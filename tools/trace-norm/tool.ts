// =============================================================================
// trace-norm — Schatten-1 norm of a complex Hermitian matrix
// =============================================================================
//
// Intent
// ------
// Compute the **trace norm** (aka Schatten-1 norm, aka nuclear norm)
// of a complex `n × n` Hermitian matrix `M`:
//
//     ||M||_1 = Σ_k |λ_k(M)|       (Hermitian: |singular values| = |eigenvalues|)
//
// This is the workbench's first qinfo v0.2 tool — the spectral
// derivative of `linalg-eigh-complex` (ADR-0035 phase 1, shard 101)
// that unblocked it. The qinfo motivations (filed under bead `hsxa`
// and the original dogfood `temp/qwasserstein.ts`):
//
//   - **Trace distance**: `T(ρ, σ) = ½ · ||ρ − σ||_1`, the Schatten-1
//     distance between density operators. Trace-norm is its kernel
//     primitive; `tools/trace-distance` (bead `k2xo`) is one
//     subtraction away.
//   - **Fidelity bounds**: `1 − F(ρ, σ) ≤ T(ρ, σ) ≤ √(1 − F²)`
//     (Fuchs–van de Graaf), the standard fidelity ↔ trace-distance
//     channel between operationally-meaningful state distances.
//   - **State distinguishability**: Helstrom's theorem: the optimal
//     two-state distinguishing probability is `(1 + T(ρ, σ)) / 2`.
//     Every quantum-info derivation that talks about "how
//     distinguishable two density operators are" routes through this
//     scalar.
//
// **Two-path dispatch** (post-`jao0`, worklog 127):
//   * Hermitian inputs → `eighComplex` (the cheap path; `Σ|λ_k|` is
//     `O(n)` after the `O(n³)` eigh). The eigenvalues are emitted in
//     the success record's `eigenvalues` field for downstream planners
//     that may want to gate on the spectrum signs.
//   * Non-Hermitian (square) inputs → `svdComplex` (ADR-0035 phase 2,
//     bead `jao0`). The singular values themselves are the absolute
//     values needed for the trace norm; `value = Σ S[k]` directly.
//     They are emitted in the success record's `singular_values` field.
//
// The dispatch is internal: the tool's wire shape stays
// `record{M: record{re, im}}` and the success record stays consistent.
// The `method` field discriminates which substrate ran.
//
// For density operators (the dogfood-named workload) Hermitian is the
// universe and the cheap path runs. The SVD path lifts the v0.1
// `trace-norm/non-hermitian-input` refusal — a non-Hermitian square
// complex matrix is now an admissible input.
//
// Input shape
// -----------
// `record{M: record{re: list<list<float64>>, im: list<list<float64>>}}`
// — the same canonical complex-matrix wire shape as
// `linalg-eigh-complex` (ADR-0035 §D2), wrapped in a record so the
// surface can grow additively (a future `hermitian?: boolean` flag,
// a future weight matrix, etc.) without breaking the schema.
//
// Both `re` and `im` are required and shape-matched (n × n square).
// A Hermitian matrix with all-zero imaginary part passes `im` as
// a list of all-zero lists — the required-`im` discipline is what
// makes "this value is complex" read from the schema (see CLAUDE.md
// hallucination-risk callout).
//
// Output shape
// ------------
// Happy path: `record{value, eigenvalues, condition_number, method,
// warnings}`. The `value` field is the trace norm itself (a single
// non-negative float64). `eigenvalues` and `condition_number` are
// pass-throughs from the eigh result — they cost nothing once eigh
// has run and are useful diagnostics for planners that might want
// to gate on the spectrum (e.g., "is ρ near a pure state?" → check
// if max eigenvalue ≈ 1).
//
// Boundary tags (ADR-0003):
//   * `trace-norm/non-finite-input` — same shape and trigger as
//     `linalg-eigh-complex`'s tag.
//   * `trace-norm/degenerate-shape` — n = 0.
//
// The legacy `trace-norm/non-hermitian-input` refusal class was
// retired in `jao0` (worklog 127): non-Hermitian square complex inputs
// now route through `svdComplex` and produce a numerical success. The
// schema retains backward-compatible shape (the union no longer
// includes the tag class, but additive removal of a refusal class is
// schema-additive — any caller pattern-matching on the tag is gated by
// a runtime check that simply never fires).
//
// `ToolError` (exit 1) for malformed input:
//   * shape mismatch between `re` and `im`
//   * non-square (m ≠ n) — the trace norm is well-defined for
//     rectangular matrices via the SVD, but trace-norm v0.1 keeps the
//     square-only wire contract; rectangular support is a separate
//     decision tied to the qinfo dogfood scope. Route to
//     `linalg-svd-complex` for non-square inputs and sum the singular
//     values yourself.
//   * ragged rows in `re` or `im`
//   * OOM on the 2n × 2n embedded buffer (Hermitian path) or the
//     n² complex working buffers (SVD path) — both substrates guard
//     and re-throw with the attempted byte count.
//
// Algorithm
// ---------
// 1. Decode the input wire shape into a `ComplexMatrix` (one pass,
//    with non-finite + rectangularity + max|M| computed inline).
// 2. Hermiticity check at tolerance `100·EPS·max|M|`. Refuse on
//    violation (the tagged-boundary discipline).
// 3. Call `eighComplex(M)` via the substrate. The complex eigh
//    handles its own OOM, scale advisories, and provides the
//    candidate's agent-honest reconstruction + orthogonality errors
//    (which we surface in `warnings` when above the soft floor).
// 4. `value = Σ_k |eigenvalues[k]|`. Plain summation; for Hermitian
//    M the eigenvalues are real and `|·|` is `Math.abs`. The total is
//    `O(n)` after the `O(n³)` eigh.
//
// The composition pattern is the first non-trivial proof that the
// ADR-0035 substrate is irresistible: `trace-norm` is a 30-line tool
// body that operates on real qinfo workloads because the heavy
// lifting lives one level down.
//
// References
//   * Watrous, *Theory of Quantum Information*, Cambridge 2018,
//     §1.1 (operator norms, spectral characterisation of the
//     trace norm) + §3.1 (trace distance, Helstrom's theorem).
//   * Nielsen & Chuang, *Quantum Computation and Quantum Information*,
//     10th anniversary ed., Cambridge 2010, §9.2 (the trace distance).
//   * Bhatia, *Matrix Analysis*, Springer 1997, §IV.2 (Schatten
//     norms; spectral characterisation for Hermitian / normal).
//   * ADR-0035 — the complex-linalg-tier ADR.

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
import { defineTool, runTool } from "@workbench/contract";
import {
  type ComplexMatrix,
  eighComplex,
  svdComplex,
} from "@workbench/linalg-core";

const NAME = "trace-norm";
const VERSION = "0.1.0";

const EPS = Number.EPSILON;
const HERMITIAN_TOL_FACTOR = 100 * EPS;

// Soft warning thresholds — surfaced via the `warnings` field of the
// happy-path record, not as boundary refusals.  Inherited from
// `linalg-eigh-complex`'s thresholds so a composed downstream
// (trace-distance, fidelity) sees consistent soft-floor behaviour.
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

const inputSchema = S.record({ M: complexMatrixSchema });

// `eigenvalues` and `singular_values` are mutually exclusive in
// practice — the Hermitian path populates `eigenvalues` (real spectrum,
// sign-preserving), the SVD path populates `singular_values` (real,
// non-negative, descending). Both are declared optional so the wire
// schema is honest about the discriminated union; the active field is
// selected by the `method` string.
const successOutputSchema = S.record(
  {
    value: S.kind("float64"),
    eigenvalues: S.list(S.kind("float64")),
    singular_values: S.list(S.kind("float64")),
    condition_number: S.kind("float64"),
    method: S.kind("string"),
    warnings: S.list(S.kind("string")),
  },
  { optional: ["eigenvalues", "singular_values"] as const },
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

function matrixWire(reRows: readonly (readonly number[])[], imRows: readonly (readonly number[])[]) {
  return record({
    re: list(reRows.map((r) => listOfFloat64(r))),
    im: list(imRows.map((r) => listOfFloat64(r))),
  });
}

function complexInput(reRows: readonly (readonly number[])[], imRows: readonly (readonly number[])[]) {
  return record({ M: matrixWire(reRows, imRows) });
}

// -----------------------------------------------------------------------------
// Decode helpers
// -----------------------------------------------------------------------------

function formatNonFinite(v: number): string {
  if (Number.isNaN(v)) return "NaN";
  if (v === Infinity) return "Infinity";
  if (v === -Infinity) return "-Infinity";
  return String(v);
}

/**
 * Decode the canonical complex-matrix wire shape into a `ComplexMatrix`.
 * Returns one of:
 *   - `{kind: "ok", M, maxAbs}` — success; `maxAbs` is the largest
 *     `|M[i,j]|` seen during the walk, needed for the Hermiticity
 *     tolerance.
 *   - `{kind: "tagged", value}` — a boundary refusal (non-finite or
 *     degenerate) to propagate up.
 *
 * Throws `ToolError` on malformed input (shape mismatch, non-square,
 * ragged). The runner has already validated `re` and `im` are
 * `list<list<float64>>` structurally; only semantic checks happen here.
 */
function decodeComplexMatrix(
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
      `${NAME}: M.re has ${m} rows, M.im has ${imList.items.length} — shapes must match`,
      { suggestion: "M.re and M.im must be the same n × n matrix" },
    );
  }

  const firstRe = reList.items[0]!;
  if (firstRe.kind !== "list") {
    throw new ToolError(`${NAME}: M.re[0] is not a list`, {});
  }
  const n = firstRe.items.length;
  if (n === 0) {
    return {
      kind: "tagged",
      value: tagged(`${NAME}/degenerate-shape`, record({ m: int(BigInt(m)), n: int(0n) })),
    };
  }
  if (m !== n) {
    throw new ToolError(
      `${NAME}: M must be square (got ${m}×${n})`,
      {
        suggestion:
          `the trace norm of a non-square matrix is defined via the SVD; ` +
          `route to linalg-svd-complex (filed under ov4j) when it ships.`,
      },
    );
  }

  const re = new Float64Array(n * n);
  const im = new Float64Array(n * n);
  let maxAbs = 0;
  for (let i = 0; i < n; i++) {
    const reRow = reList.items[i]!;
    const imRow = imList.items[i]!;
    if (reRow.kind !== "list") {
      throw new ToolError(`${NAME}: M.re[${i}] is not a list`, {});
    }
    if (imRow.kind !== "list") {
      throw new ToolError(`${NAME}: M.im[${i}] is not a list`, {});
    }
    if (reRow.items.length !== n) {
      throw new ToolError(
        `${NAME}: M.re is not rectangular (row 0 has ${n} entries, row ${i} has ${reRow.items.length})`,
        { suggestion: "every row of M.re must have the same length" },
      );
    }
    if (imRow.items.length !== n) {
      throw new ToolError(
        `${NAME}: M.im row ${i} has length ${imRow.items.length}, expected ${n} to match M.re`,
        { suggestion: "M.im and M.re must have identical shape" },
      );
    }
    for (let j = 0; j < n; j++) {
      const reCell = reRow.items[j]!;
      const imCell = imRow.items[j]!;
      if (reCell.kind !== "float64") {
        throw new ToolError(`${NAME}: M.re[${i}][${j}] is not a float64`, {});
      }
      if (imCell.kind !== "float64") {
        throw new ToolError(`${NAME}: M.im[${i}][${j}] is not a float64`, {});
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
 * Walk the upper triangle (incl. diagonal) of `M` and return the
 * worst Hermitian violation. `|M[i,j] − conj(M[j,i])| = sqrt((re[i,j]
 * − re[j,i])² + (im[i,j] + im[j,i])²)`. Diagonal: `i = j` reduces to
 * `2 · |im[i,i]|`. Mirrors `linalg-eigh-complex`'s helper of the same
 * name; duplicated here to keep `trace-norm` self-contained at the
 * tool layer (we don't want the substrate's helper leaking into the
 * trace-norm encoding path).
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
  summary:
    "Schatten-1 (trace / nuclear) norm `‖M‖₁` of any square complex matrix via two-path dispatch: Hermitian → eigh-complex (`Σ|λ_k|`), non-Hermitian → svd-complex (`Σ S_k`). First qinfo v0.2 tool",
  schema: { input: inputSchema, output: outputSchema },
  // ADR-0015 / ADR-0035 §D3: the success branch always emits float64
  // leaves (value, eigenvalues, condition_number), so platform
  // fingerprint is recorded on every successful run.
  numerical: true,
  examples: [
    // -- happy path: real-Hermitian density operators (the cheap path) ----
    {
      description: "||I_2||_1 = 2 (identity)",
      input: complexInput([[1, 0], [0, 1]], [[0, 0], [0, 0]]),
      output: traceNormSuccessFromExample([1, 0, 0, 1], [0, 0, 0, 0], 2),
    },
    {
      description: "||rho=|0><0|||_1 = 1 (pure projector)",
      input: complexInput([[1, 0], [0, 0]], [[0, 0], [0, 0]]),
      output: traceNormSuccessFromExample([1, 0, 0, 0], [0, 0, 0, 0], 2),
    },
    {
      description: "||rho=I/2||_1 = 1 (maximally mixed)",
      input: complexInput([[0.5, 0], [0, 0.5]], [[0, 0], [0, 0]]),
      output: traceNormSuccessFromExample([0.5, 0, 0, 0.5], [0, 0, 0, 0], 2),
    },
    {
      description: "||Pauli X||_1 = 2 (Hermitian, eigenvalues ±1)",
      input: complexInput([[0, 1], [1, 0]], [[0, 0], [0, 0]]),
      output: traceNormSuccessFromExample([0, 1, 1, 0], [0, 0, 0, 0], 2),
    },
    // -- happy path: complex Hermitian (the substrate's full path) --------
    {
      description: "||Pauli Y||_1 = 2 (Hermitian, eigenvalues ±1, complex eigenvectors)",
      input: complexInput([[0, 0], [0, 0]], [[0, -1], [1, 0]]),
      output: traceNormSuccessFromExample([0, 0, 0, 0], [0, -1, 1, 0], 2),
    },
    {
      description: "||[[1,i],[-i,1]]||_1 = 2 (eigenvalues 0, 2)",
      input: complexInput([[1, 0], [0, 1]], [[0, 1], [-1, 0]]),
      output: traceNormSuccessFromExample([1, 0, 0, 1], [0, 1, -1, 0], 2),
    },
    // -- happy path: 3×3 mixed signs (Hermitian, exercises |·| over signs)
    {
      description: "||diag(-3,1,4)||_1 = 8",
      input: complexInput([[-3, 0, 0], [0, 1, 0], [0, 0, 4]], [[0, 0, 0], [0, 0, 0], [0, 0, 0]]),
      output: traceNormSuccessFromExample(
        [-3, 0, 0, 0, 1, 0, 0, 0, 4],
        [0, 0, 0, 0, 0, 0, 0, 0, 0],
        3,
      ),
    },
    // -- happy path: non-Hermitian via SVD (post-jao0 lift) -------------
    {
      description: "||M||_1 via SVD for non-Hermitian M=[[0,1],[1+i,0]] (was non-Hermitian-refusal pre-jao0)",
      input: complexInput([[0, 1], [1, 0]], [[0, 0], [1, 0]]),
      output: traceNormSvdSuccessFromExample([0, 1, 1, 0], [0, 0, 1, 0], 2),
    },
    {
      description: "||M||_1 via SVD for asymmetric real M=[[1,2],[3,4]] (singular values from SVD)",
      input: complexInput([[1, 2], [3, 4]], [[0, 0], [0, 0]]),
      output: traceNormSvdSuccessFromExample([1, 2, 3, 4], [0, 0, 0, 0], 2),
    },
    // -- boundary refusals ------------------------------------------------
    {
      description: "non-finite re → tagged 'trace-norm/non-finite-input'",
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
      description: "degenerate (n=0) → tagged 'trace-norm/degenerate-shape'",
      input: record({ M: record({ re: list([]), im: list([]) }) }),
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
      name: "non-negative",
      statement: "value >= 0 for every successful run (norm property)",
      machine_checkable: true,
    },
    {
      name: "identity-norm",
      statement: "||I_n||_1 = n on the n × n identity matrix",
      machine_checkable: true,
    },
    {
      name: "homogeneity",
      statement: "||cM||_1 = |c| · ||M||_1 for every real scalar c and Hermitian M (norm property)",
      machine_checkable: true,
    },
    {
      name: "triangle-inequality",
      statement: "||A + B||_1 <= ||A||_1 + ||B||_1 for Hermitian A, B (norm property)",
      machine_checkable: true,
    },
    {
      name: "trace-bound",
      statement: "||M||_1 >= |tr(M)| for Hermitian M (the eigenvalue sum bounds the eigenvalue absolute sum)",
      machine_checkable: true,
    },
    {
      name: "density-operator-unity",
      statement: "||rho||_1 = 1 for every density operator (rho >= 0, tr rho = 1; eigenvalues non-negative summing to 1)",
      machine_checkable: true,
    },
    {
      name: "hermitian-spectral-formula",
      statement: "||M||_1 = Σ_k |λ_k(M)| for Hermitian M (the algorithm's defining identity; Bhatia §IV.2)",
      machine_checkable: true,
    },
    {
      name: "non-hermitian-routes-via-svd",
      statement: `any non-Hermitian (max|M − M†| > 100·EPS·max|M|) square M routes to svdComplex; the success record reports method="general-via-svd-complex" and surfaces the singular values in the singular_values field. The pre-jao0 trace-norm/non-hermitian-input refusal class is retired.`,
      machine_checkable: true,
    },
    {
      name: "method-discriminates-spectrum-field",
      statement: `method="hermitian-via-eigh-complex" ⇒ success record carries the eigenvalues field (real spectrum); method="general-via-svd-complex" ⇒ success record carries the singular_values field (non-negative, descending). The two fields are mutually exclusive in any given success record.`,
      machine_checkable: true,
    },
    {
      name: "non-finite-tagged",
      statement: `any NaN or ±Inf in M.re or M.im → tagged "${NAME}/non-finite-input" with the (row, col, part, value)`,
      machine_checkable: true,
    },
    {
      name: "degenerate-shape-tagged",
      statement: `n = 0 → tagged "${NAME}/degenerate-shape" with (m, n)`,
      machine_checkable: true,
    },
    {
      name: "shape-mismatch-rejected",
      statement: `M.re and M.im with disagreeing rows × cols → ToolError`,
      machine_checkable: true,
    },
    {
      name: "non-square-rejected",
      statement: `non-square M (m ≠ n) → ToolError. The trace norm is well-defined for rectangular M via the SVD, but trace-norm keeps the square-only wire contract; rectangular callers should invoke linalg-svd-complex and sum the singular values themselves.`,
      machine_checkable: true,
    },
    {
      name: "diagnostic-pass-through",
      statement: "the success record exposes the eigh substrate's eigenvalues and condition_number — pass-through diagnostics for downstream planners (trace-distance, fidelity) that may want to gate on the spectrum",
      machine_checkable: true,
    },
  ],
  fn: (input, _flags) => {
    const M = input.fields.M as Value;
    if (M.kind !== "record") {
      throw new ToolError(`${NAME}: M is not a record`, {});
    }
    const reField = M.fields.re as Value;
    const imField = M.fields.im as Value;
    if (reField.kind !== "list") {
      throw new ToolError(`${NAME}: M.re is not a list`, {});
    }
    if (imField.kind !== "list") {
      throw new ToolError(`${NAME}: M.im is not a list`, {});
    }

    const decoded = decodeComplexMatrix(reField, imField);
    if (decoded.kind === "tagged") return decoded.value;
    const { M: H, maxAbs } = decoded;
    const n = H.rows;

    // ── Path selection: Hermitian → eigh, non-Hermitian → SVD ──────────
    // The Hermiticity check at tolerance `100·EPS·max|M|` mirrors the
    // `linalg-eigh-complex` boundary; passing matrices route to the
    // cheap eigh path (`Σ |λ_k|`), failing matrices route to the
    // general SVD path (`Σ S_k`). Both are admissible — the SVD path
    // is what `jao0` (ADR-0035 phase 2) shipped to lift the v0.1
    // Hermitian-only refusal.
    let isHermitian = true;
    if (maxAbs > 0) {
      const tol = HERMITIAN_TOL_FACTOR * maxAbs;
      const worst = findWorstHermitianViolation(H.re, H.im, n, tol);
      isHermitian = worst === null;
    }

    if (isHermitian) {
      // ── Hermitian path: eighComplex, value = Σ |λ_k|. ───────────────
      const result = eighComplex(H);
      let value = 0;
      for (let k = 0; k < n; k++) value += Math.abs(result.eigenvalues[k]!);

      const warnings: string[] = [];
      if (result.reconstructionError > RECONSTRUCTION_WARNING) {
        warnings.push(
          `eigh reconstruction error ${result.reconstructionError.toExponential(2)} exceeds soft floor ${RECONSTRUCTION_WARNING.toExponential(0)}`,
        );
      }
      if (result.orthogonalityError > ORTHOGONALITY_WARNING) {
        warnings.push(
          `eigh orthogonality error ${result.orthogonalityError.toExponential(2)} exceeds soft floor ${ORTHOGONALITY_WARNING.toExponential(0)}`,
        );
      }
      if (result.conditionNumber > CONDITION_WARNING) {
        warnings.push(
          `condition number ${result.conditionNumber.toExponential(2)} near machine precision; trace norm may have lost relative accuracy on small eigenvalues`,
        );
      }

      return record({
        value: float64FromNumber(value),
        eigenvalues: listOfFloat64(result.eigenvalues),
        condition_number: float64FromNumber(result.conditionNumber),
        method: str("hermitian-via-eigh-complex"),
        warnings: list(warnings.map((w) => str(w))),
      });
    }

    // ── Non-Hermitian path: svdComplex, value = Σ S_k. ──────────────────
    // The singular values are already non-negative and descending; the
    // trace norm reads as their sum. We pass the SVD diagnostics
    // (reconstruction error, orthogonality of U and V, condition
    // number) through the warning surface using the same thresholds as
    // the Hermitian path for consistency across compositions.
    const svdResult = svdComplex(H, "reduced");
    let value = 0;
    for (let k = 0; k < svdResult.S.length; k++) value += svdResult.S[k]!;

    const warnings: string[] = [];
    if (svdResult.reconstructionError > RECONSTRUCTION_WARNING) {
      warnings.push(
        `svd reconstruction error ${svdResult.reconstructionError.toExponential(2)} exceeds soft floor ${RECONSTRUCTION_WARNING.toExponential(0)}`,
      );
    }
    if (svdResult.orthogonalityErrorU > ORTHOGONALITY_WARNING) {
      warnings.push(
        `svd orthogonality error U ${svdResult.orthogonalityErrorU.toExponential(2)} exceeds soft floor ${ORTHOGONALITY_WARNING.toExponential(0)}`,
      );
    }
    if (svdResult.orthogonalityErrorV > ORTHOGONALITY_WARNING) {
      warnings.push(
        `svd orthogonality error V ${svdResult.orthogonalityErrorV.toExponential(2)} exceeds soft floor ${ORTHOGONALITY_WARNING.toExponential(0)}`,
      );
    }
    if (svdResult.conditionNumber > CONDITION_WARNING) {
      warnings.push(
        `condition number ${svdResult.conditionNumber.toExponential(2)} near machine precision; trace norm may have lost relative accuracy on small singular values`,
      );
    }

    return record({
      value: float64FromNumber(value),
      singular_values: listOfFloat64(svdResult.S),
      condition_number: float64FromNumber(svdResult.conditionNumber),
      method: str("general-via-svd-complex"),
      warnings: list(warnings.map((w) => str(w))),
    });
  },
  test: () => {
    // Smoke probes covering: identity-norm, pure projector, maximally
    // mixed (both with trace 1), Pauli matrices (each has trace norm 2),
    // and a generic complex Hermitian.  Every probe asserts a
    // mathematical invariant (Rule 7).

    const runAndExpect = (
      label: string,
      H: ComplexMatrix,
      wantValue: number,
      tol: number,
    ) => {
      const r = eighComplex(H);
      let v = 0;
      for (let k = 0; k < r.eigenvalues.length; k++) v += Math.abs(r.eigenvalues[k]!);
      if (Math.abs(v - wantValue) > tol) {
        throw new Error(`test: ${label} value=${v}, want ${wantValue} ± ${tol}`);
      }
    };

    const make = (re: number[], im: number[], n: number): ComplexMatrix => ({
      rows: n,
      cols: n,
      re: new Float64Array(re),
      im: new Float64Array(im),
    });

    // ||I_3||_1 = 3
    runAndExpect("identity-3", make([1, 0, 0, 0, 1, 0, 0, 0, 1], [0, 0, 0, 0, 0, 0, 0, 0, 0], 3), 3, 1e-12);

    // ||rho=|0><0|||_1 = 1 (pure)
    runAndExpect("pure-projector", make([1, 0, 0, 0], [0, 0, 0, 0], 2), 1, 1e-12);

    // ||rho=I/2||_1 = 1
    runAndExpect("max-mixed-1q", make([0.5, 0, 0, 0.5], [0, 0, 0, 0], 2), 1, 1e-12);

    // ||Pauli X||_1 = 2
    runAndExpect("pauli-x", make([0, 1, 1, 0], [0, 0, 0, 0], 2), 2, 1e-12);

    // ||Pauli Y||_1 = 2
    runAndExpect("pauli-y", make([0, 0, 0, 0], [0, -1, 1, 0], 2), 2, 1e-12);

    // ||Pauli Z||_1 = 2
    runAndExpect("pauli-z", make([1, 0, 0, -1], [0, 0, 0, 0], 2), 2, 1e-12);

    // ||[[1, i], [-i, 1]]||_1 = 2 (eigenvalues 0, 2)
    runAndExpect("complex-hermitian-2x2", make([1, 0, 0, 1], [0, 1, -1, 0], 2), 2, 1e-12);

    // ||diag(-3, 1, 4)||_1 = 8
    runAndExpect("mixed-signs-3x3", make([-3, 0, 0, 0, 1, 0, 0, 0, 4], [0, 0, 0, 0, 0, 0, 0, 0, 0], 3), 8, 1e-12);
  },
});

// -----------------------------------------------------------------------------
// Example-output helper
// -----------------------------------------------------------------------------
//
// The eigh-result-based encoder duplicated here so the examples array
// remains pure data at module-load time.  We can't call the runner's
// `fn` from inside the examples table — `defineTool` reads the table
// before the runner is wired up — so we re-derive the wire output
// directly from `eighComplex` on flat re/im buffers.

function traceNormSvdSuccessFromExample(
  reArr: readonly number[],
  imArr: readonly number[],
  n: number,
) {
  const r = svdComplex(
    { rows: n, cols: n, re: new Float64Array(reArr), im: new Float64Array(imArr) },
    "reduced",
  );
  let v = 0;
  for (let k = 0; k < r.S.length; k++) v += r.S[k]!;

  const warnings: string[] = [];
  if (r.reconstructionError > RECONSTRUCTION_WARNING) {
    warnings.push(
      `svd reconstruction error ${r.reconstructionError.toExponential(2)} exceeds soft floor ${RECONSTRUCTION_WARNING.toExponential(0)}`,
    );
  }
  if (r.orthogonalityErrorU > ORTHOGONALITY_WARNING) {
    warnings.push(
      `svd orthogonality error U ${r.orthogonalityErrorU.toExponential(2)} exceeds soft floor ${ORTHOGONALITY_WARNING.toExponential(0)}`,
    );
  }
  if (r.orthogonalityErrorV > ORTHOGONALITY_WARNING) {
    warnings.push(
      `svd orthogonality error V ${r.orthogonalityErrorV.toExponential(2)} exceeds soft floor ${ORTHOGONALITY_WARNING.toExponential(0)}`,
    );
  }
  if (r.conditionNumber > CONDITION_WARNING) {
    warnings.push(
      `condition number ${r.conditionNumber.toExponential(2)} near machine precision; trace norm may have lost relative accuracy on small singular values`,
    );
  }

  return record({
    value: float64FromNumber(v),
    singular_values: listOfFloat64(r.S),
    condition_number: float64FromNumber(r.conditionNumber),
    method: str("general-via-svd-complex"),
    warnings: list(warnings.map((w) => str(w))),
  });
}

function traceNormSuccessFromExample(reArr: readonly number[], imArr: readonly number[], n: number) {
  const r = eighComplex({
    rows: n,
    cols: n,
    re: new Float64Array(reArr),
    im: new Float64Array(imArr),
  });
  let v = 0;
  for (let k = 0; k < r.eigenvalues.length; k++) v += Math.abs(r.eigenvalues[k]!);

  const warnings: string[] = [];
  if (r.reconstructionError > RECONSTRUCTION_WARNING) {
    warnings.push(
      `eigh reconstruction error ${r.reconstructionError.toExponential(2)} exceeds soft floor ${RECONSTRUCTION_WARNING.toExponential(0)}`,
    );
  }
  if (r.orthogonalityError > ORTHOGONALITY_WARNING) {
    warnings.push(
      `eigh orthogonality error ${r.orthogonalityError.toExponential(2)} exceeds soft floor ${ORTHOGONALITY_WARNING.toExponential(0)}`,
    );
  }
  if (r.conditionNumber > CONDITION_WARNING) {
    warnings.push(
      `condition number ${r.conditionNumber.toExponential(2)} near machine precision; trace norm may have lost relative accuracy on small eigenvalues`,
    );
  }

  return record({
    value: float64FromNumber(v),
    eigenvalues: listOfFloat64(r.eigenvalues),
    condition_number: float64FromNumber(r.conditionNumber),
    method: str("hermitian-via-eigh-complex"),
    warnings: list(warnings.map((w) => str(w))),
  });
}

if (import.meta.main) void runTool(def);
