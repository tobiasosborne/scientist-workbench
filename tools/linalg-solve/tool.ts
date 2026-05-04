// =============================================================================
// linalg-solve — solve A x = b for a square dense float64 matrix
// =============================================================================
//
// Intent
// ------
// The first numerical-tier tool in scientist-workbench. ADR-0014 is the
// design rationale; this file is the wire-encoding wrapper around
// `solve` from `@workbench/linalg-core`. Library and tool share one
// implementation (ADR-0010): an agent invokes the tool over stdin/stdout,
// a TS-side caller imports `solve(A, b)` and operates on `Float64Array`
// directly.
//
// What makes this tool agent-honest (the load-bearing design choice):
// the output is *not* just `x`. It is a record carrying everything an
// agent's planner needs to decide what to do with the answer:
//
//   {
//     x,                  // the solution vector
//     residual_norm,      // ||A x - b||_2
//     b_norm,             // ||b||_2 (denominator for the relative residual)
//     condition_estimate, // κ_1(A) — how well-posed the problem is
//     growth_factor,      // pivot growth — how stable the LU was
//     method,             // "lu-partial-pivot"
//     iterations,         // refinement steps performed
//     warnings,           // human-readable strings the planner can match on
//   }
//
// Boundary categories (ADR-0003)
// ------------------------------
//   * `linalg-solve/singular`    (tagged): exactly singular A; payload is
//                                a record with the row index where the
//                                pivot zeroed.
//   * Malformed input (ToolError, exit 1):
//     - non-square A
//     - dim(A) ≠ dim(b)
//     - non-finite (NaN / ±Inf) entries (with a path-into-tree)
//     - n > 200 (the v0.1 cap; suggestion points to bead `wmm`)
//     - n = 0
//
// Out of scope (v0.1, all explicitly deferred)
// --------------------------------------------
//   * Other decompositions (QR / SVD / eigendecomposition) → bead 71f
//   * n > 200 (would force the blob-by-hash convention) → bead wmm
//   * FFI to OpenBLAS                                     → bead e7y
//   * Cross-platform determinism guarantee                → bead 0ck (ADR-0015)
//
// Algorithm
// ---------
// LU with partial pivoting + one optional iterative-refinement step +
// Hager 1-norm condition estimator. See packages/linalg-core/src/{lu,
// solve, hager}.ts for the literate algorithmic prose. Reference:
// Higham, *Accuracy and Stability of Numerical Algorithms*, 2nd ed.

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
  type SolveResult,
  matrixFromRows,
  matIdentity,
  lu as luFactor,
  solve,
} from "@workbench/linalg-core";

const NAME = "linalg-solve";
const VERSION = "0.1.0";

// v0.1 cap. The forcing function: a request that exceeds this points
// the agent at bead `wmm` for the blob-by-hash follow-up.
const MAX_N = 200;

// Threshold above which we add a warning string to the output. These
// are documented thresholds, not a hard "fail above this"; the agent
// reads the raw scalar and decides for itself.
const GROWTH_FACTOR_WARNING = 1e6;
const CONDITION_WARNING = 1e10;
const RELATIVE_RESIDUAL_WARNING = 1e-8;

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

function listOfListOfFloat64(rows: readonly (readonly number[])[]): {
  readonly kind: "list";
  readonly items: readonly { readonly kind: "list"; readonly items: readonly Float64Value[] }[];
} {
  return list(rows.map((row) => listOfFloat64(row)));
}

// -----------------------------------------------------------------------------
// Tool definition
// -----------------------------------------------------------------------------

const inputSchema = S.record({
  A: S.list(S.list(S.kind("float64"))),
  b: S.list(S.kind("float64")),
});

const successOutputSchema = S.record({
  x: S.list(S.kind("float64")),
  residual_norm: S.kind("float64"),
  b_norm: S.kind("float64"),
  condition_estimate: S.kind("float64"),
  growth_factor: S.kind("float64"),
  method: S.kind("string"),
  iterations: S.kind("integer"),
  warnings: S.list(S.kind("string")),
});
const singularOutputSchema = S.tagged(
  `${NAME}/singular`,
  S.record({ pivot_row: S.kind("integer") }),
);
const outputSchema = S.union([successOutputSchema, singularOutputSchema]);

// Convenience: build the canonical input value for a hand-written matrix
// and right-hand side. Used by examples and `--test`. The return type is
// inferred (and narrow) so it satisfies the schema-typed `examples` slot.
function inp(A: readonly (readonly number[])[], b: readonly number[]) {
  return record({ A: listOfListOfFloat64(A), b: listOfFloat64(b) });
}

export const def = defineTool({
  name: NAME,
  version: VERSION,
  schema: { input: inputSchema, output: outputSchema },
  // ADR-0015: numerical tier. Output bytes are bit-identical *given the
  // platform fingerprint* {arch, os, runtime}; cross-platform divergence
  // is honestly recorded in the provenance record's `platform` field, and
  // `runMemoized` skips cache hits whose platform doesn't match the
  // running platform. Every linalg-solve output contains float64, so the
  // platform field is recorded on every successful run (per ADR-0007's
  // per-output-tier-conditioning precedent).
  numerical: true,
  flags: {
    method: F.enum(["lu"] as const, "decomposition method", { default: "lu" }),
  },
  examples: [
    {
      description: "identity 3x3: x = b",
      input: inp([[1, 0, 0], [0, 1, 0], [0, 0, 1]], [1, 2, 3]),
      output: encodeSolveValue(solve(matIdentity(3), new Float64Array([1, 2, 3]))!),
    },
    {
      description: "[[2,1],[1,3]] x = [4,5] → [7/5, 6/5]",
      input: inp([[2, 1], [1, 3]], [4, 5]),
      output: encodeSolveValue(
        solve(matrixFromRows([[2, 1], [1, 3]]), new Float64Array([4, 5]))!,
      ),
    },
    {
      description: "permutation: P x = [7,13,19] → x = [19,7,13]",
      input: inp([[0, 1, 0], [0, 0, 1], [1, 0, 0]], [7, 13, 19]),
      output: encodeSolveValue(
        solve(matrixFromRows([[0, 1, 0], [0, 0, 1], [1, 0, 0]]), new Float64Array([7, 13, 19]))!,
      ),
    },
    {
      description: "diagonal: solve(diag(2,4,8), [4,12,32]) = [2, 3, 4]",
      input: inp([[2, 0, 0], [0, 4, 0], [0, 0, 8]], [4, 12, 32]),
      output: encodeSolveValue(
        solve(matrixFromRows([[2, 0, 0], [0, 4, 0], [0, 0, 8]]), new Float64Array([4, 12, 32]))!,
      ),
    },
    {
      description: "Hilbert(3): condition_estimate flags ill-posedness",
      input: inp(
        [[1, 1 / 2, 1 / 3], [1 / 2, 1 / 3, 1 / 4], [1 / 3, 1 / 4, 1 / 5]],
        [1, 0, 0],
      ),
      output: encodeSolveValue(
        solve(
          matrixFromRows([[1, 1 / 2, 1 / 3], [1 / 2, 1 / 3, 1 / 4], [1 / 3, 1 / 4, 1 / 5]]),
          new Float64Array([1, 0, 0]),
        )!,
      ),
    },
    {
      description: "exactly singular ([[1,2],[2,4]]) → tagged 'linalg-solve/singular'",
      input: inp([[1, 2], [2, 4]], [1, 2]),
      output: tagged(`${NAME}/singular`, record({ pivot_row: int(1n) })),
    },
  ],
  invariants: [
    {
      name: "deterministic",
      statement: "same input bytes → same output bytes (single-platform; ADR-0015 will tier this)",
      machine_checkable: true,
    },
    {
      name: "round-trip-residual",
      statement: "for every successful solve, ||A x - b||_2 ≤ residual_norm + machine epsilon",
      machine_checkable: true,
    },
    {
      name: "non-square-rejected",
      statement: "non-square A raises ToolError with dimension report",
      machine_checkable: true,
    },
    {
      name: "dim-mismatch-rejected",
      statement: "rows(A) ≠ length(b) raises ToolError",
      machine_checkable: true,
    },
    {
      name: "non-finite-rejected",
      statement: "any NaN or ±Infinity in A or b raises ToolError with a path",
      machine_checkable: true,
    },
    {
      name: "size-cap-rejected",
      statement: `n > ${MAX_N} raises ToolError pointing at the v0.2 follow-up`,
      machine_checkable: true,
    },
    {
      name: "singular-tagged",
      statement: `exactly singular A produces tagged "${NAME}/singular" — never silently wrong x`,
      machine_checkable: true,
    },
  ],
  fn: (input, _flags) => {
    // The runner has already validated against `inputSchema`, so the
    // shape is guaranteed; only semantic checks remain.
    const A = decodeMatrix(input.fields.A, "A");
    const b = decodeVector(input.fields.b, "b");

    if (A.rows !== A.cols) {
      throw new ToolError(
        `${NAME}: A must be square (got ${A.rows}×${A.cols})`,
        { suggestion: "for over-determined systems, use linalg-lstsq (deferred — bead 71f)" },
      );
    }
    if (A.rows !== b.length) {
      throw new ToolError(
        `${NAME}: dim mismatch — A is ${A.rows}×${A.cols}, b has length ${b.length}`,
        { suggestion: `set length(b) = ${A.rows}` },
      );
    }
    if (A.rows > MAX_N) {
      throw new ToolError(
        `${NAME}: n = ${A.rows} exceeds v0.1 cap (${MAX_N})`,
        {
          suggestion:
            `for n > ${MAX_N}, the wire encoding cost is high; see bead scientist-workbench-wmm (blob-by-hash convention) and -e7y (FFI BLAS path)`,
        },
      );
    }

    const result = solve(A, b);
    if (result === null) {
      // Find the row at which the pivot column was all-zeros. Cheap
      // diagnostic re-run; not on the hot path.
      const pivotRow = findSingularRow(A);
      return tagged(`${NAME}/singular`, record({ pivot_row: int(BigInt(pivotRow)) }));
    }

    return encodeSolveResult(result);
  },
  test: () => {
    // In-process probe: a successful solve's residual matches what we
    // reported, and the singular case is genuinely tagged.
    const r = solve(matrixFromRows([[2, 1], [1, 3]]), new Float64Array([4, 5]))!;
    if (Math.abs(r.x[0]! - 7 / 5) > 1e-12) throw new Error("test: 2x2 hand answer drifted");
    if (Math.abs(r.x[1]! - 6 / 5) > 1e-12) throw new Error("test: 2x2 hand answer drifted");
    if (r.residualNorm > 1e-12) throw new Error("test: residual unexpectedly large");
    if (solve(matrixFromRows([[1, 2], [2, 4]]), new Float64Array([1, 2])) !== null) {
      throw new Error("test: singular matrix did not return null");
    }
    // Hilbert(4) is severely ill-conditioned; condition_estimate should
    // be ≥ 1e4 (true value is ~1.5e4 in 1-norm).
    const H = matrixFromRows([
      [1, 1 / 2, 1 / 3, 1 / 4],
      [1 / 2, 1 / 3, 1 / 4, 1 / 5],
      [1 / 3, 1 / 4, 1 / 5, 1 / 6],
      [1 / 4, 1 / 5, 1 / 6, 1 / 7],
    ]);
    const rh = solve(H, new Float64Array([1, 0, 0, 0]))!;
    if (rh.conditionEstimate < 1e4) {
      throw new Error(`test: Hilbert(4) condition estimate ${rh.conditionEstimate} < 1e4`);
    }
  },
});

// -----------------------------------------------------------------------------
// Decode / encode helpers — schema validation has happened; these only
// translate the wire bytes into raw JS numbers and back.
// -----------------------------------------------------------------------------

function decodeMatrix(v: Value, fieldName: string): Matrix {
  if (v.kind !== "list") {
    throw new ToolError(`${NAME}: ${fieldName} must be a list of lists of float64`, {});
  }
  if (v.items.length === 0) {
    throw new ToolError(`${NAME}: ${fieldName} is empty`, { suggestion: "provide an n×n matrix with n ≥ 1" });
  }
  const rows: number[][] = [];
  for (let i = 0; i < v.items.length; i++) {
    const row = v.items[i]!;
    if (row.kind !== "list") {
      throw new ToolError(`${NAME}: ${fieldName}[${i}] is not a list`, {});
    }
    const r: number[] = [];
    for (let j = 0; j < row.items.length; j++) {
      const cell = row.items[j]!;
      if (cell.kind !== "float64") {
        throw new ToolError(`${NAME}: ${fieldName}[${i}][${j}] is not a float64`, {});
      }
      const x = float64ToNumber(cell);
      if (!Number.isFinite(x)) {
        throw new ToolError(`${NAME}: ${fieldName}[${i}][${j}] is non-finite (${x})`, {
          suggestion: "every entry must be a finite IEEE-754 binary64; NaN/±Inf are not admitted",
        });
      }
      r.push(x);
    }
    rows.push(r);
  }
  return matrixFromRows(rows);
}

function decodeVector(v: Value, fieldName: string): Float64Array {
  if (v.kind !== "list") {
    throw new ToolError(`${NAME}: ${fieldName} must be a list of float64`, {});
  }
  const out = new Float64Array(v.items.length);
  for (let i = 0; i < v.items.length; i++) {
    const cell = v.items[i]!;
    if (cell.kind !== "float64") {
      throw new ToolError(`${NAME}: ${fieldName}[${i}] is not a float64`, {});
    }
    const x = float64ToNumber(cell);
    if (!Number.isFinite(x)) {
      throw new ToolError(`${NAME}: ${fieldName}[${i}] is non-finite (${x})`, {});
    }
    out[i] = x;
  }
  return out;
}

function encodeSolveResult(r: SolveResult) {
  const warnings: string[] = [];
  if (r.growthFactor > GROWTH_FACTOR_WARNING) {
    warnings.push(
      `growth factor ${r.growthFactor.toExponential(2)} exceeds ${GROWTH_FACTOR_WARNING.toExponential(0)}; LU may be backward-unstable`,
    );
  }
  if (r.conditionEstimate > CONDITION_WARNING) {
    warnings.push(
      `condition estimate ${r.conditionEstimate.toExponential(2)} exceeds ${CONDITION_WARNING.toExponential(0)}; problem is ill-posed`,
    );
  }
  if (r.bNorm > 0 && r.residualNorm / r.bNorm > RELATIVE_RESIDUAL_WARNING) {
    warnings.push(
      `relative residual ${(r.residualNorm / r.bNorm).toExponential(2)} exceeds ${RELATIVE_RESIDUAL_WARNING.toExponential(0)}; solution may be inaccurate`,
    );
  }
  return record({
    x: listOfFloat64(r.x),
    residual_norm: float64FromNumber(r.residualNorm),
    b_norm: float64FromNumber(r.bNorm),
    condition_estimate: float64FromNumber(r.conditionEstimate),
    growth_factor: float64FromNumber(r.growthFactor),
    method: str(r.method),
    iterations: int(BigInt(r.iterations)),
    warnings: list(warnings.map((w) => str(w))),
  });
}

// Helper used by the `examples` block — return type inferred narrow.
function encodeSolveValue(r: SolveResult) {
  return encodeSolveResult(r);
}

/**
 * Diagnostic only: re-run elimination far enough to identify the row
 * where the pivot column was all-zeros. Used to populate the singular-
 * tag payload. O(n³) worst case but only invoked on the rare singular
 * branch.
 */
function findSingularRow(A: Matrix): number {
  const n = A.rows;
  // Working copy.
  const a = new Float64Array(A.data);
  for (let k = 0; k < n; k++) {
    let pivotAbs = 0;
    for (let i = k; i < n; i++) {
      const v = Math.abs(a[i * n + k]!);
      if (v > pivotAbs) pivotAbs = v;
    }
    if (pivotAbs === 0) return k;
    // Naive elimination (no pivot swap; we only need to find the zero
    // column, not factor).
    let p = k;
    let pv = Math.abs(a[k * n + k]!);
    for (let i = k + 1; i < n; i++) {
      const v = Math.abs(a[i * n + k]!);
      if (v > pv) {
        pv = v;
        p = i;
      }
    }
    if (p !== k) {
      for (let j = 0; j < n; j++) {
        const t = a[p * n + j]!;
        a[p * n + j] = a[k * n + j]!;
        a[k * n + j] = t;
      }
    }
    const pivot = a[k * n + k]!;
    for (let i = k + 1; i < n; i++) {
      const m = a[i * n + k]! / pivot;
      for (let j = k + 1; j < n; j++) {
        a[i * n + j] = a[i * n + j]! - m * a[k * n + j]!;
      }
    }
  }
  return -1; // unreachable — caller already established singularity
}

if (import.meta.main) void runTool(def);
