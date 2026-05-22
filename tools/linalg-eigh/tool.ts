// =============================================================================
// linalg-eigh — Symmetric eigendecomposition of a real n×n matrix
// =============================================================================
//
// Intent
// ------
// The fifth numerical-tier tool in scientist-workbench, after `linalg-solve`
// (ADR-0014), `integrate-1d` (ADR-0015 follow-on), `linalg-qr` (worklog 043),
// and `linalg-svd` (worklog 044). Computes
//
//     A = Q · diag(λ) · Qᵀ
//
// for a real *symmetric* `n × n` matrix `A` by cyclic Jacobi rotations
// (Jacobi 1846; Golub & Van Loan §8.4). Wire wrapper around `eigh(A)`
// from `@workbench/linalg-core` — library and tool share one
// implementation per ADR-0010.
//
// What makes symmetric eigh the natural answer to "diagonalise A"
// ---------------------------------------------------------------
// For a symmetric `A`, the eigendecomposition `A = Q · diag(λ) · Qᵀ`
// gives:
//
//   - the spectral norm: `‖A‖₂ = max|λ_i|`;
//   - the spectral condition: `κ₂(A) = max|λ_i| / min|λ_i|`;
//   - functions of A: `f(A) = Q · diag(f(λ)) · Qᵀ` (matrix exponential,
//     square root, log, etc.);
//   - principal axes / modes: columns of Q;
//   - SPD definiteness check: `min(λ) > 0`;
//   - low-rank approximation by spectral truncation (eigvals near zero).
//
// SVD generalises this to non-symmetric / non-square A, but for the
// symmetric case eigh is preferred: cheaper (one matrix instead of
// two factors), and `λ` carries sign information that singular values
// (always non-negative) discard.  We deliberately ship eigh-symmetric
// only — the general (non-Hermitian) `linalg-eig` is bead `evh` and
// involves complex eigenvalues, Schur decomposition, etc.
//
// What makes this tool agent-honest
// ---------------------------------
// The output is *not* just `(Q, λ)`.  It is a record carrying everything
// an agent's planner — or the bench's verifier — needs to decide what
// to do with the answer:
//
//     {
//       Q,                       // n × n orthogonal eigenvector matrix
//       eigenvalues,             // length-n real, sorted ascending
//       reconstruction_error,    // ||A·Q − Q·diag(λ)||_F / max(||A||_F, 1)
//       orthogonality_error,     // ||QᵀQ − I||_F
//       condition_number,        // |λ_max| / max(|λ_min|, EPS · |λ_max|)
//       method,                  // "jacobi"
//       warnings,                // soft thresholds the planner may match on
//     }
//
// `reconstruction_error` and `orthogonality_error` are the candidate's
// honest self-report on its own quality (precedent: `linalg-svd`'s same
// fields, ADR-0014).  The bench's verifier (`bench/linalg-eigh/golden/
// verify.py`) recomputes both and rejects the candidate if they disagree
// by more than 1e-6 relative — agent-honest is *enforced*, not just
// convention.
//
// Why cyclic Jacobi, not tridiag + QR (LAPACK DSYTRD + DSTEQR)
// ------------------------------------------------------------
// Both are admissible by the bench's tolerance regime.  Cyclic Jacobi
// wins the implementation budget at our scale:
//
//   1. **Half the lines of code, no convergence-edge cases.**
//      Tridiag+QR needs Householder tridiagonalisation, then implicit-
//      shift QR sweeps with Wilkinson shifts on the trailing 2×2,
//      deflation, post-sort. Each piece has subtle convergence corners.
//      Jacobi has one loop: rotate (p, q) pairs until the off-diagonal
//      Frobenius norm is below tolerance.
//
//   2. **Superior accuracy on small eigenvalues** (Demmel-Veselić 1992).
//      Jacobi computes every eigenvalue to high relative accuracy
//      regardless of κ(A).  Tridiag+QR can lose half the digits on the
//      smallest eigenvalues when A has a wide spectral spread.
//
//   3. **The bench's tolerance is generous enough** that even at n=500
//      Jacobi's `O(n³ log² n)` cost remains under ~10 s — well below the
//      wall-clock budget for an interactive tool. Beyond that
//      `assessNumericalScale("eigh", ...)` warns and the planner can
//      escalate to FFI (bead `e7y`).
//
// The substrate (`packages/linalg-core/src/eigh.ts`) carries the full
// literate algorithm prose; this file is only the wire-encoding wrapper.
//
// Boundary categories (ADR-0003)
// ------------------------------
//   * `linalg-eigh/non-symmetric-input` (tagged): `max|A − Aᵀ| > 100·EPS·max|A|`.
//                                    Payload carries `(row, col, value,
//                                    max_asymmetry)` for the offending
//                                    coordinate and the asymmetry magnitude.
//                                    Tagged rather than `ToolError` because
//                                    the input is structurally well-formed
//                                    — the agent's planner can match on it
//                                    and decide whether to symmetrise
//                                    `A := (A + Aᵀ)/2` and retry.
//   * `linalg-eigh/non-finite-input`  (tagged): `A` contains NaN / ±Inf.
//                                    Payload carries `(row, col, value)` for
//                                    the first non-finite coordinate found.
//   * `linalg-eigh/degenerate-shape`  (tagged): `n = 0`.  Payload carries
//                                    `(m, n)`.
//   * `ToolError` (exit 1) for *malformed* input:
//     - non-square `A` (rectangular)
//     - non-rectangular `A` (ragged rows)
//     - actual OOM (RangeError on Float64Array allocation) — caught and
//       re-thrown as ToolError with the attempted-bytes detail.
//       Per ADR-0016, there is *no* `n ≤ 200` cap; large inputs run with
//       loud warnings instead. OOM is the only physical refusal.
//
// Out of scope (v0.1, all explicitly deferred)
// --------------------------------------------
//   * Generalised symmetric eigh `A·x = λ·B·x` — bead `geh`
//   * Non-Hermitian `linalg-eig` (complex eigenvalues, Schur decomp) —
//     bead `evh`
//   * Faster tridiag+QR substrate — bead `te-qr`
//   * FFI to LAPACK DSYEVD — bead `e7y`
//   * Cross-platform determinism guarantee — `numerical: true` (ADR-0015)
//
// Algorithm
// ---------
// Cyclic-by-rows Jacobi (Jacobi 1846; Golub & Van Loan §8.4; Demmel-
// Veselić 1992 for the high-relative-accuracy result; Forsythe-Henrici
// 1960 for the cyclic convergence proof).  See
// `packages/linalg-core/src/eigh.ts` for the full literate algorithm
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
  type EighResult,
  matrixFromRows,
  eigh,
  assessNumericalScale,
  MemoryExhaustionError,
  withOomGuard,
} from "@workbench/linalg-core";

const NAME = "linalg-eigh";
const VERSION = "0.1.0";

const EPS = Number.EPSILON;

// Symmetry tolerance, mirroring the verifier's `_is_symmetric`:
//   max|A − Aᵀ| > SYMMETRY_TOL_FACTOR · max|A|  ⇒  asymmetric.
// Rounding noise from a `(A + Aᵀ)/2` symmetrisation is bounded by
// ~ε·max|A|, so the 100× factor admits any numerically-symmetric input
// while rejecting genuine asymmetry.
const SYMMETRY_TOL_FACTOR = 100 * EPS;

// Soft warning thresholds.  These are *fields* of the output record,
// not boundary refusals — the planner reads them and decides.
const RECONSTRUCTION_WARNING = 1e-12;
const ORTHOGONALITY_WARNING = 1e-12;
const CONDITION_WARNING = 1e12;

// -----------------------------------------------------------------------------
// Schema
// -----------------------------------------------------------------------------
//
// Input is a record with required `A` (list of lists of float64).  The
// bench's wire format omits any optional fields.

const inputSchema = S.record({
  A: S.list(S.list(S.kind("float64"))),
});

const successOutputSchema = S.record({
  Q: S.list(S.list(S.kind("float64"))),
  eigenvalues: S.list(S.kind("float64")),
  reconstruction_error: S.kind("float64"),
  orthogonality_error: S.kind("float64"),
  condition_number: S.kind("float64"),
  method: S.kind("string"),
  warnings: S.list(S.kind("string")),
});

const nonSymmetricOutputSchema = S.tagged(
  `${NAME}/non-symmetric-input`,
  S.record({
    row: S.kind("integer"),
    col: S.kind("integer"),
    value: S.kind("string"),
    max_asymmetry: S.kind("string"),
  }),
);

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
  nonSymmetricOutputSchema,
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

function inp(A: readonly (readonly number[])[]) {
  return record({
    A: list(A.map((row) => listOfFloat64(row))),
  });
}

function encodeSuccess(r: EighResult, scaleWarnings: readonly string[] = []) {
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
      `condition number ${r.conditionNumber.toExponential(2)} near machine precision; downstream A⁻¹ will amplify noise`,
    );
  }
  return record({
    Q: matrixToRowsValue(r.Q),
    eigenvalues: listOfFloat64(r.eigenvalues),
    reconstruction_error: float64FromNumber(r.reconstructionError),
    orthogonality_error: float64FromNumber(r.orthogonalityError),
    condition_number: float64FromNumber(r.conditionNumber),
    method: str("jacobi"),
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
    "Cyclic Jacobi symmetric eigensolver for real symmetric `n × n` A; agent-honest reconstruction + orthogonality errors",
  schema: { input: inputSchema, output: outputSchema },
  // ADR-0015: numerical tier.  The output always contains float64
  // leaves on the success branch (Q, eigenvalues, the three error
  // scalars), so the platform fingerprint is recorded on every
  // successful run.  The boundary-tag branches carry `int`/`str`
  // payloads only — no float64 leaves — so the `containsFloat64`
  // walker correctly skips the platform field for those.  Mutually
  // exclusive with `nondeterministic: true`.
  numerical: true,
  flags: {
    // The `--method` flag exists for symmetry with the other numerical
    // tools.  Currently the only choice is "jacobi". Adding "tridiag-qr"
    // later is schema-additive.
    method: F.enum(["jacobi"] as const, "Symmetric eigh algorithm", {
      default: "jacobi",
    }),
  },
  examples: [
    {
      description: "1×1: A=[[3]] → λ=[3]",
      input: inp([[3]]),
      output: encodeSuccess(eigh(matrixFromRows([[3]]))),
    },
    {
      description: "2×2 identity: λ=[1,1]",
      input: inp([[1, 0], [0, 1]]),
      output: encodeSuccess(eigh(matrixFromRows([[1, 0], [0, 1]]))),
    },
    {
      description: "diagonal A=diag(3,1,4,1,5): λ sorted ascending = [1,1,3,4,5]",
      input: inp([
        [3, 0, 0, 0, 0],
        [0, 1, 0, 0, 0],
        [0, 0, 4, 0, 0],
        [0, 0, 0, 1, 0],
        [0, 0, 0, 0, 5],
      ]),
      output: encodeSuccess(eigh(matrixFromRows([
        [3, 0, 0, 0, 0],
        [0, 1, 0, 0, 0],
        [0, 0, 4, 0, 0],
        [0, 0, 0, 1, 0],
        [0, 0, 0, 0, 5],
      ]))),
    },
    {
      description: "all-zero 2×2: λ=[0,0], Q orthonormal",
      input: inp([[0, 0], [0, 0]]),
      output: encodeSuccess(eigh(matrixFromRows([[0, 0], [0, 0]]))),
    },
    {
      description: "non-symmetric input → tagged 'linalg-eigh/non-symmetric-input'",
      input: inp([[1, 2], [3, 4]]),
      output: tagged(`${NAME}/non-symmetric-input`, record({
        row: int(0n),
        col: int(1n),
        value: str("-1"),
        max_asymmetry: str("1"),
      })),
    },
    {
      description: "non-finite input → tagged 'linalg-eigh/non-finite-input'",
      input: inp([[1, 2], [2, NaN]]),
      output: tagged(`${NAME}/non-finite-input`, record({
        row: int(1n),
        col: int(1n),
        value: str("NaN"),
      })),
    },
    {
      description: "degenerate shape (n=0) → tagged 'linalg-eigh/degenerate-shape'",
      input: record({ A: list([]) }),
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
      statement: "for every successful factorisation, ||A·Q − Q·diag(λ)||_F ≤ 100·ε·n·sqrt(n)·||A||_F (Higham 2002 §20.6)",
      machine_checkable: true,
    },
    {
      name: "orthogonality",
      statement: "for every successful factorisation, ||QᵀQ − I_n||_F ≤ 100·ε·n·sqrt(n) — independent of κ(A) (Wilkinson 1965; Demmel-Veselić 1992)",
      machine_checkable: true,
    },
    {
      name: "eigenvalues-ascending",
      statement: "λ[i] ≤ λ[i+1] for all i < n−1 (within tolerance 100·ε·max(|λ_max|, 1)) — numpy / LAPACK convention",
      machine_checkable: true,
    },
    {
      name: "self-reported-honesty",
      statement: "reported reconstruction_error and orthogonality_error agree with verifier's recomputation to 1e-6 relative",
      machine_checkable: true,
    },
    {
      name: "non-symmetric-tagged",
      statement: `any A with max|A − Aᵀ| > 100·EPS·max|A| → tagged "${NAME}/non-symmetric-input" with the offending coordinate and asymmetry magnitude — never silently symmetrised`,
      machine_checkable: true,
    },
    {
      name: "non-finite-tagged",
      statement: `any NaN or ±Inf in A → tagged "${NAME}/non-finite-input" with the offending (row, col, value) — never silently propagated`,
      machine_checkable: true,
    },
    {
      name: "degenerate-shape-tagged",
      statement: `n = 0 → tagged "${NAME}/degenerate-shape" with (m, n) — never an unhelpful exit-1`,
      machine_checkable: true,
    },
    {
      name: "scale-warnings-emitted",
      statement: `for n > 500, the warnings field carries human-readable scale advisories per ADR-0016. Algorithm still runs.`,
      machine_checkable: true,
    },
    {
      name: "oom-becomes-toolerror",
      statement: `a true allocation OOM (RangeError on Float64Array allocation) is caught and re-thrown as a ToolError carrying the attempted byte count. This is the only refusal class for oversize inputs (ADR-0016).`,
      machine_checkable: true,
    },
    {
      name: "non-square-rejected",
      statement: "non-square A (m ≠ n) raises ToolError",
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
    // so the structural invariant `A: list<list<float64>>` already
    // holds; only semantic checks remain.
    const fields = input.fields;
    const aValue: Value = fields.A as Value;

    if (aValue.kind !== "list") {
      throw new ToolError(`${NAME}: A must be a list of lists of float64`, {});
    }
    const m = aValue.items.length;

    // ── degenerate shape: m = 0 ────────────────────────────────────────
    // We deliberately do not pre-check n here because there are no
    // rows to read n from.  By convention we report `n = 0` too.
    if (m === 0) {
      return tagged(`${NAME}/degenerate-shape`, record({
        m: int(0n),
        n: int(0n),
      }));
    }

    // Determine n from the first row, then enforce rectangularity and
    // squareness.
    const firstRow = aValue.items[0]!;
    if (firstRow.kind !== "list") {
      throw new ToolError(`${NAME}: A[0] is not a list`, {});
    }
    const n = firstRow.items.length;

    // Treat a row of zero columns the same as zero rows: degenerate shape.
    if (n === 0) {
      return tagged(`${NAME}/degenerate-shape`, record({
        m: int(BigInt(m)),
        n: int(0n),
      }));
    }

    // Squareness is a *malformed* boundary: there is no symmetric eigh
    // for a rectangular input — the contract is undefined.  We refuse
    // with `ToolError` (the SVD tool would be the right answer).
    if (m !== n) {
      throw new ToolError(
        `${NAME}: A must be square (got ${m}×${n})`,
        {
          suggestion:
            `for a non-square matrix, use linalg-svd to compute the singular ` +
            `value decomposition instead`,
        },
      );
    }

    // ADR-0016: no size cap. Compute scale-advisory warnings now (cheap,
    // O(1)); attach to the output's `warnings` list at encode time.
    const scaleWarnings = assessNumericalScale("eigh", n, n);

    // Walk the rows.  Two passes' worth of work in one: rectangularity
    // + non-finite detection + decoding into a flat Float64Array. We
    // also track `max|A|` for the symmetry tolerance, computed in the
    // same pass.
    const data = new Float64Array(n * n);
    let maxAbs = 0;
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
        const absX = Math.abs(x);
        if (absX > maxAbs) maxAbs = absX;
        data[i * n + j] = x;
      }
    }

    // ── symmetry check (post-decode) ──────────────────────────────────
    // We walk every (i, j) pair and compare against its mirror. The
    // boundary fires if `max|A − Aᵀ| > SYMMETRY_TOL_FACTOR · max|A|`
    // — same threshold as the verifier's `_is_symmetric`, so a passing
    // candidate matches the bench's symmetry decision exactly.
    //
    // We track the largest asymmetry seen and report (i, j) for it,
    // mirroring the SciPy reference's `np.argmax(np.abs(A - A.T))`.
    if (maxAbs > 0) {
      const symThresh = SYMMETRY_TOL_FACTOR * maxAbs;
      let worstAsym = 0;
      let worstI = -1;
      let worstJ = -1;
      let worstDelta = 0;
      for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) {
          const aij = data[i * n + j]!;
          const aji = data[j * n + i]!;
          const delta = aij - aji;
          const a = Math.abs(delta);
          if (a > worstAsym) {
            worstAsym = a;
            worstI = i;
            worstJ = j;
            worstDelta = delta;
          }
        }
      }
      if (worstAsym > symThresh) {
        return tagged(`${NAME}/non-symmetric-input`, record({
          row: int(BigInt(worstI)),
          col: int(BigInt(worstJ)),
          // Match the SciPy reference's payload format: the *delta*
          // `A[i,j] − A[j,i]` rather than `A[i,j]` itself.  The verifier
          // doesn't read this field for its accept/reject decision (it
          // only checks the tag and the input's actual symmetry), so
          // the choice is documentation-quality only.
          value: str(String(worstDelta)),
          max_asymmetry: str(String(worstAsym)),
        }));
      }
    }

    // The substrate operates on `Matrix`. Construct it directly from
    // the validated data buffer (skipping `matrixFromRows`'s own
    // validation, which we just did).
    const A: Matrix = { rows: n, cols: n, data };
    let result: EighResult;
    try {
      result = withOomGuard(n, n, () => eigh(A));
    } catch (e) {
      if (e instanceof MemoryExhaustionError) {
        throw new ToolError(e.message, {
          suggestion:
            `the requested ${n}×${n} dense problem could not be allocated. ` +
            `For larger problems consider the FFI bridge (bead scientist-workbench-e7y).`,
          detail: { attempted_bytes: e.attemptedBytes, m: e.dims.m, n: e.dims.n },
        });
      }
      throw e;
    }
    return encodeSuccess(result, scaleWarnings);
  },
  test: () => {
    // Smoke probe: a 5×5 symmetric case must round-trip through the
    // substrate and self-report errors that match an independent
    // recomputation (the same check the bench's verify.py applies).
    const A = matrixFromRows([
      [4, 1, 2, 0, 1],
      [1, 3, 0, 1, 0],
      [2, 0, 5, 1, 1],
      [0, 1, 1, 2, 0],
      [1, 0, 1, 0, 6],
    ]);
    const r = eigh(A);
    if (r.Q.rows !== 5 || r.Q.cols !== 5) {
      throw new Error(`test: 5×5 Q shape wrong — ${r.Q.rows}×${r.Q.cols}`);
    }
    if (r.eigenvalues.length !== 5) {
      throw new Error(`test: 5×5 eigenvalues length wrong — ${r.eigenvalues.length}`);
    }
    if (r.reconstructionError > 1e-12) {
      throw new Error(`test: 5×5 reconstruction ${r.reconstructionError} > 1e-12`);
    }
    if (r.orthogonalityError > 1e-12) {
      throw new Error(`test: 5×5 orth ${r.orthogonalityError} > 1e-12`);
    }
    // Eigenvalues are non-decreasing.
    for (let i = 0; i + 1 < r.eigenvalues.length; i++) {
      if (r.eigenvalues[i]! > r.eigenvalues[i + 1]! + 1e-12) {
        throw new Error(`test: eigenvalues not ascending at i=${i}: ${r.eigenvalues[i]} > ${r.eigenvalues[i + 1]}`);
      }
    }

    // Hilbert-8: the discriminator. Even at κ ≈ 1.5e10 the orthogonality
    // must stay near machine epsilon — that's the Jacobi advertisement.
    const H = matrixFromRows(
      Array.from({ length: 8 }, (_, i) =>
        Array.from({ length: 8 }, (_, j) => 1 / (i + j + 1)),
      ),
    );
    const rh = eigh(H);
    if (rh.orthogonalityError > 1e-12) {
      throw new Error(
        `test: Hilbert-8 orth ${rh.orthogonalityError} > 1e-12 — Jacobi regression?`,
      );
    }

    // Diagonal: eigenvalues should match diagonal entries (sorted).
    const D = matrixFromRows([
      [3, 0, 0],
      [0, 1, 0],
      [0, 0, 2],
    ]);
    const rd = eigh(D);
    const expected = [1, 2, 3];
    for (let i = 0; i < 3; i++) {
      if (Math.abs(rd.eigenvalues[i]! - expected[i]!) > 100 * Number.EPSILON) {
        throw new Error(
          `test: diagonal eigenvalues[${i}] = ${rd.eigenvalues[i]}, expected ${expected[i]}`,
        );
      }
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
