import { float64FromNumber, int, list, record } from "@workbench/protocol";
import type { GoldenSpec } from "@workbench/contract";

// Helper: 2D number array → list<list<float64>> Value.
function m(rows: number[][]): ReturnType<typeof list> {
  return list(rows.map((r) => list(r.map(float64FromNumber))));
}

function dims(...d: number[]): ReturnType<typeof list> {
  return list(d.map((x) => int(BigInt(x))));
}

function ints(...idx: number[]): ReturnType<typeof list> {
  return list(idx.map((x) => int(BigInt(x))));
}

// 12 goldens covering: product-state defining property, Bell-state max-mixed
// reduction (both sides), qutrit ⊗ qubit, 3-system multi-trace, edge cases.
export const goldens: GoldenSpec[] = [
  {
    description: "Tr_1(|0⟩⟨0| ⊗ |1⟩⟨1|) = |0⟩⟨0|",
    input: record({
      M: m([
        [0, 0, 0, 0],
        [0, 1, 0, 0],
        [0, 0, 0, 0],
        [0, 0, 0, 0],
      ]),
      dims: dims(2, 2),
      trace_out: ints(1),
    }),
  },
  {
    description: "Tr_0(|0⟩⟨0| ⊗ |1⟩⟨1|) = |1⟩⟨1|",
    input: record({
      M: m([
        [0, 0, 0, 0],
        [0, 1, 0, 0],
        [0, 0, 0, 0],
        [0, 0, 0, 0],
      ]),
      dims: dims(2, 2),
      trace_out: ints(0),
    }),
  },
  {
    description: "Bell state |Φ+⟩⟨Φ+| traced over qubit 1 → I/2",
    input: record({
      M: m([
        [0.5, 0, 0, 0.5],
        [0, 0, 0, 0],
        [0, 0, 0, 0],
        [0.5, 0, 0, 0.5],
      ]),
      dims: dims(2, 2),
      trace_out: ints(1),
    }),
  },
  {
    description: "Bell state |Φ+⟩⟨Φ+| traced over qubit 0 → I/2 (symmetric)",
    input: record({
      M: m([
        [0.5, 0, 0, 0.5],
        [0, 0, 0, 0],
        [0, 0, 0, 0],
        [0.5, 0, 0, 0.5],
      ]),
      dims: dims(2, 2),
      trace_out: ints(0),
    }),
  },
  {
    description: "Singlet |Ψ-⟩⟨Ψ-| traced over qubit 1 → I/2",
    input: record({
      M: m([
        [0, 0, 0, 0],
        [0, 0.5, -0.5, 0],
        [0, -0.5, 0.5, 0],
        [0, 0, 0, 0],
      ]),
      dims: dims(2, 2),
      trace_out: ints(1),
    }),
  },
  {
    description: "Product state diag(1,2) ⊗ diag(4,5) — Tr_1 = 9·diag(1,2)",
    input: record({
      M: m([
        [4, 0, 0, 0],
        [0, 5, 0, 0],
        [0, 0, 8, 0],
        [0, 0, 0, 10],
      ]),
      dims: dims(2, 2),
      trace_out: ints(1),
    }),
  },
  {
    description: "Qutrit ⊗ qubit: diag(1,2,3) ⊗ diag(4,5); trace qubit → 9·diag(1,2,3)",
    input: record({
      M: m([
        [4, 0, 0, 0, 0, 0],
        [0, 5, 0, 0, 0, 0],
        [0, 0, 8, 0, 0, 0],
        [0, 0, 0, 10, 0, 0],
        [0, 0, 0, 0, 12, 0],
        [0, 0, 0, 0, 0, 15],
      ]),
      dims: dims(3, 2),
      trace_out: ints(1),
    }),
  },
  {
    description: "Qutrit ⊗ qubit: trace qutrit → 6·diag(4,5)",
    input: record({
      M: m([
        [4, 0, 0, 0, 0, 0],
        [0, 5, 0, 0, 0, 0],
        [0, 0, 8, 0, 0, 0],
        [0, 0, 0, 10, 0, 0],
        [0, 0, 0, 0, 12, 0],
        [0, 0, 0, 0, 0, 15],
      ]),
      dims: dims(3, 2),
      trace_out: ints(0),
    }),
  },
  {
    description: "Maximally mixed I_8/8 on 3 qubits → I_2/2 (trace out [0, 2])",
    input: record({
      M: m(
        Array.from({ length: 8 }, (_, i) =>
          Array.from({ length: 8 }, (_, j) => (i === j ? 1 / 8 : 0)),
        ),
      ),
      dims: dims(2, 2, 2),
      trace_out: ints(0, 2),
    }),
  },
  {
    description: "Maximally mixed I_8/8 on 3 qubits → I_4/4 (trace out [1])",
    input: record({
      M: m(
        Array.from({ length: 8 }, (_, i) =>
          Array.from({ length: 8 }, (_, j) => (i === j ? 1 / 8 : 0)),
        ),
      ),
      dims: dims(2, 2, 2),
      trace_out: ints(1),
    }),
  },
  {
    description: "Trace out all subsystems → scalar tr(M)",
    input: record({
      M: m([
        [1, 2, 3, 4],
        [5, 6, 7, 8],
        [9, 0, 1, 2],
        [3, 4, 5, 6],
      ]),
      dims: dims(2, 2),
      trace_out: ints(0, 1),
    }),
  },
  {
    description: "Vacuous trace (trace_out=[]) returns M unchanged",
    input: record({
      M: m([[1, 2], [3, 4]]),
      dims: dims(2),
      trace_out: ints(),
    }),
  },
];
