// linalg-eigh-complex goldens — 33 cases covering the embedding's complete
// frontier: real-only inputs (the cheap fall-through), single-qubit Pauli
// fixtures, multi-qubit Hamiltonians, density operators (real and complex
// Bloch), Hermitian matrices with structured spectra (clustered,
// degenerate, ill-conditioned), and every boundary category from
// ADR-0035 §D6. ToolError cases (shape mismatch, non-square, ragged)
// are covered by unit tests in `tools/linalg-eigh-complex/tool.ts` and
// the substrate's eigh-complex.ts — goldens only freeze admissible
// outputs (success records + tagged boundaries).
//
// The goldens file is the agent's quick-reference; each entry's
// description is what the registry surfaces. Cases are kept small
// here (per-tool goldens are the JSON-frozen baseline); larger
// stress fixtures land in the bench corpus when the corpus-side
// `bench/linalg-eigh-complex/` shard ships (filed under `ov4j`).

import {
  float64FromNumber,
  list,
  record,
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
 * both `re` and `im` are present, rectangular, and same shape.
 */
function inp(reRows: readonly (readonly number[])[], imRows: readonly (readonly number[])[]) {
  return record({ re: mat(reRows), im: mat(imRows) });
}

/**
 * Real-symmetric Hermitian: H = A + 0·i. Convenience for the cheap
 * fall-through case where the embedded H̃ is block-diagonal and the
 * real eigh runs on A twice. The qinfo dogfood's "Bloch X-Z plane
 * only" workaround lives in this corner of input space.
 */
function realH(A: readonly (readonly number[])[]) {
  const n = A.length;
  const zeros: number[][] = [];
  for (let i = 0; i < n; i++) zeros.push(new Array<number>(A[0]!.length).fill(0));
  return inp(A, zeros);
}

/** Diagonal Hermitian from a real eigenvalue list. */
function diagH(lambda: readonly number[]): readonly (readonly number[])[] {
  const n = lambda.length;
  const rows: number[][] = [];
  for (let i = 0; i < n; i++) {
    const r = new Array<number>(n).fill(0);
    r[i] = lambda[i]!;
    rows.push(r);
  }
  return rows;
}

export const goldens: GoldenSpec[] = [
  // ── shape edges (real-valued, cheap fall-through) ────────────────────────
  { description: "1x1 H=[[3]] lambda=[3]", input: realH([[3]]) },
  { description: "1x1 H=[[-2]] lambda=[-2]", input: realH([[-2]]) },
  { description: "2x2 identity lambda=[1,1]", input: realH([[1, 0], [0, 1]]) },
  { description: "2x2 zero lambda=[0,0]", input: realH([[0, 0], [0, 0]]) },
  { description: "3x3 identity lambda=[1,1,1]", input: realH([[1, 0, 0], [0, 1, 0], [0, 0, 1]]) },

  // ── Pauli family (the canonical single-qubit fixtures) ───────────────────
  { description: "Pauli X re=[[0,1],[1,0]] im=0 eigenvalues -1 1", input: realH([[0, 1], [1, 0]]) },
  { description: "Pauli Y re=0 im=[[0,-1],[1,0]] eigenvalues -1 1 complex eigenvectors", input: inp([[0, 0], [0, 0]], [[0, -1], [1, 0]]) },
  { description: "Pauli Z re=[[1,0],[0,-1]] im=0 eigenvalues -1 1", input: realH([[1, 0], [0, -1]]) },

  // ── Hermitian 2x2 with imaginary off-diagonal ────────────────────────────
  { description: "2x2 [[1,i],[-i,1]] eigenvalues 0 2", input: inp([[1, 0], [0, 1]], [[0, 1], [-1, 0]]) },
  { description: "2x2 [[2, 1+i],[1-i, 0]] generic complex Hermitian", input: inp([[2, 1], [1, 0]], [[0, 1], [-1, 0]]) },
  { description: "2x2 phase off-diagonal eigenvalues +-1",
    input: inp([[0, Math.SQRT1_2], [Math.SQRT1_2, 0]], [[0, Math.SQRT1_2], [-Math.SQRT1_2, 0]]) },

  // ── density operators (the qinfo downstream use case) ────────────────────
  { description: "rho=|0><0| pure projector eigenvalues 0 1", input: realH([[1, 0], [0, 0]]) },
  { description: "rho=I/2 maximally mixed degenerate spectrum 1/2 1/2", input: realH([[0.5, 0], [0, 0.5]]) },
  { description: "rho=(I+0.7 Z)/2 Bloch along z eigenvalues 0.15 0.85", input: realH([[0.85, 0], [0, 0.15]]) },
  { description: "rho=(I+0.5 X+0.3 Z)/2 Bloch X-Z plane real-Hermitian",
    input: realH([[0.65, 0.25], [0.25, 0.35]]) },
  { description: "rho=(I+0.4 X+0.5 Y+0.2 Z)/2 Bloch with Y component the dogfood target",
    input: inp([[0.6, 0.2], [0.2, 0.4]], [[0, -0.25], [0.25, 0]]) },

  // ── 3x3 ─────────────────────────────────────────────────────────────────
  { description: "diag(3 1 4) lambda ascending=[1 3 4]", input: realH(diagH([3, 1, 4])) },
  { description: "3x3 real symmetric simple", input: realH([
    [4, 1, 2],
    [1, 3, 0],
    [2, 0, 5],
  ]) },
  { description: "3x3 Hermitian with one imaginary off-diagonal",
    input: inp(
      [[1, 2, 0], [2, 3, 1], [0, 1, 2]],
      [[0, 0, 1], [0, 0, 0], [-1, 0, 0]],
    ) },

  // ── 4x4 (multi-qubit territory) ─────────────────────────────────────────
  { description: "Z tensor Z two-qubit Hamiltonian diag(1 -1 -1 1)", input: realH(diagH([1, -1, -1, 1])) },
  { description: "Bell-state density |Phi+><Phi+| rank-1 eigenvalues 0 0 0 1",
    input: realH([
      [0.5, 0, 0, 0.5],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0.5, 0, 0, 0.5],
    ]) },
  { description: "X tensor Y two-qubit complex Hermitian eigenvalues degenerate +-1",
    input: inp(
      [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]],
      [[0, 0, 0, -1], [0, 0, 1, 0], [0, -1, 0, 0], [1, 0, 0, 0]],
    ) },

  // ── 5x5 and larger ──────────────────────────────────────────────────────
  { description: "diag(-3 -1 0 2 5) real Hermitian with negative and zero eigenvalues", input: realH(diagH([-3, -1, 0, 2, 5])) },
  { description: "5x5 symmetric mixed signs (real)", input: realH([
    [4, 1, 2, 0, 1],
    [1, -3, 0, 1, 0],
    [2, 0, 5, 1, -1],
    [0, 1, 1, 2, 0],
    [1, 0, -1, 0, -6],
  ]) },

  // ── degenerate and clustered spectra (the MGS cleanup path) ──────────────
  { description: "diag(1 1 1 2 2) repeated eigenvalues exercise the MGS pass", input: realH(diagH([1, 1, 1, 2, 2])) },
  { description: "all-zero 3x3 lambda=[0 0 0]", input: realH([[0, 0, 0], [0, 0, 0], [0, 0, 0]]) },
  { description: "near-degenerate diag(1 1+1e-10 2)", input: realH(diagH([1, 1 + 1e-10, 2])) },

  // ── well-separated extremes ─────────────────────────────────────────────
  { description: "well-separated diag(1e-8 1 1e8) span 16 orders", input: realH(diagH([1e-8, 1, 1e8])) },

  // ── boundary categories (ADR-0035 §D6) ──────────────────────────────────
  { description: "non-Hermitian via symmetric im tagged non-hermitian-input",
    input: inp([[0, 1], [1, 0]], [[0, 1], [1, 0]]) },
  { description: "non-Hermitian via nonzero diagonal imaginary tagged non-hermitian-input",
    input: inp([[1, 0], [0, 0]], [[1, 0], [0, 0]]) },
  { description: "non-Hermitian via re-asymmetric tagged non-hermitian-input",
    input: inp([[1, 2], [3, 4]], [[0, 0], [0, 0]]) },
  { description: "non-finite re NaN at re[1][1] tagged non-finite-input",
    input: inp([[1, 2], [2, NaN]], [[0, 0], [0, 0]]) },
  { description: "non-finite im Infinity at im[0][1] tagged non-finite-input",
    input: inp([[1, 2], [2, 1]], [[0, Infinity], [-Infinity, 0]]) },
  { description: "degenerate shape n=0 tagged degenerate-shape",
    input: record({ re: list([]), im: list([]) }) },
];
