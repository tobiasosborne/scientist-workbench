// =============================================================================
// comparison.test — sgn / abs / neg / cmp / eq / lt / le / gt / ge
// =============================================================================

import { describe, expect, test } from "bun:test";
import {
  sgn,
  abs,
  neg,
  cmp,
  eq,
  lt,
  le,
  gt,
  ge,
  isZero,
  fromInt,
  fromString,
  type BigFloat,
} from "../src/index.js";

const Z: BigFloat = { mantissa: 0n, exponent: 0, precision: 53 };

describe("sgn / isZero", () => {
  test("zero", () => {
    expect(sgn(Z)).toBe(0);
    expect(isZero(Z)).toBe(true);
  });

  test("positive", () => {
    expect(sgn(fromInt(7n, 53))).toBe(1);
    expect(sgn(fromString("0.001", 53))).toBe(1);
    expect(isZero(fromInt(7n, 53))).toBe(false);
  });

  test("negative", () => {
    expect(sgn(fromInt(-3n, 53))).toBe(-1);
    expect(sgn(fromString("-1e-50", 200))).toBe(-1);
  });
});

describe("abs / neg", () => {
  test("abs", () => {
    expect(abs(Z)).toEqual(Z);
    const a = fromInt(7n, 53);
    expect(abs(a)).toEqual(a);
    expect(abs(neg(a))).toEqual(a);
  });

  test("neg", () => {
    expect(neg(Z)).toEqual(Z);
    const a = fromInt(7n, 53);
    expect(neg(neg(a))).toEqual(a);
    expect(sgn(neg(a))).toBe(-1);
  });
});

describe("cmp", () => {
  test("zero comparisons", () => {
    expect(cmp(Z, Z)).toBe(0);
    expect(cmp(Z, fromInt(1n, 53))).toBe(-1);
    expect(cmp(fromInt(1n, 53), Z)).toBe(1);
    expect(cmp(Z, fromInt(-1n, 53))).toBe(1);
  });

  test("same sign, same magnitude", () => {
    const a = fromString("3.14", 100);
    const b = fromString("3.14", 100);
    expect(cmp(a, b)).toBe(0);
    expect(eq(a, b)).toBe(true);
  });

  test("same sign, different magnitudes", () => {
    const a = fromString("3.14", 100);
    const b = fromString("3.15", 100);
    expect(cmp(a, b)).toBe(-1);
    expect(cmp(b, a)).toBe(1);
  });

  test("different signs", () => {
    const a = fromString("-1e10", 100);
    const b = fromString("0.001", 100);
    expect(cmp(a, b)).toBe(-1);
    expect(cmp(b, a)).toBe(1);
  });

  test("comparison aligns exponents correctly", () => {
    // 2^10 vs 2^9 + 1. Different exponents, but the second is smaller.
    const big: BigFloat = { mantissa: 1n << 52n, exponent: -42, precision: 53 };
    const small: BigFloat = { mantissa: (1n << 52n) | 1n, exponent: -44, precision: 53 };
    // big = 2^10; small = (2^52 + 1) * 2^-44 ≈ 2^8 + tiny → big > small
    expect(cmp(big, small)).toBe(1);
  });

  test("ordering predicates wire correctly", () => {
    const a = fromInt(2n, 53);
    const b = fromInt(3n, 53);
    expect(lt(a, b)).toBe(true);
    expect(le(a, b)).toBe(true);
    expect(gt(b, a)).toBe(true);
    expect(ge(b, a)).toBe(true);
    expect(eq(a, a)).toBe(true);
    expect(le(a, a)).toBe(true);
    expect(ge(a, a)).toBe(true);
  });
});
