// linalg-qr goldens — 33 cases covering: shape edges, well-conditioned
// random, ill-conditioned (Hilbert / Vandermonde), structured (Wilkinson),
// rank-deficient, tall and fat rectangles, complete-mode, and every
// boundary category.
//
// The goldens file is the agent's quick-reference: each entry's
// description is what the registry surfaces. Cases are kept small here
// (per-tool goldens are the JSON-frozen baseline; the bench's
// 49-case 343-assertion battery in `bench/linalg-qr/` is the heavier
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

export const goldens: GoldenSpec[] = [
  // ── shape edges ──────────────────────────────────────────────────────────
  { description: "1x1 reduced A=[[3]] R[0,0]=-3", input: inp([[3]]) },
  { description: "1x1 reduced A=[[-2]] negative diagonal", input: inp([[-2]]) },
  { description: "2x1 tall norm sqrt 5", input: inp([[1], [2]]) },
  { description: "1x2 fat m lt n Q is 1x1 R is 1x2", input: inp([[1, 2]]) },
  { description: "2x2 identity", input: inp([[1, 0], [0, 1]]) },
  { description: "2x2 zero R is zero Q is identity", input: inp([[0, 0], [0, 0]]) },
  { description: "3x3 identity", input: inp([[1, 0, 0], [0, 1, 0], [0, 0, 1]]) },

  // ── hand-checked sign convention ─────────────────────────────────────────
  { description: "[3,4]T column R[0,0] = -5 (Householder sign convention)", input: inp([[3, 0], [4, 0]]) },
  { description: "[-3,4]T column R[0,0] = +5 (sign flips when x[0]<0)", input: inp([[-3, 0], [4, 0]]) },

  // ── standard well-conditioned ────────────────────────────────────────────
  { description: "5x3 simple tall (matches bench A_5x3)", input: inp(
    [[1, 2, 3], [4, 5, 6], [7, 8, 10], [1, 0, 1], [0, 1, 0]],
  )},
  { description: "3x5 short and fat (matches bench A_3x5)", input: inp(
    [[1, 2, 3, 4, 5], [2, 1, 0, -1, 1], [3, 0, -1, 2, 1]],
  )},
  { description: "diagonal 2 4 8 R is diag with sign convention", input: inp(
    [[2, 0, 0], [0, 4, 0], [0, 0, 8]],
  )},
  { description: "upper triangular 1 2 3 / 0 1 4 / 0 0 1 Q is plus or minus I", input: inp(
    [[1, 2, 3], [0, 1, 4], [0, 0, 1]],
  )},

  // ── permutation-like ─────────────────────────────────────────────────────
  { description: "0 1 / 1 0 row swap permutation", input: inp([[0, 1], [1, 0]]) },
  { description: "permutation 0 1 0 / 0 0 1 / 1 0 0", input: inp(
    [[0, 1, 0], [0, 0, 1], [1, 0, 0]],
  )},

  // ── ill-conditioned (the Householder discriminator) ──────────────────────
  { description: "Hilbert 4 condition 1.5e4", input: inp(hilbert(4)) },
  { description: "Hilbert 6 condition 1.5e7 MGS would drift", input: inp(hilbert(6)) },
  { description: "Hilbert 8 condition 1.5e10 MGS fails orthogonality", input: inp(hilbert(8)) },
  { description: "Hilbert 10 condition 1.6e13 Householder still order epsilon", input: inp(hilbert(10)) },
  { description: "Vandermonde 5 polynomial node basis", input: inp(vandermonde(5)) },
  { description: "Vandermonde 8 condition grows exponentially", input: inp(vandermonde(8)) },

  // ── Wilkinson family ─────────────────────────────────────────────────────
  { description: "Wilkinson tridiag W+ 5", input: inp(wilkinson(5)) },
  { description: "Wilkinson tridiag W+ 11", input: inp(wilkinson(11)) },

  // ── rank-deficient (in-scope, Householder still works) ──────────────────
  { description: "rank-1 outer product reveals rank one in diag(R)", input: inp(
    [[1, -1, 2], [2, -2, 4], [3, -3, 6], [4, -4, 8]],
  )},
  { description: "identity with zero column at j 2 R[2 2] is zero", input: inp(
    [[1, 0, 0, 0, 0], [0, 1, 0, 0, 0], [0, 0, 0, 0, 0], [0, 0, 0, 1, 0], [0, 0, 0, 0, 1]],
  )},
  { description: "all zero 3x3 R is zero Q is identity", input: inp([[0, 0, 0], [0, 0, 0], [0, 0, 0]]) },

  // ── tall / fat ───────────────────────────────────────────────────────────
  { description: "tall 6x2 standard regression shape", input: inp(
    [[1, 1], [1, 2], [1, 3], [1, 4], [1, 5], [1, 6]],
  )},
  { description: "fat 2x6 complement of regression shape", input: inp(
    [[1, 1, 1, 1, 1, 1], [1, 2, 3, 4, 5, 6]],
  )},

  // ── complete-mode (all three cases below request mode complete) ──────────
  { description: "complete-mode 5x3 Q is 5x5 bottom 2 rows of R are zero", input: inpMode(
    [[1, 2, 3], [4, 5, 6], [7, 8, 10], [1, 0, 1], [0, 1, 0]],
    "complete",
  )},
  { description: "complete-mode Hilbert 4 full 4x4 Q coincides with reduced", input: inpMode(
    hilbert(4),
    "complete",
  )},
  { description: "complete-mode 3x5 m lt n no extra Q columns", input: inpMode(
    [[1, 2, 3, 4, 5], [2, 1, 0, -1, 1], [3, 0, -1, 2, 1]],
    "complete",
  )},

  // ── boundary categories ──────────────────────────────────────────────────
  { description: "non-finite input NaN at A[1][1] tagged non-finite-input", input: inp(
    [[1, 2], [3, NaN]],
  )},
  { description: "non-finite input Infinity at A[0][0] tagged non-finite-input", input: inp(
    [[Infinity, 0], [0, 1]],
  )},
  { description: "degenerate shape m equals 0 tagged degenerate-shape", input: record({ A: list([]) }) },
];
