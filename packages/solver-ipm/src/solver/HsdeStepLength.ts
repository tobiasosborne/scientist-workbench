// Step-to-boundary helpers for the HSDE iterate. The new constraint
// HSDE adds over the standard primal-dual IPM is that the
// homogenization scalars `τ > 0` and `κ > 0` must remain strictly
// positive — they participate in the step-length ratio test alongside
// the cone variables.
//
// The HSDE full step length is:
//
//     α = min(α_K_primal, α_K_dual, α_τ, α_κ)
//
// where the first two are the existing cone step-to-boundary tests
// (`maxStepToBoundary` for LP, `minBlockStep` for SDP — currently
// private in `NtSdpSolver.ts`), and `α_τ, α_κ` come from the simple
// scalar ratio test below.
//
// The Mehrotra safeguard `α ← max(0.95·α, 2α − 1)` capped at
// `0.999999` is applied AFTER taking the minimum — see
// `StepLength.ts:safeguardStep`, which is reused unchanged.
//
// Why this file vs inlining: the τ-κ ratio is a 4-line helper, but it
// recurs in both the LP and SDP HSDE solvers and in two places per
// iter (affine step length, combined step length). Centralizing keeps
// the algebra in one place — if the safety mechanism ever needs to
// change (e.g., a τ-floor or κ-floor for ill-conditioned problems),
// it changes here, not in two call sites in two solvers.
//
// References: Mosek capi.pdf §13.3.2 (step length per cone + τ, κ);
// ECOS source `ecos.c:lineSearch` (the cone-plus-scalar pattern this
// helper distils); Andersen 2009 §3 Step 6 (the equality version of
// the ratio test).

import { maxStepToBoundary } from "./StepLength.js";

/**
 * Maximum step keeping `τ + α·dτ ≥ 0` and `κ + α·dκ ≥ 0`. The
 * standard ratio test for non-negative scalars:
 *
 *   - If `dτ < 0`, the binding step is `−τ / dτ` (the value of α
 *     that drives τ + α·dτ to exactly zero).
 *   - If `dτ ≥ 0`, τ does not bind (it stays non-negative for any
 *     α ≥ 0).
 *   - Same for κ.
 *
 * Returns `Infinity` if neither variable binds — caller will then
 * be bounded by the cone tests or by `Math.min(1, …)` at the call
 * site.
 */
export function tauKappaMaxStep(
  tau: number,
  dtau: number,
  kappa: number,
  dkappa: number,
): number {
  let alpha = Infinity;
  if (dtau < 0) {
    const a = -tau / dtau;
    if (a < alpha) alpha = a;
  }
  if (dkappa < 0) {
    const a = -kappa / dkappa;
    if (a < alpha) alpha = a;
  }
  return alpha;
}

/**
 * Full HSDE LP step length: `min(α_x, α_s, α_τ, α_κ)`.
 *
 * - `α_x, α_s` from `maxStepToBoundary` (existing LP step-to-boundary
 *   ratio test on non-negative vectors).
 * - `α_τ, α_κ` from `tauKappaMaxStep` (the new HSDE scalar test).
 *
 * The minimum is taken because the iterate must remain strictly
 * interior in *all four* variables simultaneously. The Mehrotra
 * safeguard (`safeguardStep` from `StepLength.ts`) is applied
 * AFTER this — this function returns the raw max-step.
 *
 * Note: in the legacy non-HSDE LP path, the primal and dual step
 * lengths are taken independently (`αP` and `αD`). HSDE keeps them
 * tied: the τ and κ updates use a single global α, so the cone
 * variables walk in lockstep with the homogenization scalars.
 * Returning a single number reflects this — there is no `α_primal`
 * vs `α_dual` distinction in HSDE.
 */
export function hsdeLpMaxStep(
  x: Float64Array,
  dx: Float64Array,
  s: Float64Array,
  ds: Float64Array,
  tau: number,
  dtau: number,
  kappa: number,
  dkappa: number,
): number {
  const ax = maxStepToBoundary(x, dx);
  const as_ = maxStepToBoundary(s, ds);
  const ak = tauKappaMaxStep(tau, dtau, kappa, dkappa);
  return Math.min(ax, as_, ak);
}

/**
 * Full HSDE SDP step length: `min(α_X, α_S, α_τ, α_κ)`.
 *
 * Takes the pre-computed per-cone primal and dual step bounds as
 * inputs rather than the matrices themselves. This is a deliberate
 * Phase 0 choice — the SDP cone step-to-boundary (`minBlockStep` in
 * `NtSdpSolver.ts`) is currently a private function in that module.
 * Extracting / re-exporting it crosses the "additive only" scope
 * of Phase 0 (CLAUDE.md Rule 8). The HSDE NT SDP solver (Phase 2)
 * will compute the cone steps inline using the same `minBlockStep`
 * logic and pass them through here.
 *
 * The function exists in Phase 0 so the τ-κ ratio test is
 * exercised by the LP solver (Phase 1) before the SDP path lands,
 * and so the type surface for HSDE step length is one signature
 * regardless of cone family.
 */
export function hsdeSdpMaxStep(
  conePrimalStep: number,
  coneDualStep: number,
  tau: number,
  dtau: number,
  kappa: number,
  dkappa: number,
): number {
  const ak = tauKappaMaxStep(tau, dtau, kappa, dkappa);
  return Math.min(conePrimalStep, coneDualStep, ak);
}
