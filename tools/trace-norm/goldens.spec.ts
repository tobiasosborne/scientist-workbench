// trace-norm goldens — 36 cases covering the v0.1 Hermitian path's full
// frontier: identity sizes (||I_n||_1 = n exact), pure projectors and
// rank-1 operators (||·||_1 = 1), maximally mixed density operators
// (||I/d||_1 = 1), the single-qubit Pauli matrices (each Hermitian with
// ||·||_1 = 2), real and complex Bloch density operators (the qinfo
// dogfood-named workload), generic complex Hermitian, mixed-sign
// diagonals (the Σ |·| over signed eigenvalues), multi-qubit Hamiltonians,
// degenerate spectra (the eigh MGS pass), well-separated extremes,
// and every boundary category.

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

/** Wrap parallel re/im nested arrays in the canonical complex-matrix
 *  wire shape (ADR-0035 §D2). */
function complexM(reRows: readonly (readonly number[])[], imRows: readonly (readonly number[])[]) {
  return record({ re: mat(reRows), im: mat(imRows) });
}

/** Build the trace-norm input record `{M: <complex matrix>}`. */
function inp(reRows: readonly (readonly number[])[], imRows: readonly (readonly number[])[]) {
  return record({ M: complexM(reRows, imRows) });
}

/** Real-Hermitian input shorthand: all-zero imaginary part. */
function realH(A: readonly (readonly number[])[]) {
  const n = A.length;
  const zeros: number[][] = [];
  for (let i = 0; i < n; i++) zeros.push(new Array<number>(A[0]!.length).fill(0));
  return inp(A, zeros);
}

/** Build I_n. */
function identity(n: number): readonly (readonly number[])[] {
  const rows: number[][] = [];
  for (let i = 0; i < n; i++) {
    const r = new Array<number>(n).fill(0);
    r[i] = 1;
    rows.push(r);
  }
  return rows;
}

/** Diagonal from a list of real eigenvalues. */
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
  // ── identity sizes: ||I_n||_1 = n (real-Hermitian cheap path) ────────────
  { description: "||I_1||_1 = 1", input: realH(identity(1)) },
  { description: "||I_2||_1 = 2", input: realH(identity(2)) },
  { description: "||I_3||_1 = 3", input: realH(identity(3)) },
  { description: "||I_5||_1 = 5", input: realH(identity(5)) },

  // ── pure projectors: rank-1 Hermitian with ||·||_1 = 1 ───────────────────
  { description: "rho=|0><0| pure projector ||rho||_1 = 1",
    input: realH([[1, 0], [0, 0]]) },
  { description: "rho=|1><1| pure projector ||rho||_1 = 1",
    input: realH([[0, 0], [0, 1]]) },
  { description: "rho=|Phi+><Phi+| Bell projector rank-1 ||rho||_1 = 1",
    input: realH([
      [0.5, 0, 0, 0.5],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0.5, 0, 0, 0.5],
    ]) },

  // ── maximally mixed: ||I_d/d||_1 = 1 ─────────────────────────────────────
  { description: "rho=I_2/2 one-qubit max-mixed ||rho||_1 = 1",
    input: realH([[0.5, 0], [0, 0.5]]) },
  { description: "rho=I_3/3 qutrit max-mixed ||rho||_1 = 1",
    input: realH([[1 / 3, 0, 0], [0, 1 / 3, 0], [0, 0, 1 / 3]]) },
  { description: "rho=I_4/4 two-qubit max-mixed ||rho||_1 = 1",
    input: realH(diagH([0.25, 0.25, 0.25, 0.25])) },

  // ── Pauli family: each is Hermitian with eigenvalues ±1 (||·||_1 = 2) ───
  { description: "||Pauli X||_1 = 2 real Hermitian",
    input: realH([[0, 1], [1, 0]]) },
  { description: "||Pauli Y||_1 = 2 complex Hermitian eigenvectors carry phase",
    input: inp([[0, 0], [0, 0]], [[0, -1], [1, 0]]) },
  { description: "||Pauli Z||_1 = 2 diagonal Hermitian",
    input: realH([[1, 0], [0, -1]]) },

  // ── density operators with Bloch vectors (the qinfo dogfood path) ────────
  { description: "rho=(I+0.7 Z)/2 Bloch along Z ||rho||_1 = 1",
    input: realH([[0.85, 0], [0, 0.15]]) },
  { description: "rho=(I+0.5 X+0.3 Z)/2 Bloch X-Z plane ||rho||_1 = 1",
    input: realH([[0.65, 0.25], [0.25, 0.35]]) },
  { description: "rho=(I+0.4 X+0.5 Y+0.2 Z)/2 Bloch with Y component complex Hermitian ||rho||_1 = 1 dogfood target",
    input: inp([[0.6, 0.2], [0.2, 0.4]], [[0, -0.25], [0.25, 0]]) },
  // Slightly skewed density operator: rho = diag(0.7, 0.3). ||·||_1 = 1.
  { description: "rho=diag(0.7,0.3) classical bit ||rho||_1 = 1",
    input: realH([[0.7, 0], [0, 0.3]]) },

  // ── generic complex Hermitian (eigenvalues span sign) ────────────────────
  { description: "||[[1, i], [-i, 1]]||_1 = 2 eigenvalues 0 and 2",
    input: inp([[1, 0], [0, 1]], [[0, 1], [-1, 0]]) },
  { description: "||[[2, 1+i],[1-i, 0]]||_1 generic complex Hermitian",
    input: inp([[2, 1], [1, 0]], [[0, 1], [-1, 0]]) },

  // ── mixed-sign diagonals (the |·| over signed eigenvalues) ───────────────
  { description: "||diag(-3, 1, 4)||_1 = 8",
    input: realH(diagH([-3, 1, 4])) },
  { description: "||diag(-2, -1, 0, 1, 2)||_1 = 6",
    input: realH(diagH([-2, -1, 0, 1, 2])) },
  { description: "||diag(-5, 5)||_1 = 10",
    input: realH(diagH([-5, 5])) },

  // ── multi-qubit Hamiltonians ─────────────────────────────────────────────
  { description: "||Z tensor Z||_1 = 4 two-qubit diag(1,-1,-1,1)",
    input: realH(diagH([1, -1, -1, 1])) },
  { description: "||X tensor Y||_1 = 4 two-qubit complex Hermitian eigenvalues +-1 degenerate",
    input: inp(
      [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]],
      [[0, 0, 0, -1], [0, 0, 1, 0], [0, -1, 0, 0], [1, 0, 0, 0]],
    ) },

  // ── degenerate spectra (exercises MGS via eigh-complex) ──────────────────
  { description: "||diag(1, 1, 1, 2, 2)||_1 = 7 repeated eigenvalues",
    input: realH(diagH([1, 1, 1, 2, 2])) },
  { description: "||zeros_3x3||_1 = 0 zero matrix",
    input: realH([[0, 0, 0], [0, 0, 0], [0, 0, 0]]) },

  // ── ill-conditioned (small eigenvalue floor) ─────────────────────────────
  { description: "||diag(1e-10, 1)||_1 = 1 + 1e-10 small eigenvalue",
    input: realH(diagH([1e-10, 1])) },

  // ── well-separated ───────────────────────────────────────────────────────
  { description: "||diag(1e-8, 1, 1e8)||_1 = 1e8 + 1 + 1e-8 span 16 orders",
    input: realH(diagH([1e-8, 1, 1e8])) },

  // ── 5×5 generic Hermitian (the substrate stress) ─────────────────────────
  { description: "5x5 real symmetric mixed signs",
    input: realH([
      [4, 1, 2, 0, 1],
      [1, -3, 0, 1, 0],
      [2, 0, 5, 1, -1],
      [0, 1, 1, 2, 0],
      [1, 0, -1, 0, -6],
    ]) },

  // ── non-Hermitian → SVD-path success (post-jao0 / ADR-0035 phase 2) ─────
  // These cases previously refused with tagged "trace-norm/non-hermitian-input";
  // they now route through svdComplex and produce numerical successes with
  // method="general-via-svd-complex" and singular_values populated.
  { description: "non-Hermitian symmetric-im case routes via SVD (was non-hermitian-refusal pre-jao0)",
    input: inp([[0, 1], [1, 0]], [[0, 1], [1, 0]]) },
  { description: "non-Hermitian nonzero-diagonal-imaginary case routes via SVD",
    input: inp([[1, 0], [0, 0]], [[1, 0], [0, 0]]) },
  { description: "non-Hermitian real-asymmetric M=[[1,2],[3,4]] routes via SVD",
    input: inp([[1, 2], [3, 4]], [[0, 0], [0, 0]]) },

  // ── boundary categories (remaining tagged refusals) ──────────────────────
  // Non-finite re.
  { description: "non-finite re NaN at re[1][1] tagged non-finite-input",
    input: inp([[1, 2], [2, NaN]], [[0, 0], [0, 0]]) },
  // Non-finite im.
  { description: "non-finite im Infinity at im[0][1] tagged non-finite-input",
    input: inp([[1, 2], [2, 1]], [[0, Infinity], [-Infinity, 0]]) },
  // Degenerate (n=0).
  { description: "degenerate shape n=0 tagged degenerate-shape",
    input: record({ M: complexM([], []) }) },
];
