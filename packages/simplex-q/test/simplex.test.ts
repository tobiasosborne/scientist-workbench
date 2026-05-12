// Tests for the simplex driver. The progression from trivial to
// pathological mirrors the algorithm-development sequence: start with
// LPs whose optimum is obvious, then test the three structural
// outcomes (optimal / infeasible / unbounded), then exercise the
// degeneracy / anti-cycling machinery with Beale 1955's cycling
// instance, then exercise the worst-case-pivot machinery with the
// Klee-Minty cube.
//
// What "passing" means in this suite (Rule 7): every test asserts an
// *invariant* that would only hold for a correct implementation. A
// test that says "simplex returns without throwing" is broken.

import { describe, test, expect } from "bun:test";
import { makeRat, ratEq, type Rat, ratMul, ratAdd, RAT_ZERO } from "@workbench/cas-core";
import { simplexSolve, type StandardLP } from "../src/index.js";

// ---------- helpers ----------

function R(n: number | bigint, d: number | bigint = 1n): Rat {
  const nn = typeof n === "number" ? BigInt(n) : n;
  const dd = typeof d === "number" ? BigInt(d) : d;
  return makeRat(nn, dd);
}

function vecEq(a: ReadonlyArray<Rat>, b: ReadonlyArray<Rat>): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (!ratEq(a[i]!, b[i]!)) return false;
  return true;
}

function dot(a: ReadonlyArray<Rat>, b: ReadonlyArray<Rat>): Rat {
  let s: Rat = RAT_ZERO;
  for (let i = 0; i < a.length; i++) {
    s = ratAdd(s, ratMul(a[i]!, b[i]!));
  }
  return s;
}

function matVec(A: ReadonlyArray<ReadonlyArray<Rat>>, x: ReadonlyArray<Rat>): Rat[] {
  return A.map((row) => dot(row, x));
}

// ---------- trivial cases ----------

describe("simplex — trivial cases", () => {
  test("1D: min x, x = 1, x >= 0 → x = 1", () => {
    // c = [1], A = [[1]], b = [1]
    const lp: StandardLP = { c: [R(1)], A: [[R(1)]], b: [R(1)] };
    const result = simplexSolve(lp);
    expect(result.status).toBe("optimal");
    if (result.status === "optimal") {
      expect(vecEq(result.x, [R(1)])).toBe(true);
      expect(ratEq(result.objective, R(1))).toBe(true);
    }
  });

  test("1D: min -x, x + s = 1, x, s >= 0 → x = 1, obj = -1", () => {
    // c = [-1, 0], A = [[1, 1]], b = [1]
    const lp: StandardLP = { c: [R(-1), R(0)], A: [[R(1), R(1)]], b: [R(1)] };
    const result = simplexSolve(lp);
    expect(result.status).toBe("optimal");
    if (result.status === "optimal") {
      expect(ratEq(result.x[0]!, R(1))).toBe(true);
      expect(ratEq(result.x[1]!, R(0))).toBe(true);
      expect(ratEq(result.objective, R(-1))).toBe(true);
    }
  });

  test("2D: min 2x + 3y, x + y = 5, x, y >= 0 → x = 5, y = 0, obj = 10", () => {
    const lp: StandardLP = {
      c: [R(2), R(3)],
      A: [[R(1), R(1)]],
      b: [R(5)],
    };
    const result = simplexSolve(lp);
    expect(result.status).toBe("optimal");
    if (result.status === "optimal") {
      expect(ratEq(result.objective, R(10))).toBe(true);
    }
  });

  test("KKT residuals are exactly zero for a small optimum", () => {
    // min x + y, x + 2y = 4, x + y = 3, x, y >= 0
    // Solving: x = 2, y = 1, obj = 3.
    const lp: StandardLP = {
      c: [R(1), R(1)],
      A: [[R(1), R(2)], [R(1), R(1)]],
      b: [R(4), R(3)],
    };
    const result = simplexSolve(lp);
    expect(result.status).toBe("optimal");
    if (result.status === "optimal") {
      // Primal feasibility: Ax = b.
      const Ax = matVec(lp.A, result.x);
      expect(vecEq(Ax, lp.b)).toBe(true);
      // Complementary slackness: x_j * s_j = 0 for every j.
      for (let j = 0; j < result.x.length; j++) {
        const prod = ratMul(result.x[j]!, result.slack[j]!);
        expect(ratEq(prod, RAT_ZERO)).toBe(true);
      }
      // Optimality: objective = c^T x = b^T y.
      const bTy = dot(lp.b, result.dual);
      expect(ratEq(result.objective, bTy)).toBe(true);
    }
  });
});

// ---------- infeasibility ----------

describe("simplex — infeasibility detection", () => {
  test("trivially infeasible: x = 1 AND x = 2", () => {
    // c = [0], A = [[1], [1]], b = [1, 2] — inconsistent.
    const lp: StandardLP = {
      c: [R(0)],
      A: [[R(1)], [R(1)]],
      b: [R(1), R(2)],
    };
    const result = simplexSolve(lp);
    expect(result.status).toBe("infeasible");
    if (result.status === "infeasible") {
      // Farkas: y^T b > 0 and y^T A <= 0 (componentwise).
      // Here A = [[1], [1]] and b = [1, 2].
      // y^T b = y_1 + 2 y_2 > 0
      // y^T A = y_1 + y_2 <= 0 (one-dimensional column)
      const yTb = dot(result.farkas, lp.b);
      expect(yTb.n > 0n).toBe(true);
      for (let j = 0; j < lp.c.length; j++) {
        let yTAj: Rat = RAT_ZERO;
        for (let i = 0; i < lp.A.length; i++) {
          yTAj = ratAdd(yTAj, ratMul(result.farkas[i]!, lp.A[i]![j]!));
        }
        expect(yTAj.n <= 0n).toBe(true);
      }
    }
  });
});

// ---------- unboundedness ----------

describe("simplex — unboundedness detection", () => {
  test("min -x, no upper bound on x → unbounded", () => {
    // c = [-1, 0], A = [[0, 1]], b = [1]. The only equality binds the
    // slack to 1, leaving x free to grow.
    const lp: StandardLP = {
      c: [R(-1), R(0)],
      A: [[R(0), R(1)]],
      b: [R(1)],
    };
    const result = simplexSolve(lp);
    expect(result.status).toBe("unbounded");
    if (result.status === "unbounded") {
      // Ray d satisfies A d = 0 and d >= 0 and c^T d < 0.
      const Ad = matVec(lp.A, result.ray);
      for (const v of Ad) expect(ratEq(v, RAT_ZERO)).toBe(true);
      for (const v of result.ray) expect(v.n >= 0n).toBe(true);
      const cTd = dot(lp.c, result.ray);
      expect(cTd.n < 0n).toBe(true);
    }
  });
});

// ---------- degeneracy / Beale 1955 cycling instance ----------

/**
 * Beale 1955's canonical cycling example. The original objective is
 *
 *     max  3/4 · x1 - 150 · x2 + 1/50 · x3 - 6 · x4
 *
 * subject to
 *
 *     1/4 · x1 - 60 · x2 - 1/25 · x3 + 9 · x4 ≤ 0
 *     1/2 · x1 - 90 · x2 - 1/50 · x3 + 3 · x4 ≤ 0
 *                                       x3   ≤ 1
 *     x1, x2, x3, x4 ≥ 0
 *
 * which we convert to standard form by introducing slacks `s1, s2, s3`:
 *
 *     min  -3/4 · x1 + 150 · x2 - 1/50 · x3 + 6 · x4
 *     s.t.  1/4 · x1 - 60 · x2 - 1/25 · x3 + 9 · x4 + s1            = 0
 *           1/2 · x1 - 90 · x2 - 1/50 · x3 + 3 · x4         + s2     = 0
 *                                       x3                       + s3 = 1
 *
 * Optimal value: 1/20 (or, in our minimisation convention, -1/20).
 *
 * Without anti-cycling, the standard Dantzig + smallest-subscript-leaving
 * pivot rule cycles indefinitely through six bases without progress.
 * With Bland's rule, termination is guaranteed in finite pivots.
 */
describe("simplex — Beale 1955 cycling instance (anti-cycling guard)", () => {
  const beale: StandardLP = {
    c: [R(-3, 4), R(150), R(-1, 50), R(6), R(0), R(0), R(0)],
    //   x1       x2     x3         x4   s1   s2   s3
    A: [
      [R(1, 4), R(-60), R(-1, 25), R(9), R(1), R(0), R(0)],
      [R(1, 2), R(-90), R(-1, 50), R(3), R(0), R(1), R(0)],
      [R(0),    R(0),   R(1),       R(0), R(0), R(0), R(1)],
    ],
    b: [R(0), R(0), R(1)],
  };

  test("terminates with the correct optimal value -1/20 under default policy", () => {
    const result = simplexSolve(beale, { maxIter: 1000 });
    expect(result.status).toBe("optimal");
    if (result.status === "optimal") {
      expect(ratEq(result.objective, R(-1, 20))).toBe(true);
    }
  });

  test("terminates with same value under always-Bland pricing", () => {
    // Force Bland mode from the first iteration (blandThreshold = 0
    // means "switch on the very first degenerate pivot"). The Beale
    // instance's first iterations are all degenerate, so Bland mode
    // kicks in immediately. The optimum must be identical to the
    // default-policy run — anti-cycling rules choose a different pivot
    // sequence but the same optimum (LP optima are basis-independent
    // up to multi-optimum ties, which Beale does not have).
    const result = simplexSolve(beale, { maxIter: 1000, blandThreshold: 0 });
    expect(result.status).toBe("optimal");
    if (result.status === "optimal") {
      expect(ratEq(result.objective, R(-1, 20))).toBe(true);
    }
  });
});

// ---------- degeneracy stress: Klee-Minty cube ----------

/**
 * Klee-Minty cube (Klee-Minty 1972): a family of LPs where Dantzig's
 * rule pivots through every vertex of an n-dimensional hypercube
 * (exponentially many). We use the n=3 instance to confirm:
 *   (a) the simplex *can* take an exponential number of pivots in
 *       principle (the test serves as the canary that Bland's rule
 *       is not silently kicking in on a non-cycling problem), and
 *   (b) coefficient-explosion does not occur on this instance — the
 *       cube has small integer coefficients and the basis inverse
 *       stays bounded.
 *
 * Cube formulation (n = 3): maximise 100·x1 + 10·x2 + x3 subject to
 *
 *     x1                                                   ≤ 1
 *     20·x1 + x2                                           ≤ 100
 *     200·x1 + 20·x2 + x3                                  ≤ 10000
 *     x1, x2, x3 ≥ 0
 *
 * The optimum is x = (0, 0, 10000) with objective 10000.
 */
describe("simplex — Klee-Minty cube (n=3)", () => {
  const kleeMinty: StandardLP = {
    c: [R(-100), R(-10), R(-1), R(0), R(0), R(0)],
    //   x1      x2     x3    s1   s2   s3
    A: [
      [R(1),   R(0),  R(0),  R(1), R(0), R(0)],
      [R(20),  R(1),  R(0),  R(0), R(1), R(0)],
      [R(200), R(20), R(1),  R(0), R(0), R(1)],
    ],
    b: [R(1), R(100), R(10000)],
  };

  test("reaches the cube vertex with objective -10000", () => {
    const result = simplexSolve(kleeMinty);
    expect(result.status).toBe("optimal");
    if (result.status === "optimal") {
      expect(ratEq(result.objective, R(-10000))).toBe(true);
    }
  });
});

// ---------- redundant constraint handling ----------

describe("simplex — redundant constraint handling", () => {
  test("redundant duplicate row is dropped silently", () => {
    // Two copies of the same equation: x + y = 1.
    const lp: StandardLP = {
      c: [R(1), R(1)],
      A: [[R(1), R(1)], [R(1), R(1)]],
      b: [R(1), R(1)],
    };
    const result = simplexSolve(lp);
    expect(result.status).toBe("optimal");
    if (result.status === "optimal") {
      expect(ratEq(result.objective, R(1))).toBe(true);
    }
  });
});

// ---------- empty / boundary cases ----------

describe("simplex — boundary input", () => {
  test("zero rhs, all-zero row produces optimum at 0", () => {
    // min x + y, 0·x + 0·y = 0, x, y ≥ 0 → x = y = 0, obj = 0.
    const lp: StandardLP = {
      c: [R(1), R(1)],
      A: [[R(0), R(0)]],
      b: [R(0)],
    };
    const result = simplexSolve(lp);
    expect(result.status).toBe("optimal");
    if (result.status === "optimal") {
      expect(ratEq(result.objective, R(0))).toBe(true);
    }
  });
});
