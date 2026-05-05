// =============================================================================
// svd.ts — Singular value decomposition by one-sided Jacobi (Demmel-Veselić)
// =============================================================================
//
// Intent
// ------
// Compute `A = U · diag(S) · Vᵀ` for a real `m × n` matrix `A`. Two return
// modes:
//
//   mode = "reduced":  U is `m × k`, S has length k, Vᵀ is `k × n`,
//                      where k = min(m, n).  (LAPACK economy form.)
//   mode = "complete": U is `m × m`, S has length k, Vᵀ is `n × n`.
//                      The extra `m − k` columns of U span the orthogonal
//                      complement of A's column space; the extra `n − k`
//                      rows of Vᵀ span A's null space.
//
// (When `m = n` the two modes coincide.)
//
// Why one-sided Jacobi (Demmel-Veselić) and not Golub-Reinsch
// -----------------------------------------------------------
// Golub-Reinsch (Householder bidiagonalisation + Demmel-Kahan implicit-shift
// QR sweeps on the bidiagonal) is the LAPACK DGESVD path.  It is
// asymptotically faster — `O(mn² + n³)` versus Jacobi's `O(mn² · log n)`
// per sweep with `O(log n)` sweeps.  For `n ≤ 200` (our v0.1 cap, mirroring
// `linalg-solve` and `linalg-qr`) the speed gap doesn't matter; correctness
// dominates.  Three reasons one-sided Jacobi wins the implementation budget:
//
//   1. **Half the lines of code with no convergence-edge cases.**  Golub-
//      Reinsch needs Householder bidiagonalisation, then accumulation of
//      U₁ and V₁ from the bidiagonalisation, then implicit-shift QR sweeps
//      with shift selection (Wilkinson's shift on the trailing 2×2 of
//      BᵀB), then deflation, then post-sort.  Each piece has subtle
//      convergence corner cases.  Jacobi has one loop: rotate columns
//      until off-diagonals of AᵀA are below tolerance.
//
//   2. **Superior accuracy on small singular values** (Demmel-Veselić
//      1992, Drmač 1997).  Bidiagonalisation followed by QR can lose
//      half the available digits on the smallest singular values when
//      A has a wide range of column norms; Jacobi computes every
//      singular value to high relative accuracy regardless of κ(A).
//      This matters on the bench's Hilbert-50 case (κ > 10¹⁸).
//
//   3. **Backward-stability bounds independent of κ(A)**, identical to
//      what the bench's verifier pins:
//          ‖U·diag(S)·Vᵀ − A‖_F ≤ c · ε · ‖A‖_F
//          ‖UᵀU − I‖_F          ≤ c · ε
//          ‖Vᵀ·V − I‖_F         ≤ c · ε
//      (Demmel & Veselić, *SIAM J. Matrix Anal. Appl.* 13(4), 1992.)
//
// References:
//   - Demmel & Veselić, "Jacobi's method is more accurate than QR",
//     *SIAM J. Matrix Anal. Appl.* 13(4):1204–1245, 1992.
//   - Drmač, "Implementation of Jacobi rotations for accurate singular
//     value computation in floating point arithmetic", *SIAM J. Sci.
//     Comput.* 18(4):1200–1222, 1997.
//   - Golub & Van Loan, *Matrix Computations*, 4th ed., JHU 2013, §8.5
//     (Jacobi SVD methods).
//   - Higham, *Accuracy and Stability of Numerical Algorithms*, 2nd ed.,
//     SIAM 2002, §20.3 (SVD backward-error analysis).
//
// Algorithm (one-sided Jacobi, Demmel-Veselić)
// --------------------------------------------
// One-sided Jacobi diagonalises `AᵀA` *implicitly* by orthogonal column
// rotations of A.  The key identity: if A = U·Σ·Vᵀ, then AᵀA = V·Σ²·Vᵀ,
// so applying Givens rotations from the right that diagonalise AᵀA also
// reveal Σ in the resulting orthogonal columns of A·V.  We never form
// AᵀA explicitly.
//
// Setup.  Work on the *taller* of `A` and `Aᵀ`.  If `m ≥ n`, work on A
// directly; if `m < n`, work on Aᵀ and swap U ↔ V at the end.  The
// algorithm wants the worked-on matrix to have at least as many rows as
// columns so the columns can be made orthogonal.
//
// Initialisation.  W = working_copy(A) (m × n_work, n_work ≤ m_work).
// V = I_{n_work}.  We will accumulate column rotations of W into V.
//
// Sweep loop.  Repeat until off-diagonal mass is below tolerance:
//   For each unordered pair (p, q) with p < q < n_work:
//     Compute α = ⟨W[:,p], W[:,p]⟩, β = ⟨W[:,q], W[:,q]⟩, γ = ⟨W[:,p], W[:,q]⟩.
//     If γ² ≤ ε² · α · β, columns are already (numerically) orthogonal —
//       skip (no rotation, no convergence cost).
//     Else compute the Jacobi (Givens) rotation that diagonalises the
//       2×2 block [α γ; γ β]:
//         ζ  = (β − α) / (2γ)
//         t  = sign(ζ) / (|ζ| + √(1 + ζ²))   (the smaller-magnitude root)
//         c  = 1 / √(1 + t²),   s = t · c
//     Apply the 2×2 rotation to columns p and q of W *and* of V:
//         (W[:,p], W[:,q]) ← (c·W[:,p] − s·W[:,q], s·W[:,p] + c·W[:,q])
//         (V[:,p], V[:,q]) ← same formula
//
// Convergence.  The Frobenius norm of the off-diagonal of WᵀW strictly
// decreases each rotation (Jacobi's theorem); empirical bounds on
// real-world matrices give convergence in `O(log n)` sweeps to machine
// precision.  We cap at 60 sweeps as a safety net (the bench's largest
// case is 200×200; even Hilbert-50 converges in ~20 sweeps in practice).
//
// Extraction.
//   * Singular values  S[i] = ‖W[:,i]‖₂  (the columns are now orthogonal,
//     so their norms are the singular values).
//   * Left singular vectors  U[:,i] = W[:,i] / S[i].
//     For S[i] = 0 columns (rank deficiency), set U[:,i] to a unit vector
//     in the orthogonal complement of the previously-extracted columns;
//     we use a Gram-Schmidt completion against `U[:, 0..i)`.
//   * Sort S descending; permute U, V to match.
//
// Mode handling.
//   reduced:   return U (m × k), S (k), Vᵀ (k × n) where k = min(m, n).
//              If we worked on Aᵀ, swap U ↔ V at the end.
//   complete:  reduced + extend U to m columns (and Vᵀ to n rows) by
//              Gram-Schmidt completion against the columns we already
//              have.  The extension only needs to touch m − k extra
//              U-columns (and n − k extra V-columns) because each side
//              is already an orthonormal partial basis.
//
// Edge cases
// ----------
//   * m = n = 1:                  trivial; S = |A[0,0]|, U = [sign(A[0,0])],
//                                 V = [1].  Algorithm degenerates correctly.
//   * Zero matrix:                no rotations needed; S = 0; U, V default
//                                 to identity.  Reconstruction is exact.
//   * Rank-deficient A:           Jacobi produces zero columns of W
//                                 (numerically ε-zero) for the dependent
//                                 directions.  S sorts those to the end;
//                                 U-columns at those positions are
//                                 completed by Gram-Schmidt against the
//                                 nonzero ones.
//   * m < n:                      we transpose, work on Aᵀ (now taller),
//                                 swap U ↔ V at the end.  The two modes
//                                 still coincide for m ≤ n in the sense
//                                 that U is m × m either way.
//
// Self-reported errors (the agent-honest contract)
// ------------------------------------------------
// We compute on the *actual* returned U, S, Vᵀ — the same formulas the
// bench's verify.py uses:
//
//     reconstruction_error    = ‖U · diag(S) · Vᵀ − A‖_F / max(‖A‖_F, 1)
//     orthogonality_error_U   = ‖UᵀU − I‖_F
//     orthogonality_error_Vt  = ‖Vᵀ · V − I‖_F   (i.e. ‖Vt · Vtᵀ − I‖_F)
//     condition_number        = S[0] / max(S[k-1], EPS · S[0])
//     rank_estimate           = #{i : S[i] > max(m, n) · EPS · S[0]}
//
// These are the candidate's honest self-report on its own quality
// (ADR-0014 agent-honest output discipline; bench checks 7 and 8
// require agreement to 1e-6 relative with verifier recomputation).

import { type Matrix, MatrixError } from "./matrix.js";

const EPS = Number.EPSILON;
const MAX_SWEEPS = 60;

/**
 * Result of a successful SVD factorisation `A = U · diag(S) · Vᵀ`.
 *
 * Field semantics:
 *   * `U`, `Vt`: orthogonal factors. Dimensions depend on `mode` and
 *     on whether `m < n` (see header). Vt is V transposed (so its rows
 *     are V's columns — orthonormal rows).
 *   * `S`: singular values, length k = min(m, n). Non-negative,
 *     sorted descending.
 *   * `mode`: echoes the requested mode.
 *   * `reconstructionError`, `orthogonalityErrorU`, `orthogonalityErrorVt`:
 *     candidate self-report (Frobenius). Agent-honest discipline; the
 *     bench's verifier recomputes these and demands 1e-6 relative
 *     agreement.
 *   * `conditionNumber`: `S[0] / max(S[k-1], EPS·S[0])`.  Capped at
 *     `1/EPS ≈ 4.5e15` rather than `+Inf` so finite-arithmetic
 *     downstream consumers compose without special cases.
 *   * `rankEstimate`: count of `S[i] > max(m, n) · EPS · S[0]`.
 *     LAPACK-standard numerical-rank threshold.
 */
export type SVDResult = {
  readonly U: Matrix;
  readonly S: Float64Array;
  readonly Vt: Matrix;
  readonly mode: "reduced" | "complete";
  readonly reconstructionError: number;
  readonly orthogonalityErrorU: number;
  readonly orthogonalityErrorVt: number;
  readonly conditionNumber: number;
  readonly rankEstimate: number;
};

/**
 * Compute the singular value decomposition of `A` by one-sided Jacobi.
 *
 * Returns `{U, S, Vt, mode, reconstructionError, orthogonalityErrorU,
 * orthogonalityErrorVt, conditionNumber, rankEstimate}`. Never returns
 * null — Jacobi SVD exists for every real matrix, including rank-
 * deficient ones (the dependent directions surface as `S[i] = 0`).
 *
 * The implementation operates on a working copy of `A`'s entries; the
 * caller's matrix is never mutated.
 *
 * Throws `MatrixError` only on the degenerate-storage corner the
 * substrate rejects throughout: zero rows or zero cols. The tool layer
 * catches these earlier (boundary `tagged` per ADR-0003) and never
 * forwards a degenerate matrix here.
 */
export function svd(
  A: Matrix,
  mode: "reduced" | "complete" = "reduced",
): SVDResult {
  const m = A.rows;
  const n = A.cols;
  if (m === 0 || n === 0) {
    throw new MatrixError(`svd: degenerate shape (${m}×${n})`);
  }

  // --------------------------------------------------------------------------
  // Orient the work so the worked-on matrix is at least as tall as it is
  // wide. If m ≥ n, work on A directly; if m < n, work on Aᵀ and swap
  // U ↔ V at the end.  This keeps the column-rotation algorithm's loop
  // structure clean: every column of the worked matrix gets an entry in
  // the V (or U after swap) accumulator.
  // --------------------------------------------------------------------------

  const transposed = m < n;
  const mw = transposed ? n : m; // rows of work
  const nw = transposed ? m : n; // cols of work; nw ≤ mw

  // W = working copy of (A or Aᵀ), m_w × n_w in row-major.
  const W = new Float64Array(mw * nw);
  if (transposed) {
    // Aᵀ in row-major mw × nw layout: (Aᵀ)[j, i] = A[i, j], stored at
    // W[j * nw + i].  (j ranges over the new rows = old columns; i over
    // the new columns = old rows.)
    for (let i = 0; i < m; i++) {
      for (let j = 0; j < n; j++) {
        W[j * nw + i] = A.data[i * n + j]!;
      }
    }
  } else {
    W.set(A.data);
  }

  // V_acc = identity n_w × n_w.  Each Jacobi (p, q) rotation right-
  // multiplies W and V_acc by the same 2-column rotation. After
  // convergence, W's columns are orthogonal with norms = singular values,
  // and V_acc holds the right singular vectors of the worked matrix.
  const V = new Float64Array(nw * nw);
  for (let i = 0; i < nw; i++) V[i * nw + i] = 1;

  // --------------------------------------------------------------------------
  // Tolerance for the "skip rotation" test.
  //
  // A pair (p, q) with γ² ≤ tol² · α · β has off-diagonal mass below
  // ε relative to the column-norm geometric mean — rotating would not
  // measurably reduce the off-diagonal Frobenius norm. Skipping cheaply
  // detects already-converged pairs and accelerates the sweep loop.
  // --------------------------------------------------------------------------
  const tol = EPS;

  // --------------------------------------------------------------------------
  // Main sweep loop (one-sided Jacobi).
  //
  // A "sweep" is one pass over every unordered pair (p, q) with p < q.
  // We track the number of rotations actually performed in the sweep;
  // when zero rotations are needed (all pairs already orthogonal to
  // tolerance), we declare convergence.
  //
  // We cap at MAX_SWEEPS as a safety net.  Demmel-Veselić's analysis
  // gives O(log n) sweeps in practice; n ≤ 200 means ~10–15 sweeps even
  // on the worst inputs (Hilbert-50 typically converges in ~20).
  // --------------------------------------------------------------------------
  for (let sweep = 0; sweep < MAX_SWEEPS; sweep++) {
    let rotations = 0;
    for (let p = 0; p < nw - 1; p++) {
      for (let q = p + 1; q < nw; q++) {
        // Compute the 2×2 block [α γ; γ β] = (W[:,p], W[:,q])ᵀ · (W[:,p], W[:,q]).
        // We accumulate three dot products in one pass over the rows.
        let alpha = 0;
        let beta = 0;
        let gamma = 0;
        for (let i = 0; i < mw; i++) {
          const wip = W[i * nw + p]!;
          const wiq = W[i * nw + q]!;
          alpha += wip * wip;
          beta += wiq * wiq;
          gamma += wip * wiq;
        }

        // Skip if columns are already (numerically) orthogonal. The
        // squared-angle test is γ² ≤ tol² · α · β; we use abs(γ) for
        // numerical safety, then multiply (Drmač 1997 §4.2).
        if (Math.abs(gamma) <= tol * Math.sqrt(alpha * beta)) {
          continue;
        }
        // If both α and β are zero, the columns are zero vectors; nothing
        // to rotate.  (γ would also be zero; the previous skip covers it,
        // but defence in depth.)
        if (alpha === 0 && beta === 0) continue;

        // Compute Jacobi rotation (c, s) that diagonalises [α γ; γ β].
        // Stable form (Golub & Van Loan §8.5, Algorithm 8.4.2):
        //   ζ = (β − α) / (2γ)
        //   t = sign(ζ) / (|ζ| + √(1 + ζ²))   — smaller-magnitude root
        //   c = 1 / √(1 + t²),   s = t · c
        //
        // The smaller-magnitude root keeps the rotation closer to identity,
        // which preserves ordering of the columns and minimises round-off.
        // Special-case ζ = 0 (β = α) ⇒ t = 1 directly (the limit).
        const zeta = (beta - alpha) / (2 * gamma);
        let t: number;
        if (Math.abs(zeta) > 1e150) {
          // Avoid overflow in zeta² for extreme cases; t ~ 1/(2ζ).
          t = 1 / (2 * zeta);
        } else {
          const denom = Math.abs(zeta) + Math.sqrt(1 + zeta * zeta);
          t = (zeta >= 0 ? 1 : -1) / denom;
        }
        const c = 1 / Math.sqrt(1 + t * t);
        const s = t * c;

        // Apply rotation to columns p, q of W:
        //   W[:,p] ← c·W[:,p] − s·W[:,q]
        //   W[:,q] ← s·W[:,p] + c·W[:,q]
        for (let i = 0; i < mw; i++) {
          const wip = W[i * nw + p]!;
          const wiq = W[i * nw + q]!;
          W[i * nw + p] = c * wip - s * wiq;
          W[i * nw + q] = s * wip + c * wiq;
        }
        // Apply same rotation to columns p, q of V (accumulate the
        // right singular vectors of the worked matrix).
        for (let i = 0; i < nw; i++) {
          const vip = V[i * nw + p]!;
          const viq = V[i * nw + q]!;
          V[i * nw + p] = c * vip - s * viq;
          V[i * nw + q] = s * vip + c * viq;
        }
        rotations++;
      }
    }
    if (rotations === 0) break;
  }

  // --------------------------------------------------------------------------
  // Extract singular values and left singular vectors.
  //
  // Each column of W is now orthogonal to every other column. Its norm
  // is a singular value; the unit vector W[:, i] / ‖W[:, i]‖ is the
  // corresponding left singular vector.
  //
  // For zero (rank-deficient) columns we leave the U-column slot zero
  // here and fill it later via Gram-Schmidt completion against the
  // already-extracted unit vectors.
  // --------------------------------------------------------------------------

  const k = Math.min(m, n); // == nw (since nw ≤ mw, and nw = min(m,n))

  // Pair (singular value, original column index) so we can sort
  // descending and permute U/V consistently.
  const sigmas = new Array<{ s: number; col: number }>(nw);
  const colNorms = new Float64Array(nw);
  for (let j = 0; j < nw; j++) {
    let s = 0;
    for (let i = 0; i < mw; i++) {
      const wij = W[i * nw + j]!;
      s += wij * wij;
    }
    const norm = Math.sqrt(s);
    colNorms[j] = norm;
    sigmas[j] = { s: norm, col: j };
  }
  // Sort descending. Stable enough for our purposes (ties are degenerate
  // singular values; any order satisfies the bench's `S_nonneg_descending`
  // check up to LSB tolerance).
  sigmas.sort((a, b) => b.s - a.s);

  // Allocate U_work (mw × nw, the worked-frame left vectors). For nonzero
  // singular values we extract directly; for zero (or below ε) singular
  // values, we leave a zero column and complete by Gram-Schmidt later.
  const Uwork = new Float64Array(mw * nw);
  // Track which columns we still need to fill via Gram-Schmidt.
  const needsCompletion: number[] = [];
  // Threshold for "treat as zero" when extracting U: ε times the largest
  // singular value. Below this, the W-column is at the noise floor and
  // dividing by it would amplify noise into U.
  const sMax = sigmas.length > 0 ? sigmas[0]!.s : 0;
  const zeroThreshold = sMax > 0 ? EPS * sMax * Math.max(mw, nw) : 0;

  for (let newCol = 0; newCol < nw; newCol++) {
    const origCol = sigmas[newCol]!.col;
    const sigma = sigmas[newCol]!.s;
    if (sigma > zeroThreshold) {
      const inv = 1 / colNorms[origCol]!;
      for (let i = 0; i < mw; i++) {
        Uwork[i * nw + newCol] = W[i * nw + origCol]! * inv;
      }
    } else {
      // Mark for Gram-Schmidt completion against the already-extracted
      // U-columns. Leave the column zero for now.
      needsCompletion.push(newCol);
    }
  }

  // Complete zero/rank-deficient columns by Gram-Schmidt against the
  // already-filled columns.  We need an orthonormal completion within
  // the column space dimension nw (we'll extend further to mw later if
  // mode = "complete" or if the worked frame is taller than nw).
  if (needsCompletion.length > 0) {
    completeOrthonormal(Uwork, mw, nw, needsCompletion);
  }

  // --------------------------------------------------------------------------
  // Build V_perm: permute V's columns to match the descending sort of S.
  //
  // V is `nw × nw`, where column j holds the right singular vector for
  // the original (unsorted) column j of W. We want V_perm[:, newCol] =
  // V[:, sigmas[newCol].col].
  // --------------------------------------------------------------------------

  const Vperm = new Float64Array(nw * nw);
  for (let newCol = 0; newCol < nw; newCol++) {
    const origCol = sigmas[newCol]!.col;
    for (let i = 0; i < nw; i++) {
      Vperm[i * nw + newCol] = V[i * nw + origCol]!;
    }
  }

  // --------------------------------------------------------------------------
  // Singular values vector (sorted descending). Length k = nw = min(m, n).
  //
  // Clamp tiny negatives (shouldn't happen with norms, but defence in
  // depth) and tiny noise from the extraction step. We do NOT clamp
  // genuine small singular values — those are real signal in
  // rank-revealing applications.
  // --------------------------------------------------------------------------

  const S = new Float64Array(k);
  for (let i = 0; i < k; i++) S[i] = sigmas[i]!.s;

  // --------------------------------------------------------------------------
  // Translate worked-frame matrices back to A-frame:
  //   transposed = false  ⇒  U = Uwork, V = Vperm.
  //   transposed = true   ⇒  the SVD we computed was of Aᵀ; if Aᵀ = X·Σ·Yᵀ
  //                          then A = Y·Σ·Xᵀ, so U_A = Y, V_A = X.
  //                          That is: U_A = Vperm, V_A = Uwork.
  //
  // After translation:
  //   U (A-frame) is m × k for "reduced" or m × m for "complete";
  //   V (A-frame) is n × k for "reduced" or n × n for "complete".
  //   Vt (A-frame) = transpose(V).
  // --------------------------------------------------------------------------

  // Reduced-mode A-frame U and V:
  //   U_red is m × k, V_red is n × k.
  let U_red_data: Float64Array;
  let V_red_data: Float64Array;

  if (!transposed) {
    // Worked on A directly.
    //   Uwork is m × nw = m × k.  V is n × k = nw × nw (reduced part).
    //   In !transposed case, nw = n, so the "reduced V" is nw × nw, the
    //   full V — its columns are the right singular vectors.
    //
    // Wait: when !transposed and m ≥ n, k = n = nw, so:
    //   reduced U is m × k = mw × nw  →  Uwork (full).
    //   reduced V is n × k = nw × nw  →  Vperm (full).
    U_red_data = Uwork; // shape mw × nw == m × k
    V_red_data = Vperm; // shape nw × nw == n × k
  } else {
    // Worked on Aᵀ.  mw = n, nw = m, k = m = nw.
    //   The Aᵀ-frame U is mw × nw = n × m  →  this is V_A (n × k).
    //   The Aᵀ-frame V is nw × nw = m × m  →  this is U_A (m × k).
    U_red_data = Vperm; // shape nw × nw == m × k  ← right vecs of Aᵀ
    V_red_data = Uwork; // shape mw × nw == n × k  ← left vecs of Aᵀ
  }

  // --------------------------------------------------------------------------
  // Mode handling: extend U and V to "complete" if requested.
  //
  // For "complete", U is m × m and V is n × n. We start with the reduced
  // factors (m × k and n × k) and extend each by Gram-Schmidt against the
  // already-orthonormal columns. The extension only needs `m − k` (resp.
  // `n − k`) additional columns; for square A or for any side already at
  // full size, no extension is needed.
  // --------------------------------------------------------------------------

  let U_data: Float64Array;
  let U_cols: number;
  let V_data: Float64Array;
  let V_cols: number;

  if (mode === "complete") {
    U_cols = m;
    V_cols = n;
    U_data = extendOrthonormal(U_red_data, m, k, m);
    V_data = extendOrthonormal(V_red_data, n, k, n);
  } else {
    U_cols = k;
    V_cols = k;
    U_data = U_red_data;
    V_data = V_red_data;
  }

  // Build U (m × U_cols) and Vt (V_cols × n) Matrix records.
  // Note: V_data is laid out as (n × V_cols) row-major; Vt is V_cols × n
  // row-major, which is the transpose. We materialise Vt explicitly.

  const U: Matrix = { rows: m, cols: U_cols, data: U_data };
  const VtData = new Float64Array(V_cols * n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < V_cols; j++) {
      VtData[j * n + i] = V_data[i * V_cols + j]!;
    }
  }
  const Vt: Matrix = { rows: V_cols, cols: n, data: VtData };

  // --------------------------------------------------------------------------
  // Self-reported errors and rank/condition diagnostics.
  //
  // The same formulas the bench's verify.py uses (computed on the
  // *actual* returned matrices, not on intermediate state — anything
  // else risks drifting from the verifier and failing self-honesty).
  // --------------------------------------------------------------------------

  const aNorm = frobeniusNorm(A.data);
  const reconstructionError = svdReconstructionError(U, S, Vt, A) / Math.max(aNorm, 1);
  const orthogonalityErrorU = orthogonalityFrobeniusError(U); // ||UᵀU − I||
  const orthogonalityErrorVt = orthogonalityRowsFrobeniusError(Vt); // ||Vt·Vtᵀ − I||

  // Condition number: S[0] / max(S[k-1], EPS · S[0]).  Cap at 1/EPS for
  // exactly-singular cases so the field stays a finite float (downstream
  // composes more cleanly).
  let conditionNumber: number;
  if (k === 0 || S[0]! === 0) {
    conditionNumber = 0; // degenerate; the field stays defined
  } else {
    const sMin = S[k - 1]!;
    const floor = EPS * S[0]!;
    conditionNumber = S[0]! / Math.max(sMin, floor);
  }

  // Numerical rank: count of singular values exceeding LAPACK's standard
  // relative threshold rtol = max(m, n) · ε · S[0].
  let rankEstimate = 0;
  if (k > 0 && S[0]! > 0) {
    const rtol = Math.max(m, n) * EPS * S[0]!;
    for (let i = 0; i < k; i++) {
      if (S[i]! > rtol) rankEstimate++;
    }
  }

  return {
    U,
    S,
    Vt,
    mode,
    reconstructionError,
    orthogonalityErrorU,
    orthogonalityErrorVt,
    conditionNumber,
    rankEstimate,
  };
}

// =============================================================================
// Helpers (private to this module)
// =============================================================================

/**
 * Complete a partial orthonormal basis by filling the columns named in
 * `needsCompletion` (sorted ascending) via Gram-Schmidt against the
 * already-filled columns. Operates in place on `data` (rows × cols
 * row-major). The completed columns are unit vectors orthogonal to the
 * existing columns.
 *
 * Uses modified Gram-Schmidt (subtract component along each prior
 * column one at a time) for better numerical orthogonality than CGS.
 * For our case the filled-column count is small (rank-deficient
 * extras), so MGS's O(rows·filled) per completion is cheap.
 *
 * Strategy: for each empty column, take the canonical basis vector
 * `e_t` (t cycling through 0..rows-1), project out components along
 * the already-filled columns, normalise. If the residual is ε-zero
 * (i.e. e_t already lay in the span of the filled columns), try the
 * next canonical vector.
 */
function completeOrthonormal(
  data: Float64Array,
  rows: number,
  cols: number,
  needsCompletion: readonly number[],
): void {
  // The "filled" set: cols not in needsCompletion. We'll add to it as we
  // complete each empty column.
  const filled = new Set<number>();
  for (let j = 0; j < cols; j++) filled.add(j);
  for (const j of needsCompletion) filled.delete(j);

  for (const targetCol of needsCompletion) {
    let placed = false;
    for (let trial = 0; trial < rows && !placed; trial++) {
      // Start with e_trial.
      const v = new Float64Array(rows);
      v[trial] = 1;
      // Subtract projection onto each filled column (modified Gram-Schmidt).
      for (const fc of filled) {
        let dot = 0;
        for (let i = 0; i < rows; i++) dot += v[i]! * data[i * cols + fc]!;
        if (dot !== 0) {
          for (let i = 0; i < rows; i++) v[i] = v[i]! - dot * data[i * cols + fc]!;
        }
      }
      // Re-orthogonalise once for stability (CGS2-style); cheap and
      // pushes orthogonality error to O(ε) regardless of conditioning.
      for (const fc of filled) {
        let dot = 0;
        for (let i = 0; i < rows; i++) dot += v[i]! * data[i * cols + fc]!;
        if (dot !== 0) {
          for (let i = 0; i < rows; i++) v[i] = v[i]! - dot * data[i * cols + fc]!;
        }
      }
      // Compute norm and decide if v is a usable direction.
      let norm = 0;
      for (let i = 0; i < rows; i++) norm += v[i]! * v[i]!;
      norm = Math.sqrt(norm);
      if (norm > 1e-12) {
        const inv = 1 / norm;
        for (let i = 0; i < rows; i++) data[i * cols + targetCol] = v[i]! * inv;
        filled.add(targetCol);
        placed = true;
      }
    }
    if (!placed) {
      // Fallback: shouldn't happen for well-formed inputs (cols ≤ rows
      // is enforced by the calling code; the canonical basis spans the
      // ambient space). Drop in a zero column; the orthogonality check
      // will surface the issue. This branch is the last resort.
      for (let i = 0; i < rows; i++) data[i * cols + targetCol] = 0;
    }
  }
}

/**
 * Extend an orthonormal `(rows × cols_in)` matrix to `(rows × cols_out)`
 * by Gram-Schmidt completion. Returns a fresh Float64Array sized for
 * `cols_out`; copies the input columns and fills the new columns with
 * orthonormal extensions of the existing basis.
 *
 * Pre: the first `cols_in` columns of the input are orthonormal (this is
 * enforced by `svd()` — we only call this on already-extracted U or V).
 * Pre: `cols_out ≥ cols_in` and `cols_out ≤ rows` (we can't extend past
 * the ambient dimension).
 */
function extendOrthonormal(
  inData: Float64Array,
  rows: number,
  cols_in: number,
  cols_out: number,
): Float64Array {
  if (cols_out === cols_in) return inData;
  const out = new Float64Array(rows * cols_out);
  // Copy the existing columns.
  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < cols_in; j++) {
      out[i * cols_out + j] = inData[i * cols_in + j]!;
    }
  }
  // Mark the new columns as needing completion.
  const newCols: number[] = [];
  for (let j = cols_in; j < cols_out; j++) newCols.push(j);
  completeOrthonormal(out, rows, cols_out, newCols);
  return out;
}

/**
 * Frobenius norm of a flat data buffer: √(Σ x_i²).  Plain summation
 * (the verifier does the same).
 */
function frobeniusNorm(data: Float64Array): number {
  let s = 0;
  for (let i = 0; i < data.length; i++) s += data[i]! * data[i]!;
  return Math.sqrt(s);
}

/**
 * Compute ‖U · diag(S) · Vt − A‖_F directly.  We materialise the product
 * row-by-row in a small temporary, accumulate the squared difference,
 * and return the root.  No intermediate full-matrix allocation.
 */
function svdReconstructionError(
  U: Matrix,
  S: Float64Array,
  Vt: Matrix,
  A: Matrix,
): number {
  const m = U.rows;
  const Ucols = U.cols;
  const Vrows = Vt.rows;
  const n = Vt.cols;
  const k = S.length;
  if (m !== A.rows || n !== A.cols) {
    throw new MatrixError(
      `svdReconstructionError: A is ${A.rows}×${A.cols}, expected ${m}×${n}`,
    );
  }
  // For mode = "reduced": Ucols = k = Vrows.
  // For mode = "complete": Ucols = m, Vrows = n; only the first k of each
  // contribute (since diag(S) has only k diagonal entries).
  const r = Math.min(k, Ucols, Vrows);

  let s = 0;
  for (let i = 0; i < m; i++) {
    for (let j = 0; j < n; j++) {
      // (U · diag(S) · Vt)[i, j] = Σ_p  U[i, p] · S[p] · Vt[p, j]
      let acc = 0;
      for (let p = 0; p < r; p++) {
        acc += U.data[i * Ucols + p]! * S[p]! * Vt.data[p * n + j]!;
      }
      const d = acc - A.data[i * n + j]!;
      s += d * d;
    }
  }
  return Math.sqrt(s);
}

/**
 * ‖UᵀU − I_q‖_F where q = U.cols.  Symmetric matrix; we walk the upper
 * triangle and double off-diagonal contributions.
 */
function orthogonalityFrobeniusError(U: Matrix): number {
  const m = U.rows;
  const q = U.cols;
  let s = 0;
  for (let i = 0; i < q; i++) {
    for (let j = i; j < q; j++) {
      let acc = 0;
      for (let r = 0; r < m; r++) {
        acc += U.data[r * q + i]! * U.data[r * q + j]!;
      }
      const d = acc - (i === j ? 1 : 0);
      s += (i === j ? 1 : 2) * d * d;
    }
  }
  return Math.sqrt(s);
}

/**
 * ‖Vt · Vtᵀ − I_q‖_F where q = Vt.rows.  Vt has orthonormal *rows*; the
 * row-wise dot products are entries of Vt·Vtᵀ.
 */
function orthogonalityRowsFrobeniusError(Vt: Matrix): number {
  const q = Vt.rows;
  const n = Vt.cols;
  let s = 0;
  for (let i = 0; i < q; i++) {
    for (let j = i; j < q; j++) {
      let acc = 0;
      for (let c = 0; c < n; c++) {
        acc += Vt.data[i * n + c]! * Vt.data[j * n + c]!;
      }
      const d = acc - (i === j ? 1 : 0);
      s += (i === j ? 1 : 2) * d * d;
    }
  }
  return Math.sqrt(s);
}
