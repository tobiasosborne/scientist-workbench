import { describe, expect, test } from "bun:test";
import { solveLp, lpFromCanonical, formatIterHeader, formatIterLine } from "../src/index.js";

// A trivial LP we can solve in closed form to anchor the solver.
//   min  x1 + x2  s.t.  x1 + x2 = 1,  x1, x2 ≥ 0
//   answer: any (x1, x2) with x1 + x2 = 1; objective = 1
describe("tiny LP", () => {
  test("min x1+x2 s.t. x1+x2=1 → obj=1", () => {
    const res = solveLp(
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
    expect(Math.abs(res.iterate.primalObj - 1)).toBeLessThan(1e-6);
  });

  test("min c.x s.t. Ax=b with skew costs → objective ≈ 0.5", () => {
    // min  2 x1 + x2  s.t.  x1 + x2 = 1,  x1,x2 ≥ 0
    // optimal: x2 = 1, x1 = 0, obj = 1
    const res = solveLp(
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
    expect(Math.abs(res.iterate.primalObj - 1)).toBeLessThan(1e-6);
    expect(res.iterate.x[0]!).toBeLessThan(1e-4);
    expect(Math.abs(res.iterate.x[1]! - 1)).toBeLessThan(1e-4);
  });

  test("log header is the COPT one", () => {
    expect(formatIterHeader()).toContain("Iter");
    expect(formatIterHeader()).toContain("Primal.Obj");
    expect(formatIterHeader()).toContain("Dual.Obj");
    expect(formatIterHeader()).toContain("Compl");
  });

  test("log line shape", () => {
    const line = formatIterLine({
      iter: 0,
      primalObj: -4.75,
      dualObj: 0,
      compl: 5,
      primalInf: 8.12,
      dualInf: 2,
      timeSec: 0.02,
    });
    expect(line).toContain("0");
    expect(line).toContain("e");
  });
});
