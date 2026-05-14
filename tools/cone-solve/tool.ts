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
//     max_iter?:  integer                   // default 2500 (SCS-ADMM)
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
//     — `objective` / `achieved_precision` present only when
//       `status === "optimal"`; the five status classes are
//       `optimal | infeasible | unbounded | iter-cap | numerical-breakdown`.
//   | tagged "cone-solve/{non-finite-input,degenerate-shape,malformed-cone,
//                         unsupported-cone,quadratic-objective}"
//     — boundary-failure refusal envelopes for input the tool will not
//       attempt (ADR-0003: a clean tagged refusal is correct; a lie is not).
//
// v0.1 scope
// ----------
// cone-core v0.1 implements the LP-complete cone subset — nonneg / zero /
// free. So cone-solve v0.1 accepts `NonNegCone`, `ZeroCone`, `FreeCone`
// and refuses `SOCone` / `PSDCone` / `ExpCone` / `PowCone` with a
// `cone-solve/unsupported-cone` envelope naming the cone-core sub-bead
// that tracks it (`0wc7` SOC+PSD, `j282` Exp+Pow). A quadratic objective
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
import { defineTool, runTool } from "@workbench/contract";
import {
  type Cone,
  type ConeProblem,
  type SCSResult,
  ConeError,
  nonNeg,
  scsSolve,
  zero,
  DEFAULT_SCS_OPTS,
} from "@workbench/cone-core";
import { matrixFromRows } from "@workbench/linalg-core";

const NAME = "cone-solve";
const VERSION = "0.1.0";
const METHOD_TAG = "scs";

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
 */
function encodeResult(result: SCSResult, t: Translated, n: number, warnings: string[]): Value {
  const { mEq, coneRowOfVar } = t;

  // §C dual `y = −y'_eq` — the equality-block dual, negated.
  const recoverY = (yPrime: Float64Array): number[] => {
    const y = new Array<number>(mEq);
    for (let i = 0; i < mEq; i++) y[i] = -yPrime[i]!;
    return y;
  };
  // §C dual slack `s` — the cone-block dual `y'_cone`, re-indexed to
  // variable order. A free variable (no cone row) has slack exactly 0.
  const recoverSlack = (yPrime: Float64Array): number[] => {
    const s = new Array<number>(n).fill(0);
    for (let j = 0; j < n; j++) {
      const r = coneRowOfVar[j]!;
      if (r >= 0) s[j] = yPrime[r]!;
    }
    return s;
  };

  switch (result.status) {
    case "optimal": {
      return record({
        status: str("optimal"),
        x: f64List(Array.from(result.x)),
        dual: f64List(recoverY(result.y)),
        slack: f64List(recoverSlack(result.y)),
        objective: float64FromNumber(result.objective),
        achieved_precision: float64FromNumber(result.achievedPrecision),
        iterations: int(BigInt(result.iterations)),
        method: str(METHOD_TAG),
        condition_estimate: float64FromNumber(result.conditionEstimate),
        warnings: list(warnings.map((w) => str(w))),
      });
    }
    case "iter-cap": {
      // Best-effort iterate if some iterate had u_τ > 0, else empty.
      const x = result.x === undefined ? [] : Array.from(result.x);
      const dual = result.y === undefined ? [] : recoverY(result.y);
      const slack = result.y === undefined ? [] : recoverSlack(result.y);
      const w = [
        ...warnings,
        `iteration cap (${result.iterations}) reached before convergence; ` +
          `achieved precision ${result.achievedPrecision} is worse than requested`,
      ];
      return record({
        status: str("iter-cap"),
        x: f64List(x),
        dual: f64List(dual),
        slack: f64List(slack),
        iterations: int(BigInt(result.iterations)),
        method: str(METHOD_TAG),
        condition_estimate: float64FromNumber(result.conditionEstimate),
        warnings: list(w.map((s) => str(s))),
      });
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

function fn(input: RecordValue, _flags: Record<string, never>): Value {
  void _flags;

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

  const result = scsSolve(translated.problem, {
    precision: decoded.precision,
    maxIter: decoded.maxIter,
    alpha: DEFAULT_SCS_OPTS.alpha,
    andersonMemory: DEFAULT_SCS_OPTS.andersonMemory,
  });

  return encodeResult(result, translated, decoded.c.length, []);
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
    name: "scope-honest-refusal",
    statement:
      "A cone family outside the v0.1 LP-complete subset returns a tagged " +
      "`cone-solve/unsupported-cone` envelope, never a wrong-shaped answer.",
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
  const out = fn(lp, {}) as RecordValue;
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

  // (2) An unsupported cone must produce the tagged refusal, not a solve.
  const socIn = record({
    minimize: record({ c: f64List([1, 0, 0]) }),
    subjectTo: record({ cones: list([coneExpr("SOCone", [0, 1, 2])]) }),
  });
  const socOut = fn(socIn, {});
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
  const qpOut = fn(qpIn, {});
  if (qpOut.kind !== "tagged" || qpOut.tag !== "cone-solve/quadratic-objective") {
    throw new Error(
      `cone-solve --test: Q input gave kind=${qpOut.kind}, expected tagged cone-solve/quadratic-objective`,
    );
  }
}

export const def = defineTool({
  name: NAME,
  version: VERSION,
  schema: { input: inputSchema, output: outputSchema },
  examples,
  invariants,
  numerical: true,
  fn: fn as never,
  test: smokeTest,
});

if (import.meta.main) void runTool(def);
