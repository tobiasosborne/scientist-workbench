// =============================================================================
// factorIntZ + factorRatQ — top-level pipeline tests
// =============================================================================
//
// These are end-to-end tests of the full Berlekamp + Hensel +
// recombination pipeline. We assert mathematical invariants of the
// factorisation (reconstruction, irreducibility, monicity, multiplicity
// discipline) over a battery of representative cases.

import { describe, expect, test } from "bun:test";
import {
  type Poly,
  type Rat,
  INT_RING,
  RAT_RING,
  makeRat,
  polyAdd,
  polyConst,
  polyDegInVar,
  polyDeriv,
  polyEq,
  polyFromCoeffsInVar,
  polyGcd,
  polyIsOne,
  polyMul,
  polyPow,
  polySub,
  polyVar,
} from "@workbench/cas-core";

import {
  factorIntZ,
  factorPrimitiveSquareFreeZ,
  factorRatQ,
  mignotteBound,
  mignotteHenselExponent,
} from "../src/index.js";

const x = polyVar<bigint>("x", INT_RING);
const c = (n: bigint): Poly<bigint> => polyConst<bigint>(n, INT_RING);
const uniZ = (coefs: bigint[]): Poly<bigint> =>
  polyFromCoeffsInVar(coefs.map(c), "x", INT_RING);

const xQ = polyVar<Rat>("x", RAT_RING);
const cQ = (n: number, d: number = 1): Poly<Rat> =>
  polyConst<Rat>(makeRat(BigInt(n), BigInt(d)), RAT_RING);
const uniQ = (coefs: Rat[]): Poly<Rat> =>
  polyFromCoeffsInVar(coefs.map((co) => polyConst<Rat>(co, RAT_RING)), "x", RAT_RING);

function assertProductEquals(
  factors: readonly Poly<bigint>[],
  expected: Poly<bigint>,
): void {
  let prod: Poly<bigint> = polyConst<bigint>(1n, INT_RING);
  for (const f of factors) prod = polyMul(prod, f, INT_RING);
  expect(polyEq(prod, expected, INT_RING)).toBe(true);
}

function assertEachIrreducibleZ(factors: readonly Poly<bigint>[]): void {
  // Proxy: refeed each factor through the factor pipeline; if it's
  // already irreducible the result is [factor].
  for (const f of factors) {
    if (polyDegInVar(f, "x") <= 1) continue;
    const sub = factorPrimitiveSquareFreeZ(f, "x");
    expect(sub.length).toBe(1);
    expect(polyEq(sub[0]!, f, INT_RING)).toBe(true);
  }
}

function assertMonicZ(factors: readonly Poly<bigint>[]): void {
  for (const f of factors) {
    const d = polyDegInVar(f, "x");
    let lc: bigint | null = null;
    for (const t of f.terms) {
      let pv = 0;
      for (const [name, exp] of t.exp) if (name === "x") pv = exp;
      if (pv === d) lc = t.coef;
    }
    expect(lc).toBe(1n);
  }
}

// -----------------------------------------------------------------------------
// factorPrimitiveSquareFreeZ — primitive monic square-free integer input
// -----------------------------------------------------------------------------

describe("factorPrimitiveSquareFreeZ", () => {
  test("irreducible: x² + 1", () => {
    const f = uniZ([1n, 0n, 1n]);
    const factors = factorPrimitiveSquareFreeZ(f, "x");
    expect(factors.length).toBe(1);
    expect(polyEq(factors[0]!, f, INT_RING)).toBe(true);
  });

  test("(x-1)(x+1) = x² − 1", () => {
    const f = uniZ([-1n, 0n, 1n]);
    const factors = factorPrimitiveSquareFreeZ(f, "x");
    expect(factors.length).toBe(2);
    assertProductEquals(factors, f);
    assertMonicZ(factors);
    assertEachIrreducibleZ(factors);
  });

  test("(x²+1)(x²+x+1)", () => {
    const a = uniZ([1n, 0n, 1n]);
    const b = uniZ([1n, 1n, 1n]);
    const f = polyMul(a, b, INT_RING);
    const factors = factorPrimitiveSquareFreeZ(f, "x");
    expect(factors.length).toBe(2);
    assertProductEquals(factors, f);
    assertEachIrreducibleZ(factors);
  });

  test("x⁴ − 1 = (x − 1)(x + 1)(x² + 1)", () => {
    // Degrees 1, 1, 2 — three irreducibles.
    const f = uniZ([-1n, 0n, 0n, 0n, 1n]);
    const factors = factorPrimitiveSquareFreeZ(f, "x");
    expect(factors.length).toBe(3);
    assertProductEquals(factors, f);
    assertMonicZ(factors);
    assertEachIrreducibleZ(factors);
  });

  test("Cyclotomic Φ₁₂ = x⁴ − x² + 1 — irreducible", () => {
    const f = uniZ([1n, 0n, -1n, 0n, 1n]);
    const factors = factorPrimitiveSquareFreeZ(f, "x");
    expect(factors.length).toBe(1);
    expect(polyEq(factors[0]!, f, INT_RING)).toBe(true);
  });

  test("(x − 1)(x − 2)(x − 3)(x + 4) — four distinct linear factors", () => {
    const a = uniZ([-1n, 1n]);
    const b = uniZ([-2n, 1n]);
    const cc = uniZ([-3n, 1n]);
    const dd = uniZ([4n, 1n]);
    const f = polyMul(polyMul(polyMul(a, b, INT_RING), cc, INT_RING), dd, INT_RING);
    const factors = factorPrimitiveSquareFreeZ(f, "x");
    expect(factors.length).toBe(4);
    assertProductEquals(factors, f);
    assertMonicZ(factors);
    assertEachIrreducibleZ(factors);
  });

  test("Tier-D probe: (x²-2)(x²-3) — two irreducible quadratics", () => {
    // Both irreducible over ℚ (discriminants 8 and 12 are not perfect squares).
    const a = uniZ([-2n, 0n, 1n]);
    const b = uniZ([-3n, 0n, 1n]);
    const f = polyMul(a, b, INT_RING);
    const factors = factorPrimitiveSquareFreeZ(f, "x");
    expect(factors.length).toBe(2);
    assertProductEquals(factors, f);
    assertMonicZ(factors);
    assertEachIrreducibleZ(factors);
  });

  test("Tier-D probe: deg-8 = (x²-2)(x²-3)(x²-5)(x²-7)", () => {
    const a = uniZ([-2n, 0n, 1n]);
    const b = uniZ([-3n, 0n, 1n]);
    const cc = uniZ([-5n, 0n, 1n]);
    const dd = uniZ([-7n, 0n, 1n]);
    const f = polyMul(polyMul(polyMul(a, b, INT_RING), cc, INT_RING), dd, INT_RING);
    const factors = factorPrimitiveSquareFreeZ(f, "x");
    expect(factors.length).toBe(4);
    assertProductEquals(factors, f);
    assertMonicZ(factors);
    assertEachIrreducibleZ(factors);
  });

  test("large-coefficient Mignotte stress: (x − 50)(x + 100)", () => {
    const a = uniZ([-50n, 1n]);
    const b = uniZ([100n, 1n]);
    const f = polyMul(a, b, INT_RING);
    const factors = factorPrimitiveSquareFreeZ(f, "x");
    expect(factors.length).toBe(2);
    assertProductEquals(factors, f);
  });
});

// -----------------------------------------------------------------------------
// factorIntZ — full ℤ[v] handling (content + multiplicities + irreducible)
// -----------------------------------------------------------------------------

describe("factorIntZ", () => {
  test("irreducible monic: returns [(f, 1)] with content 1", () => {
    const f = uniZ([1n, 0n, 1n]);
    const result = factorIntZ(f, "x");
    expect(result.content).toBe(1n);
    expect(result.factors.length).toBe(1);
    expect(result.factors[0]!.multiplicity).toBe(1);
    expect(polyEq(result.factors[0]!.factor, f, INT_RING)).toBe(true);
  });

  test("content extraction: 6x² + 12x + 6 = 6 · (x+1)²", () => {
    const f = uniZ([6n, 12n, 6n]);
    const result = factorIntZ(f, "x");
    expect(result.content).toBe(6n);
    expect(result.factors.length).toBe(1);
    expect(result.factors[0]!.multiplicity).toBe(2);
    expect(polyEq(result.factors[0]!.factor, uniZ([1n, 1n]), INT_RING)).toBe(true);
  });

  test("multiplicity discipline: (x-1)³(x+1)² = x⁵ − x⁴ − 2x³ + 2x² + x − 1", () => {
    const a = uniZ([-1n, 1n]);
    const b = uniZ([1n, 1n]);
    const f = polyMul(polyPow(a, 3, INT_RING), polyPow(b, 2, INT_RING), INT_RING);
    const result = factorIntZ(f, "x");
    expect(result.content).toBe(1n);
    expect(result.factors.length).toBe(2);
    // Verify multiplicities.
    const mults = result.factors.map((r) => r.multiplicity).sort();
    expect(mults).toEqual([2, 3]);
    // Reconstruct.
    let prod: Poly<bigint> = polyConst<bigint>(result.content, INT_RING);
    for (const fr of result.factors) {
      prod = polyMul(prod, polyPow(fr.factor, fr.multiplicity, INT_RING), INT_RING);
    }
    expect(polyEq(prod, f, INT_RING)).toBe(true);
  });

  test("negative leading: −x² + 1 ⟹ content captures sign", () => {
    const f = uniZ([1n, 0n, -1n]);
    const result = factorIntZ(f, "x");
    // We document content as signed; the product reconstructs `f`.
    let prod: Poly<bigint> = polyConst<bigint>(result.content, INT_RING);
    for (const fr of result.factors) {
      prod = polyMul(prod, polyPow(fr.factor, fr.multiplicity, INT_RING), INT_RING);
    }
    expect(polyEq(prod, f, INT_RING)).toBe(true);
  });

  test("constant input: f = 5 ⟹ content 5, no factors", () => {
    const f = c(5n);
    const result = factorIntZ(f, "x");
    expect(result.content).toBe(5n);
    expect(result.factors.length).toBe(0);
  });

  test("zero input throws", () => {
    const zero: Poly<bigint> = { terms: [] };
    expect(() => factorIntZ(zero, "x")).toThrow();
  });
});

// -----------------------------------------------------------------------------
// factorRatQ — the user-facing ℚ[v] entry point
// -----------------------------------------------------------------------------

describe("factorRatQ", () => {
  test("simple monic irreducible over ℚ: x² + 1", () => {
    const f = uniQ([makeRat(1n, 1n), makeRat(0n, 1n), makeRat(1n, 1n)]);
    const result = factorRatQ(f, "x");
    expect(result.content.n === 1n && result.content.d === 1n).toBe(true);
    expect(result.factors.length).toBe(1);
    expect(result.factors[0]!.multiplicity).toBe(1);
    expect(polyEq(result.factors[0]!.factor, f, RAT_RING)).toBe(true);
  });

  test("rational content: (1/2) · (x² − 1)", () => {
    // f = (1/2)(x − 1)(x + 1) = (1/2)x² − 1/2
    const f = uniQ([makeRat(-1n, 2n), makeRat(0n, 1n), makeRat(1n, 2n)]);
    const result = factorRatQ(f, "x");
    expect(result.content.n).toBe(1n);
    expect(result.content.d).toBe(2n);
    expect(result.factors.length).toBe(2);

    // Reconstruct.
    let prod: Poly<Rat> = polyConst<Rat>(result.content, RAT_RING);
    for (const fr of result.factors) {
      prod = polyMul(prod, polyPow(fr.factor, fr.multiplicity, RAT_RING), RAT_RING);
    }
    expect(polyEq(prod, f, RAT_RING)).toBe(true);
  });

  test("primitive monic over ℚ: (x²+1)(x³+x+1) — both irreducible", () => {
    const a = uniQ([makeRat(1n, 1n), makeRat(0n, 1n), makeRat(1n, 1n)]);
    const b = uniQ([makeRat(1n, 1n), makeRat(1n, 1n), makeRat(0n, 1n), makeRat(1n, 1n)]);
    const f = polyMul(a, b, RAT_RING);
    const result = factorRatQ(f, "x");
    expect(result.factors.length).toBe(2);
    let prod: Poly<Rat> = polyConst<Rat>(result.content, RAT_RING);
    for (const fr of result.factors) {
      prod = polyMul(prod, polyPow(fr.factor, fr.multiplicity, RAT_RING), RAT_RING);
    }
    expect(polyEq(prod, f, RAT_RING)).toBe(true);
  });

  test("rejects multivariate input", () => {
    const x = polyVar<Rat>("x", RAT_RING);
    const y = polyVar<Rat>("y", RAT_RING);
    const f = polyAdd(polyMul(x, y, RAT_RING), cQ(1), RAT_RING);
    expect(() => factorRatQ(f, "x")).toThrow(/multivariate/);
  });

  test("rejects zero input", () => {
    const zero: Poly<Rat> = { terms: [] };
    expect(() => factorRatQ(zero, "x")).toThrow();
  });
});

// -----------------------------------------------------------------------------
// Mignotte bound diagnostics
// -----------------------------------------------------------------------------

describe("mignotteBound + mignotteHenselExponent", () => {
  test("simple: f = x² + 1, bound is reasonable", () => {
    const f = uniZ([1n, 0n, 1n]);
    const M = mignotteBound(f, "x");
    // n=2, ‖f‖∞=1, lc=1: ⌈√3⌉ · 4 · 1 · 1 = 2·4 = 8.
    expect(M).toBe(8n);
  });

  test("Hensel exponent grows logarithmically with M", () => {
    const f = uniZ([1n, 0n, 1n]);
    const e3 = mignotteHenselExponent(f, 3n, "x");
    const e7 = mignotteHenselExponent(f, 7n, "x");
    expect(e3).toBeGreaterThan(0);
    expect(e7).toBeGreaterThan(0);
    // For a fixed M, larger p needs smaller exponent.
    expect(e7).toBeLessThanOrEqual(e3);
  });

  test("bound monotonic in degree and ‖f‖∞", () => {
    const f1 = uniZ([1n, 0n, 1n]);
    const f2 = uniZ([1n, 0n, 0n, 0n, 1n]);
    const f3 = uniZ([100n, 0n, 1n]);
    expect(mignotteBound(f2, "x")).toBeGreaterThan(mignotteBound(f1, "x"));
    expect(mignotteBound(f3, "x")).toBeGreaterThan(mignotteBound(f1, "x"));
  });
});

// silence unused-import lint
void polyDeriv;
void polyGcd;
void polyIsOne;
void polySub;
