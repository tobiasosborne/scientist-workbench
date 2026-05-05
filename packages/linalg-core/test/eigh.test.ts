// =============================================================================
// eigh.test.ts — substrate tests for cyclic-Jacobi symmetric eigh
// =============================================================================
//
// Exercises `eigh(A)` from packages/linalg-core/src/eigh.ts against the
// same stress patterns the bench cares about, but at the library level
// (no JSON traffic). Tests are split into:
//
//   ── shape & basic algebra ──────────────────────────────────────────────
//     * 1×1, 2×2 zero, 2×2 identity, 5×5 identity — shape edges
//     * diagonal A: eigenvalues are the diagonal entries (sorted)
//
//   ── reconstruction & orthogonality ─────────────────────────────────────
//     * random symmetric (n=5, 10, 20, 50) — multiple trials with seeded RNG
//     * Hilbert-8 and Hilbert-12 — extreme conditioning probes; for symmetric
//       SPD A, Jacobi achieves O(ε) orthogonality independent of κ(A)
//     * rank-deficient (rank-1 outer u·uᵀ): one nonzero eigenvalue, rest ε
//     * all-zero matrix: λ = [0,…,0], Q orthonormal
//
//   ── eigenvalue structure ───────────────────────────────────────────────
//     * eigenvalues are sorted ascending (numpy convention)
//     * repeated eigenvalues: residual stays small even though Q's columns
//       within the eigenspace are non-unique
//     * near-degenerate eigenvalues: still ascending
//
//   ── self-reported errors ───────────────────────────────────────────────
//     * reconstructionError matches independent recomputation
//     * orthogonalityError matches independent recomputation
//     These are the *bench's* checks 6 and 7. If we drift here the bench
//     catches it; we catch it earlier in the substrate.
//
//   ── condition number ──────────────────────────────────────────────────
//     * conditionNumber ≈ |λ_max| / |λ_min| for SPD A
//     * conditionNumber is finite (capped at 1/EPS) for singular A
//     * conditionNumber is 0 for the all-zero matrix
//
//   ── mutation hooks ─────────────────────────────────────────────────────
//     Documented at the bottom — perturbations a reviewer can apply that
//     should turn a test red.
//
// Tolerances: derived from Wilkinson 1965 / Higham 2002 §20.6.
// Symmetric Jacobi gives O(ε·n·√n) orthogonality and reconstruction
// (independent of κ(A)). We pad with the same 100× safety factor the
// bench's verifier uses, so a suite that passes here is on the right
// side of the bench.

import { describe, expect, test } from "bun:test";
import {
  matrixFromRows,
  matIdentity,
  type Matrix,
  eigh,
} from "../src/index.js";

const EPS = Number.EPSILON;
const SAFETY = 100;

// -----------------------------------------------------------------------------
// Helpers — independent recomputation of the verifier's diagnostics.
// We deliberately re-implement these here (not reused from eigh.ts) so a
// regression in eigh.ts's self-report doesn't go undetected because the
// test was reading the same buggy formula.
// -----------------------------------------------------------------------------

function frobenius(data: Float64Array | readonly number[]): number {
  let s = 0;
  for (const x of data) s += x * x;
  return Math.sqrt(s);
}

function reconstructionError(A: Matrix, Q: Matrix, lam: Float64Array): number {
  const n = A.rows;
  let s = 0;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      let aq = 0;
      for (let p = 0; p < n; p++) {
        aq += A.data[i * n + p]! * Q.data[p * n + j]!;
      }
      const qd = Q.data[i * n + j]! * lam[j]!;
      const d = aq - qd;
      s += d * d;
    }
  }
  return Math.sqrt(s) / Math.max(frobenius(A.data), 1);
}

function orthogonalityError(Q: Matrix): number {
  const n = Q.rows;
  const k = Q.cols;
  let s = 0;
  for (let i = 0; i < k; i++) {
    for (let j = 0; j < k; j++) {
      let acc = 0;
      for (let r = 0; r < n; r++) {
        acc += Q.data[r * k + i]! * Q.data[r * k + j]!;
      }
      const d = acc - (i === j ? 1 : 0);
      s += d * d;
    }
  }
  return Math.sqrt(s);
}

function reconTol(n: number): number {
  return SAFETY * EPS * n * Math.sqrt(n);
}

function orthTol(n: number): number {
  return SAFETY * EPS * n * Math.sqrt(n);
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
  randomSymmetric(n: number, lo = -1, hi = 1): Matrix {
    const data = new Float64Array(n * n);
    for (let i = 0; i < n; i++) {
      for (let j = i; j < n; j++) {
        const v = this.uniform(lo, hi);
        data[i * n + j] = v;
        data[j * n + i] = v;
      }
    }
    return { rows: n, cols: n, data };
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

describe("eigh — shape edges", () => {
  test("1×1: A=[[3]] → λ=[3], Q=[[1]]", () => {
    const A = matrixFromRows([[3]]);
    const r = eigh(A);
    expect(r.Q.rows).toBe(1);
    expect(r.Q.cols).toBe(1);
    expect(r.eigenvalues.length).toBe(1);
    expect(Math.abs(r.eigenvalues[0]! - 3)).toBeLessThan(8 * EPS);
    expect(Math.abs(Math.abs(r.Q.data[0]!) - 1)).toBeLessThan(8 * EPS);
  });

  test("1×1: A=[[-2]] → λ=[-2]", () => {
    const A = matrixFromRows([[-2]]);
    const r = eigh(A);
    expect(Math.abs(r.eigenvalues[0]! - -2)).toBeLessThan(8 * EPS);
  });

  test("2×2 identity: λ=[1,1], Q orthonormal", () => {
    const A = matIdentity(2);
    const r = eigh(A);
    expect(Math.abs(r.eigenvalues[0]! - 1)).toBeLessThan(SAFETY * EPS);
    expect(Math.abs(r.eigenvalues[1]! - 1)).toBeLessThan(SAFETY * EPS);
    expect(orthogonalityError(r.Q)).toBeLessThan(orthTol(2));
    expect(reconstructionError(A, r.Q, r.eigenvalues)).toBeLessThan(reconTol(2));
  });

  test("2×2 zero: λ=[0,0], Q orthonormal, reconstruction exact", () => {
    const A = matrixFromRows([[0, 0], [0, 0]]);
    const r = eigh(A);
    for (const x of r.eigenvalues) expect(x).toBe(0);
    expect(orthogonalityError(r.Q)).toBeLessThan(orthTol(2));
    expect(reconstructionError(A, r.Q, r.eigenvalues)).toBeLessThan(reconTol(2));
  });

  test("5×5 identity: λ = [1,1,1,1,1]", () => {
    const A = matIdentity(5);
    const r = eigh(A);
    for (const lam of r.eigenvalues) {
      expect(Math.abs(lam - 1)).toBeLessThan(SAFETY * EPS);
    }
    expect(orthogonalityError(r.Q)).toBeLessThan(orthTol(5));
    expect(reconstructionError(A, r.Q, r.eigenvalues)).toBeLessThan(reconTol(5));
  });

  test("diagonal A=diag(3, 1, 4, 1, 5): λ sorted ascending = [1,1,3,4,5]", () => {
    const A = matrixFromRows([
      [3, 0, 0, 0, 0],
      [0, 1, 0, 0, 0],
      [0, 0, 4, 0, 0],
      [0, 0, 0, 1, 0],
      [0, 0, 0, 0, 5],
    ]);
    const r = eigh(A);
    const expected = [1, 1, 3, 4, 5];
    for (let i = 0; i < 5; i++) {
      expect(Math.abs(r.eigenvalues[i]! - expected[i]!)).toBeLessThan(SAFETY * EPS);
    }
  });
});

// ── eigenvalues ascending ───────────────────────────────────────────────────

describe("eigh — eigenvalues ascending", () => {
  test("eigenvalues are non-decreasing across all sizes (random symmetric)", () => {
    const rng = new RNG(20260504);
    for (const n of [3, 5, 10, 20, 50]) {
      const A = rng.randomSymmetric(n);
      const r = eigh(A);
      for (let i = 0; i + 1 < n; i++) {
        const lamMax = Math.max(...Array.from(r.eigenvalues, Math.abs));
        const tol = SAFETY * EPS * Math.max(lamMax, 1);
        expect(r.eigenvalues[i]).toBeLessThanOrEqual(r.eigenvalues[i + 1]! + tol);
      }
    }
  });
});

// ── reconstruction & orthogonality on harder inputs ─────────────────────────

describe("eigh — random symmetric", () => {
  test("20 random 10×10 symmetric matrices: reconstruction & orthogonality within tolerance", () => {
    const rng = new RNG(20260505);
    for (let trial = 0; trial < 20; trial++) {
      const A = rng.randomSymmetric(10);
      const r = eigh(A);
      expect(reconstructionError(A, r.Q, r.eigenvalues)).toBeLessThan(reconTol(10));
      expect(orthogonalityError(r.Q)).toBeLessThan(orthTol(10));
    }
  });

  test("50×50 random symmetric: factorisation stays within tolerance", () => {
    const rng = new RNG(20260506);
    const A = rng.randomSymmetric(50);
    const r = eigh(A);
    expect(reconstructionError(A, r.Q, r.eigenvalues)).toBeLessThan(reconTol(50));
    expect(orthogonalityError(r.Q)).toBeLessThan(orthTol(50));
  });
});

// ── ill-conditioned: the Jacobi accuracy advertisement ──────────────────────

describe("eigh — Hilbert (the discriminator)", () => {
  test("Hilbert-8 (κ ≈ 1.5e10): orthogonality stays at O(ε), independent of κ", () => {
    const A = hilbert(8);
    const r = eigh(A);
    expect(orthogonalityError(r.Q)).toBeLessThan(orthTol(8));
    expect(reconstructionError(A, r.Q, r.eigenvalues)).toBeLessThan(reconTol(8));
    // Hilbert is SPD ⇒ all eigenvalues positive.
    for (const lam of r.eigenvalues) {
      expect(lam).toBeGreaterThan(-SAFETY * EPS);
    }
  });

  test("Hilbert-12 (κ ≈ 1e16): even at extreme κ, Jacobi converges with bounded errors", () => {
    const A = hilbert(12);
    const r = eigh(A);
    expect(orthogonalityError(r.Q)).toBeLessThan(orthTol(12));
    expect(reconstructionError(A, r.Q, r.eigenvalues)).toBeLessThan(reconTol(12));
  });
});

// ── rank-deficient inputs: residual still small ─────────────────────────────

describe("eigh — rank-deficient inputs", () => {
  test("rank-1 outer product u·uᵀ: one nonzero eigenvalue, rest ~ε", () => {
    // u = [1, 2, 3, 4]ᵀ → A = u·uᵀ has rank 1; the nonzero eigenvalue is
    // ‖u‖² = 1+4+9+16 = 30.
    const u = [1, 2, 3, 4];
    const rows = u.map((ui) => u.map((uj) => ui * uj));
    const A = matrixFromRows(rows);
    const r = eigh(A);
    expect(reconstructionError(A, r.Q, r.eigenvalues)).toBeLessThan(reconTol(4));
    expect(orthogonalityError(r.Q)).toBeLessThan(orthTol(4));
    // The largest eigenvalue is ‖u‖² = 30; the rest are ε-noise.
    const lamMax = r.eigenvalues[r.eigenvalues.length - 1]!;
    expect(Math.abs(lamMax - 30)).toBeLessThan(SAFETY * EPS * 30);
    // The smallest |λ| should be at the noise floor of A's Frobenius norm.
    const aNorm = frobenius(A.data);
    for (let i = 0; i < 3; i++) {
      expect(Math.abs(r.eigenvalues[i]!)).toBeLessThan(SAFETY * EPS * aNorm);
    }
  });

  test("all-zero 3×3: λ = [0, 0, 0], Q orthonormal", () => {
    const A = matrixFromRows([[0, 0, 0], [0, 0, 0], [0, 0, 0]]);
    const r = eigh(A);
    for (const x of r.eigenvalues) expect(x).toBe(0);
    expect(orthogonalityError(r.Q)).toBeLessThan(orthTol(3));
    expect(r.conditionNumber).toBe(0);
  });
});

// ── repeated / near-degenerate eigenvalues ─────────────────────────────────

describe("eigh — repeated and near-degenerate eigenvalues", () => {
  test("diag(1,1,1,2,2): repeated eigenvalues; residual stays at O(ε)", () => {
    const A = matrixFromRows([
      [1, 0, 0, 0, 0],
      [0, 1, 0, 0, 0],
      [0, 0, 1, 0, 0],
      [0, 0, 0, 2, 0],
      [0, 0, 0, 0, 2],
    ]);
    const r = eigh(A);
    expect(reconstructionError(A, r.Q, r.eigenvalues)).toBeLessThan(reconTol(5));
    expect(orthogonalityError(r.Q)).toBeLessThan(orthTol(5));
    // Eigenvalues: three at 1, two at 2.
    const expected = [1, 1, 1, 2, 2];
    for (let i = 0; i < 5; i++) {
      expect(Math.abs(r.eigenvalues[i]! - expected[i]!)).toBeLessThan(SAFETY * EPS);
    }
  });

  test("near-degenerate eigenvalues (gap = 1e-10): still ascending, reconstruction OK", () => {
    // Two eigenvalues 1 and 1 + 1e-10; an arbitrary orthogonal Q applied
    // to keep things general.
    const A = matrixFromRows([
      [1 + 5e-11, 5e-11, 0],
      [5e-11, 1 + 5e-11, 0],
      [0, 0, 2],
    ]);
    const r = eigh(A);
    expect(reconstructionError(A, r.Q, r.eigenvalues)).toBeLessThan(reconTol(3));
    expect(orthogonalityError(r.Q)).toBeLessThan(orthTol(3));
    for (let i = 0; i + 1 < 3; i++) {
      expect(r.eigenvalues[i]).toBeLessThanOrEqual(r.eigenvalues[i + 1]! + SAFETY * EPS * 2);
    }
  });
});

// ── self-reported errors — the agent-honest contract ───────────────────────

describe("eigh — self-reported errors are honest", () => {
  test("reconstructionError matches independent recomputation (random 8×8)", () => {
    const rng = new RNG(42);
    const A = rng.randomSymmetric(8);
    const r = eigh(A);
    const recomputed = reconstructionError(A, r.Q, r.eigenvalues);
    expect(Math.abs(r.reconstructionError - recomputed)).toBeLessThan(
      1e-12 * Math.max(recomputed, EPS),
    );
  });

  test("orthogonalityError matches independent recomputation (Hilbert-8)", () => {
    const A = hilbert(8);
    const r = eigh(A);
    const recomputed = orthogonalityError(r.Q);
    expect(Math.abs(r.orthogonalityError - recomputed)).toBeLessThan(
      1e-12 * Math.max(recomputed, EPS),
    );
  });

  test("on the all-zero matrix, both reconstruction and orthogonality are near zero", () => {
    const A = matrixFromRows([[0, 0, 0], [0, 0, 0], [0, 0, 0]]);
    const r = eigh(A);
    expect(r.reconstructionError).toBeLessThan(SAFETY * EPS);
    expect(r.orthogonalityError).toBeLessThan(orthTol(3));
  });
});

// ── condition number ────────────────────────────────────────────────────────

describe("eigh — condition number", () => {
  test("conditionNumber ≈ 1 for the identity", () => {
    const A = matIdentity(4);
    const r = eigh(A);
    expect(Math.abs(r.conditionNumber - 1)).toBeLessThan(100 * EPS);
  });

  test("conditionNumber matches |λ_max|/|λ_min| for SPD diag", () => {
    const A = matrixFromRows([
      [10, 0, 0],
      [0, 1, 0],
      [0, 0, 0.1],
    ]);
    const r = eigh(A);
    expect(Math.abs(r.conditionNumber - 100)).toBeLessThan(SAFETY * EPS * 100);
  });

  test("conditionNumber finite and bounded for singular A", () => {
    // diag(0, 1, 2): λ_min = 0 ⇒ clamp.
    const A = matrixFromRows([
      [0, 0, 0],
      [0, 1, 0],
      [0, 0, 2],
    ]);
    const r = eigh(A);
    expect(Number.isFinite(r.conditionNumber)).toBe(true);
    expect(r.conditionNumber).toBeGreaterThanOrEqual(0);
    expect(r.conditionNumber).toBeLessThanOrEqual(1 / EPS + 1);
  });
});

// ── mutation hooks ─────────────────────────────────────────────────────────
//
// Perturbations a reviewer can apply to eigh.ts; each comment names the
// test that would turn red. Verified by hand during development.
//
//   1. Skip the ascending sort of eigenvalues:
//        → "diagonal A=diag(3,1,4,1,5): λ sorted ascending = [1,1,3,4,5]"
//      becomes red because the diagonal walk produces them in [3,1,4,1,5]
//      order.
//
//   2. Forget to permute Q's columns alongside the eigenvalue sort:
//        → "20 random 10×10 symmetric matrices: reconstruction" fails —
//      Q's columns no longer pair with the (now-sorted) eigenvalues, so
//      A·Q[:,j] ≠ λ[j]·Q[:,j].
//
//   3. Miss the off-block update (skip the for-i ≠ p,q loop):
//        → "Hilbert-8" reconstruction blows up — the rotation only
//      affects the (p,q) block but the (i,p)/(i,q) entries stay stale,
//      so D doesn't actually become diagonal.
//
//   4. Use a smaller MAX_SWEEPS (say 5) so Hilbert-12 doesn't fully
//      converge:
//        → "Hilbert-12 (κ ≈ 1e16)" reconstruction fails because the
//      off-diagonal mass is still above ε.
//
//   5. Drop the "scrub D[p,q] := 0" assignment:
//        → "eigenvalues ascending" may pass but reconstructionError
//      drifts above tolerance on multi-sweep cases — accumulated
//      roundoff in the (p,q) entry feeds back into later rotations.
//
//   6. Sort descending instead of ascending:
//        → "diagonal A=diag(3,1,4,1,5)" fails — expected [1,1,3,4,5],
//      observed [5,4,3,1,1].
