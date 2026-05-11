// In-place lower-triangular Cholesky factorization of a symmetric matrix.
// Storage: row-major n × n in `A`; on success, lower triangle of `A` holds
// L such that L L^T = A_input (upper triangle is untouched/garbage).
// Returns the index at which the factorization failed (negative pivot or
// non-positive diagonal), or -1 on success.

export function choleskyInPlace(A: Float64Array, n: number, jitter = 0): number {
  for (let j = 0; j < n; j++) {
    let sum = A[j * n + j]! + jitter;
    for (let k = 0; k < j; k++) {
      const ljk = A[j * n + k]!;
      sum -= ljk * ljk;
    }
    if (!(sum > 0) || !Number.isFinite(sum)) return j;
    const ljj = Math.sqrt(sum);
    A[j * n + j] = ljj;
    const invLjj = 1 / ljj;
    for (let i = j + 1; i < n; i++) {
      let s = A[i * n + j]!;
      for (let k = 0; k < j; k++) s -= A[i * n + k]! * A[j * n + k]!;
      A[i * n + j] = s * invLjj;
    }
  }
  return -1;
}

// Solve L L^T x = b in place, with L stored in the lower triangle of A (row-major).
export function choleskySolveInPlace(A: Float64Array, n: number, x: Float64Array): void {
  for (let i = 0; i < n; i++) {
    let s = x[i]!;
    for (let k = 0; k < i; k++) s -= A[i * n + k]! * x[k]!;
    x[i] = s / A[i * n + i]!;
  }
  for (let i = n - 1; i >= 0; i--) {
    let s = x[i]!;
    for (let k = i + 1; k < n; k++) s -= A[k * n + i]! * x[k]!;
    x[i] = s / A[i * n + i]!;
  }
}

// Convenience: factor a fresh copy and solve. Returns -1 + factored buffer
// on success, or {info >= 0} on failure (with the failing pivot index).
export interface CholeskyResult {
  factored: Float64Array;
  info: number;
}

export function cholesky(A: Float64Array, n: number, jitter = 0): CholeskyResult {
  const factored = new Float64Array(A);
  const info = choleskyInPlace(factored, n, jitter);
  return { factored, info };
}
