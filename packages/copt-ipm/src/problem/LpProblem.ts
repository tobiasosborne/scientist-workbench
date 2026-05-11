// Decoded LP problem: dense row-major Float64Array storage, m × n.

import type { CanonicalLp } from "../format/CanonicalLp.js";

export interface LpProblem {
  m: number;
  n: number;
  A: Float64Array;
  b: Float64Array;
  c: Float64Array;
  nonNegMask: Uint8Array;
}

export function lpFromCanonical(p: CanonicalLp): LpProblem {
  const c = Float64Array.from(p.minimize.c);
  const n = c.length;
  const aeq = p.subjectTo.Ax_eq_b;
  if (!aeq) {
    return {
      m: 0,
      n,
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
    A,
    b: Float64Array.from(aeq.b),
    c,
    nonNegMask: maskFromCones(p.subjectTo.cones, n),
  };
}

function maskFromCones(cones: CanonicalLp["subjectTo"]["cones"], n: number): Uint8Array {
  const mask = new Uint8Array(n);
  for (const block of cones) {
    if (block.head !== "NonNegCone") {
      throw new Error(`unsupported cone in LP path: ${block.head}`);
    }
    if (block.indices) {
      for (const idx of block.indices) mask[idx] = 1;
    } else if (typeof block.size === "number") {
      for (let i = 0; i < block.size; i++) mask[i] = 1;
    }
  }
  return mask;
}
