// Reference SDP IPM using the AHO direction (Alizadeh-Haeberly-Overton 1997)
// with Lyapunov solve via eigendecomposition. Kept as an A/B-comparable
// implementation alongside the HKM-direction solver. The AHO derivation is
// algebraically cleaner — every step is a Lyapunov equation
//   A · V + V · A = R
// solved by eigendecomposition of A, no NT-scaling subtleties.
//
// Primal: min <C, X>  s.t.  <A_i, X> = b_i,  X = blockdiag(X_b) ⪰ 0.
// Dual:   max b^T y    s.t.  S = C - sum_i y_i A_i ⪰ 0.
// Internal convention: minimize <C_int, X>; if prob.maximize, C_int = -C_user.
//
// AHO linearises XS = σμI symmetrically:
//   ΔX·S + S·ΔX + X·ΔS + ΔS·X = 2 R̂   where R̂ = σμ I - sym(XS) - corr
// Substituting ΔS = Rd - Σ_k Δy_k A_k and Lyapunov-inverting in ΔX gives
//   sum_k Δy_k M_ik = -rp_i + <A_i, V(Rd)> + <A_i, U(σμ, corr)>
// with V(M) = LyapSolve(X·M + M·X) and U the constant part.

import type { SdpProblem, SdpBlock } from "../problem/SdpProblem.js";
import { DEFAULT_PARAMS, type IpmParams } from "./Defaults.js";
import { eighJacobi, frobInner, matMul, symmetrize } from "../cone/PsdCone.js";
import { choleskyInPlace, choleskySolveInPlace } from "../linalg/Cholesky.js";
import type { SolverStatus } from "./Iterate.js";
import type { IterLogLine, SolveOptions, VerboseIterLine } from "./Solver.js";
import type { SdpSolveResult } from "./SdpSolver.js";

export function solveSdpAho(prob: SdpProblem, opts: SolveOptions = {}): SdpSolveResult {
  const params: IpmParams = { ...DEFAULT_PARAMS, ...(opts.params ?? {}) };
  const startMs = Date.now();
  const m = prob.m;
  const nb = prob.blocks.length;

  const { xiP, xiD } = initialScale(prob);
  const X: Float64Array[] = prob.blocks.map((b) => eyeScaled(b.size, xiP));
  const S: Float64Array[] = prob.blocks.map((b) => eyeScaled(b.size, xiD));
  const y = new Float64Array(m);

  const log: IterLogLine[] = [];
  let stallCount = 0;
  let prevMu = Infinity;

  // Per-iter regularisation state — same shape as NT/LP path for trace
  // schema uniformity. Legacy AHO single-tier escalation: jitter × 10
  // each retry, no maxGap cap (only attempt-count cap of 20). Routing
  // through these counters keeps the verbose line consistent.
  let jitterPrimal = 0;
  let jitterDual = 0;
  let jitterGap = 1e-12;
  let bumpsPrimal = 0;
  let bumpsDual = 0;
  let bumpsGap = 0;
  let refactors = 0;

  const nowNs = (): number => Bun.nanoseconds();

  for (let iter = 0; iter <= params.iterLimit; iter++) {
    const rp = primalRes(prob, X);
    const Rd = dualRes(prob, y, S);
    const muV = mu(prob, X, S);
    const pObj = pObjInt(prob, X);
    const dObj = dObjInt(prob, y);
    const primalInf = vecInfNorm(rp);
    const dualInf = Math.max(...Rd.map((r) => matInfNorm(r)));

    const line: IterLogLine = {
      iter,
      primalObj: prob.maximize ? -pObj : pObj,
      dualObj: prob.maximize ? -dObj : dObj,
      compl: muV,
      primalInf,
      dualInf,
      timeSec: (Date.now() - startMs) / 1000,
    };
    log.push(line);
    opts.log?.(line, null as never);

    const bumpsPSnap = bumpsPrimal;
    const bumpsDSnap = bumpsDual;
    const bumpsGSnap = bumpsGap;
    const refactorsSnap = refactors;

    const gap = Math.abs(pObj - dObj);
    const gapDen = 1 + Math.abs(pObj) + Math.abs(dObj);
    const bNorm = Math.max(1, vecInfNorm(prob.b));
    const cFrob = Math.max(1, frobAll(prob.blocks.map((b) => b.C)));
    if (
      primalInf / bNorm <= params.feasTol &&
      dualInf / cFrob <= params.feasTol &&
      gap / gapDen <= params.optTol
    ) {
      return finalize("optimal");
    }
    if (Date.now() - startMs > params.timeLimitSec * 1000) return finalize("time-limit");
    if (iter >= params.iterLimit) return finalize("iter-limit");

    // Reset jitter per iter (legacy AHO semantics).
    jitterPrimal = 0;
    jitterDual = 0;
    jitterGap = 1e-12;

    const tSchurStart = nowNs();

    // Per-block: eigendecompose S = Q Λ Q^T for the Lyapunov solve.
    // Lyapunov solve: V·S + S·V = R  ⇒  V = Q · ( (Q^T R Q)_{ij} / (λ_i + λ_j) ) · Q^T
    const eigs = S.map((Sb, b) => eighJacobi(Sb, prob.blocks[b]!.size));

    // Build AHO Schur and the constant-RHS contributions in one sweep.
    // For each block, define operator V_b(R) = LyapSolve(S_b)(X_b R + R X_b).
    // Then M_ik = sum_b <A_i^b, V_b(A_k^b)>.
    const M = new Float64Array(m * m);
    const VA: Float64Array[][] = []; // VA[b][k] = V_b(A_k^b)
    for (let b = 0; b < nb; b++) {
      const n = prob.blocks[b]!.size;
      const Xb = X[b]!;
      const eig = eigs[b]!;
      const row: Float64Array[] = [];
      for (let k = 0; k < m; k++) {
        const Ak = prob.blocks[b]!.A[k]!;
        // R = X A_k + A_k X
        const XAk = new Float64Array(n * n);
        const AkX = new Float64Array(n * n);
        matMul(Xb, Ak, n, XAk);
        matMul(Ak, Xb, n, AkX);
        const R = new Float64Array(n * n);
        for (let q = 0; q < R.length; q++) R[q] = XAk[q]! + AkX[q]!;
        const V = lyapSolveSym(R, n, eig);
        row.push(V);
      }
      VA.push(row);
      for (let i = 0; i < m; i++) {
        const Ai = prob.blocks[b]!.A[i]!;
        for (let k = 0; k < m; k++) {
          M[i * m + k] = M[i * m + k]! + frobInner(Ai, row[k]!);
        }
      }
    }
    // Symmetrise M numerically.
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

    // Factor M with regularisation retry. Legacy AHO: jitter × 10, no
    // cap (only the attempt-count cap of 20). Routed through shared
    // counters for verbose-schema parity.
    const tFactorStart = nowNs();
    const Lchol = new Float64Array(m * m);
    let factored = false;
    let lastFailRow: number | null = null;
    for (let attempt = 0; attempt < 20; attempt++) {
      Lchol.set(M);
      const info = choleskyInPlace(Lchol, m, jitterGap);
      if (info < 0) { factored = true; break; }
      lastFailRow = info;
      jitterGap = jitterGap * 10;
      bumpsGap++;
      refactors++;
    }
    const tFactorMs = (nowNs() - tFactorStart) / 1e6;
    if (!factored) return finalize("numerical-error");

    const tDirStart = nowNs();
    // Predictor (σ=0, corr=0). R̂ = -sym(XS).
    const dyAff = new Float64Array(m);
    const dSaff = prob.blocks.map((b) => new Float64Array(b.size * b.size));
    const dXaff = prob.blocks.map((b) => new Float64Array(b.size * b.size));
    solveAhoNewton(prob, X, eigs, Rd, rp, /*sigmaMu*/ 0, /*corr*/ null,
      VA, Lchol, dyAff, dSaff, dXaff);

    const tStep1Start = nowNs();
    const aPaff = Math.min(1, minBlockStep(X, dXaff, prob.blocks));
    const aDaff = Math.min(1, minBlockStep(S, dSaff, prob.blocks));
    let tStepMs = (nowNs() - tStep1Start) / 1e6;

    const muAff = predictedMu(prob, X, S, dXaff, dSaff, aPaff, aDaff);
    // σ clipped to [1e-8, 0.9] per CLEANROOM_SPEC.md §2 step 5.
    const sigmaRaw = (muAff / Math.max(muV, 1e-300)) ** 3;
    const sigma = Math.max(1e-8, Math.min(0.9, sigmaRaw));
    const sigmaMu = sigma * muV;

    // Corrector: corr = sym(ΔX_aff · ΔS_aff) per block.
    const corr = prob.blocks.map((b, bi) => {
      const n = b.size;
      const tmp = new Float64Array(n * n);
      matMul(dXaff[bi]!, dSaff[bi]!, n, tmp);
      const out = new Float64Array(n * n);
      for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) {
          out[i * n + j] = 0.5 * (tmp[i * n + j]! + tmp[j * n + i]!);
        }
      }
      return out;
    });

    const dy = new Float64Array(m);
    const dS = prob.blocks.map((b) => new Float64Array(b.size * b.size));
    const dX = prob.blocks.map((b) => new Float64Array(b.size * b.size));
    solveAhoNewton(prob, X, eigs, Rd, rp, sigmaMu, corr, VA, Lchol, dy, dS, dX);

    const tStep2Start = nowNs();
    const aPmax = Math.min(1, minBlockStep(X, dX, prob.blocks));
    const aDmax = Math.min(1, minBlockStep(S, dS, prob.blocks));
    tStepMs += (nowNs() - tStep2Start) / 1e6;
    const alphaPraw = aPmax;
    const alphaDraw = aDmax;
    const alphaP = clipStep(Math.max(0.95 * aPmax, 2 * aPmax - 1));
    const alphaD = clipStep(Math.max(0.95 * aDmax, 2 * aDmax - 1));
    const tDirectionMs = (nowNs() - tDirStart) / 1e6 - tStepMs;

    for (let b = 0; b < nb; b++) {
      const n = prob.blocks[b]!.size;
      for (let k = 0; k < X[b]!.length; k++) X[b]![k] = X[b]![k]! + alphaP * dX[b]![k]!;
      for (let k = 0; k < S[b]!.length; k++) S[b]![k] = S[b]![k]! + alphaD * dS[b]![k]!;
      symmetrize(X[b]!, n);
      symmetrize(S[b]!, n);
    }
    for (let i = 0; i < m; i++) y[i] = y[i]! + alphaD * dy[i]!;

    // Stall threshold 0.99 (1% min progress) per CLEANROOM_SPEC.md §3.3.
    if (muV > 0.99 * prevMu) stallCount++;
    else stallCount = 0;
    prevMu = muV;

    let eigMinX = Infinity;
    let eigMinS = Infinity;
    for (let b = 0; b < nb; b++) {
      const nb_b = prob.blocks[b]!.size;
      const xb = X[b]!;
      const sb = S[b]!;
      for (let i = 0; i < nb_b; i++) {
        const dx = xb[i * nb_b + i]!;
        const ds = sb[i * nb_b + i]!;
        if (dx < eigMinX) eigMinX = dx;
        if (ds < eigMinS) eigMinS = ds;
      }
    }

    if (opts.verbose) {
      const v: VerboseIterLine = {
        ...line,
        kind: "sdp-aho",
        sigma,
        sigmaRaw,
        muAff,
        alphaPrimal: alphaP,
        alphaDual: alphaD,
        alphaPrimalRaw: alphaPraw,
        alphaDualRaw: alphaDraw,
        jitterPrimal,
        jitterDual,
        jitterGap,
        bumpsPrimalThisIter: bumpsPrimal - bumpsPSnap,
        bumpsDualThisIter: bumpsDual - bumpsDSnap,
        bumpsGapThisIter: bumpsGap - bumpsGSnap,
        refactorsThisIter: refactors - refactorsSnap,
        failRow: lastFailRow,
        schurDiagMin,
        schurDiagMax,
        eigMinX,
        eigMinS,
        tau: NaN,
        kappa: NaN,
        gfeas: NaN,
        prstatus: NaN,
        tSchurMs,
        tFactorMs,
        tDirectionMs,
        tStepMs,
      };
      opts.verbose(v);
    }

    if (stallCount >= params.stallIterCap) return finalize("numerical-difficulty");
  }
  return finalize("iter-limit");

  function finalize(status: SolverStatus): SdpSolveResult {
    const pFinal = pObjInt(prob, X);
    const dFinal = dObjInt(prob, y);
    return {
      status,
      primalObj: prob.maximize ? -pFinal : pFinal,
      dualObj: prob.maximize ? -dFinal : dFinal,
      X,
      y,
      S,
      iter: log.length > 0 ? log[log.length - 1]!.iter : 0,
      mu: mu(prob, X, S),
      primalInf: vecInfNorm(primalRes(prob, X)),
      dualInf: Math.max(...dualRes(prob, y, S).map((r) => matInfNorm(r))),
      log,
    };
  }
}

// AHO Newton: solve M Δy = rhs, back-substitute for ΔS, ΔX.
// rhs_i = -rp_i + <A_i, V(Rd)> + <A_i, U(σμ, corr)>
// where V(M)_b = LyapSolve(S_b)(X_b M + M X_b)  (linear in M)
// and U_b = LyapSolve(S_b)(2 σμ I - 2 sym(X_b S_b) - 2 corr_b)  (affine constant)
// Note: V(Rd) is computed per-block from Rd.
function solveAhoNewton(
  prob: SdpProblem,
  X: Float64Array[],
  eigs: { lambda: Float64Array; Q: Float64Array }[],
  Rd: Float64Array[],
  rp: Float64Array,
  sigmaMu: number,
  corr: Float64Array[] | null,
  VA: Float64Array[][],
  Lchol: Float64Array,
  dyOut: Float64Array,
  dSOut: Float64Array[],
  dXOut: Float64Array[],
): void {
  const m = prob.m;
  const nb = prob.blocks.length;

  // Derivation: ΔX = U - V(ΔS),  ΔS = Rd - Σ_k Δy_k A_k, so
  //   ΔX = U - V(Rd) + Σ_k Δy_k V(A_k)
  // Then <A_i, ΔX> = rp_i  ⇒  Σ_k Δy_k <A_i, V(A_k)> = rp_i + <A_i, V(Rd)> - <A_i, U>.
  // (sign-checked: ΔS · X + X · ΔS enters R with the opposite sign of the
  // affine RHS, hence T_lin(ΔS) = -V(ΔS); the U term then carries a minus.)
  const rhs = new Float64Array(m);
  for (let i = 0; i < m; i++) rhs[i] = rp[i]!;

  const U: Float64Array[] = [];
  const VRd: Float64Array[] = [];
  for (let b = 0; b < nb; b++) {
    const n = prob.blocks[b]!.size;
    const Xb = X[b]!;
    const eig = eigs[b]!;

    // V(Rd)_b = LyapSolve(S_b)(X_b · Rd + Rd · X_b)
    {
      const XR = new Float64Array(n * n);
      const RX = new Float64Array(n * n);
      matMul(Xb, Rd[b]!, n, XR);
      matMul(Rd[b]!, Xb, n, RX);
      const R = new Float64Array(n * n);
      for (let q = 0; q < R.length; q++) R[q] = XR[q]! + RX[q]!;
      VRd.push(lyapSolveSym(R, n, eig));
    }

    // U_b = LyapSolve(S_b)(2 σμ I - 2 sym(XS) - 2 corr)
    const XS = new Float64Array(n * n);
    const Sb = reconstructFromEig(eig, n);
    matMul(Xb, Sb, n, XS);
    const Rconst = new Float64Array(n * n);
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        Rconst[i * n + j] = -(XS[i * n + j]! + XS[j * n + i]!); // -2 sym(XS)
      }
    }
    for (let i = 0; i < n; i++) Rconst[i * n + i] = Rconst[i * n + i]! + 2 * sigmaMu;
    if (corr !== null) {
      for (let q = 0; q < Rconst.length; q++) Rconst[q] = Rconst[q]! - 2 * corr[b]![q]!;
    }
    U.push(lyapSolveSym(Rconst, n, eig));

    for (let i = 0; i < m; i++) {
      const Ai = prob.blocks[b]!.A[i]!;
      rhs[i] = rhs[i]! + frobInner(Ai, VRd[b]!);
      rhs[i] = rhs[i]! - frobInner(Ai, U[b]!);
    }
  }

  // Solve M Δy = rhs.
  dyOut.set(rhs);
  choleskySolveInPlace(Lchol, m, dyOut);

  // ΔS = Rd - sum_k Δy_k A_k
  for (let b = 0; b < nb; b++) {
    const n = prob.blocks[b]!.size;
    const dsb = dSOut[b]!;
    dsb.set(Rd[b]!);
    for (let k = 0; k < m; k++) {
      const Ak = prob.blocks[b]!.A[k]!;
      const dyk = dyOut[k]!;
      for (let q = 0; q < dsb.length; q++) dsb[q] = dsb[q]! - dyk * Ak[q]!;
    }
    symmetrize(dsb, n);
  }

  // ΔX = U - V(ΔS) = U - V(Rd) + Σ_k Δy_k V(A_k)
  for (let b = 0; b < nb; b++) {
    const n = prob.blocks[b]!.size;
    const dxb = dXOut[b]!;
    for (let q = 0; q < dxb.length; q++) dxb[q] = U[b]![q]! - VRd[b]![q]!;
    for (let k = 0; k < m; k++) {
      const dyk = dyOut[k]!;
      const Vak = VA[b]![k]!;
      for (let q = 0; q < dxb.length; q++) dxb[q] = dxb[q]! + dyk * Vak[q]!;
    }
    symmetrize(dxb, n);
  }
}

// Lyapunov solve: given S = Q Λ Q^T (eigendecomp), find V such that V·S + S·V = R.
// V = Q · D · Q^T where D_{ij} = (Q^T R Q)_{ij} / (λ_i + λ_j).
function lyapSolveSym(
  R: Float64Array,
  n: number,
  eig: { lambda: Float64Array; Q: Float64Array },
): Float64Array {
  const { lambda, Q } = eig;
  // QtR = Q^T · R
  const QtR = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      let s = 0;
      for (let k = 0; k < n; k++) s += Q[k * n + i]! * R[k * n + j]!;
      QtR[i * n + j] = s;
    }
  }
  // QtRQ = QtR · Q
  const QtRQ = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      let s = 0;
      for (let k = 0; k < n; k++) s += QtR[i * n + k]! * Q[k * n + j]!;
      QtRQ[i * n + j] = s;
    }
  }
  // D_{ij} = QtRQ_{ij} / (λ_i + λ_j)
  const D = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const denom = lambda[i]! + lambda[j]!;
      D[i * n + j] = denom > 1e-300 ? QtRQ[i * n + j]! / denom : 0;
    }
  }
  // V = Q · D · Q^T
  const QD = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      let s = 0;
      for (let k = 0; k < n; k++) s += Q[i * n + k]! * D[k * n + j]!;
      QD[i * n + j] = s;
    }
  }
  const V = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      let s = 0;
      for (let k = 0; k < n; k++) s += QD[i * n + k]! * Q[j * n + k]!;
      V[i * n + j] = s;
    }
  }
  return V;
}

function reconstructFromEig(
  eig: { lambda: Float64Array; Q: Float64Array },
  n: number,
): Float64Array {
  const { lambda, Q } = eig;
  // M = Q · diag(λ) · Q^T
  const M = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      let s = 0;
      for (let k = 0; k < n; k++) s += Q[i * n + k]! * lambda[k]! * Q[j * n + k]!;
      M[i * n + j] = s;
    }
  }
  return M;
}

function primalRes(p: SdpProblem, X: Float64Array[]): Float64Array {
  const r = new Float64Array(p.m);
  for (let i = 0; i < p.m; i++) {
    let s = 0;
    for (let b = 0; b < p.blocks.length; b++) s += frobInner(p.blocks[b]!.A[i]!, X[b]!);
    r[i] = p.b[i]! - s;
  }
  return r;
}

function dualRes(p: SdpProblem, y: Float64Array, S: Float64Array[]): Float64Array[] {
  const out: Float64Array[] = [];
  for (let b = 0; b < p.blocks.length; b++) {
    const n = p.blocks[b]!.size;
    const r = new Float64Array(n * n);
    const C = p.blocks[b]!.C;
    for (let k = 0; k < r.length; k++) r[k] = C[k]! - S[b]![k]!;
    for (let i = 0; i < p.m; i++) {
      const yi = y[i]!;
      const Ai = p.blocks[b]!.A[i]!;
      for (let k = 0; k < r.length; k++) r[k] = r[k]! - yi * Ai[k]!;
    }
    out.push(r);
  }
  return out;
}

function mu(p: SdpProblem, X: Float64Array[], S: Float64Array[]): number {
  let s = 0;
  let n = 0;
  for (let b = 0; b < p.blocks.length; b++) {
    s += frobInner(X[b]!, S[b]!);
    n += p.blocks[b]!.size;
  }
  return s / Math.max(1, n);
}

function pObjInt(p: SdpProblem, X: Float64Array[]): number {
  let s = 0;
  for (let b = 0; b < p.blocks.length; b++) s += frobInner(p.blocks[b]!.C, X[b]!);
  return s;
}
function dObjInt(p: SdpProblem, y: Float64Array): number {
  let s = 0;
  for (let i = 0; i < p.m; i++) s += p.b[i]! * y[i]!;
  return s;
}

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
    if (info >= 0) { a = Math.min(a, 0); continue; }
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) Zcopy[i * n + j] = 0;
    // Compute symmetric M = L^{-1} ΔZ L^{-T} by left-solve, transpose, left-solve, transpose.
    const M = new Float64Array(dZ[b]!);
    symmetrize(M, n);
    triLowerSolve(Zcopy, n, M);
    transposeSquareInPlace(M, n);
    triLowerSolve(Zcopy, n, M);
    transposeSquareInPlace(M, n);
    symmetrize(M, n);
    const { lambda } = eighJacobi(M, n);
    const lmin = lambda[0]!;
    const step = lmin >= 0 ? Infinity : 1 / -lmin;
    if (step < a) a = step;
  }
  return a;
}

function triLowerSolve(L: Float64Array, n: number, B: Float64Array): void {
  for (let col = 0; col < n; col++) {
    for (let i = 0; i < n; i++) {
      let s = B[i * n + col]!;
      for (let k = 0; k < i; k++) s -= L[i * n + k]! * B[k * n + col]!;
      B[i * n + col] = s / L[i * n + i]!;
    }
  }
}
function transposeSquareInPlace(M: Float64Array, n: number): void {
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const t = M[i * n + j]!;
      M[i * n + j] = M[j * n + i]!;
      M[j * n + i] = t;
    }
  }
}

function predictedMu(
  p: SdpProblem,
  X: Float64Array[],
  S: Float64Array[],
  dX: Float64Array[],
  dS: Float64Array[],
  ap: number,
  ad: number,
): number {
  let s = 0;
  let n = 0;
  for (let b = 0; b < p.blocks.length; b++) {
    const Xb = X[b]!;
    const Sb = S[b]!;
    for (let k = 0; k < Xb.length; k++) {
      s += (Xb[k]! + ap * dX[b]![k]!) * (Sb[k]! + ad * dS[b]![k]!);
    }
    n += p.blocks[b]!.size;
  }
  return s / Math.max(1, n);
}

function eyeScaled(n: number, scale: number): Float64Array {
  const A = new Float64Array(n * n);
  for (let i = 0; i < n; i++) A[i * n + i] = scale;
  return A;
}

// Separate ξ_p / ξ_d per CLEANROOM_SPEC.md §3.1 — see NtSdpSolver for prose.
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

function vecInfNorm(v: Float64Array): number {
  let m = 0;
  for (let i = 0; i < v.length; i++) { const a = Math.abs(v[i]!); if (a > m) m = a; }
  return m;
}
function matInfNorm(A: Float64Array): number {
  let m = 0;
  for (let i = 0; i < A.length; i++) { const a = Math.abs(A[i]!); if (a > m) m = a; }
  return m;
}
function frobAll(Cs: Float64Array[]): number {
  let s = 0;
  for (const C of Cs) for (let k = 0; k < C.length; k++) s += C[k]! ** 2;
  return Math.sqrt(s);
}
function clipStep(a: number): number {
  if (a < 0) return 0;
  if (a > 0.999999) return 0.999999;
  return a;
}
