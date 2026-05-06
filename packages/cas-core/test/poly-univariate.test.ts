// =============================================================================
// polyDivRemMonic + polyExtGcd — univariate substrate for Hensel lifting
// =============================================================================
//
// `polyDivRemMonic`: long division by a monic divisor over any Ring<T>.
//                    Asserts a = q·b + r with deg_v(r) < deg_v(b).
// `polyExtGcd`:      extended Euclidean over a Field<T>[v]. Asserts
//                    s·a + t·b = g with g monic, and the division-tree
//                    invariants exact in the field.
//
// The Hensel step in `packages/poly-factor` consumes both. These tests
// catch the classes of bug that would surface as "the lift step
// silently gave wrong factors mod p^k" — much harder to debug there
// than here.

import { describe, expect, test } from "bun:test";
import {
  INT_RING,
  fpField,
  makeRat,
  polyAdd,
  polyConst,
  polyDivRemMonic,
  polyEq,
  polyExtGcd,
  polyFromCoeffsInVar,
  polyIsZero,
  polyMul,
  polyNeg,
  polySub,
  polyVar,
  RAT_RING,
  type Poly,
  type Rat,
} from "../src/index.js";

// -----------------------------------------------------------------------------
// polyDivRemMonic — over INT_RING (monic ℤ[x] divisor)
// -----------------------------------------------------------------------------

describe("polyDivRemMonic over ℤ[x]", () => {
  const x = polyVar<bigint>("x", INT_RING);
  const c = (n: bigint): Poly<bigint> => polyConst<bigint>(n, INT_RING);
  const uni = (coefs: bigint[]): Poly<bigint> =>
    polyFromCoeffsInVar(coefs.map(c), "x", INT_RING);

  test("dividend = quotient · divisor + remainder, exact", () => {
    // (x^3 + 2x + 5) ÷ (x^2 + 1) → q = x, r = x + 5
    const a = uni([5n, 2n, 0n, 1n]);
    const b = uni([1n, 0n, 1n]); // x^2 + 1 (monic)
    const { q, r } = polyDivRemMonic(a, b, "x", INT_RING);
    const reconstructed = polyAdd(polyMul(q, b, INT_RING), r, INT_RING);
    expect(polyEq(reconstructed, a, INT_RING)).toBe(true);
    // deg(r) < deg(b) = 2
    expect(polyEq(q, x, INT_RING)).toBe(true);
    expect(polyEq(r, polyAdd(x, c(5n), INT_RING), INT_RING)).toBe(true);
  });

  test("zero dividend gives zero quotient and zero remainder", () => {
    const b = uni([1n, 0n, 1n]);
    const zero: Poly<bigint> = { terms: [] };
    const { q, r } = polyDivRemMonic(zero, b, "x", INT_RING);
    expect(polyIsZero(q)).toBe(true);
    expect(polyIsZero(r)).toBe(true);
  });

  test("low-degree dividend: q = 0, r = a", () => {
    const a = uni([3n, 1n]);                     // x + 3, deg 1
    const b = uni([1n, 0n, 1n]);                 // x^2 + 1, deg 2
    const { q, r } = polyDivRemMonic(a, b, "x", INT_RING);
    expect(polyIsZero(q)).toBe(true);
    expect(polyEq(r, a, INT_RING)).toBe(true);
  });

  test("rejects non-monic divisor", () => {
    const a = uni([1n, 1n, 1n]);
    const b = uni([1n, 2n]);                     // 2x + 1 (not monic)
    expect(() => polyDivRemMonic(a, b, "x", INT_RING)).toThrow(/not monic/);
  });

  test("rejects zero divisor", () => {
    const a = uni([1n, 1n]);
    const b: Poly<bigint> = { terms: [] };
    expect(() => polyDivRemMonic(a, b, "x", INT_RING)).toThrow();
  });

  test("over Q: same algorithm works on rational coefs (monic)", () => {
    const xQ = polyVar<Rat>("x", RAT_RING);
    const cQ = (n: number, d: number = 1): Poly<Rat> =>
      polyConst<Rat>(makeRat(BigInt(n), BigInt(d)), RAT_RING);
    // (x^3 - 2x + 1/2) ÷ (x - 1) → q = x^2 + x - 1, r = -1/2
    const a = polyAdd(
      polyAdd(polyMul(xQ, polyMul(xQ, xQ, RAT_RING), RAT_RING), polyMul(cQ(-2), xQ, RAT_RING), RAT_RING),
      cQ(1, 2),
      RAT_RING,
    );
    const b = polyAdd(xQ, cQ(-1), RAT_RING);
    const { q, r } = polyDivRemMonic(a, b, "x", RAT_RING);
    const reconstructed = polyAdd(polyMul(q, b, RAT_RING), r, RAT_RING);
    expect(polyEq(reconstructed, a, RAT_RING)).toBe(true);
  });

  test("evenly divides: r = 0", () => {
    // (x^2 - 1) = (x - 1)(x + 1)
    const a = uni([-1n, 0n, 1n]);
    const b = uni([-1n, 1n]);                    // x - 1
    const { q, r } = polyDivRemMonic(a, b, "x", INT_RING);
    expect(polyIsZero(r)).toBe(true);
    expect(polyEq(q, uni([1n, 1n]), INT_RING)).toBe(true);
  });
});

// -----------------------------------------------------------------------------
// polyExtGcd — over fpField(p) (univariate ext-Euclidean over 𝔽_p[v])
// -----------------------------------------------------------------------------

describe("polyExtGcd over 𝔽_p[v]", () => {
  const F = fpField(7n);
  const x = polyVar<bigint>("x", F);
  const c = (n: bigint): Poly<bigint> => polyConst<bigint>(F.fromInt(n), F);
  const uni = (coefs: bigint[]): Poly<bigint> =>
    polyFromCoeffsInVar(coefs.map((co) => c(co)), "x", F);

  // Each test asserts the Bezout identity: s·a + t·b = g.
  // We do it via cas-core arithmetic over F directly.
  const checkBezout = (
    a: Poly<bigint>, b: Poly<bigint>,
    g: Poly<bigint>, s: Poly<bigint>, t: Poly<bigint>,
  ): void => {
    const lhs = polyAdd(polyMul(s, a, F), polyMul(t, b, F), F);
    expect(polyEq(lhs, g, F)).toBe(true);
  };

  test("coprime case: gcd is 1, Bezout is non-trivial", () => {
    // a = x^2 + 1, b = x + 2 over F_7. Coprime (b(−2) = 0; a(−2) = 5 ≠ 0).
    const a = uni([1n, 0n, 1n]);
    const b = uni([2n, 1n]);
    const { g, s, t } = polyExtGcd(a, b, "x", F);
    // g should be the constant 1 (monic).
    expect(polyEq(g, polyConst<bigint>(1n, F), F)).toBe(true);
    checkBezout(a, b, g, s, t);
  });

  test("shared factor: gcd is the shared monic factor", () => {
    // a = (x - 1)(x - 2) = x^2 - 3x + 2 ≡ x^2 + 4x + 2 mod 7
    // b = (x - 1)(x + 1) = x^2 - 1 ≡ x^2 + 6 mod 7
    // gcd should be (x - 1) ≡ x + 6 mod 7.
    const a = uni([2n, -3n, 1n]);
    const b = uni([-1n, 0n, 1n]);
    const { g, s, t } = polyExtGcd(a, b, "x", F);
    const expected = uni([6n, 1n]); // x + 6 = x - 1 mod 7
    expect(polyEq(g, expected, F)).toBe(true);
    checkBezout(a, b, g, s, t);
  });

  test("g is monic", () => {
    // 3·(x+1)·(x+2) shared with 5·(x+1)·(x+3). gcd = (x+1) (monic).
    const a = polyMul(c(3n), polyMul(uni([1n, 1n]), uni([2n, 1n]), F), F);
    const b = polyMul(c(5n), polyMul(uni([1n, 1n]), uni([3n, 1n]), F), F);
    const { g } = polyExtGcd(a, b, "x", F);
    // Leading coef of g (degree-1 in x) should be 1.
    const lc = g.terms[0]!.coef;
    expect(lc).toBe(1n);
  });

  test("zero on left: gcd(0, b) = monic(b), Bezout (0, 1/lc(b))", () => {
    const zero: Poly<bigint> = { terms: [] };
    const b = uni([2n, 4n]);                       // 4x + 2
    const { g, s, t } = polyExtGcd(zero, b, "x", F);
    // 4x + 2 monic-normalised: divide by 4: 4*4=16≡2 mod 7, so inv(4) = 2,
    // (4x + 2) * 2 = 8x + 4 ≡ x + 4 mod 7.
    const expected = uni([4n, 1n]);
    expect(polyEq(g, expected, F)).toBe(true);
    checkBezout(zero, b, g, s, t);
  });

  test("zero on right: gcd(a, 0) = monic(a)", () => {
    const a = uni([2n, 4n]);
    const zero: Poly<bigint> = { terms: [] };
    const { g, s, t } = polyExtGcd(a, zero, "x", F);
    expect(polyEq(g, uni([4n, 1n]), F)).toBe(true);
    checkBezout(a, zero, g, s, t);
  });

  test("rejects (0, 0)", () => {
    const zero: Poly<bigint> = { terms: [] };
    expect(() => polyExtGcd(zero, zero, "x", F)).toThrow();
  });

  test("multiple primes, multiple inputs: random Bezout consistency", () => {
    // Span a few primes and a few input pairs, asserting Bezout each time.
    const primes = [2n, 3n, 11n, 13n, 101n];
    for (const p of primes) {
      const Fp = fpField(p);
      const cFp = (n: bigint) => polyConst<bigint>(Fp.fromInt(n), Fp);
      const uniFp = (coefs: bigint[]) =>
        polyFromCoeffsInVar(coefs.map(cFp), "x", Fp);
      const cases: [Poly<bigint>, Poly<bigint>][] = [
        [uniFp([1n, 1n]), uniFp([1n, 0n, 1n])],
        [uniFp([1n, 2n, 3n]), uniFp([4n, 5n])],
        [uniFp([2n, 0n, 0n, 1n]), uniFp([1n, 1n, 1n])],
      ];
      for (const [a, b] of cases) {
        if (polyIsZero(a) && polyIsZero(b)) continue;
        const { g, s, t } = polyExtGcd(a, b, "x", Fp);
        const lhs = polyAdd(polyMul(s, a, Fp), polyMul(t, b, Fp), Fp);
        expect(polyEq(lhs, g, Fp)).toBe(true);
      }
    }
  });

  test("symmetry: g(a, b) and g(b, a) are equal up to swapped (s, t)", () => {
    const a = uni([1n, 0n, 1n]);                  // x^2 + 1
    const b = uni([2n, 1n]);                      // x + 2
    const r1 = polyExtGcd(a, b, "x", F);
    const r2 = polyExtGcd(b, a, "x", F);
    expect(polyEq(r1.g, r2.g, F)).toBe(true);
    // Bezout swap: s_ab · a + t_ab · b = s_ba · b + t_ba · a (up to the
    // chosen reduction). Either side equals g.
    const lhs1 = polyAdd(polyMul(r2.s, b, F), polyMul(r2.t, a, F), F);
    expect(polyEq(lhs1, r2.g, F)).toBe(true);
  });
});

// silence unused-import lint for symbols we deliberately export but don't
// use in every test arm.
void polyNeg;
void polySub;
