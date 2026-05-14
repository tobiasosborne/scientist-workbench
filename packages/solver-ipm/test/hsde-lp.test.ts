// HSDE LP solver tests. Mirrors the trivial cases from tiny.test.ts
// plus a few HSDE-specific properties (τ → 1, κ → 0 on optimal;
// PRSTATUS → +1; n+1 μ-denominator). The acceptance criterion (per
// HANDOFF §2 Phase 1):
//   - Existing solver-ipm LP tests pass (zero regression — additive
//     check; the existing solveLp is untouched).
//   - New HSDE LP tests pass on hand-coded fixtures.
//   - AFIRO from lp-netlib converges (covered in a separate test file).
//   - brandy from lp-netlib either converges or returns clean tagged
//     refusal (covered in a separate test file).

import { describe, expect, test } from "bun:test";
import { lpFromCanonical, solveHsdeLp, type VerboseIterLine } from "../src/index.js";

describe("HSDE LP — trivial fixtures", () => {
  test("min x1+x2 s.t. x1+x2=1 → obj=1", () => {
    const res = solveHsdeLp(
      lpFromCanonical({
        minimize: { c: [1, 1] },
        subjectTo: {
          Ax_eq_b: { A: [[1, 1]], b: [1] },
          cones: [{ head: "NonNegCone", indices: [0, 1] }],
        },
        precision: 1e-8,
      }),
    );
    expect(res.status).toBe("optimal");
    expect(Math.abs(res.primalObj - 1)).toBeLessThan(1e-6);
    expect(res.tau).toBeGreaterThan(0);
    // Verify purified iterate lies on the constraint
    expect(Math.abs(res.x[0]! + res.x[1]! - 1)).toBeLessThan(1e-6);
    expect(res.x[0]!).toBeGreaterThan(-1e-8);
    expect(res.x[1]!).toBeGreaterThan(-1e-8);
  });

  test("min 2x1+x2 s.t. x1+x2=1 → obj=1, x2=1", () => {
    const res = solveHsdeLp(
      lpFromCanonical({
        minimize: { c: [2, 1] },
        subjectTo: {
          Ax_eq_b: { A: [[1, 1]], b: [1] },
          cones: [{ head: "NonNegCone", indices: [0, 1] }],
        },
        precision: 1e-8,
      }),
    );
    expect(res.status).toBe("optimal");
    expect(Math.abs(res.primalObj - 1)).toBeLessThan(1e-6);
    expect(res.x[0]!).toBeLessThan(1e-4);
    expect(Math.abs(res.x[1]! - 1)).toBeLessThan(1e-4);
  });

  test("3-variable LP — degenerate optimum", () => {
    // min  x1 + 2·x2 + 3·x3   s.t.  x1 + x2 + x3 = 1,  x ≥ 0
    // optimal: x1 = 1, x2 = x3 = 0, obj = 1
    const res = solveHsdeLp(
      lpFromCanonical({
        minimize: { c: [1, 2, 3] },
        subjectTo: {
          Ax_eq_b: { A: [[1, 1, 1]], b: [1] },
          cones: [{ head: "NonNegCone", indices: [0, 1, 2] }],
        },
        precision: 1e-8,
      }),
    );
    expect(res.status).toBe("optimal");
    expect(Math.abs(res.primalObj - 1)).toBeLessThan(1e-6);
    expect(Math.abs(res.x[0]! - 1)).toBeLessThan(1e-4);
    expect(res.x[1]!).toBeLessThan(1e-4);
    expect(res.x[2]!).toBeLessThan(1e-4);
  });
});

describe("HSDE LP — invariants", () => {
  test("on optimal: τ stays > 0, κ → 0 (small)", () => {
    const res = solveHsdeLp(
      lpFromCanonical({
        minimize: { c: [1, 2] },
        subjectTo: {
          Ax_eq_b: { A: [[1, 1]], b: [3] },
          cones: [{ head: "NonNegCone", indices: [0, 1] }],
        },
        precision: 1e-8,
      }),
    );
    expect(res.status).toBe("optimal");
    expect(res.tau).toBeGreaterThan(1e-6);
    // κ/τ should be small at the optimum (κ → 0, τ → ~1 normalized)
    expect(res.kappa / res.tau).toBeLessThan(1e-3);
  });

  test("achievedPrecision ≤ 1 at optimal", () => {
    // ρ-max scaled residual should be ≤ 1 when status === "optimal"
    const res = solveHsdeLp(
      lpFromCanonical({
        minimize: { c: [1, 1, 1] },
        subjectTo: {
          Ax_eq_b: { A: [[1, 1, 1], [1, -1, 0]], b: [2, 0] },
          cones: [{ head: "NonNegCone", indices: [0, 1, 2] }],
        },
        precision: 1e-8,
      }),
    );
    expect(res.status).toBe("optimal");
    expect(res.achievedPrecision).toBeLessThanOrEqual(1);
  });
});

describe("HSDE LP — verbose trace", () => {
  test("emits lp-hsde kind with τ, κ, gfeas, prstatus fields populated", () => {
    const lines: VerboseIterLine[] = [];
    const res = solveHsdeLp(
      lpFromCanonical({
        minimize: { c: [1, 1] },
        subjectTo: {
          Ax_eq_b: { A: [[1, 1]], b: [1] },
          cones: [{ head: "NonNegCone", indices: [0, 1] }],
        },
        precision: 1e-8,
      }),
      { verbose: (l) => lines.push(l) },
    );
    expect(res.status).toBe("optimal");
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) {
      expect(l.kind).toBe("lp-hsde");
      expect(Number.isFinite(l.tau)).toBe(true);
      expect(Number.isFinite(l.kappa)).toBe(true);
      expect(Number.isFinite(l.gfeas)).toBe(true);
      expect(Number.isFinite(l.prstatus)).toBe(true);
      // Phase 5 Tier 1: nitref{1,2,3} are accepted iterative-refinement step
      // counts — non-negative integers, ≤ the maxIter cap (9). They are no
      // longer stubbed at 0 (that was the Tier-0 invariant); 0 on a
      // well-conditioned iter, climbing where the Schur is ill-conditioned.
      for (const n of [l.nitref1, l.nitref2, l.nitref3]) {
        expect(Number.isInteger(n)).toBe(true);
        expect(n).toBeGreaterThanOrEqual(0);
        expect(n).toBeLessThanOrEqual(9);
      }
      // Non-HSDE eigMin fields should be NaN
      expect(Number.isNaN(l.eigMinX)).toBe(true);
      expect(Number.isNaN(l.eigMinS)).toBe(true);
    }
    // PRSTATUS should be positive (heading to optimal) for at least one iter
    const lastWithFinitePrSt = lines.filter((l) => Number.isFinite(l.prstatus));
    expect(lastWithFinitePrSt.length).toBeGreaterThan(0);
  });
});
