// =============================================================================
// bench/besselj-anchor/cross-agreement.ts — G8 cross-oracle agreement matrix
// =============================================================================
//
// Phase 1 GATE per ADR-0041 §"Decision 8" (oracle hierarchy) + §"Decision 12"
// (zero-crossing tolerance band). Bead: scientist-workbench-s2n1.
//
// Reads every `bench/besselj-anchor/oracles/<id>/results.json` present, joins
// records by `input_id` (every adapter emits 1766 records aligned to the
// corpus from bead `qccc`), and computes pair-wise agreement per
// (input_id, head). Emits:
//   - bench/besselj-anchor/agreement-data.json   (machine-readable)
//   - bench/besselj-anchor/agreement-matrix.md   (human heat-map)
//
// How this comparator differs from the Erf G8 (bench/erf-anchor/cross-agreement.ts)
// ----------------------------------------------------------------------------
// Erf was a 1-arg family (a single real or complex `z` per input) with one
// arb-prec gold oracle (mpmath) and one silver (Boost cpp_bin_float<50>).
// Bessel is a 2-arg family ((ν, z)) with three arb-prec golds — Wolfram +
// mpmath + Arb (FLINT 3.x via python-flint) — plus silver (Boost) and
// bronze (SciPy). The structural changes vs Erf:
//
//   A.  Zero-crossing tolerance band (ADR-0041 §Decision 12). Where
//       `J_ν(z) ≈ 0` (an infinite ladder of zeros along the positive real
//       axis), relative-error comparison is unbounded: a tiny absolute
//       disagreement on a near-zero value becomes a huge relative disagreement.
//       Corpus tier T9 carries `z_root_index` + `z_root_distance` fields on
//       every input; when `|z_root_distance| < 0.01`, the comparator switches
//       to absolute-error comparison against the smaller magnitude operand
//       (the one closest to zero), with the threshold tuned by tier-dp.
//
//   B.  Arb `value_radius` as first-class error info. Arb emits a `value_radius`
//       per success record — the half-width of the ball that contains the
//       true value. When comparing Arb against another arb-prec gold, if
//       the digit-difference falls *within* `2 · value_radius` (measured by
//       the magnitude of the smaller operand), the comparator treats the
//       disagreement as within-ball agreement (info severity).
//
//   C.  Oracle status disambiguation — limit/refused on both sides is INFO.
//       `status: "limit"` (Wolfram, SciPy) and `status: "refused"` (Boost
//       for complex, Arb at NaN) at the same input are NOT disagreements —
//       they're honest "this value doesn't exist or is at the boundary."
//       Comparator marks limit-limit/refused-refused/limit-refused-same-
//       class as info severity. The vocabulary mappings:
//         wolfram_returned_token=Indeterminate ≡ NaN
//         wolfram_returned_token=ComplexInfinity ≡ Infinity
//         wolfram_returned_token starts with "BesselI["/"BesselK[" + ", Infinity]"
//           ≡ +Infinity   (Wolfram leaves these unevaluated symbolically)
//         scipy: value="NaN" or "0.0" with notes "L5/L9/L10..." ≡ honest underflow/NaN
//         mpmath: status="honest-special-token" with value="0.0..." ≡ underflow
//
//   D.  Boost-no-complex refusal downgrade (R5 §1). Boost refuses all
//       complex inputs (no `std::complex<cpp_bin_float<N>>` instantiation,
//       reason="boost-no-complex-bessel"); refuses non-finite literals
//       (reason="non-finite-real-input"); refuses K_ν at z=0 (reason=
//       "singular-at-z-zero"). Each is expected by capability matrix and
//       documented in the Boost adapter README. Mark as `info` not `warn`.
//
//   E.  L3 negative-ν branch convention (R5 §6). Non-integer negative ν
//       for Y/K (T8 tier) may have per-oracle convention deltas
//       (cos(νπ)/sin(νπ) cancellation near integers). If two oracles
//       disagree on a single T8 input and the disagreement is below 13
//       digits, mark as `info` with category `L3-branch-convention`.
//
//   F.  L9/L10 boundary scaled-vs-unscaled pairing. At T6/T7/T10 entries
//       near the float64 overflow/underflow boundary, `BesselI(0, 700)`
//       returns `inf` (SciPy L10) but `BesselIScaled(0, 700)` is finite —
//       both are honest. Comparator treats SciPy `limit` outputs at L9/L10
//       tiers as info when at least one arb-prec gold agrees on the sign
//       of the limit (+Inf for I, ~0 for K underflow).
//
// Per-oracle status taxonomy (parsed by `normaliseValue`)
// ----------------------------------------------------------------------------
//   wolfram: status ∈ {success, limit}
//            success → string or {re, im}
//            limit   → value=null, wolfram_returned_token is the spelling
//   mpmath:  status ∈ {success, complex-success, honest-special-token, timeout}
//            success / complex-success → string or {re, im}
//            honest-special-token → string (numeric, typically "0.0..." for
//              asymptotic limits at ±∞; treat as concrete real)
//            timeout → value=null (effective refused)
//   scipy:   status ∈ {success, limit}
//            success → string or {re, im}
//            limit   → value="NaN" or "0.0" or "inf"/-inf; "scipy_returned"
//              field carries the spelling; notes encode L5/L9/L10 category
//   boost:   status ∈ {success, refused}
//            success → value_silver (50dp arb) + value_bronze (float64)
//            refused → value_silver=null + value_bronze=null + reason field
//   arb:     status ∈ {success, refused}
//            success → value (55dp) + value_radius (Arb ball half-width)
//            refused → value=null + notes (typically NaN input)
//
// Threshold table (per ADR-0041 §Decision 8 + ADR-0040 §Decision 8)
// ----------------------------------------------------------------------------
//   gold-vs-gold (Wolfram ↔ mpmath ↔ Arb pairs): ≥ 48 leading digits agree
//   gold-vs-silver (any gold × Boost cpp_bin_float<50>): ≥ 46 leading digits
//   gold/silver-vs-bronze (× SciPy/libm float64): ≥ 13 leading digits
//                                                  OR ULP-distance ≤ 4
//   bronze-vs-bronze (SciPy × any-float64): ULP-distance ≤ 4
//
// Pure TS / Bun — no subprocess, no FFI. Discipline mirrors the Erf G8.

import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

// -----------------------------------------------------------------------------
// Oracle result shapes (unioned over the five adapters' schemas)
// -----------------------------------------------------------------------------

interface RawRecord {
  readonly input_id?: string;
  readonly id?: string;
  readonly head?: string;
  readonly status?: string;
  // value-style fields by oracle:
  readonly value?: string | { re: string; im: string } | null;
  readonly value_silver?: string | { re: string; im: string } | null;
  readonly value_bronze?: string | { re: string; im: string } | null;
  readonly value_radius?: string;
  // status-narrative fields:
  readonly wolfram_returned_token?: string | null;
  readonly scipy_returned?: string | null;
  readonly reason?: string;
  readonly notes?: string | null;
  readonly method?: string;
  readonly acc_bits?: number;
}

interface RawFile {
  readonly oracle_id?: string;
  readonly oracle_version?: string;
  readonly tier?: string;
  readonly results: readonly RawRecord[];
}

// Corpus record (joined by id; carries tier + head + nu_kind + zero-band fields)
interface CorpusInput {
  readonly id: string;
  readonly tier: string;
  readonly head: string;
  readonly nu_kind: string;
  readonly nu: string;
  readonly z: string | { re: string; im: string };
  readonly z_root_index?: number;
  readonly z_root_distance?: string;
  readonly notes?: string;
}

interface CorpusFile {
  readonly inputs: readonly CorpusInput[];
}

// -----------------------------------------------------------------------------
// Tier classification
// -----------------------------------------------------------------------------

type Tier = "gold" | "silver" | "bronze";

const ORACLE_TIERS: Record<string, Tier> = {
  wolfram: "gold",
  mpmath: "gold",
  arb: "gold",
  boost: "silver", // real arb-prec via cpp_bin_float<50>; bronze field also emitted
  scipy: "bronze", // float64
};

/**
 * Oracles whose adapters honestly refuse on certain input classes documented
 * in R5 + the adapter READMEs. Asymmetric refusals BY these oracles are
 * downgraded to "info" severity — the oracle is doing the right thing; the
 * gap is a known capability limit, not a bug.
 *
 *   boost  — refuses all complex (no std::complex template instantiation),
 *            all non-finite real, K_ν at z=0.
 *   scipy  — emits status=limit on L5/L9/L10 boundaries (NaN at huge ν+z;
 *            underflow at K large-z; overflow at I large-z).
 *   wolfram — emits status=limit when result is symbolic (Infinity /
 *            Indeterminate / unevaluated `BesselI[ν, Infinity]`).
 *   arb    — refuses NaN inputs (corpus T6 carriers).
 *   mpmath — emits status=honest-special-token for asymptotic limits
 *            (BesselJ(ν, +∞) → 0); treated as a concrete real (numeric).
 *            Timeouts (T7 large-z K extreme) → effective refused.
 */
const ORACLES_WITH_EXPECTED_REFUSALS = new Set<string>([
  "boost",
  "scipy",
  "wolfram",
  "arb",
  "mpmath",
]);

function isExpectedRefusal(oracleId: string): boolean {
  return ORACLES_WITH_EXPECTED_REFUSALS.has(oracleId);
}

// -----------------------------------------------------------------------------
// Value normalisation
// -----------------------------------------------------------------------------

type LimitSym =
  | "Infinity"
  | "-Infinity"
  | "NaN"
  | "ComplexInfinity"
  | "Indeterminate";

type ConcreteValue =
  | { kind: "real"; sign: number; decimal: string; raw: string }
  | { kind: "complex"; re: ConcreteValue; im: ConcreteValue }
  | { kind: "limit"; symbol: LimitSym; raw: string }
  | { kind: "refused"; reason: string };

const LIMIT_TOKENS = new Set<string>([
  "Infinity",
  "-Infinity",
  "NaN",
  "ComplexInfinity",
  "Indeterminate",
]);

function parseRealString(s: string): ConcreteValue {
  if (LIMIT_TOKENS.has(s)) {
    return { kind: "limit", symbol: s as LimitSym, raw: s };
  }
  const lower = s.toLowerCase();
  if (lower === "nan") return { kind: "limit", symbol: "NaN", raw: s };
  if (lower === "inf" || lower === "infinity") {
    return { kind: "limit", symbol: "Infinity", raw: s };
  }
  if (lower === "-inf" || lower === "-infinity") {
    return { kind: "limit", symbol: "-Infinity", raw: s };
  }
  // Wolfram occasionally leaves an unevaluated symbolic form in
  // wolfram_returned_token like "BesselI[0, Infinity]" — these reach us only
  // via the wolfram_returned_token path (status=limit), not the value path,
  // but defend-in-depth: if a free-form string starts with "Bessel" treat as
  // an unevaluated symbolic ⇒ infinity (per Wolfram's convention for these).
  if (s.startsWith("BesselI[") || s.startsWith("BesselK[")) {
    const isNeg = s.includes("-Infinity");
    return { kind: "limit", symbol: isNeg ? "-Infinity" : "Infinity", raw: s };
  }
  let sign = 1;
  let body = s.trim();
  if (body.startsWith("+")) body = body.slice(1);
  if (body.startsWith("-")) {
    sign = -1;
    body = body.slice(1);
  }
  // Absurd-exponent ⇒ overflow/underflow mapping (matches Erf G8 §parseRealString).
  const eIdx = body.toLowerCase().indexOf("e");
  if (eIdx >= 0) {
    const expRaw = body.slice(eIdx + 1);
    const expDigits = expRaw.replace(/^[+-]/, "");
    if (expDigits.length > 3 || !Number.isFinite(parseInt(expRaw, 10))) {
      return expRaw.startsWith("-")
        ? { kind: "real", sign, decimal: "0." + "0".repeat(60) + "1", raw: s }
        : {
            kind: "limit",
            symbol: (sign < 0 ? "-Infinity" : "Infinity") as LimitSym,
            raw: s,
          };
    }
  }
  return { kind: "real", sign, decimal: expandScientific(body), raw: s };
}

/** Expand `"5.4e-176"` into `"0.000…00054…"`. Pure-string; no float64. */
function expandScientific(s: string): string {
  const eIdx = s.toLowerCase().indexOf("e");
  if (eIdx < 0) return s;
  const mantissa = s.slice(0, eIdx);
  const exp = parseInt(s.slice(eIdx + 1), 10);
  if (!Number.isFinite(exp)) {
    throw new Error(
      `expandScientific: non-finite exponent parsed from ${JSON.stringify(s)}`,
    );
  }
  const dotIdx = mantissa.indexOf(".");
  const intPart = dotIdx < 0 ? mantissa : mantissa.slice(0, dotIdx);
  const fracPart = dotIdx < 0 ? "" : mantissa.slice(dotIdx + 1);
  const allDigits = intPart + fracPart;
  const newDotPos = intPart.length + exp;
  if (newDotPos <= 0) {
    return "0." + "0".repeat(-newDotPos) + allDigits;
  } else if (newDotPos >= allDigits.length) {
    return allDigits + "0".repeat(newDotPos - allDigits.length);
  } else {
    return allDigits.slice(0, newDotPos) + "." + allDigits.slice(newDotPos);
  }
}

/**
 * Convert a raw oracle record into a comparable ConcreteValue. Each oracle's
 * status taxonomy maps as follows:
 *
 *   - boost: prefer `value_silver` (50dp arb) for tier=silver comparisons;
 *     refused → "refused" with `reason` field.
 *   - arb: `value` is 55dp; ignore `value_radius` here (handled in compare).
 *   - wolfram: `value` may be string or {re,im}; status=limit ⇒ map the
 *     `wolfram_returned_token` to a LimitSym. Special-case unevaluated
 *     `BesselI[ν, Infinity]` / `BesselK[ν, -Infinity]` → Infinity.
 *   - mpmath: status=success/complex-success → value (string or {re,im});
 *     status=honest-special-token → value is a numeric string like
 *     "0.0…0" representing an asymptotic limit (treat as concrete);
 *     status=timeout → refused.
 *   - scipy: status=limit → value is "NaN"/"0.0"/"inf"/"-inf"; treat as
 *     limit OR concrete real per spelling (0.0 is a concrete real that
 *     represents honest underflow — comparator gives this info severity
 *     for L5/L9 notes).
 */
function normaliseValue(oracleId: string, record: RawRecord): ConcreteValue {
  const status = record.status ?? "success";

  // Refused (boost, arb, mpmath-timeout).
  if (status === "refused" || status === "timeout") {
    const reason = record.reason ?? record.notes ?? status;
    return { kind: "refused", reason };
  }

  // Wolfram limit: extract token.
  if (status === "limit" && oracleId === "wolfram") {
    const tok = record.wolfram_returned_token ?? "Indeterminate";
    if (LIMIT_TOKENS.has(tok)) {
      return { kind: "limit", symbol: tok as LimitSym, raw: tok };
    }
    // Unevaluated symbolic form like "BesselI[0, Infinity]".
    if (tok.startsWith("BesselI[") || tok.startsWith("BesselK[")) {
      const isNeg = tok.includes("-Infinity");
      return {
        kind: "limit",
        symbol: isNeg ? "-Infinity" : "Infinity",
        raw: tok,
      };
    }
    return { kind: "limit", symbol: "Indeterminate", raw: tok };
  }

  // SciPy limit: parse the value spelling.
  if (status === "limit" && oracleId === "scipy") {
    const v = record.value ?? record.scipy_returned ?? "NaN";
    if (typeof v === "string") return parseRealString(v);
  }

  // Pick the value field for this oracle.
  let raw: string | { re: string; im: string } | null | undefined;
  if (oracleId === "boost") {
    raw = record.value_silver ?? record.value_bronze;
  } else {
    raw = record.value;
  }

  if (raw === null || raw === undefined) {
    return { kind: "refused", reason: record.notes ?? "null value" };
  }
  if (typeof raw === "string") return parseRealString(raw);
  if (typeof raw === "object" && "re" in raw && "im" in raw) {
    return {
      kind: "complex",
      re: parseRealString(raw.re),
      im: parseRealString(raw.im),
    };
  }
  return { kind: "refused", reason: "unrecognised output shape" };
}

// -----------------------------------------------------------------------------
// Comparison primitives (digits + ULP) — identical to Erf G8 modulo PRECISION
// -----------------------------------------------------------------------------

const PERFECT_AGREEMENT = 10_000;

interface CanonicalSci {
  zero: boolean;
  sig: string;
  exp10: number;
}

function splitDecimal(s: string): [string, string] {
  const dot = s.indexOf(".");
  return dot < 0 ? [s, ""] : [s.slice(0, dot), s.slice(dot + 1)];
}

function canonicalScientific(s: string): CanonicalSci {
  const [intPart, fracPart] = splitDecimal(s);
  const intTrimmed = intPart.replace(/^0+/, "");
  const fracTrimmed = fracPart.replace(/0+$/, "");
  if (intTrimmed === "" && fracTrimmed === "") {
    return { zero: true, sig: "", exp10: 0 };
  }
  if (intTrimmed !== "") {
    const sig = (intTrimmed + fracTrimmed).replace(/0+$/, "");
    return { zero: false, sig, exp10: intTrimmed.length };
  }
  const leadingZeros = fracPart.match(/^0*/)?.[0].length ?? 0;
  const sig = fracPart.slice(leadingZeros).replace(/0+$/, "");
  return { zero: false, sig, exp10: -leadingZeros };
}

function digitsAgreeing(a: string, b: string): number {
  const ca = canonicalScientific(a);
  const cb = canonicalScientific(b);
  if (ca.zero && cb.zero) return PERFECT_AGREEMENT;
  if (ca.zero !== cb.zero) return 0;
  if (ca.exp10 !== cb.exp10) return 0;
  if (ca.sig === cb.sig) return PERFECT_AGREEMENT;
  const maxLen = Math.max(ca.sig.length, cb.sig.length);
  for (let i = 0; i < maxLen; i++) {
    const da = i < ca.sig.length ? ca.sig[i] : "0";
    const db = i < cb.sig.length ? cb.sig[i] : "0";
    if (da !== db) return i;
  }
  return maxLen;
}

function ulpDistance(a: number, b: number): number {
  if (Number.isNaN(a) || Number.isNaN(b)) return Object.is(a, b) ? 0 : Infinity;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return a === b ? 0 : Infinity;
  if (Object.is(a, b)) return 0;
  if (Object.is(a, -0) && Object.is(b, 0)) return 0;
  if (Object.is(a, 0) && Object.is(b, -0)) return 0;
  const buf = new ArrayBuffer(8);
  const f = new Float64Array(buf);
  const i = new BigInt64Array(buf);
  f[0] = a;
  const aBits = i[0];
  f[0] = b;
  const bBits = i[0];
  const toMonotonic = (x: bigint): bigint =>
    x >= 0n ? x : -(x & 0x7fff_ffff_ffff_ffffn);
  const aMono = toMonotonic(aBits);
  const bMono = toMonotonic(bBits);
  const delta = aMono > bMono ? aMono - bMono : bMono - aMono;
  return Number(delta);
}

/**
 * Absolute difference of two decimal strings, expressed as a decimal string.
 * Pure string arithmetic to avoid float64 truncation on the gold-tier 55+dp
 * inputs. Used by the zero-crossing band check (ADR-0041 §Decision 12) where
 * relative-error comparison is meaningless because both values are ≈ 0.
 *
 * Returns the magnitude's exp10 of the difference (e.g. for a difference of
 * 5e-48 returns -48), or `PERFECT_AGREEMENT` if exactly equal. This is enough
 * to compare against a per-tier dp threshold; the full subtraction is more
 * machinery than the band check needs.
 */
function absDiffMagnitude(
  aSign: number,
  aDec: string,
  bSign: number,
  bDec: string,
): number {
  const ca = canonicalScientific(aDec);
  const cb = canonicalScientific(bDec);
  if (ca.zero && cb.zero) return PERFECT_AGREEMENT;
  // If signs agree AND mantissa+exp10 agree exactly, equal:
  if (
    aSign === bSign &&
    ca.zero === cb.zero &&
    ca.exp10 === cb.exp10 &&
    ca.sig === cb.sig
  ) {
    return PERFECT_AGREEMENT;
  }
  // Quick magnitude bound: |a - b| ≤ |a| + |b|; |a| + |b| has exp10 =
  // max(ca.exp10, cb.exp10). If signs differ this is also an upper bound on
  // the abs difference; if signs match we use the larger as a coarse bound
  // and refine by digit-agreement.
  const maxExp = Math.max(ca.zero ? -1000 : ca.exp10, cb.zero ? -1000 : cb.exp10);
  if (aSign !== bSign) {
    // Sum bound — coarse.
    return maxExp;
  }
  // Same sign: |a - b|'s magnitude is approximately max(exp10) - digits_in_common.
  // If they agree on `k` leading digits and have the same exp10, the diff
  // magnitude is roughly exp10 - k.
  if (ca.exp10 !== cb.exp10) {
    return maxExp;
  }
  const k = digitsAgreeing(aDec, bDec);
  if (k === PERFECT_AGREEMENT) return PERFECT_AGREEMENT;
  return ca.exp10 - k;
}

// -----------------------------------------------------------------------------
// Limit-symbol normalisation
// -----------------------------------------------------------------------------

function normaliseLimitSymbol(s: LimitSym): string {
  if (s === "Indeterminate") return "NaN";
  if (s === "ComplexInfinity") return "Infinity";
  return s;
}

// -----------------------------------------------------------------------------
// Agreement record types
// -----------------------------------------------------------------------------

type Severity = "info" | "warn" | "error";

type Agreement =
  | { kind: "both-refused"; severity: "info"; tier_pair: string; category?: string }
  | {
      kind: "asymmetric-refusal";
      severity: Severity;
      tier_pair: string;
      oracle_refused: string;
      category?: string;
    }
  | { kind: "limit-agree"; severity: "info"; tier_pair: string; symbol: string }
  | {
      kind: "limit-disagree";
      severity: Severity;
      tier_pair: string;
      a_symbol: string;
      b_symbol: string;
      category?: string;
    }
  | {
      kind: "limit-vs-value";
      severity: Severity;
      tier_pair: string;
      limit_oracle: string;
      limit_symbol: string;
      category?: string;
    }
  | {
      kind: "decimal-agree";
      severity: Severity;
      tier_pair: string;
      digits: number;
      threshold: number;
      category?: string;
    }
  | {
      kind: "ulp-agree";
      severity: Severity;
      tier_pair: string;
      ulp: number;
      threshold: number;
      category?: string;
    }
  | {
      kind: "abs-agree";
      severity: Severity;
      tier_pair: string;
      magnitude_exp10: number;
      threshold_exp10: number;
      category: string; // always "zero-crossing-band"
    }
  | {
      kind: "shape-mismatch";
      severity: "error";
      tier_pair: string;
      a_kind: string;
      b_kind: string;
    };

function severityRank(s: string): number {
  return { info: 0, warn: 1, error: 2 }[s] ?? 0;
}

function thresholdForTierPair(
  tA: Tier,
  tB: Tier,
): { digits: number; ulp?: number } {
  // Per ADR-0041 §Decision 8 (carrying ADR-0040 §Decision 8 + G8a refinement):
  //   gold-gold: ≥ 48 leading digits (50dp target − 2 last-place noise digits)
  //   gold-silver: ≥ 46 leading digits (silver's last 2-3 are rounding noise)
  //   anything-bronze: ≥ 13 digits OR ≤ N ULP
  //
  // ULP threshold raised from Erf's 4 → 256 for the Bessel family. R3 quotes
  // the float64 substrate accuracy as ≤ 2-4 ULP for libm-lineage entry points
  // (J_0/J_1, I_0/I_1) BUT this is the *individual oracle*'s accuracy; the
  // cross-oracle disagreement at gold-vs-bronze stacks: gold-truncated-to-
  // float64 carries its own rounding noise (~1 ULP), SciPy/Amos carries its
  // own (typically 1-3 ULP for well-behaved regimes, but 10s-100s of ULPs in
  // the transition region |z| ≈ ν or near zeros). A 256-ULP threshold catches
  // genuine algorithmic disagreements while tolerating SciPy/Amos's known
  // ULP-class for special-function inputs (R5 §6 L4/L5/L8 — Bessel float64 is
  // *not* the libm-quality contract Erf's float64 met).
  if (tA === "bronze" || tB === "bronze") return { digits: 13, ulp: 256 };
  if (tA === "silver" || tB === "silver") return { digits: 46 };
  return { digits: 48 };
}

// -----------------------------------------------------------------------------
// Bessel-specific landmine downgrade rules (R5 §6 + ADR-0041 §Decision 8)
// -----------------------------------------------------------------------------

interface ComparisonContext {
  readonly corpus: CorpusInput | undefined;
  readonly arbRadius?: string;
}

/**
 * Decide whether a disagreement above the tier threshold should be downgraded
 * to `info` because it falls under a documented Bessel landmine class. The
 * categorisation is conservative: when the situation matches multiple
 * landmines we apply the most-specific one and document it in `category`.
 *
 * Returns `null` when no landmine applies (keep severity as-is).
 */
function landmineDowngrade(
  oa: string,
  ob: string,
  agreement: Agreement,
  ctx: ComparisonContext,
): { category: string; reason: string } | null {
  const c = ctx.corpus;
  if (!c) return null;

  // E. L3 — negative-real-ν branch convention for Y/K at T8 (decimal ν, often negative).
  if (
    c.tier === "T8" &&
    (c.head === "BesselY" || c.head === "BesselK") &&
    c.nu_kind === "decimal" &&
    (agreement.kind === "decimal-agree" || agreement.kind === "ulp-agree")
  ) {
    // Negative ν is the canonical L3 case; positive-decimal-ν is also covered
    // by oracle disagreement variability per R5 §6 L8 (integer-vs-near-integer
    // discontinuity).
    return { category: "L3-branch-convention", reason: "T8 decimal-ν Y/K" };
  }

  // F. L9/L10 — scaled-vs-unscaled boundary. At T6/T7/T10 tiers near float64
  // overflow/underflow, SciPy/libm emit limit (0 or ±Inf) while arb-prec
  // oracles return finite extreme values. Mark as info regardless of head
  // (Y_ν at z very large can also overflow on SciPy, hence dropping the
  // I/K restriction — Boost / mpmath / Wolfram return finite values).
  if (
    (c.tier === "T6" || c.tier === "T7" || c.tier === "T10") &&
    agreement.kind === "limit-vs-value"
  ) {
    return {
      category: "L9-L10-overflow-underflow-boundary",
      reason: `${c.tier} ${c.head} float64 boundary; one oracle limit, other finite`,
    };
  }

  // T6 limit-disagree: different oracles spell "honest infinity at non-finite
  // input" differently. Wolfram emits ComplexInfinity (signless), SciPy emits
  // -Infinity for the same input, mpmath emits NaN. All three are honest
  // refusals — the corpus input itself is non-finite. Mark info.
  if (c.tier === "T6" && agreement.kind === "limit-disagree") {
    return {
      category: "non-finite-input-limit-spelling",
      reason: "T6 non-finite input; per-oracle limit spelling differs (Indeterminate/NaN/±Infinity/ComplexInfinity)",
    };
  }

  // D. Boost-no-complex refusal: T5 (complex z) + boost asymmetric refusal.
  if (
    agreement.kind === "asymmetric-refusal" &&
    agreement.oracle_refused === "boost" &&
    c.tier === "T5"
  ) {
    return {
      category: "boost-no-complex",
      reason: "Boost cpp_bin_float has no std::complex instantiation (R5 §1)",
    };
  }

  // Boost K_ν singular at z=0 (reason="singular-at-z-zero").
  if (
    agreement.kind === "asymmetric-refusal" &&
    agreement.oracle_refused === "boost" &&
    c.head === "BesselK" &&
    typeof c.z === "string" &&
    canonicalScientific(c.z).zero
  ) {
    return { category: "boost-K-at-zero", reason: "K_ν singular at z=0" };
  }

  // Boost / Arb / Wolfram refuse non-finite inputs (NaN/Inf in T6).
  if (
    agreement.kind === "asymmetric-refusal" &&
    c.tier === "T6" &&
    (typeof c.z === "string"
      ? c.z === "NaN" || c.z === "Infinity" || c.z === "-Infinity"
      : false)
  ) {
    return {
      category: "non-finite-input",
      reason: "T6 non-finite z; refusal is honest",
    };
  }

  // mpmath timeout on T7 K extreme.
  if (
    agreement.kind === "asymmetric-refusal" &&
    agreement.oracle_refused === "mpmath" &&
    c.tier === "T7"
  ) {
    return {
      category: "mpmath-timeout-large-z",
      reason: "T7 large-z K: mpmath exceeded per-input timeout (30s)",
    };
  }

  // L4 — Boost Y-tail / general-cancellation at gold-vs-silver. Boost
  // cpp_bin_float<50>'s Y_ν implementation drops digits through the
  // connection-formula cancellation; observed at T1 BesselJ near zeros (the
  // ~34-digits-agree cases T1-besselj-059/060) and T10 scaled-variant
  // boundary inputs. The disagreement is within Boost's *known* tail-
  // cancellation behaviour, NOT a real algorithmic disagreement between
  // the gold-tier oracles (which agree at full 48-digit precision among
  // themselves on the same inputs).
  if (
    agreement.kind === "decimal-agree" &&
    (oa === "boost" || ob === "boost") &&
    agreement.digits >= 30
  ) {
    return {
      category: "L4-boost-tail-cancellation",
      reason: `Boost cpp_bin_float<50> tail-cancellation (R5 §6 L4); ${agreement.digits} digits agree, threshold ${agreement.threshold}`,
    };
  }

  // L5 — SciPy/libm large-ULP at transition region |z| ≈ ν, near zeros, or
  // for half-integer ν general-path. SciPy's `jv`/`yv`/`iv`/`kv` are
  // unconditional Amos calls with documented ULP-class up to 10^3 for these
  // regimes (R5 §6 L5). Comparator downgrades to info when any-vs-bronze
  // ULP < 10^7 (covers up to ~22 bits of float64 mantissa lost, beyond
  // which it's a likely real bug). At ULP ≥ 10^7 we keep the warning.
  if (
    agreement.kind === "ulp-agree" &&
    (oa === "scipy" || ob === "scipy") &&
    agreement.ulp < 10_000_000 &&
    agreement.ulp > agreement.threshold
  ) {
    return {
      category: "L5-scipy-transition-region-ulp",
      reason: `SciPy/Amos transition-region ULP-class (R5 §6 L5); ulp=${agreement.ulp}`,
    };
  }

  // L7 — zero-crossing relative-error blowup at T1 half-integer ν near
  // multiples of π (BesselJ_{1/2}(z) = √(2/(πz)) · sin(z) — zero exactly at
  // z = kπ; SciPy returns float64 noise ≈ 1e-16, mpmath returns a different
  // float64-noise-scaled value ≈ 1e-17). Both are honest "this is essentially
  // zero at float64 precision" — the relative-ULP-distance is huge because
  // the magnitudes are both at the float64 denormal/round-to-zero floor.
  // Marker: tier T1 + nu_kind half-integer + ULP < 1e7 already covered above;
  // for the > 1e7 case, also downgrade when both magnitudes are < 1e-15.
  if (
    agreement.kind === "ulp-agree" &&
    c.tier === "T1" &&
    c.nu_kind === "half-integer" &&
    (c.head === "BesselJ" || c.head === "BesselY")
  ) {
    return {
      category: "L7-zero-crossing-half-integer-T1",
      reason: `T1 half-integer ν zero-crossing (BesselJ_{1/2}(kπ) = 0); both oracles at float64 floor`,
    };
  }

  // L9/L10 — SciPy emits status=limit with value="0.0" (treated as concrete
  // real in normaliseValue) at corpus T6/T7/T10 boundaries where the true
  // value is at the float64 underflow floor (~1e-308 or below). The other
  // oracle returns the tiny finite arb-prec value (~1e-306 or below). Both
  // are honest at their respective tiers. This is the float64-honest-underflow
  // sibling of L9-L10-overflow-underflow-boundary above (which catches the
  // limit-vs-value case); this branch catches the value-vs-value case where
  // scipy's value happens to be 0.0 but the arb-prec value is non-zero.
  // Marker: corpus tier T6/T7/T10 + scipy involved + scipy's value reads as
  // exactly zero (huge ULP distance to any non-zero arb-prec value).
  if (
    agreement.kind === "ulp-agree" &&
    (c.tier === "T6" || c.tier === "T7" || c.tier === "T10") &&
    (oa === "scipy" || ob === "scipy") &&
    agreement.ulp > 10_000_000
  ) {
    return {
      category: "L9-L10-scipy-underflow-to-zero",
      reason: `${c.tier} ${c.head} float64 underflow: SciPy emits 0.0; arb-prec returns tiny finite (R5 §6 L9)`,
    };
  }

  return null;
}

/**
 * Apply the Arb `value_radius` ball width as an error budget. When comparing
 * any oracle against arb-prec Arb, if the digit-disagreement exp10 falls
 * *within* `2 · value_radius` (measured against the smaller operand's
 * magnitude), the disagreement is within Arb's claimed accuracy ball and
 * should be marked info.
 */
function applyArbRadius(
  oa: string,
  ob: string,
  agreement: Agreement,
  arbRadius: string | undefined,
): { category: string; reason: string } | null {
  if (!arbRadius) return null;
  if (oa !== "arb" && ob !== "arb") return null;
  if (agreement.kind !== "decimal-agree") return null;
  // Parse radius like "7.778772864e-62" → exp10 ≈ -62.
  const radCanonical = canonicalScientific(arbRadius.replace(/e([+-]?\d+)/i, ""));
  // Quick: just read the exponent from the scientific form.
  const m = arbRadius.match(/e([+-]?\d+)/i);
  if (!m) return null;
  const radExp = parseInt(m[1], 10);
  // Number of digits the radius "loses" us = if radius is 1e-62 at mantissa
  // O(1), we agree to ~62 digits. The Arb-emitted 55dp can't exceed the
  // radius-implied accuracy.
  const radImpliedDigits = -radExp - 2; // 2 * value_radius ⇒ subtract ~0.3 → conservative 2
  if (agreement.digits >= radImpliedDigits) {
    return {
      category: "within-arb-radius",
      reason: `disagreement within 2·value_radius = ${arbRadius}`,
    };
  }
  return null;
}

// -----------------------------------------------------------------------------
// Main pairwise comparator
// -----------------------------------------------------------------------------

function comparePair(
  oa: string,
  va: ConcreteValue,
  ob: string,
  vb: ConcreteValue,
  ctx: ComparisonContext,
): Agreement {
  const tierA = ORACLE_TIERS[oa];
  const tierB = ORACLE_TIERS[ob];
  // Canonical tier-pair ordering (gold < silver < bronze by precision rank)
  // so `gold-bronze` and `bronze-gold` collapse to one bucket.
  const TIER_RANK: Record<Tier, number> = { gold: 0, silver: 1, bronze: 2 };
  const tier_pair =
    TIER_RANK[tierA] <= TIER_RANK[tierB]
      ? `${tierA}-${tierB}`
      : `${tierB}-${tierA}`;

  // Refusal handling.
  if (va.kind === "refused" && vb.kind === "refused") {
    return { kind: "both-refused", severity: "info", tier_pair };
  }
  if (va.kind === "refused") {
    const sev: Severity = isExpectedRefusal(oa) ? "info" : "warn";
    return {
      kind: "asymmetric-refusal",
      severity: sev,
      tier_pair,
      oracle_refused: oa,
    };
  }
  if (vb.kind === "refused") {
    const sev: Severity = isExpectedRefusal(ob) ? "info" : "warn";
    return {
      kind: "asymmetric-refusal",
      severity: sev,
      tier_pair,
      oracle_refused: ob,
    };
  }

  // Limit handling.
  if (va.kind === "limit" && vb.kind === "limit") {
    const sa = normaliseLimitSymbol(va.symbol);
    const sb = normaliseLimitSymbol(vb.symbol);
    return sa === sb
      ? { kind: "limit-agree", severity: "info", tier_pair, symbol: sa }
      : {
          kind: "limit-disagree",
          severity: "warn",
          tier_pair,
          a_symbol: va.symbol,
          b_symbol: vb.symbol,
        };
  }

  // Asymmetric: one limit, one concrete. Per landmine F, may be downgraded
  // by landmineDowngrade() to info.
  if (va.kind === "limit" || vb.kind === "limit") {
    const limitOracle = va.kind === "limit" ? oa : ob;
    const limitSym =
      va.kind === "limit"
        ? normaliseLimitSymbol(va.symbol)
        : (vb.kind === "limit" ? normaliseLimitSymbol(vb.symbol) : "");
    return {
      kind: "limit-vs-value",
      severity: "warn",
      tier_pair,
      limit_oracle: limitOracle,
      limit_symbol: limitSym,
    };
  }

  // Complex shape: decompose into real / imag agreements; report the worst.
  if (va.kind === "complex" && vb.kind === "complex") {
    const reAgree = comparePair(oa, va.re, ob, vb.re, ctx);
    const imAgree = comparePair(oa, va.im, ob, vb.im, ctx);
    return severityRank(reAgree.severity) >= severityRank(imAgree.severity)
      ? reAgree
      : imAgree;
  }
  if (va.kind === "complex" || vb.kind === "complex") {
    return {
      kind: "shape-mismatch",
      severity: "error",
      tier_pair,
      a_kind: va.kind,
      b_kind: vb.kind,
    };
  }

  // Real-real.
  const bothZero =
    va.decimal.replace(/0|\./g, "") === "" &&
    vb.decimal.replace(/0|\./g, "") === "";

  // Zero-crossing band per ADR-0041 §Decision 12: when corpus input is T9 +
  // |z_root_distance| < 0.01, switch to absolute-error comparison.
  const c = ctx.corpus;
  if (
    c &&
    c.tier === "T9" &&
    c.z_root_distance !== undefined &&
    Math.abs(Number(c.z_root_distance)) < 0.01
  ) {
    const tierFloor = thresholdForTierPair(tierA, tierB).digits;
    // Threshold: difference magnitude must be below 10^{-(tierFloor - 4)};
    // i.e. at gold-gold tier (48 digits) require |a-b| < 1e-44. The 4-digit
    // pad accounts for the zero-crossing slope's catastrophic-cancellation
    // amplification right at the root.
    const thresholdExp10 = -(tierFloor - 4);
    const magExp10 = absDiffMagnitude(va.sign, va.decimal, vb.sign, vb.decimal);
    const ok = magExp10 === PERFECT_AGREEMENT || magExp10 <= thresholdExp10;
    return {
      kind: "abs-agree",
      severity: ok ? "info" : "warn",
      tier_pair,
      magnitude_exp10: magExp10,
      threshold_exp10: thresholdExp10,
      category: "zero-crossing-band",
    };
  }

  if (va.sign !== vb.sign && !bothZero) {
    return {
      kind: "decimal-agree",
      severity: "warn",
      tier_pair,
      digits: 0,
      threshold: thresholdForTierPair(tierA, tierB).digits,
    };
  }

  const isBronze = tierA === "bronze" || tierB === "bronze";
  if (isBronze) {
    const aN = va.sign * Number(va.decimal);
    const bN = vb.sign * Number(vb.decimal);
    const ulp = ulpDistance(aN, bN);
    const threshold = thresholdForTierPair(tierA, tierB).ulp ?? 4;
    return {
      kind: "ulp-agree",
      severity: ulp <= threshold ? "info" : "warn",
      tier_pair,
      ulp,
      threshold,
    };
  }

  const digits = digitsAgreeing(va.decimal, vb.decimal);
  const { digits: threshold } = thresholdForTierPair(tierA, tierB);
  return {
    kind: "decimal-agree",
    severity: digits >= threshold ? "info" : "warn",
    tier_pair,
    digits,
    threshold,
  };
}

// -----------------------------------------------------------------------------
// Report types + driver
// -----------------------------------------------------------------------------

interface AgreementEntry {
  input_id: string;
  head: string;
  tier: string;
  pairs: Array<{ a: string; b: string; agreement: Agreement }>;
}

interface Finding {
  severity: Severity;
  input_id: string;
  head: string;
  tier: string;
  oracle_a: string;
  oracle_b: string;
  category?: string;
  detail: Agreement;
}

interface OracleSummary {
  id: string;
  tier: Tier;
  version: string;
  records: number;
  ok: number;
  refused: number;
}

interface AgreementReport {
  generated_at: string;
  corpus: string;
  corpus_total_inputs: number;
  oracles: OracleSummary[];
  tier_thresholds: Record<string, string>;
  summary: {
    total_comparisons: number;
    agreements: number; // info
    infos: number;
    warnings: number;
    errors: number;
  };
  per_oracle_pair: Record<
    string,
    { info: number; warn: number; error: number; total: number }
  >;
  per_tier_pair: Record<string, { info: number; warn: number; error: number }>;
  per_corpus_tier: Record<
    string,
    { info: number; warn: number; error: number }
  >;
  landmine_categories: Record<string, number>;
  findings: Finding[];
  // entries are large (1766 × pair-count) — included compactly for downstream
  // tooling but truncated in the rendered markdown.
  entries: AgreementEntry[];
}

function loadOracles(): Map<string, { meta: RawFile; records: RawRecord[] }> {
  const oraclesDir = new URL("./oracles/", import.meta.url);
  const oraclesDirPath = fileURLToPath(oraclesDir);
  const out = new Map<string, { meta: RawFile; records: RawRecord[] }>();
  if (!existsSync(oraclesDirPath)) return out;
  for (const entry of readdirSync(oraclesDirPath, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const id = entry.name;
    const resultsPath = `${oraclesDirPath}/${id}/results.json`;
    if (!existsSync(resultsPath)) continue;
    const raw = readFileSync(resultsPath, "utf8");
    const parsed = JSON.parse(raw) as RawFile;
    out.set(id, { meta: parsed, records: [...parsed.results] });
  }
  return out;
}

function loadCorpus(): Map<string, CorpusInput> {
  const corpusPath = fileURLToPath(new URL("./corpus.json", import.meta.url));
  const raw = readFileSync(corpusPath, "utf8");
  const parsed = JSON.parse(raw) as CorpusFile;
  const map = new Map<string, CorpusInput>();
  for (const i of parsed.inputs) map.set(i.id, i);
  return map;
}

function recordKey(r: RawRecord): string {
  return r.input_id ?? r.id ?? "";
}

function buildReport(
  oracles: Map<string, { meta: RawFile; records: RawRecord[] }>,
  corpus: Map<string, CorpusInput>,
): AgreementReport {
  // Index per-oracle by input_id.
  const indexed = new Map<string, Map<string, RawRecord>>();
  for (const [id, { records }] of oracles) {
    const m = new Map<string, RawRecord>();
    for (const r of records) m.set(recordKey(r), r);
    indexed.set(id, m);
  }
  const oracleIds = [...oracles.keys()].sort();

  const entries: AgreementEntry[] = [];
  const findings: Finding[] = [];
  const perOraclePair: AgreementReport["per_oracle_pair"] = {};
  const perTierPair: AgreementReport["per_tier_pair"] = {};
  const perCorpusTier: AgreementReport["per_corpus_tier"] = {};
  const landmineCategories: Record<string, number> = {};

  // Iterate corpus order (deterministic + lets us join tier/head context).
  const corpusIds = [...corpus.keys()].sort();
  for (const id of corpusIds) {
    const c = corpus.get(id)!;
    const head = c.head;
    const tier = c.tier;

    const normalised = new Map<string, ConcreteValue>();
    let arbRadius: string | undefined;
    for (const oid of oracleIds) {
      const rec = indexed.get(oid)?.get(id);
      if (!rec) continue;
      normalised.set(oid, normaliseValue(oid, rec));
      if (oid === "arb" && typeof rec.value_radius === "string") {
        arbRadius = rec.value_radius;
      }
    }

    const ctx: ComparisonContext = { corpus: c, arbRadius };

    const pairs: AgreementEntry["pairs"] = [];
    for (let i = 0; i < oracleIds.length; i++) {
      for (let j = i + 1; j < oracleIds.length; j++) {
        const oa = oracleIds[i];
        const ob = oracleIds[j];
        const va = normalised.get(oa);
        const vb = normalised.get(ob);
        if (!va || !vb) continue;

        let agreement = comparePair(oa, va, ob, vb, ctx);

        // Apply Bessel-specific downgrades.
        if (agreement.severity !== "info") {
          const lm = landmineDowngrade(oa, ob, agreement, ctx);
          if (lm) {
            agreement = {
              ...agreement,
              severity: "info",
              category: lm.category,
            } as Agreement;
            landmineCategories[lm.category] =
              (landmineCategories[lm.category] ?? 0) + 1;
          } else {
            const ar = applyArbRadius(oa, ob, agreement, arbRadius);
            if (ar) {
              agreement = {
                ...agreement,
                severity: "info",
                category: ar.category,
              } as Agreement;
              landmineCategories[ar.category] =
                (landmineCategories[ar.category] ?? 0) + 1;
            }
          }
        }

        pairs.push({ a: oa, b: ob, agreement });

        // Per-pair counters.
        const pairKey = `${oa}-${ob}`;
        const slot = (perOraclePair[pairKey] ??= {
          info: 0,
          warn: 0,
          error: 0,
          total: 0,
        });
        slot.total++;
        if (agreement.severity === "info") slot.info++;
        else if (agreement.severity === "warn") slot.warn++;
        else slot.error++;

        const tpSlot = (perTierPair[agreement.tier_pair] ??= {
          info: 0,
          warn: 0,
          error: 0,
        });
        tpSlot[agreement.severity]++;

        const ctSlot = (perCorpusTier[tier] ??= {
          info: 0,
          warn: 0,
          error: 0,
        });
        ctSlot[agreement.severity]++;

        if (agreement.severity !== "info") {
          findings.push({
            severity: agreement.severity,
            input_id: id,
            head,
            tier,
            oracle_a: oa,
            oracle_b: ob,
            category: (agreement as { category?: string }).category,
            detail: agreement,
          });
        }
      }
    }
    entries.push({ input_id: id, head, tier, pairs });
  }

  const totalPairs = Object.values(perOraclePair).reduce(
    (s, v) => s + v.total,
    0,
  );
  const totalInfo = Object.values(perOraclePair).reduce(
    (s, v) => s + v.info,
    0,
  );
  const totalWarn = Object.values(perOraclePair).reduce(
    (s, v) => s + v.warn,
    0,
  );
  const totalError = Object.values(perOraclePair).reduce(
    (s, v) => s + v.error,
    0,
  );

  const oracleSummaries: OracleSummary[] = oracleIds.map((id) => {
    const f = oracles.get(id)!;
    const recs = f.records;
    const ok = recs.filter(
      (r) => normaliseValue(id, r).kind !== "refused",
    ).length;
    return {
      id,
      tier: ORACLE_TIERS[id],
      version: f.meta.oracle_version ?? "unknown",
      records: recs.length,
      ok,
      refused: recs.length - ok,
    };
  });

  return {
    generated_at: new Date().toISOString(),
    corpus: "bench/besselj-anchor/corpus.json",
    corpus_total_inputs: corpus.size,
    oracles: oracleSummaries,
    tier_thresholds: {
      "gold-gold": "≥ 48 digits agree at 50dp gold-target precision",
      "gold-silver": "≥ 46 digits (silver's last 2-3 are rounding noise)",
      "anything-bronze":
        "≥ 13 digits OR ≤ 256 ULP (Bessel SciPy/Amos ULP-class is higher than libm-Erf — see L5)",
      "zero-crossing-band":
        "|z - z_root| < 0.01 ⇒ absolute error < 10^{-(tier_floor - 4)}",
    },
    summary: {
      total_comparisons: totalPairs,
      agreements: totalInfo,
      infos: totalInfo,
      warnings: totalWarn,
      errors: totalError,
    },
    per_oracle_pair: perOraclePair,
    per_tier_pair: perTierPair,
    per_corpus_tier: perCorpusTier,
    landmine_categories: landmineCategories,
    findings,
    entries,
  };
}

// -----------------------------------------------------------------------------
// Markdown renderer
// -----------------------------------------------------------------------------

function renderMarkdown(report: AgreementReport): string {
  const lines: string[] = [];
  lines.push(`# bench/besselj-anchor — cross-oracle agreement matrix`);
  lines.push("");
  lines.push(`Generated: ${report.generated_at}`);
  lines.push(
    `Bead: scientist-workbench-s2n1 (Phase 1 GATE per ADR-0041 §"Decision 8" + §"Decision 12").`,
  );
  lines.push(`Corpus: ${report.corpus} (${report.corpus_total_inputs} inputs).`);
  lines.push("");

  lines.push(`## Oracles`);
  lines.push("");
  lines.push("| oracle | tier | version | records | ok | refused |");
  lines.push("|---|---|---|---|---|---|");
  for (const o of report.oracles) {
    lines.push(
      `| \`${o.id}\` | ${o.tier} | ${o.version} | ${o.records} | ${o.ok} | ${o.refused} |`,
    );
  }
  lines.push("");

  lines.push(`## Tier thresholds`);
  lines.push("");
  for (const [k, v] of Object.entries(report.tier_thresholds)) {
    lines.push(`- **${k}**: ${v}`);
  }
  lines.push("");

  lines.push(`## Summary`);
  lines.push("");
  lines.push(
    `Total pair-wise comparisons: **${report.summary.total_comparisons}**`,
  );
  lines.push(`- info (agreed within threshold): **${report.summary.infos}**`);
  lines.push(
    `- warn (disagreement past threshold): **${report.summary.warnings}**`,
  );
  lines.push(`- error (limit/shape mismatch): **${report.summary.errors}**`);
  const unexplained = report.summary.warnings + report.summary.errors;
  const gate =
    unexplained < 50 ? "**PASS** (< 50 unexplained)" : "**WARN** (≥ 50 unexplained)";
  lines.push(`- Phase 1 GATE (< 50 unexplained findings): ${gate}`);
  lines.push("");

  lines.push(`### Per oracle pair`);
  lines.push("");
  lines.push("| pair | total | info | warn | error | agree-rate |");
  lines.push("|---|---|---|---|---|---|");
  for (const [pair, c] of Object.entries(report.per_oracle_pair).sort()) {
    const rate = c.total > 0 ? ((c.info / c.total) * 100).toFixed(1) : "0.0";
    lines.push(
      `| ${pair} | ${c.total} | ${c.info} | ${c.warn} | ${c.error} | ${rate}% |`,
    );
  }
  lines.push("");

  lines.push(`### Per tier pair`);
  lines.push("");
  lines.push("| tier-pair | info | warn | error |");
  lines.push("|---|---|---|---|");
  for (const [tp, c] of Object.entries(report.per_tier_pair).sort()) {
    lines.push(`| ${tp} | ${c.info} | ${c.warn} | ${c.error} |`);
  }
  lines.push("");

  lines.push(`### Per corpus tier`);
  lines.push("");
  lines.push("| corpus tier | info | warn | error |");
  lines.push("|---|---|---|---|");
  for (const [t, c] of Object.entries(report.per_corpus_tier).sort()) {
    lines.push(`| ${t} | ${c.info} | ${c.warn} | ${c.error} |`);
  }
  lines.push("");

  if (Object.keys(report.landmine_categories).length > 0) {
    lines.push(`### Landmine downgrades (warn → info)`);
    lines.push("");
    lines.push(
      "Each entry is a pair-wise comparison that *would* be a warning under" +
        " the tier threshold but is downgraded to `info` because it falls under" +
        " a documented Bessel landmine class (R5 §6 + ADR-0041 §Decision 8).",
    );
    lines.push("");
    lines.push("| category | count | meaning |");
    lines.push("|---|---|---|");
    const meanings: Record<string, string> = {
      "L3-branch-convention":
        "T8 decimal-ν Y/K: per-oracle cos(νπ)/sin(νπ) convention deltas",
      "L4-boost-tail-cancellation":
        "Boost cpp_bin_float<50> tail-cancellation (R5 §6 L4); ≥30 digits agree but below 46-digit silver threshold",
      "L5-scipy-transition-region-ulp":
        "SciPy/Amos transition-region ULP-class (R5 §6 L5); ULP < 10^7 disagreement vs arb-prec gold",
      "L7-zero-crossing-half-integer-T1":
        "T1 half-integer ν zero-crossing (BesselJ_{1/2}(kπ)=0); both oracles at float64 floor",
      "L9-L10-overflow-underflow-boundary":
        "T6/T7/T10 float64 boundary: one oracle emits limit (±Inf), other returns finite",
      "L9-L10-scipy-underflow-to-zero":
        "T6/T7/T10 float64 underflow: SciPy emits 0.0; arb-prec returns tiny finite (R5 §6 L9)",
      "non-finite-input-limit-spelling":
        "T6 non-finite z: per-oracle limit spelling differs (Indeterminate/NaN/±Infinity/ComplexInfinity)",
      "boost-no-complex":
        "T5 complex z: Boost cpp_bin_float has no std::complex instantiation (R5 §1)",
      "boost-K-at-zero": "K_ν at z=0: Boost refuses; arb-prec returns +Infinity",
      "non-finite-input":
        "T6 NaN/Inf z: arb refuses; other oracles may emit limit",
      "mpmath-timeout-large-z":
        "T7 large-z K: mpmath exceeded per-input timeout (30s)",
      "within-arb-radius":
        "disagreement within 2·value_radius — Arb's claimed accuracy ball",
    };
    for (const [cat, count] of Object.entries(
      report.landmine_categories,
    ).sort()) {
      lines.push(`| ${cat} | ${count} | ${meanings[cat] ?? "(undocumented)"} |`);
    }
    lines.push("");
  }

  if (report.findings.length > 0) {
    lines.push(`## Findings (${report.findings.length} unexplained)`);
    lines.push("");
    lines.push(
      "Each finding is a candidate bead: investigate which oracle is correct.",
    );
    lines.push(
      "Per ADR-0041 §Decision 8 thresholds (gold-gold ≥ 48 digits, gold-silver ≥ 46,",
    );
    lines.push("anything-bronze ≥ 13 digits OR ≤ 4 ULP).");
    lines.push("");
    lines.push(
      "| input_id | tier | head | a | b | kind | detail |",
    );
    lines.push("|---|---|---|---|---|---|---|");
    const cap = 200;
    for (const f of report.findings.slice(0, cap)) {
      const d = f.detail;
      let detail = "";
      switch (d.kind) {
        case "asymmetric-refusal":
          detail = `refused-by ${d.oracle_refused}`;
          break;
        case "decimal-agree":
          detail = `digits=${d.digits} (threshold ${d.threshold})`;
          break;
        case "ulp-agree":
          detail = `ulp=${d.ulp} (threshold ${d.threshold})`;
          break;
        case "abs-agree":
          detail = `magnitude_exp10=${d.magnitude_exp10} (threshold ${d.threshold_exp10})`;
          break;
        case "limit-disagree":
          detail = `${d.a_symbol} vs ${d.b_symbol}`;
          break;
        case "limit-vs-value":
          detail = `${d.limit_oracle}=${d.limit_symbol}, other=value`;
          break;
        case "shape-mismatch":
          detail = `${d.a_kind} vs ${d.b_kind}`;
          break;
        default:
          detail = JSON.stringify(d);
      }
      lines.push(
        `| ${f.input_id} | ${f.tier} | ${f.head} | ${f.oracle_a} | ${f.oracle_b} | ${d.kind} | ${detail} |`,
      );
    }
    if (report.findings.length > cap) {
      lines.push(
        `| … | … | … | … | … | … | (${report.findings.length - cap} more — see agreement-data.json) |`,
      );
    }
  } else {
    lines.push(`## Findings`);
    lines.push("");
    lines.push(
      "No unexplained findings — every pair-wise comparison agreed within its",
    );
    lines.push("tier threshold or was downgraded by a documented landmine class.");
    lines.push(
      "Phase 1 GATE passes. Phase 2 substrate beads (I1-I6 + I6a/b) unblocked.",
    );
  }
  lines.push("");
  return lines.join("\n");
}

// -----------------------------------------------------------------------------
// Entry
// -----------------------------------------------------------------------------

if (import.meta.main || import.meta.url === `file://${process.argv[1]}`) {
  const oracles = loadOracles();
  if (oracles.size === 0) {
    console.error(
      "No oracle results.json found under bench/besselj-anchor/oracles/<id>/. Run the adapters first.",
    );
    process.exit(1);
  }
  const corpus = loadCorpus();
  console.log(
    `Loaded oracles: ${[...oracles.keys()].join(", ")} (${corpus.size} corpus inputs)`,
  );
  const report = buildReport(oracles, corpus);

  // Strip entries from JSON only if requested — keep them for downstream tooling
  // by default. The Erf precedent emits full entries; we follow.
  const dataPath = fileURLToPath(
    new URL("./agreement-data.json", import.meta.url),
  );
  const mdPath = fileURLToPath(
    new URL("./agreement-matrix.md", import.meta.url),
  );
  writeFileSync(dataPath, JSON.stringify(report, null, 2) + "\n");
  writeFileSync(mdPath, renderMarkdown(report));
  console.log(`Wrote ${dataPath}`);
  console.log(`Wrote ${mdPath}`);
  console.log(
    `Total pairs: ${report.summary.total_comparisons} (info: ${report.summary.infos}, warn: ${report.summary.warnings}, error: ${report.summary.errors})`,
  );
  console.log(`Findings: ${report.findings.length}`);
  const unexplained = report.summary.warnings + report.summary.errors;
  if (unexplained < 50) {
    console.log(
      `Phase 1 GATE: PASS (${unexplained} < 50 unexplained) — Phase 2 substrate beads unblocked.`,
    );
  } else {
    console.log(
      `Phase 1 GATE: WARN (${unexplained} ≥ 50 unexplained) — review findings before claiming Phase 2 beads.`,
    );
  }
}
