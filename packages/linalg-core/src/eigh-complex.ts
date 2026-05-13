// =============================================================================
// eigh-complex.ts — Hermitian eigendecomposition via real-symplectic embedding
// =============================================================================
//
// Intent
// ------
// Compute `H = Q · diag(λ) · Q†` for a complex Hermitian `n × n` matrix
// `H = A + iB` where `Q` is `n × n` unitary, `Q†` its conjugate
// transpose, and `λ` a length-n real vector sorted ascending (LAPACK /
// `np.linalg.eigh` convention). The columns of `Q` are eigenvectors
// paired with `λ`.
//
// The algorithm is the **real-symplectic embedding** (Goedecker 1999;
// Day & Heroux 2001): map the complex Hermitian problem to a 2n × 2n
// real-symmetric problem and run the existing cyclic-Jacobi `eigh`. This
// reuses every line of `eigh.ts` — zero new spectral code — at the cost
// of 8× flops and 4× memory relative to a hypothetical native-complex
// Householder + complex implicit-shift QR (deferred to a v0.2 follow-
// up). For the scales the qinfo + workbench callers reach (n ≤ 256
// dense, comfortably under the `assessNumericalScale` warning floor)
// the embedding cost is invisible.
//
// The embedding identity
// ----------------------
// For `H = A + iB` complex `n × n` Hermitian:
//   - `A` is real-symmetric (`H = H†` ⟹ `Aᵀ = A`)
//   - `B` is real-antisymmetric (`H = H†` ⟹ `Bᵀ = −B`)
//
// Define the 2n × 2n real matrix
//
//     H̃ = ⎡  A   -B ⎤
//          ⎣  B    A ⎦
//
// `H̃ᵀ = [[Aᵀ, Bᵀ]; [-Bᵀ, Aᵀ]] = [[A, -B]; [B, A]] = H̃`, so `H̃` is
// real-symmetric and has a real-orthogonal eigendecomposition.
//
// Spectrum correspondence
// -----------------------
// If `H · q = λ · q` with complex `q = u + i w` and real `λ`, then
//
//     [[A, -B]; [B, A]] · [u; w] = [A u − B w; B u + A w]
//                                = [λ u; λ w]      (since H · q = λ · q)
//
// So `v = (u, w) ∈ ℝ^{2n}` is a real eigenvector of `H̃` with eigenvalue
// `λ`. The map `J: (u, w) ↦ (−w, u)` (symplectic conjugation) commutes
// with `H̃`, so `J v = (−w, u)` is also a real eigenvector with the
// *same* eigenvalue `λ`. Hence every eigenvalue of `H` appears with
// **multiplicity 2** in `H̃`'s spectrum.
//
// In the other direction, given a real eigenvector `v = (u, w)` of `H̃`
// with eigenvalue `λ`, the complex vector `q = u + i w` satisfies
//
//     H q = (A + iB)(u + iw)
//         = (A u − B w) + i (B u + A w)
//         = λ u + i λ w
//         = λ q       ✓
//
// so `q` is a complex eigenvector of `H`. By the Hermitian spectral
// theorem `λ ∈ ℝ`; that real-eigenvalue guarantee is what makes the
// embedding faithful.
//
// Reconstruction
// --------------
// Real `eigh(H̃)` returns a 2n × 2n orthogonal `Q̃` and a sorted real
// vector `λ̃ ∈ ℝ^{2n}` with `λ̃[2k] = λ̃[2k+1]` (mod numerical noise)
// for k = 0, …, n−1. We:
//
//   1. Take every other eigenvalue: `λ[k] = λ̃[2k]` for k = 0, …, n−1.
//   2. Take the corresponding column of `Q̃` and split it: column `2k`
//      is `(u_k, w_k)` with `u_k ∈ ℝ^n` the top half, `w_k ∈ ℝ^n` the
//      bottom half. Set `Q[:, k] = u_k + i w_k` ∈ ℂ^n.
//   3. Re-orthogonalise `Q` via complex Modified Gram-Schmidt (one
//      pass). The non-degenerate eigenvalues of `H` give already-
//      complex-orthogonal columns by the spectral theorem (a real-
//      orthogonal `v_a ⊥ v_b` plus `v_a ⊥ J v_b` cancels both the real
//      and imaginary parts of `q_a* q_b`). For *degenerate* eigenvalues
//      of `H` — multiplicity > 1 — real `eigh` returns an arbitrary
//      orthonormal basis of the 2m-dimensional embedded eigenspace, and
//      adjacent pairs need not be `J`-related; the MGS pass cleans
//      this up. Within a degenerate eigenspace any orthonormal basis is
//      a valid eigenvector basis, so MGS does not increase the
//      reconstruction error.
//
// References
//   * Goedecker, "Linear scaling electronic structure methods", Rev.
//     Mod. Phys. 71:1085-1123, 1999 — §III.A introduces the embedding
//     in the DFT context.
//   * Day & Heroux, "Solving complex-valued linear systems via
//     equivalent real formulations", SIAM J. Sci. Comput.
//     23(2):480-498, 2001 — backward-stability analysis of the
//     embedding for general complex problems.
//   * Higham, *Accuracy and Stability of Numerical Algorithms*, 2nd
//     ed., SIAM 2002 — §10 (complex matrices), §20.6 (symmetric
//     eigenproblem backward stability — inherited verbatim through the
//     embedding).
//   * Watrous, *Theory of Quantum Information*, Cambridge 2018 — §1.1
//     for the Hermitian-eigendecomposition role in quantum-info
//     workflows.

import { type Matrix, MatrixError } from "./matrix.js";
import { eigh } from "./eigh.js";
import {
  type ComplexMatrix,
  complexFrobeniusNorm,
  complexMatmul,
} from "./complex-matrix.js";

const EPS = Number.EPSILON;

/**
 * Result of a successful complex-Hermitian eigendecomposition
 * `H = Q · diag(λ) · Q†`.
 *
 * Field semantics:
 *   * `Q`: complex `n × n` unitary; column `i` is the eigenvector for
 *     `eigenvalues[i]`.
 *   * `eigenvalues`: length-n **real** vector, sorted ascending.
 *     Hermitian eigenvalues are real by spectral theorem; emitting
 *     them as a real `Float64Array` (not a complex pair) reflects
 *     that honestly.
 *   * `reconstructionError`: `‖H·Q − Q·diag(λ)‖_F / max(‖H‖_F, 1)` in
 *     complex arithmetic.
 *   * `orthogonalityError`: `‖Q† Q − I_n‖_F` where `Q†` is the complex
 *     conjugate transpose.
 *   * `conditionNumber`: `|λ_max| / max(|λ_min|, EPS · |λ_max|)`.
 *     Capped to a finite float for indefinite or singular `H`.
 *
 * The errors are the candidate's agent-honest self-report (ADR-0014
 * pattern; ADR-0035 §D7).
 */
export type EighComplexResult = {
  readonly Q: ComplexMatrix;
  readonly eigenvalues: Float64Array;
  readonly reconstructionError: number;
  readonly orthogonalityError: number;
  readonly conditionNumber: number;
};

/**
 * Compute the Hermitian eigendecomposition of `H` by real-symplectic
 * embedding. Returns `{Q, eigenvalues, …}` with eigenvalues sorted
 * ascending and `Q` complex-unitary.
 *
 * Throws `MatrixError` on degenerate-storage corners (`n = 0`, or `re`
 * / `im` shape mismatch with each other or with `rows × cols`). The
 * tool layer catches these earlier with a tagged boundary or
 * `ToolError`; this guard is defence in depth.
 *
 * Hermiticity of `H` is the **caller's contract**: if the input is not
 * Hermitian the algorithm runs but the resulting `Q` / `λ` will not
 * satisfy `H · Q ≈ Q · diag(λ)` (the reported `reconstructionError`
 * will be large, and the embedded real-eigh will see an asymmetric
 * `H̃`, so its Jacobi rotations operate on the symmetric part
 * implicitly — same caveat as the real eigh). The tool layer rejects
 * non-Hermitian input via the `linalg-eigh-complex/non-hermitian-input`
 * boundary tag before reaching here.
 */
export function eighComplex(H: ComplexMatrix): EighComplexResult {
  const n = H.rows;
  if (n === 0) {
    throw new MatrixError(`eighComplex: degenerate shape (${n}×${H.cols})`);
  }
  if (H.cols !== n) {
    throw new MatrixError(`eighComplex: not square (${n}×${H.cols})`);
  }
  if (H.re.length !== n * n || H.im.length !== n * n) {
    throw new MatrixError(
      `eighComplex: storage mismatch — expected ${n * n}, got re=${H.re.length} im=${H.im.length}`,
    );
  }

  // --------------------------------------------------------------------------
  // Build H̃ = [[A, -B], [B, A]] as a 2n × 2n row-major real matrix.
  //
  // For `i, j ∈ [0, n)`:
  //   top-left     H̃[i, j]         = A[i, j]      = H.re[i*n + j]
  //   top-right    H̃[i, n+j]       = -B[i, j]     = -H.im[i*n + j]
  //   bottom-left  H̃[n+i, j]       =  B[i, j]     = +H.im[i*n + j]
  //   bottom-right H̃[n+i, n+j]     = A[i, j]      = H.re[i*n + j]
  //
  // The stride is `tildeN = 2n` for row offsets. Allocation is one
  // contiguous Float64Array; no nested-array overhead.
  // --------------------------------------------------------------------------

  const tildeN = 2 * n;
  const tildeData = new Float64Array(tildeN * tildeN);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const idx = i * n + j;
      const a = H.re[idx]!;
      const b = H.im[idx]!;
      tildeData[i * tildeN + j] = a;
      tildeData[i * tildeN + (n + j)] = -b;
      tildeData[(n + i) * tildeN + j] = b;
      tildeData[(n + i) * tildeN + (n + j)] = a;
    }
  }
  const tilde: Matrix = { rows: tildeN, cols: tildeN, data: tildeData };

  // --------------------------------------------------------------------------
  // Run the existing real cyclic-Jacobi eigh on H̃. Returns Q̃ (2n × 2n
  // real-orthogonal) and λ̃ (length 2n, sorted ascending) with each
  // distinct eigenvalue of H appearing as a pair λ̃[2k] = λ̃[2k+1].
  // --------------------------------------------------------------------------

  const tildeResult = eigh(tilde);

  // --------------------------------------------------------------------------
  // Lift to complex: take every other eigenvalue + column, split column
  // into top half `u` and bottom half `w`, set complex eigenvector
  // q_k = u + i w in column k of Q.
  //
  // For column index `idxTilde` of Q̃ (row-major access: Q̃[r, c] =
  // tildeQ.data[r * tildeN + c]):
  //   u[r] = Q̃[r, idxTilde]         for r ∈ [0, n)
  //   w[r] = Q̃[n + r, idxTilde]     for r ∈ [0, n)
  // --------------------------------------------------------------------------

  const eigenvalues = new Float64Array(n);
  const qRe = new Float64Array(n * n);
  const qIm = new Float64Array(n * n);

  for (let k = 0; k < n; k++) {
    const idxTilde = 2 * k;
    eigenvalues[k] = tildeResult.eigenvalues[idxTilde]!;
    for (let r = 0; r < n; r++) {
      qRe[r * n + k] = tildeResult.Q.data[r * tildeN + idxTilde]!;
      qIm[r * n + k] = tildeResult.Q.data[(n + r) * tildeN + idxTilde]!;
    }
  }

  // --------------------------------------------------------------------------
  // Complex Modified Gram-Schmidt on Q's columns. The non-degenerate-
  // eigenvalue case already has complex-orthonormal columns by the
  // spectral theorem; this pass is for the degenerate case where real
  // eigh's arbitrary in-eigenspace basis can give complex-non-
  // orthonormal extracted q_k. Within a degenerate eigenspace, any
  // linear combination is still an eigenvector, so the orthogonality
  // error drops without inflating the reconstruction error.
  //
  // One pass is enough: Q starts O(ε) from orthonormal in the non-
  // degenerate case (so MGS is a no-op modulo round-off), and exactly
  // unitary in the degenerate case (the columns lie in a span whose
  // dimension equals the eigenvalue's multiplicity in H, so MGS
  // produces a valid unitary basis of that span).
  // --------------------------------------------------------------------------

  complexMGSInPlace(qRe, qIm, n);

  const Q: ComplexMatrix = { rows: n, cols: n, re: qRe, im: qIm };

  // --------------------------------------------------------------------------
  // Diagnostics: reconstruction, orthogonality, condition number.
  //
  // reconstruction_error = ||H·Q − Q·diag(λ)||_F / max(||H||_F, 1)
  //   uses complexMatmul + a custom Q·diag(λ) row-scale (no full
  //   diagonal materialisation).
  //
  // orthogonality_error  = ||Q† Q − I||_F using a column-pair inner
  //   product (avoids materialising Q† Q in full).
  //
  // condition_number     = |λ_max| / max(|λ_min|, EPS · |λ_max|) on
  //   the absolute eigenvalues — same formula as real eigh.
  // --------------------------------------------------------------------------

  const hNorm = complexFrobeniusNorm(H);
  const recon = eighComplexReconstructionError(H, Q, eigenvalues);
  const reconstructionError = recon / Math.max(hNorm, 1);
  const orthogonalityError = complexOrthogonalityError(Q);

  let lamMax = 0;
  let lamMin = Infinity;
  for (let i = 0; i < n; i++) {
    const a = Math.abs(eigenvalues[i]!);
    if (a > lamMax) lamMax = a;
    if (a < lamMin) lamMin = a;
  }
  let conditionNumber: number;
  if (lamMax === 0) {
    conditionNumber = 0;
  } else if (lamMin > 0) {
    conditionNumber = lamMax / lamMin;
  } else {
    conditionNumber = lamMax / (EPS * lamMax);
  }

  return {
    Q,
    eigenvalues,
    reconstructionError,
    orthogonalityError,
    conditionNumber,
  };
}

// =============================================================================
// Helpers (private to this module)
// =============================================================================

/**
 * In-place complex Modified Gram-Schmidt on a square `n × n` matrix
 * stored as parallel `(re, im)` row-major Float64Arrays. Column `k` is
 * orthogonalised against columns `0, …, k-1` and then normalised. The
 * complex inner product is
 *
 *     ⟨a, b⟩ = Σ_r conj(a[r]) · b[r]
 *            = Σ_r (a.re[r] · b.re[r] + a.im[r] · b.im[r])
 *              + i Σ_r (a.re[r] · b.im[r] − a.im[r] · b.re[r])
 *
 * For a column `q_k` that's already nearly unit-norm (the
 * non-degenerate case), MGS modifies it by O(ε); for a degenerate
 * eigenvalue's columns the modification is structural (canonicalising
 * the in-eigenspace basis) but preserves the eigenvector property.
 *
 * If a column's norm collapses (`< 1e-300`), we leave it in place
 * unscaled — this should never happen on the inputs the tool admits
 * (the embedded real eigh already orthonormalises within precision),
 * and is guarded against only for paranoia.
 */
function complexMGSInPlace(re: Float64Array, im: Float64Array, n: number): void {
  for (let k = 0; k < n; k++) {
    // Subtract projections onto each earlier column.
    for (let j = 0; j < k; j++) {
      let pRe = 0;
      let pIm = 0;
      // ⟨q_j, q_k⟩ = Σ_r conj(q_j[r]) · q_k[r]
      for (let r = 0; r < n; r++) {
        const qjRe = re[r * n + j]!;
        const qjIm = im[r * n + j]!;
        const qkRe = re[r * n + k]!;
        const qkIm = im[r * n + k]!;
        pRe += qjRe * qkRe + qjIm * qkIm;
        pIm += qjRe * qkIm - qjIm * qkRe;
      }
      // q_k ← q_k − ⟨q_j, q_k⟩ · q_j
      // Multiply: (pRe + i pIm) · (q_j.re + i q_j.im)
      //         = (pRe · q_j.re − pIm · q_j.im) + i (pRe · q_j.im + pIm · q_j.re)
      for (let r = 0; r < n; r++) {
        const qjRe = re[r * n + j]!;
        const qjIm = im[r * n + j]!;
        const subRe = pRe * qjRe - pIm * qjIm;
        const subIm = pRe * qjIm + pIm * qjRe;
        re[r * n + k] = re[r * n + k]! - subRe;
        im[r * n + k] = im[r * n + k]! - subIm;
      }
    }
    // Normalise q_k.
    let sq = 0;
    for (let r = 0; r < n; r++) {
      const a = re[r * n + k]!;
      const b = im[r * n + k]!;
      sq += a * a + b * b;
    }
    const norm = Math.sqrt(sq);
    if (norm > 1e-300) {
      const invNorm = 1 / norm;
      for (let r = 0; r < n; r++) {
        re[r * n + k] = re[r * n + k]! * invNorm;
        im[r * n + k] = im[r * n + k]! * invNorm;
      }
    }
  }
}

/**
 * Compute `‖H · Q − Q · diag(λ)‖_F` directly without materialising the
 * intermediate. The expression decomposes element-wise to:
 *
 *     (HQ)[i, j] − (Q · diag(λ))[i, j]  =  (HQ)[i, j] − λ[j] · Q[i, j]
 *
 * which is complex-valued; we sum `|·|² = re² + im²` over `(i, j)` and
 * take the square root.
 */
function eighComplexReconstructionError(
  H: ComplexMatrix,
  Q: ComplexMatrix,
  lam: Float64Array,
): number {
  const HQ = complexMatmul(H, Q);
  const n = Q.rows;
  let s = 0;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const idx = i * n + j;
      const dRe = HQ.re[idx]! - lam[j]! * Q.re[idx]!;
      const dIm = HQ.im[idx]! - lam[j]! * Q.im[idx]!;
      s += dRe * dRe + dIm * dIm;
    }
  }
  return Math.sqrt(s);
}

/**
 * Compute `‖Q† Q − I_n‖_F` directly by walking pairs `(i, j)` of columns
 * and accumulating the column inner product
 *
 *     ⟨q_i, q_j⟩ = Σ_r conj(q_i[r]) · q_j[r]
 *
 * subtracting `δ_{ij}`, and summing `|·|²` with the off-diagonal pairs
 * counted twice (Hermitian symmetry of `Q† Q − I`).
 *
 * For a perfectly unitary `Q`, every diagonal `⟨q_i, q_i⟩ = 1` and
 * every off-diagonal `⟨q_i, q_j⟩ = 0`, so the result is exactly 0.
 */
function complexOrthogonalityError(Q: ComplexMatrix): number {
  const n = Q.cols;
  const rows = Q.rows;
  let s = 0;
  for (let i = 0; i < n; i++) {
    for (let j = i; j < n; j++) {
      let aRe = 0;
      let aIm = 0;
      for (let r = 0; r < rows; r++) {
        const qiRe = Q.re[r * n + i]!;
        const qiIm = Q.im[r * n + i]!;
        const qjRe = Q.re[r * n + j]!;
        const qjIm = Q.im[r * n + j]!;
        aRe += qiRe * qjRe + qiIm * qjIm;
        aIm += qiRe * qjIm - qiIm * qjRe;
      }
      const dRe = aRe - (i === j ? 1 : 0);
      const dIm = aIm;
      const mag2 = dRe * dRe + dIm * dIm;
      s += i === j ? mag2 : 2 * mag2;
    }
  }
  return Math.sqrt(s);
}
