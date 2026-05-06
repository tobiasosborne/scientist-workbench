// =============================================================================
// poly-roots — symbolic radical roots of univariate polynomials over ℚ (deg ≤ 4)
// =============================================================================
//
// Intent
// ------
// Given `f ∈ ℚ[v]` of degree ≤ 4, return the list of `(root,
// multiplicity)` pairs where each `root` is an expression Value in
// the closed numerical vocabulary (`+ − * / ^ neg sqrt`) representing
// a root of `f`. The radicals are *exact* — `(-1 + √5) / 2`, not
// `0.6180339887...` — so the result is composable with cas-diff,
// integrate-1d, and any future symbolic tool.
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
//        deg ≥ 5 → `tagged "poly-roots/degree-too-high"` boundary tag
//   3. Each factor's roots inherit the factor's multiplicity from the
//      input.
//
// Why factor first
// ----------------
// `tools/poly-factor` already handles content extraction, square-free
// decomposition (Yun), and the full Berlekamp-Zassenhaus pipeline.
// By factoring first, every irreducible piece passed to a radicals
// solver is monic and irreducible over ℚ — no "is this reducible"
// branching in the radicals layer. The square-free input is also
// load-bearing for cubic and quartic correctness (the cubic
// discriminant `Δ = 0` case, signalling repeated roots, is excluded
// by square-freeness — repeated roots are accounted for via the
// multiplicity field).
//
// Out of scope (refusals)
// -----------------------
//   * deg ≥ 5 irreducible factor — `tagged "poly-roots/degree-too-high"`.
//     Galois 1832: no general radical formula. Lifting this cap is
//     `scientist-workbench-yoc` (Root[] / algebraic-number representation).
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
// to a different formula shape.
//
// Output shape
// ------------
//   * Happy path — `record { roots: list<record{root, multiplicity}>,
//     method: string, warnings: list<string> }`.
//   * Boundary — `tagged "poly-roots/<class>"` with payload
//     `record { detail: string }`. Three classes:
//       - `poly-roots/degree-too-high` — irreducible factor of deg ≥ 5.
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

const NAME = "poly-roots";
const VERSION = "0.1.0";

const TAG_DEGREE_TOO_HIGH = "poly-roots/degree-too-high";
const TAG_NON_POLYNOMIAL = "poly-roots/non-polynomial";
const TAG_MULTIVARIATE = "poly-roots/multivariate";

// -----------------------------------------------------------------------------
// Schema
// -----------------------------------------------------------------------------

const inputSchema = S.record({
  f: S.any(),
  var: S.kind("symbol"),
});

const rootRecordSchema = S.record({
  root: S.any(),                                    // expression in closed vocab
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

function rootsOfFactor(
  p: Poly<Rat>,
  v: string,
): Value[] | { refusal: { tag: string; detail: string } } {
  const coefs = coefsAsRat(p, v);
  const deg = coefs.length - 1;
  switch (deg) {
    case 0:
      return [];
    case 1: {
      const [a, b] = coefs;
      return [linearRoot(a!, b!)];
    }
    case 2: {
      const [a, b, c] = coefs;
      const [r1, r2] = quadraticRoots(a!, b!, c!);
      return [r1, r2];
    }
    case 3: {
      const [a, b, c, d] = coefs;
      const [r1, r2, r3] = cubicRoots(a!, b!, c!, d!);
      return [r1, r2, r3];
    }
    case 4: {
      const [a, b, c, d, e] = coefs;
      const [r1, r2, r3, r4] = quarticRoots(a!, b!, c!, d!, e!);
      return [r1, r2, r3, r4];
    }
    default:
      return {
        refusal: {
          tag: TAG_DEGREE_TOO_HIGH,
          detail: `irreducible factor of degree ${deg}; radical solution requires Root[] (poly-roots v0.2)`,
        },
      };
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

function buildHappyOutput(roots: { root: Value; multiplicity: number }[]): Value {
  return record({
    roots: list(roots.map((r) => record({
      root: r.root,
      multiplicity: int(BigInt(r.multiplicity)),
    }))),
    method: str("factor-then-radicals"),
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
        method: str("factor-then-radicals"),
        warnings: list([]),
      }),
    },
    {
      description: "Constant input: f = 5 has no roots",
      input: record({ f: int(5n), var: sym("x") }),
      output: record({
        roots: list([]),
        method: str("factor-then-radicals"),
        warnings: list([]),
      }),
    },
    {
      description: "deg-5 irreducible (x⁵ − 2x − 1) ⟹ tagged degree-too-high",
      input: record({
        f: expr("+", [
          expr("^", [sym("x"), int(5n)]),
          expr("*", [int(-2n), sym("x")]),
          int(-1n),
        ]),
        var: sym("x"),
      }),
      output: refuse(
        TAG_DEGREE_TOO_HIGH,
        "irreducible factor of degree 5; radical solution requires Root[] (poly-roots v0.2)",
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
      name: "factor-then-radicals",
      statement: "every reducible polynomial is factored via tools/poly-factor first; each radicals solver receives an irreducible factor",
      machine_checkable: false,
    },
    {
      name: "multiplicity-preserves-count",
      statement: "for f = ∏_i p_i^{e_i}, the output has Σ_i (deg p_i · e_i) entries",
      machine_checkable: true,
    },
    {
      name: "deg-leq-4-supported",
      statement: "every irreducible factor of degree 1..4 produces concrete root expressions; degree ≥ 5 produces a degree-too-high boundary tag",
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
      return buildHappyOutput([]);
    }

    const fact = factorRatQ(fPoly, varSym.name);

    const rootList: { root: Value; multiplicity: number }[] = [];
    for (const fr of fact.factors) {
      const result = rootsOfFactor(fr.factor, varSym.name);
      if (!Array.isArray(result)) {
        return refuse(result.refusal.tag, result.refusal.detail);
      }
      for (const root of result) {
        rootList.push({ root, multiplicity: fr.multiplicity });
      }
    }

    return buildHappyOutput(rootList);
  },
  test: () => {
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
    console.log(
      `poly-roots --test: deg-2 split case green; full coverage in goldens.`,
    );
  },
});

if (import.meta.main) void runTool(def);
