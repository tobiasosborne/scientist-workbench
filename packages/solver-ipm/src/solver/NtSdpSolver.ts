// SDP primal-dual IPM with the Nesterov-Todd (NT) direction
// (Todd-Toh-Tütüncü 1998, "On the Nesterov-Todd direction in SDP";
//  Tütüncü-Toh-Todd 2003, "Solving SDP/QP/LP using SDPT3"; SDPT3 v4 NTrhsfun.m,
//  NTdirfun.m, NTscaling.m).
//
// Primary SDP solver in this package. Treated as a search-direction
// peer of AHO (Alizadeh-Haeberly-Overton 1997) and HKM (Helmberg-
// Kojima-Monteiro 1996); the alternative directions live in
// AhoSdpSolver.ts and SdpSolver.ts as A/B references.
//
// Per-block NT scaling. Given X, S ≻ 0 (symmetric), find W ≻ 0 with WSW = X.
// Construct via:
//   L     = chol(S)                           // S = L L^T (lower)
//   M     = L^T X L                           // symmetric PSD
//   M     = V · diag(sv²) · V^T               // eigendecomp
//   sv    = sqrt(sv²)
//   G     = diag(sqrt(sv)) · V^T · L^{-1}     // n×n
//   W     = G^T G                             // symmetric ≻ 0
// Useful identities (verified):
//   G^T diag(-sv)  G = -X
//   G^T diag(sv)   G =  X
//   G^T diag(1/sv) G =  S^{-1}
//
// Newton equations (per SDP block):
//   primal feas:  <A_i, ΔX> = r_p_i
//   dual feas:    ΔS + Σ_k Δy_k A_k = R_d
//   NT compl:     ΔX + W·ΔS·W = E
//      E = -X                              (predictor, σ=0)
//      E = σμ S^{-1} - X - Rq              (corrector)
//        Rq = G^T · [2 sym(hdX · hdZ) / (sv_i + sv_j)] · G  in (i,j) elementwise
//        hdZ = G · ΔS_aff · G^T
//        hdX = G^{-T} · ΔX_aff · G^{-1}
//
// Reduces to Schur:
//   M_ik = <A_i, W A_k W>
//   rhs_i = r_p_i + <A_i, W R_d W>  -  <A_i, E>
//   Δy = M^{-1} rhs
//   ΔS = R_d - Σ Δy_k A_k
//   ΔX = E - W·ΔS·W
//
// All matrices are stored as full row-major n×n Float64Array (we keep the
// dense layout — the spec calls for packed lower-tri storage but for v1 we
// match what the rest of the package uses).

import type { SdpProblem, SdpBlock } from "../problem/SdpProblem.js";
import { DEFAULT_PARAMS, type IpmParams } from "./Defaults.js";
import { eighJacobi, frobInner, matMul, symmetrize } from "../cone/PsdCone.js";
import { choleskyInPlace, choleskySolveInPlace } from "../linalg/Cholesky.js";
import type { SolverStatus } from "./Iterate.js";
import type { IterLogLine, SolveOptions } from "./Solver.js";
import type { SdpSolveResult } from "./SdpSolver.js";

// ── Per-block NT factorisation: everything needed to assemble W, W^{-1}, etc.
interface NtFactor {
  n: number;
  L: Float64Array; // chol(S): S = L L^T (lower triangle in L; upper is unused)
  invL: Float64Array; // L^{-1} (full n×n; lower triangular)
  V: Float64Array; // eigenvectors of L^T X L (columns = eigenvecs)
  sv: Float64Array; // sqrt of eigenvalues of L^T X L (length n)
  G: Float64Array; // diag(sqrt(sv)) · V^T · L^{-1}
  W: Float64Array; // G^T G ≈ X^{1/2} (X^{1/2} S X^{1/2})^{-1/2} X^{1/2}
}

export function solveSdpNt(prob: SdpProblem, opts: SolveOptions = {}): SdpSolveResult {
  const params: IpmParams = { ...DEFAULT_PARAMS, ...(opts.params ?? {}) };
  const startMs = Date.now();
  const m = prob.m;
  const nb = prob.blocks.length;

  const xi = initialScale(prob);
  const X: Float64Array[] = prob.blocks.map((b) => eyeScaled(b.size, xi));
  const S: Float64Array[] = prob.blocks.map((b) => eyeScaled(b.size, xi));
  const y = new Float64Array(m);

  const log: IterLogLine[] = [];
  let stallCount = 0;
  let prevMu = Infinity;

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

    const gap = Math.abs(pObj - dObj);
    const gapDen = 1 + Math.abs(pObj) + Math.abs(dObj);
    const bNorm = Math.max(1, vecInfNorm(prob.b));
    const cFrob = Math.max(1, frobAll(prob.blocks.map((b) => b.C)));
    if (
      primalInf / bNorm <= params.feasTol &&
      dualInf / cFrob <= params.feasTol &&
      gap / gapDen <= params.optTol
    ) return finalize("optimal");
    if (Date.now() - startMs > params.timeLimitSec * 1000) return finalize("time-limit");
    if (iter >= params.iterLimit) return finalize("iter-limit");

    // Build per-block NT factorisation. May fail if S or X is not numerically PD.
    const NT: NtFactor[] = [];
    for (let b = 0; b < nb; b++) {
      const f = buildNtFactor(X[b]!, S[b]!, prob.blocks[b]!.size);
      if (f === null) return finalize("numerical-error");
      NT.push(f);
    }

    // hRd_i = Σ_b <A_i^b, W^b · R_d^b · W^b>  (shared between predictor and corrector)
    const hRd = new Float64Array(m);
    // WAk_per_block[b][k] = W A_k W (cached, reused by Schur build and back-sub if helpful)
    const WAW: Float64Array[][] = [];
    for (let b = 0; b < nb; b++) {
      const n = prob.blocks[b]!.size;
      const W = NT[b]!.W;
      // First compute W R_d W per block.
      const tmp = new Float64Array(n * n);
      matMul(W, Rd[b]!, n, tmp);
      const WRdW = new Float64Array(n * n);
      matMul(tmp, W, n, WRdW);
      symmetrize(WRdW, n);
      for (let i = 0; i < m; i++) {
        hRd[i] = hRd[i]! + frobInner(prob.blocks[b]!.A[i]!, WRdW);
      }
      // Cache W A_k W
      const row: Float64Array[] = [];
      for (let k = 0; k < m; k++) {
        const Ak = prob.blocks[b]!.A[k]!;
        matMul(W, Ak, n, tmp);
        const out = new Float64Array(n * n);
        matMul(tmp, W, n, out);
        symmetrize(out, n);
        row.push(out);
      }
      WAW.push(row);
    }

    // Schur matrix M_ik = Σ_b <A_i^b, W A_k W>
    const M = new Float64Array(m * m);
    for (let b = 0; b < nb; b++) {
      for (let i = 0; i < m; i++) {
        const Ai = prob.blocks[b]!.A[i]!;
        for (let k = 0; k < m; k++) {
          M[i * m + k] = M[i * m + k]! + frobInner(Ai, WAW[b]![k]!);
        }
      }
    }
    // Symmetrise (M is symmetric in exact arithmetic).
    for (let i = 0; i < m; i++) {
      for (let j = 0; j < i; j++) {
        const a = 0.5 * (M[i * m + j]! + M[j * m + i]!);
        M[i * m + j] = a;
        M[j * m + i] = a;
      }
    }

    // Factor M with adaptive jitter retry.
    const Lchol = new Float64Array(m * m);
    let jitter = params.initialJitter;
    let factored = false;
    for (let attempt = 0; attempt < 10; attempt++) {
      Lchol.set(M);
      const info = choleskyInPlace(Lchol, m, jitter);
      if (info < 0) { factored = true; break; }
      jitter *= 100;
      if (jitter > params.jitterMaxGap) break;
    }
    if (!factored) return finalize("numerical-error");

    // ── Predictor: E_pred = -X
    const dyAff = new Float64Array(m);
    const dSaff = prob.blocks.map((b) => new Float64Array(b.size * b.size));
    const dXaff = prob.blocks.map((b) => new Float64Array(b.size * b.size));
    solveNtNewton(prob, NT, Rd, hRd, rp, /*sigmaMu=*/ 0, /*affineSecondOrder=*/ null,
      Lchol, dyAff, dSaff, dXaff);

    const aPaff = minBlockStep(X, dXaff, prob.blocks);
    const aDaff = minBlockStep(S, dSaff, prob.blocks);
    const muAff = predictedMu(prob, X, S, dXaff, dSaff,
      Math.min(1, aPaff), Math.min(1, aDaff));
    const sigma = clip((muAff / Math.max(muV, 1e-300)) ** 3, 1e-8, 0.9);
    const sigmaMu = sigma * muV;

    // ── Corrector: E_corr = σμ S^{-1} - X - Rq
    // affineSecondOrder carries (dXaff, dSaff) so the corrector can compute Rq.
    const dy = new Float64Array(m);
    const dS = prob.blocks.map((b) => new Float64Array(b.size * b.size));
    const dX = prob.blocks.map((b) => new Float64Array(b.size * b.size));
    solveNtNewton(prob, NT, Rd, hRd, rp, sigmaMu,
      { dXaff, dSaff }, Lchol, dy, dS, dX);

    const aPmax = minBlockStep(X, dX, prob.blocks);
    const aDmax = minBlockStep(S, dS, prob.blocks);
    const alphaP = clipStep(Math.max(0.95 * aPmax, 2 * aPmax - 1));
    const alphaD = clipStep(Math.max(0.95 * aDmax, 2 * aDmax - 1));

    for (let b = 0; b < nb; b++) {
      const n = prob.blocks[b]!.size;
      const xb = X[b]!;
      const sb = S[b]!;
      const dxb = dX[b]!;
      const dsb = dS[b]!;
      for (let k = 0; k < xb.length; k++) xb[k] = xb[k]! + alphaP * dxb[k]!;
      for (let k = 0; k < sb.length; k++) sb[k] = sb[k]! + alphaD * dsb[k]!;
      symmetrize(xb, n);
      symmetrize(sb, n);
    }
    for (let i = 0; i < m; i++) y[i] = y[i]! + alphaD * dy[i]!;

    if (muV > 0.99 * prevMu) stallCount++;
    else stallCount = 0;
    prevMu = muV;
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

// ── Newton solve for both predictor (sigmaMu=0, affine=null) and corrector
//    (sigmaMu>0, affine!=null carrying the predictor step).
// E_pred = -X
// E_corr = σμ S^{-1} - X - Rq
// rhs = r_p + hRd - <A_i, E>
// Δy = M^{-1} rhs   (M Cholesky factor passed in Lchol)
// ΔS = R_d - Σ Δy_k A_k
// ΔX = E - W ΔS W
function solveNtNewton(
  prob: SdpProblem,
  NT: NtFactor[],
  Rd: Float64Array[],
  hRd: Float64Array,
  rp: Float64Array,
  sigmaMu: number,
  affine: { dXaff: Float64Array[]; dSaff: Float64Array[] } | null,
  Lchol: Float64Array,
  dyOut: Float64Array,
  dSOut: Float64Array[],
  dXOut: Float64Array[],
): void {
  const m = prob.m;
  const nb = prob.blocks.length;

  // Compute E per block, then assemble rhs.
  const E: Float64Array[] = [];
  const rhs = new Float64Array(m);
  for (let i = 0; i < m; i++) rhs[i] = rp[i]! + hRd[i]!;

  for (let b = 0; b < nb; b++) {
    const n = prob.blocks[b]!.size;
    const f = NT[b]!;
    const Eb = new Float64Array(n * n);

    // E starts as -X. We compute X from the NT factor: X = G^T diag(sv) G.
    // Easier: pass X in directly — but to avoid threading X through, recompute.
    // For numerical fidelity we use the original X (passed via X above).
    // Here we instead rebuild from sv, G: X_reb = G^T diag(sv) G.
    // (Same as the original X up to symmetrisation drift; doesn't matter.)
    // Actually simpler: caller has X; let's pass it via affine struct.
    // For predictor (affine === null) we still need X. So reconstruct here.
    gtDiagG(f, sign_neg, Eb);

    if (sigmaMu > 0) {
      // Add σμ S^{-1}.
      // S^{-1} = G^T diag(1/sv) G (identity proven in derivation comments).
      const tmp = new Float64Array(n * n);
      gtDiagG(f, sign_invSv, tmp);
      for (let k = 0; k < Eb.length; k++) Eb[k] = Eb[k]! + sigmaMu * tmp[k]!;
    }

    if (affine !== null) {
      // Rq = G^T · Rq_sv · G  with Rq_sv[i][j] = 2 sym(hdX hdZ)_{ij} / (sv_i + sv_j)
      // hdZ = G · ΔS_aff · G^T
      // hdX = G^{-T} · ΔX_aff · G^{-1}
      const dSb = affine.dSaff[b]!;
      const dXb = affine.dXaff[b]!;

      // hdZ = G · ΔS_aff · G^T
      const tmp1 = new Float64Array(n * n);
      matMul(f.G, dSb, n, tmp1);
      const hdZ = new Float64Array(n * n);
      matMulNT(tmp1, f.G, n, hdZ); // tmp1 · G^T

      // hdX = G^{-T} · ΔX_aff · G^{-1} — but for the *affine* direction we
      // have the exact algebraic identity hdX_aff = diag(-sv) - hdZ_aff,
      // which follows from the predictor Newton equation
      //   ΔX_aff + W ΔS_aff W = -X
      // by conjugation with G^{-T}·_·G^{-1} (uses G^{-T}·X·G^{-1} = diag(sv),
      // G^{-T}·W = G, W·G^{-1} = G^T). SDPT3 uses this identity to avoid
      // forming G^{-1} explicitly (numerically cleaner and faster).
      // Reference: SDPT3 NTrhsfun.m, line ~hdX = spdiags(... -par.sv,0,n,n) - hdZ.
      // (The qops(parbarrier, 1/sv) term is 0 for SDP without log-barrier.)
      void dXb;
      const hdX = new Float64Array(n * n);
      for (let k = 0; k < hdZ.length; k++) hdX[k] = -hdZ[k]!;
      for (let i = 0; i < n; i++) hdX[i * n + i] = hdX[i * n + i]! - f.sv[i]!;

      // cross = hdX · hdZ, sym = (cross + cross^T)/2
      const cross = new Float64Array(n * n);
      matMul(hdX, hdZ, n, cross);
      const symCross = new Float64Array(n * n);
      for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) {
          symCross[i * n + j] = 0.5 * (cross[i * n + j]! + cross[j * n + i]!);
        }
      }
      // Rq_sv[i][j] = 2 symCross[i][j] / (sv_i + sv_j)
      const RqSv = new Float64Array(n * n);
      for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) {
          const denom = f.sv[i]! + f.sv[j]!;
          RqSv[i * n + j] = denom > 1e-300 ? 2 * symCross[i * n + j]! / denom : 0;
        }
      }
      // Rq = G^T RqSv G
      const tmp3 = new Float64Array(n * n);
      matMulTN(f.G, RqSv, n, tmp3); // G^T · RqSv
      const Rq = new Float64Array(n * n);
      matMul(tmp3, f.G, n, Rq);
      symmetrize(Rq, n);

      // Subtract Rq from E.
      for (let k = 0; k < Eb.length; k++) Eb[k] = Eb[k]! - Rq[k]!;
    }

    symmetrize(Eb, n);
    E.push(Eb);

    // rhs_i -= <A_i, E_b>
    for (let i = 0; i < m; i++) {
      rhs[i] = rhs[i]! - frobInner(prob.blocks[b]!.A[i]!, Eb);
    }
  }

  // Solve M Δy = rhs.
  dyOut.set(rhs);
  choleskySolveInPlace(Lchol, m, dyOut);

  // ΔS = R_d - Σ Δy_k A_k.
  for (let b = 0; b < nb; b++) {
    const n = prob.blocks[b]!.size;
    const ds = dSOut[b]!;
    ds.set(Rd[b]!);
    for (let k = 0; k < m; k++) {
      const Ak = prob.blocks[b]!.A[k]!;
      const dyk = dyOut[k]!;
      for (let q = 0; q < ds.length; q++) ds[q] = ds[q]! - dyk * Ak[q]!;
    }
    symmetrize(ds, n);
  }

  // ΔX = E - W ΔS W.
  for (let b = 0; b < nb; b++) {
    const n = prob.blocks[b]!.size;
    const dx = dXOut[b]!;
    const W = NT[b]!.W;
    const tmp = new Float64Array(n * n);
    matMul(W, dSOut[b]!, n, tmp);
    const WdSW = new Float64Array(n * n);
    matMul(tmp, W, n, WdSW);
    for (let k = 0; k < dx.length; k++) dx[k] = E[b]![k]! - WdSW[k]!;
    symmetrize(dx, n);
  }
}

// ── NT factor construction ──
function buildNtFactor(X: Float64Array, S: Float64Array, n: number): NtFactor | null {
  // L = chol(S) lower; we work on a copy with a tiny jitter for robustness.
  const L = new Float64Array(S);
  symmetrize(L, n);
  for (let i = 0; i < n; i++) L[i * n + i] = L[i * n + i]! + 1e-14;
  const info = choleskyInPlace(L, n, 0);
  if (info >= 0) return null;
  // Strict zero of upper triangle (so we treat L as lower-triangular).
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) L[i * n + j] = 0;

  // invL via column-wise triangular solve.
  const invL = new Float64Array(n * n);
  for (let col = 0; col < n; col++) {
    invL[col * n + col] = 1;
  }
  triLowerSolveInPlace(L, n, invL, n);

  // Compute M_LXL = L^T · X · L.
  const Xsym = new Float64Array(X);
  symmetrize(Xsym, n);
  const tmp = new Float64Array(n * n);
  matMulTN(L, Xsym, n, tmp); // L^T · X
  const MLXL = new Float64Array(n * n);
  matMul(tmp, L, n, MLXL); // (L^T X) · L
  symmetrize(MLXL, n);

  // Eigendecompose M_LXL = V diag(sv²) V^T.
  const { lambda: sv2, Q: V } = eighJacobi(MLXL, n);
  const sv = new Float64Array(n);
  for (let i = 0; i < n; i++) sv[i] = Math.sqrt(Math.max(sv2[i]!, 1e-300));

  // G = diag(sqrt(sv)) · V^T · invL
  const VtinvL = new Float64Array(n * n);
  matMulTN(V, invL, n, VtinvL); // V^T · invL
  const G = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    const s = Math.sqrt(sv[i]!);
    for (let j = 0; j < n; j++) G[i * n + j] = s * VtinvL[i * n + j]!;
  }

  // W = G^T · G
  const W = new Float64Array(n * n);
  matMulTN(G, G, n, W); // G^T · G
  symmetrize(W, n);

  return { n, L, invL, V, sv, G, W };
}

// out ← G^T · diag(d(sv)) · G,  d a per-element transformation function.
type SvFn = (s: number) => number;
const sign_neg: SvFn = (s) => -s;
const sign_invSv: SvFn = (s) => 1 / s;
function gtDiagG(f: NtFactor, d: SvFn, out: Float64Array): void {
  const n = f.n;
  // (diag(d(sv)) G)_{ij} = d(sv_i) · G_ij  → temp matrix, then G^T · temp.
  const tmp = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    const di = d(f.sv[i]!);
    for (let j = 0; j < n; j++) tmp[i * n + j] = di * f.G[i * n + j]!;
  }
  matMulTN(f.G, tmp, n, out); // G^T · tmp
  symmetrize(out, n);
}

// ── Triangular and BLAS helpers ──

// B ← L^{-1} · B (L lower-tri, row-major; B is n × ncolsB row-major).
function triLowerSolveInPlace(L: Float64Array, n: number, B: Float64Array, ncolsB: number): void {
  for (let col = 0; col < ncolsB; col++) {
    for (let i = 0; i < n; i++) {
      let s = B[i * ncolsB + col]!;
      for (let k = 0; k < i; k++) s -= L[i * n + k]! * B[k * ncolsB + col]!;
      B[i * ncolsB + col] = s / L[i * n + i]!;
    }
  }
}

// C ← A · B^T  (all n×n row-major).
function matMulNT(A: Float64Array, B: Float64Array, n: number, C: Float64Array): void {
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      let s = 0;
      for (let k = 0; k < n; k++) s += A[i * n + k]! * B[j * n + k]!;
      C[i * n + j] = s;
    }
  }
}

// C ← A^T · B  (all n×n row-major).
function matMulTN(A: Float64Array, B: Float64Array, n: number, C: Float64Array): void {
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      let s = 0;
      for (let k = 0; k < n; k++) s += A[k * n + i]! * B[k * n + j]!;
      C[i * n + j] = s;
    }
  }
}

// ── Step length per block: α_max keeping Z + α·dZ ⪰ 0 ──
// Computes eigenvalues of the SYMMETRIC matrix L^{-1} ΔZ L^{-T}
// where L L^T = Z. α_max = 1 / max(0, -λ_min).
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
    // Strict-zero upper triangle of Zcopy so the triangular solves see a clean L.
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) Zcopy[i * n + j] = 0;

    const M = new Float64Array(dZ[b]!);
    symmetrize(M, n);
    // Step 1: M ← L^{-1} M  (left-multiply)
    triLowerSolveInPlace(Zcopy, n, M, n);
    // Step 2: M ← M L^{-T} via the identity M L^{-T} = (L^{-1} M^T)^T.
    transposeInPlace(M, n);
    triLowerSolveInPlace(Zcopy, n, M, n);
    transposeInPlace(M, n);
    symmetrize(M, n); // numerical cleanup; should already be ~symmetric
    const { lambda } = eighJacobi(M, n);
    const lmin = lambda[0]!;
    const step = lmin >= 0 ? Infinity : 1 / -lmin;
    if (step < a) a = step;
  }
  return a;
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

// ── Residuals & friends ──

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

function initialScale(p: SdpProblem): number {
  let bNorm = 0;
  for (let i = 0; i < p.m; i++) bNorm = Math.max(bNorm, Math.abs(p.b[i]!));
  let cFrob = 0;
  for (const b of p.blocks) for (let k = 0; k < b.C.length; k++) cFrob += b.C[k]! ** 2;
  return Math.max(1, 10 * bNorm, Math.sqrt(cFrob));
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
function clip(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}
