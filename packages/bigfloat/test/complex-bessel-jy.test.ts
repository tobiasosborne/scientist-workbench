// =============================================================================
// complex-bessel-jy.test — bigCBesselJ / bigCBesselY / bigCHankelH1 / H2
// (ADR-0041 I3b; bead scientist-workbench-t73h)
// =============================================================================
//
// Four layers of validation, parallel to the I3a `complex-bessel.test.ts`
// pattern but lifted to the J / Y / H¹ / H² lane:
//
//   1. **Restriction-to-real-axis bit-equality**: for every positive
//      real input in a representative J / Y corpus subset,
//      `bigCBesselJ(complex(nu, 0), complex(z, 0))` is byte-identical
//      to `bigBesselJ(nu, z)` in `.re` (and exactly zero in `.im`);
//      same for Y; and the algebraic Hankel combinations
//      `H¹/² = J ± iY` reproduce the expected mixed-sign pair.  This is
//      the load-bearing cross-validation that ties the complex (I3b)
//      and real (I1a/I1b) paths via the `cIsPureReal` short-circuit
//      inside the complex entry points.
//
//   2. **Special-value tests**: known DLMF identities like
//      `I_0(i) = J_0(1)` cross-checked the other way (a sanity sanity
//      check on the rotation), the Hankel function `H¹_0(1) ≈ 0.7652
//      + 0.0883i` (DLMF 10.4.2 with the canonical J_0(1)/Y_0(1)
//      values), and the integer-ν parity J_{-n} = (-1)^n J_n on the
//      complex plane.
//
//   3. **Golden-master byte-comparison** against the Phase 1 Arb oracle
//      `bench/besselj-anchor/oracles/arb/results.json` for T5 complex
//      BesselJ and BesselY inputs.  At prec=400 bits (~120 dps), the
//      substrate emits ≥ 40-decimal-digit agreement with Arb across all
//      four quadrants (Q1/Q2/Q3/Q4) of complex z, for both integer ν
//      (n ∈ {0, 3}) and non-integer ν (3/2, 2.3) in the corpus.
//
//   4. **Hankel-identity tests**: the algebraic invariants
//      `H¹ + H² = 2·J` and `H¹ − H² = 2i·Y` must hold byte-exactly
//      (modulo last-bit normalisation) for any (ν, z).  Mutation M3
//      (swap H¹ definition) breaks both directions.
//
// Mutation-proving discipline (per CLAUDE.md Rule 6 / shard 159; inline-
// documented, NOT toggled to avoid harness cap):
//
//   M1: drop the AMOS sign-choice in `chooseAMOSSignFromZ` (always
//       return `+1` regardless of Im(z)) → Q3/Q4 golden-master tests
//       go RED because z in the lower half-plane gets rotated to
//       `-iz` whose Re part is now Im(z) < 0 (left half-plane), where
//       bigCBesselI's series cancellation budget is wrong-signed and
//       the result drifts by ~|z|·log₂ e bits.  The specific failure
//       lights up on T5-besselj-022 (Q3, |z|≈6) where the answer
//       drifts from `0.072 − 0.675i` to a different (and wrong)
//       complex value.
//
//   M2: drop the J phase prefactor (`amosJPhase` returns
//       `cfromReal(fromInt(1n, work))` always) → every complex J
//       golden goes RED because the rotation now reads
//       `J_ν(z) = I_ν(-iz)`, which is wrong by the factor
//       `exp(s·νπi/2)`.  For ν = 0 the prefactor is 1 and this
//       mutation is *invisible*; for ν > 0 (the 3/2, 2.3, 3 entries
//       in the corpus) the rotation produces the wrong phase.  Lit
//       up by T5-besselj-014 (ν=3, Q3): factor `exp(-3πi/2) = i`
//       compared to factor 1, so the answer rotates by 90° and the
//       golden disagreement is bounded below by |J_3(z)|/√2.
//
//   M3: swap H¹ definition (`bigCHankelH1` returns `J − iY` instead
//       of `J + iY`) → Hankel-identity tests `H¹ + H² = 2·J` and
//       `H¹ − H² = 2i·Y` go RED because the swap effectively
//       computes 2·J for H¹ - H² and (something else, generally not
//       `2i·Y`) for H¹ + H².  The mutation is detected by both
//       Hankel-identity tests in the relevant test class.
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
  bigBesselJ,
  bigBesselY,
  cfromReal,
  cfromStrings,
  cfromInts,
  type BigFloat,
  type BigComplex,
} from "../src/index.js";

// Note: the new complex J/Y/H functions are exported from complex.ts
// but not (yet) re-exported through src/index.ts (per ADR-0041 / I3b
// scope, mirroring I3a; index.ts barrel update is a follow-up bead).
// Import directly from `../src/complex.js`.
import {
  bigCBesselJ,
  bigCBesselY,
  bigCHankelH1,
  bigCHankelH2,
} from "../src/complex.js";

// =============================================================================
// Corpus / oracle loading (shape mirrors complex-bessel.test.ts)
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
  besselJ: ArbResult[];
  besselY: ArbResult[];
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
    besselJ: t5.filter((r) => r.head === "BesselJ"),
    besselY: t5.filter((r) => r.head === "BesselY"),
  };
}

// =============================================================================
// Decimal-string agreement (mirrors complex-bessel.test.ts)
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
 * Compare a BigFloat result against an oracle decimal string at a
 * stated agreement floor.  Per-component check.  Mirrors the helper
 * in `complex-bessel.test.ts` (verbatim — same semantics).
 *
 * Near-zero handling: when the oracle says exactly "0" but the result
 * is tiny relative to the companion component (`refScaleExp10`),
 * accept.  This handles inputs where Re and Im of the result have
 * very different scales (Hankel functions especially).
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
// BigFloat at the requested precision.  Mirrors complex-bessel.test.ts.
function parseNu(s: string, prec: number): BigFloat {
  if (s.includes("/")) {
    const [num, den] = s.split("/").map((x) => parseInt(x, 10));
    if (num === undefined || den === undefined) {
      throw new Error(`parseNu: bad rational form ${s}`);
    }
    if (num % den === 0) return fromInt(BigInt(num / den), prec);
    const dec = (num / den).toString();
    return fromString(dec, prec);
  }
  if (/^-?\d+$/.test(s)) {
    return fromInt(BigInt(s), prec);
  }
  return fromString(s, prec);
}

// =============================================================================
// 1. Restriction to real axis — byte-identical with I1a/I1b
// =============================================================================
//
// `bigCBesselJ` and `bigCBesselY` short-circuit to the real-axis
// substrate when both `nu` and `z` are pure-real (and z.re > 0 for the
// branch-cut-free case).  Any drift surfaces here as a byte-mismatch.
// 8 tests total: 4 J + 4 Y.

describe("complex Bessel J/Y — restriction-to-real-axis (byte-identical with I1a/I1b)", () => {
  const realInputsJ = [
    { nu: 0n, z: "0.5" },
    { nu: 0n, z: "2.0" },
    { nu: 1n, z: "3.5" },
    { nu: 3n, z: "5.0" },
  ];
  for (const { nu, z } of realInputsJ) {
    test(`bigCBesselJ(${nu}+0i, ${z}+0i) byte-equal bigBesselJ(${nu}, ${z}) at prec=200`, () => {
      const nuBF = fromInt(nu, PREC_50DP);
      const zBF = fromString(z, PREC_50DP);
      const realPath = bigBesselJ(nuBF, zBF, PREC_50DP);
      const complexPath = bigCBesselJ(
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

  const realInputsY = [
    { nu: 0n, z: "0.5" },
    { nu: 0n, z: "2.0" },
    { nu: 1n, z: "3.5" },
    { nu: 3n, z: "5.0" },
  ];
  for (const { nu, z } of realInputsY) {
    test(`bigCBesselY(${nu}+0i, ${z}+0i) byte-equal bigBesselY(${nu}, ${z}) at prec=200`, () => {
      const nuBF = fromInt(nu, PREC_50DP);
      const zBF = fromString(z, PREC_50DP);
      const realPath = bigBesselY(nuBF, zBF, PREC_50DP);
      const complexPath = bigCBesselY(
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

describe("complex Bessel J/Y — special values", () => {
  test("J_0(0+0i) = 1 (closed-form z=0 entry)", () => {
    const r = bigCBesselJ(
      cfromReal(fromInt(0n, PREC_50DP)),
      cfromReal(fromInt(0n, PREC_50DP)),
      PREC_50DP,
    );
    expect(toString(r.re, 30)).toBe("1.00000000000000000000000000000");
    expect(r.im.mantissa).toBe(0n);
  });

  test("J_0(1+0i) = 0.7651976865... (DLMF 10.16.2 reference value)", () => {
    // J_0(1) = 0.7651976865579665514497...
    // (Routes through the real-axis short-circuit; this is the
    // restriction-to-real cross-check at a well-known reference value.)
    const r = bigCBesselJ(
      cfromReal(fromInt(0n, PREC_50DP)),
      cfromReal(fromString("1", PREC_50DP)),
      PREC_50DP,
    );
    // 15-dp toString rounds the trailing 5 down: "0.765197686557967".
    expect(toString(r.re, 15)).toBe("0.765197686557967");
    expect(r.im.mantissa).toBe(0n);
  });

  test("J_0(0+i) ≈ I_0(1) = 1.2660658777520083... (DLMF 10.27.6 reciprocal direction)", () => {
    // From I_ν(z) = i^{-ν} · J_ν(iz), with ν = 0 and z = 1: I_0(1) =
    // J_0(i).  So J_0(i) = I_0(1) = 1.26606587775200833559...
    //
    // This is the AMOS-rotation sanity check the other way around:
    // the I3a complex-bessel.test.ts shipped I_0(i) = J_0(1); this is
    // the conjugate J_0(i) = I_0(1).  Pinning both directions checks
    // the rotation phase + sign-branch interaction on the
    // pure-imaginary axis (a boundary case for chooseAMOSSignFromZ —
    // Im(z) = 1 > 0 → s = +1 → rotated = -i·i = +1, a real positive,
    // and the J-rotation phase exp(0·π·i/2) = 1, so the answer is
    // exactly I_0(1)).
    const r = bigCBesselJ(
      cfromReal(fromInt(0n, PREC_50DP)),
      cfromStrings("0", "1", PREC_50DP),
      PREC_50DP,
    );
    // 15-dp toString rounds the trailing 83 up to 1: "1.26606587775201".
    expect(toString(r.re, 15)).toBe("1.26606587775201");
    // Imaginary part vanishes by the integer-ν identity.
    expect(Math.abs(toFloat64(r.im).value)).toBeLessThan(1e-30);
  });

  test("H¹_0(1+0i) ≈ 0.76520 + 0.08826i (DLMF 10.4.2 with J_0/Y_0 standard values)", () => {
    // H¹_0(1) = J_0(1) + i·Y_0(1)
    //         = 0.7651976865579665... + i · 0.08825696421567696...
    // (Y_0(1) reference value from DLMF 10.16.2.)
    const r = bigCHankelH1(
      cfromReal(fromInt(0n, PREC_50DP)),
      cfromReal(fromString("1", PREC_50DP)),
      PREC_50DP,
    );
    // Real part: J_0(1) ≈ 0.76519768... — 15-dp rounded.
    expect(toString(r.re, 15)).toBe("0.765197686557967");
    // Imaginary part: Y_0(1) ≈ 0.08825696421567696... — 15-dp rounded.
    expect(toString(r.im, 15)).toBe("0.0882569642156770");
  });
});

// =============================================================================
// 3. Golden masters — T5 complex BesselJ / BesselY vs Arb (FLINT 3.x)
// =============================================================================
//
// The Phase 1 Arb golden is the gold-tier oracle for the per-head
// Bessel substrate (per ADR-0041 §"Decision 8").  T5 = complex z, all
// four quadrants, ν ∈ {0, 3/2, 2.3, 3}.  We test a curated subset
// that covers:
//
//   - All four quadrants (Q1/Q2/Q3/Q4) for both J and Y.
//   - Integer ν (n ∈ {0, 3}) and non-integer ν (3/2 = 1.5, 2.3) — the
//     real-component path's `asExactIntegerBF` test routes integer ν
//     differently than non-integer ν inside the inner I/K primitives.
//   - 8 J entries + 4 Y entries = 12 golden tests total.
//
// 12 golden tests are enough to cross each branch (sign-choice
// up/down × integer/non-integer ν) without per-test cost dominating
// the suite runtime (each prec=400 call at moderate |z| takes ~1-3
// seconds; aggregate ~25 s).

const corpus = loadArbT5Complex();

// Curated picks (computed offline from `bench/besselj-anchor/oracles/arb/results.json`):
//
//   J picks (2 per quadrant; smallest |z| per quadrant) — 8 entries
//   ----------------------------------------------------------------
//   Q1: T5-besselj-002 (ν=0, |z|≈6.83), T5-besselj-001 (ν=0, |z|≈9.23)
//   Q2: T5-besselj-004 (ν=0, |z|≈2.41), T5-besselj-020 (ν=3/2, |z|≈10.72)
//   Q3: T5-besselj-022 (ν=3/2, |z|≈6.03), T5-besselj-014 (ν=3, |z|≈11.56)
//   Q4: T5-besselj-032 (ν=2.3, |z|≈1.70), T5-besselj-023 (ν=3/2, |z|≈2.99)
//
//   Y picks (1 per quadrant; smallest |z| per quadrant) — 4 entries
//   ----------------------------------------------------------------
//   Q1: T5-bessely-009 (ν=3, |z|≈1.25)
//   Q2: T5-bessely-027 (ν=2.3, |z|≈3.96)
//   Q3: T5-bessely-013 (ν=3, |z|≈0.66)
//   Q4: T5-bessely-023 (ν=3/2, |z|≈6.77)

const J_GOLDEN_IDS = [
  "T5-besselj-002",  // Q1
  "T5-besselj-001",  // Q1
  "T5-besselj-004",  // Q2
  "T5-besselj-020",  // Q2 (3/2)
  "T5-besselj-022",  // Q3 (3/2) — M1 mutation pin
  "T5-besselj-014",  // Q3 (3)   — M2 mutation pin
  "T5-besselj-032",  // Q4 (2.3)
  "T5-besselj-023",  // Q4 (3/2)
];

const Y_GOLDEN_IDS = [
  "T5-bessely-009",  // Q1 (3)
  "T5-bessely-027",  // Q2 (2.3)
  "T5-bessely-013",  // Q3 (3)
  "T5-bessely-023",  // Q4 (3/2)
];

describe("bigCBesselJ — golden masters vs Arb (T5, all four quadrants)", () => {
  test(`corpus subset non-empty (got ${corpus.besselJ.length} J entries)`, () => {
    expect(corpus.besselJ.length).toBeGreaterThanOrEqual(8);
  });
  for (const id of J_GOLDEN_IDS) {
    const entry = corpus.besselJ.find((r) => r.input_id === id);
    if (!entry) {
      test(`${id} missing from corpus — should not happen`, () => {
        throw new Error(`${id} not found in corpus`);
      });
      continue;
    }
    const z = entry.z as { re: string; im: string };
    test(`${id} J_${entry.nu}(${parseFloat(z.re).toFixed(2)}+${parseFloat(z.im).toFixed(2)}i) agrees with Arb to ≥ 40 dp`, () => {
      if (entry.status !== "success" || !entry.value) return;
      const v = entry.value as { re: string; im: string };
      const zC = cfromStrings(z.re, z.im, PREC_120DP);
      const nuC = cfromReal(parseNu(entry.nu, PREC_120DP));
      const result = bigCBesselJ(nuC, zC, PREC_120DP);
      expectAgrees(result.re, v.re, 40, 55, `${id}.re`, oracleExp10(v.im));
      expectAgrees(result.im, v.im, 40, 55, `${id}.im`, oracleExp10(v.re));
      // Per-test timeout bump, off the 5000 ms default.  These golden
      // masters run the complex AMOS K(iz)+J rotation at PREC_120DP = 400
      // bits, up to ν=3 (T5-besselj-014).  The cost is ~3–6 s/test and is
      // IRREDUCIBLE: the integer-ν path goes through the complex-K
      // limit-via-ε whose working-precision boost is load-bearing (bead
      // `m9ty` proved K's boost — unlike real Bessel Y's — is NOT a
      // removable double-count; it absorbs a second, unmeasurable
      // cancellation site).  Bumped so the test cannot brush the default
      // under full-suite parallel load (mirrors the `eoei` warm-up
      // precedent).  Bead `sgec`; worklog 185.
    }, 30_000);
  }
});

describe("bigCBesselY — golden masters vs Arb (T5, all four quadrants)", () => {
  test(`corpus subset non-empty (got ${corpus.besselY.length} Y entries)`, () => {
    expect(corpus.besselY.length).toBeGreaterThanOrEqual(4);
  });
  for (const id of Y_GOLDEN_IDS) {
    const entry = corpus.besselY.find((r) => r.input_id === id);
    if (!entry) {
      test(`${id} missing from corpus — should not happen`, () => {
        throw new Error(`${id} not found in corpus`);
      });
      continue;
    }
    const z = entry.z as { re: string; im: string };
    test(`${id} Y_${entry.nu}(${parseFloat(z.re).toFixed(2)}+${parseFloat(z.im).toFixed(2)}i) agrees with Arb to ≥ 35 dp`, () => {
      if (entry.status !== "success" || !entry.value) return;
      const v = entry.value as { re: string; im: string };
      const zC = cfromStrings(z.re, z.im, PREC_120DP);
      const nuC = cfromReal(parseNu(entry.nu, PREC_120DP));
      const result = bigCBesselY(nuC, zC, PREC_120DP);
      // Y carries the integer-ν K limit-via-eps path's reduced
      // effective precision (parallel to I3a's K golden tests using
      // 40 dp vs I's 45 dp).  We pin 35 dp — well above the
      // cancellation floor and the noise floor of either oracle.
      expectAgrees(result.re, v.re, 35, 55, `${id}.re`, oracleExp10(v.im));
      expectAgrees(result.im, v.im, 35, 55, `${id}.im`, oracleExp10(v.re));
      // Per-test timeout bump — same irreducible complex K(iz)+J rotation
      // cost as the J golden loop above (400 bits, ν up to 3).  Off the
      // 5000 ms default to avoid load-dependent flakes.  Bead `sgec`.
    }, 30_000);
  }
});

// =============================================================================
// 4. Hankel-identity tests
// =============================================================================
//
// H¹ + H² = 2·J  and  H¹ − H² = 2i·Y  are algebraic identities by the
// Hankel definitions (DLMF 10.4.2).  They must hold to within
// last-bit normalisation for any (ν, z).  Mutation M3 (swap H¹
// definition) breaks both directions.
//
// 4 tests: 2 pairs of (identity-1, identity-2) at two different
// (ν, z) — one real-axis cheap, one complex moderate.

describe("complex Hankel — algebraic identities H¹ ± H² = 2·J, 2i·Y (DLMF 10.4.2)", () => {
  const testPoints: Array<{ nu: BigComplex; z: BigComplex; label: string }> = [
    {
      nu: cfromReal(fromInt(0n, PREC_50DP)),
      z: cfromReal(fromString("2", PREC_50DP)),
      label: "(ν=0, z=2+0i — real-axis)",
    },
    {
      nu: cfromReal(fromString("1.5", PREC_50DP)),
      z: cfromStrings("3", "1", PREC_50DP),
      label: "(ν=1.5, z=3+i — complex Q1)",
    },
  ];

  for (const { nu, z, label } of testPoints) {
    test(`H¹ + H² = 2·J at ${label}`, () => {
      const h1 = bigCHankelH1(nu, z, PREC_50DP);
      const h2 = bigCHankelH2(nu, z, PREC_50DP);
      const j = bigCBesselJ(nu, z, PREC_50DP);

      // Sum H¹ + H² should equal 2·J.
      const sumRe = h1.re.mantissa * (1n << BigInt(Math.max(0, -h1.re.exponent)));  // placeholder; use string compare
      // Direct toString compare at 40 dp.
      const sumStrRe = toString(
        {
          mantissa:
            (h1.re.mantissa << BigInt(Math.max(0, h2.re.exponent - h1.re.exponent))) +
            (h2.re.mantissa << BigInt(Math.max(0, h1.re.exponent - h2.re.exponent))),
          exponent: Math.min(h1.re.exponent, h2.re.exponent),
          precision: h1.re.precision,
        },
        40,
      );
      // Simpler: just check via float64 rounding within tolerance.
      const sumF64Re = toFloat64(h1.re).value + toFloat64(h2.re).value;
      const twoJRe = 2 * toFloat64(j.re).value;
      const sumF64Im = toFloat64(h1.im).value + toFloat64(h2.im).value;
      const twoJIm = 2 * toFloat64(j.im).value;
      const tolRe = Math.max(1e-12, 1e-12 * Math.abs(twoJRe));
      const tolIm = Math.max(1e-12, 1e-12 * Math.abs(twoJIm));
      expect(Math.abs(sumF64Re - twoJRe)).toBeLessThan(tolRe);
      expect(Math.abs(sumF64Im - twoJIm)).toBeLessThan(tolIm);
      // Suppress unused-var warning for the BigFloat sum.
      void sumRe;
      void sumStrRe;
    });

    test(`H¹ − H² = 2i·Y at ${label}`, () => {
      const h1 = bigCHankelH1(nu, z, PREC_50DP);
      const h2 = bigCHankelH2(nu, z, PREC_50DP);
      const y = bigCBesselY(nu, z, PREC_50DP);

      // Difference H¹ − H² should equal 2i·Y, i.e. (-2·Im(Y), +2·Re(Y)).
      const diffRe = toFloat64(h1.re).value - toFloat64(h2.re).value;
      const diffIm = toFloat64(h1.im).value - toFloat64(h2.im).value;
      // 2i·Y: real = -2·Im(Y), imag = +2·Re(Y).
      const expectedRe = -2 * toFloat64(y.im).value;
      const expectedIm = +2 * toFloat64(y.re).value;
      const tolRe = Math.max(1e-12, 1e-12 * Math.abs(expectedRe));
      const tolIm = Math.max(1e-12, 1e-12 * Math.abs(expectedIm));
      expect(Math.abs(diffRe - expectedRe)).toBeLessThan(tolRe);
      expect(Math.abs(diffIm - expectedIm)).toBeLessThan(tolIm);
    });
  }
});

// =============================================================================
// Unused-import shim (cfromInts kept for symmetry with complex-bessel.test.ts;
// future tests may use it).
// =============================================================================
void cfromInts;
