// =============================================================================
// real-root-isolate — VAS-LMQ rational isolating intervals for ℚ[x]'s real roots
// =============================================================================
//
// Intent
// ------
// Given a squarefree univariate polynomial `f ∈ ℚ[v]`, return a list
// of disjoint rational isolating intervals — open `(lo, hi)` for
// irrational roots, singletons `(r, r)` for rational roots — covering
// every real root of `f` exactly once, in ascending order. Output
// matches the bench/real-root-isolate verifier convention (open +
// singleton dual shape).
//
// The implementation is a Vincent-Akritas-Strzebonski continued-
// fraction algorithm with the Local-Max Quadratic (LMQ) bound — see
// `packages/real-roots/src/{vas,lmq}.ts`. SymPy's
// `dup_isolate_real_roots_sqf` (BSD) is the line-by-line port reference
// the bench gates against (worklog 058).
//
// Squarefree precondition
// -----------------------
// VAS depends on the sign-change ↔ root bijection, which fails for
// repeated factors (a double root produces *no* sign change). Callers
// compose with `packages/poly-factor::squareFree` (Yun 1976, worklog
// 052) to honour the precondition. The boundary is a tagged refusal,
// not a silent squarefree-and-isolate, because making it implicit would
// couple two distinct concerns and obscure the rational-root-multiplicity
// contract — the squarefree decomposition reports multiplicity per
// distinct root, which this tool does not.
//
// Output shape
// ------------
//   * Happy path — `record { intervals: list<record{lo, hi}>,
//     method: "vas-lmq", warnings: list<string> }`. Each `lo` and `hi`
//     is an `expression` value rendering the rational endpoint as
//     `p / q` (or just `p` when `q = 1`).
//   * Boundary — `tagged "real-root-isolate/<class>"` with payload
//     `record { detail: string }`. Three classes:
//       - `real-root-isolate/not-squarefree`
//       - `real-root-isolate/non-polynomial`
//       - `real-root-isolate/multivariate`
//
// `ToolError` is reserved for malformed input: `var` not a symbol,
// the input record missing required fields, the input being the zero
// polynomial.

import {
  expr,
  int,
  list,
  record,
  S,
  str,
  sym,
  tagged,
  ToolError,
  type RecordValue,
  type SymbolValue,
  type Value,
} from "@workbench/protocol";
import { defineTool, runTool } from "@workbench/contract";
import {
  type Poly,
  type Rat,
  CasOutOfScopeError,
  RAT_RING,
  makeRat,
  polyDegInVar,
  polyDeriv,
  polyGcd,
  polyIsConst,
  polyVars,
  ratIsZero,
  valueToRatFn,
} from "@workbench/cas-core";
import { isolateRealRoots } from "@workbench/real-roots";

const NAME = "real-root-isolate";
const VERSION = "0.1.0";

const TAG_NOT_SQUAREFREE = "real-root-isolate/not-squarefree";
const TAG_NON_POLYNOMIAL = "real-root-isolate/non-polynomial";
const TAG_MULTIVARIATE   = "real-root-isolate/multivariate";

// -----------------------------------------------------------------------------
// Schema
// -----------------------------------------------------------------------------

const inputSchema = S.record({
  f: S.any(),
  var: S.kind("symbol"),
});

const outputSchema = S.any();

// -----------------------------------------------------------------------------
// Body
// -----------------------------------------------------------------------------

/** High-to-low coefficient list, parallel to `tools/poly-roots`'s `coefsAsRat`. */
function coefsAsRat(p: Poly<Rat>, v: string): Rat[] {
  const d = polyDegInVar(p, v);
  if (d < 0) return [];
  const arr = new Array<Rat>(d + 1).fill(makeRat(0n, 1n));
  for (const t of p.terms) {
    let pv = 0;
    for (const [name, exp] of t.exp) if (name === v) pv = exp;
    arr[pv] = t.coef;
  }
  return arr.reverse();
}

/** Render a rational as a value-protocol expression: `int` for integers, `p/q` otherwise. */
function ratToExpr(r: Rat): Value {
  if (r.d === 1n) return int(r.n);
  return expr("/", [int(r.n), int(r.d)]);
}

function decodeInput(inputRec: RecordValue): { fValue: Value; varSym: SymbolValue } {
  const fValue = inputRec.fields.f as Value;
  const varVal = inputRec.fields.var as Value;
  if (varVal.kind !== "symbol") {
    throw new ToolError("`var` must be a symbol", { detail: `got kind=${varVal.kind}` });
  }
  return { fValue, varSym: varVal };
}

function refuse(tag: string, detail: string): Value {
  return tagged(tag, record({ detail: str(detail) }));
}

function buildHappyOutput(intervals: { lo: Rat; hi: Rat }[]): Value {
  return record({
    intervals: list(
      intervals.map((iv) =>
        record({ lo: ratToExpr(iv.lo), hi: ratToExpr(iv.hi) }),
      ),
    ),
    method: str("vas-lmq"),
    warnings: list([]),
  });
}

export const def = defineTool({
  name: NAME,
  version: VERSION,
  summary:
    "Rational isolating intervals for real roots via VAS continued fractions + LMQ bound; open `(lo,hi)` or singleton `(r,r)` per root",
  schema: { input: inputSchema, output: outputSchema },
  examples: [
    {
      description: "x² − 2 ⟹ two open intervals around ±√2",
      input: record({
        f: expr("+", [expr("^", [sym("x"), int(2n)]), int(-2n)]),
        var: sym("x"),
      }),
      output: record({
        intervals: list([
          record({ lo: int(-2n), hi: int(-1n) }),
          record({ lo: int(1n),  hi: int(2n) }),
        ]),
        method: str("vas-lmq"),
        warnings: list([]),
      }),
    },
    {
      description: "(x − 1)(x − 2) ⟹ two singleton intervals at the rational roots",
      input: record({
        f: expr("+", [
          expr("^", [sym("x"), int(2n)]),
          expr("*", [int(-3n), sym("x")]),
          int(2n),
        ]),
        var: sym("x"),
      }),
      output: record({
        intervals: list([
          record({ lo: int(1n), hi: int(1n) }),
          record({ lo: int(2n), hi: int(2n) }),
        ]),
        method: str("vas-lmq"),
        warnings: list([]),
      }),
    },
    {
      description: "(x − 1)² ⟹ tagged not-squarefree",
      input: record({
        f: expr("+", [
          expr("^", [sym("x"), int(2n)]),
          expr("*", [int(-2n), sym("x")]),
          int(1n),
        ]),
        var: sym("x"),
      }),
      output: refuse(
        TAG_NOT_SQUAREFREE,
        "polynomial has repeated factors; squarefree-decompose (Yun) before isolation",
      ),
    },
    {
      description: "non-polynomial input → tagged non-polynomial",
      input: record({ f: expr("sin", [sym("x")]), var: sym("x") }),
      output: refuse(
        TAG_NON_POLYNOMIAL,
        "input is not a polynomial in 'x' over ℚ: unknown head \"sin\"",
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
      name: "intervals-disjoint-and-ordered",
      statement: "every interval pair (i, i+1) satisfies hi_i ≤ lo_{i+1}",
      machine_checkable: true,
    },
    {
      name: "count-matches-real-roots",
      statement: "|intervals| equals the number of real roots of the squarefree input",
      machine_checkable: true,
    },
    {
      name: "each-interval-contains-one-root",
      statement: "for each interval, exactly one real root of f lies in [lo, hi] (Sturm count = 1)",
      machine_checkable: true,
    },
  ],
  fn: (input, _flags): Value => {
    const inputRec = input as RecordValue;
    const { fValue, varSym } = decodeInput(inputRec);

    let fRatFn;
    try {
      fRatFn = valueToRatFn(fValue);
    } catch (e) {
      if (e instanceof CasOutOfScopeError) {
        return refuse(
          TAG_NON_POLYNOMIAL,
          `input is not a polynomial in '${varSym.name}' over ℚ: ${e.message}`,
        );
      }
      throw e;
    }

    if (fRatFn.den.terms.length !== 1 || fRatFn.den.terms[0]!.exp.length !== 0) {
      return refuse(
        TAG_NON_POLYNOMIAL,
        `input is not a polynomial in '${varSym.name}' over ℚ: rational function with non-constant denominator`,
      );
    }
    let fPoly: Poly<Rat> = fRatFn.num;
    if (fRatFn.den.terms[0]!.coef.n !== 1n || fRatFn.den.terms[0]!.coef.d !== 1n) {
      const inv = makeRat(fRatFn.den.terms[0]!.coef.d, fRatFn.den.terms[0]!.coef.n);
      fPoly = {
        terms: fPoly.terms.map((t) => ({
          exp: t.exp,
          coef: makeRat(t.coef.n * inv.n, t.coef.d * inv.d),
        })),
      };
    }

    const vars = polyVars(fPoly);
    for (const u of vars) {
      if (u !== varSym.name) {
        return refuse(
          TAG_MULTIVARIATE,
          `input mentions foreign symbol '${u}'; real-root-isolate requires a univariate polynomial in '${varSym.name}'`,
        );
      }
    }

    const deg = polyDegInVar(fPoly, varSym.name);
    if (deg < 0) {
      throw new ToolError("input polynomial is zero", {
        detail: "f reduces to the zero polynomial; root-isolation undefined",
      });
    }
    if (deg === 0) {
      // Non-zero constant polynomial — no real roots.
      return buildHappyOutput([]);
    }

    // Squarefree check: gcd(f, f') is a constant (degree 0 in var) iff
    // f is squarefree. Implementation note: polyGcd returns a monic
    // result; we check by polyIsConst (which holds iff all variable
    // exponents are zero — equivalent to "no var dependence"). Per
    // worklog 058's lesson on the open + singleton convention, the
    // squarefree boundary keeps multiplicity tracking outside this
    // tool's surface (poly-factor's territory).
    const fPrime = polyDeriv(fPoly, varSym.name, RAT_RING);
    if (fPrime.terms.length > 0) {
      const g = polyGcd(fPoly, fPrime, RAT_RING);
      if (!polyIsConst(g)) {
        return refuse(
          TAG_NOT_SQUAREFREE,
          "polynomial has repeated factors; squarefree-decompose (Yun) before isolation",
        );
      }
    }

    const coefs = coefsAsRat(fPoly, varSym.name);
    // Strip leading zeros (canonical form for the package's input).
    let lead = 0;
    while (lead < coefs.length && ratIsZero(coefs[lead]!)) lead++;
    const trimmed = coefs.slice(lead);
    if (trimmed.length === 0) {
      throw new Error("real-root-isolate: unreachable; deg ≥ 1 but coefficient list is empty");
    }

    const intervals = isolateRealRoots(trimmed);
    return buildHappyOutput(intervals);
  },
  test: () => {
    // Probe: x³ - 3x + 1 (casus irreducibilis: 3 real roots).
    const probe = record({
      f: expr("+", [
        expr("^", [sym("x"), int(3n)]),
        expr("*", [int(-3n), sym("x")]),
        int(1n),
      ]),
      var: sym("x"),
    });
    const out = def.fn(probe as never, {} as never) as Value;
    if (out.kind !== "record") throw new Error("real-root-isolate --test: expected record output");
    const intervals = out.fields["intervals"];
    if (!intervals || intervals.kind !== "list") {
      throw new Error("real-root-isolate --test: intervals field missing or wrong shape");
    }
    if (intervals.items.length !== 3) {
      throw new Error(
        `real-root-isolate --test: expected 3 intervals for casus-irreducibilis cubic, got ${intervals.items.length}`,
      );
    }
    console.log(
      `real-root-isolate --test: casus-irreducibilis 3-root case green; full coverage in goldens.`,
    );
  },
});

if (import.meta.main) void runTool(def);
