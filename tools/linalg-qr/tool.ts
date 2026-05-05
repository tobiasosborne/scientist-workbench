// =============================================================================
// linalg-qr — Householder QR factorisation of a real m×n matrix
// =============================================================================
//
// Intent
// ------
// The third numerical-tier tool in scientist-workbench, after `linalg-solve`
// (ADR-0014) and `integrate-1d` (ADR-0015 follow-on). Computes
//
//     A = Q · R
//
// for a real m×n matrix `A` by Householder reflections. Wire wrapper
// around `qr(A, mode)` from `@workbench/linalg-core` — library and tool
// share one implementation per ADR-0010, so an in-process TS caller and
// a subprocess agent see the same backward-stable answer.
//
// What makes this tool agent-honest (the load-bearing design choice)
// ------------------------------------------------------------------
// The output is *not* just `(Q, R)`. It is a record carrying everything
// an agent's planner — or the bench's verifier — needs to decide what
// to do with the answer:
//
//     {
//       Q,                    // m × k orthogonal factor (k depends on mode)
//       R,                    // k × n upper-triangular factor
//       mode,                 // "reduced" | "complete" — echoes the request
//       diagonal_R,           // diag(R), top min(m,n) entries; rank-revealer
//       reconstruction_error, // ||Q·R − A||_F / max(||A||_F, 1)
//       orthogonality_error,  // ||QᵀQ − I_k||_F
//       method,               // always "householder" for v0.1
//       warnings,             // soft thresholds the planner may match on
//     }
//
// `reconstruction_error` and `orthogonality_error` are the *candidate's
// honest self-report* on its own quality (precedent: `linalg-solve`'s
// `residual_norm`, ADR-0014). The bench's verifier (`bench/linalg-qr/
// golden/verify.py`) recomputes both and rejects the candidate if the
// reported value disagrees with the recomputation by more than 1e-6
// relative — agent-honest is *enforced*, not just convention.
//
// Why Householder, not Gram-Schmidt
// ---------------------------------
// Householder QR delivers `‖QᵀQ − I‖_F = O(ε)` *independent of κ(A)*.
// Modified Gram-Schmidt gives `O(κ · ε)` — fails on Hilbert-8 (κ ≈
// 1.5e10 ⇒ orth error ≈ 3e-6). Classical Gram-Schmidt gives `O(κ² · ε)`
// — fails already on Hilbert-6. The bench's `Q_orthonormal` check pins
// `tol_orth = 100 · ε · m · √k` independent of κ, which is exactly the
// promise Householder makes and the other two algorithms cannot. The
// substrate (`packages/linalg-core/src/qr.ts`) carries the full literate
// algorithm prose; this file is only the wire-encoding wrapper.
//
// Boundary categories (ADR-0003)
// ------------------------------
//   * `linalg-qr/non-finite-input`  (tagged): `A` contains NaN / ±Inf.
//                                   Payload carries the row, column, and
//                                   the offending value as a string.
//                                   "Tagged" rather than `ToolError`
//                                   because the input is structurally
//                                   well-formed: the caller may reasonably
//                                   ask "what does QR think of this?" and
//                                   our honest answer is "out of scope."
//   * `linalg-qr/degenerate-shape`  (tagged): m = 0 or n = 0. Payload
//                                   carries m, n. Same reasoning: a
//                                   zero-by-anything input is structurally
//                                   valid wire-form; the algorithm has no
//                                   answer to give.
//   * `ToolError` (exit 1) for *malformed* input:
//     - non-rectangular `A` (ragged rows)
//     - `m · n > 200 · 200` — the v0.1 cap; suggestion points to bead `wmm`
//       (the blob-by-hash convention follow-up).
//
// Why the boundary split
// ----------------------
// `linalg-solve` puts non-finite entries in `ToolError` and tags the
// singular case. Why does `linalg-qr` flip the polarity for non-finite?
// Two reasons. First, QR is *defined* for every real matrix, including
// rank-deficient ones, so "rank deficient" is *not* a boundary — the
// substrate just produces small `diag(R)` entries. There is no analogue
// of `linalg-solve`'s `singular` tag. Second, the bench's `golden/inputs.
// json` deliberately exercises shape edges (1×1, 2×1) that some agents
// might encode with stray NaN scratch — making non-finite a tagged
// boundary lets a planner introspect the offending cell rather than
// receiving an opaque exit-1.
//
// Out of scope (v0.1, all explicitly deferred)
// --------------------------------------------
//   * Pivoting QR (column-pivoted, rank-revealing) — bead 71f
//   * SVD / eigendecomposition / generalised eigenvalues — bead 71f
//   * `m·n > 200·200` — bead `wmm` (blob-by-hash convention)
//   * FFI to LAPACK DGEQRF — bead `e7y`
//   * Cross-platform determinism guarantee — `numerical: true` (ADR-0015)
//
// Algorithm
// ---------
// Householder reflections (Golub & Van Loan §5.2.1). LAPACK DGEQRF
// storage convention: Householder vectors stored below the diagonal
// of the work array, τ in a separate length-k vector, R in the upper
// triangle. Backward accumulation of Q from right to left to keep the
// running orthogonality at machine epsilon (Golub & Van Loan §5.1.6).
// See `packages/linalg-core/src/qr.ts` for the full literate algorithm
// prose.

import {
  float64FromNumber,
  float64ToNumber,
  int,
  list,
  record,
  S,
  str,
  tagged,
  ToolError,
  type Float64Value,
  type Value,
} from "@workbench/protocol";
import { defineTool, F, runTool } from "@workbench/contract";
import {
  type Matrix,
  type QRResult,
  matrixFromRows,
  qr,
} from "@workbench/linalg-core";

const NAME = "linalg-qr";
const VERSION = "0.1.0";

// v0.1 cap mirroring `linalg-solve` (ADR-0014). The forcing function:
// a request that exceeds this points the agent at bead `wmm` for the
// blob-by-hash follow-up. The check is `m · n > MAX_CELLS` rather than
// per-axis because a 200×200 matrix and a 1×40000 vector both encode
// to the same JSON byte budget at the wire boundary.
const MAX_CELLS = 200 * 200;

// Soft warning thresholds. These are *fields* of the output record,
// not boundary refusals — the planner reads them and decides. We
// piggyback on the bench's tolerance derivation (Higham 2002 §19.4 with
// 100× safety): if the candidate's reported error exceeds 1e-12, the
// case is *probably* still correct (the bench's tolerance is wider) but
// the planner deserves to know it's near the floor.
const RECONSTRUCTION_WARNING = 1e-12;
const ORTHOGONALITY_WARNING = 1e-12;

// -----------------------------------------------------------------------------
// Schema
// -----------------------------------------------------------------------------
//
// Input is a record with a required `A` (list of lists of float64) and
// an `mode` field (string). The bench's wire format omits `mode` for
// the default and includes `mode: "complete"` only when needed; the
// adapter (`bench/linalg-qr/run-candidate.ts`) only emits the field
// when the caller's input has it. We declare it in the schema so the
// runner accepts both shapes — the runner treats absent record fields
// as "field missing" without rejecting unless the schema is explicitly
// `required`.
//
// `mode` is decoded inside `fn`; absence resolves to "reduced" (the
// LAPACK economy default and the bench's reference behaviour).

const inputSchema = S.record(
  {
    A: S.list(S.list(S.kind("float64"))),
    mode: S.kind("string"),
  },
  { optional: ["mode"] as const },
);

const successOutputSchema = S.record({
  Q: S.list(S.list(S.kind("float64"))),
  R: S.list(S.list(S.kind("float64"))),
  mode: S.kind("string"),
  diagonal_R: S.list(S.kind("float64")),
  reconstruction_error: S.kind("float64"),
  orthogonality_error: S.kind("float64"),
  method: S.kind("string"),
  warnings: S.list(S.kind("string")),
});

const nonFiniteOutputSchema = S.tagged(
  `${NAME}/non-finite-input`,
  S.record({
    row: S.kind("integer"),
    col: S.kind("integer"),
    value: S.kind("string"),
  }),
);

const degenerateOutputSchema = S.tagged(
  `${NAME}/degenerate-shape`,
  S.record({
    m: S.kind("integer"),
    n: S.kind("integer"),
  }),
);

const outputSchema = S.union([
  successOutputSchema,
  nonFiniteOutputSchema,
  degenerateOutputSchema,
]);

// -----------------------------------------------------------------------------
// Wire encoding helpers
// -----------------------------------------------------------------------------

function listOfFloat64(xs: Float64Array | readonly number[]): {
  readonly kind: "list";
  readonly items: readonly Float64Value[];
} {
  const items = new Array<Float64Value>(xs.length);
  for (let i = 0; i < xs.length; i++) items[i] = float64FromNumber(xs[i]!);
  return list(items);
}

function matrixToRowsValue(M: Matrix): {
  readonly kind: "list";
  readonly items: readonly { readonly kind: "list"; readonly items: readonly Float64Value[] }[];
} {
  const rows = new Array<{ readonly kind: "list"; readonly items: readonly Float64Value[] }>(M.rows);
  for (let i = 0; i < M.rows; i++) {
    const row = new Array<Float64Value>(M.cols);
    for (let j = 0; j < M.cols; j++) row[j] = float64FromNumber(M.data[i * M.cols + j]!);
    rows[i] = list(row);
  }
  return list(rows);
}

// -----------------------------------------------------------------------------
// Examples — each branch of the output union covered at least once
// -----------------------------------------------------------------------------
//
// The bench's `shape` check requires `mode` to echo back. For the
// minimal-input examples (where the caller omitted `mode`), the
// substrate's default is "reduced"; we pass "reduced" explicitly to the
// example builder so the output's mode field reads correctly.

function inp(A: readonly (readonly number[])[], mode: string) {
  return record({
    A: list(A.map((row) => listOfFloat64(row))),
    mode: str(mode),
  });
}

function encodeSuccess(r: QRResult) {
  const warnings: string[] = [];
  if (r.reconstructionError > RECONSTRUCTION_WARNING) {
    warnings.push(
      `reconstruction error ${r.reconstructionError.toExponential(2)} exceeds soft floor ${RECONSTRUCTION_WARNING.toExponential(0)}`,
    );
  }
  if (r.orthogonalityError > ORTHOGONALITY_WARNING) {
    warnings.push(
      `orthogonality error ${r.orthogonalityError.toExponential(2)} exceeds soft floor ${ORTHOGONALITY_WARNING.toExponential(0)}`,
    );
  }
  return record({
    Q: matrixToRowsValue(r.Q),
    R: matrixToRowsValue(r.R),
    mode: str(r.mode),
    diagonal_R: listOfFloat64(r.diagonalR),
    reconstruction_error: float64FromNumber(r.reconstructionError),
    orthogonality_error: float64FromNumber(r.orthogonalityError),
    method: str("householder"),
    warnings: list(warnings.map((w) => str(w))),
  });
}

// -----------------------------------------------------------------------------
// Tool definition
// -----------------------------------------------------------------------------

export const def = defineTool({
  name: NAME,
  version: VERSION,
  schema: { input: inputSchema, output: outputSchema },
  // ADR-0015: numerical tier. The output always contains float64
  // leaves on the success branch (Q, R, diagonal_R, both error
  // scalars), so the platform fingerprint is recorded on every
  // successful run. The boundary-tag branches (non-finite-input,
  // degenerate-shape) carry the offending row/col/value; the
  // `containsFloat64` walker in the runner picks those up too.
  // Mutually exclusive with `nondeterministic: true`.
  numerical: true,
  flags: {
    // The `--method` flag exists for symmetry with `linalg-solve` —
    // currently the only choice is "householder", which is the only
    // backward-stable algorithm at scale. Adding "givens" or
    // "blocked-householder" later is schema-additive.
    method: F.enum(["householder"] as const, "QR algorithm", { default: "householder" }),
  },
  examples: [
    {
      description: "1×1 reduced: A=[[3]], R[0,0]=-3 (sign convention)",
      input: inp([[3]], "reduced"),
      output: encodeSuccess(qr(matrixFromRows([[3]]), "reduced")),
    },
    {
      description: "5×3 simple: standard tall case (matches bench A_5x3)",
      input: inp(
        [[1, 2, 3], [4, 5, 6], [7, 8, 10], [1, 0, 1], [0, 1, 0]],
        "reduced",
      ),
      output: encodeSuccess(
        qr(
          matrixFromRows([[1, 2, 3], [4, 5, 6], [7, 8, 10], [1, 0, 1], [0, 1, 0]]),
          "reduced",
        ),
      ),
    },
    {
      description: "3×5 short-and-fat: m<n, Q is 3×3, R is 3×5",
      input: inp(
        [[1, 2, 3, 4, 5], [2, 1, 0, -1, 1], [3, 0, -1, 2, 1]],
        "reduced",
      ),
      output: encodeSuccess(
        qr(
          matrixFromRows([[1, 2, 3, 4, 5], [2, 1, 0, -1, 1], [3, 0, -1, 2, 1]]),
          "reduced",
        ),
      ),
    },
    {
      description: "complete-mode 5×3: Q is 5×5, R is 5×3 with bottom 2 rows = 0",
      input: inp(
        [[1, 2, 3], [4, 5, 6], [7, 8, 10], [1, 0, 1], [0, 1, 0]],
        "complete",
      ),
      output: encodeSuccess(
        qr(
          matrixFromRows([[1, 2, 3], [4, 5, 6], [7, 8, 10], [1, 0, 1], [0, 1, 0]]),
          "complete",
        ),
      ),
    },
    {
      description: "all-zero 2×2: R=0, Q=I (degenerate but in-scope)",
      input: inp([[0, 0], [0, 0]], "reduced"),
      output: encodeSuccess(qr(matrixFromRows([[0, 0], [0, 0]]), "reduced")),
    },
    {
      description: "non-finite input → tagged 'linalg-qr/non-finite-input'",
      input: inp([[1, 2], [3, NaN]], "reduced"),
      output: tagged(`${NAME}/non-finite-input`, record({
        row: int(1n),
        col: int(1n),
        value: str("NaN"),
      })),
    },
    {
      description: "degenerate shape (m=0) → tagged 'linalg-qr/degenerate-shape'",
      // The wire encoding for an empty list-of-list is just `list([])`.
      input: record({ A: list([]), mode: str("reduced") }),
      output: tagged(`${NAME}/degenerate-shape`, record({
        m: int(0n),
        n: int(0n),
      })),
    },
  ],
  invariants: [
    {
      name: "deterministic-per-platform",
      statement: "same input bytes → same output bytes (single platform; ADR-0015 platform fingerprint recorded in provenance)",
      machine_checkable: true,
    },
    {
      name: "reconstruction",
      statement: "for every successful factorisation, ||Q · R − A||_F ≤ 100·ε·max(m,n)·sqrt(min(m,n))·||A||_F (Higham 2002 Thm 19.4)",
      machine_checkable: true,
    },
    {
      name: "orthogonality",
      statement: "for every successful factorisation, ||QᵀQ − I_k||_F ≤ 100·ε·m·sqrt(k) — independent of κ(A) (the Householder discriminator)",
      machine_checkable: true,
    },
    {
      name: "R-upper-triangular",
      statement: "R[i,j] = 0 for i > j (within the min(m,n) block); for mode=complete with m>n, the bottom (m-n) rows of R are exactly zero",
      machine_checkable: true,
    },
    {
      name: "self-reported-honesty",
      statement: "reported reconstruction_error and orthogonality_error agree with verifier's recomputation to 1e-6 relative — no quietly inflated honesty",
      machine_checkable: true,
    },
    {
      name: "non-finite-tagged",
      statement: `any NaN or ±Inf in A → tagged "${NAME}/non-finite-input" with the offending (row, col, value) — never silently propagated through the algorithm`,
      machine_checkable: true,
    },
    {
      name: "degenerate-shape-tagged",
      statement: `m = 0 or n = 0 → tagged "${NAME}/degenerate-shape" with (m, n) — never an unhelpful exit-1`,
      machine_checkable: true,
    },
    {
      name: "size-cap-rejected",
      statement: `m·n > ${MAX_CELLS} raises ToolError pointing at the v0.2 follow-up (bead wmm)`,
      machine_checkable: true,
    },
    {
      name: "non-rectangular-rejected",
      statement: "ragged A (rows of unequal length) raises ToolError",
      machine_checkable: true,
    },
  ],
  fn: (input, _flags) => {
    // The runner has validated the input shape against `inputSchema`,
    // so the structural invariant `A: list<list<float64>>` and
    // (when present) `mode: string` already hold; only semantic
    // checks remain.
    const fields = input.fields;
    const aValue: Value = fields.A as Value;
    const modeValue: Value | undefined = fields.mode as Value | undefined;

    // ── decode `mode` (default "reduced") and check admitted values ───────
    const modeStr =
      modeValue === undefined
        ? "reduced"
        : (modeValue as { kind: "string"; value: string }).value;
    if (modeStr !== "reduced" && modeStr !== "complete") {
      throw new ToolError(
        `${NAME}: mode must be "reduced" or "complete", got ${JSON.stringify(modeStr)}`,
        { suggestion: "omit the mode field for the default ('reduced'), or set it to 'complete' for the full m×m Q" },
      );
    }
    const mode = modeStr as "reduced" | "complete";

    // ── decode A row-by-row, intercepting non-finite cells ────────────────
    if (aValue.kind !== "list") {
      throw new ToolError(`${NAME}: A must be a list of lists of float64`, {});
    }
    const m = aValue.items.length;

    // Degenerate shape: m = 0. We deliberately do not pre-check n here
    // because there are no rows to read n from.
    if (m === 0) {
      return tagged(`${NAME}/degenerate-shape`, record({
        m: int(0n),
        n: int(0n),
      }));
    }

    // Determine n from the first row, then enforce rectangularity.
    const firstRow = aValue.items[0]!;
    if (firstRow.kind !== "list") {
      throw new ToolError(`${NAME}: A[0] is not a list`, {});
    }
    const n = firstRow.items.length;

    if (n === 0) {
      return tagged(`${NAME}/degenerate-shape`, record({
        m: int(BigInt(m)),
        n: int(0n),
      }));
    }

    // Size cap — refuses both `n×n > MAX` and tall/fat shapes that
    // exceed the byte budget. ToolError because oversized input is
    // *malformed* relative to v0.1's stated scope.
    if (m * n > MAX_CELLS) {
      throw new ToolError(
        `${NAME}: m·n = ${m * n} exceeds v0.1 cap (${MAX_CELLS} = 200·200)`,
        {
          suggestion:
            `for matrices with m·n > ${MAX_CELLS}, the wire encoding cost is high; see bead scientist-workbench-wmm (blob-by-hash convention) and -e7y (FFI LAPACK path)`,
        },
      );
    }

    // Walk the rows. Two passes' worth of work in one: rectangularity
    // + non-finite detection + decoding into a flat Float64Array. We
    // could call `matrixFromRows` after collecting the rows, but it
    // raises a `MatrixError` on non-finite entries; we want a *tagged*
    // boundary value with row/col coordinates, so we walk by hand.
    const data = new Float64Array(m * n);
    for (let i = 0; i < m; i++) {
      const row = aValue.items[i]!;
      if (row.kind !== "list") {
        throw new ToolError(`${NAME}: A[${i}] is not a list`, {});
      }
      if (row.items.length !== n) {
        throw new ToolError(
          `${NAME}: A is not rectangular (row 0 has ${n} entries, row ${i} has ${row.items.length})`,
          { suggestion: "every row of A must have the same length" },
        );
      }
      for (let j = 0; j < n; j++) {
        const cell = row.items[j]!;
        if (cell.kind !== "float64") {
          throw new ToolError(`${NAME}: A[${i}][${j}] is not a float64`, {});
        }
        const x = float64ToNumber(cell);
        if (!Number.isFinite(x)) {
          // Boundary tagged: the offending coordinate plus a string
          // rendering of the bad value (Inf / NaN / -Inf) so a
          // planner can match on it without re-decoding the bits.
          return tagged(`${NAME}/non-finite-input`, record({
            row: int(BigInt(i)),
            col: int(BigInt(j)),
            value: str(formatNonFinite(x)),
          }));
        }
        data[i * n + j] = x;
      }
    }

    // The substrate operates on `Matrix`. Construct it directly from
    // the validated data buffer (skipping `matrixFromRows`'s own
    // validation, which we just did).
    const A: Matrix = { rows: m, cols: n, data };
    const result = qr(A, mode);
    return encodeSuccess(result);
  },
  test: () => {
    // Smoke probe: a 5×3 case must round-trip through the substrate
    // and self-report errors that match an independent recomputation
    // (the same check the bench's verify.py applies).
    const A = matrixFromRows([
      [1, 2, 3],
      [4, 5, 6],
      [7, 8, 10],
      [1, 0, 1],
      [0, 1, 0],
    ]);
    const r = qr(A, "reduced");
    if (r.Q.rows !== 5 || r.Q.cols !== 3) {
      throw new Error(`test: 5×3 Q shape wrong — ${r.Q.rows}×${r.Q.cols}`);
    }
    if (r.R.rows !== 3 || r.R.cols !== 3) {
      throw new Error(`test: 5×3 R shape wrong — ${r.R.rows}×${r.R.cols}`);
    }
    if (r.reconstructionError > 1e-12) {
      throw new Error(`test: 5×3 reconstruction ${r.reconstructionError} > 1e-12`);
    }
    if (r.orthogonalityError > 1e-12) {
      throw new Error(`test: 5×3 orthogonality ${r.orthogonalityError} > 1e-12`);
    }
    // Hilbert-8: the discriminator. Even at κ ≈ 1.5e10, Householder's
    // orthogonality must stay near machine epsilon. Modified Gram-
    // Schmidt would produce ~3e-6 here.
    const H = matrixFromRows(
      Array.from({ length: 8 }, (_, i) =>
        Array.from({ length: 8 }, (_, j) => 1 / (i + j + 1)),
      ),
    );
    const rh = qr(H, "reduced");
    if (rh.orthogonalityError > 1e-12) {
      throw new Error(
        `test: Hilbert-8 orthogonality ${rh.orthogonalityError} > 1e-12 — Householder regression?`,
      );
    }
    // Sign convention: x = [3, 4]ᵀ should give R[0,0] = -5 (Householder
    // picks α = -sign(x[0])·||x||).
    const Asign = matrixFromRows([[3, 0], [4, 0]]);
    const rs = qr(Asign, "reduced");
    if (Math.abs(rs.R.data[0]! - (-5)) > 1e-12) {
      throw new Error(
        `test: sign convention — R[0,0] should be -5, got ${rs.R.data[0]}`,
      );
    }
  },
});

// -----------------------------------------------------------------------------
// Helpers — formatting for the tagged-boundary payload
// -----------------------------------------------------------------------------

function formatNonFinite(v: number): string {
  if (Number.isNaN(v)) return "NaN";
  if (v === Infinity) return "Infinity";
  if (v === -Infinity) return "-Infinity";
  return String(v);
}

if (import.meta.main) void runTool(def);
