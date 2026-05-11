// Primal-dual IPM main loop for the LP path. Mehrotra 1992
// predictor-corrector with size-3 Tikhonov regularization on the Schur
// complement and a Cholesky-factored normal-equations solve.

import { type Iterate, makeIterate, type SolverStatus } from "./Iterate.js";
import type { IpmParams } from "./Defaults.js";
import { DEFAULT_PARAMS } from "./Defaults.js";
import type { LpProblem } from "../problem/LpProblem.js";
import { updateResiduals, vecNormInf } from "./Residuals.js";
import { checkConvergence } from "./Convergence.js";
import { schurAssembleNormalEq } from "../linalg/SchurAssembler.js";
import { choleskyInPlace } from "../linalg/Cholesky.js";
import {
  predictorDirection,
  correctorDirection,
} from "./Direction.js";
import { maxStepToBoundary, safeguardStep } from "./StepLength.js";

export interface SolveResult {
  status: SolverStatus;
  iterate: Iterate;
  log: IterLogLine[];
}

export interface IterLogLine {
  iter: number;
  primalObj: number;
  dualObj: number;
  compl: number;
  primalInf: number;
  dualInf: number;
  timeSec: number;
}

export interface SolveOptions {
  params?: Partial<IpmParams>;
  initialPoint?: (lp: LpProblem) => { x: Float64Array; y: Float64Array; s: Float64Array };
  log?: (line: IterLogLine, it: Iterate) => void;
}

export function solveLp(lp: LpProblem, opts: SolveOptions = {}): SolveResult {
  const params: IpmParams = { ...DEFAULT_PARAMS, ...(opts.params ?? {}) };
  const it = makeIterate(lp.m, lp.n);
  it.startMs = Date.now();
  const init = (opts.initialPoint ?? defaultInitialPoint)(lp);
  it.x.set(init.x);
  it.y.set(init.y);
  it.s.set(init.s);
  it.jitterPrimal = params.initialJitter;
  it.jitterDual = params.initialJitter;
  it.jitterGap = params.initialJitter;

  const log: IterLogLine[] = [];

  for (it.iter = 0; it.iter <= params.iterLimit; it.iter++) {
    updateResiduals(it, lp);

    const conv = checkConvergence(it, lp, params);
    const line: IterLogLine = {
      iter: it.iter,
      primalObj: it.primalObj,
      dualObj: it.dualObj,
      compl: it.mu,
      primalInf: it.primalInf,
      dualInf: it.dualInf,
      timeSec: (Date.now() - it.startMs) / 1000,
    };
    log.push(line);
    opts.log?.(line, it);

    if (conv.status !== "running") {
      it.status = conv.status;
      return { status: it.status, iterate: it, log };
    }

    // Build LP Schur complement M = A · diag(x/s) · A^T.
    const d = new Float64Array(lp.n);
    for (let j = 0; j < lp.n; j++) d[j] = it.x[j]! / it.s[j]!;
    schurAssembleNormalEq(lp.A, lp.m, lp.n, d, it.M);

    // 3-way regularization retry loop.
    if (!factorWithRegularization(it, params)) {
      it.status = "numerical-error";
      return { status: it.status, iterate: it, log };
    }

    // Predictor: σ = 0.
    predictorDirection(it, lp);
    const dxAff = new Float64Array(it.dx);
    const dyAff = new Float64Array(it.dy);
    const dsAff = new Float64Array(it.ds);
    const alphaPaff = maxStepToBoundary(it.x, dxAff);
    const alphaDaff = maxStepToBoundary(it.s, dsAff);

    // σ = (μ_aff / μ)^3, Mehrotra centering heuristic.
    let muAff = 0;
    const aP = Math.min(1, alphaPaff);
    const aD = Math.min(1, alphaDaff);
    for (let j = 0; j < lp.n; j++) {
      muAff += (it.x[j]! + aP * dxAff[j]!) * (it.s[j]! + aD * dsAff[j]!);
    }
    muAff /= Math.max(1, lp.n);
    const sigma = Math.max(0, Math.min(1, (muAff / Math.max(it.mu, 1e-300)) ** 3));
    const sigmaMu = sigma * it.mu;

    // Corrector: rc = -XSe + σμ - Δx_aff ∘ Δs_aff, reusing Cholesky factor.
    correctorDirection(it, lp, sigmaMu, dxAff, dsAff);

    // Step lengths with Mehrotra safeguard.
    const alphaPraw = Math.min(1, maxStepToBoundary(it.x, it.dx));
    const alphaDraw = Math.min(1, maxStepToBoundary(it.s, it.ds));
    const alphaP = safeguardStep(alphaPraw, params.stepFactor);
    const alphaD = safeguardStep(alphaDraw, params.stepFactor);

    // Update iterate (LP branch).
    for (let j = 0; j < lp.n; j++) it.x[j] = it.x[j]! + alphaP * it.dx[j]!;
    for (let i = 0; i < lp.m; i++) it.y[i] = it.y[i]! + alphaD * it.dy[i]!;
    for (let j = 0; j < lp.n; j++) it.s[j] = it.s[j]! + alphaD * it.ds[j]!;

    // Stall detection — μ failed to decrease.
    const muBefore = it.mu;
    let muNew = 0;
    for (let j = 0; j < lp.n; j++) muNew += it.x[j]! * it.s[j]!;
    muNew /= Math.max(1, lp.n);
    if (muNew > 0.9 * muBefore) it.stallCount++;
    else it.stallCount = 0;
  }

  it.status = "iter-limit";
  return { status: it.status, iterate: it, log };
}

// Mehrotra warm-start (LP, infeasible-start). Standard heuristic
// from Wright 1997 §11: ξ = max(1, 10·‖b‖∞), η = max(1, 10·‖c‖∞).
// Suitable for small dense problems; a more elaborate workspace
// builder (Andersen-Andersen 2000) is the natural extension if the
// iteration count climbs on individual NETLIB cases.
function defaultInitialPoint(lp: LpProblem): {
  x: Float64Array;
  y: Float64Array;
  s: Float64Array;
} {
  const { m, n, b, c } = lp;
  const bNorm = vecNormInf(b);
  const cNorm = vecNormInf(c);
  const xi = Math.max(1, 10 * bNorm);
  const eta = Math.max(1, 10 * cNorm);
  const x = new Float64Array(n).fill(xi);
  const s = new Float64Array(n).fill(eta);
  const y = new Float64Array(m);
  return { x, y, s };
}

function factorWithRegularization(it: Iterate, params: IpmParams): boolean {
  const m = it.m;
  for (let attempt = 0; attempt < 20; attempt++) {
    it.Lchol.set(it.M);
    const info = choleskyInPlace(it.Lchol, m, it.jitterPrimal);
    if (info < 0) return true;
    // Three-tier bump pattern: without inertia diagnostics here we
    // simply escalate primal regularization first, then dual, then gap.
    if (attempt < 6 || it.jitterPrimal < params.jitterMaxPrimal) {
      it.jitterPrimal = Math.max(it.jitterPrimal, 1e-12) * params.bumpPrimal;
      it.bumpsPrimal++;
    } else if (it.jitterDual < params.jitterMaxDual) {
      it.jitterDual = Math.max(it.jitterDual, 1e-12) * params.bumpDual;
      it.bumpsDual++;
    } else if (it.jitterGap < params.jitterMaxGap) {
      it.jitterGap = Math.max(it.jitterGap, 1e-12) * params.bumpGap;
      it.bumpsGap++;
    } else {
      return false;
    }
    it.refactors++;
  }
  return false;
}
