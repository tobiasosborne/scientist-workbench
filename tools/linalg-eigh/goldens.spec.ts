// linalg-eigh goldens — 32 cases covering: shape edges, well-conditioned
// random symmetric, ill-conditioned (Hilbert), structured (Wilkinson, Pei),
// rank-deficient, repeated / near-degenerate eigenvalues, ill-conditioned
// (eigenvalues spanning many orders of magnitude), and every boundary
// category.
//
// The goldens file is the agent's quick-reference: each entry's
// description is what the registry surfaces. Cases are kept small here
// (per-tool goldens are the JSON-frozen baseline; the bench's
// 46-case 316-assertion battery in `bench/linalg-eigh/` is the heavier
// validation surface).

import {
  float64FromNumber,
  list,
  record,
  type Float64Value,
} from "@workbench/protocol";
import type { GoldenSpec } from "@workbench/contract";

function f(x: number): Float64Value { return float64FromNumber(x); }
function vec(xs: readonly number[]): { readonly kind: "list"; readonly items: readonly Float64Value[] } {
  return list(xs.map(f));
}
function mat(rows: readonly (readonly number[])[]): {
  readonly kind: "list";
  readonly items: readonly { readonly kind: "list"; readonly items: readonly Float64Value[] }[];
} {
  return list(rows.map((r) => vec(r)));
}
function inp(A: readonly (readonly number[])[]) {
  return record({ A: mat(A) });
}

// Hilbert(n) — the canonical SPD ill-conditioned family.
function hilbert(n: number): number[][] {
  const rows: number[][] = [];
  for (let i = 0; i < n; i++) {
    const r: number[] = [];
    for (let j = 0; j < n; j++) r.push(1 / (i + j + 1));
    rows.push(r);
  }
  return rows;
}

// Wilkinson tridiagonal W^+_n — diagonal of integers ⌊n/2⌋..−⌊n/2⌋,
// off-diagonal ones. The classical eigenvalue stress test.
function wilkinson(n: number): number[][] {
  if (n % 2 === 0) throw new Error("wilkinson expects odd n");
  const half = (n - 1) / 2;
  const rows: number[][] = [];
  for (let i = 0; i < n; i++) {
    const r = new Array<number>(n).fill(0);
    r[i] = Math.abs(half - i);
    if (i > 0) r[i - 1] = 1;
    if (i < n - 1) r[i + 1] = 1;
    rows.push(r);
  }
  return rows;
}

// Pei matrix αI + eeᵀ — rank-1 update of identity.  For symmetric
// eigh: (n-1) eigenvalues at α and one at α+n.
function pei(n: number, alpha: number): number[][] {
  const rows: number[][] = [];
  for (let i = 0; i < n; i++) {
    const r = new Array<number>(n).fill(1);
    r[i] = alpha + 1;
    rows.push(r);
  }
  return rows;
}

// Diagonal matrix from a list of eigenvalues.
function diag(lambda: readonly number[]): number[][] {
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
  // ── shape edges ──────────────────────────────────────────────────────────
  { description: "1x1 A=[[3]] lambda=[3]", input: inp([[3]]) },
  { description: "1x1 A=[[-2]] lambda=[-2]", input: inp([[-2]]) },
  { description: "2x2 identity lambda=[1,1]", input: inp([[1, 0], [0, 1]]) },
  { description: "2x2 zero lambda=[0,0]", input: inp([[0, 0], [0, 0]]) },
  { description: "3x3 identity lambda=[1,1,1]", input: inp([[1, 0, 0], [0, 1, 0], [0, 0, 1]]) },
  { description: "5x5 identity", input: inp(diag([1, 1, 1, 1, 1])) },

  // ── diagonal: eigenvalues are the diagonal entries (sorted) ──────────────
  { description: "diag(3 1 4 1 5) sorted ascending lambda=[1 1 3 4 5]", input: inp(diag([3, 1, 4, 1, 5])) },
  { description: "diag(2 4 8) sorted lambda=[2 4 8]", input: inp(diag([2, 4, 8])) },
  { description: "diag(-3 -1 0 2 5) negative and zero eigenvalues", input: inp(diag([-3, -1, 0, 2, 5])) },

  // ── small symmetric ──────────────────────────────────────────────────────
  { description: "2x2 symmetric [[2 1] [1 2]] lambda=[1 3]", input: inp([[2, 1], [1, 2]]) },
  { description: "3x3 symmetric simple", input: inp([
    [4, 1, 2],
    [1, 3, 0],
    [2, 0, 5],
  ]) },
  { description: "5x5 symmetric mixed signs", input: inp([
    [4, 1, 2, 0, 1],
    [1, -3, 0, 1, 0],
    [2, 0, 5, 1, -1],
    [0, 1, 1, 2, 0],
    [1, 0, -1, 0, -6],
  ]) },

  // ── permutation-like (symmetric) ─────────────────────────────────────────
  { description: "2x2 [[0 1] [1 0]] eigenvalues -1 1", input: inp([[0, 1], [1, 0]]) },

  // ── ill-conditioned (Hilbert SPD) ────────────────────────────────────────
  { description: "Hilbert 4 SPD condition 1.5e4", input: inp(hilbert(4)) },
  { description: "Hilbert 6 SPD condition 1.5e7", input: inp(hilbert(6)) },
  { description: "Hilbert 8 SPD condition 1.5e10 Jacobi advertisement", input: inp(hilbert(8)) },
  { description: "Hilbert 10 SPD condition 1.6e13", input: inp(hilbert(10)) },

  // ── structured eigenvalue stress ─────────────────────────────────────────
  { description: "Wilkinson tridiag W+ 5 symmetric clustered eigenvalues", input: inp(wilkinson(5)) },
  { description: "Wilkinson tridiag W+ 11", input: inp(wilkinson(11)) },
  { description: "Pei 5 alpha=1 (4 eigenvalues at 1 one at 6)", input: inp(pei(5, 1)) },

  // ── rank-deficient / repeated eigenvalues ───────────────────────────────
  { description: "rank-1 outer u uᵀ exactly one nonzero eigenvalue", input: inp([
    [1, 2, 3, 4],
    [2, 4, 6, 8],
    [3, 6, 9, 12],
    [4, 8, 12, 16],
  ]) },
  { description: "diag(1 1 1 2 2) repeated eigenvalues", input: inp(diag([1, 1, 1, 2, 2])) },
  { description: "all-zero 3x3 lambda=[0 0 0] rank=0", input: inp([
    [0, 0, 0], [0, 0, 0], [0, 0, 0],
  ]) },
  { description: "identity-with-zero-diagonal: diag(1 1 0 1 1) one zero eigenvalue", input: inp(diag([1, 1, 0, 1, 1])) },

  // ── near-degenerate eigenvalues ──────────────────────────────────────────
  { description: "near-degenerate diag(1 1+1e-10 2) tight gap", input: inp(diag([1, 1 + 1e-10, 2])) },
  { description: "clustered diag(1 1+1e-10 1+2e-10 1+3e-10 1+4e-10)", input: inp(diag([1, 1 + 1e-10, 1 + 2e-10, 1 + 3e-10, 1 + 4e-10])) },

  // ── well-separated extremes ──────────────────────────────────────────────
  { description: "well-separated diag(1e-8 1 1e8) span 16 orders", input: inp(diag([1e-8, 1, 1e8])) },
  { description: "alternating signs diag(-2 -1 0 1 2)", input: inp(diag([-2, -1, 0, 1, 2])) },

  // ── boundary categories ──────────────────────────────────────────────────
  { description: "non-symmetric input [[1 2] [3 4]] tagged non-symmetric-input", input: inp([[1, 2], [3, 4]]) },
  { description: "non-symmetric input antisymmetric tagged non-symmetric-input", input: inp([[0, 1], [-1, 0]]) },
  { description: "non-finite input NaN at A[1][1] tagged non-finite-input", input: inp([[1, 2], [2, NaN]]) },
  { description: "non-finite input Infinity at A[0][0] tagged non-finite-input", input: inp([[Infinity, 0], [0, 1]]) },
  { description: "degenerate shape n=0 tagged degenerate-shape", input: record({ A: list([]) }) },
];
