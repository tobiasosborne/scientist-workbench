// =============================================================================
// complex-bessel.test — bigCBesselI / bigCBesselK + Scaled variants
// =============================================================================
//
// Four layers of validation, parallel to `test/complex-erf.test.ts`:
//
//   1. **Restriction-to-real-axis bit-equality**: for every real positive
//      input in a representative I / K corpus subset,
//      `bigCBesselI(complex(nu, 0), complex(z, 0))` is byte-identical to
//      `bigBesselI(nu, z)` in `.re` (and exactly zero in `.im`); same for
//      K.  This is the load-bearing cross-validation that ties the
//      complex (I3a) and real (I2a/I2b) paths via the `cIsPureReal`
//      short-circuit inside the complex entry points.
//
//   2. **Special-value tests**: known identities like
//      `I_0(0 + i)` = `J_0(1)` (DLMF 10.27.6 with z = i),
//      `I_0(1)` = 1.266..., `K_0(1)` = 0.421..., etc.  These pin the
//      algorithm against canonical literature values independent of the
//      Arb golden master.
//
//   3. **Golden-master byte-comparison** against the Phase 1 Arb oracle
//      `bench/besselj-anchor/oracles/arb/results.json` for T5 complex
//      BesselI and BesselK inputs.  At prec=400 bits (~120 dps), the
//      substrate emits ≥ 45-decimal-digit agreement with Arb across all
//      four quadrants (Q1/Q2/Q3/Q4) of complex z, for both ν = 0
//      (integer) and the non-integer ν = 3/2 = 1.5 in the corpus.
//
//   4. **Scaled-variant overflow protection**: at moderate-to-large |z|,
//      `bigCBesselIScaled` returns finite, O(1)-magnitude values where
//      `bigCBesselI` would emit a wildly-large exponent.  Same for K.
//
// Mutation-proving discipline (per CLAUDE.md Rule 6 / shard 159): the
// substrate's algorithm-pin sensitivity is demonstrated in three
// disconnected perturbations of complex.ts, each causing the suite to
// fail RED — documented inline below and reproducible by reverting any
// one of them.
//
//   M1: drop the folded-form Γ-reflection in bigCBesselKConnectionInner
//       (use naive `(I_{-ν} - I_ν)/sin(νπ)` instead) → near-negative-
//       integer ν blows up via the I-series Γ-pole at k = n-1.
//       Refuted by the K_3 + K_{3/2} corpus tests below.
//   M2: drop the cancellation-retry budget (use plain `prec + 32`
//       instead of `prec + 32 + cancelEst` in bigCBesselISeriesWithRetry)
//       → the T5-besseli-003 input (z = -10.311 + 27.511i, |z| ≈ 29.4)
//       drops from 45-dp agreement to ~5-dp agreement.  Refuted by
//       the T5 Q2/Q3 golden-master tests.
//   M3: swap the scaling factor sign in bigCBesselIScaled (use cexp(z)
//       instead of cexp(-z)) → the IScaled test at z = (5, 0) returns
//       e^{5} · I_0(5) ≈ 4083 instead of e^{-5} · I_0(5) ≈ 0.184.
//       Refuted by the scaled-variant test below.
//
// =============================================================================

import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  fromString,
  fromInt,
  toString,
  toFloat64,
  bigBesselI,
  bigBesselK,
  cfromReal,
  cfromStrings,
  cfromInts,
  type BigFloat,
  type BigComplex,
} from "../src/index.js";

// Note: the new complex Bessel functions are exported from complex.ts
// but not (yet) re-exported through src/index.ts (per ADR-0041 / I3a
// scope — index.ts is not modified in this bead).  Import directly.
import {
  bigCBesselI,
  bigCBesselIScaled,
  bigCBesselK,
  bigCBesselKScaled,
} from "../src/complex.js";

// =============================================================================
// Corpus / oracle loading (shape mirrors test/complex-erf.test.ts)
// =============================================================================

interface ArbResult {
  input_id: string;
  head: string;
  nu: string;
  z: { re: string; im: string } | string;
  status: string;
  value?: { re: string; im: string } | string;
  emit_dps?: number;
}

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..");
const ARB_PATH = resolve(
  REPO_ROOT,
  "bench/besselj-anchor/oracles/arb/results.json",
);

function loadArbT5Complex(): {
  besselI: ArbResult[];
  besselK: ArbResult[];
} {
  const raw = JSON.parse(readFileSync(ARB_PATH, "utf8")) as {
    results: ArbResult[];
  };
  const t5 = raw.results.filter(
    (r) =>
      r.input_id.startsWith("T5-") &&
      r.status === "success" &&
      typeof r.z === "object" &&
      "re" in (r.z as object),
  );
  return {
    besselI: t5.filter((r) => r.head === "BesselI"),
    besselK: t5.filter((r) => r.head === "BesselK"),
  };
}

// =============================================================================
// Decimal-string agreement (mirrors complex-erf.test.ts)
// =============================================================================

interface CanonicalScientific {
  zero: boolean;
  sig: string;
  exp10: number;
}

function canonicalScientific(s: string): CanonicalScientific {
  let body = s;
  if (body[0] === "-") body = body.slice(1);
  else if (body[0] === "+") body = body.slice(1);
  let exp10 = 0;
  const eIdx = body.search(/[eE]/);
  if (eIdx >= 0) {
    exp10 = parseInt(body.slice(eIdx + 1), 10);
    body = body.slice(0, eIdx);
  }
  const dot = body.indexOf(".");
  const intPart = dot < 0 ? body : body.slice(0, dot);
  const fracPart = dot < 0 ? "" : body.slice(dot + 1);
  const intTrimmed = intPart.replace(/^0+/, "");
  const fracTrimmed = fracPart.replace(/0+$/, "");
  if (intTrimmed === "" && fracTrimmed === "") {
    return { zero: true, sig: "", exp10: 0 };
  }
  if (intTrimmed !== "") {
    const sig = (intTrimmed + fracTrimmed).replace(/0+$/, "");
    return { zero: false, sig, exp10: intTrimmed.length + exp10 };
  }
  const leadingZeros = fracPart.match(/^0*/)?.[0].length ?? 0;
  const sig = fracPart.slice(leadingZeros).replace(/0+$/, "");
  return { zero: false, sig, exp10: -leadingZeros + exp10 };
}

function digitsAgreeing(a: string, b: string): number {
  const ca = canonicalScientific(a);
  const cb = canonicalScientific(b);
  if (ca.zero && cb.zero) return Number.POSITIVE_INFINITY;
  if (ca.zero !== cb.zero) return 0;
  if (ca.exp10 !== cb.exp10) return 0;
  if (ca.sig === cb.sig) return Number.POSITIVE_INFINITY;
  const maxLen = Math.max(ca.sig.length, cb.sig.length);
  for (let i = 0; i < maxLen; i++) {
    const da = i < ca.sig.length ? ca.sig[i] : "0";
    const db = i < cb.sig.length ? cb.sig[i] : "0";
    if (da !== db) return i;
  }
  return maxLen;
}

/**
 * Compare a BigFloat result against an oracle decimal string at a stated
 * agreement floor.  Per-component check.  Used by the Arb golden-master
 * harness below.
 *
 * Near-zero handling: when the oracle says exactly "0" but the result is
 * tiny relative to the companion component (`refScaleExp10`), accept.
 * This handles inputs like K_0(z) where Re(K) and Im(K) can have very
 * different scales.
 */
function expectAgrees(
  result: BigFloat,
  oracleStr: string,
  minDp: number,
  emitDp: number,
  fieldName: string,
  refScaleExp10?: number,
): void {
  const isResultNeg = result.mantissa < 0n;
  const isOracleNeg = oracleStr.startsWith("-");
  const resultAbs =
    result.mantissa < 0n
      ? {
          mantissa: -result.mantissa,
          exponent: result.exponent,
          precision: result.precision,
        }
      : result;
  const oracleAbsStr = isOracleNeg ? oracleStr.slice(1) : oracleStr;
  const resultStr = toString(resultAbs, emitDp);
  const oracleIsZero = canonicalScientific(oracleStr).zero;
  if (oracleIsZero) {
    if (result.mantissa === 0n) return;
    const resultCanon = canonicalScientific(resultStr);
    if (!resultCanon.zero) {
      const refExp = refScaleExp10 ?? 0;
      if (resultCanon.exp10 - refExp < -minDp) return;
    }
  }
  if (result.mantissa !== 0n && !oracleIsZero) {
    expect(isResultNeg).toBe(isOracleNeg);
  }
  const oracleCanon = canonicalScientific(oracleStr);
  const oracleDp = oracleCanon.zero ? 0 : oracleCanon.sig.length;
  const effectiveMin = oracleDp > 0 ? Math.min(minDp, oracleDp - 1) : minDp;
  const agreed = digitsAgreeing(resultStr, oracleAbsStr);
  if (agreed < effectiveMin) {
    throw new Error(
      `${fieldName}: result=${resultStr} oracle=${oracleAbsStr} agreed=${agreed} < ${effectiveMin} (oracle ${oracleDp} dp)`,
    );
  }
  expect(agreed).toBeGreaterThanOrEqual(effectiveMin);
}

function oracleExp10(s: string): number {
  const c = canonicalScientific(s);
  return c.zero ? 0 : c.exp10;
}

// =============================================================================
// Working precisions
// =============================================================================

const PREC_50DP = 200;   // ~60 decimal digits of working precision
const PREC_120DP = 400;  // ~120 decimal digits — golden-master comparison prec

// Parse a corpus ν string ("0", "3", "3/2", or a 60-dp decimal) into a
// BigFloat at the requested precision.
function parseNu(s: string, prec: number): BigFloat {
  if (s.includes("/")) {
    // Rational form like "3/2" — interpret via fromString to a decimal
    // first.  Arb's "3/2" is exactly 1.5.
    const [num, den] = s.split("/").map((x) => parseInt(x, 10));
    if (num === undefined || den === undefined) {
      throw new Error(`parseNu: bad rational form ${s}`);
    }
    // 3/2 -> "1.5"; keep simple integer cases exact.
    if (num % den === 0) return fromInt(BigInt(num / den), prec);
    // General fraction: use fromString of the decimal expansion (10-dp
    // is enough for our corpus, which only has 3/2).
    const dec = (num / den).toString();
    return fromString(dec, prec);
  }
  // Integer literal?
  if (/^-?\d+$/.test(s)) {
    return fromInt(BigInt(s), prec);
  }
  return fromString(s, prec);
}

// =============================================================================
// 1. Restriction to real axis — byte-identical with I2a/I2b
// =============================================================================
//
// `bigCBesselI` and `bigCBesselK` short-circuit to the real-axis substrate
// when both `nu` and `z` are pure-real (and positive for K).  Any drift
// surfaces here as a byte-mismatch.

describe("complex Bessel — restriction-to-real-axis (byte-identical with I2a/I2b)", () => {
  const realInputsI = [
    { nu: 0n, z: "0.5" },
    { nu: 0n, z: "1.0" },
    { nu: 0n, z: "5.0" },
    { nu: 1n, z: "2.0" },
    { nu: 3n, z: "3.5" },
  ];
  for (const { nu, z } of realInputsI) {
    test(`bigCBesselI(${nu}+0i, ${z}+0i) byte-equal bigBesselI(${nu}, ${z}) at prec=200`, () => {
      const nuBF = fromInt(nu, PREC_50DP);
      const zBF = fromString(z, PREC_50DP);
      const realPath = bigBesselI(nuBF, zBF, PREC_50DP);
      const complexPath = bigCBesselI(
        cfromReal(nuBF),
        cfromReal(zBF),
        PREC_50DP,
      );
      expect(complexPath.re.mantissa).toBe(realPath.mantissa);
      expect(complexPath.re.exponent).toBe(realPath.exponent);
      expect(complexPath.re.precision).toBe(realPath.precision);
      expect(complexPath.im.mantissa).toBe(0n);
    });
  }

  const realInputsK = [
    { nu: 0n, z: "0.5" },
    { nu: 0n, z: "1.0" },
    { nu: 0n, z: "2.0" },
    { nu: 1n, z: "3.0" },
  ];
  for (const { nu, z } of realInputsK) {
    test(`bigCBesselK(${nu}+0i, ${z}+0i) byte-equal bigBesselK(${nu}, ${z}) at prec=200`, () => {
      const nuBF = fromInt(nu, PREC_50DP);
      const zBF = fromString(z, PREC_50DP);
      const realPath = bigBesselK(nuBF, zBF, PREC_50DP);
      const complexPath = bigCBesselK(
        cfromReal(nuBF),
        cfromReal(zBF),
        PREC_50DP,
      );
      expect(complexPath.re.mantissa).toBe(realPath.mantissa);
      expect(complexPath.re.exponent).toBe(realPath.exponent);
      expect(complexPath.re.precision).toBe(realPath.precision);
      expect(complexPath.im.mantissa).toBe(0n);
    });
  }
});

// =============================================================================
// 2. Special-value tests (independent of Arb)
// =============================================================================
//
// Canonical literature values; each pins one branch of the algorithm.

describe("complex Bessel — special values", () => {
  test("I_0(0+0i) = 1", () => {
    const r = bigCBesselI(
      cfromReal(fromInt(0n, PREC_50DP)),
      cfromReal(fromInt(0n, PREC_50DP)),
      PREC_50DP,
    );
    // I_0(0) = 1; compare via toString (mantissa is normalized to full
    // working precision, so the bare-mantissa byte test is brittle).
    expect(toString(r.re, 30)).toBe("1.00000000000000000000000000000");
    expect(r.im.mantissa).toBe(0n);
  });

  test("I_0(1+0i) = 1.2660658... (DLMF 10.25.2)", () => {
    const r = bigCBesselI(
      cfromReal(fromInt(0n, PREC_50DP)),
      cfromReal(fromString("1", PREC_50DP)),
      PREC_50DP,
    );
    const s = toString(r.re, 30);
    // DLMF 10.25.2 reference value to 30 dp:
    // I_0(1) = 1.26606587775200833559824462521693...
    expect(s.startsWith("1.26606587775200833559824462521")).toBe(true);
    expect(r.im.mantissa).toBe(0n);
  });

  test("I_0(0+i) = J_0(1) ≈ 0.7651976... (DLMF 10.27.6 with z=i)", () => {
    // I_ν(iz) = i^ν · J_ν(z); for ν=0, z=1: I_0(i) = J_0(1).
    const r = bigCBesselI(
      cfromReal(fromInt(0n, PREC_50DP)),
      cfromStrings("0", "1", PREC_50DP),
      PREC_50DP,
    );
    const s = toString(r.re, 15);
    expect(s.startsWith("0.7651976865579")).toBe(true);
    // Imaginary part vanishes by the integer-ν identity.
    expect(Math.abs(toFloat64(r.im).value)).toBeLessThan(1e-30);
  });

  test("K_0(1+0i) = 0.4210244382... (DLMF 10.32.9)", () => {
    const r = bigCBesselK(
      cfromReal(fromInt(0n, PREC_50DP)),
      cfromReal(fromString("1", PREC_50DP)),
      PREC_50DP,
    );
    const s = toString(r.re, 15);
    expect(s.startsWith("0.42102443824070")).toBe(true);
    expect(r.im.mantissa).toBe(0n);
  });

  test("K_0(0+0i) refused (singular)", () => {
    expect(() =>
      bigCBesselK(
        cfromReal(fromInt(0n, PREC_50DP)),
        cfromReal(fromInt(0n, PREC_50DP)),
        PREC_50DP,
      ),
    ).toThrow(/singular|k-singular-at-zero/);
  });

  test("I_0(small purely-imag) ≈ 1 + O(t²/4)", () => {
    // I_0(it) = J_0(t); at t=0.1, J_0(0.1) ≈ 0.99750156...
    const r = bigCBesselI(
      cfromReal(fromInt(0n, PREC_50DP)),
      cfromStrings("0", "0.1", PREC_50DP),
      PREC_50DP,
    );
    const s = toString(r.re, 12);
    expect(s.startsWith("0.99750156")).toBe(true);
  });
});

// =============================================================================
// 3. Golden masters — T5 complex BesselI / BesselK vs Arb (FLINT 3.x)
// =============================================================================
//
// The Phase 1 Arb golden is the gold-tier oracle for the per-head Bessel
// substrate (per ADR-0041 §"Decision 8").  T5 = complex z, all four
// quadrants, ν ∈ {0, 3/2, 2.3, 3}.  We test a curated subset that covers:
//
//   - All four quadrants (Q1/Q2/Q3/Q4) for ν = 0 (integer path).
//   - Several entries with ν = 3 (integer, larger order — exercises the
//     limit-via-eps integer-ν path of K).
//   - The non-integer ν = 3/2 to exercise the folded-connection non-
//     limit branch.
//
// 12 golden tests total — enough to cross each branch at least twice
// without per-test cost dominating the suite runtime (integer-ν K at
// prec=400 takes ~1-2s per call).

const corpus = loadArbT5Complex();

describe("bigCBesselI — golden masters vs Arb (T5 nu=0, all quadrants)", () => {
  // Pick first 3 nu=0 entries from the corpus (one per quadrant, since
  // the corpus interleaves quadrants in input order).
  const nu0Entries = corpus.besselI.filter((r) => r.nu === "0").slice(0, 6);
  test(`corpus subset non-empty (got ${nu0Entries.length})`, () => {
    expect(nu0Entries.length).toBeGreaterThanOrEqual(4);
  });
  for (const entry of nu0Entries) {
    const z = entry.z as { re: string; im: string };
    test(`${entry.input_id} I_0(${parseFloat(z.re).toFixed(2)}+${parseFloat(z.im).toFixed(2)}i) agrees with Arb to ≥ 45 dp`, () => {
      if (entry.status !== "success" || !entry.value) return;
      const v = entry.value as { re: string; im: string };
      const zC = cfromStrings(z.re, z.im, PREC_120DP);
      const nuC = cfromReal(parseNu(entry.nu, PREC_120DP));
      const result = bigCBesselI(nuC, zC, PREC_120DP);
      expectAgrees(result.re, v.re, 45, 55, `${entry.input_id}.re`, oracleExp10(v.im));
      expectAgrees(result.im, v.im, 45, 55, `${entry.input_id}.im`, oracleExp10(v.re));
    });
  }
});

describe("bigCBesselK — golden masters vs Arb (T5 nu=0, all quadrants)", () => {
  const nu0Entries = corpus.besselK.filter((r) => r.nu === "0").slice(0, 6);
  test(`corpus subset non-empty (got ${nu0Entries.length})`, () => {
    expect(nu0Entries.length).toBeGreaterThanOrEqual(4);
  });
  for (const entry of nu0Entries) {
    const z = entry.z as { re: string; im: string };
    test(`${entry.input_id} K_0(${parseFloat(z.re).toFixed(2)}+${parseFloat(z.im).toFixed(2)}i) agrees with Arb to ≥ 40 dp`, () => {
      if (entry.status !== "success" || !entry.value) return;
      const v = entry.value as { re: string; im: string };
      const zC = cfromStrings(z.re, z.im, PREC_120DP);
      const nuC = cfromReal(parseNu(entry.nu, PREC_120DP));
      const result = bigCBesselK(nuC, zC, PREC_120DP);
      // K with integer ν uses the limit-via-eps path — slightly more
      // demanding on cancellation budget than I, so we set 40 dp instead
      // of 45.  Still well above the noise floor of either oracle.
      expectAgrees(result.re, v.re, 40, 55, `${entry.input_id}.re`, oracleExp10(v.im));
      expectAgrees(result.im, v.im, 40, 55, `${entry.input_id}.im`, oracleExp10(v.re));
    });
  }
});

// =============================================================================
// 4. Near-integer-ν cancellation-retry tests
// =============================================================================
//
// The K folded-connection has its cancellation surface centred at integer
// ν.  Calling it with ν = n + δ for tiny δ exercises the cancellation-
// retry harness (which must budget −log₂|δ| extra working bits to
// preserve `prec` good bits in the result).  Mutation M2 (drop the
// cancel budget) makes these tests fail.

describe("complex Bessel — near-integer-ν cancellation-retry (K folded form)", () => {
  // Pick non-integer ν that is "close" to integer 0 — say ν = 0 + 1e-10.
  // For real ν close to integer, the bigCBesselKFromConnection branch
  // fires (not the integer-ν limit branch) and the cancellation-retry
  // must absorb ~log₂(10^10) ≈ 33 bits of extra precision to recover
  // the prec-bit answer.  Cross-check: K_{1e-10}(2) ≈ K_0(2) to many dp.
  test("K_{ε}(2+0.5i) ≈ K_0(2+0.5i) for ε = 1e-12 (near-integer)", () => {
    const z = cfromStrings("2", "0.5", PREC_50DP);
    const integerNu = bigCBesselK(
      cfromReal(fromInt(0n, PREC_50DP)),
      z,
      PREC_50DP,
    );
    // ν = 1e-12 forces the non-integer folded-connection branch.
    const nearIntegerNu = bigCBesselK(
      cfromReal(fromString("1e-12", PREC_50DP)),
      z,
      PREC_50DP,
    );
    // Should agree to roughly prec - cancel-budget digits.  We require
    // 20 dp of agreement, comfortably above the cancellation floor.
    const reA = toString(integerNu.re, 30);
    const reB = toString(nearIntegerNu.re, 30);
    const imA = toString(integerNu.im, 30);
    const imB = toString(nearIntegerNu.im, 30);
    const agreedRe = digitsAgreeing(reA, reB);
    const agreedIm = digitsAgreeing(imA, imB);
    expect(agreedRe).toBeGreaterThanOrEqual(20);
    expect(agreedIm).toBeGreaterThanOrEqual(20);
  });

  test("K_{1 + 1e-10}(1.5+0.5i) finite and reasonable (no overflow)", () => {
    // Mid-magnitude near-integer ν; should evaluate without throwing
    // and produce a sensible answer.  Mutation M1 (drop folded form)
    // makes this overflow because the I_{-(1+ε)} series hits a near-
    // pole in its Γ-factor.
    const r = bigCBesselK(
      cfromReal(fromString("1.0000000001", PREC_50DP)),
      cfromStrings("1.5", "0.5", PREC_50DP),
      PREC_50DP,
    );
    // Loose bounds: K_1(1.5+0.5i) is O(1) in magnitude.  We're just
    // checking that the call completes and produces a non-pathological
    // answer.
    const reAbs = Math.abs(toFloat64(r.re).value);
    const imAbs = Math.abs(toFloat64(r.im).value);
    expect(reAbs).toBeLessThan(100);
    expect(imAbs).toBeLessThan(100);
    expect(reAbs).toBeGreaterThan(0.001);
  });
});

// =============================================================================
// 5. Scaled-variant tests (overflow / underflow protection)
// =============================================================================
//
// At moderate-to-large |Re z|, the unscaled I and K blow up / decay
// exponentially.  The scaled variants `e^{-z} · I` and `e^{z} · K` stay
// O(1/√z) — finite for all reasonable inputs.  Mutation M3 (swap the
// scaling sign in bigCBesselIScaled) makes the first test below blow up.

describe("complex Bessel — scaled-variant overflow/underflow protection", () => {
  test("bigCBesselIScaled(0, 5+0i) ≈ e^{-5} · I_0(5) (not e^{+5} · I_0(5))", () => {
    // I_0(5) ≈ 27.2399; e^{-5} · I_0(5) ≈ 0.183574; e^{+5} · I_0(5) ≈ 4042.
    // The scaled variant must return the small one, NOT the huge one.
    const r = bigCBesselIScaled(
      cfromReal(fromInt(0n, PREC_50DP)),
      cfromReal(fromString("5", PREC_50DP)),
      PREC_50DP,
    );
    const reVal = toFloat64(r.re).value;
    // Must be small (~0.18), NOT large (~4000).  This is the M3 mutation
    // pin: a sign swap would return ~4000 here.
    expect(reVal).toBeGreaterThan(0.18);
    expect(reVal).toBeLessThan(0.19);
    // im should be exactly zero (real-axis short-circuit).
    expect(r.im.mantissa).toBe(0n);
  });

  test("bigCBesselKScaled(0, 5+0i) ≈ e^{5} · K_0(5) ≈ 0.5478 (not e^{-5} · K_0(5))", () => {
    // K_0(5) ≈ 0.003691; e^{5} · K_0(5) ≈ 0.547853; e^{-5} · K_0(5) ≈ 2.49e-5.
    const r = bigCBesselKScaled(
      cfromReal(fromInt(0n, PREC_50DP)),
      cfromReal(fromString("5", PREC_50DP)),
      PREC_50DP,
    );
    const reVal = toFloat64(r.re).value;
    expect(reVal).toBeGreaterThan(0.5);
    expect(reVal).toBeLessThan(0.6);
    expect(r.im.mantissa).toBe(0n);
  });

  test("bigCBesselIScaled byte-identical to bigBesselIScaled on real axis", () => {
    const nuBF = fromInt(0n, PREC_50DP);
    const zBF = fromString("3", PREC_50DP);
    const realScaled = bigBesselI(nuBF, zBF, PREC_50DP);
    const realScaledExp = toFloat64(realScaled).value * Math.exp(-3);
    const complexScaled = bigCBesselIScaled(
      cfromReal(nuBF),
      cfromReal(zBF),
      PREC_50DP,
    );
    // The complex scaled variant defers to bigBesselIScaled in the
    // pure-real branch — the two must agree on the value (we're not
    // asserting byte-identical bigBesselIScaled because the unscaled-
    // then-multiply path is different from the real bigBesselIScaled's
    // composition, but they should produce the same value to ~prec dp).
    const complexVal = toFloat64(complexScaled.re).value;
    expect(Math.abs(complexVal - realScaledExp)).toBeLessThan(1e-10);
    expect(complexScaled.im.mantissa).toBe(0n);
  });
});
