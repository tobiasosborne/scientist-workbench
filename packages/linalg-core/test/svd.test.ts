// =============================================================================
// svd.test.ts — substrate tests for one-sided Jacobi SVD
// =============================================================================
//
// Exercises `svd(A, mode)` from packages/linalg-core/src/svd.ts against the
// same stress patterns the bench cares about, but at the library level
// (no JSON traffic). Tests are split into:
//
//   ── shape & basic algebra ──────────────────────────────────────────────
//     * 1×1, 2×1, 1×2, 2×2 zero — every shape edge the bench enumerates
//     * identity round-trip
//     * the bench's 5×3 standard case
//     * complete-mode shape contract for tall and fat matrices
//
//   ── reconstruction & orthogonality ─────────────────────────────────────
//     * random well-conditioned (m=n=10, multiple trials, seeded RNG)
//     * tall (m>n) and fat (m<n) rectangular cases
//     * Hilbert-8 and Hilbert-12 — extreme conditioning probes
//     * rank-1 outer product
//     * all-zero matrix
//
//   ── singular-value structure ───────────────────────────────────────────
//     * S non-negative descending
//     * S[0] is the spectral norm (matches ||A||_op for known cases)
//     * rank revealing on rank-1 outer product (one nonzero S, rest ~ε)
//     * rank revealing on identity-with-zero-column
//
//   ── self-reported errors ───────────────────────────────────────────────
//     * reconstructionError matches independent recomputation
//     * orthogonalityErrorU / orthogonalityErrorVt match recomputation
//     These are the *bench's* checks 7 and 8. If we drift here, the
//     bench will catch it; we catch it earlier in the substrate.
//
//   ── condition number / rank estimate ───────────────────────────────────
//     * condition_number ≈ S[0] / S[k-1] when nonzero
//     * condition_number is finite (capped at 1/EPS) for singular A
//     * rank_estimate matches LAPACK threshold for rank-deficient inputs
//
//   ── mutation hooks ─────────────────────────────────────────────────────
//     Documented at the bottom — perturbations a reviewer can apply
//     that should turn a test red.
//
// Tolerances: derived from Demmel-Veselić 1992 / Higham 2002 §20.3.
// Jacobi gives O(ε·m·n) backward reconstruction error and O(ε)
// orthogonality (independent of κ(A)). We pad with the same 100×
// safety factor the bench's verifier uses, so a suite that passes here
// is on the right side of the bench.

import { describe, expect, test } from "bun:test";
import {
  matrixFromRows,
  matIdentity,
  type Matrix,
  svd,
  svdJacobi,
  svdGolubReinsch,
} from "../src/index.js";

const EPS = Number.EPSILON;
const SAFETY = 100;

// -----------------------------------------------------------------------------
// Helpers — independent recomputation of the verifier's diagnostics.
// We deliberately re-implement these here (not reused from svd.ts) so a
// regression in svd.ts's self-report doesn't go undetected because the
// test was reading the same buggy formula.
// -----------------------------------------------------------------------------

function frobenius(data: Float64Array | readonly number[]): number {
  let s = 0;
  for (const x of data) s += x * x;
  return Math.sqrt(s);
}

function reconstructionError(
  U: Matrix,
  S: Float64Array,
  Vt: Matrix,
  A: Matrix,
): number {
  const m = U.rows;
  const n = Vt.cols;
  const k = S.length;
  let s = 0;
  for (let i = 0; i < m; i++) {
    for (let j = 0; j < n; j++) {
      let acc = 0;
      for (let p = 0; p < k; p++) {
        acc += U.data[i * U.cols + p]! * S[p]! * Vt.data[p * n + j]!;
      }
      const d = acc - A.data[i * n + j]!;
      s += d * d;
    }
  }
  return Math.sqrt(s) / Math.max(frobenius(A.data), 1);
}

function orthogonalityU(U: Matrix): number {
  const m = U.rows;
  const q = U.cols;
  let s = 0;
  for (let i = 0; i < q; i++) {
    for (let j = 0; j < q; j++) {
      let acc = 0;
      for (let r = 0; r < m; r++) {
        acc += U.data[r * q + i]! * U.data[r * q + j]!;
      }
      const d = acc - (i === j ? 1 : 0);
      s += d * d;
    }
  }
  return Math.sqrt(s);
}

function orthogonalityVt(Vt: Matrix): number {
  const q = Vt.rows;
  const n = Vt.cols;
  let s = 0;
  for (let i = 0; i < q; i++) {
    for (let j = 0; j < q; j++) {
      let acc = 0;
      for (let c = 0; c < n; c++) {
        acc += Vt.data[i * n + c]! * Vt.data[j * n + c]!;
      }
      const d = acc - (i === j ? 1 : 0);
      s += d * d;
    }
  }
  return Math.sqrt(s);
}

function reconTol(m: number, n: number): number {
  return SAFETY * EPS * Math.max(m, n) * Math.sqrt(Math.min(m, n));
}

function orthTol(m: number, q: number): number {
  return SAFETY * EPS * m * Math.sqrt(q);
}

// Seeded mulberry32 for reproducible random matrices.
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
  randomMatrix(rows: number, cols: number, lo = -1, hi = 1): Matrix {
    const r: number[][] = [];
    for (let i = 0; i < rows; i++) {
      const row: number[] = [];
      for (let j = 0; j < cols; j++) row.push(this.uniform(lo, hi));
      r.push(row);
    }
    return matrixFromRows(r);
  }
}

function hilbert(n: number): Matrix {
  const rows: number[][] = [];
  for (let i = 0; i < n; i++) {
    const r: number[] = [];
    for (let j = 0; j < n; j++) r.push(1 / (i + j + 1));
    rows.push(r);
  }
  return matrixFromRows(rows);
}

// ── shape edges ──────────────────────────────────────────────────────────────

describe("svd — shape edges", () => {
  test("1×1 reduced: A=[[3]] → U=±1, S=[3], Vt=±1", () => {
    const A = matrixFromRows([[3]]);
    const r = svd(A, "reduced");
    expect(r.U.rows).toBe(1);
    expect(r.U.cols).toBe(1);
    expect(r.S.length).toBe(1);
    expect(r.Vt.rows).toBe(1);
    expect(r.Vt.cols).toBe(1);
    expect(Math.abs(r.S[0]! - 3)).toBeLessThan(8 * EPS);
    expect(Math.abs(Math.abs(r.U.data[0]!) - 1)).toBeLessThan(8 * EPS);
    expect(Math.abs(Math.abs(r.Vt.data[0]!) - 1)).toBeLessThan(8 * EPS);
    // Reconstruction: U[0,0] · S[0] · Vt[0,0] = ±3
    expect(Math.abs(r.U.data[0]! * r.S[0]! * r.Vt.data[0]! - 3)).toBeLessThan(8 * EPS);
  });

  test("2×1 reduced: U is 2×1, S has length 1, Vt is 1×1", () => {
    const A = matrixFromRows([[1], [2]]);
    const r = svd(A, "reduced");
    expect(r.U.rows).toBe(2);
    expect(r.U.cols).toBe(1);
    expect(r.S.length).toBe(1);
    expect(r.Vt.rows).toBe(1);
    expect(r.Vt.cols).toBe(1);
    expect(Math.abs(r.S[0]! - Math.sqrt(5))).toBeLessThan(8 * EPS);
    expect(reconstructionError(r.U, r.S, r.Vt, A)).toBeLessThan(reconTol(2, 1));
  });

  test("1×2 reduced: m < n; U is 1×1, S has length 1, Vt is 1×2", () => {
    const A = matrixFromRows([[1, 2]]);
    const r = svd(A, "reduced");
    expect(r.U.rows).toBe(1);
    expect(r.U.cols).toBe(1);
    expect(r.S.length).toBe(1);
    expect(r.Vt.rows).toBe(1);
    expect(r.Vt.cols).toBe(2);
    expect(Math.abs(r.S[0]! - Math.sqrt(5))).toBeLessThan(8 * EPS);
    expect(reconstructionError(r.U, r.S, r.Vt, A)).toBeLessThan(reconTol(1, 2));
  });

  test("2×2 zero: S=[0,0], U/Vt are some orthonormal basis", () => {
    const A = matrixFromRows([[0, 0], [0, 0]]);
    const r = svd(A, "reduced");
    for (const x of r.S) expect(x).toBe(0);
    expect(orthogonalityU(r.U)).toBeLessThan(orthTol(2, 2));
    expect(orthogonalityVt(r.Vt)).toBeLessThan(orthTol(2, 2));
    expect(reconstructionError(r.U, r.S, r.Vt, A)).toBeLessThan(reconTol(2, 2));
  });

  test("identity 5×5: S = [1,1,1,1,1]", () => {
    const A = matIdentity(5);
    const r = svd(A, "reduced");
    for (const sigma of r.S) {
      expect(Math.abs(sigma - 1)).toBeLessThan(SAFETY * EPS);
    }
    expect(orthogonalityU(r.U)).toBeLessThan(orthTol(5, 5));
    expect(orthogonalityVt(r.Vt)).toBeLessThan(orthTol(5, 5));
    expect(reconstructionError(r.U, r.S, r.Vt, A)).toBeLessThan(reconTol(5, 5));
  });

  test("5×3 simple: standard tall case mirrors bench A_5x3", () => {
    const A = matrixFromRows([
      [1, 2, 3],
      [4, 5, 6],
      [7, 8, 10],
      [1, 0, 1],
      [0, 1, 0],
    ]);
    const r = svd(A, "reduced");
    expect(r.U.rows).toBe(5);
    expect(r.U.cols).toBe(3);
    expect(r.S.length).toBe(3);
    expect(r.Vt.rows).toBe(3);
    expect(r.Vt.cols).toBe(3);
    expect(orthogonalityU(r.U)).toBeLessThan(orthTol(5, 3));
    expect(orthogonalityVt(r.Vt)).toBeLessThan(orthTol(3, 3));
    expect(reconstructionError(r.U, r.S, r.Vt, A)).toBeLessThan(reconTol(5, 3));
  });

  test("3×5 simple: standard fat case mirrors bench A_3x5", () => {
    const A = matrixFromRows([
      [1, 2, 3, 4, 5],
      [2, 1, 0, -1, 1],
      [3, 0, -1, 2, 1],
    ]);
    const r = svd(A, "reduced");
    expect(r.U.rows).toBe(3);
    expect(r.U.cols).toBe(3);
    expect(r.S.length).toBe(3);
    expect(r.Vt.rows).toBe(3);
    expect(r.Vt.cols).toBe(5);
    expect(orthogonalityU(r.U)).toBeLessThan(orthTol(3, 3));
    expect(orthogonalityVt(r.Vt)).toBeLessThan(orthTol(3, 3));
    expect(reconstructionError(r.U, r.S, r.Vt, A)).toBeLessThan(reconTol(3, 5));
  });
});

// ── complete-mode contract ──────────────────────────────────────────────────

describe("svd — complete mode", () => {
  test("complete on 5×3: U is 5×5, S has length 3, Vt is 3×3", () => {
    const A = matrixFromRows([
      [1, 2, 3],
      [4, 5, 6],
      [7, 8, 10],
      [1, 0, 1],
      [0, 1, 0],
    ]);
    const r = svd(A, "complete");
    expect(r.mode).toBe("complete");
    expect(r.U.rows).toBe(5);
    expect(r.U.cols).toBe(5);
    expect(r.S.length).toBe(3);
    expect(r.Vt.rows).toBe(3);
    expect(r.Vt.cols).toBe(3);
    expect(orthogonalityU(r.U)).toBeLessThan(orthTol(5, 5));
    expect(orthogonalityVt(r.Vt)).toBeLessThan(orthTol(3, 3));
    expect(reconstructionError(r.U, r.S, r.Vt, A)).toBeLessThan(reconTol(5, 3));
  });

  test("complete on 3×5: U is 3×3, S has length 3, Vt is 5×5", () => {
    const A = matrixFromRows([
      [1, 2, 3, 4, 5],
      [2, 1, 0, -1, 1],
      [3, 0, -1, 2, 1],
    ]);
    const r = svd(A, "complete");
    expect(r.U.rows).toBe(3);
    expect(r.U.cols).toBe(3);
    expect(r.S.length).toBe(3);
    expect(r.Vt.rows).toBe(5);
    expect(r.Vt.cols).toBe(5);
    expect(orthogonalityU(r.U)).toBeLessThan(orthTol(3, 3));
    expect(orthogonalityVt(r.Vt)).toBeLessThan(orthTol(5, 5));
    expect(reconstructionError(r.U, r.S, r.Vt, A)).toBeLessThan(reconTol(3, 5));
  });
});

// ── reconstruction & orthogonality on harder inputs ─────────────────────────

describe("svd — random well-conditioned", () => {
  test("20 random 10×10 matrices: reconstruction & orthogonality within tolerance", () => {
    const rng = new RNG(20260505);
    for (let trial = 0; trial < 20; trial++) {
      const A = rng.randomMatrix(10, 10);
      const r = svd(A, "reduced");
      expect(reconstructionError(r.U, r.S, r.Vt, A)).toBeLessThan(reconTol(10, 10));
      expect(orthogonalityU(r.U)).toBeLessThan(orthTol(10, 10));
      expect(orthogonalityVt(r.Vt)).toBeLessThan(orthTol(10, 10));
    }
  });

  test("tall 50×3 random: orthogonality stays at machine epsilon", () => {
    const rng = new RNG(1234);
    const A = rng.randomMatrix(50, 3);
    const r = svd(A, "reduced");
    expect(reconstructionError(r.U, r.S, r.Vt, A)).toBeLessThan(reconTol(50, 3));
    expect(orthogonalityU(r.U)).toBeLessThan(orthTol(50, 3));
    expect(orthogonalityVt(r.Vt)).toBeLessThan(orthTol(3, 3));
  });

  test("fat 3×50 random: m < n shape contract", () => {
    const rng = new RNG(5678);
    const A = rng.randomMatrix(3, 50);
    const r = svd(A, "reduced");
    expect(r.U.rows).toBe(3);
    expect(r.U.cols).toBe(3);
    expect(r.S.length).toBe(3);
    expect(r.Vt.rows).toBe(3);
    expect(r.Vt.cols).toBe(50);
    expect(reconstructionError(r.U, r.S, r.Vt, A)).toBeLessThan(reconTol(3, 50));
    expect(orthogonalityU(r.U)).toBeLessThan(orthTol(3, 3));
    expect(orthogonalityVt(r.Vt)).toBeLessThan(orthTol(3, 3));
  });
});

// ── ill-conditioned: the Jacobi accuracy advertisement ──────────────────────

describe("svd — Hilbert (the discriminator)", () => {
  test("Hilbert-8 (κ ≈ 1.5e10): orthogonality stays at O(ε), independent of κ", () => {
    const A = hilbert(8);
    const r = svd(A, "reduced");
    expect(orthogonalityU(r.U)).toBeLessThan(orthTol(8, 8));
    expect(orthogonalityVt(r.Vt)).toBeLessThan(orthTol(8, 8));
    expect(reconstructionError(r.U, r.S, r.Vt, A)).toBeLessThan(reconTol(8, 8));
    // Singular values are non-increasing.
    for (let i = 0; i + 1 < r.S.length; i++) {
      expect(r.S[i]).toBeGreaterThanOrEqual(r.S[i + 1]! - 100 * EPS * r.S[0]!);
    }
  });

  test("Hilbert-12 (κ ≈ 1e16): even at extreme κ, Jacobi converges with bounded errors", () => {
    const A = hilbert(12);
    const r = svd(A, "reduced");
    expect(orthogonalityU(r.U)).toBeLessThan(orthTol(12, 12));
    expect(orthogonalityVt(r.Vt)).toBeLessThan(orthTol(12, 12));
    expect(reconstructionError(r.U, r.S, r.Vt, A)).toBeLessThan(reconTol(12, 12));
  });
});

// ── rank-deficient inputs: SVD reveals rank ─────────────────────────────────

describe("svd — rank-deficient inputs", () => {
  test("rank-1 outer product u·vᵀ: exactly one nonzero singular value", () => {
    // u = [1, 2, 3, 4]ᵀ, v = [1, -1, 2]ᵀ → A = u·vᵀ has rank 1.
    const u = [1, 2, 3, 4];
    const v = [1, -1, 2];
    const rows = u.map((ui) => v.map((vj) => ui * vj));
    const A = matrixFromRows(rows);
    const r = svd(A, "reduced");
    expect(reconstructionError(r.U, r.S, r.Vt, A)).toBeLessThan(reconTol(4, 3));
    expect(orthogonalityU(r.U)).toBeLessThan(orthTol(4, 3));
    expect(orthogonalityVt(r.Vt)).toBeLessThan(orthTol(3, 3));
    // S[0] is large (the nonzero singular value), S[1], S[2] are noise.
    expect(r.S[0]).toBeGreaterThan(1);
    const noiseFloor = SAFETY * EPS * r.S[0]!;
    expect(r.S[1]).toBeLessThan(noiseFloor);
    expect(r.S[2]).toBeLessThan(noiseFloor);
    // Rank estimate is 1.
    expect(r.rankEstimate).toBe(1);
  });

  test("identity with a zero column: rank = n−1, S[n−1] = 0", () => {
    const A = matrixFromRows([
      [1, 0, 0, 0, 0],
      [0, 1, 0, 0, 0],
      [0, 0, 0, 0, 0], // zero column at j=2 (and zero row, since this is identity-like)
      [0, 0, 0, 1, 0],
      [0, 0, 0, 0, 1],
    ]);
    const r = svd(A, "reduced");
    expect(orthogonalityU(r.U)).toBeLessThan(orthTol(5, 5));
    expect(orthogonalityVt(r.Vt)).toBeLessThan(orthTol(5, 5));
    expect(reconstructionError(r.U, r.S, r.Vt, A)).toBeLessThan(reconTol(5, 5));
    expect(r.rankEstimate).toBe(4);
    // The smallest singular value is exactly zero (or below noise floor).
    expect(r.S[4]).toBeLessThan(SAFETY * EPS);
  });

  test("all-zero 3×3: rank = 0, S = [0,0,0]", () => {
    const A = matrixFromRows([[0, 0, 0], [0, 0, 0], [0, 0, 0]]);
    const r = svd(A, "reduced");
    for (const x of r.S) expect(x).toBe(0);
    expect(orthogonalityU(r.U)).toBeLessThan(orthTol(3, 3));
    expect(orthogonalityVt(r.Vt)).toBeLessThan(orthTol(3, 3));
    expect(r.rankEstimate).toBe(0);
  });
});

// ── self-reported errors — the agent-honest contract ───────────────────────

describe("svd — self-reported errors are honest", () => {
  test("reconstructionError matches independent recomputation (5×3)", () => {
    const A = matrixFromRows([
      [1, 2, 3],
      [4, 5, 6],
      [7, 8, 10],
      [1, 0, 1],
      [0, 1, 0],
    ]);
    const r = svd(A, "reduced");
    const recomputed = reconstructionError(r.U, r.S, r.Vt, A);
    expect(Math.abs(r.reconstructionError - recomputed)).toBeLessThan(
      1e-12 * Math.max(recomputed, EPS),
    );
  });

  test("orthogonalityErrorU matches independent recomputation (Hilbert-8)", () => {
    const A = hilbert(8);
    const r = svd(A, "reduced");
    const recomputed = orthogonalityU(r.U);
    expect(Math.abs(r.orthogonalityErrorU - recomputed)).toBeLessThan(
      1e-12 * Math.max(recomputed, EPS),
    );
  });

  test("orthogonalityErrorVt matches independent recomputation (Hilbert-8)", () => {
    const A = hilbert(8);
    const r = svd(A, "reduced");
    const recomputed = orthogonalityVt(r.Vt);
    expect(Math.abs(r.orthogonalityErrorVt - recomputed)).toBeLessThan(
      1e-12 * Math.max(recomputed, EPS),
    );
  });

  test("on the all-zero matrix, both reconstruction and orthogonality are near zero", () => {
    const A = matrixFromRows([[0, 0, 0], [0, 0, 0], [0, 0, 0]]);
    const r = svd(A, "reduced");
    expect(r.reconstructionError).toBeLessThan(SAFETY * EPS);
    expect(r.orthogonalityErrorU).toBeLessThan(orthTol(3, 3));
    expect(r.orthogonalityErrorVt).toBeLessThan(orthTol(3, 3));
  });
});

// ── condition number / rank estimate ────────────────────────────────────────

describe("svd — diagnostics", () => {
  test("S is non-negative and non-increasing across all test matrices", () => {
    const cases: Matrix[] = [
      matrixFromRows([[1, 2, 3], [4, 5, 6], [7, 8, 10]]),
      hilbert(6),
      matrixFromRows([[1, 0], [0, 0.0001]]),
    ];
    for (const A of cases) {
      const r = svd(A, "reduced");
      for (let i = 0; i < r.S.length; i++) {
        expect(r.S[i]).toBeGreaterThanOrEqual(-100 * EPS * r.S[0]!);
      }
      for (let i = 0; i + 1 < r.S.length; i++) {
        expect(r.S[i]! + 100 * EPS * r.S[0]!).toBeGreaterThanOrEqual(r.S[i + 1]!);
      }
    }
  });

  test("conditionNumber equals S[0]/S[k-1] for well-conditioned matrices", () => {
    const A = matIdentity(4);
    const r = svd(A, "reduced");
    expect(Math.abs(r.conditionNumber - 1)).toBeLessThan(100 * EPS);
  });

  test("conditionNumber is finite and bounded for singular matrices", () => {
    const A = matrixFromRows([[1, 2, 3], [2, 4, 6], [1, 1, 1]]); // rows 0 and 1 collinear
    const r = svd(A, "reduced");
    expect(Number.isFinite(r.conditionNumber)).toBe(true);
    expect(r.conditionNumber).toBeGreaterThanOrEqual(0);
    // At most 1/EPS (the cap).
    expect(r.conditionNumber).toBeLessThanOrEqual(1 / EPS + 1);
  });

  test("rankEstimate counts singular values above LAPACK threshold", () => {
    // Diagonal matrix with known rank-3 structure.
    const A = matrixFromRows([
      [10, 0, 0, 0],
      [0, 5, 0, 0],
      [0, 0, 1, 0],
      [0, 0, 0, 1e-15], // below threshold (max(m,n)·EPS·S[0] = 4·2.22e-16·10 ≈ 9e-15)
    ]);
    const r = svd(A, "reduced");
    expect(r.rankEstimate).toBe(3);
  });
});

// ── mutation hooks ─────────────────────────────────────────────────────────
//
// Perturbations a reviewer can apply to svd.ts; each comment names the
// test that would turn red. Verified by hand during development.
//
//   1. Skip the descending sort of singular values:
//        → "S is non-negative and non-increasing across all test matrices"
//      becomes red because Jacobi's natural ordering of singular values
//      is whatever the sweep happens to converge to, not descending.
//
//   2. Drop the m<n transpose branch (work directly on the m<n matrix):
//        → "3×5 simple" reconstruction fails — Jacobi sweeps need at
//      least as many rows as columns; n>m violates the algorithm's
//      precondition.
//
//   3. Skip Gram-Schmidt completion of zero columns of U:
//        → "rank-1 outer product u·vᵀ" orthogonality fails — the U-columns
//      corresponding to the zero singular values stay at zero, so UᵀU
//      is missing those identity-block entries.
//
//   4. Compute reconstructionError on intermediate state (before U/V
//      permutation):
//        → "reconstructionError matches independent recomputation"
//      fails — the self-report drifts from what the verifier sees.
//
//   5. Use a smaller MAX_SWEEPS (say 5) so Hilbert-8 doesn't fully
//      converge:
//        → "Hilbert-8 (κ ≈ 1.5e10): orthogonality stays at O(ε)" fails
//      because the off-diagonal mass is still above ε.

// ============================================================================
// Golub-Reinsch path — Householder bidiagonalisation + Demmel-Kahan QR
// ============================================================================
//
// The second backend in `svd.ts`. Same backward-stability bounds as
// Jacobi, asymptotically faster (O(n³) vs O(n³ log² n)), but loses
// Jacobi's small-σ relative-accuracy guarantee. The bench's tolerances
// are scaled by ‖A‖, so both pass; the test suite below pins
// invariants the bench cares about plus a cross-algorithm agreement
// check that catches drift between the two implementations.
//
// Tolerances follow Demmel-Kahan 1990 §6 (backward-error) and Higham
// 2002 §20.3 (Frobenius bounds). For ill-conditioned matrices we
// allow looser absolute tolerance on individual singular values
// (forward error scaled by ‖A‖, not σ) — the documented difference
// between Golub-Reinsch and Jacobi.

describe("svdGolubReinsch — shape edges", () => {
  test("1×1 reduced: trivial case", () => {
    const A = matrixFromRows([[3]]);
    const r = svdGolubReinsch(A, "reduced");
    expect(r.method).toBe("golub-reinsch");
    expect(r.U.rows).toBe(1);
    expect(r.U.cols).toBe(1);
    expect(r.S.length).toBe(1);
    expect(Math.abs(r.S[0]! - 3)).toBeLessThan(8 * EPS);
    expect(reconstructionError(r.U, r.S, r.Vt, A)).toBeLessThan(reconTol(1, 1));
  });

  test("2×1 reduced: tall column vector", () => {
    const A = matrixFromRows([[1], [2]]);
    const r = svdGolubReinsch(A, "reduced");
    expect(r.U.rows).toBe(2);
    expect(r.U.cols).toBe(1);
    expect(r.S.length).toBe(1);
    expect(r.Vt.rows).toBe(1);
    expect(r.Vt.cols).toBe(1);
    expect(Math.abs(r.S[0]! - Math.sqrt(5))).toBeLessThan(8 * EPS);
    expect(reconstructionError(r.U, r.S, r.Vt, A)).toBeLessThan(reconTol(2, 1));
  });

  test("1×2 reduced: m < n triggers internal transpose", () => {
    const A = matrixFromRows([[1, 2]]);
    const r = svdGolubReinsch(A, "reduced");
    expect(r.U.rows).toBe(1);
    expect(r.U.cols).toBe(1);
    expect(r.S.length).toBe(1);
    expect(r.Vt.rows).toBe(1);
    expect(r.Vt.cols).toBe(2);
    expect(Math.abs(r.S[0]! - Math.sqrt(5))).toBeLessThan(8 * EPS);
    expect(reconstructionError(r.U, r.S, r.Vt, A)).toBeLessThan(reconTol(1, 2));
  });

  test("identity 5×5: S = [1,1,1,1,1]; bidiagonalisation is trivial", () => {
    const A = matIdentity(5);
    const r = svdGolubReinsch(A, "reduced");
    for (const sigma of r.S) expect(Math.abs(sigma - 1)).toBeLessThan(SAFETY * EPS);
    expect(orthogonalityU(r.U)).toBeLessThan(orthTol(5, 5));
    expect(orthogonalityVt(r.Vt)).toBeLessThan(orthTol(5, 5));
    expect(reconstructionError(r.U, r.S, r.Vt, A)).toBeLessThan(reconTol(5, 5));
  });

  test("5×3 standard tall case: U is 5×3, Vt is 3×3", () => {
    const A = matrixFromRows([
      [1, 2, 3],
      [4, 5, 6],
      [7, 8, 10],
      [1, 0, 1],
      [0, 1, 0],
    ]);
    const r = svdGolubReinsch(A, "reduced");
    expect(r.U.rows).toBe(5);
    expect(r.U.cols).toBe(3);
    expect(r.Vt.rows).toBe(3);
    expect(r.Vt.cols).toBe(3);
    expect(orthogonalityU(r.U)).toBeLessThan(orthTol(5, 3));
    expect(orthogonalityVt(r.Vt)).toBeLessThan(orthTol(3, 3));
    expect(reconstructionError(r.U, r.S, r.Vt, A)).toBeLessThan(reconTol(5, 3));
  });

  test("3×5 fat case: triggers internal transpose, U is 3×3, Vt is 3×5", () => {
    const A = matrixFromRows([
      [1, 2, 3, 4, 5],
      [2, 1, 0, -1, 1],
      [3, 0, -1, 2, 1],
    ]);
    const r = svdGolubReinsch(A, "reduced");
    expect(r.U.rows).toBe(3);
    expect(r.U.cols).toBe(3);
    expect(r.Vt.rows).toBe(3);
    expect(r.Vt.cols).toBe(5);
    expect(orthogonalityU(r.U)).toBeLessThan(orthTol(3, 3));
    expect(orthogonalityVt(r.Vt)).toBeLessThan(orthTol(3, 3));
    expect(reconstructionError(r.U, r.S, r.Vt, A)).toBeLessThan(reconTol(3, 5));
  });

  test("complete-mode 5×3: U expands to 5×5, Vt stays 3×3", () => {
    const A = matrixFromRows([
      [1, 2, 3],
      [4, 5, 6],
      [7, 8, 10],
      [1, 0, 1],
      [0, 1, 0],
    ]);
    const r = svdGolubReinsch(A, "complete");
    expect(r.mode).toBe("complete");
    expect(r.U.rows).toBe(5);
    expect(r.U.cols).toBe(5);
    expect(r.S.length).toBe(3);
    expect(r.Vt.rows).toBe(3);
    expect(r.Vt.cols).toBe(3);
    expect(orthogonalityU(r.U)).toBeLessThan(orthTol(5, 5));
    expect(orthogonalityVt(r.Vt)).toBeLessThan(orthTol(3, 3));
    expect(reconstructionError(r.U, r.S, r.Vt, A)).toBeLessThan(reconTol(5, 3));
  });
});

describe("svdGolubReinsch — well-conditioned and Hilbert", () => {
  test("20 random 10×10 matrices: backward-stable on every trial", () => {
    const rng = new RNG(20260601);
    for (let trial = 0; trial < 20; trial++) {
      const A = rng.randomMatrix(10, 10);
      const r = svdGolubReinsch(A, "reduced");
      expect(reconstructionError(r.U, r.S, r.Vt, A)).toBeLessThan(reconTol(10, 10));
      expect(orthogonalityU(r.U)).toBeLessThan(orthTol(10, 10));
      expect(orthogonalityVt(r.Vt)).toBeLessThan(orthTol(10, 10));
    }
  });

  test("Hilbert-8 (κ ≈ 1.5e10): orthogonality and reconstruction at O(ε)", () => {
    const A = hilbert(8);
    const r = svdGolubReinsch(A, "reduced");
    expect(orthogonalityU(r.U)).toBeLessThan(orthTol(8, 8));
    expect(orthogonalityVt(r.Vt)).toBeLessThan(orthTol(8, 8));
    expect(reconstructionError(r.U, r.S, r.Vt, A)).toBeLessThan(reconTol(8, 8));
  });

  test("Hilbert-12 (κ ≈ 1.6e16): reconstruction within bench tolerance", () => {
    // At Hilbert-12, the smallest singular value is ~1e-16 (≈ ε itself).
    // Both algorithms achieve O(ε) on the orthogonality and Frobenius
    // residual; Jacobi additionally promises high relative accuracy on
    // S[k-1], Golub-Reinsch does not. The bench's tolerance is scaled
    // by ‖A‖, not by the smallest σ, so both pass.
    const A = hilbert(12);
    const r = svdGolubReinsch(A, "reduced");
    expect(orthogonalityU(r.U)).toBeLessThan(orthTol(12, 12));
    expect(orthogonalityVt(r.Vt)).toBeLessThan(orthTol(12, 12));
    expect(reconstructionError(r.U, r.S, r.Vt, A)).toBeLessThan(reconTol(12, 12));
  });
});

describe("svdGolubReinsch — rank-deficient", () => {
  test("rank-1 outer product u·vᵀ: exactly one nonzero singular value", () => {
    const u = [1, 2, 3, 4];
    const v = [1, -1, 2];
    const rows = u.map((ui) => v.map((vj) => ui * vj));
    const A = matrixFromRows(rows);
    const r = svdGolubReinsch(A, "reduced");
    expect(reconstructionError(r.U, r.S, r.Vt, A)).toBeLessThan(reconTol(4, 3));
    expect(orthogonalityU(r.U)).toBeLessThan(orthTol(4, 3));
    expect(orthogonalityVt(r.Vt)).toBeLessThan(orthTol(3, 3));
    expect(r.S[0]!).toBeGreaterThan(1);
    const noiseFloor = SAFETY * EPS * r.S[0]!;
    expect(r.S[1]!).toBeLessThan(noiseFloor);
    expect(r.S[2]!).toBeLessThan(noiseFloor);
    expect(r.rankEstimate).toBe(1);
  });

  test("identity with zero column: rank = n−1, S[n−1] = 0", () => {
    const A = matrixFromRows([
      [1, 0, 0, 0, 0],
      [0, 1, 0, 0, 0],
      [0, 0, 0, 0, 0],
      [0, 0, 0, 1, 0],
      [0, 0, 0, 0, 1],
    ]);
    const r = svdGolubReinsch(A, "reduced");
    expect(orthogonalityU(r.U)).toBeLessThan(orthTol(5, 5));
    expect(orthogonalityVt(r.Vt)).toBeLessThan(orthTol(5, 5));
    expect(reconstructionError(r.U, r.S, r.Vt, A)).toBeLessThan(reconTol(5, 5));
    expect(r.rankEstimate).toBe(4);
    expect(r.S[4]!).toBeLessThan(SAFETY * EPS);
  });

  test("all-zero 4×4: S = [0,0,0,0], rank = 0", () => {
    const A = matrixFromRows([[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]]);
    const r = svdGolubReinsch(A, "reduced");
    for (const x of r.S) expect(x).toBe(0);
    expect(orthogonalityU(r.U)).toBeLessThan(orthTol(4, 4));
    expect(orthogonalityVt(r.Vt)).toBeLessThan(orthTol(4, 4));
    expect(r.rankEstimate).toBe(0);
  });
});

describe("svdGolubReinsch — diagnostics and self-report", () => {
  test("S non-negative descending; condition_number = S[0]/S[k-1]", () => {
    const A = matrixFromRows([[1, 2, 3], [4, 5, 6], [7, 8, 10]]);
    const r = svdGolubReinsch(A, "reduced");
    for (let i = 0; i < r.S.length; i++) {
      expect(r.S[i]!).toBeGreaterThanOrEqual(-100 * EPS * r.S[0]!);
    }
    for (let i = 0; i + 1 < r.S.length; i++) {
      expect(r.S[i]! + 100 * EPS * r.S[0]!).toBeGreaterThanOrEqual(r.S[i + 1]!);
    }
    expect(Math.abs(r.conditionNumber - r.S[0]! / r.S[r.S.length - 1]!)).toBeLessThan(
      1e-10 * r.conditionNumber,
    );
  });

  test("self-reported reconstruction matches independent recomputation", () => {
    const A = matrixFromRows([
      [1, 2, 3],
      [4, 5, 6],
      [7, 8, 10],
      [1, 0, 1],
      [0, 1, 0],
    ]);
    const r = svdGolubReinsch(A, "reduced");
    const recomputed = reconstructionError(r.U, r.S, r.Vt, A);
    expect(Math.abs(r.reconstructionError - recomputed)).toBeLessThan(
      1e-12 * Math.max(recomputed, EPS),
    );
  });

  test("self-reported orthogonality (U and Vt) matches recomputation", () => {
    const A = hilbert(8);
    const r = svdGolubReinsch(A, "reduced");
    const recU = orthogonalityU(r.U);
    const recVt = orthogonalityVt(r.Vt);
    expect(Math.abs(r.orthogonalityErrorU - recU)).toBeLessThan(
      1e-12 * Math.max(recU, EPS),
    );
    expect(Math.abs(r.orthogonalityErrorVt - recVt)).toBeLessThan(
      1e-12 * Math.max(recVt, EPS),
    );
  });
});

describe("svdGolubReinsch — large n (the cap-lift demonstration)", () => {
  test("100×100 random: backward-stable, fast", () => {
    const rng = new RNG(20260602);
    const A = rng.randomMatrix(100, 100);
    const r = svdGolubReinsch(A, "reduced");
    expect(reconstructionError(r.U, r.S, r.Vt, A)).toBeLessThan(reconTol(100, 100));
    expect(orthogonalityU(r.U)).toBeLessThan(orthTol(100, 100));
    expect(orthogonalityVt(r.Vt)).toBeLessThan(orthTol(100, 100));
  });

  test("200×200 identity: every σ equals 1 within ε", () => {
    const A = matIdentity(200);
    const r = svdGolubReinsch(A, "reduced");
    for (const s of r.S) {
      expect(Math.abs(s - 1)).toBeLessThan(SAFETY * EPS);
    }
    expect(reconstructionError(r.U, r.S, r.Vt, A)).toBeLessThan(reconTol(200, 200));
    expect(orthogonalityU(r.U)).toBeLessThan(orthTol(200, 200));
  });
});

// ── dispatch & cross-algorithm agreement ───────────────────────────────────

describe("svd — algorithm dispatch", () => {
  test("default algorithm 'auto' picks Jacobi at small n (≤ 500)", () => {
    const A = matrixFromRows([[1, 2, 3], [4, 5, 6], [7, 8, 10]]);
    const r = svd(A, "reduced");
    expect(r.method).toBe("one-sided-jacobi");
  });

  test("explicit 'jacobi' forces Jacobi regardless of size", () => {
    const A = matrixFromRows([[1, 2, 3], [4, 5, 6], [7, 8, 10]]);
    const r = svd(A, "reduced", { algorithm: "jacobi" });
    expect(r.method).toBe("one-sided-jacobi");
  });

  test("explicit 'golub-reinsch' forces Golub-Reinsch regardless of size", () => {
    const A = matrixFromRows([[1, 2, 3], [4, 5, 6], [7, 8, 10]]);
    const r = svd(A, "reduced", { algorithm: "golub-reinsch" });
    expect(r.method).toBe("golub-reinsch");
  });

  test("two algorithms agree on a moderately conditioned 30×30 matrix", () => {
    // Singular values are unique; reconstruction is unique; the
    // factors are unique up to sign/rotation in repeated-σ subspaces.
    // For a generic random matrix all σ are distinct, so we can pin
    // the singular values to high relative agreement.
    const rng = new RNG(20260603);
    const A = rng.randomMatrix(30, 30);
    const rJ = svd(A, "reduced", { algorithm: "jacobi" });
    const rGR = svd(A, "reduced", { algorithm: "golub-reinsch" });
    expect(rJ.S.length).toBe(rGR.S.length);
    for (let i = 0; i < rJ.S.length; i++) {
      // Both algorithms achieve forward error scaled by ‖A‖ on every
      // singular value. ‖A‖ ≈ rJ.S[0] ≈ a few; we allow 1e-10 relative
      // (well above either's actual ~ε precision).
      const rel = Math.abs(rJ.S[i]! - rGR.S[i]!) / Math.max(rJ.S[i]!, EPS);
      expect(rel).toBeLessThan(1e-10);
    }
  });

  test("two algorithms agree on the bench's 5×3 standard case", () => {
    const A = matrixFromRows([
      [1, 2, 3],
      [4, 5, 6],
      [7, 8, 10],
      [1, 0, 1],
      [0, 1, 0],
    ]);
    const rJ = svd(A, "reduced", { algorithm: "jacobi" });
    const rGR = svd(A, "reduced", { algorithm: "golub-reinsch" });
    for (let i = 0; i < rJ.S.length; i++) {
      const rel = Math.abs(rJ.S[i]! - rGR.S[i]!) / Math.max(rJ.S[i]!, EPS);
      expect(rel).toBeLessThan(1e-10);
    }
    // Both reconstruct the same matrix to within tolerance.
    expect(rJ.reconstructionError).toBeLessThan(reconTol(5, 3));
    expect(rGR.reconstructionError).toBeLessThan(reconTol(5, 3));
  });
});

// ── Aliasing mutation hooks for Golub-Reinsch ──────────────────────────────
//
//   1. Skip the negative-σ flip in stage 3:
//        → "rank-1 outer product u·vᵀ" rank-estimate fails — some σ
//      may be returned negative, breaking the descending sort.
//
//   2. Drop the m < n internal transpose:
//        → "3×5 fat case" reconstruction fails — bidiagonalisation
//      requires mw ≥ nw.
//
//   3. Use a constant Wilkinson shift (forget the sign convention):
//        → "Hilbert-8" reconstruction fails — the sweep converges to
//      a wrong eigenvalue of BᵀB, accumulated error blows up.
//
//   4. Skip the cancelZeroAlpha refinement:
//        → "rank-1 outer product" hangs (or hits MAX_QR_ITERATIONS) —
//      the deflation logic can't isolate a guaranteed-zero σ when an
//      α[i] becomes zero mid-sweep.
