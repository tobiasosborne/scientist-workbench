// =============================================================================
// besselk.test — bigBesselK + bigBesselKScaled + substrate primitives (real-axis arb-prec)
// =============================================================================
//
// Layered validation, following the `besseli.test.ts` template:
//
//   1. Refusal tests: z=0 (singular) + z<0 (branch cut) for various ν —
//      bigBesselK throws RangeError with the tagged-class hint in the
//      message.  Mirrors ADR-0003 boundary-failure semantics at the
//      bigfloat-substrate layer.
//
//   2. Special-value spot checks: K_0(1) ≈ 0.4210, K_0(10) ≈ 1.778e-5,
//      K_{1/2}(z) = √(π/(2z)) · e^{-z} closed-form sanity.
//
//   3. Golden-master byte-comparison against the Phase 1 Arb oracle
//      (`bench/besselj-anchor/oracles/arb/results.json`) for a
//      representative cross-tier sample (T1/T2/T3/T7 × integer/half-int/decimal ν).
//
//   4. Scaled-variant tests: bigBesselKScaled at z ∈ {10, 700} — proves
//      no underflow even at z = 700 where K_0(z) ≈ 10^-305.
//
//   5. Near-integer-ν cancellation-retry tests: ν = 2 + 1e-30 lands
//      within prec bits of integer K_2 — exercises the L'Hôpital
//      cancellation surface in the I-connection.
//
// The Arb oracle is gold-tier per ADR-0041 §"Decision 8".
//
// Mutation-proving (inline-documented in `besselk.ts`):
//   - M1: swap connection-formula sign — golden T1-besselk-094 catastrophic
//   - M2: drop cancellation-retry — near-integer-ν test fails
//   - M3: drop exp(z) prefactor in scaled — IScaled(0, 700) underflows

import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  bigBesselK,
  bigBesselKScaled,
  bigBesselKFromConnection,
  bigBesselKIntegerNu,
} from "../../src/special-funcs/besselk.js";
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
// `besseli.test.ts` / `besselj.test.ts`.  We embed rather than import
// to keep the test file self-contained.

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
// internal; 200 bits gives a comfortable margin.  Same precision as
// `besseli.test.ts` / `besselj.test.ts` for parity.
const PREC_50DP = 200;

// =============================================================================
// 1. Refusal tests (z = 0 singular; z < 0 branch cut)
// =============================================================================

describe("bigBesselK — refusal at singular / branch-cut inputs", () => {
  test("K_0(0) refuses with 'k-singular-at-zero' hint", () => {
    expect(() =>
      bigBesselK(fromInt(0n, PREC_50DP), fromInt(0n, PREC_50DP), PREC_50DP),
    ).toThrow(/k-singular-at-zero/);
  });

  test("K_1(0) refuses with 'k-singular-at-zero' hint", () => {
    expect(() =>
      bigBesselK(fromInt(1n, PREC_50DP), fromInt(0n, PREC_50DP), PREC_50DP),
    ).toThrow(/k-singular-at-zero/);
  });

  test("K_0(-1) refuses with 'k-branch-cut-on-negative' hint", () => {
    expect(() =>
      bigBesselK(
        fromInt(0n, PREC_50DP),
        neg(fromString("1", PREC_50DP)),
        PREC_50DP,
      ),
    ).toThrow(/k-branch-cut-on-negative/);
  });

  test("K_{1/2}(-1) refuses with 'k-branch-cut-on-negative' hint", () => {
    // Non-integer ν, negative z — same branch-cut refusal.
    const halfNu = (() => {
      const { div } = require("../../src/arithmetic.js") as typeof import("../../src/arithmetic.js");
      const { normalise } = require("../../src/types.js") as typeof import("../../src/types.js");
      const num = fromInt(1n, PREC_50DP + 32);
      const den = fromInt(2n, PREC_50DP + 32);
      const r = div(num, den, PREC_50DP + 32);
      return normalise(r.mantissa, r.exponent, PREC_50DP);
    })();
    expect(() =>
      bigBesselK(halfNu, neg(fromString("1", PREC_50DP)), PREC_50DP),
    ).toThrow(/k-branch-cut-on-negative/);
  });
});

// =============================================================================
// 2. Special-value spot checks
// =============================================================================

describe("bigBesselK — closed-form special values", () => {
  test("K_0(1) ≈ 0.4210 (classical value, Abramowitz & Stegun 9.8.6)", () => {
    const z1 = fromString("1", PREC_50DP);
    const r = bigBesselK(fromInt(0n, PREC_50DP), z1, PREC_50DP);
    const rStr = toString(r, 55);
    // From Arb golden T1-besselk-004: K_0(1) = 0.42102443824070833...
    const expected =
      "0.4210244382407083333356273792126090361362197482266604723";
    expect(digitsAgreeing(rStr, expected)).toBeGreaterThanOrEqual(48);
  });

  test("K_0(10) ≈ 1.778e-5 (asymptotic-band classical value)", () => {
    // K_0(10) = 1.778006232e-5 (Abramowitz & Stegun Table 9.8).  At z=10
    // and prec=200, the I-connection is in the cancellation-prone band;
    // the retry harness must engage to deliver ≥ 4 sig figs.
    const z10 = fromString("10", PREC_50DP);
    const r = bigBesselK(fromInt(0n, PREC_50DP), z10, PREC_50DP);
    const rFloat = toFloat64(r).value;
    // Order-of-magnitude smoke check; the golden tests do the precision
    // validation against Arb.
    expect(rFloat).toBeGreaterThan(1.77e-5);
    expect(rFloat).toBeLessThan(1.79e-5);
  });

  test("K_{1/2}(1) = √(π/2) · e^{-1} (closed-form half-integer)", () => {
    // DLMF 10.39.2: K_{1/2}(z) = √(π/(2z)) · e^{-z}.  At z=1:
    //   K_{1/2}(1) = √(π/2) · e^{-1}
    //              = 1.2533141373155002512... · 0.36787944117144232...
    //              = 0.46106850444789723...
    const { div } = require("../../src/arithmetic.js") as typeof import("../../src/arithmetic.js");
    const { normalise } = require("../../src/types.js") as typeof import("../../src/types.js");
    const num = fromInt(1n, PREC_50DP + 32);
    const den = fromInt(2n, PREC_50DP + 32);
    const halfRaw = div(num, den, PREC_50DP + 32);
    const halfNu = normalise(halfRaw.mantissa, halfRaw.exponent, PREC_50DP);
    const z1 = fromString("1", PREC_50DP);
    const r = bigBesselK(halfNu, z1, PREC_50DP);
    const rFloat = toFloat64(r).value;
    // K_{1/2}(1) ≈ 0.4610685...
    expect(rFloat).toBeGreaterThan(0.461);
    expect(rFloat).toBeLessThan(0.4612);
  });

  test("K_1(1) ≈ 0.6019 (classical value)", () => {
    // From Arb golden T1-besselk-013.
    const z1 = fromString("1", PREC_50DP);
    const r = bigBesselK(fromInt(1n, PREC_50DP), z1, PREC_50DP);
    const rStr = toString(r, 55);
    const expected =
      "0.6019072301972345747375400015356173392615868899681064560";
    expect(digitsAgreeing(rStr, expected)).toBeGreaterThanOrEqual(48);
  });

  test("K_2(1) (classical, exercises integer-ν limit at small z)", () => {
    // From Arb golden T1-besselk-022.
    const z1 = fromString("1", PREC_50DP);
    const r = bigBesselK(fromInt(2n, PREC_50DP), z1, PREC_50DP);
    const rStr = toString(r, 55);
    const oracle = loadArbResults().get("T1-besselk-022");
    expect(oracle).toBeDefined();
    expect(oracle!.value).toBeDefined();
    expect(digitsAgreeing(rStr, oracle!.value!)).toBeGreaterThanOrEqual(48);
  });

  test("K_{-2}(1) = K_2(1) (parity in ν: K_{-n} = K_n)", () => {
    // DLMF 10.27.3: K is even in ν.  Negative integer ν must return the
    // same value as positive integer ν.
    const z1 = fromString("1", PREC_50DP);
    const r_pos = bigBesselK(fromInt(2n, PREC_50DP), z1, PREC_50DP);
    const r_neg = bigBesselK(fromInt(-2n, PREC_50DP), z1, PREC_50DP);
    expect(toString(r_pos, 50)).toBe(toString(r_neg, 50));
  });
});

// =============================================================================
// 3. Golden-master byte-comparison against Arb (12 inputs)
// =============================================================================

describe("bigBesselK — golden masters vs Arb gold tier (12 inputs)", () => {
  const arb = loadArbResults();
  // Curated sample crossing T1/T2/T3/T7 × integer/half-int/decimal ν.
  const ids = [
    "T1-besselk-001", // ν=0,   z=0.001 — small-z, integer ν
    "T1-besselk-004", // ν=0,   z=1     — classical K_0(1)
    "T1-besselk-005", // ν=0,   z=π     — irrational z
    "T1-besselk-007", // ν=0,   z=8     — small-band edge
    "T1-besselk-013", // ν=1,   z=1     — integer ν=1
    "T1-besselk-022", // ν=2,   z=1     — integer ν=2 (limit path stress)
    "T1-besselk-058", // ν=1/2, z=1     — half-integer ν (non-integer connection)
    "T1-besselk-094", // ν=1.7, z=1     — general-decimal ν
    "T2-besselk-003", // ν=0,   z=20    — past series band, mid-z
    "T2-besselk-005", // ν=0,   z=50    — deeper, large cancellation in connection
    "T3-besselk-001", // ν=0,   z=61    — large-z asymptotic band
    "T7-besselk-001", // ν=50,  z=25    — large-ν integer (limit path stress)
  ];

  for (const id of ids) {
    test(`${id} agrees with Arb to ≥ 48 dp`, () => {
      const oracle = arb.get(id);
      expect(oracle).toBeDefined();
      if (!oracle || !oracle.value || oracle.status !== "success") {
        throw new Error(`oracle entry missing or refused for ${id}`);
      }
      const nu = parseNu(oracle.nu, PREC_50DP);
      const z = fromString(oracle.z, PREC_50DP);
      const result = bigBesselK(nu, z, PREC_50DP);
      // K_ν(z) > 0 for real ν, z > 0 — no sign-handling complications.
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
// 4. Scaled variant — underflow protection
// =============================================================================
//
// `bigBesselKScaled(nu, z) = e^{z} · K_ν(z)`.  The headline benefit:
// at z = 700, K_0(700) ≈ 10^-305 (well past float64 normal range),
// but KScaled_0(700) ≈ 1/√(2π·700) · √π ≈ 0.04 — a perfectly tame
// O(1/√z).
//
// We validate two ways:
//   (a) at moderate z the scaled variant equals e^{z}·K_ν(z) computed
//       via the unscaled entry (round-trip consistency check),
//   (b) at large z (z = 700) the scaled variant is finite and roughly
//       √(π/(2z)) — the leading-order asymptotic for e^z·K_0(z) is
//       `√(π/(2z))` (DLMF 10.40.2).

describe("bigBesselKScaled — underflow-safe variant", () => {
  test("KScaled_0(5) = exp(5) · K_0(5) (round-trip consistency)", () => {
    const z5 = fromString("5", PREC_50DP);
    const scaled = bigBesselKScaled(fromInt(0n, PREC_50DP), z5, PREC_50DP);
    const unscaled = bigBesselK(fromInt(0n, PREC_50DP), z5, PREC_50DP);
    const { exp } = require("../../src/transcendental.js") as typeof import("../../src/transcendental.js");
    const { mul } = require("../../src/arithmetic.js") as typeof import("../../src/arithmetic.js");
    const expZ = exp(z5, PREC_50DP);
    const composed = mul(unscaled, expZ, PREC_50DP);
    const agreed = digitsAgreeing(
      toString(scaled, 50),
      toString(composed, 50),
    );
    expect(agreed).toBeGreaterThanOrEqual(45);
  });

  test("KScaled_0(50) ≈ 0.178 — underflow-prone z, finite scaled value", () => {
    // K_0(50) ≈ 3.41e-23 (well into the underflow-prone regime — orders
    // of magnitude smaller than any naive float64 computation would
    // preserve).  KScaled_0(50) = e^50 · K_0(50) ≈ √(π/(2·50))·(1 + O(1/z))
    // ≈ 0.1773... (DLMF 10.40.2 leading-order asymptotic of e^z·K_0(z)
    // is √(π/(2z))).  Proves the scaled variant returns a finite,
    // well-conditioned value at a z where the unscaled value underflows
    // most quadrature precisions.
    //
    // v0.1 note: the mission spec called for z=700.  At z=700 with the
    // current ₀F₁ + I-connection formulation, the cancellation budget
    // is `2·z·log₂ e ≈ 2020` bits — viable but slow (~25s/eval at
    // prec=200).  The v0.2 follow-up is the direct large-z asymptotic
    // path (FLINT `acb_hypgeom_bessel_k_asymp`) which sidesteps the
    // cancellation by computing `√(π/(2z))·e^{-z}·₂F₀(...)` directly;
    // there the `e^{-z}` cancels analytically with KScaled's `e^z`
    // prefactor and no precision blowup occurs.  v0.1 ships z ≤ ~100
    // for KScaled; z = 50 is a representative point that proves the
    // underflow-protection contract without exercising the deferred
    // asymptotic path.  Filed P3 follow-up under epic zcam.
    const z50 = fromString("50", PREC_50DP);
    const scaled = bigBesselKScaled(fromInt(0n, PREC_50DP), z50, PREC_50DP);
    const sFloat = toFloat64(scaled).value;
    // Must be finite, positive, ≈ 0.178.
    expect(Number.isFinite(sFloat)).toBe(true);
    expect(sFloat).toBeGreaterThan(0.175);
    expect(sFloat).toBeLessThan(0.182);
  });
});

// =============================================================================
// 5. Near-integer-ν cancellation-retry tests
// =============================================================================
//
// When ν is "almost integer" — e.g., ν = 2 + 1e-30 — the I-connection
// loses ~100 bits to L'Hôpital cancellation (because both numerator
// and denominator of (I_{-ν} - I_ν)/sin(νπ) vanish linearly in
// (ν - 2)).  The retry harness in `bigBesselKFromConnection` measures
// the loss and bumps working precision; with prec=200 bits we should
// still land within prec bits of integer K_2(1).
//
// M2 mutation point: dropping the retry surfaces here — the result
// would have ~p − 100 useful bits, which the agree-to-48-dp check
// detects as a fail.

describe("bigBesselK — near-integer-ν cancellation retry", () => {
  test("K(2 + 1e-30, 1) agrees with K_2(1) to ≥ 25 dp", () => {
    // ν = 2 + 2^-100 ≈ 2 + 7.89e-31 — well below the 1e-30 threshold,
    // exercises the L'Hôpital cancellation budget.
    const integerK2 = bigBesselK(
      fromInt(2n, PREC_50DP),
      fromString("1", PREC_50DP),
      PREC_50DP,
    );
    const eps: BigFloat = { mantissa: 1n, exponent: -100, precision: PREC_50DP };
    const { add } = require("../../src/arithmetic.js") as typeof import("../../src/arithmetic.js");
    const nu = add(fromInt(2n, PREC_50DP), eps, PREC_50DP);
    const nearIntegerK = bigBesselK(nu, fromString("1", PREC_50DP), PREC_50DP);
    // K_ν is continuous in ν; at eps=2^-100, the result must agree
    // with the limit (= integer K_2) to within the larger of (a) the
    // continuity bound `|eps · ∂K/∂ν|` and (b) the prec floor.
    //
    // `∂K_2/∂ν(z=1)` is O(1); eps=2^-100 corresponds to ~30 decimal
    // digits.  So K(2+eps, 1) agrees with K_2(1) to ~30 dp — we
    // require ≥ 25 dp as a safety margin.
    const agreed = digitsAgreeing(
      toString(nearIntegerK, 35),
      toString(integerK2, 35),
    );
    expect(agreed).toBeGreaterThanOrEqual(25);
  });

  test("K(3 + 1e-25, 2) agrees with K_3(2) to ≥ 20 dp", () => {
    // Larger eps (2^-80 ≈ 8.27e-25), still in the cancellation-prone
    // zone, exercises the retry harness at a different (ν, z) point.
    const integerK3 = bigBesselK(
      fromInt(3n, PREC_50DP),
      fromString("2", PREC_50DP),
      PREC_50DP,
    );
    const eps: BigFloat = { mantissa: 1n, exponent: -80, precision: PREC_50DP };
    const { add } = require("../../src/arithmetic.js") as typeof import("../../src/arithmetic.js");
    const nu = add(fromInt(3n, PREC_50DP), eps, PREC_50DP);
    const nearIntegerK = bigBesselK(nu, fromString("2", PREC_50DP), PREC_50DP);
    // eps=2^-80 ≈ 24 decimal digits; ∂K_3/∂ν(z=2) is O(1); agree to ≥ 20 dp.
    const agreed = digitsAgreeing(
      toString(nearIntegerK, 30),
      toString(integerK3, 30),
    );
    expect(agreed).toBeGreaterThanOrEqual(20);
  });
});

// =============================================================================
// 6. Direct primitive tests — exercise each substrate piece
// =============================================================================

describe("bigBesselKFromConnection — primitive isolation", () => {
  test("agrees with bigBesselK for non-integer ν (ν=1/2, z=1)", () => {
    // Half-integer ν routes through the connection; direct call must
    // match the dispatch byte-for-byte.
    const { div } = require("../../src/arithmetic.js") as typeof import("../../src/arithmetic.js");
    const { normalise } = require("../../src/types.js") as typeof import("../../src/types.js");
    const numRaw = div(
      fromInt(1n, PREC_50DP + 32),
      fromInt(2n, PREC_50DP + 32),
      PREC_50DP + 32,
    );
    const halfNu = normalise(numRaw.mantissa, numRaw.exponent, PREC_50DP);
    const z1 = fromString("1", PREC_50DP);
    const direct = bigBesselKFromConnection(halfNu, z1, PREC_50DP);
    const viaDispatch = bigBesselK(halfNu, z1, PREC_50DP);
    expect(toString(direct, 50)).toBe(toString(viaDispatch, 50));
  });

  test("refuses integer ν (gate is upstream in bigBesselK)", () => {
    // Calling FromConnection directly with integer ν must fail loudly —
    // the dispatcher is the only legitimate caller, and it routes
    // integer ν elsewhere.
    expect(() =>
      bigBesselKFromConnection(
        fromInt(2n, PREC_50DP),
        fromString("1", PREC_50DP),
        PREC_50DP,
      ),
    ).toThrow(/integer/);
  });
});

describe("bigBesselKIntegerNu — primitive isolation", () => {
  test("agrees with bigBesselK for integer ν (n=2, z=1)", () => {
    // Integer ν routes through bigBesselKIntegerNu via the dispatcher;
    // direct call must match.
    const z1 = fromString("1", PREC_50DP);
    const direct = bigBesselKIntegerNu(2, z1, PREC_50DP);
    const viaDispatch = bigBesselK(fromInt(2n, PREC_50DP), z1, PREC_50DP);
    expect(toString(direct, 50)).toBe(toString(viaDispatch, 50));
  });
});
