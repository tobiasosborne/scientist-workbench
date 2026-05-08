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

  // Regression coverage for inputs the bead `scientist-workbench-4ne`
  // *claimed* were broken (they aren't — the bead's "truth" values were
  // bogus; the substrate is byte-correct against mpmath at every digit).
  // These goldens were generated via:
  //   python3 -c "from mpmath import mp, mpf, exp; mp.dps=80;
  //               print(mp.nstr(exp(mpf('<x>')), 80, strip_zeros=False))"
  // and are byte-identical to wolframscript -code 'N[Exp[<x>], 80]' on the
  // first 75+ digits.
  test("exp(0.1) at 70 dps — mpmath byte-identical", () => {
    const PREC = 263; // ≈ 70 dps
    const r = exp(fromString("0.1", PREC), PREC);
    expect(toString(r, 70)).toBe(
      "1.105170918075647624811707826490246668224547194737518718792863289440968",
    );
  });

  test("exp(0.3) at 70 dps — mpmath byte-identical", () => {
    const PREC = 263;
    const r = exp(fromString("0.3", PREC), PREC);
    expect(toString(r, 70)).toBe(
      "1.349858807576003103983744313328007330378299697359365803049917989939613",
    );
  });

  test("exp(0.8) at 70 dps — mpmath byte-identical", () => {
    const PREC = 263;
    const r = exp(fromString("0.8", PREC), PREC);
    expect(toString(r, 70)).toBe(
      "2.225540928492467604579537531395076757053634135048484596118583955556623",
    );
  });

  test("exp(1.4) at 70 dps — mpmath byte-identical", () => {
    const PREC = 263;
    const r = exp(fromString("1.4", PREC), PREC);
    expect(toString(r, 70)).toBe(
      "4.055199966844674587224108895228620252167561141684041071652232894506938",
    );
  });

  test("exp(-1.4) at 70 dps — mpmath byte-identical", () => {
    const PREC = 263;
    const r = exp(fromString("-1.4", PREC), PREC);
    expect(toString(r, 70)).toBe(
      "0.2465969639416064769398612398337676330642837742414514892465683564776597",
    );
  });

  test("exp(2.5) at 70 dps — mpmath byte-identical", () => {
    const PREC = 263;
    const r = exp(fromString("2.5", PREC), PREC);
    expect(toString(r, 70)).toBe(
      "12.18249396070347343807017595116796618318276779006316131156039834183819",
    );
  });

  test("exp(7) at 100 dps — high-precision, large k", () => {
    const PREC = 363; // ≈ 100 dps
    const r = exp(fromInt(7n, PREC), PREC);
    // mpmath: exp(7) = 1096.6331584284585992637202382881214324422191348336131437827392407761217693312331290224785687872498...
    expect(toString(r, 100)).toBe(
      "1096.633158428458599263720238288121432442219134833613143782739240776121769331233129022478568787249844",
    );
  });

  test("exp(-1000) underflows or stays representable", () => {
    // Boundary: exp(-1000) ≈ 5e-435, representable as a BigFloat at any
    // precision since BigFloat exponent is i32. Should not throw.
    const PREC = 100;
    const r = exp(fromInt(-1000n, PREC), PREC);
    // Expect mantissa non-zero (non-underflow) and exponent very negative.
    expect(r.mantissa).not.toBe(0n);
    expect(r.exponent).toBeLessThan(-1000);
  });

  test("exp throws on out-of-range argument", () => {
    // |k| > 2^30 should throw; build x = 2^31 (safely beyond the gate).
    const huge = fromString("2000000000", 100); // ≈ 2 × 10^9, k ≈ 2.88 × 10^9 > 2^30
    expect(() => exp(huge, 100)).toThrow(RangeError);
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
