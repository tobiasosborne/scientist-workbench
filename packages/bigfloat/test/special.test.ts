// =============================================================================
// special.test — Bernoulli, gamma, lgamma, digamma, trigamma
// =============================================================================
//
// Reference values (from mpmath at 50 dps):
//   B_2 = 1/6, B_4 = -1/30, B_6 = 1/42, B_8 = -1/30, B_10 = 5/66.
//   Γ(1) = 1, Γ(2) = 1, Γ(3) = 2, Γ(4) = 6, Γ(1/2) = √π.
//   Γ(5.5) = 52.342777784553520181149907899332167972116733621068
//   log Γ(10) = 12.801827480081469611207717874566706164281149255619
//   ψ(1) = -γ (Euler-Mascheroni) = -0.57721566490153286060651209008240243104215933593992
//   ψ(2) = 1 - γ = 0.42278433509846713939348790991759756895784066406008
//   ψ(1/2) = -γ - 2 log 2 = -1.9635100260214234794409763329987555671931596046604
//   ψ'(1) = π²/6 = 1.6449340668482264364724151666460251892189499012068
//   ψ'(2) = π²/6 - 1 = 0.6449340668482264364724151666460251892189499012068
//   ψ'(1/2) = π²/2 = 4.9348022005446793094172454999380755676568497036204

import { describe, expect, test } from "bun:test";
import {
  bernoulliRational,
  gamma,
  lgamma,
  digamma,
  trigamma,
  polygamma,
  fromInt,
  fromString,
  fromFloat64,
  toString,
  toFloat64,
  decimalToBinaryPrecision,
  pi,
  ln2,
  div,
  sub,
  abs,
  mul,
  sqrt,
  type BigFloat,
} from "../src/index.js";

const PREC50DPS = decimalToBinaryPrecision(50);

describe("bernoulliRational", () => {
  test("classic small values", () => {
    expect(bernoulliRational(0)).toEqual({ num: 1n, den: 1n });
    expect(bernoulliRational(1)).toEqual({ num: -1n, den: 2n });
    expect(bernoulliRational(2)).toEqual({ num: 1n, den: 6n });
    expect(bernoulliRational(3)).toEqual({ num: 0n, den: 1n });
    expect(bernoulliRational(4)).toEqual({ num: -1n, den: 30n });
    expect(bernoulliRational(6)).toEqual({ num: 1n, den: 42n });
    expect(bernoulliRational(8)).toEqual({ num: -1n, den: 30n });
    expect(bernoulliRational(10)).toEqual({ num: 5n, den: 66n });
  });

  test("B_12 and B_14", () => {
    // B_12 = -691/2730
    expect(bernoulliRational(12)).toEqual({ num: -691n, den: 2730n });
    // B_14 = 7/6
    expect(bernoulliRational(14)).toEqual({ num: 7n, den: 6n });
  });

  test("odd indices > 1 are zero", () => {
    for (const n of [5, 7, 9, 11, 13, 51]) {
      expect(bernoulliRational(n)).toEqual({ num: 0n, den: 1n });
    }
  });
});

describe("gamma — integer arguments (Γ(n) = (n-1)!)", () => {
  test("Γ(1) = 1", () => {
    const r = gamma(fromInt(1n, 100), 100);
    expect(toFloat64(r).value).toBe(1);
  });
  test("Γ(2) = 1", () => {
    const r = gamma(fromInt(2n, 100), 100);
    expect(toFloat64(r).value).toBe(1);
  });
  test("Γ(3) = 2", () => {
    const r = gamma(fromInt(3n, 100), 100);
    expect(toFloat64(r).value).toBe(2);
  });
  test("Γ(4) = 6", () => {
    const r = gamma(fromInt(4n, 100), 100);
    expect(toFloat64(r).value).toBe(6);
  });
  test("Γ(10) = 362880", () => {
    const r = gamma(fromInt(10n, 100), 100);
    expect(toFloat64(r).value).toBe(362880);
  });
});

describe("gamma — half-integer arguments", () => {
  test("Γ(1/2) = √π", () => {
    const r = gamma(fromString("0.5", PREC50DPS), PREC50DPS);
    const sqrtPi = sqrt(pi(PREC50DPS), PREC50DPS);
    expect(toFloat64(abs(sub(r, sqrtPi, PREC50DPS))).value).toBeLessThan(1e-45);
  });

  test("Γ(3/2) = √π/2", () => {
    const r = gamma(fromString("1.5", PREC50DPS), PREC50DPS);
    const expected = div(sqrt(pi(PREC50DPS), PREC50DPS), fromInt(2n, PREC50DPS), PREC50DPS);
    expect(toFloat64(abs(sub(r, expected, PREC50DPS))).value).toBeLessThan(1e-45);
  });

  test("Γ(5.5) at 50 dps", () => {
    // Wolfram: N[Gamma[55/10], 50] = 52.342777784553520181149008492418193679490132376114
    const r = gamma(fromString("5.5", PREC50DPS), PREC50DPS);
    expect(toString(r, 50)).toBe("52.342777784553520181149008492418193679490132376114");
  });
});

describe("gamma — negative non-integer arguments", () => {
  test("Γ(-0.5) = -2√π", () => {
    const r = gamma(fromString("-0.5", PREC50DPS), PREC50DPS);
    const sqrtPi = sqrt(pi(PREC50DPS), PREC50DPS);
    const expected = mul(fromInt(-2n, PREC50DPS), sqrtPi, PREC50DPS);
    expect(toFloat64(abs(sub(r, expected, PREC50DPS))).value).toBeLessThan(1e-44);
  });

  test("Γ(-1.5) = 4√π/3", () => {
    const r = gamma(fromString("-1.5", PREC50DPS), PREC50DPS);
    const sqrtPi = sqrt(pi(PREC50DPS), PREC50DPS);
    const expected = div(mul(fromInt(4n, PREC50DPS), sqrtPi, PREC50DPS), fromInt(3n, PREC50DPS), PREC50DPS);
    expect(toFloat64(abs(sub(r, expected, PREC50DPS))).value).toBeLessThan(1e-43);
  });
});

describe("gamma — poles", () => {
  test("Γ(0) throws", () => {
    expect(() => gamma(fromInt(0n, 53), 53)).toThrow(RangeError);
  });
  test("Γ(-1), Γ(-2) throw", () => {
    expect(() => gamma(fromInt(-1n, 53), 53)).toThrow(RangeError);
    expect(() => gamma(fromInt(-2n, 53), 53)).toThrow(RangeError);
  });
});

describe("gamma / lgammaRealAbs — near-pole reflection precision (bead zhrm)", () => {
  // Sibling of `oj5j`'s complex-path fix (worklog 117 → 119), same bug
  // shape: the reflection branch formed `π·z` at fixed `work = prec +
  // 32` *before* `sin`'s argument reduction, so for a real
  // high-precision `z = m + ζ` with `|ζ|` tiny the `π·ζ` information
  // (≈ −log₂|ζ| bits below `π·m`) was truncated away, then
  // `reduceModPiOver2` re-did the same large subtraction. Net loss
  // ~(−log₁₀|ζ| − 9) digits of requested precision on `lgamma(z)` /
  // `gamma(z)` for `z < 0` near a non-positive integer; *plus* a
  // false-positive "pole" `RangeError` from `gamma`'s naïve
  // `sgn(sin(πz))` sign-detection when `|ζ|` was small enough to
  // annihilate `sin(πz)` to zero.
  //
  // The fix reduces `z → ζ` before multiplying by π and bumps `work`
  // by the measured cancellation depth. `gamma`'s sign now reads off
  // the structural identity `sgn(Γ(z)) = (−1)ᵐ · sgn(ζ)` — exact,
  // sin-free, no near-pole sgn collapse. For `m = 0` (the region
  // `z ∈ (−½, ½)`) the computation is byte-identical to the pre-fix
  // code.
  //
  // Mutation proof: reverting `lgammaRealAbs` to the `πz`-first form
  // collapses the `ε = 1e-69` cases to ~20 / ~40 digit agreement at
  // 30 / 50 dps — a hard RED on every assertion below.

  const REF_DPS = 160;
  const REF = decimalToBinaryPrecision(REF_DPS);

  function sigAgree(a: BigFloat, b: BigFloat, cap: number): number {
    const sa = toString(a, cap);
    const sb = toString(b, cap);
    let n = 0;
    for (let i = 0; i < Math.min(sa.length, sb.length); i++) {
      if (sa[i] !== sb[i]) break;
      if (sa[i] !== "-" && sa[i] !== ".") n++;
    }
    return n;
  }
  const offReal = (m: number, k: number) =>
    `${m < 0 ? "-" : ""}${Math.abs(m)}.` + "0".repeat(k - 1) + "1"; // m − 10⁻ᵏ

  const cases = [
    { name: "z = -1 − 1e-20 (near pole m = -1)", str: offReal(-1, 20) },
    { name: "z = -1 − 1e-69 (near pole m = -1, oj5j witness scale)", str: offReal(-1, 69) },
    { name: "z = -3 − 1e-69 (near pole m = -3)", str: offReal(-3, 69) },
    { name: "z = -10 − 1e-50 (deeper-shifted near pole m = -10)", str: offReal(-10, 50) },
  ];

  for (const c of cases) {
    test(`${c.name}: lgamma(z) holds the requested precision`, () => {
      const zRef = fromString(c.str, REF);
      const ref = lgamma(zRef, REF);
      for (const dps of [30, 50]) {
        const p = decimalToBinaryPrecision(dps);
        const got = lgamma(zRef, p);
        expect(sigAgree(got, ref, dps + 4)).toBeGreaterThanOrEqual(dps);
      }
    });

    test(`${c.name}: gamma(z) does not throw spuriously and matches reference`, () => {
      // The bead's second failure mode: gamma's pre-fix sign detection
      // was `sgn(sin(πz, work))`. Near a pole, `sin(πz)` got
      // annihilated to zero, `sgn` returned 0, and gamma threw
      // `pole at z = ...` even though z was only *close* to a pole.
      // The algebraic-identity sign fix removes the throw — and the
      // value is correct.
      const zRef = fromString(c.str, REF);
      const ref = gamma(zRef, REF);
      const got = gamma(zRef, decimalToBinaryPrecision(50));
      expect(sigAgree(got, ref, 54)).toBeGreaterThanOrEqual(50);
    });
  }

  test("control: z = -0.3 (m = 0, the byte-identical region) unaffected", () => {
    // Cross-check by reflection: Γ(-0.3)·Γ(1.3) = π/sin(-0.3π);
    // Γ(1.3) ≈ 0.89747; sin(-0.3π) ≈ -0.80902 → Γ(-0.3) ≈ -4.3266;
    // log|Γ(-0.3)| ≈ 1.46484.  Pin the value rather than byte-equality
    // so the test catches both wrong values and unintended regressions
    // to the pre-fix path in the m = 0 region.
    const z = fromString("-0.3", PREC50DPS);
    const r = lgamma(z, PREC50DPS);
    expect(toString(r, 30)).toBe("1.46484005085760250700847863478");
  });

  test("control: exact pole still throws (Γ(-2) and lgamma(-2) both)", () => {
    // The reduction `ζ = z − m` puts ζ exactly at zero for integer z;
    // the explicit isZero check is what catches the pole. Pinning that
    // the path didn't accidentally route past it.
    const pole = fromInt(-2n, PREC50DPS);
    expect(() => gamma(pole, PREC50DPS)).toThrow(/pole/);
    expect(() => lgamma(pole, PREC50DPS)).toThrow(/pole/);
  });
});

describe("lgamma", () => {
  test("log Γ(1) = 0", () => {
    const r = lgamma(fromInt(1n, 100), 100);
    expect(toFloat64(abs(r)).value).toBeLessThan(1e-45);
  });

  test("log Γ(10) at 50 dps", () => {
    // Wolfram: 12.801827480081469611207717874566706164281149255663
    const r = lgamma(fromInt(10n, PREC50DPS), PREC50DPS);
    expect(toString(r, 50)).toBe("12.801827480081469611207717874566706164281149255663");
  });

  test("log Γ(100) ≈ 359.1342053696...", () => {
    // Wolfram: 359.13420536957539877604401046028690961262171808563
    const r = lgamma(fromInt(100n, PREC50DPS), PREC50DPS);
    expect(toString(r, 50)).toBe("359.13420536957539877604401046028690961262171808563");
  });
});

describe("digamma", () => {
  test("ψ(1) = -γ at 50 dps", () => {
    const r = digamma(fromInt(1n, PREC50DPS), PREC50DPS);
    expect(toString(r, 50)).toBe("-0.57721566490153286060651209008240243104215933593992");
  });

  test("ψ(2) = 1 - γ at 50 dps", () => {
    const r = digamma(fromInt(2n, PREC50DPS), PREC50DPS);
    expect(toString(r, 50)).toBe("0.42278433509846713939348790991759756895784066406008");
  });

  test("ψ(1/2) = -γ - 2 log 2", () => {
    // Reference: -1.9635100260214234794409763329987555671931596046604
    const r = digamma(fromString("0.5", PREC50DPS), PREC50DPS);
    expect(toString(r, 50)).toBe("-1.9635100260214234794409763329987555671931596046604");
  });

  test("ψ(10) at 50 dps", () => {
    // Wolfram: 2.2517525890667211076474561638858515372118089180283
    const r = digamma(fromInt(10n, PREC50DPS), PREC50DPS);
    expect(toString(r, 50)).toBe("2.2517525890667211076474561638858515372118089180283");
  });
});

describe("trigamma", () => {
  test("ψ'(1) = π²/6 at 50 dps", () => {
    // mpmath: trigamma(1) = 1.6449340668482264364724151666460251892189499012068
    const r = trigamma(fromInt(1n, PREC50DPS), PREC50DPS);
    expect(toString(r, 50)).toBe("1.6449340668482264364724151666460251892189499012068");
  });

  test("ψ'(2) = π²/6 - 1", () => {
    // Wolfram: 0.64493406684822643647241516664602518921894990120680
    const r = trigamma(fromInt(2n, PREC50DPS), PREC50DPS);
    expect(toString(r, 50)).toBe("0.64493406684822643647241516664602518921894990120680");
  });

  test("ψ'(1/2) = π²/2", () => {
    // Reference: 4.9348022005446793094172454999380755676568497036204
    const r = trigamma(fromString("0.5", PREC50DPS), PREC50DPS);
    expect(toString(r, 50)).toBe("4.9348022005446793094172454999380755676568497036204");
  });
});

describe("polygamma dispatch", () => {
  test("polygamma(0, z) === digamma(z)", () => {
    const a = polygamma(0, fromInt(3n, 100), 100);
    const b = digamma(fromInt(3n, 100), 100);
    expect(toFloat64(sub(a, b, 100)).value).toBeCloseTo(0, 25);
  });

  test("polygamma(1, z) === trigamma(z)", () => {
    const a = polygamma(1, fromInt(5n, 100), 100);
    const b = trigamma(fromInt(5n, 100), 100);
    expect(toFloat64(sub(a, b, 100)).value).toBeCloseTo(0, 25);
  });

  test("polygamma(2, z) throws (deferred to v0.2)", () => {
    expect(() => polygamma(2, fromInt(1n, 53), 53)).toThrow(RangeError);
  });
});
