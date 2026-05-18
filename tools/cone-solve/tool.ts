// =============================================================================
// cone-solve — the universal convex-cone solver
// =============================================================================
//
// Intent
// ------
// The Phase-1 *primary* tool of the convex-cone solver tier (ADR-0030 §B):
// the symbol a TS expert types — `wb.run("cone-solve", …)` — for any
// convex cone program, without first classifying it as LP / QP / SOCP /
// SDP. One schema, one mental model, one honest status taxonomy. The LP
// and QP specialists exist for best-in-class accuracy on *known*
// structure; this tool is the universal default, the `Array.prototype.sort`
// to their `radix-sort`.
//
// The algorithm is SCS-style operator splitting on the homogeneous
// self-dual embedding (O'Donoghue-Chu-Parikh-Boyd 2016), implemented in
// `@workbench/cone-core`. This tool is the wire layer around that
// substrate: it decodes the ADR-0030 §C input record, translates the §C
// problem form into cone-core's O'Donoghue form, runs `scsSolve`,
// recovers the §C primal–dual point, and encodes the ADR-0030 §D output.
//
// Input shape (ADR-0030 §C)
// -------------------------
//   record {
//     minimize:  record { c: list<float64>, Q?: list<list<float64>> },
//     subjectTo: record {
//       Ax_eq_b?: record { A: list<list<float64>>, b: list<float64> },
//       cones:    list<expression>          // NonNegCone[idx], ZeroCone[idx], …
//     },
//     precision?: float64,                  // default 1e-8
//     max_iter?:  integer                   // default 50000 (SCS-ADMM, ADR-0037 §D)
//   }
//
// The §C problem is `minimise cᵀx s.t. A x = b, x ∈ 𝒦` — the cone
// constrains the *variable vector* `x` directly, with `A x = b` an
// equality. (This differs from cone-core's O'Donoghue form, where the
// cone constrains the *slack* and `x` is free — see the translation
// below.)
//
// Output shape (ADR-0030 §D)
// --------------------------
//   record { status, x, dual, slack, objective?, achieved_precision?,
//            iterations, method, condition_estimate, warnings }
//     — `objective` is present only when `status === "optimal"`.
//       `achieved_precision` is present on `optimal` and on `iter-cap`
//       whenever a primal–dual iterate was recoverable — it is the
//       §C-wire-form KKT residual of the *returned* point (`kktResidualC`;
//       bead `rgl8`), so `optimal` always means `achieved_precision ≤
//       precision`. That coherence is now *structural*: this tool hands
//       `scsSolve` an `SCSOpts.convergenceTest` denominated in exactly
//       that §C-wire-form residual (bead `oxuk`), so the iteration is
//       driven to the wire criterion directly — no post-hoc `optimal →
//       iter-cap` re-label. The five status classes are
//       `optimal | infeasible | unbounded | iter-cap | numerical-breakdown`.
//   | tagged "cone-solve/{non-finite-input,degenerate-shape,malformed-cone,
//                         unsupported-cone,quadratic-objective}"
//     — boundary-failure refusal envelopes for input the tool will not
//       attempt (ADR-0003: a clean tagged refusal is correct; a lie is not).
//
// v0.1 scope
// ----------
// cone-core projects five of the seven cone families (nonneg / zero /
// free / soc / psd; bead `0wc7`), but cone-solve v0.1's *wire layer*
// accepts only `NonNegCone` / `ZeroCone` / `FreeCone`: it refuses
// `SOCone` / `PSDCone` / `ExpCone` / `PowCone` with a
// `cone-solve/unsupported-cone` envelope. The SOC / PSD refusal is a
// tool-layer gap, not a substrate one — the §C wire-form translation
// for those cones (the `expression "SOCone" / "PSDCone"` heads with
// their index / size payloads onto cone-core's projectable blocks) is
// its own bead; the envelope names the cone-core sub-bead for context
// (`0wc7` SOC+PSD substrate, `j282` Exp+Pow). A quadratic objective
// (`minimize.Q`) is refused with `cone-solve/quadratic-objective` — the
// SCS substrate supports `½xᵀQx` natively in principle (ADR-0030
// open-question 3) but cone-core v0.1's `scsSolve` does not yet. Both
// refusals are honest scope, not silent wrong answers.
//
// The §C → O'Donoghue translation
// -------------------------------
// cone-core's `ConeProblem` is `minimise c'ᵀx' s.t. A'x' + s' = b',
// (x', s') ∈ ℝⁿ × 𝒦'` — `x'` *free*, the cone on the *slack*. The §C
// problem `minimise cᵀx s.t. A x = b, x ∈ 𝒦` translates as:
//
//   - keep `x' = x` (free in ℝⁿ), `c' = c`;
//   - `A x = b`  becomes  `A x' + s_eq = b`, `s_eq ∈ {0}ᵐ`  — the
//     equality block: rows `A`, rhs `b`, cone `zero(m)`;
//   - `x ∈ 𝒦`  becomes  `−x' + s_K = 0`, `s_K ∈ 𝒦`  — the cone block:
//     one row `−eⱼ` per variable index `j` the cone covers, rhs `0`,
//     cone the matching cone-core `Cone`.
//
// so `A' = [A ; S]` (S the −eⱼ selection matrix), `b' = [b ; 0]`,
// `cones' = [zero(m), …𝒦]`. The translated primal is feasible / optimal /
// infeasible / unbounded exactly when the §C problem is.
//
// Recovering the §C point from cone-core's `(x', y', s')`
// ------------------------------------------------------
// `scsSolve` returns the O'Donoghue triple for the *translated* problem.
// The §C answer comes back by:
//   - §C `x`     = `x'`                              (the variables are shared)
//   - §C `y`     = `−y'_eq`                          (negate the equality-block dual)
//   - §C `slack` = `y'_cone`, re-indexed to variable order
// This is derived from `A'ᵀy' = −c'` (the O'Donoghue dual stationarity):
// see `docs/ground-truth/convex/scs-algorithm.md` and the worklog shard.
//
// Algorithm references
// --------------------
// O'Donoghue et al 2016, *Conic Optimization via Operator Splitting and
// Homogeneous Self-Dual Embedding* (`docs/refs/odonoghue-2016-scs.pdf`),
// transcribed to `docs/ground-truth/convex/scs-algorithm.md`. The SCS
// iteration itself lives in `@workbench/cone-core`; this tool is the
// ADR-0030 §C/§D wire around it.

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
  type Value,
  type RecordValue,
} from "@workbench/protocol";
import { defineTool, F, runTool } from "@workbench/contract";
import {
  type Candidate,
  type Cone,
  type ConeProblem,
  type SCSResult,
  type AndersonSpec,
  ConeError,
  nonNeg,
  scsSolve,
  zero,
  DEFAULT_SCS_OPTS,
  DEFAULT_ANDERSON_I_SPEC,
} from "@workbench/cone-core";
import { matrixFromRows } from "@workbench/linalg-core";

const NAME = "cone-solve";
const VERSION = "0.1.0";
const METHOD_TAG = "scs";

// -----------------------------------------------------------------------------
// Accelerator selector flag (ADR-0036 §F)
// -----------------------------------------------------------------------------
//
// The `--accelerator` flag selects between the v0.1 Type-II AA (the
// classical Walker-Ni method) and the v0.2 Type-I AA-I-S-m (Zhang-
// O'Donoghue-Boyd's Powell-regularised + GS-restart + KM-safeguarded
// algorithm — ground truth file §7). Default `type-ii` so existing
// goldens stay byte-identical; the flip to `type-i` happens in a
// future ADR once the lp-netlib bench measures the win.

const ACCELERATOR_VALUES = ["type-ii", "type-i"] as const;
type AcceleratorChoice = (typeof ACCELERATOR_VALUES)[number];

// -----------------------------------------------------------------------------
// Wire schema — ADR-0030 §C input / §D output
// -----------------------------------------------------------------------------
//
// The input schema is the universal cone-tier wire shape, accepted
// verbatim (shared with `tools/lp-solve` and `tools/sdp-solve`). `cones`
// is `list<expression>` because cone heads carry index-list args of
// varying arity; cone-family scope is enforced inside `parseCones` with a
// richer `unsupported-cone` envelope than a schema rejection could give.

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
// Refusal envelopes
// -----------------------------------------------------------------------------
//
// Boundary-failure outputs are `tagged "cone-solve/<class>"` values with a
// structured `detail` payload (ADR-0003: routine-non-success would be a
// record-with-flag; a *malformed* input would be a `ToolError`; a boundary
// the tool will not cross is a tagged value). We model a refusal as a
// plain JS struct internally and only encode it at the `fn` boundary.

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

function refusalValue(r: RefusalEnvelope): Value {
  return tagged(r.tag, record({ detail: str(r.detail) }));
}

// -----------------------------------------------------------------------------
// Input decoding
// -----------------------------------------------------------------------------
//
// The runner has already validated the canonical input against
// `inputSchema`, so the *shape* (record with these fields, lists of
// float64, …) is guaranteed. What the schema cannot check — finiteness of
// the float entries, mutual dimension consistency, raggedness of `A` —
// `decodeInput` checks here and returns a `RefusalEnvelope` for, never a
// throw: a dimension mismatch is a boundary the tool declines, not a
// crash (ADR-0030 §A.3 lists `degenerate-shape` / `non-finite-input` as
// refusal envelopes).

interface DecodedInput {
  readonly c: number[];
  readonly hasQ: boolean;
  readonly hasEq: boolean;
  readonly A: number[][];
  readonly b: number[];
  readonly cones: readonly Value[];
  readonly precision: number;
  readonly maxIter: number;
}

function floatItems(v: Value): number[] {
  if (v.kind !== "list") throw new ConeError(`expected list, got ${v.kind}`);
  return v.items.map((it) => {
    if (it.kind !== "float64") throw new ConeError(`expected float64, got ${it.kind}`);
    return float64ToNumber(it);
  });
}

function decodeInput(input: RecordValue): DecodedInput | RefusalEnvelope {
  const fields = input.fields;
  const minimize = (fields["minimize"] as RecordValue).fields;
  const subjectTo = (fields["subjectTo"] as RecordValue).fields;

  const c = floatItems(minimize["c"]!);
  if (c.length === 0) {
    return refusal("degenerate-shape", "minimize.c is empty — the problem has no variables");
  }
  for (let j = 0; j < c.length; j++) {
    if (!Number.isFinite(c[j]!)) {
      return refusal("non-finite-input", `minimize.c[${j}] is not finite`);
    }
  }
  const hasQ = "Q" in minimize;

  let A: number[][] = [];
  let b: number[] = [];
  const hasEq = "Ax_eq_b" in subjectTo;
  if (hasEq) {
    const ax = (subjectTo["Ax_eq_b"] as RecordValue).fields;
    const aRows = (ax["A"] as { kind: "list"; items: Value[] }).items;
    A = aRows.map((row) => floatItems(row));
    b = floatItems(ax["b"]!);
    if (A.length !== b.length) {
      return refusal("degenerate-shape", `A has ${A.length} rows but b has ${b.length} entries`);
    }
    for (let i = 0; i < A.length; i++) {
      if (A[i]!.length !== c.length) {
        return refusal(
          "degenerate-shape",
          `A row ${i} has ${A[i]!.length} columns, expected ${c.length} (= |c|)`,
        );
      }
      for (let j = 0; j < A[i]!.length; j++) {
        if (!Number.isFinite(A[i]![j]!)) {
          return refusal("non-finite-input", `Ax_eq_b.A[${i}][${j}] is not finite`);
        }
      }
    }
    for (let i = 0; i < b.length; i++) {
      if (!Number.isFinite(b[i]!)) {
        return refusal("non-finite-input", `Ax_eq_b.b[${i}] is not finite`);
      }
    }
  }

  const cones = (subjectTo["cones"] as { kind: "list"; items: Value[] }).items;

  // `precision` and `max_iter` are optional input fields with the
  // ADR-0030 tier defaults. A non-positive precision or a sub-1 iteration
  // cap is a malformed knob → `degenerate-shape`.
  let precision = DEFAULT_SCS_OPTS.precision;
  if ("precision" in fields) {
    precision = float64ToNumber(fields["precision"] as { kind: "float64"; bits: string });
    if (!(precision > 0) || !Number.isFinite(precision)) {
      return refusal("degenerate-shape", `precision must be a positive finite float, got ${precision}`);
    }
  }
  let maxIter = DEFAULT_SCS_OPTS.maxIter;
  if ("max_iter" in fields) {
    maxIter = Number(BigInt((fields["max_iter"] as { kind: "integer"; value: string }).value));
    if (!Number.isInteger(maxIter) || maxIter < 1) {
      return refusal("degenerate-shape", `max_iter must be a positive integer, got ${maxIter}`);
    }
  }

  return { c, hasQ, hasEq, A, b, cones, precision, maxIter };
}

// -----------------------------------------------------------------------------
// Cone-vocabulary parsing
// -----------------------------------------------------------------------------
//
// Each cone expression covers a slice of the variable vector by integer
// index. v0.1 supports the three LP-complete families — `NonNegCone`,
// `ZeroCone`, `FreeCone` — matching cone-core's projection scope. A
// `FreeCone` is parsed but contributes *no block*: in the O'Donoghue
// translation `x'` is already free, so a free variable simply has no cone
// row. `SOCone` / `PSDCone` / `ExpCone` / `PowCone` are refused with the
// cone-core sub-bead pointer; anything else is `malformed-cone`.

interface ConeBlock {
  /** The cone-core cone for this block (over its `indices`, in order). */
  readonly cone: Cone;
  /** The variable indices this cone covers, in order. */
  readonly indices: number[];
}

function parseIndexList(v: Value, n: number, head: string): number[] | RefusalEnvelope {
  if (v.kind !== "list") {
    return refusal("malformed-cone", `${head} expects a list<integer> argument, got ${v.kind}`);
  }
  const out: number[] = [];
  for (const item of v.items) {
    if (item.kind !== "integer") {
      return refusal("malformed-cone", `${head} index is not an integer: kind=${item.kind}`);
    }
    const idx = Number(BigInt(item.value));
    if (idx < 0 || idx >= n) {
      return refusal("malformed-cone", `${head} index ${idx} out of range [0, ${n})`);
    }
    out.push(idx);
  }
  return out;
}

function parseCones(cones: readonly Value[], n: number): ConeBlock[] | RefusalEnvelope {
  const blocks: ConeBlock[] = [];
  const covered = new Set<number>();
  for (const c of cones) {
    if (c.kind !== "expression") {
      return refusal("malformed-cone", `cone is not an expression value: kind=${c.kind}`);
    }
    const head = c.head;
    switch (head) {
      case "NonNegCone":
      case "ZeroCone":
      case "FreeCone": {
        if (c.args.length !== 1) {
          return refusal("malformed-cone", `${head} expects exactly one list<integer> argument`);
        }
        const idx = parseIndexList(c.args[0]!, n, head);
        if (isRefusal(idx)) return idx;
        for (const j of idx) {
          if (covered.has(j)) {
            return refusal("malformed-cone", `variable index ${j} is covered by more than one cone`);
          }
          covered.add(j);
        }
        if (head === "FreeCone") {
          // A free variable adds no cone row — `x'` is already free in
          // the O'Donoghue translation. Recorded only so the index is
          // marked covered (a free var legitimately produces slack 0).
          break;
        }
        const cone: Cone = head === "NonNegCone" ? nonNeg(idx.length) : zero(idx.length);
        blocks.push({ cone, indices: idx });
        break;
      }
      case "SOCone":
      case "PSDCone":
        return refusal(
          "unsupported-cone",
          `the ${head} cone is not implemented in cone-solve v0.1 — tracked in ` +
            `scientist-workbench-0wc7 (cone-core SOC + PSD projections)`,
        );
      case "ExpCone":
      case "PowCone":
        return refusal(
          "unsupported-cone",
          `the ${head} cone is not implemented in cone-solve v0.1 — tracked in ` +
            `scientist-workbench-j282 (cone-core Exp + Pow projections)`,
        );
      default:
        return refusal("malformed-cone", `unknown cone head: ${head}`);
    }
  }
  return blocks;
}

// -----------------------------------------------------------------------------
// The §C → O'Donoghue translation
// -----------------------------------------------------------------------------
//
// Builds the cone-core `ConeProblem` from the decoded §C data plus the
// parsed cone blocks, and the `coneRowOfVar` map needed to recover the §C
// dual slack afterwards. See the file header for the algebra.

interface Translated {
  readonly problem: ConeProblem;
  /** Number of equality rows `m` — the equality block occupies rows `[0, m)`. */
  readonly mEq: number;
  /**
   * `coneRowOfVar[j]` is the absolute row index in `A'` carrying `−eⱼ`
   * for variable `j`, or `−1` if `j` is a free variable (no cone row).
   * Used to re-index the cone-block dual `y'_cone` back to variable order.
   */
  readonly coneRowOfVar: number[];
}

function translate(d: DecodedInput, blocks: readonly ConeBlock[]): Translated | RefusalEnvelope {
  const n = d.c.length;
  const mEq = d.hasEq ? d.b.length : 0;

  const rows: number[][] = [];
  const bPrime: number[] = [];
  const cones: Cone[] = [];

  // equality block: A x' + s_eq = b, s_eq ∈ {0}ᵐ
  if (d.hasEq) {
    for (let i = 0; i < mEq; i++) {
      rows.push(d.A[i]!.slice());
      bPrime.push(d.b[i]!);
    }
    if (mEq > 0) cones.push(zero(mEq));
  }

  // cone block: −eⱼ x' + s_K = 0, s_K ∈ 𝒦, one row per covered index
  const coneRowOfVar = new Array<number>(n).fill(-1);
  for (const block of blocks) {
    for (const j of block.indices) {
      const row = new Array<number>(n).fill(0);
      row[j] = -1;
      coneRowOfVar[j] = rows.length;
      rows.push(row);
      bPrime.push(0);
    }
    cones.push(block.cone);
  }

  if (rows.length === 0) {
    // No equality, no cone rows — `min cᵀx` over a free `x`. Unbounded
    // unless `c = 0`; either way there is no constraint system to embed.
    return refusal(
      "degenerate-shape",
      "problem has no constraints — neither Ax_eq_b nor any constraining cone",
    );
  }

  const problem: ConeProblem = {
    A: matrixFromRows(rows),
    b: new Float64Array(bPrime),
    c: new Float64Array(d.c),
    cones,
  };
  return { problem, mEq, coneRowOfVar };
}

// -----------------------------------------------------------------------------
// §C recovery + §D encoding
// -----------------------------------------------------------------------------

// `f64List` and `coneExpr` deliberately let TypeScript *infer* their
// return types (`ListValueOf<Float64Value>`, `ExpressionValue`) rather
// than widening to `Value`. The example records are checked against the
// schema-narrowed `defineTool` types — a widened helper would lose the
// narrowing and force `as never` casts at every example (the x0lc
// lesson). The narrow types are still assignable to `Value` everywhere
// `encodeResult` assembles a record.
function f64List(xs: readonly number[]) {
  return list(xs.map((x) => float64FromNumber(x)));
}

/**
 * The §C-wire-form KKT residual of a recovered primal–dual point.
 *
 * `achieved_precision` must describe the point the tool *returns* — the
 * §C `(x, dual, slack)` — measured the way the consumer measures it, not
 * `cone-core`'s internal O'Donoghue-embedded-form residual. The two
 * genuinely differ (bead `rgl8`, worklog 114): `cone-core`'s
 * `achievedPrecision` is the §3.5 relative residual of the *translated,
 * embedded* problem in 2-norm, and it has no `xᵀs` term (it uses the
 * duality gap `cᵀx + bᵀy`, which equals `xᵀs` only in exact arithmetic).
 * `cone-core` is not wrong — it honestly describes *its* form; the
 * §C-form residual of the *recovered* point is a tool-layer concern
 * (worklog 112: protocol / wire shape lives in the tool layer).
 *
 * This recomputes the exact three residuals the corpus `lp-netlib`
 * `verifier_protocol.md` defines (checks 4 / 6 / 7), against the original
 * §C data:
 *
 *   r_p = ‖A·x − b‖_∞ / max(1, ‖b‖_∞)        — primal feasibility
 *   r_d = ‖Aᵀ·y + s − c‖_∞ / max(1, ‖c‖_∞)   — dual feasibility
 *   r_c = |xᵀ·s| / max(1, |cᵀ·x|)            — complementary slackness
 *
 * and returns their max. With no equality block (`A` empty) `r_p` is
 * vacuously 0 and the `Aᵀy` term is the zero vector — the formula
 * degrades correctly. Inf-norm throughout, matching the verifier: this
 * is precisely the number the verifier's `self_reported_precision` check
 * (#10) recomputes and gates `achieved_precision` against, so reporting
 * it here makes the honest-scope contract hold by construction.
 */
function kktResidualC(
  A: readonly (readonly number[])[],
  b: readonly number[],
  c: readonly number[],
  x: readonly number[],
  y: readonly number[],
  s: readonly number[],
): number {
  const m = A.length;
  const n = c.length;
  const infNorm = (v: readonly number[]): number => {
    let mx = 0;
    for (const e of v) {
      const a = Math.abs(e);
      if (a > mx) mx = a;
    }
    return mx;
  };

  // r_p = ‖A·x − b‖_∞ / max(1, ‖b‖_∞)
  let rpNum = 0;
  for (let i = 0; i < m; i++) {
    const row = A[i]!;
    let acc = 0;
    for (let j = 0; j < n; j++) acc += row[j]! * x[j]!;
    rpNum = Math.max(rpNum, Math.abs(acc - b[i]!));
  }
  const rP = rpNum / Math.max(1, infNorm(b));

  // r_d = ‖Aᵀ·y + s − c‖_∞ / max(1, ‖c‖_∞)
  const aty = new Float64Array(n);
  for (let i = 0; i < m; i++) {
    const row = A[i]!;
    const yi = y[i]!;
    for (let j = 0; j < n; j++) aty[j]! += row[j]! * yi;
  }
  let rdNum = 0;
  for (let j = 0; j < n; j++) rdNum = Math.max(rdNum, Math.abs(aty[j]! + s[j]! - c[j]!));
  const rD = rdNum / Math.max(1, infNorm(c));

  // r_c = |xᵀ·s| / max(1, |cᵀ·x|)
  let xs = 0;
  let cx = 0;
  for (let j = 0; j < n; j++) {
    xs += x[j]! * s[j]!;
    cx += c[j]! * x[j]!;
  }
  const rC = Math.abs(xs) / Math.max(1, Math.abs(cx));

  return Math.max(rP, rD, rC);
}

/**
 * Recover the §C dual variable and dual slack from a translated-problem
 * dual `y'` (cone-core's `SCSResult.y` / a `Candidate.y`).
 *
 *   - §C `dual`  = `−y'_eq`     — the equality-block dual, negated
 *   - §C `slack` = `y'_cone`    — the cone-block dual, re-indexed from
 *                                 row order to variable order via
 *                                 `coneRowOfVar`; a free variable (no
 *                                 cone row) has slack exactly `0`.
 *
 * Shared by `encodeResult` (which encodes the final point) and the
 * per-iteration `convergenceTest` closure in `fn` (which measures the
 * §C-wire-form residual of every candidate) so the two never drift —
 * they recover the §C point the same way, by construction.
 */
function recoverDualSlack(
  yPrime: Float64Array,
  t: Translated,
  n: number,
): { dual: number[]; slack: number[] } {
  const dual = new Array<number>(t.mEq);
  for (let i = 0; i < t.mEq; i++) dual[i] = -yPrime[i]!;
  const slack = new Array<number>(n).fill(0);
  for (let j = 0; j < n; j++) {
    const r = t.coneRowOfVar[j]!;
    if (r >= 0) slack[j] = yPrime[r]!;
  }
  return { dual, slack };
}

/**
 * Encode the `scsSolve` result as the ADR-0030 §D output. `optimal`,
 * `iter-cap`, `infeasible`, `unbounded` and `numerical-breakdown` are all
 * the §D *record* (with the `status` field) — only *malformed input* gets
 * a tagged envelope (worklog 089: "status is honest"; the verifier treats
 * a tagged envelope on a known-optimal case as a hard fail).
 *
 * The §C recovery (see file header):
 *   - §C `x`     = `x'`
 *   - §C `y`     = `−y'_eq`           (negate the first `mEq` duals)
 *   - §C `slack` = `y'_cone`          (re-indexed via `coneRowOfVar`)
 *
 * `achieved_precision` is recomputed here, in §C wire form, from the
 * *recovered* `(x, dual, slack)` against the original §C `(A, b, c)` —
 * `kktResidualC`, not `cone-core`'s embedded-form `achievedPrecision`
 * (bead `rgl8`). It describes the point this function actually emits.
 */
function encodeResult(
  result: SCSResult,
  t: Translated,
  decoded: DecodedInput,
  warnings: string[],
): Value {
  const { mEq } = t;
  const n = decoded.c.length;

  switch (result.status) {
    case "optimal": {
      // `cone-core` returned `optimal`. Because this tool hands `scsSolve`
      // an `SCSOpts.convergenceTest` (built in `fn`) that *is* the
      // §C-wire-form test `kktResidualC ≤ precision`, that status already
      // means the recovered §C point meets the wire contract. This is the
      // deeper fix bead `oxuk` calls for: it retires rgl8's stopgap
      // coherence guard (which re-labelled `optimal → iter-cap` when the
      // embedded §3.5 test fired looser than the §C residual). `scsSolve`
      // is now driven to the consumer criterion directly, so the
      // embedded/§C gap never leaks into the status — there is no
      // re-label, `optimal` means `optimal` with no asterisk.
      //
      // `achieved_precision` is still recomputed here in §C wire form
      // from the recovered point — it is the figure the verifier's check
      // #10 recomputes, and the §D output field must carry it. By
      // construction it equals what the `convergenceTest` closure
      // measured: same final iterate (`result.x` / `result.y` is the very
      // `Candidate` the last hook call accepted), same `recoverDualSlack`,
      // same `kktResidualC` — so it is `≤ precision`. That identity is an
      // `--invariants` claim, exercised numerically by `--test`.
      const x = Array.from(result.x);
      const { dual, slack } = recoverDualSlack(result.y, t, n);
      const achievedPrecision = kktResidualC(decoded.A, decoded.b, decoded.c, x, dual, slack);
      return record({
        status: str("optimal"),
        x: f64List(x),
        dual: f64List(dual),
        slack: f64List(slack),
        objective: float64FromNumber(result.objective),
        achieved_precision: float64FromNumber(achievedPrecision),
        iterations: int(BigInt(result.iterations)),
        method: str(METHOD_TAG),
        condition_estimate: float64FromNumber(result.conditionEstimate),
        warnings: list(warnings.map((w) => str(w))),
      });
    }
    case "iter-cap": {
      // Best-effort iterate if some iterate had u_τ > 0, else empty. When
      // an iterate exists, `achieved_precision` is the honest §C-form KKT
      // residual *of that iterate* — emitted as a field (ADR-0030 §D: an
      // `iter-cap` carries its honest precision), recomputed the same way
      // as the `optimal` branch so the warning string and the field never
      // disagree. With no iterate (`result.x` undefined) there is nothing
      // to measure: the field is absent and the warning says so.
      const hasIterate = result.x !== undefined && result.y !== undefined;
      const x = result.x === undefined ? [] : Array.from(result.x);
      const { dual, slack }: { dual: number[]; slack: number[] } =
        result.y === undefined ? { dual: [], slack: [] } : recoverDualSlack(result.y, t, n);
      const achievedPrecision = hasIterate
        ? kktResidualC(decoded.A, decoded.b, decoded.c, x, dual, slack)
        : undefined;
      const w = [
        ...warnings,
        `iteration cap (${result.iterations}) reached before convergence; ` +
          (achievedPrecision === undefined
            ? `no primal–dual iterate was recoverable (τ never positive)`
            : `achieved precision ${achievedPrecision} is worse than requested`),
      ];
      const fields: Record<string, Value> = {
        status: str("iter-cap"),
        x: f64List(x),
        dual: f64List(dual),
        slack: f64List(slack),
        iterations: int(BigInt(result.iterations)),
        method: str(METHOD_TAG),
        condition_estimate: float64FromNumber(result.conditionEstimate),
        warnings: list(w.map((s) => str(s))),
      };
      if (achievedPrecision !== undefined) {
        fields["achieved_precision"] = float64FromNumber(achievedPrecision);
      }
      return record(fields);
    }
    case "infeasible": {
      // The primal is infeasible — `dual` carries the Farkas certificate
      // (a `y'` of the *translated* problem; its equality-block slice,
      // negated, is the §C Farkas direction). `x` / `slack` are empty.
      const cert = result.certificate;
      const y = new Array<number>(mEq);
      for (let i = 0; i < mEq; i++) y[i] = -cert[i]!;
      return record({
        status: str("infeasible"),
        x: f64List([]),
        dual: f64List(y),
        slack: f64List([]),
        iterations: int(BigInt(result.iterations)),
        method: str(METHOD_TAG),
        condition_estimate: float64FromNumber(result.conditionEstimate),
        warnings: list(warnings.map((w) => str(w))),
      });
    }
    case "unbounded": {
      // The primal is unbounded — `x` carries the unbounded ray.
      return record({
        status: str("unbounded"),
        x: f64List(Array.from(result.certificate)),
        dual: f64List([]),
        slack: f64List([]),
        iterations: int(BigInt(result.iterations)),
        method: str(METHOD_TAG),
        condition_estimate: float64FromNumber(result.conditionEstimate),
        warnings: list(warnings.map((w) => str(w))),
      });
    }
    case "numerical-breakdown": {
      return record({
        status: str("numerical-breakdown"),
        x: f64List([]),
        dual: f64List([]),
        slack: f64List([]),
        iterations: int(BigInt(result.iterations)),
        method: str(METHOD_TAG),
        condition_estimate: float64FromNumber(0),
        warnings: list([...warnings, result.detail].map((s) => str(s))),
      });
    }
  }
}

// -----------------------------------------------------------------------------
// The fn body
// -----------------------------------------------------------------------------

function fn(
  input: RecordValue,
  flags: { accelerator: AcceleratorChoice },
): Value {
  const decoded = decodeInput(input);
  if (isRefusal(decoded)) return refusalValue(decoded);

  if (decoded.hasQ) {
    return refusalValue(
      refusal(
        "quadratic-objective",
        "cone-solve v0.1 handles linear objectives only; a quadratic `minimize.Q` " +
          "is deferred (ADR-0030 open-question 3) — drop Q or use the future tools/qp-solve",
      ),
    );
  }

  const blocks = parseCones(decoded.cones, decoded.c.length);
  if (isRefusal(blocks)) return refusalValue(blocks);

  const translated = translate(decoded, blocks);
  if (isRefusal(translated)) return refusalValue(translated);

  // The §C-wire-form convergence test handed to `scsSolve` (ADR-0030
  // addendum, bead `oxuk`). cone-core's paper-faithful §3.5 termination
  // test is denominated in the *embedded translated* problem's 2-norm
  // residual — looser than this tool's `precision` contract, which is
  // the §C-wire-form KKT residual of the *recovered* point (the figure
  // the corpus verifier recomputes). Supplying this predicate makes
  // `scsSolve` drive the iteration to *that* criterion: it declares
  // `optimal` exactly when `kktResidualC ≤ precision` on the recovered
  // §C point — so an `optimal` from this tool means the wire contract
  // holds, with no post-hoc coherence re-label (rgl8's stopgap, retired
  // by this bead). Runs once per iteration; `kktResidualC` is O(m·n),
  // bounded by the iteration's own subspace solve.
  const n = decoded.c.length;
  const convergenceTest = (candidate: Candidate): boolean => {
    const { dual, slack } = recoverDualSlack(candidate.y, translated, n);
    const residual = kktResidualC(
      decoded.A,
      decoded.b,
      decoded.c,
      Array.from(candidate.x),
      dual,
      slack,
    );
    return residual <= decoded.precision;
  };

  // Build the `accelerator` spec from the typed flag. `type-ii` keeps
  // back-compat with the v0.1 default (a memory-window AA-II); `type-i`
  // selects the AA-I-S-m v0.2 path (ADR-0036 §F) with the paper's
  // default hyper-parameters from `DEFAULT_ANDERSON_I_SPEC`.
  //
  // Mutual exclusion (CLAUDE.md Rule 1): we set `accelerator` explicitly
  // *only* for `type-i` — for `type-ii` we leave it unset and let
  // `andersonMemory` carry the choice, preserving byte-identical
  // SCSOpts for the back-compat path. `scsSolve` rejects passing both.
  const acceleratorSpec: AndersonSpec | undefined =
    flags.accelerator === "type-i"
      ? { kind: "type-i", ...DEFAULT_ANDERSON_I_SPEC }
      : undefined;

  const result = scsSolve(translated.problem, {
    precision: decoded.precision,
    maxIter: decoded.maxIter,
    alpha: DEFAULT_SCS_OPTS.alpha,
    andersonMemory: DEFAULT_SCS_OPTS.andersonMemory,
    convergenceTest,
    ...(acceleratorSpec !== undefined ? { accelerator: acceleratorSpec } : {}),
  });

  return encodeResult(result, translated, decoded, []);
}

// -----------------------------------------------------------------------------
// Examples — one per code-path branch
// -----------------------------------------------------------------------------

function coneExpr(head: string, indices: number[]) {
  return expr(head, [list(indices.map((i) => int(BigInt(i))))]);
}

const examples = [
  {
    description: "1-D LP: minimise x subject to x = 1, x ≥ 0 — optimum x = 1",
    input: record({
      minimize: record({ c: f64List([1]) }),
      subjectTo: record({
        Ax_eq_b: record({ A: list([f64List([1])]), b: f64List([1]) }),
        cones: list([coneExpr("NonNegCone", [0])]),
      }),
    }),
    output: record({
      status: str("optimal"),
      x: f64List([1]),
      dual: f64List([1]),
      slack: f64List([0]),
      objective: float64FromNumber(1),
      achieved_precision: float64FromNumber(0),
      iterations: int(1n),
      method: str(METHOD_TAG),
      condition_estimate: float64FromNumber(0),
      warnings: list([]),
    }),
  },
  {
    description: "Refusal: a second-order cone is outside cone-solve v0.1's LP-complete scope",
    input: record({
      minimize: record({ c: f64List([1, 0, 0]) }),
      subjectTo: record({ cones: list([coneExpr("SOCone", [0, 1, 2])]) }),
    }),
    output: tagged(
      "cone-solve/unsupported-cone",
      record({
        detail: str(
          "the SOCone cone is not implemented in cone-solve v0.1 — tracked in " +
            "scientist-workbench-0wc7 (cone-core SOC + PSD projections)",
        ),
      }),
    ),
  },
  {
    description: "Refusal: a quadratic objective is deferred (ADR-0030 open-question 3)",
    input: record({
      minimize: record({ c: f64List([1]), Q: list([f64List([2])]) }),
      subjectTo: record({
        Ax_eq_b: record({ A: list([f64List([1])]), b: f64List([1]) }),
        cones: list([coneExpr("NonNegCone", [0])]),
      }),
    }),
    output: tagged(
      "cone-solve/quadratic-objective",
      record({
        detail: str(
          "cone-solve v0.1 handles linear objectives only; a quadratic `minimize.Q` " +
            "is deferred (ADR-0030 open-question 3) — drop Q or use the future tools/qp-solve",
        ),
      }),
    ),
  },
  {
    description:
      "1-D LP with --accelerator=type-i (ADR-0036 §F AA-I-S-m path) — same optimum",
    input: record({
      minimize: record({ c: f64List([1]) }),
      subjectTo: record({
        Ax_eq_b: record({ A: list([f64List([1])]), b: f64List([1]) }),
        cones: list([coneExpr("NonNegCone", [0])]),
      }),
    }),
    flags: { accelerator: "type-i" as const },
    output: record({
      status: str("optimal"),
      x: f64List([1]),
      dual: f64List([1]),
      slack: f64List([0]),
      objective: float64FromNumber(1),
      achieved_precision: float64FromNumber(0),
      iterations: int(1n),
      method: str(METHOD_TAG),
      condition_estimate: float64FromNumber(0),
      warnings: list([]),
    }),
  },
];

const invariants = [
  {
    name: "primal-feasibility",
    statement: "Optimal status implies A·x = b and x ∈ 𝒦 within `achieved_precision`.",
    machine_checkable: true,
  },
  {
    name: "dual-feasibility",
    statement: "Optimal status implies Aᵀy + slack = c with slack ∈ 𝒦* within `achieved_precision`.",
    machine_checkable: true,
  },
  {
    name: "complementary-slackness",
    statement: "Optimal status implies |xᵀ·slack| ≤ achieved_precision · max(1, |cᵀx|).",
    machine_checkable: true,
  },
  {
    name: "strong-duality",
    statement: "Optimal status implies cᵀx = bᵀy within `achieved_precision`.",
    machine_checkable: true,
  },
  {
    name: "honest-precision",
    statement:
      "`achieved_precision` ≥ the true max relative KKT residual — the solver " +
      "never under-claims (CLAUDE.md Rule 8).",
    machine_checkable: true,
  },
  {
    name: "optimal-precision-coherence",
    statement:
      "`optimal` status implies `achieved_precision ≤ precision`. The tool hands " +
      "`scsSolve` a `convergenceTest` denominated in the §C-wire-form residual " +
      "(bead `oxuk`), so the iteration is driven to the wire criterion directly " +
      "— an `optimal` never carries a residual worse than requested.",
    machine_checkable: true,
  },
  {
    name: "scope-honest-refusal",
    statement:
      "A cone family outside the v0.1 LP-complete subset returns a tagged " +
      "`cone-solve/unsupported-cone` envelope, never a wrong-shaped answer.",
    machine_checkable: true,
  },
  {
    name: "accelerator-choice-agrees-on-the-optimum",
    statement:
      "On a feasible LP both `--accelerator=type-ii` (default) and " +
      "`--accelerator=type-i` (ADR-0036 §F AA-I-S-m) return the same primal " +
      "optimum within `achieved_precision` — acceleration changes the speed, " +
      "never the answer (the determinism contract for the choice flag).",
    machine_checkable: true,
  },
];

// -----------------------------------------------------------------------------
// In-process smoke test (--test)
// -----------------------------------------------------------------------------
//
// Exercises the happy path and the two refusal envelopes against problems
// with hand-known answers. Asserts structural and numerical facts — never
// just "didn't throw" (CLAUDE.md Rule 7).

function smokeTest(): void {
  // (1) A 2-variable LP with a known optimum: min x + 2y s.t. x + y = 3,
  // x, y ≥ 0 → x = 3, y = 0, objective = 3.
  const lp = record({
    minimize: record({ c: f64List([1, 2]) }),
    subjectTo: record({
      Ax_eq_b: record({ A: list([f64List([1, 1])]), b: f64List([3]) }),
      cones: list([coneExpr("NonNegCone", [0, 1])]),
    }),
  });
  const out = fn(lp, { accelerator: "type-ii" }) as RecordValue;
  const status = (out.fields["status"] as { kind: "string"; value: string }).value;
  if (status !== "optimal") {
    throw new Error(`cone-solve --test: LP returned status=${status}, expected "optimal"`);
  }
  const objV = out.fields["objective"];
  if (objV === undefined || objV.kind !== "float64") {
    throw new Error("cone-solve --test: optimal result is missing the objective field");
  }
  const obj = float64ToNumber(objV);
  if (Math.abs(obj - 3) > 1e-5) {
    throw new Error(`cone-solve --test: LP objective ${obj} differs from 3 by more than 1e-5`);
  }
  // The recovered x must be primal-feasible: x ≥ 0 and x₀ + x₁ = 3.
  const x = (out.fields["x"] as { kind: "list"; items: Value[] }).items.map((v) =>
    float64ToNumber(v as { kind: "float64"; bits: string }),
  );
  if (x.length !== 2 || x[0]! < -1e-6 || x[1]! < -1e-6 || Math.abs(x[0]! + x[1]! - 3) > 1e-5) {
    throw new Error(`cone-solve --test: recovered x=${JSON.stringify(x)} is not primal-feasible`);
  }

  // honest-precision invariant (CLAUDE.md Rule 8): the reported
  // `achieved_precision` must *be* the §C-wire-form KKT residual of the
  // *returned* `(x, dual, slack)` — not cone-core's embedded-form residual
  // (bead `rgl8`). Recompute the three §C residuals here *independently*
  // — own inline loops, not a `kktResidualC` call — and assert the field
  // equals their max. The original bug forwarded a 2-norm embedded-form
  // number that under-claimed the true §C residual by ~3× on `scsd1`;
  // `bench/cone-solve/profile-lp-netlib.ts` is the at-scale mutation
  // canary, this is the per-tool one.
  const apV = out.fields["achieved_precision"];
  if (apV === undefined || apV.kind !== "float64") {
    throw new Error("cone-solve --test: optimal result is missing the achieved_precision field");
  }
  const achievedPrecision = float64ToNumber(apV);
  const dual = (out.fields["dual"] as { kind: "list"; items: Value[] }).items.map((v) =>
    float64ToNumber(v as { kind: "float64"; bits: string }),
  );
  const slack = (out.fields["slack"] as { kind: "list"; items: Value[] }).items.map((v) =>
    float64ToNumber(v as { kind: "float64"; bits: string }),
  );
  // §C data of this test problem: min x+2y s.t. [1 1]·x = 3, x ∈ ℝ²₊.
  const rP = Math.abs(x[0]! + x[1]! - 3) / Math.max(1, 3);
  const rD =
    Math.max(Math.abs(dual[0]! + slack[0]! - 1), Math.abs(dual[0]! + slack[1]! - 2)) /
    Math.max(1, 2);
  const rC =
    Math.abs(x[0]! * slack[0]! + x[1]! * slack[1]!) / Math.max(1, Math.abs(x[0]! + 2 * x[1]!));
  const trueResidual = Math.max(rP, rD, rC);
  if (!Number.isFinite(achievedPrecision) || achievedPrecision < 0) {
    throw new Error(
      `cone-solve --test: achieved_precision ${achievedPrecision} is not a sane residual`,
    );
  }
  if (achievedPrecision < trueResidual - 1e-12) {
    throw new Error(
      `cone-solve --test: honest-precision violated — achieved_precision ${achievedPrecision} ` +
        `under-claims the §C KKT residual ${trueResidual} (CLAUDE.md Rule 8)`,
    );
  }
  if (Math.abs(achievedPrecision - trueResidual) > 1e-9 * Math.max(1, trueResidual)) {
    throw new Error(
      `cone-solve --test: achieved_precision ${achievedPrecision} is not the §C KKT residual ` +
        `${trueResidual} — it must describe the returned (x, dual, slack), not the embedded form`,
    );
  }
  // optimal-precision-coherence invariant (bead `oxuk`): an `optimal`
  // status must mean `achieved_precision ≤ precision` with no asterisk.
  // This holds *structurally* — `fn` hands `scsSolve` a `convergenceTest`
  // that is exactly `kktResidualC ≤ precision`, so `scsSolve` declares
  // `optimal` only once the §C wire contract is met (rgl8's post-hoc
  // `optimal → iter-cap` re-label is retired). The LP above uses the
  // default `precision`; assert the contract numerically.
  if (achievedPrecision > DEFAULT_SCS_OPTS.precision) {
    throw new Error(
      `cone-solve --test: optimal-precision-coherence violated — status is "optimal" but ` +
        `achieved_precision ${achievedPrecision} exceeds the default precision ` +
        `${DEFAULT_SCS_OPTS.precision} (the convergenceTest hook should make ` +
        `optimal ⟹ achieved_precision ≤ precision structural — bead oxuk)`,
    );
  }

  // (2) An unsupported cone must produce the tagged refusal, not a solve.
  const socIn = record({
    minimize: record({ c: f64List([1, 0, 0]) }),
    subjectTo: record({ cones: list([coneExpr("SOCone", [0, 1, 2])]) }),
  });
  const socOut = fn(socIn, { accelerator: "type-ii" });
  if (socOut.kind !== "tagged" || socOut.tag !== "cone-solve/unsupported-cone") {
    throw new Error(
      `cone-solve --test: SOCone input gave kind=${socOut.kind}, expected tagged cone-solve/unsupported-cone`,
    );
  }

  // (3) A quadratic objective must be refused, not silently linearised.
  const qpIn = record({
    minimize: record({ c: f64List([1]), Q: list([f64List([2])]) }),
    subjectTo: record({
      Ax_eq_b: record({ A: list([f64List([1])]), b: f64List([1]) }),
      cones: list([coneExpr("NonNegCone", [0])]),
    }),
  });
  const qpOut = fn(qpIn, { accelerator: "type-ii" });
  if (qpOut.kind !== "tagged" || qpOut.tag !== "cone-solve/quadratic-objective") {
    throw new Error(
      `cone-solve --test: Q input gave kind=${qpOut.kind}, expected tagged cone-solve/quadratic-objective`,
    );
  }

  // (4) accelerator-choice-agrees-on-the-optimum invariant: the same LP
  // solved with `--accelerator=type-i` must return the same primal
  // optimum within precision. AA-I-S-m is the ADR-0036 §F path; if it
  // *diverged* on a feasible LP, this assertion would catch it.
  const outAAI = fn(lp, { accelerator: "type-i" }) as RecordValue;
  const statusAAI = (outAAI.fields["status"] as { kind: "string"; value: string }).value;
  if (statusAAI !== "optimal") {
    throw new Error(
      `cone-solve --test: type-i path returned status=${statusAAI}, expected "optimal"`,
    );
  }
  const objAAIv = outAAI.fields["objective"];
  if (objAAIv === undefined || objAAIv.kind !== "float64") {
    throw new Error("cone-solve --test: type-i optimal result is missing the objective field");
  }
  const objAAI = float64ToNumber(objAAIv);
  if (Math.abs(objAAI - 3) > 1e-5) {
    throw new Error(
      `cone-solve --test: type-i LP objective ${objAAI} differs from 3 by more than 1e-5 ` +
        `— accelerator-choice-agrees-on-the-optimum invariant violated (ADR-0036 §F)`,
    );
  }
  const xAAI = (outAAI.fields["x"] as { kind: "list"; items: Value[] }).items.map((v) =>
    float64ToNumber(v as { kind: "float64"; bits: string }),
  );
  if (
    xAAI.length !== 2 ||
    Math.abs(xAAI[0]! - x[0]!) > 1e-5 ||
    Math.abs(xAAI[1]! - x[1]!) > 1e-5
  ) {
    throw new Error(
      `cone-solve --test: type-i recovered x=${JSON.stringify(xAAI)} differs from ` +
        `type-ii x=${JSON.stringify(x)} by more than 1e-5 — accelerator-choice-agrees-on-the-optimum ` +
        `invariant violated (ADR-0036 §F)`,
    );
  }
}

export const def = defineTool({
  name: NAME,
  version: VERSION,
  schema: { input: inputSchema, output: outputSchema },
  flags: {
    accelerator: F.enum(
      ACCELERATOR_VALUES,
      "Anderson-acceleration variant: 'type-ii' (Walker-Ni; v0.1 default, " +
        "shipped goldens-preserving) or 'type-i' (AA-I-S-m with Powell + " +
        "GS-restart + KM-safeguard; ADR-0036 §F).",
      { default: "type-ii" as const },
    ),
  },
  examples,
  invariants,
  numerical: true,
  fn: fn as never,
  test: smokeTest,
});

if (import.meta.main) void runTool(def);
