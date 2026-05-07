// =============================================================================
// complex.test — BigComplex arithmetic, sqrt, exp, log, gamma, digamma
// =============================================================================

import { describe, expect, test } from "bun:test";
import {
  cfromReal,
  cfromInts,
  cfromStrings,
  cconj,
  cisZero,
  cadd,
  csub,
  cmul,
  cdiv,
  cneg,
  cabs,
  carg,
  csqrt,
  cexp,
  clog,
  cpow,
  clgamma,
  cgamma,
  cdigamma,
  fromInt,
  fromString,
  fromFloat64,
  toFloat64,
  toString,
  decimalToBinaryPrecision,
  pi,
  sub,
  abs,
  div,
  type BigComplex,
} from "../src/index.js";

const PREC50DPS = decimalToBinaryPrecision(50);

describe("BigComplex constructors and accessors", () => {
  test("cfromReal", () => {
    const r = cfromReal(fromInt(7n, 53));
    expect(toFloat64(r.re).value).toBe(7);
    expect(toFloat64(r.im).value).toBe(0);
  });

  test("cfromInts", () => {
    const r = cfromInts(3n, 4n, 53);
    expect(toFloat64(r.re).value).toBe(3);
    expect(toFloat64(r.im).value).toBe(4);
  });

  test("cconj", () => {
    const r = cconj(cfromInts(3n, 4n, 53));
    expect(toFloat64(r.re).value).toBe(3);
    expect(toFloat64(r.im).value).toBe(-4);
  });

  test("cisZero", () => {
    expect(cisZero(cfromInts(0n, 0n, 53))).toBe(true);
    expect(cisZero(cfromInts(0n, 1n, 53))).toBe(false);
    expect(cisZero(cfromInts(1n, 0n, 53))).toBe(false);
  });
});

describe("BigComplex arithmetic", () => {
  test("(1+2i) + (3+4i) = 4+6i", () => {
    const r = cadd(cfromInts(1n, 2n, 53), cfromInts(3n, 4n, 53), 53);
    expect(toFloat64(r.re).value).toBe(4);
    expect(toFloat64(r.im).value).toBe(6);
  });

  test("(1+2i) - (3+4i) = -2-2i", () => {
    const r = csub(cfromInts(1n, 2n, 53), cfromInts(3n, 4n, 53), 53);
    expect(toFloat64(r.re).value).toBe(-2);
    expect(toFloat64(r.im).value).toBe(-2);
  });

  test("(1+2i) * (3+4i) = -5+10i", () => {
    const r = cmul(cfromInts(1n, 2n, 53), cfromInts(3n, 4n, 53), 53);
    expect(toFloat64(r.re).value).toBe(-5);
    expect(toFloat64(r.im).value).toBe(10);
  });

  test("(3+4i) / (1+2i) = 11/5 - 2/5 i", () => {
    const r = cdiv(cfromInts(3n, 4n, 100), cfromInts(1n, 2n, 100), 100);
    expect(toFloat64(r.re).value).toBeCloseTo(11 / 5, 14);
    expect(toFloat64(r.im).value).toBeCloseTo(-2 / 5, 14);
  });

  test("cmul commutative", () => {
    const a = cfromStrings("0.7", "1.3", 100);
    const b = cfromStrings("-2.5", "0.4", 100);
    const ab = cmul(a, b, 100);
    const ba = cmul(b, a, 100);
    expect(toFloat64(sub(ab.re, ba.re, 100)).value).toBeCloseTo(0, 25);
    expect(toFloat64(sub(ab.im, ba.im, 100)).value).toBeCloseTo(0, 25);
  });

  test("cdiv: a/a = 1", () => {
    const a = cfromInts(3n, 4n, 100);
    const r = cdiv(a, a, 100);
    expect(toFloat64(sub(r.re, fromInt(1n, 100), 100)).value).toBeCloseTo(0, 25);
    expect(toFloat64(r.im).value).toBeCloseTo(0, 25);
  });

  test("cdiv throws on zero divisor", () => {
    expect(() => cdiv(cfromInts(1n, 1n, 53), cfromInts(0n, 0n, 53), 53)).toThrow(RangeError);
  });
});

describe("|z| and arg(z)", () => {
  test("|3+4i| = 5", () => {
    const r = cabs(cfromInts(3n, 4n, 100), 100);
    expect(toFloat64(r).value).toBe(5);
  });

  test("|0| = 0", () => {
    const r = cabs(cfromInts(0n, 0n, 53), 53);
    expect(toFloat64(r).value).toBe(0);
  });

  test("arg(1+i) = π/4", () => {
    const r = carg(cfromInts(1n, 1n, PREC50DPS), PREC50DPS);
    const piOver4 = div(pi(PREC50DPS), fromInt(4n, PREC50DPS), PREC50DPS);
    expect(toFloat64(abs(sub(r, piOver4, PREC50DPS))).value).toBeLessThan(1e-45);
  });

  test("arg(-1) = π", () => {
    const r = carg(cfromInts(-1n, 0n, PREC50DPS), PREC50DPS);
    expect(toFloat64(abs(sub(r, pi(PREC50DPS), PREC50DPS))).value).toBeLessThan(1e-45);
  });

  test("arg(-i) = -π/2", () => {
    const r = carg(cfromInts(0n, -1n, PREC50DPS), PREC50DPS);
    const expected = div(pi(PREC50DPS), fromInt(-2n, PREC50DPS), PREC50DPS);
    expect(toFloat64(abs(sub(r, expected, PREC50DPS))).value).toBeLessThan(1e-45);
  });
});

describe("csqrt", () => {
  test("csqrt(0) = 0", () => {
    const r = csqrt(cfromInts(0n, 0n, 53), 53);
    expect(cisZero(r)).toBe(true);
  });

  test("csqrt(4) = 2", () => {
    const r = csqrt(cfromInts(4n, 0n, 53), 53);
    expect(toFloat64(r.re).value).toBe(2);
    expect(toFloat64(r.im).value).toBeCloseTo(0, 14);
  });

  test("csqrt(-1) = i", () => {
    const r = csqrt(cfromInts(-1n, 0n, 53), 53);
    expect(toFloat64(r.re).value).toBeCloseTo(0, 14);
    expect(toFloat64(r.im).value).toBe(1);
  });

  test("csqrt(-i) = (1-i)/√2", () => {
    const r = csqrt(cfromInts(0n, -1n, PREC50DPS), PREC50DPS);
    // Wolfram: Sqrt[-I] = (1-I)/Sqrt[2] = 0.70710678... - 0.70710678... i.
    expect(toFloat64(r.re).value).toBeCloseTo(Math.SQRT1_2, 14);
    expect(toFloat64(r.im).value).toBeCloseTo(-Math.SQRT1_2, 14);
  });

  test("csqrt(z)² = z", () => {
    for (const [a, b] of [
      [3, 4],
      [-2, 5],
      [-7, -1],
    ] as [number, number][]) {
      const z = cfromInts(BigInt(a), BigInt(b), 100);
      const s = csqrt(z, 100);
      const back = cmul(s, s, 100);
      expect(toFloat64(sub(back.re, z.re, 100)).value).toBeCloseTo(0, 25);
      expect(toFloat64(sub(back.im, z.im, 100)).value).toBeCloseTo(0, 25);
    }
  });
});

describe("cexp", () => {
  test("exp(0) = 1", () => {
    const r = cexp(cfromInts(0n, 0n, 100), 100);
    expect(toFloat64(r.re).value).toBe(1);
    expect(toFloat64(r.im).value).toBeCloseTo(0, 14);
  });

  test("exp(iπ) = -1 (Euler's identity)", () => {
    const iPi: BigComplex = { re: fromInt(0n, PREC50DPS), im: pi(PREC50DPS) };
    const r = cexp(iPi, PREC50DPS);
    expect(toFloat64(sub(r.re, fromInt(-1n, PREC50DPS), PREC50DPS)).value).toBeCloseTo(0, 45);
    expect(toFloat64(r.im).value).toBeCloseTo(0, 45);
  });

  test("exp(1+i) at 50 dps", () => {
    // Wolfram: N[E^(1+I), 50]
    //   re = 1.4686939399158851571389675973266042613269567366290
    //   im = 2.2873552871788423912081719067005018089555862566684
    const r = cexp(cfromInts(1n, 1n, PREC50DPS), PREC50DPS);
    expect(toString(r.re, 50)).toBe("1.4686939399158851571389675973266042613269567366290");
    expect(toString(r.im, 50)).toBe("2.2873552871788423912081719067005018089555862566684");
  });
});

describe("clog", () => {
  test("log(1) = 0", () => {
    const r = clog(cfromInts(1n, 0n, 100), 100);
    expect(toFloat64(r.re).value).toBeCloseTo(0, 25);
    expect(toFloat64(r.im).value).toBe(0);
  });

  test("log(-1) = iπ", () => {
    const r = clog(cfromInts(-1n, 0n, PREC50DPS), PREC50DPS);
    expect(toFloat64(abs(r.re)).value).toBeLessThan(1e-45);
    expect(toFloat64(sub(r.im, pi(PREC50DPS), PREC50DPS)).value).toBeCloseTo(0, 45);
  });

  test("log(i) = iπ/2", () => {
    const r = clog(cfromInts(0n, 1n, PREC50DPS), PREC50DPS);
    const piOver2 = div(pi(PREC50DPS), fromInt(2n, PREC50DPS), PREC50DPS);
    expect(toFloat64(abs(r.re)).value).toBeLessThan(1e-45);
    expect(toFloat64(sub(r.im, piOver2, PREC50DPS)).value).toBeCloseTo(0, 45);
  });

  test("log(exp(z)) ≈ z (modulo branch on im)", () => {
    const z = cfromStrings("0.5", "0.7", 100);
    const r = clog(cexp(z, 100), 100);
    expect(toFloat64(sub(r.re, z.re, 100)).value).toBeCloseTo(0, 25);
    expect(toFloat64(sub(r.im, z.im, 100)).value).toBeCloseTo(0, 25);
  });
});

describe("cpow", () => {
  test("(2+0i)^(0.5+0i) = √2", () => {
    const r = cpow(cfromInts(2n, 0n, PREC50DPS), cfromStrings("0.5", "0", PREC50DPS), PREC50DPS);
    expect(toString(r.re, 50)).toBe("1.4142135623730950488016887242096980785696718753769");
    expect(toFloat64(abs(r.im)).value).toBeLessThan(1e-45);
  });

  test("i^i = e^(-π/2)", () => {
    // i^i = e^(i log i) = e^(i · iπ/2) = e^(-π/2). Real-valued ≈ 0.20787957635...
    const r = cpow(cfromInts(0n, 1n, PREC50DPS), cfromInts(0n, 1n, PREC50DPS), PREC50DPS);
    expect(toFloat64(r.re).value).toBeCloseTo(0.20787957635076193, 14);
    expect(toFloat64(abs(r.im)).value).toBeLessThan(1e-45);
  });
});

describe("cgamma — complex gamma function", () => {
  test("Γ(1+0i) = 1", () => {
    const r = cgamma(cfromInts(1n, 0n, 100), 100);
    expect(toFloat64(r.re).value).toBeCloseTo(1, 14);
    expect(toFloat64(r.im).value).toBeCloseTo(0, 14);
  });

  test("Γ(1+i) at 50 dps (Wolfram cross-check)", () => {
    // Wolfram: N[Gamma[1+I], 50] =
    //   0.498015668118356042713691117353699402863125345240..
    //  -0.154949828301810685124955130920485482685526555297.. I
    const r = cgamma(cfromInts(1n, 1n, PREC50DPS), PREC50DPS);
    expect(toFloat64(r.re).value).toBeCloseTo(0.49801566811835604, 13);
    expect(toFloat64(r.im).value).toBeCloseTo(-0.15494982830181068, 13);
  });

  test("Γ(0.5+0.5i) at 50 dps", () => {
    // Wolfram: N[Gamma[1/2 + I/2], 50] =
    //   0.81816399954174739407... - 0.76331382871398261667... I
    const r = cgamma(cfromStrings("0.5", "0.5", PREC50DPS), PREC50DPS);
    expect(toFloat64(r.re).value).toBeCloseTo(0.8181639995417474, 13);
    expect(toFloat64(r.im).value).toBeCloseTo(-0.7633138287139826, 13);
  });

  test("Γ on negative half-integer (reflection branch)", () => {
    // Γ(-0.5 + 0i) = -2√π ≈ -3.5449077018...
    const r = cgamma(cfromStrings("-0.5", "0", PREC50DPS), PREC50DPS);
    expect(toFloat64(r.re).value).toBeCloseTo(-2 * Math.sqrt(Math.PI), 14);
    expect(toFloat64(abs(r.im)).value).toBeLessThan(1e-30);
  });
});

describe("cdigamma — complex digamma", () => {
  test("ψ(1+0i) = -γ", () => {
    const r = cdigamma(cfromInts(1n, 0n, 100), 100);
    expect(toFloat64(r.re).value).toBeCloseTo(-0.5772156649015329, 14);
    expect(toFloat64(r.im).value).toBeCloseTo(0, 25);
  });

  test("ψ(1+i) at 50 dps", () => {
    // Wolfram: N[PolyGamma[0, 1+I], 50] ≈
    //   0.094650320622476947... + 1.07667404746858117... I
    const r = cdigamma(cfromInts(1n, 1n, PREC50DPS), PREC50DPS);
    expect(toFloat64(r.re).value).toBeCloseTo(0.09465032062247695, 13);
    expect(toFloat64(r.im).value).toBeCloseTo(1.0766740474685811, 13);
  });
});
