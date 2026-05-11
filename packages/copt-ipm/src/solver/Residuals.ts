// Residual + μ computation for the LP path (FUN_00728a80 at L363/L1099).

import type { Iterate } from "./Iterate.js";
import type { LpProblem } from "../problem/LpProblem.js";
import { matVec, matVecTranspose } from "../linalg/SchurAssembler.js";

export function updateResiduals(it: Iterate, lp: LpProblem): void {
  const { m, n, A, b, c } = lp;
  // rp = b - A x
  matVec(A, m, n, it.x, it.rp);
  for (let i = 0; i < m; i++) it.rp[i] = b[i]! - it.rp[i]!;
  // rd = c - A^T y - s
  matVecTranspose(A, m, n, it.y, it.rd);
  for (let j = 0; j < n; j++) it.rd[j] = c[j]! - it.rd[j]! - it.s[j]!;
  // μ = x^T s / n
  let mu = 0;
  for (let j = 0; j < n; j++) mu += it.x[j]! * it.s[j]!;
  it.mu = mu / Math.max(1, n);
  // c^T x and b^T y
  let pobj = 0;
  for (let j = 0; j < n; j++) pobj += c[j]! * it.x[j]!;
  let dobj = 0;
  for (let i = 0; i < m; i++) dobj += b[i]! * it.y[i]!;
  it.primalObj = pobj;
  it.dualObj = dobj;
  // Norms (∞-norm of residuals — what COPT's Compl/Primal.Inf/Dual.Inf use).
  it.primalInf = vecNormInf(it.rp);
  it.dualInf = vecNormInf(it.rd);
  it.gap = Math.abs(pobj - dobj);
}

export function vecNormInf(v: Float64Array): number {
  let m = 0;
  for (let i = 0; i < v.length; i++) {
    const a = Math.abs(v[i]!);
    if (a > m) m = a;
  }
  return m;
}

export function vecNorm2(v: Float64Array | readonly number[]): number {
  let s = 0;
  for (let i = 0; i < v.length; i++) {
    const x = v[i]!;
    s += x * x;
  }
  return Math.sqrt(s);
}
