// SDP primal-dual IPM with HKM (Helmberg-Kojima-Monteiro) direction.
// Primal: min <C, X>  s.t.  <A_i, X> = b_i,  X = blockdiag(X_1,..,X_nb) ⪰ 0.
// Dual:   max b^T y    s.t.  S = C - sum_i y_i A_i ⪰ 0.
//
// HKM direction (Helmberg-Kojima-Monteiro 1996):
//   ΔS = Rd - sum_k Δy_k A_k
//   ΔX = sym( (R̂xs - X ΔS) S^{-1} )
// where R̂xs = σμ I - sym(XS)
//
// Schur system for Δy (m×m, SPD):
//   M_{ik} = sum_b <A_i^b, sym(X^b A_k^b S_inv^b)>
//   rhs_i  = rp_i - sum_b <A_i^b, sym((R̂xs^b - X^b Rd^b) S_inv^b)>
//
// Mehrotra predictor-corrector with adaptive σ.
//
// Internal convention: minimize <C_int, X>. If prob.maximize, C_int = -C_user.
// Outputs are flipped back to user convention.

import type { SdpProblem, SdpBlock } from "../problem/SdpProblem.js";
import { DEFAULT_PARAMS, type IpmParams } from "./Defaults.js";
import {
  eighJacobi,
  frobInner,
  matMul,
  symmetrize,
} from "../cone/PsdCone.js";
import { choleskyInPlace, choleskySolveInPlace } from "../linalg/Cholesky.js";
import { type SolverStatus } from "./Iterate.js";
import type { IterLogLine, SolveOptions } from "./Solver.js";

export interface SdpSolveResult {
  status: SolverStatus;
  primalObj: number; // value in user convention (max if problem was a max)
  dualObj: number;
  X: Float64Array[]; // per-block primal
  y: Float64Array;
  S: Float64Array[]; // per-block dual slack
  iter: number;
  mu: number;
  primalInf: number;
  dualInf: number;
  log: IterLogLine[];
}

export function solveSdp(prob: SdpProblem, opts: SolveOptions = {}): SdpSolveResult {
  const params: IpmParams = { ...DEFAULT_PARAMS, ...(opts.params ?? {}) };
  const startMs = Date.now();
  const m = prob.m;
  const nb = prob.blocks.length;

  // Initial point: X^0 = ξ_p · I, S^0 = ξ_d · I, y = 0.
  // Separate primal/dual scales per CLEANROOM_SPEC.md §3.1 (see NtSdpSolver
  // for prose on why this matters for SDPLIB-class problems).
  const { xiP, xiD } = initialDiagScale(prob);
  const X: Float64Array[] = prob.blocks.map((b) => eyeScaled(b.size, xiP));
  const S: Float64Array[] = prob.blocks.map((b) => eyeScaled(b.size, xiD));
  const y = new Float64Array(m);

  const log: IterLogLine[] = [];
  let stallCount = 0;
  let prevMu = Infinity;

  for (let iter = 0; iter <= params.iterLimit; iter++) {
    // Compute residuals.
    const rp = primalResidual(prob, X);
    const Rd = dualResidual(prob, y, S);
    const muV = computeMu(prob, X, S);
    const pObj = primalObjInternal(prob, X); // internal: minimize
    const dObj = dualObjInternal(prob, y);   // internal: sum b_i y_i

    const primalInf = vecInfNorm(rp);
    const dualInf = Math.max(...Rd.map((r) => matInfNorm(r)));

    // User-facing objectives: flip sign if maximize (internally we minimize -C_user)
    const pObjUser = prob.maximize ? -pObj : pObj;
    const dObjUser = prob.maximize ? -dObj : dObj;

    const line: IterLogLine = {
      iter,
      primalObj: pObjUser,
      dualObj: dObjUser,
      compl: muV,
      primalInf,
      dualInf,
      timeSec: (Date.now() - startMs) / 1000,
    };
    log.push(line);
    opts.log?.(line, null as never);

    // Convergence check.
    const gap = Math.abs(pObj - dObj);
    const gapDen = 1 + Math.abs(pObj) + Math.abs(dObj);
    const bNorm = vecInfNorm(prob.b);
    const cFrobNorm = blockwiseFrobNorm(prob.blocks.map((b) => b.C));
    const optimal =
      primalInf / Math.max(1, bNorm) <= params.feasTol &&
      dualInf / Math.max(1, cFrobNorm) <= params.feasTol &&
      gap / gapDen <= params.optTol;

    if (optimal) return finalize("optimal");
    if (Date.now() - startMs > params.timeLimitSec * 1000) return finalize("time-limit");
    if (iter >= params.iterLimit) return finalize("iter-limit");

    // Compute S_inv per block via Cholesky of S, solve L L^T X = I.
    const Sinv: Float64Array[] = [];
    for (let b = 0; b < nb; b++) {
      const n = prob.blocks[b]!.size;
      const Sinv_b = computeInverse(S[b]!, n);
      if (Sinv_b === null) return finalize("numerical-error");
      Sinv.push(Sinv_b);
    }

    // Build HKM Schur matrix: M_{ik} = sum_b <A_i^b, sym(X^b A_k^b S_inv^b)>
    // Symmetrize M afterward to enforce numerical symmetry.
    const M = buildHkmSchur(prob, X, Sinv);
    // Symmetrize M numerically.
    for (let i = 0; i < m; i++) {
      for (let j = 0; j < i; j++) {
        const avg = 0.5 * (M[i * m + j]! + M[j * m + i]!);
        M[i * m + j] = avg;
        M[j * m + i] = avg;
      }
    }

    // Factor M with regularization retry.
    const Lchol = new Float64Array(m * m);
    let jitter = 1e-12;
    let factored = false;
    for (let attempt = 0; attempt < 20; attempt++) {
      Lchol.set(M);
      const info = choleskyInPlace(Lchol, m, jitter);
      if (info < 0) { factored = true; break; }
      jitter *= 10;
    }
    if (!factored) return finalize("numerical-error");

    // ── Predictor: σ = 0, corr = 0 ──
    const dyAff = new Float64Array(m);
    const dSaff = prob.blocks.map((blk) => new Float64Array(blk.size ** 2));
    const dXaff = prob.blocks.map((blk) => new Float64Array(blk.size ** 2));

    solveHkmNewton(prob, X, S, Sinv, Rd, /*sigmaMu=*/ 0,
      Lchol, dyAff, dSaff, dXaff, rp);

    const alphaPaff = maxSafePsdStep(X, dXaff, prob.blocks);
    const alphaDaff = maxSafePsdStep(S, dSaff, prob.blocks);

    // μ_aff for Mehrotra centering.
    const muAff = predictedMu(prob, X, S, dXaff, dSaff, alphaPaff, alphaDaff);
    // σ clipped to [1e-8, 0.9] per CLEANROOM_SPEC.md §2 step 5.
    const sigma = Math.max(1e-8, Math.min(0.9, (muAff / Math.max(muV, 1e-300)) ** 3));
    const sigmaMu = sigma * muV;

    // ── Corrector: centering + Mehrotra second-order correction ──
    const dy = new Float64Array(m);
    const dS = prob.blocks.map((blk) => new Float64Array(blk.size ** 2));
    const dX = prob.blocks.map((blk) => new Float64Array(blk.size ** 2));
    solveHkmNewtonCorrected(prob, X, S, Sinv, Rd, sigmaMu,
      dXaff, dSaff, alphaPaff, alphaDaff, Lchol, dy, dS, dX, rp);

    const alphaPraw = maxSafePsdStep(X, dX, prob.blocks);
    const alphaDraw = maxSafePsdStep(S, dS, prob.blocks);

    // Safeguard step: use 0.99995 factor (Mehrotra interior).
    const alphaP = alphaPraw * params.stepFactor;
    const alphaD = alphaDraw * params.stepFactor;

    // Update iterates.
    for (let b = 0; b < nb; b++) {
      const xb = X[b]!;
      const sb = S[b]!;
      const dxb = dX[b]!;
      const dsb = dS[b]!;
      const n = prob.blocks[b]!.size;
      for (let k = 0; k < xb.length; k++) xb[k] = xb[k]! + alphaP * dxb[k]!;
      for (let k = 0; k < sb.length; k++) sb[k] = sb[k]! + alphaD * dsb[k]!;
      symmetrize(xb, n);
      symmetrize(sb, n);
    }
    for (let i = 0; i < m; i++) y[i] = y[i]! + alphaD * dy[i]!;

    // Stall detection — threshold 0.99 (1% min progress) per CLEANROOM_SPEC.md §3.3.
    if (muV > 0.99 * prevMu) stallCount++;
    else stallCount = 0;
    prevMu = muV;
    if (stallCount >= params.stallIterCap) return finalize("numerical-difficulty");
  }
  return finalize("iter-limit");

  function finalize(status: SolverStatus): SdpSolveResult {
    const iterDone = log.length > 0 ? log[log.length - 1]!.iter : 0;
    const pObjFinal = primalObjInternal(prob, X);
    const dObjFinal = dualObjInternal(prob, y);
    const pObjUser = prob.maximize ? -pObjFinal : pObjFinal;
    const dObjUser = prob.maximize ? -dObjFinal : dObjFinal;
    return {
      status,
      primalObj: pObjUser,
      dualObj: dObjUser,
      X,
      y,
      S,
      iter: iterDone,
      mu: computeMu(prob, X, S),
      primalInf: vecInfNorm(primalResidual(prob, X)),
      dualInf: Math.max(...dualResidual(prob, y, S).map((r) => matInfNorm(r))),
      log,
    };
  }
}

// ── HKM Newton direction solver (predictor: σ=0, no Mehrotra correction) ──
// Schur rhs: rhs_i = rp_i - <A_i, sym((Rxs - X Rd) S_inv)>
// Rxs = σμI - sym(XS)
// Δy = M^{-1} rhs
// ΔS = Rd - sum_k Δy_k A_k
// ΔX = sym((Rxs - X ΔS) S_inv)
function solveHkmNewton(
  prob: SdpProblem,
  X: Float64Array[],
  S: Float64Array[],
  Sinv: Float64Array[],
  Rd: Float64Array[],
  sigmaMu: number,
  Lchol: Float64Array,
  dyOut: Float64Array,
  dSOut: Float64Array[],
  dXOut: Float64Array[],
  rp: Float64Array,
): void {
  const m = prob.m;
  const nb = prob.blocks.length;

  const Rxs: Float64Array[] = [];
  const rhs = new Float64Array(m);

  // Initialize rhs = rp
  for (let i = 0; i < m; i++) rhs[i] = rp[i]!;

  for (let b = 0; b < nb; b++) {
    const n = prob.blocks[b]!.size;
    const Xb = X[b]!;
    const Sb = S[b]!;
    const Sb_inv = Sinv[b]!;
    const Rdb = Rd[b]!;

    // Rxs^b = σμ I - sym(X S)
    const Rxsb = new Float64Array(n * n);
    const XS = new Float64Array(n * n);
    matMul(Xb, Sb, n, XS);
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        Rxsb[i * n + j] = -0.5 * (XS[i * n + j]! + XS[j * n + i]!);
      }
    }
    for (let i = 0; i < n; i++) Rxsb[i * n + i] = Rxsb[i * n + i]! + sigmaMu;
    Rxs.push(Rxsb);

    // T = sym((Rxs - X Rd) S_inv)
    const XRd = new Float64Array(n * n);
    matMul(Xb, Rdb, n, XRd);
    const E = new Float64Array(n * n);
    for (let k = 0; k < n * n; k++) E[k] = Rxsb[k]! - XRd[k]!;
    const ESinv = new Float64Array(n * n);
    matMul(E, Sb_inv, n, ESinv);
    symmetrize(ESinv, n);

    // rhs_i -= <A_i, T>
    for (let i = 0; i < m; i++) {
      rhs[i] = rhs[i]! - frobInner(prob.blocks[b]!.A[i]!, ESinv);
    }
  }

  // Solve M Δy = rhs
  dyOut.set(rhs);
  choleskySolveInPlace(Lchol, m, dyOut);

  // ΔS^b = Rd^b - sum_k Δy_k A_k^b
  for (let b = 0; b < nb; b++) {
    const n = prob.blocks[b]!.size;
    const ds = dSOut[b]!;
    const Rdb = Rd[b]!;
    for (let k = 0; k < ds.length; k++) ds[k] = Rdb[k]!;
    for (let i = 0; i < m; i++) {
      const Ai = prob.blocks[b]!.A[i]!;
      const dyi = dyOut[i]!;
      for (let k = 0; k < ds.length; k++) ds[k] = ds[k]! - dyi * Ai[k]!;
    }
    symmetrize(ds, n);
  }

  // ΔX^b = sym((Rxs^b - X^b ΔS^b) S_inv^b)
  for (let b = 0; b < nb; b++) {
    const n = prob.blocks[b]!.size;
    const Xb = X[b]!;
    const Sb_inv = Sinv[b]!;
    const Rxsb = Rxs[b]!;
    const dsb = dSOut[b]!;
    const XdS = new Float64Array(n * n);
    matMul(Xb, dsb, n, XdS);
    const E = new Float64Array(n * n);
    for (let k = 0; k < n * n; k++) E[k] = Rxsb[k]! - XdS[k]!;
    const dxb = dXOut[b]!;
    matMul(E, Sb_inv, n, dxb);
    symmetrize(dxb, n);
  }
}

// ── HKM Newton direction (corrector with Mehrotra second-order term) ──
// Same as above but Rxs also subtracts alphaPaff * alphaDaff * sym(ΔX_aff * ΔS_aff).
// The scale αPaff * αDaff represents the actual second-order residual at the
// affine step lengths, avoiding the correction blowing up when αPaff << 1.
function solveHkmNewtonCorrected(
  prob: SdpProblem,
  X: Float64Array[],
  S: Float64Array[],
  Sinv: Float64Array[],
  Rd: Float64Array[],
  sigmaMu: number,
  dXaff: Float64Array[],
  dSaff: Float64Array[],
  alphaPaff: number,
  alphaDaff: number,
  Lchol: Float64Array,
  dyOut: Float64Array,
  dSOut: Float64Array[],
  dXOut: Float64Array[],
  rp: Float64Array,
): void {
  const m = prob.m;
  const nb = prob.blocks.length;

  const Rxs: Float64Array[] = [];
  const rhs = new Float64Array(m);
  for (let i = 0; i < m; i++) rhs[i] = rp[i]!;

  for (let b = 0; b < nb; b++) {
    const n = prob.blocks[b]!.size;
    const Xb = X[b]!;
    const Sb = S[b]!;
    const Sb_inv = Sinv[b]!;
    const Rdb = Rd[b]!;

    // Rxs^b = σμ I - sym(X S) - sym(ΔX_aff * ΔS_aff)
    const Rxsb = new Float64Array(n * n);
    const XS = new Float64Array(n * n);
    matMul(Xb, Sb, n, XS);
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        Rxsb[i * n + j] = -0.5 * (XS[i * n + j]! + XS[j * n + i]!);
      }
    }
    for (let i = 0; i < n; i++) Rxsb[i * n + i] = Rxsb[i * n + i]! + sigmaMu;

    // Subtract αPaff * αDaff * sym(ΔX_aff * ΔS_aff).
    // The factor αPaff * αDaff reflects the actual second-order complementarity
    // residual at the affine step lengths. Without this scaling, when αPaff << 1,
    // the correction term dominates σμI and makes the corrector step counter-productive.
    const corrScale = alphaPaff * alphaDaff;
    const corr = new Float64Array(n * n);
    matMul(dXaff[b]!, dSaff[b]!, n, corr);
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        Rxsb[i * n + j] = Rxsb[i * n + j]! - corrScale * 0.5 * (corr[i * n + j]! + corr[j * n + i]!);
      }
    }
    Rxs.push(Rxsb);

    // T = sym((Rxs - X Rd) S_inv)
    const XRd = new Float64Array(n * n);
    matMul(Xb, Rdb, n, XRd);
    const E = new Float64Array(n * n);
    for (let k = 0; k < n * n; k++) E[k] = Rxsb[k]! - XRd[k]!;
    const ESinv = new Float64Array(n * n);
    matMul(E, Sb_inv, n, ESinv);
    symmetrize(ESinv, n);

    for (let i = 0; i < m; i++) {
      rhs[i] = rhs[i]! - frobInner(prob.blocks[b]!.A[i]!, ESinv);
    }
  }

  dyOut.set(rhs);
  choleskySolveInPlace(Lchol, m, dyOut);

  for (let b = 0; b < nb; b++) {
    const n = prob.blocks[b]!.size;
    const ds = dSOut[b]!;
    const Rdb = Rd[b]!;
    for (let k = 0; k < ds.length; k++) ds[k] = Rdb[k]!;
    for (let i = 0; i < m; i++) {
      const Ai = prob.blocks[b]!.A[i]!;
      const dyi = dyOut[i]!;
      for (let k = 0; k < ds.length; k++) ds[k] = ds[k]! - dyi * Ai[k]!;
    }
    symmetrize(ds, n);
  }

  for (let b = 0; b < nb; b++) {
    const n = prob.blocks[b]!.size;
    const Xb = X[b]!;
    const Sb_inv = Sinv[b]!;
    const Rxsb = Rxs[b]!;
    const dsb = dSOut[b]!;
    const XdS = new Float64Array(n * n);
    matMul(Xb, dsb, n, XdS);
    const E = new Float64Array(n * n);
    for (let k = 0; k < n * n; k++) E[k] = Rxsb[k]! - XdS[k]!;
    const dxb = dXOut[b]!;
    matMul(E, Sb_inv, n, dxb);
    symmetrize(dxb, n);
  }
}

// ── Schur matrix for HKM ──
// M_{ik} = sum_b <A_i^b, sym(X^b A_k^b S_inv^b)>
function buildHkmSchur(
  prob: SdpProblem,
  X: Float64Array[],
  Sinv: Float64Array[],
): Float64Array {
  const m = prob.m;
  const M = new Float64Array(m * m);

  for (let b = 0; b < prob.blocks.length; b++) {
    const n = prob.blocks[b]!.size;
    const Xb = X[b]!;
    const Sb_inv = Sinv[b]!;
    const tmp = new Float64Array(n * n);
    const tmp2 = new Float64Array(n * n);
    const XASinv: Float64Array[] = new Array(m);
    for (let k = 0; k < m; k++) {
      const Ak = prob.blocks[b]!.A[k]!;
      matMul(Xb, Ak, n, tmp);
      matMul(tmp, Sb_inv, n, tmp2);
      const out = new Float64Array(n * n);
      out.set(tmp2);
      symmetrize(out, n);
      XASinv[k] = out;
    }
    for (let i = 0; i < m; i++) {
      const Ai = prob.blocks[b]!.A[i]!;
      for (let k = 0; k < m; k++) {
        M[i * m + k] = M[i * m + k]! + frobInner(Ai, XASinv[k]!);
      }
    }
  }

  return M;
}

// ── Compute S^{-1} via Cholesky with jitter retry ──
function computeInverse(S: Float64Array, n: number): Float64Array | null {
  const Scopy = new Float64Array(S);
  symmetrize(Scopy, n);
  let jitter = 1e-14;
  for (let attempt = 0; attempt < 30; attempt++) {
    const Stry = new Float64Array(Scopy);
    for (let i = 0; i < n; i++) Stry[i * n + i] = Stry[i * n + i]! + jitter;
    const info = choleskyInPlace(Stry, n, 0);
    if (info < 0) {
      const Sinv = new Float64Array(n * n);
      for (let col = 0; col < n; col++) {
        const rhs = new Float64Array(n);
        rhs[col] = 1;
        choleskySolveInPlace(Stry, n, rhs);
        for (let row = 0; row < n; row++) Sinv[row * n + col] = rhs[row]!;
      }
      symmetrize(Sinv, n);
      return Sinv;
    }
    jitter *= 10;
  }
  return null;
}

// ── Maximum safe step using eigendecomposition ──
// Computes max α such that Z + α dZ ⪰ 0.
// Uses Z = Q D Q^T to whiten: find λ_min of Q^T dZ Q / D.
// If Z is not PD, returns 0.
function psdMaxStepEig(Z: Float64Array, dZ: Float64Array, n: number): number {
  const Zsym = new Float64Array(Z);
  symmetrize(Zsym, n);
  const dZsym = new Float64Array(dZ);
  symmetrize(dZsym, n);

  const { lambda: lambdaZ, Q } = eighJacobi(Zsym, n);
  const lminZ = lambdaZ[0]!;

  if (lminZ <= 1e-300) {
    // Z is not PD — return 0 to prevent any step.
    return 0;
  }

  // Compute Z^{-1/2} = Q D^{-1/2} Q^T
  const Zinvhalf = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    const d = 1 / Math.sqrt(lambdaZ[i]!);
    for (let j = 0; j < n; j++) {
      for (let k = 0; k < n; k++) {
        Zinvhalf[j * n + k] = Zinvhalf[j * n + k]! + Q[j * n + i]! * d * Q[k * n + i]!;
      }
    }
  }

  // M = Z^{-1/2} dZ Z^{-1/2}
  const tmp = new Float64Array(n * n);
  matMul(dZsym, Zinvhalf, n, tmp);
  const Mmat = new Float64Array(n * n);
  matMul(Zinvhalf, tmp, n, Mmat);
  symmetrize(Mmat, n);

  const { lambda: lambdaM } = eighJacobi(Mmat, n);
  // Z + α dZ ⪰ 0 iff I + α M ⪰ 0.
  // Critical α = -1/λ_min(M) when λ_min(M) < 0.
  const lminM = lambdaM[0]!;
  if (lminM >= 0) return Infinity;
  return 1 / (-lminM);
}

// Compute minimum over blocks of maximum safe step.
function maxSafePsdStep(
  Z: Float64Array[],
  dZ: Float64Array[],
  blocks: SdpBlock[],
): number {
  let a = Infinity;
  for (let b = 0; b < blocks.length; b++) {
    const n = blocks[b]!.size;
    const s = psdMaxStepEig(Z[b]!, dZ[b]!, n);
    if (s < a) a = s;
  }
  if (!isFinite(a)) a = 1;
  return a;
}

// ── Residuals ──

function primalResidual(p: SdpProblem, X: Float64Array[]): Float64Array {
  const r = new Float64Array(p.m);
  for (let i = 0; i < p.m; i++) {
    let s = 0;
    for (let b = 0; b < p.blocks.length; b++) s += frobInner(p.blocks[b]!.A[i]!, X[b]!);
    r[i] = p.b[i]! - s;
  }
  return r;
}

function dualResidual(p: SdpProblem, y: Float64Array, S: Float64Array[]): Float64Array[] {
  const out: Float64Array[] = [];
  for (let b = 0; b < p.blocks.length; b++) {
    const n = p.blocks[b]!.size;
    const r = new Float64Array(n * n);
    const C = p.blocks[b]!.C;
    for (let k = 0; k < r.length; k++) r[k] = C[k]! - S[b]![k]!;
    for (let i = 0; i < p.m; i++) {
      const Ai = p.blocks[b]!.A[i]!;
      const yi = y[i]!;
      for (let k = 0; k < r.length; k++) r[k] = r[k]! - yi * Ai[k]!;
    }
    out.push(r);
  }
  return out;
}

function computeMu(p: SdpProblem, X: Float64Array[], S: Float64Array[]): number {
  let s = 0;
  let n = 0;
  for (let b = 0; b < p.blocks.length; b++) {
    s += frobInner(X[b]!, S[b]!);
    n += p.blocks[b]!.size;
  }
  return s / Math.max(1, n);
}

function primalObjInternal(p: SdpProblem, X: Float64Array[]): number {
  let s = 0;
  for (let b = 0; b < p.blocks.length; b++) s += frobInner(p.blocks[b]!.C, X[b]!);
  return s;
}

function dualObjInternal(p: SdpProblem, y: Float64Array): number {
  let s = 0;
  for (let i = 0; i < p.m; i++) s += p.b[i]! * y[i]!;
  return s;
}

// ── Helpers ──

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
    const dXb = dX[b]!;
    const dSb = dS[b]!;
    for (let k = 0; k < Xb.length; k++) {
      s += (Xb[k]! + ap * dXb[k]!) * (Sb[k]! + ad * dSb[k]!);
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

function initialDiagScale(p: SdpProblem): { xiP: number; xiD: number } {
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
  let mx = 0;
  for (let i = 0; i < v.length; i++) {
    const a = Math.abs(v[i]!);
    if (a > mx) mx = a;
  }
  return mx;
}

function matInfNorm(A: Float64Array): number {
  let mx = 0;
  for (let i = 0; i < A.length; i++) {
    const a = Math.abs(A[i]!);
    if (a > mx) mx = a;
  }
  return mx;
}

function blockwiseFrobNorm(Cs: Float64Array[]): number {
  let s = 0;
  for (const C of Cs) for (let k = 0; k < C.length; k++) s += C[k]! ** 2;
  return Math.sqrt(s);
}
