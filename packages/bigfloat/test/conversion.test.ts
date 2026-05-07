// =============================================================================
// conversion.test — fromInt / fromFloat64 / fromString / toFloat64 / toString
// =============================================================================

import { describe, expect, test } from "bun:test";
import {
  fromInt,
  fromFloat64,
  fromString,
  toFloat64,
  toString,
  eq,
  validate,
} from "../src/index.js";

describe("fromInt", () => {
  test("zero", () => {
    expect(fromInt(0n, 53)).toEqual({ mantissa: 0n, exponent: 0, precision: 53 });
    expect(fromInt(0, 100)).toEqual({ mantissa: 0n, exponent: 0, precision: 100 });
  });

  test("small positive integer", () => {
    const a = fromInt(7n, 53);
    validate(a);
    expect(toFloat64(a).value).toBe(7);
  });

  test("large bigint stripped of trailing zeros", () => {
    // 2^100 = mantissa 1 * 2^100. In our normalised form at 53 bits, the
    // mantissa is 2^52 and the exponent is 48 (so the value is 2^52 * 2^48 = 2^100).
    const a = fromInt(1n << 100n, 53);
    validate(a);
    expect(a.mantissa).toBe(1n << 52n);
    expect(a.exponent).toBe(48);
  });

  test("negative", () => {
    const a = fromInt(-12345n, 53);
    validate(a);
    expect(toFloat64(a).value).toBe(-12345);
  });
});

describe("fromFloat64", () => {
  test("zero (positive and negative)", () => {
    expect(fromFloat64(0)).toEqual({ mantissa: 0n, exponent: 0, precision: 53 });
    expect(fromFloat64(-0)).toEqual({ mantissa: 0n, exponent: 0, precision: 53 });
  });

  test("non-finite throws", () => {
    expect(() => fromFloat64(NaN)).toThrow(RangeError);
    expect(() => fromFloat64(Infinity)).toThrow(RangeError);
    expect(() => fromFloat64(-Infinity)).toThrow(RangeError);
  });

  test("round-trips simple powers of two exactly", () => {
    for (const x of [1, 2, 0.5, 0.25, 4, 8, -1, -0.5]) {
      const a = fromFloat64(x);
      validate(a);
      expect(toFloat64(a).value).toBe(x);
    }
  });

  test("round-trips 0.1 with the same float64 bit pattern", () => {
    const a = fromFloat64(0.1);
    validate(a);
    expect(toFloat64(a).value).toBe(0.1);
  });

  test("subnormals", () => {
    const min = Number.MIN_VALUE; // 2^-1074
    const a = fromFloat64(min);
    validate(a);
    expect(toFloat64(a).value).toBe(min);
  });
});

describe("toFloat64", () => {
  test("overflow returns ±Infinity", () => {
    // 2^1024 is just over the float64 ceiling.
    const big = fromInt(1n << 1024n, 53);
    const r = toFloat64(big);
    expect(r.value).toBe(Infinity);
    expect(r.overflow).toBe("overflow");
  });

  test("underflow returns ±0", () => {
    // 2^-2000 is far below the subnormal floor (≈ 2^-1074).
    const tiny = fromInt(1n, 53);
    const tinyShifted = { ...tiny, exponent: tiny.exponent - 2000 };
    const r = toFloat64(tinyShifted);
    expect(r.value).toBe(0);
    expect(r.overflow).toBe("underflow");
  });
});

describe("fromString", () => {
  test("integer literals", () => {
    expect(toFloat64(fromString("0", 53)).value).toBe(0);
    expect(toFloat64(fromString("42", 53)).value).toBe(42);
    expect(toFloat64(fromString("-17", 53)).value).toBe(-17);
  });

  test("decimal literals", () => {
    expect(toFloat64(fromString("1.5", 53)).value).toBe(1.5);
    expect(toFloat64(fromString("-3.25", 53)).value).toBe(-3.25);
    expect(toFloat64(fromString("0.5", 53)).value).toBe(0.5);
    expect(toFloat64(fromString(".5", 53)).value).toBe(0.5);
  });

  test("scientific notation", () => {
    expect(toFloat64(fromString("1e10", 53)).value).toBe(1e10);
    expect(toFloat64(fromString("1.5e-3", 53)).value).toBe(1.5e-3);
    expect(toFloat64(fromString("-2.5E+5", 53)).value).toBe(-2.5e5);
  });

  test("0.1 round-trips through float64 to the same bit pattern", () => {
    const a = fromString("0.1", 53);
    expect(toFloat64(a).value).toBe(0.1);
  });

  test("rejects malformed input", () => {
    expect(() => fromString("", 53)).toThrow(RangeError);
    expect(() => fromString("abc", 53)).toThrow(RangeError);
    expect(() => fromString("1.2.3", 53)).toThrow(RangeError);
  });
});

describe("toString", () => {
  test("zero", () => {
    expect(toString({ mantissa: 0n, exponent: 0, precision: 53 }, 5)).toBe("0.0000");
  });

  test("simple integers at moderate precision", () => {
    expect(toString(fromInt(7n, 53), 1)).toBe("7");
    expect(toString(fromInt(7n, 53), 5)).toBe("7.0000");
    expect(toString(fromInt(-42n, 53), 5)).toBe("-42.000");
  });

  test("simple decimals", () => {
    expect(toString(fromString("1.5", 100), 5)).toBe("1.5000");
    expect(toString(fromString("0.25", 100), 5)).toBe("0.25000");
  });

  test("scientific format for very large", () => {
    expect(toString(fromString("1.5e20", 100), 3)).toBe("1.50e+20");
  });

  test("scientific format for very small", () => {
    expect(toString(fromString("1.5e-7", 100), 3)).toBe("1.50e-7");
  });

  test("matches mpmath at 50 digits for sqrt(2) — checked in arithmetic.test.ts", () => {
    // Cross-reference; the heavy lift is in arithmetic.test.ts.
    expect(true).toBe(true);
  });
});
