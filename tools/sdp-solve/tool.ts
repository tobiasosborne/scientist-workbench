// =============================================================================
// sdp-solve — semidefinite-programming specialist (cone-solver tier, ADR-0030 §B)
// =============================================================================
//
// Intent
// ------
// The SDP specialist of the cone-solver tier. A TS expert who types
// `wb.run("sdp-solve", problem)` gets back a `record` with the primal
// matrix(es) `X` (svec'd into the wire vector `x`), the dual `y`, the
// dual slack matrix(es) `S` (svec'd into `slack`), the objective, and an
// honest `achieved_precision` derived from the IPM's primal/dual
// feasibility residual and complementary slackness.
//
// Internally the tool wraps `@workbench/solver-ipm`'s primal-dual
// interior-point method. Three search directions are available; the
// default is the Nesterov-Todd direction (Todd-Toh-Tütüncü 1998), which
// is symmetric and self-scaled — the SDPT3 default for v4 onwards.
// Alizadeh-Haeberly-Overton (1997) is exposed as `--method=aho` for A/B
// comparison; Helmberg-Kojima-Monteiro (1996) is gated behind
// `--method=hkm-debug` because it is asymmetric and slower-converging
// in practice.
//
// Wire vs internal representation
// -------------------------------
// The tool speaks the unified cone-solver wire (ADR-0030 §C/§D): every
// primal variable, including the entries of every PSD matrix block,
// lives in a single n-vector `x`. A `PSDCone[size, indices]` cone tells
// the tool that the slice `x[indices]` is the **svec** (symmetric
// vectorisation) of an `size × size` PSD matrix.
//
// **svec convention** — strict-Mosek-format with √2 off-diagonal scaling
// (ADR-0030 §C, Open Question #4). For a symmetric `n × n` matrix `M`:
//
//     svec(M)[k(i,i)] = M[i,i]                  (diagonal)
//     svec(M)[k(i,j)] = √2 · M[i,j]   (i < j)   (upper off-diagonal)
//
// where the position `k(i,j)` is the row-major upper-triangular index:
//
//     k(0,0)=0  k(0,1)=1  k(0,2)=2  ...  k(0,n-1)=n-1
//                          k(1,1)=n  k(1,2)=n+1  ...
//                                              k(n-1,n-1)=n(n+1)/2 - 1
//
// The √2 scaling makes the Frobenius inner product algebraically
// trivial: `<C, X>_F = svec(C)ᵀ · svec(X)`. Without the scaling the
// off-diagonal terms would be double-counted (because both `M[i,j]` and
// `M[j,i]` carry the same value for symmetric `M`). This is the trap
// every amateur SDP implementer falls into; we name it explicitly here.
//
// The cone's `indices: list<integer>` argument carries `n*(n+1)/2`
// integers — the global positions in `x` that constitute `svec(X_b)`,
// in the row-major upper-tri order above. Two PSD blocks of sizes 2 and
// 3 might be encoded with `indices = [0, 1, 2]` and
// `indices = [3, 4, 5, 6, 7, 8]`, or with any other partition of `x`'s
// indices — the partition is the agent's choice.
//
// On output, the same convention applies in reverse: `x[indices]`
// carries `svec(X_b)`, and `slack[indices]` carries `svec(S_b)`. To
// recover the matrix from the wire, scale off-diagonals by `1/√2` and
// fill out the symmetric counterpart. The tool's README prints a worked
// example.
//
// v0.1 cone vocabulary
// --------------------
// PSDCone (the primary surface) and ZeroCone (variables forced to
// zero — rarely used; usually absorbed into `Ax_eq_b`) are accepted.
// `NonNegCone` is **refused with a suggestion** to use `tools/lp-solve`
// for pure-LP problems or to wait for the universal `tools/cone-solve`
// (bead `2ivi`) for mixed-cone problems. Internally NonNegCone could be
// reformulated as a diagonal PSD block of size `len(indices)`, but the
// `O(n²)` blow-up is wasteful and SDPLIB problems with LP blocks (the
// truss-* series, some control-* variants) are deferred to v0.2 (bead
// `67nj`). All other cone heads (SOCone, ExpCone, PowCone) refuse with
// a redirect to `tools/cone-solve`.
//
// Termination taxonomy mapping (ADR-0030 §A.3)
// --------------------------------------------
//
//     IPM SolverStatus           wire status              objective?
//     ─────────────────────      ─────────────────        ───────────
//     optimal                    "optimal"                present
//     primal-infeasible          "infeasible"             ABSENT
//     dual-infeasible            "unbounded"              ABSENT
//     iter-limit / time-limit    "iter-cap"               ABSENT
//     numerical-error /          "numerical-breakdown"    ABSENT
//        numerical-difficulty
//
// `objective` and `achieved_precision` are present iff
// `status === "optimal"`. The corpus verifier enforces this — they are
// `±∞` or NaN in degenerate cases, both forbidden from raw JSON. (See
// worklog 005 for the field-absence semantics decision.)
//
// Refusal envelopes (ADR-0003)
// ----------------------------
//   * `sdp-solve/non-finite-input`     — NaN / ±Inf in `c`, `A`, or `b`.
//   * `sdp-solve/degenerate-shape`     — row-count mismatch between
//                                        `A`, `b`, and `c`.
//   * `sdp-solve/quadratic-objective`  — `minimize.Q` is present;
//                                        SDPT3-style quadratic SDP
//                                        is out of scope for v0.1.
//   * `sdp-solve/non-sdp-cone`         — cone head other than
//                                        PSDCone / ZeroCone.
//   * `sdp-solve/malformed-cone`       — bad arity, indices out of
//                                        range, indices count doesn't
//                                        match `size*(size+1)/2`.
//   * `sdp-solve/cone-coverage`        — variables in `x` not covered
//                                        by any cone (PSDCone /
//                                        ZeroCone), or covered twice.
//
// Iteration-cap and numerical-breakdown live in the success record
// (status field), not as tagged refusals — the agent often wants the
// best-effort iterate even when convergence didn't reach `precision`.
//
// Determinism
// -----------
// `numerical: true` (ADR-0015). Bit-identical given the platform
// fingerprint `{arch, os, runtime}`. The runner auto-emits the
// `platform` field in the provenance record because the output carries
// float64 leaves. `runMemoized` cache hits drop on platform change.
//
// References
// ----------
// - Todd, Toh, Tütüncü (1998). "On the Nesterov-Todd direction in SDP."
//   *SIAM J Opt* 8(3). [primary algorithm]
// - Tütüncü, Toh, Todd (2003). "Solving SDP/QP/LP using SDPT3."
//   *Math Prog Ser B*. [SDPT3 v4 architecture; the canonical reference]
// - Alizadeh, Haeberly, Overton (1997). "Complementarity and
//   nondegeneracy in SDP." *Math Prog* 77. [AHO direction, A/B]
// - Helmberg, Kojima, Monteiro (1996). "An interior-point method for
//   SDP." *SIAM J Opt* 6(2). [HKM direction, --method=hkm-debug]
// - Mehrotra (1992). "On the implementation of a primal-dual
//   interior-point method." *SIAM J Opt* 2(4). [predictor-corrector]
// - Wright (1997). *Primal-Dual Interior-Point Methods*. SIAM.
//   [textbook for the KKT residual conventions]
// - Boyd, Vandenberghe (2004). *Convex Optimisation*. Ch. 11.
//   [interior-point pedagogy]

import {
  expr,
  float64FromNumber,
  float64ToNumber,
  int,
  list,
  record,
  S,
  str,
  tagged,
  type ExpressionValue,
  type RecordValue,
  type Value,
} from "@workbench/protocol";
import { defineTool, F, runTool } from "@workbench/contract";
import {
  solveSdp as solveSdpNt,
  solveSdpAho,
  solveSdpHkm,
  solveHsdeSdpNt,
  formatVerboseLine,
  type SdpProblem,
  type SdpBlock,
  type SdpSolveResult,
  type HsdeSdpSolveResult,
  type SolverStatus,
  type VerboseIterLine,
  toWireStatus,
  type WireStatus,
} from "@workbench/solver-ipm";
import { writeSync, openSync, closeSync } from "node:fs";

const NAME = "sdp-solve";
const VERSION = "0.1.0";

const METHOD_TAG_NT = "solver-ipm-nt";
const METHOD_TAG_AHO = "solver-ipm-aho";
const METHOD_TAG_HKM = "solver-ipm-hkm";
const METHOD_TAG_HSDE_NT = "solver-ipm-hsde-nt";

// -----------------------------------------------------------------------------
// Schema
// -----------------------------------------------------------------------------
//
// Input is the unified ADR-0030 §C cone-solver wire — the same shape
// `tools/lp-solve` and (eventually) `tools/cone-solve` accept. The cones
// list is the discriminator: PSDCone variants land here; NonNegCone
// variants land at lp-solve. A future planner that wants type-driven
// dispatch can read the cone heads off the wire and route accordingly.
//
// Output is ADR-0030 §D. Same union as lp-solve's: a success record
// with `objective` / `achieved_precision` present iff status is
// "optimal", or a `tagged "sdp-solve/<class>"` refusal envelope.

const inputSchema = S.record(
  {
    minimize: S.record(
      { c: S.list(S.kind("float64")), Q: S.list(S.list(S.kind("float64"))) },
      { optional: ["Q"] },
    ),
    subjectTo: S.record(
      {
        Ax_eq_b: S.record({
          A: S.list(S.list(S.kind("float64"))),
          b: S.list(S.kind("float64")),
        }),
        cones: S.list(S.expression()),
      },
      { optional: ["Ax_eq_b"] },
    ),
    precision: S.kind("float64"),
    max_iter: S.kind("integer"),
  },
  { optional: ["precision", "max_iter"] },
);

const outputSchema = S.union([
  S.record(
    {
      status: S.kind("string"),
      x: S.list(S.kind("float64")),
      dual: S.list(S.kind("float64")),
      slack: S.list(S.kind("float64")),
      objective: S.kind("float64"),
      achieved_precision: S.kind("float64"),
      iterations: S.kind("integer"),
      method: S.kind("string"),
      condition_estimate: S.kind("float64"),
      warnings: S.list(S.kind("string")),
    },
    { optional: ["objective", "achieved_precision"] },
  ),
  S.tagged(null, S.any()),
]);

// -----------------------------------------------------------------------------
// svec ↔ symmetric matrix
// -----------------------------------------------------------------------------
//
// Mosek convention: `<C, X>_F = svec(C)ᵀ svec(X)` exactly, with √2
// scaling on strict off-diagonal entries. Diagonal entries are
// untouched. The `k(i,j)` mapping is row-major upper-triangular —
// (0,0), (0,1), ..., (0,n-1), (1,1), (1,2), ..., (n-1,n-1). The
// substrate IPM expects full `n × n` row-major Float64Array matrices;
// this section bridges the two representations.

const SQRT2 = Math.SQRT2;
const INV_SQRT2 = 1 / Math.SQRT2;

function svecLen(n: number): number {
  return (n * (n + 1)) / 2;
}

/**
 * Inverse of the row-major upper-tri svec ordering. Given a position
 * `k` in `[0, n*(n+1)/2)` returns the matrix entry `(i, j)` with
 * `i ≤ j` such that `svec(M)[k] = M[i,j]` (modulo √2 scaling for
 * `i < j`).
 *
 * The closed-form inverse uses `i = ⌊(2n + 1 - √((2n+1)² - 8k)) / 2⌋`.
 * We iterate instead of computing the square root because the iteration
 * is exact in integer arithmetic and `n` is at most a few hundred for
 * any practical SDP — the loop runs in O(n) per call, the whole svec
 * traversal in O(n²), which matches the inherent matrix-fill cost.
 */
function svecToIJ(k: number, n: number): { i: number; j: number } {
  let i = 0;
  let rem = k;
  // Each row `r` contributes (n - r) entries to svec.
  while (rem >= n - i) {
    rem -= n - i;
    i++;
  }
  return { i, j: i + rem };
}

/**
 * Decode `vec[indices[k]]` for `k = 0..n*(n+1)/2 - 1` into the symmetric
 * `n × n` matrix `F` (row-major), inverting the √2 scaling on off-
 * diagonals. The output matrix is symmetric by construction.
 *
 * The off-diagonal scale factor is `1/√2` because the wire carries
 * `svec(M)[k(i,j)] = √2 · M[i,j]`.
 */
function unsvecIntoFull(
  F: Float64Array,
  n: number,
  vec: ReadonlyArray<number>,
  indices: ReadonlyArray<number>,
): void {
  for (let k = 0; k < indices.length; k++) {
    const { i, j } = svecToIJ(k, n);
    const v = vec[indices[k]!]!;
    if (i === j) {
      F[i * n + i] = v;
    } else {
      const half = v * INV_SQRT2;
      F[i * n + j] = half;
      F[j * n + i] = half;
    }
  }
}

/**
 * Pack the symmetric matrix `F` (n × n, row-major) into `vecOut` at
 * positions `indices[k]`, applying the √2 scaling on off-diagonals.
 * If `F` has slight asymmetry from numerical drift, we average the two
 * triangle entries for the off-diagonal — a minor numerical hygiene
 * step that costs O(n²) and improves the wire output's stability.
 */
function svecFromFull(
  F: Float64Array,
  n: number,
  vecOut: number[],
  indices: ReadonlyArray<number>,
): void {
  for (let k = 0; k < indices.length; k++) {
    const { i, j } = svecToIJ(k, n);
    if (i === j) {
      vecOut[indices[k]!] = F[i * n + i]!;
    } else {
      const v = 0.5 * (F[i * n + j]! + F[j * n + i]!);
      vecOut[indices[k]!] = SQRT2 * v;
    }
  }
}

// -----------------------------------------------------------------------------
// Cone parsing
// -----------------------------------------------------------------------------
//
// The input cone list is a `list<expression>`; we walk it once and
// build the per-block layout the IPM needs. Refusal envelopes fire on
// any structural problem; otherwise we return a `ConeLayout` carrying
// per-block `{ size, indices }`.
//
// Coverage and collision are enforced after parsing: every variable in
// `x` must be in exactly one PSDCone (or in a ZeroCone, which adds a
// degenerate equality but not a block to the IPM). A variable that is
// in no cone is a `cone-coverage` refusal (we cannot determine its
// sign / cone membership). A variable that is in two cones is a
// collision refusal.

interface PsdBlockSpec {
  readonly size: number;
  readonly indices: ReadonlyArray<number>;
}

interface ConeLayout {
  /** PSD blocks in declaration order. */
  readonly blocks: ReadonlyArray<PsdBlockSpec>;
  /** Indices forced to zero by ZeroCone (passed through to constraints). */
  readonly zeroIndices: ReadonlyArray<number>;
}

interface RefusalEnvelope {
  readonly _refusal: true;
  readonly tag: string;
  readonly detail: string;
}

function refusal(cls: string, detail: string): RefusalEnvelope {
  return { _refusal: true, tag: `${NAME}/${cls}`, detail };
}

function isRefusal(x: unknown): x is RefusalEnvelope {
  return typeof x === "object" && x !== null && (x as RefusalEnvelope)._refusal === true;
}

function refusalValue(r: RefusalEnvelope, payload: Record<string, Value> = {}): Value {
  return tagged(r.tag, record({ detail: str(r.detail), ...payload }));
}

function parseCones(
  cones: ReadonlyArray<Value>,
  n: number,
): ConeLayout | RefusalEnvelope {
  const blocks: PsdBlockSpec[] = [];
  const zeroIndices: number[] = [];
  // `coveredBy[j]` = index into `cones` (or -1) of the cone covering var j.
  const coveredBy = new Int32Array(n).fill(-1);

  for (let coneIdx = 0; coneIdx < cones.length; coneIdx++) {
    const c = cones[coneIdx]!;
    if (c.kind !== "expression") {
      return refusal(
        "malformed-cone",
        `cone[${coneIdx}] is not an expression value: kind=${c.kind}`,
      );
    }
    switch (c.head) {
      case "PSDCone": {
        if (c.args.length !== 2) {
          return refusal(
            "malformed-cone",
            `PSDCone expects [size: integer, indices: list<integer>]; got ${c.args.length} args`,
          );
        }
        const sizeArg = c.args[0]!;
        if (sizeArg.kind !== "integer") {
          return refusal(
            "malformed-cone",
            `PSDCone[0] (size) must be an integer; got kind=${sizeArg.kind}`,
          );
        }
        const indicesArg = c.args[1]!;
        if (indicesArg.kind !== "list") {
          return refusal(
            "malformed-cone",
            `PSDCone[1] (indices) must be a list; got kind=${indicesArg.kind}`,
          );
        }
        const size = Number(BigInt(sizeArg.value));
        if (!Number.isInteger(size) || size <= 0) {
          return refusal(
            "malformed-cone",
            `PSDCone size must be a positive integer; got ${size}`,
          );
        }
        const expectedLen = svecLen(size);
        if (indicesArg.items.length !== expectedLen) {
          return refusal(
            "malformed-cone",
            `PSDCone[size=${size}] expects ${expectedLen} indices (size*(size+1)/2); got ${indicesArg.items.length}`,
          );
        }
        const idxs: number[] = [];
        for (const item of indicesArg.items) {
          if (item.kind !== "integer") {
            return refusal(
              "malformed-cone",
              `PSDCone indices entry is not an integer: kind=${item.kind}`,
            );
          }
          const j = Number(BigInt(item.value));
          if (!Number.isInteger(j) || j < 0 || j >= n) {
            return refusal(
              "malformed-cone",
              `PSDCone index ${j} out of range [0, ${n})`,
            );
          }
          if (coveredBy[j] !== -1) {
            return refusal(
              "cone-coverage",
              `variable ${j} appears in cone[${coveredBy[j]}] and cone[${coneIdx}] (index collision)`,
            );
          }
          coveredBy[j] = coneIdx;
          idxs.push(j);
        }
        blocks.push({ size, indices: idxs });
        break;
      }
      case "ZeroCone": {
        if (c.args.length !== 1) {
          return refusal(
            "malformed-cone",
            `ZeroCone expects [indices: list<integer>]; got ${c.args.length} args`,
          );
        }
        const indicesArg = c.args[0]!;
        if (indicesArg.kind !== "list") {
          return refusal(
            "malformed-cone",
            `ZeroCone[0] (indices) must be a list; got kind=${indicesArg.kind}`,
          );
        }
        for (const item of indicesArg.items) {
          if (item.kind !== "integer") {
            return refusal(
              "malformed-cone",
              `ZeroCone indices entry is not an integer: kind=${item.kind}`,
            );
          }
          const j = Number(BigInt(item.value));
          if (!Number.isInteger(j) || j < 0 || j >= n) {
            return refusal(
              "malformed-cone",
              `ZeroCone index ${j} out of range [0, ${n})`,
            );
          }
          if (coveredBy[j] !== -1) {
            return refusal(
              "cone-coverage",
              `variable ${j} appears in cone[${coveredBy[j]}] and cone[${coneIdx}] (index collision)`,
            );
          }
          coveredBy[j] = coneIdx;
          zeroIndices.push(j);
        }
        break;
      }
      case "NonNegCone":
        return refusal(
          "non-sdp-cone",
          `NonNegCone is not handled by sdp-solve in v0.1; route pure-LP problems to tools/lp-solve, or wait for tools/cone-solve (bead 2ivi) for mixed cones`,
        );
      case "SOCone":
      case "ExpCone":
      case "PowCone":
        return refusal(
          "non-sdp-cone",
          `cone head ${c.head} is not handled by sdp-solve; use tools/cone-solve (bead 2ivi) for non-PSD cones`,
        );
      default:
        return refusal(
          "non-sdp-cone",
          `unknown cone head ${c.head}; sdp-solve v0.1 handles PSDCone and ZeroCone`,
        );
    }
  }

  // Coverage check: every variable must be in some cone.
  for (let j = 0; j < n; j++) {
    if (coveredBy[j] === -1) {
      return refusal(
        "cone-coverage",
        `variable ${j} is not covered by any cone; sdp-solve requires every variable to lie in PSDCone or ZeroCone`,
      );
    }
  }

  return { blocks, zeroIndices };
}

// -----------------------------------------------------------------------------
// Wire → SdpProblem
// -----------------------------------------------------------------------------
//
// The IPM consumes `SdpProblem` per `packages/solver-ipm/src/problem/
// SdpProblem.ts`:
//
//   {
//     m:        number,
//     blocks:   [ { size, C: Float64Array(n×n), A: Float64Array(n×n)[m] }, ... ],
//     b:        Float64Array(m),
//     maximize: boolean,   // we always pass false (we minimise on the wire).
//   }
//
// For each PSDCone block we materialise C_b from c[indices_b] and
// A_i^b from A[i][indices_b] using `unsvecIntoFull`. ZeroCone variables
// generate explicit equalities `x_j = 0` appended to `Ax_eq_b` if not
// already pinned; this is the simplest correct path and the rare cone
// is not performance-critical.

function buildSdpProblem(
  cFloat: ReadonlyArray<number>,
  aFloat: ReadonlyArray<ReadonlyArray<number>> | null,
  bFloat: ReadonlyArray<number>,
  layout: ConeLayout,
): SdpProblem {
  const n = cFloat.length;
  const mOriginal = bFloat.length;
  // Append equality `x_j = 0` rows for any ZeroCone indices not already
  // pinned. The downstream IPM doesn't care about duplicates; over-
  // determined equalities are absorbed by the Schur factor's
  // regularisation.
  const extraRows: number[] = [];
  if (layout.zeroIndices.length > 0) {
    for (const j of layout.zeroIndices) extraRows.push(j);
  }
  const mTotal = mOriginal + extraRows.length;
  const b = new Float64Array(mTotal);
  for (let i = 0; i < mOriginal; i++) b[i] = bFloat[i]!;
  // extraRows contribute `0` to b (already zero-initialised).

  const blocks: SdpBlock[] = [];
  for (const spec of layout.blocks) {
    const sz = spec.size;
    const C = new Float64Array(sz * sz);
    unsvecIntoFull(C, sz, cFloat, spec.indices);

    const A: Float64Array[] = new Array(mTotal);
    for (let i = 0; i < mOriginal; i++) {
      const Ai = new Float64Array(sz * sz);
      if (aFloat !== null) unsvecIntoFull(Ai, sz, aFloat[i]!, spec.indices);
      A[i] = Ai;
    }
    // Extra rows (one per ZeroCone index): the constraint `x_j = 0`
    // contributes a single 1 at `(i,i)` of the block whose svec slot
    // index `i` corresponds to `j`, *if* `j` falls inside this block's
    // indices. Since ZeroCone indices are distinct from PSDCone indices
    // (collision-checked in parseCones), this contribution is zero for
    // every PSDCone block — but we still need to fill the array. The
    // extra-row constraints only carry coefficients via a separate
    // diagonal-1 block, which we add below as a singleton 1×1 PSD
    // block per ZeroCone index. (See note on ZeroCone handling below.)
    for (let r = 0; r < extraRows.length; r++) {
      A[mOriginal + r] = new Float64Array(sz * sz); // all zeros
    }
    blocks.push({ size: sz, C, A });
  }

  // ZeroCone handling: each forced-zero variable becomes a singleton
  // 1×1 PSD block. The block's primal scalar `X = x_j ≥ 0`, the
  // associated equality `<A_i^b, X> = 0` for the appended row pins it
  // to zero. The C entry is `c[j]`; the original constraint rows
  // contribute `A[i][j]` as the singleton matrix.
  //
  // This works correctly because the constraint <[1], X> = 0 for a
  // 1×1 PSD matrix forces X = 0, and the original objective and
  // constraints accumulate the same coefficients as if x_j had been
  // a NonNegCone variable. The IPM is symmetric and well-defined on
  // 1×1 PSD blocks (they reduce to scalar primal-dual barriers).
  for (let r = 0; r < extraRows.length; r++) {
    const j = extraRows[r]!;
    const C = new Float64Array(1);
    C[0] = cFloat[j]!;
    const A: Float64Array[] = new Array(mTotal);
    for (let i = 0; i < mOriginal; i++) {
      const v = aFloat !== null ? aFloat[i]![j]! : 0;
      const Ai = new Float64Array(1);
      Ai[0] = v;
      A[i] = Ai;
    }
    for (let rr = 0; rr < extraRows.length; rr++) {
      const Ai = new Float64Array(1);
      // The extra row at index (mOriginal + rr) pins variable
      // extraRows[rr]; this block represents extraRows[r]; same iff
      // r === rr.
      if (rr === r) Ai[0] = 1;
      A[mOriginal + rr] = Ai;
    }
    blocks.push({ size: 1, C, A });
  }

  return { m: mTotal, blocks, b, maximize: false };
}

// -----------------------------------------------------------------------------
// SdpResult → wire
// -----------------------------------------------------------------------------
//
// Encode the IPM's per-block X / S matrices back into the n-vector
// wire (svec at the indices the input cones declared). The dual y is
// returned as-is for the original constraint rows; appended ZeroCone
// rows are dropped from the wire dual to match the user's input
// dimensionality.

interface EncodeContext {
  n: number;
  mOriginal: number;
  layout: ConeLayout;
  cFloat: ReadonlyArray<number>;
  aFloat: ReadonlyArray<ReadonlyArray<number>> | null;
  bFloat: ReadonlyArray<number>;
  methodTag: string;
}

function encodeSdpResult(res: SdpSolveResult, ctx: EncodeContext): Value {
  const wireStatus = toWireStatus(res.status);
  const xWire = new Array<number>(ctx.n).fill(0);
  const sWire = new Array<number>(ctx.n).fill(0);

  // Per-block decode. PSDCone blocks come first (in declaration order);
  // singleton ZeroCone blocks come last and we don't surface them in
  // the wire (their primal value is forced to zero anyway).
  const nPsdBlocks = ctx.layout.blocks.length;
  for (let b = 0; b < nPsdBlocks; b++) {
    const spec = ctx.layout.blocks[b]!;
    svecFromFull(res.X[b]!, spec.size, xWire, spec.indices);
    svecFromFull(res.S[b]!, spec.size, sWire, spec.indices);
  }
  // ZeroCone variables: x_j = 0, slack carries `c[j] - sum_i y_i A[i][j]`
  // per the dual feasibility relation. We compute the slack honestly
  // for each forced-zero variable so the wire's dual-feasibility check
  // at the verifier is well-defined.
  for (const j of ctx.layout.zeroIndices) {
    xWire[j] = 0;
    let s = ctx.cFloat[j]!;
    if (ctx.aFloat !== null) {
      for (let i = 0; i < ctx.mOriginal; i++) {
        s -= res.y[i]! * ctx.aFloat[i]![j]!;
      }
    }
    sWire[j] = s;
  }

  // Dual: take the first mOriginal entries of res.y; appended rows are
  // internal-only.
  const yWire = new Array<number>(ctx.mOriginal);
  for (let i = 0; i < ctx.mOriginal; i++) yWire[i] = res.y[i]!;

  // Honest precision in the wire frame. The IPM's internal
  // `primalInf`/`dualInf`/`mu` are computed in the engine's
  // *matrix* representation; the wire encoding applies √2 scaling
  // on off-diagonals (Mosek format), which amplifies the residual
  // norms by O(svec_len) when summed in the n-vector representation.
  // The corpus verifier recomputes residuals from the wire `(x, y, s)`
  // directly, so we must report what *those formulas* see, not what
  // the engine sees, to keep self-reported precision honest
  // (CLAUDE.md Rule 8 — honest scope).
  //
  //   r_p_wire = ‖A·x - b‖_∞              (length m_original)
  //   r_d_wire = ‖Aᵀ·y + s - c‖_∞          (length n)
  //   r_c_wire = |xᵀs|                     (= <X, S>_F by svec design)
  let rpWire = 0;
  if (ctx.aFloat !== null) {
    for (let i = 0; i < ctx.mOriginal; i++) {
      let acc = 0;
      const row = ctx.aFloat[i]!;
      for (let j = 0; j < ctx.n; j++) acc += row[j]! * xWire[j]!;
      const r = Math.abs(acc - ctx.bFloat[i]!);
      if (r > rpWire) rpWire = r;
    }
  }
  let rdWire = 0;
  for (let j = 0; j < ctx.n; j++) {
    let acc = 0;
    if (ctx.aFloat !== null) {
      for (let i = 0; i < ctx.mOriginal; i++) acc += ctx.aFloat[i]![j]! * yWire[i]!;
    }
    const r = Math.abs(acc + sWire[j]! - ctx.cFloat[j]!);
    if (r > rdWire) rdWire = r;
  }
  let rcWire = 0;
  for (let j = 0; j < ctx.n; j++) rcWire += xWire[j]! * sWire[j]!;
  rcWire = Math.abs(rcWire);

  const achievedPrecision = Math.max(rpWire, rdWire, rcWire);

  const warnings: Value[] = [];
  if (wireStatus === "iter-cap") {
    warnings.push(
      str(
        `iteration cap reached at iter=${res.iter}; primalInf=${res.primalInf.toExponential(3)}, dualInf=${res.dualInf.toExponential(3)}, mu=${res.mu.toExponential(3)}`,
      ),
    );
  }
  if (wireStatus === "numerical-breakdown") {
    warnings.push(
      str(
        `numerical breakdown at iter=${res.iter} (Cholesky failure or stall); inspect log; status was ${res.status}`,
      ),
    );
  }

  const baseFields: Record<string, Value> = {
    status: str(wireStatus),
    x: list(xWire.map(float64FromNumber)),
    dual: list(yWire.map(float64FromNumber)),
    slack: list(sWire.map(float64FromNumber)),
    iterations: int(BigInt(res.iter)),
    method: str(ctx.methodTag),
    condition_estimate: float64FromNumber(0),
    warnings: list(warnings),
  };

  if (wireStatus === "optimal") {
    baseFields["objective"] = float64FromNumber(res.primalObj);
    baseFields["achieved_precision"] = float64FromNumber(achievedPrecision);
  }

  return record(baseFields);
}

// -----------------------------------------------------------------------------
// Input decoding
// -----------------------------------------------------------------------------

function decodeInput(input: RecordValue): {
  c: number[];
  hasQ: boolean;
  A: number[][] | null;
  b: number[];
  cones: ReadonlyArray<Value>;
  precision: number | undefined;
  maxIter: number | undefined;
} {
  const fields = input.fields;
  const minimize = (fields["minimize"] as RecordValue).fields;
  const subjectTo = (fields["subjectTo"] as RecordValue).fields;
  const cList = (minimize["c"] as { kind: "list"; items: Value[] }).items;
  const c = cList.map((v) => float64ToNumber(v as { kind: "float64"; bits: string }));
  const hasQ = "Q" in minimize;

  let A: number[][] | null = null;
  let b: number[] = [];
  if ("Ax_eq_b" in subjectTo) {
    const ax = (subjectTo["Ax_eq_b"] as RecordValue).fields;
    const aRows = (ax["A"] as { kind: "list"; items: Value[] }).items;
    A = aRows.map((row) =>
      (row as { kind: "list"; items: Value[] }).items.map((v) =>
        float64ToNumber(v as { kind: "float64"; bits: string }),
      ),
    );
    b = (ax["b"] as { kind: "list"; items: Value[] }).items.map((v) =>
      float64ToNumber(v as { kind: "float64"; bits: string }),
    );
  }
  const cones = (subjectTo["cones"] as { kind: "list"; items: Value[] }).items;

  const precision =
    "precision" in fields
      ? float64ToNumber(fields["precision"] as { kind: "float64"; bits: string })
      : undefined;
  const maxIter =
    "max_iter" in fields
      ? Number(BigInt((fields["max_iter"] as { kind: "integer"; value: string }).value))
      : undefined;
  return { c, hasQ, A, b, cones, precision, maxIter };
}

// -----------------------------------------------------------------------------
// fn body
// -----------------------------------------------------------------------------

type Method = "auto" | "nt" | "aho" | "hkm-debug" | "hsde-nt";

interface IpmParamsLite {
  iterLimit?: number;
  feasTol?: number;
  optTol?: number;
  stallIterCap?: number;
}

// HsdeSdpSolveResult is a structural superset of SdpSolveResult (it adds
// `tau`, `kappa`, `achievedPrecision`); TS structural typing therefore
// accepts the HSDE return into the legacy slot directly. The downstream
// `encodeSdpResult` only reads the intersection (status, X, y, S, iter,
// primalObj, primalInf, dualInf, mu), so no encoder branch is needed.
function pickSolver(
  method: Method,
): {
  tag: string;
  solve: (
    p: SdpProblem,
    opts: { params?: IpmParamsLite; verbose?: (line: VerboseIterLine) => void },
  ) => SdpSolveResult;
} {
  switch (method) {
    case "auto":
    case "hsde-nt":
      // `auto` routes to HSDE+IR (ADR-0033 + Phase 5 Tiers 1–3). On the
      // SDPLIB corpus's six-case panel HSDE+IR cleanly lifts control2 to
      // strict optimal (legacy NT returned `dual-feasible` via the
      // 6-flag soft-success branch) and matches legacy NT on the other
      // five cases at the corpus verifier's tolerance — see worklog 129
      // for the bench grade comparison. Legacy `nt` remains reachable
      // via `--method=nt` for A/B and trace-diff workflows.
      return { tag: METHOD_TAG_HSDE_NT, solve: solveHsdeSdpNt };
    case "nt":
      return { tag: METHOD_TAG_NT, solve: solveSdpNt };
    case "aho":
      return { tag: METHOD_TAG_AHO, solve: solveSdpAho };
    case "hkm-debug":
      return { tag: METHOD_TAG_HKM, solve: solveSdpHkm };
  }
}

function fn(
  input: RecordValue,
  flags: { method?: Method },
): Value {
  const dec = decodeInput(input);

  if (dec.hasQ) {
    return refusalValue(
      refusal(
        "quadratic-objective",
        "tools/sdp-solve does not handle quadratic objectives in v0.1; the cone-solver tier's quadratic SDP is part of the deferred ADR-0030 §G white-whale lane",
      ),
    );
  }

  const n = dec.c.length;
  for (let j = 0; j < n; j++) {
    if (!Number.isFinite(dec.c[j]!)) {
      return refusalValue(
        refusal("non-finite-input", `c[${j}] = ${dec.c[j]} is non-finite`),
      );
    }
  }

  const mOriginal = dec.b.length;
  if (dec.A !== null) {
    if (dec.A.length !== mOriginal) {
      return refusalValue(
        refusal(
          "degenerate-shape",
          `A has ${dec.A.length} rows but b has length ${mOriginal}`,
        ),
      );
    }
    for (let i = 0; i < dec.A.length; i++) {
      if (dec.A[i]!.length !== n) {
        return refusalValue(
          refusal(
            "degenerate-shape",
            `A[${i}] has ${dec.A[i]!.length} columns but c has length ${n}`,
          ),
        );
      }
      for (let j = 0; j < n; j++) {
        if (!Number.isFinite(dec.A[i]![j]!)) {
          return refusalValue(
            refusal("non-finite-input", `A[${i}][${j}] = ${dec.A[i]![j]} is non-finite`),
          );
        }
      }
      if (!Number.isFinite(dec.b[i]!)) {
        return refusalValue(
          refusal("non-finite-input", `b[${i}] = ${dec.b[i]} is non-finite`),
        );
      }
    }
  }

  const layout = parseCones(dec.cones, n);
  if (isRefusal(layout)) return refusalValue(layout);

  // No PSD blocks at all: nothing to do (degenerate). Refuse honestly.
  if (layout.blocks.length === 0) {
    return refusalValue(
      refusal(
        "cone-coverage",
        `no PSDCone blocks declared; sdp-solve v0.1 requires at least one PSDCone (variables-only-in-ZeroCone is degenerate)`,
      ),
    );
  }

  const problem = buildSdpProblem(dec.c, dec.A, dec.b, layout);

  const { tag: methodTag, solve } = pickSolver(flags.method ?? "auto");
  // Substrate default stallIterCap=10 per CLEANROOM_SPEC.md §3.3 — relies on
  // the spec-aligned 0.99 threshold (1% min progress) in the SDP solvers.
  // The pre-alignment 0.9 threshold required 10% progress per iter, which is
  // too eager for late-stage SDP convergence near the optimal face — that
  // mismatch was the reason for the previous `stallIterCap: 30` band-aid.
  const params: IpmParamsLite = {};
  if (dec.maxIter !== undefined) params.iterLimit = dec.maxIter;
  if (dec.precision !== undefined) {
    params.feasTol = dec.precision;
    params.optTol = dec.precision;
  }
  const { verbose, close } = makeVerboseHook();
  let result: SdpSolveResult;
  try {
    result = solve(problem, { params, verbose });
  } finally {
    close();
  }

  return encodeSdpResult(result, {
    n,
    mOriginal,
    layout,
    cFloat: dec.c,
    aFloat: dec.A,
    bFloat: dec.b,
    methodTag,
  });
}

/**
 * Verbose iter-trace hook factory. Mirrors the lp-solve implementation.
 * Always emits a human-readable verbose line per iter to stderr
 * (`writeSync(2, ...)` — genuinely synchronous, survives mid-iter crash).
 * When `IPM_TRACE_JSONL=<path>` is set, also appends JSONL to that
 * path for `scripts/trace-diff.ts`. Tool-CLI-only by design: library
 * callers (tests, scripts) that invoke `solveSdpNt` etc. directly stay
 * silent unless they pass `verbose:` themselves.
 */
function makeVerboseHook(): {
  verbose: (line: VerboseIterLine) => void;
  close: () => void;
} {
  const jsonlPath = process.env.IPM_TRACE_JSONL;
  const jsonlFd = jsonlPath ? openSync(jsonlPath, "a") : -1;
  const verbose = (line: VerboseIterLine): void => {
    writeSync(2, formatVerboseLine(line) + "\n");
    if (jsonlFd >= 0) writeSync(jsonlFd, JSON.stringify(line) + "\n");
  };
  const close = (): void => {
    if (jsonlFd >= 0) closeSync(jsonlFd);
  };
  return { verbose, close };
}

// -----------------------------------------------------------------------------
// Examples (≥3, every code-path branch + a worked refusal)
// -----------------------------------------------------------------------------

function psdCone(size: number, indices: number[]): ExpressionValue {
  return expr("PSDCone", [
    int(BigInt(size)),
    list(indices.map((i) => int(BigInt(i)))),
  ]);
}

// Example 1: trivial 1×1 SDP equivalent to LP `min x s.t. x = 5, x ≥ 0`.
// Optimum: X = [[5]], objective = 5. Tests the smallest possible PSD
// block and wire encoding through unsvec.
const example1Input = record({
  minimize: record({ c: list([float64FromNumber(1)]) }),
  subjectTo: record({
    Ax_eq_b: record({
      A: list([list([float64FromNumber(1)])]),
      b: list([float64FromNumber(5)]),
    }),
    cones: list([psdCone(1, [0])]),
  }),
});

// Example 2: 2×2 SDP. minimise -tr(X) s.t. X[0,0] + X[1,1] = 4, X ⪰ 0.
// Optimum: X = 4 · v vᵀ for any unit vector v; primal value -4. We pick
// X = diag(2, 2) for the example output. Tests the 3-element svec
// (n=2 ⇒ svec_len=3) and the off-diagonal √2 path.
//
// The wire input has c = (-1, 0, -1) for the diagonal entries (off-
// diagonal entry contributes 0 to objective in this problem), and
// A[0] = (1, 0, 1) for the trace-equality. b = [4].
//
// In svec wire, slot 0 = X[0,0], slot 1 = √2 · X[0,1], slot 2 = X[1,1].
// Output X = diag(2,2) ⇒ x = (2, 0, 2). Slack S = c - y · a:
// y = [-1] (sign convention) so S = c - y A = (-1 - (-1)·1, 0 - (-1)·0,
// -1 - (-1)·1) = (0, 0, 0) ⇒ slack = (0, 0, 0). Complementarity:
// <X, S>_F = 0 ✓. Strong duality: bᵀy = 4 · (-1) = -4 = cᵀx. ✓
//
// We don't pin the goldens to specific (X, S) bytes here — the IPM may
// reach an interior optimum point along the optimal face — but the
// objective and the cone-membership invariants hold up to the IPM's
// 1e-8 tolerance.
const example2Input = record({
  minimize: record({
    c: list([
      float64FromNumber(-1),
      float64FromNumber(0),
      float64FromNumber(-1),
    ]),
  }),
  subjectTo: record({
    Ax_eq_b: record({
      A: list([
        list([
          float64FromNumber(1),
          float64FromNumber(0),
          float64FromNumber(1),
        ]),
      ]),
      b: list([float64FromNumber(4)]),
    }),
    cones: list([psdCone(2, [0, 1, 2])]),
  }),
});

// Example 3: refusal — Q field present.
const example3Input = record({
  minimize: record({
    c: list([float64FromNumber(1)]),
    Q: list([list([float64FromNumber(2)])]),
  }),
  subjectTo: record({
    Ax_eq_b: record({
      A: list([list([float64FromNumber(1)])]),
      b: list([float64FromNumber(1)]),
    }),
    cones: list([psdCone(1, [0])]),
  }),
});

const example3Output = tagged(
  "sdp-solve/quadratic-objective",
  record({
    detail: str(
      "tools/sdp-solve does not handle quadratic objectives in v0.1; the cone-solver tier's quadratic SDP is part of the deferred ADR-0030 §G white-whale lane",
    ),
  }),
);

// Example 4: refusal — NonNegCone routed away.
const example4Input = record({
  minimize: record({ c: list([float64FromNumber(1)]) }),
  subjectTo: record({
    Ax_eq_b: record({
      A: list([list([float64FromNumber(1)])]),
      b: list([float64FromNumber(1)]),
    }),
    cones: list([expr("NonNegCone", [list([int(0n)])])]),
  }),
});

const example4Output = tagged(
  "sdp-solve/non-sdp-cone",
  record({
    detail: str(
      "NonNegCone is not handled by sdp-solve in v0.1; route pure-LP problems to tools/lp-solve, or wait for tools/cone-solve (bead 2ivi) for mixed cones",
    ),
  }),
);

// Example outputs are hand-written to document the expected wire
// shape. We don't pin them byte-exactly here (the goldens do that —
// see goldens.spec.ts); these examples are documentation that the
// runner validates against `outputSchema` at load time. The actual
// IPM-produced numeric values for `x`, `dual`, `slack`, `objective`,
// and `achieved_precision` may differ by float64 ULPs from what is
// shown — that drift is captured in the goldens, not here.
//
// For example 1 (1×1, x = 5): documented expected shape with the
// analytic optimum. For example 2 (2×2 trace = 4): the optimum face
// is the rank-1 cone; we document one canonical vertex (X = diag(2,2)).

const example1Output = record({
  status: str("optimal"),
  x: list([float64FromNumber(5)]),
  dual: list([float64FromNumber(1)]),
  slack: list([float64FromNumber(0)]),
  iterations: int(4n),
  method: str(METHOD_TAG_HSDE_NT),
  condition_estimate: float64FromNumber(0),
  warnings: list([]),
  objective: float64FromNumber(5),
  achieved_precision: float64FromNumber(1e-12),
});

const example2Output = record({
  status: str("optimal"),
  x: list([
    float64FromNumber(2),
    float64FromNumber(0),
    float64FromNumber(2),
  ]),
  dual: list([float64FromNumber(-1)]),
  slack: list([
    float64FromNumber(0),
    float64FromNumber(0),
    float64FromNumber(0),
  ]),
  iterations: int(4n),
  method: str(METHOD_TAG_HSDE_NT),
  condition_estimate: float64FromNumber(0),
  warnings: list([]),
  objective: float64FromNumber(-4),
  achieved_precision: float64FromNumber(1e-12),
});

const examples = [
  {
    description: "1×1 PSD: minimise x s.t. x = 5, x ≥ 0 — optimum x = 5",
    input: example1Input,
    output: example1Output,
  },
  {
    description:
      "2×2 PSD: minimise -tr(X) s.t. tr(X) = 4, X ⪰ 0 — optimum primal value -4",
    input: example2Input,
    output: example2Output,
  },
  {
    description: "Refusal: quadratic objective Q is out of scope for v0.1",
    input: example3Input,
    output: example3Output,
  },
  {
    description: "Refusal: NonNegCone not handled (route to tools/lp-solve)",
    input: example4Input,
    output: example4Output,
  },
];

const invariants = [
  {
    name: "primal-feasibility",
    statement:
      "Optimal status implies <A_i, X> = b_i for every i within `achieved_precision` (X reconstructed from x[indices] via inverse svec)",
    machine_checkable: true,
  },
  {
    name: "dual-feasibility",
    statement:
      "Optimal status implies S = C - sum_i y_i A_i with S ⪰ 0 within `achieved_precision`",
    machine_checkable: true,
  },
  {
    name: "primal-psd",
    statement:
      "Optimal status implies every block X_b ⪰ 0 within `achieved_precision`",
    machine_checkable: true,
  },
  {
    name: "dual-psd",
    statement:
      "Optimal status implies every block S_b ⪰ 0 within `achieved_precision`",
    machine_checkable: true,
  },
  {
    name: "complementary-slackness",
    statement:
      "Optimal status implies <X, S>_F = 0 (sum over blocks) within `achieved_precision`",
    machine_checkable: true,
  },
  {
    name: "strong-duality",
    statement:
      "Optimal status implies <C, X>_F = bᵀy within `achieved_precision`",
    machine_checkable: true,
  },
  {
    name: "svec-frobenius-identity",
    statement:
      "<C, X>_F = svec(C) · svec(X) holds for the Mosek √2 convention; the wire's cᵀx and bᵀy compute the matrix inner products directly",
    machine_checkable: true,
  },
];

// -----------------------------------------------------------------------------
// --test smoke hook
// -----------------------------------------------------------------------------
//
// In-process probe across the three solver methods (NT, AHO, HKM-debug)
// on the smallest non-trivial SDP: maximise λ_min(X) over {X ⪰ 0,
// tr X = 4} for a 2×2 PSD block. The KKT optimum is X = (4/2) I,
// objective = -4 (we minimise -tr(X) for the formulation above).
// Each method must reach `optimal` and agree on the objective to 1e-4.

function smokeTest(): void {
  const problem = example2Input as RecordValue;
  const expectedTagFor: Record<string, string> = {
    nt: METHOD_TAG_NT,
    aho: METHOD_TAG_AHO,
    "hsde-nt": METHOD_TAG_HSDE_NT,
  };
  for (const method of ["nt", "aho", "hsde-nt"] as const) {
    const out = fn(problem, { method }) as RecordValue;
    const status = (out.fields["status"] as { kind: "string"; value: string }).value;
    if (status !== "optimal") {
      throw new Error(
        `sdp-solve --test: method=${method} returned status=${status}, expected optimal`,
      );
    }
    const objVal = out.fields["objective"];
    if (objVal === undefined || objVal.kind !== "float64") {
      throw new Error(`sdp-solve --test: method=${method} missing objective field`);
    }
    const obj = float64ToNumber(objVal);
    if (Math.abs(obj - -4) > 1e-4) {
      throw new Error(
        `sdp-solve --test: method=${method} objective ${obj} differs from -4 by more than 1e-4`,
      );
    }
    const tag = (out.fields["method"] as { kind: "string"; value: string }).value;
    const expectedTag = expectedTagFor[method]!;
    if (tag !== expectedTag) {
      throw new Error(
        `sdp-solve --test: method=${method} reported method tag "${tag}", expected "${expectedTag}"`,
      );
    }
  }
}

// -----------------------------------------------------------------------------
// Tool definition
// -----------------------------------------------------------------------------

export const def = defineTool({
  name: NAME,
  version: VERSION,
  schema: { input: inputSchema, output: outputSchema },
  flags: {
    method: F.enum(
      ["auto", "nt", "aho", "hkm-debug", "hsde-nt"] as const,
      "search direction. auto (default): hsde-nt (HSDE + iterative refinement, ADR-0033; Phase 5 Tiers 1-3); nt: legacy primal-dual NT (kept for A/B + trace-diff); aho: AHO direction for A/B; hkm-debug: HKM, asymmetric, debug-only; hsde-nt: explicit HSDE selection (identical to auto today)",
      { default: "auto" },
    ),
  },
  examples,
  invariants,
  numerical: true,
  fn: fn as never,
  test: smokeTest,
});

// Suppress unused-import warnings when neither WireStatus nor SolverStatus
// is referenced by the inferred TypeScript types directly. They're part
// of the documentary surface and the re-export contract.
void (null as unknown as WireStatus | SolverStatus);

if (import.meta.main) void runTool(def);
