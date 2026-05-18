// =============================================================================
// bessely.test — bigBesselY + substrate primitives (real-axis arb-prec)
// =============================================================================
//
// Layered validation, following the `besselk.test.ts` template:
//
//   1. Refusal tests: z = 0 (singular) + z < 0 (branch cut) for various
//      ν — bigBesselY throws RangeError with the tagged-class hint in
//      the message.  Mirrors ADR-0003 boundary-failure semantics at
//      the bigfloat-substrate layer.
//
//   2. Special-value spot checks: Y_0(1) ≈ 0.08826, Y_{1/2}(1) =
//      -sqrt(2/π)·cos(1) (closed-form half-integer per DLMF 10.49.1),
//      Y_1(1) ≈ -0.7812, Y_0(10), Y_1(10), Y_2(5).
//
//   3. Golden-master byte-comparison against the Phase 1 Arb oracle
//      (`bench/besselj-anchor/oracles/arb/results.json`) for a
//      representative cross-tier sample (T1/T2/T3/T7 ×
//      integer/half-integer/decimal ν).
//
//   4. Near-integer-ν cancellation-retry tests: ν = 1 + 2^−100 lands
//      within prec bits of integer Y_1 — exercises the L'Hôpital
//      cancellation surface in the connection formula.
//
//   5. Negative-ν parity tests (integer ν only): Y_{-n}(z) =
//      (-1)^n · Y_n(z) per DLMF 10.4.1.
//
// The Arb oracle is gold-tier per ADR-0041 §"Decision 8".  Per the
// ADR-0041 §Decision 8 oracle hierarchy, three-way (Arb + Wolfram +
// mpmath) gold agreement is the cross-validation baseline; this test
// file pins agreement against Arb only — the other gold-tier oracles
// are independently validated in the bench cross-agreement matrix.
//
// Mutation-proving (inline-documented in `bessely.ts`):
//   - M1: swap connection-formula numerator sign — every golden RED.
//   - M2: drop the connection's cancellation-retry — near-integer-ν
//         test fails by ~lossBits − 16 digits.
//   - M3: use ε = 2^−(prec/2 + 16) (quadratic budget) instead of
//         2^−(prec + 32) (linear budget) — integer-ν Y golden tests
//         lose ~prec/2 digits per the I2b worklog 157 lesson.

import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  bigBesselY,
  bigBesselYConnection,
  bigBesselYIntegerNu,
} from "../../src/special-funcs/bessely.js";
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
// `besseli.test.ts` / `besselj.test.ts` / `besselk.test.ts`.  Embedded
// rather than imported to keep the test file self-contained (per the
// Erf shard 131 review pattern).

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
// rounding.  Same precision as `besseli.test.ts` / `besselj.test.ts` /
// `besselk.test.ts` for parity.
const PREC_50DP = 200;

// =============================================================================
// 1. Refusal tests (z = 0 singular; z < 0 branch cut)
// =============================================================================

describe("bigBesselY — refusal at singular / branch-cut inputs", () => {
  test("Y_0(0) refuses with 'y-singular-at-zero' hint", () => {
    expect(() =>
      bigBesselY(fromInt(0n, PREC_50DP), fromInt(0n, PREC_50DP), PREC_50DP),
    ).toThrow(/y-singular-at-zero/);
  });

  test("Y_1(0) refuses with 'y-singular-at-zero' hint", () => {
    expect(() =>
      bigBesselY(fromInt(1n, PREC_50DP), fromInt(0n, PREC_50DP), PREC_50DP),
    ).toThrow(/y-singular-at-zero/);
  });

  test("Y_0(-1) refuses with 'y-branch-cut-on-negative' hint", () => {
    expect(() =>
      bigBesselY(
        fromInt(0n, PREC_50DP),
        neg(fromString("1", PREC_50DP)),
        PREC_50DP,
      ),
    ).toThrow(/y-branch-cut-on-negative/);
  });

  test("Y_{1/2}(-1) refuses with 'y-branch-cut-on-negative' hint", () => {
    const halfNu = (() => {
      const { div } = require("../../src/arithmetic.js") as typeof import("../../src/arithmetic.js");
      const { normalise } = require("../../src/types.js") as typeof import("../../src/types.js");
      const num = fromInt(1n, PREC_50DP + 32);
      const den = fromInt(2n, PREC_50DP + 32);
      const r = div(num, den, PREC_50DP + 32);
      return normalise(r.mantissa, r.exponent, PREC_50DP);
    })();
    expect(() =>
      bigBesselY(halfNu, neg(fromString("1", PREC_50DP)), PREC_50DP),
    ).toThrow(/y-branch-cut-on-negative/);
  });
});

// =============================================================================
// 2. Special-value spot checks
// =============================================================================

describe("bigBesselY — closed-form special values", () => {
  test("Y_0(1) ≈ 0.08826 (classical, Abramowitz & Stegun 9.8.7)", () => {
    const z1 = fromString("1", PREC_50DP);
    const r = bigBesselY(fromInt(0n, PREC_50DP), z1, PREC_50DP);
    const rStr = toString(r, 55);
    // From Arb golden T1-bessely-004: Y_0(1) = 0.08825696421567695...
    const expected =
      "0.08825696421567695798292676602351516282781752309067554671";
    expect(digitsAgreeing(rStr, expected)).toBeGreaterThanOrEqual(48);
  });

  test("Y_{1/2}(1) = -sqrt(2/π) · cos(1) (closed-form half-integer, DLMF 10.49.1)", () => {
    // DLMF 10.49.1: Y_{1/2}(z) = -sqrt(2/(πz)) · cos(z).
    // At z = 1: Y_{1/2}(1) = -sqrt(2/π) · cos(1)
    //                       = -0.7978845608... · 0.5403023058...
    //                       = -0.4310988680...
    const { div } = require("../../src/arithmetic.js") as typeof import("../../src/arithmetic.js");
    const { normalise } = require("../../src/types.js") as typeof import("../../src/types.js");
    const num = fromInt(1n, PREC_50DP + 32);
    const den = fromInt(2n, PREC_50DP + 32);
    const halfRaw = div(num, den, PREC_50DP + 32);
    const halfNu = normalise(halfRaw.mantissa, halfRaw.exponent, PREC_50DP);
    const z1 = fromString("1", PREC_50DP);
    const r = bigBesselY(halfNu, z1, PREC_50DP);
    // From Arb golden T1-bessely-058: Y_{1/2}(1) = -0.4310988680...
    const expected =
      "-0.4310988680183760795205209672985334000880560106886169047";
    const rStr = toString(r, 55);
    expect(digitsAgreeing(rStr, expected)).toBeGreaterThanOrEqual(48);
  });

  test("Y_1(1) ≈ -0.7812 (classical integer-ν value)", () => {
    const z1 = fromString("1", PREC_50DP);
    const r = bigBesselY(fromInt(1n, PREC_50DP), z1, PREC_50DP);
    const rStr = toString(r, 55);
    // From Arb golden T1-bessely-013: Y_1(1) = -0.7812128213002887...
    const expected =
      "-0.7812128213002887165471500000479648205499063907164446078";
    expect(digitsAgreeing(rStr, expected)).toBeGreaterThanOrEqual(48);
  });

  test("Y_0(10) (asymptotic-band integer-ν value)", () => {
    // At z=10 the connection-formula's `J_ν(z)` evaluation is in the
    // J-Maclaurin cancellation band (|z| > 8); the cancellation-retry
    // in `evalJAnyNu`'s call chain must engage.  Y_0(10) is order O(1)
    // — no underflow at this z.
    const z10 = fromString("10", PREC_50DP);
    const r = bigBesselY(fromInt(0n, PREC_50DP), z10, PREC_50DP);
    const rFloat = toFloat64(r).value;
    // Y_0(10) ≈ 0.05567 (DLMF Table); validate order of magnitude.
    expect(rFloat).toBeGreaterThan(0.055);
    expect(rFloat).toBeLessThan(0.057);
  });

  test("Y_1(10) (asymptotic-band integer-ν=1)", () => {
    // Y_1(10) ≈ 0.2490 (Abramowitz & Stegun Table 9.4); validate
    // order of magnitude.  Different ν exercises the asymptotic phase
    // ω = z − νπ/2 − π/4 at a different value.
    const z10 = fromString("10", PREC_50DP);
    const r = bigBesselY(fromInt(1n, PREC_50DP), z10, PREC_50DP);
    const rFloat = toFloat64(r).value;
    expect(rFloat).toBeGreaterThan(0.248);
    expect(rFloat).toBeLessThan(0.25);
  });

  test("Y_2(5) (integer-ν, mid-z transition band)", () => {
    // Y_2(5) ≈ 0.3676 — exercises integer-ν path at z in the
    // J-Maclaurin direct band (|z| < 8) but with non-trivial
    // cancellation in the connection.  Reference Abramowitz & Stegun
    // Table 9.4.
    const z5 = fromString("5", PREC_50DP);
    const r = bigBesselY(fromInt(2n, PREC_50DP), z5, PREC_50DP);
    const rFloat = toFloat64(r).value;
    expect(rFloat).toBeGreaterThan(0.367);
    expect(rFloat).toBeLessThan(0.369);
  });
});

// =============================================================================
// 3. Golden-master byte-comparison against Arb (12 inputs)
// =============================================================================
//
// Curated sample spans T1 small-z + T2 mid-z + T3 large-z + T7 large-ν
// across integer / half-integer / decimal ν.  At PREC_50DP = 200 bits
// the substrate emits ≥ 48 dp agreement against Arb's 55 dp emit.

describe("bigBesselY — golden masters vs Arb gold tier (12 inputs)", () => {
  const arb = loadArbResults();
  const ids = [
    "T1-bessely-004", // ν=0,   z=1     — classical Y_0(1) integer-ν
    "T1-bessely-005", // ν=0,   z=π     — integer-ν, irrational z
    "T1-bessely-007", // ν=0,   z=8     — small-band edge integer-ν
    "T1-bessely-013", // ν=1,   z=1     — integer ν=1
    "T1-bessely-022", // ν=2,   z=1     — integer ν=2 (limit path stress)
    "T1-bessely-058", // ν=1/2, z=1     — half-integer ν (non-integer connection)
    "T1-bessely-067", // ν=3/2, z=1     — half-integer ν=3/2
    "T1-bessely-094", // ν=1.7, z=1     — general-decimal ν
    "T1-bessely-103", // ν=2.3, z=1     — decimal ν > 2
    "T2-bessely-003", // ν=0,   z=20    — past series band, mid-z integer-ν
    "T2-bessely-005", // ν=0,   z=50    — deeper, large-z asymptotic regime
    "T3-bessely-001", // ν=0,   large-z asymptotic regime
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
      const result = bigBesselY(nu, z, PREC_50DP);
      // Y is signed (oscillates), so the sign comparison is load-bearing.
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
// 4. Near-integer-ν cancellation-retry tests
// =============================================================================
//
// When ν is "almost integer" — e.g., ν = 1 + 2^−100 — the connection
// formula loses ~100 bits to L'Hôpital cancellation (because both
// numerator `J_ν cos(νπ) − J_{-ν}` and denominator `sin(νπ)` vanish
// linearly in `(ν − n)`).  The retry harness in `bigBesselYConnection`
// measures the loss and bumps working precision; with prec=200 bits
// we should still land within `prec − cancellation_budget` bits of
// integer Y_n(z).
//
// M2 mutation point: dropping the retry surfaces here — the result
// would have ~p − 100 useful bits, which the agree-to-25-dp check
// detects as a fail.

describe("bigBesselY — near-integer-ν cancellation retry", () => {
  test("Y(1 + 2^-100, 1) agrees with Y_1(1) to ≥ 25 dp", () => {
    const integerY1 = bigBesselY(
      fromInt(1n, PREC_50DP),
      fromString("1", PREC_50DP),
      PREC_50DP,
    );
    // ν = 1 + 2^-100 ≈ 1 + 7.89e-31 — well below 1e-30, exercises the
    // L'Hôpital cancellation budget.
    const eps: BigFloat = { mantissa: 1n, exponent: -100, precision: PREC_50DP };
    const { add } = require("../../src/arithmetic.js") as typeof import("../../src/arithmetic.js");
    const nu = add(fromInt(1n, PREC_50DP), eps, PREC_50DP);
    const nearIntegerY = bigBesselY(nu, fromString("1", PREC_50DP), PREC_50DP);
    // Y_ν is continuous in ν away from integer-ν singularities; at
    // ν = n + ε the result agrees with Y_n to within the continuity
    // bound `|ε · ∂Y/∂ν|` ≈ ε · O(1).  ε = 2^-100 ≈ 30 decimal digits;
    // we require ≥ 25 dp as a safety margin against the prec floor.
    const agreed = digitsAgreeing(
      toString(nearIntegerY, 35),
      toString(integerY1, 35),
    );
    expect(agreed).toBeGreaterThanOrEqual(25);
  });

  test("Y(2 + 2^-80, 3) agrees with Y_2(3) to ≥ 20 dp", () => {
    // Larger eps (2^-80 ≈ 8.27e-25), at a different (ν, z) point.
    // Exercises the retry harness against a different J series regime
    // (z = 3 is in the J-Maclaurin direct band, ν = 2 is integer-near).
    const integerY2 = bigBesselY(
      fromInt(2n, PREC_50DP),
      fromString("3", PREC_50DP),
      PREC_50DP,
    );
    const eps: BigFloat = { mantissa: 1n, exponent: -80, precision: PREC_50DP };
    const { add } = require("../../src/arithmetic.js") as typeof import("../../src/arithmetic.js");
    const nu = add(fromInt(2n, PREC_50DP), eps, PREC_50DP);
    const nearIntegerY = bigBesselY(nu, fromString("3", PREC_50DP), PREC_50DP);
    // ε = 2^-80 ≈ 24 dp; ∂Y_2/∂ν(z=3) is O(1); agree to ≥ 20 dp.
    const agreed = digitsAgreeing(
      toString(nearIntegerY, 30),
      toString(integerY2, 30),
    );
    expect(agreed).toBeGreaterThanOrEqual(20);
  });
});

// =============================================================================
// 5. Negative-integer-ν parity (DLMF 10.4.1)
// =============================================================================

describe("bigBesselY — negative-integer-ν parity Y_{-n}(z) = (-1)^n Y_n(z)", () => {
  test("Y_{-1}(1) = -Y_1(1) (n=1, odd parity → sign flip)", () => {
    const z1 = fromString("1", PREC_50DP);
    const yPos = bigBesselY(fromInt(1n, PREC_50DP), z1, PREC_50DP);
    const yNeg = bigBesselY(fromInt(-1n, PREC_50DP), z1, PREC_50DP);
    // Y_{-1}(1) = -Y_1(1) per DLMF 10.4.1 with n=1 (odd).
    expect(toString(yNeg, 50)).toBe(toString(neg(yPos), 50));
  });

  test("Y_{-2}(1) = Y_2(1) (n=2, even parity → same sign)", () => {
    const z1 = fromString("1", PREC_50DP);
    const yPos = bigBesselY(fromInt(2n, PREC_50DP), z1, PREC_50DP);
    const yNeg = bigBesselY(fromInt(-2n, PREC_50DP), z1, PREC_50DP);
    expect(toString(yNeg, 50)).toBe(toString(yPos, 50));
  });
});

// =============================================================================
// 6. Direct primitive tests — exercise each substrate piece
// =============================================================================

describe("bigBesselYConnection — primitive isolation", () => {
  test("agrees with bigBesselY for non-integer ν (ν=1/2, z=1)", () => {
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
    const direct = bigBesselYConnection(halfNu, z1, PREC_50DP);
    const viaDispatch = bigBesselY(halfNu, z1, PREC_50DP);
    expect(toString(direct, 50)).toBe(toString(viaDispatch, 50));
  });

  test("refuses integer ν (gate is upstream in bigBesselY)", () => {
    // Calling Connection directly with integer ν must fail loudly —
    // the dispatcher is the only legitimate caller, and it routes
    // integer ν elsewhere.
    expect(() =>
      bigBesselYConnection(
        fromInt(2n, PREC_50DP),
        fromString("1", PREC_50DP),
        PREC_50DP,
      ),
    ).toThrow(/integer/);
  });
});

describe("bigBesselYIntegerNu — primitive isolation", () => {
  test("agrees with bigBesselY for integer ν (n=1, z=1)", () => {
    // Integer ν routes through bigBesselYIntegerNu via the dispatcher;
    // direct call must match.
    const z1 = fromString("1", PREC_50DP);
    const direct = bigBesselYIntegerNu(1, z1, PREC_50DP);
    const viaDispatch = bigBesselY(fromInt(1n, PREC_50DP), z1, PREC_50DP);
    expect(toString(direct, 50)).toBe(toString(viaDispatch, 50));
  });

  test("agrees with bigBesselY for integer ν=0 (Y_0(1))", () => {
    // ν=0 is the most-cancellation-prone integer case in the limit-via-ε
    // path because the connection formula's `sin(νπ)` factor is the
    // load-bearing denominator near ν=0 too (sin(ε·π) → 0 as ε → 0).
    const z1 = fromString("1", PREC_50DP);
    const direct = bigBesselYIntegerNu(0, z1, PREC_50DP);
    const viaDispatch = bigBesselY(fromInt(0n, PREC_50DP), z1, PREC_50DP);
    expect(toString(direct, 50)).toBe(toString(viaDispatch, 50));
  });
});
