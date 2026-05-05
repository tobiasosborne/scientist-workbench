// =============================================================================
// radau.ts — Radau-IIA(5) Butcher tableau + simplified-Newton iteration
// =============================================================================
//
// Intent
// ------
// Single-step routine for the 3-stage 5th-order Radau-IIA implicit
// Runge-Kutta method. The textbook reference is Hairer-Wanner Vol II
// §IV.8 (collocation derivation, A-stability, L-stability, stiffly-
// accurate property); §IV.10 (implementation); the *companion paper*
// Hairer-Wanner 1999 (J. Comput. Appl. Math. 111, 93-111) is the
// reference for the simplified-Newton iteration with complex-eigenvalue
// transformation that this file implements.
//
// Why Radau-IIA(5)
// ----------------
// The canonical "implicit RK for stiff IVP" choice. A-stable, L-stable
// (so it damps high-frequency stiff modes), 5th-order (so we get
// sensible accuracy without going to BDF's order-selection logic),
// stiffly-accurate (so the global error on stiff problems is bounded
// independent of the horizon — HW Vol II §IV.10). This is the algorithm
// behind `scipy.integrate.solve_ivp(method='Radau')`.
//
// Butcher tableau and constants
// -----------------------------
// `C`  = stage abscissae (length 3); `T, TI` = real/complex eigenbasis
// transformation matrices that diagonalise A⁻¹ = T · diag(γ, μ, μ̄) · T⁻¹;
// `MU_REAL = γ`, `MU_COMPLEX = μ` (one complex pair, conjugate of the
// other so we solve only the real and one complex system per Newton
// iteration); `E` = embedded-estimator weights; `P` = dense-output
// (cubic Hermite-collocation) coefficients.
//
// Constants are reproduced verbatim from `scipy/integrate/_ivp/radau.py`
// (the canonical reference implementation; cross-checked against
// HW Vol II Table 5.6). Closed-form expressions are used where the
// rational/algebraic form is simpler than the literal; pure literals
// are preserved when SciPy ships them as such.
//
// Simplified-Newton with complex-eigenvalue transformation
// --------------------------------------------------------
// The implicit stage equation is
//
//     Z_i = h · Σ_{j=1}^{3} a_{ij} · f(t_n + c_j h, y_n + Z_j),     i = 1..3
//
// Linearising around (t_n, y_n) with J = ∂f/∂y(t_n, y_n) gives the
// (3n × 3n) Newton matrix `(h·A)⁻¹ ⊗ I − I ⊗ J`, which factors via the
// eigendecomposition of A⁻¹:
//
//     A⁻¹ = T · diag(γ, μ, μ̄) · T⁻¹
//
// In coordinates W = (T⁻¹ ⊗ I_n) Z, the (3n × 3n) system block-
// diagonalises into one real `n × n` system and one complex `n × n`
// system (the third block is the conjugate of the second; trivially
// solved by conjugation).
//
//     ((γ/h) I − J) · ΔW₀ = (TIᵣ · F).T − γ/h · W₀
//     ((μ/h) I − J) · ΔW_c = (TI_c · F).T − μ/h · (W₁ + i W₂)
//
// Per Newton iteration cost: one real `n × n` LU+solve, one complex
// `n × n` LU+solve. Inlining a 3n × 3n solve would be `27 ×` more work.
//
// The implementation embeds the complex `n × n` solve as a real
// `2n × 2n` block solve, since `@workbench/linalg-core`'s `lu` /
// `luSolve` take real Float64Array data. This is the standard
// "stack real and imaginary parts" trick. The factorised LU is reused
// across multiple Newton iterations within the same step, and across
// multiple steps when h doesn't change.
//
// Newton convergence test
// -----------------------
// Following HW Vol II §IV.8 / SciPy: track WRMS norm `|ΔW^{(k)}|` and
// the rate `θ = |ΔW^{(k)}| / |ΔW^{(k-1)}|`. Accept when `θ/(1-θ) ·
// |ΔW^{(k)}| < tol`. Diverge when `θ ≥ 1` or after `NEWTON_MAXITER`
// (= 6) iterations. On divergence the driver shrinks `h`, refactors,
// and retries.

import { type Matrix, matrixFromRows, lu, luSolve, type LUResult } from "@workbench/linalg-core";

// ---- Butcher tableau --------------------------------------------------------

const SQ6 = Math.sqrt(6);

/** Radau-IIA(5) abscissae c. */
export const C: readonly [number, number, number] = [
  (4 - SQ6) / 10,
  (4 + SQ6) / 10,
  1,
];

/** Embedded-estimator weights `E` (HW Vol II §IV.8.20; SciPy `_radau.py`).
 *  Layout: a length-3 vector applied to the three stage values. The
 *  full local-error formula is `error = LU_real \ (h·γ·E·F.T + γ·Z[2])`
 *  — see `radauErrorNorm` below. */
export const E: readonly [number, number, number] = [
  (-13 - 7 * SQ6) / 3,
  (-13 + 7 * SQ6) / 3,
  -1 / 3,
];

/** Real eigenvalue γ of A⁻¹.
 *  Closed-form: `3 + 3^(2/3) − 3^(1/3)`. */
export const MU_REAL = 3 + Math.pow(3, 2 / 3) - Math.pow(3, 1 / 3);

/** Complex eigenvalue μ = α + iβ of A⁻¹.
 *  Closed-form: `(3 + (3^(1/3) − 3^(2/3))/2) + i·(−(3^(5/6) + 3^(7/6))/2)`.
 *  Note SciPy ships this as a single Python complex; we split into real
 *  and imaginary parts for real-arithmetic embedding. */
export const MU_COMPLEX_REAL =
  3 + 0.5 * (Math.pow(3, 1 / 3) - Math.pow(3, 2 / 3));
export const MU_COMPLEX_IMAG =
  -0.5 * (Math.pow(3, 5 / 6) + Math.pow(3, 7 / 6));

/** Transformation matrix T (real form). Row-major 3×3. Column 0 of T
 *  corresponds to the real eigenvalue γ; columns 1 and 2 are the real
 *  and imaginary parts of the complex eigenvector pair. */
const T_MAT: readonly (readonly number[])[] = [
  [0.09443876248897524, -0.14125529502095421, 0.03002919410514742],
  [0.25021312296533332, 0.20412935229379994, -0.38294211275726192],
  [1, 1, 0],
];

/** T⁻¹. Row-major 3×3. */
const TI_MAT: readonly (readonly number[])[] = [
  [4.17871859155190428, 0.32768282076106237, 0.52337644549944951],
  [-4.17871859155190428, -0.32768282076106237, 0.47662355450055044],
  [0.50287263494578682, -2.57192694985560522, 0.59603920482822492],
];

/** Dense-output coefficients P (HW Vol II eq. IV.8.21; SciPy `_radau.py`).
 *  Row-major 3×3. The interpolant on `[t_n, t_n + h]` is built as
 *  `Q = Z.T @ P` (n × 3) and evaluated as `y(θ) = y_n + Q · [θ, θ², θ³]`. */
export const P_DENSE: readonly (readonly number[])[] = [
  [13 / 3 + 7 * SQ6 / 3, -23 / 3 - 22 * SQ6 / 3, 10 / 3 + 5 * SQ6],
  [13 / 3 - 7 * SQ6 / 3, -23 / 3 + 22 * SQ6 / 3, 10 / 3 - 5 * SQ6],
  [1 / 3, -8 / 3, 10 / 3],
];

// ---- Newton iteration constants ---------------------------------------------

/** Maximum simplified-Newton iterations per step attempt. SciPy uses 6. */
export const NEWTON_MAXITER = 6;

/** Step-size minimum factor (rejection cap). Matches SciPy. */
export const RADAU_MIN_FACTOR = 0.2;
/** Step-size maximum factor (acceptance cap). Matches SciPy. */
export const RADAU_MAX_FACTOR = 10;

/** Newton tolerance, parameterised on rtol per SciPy:
 *  `newton_tol = max(10·EPS/rtol, min(0.03, rtol^0.5))`. */
export function radauNewtonTol(rtol: number): number {
  const EPS = Number.EPSILON;
  return Math.max(10 * EPS / rtol, Math.min(0.03, Math.sqrt(rtol)));
}

// ---- Public types -----------------------------------------------------------

/** Outcome of one simplified-Newton call. */
export interface RadauNewtonResult {
  readonly converged: boolean;
  readonly nIter: number;
  /** Last-iteration WRMS rate θ = |ΔW_k| / |ΔW_{k-1}|. `undefined` on
   *  the first iteration (no rate available yet). NaN if `Newton`
   *  bailed at iteration 0. */
  readonly rate: number | undefined;
}

// ---- LU factorisation helpers -----------------------------------------------

/**
 * Build `(γ/h) I − J` and factor. Returns `null` iff exactly singular
 * (rare; the driver tags `jacobian-singular`).
 */
export function factorRealNewton(
  J: Float64Array,
  n: number,
  h: number,
): LUResult | null {
  const muOverH = MU_REAL / h;
  const rows: number[][] = new Array<number[]>(n);
  for (let i = 0; i < n; i++) {
    const row = new Array<number>(n);
    for (let j = 0; j < n; j++) row[j] = -J[i * n + j]!;
    row[i] = row[i]! + muOverH;
    rows[i] = row;
  }
  const M: Matrix = matrixFromRows(rows);
  return lu(M);
}

/**
 * Build the real `2n × 2n` embedding of the complex `(μ/h) I − J`
 * Newton matrix and factor it.
 *
 * The complex matrix `M = (α/h + i β/h) I − J` acting on `z = z_re + i z_im`
 * is equivalent to the real `2n × 2n` matrix
 *
 *     | α/h I − J         −β/h I       |
 *     | β/h I              α/h I − J  |
 *
 * acting on the stacked vector `(z_re; z_im)`. We always have
 * `MU_COMPLEX_IMAG < 0`, so β = MU_COMPLEX_IMAG / h has a sign
 * matching `h`'s; the matrix is exactly singular iff `(α/h)² + (β/h)²`
 * is an eigenvalue of `J Jᵀ`, which is again rare.
 */
export function factorComplexNewton(
  J: Float64Array,
  n: number,
  h: number,
): LUResult | null {
  const alpha = MU_COMPLEX_REAL / h;
  const beta = MU_COMPLEX_IMAG / h;
  const m = 2 * n;
  const rows: number[][] = new Array<number[]>(m);
  for (let i = 0; i < m; i++) rows[i] = new Array<number>(m).fill(0);
  // Top-left block: αI − J
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) rows[i]![j] = -J[i * n + j]!;
    rows[i]![i] = rows[i]![i]! + alpha;
  }
  // Bottom-right block: αI − J
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) rows[n + i]![n + j] = -J[i * n + j]!;
    rows[n + i]![n + i] = rows[n + i]![n + i]! + alpha;
  }
  // Top-right block: −β I
  for (let i = 0; i < n; i++) rows[i]![n + i] = -beta;
  // Bottom-left block: +β I
  for (let i = 0; i < n; i++) rows[n + i]![i] = beta;
  const M: Matrix = matrixFromRows(rows);
  return lu(M);
}

/** Solve `(γ/h) I − J) x = b` using a precomputed LU. Returns x. */
export function solveReal(
  luRes: LUResult,
  b: Float64Array,
): Float64Array {
  return luSolve(luRes, b);
}

/**
 * Solve the complex `(μ/h) I − J) (x_re + i x_im) = b_re + i b_im`
 * via the embedded `2n × 2n` real LU. Allocates and returns
 * `{re, im}` arrays of length `n`.
 */
export function solveComplex(
  luRes: LUResult,
  bRe: Float64Array,
  bIm: Float64Array,
): { re: Float64Array; im: Float64Array } {
  const n = bRe.length;
  const stacked = new Float64Array(2 * n);
  for (let i = 0; i < n; i++) {
    stacked[i] = bRe[i]!;
    stacked[n + i] = bIm[i]!;
  }
  const x = luSolve(luRes, stacked);
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    re[i] = x[i]!;
    im[i] = x[n + i]!;
  }
  return { re, im };
}

// ---- Simplified-Newton iteration --------------------------------------------

/**
 * Run the simplified-Newton iteration for one Radau-IIA(5) step.
 *
 * Direct port of SciPy `_radau.py::solve_collocation_system`.
 *
 * Inputs:
 *   `f`       — RHS function `(t, y, out) => void`.
 *   `t`       — current time
 *   `y`       — current state (length n)
 *   `h`       — signed step size
 *   `Zinit`   — initial-guess stage increments. Layout: row-major
 *               (3 × n), `Z[s*n + i]` is component `i` of stage `s`.
 *   `tol`     — Newton tolerance (use `radauNewtonTol(rtol)`).
 *   `luReal`  — precomputed LU of `(γ/h) I − J`.
 *   `luCplx`  — precomputed LU of the embedded real `2n × 2n`.
 *   `scale`   — per-component WRMS scale `atol + rtol·|y|` (length n).
 *
 * Outputs (caller-allocated):
 *   `Zout`    — converged stage increments (3·n).
 *   `Fout`    — final stage f-values f(t + c_s·h, y + Z_s) (3·n).
 *
 * Returns the convergence flag, iteration count, and final rate `θ`.
 * The driver feeds these into the step-acceptance + Jacobian-staleness
 * logic.
 *
 * On non-converge, `Zout` carries the *last attempted* stage state
 * (informational; the driver discards it and retries with a refactored
 * Jacobian or a smaller step).
 */
export function radauNewton(
  f: (t: number, y: Float64Array, out: Float64Array) => void,
  t: number,
  y: Float64Array,
  h: number,
  Zinit: Float64Array,
  tol: number,
  luReal: LUResult,
  luCplx: LUResult,
  scale: Float64Array,
  Zout: Float64Array,
  Fout: Float64Array,
): RadauNewtonResult {
  const n = y.length;

  // Working buffers.
  const Z = new Float64Array(3 * n);
  for (let i = 0; i < 3 * n; i++) Z[i] = Zinit[i]!;
  const W = new Float64Array(3 * n);
  applyTI(Z, W, n);

  const yStage = new Float64Array(n);
  const F = new Float64Array(3 * n); // F[s*n + i] = f_i(t + c_s h, y + Z_s)

  // Linear combinations of stage F values:
  //   FT_real    = Σ_s TI[0][s] · F[s]    (length n)
  //   FT_cpx_re  = Σ_s TI[1][s] · F[s]    (length n)
  //   FT_cpx_im  = Σ_s TI[2][s] · F[s]    (length n)
  // (Note: SciPy uses `TI_REAL = TI[0]` and `TI_COMPLEX = TI[1] + 1j·TI[2]`.
  //  The complex linear combination over real F equals re/im split as
  //  shown.)
  const FTreal = new Float64Array(n);
  const FTcpxRe = new Float64Array(n);
  const FTcpxIm = new Float64Array(n);

  let dWnormOld: number | undefined = undefined;
  let rate: number | undefined = undefined;
  let nIter = 0;

  for (let k = 0; k < NEWTON_MAXITER; k++) {
    nIter = k + 1;

    // Stage F values.
    for (let s = 0; s < 3; s++) {
      for (let i = 0; i < n; i++) yStage[i] = y[i]! + Z[s * n + i]!;
      const out = F.subarray(s * n, (s + 1) * n);
      f(t + C[s]! * h, yStage, out);
    }
    // Bail if any non-finite F.
    for (let i = 0; i < 3 * n; i++) {
      if (!Number.isFinite(F[i]!)) {
        // Non-finite stage f; non-converged. The driver translates the
        // step-shrink path; if the controller already shrank to floor
        // the driver eventually emits a non-finite-during-eval boundary.
        for (let j = 0; j < 3 * n; j++) Zout[j] = Z[j]!;
        for (let j = 0; j < 3 * n; j++) Fout[j] = F[j]!;
        return { converged: false, nIter, rate };
      }
    }

    // Linear combinations.
    for (let i = 0; i < n; i++) {
      FTreal[i] =
        TI_MAT[0]![0]! * F[0 * n + i]! +
        TI_MAT[0]![1]! * F[1 * n + i]! +
        TI_MAT[0]![2]! * F[2 * n + i]!;
      FTcpxRe[i] =
        TI_MAT[1]![0]! * F[0 * n + i]! +
        TI_MAT[1]![1]! * F[1 * n + i]! +
        TI_MAT[1]![2]! * F[2 * n + i]!;
      FTcpxIm[i] =
        TI_MAT[2]![0]! * F[0 * n + i]! +
        TI_MAT[2]![1]! * F[1 * n + i]! +
        TI_MAT[2]![2]! * F[2 * n + i]!;
    }

    // RHS for real system: f_real = FTreal - M_real · W[0],
    //   where M_real = MU_REAL / h.
    const MR = MU_REAL / h;
    const MC_RE = MU_COMPLEX_REAL / h;
    const MC_IM = MU_COMPLEX_IMAG / h;

    const fReal = new Float64Array(n);
    for (let i = 0; i < n; i++) fReal[i] = FTreal[i]! - MR * W[0 * n + i]!;

    // RHS for complex system: f_complex = FTcpxRe + i·FTcpxIm − M_complex · (W[1] + i W[2]).
    // Real part:  FTcpxRe − (MC_RE · W[1] − MC_IM · W[2])
    // Imag part:  FTcpxIm − (MC_IM · W[1] + MC_RE · W[2])
    const fCpxRe = new Float64Array(n);
    const fCpxIm = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const w1 = W[1 * n + i]!;
      const w2 = W[2 * n + i]!;
      fCpxRe[i] = FTcpxRe[i]! - (MC_RE * w1 - MC_IM * w2);
      fCpxIm[i] = FTcpxIm[i]! - (MC_IM * w1 + MC_RE * w2);
    }

    // Solve.
    const dW0 = solveReal(luReal, fReal);
    const dWcpx = solveComplex(luCplx, fCpxRe, fCpxIm);

    // WRMS norm of the stacked dW = (dW0, dWcpx.re, dWcpx.im).
    let sumSq = 0;
    for (let i = 0; i < n; i++) {
      const sc = scale[i]!;
      const a = dW0[i]! / sc;
      const b = dWcpx.re[i]! / sc;
      const c = dWcpx.im[i]! / sc;
      sumSq += a * a + b * b + c * c;
    }
    const dWnorm = Math.sqrt(sumSq / (3 * n));

    if (dWnormOld !== undefined) {
      rate = dWnorm / Math.max(dWnormOld, 1e-300);
    }

    // Divergence checks (SciPy's exact form):
    //   if rate is not None and (rate >= 1 or
    //       rate ** (NEWTON_MAXITER - k) / (1 - rate) * dWnorm > tol):
    //     break
    if (rate !== undefined) {
      if (rate >= 1) {
        for (let i = 0; i < 3 * n; i++) Zout[i] = Z[i]!;
        for (let i = 0; i < 3 * n; i++) Fout[i] = F[i]!;
        return { converged: false, nIter, rate };
      }
      const projection = Math.pow(rate, NEWTON_MAXITER - k) / Math.max(1 - rate, 1e-30) * dWnorm;
      if (projection > tol) {
        for (let i = 0; i < 3 * n; i++) Zout[i] = Z[i]!;
        for (let i = 0; i < 3 * n; i++) Fout[i] = F[i]!;
        return { converged: false, nIter, rate };
      }
    }

    // Apply update.
    for (let i = 0; i < n; i++) {
      W[0 * n + i] = W[0 * n + i]! + dW0[i]!;
      W[1 * n + i] = W[1 * n + i]! + dWcpx.re[i]!;
      W[2 * n + i] = W[2 * n + i]! + dWcpx.im[i]!;
    }
    applyT(W, Z, n);

    // Acceptance check.
    if (
      dWnorm === 0 ||
      (rate !== undefined && rate / Math.max(1 - rate, 1e-30) * dWnorm < tol)
    ) {
      for (let i = 0; i < 3 * n; i++) Zout[i] = Z[i]!;
      // Final F-values at converged Z are already in F (we computed at
      // top of loop). However, we did the F-eval *before* the W update,
      // so to be consistent with SciPy we don't recompute — SciPy returns
      // the F from the *last* iteration before update, which is what we
      // have. (The error estimator uses these same F values.)
      for (let i = 0; i < 3 * n; i++) Fout[i] = F[i]!;
      return { converged: true, nIter, rate };
    }

    dWnormOld = dWnorm;
  }

  // NEWTON_MAXITER hit without convergence.
  for (let i = 0; i < 3 * n; i++) Zout[i] = Z[i]!;
  for (let i = 0; i < 3 * n; i++) Fout[i] = F[i]!;
  return { converged: false, nIter, rate };
}

// ---- (T ⊗ I) and (T⁻¹ ⊗ I) applied to a stacked-3n vector --------------------

/** Z_out = (T · W_in row-block-by-row-block). W and Z are `(3·n)`
 *  arrays with `[s*n + i]` = component `i` of stage/eigen-coordinate `s`. */
function applyT(W: Float64Array, Z: Float64Array, n: number): void {
  for (let i = 0; i < n; i++) {
    const w0 = W[0 * n + i]!;
    const w1 = W[1 * n + i]!;
    const w2 = W[2 * n + i]!;
    Z[0 * n + i] = T_MAT[0]![0]! * w0 + T_MAT[0]![1]! * w1 + T_MAT[0]![2]! * w2;
    Z[1 * n + i] = T_MAT[1]![0]! * w0 + T_MAT[1]![1]! * w1 + T_MAT[1]![2]! * w2;
    Z[2 * n + i] = T_MAT[2]![0]! * w0 + T_MAT[2]![1]! * w1 + T_MAT[2]![2]! * w2;
  }
}

/** W_out = (T⁻¹ · Z_in). Same layout. */
function applyTI(Z: Float64Array, W: Float64Array, n: number): void {
  for (let i = 0; i < n; i++) {
    const z0 = Z[0 * n + i]!;
    const z1 = Z[1 * n + i]!;
    const z2 = Z[2 * n + i]!;
    W[0 * n + i] = TI_MAT[0]![0]! * z0 + TI_MAT[0]![1]! * z1 + TI_MAT[0]![2]! * z2;
    W[1 * n + i] = TI_MAT[1]![0]! * z0 + TI_MAT[1]![1]! * z1 + TI_MAT[1]![2]! * z2;
    W[2 * n + i] = TI_MAT[2]![0]! * z0 + TI_MAT[2]![1]! * z1 + TI_MAT[2]![2]! * z2;
  }
}

// ---- Local error estimator ---------------------------------------------------

/**
 * Compute the WRMS-norm local error after a converged Radau step.
 *
 * SciPy's exact formula:
 *
 *     ZE     = Z.T · E / h    (n-vector; Z is (3, n), E is (3,))
 *     error  = LU_real \ (f0 + ZE)
 *     scale  = atol + max(|y|, |yNew|) · rtol
 *     err_norm = sqrt(mean((error / scale)²))
 *
 * On the first iteration *of a rejected step that is being retried at
 * smaller h*, SciPy applies a more conservative re-estimator:
 *
 *     error = LU_real \ (f(t, y + error) + ZE)
 *
 * `errorNorm` carries `nFevDelta` so the driver can keep n_evals
 * accurate.
 *
 * Returns the error norm and (if rejected==true) the extra f-evaluation count.
 */
export function radauErrorNorm(
  f0: Float64Array,
  Z: Float64Array,
  y: Float64Array,
  yNew: Float64Array,
  h: number,
  luReal: LUResult,
  rtol: number,
  atol: number,
  rejected: boolean,
  fnEval?: (t: number, y: Float64Array, out: Float64Array) => void,
  t?: number,
): { errNorm: number; nFevDelta: number } {
  const n = y.length;

  // ZE = Z.T · E / h  (n-vector).
  const ZE = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    ZE[i] = (
      Z[0 * n + i]! * E[0]! +
      Z[1 * n + i]! * E[1]! +
      Z[2 * n + i]! * E[2]!
    ) / h;
  }

  // First estimate.
  const rhs = new Float64Array(n);
  for (let i = 0; i < n; i++) rhs[i] = f0[i]! + ZE[i]!;
  let error = solveReal(luReal, rhs);

  // Scale.
  const scale = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    scale[i] = atol + rtol * Math.max(Math.abs(y[i]!), Math.abs(yNew[i]!));
  }

  let errNorm = wrmsNorm(error, scale);
  let nFevDelta = 0;

  // SciPy: on a rejected step where the first estimator says > 1, retry
  // with a more conservative formula that costs one extra f-evaluation.
  if (rejected && errNorm > 1 && fnEval !== undefined && t !== undefined) {
    const ytmp = new Float64Array(n);
    for (let i = 0; i < n; i++) ytmp[i] = y[i]! + error[i]!;
    const ftmp = new Float64Array(n);
    fnEval(t, ytmp, ftmp);
    nFevDelta = 1;
    const rhs2 = new Float64Array(n);
    for (let i = 0; i < n; i++) rhs2[i] = ftmp[i]! + ZE[i]!;
    error = solveReal(luReal, rhs2);
    errNorm = wrmsNorm(error, scale);
  }

  return { errNorm, nFevDelta };
}

function wrmsNorm(e: Float64Array, scale: Float64Array): number {
  const n = e.length;
  let sumSq = 0;
  for (let i = 0; i < n; i++) {
    const r = e[i]! / scale[i]!;
    sumSq += r * r;
  }
  return Math.sqrt(sumSq / n);
}

// ---- Step-size predictor (HW Vol II §IV.8) ---------------------------------

/**
 * Predict by which factor to increase/decrease the step size given
 * current and previous (h, error_norm) pairs. Direct port of SciPy's
 * `predict_factor` (HW Vol II §IV.8). One-step fallback when no history.
 */
export function radauPredictFactor(
  hAbs: number,
  hAbsOld: number | undefined,
  errorNorm: number,
  errorNormOld: number | undefined,
): number {
  let multiplier: number;
  if (errorNormOld === undefined || hAbsOld === undefined || errorNorm === 0) {
    multiplier = 1;
  } else {
    multiplier = (hAbs / hAbsOld) * Math.pow(errorNormOld / errorNorm, 0.25);
  }
  // Avoid pow(0, -0.25) = Inf — clamp errorNorm at tiny floor.
  const e = Math.max(errorNorm, 1e-300);
  return Math.min(1, multiplier) * Math.pow(e, -0.25);
}
