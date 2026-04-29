// algebraic.test.ts — ring-axiom + known-value battery for Q[√2], Q[i],
// and the tower Q[√2, i].
//
// Each test is grounded in textbook arithmetic. We assert every
// concrete equality with reference to its mathematical statement so a
// future agent reading the file can re-derive any line.

import { describe, expect, test } from "bun:test";
import {
  algElement,
  algebraicRing,
  makeRat,
  qI,
  qSqrt2,
  qSqrt2I,
  Q_I,
  Q_SQRT2,
  Q_SQRT2_I,
  RAT_RING,
} from "../src/index.js";

const ZERO = RAT_RING.zero;
const ONE = RAT_RING.one;
const TWO = makeRat(2n);
const HALF = makeRat(1n, 2n);
const NEG_HALF = makeRat(-1n, 2n);

describe("Q[√2] basics", () => {
  test("element 1 round-trips", () => {
    expect(Q_SQRT2.eq(qSqrt2(ONE, ZERO), Q_SQRT2.one)).toBe(true);
  });

  test("element √2 has expected coefs", () => {
    const sqrt2 = qSqrt2(ZERO, ONE);
    expect(sqrt2.coefs.length).toBe(2);
  });

  test("(√2)² = 2", () => {
    const sqrt2 = qSqrt2(ZERO, ONE);
    const sq = Q_SQRT2.mul(sqrt2, sqrt2);
    const two = qSqrt2(TWO, ZERO);
    expect(Q_SQRT2.eq(sq, two)).toBe(true);
  });

  test("(1 + √2)² = 3 + 2√2", () => {
    const a = qSqrt2(ONE, ONE);
    const sq = Q_SQRT2.mul(a, a);
    expect(Q_SQRT2.eq(sq, qSqrt2(makeRat(3n), makeRat(2n)))).toBe(true);
  });

  test("(1 + √2)(1 − √2) = −1", () => {
    const a = qSqrt2(ONE, ONE);
    const b = qSqrt2(ONE, makeRat(-1n));
    const product = Q_SQRT2.mul(a, b);
    expect(Q_SQRT2.eq(product, qSqrt2(makeRat(-1n), ZERO))).toBe(true);
  });

  test("inverse of (1 + √2) is (−1 + √2)", () => {
    const a = qSqrt2(ONE, ONE);
    const inv = Q_SQRT2.inv(a);
    // (1 + √2)(−1 + √2) = −1 + √2 − √2 + 2 = 1.
    expect(Q_SQRT2.eq(inv, qSqrt2(makeRat(-1n), ONE))).toBe(true);
    expect(Q_SQRT2.eq(Q_SQRT2.mul(a, inv), Q_SQRT2.one)).toBe(true);
  });

  test("inverse of √2 is √2/2", () => {
    const sqrt2 = qSqrt2(ZERO, ONE);
    const inv = Q_SQRT2.inv(sqrt2);
    expect(Q_SQRT2.eq(inv, qSqrt2(ZERO, HALF))).toBe(true);
    expect(Q_SQRT2.eq(Q_SQRT2.mul(sqrt2, inv), Q_SQRT2.one)).toBe(true);
  });

  test("zero is recognised regardless of construction path", () => {
    const z1 = Q_SQRT2.sub(qSqrt2(makeRat(3n), ZERO), qSqrt2(makeRat(3n), ZERO));
    const z2 = qSqrt2(ZERO, ZERO);
    expect(Q_SQRT2.isZero(z1)).toBe(true);
    expect(Q_SQRT2.isZero(z2)).toBe(true);
    expect(Q_SQRT2.eq(z1, z2)).toBe(true);
  });

  test("ring axioms: associativity + commutativity of add and mul", () => {
    const a = qSqrt2(makeRat(2n), makeRat(-3n));
    const b = qSqrt2(ONE, ONE);
    const c = qSqrt2(makeRat(0n), makeRat(5n));
    expect(Q_SQRT2.eq(Q_SQRT2.add(a, b), Q_SQRT2.add(b, a))).toBe(true);
    expect(
      Q_SQRT2.eq(
        Q_SQRT2.add(Q_SQRT2.add(a, b), c),
        Q_SQRT2.add(a, Q_SQRT2.add(b, c))
      )
    ).toBe(true);
    expect(Q_SQRT2.eq(Q_SQRT2.mul(a, b), Q_SQRT2.mul(b, a))).toBe(true);
    expect(
      Q_SQRT2.eq(
        Q_SQRT2.mul(Q_SQRT2.mul(a, b), c),
        Q_SQRT2.mul(a, Q_SQRT2.mul(b, c))
      )
    ).toBe(true);
  });

  test("ring axiom: distributivity a·(b+c) = a·b + a·c", () => {
    const a = qSqrt2(makeRat(2n), ONE);
    const b = qSqrt2(ONE, makeRat(-1n));
    const c = qSqrt2(makeRat(3n), makeRat(2n));
    const left = Q_SQRT2.mul(a, Q_SQRT2.add(b, c));
    const right = Q_SQRT2.add(Q_SQRT2.mul(a, b), Q_SQRT2.mul(a, c));
    expect(Q_SQRT2.eq(left, right)).toBe(true);
  });

  test("fromInt embeds Z correctly", () => {
    expect(Q_SQRT2.eq(Q_SQRT2.fromInt(5n), qSqrt2(makeRat(5n), ZERO))).toBe(true);
    expect(Q_SQRT2.eq(Q_SQRT2.fromInt(0n), Q_SQRT2.zero)).toBe(true);
    expect(Q_SQRT2.eq(Q_SQRT2.fromInt(1n), Q_SQRT2.one)).toBe(true);
  });
});

describe("Q[i] basics", () => {
  test("i² = −1", () => {
    const i = qI(ZERO, ONE);
    const sq = Q_I.mul(i, i);
    expect(Q_I.eq(sq, qI(makeRat(-1n), ZERO))).toBe(true);
  });

  test("(1 + i)² = 2i", () => {
    const a = qI(ONE, ONE);
    const sq = Q_I.mul(a, a);
    expect(Q_I.eq(sq, qI(ZERO, TWO))).toBe(true);
  });

  test("(1 + i)(1 − i) = 2", () => {
    const a = qI(ONE, ONE);
    const b = qI(ONE, makeRat(-1n));
    const product = Q_I.mul(a, b);
    expect(Q_I.eq(product, qI(TWO, ZERO))).toBe(true);
  });

  test("inverse of (1 + i) is (1 − i)/2", () => {
    const a = qI(ONE, ONE);
    const inv = Q_I.inv(a);
    expect(Q_I.eq(inv, qI(HALF, NEG_HALF))).toBe(true);
    expect(Q_I.eq(Q_I.mul(a, inv), Q_I.one)).toBe(true);
  });

  test("inverse of i is −i", () => {
    const i = qI(ZERO, ONE);
    const inv = Q_I.inv(i);
    expect(Q_I.eq(inv, qI(ZERO, makeRat(-1n)))).toBe(true);
  });
});

describe("Q[√2, i] tower", () => {
  // Helper: extract the four Q-coefficients on the basis {1, √2, i, √2·i}.
  function basisCoefs(
    e: ReturnType<typeof qSqrt2I>
  ): [bigint, bigint, bigint, bigint] {
    // e.coefs[0] is the "real" Q[√2] part c = a + b·√2.
    // e.coefs[1] is the "i" coefficient d = c + d·√2.
    const real = e.coefs[0]?.coefs ?? [];
    const imag = e.coefs[1]?.coefs ?? [];
    const a = real[0] ?? RAT_RING.zero;
    const b = real[1] ?? RAT_RING.zero;
    const c = imag[0] ?? RAT_RING.zero;
    const d = imag[1] ?? RAT_RING.zero;
    // Convert each to bigint num assuming denominator 1 — the test
    // cases below use only integer rationals, so this is a simple
    // sanity assertion. Real comparisons go through Q_SQRT2_I.eq.
    return [a.n, b.n, c.n, d.n];
  }

  test("basis element 1", () => {
    expect(Q_SQRT2_I.eq(qSqrt2I(ONE, ZERO, ZERO, ZERO), Q_SQRT2_I.one)).toBe(true);
  });

  test("(√2)² = 2 within the tower", () => {
    const sqrt2 = qSqrt2I(ZERO, ONE, ZERO, ZERO);
    const sq = Q_SQRT2_I.mul(sqrt2, sqrt2);
    expect(Q_SQRT2_I.eq(sq, qSqrt2I(TWO, ZERO, ZERO, ZERO))).toBe(true);
  });

  test("i² = −1 within the tower", () => {
    const i = qSqrt2I(ZERO, ZERO, ONE, ZERO);
    const sq = Q_SQRT2_I.mul(i, i);
    expect(Q_SQRT2_I.eq(sq, qSqrt2I(makeRat(-1n), ZERO, ZERO, ZERO))).toBe(true);
  });

  test("(√2·i)² = −2 within the tower", () => {
    // (√2·i)² = (√2)²·i² = 2·(−1) = −2.
    const sqrt2i = qSqrt2I(ZERO, ZERO, ZERO, ONE);
    const sq = Q_SQRT2_I.mul(sqrt2i, sqrt2i);
    expect(Q_SQRT2_I.eq(sq, qSqrt2I(makeRat(-2n), ZERO, ZERO, ZERO))).toBe(true);
  });

  test("√2 · i = √2·i (basis multiplication)", () => {
    const sqrt2 = qSqrt2I(ZERO, ONE, ZERO, ZERO);
    const i = qSqrt2I(ZERO, ZERO, ONE, ZERO);
    const product = Q_SQRT2_I.mul(sqrt2, i);
    expect(Q_SQRT2_I.eq(product, qSqrt2I(ZERO, ZERO, ZERO, ONE))).toBe(true);
  });

  test("(1 + i)(1 − i) = 2 within the tower", () => {
    const a = qSqrt2I(ONE, ZERO, ONE, ZERO);
    const b = qSqrt2I(ONE, ZERO, makeRat(-1n), ZERO);
    const product = Q_SQRT2_I.mul(a, b);
    expect(Q_SQRT2_I.eq(product, qSqrt2I(TWO, ZERO, ZERO, ZERO))).toBe(true);
  });

  test("(1 + √2)(1 − √2) = −1 within the tower", () => {
    const a = qSqrt2I(ONE, ONE, ZERO, ZERO);
    const b = qSqrt2I(ONE, makeRat(-1n), ZERO, ZERO);
    const product = Q_SQRT2_I.mul(a, b);
    expect(Q_SQRT2_I.eq(product, qSqrt2I(makeRat(-1n), ZERO, ZERO, ZERO))).toBe(true);
  });

  test("(1 + i + √2)² in the four-basis", () => {
    // (1 + i + √2)² = 1 + i² + 2 + 2i + 2√2 + 2√2·i
    //               = 1 + (-1) + 2 + 2i + 2√2 + 2√2·i
    //               = 2 + 2√2 + 2i + 2√2·i
    const a = qSqrt2I(ONE, ONE, ONE, ZERO);
    const sq = Q_SQRT2_I.mul(a, a);
    expect(
      Q_SQRT2_I.eq(sq, qSqrt2I(TWO, TWO, TWO, TWO))
    ).toBe(true);
  });

  test("inverse of i is −i", () => {
    const i = qSqrt2I(ZERO, ZERO, ONE, ZERO);
    const inv = Q_SQRT2_I.inv(i);
    expect(Q_SQRT2_I.eq(inv, qSqrt2I(ZERO, ZERO, makeRat(-1n), ZERO))).toBe(true);
    expect(Q_SQRT2_I.eq(Q_SQRT2_I.mul(i, inv), Q_SQRT2_I.one)).toBe(true);
  });

  test("inverse of (1 + √2) is (−1 + √2) within the tower", () => {
    const a = qSqrt2I(ONE, ONE, ZERO, ZERO);
    const inv = Q_SQRT2_I.inv(a);
    expect(
      Q_SQRT2_I.eq(inv, qSqrt2I(makeRat(-1n), ONE, ZERO, ZERO))
    ).toBe(true);
    expect(Q_SQRT2_I.eq(Q_SQRT2_I.mul(a, inv), Q_SQRT2_I.one)).toBe(true);
  });

  test("inverse of (1 + i) is (1 − i)/2", () => {
    const a = qSqrt2I(ONE, ZERO, ONE, ZERO);
    const inv = Q_SQRT2_I.inv(a);
    expect(
      Q_SQRT2_I.eq(inv, qSqrt2I(HALF, ZERO, NEG_HALF, ZERO))
    ).toBe(true);
    expect(Q_SQRT2_I.eq(Q_SQRT2_I.mul(a, inv), Q_SQRT2_I.one)).toBe(true);
  });

  test("ring axiom: distributivity within the tower", () => {
    const a = qSqrt2I(ONE, ONE, ONE, ONE);
    const b = qSqrt2I(makeRat(2n), ZERO, ZERO, ONE);
    const c = qSqrt2I(ZERO, makeRat(-1n), ONE, ZERO);
    const left = Q_SQRT2_I.mul(a, Q_SQRT2_I.add(b, c));
    const right = Q_SQRT2_I.add(Q_SQRT2_I.mul(a, b), Q_SQRT2_I.mul(a, c));
    expect(Q_SQRT2_I.eq(left, right)).toBe(true);
  });

  test("zero and one of the tower are recognised", () => {
    expect(Q_SQRT2_I.isZero(Q_SQRT2_I.zero)).toBe(true);
    expect(Q_SQRT2_I.isZero(Q_SQRT2_I.sub(Q_SQRT2_I.one, Q_SQRT2_I.one))).toBe(true);
    expect(Q_SQRT2_I.isOne(Q_SQRT2_I.one)).toBe(true);
  });

  test("basis-coef sanity check for direct constructor", () => {
    const a = qSqrt2I(makeRat(3n), makeRat(-2n), makeRat(7n), makeRat(0n));
    expect(basisCoefs(a)).toEqual([3n, -2n, 7n, 0n]);
  });
});

describe("algebraicRing — error paths", () => {
  test("reducible minimal polynomial is the caller's problem", () => {
    // p(α) = α² − 1 = (α − 1)(α + 1) is reducible. The constructor
    // doesn't check; arithmetic in this ring is still defined as a
    // ring (just not a field), and `inv` may fail for elements that
    // aren't units. Document this — the caller is expected to pass
    // an irreducible minimal polynomial.
    const reducible = algebraicRing({
      base: RAT_RING,
      minimalPoly: [makeRat(-1n), RAT_RING.zero, RAT_RING.one],
      generatorName: "α",
    });
    // (α − 1)(α + 1) = α² − 1 ≡ 0; so α − 1 is a zero divisor and
    // has no inverse. The implementation throws when the gcd has
    // non-trivial degree.
    const aMinus1 = algElement([makeRat(-1n), RAT_RING.one], RAT_RING);
    expect(() => reducible.inv(aMinus1)).toThrow();
  });

  test("non-monic minimal polynomial throws at construction", () => {
    expect(() =>
      algebraicRing({
        base: RAT_RING,
        minimalPoly: [makeRat(-1n), RAT_RING.zero, makeRat(2n)], // 2α² − 1
        generatorName: "α",
      })
    ).toThrow(/monic/);
  });

  test("degree-0 minimal polynomial throws", () => {
    expect(() =>
      algebraicRing({
        base: RAT_RING,
        minimalPoly: [RAT_RING.one],
        generatorName: "α",
      })
    ).toThrow(/degree ≥ 1/);
  });

  test("inverse of zero throws", () => {
    expect(() => Q_SQRT2.inv(Q_SQRT2.zero)).toThrow(/zero/);
    expect(() => Q_I.inv(Q_I.zero)).toThrow(/zero/);
    expect(() => Q_SQRT2_I.inv(Q_SQRT2_I.zero)).toThrow(/zero/);
  });
});
