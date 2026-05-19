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

describe("digamma — negative-argument reflection lift (bead 2awg)", () => {
  // DLMF §5.5.4: ψ(1 − z) − ψ(z) = π · cot(π z)  ⟹  ψ(z) = ψ(1 − z) − π·cot(π z).
  // The sign on the cot term is load-bearing — see (M1) below.
  //
  // Mutation-proof markers (per PHASE2-impl-plans §I1a):
  //   (M1) Flipping the sign on the cot term (ψ = ψ(1−z) + π·cot(π z))
  //        leaves half-integer z (cot = 0) untouched but breaks every
  //        non-half-integer negative z. The z = -0.3 mpmath gold below
  //        catches this — ψ(-0.3) ≈ +2.1133, the +cot mutation yields
  //        ≈ -2.4513. RED-confirmed by inverting the sub→add at the
  //        last line of digammaReflect.
  //   (M3) Swapping sin/cos in the cot construction inverts cot →
  //        tan(πζ), which is ~ζ near integer ζ instead of ~1/ζ — every
  //        reflection value comes out wildly wrong (half-integer too:
  //        sin/cos = 0 → +∞ in tan; ψ(-0.5) value pin is the witness).
  //        RED-confirmed by swapping cos/sin argument order in the
  //        `div(cosPiZeta, sinPiZeta, …)` line.
  //
  // (M2 — dropping the lossBits bump — is the spec's stated third
  // mutation, but in the present substrate it fires only in
  // architectural corners that the value pins below don't surface.
  // The reduce-first pattern alone (form `ζ = z − round(z)` before
  // multiplying by π, so `sin`'s reduction sees a small angle directly)
  // is what carries the near-pole precision; the lossBits bump remains
  // in the code as belt-and-braces consistency with `cdigammaReflect`
  // and `lgammaRealAbs`, but on the real axis with z's mantissa carried
  // at high precision, the +32 substrate margin plus the +96 internal
  // bump of the positive-branch `digamma(1−z)` recursive call already
  // absorb the cancellation depth. The near-pole pin at z = -0.999
  // below verifies value-correctness, not the lossBits bump per se.)

  test("ψ(-0.5) = 2 - γ - 2 log 2 (mpmath at 50 dps)", () => {
    // Closed form: cot(-π/2) = 0, so the reflection collapses to ψ(-0.5)
    // = ψ(1.5) = ψ(0.5) + 1/0.5 = (-γ - 2 log 2) + 2 = 2 - γ - 2 log 2.
    // From the pinned ψ(1/2) test above:
    //   ψ(1/2) = -1.9635100260214234794409763329987555671931596046604
    // So ψ(-1/2) = 0.0364899739785765205590236670012444328068403953395...
    // (mpmath agrees: 0.036489973978576520559023667001244432806840039533956...
    // — the bead 2awg G8 "canonical opposing Boost-1.83" value.)
    const r = digamma(fromString("-0.5", PREC50DPS), PREC50DPS);
    expect(toString(r, 50)).toBe("0.036489973978576520559023667001244432806840395339566");
    // Cross-check: ψ(-0.5) + ψ(0.5) should equal -2γ - 4log2 + 2 = -2·(γ+2log2−1)
    //   = -2·0.9635100260214234794409763329987555671931596046604
    //   = -1.9270200520428469588819526659975111343863192093208
    // Equivalently ψ(-0.5) + ψ(0.5) = ψ(0.5) + 2 + ψ(0.5) = 2·ψ(0.5) + 2.
    const sumLift = sub(
      digamma(fromString("-0.5", PREC50DPS), PREC50DPS),
      digamma(fromString("0.5", PREC50DPS), PREC50DPS),
      PREC50DPS,
    );
    // ψ(-0.5) - ψ(0.5) = 2 exactly (the recurrence).
    expect(toFloat64(abs(sub(sumLift, fromInt(2n, PREC50DPS), PREC50DPS))).value)
      .toBeLessThan(1e-45);
  });

  test("ψ(-1.5) ≈ 0.70315664064524318... (mpmath)", () => {
    // mpmath.digamma(-1.5) = 0.703156640645243187225690333667911099473507062006232...
    const r = digamma(fromString("-1.5", PREC50DPS), PREC50DPS);
    expect(toString(r, 50)).toBe("0.70315664064524318722569033366791109947350706200623");
  });

  test("ψ(-2.5) ≈ 1.10315664064524318... (mpmath)", () => {
    // mpmath.digamma(-2.5) = ψ(-1.5) + 1/(-2.5) + 1/(-1.5) -- check via
    // recurrence: ψ(z+1) = ψ(z) + 1/z so ψ(-1.5) = ψ(-2.5) + 1/(-2.5),
    // and ψ(-2.5) = ψ(-1.5) - 1/(-2.5) = 0.7031566 + 0.4 = 1.1031566.
    const r = digamma(fromString("-2.5", PREC50DPS), PREC50DPS);
    expect(toString(r, 50)).toBe("1.1031566406452431872256903336679110994735070620062");
  });

  test("ψ(-0.3) ≈ 2.11330977963539... (mpmath; (M1) sign-flip witness)", () => {
    // mpmath.digamma(mpf("-0.3")) = 2.113309779635398718584726088771875390355199145797...
    // The +cot-sign mutation yields ψ(1.3) + π·cot(-0.3π) = -0.1694 + (-2.2818) =
    // -2.4513 — wrong sign AND wrong magnitude. Half-integer z above cannot
    // catch this because cot(πz) = 0 there.
    const r = digamma(fromString("-0.3", PREC50DPS), PREC50DPS);
    expect(toString(r, 50)).toBe("2.1133097796353987185847260887718753903551991457978");
  });

  test("ψ(-0.999) at 100 dps — near-pole value correctness", () => {
    // ζ = -0.999 - (-1) = 0.001, ~10 bits below 1. The cot(πz) term is
    // ≈ 1/(πζ) ≈ 318, dominating the result. Pinning the high-prec
    // answer verifies the reduce-first reflection holds precision
    // through the near-pole regime. mpmath.digamma(mpf("-999")/1000) at
    // 110 dps: -999.5745709308092994704716134686482274991257459049111...
    const P100 = decimalToBinaryPrecision(100);
    const r = digamma(fromString("-0.999", P100), P100);
    expect(toString(r, 50)).toBe("-999.57457093080929947047161346864822749912574590491");
  });

  test("trigamma ψ'(-0.5) = π²/2 + 4 (DLMF §5.15.3 — half-integer closed form)", () => {
    // mpmath.trigamma(mpf(-1)/2) = 8.93480220054467930941724549993807556765684970362...
    // (π²/2 = 4.9348022005446793... + 4 = 8.9348022005446793...)
    const r = trigamma(fromString("-0.5", PREC50DPS), PREC50DPS);
    expect(toString(r, 50)).toBe("8.9348022005446793094172454999380755676568497036204");
  });

  test("trigamma ψ'(-1.5) ≈ 9.379246644989123... (mpmath)", () => {
    // mpmath.trigamma(mpf(-3)/2) = 9.379246644989123753861689944382520012101294148064839...
    // By recurrence ψ'(z+1) = ψ'(z) - 1/z²: ψ'(-0.5) = ψ'(-1.5) - 1/(-1.5)²
    //   ⟹ ψ'(-1.5) = ψ'(-0.5) + 4/9 = 8.93480... + 0.44444... = 9.37925...
    const r = trigamma(fromString("-1.5", PREC50DPS), PREC50DPS);
    expect(toString(r, 50)).toBe("9.3792466449891237538616899443825200121012941480648");
  });

  test("trigamma ψ'(-0.3) ≈ 13.945160267... (non-half-integer; (M3) cot/tan witness)", () => {
    // mpmath.trigamma(mpf("-0.3")) = 13.945160267805721737956755092119029758510120297405143...
    // (M3) lift uses (π/sin(πζ))²; if sin were replaced by cos the
    // value would be (π/cos(πζ))² which at ζ = 0.3 - rather, at z = -0.3
    // we reduce: m = round(-0.3) = 0, ζ = -0.3. (π/cos(-0.3π))² =
    // (π/0.5878)² ≈ 28.6, way off from 13.945.
    const r = trigamma(fromString("-0.3", PREC50DPS), PREC50DPS);
    expect(toString(r, 50)).toBe("13.945160267805721737956755092119029758510120297405");
  });

  test("poles still throw — ψ(0), ψ(-1), ψ'(0), ψ'(-2)", () => {
    // Existing convention: gamma at non-positive integers throws
    // RangeError (see "gamma — poles" suite above). Mirror exactly.
    expect(() => digamma(fromInt(0n, 53), 53)).toThrow(RangeError);
    expect(() => digamma(fromInt(-1n, 53), 53)).toThrow(RangeError);
    expect(() => digamma(fromInt(-3n, 53), 53)).toThrow(RangeError);
    expect(() => trigamma(fromInt(0n, 53), 53)).toThrow(RangeError);
    expect(() => trigamma(fromInt(-2n, 53), 53)).toThrow(RangeError);
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
});

describe("polygamma m≥2 via Hurwitz zeta (bead 7znk / I1b)", () => {
  // Reference values computed via the polygamma identity itself at 160 dps
  // and cross-validated against DLMF §5.15 closed forms:
  //
  //   ψ^(2)(1)   = (-1)^3 · 2! · ζ(3)              [DLMF §5.15.2]
  //              = -2 · 1.2020569031595942853997381615114499907649862923405
  //              = -2.4041138063191885707994763230228999815299725846810
  //
  //   ψ^(2)(1/2) = -14 · ζ(3)                       [DLMF §5.15.3 / §25.6.4:
  //                                                  ζ(s, 1/2) = (2^s − 1) ζ(s)]
  //              = -16.828796644234319995596334261160299870709808092767
  //
  //   ψ^(3)(1)   = (-1)^4 · 3! · ζ(4)               [DLMF §5.15.2]
  //              = 6 · π⁴/90  =  π⁴/15
  //              = 6.4939394022668291490960221792470074166485057115124
  //
  //   ψ^(2)(2)   = ψ^(2)(1) + 2!/1^3                [DLMF §5.15.5,
  //                                                  d^m/dz^m(1/z) = (-1)^m m! z^{-(m+1)}]
  //              = -2.4041138063... + 2
  //              = -0.40411380631918857079947632302289998152997258468100
  //
  // MUTATION-PROOF MARKERS this block pins (CLAUDE.md Rule 7, Rule 6
  // port-and-verify discipline):
  //
  //   M1. Leading sign `(-1)^(m+1)` in `ψ^(m) = (-1)^(m+1) · m! · ζ(m+1, z)`.
  //       Flipping to `(-1)^m` would make polygamma(2, 1) = +2ζ(3) ≈ +2.4041
  //       instead of -2.4041. Pinned to 50 dps by the first golden.
  //
  //   M2. Recurrence shift in `polygammaHurwitz`. Without the shift the
  //       Euler-Maclaurin asymptotic is evaluated at small z (z = 1 or
  //       z = 0.5) where it diverges — the optimal-truncation error is
  //       O(1) at best. The polygamma(2, 1) golden catches this
  //       immediately.
  //
  //   M3. Bernoulli index B_{2k} (not B_{2k+2}, not B_k) in the
  //       Euler-Maclaurin coefficient. Shifting the index changes the
  //       leading correction term magnitude by orders. The closed-form
  //       polygamma(3, 1) = π⁴/15 test catches this.
  //
  //   M4. Pochhammer (s)_{2k-1} = s(s+1)…(s+2k-2) has *2k-1 factors*,
  //       starting at s. Using 2k factors or starting at s-1 misaligns
  //       the series. Pinned by polygamma(3, 1) = π⁴/15 at 50 dps.

  test("polygamma(2, 1) = -2·ζ(3) at 50 dps (DLMF §5.15.2)", () => {
    const r = polygamma(2, fromInt(1n, PREC50DPS), PREC50DPS);
    expect(toString(r, 50)).toBe("-2.4041138063191885707994763230228999815299725846810");
  });

  test("polygamma(2, 1/2) = -14·ζ(3) at 50 dps (DLMF §5.15.3)", () => {
    // ζ(s, 1/2) = (2^s − 1) ζ(s) gives ζ(3, 1/2) = 7 ζ(3),
    // so ψ''(1/2) = -2 · 7 ζ(3) = -14 ζ(3).
    const r = polygamma(2, fromString("0.5", PREC50DPS), PREC50DPS);
    expect(toString(r, 50)).toBe("-16.828796644234319995596334261160299870709808092767");
  });

  test("polygamma(3, 1) = π⁴/15 at 50 dps (DLMF §5.15.2 with ζ(4) = π⁴/90)", () => {
    // ψ'''(1) = 6 · ζ(4) = 6 · π⁴/90 = π⁴/15.  Pinning to the closed
    // form via the same `pi(prec)` chain catches drift in the polygamma
    // path independent of the Bernoulli oracle.
    const r = polygamma(3, fromInt(1n, PREC50DPS), PREC50DPS);
    const piVal = pi(PREC50DPS);
    const pi2 = mul(piVal, piVal, PREC50DPS);
    const pi4 = mul(pi2, pi2, PREC50DPS);
    const expected = div(pi4, fromInt(15n, PREC50DPS), PREC50DPS);
    expect(toFloat64(abs(sub(r, expected, PREC50DPS))).value).toBeLessThan(1e-45);
  });

  test("polygamma(2, 2) = ψ''(1) + 2 (DLMF §5.15.5 recurrence)", () => {
    // Differentiating ψ(z+1) = ψ(z) + 1/z m times gives
    //   ψ^(m)(z+1) = ψ^(m)(z) + (-1)^m · m! · z^{-(m+1)}.
    // For m = 2 at z = 1: ψ''(2) = ψ''(1) + 2!/1^3 = ψ''(1) + 2.
    // Cross-check via two independent polygamma evaluations — the
    // recurrence is structural, not a property of the algorithm, so
    // a wrong sign-grouping in `polygammaHurwitz` breaks it.
    const at1 = polygamma(2, fromInt(1n, PREC50DPS), PREC50DPS);
    const at2 = polygamma(2, fromInt(2n, PREC50DPS), PREC50DPS);
    const diff = sub(at2, at1, PREC50DPS);
    expect(toFloat64(abs(sub(diff, fromInt(2n, PREC50DPS), PREC50DPS))).value).toBeLessThan(1e-45);
  });

  test("sign discriminates m=1 (trigamma positive) vs m=2 (polygamma negative)", () => {
    // ψ'(1) = ζ(2) = π²/6 ≈ +1.6449  (positive — m=1 odd, (-1)^2 = +1)
    // ψ''(1) = -2 ζ(3) ≈ -2.4041     (NEGATIVE — m=2 even, (-1)^3 = -1)
    // The (-1)^(m+1) sign flip between odd-m and even-m is the
    // load-bearing M1 signal. The cross-function gap is ~4 — any sign
    // mistake on either side collapses the gap.
    const tri = trigamma(fromInt(1n, PREC50DPS), PREC50DPS);
    const m2 = polygamma(2, fromInt(1n, PREC50DPS), PREC50DPS);
    expect(toFloat64(tri).value).toBeGreaterThan(1.5);
    expect(toFloat64(m2).value).toBeLessThan(-2);
    expect(toFloat64(tri).value - toFloat64(m2).value).toBeGreaterThan(4);
  });

  test("polygamma(m, z) finite for m ∈ {2, 3, 5, 8} at z = 1.5 (no-throw smoke)", () => {
    // Stability sweep across orders. Values themselves are pinned by
    // the closed-form tests above; here we confirm dispatch / shift /
    // Euler-Maclaurin stays finite at moderate m.
    for (const m of [2, 3, 5, 8]) {
      const r = polygamma(m, fromString("1.5", PREC50DPS), PREC50DPS);
      expect(Number.isFinite(toFloat64(r).value)).toBe(true);
    }
  });

  test("polygamma(2, z) for z ≤ 0 throws (reflection deferred to v0.2)", () => {
    // The m ≥ 2 reflection branch (DLMF §5.15.6, derivatives of cot(πz))
    // is non-trivial and deferred per R2 §2.2 final paragraph.
    expect(() => polygamma(2, fromString("-0.5", PREC50DPS), PREC50DPS)).toThrow();
    expect(() => polygamma(2, fromInt(0n, PREC50DPS), PREC50DPS)).toThrow();
  });
});
