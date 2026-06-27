// Assembly of the augmented quasidefinite KKT matrix for the QP IPM.
// Ground truth: docs/ground-truth/convex/qp-ipm.md §§3–4.
//
//     K = [ −(Q + X⁻¹S) − ρ0 I_n      Aᵀ        ]   (row-major, N = n+m)
//         [        A               + δ0 I_m     ]
//
// The matrix is stored fully symmetric in `it.K0` (both triangles), even
// though `signedLdltInPlace` / `ldltSolveInPlace` read only the lower
// triangle: keeping the upper triangle correct lets `symMatVecN` compute
// the exact `K0·v` product the iterative-refinement residual needs,
// reading the unfactored base matrix.
//
// `Q`, `A`, the y-block `+δ0`, and the base `−ρ0` on the x-diagonal are
// constant across the solve, so `assembleKktStatic` runs ONCE; only the
// `n` x-block diagonal entries carry the per-iteration `−(s_j/x_j)` term
// (`X⁻¹S` changes every step), refreshed by `updateKktDiagonal`. The
// escalation regularization (`ρ_e`, `δ_e`) is applied later, on the
// working copy, by `SignedRegularization.ts`.

import type { QpIterate } from "./QpIterate.js";
import type { QpProblem } from "../problem/QpProblem.js";

// Fill the constant structure of `it.K0`. Requires `it.rho0` / `it.delta0`
// already set (the base proximal levels, qp-ipm.md §5). The x-block
// diagonal is initialised to its constant part `−Q_jj − ρ0`;
// `updateKktDiagonal` adds the `−s_j/x_j` term each iteration.
export function assembleKktStatic(it: QpIterate, qp: QpProblem): void {
  const { n, m, N } = it;
  const { Q, A } = qp;
  const K = it.K0;
  K.fill(0);

  // (1,1) x-block: −Q (off-diagonal); diagonal = −Q_jj − ρ0 (base).
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) K[i * N + j] = -Q[i * n + j]!;
    K[i * N + i] = -Q[i * n + i]! - it.rho0;
  }

  // (2,1) = A (lower-left) and (1,2) = Aᵀ (upper-right), kept symmetric.
  for (let r = 0; r < m; r++) {
    for (let j = 0; j < n; j++) {
      const a = A[r * n + j]!;
      K[(n + r) * N + j] = a;
      K[j * N + (n + r)] = a;
    }
  }

  // (2,2) y-block: +δ0 I.
  for (let r = 0; r < m; r++) K[(n + r) * N + (n + r)] = it.delta0;
}

// Refresh the per-iteration x-block diagonal: `K_jj = −Q_jj − ρ0 − s_j/x_j`.
// (The y-block diagonal `+δ0` is constant and untouched.)
export function updateKktDiagonal(it: QpIterate, qp: QpProblem): void {
  const { n, N } = it;
  const { Q } = qp;
  const K = it.K0;
  for (let j = 0; j < n; j++) {
    K[j * N + j] = -Q[j * n + j]! - it.rho0 - it.s[j]! / it.x[j]!;
  }
}

// Full symmetric matrix–vector product `y = K0 · x` (reads both
// triangles of the unfactored base matrix) — the residual kernel for
// iterative refinement on the augmented solve.
export function symMatVecN(K: Float64Array, N: number, x: Float64Array, y: Float64Array): void {
  for (let i = 0; i < N; i++) {
    let s = 0;
    const row = i * N;
    for (let k = 0; k < N; k++) s += K[row + k]! * x[k]!;
    y[i] = s;
  }
}
