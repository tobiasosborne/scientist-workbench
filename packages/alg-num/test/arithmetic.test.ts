// =============================================================================
// alg-num — algebraic-number arithmetic via resultants (rti)
// =============================================================================
//
// Coverage:
//   • algNumNeg  : minpoly(−α) preserved up to sign-fix; index reversed.
//   • algNumAdd  : √2 + √3 = Root[x⁴ − 10x² + 1, 3] (ADR-0018 headline);
//                  1 + √2 = Root[x² − 2x − 1, 1].
//   • algNumMul  : √2 · √3 = √6 = Root[x² − 6, 1];
//                  √2 · √2 = 2 = Root[x − 2, 0] (rational degenerate).
//   • algNumInv  : 1/√2 = ½√2 = Root[2x² − 1, 1].
//   • algNumSub  : √2 − √2 = 0 (rational singleton).
//   • algNumDiv  : √6 / √2 = √3 = Root[x² − 3, 1].
//   • Cross-construction round-trip: alg-arithmetic results compose
//     with `makeRoot`-by-hint construction of the expected minpoly.

import { describe, expect, test } from "bun:test";
import {
  type Poly,
  type Rat,
  INT_RING,
  RAT_RING,
  makeRat,
  polyAdd,
  polyConst,
  polyEq,
  polyMul,
  polyVar,
} from "@workbench/cas-core";

import {
  ROOT_VAR,
  algNumAdd,
  algNumDiv,
  algNumInv,
  algNumMul,
  algNumNeg,
  algNumSub,
  makeRoot,
  rootCanonicalEq,
  sylvesterResultantInY,
} from "../src/index.js";

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function fromCoeffsLowToHigh(rats: readonly Rat[], v: string = ROOT_VAR): Poly<Rat> {
  const X = polyVar<Rat>(v, RAT_RING);
  const ONE = polyConst<Rat>(makeRat(1n, 1n), RAT_RING);
  let acc = polyConst<Rat>(makeRat(0n, 1n), RAT_RING);
  let pow: Poly<Rat> = ONE;
  for (let i = 0; i < rats.length; i++) {
    acc = polyAdd(acc, polyMul(polyConst<Rat>(rats[i]!, RAT_RING), pow, RAT_RING), RAT_RING);
    if (i + 1 < rats.length) pow = polyMul(pow, X, RAT_RING);
  }
  return acc;
}

function intPolyLowToHigh(coeffs: readonly bigint[]): Poly<bigint> {
  const Xi = polyVar<bigint>(ROOT_VAR, INT_RING);
  const oneI = polyConst<bigint>(1n, INT_RING);
  let acc = polyConst<bigint>(0n, INT_RING);
  let pow: Poly<bigint> = oneI;
  for (let i = 0; i < coeffs.length; i++) {
    acc = polyAdd(acc, polyMul(polyConst<bigint>(coeffs[i]!, INT_RING), pow, INT_RING), INT_RING);
    if (i + 1 < coeffs.length) pow = polyMul(pow, Xi, INT_RING);
  }
  return acc;
}

const rat = (n: bigint, d: bigint = 1n) => makeRat(n, d);

const SQRT2 = makeRoot(
  fromCoeffsLowToHigh([rat(-2n), rat(0n), rat(1n)]),
  { lo: rat(1n), hi: rat(2n) },
  ROOT_VAR,
);

const NEG_SQRT2 = makeRoot(
  fromCoeffsLowToHigh([rat(-2n), rat(0n), rat(1n)]),
  { lo: rat(-2n), hi: rat(-1n) },
  ROOT_VAR,
);

const SQRT3 = makeRoot(
  fromCoeffsLowToHigh([rat(-3n), rat(0n), rat(1n)]),
  { lo: rat(1n), hi: rat(2n) },
  ROOT_VAR,
);

const ONE_R = makeRoot(
  fromCoeffsLowToHigh([rat(-1n), rat(1n)]),     // x − 1
  { lo: rat(1n), hi: rat(1n) },
  ROOT_VAR,
);

// -----------------------------------------------------------------------------
// sylvesterResultantInY — direct sanity tests
// -----------------------------------------------------------------------------

describe("sylvesterResultantInY — sanity", () => {
  test("Res_y(y^2 − 2, y^2 − 3) over ℚ[x] = (3 − 2)^2 · 1 = 1 (constant in x)", () => {
    // Both inputs are constants in x.
    const f = fromCoeffsLowToHigh([rat(-2n), rat(0n), rat(1n)], "y");
    const g = fromCoeffsLowToHigh([rat(-3n), rat(0n), rat(1n)], "y");
    const res = sylvesterResultantInY(f, g, "y");
    // The resultant of two coprime constants-in-x polys is a constant in x.
    // Specifically Res(y^2 − 2, y^2 − 3) = (−1)^{2·2} · (-1) · (−1) · (1)^2 ·
    // (a_n)^{m} · prod (β_j - α_i) = product of differences of roots.
    // The four root-pair-diffs are (√3-√2)(√3+√2)(-√3-√2)(-√3+√2) = (3-2)(-3+2) = (1)(-1) = -1.
    // After degree-aware sign factor sign(-1)^{m·n} = 1: we get ±1.
    // Direct Sylvester evaluation gives 1 (computed elsewhere as a check).
    expect(polyEq(res, polyConst<Rat>(makeRat(1n, 1n), RAT_RING), RAT_RING)).toBe(true);
  });
});

// -----------------------------------------------------------------------------
// algNumNeg
// -----------------------------------------------------------------------------

describe("algNumNeg", () => {
  test("neg(+√2) == −√2 (same minpoly, k = 0)", () => {
    const r = algNumNeg(SQRT2);
    expect(polyEq(r.minpoly, intPolyLowToHigh([-2n, 0n, 1n]), INT_RING)).toBe(true);
    expect(r.k).toBe(0);
    expect(rootCanonicalEq(r, NEG_SQRT2)).toBe(true);
  });

  test("neg(−√2) == +√2 (k = 1)", () => {
    const r = algNumNeg(NEG_SQRT2);
    expect(rootCanonicalEq(r, SQRT2)).toBe(true);
  });

  test("neg(neg(α)) == α (involution)", () => {
    const r = algNumNeg(algNumNeg(SQRT3));
    expect(rootCanonicalEq(r, SQRT3)).toBe(true);
  });

  test("neg(1) == −1 (rational case, minpoly x + 1)", () => {
    const r = algNumNeg(ONE_R);
    expect(polyEq(r.minpoly, intPolyLowToHigh([1n, 1n]), INT_RING)).toBe(true);
    expect(r.k).toBe(0);
  });
});

// -----------------------------------------------------------------------------
// algNumAdd — the headline ADR example
// -----------------------------------------------------------------------------

describe("algNumAdd", () => {
  test("√2 + √3 = Root[x⁴ − 10x² + 1, 3] (ADR-0018 headline)", () => {
    const r = algNumAdd(SQRT2, SQRT3);
    expect(polyEq(r.minpoly, intPolyLowToHigh([1n, 0n, -10n, 0n, 1n]), INT_RING)).toBe(true);
    expect(r.k).toBe(3);   // ascending: −(√2+√3), −(√3−√2), √3−√2, √2+√3
  });

  test("1 + √2 = Root[x² − 2x − 1, 1]", () => {
    const r = algNumAdd(ONE_R, SQRT2);
    // (x − 1)^2 = 2 ⇒ x² − 2x − 1 = 0; roots 1±√2 ascending: 1−√2 (≈ −0.414), 1+√2 (≈ +2.414).
    expect(polyEq(r.minpoly, intPolyLowToHigh([-1n, -2n, 1n]), INT_RING)).toBe(true);
    expect(r.k).toBe(1);
  });

  test("√2 + (−√2) = 0 (rational singleton)", () => {
    const zero = algNumAdd(SQRT2, NEG_SQRT2);
    // Minpoly of 0 is `x`; coefficients [0, 1].
    expect(polyEq(zero.minpoly, intPolyLowToHigh([0n, 1n]), INT_RING)).toBe(true);
    expect(zero.k).toBe(0);
    expect(zero.interval.lo.n).toBe(0n);
    expect(zero.interval.hi.n).toBe(0n);
  });

  test("commutative: α + β = β + α", () => {
    const r1 = algNumAdd(SQRT2, SQRT3);
    const r2 = algNumAdd(SQRT3, SQRT2);
    expect(rootCanonicalEq(r1, r2)).toBe(true);
  });
});

// -----------------------------------------------------------------------------
// algNumSub
// -----------------------------------------------------------------------------

describe("algNumSub", () => {
  test("√3 − √2 = Root[x⁴ − 10x² + 1, 2] (positive of the inner pair)", () => {
    const r = algNumSub(SQRT3, SQRT2);
    expect(polyEq(r.minpoly, intPolyLowToHigh([1n, 0n, -10n, 0n, 1n]), INT_RING)).toBe(true);
    expect(r.k).toBe(2);     // √3 − √2 ≈ 0.318, the second-from-bottom root
  });

  test("α − α = 0", () => {
    const r = algNumSub(SQRT2, SQRT2);
    expect(polyEq(r.minpoly, intPolyLowToHigh([0n, 1n]), INT_RING)).toBe(true);
    expect(r.k).toBe(0);
  });
});

// -----------------------------------------------------------------------------
// algNumMul
// -----------------------------------------------------------------------------

describe("algNumMul", () => {
  test("√2 · √3 = √6 = Root[x² − 6, 1]", () => {
    const r = algNumMul(SQRT2, SQRT3);
    expect(polyEq(r.minpoly, intPolyLowToHigh([-6n, 0n, 1n]), INT_RING)).toBe(true);
    expect(r.k).toBe(1);
  });

  test("√2 · √2 = 2 (rational case, Root[x − 2, 0])", () => {
    const r = algNumMul(SQRT2, SQRT2);
    expect(polyEq(r.minpoly, intPolyLowToHigh([-2n, 1n]), INT_RING)).toBe(true);
    expect(r.k).toBe(0);
  });

  test("√2 · (−√2) = −2 (rational case, Root[x + 2, 0])", () => {
    const r = algNumMul(SQRT2, NEG_SQRT2);
    expect(polyEq(r.minpoly, intPolyLowToHigh([2n, 1n]), INT_RING)).toBe(true);
    expect(r.k).toBe(0);
  });

  test("commutative: α · β = β · α", () => {
    const r1 = algNumMul(SQRT2, SQRT3);
    const r2 = algNumMul(SQRT3, SQRT2);
    expect(rootCanonicalEq(r1, r2)).toBe(true);
  });
});

// -----------------------------------------------------------------------------
// algNumInv
// -----------------------------------------------------------------------------

describe("algNumInv", () => {
  test("1/√2 = √2/2 = Root[2x² − 1, 1]", () => {
    const r = algNumInv(SQRT2);
    expect(polyEq(r.minpoly, intPolyLowToHigh([-1n, 0n, 2n]), INT_RING)).toBe(true);
    expect(r.k).toBe(1);     // +√2/2 ≈ 0.707
  });

  test("inv(inv(α)) == α (involution)", () => {
    const r = algNumInv(algNumInv(SQRT3));
    expect(rootCanonicalEq(r, SQRT3)).toBe(true);
  });

  test("inv(0) throws", () => {
    const ZERO = algNumSub(SQRT2, SQRT2);
    expect(() => algNumInv(ZERO)).toThrow(/zero/i);
  });
});

// -----------------------------------------------------------------------------
// algNumDiv
// -----------------------------------------------------------------------------

describe("algNumDiv", () => {
  test("√6 / √2 = √3 = Root[x² − 3, 1]", () => {
    const SQRT6 = algNumMul(SQRT2, SQRT3);
    const r = algNumDiv(SQRT6, SQRT2);
    expect(polyEq(r.minpoly, intPolyLowToHigh([-3n, 0n, 1n]), INT_RING)).toBe(true);
    expect(r.k).toBe(1);
  });

  test("α / α = 1", () => {
    const r = algNumDiv(SQRT3, SQRT3);
    expect(polyEq(r.minpoly, intPolyLowToHigh([-1n, 1n]), INT_RING)).toBe(true);
    expect(r.k).toBe(0);
  });
});
