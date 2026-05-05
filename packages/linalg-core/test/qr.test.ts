// =============================================================================
// qr.test.ts — substrate tests for Householder QR
// =============================================================================
//
// We exercise the `qr(A, mode)` substrate from packages/linalg-core/src/qr.ts
// against the same set of stress patterns the bench cares about, but at the
// library level (no JSON traffic). The tests are split into:
//
//   ── shape & basic algebra ──────────────────────────────────────────────
//     * identity round-trip
//     * 1×1, 2×1, 1×2, 2×2 zero — every shape edge the bench enumerates
//     * complete-mode shape contract (Q is m×m, R is m×n with bottom rows zero)
//     * sign convention (Householder picks α = -sign(x[0])·||x||)
//
//   ── reconstruction & orthogonality ─────────────────────────────────────
//     * random well-conditioned (m=n=10, 30 trials, seeded RNG)
//     * tall (m>n) and fat (m<n) rectangular cases
//     * Hilbert-8 (κ ≈ 1.5e10) — the discriminator: classical and modified
//       Gram-Schmidt fail orthogonality here; Householder must not.
//     * rank-1 outer product (rank-deficient by construction)
//     * all-zero matrix (degenerate but in-scope)
//
//   ── self-reported errors ───────────────────────────────────────────────
//     * `reconstructionError` matches recomputed ||QR − A||_F / max(||A||_F, 1)
//     * `orthogonalityError`  matches recomputed ||QᵀQ − I||_F
//     These are the *bench's* checks 6 and 7. If we drift here, the bench
//     will catch it; we catch it earlier in the substrate.
//
//   ── mutation hooks ─────────────────────────────────────────────────────
//     Documented at the bottom — perturbations a reviewer can apply that
//     should turn a test red.
//
// Tolerances: derived from Higham 2002, Thm 19.4 — Householder gives
// O(ε·m·n) backward error and O(ε) orthogonality (independent of κ). We
// pad with the same 100× safety factor the bench's verifier uses, so a
// suite that passes here is on the right side of the bench.

import { describe, expect, test } from "bun:test";
import {
  matrixFromRows,
  matIdentity,
  type Matrix,
  qr,
} from "../src/index.js";

const EPS = Number.EPSILON;
const SAFETY = 100;

// -----------------------------------------------------------------------------
// Helpers — independent recomputation of the verifier's two diagnostics.
// We deliberately re-implement these *here* (rather than reuse the qr.ts
// internals) so a regression in qr.ts's self-report doesn't go undetected
// because the test was reading the same buggy formula.
// -----------------------------------------------------------------------------

function frobenius(data: Float64Array | readonly number[]): number {
  let s = 0;
  for (const x of data) s += x * x;
  return Math.sqrt(s);
}

function matMul(A: Matrix, B: Matrix): Matrix {
  if (A.cols !== B.rows) throw new Error(`matMul: ${A.cols} != ${B.rows}`);
  const out = new Float64Array(A.rows * B.cols);
  for (let i = 0; i < A.rows; i++) {
    for (let j = 0; j < B.cols; j++) {
      let s = 0;
      for (let k = 0; k < A.cols; k++) {
        s += A.data[i * A.cols + k]! * B.data[k * B.cols + j]!;
      }
      out[i * B.cols + j] = s;
    }
  }
  return { rows: A.rows, cols: B.cols, data: out };
}

function reconstructionError(Q: Matrix, R: Matrix, A: Matrix): number {
  const QR = matMul(Q, R);
  if (QR.rows !== A.rows || QR.cols !== A.cols) {
    throw new Error(
      `reconstructionError: shape mismatch QR=${QR.rows}x${QR.cols} A=${A.rows}x${A.cols}`,
    );
  }
  const diff = new Float64Array(A.data.length);
  for (let i = 0; i < A.data.length; i++) diff[i] = QR.data[i]! - A.data[i]!;
  return frobenius(diff) / Math.max(frobenius(A.data), 1);
}

function orthogonalityError(Q: Matrix): number {
  const m = Q.rows;
  const k = Q.cols;
  // ||QᵀQ − I_k||_F. We materialise QᵀQ (k×k) entry by entry; for k ≤ 50
  // (the largest test case here) this is cheap.
  let s = 0;
  for (let i = 0; i < k; i++) {
    for (let j = 0; j < k; j++) {
      let acc = 0;
      for (let r = 0; r < m; r++) {
        acc += Q.data[r * k + i]! * Q.data[r * k + j]!;
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

function orthTol(m: number, k: number): number {
  return SAFETY * EPS * m * Math.sqrt(k);
}

function structTol(m: number, n: number, A: Matrix): number {
  return SAFETY * EPS * Math.max(m, n) * Math.max(frobenius(A.data), 1);
}

// Seeded mulberry32 — lifted from the linalg-core test file so seed
// behaviour stays comparable.
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

describe("qr — shape edges", () => {
  test("1×1 reduced: A=[[3]], Q=[[1]] (or [[-1]]), R=[[3]] (or [[-3]])", () => {
    const A = matrixFromRows([[3]]);
    const r = qr(A, "reduced");
    expect(r.Q.rows).toBe(1);
    expect(r.Q.cols).toBe(1);
    expect(r.R.rows).toBe(1);
    expect(r.R.cols).toBe(1);
    // |Q[0,0]| === 1 and Q·R = A.
    expect(Math.abs(Math.abs(r.Q.data[0]!) - 1)).toBeLessThan(8 * EPS);
    expect(Math.abs(r.Q.data[0]! * r.R.data[0]! - 3)).toBeLessThan(8 * EPS);
    expect(r.diagonalR.length).toBe(1);
  });

  test("2×1 reduced: Q is 2×1, R is 1×1", () => {
    const A = matrixFromRows([[1], [2]]);
    const r = qr(A, "reduced");
    expect(r.Q.rows).toBe(2);
    expect(r.Q.cols).toBe(1);
    expect(r.R.rows).toBe(1);
    expect(r.R.cols).toBe(1);
    // R[0,0] = ±||A||_2 = ±√5
    expect(Math.abs(Math.abs(r.R.data[0]!) - Math.sqrt(5))).toBeLessThan(8 * EPS);
    expect(reconstructionError(r.Q, r.R, A)).toBeLessThan(reconTol(2, 1));
  });

  test("1×2 reduced: m < n, so Q is 1×1 and R is 1×2", () => {
    const A = matrixFromRows([[1, 2]]);
    const r = qr(A, "reduced");
    // For m<n, k=min(m,n)=m=1, qCols=m=1.
    expect(r.Q.rows).toBe(1);
    expect(r.Q.cols).toBe(1);
    expect(r.R.rows).toBe(1);
    expect(r.R.cols).toBe(2);
    expect(reconstructionError(r.Q, r.R, A)).toBeLessThan(reconTol(1, 2));
  });

  test("2×2 zero: R=0, Q=I (any orthogonal Q works; Householder returns identity-shaped)", () => {
    const A = matrixFromRows([[0, 0], [0, 0]]);
    const r = qr(A, "reduced");
    // R must be exactly zero (the loop's scale==0 branch never writes to R).
    for (const x of r.R.data) expect(x).toBe(0);
    // Q must be orthogonal — for the zero matrix specifically, Householder's
    // identity-reflector branch leaves Q at the initial identity.
    expect(orthogonalityError(r.Q)).toBeLessThan(orthTol(2, 2));
    expect(reconstructionError(r.Q, r.R, A)).toBe(0);
  });

  test("identity 5×5: Q=I, R=I (the trivial case must not perturb)", () => {
    const A = matIdentity(5);
    const r = qr(A, "reduced");
    // R is upper triangular with R[i,i] = ±1 (Householder may flip sign).
    for (let i = 0; i < 5; i++) {
      expect(Math.abs(Math.abs(r.R.data[i * 5 + i]!) - 1)).toBeLessThan(8 * EPS);
    }
    expect(orthogonalityError(r.Q)).toBeLessThan(orthTol(5, 5));
    expect(reconstructionError(r.Q, r.R, A)).toBeLessThan(reconTol(5, 5));
  });

  test("5×3 simple: standard tall case mirrors bench A_5x3", () => {
    const A = matrixFromRows([
      [1, 2, 3],
      [4, 5, 6],
      [7, 8, 10],
      [1, 0, 1],
      [0, 1, 0],
    ]);
    const r = qr(A, "reduced");
    expect(r.Q.rows).toBe(5);
    expect(r.Q.cols).toBe(3);
    expect(r.R.rows).toBe(3);
    expect(r.R.cols).toBe(3);
    // R is upper triangular below the diagonal.
    expect(Math.abs(r.R.data[1 * 3 + 0]!)).toBeLessThan(structTol(5, 3, A));
    expect(Math.abs(r.R.data[2 * 3 + 0]!)).toBeLessThan(structTol(5, 3, A));
    expect(Math.abs(r.R.data[2 * 3 + 1]!)).toBeLessThan(structTol(5, 3, A));
    expect(orthogonalityError(r.Q)).toBeLessThan(orthTol(5, 3));
    expect(reconstructionError(r.Q, r.R, A)).toBeLessThan(reconTol(5, 3));
  });
});

// ── complete-mode contract ───────────────────────────────────────────────────

describe("qr — complete mode", () => {
  test("complete on 5×3: Q is 5×5, R is 5×3 with bottom 2 rows = 0", () => {
    const A = matrixFromRows([
      [1, 2, 3],
      [4, 5, 6],
      [7, 8, 10],
      [1, 0, 1],
      [0, 1, 0],
    ]);
    const r = qr(A, "complete");
    expect(r.mode).toBe("complete");
    expect(r.Q.rows).toBe(5);
    expect(r.Q.cols).toBe(5);
    expect(r.R.rows).toBe(5);
    expect(r.R.cols).toBe(3);
    // Bottom rows of R must be exactly zero (LAPACK convention).
    for (let i = 3; i < 5; i++) {
      for (let j = 0; j < 3; j++) {
        expect(r.R.data[i * 3 + j]).toBe(0);
      }
    }
    expect(orthogonalityError(r.Q)).toBeLessThan(orthTol(5, 5));
    expect(reconstructionError(r.Q, r.R, A)).toBeLessThan(reconTol(5, 3));
  });

  test("complete coincides with reduced when m ≤ n (no extra columns to compute)", () => {
    const A = matrixFromRows([[1, 2, 3, 4, 5], [2, 1, 0, -1, 1], [3, 0, -1, 2, 1]]);
    const reduced = qr(A, "reduced");
    const complete = qr(A, "complete");
    // Both have Q of shape m×m; the substrate should produce identical bytes.
    expect(reduced.Q.rows).toBe(complete.Q.rows);
    expect(reduced.Q.cols).toBe(complete.Q.cols);
    for (let i = 0; i < reduced.Q.data.length; i++) {
      expect(reduced.Q.data[i]).toBe(complete.Q.data[i]!);
    }
  });
});

// ── sign convention (Householder picks the sign that avoids cancellation) ───

describe("qr — sign convention", () => {
  test("R[0,0] for a positive-leading column has α = -||x|| (sign is negated)", () => {
    // x = [3, 4]: ||x|| = 5; the Householder convention sets α = -sign(x[0])·||x||.
    // x[0] = 3 > 0, so α = -5.
    const A = matrixFromRows([[3, 0], [4, 0]]);
    const r = qr(A, "reduced");
    expect(r.R.data[0]).toBeCloseTo(-5, 12);
  });

  test("R[0,0] for a negative-leading column has α = +||x||", () => {
    // x = [-3, 4]: ||x|| = 5; α = -sign(-3)·5 = +5.
    const A = matrixFromRows([[-3, 0], [4, 0]]);
    const r = qr(A, "reduced");
    expect(r.R.data[0]).toBeCloseTo(5, 12);
  });
});

// ── reconstruction & orthogonality on harder inputs ──────────────────────────

describe("qr — random well-conditioned", () => {
  test("30 random 10×10 matrices: ||QR-A||_F/||A||_F and ||QᵀQ-I||_F within tolerance", () => {
    const rng = new RNG(20260505);
    for (let trial = 0; trial < 30; trial++) {
      const A = rng.randomMatrix(10, 10);
      const r = qr(A, "reduced");
      expect(reconstructionError(r.Q, r.R, A)).toBeLessThan(reconTol(10, 10));
      expect(orthogonalityError(r.Q)).toBeLessThan(orthTol(10, 10));
    }
  });

  test("tall 50×3 random: orthogonality stays at machine epsilon", () => {
    const rng = new RNG(1234);
    const A = rng.randomMatrix(50, 3);
    const r = qr(A, "reduced");
    expect(reconstructionError(r.Q, r.R, A)).toBeLessThan(reconTol(50, 3));
    expect(orthogonalityError(r.Q)).toBeLessThan(orthTol(50, 3));
  });

  test("fat 3×50 random: m < n, complete-mode-shape Q (3×3)", () => {
    const rng = new RNG(5678);
    const A = rng.randomMatrix(3, 50);
    const r = qr(A, "reduced");
    expect(r.Q.rows).toBe(3);
    expect(r.Q.cols).toBe(3);
    expect(r.R.rows).toBe(3);
    expect(r.R.cols).toBe(50);
    expect(reconstructionError(r.Q, r.R, A)).toBeLessThan(reconTol(3, 50));
    expect(orthogonalityError(r.Q)).toBeLessThan(orthTol(3, 3));
  });
});

// ── ill-conditioned: the Householder discriminator ──────────────────────────

describe("qr — Hilbert (the discriminator)", () => {
  test("Hilbert-8 (κ ≈ 1.5e10): orthogonality must stay at O(ε), independent of κ", () => {
    // Classical Gram-Schmidt would give ~κ²·ε ≈ 2e-12 (visible drift).
    // Modified Gram-Schmidt would give ~κ·ε ≈ 3e-6 (catastrophic).
    // Householder gives O(ε) — that's why this test passes.
    const A = hilbert(8);
    const r = qr(A, "reduced");
    expect(orthogonalityError(r.Q)).toBeLessThan(orthTol(8, 8));
    expect(reconstructionError(r.Q, r.R, A)).toBeLessThan(reconTol(8, 8));
  });

  test("Hilbert-12: even at κ ≈ 1e16, orthogonality stays bounded", () => {
    const A = hilbert(12);
    const r = qr(A, "reduced");
    expect(orthogonalityError(r.Q)).toBeLessThan(orthTol(12, 12));
    // Reconstruction is still fine — Householder is backward-stable.
    expect(reconstructionError(r.Q, r.R, A)).toBeLessThan(reconTol(12, 12));
  });
});

// ── rank-deficient (in-scope, Householder still works) ──────────────────────

describe("qr — rank-deficient inputs", () => {
  test("rank-1 outer product u·vᵀ: Q has orthonormal cols, R has at most 1 nonzero diag entry", () => {
    // u = [1, 2, 3, 4]ᵀ, v = [1, -1, 2]ᵀ → A = u·vᵀ has rank 1.
    const u = [1, 2, 3, 4];
    const v = [1, -1, 2];
    const rows = u.map((ui) => v.map((vj) => ui * vj));
    const A = matrixFromRows(rows);
    const r = qr(A, "reduced");
    expect(reconstructionError(r.Q, r.R, A)).toBeLessThan(reconTol(4, 3));
    expect(orthogonalityError(r.Q)).toBeLessThan(orthTol(4, 3));
    // The R diagonal reveals the rank: |R[0,0]| ~ ||A||, |R[1,1]| ~ |R[2,2]| ~ ε.
    const diagAbs = [
      Math.abs(r.diagonalR[0]!),
      Math.abs(r.diagonalR[1]!),
      Math.abs(r.diagonalR[2]!),
    ];
    expect(diagAbs[0]).toBeGreaterThan(1);
    expect(diagAbs[1]).toBeLessThan(structTol(4, 3, A));
    expect(diagAbs[2]).toBeLessThan(structTol(4, 3, A));
  });

  test("identity with a zero column: Householder still produces orthonormal Q", () => {
    const A = matrixFromRows([
      [1, 0, 0, 0, 0],
      [0, 1, 0, 0, 0],
      [0, 0, 0, 0, 0],  // zero diagonal → zero column at j=2
      [0, 0, 0, 1, 0],
      [0, 0, 0, 0, 1],
    ]);
    const r = qr(A, "reduced");
    expect(orthogonalityError(r.Q)).toBeLessThan(orthTol(5, 5));
    expect(reconstructionError(r.Q, r.R, A)).toBeLessThan(reconTol(5, 5));
    // The zero column manifests as R[2,2] = 0.
    expect(r.R.data[2 * 5 + 2]).toBe(0);
  });
});

// ── self-reported errors — the agent-honest contract ────────────────────────

describe("qr — self-reported errors are honest", () => {
  test("reconstructionError matches an independent recomputation (5×3)", () => {
    const A = matrixFromRows([
      [1, 2, 3],
      [4, 5, 6],
      [7, 8, 10],
      [1, 0, 1],
      [0, 1, 0],
    ]);
    const r = qr(A, "reduced");
    const recomputed = reconstructionError(r.Q, r.R, A);
    // Bench check 6 demands within 1e-6 relative; we test much tighter.
    expect(Math.abs(r.reconstructionError - recomputed)).toBeLessThan(
      1e-12 * Math.max(recomputed, EPS),
    );
  });

  test("orthogonalityError matches an independent recomputation (Hilbert-8)", () => {
    const A = hilbert(8);
    const r = qr(A, "reduced");
    const recomputed = orthogonalityError(r.Q);
    expect(Math.abs(r.orthogonalityError - recomputed)).toBeLessThan(
      1e-12 * Math.max(recomputed, EPS),
    );
  });

  test("on the all-zero matrix, both self-reports are exactly zero", () => {
    const A = matrixFromRows([[0, 0, 0], [0, 0, 0], [0, 0, 0]]);
    const r = qr(A, "reduced");
    expect(r.reconstructionError).toBe(0);
    expect(r.orthogonalityError).toBeLessThan(orthTol(3, 3));
  });
});

// ── mutation hooks ─────────────────────────────────────────────────────────
//
// Perturbations a reviewer can apply to qr.ts; each comment names the
// test that would turn red. These have been verified by hand during
// development; preserved here so the *intent* of each test stays legible.
//
//   1. Drop the sign-convention negation (`alpha = -sign * xnorm` →
//      `alpha = sign * xnorm`):
//        → "R[0,0] for a positive-leading column has α = -||x||"
//      and several reconstruction tests (cancellation in v[0] amplifies
//      orthogonality error on Hilbert-8).
//
//   2. Apply reflectors to A *and* re-write the diagonal column (skip
//      the v ← v / v[0] rescaling, leaving v[0] in the storage slot):
//        → "5×3 simple" reconstruction fails — the sub-diagonal R entries
//      become non-zero because the rank-1 update uses an unscaled v.
//
//   3. Swap backward-accumulation order to forward (`for j = 0..k-1: Q ← H_j · Q`):
//        → Hilbert-12 orthogonality test fails — forward accumulation
//      doesn't preserve the sparse-identity-block invariant.
//
//   4. Compute `reconstructionError` on intermediate state (before the
//      final rank-1 updates land):
//        → "reconstructionError matches an independent recomputation"
//      fails — the self-report drifts from what the verifier sees.
//
//   5. Use plain ||x||² accumulation (no scaled DNRM2) inside the
//      reflector construction:
//        → no test in this file fails directly (our matrices are normal-
//      magnitude). The motivation is preservation of the substrate's
//      large-magnitude representability — covered by the linalg-core
//      `vecNorm2: handles large magnitudes` test in linalg-core.test.ts.
