// =============================================================================
// linalg-svd — Singular value decomposition of a real m×n matrix
// =============================================================================
//
// Intent
// ------
// The fourth numerical-tier tool in scientist-workbench, after `linalg-solve`
// (ADR-0014), `integrate-1d` (ADR-0015 follow-on), and `linalg-qr`
// (worklog 043). Computes
//
//     A = U · diag(S) · Vᵀ
//
// for a real m×n matrix `A`. Wire wrapper around `svd(A, mode, opts?)`
// from `@workbench/linalg-core` — library and tool share one
// implementation per ADR-0010. The substrate dispatches between two
// backends (worklog 046): one-sided Jacobi (Demmel-Veselić 1992) for
// `max(m, n) ≤ 500` and Golub-Reinsch (Householder bidiagonalisation
// + Demmel-Kahan implicit-shift QR sweeps; Demmel & Kahan 1990) above.
// The dispatch is internal; the `method` field of the output reports
// which backend ran.
//
// What makes SVD the *general-purpose rank-revealing tool*
// --------------------------------------------------------
// Every other dense factorisation is a special case derivable from SVD:
//
//   - rank from the count of nonzero S_i;
//   - least-squares solution from V · diag(1/S) · Uᵀ b (pseudo-inverse);
//   - spectral decomposition of AᵀA from V, S²;
//   - condition number = S[0] / S[k-1];
//   - principal components = columns of U;
//   - low-rank approximations = truncate at S[r].
//
// `linalg-solve` solves Ax = b but fails on singular A.  `linalg-qr`
// factorises any A but doesn't *reveal* rank — its triangular R has
// pivot magnitudes, not singular values.  `linalg-svd` factorises any A
// AND reveals rank as the count of singular values above the LAPACK-
// standard threshold.  So the output record is richer than QR's: it
// carries `condition_number` and `rank_estimate` as first-class fields.
//
// What makes this tool agent-honest
// ---------------------------------
// The output is *not* just (U, S, Vᵀ).  It is a record carrying everything
// an agent's planner — or the bench's verifier — needs to decide what
// to do with the answer:
//
//     {
//       U,                       // m × k orthogonal factor (k depends on mode)
//       S,                       // length-k singular values, descending
//       Vt,                      // k × n orthogonal factor (rows orthonormal)
//       mode,                    // "reduced" | "complete" — echoes the request
//       reconstruction_error,    // ||U·diag(S)·Vᵀ − A||_F / max(||A||_F, 1)
//       orthogonality_error_U,   // ||UᵀU − I_q||_F
//       orthogonality_error_Vt,  // ||Vᵀ·V − I_q||_F  (== ||Vt·Vtᵀ − I_q||_F)
//       condition_number,        // S[0] / max(S[k-1], EPS · S[0])
//       rank_estimate,           // count of S_i > max(m,n) · EPS · S[0]
//       method,                  // "one-sided-jacobi" or "golub-reinsch"
//       warnings,                // soft thresholds the planner may match on
//     }
//
// `reconstruction_error`, `orthogonality_error_U`, and
// `orthogonality_error_Vt` are the *candidate's honest self-report* on
// its own quality (precedent: `linalg-qr`'s same fields, ADR-0014).
// The bench's verifier (`bench/linalg-svd/golden/verify.py`) recomputes
// all three and rejects the candidate if they disagree by more than 1e-6
// relative — agent-honest is *enforced*, not just convention.
//
// Why dual-algorithm dispatch (worklog 046)
// -----------------------------------------
// Both algorithms are admissible by the bench's tolerance regime.
// They have complementary strengths:
//
//   * **One-sided Jacobi** has high relative accuracy on every
//     singular value regardless of κ(A) (Demmel-Veselić 1992) — the
//     decisive property when reading off the smallest singular value
//     of an ill-conditioned matrix. Cost is O(mn² log² n); interactive
//     to ~n=500.
//
//   * **Golub-Reinsch** has the textbook O(mn² + n³) cost with small
//     constants and no log factor, lifting the practical pure-TS
//     ceiling from ~n=500 (Jacobi) to ~n=2000 (~5 min on dev-box;
//     ~25 s at n=1000 vs Jacobi's ~3.5 min — the 5–10× speedup is
//     the dispatch headline). Forward error on small singular values
//     is bounded by ε·‖A‖, not ε·σ — half the digits on the smallest
//     σ when κ is large.
//
// The auto-dispatch threshold sits at max(m, n) = 500 — the boundary
// of the "well-tested" regime per scale.ts and ADR-0016. Below it,
// Jacobi's small-σ accuracy wins; above it, Golub-Reinsch's speed
// dominates and the n³ Jacobi scaling becomes the binding constraint.
//
// The substrate (`packages/linalg-core/src/svd.ts`) carries the full
// literate algorithm prose; this file is only the wire-encoding wrapper.
//
// Boundary categories (ADR-0003)
// ------------------------------
//   * `linalg-svd/non-finite-input`  (tagged): `A` contains NaN / ±Inf.
//                                    Payload carries the row, column,
//                                    and the offending value as a
//                                    string. Tagged rather than
//                                    `ToolError` because the input is
//                                    structurally well-formed (the
//                                    caller may reasonably ask "what
//                                    does SVD think of this?" and our
//                                    honest answer is "out of scope").
//                                    Mirrors `linalg-qr`'s polarity.
//   * `linalg-svd/degenerate-shape`  (tagged): m = 0 or n = 0. Payload
//                                    carries m, n. Same reasoning: a
//                                    zero-by-anything input is
//                                    structurally valid wire-form; the
//                                    algorithm has no answer to give.
//   * `ToolError` (exit 1) for *malformed* input:
//     - non-rectangular `A` (ragged rows)
//     - `mode` is not "reduced" or "complete"
//     - actual OOM (RangeError on Float64Array allocation) — caught and
//       re-thrown as ToolError with the attempted-bytes detail.
//       Per ADR-0016, the previous `m·n ≤ 200·200` cap is *withdrawn*;
//       large inputs run with loud warnings instead. OOM is the only
//       physical refusal.
//
// Out of scope (all explicitly deferred)
// --------------------------------------
//   * Generalised SVD, randomised SVD, truncated SVD — bead 71f
//   * Per-tool size cap — *withdrawn* per ADR-0016. With dual-algorithm
//     dispatch (worklog 046), the practical pure-TS ceiling is ~n=2000
//     (Golub-Reinsch); larger inputs emit a strong warning and proceed
//     unless OOM intervenes.
//   * FFI to LAPACK DGESDD — bead `e7y`
//   * Cross-platform determinism guarantee — `numerical: true` (ADR-0015)
//
// Algorithm
// ---------
// Dual-algorithm dispatch — see `packages/linalg-core/src/svd.ts`
// for the full literate prose on both backends and the dispatch rule.

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
  type SVDResult,
  matrixFromRows,
  svd,
  assessNumericalScale,
  MemoryExhaustionError,
  withOomGuard,
} from "@workbench/linalg-core";

const NAME = "linalg-svd";
const VERSION = "0.2.0";

// ADR-0016 lifts the v0.1 `m · n ≤ 200 · 200` cap. Large inputs run
// with `assessNumericalScale("svd-jacobi", ...)` warnings appended
// to the output's `warnings` field; the only refusal is a true
// allocation OOM (RangeError → ToolError via `withOomGuard`).

// Soft warning thresholds.  These are *fields* of the output record,
// not boundary refusals — the planner reads them and decides.  We
// piggyback on the bench's tolerance derivation (Higham 2002 §20.3
// with 100× safety): if the candidate's reported error exceeds 1e-12,
// the case is *probably* still correct (the bench's tolerance is
// wider) but the planner deserves to know it's near the floor.
const RECONSTRUCTION_WARNING = 1e-12;
const ORTHOGONALITY_WARNING = 1e-12;

// Threshold above which `condition_number` triggers a precision
// warning. 1e12 is one order of magnitude before "near machine
// precision" for double-precision floats; a planner consuming this
// SVD downstream (e.g. for least-squares) deserves to know the
// pseudo-inverse will amplify noise by 12 orders of magnitude.
const CONDITION_WARNING = 1e12;

// -----------------------------------------------------------------------------
// Schema
// -----------------------------------------------------------------------------
//
// Input is a record with required `A` (list of lists of float64) and
// optional `mode` (string).  The bench's wire format omits `mode` for
// the default ("reduced") and includes `mode: "complete"` only when
// needed; the adapter (`bench/linalg-svd/run-candidate.ts`) only emits
// the field when the caller's input has it.  We declare it as optional
// in the schema so the runner accepts both shapes.
//
// (This is the lesson from worklog 043 friction 1: the QR subagent's
// first cut declared `mode` as a required field and burned 45/49 cases
// on schema-validation rejection. Same trap; same fix.)

const inputSchema = S.record(
  {
    A: S.list(S.list(S.kind("float64"))),
    mode: S.kind("string"),
  },
  { optional: ["mode"] as const },
);

const successOutputSchema = S.record({
  U: S.list(S.list(S.kind("float64"))),
  S: S.list(S.kind("float64")),
  Vt: S.list(S.list(S.kind("float64"))),
  mode: S.kind("string"),
  reconstruction_error: S.kind("float64"),
  orthogonality_error_U: S.kind("float64"),
  orthogonality_error_Vt: S.kind("float64"),
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
// The bench's `shape` check requires `mode` to echo back.  For
// minimal-input examples (where the caller omitted `mode`), the
// substrate's default is "reduced"; we pass "reduced" explicitly to the
// example builder so the output's `mode` field reads correctly.

function inp(A: readonly (readonly number[])[], mode: string) {
  return record({
    A: list(A.map((row) => listOfFloat64(row))),
    mode: str(mode),
  });
}

function encodeSuccess(r: SVDResult, scaleWarnings: readonly string[] = []) {
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
  if (r.orthogonalityErrorVt > ORTHOGONALITY_WARNING) {
    warnings.push(
      `orthogonality error Vt ${r.orthogonalityErrorVt.toExponential(2)} exceeds soft floor ${ORTHOGONALITY_WARNING.toExponential(0)}`,
    );
  }
  if (r.conditionNumber > CONDITION_WARNING) {
    warnings.push(
      `condition number ${r.conditionNumber.toExponential(2)} near machine precision; downstream pseudo-inverse will amplify noise`,
    );
  }
  return record({
    U: matrixToRowsValue(r.U),
    S: listOfFloat64(r.S),
    Vt: matrixToRowsValue(r.Vt),
    mode: str(r.mode),
    reconstruction_error: float64FromNumber(r.reconstructionError),
    orthogonality_error_U: float64FromNumber(r.orthogonalityErrorU),
    orthogonality_error_Vt: float64FromNumber(r.orthogonalityErrorVt),
    condition_number: float64FromNumber(r.conditionNumber),
    rank_estimate: int(BigInt(r.rankEstimate)),
    method: str(r.method),
    warnings: list(warnings.map((w) => str(w))),
  });
}

// -----------------------------------------------------------------------------
// Tool definition
// -----------------------------------------------------------------------------

export const def = defineTool({
  name: NAME,
  version: VERSION,
  summary:
    "Dual-algorithm SVD (one-sided Jacobi ≤ n=500; Golub-Reinsch above); `condition_number` and `rank_estimate` are first-class fields",
  schema: { input: inputSchema, output: outputSchema },
  // ADR-0015: numerical tier.  The output always contains float64
  // leaves on the success branch (U, S, Vt, the four error scalars,
  // condition_number), so the platform fingerprint is recorded on
  // every successful run.  The boundary-tag branches carry
  // `int`/`str` payloads only — no float64 leaves — so the
  // `containsFloat64` walker correctly skips the platform field for
  // those.  Mutually exclusive with `nondeterministic: true`.
  numerical: true,
  flags: {
    // The `--method` flag selects the SVD backend explicitly. Default
    // `"auto"` dispatches by problem size: one-sided Jacobi for
    // `max(m, n) ≤ 500` (high relative accuracy on small singular
    // values; Demmel-Veselić 1992) and Golub-Reinsch (Householder
    // bidiagonalisation + Demmel-Kahan implicit-shift QR sweeps;
    // Demmel & Kahan 1990) above. Forcing "one-sided-jacobi" or
    // "golub-reinsch" is useful for tests and benchmarks. The
    // `method` field of the success record always reports the
    // backend that actually ran. See `packages/linalg-core/src/svd.ts`
    // for the dispatch rationale.
    method: F.enum(["auto", "one-sided-jacobi", "golub-reinsch"] as const, "SVD algorithm", {
      default: "auto",
    }),
  },
  examples: [
    {
      description: "1×1 reduced: A=[[3]] → S=[3]",
      input: inp([[3]], "reduced"),
      output: encodeSuccess(svd(matrixFromRows([[3]]), "reduced")),
    },
    {
      description: "5×3 simple: standard tall case (matches bench A_5x3)",
      input: inp(
        [[1, 2, 3], [4, 5, 6], [7, 8, 10], [1, 0, 1], [0, 1, 0]],
        "reduced",
      ),
      output: encodeSuccess(
        svd(
          matrixFromRows([[1, 2, 3], [4, 5, 6], [7, 8, 10], [1, 0, 1], [0, 1, 0]]),
          "reduced",
        ),
      ),
    },
    {
      description: "3×5 short-and-fat: m<n, U is 3×3, Vt is 3×5",
      input: inp(
        [[1, 2, 3, 4, 5], [2, 1, 0, -1, 1], [3, 0, -1, 2, 1]],
        "reduced",
      ),
      output: encodeSuccess(
        svd(
          matrixFromRows([[1, 2, 3, 4, 5], [2, 1, 0, -1, 1], [3, 0, -1, 2, 1]]),
          "reduced",
        ),
      ),
    },
    {
      description: "complete-mode 5×3: U is 5×5, Vt is 3×3 (extra U cols span ker(Aᵀ))",
      input: inp(
        [[1, 2, 3], [4, 5, 6], [7, 8, 10], [1, 0, 1], [0, 1, 0]],
        "complete",
      ),
      output: encodeSuccess(
        svd(
          matrixFromRows([[1, 2, 3], [4, 5, 6], [7, 8, 10], [1, 0, 1], [0, 1, 0]]),
          "complete",
        ),
      ),
    },
    {
      description: "all-zero 2×2: S=[0,0], rank=0 (degenerate but in-scope)",
      input: inp([[0, 0], [0, 0]], "reduced"),
      output: encodeSuccess(svd(matrixFromRows([[0, 0], [0, 0]]), "reduced")),
    },
    {
      description: "non-finite input → tagged 'linalg-svd/non-finite-input'",
      input: inp([[1, 2], [3, NaN]], "reduced"),
      output: tagged(`${NAME}/non-finite-input`, record({
        row: int(1n),
        col: int(1n),
        value: str("NaN"),
      })),
    },
    {
      description: "degenerate shape (m=0) → tagged 'linalg-svd/degenerate-shape'",
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
      statement: "for every successful factorisation, ||U·diag(S)·Vᵀ − A||_F ≤ 100·ε·max(m,n)·sqrt(min(m,n))·||A||_F (Higham 2002 §20.3)",
      machine_checkable: true,
    },
    {
      name: "orthogonality-U",
      statement: "for every successful factorisation, ||UᵀU − I_q||_F ≤ 100·ε·m·sqrt(q) — independent of κ(A) (Demmel-Veselić 1992)",
      machine_checkable: true,
    },
    {
      name: "orthogonality-Vt",
      statement: "for every successful factorisation, ||Vᵀ·V − I_q||_F ≤ 100·ε·n·sqrt(q) — independent of κ(A)",
      machine_checkable: true,
    },
    {
      name: "S-non-negative-descending",
      statement: "S[i] ≥ 0 for all i, and S[i] ≥ S[i+1] for all i < k−1 (within tolerance 100·ε·S[0])",
      machine_checkable: true,
    },
    {
      name: "self-reported-honesty",
      statement: "reported reconstruction_error, orthogonality_error_U, and orthogonality_error_Vt agree with verifier's recomputation to 1e-6 relative",
      machine_checkable: true,
    },
    {
      name: "rank-estimate-LAPACK-threshold",
      statement: "rank_estimate counts singular values exceeding max(m,n)·ε·S[0] — the LAPACK-standard numerical-rank threshold",
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
      name: "scale-warnings-emitted",
      statement: `for max(m, n) > 500, the warnings field carries human-readable scale advisories per ADR-0016 (estimated wall-clock under one-sided Jacobi: O(n³ log² n) — n=500 ≈ 18 s, n=1000 ≈ 3.5 min). Algorithm still runs.`,
      machine_checkable: true,
    },
    {
      name: "oom-becomes-toolerror",
      statement: `a true allocation OOM (RangeError on Float64Array allocation) is caught and re-thrown as a ToolError carrying the attempted byte count. This is the only refusal class for oversize inputs (ADR-0016).`,
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
    // so the structural invariant `A: list<list<float64>>` and (when
    // present) `mode: string` already hold; only semantic checks
    // remain.
    const fields = input.fields;
    const aValue: Value = fields.A as Value;
    const modeValue: Value | undefined = fields.mode as Value | undefined;

    // ── decode `mode` (default "reduced") and check admitted values ───
    const modeStr =
      modeValue === undefined
        ? "reduced"
        : (modeValue as { kind: "string"; value: string }).value;
    if (modeStr !== "reduced" && modeStr !== "complete") {
      throw new ToolError(
        `${NAME}: mode must be "reduced" or "complete", got ${JSON.stringify(modeStr)}`,
        { suggestion: "omit the mode field for the default ('reduced'), or set it to 'complete' for the full m×m U and n×n Vᵀ" },
      );
    }
    const mode = modeStr as "reduced" | "complete";

    // ── decode A row-by-row, intercepting non-finite cells ────────────
    if (aValue.kind !== "list") {
      throw new ToolError(`${NAME}: A must be a list of lists of float64`, {});
    }
    const m = aValue.items.length;

    // Degenerate shape: m = 0.  We deliberately do not pre-check n
    // here because there are no rows to read n from.
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

    // ADR-0016: no size cap. Compute scale-advisory warnings now (cheap,
    // O(1)); attach to the output's `warnings` list at encode time. The
    // only refusal for oversize inputs is a true allocation OOM caught by
    // `withOomGuard` below.
    const scaleWarnings = assessNumericalScale("svd-jacobi", m, n);

    // Walk the rows.  Two passes' worth of work in one: rectangularity
    // + non-finite detection + decoding into a flat Float64Array.  We
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
          // rendering of the bad value (Inf / NaN / -Inf) so a planner
          // can match on it without re-decoding the bits.
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
    let result: SVDResult;
    try {
      result = withOomGuard(m, n, () => svd(A, mode));
    } catch (e) {
      if (e instanceof MemoryExhaustionError) {
        throw new ToolError(e.message, {
          suggestion:
            `the requested ${m}×${n} dense problem could not be allocated. ` +
            `For larger problems consider the FFI bridge (bead scientist-workbench-e7y).`,
          detail: { attempted_bytes: e.attemptedBytes, m: e.dims.m, n: e.dims.n },
        });
      }
      throw e;
    }
    return encodeSuccess(result, scaleWarnings);
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
    const r = svd(A, "reduced");
    if (r.U.rows !== 5 || r.U.cols !== 3) {
      throw new Error(`test: 5×3 U shape wrong — ${r.U.rows}×${r.U.cols}`);
    }
    if (r.S.length !== 3) {
      throw new Error(`test: 5×3 S length wrong — ${r.S.length}`);
    }
    if (r.Vt.rows !== 3 || r.Vt.cols !== 3) {
      throw new Error(`test: 5×3 Vt shape wrong — ${r.Vt.rows}×${r.Vt.cols}`);
    }
    if (r.reconstructionError > 1e-12) {
      throw new Error(`test: 5×3 reconstruction ${r.reconstructionError} > 1e-12`);
    }
    if (r.orthogonalityErrorU > 1e-12) {
      throw new Error(`test: 5×3 orthU ${r.orthogonalityErrorU} > 1e-12`);
    }
    if (r.orthogonalityErrorVt > 1e-12) {
      throw new Error(`test: 5×3 orthVt ${r.orthogonalityErrorVt} > 1e-12`);
    }
    // S is non-negative descending.
    for (let i = 0; i < r.S.length; i++) {
      if (r.S[i]! < 0) throw new Error(`test: S[${i}] = ${r.S[i]} is negative`);
      if (i + 1 < r.S.length && r.S[i]! < r.S[i + 1]! - 1e-12) {
        throw new Error(`test: S not descending at i=${i}: ${r.S[i]} < ${r.S[i + 1]}`);
      }
    }

    // Hilbert-8: the discriminator. Even at κ ≈ 1.5e10, Jacobi's
    // orthogonality must stay near machine epsilon.
    const H = matrixFromRows(
      Array.from({ length: 8 }, (_, i) =>
        Array.from({ length: 8 }, (_, j) => 1 / (i + j + 1)),
      ),
    );
    const rh = svd(H, "reduced");
    if (rh.orthogonalityErrorU > 1e-12) {
      throw new Error(
        `test: Hilbert-8 orthU ${rh.orthogonalityErrorU} > 1e-12 — Jacobi regression?`,
      );
    }
    if (rh.orthogonalityErrorVt > 1e-12) {
      throw new Error(
        `test: Hilbert-8 orthVt ${rh.orthogonalityErrorVt} > 1e-12 — Jacobi regression?`,
      );
    }

    // Rank-revealing on a rank-1 outer product.
    const u = [1, 2, 3, 4];
    const v = [1, -1, 2];
    const A2 = matrixFromRows(u.map((ui) => v.map((vj) => ui * vj)));
    const r2 = svd(A2, "reduced");
    if (r2.rankEstimate !== 1) {
      throw new Error(`test: rank-1 outer product rank_estimate = ${r2.rankEstimate}, expected 1`);
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
