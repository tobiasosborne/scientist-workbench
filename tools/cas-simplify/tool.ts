// =============================================================================
// cas-simplify — canonicalise an expression value over Q[x_1,…,x_n] / Q(x_1,…,x_n)
// =============================================================================
//
// Intent
// ------
// `cas-simplify` is the workbench's symbolic canonicaliser. Given any
// Value, it folds the in-scope arithmetic subtrees — heads `+ - * / ^`
// over symbols / integers / rationals — to a canonical form: a
// sum-of-monomials polynomial, or `num/den` for a rational function in
// lowest terms. Subtrees outside that scope (unknown heads, tagged
// values, strings, lists, …) are wrapped in
// `tagged "cas-simplify/out-of-scope"` with their children recursively
// simplified where possible — the foreign-pass-through invariant of
// PRD §2.3. The schema is `S.any()` on both sides: tightening either
// side would lie about what the tool does.
//
// `cas-simplify` is the canonical post-processor for `cas-diff` output:
// the derivative expressions `cas-diff` emits are correct but not in
// canonical sum-of-monomials form, so a `cas-diff | cas-simplify`
// pipeline is the standard symbolic-differentiation idiom.
//
// Algorithm
// ---------
// The core canonicaliser lives in `@workbench/cas-core` (`casSimplify`).
// It expands products, collects like monomials, normalises rational
// coefficients, and — since v0.3.0 (ADR-0013) — reduces rational
// functions by polynomial GCD: `(x²−1)/(x−1)` simplifies to `x+1`,
// common factors cancelled across numerator and denominator.
//
// Erf-family identities (since v0.5.0, bead `bfwt`)
// -------------------------------------------------
// A 19-rule identity table — `packages/cas-core/src/special-funcs/
// erf-identities.ts` — fires on `Erf` / `Erfc` / `Erfi` / `InverseErf`
// / `InverseErfc` heads, plus a cross-head sum-walker that collapses
// `Erfc(z) + Erf(z) → 1`. The rules ship in three tiers (R1 / DLMF
// Chapter 7):
//
//   * Tier 1 — special values (15 rules): `Erf(0)=0`, `Erf(±∞)=±1`,
//     `Erfc(0)=1`, `Erfc(+∞)=0`, `Erfc(−∞)=2`, `Erfi(0)=0`,
//     `Erfi(±∞)=±∞`, `InverseErf(0)=0`, `InverseErf(±1)=±∞`,
//     `InverseErfc(0)=+∞`, `InverseErfc(1)=0`, `InverseErfc(2)=−∞`.
//     `±∞` is encoded as `sym("infinity")` / `mkNeg(sym("infinity"))`
//     (R1 §11.1 — cas-core has no first-class infinity Value).
//   * Tier 2 — parity / odd symmetry (4 rules): `Erf(−z)=−Erf(z)`,
//     `Erfc(−z)=2−Erfc(z)`, `Erfi(−z)=−Erfi(z)`,
//     `InverseErf(−z)=−InverseErf(z)`. The `−z` pattern matches both
//     `expr("neg",[z])` (smart-ctor) and `expr("-",[z])` (user-typed
//     unary); binary `a − b` does NOT trigger parity.
//   * Tier 3 — algebraic interrelations (1 rule):
//     `Erfi(z) = −i·Erf(i·z)`, with `i = sym("I")`. Tier-1/Tier-2 rules
//     take precedence so `Erfi(0)→0`, not the deeper cascade.
//
// The cross-head sum-collapse `Erfc(z) + Erf(z) → 1` recognises pairs
// on structurally-equal arguments, in any order, possibly embedded in a
// larger sum (`x + Erfc(z) + Erf(z) → x + 1`); the walker
// `collapseErfComplementPairs` runs in `cas-simplify`'s pre-pass.
//
// Scope boundary
// --------------
// Equality of two rational functions is `cas-verify`'s job (it uses
// cross-multiplication and never depended on GCD reduction). Use
// `cas-verify` to decide `A = B`; `cas-simplify` only canonicalises a
// single value.

import {
  canonicalize,
  expr,
  hash,
  int,
  rat as protocolRat,
  S,
  sym,
  tagged,
  type Value,
} from "@workbench/protocol";
import { defineTool, runTool } from "@workbench/contract";
import { casSimplify, SIMPLIFY_TAG } from "@workbench/cas-core";

const NAME = "cas-simplify";
const VERSION = "0.5.0";  // bead bfwt: Erf-family identity table + Erfc+Erf=1 sum-collapse

// cas-simplify is honest about its breadth: it accepts any Value (it
// will recursively simplify arithmetic subterms wherever they appear,
// wrapping non-arithmetic subterms in `tagged "cas-simplify/out-of-
// scope"`). The output is also any Value — sometimes a literal, often
// an expression, occasionally a tagged-out-of-scope wrap. Tightening
// either side via the schema would lie about what the tool does.
const passThroughSchema = S.any();

export const def = defineTool({
  name: NAME,
  version: VERSION,
  summary:
    "Symbolic canonicalisation over `Q[x_1,…,x_n]` / `Q(x_1,…,x_n)`; rational functions reduced by polynomial GCD; foreign subtrees wrapped in `tagged \"cas-simplify/out-of-scope\"`",
  schema: {
    input: passThroughSchema,
    output: passThroughSchema,
  },
  examples: [
    {
      description: "literal collapses",
      input: expr("+", [int(1n), int(1n)]),
      output: int(2n),
    },
    {
      description: "(x+1)(x-1) expands",
      input: expr("*", [expr("+", [sym("x"), int(1n)]), expr("-", [sym("x"), int(1n)])]),
      output: expr("+", [expr("^", [sym("x"), int(2n)]), int(-1n)]),
    },
    {
      description: "rational coefficient survives",
      input: expr("*", [protocolRat(3n, 4n), sym("x")]),
      output: expr("*", [protocolRat(3n, 4n), sym("x")]),
    },
    {
      description: "x - x simplifies to 0",
      input: expr("-", [sym("x"), sym("x")]),
      output: int(0n),
    },
    {
      description: "double negative",
      input: expr("-", [expr("-", [sym("x")])]),
      output: sym("x"),
    },
    {
      description: "unknown head wraps as tagged out-of-scope",
      input: expr("sin", [sym("x")]),
      output: tagged(SIMPLIFY_TAG, expr("sin", [sym("x")])),
    },
    {
      description: "out-of-scope still simplifies arithmetic children",
      input: expr("sin", [expr("+", [sym("x"), sym("x")])]),
      output: tagged(SIMPLIFY_TAG, expr("sin", [expr("*", [int(2n), sym("x")])])),
    },
    {
      // (x² − 1)/(x − 1) cancels to x + 1: the simplifier's polynomial
      // normaliser recognises the common factor. The exact output bytes
      // are pinned in the folded golden (ADR-0043 / issue ixnv.3); the
      // example records the worked input and the canonical answer.
      description: "rational function (x²−1)/(x−1) reduces to x+1",
      input: expr("/", [
        expr("-", [expr("^", [sym("x"), int(2n)]), int(1n)]),
        expr("-", [sym("x"), int(1n)]),
      ]),
      output: expr("+", [sym("x"), int(1n)]),
    },
  ],
  invariants: [
    { name: "idempotent", statement: "simplify(simplify(v)) = simplify(v)", machine_checkable: true },
    { name: "deterministic", statement: "same input → same output bytes", machine_checkable: true },
    {
      name: "foreign-pass-through",
      statement: "out-of-scope subterms preserved verbatim inside `tagged \"cas-simplify/out-of-scope\"`",
      machine_checkable: true,
    },
    {
      name: "no-gcd-reduction",
      statement: "rational functions are NOT reduced by polynomial GCD (use cas-verify or wait for cas-reduce)",
      machine_checkable: false,
    },
  ],
  fn: (input, _flags) => casSimplify(input),
  test: () => {
    const probes: Value[] = [
      int(0n),
      sym("x"),
      expr("+", [int(1n), int(1n)]),
      expr("*", [expr("+", [sym("x"), int(1n)]), expr("-", [sym("x"), int(1n)])]),
      expr("sin", [sym("x")]),
    ];
    for (const v of probes) {
      const a = canonicalize(casSimplify(v));
      const b = canonicalize(casSimplify(casSimplify(v)));
      if (a !== b) {
        throw new Error(`cas-simplify not idempotent on ${canonicalize(v)}`);
      }
      const ha = hash(casSimplify(v));
      const hb = hash(casSimplify(v));
      if (ha !== hb) throw new Error(`cas-simplify not deterministic`);
    }
  },
});

if (import.meta.main) void runTool(def);
