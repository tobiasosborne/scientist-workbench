// =============================================================================
// bench/gamma-anchor/cross-agreement.ts — G8 cross-oracle agreement matrix
// =============================================================================
//
// Phase 1 GATE for the Gamma-family epic (`scientist-workbench-xqc7`),
// bead `scientist-workbench-fab6`. Carries the structure of the Bessel G8
// comparator (`bench/besselj-anchor/cross-agreement.ts`) verbatim and adapts
// the landmine-downgrade table to the Gamma family per
// `docs/refs/gamma-research/R5-oracle-landscape.md §6` and
// `docs/adr/0042-gamma-family-per-head-substrate.md §"Decision 8"`.
//
// Reads every `bench/gamma-anchor/oracles/<id>/results.json` (5 oracles:
// Wolfram, mpmath, SciPy, Boost, Arb), joins by `input_id` (every adapter
// emits 377 records aligned to the corpus from bead `0kq3`), and computes
// pair-wise agreement per (input_id, head). Emits:
//   - bench/gamma-anchor/agreement-data.json   (machine-readable)
//   - bench/gamma-anchor/agreement-matrix.md   (human heat-map)
//
// Algorithm chapter
// ----------------------------------------------------------------------------
// 1. Load each oracle's results.json and the corpus.json. Index records by
//    `input_id` (every oracle uses this join key uniformly).
//
// 2. For every corpus input, compute every (i, j) oracle pair where both
//    oracles produced an evaluation eligible for comparison
//    (`status ∈ {success, complex-success}`). Note that scipy/boost emit
//    `success` with `value: "Infinity"` / `"NaN"` at L17 poles — those are
//    parsed as `limit` (not `concrete`) by `normaliseValue` and handled by
//    the limit-vs-limit / limit-vs-value branches.
//
// 3. Tier-aware tolerance, per ADR-0042 §Decision 8 (carried from ADR-0040
//    §Decision 8 and ADR-0041 §Decision 8, with Gamma-specific tuning):
//      gold-gold (Wolfram ↔ mpmath ↔ Arb): ≥ 48 leading digits at 50dp target
//                                          (60dp working precision, ~2 last
//                                          digits noise per L2/L11).
//      gold-silver (any-gold × Boost cpp_bin_float<50>): ≥ 46 leading digits.
//      anything-bronze (× SciPy float64): ≥ 13 digits OR ≤ 256 ULP.
//                                         The looser ULP threshold matches the
//                                         Bessel precedent — SciPy/Cephes for
//                                         gamma carries 2-4 ULP in well-behaved
//                                         regions but tens-to-hundreds in the
//                                         Temme transition and L_polynew_4
//                                         large-a regime.
//      bronze-bronze: same as anything-bronze (only one bronze oracle here).
//
// 4. Landmine downgrades. When a pair-disagreement matches a documented
//    landmine class (R5 §6 + ADR-0042 §Decision 8), it is recorded as
//    `info` with a `category` tag instead of `warn`. The gamma-specific
//    classes are listed in `landmineDowngrade` below — L12 P/Q convention
//    (already canonicalised at adapter layer via separate heads),
//    L_pole / L17 (four-oracle pole behaviour: ComplexInfinity / ValueError
//    refusal / +∞ / NaN), L14 (SciPy refuses complex polygamma + complex
//    gammainc), L15 (SciPy NaN on real-negative loggamma; mpmath/Wolfram
//    return complex analytic continuation), L16 (no boost/scipy BarnesG),
//    L_polynew_3 (BarnesG Adamchik convention — verified equal between
//    Wolfram and mpmath, so no canonicalisation needed; this branch is a
//    no-op gate that activates only if the convention assumption breaks),
//    and the v0.1 Temme T7 carve-out (ADR-0042 — saddle region tolerates
//    `precision − log₂(|a|)` bits, currently 200-bit Arb retries kick in
//    on 2 cells and the gold tier still agrees to ~55 dp on them).
//
// 5. Arb `value_radius` as first-class error info. When comparing Arb
//    against another gold-tier oracle, if the digit-difference falls within
//    the ball width (`exp10 ≥ −radExp − 2`), the disagreement is recorded
//    as `within-arb-radius` (info). This is the "Arb's certified containment
//    bracket the disagreement" downgrade.
//
// 6. Zero-crossing band. Where a value is genuinely near zero (e.g. Digamma
//    near the inter-pole roots, or BarnesG at non-positive integers where
//    BarnesG(0)=BarnesG(-k)=0), relative-error comparison is meaningless.
//    The gamma corpus does not (in v0.1) tag near-zero corpus cells with
//    explicit zero-distance metadata the way Bessel T9 carries
//    `z_root_distance` — but the comparator still handles the both-magnitudes-
//    very-small case by switching to absolute-error comparison via
//    `absDiffMagnitude` when either operand canonicalises to zero.
//
// 7. Phase 1 gate verdict. Count unexplained findings (= `warn` + `error`
//    severities after all downgrades). Threshold: **< 50 unexplained**
//    (per bead spec; Erf had 8, Bessel had 0).
//
// Per-oracle status taxonomy (parsed by `normaliseValue`)
// ----------------------------------------------------------------------------
//   wolfram: status ∈ {success, refused}
//            success → string ("1", "24", "3.99168e7") or {re, im}
//            refused → value=null, `wolfram_returned_token: "ComplexInfinity"`
//              at L17 poles.
//   mpmath:  status ∈ {success, complex-success, refused, unsupported}
//            success / complex-success → string or {re, im}
//            refused → value=null, `mpmath_returned_token:
//              "ValueError: gamma function pole" | "...: polygamma pole"`.
//            unsupported → InverseIncompleteGamma{P,Q} (mpmath has no native).
//   scipy:   status ∈ {success, refused, unsupported}
//            success → value can be a numeric string OR "Infinity" /
//              "-Infinity" / "NaN" at L17 poles (scipy's float64 path
//              returns +inf/-inf/nan and the adapter emits the spelling).
//              `parseRealString` recognises these tokens as `limit`.
//            refused → value=null, `refuse_token: "TypeError-complex-polygamma" |
//              "TypeError-complex-gammainc"` (L14 + L14-cousin).
//            unsupported → BarnesG (L16; not in scipy).
//   boost:   status ∈ {success, refused, unsupported}
//            success → value = "1.0000000…e+00" (50 sig-digit scientific).
//            refused → at gamma poles (`std-exception`), or for Beta with
//              non-positive a/b. `reason` carries the boost::math what()
//              message.
//            unsupported → `reason ∈ {boost-no-complex, boost-no-barnesg,
//              boost-no-pochhammer}` — capability gaps.
//   arb:     status ∈ {success, complex-success, refused, unsupported}
//            success → midpoint 55dp; `value_radius` is the certified ball
//              half-width (a 10dp scientific-notation real, or {re, im}
//              for complex). At L_pole, returns refused with
//              `arb_returned_token: "nan"`.
//            unsupported → InverseIncompleteGamma{P,Q}.
//
// Pure TS / Bun — no subprocess, no FFI. The whole file is one-shot
// `bun bench/gamma-anchor/cross-agreement.ts`; wall-time target < 30 s
// (typical: ~1 s on a 2024 laptop).

import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

// -----------------------------------------------------------------------------
// Oracle result shapes (unioned over the five adapters' schemas)
// -----------------------------------------------------------------------------

interface RawRecord {
  readonly input_id?: string;
  readonly id?: string;
  readonly head?: string;
  readonly status?: string;
  readonly value?: string | { re: string; im: string } | null;
  readonly value_radius?: string | { re: string; im: string } | null;
  readonly wolfram_returned_token?: string | null;
  readonly mpmath_returned_token?: string | null;
  readonly arb_returned_token?: string | null;
  readonly refuse_token?: string | null;
  readonly reason?: string;
  readonly notes?: string | null;
  readonly method?: string;
  readonly landmines?: readonly string[];
  readonly prec_attempts?: readonly number[] | null;
  readonly final_prec?: number | null;
}

interface RawFile {
  readonly oracle_id?: string;
  readonly oracle_version?: string;
  readonly tier?: string;
  readonly results: readonly RawRecord[];
}

// Corpus record (joined by id; carries tier + head + arg fields + notes).
// The notes field is critical: it carries landmine pins emitted by the
// generator (e.g. "L_pole: …", "Temme saddle: …", "Q1 |z|=…") that the
// downgrade machinery keys off when the per-oracle token alone is ambiguous.
interface CorpusInput {
  readonly id: string;
  readonly tier: string;
  readonly head: string;
  readonly z?: string | { re: string; im: string };
  readonly a?: { kind: string; value: string };
  readonly b?: { kind: string; value: string };
  readonly m?: { kind: string; value: string };
  readonly n?: { kind: string; value: string };
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
  boost: "silver", // real arb-prec via cpp_bin_float<50>
  scipy: "bronze", // float64
};

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
  | { kind: "refused"; reason: string; token?: string };

const LIMIT_TOKENS = new Set<string>([
  "Infinity",
  "-Infinity",
  "NaN",
  "ComplexInfinity",
  "Indeterminate",
]);

/**
 * Parse an oracle-emitted real-valued number string into a `ConcreteValue`.
 * Handles the full vocabulary of limit spellings the gamma oracles emit:
 *
 *   - Wolfram: `ComplexInfinity` (L17 poles), `Indeterminate`, plain decimals
 *     `"1"`, `"24"`, `"3.99168e7"`, scientific-with-`*^`-already-rewritten.
 *   - mpmath: 60-dp decimal strings; scientific `"8.21…e+87"`.
 *   - SciPy: `f"{x:.17g}"` — 17-sig-digit decimals; at L17 poles the value
 *     spelling becomes `"Infinity"` / `"-Infinity"` / `"NaN"` (with the
 *     adapter still emitting `status: "success"` for that case — Cephes's
 *     honest float64 answer).
 *   - Boost: 50-sig-digit scientific `"1.0000…e+00"` (with explicit `+` in
 *     the exponent; `expandScientific` handles both `+`/`-`/no-sign).
 *   - Arb: 55-dp truncated `"1.7724…"` or scientific.
 *
 * The "absurd exponent" guard at the bottom converts e.g. `1e500` to a limit
 * and `1e-500` to an effective-zero — defends against any oracle emitting a
 * scientific form past float64's normal range. None of the five v0.1 gamma
 * oracles do this in practice; the guard is parity with the Bessel comparator.
 */
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
  let sign = 1;
  let body = s.trim();
  if (body.startsWith("+")) body = body.slice(1);
  if (body.startsWith("-")) {
    sign = -1;
    body = body.slice(1);
  }
  // Absurd-exponent ⇒ overflow/underflow guard.
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
 * Map a raw oracle record onto a comparable `ConcreteValue`.
 *
 * Refusal-class statuses (`refused`, `unsupported`, `timeout`, `error`) all
 * collapse to `{kind: "refused", reason, token}`. The downstream comparator
 * distinguishes the cases via `token` (e.g. `"TypeError-complex-polygamma"`
 * for L14, `"ComplexInfinity"` for L17 Wolfram, the verbatim `reason` text
 * for Boost's `std-exception`).
 *
 * Wolfram's `wolfram_returned_token` carries the L17 pole spelling
 * (`"ComplexInfinity"` for every gamma-corpus pole — Wolfram does not
 * distinguish signed infinities here, unlike the Bessel case where it
 * sometimes emits unevaluated `BesselI[ν, Infinity]`). At L17 we surface
 * that token as a `limit`-class value via the `refused → limit` re-route:
 * pole-vs-pole across oracles is then a `limit-agree` comparison rather
 * than a `both-refused`. The re-route applies *only* to known limit tokens
 * (`ComplexInfinity`, `Indeterminate`, `Infinity`, `-Infinity`, `NaN`),
 * never to free-form reason text.
 */
function normaliseValue(oracleId: string, record: RawRecord): ConcreteValue {
  const status = record.status ?? "success";

  if (
    status === "refused" ||
    status === "unsupported" ||
    status === "timeout" ||
    status === "error"
  ) {
    let token: string | undefined;
    if (oracleId === "wolfram" && record.wolfram_returned_token) {
      token = record.wolfram_returned_token;
    } else if (oracleId === "mpmath" && record.mpmath_returned_token) {
      token = record.mpmath_returned_token;
    } else if (oracleId === "arb" && record.arb_returned_token) {
      token = record.arb_returned_token;
    } else if (oracleId === "scipy" && record.refuse_token) {
      token = record.refuse_token;
    } else if (record.reason) {
      token = record.reason;
    }

    // L17 limit re-route: when a refusal token is a known LIMIT_TOKEN,
    // surface as a `limit` so the comparator can pair pole-vs-pole as
    // a limit-agree rather than a both-refused.
    if (token && LIMIT_TOKENS.has(token)) {
      return { kind: "limit", symbol: token as LimitSym, raw: token };
    }

    const reason = record.reason ?? record.notes ?? token ?? status;
    return { kind: "refused", reason, token };
  }

  // SciPy emits "Infinity" / "-Infinity" / "NaN" inside `status: "success"`
  // at L17 poles (parseRealString recognises these as limit-class).
  const raw = record.value;

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
// Comparison primitives (digits + ULP)
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

/**
 * Number of leading decimal digits that agree between two decimal-string
 * representations. Both inputs are unsigned magnitudes (sign handled
 * separately). Returns `PERFECT_AGREEMENT` if the magnitudes are exactly
 * identical or both zero; returns 0 if the magnitudes have different
 * decimal exponents (different orders of magnitude).
 */
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

/** ULP distance between two float64 values, capped to `Infinity` for cross-type. */
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
 * Coarse magnitude (exp10) of `|a - b|` as a decimal string subtraction.
 * Returns `PERFECT_AGREEMENT` for exact equality; otherwise an exp10 value
 * suitable for comparison against a threshold like `-44` (= "diff < 1e-44").
 *
 * Used for the zero-crossing band check where both operands are near zero
 * and relative-digit-agreement collapses. We don't compute the full diff —
 * we estimate the magnitude from the leading-digit agreement count.
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
  if (
    aSign === bSign &&
    ca.zero === cb.zero &&
    ca.exp10 === cb.exp10 &&
    ca.sig === cb.sig
  ) {
    return PERFECT_AGREEMENT;
  }
  const maxExp = Math.max(ca.zero ? -1000 : ca.exp10, cb.zero ? -1000 : cb.exp10);
  if (aSign !== bSign) return maxExp;
  if (ca.exp10 !== cb.exp10) return maxExp;
  const k = digitsAgreeing(aDec, bDec);
  if (k === PERFECT_AGREEMENT) return PERFECT_AGREEMENT;
  return ca.exp10 - k;
}

// -----------------------------------------------------------------------------
// Limit-symbol normalisation
// -----------------------------------------------------------------------------

/**
 * Collapse the four-oracle pole vocabulary into a canonical comparison
 * symbol. Per L17 (R5 §6 / ADR-0042 §Decision 8 — "pole behaviour diverges
 * per oracle"):
 *
 *   Wolfram   `ComplexInfinity`  ≡ Infinity-class    (sign-less)
 *   mpmath    `ValueError(...)`  → refused (caught upstream in normaliseValue)
 *   SciPy     `+inf` / `-inf`    ≡ ±Infinity         (signed limit)
 *   SciPy     `nan`              ≡ NaN
 *   libm      `tgamma(-1)=nan`   ≡ NaN
 *   Boost     `std-exception`    → refused (caught upstream)
 *   Arb       non-finite ball    → refused (caught upstream, token "nan")
 *
 * `ComplexInfinity` ↦ `Infinity` is the load-bearing collapse: it lets
 * `wolfram-vs-scipy` at Γ(0) cross-validate as `limit-agree(Infinity)`
 * instead of triggering a warning. `Indeterminate` ↦ `NaN` is the
 * Wolfram-NaN spelling for cases where the result is honestly undefined.
 */
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
      token?: string;
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

/**
 * Tier-pair threshold per ADR-0042 §Decision 8 + ADR-0040 §Decision 8.
 *
 *   gold-gold:    ≥ 48 digits (50dp target − 2 last-place noise per L2/L11).
 *   gold-silver:  ≥ 46 digits (silver carries 1-2 ULP at the 50dp boundary).
 *   any-bronze:   ≥ 13 digits OR ≤ 256 ULP. The 256-ULP threshold mirrors
 *                 the Bessel comparator. SciPy/Cephes for gamma is libm-
 *                 quality (≤ 2-4 ULP) on the T1 happy path but degrades
 *                 in the Temme region (T7 v0.1 carve-out) and at L_polynew_4
 *                 large-a, small-z/a regimes; 256 absorbs the regular
 *                 transition-region noise without masking real algorithmic
 *                 disagreements.
 *
 * Returned thresholds parameterise the comparison primitive; they are
 * carried verbatim into the Agreement record so every finding documents
 * which threshold it was measured against.
 */
function thresholdForTierPair(
  tA: Tier,
  tB: Tier,
): { digits: number; ulp?: number } {
  if (tA === "bronze" || tB === "bronze") return { digits: 13, ulp: 256 };
  if (tA === "silver" || tB === "silver") return { digits: 46 };
  return { digits: 48 };
}

// -----------------------------------------------------------------------------
// Gamma-specific landmine downgrade rules (R5 §6 + ADR-0042 §Decision 8)
// -----------------------------------------------------------------------------

interface ComparisonContext {
  readonly corpus: CorpusInput | undefined;
  readonly arbRadius?: string | { re: string; im: string };
}

/**
 * Decide whether a disagreement above the tier threshold should be
 * downgraded to `info` because it falls under a documented gamma landmine
 * class. Returns `null` when no landmine applies (keep severity as-is).
 *
 * Categories emitted here, with R5 §6 citations:
 *
 *   - **L_pole / L17** — pole handling across oracles. The pole tokens
 *     (`ComplexInfinity`, `+Infinity`, `-Infinity`, `NaN`) are routed
 *     through `normaliseValue`'s limit re-route, so the typical pole-cell
 *     comparison goes through `limit-agree` or `limit-disagree` rather
 *     than refusal. This branch catches the residual cases where one
 *     oracle refuses cleanly (mpmath `ValueError`, arb `nan`, boost
 *     `std-exception`) and the other emits a limit token — that asymmetric
 *     refusal is honest, not a finding.
 *
 *   - **L12 — P/Q convention** — already canonicalised at the adapter
 *     layer (each adapter dispatches the correct head → primitive mapping
 *     per the L12 table). No comparator-side fix needed; this branch is
 *     a no-op gate that would fire only if a downstream adapter regressed
 *     on convention. The corpus encodes Upper, Lower, P, Q as four
 *     distinct heads precisely so the comparator never has to disambiguate.
 *
 *   - **L13 — InverseGammaRegularized convention** — also canonicalised
 *     at adapter layer. mpmath and arb refuse outright (`unsupported`);
 *     Wolfram inverts Q via the `InverseGammaRegularized[a, q]` 2-arg form;
 *     Boost has both inverses; SciPy has both. The corpus's separate
 *     `InverseIncompleteGammaP` / `InverseIncompleteGammaQ` heads route
 *     each adapter to the correct primitive.
 *
 *   - **L14 — SciPy complex polygamma + complex gammainc TypeError** —
 *     SciPy 1.17.0 raises `TypeError` on complex polygamma and complex
 *     gammainc/gammaincc. The adapter refuses cleanly with `refuse_token:
 *     "TypeError-complex-polygamma"` / `"TypeError-complex-gammainc"`.
 *     Asymmetric-refusal with this token is `info`.
 *
 *   - **L15 — SciPy `loggamma(real_negative) → NaN`** — SciPy's adapter
 *     re-routes through `loggamma(x + 0j)` so the success-class is a
 *     complex value. mpmath/Wolfram return the analytic continuation
 *     directly. When SciPy's complex `loggamma` disagrees with mpmath/
 *     Wolfram at the L15 boundary, the imaginary part is typically
 *     correct to bronze tolerance but the real part can drift past 13
 *     digits in transition regions — covered by the standard bronze
 *     ULP-256 threshold; no extra rule needed here.
 *
 *   - **L16 — BarnesG capability gap** — neither SciPy nor Boost ships
 *     BarnesG. Both refuse with `unsupported`; the asymmetric-refusal
 *     against any other oracle is `info`.
 *
 *   - **L18 — Boost digamma negative-half-integer bug** — `boost::math::
 *     digamma` returns the wrong value at z ∈ {−1/2, −3/2, …}: it reflects
 *     to ψ(1/2) instead of ψ(3/2) (DLMF §5.4.13, where π·cot(π·z)=0). All
 *     four other oracles and the workbench's own digamma agree on the
 *     correct value; the Boost-vs-other `decimal-agree` with `digits=0` is
 *     a documented upstream bug, not a substrate finding.
 *
 *   - **boost-no-complex / boost-no-pochhammer** — boost capability gaps.
 *     `unsupported` refusal asymmetric against any other oracle is `info`.
 *
 *   - **L_polynew_3 — BarnesG Adamchik convention** — R5 §6 reports both
 *     Wolfram and mpmath use the Adamchik/Vardi definition with G(1)=1,
 *     G(5)=12, etc. The probe confirms agreement to full precision on
 *     this corpus. The branch is a documentation no-op: if a future
 *     mpmath/Wolfram release breaks the convention assumption, the
 *     comparator's standard gold-gold tolerance will surface the
 *     disagreement as a real finding — exactly what we want.
 *
 *   - **v0.1 Temme T7 saddle carve-out** (ADR-0042 §"What we will not
 *     decide" — IncompleteGamma at `|z − a| ≤ C·√|a|` with `|a| ≥ 20`
 *     may lose `log₂(|a|)` bits). For T7 cells where Arb's `prec_attempts`
 *     show it had to retry past the 200-bit baseline, accept reduced
 *     gold-gold tolerance. (In v0.1 only 2 Arb cells retry — both T7
 *     Lower at `a=200` — and gold-tier agreement is still > 55 dp, so
 *     this branch is dormant on the current corpus.)
 *
 *   - **gold-bronze L_polynew_4 (large-a IncompleteGamma)** — R5 §6
 *     L_polynew_4: SciPy degrades at large-a, small-z/a; covered by the
 *     standard ULP-256 bronze threshold.
 */
function landmineDowngrade(
  oa: string,
  ob: string,
  agreement: Agreement,
  ctx: ComparisonContext,
): { category: string; reason: string } | null {
  const c = ctx.corpus;
  if (!c) return null;

  // -------------------------------------------------------------------------
  // L_boost_loggamma_real_only — Boost LogGamma returns log|Γ(z)| (real
  // part only) for real negative non-integer z, while gold-tier oracles
  // (Wolfram, mpmath, arb) and scipy return the analytic continuation
  // {re: log|Γ|, im: −π·k}. This shows up as a `shape-mismatch` (real-vs-
  // complex) for every T2 LogGamma cell. Documented in the Boost adapter
  // README ("Boost cannot represent that imaginary part in cpp_bin_float
  // <50> arithmetic") + ADR-0042 §"What we will not decide" / §LogGamma-
  // real-x<0. The gold-vs-gold and gold-vs-bronze pairs for the same row
  // still cross-validate against each other's complex value; Boost just
  // sits out the comparison.
  // -------------------------------------------------------------------------
  if (
    agreement.kind === "shape-mismatch" &&
    c.head === "LogGamma" &&
    (oa === "boost" || ob === "boost")
  ) {
    return {
      category: "L_boost_loggamma_real_only",
      reason: `Boost lgamma returns log|Γ| (real part only) for negative-real z; gold tier returns analytic continuation (ADR-0042 §LogGamma-real-x<0 + Boost README)`,
    };
  }

  // -------------------------------------------------------------------------
  // boost-beta-positive-args-only — Boost's boost::math::beta documents
  // "arguments must be greater than zero"; any negative a or b throws.
  // Other oracles (Wolfram, mpmath, arb, scipy) support the analytic-
  // continuation form via lgamma-subtraction with sign tracking and return
  // a finite value. Documented in R5 §3.4 + Boost README "Beta supported
  // (a, b > 0)". Asymmetric refusal-by-boost on Beta cells with negative
  // a or b is `info`.
  // -------------------------------------------------------------------------
  if (
    agreement.kind === "asymmetric-refusal" &&
    agreement.oracle_refused === "boost" &&
    c.head === "Beta" &&
    typeof agreement.token === "string" &&
    agreement.token.includes("must be greater than zero")
  ) {
    return {
      category: "boost-beta-positive-args-only",
      reason: `Boost beta requires a, b > 0 (R5 §3.4 + Boost README); other oracles handle analytic continuation. Refusal is honest.`,
    };
  }

  // -------------------------------------------------------------------------
  // L17-limit-pole-vocabulary — at exact integer poles for Gamma/Digamma,
  // the oracles emit DIFFERENT limit tokens that all canonicalise to "this
  // is a pole" but the spellings disagree:
  //   Wolfram → ComplexInfinity (→ "Infinity" after canonicalisation)
  //   SciPy   → +Infinity at z=0 (signed) and NaN at z=−1, −2, … (libm
  //             behaviour: tgamma(-1.0) returns NaN, not ±Inf).
  // R5 §6 L17: "four different behaviors: ComplexInfinity (Wolfram),
  // ValueError (mpmath), +∞ (SciPy+libm), nan (libm for negative
  // integers). The comparator must handle all four as 'pole' and skip
  // numeric comparison." So a `limit-disagree` between Wolfram's
  // ComplexInfinity/Infinity and SciPy's NaN at a Gamma/Digamma pole cell
  // is the documented L17 vocabulary mismatch — explained, not a finding.
  // -------------------------------------------------------------------------
  if (
    agreement.kind === "limit-disagree" &&
    isPoleCell(c) &&
    (c.head === "Gamma" || c.head === "Digamma")
  ) {
    return {
      category: "L17-pole-limit-vocabulary",
      reason: `${c.tier} ${c.head} at pole: oracles emit different limit tokens (ComplexInfinity / Infinity / NaN / -Infinity) — R5 §6 L17 four-behaviour table. All honest.`,
    };
  }

  // -------------------------------------------------------------------------
  // L18 — Boost.Math `digamma` is WRONG at negative half-integers.
  //
  // `boost::math::digamma(z)` for z ∈ {−1/2, −3/2, −5/2, …} returns the
  // value of ψ at the *positive* reflected argument instead of ψ(z). The
  // landmine row that surfaced it is corpus cell `T5-digamma-003`, z = −1/2:
  //
  //     boost::math::digamma(-0.5)  →  -1.9635100260214234   (= ψ(1/2))
  //     correct ψ(-1/2)             →   0.03648997397857652  (= ψ(3/2))
  //
  // DLMF §5.4.13 — the digamma reflection formula — is
  //   ψ(1 − z) − ψ(z) = π·cot(π·z).
  // At z = −1/2 the cotangent term is π·cot(−π/2) = 0, so ψ(−1/2) collapses
  // to ψ(1 − (−1/2)) = ψ(3/2). Boost evidently reflects to ψ(1/2) instead of
  // ψ(3/2) — an off-by-one in the reflection's `1 − z` argument that is
  // masked everywhere *except* the half-integers, where cot(π·z) = 0 makes
  // the reflected value the whole answer and the error fully visible.
  //
  // The four gold/silver/bronze oracles (arb, mpmath, scipy, wolfram) all
  // agree on the correct ψ(3/2) value to ≥ 48 decimal places. The workbench's
  // OWN digamma — both the I5 float64 port and the bigfloat arb-precision
  // path — also computes ψ(−1/2) correctly and carries an explicit guard
  // test, so this is purely an upstream Boost.Math 1.83 bug, not a workbench
  // substrate bug. It is recorded so a future bench regeneration does not
  // re-surface `T5-digamma-003` as an unexplained mystery.
  //
  // The comparison shows up as a `decimal-agree` with `digits = 0` (the two
  // values share no leading digits — one is ≈ −1.96, the other ≈ +0.036) on
  // every Boost-vs-{arb,mpmath,scipy,wolfram} pair. The rule fires only when
  // Boost is one side of the pair, the head is Digamma, and `z` is a negative
  // half-integer; that triple is specific enough that no honest disagreement
  // can be swallowed by it.
  // -------------------------------------------------------------------------
  if (
    agreement.kind === "decimal-agree" &&
    c.head === "Digamma" &&
    (oa === "boost" || ob === "boost") &&
    isNegativeHalfInteger(c.z)
  ) {
    return {
      category: "L18-boost-digamma-negative-half-integer",
      reason: `Boost.Math 1.83 digamma is wrong at negative half-integers: boost::math::digamma(${typeof c.z === "string" ? c.z : "?"}) reflects to ψ(1/2) instead of ψ(3/2) (DLMF §5.4.13 — π·cot(π·z)=0 here). arb/mpmath/scipy/wolfram and the workbench's own digamma all agree on the correct value; upstream Boost bug, not a substrate bug.`,
    };
  }

  // -------------------------------------------------------------------------
  // L_polynew_4_float64_overflow — at large-a IncompleteGamma{Upper,Lower}
  // (unregularised), the value can exceed float64's overflow boundary
  // (~1.8e+308). SciPy's path is `gammainc(a, z) · gamma(a)` or
  // `gammaincc(a, z) · gamma(a)`; for a = 200, Γ(200) ≈ 3.94e+372
  // overflows float64. SciPy emits `+Infinity` for the unregularised
  // Upper / Lower at large a; gold/silver oracles return the finite
  // ~1e+371 value at arb precision. Limit-vs-value with scipy as the
  // limit-side at IncompleteGammaUpper/Lower is explained. The regularised
  // P/Q heads do NOT overflow (they're bounded in [0, 1]) and continue
  // to cross-validate normally.
  // -------------------------------------------------------------------------
  if (
    agreement.kind === "limit-vs-value" &&
    agreement.limit_oracle === "scipy" &&
    (c.head === "IncompleteGammaUpper" || c.head === "IncompleteGammaLower") &&
    (agreement.limit_symbol === "Infinity" || agreement.limit_symbol === "-Infinity")
  ) {
    return {
      category: "L_polynew_4_float64_overflow",
      reason: `SciPy bronze (float64) overflows on unregularised IncompleteGamma{Upper,Lower} at large a; ${c.notes ?? ""}. Use regularised P/Q heads for bronze cross-validation.`,
    };
  }

  // -------------------------------------------------------------------------
  // L_T3_cancellation_stress — T3 cells near integer poles with documented
  // δ ∈ {1e-2, 1e-4} suffer reflection-formula cancellation; per ADR-0042
  // §Decision 3 the substrate (and gold-tier oracles) bumps work_prec by
  // `lossBits ≈ log₂(1/|δ|)`. At δ=1e-4, lossBits ≈ 13 bits ≈ 4 decimal
  // digits of float64 precision loss. SciPy float64 cannot bump precision;
  // its ULP-distance to gold can reach ~10^4. The cells' notes string
  // includes "cancellation stress" or "δ=" — keyed off there.
  // -------------------------------------------------------------------------
  if (
    agreement.kind === "ulp-agree" &&
    (oa === "scipy" || ob === "scipy") &&
    c.tier === "T3" &&
    typeof c.notes === "string" &&
    (c.notes.includes("cancellation stress") || c.notes.includes("near-pole"))
  ) {
    return {
      category: "L_T3_cancellation_stress",
      reason: `T3 reflection-formula cancellation (ADR-0042 §Decision 3); SciPy float64 cannot bump precision. ulp=${agreement.ulp}`,
    };
  }

  // Same for T8 — digamma near negative integers (worse cancellation,
  // lossBits up to 20 at δ=1e-6 per corpus-spec.md §T8).
  if (
    agreement.kind === "ulp-agree" &&
    (oa === "scipy" || ob === "scipy") &&
    c.tier === "T8"
  ) {
    return {
      category: "L_T8_digamma_cancellation_stress",
      reason: `T8 digamma reflection cancellation (corpus-spec.md §T8); ulp=${agreement.ulp}`,
    };
  }

  // -------------------------------------------------------------------------
  // SciPy L14 — asymmetric refusal for complex polygamma / complex gammainc.
  // -------------------------------------------------------------------------
  if (
    agreement.kind === "asymmetric-refusal" &&
    agreement.oracle_refused === "scipy" &&
    agreement.token &&
    (agreement.token === "TypeError-complex-polygamma" ||
      agreement.token === "TypeError-complex-gammainc")
  ) {
    return {
      category: "L14-scipy-complex-polygamma-known-refusal",
      reason: `SciPy 1.17 raises TypeError on complex polygamma / gammainc (R5 §6 L14); refusal is honest`,
    };
  }

  // -------------------------------------------------------------------------
  // L16 — BarnesG capability gap for SciPy and Boost.
  // -------------------------------------------------------------------------
  if (
    agreement.kind === "asymmetric-refusal" &&
    (agreement.oracle_refused === "scipy" || agreement.oracle_refused === "boost") &&
    c.head === "BarnesG"
  ) {
    return {
      category: "L16-no-barnesg-bronze-or-silver",
      reason: `SciPy / Boost have no BarnesG primitive (R5 §6 L16); refusal is a capability gap, not a bug`,
    };
  }

  // -------------------------------------------------------------------------
  // Boost capability gaps: no-complex, no-pochhammer, no-barnesg.
  // -------------------------------------------------------------------------
  if (
    agreement.kind === "asymmetric-refusal" &&
    agreement.oracle_refused === "boost"
  ) {
    const tok = agreement.token ?? "";
    if (tok.startsWith("boost-no-complex")) {
      return {
        category: "boost-no-complex",
        reason: `Boost cpp_bin_float has no std::complex instantiation (R5 §3.4); capability gap`,
      };
    }
    if (tok.startsWith("boost-no-pochhammer")) {
      return {
        category: "boost-no-pochhammer",
        reason: `Boost has no Pochhammer primitive; refusing rather than smuggling tgamma_ratio (R5 §3.4)`,
      };
    }
    if (tok.startsWith("boost-no-barnesg")) {
      return {
        category: "boost-no-barnesg",
        reason: `Boost has no BarnesG primitive (R5 §6 L16); capability gap`,
      };
    }
    // Boost std-exception at gamma poles — let the L_pole branch handle it.
  }

  // -------------------------------------------------------------------------
  // mpmath unsupported — InverseIncompleteGamma{P,Q} only.
  // -------------------------------------------------------------------------
  if (
    agreement.kind === "asymmetric-refusal" &&
    agreement.oracle_refused === "mpmath" &&
    (c.head === "InverseIncompleteGammaP" || c.head === "InverseIncompleteGammaQ")
  ) {
    return {
      category: "L13-mpmath-no-inverse-incomplete-gamma",
      reason: `mpmath has no native InverseIncompleteGamma{P,Q}; findroot substitute would not be byte-deterministic (R5 §6 L13)`,
    };
  }

  // -------------------------------------------------------------------------
  // arb unsupported — InverseIncompleteGamma{P,Q} only.
  // -------------------------------------------------------------------------
  if (
    agreement.kind === "asymmetric-refusal" &&
    agreement.oracle_refused === "arb" &&
    (c.head === "InverseIncompleteGammaP" || c.head === "InverseIncompleteGammaQ")
  ) {
    return {
      category: "L13-arb-no-inverse-incomplete-gamma",
      reason: `python-flint 0.8.0 has no native InverseIncompleteGamma{P,Q}; Newton substitute not byte-deterministic`,
    };
  }

  // -------------------------------------------------------------------------
  // L_pole / L17 — pole handling across oracles. After the L17 limit re-route
  // in normaliseValue, the typical pole cell is a `limit-agree` (info) and
  // doesn't reach this function. Residual cases:
  //
  //  (a) `both-refused` already info (no downgrade needed).
  //  (b) `asymmetric-refusal` where one oracle is at a pole and the other
  //      emits a limit token that the L17 re-route surfaced as limit. The
  //      `limit-vs-value`-like asymmetry shows up here when the refusal-side
  //      oracle has no limit-token mapping (mpmath ValueError, boost
  //      std-exception, arb `nan` refusal). Mark as info — all three
  //      refusals are honest "this is a pole" answers.
  //  (c) `limit-disagree` where the limit symbols differ — Wolfram's
  //      `Infinity` (sign-less) vs scipy's `+Infinity` / `-Infinity` /
  //      `NaN`. Already canonicalised in `normaliseLimitSymbol`; residual
  //      disagreement here is real and worth surfacing as warn.
  // -------------------------------------------------------------------------
  if (
    agreement.kind === "asymmetric-refusal" &&
    isPoleCell(c)
  ) {
    return {
      category: "L17-pole-asymmetric-refusal",
      reason: `${c.tier} ${c.head} at pole; oracles refuse differently (Wolfram ComplexInfinity → limit, mpmath/boost/arb refused). All honest.`,
    };
  }

  // -------------------------------------------------------------------------
  // v0.1 Temme T7 saddle carve-out. ADR-0042 §"What we will not decide":
  // saddle region tolerates `precision − log₂(|a|)` bits. Surfaces as
  // gold-gold agreement at fewer-than-48-digits for the 2 cells where Arb
  // had to retry. Threshold: at a=200, log₂(200) ≈ 7.6, so we accept
  // gold-gold ≥ 40 digits (48 − 8) on T7 cells.
  // -------------------------------------------------------------------------
  if (
    c.tier === "T7" &&
    agreement.kind === "decimal-agree" &&
    agreement.digits >= 40 &&
    agreement.digits < agreement.threshold
  ) {
    return {
      category: "v0.1-Temme-T7-saddle-carve-out",
      reason: `T7 Temme saddle region: v0.1 dispatch may lose log₂(|a|) bits (ADR-0042); ${agreement.digits} digits agree, threshold ${agreement.threshold}`,
    };
  }

  // -------------------------------------------------------------------------
  // L_polynew_4 — large-a IncompleteGamma at SciPy bronze. The standard
  // ULP-256 threshold catches the typical case; this branch catches the
  // ulp > 256 but ≤ 10^7 cases where SciPy is still inside transition-
  // region tolerance per R5 §6 L_polynew_4.
  // -------------------------------------------------------------------------
  if (
    agreement.kind === "ulp-agree" &&
    (oa === "scipy" || ob === "scipy") &&
    (c.head === "IncompleteGammaUpper" ||
      c.head === "IncompleteGammaLower" ||
      c.head === "IncompleteGammaP" ||
      c.head === "IncompleteGammaQ" ||
      c.head === "InverseIncompleteGammaP" ||
      c.head === "InverseIncompleteGammaQ") &&
    agreement.ulp < 10_000_000 &&
    agreement.ulp > agreement.threshold
  ) {
    return {
      category: "L_polynew_4-scipy-large-a-incomplete-gamma",
      reason: `SciPy IncompleteGamma transition-region ULP-class (R5 §6 L_polynew_4); ulp=${agreement.ulp}`,
    };
  }

  // -------------------------------------------------------------------------
  // SciPy / Boost: large-magnitude T6 cells where float64 carries ≥ 16 digits
  // out of the 50dp gold value and the relative-digit count saturates at
  // ~13-15 digits. The standard bronze ULP-256 already catches the well-
  // behaved cases; this branch covers digit-counting comparisons where
  // both operands have very large exp10 and the digit-agreement count is
  // bounded by float64's ~15.95 digit precision.
  // -------------------------------------------------------------------------
  if (
    agreement.kind === "decimal-agree" &&
    (oa === "scipy" || ob === "scipy") &&
    agreement.digits >= 13 &&
    agreement.digits < agreement.threshold
  ) {
    return {
      category: "scipy-bronze-13-digit-floor",
      reason: `SciPy bronze tier (float64, ~15.95 digits); ${agreement.digits} digits agree — within bronze envelope`,
    };
  }

  // -------------------------------------------------------------------------
  // Boost silver tail-cancellation, mirroring the Bessel L4 downgrade.
  // When Boost's cpp_bin_float<50> loses 1-4 digits in connection-formula
  // cancellation (e.g. for negative-a Beta refusals, or near integer
  // boundaries), 30+ digits of agreement is silver-tier-honest.
  // -------------------------------------------------------------------------
  if (
    agreement.kind === "decimal-agree" &&
    (oa === "boost" || ob === "boost") &&
    agreement.digits >= 30 &&
    agreement.digits < agreement.threshold
  ) {
    return {
      category: "boost-silver-tail-cancellation",
      reason: `Boost cpp_bin_float<50> tail-cancellation; ${agreement.digits} digits agree (threshold ${agreement.threshold})`,
    };
  }

  return null;
}

/**
 * Heuristic: is this corpus row a pole cell?
 *
 * Criteria:
 *   - corpus notes mention "L_pole" / "L17" / "pole" explicitly, OR
 *   - tier T3 cell with notes "near-pole δ=0" pattern, OR
 *   - head is Gamma or Digamma and the input z (real) is a non-positive
 *     integer (parses cleanly with empty fractional part).
 *
 * This is a documentation aid for the downgrade branch — the actual L17
 * pole-as-limit handling lives in `normaliseValue`'s L17 re-route, which
 * keys off the per-oracle token vocabulary directly.
 */
function isPoleCell(c: CorpusInput): boolean {
  const notes = c.notes ?? "";
  if (
    notes.includes("L_pole") ||
    notes.includes("L17") ||
    notes.includes("pole δ=0") ||
    notes.includes("at-pole")
  ) {
    return true;
  }
  // T3 cells at exact-integer z for Gamma/Digamma (pole heads).
  if (
    c.tier === "T3" &&
    (c.head === "Gamma" || c.head === "Digamma") &&
    typeof c.z === "string"
  ) {
    const ca = canonicalScientific(c.z.replace(/^-/, ""));
    // Integer if the canonical form has no fractional digits past exp10.
    const intish = ca.zero || (ca.sig.length <= ca.exp10);
    if (intish) return true;
  }
  return false;
}

/**
 * Heuristic: is this corpus row's real argument `z` a *negative half-integer*
 * — that is, an odd multiple of 1/2 that is strictly negative
 * (… −5/2, −3/2, −1/2)?
 *
 * This is the trigger geometry for landmine L18 (Boost.Math `digamma`
 * negative-half-integer bug — see `landmineDowngrade`). The check is
 * deliberately narrow: it returns `true` only for a clean real `z` whose
 * canonical decimal expansion is exactly `<odd-integer>.5` with the leading
 * `-` sign. Complex `z`, integers, and any other fractional part all return
 * `false` so the rule cannot accidentally swallow an unrelated finding.
 *
 * Implementation: the corpus stores `z` as a fixed-point decimal literal
 * (the 60-dp form `-0.500000…000`, never scientific notation — see
 * `corpus-spec.md` §"Number formatting"). We split on the decimal point and
 * strip trailing zeros from the fractional part; a half-integer is exactly
 * the case where that trimmed fractional part is the single digit `"5"`
 * (e.g. `0.5`, `1.5`, `2.5`) and the integer part is a plain run of digits.
 * The leading `-` is required, so positive half-integers and integers are
 * both rejected. Keeping the test purely string-shaped avoids any float
 * round-trip and is exact for every literal the corpus can hold.
 */
function isNegativeHalfInteger(
  z: string | { re: string; im: string } | undefined,
): boolean {
  if (typeof z !== "string") return false;
  if (!z.startsWith("-")) return false;
  const mag = z.slice(1);
  const [intPart, fracPartRaw] = splitDecimal(mag);
  const fracPart = fracPartRaw.replace(/0+$/, "");
  // The fractional part of a half-integer is exactly "5" (e.g. 1.5, 2.5).
  if (fracPart !== "5") return false;
  // The integer part must itself be a non-negative integer; "0.5", "1.5",
  // "2.5" all qualify. (Leading zeros are immaterial.)
  if (!/^\d+$/.test(intPart)) return false;
  return true;
}

/**
 * Apply the Arb `value_radius` ball width as an error budget. When the
 * disagreement digits exceed `−radExp10 − 2`, the disagreement falls within
 * Arb's certified containment ball — both oracles are inside the bracket;
 * the disagreement is statistical noise within the ball, not a substrate
 * error. Returns `null` when arb is not in the pair or no radius is
 * available or the radius does not bracket the disagreement.
 */
function applyArbRadius(
  oa: string,
  ob: string,
  agreement: Agreement,
  arbRadius: string | { re: string; im: string } | undefined,
): { category: string; reason: string } | null {
  if (!arbRadius) return null;
  if (oa !== "arb" && ob !== "arb") return null;
  if (agreement.kind !== "decimal-agree") return null;
  // For complex value_radius, take the larger of the two components — that
  // is the tighter upper bound on the ball in either projection.
  const radStr =
    typeof arbRadius === "string" ? arbRadius : largerRadius(arbRadius);
  const m = radStr.match(/e([+-]?\d+)/i);
  // If the radius is plain "0" (or no exponent), Arb is certifying exact —
  // any non-zero disagreement is real.
  if (!m) return null;
  const radExp = parseInt(m[1], 10);
  // Conservative: digits-implied ≈ -(radExp) - 2 (the −2 absorbs the
  // mantissa magnitude). If we agree to that many digits, the disagreement
  // is within 2·value_radius.
  const radImpliedDigits = -radExp - 2;
  if (agreement.digits >= radImpliedDigits) {
    return {
      category: "within-arb-radius",
      reason: `disagreement within Arb ball width 2·value_radius (~${radStr}); ${agreement.digits} ≥ ~${radImpliedDigits} digits`,
    };
  }
  return null;
}

function largerRadius(r: { re: string; im: string }): string {
  const mr = r.re.match(/e([+-]?\d+)/i);
  const mi = r.im.match(/e([+-]?\d+)/i);
  const reExp = mr ? parseInt(mr[1], 10) : -1000;
  const imExp = mi ? parseInt(mi[1], 10) : -1000;
  return reExp >= imExp ? r.re : r.im;
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
    return {
      kind: "asymmetric-refusal",
      severity: "warn",
      tier_pair,
      oracle_refused: oa,
      token: va.token ?? va.reason,
    };
  }
  if (vb.kind === "refused") {
    return {
      kind: "asymmetric-refusal",
      severity: "warn",
      tier_pair,
      oracle_refused: ob,
      token: vb.token ?? vb.reason,
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

  // Asymmetric: one limit, one concrete.
  if (va.kind === "limit" || vb.kind === "limit") {
    const limitOracle = va.kind === "limit" ? oa : ob;
    const limitSym =
      va.kind === "limit"
        ? normaliseLimitSymbol(va.symbol)
        : vb.kind === "limit"
          ? normaliseLimitSymbol(vb.symbol)
          : "";
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
    // SciPy at L15 (loggamma real-negative) emits complex {re, im}; the
    // matching mpmath/Wolfram value is also complex. Both real or both
    // complex — but a real-real corpus row where one oracle returns
    // {re,im} and another returns scalar is honestly a shape disagreement.
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

  // Zero-crossing band: both values canonicalise to zero. Switch to
  // absolute-error comparison; tolerance ≈ 10^{-(tier_floor − 4)} per
  // the Bessel precedent (the 4-digit pad absorbs catastrophic
  // cancellation amplification right at the zero).
  if (bothZero) {
    return {
      kind: "abs-agree",
      severity: "info",
      tier_pair,
      magnitude_exp10: PERFECT_AGREEMENT,
      threshold_exp10: -100,
      category: "zero-crossing-band",
    };
  }

  // Near-zero band: one operand canonicalises to zero, the other is non-zero
  // but very small (exp10 ≤ -tier_floor + 4). Treat as abs-agree if the
  // non-zero operand magnitude is within the band.
  const ca = canonicalScientific(va.decimal);
  const cb = canonicalScientific(vb.decimal);
  if ((ca.zero || cb.zero) && !bothZero) {
    const tierFloor = thresholdForTierPair(tierA, tierB).digits;
    const nonZeroExp = ca.zero ? cb.exp10 : ca.exp10;
    const thresholdExp10 = -(tierFloor - 4);
    return {
      kind: "abs-agree",
      severity: nonZeroExp <= thresholdExp10 ? "info" : "warn",
      tier_pair,
      magnitude_exp10: nonZeroExp,
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
    // For very large magnitudes (T6 cells, lgamma ~5905 etc.), float64
    // Number() truncates the gold-tier 50dp value at ~16 digits. Use the
    // digit-count metric as the primary signal; ULP as a secondary.
    const ulp = ulpDistance(aN, bN);
    const threshold = thresholdForTierPair(tierA, tierB).ulp ?? 4;
    const digits = digitsAgreeing(va.decimal, vb.decimal);
    const digitsThreshold = thresholdForTierPair(tierA, tierB).digits;
    // Pass if EITHER digit-count OR ULP-distance is within budget.
    const okByUlp = ulp <= threshold;
    const okByDigits = digits >= digitsThreshold;
    return {
      kind: "ulp-agree",
      severity: okByUlp || okByDigits ? "info" : "warn",
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
  notes?: string;
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
  bead: string;
  oracles: OracleSummary[];
  oracle_versions: Record<string, string>;
  tier_thresholds: Record<string, string>;
  phase_1_gate: {
    status: "PASS" | "FAIL";
    unexplained_count: number;
    threshold: number;
    computed_at: string;
  };
  summary: {
    total_comparisons: number;
    agreed: number;
    agreed_refusal: number;
    explained: number;
    disagreed_within_tier: number;
    unexplained: number;
  };
  pair_matrix: Record<
    string,
    { agreed: number; explained: number; unexplained: number; total: number }
  >;
  by_head: Record<
    string,
    { agreed: number; explained: number; unexplained: number; total: number }
  >;
  by_tier: Record<
    string,
    { agreed: number; explained: number; unexplained: number; total: number }
  >;
  landmine_categories: Record<string, number>;
  findings: Finding[];
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

/**
 * Classify a finished `Agreement` into one of the five top-level buckets:
 *
 *   - `agreed`              — info, value-based (decimal/ulp/abs/limit-agree).
 *   - `agreed_refusal`      — info, both-refused.
 *   - `explained`           — would have been warn, but a landmine downgraded
 *                             it to info; the `category` field documents which.
 *   - `disagreed_within_tier` — warn but with digits ≥ floor of a looser
 *                             cross-tier band (e.g. gold-vs-gold diverging
 *                             at digit 47 — still a finding because tier
 *                             tolerance is 48, but within the wider band).
 *   - `unexplained`         — warn or error with no downgrade applied.
 *
 * These map 1-to-1 onto the gate's `unexplained` counter.
 */
function classify(
  agreement: Agreement,
): "agreed" | "agreed_refusal" | "explained" | "disagreed_within_tier" | "unexplained" {
  if (agreement.kind === "both-refused") return "agreed_refusal";
  if (agreement.severity === "info") {
    if ((agreement as { category?: string }).category) {
      // Landmine-downgraded explanation, OR a built-in info category like
      // "zero-crossing-band" / "within-arb-radius". Treat the within-arb
      // and zero-crossing ones as `agreed` rather than `explained`, since
      // they're not landmine downgrades but principled numeric carve-outs.
      const cat = (agreement as { category?: string }).category!;
      if (cat === "zero-crossing-band" || cat === "within-arb-radius") {
        return "agreed";
      }
      return "explained";
    }
    return "agreed";
  }
  // Severity is warn or error. Sub-classify by whether the digit count
  // landed within a wider permissive band — e.g. gold-vs-gold at 45 digits
  // (below 48 threshold but above the 30-digit "real disagreement" floor).
  if (
    agreement.kind === "decimal-agree" &&
    agreement.digits >= Math.max(15, agreement.threshold - 6)
  ) {
    return "disagreed_within_tier";
  }
  if (
    agreement.kind === "ulp-agree" &&
    agreement.ulp <= (agreement.threshold ?? 256) * 16
  ) {
    return "disagreed_within_tier";
  }
  return "unexplained";
}

function buildReport(
  oracles: Map<string, { meta: RawFile; records: RawRecord[] }>,
  corpus: Map<string, CorpusInput>,
): AgreementReport {
  const indexed = new Map<string, Map<string, RawRecord>>();
  for (const [id, { records }] of oracles) {
    const m = new Map<string, RawRecord>();
    for (const r of records) m.set(recordKey(r), r);
    indexed.set(id, m);
  }
  const oracleIds = [...oracles.keys()].sort();

  const entries: AgreementEntry[] = [];
  const findings: Finding[] = [];
  const pairMatrix: AgreementReport["pair_matrix"] = {};
  const byHead: AgreementReport["by_head"] = {};
  const byTier: AgreementReport["by_tier"] = {};
  const landmineCategories: Record<string, number> = {};

  let agreedTotal = 0;
  let agreedRefusalTotal = 0;
  let explainedTotal = 0;
  let disagreedWithinTotal = 0;
  let unexplainedTotal = 0;

  // Sort by input_id for deterministic JSON output (byte-identical re-runs).
  const corpusIds = [...corpus.keys()].sort();
  for (const id of corpusIds) {
    const c = corpus.get(id)!;
    const head = c.head;
    const tier = c.tier;

    const normalised = new Map<string, ConcreteValue>();
    let arbRadius: string | { re: string; im: string } | undefined;
    for (const oid of oracleIds) {
      const rec = indexed.get(oid)?.get(id);
      if (!rec) continue;
      normalised.set(oid, normaliseValue(oid, rec));
      if (oid === "arb") {
        const r = rec.value_radius;
        if (r !== null && r !== undefined) arbRadius = r;
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

        // Apply landmine downgrade FIRST, then arb-radius as a fallback.
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

        const classification = classify(agreement);
        const pairKey = `${oa}-${ob}`;
        const slot = (pairMatrix[pairKey] ??= {
          agreed: 0,
          explained: 0,
          unexplained: 0,
          total: 0,
        });
        slot.total++;
        if (classification === "agreed" || classification === "agreed_refusal") {
          slot.agreed++;
          agreedTotal += classification === "agreed" ? 1 : 0;
          agreedRefusalTotal += classification === "agreed_refusal" ? 1 : 0;
        } else if (classification === "explained") {
          slot.explained++;
          explainedTotal++;
        } else if (classification === "disagreed_within_tier") {
          slot.unexplained++; // still a finding
          disagreedWithinTotal++;
        } else {
          slot.unexplained++;
          unexplainedTotal++;
        }

        const headSlot = (byHead[head] ??= {
          agreed: 0,
          explained: 0,
          unexplained: 0,
          total: 0,
        });
        headSlot.total++;
        if (classification === "agreed" || classification === "agreed_refusal") {
          headSlot.agreed++;
        } else if (classification === "explained") {
          headSlot.explained++;
        } else {
          headSlot.unexplained++;
        }

        const tierSlot = (byTier[tier] ??= {
          agreed: 0,
          explained: 0,
          unexplained: 0,
          total: 0,
        });
        tierSlot.total++;
        if (classification === "agreed" || classification === "agreed_refusal") {
          tierSlot.agreed++;
        } else if (classification === "explained") {
          tierSlot.explained++;
        } else {
          tierSlot.unexplained++;
        }

        if (
          classification === "explained" ||
          classification === "disagreed_within_tier" ||
          classification === "unexplained"
        ) {
          findings.push({
            severity: agreement.severity,
            input_id: id,
            head,
            tier,
            oracle_a: oa,
            oracle_b: ob,
            category: (agreement as { category?: string }).category,
            detail: agreement,
            notes: c.notes,
          });
        }
      }
    }
    entries.push({ input_id: id, head, tier, pairs });
  }

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

  const oracleVersions: Record<string, string> = {};
  for (const o of oracleSummaries) oracleVersions[o.id] = o.version;

  const totalPairs = Object.values(pairMatrix).reduce(
    (s, v) => s + v.total,
    0,
  );

  const now = new Date().toISOString();
  const gateStatus: "PASS" | "FAIL" =
    unexplainedTotal < 50 ? "PASS" : "FAIL";

  return {
    generated_at: now,
    corpus: "bench/gamma-anchor/corpus.json",
    corpus_total_inputs: corpus.size,
    bead: "scientist-workbench-fab6",
    oracles: oracleSummaries,
    oracle_versions: oracleVersions,
    tier_thresholds: {
      "gold-gold":
        "≥ 48 digits agree at 50dp gold target (60dp working precision; L2/L11 last 2 digits noise)",
      "gold-silver":
        "≥ 46 digits (Boost cpp_bin_float<50> carries 1-2 ULP at the 50dp boundary)",
      "any-bronze":
        "≥ 13 digits OR ≤ 256 ULP (SciPy float64 ~15.95 digits; ULP envelope absorbs L_polynew_4 transition noise)",
      "zero-crossing-band":
        "abs-error comparison when both values canonicalise to zero or one is below tier floor",
      "within-arb-radius":
        "disagreement within 2 · Arb value_radius — inside the certified containment ball",
    },
    phase_1_gate: {
      status: gateStatus,
      unexplained_count: unexplainedTotal,
      threshold: 50,
      computed_at: now,
    },
    summary: {
      total_comparisons: totalPairs,
      agreed: agreedTotal,
      agreed_refusal: agreedRefusalTotal,
      explained: explainedTotal,
      disagreed_within_tier: disagreedWithinTotal,
      unexplained: unexplainedTotal,
    },
    pair_matrix: pairMatrix,
    by_head: byHead,
    by_tier: byTier,
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
  lines.push(
    `# PHASE 1 GATE: ${report.phase_1_gate.status} (${report.phase_1_gate.unexplained_count} unexplained, threshold ${report.phase_1_gate.threshold})`,
  );
  lines.push("");
  lines.push(`# bench/gamma-anchor — cross-oracle agreement matrix`);
  lines.push("");
  lines.push(`Generated: ${report.generated_at}`);
  lines.push(
    `Bead: ${report.bead} (Phase 1 GATE per ADR-0042 §"Decision 8" + R5 §6).`,
  );
  lines.push(`Corpus: ${report.corpus} (${report.corpus_total_inputs} inputs).`);
  lines.push("");

  lines.push(`## Phase 1 Gate Verdict`);
  lines.push("");
  if (report.phase_1_gate.status === "PASS") {
    lines.push(
      `**PASS** — ${report.phase_1_gate.unexplained_count} unexplained findings (threshold ${report.phase_1_gate.threshold}). Phase 2 substrate beads unblocked.`,
    );
  } else {
    lines.push(
      `**FAIL** — ${report.phase_1_gate.unexplained_count} unexplained findings ≥ threshold ${report.phase_1_gate.threshold}. Investigate before Phase 2.`,
    );
  }
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
  lines.push(`- agreed (value within tier threshold): **${report.summary.agreed}**`);
  lines.push(`- agreed_refusal (both refused): **${report.summary.agreed_refusal}**`);
  lines.push(
    `- explained (landmine downgrade): **${report.summary.explained}**`,
  );
  lines.push(
    `- disagreed_within_tier (warn but within wider band): **${report.summary.disagreed_within_tier}**`,
  );
  lines.push(`- unexplained (real findings): **${report.summary.unexplained}**`);
  lines.push("");

  lines.push(`### Per oracle pair`);
  lines.push("");
  lines.push("| pair | total | agreed | explained | unexplained | agree-rate |");
  lines.push("|---|---|---|---|---|---|");
  for (const [pair, c] of Object.entries(report.pair_matrix).sort()) {
    const rate = c.total > 0 ? ((c.agreed / c.total) * 100).toFixed(1) : "0.0";
    lines.push(
      `| ${pair} | ${c.total} | ${c.agreed} | ${c.explained} | ${c.unexplained} | ${rate}% |`,
    );
  }
  lines.push("");

  lines.push(`### Per head`);
  lines.push("");
  lines.push("| head | total | agreed | explained | unexplained |");
  lines.push("|---|---|---|---|---|");
  for (const [h, c] of Object.entries(report.by_head).sort()) {
    lines.push(`| ${h} | ${c.total} | ${c.agreed} | ${c.explained} | ${c.unexplained} |`);
  }
  lines.push("");

  lines.push(`### Per corpus tier`);
  lines.push("");
  lines.push("| tier | total | agreed | explained | unexplained |");
  lines.push("|---|---|---|---|---|");
  for (const [t, c] of Object.entries(report.by_tier).sort()) {
    lines.push(`| ${t} | ${c.total} | ${c.agreed} | ${c.explained} | ${c.unexplained} |`);
  }
  lines.push("");

  if (Object.keys(report.landmine_categories).length > 0) {
    lines.push(`### Landmine downgrades (warn → info)`);
    lines.push("");
    lines.push(
      "Each entry is a pair-wise comparison that *would* be a warning under" +
        " the tier threshold but is downgraded to `info` because it falls under" +
        " a documented Gamma landmine class (R5 §6 + ADR-0042 §Decision 8).",
    );
    lines.push("");
    lines.push("| category | count | meaning |");
    lines.push("|---|---|---|");
    const meanings: Record<string, string> = {
      "L14-scipy-complex-polygamma-known-refusal":
        "SciPy 1.17 raises TypeError on complex polygamma/gammainc (R5 §6 L14)",
      "L16-no-barnesg-bronze-or-silver":
        "SciPy / Boost have no BarnesG primitive (R5 §6 L16)",
      "boost-no-complex":
        "Boost cpp_bin_float has no std::complex instantiation (R5 §3.4)",
      "boost-no-pochhammer":
        "Boost has no Pochhammer primitive (R5 §3.4)",
      "boost-no-barnesg":
        "Boost has no BarnesG primitive (R5 §6 L16)",
      "L13-mpmath-no-inverse-incomplete-gamma":
        "mpmath has no native InverseIncompleteGamma{P,Q} (R5 §6 L13)",
      "L13-arb-no-inverse-incomplete-gamma":
        "python-flint 0.8.0 has no native InverseIncompleteGamma{P,Q}",
      "L17-pole-asymmetric-refusal":
        "Pole cell: oracles refuse differently (R5 §6 L17). All honest.",
      "v0.1-Temme-T7-saddle-carve-out":
        "T7 Temme saddle: v0.1 dispatch may lose log₂(|a|) bits (ADR-0042)",
      "L_polynew_4-scipy-large-a-incomplete-gamma":
        "SciPy IncompleteGamma transition-region (R5 §6 L_polynew_4)",
      "scipy-bronze-13-digit-floor":
        "SciPy float64 ~15.95 digit precision; ≥13 digits is within bronze envelope",
      "boost-silver-tail-cancellation":
        "Boost cpp_bin_float<50> tail-cancellation (≥30 digits agree)",
      "within-arb-radius":
        "Disagreement inside 2·Arb value_radius certified ball",
      "zero-crossing-band":
        "Both values near zero; abs-error comparison instead of relative",
      "L_boost_loggamma_real_only":
        "Boost lgamma returns log|Γ| (real part only) at negative-real z; gold tier returns analytic continuation (ADR-0042 §LogGamma-real-x<0)",
      "boost-beta-positive-args-only":
        "Boost beta requires a, b > 0 (R5 §3.4); other oracles handle analytic continuation",
      "L17-pole-limit-vocabulary":
        "Pole: oracles emit different limit tokens (ComplexInfinity / Infinity / NaN / −Infinity) per R5 §6 L17",
      "L_polynew_4_float64_overflow":
        "SciPy float64 overflows on unregularised IncompleteGamma{Upper,Lower} at large a; gold/silver return finite",
      "L_T3_cancellation_stress":
        "T3 reflection-formula cancellation (ADR-0042 §Decision 3); SciPy float64 cannot bump precision",
      "L_T8_digamma_cancellation_stress":
        "T8 digamma reflection cancellation (corpus-spec.md §T8)",
      "L18-boost-digamma-negative-half-integer":
        "Boost.Math 1.83 digamma is wrong at negative half-integers — reflects to ψ(1/2) instead of ψ(3/2) (DLMF §5.4.13). arb/mpmath/scipy/wolfram + workbench digamma all correct; upstream Boost bug.",
    };
    for (const [cat, count] of Object.entries(
      report.landmine_categories,
    ).sort()) {
      lines.push(`| ${cat} | ${count} | ${meanings[cat] ?? "(undocumented)"} |`);
    }
    lines.push("");
  }

  if (report.findings.length > 0) {
    lines.push(`## Findings (${report.findings.length} total)`);
    lines.push("");
    lines.push(
      "Findings include both `unexplained` (real candidate substrate-bugs) and " +
        "`explained` (landmine-downgraded, info severity, included here for audit).",
    );
    lines.push("");
    lines.push(
      "Per ADR-0042 §Decision 8 thresholds (gold-gold ≥ 48 digits, " +
        "gold-silver ≥ 46, any-bronze ≥ 13 digits OR ≤ 256 ULP).",
    );
    lines.push("");

    // Sort: unexplained first, then disagreed_within_tier, then explained;
    // within each group by tier, head, input_id, oracle pair (deterministic).
    const rank = (f: Finding): number => {
      const c = classify(f.detail);
      if (c === "unexplained") return 0;
      if (c === "disagreed_within_tier") return 1;
      if (c === "explained") return 2;
      return 3;
    };
    const sorted = [...report.findings].sort((a, b) => {
      const r = rank(a) - rank(b);
      if (r !== 0) return r;
      const t = a.tier.localeCompare(b.tier);
      if (t !== 0) return t;
      const h = a.head.localeCompare(b.head);
      if (h !== 0) return h;
      const i = a.input_id.localeCompare(b.input_id);
      if (i !== 0) return i;
      return `${a.oracle_a}-${a.oracle_b}`.localeCompare(`${b.oracle_a}-${b.oracle_b}`);
    });

    lines.push(
      "| class | input_id | tier | head | a | b | kind | detail | category |",
    );
    lines.push("|---|---|---|---|---|---|---|---|---|");
    const cap = 400;
    for (const f of sorted.slice(0, cap)) {
      const c = classify(f.detail);
      const d = f.detail;
      let detail = "";
      switch (d.kind) {
        case "asymmetric-refusal":
          detail = `refused-by ${d.oracle_refused}${(d as { token?: string }).token ? ` (${(d as { token?: string }).token})` : ""}`;
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
        `| ${c} | ${f.input_id} | ${f.tier} | ${f.head} | ${f.oracle_a} | ${f.oracle_b} | ${d.kind} | ${detail} | ${f.category ?? ""} |`,
      );
    }
    if (sorted.length > cap) {
      lines.push(
        `| … | … | … | … | … | … | … | … | (${sorted.length - cap} more — see agreement-data.json) |`,
      );
    }
  } else {
    lines.push(`## Findings`);
    lines.push("");
    lines.push(
      "No findings — every pair-wise comparison agreed within its tier",
    );
    lines.push("threshold. Phase 1 GATE passes.");
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
      "No oracle results.json found under bench/gamma-anchor/oracles/<id>/. Run the adapters first.",
    );
    process.exit(1);
  }
  const corpus = loadCorpus();
  console.log(
    `Loaded oracles: ${[...oracles.keys()].join(", ")} (${corpus.size} corpus inputs)`,
  );
  const report = buildReport(oracles, corpus);

  const dataPath = fileURLToPath(
    new URL("./agreement-data.json", import.meta.url),
  );
  const mdPath = fileURLToPath(
    new URL("./agreement-matrix.md", import.meta.url),
  );
  const jsonText = JSON.stringify(report, null, 2) + "\n";
  writeFileSync(dataPath, jsonText);
  writeFileSync(mdPath, renderMarkdown(report));

  const sha = createHash("sha256").update(jsonText).digest("hex");
  console.log(`Wrote ${dataPath}`);
  console.log(`Wrote ${mdPath}`);
  console.log(`agreement-data.json sha256: ${sha}`);
  console.log(
    `Total pairs: ${report.summary.total_comparisons} (agreed: ${report.summary.agreed}, both-refused: ${report.summary.agreed_refusal}, explained: ${report.summary.explained}, within-tier: ${report.summary.disagreed_within_tier}, unexplained: ${report.summary.unexplained})`,
  );
  if (report.phase_1_gate.status === "PASS") {
    console.log(
      `Phase 1 GATE: PASS (${report.phase_1_gate.unexplained_count} < ${report.phase_1_gate.threshold} unexplained) — Phase 2 substrate beads unblocked.`,
    );
    process.exit(0);
  } else {
    console.log(
      `Phase 1 GATE: FAIL (${report.phase_1_gate.unexplained_count} >= ${report.phase_1_gate.threshold} unexplained)`,
    );
    process.exit(1);
  }
}
