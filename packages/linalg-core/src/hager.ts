// =============================================================================
// hager.ts — 1-norm condition estimator (Hager's algorithm)
// =============================================================================
//
// Intent
// ------
// Estimate `||A^{-1}||_1` from a precomputed LU factorisation, using
// only matrix-vector products with A^{-1} and (A^{-1})ᵀ — i.e. solves
// against L, U and their transposes. The estimate is typically within
// a factor of 2-3 of the true 1-norm; the worst-case ratio is bounded
// (Higham 1988 §3) and in 25 years of LAPACK use the algorithm has
// proven extremely reliable on real-world matrices.
//
// Why we want this
// ----------------
// The 1-norm condition number κ_1(A) = ||A||_1 · ||A^{-1}||_1
// quantifies how much a relative perturbation in `b` can amplify into
// a relative perturbation in `x`. For agent-honest output, this is the
// load-bearing scalar: it tells the planner whether the problem itself
// is well-posed.
//
//   κ_1 ≈ 1     — perfectly conditioned
//   κ_1 ≈ 10⁴   — losing ~4 digits of accuracy
//   κ_1 ≈ 10¹²  — losing ~12 digits; only ~3 digits of x are
//                 trustworthy
//   κ_1 > 10¹⁶  — A is numerically singular at float64 precision
//
// Computing κ_1 *exactly* costs O(n³) (you'd need A^{-1}). Hager's
// estimator costs O(n²) given the LU — comparable to a single solve.
// That's the right cost / accuracy trade-off.
//
// Algorithm — Hager (1984), with Higham's (1988) modifications
// ------------------------------------------------------------
// We seek `γ = ||B||_1` where `B = A^{-1}`. Note ||B||_1 = max_j Σ_i |B[i,j]|;
// equivalently, `γ = max ||B x||_1 over ||x||_1 ≤ 1`.
//
// The dual characterization: `||B||_1 = max ξᵀ B x` over the unit
// 1-ball in x and the unit ∞-ball in ξ (Hölder). Hager's iteration
// climbs this max:
//
//   1. Start with x = (1/n, …, 1/n) (||x||_1 = 1).
//   2. y = B x  (i.e. solve A y = x using the LU).
//   3. ξ = sign(y) (entrywise; ξ_i = 1 if y_i ≥ 0 else -1).
//   4. z = Bᵀ ξ  (i.e. solve Aᵀ z = ξ using the transposed LU solve).
//   5. If ||z||_∞ ≤ zᵀ x, return ||y||_1 as the estimate.
//   6. Else, set x = e_j where j = argmax |z_i|; loop to step 2.
//
// In ≤ 5 iterations on virtually all real matrices. We cap at 5 to
// keep the cost predictable.

import { type LUResult, luSolve, luSolveTransposed } from "./lu.js";

/**
 * Estimate `||A^{-1}||_1` given an LU factorisation of A. Returns
 * +Infinity if A is so ill-conditioned that an internal solve produces
 * non-finite values; that is the right signal for the tool layer to
 * surface as a "matrix is numerically singular" warning.
 */
export function hagerOneNormEstimate(lu: LUResult): number {
  const n = lu.LU.rows;
  const x = new Float64Array(n);
  x.fill(1 / n);

  let estimate = 0;
  const MAX_ITER = 5;
  let prevJ = -1;

  for (let iter = 0; iter < MAX_ITER; iter++) {
    const y = luSolve(lu, x);
    if (!allFinite(y)) return Number.POSITIVE_INFINITY;
    const yNorm1 = sumAbs(y);
    if (yNorm1 > estimate) estimate = yNorm1;

    const xi = new Float64Array(n);
    for (let i = 0; i < n; i++) xi[i] = y[i]! >= 0 ? 1 : -1;

    const z = luSolveTransposed(lu, xi);
    if (!allFinite(z)) return Number.POSITIVE_INFINITY;

    // Find the index of the largest |z_i| and compute zᵀ x.
    let maxIdx = 0;
    let maxAbs = Math.abs(z[0]!);
    let zDotX = z[0]! * x[0]!;
    for (let i = 1; i < n; i++) {
      const a = Math.abs(z[i]!);
      if (a > maxAbs) {
        maxAbs = a;
        maxIdx = i;
      }
      zDotX += z[i]! * x[i]!;
    }

    // Stop if no further improvement is achievable.
    if (maxAbs <= zDotX) break;
    // Stop if we've cycled (chose the same coordinate twice).
    if (maxIdx === prevJ) break;

    // Jump to the unit vector along the coordinate of largest |z|.
    x.fill(0);
    x[maxIdx] = 1;
    prevJ = maxIdx;
  }

  return estimate;
}

function sumAbs(v: Float64Array): number {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += Math.abs(v[i]!);
  return s;
}

function allFinite(v: Float64Array): boolean {
  for (let i = 0; i < v.length; i++) {
    if (!Number.isFinite(v[i]!)) return false;
  }
  return true;
}
