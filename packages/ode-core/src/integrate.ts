// =============================================================================
// integrate.ts — adaptive driver for non-stiff IVP via DOPRI5 + PI controller
// =============================================================================
//
// Intent
// ------
// Top-level adaptive integrator for `dy/dt = f(t, y), y(t0) = y0` over
// `t ∈ [t0, tf]` (forward) or `[tf, t0]` (reverse, when `tf < t0`).
// Combines:
//
//   * `dopri5.ts` — single-step Dormand-Prince 5(4) with FSAL.
//   * `pi-controller.ts` — Gustafsson 1991 PI step-size law plus
//                          HNW Vol I §II.4 initial-step heuristic.
//   * Hermite continuous extension (HNW Vol I §II.6) for evaluation
//     at sub-step `t_eval` points.
//
// The driver is allocation-free in the inner loop: every `Float64Array`
// it needs is allocated once at entry and reused across step
// attempts. Rejected steps reuse `k1` (since FSAL `k7` only rotates
// into `k1` on accepted steps). The PI controller's `err_prev` is
// only updated on accepted steps.
//
// Boundary semantics
// ------------------
// Two boundary conditions surface as `OdeNonFiniteError` /
// degenerate-tspan signal; the tool layer translates these to ADR-0003
// tagged values. A `t0 == tf` input is rejected at the top of the
// driver (no integration is needed; reporting `(y0)` would be a lie
// about whether the step controller had any opinion at all).
//
// Reverse integration
// -------------------
// `tf < t0` integrates backward. Internally we set `direction = -1`
// and let the step size carry the sign: every step is `t_{n+1} = t_n
// + h` with `h < 0`. The PI law and dense extension are direction-
// agnostic; the continuous extension still uses `θ ∈ [0, 1]`
// parameterising "fraction of step elapsed" which works in either
// direction. The `t_eval` array is required to be sorted in the
// direction of integration (descending for reverse); we walk it in
// step order and emit one row per requested time.
//
// Status semantics
// ----------------
// `status === "success"` iff every requested `t_eval` point was
// reached and the integration completed up to `tf`. `converged === (status === "success")`
// is enforced.
//
// Other status values:
//   * `"max_step_exceeded"` — caller specified `max_step` and a step
//     attempt would exceed it after applying the controller's
//     contraction. Currently unused (we honour `max_step` by clipping
//     each attempt; we never need to abort) but reserved for v0.2.
//   * `"tspan_exhausted"` — the integrator could not advance beyond
//     a stiffness-edge / vanishing step (`|h_new| < 10·EPS·|t|`).

import { dopri5Step, dopri5DenseEval } from "./dopri5.js";
import { nextStepFactor, selectInitialStep } from "./pi-controller.js";

const EPS = Number.EPSILON;

/** Boundary signal: the user's `f` returned a non-finite component
 *  during integration. The driver throws this; the tool layer catches
 *  and translates to a `tagged` boundary value (ADR-0003). */
export class OdeNonFiniteError extends Error {
  readonly atT: number;
  readonly atY: Float64Array;
  readonly kind: "NaN" | "Infinity" | "-Infinity";
  constructor(atT: number, atY: Float64Array, kind: "NaN" | "Infinity" | "-Infinity") {
    super(
      `OdeNonFiniteError: f produced ${kind} at t = ${atT}, y = [${Array.from(atY).join(", ")}]`,
    );
    this.name = "OdeNonFiniteError";
    this.atT = atT;
    this.atY = atY;
    this.kind = kind;
  }
}

/** Boundary signal: `t0 == tf`. The driver throws this from
 *  `integrate()` so the tool layer can return `tagged
 *  "integrate-ode-ivp/degenerate-tspan"`. */
export class OdeDegenerateTspanError extends Error {
  readonly t0: number;
  readonly tf: number;
  constructor(t0: number, tf: number) {
    super(`OdeDegenerateTspanError: t0 == tf (${t0})`);
    this.name = "OdeDegenerateTspanError";
    this.t0 = t0;
    this.tf = tf;
  }
}

export interface IntegrateOptions {
  /** Relative tolerance per component. Default 1e-3. */
  readonly rtol?: number;
  /** Absolute tolerance per component. Default 1e-6. */
  readonly atol?: number;
  /** Optional cap on absolute step size. */
  readonly maxStep?: number;
  /** Output time grid (sorted in the direction of integration). When
   *  undefined we emit `[t0, tf]`. */
  readonly tEval?: readonly number[];
}

export interface IntegrateResult {
  /** Trajectory: `t_values.length × n_components` row-major. Each row
   *  is the state at the corresponding `t_values[i]`. */
  readonly trajectory: Float64Array[];
  /** The output time grid. Equal to `tEval` if provided, else `[t0, tf]`. */
  readonly tValues: Float64Array;
  /** The last accepted step's local error norm (1-normalised). The
   *  PI controller treats `err < 1` as the accept threshold. */
  readonly errorEstimate: number;
  /** Total `f` evaluations (accepted + rejected stages + initial probe). */
  readonly nEvals: number;
  readonly nStepsAccepted: number;
  readonly nStepsRejected: number;
  readonly status: "success" | "max_step_exceeded" | "tspan_exhausted";
}

/**
 * Adaptive integration of `dy/dt = f(t, y)` from `t0` to `tf`.
 *
 * Returns trajectory rows for every `tEval` point (default
 * `[t0, tf]`). For sub-step `tEval` points the Hermite continuous
 * extension is evaluated against the most-recently-accepted step;
 * accepted-endpoint `tEval` points read the integrator's state
 * directly without touching the dense extension.
 */
export function integrate(
  f: (t: number, y: Float64Array, out: Float64Array) => void,
  t0: number,
  tf: number,
  y0: Float64Array,
  options: IntegrateOptions = {},
): IntegrateResult {
  const rtol = options.rtol ?? 1e-3;
  const atol = options.atol ?? 1e-6;
  const maxStep = options.maxStep;
  const n = y0.length;

  // Degenerate tspan: t0 == tf. We refuse rather than report (y0).
  if (t0 === tf) {
    throw new OdeDegenerateTspanError(t0, tf);
  }

  // Direction of integration. Forward = 1, reverse = -1.
  const direction = tf > t0 ? 1 : -1;

  // Build the output time grid. If `tEval` is provided we use it as-
  // is; otherwise we emit only the endpoints.
  const tValuesArr: number[] = options.tEval !== undefined
    ? Array.from(options.tEval)
    : [t0, tf];
  const m = tValuesArr.length;

  // Pre-allocate the trajectory row buffers.
  const trajectory: Float64Array[] = new Array(m);
  for (let i = 0; i < m; i++) trajectory[i] = new Float64Array(n);

  // Per-step working storage. Allocate once, reuse forever.
  const k1 = new Float64Array(n);
  const k2 = new Float64Array(n);
  const k3 = new Float64Array(n);
  const k4 = new Float64Array(n);
  const k5 = new Float64Array(n);
  const k6 = new Float64Array(n);
  const k7 = new Float64Array(n);
  const yNew = new Float64Array(n);
  const errBuf = new Float64Array(n);
  const tmp = new Float64Array(n);
  // Snapshot of `y` at the start of the *most recently accepted step*;
  // needed by the dense extension to interpolate sub-step `t_eval`
  // points after `y` has already advanced.
  const yStep = new Float64Array(n);
  const ySnap = new Float64Array(n);
  // FSAL k1 stash for the *most recently accepted step* (so sub-step
  // dense interpolation uses the right k-vectors after y has advanced).
  const k1Snap = new Float64Array(n);
  const k2Snap = new Float64Array(n);
  const k3Snap = new Float64Array(n);
  const k4Snap = new Float64Array(n);
  const k5Snap = new Float64Array(n);
  const k6Snap = new Float64Array(n);
  const k7Snap = new Float64Array(n);

  // Integrator state: t, y, k1 (= f(t, y)).
  let t = t0;
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) y[i] = y0[i]!;

  let nEvals = 0;
  let nStepsAccepted = 0;
  let nStepsRejected = 0;

  // First evaluation: f(t0, y0). Required before the controller can
  // pick an initial step, and (since the integrator advances on FSAL)
  // becomes the very first `k1`.
  f(t, y, k1);
  nEvals += 1;
  checkFinite(k1, t, y);

  // Initial step. The controller's heuristic charges one extra `f`
  // evaluation (the Euler probe).
  let h = selectInitialStep(f, t, y, k1, rtol, atol, direction) * direction;
  nEvals += 1;
  if (maxStep !== undefined) {
    if (Math.abs(h) > maxStep) h = direction * maxStep;
  }

  // Cache the most-recently-accepted-step state for dense
  // interpolation. Initialised to "nothing accepted yet"; the first
  // accepted step populates them.
  let tStep = t0;       // start of the step whose k-vectors are stashed
  let hStep = 0;        // signed step size of that step
  let stepAccepted = false;

  let errPrevNorm: number | undefined = undefined;
  let lastErrNorm = 0;

  // Index into `tValuesArr`: the next un-emitted output time.
  let nextOut = 0;

  // Emit any output points equal to t0 (the dense extension is
  // unnecessary; just copy y).
  while (nextOut < m && Math.abs(tValuesArr[nextOut]! - t0) <= 1e-12 * Math.max(Math.abs(t0), 1)) {
    const row = trajectory[nextOut]!;
    for (let i = 0; i < n; i++) row[i] = y[i]!;
    // Snap the time exactly to t0 for monotone-t_values
    tValuesArr[nextOut] = t0;
    nextOut += 1;
  }

  let status: "success" | "max_step_exceeded" | "tspan_exhausted" = "success";

  // Main step loop.
  while (nextOut < m) {
    // Termination guard: have we already passed tf?
    if (direction * (t - tf) >= 0) {
      // Should not happen under normal flow (we clip `h` to land on tf).
      break;
    }

    // Clip step to land on tf if we're about to overshoot.
    if (direction * ((t + h) - tf) > 0) {
      h = tf - t;
    }
    if (maxStep !== undefined && Math.abs(h) > maxStep) {
      h = direction * maxStep;
    }

    // Check the step is large enough to make progress in float64.
    // 10·EPS·|t| matches SciPy's `_ivp/common.py::warn_extraneous`
    // floor and HNW's pragma.
    if (Math.abs(h) < 10 * EPS * Math.max(Math.abs(t), 1)) {
      status = "tspan_exhausted";
      break;
    }

    // Snapshot the step start. If accepted, this becomes the dense-
    // interpolation base.
    for (let i = 0; i < n; i++) yStep[i] = y[i]!;
    const tStepLocal = t;

    // Step. After this, k1..k7, yNew, errBuf are populated.
    dopri5Step(f, t, y, h, k1, k2, k3, k4, k5, k6, k7, yNew, errBuf, tmp);
    nEvals += 6;
    // Detect non-finite: any of the stages or yNew
    checkFinite(k2, t + (1 / 5) * h, y);
    checkFinite(k3, t + (3 / 10) * h, y);
    checkFinite(k4, t + (4 / 5) * h, y);
    checkFinite(k5, t + (8 / 9) * h, y);
    checkFinite(k6, t + h, y);
    checkFinite(k7, t + h, yNew);

    // 1-normalised error: ||err / (atol + rtol·max(|y|, |y_new|))||_RMS
    let sumSq = 0;
    for (let i = 0; i < n; i++) {
      const sc = atol + rtol * Math.max(Math.abs(y[i]!), Math.abs(yNew[i]!));
      const r = errBuf[i]! / sc;
      sumSq += r * r;
    }
    const errNorm = Math.sqrt(sumSq / n);

    if (errNorm < 1) {
      // Accept.
      // Copy k7 into k1 (FSAL) and snapshot the step's k-vectors for
      // dense interpolation.
      for (let i = 0; i < n; i++) {
        ySnap[i] = yStep[i]!;
        k1Snap[i] = k1[i]!;
        k2Snap[i] = k2[i]!;
        k3Snap[i] = k3[i]!;
        k4Snap[i] = k4[i]!;
        k5Snap[i] = k5[i]!;
        k6Snap[i] = k6[i]!;
        k7Snap[i] = k7[i]!;
      }
      tStep = tStepLocal;
      hStep = h;
      stepAccepted = true;

      // Advance integrator state.
      const tNew = t + h;
      for (let i = 0; i < n; i++) y[i] = yNew[i]!;
      // FSAL: k7 (computed at (t + h, y_new)) becomes the next k1.
      for (let i = 0; i < n; i++) k1[i] = k7[i]!;
      t = tNew;

      nStepsAccepted += 1;
      lastErrNorm = errNorm;

      // Emit any output points falling within (tStep, t]. Inclusive
      // of the right endpoint: when the controller lands exactly on a
      // requested t_eval point, we read y directly; for sub-step
      // points we evaluate the dense extension.
      while (nextOut < m) {
        const tOut = tValuesArr[nextOut]!;
        // Is tOut within the just-accepted step interval?
        // For forward (h > 0) the interval is (tStep, t]; we accept
        // tOut if direction*(tOut - tStep) > -ε and direction*(t - tOut) >= -ε.
        // Use a small slack to avoid losing exact-endpoint hits to
        // float roundoff.
        const tol = 1e-12 * Math.max(Math.abs(tStep), Math.abs(t), 1);
        const afterStart = direction * (tOut - tStep) > tol;
        const beforeOrAtEnd = direction * (t - tOut) >= -tol;
        if (afterStart && beforeOrAtEnd) {
          // Within the step. Evaluate dense extension at θ = (tOut - tStep) / hStep.
          const theta = (tOut - tStep) / hStep;
          if (theta >= 1 - tol / Math.max(Math.abs(hStep), 1)) {
            // Right at (or past) the right endpoint — use y directly.
            const row = trajectory[nextOut]!;
            for (let i = 0; i < n; i++) row[i] = y[i]!;
          } else {
            const row = trajectory[nextOut]!;
            dopri5DenseEval(
              theta, hStep, ySnap,
              k1Snap, k2Snap, k3Snap, k4Snap, k5Snap, k6Snap, k7Snap,
              row,
            );
          }
          // Snap time to exact request to keep monotone_t_values
          // happy (the integrator's internal `t` may differ from
          // the requested `tOut` by 1 ulp after add-clip-add).
          tValuesArr[nextOut] = tOut;
          nextOut += 1;
        } else {
          break;
        }
      }

      // PI controller seed for the next step.
      const factor = nextStepFactor(errNorm, errPrevNorm);
      h = h * factor;
      errPrevNorm = errNorm;
    } else {
      // Reject. The PI controller's I-only fallback law shrinks h.
      // We do *not* advance state; k1 (= f(t, y)) remains valid.
      const factor = nextStepFactor(errNorm, undefined);
      h = h * factor;
      nStepsRejected += 1;
      // Note: the six new f-evaluations done in this step are still
      // counted in nEvals (they are real work); they just don't move t.
    }

    // Termination: have we reached tf and emitted everything?
    if (direction * (t - tf) >= 0 && nextOut >= m) break;
  }

  // After the loop: any remaining output points beyond t are filled
  // with the most-recently-accepted state (or, if no step was
  // accepted, y0). This shouldn't happen on a successful run; if it
  // does, status is already "tspan_exhausted".
  while (nextOut < m) {
    const tOut = tValuesArr[nextOut]!;
    const row = trajectory[nextOut]!;
    if (stepAccepted) {
      // Use dense extension if tOut is within the last accepted step
      // and the integrator stalled trying to extend further.
      const theta = (tOut - tStep) / hStep;
      if (theta >= 0 && theta <= 1) {
        dopri5DenseEval(
          theta, hStep, ySnap,
          k1Snap, k2Snap, k3Snap, k4Snap, k5Snap, k6Snap, k7Snap,
          row,
        );
      } else {
        for (let i = 0; i < n; i++) row[i] = y[i]!;
      }
    } else {
      for (let i = 0; i < n; i++) row[i] = y0[i]!;
    }
    nextOut += 1;
    if (status === "success") status = "tspan_exhausted";
  }

  return {
    trajectory,
    tValues: new Float64Array(tValuesArr),
    errorEstimate: lastErrNorm,
    nEvals,
    nStepsAccepted,
    nStepsRejected,
    status,
  };
}

function checkFinite(buf: Float64Array, atT: number, atY: Float64Array): void {
  for (let i = 0; i < buf.length; i++) {
    const v = buf[i]!;
    if (!Number.isFinite(v)) {
      const kind: "NaN" | "Infinity" | "-Infinity" =
        Number.isNaN(v) ? "NaN" : v > 0 ? "Infinity" : "-Infinity";
      throw new OdeNonFiniteError(atT, new Float64Array(atY), kind);
    }
  }
}
