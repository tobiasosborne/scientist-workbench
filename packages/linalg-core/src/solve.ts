// =============================================================================
// solve.ts — high-level dense solve A x = b
// =============================================================================
//
// Intent
// ------
// One call. One typed result. Everything an agent's planner needs to
// decide what to do next, in one record.
//
//   solve(A, b) -> {
//     x,                  // the answer
//     residualNorm,       // ||A x - b||_2 — how well the answer fits
//     bNorm,              // ||b||_2 — denominator for relative residual
//     conditionEstimate,  // κ_1(A) — how well-posed the problem is
//     growthFactor,       // pivot-growth — how stable the LU was
//     method,             // "lu-partial-pivot" — which method ran
//     iterations,         // refinement steps performed
//   }
//
// Why this shape
// --------------
// A solve that returns just `x` is useless to a planner: there's no
// way to decide "should I retry with a different method? warn the
// user? trust this result?". The planner needs:
//
//   * `residualNorm / bNorm`: did the method actually solve the
//     problem? (For a well-conditioned A it should be O(eps); larger
//     values mean refinement didn't fully converge.)
//   * `conditionEstimate`: even with a small residual, is the answer
//     trustworthy? κ_1 ≈ 1e8 on a single-precision residual means
//     ~half the digits of x are noise, regardless of the residual
//     looking small.
//   * `growthFactor`: did the LU itself behave? Growth > 1e10 hints
//     at a pivoting pathology; the planner might want to try a
//     different decomposition (QR) when the tool layer adds it.
//   * `method`: explicit, not magical. v0.1 has one method; the field
//     exists so the wire format is stable when v0.2 adds QR.
//
// The tool layer (`tools/linalg-solve`) translates these scalars into
// human-readable warnings on the wire ("growth factor 1.2e8 exceeds
// 1e6"); the library returns the raw numbers so callers can apply
// their own thresholds.
//
// Iterative refinement — one step
// -------------------------------
// After the initial LU-solve produces x₀:
//
//   r = b - A x₀                 (residual, in float64)
//   d = solve via the same LU    (correction)
//   x = x₀ + d
//
// One refinement step buys roughly one extra digit of accuracy on
// well-conditioned problems. Without higher-precision arithmetic for
// the residual, we can't iterate to machine precision (the textbook
// Wilkinson result), but one step is cheap (~3n² flops, dominated by
// matVec) and meaningfully improves the residualNorm we report.
//
// We refine *if and only if* the unrefined relative residual exceeds
// `4 * n * eps` (a rough "could reasonably do better" threshold).
// Below that, refinement won't help and we'd be wasting cycles.

import { type Matrix, matVec, vecNorm2, matNorm1 } from "./matrix.js";
import { lu, luSolve, type LUResult } from "./lu.js";
import { hagerOneNormEstimate } from "./hager.js";

/**
 * Result of a successful `solve`. See file header for field semantics.
 */
export type SolveResult = {
  readonly x: Float64Array;
  readonly residualNorm: number;
  readonly bNorm: number;
  readonly conditionEstimate: number;
  readonly growthFactor: number;
  readonly method: "lu-partial-pivot";
  readonly iterations: number;
};

const EPS = Number.EPSILON; // 2^-52 ≈ 2.22e-16
const REFINE_THRESHOLD_FACTOR = 4;

/**
 * Solve `A x = b` for x. Returns `null` iff A is exactly singular (a
 * pivot was zero); otherwise returns a `SolveResult`. Non-square A or
 * dimension mismatch raises `MatrixError`.
 *
 * The condition estimate is κ_1(A) ≈ ||A||_1 · ||A^{-1}||_1 (Hager
 * estimator on the right factor). Multiplied by `eps`, this gives the
 * expected relative error in `x`: `||δx|| / ||x|| ≲ κ_1 · eps`.
 */
export function solve(A: Matrix, b: Float64Array): SolveResult | null {
  if (A.rows !== A.cols) {
    throw new Error(`solve: A must be square (got ${A.rows}×${A.cols})`);
  }
  if (A.rows !== b.length) {
    throw new Error(`solve: dim mismatch — A is ${A.rows}×${A.cols}, b has length ${b.length}`);
  }

  const luRes = lu(A);
  if (luRes === null) return null;

  // Step 1: initial solve.
  let x = luSolve(luRes, b);

  // Step 2: residual + (conditional) one refinement step.
  const bNorm = vecNorm2(b);
  let residualNorm = computeResidualNorm(A, x, b);
  let iterations = 0;

  const refineThreshold = REFINE_THRESHOLD_FACTOR * A.rows * EPS;
  if (bNorm > 0 && residualNorm / bNorm > refineThreshold) {
    const r = computeResidual(A, x, b);
    const d = luSolve(luRes, r);
    const xNew = new Float64Array(A.rows);
    for (let i = 0; i < A.rows; i++) xNew[i] = x[i]! + d[i]!;
    const newResidualNorm = computeResidualNorm(A, xNew, b);
    // Accept the refinement only if it actually helped. On
    // ill-conditioned problems, refinement can occasionally make
    // things worse in float64; reject in that case.
    if (newResidualNorm < residualNorm) {
      x = xNew;
      residualNorm = newResidualNorm;
      iterations = 1;
    }
  }

  // Step 3: condition estimate. Cheap (~4 solves with the LU).
  const ANorm1 = matNorm1(A);
  const AInvNorm1Estimate = hagerOneNormEstimate(luRes);
  const conditionEstimate = ANorm1 * AInvNorm1Estimate;

  return {
    x,
    residualNorm,
    bNorm,
    conditionEstimate,
    growthFactor: luRes.growthFactor,
    method: "lu-partial-pivot",
    iterations,
  };
}

function computeResidual(A: Matrix, x: Float64Array, b: Float64Array): Float64Array {
  const Ax = matVec(A, x);
  const r = new Float64Array(b.length);
  for (let i = 0; i < b.length; i++) r[i] = b[i]! - Ax[i]!;
  return r;
}

function computeResidualNorm(A: Matrix, x: Float64Array, b: Float64Array): number {
  return vecNorm2(computeResidual(A, x, b));
}

/**
 * Same as `solve` but takes a precomputed LU. Useful when solving
 * many right-hand sides against the same A (the LU cost amortises);
 * the tool layer doesn't expose this yet, but the library does.
 */
export function solveWithLU(A: Matrix, luRes: LUResult, b: Float64Array): SolveResult {
  if (A.rows !== b.length) {
    throw new Error(`solveWithLU: dim mismatch — A is ${A.rows}×${A.cols}, b has length ${b.length}`);
  }
  let x = luSolve(luRes, b);
  const bNorm = vecNorm2(b);
  let residualNorm = computeResidualNorm(A, x, b);
  let iterations = 0;

  const refineThreshold = REFINE_THRESHOLD_FACTOR * A.rows * EPS;
  if (bNorm > 0 && residualNorm / bNorm > refineThreshold) {
    const r = computeResidual(A, x, b);
    const d = luSolve(luRes, r);
    const xNew = new Float64Array(A.rows);
    for (let i = 0; i < A.rows; i++) xNew[i] = x[i]! + d[i]!;
    const newResidualNorm = computeResidualNorm(A, xNew, b);
    if (newResidualNorm < residualNorm) {
      x = xNew;
      residualNorm = newResidualNorm;
      iterations = 1;
    }
  }

  const ANorm1 = matNorm1(A);
  const AInvNorm1Estimate = hagerOneNormEstimate(luRes);
  const conditionEstimate = ANorm1 * AInvNorm1Estimate;

  return {
    x,
    residualNorm,
    bNorm,
    conditionEstimate,
    growthFactor: luRes.growthFactor,
    method: "lu-partial-pivot",
    iterations,
  };
}
