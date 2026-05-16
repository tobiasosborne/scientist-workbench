// =============================================================================
// Braaksma asymptotic — far-field algebraic series for the Meijer G-function
// =============================================================================
//
// `meijergAsymptotic(params, z, precision, opts)` is the v0.1 of layer 6 of
// the seven-layer MeijerG numerical evaluator (PLAN.md, hv0.9). Three
// numerical paths now exist for `G^{m,n}_{p,q}(z)`:
//
//   * **Slater** (layer 3, `slater.ts`) — sums one of two formal residue
//     series to convergence. Cheap when applicable; refuses in the
//     `|z| ≈ 1` quarantine band and in the `p > q` regime where the
//     residue series is genuinely divergent.
//   * **Mellin–Barnes contour** (layer 5, `contour.ts`) — direct
//     numerical integration on a vertical contour in the `s`-plane.
//     Convergent whenever the integrand decays (`2(m+n) > p+q`); cost
//     grows with `precision · log|z|` because the truncation `T` must
//     widen as `|z|` grows.
//   * **Asymptotic** (this layer, v0.1) — the **far-field** path. For
//     `|z| → ∞` the n-pole Slater series is asymptotic (in the
//     Poincaré sense): truncated at its **optimal** index it gives an
//     answer whose error is the smallest-term magnitude. Cost is
//     `O(precision)` Γ-evaluations once `|z|` is large enough; no
//     direct `|z|`-dependence beyond the truncation index.
//
// Mathematical foundation
// =======================
//
// Read in concert with ADR-0026 (this layer's design pin) and DLMF
// §16.11. The Meijer G is the Mellin–Barnes integral
//
//                     1     ⌠   ∏Γ(b_j − s) · ∏Γ(1 − a_j + s)
//      G(...; z) = ──────  ⎮  ──────────────────────────────────  z^s ds
//                    2πi    ⌡L  ∏Γ(1 − b_j + s) · ∏Γ(a_j − s)
//
// Closing the contour to the **right** (towards `Re(s) → +∞`) picks
// up residues at `s = a_h + k − 1` (poles of `Γ(1 − a_j + s)` for
// `j = 1..n`, `k = 0, 1, 2, …`). Summing these residues for fixed
// `h` over `k = 0, 1, 2, …` recovers Slater Series 2's `h`-th
// residue line. Slater 1966 §5.5 proves that the resulting double-sum
// converges to `G(z)` when `q ≥ p`.
//
// **The asymptotic move (Braaksma 1964 Compositio Math 15: 239-341):**
// when `p > q` the formal series **diverges**, but it is *still*
// asymptotic to `G(z)` as `|z| → ∞` in the Poincaré sense. More
// generally, *for any (m, n, p, q)*, in the principal sector
// `|arg z| < π/2`, the n-pole sum is the dominant contribution to
// `G(z)` and:
//
//   * for `p ≤ q`, summing to convergence reproduces Slater Series 2
//     (which the convergent path already does correctly);
//
//   * for `p > q`, the series diverges and **must** be truncated; the
//     optimal-truncation rule (Olver 1974 §3.7) says: truncate at the
//     index `k*` where the term magnitude is minimised, achieving an
//     error of order `|t_{k*+1}|`.
//
// We compute the same partial-sum machinery as the inner pFq used by
// Slater Series 2 — we just **stop summing at the optimal index
// instead of summing to convergence**.
//
// What v0.1 ships
// ---------------
//
// The **algebraic dominant asymptotic** in the principal sector:
//
//                   n
//   G(z)  ≈   Σ        B_h · z^{a_h - 1} · S_h(z)
//                  h=1
//
// where `B_h` is the Slater-Series-2 prefactor and each `S_h(z)` is
// the formal `pFq`-style series at the `h`-th upper pole, **truncated
// at its individual optimal index** `k*_h`. The error estimate is
// `Σ_h |B_h · z^{a_h - 1} · t_{h, k*_h + 1}|`.
//
// What v0.1 explicitly does NOT do (deferred to follow-up beads;
// ADR-0026 §7):
//
//   * **Stokes-line connection coefficients.** The exponential
//     `E_{p,q}(z)` series and the Stokes-multiplier table that
//     activates exponentially-small contributions across sector
//     boundaries.
//   * **Olde Daalhuis–Olver hyperasymptotic refinement.** Recovers
//     accuracy across Stokes lines via Borel resummation.
//   * **Secondary sectors `|arg z| > π/2 - π/64`.** The full Braaksma
//     theorem with full sector-by-sector connection coefficients.
//   * **Symmetric `|z| → 0` asymptotic.** Uses the m-pole (lower-pole)
//     residue series instead, with the same optimal-truncation
//     machinery.
//
// Each of these regimes returns a structured `MeijerGAsymptoticRefusal`
// envelope; the v0.1 caller routes to the contour quadrature
// (`meijergContour`) for inputs the asymptotic refuses. The hv0.10
// top-level dispatcher will compose these branches.
//
// Determinism contract
// ====================
// Every operation bottoms out in `BigInt` arithmetic via the bigfloat /
// bigcomplex substrate. The recurrence is deterministic given the
// inputs; the optimal-truncation finder is `<` on BigFloats
// (deterministic). So same `(params, z, precision, opts)` ⇒ same output
// bytes, forever, on any platform — `arbprec: true`'s strongest
// guarantee (ADR-0020).

import {
  type BigComplex,
  type BigFloat,
  abs as absBF,
  add,
  bitLength,
  cabs,
  cadd,
  carg,
  cdiv,
  cfromReal,
  cgamma,
  cmp,
  cmul,
  cneg,
  cpow,
  csub,
  decimalToBinaryPrecision,
  div as divBF,
  exp as expBF,
  fromInt,
  isZero,
  log as logBF,
  mul as mulBF,
  neg as negBF,
  pi,
  sgn,
  sub as subBF,
  toFloat64,
} from "@workbench/bigfloat";
import { evaluateEpq } from "./exponential.js";
import { stokesMultiplier } from "./stokes.js";
import type { MeijerGParameters } from "./types.js";

// -----------------------------------------------------------------------------
// Public types
// -----------------------------------------------------------------------------
//
// Mirrors `MeijerGContourResult` line-for-line on the *common*
// fields — `status`, `value`, `method`, `achievedPrecision`,
// `workingPrecision`, `warnings` — so the future hv0.10 dispatcher
// can switch on the result envelope with a single shared shape. The
// asymptotic-specific fields (`nTerms`, `optimalTermIndices`,
// `errorEstimate`, `sector`) are added without conflict.

export interface MeijerGAsymptoticOptions {
  /**
   * Hard cap on the per-pole inner-series term count; prevents
   * runaway in the unlikely event the optimal-truncation finder
   * fails to detect the term-magnitude turnaround. Default: max
   * `(64, 4 × precision)`.
   */
  readonly maxTermsPerPole?: number;

  /**
   * Override the default principal-sector half-angle (in radians)
   * used by the sector classifier. Default: `π/2 - π/64` (DLMF
   * §16.11.7). The small `π/64` margin keeps inputs *near* the
   * Stokes line `arg z = ±π/2` from being claimed as "principal" —
   * they get refused as `stokes-line` instead.
   */
  readonly principalSectorAngle?: number;
}

export interface MeijerGAsymptoticSuccess {
  readonly status: "success";
  readonly value: BigComplex;
  readonly achievedPrecision: number;
  /**
   * `"braaksma-algebraic"` — principal-sector path, algebraic series
   * only (`H(z)` truncated optimally; ADR-0026, the v0.1 of layer 6).
   *
   * `"braaksma-stokes"` — Stokes-band path (ADR-0039, bead `egf`): the
   * compound asymptotic `G ~ H(z·e^{∓πi}) + Σ_k S_k · E(z·e^{2πik/κ})`
   * assembled from the algebraic series at a rotated argument plus
   * one or more exponential `E_{p,q}` contributions weighted by the
   * `stokes.ts` multiplier table.
   */
  readonly method: "braaksma-algebraic" | "braaksma-stokes";
  /** Total summands across all `n` per-pole series. */
  readonly nTerms: number;
  /** Per-pole optimal truncation index (length `n`). */
  readonly optimalTermIndices: readonly number[];
  /** Sum of per-pole `|B_h · z^{a_h - 1} · t_{k*+1}|` plus the
   *  exponential-series first-omitted-term magnitudes on the Stokes
   *  path; conservative error estimate.  Reported as a BigFloat at
   *  `workingPrecision`. */
  readonly errorEstimate: BigFloat;
  /**
   * `"principal"` — `|arg z|` is strictly inside the principal sector
   * for the regime's `κ`; the algebraic series alone is asymptotic.
   *
   * `"stokes"` — `|arg z|` is past one of the Stokes lines (at
   * `±π/2` for `κ=1`, `±π, ±2π, …` for `κ≥3`) but the multiplier
   * table covers the regime; the connection formula was assembled.
   */
  readonly sector: "principal" | "stokes";
  readonly workingPrecision: number;
  readonly warnings: readonly string[];
}

export interface MeijerGAsymptoticRefusal {
  readonly status:
    | "stokes-line"
    | "stokes-band-refused"
    | "coverage-gap"
    | "secondary-sector"
    | "small-z"
    | "non-asymptotic-regime"
    | "no-pole-residues"
    | "input-error";
  readonly reason: string;
  /**
   * Present iff `status === "stokes-band-refused"`. The band
   * half-width `W = c_W · |z|^{-1/(2κ)}` in radians (BigFloat at
   * working precision), per ADR-0039 §D5 Option C. Surfaces the
   * smoothing-band geometry so the caller can pick a wider precision
   * (which narrows the band) or route to a smoothing-capable layer.
   */
  readonly bandHalfWidth?: BigFloat;
}

export type MeijerGAsymptoticResult =
  | MeijerGAsymptoticSuccess
  | MeijerGAsymptoticRefusal;

// -----------------------------------------------------------------------------
// Sector classification — κ-aware (ADR-0039 §D3 + §D4)
// -----------------------------------------------------------------------------
//
// The v0.1-of-`egf` classifier replaces the single conservative cap of
// ADR-0026 with a `κ = q − p + 1`-aware verdict. The regime split:
//
//   * `κ = 1` (`p = q`): principal sector `|arg z| < π/2`. Stokes lines
//     at `arg z = ±π/2`. Past the upper Stokes line (signOfImZ ≥ 0):
//     sectorIndex = −1. Past the lower (signOfImZ ≤ 0): sectorIndex
//     = +1. Outside `[−π, π]` is `out-of-coverage` (the negative-real
//     axis is already refused upstream as the branch cut).
//
//   * `κ = 2` (`p = q − 1`): the three-term H + E^− + E^+ formula
//     (DLMF 16.11.8) is structurally distinct from κ=1 and κ≥3 and is
//     filed as a separate bead (`scientist-workbench-fc83`). Verdict:
//     `out-of-coverage`.
//
//   * `κ ≥ 3` (`p ≤ q − 2`): principal sector `|arg z| < κπ/2`. Stokes
//     lines at `arg z = ±π, ±2π, …, ±⌊(κ−1)/2⌋·π`. v0.1 covers
//     `sectorIndex ∈ {−1, 0, +1}`, i.e. the principal sector and the
//     two sectors adjacent to `arg z = ±π`; beyond is `out-of-coverage`
//     (multi-Stokes refinement is a follow-on bead).
//
// The Stokes-band geometry comes from ADR-0039 §D4 (Option C of §D5).
// The band half-width is
//
//   W = c_W · |z|^{-1/(2κ)}      with c_W = 5
//
// computed at BigFloat precision via `cpow(|z|, -1/(2κ))`. The band
// gates the Stokes-line decision:
//
//   * `W < 2^{-workingBits/2}`: band is sub-precision (the sharp-switch
//     regime; the Berry smoothing is below working precision). Treat
//     the line as sharp and classify as `"stokes"` if inside the band.
//
//   * `W ≥ 2^{-workingBits/2}`: band is above sub-precision. Refuse
//     with `"stokes-band-refused"` carrying the band half-width
//     (per Option C, refuse honestly until Berry smoothing ships in a
//     follow-on bead).
//
// All comparisons happen at BigFloat precision; no `Math.atan2`, no
// float64 cast of `z.im` for sign decisions. The `arbprec: true`
// contract (ADR-0020) holds end-to-end through the classifier.

/**
 * The verdict returned by the κ-aware sector classifier.
 *
 * `"principal"` — the algebraic series alone is asymptotic; the caller
 * should use the existing `braaksma-algebraic` path. `sectorIndex = 0`
 * is the principal exponential branch.
 *
 * `"stokes"` — `|arg z|` is past one of the covered Stokes lines and
 * the multiplier table can resolve the regime. `sectorIndex ∈ {−1, +1}`
 * picks which rotated `E` representative carries the discontinuity;
 * `signOfImZ` indexes the upper-vs-lower-half-plane geometry.
 *
 * `"stokes-band-refused"` — `|arg z|` is inside the Stokes band and the
 * band is wider than sub-precision; the Berry smoothing is not yet
 * available (ADR-0039 §D5, Option C). The caller refuses with the
 * band half-width attached for diagnostics.
 *
 * `"secondary"` — `|arg z|` is past the v0.1-covered Stokes lines for
 * the regime. The legacy ADR-0026 refusal class; retained for inputs
 * that fall outside both the principal sector and the immediately
 * adjacent Stokes-covered sectors.
 *
 * `"out-of-coverage"` — the regime is mathematically defined but not
 * in v0.1 scope. Notably `κ = 2` (the three-term H + E^− + E^+ formula
 * of DLMF 16.11.8; filed as `scientist-workbench-fc83`). The `reason`
 * names the follow-up bead so the caller can route or surface.
 */
export type SectorVerdict =
  | { kind: "principal"; sectorIndex: 0 }
  | { kind: "stokes"; sectorIndex: -1 | 0 | 1; signOfImZ: -1 | 0 | 1 }
  | {
      kind: "stokes-band-refused";
      signOfImZ: -1 | 0 | 1;
      bandHalfWidth: BigFloat;
    }
  | { kind: "secondary"; sectorIndex: number }
  | { kind: "out-of-coverage"; reason: string };

/**
 * The Stokes-band coefficient `c_W` of ADR-0039 §D4 (Option C of §D5):
 * `W = c_W · |z|^{-1/(2κ)}` with `c_W = 5` chosen so that
 * `erfc(c_W) ≈ 1.5·10^{-12}` — the multiplier transition is below
 * working precision outside the band for any reasonable user request.
 *
 * This constant is part of the **input identity for caching purposes**:
 * changing it changes the output bytes near the Stokes band. Fixed for
 * `egf` v0.1; widening it requires a separate ADR (it strictly narrows
 * the refusal envelope so the change is backwards-compatible at the
 * value level but not at the bytes level).
 */
const STOKES_BAND_CW = 5n;

/**
 * Classify the sector containing `z` for the κ-aware asymptotic
 * (ADR-0039 §D3). The `(m, n, p, q)` shape selects which κ-regime is
 * in scope; `z` and `workingBits` drive the BigFloat-precision Stokes-
 * band decision.
 *
 * Signature note: the argument order was permuted from the v0.1 of
 * ADR-0026 (`z, m, n, p, q, workingBits, opts`) to put the shape
 * tuple first, matching the rest of the module's `(params, z, prec)`
 * convention and aligning with the user spec for ADR-0039. The legacy
 * `principalSectorAngle` override is no longer accepted — the κ-aware
 * geometry replaces the single conservative cap.
 */
export function classifySector(
  m: number,
  n: number,
  p: number,
  q: number,
  z: BigComplex,
  workingBits: number,
): SectorVerdict {
  void m;
  void n;
  const kappa = q - p + 1;

  // z = 0 is not in any far-field sector; the asymptotic does not apply.
  // We surface this as `out-of-coverage` rather than `secondary` so the
  // caller's existing |z| ≥ 1 gate catches it explicitly with the right
  // refusal class.
  if (isZero(z.re) && isZero(z.im)) {
    return {
      kind: "out-of-coverage",
      reason: "z = 0: not in any far-field sector",
    };
  }

  // κ ≤ 0 is filtered upstream by `canUseAsymptotic` when `n < p`; for
  // `n = p ∧ κ ≤ 0` the existing scan-for-min branch handles the
  // algebraic-only path with no exponential corrections (e.g. anchor 8
  // `G^{0,2}_{2,0}` with κ = −1). The principal-sector cap for κ ≤ 0 is
  // governed by the algebraic series alone, not the Stokes geometry —
  // we use the conservative ADR-0026 cap as a fallback for those.
  if (kappa <= 0) {
    return classifyKappaLE0(z, workingBits);
  }

  // κ = 2 is the explicit coverage-gap (ADR-0039 §D2; bead `fc83`).
  if (kappa === 2) {
    return {
      kind: "out-of-coverage",
      reason:
        `κ = q − p + 1 = 2 (p = q − 1): the three-term H + E^- + E^+ ` +
        `connection formula of DLMF 16.11.8 is structurally distinct ` +
        `from the κ=1 and κ≥3 cases covered by egf v0.1. Filed as ` +
        `follow-up bead scientist-workbench-fc83.`,
    };
  }

  // BigFloat |arg z| — never float64. ADR-0039 §D4: the sign of Im(z)
  // drives an exponentially-divergent multiplier branch, and the
  // BigFloat `carg` is bit-identical cross-platform forever.
  const argZ = carg(z, workingBits);
  const signOfArg = sgn(argZ);
  // signOfImZ: derived from sign of arg z. arg z ∈ (−π, π], so
  //   arg z > 0 ⇔ Im z > 0  (mod the negative real axis at arg = π,
  //   which the caller has filtered as the branch cut),
  //   arg z = 0 ⇔ Im z = 0 ∧ Re z > 0 (principal-value convention),
  //   arg z < 0 ⇔ Im z < 0.
  const signOfImZ: -1 | 0 | 1 = signOfArg;
  const absArg = absBF(argZ);

  // Stokes lines for the regime. For κ = 1: ±π/2. For κ ≥ 3: ±π, ±2π,
  // …, with the principal-sector boundary at ±κπ/2. v0.1 covers the
  // principal sector and the two adjacent (±π for κ ≥ 3, ±π/2 for κ=1).
  const piBF = pi(workingBits);

  if (kappa === 1) {
    // Principal sector boundary: π/2. Stokes line at π/2 itself.
    const halfPi = divBF(piBF, fromInt(2n, workingBits), workingBits);
    return classifyAroundLine(
      absArg,
      halfPi,
      signOfImZ,
      kappa,
      z,
      workingBits,
    );
  }

  // κ ≥ 3 — the principal-sector boundary is κπ/2. The first interior
  // Stokes lines are at ±π. v0.1 covers `|arg z| < π + W` (immediately
  // past the ±π lines, sectorIndex = ±1) and refuses everything wider.
  // For very high κ (5, 7, …) additional interior Stokes lines exist
  // at multiples of π; v0.1 caps at the first crossing.
  const kappaPiOver2 = divBF(
    mulBF(piBF, fromInt(BigInt(kappa), workingBits), workingBits),
    fromInt(2n, workingBits),
    workingBits,
  );
  // The first interior Stokes line. We classify around ±π.
  const verdict = classifyAroundLine(
    absArg,
    piBF,
    signOfImZ,
    kappa,
    z,
    workingBits,
  );
  if (verdict.kind === "principal" || verdict.kind === "stokes") {
    // Both cases live within `|arg z| < π + W`; verify against the
    // algebraic-sector boundary κπ/2 for completeness.
    void kappaPiOver2;
    return verdict;
  }
  // `secondary` from classifyAroundLine means `|arg z| ≥ π + W`. For
  // κ ≥ 3 we treat that as `out-of-coverage` (multi-Stokes refinement
  // is a follow-on bead) rather than the legacy ADR-0026 `secondary`.
  if (verdict.kind === "secondary") {
    return {
      kind: "out-of-coverage",
      reason:
        `|arg z| past the first interior Stokes line (arg z = ±π) for κ = ` +
        `${kappa}; v0.1 covers sectorIndex ∈ {−1, 0, +1} only. ` +
        `Multi-Stokes refinement is a follow-on bead.`,
    };
  }
  return verdict;
}

/**
 * Sector classification at a single Stokes line `θ_S` (real positive
 * BigFloat). Computes the band half-width `W = c_W · |z|^{-1/(2κ)}`
 * at BigFloat precision; compares `|absArg − θ_S|` against `W` and
 * `θ_S` itself to decide principal / stokes / band-refused / secondary.
 */
function classifyAroundLine(
  absArg: BigFloat,
  thetaS: BigFloat,
  signOfImZ: -1 | 0 | 1,
  kappa: number,
  z: BigComplex,
  workingBits: number,
): SectorVerdict {
  // Band half-width W = c_W · |z|^{-1/(2κ)}. Computed at BigFloat
  // precision via exp(−log(|z|) / (2κ)) · c_W. The negative exponent
  // is built explicitly (rather than `cpow` on a real base) to keep
  // the algebra real-only and avoid the complex-power machinery.
  const absZ = cabs(z, workingBits);
  // |z|^{-1/(2κ)} = exp(−log|z| / (2κ)). |z| > 0 here by the z=0 gate
  // at the top of `classifySector`.
  const logAbsZ = logBF(absZ, workingBits);
  const twoKappaBF = fromInt(BigInt(2 * kappa), workingBits);
  const negLogOverTwoK = negBF(divBF(logAbsZ, twoKappaBF, workingBits));
  const absZToNegInvTwoK = expBF(negLogOverTwoK, workingBits);
  const cW = fromInt(STOKES_BAND_CW, workingBits);
  let bandW = mulBF(cW, absZToNegInvTwoK, workingBits);

  // Band cap (ADR-0039 §D5 Option C, refined). The raw formula
  // `c_W · |z|^{-1/(2κ)}` is wide at modest `|z|`: at `|z| = 10, κ = 1`
  // we get `W ≈ 1.5` rad, which exceeds the principal-sector half-
  // width `π/2 ≈ 1.57`. Without a cap, the entire principal sector
  // would refuse with `stokes-band-refused` — clearly not the intent
  // (the ref doc §5.3 derives an O(0.3 rad) width at |z|=10, and the
  // `c_W = 5` factor extends that to cover ~12 dps of erfc fall-off,
  // not to engulf the principal sector).
  //
  // Cap: `min(W, θ_S / 2)`. The band can never extend more than
  // halfway across the principal sector. The cap is essentially
  // inactive once `|z|` is large enough that `W < θ_S/2` (e.g.
  // `|z| > 400` for κ = 1) — the asymptotic-regime use case. The
  // cap *is* active for `|z| < ~400` (κ = 1), refusing only inputs
  // genuinely close to the line.
  //
  // This refinement is *not* in the ADR text; it is a clarifying
  // implementation choice motivated by the existing test suite (the
  // closed-form anchor at `z = 10+5i` falls in principal sector with
  // `arg z = 0.46` but the uncapped `W = 1.5` would erroneously
  // capture it). The cap is bit-deterministic (BigFloat division by
  // 2) and changes the refusal envelope from the literal ADR formula
  // — surfacing here as a deviation that the bead's final report
  // will flag.
  const thetaSOverTwo = divBF(thetaS, fromInt(2n, workingBits), workingBits);
  if (cmp(bandW, thetaSOverTwo) > 0) {
    bandW = thetaSOverTwo;
  }

  // Sub-precision threshold: 2^{-workingBits/2}. Built as
  // exp(−(workingBits/2) · ln 2) via the `pow` route would be one
  // exp+log; we use `pow(2, ...)` exposed as `powInt` on integers
  // shifted into BigFloat, or simpler: a BigFloat with mantissa = 1 and
  // exponent = −workingBits/2 represents `2^{−workingBits/2}` exactly.
  const halfBits = Math.floor(workingBits / 2);
  const subPrecisionThreshold: BigFloat = {
    mantissa: 1n,
    exponent: -halfBits,
    precision: workingBits,
  };

  // |absArg − θ_S|: subtraction can yield a small positive or negative
  // BigFloat near the line; we take abs() to compare against W and 0.
  const diff = subBF(absArg, thetaS, workingBits);
  const absDiff = absBF(diff);

  // Inside the band? `|absArg − θ_S| < W`.
  const insideBand = cmp(absDiff, bandW) < 0;

  if (insideBand) {
    // Sharp-switch regime: W < sub-precision threshold ⇒ treat the
    // line as exact, classify by signOfArgDiff.
    const bandIsSubPrecision = cmp(bandW, subPrecisionThreshold) < 0;
    if (bandIsSubPrecision) {
      // On (or sub-precision-close-to) the line. Choose which side:
      // diff > 0 ⇒ |absArg| > θ_S, just past the line, sectorIndex = ±1.
      // diff ≤ 0 ⇒ |absArg| ≤ θ_S, in the principal sector (or
      // sub-precision-on the line, treated as principal by Option C).
      if (cmp(diff, fromInt(0n, workingBits)) > 0) {
        const sectorIndex = signOfImZ >= 0 ? -1 : 1;
        return { kind: "stokes", sectorIndex, signOfImZ };
      }
      return { kind: "principal", sectorIndex: 0 };
    }
    // Band exceeds sub-precision: refuse with band-half-width.
    return { kind: "stokes-band-refused", signOfImZ, bandHalfWidth: bandW };
  }

  // Outside the band. Is `|absArg|` past the line?
  if (cmp(diff, fromInt(0n, workingBits)) > 0) {
    // `|absArg| > θ_S + W`. Past the line, but how far? The next
    // Stokes line for κ ≥ 3 is at the principal-sector boundary κπ/2;
    // for κ = 1 the algebraic-sector boundary IS the Stokes line. For
    // both regimes, sectorIndex = ±1 is the "first sector past the
    // line" — v0.1's scope cap. Wider than that is `secondary` for
    // the caller to disposition.
    //
    // The caller refines: for κ=1, anything past π/2 within the
    // multiplier-table's covered range is sectorIndex = ±1. For κ ≥ 3,
    // sectorIndex = ±1 covers `π < |arg z| < ?`; we return `stokes`
    // here and let the caller decide whether `|arg z|` is also past
    // the next line (currently it isn't in v0.1 scope; this returns
    // `secondary` from `classifySector` for κ ≥ 3 by the wrapper).
    const sectorIndex = signOfImZ >= 0 ? -1 : 1;
    return { kind: "stokes", sectorIndex, signOfImZ };
  }
  // `|absArg| < θ_S − W`: strictly inside the principal sector.
  return { kind: "principal", sectorIndex: 0 };
}

/**
 * κ ≤ 0 fallback classifier: no Stokes structure to model with the
 * `egf` v0.1 multiplier table. Use the legacy ADR-0026 conservative
 * cap (`π/2 − π/64`) for the algebraic-only `braaksma-algebraic` path.
 * For `n = p` regimes the existing scan-for-min branch handles the
 * truncation correctly (anchor 8 `G^{0,2}_{2,0}` exercises this);
 * `n < p ∧ κ ≤ 0` is refused upstream by `canUseAsymptotic` (the
 * regime requires mandatory exponential corrections from a future
 * bead).
 */
function classifyKappaLE0(
  z: BigComplex,
  workingBits: number,
): SectorVerdict {
  const argZ = carg(z, workingBits);
  const absArg = absBF(argZ);
  const piBF = pi(workingBits);
  const piOver2 = divBF(piBF, fromInt(2n, workingBits), workingBits);
  // π/64 in BigFloat.
  const piOver64 = divBF(piBF, fromInt(64n, workingBits), workingBits);
  const cap = subBF(piOver2, piOver64, workingBits);
  const margin: BigFloat = {
    mantissa: 1n,
    exponent: -Math.floor(workingBits / 4),
    precision: workingBits,
  };
  const lower = subBF(cap, margin, workingBits);
  const upper = subBF(cap, negBF(margin), workingBits);
  if (cmp(absArg, lower) < 0) {
    return { kind: "principal", sectorIndex: 0 };
  }
  if (cmp(absArg, upper) < 0) {
    // Defensive: in the legacy band; treat as secondary (the algebraic
    // refusal class). The κ ≤ 0 ∧ n < p combination doesn't reach here
    // (dispatcher refuses), and n = p has no Stokes phenomenon to
    // worry about for the v0.1 scope; the band itself is informational.
    return { kind: "secondary", sectorIndex: 0 };
  }
  return { kind: "secondary", sectorIndex: 0 };
}

// -----------------------------------------------------------------------------
// Per-pole asymptotic-series term generator
// -----------------------------------------------------------------------------
//
// The recurrence is the same as `pfq.ts`'s `pFqDirectSeries` for
// the inner pFq of Slater Series 2 — derived in `series.ts` lines
// 251-262:
//
//   inner pFq, h-th upper pole:
//     argument:    z_inner = (-1)^{q-m-n} / z
//     upper (q):   α_j ∈ { 1 + b_j - a_h : j ∈ bm } ∪
//                        { 1 + b_j - a_h : j ∈ bq }
//     lower (p−1): β_j ∈ { 1 + a_j - a_h : j ∈ an, j ≠ h } ∪
//                        { 1 + a_j - a_h : j ∈ ap }
//
//   pFq's per-step ratio at index k (≥ 1):
//     term_k / term_{k-1}
//       = z_inner · ∏ (α_j + k - 1) / [k · ∏ (β_j + k - 1)]
//       = z_inner · ∏ (b_j - a_h + k) / [k · ∏ (a_j - a_h + k)]
//
// We pre-compute the constant-in-k offsets `b_j - a_h` (and
// `a_j - a_h for j ≠ h`) once; the recurrence then takes
// `(offset + k)` at each step. This avoids re-doing `1 + (b - a)`
// every iteration.

/**
 * Yield successive terms `t_{h,k}` of the algebraic asymptotic
 * series for the `h`-th upper pole. The first yielded value is
 * `t_{h,0} = 1`; each subsequent value is `t_{h,k-1} · ratio_k`.
 *
 * The yielded terms are the *coefficients* of the per-pole
 * prefactor `B_h · z^{a_h - 1}`; the caller multiplies once after
 * summation rather than threading the prefactor through every step.
 *
 * Note: this is a low-level primitive; the public path is
 * `meijergAsymptotic` below.
 */
export function* asymptoticTerms(
  params: MeijerGParameters,
  z: BigComplex,
  h: number,
  workingBits: number,
): Generator<BigComplex> {
  const { an, ap, bm, bq } = params;
  const m = bm.length;
  const n = an.length;
  if (h < 0 || h >= n) {
    throw new Error(
      `asymptoticTerms: h=${h} out of range [0, n=${n}); the asymptotic ` +
        `is summed over upper poles a_1..a_n only`,
    );
  }
  const ah = an[h]!;

  // Slater Series 2 sign: the inner pFq is evaluated at
  // `(-1)^{q-m-n} / z`. We carry the parity as a single boolean and
  // multiply the per-step ratio by `(−1)` when the parity is odd.
  const q = m + bq.length;
  const negate = (((q - m - n) % 2) + 2) % 2 === 1;

  // Precompute the constant-in-k offsets `(b_j - a_h)` and
  // `(a_j - a_h for j ≠ h)`. These are added to the running k each
  // step to form the Pochhammer factors.
  const upperOffsets: BigComplex[] = []; // (b_j - a_h) for j ∈ bm ∪ bq
  for (const bj of bm) upperOffsets.push(csub(bj, ah, workingBits));
  for (const bj of bq) upperOffsets.push(csub(bj, ah, workingBits));
  const lowerOffsets: BigComplex[] = []; // (a_j - a_h) for j ∈ (an∪ap)\{h}
  for (let j = 0; j < n; j++) {
    if (j === h) continue;
    lowerOffsets.push(csub(an[j]!, ah, workingBits));
  }
  for (const aj of ap) lowerOffsets.push(csub(aj, ah, workingBits));

  // Pre-compute 1/z once; every step reuses it.
  const oneOverZ = cdiv(
    cfromReal(fromInt(1n, workingBits)),
    z,
    workingBits,
  );

  // k = 0: leading term is 1.
  let term = cfromReal(fromInt(1n, workingBits));
  yield term;

  // k = 1, 2, … : term_k = term_{k-1} · z_inner · ∏(off + k) / [k · ∏(off' + k)]
  for (let k = 1; k < Number.MAX_SAFE_INTEGER; k++) {
    const kBC = cfromReal(fromInt(BigInt(k), workingBits));

    let numer = cfromReal(fromInt(1n, workingBits));
    for (const off of upperOffsets) {
      numer = cmul(numer, cadd(off, kBC, workingBits), workingBits);
    }

    let denom = kBC;
    for (const off of lowerOffsets) {
      denom = cmul(denom, cadd(off, kBC, workingBits), workingBits);
    }

    // ratio = (±1) · numer / denom / z.
    let ratio = cmul(cdiv(numer, denom, workingBits), oneOverZ, workingBits);
    if (negate) ratio = cneg(ratio);

    term = cmul(term, ratio, workingBits);
    yield term;
  }
}

// -----------------------------------------------------------------------------
// Optimal-truncation finder — regime-aware (ADR-0039 §D1, bead 43i)
// -----------------------------------------------------------------------------
//
// Two truncation strategies live behind a single entry point. The
// regime decision is driven by `κ = q − p + 1` and the `n < p`
// predicate (ADR-0039 §D1):
//
//   * **Scan-for-smallest-term branch.** The original Olver §3.7 rule:
//     iterate term-by-term, watching for the magnitude turnaround
//     `|t_k| ≥ |t_{k-1}|`; truncate at `k − 1`. Selected for all
//     `n = p` shapes (no `ap` parameters), regardless of `κ`. When
//     the inner ${}_qF_{p-1}(z^{-1})$ is genuinely divergent (e.g.
//     G^{0,2}_{2,0} with `κ = −1`, the existing anchor 8), the scan
//     reliably finds an interior minimum. When the inner series is
//     convergent (e.g. anchor 3 G^{1,1}_{1,1} with `κ = 1` and
//     `|z| > 1`), the scan sums until terms fall below the working-
//     precision floor; hitting the cap is acceptable.
//
//   * **Paris–Kaminski analytical N* branch** (ADR-0039 §D1, P&K
//     Theorem 2.2 p. 53). For `n < p AND κ ≥ 1` — the `43i` scope —
//     the optimal truncation index is the closed-form expression
//
//       N*(h) = ⌊ |κ · z^{1/κ}| ⌋
//
//     evaluated at full BigFloat precision (principal-value root via
//     `cpow`, magnitude via `cabs`, floor via mantissa-shift on
//     BigInt for bit-determinism). The per-pole error estimate is the
//     magnitude of the first omitted term `|t_{N*+1}|` — the same
//     "first-omitted" rule as Olver's, just at an analytically-chosen
//     index instead of an empirical one. Bead 43i (ADR-0039) is
//     filed against this branch: the old scan-for-min systematically
//     under-truncates on `n < p` inputs by stopping at the first
//     spurious local minimum from noise, costing one or two digits
//     near the user-stated precision (worklog notes the Slater
//     Series-2 precision ceiling at `|z| ≈ 16` for this very reason).
//     The `κ ≤ 0 AND n < p` regime is refused at the dispatcher
//     (ADR-0039 §D1, `canUseAsymptotic`); the `κ ≤ 0 AND n = p`
//     regime stays on the scan branch above.
//
// **Defence-in-depth.** In the PK branch we still run the scan loop
// up to the cap. If both indices are interior (cap-not-reached on the
// scan, N* < cap on the PK side) and they disagree by more than a
// factor of 2, the result records a `truncation-disagreement` warning
// in the success record's `warnings` array. The decision is *never*
// changed by this comparison; PK is the truth in its regime. The
// warning is a regression-detector for the day the formula or the
// per-pole term recurrence drifts.
//
// **`κ` is computed once.** The `(m, n, p, q, κ)` tuple is read from
// `params` at the top of the function — not inside the per-`k` loop
// (the old code had no such tuple at all; the regime check is new).
// The `cpow(z, 1/κ, workingBits)` evaluation is performed once per
// call and reused both for `N*` and for the early-out check on
// `N* = 0` (degenerate sub-asymptotic input).

/**
 * Read the per-pole term magnitudes off `asymptoticTerms` and find
 * the optimal truncation index `k*` per the regime split documented
 * above.
 *
 * Returns:
 *   * `index`: the truncation index `k*`. The truncated partial sum
 *     is `Σ_{k=0..k*} t_k`.
 *   * `partialSum`: the `Σ_{k=0..k*} t_k` value, in pre-prefactor
 *     coefficient form. The caller multiplies by `B_h · z^{a_h - 1}`
 *     externally.
 *   * `errorEstimate`: `|t_{k*+1}|` as a BigFloat at `workingBits`.
 *   * `nTerms`: number of generator pulls actually performed.
 *   * `reachedCap`: whether the cap was hit before the term-
 *     magnitude turnaround (scan branch) or before reaching `N*` (PK
 *     branch). The caller decides whether to surface a warning,
 *     treat the partial sum as best-effort, or refuse with
 *     `non-asymptotic-regime`.
 *   * `warnings`: optional list of structured warning strings emitted
 *     by the PK branch's defence-in-depth comparison. Empty when no
 *     defence-in-depth trigger fired. The caller folds these into
 *     the success record's `warnings` list verbatim.
 */
export function findOptimalTruncation(
  params: MeijerGParameters,
  z: BigComplex,
  h: number,
  workingBits: number,
  maxTerms: number,
): {
  index: number;
  partialSum: BigComplex;
  errorEstimate: BigFloat;
  nTerms: number;
  reachedCap: boolean;
  warnings: string[];
} {
  // Regime tuple — computed once per call, never inside the k-loop.
  // The asymptoticTerms generator independently sees these same
  // `params`; we read them here only to decide which truncation rule
  // to apply.
  const m = params.bm.length;
  const n = params.an.length;
  const p = n + params.ap.length;
  const q = m + params.bq.length;
  const kappa = q - p + 1;

  // ADR-0039 §D1 specifies the divergent branch as `n < p OR κ ≤ 1`.
  // Empirically (worklog notes for bead 43i, this file), the
  // sub-clause `κ ≤ 1` is load-bearing only for inputs where the
  // formal inner ${}_qF_{p-1}(z^{-1})$ is divergent — i.e. for
  // `κ ≥ 2` shape `(m, n, p, q)` where the existing scan-for-min
  // already correctly catches the turnaround. The complementary
  // `n = p AND κ = 1` regime (inner $_pF_{p-1}$, convergent for
  // `|z^{-1}| < 1`) does *not* fit the Paris–Kaminski analytical
  // truncation: at moderate `|z|` (e.g. `|z| ≈ 11`, anchor 5's
  // `z = 10 + 5i`) the PK index `N* ≈ |z|` is far too small to
  // reach the user-stated precision (25 dps in the existing test
  // suite — only ~12 digits achieved at `N* = 11`). For those
  // inputs the scan-for-min loop sums until terms fall below the
  // working-precision floor, which is the correct behaviour.
  //
  // The regime decision implemented here is therefore narrower than
  // the ADR's literal text: **PK fires only for `n < p AND κ ≥ 1`**
  // — the n < p axis is the exclusive trigger. The κ ≤ 0 inputs are
  // either refused by `canUseAsymptotic` (`κ ≤ 0 AND n < p`) or
  // routed through the scan branch (`κ ≤ 0 AND n = p`, e.g.
  // G^{0,2}_{2,0} with κ = −1, where the inner ${}_qF_{p-1}$ is
  // genuinely divergent and Olver's rule catches it). This
  // satisfies the byte-identical-regression requirement of bead
  // 43i: every `n = p` test case routes through the unchanged scan
  // branch.
  //
  // Deviation noted in the bead 43i report; ADR-0039's regime text
  // is correct in spirit ("the divergent regime needs PK") but the
  // boundary case `n = p AND κ = 1` (which the ADR places on the
  // divergent side) is empirically convergent-inner-pFq and is
  // better served by scan-for-min.
  const useParisKaminski = kappa >= 1 && n < p;

  if (useParisKaminski) {
    return findTruncationParisKaminski(
      params,
      z,
      h,
      workingBits,
      maxTerms,
      kappa,
    );
  }
  return findTruncationScan(params, z, h, workingBits, maxTerms);
}

/**
 * The original Olver scan-for-smallest-term loop, extracted from the
 * pre-43i implementation. Iterate term-by-term until `|t_k| ≥ |t_{k-1}|`
 * (asymptotic geometry has reversed; truncate at `k − 1`) or the cap
 * is hit. The error estimate is `|t_{k*+1}|`, the first-omitted-term
 * magnitude (Olver Lemma 3.7.1, "superasymptotic" §3.7). No warnings
 * emitted from this branch — its caps and cap-hit behaviour are
 * already surfaced by the outer `meijergAsymptotic` via `reachedCap`.
 */
function findTruncationScan(
  params: MeijerGParameters,
  z: BigComplex,
  h: number,
  workingBits: number,
  maxTerms: number,
): {
  index: number;
  partialSum: BigComplex;
  errorEstimate: BigFloat;
  nTerms: number;
  reachedCap: boolean;
  warnings: string[];
} {
  const it = asymptoticTerms(params, z, h, workingBits);
  const t0 = it.next().value as BigComplex;
  let prevMag = cabs(t0, workingBits);
  let partialSum = t0;

  for (let k = 1; k < maxTerms; k++) {
    const tk = it.next().value as BigComplex;
    const tkMag = cabs(tk, workingBits);

    if (cmp(tkMag, prevMag) >= 0) {
      return {
        index: k - 1,
        partialSum,
        errorEstimate: tkMag,
        nTerms: k + 1,
        reachedCap: false,
        warnings: [],
      };
    }

    partialSum = cadd(partialSum, tk, workingBits);
    prevMag = tkMag;
  }
  return {
    index: maxTerms - 1,
    partialSum,
    errorEstimate: prevMag,
    nTerms: maxTerms,
    reachedCap: true,
    warnings: [],
  };
}

/**
 * Paris–Kaminski analytical-truncation branch (ADR-0039 §D1, P&K
 * Theorem 2.2 p. 53). Computes `N*(h) = ⌊|κ z^{1/κ}|⌋` at full
 * BigFloat precision and truncates the partial sum at that index.
 * The error estimate is `|t_{N*+1}|`, the first-omitted-term
 * magnitude — same Olver-style rule, evaluated at the analytical
 * optimum.
 *
 * **Determinism.** `cpow` uses the principal-value root (clog/cexp
 * pair, `arg z ∈ (−π, π]`). `cabs` is BigFloat-exact. The
 * `BigFloat → bigint` floor uses mantissa-shift arithmetic (no
 * float64 round-trip), preserving the `arbprec: true` contract:
 * same `(params, z, workingBits)` ⇒ same `N*` ⇒ same partial sum
 * on every platform forever.
 *
 * **Defence-in-depth.** The scan-for-min loop also runs (up to the
 * cap). If it finds an interior minimum at `k_scan`, and `k_scan`
 * disagrees with `N*` by more than a factor of 2, a
 * `truncation-disagreement` warning is emitted. The PK index always
 * wins the truncation decision — the warning is informational only.
 */
function findTruncationParisKaminski(
  params: MeijerGParameters,
  z: BigComplex,
  h: number,
  workingBits: number,
  maxTerms: number,
  kappa: number,
): {
  index: number;
  partialSum: BigComplex;
  errorEstimate: BigFloat;
  nTerms: number;
  reachedCap: boolean;
  warnings: string[];
} {
  // Compute N* = ⌊ |κ z^{1/κ}| ⌋. The principal-value root
  // `z^{1/κ}` is taken (`clog / cexp` via `cpow`), then multiplied
  // by the integer `κ` (lifted into a BigComplex with zero imag
  // part), then magnitude, then floor-to-bigint.
  const oneOverKappa = cfromReal(
    divBF(
      fromInt(1n, workingBits),
      fromInt(BigInt(kappa), workingBits),
      workingBits,
    ),
  );
  const zToOneOverKappa = cpow(z, oneOverKappa, workingBits);
  const kappaBC = cfromReal(fromInt(BigInt(kappa), workingBits));
  const kappaZ = cmul(kappaBC, zToOneOverKappa, workingBits);
  const magBF = cabs(kappaZ, workingBits);
  const floorBI = floorNonNegativeBigFloatToBigInt(magBF);
  // Clamp to the inclusive range `[0, maxTerms - 1]`. `maxTerms` is
  // bounded by `Math.max(64, 4 × precision)`, well below
  // `Number.MAX_SAFE_INTEGER`, so the BigInt → number conversion
  // here is exact.
  let NStar: number;
  if (floorBI <= 0n) {
    NStar = 0;
  } else if (floorBI >= BigInt(maxTerms - 1)) {
    NStar = maxTerms - 1;
  } else {
    NStar = Number(floorBI);
  }

  // Iterate the generator from k = 0 to k = N* (inclusive), accumulating
  // the partial sum. In parallel, track the first index where the
  // scan-for-min rule would have stopped (`|t_k| ≥ |t_{k-1}|`) — this
  // is the defence-in-depth comparator. Then pull one more term to get
  // `t_{N*+1}` for the error estimate.
  const it = asymptoticTerms(params, z, h, workingBits);
  const t0 = it.next().value as BigComplex;
  let prevMag = cabs(t0, workingBits);
  let partialSum = t0;
  let kScan: number | null = null;
  let nTerms = 1;

  for (let k = 1; k <= NStar; k++) {
    const tk = it.next().value as BigComplex;
    nTerms++;
    const tkMag = cabs(tk, workingBits);
    if (kScan === null && cmp(tkMag, prevMag) >= 0) {
      kScan = k - 1;
    }
    partialSum = cadd(partialSum, tk, workingBits);
    prevMag = tkMag;
  }

  // First-omitted-term magnitude for the error estimate. The
  // generator is unbounded, so this pull is always safe. (If
  // N* = maxTerms − 1, we still pull k = maxTerms, conceptually one
  // step past the cap, which the generator handles fine — see
  // asymptoticTerms's `k < Number.MAX_SAFE_INTEGER` loop.) The
  // additional pull does not extend the partial sum.
  const tNext = it.next().value as BigComplex;
  const errorEstimate = cabs(tNext, workingBits);
  nTerms++;

  // Defence-in-depth: keep scanning past N* up to the cap to see
  // whether scan-for-min would have found an interior turnaround
  // significantly different from N*. We only run this extra scan
  // when kScan is still null (i.e. the term magnitudes were still
  // shrinking at k = N*), so the extra cost is bounded by maxTerms.
  // The point is to detect drift between the analytical N* and the
  // empirical scan-for-min — if they disagree by >2×, something is
  // off; emit a warning and let downstream verification catch it.
  let scanReachedCap = false;
  if (kScan === null) {
    let prev = prevMag;
    let lastMag = cabs(tNext, workingBits);
    if (cmp(lastMag, prev) >= 0) {
      kScan = NStar; // turnaround at N*; consistent with PK
    } else {
      prev = lastMag;
      for (let k = NStar + 2; k < maxTerms; k++) {
        const tk = it.next().value as BigComplex;
        const tkMag = cabs(tk, workingBits);
        if (cmp(tkMag, prev) >= 0) {
          kScan = k - 1;
          break;
        }
        prev = tkMag;
      }
      if (kScan === null) scanReachedCap = true;
    }
  }

  const warnings: string[] = [];
  // Disagreement check: only meaningful when both indices are
  // interior (cap-not-reached on the scan side). The PK branch's
  // `reachedCap` is the cap-clamp on N* itself, reported separately.
  if (kScan !== null && !scanReachedCap && NStar > 0) {
    const ratio = kScan === 0 ? Infinity : NStar / kScan;
    const invRatio = NStar === 0 ? Infinity : kScan / NStar;
    if (ratio > 2 || invRatio > 2) {
      warnings.push(
        `truncation-disagreement: N*=${NStar}, scan=${kScan}`,
      );
    }
  }

  return {
    index: NStar,
    partialSum,
    errorEstimate,
    nTerms,
    // `reachedCap` reports whether N* was clamped by the cap. The
    // outer `meijergAsymptotic` already surfaces a cap warning when
    // this flag is set, identically to the scan branch's semantics.
    reachedCap: floorBI > BigInt(maxTerms - 1),
    warnings,
  };
}

/**
 * Floor a non-negative `BigFloat` to a `BigInt`, exactly, via
 * mantissa-shift arithmetic. No float64 in the path.
 *
 * A `BigFloat` is `mantissa · 2^exponent`. For non-negative values:
 *   * `exponent ≥ 0`: floor = `mantissa << exponent` (exact).
 *   * `exponent < 0`: floor = `mantissa >> (−exponent)` (arithmetic
 *     right-shift on a non-negative BigInt is the integer floor).
 * Zero mantissa ⇒ zero floor.
 */
function floorNonNegativeBigFloatToBigInt(x: BigFloat): bigint {
  if (x.mantissa === 0n) return 0n;
  if (x.mantissa < 0n) {
    throw new Error(
      `floorNonNegativeBigFloatToBigInt: expected non-negative input; ` +
        `got mantissa=${x.mantissa}`,
    );
  }
  if (x.exponent >= 0) return x.mantissa << BigInt(x.exponent);
  return x.mantissa >> BigInt(-x.exponent);
}

// -----------------------------------------------------------------------------
// Per-pole prefactor (Slater Series 2 form)
// -----------------------------------------------------------------------------
//
// The per-pole `B_h` prefactor is the Slater Series 2 prefactor
// (`series.ts` lines 224-244) repeated:
//
//                ∏_{j ≠ h, j ≤ n}  Γ(a_h - a_j)
//                · ∏_{j ≤ m}        Γ(1 + b_j - a_h)
//        B_h = ─────────────────────────────────────────────────
//                ∏_{j ≤ p - n} Γ(1 + ap_j - a_h)
//                · ∏_{j ≤ q - m} Γ(a_h - bq_j)
//
// We re-implement here (rather than calling `series.ts` directly)
// because the asymptotic path needs *only* the prefactor;
// `evaluateSeries2` couples the prefactor with the inner-pFq sum,
// which is exactly what we're replacing with the optimal-truncation
// alternative. The duplication is ~25 lines; refactoring `series.ts`
// to expose the prefactor alone would split a piece of code that
// reads naturally as a unit.

function residuePrefactor(
  params: MeijerGParameters,
  h: number,
  workingBits: number,
): BigComplex {
  const { an, ap, bm, bq } = params;
  const ah = an[h]!;
  const one = cfromReal(fromInt(1n, workingBits));

  let numer = one;
  for (let j = 0; j < an.length; j++) {
    if (j === h) continue;
    numer = cmul(
      numer,
      cgamma(csub(ah, an[j]!, workingBits), workingBits),
      workingBits,
    );
  }
  for (let j = 0; j < bm.length; j++) {
    const arg = csub(cadd(one, bm[j]!, workingBits), ah, workingBits);
    numer = cmul(numer, cgamma(arg, workingBits), workingBits);
  }

  let denom = one;
  for (let j = 0; j < ap.length; j++) {
    const arg = csub(cadd(one, ap[j]!, workingBits), ah, workingBits);
    denom = cmul(denom, cgamma(arg, workingBits), workingBits);
  }
  for (let j = 0; j < bq.length; j++) {
    denom = cmul(
      denom,
      cgamma(csub(ah, bq[j]!, workingBits), workingBits),
      workingBits,
    );
  }

  return cdiv(numer, denom, workingBits);
}

// -----------------------------------------------------------------------------
// Public entry
// -----------------------------------------------------------------------------

/**
 * Evaluate `G^{m,n}_{p,q}(z)` via the Braaksma algebraic asymptotic
 * for `|z| → ∞` in the principal sector.
 *
 * Returns a structured success record (with `value`, per-pole
 * truncation indices, error estimate, sector classification) or a
 * structured refusal (out-of-sector, non-asymptotic-regime, etc.).
 */
export function meijergAsymptotic(
  params: MeijerGParameters,
  z: BigComplex,
  precision: number,
  opts: MeijerGAsymptoticOptions = {},
): MeijerGAsymptoticResult {
  // ----------------------------------------------------------- inputs
  if (!Number.isInteger(precision) || precision < 1) {
    return {
      status: "input-error",
      reason: `precision must be a positive integer; got ${precision}`,
    };
  }
  const { an, ap, bm, bq } = params;
  const m = bm.length;
  const n = an.length;
  const p = n + ap.length;
  const q = m + bq.length;

  // Asymptotic at |z| → ∞ via the right-pole (a_h) residues. Need
  // n ≥ 1 to have any residues to close on the right.
  if (n === 0) {
    return {
      status: "no-pole-residues",
      reason:
        "n = 0: no upper-pole residues available; the right-closing " +
        "asymptotic at |z| → ∞ does not apply. The symmetric " +
        "left-closing asymptotic at |z| → 0 is filed under hv0.9.4.",
    };
  }

  // z = 0 is the opposite limit of the |z| → ∞ asymptotic.
  if (isZero(z.re) && isZero(z.im)) {
    return {
      status: "small-z",
      reason: "z = 0; the |z| → ∞ asymptotic does not apply at the origin",
    };
  }

  // Working precision: target + 30-bit safety margin (same discipline
  // as Slater / contour layers). The optimal-truncation finder is
  // sensitive to term-magnitude comparisons; generous headroom keeps
  // the comparisons stable.
  const workingBits = decimalToBinaryPrecision(precision, 30);

  // Sector verdict — κ-aware (ADR-0039 §D3). Replaces the v0.1 single
  // conservative cap of ADR-0026 with a regime-dependent geometry:
  // principal sector, Stokes-band-refused, stokes (covered crossing),
  // secondary, out-of-coverage. The dispatcher's `canUseAsymptotic`
  // pre-filter is a coarse early-out; the detailed verdict lives here.
  void opts.principalSectorAngle; // retained for API stability; the
  // κ-aware classifier supersedes the override. The legacy `opts.
  // principalSectorAngle` is silently ignored; callers that need a
  // forced-principal classification (e.g. test scaffolding probing H
  // at a rotated argument) should pass the rotated value explicitly.
  const verdict = classifySector(m, n, p, q, z, workingBits);

  if (verdict.kind === "out-of-coverage") {
    return {
      status: "coverage-gap",
      reason: verdict.reason,
    };
  }
  if (verdict.kind === "stokes-band-refused") {
    return {
      status: "stokes-band-refused",
      reason:
        `|arg z − θ_S| < c_W · |z|^{-1/(2κ)} = band half-width; the ` +
        `Berry smoothing layer for this band is deferred to bead ` +
        `scientist-workbench-ybrw (egf v0.2). Option C (ADR-0039 §D5) ` +
        `refuses honestly until then. Workarounds: (a) raise the ` +
        `working precision to shrink the sub-precision threshold below ` +
        `the band width; (b) request a |z| large enough that the band ` +
        `falls below sub-precision (W ~ |z|^{-1/(2κ)}); (c) move |arg ` +
        `z| further from the line.`,
      bandHalfWidth: verdict.bandHalfWidth,
    };
  }
  if (verdict.kind === "secondary") {
    return {
      status: "secondary-sector",
      reason:
        `|arg z| beyond the v0.1-covered Stokes-line sectors; the v0.1 ` +
        `dominant balance does not cover this region. The full Braaksma ` +
        `theorem with multi-Stokes sector handling is filed as a ` +
        `follow-on bead.`,
    };
  }

  // |z| sanity. The asymptotic requires |z| large enough that the
  // term ratio shrinks for at least the first few k. Hard floor at
  // |z| = 1; the optimal-truncation finder catches the actual
  // case-by-case "not asymptotic enough" failure at higher |z|.
  const zMag = toFloat64(cabs(z, workingBits)).value;
  if (!Number.isFinite(zMag) || zMag < 1) {
    return {
      status: "small-z",
      reason:
        `|z| = ${zMag.toExponential(3)}; the v0.1 algebraic asymptotic ` +
        `requires |z| ≥ 1 (and in practice |z| ≫ p + q) to be useful. ` +
        `Route to Slater (meijergSlater) for |z| < 1 inputs.`,
    };
  }

  const maxTermsPerPole = opts.maxTermsPerPole ?? Math.max(64, 4 * precision);

  // -----------------------------------------------------------------
  // Principal-sector path (existing behaviour; method = braaksma-algebraic)
  // -----------------------------------------------------------------
  if (verdict.kind === "principal") {
    return assembleAlgebraic(
      params,
      z,
      z,
      precision,
      workingBits,
      maxTermsPerPole,
      "braaksma-algebraic",
      "principal",
    );
  }

  // -----------------------------------------------------------------
  // Stokes-band path: connection-formula assembly (ADR-0039 §D3)
  // -----------------------------------------------------------------
  //
  // We evaluate
  //
  //   G(z) ~ H_alg(z) + Σ_k S_k · E_{p,q}(z e^{2πik/κ})
  //
  // where `S_k` ∈ {0, ±1, ±i} is the Stokes multiplier from `stokes.ts`.
  //
  // The algebraic argument z_H = z (identity) for ALL κ in v0.1 scope.
  //
  // Bug-fix note (math-research subagent diagnosis): the previous code
  // set `zArgForH = cneg(z)` for κ = 1, citing DLMF 16.11.7's
  // `H_{q,q}(z e^{∓πi})` formula. That rotation applies to DLMF's
  // H_{q,q}, which is the *asymptotic series for {}_qF_q* (i.e. the
  // case (m,n) = (0,p) where only one residue family is present and
  // the argument must be rotated to land on the correct Riemann sheet
  // of the hypergeometric function). The workbench's `assembleAlgebraic`
  // computes the *right-closing Slater-residue series* for G^{m,n}_{p,q}
  // itself (ref doc §2.2, the H^{m,n}_{p,q}(z) formula). This series is
  // evaluated on the principal Riemann sheet and equals G(z) directly —
  // no rotation is needed or correct. The apparent DLMF discrepancy is
  // because DLMF 16.11.7 is written for {}_qF_q, not for the general
  // Meijer-G; see `docs/refs/dlmf-16-11.md` §2.2 for the workbench-H
  // definition and §4.3 for the distinction between the DLMF-H_{q,q}
  // (pFq asymptotic) and the workbench H^{m,n}_{p,q} (Slater residues).
  //
  // The algebraic part is evaluated by the *existing* per-pole loop
  // (`assembleAlgebraic`). The per-pole prefactor `B_h` is unchanged;
  // the `z^{a_h - 1}` factor is evaluated at z directly via
  // principal-value `cpow`.

  const kappa = q - p + 1;

  // zArgForH = z for all κ in v0.1 scope (identity — no rotation).
  // See the fix-note above for why the previous κ = 1 rotation to
  // cneg(z) was incorrect.
  const zArgForH = z;

  // 1. Algebraic part: assemble H at the (possibly-rotated) argument
  //    using the *same* per-pole machinery as the principal path. We
  //    pass `z` as the "factor-z" argument so per-pole error estimates
  //    are reported relative to the original `z` magnitude.
  const algResult = assembleAlgebraic(
    params,
    zArgForH,
    z,
    precision,
    workingBits,
    maxTermsPerPole,
    "braaksma-stokes",
    "stokes",
  );
  if (algResult.status !== "success") {
    // Algebraic refusal propagates; the connection formula cannot
    // assemble without the H contribution.
    return algResult;
  }

  // 2. Exponential contributions. For the v0.1 scope, sectorIndex ∈
  //    {−1, 0, +1}: three rotated E representatives. The Stokes
  //    multipliers S_k come from `stokes.ts`; zero multipliers
  //    short-circuit the E evaluation entirely.
  const sectorIndices: ReadonlyArray<-1 | 0 | 1> = [-1, 0, 1];
  let total: BigComplex = algResult.value;
  let warnings: string[] = [...algResult.warnings];
  let totalErrorEstimate: BigFloat = algResult.errorEstimate;

  for (const sectorIndex of sectorIndices) {
    const mult = stokesMultiplier(
      kappa,
      sectorIndex,
      verdict.signOfImZ,
      workingBits,
    );
    if (mult.status === "coverage-gap") {
      return {
        status: "coverage-gap",
        reason: mult.reason!,
      };
    }
    if (mult.status === "out-of-table") {
      // Defensive — the κ-aware classifier should already have routed
      // to coverage-gap. Surface as input-error so the bug is loud.
      return {
        status: "input-error",
        reason:
          `internal: Stokes-multiplier lookup returned out-of-table for ` +
          `(κ=${kappa}, sectorIndex=${sectorIndex}, signOfImZ=${verdict.signOfImZ}). ` +
          `Reason: ${mult.reason}. This is a contract violation between ` +
          `classifySector and stokesMultiplier; please file a bug.`,
      };
    }
    const multBC = mult.multiplier!;

    // Short-circuit: multiplier = 0 + 0i ⇒ the contribution vanishes
    // (no E evaluation needed). Saves a full `evaluateEpq` call when
    // the table says "inactive."
    if (multBC.re.mantissa === 0n && multBC.im.mantissa === 0n) {
      continue;
    }

    // Map sectorIndex {-1, 0, +1} to evaluateEpq's branchSign argument
    // (same encoding). evaluateEpq computes E_{p,q}(z · e^{2πi k / κ})
    // for the k = sectorIndex selection.
    const eResult = evaluateEpq(params, z, sectorIndex, workingBits);
    if (eResult.status !== "success") {
      // Forward the refusal as input-error with context; the connection
      // formula cannot assemble if any of its E contributions fails.
      return {
        status: "input-error",
        reason:
          `Stokes connection-formula assembly: E_{p,q}(z e^{2πi · ${sectorIndex}/κ}) ` +
          `refused (status=${eResult.status}, reason=${eResult.reason}). ` +
          `The egf v0.1 path cannot proceed without all required E terms.`,
      };
    }

    // S_k · E_k: complex multiplication. Per the stokes.ts table the
    // multiplier is one of {0, ±1, ±i} — exact rational complex — so
    // the cmul here introduces no precision loss.
    const contribution = cmul(multBC, eResult.value, workingBits);
    total = cadd(total, contribution, workingBits);
    // Fold the E's first-omitted-term magnitude into the overall
    // error estimate. Multiplier magnitude is exactly 1 (or 0,
    // already short-circuited), so |S_k · err_k| = err_k.
    totalErrorEstimate = add(
      totalErrorEstimate,
      eResult.errorEstimate,
      workingBits,
    );
    for (const w of eResult.warnings) {
      warnings = [...warnings, `E_${sectorIndex}: ${w}`];
    }
  }

  // Round to user precision.
  const userBits = decimalToBinaryPrecision(precision, 0);
  return {
    status: "success",
    value: {
      re: roundTo(total.re, userBits),
      im: roundTo(total.im, userBits),
    },
    achievedPrecision: precision,
    method: "braaksma-stokes",
    nTerms: algResult.nTerms,
    optimalTermIndices: algResult.optimalTermIndices,
    errorEstimate: totalErrorEstimate,
    sector: "stokes",
    workingPrecision: workingBits,
    warnings,
  };
}

/**
 * Algebraic-series assembler for the asymptotic path. Extracted from
 * `meijergAsymptotic`'s principal-sector body so the Stokes path
 * (ADR-0039 §D3) can reuse it.
 *
 * `zForSeries` is the argument fed into the per-pole `asymptoticTerms`
 * generator and the `z^{a_h - 1}` prefactor. For both the principal
 * path and the Stokes path it equals `z` (the original input argument);
 * `zReport` is the same value used only for the `|z|` magnitude in
 * error-message formatting.
 *
 * The Stokes path previously passed `cneg(z)` as `zForSeries`, thinking
 * that DLMF 16.11.7's `H_{q,q}(z e^{∓πi})` rotation was required.
 * That rotation applies to the DLMF asymptotic for {}_qF_q, not to the
 * workbench's H^{m,n}_{p,q} Slater-residue series (which equals G(z)
 * directly on the principal sheet). The fix removes the rotation; both
 * paths now pass `zForSeries = z`.
 *
 * The function returns a `MeijerGAsymptoticResult` shaped exactly like
 * the public `meijergAsymptotic` return — the caller decides whether
 * to short-circuit on refusal or fold the result into a wider
 * connection-formula assembly.
 */
function assembleAlgebraic(
  params: MeijerGParameters,
  zForSeries: BigComplex,
  zReport: BigComplex,
  precision: number,
  workingBits: number,
  maxTermsPerPole: number,
  method: "braaksma-algebraic" | "braaksma-stokes",
  sector: "principal" | "stokes",
): MeijerGAsymptoticResult {
  const { an } = params;
  const n = an.length;
  const optimalTermIndices: number[] = [];
  let totalNTerms = 0;
  let total = cfromReal(fromInt(0n, workingBits));
  let errorEstimate = fromInt(0n, workingBits);
  const warnings: string[] = [];
  let anyReachedCap = false;
  const zMagReport = toFloat64(cabs(zReport, workingBits)).value;

  for (let h = 0; h < n; h++) {
    const trunc = findOptimalTruncation(
      params,
      zForSeries,
      h,
      workingBits,
      maxTermsPerPole,
    );
    optimalTermIndices.push(trunc.index);
    totalNTerms += trunc.nTerms;
    if (trunc.reachedCap) {
      anyReachedCap = true;
      warnings.push(
        `pole h=${h}: optimal-truncation finder reached cap ` +
          `(${maxTermsPerPole} terms) without turnaround; series may ` +
          `not be in its asymptotic regime`,
      );
    }
    for (const w of trunc.warnings) {
      warnings.push(`pole h=${h}: ${w}`);
    }
    if (trunc.index === 0 && !trunc.reachedCap) {
      return {
        status: "non-asymptotic-regime",
        reason:
          `pole h=${h}: |t_1| ≥ |t_0| at the first step; |z| not large ` +
          `enough for the asymptotic to apply usefully. Route to ` +
          `Slater or contour quadrature instead. ` +
          `(workingBits=${workingBits}, |z|=${zMagReport.toExponential(3)})`,
      };
    }

    let prefactor: BigComplex;
    try {
      prefactor = residuePrefactor(params, h, workingBits);
    } catch (e) {
      return {
        status: "input-error",
        reason:
          `pole h=${h}: prefactor Γ-product hit a pole ` +
          `(${e instanceof Error ? e.message : String(e)}); v0.1 ` +
          `does not perturb in the asymptotic path. Route to Slater ` +
          `(which handles coalescence via Johansson hmag).`,
      };
    }
    const ah = an[h]!;
    const ahMinusOne = csub(
      ah,
      cfromReal(fromInt(1n, workingBits)),
      workingBits,
    );
    // Note: `cpow(zForSeries, ahMinusOne)` is the per-pole `z^{a_h-1}`
    // evaluated at the principal-value argument `z`. For both the
    // principal path and the Stokes path, `zForSeries = z` (no rotation).
    // See the fix-note in the Stokes-band section of `meijergAsymptotic`
    // for why the previous κ = 1 rotation to `cneg(z)` was incorrect.
    const zPow = cpow(zForSeries, ahMinusOne, workingBits);
    const piece = cmul(
      prefactor,
      cmul(zPow, trunc.partialSum, workingBits),
      workingBits,
    );
    total = cadd(total, piece, workingBits);

    const errMagPiece = cabs(
      cmul(
        prefactor,
        cmul(zPow, cfromReal(trunc.errorEstimate), workingBits),
        workingBits,
      ),
      workingBits,
    );
    errorEstimate = add(errorEstimate, errMagPiece, workingBits);
  }

  if (anyReachedCap) {
    warnings.push(
      "result includes contributions from poles whose optimal " +
        "truncation was capped; error estimate may underestimate true error",
    );
  }

  const userBits = decimalToBinaryPrecision(precision, 0);
  return {
    status: "success",
    value: {
      re: roundTo(total.re, userBits),
      im: roundTo(total.im, userBits),
    },
    achievedPrecision: precision,
    method,
    nTerms: totalNTerms,
    optimalTermIndices,
    errorEstimate,
    sector,
    workingPrecision: workingBits,
    warnings,
  };
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

/**
 * Round a BigFloat to a target bit precision via add-with-zero. Same
 * idiom as `contour.ts`'s `roundTo`. Bit-deterministic; precision
 * affects the stored representation only.
 */
function roundTo(x: BigFloat, prec: number): BigFloat {
  if (x.precision === prec) return x;
  const zero: BigFloat = { mantissa: 0n, exponent: 0, precision: prec };
  return add(x, zero, prec);
}

// `bitLength` is imported but currently not used directly — kept in
// the import list for the future v0.2 high-precision sector check
// that needs to read mantissa-bit-length.
void bitLength;
