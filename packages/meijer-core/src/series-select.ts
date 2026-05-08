// =============================================================================
// Series-selection rule (Slater 1966 §5; Johansson 2009 mpmath blog post)
// =============================================================================
//
// Slater's theorem gives two natural residue-summation paths through the
// Mellin-Barnes contour for `G^{m,n}_{p,q}`:
//
//   Series 1 — close the contour around the `Γ(b_j − s)` poles (j = 1..m).
//              The result is a sum of `m` residue lines, each one a
//              `pF_{q-1}` series in `(−1)^{p−m−n} · z`.
//              Inner-series radius of convergence:
//                * `∞` when `p < q` (the inner series is `pF_{q−1}` with
//                   `p < q − 1 + 1`, whole-plane convergent);
//                * `1`  when `p == q`.
//
//   Series 2 — close around the `Γ(1 − a_j + s)` poles (j = 1..n).
//              The result is a sum of `n` residue lines in
//              `(−1)^{q−m−n} / z`. Inner-series radius:
//                * `∞` when `p > q`;
//                * `1`  when `p == q`.
//
// The selection rule is the cheapest decision that always lands on a
// convergent series:
//
//   * `p < q`:               Series 1 (Series 2 inner is divergent).
//   * `p > q`:               Series 2 (Series 1 inner is divergent).
//   * `p == q == m + n`:     pick by `|z|` against the unit circle —
//                              `|z| > 1` ⟹ Series 2,
//                              `|z| < 1` ⟹ Series 1,
//                              `|z| ≈ 1` ⟹ neither converges (quarantine).
//   * `p == q ∧ m + n ≠ p`: Slater's series both have weaker structure
//                              here — the formula has a Stokes-phenomenon
//                              behaviour that is subtler than a simple
//                              radius-of-convergence story. We default
//                              to Series 1 and let the inner pFq refuse
//                              when it must.
//
// The function below codifies this rule as a small, fully-tested
// dispatcher; the `slater.ts` orchestrator reads its result and runs
// the chosen series.

import type { BigComplex } from "@workbench/bigfloat";
import { cabs, toFloat64 } from "@workbench/bigfloat";
import type { MeijerGParameters, SeriesChoice } from "./types.js";

/**
 * Decision returned by the selector.
 *
 * `quarantine` flags the awkward-`|z|≈1` band where both series fail
 * for `p == q ∧ m + n == p`. The orchestrator turns that flag into a
 * structured `quarantine-band` refusal at the boundary; downstream
 * the caller would route the same input through the layer-13e contour
 * quadrature.
 */
export interface SeriesSelection {
  readonly series: SeriesChoice;
  readonly quarantine: boolean;
  readonly zMag: number;
  readonly p: number;
  readonly q: number;
  readonly m: number;
  readonly n: number;
}

/**
 * Apply the (p, q, m, n, |z|) selection rule. The quarantine-band
 * decision uses `|z|` evaluated to float64 (sufficient — the band is a
 * ~`±0.01` neighbourhood of the unit circle, far above any precision
 * the dial would ask for).
 */
export function selectSeries(
  params: MeijerGParameters,
  z: BigComplex,
  opts?: {
    readonly forceSeries?: SeriesChoice;
    readonly quarantineBand?: readonly [number, number];
  },
): SeriesSelection {
  const m = params.bm.length;
  const n = params.an.length;
  const p = n + params.ap.length;
  const q = m + params.bq.length;

  const zMag = toFloat64(cabs(z, 53)).value;
  // Default band is sized to the inner-pFq's refusal threshold (0.99
  // in `@workbench/hypergeometric`'s direct-series evaluator). Anything
  // closer to the unit circle than that — on either side — would push
  // the inner pFq into the deferred analytic-continuation regime, and
  // the Slater path's job is to surface that as a structured refusal
  // so the caller can route to the contour-integration layer.
  const [qLo, qHi] = opts?.quarantineBand ?? [0.99, 1 / 0.99];

  const forced = opts?.forceSeries;
  if (forced !== undefined) {
    return { series: forced, quarantine: false, zMag, p, q, m, n };
  }

  // Series 2 has no `Γ(1 − a_j + s)` poles to close around when n = 0;
  // similarly Series 1 fails when m = 0. Defer to the other series
  // before the (p, q) tie-break.
  if (n === 0) {
    return { series: 1, quarantine: false, zMag, p, q, m, n };
  }
  if (m === 0) {
    return { series: 2, quarantine: false, zMag, p, q, m, n };
  }

  if (p < q) {
    return { series: 1, quarantine: false, zMag, p, q, m, n };
  }
  if (p > q) {
    return { series: 2, quarantine: false, zMag, p, q, m, n };
  }

  // p == q.
  if (p === m + n) {
    if (zMag >= qLo && zMag <= qHi) {
      // Default to Series 1 (the orchestrator will see the quarantine
      // flag and refuse before evaluating).
      return { series: 1, quarantine: true, zMag, p, q, m, n };
    }
    if (zMag > 1) {
      return { series: 2, quarantine: false, zMag, p, q, m, n };
    }
    return { series: 1, quarantine: false, zMag, p, q, m, n };
  }

  // p == q ∧ m + n ≠ p — Stokes regime. Default to Series 1.
  return { series: 1, quarantine: false, zMag, p, q, m, n };
}
