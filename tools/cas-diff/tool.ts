// =============================================================================
// cas-diff — symbolic differentiation over the closed numerical vocabulary
// =============================================================================
//
// Intent
// ------
// `cas-diff` computes `∂f/∂var` for an expression `f` over the closed
// vocabulary admitted by integrate-1d / optimize-lbfgs-projected:
//
//     heads:     + - * / ^ neg exp sin cos tan log sqrt abs
//     constants: pi, e
//     leaves:    integer, rational, float64
//     variables: any symbol
//
// The output is a new expression Value whose heads are also in this
// table — meaning the result composes directly with integrate-1d (for
// Leibniz-rule applications) and with optimize-lbfgs-projected (which
// requires `grad: list<expression>` in its input). The motivating
// scenario, from `scripts/demo-min-integral.ts`: minimise an integral
// `I(a) = ∫ p(x, a) dx` over `a`. Without cas-diff the agent had to
// hand-derive `∂p/∂a`. With cas-diff the agent calls `casDiff` once per
// variable and hands the result straight to integrate-1d / optimize.
//
// Why a sibling to cas-simplify rather than a flag on it
// ------------------------------------------------------
// cas-simplify canonicalises Q[x_1..x_n] / Q(x_1..x_n) (a *narrower*
// vocabulary that excludes transcendentals — sin / cos / exp / log /
// sqrt / abs are out-of-scope and emerge wrapped in tagged
// `cas-simplify/out-of-scope`). Differentiation rules ARE well-defined
// for those transcendentals — high-school calculus. So cas-diff's
// vocabulary is the *broader* numerical-eval vocabulary, and it would
// be dishonest to make a `cas-simplify --diff` flag because its scope
// wouldn't match the rest of cas-simplify. Different operation,
// different scope, different tool. Decomposition discipline.
//
// Input shape
// -----------
// `record { f: <expression>, var: <symbol> }`. The field name `f`
// mirrors integrate-1d / optimize-lbfgs-projected for cross-tool
// symmetry — an agent that already knows those tools' calling
// conventions can predict cas-diff's. `var` is the differentiation
// variable (also matching integrate-1d's nomenclature).
//
// Output shape
// ------------
// Two ADR-0003 categories; no third (no separate "non-finite" or
// "degenerate" boundary tag — symbolic differentiation is total over
// its declared scope):
//
//   * Happy path — the differentiated expression Value (`S.any()` —
//     could be a literal, a symbol, or any expression in the closed
//     vocabulary).
//   * Boundary — `tagged "cas-diff/out-of-scope"` with payload =
//     original input record. Triggered iff any subterm has a head
//     outside the rule table OR a Value kind the rule table doesn't
//     interpret as a mathematical scalar (string / list / record /
//     tagged / boolean).
//
// We refuse the *whole* input on any out-of-scope subterm, rather than
// embedding tagged sub-nodes inside an otherwise-valid result, because
// the agent then gets a binary yes/no answer at the top level rather
// than having to walk the result tree. (Cf. cas-simplify, which does
// the embedded form because its own callers — the planner walking
// rational-function structure — needs the partial reduction.)
//
// Algorithm
// ---------
// Single-pass recursive descent in `packages/cas-core/src/diff.ts`,
// dispatching on Value kind / expression head. Smart constructors
// absorb local identities (0+x → x, 1·x → x, x⁰ → 1, x¹ → x,
// neg(neg(x)) → x); no further reduction. Reference: any standard
// CAS textbook — Cohen *Computer Algebra and Symbolic Computation:
// Mathematical Methods* (2003) §6, or Knuth TAOCP Vol 2 §4.6.4. The
// rule table is high-school calculus.
//
// Determinism contract
// --------------------
// `numerical: false` (default symbolic tier per ADR-0015). Output is
// bit-identical cross-platform forever — there is no float64
// arithmetic in the symbolic-diff path; integer / rational arithmetic
// in the smart constructors uses BigInt and is deterministic. Same
// tier as cas-simplify.

import {
  canonicalize,
  expr,
  hash,
  int,
  rat,
  record,
  S,
  sym,
  tagged,
  type SymbolValue,
  type Value,
} from "@workbench/protocol";
import { defineTool, runTool } from "@workbench/contract";
import {
  CasDiffOutOfScopeError,
  DIFF_TAG,
  differentiate,
} from "@workbench/cas-core";
import { evalNumericExpr } from "@workbench/quadrature";

const NAME = "cas-diff";
const VERSION = "0.1.0";

// -----------------------------------------------------------------------------
// Schema
// -----------------------------------------------------------------------------
//
// `f` is `S.any()` for the same reason integrate-1d's `f` is `S.any()`:
// closed-form vocabulary checking inside a recursive schema would
// duplicate the per-node check `differentiate` does, and the per-node
// check carries richer error messages anyway.

const inputSchema = S.record({
  f: S.any(),
  var: S.kind("symbol"),
});

// Output is a union of "any expression-like Value" (the happy path) and
// the boundary tag wrapping the original input. We declare the happy
// path as `S.any()` — like cas-simplify — because the result kind
// genuinely varies (literal / symbol / expression).
const outputSchema = S.union([
  S.any(),
  S.tagged(DIFF_TAG, inputSchema),
]);

// -----------------------------------------------------------------------------
// Body
// -----------------------------------------------------------------------------

function diffOrTag(f: Value, varSym: SymbolValue, original: Value): Value {
  try {
    return differentiate(f, varSym);
  } catch (e) {
    if (e instanceof CasDiffOutOfScopeError) {
      return tagged(DIFF_TAG, original);
    }
    throw e;
  }
}

// -----------------------------------------------------------------------------
// Tool definition
// -----------------------------------------------------------------------------

export const def = defineTool({
  name: NAME,
  version: VERSION,
  schema: { input: inputSchema, output: outputSchema },
  examples: [
    {
      description: "d(x²)/dx = 2·x  (power rule)",
      input: record({ f: expr("^", [sym("x"), int(2n)]), var: sym("x") }),
      output: expr("*", [int(2n), sym("x")]),
    },
    {
      description: "d(sin(x))/dx = cos(x)",
      input: record({ f: expr("sin", [sym("x")]), var: sym("x") }),
      output: expr("cos", [sym("x")]),
    },
    {
      description: "d(x + y)/dx = 1  (other variables treated as constants)",
      input: record({ f: expr("+", [sym("x"), sym("y")]), var: sym("x") }),
      output: int(1n),
    },
    {
      description: "d((1 - a·x)·(2 + x)·(3/7 + a·x) / (x² - 49)) / da — the demo's integrand",
      input: record({
        f: expr("/", [
          expr("*", [
            expr("*", [
              expr("-", [int(1n), expr("*", [sym("a"), sym("x")])]),
              expr("+", [int(2n), sym("x")]),
            ]),
            expr("+", [rat(3n, 7n), expr("*", [sym("a"), sym("x")])]),
          ]),
          expr("+", [expr("^", [sym("x"), int(2n)]), int(-49n)]),
        ]),
        var: sym("a"),
      }),
      // The exact derivative shape is determined by the rule + smart-
      // constructor pipeline. Recomputed at example-load time so the
      // example structurally matches what the tool produces. (No
      // hand-typed reference form — the tool itself is the spec; the
      // FD cross-check in `--test` is the orthogonal verification.)
      output: differentiate(
        expr("/", [
          expr("*", [
            expr("*", [
              expr("-", [int(1n), expr("*", [sym("a"), sym("x")])]),
              expr("+", [int(2n), sym("x")]),
            ]),
            expr("+", [rat(3n, 7n), expr("*", [sym("a"), sym("x")])]),
          ]),
          expr("+", [expr("^", [sym("x"), int(2n)]), int(-49n)]),
        ]),
        sym("a"),
      ),
    },
    {
      description: "unknown head (gamma) → tagged out-of-scope",
      input: record({ f: expr("gamma", [sym("x")]), var: sym("x") }),
      output: tagged(
        DIFF_TAG,
        record({ f: expr("gamma", [sym("x")]), var: sym("x") }),
      ),
    },
  ],
  invariants: [
    {
      name: "deterministic",
      statement: "same input bytes → same output bytes (symbolic tier; bit-identical cross-platform)",
      machine_checkable: true,
    },
    {
      name: "fd-cross-check",
      statement: "for every in-scope corpus expression in the --test hook, evalNumericExpr of the cas-diff output agrees with a centred-finite-difference of the input at random points (relative error ≤ 1e-6)",
      machine_checkable: true,
    },
    {
      name: "out-of-scope-tagged",
      statement: `unknown expression head or non-arithmetic Value kind → tagged "${DIFF_TAG}" with original input as payload — never silently wrong derivative`,
      machine_checkable: true,
    },
    {
      name: "constant-vars-vanish",
      statement: "d(c)/dx = 0 for c independent of x (other free symbols, pi, e, all numeric leaves)",
      machine_checkable: true,
    },
  ],
  fn: (input, _flags): Value => {
    // Input is the validated Value tree shaped by `inputSchema`. Access
    // through `.fields.<name>`. The TS types are narrowed by the schema
    // so the casts below are conservative pinpointing for downstream
    // consumers.
    const f = input.fields.f as Value;
    const varSym = input.fields.var as SymbolValue;
    return diffOrTag(f, varSym, input);
  },
  test: () => {
    // The FD cross-check is the load-bearing structural test. Same
    // corpus shape as the package-level test in
    // packages/cas-core/test/diff.test.ts, but exercised through the
    // tool entry point so a regression in either the tool wrapper or
    // the library surfaces here.
    const x = sym("x");
    const FD_H = 1e-6;
    const FD_TOL = 1e-6;
    const corpus: { description: string; f: Value; points: number[] }[] = [
      { description: "x³", f: expr("^", [x, int(3n)]), points: [-1.5, 0.5, 2] },
      { description: "1/(1+x²)", f: expr("/", [int(1n),
        expr("+", [int(1n), expr("^", [x, int(2n)])]),
      ]), points: [-2, 0, 1.5] },
      { description: "sin(x)·cos(x)",
        f: expr("*", [expr("sin", [x]), expr("cos", [x])]),
        points: [-1.5, 0, 1.2] },
      { description: "exp(-x²/2)",
        f: expr("exp", [
          expr("neg", [expr("/", [expr("^", [x, int(2n)]), int(2n)])]),
        ]),
        points: [-2, 0, 1, 2] },
      { description: "log(2 + sin(x))",
        f: expr("log", [expr("+", [int(2n), expr("sin", [x])])]),
        points: [-2, 0, 1, 2] },
      { description: "sqrt(x² + 1)",
        f: expr("sqrt", [
          expr("+", [expr("^", [x, int(2n)]), int(1n)]),
        ]),
        points: [-1.5, 0, 0.7, 2] },
      { description: "(x - 3)⁴",
        f: expr("^", [expr("-", [x, int(3n)]), int(4n)]),
        points: [-1, 1, 2.5, 5] },
      { description: "tan(x)·log(1+x²)",
        f: expr("*", [
          expr("tan", [x]),
          expr("log", [
            expr("+", [int(1n), expr("^", [x, int(2n)])]),
          ]),
        ]),
        points: [-1, 0.5, 1.2] },
    ];
    for (const probe of corpus) {
      const dExpr = differentiate(probe.f, x);
      for (const x0 of probe.points) {
        const env = (xv: number) => new Map([["x", xv]]);
        const fPlus = evalNumericExpr(probe.f, env(x0 + FD_H));
        const fMinus = evalNumericExpr(probe.f, env(x0 - FD_H));
        const fdEstimate = (fPlus - fMinus) / (2 * FD_H);
        const dValue = evalNumericExpr(dExpr, env(x0));
        const denom = Math.max(Math.abs(fdEstimate), 1);
        const relErr = Math.abs(dValue - fdEstimate) / denom;
        if (relErr > FD_TOL) {
          throw new Error(
            `cas-diff FD cross-check failed on ${probe.description} at x=${x0}: ` +
              `cas-diff=${dValue}, FD=${fdEstimate}, relErr=${relErr.toExponential(3)}`,
          );
        }
      }
    }
    // Determinism: hash-equal on a probe.
    const probe = expr("*", [int(2n), expr("^", [x, int(3n)])]);
    const a = canonicalize(differentiate(probe, x));
    const b = canonicalize(differentiate(probe, x));
    if (a !== b) throw new Error("cas-diff not deterministic");
    if (hash(differentiate(probe, x)) !== hash(differentiate(probe, x))) {
      throw new Error("cas-diff hash not stable");
    }
    // Out-of-scope handling: tagged at top level.
    const ofs = diffOrTag(
      expr("gamma", [x]),
      x,
      record({ f: expr("gamma", [x]), var: x }),
    );
    if (ofs.kind !== "tagged" || ofs.tag !== DIFF_TAG) {
      throw new Error("cas-diff: unknown head should produce tagged out-of-scope");
    }
    console.log(`cas-diff --test: ${corpus.length} corpus probes × multiple points all agree with FD (rel ≤ ${FD_TOL.toExponential(0)})`);
  },
});

if (import.meta.main) void runTool(def);
