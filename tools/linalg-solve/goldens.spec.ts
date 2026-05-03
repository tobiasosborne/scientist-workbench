// linalg-solve goldens — 16 cases covering: identity, hand-checked,
// permutation, diagonal, triangular, Hilbert (ill-conditioned), bad-pivot
// growth (Wilkinson), and every boundary category.
//
// The goldens file is the agent's quick-reference: each entry's
// description is what the registry surfaces. Keep them readable.

import { float64FromNumber, list, record, type Float64Value } from "@workbench/protocol";
import type { GoldenSpec } from "@workbench/contract";

function f(x: number): Float64Value { return float64FromNumber(x); }
function vec(xs: readonly number[]): { readonly kind: "list"; readonly items: readonly Float64Value[] } {
  return list(xs.map(f));
}
function mat(rows: readonly (readonly number[])[]): { readonly kind: "list"; readonly items: readonly { readonly kind: "list"; readonly items: readonly Float64Value[] }[] } {
  return list(rows.map((r) => vec(r)));
}
function inp(A: readonly (readonly number[])[], b: readonly number[]) {
  return record({ A: mat(A), b: vec(b) });
}

export const goldens: GoldenSpec[] = [
  // ── identities ───────────────────────────────────────────────────────────
  { description: "identity 2x2: x = b", input: inp([[1, 0], [0, 1]], [3, 5]) },
  { description: "identity 3x3: x = b", input: inp([[1, 0, 0], [0, 1, 0], [0, 0, 1]], [1, 2, 3]) },
  { description: "identity 5x5 with non-trivial b", input: inp(
    [[1, 0, 0, 0, 0], [0, 1, 0, 0, 0], [0, 0, 1, 0, 0], [0, 0, 0, 1, 0], [0, 0, 0, 0, 1]],
    [1.5, -2.25, 3.75, 0, 100],
  )},

  // ── hand-checked ─────────────────────────────────────────────────────────
  { description: "2x2 [[2,1],[1,3]] x = [4,5] → [7/5, 6/5]", input: inp([[2, 1], [1, 3]], [4, 5]) },
  { description: "diag(2,4,8) x = [4,12,32] → [2, 3, 4]", input: inp([[2, 0, 0], [0, 4, 0], [0, 0, 8]], [4, 12, 32]) },
  { description: "upper triangular [[1,2,3],[0,1,4],[0,0,1]] x = [6,5,1]", input: inp(
    [[1, 2, 3], [0, 1, 4], [0, 0, 1]], [6, 5, 1],
  )},

  // ── pivoting / permutations ──────────────────────────────────────────────
  { description: "permutation [[0,1,0],[0,0,1],[1,0,0]] x = [7,13,19] → [19,7,13]", input: inp(
    [[0, 1, 0], [0, 0, 1], [1, 0, 0]], [7, 13, 19],
  )},
  { description: "swap-required [[0,1],[1,0]] x = [3,7]", input: inp([[0, 1], [1, 0]], [3, 7]) },

  // ── ill-conditioned ──────────────────────────────────────────────────────
  { description: "Hilbert(3) x = e_1: condition_estimate flags ill-posedness", input: inp(
    [[1, 1 / 2, 1 / 3], [1 / 2, 1 / 3, 1 / 4], [1 / 3, 1 / 4, 1 / 5]],
    [1, 0, 0],
  )},
  { description: "Hilbert(4) x = e_1: warnings list populated", input: inp(
    [
      [1, 1 / 2, 1 / 3, 1 / 4],
      [1 / 2, 1 / 3, 1 / 4, 1 / 5],
      [1 / 3, 1 / 4, 1 / 5, 1 / 6],
      [1 / 4, 1 / 5, 1 / 6, 1 / 7],
    ],
    [1, 0, 0, 0],
  )},

  // ── pivot growth (Wilkinson construction) ────────────────────────────────
  { description: "Wilkinson growth-5: growth_factor warning", input: inp(
    [
      [1, 0, 0, 0, 1],
      [-1, 1, 0, 0, 1],
      [-1, -1, 1, 0, 1],
      [-1, -1, -1, 1, 1],
      [-1, -1, -1, -1, 1],
    ],
    [1, 1, 1, 1, 1],
  )},

  // ── boundary categories ──────────────────────────────────────────────────
  { description: "exactly singular [[1,2],[2,4]] tagged singular", input: inp([[1, 2], [2, 4]], [1, 2]) },
  { description: "all-zeros 3x3 tagged singular at row 0", input: inp([[0, 0, 0], [0, 0, 0], [0, 0, 0]], [1, 2, 3]) },

  // ── well-conditioned, larger ─────────────────────────────────────────────
  { description: "diagonally dominant 4x4: residual ~ eps", input: inp(
    [[10, 1, 0, 0], [1, 10, 1, 0], [0, 1, 10, 1], [0, 0, 1, 10]],
    [11, 12, 12, 11],
  )},
  { description: "tridiagonal 6x6 (-1, 2, -1) discrete Laplacian", input: inp(
    [
      [2, -1, 0, 0, 0, 0],
      [-1, 2, -1, 0, 0, 0],
      [0, -1, 2, -1, 0, 0],
      [0, 0, -1, 2, -1, 0],
      [0, 0, 0, -1, 2, -1],
      [0, 0, 0, 0, -1, 2],
    ],
    [1, 0, 0, 0, 0, 1],
  )},
  { description: "negative-pivot pathway: [[-2, 1], [1, -3]] x = [-3, -7]", input: inp(
    [[-2, 1], [1, -3]], [-3, -7],
  )},
];
