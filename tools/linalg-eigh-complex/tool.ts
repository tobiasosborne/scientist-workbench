// =============================================================================
// linalg-eigh-complex — Hermitian eigendecomposition of a complex n×n matrix
// =============================================================================
//
// Intent
// ------
// The complex sibling of `linalg-eigh`. Computes
//
//     H = Q · diag(λ) · Q†
//
// for a complex *Hermitian* `n × n` matrix `H = A + iB` (with `Aᵀ = A`
// real-symmetric and `Bᵀ = -B` real-antisymmetric). The result is the
// real-valued spectrum `λ ∈ ℝ^n` (Hermitian eigenvalues are real by
// spectral theorem) and the unitary `Q ∈ ℂ^{n×n}` whose columns are the
// eigenvectors.
//
// Wire wrapper around `eighComplex(H)` from `@workbench/linalg-core`
// (ADR-0035, worklog shard 100). The substrate's algorithm is the
// real-symplectic embedding `H̃ = [[A, -B], [B, A]]`, a 2n × 2n real-
// symmetric matrix whose eigenvalues are the Hermitian eigenvalues of
// `H` each with multiplicity 2; we run the existing real Jacobi eigh
// on `H̃` and lift the eigenvectors back. The full algorithm prose
// lives in `packages/linalg-core/src/eigh-complex.ts`; this file is
// the wire-encoding wrapper.
//
// Input shape
// -----------
// `record{re: list<list<float64>>, im: list<list<float64>>}` — both
// fields **required** (ADR-0035 §D2). `re` and `im` must be rectangular
// with matching shape (the structural assertion that "this value
// represents a single complex matrix"). A Hermitian matrix with known-
// zero imaginary part still passes `im` as an all-zero `list<list>` —
// the required-`im` discipline is what makes "this value is complex"
// read from the schema.
//
// Output shape
// ------------
// Happy path: `record{Q: record{re, im}, eigenvalues: list<float64>,
// reconstruction_error, orthogonality_error, condition_number, method,
// warnings}`.  Hermitian eigenvalues are real, so `eigenvalues` is
// `list<float64>` (not `list<record{re, im}>` of always-zero-imaginary
// values — that would lie about what Hermitian eigh produces).
//
// Boundary tags (ADR-0003):
//   * `linalg-eigh-complex/non-hermitian-input` — the worst Hermitian
//     violation (`|H[i,j] - conj(H[j,i])|`) exceeds `100 · EPS · max|H|`.
//     Payload: `(row, col, violation, max_violation)` so a planner can
//     match and decide whether to Hermitian-symmetrise
//     `H := (H + H†)/2` and retry.
//   * `linalg-eigh-complex/non-finite-input` — NaN / ±Inf in `re` or
//     `im`. Payload: `(row, col, part, value)` for the first non-
//     finite coordinate found, with `part ∈ {re, im}`.
//   * `linalg-eigh-complex/degenerate-shape` — `n = 0`. Payload:
//     `(m, n)`.
//
// `ToolError` (exit 1) for *malformed* input:
//   * shape mismatch between `re` and `im` (different `m × n`)
//   * non-square (`m ≠ n`) — Hermitian eigh undefined; route to
//     `linalg-svd-complex` (filed) when shipped
//   * ragged rows in `re` or `im`
//   * OOM on the 2n × 2n embedded buffer (re-thrown with attempted
//     bytes)
//
// Algorithm
// ---------
// Substrate-side: real-symplectic embedding → existing cyclic-Jacobi
// real `eigh` (Jacobi 1846; Demmel-Veselić 1992; Golub & Van Loan
// §8.4) → eigenvalue dedupe + eigenvector lift + complex Modified
// Gram-Schmidt cleanup for degenerate eigenspaces. Full prose in
// `packages/linalg-core/src/eigh-complex.ts`. The cost is 8× flops
// relative to a hypothetical native-complex Householder + QR (deferred
// to v0.2 follow-up); invisible at qinfo-dogfood scale (n ≤ 256).
//
// References
//   * Goedecker 1999 — real-symplectic embedding in DFT.
//   * Day & Heroux 2001 — backward stability of the embedding.
//   * Higham 2002 §10 + §20.6 — complex matrices, symmetric eigenproblem
//     backward stability (inherited verbatim).
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
  type EighComplexResult,
  eighComplex,
  assessNumericalScale,
  MemoryExhaustionError,
  withOomGuard,
} from "@workbench/linalg-core";

const NAME = "linalg-eigh-complex";
const VERSION = "0.1.0";

const EPS = Number.EPSILON;

// Hermiticity tolerance, parallel to `linalg-eigh`'s SYMMETRY_TOL_FACTOR.
// The threshold `max|H - H†| > 100 · EPS · max|H|` admits any input that
// would round-trip through `(H + H†)/2` without measurable change while
// rejecting genuine non-Hermitian inputs.
const HERMITIAN_TOL_FACTOR = 100 * EPS;

// Soft warning thresholds — fields of the output record, not boundary
// refusals (ADR-0014 pattern).
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

const inputSchema = complexMatrixSchema;

const successOutputSchema = S.record({
  Q: complexMatrixSchema,
  eigenvalues: S.list(S.kind("float64")),
  reconstruction_error: S.kind("float64"),
  orthogonality_error: S.kind("float64"),
  condition_number: S.kind("float64"),
  method: S.kind("string"),
  warnings: S.list(S.kind("string")),
});

const nonHermitianOutputSchema = S.tagged(
  `${NAME}/non-hermitian-input`,
  S.record({
    row: S.kind("integer"),
    col: S.kind("integer"),
    violation: S.kind("string"),
    max_violation: S.kind("string"),
  }),
);

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
  nonHermitianOutputSchema,
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

/**
 * Encode a `rows × cols` Float64Array as `list<list<float64>>` row by row.
 */
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

function complexInput(reRows: readonly (readonly number[])[], imRows: readonly (readonly number[])[]) {
  return record({
    re: list(reRows.map((row) => listOfFloat64(row))),
    im: list(imRows.map((row) => listOfFloat64(row))),
  });
}

function encodeSuccess(r: EighComplexResult, scaleWarnings: readonly string[] = []) {
  const warnings: string[] = [...scaleWarnings];
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
  if (r.conditionNumber > CONDITION_WARNING) {
    warnings.push(
      `condition number ${r.conditionNumber.toExponential(2)} near machine precision; downstream H⁻¹ will amplify noise`,
    );
  }
  return record({
    Q: complexMatrixToValue(r.Q),
    eigenvalues: listOfFloat64(r.eigenvalues),
    reconstruction_error: float64FromNumber(r.reconstructionError),
    orthogonality_error: float64FromNumber(r.orthogonalityError),
    condition_number: float64FromNumber(r.conditionNumber),
    method: str("real-symplectic-embedding"),
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
 * `ToolError` on malformed-input cases (shape mismatch, non-square,
 * ragged) and returning a boundary `tagged` for non-finite or
 * degenerate-shape cases. The runner has already validated the wire-
 * structural shape (`re` and `im` are `list<list<float64>>`); the
 * checks here are semantic.
 */
function decodeInput(
  reList: { readonly kind: "list"; readonly items: readonly Value[] },
  imList: { readonly kind: "list"; readonly items: readonly Value[] },
):
  | { kind: "ok"; M: ComplexMatrix; maxAbs: number }
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
  if (m !== n) {
    throw new ToolError(
      `${NAME}: H must be square (got ${m}×${n})`,
      {
        suggestion:
          `for a non-square complex matrix, use linalg-svd-complex (filed) when shipped`,
      },
    );
  }

  // Walk both halves in one pass: rectangularity + non-finite detection +
  // decode into flat Float64Array buffers + track max|H|.
  const re = new Float64Array(n * n);
  const im = new Float64Array(n * n);
  let maxAbs = 0;
  for (let i = 0; i < n; i++) {
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
      const mag = Math.hypot(reX, imX);
      if (mag > maxAbs) maxAbs = mag;
      re[i * n + j] = reX;
      im[i * n + j] = imX;
    }
  }
  return { kind: "ok", M: { rows: n, cols: n, re, im }, maxAbs };
}

/**
 * Locate the worst Hermitian violation of `H = re + i · im`:
 *
 *   |H[i,j] − conj(H[j,i])|  =  sqrt((re[i,j] − re[j,i])² + (im[i,j] + im[j,i])²)
 *
 * (For the diagonal `i = j`, the formula reduces to `2|im[i,i]|`.)
 *
 * Returns the worst (row, col, magnitude) for the boundary payload, or
 * `null` when every pair lies below the tolerance.
 */
function findWorstHermitianViolation(
  re: Float64Array,
  im: Float64Array,
  n: number,
  tol: number,
): { row: number; col: number; violation: number } | null {
  let worst = 0;
  let worstI = -1;
  let worstJ = -1;
  for (let i = 0; i < n; i++) {
    for (let j = i; j < n; j++) {
      const dRe = re[i * n + j]! - re[j * n + i]!;
      const dIm = im[i * n + j]! + im[j * n + i]!;
      const v = Math.hypot(dRe, dIm);
      if (v > worst) {
        worst = v;
        worstI = i;
        worstJ = j;
      }
    }
  }
  return worst > tol ? { row: worstI, col: worstJ, violation: worst } : null;
}

// -----------------------------------------------------------------------------
// Tool definition
// -----------------------------------------------------------------------------

export const def = defineTool({
  name: NAME,
  version: VERSION,
  schema: { input: inputSchema, output: outputSchema },
  // ADR-0015 / ADR-0035 §D3: numerical tier. The success branch output
  // always contains float64 leaves (Q.re, Q.im, eigenvalues, the three
  // error scalars), so the platform fingerprint is recorded on every
  // successful run. Boundary-tag branches carry int / str payloads only;
  // `containsFloat64` correctly skips the platform field for those.
  numerical: true,
  flags: {
    // The `--method` flag is declared `F.enum(["real-symplectic-embedding"])`
    // for symmetry with `linalg-eigh`'s `--method=jacobi`. v0.1 ships
    // only the embedding algorithm; adding `"complex-jacobi"` later
    // is schema-additive (ADR-0035 §D7).
    method: F.enum(["real-symplectic-embedding"] as const, "Complex Hermitian eigh algorithm", {
      default: "real-symplectic-embedding",
    }),
  },
  examples: [
    // -- happy path, real-valued (the cheap fallback path through the
    //    embedding: all-zero im means H̃ is block-diagonal and the
    //    real eigh runs directly on A) -------------------------------------
    {
      description: "1×1 real Hermitian: H=[[3]] → λ=[3]",
      input: complexInput([[3]], [[0]]),
      output: encodeSuccess(
        eighComplex({ rows: 1, cols: 1, re: new Float64Array([3]), im: new Float64Array([0]) }),
      ),
    },
    {
      description: "2×2 identity (real): λ=[1,1]",
      input: complexInput([[1, 0], [0, 1]], [[0, 0], [0, 0]]),
      output: encodeSuccess(
        eighComplex({
          rows: 2,
          cols: 2,
          re: new Float64Array([1, 0, 0, 1]),
          im: new Float64Array([0, 0, 0, 0]),
        }),
      ),
    },
    {
      description: "2×2 Pauli X (real, eigenvalues ±1)",
      input: complexInput([[0, 1], [1, 0]], [[0, 0], [0, 0]]),
      output: encodeSuccess(
        eighComplex({
          rows: 2,
          cols: 2,
          re: new Float64Array([0, 1, 1, 0]),
          im: new Float64Array([0, 0, 0, 0]),
        }),
      ),
    },
    {
      description: "2×2 Pauli Z (real, eigenvalues ±1)",
      input: complexInput([[1, 0], [0, -1]], [[0, 0], [0, 0]]),
      output: encodeSuccess(
        eighComplex({
          rows: 2,
          cols: 2,
          re: new Float64Array([1, 0, 0, -1]),
          im: new Float64Array([0, 0, 0, 0]),
        }),
      ),
    },
    // -- happy path, genuinely complex (the embedding does real work) ----
    {
      description: "2×2 Pauli Y: pure imaginary off-diagonals; eigenvalues ±1; eigenvectors carry phase",
      input: complexInput([[0, 0], [0, 0]], [[0, -1], [1, 0]]),
      output: encodeSuccess(
        eighComplex({
          rows: 2,
          cols: 2,
          re: new Float64Array([0, 0, 0, 0]),
          im: new Float64Array([0, -1, 1, 0]),
        }),
      ),
    },
    {
      description: "2×2 complex Hermitian H=[[1, i],[-i, 1]]: eigenvalues 0, 2",
      input: complexInput([[1, 0], [0, 1]], [[0, 1], [-1, 0]]),
      output: encodeSuccess(
        eighComplex({
          rows: 2,
          cols: 2,
          re: new Float64Array([1, 0, 0, 1]),
          im: new Float64Array([0, 1, -1, 0]),
        }),
      ),
    },
    {
      description: "3×3 real-symmetric diagonal: diag(3,1,4) → λ ascending = [1,3,4]",
      input: complexInput(
        [[3, 0, 0], [0, 1, 0], [0, 0, 4]],
        [[0, 0, 0], [0, 0, 0], [0, 0, 0]],
      ),
      output: encodeSuccess(
        eighComplex({
          rows: 3,
          cols: 3,
          re: new Float64Array([3, 0, 0, 0, 1, 0, 0, 0, 4]),
          im: new Float64Array(9),
        }),
      ),
    },
    {
      description: "all-zero 2×2: λ=[0,0], Q unitary (real-valued in this case)",
      input: complexInput([[0, 0], [0, 0]], [[0, 0], [0, 0]]),
      output: encodeSuccess(
        eighComplex({
          rows: 2,
          cols: 2,
          re: new Float64Array(4),
          im: new Float64Array(4),
        }),
      ),
    },
    // -- boundary branches: tagged refusals ------------------------------
    {
      description: "non-Hermitian (im not antisymmetric) → tagged 'linalg-eigh-complex/non-hermitian-input'",
      input: complexInput([[0, 1], [1, 0]], [[0, 1], [1, 0]]),
      output: tagged(
        `${NAME}/non-hermitian-input`,
        record({
          row: int(0n),
          col: int(1n),
          violation: str("2"),
          max_violation: str("2"),
        }),
      ),
    },
    {
      description: "non-Hermitian (nonzero diagonal imaginary) → tagged",
      input: complexInput([[1, 0], [0, 0]], [[1, 0], [0, 0]]),
      output: tagged(
        `${NAME}/non-hermitian-input`,
        record({
          row: int(0n),
          col: int(0n),
          violation: str("2"),
          max_violation: str("2"),
        }),
      ),
    },
    {
      description: "non-finite re → tagged 'linalg-eigh-complex/non-finite-input'",
      input: complexInput([[1, 2], [2, NaN]], [[0, 0], [0, 0]]),
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
      description: "non-finite im → tagged",
      input: complexInput([[1, 2], [2, 1]], [[0, Infinity], [-Infinity, 0]]),
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
      description: "degenerate (n=0) → tagged 'linalg-eigh-complex/degenerate-shape'",
      input: record({ re: list([]), im: list([]) }),
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
      statement: "for every successful factorisation, ||H·Q − Q·diag(λ)||_F ≤ 100·ε·n·sqrt(n)·||H||_F (Higham 2002 §20.6 inherited via the real-symplectic embedding)",
      machine_checkable: true,
    },
    {
      name: "unitarity",
      statement: "for every successful factorisation, ||Q† Q − I_n||_F ≤ 100·ε·n·sqrt(n) (independent of κ(H); complex MGS guarantees this even on degenerate eigenspaces)",
      machine_checkable: true,
    },
    {
      name: "eigenvalues-real",
      statement: "every eigenvalue is real — Hermitian spectral theorem (the substrate emits as Float64Array; the wire emits as list<float64>, not list<record{re, im}>)",
      machine_checkable: true,
    },
    {
      name: "eigenvalues-ascending",
      statement: "λ[i] ≤ λ[i+1] for all i < n−1 (within tolerance 100·ε·max(|λ_max|, 1)) — numpy / LAPACK convention inherited from the embedded real eigh",
      machine_checkable: true,
    },
    {
      name: "self-reported-honesty",
      statement: "reported reconstruction_error and orthogonality_error agree with an independent NumPy `np.linalg.eigh(H)` recomputation to 1e-6 relative on every bench corpus case",
      machine_checkable: true,
    },
    {
      name: "non-hermitian-tagged",
      statement: `any H with max|H − H†| > 100·EPS·max|H| → tagged "${NAME}/non-hermitian-input" with the offending coordinate and violation magnitude — never silently Hermitian-symmetrised`,
      machine_checkable: true,
    },
    {
      name: "non-finite-tagged",
      statement: `any NaN or ±Inf in re or im → tagged "${NAME}/non-finite-input" with the (row, col, part, value) — never silently propagated`,
      machine_checkable: true,
    },
    {
      name: "degenerate-shape-tagged",
      statement: `n = 0 → tagged "${NAME}/degenerate-shape" with (m, n) — never an unhelpful exit-1`,
      machine_checkable: true,
    },
    {
      name: "shape-mismatch-rejected",
      statement: `re and im with disagreeing rows × cols → ToolError (malformed input — no single complex matrix to operate on)`,
      machine_checkable: true,
    },
    {
      name: "non-square-rejected",
      statement: "non-square re (m ≠ n) raises ToolError with a suggestion to use linalg-svd-complex when shipped",
      machine_checkable: true,
    },
    {
      name: "real-input-cheap-path",
      statement: "all-zero im inputs decompose via the embedding's natural block-diagonal structure: H̃ = blockdiag(A, A) and real eigh sees A twice — equivalent to running real eigh on A directly",
      machine_checkable: true,
    },
    {
      name: "scale-warnings-emitted",
      statement: `for n > 500, the warnings field carries human-readable scale advisories per ADR-0016. Algorithm still runs.`,
      machine_checkable: true,
    },
    {
      name: "oom-becomes-toolerror",
      statement: `a true allocation OOM on the 2n × 2n embedded buffer (RangeError on Float64Array allocation) is caught and re-thrown as a ToolError carrying the attempted byte count. This is the only refusal class for oversize inputs (ADR-0016).`,
      machine_checkable: true,
    },
  ],
  fn: (input, _flags): Value => {
    const reField = input.fields.re as Value;
    const imField = input.fields.im as Value;

    // The runner has validated the structural shape (`list<list<float64>>`
    // for both `re` and `im`); semantic checks are the body's job.
    if (reField.kind !== "list") {
      throw new ToolError(`${NAME}: re is not a list`, {});
    }
    if (imField.kind !== "list") {
      throw new ToolError(`${NAME}: im is not a list`, {});
    }

    const decoded = decodeInput(reField, imField);
    if (decoded.kind === "tagged") return decoded.value;
    const { M, maxAbs } = decoded;
    const n = M.rows;

    // -- Hermiticity check (post-decode, pre-substrate) ----------------------
    if (maxAbs > 0) {
      const tol = HERMITIAN_TOL_FACTOR * maxAbs;
      const worst = findWorstHermitianViolation(M.re, M.im, n, tol);
      if (worst !== null) {
        return tagged(
          `${NAME}/non-hermitian-input`,
          record({
            row: int(BigInt(worst.row)),
            col: int(BigInt(worst.col)),
            violation: str(String(worst.violation)),
            max_violation: str(String(worst.violation)),
          }),
        );
      }
    }

    // -- Scale warnings (ADR-0016): no size cap, just advisories. ------------
    // The embedded real eigh runs on a 2n × 2n matrix, so we pass 2n to
    // the scale advisor — that's what determines the wall-clock and
    // memory cost honestly.
    const scaleWarnings = assessNumericalScale("eigh", 2 * n, 2 * n);

    // -- Substrate call, guarded by withOomGuard. ----------------------------
    let result: EighComplexResult;
    try {
      result = withOomGuard(2 * n, 2 * n, () => eighComplex(M));
    } catch (e) {
      if (e instanceof MemoryExhaustionError) {
        throw new ToolError(e.message, {
          suggestion:
            `the requested ${n}×${n} complex problem embeds to a ${2 * n}×${2 * n} ` +
            `real-symmetric matrix that could not be allocated. ` +
            `For larger problems consider the FFI bridge (bead scientist-workbench-e7y) ` +
            `or wait for the native complex-Jacobi path (ADR-0035 §D5 v0.2 follow-up).`,
          detail: { attempted_bytes: e.attemptedBytes, m: e.dims.m, n: e.dims.n },
        });
      }
      throw e;
    }
    return encodeSuccess(result, scaleWarnings);
  },
  test: () => {
    // Smoke probes covering the canonical Hermitian fixtures + a
    // genuinely-complex Hermitian + the real-density-operator cheap
    // path. Mirrors `linalg-eigh`'s `--test`: every probe asserts a
    // mathematical invariant, not just "didn't throw" (Rule 7).

    const expectClose = (label: string, got: number, want: number, tol: number) => {
      if (Math.abs(got - want) > tol) {
        throw new Error(`test: ${label} got ${got}, want ${want} ± ${tol}`);
      }
    };

    // 1. Pauli Y: real-symplectic embedding's exemplar. Hermitian via
    //    antisymmetric im; eigenvalues are ±1 exactly.
    const Y = eighComplex({
      rows: 2,
      cols: 2,
      re: new Float64Array([0, 0, 0, 0]),
      im: new Float64Array([0, -1, 1, 0]),
    });
    if (Y.eigenvalues.length !== 2) throw new Error(`test: Y eigenvalues length ${Y.eigenvalues.length}`);
    expectClose("Y λ[0]", Y.eigenvalues[0]!, -1, 1e-12);
    expectClose("Y λ[1]", Y.eigenvalues[1]!, 1, 1e-12);
    if (Y.reconstructionError > 1e-12) throw new Error(`test: Y recon ${Y.reconstructionError}`);
    if (Y.orthogonalityError > 1e-12) throw new Error(`test: Y orth ${Y.orthogonalityError}`);

    // 2. Pauli Z: real input through the complex path. Should give
    //    eigenvalues ±1 and a real Q.
    const Z = eighComplex({
      rows: 2,
      cols: 2,
      re: new Float64Array([1, 0, 0, -1]),
      im: new Float64Array(4),
    });
    expectClose("Z λ[0]", Z.eigenvalues[0]!, -1, 1e-12);
    expectClose("Z λ[1]", Z.eigenvalues[1]!, 1, 1e-12);
    if (Z.reconstructionError > 1e-12) throw new Error(`test: Z recon ${Z.reconstructionError}`);

    // 3. Hermitian H = [[1, i], [-i, 1]]: eigenvalues 0, 2.
    const H = eighComplex({
      rows: 2,
      cols: 2,
      re: new Float64Array([1, 0, 0, 1]),
      im: new Float64Array([0, 1, -1, 0]),
    });
    expectClose("H λ[0]", H.eigenvalues[0]!, 0, 1e-12);
    expectClose("H λ[1]", H.eigenvalues[1]!, 2, 1e-12);
    if (H.reconstructionError > 1e-12) throw new Error(`test: H recon ${H.reconstructionError}`);
    if (H.orthogonalityError > 1e-12) throw new Error(`test: H orth ${H.orthogonalityError}`);

    // 4. 4×4 random Hermitian. Cross-check that eigenvalues are ascending.
    //    Construct as M + M† for a random M; the result is automatically
    //    Hermitian.
    const seed = 137;
    const random = (i: number) => {
      // Tiny LCG, deterministic; gives a reproducible Hermitian to test
      // against eigenvalue-ordering invariant.
      let x = (seed * (i + 1)) % 1000;
      return ((x / 1000) * 2 - 1);
    };
    const reM = new Float64Array(16);
    const imM = new Float64Array(16);
    for (let k = 0; k < 16; k++) {
      reM[k] = random(k);
      imM[k] = random(k + 100);
    }
    // Symmetrise: re ← (re + reᵀ)/2, im ← (im - imᵀ)/2 to get Hermitian.
    const reH = new Float64Array(16);
    const imH = new Float64Array(16);
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 4; j++) {
        reH[i * 4 + j] = (reM[i * 4 + j]! + reM[j * 4 + i]!) / 2;
        imH[i * 4 + j] = (imM[i * 4 + j]! - imM[j * 4 + i]!) / 2;
      }
    }
    const R = eighComplex({ rows: 4, cols: 4, re: reH, im: imH });
    if (R.eigenvalues.length !== 4) throw new Error(`test: 4×4 eigenvalues length ${R.eigenvalues.length}`);
    for (let i = 0; i + 1 < 4; i++) {
      if (R.eigenvalues[i]! > R.eigenvalues[i + 1]! + 1e-12) {
        throw new Error(`test: 4×4 eigenvalues not ascending at i=${i}: ${R.eigenvalues[i]} > ${R.eigenvalues[i + 1]}`);
      }
    }
    if (R.reconstructionError > 1e-12) {
      throw new Error(`test: 4×4 recon ${R.reconstructionError} > 1e-12`);
    }
    if (R.orthogonalityError > 1e-12) {
      throw new Error(`test: 4×4 orth ${R.orthogonalityError} > 1e-12`);
    }
  },
});

if (import.meta.main) void runTool(def);
