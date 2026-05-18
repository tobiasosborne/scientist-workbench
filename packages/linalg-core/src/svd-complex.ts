// =============================================================================
// svd-complex.ts — Singular Value Decomposition of a complex m × n matrix
// =============================================================================
//
// Intent
// ------
// Compute the SVD
//
//     M = U · diag(σ) · V†                          (M ∈ ℂ^{m×n})
//
// for a complex matrix `M`. `U ∈ ℂ^{m×k}`, `V ∈ ℂ^{n×k}`, `σ ∈ ℝ^k`
// non-negative descending, where `k = min(m, n)` for reduced mode and
// the factors extend to `m × m` / `n × n` orthonormal completions for
// complete mode. `V†` is the **conjugate transpose** of `V` (`V_hermitian`,
// NumPy `Vh`).
//
// Why one-sided Jacobi (not the real-symplectic embedding)
// --------------------------------------------------------
// ADR-0035 §D8: *"the symplectic embedding buys nothing for SVD."* The
// embedding trick that works for Hermitian eigh — `H̃ = [[A, -B]; [B, A]]`
// with eigenvalues paired `{λ_k, λ_k}` — does **not** carry the SVD's
// distinct `U` / `V` structure: the analogous 2m × 2n real-embedded SVD
// produces singular values paired with messy interleaving and does not
// shortcut the algorithm. Native complex SVD via **one-sided Jacobi**
// (Hari & Veselić 1987, "On Jacobi methods for singular value
// decompositions", SIAM J. Sci. Stat. Comp. 8(5):741-754) is the cleaner
// path: it composes complex Jacobi rotations directly on the columns of
// `M`, retains the relative-accuracy property of real Jacobi (Demmel &
// Veselić 1992), and ships in ~250 LOC including diagnostics.
//
// Algorithm
// ---------
// One-sided Jacobi diagonalises `M† M` *implicitly* by complex unitary
// column rotations of `M`. The key identity: if `M = U · Σ · V†`, then
// `M† M = V · Σ² · V†`, so a sequence of right-rotations `V` that
// orthogonalises the columns of `M · V` reveals both `Σ` (column norms)
// and `U` (normalised orthogonal columns).
//
// Setup. Work on the *taller* of `M` and `M†`. If `m ≥ n`, work on `M`
// directly; if `m < n`, work on `M†` (size n × m) and swap `U ↔ V` at
// the end (because the SVD of `M†` is `V · Σ · U†`, so the "left
// singular vectors of M†" are `V` of `M` and vice versa). The algorithm
// wants the worked-on matrix to have at least as many rows as columns so
// its columns can be made mutually orthogonal.
//
// Per-pair update for column indices `(p, q)`, `p < q < n_w`:
//
//   1. Form the 2×2 Gram-matrix entries:
//        α = ⟨W[:,p], W[:,p]⟩  (real, ≥ 0)         the squared p-norm
//        β = ⟨W[:,q], W[:,q]⟩  (real, ≥ 0)         the squared q-norm
//        γ = ⟨W[:,p], W[:,q]⟩ = Σ_i conj(W[i,p]) · W[i,q]   (complex)
//
//   2. Convergence test (Drmač 1997 §4.2): if `|γ|² ≤ ε² · α · β`, the
//      column pair is already (numerically) orthogonal — skip without
//      rotating. This is the load-bearing per-pair tolerance: an
//      ε-relative test rather than an ε-absolute one preserves relative
//      accuracy across many orders of magnitude in the singular values.
//
//   3. Phase extraction (the complex-specific step that real Jacobi
//      doesn't need). Choose `e^{-iθ} = conj(γ) / |γ|` so that
//      `γ' = e^{-iθ} · γ = |γ|` is real and non-negative. Applying the
//      complex-diagonal factor `diag(1, e^{-iθ})` to the right of W
//      multiplies column q by `e^{-iθ}`, making the new ⟨p, q⟩ inner
//      product real. The Gram matrix is now `[[α, |γ|], [|γ|, β]]` —
//      a real-symmetric 2×2.
//
//   4. Real Jacobi rotation on the now-real Gram matrix (Demmel-Veselić
//      tangent recipe):
//        ζ = (β − α) / (2|γ|)
//        t = sgn(ζ) / (|ζ| + sqrt(1 + ζ²))     (the tangent — pick the
//                                                smaller-magnitude root
//                                                for stability)
//        c = 1 / sqrt(1 + t²)                  (cos)
//        s = t · c                              (sin)
//
//      For huge `|ζ|` (the near-diagonal case where α ≈ β makes the
//      naive denominator hide a cancellation) the standard fallback
//      `t = 1 / (2ζ)` is used.
//
//   5. Apply the combined complex rotation
//        U_pq = [[c,    -s · e^{iθ} ],
//                [s · e^{-iθ},   c  ]]
//      to columns p and q of W (i.e. right-multiply by U_pq):
//
//        W[:, p] ← c · W[:, p] − s · e^{-iθ} · W[:, q]
//        W[:, q] ← s · W[:, p] + c · e^{-iθ} · W[:, q]
//
//      and the same update to the accumulator V's columns. (`V` starts
//      as the n_w × n_w complex identity; at convergence its columns
//      are the right singular vectors of W, modulo column permutation
//      to sort σ descending.)
//
// Convergence. The off-diagonal mass `Σ_{p < q} |⟨W[:,p], W[:,q]⟩|²`
// decreases monotonically each rotation (Hari-Veselić 1987 §3,
// generalising Jacobi 1846). Empirical bounds give convergence in
// O(log n) sweeps to machine precision; we cap at 60 (the same cap real
// Jacobi uses) and warn on truncation.
//
// Post-processing.
//   * Column norms of W at convergence are the singular values:
//     σ_j = sqrt(⟨W[:,j], W[:,j]⟩).
//   * Left singular vectors: U_work[:, j] = W[:, j] / σ_j (complex
//     normalisation). For columns with σ_j below the rank-revealing
//     threshold (max(m, n) · ε · σ_max), the orthonormalisation is
//     completed via complex modified Gram-Schmidt against the already-
//     placed columns.
//   * Permute by descending σ.
//   * If we worked on M† (m < n branch), swap (U_work, V) ↔ (V_final,
//     U_final).
//   * For complete mode, extend U_final and V_final to square m × m
//     and n × n unitaries via complex Gram-Schmidt completion.
//
// Determinism and stability
// -------------------------
// `numerical: true` (ADR-0015). The platform fingerprint is recorded
// in the provenance record on every successful run, exactly as for real
// `svd`. Complex Jacobi rotations compose deterministic field
// arithmetic (real `c`, `s` from a sqrt-tangent recipe; complex phase
// from a divide-by-magnitude); no new sources of float nondeterminism
// are introduced over the real-Jacobi baseline. Demmel-Veselić's
// relative-accuracy theorem carries over: small singular values of a
// well-scaled `M` are computed with high *relative* accuracy, not
// merely absolute — a property the LAPACK DGESVD path does not provide.
//
// References
//   * Jacobi, C. G. J. (1846), "Über ein leichtes Verfahren die in der
//     Theorie der Säcularstörungen vorkommenden Gleichungen numerisch
//     aufzulösen", Crelle J. 30:51-94. The original Jacobi method.
//   * Forsythe & Henrici (1960), "The cyclic Jacobi method for computing
//     the principal values of a complex matrix", Trans. AMS 94:1-23.
//     The first complex-matrix Jacobi SVD.
//   * Brent & Luk (1985), "The solution of singular-value and symmetric
//     eigenvalue problems on multiprocessor arrays", SIAM J. Sci. Stat.
//     Comput. 6(1):69-84. The one-sided variant used here.
//   * Hari & Veselić (1987), "On Jacobi methods for singular value
//     decompositions", SIAM J. Sci. Stat. Comp. 8(5):741-754. The
//     convergence proof for complex one-sided Jacobi.
//   * Demmel & Veselić (1992), "Jacobi's method is more accurate than
//     QR", SIAM J. Matrix Anal. Appl. 13(4):1204-1245. The relative-
//     accuracy property inherited from the real Jacobi proof.
//   * Drmač, Z. (1997), "Implementation of Jacobi rotations for
//     accurate singular value computation in floating point arithmetic",
//     SIAM J. Sci. Comput. 18(4):1200-1222. The per-pair tolerance test
//     `|γ|² ≤ ε² · α · β` used here.
//   * Higham, *Accuracy and Stability of Numerical Algorithms*, 2nd ed.,
//     SIAM 2002 — §10 (complex matrices), §21 (SVD backward stability).

import { MatrixError } from "./matrix.js";
import {
  type ComplexMatrix,
  complexAdjoint,
  complexFrobeniusNorm,
  complexMatmul,
  complexZeros,
} from "./complex-matrix.js";

const EPS = Number.EPSILON;

// Sweep cap matches the real one-sided Jacobi path. The Hari-Veselić
// convergence bound gives O(log n) sweeps to machine precision; the
// generous cap catches pathological inputs (near-rank-deficient with
// extreme column scaling) without locking the loop forever.
const MAX_SWEEPS_JACOBI = 60;

/**
 * Result of a successful complex SVD factorisation `M = U · diag(S) · V†`.
 *
 * Field semantics:
 *   * `U`: complex `m × q` left singular vectors. `q = min(m, n)` for
 *     reduced mode; `q = m` for complete mode.
 *   * `S`: length-`k` real singular values, non-negative and sorted
 *     descending. `k = min(m, n)` regardless of mode (the complete-mode
 *     extra columns of U / V have σ = 0 implicitly).
 *   * `V`: complex `n × q'` right singular vectors. `q' = min(m, n)`
 *     for reduced mode; `q' = n` for complete mode. **The wire form
 *     emits `Vh = V†` (conjugate transpose)** for parity with the real
 *     tool's `Vt`; the substrate keeps `V` itself so downstream
 *     diagnostics can use `M · V` without re-conjugating.
 *   * `mode`: echoes the request.
 *   * `method`: always `"complex-one-sided-jacobi"` in v0.1. When a
 *     native bidiagonal / QR path ships, this becomes a discriminated
 *     enum schema-additively (ADR-0035 §D7 precedent for eigh).
 *   * `reconstructionError`: `‖M − U · diag(S) · V†‖_F / max(‖M‖_F, 1)`.
 *   * `orthogonalityErrorU`: `‖U† U − I_q‖_F`.
 *   * `orthogonalityErrorV`: `‖V† V − I_q'‖_F`.
 *   * `conditionNumber`: `S[0] / max(S[k-1], EPS · S[0])`. Capped at
 *     `1/EPS` for finite-arithmetic downstream consumers.
 *   * `rankEstimate`: count of `S[i] > max(m, n) · EPS · S[0]`.
 *     LAPACK-standard numerical-rank threshold.
 *
 * The errors are the agent-honest self-report (ADR-0014 pattern); a
 * bench-side verifier recomputes them against NumPy `np.linalg.svd(M)`
 * to confirm.
 */
export type SvdComplexResult = {
  readonly U: ComplexMatrix;
  readonly S: Float64Array;
  readonly V: ComplexMatrix;
  readonly mode: "reduced" | "complete";
  readonly method: "complex-one-sided-jacobi";
  readonly reconstructionError: number;
  readonly orthogonalityErrorU: number;
  readonly orthogonalityErrorV: number;
  readonly conditionNumber: number;
  readonly rankEstimate: number;
};

/**
 * Compute the singular value decomposition of `M` via complex one-sided
 * Jacobi (Hari-Veselić 1987). Returns `{U, S, V, …}` with `S` sorted
 * descending and `U`, `V` complex-unitary on their `q × q` (reduced) or
 * `m × m` / `n × n` (complete) shape.
 *
 * Throws `MatrixError` on degenerate storage (`m = 0` or `n = 0`, or
 * `re` / `im` length mismatch). The tool layer catches these earlier
 * with a tagged boundary or `ToolError`; this guard is defence in
 * depth.
 *
 * The implementation operates on a working copy of `M`; the caller's
 * matrix is never mutated.
 */
export function svdComplex(
  M: ComplexMatrix,
  mode: "reduced" | "complete" = "reduced",
): SvdComplexResult {
  const m = M.rows;
  const n = M.cols;
  if (m === 0 || n === 0) {
    throw new MatrixError(`svdComplex: degenerate shape (${m}×${n})`);
  }
  if (M.re.length !== m * n || M.im.length !== m * n) {
    throw new MatrixError(
      `svdComplex: storage mismatch — expected ${m * n}, got re=${M.re.length} im=${M.im.length}`,
    );
  }

  // ---------------------------------------------------------------------------
  // Orient the work so the worked-on matrix is at least as tall as wide.
  // If m < n, we conjugate-transpose M into W. The SVD of M† is V Σ U†,
  // so the *left* singular vectors of W (= M†) are V of M, and the
  // *right* singular vectors of W are U of M. We swap at the end.
  // ---------------------------------------------------------------------------
  const transposed = m < n;
  const mw = transposed ? n : m;
  const nw = transposed ? m : n;

  const Wre = new Float64Array(mw * nw);
  const Wim = new Float64Array(mw * nw);
  if (transposed) {
    // W = M†: W[i, j] = conj(M[j, i]) = re=M.re[j,i], im=-M.im[j,i].
    // m_w = n, n_w = m.
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < m; j++) {
        const src = j * n + i;
        const dst = i * m + j;
        Wre[dst] = M.re[src]!;
        Wim[dst] = -M.im[src]!;
      }
    }
  } else {
    Wre.set(M.re);
    Wim.set(M.im);
  }

  // V_acc = complex identity n_w × n_w. Each rotation right-multiplies W
  // and V_acc by the same complex 2-column rotation.
  const Vre = new Float64Array(nw * nw);
  const Vim = new Float64Array(nw * nw);
  for (let i = 0; i < nw; i++) Vre[i * nw + i] = 1;

  const tol = EPS;

  // ---------------------------------------------------------------------------
  // Sweep loop. Cyclic ordering: visit every unordered pair (p, q) once
  // per sweep. Early exit when no rotations fire in a full sweep.
  // ---------------------------------------------------------------------------
  let sweepsRun = 0;
  let reachedCap = false;
  for (let sweep = 0; sweep < MAX_SWEEPS_JACOBI; sweep++) {
    sweepsRun = sweep + 1;
    let rotations = 0;
    for (let p = 0; p < nw - 1; p++) {
      for (let q = p + 1; q < nw; q++) {
        // ── Gram-matrix entries for columns p and q of W ────────────────
        let alpha = 0;
        let beta = 0;
        let gammaRe = 0;
        let gammaIm = 0;
        for (let i = 0; i < mw; i++) {
          const wpRe = Wre[i * nw + p]!;
          const wpIm = Wim[i * nw + p]!;
          const wqRe = Wre[i * nw + q]!;
          const wqIm = Wim[i * nw + q]!;
          alpha += wpRe * wpRe + wpIm * wpIm;
          beta += wqRe * wqRe + wqIm * wqIm;
          // γ = Σ conj(W[:,p]) · W[:,q]
          //   = Σ (wpRe − i wpIm)(wqRe + i wqIm)
          //   = Σ (wpRe·wqRe + wpIm·wqIm) + i (wpRe·wqIm − wpIm·wqRe)
          gammaRe += wpRe * wqRe + wpIm * wqIm;
          gammaIm += wpRe * wqIm - wpIm * wqRe;
        }
        const gammaAbsSq = gammaRe * gammaRe + gammaIm * gammaIm;

        // ── Drmač 1997 §4.2 per-pair tolerance test ─────────────────────
        if (gammaAbsSq <= tol * tol * alpha * beta) continue;
        if (alpha === 0 && beta === 0) continue;

        const gammaAbs = Math.sqrt(gammaAbsSq);

        // ── Phase extraction: e^{-iθ} = conj(γ) / |γ| ────────────────────
        // After applying e^{-iθ} to column q, the new ⟨p, q⟩ inner
        // product is |γ| (real, ≥ 0).
        const invGammaAbs = 1 / gammaAbs;
        const ethRe = gammaRe * invGammaAbs; //  Re(conj(γ)/|γ|) =  Re(γ)/|γ|
        const ethIm = -gammaIm * invGammaAbs; //  Im(conj(γ)/|γ|) = -Im(γ)/|γ|

        // ── Real Jacobi rotation on the now-real Gram matrix ───────────
        const zeta = (beta - alpha) / (2 * gammaAbs);
        let t: number;
        if (Math.abs(zeta) > 1e150) {
          t = 1 / (2 * zeta);
        } else {
          const denom = Math.abs(zeta) + Math.sqrt(1 + zeta * zeta);
          t = (zeta >= 0 ? 1 : -1) / denom;
        }
        const c = 1 / Math.sqrt(1 + t * t);
        const s = t * c;

        // ── Apply the combined complex rotation to W's columns ─────────
        //   W[:, p] ← c · W[:, p] − s · e^{-iθ} · W[:, q]
        //   W[:, q] ← s · W[:, p] + c · e^{-iθ} · W[:, q]
        for (let i = 0; i < mw; i++) {
          const wpRe = Wre[i * nw + p]!;
          const wpIm = Wim[i * nw + p]!;
          const wqRe = Wre[i * nw + q]!;
          const wqIm = Wim[i * nw + q]!;
          // phased = e^{-iθ} · W[i, q]
          //        = (ethRe + i ethIm)(wqRe + i wqIm)
          //        = (ethRe·wqRe − ethIm·wqIm) + i (ethRe·wqIm + ethIm·wqRe)
          const phRe = ethRe * wqRe - ethIm * wqIm;
          const phIm = ethRe * wqIm + ethIm * wqRe;
          Wre[i * nw + p] = c * wpRe - s * phRe;
          Wim[i * nw + p] = c * wpIm - s * phIm;
          Wre[i * nw + q] = s * wpRe + c * phRe;
          Wim[i * nw + q] = s * wpIm + c * phIm;
        }

        // ── Apply the same rotation to V's columns ─────────────────────
        for (let i = 0; i < nw; i++) {
          const vpRe = Vre[i * nw + p]!;
          const vpIm = Vim[i * nw + p]!;
          const vqRe = Vre[i * nw + q]!;
          const vqIm = Vim[i * nw + q]!;
          const phRe = ethRe * vqRe - ethIm * vqIm;
          const phIm = ethRe * vqIm + ethIm * vqRe;
          Vre[i * nw + p] = c * vpRe - s * phRe;
          Vim[i * nw + p] = c * vpIm - s * phIm;
          Vre[i * nw + q] = s * vpRe + c * phRe;
          Vim[i * nw + q] = s * vpIm + c * phIm;
        }
        rotations++;
      }
    }
    if (rotations === 0) break;
    if (sweep === MAX_SWEEPS_JACOBI - 1) reachedCap = true;
  }
  // The cap-reached signal is informational; the result is still the
  // best Jacobi-approximation of the SVD at the cap. We don't surface
  // it as a warning here (the substrate is pure); the tool layer can
  // re-derive it from sweepsRun + a future flag if needed.
  void reachedCap;
  void sweepsRun;

  // ---------------------------------------------------------------------------
  // Extract singular values and the left-singular-vector candidate
  // U_work[:, j] = W[:, j] / σ_j.
  // ---------------------------------------------------------------------------
  const colNorms = new Float64Array(nw);
  for (let j = 0; j < nw; j++) {
    let sq = 0;
    for (let i = 0; i < mw; i++) {
      const a = Wre[i * nw + j]!;
      const b = Wim[i * nw + j]!;
      sq += a * a + b * b;
    }
    colNorms[j] = Math.sqrt(sq);
  }
  const sigmas: { s: number; col: number }[] = new Array(nw);
  for (let j = 0; j < nw; j++) sigmas[j] = { s: colNorms[j]!, col: j };
  sigmas.sort((a, b) => b.s - a.s);

  const sMax = sigmas.length > 0 ? sigmas[0]!.s : 0;
  // LAPACK numerical-rank threshold: σ_j > max(m, n) · ε · σ_max.
  const rankThreshold = sMax > 0 ? Math.max(mw, nw) * EPS * sMax : 0;
  // The "needs completion" threshold (a column whose σ has collapsed to
  // numerical zero — cannot be normalised to a singular vector). Stays
  // distinct from rankThreshold above so the rank report reflects the
  // mathematical rank cut while the completion path runs only on the
  // truly zero columns.
  const zeroThreshold = sMax > 0 ? EPS * sMax * Math.max(mw, nw) : 0;

  // U_work has columns sorted by descending σ: U_work[:, k] = (W[:, sigmas[k].col]) / sigmas[k].s.
  const UworkRe = new Float64Array(mw * nw);
  const UworkIm = new Float64Array(mw * nw);
  const needsCompletion: number[] = [];
  for (let k = 0; k < nw; k++) {
    const orig = sigmas[k]!.col;
    const sig = sigmas[k]!.s;
    if (sig > zeroThreshold) {
      const inv = 1 / sig;
      for (let i = 0; i < mw; i++) {
        UworkRe[i * nw + k] = Wre[i * nw + orig]! * inv;
        UworkIm[i * nw + k] = Wim[i * nw + orig]! * inv;
      }
    } else {
      needsCompletion.push(k);
    }
  }
  if (needsCompletion.length > 0) {
    complexCompleteOrthonormal(UworkRe, UworkIm, mw, nw, needsCompletion);
  }

  // V_perm has columns reordered to match the σ sort.
  const VpermRe = new Float64Array(nw * nw);
  const VpermIm = new Float64Array(nw * nw);
  for (let k = 0; k < nw; k++) {
    const orig = sigmas[k]!.col;
    for (let i = 0; i < nw; i++) {
      VpermRe[i * nw + k] = Vre[i * nw + orig]!;
      VpermIm[i * nw + k] = Vim[i * nw + orig]!;
    }
  }

  const kMin = Math.min(m, n); // == nw

  // ---------------------------------------------------------------------------
  // Translate worked-frame matrices back to M-frame.
  //   if !transposed: U_red = U_work (m × k), V_red = V_perm (n × k).
  //   if  transposed: we worked on M† = V Σ U†, so left vecs of W are V
  //                   of M and right vecs of W are U of M — swap.
  //                   U_red = V_perm (m × k), V_red = U_work (n × k).
  // ---------------------------------------------------------------------------
  let URedRe: Float64Array;
  let URedIm: Float64Array;
  let VRedRe: Float64Array;
  let VRedIm: Float64Array;
  let URedRows: number;
  let VRedRows: number;
  if (!transposed) {
    URedRe = UworkRe;
    URedIm = UworkIm;
    VRedRe = VpermRe;
    VRedIm = VpermIm;
    URedRows = mw;
    VRedRows = nw;
  } else {
    URedRe = VpermRe;
    URedIm = VpermIm;
    VRedRe = UworkRe;
    VRedIm = UworkIm;
    URedRows = nw;
    VRedRows = mw;
  }

  // Trim to k columns (drop the extra n_w − k = 0 columns when m = n;
  // otherwise n_w = k by construction). This is a no-op for square
  // inputs but matters for rectangular ones in the transposed branch
  // where U_work was n × n and we want m × k.
  const URedTrimRe = trimColumns(URedRe, URedRows, nw, kMin);
  const URedTrimIm = trimColumns(URedIm, URedRows, nw, kMin);
  const VRedTrimRe = trimColumns(VRedRe, VRedRows, nw, kMin);
  const VRedTrimIm = trimColumns(VRedIm, VRedRows, nw, kMin);

  // ---------------------------------------------------------------------------
  // Reduced vs complete mode.
  // ---------------------------------------------------------------------------
  let Ufinal: ComplexMatrix;
  let Vfinal: ComplexMatrix;
  if (mode === "reduced") {
    Ufinal = { rows: URedRows, cols: kMin, re: URedTrimRe, im: URedTrimIm };
    Vfinal = { rows: VRedRows, cols: kMin, re: VRedTrimRe, im: VRedTrimIm };
  } else {
    // complete: extend U to m × m and V to n × n via complex Gram-
    // Schmidt completion against the existing orthonormal columns.
    const UfullRe = complexExtendOrthonormal(URedTrimRe, URedTrimIm, URedRows, kMin, URedRows).re;
    const UfullIm = complexExtendOrthonormal(URedTrimRe, URedTrimIm, URedRows, kMin, URedRows).im;
    const VfullRe = complexExtendOrthonormal(VRedTrimRe, VRedTrimIm, VRedRows, kMin, VRedRows).re;
    const VfullIm = complexExtendOrthonormal(VRedTrimRe, VRedTrimIm, VRedRows, kMin, VRedRows).im;
    Ufinal = { rows: URedRows, cols: URedRows, re: UfullRe, im: UfullIm };
    Vfinal = { rows: VRedRows, cols: VRedRows, re: VfullRe, im: VfullIm };
  }

  const S = new Float64Array(kMin);
  for (let i = 0; i < kMin; i++) S[i] = sigmas[i]!.s;

  // ---------------------------------------------------------------------------
  // Diagnostics: reconstruction, orthogonality, condition number, rank.
  // ---------------------------------------------------------------------------
  const mNorm = complexFrobeniusNorm(M);
  const reconstructionError =
    svdComplexReconstructionError(M, Ufinal, S, Vfinal) / Math.max(mNorm, 1);
  const orthogonalityErrorU = complexOrthogonalityError(Ufinal);
  const orthogonalityErrorV = complexOrthogonalityError(Vfinal);

  let conditionNumber: number;
  if (kMin === 0 || S[0] === 0) {
    conditionNumber = 0;
  } else {
    const sMin = S[kMin - 1]!;
    if (sMin > 0) {
      conditionNumber = S[0]! / sMin;
    } else {
      conditionNumber = S[0]! / (EPS * S[0]!);
    }
    // Cap at 1/EPS so downstream consumers see a finite number.
    const cap = 1 / EPS;
    if (conditionNumber > cap) conditionNumber = cap;
  }

  let rankEstimate = 0;
  for (let i = 0; i < kMin; i++) {
    if (S[i]! > rankThreshold) rankEstimate++;
  }

  return {
    U: Ufinal,
    S,
    V: Vfinal,
    mode,
    method: "complex-one-sided-jacobi",
    reconstructionError,
    orthogonalityErrorU,
    orthogonalityErrorV,
    conditionNumber,
    rankEstimate,
  };
}

// =============================================================================
// Helpers (private to this module)
// =============================================================================

/**
 * Trim a flat `rows × cols` Float64Array to its first `keepCols`
 * columns, returning a fresh array. No-op (still allocates a copy)
 * when `keepCols === cols`. The freshness is intentional: callers
 * (e.g. complete-mode extension) mutate the returned buffer.
 */
function trimColumns(
  data: Float64Array,
  rows: number,
  cols: number,
  keepCols: number,
): Float64Array {
  if (keepCols === cols) return new Float64Array(data);
  const out = new Float64Array(rows * keepCols);
  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < keepCols; j++) {
      out[i * keepCols + j] = data[i * cols + j]!;
    }
  }
  return out;
}

/**
 * Complete a partial complex orthonormal basis stored as parallel
 * `(re, im)` Float64Arrays: for each column index in `needsCompletion`,
 * write an orthonormal vector against the columns already considered
 * "filled" (every column not in `needsCompletion`).
 *
 * Strategy: try unit basis vectors `e_k` in turn, project onto the
 * complement of the filled subspace via complex modified Gram-Schmidt
 * (twice, for CGS2 stability), normalise. If a trial vector lies in
 * the filled span, advance to the next `e_k`. If all `rows` trials
 * fail (the filled subspace is the entire space), zero the target —
 * but this should never happen on the inputs the tool admits.
 */
function complexCompleteOrthonormal(
  re: Float64Array,
  im: Float64Array,
  rows: number,
  cols: number,
  needsCompletion: readonly number[],
): void {
  const filled = new Set<number>();
  for (let j = 0; j < cols; j++) filled.add(j);
  for (const j of needsCompletion) filled.delete(j);

  for (const targetCol of needsCompletion) {
    let placed = false;
    for (let trial = 0; trial < rows && !placed; trial++) {
      const vRe = new Float64Array(rows);
      const vIm = new Float64Array(rows);
      vRe[trial] = 1;
      // Two-pass complex modified Gram-Schmidt against filled columns
      // (CGS2; the second pass cancels the first pass's round-off).
      for (let pass = 0; pass < 2; pass++) {
        for (const fc of filled) {
          // ⟨q_fc, v⟩ = Σ conj(q_fc[r]) · v[r]
          let dotRe = 0;
          let dotIm = 0;
          for (let i = 0; i < rows; i++) {
            const qRe = re[i * cols + fc]!;
            const qIm = im[i * cols + fc]!;
            dotRe += qRe * vRe[i]! + qIm * vIm[i]!;
            dotIm += qRe * vIm[i]! - qIm * vRe[i]!;
          }
          // v ← v − ⟨q_fc, v⟩ · q_fc
          //   = v − (dotRe + i dotIm) · (q_fc.re + i q_fc.im)
          for (let i = 0; i < rows; i++) {
            const qRe = re[i * cols + fc]!;
            const qIm = im[i * cols + fc]!;
            const subRe = dotRe * qRe - dotIm * qIm;
            const subIm = dotRe * qIm + dotIm * qRe;
            vRe[i] = vRe[i]! - subRe;
            vIm[i] = vIm[i]! - subIm;
          }
        }
      }
      let norm = 0;
      for (let i = 0; i < rows; i++) {
        norm += vRe[i]! * vRe[i]! + vIm[i]! * vIm[i]!;
      }
      norm = Math.sqrt(norm);
      if (norm > 1e-12) {
        const inv = 1 / norm;
        for (let i = 0; i < rows; i++) {
          re[i * cols + targetCol] = vRe[i]! * inv;
          im[i * cols + targetCol] = vIm[i]! * inv;
        }
        filled.add(targetCol);
        placed = true;
      }
    }
    if (!placed) {
      for (let i = 0; i < rows; i++) {
        re[i * cols + targetCol] = 0;
        im[i * cols + targetCol] = 0;
      }
    }
  }
}

/**
 * Extend a complex `rows × colsIn` orthonormal matrix to `rows × colsOut`
 * by complex Gram-Schmidt completion of the trailing `colsOut − colsIn`
 * columns. Returns parallel `(re, im)` Float64Arrays.
 */
function complexExtendOrthonormal(
  inRe: Float64Array,
  inIm: Float64Array,
  rows: number,
  colsIn: number,
  colsOut: number,
): { re: Float64Array; im: Float64Array } {
  if (colsOut === colsIn) {
    return { re: new Float64Array(inRe), im: new Float64Array(inIm) };
  }
  const outRe = new Float64Array(rows * colsOut);
  const outIm = new Float64Array(rows * colsOut);
  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < colsIn; j++) {
      outRe[i * colsOut + j] = inRe[i * colsIn + j]!;
      outIm[i * colsOut + j] = inIm[i * colsIn + j]!;
    }
  }
  const newCols: number[] = [];
  for (let j = colsIn; j < colsOut; j++) newCols.push(j);
  complexCompleteOrthonormal(outRe, outIm, rows, colsOut, newCols);
  return { re: outRe, im: outIm };
}

/**
 * Compute `‖M − U · diag(S) · V†‖_F` directly. Strategy:
 *
 *   ‖M − U·diag(S)·V†‖_F = ‖M·V − U·diag(S)‖_F      (V unitary)
 *
 * holds when V is the *full* unitary (n × n in complete mode); for
 * reduced mode V is n × k and the equality above is exact only when
 * the trailing n − k singular values are zero (i.e. M has rank ≤ k =
 * min(m, n) which always holds for any matrix). So either form is
 * valid in both modes. We use the right form since we have U and V at
 * hand and can stream the result element-wise without materialising the
 * full m × n reconstruction.
 *
 * In reduced mode V is n × k; `M · V` is m × k; `U · diag(S)` is m × k.
 * In complete mode V is n × n; `M · V` is m × n; `U · diag(S)` extended
 * to m × n by padding S with zeros (the trailing columns of `U·diag(S)`
 * are zero columns).
 */
function svdComplexReconstructionError(
  M: ComplexMatrix,
  U: ComplexMatrix,
  S: Float64Array,
  V: ComplexMatrix,
): number {
  // M · V: m × V.cols.
  const MV = complexMatmul(M, V);
  const kReal = S.length;
  let s = 0;
  for (let i = 0; i < MV.rows; i++) {
    for (let j = 0; j < MV.cols; j++) {
      const idx = i * MV.cols + j;
      // (U · diag(S))[i, j]: if j < kReal, it's S[j] * U[i, j]; else 0.
      const uRe = j < U.cols ? U.re[i * U.cols + j]! : 0;
      const uIm = j < U.cols ? U.im[i * U.cols + j]! : 0;
      const sigma = j < kReal ? S[j]! : 0;
      const dRe = MV.re[idx]! - sigma * uRe;
      const dIm = MV.im[idx]! - sigma * uIm;
      s += dRe * dRe + dIm * dIm;
    }
  }
  return Math.sqrt(s);
}

/**
 * Compute `‖Q† Q − I‖_F` for a complex `rows × cols` matrix `Q` by
 * walking pairs `(i, j)` of columns and accumulating the column inner
 * product `⟨q_i, q_j⟩ = Σ conj(q_i[r]) · q_j[r]`. Diagonal terms
 * subtract 1; off-diagonal pairs are counted twice (Hermitian symmetry
 * of `Q† Q − I`).
 *
 * Used by the diagnostic self-report for both `U` (orthogonality of
 * left singular vectors) and `V` (orthogonality of right singular
 * vectors). For a perfectly unitary `Q`, returns 0.
 */
function complexOrthogonalityError(Q: ComplexMatrix): number {
  const cols = Q.cols;
  const rows = Q.rows;
  let s = 0;
  for (let i = 0; i < cols; i++) {
    for (let j = i; j < cols; j++) {
      let aRe = 0;
      let aIm = 0;
      for (let r = 0; r < rows; r++) {
        const qiRe = Q.re[r * cols + i]!;
        const qiIm = Q.im[r * cols + i]!;
        const qjRe = Q.re[r * cols + j]!;
        const qjIm = Q.im[r * cols + j]!;
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

// `complexZeros` and `complexAdjoint` aren't used directly in this file
// but are exported alongside the substrate; the tool layer adjoints `V`
// to `Vh` for the wire emission. Kept as named imports so the public
// surface of `complex-matrix.js` stays cohesive.
void complexZeros;
void complexAdjoint;
