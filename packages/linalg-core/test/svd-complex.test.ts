// =============================================================================
// svd-complex — property tests for the complex one-sided Jacobi SVD
// =============================================================================
//
// Tests assert mathematical invariants of the decomposition:
//
//   1. Reconstruction: ‖M − U·diag(S)·V†‖_F is at most a few machine
//      epsilons relative to ‖M‖_F.
//   2. Unitarity: ‖U†U − I‖_F and ‖V†V − I‖_F are at most a few machine
//      epsilons (per-column, independent of κ).
//   3. Singular values are real, non-negative, and descending.
//   4. Square Hermitian inputs: σ_i = |λ_i| of the spectrum (verified
//      against eighComplex).
//   5. Rectangular inputs work (both m > n and m < n branches).
//   6. Rank-deficient and zero matrices are admitted (S has trailing
//      zeros; rank estimate matches).
//   7. Complete mode produces square U and V; reduced mode produces
//      m×k / n×k (k = min(m, n)).
//   8. Determinism: byte-identical output for byte-identical input.
//
// Strategy: small problems with closed-form or eigh-cross-verified
// expected singular values; correctness asserted to ~100·ε. The
// substrate's algorithm prose lives in
// `packages/linalg-core/src/svd-complex.ts`; this file is the
// machine-checkable contract.

import { describe, expect, test } from "bun:test";
import {
  type ComplexMatrix,
  complexFromNested,
  complexFrobeniusNorm,
  complexMatmul,
  complexAdjoint,
  svdComplex,
  eighComplex,
} from "../src/index.js";

const EPS = Number.EPSILON;

// ─── helpers ─────────────────────────────────────────────────────────────

function reconErr(M: ComplexMatrix, r: ReturnType<typeof svdComplex>): number {
  // ‖M − U · diag(S) · V†‖_F  via the (M − U·diag(S)·V†) construction.
  const Vh = complexAdjoint(r.V);
  // Construct U_scaled = U · diag(S), then U_scaled · V†.
  const UScaledRe = new Float64Array(r.U.re.length);
  const UScaledIm = new Float64Array(r.U.im.length);
  for (let i = 0; i < r.U.rows; i++) {
    for (let j = 0; j < r.U.cols; j++) {
      const sigma = j < r.S.length ? r.S[j]! : 0;
      UScaledRe[i * r.U.cols + j] = sigma * r.U.re[i * r.U.cols + j]!;
      UScaledIm[i * r.U.cols + j] = sigma * r.U.im[i * r.U.cols + j]!;
    }
  }
  const UScaled: ComplexMatrix = {
    rows: r.U.rows,
    cols: r.U.cols,
    re: UScaledRe,
    im: UScaledIm,
  };
  const reconstruction = complexMatmul(UScaled, Vh);
  // Compute ‖M − reconstruction‖_F.
  let s = 0;
  for (let i = 0; i < M.rows; i++) {
    for (let j = 0; j < M.cols; j++) {
      const idx = i * M.cols + j;
      const dRe = M.re[idx]! - reconstruction.re[idx]!;
      const dIm = M.im[idx]! - reconstruction.im[idx]!;
      s += dRe * dRe + dIm * dIm;
    }
  }
  return Math.sqrt(s);
}

function orthError(Q: ComplexMatrix): number {
  // ‖Q† Q − I‖_F.
  const QhQ = complexMatmul(complexAdjoint(Q), Q);
  let s = 0;
  for (let i = 0; i < QhQ.rows; i++) {
    for (let j = 0; j < QhQ.cols; j++) {
      const idx = i * QhQ.cols + j;
      const dRe = QhQ.re[idx]! - (i === j ? 1 : 0);
      const dIm = QhQ.im[idx]!;
      s += dRe * dRe + dIm * dIm;
    }
  }
  return Math.sqrt(s);
}

const reconTol = (m: number, n: number, M: ComplexMatrix) =>
  100 * EPS * Math.max(m, n) * Math.sqrt(Math.min(m, n)) * Math.max(complexFrobeniusNorm(M), 1);
const orthTol = (dim: number) => 100 * EPS * dim * Math.sqrt(dim);

// ─── shape edges ─────────────────────────────────────────────────────────

describe("svdComplex — shape edges (real-valued, cheap path)", () => {
  test("1×1 M=[[3]] → S=[3], U=[[±1]], V=[[±1]]", () => {
    const M = complexFromNested([[3]], [[0]]);
    const r = svdComplex(M);
    expect(r.U.rows).toBe(1);
    expect(r.U.cols).toBe(1);
    expect(r.V.rows).toBe(1);
    expect(r.V.cols).toBe(1);
    expect(r.S.length).toBe(1);
    expect(Math.abs(r.S[0]! - 3)).toBeLessThan(8 * EPS);
    expect(reconErr(M, r)).toBeLessThan(reconTol(1, 1, M));
  });

  test("2×2 zero matrix: S=[0,0], rank 0, but U / V are unitary completions", () => {
    const M = complexFromNested([[0, 0], [0, 0]], [[0, 0], [0, 0]]);
    const r = svdComplex(M);
    for (const x of r.S) expect(x).toBe(0);
    expect(r.rankEstimate).toBe(0);
    // U and V should still be orthonormal (filled via complex Gram-Schmidt).
    expect(orthError(r.U)).toBeLessThan(orthTol(2));
    expect(orthError(r.V)).toBeLessThan(orthTol(2));
  });

  test("2×2 identity: S=[1,1], full rank, perfect reconstruction", () => {
    const M = complexFromNested([[1, 0], [0, 1]], [[0, 0], [0, 0]]);
    const r = svdComplex(M);
    expect(r.S[0]!).toBeCloseTo(1, 12);
    expect(r.S[1]!).toBeCloseTo(1, 12);
    expect(r.rankEstimate).toBe(2);
    expect(reconErr(M, r)).toBeLessThan(reconTol(2, 2, M));
  });

  test("diagonal diag(3, 1) sorted descending", () => {
    const M = complexFromNested([[3, 0], [0, 1]], [[0, 0], [0, 0]]);
    const r = svdComplex(M);
    expect(r.S[0]!).toBeCloseTo(3, 12);
    expect(r.S[1]!).toBeCloseTo(1, 12);
  });

  test("M=[[-2]]: S=[2] (sign absorbed into U)", () => {
    const M = complexFromNested([[-2]], [[0]]);
    const r = svdComplex(M);
    expect(r.S[0]!).toBeCloseTo(2, 12);
    // |U[0][0]| = 1; the sign is the algorithm's choice
    expect(Math.abs(Math.hypot(r.U.re[0]!, r.U.im[0]!) - 1)).toBeLessThan(8 * EPS);
  });
});

// ─── Pauli matrices (canonical complex 2×2 fixtures) ──────────────────────

describe("svdComplex — Pauli matrices", () => {
  test("Pauli X: real, singular values 1, 1", () => {
    const M = complexFromNested([[0, 1], [1, 0]], [[0, 0], [0, 0]]);
    const r = svdComplex(M);
    expect(r.S[0]!).toBeCloseTo(1, 12);
    expect(r.S[1]!).toBeCloseTo(1, 12);
    expect(reconErr(M, r)).toBeLessThan(reconTol(2, 2, M));
  });

  test("Pauli Y: pure imaginary, singular values 1, 1; complex U / V", () => {
    const M = complexFromNested([[0, 0], [0, 0]], [[0, -1], [1, 0]]);
    const r = svdComplex(M);
    expect(r.S[0]!).toBeCloseTo(1, 12);
    expect(r.S[1]!).toBeCloseTo(1, 12);
    expect(orthError(r.U)).toBeLessThan(orthTol(2));
    expect(orthError(r.V)).toBeLessThan(orthTol(2));
    expect(reconErr(M, r)).toBeLessThan(reconTol(2, 2, M));
  });

  test("Pauli Z: diagonal, singular values 1, 1", () => {
    const M = complexFromNested([[1, 0], [0, -1]], [[0, 0], [0, 0]]);
    const r = svdComplex(M);
    expect(r.S[0]!).toBeCloseTo(1, 12);
    expect(r.S[1]!).toBeCloseTo(1, 12);
  });
});

// ─── Hermitian fixtures (cross-check with eighComplex) ─────────────────────

describe("svdComplex vs eighComplex (Hermitian: σ_i = |λ_i|)", () => {
  test("H = [[1, i], [-i, 1]]: rank 1, singular values [2, 0]", () => {
    const H = complexFromNested([[1, 0], [0, 1]], [[0, 1], [-1, 0]]);
    const sigma = svdComplex(H);
    const lambda = eighComplex(H);
    // Sort |λ| descending and compare to S.
    const absLam = Array.from(lambda.eigenvalues, Math.abs).sort((a, b) => b - a);
    for (let i = 0; i < sigma.S.length; i++) {
      expect(Math.abs(sigma.S[i]! - absLam[i]!)).toBeLessThan(1e-12);
    }
    expect(sigma.rankEstimate).toBe(1);
  });

  test("H = [[2, 1+i], [1-i, 0]]: σ = |eigenvalues| descending", () => {
    const H = complexFromNested([[2, 1], [1, 0]], [[0, 1], [-1, 0]]);
    const sigma = svdComplex(H);
    const lambda = eighComplex(H);
    const absLam = Array.from(lambda.eigenvalues, Math.abs).sort((a, b) => b - a);
    for (let i = 0; i < sigma.S.length; i++) {
      expect(Math.abs(sigma.S[i]! - absLam[i]!)).toBeLessThan(1e-12);
    }
  });

  test("3×3 tridiagonal Hermitian (sweep convergence)", () => {
    const H = complexFromNested(
      [[1, 0.5, 0], [0.5, 2, 0.5], [0, 0.5, 3]],
      [[0, 0.5, 0], [-0.5, 0, 0.5], [0, -0.5, 0]],
    );
    const sigma = svdComplex(H);
    const lambda = eighComplex(H);
    const absLam = Array.from(lambda.eigenvalues, Math.abs).sort((a, b) => b - a);
    for (let i = 0; i < sigma.S.length; i++) {
      expect(Math.abs(sigma.S[i]! - absLam[i]!)).toBeLessThan(1e-12);
    }
    expect(reconErr(H, sigma)).toBeLessThan(reconTol(3, 3, H));
  });
});

// ─── rectangular cases ────────────────────────────────────────────────────

describe("svdComplex — rectangular", () => {
  test("3×2 tall (m > n): U is 3×2, V is 2×2, S length 2", () => {
    const M = complexFromNested([[1, 0], [0, 1], [0, 0]], [[0, 0], [0, 0], [0, 0]]);
    const r = svdComplex(M);
    expect(r.U.rows).toBe(3);
    expect(r.U.cols).toBe(2);
    expect(r.V.rows).toBe(2);
    expect(r.V.cols).toBe(2);
    expect(r.S.length).toBe(2);
    expect(r.S[0]!).toBeCloseTo(1, 12);
    expect(r.S[1]!).toBeCloseTo(1, 12);
    expect(reconErr(M, r)).toBeLessThan(reconTol(3, 2, M));
  });

  test("2×3 short (m < n, routes via M† internally): U is 2×2, V is 3×2", () => {
    const M = complexFromNested([[1, 0, 0], [0, 1, 0]], [[0, 0, 0], [0, 0, 0]]);
    const r = svdComplex(M);
    expect(r.U.rows).toBe(2);
    expect(r.U.cols).toBe(2);
    expect(r.V.rows).toBe(3);
    expect(r.V.cols).toBe(2);
    expect(r.S.length).toBe(2);
    expect(r.S[0]!).toBeCloseTo(1, 12);
    expect(r.S[1]!).toBeCloseTo(1, 12);
    expect(reconErr(M, r)).toBeLessThan(reconTol(2, 3, M));
  });

  test("4×2 tall real generic", () => {
    const M = complexFromNested(
      [[1, 2], [3, 4], [5, 6], [7, 8]],
      [[0, 0], [0, 0], [0, 0], [0, 0]],
    );
    const r = svdComplex(M);
    expect(r.U.rows).toBe(4);
    expect(r.U.cols).toBe(2);
    expect(reconErr(M, r)).toBeLessThan(reconTol(4, 2, M));
    expect(orthError(r.U)).toBeLessThan(orthTol(4));
    expect(orthError(r.V)).toBeLessThan(orthTol(2));
  });

  test("2×4 short complex generic", () => {
    const M = complexFromNested(
      [[1, 0, 1, 0], [0, 1, 0, 1]],
      [[0, 1, 0, 0], [0, 0, 0, 1]],
    );
    const r = svdComplex(M);
    expect(r.U.rows).toBe(2);
    expect(r.U.cols).toBe(2);
    expect(r.V.rows).toBe(4);
    expect(r.V.cols).toBe(2);
    expect(reconErr(M, r)).toBeLessThan(reconTol(2, 4, M));
  });
});

// ─── complete vs reduced mode ─────────────────────────────────────────────

describe("svdComplex — mode", () => {
  test("complete 3×2: U is 3×3, V is 2×2; reduced 3×2: U is 3×2, V is 2×2", () => {
    const M = complexFromNested([[1, 0], [0, 1], [0, 0]], [[0, 0], [0, 0], [0, 0]]);
    const red = svdComplex(M, "reduced");
    const comp = svdComplex(M, "complete");
    expect(red.U.cols).toBe(2);
    expect(comp.U.cols).toBe(3);
    expect(red.V.cols).toBe(2);
    expect(comp.V.cols).toBe(2);
    // Singular values are the same (complete-mode extra columns
    // correspond to implicit zero singular values).
    expect(red.S.length).toBe(2);
    expect(comp.S.length).toBe(2);
    // The extra column of complete U must be orthogonal to the first 2.
    expect(orthError(comp.U)).toBeLessThan(orthTol(3));
  });

  test("complete 2×3: U is 2×2, V is 3×3", () => {
    const M = complexFromNested([[1, 0, 0], [0, 1, 0]], [[0, 0, 0], [0, 0, 0]]);
    const comp = svdComplex(M, "complete");
    expect(comp.U.cols).toBe(2);
    expect(comp.V.cols).toBe(3);
    expect(orthError(comp.V)).toBeLessThan(orthTol(3));
  });

  test("complete 2×2 with imaginary part", () => {
    const M = complexFromNested([[1, 0], [0, 1]], [[0, 1], [-1, 0]]);
    const r = svdComplex(M, "complete");
    expect(r.U.cols).toBe(2);
    expect(r.V.cols).toBe(2);
    expect(orthError(r.U)).toBeLessThan(orthTol(2));
    expect(orthError(r.V)).toBeLessThan(orthTol(2));
  });
});

// ─── ordering and reality of S ────────────────────────────────────────────

describe("svdComplex — S contract", () => {
  test("S is sorted descending across many random shapes", () => {
    // Deterministic LCG so the test reproduces.
    const lcg = (seed: number) => {
      let x = seed;
      return () => {
        x = (1103515245 * x + 12345) & 0x7fffffff;
        return (x / 0x7fffffff) * 2 - 1;
      };
    };
    const rng = lcg(42);
    const shapes: readonly [number, number][] = [
      [2, 2], [3, 3], [3, 2], [2, 3], [4, 3], [3, 4], [5, 5],
    ];
    for (const [m, n] of shapes) {
      const re = new Float64Array(m * n);
      const im = new Float64Array(m * n);
      for (let k = 0; k < m * n; k++) {
        re[k] = rng();
        im[k] = rng();
      }
      const M: ComplexMatrix = { rows: m, cols: n, re, im };
      const r = svdComplex(M);
      for (let i = 0; i + 1 < r.S.length; i++) {
        expect(r.S[i]!).toBeGreaterThanOrEqual(r.S[i + 1]! - 100 * EPS * r.S[0]!);
      }
      for (const x of r.S) expect(x).toBeGreaterThanOrEqual(0);
    }
  });
});

// ─── rank-deficient cases ─────────────────────────────────────────────────

describe("svdComplex — rank-deficient", () => {
  test("2×2 rank-1 outer product: S = [√(a² + b² + c² + d²), 0]", () => {
    // M = u · vᵀ with u = (1, 1) and v = (1, 1): trace 2, ||M||_F = 2.
    // Singular values: σ_1 = ||u||·||v|| = √2·√2 = 2; σ_2 = 0.
    const M = complexFromNested([[1, 1], [1, 1]], [[0, 0], [0, 0]]);
    const r = svdComplex(M);
    expect(r.S[0]!).toBeCloseTo(2, 12);
    expect(r.S[1]!).toBeCloseTo(0, 12);
    expect(r.rankEstimate).toBe(1);
  });

  test("3×3 well-separated diag(1e-8, 1, 1e8): S descending, σ_min below LAPACK rank threshold", () => {
    // σ_max = 1e8 ⇒ LAPACK threshold = max(m,n)·ε·σ_max ≈ 6.7e-8,
    // and σ_min = 1e-8 falls below it ⇒ rank reports 2, not 3. This
    // is the LAPACK MATRIX_RANK convention; the matrix is mathematically
    // full rank but numerically rank-2 at machine precision.
    const M = complexFromNested(
      [[1e-8, 0, 0], [0, 1, 0], [0, 0, 1e8]],
      [[0, 0, 0], [0, 0, 0], [0, 0, 0]],
    );
    const r = svdComplex(M);
    expect(r.S[0]!).toBeCloseTo(1e8, 0);
    expect(r.S[1]!).toBeCloseTo(1, 12);
    expect(r.S[2]!).toBeCloseTo(1e-8, 16);
    expect(r.rankEstimate).toBe(2);
  });

  test("3×3 well-separated diag(1e-6, 1, 1): all three σ above LAPACK rank threshold ⇒ rank 3", () => {
    // σ_max = 1, threshold ≈ 3·ε ≈ 7e-16; σ_min = 1e-6 well above ⇒ full rank.
    const M = complexFromNested(
      [[1e-6, 0, 0], [0, 1, 0], [0, 0, 1]],
      [[0, 0, 0], [0, 0, 0], [0, 0, 0]],
    );
    const r = svdComplex(M);
    expect(r.rankEstimate).toBe(3);
  });
});

// ─── self-reported errors match independently-computed values ─────────────

describe("svdComplex — self-reported errors honest", () => {
  test("reconstruction_error and orthogonality errors agree with hand-computed", () => {
    const M = complexFromNested([[1, 2], [3, 4]], [[1, 0], [0, -1]]);
    const r = svdComplex(M);
    // Independently recompute.
    const ourRecon = reconErr(M, r) / Math.max(complexFrobeniusNorm(M), 1);
    const ourOrthU = orthError(r.U);
    const ourOrthV = orthError(r.V);
    // Should agree to a small multiple of machine epsilon.
    expect(Math.abs(r.reconstructionError - ourRecon)).toBeLessThan(1e-12);
    expect(Math.abs(r.orthogonalityErrorU - ourOrthU)).toBeLessThan(1e-12);
    expect(Math.abs(r.orthogonalityErrorV - ourOrthV)).toBeLessThan(1e-12);
  });
});

// ─── determinism (byte-identical output for identical input) ─────────────

describe("svdComplex — determinism", () => {
  test("two calls produce byte-identical Float64Array contents", () => {
    const M = complexFromNested([[1, 2], [3, 4]], [[1, 0], [0, -1]]);
    const r1 = svdComplex(M);
    const r2 = svdComplex(M);
    for (let i = 0; i < r1.S.length; i++) expect(r1.S[i]).toBe(r2.S[i]);
    for (let i = 0; i < r1.U.re.length; i++) {
      expect(r1.U.re[i]).toBe(r2.U.re[i]);
      expect(r1.U.im[i]).toBe(r2.U.im[i]);
    }
    for (let i = 0; i < r1.V.re.length; i++) {
      expect(r1.V.re[i]).toBe(r2.V.re[i]);
      expect(r1.V.im[i]).toBe(r2.V.im[i]);
    }
  });
});
