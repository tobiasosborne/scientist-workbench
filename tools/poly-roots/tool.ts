// =============================================================================
// poly-roots — symbolic roots of univariate polynomials over ℚ
// =============================================================================
//
// Intent
// ------
// Given `f ∈ ℚ[v]`, return the list of `(root, multiplicity)` pairs.
// For irreducible factors of degree ≤ 4, each `root` is an *exact*
// expression Value in the closed numerical vocabulary (`+ − * / ^ neg
// sqrt`) — `(-1 + √5) / 2`, not `0.6180339887...` — composable with
// cas-diff, integrate-1d, and any future symbolic tool.
//
// For irreducible factors of degree ≥ 5, where Galois 1832 forbids a
// general radical formula, each `root` is a `Root[poly, k]` value —
// the value-protocol primitive for an arbitrary algebraic number
// (ADR-0018; the encoding lives in `@workbench/alg-num`). `Root[]`
// composes with arithmetic on algebraic numbers (sum / product /
// inverse) and with downstream Solve-class tools.
//
// The pipeline:
//
//   1. `tools/poly-factor` factors `f` over ℚ into integer-primitive
//      irreducible factors with multiplicities.
//   2. For each irreducible factor, dispatch on degree:
//        deg 1 → `linearRoot`     (rational, exact)
//        deg 2 → `quadraticRoots` (closed-form via discriminant)
//        deg 3 → `cubicRoots`     (Cardano 1545)
//        deg 4 → `quarticRoots`   (Ferrari 1540 + biquadratic fast path)
//        deg ≥ 5 → `Root[poly, k]` via VAS-LMQ real-root isolation
//                  (one Root[] per real root of the factor).
//   3. Each factor's roots inherit the factor's multiplicity from the
//      input.
//
// Why factor first
// ----------------
// `tools/poly-factor` already handles content extraction, square-free
// decomposition (Yun), and the full Berlekamp-Zassenhaus pipeline.
// By factoring first, every irreducible piece passed to the dispatch
// layer is monic and irreducible over ℚ — no "is this reducible"
// branching downstream. The square-free input is also load-bearing
// for cubic and quartic correctness (the discriminant `Δ = 0` case,
// signalling repeated roots, is excluded by square-freeness;
// repeated roots are accounted for via the multiplicity field).
// For the deg-≥5 path, factoring lets a polynomial like
// `(x − 2)(x⁵ − x − 1)` route the linear factor through `linearRoot`
// (preferring the rational answer `2`) while the irreducible quintic
// gets `Root[]` naming.
//
// Out of scope (refusals)
// -----------------------
//   * Irreducible deg-≥5 factor with one or more *complex* roots —
//     `tagged "poly-roots/complex-roots-not-yet-named"`.
//     The `@workbench/alg-num` substrate (v0.1) names *real* algebraic
//     numbers only — its constructor (`makeRoot` / `makeRootByIndex`)
//     accepts a real isolating-interval hint and uses VAS-LMQ to
//     enumerate real roots. Complex algebraic naming requires planar
//     complex-root isolation (Pinkert / Pan-Sevriuk), tracked as a
//     future shard. Until that lands, an irreducible deg-≥5 factor
//     whose real-root count is less than its degree refuses honestly
//     rather than producing a half-named answer.
//   * Multivariate input — `tagged "poly-roots/multivariate"`.
//   * Non-polynomial / out-of-scope head — `tagged
//     "poly-roots/non-polynomial"`.
//   * Rational-function (non-constant denominator) — same.
//
// Casus irreducibilis
// -------------------
// Cubic with three real roots and `Δ_c < 0`: per bead 1yu, Cardano
// emits faithful complex form (`sqrt(negative)` and `^(1/3)` of
// complex values), not the trigonometric formula. The result
// expressions are syntactically valid in the closed vocabulary but
// numerically evaluate to NaN; downstream `ToReal` simplification
// can recover real values when called for. This is the price of
// keeping the symbolic-radical contract honest — no silent switch
// to a different formula shape. The deg-≥5 `Root[]` path is the
// strictly better long-term answer (lazy interval refinement
// converges to a real value), but for deg ≤ 4 the radical form is
// preferred because radicals compose with cas-simplify.
//
// Output shape
// ------------
//   * Happy path — `record { roots: list<record{root, multiplicity}>,
//     method: string, warnings: list<string> }`. The `method` field
//     reads `factor-then-radicals` when every irreducible factor used
//     a radical formula (deg ≤ 4); `factor-then-radicals-or-root`
//     when at least one factor was named via `Root[]`.
//   * Boundary — `tagged "poly-roots/<class>"` with payload
//     `record { detail: string }`. Four classes:
//       - `poly-roots/complex-roots-not-yet-named` — irreducible
//         factor of deg ≥ 5 has complex roots (alg-num v0.1 limit).
//       - `poly-roots/non-polynomial`   — input is not a polynomial.
//       - `poly-roots/multivariate`     — input mentions a non-`var` symbol.
//
// `ToolError` is reserved for malformed input: `var` not a symbol,
// the input record missing required fields, the input being the
// zero polynomial, etc.

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
  cubicRoots,
  linearRoot,
  makeRat,
  polyDegInVar,
  polyVars,
  quadraticRoots,
  quarticRoots,
  valueToRatFn,
} from "@workbench/cas-core";
import { factorRatQ } from "@workbench/poly-factor";
import {
  ROOT_VAR,
  canonicalIntegerForm,
  polyToHighToLowRat,
  rootToValue,
} from "@workbench/alg-num";
import { isolateRealRoots } from "@workbench/real-roots";

const NAME = "poly-roots";
const VERSION = "0.2.0";

const TAG_COMPLEX_NOT_YET = "poly-roots/complex-roots-not-yet-named";
const TAG_NON_POLYNOMIAL = "poly-roots/non-polynomial";
const TAG_MULTIVARIATE = "poly-roots/multivariate";

const METHOD_RADICALS = "factor-then-radicals";
const METHOD_RADICALS_OR_ROOT = "factor-then-radicals-or-root";

// -----------------------------------------------------------------------------
// Schema
// -----------------------------------------------------------------------------

const inputSchema = S.record({
  f: S.any(),
  var: S.kind("symbol"),
});

const rootRecordSchema = S.record({
  root: S.any(),                                    // expression in closed vocab, or Root[poly, k]
  multiplicity: S.kind("integer"),
});

// Output schema: the closed-form happy-path shape (`record { roots,
// method, warnings }`) is documented in the prose above and enforced
// by goldens; we declare `S.any()` here to keep TS-inference on the
// `fn` return type tractable, matching the cas-diff pattern. The
// runtime trade-off: the runner's schema validation no longer catches
// happy-path shape drift, but the goldens battery does.
const outputSchema = S.any();
void rootRecordSchema;

// -----------------------------------------------------------------------------
// Body
// -----------------------------------------------------------------------------

/** Coefficients of `p` viewed in `v`-descending order. */
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

interface FactorResult {
  readonly roots: Value[];
  readonly usedRoot: boolean;
}

function rootsOfFactor(
  p: Poly<Rat>,
  v: string,
): FactorResult | { refusal: { tag: string; detail: string } } {
  const coefs = coefsAsRat(p, v);
  const deg = coefs.length - 1;
  switch (deg) {
    case 0:
      return { roots: [], usedRoot: false };
    case 1: {
      const [a, b] = coefs;
      return { roots: [linearRoot(a!, b!)], usedRoot: false };
    }
    case 2: {
      const [a, b, c] = coefs;
      const [r1, r2] = quadraticRoots(a!, b!, c!);
      return { roots: [r1, r2], usedRoot: false };
    }
    case 3: {
      const [a, b, c, d] = coefs;
      const [r1, r2, r3] = cubicRoots(a!, b!, c!, d!);
      return { roots: [r1, r2, r3], usedRoot: false };
    }
    case 4: {
      const [a, b, c, d, e] = coefs;
      const [r1, r2, r3, r4] = quarticRoots(a!, b!, c!, d!, e!);
      return { roots: [r1, r2, r3, r4], usedRoot: false };
    }
    default: {
      // deg ≥ 5: name each real root by `Root[poly, k]`. The factor `p`
      // is monic over ℚ and irreducible (factorRatQ contract); converting
      // to canonical ℤ[x] form (primitive, positive-leading) gives the
      // canonical minpoly. VAS-LMQ enumerates real roots in ascending
      // order — exactly the order ADR-0018 §"Index k" requires for the
      // real prefix of the canonical sort.
      const minpoly = canonicalIntegerForm(p, v);
      const intervals = isolateRealRoots(polyToHighToLowRat(minpoly, ROOT_VAR));
      if (intervals.length < deg) {
        return {
          refusal: {
            tag: TAG_COMPLEX_NOT_YET,
            detail:
              `irreducible factor of degree ${deg} has ${deg - intervals.length} complex root(s); `
              + `alg-num v0.1 names real algebraic numbers only — complex algebraic naming `
              + `requires planar complex-root isolation (future shard).`,
          },
        };
      }
      const roots: Value[] = intervals.map((iv, k) =>
        rootToValue({
          minpoly,
          k,
          interval: { lo: iv.lo, hi: iv.hi },
        }),
      );
      return { roots, usedRoot: true };
    }
  }
}

function decodeInput(inputRec: RecordValue): { fValue: Value; varSym: SymbolValue } {
  const fValue = inputRec.fields.f as Value;
  const varVal = inputRec.fields.var as Value;
  if (varVal.kind !== "symbol") {
    throw new ToolError("`var` must be a symbol", { detail: `got kind=${varVal.kind}` });
  }
  return { fValue, varSym: varVal };
}

function buildHappyOutput(
  roots: { root: Value; multiplicity: number }[],
  method: string,
): Value {
  return record({
    roots: list(roots.map((r) => record({
      root: r.root,
      multiplicity: int(BigInt(r.multiplicity)),
    }))),
    method: str(method),
    warnings: list([]),
  });
}

function refuse(tag: string, detail: string): Value {
  return tagged(tag, record({ detail: str(detail) }));
}

export const def = defineTool({
  name: NAME,
  version: VERSION,
  schema: { input: inputSchema, output: outputSchema },
  examples: [
    {
      description: "x² − 1 = (x − 1)(x + 1) ⟹ roots ±1",
      input: record({
        f: expr("+", [expr("^", [sym("x"), int(2n)]), int(-1n)]),
        var: sym("x"),
      }),
      output: record({
        roots: list([
          record({ root: int(1n), multiplicity: int(1n) }),
          record({ root: int(-1n), multiplicity: int(1n) }),
        ]),
        method: str(METHOD_RADICALS),
        warnings: list([]),
      }),
    },
    {
      description: "Constant input: f = 5 has no roots",
      input: record({ f: int(5n), var: sym("x") }),
      output: record({
        roots: list([]),
        method: str(METHOD_RADICALS),
        warnings: list([]),
      }),
    },
    {
      description:
        "x⁵ − x − 1 — irreducible quintic with 1 real + 4 complex roots ⟹ tagged complex-roots-not-yet-named",
      input: record({
        f: expr("+", [
          expr("^", [sym("x"), int(5n)]),
          expr("*", [int(-1n), sym("x")]),
          int(-1n),
        ]),
        var: sym("x"),
      }),
      output: refuse(
        TAG_COMPLEX_NOT_YET,
        "irreducible factor of degree 5 has 4 complex root(s); "
          + "alg-num v0.1 names real algebraic numbers only — complex algebraic naming "
          + "requires planar complex-root isolation (future shard).",
      ),
    },
    {
      description: "non-polynomial input → tagged non-polynomial",
      input: record({ f: expr("sin", [sym("x")]), var: sym("x") }),
      output: refuse(
        TAG_NON_POLYNOMIAL,
        "input is not a polynomial in 'x' over ℚ: out-of-scope head 'sin'",
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
      name: "factor-then-dispatch",
      statement:
        "every reducible polynomial is factored via tools/poly-factor first; each radical solver receives an irreducible factor of degree 1..4, and each Root[]-naming path receives an irreducible factor of degree ≥ 5",
      machine_checkable: false,
    },
    {
      name: "multiplicity-preserves-count",
      statement: "for f = ∏_i p_i^{e_i}, the output has Σ_i (deg p_i · e_i) entries",
      machine_checkable: true,
    },
    {
      name: "deg-leq-4-radicals",
      statement: "every irreducible factor of degree 1..4 produces concrete root expressions in the closed radical vocabulary",
      machine_checkable: true,
    },
    {
      name: "deg-geq-5-named-when-real",
      statement:
        "every irreducible factor of degree ≥ 5 with all-real roots produces (deg) Root[poly, k] values; a factor with one or more complex roots refuses with `poly-roots/complex-roots-not-yet-named`",
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
          `input mentions foreign symbol '${u}'; poly-roots requires a univariate polynomial in '${varSym.name}'`,
        );
      }
    }

    if (polyDegInVar(fPoly, varSym.name) <= 0) {
      try {
        factorRatQ(fPoly, varSym.name);
      } catch {
        throw new ToolError("input polynomial is zero", {
          detail: "f reduces to the zero polynomial; root-finding undefined",
        });
      }
      return buildHappyOutput([], METHOD_RADICALS);
    }

    const fact = factorRatQ(fPoly, varSym.name);

    const rootList: { root: Value; multiplicity: number }[] = [];
    let anyRoot = false;
    for (const fr of fact.factors) {
      const result = rootsOfFactor(fr.factor, varSym.name);
      if ("refusal" in result) {
        return refuse(result.refusal.tag, result.refusal.detail);
      }
      if (result.usedRoot) anyRoot = true;
      for (const root of result.roots) {
        rootList.push({ root, multiplicity: fr.multiplicity });
      }
    }

    return buildHappyOutput(rootList, anyRoot ? METHOD_RADICALS_OR_ROOT : METHOD_RADICALS);
  },
  test: () => {
    // Probe 1 — deg-2 split case (existing radicals path).
    const inputProbe = record({
      f: expr("+", [
        expr("^", [sym("x"), int(2n)]),
        expr("*", [int(-5n), sym("x")]),
        int(6n),
      ]),
      var: sym("x"),
    });
    const out = def.fn(inputProbe as never, {} as never) as Value;
    if (out.kind !== "record") throw new Error("poly-roots --test: expected record output");
    const rs = out.fields["roots"];
    if (!rs || rs.kind !== "list") throw new Error("poly-roots --test: roots field missing or wrong shape");
    if (rs.items.length !== 2) {
      throw new Error(`poly-roots --test: expected 2 roots, got ${rs.items.length}`);
    }

    // Probe 2 — deg-5 irreducible with complex roots (refuses honestly).
    // x^5 − x − 1: classical Lehmer-irreducible quintic, 1 real + 2 complex pairs.
    const inputComplex = record({
      f: expr("+", [
        expr("^", [sym("x"), int(5n)]),
        expr("*", [int(-1n), sym("x")]),
        int(-1n),
      ]),
      var: sym("x"),
    });
    const outComplex = def.fn(inputComplex as never, {} as never) as Value;
    if (outComplex.kind !== "tagged") {
      throw new Error("poly-roots --test: expected tagged refusal for x^5 − x − 1");
    }
    if (outComplex.tag !== TAG_COMPLEX_NOT_YET) {
      throw new Error(`poly-roots --test: expected ${TAG_COMPLEX_NOT_YET}, got ${outComplex.tag}`);
    }

    // Probe 3 — deg-5 irreducible with all-real roots (Lehmer's L(x), 11th
    // cyclotomic over the real subfield: minimal polynomial of 2cos(2π/11)).
    // Five real roots ⟹ five Root[] values, all sharing the same minpoly.
    const Lx = expr("+", [
      expr("^", [sym("x"), int(5n)]),
      expr("^", [sym("x"), int(4n)]),
      expr("*", [int(-4n), expr("^", [sym("x"), int(3n)])]),
      expr("*", [int(-3n), expr("^", [sym("x"), int(2n)])]),
      expr("*", [int(3n), sym("x")]),
      int(1n),
    ]);
    const outAllReal = def.fn(record({ f: Lx, var: sym("x") }) as never, {} as never) as Value;
    if (outAllReal.kind !== "record") {
      throw new Error("poly-roots --test: expected record output for Lehmer L(x)");
    }
    const outRoots = outAllReal.fields["roots"];
    if (!outRoots || outRoots.kind !== "list" || outRoots.items.length !== 5) {
      throw new Error(
        `poly-roots --test: expected 5 Root[] for Lehmer L(x), got ${outRoots?.kind === "list" ? outRoots.items.length : "non-list"}`,
      );
    }
    for (const ri of outRoots.items) {
      if (ri.kind !== "record") throw new Error("poly-roots --test: Lehmer root entry not a record");
      const r = ri.fields["root"];
      if (!r || r.kind !== "expression" || r.head !== "Root") {
        throw new Error("poly-roots --test: Lehmer root not a Root[] expression");
      }
    }

    console.log(
      `poly-roots --test: deg-2 radicals + deg-5 complex-refusal + deg-5 all-real Root[] paths green; full coverage in goldens.`,
    );
  },
});

if (import.meta.main) void runTool(def);
