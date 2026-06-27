// Decoded convex-QP problem: dense row-major Float64Array storage.
// Ground truth: docs/ground-truth/convex/qp-ipm.md §1.
//
// A `QpProblem` is a strict superset of `LpProblem` (it adds the dense
// symmetric Hessian `Q`), reflecting that the QP solver restricted to
// `Q = 0` must reproduce the LP solver exactly (the consistency anchor,
// qp-ipm.md §3). The canonical wire shape `CanonicalQp` likewise extends
// `CanonicalLp` with the single field `minimize.Q`.

import type { CanonicalLp, ConeBlock } from "../format/CanonicalLp.js";

export interface CanonicalQp extends CanonicalLp {
  minimize: { c: readonly number[]; Q: readonly (readonly number[])[] };
}

export interface QpProblem {
  m: number;
  n: number;
  /** Dense symmetric Hessian, row-major `n × n`. */
  Q: Float64Array;
  /** Constraint matrix, row-major `m × n`. */
  A: Float64Array;
  b: Float64Array;
  c: Float64Array;
  nonNegMask: Uint8Array;
}

// `y = Q · x` for a dense symmetric `Q` stored row-major `n × n`. This is
// the one matvec the LP residual layer lacks; it adds the `Qx` term to
// the dual residual `r_d = Qx + c − Aᵀy − s` (qp-ipm.md §2).
export function symMatVec(Q: Float64Array, n: number, x: Float64Array, y: Float64Array): void {
  for (let i = 0; i < n; i++) {
    let s = 0;
    const row = i * n;
    for (let j = 0; j < n; j++) s += Q[row + j]! * x[j]!;
    y[i] = s;
  }
}

// Decode a `CanonicalQp` into the dense solver shape. Mirrors
// `lpFromCanonical`, adding the `Q` fill. `Q` is symmetrized on decode
// (`Q := (Q + Qᵀ)/2`) to remove wire round-off asymmetry before the
// solver assumes symmetry (qp-ipm.md §7); PSD validation is the tool
// layer's responsibility (it owns the refusal envelope).
export function qpFromCanonical(p: CanonicalQp): QpProblem {
  const c = Float64Array.from(p.minimize.c);
  const n = c.length;

  const Qrows = p.minimize.Q;
  if (Qrows.length !== n) {
    throw new Error(`Q rows=${Qrows.length} but c length=${n}`);
  }
  const Q = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    const row = Qrows[i]!;
    if (row.length !== n) {
      throw new Error(`Q row ${i} length=${row.length} but c length=${n}`);
    }
    for (let j = 0; j < n; j++) Q[i * n + j] = row[j]!;
  }
  // Symmetrize: Q := (Q + Qᵀ)/2 (idempotent on a symmetric matrix).
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const avg = 0.5 * (Q[i * n + j]! + Q[j * n + i]!);
      Q[i * n + j] = avg;
      Q[j * n + i] = avg;
    }
  }

  const aeq = p.subjectTo.Ax_eq_b;
  if (!aeq) {
    return {
      m: 0,
      n,
      Q,
      A: new Float64Array(0),
      b: new Float64Array(0),
      c,
      nonNegMask: maskFromCones(p.subjectTo.cones, n),
    };
  }
  const m = aeq.b.length;
  if (aeq.A.length !== m) {
    throw new Error(`A rows=${aeq.A.length} but b length=${m}`);
  }
  const A = new Float64Array(m * n);
  for (let i = 0; i < m; i++) {
    const row = aeq.A[i]!;
    if (row.length !== n) {
      throw new Error(`A row ${i} length=${row.length} but c length=${n}`);
    }
    for (let j = 0; j < n; j++) A[i * n + j] = row[j]!;
  }
  return {
    m,
    n,
    Q,
    A,
    b: Float64Array.from(aeq.b),
    c,
    nonNegMask: maskFromCones(p.subjectTo.cones, n),
  };
}

function maskFromCones(cones: readonly ConeBlock[], n: number): Uint8Array {
  const mask = new Uint8Array(n);
  for (const block of cones) {
    if (block.head !== "NonNegCone") {
      throw new Error(`unsupported cone in QP path: ${block.head}`);
    }
    if (block.indices) {
      for (const idx of block.indices) mask[idx] = 1;
    } else if (typeof block.size === "number") {
      for (let i = 0; i < block.size; i++) mask[i] = 1;
    }
  }
  return mask;
}
