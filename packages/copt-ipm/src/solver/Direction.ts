// Predictor + corrector direction compute for the LP cone.
// The KKT Newton system collapses (via Δx, Δs elimination) into
//   M Δy = rp - A diag(1/s) rc + A diag(x/s) rd
//   Δs = rd - A^T Δy
//   Δx = (rc - x ∘ Δs) / s
// where rc is the right-hand side of the complementarity equation:
//   predictor: rc = -x ∘ s
//   corrector: rc = -x ∘ s + σμ e - Δx_aff ∘ Δs_aff

import type { Iterate } from "./Iterate.js";
import type { LpProblem } from "../problem/LpProblem.js";
import { choleskySolveInPlace } from "../linalg/Cholesky.js";
import { matVec, matVecTranspose } from "../linalg/SchurAssembler.js";

export function solveNewtonSystem(
  it: Iterate,
  lp: LpProblem,
  rc: Float64Array, // complementarity RHS, length n
): void {
  const { m, n, A } = lp;
  // tmpN = rc / s - (x/s) ∘ rd
  // rhs = rp - A · tmpN
  // (so rhs = rp - A diag(1/s) rc + A diag(x/s) rd)
  const tmpN = new Float64Array(n);
  for (let j = 0; j < n; j++) {
    tmpN[j] = rc[j]! / it.s[j]! - (it.x[j]! / it.s[j]!) * it.rd[j]!;
  }
  matVec(A, m, n, tmpN, it.rhs);
  for (let i = 0; i < m; i++) it.rhs[i] = it.rp[i]! - it.rhs[i]!;

  // Solve M Δy = rhs  (M is held factored in it.Lchol).
  it.dy.set(it.rhs);
  choleskySolveInPlace(it.Lchol, m, it.dy);

  // Δs = rd - A^T Δy
  matVecTranspose(A, m, n, it.dy, it.ds);
  for (let j = 0; j < n; j++) it.ds[j] = it.rd[j]! - it.ds[j]!;

  // Δx = (rc - x ∘ Δs) / s
  for (let j = 0; j < n; j++) {
    it.dx[j] = (rc[j]! - it.x[j]! * it.ds[j]!) / it.s[j]!;
  }
}

// Predictor: σ = 0, rc = -x ∘ s. Mutates it.dx, it.dy, it.ds.
export function predictorDirection(it: Iterate, lp: LpProblem): void {
  const rc = new Float64Array(lp.n);
  for (let j = 0; j < lp.n; j++) rc[j] = -it.x[j]! * it.s[j]!;
  solveNewtonSystem(it, lp, rc);
}

// Corrector: σμ - Δx_aff ∘ Δs_aff. Reuses it.Lchol factorization.
// `dxAff`, `dsAff` must be the predictor results (caller saved them first).
export function correctorDirection(
  it: Iterate,
  lp: LpProblem,
  sigmaMu: number,
  dxAff: Float64Array,
  dsAff: Float64Array,
): void {
  const rc = new Float64Array(lp.n);
  for (let j = 0; j < lp.n; j++) {
    rc[j] = -it.x[j]! * it.s[j]! + sigmaMu - dxAff[j]! * dsAff[j]!;
  }
  solveNewtonSystem(it, lp, rc);
}
