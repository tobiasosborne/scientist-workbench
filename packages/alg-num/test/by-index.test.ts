// =============================================================================
// alg-num — makeRootByIndex: canonicalising constructor by global k
// =============================================================================
//
// `makeRootByIndex(poly, k, v)` is the construction primitive for
// resultant-style operations (rti) and non-canonical-wire parsing
// (encoding.ts → valueToRoot fallback). It accepts a polynomial that
// may be reducible / non-monic / non-primitive and a 0-indexed global
// real-root selector, and returns the canonical Root (with a possibly-
// reindexed k inside its irreducible factor).

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
  makeRootByIndex,
  rootCanonicalEq,
  makeRoot,
} from "../src/index.js";

// -----------------------------------------------------------------------------
// Helpers
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

function intPolyLowToHigh(coeffs: readonly bigint[]): Poly<bigint> {
  const Xi = polyVar<bigint>(ROOT_VAR, INT_RING);
  const oneI = polyConst<bigint>(1n, INT_RING);
  let acc = polyConst<bigint>(0n, INT_RING);
  let pow = oneI;
  for (let i = 0; i < coeffs.length; i++) {
    const term = polyMul(polyConst<bigint>(coeffs[i]!, INT_RING), pow, INT_RING);
    acc = polyAdd(acc, term, INT_RING);
    pow = polyMul(pow, Xi, INT_RING);
  }
  return acc;
}

const rat = (n: bigint, d: bigint = 1n) => makeRat(n, d);

// -----------------------------------------------------------------------------
// Irreducible inputs — k matches inner k
// -----------------------------------------------------------------------------

describe("makeRootByIndex — irreducible inputs", () => {
  test("x^2 − 2: global k=0 → −√2 (k=0); global k=1 → +√2 (k=1)", () => {
    const f = fromCoeffsLowToHigh([rat(-2n), rat(0n), rat(1n)]);
    const neg = makeRootByIndex(f, 0, ROOT_VAR);
    const pos = makeRootByIndex(f, 1, ROOT_VAR);
    expect(polyEq(neg.minpoly, intPolyLowToHigh([-2n, 0n, 1n]), INT_RING)).toBe(true);
    expect(neg.k).toBe(0);
    expect(pos.k).toBe(1);
  });

  test("x^5 − x − 1 (one real root): global k=0 → that root, k=1 throws", () => {
    const f = fromCoeffsLowToHigh([
      rat(-1n), rat(-1n), rat(0n), rat(0n), rat(0n), rat(1n),
    ]);
    const r = makeRootByIndex(f, 0, ROOT_VAR);
    expect(r.k).toBe(0);
    expect(() => makeRootByIndex(f, 1, ROOT_VAR)).toThrow(/k=1/);
  });
});

// -----------------------------------------------------------------------------
// Reducible inputs — global k re-indexed within factor
// -----------------------------------------------------------------------------

describe("makeRootByIndex — reducible inputs", () => {
  test("(x^2 − 2)(x^2 − 3): global k=0,1,2,3 ↦ {−√3, −√2, +√2, +√3}", () => {
    const f = fromCoeffsLowToHigh([rat(6n), rat(0n), rat(-5n), rat(0n), rat(1n)]);
    const r0 = makeRootByIndex(f, 0, ROOT_VAR);
    const r1 = makeRootByIndex(f, 1, ROOT_VAR);
    const r2 = makeRootByIndex(f, 2, ROOT_VAR);
    const r3 = makeRootByIndex(f, 3, ROOT_VAR);

    // Real-value ordering: −√3 (≈ −1.732), −√2 (≈ −1.414), +√2 (≈ +1.414), +√3 (≈ +1.732).
    // Within the canonical minpoly x^2 − 2: roots are −√2 (k=0), +√2 (k=1).
    // Within x^2 − 3: −√3 (k=0), +√3 (k=1).
    expect(polyEq(r0.minpoly, intPolyLowToHigh([-3n, 0n, 1n]), INT_RING)).toBe(true);
    expect(r0.k).toBe(0);

    expect(polyEq(r1.minpoly, intPolyLowToHigh([-2n, 0n, 1n]), INT_RING)).toBe(true);
    expect(r1.k).toBe(0);

    expect(polyEq(r2.minpoly, intPolyLowToHigh([-2n, 0n, 1n]), INT_RING)).toBe(true);
    expect(r2.k).toBe(1);

    expect(polyEq(r3.minpoly, intPolyLowToHigh([-3n, 0n, 1n]), INT_RING)).toBe(true);
    expect(r3.k).toBe(1);
  });

  test("non-canonical (negative-leading, content-2) input: −2x^2 + 4 → x^2 − 2", () => {
    // −2x^2 + 4 has roots ±√2; ascending k=0 ↦ −√2, k=1 ↦ +√2.
    const f = fromCoeffsLowToHigh([rat(4n), rat(0n), rat(-2n)]);
    const r = makeRootByIndex(f, 1, ROOT_VAR);
    expect(polyEq(r.minpoly, intPolyLowToHigh([-2n, 0n, 1n]), INT_RING)).toBe(true);
    expect(r.k).toBe(1);
  });
});

// -----------------------------------------------------------------------------
// Cross-construction equality
// -----------------------------------------------------------------------------

describe("makeRootByIndex — equality across construction paths", () => {
  test("makeRootByIndex(reducible, k) and makeRoot(irreducible-factor, hint) agree on canonical Root", () => {
    // (x^2 − 2)(x^2 − 3) at global k=2 (= +√2)
    const reducible = fromCoeffsLowToHigh([rat(6n), rat(0n), rat(-5n), rat(0n), rat(1n)]);
    const fromIndex = makeRootByIndex(reducible, 2, ROOT_VAR);

    // Direct construction of +√2 via the irreducible factor + hint.
    const irreducible = fromCoeffsLowToHigh([rat(-2n), rat(0n), rat(1n)]);
    const fromHint = makeRoot(irreducible, { lo: rat(1n), hi: rat(2n) }, ROOT_VAR);

    expect(rootCanonicalEq(fromIndex, fromHint)).toBe(true);
  });

  test("non-canonical path agrees with canonical path: (3x^2 − 6) and (x^2 − 2) yield equal Roots", () => {
    const nonCanonical = fromCoeffsLowToHigh([rat(-6n), rat(0n), rat(3n)]);
    const canonical = fromCoeffsLowToHigh([rat(-2n), rat(0n), rat(1n)]);
    const r1 = makeRootByIndex(nonCanonical, 1, ROOT_VAR);
    const r2 = makeRootByIndex(canonical, 1, ROOT_VAR);
    expect(rootCanonicalEq(r1, r2)).toBe(true);
  });
});

// -----------------------------------------------------------------------------
// Refusals
// -----------------------------------------------------------------------------

describe("makeRootByIndex — refusals", () => {
  test("k out of range (k=#real-roots) throws", () => {
    const f = fromCoeffsLowToHigh([rat(-2n), rat(0n), rat(1n)]);
    expect(() => makeRootByIndex(f, 2, ROOT_VAR)).toThrow(/k=2/);
  });

  test("negative k throws", () => {
    const f = fromCoeffsLowToHigh([rat(-2n), rat(0n), rat(1n)]);
    expect(() => makeRootByIndex(f, -1, ROOT_VAR)).toThrow(/non-negative/i);
  });

  test("non-integer k throws", () => {
    const f = fromCoeffsLowToHigh([rat(-2n), rat(0n), rat(1n)]);
    expect(() => makeRootByIndex(f, 0.5, ROOT_VAR)).toThrow(/integer/i);
  });

  test("constant input throws", () => {
    const f = polyConst<Rat>(makeRat(5n, 1n), RAT_RING);
    expect(() => makeRootByIndex(f, 0, ROOT_VAR)).toThrow(/degree|constant/i);
  });

  test("zero polynomial throws", () => {
    const f = polyConst<Rat>(makeRat(0n, 1n), RAT_RING);
    expect(() => makeRootByIndex(f, 0, ROOT_VAR)).toThrow(/zero|degree/i);
  });
});
