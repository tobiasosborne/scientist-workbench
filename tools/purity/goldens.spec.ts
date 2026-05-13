// purity goldens — coverage across the v0.1 Hermitian path's full
// frontier: pure projectors (γ = 1), maximally mixed (γ = 1/d) at
// several d, Bloch density operators (real and complex Hermitian),
// rank-2 mixtures sweeping the [1/d, 1] interval, multi-qubit
// product / entangled state projectors, mixed-sign Hermitian
// operators (γ > 1 — observable, not density), and every boundary
// category.
//
// The sum-of-squares formula γ = Σ_{i,j} (re² + im²) makes every
// expected output computable by hand from the input matrix — the
// goldens are pure-data ground truth.

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

/** Build the purity input record `{rho: <complex matrix>}`. */
function inp(reRows: readonly (readonly number[])[], imRows: readonly (readonly number[])[]) {
  return record({ rho: complexM(reRows, imRows) });
}

/** Real-Hermitian shorthand: all-zero imaginary part. */
function realH(A: readonly (readonly number[])[]) {
  const n = A.length;
  const zeros: number[][] = [];
  for (let i = 0; i < n; i++) zeros.push(new Array<number>(A[0]!.length).fill(0));
  return inp(A, zeros);
}

export const goldens: GoldenSpec[] = [
  // ── pure projectors: rank-1 Hermitian, γ = 1 ─────────────────────────────
  { description: "rho=|0><0| computational pure state γ=1",
    input: realH([[1, 0], [0, 0]]) },
  { description: "rho=|1><1| computational pure state γ=1",
    input: realH([[0, 0], [0, 1]]) },
  { description: "rho=|+><+| superposition pure state γ=1",
    input: realH([[0.5, 0.5], [0.5, 0.5]]) },
  { description: "rho=|-><-| superposition pure state γ=1",
    input: realH([[0.5, -0.5], [-0.5, 0.5]]) },
  { description: "rho=|+i><+i| Pauli-Y eigenstate complex-Hermitian γ=1",
    input: inp([[0.5, 0], [0, 0.5]], [[0, -0.5], [0.5, 0]]) },
  { description: "rho=|-i><-i| Pauli-Y eigenstate complex-Hermitian γ=1",
    input: inp([[0.5, 0], [0, 0.5]], [[0, 0.5], [-0.5, 0]]) },

  // ── maximally mixed: γ = 1/d ────────────────────────────────────────────
  { description: "rho=I_2/2 one-qubit max-mixed γ=1/2",
    input: realH([[0.5, 0], [0, 0.5]]) },
  { description: "rho=I_3/3 qutrit max-mixed γ=1/3",
    input: realH([[1 / 3, 0, 0], [0, 1 / 3, 0], [0, 0, 1 / 3]]) },
  { description: "rho=I_4/4 two-qubit max-mixed γ=1/4",
    input: realH([
      [0.25, 0, 0, 0],
      [0, 0.25, 0, 0],
      [0, 0, 0.25, 0],
      [0, 0, 0, 0.25],
    ]) },

  // ── rank-2 mixtures: γ = p² + (1-p)² ∈ [1/2, 1] ─────────────────────────
  { description: "rho=diag(0.7, 0.3) classical bit γ=0.58",
    input: realH([[0.7, 0], [0, 0.3]]) },
  { description: "rho=diag(0.9, 0.1) near-pure mixture γ=0.82",
    input: realH([[0.9, 0], [0, 0.1]]) },
  { description: "rho=diag(0.99, 0.01) very-near-pure γ=0.9802 - within tol of 1 but not flagged pure",
    input: realH([[0.99, 0], [0, 0.01]]) },

  // ── Bloch density operators (with Y-component → complex Hermitian) ──────
  { description: "rho=(I+0.5 X+0.3 Z)/2 Bloch X-Z plane γ=0.5·(1 + 0.34) = 0.67",
    input: realH([[0.65, 0.25], [0.25, 0.35]]) },
  { description: "rho=(I+0.4 X+0.5 Y+0.2 Z)/2 Bloch with Y component complex-Hermitian γ=0.5·(1+0.45)=0.725 dogfood target",
    input: inp([[0.6, 0.2], [0.2, 0.4]], [[0, -0.25], [0.25, 0]]) },
  { description: "rho=(I+0.6 Y)/2 Bloch-Y only complex-Hermitian γ=0.68",
    input: inp([[0.5, 0], [0, 0.5]], [[0, -0.3], [0.3, 0]]) },

  // ── two-qubit Bell projector (rank-1 pure state, γ = 1) ─────────────────
  { description: "rho=|Phi+><Phi+| Bell pure state γ=1",
    input: realH([
      [0.5, 0, 0, 0.5],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0.5, 0, 0, 0.5],
    ]) },
  { description: "rho=|Psi-><Psi-| Bell pure state with phase γ=1",
    input: realH([
      [0, 0, 0, 0],
      [0, 0.5, -0.5, 0],
      [0, -0.5, 0.5, 0],
      [0, 0, 0, 0],
    ]) },

  // ── two-qubit product (γ = 1 for product of pures) ──────────────────────
  { description: "rho=|0+><0+| product of pures γ=1",
    input: realH([
      [0.5, 0.5, 0, 0],
      [0.5, 0.5, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
    ]) },

  // ── multi-qubit mixed (entanglement signature) ──────────────────────────
  { description: "rho=(|00><00|+|11><11|)/2 separable classical mix γ=1/2",
    input: realH([
      [0.5, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0.5],
    ]) },

  // ── observable (Hermitian, not normalised to density operator) ──────────
  // Pauli matrices have eigenvalues ±1, so γ = 2 (warns: not a density op).
  { description: "rho=Pauli X observable γ=2 trace=0 warn-not-density",
    input: realH([[0, 1], [1, 0]]) },
  { description: "rho=Pauli Y observable complex-Hermitian γ=2 warn-not-density",
    input: inp([[0, 0], [0, 0]], [[0, -1], [1, 0]]) },
  { description: "rho=Pauli Z observable γ=2 warn-not-density",
    input: realH([[1, 0], [0, -1]]) },

  // ── identity-norm observable (γ = d, not bounded by 1) ──────────────────
  { description: "rho=I_2 unnormalised identity γ=2 trace=2 warn-not-density",
    input: realH([[1, 0], [0, 1]]) },
  { description: "rho=I_3 unnormalised identity γ=3 trace=3 warn-not-density",
    input: realH([[1, 0, 0], [0, 1, 0], [0, 0, 1]]) },

  // ── generic complex Hermitian (γ via sum-of-squares) ────────────────────
  { description: "rho=[[1, 1+i], [1-i, 1]]/3 generic complex Hermitian density operator",
    input: inp([[1 / 3, 1 / 3], [1 / 3, 1 / 3]], [[0, 1 / 3], [-1 / 3, 0]]) },

  // ── degenerate spectra (multiplicity ≥ 2) ───────────────────────────────
  { description: "rho=diag(1/3, 1/3, 1/3) trivially degenerate γ=1/3",
    input: realH([[1 / 3, 0, 0], [0, 1 / 3, 0], [0, 0, 1 / 3]]) },
  { description: "rho=zeros_3 the zero operator γ=0 trace=0 warn-not-density",
    input: realH([[0, 0, 0], [0, 0, 0], [0, 0, 0]]) },

  // ── 5×5 real symmetric (the bigger stress) ──────────────────────────────
  { description: "5x5 real symmetric mixed signs observable γ=Σ entries²",
    input: realH([
      [4, 1, 2, 0, 1],
      [1, -3, 0, 1, 0],
      [2, 0, 5, 1, -1],
      [0, 1, 1, 2, 0],
      [1, 0, -1, 0, -6],
    ]) },

  // ── boundary categories ─────────────────────────────────────────────────
  // Non-Hermitian: re asymmetric.
  { description: "non-Hermitian via re-asymmetric tagged non-hermitian-input",
    input: realH([[1, 2], [3, 0]]) },
  // Non-Hermitian: im symmetric (should be antisymmetric for Hermitian).
  { description: "non-Hermitian via symmetric im tagged non-hermitian-input",
    input: inp([[0, 1], [1, 0]], [[0, 1], [1, 0]]) },
  // Non-Hermitian: nonzero imaginary on diagonal.
  { description: "non-Hermitian via nonzero diagonal imaginary tagged non-hermitian-input",
    input: inp([[1, 0], [0, 0]], [[1, 0], [0, 0]]) },
  // Non-finite re.
  { description: "non-finite re NaN at re[1][1] tagged non-finite-input",
    input: inp([[1, 0], [0, NaN]], [[0, 0], [0, 0]]) },
  // Non-finite im.
  { description: "non-finite im Infinity at im[0][1] tagged non-finite-input",
    input: inp([[1, 0], [0, 1]], [[0, Infinity], [-Infinity, 0]]) },
  // Degenerate (n=0).
  { description: "degenerate shape n=0 tagged degenerate-shape",
    input: record({ rho: record({ re: list([]), im: list([]) }) }) },
];
