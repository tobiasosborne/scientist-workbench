// HSDE SDP solver with Nesterov-Todd direction — the hinf2 fix.
//
// The iterate is `(X_b, y, S_b, τ, κ)` where each block `(X_b, S_b)`
// is an n_b × n_b PSD matrix, `y` is the m-vector of equality
// multipliers, and `τ, κ` are the global homogenization scalars.
// The HSDE block (Mosek capi.pdf eq. 13.8) with SDP inner products:
//
//     Σ_b <A_i^b, X^b> − b_i·τ           = 0        (i = 1..m primal feas)
//     Σ_i y_i·A_i^b + S^b − C^b·τ        = 0        (per-block dual feas)
//     −Σ_b <C^b, X^b> + b^T·y − κ        = 0        (gap feas)
//                  Σ_b <X^b, S^b> + τ·κ = 0        (homogenized complementarity)
//
// where `<A, B> = trace(A^T · B)` for SDP. Cone: each `X^b ∈ S^{n_b}_+`,
// each `S^b ∈ S^{n_b}_+`, τ > 0, κ > 0.
//
// Implementation: same ECOS-pattern two-RHS structure as
// `HsdeLpSolver.ts`. Factor the NT Schur complement
// `M_{ik} = Σ_b <A_i^b, W^b · A_k^b · W^b>` ONCE per iter (reusing
// the existing per-block `NtFactor` machinery, copied from
// `NtSdpSolver.ts` to keep this file self-contained), solve THREE
// right-hand sides against the same Cholesky factor:
//
//   RHS1 (data direction):    M·dy1 = b + <A_i, W·C·W>
//   RHS2 affine:              M·dy2 = -<A_i, E_x_aff> − r_p_i − <A_i, W·r_d·W>
//   RHS2 combined (corrector): M·dy2 = -<A_i, E_x_comb> − η·r_p_i − η·<A_i, W·r_d·W>
//
// The scalar τ, κ updates use the same formula as the LP solver, with
// `Σ_b <C^b, X^b>` substituting for `c^T·x`.
//
// Derivation (SDP analog of HsdeLpSolver derivation):
//
// Newton system rows:
//   (1)  <A_i, dX> − b_i·dτ                  = -η·r_p_i             (m scalar rows)
//   (2)  Σ_i dy_i A_i^b + dS^b − C^b·dτ      = -η·r_d^b              (per-block)
//   (3)  -Σ_b <C^b, dX^b> + b^T·dy − dκ      = -η·r_g                (scalar)
//   (4)  W^b·dS^b·W^b + dX^b                 = E_x^b                 (per-block NT)
//   (5)  κ·dτ + τ·dκ                          = E_τ                  (scalar)
//
// E_x^b (per block):
//   E_x_aff^b  = -X^b                                              (affine, η=1)
//   E_x_comb^b = -X^b + σμ·(S^b)^{-1} − Rq^b                       (corrector)
// where Rq^b is the Mehrotra cross-term, computed from the affine
// direction in NT-scaled space (see `computeRq` below).
//
// E_τ:
//   E_τ_aff  = -τκ
//   E_τ_comb = -τκ + σμ − dτ_aff·dκ_aff
//
// From (4): dS^b = (W^b)^{-1} · (E_x^b - dX^b) · (W^b)^{-1}. But the
// cleaner NT-direction reduction goes the other way: substitute
// dX^b = E_x^b - W^b·dS^b·W^b into (1):
//
//   <A_i, E_x> − <A_i, W·dS·W> − b_i·dτ = -η·r_p_i
//
// From (2): dS^b = -Σ_k dy_k·A_k^b + C^b·dτ − η·r_d^b. Substitute:
//
//   <A_i, W·dS·W> = -Σ_k dy_k·<A_i, W·A_k·W> + dτ·<A_i, W·C·W> − η·<A_i, W·r_d·W>
//                 = -Σ_k M_{ik}·dy_k + dτ·<A_i, W·C·W> − η·<A_i, W·r_d·W>
//
// So (1) becomes:
//
//   <A_i, E_x> + Σ_k M_{ik}·dy_k − dτ·<A_i, W·C·W> + η·<A_i, W·r_d·W> − b_i·dτ = -η·r_p_i
//
// Rearranging:
//
//   M·dy = -<A_i, E_x> − η·r_p_i − η·<A_i, W·r_d·W> + (b_i + <A_i, W·C·W>)·dτ
//
// Decompose `dy = dy2 + dτ·dy1`:
//
//   M·dy1 = b_i + <A_i, W·C·W>                                     (data direction)
//   M·dy2 = -<A_i, E_x> − η·r_p_i − η·<A_i, W·r_d·W>                (iterate direction)
//
// Recovery (per block):
//   dS1^b = C^b − Σ_k dy1_k·A_k^b
//   dS2^b = -Σ_k dy2_k·A_k^b − η·r_d^b
//   dX1^b = -W^b · dS1^b · W^b
//   dX2^b = E_x^b - W^b · dS2^b · W^b
//
// Scalar dτ (from (3) with (5) substituted, analogous to LP):
//
//   dτ_denom = κ/τ − Σ_b <C^b, dX1^b> + b^T·dy1
//   dτ_num   = -η·r_g + Σ_b <C^b, dX2^b> − b^T·dy2 + E_τ/τ
//   dτ        = dτ_num / dτ_denom
//   dκ        = (E_τ − κ·dτ) / τ
//
// Full direction: dy = dy2 + dτ·dy1, dS^b = dS2^b + dτ·dS1^b, dX^b = dX2^b + dτ·dX1^b.
//
// References: ADR-0033 (this port), Andersen 2009 §3, Mosek
// capi.pdf §13.3, SDPT3 v4 (NTrhsfun.m, NTdirfun.m) for the Rq
// formula, `NtSdpSolver.ts` for `buildNtFactor` + `minBlockStep`
// (copied here as a Phase-0-deferred extraction).

import type { SdpProblem, SdpBlock } from "../problem/SdpProblem.js";
import { DEFAULT_PARAMS, type IpmParams } from "./Defaults.js";
import { eighJacobi, frobInner, matMul, symmetrize } from "../cone/PsdCone.js";
import { choleskyInPlace } from "../linalg/Cholesky.js";
import { solveWithIR } from "../linalg/IterativeRefinement.js";
import type { SolverStatus } from "./Iterate.js";
import type { IterLogLine, SolveOptions, VerboseIterLine } from "./Solver.js";
import {
  factorWith3Way,
  makeSdpDiagnose,
  regParamsFromIpm,
  type RegState,
} from "./Regularization.js";
import { tauKappaMaxStep } from "./HsdeStepLength.js";

// ─────────────────────────────────────────────────────────────────────
// NtFactor — per-block Nesterov-Todd factorisation
// (Copied from NtSdpSolver.ts. The duplication is deliberate
// short-term; both files use these identical math primitives.
// A tidy-up bead can extract to a shared `NtScaling.ts` module
// once both HSDE and legacy NT paths have stabilised.)
// ─────────────────────────────────────────────────────────────────────

interface NtFactor {
  n: number;
  L: Float64Array;
  invL: Float64Array;
  V: Float64Array;
  sv: Float64Array;
  G: Float64Array;
  W: Float64Array;
}

function buildNtFactor(X: Float64Array, S: Float64Array, n: number): NtFactor | null {
  const L = new Float64Array(S);
  symmetrize(L, n);
  for (let i = 0; i < n; i++) L[i * n + i] = L[i * n + i]! + 1e-14;
  const info = choleskyInPlace(L, n, 0);
  if (info >= 0) return null;
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) L[i * n + j] = 0;

  const invL = new Float64Array(n * n);
  for (let col = 0; col < n; col++) invL[col * n + col] = 1;
  triLowerSolveInPlace(L, n, invL, n);

  const Xsym = new Float64Array(X);
  symmetrize(Xsym, n);
  const tmp = new Float64Array(n * n);
  matMulTN(L, Xsym, n, tmp);
  const MLXL = new Float64Array(n * n);
  matMul(tmp, L, n, MLXL);
  symmetrize(MLXL, n);

  const { lambda: sv2, Q: V } = eighJacobi(MLXL, n);
  const sv = new Float64Array(n);
  for (let i = 0; i < n; i++) sv[i] = Math.sqrt(Math.max(sv2[i]!, 1e-300));

  const VtinvL = new Float64Array(n * n);
  matMulTN(V, invL, n, VtinvL);
  const G = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    const s = Math.sqrt(sv[i]!);
    for (let j = 0; j < n; j++) G[i * n + j] = s * VtinvL[i * n + j]!;
  }

  const W = new Float64Array(n * n);
  matMulTN(G, G, n, W);
  symmetrize(W, n);

  return { n, L, invL, V, sv, G, W };
}

function gtDiagInvSvG(f: NtFactor, out: Float64Array): void {
  // out ← G^T · diag(1/sv) · G = S^{-1}
  const n = f.n;
  const tmp = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    const di = 1 / f.sv[i]!;
    for (let j = 0; j < n; j++) tmp[i * n + j] = di * f.G[i * n + j]!;
  }
  matMulTN(f.G, tmp, n, out);
  symmetrize(out, n);
}

function triLowerSolveInPlace(L: Float64Array, n: number, B: Float64Array, ncolsB: number): void {
  for (let col = 0; col < ncolsB; col++) {
    for (let i = 0; i < n; i++) {
      let s = B[i * ncolsB + col]!;
      for (let k = 0; k < i; k++) s -= L[i * n + k]! * B[k * ncolsB + col]!;
      B[i * ncolsB + col] = s / L[i * n + i]!;
    }
  }
}

function matMulTN(A: Float64Array, B: Float64Array, n: number, C: Float64Array): void {
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      let s = 0;
      for (let k = 0; k < n; k++) s += A[k * n + i]! * B[k * n + j]!;
      C[i * n + j] = s;
    }
  }
}

function matMulNT(A: Float64Array, B: Float64Array, n: number, C: Float64Array): void {
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      let s = 0;
      for (let k = 0; k < n; k++) s += A[i * n + k]! * B[j * n + k]!;
      C[i * n + j] = s;
    }
  }
}

function transposeInPlace(M: Float64Array, n: number): void {
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const tmp = M[i * n + j]!;
      M[i * n + j] = M[j * n + i]!;
      M[j * n + i] = tmp;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────
// minBlockStep — max step keeping Z + α·dZ ⪰ 0 (per block)
// (Copied from NtSdpSolver.ts — same duplication note as buildNtFactor.)
// ─────────────────────────────────────────────────────────────────────

function minBlockStep(
  Z: Float64Array[],
  dZ: Float64Array[],
  blocks: SdpBlock[],
): number {
  let a = Infinity;
  for (let b = 0; b < blocks.length; b++) {
    const n = blocks[b]!.size;
    const Zcopy = new Float64Array(Z[b]!);
    symmetrize(Zcopy, n);
    for (let i = 0; i < n; i++) Zcopy[i * n + i] = Zcopy[i * n + i]! + 1e-14;
    const info = choleskyInPlace(Zcopy, n, 0);
    if (info >= 0) return 0;
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) Zcopy[i * n + j] = 0;

    const M = new Float64Array(dZ[b]!);
    symmetrize(M, n);
    triLowerSolveInPlace(Zcopy, n, M, n);
    transposeInPlace(M, n);
    triLowerSolveInPlace(Zcopy, n, M, n);
    transposeInPlace(M, n);
    symmetrize(M, n);
    const { lambda } = eighJacobi(M, n);
    const lmin = lambda[0]!;
    const step = lmin >= 0 ? Infinity : 1 / -lmin;
    if (step < a) a = step;
  }
  return a;
}

// ─────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────

/** HSDE SDP solve result. Returned (X, y, S) are purified (divided by τ*). */
export interface HsdeSdpSolveResult {
  status: SolverStatus;
  X: Float64Array[];        // purified per-block: X*/τ*
  y: Float64Array;          // purified: y*/τ*
  S: Float64Array[];        // purified: S*/τ*
  tau: number;
  kappa: number;
  primalObj: number;        // Σ_b <C^b, X^b/τ>
  dualObj: number;          // b^T·(y/τ)
  iter: number;
  mu: number;
  primalInf: number;
  dualInf: number;
  achievedPrecision: number;
  log: IterLogLine[];
}

// ─────────────────────────────────────────────────────────────────────
// Solver entry point
// ─────────────────────────────────────────────────────────────────────

export function solveHsdeSdpNt(
  prob: SdpProblem,
  opts: SolveOptions = {},
): HsdeSdpSolveResult {
  const params: IpmParams = { ...DEFAULT_PARAMS, ...(opts.params ?? {}) };
  const startMs = Date.now();
  const m = prob.m;
  const blocks = prob.blocks;
  const nb = blocks.length;
  const totalConeDim = blocks.reduce((s, b) => s + b.size, 0);

  // Initial point: per-block X^b = ξ_p · I_{n_b}, S^b = ξ_d · I_{n_b}, y = 0, τ = κ = 1.
  // Uses the existing ξ_p/ξ_d formulas (CLEANROOM_SPEC §3.1, mirrored
  // from NtSdpSolver.ts:initialScale).
  const { xiP, xiD } = initialScale(prob);
  const X: Float64Array[] = blocks.map((b) => eyeScaled(b.size, xiP));
  const S: Float64Array[] = blocks.map((b) => eyeScaled(b.size, xiD));
  const y = new Float64Array(m);
  let tau = 1;
  let kappa = 1;

  // Per-iter direction storage. Allocated once.
  // dX1, dS1: data direction (τ-coefficient)
  // dX2, dS2: iterate direction (η · r-coefficient + E_x); overwritten between affine + combined
  // dXaff, dSaff: full affine direction (dX2 + dτ_aff · dX1)
  // dX,  dS:  full combined direction
  const dy1 = new Float64Array(m);
  const dy2 = new Float64Array(m);
  const dy = new Float64Array(m);
  const dX1 = blocks.map((b) => new Float64Array(b.size * b.size));
  const dS1 = blocks.map((b) => new Float64Array(b.size * b.size));
  const dX2 = blocks.map((b) => new Float64Array(b.size * b.size));
  const dS2 = blocks.map((b) => new Float64Array(b.size * b.size));
  const dXaff = blocks.map((b) => new Float64Array(b.size * b.size));
  const dSaff = blocks.map((b) => new Float64Array(b.size * b.size));
  const dX = blocks.map((b) => new Float64Array(b.size * b.size));
  const dS = blocks.map((b) => new Float64Array(b.size * b.size));
  const rp = new Float64Array(m);
  const rd: Float64Array[] = blocks.map((b) => new Float64Array(b.size * b.size));
  const M = new Float64Array(m * m);
  const Lchol = new Float64Array(m * m);
  const rhs = new Float64Array(m);
  // Iterative-refinement scratch + per-iter accepted-step counts (Phase 5
  // Tier 1). workE / workCorr are allocated once per solve and reused by
  // every `solveWithIR` call; nitref{1,2,3} are overwritten each iter and
  // read at the verbose-trace emission site.
  const workE = new Float64Array(m);
  const workCorr = new Float64Array(m);
  let nitref1 = 0;
  let nitref2 = 0;
  let nitref3 = 0;

  // Per-block scratch for W·A_k·W cache. Built once per iter (after
  // NT factor build) and reused by both affine and combined back-subs.
  const WAW: Float64Array[][] = blocks.map((b) =>
    Array.from({ length: m }, () => new Float64Array(b.size * b.size)),
  );
  // Per-block W·C·W (for data direction RHS) — recomputed per iter.
  const WCW: Float64Array[] = blocks.map((b) => new Float64Array(b.size * b.size));
  // Per-block W·r_d·W cache (for iterate direction RHS).
  const WrdW: Float64Array[] = blocks.map((b) => new Float64Array(b.size * b.size));

  // 3-way Tikhonov regularization state (mirrored from LP path).
  const reg: RegState = {
    jitterPrimal: 0,
    jitterDual: 0,
    jitterGap: params.initialJitter,  // SDP path historically gap-only; preserved
    bumpsPrimal: 0,
    bumpsDual: 0,
    bumpsGap: 0,
    refactors: 0,
  };
  const sdpDiagnose = makeSdpDiagnose(blocks, m);
  const regParams = regParamsFromIpm(params, /*maxRefactor=*/ 20);

  // Best-iterate snapshot (per ADR-0033 §"Decision 7"). Stores unpurified
  // iterate; purification happens on return.
  let bestAchieved = Infinity;
  let bestStatus: SolverStatus | null = null;
  const bestX = blocks.map((b) => new Float64Array(b.size * b.size));
  const bestS = blocks.map((b) => new Float64Array(b.size * b.size));
  const bestY = new Float64Array(m);
  let bestTau = 1;
  let bestKappa = 1;
  let bestIter = 0;

  const log: IterLogLine[] = [];
  let stallCount = 0;
  let prevMu = Infinity;
  const nowNs = (): number => Bun.nanoseconds();

  for (let iter = 0; iter <= params.iterLimit; iter++) {
    // ─── Residuals + objectives ───
    // r_p_i  = Σ_b <A_i^b, X^b> − b_i·τ
    // r_d^b  = Σ_i y_i·A_i^b + S^b − C^b·τ
    // r_g    = -Σ_b <C^b, X^b> + b^T·y − κ
    // μ      = (Σ_b <X^b, S^b> + τ·κ) / (Σ_b n_b + 1)
    for (let i = 0; i < m; i++) {
      let s = 0;
      for (let b = 0; b < nb; b++) s += frobInner(blocks[b]!.A[i]!, X[b]!);
      rp[i] = s - prob.b[i]! * tau;
    }
    for (let b = 0; b < nb; b++) {
      const n = blocks[b]!.size;
      const rb = rd[b]!;
      const Cb = blocks[b]!.C;
      const Sb = S[b]!;
      for (let k = 0; k < rb.length; k++) rb[k] = -Cb[k]! * tau + Sb[k]!;
      for (let i = 0; i < m; i++) {
        const yi = y[i]!;
        const Ai = blocks[b]!.A[i]!;
        for (let k = 0; k < rb.length; k++) rb[k] = rb[k]! + yi * Ai[k]!;
      }
      void n;
    }
    let pObj = 0;
    for (let b = 0; b < nb; b++) pObj += frobInner(blocks[b]!.C, X[b]!);
    let dObj = 0;
    for (let i = 0; i < m; i++) dObj += prob.b[i]! * y[i]!;
    const rg = -pObj + dObj - kappa;
    let xs = 0;
    for (let b = 0; b < nb; b++) xs += frobInner(X[b]!, S[b]!);
    const mu = (xs + tau * kappa) / (totalConeDim + 1);
    const primalInf = vecInfNorm(rp);
    let dualInf = 0;
    for (let b = 0; b < nb; b++) {
      const di = matInfNorm(rd[b]!);
      if (di > dualInf) dualInf = di;
    }
    const gapInf = Math.abs(rg);

    // Log line — purified objectives
    const pObjPure = tau > 0 ? pObj / tau : NaN;
    const dObjPure = tau > 0 ? dObj / tau : NaN;
    const line: IterLogLine = {
      iter,
      primalObj: prob.maximize ? -pObjPure : pObjPure,
      dualObj: prob.maximize ? -dObjPure : dObjPure,
      compl: mu,
      primalInf,
      dualInf,
      timeSec: (Date.now() - startMs) / 1000,
    };
    log.push(line);
    opts.log?.(line, null as never);

    // ─── Convergence + best-iterate ───
    const term = checkHsdeTermination(
      rp, rd, rg, pObj, dObj, tau, kappa, primalInf, dualInf, prob, params,
    );
    const gapAbs = Math.abs(pObjPure - dObjPure);
    const objScale = Math.max(1, Math.abs(pObjPure));
    const achieved = Math.max(
      term.rhoP,
      term.rhoD,
      term.rhoG,
      Number.isFinite(gapAbs) ? gapAbs / objScale : Infinity,
    );
    if (achieved < bestAchieved) {
      for (let b = 0; b < nb; b++) {
        bestX[b]!.set(X[b]!);
        bestS[b]!.set(S[b]!);
      }
      bestY.set(y);
      bestTau = tau;
      bestKappa = kappa;
      bestIter = iter;
      bestAchieved = achieved;
      // bestStatus stays null: HSDE's termination test is comprehensive (it
      // already classifies optimal + primal-infeasible + dual-infeasible
      // via the τ-κ witness tests below). Any iter that the test doesn't
      // accept is not converged — the snapshot is preserved so the caller
      // gets the *best* iterate seen, but `finalizeBestOr` honestly returns
      // the fallback status (iter-limit / numerical-difficulty / numerical-
      // error). The legacy "dual-feasible soft success" map (Status.ts)
      // applies only to NT's 6-flag tree, not HSDE.
      void bestStatus;
    }

    if (term.status !== "running") {
      return finalize(term.status);
    }
    if (Date.now() - startMs > params.timeLimitSec * 1000) return finalizeBestOr("time-limit");
    if (iter >= params.iterLimit) return finalizeBestOr("iter-limit");
    if (stallCount >= params.stallIterCap) return finalizeBestOr("numerical-difficulty");

    // Reset jitter per-iter (legacy NT semantics).
    reg.jitterPrimal = 0;
    reg.jitterDual = 0;
    reg.jitterGap = params.initialJitter;
    const bumpsPSnap = reg.bumpsPrimal;
    const bumpsDSnap = reg.bumpsDual;
    const bumpsGSnap = reg.bumpsGap;
    const refactorsSnap = reg.refactors;

    // ─── Build per-block NT factors ───
    const tSchurStart = nowNs();
    const NT: NtFactor[] = [];
    for (let b = 0; b < nb; b++) {
      const f = buildNtFactor(X[b]!, S[b]!, blocks[b]!.size);
      if (f === null) return finalizeBestOr("numerical-error");
      NT.push(f);
    }

    // ─── Cache W·A_k·W per block, W·C·W per block, W·r_d·W per block ───
    for (let b = 0; b < nb; b++) {
      const n = blocks[b]!.size;
      const W = NT[b]!.W;
      // W·A_k·W for all k
      for (let k = 0; k < m; k++) {
        const Ak = blocks[b]!.A[k]!;
        const tmp = new Float64Array(n * n);
        matMul(W, Ak, n, tmp);
        const out = WAW[b]![k]!;
        matMul(tmp, W, n, out);
        symmetrize(out, n);
      }
      // W·C^b·W
      {
        const Cb = blocks[b]!.C;
        const tmp = new Float64Array(n * n);
        matMul(W, Cb, n, tmp);
        matMul(tmp, W, n, WCW[b]!);
        symmetrize(WCW[b]!, n);
      }
      // W·r_d^b·W
      {
        const tmp = new Float64Array(n * n);
        matMul(W, rd[b]!, n, tmp);
        matMul(tmp, W, n, WrdW[b]!);
        symmetrize(WrdW[b]!, n);
      }
    }

    // ─── Schur M = Σ_b <A_i^b, W^b·A_k^b·W^b> ───
    M.fill(0);
    for (let b = 0; b < nb; b++) {
      for (let i = 0; i < m; i++) {
        const Ai = blocks[b]!.A[i]!;
        for (let k = 0; k < m; k++) {
          M[i * m + k] = M[i * m + k]! + frobInner(Ai, WAW[b]![k]!);
        }
      }
    }
    // Symmetrise (M is symmetric in exact arithmetic)
    for (let i = 0; i < m; i++) {
      for (let j = 0; j < i; j++) {
        const a = 0.5 * (M[i * m + j]! + M[j * m + i]!);
        M[i * m + j] = a;
        M[j * m + i] = a;
      }
    }
    let schurDiagMin = Infinity;
    let schurDiagMax = -Infinity;
    for (let i = 0; i < m; i++) {
      const d = M[i * m + i]!;
      if (d < schurDiagMin) schurDiagMin = d;
      if (d > schurDiagMax) schurDiagMax = d;
    }
    const tSchurMs = (nowNs() - tSchurStart) / 1e6;

    // ─── Factor M with 3-way Tikhonov ───
    const tFactorStart = nowNs();
    const factorRes = factorWith3Way(M, m, Lchol, reg, regParams, sdpDiagnose);
    const tFactorMs = (nowNs() - tFactorStart) / 1e6;
    if (!factorRes.success) return finalizeBestOr("numerical-error");

    // ─── Data direction: M·dy1 = b + <A_i, W·C·W> ───
    // Then dS1^b = C^b − Σ_k dy1_k·A_k^b, dX1^b = -W·dS1^b·W.
    const tDirStart = nowNs();
    for (let i = 0; i < m; i++) {
      let s = prob.b[i]!;
      for (let b = 0; b < nb; b++) s += frobInner(blocks[b]!.A[i]!, WCW[b]!);
      rhs[i] = s;
    }
    // Back-substitution with iterative refinement against the unregularised
    // Schur M (Phase 5 Tier 1). nitref1 = accepted refinement steps on the
    // data direction; 0 when the regularised solve was already accurate.
    nitref1 = solveWithIR(M, m, Lchol, rhs, dy1, workE, workCorr);
    for (let b = 0; b < nb; b++) {
      const n = blocks[b]!.size;
      const ds1 = dS1[b]!;
      const dx1 = dX1[b]!;
      ds1.set(blocks[b]!.C);
      for (let k = 0; k < m; k++) {
        const Ak = blocks[b]!.A[k]!;
        const dyk = dy1[k]!;
        for (let q = 0; q < ds1.length; q++) ds1[q] = ds1[q]! - dyk * Ak[q]!;
      }
      symmetrize(ds1, n);
      // dX1 = -W · dS1 · W
      const W = NT[b]!.W;
      const tmp = new Float64Array(n * n);
      matMul(W, ds1, n, tmp);
      matMul(tmp, W, n, dx1);
      for (let q = 0; q < dx1.length; q++) dx1[q] = -dx1[q]!;
      symmetrize(dx1, n);
    }

    // dτ_denom = κ/τ − Σ_b <C^b, dX1^b> + b^T·dy1
    let cdx1 = 0;
    for (let b = 0; b < nb; b++) cdx1 += frobInner(blocks[b]!.C, dX1[b]!);
    let bdy1 = 0;
    for (let i = 0; i < m; i++) bdy1 += prob.b[i]! * dy1[i]!;
    const dtauDenom = kappa / tau - cdx1 + bdy1;

    // ─── Affine direction (predictor, η=1, E_x_aff = -X) ───
    // M·dy2 = -<A_i, E_x_aff> − r_p_i − <A_i, W·r_d·W>
    //       = <A_i, X> − r_p_i − <A_i, W·r_d·W>    (E_x_aff = -X)
    for (let i = 0; i < m; i++) {
      let s = -rp[i]!;
      for (let b = 0; b < nb; b++) {
        s += frobInner(blocks[b]!.A[i]!, X[b]!);
        s -= frobInner(blocks[b]!.A[i]!, WrdW[b]!);
      }
      rhs[i] = s;
    }
    // Iterative-refinement back-sub (Phase 5 Tier 1); nitref2 = affine-
    // direction accepted refinement steps.
    nitref2 = solveWithIR(M, m, Lchol, rhs, dy2, workE, workCorr);

    // Recover dS2_aff, dX2_aff per block
    for (let b = 0; b < nb; b++) {
      const n = blocks[b]!.size;
      const ds2 = dS2[b]!;
      const dx2 = dX2[b]!;
      // dS2 = -Σ_k dy2_k·A_k − r_d^b (η=1)
      ds2.fill(0);
      for (let k = 0; k < m; k++) {
        const Ak = blocks[b]!.A[k]!;
        const dyk = dy2[k]!;
        for (let q = 0; q < ds2.length; q++) ds2[q] = ds2[q]! - dyk * Ak[q]!;
      }
      for (let q = 0; q < ds2.length; q++) ds2[q] = ds2[q]! - rd[b]![q]!;
      symmetrize(ds2, n);
      // dX2 = E_x_aff − W·dS2·W = -X − W·dS2·W
      const W = NT[b]!.W;
      const tmp = new Float64Array(n * n);
      matMul(W, ds2, n, tmp);
      const WdSW = new Float64Array(n * n);
      matMul(tmp, W, n, WdSW);
      for (let q = 0; q < dx2.length; q++) dx2[q] = -X[b]![q]! - WdSW[q]!;
      symmetrize(dx2, n);
    }

    // Scalar dτ_aff, dκ_aff
    let cdx2_aff = 0;
    for (let b = 0; b < nb; b++) cdx2_aff += frobInner(blocks[b]!.C, dX2[b]!);
    let bdy2_aff = 0;
    for (let i = 0; i < m; i++) bdy2_aff += prob.b[i]! * dy2[i]!;
    // E_τ_aff = -τκ ⇒ E_τ/τ = -κ
    const dtauAffNum = -rg + cdx2_aff - bdy2_aff - kappa;
    const dtauAff = dtauAffNum / dtauDenom;
    const dkapAff = -kappa - (kappa / tau) * dtauAff;

    // Combine affine: dX_aff = dX2 + dτ_aff·dX1, dS_aff = dS2 + dτ_aff·dS1
    for (let b = 0; b < nb; b++) {
      const dx = dXaff[b]!;
      const ds = dSaff[b]!;
      for (let q = 0; q < dx.length; q++) {
        dx[q] = dX2[b]![q]! + dtauAff * dX1[b]![q]!;
        ds[q] = dS2[b]![q]! + dtauAff * dS1[b]![q]!;
      }
    }

    // ─── Affine step length + μ_aff + σ ───
    const tStep1Start = nowNs();
    const aConeP_aff = minBlockStep(X, dXaff, blocks);
    const aConeD_aff = minBlockStep(S, dSaff, blocks);
    const aKap_aff = tauKappaMaxStep(tau, dtauAff, kappa, dkapAff);
    const alphaAffRaw = Math.min(aConeP_aff, aConeD_aff, aKap_aff);
    const alphaAff = Math.min(1, alphaAffRaw);
    let tStepMs = (nowNs() - tStep1Start) / 1e6;

    // μ_aff = (Σ_b <X+α·dX, S+α·dS> + (τ+α·dτ)(κ+α·dκ)) / (totalConeDim + 1)
    let muAffNum = 0;
    for (let b = 0; b < nb; b++) {
      const Xb = X[b]!;
      const Sb = S[b]!;
      const dxb = dXaff[b]!;
      const dsb = dSaff[b]!;
      for (let q = 0; q < Xb.length; q++) {
        muAffNum += (Xb[q]! + alphaAff * dxb[q]!) * (Sb[q]! + alphaAff * dsb[q]!);
      }
    }
    muAffNum += (tau + alphaAff * dtauAff) * (kappa + alphaAff * dkapAff);
    const muAff = muAffNum / (totalConeDim + 1);
    const sigmaRaw = (muAff / Math.max(mu, 1e-300)) ** 3;
    const sigma = clip(sigmaRaw, 1e-8, 0.9);

    // ─── Combined direction (corrector, η = 1−σ) ───
    // E_x_comb^b = -X^b + σμ·(S^b)^{-1} − Rq^b
    // E_τ_comb   = -τκ + σμ − dτ_aff·dκ_aff
    // M·dy2 = -<A_i, E_x_comb> − (1-σ)·r_p_i − (1-σ)·<A_i, W·r_d·W>
    const eta = 1 - sigma;
    const sigmaMu = sigma * mu;

    // Per-block: compute Sinv = G^T · diag(1/sv) · G, then Rq = G^T · RqSv · G
    // where RqSv[i,j] = 2·sym(hdX·hdZ)[i,j] / (sv_i + sv_j)
    //   hdZ_aff = G · dS_aff · G^T
    //   hdX_aff = G^{-T} · dX_aff · G^{-1}     (algebraic identity per SDPT3:
    //              hdX_aff = diag(-sv) - hdZ_aff in the affine direction)
    //
    // Note we use the algebraic identity for hdX_aff (no G^{-1} needed) —
    // same trick as legacy NtSdpSolver.
    const ExComb: Float64Array[] = blocks.map((b) => new Float64Array(b.size * b.size));
    for (let b = 0; b < nb; b++) {
      const n = blocks[b]!.size;
      const f = NT[b]!;
      const Eb = ExComb[b]!;
      // start with -X
      for (let q = 0; q < Eb.length; q++) Eb[q] = -X[b]![q]!;
      // + σμ · S^{-1}
      const Sinv = new Float64Array(n * n);
      gtDiagInvSvG(f, Sinv);
      for (let q = 0; q < Eb.length; q++) Eb[q] = Eb[q]! + sigmaMu * Sinv[q]!;
      // − Rq
      // hdZ = G · dS_aff · G^T
      const tmp1 = new Float64Array(n * n);
      matMul(f.G, dSaff[b]!, n, tmp1);
      const hdZ = new Float64Array(n * n);
      matMulNT(tmp1, f.G, n, hdZ);
      // hdX = diag(-sv) - hdZ  (algebraic identity for affine direction)
      const hdX = new Float64Array(n * n);
      for (let q = 0; q < hdZ.length; q++) hdX[q] = -hdZ[q]!;
      for (let i = 0; i < n; i++) hdX[i * n + i] = hdX[i * n + i]! - f.sv[i]!;
      // symCross = sym(hdX · hdZ)
      const cross = new Float64Array(n * n);
      matMul(hdX, hdZ, n, cross);
      const symCross = new Float64Array(n * n);
      for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) {
          symCross[i * n + j] = 0.5 * (cross[i * n + j]! + cross[j * n + i]!);
        }
      }
      // RqSv[i,j] = 2·symCross[i,j] / (sv_i + sv_j)
      const RqSv = new Float64Array(n * n);
      for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) {
          const denom = f.sv[i]! + f.sv[j]!;
          RqSv[i * n + j] = denom > 1e-300 ? 2 * symCross[i * n + j]! / denom : 0;
        }
      }
      // Rq = G^T · RqSv · G
      const tmp2 = new Float64Array(n * n);
      matMulTN(f.G, RqSv, n, tmp2);
      const Rq = new Float64Array(n * n);
      matMul(tmp2, f.G, n, Rq);
      symmetrize(Rq, n);
      // E_b -= Rq
      for (let q = 0; q < Eb.length; q++) Eb[q] = Eb[q]! - Rq[q]!;
      symmetrize(Eb, n);
    }

    // RHS2 = -<A_i, E_x_comb> − η·r_p_i − η·<A_i, W·r_d·W>
    for (let i = 0; i < m; i++) {
      let s = -eta * rp[i]!;
      for (let b = 0; b < nb; b++) {
        s -= frobInner(blocks[b]!.A[i]!, ExComb[b]!);
        s -= eta * frobInner(blocks[b]!.A[i]!, WrdW[b]!);
      }
      rhs[i] = s;
    }
    // Iterative-refinement back-sub (Phase 5 Tier 1); nitref3 = combined-
    // direction accepted refinement steps.
    nitref3 = solveWithIR(M, m, Lchol, rhs, dy2, workE, workCorr);

    // Recover dS2_comb, dX2_comb per block
    for (let b = 0; b < nb; b++) {
      const n = blocks[b]!.size;
      const ds2 = dS2[b]!;
      const dx2 = dX2[b]!;
      // dS2 = -Σ_k dy2_k·A_k − η·r_d^b
      ds2.fill(0);
      for (let k = 0; k < m; k++) {
        const Ak = blocks[b]!.A[k]!;
        const dyk = dy2[k]!;
        for (let q = 0; q < ds2.length; q++) ds2[q] = ds2[q]! - dyk * Ak[q]!;
      }
      for (let q = 0; q < ds2.length; q++) ds2[q] = ds2[q]! - eta * rd[b]![q]!;
      symmetrize(ds2, n);
      // dX2 = E_x_comb − W·dS2·W
      const W = NT[b]!.W;
      const tmp = new Float64Array(n * n);
      matMul(W, ds2, n, tmp);
      const WdSW = new Float64Array(n * n);
      matMul(tmp, W, n, WdSW);
      for (let q = 0; q < dx2.length; q++) dx2[q] = ExComb[b]![q]! - WdSW[q]!;
      symmetrize(dx2, n);
    }

    // Scalar dτ, dκ (combined)
    let cdx2_c = 0;
    for (let b = 0; b < nb; b++) cdx2_c += frobInner(blocks[b]!.C, dX2[b]!);
    let bdy2_c = 0;
    for (let i = 0; i < m; i++) bdy2_c += prob.b[i]! * dy2[i]!;
    const Etau_comb = -tau * kappa + sigmaMu - dtauAff * dkapAff;
    const dtauNum = -eta * rg + cdx2_c - bdy2_c + Etau_comb / tau;
    const dtau = dtauNum / dtauDenom;
    const dkap = (Etau_comb - kappa * dtau) / tau;

    // Combine: dy = dy2 + dτ·dy1, dS = dS2 + dτ·dS1, dX = dX2 + dτ·dX1
    for (let i = 0; i < m; i++) dy[i] = dy2[i]! + dtau * dy1[i]!;
    for (let b = 0; b < nb; b++) {
      const dxb = dX[b]!;
      const dsb = dS[b]!;
      for (let q = 0; q < dxb.length; q++) {
        dxb[q] = dX2[b]![q]! + dtau * dX1[b]![q]!;
        dsb[q] = dS2[b]![q]! + dtau * dS1[b]![q]!;
      }
    }
    const tDirectionMs = (nowNs() - tDirStart) / 1e6 - tStepMs;

    // ─── Combined step length ───
    const tStep2Start = nowNs();
    const aConeP = minBlockStep(X, dX, blocks);
    const aConeD = minBlockStep(S, dS, blocks);
    const aKap = tauKappaMaxStep(tau, dtau, kappa, dkap);
    const alphaRaw = Math.min(aConeP, aConeD, aKap);
    tStepMs += (nowNs() - tStep2Start) / 1e6;
    const alpha = clipStep(Math.max(0.95 * alphaRaw, 2 * alphaRaw - 1));

    // ─── Update ───
    for (let b = 0; b < nb; b++) {
      const n = blocks[b]!.size;
      const Xb = X[b]!;
      const Sb = S[b]!;
      const dxb = dX[b]!;
      const dsb = dS[b]!;
      for (let q = 0; q < Xb.length; q++) {
        Xb[q] = Xb[q]! + alpha * dxb[q]!;
        Sb[q] = Sb[q]! + alpha * dsb[q]!;
      }
      symmetrize(Xb, n);
      symmetrize(Sb, n);
    }
    for (let i = 0; i < m; i++) y[i] = y[i]! + alpha * dy[i]!;
    tau += alpha * dtau;
    kappa += alpha * dkap;

    // Stall detection on homogenized μ
    let muNewSum = 0;
    for (let b = 0; b < nb; b++) muNewSum += frobInner(X[b]!, S[b]!);
    const muNew = (muNewSum + tau * kappa) / (totalConeDim + 1);
    if (muNew > 0.99 * mu) stallCount++;
    else stallCount = 0;
    prevMu = mu;

    // Verbose trace
    if (opts.verbose) {
      // eigMin proxy: min diagonal of X and S across blocks
      let eigMinX = Infinity;
      let eigMinS = Infinity;
      for (let b = 0; b < nb; b++) {
        const nb_b = blocks[b]!.size;
        const Xb = X[b]!;
        const Sb = S[b]!;
        for (let i = 0; i < nb_b; i++) {
          if (Xb[i * nb_b + i]! < eigMinX) eigMinX = Xb[i * nb_b + i]!;
          if (Sb[i * nb_b + i]! < eigMinS) eigMinS = Sb[i * nb_b + i]!;
        }
      }
      const v: VerboseIterLine = {
        ...line,
        kind: "sdp-hsde-nt",
        sigma,
        sigmaRaw,
        muAff,
        alphaPrimal: alpha,
        alphaDual: alpha,
        alphaPrimalRaw: alphaRaw,
        alphaDualRaw: alphaRaw,
        jitterPrimal: reg.jitterPrimal,
        jitterDual: reg.jitterDual,
        jitterGap: reg.jitterGap,
        bumpsPrimalThisIter: reg.bumpsPrimal - bumpsPSnap,
        bumpsDualThisIter: reg.bumpsDual - bumpsDSnap,
        bumpsGapThisIter: reg.bumpsGap - bumpsGSnap,
        refactorsThisIter: reg.refactors - refactorsSnap,
        failRow: factorRes.lastFailRow,
        schurDiagMin,
        schurDiagMax,
        eigMinX,
        eigMinS,
        tau,
        kappa,
        gfeas: gapInf,
        prstatus: term.prstatus,
        nitref1,
        nitref2,
        nitref3,
        tSchurMs,
        tFactorMs,
        tDirectionMs,
        tStepMs,
      };
      opts.verbose(v);
    }
  }

  return finalizeBestOr("iter-limit");

  function finalize(status: SolverStatus): HsdeSdpSolveResult {
    return purifyAndReturn(status, X, y, S, tau, kappa, log.length > 0 ? log.length - 1 : 0,
      bestAchieved);
  }
  function finalizeBestOr(fallback: SolverStatus): HsdeSdpSolveResult {
    // Always prefer the best snapshot when we have one (the current iterate
    // may have just blown up — e.g. NT factor failure on a degenerate τ→0
    // limit). Status is the honest fallback: bestStatus is reserved for
    // classifications the termination test made positively (today: never
    // assigned — bestStatus is always null at this site, and the certificate
    // tests in `checkHsdeTermination` short-circuit via `finalize(...)` when
    // they fire). Falling through here means "didn't converge"; the wire
    // taxonomy maps the fallback to `numerical-breakdown` / `iter-cap`,
    // never `optimal`.
    if (bestAchieved === Infinity) return finalize(fallback);
    return purifyAndReturn(
      bestStatus ?? fallback,
      bestX, bestY, bestS, bestTau, bestKappa, bestIter, bestAchieved,
    );
  }
  function purifyAndReturn(
    status: SolverStatus,
    Xin: Float64Array[], yin: Float64Array, Sin: Float64Array[],
    tauv: number, kappav: number, iter: number, achieved: number,
  ): HsdeSdpSolveResult {
    const Xp = blocks.map((b, i) => {
      const out = new Float64Array(b.size * b.size);
      if (tauv > 0) {
        for (let q = 0; q < out.length; q++) out[q] = Xin[i]![q]! / tauv;
      } else {
        out.set(Xin[i]!);
      }
      return out;
    });
    const Sp = blocks.map((b, i) => {
      const out = new Float64Array(b.size * b.size);
      if (tauv > 0) {
        for (let q = 0; q < out.length; q++) out[q] = Sin[i]![q]! / tauv;
      } else {
        out.set(Sin[i]!);
      }
      return out;
    });
    const yp = new Float64Array(m);
    if (tauv > 0) {
      for (let i = 0; i < m; i++) yp[i] = yin[i]! / tauv;
    } else {
      yp.set(yin);
    }
    let pObjP = 0;
    for (let b = 0; b < nb; b++) pObjP += frobInner(blocks[b]!.C, Xp[b]!);
    let dObjP = 0;
    for (let i = 0; i < m; i++) dObjP += prob.b[i]! * yp[i]!;
    let xs = 0;
    for (let b = 0; b < nb; b++) xs += frobInner(Xp[b]!, Sp[b]!);
    let pInfFinal = 0;
    for (let i = 0; i < m; i++) {
      let s = 0;
      for (let b = 0; b < nb; b++) s += frobInner(blocks[b]!.A[i]!, Xp[b]!);
      const r = Math.abs(s - prob.b[i]!);
      if (r > pInfFinal) pInfFinal = r;
    }
    let dInfFinal = 0;
    for (let b = 0; b < nb; b++) {
      const n = blocks[b]!.size;
      const r = new Float64Array(n * n);
      const Cb = blocks[b]!.C;
      for (let q = 0; q < r.length; q++) r[q] = Cb[q]! - Sp[b]![q]!;
      for (let i = 0; i < m; i++) {
        const yi = yp[i]!;
        const Ai = blocks[b]!.A[i]!;
        for (let q = 0; q < r.length; q++) r[q] = r[q]! - yi * Ai[q]!;
      }
      const di = matInfNorm(r);
      if (di > dInfFinal) dInfFinal = di;
    }
    return {
      status,
      X: Xp,
      y: yp,
      S: Sp,
      tau: tauv,
      kappa: kappav,
      primalObj: prob.maximize ? -pObjP : pObjP,
      dualObj: prob.maximize ? -dObjP : dObjP,
      iter,
      mu: xs / Math.max(1, totalConeDim),
      primalInf: pInfFinal,
      dualInf: dInfFinal,
      achievedPrecision: achieved,
      log,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────

interface TerminationCheck {
  status: SolverStatus;
  rhoP: number;
  rhoD: number;
  rhoG: number;
  prstatus: number;
}

// HSDE termination — three classifications via two structurally distinct tests.
//
// Optimal classification uses the **purified** ρ-metrics (ρ_p, ρ_d, ρ_g all ≤ 1
// AND τ ≫ κ AND τ + κ substantial). Purification by τ makes ρ the right shape
// for the optimal regime: τ > 0 and (X/τ, y/τ, S/τ) is the actual primal-dual
// pair we hand back, so feasibility/optimality tolerances are naturally
// expressed in terms of `residual / τ`.
//
// Infeasibility certificates use **unpurified** residuals + objectives — the
// τ→0 limit point (X*, y*, S*, τ*=0, κ*>0) IS the Farkas certificate, and
// dividing by τ is a category error there (it would blow up exactly because
// τ→0 is what we're trying to detect). This mirrors Mosek's `hom_terminatelo`
// (decomp 003f8460) — the gate to classification is `pfeasinff < tolP OR
// dfeasinff ≤ tolD` (NOT a conjunction with ρ), and the certificate tests are
// ratio tests on unpurified `b^T y` vs `‖r_d‖` and `⟨C, X⟩` vs `‖r_p‖`.
// The earlier ADR-0033 design (Decision 6) gated *both* on `max(ρ_p, ρ_d, ρ_g)
// ≤ 1` — that gate never trips on actually-infeasible problems because the
// purified ρ-metrics inflate as τ→0, so the τ-κ ρ-dichotomy never fired
// (bead `io2v`).
//
// The witness floor (1e-6) on |b^T y| / |⟨C, X⟩| guards against the
// degenerate "everything collapses to zero" iterate that satisfies the
// certificate inequalities vacuously. The τ + κ collapse floor (1e-8) does
// the analogous job for the optimal branch — without it, an iterate with
// τ = 1e-15 and κ = 1e-24 would have prstatus → +1 and ρ-metrics → 0
// because rp, rd, gap also collapse, and we'd declare optimal on a
// degenerate point with no usable purified iterate.
function checkHsdeTermination(
  rp: Float64Array,
  rd: Float64Array[],
  rg: number,
  pObj: number,
  dObj: number,
  tau: number,
  kappa: number,
  primalInf: number,
  dualInf: number,
  prob: SdpProblem,
  params: IpmParams,
): TerminationCheck {
  const bInfNorm = Math.max(1, vecInfNorm(prob.b));
  let cFrobSq = 0;
  for (const b of prob.blocks) for (let k = 0; k < b.C.length; k++) cFrobSq += b.C[k]! ** 2;
  const cFrob = Math.max(1, Math.sqrt(cFrobSq));
  const eps_p = params.feasTol;
  const eps_d = params.feasTol;
  const eps_g = params.optTol;
  // Infeasibility-certificate tolerance: looser than feasTol since the
  // unpurified residual is being compared to a witness magnitude that can
  // itself be modest (e.g. b^T y ~ 1 on small SDPLIB cases). Matches the
  // Mosek `tolinfeas` default of 1e-8 scaled by witness.
  const eps_inf = Math.max(params.feasTol, 1e-8);

  const rhoP = tau > 0 ? primalInf / (tau * eps_p * (1 + bInfNorm)) : Infinity;
  const rhoD = tau > 0 ? dualInf / (tau * eps_d * (1 + cFrob)) : Infinity;

  const pObjPure = tau > 0 ? pObj / tau : NaN;
  const dObjPure = tau > 0 ? dObj / tau : NaN;
  const gapAbs = Math.abs(pObjPure - dObjPure);
  const gapScale = Math.max(1, Math.min(Math.abs(pObjPure), Math.abs(dObjPure)));
  const rhoG = Number.isFinite(gapAbs) ? gapAbs / (eps_g * gapScale) : Infinity;

  const prstatus = (tau - kappa) / Math.max(tau + kappa, 1e-300);

  // Anti-collapse floor. A healthy HSDE iterate has τ + κ comparable to its
  // initialization (we init both to 1). Below this floor the iterate is
  // degenerate — neither classification can be trusted; let the outer loop
  // continue or hit numerical-difficulty / iter-limit on fall-through.
  const TAU_KAPPA_FLOOR = 1e-8;
  if (tau + kappa < TAU_KAPPA_FLOOR) {
    return { status: "running", rhoP, rhoD, rhoG, prstatus };
  }

  // Optimal: purified ρ-metrics small, τ dominates κ, scale is substantial.
  if (rhoP <= 1 && rhoD <= 1 && rhoG <= 1 && prstatus > 0.5) {
    void rg;  // r_g already enters via rhoG; preserved for trace plumbing
    return { status: "optimal", rhoP, rhoD, rhoG, prstatus };
  }

  // Infeasibility certificates fire only in the κ-dominant regime
  // (`prstatus < -0.5`, i.e. τ ≪ κ — the HSDE iterate is heading to the
  // τ→0 limit). Without this guard an almost-converged optimal problem
  // where |b^T y| ≫ ‖C‖_F could spuriously fire the primal-infeasibility
  // cert before the ρ-metrics drop below 1 (the cert's `eps_inf · |b^T y|`
  // bound is generous enough to admit dualInf the optimal test would reject).
  // The guard makes the regime-switch explicit: optimal is τ-dominant,
  // infeasibility is κ-dominant — they never overlap.
  const WITNESS_FLOOR = 1e-6;

  // Primal-infeasibility certificate (Farkas y witness). The unpurified
  // iterate (y, S) satisfies Σ y_i A_i + S = -r_d with S ⪰ 0, so as r_d → 0
  // we have Σ y_i A_i ⪯ 0. Combined with b^T y > 0, this is a Farkas y for
  // primal infeasibility. Test: `dualInf / b^T y` is small AND `b^T y` is
  // substantial in absolute terms (avoid collapse-noise).
  if (
    prstatus < -0.5 &&
    dObj > WITNESS_FLOOR &&
    dualInf <= eps_inf * (1 + Math.abs(dObj))
  ) {
    return { status: "primal-infeasible", rhoP, rhoD, rhoG, prstatus };
  }

  // Dual-infeasibility certificate (primal recession ray). The unpurified
  // iterate X satisfies Σ ⟨A_i, X⟩ - b_i τ = r_p → 0 as r_p, τ → 0, so
  // ⟨A_i, X⟩ → 0. Combined with ⟨C, X⟩ < 0 strictly, X is a primal
  // recession ray (primal unbounded ⟺ dual infeasible).
  if (
    prstatus < -0.5 &&
    pObj < -WITNESS_FLOOR &&
    primalInf <= eps_inf * (1 + Math.abs(pObj))
  ) {
    return { status: "dual-infeasible", rhoP, rhoD, rhoG, prstatus };
  }

  void rg;
  return { status: "running", rhoP, rhoD, rhoG, prstatus };
}

function initialScale(p: SdpProblem): { xiP: number; xiD: number } {
  let bNorm = 0;
  for (let i = 0; i < p.m; i++) bNorm = Math.max(bNorm, Math.abs(p.b[i]!));
  let cFrobSq = 0;
  for (const b of p.blocks) for (let k = 0; k < b.C.length; k++) cFrobSq += b.C[k]! ** 2;
  const cFrob = Math.sqrt(cFrobSq);
  return {
    xiP: Math.max(1, 10 * bNorm),
    xiD: Math.max(1, 10 * cFrob + bNorm),
  };
}

function eyeScaled(n: number, scale: number): Float64Array {
  const A = new Float64Array(n * n);
  for (let i = 0; i < n; i++) A[i * n + i] = scale;
  return A;
}

function vecInfNorm(v: Float64Array): number {
  let m = 0;
  for (let i = 0; i < v.length; i++) {
    const a = Math.abs(v[i]!);
    if (a > m) m = a;
  }
  return m;
}
function matInfNorm(A: Float64Array): number {
  let m = 0;
  for (let i = 0; i < A.length; i++) {
    const a = Math.abs(A[i]!);
    if (a > m) m = a;
  }
  return m;
}
function clipStep(a: number): number {
  if (a < 0) return 0;
  if (a > 0.999999) return 0.999999;
  return a;
}
function clip(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}
