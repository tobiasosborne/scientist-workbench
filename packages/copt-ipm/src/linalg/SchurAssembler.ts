// LP normal-equations matrix M = A · diag(d) · A^T, symmetric m × m.
// `A` is row-major m × n in a Float64Array. `d` is length n. Output is
// allocated by the caller; only the lower triangle (i ≥ j) is computed
// since M is symmetric — Cholesky reads from the lower triangle.

export function schurAssembleNormalEq(
  A: Float64Array,
  m: number,
  n: number,
  d: Float64Array,
  M: Float64Array,
): void {
  // Decomp at L709-826 of FUN_00732a50 hand-unrolls D = 1/x²; the algorithm
  // is just M_ij = sum_k A[i,k] * d[k] * A[j,k]. We compute the lower
  // triangle (i ≥ j) and mirror at the end.
  M.fill(0);
  for (let i = 0; i < m; i++) {
    for (let j = 0; j <= i; j++) {
      let s = 0;
      for (let k = 0; k < n; k++) s += A[i * n + k]! * d[k]! * A[j * n + k]!;
      M[i * m + j] = s;
    }
  }
  for (let i = 0; i < m; i++) {
    for (let j = i + 1; j < m; j++) M[i * m + j] = M[j * m + i]!;
  }
}

// y = A · x, A row-major m × n.
export function matVec(A: Float64Array, m: number, n: number, x: Float64Array, y: Float64Array): void {
  for (let i = 0; i < m; i++) {
    let s = 0;
    for (let j = 0; j < n; j++) s += A[i * n + j]! * x[j]!;
    y[i] = s;
  }
}

// y = A^T · x, A row-major m × n, output length n.
export function matVecTranspose(
  A: Float64Array,
  m: number,
  n: number,
  x: Float64Array,
  y: Float64Array,
): void {
  y.fill(0);
  for (let i = 0; i < m; i++) {
    const xi = x[i]!;
    for (let j = 0; j < n; j++) y[j] = y[j]! + A[i * n + j]! * xi;
  }
}
