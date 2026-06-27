// Mehrotra predictor-corrector primal-dual interior-point method for the
// convex QP `min ½xᵀQx + cᵀx s.t. Ax=b, x≥0` (Q ⪰ 0). Ground truth:
// docs/ground-truth/convex/qp-ipm.md §6; decision record ADR-0044.
//
// This is the QP generalisation of `solveLp` (Solver.ts): the Mehrotra
// loop shape — residuals → factor-once → predictor → σ=clamp((μ_aff/μ)³)
// → corrector (reusing the factor) → safeguarded fraction-to-boundary
// step — is identical. The two QP-specific changes are (i) the matrix
// factored is the augmented quasidefinite KKT `K` (★), not the LP m×m
// normal-equations Schur, factored by the static signed-Cholesky
// (`SignedRegularization.ts`); and (ii) `r_d` carries the `Qx` term
// (`QpResiduals.ts`). The Q=0 restriction reproduces the LP trajectory
// (the consistency anchor, qp-ipm.md §3).

import { type QpIterate, makeQpIterate } from "./QpIterate.js";
import type { SolverStatus } from "./Iterate.js";
import type { IpmParams } from "./Defaults.js";
import { DEFAULT_PARAMS } from "./Defaults.js";
import type { QpProblem } from "../problem/QpProblem.js";
import { updateQpResiduals } from "./QpResiduals.js";
import { checkQpConvergence } from "./QpConvergence.js";
import { assembleKktStatic, updateKktDiagonal } from "./QpKktAssembler.js";
import { signedFactorWithRetry, DEFAULT_QP_REG, type QpRegParams } from "./SignedRegularization.js";
import { qpPredictorDirection, qpCorrectorDirection } from "./QpDirection.js";
import { maxStepToBoundary, safeguardStep } from "./StepLength.js";
import { vecNormInf } from "./Residuals.js";

export interface QpSolveResult {
  status: SolverStatus;
  iterate: QpIterate;
}

export interface QpSolveOptions {
  params?: Partial<IpmParams>;
  reg?: Partial<QpRegParams>;
  initialPoint?: (qp: QpProblem) => { x: Float64Array; y: Float64Array; s: Float64Array };
}

// Relative floor for the base proximal regularization (ρ0 = δ0). Scaled
// by the problem data magnitude, NOT by the per-iteration X⁻¹S range, so
// the proximal bias stays ~1e-10 (the accuracy ceiling) and does not
// inflate as μ → 0.
const REG_BASE = 1e-10;

export function solveQp(qp: QpProblem, opts: QpSolveOptions = {}): QpSolveResult {
  const params: IpmParams = { ...DEFAULT_PARAMS, ...(opts.params ?? {}) };
  const reg: QpRegParams = { ...DEFAULT_QP_REG, ...(opts.reg ?? {}) };
  const it = makeQpIterate(qp.m, qp.n);
  it.startMs = Date.now();

  // Base proximal levels, scaled by the data magnitude (data-, not
  // iteration-dependent — qp-ipm.md §5).
  const dataScale = problemScale(qp);
  it.rho0 = REG_BASE * dataScale;
  it.delta0 = REG_BASE * dataScale;

  const init = (opts.initialPoint ?? defaultInitialPoint)(qp);
  it.x.set(init.x);
  it.y.set(init.y);
  it.s.set(init.s);

  // Static augmented pattern (Q, A, base ±reg, y-block +δ0).
  assembleKktStatic(it, qp);

  for (it.iter = 0; it.iter <= params.iterLimit; it.iter++) {
    updateQpResiduals(it, qp);

    const status = checkQpConvergence(it, qp, params);
    if (status !== "running") {
      it.status = status;
      return { status, iterate: it };
    }

    // Refresh the x-block diagonal with the new X⁻¹S, then factor once.
    updateKktDiagonal(it, qp);
    const factorRes = signedFactorWithRetry(it, reg);
    if (!factorRes.success) {
      it.status = "numerical-error";
      return { status: it.status, iterate: it };
    }

    // Predictor (affine, σ = 0). Save the affine direction.
    qpPredictorDirection(it);
    it.dxAff.set(it.dx);
    it.dsAff.set(it.ds);

    const aP = Math.min(1, maxStepToBoundary(it.x, it.dxAff));
    const aD = Math.min(1, maxStepToBoundary(it.s, it.dsAff));
    let muAff = 0;
    for (let j = 0; j < qp.n; j++) {
      muAff += (it.x[j]! + aP * it.dxAff[j]!) * (it.s[j]! + aD * it.dsAff[j]!);
    }
    muAff /= Math.max(1, qp.n);
    const sigma = Math.max(0, Math.min(1, (muAff / Math.max(it.mu, 1e-300)) ** 3));

    // Corrector (reuses the same factor).
    qpCorrectorDirection(it, sigma * it.mu);

    const alphaP = safeguardStep(Math.min(1, maxStepToBoundary(it.x, it.dx)), params.stepFactor);
    const alphaD = safeguardStep(Math.min(1, maxStepToBoundary(it.s, it.ds)), params.stepFactor);

    const muBefore = it.mu;
    for (let j = 0; j < qp.n; j++) it.x[j] = it.x[j]! + alphaP * it.dx[j]!;
    for (let i = 0; i < qp.m; i++) it.y[i] = it.y[i]! + alphaD * it.dy[i]!;
    for (let j = 0; j < qp.n; j++) it.s[j] = it.s[j]! + alphaD * it.ds[j]!;

    // Stall detection (mirrors Solver.ts:305-316).
    let muNew = 0;
    for (let j = 0; j < qp.n; j++) muNew += it.x[j]! * it.s[j]!;
    muNew /= Math.max(1, qp.n);
    if (muNew > 0.99 * muBefore) it.stallCount++;
    else it.stallCount = 0;
  }

  it.status = "iter-limit";
  return { status: it.status, iterate: it };
}

// Mehrotra infeasible-start heuristic, reusing the LP rule (Wright 1997
// §11; cf. Solver.ts defaultInitialPoint): x = s = const > 0, y = 0.
function defaultInitialPoint(qp: QpProblem): {
  x: Float64Array;
  y: Float64Array;
  s: Float64Array;
} {
  const { m, n, b, c } = qp;
  const xi = Math.max(1, 10 * vecNormInf(b));
  const eta = Math.max(1, 10 * vecNormInf(c));
  return {
    x: new Float64Array(n).fill(xi),
    s: new Float64Array(n).fill(eta),
    y: new Float64Array(m),
  };
}

function problemScale(qp: QpProblem): number {
  let s = 1;
  for (let i = 0; i < qp.Q.length; i++) {
    const a = Math.abs(qp.Q[i]!);
    if (a > s) s = a;
  }
  for (let i = 0; i < qp.A.length; i++) {
    const a = Math.abs(qp.A[i]!);
    if (a > s) s = a;
  }
  return s;
}
