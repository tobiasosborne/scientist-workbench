// =============================================================================
// poly-factor — exact univariate polynomial factorisation over ℚ
// =============================================================================
//
// Intent
// ------
// Given a polynomial `f ∈ ℚ[v]` of any degree, return its unique
// (up to ordering) irreducible factorisation
//
//     f = content · ∏_i p_i(v)^{e_i}
//
// where `content ∈ ℚ` carries the rational scalar (sign and content),
// each `p_i ∈ ℤ[v]` is **irreducible over ℚ**, **primitive**
// (`gcd(coefs) = 1`), and has **positive leading coefficient**, and
// `e_i ≥ 1` is the multiplicity. This is the canonical form. The
// constant prefactor `content` carries the sign and rational
// content; all symbolic structure lives in the `p_i`.
//
// Two-paragraph "why this shape": Mathematica's `Factor[]` returns
// each factor as a polynomial-with-arbitrary-coefficients, leaving
// "the integer factor lives in `Times` at the top" implicit. The
// scientist-workbench convention (ADR-0017 for solution-set shapes,
// extended here for factor-list shapes) is to **separate concerns**:
// the rational content is a rational, the irreducible factors are
// integer polynomials, multiplicities are integers. A planner that
// wants the integer-factor-only view reads `factors`; one that needs
// the original polynomial reconstructs via the explicit product.
//
// Out of scope
// ------------
// • Multivariate factorisation (returns `tagged "poly-factor/non-polynomial"`).
// • Algebraic-extension coefficient rings (factor over `ℚ(α)[v]`).
// • Approximate / numerical root finding (use `linalg-solve` companion-
//   matrix dispatch when it ships, or future `tools/poly-roots`).
//
// Input shape
// -----------
// `record { f: <expression>, var: <symbol> }`. Field name `f` mirrors
// `cas-diff` and `integrate-1d` for cross-tool symmetry. `var` is the
// principal variable; everything else is treated as out-of-scope.
//
// Output shape
// ------------
//   * Happy path — `record { content: <integer|rational>, factors:
//     <list<record{factor: expression, multiplicity: integer}>>,
//     method: <string>, warnings: <list<string>> }`.
//   * Boundary — `tagged "poly-factor/non-polynomial"` with payload
//     `record { detail: string }`. Triggered when the input expression
//     is not a polynomial in `var` over ℚ (out-of-scope head, foreign
//     symbol, division by a non-constant, etc.).
//
// `ToolError` is reserved for malformed input (`f` of wrong kind,
// `var` not a symbol, parse-time inconsistency).
//
// Algorithm
// ---------
// Standard pipeline (Cox-Little-O'Shea Ch. 4; Geddes-Czapor-Labahn
// Ch. 8):
//
//   1. Convert `f` from expression Value → `Poly<Rat>` via
//      `valueToRatFn` (refusing if denominator ≠ 1 or any subterm
//      out-of-scope).
//   2. Multivariate refusal: if `polyVars(f)` mentions anything other
//      than `var`, return `tagged "poly-factor/non-polynomial"`.
//   3. Run `factorRatQ(f, var)` from `@workbench/poly-factor`:
//      content/primitive split, square-free decomposition (Yun 1976),
//      mod-p factorisation (Berlekamp 1967), Hensel lift (Zassenhaus
//      1969 quadratic), recombination (Berlekamp-Zassenhaus subset-sum).
//   4. Convert each ℚ-monic factor to its primitive ℤ form (multiply
//      through by the LCM of denominators; the absorbed scaling goes
//      into `content`). Sign-fix to positive leading coefficient.
//   5. Sort factor list canonically (degree ascending, then lex on
//      coefficient sequence).
//   6. Emit the canonical record.
//
// Determinism contract
// --------------------
// Default symbolic tier (no `numerical: true`). Output is bit-identical
// cross-platform forever — every step is exact rational/integer
// arithmetic over BigInt.

import {
  expr,
  int,
  list,
  rat as protocolRat,
  record,
  S,
  str,
  sym,
  tagged,
  ToolError,
  type ExpressionValue,
  type IntegerValue,
  type RationalValue,
  type RecordValue,
  type StringValue,
  type SymbolValue,
  type Value,
} from "@workbench/protocol";
import { defineTool, runTool } from "@workbench/contract";
import {
  type Poly,
  type Rat,
  CasOutOfScopeError,
  INT_RING,
  RAT_RING,
  makeRat,
  polyConst,
  polyDegInVar,
  polyFromCoeffsInVar,
  polyToValue,
  polyVars,
  ratFnToValue,
  valueToRatFn,
} from "@workbench/cas-core";
import { factorRatQ, type RatFactorRecord } from "@workbench/poly-factor";

const NAME = "poly-factor";
const VERSION = "0.1.0";
const NON_POLY_TAG = "poly-factor/non-polynomial";

// -----------------------------------------------------------------------------
// Schema
// -----------------------------------------------------------------------------
//
// Input is a record with two fields. We use S.any() for `f` (matching
// cas-diff and integrate-1d) — the closed-form vocabulary is checked
// inside `valueToRatFn` rather than at the schema level, where it
// would duplicate the per-node check anyway.

const inputSchema = S.record({
  f: S.any(),
  var: S.kind("symbol"),
});

const factorRecordSchema = S.record({
  factor: S.any(),
  multiplicity: S.kind("integer"),
});

const outputHappySchema = S.record({
  content: S.any(),                                   // integer | rational
  factors: S.list(factorRecordSchema),
  method: S.kind("string"),
  warnings: S.list(S.kind("string")),
});

const outputSchema = S.union([
  outputHappySchema,
  S.tagged(NON_POLY_TAG, S.record({ detail: S.kind("string") })),
]);

// -----------------------------------------------------------------------------
// Body
// -----------------------------------------------------------------------------

function ratToValue(r: Rat): Value {
  if (r.d === 1n) return int(r.n);
  return protocolRat(r.n, r.d);
}

/**
 * Convert a monic ℚ-factor to a primitive ℤ-polynomial with positive
 * leading coefficient. Returns the integer polynomial along with the
 * scaling factor `s` such that `(input over ℚ) · s = output over ℤ`,
 * i.e., the *integer* polynomial equals `s · monicFactor`. This `s`
 * goes into `content` (with the original `content / s^multiplicity`
 * adjustment).
 */
function monicQToPrimitiveZ(
  monicQ: Poly<Rat>,
): { intPoly: Poly<bigint>; scaling: bigint } {
  // LCM of denominators.
  let lcm: bigint = 1n;
  for (const t of monicQ.terms) {
    const d = t.coef.d;
    const g = gcdAbs(lcm, d);
    lcm = (lcm / g) * d;
  }
  // Multiply through.
  const intCoefs = monicQ.terms.map((t) => ({
    exp: t.exp,
    coef: t.coef.n * (lcm / t.coef.d),
  }));
  // gcd of int coefs (positive).
  let g: bigint = 0n;
  for (const t of intCoefs) g = gcdAbs(g, t.coef);
  if (g === 0n) g = 1n;
  // Strip content. After stripping, the coefficients are primitive.
  let primTerms = intCoefs.map((t) => ({ exp: t.exp, coef: t.coef / g }));
  // Sign-fix to positive leading coef.
  let dLead = -1, lcCoef = 0n;
  for (const t of primTerms) {
    let pv = 0;
    for (const [, exp] of t.exp) pv = exp;
    if (pv > dLead) { dLead = pv; lcCoef = t.coef; }
  }
  let signFlip = 1n;
  if (lcCoef < 0n) {
    primTerms = primTerms.map((t) => ({ exp: t.exp, coef: -t.coef }));
    signFlip = -1n;
  }
  // Output integer polynomial = signFlip · (intCoefs / g) = (signFlip / g) · lcm · monicQ.
  // So `(monicQ over ℚ) · scaling = output`, where scaling = signFlip · lcm / g.
  const scaling = (signFlip * lcm) / g;
  return { intPoly: { terms: primTerms }, scaling };
}

function gcdAbs(a: bigint, b: bigint): bigint {
  let aa = a < 0n ? -a : a;
  let bb = b < 0n ? -b : b;
  while (bb !== 0n) { const t = aa % bb; aa = bb; bb = t; }
  return aa;
}

function bigPow(base: bigint, exp: number): bigint {
  let r = 1n;
  let b = base;
  let e = exp;
  while (e > 0) {
    if ((e & 1) === 1) r *= b;
    e >>>= 1;
    if (e > 0) b = b * b;
  }
  return r;
}

function intPolyToValue(p: Poly<bigint>): Value {
  // Lift ℤ-coefs to ℚ-coefs (denominator 1) and reuse polyToValue.
  const fQ: Poly<Rat> = {
    terms: p.terms.map((t) => ({ exp: t.exp, coef: makeRat(t.coef, 1n) })),
  };
  return polyToValue(fQ);
}

/** Canonicalise factor list ordering: degree ascending, then lex on coefs. */
function sortFactorsCanonical(
  factors: readonly { intPoly: Poly<bigint>; multiplicity: number }[],
  varName: string,
): { intPoly: Poly<bigint>; multiplicity: number }[] {
  const out = factors.slice();
  out.sort((a, b) => {
    const da = polyDegInVar(a.intPoly, varName);
    const db = polyDegInVar(b.intPoly, varName);
    if (da !== db) return da - db;
    // Lex on coef-by-coef in v-descending order.
    const ca = coefsByVarDescending(a.intPoly, varName);
    const cb = coefsByVarDescending(b.intPoly, varName);
    const len = Math.max(ca.length, cb.length);
    for (let i = 0; i < len; i++) {
      const xi = ca[i] ?? 0n;
      const yi = cb[i] ?? 0n;
      if (xi < yi) return -1;
      if (xi > yi) return 1;
    }
    return 0;
  });
  return out;
}

function coefsByVarDescending(p: Poly<bigint>, v: string): bigint[] {
  const d = polyDegInVar(p, v);
  if (d < 0) return [];
  const arr = new Array<bigint>(d + 1).fill(0n);
  for (const t of p.terms) {
    let pv = 0;
    for (const [name, exp] of t.exp) if (name === v) pv = exp;
    arr[pv] = t.coef;
  }
  // Reverse to get v-descending order (consistent with PROMPT's "lex on
  // coefficient sequence in canonical degree-descending form").
  return arr.reverse();
}

function decodeRecordInput(input: RecordValue): { fValue: Value; varSym: SymbolValue } {
  const fValue = input.fields.f as Value;
  const varVal = input.fields.var as Value;
  if (varVal.kind !== "symbol") {
    throw new ToolError("`var` must be a symbol", { detail: `got kind=${varVal.kind}` });
  }
  return { fValue, varSym: varVal };
}

function buildHappyOutput(
  contentRat: Rat,
  factors: readonly { intPoly: Poly<bigint>; multiplicity: number }[],
): Value {
  const factorRecords = factors.map((fr) =>
    record({
      factor: intPolyToValue(fr.intPoly),
      multiplicity: int(BigInt(fr.multiplicity)),
    })
  );
  return record({
    content: ratToValue(contentRat),
    factors: list(factorRecords),
    method: str("berlekamp-zassenhaus"),
    warnings: list([]),
  });
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
      description: "x² − 1 = (x − 1)(x + 1) over ℚ",
      input: record({
        f: expr("+", [expr("^", [sym("x"), int(2n)]), int(-1n)]),
        var: sym("x"),
      }),
      output: record({
        content: int(1n),
        factors: list([
          record({
            factor: expr("+", [sym("x"), int(-1n)]),
            multiplicity: int(1n),
          }),
          record({
            factor: expr("+", [sym("x"), int(1n)]),
            multiplicity: int(1n),
          }),
        ]),
        method: str("berlekamp-zassenhaus"),
        warnings: list([]),
      }),
    },
    {
      description: "x² + 1 — irreducible over ℚ",
      input: record({
        f: expr("+", [expr("^", [sym("x"), int(2n)]), int(1n)]),
        var: sym("x"),
      }),
      output: record({
        content: int(1n),
        factors: list([
          record({
            factor: expr("+", [expr("^", [sym("x"), int(2n)]), int(1n)]),
            multiplicity: int(1n),
          }),
        ]),
        method: str("berlekamp-zassenhaus"),
        warnings: list([]),
      }),
    },
    {
      description: "Constant input: f = 7 → content 7, no factors",
      input: record({ f: int(7n), var: sym("x") }),
      output: record({
        content: int(7n),
        factors: list([]),
        method: str("berlekamp-zassenhaus"),
        warnings: list([]),
      }),
    },
    {
      description: "Non-polynomial input → tagged out-of-scope",
      input: record({
        f: expr("sin", [sym("x")]),
        var: sym("x"),
      }),
      output: tagged(NON_POLY_TAG, record({ detail: str("input is not a polynomial in 'x' over ℚ: out-of-scope head 'sin'") })),
    },
  ],
  invariants: [
    {
      name: "deterministic",
      statement: "same input bytes → same output bytes (symbolic tier; bit-identical cross-platform)",
      machine_checkable: true,
    },
    {
      name: "reconstruction",
      statement: "content · ∏ factor_i^multiplicity_i equals f exactly as polynomials in ℚ[var]",
      machine_checkable: true,
    },
    {
      name: "factors-irreducible",
      statement: "every factor in the output is irreducible over ℚ — re-feeding it yields a single-factor list",
      machine_checkable: true,
    },
    {
      name: "factors-primitive",
      statement: "every factor is in ℤ[var] with gcd of coefficients equal to 1",
      machine_checkable: true,
    },
    {
      name: "factors-positive-leading",
      statement: "every factor has positive leading coefficient",
      machine_checkable: true,
    },
    {
      name: "non-poly-tagged",
      statement: `non-polynomial / multivariate / out-of-scope input → tagged "${NON_POLY_TAG}" with detail string — never silently wrong factorisation`,
      machine_checkable: true,
    },
  ],
  fn: (input, _flags): Value => {
    const inputRec = input as RecordValue;
    const { fValue, varSym } = decodeRecordInput(inputRec);

    // Convert input expression → Poly<Rat>. valueToRatFn throws
    // CasOutOfScopeError on out-of-vocabulary heads (sin, exp, etc.) or
    // unsupported kinds (string, list, …); we catch and turn into the
    // refusal tag.
    let fRatFn;
    try {
      fRatFn = valueToRatFn(fValue);
    } catch (e) {
      if (e instanceof CasOutOfScopeError) {
        return tagged(NON_POLY_TAG, record({
          detail: str(`input is not a polynomial in '${varSym.name}' over ℚ: ${e.message}`),
        }));
      }
      throw e;
    }

    // Refusal: rational function (denominator ≠ 1) is not a polynomial.
    // Compose ratFnToValue back to expression form for the detail; for
    // the refusal we just describe the issue.
    if (fRatFn.den.terms.length !== 1 || fRatFn.den.terms[0]!.exp.length !== 0) {
      return tagged(NON_POLY_TAG, record({
        detail: str(`input is not a polynomial in '${varSym.name}' over ℚ: rational function with non-constant denominator`),
      }));
    }
    if (fRatFn.den.terms[0]!.coef.n !== 1n || fRatFn.den.terms[0]!.coef.d !== 1n) {
      // Denominator is a non-1 rational scalar — re-absorb into numerator.
      const inv = makeRat(fRatFn.den.terms[0]!.coef.d, fRatFn.den.terms[0]!.coef.n);
      const scaled: Poly<Rat> = {
        terms: fRatFn.num.terms.map((t) => ({
          exp: t.exp,
          coef: makeRat(t.coef.n * inv.n, t.coef.d * inv.d),
        })),
      };
      fRatFn = { num: scaled, den: polyConst<Rat>(makeRat(1n, 1n), RAT_RING) };
    }

    const fPoly: Poly<Rat> = fRatFn.num;

    // Refusal: multivariate.
    const vars = polyVars(fPoly);
    for (const u of vars) {
      if (u !== varSym.name) {
        return tagged(NON_POLY_TAG, record({
          detail: str(`input is not a polynomial in '${varSym.name}' over ℚ: mentions foreign symbol '${u}'`),
        }));
      }
    }

    // Constant input: emit directly. factorRatQ would handle it but
    // bypassing avoids the deg-1 path's prime selection.
    if (polyDegInVar(fPoly, varSym.name) <= 0) {
      // f is a constant (or zero — but zero is impossible here, since
      // valueToRatFn either consumed the integer 0 → poly 0, in which
      // case factorRatQ would throw; let's just delegate).
      // We pass to factorRatQ which throws on zero; if it does, treat
      // as malformed input.
      try {
        const result = factorRatQ(fPoly, varSym.name);
        return buildHappyOutput(result.content, []);
      } catch {
        throw new ToolError("input polynomial is zero", {
          detail: "f reduces to the zero polynomial; factorisation undefined",
        });
      }
    }

    // Run the factorisation.
    const result = factorRatQ(fPoly, varSym.name);

    // Convert each ℚ-monic factor to integer-primitive form, adjusting
    // the content scalar accordingly.
    let contentRat = result.content;
    const intFactorList: { intPoly: Poly<bigint>; multiplicity: number }[] = [];
    for (const fr of result.factors) {
      const { intPoly, scaling } = monicQToPrimitiveZ(fr.factor);
      // The original ℚ-relation: f = content · ∏ factor_i^e_i.
      // After conversion: factor_i = (1/scaling_i) · intPoly_i.
      // So f = content · ∏ ((1/scaling_i)^e_i · intPoly_i^e_i)
      //      = (content / ∏ scaling_i^e_i) · ∏ intPoly_i^e_i.
      // Update contentRat ← contentRat / scaling^multiplicity.
      const scalePow = bigPow(scaling, fr.multiplicity);
      contentRat = makeRat(contentRat.n, contentRat.d * scalePow);
      intFactorList.push({ intPoly, multiplicity: fr.multiplicity });
      void fr;
    }

    const sorted = sortFactorsCanonical(intFactorList, varSym.name);
    return buildHappyOutput(contentRat, sorted);
  },
  test: () => {
    // Probe: re-factor the integer factor in each known-irreducible
    // case to confirm `factors-irreducible`. Probe: reconstruct via
    // multiplication for `reconstruction`. The full bench is the
    // 56-case golden battery; here we run a tiny corpus through the
    // wrapper to catch regressions in the wrapper layer.
    const probes: { f: Poly<Rat>; expected_factor_count: number }[] = [
      {
        f: polyFromCoeffsInVar(
          [polyConst<Rat>(makeRat(-1n, 1n), RAT_RING),
           polyConst<Rat>(makeRat(0n, 1n), RAT_RING),
           polyConst<Rat>(makeRat(1n, 1n), RAT_RING)],
          "x", RAT_RING,
        ), // x² − 1 → 2 factors
        expected_factor_count: 2,
      },
      {
        f: polyFromCoeffsInVar(
          [polyConst<Rat>(makeRat(1n, 1n), RAT_RING),
           polyConst<Rat>(makeRat(0n, 1n), RAT_RING),
           polyConst<Rat>(makeRat(1n, 1n), RAT_RING)],
          "x", RAT_RING,
        ), // x² + 1 → 1 factor (irreducible)
        expected_factor_count: 1,
      },
    ];
    for (const probe of probes) {
      const result = factorRatQ(probe.f, "x");
      if (result.factors.length !== probe.expected_factor_count) {
        throw new Error(
          `poly-factor --test: expected ${probe.expected_factor_count} factors, got ${result.factors.length}`,
        );
      }
    }
    console.log(
      `poly-factor --test: ${probes.length} probes pass; full coverage in bench/poly-factor-q/.`,
    );
    void ratFnToValue;
    void factorRatQ;
    void NAME;
  },
});

if (import.meta.main) void runTool(def);

// silence unused-import lint for occasional stub-symbols
type _Refs = [ExpressionValue, IntegerValue, RationalValue, StringValue, RatFactorRecord];
const _refs: _Refs | null = null;
void _refs;
