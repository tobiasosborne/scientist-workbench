// =============================================================================
// pi-controller.ts — Gustafsson PI step-size controller for adaptive RK
// =============================================================================
//
// Intent
// ------
// Step-size controller for Dormand-Prince 5(4) (and structurally
// for any embedded RK pair of order p). Implements the proportional-
// integral (PI) controller of Gustafsson (1991), which observes both
// the current and previous error norms to damp the oscillations the
// classical "I-only" Wat-Karpov controller exhibits on stiff edges.
//
// The textbook law (Gustafsson 1991; HNW Vol I §IV.2 eq. 2.43;
// SciPy `_ivp/rk.py::RK45._step_impl`):
//
//     factor = (1 / err)^α · (err_prev / 1)^β
//            = err^(-α) · err_prev^β
//
// where err and err_prev are *normalised* error norms (1.0 is the
// budget). The next step is `h_new = h · factor`, with safety factor
// 0.9 and clamps to [MIN_FACTOR, MAX_FACTOR].
//
// Equivalent form used in HNW and SciPy:
//   α = 0.7 / p,   β = 0.4 / p     (with p = 5 for DOPRI5).
// → α ≈ 0.14, β ≈ 0.08 for the *exponents on err* / *err_prev*.
//
// The first accepted step has no `err_prev`; the controller falls
// back to the I-only law `factor = err^(-1/p)` with the same safety
// and clamps. SciPy uses 1.0 as the seed `err_prev` which is the same
// thing in the limit; we use the I-only fallback explicitly to make
// the first-step behaviour readable.
//
// Step rejection
// --------------
// When `err > 1`, we *do not* update `err_prev` (the reject mechanism
// uses the same I-only-on-current law). This matches HNW's
// recommendation: a rejected step's err_prev would otherwise leak a
// pre-rejection memory into the next attempt. SciPy implements the
// same discipline.

/** Order of the high-order solution (DOPRI5: 5). */
const ORDER = 5;

/** PI exponents (Gustafsson 1991; HNW Vol I §IV.2 Table 2.1). */
const ALPHA = 0.7 / ORDER;  // 0.14
const BETA = 0.4 / ORDER;   // 0.08

/** Safety factor — multiplicative slack between the "marginally
 *  accept" step size and the actually-taken next step. Standard in
 *  the literature; tuning rarely worth the test churn. */
const SAFETY = 0.9;

/** Minimum factor on a rejected or accepted step (prevents runaway
 *  shrinkage / growth). HNW §IV.2 recommends [0.2, 5]; SciPy uses the
 *  same. */
export const MIN_FACTOR = 0.2;
export const MAX_FACTOR = 10.0;

/**
 * Compute the next step size given the current and previous (1-
 * normalised) error norms. Returns a *positive* multiplicative factor
 * the caller multiplies by `h` (preserving sign for reverse
 * integration).
 *
 *   - `errNorm`     ∈ [0, ∞): the WRMS-style 1-normalised error norm.
 *                              `< 1` accepts; `> 1` rejects.
 *   - `errPrevNorm` ∈ (0, ∞) | undefined: the previous accepted
 *                              step's error norm. Undefined seeds the
 *                              I-only first-step law.
 *
 * `EPS_FLOOR` (= 1e-15) clamps `errNorm` at the bottom: if the user's
 * `f` is exactly the constant zero function (or every component
 * happens to be zero at the budgeted nodes), `errNorm = 0` would blow
 * the factor up. We clamp to `1e-15` so the factor caps at the
 * defined `MAX_FACTOR` without a special case in the caller.
 */
export function nextStepFactor(errNorm: number, errPrevNorm?: number): number {
  const eClamped = Math.max(errNorm, 1e-15);
  let factor: number;
  if (errPrevNorm === undefined || errNorm >= 1) {
    // First step or rejected step: I-only on the current error.
    factor = SAFETY * Math.pow(eClamped, -1 / ORDER);
  } else {
    // PI law. Note errPrev clamped too — a clean run can produce
    // tiny errPrev too (and the β power keeps that benign, but
    // clamping gives byte-stable behaviour).
    const ePrev = Math.max(errPrevNorm, 1e-15);
    factor = SAFETY * Math.pow(eClamped, -ALPHA) * Math.pow(ePrev, BETA);
  }
  if (factor < MIN_FACTOR) factor = MIN_FACTOR;
  if (factor > MAX_FACTOR) factor = MAX_FACTOR;
  return factor;
}

/**
 * Initial step-size heuristic from Hairer-Nørsett-Wanner Vol I §II.4
 * "Starting Step Size", reproduced almost verbatim from SciPy
 * `_ivp/common.py::select_initial_step`.
 *
 * The procedure:
 *
 *   1. Compute scale d = atol + rtol·|y0|, then d0 = ||y0/d||₂_RMS,
 *      d1 = ||f0/d||₂_RMS.
 *   2. If d0 < 1e-5 or d1 < 1e-5, h0 = 1e-6; else h0 = 0.01·d0/d1.
 *   3. Take an Euler step y1 = y0 + h0·f0; compute f1 = f(t0+h0, y1).
 *      d2 = ||(f1 − f0)/d||₂_RMS / h0 (estimate of the second
 *      derivative norm).
 *   4. If max(d1, d2) ≤ 1e-15, h1 = max(1e-6, 1e-3·h0); else
 *      h1 = (0.01/max(d1, d2))^(1/(p+1)).
 *   5. Return h_init = min(100·h0, h1) (sign applied externally).
 *
 * Returned value is *unsigned*; the driver multiplies by ±1 to set
 * direction. The procedure spends two `f` evaluations (one for `f0`,
 * one for `f1`); the caller charges these to `n_evals`.
 */
export function selectInitialStep(
  f: (t: number, y: Float64Array, out: Float64Array) => void,
  t0: number,
  y0: Float64Array,
  f0: Float64Array,
  rtol: number,
  atol: number,
  direction: number,
): number {
  const n = y0.length;
  if (n === 0) return 1e-6; // pathological; the driver should already have refused.

  // d0 = sqrt((1/n) Σ (y0_i / d_i)²),  d_i = atol + rtol|y0_i|
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

  let h0: number;
  if (d0 < 1e-5 || d1 < 1e-5) {
    h0 = 1e-6;
  } else {
    h0 = 0.01 * d0 / d1;
  }

  // Tentative Euler probe.
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

  let h1: number;
  if (d1 <= 1e-15 && d2 <= 1e-15) {
    h1 = Math.max(1e-6, h0 * 1e-3);
  } else {
    h1 = Math.pow(0.01 / Math.max(d1, d2), 1 / (ORDER + 1));
  }

  return Math.min(100 * h0, h1);
}
