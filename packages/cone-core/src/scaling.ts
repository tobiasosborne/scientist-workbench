// =============================================================================
// scaling.ts — diagonal data equilibration (O'Donoghue 2016 §5)
// =============================================================================
//
// The SCS iteration (`scs.ts`) has no parameters, but the *relative
// scaling* of the problem data strongly affects how fast it converges
// (O'Donoghue 2016 §5, p. 1057–1058). A problem whose constraint matrix
// has rows and columns of wildly different magnitudes — the norm for
// NETLIB LPs, whose coefficients span many orders of magnitude — can
// stall the first-order iteration for thousands of iterations. The fix
// the paper prescribes is a *preprocessing* step: rescale the data so the
// rows and columns of `A` have comparable norms, solve the well-scaled
// problem, and map the solution back.
//
// This module computes the diagonal scaling `D` (rows) and `E` (columns)
// by **Ruiz equilibration** (Ruiz 2001, the paper's ref [80]): a few
// rounds of alternating row/column geometric rescaling that drive every
// row and column of `D A E` toward unit ∞-norm. For the LP-complete cone
// subset every positive diagonal `D` preserves cone membership (nonneg /
// zero / free cones are closed under positive componentwise scaling), so
// `D` is an unconstrained positive diagonal — the block-constant
// restriction the paper notes is only needed once `cone-core` grows the
// SOC / PSD cones.
//
// The paper's scalar factors `σ` (on `b`) and `ρ` (on `c`) are folded
// into `D` and `E` — `cone-core` v0.1 takes `σ = ρ = 1` and leaves the
// scalar-balancing refinement to a follow-up if a bench case still
// stalls. Ground truth: `docs/ground-truth/convex/scs-algorithm.md` §5.

import { type Matrix, matZeros } from "@workbench/linalg-core";
import { type ConeProblem, type Scaling } from "./hsde.js";

/**
 * Compute a Ruiz-equilibration scaling for a cone problem: positive
 * diagonals `D` (length `m`) and `E` (length `n`) such that the rescaled
 * matrix `D A E` has rows and columns of near-unit ∞-norm.
 *
 * Each round: take the ∞-norm of every row and every column of the
 * *currently* scaled matrix `D A E`, then divide `Dᵢ` by `√(rowᵢ)` and
 * `Eⱼ` by `√(colⱼ)`. A zero row or column leaves its scale untouched —
 * there is nothing to equilibrate, and dividing by `√0` would poison the
 * scaling. The default 20 rounds is comfortably past the geometric
 * convergence point for the dense small problems `cone-core` v0.1
 * targets; the iteration is `O(rounds · m · n)`.
 */
export function equilibrate(problem: ConeProblem, rounds = 20): Scaling {
  const A: Matrix = problem.A;
  const m = A.rows;
  const n = A.cols;
  const D = new Float64Array(m).fill(1);
  const E = new Float64Array(n).fill(1);

  for (let round = 0; round < rounds; round++) {
    const rowNorm = new Float64Array(m);
    const colNorm = new Float64Array(n);
    for (let i = 0; i < m; i++) {
      const di = D[i]!;
      const base = i * n;
      for (let j = 0; j < n; j++) {
        const scaled = Math.abs(di * A.data[base + j]! * E[j]!);
        if (scaled > rowNorm[i]!) rowNorm[i] = scaled;
        if (scaled > colNorm[j]!) colNorm[j] = scaled;
      }
    }
    for (let i = 0; i < m; i++) {
      const r = rowNorm[i]!;
      if (r > 0) D[i] = D[i]! / Math.sqrt(r);
    }
    for (let j = 0; j < n; j++) {
      const c = colNorm[j]!;
      if (c > 0) E[j] = E[j]! / Math.sqrt(c);
    }
  }

  return { D, E };
}

/**
 * Apply a `Scaling` to a `ConeProblem`, producing the rescaled problem
 * `Â = D A E`, `b̂ = D b`, `ĉ = E c` (the paper's `σ = ρ = 1` case). The
 * cone product is carried through unchanged — every cone in the
 * LP-complete subset is invariant under the positive-diagonal `D`, so the
 * scaled slack lands in the same cone.
 *
 * `scsSolve` solves the rescaled problem and `recoverPrimalDual` (given
 * the same `Scaling`) maps the embedding iterate back to the original
 * problem's coordinates — see `hsde.ts`.
 */
export function applyScaling(problem: ConeProblem, scaling: Scaling): ConeProblem {
  const { A, b, c, cones } = problem;
  const m = A.rows;
  const n = A.cols;
  const { D, E } = scaling;

  const scaledA = matZeros(m, n);
  for (let i = 0; i < m; i++) {
    const di = D[i]!;
    const base = i * n;
    for (let j = 0; j < n; j++) {
      scaledA.data[base + j] = di * A.data[base + j]! * E[j]!;
    }
  }
  const scaledB = new Float64Array(m);
  for (let i = 0; i < m; i++) scaledB[i] = D[i]! * b[i]!;
  const scaledC = new Float64Array(n);
  for (let j = 0; j < n; j++) scaledC[j] = E[j]! * c[j]!;

  return { A: scaledA, b: scaledB, c: scaledC, cones };
}
