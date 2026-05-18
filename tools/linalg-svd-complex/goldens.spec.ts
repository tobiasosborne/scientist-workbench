// linalg-svd-complex goldens — covering the complex one-sided Jacobi
// algorithm's frontier: real-valued inputs (the "im = 0 round-off" cheap
// path), Pauli fixtures, Hermitian inputs (eigenvalue magnitude is the
// singular value), generic complex matrices, rectangular inputs (m > n
// and the m < n M† routing branch), rank-deficient matrices, reduced
// vs complete mode, and every boundary category from ADR-0035 §D6 + the
// SVD-specific shape-mismatch / mode-validation ToolErrors. The
// ToolError cases (shape mismatch, ragged, bad mode) live in unit tests
// in `tools/linalg-svd-complex/tool.ts` — goldens freeze only
// admissible outputs (success records + tagged boundaries).
//
// The goldens file is the agent's quick-reference; each entry's
// description is what the registry surfaces. Cases are kept small here
// (per-tool goldens are the JSON-frozen baseline); larger stress
// fixtures land in the bench corpus when `bench/linalg-svd-complex/`
// ships (filed under `ov4j`).

import {
  float64FromNumber,
  list,
  record,
  str,
  type Float64Value,
} from "@workbench/protocol";
import type { GoldenSpec } from "@workbench/contract";

function f(x: number): Float64Value {
  return float64FromNumber(x);
}
function vec(xs: readonly number[]): {
  readonly kind: "list";
  readonly items: readonly Float64Value[];
} {
  return list(xs.map(f));
}
function mat(rows: readonly (readonly number[])[]): {
  readonly kind: "list";
  readonly items: readonly { readonly kind: "list"; readonly items: readonly Float64Value[] }[];
} {
  return list(rows.map((r) => vec(r)));
}

/**
 * Build the canonical complex-matrix wire input from parallel real and
 * imaginary nested arrays. Mirrors ADR-0035 §D2's required-im shape:
 * both `re` and `im` are present, rectangular, and same shape. `mode`
 * is included explicitly (no defaulting) so the success record echoes
 * the right value back.
 */
function inp(
  reRows: readonly (readonly number[])[],
  imRows: readonly (readonly number[])[],
  mode: string = "reduced",
) {
  return record({ re: mat(reRows), im: mat(imRows), mode: str(mode) });
}

/**
 * Real-valued matrix (im = 0): the cheap path where complex Jacobi's
 * imaginary-arithmetic terms vanish. Tests that the algorithm produces
 * the right singular values when `im` is identically zero.
 */
function realM(A: readonly (readonly number[])[], mode: string = "reduced") {
  const m = A.length;
  const n = A[0]!.length;
  const zeros: number[][] = [];
  for (let i = 0; i < m; i++) zeros.push(new Array<number>(n).fill(0));
  return inp(A, zeros, mode);
}

export const goldens: GoldenSpec[] = [
  // ── shape edges (real-valued, cheap path) ───────────────────────────────
  { description: "1x1 real M=[[3]] S=[3]", input: realM([[3]]) },
  { description: "1x1 real M=[[-2]] S=[2] sign-flipped", input: realM([[-2]]) },
  { description: "2x2 identity S=[1,1]", input: realM([[1, 0], [0, 1]]) },
  { description: "2x2 zero S=[0,0] rank 0", input: realM([[0, 0], [0, 0]]) },
  { description: "2x2 diagonal diag(3,1) S=[3,1] descending", input: realM([[3, 0], [0, 1]]) },
  { description: "3x3 identity S=[1,1,1]", input: realM([[1, 0, 0], [0, 1, 0], [0, 0, 1]]) },

  // ── Pauli family (canonical complex single-qubit fixtures) ──────────────
  { description: "Pauli X re=[[0,1],[1,0]] im=0 S=[1,1]", input: realM([[0, 1], [1, 0]]) },
  { description: "Pauli Y re=0 im=[[0,-1],[1,0]] S=[1,1] complex U V",
    input: inp([[0, 0], [0, 0]], [[0, -1], [1, 0]]) },
  { description: "Pauli Z re=[[1,0],[0,-1]] im=0 S=[1,1]", input: realM([[1, 0], [0, -1]]) },

  // ── Hermitian 2x2 with imaginary off-diagonal ────────────────────────────
  { description: "2x2 [[1,i],[-i,1]] rank 1 S=[2,0]", input: inp([[1, 0], [0, 1]], [[0, 1], [-1, 0]]) },
  { description: "2x2 [[2, 1+i],[1-i, 0]] generic complex Hermitian",
    input: inp([[2, 1], [1, 0]], [[0, 1], [-1, 0]]) },
  { description: "2x2 generic complex M=[[1+i,2],[3,4-i]] not Hermitian",
    input: inp([[1, 2], [3, 4]], [[1, 0], [0, -1]]) },

  // ── rectangular tall (m > n) ─────────────────────────────────────────────
  { description: "3x2 tall real orthonormal columns S=[1,1]",
    input: realM([[1, 0], [0, 1], [0, 0]]) },
  { description: "4x2 tall real generic",
    input: realM([[1, 2], [3, 4], [5, 6], [7, 8]]) },
  { description: "3x2 tall complex orthonormal-like im introduces phase",
    input: inp([[1, 0], [0, 1], [0, 0]], [[0, 0], [0, 0], [0, 1]]) },

  // ── rectangular short-and-fat (m < n) — routes via M† internally ─────────
  { description: "2x3 short real orthonormal rows S=[1,1]",
    input: realM([[1, 0, 0], [0, 1, 0]]) },
  { description: "2x4 short real generic",
    input: realM([[1, 2, 3, 4], [5, 6, 7, 8]]) },
  { description: "2x3 short complex with im swap U V after M dagger routing",
    input: inp([[1, 0, 0], [0, 1, 0]], [[0, 0, 0.5], [0, 0, 0]]) },

  // ── 3x3 complex Hermitian (Gram exercises convergence) ─────────────────
  { description: "3x3 tridiagonal Hermitian sweep convergence",
    input: inp(
      [[1, 0.5, 0], [0.5, 2, 0.5], [0, 0.5, 3]],
      [[0, 0.5, 0], [-0.5, 0, 0.5], [0, -0.5, 0]],
    ) },

  // ── density operators (qinfo downstream use case) ────────────────────────
  { description: "rho=|0><0| pure projector S=[1,0]", input: realM([[1, 0], [0, 0]]) },
  { description: "rho=I/2 maximally mixed S=[0.5,0.5]", input: realM([[0.5, 0], [0, 0.5]]) },
  { description: "rho with Bloch Y component dogfood target",
    input: inp([[0.6, 0.2], [0.2, 0.4]], [[0, -0.25], [0.25, 0]]) },

  // ── 4x4 multi-qubit ──────────────────────────────────────────────────────
  { description: "Z tensor Z diag(1 -1 -1 1) S=[1,1,1,1]",
    input: realM([[1, 0, 0, 0], [0, -1, 0, 0], [0, 0, -1, 0], [0, 0, 0, 1]]) },
  { description: "Bell-state density rank-1 S=[1,0,0,0]",
    input: realM([
      [0.5, 0, 0, 0.5],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0.5, 0, 0, 0.5],
    ]) },
  { description: "X tensor Y complex Hermitian S=[1,1,1,1]",
    input: inp(
      [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]],
      [[0, 0, 0, -1], [0, 0, 1, 0], [0, -1, 0, 0], [1, 0, 0, 0]],
    ) },

  // ── rank-deficient and ill-conditioned ──────────────────────────────────
  { description: "2x2 rank-1 outer product S=[2,0]",
    input: realM([[1, 1], [1, 1]]) },
  { description: "3x3 well-separated diag(1e-8 1 1e8) span 16 orders",
    input: realM([[1e-8, 0, 0], [0, 1, 0], [0, 0, 1e8]]) },
  { description: "near-degenerate diag(1 1+1e-10 2)",
    input: realM([[1, 0, 0], [0, 1 + 1e-10, 0], [0, 0, 2]]) },

  // ── complete-mode cases ─────────────────────────────────────────────────
  { description: "complete mode 3x2 U is 3x3 V is 2x2 extra U col spans ker(M dagger)",
    input: realM([[1, 0], [0, 1], [0, 0]], "complete") },
  { description: "complete mode 2x3 U is 2x2 V is 3x3 extra V col spans ker(M)",
    input: realM([[1, 0, 0], [0, 1, 0]], "complete") },
  { description: "complete mode 2x2 complex Hermitian H=[[1,i],[-i,1]]",
    input: inp([[1, 0], [0, 1]], [[0, 1], [-1, 0]], "complete") },

  // ── boundary categories (ADR-0035 §D6) ──────────────────────────────────
  { description: "non-finite re NaN at re[1][1] tagged non-finite-input",
    input: inp([[1, 2], [3, NaN]], [[0, 0], [0, 0]]) },
  { description: "non-finite im Infinity at im[0][1] tagged non-finite-input",
    input: inp([[1, 2], [3, 4]], [[0, Infinity], [0, 0]]) },
  { description: "non-finite im negative Infinity at im[1][0]",
    input: inp([[1, 2], [3, 4]], [[0, 0], [-Infinity, 0]]) },
  { description: "degenerate shape m=0 tagged degenerate-shape",
    input: record({ re: list([]), im: list([]), mode: str("reduced") }) },
];
