// Predictor + corrector direction compute for the QP path. Ground truth:
// docs/ground-truth/convex/qp-ipm.md §§3,6.
//
// The augmented system (★) is, after eliminating Δs:
//   [ −(Q+X⁻¹S)  Aᵀ ][Δx]   [ r_d + X⁻¹ r_c ]
//   [     A        0 ][Δy] = [    −r_p        ]
// `Kfac` already holds the signed-LDLᵀ factor of the regularized
// left-hand matrix (built once per outer iteration by the solver loop,
// reused by BOTH predictor and corrector — only the RHS changes). The
// complementarity RHS `r_c` distinguishes the two:
//   predictor: r_c = XSe                              (σ = 0)
//   corrector: r_c = XSe + ΔX_aff ΔS_aff e − σμ e
// After the augmented solve yields (Δx, Δy), Δs is recovered from the
// eliminated row: Δs_j = (−r_c_j − s_j Δx_j) / x_j.

import type { QpIterate } from "./QpIterate.js";
import { ldltSolveInPlace } from "../linalg/SignedLdlt.js";
import { symMatVecN } from "./QpKktAssembler.js";
import { vecNormInf } from "./Residuals.js";

// Iterative-refinement parameters (qp-ipm.md §6 "Iterative refinement").
// Mirrors `IterativeRefinement.ts solveWithIR`: a few trial/rollback
// steps that polish the single LDLᵀ solve toward the PROXIMAL TARGET
// `K0` (base ρ0,δ0 — the well-posed nearby system) using the
// escalation-regularized `Kfac` as the approximate solver. This is what
// recovers the last 2–3 digits the augmented-system √-conditioning
// leaves headroom for, so the solver reaches the 1e-10 ceiling rather
// than flooring at the single-solve roundoff (cond·u).
const IR_MAX = 5;
const IR_TOL_REL = 1e-14;
const IR_STAGNATION = 6;

// Refine `K0 · v = rhs` in place into `it.dv`, using `it.Kfac` (the
// signed-LDLᵀ factor of the escalation-regularized matrix) as the
// approximate solver and `symMatVecN(K0)` for the true residual. The
// trial/rollback loop is the QP analogue of `solveWithIR` (fixed-
// precision IR is not monotone — Higham §12.1 — so a residual-worsening
// trial is rolled back exactly). Returns the number of accepted refines.
function ldltSolveRefined(it: QpIterate, rhs: Float64Array): number {
  const { N } = it;
  const sol = it.dv;
  const res = it.irRes;
  const corr = it.irCorr;

  // Initial solve sol ≈ Kfac⁻¹ rhs.
  sol.set(rhs);
  ldltSolveInPlace(it.Kfac, N, sol);

  const convTol = IR_TOL_REL * (1 + vecNormInf(rhs));

  // res = rhs − K0·sol (residual against the proximal target K0).
  symMatVecN(it.K0, N, sol, res);
  for (let i = 0; i < N; i++) res[i] = rhs[i]! - res[i]!;

  let prevErr = Infinity;
  let nrefine = 0;
  for (let k = 0; k < IR_MAX; k++) {
    const err = vecNormInf(res);
    if (err < convTol) break; // already accurate to working precision
    if (prevErr / err < IR_STAGNATION) break; // diminishing returns

    // Trial correction (same factor), applied in place.
    corr.set(res);
    ldltSolveInPlace(it.Kfac, N, corr);
    for (let i = 0; i < N; i++) sol[i] = sol[i]! + corr[i]!;

    // Trial residual.
    symMatVecN(it.K0, N, sol, res);
    for (let i = 0; i < N; i++) res[i] = rhs[i]! - res[i]!;
    if (vecNormInf(res) > err) {
      // Worsened — roll back exactly and stop.
      for (let i = 0; i < N; i++) sol[i] = sol[i]! - corr[i]!;
      break;
    }
    prevErr = err;
    nrefine++;
  }
  return nrefine;
}

// Core solve: given the complementarity RHS `rc` (length n, the actual
// r_c value), assemble the length-N augmented RHS, solve (with iterative
// refinement) using the pre-factored `Kfac`, and write Δx (it.dx),
// Δy (it.dy), Δs (it.ds).
export function solveQpNewton(it: QpIterate, rc: Float64Array): void {
  const { n, m, N } = it;
  const u = it.u;

  // top block: u[j] = r_d[j] + r_c[j]/x[j]   (= r_d + X⁻¹ r_c)
  for (let j = 0; j < n; j++) u[j] = it.rd[j]! + rc[j]! / it.x[j]!;
  // bottom block: u[n+i] = −r_p[i]
  for (let i = 0; i < m; i++) u[n + i] = -it.rp[i]!;

  // Solve K [Δx;Δy] = u, refined toward the proximal target K0.
  ldltSolveRefined(it, u);
  const v = it.dv;

  for (let j = 0; j < n; j++) it.dx[j] = v[j]!;
  for (let i = 0; i < m; i++) it.dy[i] = v[n + i]!;

  // Δs_j = (−r_c_j − s_j Δx_j) / x_j.
  for (let j = 0; j < n; j++) {
    it.ds[j] = (-rc[j]! - it.s[j]! * it.dx[j]!) / it.x[j]!;
  }
}

// Predictor (affine): r_c = XSe. Writes it.dx/dy/ds.
export function qpPredictorDirection(it: QpIterate): void {
  const rc = it.rc;
  for (let j = 0; j < it.n; j++) rc[j] = it.x[j]! * it.s[j]!;
  solveQpNewton(it, rc);
}

// Corrector: r_c = XSe + ΔX_aff ΔS_aff e − σμ e, reusing the same factor.
// `it.dxAff`/`it.dsAff` must hold the saved predictor direction.
export function qpCorrectorDirection(it: QpIterate, sigmaMu: number): void {
  const rc = it.rc;
  for (let j = 0; j < it.n; j++) {
    rc[j] = it.x[j]! * it.s[j]! + it.dxAff[j]! * it.dsAff[j]! - sigmaMu;
  }
  solveQpNewton(it, rc);
}
