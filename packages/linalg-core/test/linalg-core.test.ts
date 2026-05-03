// linalg-core tests:
//   - matrix: constructors, NaN rejection, ragged-input rejection
//   - matVec, vecNorm2, matNorm1: agreement with hand-computed cases
//   - lu: PA = LU reconstruction property; growthFactor sanity; singular detection
//   - luSolve / luSolveTransposed: round-trip A · solve(A, b) ≈ b on random matrices
//   - hagerOneNormEstimate: within ~3× of the exact ||A^{-1}||_1 (computed
//     by inverting a small matrix column-by-column via the LU)
//   - solve: end-to-end on hand-checked, identity, permutation, triangular, Hilbert
//   - mutation hooks (commented): perturbations the test suite catches

import { describe, expect, test } from "bun:test";
import {
  matrixFromRows,
  matIdentity,
  matZeros,
  matVec,
  vecNorm2,
  vecNormInf,
  matNorm1,
  lu,
  luSolve,
  luSolveTransposed,
  luDet,
  hagerOneNormEstimate,
  solve,
  type Matrix,
} from "../src/index.js";

const EPS = Number.EPSILON;

class RNG {
  private state: number;
  constructor(seed: number) { this.state = seed >>> 0; }
  next(): number {
    let t = (this.state += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  uniform(lo: number, hi: number): number { return lo + (hi - lo) * this.next(); }
  randomMatrix(n: number, lo = -1, hi = 1): Matrix {
    const rows: number[][] = [];
    for (let i = 0; i < n; i++) {
      const row: number[] = [];
      for (let j = 0; j < n; j++) row.push(this.uniform(lo, hi));
      rows.push(row);
    }
    return matrixFromRows(rows);
  }
  randomVector(n: number, lo = -1, hi = 1): Float64Array {
    const v = new Float64Array(n);
    for (let i = 0; i < n; i++) v[i] = this.uniform(lo, hi);
    return v;
  }
}

// Reconstruct A from an LU factorisation: P^T (L · U). Used to verify
// the LU result independently of the solve loop.
function reconstructFromLU(LU: Matrix, P: Int32Array): Matrix {
  const n = LU.rows;
  // Build L (unit lower) and U (upper) explicitly.
  const L = matZeros(n, n);
  const U = matZeros(n, n);
  for (let i = 0; i < n; i++) {
    L.data[i * n + i] = 1;
    for (let j = 0; j < i; j++) L.data[i * n + j] = LU.data[i * n + j]!;
    for (let j = i; j < n; j++) U.data[i * n + j] = LU.data[i * n + j]!;
  }
  // LU' = L · U
  const LU2 = matZeros(n, n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      let s = 0;
      for (let k = 0; k < n; k++) s += L.data[i * n + k]! * U.data[k * n + j]!;
      LU2.data[i * n + j] = s;
    }
  }
  // Reverse the permutation: A[P[i], j] = LU2[i, j], so A[r, j] = LU2[Pinv[r], j].
  const Pinv = new Int32Array(n);
  for (let i = 0; i < n; i++) Pinv[P[i]!] = i;
  const A = matZeros(n, n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      A.data[i * n + j] = LU2.data[Pinv[i]! * n + j]!;
    }
  }
  return A;
}

function maxAbsDiff(A: Matrix, B: Matrix): number {
  let m = 0;
  for (let i = 0; i < A.data.length; i++) {
    const d = Math.abs(A.data[i]! - B.data[i]!);
    if (d > m) m = d;
  }
  return m;
}

function maxAbsDiffVec(a: Float64Array, b: Float64Array): number {
  let m = 0;
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i]! - b[i]!);
    if (d > m) m = d;
  }
  return m;
}

// ── matrix constructors ───────────────────────────────────────────────────

describe("matrix constructors", () => {
  test("matrixFromRows: well-formed", () => {
    const m = matrixFromRows([[1, 2, 3], [4, 5, 6]]);
    expect(m.rows).toBe(2);
    expect(m.cols).toBe(3);
    expect(Array.from(m.data)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  test("matrixFromRows: rejects NaN, Infinity", () => {
    expect(() => matrixFromRows([[1, NaN]])).toThrow(/non-finite/);
    expect(() => matrixFromRows([[1, Infinity]])).toThrow(/non-finite/);
    expect(() => matrixFromRows([[1, -Infinity]])).toThrow(/non-finite/);
  });

  test("matrixFromRows: rejects empty and ragged input", () => {
    expect(() => matrixFromRows([])).toThrow(/empty matrix/);
    expect(() => matrixFromRows([[]])).toThrow(/empty matrix/);
    expect(() => matrixFromRows([[1, 2], [3]])).toThrow(/ragged/);
  });

  test("matIdentity: 3x3", () => {
    const I = matIdentity(3);
    expect(Array.from(I.data)).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1]);
  });
});

// ── basic ops ─────────────────────────────────────────────────────────────

describe("matVec, norms", () => {
  test("matVec: hand-checked", () => {
    const A = matrixFromRows([[1, 2], [3, 4]]);
    const x = new Float64Array([5, 6]);
    const y = matVec(A, x);
    expect(Array.from(y)).toEqual([17, 39]);
  });

  test("matVec: identity preserves x", () => {
    const I = matIdentity(4);
    const x = new Float64Array([1.5, -2.25, 0, 7]);
    expect(Array.from(matVec(I, x))).toEqual([1.5, -2.25, 0, 7]);
  });

  test("vecNorm2: hand-checked", () => {
    expect(vecNorm2(new Float64Array([3, 4]))).toBeCloseTo(5, 12);
    expect(vecNorm2(new Float64Array([0, 0, 0]))).toBe(0);
  });

  test("vecNorm2: handles large magnitudes without overflow", () => {
    const v = new Float64Array([1e200, 1e200]);
    expect(vecNorm2(v)).toBeCloseTo(Math.SQRT2 * 1e200, -180);
  });

  test("vecNormInf: max |x|", () => {
    expect(vecNormInf(new Float64Array([1, -3, 2]))).toBe(3);
  });

  test("matNorm1: max column sum of abs", () => {
    const A = matrixFromRows([[1, -7], [-2, 3]]);
    // col 0: |1| + |-2| = 3; col 1: |-7| + |3| = 10
    expect(matNorm1(A)).toBe(10);
  });
});

// ── LU factorisation ──────────────────────────────────────────────────────

describe("LU factorisation", () => {
  test("LU of identity is identity, permutation is identity", () => {
    const I = matIdentity(4);
    const r = lu(I)!;
    expect(Array.from(r.LU.data)).toEqual(Array.from(I.data));
    expect(Array.from(r.P)).toEqual([0, 1, 2, 3]);
    expect(r.signDet).toBe(1);
    expect(r.growthFactor).toBe(1);
  });

  test("LU on hand-computed 2x2", () => {
    const A = matrixFromRows([[2, 1], [1, 3]]);
    const r = lu(A)!;
    // Reconstruction must agree with A entry-for-entry within ~eps.
    const Arec = reconstructFromLU(r.LU, r.P);
    expect(maxAbsDiff(A, Arec)).toBeLessThan(8 * EPS);
  });

  test("LU reconstructs A on 30 random 5x5 matrices", () => {
    const rng = new RNG(42);
    for (let trial = 0; trial < 30; trial++) {
      const A = rng.randomMatrix(5);
      const r = lu(A);
      if (r === null) continue; // exactly singular, skip
      const Arec = reconstructFromLU(r.LU, r.P);
      // Tolerance: residual ≲ growth · eps · ||A||_inf · n
      let maxAbsA = 0;
      for (let i = 0; i < A.data.length; i++) {
        const v = Math.abs(A.data[i]!);
        if (v > maxAbsA) maxAbsA = v;
      }
      const tol = 1e-12 * Math.max(1, maxAbsA) * r.growthFactor;
      expect(maxAbsDiff(A, Arec)).toBeLessThan(tol);
    }
  });

  test("LU detects exactly-singular matrix (zero column)", () => {
    const A = matrixFromRows([[1, 0], [2, 0]]);
    expect(lu(A)).toBeNull();
  });

  test("LU detects exactly-singular matrix (linearly dependent rows)", () => {
    const A = matrixFromRows([[1, 2], [2, 4]]);
    expect(lu(A)).toBeNull();
  });

  test("LU pivots correctly when (0,0) is zero", () => {
    // Without pivoting this matrix would divide by 0; partial pivoting
    // swaps row 0 and row 1 first.
    const A = matrixFromRows([[0, 1], [1, 0]]);
    const r = lu(A)!;
    expect(r.P[0]).toBe(1); // row 1 went to position 0
    expect(r.signDet).toBe(-1); // odd permutation
    expect(luDet(r)).toBeCloseTo(-1, 12);
  });

  test("growth factor is 1 on diagonally-dominant matrices", () => {
    const A = matrixFromRows([[10, 1, 0], [1, 10, 1], [0, 1, 10]]);
    const r = lu(A)!;
    // Strictly diagonally dominant ⇒ no row swaps needed, growth ≈ 1.
    expect(r.growthFactor).toBeLessThan(1.5);
  });
});

// ── triangular solves ─────────────────────────────────────────────────────

describe("luSolve, luSolveTransposed", () => {
  test("luSolve recovers x on identity", () => {
    const I = matIdentity(3);
    const r = lu(I)!;
    const b = new Float64Array([5, -2, 7.5]);
    expect(Array.from(luSolve(r, b))).toEqual([5, -2, 7.5]);
  });

  test("luSolve gives the hand-computed answer on 2x2", () => {
    // [[2,1],[1,3]] x = [4, 5] → x = [7/5, 6/5]
    const A = matrixFromRows([[2, 1], [1, 3]]);
    const r = lu(A)!;
    const x = luSolve(r, new Float64Array([4, 5]));
    expect(x[0]).toBeCloseTo(7 / 5, 12);
    expect(x[1]).toBeCloseTo(6 / 5, 12);
  });

  test("luSolve round-trip: A · solve(A, b) ≈ b for random 5x5", () => {
    const rng = new RNG(123);
    for (let trial = 0; trial < 30; trial++) {
      const A = rng.randomMatrix(5);
      const b = rng.randomVector(5);
      const r = lu(A);
      if (r === null) continue;
      const x = luSolve(r, b);
      const Ax = matVec(A, x);
      expect(maxAbsDiffVec(Ax, b)).toBeLessThan(1e-10 * r.growthFactor);
    }
  });

  test("luSolveTransposed: A^T · solve_T(A, b) ≈ b for random 5x5", () => {
    const rng = new RNG(456);
    for (let trial = 0; trial < 30; trial++) {
      const A = rng.randomMatrix(5);
      const b = rng.randomVector(5);
      const r = lu(A);
      if (r === null) continue;
      const z = luSolveTransposed(r, b);
      // A^T z = b means: for each i, Σ_j A[j,i] z[j] = b[i]
      const ATz = new Float64Array(5);
      for (let i = 0; i < 5; i++) {
        let s = 0;
        for (let j = 0; j < 5; j++) s += A.data[j * 5 + i]! * z[j]!;
        ATz[i] = s;
      }
      expect(maxAbsDiffVec(ATz, b)).toBeLessThan(1e-10 * r.growthFactor);
    }
  });
});

// ── Hager condition estimator ─────────────────────────────────────────────

describe("hagerOneNormEstimate", () => {
  test("identity has condition 1", () => {
    const I = matIdentity(4);
    const r = lu(I)!;
    expect(hagerOneNormEstimate(r)).toBeCloseTo(1, 12);
  });

  test("Hilbert(3) condition: known to be ≈ 524 in 1-norm; estimate within 3x", () => {
    // Hilbert(3) inverse is integer-valued and well-known; ||H||_1 = 11/6,
    // ||H^{-1}||_1 = 408. So κ_1 ≈ 748. Hager's estimate should be within
    // ~3x. We check both that the estimate is in the right ballpark and
    // that it's a *lower* bound (Hager always under-estimates).
    const H = matrixFromRows([
      [1, 1 / 2, 1 / 3],
      [1 / 2, 1 / 3, 1 / 4],
      [1 / 3, 1 / 4, 1 / 5],
    ]);
    const r = lu(H)!;
    const est = hagerOneNormEstimate(r);
    const trueInvNorm = 408; // exact
    // Hager is a *lower* bound for the true norm.
    expect(est).toBeLessThanOrEqual(trueInvNorm * 1.0001);
    expect(est).toBeGreaterThan(trueInvNorm / 3);
  });

  test("Hilbert(4) is more ill-conditioned than Hilbert(3)", () => {
    const H3 = matrixFromRows([
      [1, 1 / 2, 1 / 3],
      [1 / 2, 1 / 3, 1 / 4],
      [1 / 3, 1 / 4, 1 / 5],
    ]);
    const H4 = matrixFromRows([
      [1, 1 / 2, 1 / 3, 1 / 4],
      [1 / 2, 1 / 3, 1 / 4, 1 / 5],
      [1 / 3, 1 / 4, 1 / 5, 1 / 6],
      [1 / 4, 1 / 5, 1 / 6, 1 / 7],
    ]);
    const cond3 = matNorm1(H3) * hagerOneNormEstimate(lu(H3)!);
    const cond4 = matNorm1(H4) * hagerOneNormEstimate(lu(H4)!);
    expect(cond4).toBeGreaterThan(cond3);
  });
});

// ── high-level solve ──────────────────────────────────────────────────────

describe("solve (end-to-end)", () => {
  test("identity: x = b", () => {
    const I = matIdentity(3);
    const b = new Float64Array([1, 2, 3]);
    const r = solve(I, b)!;
    expect(Array.from(r.x)).toEqual([1, 2, 3]);
    expect(r.residualNorm).toBe(0);
    expect(r.conditionEstimate).toBeCloseTo(1, 10);
    expect(r.growthFactor).toBe(1);
    expect(r.method).toBe("lu-partial-pivot");
  });

  test("hand-checked 2x2: [[2,1],[1,3]] x = [4,5] → [7/5, 6/5]", () => {
    const A = matrixFromRows([[2, 1], [1, 3]]);
    const b = new Float64Array([4, 5]);
    const r = solve(A, b)!;
    expect(r.x[0]).toBeCloseTo(7 / 5, 14);
    expect(r.x[1]).toBeCloseTo(6 / 5, 14);
    expect(r.residualNorm / r.bNorm).toBeLessThan(1e-15);
  });

  test("permutation matrix on b recovers via inverse permutation", () => {
    // [[0,1,0],[0,0,1],[1,0,0]] x = [a,b,c] has solution x = [c,a,b].
    const P = matrixFromRows([[0, 1, 0], [0, 0, 1], [1, 0, 0]]);
    const b = new Float64Array([7, 13, 19]);
    const r = solve(P, b)!;
    expect(Array.from(r.x)).toEqual([19, 7, 13]);
  });

  test("singular matrix returns null", () => {
    const A = matrixFromRows([[1, 2], [2, 4]]);
    expect(solve(A, new Float64Array([1, 2]))).toBeNull();
  });

  test("Hilbert(5) is solvable but ill-conditioned (condition > 1e5)", () => {
    const H = matrixFromRows([
      [1, 1 / 2, 1 / 3, 1 / 4, 1 / 5],
      [1 / 2, 1 / 3, 1 / 4, 1 / 5, 1 / 6],
      [1 / 3, 1 / 4, 1 / 5, 1 / 6, 1 / 7],
      [1 / 4, 1 / 5, 1 / 6, 1 / 7, 1 / 8],
      [1 / 5, 1 / 6, 1 / 7, 1 / 8, 1 / 9],
    ]);
    // For H · x = (1, 0, 0, 0, 0), the answer is the first row of H^{-1}:
    // [25, -300, 1050, -1400, 630] (well-known).
    const b = new Float64Array([1, 0, 0, 0, 0]);
    const r = solve(H, b)!;
    expect(r.x[0]).toBeCloseTo(25, 5);
    expect(r.x[1]).toBeCloseTo(-300, 4);
    expect(r.x[2]).toBeCloseTo(1050, 3);
    expect(r.x[3]).toBeCloseTo(-1400, 3);
    expect(r.x[4]).toBeCloseTo(630, 3);
    // Hilbert-5 condition is ~5e5 in 1-norm.
    expect(r.conditionEstimate).toBeGreaterThan(1e5);
  });

  test("round-trip on 30 random 10x10 matrices: ||A x - b|| / ||b|| < 1e-10", () => {
    const rng = new RNG(789);
    let succeeded = 0;
    for (let trial = 0; trial < 30; trial++) {
      const A = rng.randomMatrix(10);
      const b = rng.randomVector(10);
      const r = solve(A, b);
      if (r === null) continue;
      // Skip ill-conditioned outliers
      if (r.conditionEstimate > 1e8) continue;
      const rel = r.bNorm > 0 ? r.residualNorm / r.bNorm : r.residualNorm;
      expect(rel).toBeLessThan(1e-10);
      succeeded++;
    }
    // We should have succeeded on most trials (non-singular, well-conditioned).
    expect(succeeded).toBeGreaterThan(20);
  });

  test("non-square A throws", () => {
    const A = matrixFromRows([[1, 2, 3], [4, 5, 6]]);
    expect(() => solve(A, new Float64Array([1, 2]))).toThrow(/square/);
  });

  test("dim mismatch throws", () => {
    const A = matIdentity(3);
    expect(() => solve(A, new Float64Array([1, 2]))).toThrow(/mismatch/);
  });

  test("growth factor reported on a constructed bad-pivoting case", () => {
    // The classic Wilkinson growth example. With partial pivoting,
    // growth on this matrix is 2^(n-1). For n = 5, growth = 16.
    const W = matrixFromRows([
      [ 1,  0,  0,  0,  1],
      [-1,  1,  0,  0,  1],
      [-1, -1,  1,  0,  1],
      [-1, -1, -1,  1,  1],
      [-1, -1, -1, -1,  1],
    ]);
    const b = new Float64Array([1, 1, 1, 1, 1]);
    const r = solve(W, b)!;
    expect(r.growthFactor).toBeGreaterThanOrEqual(15);
  });
});

// ── mutation hooks ─────────────────────────────────────────────────────────
//
// These describe perturbations that should *fail* the suite, and which
// test catches each one. Verified by hand-perturbing during development;
// preserved here so a future reader knows what the tests are testing for.
//
//   1. Skip pivoting (always use LU[k,k] regardless of magnitude):
//      → "LU pivots correctly when (0,0) is zero" fails (divide by 0)
//   2. Drop the L-storage line `a[offI + k] = m`:
//      → "LU on hand-computed 2x2" reconstruction fails
//   3. Swap forward-sub bounds (j ≤ i instead of j < i):
//      → "luSolve gives the hand-computed answer" fails
//   4. Drop iterative refinement (always set iterations = 0):
//      → no test fails (we only test residual quality, not iteration
//        count); this is honest — refinement is a quality bonus, not
//        a correctness condition. Documented in ADR-0014's
//        forcing-question #4.
//   5. Drop the absolute value in pivot search (use a[i,k] not |a[i,k]|):
//      → growth factor and round-trip tests fail on matrices with
//        negative pivots.
