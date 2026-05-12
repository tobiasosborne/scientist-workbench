// =============================================================================
// tensor-product — Kronecker product of two real matrices
// =============================================================================
//
// Intent
// ------
// Given two real matrices A (m_A × n_A) and B (m_B × n_B), produce
// (A ⊗ B), the (m_A · m_B) × (n_A · n_B) Kronecker product:
//
//     (A ⊗ B)[i_A · m_B + i_B, j_A · n_B + j_B]  =  A[i_A, j_A] · B[i_B, j_B].
//
// The standard composable primitive when you need to assemble operators on
// product Hilbert spaces, build block matrices via I_k ⊗ M sandwiches, or
// construct test density matrices like ρ_A ⊗ ρ_B. Wired to the cohesive
// `@workbench/qinfo` substrate; this tool is a thin Value-↔-Matrix wrapper
// around `qinfo.kron`.
//
// Why the wire is real-only at v0.1
// ---------------------------------
// The substrate supports complex from day 1 (see ADR-0034). The *wire*
// schema stays real-Hermitian-only across the qinfo tool surface until
// the linalg-complex-extension epic (bead `ov4j`) ships its wire-protocol
// shape for complex matrices. Once that lands, this tool's input/output
// schemas extend additively (an optional `B_im` / `A_im` pair); the v0.1
// real call site keeps working unchanged.
//
// Output shape (ADR-0003: happy-path success)
// -------------------------------------------
//   record { AB: list<list<float64>>,
//            shape: list<integer> /* [rows, cols] */,
//            warnings: list<string> }
//
// `warnings` is currently empty but reserved for future soft notifications
// (e.g., "result has NaN entries because input did" if we add that scan).
//
// Refusal is ToolError, not tagged: empty/ragged/non-finite inputs are
// *malformed* (the input doesn't represent a valid matrix), and ADR-0003
// reserves `tagged` for boundary failures on otherwise-valid inputs.

import {
  S,
  ToolError,
  float64FromNumber,
  float64ToNumber,
  int,
  list,
  record,
} from "@workbench/protocol";
import type { Value } from "@workbench/protocol";
import { defineTool, runTool } from "@workbench/contract";
import {
  fromNested,
  kron2,
  maxAbsDiff,
  matmul,
  toNested,
  type Matrix,
} from "@workbench/qinfo";

const NAME = "tensor-product";
const VERSION = "0.1.0";

// ─── Wire helpers ──────────────────────────────────────────────────────

type Float64Value = { kind: "float64"; bits: string };
type ListValue = { kind: "list"; items: Value[] };

function valueToMatrix(v: Value, field: string): Matrix {
  if (v.kind !== "list") {
    throw new ToolError(`${NAME}: ${field} must be a list<list<float64>>`, {});
  }
  const rows = (v as ListValue).items;
  if (rows.length === 0) {
    throw new ToolError(`${NAME}: ${field} has zero rows`, {});
  }
  const cols = (rows[0] as ListValue).items.length;
  if (cols === 0) {
    throw new ToolError(`${NAME}: ${field} has zero columns`, {});
  }
  const data: number[][] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] as ListValue;
    if (row.items.length !== cols) {
      throw new ToolError(
        `${NAME}: ${field} is ragged — row 0 has ${cols} cols, row ${i} has ${row.items.length}`,
        {},
      );
    }
    const r = new Array<number>(cols);
    for (let j = 0; j < cols; j++) {
      const x = float64ToNumber(row.items[j] as Float64Value);
      if (!Number.isFinite(x)) {
        throw new ToolError(
          `${NAME}: ${field}[${i}][${j}] is not finite (got ${x})`,
          {},
        );
      }
      r[j] = x;
    }
    data.push(r);
  }
  return fromNested(data);
}

function matrixToValue(M: Matrix) {
  const rows = toNested(M);
  return list(rows.map((r) => list(r.map(float64FromNumber))));
}

// ─── Schemas ───────────────────────────────────────────────────────────

const real2dSchema = S.list(S.list(S.kind("float64")));

const inputSchema = S.record({
  A: real2dSchema,
  B: real2dSchema,
});

const outputSchema = S.record({
  AB: real2dSchema,
  shape: S.list(S.kind("integer")),
  warnings: S.list(S.kind("string")),
});

// ─── Tool ──────────────────────────────────────────────────────────────

export const def = defineTool({
  name: NAME,
  version: VERSION,
  schema: { input: inputSchema, output: outputSchema },
  examples: [
    {
      description: "I_2 ⊗ I_2 = I_4",
      input: record({
        A: list([
          list([float64FromNumber(1), float64FromNumber(0)]),
          list([float64FromNumber(0), float64FromNumber(1)]),
        ]),
        B: list([
          list([float64FromNumber(1), float64FromNumber(0)]),
          list([float64FromNumber(0), float64FromNumber(1)]),
        ]),
      }),
    },
    {
      description: "|0⟩⟨0| ⊗ |1⟩⟨1| has a single 1 at (1, 1) in the 4×4 result",
      input: record({
        A: list([
          list([float64FromNumber(1), float64FromNumber(0)]),
          list([float64FromNumber(0), float64FromNumber(0)]),
        ]),
        B: list([
          list([float64FromNumber(0), float64FromNumber(0)]),
          list([float64FromNumber(0), float64FromNumber(1)]),
        ]),
      }),
    },
    {
      description: "rectangular kron: 2×3 ⊗ 3×2 = 6×6",
      input: record({
        A: list([
          list([float64FromNumber(1), float64FromNumber(2), float64FromNumber(3)]),
          list([float64FromNumber(4), float64FromNumber(5), float64FromNumber(6)]),
        ]),
        B: list([
          list([float64FromNumber(1), float64FromNumber(2)]),
          list([float64FromNumber(3), float64FromNumber(4)]),
          list([float64FromNumber(5), float64FromNumber(6)]),
        ]),
      }),
    },
  ],
  invariants: [
    {
      name: "shape",
      statement: "(m_A × n_A) ⊗ (m_B × n_B) has shape (m_A·m_B, n_A·n_B)",
      machine_checkable: true,
    },
    {
      name: "mixed-product",
      statement: "(A ⊗ B)(C ⊗ D) = (A·C) ⊗ (B·D) (the kron mixed-product law)",
      machine_checkable: true,
    },
    {
      name: "identity",
      statement: "I_m ⊗ I_n = I_{m·n}",
      machine_checkable: true,
    },
    {
      name: "trace-product",
      statement: "tr(A ⊗ B) = tr(A) · tr(B) for square A, B",
      machine_checkable: true,
    },
    {
      name: "rejects-malformed",
      statement: "empty / ragged / non-finite input throws ToolError, not a wrong record",
      machine_checkable: true,
    },
    {
      name: "deterministic",
      statement: "same input bytes → same output bytes",
      machine_checkable: true,
    },
  ],
  fn: (input, _flags) => {
    const A = valueToMatrix(input.fields.A, "A");
    const B = valueToMatrix(input.fields.B, "B");
    const AB = kron2(A, B);
    return record({
      AB: matrixToValue(AB),
      shape: list([int(BigInt(AB.rows)), int(BigInt(AB.cols))]),
      warnings: list([]),
    });
  },
  test: () => {
    // Identity check.
    const I2 = fromNested([[1, 0], [0, 1]]);
    const I4 = kron2(I2, I2);
    const expectedI4 = fromNested([
      [1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1],
    ]);
    if (maxAbsDiff(I4, expectedI4) !== 0) {
      throw new Error("tensor-product --test: I_2 ⊗ I_2 ≠ I_4");
    }
    // Mixed product: (A⊗B)(C⊗D) = (AC)⊗(BD).
    const A = fromNested([[1, 2], [3, 4]]);
    const B = fromNested([[5, 6], [7, 8]]);
    const C = fromNested([[9, 10], [11, 12]]);
    const D = fromNested([[13, 14], [15, 16]]);
    const lhs = matmul(kron2(A, B), kron2(C, D));
    const rhs = kron2(matmul(A, C), matmul(B, D));
    if (maxAbsDiff(lhs, rhs) > 1e-10) {
      throw new Error(
        `tensor-product --test: mixed-product law violated (max diff ${maxAbsDiff(lhs, rhs)})`,
      );
    }
  },
});

if (import.meta.main) void runTool(def);
