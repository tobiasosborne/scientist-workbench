// 6-flag / 11-status convergence test (FUN_00732a50 L482-600).
// We compute the same relative + absolute primal/dual feasibility and
// gap flags; the status code is derived from their conjunction plus
// iter/time/stall guards.

import type { Iterate, SolverStatus } from "./Iterate.js";
import type { IpmParams } from "./Defaults.js";
import type { LpProblem } from "../problem/LpProblem.js";
import { vecNormInf, vecNorm2 } from "./Residuals.js";

export interface ConvergenceCheck {
  status: SolverStatus;
  flagRelPrimal: boolean;
  flagRelDual: boolean;
  flagAbsPrimal: boolean;
  flagAbsDual: boolean;
  flagGapRel: boolean;
  flagGapAbs: boolean;
}

export function checkConvergence(
  it: Iterate,
  lp: LpProblem,
  p: IpmParams,
): ConvergenceCheck {
  const bNorm = Math.max(1, vecNormInf(lp.b));
  const cNorm = Math.max(1, vecNormInf(lp.c));

  const flagRelPrimal = it.primalInf / bNorm <= p.feasTol;
  const flagRelDual = it.dualInf / cNorm <= p.feasTol;
  const flagAbsPrimal = it.primalInf <= p.feasTol;
  const flagAbsDual = it.dualInf <= p.feasTol;

  const gapDenom = 1 + Math.abs(it.primalObj) + Math.abs(it.dualObj);
  const flagGapRel = it.gap / gapDenom <= p.optTol;
  const flagGapAbs = it.gap <= p.optTol;

  let status: SolverStatus = "running";

  // Order matters: optimal first, then resource limits, then degraded states.
  if (flagRelPrimal && flagRelDual && (flagGapRel || flagGapAbs)) {
    status = "optimal";
  } else if (flagRelDual && flagGapAbs && it.iter > 0) {
    status = "dual-feasible";
  }

  // Farkas-style infeasibility certificates (FUN_00732a50 L587, L593).
  //
  // Primal infeasible: there exists a "ray" (y, s) with A^T y + s ≈ 0, s ≥ 0,
  // and b^T y > 0. In a primal-dual IPM, this presents as the dual residual
  // shrinking while the dual objective grows positive without bound.
  //
  // Dual infeasible / primal unbounded: there exists x ≥ 0 with A x ≈ 0 and
  // c^T x < 0. Presents as primal residual shrinking while the primal
  // objective diverges to -∞.
  //
  // We require iter > 5 to avoid false positives during early iterations,
  // and a magnitude threshold of 1e8 to avoid mis-classifying slow
  // convergence as a certificate.
  if (status === "running" && it.iter > 5) {
    const xInfNorm = vecNormInf(it.x);
    const yInfNorm = vecNormInf(it.y);
    const huge = 1e8;
    if (it.dualInf <= 1e-6 && it.dualObj > huge && yInfNorm > huge) {
      status = "primal-infeasible";
    } else if (it.primalInf <= 1e-6 && it.primalObj < -huge && xInfNorm > huge) {
      status = "dual-infeasible";
    }
  }

  if (status === "running") {
    if (Date.now() - it.startMs > p.timeLimitSec * 1000) status = "time-limit";
    else if (it.iter >= p.iterLimit) status = "iter-limit";
    else if (it.stallCount >= p.stallIterCap) status = "numerical-difficulty";
  }

  return {
    status,
    flagRelPrimal,
    flagRelDual,
    flagAbsPrimal,
    flagAbsDual,
    flagGapRel,
    flagGapAbs,
  };
}

export { vecNormInf, vecNorm2 };
