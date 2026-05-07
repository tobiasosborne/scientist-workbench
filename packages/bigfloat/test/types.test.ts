// =============================================================================
// types.test — normalisation, invariants, decimal-binary conversion
// =============================================================================

import { describe, expect, test } from "bun:test";
import {
  normalise,
  validate,
  BigFloatInvariantError,
  bitLength,
  decimalToBinaryPrecision,
  type BigFloat,
} from "../src/index.js";

describe("bitLength", () => {
  test("zero", () => {
    expect(bitLength(0n)).toBe(0);
  });
  test("small positives", () => {
    expect(bitLength(1n)).toBe(1);
    expect(bitLength(2n)).toBe(2);
    expect(bitLength(3n)).toBe(2);
    expect(bitLength(7n)).toBe(3);
    expect(bitLength(8n)).toBe(4);
  });
  test("negatives", () => {
    expect(bitLength(-1n)).toBe(1);
    expect(bitLength(-1024n)).toBe(11);
  });
  test("large", () => {
    expect(bitLength(1n << 100n)).toBe(101);
  });
});

describe("normalise", () => {
  test("zero canonicalises regardless of input exponent", () => {
    expect(normalise(0n, 17, 53)).toEqual({
      mantissa: 0n,
      exponent: 0,
      precision: 53,
    });
    expect(normalise(0n, -42, 200)).toEqual({
      mantissa: 0n,
      exponent: 0,
      precision: 200,
    });
  });

  test("pads when mantissa has fewer bits than precision", () => {
    // Input: 1 * 2^0, target prec=8. Result should be `1<<7 * 2^-7` = 128 * 2^-7 = 1.
    const result = normalise(1n, 0, 8);
    expect(result.mantissa).toBe(128n);
    expect(result.exponent).toBe(-7);
    expect(result.precision).toBe(8);
  });

  test("truncates when mantissa exceeds precision (no rounding needed)", () => {
    // Input: 0b1100 (12) at exp 0, prec 3. Top 3 bits = 0b110 = 6. Low bit = 0.
    // Result: 6 * 2^1 = 12 ✓
    const result = normalise(12n, 0, 3);
    expect(result.mantissa).toBe(6n);
    expect(result.exponent).toBe(1);
  });

  test("round-half-to-even: round up", () => {
    // Input: 0b1011 (11) at exp 0, prec 3. Top 3 bits = 0b101 = 5; half-bit = 1; lower mask is 0.
    // The discarded portion = 0b1 → exactly half. High = 5 (odd) → round up to 6.
    const result = normalise(11n, 0, 3);
    expect(result.mantissa).toBe(6n);
    expect(result.exponent).toBe(1);
  });

  test("round-half-to-even: round down (high is even)", () => {
    // Input: 0b1101 (13) at exp 0, prec 3. Top 3 bits = 0b110 = 6; half-bit = 1.
    // discarded = 1 (the trailing bit). low > halfBit? 1 > 1? No. low === halfBit? Yes. high & 1? 0 → no round-up.
    // Wait: "13 = 0b1101", top 3 bits = "110" = 6, low 1 bit = "1". halfBit (shift=1, halfBit = 1<<0 = 1n). lowMask = 1n. low = 1n. low === halfBit (1 === 1) → tie. high & 1n = 0 → round-down. result = 6.
    const result = normalise(13n, 0, 3);
    expect(result.mantissa).toBe(6n);
    expect(result.exponent).toBe(1);
  });

  test("round-up triggers re-normalise (precision growth by one)", () => {
    // Input: 0b1111 (15) at exp 0, prec 3. Top 3 bits = 0b111 = 7; discarded = 1 (the trailing bit).
    // halfBit (shift=1, halfBit = 1). low === halfBit → tie. high (7) & 1 = 1 (odd) → round up to 8.
    // 8 has 4 bits → re-shift right by 1, exp += 1. Result: 4 * 2^2 = 16.
    const result = normalise(15n, 0, 3);
    expect(result.mantissa).toBe(4n);
    expect(result.exponent).toBe(2);
  });

  test("preserves sign", () => {
    const result = normalise(-7n, 5, 4);
    expect(result.mantissa).toBeLessThan(0n);
    expect(result.precision).toBe(4);
  });

  test("rejects invalid precision", () => {
    expect(() => normalise(1n, 0, 0)).toThrow(RangeError);
    expect(() => normalise(1n, 0, -5)).toThrow(RangeError);
    expect(() => normalise(1n, 0, 1.5)).toThrow(RangeError);
  });

  test("rejects non-finite exponent", () => {
    expect(() => normalise(1n, NaN, 8)).toThrow(RangeError);
    expect(() => normalise(1n, 1.5, 8)).toThrow(RangeError);
  });

  test("idempotence: normalise(normalise(x)) === normalise(x)", () => {
    // Property test on a few hand-picked cases — full random property test
    // belongs in a property-test file, not here.
    const cases = [
      { m: 7n, e: 3, p: 4 },
      { m: -123n, e: -10, p: 8 },
      { m: 1n << 100n, e: -50, p: 64 },
    ];
    for (const c of cases) {
      const a = normalise(c.m, c.e, c.p);
      const b = normalise(a.mantissa, a.exponent, a.precision);
      expect(b).toEqual(a);
    }
  });
});

describe("validate", () => {
  test("accepts valid values", () => {
    expect(validate({ mantissa: 0n, exponent: 0, precision: 53 })).toBeDefined();
    // 5 = 0b101 has 3 bits.
    expect(validate({ mantissa: 5n, exponent: 0, precision: 3 })).toBeDefined();
  });

  test("rejects zero mantissa with non-zero exponent", () => {
    expect(() =>
      validate({ mantissa: 0n, exponent: 5, precision: 53 } as BigFloat),
    ).toThrow(BigFloatInvariantError);
  });

  test("rejects mantissa-bits / precision mismatch", () => {
    expect(() =>
      validate({ mantissa: 1n, exponent: 0, precision: 53 } as BigFloat),
    ).toThrow(BigFloatInvariantError);
  });
});

describe("decimalToBinaryPrecision", () => {
  test("conventional values", () => {
    // 50 decimal digits: 50 * log2(10) ≈ 166.1, so ceil(166.1) + 30 = 197.
    expect(decimalToBinaryPrecision(50)).toBe(167 + 30);
    // 1 decimal digit: ceil(3.32) + 30 = 4 + 30.
    expect(decimalToBinaryPrecision(1)).toBe(4 + 30);
    // Custom safety margin:
    expect(decimalToBinaryPrecision(10, 0)).toBe(34); // ceil(33.22) = 34.
  });

  test("rejects invalid input", () => {
    expect(() => decimalToBinaryPrecision(0)).toThrow(RangeError);
    expect(() => decimalToBinaryPrecision(1.5)).toThrow(RangeError);
  });
});
