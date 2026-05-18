// HSDE LP solver — Homogeneous Self-Dual Embedding for linear
// programming. The iterate carries the standard primal-dual triple
// `(x, y, s)` augmented by the homogenization scalars `(τ, κ)`. The
// homogenized model (Mosek capi.pdf eq. 13.8, Andersen 2009 eq. 3
// rearranged):
//
//     A·x − b·τ            = 0      (primal feasibility)
//     A^T·y + s − c·τ      = 0      (dual feasibility)
//     −c^T·x + b^T·y − κ   = 0      (gap feasibility)
//                  x·s + τ·κ = 0    (homogenized complementarity)
//
// Cone: x ∈ R^n_+, s ∈ R^n_+, τ > 0, κ > 0 on trial iterates.
//
// Sign convention. We follow Andersen 2009 / Mosek capi.pdf
// throughout — NOT the ECOS convention, which flips the sign of
// `b^T y` in the gap row due to using `max −b^T y` as the dual
// objective. The two-RHS implementation pattern is ECOS's, but the
// algebra is And09/Mosek. See ADR-0033 §"Decision 2" for the
// reasoning.
//
// Implementation structure (ADR-0033 §"Decision 3"):
//
// 1. The 5×5 augmented Newton system is NOT assembled. Following
//    ECOS, we eliminate τ, κ from the linear system: factor the
//    standard primal-dual KKT Schur complement `M = A·D·A^T` (where
//    `D = diag(x/s)`) ONCE per iter, solve THREE right-hand sides
//    against the same Cholesky factor:
//
//      RHS1 (data direction):    `M·dy1 = A·D·c + b`
//      RHS2 affine (predictor):  iterate-dependent, η=1, γ=0
//      RHS2 combined (corrector): iterate-dependent, η=1−σ, γ=σ
//
// 2. τ, κ are recovered via scalar formulas OUTSIDE the linear
//    system. The `dτ_denom = κ/τ − c^T·dx1 + b^T·dy1` is computed
//    ONCE per iter and reused for both the affine and combined dτ
//    formulas (it depends only on `(x, y, s, τ, κ)` and the data
//    direction, neither of which moves within an iter).
//
// Derivation (full, since the sign convention departs from ECOS).
//
// Sign convention. With residuals `r_p = A·x − b·τ`, `r_d = A^T·y +
// s − c·τ`, `r_g = −c^T·x + b^T·y − κ` (Mosek capi.pdf eq. 13.8),
// the Newton step on the nonlinear system `F(z) = 0` is `J·dz = −F(z)`.
// So the linear-residual rows of the Newton system carry RHS `−η·r_p,
// −η·r_d, −η·r_g`. The complementarity rows carry RHS `−X·s + γμe`
// (for combined) and `−τ·κ + γμ`. And09 step 5 writes the Newton
// equations as `A·dx − b·dτ = η·r_p` with their `r_p := b·τ − A·x`
// (i.e., negated). Substituting And09 r_p = -Mosek r_p shows the two
// formulations are algebraically identical; we use Mosek's sign
// convention throughout for consistency with the iter-log columns.
//
// Newton system (η := 1−γ, γ = centering parameter):
//
//   (1)  A·dx − b·dτ                = −η·r_p
//   (2)  A^T·dy + ds − c·dτ         = −η·r_d
//   (3)  −c^T·dx + b^T·dy − dκ      = −η·r_g
//   (4)  S·dx + X·ds                = E_x        E_x = −X·s + γμe − dX_a·dS_a (combined)
//                                                E_x = −X·s                    (affine)
//   (5)  κ·dτ + τ·dκ                = E_τ        E_τ = −τ·κ + γμ − dτ_a·dκ_a (combined)
//                                                E_τ = −τ·κ                    (affine)
//
// From (4): `ds = (E_x − S·dx)/X` element-wise.
// Sub into (2): `A^T·dy + (E_x − S·dx)/X − c·dτ = −η·r_d`, rearrange
// for `dx` (D := diag(x/s)):
//
//     dx = D·A^T·dy − D·c·dτ + E_x/S + η·D·r_d
//
// Sub into (1): `A·D·A^T·dy = −η·r_p − η·A·D·r_d − A·E_x/S + (A·D·c + b)·dτ`.
//
// Define `M := A·D·A^T`. Decompose `dy = dy2 + dτ·dy1`:
//
//     M·dy1 = A·D·c + b                                  (data direction)
//     M·dy2 = −η·r_p − η·A·D·r_d − A·E_x/S                (iterate direction)
//
// Recovery (using S/X · D = I and S/X · 1/S = 1/X):
//
//     dx1 = D·A^T·dy1 − D·c
//     dx2 = D·A^T·dy2 + E_x/S + η·D·r_d
//     ds1 = c − A^T·dy1
//     ds2 = −η·r_d − A^T·dy2
//
// Scalar dτ from (3) after substituting (5):
//
//     −c^T·(dx2 + dτ·dx1) + b^T·(dy2 + dτ·dy1) − (E_τ − κ·dτ)/τ = −η·r_g
//     dτ·(κ/τ − c^T·dx1 + b^T·dy1) = −η·r_g + c^T·dx2 − b^T·dy2 + E_τ/τ
//
// So:
//
//     dτ_denom = κ/τ − c^T·dx1 + b^T·dy1
//     dτ_num   = −η·r_g + c^T·dx2 − b^T·dy2 + E_τ/τ
//     dτ       = dτ_num / dτ_denom
//     dκ       = (E_τ − κ·dτ) / τ
//
// Full direction: `dx_full = dx2 + dτ·dx1`, etc.
//
// References: ADR-0033 (this port's design), Andersen 2009 §3
// (`docs/refs/andersen-2009-homogeneous-self-dual.pdf`),
// Mosek capi.pdf §13.3, ECOS source `ecos.c:1075-1617` for the
// structural pattern. The `dτ_denom` sign — `+ b^T·dy1`, opposite
// to ECOS's `− b^T·dy1` — traces to our `r_g = −c^T·x + b^T·y − κ`
// vs ECOS's `rt = κ + c^T·x + b^T·y + h^T·z` (opposite sign on
// b^T·y due to their `max −b^T·y` dual objective).

import type { LpProblem } from "../problem/LpProblem.js";
import type { IpmParams } from "./Defaults.js";
import { DEFAULT_PARAMS } from "./Defaults.js";
import type { SolverStatus } from "./Iterate.js";
import {
  factorWith3Way,
  makeLpDiagnose,
  regParamsFromIpm,
  type RegState,
} from "./Regularization.js";
import { schurAssembleNormalEq } from "../linalg/SchurAssembler.js";
import { solveWithIR } from "../linalg/IterativeRefinement.js";
import type {
  IterLogLine,
  SolveOptions,
  VerboseIterLine,
} from "./Solver.js";
import { vecNormInf } from "./Residuals.js";
import { hsdeLpMaxStep } from "./HsdeStepLength.js";
import { safeguardStep } from "./StepLength.js";

// ─────────────────────────────────────────────────────────────────────
// Public result type
// ─────────────────────────────────────────────────────────────────────

/**
 * HSDE LP solve result. The returned `(x, y, s)` are **purified** —
 * divided by `τ*` so they live in the original (un-homogenized)
 * problem's variable space. `tau`, `kappa` carry the homogenization
 * scalars at termination for diagnostic purposes (and for
 * infeasibility certificates, where `τ → 0`).
 *
 * `achievedPrecision` is `max(ρ_p, ρ_d, ρ_g)` — the Mosek-style
 * scaled-residual norm. ≤ 1 means converged to the requested
 * tolerance; > 1 means the solver returned a best-iterate snapshot
 * that doesn't quite hit tol (honest scope: the iterate IS the best
 * answer the solver could find, callers read this field to know how
 * close).
 */
export interface HsdeLpSolveResult {
  status: SolverStatus;
  x: Float64Array;       // purified: x* / τ*
  y: Float64Array;       // purified: y* / τ*
  s: Float64Array;       // purified: s* / τ*
  tau: number;
  kappa: number;
  primalObj: number;     // c^T·(x/τ)
  dualObj: number;       // b^T·(y/τ)
  iter: number;
  achievedPrecision: number;
  log: IterLogLine[];
}

// ─────────────────────────────────────────────────────────────────────
// Internal iterate (heap-allocated once per solve)
// ─────────────────────────────────────────────────────────────────────

interface State {
  m: number;
  n: number;
  // Iterate (unpurified)
  x: Float64Array;
  y: Float64Array;
  s: Float64Array;
  tau: number;
  kappa: number;
  // Residuals
  rp: Float64Array;
  rd: Float64Array;
  rg: number;
  mu: number;
  pObj: number;          // c^T·x (UNNORMALIZED; the purified value is c^T·x/τ)
  dObj: number;          // b^T·y
  primalInf: number;     // ‖r_p‖_∞
  dualInf: number;       // ‖r_d‖_∞
  gapInf: number;        // |r_g|
  // Data-direction solve (shared between affine and combined)
  dx1: Float64Array;
  dy1: Float64Array;
  ds1: Float64Array;
  dtauDenom: number;
  // Iterate-direction solve (overwritten between affine and combined)
  dx2: Float64Array;
  dy2: Float64Array;
  ds2: Float64Array;
  // Affine direction (kept after the affine solve for the corrector cross-term)
  dxAff: Float64Array;
  dsAff: Float64Array;
  dtauAff: number;
  dkapAff: number;
  // Combined direction (final per-iter step)
  dx: Float64Array;
  dy: Float64Array;
  ds: Float64Array;
  dtau: number;
  dkap: number;
  // Schur workspace
  D: Float64Array;       // diag(x/s), n-vector
  M: Float64Array;       // m × m Schur, row-major
  Lchol: Float64Array;   // Cholesky factor of M (with regularization)
  rhs: Float64Array;     // m-vector workspace for back-sub
  // Iterative-refinement workspaces + per-iter step counts (Phase 5 Tier 1).
  // workE / workCorr are the residual / correction scratch for `solveWithIR`,
  // allocated once per solve; nitref{1,2,3} are the accepted-step counts of
  // the data / affine / combined back-substitutions, surfaced in the trace.
  workE: Float64Array;
  workCorr: Float64Array;
  nitref1: number;
  nitref2: number;
  nitref3: number;
  // Reg state (3-way Tikhonov)
  reg: RegState;
  // Iter / status / timing
  iter: number;
  status: SolverStatus;
  stallCount: number;
  prevMu: number;
  startMs: number;
}

function makeState(m: number, n: number, params: IpmParams): State {
  return {
    m, n,
    x: new Float64Array(n),
    y: new Float64Array(m),
    s: new Float64Array(n),
    tau: 1,
    kappa: 1,
    rp: new Float64Array(m),
    rd: new Float64Array(n),
    rg: 0,
    mu: 0,
    pObj: 0,
    dObj: 0,
    primalInf: 0,
    dualInf: 0,
    gapInf: 0,
    dx1: new Float64Array(n),
    dy1: new Float64Array(m),
    ds1: new Float64Array(n),
    dtauDenom: 0,
    dx2: new Float64Array(n),
    dy2: new Float64Array(m),
    ds2: new Float64Array(n),
    dxAff: new Float64Array(n),
    dsAff: new Float64Array(n),
    dtauAff: 0,
    dkapAff: 0,
    dx: new Float64Array(n),
    dy: new Float64Array(m),
    ds: new Float64Array(n),
    dtau: 0,
    dkap: 0,
    D: new Float64Array(n),
    M: new Float64Array(m * m),
    Lchol: new Float64Array(m * m),
    rhs: new Float64Array(m),
    workE: new Float64Array(m),
    workCorr: new Float64Array(m),
    nitref1: 0,
    nitref2: 0,
    nitref3: 0,
    reg: {
      jitterPrimal: params.initialJitter,
      jitterDual: 0,
      jitterGap: 0,
      bumpsPrimal: 0,
      bumpsDual: 0,
      bumpsGap: 0,
      refactors: 0,
    },
    iter: 0,
    status: "running",
    stallCount: 0,
    prevMu: Infinity,
    startMs: 0,
  };
}

// ─────────────────────────────────────────────────────────────────────
// Public entry point
// ─────────────────────────────────────────────────────────────────────

export function solveHsdeLp(lp: LpProblem, opts: SolveOptions = {}): HsdeLpSolveResult {
  const params: IpmParams = { ...DEFAULT_PARAMS, ...(opts.params ?? {}) };
  const { m, n } = lp;
  const st = makeState(m, n, params);
  st.startMs = Date.now();
  // Initial point: x⁰ = ξ_p·e, s⁰ = ξ_d·e, y⁰ = 0, τ⁰ = κ⁰ = 1.
  // The ξ_p, ξ_d formula is Andersen-Andersen 2000 / Wright 1997 §11
  // standard heuristic, same as the legacy LP path (see
  // `Solver.ts:defaultInitialPoint`). τ⁰ = κ⁰ = 1 is the symmetric
  // centered choice (And09 §3 Step 1 only requires positivity).
  const bNorm = vecNormInf(lp.b);
  const cNorm = vecNormInf(lp.c);
  const xi = Math.max(1, 10 * bNorm);
  const eta = Math.max(1, 10 * cNorm);
  for (let j = 0; j < n; j++) {
    st.x[j] = xi;
    st.s[j] = eta;
  }
  // y already zero; τ, κ already 1 from makeState.

  const log: IterLogLine[] = [];
  const lpDiagnose = makeLpDiagnose(lp.A, m, n);
  const regParams = regParamsFromIpm(
    { ...params, jitterMaxDual: 1e-2, jitterMaxGap: 1e-2 },
    /*maxRefactor=*/ 20,
  );

  // Best-iterate snapshot (per ADR-0033 §"Decision 7": snapshot the
  // UNPURIFIED iterate; purify only on return). Returned via
  // `finalizeBestOr` on stall / iter-limit / numerical fall-through.
  let bestAchieved = Infinity;
  let bestStatus: SolverStatus | null = null;
  const bestX = new Float64Array(n);
  const bestY = new Float64Array(m);
  const bestS = new Float64Array(n);
  let bestTau = 1;
  let bestKappa = 1;
  let bestIter = 0;

  const nowNs = (): number => Bun.nanoseconds();

  for (st.iter = 0; st.iter <= params.iterLimit; st.iter++) {
    computeResiduals(st, lp);

    // Termination test (ART03 / Mosek ρ-dichotomy per ADR-0033 §"Decision 6").
    const term = checkHsdeTermination(st, lp, params);

    const line: IterLogLine = {
      iter: st.iter,
      primalObj: st.tau > 0 ? st.pObj / st.tau : NaN,
      dualObj: st.tau > 0 ? st.dObj / st.tau : NaN,
      compl: st.mu,
      primalInf: st.primalInf,
      dualInf: st.dualInf,
      timeSec: (Date.now() - st.startMs) / 1000,
    };
    log.push(line);
    opts.log?.(line, null as never);

    // Best-iterate snapshot. We use the same verifier-aligned achieved
    // metric as the legacy NT solver (worklog 095) but evaluated on the
    // *purified* objective magnitudes (since that's what the verifier
    // sees). The iterate itself stored is unpurified (hazard §3.3).
    const pObjPure = st.tau > 0 ? st.pObj / st.tau : NaN;
    const dObjPure = st.tau > 0 ? st.dObj / st.tau : NaN;
    const objScale = Math.max(1, Math.abs(pObjPure));
    const gapAbs = Math.abs(pObjPure - dObjPure);
    const achieved = Math.max(
      term.rhoP,
      term.rhoD,
      term.rhoG,
      Number.isFinite(gapAbs) ? gapAbs / objScale : Infinity,
    );
    if (achieved < bestAchieved) {
      bestX.set(st.x);
      bestY.set(st.y);
      bestS.set(st.s);
      bestTau = st.tau;
      bestKappa = st.kappa;
      bestIter = st.iter;
      bestAchieved = achieved;
      bestStatus = "dual-feasible";
    }

    if (term.status !== "running") {
      st.status = term.status;
      return finalize(term.status);
    }

    if (Date.now() - st.startMs > params.timeLimitSec * 1000) {
      return finalizeBestOr("time-limit");
    }
    if (st.iter >= params.iterLimit) {
      return finalizeBestOr("iter-limit");
    }
    if (st.stallCount >= params.stallIterCap) {
      return finalizeBestOr("numerical-difficulty");
    }

    // Snapshot reg counters for per-iter delta in verbose trace.
    const bumpsPSnap = st.reg.bumpsPrimal;
    const bumpsDSnap = st.reg.bumpsDual;
    const bumpsGSnap = st.reg.bumpsGap;
    const refactorsSnap = st.reg.refactors;

    // ─── Build Schur M = A · D · A^T ───
    const tSchurStart = nowNs();
    for (let j = 0; j < n; j++) st.D[j] = st.x[j]! / st.s[j]!;
    schurAssembleNormalEq(lp.A, m, n, st.D, st.M);
    let schurDiagMin = Infinity;
    let schurDiagMax = -Infinity;
    for (let i = 0; i < m; i++) {
      const d = st.M[i * m + i]!;
      if (d < schurDiagMin) schurDiagMin = d;
      if (d > schurDiagMax) schurDiagMax = d;
    }
    const tSchurMs = (nowNs() - tSchurStart) / 1e6;

    // ─── Factor with 3-way Tikhonov ───
    const tFactorStart = nowNs();
    const factorRes = factorWith3Way(st.M, m, st.Lchol, st.reg, regParams, lpDiagnose);
    const tFactorMs = (nowNs() - tFactorStart) / 1e6;
    if (!factorRes.success) {
      return finalizeBestOr("numerical-error");
    }

    // ─── Data direction: solve M·dy1 = A·D·c + b ───
    // (used by both affine and combined; only computed once per iter)
    const tDirStart = nowNs();
    computeDataDirection(st, lp);

    // ─── Affine direction (predictor, η=1, γ=0) ───
    // RHS2_aff = r_p + A·D·r_d − A·(E_x_aff / S)  with E_x_aff = −X·s
    // (E_x_aff/S = −x componentwise, so −A·E_x_aff/S = A·x)
    computeAffineDirection(st, lp);

    // Combine affine: dx_aff = dx2 + dτ_aff·dx1, similar y, s
    for (let j = 0; j < n; j++) {
      st.dxAff[j] = st.dx2[j]! + st.dtauAff * st.dx1[j]!;
      st.dsAff[j] = st.ds2[j]! + st.dtauAff * st.ds1[j]!;
    }
    // (dyAff not stored as full vector — only needed via dx2 + dτ·dx1
    // which we computed above; the combined dy is in `st.dy` at end.)

    // ─── Affine step length + μ_aff + σ ───
    const tStep1Start = nowNs();
    const alphaAffRaw = hsdeLpMaxStep(
      st.x, st.dxAff, st.s, st.dsAff,
      st.tau, st.dtauAff, st.kappa, st.dkapAff,
    );
    const alphaAff = Math.min(1, alphaAffRaw);
    let tStepMs = (nowNs() - tStep1Start) / 1e6;

    // Predicted μ_aff at the affine step
    let muAffNum = 0;
    for (let j = 0; j < n; j++) {
      muAffNum += (st.x[j]! + alphaAff * st.dxAff[j]!) * (st.s[j]! + alphaAff * st.dsAff[j]!);
    }
    muAffNum += (st.tau + alphaAff * st.dtauAff) * (st.kappa + alphaAff * st.dkapAff);
    const muAff = muAffNum / (n + 1);

    // Mehrotra σ — ADR-0033 §"Decision 4" — clip to [1e-8, 0.9]
    const sigmaRaw = (muAff / Math.max(st.mu, 1e-300)) ** 3;
    const sigma = clip(sigmaRaw, 1e-8, 0.9);

    // ─── Corrector direction (combined, η=1−σ, γ=σ) ───
    // E_x_comb = −X·s + σμe − dx_aff·ds_aff (Mehrotra cross-term)
    // E_τ_comb = −τκ + σμ − dτ_aff·dκ_aff
    computeCombinedDirection(st, lp, sigma, muAff);
    // After this call, `st.dx, st.dy, st.ds, st.dtau, st.dkap` hold the full combined direction.
    const tDirectionMs = (nowNs() - tDirStart) / 1e6 - tStepMs;

    // ─── Combined step length ───
    const tStep2Start = nowNs();
    const alphaMax = hsdeLpMaxStep(
      st.x, st.dx, st.s, st.ds,
      st.tau, st.dtau, st.kappa, st.dkap,
    );
    const alphaRaw = Math.min(1, alphaMax);
    tStepMs += (nowNs() - tStep2Start) / 1e6;

    // Mehrotra safeguard: α ← max(0.95·α, 2α−1), capped at 0.999999
    const alpha = safeguardStep(alphaRaw, params.stepFactor);

    // ─── Update iterate ───
    for (let j = 0; j < n; j++) {
      st.x[j] = st.x[j]! + alpha * st.dx[j]!;
      st.s[j] = st.s[j]! + alpha * st.ds[j]!;
    }
    for (let i = 0; i < m; i++) st.y[i] = st.y[i]! + alpha * st.dy[i]!;
    st.tau += alpha * st.dtau;
    st.kappa += alpha * st.dkap;

    // Stall detection: μ + τκ regressed by less than 1% counts as stall
    const muNew = computeMu(st);
    if (muNew > 0.99 * st.mu) st.stallCount++;
    else st.stallCount = 0;
    st.prevMu = st.mu;

    // Verbose trace emission (after iter resolves — sigma/alpha/etc. populated)
    if (opts.verbose) {
      const v: VerboseIterLine = {
        ...line,
        kind: "lp-hsde",
        sigma,
        sigmaRaw,
        muAff,
        alphaPrimal: alpha,
        alphaDual: alpha,        // HSDE uses single α; report same on both
        alphaPrimalRaw: alphaRaw,
        alphaDualRaw: alphaRaw,
        jitterPrimal: st.reg.jitterPrimal,
        jitterDual: st.reg.jitterDual,
        jitterGap: st.reg.jitterGap,
        bumpsPrimalThisIter: st.reg.bumpsPrimal - bumpsPSnap,
        bumpsDualThisIter: st.reg.bumpsDual - bumpsDSnap,
        bumpsGapThisIter: st.reg.bumpsGap - bumpsGSnap,
        refactorsThisIter: st.reg.refactors - refactorsSnap,
        failRow: factorRes.lastFailRow,
        schurDiagMin,
        schurDiagMax,
        eigMinX: NaN,
        eigMinS: NaN,
        tau: st.tau,
        kappa: st.kappa,
        gfeas: st.gapInf,
        prstatus: term.prstatus,
        nitref1: st.nitref1,
        nitref2: st.nitref2,
        nitref3: st.nitref3,
        tSchurMs,
        tFactorMs,
        tDirectionMs,
        tStepMs,
      };
      opts.verbose(v);
    }
  }

  return finalizeBestOr("iter-limit");

  // ─── Helpers (closures over st, lp, log) ───

  function finalize(status: SolverStatus): HsdeLpSolveResult {
    return purifyAndReturn(status, st.x, st.y, st.s, st.tau, st.kappa, st.iter,
      Math.max(st.primalInf, st.dualInf, st.gapInf));
  }

  function finalizeBestOr(fallback: SolverStatus): HsdeLpSolveResult {
    if (bestStatus === null) {
      return finalize(fallback);
    }
    return purifyAndReturn(bestStatus, bestX, bestY, bestS, bestTau, bestKappa,
      bestIter, bestAchieved);
  }

  function purifyAndReturn(
    status: SolverStatus,
    x: Float64Array, y: Float64Array, s: Float64Array,
    tau: number, kappa: number, iter: number,
    achieved: number,
  ): HsdeLpSolveResult {
    // ADR-0033 §"Decision 7" + hazard §3.3: divide by τ* HERE only,
    // not at snapshot time. Producing fresh Float64Arrays so the
    // caller can mutate without affecting the internal state.
    const xPure = new Float64Array(n);
    const yPure = new Float64Array(m);
    const sPure = new Float64Array(n);
    if (tau > 0) {
      for (let j = 0; j < n; j++) {
        xPure[j] = x[j]! / tau;
        sPure[j] = s[j]! / tau;
      }
      for (let i = 0; i < m; i++) yPure[i] = y[i]! / tau;
    } else {
      // τ ≤ 0: don't divide, return iterate as-is (likely an
      // infeasibility certificate — the un-divided x*, y* are the
      // certificate vectors).
      xPure.set(x);
      yPure.set(y);
      sPure.set(s);
    }
    // Recompute objectives on the purified iterate
    let pObj = 0;
    for (let j = 0; j < n; j++) pObj += lp.c[j]! * xPure[j]!;
    let dObj = 0;
    for (let i = 0; i < m; i++) dObj += lp.b[i]! * yPure[i]!;
    return {
      status,
      x: xPure,
      y: yPure,
      s: sPure,
      tau,
      kappa,
      primalObj: pObj,
      dualObj: dObj,
      iter,
      achievedPrecision: achieved,
      log,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────

/**
 * Compute the three HSDE residuals + μ + objectives at the current
 * iterate. Mosek/And09 sign convention throughout.
 *
 *   r_p = A·x − b·τ                  (PFEAS column shows ‖r_p‖_∞)
 *   r_d = A^T·y + s − c·τ            (DFEAS column shows ‖r_d‖_∞)
 *   r_g = −c^T·x + b^T·y − κ          (GFEAS column shows |r_g|)
 *   μ   = (x^T·s + τ·κ) / (n + 1)    (homogenized complementarity)
 */
function computeResiduals(st: State, lp: LpProblem): void {
  const { m, n } = st;
  const { A, b, c } = lp;
  // r_p = A·x − b·τ
  for (let i = 0; i < m; i++) {
    let s = 0;
    for (let j = 0; j < n; j++) s += A[i * n + j]! * st.x[j]!;
    st.rp[i] = s - b[i]! * st.tau;
  }
  // r_d = A^T·y + s − c·τ
  for (let j = 0; j < n; j++) {
    let r = -c[j]! * st.tau + st.s[j]!;
    for (let i = 0; i < m; i++) r += A[i * n + j]! * st.y[i]!;
    st.rd[j] = r;
  }
  // c^T·x, b^T·y
  let pObj = 0;
  for (let j = 0; j < n; j++) pObj += c[j]! * st.x[j]!;
  let dObj = 0;
  for (let i = 0; i < m; i++) dObj += b[i]! * st.y[i]!;
  st.pObj = pObj;
  st.dObj = dObj;
  // r_g = −c^T·x + b^T·y − κ
  st.rg = -pObj + dObj - st.kappa;
  // μ = (x·s + τκ) / (n + 1)
  st.mu = computeMu(st);
  // Norms (un-normalized log column values)
  st.primalInf = vecNormInf(st.rp);
  st.dualInf = vecNormInf(st.rd);
  st.gapInf = Math.abs(st.rg);
}

function computeMu(st: State): number {
  const { n } = st;
  let s = 0;
  for (let j = 0; j < n; j++) s += st.x[j]! * st.s[j]!;
  s += st.tau * st.kappa;
  return s / (n + 1);
}

interface TerminationCheck {
  status: SolverStatus;
  rhoP: number;
  rhoD: number;
  rhoG: number;
  prstatus: number;
}

/**
 * ART03 / Mosek termination dichotomy. Computes the three ρ-scaled
 * residuals (capi.pdf §13.3.2) and PRSTATUS, then maps to status.
 *
 *   ρ_p = ‖A·x/τ − b‖_∞ / (ε_p · (1 + ‖b‖_∞))
 *   ρ_d = ‖A^T·y/τ + s/τ − c‖_∞ / (ε_d · (1 + ‖c‖_∞))
 *   ρ_g = |c^T·x/τ − b^T·y/τ| / (ε_g · max(1, min(|c^T·x|, |b^T·y|)/τ))
 *   PRSTATUS = (b^T·y − c^T·x) / max(‖b‖_∞, ‖c‖_∞, 1)
 *
 * Decision:
 *   max(ρ_p, ρ_d, ρ_g) ≤ 1 AND PRSTATUS > +0.5 → "optimal"
 *   max(ρ_p, ρ_d, ρ_g) ≤ 1 AND PRSTATUS < −0.5 → primal/dual-infeasible
 *      (which one decided by sign of b^T·y vs c^T·x)
 *   otherwise → "running"
 */
function checkHsdeTermination(st: State, lp: LpProblem, params: IpmParams): TerminationCheck {
  const bInfNorm = Math.max(1, vecNormInf(lp.b));
  const cInfNorm = Math.max(1, vecNormInf(lp.c));
  const eps_p = params.feasTol;
  const eps_d = params.feasTol;
  const eps_g = params.optTol;
  const tau = st.tau;

  // ρ_p, ρ_d: divide residuals by τ before scaling. r_p/τ = A·(x/τ) − b.
  // r_d/τ = A^T·(y/τ) + s/τ − c. The un-normalized r_p is what
  // st.primalInf carries; divide by τ for the convergence check.
  const rhoP = tau > 0 ? st.primalInf / (tau * eps_p * (1 + bInfNorm)) : Infinity;
  const rhoD = tau > 0 ? st.dualInf / (tau * eps_d * (1 + cInfNorm)) : Infinity;

  // ρ_g: use the min(|c^T·x|, |b^T·y|)/τ as the scale, capped at 1.
  // This mirrors capi.pdf §13.3.2 exactly.
  const pObjPure = tau > 0 ? st.pObj / tau : NaN;
  const dObjPure = tau > 0 ? st.dObj / tau : NaN;
  const gapAbs = Math.abs(pObjPure - dObjPure);
  const gapScale = Math.max(1, Math.min(Math.abs(pObjPure), Math.abs(dObjPure)));
  const rhoG = Number.isFinite(gapAbs)
    ? gapAbs / (eps_g * gapScale)
    : Infinity;

  // PRSTATUS — Mosek's iter log column. capi.pdf §13.3.4 specifies
  // only "converges to +1 if optimal, −1 if not"; the exact formula
  // isn't given. The natural definition that matches the observed
  // probe-log behaviour (0 at symmetric init τ=κ=1, → +1 as κ→0,
  // → −1 as τ→0) is `(τ − κ)/(τ + κ)`. This is bounded in [−1, +1]
  // and depends only on the HSDE-specific scalars, so it directly
  // captures the dichotomy.
  //
  // The earlier candidate `(bᵀy − cᵀx) / max(‖b‖, ‖c‖, 1)` (from
  // the original handoff) doesn't work: at the optimal branch
  // `bᵀy* = cᵀx*` (zero gap), giving PRSTATUS → 0 not +1.
  const prstatus = (st.tau - st.kappa) / Math.max(st.tau + st.kappa, 1e-300);

  // Soft-rel: near-rel multiplier (CLAUDE.md is silent on the exact
  // value for HSDE; we use the same 1000× as Mosek's
  // MSK_DPAR_INTPNT_CO_TOL_NEAR_REL default).

  let status: SolverStatus = "running";
  const rhoMax = Math.max(rhoP, rhoD, rhoG);

  if (rhoMax <= 1) {
    if (prstatus > 0.5) {
      status = "optimal";
    } else if (prstatus < -0.5) {
      // Infeasibility certificate. Decide which kind by sign of
      // objectives (And09 §2 below eq. 4).
      if (st.dObj > 0) {
        status = "primal-infeasible";
      } else if (st.pObj < 0) {
        status = "dual-infeasible";
      } else {
        status = "primal-infeasible";  // ambiguous; pick a side
      }
    }
  }

  return { status, rhoP, rhoD, rhoG, prstatus };
}

/**
 * Compute the "data direction" Δξ₁ = (dx1, dy1, ds1).
 *
 *   M·dy1 = A·D·c + b
 *   dx1   = D·A^T·dy1 − D·c
 *   ds1   = c − A^T·dy1
 *
 * Also computes `dtau_denom = κ/τ − c^T·dx1 + b^T·dy1` which is
 * reused for both the affine and combined dτ formulas (depends only
 * on data direction + iterate's (τ, κ), neither of which changes
 * within an iter).
 */
function computeDataDirection(st: State, lp: LpProblem): void {
  const { m, n } = st;
  const { A, b, c } = lp;

  // RHS = A·D·c + b
  for (let i = 0; i < m; i++) {
    let s = b[i]!;
    for (let j = 0; j < n; j++) s += A[i * n + j]! * st.D[j]! * c[j]!;
    st.rhs[i] = s;
  }
  // Back-substitution with iterative refinement against the unregularised M
  // (Phase 5 Tier 1). nitref1 = accepted refinement steps on the data
  // direction; 0 when the regularised solve was already accurate enough.
  st.nitref1 = solveWithIR(st.M, m, st.Lchol, st.rhs, st.dy1, st.workE, st.workCorr);

  // dx1 = D·A^T·dy1 − D·c
  // ds1 = c − A^T·dy1
  for (let j = 0; j < n; j++) {
    let aty = 0;
    for (let i = 0; i < m; i++) aty += A[i * n + j]! * st.dy1[i]!;
    st.dx1[j] = st.D[j]! * (aty - c[j]!);
    st.ds1[j] = c[j]! - aty;
  }

  // dtau_denom = κ/τ − c^T·dx1 + b^T·dy1
  // Sign on b^T·dy1 is +, per derivation at top of file (this is the
  // place the And09/Mosek vs ECOS sign convention departs).
  let cdx = 0;
  for (let j = 0; j < n; j++) cdx += c[j]! * st.dx1[j]!;
  let bdy = 0;
  for (let i = 0; i < m; i++) bdy += b[i]! * st.dy1[i]!;
  st.dtauDenom = st.kappa / st.tau - cdx + bdy;
}

/**
 * Compute the "affine direction" Δξ₂_aff and the scalar dτ_aff, dκ_aff.
 *
 * RHS (η = 1, E_x_aff = −X·s, E_τ_aff = −τ·κ):
 *   M·dy2 = −r_p − A·D·r_d − A·(E_x_aff/S)
 *         = −r_p − A·D·r_d + A·x      [E_x_aff/S = −x componentwise]
 *
 * Recovery:
 *   dx2 = D·A^T·dy2 + E_x_aff/S + D·r_d   = D·A^T·dy2 − x + D·r_d
 *   ds2 = −r_d − A^T·dy2
 *
 * Scalar:
 *   dtau_aff = (−r_g + c^T·dx2 − b^T·dy2 + E_τ_aff/τ) / dtau_denom
 *            = (−r_g + c^T·dx2 − b^T·dy2 − κ) / dtau_denom
 *   dkap_aff = (E_τ_aff − κ·dtau_aff) / τ
 *            = (−τκ − κ·dtau_aff) / τ
 *            = −κ − (κ/τ)·dtau_aff
 */
function computeAffineDirection(st: State, lp: LpProblem): void {
  const { m, n } = st;
  const { A, b, c } = lp;

  // RHS2 = −r_p − A·D·r_d + A·x
  for (let i = 0; i < m; i++) {
    let s = -st.rp[i]!;
    for (let j = 0; j < n; j++) {
      s += A[i * n + j]! * (st.x[j]! - st.D[j]! * st.rd[j]!);
    }
    st.rhs[i] = s;
  }
  // Iterative-refinement back-sub (Phase 5 Tier 1); nitref2 = affine-direction
  // accepted refinement steps.
  st.nitref2 = solveWithIR(st.M, m, st.Lchol, st.rhs, st.dy2, st.workE, st.workCorr);

  // dx2 = D·A^T·dy2 − x + D·r_d
  // ds2 = −r_d − A^T·dy2
  for (let j = 0; j < n; j++) {
    let aty = 0;
    for (let i = 0; i < m; i++) aty += A[i * n + j]! * st.dy2[i]!;
    st.dx2[j] = st.D[j]! * aty - st.x[j]! + st.D[j]! * st.rd[j]!;
    st.ds2[j] = -st.rd[j]! - aty;
  }

  // dtau_aff = (−r_g + c^T·dx2 − b^T·dy2 − κ) / dtau_denom
  let cdx = 0;
  for (let j = 0; j < n; j++) cdx += c[j]! * st.dx2[j]!;
  let bdy = 0;
  for (let i = 0; i < m; i++) bdy += b[i]! * st.dy2[i]!;
  // E_τ_aff/τ = -τκ/τ = -κ
  const dtauAffNum = -st.rg + cdx - bdy - st.kappa;
  st.dtauAff = dtauAffNum / st.dtauDenom;
  st.dkapAff = -st.kappa - (st.kappa / st.tau) * st.dtauAff;
}

/**
 * Compute the "combined direction" (corrector) using σ from the
 * predictor μ_aff and the cross-term Δx_aff · Δs_aff.
 *
 * E_x_comb[j] = −x_j·s_j + σμ − dxAff[j]·dsAff[j]
 * E_τ_comb    = −τκ      + σμ − dtau_aff·dkap_aff
 *
 * RHS (η = 1 − σ):
 *   M·dy2 = −(1−σ)·r_p − (1−σ)·A·D·r_d − A·(E_x_comb/S)
 *
 * E_x_comb[j]/S[j] = −x_j + (σμ − dxAff·dsAff)/s_j
 *
 * Recovery:
 *   dx2 = D·A^T·dy2 + E_x_comb/S + (1−σ)·D·r_d
 *   ds2 = −(1−σ)·r_d − A^T·dy2
 *
 * Scalar:
 *   dtau_num = −(1−σ)·r_g + c^T·dx2 − b^T·dy2 + E_τ_comb/τ
 *   dtau     = dtau_num / dtau_denom
 *   dkap     = (E_τ_comb − κ·dtau) / τ
 *
 * Full direction: dx = dx2 + dτ·dx1, dy = dy2 + dτ·dy1, ds = ds2 + dτ·ds1.
 */
function computeCombinedDirection(st: State, lp: LpProblem, sigma: number, mu: number): void {
  const { m, n } = st;
  const { A } = lp;
  const eta = 1 - sigma;
  const sigmaMu = sigma * mu;

  // RHS2 = −(1−σ)·r_p − (1−σ)·A·D·r_d − A·(E_x_comb/S)
  // −A·(E_x_comb/S)[i] = A·x − A·((σμ − dxAff·dsAff)/s)
  for (let i = 0; i < m; i++) {
    let s = -eta * st.rp[i]!;
    for (let j = 0; j < n; j++) {
      const Ec_over_s = -st.x[j]!
        + (sigmaMu - st.dxAff[j]! * st.dsAff[j]!) / st.s[j]!;
      s += A[i * n + j]! * (-eta * st.D[j]! * st.rd[j]! - Ec_over_s);
    }
    st.rhs[i] = s;
  }
  // Iterative-refinement back-sub (Phase 5 Tier 1); nitref3 = combined-
  // direction accepted refinement steps.
  st.nitref3 = solveWithIR(st.M, m, st.Lchol, st.rhs, st.dy2, st.workE, st.workCorr);

  // dx2 = D·A^T·dy2 + E_x_comb/S + (1−σ)·D·r_d
  // ds2 = −(1−σ)·r_d − A^T·dy2
  let cdx = 0;
  let bdy = 0;
  for (let j = 0; j < n; j++) {
    let aty = 0;
    for (let i = 0; i < m; i++) aty += A[i * n + j]! * st.dy2[i]!;
    const Ec_over_s = -st.x[j]!
      + (sigmaMu - st.dxAff[j]! * st.dsAff[j]!) / st.s[j]!;
    st.dx2[j] = st.D[j]! * aty + Ec_over_s + eta * st.D[j]! * st.rd[j]!;
    st.ds2[j] = -eta * st.rd[j]! - aty;
    cdx += lp.c[j]! * st.dx2[j]!;
  }
  for (let i = 0; i < m; i++) bdy += lp.b[i]! * st.dy2[i]!;

  // E_τ_comb = −τκ + σμ − dtau_aff·dkap_aff
  const Etau = -st.tau * st.kappa + sigmaMu - st.dtauAff * st.dkapAff;
  const Etau_over_tau = Etau / st.tau;
  // dtau_num = −(1−σ)·r_g + c·dx2 − b·dy2 + E_τ_comb/τ
  const dtauNum = -eta * st.rg + cdx - bdy + Etau_over_tau;
  st.dtau = dtauNum / st.dtauDenom;
  st.dkap = (Etau - st.kappa * st.dtau) / st.tau;

  // Full direction: combine with data direction
  for (let j = 0; j < n; j++) {
    st.dx[j] = st.dx2[j]! + st.dtau * st.dx1[j]!;
    st.ds[j] = st.ds2[j]! + st.dtau * st.ds1[j]!;
  }
  for (let i = 0; i < m; i++) st.dy[i] = st.dy2[i]! + st.dtau * st.dy1[i]!;
}

function clip(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}
