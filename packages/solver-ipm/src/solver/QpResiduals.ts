// Primal/dual/complementarity residuals, μ, and objectives for the QP
// path. Ground truth: docs/ground-truth/convex/qp-ipm.md §2.
//
// Sign convention (self-consistent with the augmented RHS assembly in
// QpDirection.ts; note it is the NEGATION of the LP `Residuals.ts`
// convention for r_p, so the two solvers' internals must not be mixed):
//   r_d = Qx + c − Aᵀy − s          (dual residual,  length n)
//   r_p = Ax − b                    (primal residual, length m)
// Objectives carry the quadratic term so the duality gap is xᵀs at a
// feasible point:
//   primalObj = cᵀx + (1/2) xᵀQx
//   dualObj   = bᵀy − (1/2) xᵀQx
//   primalObj − dualObj = xᵀQx + cᵀx − bᵀy  →  xᵀs  when r_p = r_d = 0.

import type { QpIterate } from "./QpIterate.js";
import type { QpProblem } from "../problem/QpProblem.js";
import { symMatVec } from "../problem/QpProblem.js";
import { matVec, matVecTranspose } from "../linalg/SchurAssembler.js";
import { vecNormInf } from "./Residuals.js";

export function updateQpResiduals(it: QpIterate, qp: QpProblem): void {
  const { m, n } = it;
  const { Q, A, b, c } = qp;

  // r_p = A x − b.
  matVec(A, m, n, it.x, it.rp);
  for (let i = 0; i < m; i++) it.rp[i] = it.rp[i]! - b[i]!;

  // r_d = Q x + c − Aᵀ y − s. Use rd as scratch: first Aᵀy, then combine
  // with the Qx term (computed into a temp slice of ldltTmp's tail is
  // unsafe; use the dx buffer which is free at residual time).
  const qx = it.dx; // dx is unused until the direction solve — reuse as Qx scratch
  symMatVec(Q, n, it.x, qx);
  matVecTranspose(A, m, n, it.y, it.rd); // rd ← Aᵀy
  for (let j = 0; j < n; j++) it.rd[j] = qx[j]! + c[j]! - it.rd[j]! - it.s[j]!;

  // μ = xᵀs / n.
  let mu = 0;
  for (let j = 0; j < n; j++) mu += it.x[j]! * it.s[j]!;
  it.mu = mu / Math.max(1, n);

  // Objectives. xᵀQx = xᵀ(Qx) reuses qx.
  let xtQx = 0;
  for (let j = 0; j < n; j++) xtQx += it.x[j]! * qx[j]!;
  let ctx = 0;
  for (let j = 0; j < n; j++) ctx += c[j]! * it.x[j]!;
  let bty = 0;
  for (let i = 0; i < m; i++) bty += b[i]! * it.y[i]!;
  it.primalObj = ctx + 0.5 * xtQx;
  it.dualObj = bty - 0.5 * xtQx;

  it.primalInf = vecNormInf(it.rp);
  it.dualInf = vecNormInf(it.rd);
  it.gap = Math.abs(it.primalObj - it.dualObj);

  // dx was borrowed as Qx scratch — clear it so the direction solve
  // starts from a known state (it is fully overwritten there anyway).
  it.dx.fill(0);
}
