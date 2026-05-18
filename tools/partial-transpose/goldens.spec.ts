import { float64FromNumber, int, list, record } from "@workbench/protocol";
import type { GoldenSpec } from "@workbench/contract";

// Helper: 2D number array → list<list<float64>> Value.
function m(rows: number[][]) {
  return list(rows.map((r) => list(r.map(float64FromNumber))));
}

function dims(...d: number[]) {
  return list(d.map((x) => int(BigInt(x))));
}

function ints(...idx: number[]) {
  return list(idx.map((x) => int(BigInt(x))));
}

// Common matrices.
const Bell = [
  [0.5, 0, 0, 0.5],
  [0, 0, 0, 0],
  [0, 0, 0, 0],
  [0.5, 0, 0, 0.5],
];
const Singlet = [
  [0, 0, 0, 0],
  [0, 0.5, -0.5, 0],
  [0, -0.5, 0.5, 0],
  [0, 0, 0, 0],
];
const I8_8 = Array.from({ length: 8 }, (_, i) =>
  Array.from({ length: 8 }, (_, j) => (i === j ? 1 / 8 : 0)),
);

// 12 goldens covering: Bell-state PPT canonical, singlet, product, multi-subsystem,
// edge cases, qutrit dims, multiple PT axes simultaneously.
export const goldens: GoldenSpec[] = [
  {
    description:
      "Bell state |Φ+⟩⟨Φ+| with PT on qubit 1 → (1/2) SWAP — the canonical Peres–Horodecki witness, min eigenvalue −1/2",
    input: record({
      M: m(Bell),
      dims: dims(2, 2),
      transposeOn: ints(1),
    }),
  },
  {
    description:
      "Bell state with PT on qubit 0 → also (1/2) SWAP (symmetric — the witness is independent of which subsystem you PT)",
    input: record({
      M: m(Bell),
      dims: dims(2, 2),
      transposeOn: ints(0),
    }),
  },
  {
    description:
      "Singlet |Ψ-⟩⟨Ψ-| with PT on qubit 1 → has negative eigenvalue (max-entangled, second canonical witness)",
    input: record({
      M: m(Singlet),
      dims: dims(2, 2),
      transposeOn: ints(1),
    }),
  },
  {
    description:
      "Product state diag(1,2) ⊗ diag(3,4) = diag(3,4,6,8): PT on qubit 1 is the identity (PPT, separable)",
    input: record({
      M: m([
        [3, 0, 0, 0],
        [0, 4, 0, 0],
        [0, 0, 6, 0],
        [0, 0, 0, 8],
      ]),
      dims: dims(2, 2),
      transposeOn: ints(1),
    }),
  },
  {
    description:
      "Product state (|0⟩⟨1| ⊗ I_2): PT on qubit 1 swaps the off-diagonal block — A ⊗ I = A ⊗ Iᵀ (still A ⊗ I)",
    input: record({
      M: m([
        [0, 0, 1, 0],
        [0, 0, 0, 1],
        [0, 0, 0, 0],
        [0, 0, 0, 0],
      ]),
      dims: dims(2, 2),
      transposeOn: ints(1),
    }),
  },
  {
    description:
      "PT on the whole 2×2 system equals the full transpose (asymmetric matrix)",
    input: record({
      M: m([
        [1, 2, 3, 4],
        [5, 6, 7, 8],
        [9, 10, 11, 12],
        [13, 14, 15, 16],
      ]),
      dims: dims(2, 2),
      transposeOn: ints(0, 1),
    }),
  },
  {
    description: "Vacuous PT (transposeOn=[]) returns M unchanged",
    input: record({
      M: m([
        [1, 2],
        [3, 4],
      ]),
      dims: dims(2),
      transposeOn: ints(),
    }),
  },
  {
    description:
      "Qutrit ⊗ qubit ([3,2]) with PT on qubit (index 1) — swaps every 3×3 off-diagonal block of the 6×6",
    input: record({
      M: m([
        [1, 2, 3, 4, 5, 6],
        [7, 8, 9, 10, 11, 12],
        [13, 14, 15, 16, 17, 18],
        [19, 20, 21, 22, 23, 24],
        [25, 26, 27, 28, 29, 30],
        [31, 32, 33, 34, 35, 36],
      ]),
      dims: dims(3, 2),
      transposeOn: ints(1),
    }),
  },
  {
    description:
      "Qutrit ⊗ qubit ([3,2]) with PT on qutrit (index 0) — transposes the 3×3 block structure",
    input: record({
      M: m([
        [1, 2, 3, 4, 5, 6],
        [7, 8, 9, 10, 11, 12],
        [13, 14, 15, 16, 17, 18],
        [19, 20, 21, 22, 23, 24],
        [25, 26, 27, 28, 29, 30],
        [31, 32, 33, 34, 35, 36],
      ]),
      dims: dims(3, 2),
      transposeOn: ints(0),
    }),
  },
  {
    description:
      "Three qubits ([2,2,2]) on the maximally mixed I_8/8: PT on any subsystem is a no-op",
    input: record({
      M: m(I8_8),
      dims: dims(2, 2, 2),
      transposeOn: ints(1),
    }),
  },
  {
    description:
      "Three qubits, PT on subsystems [0, 2] simultaneously — sub-set PT, not a sequence",
    input: record({
      M: m(
        Array.from({ length: 8 }, (_, i) =>
          Array.from({ length: 8 }, (_, j) => i * 8 + j + 1),
        ),
      ),
      dims: dims(2, 2, 2),
      transposeOn: ints(0, 2),
    }),
  },
  {
    description:
      "Three qubits, PT on subsystem 1 only — the middle subsystem; tests the non-extreme position",
    input: record({
      M: m(
        Array.from({ length: 8 }, (_, i) =>
          Array.from({ length: 8 }, (_, j) => i * 8 + j + 1),
        ),
      ),
      dims: dims(2, 2, 2),
      transposeOn: ints(1),
    }),
  },
];
