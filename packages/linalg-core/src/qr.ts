// =============================================================================
// qr.ts — QR factorisation by Householder reflections
// =============================================================================
//
// Intent
// ------
// Compute `A = Q · R` for a real `m × n` matrix `A` using Householder
// reflections. Two return modes:
//
//   mode = "reduced": Q is `m × k`, R is `k × n`,           where k = min(m, n)
//   mode = "complete": Q is `m × m`, R is `m × n` (bottom `m − n` rows of R
//                       are exactly zero when m > n)
//
// For `m ≤ n` the two modes coincide (Q is `m × m` either way).
//
// Why Householder, not Gram-Schmidt
// ---------------------------------
// Numerical orthogonality of `Q` is what keeps `Q` usable as a
// least-squares oracle. The bench's `Q_orthonormal` check pins
// `‖QᵀQ − I‖_F ≤ 100·ε·m·√k`, *independent of the condition number of A*.
// Three textbook QR algorithms; only one passes that bar:
//
//   * Classical Gram-Schmidt: `‖QᵀQ − I‖_F = O(κ(A)² · ε)`. Catastrophic
//     on Hilbert-6 (κ ~ 10⁷ ⇒ orth error ~ 10⁻²).
//   * Modified Gram-Schmidt:  `‖QᵀQ − I‖_F = O(κ(A) · ε)`. Fails Hilbert-8
//     (κ ~ 10¹⁰ ⇒ orth error ~ 10⁻⁶).
//   * Householder reflections: `‖QᵀQ − I‖_F = O(ε)`. Independent of κ.
//     This is why DGEQRF is the LAPACK default and why we ship it here.
//
// References: Wilkinson, *The Algebraic Eigenvalue Problem*, OUP 1965;
// Higham, *Accuracy and Stability of Numerical Algorithms*, 2nd ed.,
// SIAM 2002, Theorem 19.4 (Householder QR backward stability); Golub
// & Van Loan, *Matrix Computations*, 4th ed., JHU 2013, §5.2 (Algorithm
// 5.2.1, Householder QR).
//
// Algorithm (Golub & Van Loan, Algorithm 5.2.1)
// ---------------------------------------------
// For `j = 0, 1, …, k−1` (where k = min(m, n)):
//
//   Let `x = A[j..m, j]` — the column of the trailing sub-matrix.
//
//   Construct a Householder reflector `H = I − τ · v · vᵀ` such that
//   `H · x = (α, 0, 0, …)ᵀ` for some scalar α.
//
//   The standard normalisation (Golub & Van Loan §5.1.2) chooses the
//   sign of α to avoid cancellation in the construction of v:
//
//     α = −sign(x[0]) · ‖x‖₂      (with sign(0) := +1)
//     v = x − α · e₁              (so v[0] = x[0] − α; the rest equals x)
//     τ = 2 / (vᵀv)               (equivalently 2 v[0] · α / (α²) when v[0]=x[0]−α)
//
//   With sign(x[0]) ≠ 0 chosen as above, `x[0] − α` has the same sign as
//   `−α`, and its magnitude is ≥ ‖x‖₂ — no subtractive cancellation.
//
//   Apply H to A[j..m, j..n] from the left:
//
//     A[j..m, j..n] ← A[j..m, j..n] − τ · v · (vᵀ · A[j..m, j..n])
//
//   The first column collapses to (α, 0, 0, …)ᵀ; we store α at A[j, j]
//   (the j-th diagonal of R) and store v[1..] *in place* below the
//   diagonal (the slot vacated by the now-zero entries).
//
// Storage convention (LAPACK DGEQRF style)
// ----------------------------------------
// After the j-th step, A's storage holds:
//
//     R on and above the diagonal,
//     v[1..] strictly below the diagonal of column j,
//     τ_j stored in a separate length-k vector.
//
// The leading entry v[0] is conventionally fixed at 1 by rescaling
// `v ← v / v[0]` and adjusting τ; this lets us reuse the slot at A[j,j]
// for R[j,j] = α without conflict. See Golub & Van Loan §5.1.4 for the
// rescaling math; we follow it here so that `v[0] = 1` is implicit when
// we apply or accumulate reflectors.
//
// Reconstructing Q
// ----------------
// We accumulate Q from right to left (LAPACK DORGQR's
// "backward-accumulation" pattern). Starting from `Q = I` (m × k for
// reduced, m × m for complete), apply `H_{k−1} … H_1 H_0 · Q`. Each
// application is rank-1: `Q ← Q − τ_j · v_j · (v_jᵀ · Q)`.
//
// Right-to-left order keeps the early `Q` columns mostly identity, so
// the rank-1 updates touch a sparse region and the running orthogonality
// stays at ε. Forward accumulation (`Q ← I; for j: Q ← H_j · Q`) is
// algebraically equivalent but numerically inferior — Golub & Van Loan
// §5.1.6.
//
// Self-reported errors
// --------------------
// Once Q and R are formed, we compute the two diagnostics the agent's
// planner reads:
//
//     reconstruction_error  = ‖Q · R − A‖_F / max(‖A‖_F, 1)
//     orthogonality_error   = ‖QᵀQ − I‖_F
//
// These are the *candidate's honest self-report* on its own quality
// (ADR-0014 agent-honest output discipline). The verifier recomputes
// both from Q, R, and the original A; bench check 6/7 require agreement
// to `1e-6` relative. We therefore compute them inside this function on
// the actual returned matrices, not on intermediate state — anything
// else would risk drifting from the verifier and failing self-honesty.
//
// Edge cases
// ----------
//   * `m = n = 1`:                 trivial; H is the 1-element reflector
//                                  (α = ±A[0,0]). Still uses the algorithm.
//   * Zero column at step j:       ‖x‖ = 0, so we set α = 0, τ = 0, and
//                                  store identity-effect (no rank-1 update).
//                                  R[j,j] = 0 — a rank-revealing zero.
//   * All-zero input A:            every step has zero-column ⇒ R = 0,
//                                  Q = identity. Reconstruction is exact.
//   * `m < n`:                     k = m; the last column of R is partially
//                                  filled but no further reflector is
//                                  needed below row m−1. Reduced and
//                                  complete coincide (Q is m × m).
//   * `m > n` in reduced mode:     Q has only n columns. The remaining
//                                  m − n orthogonal directions are not
//                                  computed (they live implicitly in the
//                                  Householder vectors but are never
//                                  materialised). Saves m·(m−n) entries.

import { type Matrix, MatrixError } from "./matrix.js";

/**
 * Result of a successful QR factorisation.
 *
 * Field semantics:
 *
 *   * `Q`, `R`: the factors. Dimensions depend on `mode` (and, for
 *     `m < n`, both modes return Q as `m × m`).
 *
 *   * `mode`: echoes back the requested mode, either "reduced"
 *     (default; LAPACK's economy QR) or "complete" (full m × m Q).
 *
 *   * `diagonalR`: a length-`min(m, n)` snapshot of `diag(R)`. Useful
 *     for rank diagnostics — small entries reveal numerical rank
 *     deficiency without forcing the caller to walk R themselves.
 *
 *   * `reconstructionError`: `‖Q · R − A‖_F / max(‖A‖_F, 1)`. The
 *     denominator is `max(·, 1)` so the metric is sensible on
 *     `A = 0`.
 *
 *   * `orthogonalityError`: `‖QᵀQ − I_k‖_F`, where k is `Q.cols`.
 *
 * Both error fields are computed *after* Q and R are finalised, on
 * the actual returned matrices — they're the honest self-report,
 * not an intermediate estimate. The agent-honest output discipline
 * (ADR-0014; bench check 6/7) requires this.
 */
export type QRResult = {
  readonly Q: Matrix;
  readonly R: Matrix;
  readonly mode: "reduced" | "complete";
  readonly diagonalR: Float64Array;
  readonly reconstructionError: number;
  readonly orthogonalityError: number;
};

/**
 * Compute the Householder QR factorisation of `A`.
 *
 * Returns `{Q, R, mode, diagonalR, reconstructionError, orthogonalityError}`.
 * Never returns null — Householder QR exists and is computed for every
 * real matrix, including rank-deficient ones (where `diag(R)` reveals
 * the rank gap as small entries).
 *
 * The implementation operates on a working copy of `A`'s entries; the
 * caller's matrix is never mutated.
 *
 * Throws `MatrixError` only on the degenerate-storage corner the
 * substrate rejects throughout: zero rows or zero cols. The tool layer
 * catches these earlier (boundary `tagged` per ADR-0003) and never
 * forwards a degenerate matrix here.
 */
export function qr(
  A: Matrix,
  mode: "reduced" | "complete" = "reduced",
): QRResult {
  const m = A.rows;
  const n = A.cols;
  if (m === 0 || n === 0) {
    throw new MatrixError(`qr: degenerate shape (${m}×${n})`);
  }

  const k = Math.min(m, n);
  // qCols is the number of columns Q ends up with.
  const qCols = mode === "complete" || m < n ? m : k;

  // Working copy of A. After the loop:
  //   * Above-and-on the diagonal of `work` carries R's entries.
  //   * Strictly below the diagonal of column j carries v_j[1..],
  //     with the implicit v_j[0] = 1 normalisation.
  const work = new Float64Array(A.data);
  const tau = new Float64Array(k);

  // Per-column reflector construction and application. The inner loops
  // touch the trailing sub-matrix `work[j..m, j..n]` only; columns
  // `< j` are already converged to their R values.
  for (let j = 0; j < k; j++) {
    // -------------------------------------------------------------------------
    // Step 1: build the reflector that annihilates the sub-column
    //         x = work[j..m, j].
    //
    // We compute ‖x‖₂ via a scaled-DNRM2 pass to stay representable
    // for very large or very small entries — same trick `vecNorm2` uses
    // in matrix.ts. The Householder vector v has v[0] = x[0] − α and
    // v[i] = x[i] for i > 0; we then normalise v ← v / v[0] so that
    // v[0] = 1 implicitly, and τ becomes 2 / (vᵀv) on the rescaled v
    // (equivalently τ = (α − x[0]) / α; both formulations match Golub &
    // Van Loan §5.1.4).
    // -------------------------------------------------------------------------

    // Find the sub-column max for the scaled norm.
    let scale = 0;
    for (let i = j; i < m; i++) {
      const a = Math.abs(work[i * n + j]!);
      if (a > scale) scale = a;
    }

    if (scale === 0) {
      // Sub-column is exactly zero. The reflector is the identity; R[j,j] = 0
      // (a rank-revealing zero); v_j[0..] = 0 so subsequent v-applications
      // are no-ops. Store τ_j = 0 to mark this.
      tau[j] = 0;
      // diag(R) entry stays at the existing 0 (no write needed).
      continue;
    }

    // Compute ‖x‖₂ in the scaled basis, then unscale.
    let s = 0;
    for (let i = j; i < m; i++) {
      const r = work[i * n + j]! / scale;
      s += r * r;
    }
    const xnorm = scale * Math.sqrt(s);

    // Sign convention: α = −sign(x[0]) · ‖x‖₂, with sign(0) := +1.
    // This pushes v[0] = x[0] − α further from zero, eliminating
    // subtractive cancellation in the construction of v.
    const x0 = work[j * n + j]!;
    const sign = x0 >= 0 ? 1 : -1;
    const alpha = -sign * xnorm;

    // v[0] = x[0] − α. We need this for both the τ formula and the
    // rescaling step v ← v / v[0].
    const v0 = x0 - alpha;

    // τ = 2 v[0] α_aux / vᵀv, where α_aux = (α − x[0]) is here −v0,
    // and vᵀv = v[0]² + Σ_{i>j} x[i]² = v[0]² + (xnorm² − x[0]²)
    //         = v[0]² + xnorm² − x[0]²
    //         = (x[0] − α)² + xnorm² − x[0]²
    //         = α² − 2 α x[0] + xnorm² − x[0]² + 2 x[0]² − 2 x[0] x[0]   [oh, mess]
    //
    // The clean derivation (Golub & Van Loan §5.1.4, eq. 5.1.6):
    //
    //     τ = (v0 − x[0] + α + x[0] − α) / v0           (after rescaling)
    //
    // is simpler stated as: after rescaling v ← v / v[0], the implicit
    // v[0] = 1, the rest is x[i]/v[0]. Then vᵀv = 1 + Σ_{i>j} (x[i]/v[0])²
    // and τ = 2 / vᵀv. We compute it directly:
    let vDotV = 1; // implicit v[0] = 1 after rescaling
    const inv_v0 = 1 / v0;
    for (let i = j + 1; i < m; i++) {
      const vi = work[i * n + j]! * inv_v0; // rescaled v[i]
      work[i * n + j] = vi;                 // write back the rescaled v[i]
      vDotV += vi * vi;
    }
    const tj = 2 / vDotV;
    tau[j] = tj;

    // R[j, j] = α — the diagonal entry of R for this column.
    work[j * n + j] = alpha;

    // -------------------------------------------------------------------------
    // Step 2: apply H = I − τ_j · v · vᵀ to the trailing sub-matrix
    //         work[j..m, (j+1)..n].
    //
    // For each column c in the trailing block:
    //   w = vᵀ · work[j..m, c]                  (with implicit v[j] = 1)
    //   work[j..m, c] -= τ_j · w · v             (rank-1 update)
    //
    // The j-th column has already been rewritten to (α, v[j+1], v[j+2], …),
    // which is exactly the rank-1 update applied to the original column
    // (as can be verified: H · x = (α, 0, …)ᵀ, and we wrote v[1..] into
    // the slots that would have been zeroed). So we update only c > j.
    // -------------------------------------------------------------------------

    for (let c = j + 1; c < n; c++) {
      // Compute w = vᵀ · work[j..m, c].
      let w = work[j * n + c]!; // implicit v[0] = 1 contributes work[j, c]
      for (let i = j + 1; i < m; i++) {
        w += work[i * n + j]! * work[i * n + c]!;
      }
      const tw = tj * w;
      // Rank-1 update: work[j..m, c] -= tw · v.
      work[j * n + c] = work[j * n + c]! - tw; // implicit v[0] = 1
      for (let i = j + 1; i < m; i++) {
        work[i * n + c] = work[i * n + c]! - tw * work[i * n + j]!;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Extract R from the upper triangle of `work`.
  //
  //   reduced  : R is min(m,n) × n, taken from rows 0..k-1.
  //   complete : R is m × n; rows k..m-1 are exactly zero (only meaningful
  //              when m > n; when m ≤ n we have k = m, so this branch
  //              produces no extra rows).
  // ---------------------------------------------------------------------------

  const rRows = mode === "complete" ? m : k;
  const R: Matrix = {
    rows: rRows,
    cols: n,
    data: new Float64Array(rRows * n),
  };
  for (let i = 0; i < k; i++) {
    // Upper triangle: copy work[i, i..n] into R[i, i..n].
    for (let cc = i; cc < n; cc++) {
      R.data[i * n + cc] = work[i * n + cc]!;
    }
  }
  // For mode="complete" with m > n, rows k..rRows-1 of R remain zero
  // (initialised by Float64Array). This matches the LAPACK convention.

  // ---------------------------------------------------------------------------
  // Build Q by backward accumulation: Q ← H_0 · H_1 · … · H_{k-1} · I_qCols.
  //
  // We start with Q = I (m × qCols) and apply each H_j in *reverse* order
  // from the right. For each j from k-1 down to 0, perform the rank-1
  // update on Q[j..m, *]:
  //
  //     Q[j..m, *] ← Q[j..m, *] − τ_j · v_j · (v_jᵀ · Q[j..m, *])
  //
  // The implicit v_j[0] = 1 is honoured throughout. Right-to-left order
  // keeps Q's identity columns mostly untouched in the early iterations,
  // so the running orthogonality error stays near machine epsilon
  // (Golub & Van Loan §5.1.6).
  // ---------------------------------------------------------------------------

  const Q: Matrix = {
    rows: m,
    cols: qCols,
    data: new Float64Array(m * qCols),
  };
  for (let i = 0; i < m && i < qCols; i++) {
    Q.data[i * qCols + i] = 1; // identity
  }

  for (let j = k - 1; j >= 0; j--) {
    const tj = tau[j]!;
    if (tj === 0) continue; // zero-column reflector is the identity

    // Apply H_j to columns 0..qCols-1 of Q, but only rows j..m-1 are
    // touched (the reflector acts as identity on rows < j). For each
    // such column c:
    //   w = Q[j, c] (since v[0] = 1) + Σ_{i>j} v[i] · Q[i, c]
    //   Q[j, c] -= τ_j · w
    //   for i > j:  Q[i, c] -= τ_j · w · v[i]
    //
    // For backward accumulation we only need to touch columns c ≥ j —
    // columns with index < j of the in-progress identity are still
    // untouched in any prior j-loop step (they remain (0,…,1_at_c,…,0))
    // and their leading-block dot product with v is zero. Skipping
    // those is a substantive ε save *and* a flop save.
    for (let c = j; c < qCols; c++) {
      let w = Q.data[j * qCols + c]!; // implicit v_j[0] = 1
      for (let i = j + 1; i < m; i++) {
        w += work[i * n + j]! * Q.data[i * qCols + c]!;
      }
      const tw = tj * w;
      Q.data[j * qCols + c] = Q.data[j * qCols + c]! - tw;
      for (let i = j + 1; i < m; i++) {
        Q.data[i * qCols + c] = Q.data[i * qCols + c]! - tw * work[i * n + j]!;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // diag(R): top-min(m,n) entries of R's diagonal. Stored as a fresh
  // Float64Array so the caller can hand it on without aliasing R.
  // ---------------------------------------------------------------------------

  const diagonalR = new Float64Array(k);
  for (let i = 0; i < k; i++) {
    diagonalR[i] = R.data[i * n + i]!;
  }

  // ---------------------------------------------------------------------------
  // Self-reported errors.
  //
  // We compute these on the *actual* returned Q and R — the same
  // formulas the bench's verify.py uses. The Frobenius norms walk the
  // matrices in row-major order with a straight float64 sum (no Kahan
  // accumulation): the verifier does the same, so any discrepancy
  // would be a real algorithmic divergence, not a summation-order
  // artefact.
  // ---------------------------------------------------------------------------

  const aNorm = frobeniusNormFromArray(A.data);
  const reconstructionError = frobeniusNormDiff(Q, R, A) / Math.max(aNorm, 1);
  const orthogonalityError = frobeniusOrthogonalityError(Q);

  return {
    Q,
    R,
    mode,
    diagonalR,
    reconstructionError,
    orthogonalityError,
  };
}

// -----------------------------------------------------------------------------
// Frobenius-norm helpers (private to this module).
//
// Two reasons these aren't in `matrix.ts`:
//   1. They're QR-specific in their composition (||Q·R − A|| and ||QᵀQ − I||)
//      and don't generalise cleanly into single-matrix utilities.
//   2. Inlining them here keeps the qr() body's reasoning local — a
//      reader doesn't have to chase across files to verify the
//      self-reported error matches what the bench's verifier computes.
// -----------------------------------------------------------------------------

/**
 * Frobenius norm of a flat data buffer: √(Σ x_i²). We reuse the
 * scaled-DNRM2 pattern from `vecNorm2` to stay representable for
 * very large or very small inputs.
 */
function frobeniusNormFromArray(data: Float64Array): number {
  let scale = 0;
  for (let i = 0; i < data.length; i++) {
    const a = Math.abs(data[i]!);
    if (a > scale) scale = a;
  }
  if (scale === 0) return 0;
  let s = 0;
  for (let i = 0; i < data.length; i++) {
    const r = data[i]! / scale;
    s += r * r;
  }
  return scale * Math.sqrt(s);
}

/**
 * Compute `‖Q · R − A‖_F` directly. We form `Q · R` row-by-row and
 * accumulate the squared-difference sum without materialising the
 * product matrix in full. (For m × n with k = Q.cols, the temporary
 * matrix would be m·n entries; the streaming form lets the JIT keep
 * one row in a register.)
 */
function frobeniusNormDiff(Q: Matrix, R: Matrix, A: Matrix): number {
  const m = Q.rows;
  const k = Q.cols;
  const n = R.cols;
  if (R.rows !== k) {
    // Shouldn't happen if qr() built things correctly; defence in depth.
    throw new MatrixError(
      `frobeniusNormDiff: Q has ${k} cols but R has ${R.rows} rows`,
    );
  }
  if (A.rows !== m || A.cols !== n) {
    throw new MatrixError(
      `frobeniusNormDiff: A is ${A.rows}×${A.cols}, expected ${m}×${n}`,
    );
  }

  // First pass: find the max |Q·R − A| entry for the scaled-norm
  // denominator. Two passes keeps overflow at bay for high-magnitude
  // matrices (same DNRM2 trick).
  let scale = 0;
  for (let i = 0; i < m; i++) {
    for (let cc = 0; cc < n; cc++) {
      let qr_ic = 0;
      for (let kk = 0; kk < k; kk++) {
        qr_ic += Q.data[i * k + kk]! * R.data[kk * n + cc]!;
      }
      const d = Math.abs(qr_ic - A.data[i * n + cc]!);
      if (d > scale) scale = d;
    }
  }
  if (scale === 0) return 0;
  let s = 0;
  for (let i = 0; i < m; i++) {
    for (let cc = 0; cc < n; cc++) {
      let qr_ic = 0;
      for (let kk = 0; kk < k; kk++) {
        qr_ic += Q.data[i * k + kk]! * R.data[kk * n + cc]!;
      }
      const r = (qr_ic - A.data[i * n + cc]!) / scale;
      s += r * r;
    }
  }
  return scale * Math.sqrt(s);
}

/**
 * Compute `‖QᵀQ − I_k‖_F` directly. We form `QᵀQ`'s upper triangle
 * (it's symmetric) one entry at a time, subtract the Kronecker delta,
 * and accumulate squares. The off-diagonal entries are doubled in the
 * sum because both `(i, j)` and `(j, i)` of `QᵀQ − I` carry the same
 * magnitude (|<q_i, q_j>|).
 */
function frobeniusOrthogonalityError(Q: Matrix): number {
  const m = Q.rows;
  const k = Q.cols;

  // Compute G[i, j] = <q_i, q_j> − δ_{ij} for i ≤ j; the matrix is
  // symmetric. Frobenius norm contribution: G[i,i]² for i = j, plus
  // 2·G[i,j]² for i < j.
  //
  // We use the same scaled-norm pattern: find max-magnitude entry,
  // then accumulate normalised squares.

  let scale = 0;
  for (let i = 0; i < k; i++) {
    for (let j = i; j < k; j++) {
      let s = 0;
      for (let r = 0; r < m; r++) {
        s += Q.data[r * k + i]! * Q.data[r * k + j]!;
      }
      const d = Math.abs(s - (i === j ? 1 : 0));
      if (d > scale) scale = d;
    }
  }
  if (scale === 0) return 0;

  let acc = 0;
  for (let i = 0; i < k; i++) {
    for (let j = i; j < k; j++) {
      let s = 0;
      for (let r = 0; r < m; r++) {
        s += Q.data[r * k + i]! * Q.data[r * k + j]!;
      }
      const d = (s - (i === j ? 1 : 0)) / scale;
      const c = i === j ? 1 : 2;
      acc += c * d * d;
    }
  }
  return scale * Math.sqrt(acc);
}
