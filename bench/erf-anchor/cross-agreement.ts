// =============================================================================
// bench/erf-anchor/cross-agreement.ts — G8 cross-oracle agreement matrix
// =============================================================================
//
// Phase 1 GATE per ADR-0040 §"Decision 10". Bead: scientist-workbench-68ir.
//
// Reads every `bench/erf-anchor/oracles/<id>/results.json` file present and
// computes a pair-wise agreement matrix per (input_id, head). The matrix
// answers: "for this corpus input, do our gold/silver/bronze oracles agree
// to the precision their tiers claim?"
//
// What is the matrix telling us?
// ------------------------------
// Three classes of finding fall out:
//
//   class A (expected agreement, threshold met)
//     Wolfram gold vs mpmath gold to ≥48 of 50 digits, OR
//     mpmath gold vs Boost cpp_bin_float<50> silver to ≥48 of 50 digits, OR
//     SciPy bronze vs gold-truncated-to-float64 within 2 ULP.
//     ⟹ corpus input is "well-anchored" — the Phase 2 substrate has an
//        unambiguous correctness target for this input.
//
//   class B (refusal-refusal — agreement by construction)
//     Both oracles honestly refused the same input (e.g., MAX_DOUBLE
//     Erfc overflows mpmath AND Boost; complex inputs refused by Boost).
//     ⟹ honest scope, not a finding. Counts toward "well-anchored" too.
//
//   class C (DISAGREEMENT)
//     Two oracles produced concrete outputs but their values diverge past
//     the tier threshold (gold-gold > 2 digits; silver-silver > 2 digits;
//     bronze-bronze > 4 ULP). OR one oracle returned, the other refused
//     (asymmetric refusal). ⟹ FINDING — investigate which oracle is correct
//     (or whether both are wrong in different ways). Each class-C finding
//     is a bead candidate.
//
// Thresholds per ADR-0040 §"Decision 8":
//   gold-vs-gold: pair-disagreement > 2 digits ⟹ flag
//   bronze-vs-bronze: pair-disagreement > 4 ULP ⟹ flag
//   gold-vs-silver: same as gold-vs-gold, restricted to silver's precision
//   gold-vs-bronze: gold truncated to float64, then ULP comparison
//
// Output
// ------
//   bench/erf-anchor/agreement-data.json   — full machine-readable matrix
//   bench/erf-anchor/agreement-matrix.md   — human-readable summary + heat map
//
// Pure TS / Bun — no subprocess, no FFI. Discipline mirrors
// generate-corpus.ts.

import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

// -----------------------------------------------------------------------------
// Oracle result shapes (unioned over the four adapters' schemas)
// -----------------------------------------------------------------------------

interface OracleResultRecord {
  readonly input_id: string;
  readonly head: string;
  readonly z?: unknown;
  readonly output?: string | { re: string; im: string } | null;
  readonly method?: string;
  readonly achieved_precision?: number;
  readonly note?: string;
  readonly failure_reason?: string;
  readonly elapsed_ms?: number;
}

interface OracleResultsFile {
  readonly oracle_id: string;
  readonly oracle_version: string;
  readonly results: readonly OracleResultRecord[];
  readonly total_results?: number;
  readonly total_ok?: number;
  readonly total_refused?: number;
}

// -----------------------------------------------------------------------------
// Tier classification for each oracle
// -----------------------------------------------------------------------------

type Tier = "gold" | "silver" | "bronze";

const ORACLE_TIERS: Record<string, Tier> = {
  wolfram: "gold",
  mpmath: "gold",
  boost: "silver",   // real arb-prec via cpp_bin_float<50>
  scipy: "bronze",   // float64
  julia: "silver",   // (deferred; SpecialFunctions.jl not installed)
  arb: "gold",       // (deferred; not installed)
};

// -----------------------------------------------------------------------------
// Value normalisation — handle the union of output shapes
// -----------------------------------------------------------------------------

type ConcreteValue =
  | { kind: "real"; sign: number; decimal: string; raw: string }
  | { kind: "complex"; re: ConcreteValue; im: ConcreteValue }
  | { kind: "limit"; symbol: "Infinity" | "-Infinity" | "NaN" | "ComplexInfinity" | "Indeterminate" }
  | { kind: "refused"; reason: string };

const LIMIT_TOKENS = new Set(["Infinity", "-Infinity", "NaN", "ComplexInfinity", "Indeterminate"]);

function parseRealString(s: string): ConcreteValue {
  if (LIMIT_TOKENS.has(s)) {
    return { kind: "limit", symbol: s as "Infinity" };
  }
  // Bronze tier (SciPy) emits Python repr — handle "nan", "inf", "-inf".
  const lower = s.toLowerCase();
  if (lower === "nan") return { kind: "limit", symbol: "NaN" };
  if (lower === "inf" || lower === "infinity") return { kind: "limit", symbol: "Infinity" };
  if (lower === "-inf" || lower === "-infinity") return { kind: "limit", symbol: "-Infinity" };
  // Normalize: strip leading +; emit sign as -1/+1; emit absolute decimal.
  let sign = 1;
  let body = s.trim();
  if (body.startsWith("+")) body = body.slice(1);
  if (body.startsWith("-")) { sign = -1; body = body.slice(1); }
  // Detect outputs from genuine arb-prec oracles (mpmath especially) that
  // emit values with absurdly-large exponents — e.g. Erfi(MAX_DOUBLE) is
  // ~1.38e+14_035_097_408_404…, a string with a 580-digit exponent. These
  // values are mathematically well-defined but exceed every other oracle's
  // representable range; comparison digit-by-digit is meaningless. Map to
  // an overflow-limit for the comparator (so the comparison reduces to
  // "did everyone agree this was effectively infinite?"). Threshold is
  // chosen generously: |exp| > 400 (well past IEEE-754 double's 308) and
  // also catches the parseInt → Infinity bigint-exponent case directly.
  const eIdx = body.toLowerCase().indexOf("e");
  if (eIdx >= 0) {
    const expRaw = body.slice(eIdx + 1);
    const expDigits = expRaw.startsWith("+") || expRaw.startsWith("-") ? expRaw.slice(1) : expRaw;
    if (expDigits.length > 3 || !Number.isFinite(parseInt(expRaw, 10))) {
      const overflow = expRaw.startsWith("-")
        ? { kind: "real" as const, sign, decimal: "0." + "0".repeat(60) + "1", raw: s }   // underflow ⇒ effective zero
        : { kind: "limit" as const, symbol: (sign < 0 ? "-Infinity" : "Infinity") as "Infinity" };
      return overflow;
    }
  }
  // Body may be in scientific form (e.g. "1.23e-10") or fixed decimal.
  // Canonicalise both into a uniform decimal-string representation for
  // digit-counting agreement (we expand scientific by string surgery).
  return { kind: "real", sign, decimal: expandScientific(body), raw: s };
}

/**
 * Expand `"5.4e-176"` into `"0.000…00054…"`. Pure-string; no float64.
 * Returns the integer-and-fraction string without sign.
 */
function expandScientific(s: string): string {
  const eIdx = s.toLowerCase().indexOf("e");
  if (eIdx < 0) return s;
  const mantissa = s.slice(0, eIdx);
  const exp = parseInt(s.slice(eIdx + 1), 10);
  if (!Number.isFinite(exp)) {
    throw new Error(`expandScientific: non-finite exponent parsed from ${JSON.stringify(s)} (mantissa=${JSON.stringify(mantissa)}, exp-raw=${JSON.stringify(s.slice(eIdx + 1))})`);
  }
  const dotIdx = mantissa.indexOf(".");
  const intPart = dotIdx < 0 ? mantissa : mantissa.slice(0, dotIdx);
  const fracPart = dotIdx < 0 ? "" : mantissa.slice(dotIdx + 1);
  const allDigits = intPart + fracPart;
  // Decimal point currently sits at position `intPart.length` in `allDigits`.
  // After applying exp, it moves by `exp` to the right (positive exp) or left.
  const newDotPos = intPart.length + exp;
  if (newDotPos <= 0) {
    return "0." + "0".repeat(-newDotPos) + allDigits;
  } else if (newDotPos >= allDigits.length) {
    return allDigits + "0".repeat(newDotPos - allDigits.length);
  } else {
    return allDigits.slice(0, newDotPos) + "." + allDigits.slice(newDotPos);
  }
}

function normaliseValue(record: OracleResultRecord): ConcreteValue {
  if (record.failure_reason || record.note?.includes("refused")) {
    return { kind: "refused", reason: record.failure_reason ?? record.note ?? "unknown" };
  }
  if (record.output === null || record.output === undefined) {
    return { kind: "refused", reason: record.note ?? "null output" };
  }
  if (typeof record.output === "string") {
    return parseRealString(record.output);
  }
  if (typeof record.output === "object" && "re" in record.output && "im" in record.output) {
    return {
      kind: "complex",
      re: parseRealString(record.output.re),
      im: parseRealString(record.output.im),
    };
  }
  return { kind: "refused", reason: `unrecognised output shape: ${JSON.stringify(record.output)}` };
}

// -----------------------------------------------------------------------------
// Pairwise agreement comparator
// -----------------------------------------------------------------------------

/**
 * The "agreement is perfect" sentinel. Distinct from a 1000-digit
 * agreement (which would only arise from a degenerate input we'd never
 * expect in practice); using a large finite value keeps JSON-serialisable
 * semantics while indicating "both values are equal as written, with as
 * much agreement as both representations carry."
 */
const PERFECT_AGREEMENT = 10_000;

/**
 * Count leading decimal digits in common between two non-negative
 * decimal-fraction strings.
 *
 * Algorithm: convert each to a canonical scientific form
 * `(mantissa_digits: string, exp10: number)` where `mantissa_digits` starts
 * with a non-zero digit (or both strings represent zero). Both-zero ⟹
 * PERFECT_AGREEMENT. Different exp10 ⟹ 0 (magnitudes disagree). Same
 * exp10 ⟹ count common leading digits with the shorter mantissa padded
 * by trailing zeros (so `1234` vs `12340000` agree on 8 digits — they ARE
 * the same value to that precision).
 */
function digitsAgreeing(a: string, b: string): number {
  const ca = canonicalScientific(a);
  const cb = canonicalScientific(b);
  if (ca.zero && cb.zero) return PERFECT_AGREEMENT;
  if (ca.zero !== cb.zero) return 0;                 // one zero, one not
  if (ca.exp10 !== cb.exp10) return 0;               // magnitudes disagree
  if (ca.sig === cb.sig) return PERFECT_AGREEMENT;   // identical mantissa = equal as written
  // Compare significand digit-by-digit; shorter is right-padded by zeros.
  const maxLen = Math.max(ca.sig.length, cb.sig.length);
  for (let i = 0; i < maxLen; i++) {
    const da = i < ca.sig.length ? ca.sig[i] : "0";
    const db = i < cb.sig.length ? cb.sig[i] : "0";
    if (da !== db) return i;
  }
  return maxLen;                                     // every digit matched (one was prefix-padded)
}

interface CanonicalScientific {
  zero: boolean;       // true if the value is zero (any number of trailing zeros)
  sig: string;         // significand digits, leading non-zero (empty if zero)
  exp10: number;       // exponent so that value = 0.<sig> × 10^exp10
                       // (i.e. the position of the implicit decimal point past which
                       //  the first non-zero digit appears)
}

function canonicalScientific(s: string): CanonicalScientific {
  // Drop any trailing-zero artefacts; collapse multi-zero "0.0…000" to zero.
  const [intPart, fracPart] = splitDecimal(s);
  const intTrimmed = intPart.replace(/^0+/, "");
  const fracTrimmed = fracPart.replace(/0+$/, "");
  if (intTrimmed === "" && fracTrimmed === "") {
    return { zero: true, sig: "", exp10: 0 };
  }
  if (intTrimmed !== "") {
    // Value ≥ 1. Significand = intTrimmed + fracTrimmed; exp10 = +length(intTrimmed).
    const sig = (intTrimmed + fracTrimmed).replace(/0+$/, "");
    return { zero: false, sig, exp10: intTrimmed.length };
  }
  // Value < 1. Find the leading-zeros run in fracPart.
  const leadingZeros = fracPart.match(/^0*/)?.[0].length ?? 0;
  const sig = fracPart.slice(leadingZeros).replace(/0+$/, "");
  return { zero: false, sig, exp10: -leadingZeros };
}

function splitDecimal(s: string): [string, string] {
  const dot = s.indexOf(".");
  return dot < 0 ? [s, ""] : [s.slice(0, dot), s.slice(dot + 1)];
}

/** ULP distance between two float64 values. ±Inf/NaN/sign-zero handled. */
function ulpDistance(a: number, b: number): number {
  if (Number.isNaN(a) || Number.isNaN(b)) return Object.is(a, b) ? 0 : Infinity;
  if (!Number.isFinite(a) || !Number.isFinite(b)) {
    return a === b ? 0 : Infinity;
  }
  if (Object.is(a, b)) return 0;
  if (Object.is(a, -0) && Object.is(b, 0)) return 0;
  if (Object.is(a, 0) && Object.is(b, -0)) return 0;
  const buf = new ArrayBuffer(8);
  const f = new Float64Array(buf);
  const i = new BigInt64Array(buf);
  f[0] = a; const aBits = i[0];
  f[0] = b; const bBits = i[0];
  // Two's-complement for negatives: flip non-sign bits and add 1 (we just
  // need a monotonic mapping; abs of the difference is the ULP distance).
  const toMonotonic = (x: bigint): bigint => x >= 0n ? x : -(x & 0x7fff_ffff_ffff_ffffn);
  const aMono = toMonotonic(aBits);
  const bMono = toMonotonic(bBits);
  const delta = aMono > bMono ? aMono - bMono : bMono - aMono;
  return Number(delta);
}

type Agreement =
  | { kind: "both-refused"; severity: "info"; tier_pair: string }
  | { kind: "asymmetric-refusal"; severity: "warn"; tier_pair: string; oracle_refused: string }
  | { kind: "limit-agree"; severity: "info"; tier_pair: string; symbol: string }
  | { kind: "limit-disagree"; severity: "error"; tier_pair: string; a_symbol: string; b_symbol: string }
  | { kind: "decimal-agree"; severity: "info" | "warn"; tier_pair: string; digits: number; threshold: number }
  | { kind: "ulp-agree"; severity: "info" | "warn"; tier_pair: string; ulp: number; threshold: number }
  | { kind: "shape-mismatch"; severity: "error"; tier_pair: string; a_kind: string; b_kind: string };

function comparePair(
  oa: string, va: ConcreteValue,
  ob: string, vb: ConcreteValue,
): Agreement {
  const tierA = ORACLE_TIERS[oa];
  const tierB = ORACLE_TIERS[ob];
  const tier_pair = `${tierA}-${tierB}`;

  // Refusal handling
  if (va.kind === "refused" && vb.kind === "refused") {
    return { kind: "both-refused", severity: "info", tier_pair };
  }
  if (va.kind === "refused") {
    return { kind: "asymmetric-refusal", severity: "warn", tier_pair, oracle_refused: oa };
  }
  if (vb.kind === "refused") {
    return { kind: "asymmetric-refusal", severity: "warn", tier_pair, oracle_refused: ob };
  }

  // Limit-value handling. Normalise oracle-specific spellings: Wolfram says
  // "Indeterminate" where mpmath/SciPy say "NaN" (semantically equal —
  // "this computation didn't produce a number"). Likewise "ComplexInfinity"
  // is Wolfram's spelling for an infinite-magnitude limit on the complex
  // plane; map to "Infinity" for comparison since the sign-of-infinity
  // information isn't carried by mpmath's plain "Infinity" tag either.
  const normaliseLimit = (s: string): string =>
    s === "Indeterminate" ? "NaN" :
    s === "ComplexInfinity" ? "Infinity" : s;
  if (va.kind === "limit" && vb.kind === "limit") {
    const sa = normaliseLimit(va.symbol);
    const sb = normaliseLimit(vb.symbol);
    return sa === sb
      ? { kind: "limit-agree", severity: "info", tier_pair, symbol: sa }
      : { kind: "limit-disagree", severity: "error", tier_pair, a_symbol: va.symbol, b_symbol: vb.symbol };
  }
  if (va.kind === "limit" || vb.kind === "limit") {
    return {
      kind: "shape-mismatch", severity: "error", tier_pair,
      a_kind: va.kind, b_kind: vb.kind,
    };
  }

  // Complex shape
  if (va.kind === "complex" && vb.kind === "complex") {
    // Decompose into real / imag agreements; report worst.
    const reAgree = comparePair(oa, va.re, ob, vb.re);
    const imAgree = comparePair(oa, va.im, ob, vb.im);
    // Worst of the two.
    return severityRank(reAgree.severity) >= severityRank(imAgree.severity) ? reAgree : imAgree;
  }
  if (va.kind === "complex" || vb.kind === "complex") {
    return {
      kind: "shape-mismatch", severity: "error", tier_pair,
      a_kind: va.kind, b_kind: vb.kind,
    };
  }

  // Real-real comparison.
  if (va.sign !== vb.sign && !(va.decimal.replace(/0|\./g, "") === "" && vb.decimal.replace(/0|\./g, "") === "")) {
    // Signs differ on non-zero values → no digits agree (treat as disagreement).
    return {
      kind: "decimal-agree", severity: "warn", tier_pair, digits: 0,
      threshold: thresholdForTierPair(tierA, tierB).digits,
    };
  }

  // Decide whether to compare as decimal digits (silver+/gold) or ULP (bronze).
  const isBronze = tierA === "bronze" || tierB === "bronze";
  if (isBronze) {
    const aN = Number(va.sign * Number(va.decimal));
    const bN = Number(vb.sign * Number(vb.decimal));
    const ulp = ulpDistance(aN, bN);
    const threshold = thresholdForTierPair(tierA, tierB).ulp ?? 4;
    return {
      kind: "ulp-agree", severity: ulp <= threshold ? "info" : "warn",
      tier_pair, ulp, threshold,
    };
  }
  const digits = digitsAgreeing(va.decimal, vb.decimal);
  const { digits: threshold } = thresholdForTierPair(tierA, tierB);
  return {
    kind: "decimal-agree", severity: digits >= threshold ? "info" : "warn",
    tier_pair, digits, threshold,
  };
}

function severityRank(s: string): number {
  return { info: 0, warn: 1, error: 2 }[s] ?? 0;
}

function thresholdForTierPair(tA: Tier, tB: Tier): { digits: number; ulp?: number } {
  // Per ADR-0040 §"Decision 8", refined by G8a (wko6) finding 2026-05-16:
  //   gold-vs-gold (both ≥ 55 dp emitted): > 2 digits below 50-dp gold
  //     target ⟹ flag. Threshold 48.
  //   gold-vs-silver: silver is Boost cpp_bin_float<50> which emits exactly
  //     50 sig digits — last 2-3 are rounding noise vs gold's 55-dp emit.
  //     Threshold 46 (50 minus 4-digit safety per last-place-rounding behavior).
  //   bronze-bronze, anything-vs-bronze: > 4 ULP ⟹ flag. Float64 mantissa
  //     is 52 bits ≈ 15.95 decimal; effective threshold for digit-counting
  //     comparisons cross-tier is ~13 (after truncating gold/silver to f64).
  if (tA === "bronze" || tB === "bronze") return { digits: 13, ulp: 4 };
  if (tA === "silver" || tB === "silver") return { digits: 46 };
  // Both gold.
  return { digits: 48 };
}

// -----------------------------------------------------------------------------
// Top-level driver
// -----------------------------------------------------------------------------

interface AgreementEntry {
  input_id: string;
  head: string;
  per_oracle: Record<string, "ok" | "refused" | "missing">;
  pairs: Array<{
    a: string; b: string;
    agreement: Agreement;
  }>;
}

interface AgreementReport {
  generated_at: string;
  corpus_total: number;
  oracles: Array<{ id: string; tier: Tier; version: string; records: number; ok: number; refused: number }>;
  entries: AgreementEntry[];
  findings: Array<{
    severity: "warn" | "error";
    input_id: string;
    head: string;
    oracle_a: string;
    oracle_b: string;
    detail: Agreement;
  }>;
  summary: {
    total_pairs: number;
    info: number;
    warn: number;
    error: number;
    per_tier_pair: Record<string, { info: number; warn: number; error: number }>;
  };
}

function loadOracles(): Map<string, OracleResultsFile> {
  const oraclesDir = new URL("./oracles/", import.meta.url);
  const oraclesDirPath = fileURLToPath(oraclesDir);
  const oracles = new Map<string, OracleResultsFile>();
  if (!existsSync(oraclesDirPath)) return oracles;
  for (const entry of readdirSync(oraclesDirPath, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const id = entry.name;
    const resultsPath = `${oraclesDirPath}/${id}/results.json`;
    if (!existsSync(resultsPath)) continue;
    const raw = readFileSync(resultsPath, "utf8");
    const parsed = JSON.parse(raw) as OracleResultsFile;
    oracles.set(id, parsed);
  }
  return oracles;
}

function buildReport(oracles: Map<string, OracleResultsFile>): AgreementReport {
  // Index per-oracle by (input_id, head).
  type Key = string;
  const key = (input_id: string, head: string): Key => `${input_id}|${head}`;
  const indexed = new Map<string, Map<Key, OracleResultRecord>>();
  for (const [id, file] of oracles) {
    const m = new Map<Key, OracleResultRecord>();
    for (const r of file.results) m.set(key(r.input_id, r.head), r);
    indexed.set(id, m);
  }

  // Collect every (input_id, head) seen across all oracles.
  const allKeys = new Set<Key>();
  for (const [, m] of indexed) for (const k of m.keys()) allKeys.add(k);

  const entries: AgreementEntry[] = [];
  const findings: AgreementReport["findings"] = [];
  const oracleIds = [...oracles.keys()].sort();

  for (const k of [...allKeys].sort()) {
    const [input_id, head] = k.split("|") as [string, string];
    const per_oracle: Record<string, "ok" | "refused" | "missing"> = {};
    const normalised = new Map<string, ConcreteValue>();
    for (const oid of oracleIds) {
      const rec = indexed.get(oid)?.get(k);
      if (!rec) { per_oracle[oid] = "missing"; continue; }
      const v = normaliseValue(rec);
      normalised.set(oid, v);
      per_oracle[oid] = v.kind === "refused" ? "refused" : "ok";
    }
    const pairs: AgreementEntry["pairs"] = [];
    for (let i = 0; i < oracleIds.length; i++) {
      for (let j = i + 1; j < oracleIds.length; j++) {
        const oa = oracleIds[i], ob = oracleIds[j];
        const va = normalised.get(oa), vb = normalised.get(ob);
        if (!va || !vb) continue;
        const agreement = comparePair(oa, va, ob, vb);
        pairs.push({ a: oa, b: ob, agreement });
        if (agreement.severity !== "info") {
          findings.push({
            severity: agreement.severity, input_id, head,
            oracle_a: oa, oracle_b: ob, detail: agreement,
          });
        }
      }
    }
    entries.push({ input_id, head, per_oracle, pairs });
  }

  // Summary stats.
  const summary: AgreementReport["summary"] = {
    total_pairs: 0, info: 0, warn: 0, error: 0,
    per_tier_pair: {},
  };
  for (const e of entries) {
    for (const p of e.pairs) {
      summary.total_pairs++;
      summary[p.agreement.severity]++;
      const tp = p.agreement.tier_pair;
      const slot = (summary.per_tier_pair[tp] ??= { info: 0, warn: 0, error: 0 });
      slot[p.agreement.severity]++;
    }
  }

  return {
    generated_at: new Date().toISOString(),
    corpus_total: allKeys.size,
    oracles: oracleIds.map((id) => {
      const f = oracles.get(id)!;
      const recs = f.results;
      const ok = recs.filter((r) => normaliseValue(r).kind !== "refused").length;
      return { id, tier: ORACLE_TIERS[id], version: f.oracle_version, records: recs.length, ok, refused: recs.length - ok };
    }),
    entries, findings, summary,
  };
}

function renderMarkdown(report: AgreementReport): string {
  const lines: string[] = [];
  lines.push(`# bench/erf-anchor — cross-oracle agreement matrix`);
  lines.push("");
  lines.push(`Generated: ${report.generated_at}`);
  lines.push(`Bead: scientist-workbench-68ir (Phase 1 GATE per ADR-0040 §"Decision 10").`);
  lines.push("");
  lines.push(`## Oracles`);
  lines.push("");
  lines.push("| oracle | tier | version | records | ok | refused |");
  lines.push("|---|---|---|---|---|---|");
  for (const o of report.oracles) {
    lines.push(`| \`${o.id}\` | ${o.tier} | ${o.version} | ${o.records} | ${o.ok} | ${o.refused} |`);
  }
  lines.push("");
  lines.push(`## Summary`);
  lines.push("");
  lines.push(`Total pairwise comparisons: **${report.summary.total_pairs}**`);
  lines.push(`- info (agreed within threshold): **${report.summary.info}**`);
  lines.push(`- warn (disagreement past threshold): **${report.summary.warn}**`);
  lines.push(`- error (limit/shape mismatch): **${report.summary.error}**`);
  lines.push("");
  lines.push(`### Per tier-pair`);
  lines.push("");
  lines.push("| tier-pair | info | warn | error |");
  lines.push("|---|---|---|---|");
  for (const [tp, counts] of Object.entries(report.summary.per_tier_pair).sort()) {
    lines.push(`| ${tp} | ${counts.info} | ${counts.warn} | ${counts.error} |`);
  }
  lines.push("");
  if (report.findings.length > 0) {
    lines.push(`## Findings (${report.findings.length})`);
    lines.push("");
    lines.push("Each finding is a bead candidate: investigate which oracle is");
    lines.push("correct (or whether both are wrong in different ways). Apply");
    lines.push("ADR-0040 §\"Decision 8\" thresholds (gold-vs-gold > 2 digits;");
    lines.push("bronze-vs-bronze > 4 ULP; asymmetric refusal always flagged).");
    lines.push("");
    lines.push("| input_id | head | oracle_a | oracle_b | kind | detail |");
    lines.push("|---|---|---|---|---|---|");
    // Cap displayed findings at 100 to keep the report readable; full list
    // is in the JSON.
    for (const f of report.findings.slice(0, 100)) {
      const d = f.detail;
      let detail = "";
      switch (d.kind) {
        case "asymmetric-refusal": detail = `refused-by ${d.oracle_refused}`; break;
        case "decimal-agree": detail = `digits=${d.digits} (threshold ${d.threshold})`; break;
        case "ulp-agree": detail = `ulp=${d.ulp} (threshold ${d.threshold})`; break;
        case "limit-disagree": detail = `${d.a_symbol} vs ${d.b_symbol}`; break;
        case "shape-mismatch": detail = `${d.a_kind} vs ${d.b_kind}`; break;
        default: detail = JSON.stringify(d);
      }
      lines.push(`| ${f.input_id} | ${f.head} | ${f.oracle_a} | ${f.oracle_b} | ${d.kind} | ${detail} |`);
    }
    if (report.findings.length > 100) {
      lines.push(`| … | … | … | … | … | (${report.findings.length - 100} more — see agreement-data.json) |`);
    }
  } else {
    lines.push(`## Findings`);
    lines.push("");
    lines.push("No findings: every pairwise comparison agreed within its tier threshold.");
    lines.push("Phase 1 GATE passes. Phase 2 substrate beads (I1-I6, I6a) unblocked.");
  }
  return lines.join("\n") + "\n";
}

// -----------------------------------------------------------------------------
// Entry
// -----------------------------------------------------------------------------

if (import.meta.main || import.meta.url === `file://${process.argv[1]}`) {
  const oracles = loadOracles();
  if (oracles.size === 0) {
    console.error("No oracle results.json found under bench/erf-anchor/oracles/<id>/. Run the adapters first.");
    process.exit(1);
  }
  console.log(`Loaded oracles: ${[...oracles.keys()].join(", ")}`);
  const report = buildReport(oracles);
  const dataPath = fileURLToPath(new URL("./agreement-data.json", import.meta.url));
  const mdPath = fileURLToPath(new URL("./agreement-matrix.md", import.meta.url));
  writeFileSync(dataPath, JSON.stringify(report, null, 2) + "\n");
  writeFileSync(mdPath, renderMarkdown(report));
  console.log(`Wrote ${dataPath}`);
  console.log(`Wrote ${mdPath}`);
  console.log(`Total pairs: ${report.summary.total_pairs} (info: ${report.summary.info}, warn: ${report.summary.warn}, error: ${report.summary.error})`);
  console.log(`Findings: ${report.findings.length}`);
  if (report.findings.length > 0) {
    console.log(`Phase 1 GATE: WARN — review findings before claiming Phase 2 beads.`);
    process.exit(0);
  }
  console.log(`Phase 1 GATE: PASS — Phase 2 substrate beads unblocked.`);
}
