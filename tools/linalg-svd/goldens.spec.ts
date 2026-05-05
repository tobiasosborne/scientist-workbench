// linalg-svd goldens — 33 cases covering: shape edges, well-conditioned
// random, ill-conditioned (Hilbert / Vandermonde), structured (Wilkinson,
// Pei, Frank), rank-deficient, tall and fat rectangles, complete-mode,
// and every boundary category.
//
// The goldens file is the agent's quick-reference: each entry's
// description is what the registry surfaces. Cases are kept small here
// (per-tool goldens are the JSON-frozen baseline; the bench's
// 49-case 392-assertion battery in `bench/linalg-svd/` is the heavier
// validation surface).

import {
  float64FromNumber,
  list,
  record,
  str,
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
function inpMode(A: readonly (readonly number[])[], mode: "reduced" | "complete") {
  return record({ A: mat(A), mode: str(mode) });
}

// Hilbert(n) — the canonical ill-conditioned family.
function hilbert(n: number): number[][] {
  const rows: number[][] = [];
  for (let i = 0; i < n; i++) {
    const r: number[] = [];
    for (let j = 0; j < n; j++) r.push(1 / (i + j + 1));
    rows.push(r);
  }
  return rows;
}

// Vandermonde(n) — Lagrange-node powers; columns are x^j for x in 1..n.
function vandermonde(n: number): number[][] {
  const rows: number[][] = [];
  for (let i = 0; i < n; i++) {
    const r: number[] = [];
    for (let j = 0; j < n; j++) r.push((i + 1) ** j);
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

// Pei matrix αI + eeᵀ — rank-1 update of identity. SVD should give
// (n-1) singular values clustered at α and one at α+n.
function pei(n: number, alpha: number): number[][] {
  const rows: number[][] = [];
  for (let i = 0; i < n; i++) {
    const r = new Array<number>(n).fill(1);
    r[i] = alpha + 1;
    rows.push(r);
  }
  return rows;
}

export const goldens: GoldenSpec[] = [
  // ── shape edges ──────────────────────────────────────────────────────────
  { description: "1x1 reduced A=[[3]] S=[3]", input: inp([[3]]) },
  { description: "1x1 reduced A=[[-2]] S=[2] (sign goes into U or Vt)", input: inp([[-2]]) },
  { description: "2x1 tall S=[sqrt 5]", input: inp([[1], [2]]) },
  { description: "1x2 fat m lt n U is 1x1 Vt is 1x2", input: inp([[1, 2]]) },
  { description: "2x2 identity S=[1,1]", input: inp([[1, 0], [0, 1]]) },
  { description: "2x2 zero S=[0,0] rank=0", input: inp([[0, 0], [0, 0]]) },
  { description: "3x3 identity S=[1,1,1]", input: inp([[1, 0, 0], [0, 1, 0], [0, 0, 1]]) },

  // ── standard well-conditioned ────────────────────────────────────────────
  { description: "5x3 simple tall (matches bench A_5x3)", input: inp(
    [[1, 2, 3], [4, 5, 6], [7, 8, 10], [1, 0, 1], [0, 1, 0]],
  )},
  { description: "3x5 short and fat (matches bench A_3x5)", input: inp(
    [[1, 2, 3, 4, 5], [2, 1, 0, -1, 1], [3, 0, -1, 2, 1]],
  )},
  { description: "diagonal 2 4 8 S sorted descending [8 4 2]", input: inp(
    [[2, 0, 0], [0, 4, 0], [0, 0, 8]],
  )},
  { description: "upper triangular 1 2 3 / 0 1 4 / 0 0 1", input: inp(
    [[1, 2, 3], [0, 1, 4], [0, 0, 1]],
  )},

  // ── permutation-like ─────────────────────────────────────────────────────
  { description: "0 1 / 1 0 row swap permutation S=[1,1]", input: inp([[0, 1], [1, 0]]) },
  { description: "permutation 3x3 cyclic shift S=[1,1,1]", input: inp(
    [[0, 1, 0], [0, 0, 1], [1, 0, 0]],
  )},

  // ── ill-conditioned (Jacobi accuracy advertisement) ──────────────────────
  { description: "Hilbert 4 condition 1.5e4", input: inp(hilbert(4)) },
  { description: "Hilbert 6 condition 1.5e7", input: inp(hilbert(6)) },
  { description: "Hilbert 8 condition 1.5e10 Jacobi reveals all 8 sigmas", input: inp(hilbert(8)) },
  { description: "Hilbert 10 condition 1.6e13", input: inp(hilbert(10)) },
  { description: "Vandermonde 5 polynomial node basis", input: inp(vandermonde(5)) },
  { description: "Vandermonde 8 condition grows exponentially", input: inp(vandermonde(8)) },

  // ── structured test matrices ─────────────────────────────────────────────
  { description: "Wilkinson tridiag W+ 5 symmetric clustered eigenvalues", input: inp(wilkinson(5)) },
  { description: "Wilkinson tridiag W+ 11", input: inp(wilkinson(11)) },
  { description: "Pei 5 alpha=1 (4 sigmas at 1 one at 6)", input: inp(pei(5, 1)) },

  // ── rank-deficient: SVD reveals rank ────────────────────────────────────
  { description: "rank-1 outer product u·vᵀ exactly one nonzero S", input: inp(
    [[1, -1, 2], [2, -2, 4], [3, -3, 6], [4, -4, 8]],
  )},
  { description: "identity with zero column at j 2 rank=4 S[4]=0", input: inp(
    [[1, 0, 0, 0, 0], [0, 1, 0, 0, 0], [0, 0, 0, 0, 0], [0, 0, 0, 1, 0], [0, 0, 0, 0, 1]],
  )},
  { description: "all zero 3x3 S=[0,0,0] rank=0", input: inp([[0, 0, 0], [0, 0, 0], [0, 0, 0]]) },

  // ── tall / fat ───────────────────────────────────────────────────────────
  { description: "tall 6x2 standard regression shape", input: inp(
    [[1, 1], [1, 2], [1, 3], [1, 4], [1, 5], [1, 6]],
  )},
  { description: "fat 2x6 complement of regression shape", input: inp(
    [[1, 1, 1, 1, 1, 1], [1, 2, 3, 4, 5, 6]],
  )},

  // ── complete-mode ────────────────────────────────────────────────────────
  { description: "complete-mode 5x3 U is 5x5 Vt is 3x3", input: inpMode(
    [[1, 2, 3], [4, 5, 6], [7, 8, 10], [1, 0, 1], [0, 1, 0]],
    "complete",
  )},
  { description: "complete-mode 3x5 U is 3x3 Vt is 5x5", input: inpMode(
    [[1, 2, 3, 4, 5], [2, 1, 0, -1, 1], [3, 0, -1, 2, 1]],
    "complete",
  )},
  { description: "complete-mode Hilbert 4 square (modes coincide for m=n)", input: inpMode(
    hilbert(4),
    "complete",
  )},

  // ── boundary categories ──────────────────────────────────────────────────
  { description: "non-finite input NaN at A[1][1] tagged non-finite-input", input: inp(
    [[1, 2], [3, NaN]],
  )},
  { description: "non-finite input Infinity at A[0][0] tagged non-finite-input", input: inp(
    [[Infinity, 0], [0, 1]],
  )},
  { description: "degenerate shape m=0 tagged degenerate-shape", input: record({ A: list([]) }) },
];
