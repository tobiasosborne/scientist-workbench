// Static-order signed-Cholesky LDLᵀ for symmetric quasidefinite (SQD)
// systems — the linear-algebra core of the convex-QP interior-point
// solver (`solveQp`).
//
// Ground truth: docs/ground-truth/convex/qp-ipm.md §4, and the qp-solve
// ADR. The mathematics is Vanderbei (1995), *Symmetric Quasidefinite
// Matrices*, SIAM J. Optim. 5(1):100–113.
//
// WHY A NEW KERNEL, AND WHY THIS ONE.
//
// The QP Newton step (qp-ipm.md §3) reduces to the augmented saddle
// system
//
//     K = [ −(Q + X⁻¹S) − ρI    Aᵀ     ]
//         [        A          + δI     ]
//
// whose (1,1) block is symmetric negative definite (because Q ⪰ 0 and
// X⁻¹S > 0 on the strict interior) and whose (2,2) block is symmetric
// positive definite (because δ > 0). A matrix with a negative-definite
// leading block and a positive-definite trailing block is *symmetric
// quasidefinite*. The existing `choleskyInPlace` cannot factor it: it
// hard-rejects the negative pivots of the (1,1) block at
// `Cholesky.ts:14` (`if (!(sum > 0)) return j`), because it is SPD-only
// by construction.
//
// Vanderbei's theorem is the licence for the cheapest possible repair:
// an SQD matrix admits an `LDLᵀ` factorization with *diagonal* `D` for
// EVERY symmetric permutation — in particular the identity permutation.
// So we never search for a pivot; the natural order `0 … N−1` is always
// numerically stable (Gill–Saunders–Shinnerl 1996 bound the element
// growth by `cond(K)` and the regularization ratio, not by any
// pivot-search quantity). The factorization order is therefore a
// function of the integers `(n, m)` alone — it reads no float64 value —
// which is exactly what the `numerical: true` determinism contract
// (ADR-0015) wants: there is *zero* pivot-determinism surface, unlike a
// Bunch–Kaufman factorization whose data-dependent 1×1/2×2 pivot choice
// is the largest cross-platform divergence risk among the candidate
// designs (the qp-solve design panel's spec C).
//
// `signedLdltInPlace` is therefore the no-`sqrt` sibling of
// `choleskyInPlace`: the same left-looking outer-product recurrence
// (Golub–Van Loan Alg. 4.1.2), but storing `D` (with its sign) on the
// diagonal instead of `√pivot`, and checking that each pivot has the
// sign its block demands. A pivot that loses its sign under rounding is
// reported (its row index returned) so the caller can raise the
// regularization and re-factor (`SignedRegularization.ts`); with
// `ρ, δ > 0` the quasidefinite structure guarantees this cannot happen
// in exact arithmetic, so a returned row is a pure rounding signal.

// Factor a symmetric quasidefinite `K` (row-major `N × N`) in place as
// `K = L D Lᵀ`, with `L` unit-lower-triangular (strict lower triangle of
// `K` on return) and `D` diagonal (the diagonal of `K` on return). The
// first `n` pivots must be strictly negative (the x-block) and the
// remaining `m = N − n` strictly positive (the y-block).
//
// Storage matches `choleskyInPlace`: only the lower triangle of `K` is
// read; the upper triangle is left untouched (garbage). `tmp` is a
// caller-owned scratch row of length ≥ `N` (the allocation-free
// discipline of `Iterate` — no per-call allocation in the inner loop).
//
// Returns `-1` on success, or the (0-based) row index of the first pivot
// that failed the sign/finiteness guard — the signal to regularize and
// retry.
export function signedLdltInPlace(
  K: Float64Array,
  N: number,
  n: number,
  tmp: Float64Array,
): number {
  for (let j = 0; j < N; j++) {
    // tmp[k] = D_k · L_jk for k < j (the scaled column entries reused by
    // both the pivot update and the trailing-column update below).
    for (let k = 0; k < j; k++) tmp[k] = K[k * N + k]! * K[j * N + k]!;

    // Pivot D_j = K_jj − Σ_{k<j} L_jk · (D_k · L_jk).
    let d = K[j * N + j]!;
    for (let k = 0; k < j; k++) d -= K[j * N + k]! * tmp[k]!;

    // Sign-pattern guard. x-block (j < n) pivots must be < 0; y-block
    // pivots > 0. A violation (or a non-finite pivot) is the
    // regularization-retry signal.
    const wantNeg = j < n;
    if (wantNeg ? !(d < 0) : !(d > 0)) return j;
    if (!Number.isFinite(d)) return j;

    K[j * N + j] = d;
    const invd = 1 / d;

    // Trailing column: L_ij = (K_ij − Σ_{k<j} L_ik · (D_k · L_jk)) / D_j.
    for (let i = j + 1; i < N; i++) {
      let s = K[i * N + j]!;
      for (let k = 0; k < j; k++) s -= K[i * N + k]! * tmp[k]!;
      K[i * N + j] = s * invd;
    }
  }
  return -1;
}

// Solve `K v = b` in place (`b` overwritten by `v`), given the factor
// produced by `signedLdltInPlace` stored in the lower triangle + diagonal
// of `K`. Three sweeps: forward `L w = b` (unit lower), diagonal
// `D z = w` (this is where the negative pivots invert — the only place
// the sign of `D` enters), backward `Lᵀ v = z`.
export function ldltSolveInPlace(K: Float64Array, N: number, b: Float64Array): void {
  // L w = b  (L unit lower-triangular; implicit unit diagonal).
  for (let i = 0; i < N; i++) {
    let s = b[i]!;
    for (let k = 0; k < i; k++) s -= K[i * N + k]! * b[k]!;
    b[i] = s;
  }
  // D z = w.
  for (let i = 0; i < N; i++) b[i] = b[i]! / K[i * N + i]!;
  // Lᵀ v = z.
  for (let i = N - 1; i >= 0; i--) {
    let s = b[i]!;
    for (let k = i + 1; k < N; k++) s -= K[k * N + i]! * b[k]!;
    b[i] = s;
  }
}
