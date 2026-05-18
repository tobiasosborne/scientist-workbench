// =============================================================================
// partial-transpose — transpose on selected subsystems of an operator on a
// tensor-product Hilbert space
// =============================================================================
//
// Intent
// ------
// Given an operator M on H = H_0 ⊗ H_1 ⊗ ⋯ ⊗ H_{n−1} (where H_k has
// dimension dims[k]), and one or more subsystems to transpose, produce
// the partially-transposed operator:
//
//     PT_S(M)[I, J]  =  M[I_S↔J_S, J_S↔I_S]
//
// where for each subsystem index `s ∈ S`, the row's s-th component is
// taken from the column's s-th component and vice versa. The other
// subsystems are left alone. When S = {0,…,n−1}, PT_S equals the full
// transpose; when S = ∅, PT_S is the identity.
//
// This is a pure index permutation — no arithmetic on the entries. The
// substrate `@workbench/qinfo`'s `partialTranspose` is the workhorse;
// this tool is a thin Value-↔-Matrix wrapper.
//
// Why an agent reaches for this tool
// ----------------------------------
// The Peres–Horodecki criterion (Peres 1996; Horodecki³ 1996) says:
// if a bipartite state ρ_AB is separable, then PT_B(ρ_AB) ⪰ 0. The
// contrapositive — finding a negative eigenvalue of PT_B(ρ_AB) — is the
// canonical entanglement witness. On 2×2 and 2×3 systems the criterion
// is *necessary and sufficient*; for larger systems it's a one-sided
// witness (PPT-but-entangled states exist on 3×3 and beyond).
//
// The decisive worked example: PT on one qubit of the Bell state
// |Φ+⟩⟨Φ+| produces (1/2) SWAP_4, whose minimum eigenvalue is −1/2.
// That single negative number certifies entanglement. The matrix-form
// piece (PT on the Bell state equals (1/2) SWAP_4) is pinned in this
// tool's `--test` hook; the eigenvalue check is exercised at the demo
// level by composing with `linalg-eigh`.
//
// Dims model (matches partial-trace; ADR-0034 §D3)
// ------------------------------------------------
// Subsystems can have arbitrary dimension — `[2, 2, 2]` for three qubits,
// `[3, 3]` for two qutrits, `[4, 3, 2]` mixed. Subsystem k = 0 is the
// LEFTMOST tensor factor. This convention is locked substrate-wide;
// QuTiP uses the opposite endianness and we explicitly diverge.
//
// `transposeOn` accepts a list of integers — duplicates and out-of-range
// indices are rejected. Order within the list doesn't matter (the
// operation is a coordinate-wise swap, not a sequence of operations).
//
// Output shape (ADR-0003: happy-path success)
// -------------------------------------------
//   record { M_pt:     list<list<float64>>,
//            shape:    list<integer>           /* [d, d] */,
//            warnings: list<string> }
//
// Refusal is `ToolError`, not tagged — shape/dim/range mismatches are
// malformed inputs. The bead description lists tagged categories for
// these cases, but the partial-trace precedent (filed under the same
// ADR-0003 review) resolved the same situation in favour of `ToolError`:
// the partial-transpose operation has no "out of scope" branch of the
// math — it is defined for every well-shaped matrix — so any rejection
// is a contract violation by the caller, which is exactly what
// `ToolError` is for.

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
  partialTranspose,
  toNested,
  type Matrix,
} from "@workbench/qinfo";

const NAME = "partial-transpose";
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
  const firstRow = rows[0] as ListValue;
  if (firstRow.kind !== "list") {
    throw new ToolError(`${NAME}: ${field}[0] must be a list<float64>`, {});
  }
  const cols = firstRow.items.length;
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
  transposeOn: S.list(S.kind("integer")),
});

const outputSchema = S.record({
  M_pt: real2dSchema,
  shape: S.list(S.kind("integer")),
  warnings: S.list(S.kind("string")),
});

// ─── Tool ──────────────────────────────────────────────────────────────

export const def = defineTool({
  name: NAME,
  version: VERSION,
  schema: { input: inputSchema, output: outputSchema },
  numerical: true, // ADR-0034 §D8
  examples: [
    {
      description:
        "Bell state |Φ+⟩⟨Φ+| with partial transpose on qubit 1 → (1/2) SWAP. The min eigenvalue −1/2 is the canonical Peres–Horodecki witness; pair with linalg-eigh to test.",
      input: record({
        M: list([
          list([0.5, 0, 0, 0.5].map(float64FromNumber)),
          list([0, 0, 0, 0].map(float64FromNumber)),
          list([0, 0, 0, 0].map(float64FromNumber)),
          list([0.5, 0, 0, 0.5].map(float64FromNumber)),
        ]),
        dims: list([int(2n), int(2n)]),
        transposeOn: list([int(1n)]),
      }),
    },
    {
      description:
        "Product state diag(1,2) ⊗ diag(3,4): PT on either side is a no-op (separable, diagonal)",
      input: record({
        M: list([
          list([3, 0, 0, 0].map(float64FromNumber)),
          list([0, 4, 0, 0].map(float64FromNumber)),
          list([0, 0, 6, 0].map(float64FromNumber)),
          list([0, 0, 0, 8].map(float64FromNumber)),
        ]),
        dims: list([int(2n), int(2n)]),
        transposeOn: list([int(1n)]),
      }),
    },
    {
      description: "PT on the whole system equals the full transpose",
      input: record({
        M: list([
          list([1, 2, 3, 4].map(float64FromNumber)),
          list([5, 6, 7, 8].map(float64FromNumber)),
          list([9, 10, 11, 12].map(float64FromNumber)),
          list([13, 14, 15, 16].map(float64FromNumber)),
        ]),
        dims: list([int(2n), int(2n)]),
        transposeOn: list([int(0n), int(1n)]),
      }),
    },
    {
      description: "Empty transposeOn=[] is the identity copy of M",
      input: record({
        M: list([
          list([1, 2].map(float64FromNumber)),
          list([3, 4].map(float64FromNumber)),
        ]),
        dims: list([int(2n)]),
        transposeOn: list([]),
      }),
    },
  ],
  invariants: [
    {
      name: "involution",
      statement:
        "PT_S(PT_S(M)) = M (applying the same partial transpose twice is the identity)",
      machine_checkable: true,
    },
    {
      name: "product-state",
      statement:
        "PT_S(A ⊗ B) on the B subsystem equals A ⊗ Bᵀ; the transpose-on-A case is symmetric",
      machine_checkable: true,
    },
    {
      name: "whole-system-equals-full-transpose",
      statement: "PT_{0,…,n−1}(M) = Mᵀ",
      machine_checkable: true,
    },
    {
      name: "empty-is-identity",
      statement: "PT_∅(M) = M (vacuous case)",
      machine_checkable: true,
    },
    {
      name: "bell-state-witness",
      statement:
        "PT on one qubit of |Φ+⟩⟨Φ+| equals (1/2) SWAP, whose min eigenvalue is −1/2 — the canonical PPT entanglement witness",
      machine_checkable: true,
    },
    {
      name: "shape-preserving",
      statement: "output M_pt has the same shape as input M",
      machine_checkable: true,
    },
    {
      name: "rejects-malformed",
      statement:
        "shape/dim mismatch, out-of-range or duplicate subsystem indices, non-finite entries → ToolError (not a wrong-shaped success record)",
      machine_checkable: true,
    },
  ],
  fn: (input, _flags): Value => {
    const M = valueToMatrix(input.fields.M as Value, "M");
    const dims = readIntList(input.fields.dims as Value, "dims");
    const transposeOn = readIntList(
      input.fields.transposeOn as Value,
      "transposeOn",
    );

    // Validate dims.
    if (dims.length === 0) {
      throw new ToolError(`${NAME}: dims must be non-empty`, {});
    }
    for (let i = 0; i < dims.length; i++) {
      if (!Number.isInteger(dims[i]) || dims[i]! <= 0) {
        throw new ToolError(
          `${NAME}: dims[${i}] must be a positive integer, got ${dims[i]}`,
          {},
        );
      }
    }
    // Validate M shape against dims.
    const expectedD = dimProduct(dims);
    if (M.rows !== expectedD || M.cols !== expectedD) {
      throw new ToolError(
        `${NAME}: M must be ${expectedD}×${expectedD} (= ∏ dims), got ${M.rows}×${M.cols}`,
        {
          suggestion: `Check that dims = ${JSON.stringify(dims)} matches your operator's shape.`,
        },
      );
    }
    // Validate transposeOn entries.
    const seen = new Set<number>();
    for (const k of transposeOn) {
      if (!Number.isInteger(k) || k < 0 || k >= dims.length) {
        throw new ToolError(
          `${NAME}: transposeOn contains ${k}, out of range [0, ${dims.length})`,
          {},
        );
      }
      if (seen.has(k)) {
        throw new ToolError(
          `${NAME}: transposeOn contains duplicate index ${k}`,
          {
            suggestion:
              "Each subsystem can be transposed at most once; the order within transposeOn does not matter.",
          },
        );
      }
      seen.add(k);
    }

    const M_pt = partialTranspose(M, dims, transposeOn);
    return record({
      M_pt: matrixToValue(M_pt),
      shape: list([int(BigInt(M_pt.rows)), int(BigInt(M_pt.cols))]),
      warnings: list([]),
    });
  },
  test: () => {
    // Bell-state PPT canonical: PT on qubit 1 of |Φ+⟩⟨Φ+| equals (1/2) SWAP_4.
    const bell = fromNested([
      [0.5, 0, 0, 0.5],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0.5, 0, 0, 0.5],
    ]);
    const bell_pt = partialTranspose(bell, [2, 2], 1);
    const halfSwap = [
      0.5, 0, 0, 0,
      0, 0, 0.5, 0,
      0, 0.5, 0, 0,
      0, 0, 0, 0.5,
    ];
    let maxErr = 0;
    for (let k = 0; k < 16; k++) {
      const diff = Math.abs(bell_pt.re[k]! - halfSwap[k]!);
      if (diff > maxErr) maxErr = diff;
    }
    if (maxErr > 0) {
      throw new Error(
        `partial-transpose --test: PT(|Φ+⟩⟨Φ+|) should equal (1/2)·SWAP (max diff ${maxErr})`,
      );
    }
    // Involution: PT(PT(M)) = M for any M, any subset.
    const rand = fromNested([
      [1, 2, 3, 4],
      [5, 6, 7, 8],
      [9, 10, 11, 12],
      [13, 14, 15, 16],
    ]);
    const once = partialTranspose(rand, [2, 2], [1]);
    const twice = partialTranspose(once, [2, 2], [1]);
    for (let k = 0; k < 16; k++) {
      if (twice.re[k]! !== rand.re[k]!) {
        throw new Error(
          `partial-transpose --test: PT(PT(M)) ≠ M at flat-index ${k}`,
        );
      }
    }
    // Whole-system PT equals full transpose.
    const full_pt = partialTranspose(rand, [2, 2], [0, 1]);
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 4; j++) {
        if (full_pt.re[i * 4 + j]! !== rand.re[j * 4 + i]!) {
          throw new Error(
            `partial-transpose --test: full PT ≠ transpose at [${i},${j}]`,
          );
        }
      }
    }
    // Empty transposeOn = identity copy.
    const id_pt = partialTranspose(rand, [4], []);
    for (let k = 0; k < 16; k++) {
      if (id_pt.re[k]! !== rand.re[k]!) {
        throw new Error(
          `partial-transpose --test: PT_∅(M) ≠ M at flat-index ${k}`,
        );
      }
    }
  },
});

if (import.meta.main) void runTool(def);
