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
  add,
  bitLength,
  cabs,
  cadd,
  cdiv,
  cfromReal,
  cgamma,
  cmp,
  cmul,
  cneg,
  cpow,
  csub,
  decimalToBinaryPrecision,
  fromInt,
  isZero,
  toFloat64,
} from "@workbench/bigfloat";
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
  readonly method: "braaksma-algebraic";
  /** Total summands across all `n` per-pole series. */
  readonly nTerms: number;
  /** Per-pole optimal truncation index (length `n`). */
  readonly optimalTermIndices: readonly number[];
  /** Sum of per-pole `|B_h · z^{a_h - 1} · t_{k*+1}|`; conservative
   *  error estimate.  Reported as a BigFloat at `workingPrecision`. */
  readonly errorEstimate: BigFloat;
  readonly sector: "principal";
  readonly workingPrecision: number;
  readonly warnings: readonly string[];
}

export interface MeijerGAsymptoticRefusal {
  readonly status:
    | "stokes-line"
    | "secondary-sector"
    | "small-z"
    | "non-asymptotic-regime"
    | "no-pole-residues"
    | "input-error";
  readonly reason: string;
}

export type MeijerGAsymptoticResult =
  | MeijerGAsymptoticSuccess
  | MeijerGAsymptoticRefusal;

// -----------------------------------------------------------------------------
// Sector classification
// -----------------------------------------------------------------------------
//
// Three sector classes:
//
//   * `principal`: `|arg z| ≤ angle - margin`; the algebraic series
//     alone is asymptotic, no exponential corrections needed.
//   * `stokes`: `|arg z|` within `margin` of the boundary; the
//     exponential terms are switching on/off and v0.1's algebraic-
//     only answer is unreliable. Refuse.
//   * `secondary`: `|arg z|` is past the principal-sector cap; full
//     Braaksma theorem (deferred) is required. Refuse.
//
// `margin` scales with the working precision: `2^{-workingBits/4}`
// — small enough to admit legitimate inputs at 50 dps (band ~10^-13),
// wide enough to catch genuinely-near-Stokes inputs at any precision.

/**
 * Classify the sector containing `z` for the v0.1 algebraic
 * asymptotic. The `m, n, p, q` arguments are accepted for forward
 * compatibility (future v0.2 will have regime-dependent half-angle)
 * but v0.1 uses a single conservative cap across all regimes.
 */
export function classifySector(
  z: BigComplex,
  m: number,
  n: number,
  p: number,
  q: number,
  workingBits: number,
  principalSectorAngle?: number,
): "principal" | "stokes" | "secondary" {
  // ADR-0026 §3 sets the v0.1 default at π/2 − π/64 (strictly tighter
  // than the DLMF principal sector for `p ≤ q − 1`, equal to it for
  // `p ≥ q`). The conservative cap costs nothing because the contour
  // layer covers `|arg z| ∈ [π/2 - π/64, π]` cleanly. v0.2 may widen
  // per regime.
  void m;
  void n;
  void p;
  void q;
  const angle = principalSectorAngle ?? Math.PI / 2 - Math.PI / 64;

  if (isZero(z.re) && isZero(z.im)) {
    return "secondary"; // |z| = 0 is not in any far-field sector
  }
  // We classify in float64 |arg z|. Cost: one toFloat64 per
  // BigFloat. A future v0.2 could classify in BigFloat for tighter
  // band edges, but at workingBits ≥ 100 the float64 |arg z| is
  // accurate to ~16 digits, more than sufficient outside the Stokes
  // band; *inside* the band we want refusal anyway.
  const reF = toFloat64(z.re).value;
  const imF = toFloat64(z.im).value;
  const absArg = Math.abs(Math.atan2(imF, reF));

  // Margin: 2^{-workingBits/4} radians. At workingBits = 200 the
  // margin is 2^{-50} ≈ 9·10^{-16}; at workingBits = 100 it is
  // 2^{-25} ≈ 3·10^{-8}. Both are well below the angular precision
  // any reasonable caller cares about.
  const margin = Math.pow(2, -workingBits / 4);

  if (absArg < angle - margin) return "principal";
  if (absArg < angle + margin) return "stokes";
  return "secondary";
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
// Optimal-truncation finder
// -----------------------------------------------------------------------------

/**
 * Read the per-pole term magnitudes off `asymptoticTerms` and find
 * the optimal truncation index `k*`: the last index `k` such that
 * `|t_{k+1}| < |t_k|`. The error estimate is `|t_{k*+1}|` (Olver
 * §3.7, "superasymptotic").
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
 *     magnitude turnaround. The caller decides whether to surface
 *     a warning, treat the partial sum as best-effort, or refuse
 *     with `non-asymptotic-regime`.
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
} {
  const it = asymptoticTerms(params, z, h, workingBits);
  // First term: k = 0.
  const t0 = it.next().value as BigComplex;
  let prevMag = cabs(t0, workingBits);
  let partialSum = t0;

  for (let k = 1; k < maxTerms; k++) {
    const tk = it.next().value as BigComplex;
    const tkMag = cabs(tk, workingBits);

    // Term-magnitude turnaround test. If `|t_k| ≥ |t_{k-1}|`, the
    // asymptotic geometry has reversed at index `k-1`; truncate
    // there. The error estimate is `|t_k|`, the first-omitted-term
    // magnitude (Olver Lemma 3.7.1).
    if (cmp(tkMag, prevMag) >= 0) {
      return {
        index: k - 1,
        partialSum,
        errorEstimate: tkMag,
        nTerms: k + 1,
        reachedCap: false,
      };
    }

    // Still shrinking — accumulate.
    partialSum = cadd(partialSum, tk, workingBits);
    prevMag = tkMag;
  }
  // Cap reached without turnaround.
  return {
    index: maxTerms - 1,
    partialSum,
    errorEstimate: prevMag,
    nTerms: maxTerms,
    reachedCap: true,
  };
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

  // Sector check.
  const sectorAngle = opts.principalSectorAngle;
  const sector = classifySector(z, m, n, p, q, workingBits, sectorAngle);
  if (sector === "stokes") {
    return {
      status: "stokes-line",
      reason:
        "input lies within the precision-dependent Stokes-line band " +
        "around |arg z| = π/2 - π/64; the v0.1 algebraic-only asymptotic " +
        "is unreliable here. Route to contour quadrature " +
        "(meijergContour) or wait for hv0.9.2 (Stokes-line connection " +
        "coefficients).",
    };
  }
  if (sector === "secondary") {
    return {
      status: "secondary-sector",
      reason:
        "|arg z| > π/2 - π/64 (secondary sector); the v0.1 dominant " +
        "balance does not cover this sector. Route to contour " +
        "quadrature or wait for hv0.9.5 (full sector handling).",
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

  // Per-pole truncation + accumulation.
  const maxTermsPerPole = opts.maxTermsPerPole ?? Math.max(64, 4 * precision);
  const optimalTermIndices: number[] = [];
  let totalNTerms = 0;
  let total = cfromReal(fromInt(0n, workingBits));
  let errorEstimate = fromInt(0n, workingBits);
  const warnings: string[] = [];
  let anyReachedCap = false;

  for (let h = 0; h < n; h++) {
    const trunc = findOptimalTruncation(
      params,
      z,
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
    if (trunc.index === 0 && !trunc.reachedCap) {
      // |t_1| ≥ |t_0|: the very first ratio is non-shrinking. The
      // series is not asymptotic at this |z| for this pole. The
      // partial sum is just `t_0 = 1`, which is meaningless on its
      // own — refuse with `non-asymptotic-regime`.
      return {
        status: "non-asymptotic-regime",
        reason:
          `pole h=${h}: |t_1| ≥ |t_0| at the first step; |z| not large ` +
          `enough for the asymptotic to apply usefully. Route to ` +
          `Slater or contour quadrature instead. ` +
          `(workingBits=${workingBits}, |z|=${zMag.toExponential(3)})`,
      };
    }

    // Apply the per-pole prefactor B_h and the z^{a_h - 1} factor.
    let prefactor: BigComplex;
    try {
      prefactor = residuePrefactor(params, h, workingBits);
    } catch (e) {
      // cgamma throws RangeError on exact non-positive integer.
      // Surface as input-error; the asymptotic does not perturb in
      // v0.1 (the Slater path's Johansson hmag is the perturbation
      // home).
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
    const zPow = cpow(z, ahMinusOne, workingBits);
    const piece = cmul(
      prefactor,
      cmul(zPow, trunc.partialSum, workingBits),
      workingBits,
    );
    total = cadd(total, piece, workingBits);

    // Per-pole error contribution: |B_h · z^{a_h - 1} · t_{k*+1}|.
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

  // Round to user precision and pack.
  const userBits = decimalToBinaryPrecision(precision, 0);
  return {
    status: "success",
    value: {
      re: roundTo(total.re, userBits),
      im: roundTo(total.im, userBits),
    },
    achievedPrecision: precision,
    method: "braaksma-algebraic",
    nTerms: totalNTerms,
    optimalTermIndices,
    errorEstimate,
    sector: "principal",
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
