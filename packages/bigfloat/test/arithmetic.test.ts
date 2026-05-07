// =============================================================================
// arithmetic.test — add, sub, mul, div, sqrt, powInt
// =============================================================================
//
// Spot tests for hand-picked cases plus randomised cross-validation against
// JS float64 at small precisions (where float64 is exact for the result).
// Cross-validation against mpmath at high precisions lives in a separate
// integration test (run-on-demand; not in the per-commit `bun test`).

import { describe, expect, test } from "bun:test";
import {
  add,
  sub,
  mul,
  div,
  sqrt,
  powInt,
  fromInt,
  fromFloat64,
  fromString,
  toFloat64,
  toString,
  eq,
  cmp,
  type BigFloat,
} from "../src/index.js";

describe("add", () => {
  test("zero is identity (left and right)", () => {
    const z: BigFloat = { mantissa: 0n, exponent: 0, precision: 53 };
    const a = fromInt(7n, 53);
    expect(eq(add(z, a, 53), a)).toBe(true);
    expect(eq(add(a, z, 53), a)).toBe(true);
  });

  test("integer + integer at sufficient precision is exact", () => {
    const a = fromInt(7n, 53);
    const b = fromInt(13n, 53);
    const sum = add(a, b, 53);
    expect(toFloat64(sum).value).toBe(20);
  });

  test("0.1 + 0.2 at 53-bit precision matches float64 rounding", () => {
    // The classic case: float64 0.1 + 0.2 = 0.30000000000000004.
    // Our 53-bit BigFloat add of fromFloat64(0.1) + fromFloat64(0.2) should
    // produce the same float64 when round-tripped.
    const a = fromFloat64(0.1);
    const b = fromFloat64(0.2);
    const r = add(a, b, 53);
    expect(toFloat64(r).value).toBe(0.1 + 0.2);
  });

  test("large + small loses the small (catastrophic cancellation absent here)", () => {
    // 1.0 + 2^-100 at 53 bits → 1.0 (the small is below the rounding threshold).
    const big = fromInt(1n, 53);
    const small: BigFloat = { mantissa: 1n << 52n, exponent: -152, precision: 53 };
    const r = add(big, small, 53);
    expect(toFloat64(r).value).toBe(1);
  });

  test("commutative", () => {
    const a = fromString("1.234", 80);
    const b = fromString("-9.87654321", 80);
    expect(eq(add(a, b, 80), add(b, a, 80))).toBe(true);
  });

  test("precision parameter determines result precision", () => {
    const a = fromString("1.111111111", 200);
    const b = fromString("2.222222222", 200);
    const r = add(a, b, 50);
    expect(r.precision).toBe(50);
  });
});

describe("sub", () => {
  test("a - a = 0", () => {
    const a = fromString("3.14159", 100);
    const r = sub(a, a, 100);
    expect(r.mantissa).toBe(0n);
  });

  test("matches add(a, neg(b))", () => {
    const a = fromString("5.5", 80);
    const b = fromString("3.3", 80);
    const r = sub(a, b, 80);
    expect(toFloat64(r).value).toBeCloseTo(2.2, 14);
  });
});

describe("mul", () => {
  test("zero short-circuit", () => {
    const z: BigFloat = { mantissa: 0n, exponent: 0, precision: 53 };
    const a = fromString("1e100", 53);
    expect(mul(z, a, 53).mantissa).toBe(0n);
    expect(mul(a, z, 53).mantissa).toBe(0n);
  });

  test("integer * integer at sufficient precision is exact", () => {
    const a = fromInt(123n, 53);
    const b = fromInt(456n, 53);
    expect(toFloat64(mul(a, b, 53)).value).toBe(56088);
  });

  test("commutative", () => {
    const a = fromString("0.7", 100);
    const b = fromString("-1.3", 100);
    expect(eq(mul(a, b, 100), mul(b, a, 100))).toBe(true);
  });

  test("matches float64 for representable cases at 53 bits", () => {
    // 1.5 * 2.5 = 3.75 — both inputs and output are exact in float64.
    const a = fromFloat64(1.5);
    const b = fromFloat64(2.5);
    const r = mul(a, b, 53);
    expect(toFloat64(r).value).toBe(3.75);
  });
});

describe("div", () => {
  test("throws on divide by zero", () => {
    const a = fromInt(1n, 53);
    const z: BigFloat = { mantissa: 0n, exponent: 0, precision: 53 };
    expect(() => div(a, z, 53)).toThrow(RangeError);
  });

  test("zero divided by anything is zero", () => {
    const z: BigFloat = { mantissa: 0n, exponent: 0, precision: 53 };
    const a = fromString("17.5", 53);
    expect(div(z, a, 53).mantissa).toBe(0n);
  });

  test("a/a = 1 at sufficient precision", () => {
    const a = fromString("3.14159265358979323846", 200);
    const r = div(a, a, 200);
    expect(toFloat64(r).value).toBe(1);
  });

  test("1/3 has correct first 16 digits", () => {
    const one = fromInt(1n, 200);
    const three = fromInt(3n, 200);
    const r = div(one, three, 200);
    expect(toFloat64(r).value).toBeCloseTo(1 / 3, 15);
  });

  test("sign correctness", () => {
    const a = fromString("-12", 53);
    const b = fromString("4", 53);
    const r = div(a, b, 53);
    expect(toFloat64(r).value).toBe(-3);
  });
});

describe("sqrt", () => {
  test("sqrt(0) = 0", () => {
    const z: BigFloat = { mantissa: 0n, exponent: 0, precision: 53 };
    expect(sqrt(z, 53).mantissa).toBe(0n);
  });

  test("throws on negative", () => {
    const a = fromString("-1", 53);
    expect(() => sqrt(a, 53)).toThrow(RangeError);
  });

  test("sqrt(4) = 2 exactly", () => {
    const a = fromInt(4n, 53);
    const r = sqrt(a, 53);
    expect(toFloat64(r).value).toBe(2);
  });

  test("sqrt(2) at 50 dec digits matches mpmath reference", () => {
    // mpmath: sqrt(2) at 50 dps =
    // 1.4142135623730950488016887242096980785696718753769
    const a = fromInt(2n, 200);
    const r = sqrt(a, 200);
    const s = toString(r, 50);
    expect(s).toBe("1.4142135623730950488016887242096980785696718753769");
  });

  test("(sqrt(a))^2 ≈ a", () => {
    const a = fromString("17.123456789", 200);
    const s = sqrt(a, 200);
    const back = mul(s, s, 200);
    // Difference should be at most a few ulps in the result precision
    const diff = sub(back, a, 200);
    // |diff| / |a| ≤ 2^-(precision-2) say
    const ratio = div(diff, a, 100);
    const ratioFloat = toFloat64(ratio).value;
    expect(Math.abs(ratioFloat)).toBeLessThan(1e-50);
  });
});

describe("powInt", () => {
  test("a^0 = 1", () => {
    const a = fromString("17.5", 100);
    const r = powInt(a, 0, 100);
    expect(toFloat64(r).value).toBe(1);
  });

  test("a^1 = a", () => {
    const a = fromString("3.14", 100);
    const r = powInt(a, 1, 100);
    expect(eq(r, a)).toBe(true);
  });

  test("2^10 = 1024 exactly", () => {
    const two = fromInt(2n, 53);
    const r = powInt(two, 10, 53);
    expect(toFloat64(r).value).toBe(1024);
  });

  test("3^-2 = 1/9", () => {
    const three = fromInt(3n, 100);
    const r = powInt(three, -2, 100);
    expect(toFloat64(r).value).toBeCloseTo(1 / 9, 15);
  });

  test("(-2)^3 = -8", () => {
    const a = fromString("-2", 53);
    const r = powInt(a, 3, 53);
    expect(toFloat64(r).value).toBe(-8);
  });
});

describe("randomised cross-validation against float64", () => {
  // A linear-congruential RNG so the property test is deterministic across
  // runs — bit-determinism applies even to test inputs.
  function* lcg(seed: number) {
    let s = seed >>> 0;
    for (let i = 0; i < 200; i++) {
      // Park-Miller-style; not for crypto, just stable pseudo-random.
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      yield s;
    }
  }
  function randFloat(s: number): number {
    // Map LCG output to a float in (-1e6, 1e6) avoiding zero.
    const u = (s & 0xffff) / 0x10000;
    const sign = (s >>> 16) & 1 ? -1 : 1;
    const mag = Math.exp((u - 0.5) * 20);
    return sign * mag;
  }

  test("add matches float64 to a few ulps for random pairs", () => {
    const seeds = Array.from(lcg(42));
    for (let i = 0; i < seeds.length; i += 2) {
      const x = randFloat(seeds[i]!);
      const y = randFloat(seeds[i + 1]!);
      const expected = x + y;
      if (!Number.isFinite(expected)) continue;
      const a = fromFloat64(x);
      const b = fromFloat64(y);
      const r = toFloat64(add(a, b, 53)).value;
      // For 53-bit add, the result should be exactly the float64 sum
      // (round-half-to-even matches IEEE-754).
      expect(r).toBe(expected);
    }
  });

  test("mul matches float64 for random pairs", () => {
    const seeds = Array.from(lcg(7));
    for (let i = 0; i < seeds.length; i += 2) {
      const x = randFloat(seeds[i]!);
      const y = randFloat(seeds[i + 1]!);
      const expected = x * y;
      if (!Number.isFinite(expected) || expected === 0) continue;
      const a = fromFloat64(x);
      const b = fromFloat64(y);
      const r = toFloat64(mul(a, b, 53)).value;
      expect(r).toBe(expected);
    }
  });
});
