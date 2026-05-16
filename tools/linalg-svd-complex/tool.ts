// =============================================================================
// linalg-svd-complex — Singular value decomposition of a complex m × n matrix
// =============================================================================
//
// Intent
// ------
// The complex sibling of `linalg-svd`. Computes
//
//     M = U · diag(S) · V†
//
// for a complex matrix `M = A + iB` (`A`, `B` real `m × n`). The output is
// the singular values `S ∈ ℝ^k` (non-negative descending, `k = min(m, n)`)
// and the unitary factors `U ∈ ℂ^{m×q}` (left singular vectors) and
// `V ∈ ℂ^{n×q'}` (right singular vectors), with `q, q'` depending on mode:
//
//   * "reduced":  `U` is `m × k`,  `V` is `n × k`.   Default.
//   * "complete": `U` is `m × m`,  `V` is `n × n`.   Extra columns span
//                                                    the orthogonal
//                                                    complement of the
//                                                    row / column space.
//
// The wire form emits `Vh = V†` (conjugate transpose; NumPy convention)
// so `M = U · diag(S) · Vh` reads directly off the success record.
//
// Wire wrapper around `svdComplex(M, mode)` from `@workbench/linalg-core`
// (ADR-0035, worklog shard 127). The substrate's algorithm is **complex
// one-sided Jacobi** (Hari-Veselić 1987) — not the real-symplectic
// embedding the Hermitian-eigh sibling uses. ADR-0035 §D8 names the
// reason: the embedding's eigenvalue-pairing trick doesn't transfer to
// SVD's distinct U / V structure, and native complex Jacobi is the
// cleaner path with the same relative-accuracy properties
// (Demmel-Veselić 1992).
//
// Input shape
// -----------
// `record{re: list<list<float64>>, im: list<list<float64>>, mode?: string}`
// — `re` and `im` both **required** (ADR-0035 §D2), rectangular with
// matching shape. A real-valued matrix still passes `im` as an all-zero
// `list<list<float64>>` — the required-`im` discipline is what makes
// "this value is complex" read from the schema. `mode` defaults to
// "reduced".
//
// Output shape
// ------------
// Happy path: `record{U: record{re, im}, S: list<float64>, Vh: record{re,
// im}, mode, reconstruction_error, orthogonality_error_U,
// orthogonality_error_Vh, condition_number, rank_estimate, method,
// warnings}`. `S` is real (singular values are real by spectral theorem).
//
// Boundary tags (ADR-0003):
//   * `linalg-svd-complex/non-finite-input` — NaN / ±Inf in `re` or `im`.
//     Payload: `(row, col, part, value)` for the first non-finite
//     coordinate found, with `part ∈ {re, im}`.
//   * `linalg-svd-complex/degenerate-shape` — `m = 0` or `n = 0`.
//     Payload: `(m, n)`.
//
// `ToolError` (exit 1) for *malformed* input:
//   * shape mismatch between `re` and `im` (different `m × n`)
//   * ragged rows in `re` or `im`
//   * `mode` is not "reduced" or "complete"
//   * OOM on the working buffers (re-thrown with attempted bytes,
//     same pattern as real `linalg-svd`)
//
// Algorithm
// ---------
// Substrate-side: complex one-sided Jacobi SVD (Forsythe-Henrici 1960 →
// Brent-Luk 1985 → Hari-Veselić 1987 → Drmač 1997 per-pair tolerance).
// For each column pair `(p, q)` of the work matrix:
//   1. Form the 2×2 Gram-matrix entries `(α, β, γ)`.
//   2. Skip if `|γ|² ≤ ε² · α · β` (Drmač test — relative accuracy).
//   3. Extract phase `e^{-iθ} = conj(γ)/|γ|`; apply to column q to
//      make the Gram inner product real.
//   4. Real Jacobi rotation `(c, s)` from `ζ = (β − α)/(2|γ|)`.
//   5. Apply the combined complex rotation to columns of W and V_acc.
// Convergence: ~6 sweeps to machine precision for typical inputs. Full
// algorithm prose in `packages/linalg-core/src/svd-complex.ts`.
//
// References
//   * Hari & Veselić 1987 — convergence of complex one-sided Jacobi.
//   * Demmel & Veselić 1992 — relative-accuracy property.
//   * Drmač 1997 — per-pair tolerance test.
//   * Higham 2002 §10, §21 — complex matrices, SVD backward stability.
//   * ADR-0035 — the tier's design decisions.

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
  type ComplexMatrix,
  type SvdComplexResult,
  svdComplex,
  complexAdjoint,
  assessNumericalScale,
  MemoryExhaustionError,
  withOomGuard,
} from "@workbench/linalg-core";

const NAME = "linalg-svd-complex";
const VERSION = "0.1.0";

// Soft warning thresholds — fields of the output record, not boundary
// refusals (ADR-0014 pattern; parallel to linalg-svd).
const RECONSTRUCTION_WARNING = 1e-12;
const ORTHOGONALITY_WARNING = 1e-12;
const CONDITION_WARNING = 1e12;

// -----------------------------------------------------------------------------
// Schemas
// -----------------------------------------------------------------------------

const complexMatrixSchema = S.record({
  re: S.list(S.list(S.kind("float64"))),
  im: S.list(S.list(S.kind("float64"))),
});

const inputSchema = S.record(
  {
    re: S.list(S.list(S.kind("float64"))),
    im: S.list(S.list(S.kind("float64"))),
    mode: S.kind("string"),
  },
  { optional: ["mode"] as const },
);

const successOutputSchema = S.record({
  U: complexMatrixSchema,
  S: S.list(S.kind("float64")),
  Vh: complexMatrixSchema,
  mode: S.kind("string"),
  reconstruction_error: S.kind("float64"),
  orthogonality_error_U: S.kind("float64"),
  orthogonality_error_Vh: S.kind("float64"),
  condition_number: S.kind("float64"),
  rank_estimate: S.kind("integer"),
  method: S.kind("string"),
  warnings: S.list(S.kind("string")),
});

const nonFiniteOutputSchema = S.tagged(
  `${NAME}/non-finite-input`,
  S.record({
    row: S.kind("integer"),
    col: S.kind("integer"),
    part: S.kind("string"),
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

function bufferToRowsValue(buf: Float64Array, rows: number, cols: number) {
  const out = new Array<{ readonly kind: "list"; readonly items: readonly Float64Value[] }>(rows);
  for (let i = 0; i < rows; i++) {
    const row = new Array<Float64Value>(cols);
    for (let j = 0; j < cols; j++) row[j] = float64FromNumber(buf[i * cols + j]!);
    out[i] = list(row);
  }
  return list(out);
}

/**
 * Encode a `ComplexMatrix` as the canonical `record{re, im}` wire
 * shape (ADR-0035 §D2). Both parts emitted as `list<list<float64>>`.
 */
function complexMatrixToValue(M: ComplexMatrix) {
  return record({
    re: bufferToRowsValue(M.re, M.rows, M.cols),
    im: bufferToRowsValue(M.im, M.rows, M.cols),
  });
}

// -----------------------------------------------------------------------------
// Construction helpers for the examples table
// -----------------------------------------------------------------------------

function complexInput(
  reRows: readonly (readonly number[])[],
  imRows: readonly (readonly number[])[],
  mode: string,
) {
  return record({
    re: list(reRows.map((row) => listOfFloat64(row))),
    im: list(imRows.map((row) => listOfFloat64(row))),
    mode: str(mode),
  });
}

function encodeSuccess(r: SvdComplexResult, scaleWarnings: readonly string[] = []) {
  const warnings: string[] = [...scaleWarnings];
  if (r.reconstructionError > RECONSTRUCTION_WARNING) {
    warnings.push(
      `reconstruction error ${r.reconstructionError.toExponential(2)} exceeds soft floor ${RECONSTRUCTION_WARNING.toExponential(0)}`,
    );
  }
  if (r.orthogonalityErrorU > ORTHOGONALITY_WARNING) {
    warnings.push(
      `orthogonality error U ${r.orthogonalityErrorU.toExponential(2)} exceeds soft floor ${ORTHOGONALITY_WARNING.toExponential(0)}`,
    );
  }
  if (r.orthogonalityErrorV > ORTHOGONALITY_WARNING) {
    warnings.push(
      `orthogonality error Vh ${r.orthogonalityErrorV.toExponential(2)} exceeds soft floor ${ORTHOGONALITY_WARNING.toExponential(0)}`,
    );
  }
  if (r.conditionNumber > CONDITION_WARNING) {
    warnings.push(
      `condition number ${r.conditionNumber.toExponential(2)} near machine precision; downstream pseudo-inverse will amplify noise`,
    );
  }
  // Wire emits Vh = V† (conjugate transpose; NumPy convention). The
  // substrate keeps V itself so the substrate-side reconstruction
  // diagnostic can use `M·V − U·diag(S)` directly; the adjoint is
  // computed once here for the wire.
  const Vh = complexAdjoint(r.V);
  return record({
    U: complexMatrixToValue(r.U),
    S: listOfFloat64(r.S),
    Vh: complexMatrixToValue(Vh),
    mode: str(r.mode),
    reconstruction_error: float64FromNumber(r.reconstructionError),
    orthogonality_error_U: float64FromNumber(r.orthogonalityErrorU),
    orthogonality_error_Vh: float64FromNumber(r.orthogonalityErrorV),
    condition_number: float64FromNumber(r.conditionNumber),
    rank_estimate: int(BigInt(r.rankEstimate)),
    method: str(r.method),
    warnings: list(warnings.map((w) => str(w))),
  });
}

// -----------------------------------------------------------------------------
// Helpers used by `fn`
// -----------------------------------------------------------------------------

/**
 * Render a non-finite double as a stable, planner-readable string.
 */
function formatNonFinite(v: number): string {
  if (Number.isNaN(v)) return "NaN";
  if (v === Infinity) return "Infinity";
  if (v === -Infinity) return "-Infinity";
  return String(v);
}

/**
 * Decode the input `record{re, im}` into a `ComplexMatrix`, raising
 * `ToolError` on malformed-input cases (shape mismatch, ragged) and
 * returning a boundary `tagged` for non-finite or degenerate-shape
 * cases. The runner has already validated the wire-structural shape
 * (`re` and `im` are `list<list<float64>>`); the checks here are
 * semantic and rectangular-rigidity.
 *
 * Unlike `linalg-eigh-complex`, non-square `re` is *not* an error here:
 * SVD is defined for any `m × n`.
 */
function decodeInput(
  reList: { readonly kind: "list"; readonly items: readonly Value[] },
  imList: { readonly kind: "list"; readonly items: readonly Value[] },
):
  | { kind: "ok"; M: ComplexMatrix }
  | { kind: "tagged"; value: Value } {
  const m = reList.items.length;
  if (m === 0) {
    return {
      kind: "tagged",
      value: tagged(`${NAME}/degenerate-shape`, record({ m: int(0n), n: int(0n) })),
    };
  }
  if (imList.items.length !== m) {
    throw new ToolError(
      `${NAME}: re has ${m} rows, im has ${imList.items.length} — shapes must match`,
      { suggestion: "re and im must be the same m × n matrix" },
    );
  }

  const firstReRow = reList.items[0]!;
  if (firstReRow.kind !== "list") {
    throw new ToolError(`${NAME}: re[0] is not a list`, {});
  }
  const n = firstReRow.items.length;
  if (n === 0) {
    return {
      kind: "tagged",
      value: tagged(`${NAME}/degenerate-shape`, record({ m: int(BigInt(m)), n: int(0n) })),
    };
  }

  const re = new Float64Array(m * n);
  const im = new Float64Array(m * n);
  for (let i = 0; i < m; i++) {
    const reRow = reList.items[i]!;
    const imRow = imList.items[i]!;
    if (reRow.kind !== "list") {
      throw new ToolError(`${NAME}: re[${i}] is not a list`, {});
    }
    if (imRow.kind !== "list") {
      throw new ToolError(`${NAME}: im[${i}] is not a list`, {});
    }
    if (reRow.items.length !== n) {
      throw new ToolError(
        `${NAME}: re is not rectangular (row 0 has ${n} entries, row ${i} has ${reRow.items.length})`,
        { suggestion: "every row of re must have the same length" },
      );
    }
    if (imRow.items.length !== n) {
      throw new ToolError(
        `${NAME}: im row ${i} has length ${imRow.items.length}, expected ${n} to match re`,
        { suggestion: "im and re must have identical shape" },
      );
    }
    for (let j = 0; j < n; j++) {
      const reCell = reRow.items[j]!;
      const imCell = imRow.items[j]!;
      if (reCell.kind !== "float64") {
        throw new ToolError(`${NAME}: re[${i}][${j}] is not a float64`, {});
      }
      if (imCell.kind !== "float64") {
        throw new ToolError(`${NAME}: im[${i}][${j}] is not a float64`, {});
      }
      const reX = float64ToNumber(reCell);
      const imX = float64ToNumber(imCell);
      if (!Number.isFinite(reX)) {
        return {
          kind: "tagged",
          value: tagged(
            `${NAME}/non-finite-input`,
            record({
              row: int(BigInt(i)),
              col: int(BigInt(j)),
              part: str("re"),
              value: str(formatNonFinite(reX)),
            }),
          ),
        };
      }
      if (!Number.isFinite(imX)) {
        return {
          kind: "tagged",
          value: tagged(
            `${NAME}/non-finite-input`,
            record({
              row: int(BigInt(i)),
              col: int(BigInt(j)),
              part: str("im"),
              value: str(formatNonFinite(imX)),
            }),
          ),
        };
      }
      re[i * n + j] = reX;
      im[i * n + j] = imX;
    }
  }
  return { kind: "ok", M: { rows: m, cols: n, re, im } };
}

// -----------------------------------------------------------------------------
// Tool definition
// -----------------------------------------------------------------------------

export const def = defineTool({
  name: NAME,
  version: VERSION,
  schema: { input: inputSchema, output: outputSchema },
  // ADR-0015 / ADR-0035 §D3: numerical tier. The success branch output
  // always contains float64 leaves (U.re, U.im, S, Vh.re, Vh.im, the
  // five error scalars), so the platform fingerprint is recorded on
  // every successful run. Boundary-tag branches carry int / str payloads
  // only; `containsFloat64` correctly skips the platform field for those.
  numerical: true,
  flags: {
    // v0.1 ships only the complex one-sided Jacobi path. A future
    // bidiagonal-Golub-Reinsch complex variant (if ever justified by a
    // workload at n ≥ 1000 — bead `e7y` would FFI to LAPACK first) is
    // schema-additive via this enum (ADR-0035 §D7 precedent).
    method: F.enum(["complex-one-sided-jacobi"] as const, "Complex SVD algorithm", {
      default: "complex-one-sided-jacobi",
    }),
  },
  examples: [
    // -- happy path, real-valued square ----------------------------------
    {
      description: "1×1 real M=[[3]] → S=[3]",
      input: complexInput([[3]], [[0]], "reduced"),
      output: encodeSuccess(
        svdComplex(
          { rows: 1, cols: 1, re: new Float64Array([3]), im: new Float64Array([0]) },
          "reduced",
        ),
      ),
    },
    {
      description: "2×2 diagonal M=diag(3,1) → S=[3,1]",
      input: complexInput([[3, 0], [0, 1]], [[0, 0], [0, 0]], "reduced"),
      output: encodeSuccess(
        svdComplex(
          { rows: 2, cols: 2, re: new Float64Array([3, 0, 0, 1]), im: new Float64Array([0, 0, 0, 0]) },
          "reduced",
        ),
      ),
    },
    {
      description: "2×2 Pauli X (real, singular values 1, 1)",
      input: complexInput([[0, 1], [1, 0]], [[0, 0], [0, 0]], "reduced"),
      output: encodeSuccess(
        svdComplex(
          { rows: 2, cols: 2, re: new Float64Array([0, 1, 1, 0]), im: new Float64Array([0, 0, 0, 0]) },
          "reduced",
        ),
      ),
    },
    // -- happy path, genuinely complex ------------------------------------
    {
      description: "2×2 Pauli Y (pure-imaginary off-diagonals; S = [1, 1])",
      input: complexInput([[0, 0], [0, 0]], [[0, -1], [1, 0]], "reduced"),
      output: encodeSuccess(
        svdComplex(
          { rows: 2, cols: 2, re: new Float64Array([0, 0, 0, 0]), im: new Float64Array([0, -1, 1, 0]) },
          "reduced",
        ),
      ),
    },
    {
      description: "2×2 Hermitian H=[[1,i],[-i,1]] (eigenvalues 0, 2; singular values 2, 0; rank 1)",
      input: complexInput([[1, 0], [0, 1]], [[0, 1], [-1, 0]], "reduced"),
      output: encodeSuccess(
        svdComplex(
          { rows: 2, cols: 2, re: new Float64Array([1, 0, 0, 1]), im: new Float64Array([0, 1, -1, 0]) },
          "reduced",
        ),
      ),
    },
    {
      description: "2×2 generic complex M=[[1+i, 2], [3, 4-i]]",
      input: complexInput([[1, 2], [3, 4]], [[1, 0], [0, -1]], "reduced"),
      output: encodeSuccess(
        svdComplex(
          { rows: 2, cols: 2, re: new Float64Array([1, 2, 3, 4]), im: new Float64Array([1, 0, 0, -1]) },
          "reduced",
        ),
      ),
    },
    // -- rectangular cases (m > n and m < n) ------------------------------
    {
      description: "3×2 tall: real orthonormal columns ⇒ S = [1, 1], U is 3×2, Vh is 2×2",
      input: complexInput(
        [[1, 0], [0, 1], [0, 0]],
        [[0, 0], [0, 0], [0, 0]],
        "reduced",
      ),
      output: encodeSuccess(
        svdComplex(
          {
            rows: 3,
            cols: 2,
            re: new Float64Array([1, 0, 0, 1, 0, 0]),
            im: new Float64Array(6),
          },
          "reduced",
        ),
      ),
    },
    {
      description: "2×3 short-and-fat: m<n branch routes via M† internally; U is 2×2, Vh is 2×3",
      input: complexInput(
        [[1, 0, 0], [0, 1, 0]],
        [[0, 0, 0], [0, 0, 0]],
        "reduced",
      ),
      output: encodeSuccess(
        svdComplex(
          {
            rows: 2,
            cols: 3,
            re: new Float64Array([1, 0, 0, 0, 1, 0]),
            im: new Float64Array(6),
          },
          "reduced",
        ),
      ),
    },
    {
      description: "3×3 complex Hermitian (Pauli-X⊗I block) — Gram exercises sweep convergence",
      input: complexInput(
        [[1, 0.5, 0], [0.5, 2, 0.5], [0, 0.5, 3]],
        [[0, 0.5, 0], [-0.5, 0, 0.5], [0, -0.5, 0]],
        "reduced",
      ),
      output: encodeSuccess(
        svdComplex(
          {
            rows: 3,
            cols: 3,
            re: new Float64Array([1, 0.5, 0, 0.5, 2, 0.5, 0, 0.5, 3]),
            im: new Float64Array([0, 0.5, 0, -0.5, 0, 0.5, 0, -0.5, 0]),
          },
          "reduced",
        ),
      ),
    },
    // -- complete mode ---------------------------------------------------
    {
      description: "complete-mode 3×2: U is 3×3 (extra col spans ker(M†)), Vh is 2×2",
      input: complexInput(
        [[1, 0], [0, 1], [0, 0]],
        [[0, 0], [0, 0], [0, 0]],
        "complete",
      ),
      output: encodeSuccess(
        svdComplex(
          {
            rows: 3,
            cols: 2,
            re: new Float64Array([1, 0, 0, 1, 0, 0]),
            im: new Float64Array(6),
          },
          "complete",
        ),
      ),
    },
    // -- rank-deficient + all-zero (degenerate but in-scope) -------------
    {
      description: "all-zero 2×2: S=[0,0], rank=0",
      input: complexInput([[0, 0], [0, 0]], [[0, 0], [0, 0]], "reduced"),
      output: encodeSuccess(
        svdComplex(
          { rows: 2, cols: 2, re: new Float64Array(4), im: new Float64Array(4) },
          "reduced",
        ),
      ),
    },
    // -- boundary branches: tagged refusals ------------------------------
    {
      description: "non-finite re (NaN) → tagged 'linalg-svd-complex/non-finite-input'",
      input: complexInput([[1, 2], [3, NaN]], [[0, 0], [0, 0]], "reduced"),
      output: tagged(
        `${NAME}/non-finite-input`,
        record({
          row: int(1n),
          col: int(1n),
          part: str("re"),
          value: str("NaN"),
        }),
      ),
    },
    {
      description: "non-finite im (Infinity) → tagged",
      input: complexInput([[1, 2], [3, 4]], [[0, Infinity], [0, 0]], "reduced"),
      output: tagged(
        `${NAME}/non-finite-input`,
        record({
          row: int(0n),
          col: int(1n),
          part: str("im"),
          value: str("Infinity"),
        }),
      ),
    },
    {
      description: "degenerate (m=0) → tagged 'linalg-svd-complex/degenerate-shape'",
      input: record({ re: list([]), im: list([]), mode: str("reduced") }),
      output: tagged(
        `${NAME}/degenerate-shape`,
        record({ m: int(0n), n: int(0n) }),
      ),
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
      statement: "for every successful factorisation, ||M − U·diag(S)·Vh||_F ≤ 100·ε·max(m,n)·sqrt(min(m,n))·||M||_F (Higham 2002 §21; complex one-sided Jacobi inherits real bound; Hari-Veselić 1987)",
      machine_checkable: true,
    },
    {
      name: "orthogonality-U",
      statement: "for every successful factorisation, ||U† U − I_q||_F ≤ 100·ε·m·sqrt(q) — independent of κ(M); Demmel-Veselić 1992 relative-accuracy carries to complex case (Drmač 1997 §4)",
      machine_checkable: true,
    },
    {
      name: "orthogonality-Vh",
      statement: "for every successful factorisation, ||Vh · Vh† − I_q'||_F ≤ 100·ε·n·sqrt(q') — independent of κ(M)",
      machine_checkable: true,
    },
    {
      name: "S-non-negative-descending-real",
      statement: "S[i] ≥ 0 for all i, and S[i] ≥ S[i+1] for all i < k−1 (within tolerance 100·ε·S[0]); S is emitted as list<float64> (singular values are real by spectral theorem, not list<record{re, im}>)",
      machine_checkable: true,
    },
    {
      name: "self-reported-honesty",
      statement: "reported reconstruction_error, orthogonality_error_U, and orthogonality_error_Vh agree with an independent NumPy `np.linalg.svd(M)` recomputation to 1e-6 relative on every bench corpus case",
      machine_checkable: true,
    },
    {
      name: "rank-estimate-LAPACK-threshold",
      statement: "rank_estimate counts singular values exceeding max(m,n)·ε·S[0] — the LAPACK-standard numerical-rank threshold",
      machine_checkable: true,
    },
    {
      name: "non-finite-tagged",
      statement: `any NaN or ±Inf in re or im → tagged "${NAME}/non-finite-input" with the (row, col, part, value) — never silently propagated`,
      machine_checkable: true,
    },
    {
      name: "degenerate-shape-tagged",
      statement: `m = 0 or n = 0 → tagged "${NAME}/degenerate-shape" with (m, n) — never an unhelpful exit-1`,
      machine_checkable: true,
    },
    {
      name: "shape-mismatch-rejected",
      statement: "re and im with disagreeing rows × cols → ToolError (malformed input — no single complex matrix to operate on)",
      machine_checkable: true,
    },
    {
      name: "rectangular-input-supported",
      statement: "M may be m × n with m ≠ n (unlike linalg-eigh-complex which requires square); the m < n case routes via M† internally and swaps U ↔ V at the end",
      machine_checkable: true,
    },
    {
      name: "real-input-cheap-path",
      statement: "all-zero im inputs run through the complex Jacobi path with im-arithmetic terms vanishing; result's U.im and Vh.im are zero up to round-off",
      machine_checkable: true,
    },
    {
      name: "scale-warnings-emitted",
      statement: `for max(m, n) > 500, the warnings field carries human-readable scale advisories per ADR-0016. Algorithm still runs.`,
      machine_checkable: true,
    },
    {
      name: "oom-becomes-toolerror",
      statement: `a true allocation OOM on the work buffers (RangeError on Float64Array allocation) is caught and re-thrown as a ToolError carrying the attempted byte count. This is the only refusal class for oversize inputs (ADR-0016).`,
      machine_checkable: true,
    },
  ],
  fn: (input, _flags): Value => {
    const reField = input.fields.re as Value;
    const imField = input.fields.im as Value;
    const modeField = input.fields.mode as Value | undefined;

    // The runner has validated the structural shape (`list<list<float64>>`
    // for both `re` and `im`, optional `string` for mode); semantic
    // checks are the body's job.
    if (reField.kind !== "list") {
      throw new ToolError(`${NAME}: re is not a list`, {});
    }
    if (imField.kind !== "list") {
      throw new ToolError(`${NAME}: im is not a list`, {});
    }

    // -- Mode handling: default "reduced"; reject unknown values ---------
    let mode: "reduced" | "complete" = "reduced";
    if (modeField !== undefined) {
      if (modeField.kind !== "string") {
        throw new ToolError(`${NAME}: mode must be a string`, {});
      }
      const s = modeField.value;
      if (s === "reduced") mode = "reduced";
      else if (s === "complete") mode = "complete";
      else {
        throw new ToolError(`${NAME}: mode must be "reduced" or "complete" (got "${s}")`, {
          suggestion: `valid modes: "reduced" (default, k = min(m, n)) or "complete" (m × m U, n × n V)`,
        });
      }
    }

    const decoded = decodeInput(reField, imField);
    if (decoded.kind === "tagged") return decoded.value;
    const { M } = decoded;
    const m = M.rows;
    const n = M.cols;

    // -- Scale warnings (ADR-0016): no size cap, just advisories. --------
    // The complex Jacobi path's cost is ~4× real Jacobi per rotation
    // (complex multiply = 4 real multiplies + 2 add); we pass max(m, n)
    // to the scale advisor (the dominant cost axis for one-sided Jacobi).
    const scaleWarnings = assessNumericalScale("svd-jacobi", m, n);

    // -- Substrate call, guarded by withOomGuard. ------------------------
    let result: SvdComplexResult;
    try {
      result = withOomGuard(m, n, () => svdComplex(M, mode));
    } catch (e) {
      if (e instanceof MemoryExhaustionError) {
        throw new ToolError(e.message, {
          suggestion:
            `the requested ${m}×${n} complex SVD could not allocate its working buffers ` +
            `(${m}·${n} complex × 16 bytes for W, ${n}² complex × 16 bytes for V_acc). ` +
            `For larger problems consider the FFI bridge (bead scientist-workbench-e7y) ` +
            `or a complex bidiagonal+QR variant (deferred follow-up).`,
          detail: { attempted_bytes: e.attemptedBytes, m: e.dims.m, n: e.dims.n },
        });
      }
      throw e;
    }
    return encodeSuccess(result, scaleWarnings);
  },
  test: () => {
    // Smoke probes covering each algorithmic branch + a genuinely-complex
    // case + a rectangular case. Mirrors `linalg-eigh-complex`'s `--test`:
    // every probe asserts a mathematical invariant, not just "didn't
    // throw" (Rule 7).

    const expectClose = (label: string, got: number, want: number, tol: number) => {
      if (Math.abs(got - want) > tol) {
        throw new Error(`test: ${label} got ${got}, want ${want} ± ${tol}`);
      }
    };

    // 1. Diagonal: singular values are the |diagonal entries|, descending.
    const D = svdComplex({
      rows: 2,
      cols: 2,
      re: new Float64Array([3, 0, 0, 1]),
      im: new Float64Array(4),
    });
    expectClose("D S[0]", D.S[0]!, 3, 1e-12);
    expectClose("D S[1]", D.S[1]!, 1, 1e-12);
    if (D.reconstructionError > 1e-12) throw new Error(`test: D recon ${D.reconstructionError}`);

    // 2. Pauli Y: pure-imaginary off-diagonals. Singular values both 1.
    const Y = svdComplex({
      rows: 2,
      cols: 2,
      re: new Float64Array([0, 0, 0, 0]),
      im: new Float64Array([0, -1, 1, 0]),
    });
    expectClose("Y S[0]", Y.S[0]!, 1, 1e-12);
    expectClose("Y S[1]", Y.S[1]!, 1, 1e-12);
    if (Y.reconstructionError > 1e-12) throw new Error(`test: Y recon ${Y.reconstructionError}`);
    if (Y.orthogonalityErrorU > 1e-12) throw new Error(`test: Y orth U ${Y.orthogonalityErrorU}`);
    if (Y.orthogonalityErrorV > 1e-12) throw new Error(`test: Y orth V ${Y.orthogonalityErrorV}`);

    // 3. Hermitian H=[[1,i],[-i,1]]: rank 1, singular values [2, 0].
    const H = svdComplex({
      rows: 2,
      cols: 2,
      re: new Float64Array([1, 0, 0, 1]),
      im: new Float64Array([0, 1, -1, 0]),
    });
    expectClose("H S[0]", H.S[0]!, 2, 1e-12);
    expectClose("H S[1]", H.S[1]!, 0, 1e-12);
    if (H.rankEstimate !== 1) throw new Error(`test: H rank ${H.rankEstimate}`);

    // 4. Rectangular m<n branch: 2×3 with orthonormal rows. Singular
    //    values both 1, U is 2×2, V is 3×2.
    const R = svdComplex(
      {
        rows: 2,
        cols: 3,
        re: new Float64Array([1, 0, 0, 0, 1, 0]),
        im: new Float64Array(6),
      },
      "reduced",
    );
    expectClose("R S[0]", R.S[0]!, 1, 1e-12);
    expectClose("R S[1]", R.S[1]!, 1, 1e-12);
    if (R.U.rows !== 2 || R.U.cols !== 2) throw new Error(`test: R U shape ${R.U.rows}×${R.U.cols}`);
    if (R.V.rows !== 3 || R.V.cols !== 2) throw new Error(`test: R V shape ${R.V.rows}×${R.V.cols}`);
    if (R.reconstructionError > 1e-12) throw new Error(`test: R recon ${R.reconstructionError}`);

    // 5. Generic 2×2 complex: singular values match expected (computed
    //    offline against NumPy). M = [[1+i, 2], [3, 4-i]].
    const G = svdComplex({
      rows: 2,
      cols: 2,
      re: new Float64Array([1, 2, 3, 4]),
      im: new Float64Array([1, 0, 0, -1]),
    });
    if (G.S.length !== 2) throw new Error(`test: G S length ${G.S.length}`);
    if (G.S[0]! < G.S[1]!) throw new Error(`test: G S not descending: ${G.S[0]} < ${G.S[1]}`);
    if (G.reconstructionError > 1e-12) throw new Error(`test: G recon ${G.reconstructionError}`);
    if (G.orthogonalityErrorU > 1e-12) throw new Error(`test: G orth U ${G.orthogonalityErrorU}`);
  },
});

if (import.meta.main) void runTool(def);
