// =============================================================================
// partial-trace — trace out one or more subsystems of an operator on a
// tensor-product Hilbert space
// =============================================================================
//
// Intent
// ------
// Given an operator M on H = H_0 ⊗ H_1 ⊗ ⋯ ⊗ H_{n−1} (where H_k has
// dimension dims[k]), and one or more subsystems to trace out, produce
// the reduced operator on the remaining factors:
//
//     (Tr_S M)[I_kept, J_kept]  =  Σ_{I_S = J_S}  M[I, J]
//
// where I_S denotes "the values at subsystem indices in S" and the sum
// runs over all such joint settings. The substrate `@workbench/qinfo`'s
// `partialTrace` is the workhorse; this tool is a thin Value-↔-Matrix
// wrapper.
//
// Dims model
// ----------
// Subsystems can have arbitrary dimension — `[2, 2, 2]` for three qubits,
// `[3, 3]` for two qutrits, `[4, 3, 2]` mixed. Subsystem k = 0 is the
// LEFTMOST tensor factor (so for dims = [d_0, d_1, …], |ψ⟩ = |q_0⟩ ⊗
// |q_1⟩ ⊗ … is the reading order). The substrate dim helpers
// (`dimProduct`, `composeIndex`) lock this convention; consumers don't
// have to rederive it from index math.
//
// `trace_out` accepts either a single integer or a list of integers; the
// substrate handles multi-subsystem trace by tracing high-to-low so the
// remaining indices in [0, …) don't shift between steps.
//
// Output shape (ADR-0003: happy-path success)
// -------------------------------------------
//   record { reduced: list<list<float64>>,
//            reduced_dims: list<integer>,
//            shape: list<integer>           /* [d_kept, d_kept] */,
//            warnings: list<string> }
//
// `reduced_dims` is the post-trace dim list (input dims with `trace_out`
// indices removed) — useful for chained partial-trace calls without
// rederiving from `dims` + `trace_out`.
//
// Refusal is ToolError, not tagged: shape/dim/range mismatches are
// malformed inputs.

import {
  S,
  ToolError,
  float64FromNumber,
  float64ToNumber,
  int,
  list,
  record,
  type Value,
} from "@workbench/protocol";
import { defineTool, runTool } from "@workbench/contract";
import {
  dimProduct,
  fromNested,
  partialTrace,
  toNested,
  trace as traceM,
  type Matrix,
} from "@workbench/qinfo";

const NAME = "partial-trace";
const VERSION = "0.1.0";

// ─── Wire helpers ──────────────────────────────────────────────────────

type Float64Value = { kind: "float64"; bits: string };
type IntegerValue = { kind: "integer"; value: string };
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

function readIntList(v: Value, field: string): number[] {
  if (v.kind !== "list") {
    throw new ToolError(`${NAME}: ${field} must be a list<integer>`, {});
  }
  const items = (v as ListValue).items;
  const out: number[] = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i] as IntegerValue;
    out.push(Number(BigInt(it.value)));
  }
  return out;
}

// ─── Schemas ───────────────────────────────────────────────────────────

const real2dSchema = S.list(S.list(S.kind("float64")));

const inputSchema = S.record({
  M: real2dSchema,
  dims: S.list(S.kind("integer")),
  trace_out: S.list(S.kind("integer")),
});

const outputSchema = S.record({
  reduced: real2dSchema,
  reduced_dims: S.list(S.kind("integer")),
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
      description: "Trace out qubit 1 of |0⟩⟨0| ⊗ |1⟩⟨1| → |0⟩⟨0|",
      input: record({
        // 4×4 with a single 1 at (1, 1) — |0⟩⟨0| ⊗ |1⟩⟨1|.
        M: list([
          list([0, 0, 0, 0].map(float64FromNumber)),
          list([0, 1, 0, 0].map(float64FromNumber)),
          list([0, 0, 0, 0].map(float64FromNumber)),
          list([0, 0, 0, 0].map(float64FromNumber)),
        ]),
        dims: list([int(2n), int(2n)]),
        trace_out: list([int(1n)]),
      }),
    },
    {
      description: "Bell state |Φ+⟩⟨Φ+| → trace out qubit 1 = I/2",
      input: record({
        M: list([
          list([0.5, 0, 0, 0.5].map(float64FromNumber)),
          list([0, 0, 0, 0].map(float64FromNumber)),
          list([0, 0, 0, 0].map(float64FromNumber)),
          list([0.5, 0, 0, 0.5].map(float64FromNumber)),
        ]),
        dims: list([int(2n), int(2n)]),
        trace_out: list([int(1n)]),
      }),
    },
    {
      description: "Qutrit ⊗ qubit (dims=[3,2]); trace out the qubit",
      input: record({
        // diag(1,2,3) ⊗ diag(4,5) = diag(4,5,8,10,12,15) — trace out → tr(B)·A = 9·diag(1,2,3)
        M: list([
          list([4, 0, 0, 0, 0, 0].map(float64FromNumber)),
          list([0, 5, 0, 0, 0, 0].map(float64FromNumber)),
          list([0, 0, 8, 0, 0, 0].map(float64FromNumber)),
          list([0, 0, 0, 10, 0, 0].map(float64FromNumber)),
          list([0, 0, 0, 0, 12, 0].map(float64FromNumber)),
          list([0, 0, 0, 0, 0, 15].map(float64FromNumber)),
        ]),
        dims: list([int(3n), int(2n)]),
        trace_out: list([int(1n)]),
      }),
    },
    {
      description: "Trace out subsystems [0, 2] of a 3-qubit operator",
      input: record({
        // I_8 / 8 maximally mixed → reduced on subsystem 1 is I_2 / 2.
        M: list(
          Array.from({ length: 8 }, (_, i) =>
            list(
              Array.from({ length: 8 }, (_, j) =>
                float64FromNumber(i === j ? 1 / 8 : 0),
              ),
            ),
          ),
        ),
        dims: list([int(2n), int(2n), int(2n)]),
        trace_out: list([int(0n), int(2n)]),
      }),
    },
  ],
  invariants: [
    {
      name: "shape",
      statement: "output is d_kept × d_kept where d_kept = ∏_{k ∉ trace_out} dims[k]",
      machine_checkable: true,
    },
    {
      name: "trace-preservation",
      statement: "tr(partialTrace(M)) = tr(M)",
      machine_checkable: true,
    },
    {
      name: "product-state",
      statement: "Tr_1(A ⊗ B) = tr(B) · A (defining property)",
      machine_checkable: true,
    },
    {
      name: "linearity",
      statement: "Tr_k(α·M + β·N) = α·Tr_k(M) + β·Tr_k(N)",
      machine_checkable: true,
    },
    {
      name: "bell-reduces-to-maximally-mixed",
      statement: "|Φ+⟩⟨Φ+| with one qubit traced out is I/2",
      machine_checkable: true,
    },
    {
      name: "rejects-malformed",
      statement: "shape/dim/range mismatch raises ToolError, not a wrong record",
      machine_checkable: true,
    },
  ],
  fn: (input, _flags) => {
    const M = valueToMatrix(input.fields.M, "M");
    const dims = readIntList(input.fields.dims, "dims");
    const traceOut = readIntList(input.fields.trace_out, "trace_out");

    // Validate dims values.
    for (let i = 0; i < dims.length; i++) {
      if (!Number.isInteger(dims[i]) || dims[i]! <= 0) {
        throw new ToolError(
          `${NAME}: dims[${i}] must be a positive integer, got ${dims[i]}`,
          {},
        );
      }
    }
    if (dims.length === 0) {
      throw new ToolError(`${NAME}: dims must be non-empty`, {});
    }
    // Validate M shape against dims.
    const expectedD = dimProduct(dims);
    if (M.rows !== expectedD || M.cols !== expectedD) {
      throw new ToolError(
        `${NAME}: M must be ${expectedD}×${expectedD} (= ∏ dims), got ${M.rows}×${M.cols}`,
        { suggestion: `Check that dims = ${JSON.stringify(dims)} matches your operator's shape.` },
      );
    }
    // Validate trace_out indices.
    for (const k of traceOut) {
      if (!Number.isInteger(k) || k < 0 || k >= dims.length) {
        throw new ToolError(
          `${NAME}: trace_out contains ${k}, out of range [0, ${dims.length})`,
          {},
        );
      }
    }
    if (traceOut.length === 0) {
      // Vacuous trace; return M itself.
      return record({
        reduced: matrixToValue(M),
        reduced_dims: list(dims.map((d) => int(BigInt(d)))),
        shape: list([int(BigInt(M.rows)), int(BigInt(M.cols))]),
        warnings: list([]),
      });
    }

    const reduced = partialTrace(M, dims, traceOut);
    const tracedSet = new Set(traceOut);
    const reducedDims = dims.filter((_, k) => !tracedSet.has(k));

    return record({
      reduced: matrixToValue(reduced),
      reduced_dims: list(reducedDims.map((d) => int(BigInt(d)))),
      shape: list([int(BigInt(reduced.rows)), int(BigInt(reduced.cols))]),
      warnings: list([]),
    });
  },
  test: () => {
    // Bell-state PPT canonical reduction: ρ_A = I/2.
    const bell = fromNested([
      [0.5, 0, 0, 0.5],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0.5, 0, 0, 0.5],
    ]);
    const reduced = partialTrace(bell, [2, 2], 1);
    const expected = fromNested([[0.5, 0], [0, 0.5]]);
    let maxErr = 0;
    for (let i = 0; i < 4; i++) {
      const diff = Math.abs(reduced.re[i]! - expected.re[i]!);
      if (diff > maxErr) maxErr = diff;
    }
    if (maxErr > 1e-12) {
      throw new Error(`partial-trace --test: Bell reduced ≠ I/2 (max diff ${maxErr})`);
    }
    // Trace preservation.
    const tOrig = traceM(bell).re;
    const tRed = traceM(reduced).re;
    if (Math.abs(tOrig - tRed) > 1e-12) {
      throw new Error(`partial-trace --test: trace not preserved (${tOrig} vs ${tRed})`);
    }
  },
});

if (import.meta.main) void runTool(def);
