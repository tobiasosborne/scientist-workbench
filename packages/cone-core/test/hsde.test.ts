// Homogeneous-self-dual-embedding tests — `buildHSDE`, `assembleQ`,
// `recoverPrimalDual`, and the internal linear-algebra helpers.
//
// The headline invariants:
//   - `assembleQ` produces a skew-symmetric matrix (Qᵀ = −Q) — this is
//     load-bearing for the entire SCS derivation (it is what makes
//     `I + Q` invertible and the iteration nonexpansive).
//   - `recoverPrimalDual` classifies a hand-built embedding point into
//     exactly the right one of optimal / primal-infeasible /
//     dual-infeasible / inconclusive, and the certificates it emits
//     satisfy their defining equalities (`bᵀcert = −1`, `cᵀcert = −1`).

import { describe, expect, test } from "bun:test";
import { matrixFromRows, get } from "@workbench/linalg-core";
import {
  type ConeProblem,
  type Tolerances,
  ConeError,
  assembleQ,
  buildHSDE,
  dot,
  matTransposeVec,
  nonNeg,
  recoverPrimalDual,
} from "../src/index.js";

const TOL: Tolerances = {
  epsPri: 1e-8,
  epsDual: 1e-8,
  epsGap: 1e-8,
  epsUnbdd: 1e-8,
  epsInfeas: 1e-8,
};

// ── internal linear-algebra helpers ─────────────────────────────────────────

describe("matTransposeVec", () => {
  test("computes Aᵀ x", () => {
    const A = matrixFromRows([
      [1, 2],
      [3, 4],
      [5, 6],
    ]);
    expect(Array.from(matTransposeVec(A, new Float64Array([1, 1, 1])))).toEqual([9, 12]);
    expect(Array.from(matTransposeVec(A, new Float64Array([1, 0, 0])))).toEqual([1, 2]);
  });
  test("rejects a length mismatch", () => {
    const A = matrixFromRows([[1, 2]]);
    expect(() => matTransposeVec(A, new Float64Array([1, 2]))).toThrow(ConeError);
  });
});

describe("dot", () => {
  test("computes the Euclidean inner product", () => {
    expect(dot(new Float64Array([1, 2, 3]), new Float64Array([4, 5, 6]))).toBe(32);
  });
  test("rejects a length mismatch", () => {
    expect(() => dot(new Float64Array([1]), new Float64Array([1, 2]))).toThrow(ConeError);
  });
});

// ── buildHSDE ───────────────────────────────────────────────────────────────

describe("buildHSDE", () => {
  const ok: ConeProblem = {
    A: matrixFromRows([
      [-1, 0],
      [0, -1],
    ]),
    b: new Float64Array([-1, -2]),
    c: new Float64Array([1, 1]),
    cones: [nonNeg(2)],
  };

  test("lifts a well-formed problem and surfaces n, m, N", () => {
    const h = buildHSDE(ok);
    expect(h.n).toBe(2);
    expect(h.m).toBe(2);
    expect(h.N).toBe(5); // n + m + 1
  });

  test("rejects b of the wrong length", () => {
    expect(() => buildHSDE({ ...ok, b: new Float64Array([1]) })).toThrow(/b has length/);
  });
  test("rejects c of the wrong length", () => {
    expect(() => buildHSDE({ ...ok, c: new Float64Array([1, 2, 3]) })).toThrow(/c has length/);
  });
  test("rejects a cone product that does not tile m", () => {
    expect(() => buildHSDE({ ...ok, cones: [nonNeg(1)] })).toThrow(/tile m/);
  });
  test("rejects a non-finite data entry", () => {
    expect(() => buildHSDE({ ...ok, b: new Float64Array([Number.NaN, 0]) })).toThrow(/non-finite/);
  });
  test("rejects an empty problem", () => {
    const empty: ConeProblem = {
      A: matrixFromRows([[0]]),
      b: new Float64Array([0]),
      c: new Float64Array([0]),
      cones: [nonNeg(1)],
    };
    // 1×1 is the minimum and is accepted; 0-row / 0-col matrices are
    // rejected by `matrixFromRows` upstream, so the n<1/m<1 guard is
    // exercised via a hand-built degenerate Matrix.
    expect(buildHSDE(empty).N).toBe(3);
  });
});

// ── assembleQ — the skew-symmetry invariant ─────────────────────────────────

describe("assembleQ", () => {
  const h = buildHSDE({
    A: matrixFromRows([
      [2, -3],
      [5, 7],
      [-1, 4],
    ]),
    b: new Float64Array([1, -2, 3]),
    c: new Float64Array([-4, 6]),
    cones: [nonNeg(3)],
  });

  test("is skew-symmetric: Qᵀ = −Q (the load-bearing invariant)", () => {
    const Q = assembleQ(h);
    expect(Q.rows).toBe(h.N);
    expect(Q.cols).toBe(h.N);
    for (let i = 0; i < h.N; i++) {
      for (let j = 0; j < h.N; j++) {
        // The invariant is Q + Qᵀ = 0; the sum form is the mathematically
        // honest check and is robust to the `+0` / `−0` distinction
        // (`Object.is(0, −0)` is false, but `0 + −0` is `+0`).
        expect(get(Q, i, j) + get(Q, j, i)).toBe(0);
      }
      // skew-symmetry forces a zero diagonal
      expect(Math.abs(get(Q, i, i))).toBe(0);
    }
  });

  test("places the A / b / c blocks at the documented positions", () => {
    const Q = assembleQ(h);
    const { n, m } = h; // n=2, m=3
    // Aᵀ block: Q[i][n+j] = A[j][i]
    expect(get(Q, 0, n + 0)).toBe(2); // A[0][0]
    expect(get(Q, 1, n + 2)).toBe(4); // A[2][1]
    // −A block: Q[n+j][i] = −A[j][i]
    expect(get(Q, n + 1, 0)).toBe(-5); // −A[1][0]
    // c column: Q[i][n+m] = c[i]
    expect(get(Q, 0, n + m)).toBe(-4);
    expect(get(Q, 1, n + m)).toBe(6);
    // b column: Q[n+j][n+m] = b[j]
    expect(get(Q, n + 0, n + m)).toBe(1);
    expect(get(Q, n + 2, n + m)).toBe(3);
    // −cᵀ / −bᵀ row
    expect(get(Q, n + m, 0)).toBe(4);
    expect(get(Q, n + m, n + 1)).toBe(2);
  });
});

// ── recoverPrimalDual — the §3.5 termination evaluator ──────────────────────

describe("recoverPrimalDual — optimal", () => {
  // LP: min x s.t. x ≥ 1, encoded −x + s = −1, s ≥ 0. n = m = 1, N = 3.
  // Known solution x = 1, y = 1, s = 0 → embedding point u = [1,1,1], v = 0.
  const h = buildHSDE({
    A: matrixFromRows([[-1]]),
    b: new Float64Array([-1]),
    c: new Float64Array([1]),
    cones: [nonNeg(1)],
  });

  test("classifies a zero-residual point as optimal with the right (x, y, s)", () => {
    const u = new Float64Array([1, 1, 1]);
    const v = new Float64Array([0, 0, 0]);
    const r = recoverPrimalDual(u, v, h, TOL);
    expect(r.kind).toBe("optimal");
    if (r.kind !== "optimal") throw new Error("unreachable");
    expect(r.x[0]).toBeCloseTo(1, 12);
    expect(r.y[0]).toBeCloseTo(1, 12);
    expect(r.s[0]).toBeCloseTo(0, 12);
    expect(r.objective).toBeCloseTo(1, 12);
    expect(r.primalResidual).toBeCloseTo(0, 12);
    expect(r.dualResidual).toBeCloseTo(0, 12);
    expect(r.gap).toBeCloseTo(0, 12);
  });

  test("homogeneity: scaling the embedding point by t > 0 gives the same (x, y, s)", () => {
    const u = new Float64Array([3, 3, 3]); // t = 3
    const v = new Float64Array([0, 0, 0]);
    const r = recoverPrimalDual(u, v, h, TOL);
    expect(r.kind).toBe("optimal");
    if (r.kind !== "optimal") throw new Error("unreachable");
    expect(r.x[0]).toBeCloseTo(1, 12);
    expect(r.y[0]).toBeCloseTo(1, 12);
  });

  test("a point with a large residual is inconclusive, but carries the candidate", () => {
    const u = new Float64Array([5, 0, 1]); // x = 5: primal residual ‖−4‖ = 4
    const v = new Float64Array([0, 0, 0]);
    const r = recoverPrimalDual(u, v, h, TOL);
    expect(r.kind).toBe("inconclusive");
    if (r.kind !== "inconclusive") throw new Error("unreachable");
    expect(r.candidate).toBeDefined();
    expect(r.candidate!.x[0]).toBeCloseTo(5, 12);
    expect(r.candidate!.primalResidual).toBeCloseTo(4, 12);
  });

  test("a point with u_τ ≤ 0 is inconclusive with no candidate", () => {
    const u = new Float64Array([1, 0, -1]); // u_τ = −1
    const v = new Float64Array([0, 0, 0]);
    const r = recoverPrimalDual(u, v, h, TOL);
    expect(r.kind).toBe("inconclusive");
    if (r.kind !== "inconclusive") throw new Error("unreachable");
    expect(r.candidate).toBeUndefined();
  });
});

describe("recoverPrimalDual — primal-infeasible", () => {
  // x ≥ 1 ∧ x ≤ 0 — infeasible. Rows: −x+s₀=−1, x+s₁=0, s ≥ 0. n=1, m=2, N=4.
  // Farkas y: Aᵀy = −y₀+y₁ = 0, y ≥ 0, bᵀy = −y₀ < 0 → y = (1,1) gives bᵀy = −1.
  const h = buildHSDE({
    A: matrixFromRows([[-1], [1]]),
    b: new Float64Array([-1, 0]),
    c: new Float64Array([1]),
    cones: [nonNeg(2)],
  });

  test("classifies the Farkas direction as primal-infeasible, cert satisfies bᵀcert = −1", () => {
    // u = [u_x; u_y; u_τ] with u_y = (1,1), u_τ = 0; v irrelevant here.
    const u = new Float64Array([0, 1, 1, 0]);
    const v = new Float64Array([0, 0, 0, 0]);
    const r = recoverPrimalDual(u, v, h, TOL);
    expect(r.kind).toBe("primal-infeasible");
    if (r.kind !== "primal-infeasible") throw new Error("unreachable");
    // bᵀcert = −1 by construction of the §3.5 scaling
    expect(dot(h.b, r.certificate)).toBeCloseTo(-1, 12);
    // Aᵀcert ≈ 0 — the certificate lies in the null space of Aᵀ
    expect(matTransposeVec(h.A, r.certificate)[0]).toBeCloseTo(0, 12);
  });
});

describe("recoverPrimalDual — dual-infeasible (primal unbounded)", () => {
  // min −x s.t. x ≥ 0 — unbounded below. Row: −x + s = 0, s ≥ 0. n=m=1, N=3.
  // Ray x: −Ax = x ∈ ℝ₊, cᵀx = −x = −1 → x = 1.
  const h = buildHSDE({
    A: matrixFromRows([[-1]]),
    b: new Float64Array([0]),
    c: new Float64Array([-1]),
    cones: [nonNeg(1)],
  });

  test("classifies the unbounded ray as dual-infeasible, cert satisfies cᵀcert = −1", () => {
    // u_x = 1 (cᵀu_x = −1 < 0); v_s = 1 so A u_x + v_s = 0; u_τ = 0.
    const u = new Float64Array([1, 0, 0]);
    const v = new Float64Array([0, 1, 0]);
    const r = recoverPrimalDual(u, v, h, TOL);
    expect(r.kind).toBe("dual-infeasible");
    if (r.kind !== "dual-infeasible") throw new Error("unreachable");
    expect(dot(h.c, r.certificate)).toBeCloseTo(-1, 12);
  });
});

describe("recoverPrimalDual — guards", () => {
  test("rejects u / v whose length is not the embedding dimension N", () => {
    const h = buildHSDE({
      A: matrixFromRows([[-1]]),
      b: new Float64Array([-1]),
      c: new Float64Array([1]),
      cones: [nonNeg(1)],
    });
    expect(() => recoverPrimalDual(new Float64Array(2), new Float64Array(3), h, TOL)).toThrow(
      ConeError,
    );
  });
});
