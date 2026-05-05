// =============================================================================
// dopri5.ts — Dormand-Prince 5(4) explicit Runge-Kutta single-step routine
// =============================================================================
//
// Intent
// ------
// Single-step routine for the Dormand-Prince 5(4) embedded RK pair
// (Dormand & Prince 1980; Hairer-Nørsett-Wanner Vol I §II.5). The 5th
// order solution advances and the 4th-order embedded estimate gives
// the local truncation error used for adaptive step-size control by
// the PI driver in `integrate.ts`.
//
// FSAL — "First Same As Last" — is the canonical optimisation: the
// 7th stage `k7` is `f(t + h, y_{n+1})`, which equals `k1` of the
// next accepted step. The driver therefore performs only six new `f`
// evaluations per accepted step (after the very first step), and
// rejected steps reuse the same `k1` until a new accepted step
// rotates `k7 → k1`.
//
// Coefficient table (Dormand-Prince 1980; verbatim copy from
// Hairer-Nørsett-Wanner Vol I §II.5 Table 5.2; cross-checked against
// SciPy `scipy/integrate/_ivp/rk.py::DOP853` and Wikipedia "Dormand-
// Prince method").
//
//   c = [0, 1/5, 3/10, 4/5, 8/9, 1, 1]
//   A:
//     stage 2: a21 = 1/5
//     stage 3: a31 = 3/40,         a32 = 9/40
//     stage 4: a41 = 44/45,        a42 = -56/15,        a43 = 32/9
//     stage 5: a51 = 19372/6561,   a52 = -25360/2187,   a53 = 64448/6561,
//              a54 = -212/729
//     stage 6: a61 = 9017/3168,    a62 = -355/33,       a63 = 46732/5247,
//              a64 = 49/176,       a65 = -5103/18656
//     stage 7: a71 = 35/384,       a72 = 0,             a73 = 500/1113,
//              a74 = 125/192,      a75 = -2187/6784,    a76 = 11/84
//
//   b5 (5th-order weights, used to advance y) is row 7 of A:
//     b5 = [35/384, 0, 500/1113, 125/192, -2187/6784, 11/84, 0]
//   b4 (embedded 4th-order weights):
//     b4 = [5179/57600, 0, 7571/16695, 393/640, -92097/339200, 187/2100, 1/40]
//   err = b5 - b4  (used by the PI controller)
//
// The b5 weights coincide with stage 7's A-row (a71..a76, 0). That is
// what makes FSAL work: stage 7 evaluates `f` at the new step's
// `(t + h, y_{n+1})`, and y_{n+1} = y_n + h·Σ b5_i k_i = y_n + h·Σ a7_i k_i.
//
// Numeric leaves stored as JS `number` (IEEE-754 binary64); the
// rationals are evaluated once at module load and the resulting
// constants are byte-identical to `Number(num/den)` arithmetic which
// itself is bit-stable on every platform Bun targets (the rationals
// are all exactly representable up to ~2^53; the divisions round once
// in the round-to-nearest-ties-to-even default mode, identically on
// x86-64 / arm64 / wasm).

const c2 = 1 / 5;
const c3 = 3 / 10;
const c4 = 4 / 5;
const c5 = 8 / 9;
// c6 = 1; c7 = 1 — used implicitly for the FSAL stage.

const a21 = 1 / 5;

const a31 = 3 / 40;
const a32 = 9 / 40;

const a41 = 44 / 45;
const a42 = -56 / 15;
const a43 = 32 / 9;

const a51 = 19372 / 6561;
const a52 = -25360 / 2187;
const a53 = 64448 / 6561;
const a54 = -212 / 729;

const a61 = 9017 / 3168;
const a62 = -355 / 33;
const a63 = 46732 / 5247;
const a64 = 49 / 176;
const a65 = -5103 / 18656;

// Row 7 == 5th-order weights b5; FSAL.
const a71 = 35 / 384;
// a72 = 0
const a73 = 500 / 1113;
const a74 = 125 / 192;
const a75 = -2187 / 6784;
const a76 = 11 / 84;
// a77 = 0

// 5th-order solution weights (row 7 of A; same constants reused).
export const B5_1 = a71;
export const B5_2 = 0;
export const B5_3 = a73;
export const B5_4 = a74;
export const B5_5 = a75;
export const B5_6 = a76;
export const B5_7 = 0;

// 4th-order embedded weights.
const b4_1 = 5179 / 57600;
const b4_2 = 0;
const b4_3 = 7571 / 16695;
const b4_4 = 393 / 640;
const b4_5 = -92097 / 339200;
const b4_6 = 187 / 2100;
const b4_7 = 1 / 40;

// Error weights e_i = b5_i - b4_i. Pre-computed once.
const E1 = B5_1 - b4_1;
const E2 = 0 - b4_2;
const E3 = B5_3 - b4_3;
const E4 = B5_4 - b4_4;
const E5 = B5_5 - b4_5;
const E6 = B5_6 - b4_6;
const E7 = 0 - b4_7;

/** Order of the high-order pair (used by the PI controller's exponent). */
export const ORDER = 5;

/** Number of stages (FSAL: 7 stages, 6 new evaluations per accepted step after the first). */
export const N_STAGES = 7;

/**
 * Dense-output coefficients for the 4th-order Hermite continuous
 * extension (HNW Vol I §II.6, eq. 6.13; Dormand-Prince 1980 §6).
 *
 * The continuous extension has the form
 *
 *   y(t_n + θ·h) = y_n + h · Σ_{i=1..7} b_i(θ) · k_i
 *
 * where θ ∈ [0, 1] and `b_i(θ)` are the polynomial weights below.
 * Coefficients verbatim from SciPy `scipy/integrate/_ivp/rk.py`
 * (`P` matrix in `RK45`); cross-checked against the Shampine-Gordon
 * 1997 derivation reproduced in HNW.
 *
 * Layout: P[stage][power]; row `i` gives the coefficients of the
 * polynomial whose value at θ is the dense weight for stage `i`.
 * Stage 2 is unused (b5_2 = 0 and the dense weight is identically 0).
 */
const P: ReadonlyArray<readonly number[]> = [
  // stage 1 (k1):
  // 1 - 8048581381/2820520608 θ + 8663915743/2820520608 θ² - 12715105075/11282082432 θ³
  [1, -8048581381 / 2820520608, 8663915743 / 2820520608, -12715105075 / 11282082432],
  // stage 2 (k2): identically zero
  [0, 0, 0, 0],
  // stage 3 (k3):
  [0, 131558114200 / 32700410799, -68118460800 / 10900136933, 87487479700 / 32700410799],
  // stage 4 (k4):
  [0, -1754552775 / 470086768, 14199869525 / 1410260304, -10690763975 / 1880347072],
  // stage 5 (k5):
  [0, 127303824393 / 49829197408, -318862633887 / 49829197408, 701980252875 / 199316789632],
  // stage 6 (k6):
  [0, -282668133 / 205662961, 2019193451 / 616988883, -1453857185 / 822651844],
  // stage 7 (k7):
  [0, 40617522 / 29380423, -110615467 / 29380423, 69997945 / 29380423],
];

/**
 * Compute the seven stages `k1..k7` of one DOPRI5 step from `(t, y)`
 * using step size `h`, write the new state `y_new = y + h · Σ b5_i k_i`
 * and the per-component error vector `err = h · Σ e_i k_i` into the
 * provided output buffers.
 *
 * Inputs:
 *   `f`     — the RHS function, signature `(t, y, out)`. Writes
 *             `f(t, y)` into `out` (in place — caller owns the buffer).
 *             May throw `OdeNonFiniteError` (the driver translates).
 *   `t`     — current time
 *   `y`     — current state (Float64Array, length n)
 *   `h`     — step size (positive for forward, negative for reverse)
 *   `k1`    — first-stage derivative `f(t, y)`. Filled by caller (FSAL).
 *   `k2..7` — output buffers for stages 2..7 (length n each)
 *   `yNew`  — output buffer for `y_new` (length n)
 *   `err`   — output buffer for the error vector (length n)
 *   `tmp`   — a scratch buffer (length n) used for the staged
 *             intermediates `y + h · Σ a_ij k_j`.
 *
 * The function is allocation-free: every buffer is supplied by the
 * caller. This matters at the inner-loop scale of an adaptive driver
 * (10⁴-10⁶ steps on hard problems).
 *
 * The FSAL property means the caller must also retain `k7` so that
 * the next accepted step can copy it into its own `k1`. (`k7 =
 * f(t + h, y_new)`.)
 */
export function dopri5Step(
  f: (t: number, y: Float64Array, out: Float64Array) => void,
  t: number,
  y: Float64Array,
  h: number,
  k1: Float64Array,
  k2: Float64Array,
  k3: Float64Array,
  k4: Float64Array,
  k5: Float64Array,
  k6: Float64Array,
  k7: Float64Array,
  yNew: Float64Array,
  err: Float64Array,
  tmp: Float64Array,
): void {
  const n = y.length;

  // Stage 2:  y + h · a21 · k1
  for (let i = 0; i < n; i++) tmp[i] = y[i]! + h * a21 * k1[i]!;
  f(t + c2 * h, tmp, k2);

  // Stage 3:  y + h · (a31 k1 + a32 k2)
  for (let i = 0; i < n; i++) tmp[i] = y[i]! + h * (a31 * k1[i]! + a32 * k2[i]!);
  f(t + c3 * h, tmp, k3);

  // Stage 4:  y + h · (a41 k1 + a42 k2 + a43 k3)
  for (let i = 0; i < n; i++) {
    tmp[i] = y[i]! + h * (a41 * k1[i]! + a42 * k2[i]! + a43 * k3[i]!);
  }
  f(t + c4 * h, tmp, k4);

  // Stage 5:  y + h · (a51 k1 + a52 k2 + a53 k3 + a54 k4)
  for (let i = 0; i < n; i++) {
    tmp[i] = y[i]! + h * (
      a51 * k1[i]! + a52 * k2[i]! + a53 * k3[i]! + a54 * k4[i]!
    );
  }
  f(t + c5 * h, tmp, k5);

  // Stage 6:  y + h · (a61 k1 + a62 k2 + a63 k3 + a64 k4 + a65 k5)
  for (let i = 0; i < n; i++) {
    tmp[i] = y[i]! + h * (
      a61 * k1[i]! + a62 * k2[i]! + a63 * k3[i]! + a64 * k4[i]! + a65 * k5[i]!
    );
  }
  f(t + h, tmp, k6);

  // Stage 7 = y_new computed via b5 weights. Note a72 = a77 = 0.
  for (let i = 0; i < n; i++) {
    yNew[i] = y[i]! + h * (
      a71 * k1[i]! + a73 * k3[i]! + a74 * k4[i]! + a75 * k5[i]! + a76 * k6[i]!
    );
  }
  // FSAL: k7 = f(t + h, y_new). This is the next step's k1.
  f(t + h, yNew, k7);

  // Local error estimate: err = h · (e1 k1 + e2 k2 + e3 k3 + e4 k4 + e5 k5 + e6 k6 + e7 k7)
  for (let i = 0; i < n; i++) {
    err[i] = h * (
      E1 * k1[i]! + E2 * k2[i]! + E3 * k3[i]! + E4 * k4[i]! +
      E5 * k5[i]! + E6 * k6[i]! + E7 * k7[i]!
    );
  }
}

/**
 * Evaluate the 4th-order Hermite continuous extension at parameter
 * `θ ∈ [0, 1]` between accepted endpoints `t_n` and `t_n + h`, and
 * write the interpolated state into `out`.
 *
 * Algorithm: each stage's dense weight is evaluated as
 *
 *   b_i(θ) = θ · (P[i,0] + θ · (P[i,1] + θ · (P[i,2] + θ · P[i,3])))
 *
 * (Horner). The interpolant is
 *
 *   y(t_n + θ·h) = y_n + h · Σ b_i(θ) · k_i
 *
 * Note the leading factor of θ outside the Horner — `b_i(0) = 0`,
 * so the interpolant satisfies `y(t_n) = y_n` exactly (independent
 * of any roundoff in the polynomial coefficients).
 *
 * Caller passes the seven stage vectors from the most-recently-
 * accepted step, the step base `y_n`, and `h` (signed).
 */
export function dopri5DenseEval(
  theta: number,
  h: number,
  yN: Float64Array,
  k1: Float64Array,
  k2: Float64Array,
  k3: Float64Array,
  k4: Float64Array,
  k5: Float64Array,
  k6: Float64Array,
  k7: Float64Array,
  out: Float64Array,
): void {
  const n = yN.length;
  // Horner-evaluate each stage's dense weight at theta. Outer θ
  // factor is applied at the end of each Horner expansion.
  const b1 = theta * (P[0]![0]! + theta * (P[0]![1]! + theta * (P[0]![2]! + theta * P[0]![3]!)));
  // stage 2 is identically 0; skip
  const b3 = theta * (P[2]![0]! + theta * (P[2]![1]! + theta * (P[2]![2]! + theta * P[2]![3]!)));
  const b4_ = theta * (P[3]![0]! + theta * (P[3]![1]! + theta * (P[3]![2]! + theta * P[3]![3]!)));
  const b5_ = theta * (P[4]![0]! + theta * (P[4]![1]! + theta * (P[4]![2]! + theta * P[4]![3]!)));
  const b6 = theta * (P[5]![0]! + theta * (P[5]![1]! + theta * (P[5]![2]! + theta * P[5]![3]!)));
  const b7 = theta * (P[6]![0]! + theta * (P[6]![1]! + theta * (P[6]![2]! + theta * P[6]![3]!)));

  for (let i = 0; i < n; i++) {
    out[i] = yN[i]! + h * (
      b1 * k1[i]! + b3 * k3[i]! + b4_ * k4[i]! +
      b5_ * k5[i]! + b6 * k6[i]! + b7 * k7[i]!
    );
    // k2 contribution is zero.
    void k2;
  }
}
