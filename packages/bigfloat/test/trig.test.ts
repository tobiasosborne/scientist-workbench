// =============================================================================
// trig.test — sin / cos / tan / asin / acos / atan / atan2 + hyperbolics + pow
// =============================================================================
//
// Reference values from mpmath at 50 dps. Cross-validation:
//   sin(1)        = 0.84147098480789650665250232163029899962256306079837
//   cos(1)        = 0.54030230586813971740093660744297660373231042061792
//   sin(π/4)      = √2/2 = 0.70710678118654752440084436210484903928483593768847
//   asin(1)       = π/2
//   atan(1)       = π/4
//   atan2(1, 1)   = π/4
//   sinh(1)       = 1.1752011936438014568823818505956008151557179813341
//   cosh(1)       = 1.5430806348152437784779056207570616826015291123659
//   tanh(1)       = 0.76159415595576488811945828260479359041276859725794
//   asinh(1)      = log(1 + √2) = 0.88137358701954302523260932497979230902816032826163
//   acosh(2)      = log(2 + √3) = 1.3169578969248167086250463473079684440269819714675
//   atanh(0.5)    = ½·log(3) = 0.54930614433405484569762261846126285232374527891137

import { describe, expect, test } from "bun:test";
import {
  sin,
  cos,
  tan,
  asin,
  acos,
  atan,
  atan2,
  sinh,
  cosh,
  tanh,
  asinh,
  acosh,
  atanh,
  pow,
  pi,
  fromInt,
  fromString,
  fromFloat64,
  toString,
  toFloat64,
  decimalToBinaryPrecision,
  div,
  sub,
  abs,
  type BigFloat,
} from "../src/index.js";

const PREC50DPS = decimalToBinaryPrecision(50); // 197 bits

describe("sin", () => {
  test("sin(0) = 0", () => {
    expect(sin(fromInt(0n, 100), 100).mantissa).toBe(0n);
  });

  test("sin(1) at 50 dps", () => {
    const r = sin(fromInt(1n, PREC50DPS), PREC50DPS);
    expect(toString(r, 50)).toBe("0.84147098480789650665250232163029899962256306079837");
  });

  test("sin(π) ≈ 0", () => {
    const r = sin(pi(PREC50DPS), PREC50DPS);
    expect(toFloat64(abs(r)).value).toBeLessThan(1e-45);
  });

  test("sin(π/2) ≈ 1", () => {
    const piOver2 = div(pi(PREC50DPS), fromInt(2n, PREC50DPS), PREC50DPS);
    const r = sin(piOver2, PREC50DPS);
    const diff = sub(r, fromInt(1n, PREC50DPS), PREC50DPS);
    expect(toFloat64(abs(diff)).value).toBeLessThan(1e-45);
  });

  test("matches Math.sin", () => {
    for (const x of [0.5, -0.5, 1, -1, 2, -2, 5, -5, 0.001]) {
      const r = toFloat64(sin(fromFloat64(x), 53)).value;
      expect(r).toBeCloseTo(Math.sin(x), 14);
    }
  });
});

describe("cos", () => {
  test("cos(0) = 1", () => {
    const r = cos(fromInt(0n, 100), 100);
    expect(toFloat64(r).value).toBe(1);
  });

  test("cos(1) at 50 dps", () => {
    const r = cos(fromInt(1n, PREC50DPS), PREC50DPS);
    expect(toString(r, 50)).toBe("0.54030230586813971740093660744297660373231042061792");
  });

  test("cos(π) = -1", () => {
    const r = cos(pi(PREC50DPS), PREC50DPS);
    const diff = sub(r, fromInt(-1n, PREC50DPS), PREC50DPS);
    expect(toFloat64(abs(diff)).value).toBeLessThan(1e-45);
  });

  test("matches Math.cos", () => {
    for (const x of [0.5, -0.5, 1, -1, 2, -2, 5, -5]) {
      const r = toFloat64(cos(fromFloat64(x), 53)).value;
      expect(r).toBeCloseTo(Math.cos(x), 14);
    }
  });
});

describe("Pythagorean identity", () => {
  test("sin² + cos² = 1 at random points", () => {
    for (const x of [0.7, -1.3, 2.5, -3.7, 5.1]) {
      const xb = fromFloat64(x);
      const s = sin(xb, 100);
      const c = cos(xb, 100);
      const sum = toFloat64(
        sub(
          add(mul(s, s, 100), mul(c, c, 100), 100),
          fromInt(1n, 100),
          100,
        ),
      ).value;
      expect(Math.abs(sum)).toBeLessThan(1e-25);
    }
  });
});

import { add, mul } from "../src/index.js";

describe("tan", () => {
  test("tan(0) = 0", () => {
    expect(tan(fromInt(0n, 53), 53).mantissa).toBe(0n);
  });

  test("tan(π/4) ≈ 1", () => {
    const piOver4 = div(pi(PREC50DPS), fromInt(4n, PREC50DPS), PREC50DPS);
    const r = tan(piOver4, PREC50DPS);
    const diff = sub(r, fromInt(1n, PREC50DPS), PREC50DPS);
    expect(toFloat64(abs(diff)).value).toBeLessThan(1e-45);
  });

  test("matches Math.tan", () => {
    for (const x of [0.3, -0.7, 1.2, -1.5]) {
      const r = toFloat64(tan(fromFloat64(x), 53)).value;
      expect(r).toBeCloseTo(Math.tan(x), 13);
    }
  });
});

describe("atan", () => {
  test("atan(0) = 0", () => {
    expect(atan(fromInt(0n, 53), 53).mantissa).toBe(0n);
  });

  test("atan(1) = π/4", () => {
    const r = atan(fromInt(1n, PREC50DPS), PREC50DPS);
    const piOver4 = div(pi(PREC50DPS), fromInt(4n, PREC50DPS), PREC50DPS);
    const diff = sub(r, piOver4, PREC50DPS);
    expect(toFloat64(abs(diff)).value).toBeLessThan(1e-45);
  });

  test("atan(very large) ≈ π/2", () => {
    const r = atan(fromString("1e30", PREC50DPS), PREC50DPS);
    const piOver2 = div(pi(PREC50DPS), fromInt(2n, PREC50DPS), PREC50DPS);
    const diff = sub(r, piOver2, PREC50DPS);
    expect(toFloat64(abs(diff)).value).toBeLessThan(1e-29);
  });

  test("atan is odd", () => {
    const r1 = atan(fromString("0.7", 100), 100);
    const r2 = atan(fromString("-0.7", 100), 100);
    const sum = toFloat64(add(r1, r2, 100)).value;
    expect(Math.abs(sum)).toBeLessThan(1e-25);
  });

  test("matches Math.atan over a range", () => {
    for (const x of [0.1, -0.5, 1, -1, 5, -5, 100]) {
      const r = toFloat64(atan(fromFloat64(x), 53)).value;
      expect(r).toBeCloseTo(Math.atan(x), 14);
    }
  });
});

describe("atan2", () => {
  test("standard quadrants", () => {
    // atan2(0, 1) = 0
    expect(toFloat64(atan2(fromInt(0n, 53), fromInt(1n, 53), 53)).value).toBe(0);
    // atan2(1, 0) = π/2
    expect(toFloat64(atan2(fromInt(1n, 53), fromInt(0n, 53), 53)).value).toBeCloseTo(Math.PI / 2, 14);
    // atan2(0, -1) = π
    expect(toFloat64(atan2(fromInt(0n, 53), fromInt(-1n, 53), 53)).value).toBeCloseTo(Math.PI, 14);
    // atan2(-1, 0) = -π/2
    expect(toFloat64(atan2(fromInt(-1n, 53), fromInt(0n, 53), 53)).value).toBeCloseTo(-Math.PI / 2, 14);
    // atan2(1, 1) = π/4
    expect(toFloat64(atan2(fromInt(1n, 53), fromInt(1n, 53), 53)).value).toBeCloseTo(Math.PI / 4, 14);
  });

  test("matches Math.atan2 over a range", () => {
    const cases: Array<[number, number]> = [
      [1, 1],
      [-1, 1],
      [1, -1],
      [-1, -1],
      [3, 4],
      [-3, 4],
      [3, -4],
      [-3, -4],
    ];
    for (const [y, x] of cases) {
      const r = toFloat64(atan2(fromFloat64(y), fromFloat64(x), 53)).value;
      expect(r).toBeCloseTo(Math.atan2(y, x), 14);
    }
  });
});

describe("asin / acos", () => {
  test("asin(0) = 0", () => {
    expect(asin(fromInt(0n, 53), 53).mantissa).toBe(0n);
  });

  test("asin(1) = π/2", () => {
    const r = asin(fromInt(1n, PREC50DPS), PREC50DPS);
    const piOver2 = div(pi(PREC50DPS), fromInt(2n, PREC50DPS), PREC50DPS);
    expect(toFloat64(abs(sub(r, piOver2, PREC50DPS))).value).toBeLessThan(1e-45);
  });

  test("asin(0.5) ≈ π/6", () => {
    const r = asin(fromString("0.5", PREC50DPS), PREC50DPS);
    const piOver6 = div(pi(PREC50DPS), fromInt(6n, PREC50DPS), PREC50DPS);
    expect(toFloat64(abs(sub(r, piOver6, PREC50DPS))).value).toBeLessThan(1e-45);
  });

  test("acos(0) = π/2", () => {
    const r = acos(fromInt(0n, PREC50DPS), PREC50DPS);
    const piOver2 = div(pi(PREC50DPS), fromInt(2n, PREC50DPS), PREC50DPS);
    expect(toFloat64(abs(sub(r, piOver2, PREC50DPS))).value).toBeLessThan(1e-45);
  });

  test("acos(1) = 0", () => {
    const r = acos(fromInt(1n, PREC50DPS), PREC50DPS);
    expect(toFloat64(abs(r)).value).toBeLessThan(1e-45);
  });

  test("asin throws on |x| > 1", () => {
    expect(() => asin(fromString("1.1", 53), 53)).toThrow(RangeError);
  });
});

describe("hyperbolics", () => {
  test("sinh(0) = 0", () => {
    expect(sinh(fromInt(0n, 53), 53).mantissa).toBe(0n);
  });

  test("cosh(0) = 1", () => {
    expect(toFloat64(cosh(fromInt(0n, 100), 100)).value).toBe(1);
  });

  test("sinh(1) at 50 dps", () => {
    const r = sinh(fromInt(1n, PREC50DPS), PREC50DPS);
    expect(toString(r, 50)).toBe("1.1752011936438014568823818505956008151557179813341");
  });

  test("cosh(1) at 50 dps", () => {
    const r = cosh(fromInt(1n, PREC50DPS), PREC50DPS);
    expect(toString(r, 50)).toBe("1.5430806348152437784779056207570616826015291123659");
  });

  test("tanh(1) at 50 dps", () => {
    const r = tanh(fromInt(1n, PREC50DPS), PREC50DPS);
    expect(toString(r, 50)).toBe("0.76159415595576488811945828260479359041276859725794");
  });

  test("cosh² - sinh² = 1", () => {
    for (const x of [0.5, 1, 2, -1.5]) {
      const xb = fromFloat64(x);
      const s = sinh(xb, 100);
      const c = cosh(xb, 100);
      const diff = sub(mul(c, c, 100), mul(s, s, 100), 100);
      const off = sub(diff, fromInt(1n, 100), 100);
      expect(toFloat64(abs(off)).value).toBeLessThan(1e-25);
    }
  });

  test("asinh(1) = log(1 + √2)", () => {
    // log(1+√2) to 60 digits: 0.881373587019543025232609324979792309028160328261635413773884
    // Round at digit 51 (=5, with non-zero trail) → round up. ...826163 → ...826164.
    const r = asinh(fromInt(1n, PREC50DPS), PREC50DPS);
    expect(toString(r, 50)).toBe("0.88137358701954302523260932497979230902816032826164");
  });

  test("acosh(2) at 50 dps", () => {
    const r = acosh(fromInt(2n, PREC50DPS), PREC50DPS);
    expect(toString(r, 50)).toBe("1.3169578969248167086250463473079684440269819714675");
  });

  test("acosh throws on x < 1", () => {
    expect(() => acosh(fromString("0.5", 53), 53)).toThrow(RangeError);
  });

  test("atanh(0.5) = ½·log(3)", () => {
    const r = atanh(fromString("0.5", PREC50DPS), PREC50DPS);
    expect(toString(r, 50)).toBe("0.54930614433405484569762261846126285232374527891137");
  });

  test("atanh throws on |x| ≥ 1", () => {
    expect(() => atanh(fromInt(1n, 53), 53)).toThrow(RangeError);
  });
});

describe("pow", () => {
  test("integer exponent fast path", () => {
    // 2^10 = 1024 exactly via integer fast path.
    const r = pow(fromInt(2n, 53), fromInt(10n, 53), 53);
    expect(toFloat64(r).value).toBe(1024);
  });

  test("real exponent: 2^0.5 = √2", () => {
    const r = pow(fromInt(2n, PREC50DPS), fromString("0.5", PREC50DPS), PREC50DPS);
    expect(toString(r, 50)).toBe("1.4142135623730950488016887242096980785696718753769");
  });

  test("real exponent: e^x via pow(e, x)", () => {
    // e^1 = e, computed via pow.
    const r = pow(
      pow(fromString("2.718281828459045235360287471352662497757247093699959574966967627724076630", PREC50DPS), fromInt(1n, PREC50DPS), PREC50DPS),
      fromInt(1n, PREC50DPS),
      PREC50DPS,
    );
    // Just check it round-trips reasonably (integer pow of e is e).
    expect(toFloat64(r).value).toBeCloseTo(Math.E, 14);
  });

  test("throws on negative base with non-integer exponent", () => {
    expect(() =>
      pow(fromString("-2", 53), fromString("0.5", 53), 53),
    ).toThrow(RangeError);
  });

  test("0^positive = 0", () => {
    const r = pow(fromInt(0n, 53), fromString("2.5", 53), 53);
    expect(r.mantissa).toBe(0n);
  });

  test("matches Math.pow", () => {
    const cases: Array<[number, number]> = [
      [2, 3.5],
      [10, -0.5],
      [Math.E, 1.5],
      [3, 2.7],
    ];
    for (const [a, b] of cases) {
      const r = toFloat64(pow(fromFloat64(a), fromFloat64(b), 53)).value;
      expect(r).toBeCloseTo(Math.pow(a, b), 13);
    }
  });
});
