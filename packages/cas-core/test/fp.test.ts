// =============================================================================
// fp — INT_RING, fpField, polyTrunc
// =============================================================================
//
// Surface-level tests of the field/ring instances and the modular
// truncation helper. The point is structural correctness — every
// arithmetic operation lands in the expected canonical residue class,
// inverses round-trip, polyTrunc preserves canonical form. These are
// the substrate that Hensel lifting (poly-factor) leans on; if any of
// these break, downstream factorisation is silently wrong.

import { describe, expect, test } from "bun:test";
import {
  INT_RING,
  fpField,
  polyAdd,
  polyConst,
  polyEq,
  polyFromCoeffsInVar,
  polyMul,
  polyTrunc,
  polyVar,
  type Poly,
} from "../src/index.js";

describe("INT_RING", () => {
  test("ring axioms: zero, one, fromInt", () => {
    expect(INT_RING.zero).toBe(0n);
    expect(INT_RING.one).toBe(1n);
    expect(INT_RING.fromInt(42n)).toBe(42n);
    expect(INT_RING.fromInt(-7n)).toBe(-7n);
  });

  test("arithmetic agrees with bigint", () => {
    expect(INT_RING.add(3n, 4n)).toBe(7n);
    expect(INT_RING.sub(3n, 5n)).toBe(-2n);
    expect(INT_RING.mul(6n, 7n)).toBe(42n);
    expect(INT_RING.neg(5n)).toBe(-5n);
  });

  test("predicates", () => {
    expect(INT_RING.isZero(0n)).toBe(true);
    expect(INT_RING.isZero(1n)).toBe(false);
    expect(INT_RING.isOne(1n)).toBe(true);
    expect(INT_RING.isOne(-1n)).toBe(false);
    expect(INT_RING.eq(3n, 3n)).toBe(true);
    expect(INT_RING.eq(3n, 4n)).toBe(false);
  });

  test("polyAdd over INT_RING produces integer-coef polynomials", () => {
    const x = polyVar<bigint>("x", INT_RING);
    const f = polyAdd(x, polyConst(2n, INT_RING), INT_RING);
    expect(f.terms.map((t) => t.coef)).toEqual([1n, 2n]);
  });
});

describe("fpField", () => {
  test("rejects modulus < 2", () => {
    expect(() => fpField(1n)).toThrow();
    expect(() => fpField(0n)).toThrow();
    expect(() => fpField(-3n)).toThrow();
  });

  test("F_5: arithmetic is in [0, 5)", () => {
    const F = fpField(5n);
    expect(F.add(3n, 4n)).toBe(2n);          // 7 ≡ 2
    expect(F.sub(1n, 3n)).toBe(3n);          // -2 ≡ 3
    expect(F.mul(3n, 4n)).toBe(2n);          // 12 ≡ 2
    expect(F.neg(2n)).toBe(3n);              // -2 ≡ 3
    expect(F.neg(0n)).toBe(0n);
  });

  test("F_7: inverses round-trip via mul", () => {
    const F = fpField(7n);
    for (let a = 1n; a < 7n; a++) {
      const inv = F.inv(a);
      expect(F.mul(a, inv)).toBe(1n);
    }
  });

  test("F_p: inv(0) throws", () => {
    const F = fpField(11n);
    expect(() => F.inv(0n)).toThrow();
  });

  test("composite modulus: inv of a non-coprime element throws", () => {
    // fpField doesn't verify primality; passing a composite modulus is
    // the caller's bug. Confirm that inv() catches non-invertible
    // elements rather than producing nonsense.
    const F = fpField(15n);
    expect(() => F.inv(3n)).toThrow();        // gcd(3, 15) = 3
    expect(F.mul(F.inv(2n), 2n)).toBe(1n);    // 2 is invertible mod 15
  });

  test("predicates and fromInt normalise into [0, p)", () => {
    const F = fpField(13n);
    expect(F.fromInt(15n)).toBe(2n);
    expect(F.fromInt(-1n)).toBe(12n);
    expect(F.isZero(13n)).toBe(true);
    expect(F.isOne(14n)).toBe(true);
    expect(F.eq(15n, 2n)).toBe(true);
  });

  test("dictionary cache: fpField(p) is identical between calls", () => {
    const F1 = fpField(101n);
    const F2 = fpField(101n);
    expect(F1).toBe(F2);
  });
});

describe("polyTrunc", () => {
  const x = polyVar<bigint>("x", INT_RING);
  const c = (n: bigint): Poly<bigint> => polyConst<bigint>(n, INT_RING);
  const buildUni = (coefs: bigint[]): Poly<bigint> =>
    polyFromCoeffsInVar(coefs.map(c), "x", INT_RING);

  test("rejects modulus < 1", () => {
    const f = c(7n);
    expect(() => polyTrunc(f, 0n)).toThrow();
    expect(() => polyTrunc(f, -3n)).toThrow();
  });

  test("identity when all coefs are already in [0, m)", () => {
    const f = polyAdd(polyMul(c(3n), x, INT_RING), c(2n), INT_RING);
    const g = polyTrunc(f, 7n);
    expect(polyEq(f, g, INT_RING)).toBe(true);
  });

  test("reduces coefs into canonical [0, m)", () => {
    const f = polyAdd(polyMul(c(20n), x, INT_RING), c(15n), INT_RING);
    const g = polyTrunc(f, 7n);
    // 20 ≡ 6, 15 ≡ 1
    const expected = polyAdd(polyMul(c(6n), x, INT_RING), c(1n), INT_RING);
    expect(polyEq(g, expected, INT_RING)).toBe(true);
  });

  test("negative coefs lift into [0, m)", () => {
    const f = polyAdd(polyMul(c(-3n), x, INT_RING), c(-1n), INT_RING);
    const g = polyTrunc(f, 5n);
    // -3 ≡ 2, -1 ≡ 4
    const expected = polyAdd(polyMul(c(2n), x, INT_RING), c(4n), INT_RING);
    expect(polyEq(g, expected, INT_RING)).toBe(true);
  });

  test("zero coef terms drop", () => {
    // (5x + 5) mod 5 == 0
    const f = polyAdd(polyMul(c(5n), x, INT_RING), c(5n), INT_RING);
    const g = polyTrunc(f, 5n);
    expect(g.terms.length).toBe(0);
  });

  test("idempotent", () => {
    const f = buildUni([15n, -7n, 22n, -100n]);
    const once = polyTrunc(f, 11n);
    const twice = polyTrunc(once, 11n);
    expect(polyEq(once, twice, INT_RING)).toBe(true);
  });

  test("commutes with reduction order: trunc(trunc(f, m^2), m) == trunc(f, m)", () => {
    const f = buildUni([200n, -150n, 90n]);
    const m = 7n;
    const left = polyTrunc(polyTrunc(f, m * m), m);
    const right = polyTrunc(f, m);
    expect(polyEq(left, right, INT_RING)).toBe(true);
  });
});
