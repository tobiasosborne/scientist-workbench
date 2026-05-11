// Packed symmetric matrix utilities for the PSD cone.
// Storage: row-major dense n×n Float64Array. We keep it dense (not svec)
// because dense Cholesky/eigh in @workbench/linalg-core is what we have
// and SDP block sizes are small in our test problems.

import { choleskyInPlace } from "../linalg/Cholesky.js";

export function symmetrize(A: Float64Array, n: number): void {
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const v = 0.5 * (A[i * n + j]! + A[j * n + i]!);
      A[i * n + j] = v;
      A[j * n + i] = v;
    }
  }
}

// Frobenius inner product <A, B> = sum_ij A_ij B_ij.
export function frobInner(A: Float64Array, B: Float64Array): number {
  let s = 0;
  for (let i = 0; i < A.length; i++) s += A[i]! * B[i]!;
  return s;
}

// C = A · B for dense n×n row-major matrices.
export function matMul(A: Float64Array, B: Float64Array, n: number, C: Float64Array): void {
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      let s = 0;
      for (let k = 0; k < n; k++) s += A[i * n + k]! * B[k * n + j]!;
      C[i * n + j] = s;
    }
  }
}

// In place B ← L^{-1} · B where L is lower triangular row-major (n×n, stored full
// but we only read the lower triangle).
function triLowerSolveInPlace(L: Float64Array, n: number, B: Float64Array, ncolsB: number): void {
  for (let col = 0; col < ncolsB; col++) {
    for (let i = 0; i < n; i++) {
      let s = B[i * ncolsB + col]!;
      for (let k = 0; k < i; k++) s -= L[i * n + k]! * B[k * ncolsB + col]!;
      B[i * ncolsB + col] = s / L[i * n + i]!;
    }
  }
}

// In place B ← L^{-T} · B (L lower-tri, so L^T is upper).
function triUpperSolveTInPlace(L: Float64Array, n: number, B: Float64Array, ncolsB: number): void {
  for (let col = 0; col < ncolsB; col++) {
    for (let i = n - 1; i >= 0; i--) {
      let s = B[i * ncolsB + col]!;
      for (let k = i + 1; k < n; k++) s -= L[k * n + i]! * B[k * ncolsB + col]!;
      B[i * ncolsB + col] = s / L[i * n + i]!;
    }
  }
}

// Compute the eigenvalues + eigenvectors of a symmetric matrix via cyclic
// Jacobi. Returns eigenvalues in ascending order (LAPACK convention) and
// the orthogonal Q with A = Q · diag(λ) · Q^T. Operates on a copy of A.
// (Reimplemented here to avoid a circular workspace dep at this stage.)
export function eighJacobi(
  A: Float64Array,
  n: number,
  tol = 1e-14,
  maxSweeps = 60,
): { lambda: Float64Array; Q: Float64Array } {
  const M = new Float64Array(A);
  symmetrize(M, n);
  const Q = new Float64Array(n * n);
  for (let i = 0; i < n; i++) Q[i * n + i] = 1;
  for (let sweep = 0; sweep < maxSweeps; sweep++) {
    let off = 0;
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
      const m = M[i * n + j]!;
      off += m * m;
    }
    if (off < tol * tol) break;
    for (let p = 0; p < n - 1; p++) {
      for (let q = p + 1; q < n; q++) {
        const apq = M[p * n + q]!;
        if (Math.abs(apq) < 1e-300) continue;
        const app = M[p * n + p]!;
        const aqq = M[q * n + q]!;
        const theta = (aqq - app) / (2 * apq);
        let t: number;
        if (Math.abs(theta) > 1e150) t = 1 / (2 * theta);
        else {
          const s = theta >= 0 ? 1 : -1;
          t = s / (Math.abs(theta) + Math.sqrt(1 + theta * theta));
        }
        const c = 1 / Math.sqrt(1 + t * t);
        const s = t * c;
        M[p * n + p] = app - t * apq;
        M[q * n + q] = aqq + t * apq;
        M[p * n + q] = 0;
        M[q * n + p] = 0;
        for (let r = 0; r < n; r++) {
          if (r === p || r === q) continue;
          const arp = M[r * n + p]!;
          const arq = M[r * n + q]!;
          const nrp = c * arp - s * arq;
          const nrq = s * arp + c * arq;
          M[r * n + p] = nrp;
          M[p * n + r] = nrp;
          M[r * n + q] = nrq;
          M[q * n + r] = nrq;
        }
        for (let r = 0; r < n; r++) {
          const qrp = Q[r * n + p]!;
          const qrq = Q[r * n + q]!;
          Q[r * n + p] = c * qrp - s * qrq;
          Q[r * n + q] = s * qrp + c * qrq;
        }
      }
    }
  }
  const lambda = new Float64Array(n);
  for (let i = 0; i < n; i++) lambda[i] = M[i * n + i]!;
  // Sort ascending and reorder Q columns.
  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => lambda[a]! - lambda[b]!);
  const lamSorted = new Float64Array(n);
  const Qsorted = new Float64Array(n * n);
  for (let j = 0; j < n; j++) {
    lamSorted[j] = lambda[order[j]!]!;
    for (let i = 0; i < n; i++) Qsorted[i * n + j] = Q[i * n + order[j]!]!;
  }
  return { lambda: lamSorted, Q: Qsorted };
}

// Compute B = A^{1/2} for a PSD matrix via eigendecomposition.
export function psdSqrt(A: Float64Array, n: number): Float64Array {
  const { lambda, Q } = eighJacobi(A, n);
  const D = new Float64Array(n * n);
  for (let i = 0; i < n; i++) D[i * n + i] = Math.sqrt(Math.max(0, lambda[i]!));
  const QD = new Float64Array(n * n);
  matMul(Q, D, n, QD);
  // B = QD · Q^T
  const B = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      let s = 0;
      for (let k = 0; k < n; k++) s += QD[i * n + k]! * Q[j * n + k]!;
      B[i * n + j] = s;
    }
  }
  return B;
}

// Compute B = A^{-1/2} via eigendecomposition.
export function psdInvSqrt(A: Float64Array, n: number): Float64Array {
  const { lambda, Q } = eighJacobi(A, n);
  const D = new Float64Array(n * n);
  for (let i = 0; i < n; i++) D[i * n + i] = 1 / Math.sqrt(Math.max(1e-300, lambda[i]!));
  const QD = new Float64Array(n * n);
  matMul(Q, D, n, QD);
  const B = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      let s = 0;
      for (let k = 0; k < n; k++) s += QD[i * n + k]! * Q[j * n + k]!;
      B[i * n + j] = s;
    }
  }
  return B;
}

// Compute the NT scaling W: WSW = X, W = X^{1/2} (X^{1/2} S X^{1/2})^{-1/2} X^{1/2}.
export function ntScaling(X: Float64Array, S: Float64Array, n: number): Float64Array {
  const Xhalf = psdSqrt(X, n);
  const tmp = new Float64Array(n * n);
  const inner = new Float64Array(n * n);
  matMul(Xhalf, S, n, tmp);
  matMul(tmp, Xhalf, n, inner);
  symmetrize(inner, n);
  const innerInvSqrt = psdInvSqrt(inner, n);
  matMul(Xhalf, innerInvSqrt, n, tmp);
  const W = new Float64Array(n * n);
  matMul(tmp, Xhalf, n, W);
  symmetrize(W, n);
  return W;
}

// Maximum step length keeping (X + α·ΔX) PSD: 1 / max(0, -λ_min(L^{-1} ΔX L^{-T}))
// where L L^T = X. Returns Infinity if no negative eigenvalue.
export function psdMaxStep(X: Float64Array, dX: Float64Array, n: number): number {
  const Xcopy = new Float64Array(X);
  symmetrize(Xcopy, n);
  // jitter to keep Cholesky robust at start
  for (let i = 0; i < n; i++) Xcopy[i * n + i] = Xcopy[i * n + i]! + 1e-14;
  const info = choleskyInPlace(Xcopy, n, 0);
  if (info >= 0) return Infinity;
  // Scaled increment: M = L^{-1} ΔX L^{-T}
  const M = new Float64Array(dX);
  triLowerSolveInPlace(Xcopy, n, M, n);
  triUpperSolveTInPlace(Xcopy, n, M, n);
  symmetrize(M, n);
  const { lambda } = eighJacobi(M, n);
  const lmin = lambda[0]!;
  return lmin >= 0 ? Infinity : 1 / (-lmin);
}
