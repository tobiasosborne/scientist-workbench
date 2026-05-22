// =============================================================================
// choi-iso — Choi–Jamiołkowski isomorphism between superoperator matrices
// and Choi matrices, in both directions
// =============================================================================
//
// Intent
// ------
// A quantum channel Φ : M_{d_in} → M_{d_out} has (at least) three equivalent
// matrix representations:
//
//   (a) Kraus operators {K_α}, with Φ(ρ) = Σ_α K_α ρ K_α†;
//   (b) the superoperator matrix S of size (d_out² × d_in²), satisfying
//       vec(Φ(ρ)) = S · vec(ρ);
//   (c) the Choi matrix J of size (d_in·d_out × d_in·d_out),
//       J(Φ) := Σ_{i,j} |i⟩⟨j|_in ⊗ Φ(|i⟩⟨j|)_out.
//
// (b) ↔ (c) is the Choi–Jamiołkowski isomorphism. This tool wraps the
// substrate's `choi` / `deChoi` pair so callers can shuttle between the two
// representations on the wire. The substrate (`packages/qinfo/src/choi.ts`)
// owns the index-arithmetic; the tool's job is the wire-shape, the dim-
// guard, and the seven-artefact contract.
//
// Why both forms matter to an agent
// ---------------------------------
// Superoperator form (S) is what you usually *build*: each Kraus term
// contributes K̄_α ⊗ K_α to S, so writing channel composition or convex
// combination is straight matrix algebra. Choi form (J) is what you usually
// *test*: J ⪰ 0 iff Φ is completely positive, Tr_2(J) = I iff Φ is trace
// preserving. Both representations carry the same information; agents that
// build one and need to test the other reach for this tool.
//
// Convention (locked, see ADR-0034 §D7)
// -------------------------------------
// Column-stacking vec: `vec(M)[i + m·j] = M[i, j]`. Input subsystem is the
// LEFT tensor factor of J, output subsystem is the RIGHT tensor factor.
// Index map from S to J:
//
//     J[i_in·d_out + i_out, j_in·d_out + j_out]
//         =  S[i_out + d_out·j_out, i_in + d_in·j_in].
//
// This matches Watrous (TQI §2.2), QuTiP `to_choi`, Qiskit's `Choi` class,
// and Wood–Biamonte–Cory (arXiv:1111.6950, Eq. 3.22, the "column convention").
// SymPy has no Choi-matrix implementation; the ADR's mention of SymPy is to
// the vec convention specifically. Mixing column-stacking with row-stacking
// gives a SWAP-equivalent Choi (Wood et al. §3 row-vs-column) and is the
// single most common bug class in this corner of the literature, so the
// substrate locks one convention and refuses to be parameterised.
//
// Input shape (discriminated union)
// ---------------------------------
//   tagged "channel-to-choi"  → record { channel: list<list<float64>>,
//                                        dim_in: integer,
//                                        dim_out: integer }
//   tagged "choi-to-channel"  → record { J:       list<list<float64>>,
//                                        dim_in: integer,
//                                        dim_out: integer }
//
// The discriminator is the tag, not a string-typed `mode` field, because
// the two payloads have a different field name (`channel` vs `J`) — a TS
// expert would model this as a discriminated union, so the wire shape
// follows. The protocol's `S.tagged` + `S.union` is the exact vocabulary;
// at the fn body the TS type narrows on `input.tag`.
//
// Output shape (union — happy-path only, two record shapes by direction)
// ---------------------------------------------------------------------
//   forward → record { J:       list<list<float64>>,
//                      shape:   list<integer> /* [d_in·d_out, d_in·d_out] */,
//                      warnings: list<string> }
//   inverse → record { channel: list<list<float64>>,
//                      shape:   list<integer> /* [d_out², d_in²] */,
//                      warnings: list<string> }
//
// The output's matrix-bearing field is *named* after what it is — `J` for
// Choi matrix, `channel` for superoperator matrix. Caller knows the
// direction (they sent it), so the named field reads more naturally than
// an opaque "result" field would.
//
// Refusal pattern (ADR-0003)
// --------------------------
// Every failure mode of this tool is "the caller's input was malformed":
// non-positive dims, matrix shape that doesn't match d_in/d_out, non-finite
// entries. None of these are boundary failures of the math — the Choi
// isomorphism is a *pure index permutation*, defined for every well-shaped
// matrix. So all failures are `ToolError`, never tagged refusals. This is
// the same pattern partial-trace uses.

import {
  S,
  ToolError,
  float64FromNumber,
  float64ToNumber,
  int,
  list,
  record,
  type RecordValue,
  type Value,
} from "@workbench/protocol";
import { defineTool, runTool } from "@workbench/contract";
import {
  choi,
  deChoi,
  fromNested,
  toNested,
  type Matrix,
} from "@workbench/qinfo";

const NAME = "choi-iso";
const VERSION = "0.1.0";

// ─── Wire helpers ──────────────────────────────────────────────────────
//
// Shared with partial-trace / tensor-product in spirit but kept local: the
// per-tool ToolError messages embed NAME, which we want to read cleanly.
// When more qinfo tools land, a `tools/qinfo-common.ts` helper for these is
// the natural extraction; one tool's worth of duplication doesn't justify
// the package yet.

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

function readPositiveInt(v: Value, field: string): number {
  if (v.kind !== "integer") {
    throw new ToolError(`${NAME}: ${field} must be an integer`, {});
  }
  const n = Number(BigInt((v as IntegerValue).value));
  if (!Number.isInteger(n) || n <= 0) {
    throw new ToolError(
      `${NAME}: ${field} must be a positive integer, got ${n}`,
      {},
    );
  }
  // Practical upper bound: 16384 is already 64K × 64K storage for the
  // larger of the two matrices. Refuse anything that would over-allocate.
  if (n > 16384) {
    throw new ToolError(
      `${NAME}: ${field} = ${n} is unreasonably large (cap 16384); index manipulation alone would need ${n * n * n * n} bytes`,
      {},
    );
  }
  return n;
}

// ─── Schemas ───────────────────────────────────────────────────────────

const real2dSchema = S.list(S.list(S.kind("float64")));

const forwardPayloadSchema = S.record({
  channel: real2dSchema,
  dim_in: S.kind("integer"),
  dim_out: S.kind("integer"),
});

const inversePayloadSchema = S.record({
  J: real2dSchema,
  dim_in: S.kind("integer"),
  dim_out: S.kind("integer"),
});

const FORWARD_TAG = "channel-to-choi";
const INVERSE_TAG = "choi-to-channel";

const inputSchema = S.union([
  S.tagged(FORWARD_TAG, forwardPayloadSchema),
  S.tagged(INVERSE_TAG, inversePayloadSchema),
]);

const forwardOutputSchema = S.record({
  J: real2dSchema,
  shape: S.list(S.kind("integer")),
  warnings: S.list(S.kind("string")),
});

const inverseOutputSchema = S.record({
  channel: real2dSchema,
  shape: S.list(S.kind("integer")),
  warnings: S.list(S.kind("string")),
});

const outputSchema = S.union([forwardOutputSchema, inverseOutputSchema]);

// ─── Examples (golden seeds) ───────────────────────────────────────────
//
// Four representative examples live here in def.examples (registry/help
// surface). The full >=10 fixture set lives in goldens.spec.ts and is
// generated via `bun scripts/generate-goldens.ts --tool choi-iso`.

import { tagged } from "@workbench/protocol";

const ex_identity_qubit_forward = {
  description:
    "Identity channel on a qubit, S = I_4 (vec ρ → vec ρ) → J = |Ω⟩⟨Ω|, the unnormalised maximally entangled projector",
  input: tagged(
    FORWARD_TAG,
    record({
      // S = I_4: the superoperator matrix of the identity channel in
      // column-stacking is just the 4×4 identity (vec(ρ) = vec(ρ)).
      channel: list([
        list([1, 0, 0, 0].map(float64FromNumber)),
        list([0, 1, 0, 0].map(float64FromNumber)),
        list([0, 0, 1, 0].map(float64FromNumber)),
        list([0, 0, 0, 1].map(float64FromNumber)),
      ]),
      dim_in: int(2n),
      dim_out: int(2n),
    }),
  ),
} as const;

const ex_identity_qubit_inverse = {
  description:
    "Inverse direction on the same channel — Choi |Ω⟩⟨Ω| should round-trip back to the identity superoperator",
  input: tagged(
    INVERSE_TAG,
    record({
      // |Ω⟩⟨Ω| with |Ω⟩ = |00⟩ + |11⟩ (unnormalised).
      J: list([
        list([1, 0, 0, 1].map(float64FromNumber)),
        list([0, 0, 0, 0].map(float64FromNumber)),
        list([0, 0, 0, 0].map(float64FromNumber)),
        list([1, 0, 0, 1].map(float64FromNumber)),
      ]),
      dim_in: int(2n),
      dim_out: int(2n),
    }),
  ),
} as const;

const ex_transpose_map = {
  description:
    "Transpose map T(ρ) = ρᵀ: positive but not CP — its Choi matrix is SWAP, which has eigenvalues {-1, 1, 1, 1}. The simplest J(Φ) ⋡ 0 witness.",
  input: tagged(
    FORWARD_TAG,
    record({
      // Superoperator of the transpose map in column-stacking:
      // vec(ρᵀ)[i + 2j] = ρ[j, i] = vec(ρ)[j + 2i].  In matrix form
      // S[i + 2j, j' + 2i'] = δ_{i,j'} δ_{j,i'}, which is the SWAP matrix.
      channel: list([
        list([1, 0, 0, 0].map(float64FromNumber)),
        list([0, 0, 1, 0].map(float64FromNumber)),
        list([0, 1, 0, 0].map(float64FromNumber)),
        list([0, 0, 0, 1].map(float64FromNumber)),
      ]),
      dim_in: int(2n),
      dim_out: int(2n),
    }),
  ),
} as const;

const ex_depolarising_half = {
  description:
    "Qubit depolarising channel at p = 1/2:  Φ(ρ) = (1/2) ρ + (1/2)(I/2)·tr(ρ).  J = (1/2)|Ω⟩⟨Ω| + (1/4) I_4.",
  input: tagged(
    FORWARD_TAG,
    record({
      // S of (1/2) id + (1/2) tr(·)(I/2). In column-stacking, the
      // tr(·)(I/2) part has S = (1/2) |vec(I)⟩⟨vec(I)| / 2 = (1/4) |i⟩⟨i'|
      // when i = i', i.e. supports only on row indices 0 and 3.
      // Computed entry-by-entry: S = diag(3/4, 1/4, 1/4, 3/4) with off-
      // diagonal coupling S[0,3] = S[3,0] = 1/4. The Choi of this is the
      // p=1/2 line in the canonical depolarising formula.
      channel: list([
        list([3 / 4, 0, 0, 1 / 4].map(float64FromNumber)),
        list([0, 1 / 4, 0, 0].map(float64FromNumber)),
        list([0, 0, 1 / 4, 0].map(float64FromNumber)),
        list([1 / 4, 0, 0, 3 / 4].map(float64FromNumber)),
      ]),
      dim_in: int(2n),
      dim_out: int(2n),
    }),
  ),
} as const;

// ─── Tool ──────────────────────────────────────────────────────────────

export const def = defineTool({
  name: NAME,
  version: VERSION,
  summary:
    "Choi-Jamiołkowski isomorphism between superoperator matrices and Choi matrices; pure index permutation (Watrous / QuTiP convention); bit-identical round-trip is the decisive invariant. qinfo v0.1 (ADR-0034)",
  schema: { input: inputSchema, output: outputSchema },
  numerical: true, // ADR-0034 §D8: index-only ops are platform-bit-identical-in-practice
  examples: [
    ex_identity_qubit_forward,
    ex_identity_qubit_inverse,
    ex_transpose_map,
    ex_depolarising_half,
  ],
  invariants: [
    {
      name: "round-trip",
      statement: "deChoi(choi(S, d_in, d_out), d_in, d_out) = S (exact, bit-identical)",
      machine_checkable: true,
    },
    {
      name: "identity-channel-choi-is-omega",
      statement:
        "J(id_d) = |Ω⟩⟨Ω| where |Ω⟩ = Σ_i |ii⟩ — a rank-1 PSD matrix with trace d (unnormalised)",
      machine_checkable: true,
    },
    {
      name: "linearity",
      statement: "choi(αS + βT) = α·choi(S) + β·choi(T)",
      machine_checkable: true,
    },
    {
      name: "shape-forward",
      statement: "choi(d_out²×d_in² matrix) = (d_in·d_out)×(d_in·d_out) matrix",
      machine_checkable: true,
    },
    {
      name: "shape-inverse",
      statement: "deChoi((d_in·d_out)×(d_in·d_out) matrix) = (d_out²×d_in²) matrix",
      machine_checkable: true,
    },
    {
      name: "transpose-map-is-swap",
      statement:
        "J(T) where T(ρ) = ρᵀ equals the SWAP matrix — the canonical positive-but-not-CP witness",
      machine_checkable: true,
    },
    {
      name: "rejects-malformed",
      statement:
        "shape/dim mismatch, non-positive dim, non-finite entries → ToolError (not a wrong-shaped success record)",
      machine_checkable: true,
    },
  ],
  fn: (input, _flags): Value => {
    // The runner has validated `input` against `inputSchema` already, so
    // `input` is statically `TaggedValue` with `tag ∈ {FORWARD_TAG,
    // INVERSE_TAG}` and `payload` a record matching the corresponding
    // payload schema. The TS narrowing comes from `input.tag`.
    if (input.kind !== "tagged") {
      // Unreachable post-validation; guard exists to satisfy the type
      // system rather than to catch a real input. Loud, not silent.
      throw new ToolError(
        `${NAME}: internal — expected tagged input post-schema-validation, got kind=${input.kind}`,
        {},
      );
    }

    if (input.tag === FORWARD_TAG) {
      const fields = (input.payload as RecordValue).fields;
      const channel = valueToMatrix(fields.channel as Value, "channel");
      const dim_in = readPositiveInt(fields.dim_in as Value, "dim_in");
      const dim_out = readPositiveInt(fields.dim_out as Value, "dim_out");
      const dInSq = dim_in * dim_in;
      const dOutSq = dim_out * dim_out;
      if (channel.rows !== dOutSq || channel.cols !== dInSq) {
        throw new ToolError(
          `${NAME}: channel must be (d_out²·d_in²) = (${dOutSq}, ${dInSq}), got (${channel.rows}, ${channel.cols})`,
          {
            suggestion: `For a channel Φ : M_${dim_in} → M_${dim_out}, the superoperator matrix S satisfies vec(Φ(ρ)) = S·vec(ρ) and has size (d_out²×d_in²). Check that dim_in=${dim_in} and dim_out=${dim_out} match your matrix.`,
          },
        );
      }
      const J = choi(channel, dim_in, dim_out);
      return record({
        J: matrixToValue(J),
        shape: list([int(BigInt(J.rows)), int(BigInt(J.cols))]),
        warnings: list([]),
      });
    }

    if (input.tag === INVERSE_TAG) {
      const fields = (input.payload as RecordValue).fields;
      const J = valueToMatrix(fields.J as Value, "J");
      const dim_in = readPositiveInt(fields.dim_in as Value, "dim_in");
      const dim_out = readPositiveInt(fields.dim_out as Value, "dim_out");
      const dJ = dim_in * dim_out;
      if (J.rows !== dJ || J.cols !== dJ) {
        throw new ToolError(
          `${NAME}: J must be (d_in·d_out × d_in·d_out) = (${dJ}, ${dJ}), got (${J.rows}, ${J.cols})`,
          {
            suggestion: `For a channel Φ : M_${dim_in} → M_${dim_out}, the Choi matrix has size (d_in·d_out)² = ${dJ}². Check that dim_in=${dim_in} and dim_out=${dim_out} match your matrix.`,
          },
        );
      }
      const S_out = deChoi(J, dim_in, dim_out);
      return record({
        channel: matrixToValue(S_out),
        shape: list([int(BigInt(S_out.rows)), int(BigInt(S_out.cols))]),
        warnings: list([]),
      });
    }

    // Unreachable: schema validation pins the tag to one of FORWARD_TAG /
    // INVERSE_TAG. A loud failure here would mean the schema and the
    // dispatch disagree — that's a bug, not user error.
    throw new ToolError(
      `${NAME}: internal — unexpected tag '${input.tag}' post-schema-validation`,
      {},
    );
  },
  test: () => {
    // Round-trip on a non-trivial channel: amplitude-damping at γ = 1/2.
    // Kraus operators K_0 = [[1,0],[0,√(1−γ)]], K_1 = [[0,√γ],[0,0]] give
    // the superoperator S = Σ_α K̄_α ⊗ K_α (column-stacking).
    const g = 0.5;
    const s = Math.sqrt(1 - g);
    // S[i_out + 2·j_out, i_in + 2·j_in] = Σ_α K_α[i_out,i_in] K̄_α[j_out,j_in].
    // (Real Kraus ops, so K̄ = K.)
    const Ks = [
      [
        [1, 0],
        [0, s],
      ],
      [
        [0, Math.sqrt(g)],
        [0, 0],
      ],
    ];
    const S_in = new Array(4).fill(0).map(() => new Array(4).fill(0));
    for (let iout = 0; iout < 2; iout++) {
      for (let jout = 0; jout < 2; jout++) {
        for (let iin = 0; iin < 2; iin++) {
          for (let jin = 0; jin < 2; jin++) {
            let acc = 0;
            for (const K of Ks) acc += K[iout]![iin]! * K[jout]![jin]!;
            S_in[iout + 2 * jout]![iin + 2 * jin] = acc;
          }
        }
      }
    }
    const M_S = fromNested(S_in);
    const J = choi(M_S, 2, 2);
    const M_S_back = deChoi(J, 2, 2);
    let maxErr = 0;
    for (let k = 0; k < 16; k++) {
      const diff = Math.abs(M_S_back.re[k]! - M_S.re[k]!);
      if (diff > maxErr) maxErr = diff;
    }
    if (maxErr > 0) {
      throw new Error(
        `choi-iso --test: round-trip on amplitude-damping should be bit-identical (got max diff ${maxErr})`,
      );
    }
    // Identity-channel Choi structural check: J should be |Ω⟩⟨Ω| with
    // entries 1 only at (0,0), (0,3), (3,0), (3,3).
    const I4 = fromNested([
      [1, 0, 0, 0],
      [0, 1, 0, 0],
      [0, 0, 1, 0],
      [0, 0, 0, 1],
    ]);
    const J_id = choi(I4, 2, 2);
    const expected: [number, number, number][] = [
      [0, 0, 1],
      [0, 3, 1],
      [3, 0, 1],
      [3, 3, 1],
    ];
    const expectedSet = new Set(expected.map(([i, j]) => `${i},${j}`));
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 4; j++) {
        const got = J_id.re[i * 4 + j]!;
        const want = expectedSet.has(`${i},${j}`) ? 1 : 0;
        if (Math.abs(got - want) > 0) {
          throw new Error(
            `choi-iso --test: J(id) entry [${i},${j}] = ${got}, expected ${want}`,
          );
        }
      }
    }
    // Transpose-map Choi = SWAP. Check the off-diagonal pair (1,2) and
    // (2,1) are both 1 — the signature of the non-CP-ness witness.
    const T_super = fromNested([
      [1, 0, 0, 0],
      [0, 0, 1, 0],
      [0, 1, 0, 0],
      [0, 0, 0, 1],
    ]);
    const J_T = choi(T_super, 2, 2);
    const swap = fromNested([
      [1, 0, 0, 0],
      [0, 0, 1, 0],
      [0, 1, 0, 0],
      [0, 0, 0, 1],
    ]);
    for (let k = 0; k < 16; k++) {
      if (J_T.re[k]! !== swap.re[k]!) {
        throw new Error(
          `choi-iso --test: J(transpose) should equal SWAP, mismatch at flat-index ${k}`,
        );
      }
    }
  },
});

if (import.meta.main) void runTool(def);
