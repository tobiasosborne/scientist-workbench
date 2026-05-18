// =============================================================================
// besseli.test — bigBesselI + bigBesselIScaled + substrate primitives (real-axis arb-prec)
// =============================================================================
//
// Three layers of validation, following the `besselj.test.ts` template:
//
//   1. Special-value spot checks: I_0(0) = 1; I_n(0) = 0 for n ≥ 1;
//      classical values I_0(1) ≈ 1.266, I_0(10) ≈ 2815.7, I_0(100) ≈ 1.07e42.
//
//   2. Golden-master byte-comparison against the Phase 1 Arb oracle
//      (`bench/besselj-anchor/oracles/arb/results.json`) for a
//      representative cross-tier sample (T1 small-z + T2 mid-z + T3
//      large-z + T7 large-ν).  At prec=200 bits (~60 dps), the substrate
//      emits ≥ 48-decimal-digit agreement against Arb's 55 dp emit.
//
//   3. Scaled-variant tests: bigBesselIScaled at z ∈ {10, 100, 700} —
//      proves no overflow even at z = 700 where I_0(z) ≈ 10^301.
//
//   4. Negative-z parity tests (integer ν only): I_n(-z) = (-1)^n I_n(z).
//
// The Arb oracle is gold-tier per ADR-0041 §"Decision 8".  Per the
// ADR-0041 §Decision 8 oracle hierarchy, three-way (Arb + Wolfram +
// mpmath) gold agreement is the cross-validation baseline; this test
// file pins agreement against Arb only — the other gold-tier oracles
// are independently validated in the bench cross-agreement matrix.

import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  bigBesselI,
  bigBesselIScaled,
  bigBesselISeriesMaclaurin,
  bigBesselIHankelAsymptotic,
} from "../../src/special-funcs/besseli.js";
import {
  fromString,
  fromInt,
  toString,
  toFloat64,
  neg,
  abs,
  type BigFloat,
} from "../../src/index.js";

// =============================================================================
// Helpers — decimal-string agreement + ν-parsing
// =============================================================================
//
// `canonicalScientific` + `digitsAgreeing` mirror the same helpers in
// `besselj.test.ts` / `erf.test.ts`.  We embed rather than import to
// keep the test file self-contained (cross-test imports of pure helpers
// were rejected in Erf shard 131 review).

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
    const num = fromInt(p, prec + 32);
    const den = fromInt(q, prec + 32);
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
// rounding.  Same precision as `besselj.test.ts` for parity.
const PREC_50DP = 200;

// =============================================================================
// 1. Special-value spot checks
// =============================================================================

describe("bigBesselI — closed-form special values", () => {
  test("I_0(0) = 1 exactly", () => {
    const r = bigBesselI(fromInt(0n, PREC_50DP), fromInt(0n, PREC_50DP), PREC_50DP);
    expect(toString(r, 30)).toBe("1.00000000000000000000000000000");
  });

  test("I_1(0) = 0 exactly", () => {
    const r = bigBesselI(fromInt(1n, PREC_50DP), fromInt(0n, PREC_50DP), PREC_50DP);
    expect(r.mantissa).toBe(0n);
  });

  test("I_2(0) = 0 exactly", () => {
    const r = bigBesselI(fromInt(2n, PREC_50DP), fromInt(0n, PREC_50DP), PREC_50DP);
    expect(r.mantissa).toBe(0n);
  });

  test("I_0(1) ≈ 1.266 (classical value, Abramowitz & Stegun 9.8.1)", () => {
    const z1 = fromString("1", PREC_50DP);
    const r = bigBesselI(fromInt(0n, PREC_50DP), z1, PREC_50DP);
    const rStr = toString(r, 55);
    // From Arb golden T1-besseli-004: I_0(1) = 1.26606587775200833559824...
    const expected =
      "1.2660658777520083355982446252147175376076703113549622";
    expect(digitsAgreeing(rStr, expected)).toBeGreaterThanOrEqual(48);
  });

  test("I_0(10) ≈ 2815.7 (classical value, cross-validates asymptotic branch)", () => {
    const z10 = fromString("10", PREC_50DP);
    const r = bigBesselI(fromInt(0n, PREC_50DP), z10, PREC_50DP);
    const rFloat = toFloat64(r).value;
    // I_0(10) = 2815.7166284... — match to 4 sig-figs as a smoke check
    // (the golden-master tests do the high-precision validation; this
    // test pins that the order of magnitude is right at the I-dispatch
    // boundary).
    expect(rFloat).toBeGreaterThan(2815);
    expect(rFloat).toBeLessThan(2816);
  });

  test("I_0(100) ≈ 1.07e+42 (asymptotic regime smoke check)", () => {
    // At z=100 the dispatcher routes to the modified-Hankel asymptotic
    // (since 2|z| = 200 > prec = 200 is borderline but the |z| < 16
    // lane is rejected, and the 2|z| < prec lane is also rejected at
    // prec=200 boundary).  This exercises the asymptotic branch.
    const z100 = fromString("100", PREC_50DP);
    const r = bigBesselI(fromInt(0n, PREC_50DP), z100, PREC_50DP);
    // Convert to string form and parse leading digits + exponent.
    const rStr = toString(r, 6);
    // I_0(100) ≈ 1.07375e+42 (Abramowitz & Stegun, also matches Wolfram).
    expect(rStr).toMatch(/^1\.073(5|6|7|8)\d*e\+0?42$/);
  });
});

// =============================================================================
// 2. Parity at integer ν (I_n(-z) = (-1)^n I_n(z); I_n is symmetric in n)
// =============================================================================

describe("bigBesselI — parity at integer ν", () => {
  test("I_0(-1) = I_0(1) (even in z at ν=0)", () => {
    const z1 = fromString("1", PREC_50DP);
    const r_pos = bigBesselI(fromInt(0n, PREC_50DP), z1, PREC_50DP);
    const r_neg = bigBesselI(fromInt(0n, PREC_50DP), neg(z1), PREC_50DP);
    expect(toString(r_pos, 50)).toBe(toString(r_neg, 50));
  });
  test("I_1(-1) = -I_1(1) (odd in z at ν=1)", () => {
    const z1 = fromString("1", PREC_50DP);
    const r_pos = bigBesselI(fromInt(1n, PREC_50DP), z1, PREC_50DP);
    const r_neg = bigBesselI(fromInt(1n, PREC_50DP), neg(z1), PREC_50DP);
    expect(toString(r_pos, 50)).toBe(toString(neg(r_neg), 50));
  });
});

// =============================================================================
// 3. Golden-master byte-comparison against Arb (12 inputs)
// =============================================================================

describe("bigBesselI — golden masters vs Arb gold tier (12 inputs)", () => {
  const arb = loadArbResults();
  // Curated sample crossing T1/T2/T3/T7 × integer/half-int/decimal ν.
  // Each ID is a corpus entry from `bench/besselj-anchor/corpus.json`;
  // the Arb oracle response is at `oracles/arb/results.json`.
  const ids = [
    "T1-besseli-001", // ν=0, z=0.001     — small-z Maclaurin
    "T1-besseli-004", // ν=0, z=1         — small-z, classical I_0(1)
    "T1-besseli-005", // ν=0, z=π         — small-z, irrational z
    "T1-besseli-007", // ν=0, z=8         — series-band edge
    "T1-besseli-013", // ν=1, z=1         — small-z, ν=1
    "T1-besseli-022", // ν=2, z=1         — small-z, ν=2
    "T1-besseli-058", // ν=1/2, z=1       — half-integer ν
    "T1-besseli-094", // ν=1.7, z=1       — general-decimal ν
    "T2-besseli-003", // ν=0, z=20        — past |z|<16, in mid-band
    "T2-besseli-005", // ν=0, z=50        — solid asymptotic regime
    "T3-besseli-001", // ν=0, z=61        — deeper asymptotic
    "T7-besseli-001", // ν=50, z=25       — large-ν, ν > z²/4=156? no, 50<156
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
      const result = bigBesselI(nu, z, PREC_50DP);
      // I_ν(z) > 0 for ν ≥ 0, z > 0 — no sign-handling complications.
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
// 4. Scaled variant — overflow protection
// =============================================================================
//
// `bigBesselIScaled(nu, z) = exp(-|z|) · I_ν(z)`.  The headline benefit:
// at z = 700, I_0(700) ≈ 10^301 (well past float64), but
// IScaled_0(700) ≈ 0.0151 (a perfectly tame O(1/√z)).
//
// We validate two ways:
//   (a) at small z the scaled variant equals exp(-z)·I_ν(z) computed via
//       the unscaled entry (round-trip consistency check),
//   (b) at large z (z = 700) the scaled variant is finite and roughly
//       1/√(2π·700) ≈ 0.01510 — the leading-order asymptotic for
//       e^{-z}·I_0(z) is `1/√(2πz)` (DLMF 10.40.1).

describe("bigBesselIScaled — overflow-safe variant", () => {
  test("IScaled_0(10) = exp(-10) · I_0(10) (round-trip consistency)", () => {
    const z10 = fromString("10", PREC_50DP);
    const scaled = bigBesselIScaled(fromInt(0n, PREC_50DP), z10, PREC_50DP);
    // Compose manually via the unscaled entry.
    const unscaled = bigBesselI(fromInt(0n, PREC_50DP), z10, PREC_50DP);
    const { exp } = require("../../src/transcendental.js") as typeof import("../../src/transcendental.js");
    const { mul } = require("../../src/arithmetic.js") as typeof import("../../src/arithmetic.js");
    const expNegZ = exp(neg(z10), PREC_50DP);
    const composed = mul(unscaled, expNegZ, PREC_50DP);
    // Both should agree to ≥ 48 dp.
    const agreed = digitsAgreeing(toString(scaled, 55), toString(composed, 55));
    expect(agreed).toBeGreaterThanOrEqual(48);
  });

  test("IScaled_0(100) ≈ 0.0399 (finite even though I_0(100) ≈ 1e42)", () => {
    const z100 = fromString("100", PREC_50DP);
    const scaled = bigBesselIScaled(fromInt(0n, PREC_50DP), z100, PREC_50DP);
    const sFloat = toFloat64(scaled).value;
    // e^{-100} · I_0(100) ≈ 0.03992... (Abramowitz & Stegun Table 9.8).
    // Bracket loose enough to absorb any leading-bit rounding.
    expect(sFloat).toBeGreaterThan(0.039);
    expect(sFloat).toBeLessThan(0.041);
  });

  test("IScaled_0(700) ≈ 0.0151 — no overflow at the float64 cliff", () => {
    // At z = 700, exp(z) ≈ 10^304 — at the very edge of float64.
    // I_0(700) ≈ 10^301 — overflows in any naive float64 path.
    // IScaled_0(700) ≈ 1/√(2π·700) ≈ 0.01509 — perfectly representable.
    const z700 = fromString("700", PREC_50DP);
    const scaled = bigBesselIScaled(fromInt(0n, PREC_50DP), z700, PREC_50DP);
    const sFloat = toFloat64(scaled).value;
    // Must be finite, positive, and roughly 0.0151.
    expect(Number.isFinite(sFloat)).toBe(true);
    expect(sFloat).toBeGreaterThan(0.014);
    expect(sFloat).toBeLessThan(0.016);
  });

  test("IScaled_0(0) = I_0(0) = 1 (z=0 fast path)", () => {
    // e^0 · I_0(0) = 1.  Pin the fast-path return.
    const r = bigBesselIScaled(
      fromInt(0n, PREC_50DP),
      fromInt(0n, PREC_50DP),
      PREC_50DP,
    );
    expect(toString(r, 30)).toBe("1.00000000000000000000000000000");
  });
});

// =============================================================================
// 5. Direct primitive tests — exercise each substrate piece
// =============================================================================

describe("bigBesselISeriesMaclaurin — primitive isolation", () => {
  test("agrees with bigBesselI for small z (z=1, ν=0)", () => {
    // In the |z| < 16 lane the dispatcher routes to Maclaurin directly,
    // so the two must agree byte-identically.
    const z = fromString("1", PREC_50DP);
    const nu = fromInt(0n, PREC_50DP);
    const direct = bigBesselISeriesMaclaurin(nu, z, PREC_50DP);
    const viaDispatch = bigBesselI(nu, z, PREC_50DP);
    expect(toString(direct, 50)).toBe(toString(viaDispatch, 50));
  });
});

describe("bigBesselIHankelAsymptotic — primitive isolation", () => {
  test("agrees with bigBesselI in the asymptotic band (z=100, ν=0)", () => {
    // At z=100, prec=200: 2|z|=200 not < prec=200, so the mid-band
    // condition fails and the dispatcher routes to asymptotic.  Direct
    // call must match the dispatch.
    const z = fromString("100", PREC_50DP);
    const nu = fromInt(0n, PREC_50DP);
    const direct = bigBesselIHankelAsymptotic(nu, z, PREC_50DP);
    const viaDispatch = bigBesselI(nu, z, PREC_50DP);
    // Match to ≥ 48 dp.
    expect(digitsAgreeing(toString(direct, 55), toString(viaDispatch, 55)))
      .toBeGreaterThanOrEqual(48);
  });
  test("throws on non-positive z", () => {
    const zNeg = neg(fromString("5", PREC_50DP));
    expect(() => bigBesselIHankelAsymptotic(fromInt(0n, PREC_50DP), zNeg, PREC_50DP))
      .toThrow(/must be positive/);
  });
});

// -----------------------------------------------------------------------------
// bigBesselI — bead m4ut regression coverage (large ν, large z)
// -----------------------------------------------------------------------------
//
// The pre-fix dispatcher routed all `2|z| ≥ prec` calls through
// `bigBesselIHankelAsymptotic`, which is only valid for ν ≪ z. For
// ν ≳ z/2 the asymptotic's term-ratio `(4ν² − (2k−1)²)/(8(k+1)z)`
// grows factorially up to k ≈ ν before decaying, and the optimal-
// truncation point falls inside catastrophic intermediate-term growth.
//
// Canonical regression: `bigBesselI(100, 150, 200)` was returning
// `−1.47e+65` against mpmath `+4.14e+49` — 17 orders of magnitude
// wrong + sign flip. The fix (worklog 170) adds a `ν ≥ 25 → Maclaurin`
// guard at the top of the dispatcher; the Maclaurin series is ULP-
// accurate at any (ν, z) given sufficient working precision.

describe("bigBesselI — bead m4ut large-ν regression (mpmath gold tier)", () => {
  // Reference values from mpmath dps=25.
  type MSample = [number, number, number];
  const SAMPLES: ReadonlyArray<MSample> = [
    [50, 100, 4.8219580855940807e36],
    [100, 150, 4.139322752421548e49],
    [100, 200, 4.352750449727022e74],
    [200, 300, 4.0755371340915294e100],
    [50, 200, 4.003924798366753e82],
  ];
  for (const [nu, z, ref] of SAMPLES) {
    test(`bigBesselI(${nu}, ${z}, 100) ≈ mpmath to ≤ 1e-13`, () => {
      const result = bigBesselI(fromInt(BigInt(nu), 100), fromString(`${z}`, 100), 100);
      const got = toFloat64(result).value;
      const rel = Math.abs(got - ref) / Math.abs(ref);
      expect(rel).toBeLessThan(1e-13);
    });
  }

  test("m4ut point regression: bigBesselI(100, 150) → +4.14e+49 (was −1.47e+65 pre-fix)", () => {
    const result = bigBesselI(fromInt(100n, 100), fromString("150", 100), 100);
    const got = toFloat64(result).value;
    // The canonical fingerprint: sign positive, magnitude ~10^49.
    expect(got).toBeGreaterThan(0); // sign — pre-fix returned negative
    expect(got).toBeGreaterThan(1e49);
    expect(got).toBeLessThan(1e50);
    expect(Math.abs(got - 4.139322752421548e49) / 4.139322752421548e49).toBeLessThan(1e-13);
  });
});
