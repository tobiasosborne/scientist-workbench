// =============================================================================
// bench/besselj-anchor/generate-corpus.ts — deterministic golden-master input
// generator for the Bessel family (BesselJ, BesselY, BesselI, BesselK +
// BesselIScaled, BesselKScaled).
// =============================================================================
//
// Generates `bench/besselj-anchor/corpus.json`, the canonical input manifest
// the oracle adapters (G2 Wolfram, G3 mpmath, G4 SciPy, G5 Boost, G7 Arb)
// consume to emit cross-validating golden masters per ADR-0041.
//
// Ten tiers per ADR-0041 §"Decision 10" and bead G1 (scientist-workbench-qccc):
//
//   T1  — small-z series          |z| ∈ (0, 8]       ₀F₁ Maclaurin regime
//   T2  — mid-z                   |z| ∈ (8, 60]      cancellation-retry / Hankel boundary
//   T3  — large-z asymptotic      |z| ∈ (60, 300]    Hankel regime (z_c_Hankel(p) = p/2; @p=200 bit ≈ 100; corpus covers 60-300 to cover all precisions)
//   T4  — transition |z| ≈ ν     |z| ∈ ν · (0.7, 1.3)   Olver-uniform / Temme-CF regime; FLINT-pattern cancellation-retry
//   T5  — complex Q1-Q4          |z| ∈ [0.5, 30], arg z ∈ (-π, π]   full Amos-rotation complex path
//   T6  — edges                  ±0, ±∞, NaN, subnormal, denormal-extreme — float64 limit-of-representation
//   T7  — high-ν Debye           ν ∈ [50, 500] × |z| ∈ ν · [0.5, 2]   asymptotic large-ν regime
//   T8  — negative-real-ν        non-integer ν < 0  for Y and K (cos/sin connection-formula branch)
//   T9  — Bessel zeros           |z - z_root| < 0.01 band; relative-error → absolute-error transition per ADR-0041 §Decision 12
//   T10 — large-ν integer        ν ∈ {50, 100, 200, 500} integer × |z| ∈ {1, 10}  overflow/underflow boundary; scaled variants for I/K
//
// Three ν-classes drive the per-tier dispatch:
//   - integer ν ∈ ℤ                 → exercises integer-recurrence paths
//   - half-integer ν ∈ ℤ + 1/2      → exercises closed-form J_{n+1/2} ↔ spherical-Bessel reductions (R1 priority-class C)
//   - general non-integer ν ∈ ℝ \ ℚ  → exercises the general ν algorithm (₀F₁, Hankel)
//
// The corpus emits ν as a discriminated `nu_kind` + `nu` string so each
// oracle adapter parses unambiguously per R5 §6 L1 (Wolfram input-trap: Bessel
// inputs MUST construct as `Rational[num, den]`, never machine-double literal):
//   {nu_kind: "integer", nu: "3"}            → adapter parses as Integer[3]
//   {nu_kind: "half-integer", nu: "7/2"}     → adapter parses as Rational[7, 2]
//   {nu_kind: "decimal", nu: "1.7000…"}      → adapter parses as Rational from
//                                              decimal-string at 60-dp depth
//
// Determinism: a single-stream Park-Miller LCG seeded with the bead's filing
// date (20260517 — one day after the Erf seed 20260516 to ensure a different
// stream). Re-running this script produces a byte-identical corpus.json. The
// corpus IS the source of truth for the entire Phase 1 golden-master corpus.
//
// Run: bun bench/besselj-anchor/generate-corpus.ts
// Output: bench/besselj-anchor/corpus.json
//
// Number formatting discipline: every real/imag/decimal-ν value emits as a
// fixed-format decimal string with EXPECTED_DECIMALS digits past the decimal
// point. JS Number has ~15.95 decimal digits of precision so trailing digits
// past ~15 are filler zeros — intentional padding canonicalising what "exact
// input" means at the oracle level.

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// -----------------------------------------------------------------------------
// Reproducible randomness (Park-Miller LCG, seed = bead filing date)
// -----------------------------------------------------------------------------

const SEED = 20260517;
const PARK_MILLER_M = 2147483647; // 2^31 − 1
const PARK_MILLER_A = 48271;

let lcgState = SEED;
function nextU01(): number {
  lcgState = (lcgState * PARK_MILLER_A) % PARK_MILLER_M;
  return lcgState / PARK_MILLER_M;
}
function uniform(lo: number, hi: number): number {
  return lo + (hi - lo) * nextU01();
}
function pick<T>(xs: readonly T[]): T {
  return xs[Math.floor(nextU01() * xs.length)];
}

// -----------------------------------------------------------------------------
// Decimal formatting — Wolfram-trap-proof (R5 §6 L1 carried from Erf G1)
// -----------------------------------------------------------------------------

const EXPECTED_DECIMALS = 60;

function formatDecimal(x: number): string {
  if (!Number.isFinite(x)) {
    if (Number.isNaN(x)) return "NaN";
    return x > 0 ? "Infinity" : "-Infinity";
  }
  if (Object.is(x, -0)) return "-0." + "0".repeat(EXPECTED_DECIMALS);
  if (x === 0) return "0." + "0".repeat(EXPECTED_DECIMALS);
  return x.toFixed(EXPECTED_DECIMALS);
}

// -----------------------------------------------------------------------------
// ν encoding — discriminated for adapter unambiguity
// -----------------------------------------------------------------------------

type Nu =
  | { nu_kind: "integer"; nu: string }
  | { nu_kind: "half-integer"; nu: string }        // form "(2n+1)/2", den=2 always
  | { nu_kind: "decimal"; nu: string };             // 60-dp string

function nuInt(n: number): Nu {
  if (!Number.isInteger(n)) throw new Error(`nuInt: ${n} is not an integer`);
  return { nu_kind: "integer", nu: String(n) };
}
function nuHalf(twiceNu: number): Nu {
  // ν = twiceNu / 2 where twiceNu is odd integer (so ν = (2k+1)/2)
  if (!Number.isInteger(twiceNu) || twiceNu % 2 === 0) {
    throw new Error(`nuHalf: ${twiceNu}/2 is not a half-integer`);
  }
  return { nu_kind: "half-integer", nu: `${twiceNu}/2` };
}
function nuDecimal(x: number): Nu {
  if (Number.isInteger(x)) throw new Error(`nuDecimal: ${x} is integer, use nuInt`);
  if (Number.isInteger(2 * x)) throw new Error(`nuDecimal: ${x} is half-integer, use nuHalf`);
  return { nu_kind: "decimal", nu: formatDecimal(x) };
}

// -----------------------------------------------------------------------------
// Tier scaffolding
// -----------------------------------------------------------------------------

type RealInput = { id: string; tier: string; head: string } & Nu & { z: string; notes?: string };
type ComplexInput = { id: string; tier: string; head: string } & Nu & {
  z: { re: string; im: string };
  notes?: string;
};
type ZeroInput = { id: string; tier: string; head: string } & Nu & {
  z: string;
  z_root_index?: number;
  z_root_distance?: string;
  notes?: string;
};
type CorpusInput = RealInput | ComplexInput | ZeroInput;

const inputs: CorpusInput[] = [];
const tierCounter = new Map<string, number>();
function nextId(tier: string, head: string): string {
  const key = `${tier}-${head.toLowerCase()}`;
  const n = (tierCounter.get(key) ?? 0) + 1;
  tierCounter.set(key, n);
  return `${tier}-${head.toLowerCase()}-${String(n).padStart(3, "0")}`;
}
function addReal(tier: string, head: string, nu: Nu, x: number, notes?: string): void {
  inputs.push({ id: nextId(tier, head), tier, head, ...nu, z: formatDecimal(x), notes });
}
function addComplex(tier: string, head: string, nu: Nu, re: number, im: number, notes?: string): void {
  inputs.push({
    id: nextId(tier, head),
    tier, head, ...nu,
    z: { re: formatDecimal(re), im: formatDecimal(im) },
    notes,
  });
}
function addZeroNear(tier: string, head: string, nu: Nu, z_root: number, root_idx: number, delta: number, notes?: string): void {
  const z = z_root + delta;
  inputs.push({
    id: nextId(tier, head), tier, head, ...nu,
    z: formatDecimal(z),
    z_root_index: root_idx,
    z_root_distance: formatDecimal(delta),
    notes,
  });
}

// -----------------------------------------------------------------------------
// Canonical ν values per class
// -----------------------------------------------------------------------------
// Integer: smallest few (cover J_0/J_1 special paths) + moderate + larger
const NU_INT: Nu[] = [nuInt(0), nuInt(1), nuInt(2), nuInt(3), nuInt(5), nuInt(10)];
// Half-integer: cover spherical-Bessel ladder + few more
const NU_HALF: Nu[] = [nuHalf(1), nuHalf(3), nuHalf(5), nuHalf(7)];   // 1/2, 3/2, 5/2, 7/2
// General real (non-integer, non-half-integer): cover ν > 0
const NU_GEN_POS: Nu[] = [nuDecimal(1.7), nuDecimal(2.3), nuDecimal(4.7)];
// Negative non-integer for T8: cover Y and K connection-formula branch
const NU_NEG_HALF: Nu[] = [nuHalf(-1), nuHalf(-3), nuHalf(-5)];   // -1/2, -3/2, -5/2
const NU_NEG_GEN: Nu[] = [nuDecimal(-1.7), nuDecimal(-2.3)];

const ALL_POS_NU: Nu[] = [...NU_INT, ...NU_HALF, ...NU_GEN_POS];
const ALL_HEADS = ["BesselJ", "BesselY", "BesselI", "BesselK"];
const SCALED_HEADS = ["BesselIScaled", "BesselKScaled"];

// =============================================================================
// T1 — small-z series  |z| ∈ (0, 8]  (₀F₁ Maclaurin regime per R2 §3.1)
// =============================================================================
// ₀F₁ direct path is valid for |z| < 8 unconditionally per FLINT; covers all 4
// heads × 3 ν-classes. Canonical anchors: very-small z (test ε limit), z=1
// (unit), z=2π (one wavelength oscillation for J/Y), z=8 (boundary).

const T1_CANONICAL_Z = [1e-3, 0.1, 0.5, 1.0, Math.PI, 2 * Math.PI, 8.0];

for (const head of ALL_HEADS) {
  for (const nu of ALL_POS_NU) {
    for (const z of T1_CANONICAL_Z) {
      addReal("T1", head, nu, z, `canonical: ν=${nu.nu} z=${z.toFixed(4)}`);
    }
    // Plus 2 LCG-sampled
    for (let i = 0; i < 2; i++) {
      addReal("T1", head, nu, uniform(1e-3, 8.0), "LCG-sampled");
    }
  }
}

// =============================================================================
// T2 — mid-z  |z| ∈ (8, 60]  (cancellation-retry ₀F₁ / Hankel-boundary)
// =============================================================================
// Per R2: ₀F₁ with cancellation-retry until |z| > z_c_Hankel(p) = p/2. For
// double-precision (p=53) z_c ≈ 26.5; for 200-bit (60dp) z_c ≈ 100. T2 covers
// the gap where the impl chooses dynamically between paths.

const T2_CANONICAL_Z = [8.5, 12, 20, 30, 50, 60];

for (const head of ALL_HEADS) {
  for (const nu of ALL_POS_NU) {
    for (const z of T2_CANONICAL_Z) {
      addReal("T2", head, nu, z, `canonical: ν=${nu.nu} z=${z.toFixed(1)}`);
    }
    // Plus 1 LCG-sampled
    addReal("T2", head, nu, uniform(8, 60), "LCG-sampled");
  }
}

// =============================================================================
// T3 — large-z asymptotic  |z| ∈ (60, 300]  (Hankel regime)
// =============================================================================
// At 200-bit precision z_c ≈ 100; at 500-bit z_c ≈ 250. Corpus reaches 300 to
// cover all precisions up to ~600 bits. K_ν underflows for |z| > ~700 in
// float64 — ScaledHeads cover those regimes; T3 stays well below the
// underflow cliff. I_ν overflows past z > 700; scaled needed there too.

const T3_CANONICAL_Z = [61, 80, 100, 150, 200, 300];

for (const head of ALL_HEADS) {
  for (const nu of ALL_POS_NU) {
    for (const z of T3_CANONICAL_Z) {
      addReal("T3", head, nu, z, `canonical-asymptotic: ν=${nu.nu} z=${z}`);
    }
  }
}
// Scaled variants for T3 at moderate-ν integer only
for (const head of SCALED_HEADS) {
  for (const nu of [nuInt(0), nuInt(1), nuInt(3), nuInt(5)]) {
    for (const z of [80, 150, 250]) {
      addReal("T3", head, nu, z, `scaled-variant-large-z: ν=${nu.nu} z=${z}`);
    }
  }
}

// =============================================================================
// T4 — transition region |z| ≈ ν  (FLINT-pattern cancellation-retry)
// =============================================================================
// Per R2 §3.2 the algorithmically hardest region (no power series, no Hankel).
// v0.1 ships cancellation-retry ₀F₁; v0.2 would add Olver-uniform / Temme-CF
// (deferred per ADR-0041 §"What we will not decide").
// Cover both sides of the transition.

const T4_RATIOS = [0.7, 0.85, 0.95, 1.05, 1.15, 1.3];   // z/ν

for (const head of ALL_HEADS) {
  for (const nu of [nuInt(5), nuInt(10), nuHalf(7), nuDecimal(4.7)]) {
    const nuVal = nu.nu_kind === "integer" ? Number(nu.nu)
                : nu.nu_kind === "half-integer" ? Number(nu.nu.split("/")[0]) / 2
                : Number(nu.nu);
    for (const r of T4_RATIOS) {
      addReal("T4", head, nu, nuVal * r, `transition: z/ν=${r}`);
    }
  }
}

// =============================================================================
// T5 — complex Q1-Q4  |z| ∈ [0.5, 30] gridded  (Amos-rotation full complex)
// =============================================================================
// All 4 heads × 3 ν-classes × 4 quadrant samples. Magnitudes span small-z
// (Maclaurin) through large-z (Hankel) so the Amos-rotation algorithm path
// exercises across regimes.

const T5_QUADRANTS: { name: string; theta_lo: number; theta_hi: number }[] = [
  { name: "Q1", theta_lo: 0.1, theta_hi: Math.PI / 2 - 0.1 },
  { name: "Q2", theta_lo: Math.PI / 2 + 0.1, theta_hi: Math.PI - 0.1 },
  { name: "Q3", theta_lo: -Math.PI + 0.1, theta_hi: -Math.PI / 2 - 0.1 },
  { name: "Q4", theta_lo: -Math.PI / 2 + 0.1, theta_hi: -0.1 },
];

for (const head of ALL_HEADS) {
  for (const nu of [nuInt(0), nuInt(3), nuHalf(3), nuDecimal(2.3)]) {
    for (const q of T5_QUADRANTS) {
      for (let i = 0; i < 2; i++) {
        const r = uniform(0.5, 30);
        const theta = uniform(q.theta_lo, q.theta_hi);
        addComplex("T5", head, nu, r * Math.cos(theta), r * Math.sin(theta), `${q.name} |z|=${r.toFixed(2)} arg=${theta.toFixed(3)}`);
      }
    }
  }
}

// =============================================================================
// T6 — edge cases  (float64 limit-of-representation)
// =============================================================================
// Honest-scope discipline carried from Erf T6. Bronze-tier oracles (libm,
// SciPy) ARE the reference for these. Bessel-specific: J_ν(0) = δ_{ν,0} for
// integer ν, undefined for non-integer; Y_ν(0+) = -∞ (logarithmic); K_ν(0+)
// = +∞ (logarithmic); I_ν(0) = δ_{ν,0} for integer ν.

const T6_EDGES: { z: number; note: string }[] = [
  { z: 0, note: "positive-zero (J_0(0)=1, J_n(0)=0 for n>0)" },
  { z: -0, note: "negative-zero" },
  { z: Infinity, note: "positive-infinity" },
  { z: -Infinity, note: "negative-infinity" },
  { z: Number.MIN_VALUE, note: "smallest-positive-subnormal-2^-1074" },
  { z: 2.2250738585072014e-308, note: "smallest-positive-normal-2^-1022" },
  { z: 700, note: "I/K overflow/underflow boundary; ive/kve scaled required" },
];

for (const head of ALL_HEADS) {
  for (const nu of [nuInt(0), nuInt(1), nuHalf(1)]) {
    for (const e of T6_EDGES) {
      addReal("T6", head, nu, e.z, `edge: ${e.note}`);
    }
    addReal("T6", head, nu, NaN, "edge: NaN");
  }
}

// =============================================================================
// T7 — high-ν Debye  ν ∈ [50, 500] integer × |z| ∈ ν · [0.5, 2]
// =============================================================================
// Per R2 §3.3, Debye asymptotic is the regime for large ν; v0.1 uses
// cancellation-retry ₀F₁ (Debye deferred). Corpus exercises this regime to
// pin the algorithm choice's accuracy + termination behaviour.

const T7_NU_VALUES: Nu[] = [nuInt(50), nuInt(100), nuInt(200), nuInt(500)];
const T7_Z_RATIOS = [0.5, 0.9, 1.0, 1.5, 2.0];

for (const head of ALL_HEADS) {
  for (const nu of T7_NU_VALUES) {
    const nuVal = Number(nu.nu);
    for (const r of T7_Z_RATIOS) {
      addReal("T7", head, nu, nuVal * r, `high-ν Debye: ν=${nuVal} z=${(nuVal * r).toFixed(0)}`);
    }
  }
}

// =============================================================================
// T8 — negative-real-ν boundary  (Y, K connection-formula branch)
// =============================================================================
// R5 §6 L3 landmine. Y_{-ν} and K_{-ν} for non-integer ν involve
// cos(νπ) / sin(νπ) cancellation near integers. Each oracle has its own
// convention — corpus pins the test cases the comparator tolerates.

for (const head of ["BesselY", "BesselK"]) {
  for (const nu of [...NU_NEG_HALF, ...NU_NEG_GEN]) {
    for (const z of [1.0, 5.0, 10.0]) {
      addReal("T8", head, nu, z, `negative-ν branch: ν=${nu.nu}`);
    }
  }
}

// =============================================================================
// T9 — Bessel zeros  (J_ν / Y_ν zero-crossing tolerance band, ADR-0041 §Dec 12)
// =============================================================================
// Pre-computed zeros from mpmath.besseljzero / besselyzero (50-dp precision)
// for the canonical ν values. Corpus emits z near each root with a delta
// inside the L7 tolerance band (< 0.01). The G8 comparator switches to
// absolute-error within this band.

// First 5 zeros of J_0 (DLMF Table 10.21.1; verified via mpmath.besseljzero(0, k))
const J0_ZEROS = [
  2.4048255576957727686,
  5.5200781102863106496,
  8.6537279129110122170,
  11.7915344390142816137,
  14.9309177084877859477,
];
// First 5 zeros of J_1
const J1_ZEROS = [
  3.8317059702075123157,
  7.0155866698156187536,
  10.1734681350627073914,
  13.3236919363142519861,
  16.4706300508776089335,
];
// First 5 zeros of Y_0
const Y0_ZEROS = [
  0.8935769662791675215,
  3.9576784193148578684,
  7.0860510603017726976,
  10.2223453479517495545,
  13.3610974738727557679,
];
// First 5 zeros of Y_1
const Y1_ZEROS = [
  2.1971413260310170351,
  5.4296810407941351327,
  8.5960058683311689265,
  11.7491548717387275064,
  14.8974421323142440623,
];

const T9_DELTAS = [0, 1e-4, 1e-3, 5e-3, -1e-3, -5e-3];   // inside the L7 band |δ| < 0.01

function emitZeroSamples(head: string, nu: Nu, roots: readonly number[]): void {
  roots.forEach((root, idx) => {
    for (const d of T9_DELTAS) {
      addZeroNear("T9", head, nu, root, idx + 1, d, `zero-band ν=${nu.nu} root ${idx + 1}`);
    }
  });
}

emitZeroSamples("BesselJ", nuInt(0), J0_ZEROS);
emitZeroSamples("BesselJ", nuInt(1), J1_ZEROS);
emitZeroSamples("BesselY", nuInt(0), Y0_ZEROS);
emitZeroSamples("BesselY", nuInt(1), Y1_ZEROS);

// =============================================================================
// T10 — large-ν integer  ν ∈ {50, 100, 200, 500} × |z| ∈ {1, 10}
// =============================================================================
// Overflow/underflow boundary regime. J_ν(z) underflows when ν >> z (because
// J_ν(z) ~ (z/2)^ν / Γ(ν+1) for small z); I_ν overflows for large argument;
// K_ν underflows. Scaled variants cover I_ν and K_ν; J and Y still tested
// directly to validate algorithm graceful-underflow behaviour.

const T10_NU: Nu[] = [nuInt(50), nuInt(100), nuInt(200), nuInt(500)];
const T10_Z = [1.0, 10.0];

for (const head of ALL_HEADS) {
  for (const nu of T10_NU) {
    for (const z of T10_Z) {
      addReal("T10", head, nu, z, `large-ν integer: ν=${nu.nu} z=${z} (J/I underflow when z<<ν; Y/K overflow)`);
    }
  }
}
// Scaled variants for the I/K overflow/underflow cases
for (const head of SCALED_HEADS) {
  for (const nu of T10_NU) {
    for (const z of T10_Z) {
      addReal("T10", head, nu, z, `scaled: ν=${nu.nu} z=${z}`);
    }
  }
}

// -----------------------------------------------------------------------------
// Emit
// -----------------------------------------------------------------------------

const corpus = {
  manifest_version: 1,
  generated_at: "2026-05-17T00:00:00Z",
  bead: "scientist-workbench-qccc",
  adr: "0041",
  seed: SEED,
  lcg: "Park-Miller (a=48271, m=2^31-1)",
  expected_decimals_per_value: EXPECTED_DECIMALS,
  expected_precision_decimals_for_gold_oracle: 50,
  nu_classes: {
    integer: "ν ∈ ℤ — exercises integer-recurrence + closed-form-at-0 paths",
    "half-integer": "ν = (2k+1)/2 — exercises J_{n+1/2} ↔ spherical-Bessel closures (R1 priority-class C)",
    decimal: "ν general real non-integer non-half-integer — exercises general-ν algorithm (₀F₁, Hankel asymptotic)",
  },
  tier_descriptions: {
    T1: "small-z series |z| ∈ (0, 8] — ₀F₁ Maclaurin regime (R2 §3.1)",
    T2: "mid-z |z| ∈ (8, 60] — cancellation-retry ₀F₁ / Hankel boundary",
    T3: "large-z asymptotic |z| ∈ (60, 300] — Hankel regime; z_c_Hankel(p)=p/2 (linear scaling)",
    T4: "transition |z| ≈ ν — algorithmically hardest region (R2 §3.2)",
    T5: "complex Q1-Q4 |z| ∈ [0.5, 30] — Amos-rotation full complex path",
    T6: "edges ±0, ±∞, NaN, subnormal, 700-boundary — float64 limit-of-representation",
    T7: "high-ν Debye ν ∈ [50, 500] × |z| ∈ ν·[0.5, 2] — large-ν asymptotic regime",
    T8: "negative-real-ν Y/K connection-formula branch (R5 §6 L3 landmine)",
    T9: "Bessel zeros — zero-crossing tolerance band per ADR-0041 §Decision 12 (|δ|<0.01)",
    T10: "large-ν integer — overflow/underflow boundary; scaled variants for I/K",
  },
  totals: {
    by_tier: Object.fromEntries(
      [...new Set(inputs.map((i) => i.tier))]
        .sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)))
        .map((t) => [t, inputs.filter((i) => i.tier === t).length]),
    ),
    by_head: Object.fromEntries(
      [...new Set(inputs.map((i) => i.head))]
        .sort()
        .map((h) => [h, inputs.filter((i) => i.head === h).length]),
    ),
    by_nu_class: Object.fromEntries(
      ["integer", "half-integer", "decimal"]
        .map((c) => [c, inputs.filter((i) => i.nu_kind === c).length]),
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
  console.log("By ν-class:", corpus.totals.by_nu_class);
}
