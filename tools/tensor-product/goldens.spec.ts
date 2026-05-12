import { float64FromNumber, list, record } from "@workbench/protocol";
import type { GoldenSpec } from "@workbench/contract";

// Helper: 2D number array → list<list<float64>> Value.
function m(rows: number[][]): ReturnType<typeof list> {
  return list(rows.map((r) => list(r.map(float64FromNumber))));
}

// 10 goldens covering: identity composition, Pauli kron pairs, rectangular
// inputs, real ⊗ |0⟩⟨0| / |1⟩⟨1| sparsity, scalar (1×1) edge cases.
export const goldens: GoldenSpec[] = [
  {
    description: "I_2 ⊗ I_2 = I_4 (identity composition)",
    input: record({
      A: m([[1, 0], [0, 1]]),
      B: m([[1, 0], [0, 1]]),
    }),
  },
  {
    description: "|0⟩⟨0| ⊗ |1⟩⟨1| — single 1 at (1, 1)",
    input: record({
      A: m([[1, 0], [0, 0]]),
      B: m([[0, 0], [0, 1]]),
    }),
  },
  {
    description: "|1⟩⟨1| ⊗ |0⟩⟨0| — single 1 at (2, 2)",
    input: record({
      A: m([[0, 0], [0, 1]]),
      B: m([[1, 0], [0, 0]]),
    }),
  },
  {
    description: "Pauli X ⊗ Pauli X — anti-diagonal swap (4×4 cyclic shift by 3)",
    input: record({
      A: m([[0, 1], [1, 0]]),
      B: m([[0, 1], [1, 0]]),
    }),
  },
  {
    description: "Pauli Z ⊗ Pauli Z — diag(1, -1, -1, 1)",
    input: record({
      A: m([[1, 0], [0, -1]]),
      B: m([[1, 0], [0, -1]]),
    }),
  },
  {
    description: "diag(1, 2) ⊗ diag(3, 5) = diag(3, 5, 6, 10)",
    input: record({
      A: m([[1, 0], [0, 2]]),
      B: m([[3, 0], [0, 5]]),
    }),
  },
  {
    description: "rectangular: 2×3 ⊗ 3×2 = 6×6 (shape sanity)",
    input: record({
      A: m([[1, 2, 3], [4, 5, 6]]),
      B: m([[1, 2], [3, 4], [5, 6]]),
    }),
  },
  {
    description: "1×1 scalar ⊗ 2×2 = 2×2 (left-scalar multiplication)",
    input: record({
      A: m([[7]]),
      B: m([[1, 2], [3, 4]]),
    }),
  },
  {
    description: "2×2 ⊗ 1×1 scalar = 2×2 (right-scalar multiplication)",
    input: record({
      A: m([[1, 2], [3, 4]]),
      B: m([[7]]),
    }),
  },
  {
    description: "asymmetric: 3×1 ⊗ 1×3 = 3×3 outer-product",
    input: record({
      A: m([[1], [2], [3]]),
      B: m([[1, 2, 3]]),
    }),
  },
  {
    description: "negative entries: diag(-1, 1) ⊗ diag(1, -1) = diag(-1, 1, 1, -1)",
    input: record({
      A: m([[-1, 0], [0, 1]]),
      B: m([[1, 0], [0, -1]]),
    }),
  },
];
