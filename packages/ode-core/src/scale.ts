// =============================================================================
// scale.ts — measurement-driven warning thresholds for non-stiff IVP
// =============================================================================
//
// ADR-0016 applied to the ODE tier. Mirrors `linalg-core/src/scale.ts`'s
// pattern: rather than refusing inputs above an arbitrary cap, we
// *warn* — the agent reads the strings and decides what to do. The
// agent-honest output discipline already has a `warnings` field; this
// helper produces the strings that go in it.
//
// Non-stiff IVP scale dimensions
// ------------------------------
// Two independent dimensions matter for an explicit RK driver:
//
//   1. `n_components` — state-vector dimension. Per-step cost is
//      O(n_components) and so is the wire-encoding cost of the
//      trajectory. On a phone the wire payload is the dominant
//      pressure: `(n_eval × n_components)` floats at ~25 bytes each
//      after canonical encoding. Phone browser-tab budget is
//      typically 1-2 GB; 10 MB of trajectory is a perceptible bite.
//
//   2. `n_steps_estimate` — projected number of accepted steps. For
//      an explicit RK pair on a problem with characteristic frequency
//      ω over horizon T, `n_steps ≈ ω·T / rtol^(1/p)` where p is the
//      method order (5 for DOPRI5). The driver doesn't know ω in
//      advance; the caller's `t_eval` length is a lower bound and the
//      ratio `(tf − t0) / max_step` (when supplied) is an upper. We
//      use a conservative estimate based on the user's inputs.
//
// Phone CPUs run roughly 3× slower than the dev-box x86 measurements;
// the messages bake in that factor.

const N_COMPONENTS_LARGE = 100;       // beyond this: "wire encoding cost noticeable"
const N_COMPONENTS_VERY_LARGE = 1000; // beyond this: "FFI strongly recommended"

const N_STEPS_LONG = 100_000;     // beyond this: "long integration; consider stiff solver"
const N_STEPS_VERY_LONG = 1_000_000;

export type Algorithm = "ode-rkf45" | "ode-radau";

/**
 * Estimate peak working memory in MB for a `n_components × n_eval`
 * trajectory plus the integrator's per-step working buffers. The
 * driver allocates ~10 Float64Array buffers of length `n_components`
 * (seven k-vectors, y_new, err, tmp); the trajectory is a 2-D float64
 * array of `n_eval × n_components`.
 */
export function estimatePeakMemoryMB(
  nComponents: number,
  nEvalPoints: number,
): number {
  // Per-step working: 10 buffers × n × 8 bytes
  const working = 10 * nComponents * 8;
  // Trajectory: n_eval × n_components × 8 bytes (the float64 array)
  // plus the wire-encoded JSON form (~3× expansion factor).
  const traj = nEvalPoints * nComponents * 8 * 4;
  const baseline = 50 * 1024 * 1024;
  return (working + traj + baseline) / (1024 * 1024);
}

/** Wall-clock estimate (seconds) on the dev-box for `n_steps`
 *  accepted RK steps with `n_components` state. Phone CPUs ≈ 3× slower.
 *
 *  Calibration: a single DOPRI5 step costs ~6 RHS evals × per-eval cost.
 *  For Radau, one accepted step costs ~3·k_newton ≈ 12 stage evals plus
 *  one n³/3 LU factorisation; the LU dominates at moderate `n`. For the
 *  closed-vocabulary expression of typical depth (~10 nodes), one
 *  evaluation is ~5 µs on Bun on x86-64; we round to 1 µs/eval/component.
 */
export function estimateWallClockSeconds(
  algo: Algorithm,
  nComponents: number,
  nSteps: number,
): number {
  if (algo === "ode-radau") {
    // Radau-IIA: per accepted step, ~12 stage evals + one O(n³) LU.
    const evalCost = nSteps * 12 * nComponents * 1e-6;
    const luCost = nSteps * (nComponents * nComponents * nComponents) / 3 * 1e-9;
    return evalCost + luCost;
  }
  return nSteps * (6 + 1) * nComponents * 1e-6;
}

/** Produce the canonical warning strings for a given problem. */
export function assessNumericalScale(
  algo: Algorithm,
  nComponents: number,
  nStepsEstimate: number,
  nEvalPoints: number = 0,
): string[] {
  const warnings: string[] = [];
  const isStiff = algo === "ode-radau";

  if (nComponents > N_COMPONENTS_VERY_LARGE) {
    warnings.push(
      `state dimension n=${nComponents} is in the regime where pure-TS ` +
      `vector evaluation becomes a bottleneck; FFI bridge to a compiled ` +
      `${isStiff ? "Radau" : "RK"} driver strongly recommended (bead scientist-workbench-e7y for the ` +
      `numerical-tier FFI plan)`,
    );
  } else if (nComponents > N_COMPONENTS_LARGE) {
    warnings.push(
      `state dimension n=${nComponents} above the ${N_COMPONENTS_LARGE}-component ` +
      `well-tested threshold; ${isStiff ? "per-step cost is O(n³) (LU factorisation) and the" : "per-step cost grows linearly in n and the"} wire-` +
      `encoded trajectory size grows as n × n_eval`,
    );
  }

  if (nStepsEstimate > N_STEPS_VERY_LONG) {
    const tSec = estimateWallClockSeconds(algo, nComponents, nStepsEstimate);
    if (isStiff) {
      warnings.push(
        `estimated step count ${nStepsEstimate.toExponential(2)} is very long for ` +
        `Radau (~${tSec.toFixed(0)}s on dev-box); consider an FFI-backed solver or splitting the horizon`,
      );
    } else {
      warnings.push(
        `estimated step count ${nStepsEstimate.toExponential(2)} is in the regime ` +
        `where DOPRI5 is impractical (~${tSec.toFixed(0)}s on dev-box); the ` +
        `problem is likely stiff (consider integrate-ode-stiff, bead scientist-` +
        `workbench-09g) or the horizon should be split`,
      );
    }
  } else if (nStepsEstimate > N_STEPS_LONG) {
    const tSec = estimateWallClockSeconds(algo, nComponents, nStepsEstimate);
    warnings.push(
      `estimated step count ${nStepsEstimate.toExponential(1)} above the ` +
      `${N_STEPS_LONG.toExponential(0)} long-integration threshold; expected wall-` +
      `clock ~${tSec.toFixed(1)}s on dev-box (~${(tSec * 3).toFixed(0)}s on phone)`,
    );
  }

  if (nEvalPoints > 0) {
    const peakMB = estimatePeakMemoryMB(nComponents, nEvalPoints);
    if (peakMB > 500) {
      warnings.push(
        `estimated peak memory ~${peakMB.toFixed(0)} MB; OOM risk on mobile ` +
        `platforms (typical browser-tab budget 1-2 GB)`,
      );
    } else if (peakMB > 100) {
      warnings.push(
        `estimated peak memory ~${peakMB.toFixed(0)} MB; large fraction of ` +
        `typical mobile-browser tab budget`,
      );
    }
  }

  return warnings;
}
