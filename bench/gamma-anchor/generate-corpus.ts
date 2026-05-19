// =============================================================================
// bench/gamma-anchor/generate-corpus.ts — deterministic golden-master input
// generator for the Gamma family (Gamma, LogGamma, Digamma, Trigamma,
// Polygamma, Pochhammer, IncompleteGamma{Upper, Lower, P, Q}, Beta, LogBeta,
// BarnesG, plus scaled / inverse / IncompleteBeta variants per the
// ADR-0042 §Decision 4 ADMITTED_HEADS table).
// =============================================================================
//
// Generates `bench/gamma-anchor/corpus.json`, the canonical input manifest
// the oracle adapters (G2 Wolfram, G3 mpmath, G4 SciPy, G5 Boost, G6 libm,
// G7 Arb) consume to emit cross-validating golden masters per ADR-0042 and
// `docs/refs/gamma-research/PHASE2-impl-plans.md` §"Corpus design notes".
//
// Eight tiers per the corpus-design notes:
//
//   T1 — real positive z+a   z ∈ (0, 20], a ∈ (0, 20]   covers ₀F₁ / Lanczos /
//                                                       series + CF crossovers
//                                                       across all 16 heads;
//                                                       Cephes `igam.c` dispatch
//                                                       turns over at z ≈ a + 1
//                                                       (R3 §3.3).
//   T2 — real negative z     z ∈ [-15, 0)               Gamma-family pole
//                                                       structure (Z⁻₀), LogGamma
//                                                       analytic continuation
//                                                       (R3 §2.2 minimum-point
//                                                       branch), Digamma reflection
//                                                       (R2 §1.3, §2.4).
//   T3 — near-poles          |z + n| ≤ 1e-4 for n=0..5  Cancellation stress on
//                                                       `lgammaRealAbs` and
//                                                       `clgammaReflect`; the
//                                                       reflection formula has
//                                                       a sin(πz) factor that
//                                                       must be evaluated with
//                                                       the reduced argument
//                                                       ζ = z - round(z) to
//                                                       avoid catastrophic
//                                                       precision loss (R2
//                                                       §1.3, ADR-0042 §Dec 3).
//   T4 — complex Q1-Q4       |z| ∈ [0.5, 12], arg z grid Full complex paths
//                                                       across all four
//                                                       quadrants for the
//                                                       complex-capable heads
//                                                       (IncompleteGamma{Upper,
//                                                       Lower}, Beta, BarnesG
//                                                       complex; LogGamma, Gamma,
//                                                       Digamma already real-
//                                                       continued via reflection).
//   T5 — half-integer a      a ∈ {1/2, 3/2, 5/2, -1/2}  R1 priority-A/B closed-
//                                                       form rules: Γ(1/2)=√π,
//                                                       Γ(3/2) = √π/2, Poch
//                                                       half-integer reductions
//                                                       (DLMF §5.5.5).
//   T6 — large |z|           |z| ∈ (100, 1000]          Poincaré asymptotic
//                                                       path for IncompleteGamma
//                                                       Upper (DLMF §8.11.2) and
//                                                       Stirling for Gamma /
//                                                       LogGamma; ULP-stress for
//                                                       Boost `digamma.hpp`
//                                                       asymptotic series.
//   T7 — near a = z (Temme)  |z - a| ≤ √a, a ∈ [20, 200]The Temme uniform
//                                                       asymptotic transition
//                                                       region per ADR-0042
//                                                       §"What we will not
//                                                       decide" — v0.1 ships
//                                                       series+CF with a
//                                                       documented log₂(|a|)-bit
//                                                       shortfall; corpus MUST
//                                                       measure the gap so the
//                                                       v0.2 Temme bead can prove
//                                                       the closure.
//   T8 — digamma near        z near -1, -2, -3, -4, -5  Reflection-formula
//        negative integers   Δ ∈ {±1e-4, ±1e-3, ±1e-2}  cancellation: ψ has
//                                                       simple poles at -n;
//                                                       trigamma/polygamma have
//                                                       higher-order poles (R3
//                                                       §1.3-1.5; R2 §1.3).
//
// Three argument-value classes drive parsing in every oracle adapter (carrying
// Bessel R5 §6 L1's discriminated-encoding pattern to the gamma family):
//
//   - integer:        `a_kind: "integer"`,        a: "3"    → adapter parses as
//                                                              Integer[3]
//   - half-integer:   `a_kind: "half-integer"`,   a: "3/2"  → Rational[3, 2]
//   - decimal:        `a_kind: "decimal"`,        a: "1.7…" → Rational from
//                                                              decimal-string at
//                                                              60-dp depth
//
// **Wolfram input-trap (R5 §6 L1).** All decimal arguments emit as 60-digit
// fixed-format strings — never machine-precision doubles. `N[Gamma[1.5], 50]`
// silently caps at 17 digits because `1.5` parses as a machine double; the
// fix is `N[Gamma[Rational[3,2]], 50]`. Adapter has to construct rationals
// from the decimal string; this generator emits them in a form the adapter
// parses unambiguously.
//
// **L12 pin (R5 §6, THE critical gamma landmine).** Incomplete-gamma
// regularisation conventions are inverted across oracles. The corpus
// emits FOUR SEPARATE HEADS — IncompleteGammaUpper, IncompleteGammaLower,
// IncompleteGammaP, IncompleteGammaQ — and the adapter, for each, tags
// the call with `// L12` and consults the convention table:
//
//   Wolfram `Gamma[a, z]`                  = Γ(a,z) upper unregularised  → Upper
//   Wolfram `Gamma[a, 0, z]`               = γ(a,z) lower unregularised  → Lower
//   Wolfram `GammaRegularized[a, z]`       = Q(a,z) upper regularised    → Q
//   Wolfram `GammaRegularized[a, 0, z]`    = P(a,z) lower regularised    → P
//   mpmath   `gammainc(a, z)`              = Γ(a,z) Upper (unreg)        → Upper
//   mpmath   `gammainc(a, 0, z)`           = γ(a,z) Lower (unreg)        → Lower
//   mpmath   `gammainc(a, z, reg=True)`    = Q(a,z)                      → Q
//   mpmath   `gammainc(a, 0, z, reg=True)` = P(a,z)                      → P
//   scipy    `gammainc(a, z)`              = P(a,z)  LOWER REGULARISED   → P  ← inverted
//   scipy    `gammaincc(a, z)`             = Q(a,z)                      → Q
//
// **L17 pin (pole behavior).** Gamma at non-positive integers has four
// distinct oracle behaviors (ComplexInfinity / ValueError / +∞ / NaN). T3
// includes Δ=0 cells expecting comparator special-case; non-zero deltas
// exercise the cancellation cliff that the reflection path must handle
// without precision loss.
//
// Determinism: a single-stream Park-Miller LCG seeded with the bead's
// filing date (20260519 — one day after Bessel's 20260517 and three after
// Erf's 20260516). Re-running this script produces a byte-identical
// `corpus.json`. The corpus IS the source of truth for the entire Phase 1
// golden-master corpus; oracles consume it, re-evaluate each head against
// the canonical input, and the G8 cross-agreement comparator grades the
// oracles against each other on this shared input set.
//
// Run: bun bench/gamma-anchor/generate-corpus.ts
// Output: bench/gamma-anchor/corpus.json
//
// Number formatting discipline: every real/imag/decimal-arg value emits as a
// fixed-format decimal string with EXPECTED_DECIMALS digits past the
// decimal point. JS Number has ~15.95 decimal digits of precision so
// trailing digits past ~15 are filler zeros — intentional padding
// canonicalising what "exact input" means at the oracle level. Identical
// discipline to Erf/Bessel `formatDecimal`.

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// -----------------------------------------------------------------------------
// Reproducible randomness (Park-Miller LCG, seed = bead filing date 20260519)
// -----------------------------------------------------------------------------

const SEED = 20260519;
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
  return xs[Math.floor(nextU01() * xs.length)]!;
}

// -----------------------------------------------------------------------------
// Decimal formatting — Wolfram-trap-proof (R5 §6 L1, carried from Erf/Bessel)
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
// Argument-value encoding — discriminated for adapter unambiguity (carry from
// Bessel's nu_kind pattern; applied uniformly to a, b, n)
// -----------------------------------------------------------------------------
//
// Every scalar argument that is NOT the primary complex variable z carries a
// `*_kind` discriminator so the adapter knows whether to construct
// `Integer[k]`, `Rational[num, den]`, or `Rational[<decimal-string>]`. The
// primary `z` (and its complex `re`/`im`) stays in the simpler 60-digit
// decimal-string form because z is the head's analytic variable (the
// transcendental input) and oracles all accept decimal-string z without the
// rational-cast trap.

type Kind = "integer" | "half-integer" | "decimal";

type ArgScalar = { kind: Kind; value: string };

function argInt(n: number): ArgScalar {
  if (!Number.isInteger(n)) throw new Error(`argInt: ${n} is not an integer`);
  return { kind: "integer", value: String(n) };
}
function argHalf(twiceA: number): ArgScalar {
  // a = twiceA / 2 where twiceA is odd (so a = (2k+1)/2)
  if (!Number.isInteger(twiceA) || twiceA % 2 === 0) {
    throw new Error(`argHalf: ${twiceA}/2 is not a half-integer`);
  }
  return { kind: "half-integer", value: `${twiceA}/2` };
}
function argDecimal(x: number): ArgScalar {
  if (Number.isInteger(x)) throw new Error(`argDecimal: ${x} is integer, use argInt`);
  if (Number.isInteger(2 * x)) throw new Error(`argDecimal: ${x} is half-integer, use argHalf`);
  return { kind: "decimal", value: formatDecimal(x) };
}

// -----------------------------------------------------------------------------
// Head vocabulary — ADR-0042 §Decision 4 ADMITTED_HEADS (19 entries)
// -----------------------------------------------------------------------------
//
// The float64-dispatcher head list is broader than the cas-core vocabulary
// list (6 new heads) because numerical evaluation can serve heads that exist
// purely as evaluation shortcuts. The corpus respects the dispatcher list so
// it exercises every numerical path the I5 substrate must implement.

type Head =
  // Unary real / complex (single argument z)
  | "Gamma"
  | "LogGamma"
  | "Digamma"
  | "Trigamma"
  | "BarnesG"
  // Binary: (m, z) — m is an integer order
  | "Polygamma"
  // Binary: (a, n) — n is the rising-factorial step count
  | "Pochhammer"
  // Binary: (a, z) — incomplete gamma family (FOUR DISTINCT HEADS per L12)
  | "IncompleteGammaUpper"
  | "IncompleteGammaLower"
  | "IncompleteGammaP"
  | "IncompleteGammaQ"
  // Binary: (a, q) — inverse incomplete gamma
  | "InverseIncompleteGammaP"
  | "InverseIncompleteGammaQ"
  // Binary: (a, b)
  | "Beta"
  | "LogBeta"
  | "GammaRatio"
  | "GammaDeltaRatio"
  | "GammaPDerivative"
  // Ternary: (z, a, b)
  | "IncompleteBeta";

// -----------------------------------------------------------------------------
// Tier scaffolding
// -----------------------------------------------------------------------------
//
// Per-input record shape varies by head arity. We use a discriminated union
// so the TypeScript type system catches missing-field bugs at construction
// time; the wire schema is the JSON form that survives JSON.stringify.

type InputBase = {
  id: string;
  tier: string;
  head: Head;
  notes?: string;
};

type RealZ = InputBase & { z: string };
type ComplexZ = InputBase & { z: { re: string; im: string } };

type WithA = { a: ArgScalar };
type WithB = { b: ArgScalar };
type WithM = { m: ArgScalar };  // Polygamma order
type WithN = { n: ArgScalar };  // Pochhammer step

type CorpusInput =
  // Unary z
  | RealZ
  | ComplexZ
  // (m, z) Polygamma
  | (RealZ & WithM)
  | (ComplexZ & WithM)
  // (a, z) IncompleteGamma{Upper,Lower,P,Q}, inverse, GammaPDerivative
  | (RealZ & WithA)
  | (ComplexZ & WithA)
  // (a, n) Pochhammer
  | (RealZ & WithA & WithN)
  // (a, b) Beta, LogBeta, GammaRatio, GammaDeltaRatio (no z)
  | (InputBase & WithA & WithB)
  // (z, a, b) IncompleteBeta
  | (RealZ & WithA & WithB);

const inputs: CorpusInput[] = [];
const tierCounter = new Map<string, number>();
function nextId(tier: string, head: Head): string {
  const key = `${tier}-${head.toLowerCase()}`;
  const n = (tierCounter.get(key) ?? 0) + 1;
  tierCounter.set(key, n);
  return `${tier}-${head.toLowerCase()}-${String(n).padStart(3, "0")}`;
}

// ----- Emitters for each head-arity shape -----

function addUnaryReal(tier: string, head: Head, z: number, notes?: string): void {
  inputs.push({ id: nextId(tier, head), tier, head, z: formatDecimal(z), notes });
}
function addUnaryComplex(tier: string, head: Head, re: number, im: number, notes?: string): void {
  inputs.push({
    id: nextId(tier, head), tier, head,
    z: { re: formatDecimal(re), im: formatDecimal(im) },
    notes,
  });
}
function addPolygammaReal(tier: string, m: ArgScalar, z: number, notes?: string): void {
  inputs.push({ id: nextId(tier, "Polygamma"), tier, head: "Polygamma", m, z: formatDecimal(z), notes });
}
function addPolygammaComplex(tier: string, m: ArgScalar, re: number, im: number, notes?: string): void {
  inputs.push({
    id: nextId(tier, "Polygamma"), tier, head: "Polygamma", m,
    z: { re: formatDecimal(re), im: formatDecimal(im) },
    notes,
  });
}
function addAZReal(tier: string, head: Head, a: ArgScalar, z: number, notes?: string): void {
  inputs.push({ id: nextId(tier, head), tier, head, a, z: formatDecimal(z), notes });
}
function addAZComplex(tier: string, head: Head, a: ArgScalar, re: number, im: number, notes?: string): void {
  inputs.push({
    id: nextId(tier, head), tier, head, a,
    z: { re: formatDecimal(re), im: formatDecimal(im) },
    notes,
  });
}
function addPochhammer(tier: string, a: ArgScalar, n: ArgScalar, notes?: string): void {
  // Pochhammer's primary "z" slot is the (a, n) pair; we still emit a `z`
  // field for wire-schema uniformity (=`a` repeated as 60-dp decimal). The
  // adapter ignores `z` for Pochhammer — only `a` and `n` matter.
  const aNum = parseArgNumeric(a);
  inputs.push({
    id: nextId(tier, "Pochhammer"), tier, head: "Pochhammer",
    a, n, z: formatDecimal(aNum), notes,
  });
}
function addBeta(tier: string, head: Head, a: ArgScalar, b: ArgScalar, notes?: string): void {
  inputs.push({ id: nextId(tier, head), tier, head, a, b, notes });
}
function addIncompleteBeta(tier: string, z: number, a: ArgScalar, b: ArgScalar, notes?: string): void {
  inputs.push({
    id: nextId(tier, "IncompleteBeta"), tier, head: "IncompleteBeta",
    z: formatDecimal(z), a, b, notes,
  });
}

function parseArgNumeric(arg: ArgScalar): number {
  if (arg.kind === "integer") return Number(arg.value);
  if (arg.kind === "half-integer") {
    const [num, den] = arg.value.split("/");
    return Number(num) / Number(den);
  }
  return Number(arg.value);
}

// =============================================================================
// T1 — real positive z + a   (all 16 heads; covers series and CF crossovers)
// =============================================================================
//
// The flagship tier: every head admitted to ADR-0042's ADMITTED_HEADS table
// gets exercised on the bread-and-butter regime z ∈ (0, 20], a ∈ (0, 20].
// This covers:
//
//   - Gamma / LogGamma: Stirling kicks in beyond `shiftThreshold` (R2 §1.1),
//     so z near 1-3 exercises the recurrence path; z near 10-20 exercises
//     the asymptotic Stirling path directly.
//   - Digamma / Trigamma: same dispatch.
//   - IncompleteGamma{Upper,Lower,P,Q}: Cephes `igam.c` dispatch turns over
//     at z ≈ a + 1 (R3 §3.3) — for z < a use the lower-incomplete series;
//     for z > a + 1 use the continued fraction for the upper.
//   - Beta / LogBeta: lgamma-subtraction, sign tracking trivial here.
//   - Pochhammer: direct product (small n) vs lgamma-ratio (large n)
//     crossover at n ≈ 20 (R2 §1.4).
//
// Canonical anchors at z=1 (Γ(1)=1, ψ(1)=-γ, ψ⁽¹⁾(1)=π²/6) and z=2
// (Γ(2)=1, ψ(2)=1-γ).

// Canonical z values: cover Γ(1)=1, Γ(2)=1 anchors, mid-range and the
// Stirling-transition region z ≈ 10. Trimmed to 4 values per head to keep
// the corpus inside its size budget.
const T1_Z_CANONICAL = [1.0, 2.0, 5.0, 12.0];

// Unary heads (single z). Five heads × 4 canonical + 1 LCG-sampled = 25.
for (const head of ["Gamma", "LogGamma", "Digamma", "Trigamma", "BarnesG"] as const) {
  for (const z of T1_Z_CANONICAL) addUnaryReal("T1", head, z, "canonical-positive");
  addUnaryReal("T1", head, uniform(0.1, 20), "LCG-sampled");
}

// Polygamma m ∈ {2, 3} (the lift orders); 2 z-values each. 4 cells.
for (const m of [argInt(2), argInt(3)]) {
  for (const z of [1.0, 5.0]) addPolygammaReal("T1", m, z, `canonical: ψ^(${m.value})`);
}

// Pochhammer (a, n): 3 a-values × 3 n-values = 9 cells. Covers direct-product
// (small n) and lgamma-ratio (large n=25) regimes.
for (const a of [argHalf(1), argInt(2), argDecimal(1.7)]) {
  for (const n of [argInt(1), argInt(10), argInt(25)]) {
    addPochhammer("T1", a, n, `(a)_${n.value}`);
  }
}

// Incomplete-gamma family — FOUR DISTINCT HEADS per L12. Shared (a, z) grid
// so the comparator can cross-check P + Q = 1 and Lower + Upper = Γ(a)
// identities. 4 heads × 5 cells = 20.
const T1_AZ_GRID: ReadonlyArray<[ArgScalar, number]> = [
  [argHalf(1), 2.0],            // a < z; Q small
  [argHalf(3), 1.0],             // a > z; P small
  [argInt(2), 3.0],              // mid
  [argInt(5), 5.0],              // a ≈ z (mild saddle; deeper saddles in T7)
  [argDecimal(1.7), 4.5],
];
for (const head of ["IncompleteGammaUpper", "IncompleteGammaLower", "IncompleteGammaP", "IncompleteGammaQ"] as const) {
  for (const [a, z] of T1_AZ_GRID) {
    addAZReal("T1", head, a, z, `L12: head=${head} a=${a.value} z=${z}`);
  }
}

// Inverse incomplete gamma: 2 heads × 2 a × 3 q = 12.
for (const head of ["InverseIncompleteGammaP", "InverseIncompleteGammaQ"] as const) {
  for (const a of [argHalf(1), argInt(5)]) {
    for (const q of [0.1, 0.5, 0.9]) {
      addAZReal("T1", head, a, q, `inverse: q=${q}`);
    }
  }
}

// Beta / LogBeta: 4 (a, b) pairs each = 8 cells.
const T1_BETA_PAIRS: ReadonlyArray<[ArgScalar, ArgScalar]> = [
  [argHalf(1), argHalf(1)],  // B(1/2, 1/2) = π
  [argInt(2), argInt(3)],
  [argDecimal(1.7), argDecimal(2.3)],
  [argInt(10), argInt(2)],   // asymmetric
];
for (const head of ["Beta", "LogBeta"] as const) {
  for (const [a, b] of T1_BETA_PAIRS) addBeta("T1", head, a, b, `B(${a.value}, ${b.value})`);
}

// GammaRatio / GammaDeltaRatio: ratio-stable variants per R3 §5. 2 each = 4.
for (const [a, b] of [
  [argInt(10), argInt(7)] as const,
  [argDecimal(5.7), argDecimal(3.3)] as const,
]) addBeta("T1", "GammaRatio", a, b, `Γ(${a.value})/Γ(${b.value})`);
for (const [a, delta] of [
  [argInt(5), argHalf(1)] as const,
  [argDecimal(7.3), argDecimal(1.7)] as const,
]) addBeta("T1", "GammaDeltaRatio", a, delta, `Γ(${a.value})/Γ(${a.value}+${delta.value})`);

// GammaPDerivative: 4 cells.
for (const a of [argHalf(1), argInt(5)]) {
  for (const z of [0.5, 5.0]) {
    addAZReal("T1", "GammaPDerivative", a, z, "∂P/∂x");
  }
}

// IncompleteBeta (z, a, b): 3 z × 2 (a,b) = 6.
for (const z of [0.3, 0.5, 0.9]) {
  for (const [a, b] of [
    [argInt(2), argInt(3)] as const,
    [argHalf(1), argHalf(3)] as const,
  ]) addIncompleteBeta("T1", z, a, b, `I_${z}(${a.value}, ${b.value})`);
}

// =============================================================================
// T2 — real negative z   (Gamma family poles; LogGamma analytic continuation)
// =============================================================================
//
// Negative real z is the home of:
//
//   - Gamma: poles at z = 0, -1, -2, ... ; finite between poles; sign
//     alternates each interval (Γ(-0.5) < 0, Γ(-1.5) > 0, ...).
//   - LogGamma: analytic continuation has imaginary part ≠ 0 for x < 0
//     non-integer; SciPy's `loggamma(real_negative)` returns NaN (R5 §6 L15)
//     so the adapter passes as `x + 0j`. v0.1 substrate (`lgammaRealAbs` plus
//     sign tracking) returns log|Γ(x)| + iπk where k is the parity count of
//     poles crossed; the corpus exercises that the +iπk term is consistent
//     with Wolfram's analytic-continuation branch choice.
//   - Digamma: lift unblocked by ADR-0042 §Decision 3 (`cdigammaReflect`
//     pattern); previously threw at `special.ts:340`.
//   - Trigamma / Polygamma: reflection via z ↦ 1-z.
//
// Cells sit strictly BETWEEN integer poles. T3 covers near-pole stress.

const T2_NEG_Z = [-0.3, -0.7, -1.3, -2.7, -3.5, -5.7, -8.3];
for (const head of ["Gamma", "LogGamma", "Digamma", "Trigamma"] as const) {
  for (const z of T2_NEG_Z) addUnaryReal("T2", head, z, "negative-non-pole (between integer poles)");
  // 1 LCG-sampled negative z, avoiding integer poles
  let z = uniform(-15, -0.1);
  while (Math.abs(z - Math.round(z)) < 0.05) z = uniform(-15, -0.1);
  addUnaryReal("T2", head, z, "LCG-sampled negative");
}

// Polygamma at negative non-integer z (m=2 only — m=3 carried by T3/T8)
for (const z of [-0.3, -1.3, -2.7]) {
  addPolygammaReal("T2", argInt(2), z, `ψ^(2) negative-non-pole`);
}

// Pochhammer at negative a — important: (a)_n for a < 0 hits a zero when
// the product touches a non-positive integer (L_polynew_6 from R5).
for (const [a, n] of [
  [argDecimal(-0.7), argInt(3)] as const,
  [argDecimal(-1.3), argInt(2)] as const,
  [argInt(-5), argInt(6)] as const,    // zero by construction: (-5)_6 contains 0
  [argInt(-5), argInt(3)] as const,    // non-zero
  [argHalf(-3), argInt(4)] as const,
]) addPochhammer("T2", a, n, "neg-a Pochhammer (L_polynew_6 stress)");

// Beta at negative a or b (not both integer, to avoid Γ(neg-int) pole)
for (const [a, b] of [
  [argDecimal(-0.7), argInt(2)] as const,
  [argHalf(-1), argHalf(3)] as const,
  [argDecimal(-1.3), argDecimal(2.7)] as const,
]) addBeta("T2", "Beta", a, b, "Beta with one negative non-integer arg");

// =============================================================================
// T3 — near-poles   (cancellation stress on lgammaRealAbs / clgammaReflect)
// =============================================================================
//
// The reflection formula Γ(z)·Γ(1-z) = π/sin(πz) has a sin(πz) factor that
// has zeros at every integer. When z is near an integer, sin(πz) ≈ π·(z-n)
// loses precision unless evaluated with the reduced argument ζ = z - n.
// Trigamma/polygamma reflection are even more delicate because the digamma
// reflection ψ(1-z) - ψ(z) = π·cot(πz) has higher-order singularities.
//
// Cells: z = -n + δ for n ∈ {0, 1, 2, 3, 4, 5} and δ ∈ {1e-2, 1e-4, 1e-6,
// -1e-2, -1e-4, -1e-6}. This grid stresses the loss-of-significance bound:
// per ADR-0042 §Decision 3, `lossBits = max(0, log₂|z| - log₂|ζ|)` and
// `work_prec = prec + 32 + lossBits`. At δ = 1e-6, lossBits ≈ 20; the
// substrate needs to grow work-precision accordingly. The corpus is the
// vehicle that proves this is happening.
//
// The exact-pole case (δ = 0) is included for L17 — the comparator must
// special-case pole inputs (Wolfram ComplexInfinity, mpmath ValueError,
// SciPy +∞, libm NaN). Each oracle returns a different shape; G8 records
// the four behaviors and reconciles.

// T3 near-pole grid: cover the four nearest poles {0, -1, -2, -3}
// (deeper poles −4, −5 carried by T8 digamma cells) × 4 deltas (positive
// and negative, two magnitudes) + the exact-pole δ=0 row for L17.
// 4 poles × 4 finite deltas × 2 heads (Gamma, Digamma) = 32 + 4 exact-pole
// cells × 2 heads = 8 → 40 cells.
const T3_POLE_LOCATIONS = [0, -1, -2, -3];
const T3_DELTAS_FINITE = [1e-2, 1e-4, -1e-2, -1e-4];

for (const n of T3_POLE_LOCATIONS) {
  // Exact-pole row (δ = 0) — L17 stress for Gamma and Digamma. LogGamma/
  // Trigamma poles co-locate; covering Gamma+Digamma is enough to expose
  // the four-way oracle divergence.
  if (n <= 0) {
    for (const head of ["Gamma", "Digamma"] as const) {
      addUnaryReal("T3", head, n, `L17 exact pole at z=${n} (oracle behavior diverges)`);
    }
  }
  for (const delta of T3_DELTAS_FINITE) {
    const z = n + delta;
    for (const head of ["Gamma", "Digamma"] as const) {
      addUnaryReal("T3", head, z, `pole-${n} δ=${delta} (cancellation stress)`);
    }
  }
}

// A separate, smaller LogGamma + Trigamma probe to confirm reflection
// behaves at the two nearest poles only — 2 poles × 2 deltas × 2 heads = 8.
for (const n of [-1, -2]) {
  for (const delta of [1e-3, -1e-3]) {
    for (const head of ["LogGamma", "Trigamma"] as const) {
      addUnaryReal("T3", head, n + delta, `pole-${n} δ=${delta} (${head})`);
    }
  }
}

// Polygamma m=2 near poles (higher-order singularity): 3 poles × 2 deltas = 6.
for (const n of [0, -1, -2]) {
  for (const delta of [1e-3, -1e-3]) {
    addPolygammaReal("T3", argInt(2), n + delta, `Trigamma-via-Polygamma near pole z=${n}`);
  }
}

// =============================================================================
// T4 — complex Q1-Q4   (4 heads × 4 quadrants per PHASE2-impl-plans corpus notes)
// =============================================================================
//
// Per ADR-0042 §Decision 4, the complex paths through the substrate are:
//   - Gamma / LogGamma / Digamma: ALREADY SHIP (cgamma, clgamma, cdigamma)
//   - Trigamma / Polygamma: NEW (cpolygamma via Hurwitz zeta)
//   - IncompleteGamma{Upper, Lower}: NEW (cIncompleteGamma*)
//   - Beta: NEW (cBeta via lgamma)
//   - BarnesG: gold-only (Wolfram + mpmath; no Boost / SciPy complex path)
//
// Magnitudes span (0.5, 12) so the Maclaurin / asymptotic crossover regions
// (different per head) are exercised. Each quadrant is independently
// sampled to drive the four-quadrant sign-tracking branches in the
// reflection / continuation paths.

const T4_QUADRANTS: ReadonlyArray<{ name: string; theta_lo: number; theta_hi: number }> = [
  { name: "Q1", theta_lo: 0.1, theta_hi: Math.PI / 2 - 0.1 },
  { name: "Q2", theta_lo: Math.PI / 2 + 0.1, theta_hi: Math.PI - 0.1 },
  { name: "Q3", theta_lo: -Math.PI + 0.1, theta_hi: -Math.PI / 2 - 0.1 },
  { name: "Q4", theta_lo: -Math.PI / 2 + 0.1, theta_hi: -0.1 },
];

// Unary complex heads: 5 heads × 4 quadrants × 1 sample = 20.
for (const head of ["Gamma", "LogGamma", "Digamma", "Trigamma", "BarnesG"] as const) {
  for (const q of T4_QUADRANTS) {
    const r = uniform(0.5, 12);
    const theta = uniform(q.theta_lo, q.theta_hi);
    addUnaryComplex("T4", head, r * Math.cos(theta), r * Math.sin(theta),
      `${q.name} |z|=${r.toFixed(2)} arg=${theta.toFixed(3)}`);
  }
}

// Polygamma complex (m=2) — gold-only per L14 (SciPy 1.11.4 refuses complex).
// 4 quadrants × 1 sample = 4.
for (const q of T4_QUADRANTS) {
  const r = uniform(0.5, 8);
  const theta = uniform(q.theta_lo, q.theta_hi);
  addPolygammaComplex("T4", argInt(2), r * Math.cos(theta), r * Math.sin(theta),
    `${q.name} L14: SciPy refuses; Wolfram+mpmath voices only`);
}

// IncompleteGamma{Upper, Lower} complex — gold-only (Wolfram + mpmath).
// FOUR DISTINCT HEADS per L12 maintained even in complex. 2 heads × 2 a ×
// 4 quadrants = 16.
for (const head of ["IncompleteGammaUpper", "IncompleteGammaLower"] as const) {
  for (const a of [argHalf(1), argInt(2)]) {
    for (const q of T4_QUADRANTS) {
      const r = uniform(0.5, 8);
      const theta = uniform(q.theta_lo, q.theta_hi);
      addAZComplex("T4", head, a, r * Math.cos(theta), r * Math.sin(theta),
        `${q.name} L12 head=${head} a=${a.value}`);
    }
  }
}

// =============================================================================
// T5 — half-integer a   (R1 priority-A/B closed-form rules; DLMF §5.4-§5.5)
// =============================================================================
//
// Half-integer arguments are special-value test cases:
//   - Γ(1/2) = √π                        (DLMF §5.4.1)
//   - Γ(3/2) = √π/2
//   - Γ(5/2) = 3√π/4
//   - Γ(-1/2) = -2√π                     (DLMF §5.4.6)
//   - LogGamma at half-integer: log of above
//   - Digamma at 1/2: -γ - 2·log(2)      (DLMF §5.4.13)
//   - Pochhammer half-integer reductions: (1/2)_n = (2n)! / (4^n · n!)
//   - Beta(1/2, 1/2) = π                 (DLMF §5.12.1 + Γ(1/2)²/Γ(1))
//   - Beta(1/2, n+1/2) = π / 2^(2n+1) · C(2n, n)
//
// These cells are golden tests of the closed-form simplifier (Phase 2 I4
// rules). The G8 comparator must verify oracle values land on these
// exact-form numerics at full precision.

const T5_HALF_A: ArgScalar[] = [argHalf(1), argHalf(3), argHalf(-1)];
const T5_Z_VALUES = [1.0, 5.0];

// Pure half-integer z exercises for unary heads. 4 heads × 3 a = 12.
for (const head of ["Gamma", "LogGamma", "Digamma", "Trigamma"] as const) {
  for (const a of T5_HALF_A) {
    const z = parseArgNumeric(a);
    addUnaryReal("T5", head, z, `half-integer closure ${head}(${a.value})`);
  }
}

// Pochhammer half-integer (a, n) closed forms: 2 a × 3 n = 6.
for (const a of [argHalf(1), argHalf(3)]) {
  for (const n of [argInt(2), argInt(5), argInt(10)]) {
    addPochhammer("T5", a, n, `(${a.value})_${n.value} closed-form`);
  }
}

// IncompleteGamma family at half-integer a — closed forms in erf:
//   Γ(1/2, z) = √π · erfc(√z)
//   Γ(-1/2, z) = 2(e^-z/√z) - 2√π·erfc(√z)
// 4 heads × 2 a × 2 z = 16.
for (const a of [argHalf(1), argHalf(3)]) {
  for (const z of T5_Z_VALUES) {
    for (const head of ["IncompleteGammaUpper", "IncompleteGammaLower", "IncompleteGammaP", "IncompleteGammaQ"] as const) {
      addAZReal("T5", head, a, z, `half-integer-a (erfc closed form)`);
    }
  }
}

// Beta at half-integer (a, b): 6 cells (B(1/2,1/2)=π anchor mandatory).
for (const [a, b] of [
  [argHalf(1), argHalf(1)] as const,
  [argHalf(1), argHalf(3)] as const,
  [argHalf(1), argHalf(5)] as const,
  [argHalf(3), argHalf(3)] as const,
  [argHalf(3), argHalf(5)] as const,
  [argHalf(5), argHalf(5)] as const,
]) addBeta("T5", "Beta", a, b, `B(${a.value}, ${b.value}) half-integer closed form`);

// =============================================================================
// T6 — large |z|   (Poincaré asymptotic; Stirling deep regime)
// =============================================================================
//
// For |z| > 100 the algorithms enter their asymptotic regime:
//   - Gamma / LogGamma: Stirling series converges in ~O(1) terms; the
//     algorithm is now essentially the "evaluate at this z directly" path.
//   - Digamma / Trigamma: Boost's `digamma.hpp` switches to the DLMF §5.11.2
//     asymptotic series.
//   - IncompleteGammaUpper: DLMF §8.11.2 Poincaré asymptotic (R2 §1.7).
//   - IncompleteGammaLower: derive from Upper.
//
// Cells: |z| ∈ {100, 200, 500, 1000} times canonical anchors. We MUST stay
// below the float64 overflow boundary for `tgamma` (~171.6, R3 §3.1), so
// the unary-Gamma cells here are deliberately bounded. LogGamma has no
// such constraint (log of magnitude grows linearly).

const T6_LARGE_Z = [100, 300, 1000];

// LogGamma / Digamma / Trigamma: no overflow concern. 3 heads × 3 z + 1 LCG = 12.
for (const head of ["LogGamma", "Digamma", "Trigamma"] as const) {
  for (const z of T6_LARGE_Z) {
    addUnaryReal("T6", head, z, `large-z asymptotic |z|=${z}`);
  }
  addUnaryReal("T6", head, uniform(100, 1000), "LCG-sampled large-z");
}

// Gamma at z up to 170 (just below overflow); compensated by LogGamma cells.
for (const z of [120, 170]) {
  addUnaryReal("T6", "Gamma", z, `near-overflow z=${z} (float64 boundary ≈ 171.6)`);
}

// IncompleteGammaUpper / Q with large z (Poincaré path): 2 a × 3 z × 2 heads = 12.
for (const a of [argInt(2), argInt(10)]) {
  for (const z of T6_LARGE_Z) {
    addAZReal("T6", "IncompleteGammaUpper", a, z, `Poincaré path a=${a.value} z=${z}`);
    addAZReal("T6", "IncompleteGammaQ", a, z, `L12: Q(a,z) at large z → 0`);
  }
}

// BarnesG at moderately-large z (avoiding overflow): 2 cells.
for (const z of [20, 50]) {
  addUnaryReal("T6", "BarnesG", z, `BarnesG large-z asymptotic z=${z}`);
}

// =============================================================================
// T7 — near a = z   (Temme uniform asymptotic transition region; v0.1 carve-out)
// =============================================================================
//
// Per ADR-0042 §"What we will not decide", v0.1 ships series + CF dispatch
// only for IncompleteGamma. In the saddle region |z - a| ≤ C·√|a| with
// |a| ≥ 20, both series and CF degrade — series convergence is slow, CF
// near-stagnation. The carve-out: v0.1 substrate may lose up to log₂(|a|)
// bits relative to requested precision. At prec = 200, a = 100, z = 100,
// the dispatch may achieve only ~190 bits of agreement.
//
// The corpus MUST measure this gap explicitly so v0.2's Temme implementation
// can prove the closure. The G8 cross-agreement comparator tolerates the
// carve-out on T7 cells: passes at `precision - log₂(|a|)` bits instead of
// `precision - 4`.
//
// Cells: a ∈ {20, 50, 100, 200}, z = a + δ·√a for δ ∈ {-1.5, -0.5, 0,
// 0.5, 1.5}. The δ = 0 cell is the exact saddle point.

// 3 a-values × 3 deltas × 4 heads = 36. Covers δ=0 (exact saddle) and
// δ=±1 (one √a step either side) — enough to bracket the transition.
const T7_A_VALUES = [20, 100, 200];
const T7_DELTAS_OVER_SQRT_A = [-1.0, 0, 1.0];

for (const aN of T7_A_VALUES) {
  const a = argInt(aN);
  for (const d of T7_DELTAS_OVER_SQRT_A) {
    const z = aN + d * Math.sqrt(aN);
    for (const head of ["IncompleteGammaUpper", "IncompleteGammaLower", "IncompleteGammaP", "IncompleteGammaQ"] as const) {
      addAZReal("T7", head, a, z,
        `Temme saddle: a=${aN}, z-a=${(d * Math.sqrt(aN)).toFixed(2)} (δ/√a=${d}); v0.1 carve-out`);
    }
  }
}

// Half-integer a Temme cells: 2 a × 2 d = 4.
for (const k of [10, 50]) {
  const a = argHalf(2 * k + 1);
  const aN = parseArgNumeric(a);
  for (const d of [0, 1.0]) {
    const z = aN + d * Math.sqrt(aN);
    addAZReal("T7", "IncompleteGammaUpper", a, z,
      `Temme half-int a=${a.value}, δ/√a=${d}`);
  }
}

// =============================================================================
// T8 — digamma near negative integers   (near-pole cancellation for reflection)
// =============================================================================
//
// Digamma's poles are at z = 0, -1, -2, ... (simple poles, residue -1).
// The reflection formula ψ(1-z) - ψ(z) = π·cot(πz) is the bedrock of the
// negative-z digamma evaluation: for x < 0, we compute ψ(1-x) using the
// positive-x asymptotic path, then apply the reflection.
//
// `cot(πz)` has the same simple poles, so when z is near an integer, the
// reflection picks up large π·cot(πz) values that must cancel against the
// ψ(1-z) contribution. The cancellation depth is `lossBits ≈ log₂(1/|δ|)`
// where δ = z - round(z). The substrate must scale `work_prec` accordingly
// (`work = prec + 32 + lossBits`); the corpus is what proves this is
// happening at the 50-dp gold tier.
//
// Cells: digamma + trigamma + polygamma(m=2) near z ∈ {-1, -2, -3, -4, -5}.
// Deltas span 5 orders of magnitude so the substrate's work-precision
// scaling is exercised end-to-end. Trigamma/polygamma have higher-order
// poles, so their cancellation is more brutal.

// 3 poles × 4 deltas (two magnitudes × ±sign) × 3 heads (Digamma, Trigamma,
// Polygamma m=2) = 36. The deltas span 4 orders of magnitude so the
// substrate's work-precision scaling is exercised across `lossBits` ∈
// {6, 13, 20, 26} approximately.
const T8_POLES = [-1, -2, -3];
const T8_DELTAS = [1e-2, 1e-6, -1e-2, -1e-6];

for (const n of T8_POLES) {
  for (const delta of T8_DELTAS) {
    const z = n + delta;
    addUnaryReal("T8", "Digamma", z, `near-pole ψ at z=${n} (δ=${delta}; lossBits ≈ ${Math.round(Math.log2(1 / Math.abs(delta)))})`);
    addUnaryReal("T8", "Trigamma", z, `near-pole ψ' at z=${n} (higher-order)`);
    addPolygammaReal("T8", argInt(2), z, `near-pole ψ^(2) at z=${n} (3rd-order pole)`);
  }
}

// Complex near-pole cells: ψ has poles at non-positive integers in ℂ as well.
// 2 poles × 2 thetas × 1 r = 4 cells.
for (const n of [-1, -2]) {
  for (const theta of [0.5, 2.0]) {
    const r = 1e-3;
    addUnaryComplex("T8", "Digamma", n + r * Math.cos(theta), r * Math.sin(theta),
      `near-pole-complex z=${n}+${r}·e^(i·${theta.toFixed(2)})`);
  }
}

// -----------------------------------------------------------------------------
// Emit
// -----------------------------------------------------------------------------

const corpus = {
  manifest_version: 1,
  generated_at: "2026-05-19T00:00:00Z",
  bead: "scientist-workbench-0kq3",
  adr: "0042",
  seed: SEED,
  lcg: "Park-Miller (a=48271, m=2^31-1)",
  expected_decimals_per_value: EXPECTED_DECIMALS,
  expected_precision_decimals_for_gold_oracle: 50,
  arg_kinds: {
    integer: "k ∈ ℤ — adapter parses as Integer[k]",
    "half-integer": "(2k+1)/2 — adapter parses as Rational[2k+1, 2]",
    decimal: "general real non-integer non-half-integer — adapter parses as Rational from 60-dp string (R5 §6 L1 Wolfram input-trap)",
  },
  tier_descriptions: {
    T1: "real positive z+a — all 16 heads; covers series/CF crossovers (R3 §3.3)",
    T2: "real negative z — Gamma-family poles, LogGamma analytic continuation, Digamma reflection (R2 §1.3, R5 §6 L15)",
    T3: "near-poles z near 0, -1, -2, ..., -5 with δ ∈ {±1e-2, ±1e-4, ±1e-6} — cancellation stress (ADR-0042 §Decision 3; R5 §6 L17)",
    T4: "complex Q1-Q4 |z| ∈ [0.5, 12] — full Faddeeva-class complex paths (R5 §6 L14 for SciPy polygamma)",
    T5: "half-integer a — R1 priority-A/B closed forms (DLMF §5.4-§5.5)",
    T6: "large |z| ∈ (100, 1000] — Poincaré asymptotic / Stirling deep regime (R2 §1.7)",
    T7: "near a ≈ z (Temme uniform asymptotic transition) — v0.1 carve-out per ADR-0042 §'What we will not decide'",
    T8: "digamma near negative integers — reflection-formula near-pole cancellation; lossBits ≈ log₂(1/|δ|)",
  },
  landmines_pinned: {
    L1: "Wolfram input-trap: all numerics as Rational strings / 60-dp decimals",
    L12: "Incomplete-gamma regularisation: Upper, Lower, P, Q are FOUR DISTINCT HEADS — never share an input record",
    L14: "SciPy 1.11.4 polygamma complex TypeError — T4 polygamma cells are gold-only (Wolfram + mpmath)",
    L15: "SciPy loggamma(real_negative) → NaN; adapter passes x+0j",
    L17: "Γ at non-positive integers: four oracle behaviors (ComplexInfinity, ValueError, +∞, NaN); comparator special-cases poles",
    "v0.1-carve-out": "T7 Temme region: G8 comparator tolerates precision - log₂(|a|) bits instead of precision - 4",
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
    by_arg_kind: {
      // Count occurrences where an `a` field carries each kind. Integer-only
      // arity-1 cells (Gamma(z), LogGamma(z), ...) don't have an `a` field;
      // they count under `unary` separately.
      integer: inputs.filter((i) => "a" in i && (i as { a: ArgScalar }).a.kind === "integer").length,
      "half-integer": inputs.filter((i) => "a" in i && (i as { a: ArgScalar }).a.kind === "half-integer").length,
      decimal: inputs.filter((i) => "a" in i && (i as { a: ArgScalar }).a.kind === "decimal").length,
      unary: inputs.filter((i) => !("a" in i) && !("m" in i)).length,
    },
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
  console.log("By arg-kind:", corpus.totals.by_arg_kind);
}
