// Convergence / termination test for the QP path — a faithful port of
// the LP `Convergence.ts` logic, retyped for `QpIterate` / `QpProblem`
// so the tested LP path is not perturbed (ADR-0012 blast-radius
// discipline). Same six relative/absolute feasibility+gap flags and the
// same Farkas-style infeasibility certificates; the only QP difference
// is that `primalObj`/`dualObj`/`gap` already carry the quadratic term
// (QpResiduals.ts).

import type { QpIterate } from "./QpIterate.js";
import type { QpProblem } from "../problem/QpProblem.js";
import type { IpmParams } from "./Defaults.js";
import type { SolverStatus } from "./Iterate.js";
import { vecNormInf } from "./Residuals.js";

export function checkQpConvergence(it: QpIterate, qp: QpProblem, p: IpmParams): SolverStatus {
  const bNorm = Math.max(1, vecNormInf(qp.b));
  const cNorm = Math.max(1, vecNormInf(qp.c));

  const flagRelPrimal = it.primalInf / bNorm <= p.feasTol;
  const flagRelDual = it.dualInf / cNorm <= p.feasTol;

  const gapDenom = 1 + Math.abs(it.primalObj) + Math.abs(it.dualObj);
  const flagGapRel = it.gap / gapDenom <= p.optTol;
  const flagGapAbs = it.gap <= p.optTol;

  let status: SolverStatus = "running";

  // QP requires BOTH primal and dual feasibility (plus gap) for `optimal`.
  // Unlike the LP/SDP paths, the QP path does NOT report a primal-
  // infeasible `dual-feasible` iterate as wire-`optimal`: there is no
  // best-iterate tracking here, and calling a primal-infeasible point
  // "optimal" would be dishonest (Rule 8). A run that only reaches dual
  // feasibility keeps iterating and terminates `iter-limit` (wire
  // `iter-cap`) — the caller reads `achieved_precision` for the gap.
  if (flagRelPrimal && flagRelDual && (flagGapRel || flagGapAbs)) {
    status = "optimal";
  }

  // Farkas-style certificates (mirrors Convergence.ts:60-69): require a
  // few iterations + a magnitude threshold to avoid mislabelling slow
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

  // No wall-clock branch (cf. the LP path's time-limit): a numerical:true
  // tool must be a pure function of its input + platform fingerprint, so
  // termination uses only the deterministic iteration cap and stall count
  // (ADR-0044 §E). This is the one deliberate divergence from the ported
  // LP `Convergence.ts`.
  if (status === "running") {
    if (it.iter >= p.iterLimit) status = "iter-limit";
    else if (it.stallCount >= p.stallIterCap) status = "numerical-difficulty";
  }

  return status;
}
