// =============================================================================
// bench/erf-anchor/generate-corpus.ts — deterministic golden-master input generator
// =============================================================================
//
// Generates `bench/erf-anchor/corpus.json`, the canonical input manifest the
// oracle adapters (G2 Wolfram, G3 mpmath, G4 SciPy, G6 Boost, G7 Arb) consume
// to emit cross-validating golden masters.
//
// Eight tiers per ADR-0040 §"Decision 10" and bead G1 (scientist-workbench-9sqr):
//
//   T1 — real-small  |x| ∈ [0, 0.84]                — Maclaurin Borel regime
//   T2 — real-mid    |x| ∈ (0.84, 6]                — Cody pieces / mid asymptotic
//   T3 — real-large  |x| ∈ (6, 30]                  — asymptotic regime; erfc/erfcx required
//   T4 — imag-pure   z = i·y, y ∈ [0, 30]           — Erfi via Faddeeva
//   T5 — complex Q1-Q4 |z| ∈ [0.1, 15] gridded      — full Faddeeva, all four quadrants
//   T6 — edge       ±0, ±∞, NaN, subnormal, denormal — float64 limit-of-representation
//   T7 — Stokes band |arg z| ∈ [π/2±0.1] × |z|∈[1,30] — Berry-smoothing consumer regime (bead ybrw)
//   T8 — inverses   InverseErf(y), InverseErfc(y)    — Newton-iteration validation
//
// Determinism: a single-stream Park-Miller LCG seeded with the bead's filing
// date (20260516). Re-running this script produces a byte-identical
// corpus.json. The corpus IS the source of truth for the entire Phase 1
// golden-master corpus; oracles consume it, regenerate output values, and the
// G8 cross-agreement matrix grades the oracles against each other on this
// shared input set.
//
// Run: bun bench/erf-anchor/generate-corpus.ts
// Output: bench/erf-anchor/corpus.json
//
// Number formatting discipline: every real/imag value emits as a fixed-format
// decimal string with `EXPECTED_DECIMALS` digits past the decimal point —
// matches what mpmath / Wolfram parse losslessly at 60-digit precision. NO
// JavaScript Number serialization (`toString()` loses trailing zeros and uses
// exponent notation at small/large magnitudes, both of which break the
// Wolfram input-trap landmine R5 §3.1 flagged).

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// -----------------------------------------------------------------------------
// Reproducible randomness (Park-Miller LCG, seed = bead filing date)
// -----------------------------------------------------------------------------

const SEED = 20260516;
const PARK_MILLER_M = 2147483647; // 2^31 − 1
const PARK_MILLER_A = 48271;

let lcgState = SEED;
function nextU01(): number {
  lcgState = (lcgState * PARK_MILLER_A) % PARK_MILLER_M;
  return lcgState / PARK_MILLER_M;
}

/** Uniform sample in [lo, hi). */
function uniform(lo: number, hi: number): number {
  return lo + (hi - lo) * nextU01();
}

// -----------------------------------------------------------------------------
// Decimal formatting — Wolfram-trap-proof
// -----------------------------------------------------------------------------

const EXPECTED_DECIMALS = 60;

/**
 * Format a finite JS number as a decimal string with exactly EXPECTED_DECIMALS
 * digits after the decimal point. JS Number has ~15.95 decimal digits of
 * precision, so the trailing digits past ~15 are filler zeros; this is
 * intentional — oracles re-evaluate `erf` against the *exact* input value
 * the corpus declares, so the trailing-zero padding canonicalises what
 * "exact input" means.
 *
 * The Wolfram landmine (R5 §3.1): `N[Erf[1.23], 50]` silently returns ~16
 * digits because `1.23` parses as machine-precision double. The adapter must
 * construct as `Rational[num, den]` from the decimal string. This formatter
 * emits a string the adapter can pass to such a parser unambiguously.
 */
function formatDecimal(x: number): string {
  if (!Number.isFinite(x)) {
    if (Number.isNaN(x)) return "NaN";
    return x > 0 ? "Infinity" : "-Infinity";
  }
  // Use toFixed with the cap; JS caps toFixed at 100 digits which is fine.
  // Sign-and-zero edge: -0 must be preserved (the T6 tier exercises it).
  if (Object.is(x, -0)) return "-0." + "0".repeat(EXPECTED_DECIMALS);
  if (x === 0) return "0." + "0".repeat(EXPECTED_DECIMALS);
  return x.toFixed(EXPECTED_DECIMALS);
}

// -----------------------------------------------------------------------------
// Tier scaffolding
// -----------------------------------------------------------------------------

type RealInput = { id: string; tier: string; head: string; z: string; notes?: string };
type ComplexInput = { id: string; tier: string; head: string; z: { re: string; im: string }; notes?: string };
type CorpusInput = RealInput | ComplexInput;

const inputs: CorpusInput[] = [];
let tierCounter = new Map<string, number>();
function nextId(tier: string, head: string): string {
  const n = (tierCounter.get(tier) ?? 0) + 1;
  tierCounter.set(tier, n);
  return `${tier}-${head.toLowerCase()}-${String(n).padStart(3, "0")}`;
}
function addReal(tier: string, head: string, x: number, notes?: string): void {
  inputs.push({ id: nextId(tier, head), tier, head, z: formatDecimal(x), notes });
}
function addComplex(tier: string, head: string, re: number, im: number, notes?: string): void {
  inputs.push({
    id: nextId(tier, head),
    tier, head,
    z: { re: formatDecimal(re), im: formatDecimal(im) },
    notes,
  });
}

// -----------------------------------------------------------------------------
// T1 — real-small |x| ∈ [0, 0.84]  (Maclaurin Borel regime)
// -----------------------------------------------------------------------------
// Erf, Erfc both well-defined here; algorithm region is the all-positive Borel
// series DLMF 7.6.2 per R2 §1.2. Erf(0) = 0 is the canonical anchor.

const T1_CANONICAL = [0, 1e-3, 0.1, 0.5, 0.84];
for (const head of ["Erf", "Erfc"]) {
  for (const x of T1_CANONICAL) addReal("T1", head, x, "canonical");
  for (let i = 0; i < 10; i++) addReal("T1", head, uniform(0, 0.84), "LCG-sampled");
}

// -----------------------------------------------------------------------------
// T2 — real-mid |x| ∈ (0.84, 6]  (Cody float64 pieces; mid asymptotic at p=50)
// -----------------------------------------------------------------------------
// SunPro 1993 R3 §1 dispatch boundaries: 0.84375, 1.25, 1/0.35 ≈ 2.857, 6.
// All three are corpus anchors.

const T2_CANONICAL = [0.84375 + 1e-12, 1.25, 1 / 0.35, 4, 6];
for (const head of ["Erf", "Erfc", "Erfcx"]) {
  for (const x of T2_CANONICAL) addReal("T2", head, x, "canonical-Cody-boundary");
  for (let i = 0; i < 8; i++) addReal("T2", head, uniform(0.84, 6), "LCG-sampled");
}

// -----------------------------------------------------------------------------
// T3 — real-large |x| ∈ (6, 30]  (asymptotic; Erf saturates → only Erfc / Erfcx)
// -----------------------------------------------------------------------------
// Erf(x) saturates to ±1 at |x| ≥ 6 per SunPro saturation. Validation focuses
// on Erfc (catastrophic-cancellation risk if implemented as 1−Erf — R2 risk 1)
// and Erfcx (scaled — R2 risk 3).

const T3_CANONICAL = [6 + 1e-6, 10, 11, 20, 28];
for (const head of ["Erfc", "Erfcx"]) {
  for (const x of T3_CANONICAL) addReal("T3", head, x, "canonical-asymptotic");
  for (let i = 0; i < 10; i++) addReal("T3", head, uniform(6, 30), "LCG-sampled");
}

// -----------------------------------------------------------------------------
// T4 — imaginary-pure z = i·y, y ∈ [0, 30]  (Erfi via Faddeeva; Erf(i·y) = i·Erfi(y))
// -----------------------------------------------------------------------------

const T4_CANONICAL = [0, 0.5, 1, 3, 10, 30];
for (const head of ["Erfi", "Erf"]) {
  for (const y of T4_CANONICAL) addComplex("T4", head, 0, y, "canonical-pure-imag");
  for (let i = 0; i < 9; i++) addComplex("T4", head, 0, uniform(0, 30), "LCG-sampled-pure-imag");
}

// -----------------------------------------------------------------------------
// T5 — complex Q1-Q4 |z| ∈ [0.1, 15] gridded  (full Faddeeva, all four quadrants)
// -----------------------------------------------------------------------------
// 15 LCG-sampled (|z|, arg z) pairs per head. Magnitudes span the Maclaurin
// region (|z|² < p · ln 2 ≈ 138 at p=200) through the asymptotic boundary.

for (const head of ["Erf", "Erfc", "Erfi"]) {
  for (let i = 0; i < 15; i++) {
    const r = uniform(0.1, 15);
    const theta = uniform(0, 2 * Math.PI);
    addComplex("T5", head, r * Math.cos(theta), r * Math.sin(theta), "LCG-sampled-complex");
  }
}

// -----------------------------------------------------------------------------
// T6 — edge cases  (float64 limit-of-representation: signed zero, infinity, NaN,
//                   subnormal min, smallest denormal)
// -----------------------------------------------------------------------------
// Honest-scope discipline: edge inputs MUST return the documented limit value
// or refuse with a structured tag. Bronze-tier oracles (libm, SciPy) ARE the
// reference for these.

const T6_EDGES: { x: number; note: string }[] = [
  { x: 0, note: "positive-zero" },
  { x: -0, note: "negative-zero" },
  { x: Infinity, note: "positive-infinity" },
  { x: -Infinity, note: "negative-infinity" },
  { x: Number.MIN_VALUE, note: "smallest-positive-subnormal-2^-1074" },
  { x: 2.2250738585072014e-308, note: "smallest-positive-normal-2^-1022" },
  { x: Number.MAX_VALUE, note: "largest-finite-1.7976931348623157e+308" },
];
// NaN is added separately because it doesn't admit a meaningful decimal-string
// representation past the literal "NaN" token; the adapter handles it
// specially.
for (const head of ["Erf", "Erfc", "Erfcx", "Erfi"]) {
  for (const { x, note } of T6_EDGES) addReal("T6", head, x, `edge: ${note}`);
  addReal("T6", head, NaN, "edge: NaN");
}

// -----------------------------------------------------------------------------
// T7 — Stokes-band |arg z| ∈ [π/2 ± 0.1] × |z| ∈ [1, 30]
//      (Berry-smoothing consumer regime — bead ybrw)
// -----------------------------------------------------------------------------
// Erfc + Erfcx are the Berry-smoothing kernel's calls. The Stokes line is the
// region where R2 §"Risk 2" flags the cancellation cliff if the wrong (DLMF
// 7.6.1 alternating) series form is used.

const T7_ARGS = [
  Math.PI / 2 - 0.10, Math.PI / 2 - 0.05, Math.PI / 2,
  Math.PI / 2 + 0.05, Math.PI / 2 + 0.10,
  -Math.PI / 2 - 0.10, -Math.PI / 2 - 0.05, -Math.PI / 2,
  -Math.PI / 2 + 0.05, -Math.PI / 2 + 0.10,
];
const T7_MAGS = [1, 3, 5, 10, 20, 30];
// Cartesian product would be 60; sample 15 per head via LCG.
for (const head of ["Erfc", "Erfcx"]) {
  for (let i = 0; i < 15; i++) {
    const r = T7_MAGS[Math.floor(nextU01() * T7_MAGS.length)];
    const theta = T7_ARGS[Math.floor(nextU01() * T7_ARGS.length)];
    addComplex("T7", head, r * Math.cos(theta), r * Math.sin(theta), "Stokes-band-Berry-smoothing");
  }
}

// -----------------------------------------------------------------------------
// T8 — inverses InverseErf(y), InverseErfc(y)
// -----------------------------------------------------------------------------
// Blair-Edwards-Johnson 1976 region boundaries: |y|=0.75 and |y|=0.9375 for
// InverseErf; y=0.0625 and y=1e-100 for InverseErfc. All boundaries are
// canonical anchors.

const T8_ERFINV_CANONICAL = [-0.999, -0.9375 + 1e-12, -0.75 - 1e-12, -0.5, 0, 0.5, 0.75 + 1e-12, 0.9375 - 1e-12, 0.999];
const T8_ERFCINV_CANONICAL = [1e-50, 1e-10, 0.0625, 0.1, 0.5, 0.9, 1.0, 1.5, 1.9375, 1.999];
for (const y of T8_ERFINV_CANONICAL) addReal("T8", "InverseErf", y, "canonical-Blair-boundary");
for (let i = 0; i < 8; i++) addReal("T8", "InverseErf", uniform(-0.99, 0.99), "LCG-sampled");
for (const y of T8_ERFCINV_CANONICAL) addReal("T8", "InverseErfc", y, "canonical-Blair-boundary");
for (let i = 0; i < 8; i++) addReal("T8", "InverseErfc", uniform(0.01, 1.99), "LCG-sampled");

// -----------------------------------------------------------------------------
// Emit
// -----------------------------------------------------------------------------

const corpus = {
  manifest_version: 1,
  generated_at: "2026-05-16T00:00:00Z",
  bead: "scientist-workbench-9sqr",
  adr: "0040",
  seed: SEED,
  lcg: "Park-Miller (a=48271, m=2^31-1)",
  expected_decimals_per_value: EXPECTED_DECIMALS,
  expected_precision_decimals_for_gold_oracle: 50,
  tier_descriptions: {
    T1: "real-small |x| ∈ [0, 0.84] — Maclaurin Borel regime (DLMF 7.6.2)",
    T2: "real-mid |x| ∈ (0.84, 6] — Cody float64 pieces / mid asymptotic",
    T3: "real-large |x| ∈ (6, 30] — asymptotic; Erf saturates (Erfc/Erfcx only)",
    T4: "imaginary-pure z = i·y, y ∈ [0, 30] — Erfi via Faddeeva",
    T5: "complex Q1-Q4 |z| ∈ [0.1, 15] gridded — full Faddeeva, all four quadrants",
    T6: "edge ±0, ±∞, NaN, subnormal, denormal — float64 limit-of-representation",
    T7: "Stokes band |arg z| ∈ [π/2±0.1] × |z| ∈ [1, 30] — Berry-smoothing consumer (bead ybrw)",
    T8: "inverses InverseErf(y), InverseErfc(y) — Newton-iteration validation",
  },
  totals: {
    by_tier: Object.fromEntries(
      [...new Set(inputs.map((i) => i.tier))]
        .sort()
        .map((t) => [t, inputs.filter((i) => i.tier === t).length])
    ),
    by_head: Object.fromEntries(
      [...new Set(inputs.map((i) => i.head))]
        .sort()
        .map((h) => [h, inputs.filter((i) => i.head === h).length])
    ),
    total: inputs.length,
  },
  inputs,
};

if (import.meta.main || import.meta.url === `file://${process.argv[1]}`) {
  const url = new URL("./corpus.json", import.meta.url);
  const path = fileURLToPath(url);
  writeFileSync(path, JSON.stringify(corpus, null, 2) + "\n");
  console.log(`Wrote ${path}`);
  console.log(`Total inputs: ${corpus.totals.total}`);
  console.log("By tier:", corpus.totals.by_tier);
  console.log("By head:", corpus.totals.by_head);
}
