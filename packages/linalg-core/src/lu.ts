// =============================================================================
// lu.ts — LU factorisation with partial pivoting
// =============================================================================
//
// Intent
// ------
// Compute `P A = L U`, where:
//   * P is a row permutation (stored as a flat permutation vector, not a
//     matrix; a matrix would be a wasteful Float64Array of zeros).
//   * L is unit lower-triangular (1s on the diagonal, fill below).
//   * U is upper-triangular (fill on and above the diagonal).
//
// L and U share storage. We pack them into a single `Matrix`:
//   * `LU[i, j]` for `j ≥ i` carries `U[i, j]` directly.
//   * `LU[i, j]` for `j < i` carries `L[i, j]`. The unit diagonal of L
//     is implicit; we never write the 1s.
// This is the LAPACK-style packing (DGETRF). It halves the memory and,
// more importantly, eliminates a layer of indirection in the inner
// loop — every read and write is into one contiguous buffer.
//
// Algorithm — Doolittle with partial pivoting
// -------------------------------------------
// For pivot column k = 0, 1, …, n-1:
//   1. Find p ≥ k with |LU[p, k]| maximal. (Partial pivoting: search
//      the column at and below the diagonal for the largest pivot.)
//   2. If LU[p, k] is exactly zero → A is exactly singular; bail.
//   3. Swap rows p and k in LU; record the swap in P; flip signDet.
//   4. For each row i > k:
//        LU[i, k] /= LU[k, k]      (this is L[i, k])
//        For each col j > k:
//          LU[i, j] -= LU[i, k] * LU[k, j]   (Schur complement update)
//
// Why partial (not full) pivoting
// -------------------------------
// Full pivoting is more numerically robust on adversarial inputs, but
// it costs an extra O(n²) per pivot step and breaks the row-major
// access pattern (we'd swap columns, walking memory non-sequentially).
// In practice partial pivoting is the universal default — it's what
// LAPACK's DGETRF does, what NumPy's `numpy.linalg.solve` calls into,
// what every "small CAS" linalg uses. For the matrices a sci-wb agent
// will hand us (n ≤ 200, condition typically < 1e10), partial pivoting
// is amply sufficient. The growth factor is reported so the agent's
// planner sees if a problem genuinely sat in the bad-pivoting tail.
//
// Why "exactly zero" and not "below threshold"
// --------------------------------------------
// A "tiny pivot" heuristic (`if |pivot| < eps then declare singular`)
// is a footgun: the threshold encodes a hidden assumption about
// scaling, and the behaviour silently changes when matrices are
// rescaled. We bail only on *exactly* zero and surface the
// growth-factor warning to the caller; the tool layer (linalg-solve)
// reads that and emits a `warnings: ["growth factor 1.2e8"]` field on
// the output record. The planner decides what to do.

import { type Matrix, MatrixError, matClone } from "./matrix.js";

/**
 * Result of a successful LU factorisation.
 *
 * `LU` packs L and U as documented in the file header.
 *
 * `P` is a permutation in one-line notation: `P[i]` is the index of
 * the original row that ended up at row i. Equivalently, the permuted
 * matrix `(P A)[i, j] === A[P[i], j]`.
 *
 * `signDet` is +1 if the row swaps performed during pivoting form an
 * even permutation, -1 if odd. Multiply this by `Π U[i, i]` to get
 * `det(A)`.
 *
 * `growthFactor` is Wilkinson's growth ratio:
 *   `max_i,j |U[i, j]| / max_i,j |A[i, j]|`
 * Values > 1e6 hint at numerical danger (backward error ≈ growth ×
 * eps × ||A||); values > 1e10 are red. The tool layer translates
 * thresholds into the warnings list.
 */
export type LUResult = {
  readonly LU: Matrix;
  readonly P: Int32Array;
  readonly signDet: 1 | -1;
  readonly growthFactor: number;
};

/**
 * In-place LU factorisation. Mutates `LU.data`. Returns `null` iff a
 * pivot is exactly zero (A is exactly singular). On success returns
 * `{LU: <input>, P, signDet, growthFactor}`.
 *
 * This is the lowest-level entry point; most callers want `lu` (which
 * clones the input) below.
 */
export function luInPlace(LU: Matrix): LUResult | null {
  if (LU.rows !== LU.cols) {
    throw new MatrixError(`luInPlace: A must be square (got ${LU.rows}×${LU.cols})`);
  }
  const n = LU.rows;
  const a = LU.data;
  const P = new Int32Array(n);
  for (let i = 0; i < n; i++) P[i] = i;
  let signDet: 1 | -1 = 1;

  // Track max |A[i,j]| up front so the growth factor is meaningful at
  // the end. We do one pass; this is O(n²), the same order as one row
  // of the elimination, so the overhead is negligible.
  let maxA = 0;
  for (let i = 0; i < n * n; i++) {
    const v = Math.abs(a[i]!);
    if (v > maxA) maxA = v;
  }
  if (maxA === 0) {
    // The all-zeros matrix. Singular, no useful factorisation.
    return null;
  }

  for (let k = 0; k < n; k++) {
    // Step 1: find the pivot (largest |a[i,k]| for i ≥ k).
    let p = k;
    let pv = Math.abs(a[k * n + k]!);
    for (let i = k + 1; i < n; i++) {
      const v = Math.abs(a[i * n + k]!);
      if (v > pv) {
        pv = v;
        p = i;
      }
    }
    if (pv === 0) {
      // Exactly singular at column k: every entry on/below the
      // diagonal in this column is zero.
      return null;
    }

    // Step 3: swap rows p and k. (Step 2 is implicit in the pv === 0
    // check above.)
    if (p !== k) {
      const offP = p * n;
      const offK = k * n;
      for (let j = 0; j < n; j++) {
        const tmp = a[offP + j]!;
        a[offP + j] = a[offK + j]!;
        a[offK + j] = tmp;
      }
      const tmpP = P[p]!;
      P[p] = P[k]!;
      P[k] = tmpP;
      signDet = (signDet === 1 ? -1 : 1);
    }

    // Step 4: eliminate below the pivot.
    const pivot = a[k * n + k]!;
    const offK = k * n;
    for (let i = k + 1; i < n; i++) {
      const offI = i * n;
      const m = a[offI + k]! / pivot;
      a[offI + k] = m; // store L[i,k] in the lower triangle
      for (let j = k + 1; j < n; j++) {
        a[offI + j] = a[offI + j]! - m * a[offK + j]!;
      }
    }
  }

  // Compute growth factor: max |U[i, j]| over the upper triangle / maxA.
  let maxU = 0;
  for (let i = 0; i < n; i++) {
    for (let j = i; j < n; j++) {
      const v = Math.abs(a[i * n + j]!);
      if (v > maxU) maxU = v;
    }
  }
  return { LU, P, signDet, growthFactor: maxU / maxA };
}

/** Allocating wrapper: clones A, returns a fresh LU result. */
export function lu(A: Matrix): LUResult | null {
  return luInPlace(matClone(A));
}

/**
 * Solve `L y = (P b)` followed by `U x = y`, given an LU factorisation
 * and a right-hand side. Allocates and returns x; does not mutate b.
 *
 * Forward substitution (L y = Pb): L is unit lower triangular with the
 * 1s implicit, so for each row i: `y[i] = (Pb)[i] - Σ_{j<i} L[i, j] y[j]`.
 *
 * Back substitution (U x = y): for each row i from n-1 down to 0:
 *   `x[i] = (y[i] - Σ_{j>i} U[i, j] x[j]) / U[i, i]`.
 */
export function luSolve(luResult: LUResult, b: Float64Array): Float64Array {
  const n = luResult.LU.rows;
  if (b.length !== n) {
    throw new MatrixError(`luSolve: dim mismatch — LU is ${n}×${n}, b has length ${b.length}`);
  }
  const a = luResult.LU.data;
  const P = luResult.P;

  // y starts as P b (apply the row permutation to b).
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) y[i] = b[P[i]!]!;

  // Forward sub: L y = Pb. L has unit diagonal (implicit).
  for (let i = 0; i < n; i++) {
    let s = y[i]!;
    const offI = i * n;
    for (let j = 0; j < i; j++) s -= a[offI + j]! * y[j]!;
    y[i] = s;
  }

  // Back sub: U x = y. U has its diagonal stored.
  const x = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) {
    let s = y[i]!;
    const offI = i * n;
    for (let j = i + 1; j < n; j++) s -= a[offI + j]! * x[j]!;
    x[i] = s / a[offI + i]!;
  }
  return x;
}

/**
 * `luSolveTransposed` — solve `Aᵀ z = c` given the LU of A. Used by
 * Hager's condition estimator, which needs solves with both A and Aᵀ
 * to bound `||A^{-1}||_1` from below.
 *
 * The math: if `P A = L U`, then `Aᵀ Pᵀ = Uᵀ Lᵀ`, so `Aᵀ z = c` is
 * equivalent to: solve `Uᵀ w = c` (forward sub on the upper-triangular
 * factor's transpose), then `Lᵀ v = w` (back sub on the lower factor's
 * transpose, with unit diagonal), then `z = Pᵀ v` (apply the inverse
 * permutation: `z[P[i]] = v[i]`).
 */
export function luSolveTransposed(luResult: LUResult, c: Float64Array): Float64Array {
  const n = luResult.LU.rows;
  if (c.length !== n) {
    throw new MatrixError(`luSolveTransposed: dim mismatch — LU is ${n}×${n}, c has length ${c.length}`);
  }
  const a = luResult.LU.data;
  const P = luResult.P;

  // Forward sub on Uᵀ: Uᵀ w = c. Uᵀ[i, j] = U[j, i] = a[j*n + i] for j ≤ i.
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = c[i]!;
    for (let j = 0; j < i; j++) s -= a[j * n + i]! * w[j]!;
    w[i] = s / a[i * n + i]!;
  }

  // Back sub on Lᵀ: Lᵀ v = w. Lᵀ has unit diagonal (implicit).
  // Lᵀ[i, j] = L[j, i] = a[j*n + i] for j > i.
  const v = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) {
    let s = w[i]!;
    for (let j = i + 1; j < n; j++) s -= a[j * n + i]! * v[j]!;
    v[i] = s;
  }

  // z = Pᵀ v: undo the permutation. z[P[i]] = v[i].
  const z = new Float64Array(n);
  for (let i = 0; i < n; i++) z[P[i]!] = v[i]!;
  return z;
}

/**
 * Compute `det(A)` from an LU factorisation. Handy for the few callers
 * that want it; not used by `solve`. Note: for large n, the determinant
 * can underflow / overflow even when A is well-conditioned. Callers
 * needing log|det| should compute `Σ log|U[i,i]|` directly.
 */
export function luDet(luResult: LUResult): number {
  const n = luResult.LU.rows;
  let d: number = luResult.signDet;
  const a = luResult.LU.data;
  for (let i = 0; i < n; i++) d *= a[i * n + i]!;
  return d;
}
