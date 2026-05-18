// =============================================================================
// besselj.test — bigBesselJ + substrate primitives (real-axis arb-prec)
// =============================================================================
//
// Three layers of validation, following the `erf.test.ts` template:
//
//   1. Special-value spot checks: J_0(0) = 1; J_n(0) = 0 for n ≥ 1;
//      J_{1/2}(0) = 0; parity J_n(-z) = (-1)^n J_n(z); a small smoke
//      check against J_0(2π).
//
//   2. Golden-master byte-comparison against the Phase 1 Arb oracle
//      (`bench/besselj-anchor/oracles/arb/results.json`) for a
//      representative cross-tier sample (T1 small-z + T2 mid-z + T3
//      large-z + T7 large-ν).  At prec=200 bits (~60 dps), the substrate
//      emits ≥ 48-decimal-digit agreement against Arb's 55 dp emit.
//
//   3. Cancellation-retry behaviour: tests that exercise the alternating-
//      Maclaurin cancellation band (`8 < |z| < z_c_Hankel(prec)` with
//      `ν < z²/4`) at multiple precisions, confirming the retry harness
//      delivers prec-bit accuracy where the raw Maclaurin would not.
//
// The Arb oracle is gold-tier per ADR-0040 §"Decision 8".  Per the
// ADR-0041 §Decision 8 oracle hierarchy, three-way (Arb + Wolfram +
// mpmath) gold agreement is the cross-validation baseline; this test
// file pins agreement against Arb only — the other gold-tier oracles
// are independently validated in the bench cross-agreement matrix.

import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  bigBesselJ,
  bigBesselJSeriesMaclaurin,
  bigBesselJHankelAsymptotic,
  bigBesselJSeriesCancellationRetry,
} from "../../src/special-funcs/besselj.js";
import {
  fromString,
  fromInt,
  toFloat64,
  toString,
  neg,
  abs,
  type BigFloat,
} from "../../src/index.js";

// =============================================================================
// Helpers — decimal-string agreement + ν-parsing
// =============================================================================
//
// `canonicalScientific` + `digitsAgreeing` are line-for-line copies of
// the Erf test (`packages/bigfloat/test/erf.test.ts:106-167`).  We embed
// rather than import to keep the test file self-contained (cross-test
// imports of pure helpers were rejected in the Erf shard 131 review).

interface CanonicalScientific {
  zero: boolean;
  sig: string;
  exp10: number;
}

function canonicalScientific(s: string): CanonicalScientific {
  let body = s;
  if (body[0] === "-") body = body.slice(1);
  else if (body[0] === "+") body = body.slice(1);
  let expSuffix = 0;
  const eIdx = body.search(/[eE]/);
  if (eIdx >= 0) {
    expSuffix = parseInt(body.slice(eIdx + 1), 10);
    if (!Number.isFinite(expSuffix)) {
      throw new RangeError(`canonicalScientific: bad exponent in '${s}'`);
    }
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
    return { zero: false, sig, exp10: intTrimmed.length + expSuffix };
  }
  const leadingZeros = fracPart.match(/^0*/)?.[0].length ?? 0;
  const sig = fracPart.slice(leadingZeros).replace(/0+$/, "");
  return { zero: false, sig, exp10: -leadingZeros + expSuffix };
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
 * Parse a ν-value from the corpus.  The corpus uses three forms:
 *   "3"            → integer       → fromInt(3n)
 *   "1/2"          → rational      → fromInt(p)/fromInt(q)
 *   "1.6999..."    → float64-as-decimal → fromString
 *
 * Returned at the requested precision.
 */
function parseNu(s: string, prec: number): BigFloat {
  const slash = s.indexOf("/");
  if (slash >= 0) {
    const p = BigInt(s.slice(0, slash));
    const q = BigInt(s.slice(slash + 1));
    // Rational → BigFloat via fromInt(p) / fromInt(q) at extra precision.
    // We use the same shape as the parent module: build at prec + 32 then
    // round to prec.
    const num = fromInt(p, prec + 32);
    const den = fromInt(q, prec + 32);
    // import locally to avoid polluting the top-level imports
    const { div } = require("../../src/arithmetic.js") as typeof import("../../src/arithmetic.js");
    const { normalise } = require("../../src/types.js") as typeof import("../../src/types.js");
    const r = div(num, den, prec + 32);
    return normalise(r.mantissa, r.exponent, prec);
  }
  if (s.indexOf(".") >= 0) {
    return fromString(s, prec);
  }
  return fromInt(BigInt(s), prec);
}

// =============================================================================
// Corpus / oracle loading
// =============================================================================

interface OracleResult {
  input_id: string;
  head: string;
  nu: string;
  z: string;
  status: string;
  value?: string;
  emit_dps?: number;
}

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..", "..");
const ARB_PATH = resolve(
  REPO_ROOT,
  "bench/besselj-anchor/oracles/arb/results.json",
);

function loadArbResults(): Map<string, OracleResult> {
  const raw = JSON.parse(readFileSync(ARB_PATH, "utf8")) as {
    results: OracleResult[];
  };
  const m = new Map<string, OracleResult>();
  for (const r of raw.results) m.set(r.input_id, r);
  return m;
}

// =============================================================================
// Working precision (bits)
// =============================================================================
//
// Arb emits at 55 dp; to byte-compare at ≥ 48 dp we need ~160 bits
// internal; 200 bits gives a comfortable margin against the final
// rounding.  Same precision as `erf.test.ts` for parity.
const PREC_50DP = 200;

// =============================================================================
// 1. Special-value spot checks
// =============================================================================

describe("bigBesselJ — closed-form special values", () => {
  test("J_0(0) = 1 exactly", () => {
    const r = bigBesselJ(fromInt(0n, PREC_50DP), fromInt(0n, PREC_50DP), PREC_50DP);
    // Should be exactly 1.  Canonicalising via toString.
    expect(toString(r, 30)).toBe("1.00000000000000000000000000000");
  });

  test("J_1(0) = 0 exactly", () => {
    const r = bigBesselJ(fromInt(1n, PREC_50DP), fromInt(0n, PREC_50DP), PREC_50DP);
    expect(r.mantissa).toBe(0n);
  });

  test("J_2(0) = 0 exactly", () => {
    const r = bigBesselJ(fromInt(2n, PREC_50DP), fromInt(0n, PREC_50DP), PREC_50DP);
    expect(r.mantissa).toBe(0n);
  });

  test("J_3(0) = 0 exactly", () => {
    const r = bigBesselJ(fromInt(3n, PREC_50DP), fromInt(0n, PREC_50DP), PREC_50DP);
    expect(r.mantissa).toBe(0n);
  });

  test("J_{1/2}(0) = 0 exactly", () => {
    // ν = 1/2 (positive non-integer) → J_ν(0) = 0 (limit; sqrt(2z/π)·1 → 0).
    const half = fromString("0.5", PREC_50DP);
    const r = bigBesselJ(half, fromInt(0n, PREC_50DP), PREC_50DP);
    expect(r.mantissa).toBe(0n);
  });

  test("J_0(2π) ≈ 0.22 (T1 corpus value, byte-identical to Arb)", () => {
    // The corpus entry T1-besselj-006 uses the float64 of 2π (the same
    // bit pattern Math.PI · 2 produces).
    const twoPi = fromString(
      "6.283185307179586231995926937088370323181152343750000000000000",
      PREC_50DP,
    );
    const r = bigBesselJ(fromInt(0n, PREC_50DP), twoPi, PREC_50DP);
    const rStr = toString(abs(r), 55);
    const expected =
      "0.2202769085399344102581645201524680299248079910654325771";
    expect(digitsAgreeing(rStr, expected)).toBeGreaterThanOrEqual(48);
  });
});

// =============================================================================
// 2. Parity (J_n(-z) = (-1)^n J_n(z))
// =============================================================================

describe("bigBesselJ — parity at integer ν", () => {
  test("J_0(-1) = J_0(1)", () => {
    const z1 = fromString("1", PREC_50DP);
    const r_pos = bigBesselJ(fromInt(0n, PREC_50DP), z1, PREC_50DP);
    const r_neg = bigBesselJ(fromInt(0n, PREC_50DP), neg(z1), PREC_50DP);
    expect(toString(r_pos, 50)).toBe(toString(r_neg, 50));
  });
  test("J_1(-1) = -J_1(1)", () => {
    const z1 = fromString("1", PREC_50DP);
    const r_pos = bigBesselJ(fromInt(1n, PREC_50DP), z1, PREC_50DP);
    const r_neg = bigBesselJ(fromInt(1n, PREC_50DP), neg(z1), PREC_50DP);
    expect(toString(r_pos, 50)).toBe(toString(neg(r_neg), 50));
  });
  test("J_-3(2) = -J_3(2)", () => {
    // Integer-ν reflection J_{-n}(z) = (-1)^n J_n(z).
    const z2 = fromString("2", PREC_50DP);
    const r_pos = bigBesselJ(fromInt(3n, PREC_50DP), z2, PREC_50DP);
    const r_neg_nu = bigBesselJ(fromInt(-3n, PREC_50DP), z2, PREC_50DP);
    expect(toString(r_pos, 50)).toBe(toString(neg(r_neg_nu), 50));
  });
});

// =============================================================================
// 3. Golden-master byte-comparison against Arb (12 inputs)
// =============================================================================

describe("bigBesselJ — golden masters vs Arb gold tier (12 inputs)", () => {
  const arb = loadArbResults();
  // Curated sample crossing T1/T2/T3/T7 × integer/half-int/decimal ν.
  // Each ID is a corpus entry from `bench/besselj-anchor/corpus.json`;
  // the Arb oracle response is at `oracles/arb/results.json`.
  const ids = [
    "T1-besselj-001", // ν=0, z=0.001     — small-z Maclaurin
    "T1-besselj-005", // ν=0, z≈π         — small-z Maclaurin, negative answer
    "T1-besselj-013", // ν=1, z=1         — small-z, ν=1
    "T1-besselj-022", // ν=2, z=1         — small-z, ν=2
    "T1-besselj-058", // ν=1/2, z=1       — half-integer (sin path)
    "T1-besselj-094", // ν=1.7, z=1       — general-decimal ν
    "T2-besselj-001", // ν=0, z=8.5       — boundary into transition band
    "T2-besselj-003", // ν=0, z=20        — cancellation territory
    "T2-besselj-005", // ν=0, z=50        — deep transition (close to Hankel)
    "T3-besselj-001", // ν=0, z=61        — Hankel asymptotic regime
    "T3-besselj-010", // ν=1, z=150       — deep Hankel
    "T7-besselj-001", // ν=50, z=25       — large-ν (z²/4 > ν → Maclaurin)
  ];

  for (const id of ids) {
    test(`${id} agrees with Arb to ≥ 48 dp`, () => {
      const oracle = arb.get(id);
      expect(oracle).toBeDefined();
      if (!oracle || !oracle.value) {
        throw new Error(`oracle entry missing or refused for ${id}`);
      }
      const nu = parseNu(oracle.nu, PREC_50DP);
      const z = fromString(oracle.z, PREC_50DP);
      const result = bigBesselJ(nu, z, PREC_50DP);
      // Sign + magnitude split (canonicalScientific takes positive
      // strings only).
      const isNeg = result.mantissa < 0n;
      const oracleNeg = oracle.value.startsWith("-");
      expect(isNeg).toBe(oracleNeg);
      const resultStr = toString(abs(result), 55);
      const oracleAbsStr = oracleNeg ? oracle.value.slice(1) : oracle.value;
      const agreed = digitsAgreeing(resultStr, oracleAbsStr);
      expect(agreed).toBeGreaterThanOrEqual(48);
    });
  }
});

// =============================================================================
// 4. Cancellation-retry: large-|z| moderate-precision tests
// =============================================================================
//
// These test the cancellation-retry harness specifically.  At
// z = 20 prec = 53, the analytic cancellation estimate is `~29` bits —
// already past the prec=53 working budget if the retry weren't bumping.
// At z = 200 prec = 200, the cancellation is `~289` bits, eating into
// the working precision unless the retry bumps work past `prec + 289`.
//
// The strategy: compute at the target prec, then re-compute at a much
// higher prec (prec + 200 bits extra) and confirm the lower-prec answer
// agrees with the higher-prec answer to within the target precision.
// This proves the cancellation-retry delivered prec-bit accuracy at
// the target precision — without the retry, the answers would diverge
// at the cancellation-loss bit boundary.

describe("bigBesselJ — cancellation retry delivers prec-bit accuracy", () => {
  // At z = 50, the analytic cancellation is ~72 bits; the retry must
  // pay for at least those bits to reach prec=53 bits of accuracy.
  // Note: |z|=50 is in the Hankel-asymptotic band at prec=53 (z_c=26.5),
  // but at prec=200 it sits in the transition band (z_c=100) where the
  // retry actually fires.  Either way, the answer must converge.
  const cases: Array<{ z: string; prec: number }> = [
    { z: "50", prec: 53 },
    { z: "50", prec: 100 },
    { z: "50", prec: 200 },
    { z: "100", prec: 200 },
  ];

  for (const c of cases) {
    test(`J_0(${c.z}) at prec=${c.prec} matches prec=${c.prec + 200} to ≥ prec-bits`, () => {
      const zBase = fromString(c.z, c.prec);
      const zHigh = fromString(c.z, c.prec + 200);
      const rBase = bigBesselJ(fromInt(0n, c.prec), zBase, c.prec);
      const rHigh = bigBesselJ(fromInt(0n, c.prec + 200), zHigh, c.prec + 200);
      // Express both at the same string length and check digit agreement.
      // We need at least floor(prec/log2 10) ≈ prec * 0.301 digits.
      const targetDp = Math.max(8, Math.floor(c.prec * 0.301) - 2);
      const baseStr = toString(abs(rBase), targetDp + 2);
      const highStr = toString(abs(rHigh), targetDp + 2);
      // Sign agreement first.
      expect(rBase.mantissa < 0n).toBe(rHigh.mantissa < 0n);
      const agreed = digitsAgreeing(baseStr, highStr);
      expect(agreed).toBeGreaterThanOrEqual(targetDp);
    });
  }
});

// =============================================================================
// 5. Direct primitive tests — exercise each substrate piece
// =============================================================================

describe("bigBesselJSeriesMaclaurin — primitive isolation", () => {
  test("agrees with bigBesselJ for small z (z=1, ν=0)", () => {
    // In the small-z lane the dispatcher routes to Maclaurin directly,
    // so the two must agree byte-identically.
    const z = fromString("1", PREC_50DP);
    const nu = fromInt(0n, PREC_50DP);
    const direct = bigBesselJSeriesMaclaurin(nu, z, PREC_50DP);
    const viaDispatch = bigBesselJ(nu, z, PREC_50DP);
    expect(toString(direct, 50)).toBe(toString(viaDispatch, 50));
  });
});

describe("bigBesselJHankelAsymptotic — primitive isolation", () => {
  test("agrees with bigBesselJ in the asymptotic band (z=100, ν=0)", () => {
    const z = fromString("100", PREC_50DP);
    const nu = fromInt(0n, PREC_50DP);
    const direct = bigBesselJHankelAsymptotic(nu, z, PREC_50DP);
    const viaDispatch = bigBesselJ(nu, z, PREC_50DP);
    expect(toString(direct, 48)).toBe(toString(viaDispatch, 48));
  });
  test("throws on non-positive z", () => {
    const zNeg = neg(fromString("5", PREC_50DP));
    expect(() => bigBesselJHankelAsymptotic(fromInt(0n, PREC_50DP), zNeg, PREC_50DP))
      .toThrow(/must be positive/);
  });
});

describe("bigBesselJSeriesCancellationRetry — primitive isolation", () => {
  test("agrees with bigBesselJ in transition band (z=20, ν=0)", () => {
    // At prec=200, z=20 sits in the transition band (z_c=100).  The
    // dispatcher routes here.  Direct call must match the dispatch.
    const z = fromString("20", PREC_50DP);
    const nu = fromInt(0n, PREC_50DP);
    const direct = bigBesselJSeriesCancellationRetry(nu, z, PREC_50DP);
    const viaDispatch = bigBesselJ(nu, z, PREC_50DP);
    expect(toString(direct, 50)).toBe(toString(viaDispatch, 50));
  });
});

// -----------------------------------------------------------------------------
// bigBesselJ — bead m4ut regression coverage (large ν, large z)
// -----------------------------------------------------------------------------
//
// The pre-fix dispatcher routed all `|z| > z_c_Hankel(prec) = prec/2`
// calls through `bigBesselJHankelAsymptotic`, which is only valid for
// ν ≪ z. For ν ≳ z/2 the asymptotic's term-ratio
// `(4ν² − (2k+1)²)/(8(k+1)z)` grows factorially up to k ≈ ν before
// decaying.
//
// Canonical regression: `bigBesselJ(100, 150, 200)` was returning
// `+2.17` against mpmath `−0.0154` — 141× wrong + sign flip. The fix
// (worklog 170) adds a `ν ≥ 25 → Maclaurin / cancellation-retry`
// guard at the top of the dispatcher.

describe("bigBesselJ — bead m4ut large-ν regression (mpmath gold tier)", () => {
  type MSample = [number, number, number];
  // Reference values from mpmath dps=25.
  const SAMPLES: ReadonlyArray<MSample> = [
    [50, 100, -0.038698339728525384],
    [100, 150, -0.015359526118405391],
    [100, 200, 0.009333214186557586],
    [200, 300, -0.01936987260083438],
    [50, 200, 0.015693898978573085],
  ];
  for (const [nu, z, ref] of SAMPLES) {
    test(`bigBesselJ(${nu}, ${z}, 100) ≈ mpmath to ≤ 1e-13`, () => {
      const result = bigBesselJ(fromInt(BigInt(nu), 100), fromString(`${z}`, 100), 100);
      const got = toFloat64(result).value;
      const rel = Math.abs(got - ref) / Math.abs(ref);
      expect(rel).toBeLessThan(1e-13);
    });
  }

  test("m4ut point regression: bigBesselJ(100, 150) → −0.0154 (was +2.17 pre-fix)", () => {
    const result = bigBesselJ(fromInt(100n, 100), fromString("150", 100), 100);
    const got = toFloat64(result).value;
    // The canonical fingerprint: sign negative, magnitude ~0.015.
    expect(got).toBeLessThan(0); // sign — pre-fix returned positive
    expect(Math.abs(got)).toBeGreaterThan(0.01);
    expect(Math.abs(got)).toBeLessThan(0.02);
    expect(Math.abs(got - -0.015359526118405391) / 0.015359526118405391).toBeLessThan(1e-13);
  });
});
