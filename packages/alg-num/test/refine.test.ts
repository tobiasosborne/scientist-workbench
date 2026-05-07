// =============================================================================
// alg-num — refineRoot: lazy isolating-interval refinement
// =============================================================================
//
// Coverage:
//   • Refines until target width is met.
//   • Bracket invariant preserved: refined interval still contains the
//     named root (verified via sign criterion at endpoints).
//   • Idempotence: refining beyond the current width is a no-op.
//   • Bit-precision target.
//   • Singleton intervals (rational roots) are unchanged.
//   • Canonical equality preserved across refinement.
//   • Edge: bits=0 (target width 1).
//   • Refusals: both maxWidth + bits supplied; negative bits;
//     non-positive maxWidth.

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
  intervalWidth,
  makeRoot,
  refineRoot,
  rootCanonicalEq,
  signAtRat,
} from "../src/index.js";

// -----------------------------------------------------------------------------
// Helpers — small ratFn-style polynomial constructors over ℚ in `x`.
// -----------------------------------------------------------------------------

const X = polyVar<Rat>(ROOT_VAR, RAT_RING);
const ONE_Q = polyConst<Rat>(makeRat(1n, 1n), RAT_RING);

function fromCoeffsLowToHigh(rats: readonly Rat[]): Poly<Rat> {
  let acc = polyConst<Rat>(makeRat(0n, 1n), RAT_RING);
  let pow = ONE_Q;
  for (let i = 0; i < rats.length; i++) {
    const term = polyMul(polyConst<Rat>(rats[i]!, RAT_RING), pow, RAT_RING);
    acc = polyAdd(acc, term, RAT_RING);
    pow = polyMul(pow, X, RAT_RING);
  }
  return acc;
}

const rat = (n: bigint, d: bigint = 1n) => makeRat(n, d);

// `+√2` Root, repeatedly used.
function makeSqrt2() {
  return makeRoot(
    fromCoeffsLowToHigh([rat(-2n), rat(0n), rat(1n)]),
    { lo: rat(1n), hi: rat(2n) },
    ROOT_VAR,
  );
}

function ratLE(a: Rat, b: Rat): boolean {
  return a.n * b.d <= b.n * a.d;
}

function ratGT(a: Rat, b: Rat): boolean {
  return a.n * b.d > b.n * a.d;
}

// -----------------------------------------------------------------------------
// Bit-precision target
// -----------------------------------------------------------------------------

describe("refineRoot — bit-precision target", () => {
  test("bits=10 narrows +√2's interval below 2^{-10}", () => {
    const r = makeSqrt2();
    const refined = refineRoot(r, { bits: 10 });
    const w = intervalWidth(refined.interval);
    const target = makeRat(1n, 1024n);
    expect(ratLE(w, target)).toBe(true);
  });

  test("bits=64 narrows +√2's interval below 2^{-64}", () => {
    const r = makeSqrt2();
    const refined = refineRoot(r, { bits: 64 });
    const w = intervalWidth(refined.interval);
    const target = makeRat(1n, 1n << 64n);
    expect(ratLE(w, target)).toBe(true);
  });

  test("bits=0 narrows +√2's interval below 1 (its initial width is 1)", () => {
    const r = makeSqrt2();
    expect(intervalWidth(r.interval).n).toBe(1n);
    const refined = refineRoot(r, { bits: 0 });
    const w = intervalWidth(refined.interval);
    const one = makeRat(1n, 1n);
    expect(ratLE(w, one)).toBe(true);
  });
});

// -----------------------------------------------------------------------------
// Bracket invariant: refined interval still contains the root
// -----------------------------------------------------------------------------

describe("refineRoot — bracket invariant", () => {
  test("after refining +√2, sign(g(lo)) and sign(g(hi)) are still opposite", () => {
    const r = makeSqrt2();
    const refined = refineRoot(r, { bits: 32 });
    const sLo = signAtRat(refined.minpoly, refined.interval.lo, ROOT_VAR);
    const sHi = signAtRat(refined.minpoly, refined.interval.hi, ROOT_VAR);
    // Either bracket (opposite signs, root strictly inside) or
    // singleton (one sign zero, root at endpoint).
    if (sLo === 0 || sHi === 0) {
      expect(refined.interval.lo).toEqual(refined.interval.hi);
    } else {
      expect(sLo).toBe(-sHi as -1 | 1);
    }
  });

  test("after refining the smallest real root of x^5 − x − 1, root is bracketed", () => {
    const r = makeRoot(
      fromCoeffsLowToHigh([rat(-1n), rat(-1n), rat(0n), rat(0n), rat(0n), rat(1n)]),
      { lo: rat(1n), hi: rat(2n) },
      ROOT_VAR,
    );
    const refined = refineRoot(r, { bits: 50 });
    const sLo = signAtRat(refined.minpoly, refined.interval.lo, ROOT_VAR);
    const sHi = signAtRat(refined.minpoly, refined.interval.hi, ROOT_VAR);
    if (sLo === 0 || sHi === 0) {
      expect(refined.interval.lo).toEqual(refined.interval.hi);
    } else {
      expect(sLo).toBe(-sHi as -1 | 1);
    }
  });

  test("refined interval lies inside the original interval", () => {
    const r = makeSqrt2();
    const refined = refineRoot(r, { bits: 16 });
    expect(refined.interval.lo.n * r.interval.lo.d).toBeGreaterThanOrEqual(
      r.interval.lo.n * refined.interval.lo.d,
    );
    expect(refined.interval.hi.n * r.interval.hi.d).toBeLessThanOrEqual(
      r.interval.hi.n * refined.interval.hi.d,
    );
  });
});

// -----------------------------------------------------------------------------
// Idempotence + monotone narrowing
// -----------------------------------------------------------------------------

describe("refineRoot — idempotence and monotone narrowing", () => {
  test("refining to a width ≥ current width is a no-op (same Root identity)", () => {
    const r = makeSqrt2();
    // Initial width is 1 (interval (1, 2)).
    const noOp = refineRoot(r, { maxWidth: rat(2n) });
    expect(noOp).toBe(r);   // returned the input unchanged
  });

  test("refining further narrows further (monotone)", () => {
    const r = makeSqrt2();
    const r1 = refineRoot(r, { bits: 8 });
    const r2 = refineRoot(r1, { bits: 32 });
    expect(ratGT(intervalWidth(r1.interval), intervalWidth(r2.interval))).toBe(true);
  });

  test("refining a refined Root to the same target is a no-op", () => {
    const r = makeSqrt2();
    const refined = refineRoot(r, { bits: 16 });
    const refinedAgain = refineRoot(refined, { bits: 16 });
    expect(refinedAgain).toBe(refined);
  });
});

// -----------------------------------------------------------------------------
// Canonical equality is preserved
// -----------------------------------------------------------------------------

describe("refineRoot — canonical identity", () => {
  test("rootCanonicalEq(refineRoot(r, t), r) is always true", () => {
    const r = makeSqrt2();
    expect(rootCanonicalEq(refineRoot(r, { bits: 0 }), r)).toBe(true);
    expect(rootCanonicalEq(refineRoot(r, { bits: 16 }), r)).toBe(true);
    expect(rootCanonicalEq(refineRoot(r, { bits: 64 }), r)).toBe(true);
  });

  test("minpoly bytes are identical pre- and post-refinement", () => {
    const r = makeSqrt2();
    const refined = refineRoot(r, { bits: 32 });
    expect(polyEq(refined.minpoly, r.minpoly, INT_RING)).toBe(true);
    expect(refined.k).toBe(r.k);
  });
});

// -----------------------------------------------------------------------------
// Singleton (rational root) is unchanged
// -----------------------------------------------------------------------------

describe("refineRoot — singleton intervals", () => {
  test("rational root (singleton interval) is a no-op", () => {
    // Linear x − 3 with hint [3, 3] gives a singleton interval (3, 3).
    const r = makeRoot(
      fromCoeffsLowToHigh([rat(-3n), rat(1n)]),
      { lo: rat(3n), hi: rat(3n) },
      ROOT_VAR,
    );
    expect(r.interval.lo).toEqual(r.interval.hi);
    const refined = refineRoot(r, { bits: 64 });
    expect(refined).toBe(r);
  });
});

// -----------------------------------------------------------------------------
// Refusals
// -----------------------------------------------------------------------------

describe("refineRoot — refusals", () => {
  const r = makeSqrt2();

  test("both maxWidth and bits supplied → throws", () => {
    expect(() => refineRoot(r, { maxWidth: rat(1n, 100n), bits: 10 })).toThrow(/exactly one/i);
  });

  test("neither maxWidth nor bits supplied → throws", () => {
    expect(() => refineRoot(r, {})).toThrow(/exactly one/i);
  });

  test("negative bits → throws", () => {
    expect(() => refineRoot(r, { bits: -1 })).toThrow(/non-negative/i);
  });

  test("non-integer bits → throws", () => {
    expect(() => refineRoot(r, { bits: 0.5 })).toThrow(/integer/i);
  });

  test("zero or negative maxWidth → throws", () => {
    expect(() => refineRoot(r, { maxWidth: rat(0n, 1n) })).toThrow(/positive/i);
    expect(() => refineRoot(r, { maxWidth: rat(-1n, 1n) })).toThrow(/positive/i);
  });
});
