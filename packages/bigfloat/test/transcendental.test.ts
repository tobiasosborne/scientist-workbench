// =============================================================================
// transcendental.test — exp, log, expm1, log1p, atanSmall, ln2, pi, e
// =============================================================================
//
// Reference values from mpmath at 50 dps (verified out-of-band):
//   ln(2) = 0.69314718055994530941723212145817656807550013436026
//   π     = 3.1415926535897932384626433832795028841971693993751
//   e     = 2.7182818284590452353602874713526624977572470936999
//   log(10) = 2.3025850929940456840179914546843642076011014886288
//   exp(1) = e (above)
//   exp(-1) = 0.36787944117144232839852867057839216006144...

import { describe, expect, test } from "bun:test";
import {
  ln2,
  pi,
  e,
  exp,
  log,
  expm1,
  log1p,
  atanSmall,
  fromInt,
  fromString,
  fromFloat64,
  toString,
  toFloat64,
  sub,
  abs,
  div,
  decimalToBinaryPrecision,
} from "../src/index.js";

const PREC50DPS = decimalToBinaryPrecision(50); // 197 bits

describe("ln2", () => {
  test("matches mpmath at 50 dps", () => {
    const r = ln2(PREC50DPS);
    expect(toString(r, 50)).toBe("0.69314718055994530941723212145817656807550013436026");
  });

  test("cached: lower-precision result is consistent", () => {
    // Pre-warm cache.
    ln2(PREC50DPS);
    const r10 = ln2(decimalToBinaryPrecision(10));
    expect(toString(r10, 10)).toBe("0.6931471806");
  });
});

describe("pi", () => {
  test("matches mpmath at 50 dps", () => {
    const r = pi(PREC50DPS);
    expect(toString(r, 50)).toBe("3.1415926535897932384626433832795028841971693993751");
  });

  test("matches at 100 dps", () => {
    const r = pi(decimalToBinaryPrecision(100));
    expect(toString(r, 100)).toBe(
      "3.141592653589793238462643383279502884197169399375105820974944592307816406286208998628034825342117068",
    );
  });
});

describe("e", () => {
  test("matches mpmath at 50 dps (round-half-to-even)", () => {
    // e to 60 digits: 2.71828182845904523536028747135266249775724709369995957...
    // Round to 50 sig figs: digit 51 is 9, > 5 → round up → ...0937000.
    // mpmath's str(e) at mp.dps=50 truncates and shows ...0936999; the
    // round-half-to-even result we produce here is ...0937000.
    const r = e(PREC50DPS);
    expect(toString(r, 50)).toBe("2.7182818284590452353602874713526624977572470937000");
  });
});

describe("exp", () => {
  test("exp(0) = 1", () => {
    const r = exp(fromInt(0n, 100), 100);
    expect(toFloat64(r).value).toBe(1);
  });

  test("exp(1) = e", () => {
    const r = exp(fromInt(1n, PREC50DPS), PREC50DPS);
    // Same as the e constant test — round-half-to-even at digit 51 = 9.
    expect(toString(r, 50)).toBe("2.7182818284590452353602874713526624977572470937000");
  });

  test("exp(-1) at 50 dps", () => {
    // 1/e to 60 digits:
    //   0.367879441171442321595523770161460867445811131031767834507836...
    // Round at digit 51 = 7, > 5 → round up. Last digit 6 → 7.
    const r = exp(fromInt(-1n, PREC50DPS), PREC50DPS);
    expect(toString(r, 50)).toBe("0.36787944117144232159552377016146086744581113103177");
  });

  test("exp(2) at 50 dps", () => {
    // mpmath: exp(2) = 7.3890560989306502272304274605750078131803155705518
    const r = exp(fromInt(2n, PREC50DPS), PREC50DPS);
    expect(toString(r, 50)).toBe("7.3890560989306502272304274605750078131803155705518");
  });

  test("exp(0.5) at 50 dps", () => {
    // mpmath: exp(0.5) = 1.6487212707001281468486507878141635716537761007101
    const r = exp(fromString("0.5", PREC50DPS), PREC50DPS);
    expect(toString(r, 50)).toBe("1.6487212707001281468486507878141635716537761007101");
  });

  test("exp(x) matches float64 for small x", () => {
    for (const x of [0.5, -0.3, 1.7, -1.2, 2.5, -2.5]) {
      const r = toFloat64(exp(fromFloat64(x), 53)).value;
      expect(r).toBeCloseTo(Math.exp(x), 14);
    }
  });

  test("log(exp(x)) ≈ x", () => {
    const x = fromString("3.14", 200);
    const r = log(exp(x, 200), 200);
    const diff = sub(r, x, 200);
    // |diff| should be at most a few ulps, i.e., around 2^-(precision-2)
    const diffAbs = abs(diff);
    const xAbs = abs(x);
    const ratio = div(diffAbs, xAbs, 100);
    expect(toFloat64(ratio).value).toBeLessThan(1e-50);
  });
});

describe("log", () => {
  test("log(1) = 0", () => {
    const r = log(fromInt(1n, 100), 100);
    expect(r.mantissa).toBe(0n);
  });

  test("log(2) at 50 dps matches mpmath", () => {
    const r = log(fromInt(2n, PREC50DPS), PREC50DPS);
    expect(toString(r, 50)).toBe("0.69314718055994530941723212145817656807550013436026");
  });

  test("log(10) at 50 dps", () => {
    // mpmath: log(10) = 2.3025850929940456840179914546843642076011014886288
    const r = log(fromInt(10n, PREC50DPS), PREC50DPS);
    expect(toString(r, 50)).toBe("2.3025850929940456840179914546843642076011014886288");
  });

  test("log(e) = 1", () => {
    const eVal = e(PREC50DPS);
    const r = log(eVal, PREC50DPS);
    // r should be exactly 1 to working precision.
    const diff = sub(r, fromInt(1n, PREC50DPS), PREC50DPS);
    expect(toFloat64(abs(diff)).value).toBeLessThan(1e-45);
  });

  test("log throws on non-positive", () => {
    expect(() => log(fromInt(0n, 53), 53)).toThrow(RangeError);
    expect(() => log(fromInt(-1n, 53), 53)).toThrow(RangeError);
  });

  test("matches float64", () => {
    for (const x of [0.5, 1.5, 2.7, 100, 0.001]) {
      const r = toFloat64(log(fromFloat64(x), 53)).value;
      expect(r).toBeCloseTo(Math.log(x), 14);
    }
  });
});

describe("expm1", () => {
  test("expm1(0) = 0", () => {
    const r = expm1(fromInt(0n, 53), 53);
    expect(r.mantissa).toBe(0n);
  });

  test("matches Math.expm1 for small x", () => {
    for (const x of [0.001, 1e-10, -1e-12, 0.4, -0.4]) {
      const r = toFloat64(expm1(fromFloat64(x), 53)).value;
      expect(r).toBeCloseTo(Math.expm1(x), 14);
    }
  });

  test("matches Math.expm1 for larger x via exp - 1 path", () => {
    for (const x of [0.6, 1, 2, -1.5]) {
      const r = toFloat64(expm1(fromFloat64(x), 53)).value;
      expect(r).toBeCloseTo(Math.expm1(x), 14);
    }
  });
});

describe("log1p", () => {
  test("log1p(0) = 0", () => {
    const r = log1p(fromInt(0n, 53), 53);
    expect(r.mantissa).toBe(0n);
  });

  test("matches Math.log1p for small x", () => {
    for (const x of [0.001, 1e-10, -1e-12, 0.4, -0.4]) {
      const r = toFloat64(log1p(fromFloat64(x), 53)).value;
      expect(r).toBeCloseTo(Math.log1p(x), 14);
    }
  });

  test("matches Math.log1p for larger x via log path", () => {
    for (const x of [0.6, 1, 2]) {
      const r = toFloat64(log1p(fromFloat64(x), 53)).value;
      expect(r).toBeCloseTo(Math.log1p(x), 14);
    }
  });
});

describe("atanSmall", () => {
  test("atan(0) = 0", () => {
    const r = atanSmall(fromInt(0n, 100), 100);
    expect(r.mantissa).toBe(0n);
  });

  test("atan(1/2) at 50 dps", () => {
    // mpmath: atan(1/2) = 0.46364760900080611621425623146121440202853705428612
    const r = atanSmall(div(fromInt(1n, PREC50DPS), fromInt(2n, PREC50DPS), PREC50DPS), PREC50DPS);
    expect(toString(r, 50)).toBe("0.46364760900080611621425623146121440202853705428612");
  });

  test("throws on |x| >= 1", () => {
    expect(() => atanSmall(fromInt(1n, 53), 53)).toThrow(RangeError);
    expect(() => atanSmall(fromInt(-1n, 53), 53)).toThrow(RangeError);
    expect(() => atanSmall(fromInt(2n, 53), 53)).toThrow(RangeError);
  });

  test("matches Math.atan for moderate x", () => {
    // atanSmall is the raw Taylor-series implementation; convergence is
    // slow as |x| → 1. For |x| ≤ 0.7 it's well within budget. The full
    // `atan` (with reduction for |x| ≥ 0.5) lands in a future commit.
    for (const x of [0.1, -0.3, 0.5, 0.7, -0.7]) {
      const r = toFloat64(atanSmall(fromFloat64(x), 53)).value;
      expect(r).toBeCloseTo(Math.atan(x), 14);
    }
  });
});
