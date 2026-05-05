// =============================================================================
// integrate-stiff.ts — adaptive stiff IVP driver via Radau-IIA(5)
// =============================================================================
//
// Intent
// ------
// Top-level adaptive integrator for stiff `dy/dt = f(t, y)` over `[t0,
// tf]` (or `[tf, t0]` for reverse). Uses 3-stage 5th-order Radau-IIA
// with simplified Newton iteration + complex-eigenvalue split
// (Hairer-Wanner Vol II §IV.8 / 1999 paper); the `radau.ts` substrate
// implements the per-step Newton; this file orchestrates step
// acceptance, Jacobian-staleness signalling, dense-output emission via
// the cubic Hermite-collocation interpolant from HW Vol II eq. IV.8.21,
// and reverse integration.
//
// The algorithmic skeleton mirrors `scipy/integrate/_ivp/radau.py
// ::_step_impl` — same predictor (HW Vol II §IV.8 with two-step
// history), same Jacobian-staleness rule (`recompute_jac = jac is not
// None and n_iter > 2 and rate > 1e-3`), same step-rejection pattern.
//
// Boundary semantics (the tool layer translates these to ADR-0003 tags):
//   * `OdeDegenerateTspanError` — `t0 == tf`.
//   * `OdeNonFiniteError`        — RHS or Jacobian non-finite during integration.
//   * `OdeJacobianSingularError` — LU factorisation hit an exactly
//                                  singular Newton matrix. Records the
//                                  state at which it happened plus the
//                                  Hager 1-norm condition estimate so
//                                  the planner can decide whether to
//                                  add `ε I` regularisation or refactor
//                                  the model.
//
// Status semantics
// ----------------
// `status === "success"` iff every requested `t_eval` point was reached
// and the integration completed up to `tf`. `converged === (status ===
// "success")` is the same hard rule as the path-finder.
//
// Other status values:
//   * `"max_step_exceeded"`    — reserved (currently unused; we honour
//                                max_step by clipping each attempt).
//   * `"tspan_exhausted"`      — step shrunk below the float64 floor
//                                (`|h| < 10·EPS·|t|`) without progress.
//   * `"newton-divergence"`    — Newton failed to converge after
//                                refactoring with a fresh Jacobian and
//                                shrinking `h` repeatedly down to the
//                                floor. The most recently accepted
//                                state is retained.
//
// Why no FSAL bookkeeping
// -----------------------
// Unlike DOPRI5, Radau-IIA(5) is implicit: there is no FSAL identity
// between the new step's first stage f and the old step's last. Each
// accepted step requires (a) the step-start `f0 = f(t_n, y_n)` for the
// error estimator, (b) `3·k_newton` stage f-evaluations, (c) one
// `f_new = f(t_{n+1}, y_{n+1})` so the next step has its `f0`. The
// driver caches `f_new` into `f0` for the next step.

import { type LUResult } from "@workbench/linalg-core";
import {
  C as RADAU_C,
  P_DENSE,
  factorRealNewton,
  factorComplexNewton,
  radauNewton,
  radauNewtonTol,
  radauErrorNorm,
  radauPredictFactor,
  RADAU_MIN_FACTOR,
  RADAU_MAX_FACTOR,
} from "./radau.js";
import {
  OdeDegenerateTspanError,
  OdeNonFiniteError,
} from "./integrate.js";

const EPS = Number.EPSILON;

/** Polyfill for the IEEE-754 next-representable float. Mirrors C's
 *  `nextafter(x, dir)`; JavaScript's `Math` namespace doesn't expose
 *  one. Only used in the SciPy-style `min_step = 10·|ulp(t)|` floor —
 *  any monotonically-correct ulp approximation is sufficient. */
function nextAfter(x: number, towards: number): number {
  if (Number.isNaN(x) || Number.isNaN(towards)) return NaN;
  if (x === towards) return towards;
  if (x === 0) return towards > 0 ? Number.MIN_VALUE : -Number.MIN_VALUE;
  const buf = new Float64Array(1);
  const view = new BigInt64Array(buf.buffer);
  buf[0] = x;
  // Toward +Infinity: increment magnitude for x > 0, decrement for x < 0.
  // Toward -Infinity: opposite.
  const goingUp = towards > x;
  if ((x > 0 && goingUp) || (x < 0 && !goingUp)) {
    view[0] = view[0]! + 1n;
  } else {
    view[0] = view[0]! - 1n;
  }
  return buf[0]!;
}

/** Boundary signal: the implicit linear solve hit an exactly singular
 *  Newton matrix at some `(t, y)`. The driver throws this; the tool
 *  layer translates to `tagged "integrate-ode-stiff/jacobian-singular"`. */
export class OdeJacobianSingularError extends Error {
  readonly atT: number;
  readonly atY: Float64Array;
  /** Hager 1-norm condition estimate at the singular point (or +Inf
   *  if the LU returned null and Hager wasn't applied). */
  readonly conditionNumber: number;
  constructor(atT: number, atY: Float64Array, conditionNumber: number) {
    super(`OdeJacobianSingularError: Newton matrix singular at t=${atT}`);
    this.name = "OdeJacobianSingularError";
    this.atT = atT;
    this.atY = atY;
    this.conditionNumber = conditionNumber;
  }
}

export interface IntegrateStiffOptions {
  /** Relative tolerance per component. Default 1e-3. */
  readonly rtol?: number;
  /** Absolute tolerance per component. Default 1e-6. */
  readonly atol?: number;
  /** Optional cap on absolute step size. */
  readonly maxStep?: number;
  /** Output time grid (sorted in the direction of integration). When
   *  undefined we emit `[t0, tf]`. */
  readonly tEval?: readonly number[];
  /** Analytic Jacobian function `(t, y, Jout)`. When omitted, the
   *  driver uses a centred-finite-difference approximation. */
  readonly jacobian?: (t: number, y: Float64Array, Jout: Float64Array) => void;
  /** Hook so the driver can report f-evaluations from inside the FD
   *  Jacobian back into n_evals. */
  readonly fdEvalCounter?: { value: number };
}

export interface IntegrateStiffResult {
  /** Trajectory: `t_values.length × n_components` row-major. */
  readonly trajectory: Float64Array[];
  /** Output time grid. Equal to `tEval` if provided, else `[t0, tf]`. */
  readonly tValues: Float64Array;
  /** Last accepted step's local error norm (1-normalised). */
  readonly errorEstimate: number;
  /** Total `f` evaluations. */
  readonly nEvals: number;
  readonly nStepsAccepted: number;
  readonly nStepsRejected: number;
  readonly nJacobianEvals: number;
  readonly nLUDecompositions: number;
  readonly status:
    | "success"
    | "max_step_exceeded"
    | "tspan_exhausted"
    | "newton-divergence";
}

/**
 * Adaptive Radau-IIA(5) integration of `dy/dt = f(t, y)` over `[t0, tf]`.
 *
 * Returns trajectory rows for every `tEval` point (default `[t0, tf]`).
 * For sub-step `tEval` points, the cubic Hermite-collocation continuous
 * extension (`P_DENSE` coefficients from `radau.ts`) is evaluated against
 * the most-recently-accepted step.
 */
export function integrateStiff(
  f: (t: number, y: Float64Array, out: Float64Array) => void,
  t0: number,
  tf: number,
  y0: Float64Array,
  options: IntegrateStiffOptions = {},
): IntegrateStiffResult {
  const rtol = options.rtol ?? 1e-3;
  const atol = options.atol ?? 1e-6;
  const maxStep = options.maxStep;
  const userJacobian = options.jacobian;
  const fdCounter = options.fdEvalCounter;
  const n = y0.length;

  if (t0 === tf) {
    throw new OdeDegenerateTspanError(t0, tf);
  }

  const direction = tf > t0 ? 1 : -1;

  // Output grid.
  const tValuesArr: number[] = options.tEval !== undefined
    ? Array.from(options.tEval)
    : [t0, tf];
  const m = tValuesArr.length;

  const trajectory: Float64Array[] = new Array(m);
  for (let i = 0; i < m; i++) trajectory[i] = new Float64Array(n);

  // Working buffers.
  const J = new Float64Array(n * n);
  const Z = new Float64Array(3 * n);
  const Zpred = new Float64Array(3 * n); // initial guess from previous step's interpolant
  const Fstages = new Float64Array(3 * n);
  const f0 = new Float64Array(n);
  const f0New = new Float64Array(n);
  const yNew = new Float64Array(n);
  const ZSnap = new Float64Array(3 * n); // snapshot for dense interpolation
  const ySnap = new Float64Array(n);
  const QSnap = new Float64Array(n * 3); // dense interpolant Q matrix (n × 3)

  // Integrator state.
  let t = t0;
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) y[i] = y0[i]!;

  let nEvals = 0;
  let nStepsAccepted = 0;
  let nStepsRejected = 0;
  let nJacobianEvals = 0;
  let nLUDecompositions = 0;

  // Initial f0 = f(t0, y0).
  f(t, y, f0);
  nEvals += 1;
  for (let i = 0; i < n; i++) {
    if (!Number.isFinite(f0[i]!)) {
      const kind: "NaN" | "Infinity" | "-Infinity" =
        Number.isNaN(f0[i]!) ? "NaN" : f0[i]! > 0 ? "Infinity" : "-Infinity";
      throw new OdeNonFiniteError(t, new Float64Array(y), kind);
    }
  }

  // Initial Jacobian.
  evaluateJacobian(t, y, J, n, userJacobian, f, fdCounter);
  nJacobianEvals += 1;
  if (fdCounter !== undefined) {
    nEvals += fdCounter.value;
    fdCounter.value = 0;
  }
  let currentJac = true; // J was just computed at (t, y)

  // Initial step size (HW Vol II §II.4 starting-step heuristic).
  // The Radau-IIA order for step-size selection is 3 (per SciPy's
  // `select_initial_step` call which uses `error_estimator_order=3`
  // for Radau).
  let hAbs = selectInitialStepStiff(f, t, y, f0, rtol, atol, direction);
  nEvals += 1; // probe call inside selectInitialStepStiff
  if (maxStep !== undefined && hAbs > maxStep) hAbs = maxStep;
  // SciPy's min step floor:
  const tNext = direction === 1 ? nextAfter(t, Infinity) : nextAfter(t, -Infinity);
  let minStep = 10 * Math.abs(tNext - t);
  if (hAbs < minStep) hAbs = minStep;

  let hAbsOld: number | undefined = undefined;
  let errorNormOld: number | undefined = undefined;

  let LUreal: LUResult | null = null;
  let LUcomplex: LUResult | null = null;
  let lastH: number | undefined = undefined; // h at which LUs were factored

  let status: IntegrateStiffResult["status"] = "success";
  let lastErrNorm = 0;

  // The previous-step interpolant (ySnap, QSnap, hSnap, tSnap) seeds
  // the initial-Z prediction for the next step (SciPy: `Z0 = sol(t +
  // h*C).T - y`). Until a step has been accepted, we seed with zero.
  let havePrevStep = false;
  let tStep = t0;
  let hStep = 0;

  const newtonTol = radauNewtonTol(rtol);

  // Index into tValuesArr: the next un-emitted output time.
  let nextOut = 0;

  // Emit any output points equal to t0.
  while (
    nextOut < m &&
    Math.abs(tValuesArr[nextOut]! - t0) <= 1e-12 * Math.max(Math.abs(t0), 1)
  ) {
    const row = trajectory[nextOut]!;
    for (let i = 0; i < n; i++) row[i] = y[i]!;
    tValuesArr[nextOut] = t0;
    nextOut += 1;
  }

  // Main step loop.
  outer: while (nextOut < m) {
    // Termination guard.
    if (direction * (t - tf) >= 0) break;

    // Update minStep at current t (it depends on |t|).
    const tNextHere = direction === 1
      ? nextAfter(t, Infinity)
      : nextAfter(t, -Infinity);
    minStep = 10 * Math.abs(tNextHere - t);

    // Cap hAbs at maxStep if specified.
    if (maxStep !== undefined && hAbs > maxStep) {
      hAbs = maxStep;
      hAbsOld = undefined;
      errorNormOld = undefined;
    }
    // Floor hAbs at minStep.
    if (hAbs < minStep) {
      hAbs = minStep;
      hAbsOld = undefined;
      errorNormOld = undefined;
    }

    let rejected = false;
    let stepAccepted = false;
    let errNormThisStep = 0;
    let hThisStep = 0;
    let nIterThisStep = 0;
    let rateThisStep: number | undefined = undefined;

    while (!stepAccepted) {
      // If hAbs has shrunk below floor, give up.
      if (hAbs < minStep) {
        status = "tspan_exhausted";
        break outer;
      }

      let h = direction * hAbs;
      let tNewProposed = t + h;
      // Clip to tf.
      if (direction * (tNewProposed - tf) > 0) {
        tNewProposed = tf;
      }
      h = tNewProposed - t;
      hAbs = Math.abs(h);

      // Initial Z guess: from previous step's interpolant if available,
      // else zero.
      if (havePrevStep) {
        // Z0[s] = interpolant(t + h·C[s]) - y. Interpolant: y_old +
        // QSnap @ [θ, θ², θ³] where θ = (t_eval - tStep)/hStep.
        for (let s = 0; s < 3; s++) {
          const tEvalStage = t + h * RADAU_C[s]!;
          const theta = (tEvalStage - tStep) / hStep;
          const t1 = theta;
          const t2 = theta * theta;
          const t3 = t2 * theta;
          for (let i = 0; i < n; i++) {
            const interp = ySnap[i]! +
              QSnap[i * 3 + 0]! * t1 +
              QSnap[i * 3 + 1]! * t2 +
              QSnap[i * 3 + 2]! * t3;
            Zpred[s * n + i] = interp - y[i]!;
          }
        }
      } else {
        for (let i = 0; i < 3 * n; i++) Zpred[i] = 0;
      }

      // Build / refactor LUs if h has changed or we don't have one.
      if (LUreal === null || LUcomplex === null || lastH !== h) {
        LUreal = factorRealNewton(J, n, h);
        LUcomplex = factorComplexNewton(J, n, h);
        nLUDecompositions += 2;
        lastH = h;
        if (LUreal === null || LUcomplex === null) {
          // Singular Newton matrix at (t, y). Tag — the planner can
          // then refactor the model or regularise.
          throw new OdeJacobianSingularError(t, new Float64Array(y), Infinity);
        }
      }

      // Build per-component scale `s = atol + rtol·|y|`.
      const scale = new Float64Array(n);
      for (let i = 0; i < n; i++) scale[i] = atol + rtol * Math.abs(y[i]!);

      // Newton iteration.
      const newton = radauNewton(
        f, t, y, h, Zpred, newtonTol,
        LUreal, LUcomplex, scale, Z, Fstages,
      );
      // SciPy charges `n_iter * 3` stage evaluations to nfev.
      nEvals += newton.nIter * 3;

      if (!newton.converged) {
        // Newton failed. Two cases (SciPy logic):
        //   - currentJac == false: refactor with fresh J and retry at
        //     same h.
        //   - currentJac == true: shrink h by 0.5 and retry (refactor LU
        //     because h changed).
        if (!currentJac) {
          evaluateJacobian(t, y, J, n, userJacobian, f, fdCounter);
          nJacobianEvals += 1;
          if (fdCounter !== undefined) {
            nEvals += fdCounter.value;
            fdCounter.value = 0;
          }
          currentJac = true;
          LUreal = null;
          LUcomplex = null;
          continue; // refactor on next inner-loop pass
        }
        // currentJac was true → shrink h.
        hAbs *= 0.5;
        LUreal = null;
        LUcomplex = null;
        // hAbs may have dropped below minStep — outer-loop floor catches.
        if (hAbs < minStep) {
          status = "newton-divergence";
          break outer;
        }
        continue;
      }

      // Newton converged — compute yNew = y + Z[2].
      for (let i = 0; i < n; i++) yNew[i] = y[i]! + Z[2 * n + i]!;

      // Local error estimate.
      const errInfo = radauErrorNorm(
        f0, Z, y, yNew, h, LUreal, rtol, atol,
        rejected, f, t,
      );
      let errNorm = errInfo.errNorm;
      nEvals += errInfo.nFevDelta;

      // Safety factor decreases as Newton iter count rises (HW Vol II §IV.8).
      const safety = 0.9 * (2 * 6 + 1) / (2 * 6 + newton.nIter);

      if (errNorm > 1) {
        // Reject.
        const factor = radauPredictFactor(hAbs, hAbsOld, errNorm, errorNormOld);
        hAbs *= Math.max(RADAU_MIN_FACTOR, safety * factor);
        LUreal = null;
        LUcomplex = null;
        rejected = true;
        nStepsRejected += 1;
      } else {
        // Accept.
        stepAccepted = true;
        errNormThisStep = errNorm;
        hThisStep = h;
        nIterThisStep = newton.nIter;
        rateThisStep = newton.rate;
      }
    }

    // Step accepted. Compute the step's interpolant for sub-step
    // dense output, advance state, and decide what to do with the
    // Jacobian / LU for the next step.

    // Dense interpolant: Q = Z.T · P  (n × 3).
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < 3; j++) {
        QSnap[i * 3 + j] =
          Z[0 * n + i]! * P_DENSE[0]![j]! +
          Z[1 * n + i]! * P_DENSE[1]![j]! +
          Z[2 * n + i]! * P_DENSE[2]![j]!;
      }
    }
    // Snapshot of (yStep, hStep, tStep) for dense interpolation reads.
    for (let i = 0; i < n; i++) ySnap[i] = y[i]!;
    for (let i = 0; i < 3 * n; i++) ZSnap[i] = Z[i]!;
    void ZSnap; // (kept for potential introspection; the Q + ySnap +
                //  hSnap triple is what the dense extension actually reads.)
    tStep = t;
    hStep = hThisStep;
    havePrevStep = true;

    nStepsAccepted += 1;
    lastErrNorm = errNormThisStep;

    // Advance state.
    const tNew = t + hThisStep;
    for (let i = 0; i < n; i++) y[i] = yNew[i]!;
    t = tNew;

    // Compute f_new = f(t_new, y_new) for the next step's f0 *and*
    // for the next-step error estimator.
    f(t, y, f0New);
    nEvals += 1;
    for (let i = 0; i < n; i++) {
      if (!Number.isFinite(f0New[i]!)) {
        const kind: "NaN" | "Infinity" | "-Infinity" =
          Number.isNaN(f0New[i]!) ? "NaN" : f0New[i]! > 0 ? "Infinity" : "-Infinity";
        throw new OdeNonFiniteError(t, new Float64Array(y), kind);
      }
    }

    // Emit output rows in (tStep, t].
    while (nextOut < m) {
      const tOut = tValuesArr[nextOut]!;
      const tol = 1e-12 * Math.max(Math.abs(tStep), Math.abs(t), 1);
      const afterStart = direction * (tOut - tStep) > tol;
      const beforeOrAtEnd = direction * (t - tOut) >= -tol;
      if (afterStart && beforeOrAtEnd) {
        const theta = (tOut - tStep) / hThisStep;
        if (theta >= 1 - tol / Math.max(Math.abs(hThisStep), 1)) {
          const row = trajectory[nextOut]!;
          for (let i = 0; i < n; i++) row[i] = y[i]!;
        } else {
          const row = trajectory[nextOut]!;
          const t1 = theta;
          const t2 = theta * theta;
          const t3 = t2 * theta;
          for (let i = 0; i < n; i++) {
            row[i] = ySnap[i]! +
              QSnap[i * 3 + 0]! * t1 +
              QSnap[i * 3 + 1]! * t2 +
              QSnap[i * 3 + 2]! * t3;
          }
        }
        tValuesArr[nextOut] = tOut;
        nextOut += 1;
      } else {
        break;
      }
    }

    // Step-size predictor for next step.
    const factor = radauPredictFactor(hAbs, hAbsOld, errNormThisStep, errorNormOld);
    const safety = 0.9 * (2 * 6 + 1) / (2 * 6 + nIterThisStep);
    let nextFactor = Math.min(RADAU_MAX_FACTOR, safety * factor);

    // Jacobian-staleness logic (SciPy):
    //   recompute_jac = jac is not None and n_iter > 2 and rate > 1e-3
    // We apply the same rule when an analytic Jacobian is supplied; for
    // FD Jacobians we apply the same rule too — the overhead of a
    // FD-Jacobian recompute is `2n` f-evals which is benign on the
    // problem sizes we're targeting (n ≤ 40 for the bench).
    const rate = rateThisStep ?? 0;
    const recomputeJac = nIterThisStep > 2 && rate > 1e-3;

    if (!recomputeJac && nextFactor < 1.2) {
      // SciPy: keep h at current value and reuse the LU.
      nextFactor = 1;
    } else {
      // Step size will change; force LU refactor next iteration.
      LUreal = null;
      LUcomplex = null;
    }

    if (recomputeJac) {
      evaluateJacobian(t, y, J, n, userJacobian, f, fdCounter);
      nJacobianEvals += 1;
      if (fdCounter !== undefined) {
        nEvals += fdCounter.value;
        fdCounter.value = 0;
      }
      currentJac = true;
    } else if (userJacobian !== undefined) {
      // Reuse the J we have; mark it as "not freshly computed at the
      // new state" so a Newton fail next step triggers a recompute.
      currentJac = false;
    } else {
      // FD Jacobian path — also stale.
      currentJac = false;
    }

    // Carry next f0 = f_new.
    for (let i = 0; i < n; i++) f0[i] = f0New[i]!;

    // Update controller history *before* updating hAbs.
    hAbsOld = hAbs;
    errorNormOld = errNormThisStep;
    hAbs *= nextFactor;
    // Honour maxStep.
    if (maxStep !== undefined && hAbs > maxStep) hAbs = maxStep;

    if (direction * (t - tf) >= 0 && nextOut >= m) break;
  }

  // After loop: any remaining output points (only on
  // tspan_exhausted/newton-divergence paths) get the last-accepted state.
  while (nextOut < m) {
    const tOut = tValuesArr[nextOut]!;
    const row = trajectory[nextOut]!;
    if (havePrevStep) {
      const theta = (tOut - tStep) / hStep;
      if (theta >= 0 && theta <= 1) {
        const t1 = theta;
        const t2 = theta * theta;
        const t3 = t2 * theta;
        for (let i = 0; i < n; i++) {
          row[i] = ySnap[i]! +
            QSnap[i * 3 + 0]! * t1 +
            QSnap[i * 3 + 1]! * t2 +
            QSnap[i * 3 + 2]! * t3;
        }
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
    nJacobianEvals,
    nLUDecompositions,
    status,
  };
}

// ---- Helpers ----------------------------------------------------------------

/**
 * Evaluate the Jacobian into `Jout`. Dispatches to the user-supplied
 * analytic Jacobian if present; else falls back to centred-finite-
 * differences. Both paths may throw `OdeNonFiniteError`.
 */
function evaluateJacobian(
  t: number,
  y: Float64Array,
  Jout: Float64Array,
  n: number,
  userJacobian:
    | ((t: number, y: Float64Array, Jout: Float64Array) => void)
    | undefined,
  rhs: (t: number, y: Float64Array, out: Float64Array) => void,
  fdCounter: { value: number } | undefined,
): void {
  if (userJacobian !== undefined) {
    userJacobian(t, y, Jout);
    return;
  }
  // Centred FD inline (avoids importing newton-iteration here to keep
  // the substrate self-contained on the hot path; lambdified analytic
  // Jacobians come in via userJacobian).
  const FD_STEP_BASE = Math.sqrt(EPS);
  const yPlus = new Float64Array(n);
  const yMinus = new Float64Array(n);
  const fPlus = new Float64Array(n);
  const fMinus = new Float64Array(n);
  for (let j = 0; j < n; j++) {
    const yj = y[j]!;
    const hj = FD_STEP_BASE * Math.max(Math.abs(yj), 1);
    for (let i = 0; i < n; i++) yPlus[i] = y[i]!;
    yPlus[j] = yj + hj;
    rhs(t, yPlus, fPlus);
    for (let i = 0; i < n; i++) yMinus[i] = y[i]!;
    yMinus[j] = yj - hj;
    rhs(t, yMinus, fMinus);
    if (fdCounter !== undefined) fdCounter.value += 2;
    const inv2hj = 1 / (2 * hj);
    for (let i = 0; i < n; i++) {
      const v = (fPlus[i]! - fMinus[i]!) * inv2hj;
      if (!Number.isFinite(v)) {
        const kind: "NaN" | "Infinity" | "-Infinity" =
          Number.isNaN(v) ? "NaN" : v > 0 ? "Infinity" : "-Infinity";
        throw new OdeNonFiniteError(t, new Float64Array(y), kind);
      }
      Jout[i * n + j] = v;
    }
  }
}

/**
 * Initial step size for stiff IVP. Same shape as the path-finder's
 * `selectInitialStep` but using `error_estimator_order = 3` (the order
 * used by SciPy's Radau for step-size control).
 */
function selectInitialStepStiff(
  f: (t: number, y: Float64Array, out: Float64Array) => void,
  t0: number,
  y0: Float64Array,
  f0: Float64Array,
  rtol: number,
  atol: number,
  direction: number,
): number {
  const n = y0.length;
  if (n === 0) return 1e-6;

  let sum0 = 0;
  let sum1 = 0;
  for (let i = 0; i < n; i++) {
    const sc = atol + rtol * Math.abs(y0[i]!);
    const r0 = y0[i]! / sc;
    const r1 = f0[i]! / sc;
    sum0 += r0 * r0;
    sum1 += r1 * r1;
  }
  const d0 = Math.sqrt(sum0 / n);
  const d1 = Math.sqrt(sum1 / n);
  const h0 = (d0 < 1e-5 || d1 < 1e-5) ? 1e-6 : 0.01 * d0 / d1;

  const yProbe = new Float64Array(n);
  const fProbe = new Float64Array(n);
  for (let i = 0; i < n; i++) yProbe[i] = y0[i]! + h0 * direction * f0[i]!;
  f(t0 + h0 * direction, yProbe, fProbe);
  let sum2 = 0;
  for (let i = 0; i < n; i++) {
    const sc = atol + rtol * Math.abs(y0[i]!);
    const r = (fProbe[i]! - f0[i]!) / sc;
    sum2 += r * r;
  }
  const d2 = Math.sqrt(sum2 / n) / h0;
  // Order = 3 for Radau step-size selection (HW Vol II §IV.8).
  const ORDER = 3;
  let h1: number;
  if (d1 <= 1e-15 && d2 <= 1e-15) {
    h1 = Math.max(1e-6, h0 * 1e-3);
  } else {
    h1 = Math.pow(0.01 / Math.max(d1, d2), 1 / (ORDER + 1));
  }
  return Math.min(100 * h0, h1);
}
