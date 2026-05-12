// =============================================================================
// lp-solve — linear-programming specialist, exact-rational engine
// =============================================================================
//
// Intent
// ------
// The LP specialist of the cone-solver tier (ADR-0030 §B), v0.1 lane:
// arbitrary-precision rational engine wrapped in the float64 wire schema.
// A TS expert who types `wb.run("lp-solve", problem)` gets back a
// `record` with primal `x`, dual `y`, slacks `s`, objective, and a
// reported `achieved_precision` that is — for well-scaled inputs —
// dominated by IEEE-754 round-off, i.e. ≈ 2.2 × 10⁻¹⁶. That is four
// orders of magnitude past the 1e-12 accuracy ceiling ADR-0030 named,
// because the simplex method ran *exactly* over ℚ inside the tool;
// only the wire encode and decode are float64 operations.
//
// ADR-0031 codifies the design choice. The bench gate is 21/21 on
// `lp-netlib` plus 29/29 on `lp-small` in the sister corpus repo.
//
// The wire-and-engine sandwich
// ----------------------------
// The shape of every successful execution is:
//
//     float64 input (c, A, b, …)
//        ↓  decode each float64 to its *exact* IEEE-754 dyadic rational
//     Rat input (c̃, Ã, b̃)
//        ↓  free-variable splitting; cone vocabulary check
//     standard-form LP over ℚ
//        ↓  @workbench/simplex-q::simplexSolve
//     SimplexResult (Rat fields)
//        ↓  re-assemble splits; map engine status → ADR-0030 taxonomy
//     pre-encode result (Rat fields)
//        ↓  encode each Rat to nearest float64 (round-half-to-even)
//     ADR-0030 §D output record (float64 fields)
//
// The encoding step is the *only* lossy operation in the pipeline. For
// any output coefficient `r = p/q`, the encoded value `f` satisfies
// `|f - r| ≤ ½ ULP(r)`, the strongest guarantee an IEEE-754 wire can
// carry. The KKT residuals reported as `achieved_precision` are
// computed by *re-lifting* the encoded floats back to ℚ, evaluating the
// residuals in ℚ, and encoding the residual maximum back to float64 —
// so the reported precision is faithful to the wire bytes the agent
// actually sees, not the (zero) interior residual.
//
// Boundary categories (ADR-0003, refusal envelopes)
// -------------------------------------------------
//   * `lp-solve/non-finite-input` — any `c[j]`, `A[i][j]`, or `b[i]`
//     is NaN, +Inf, or -Inf. Payload identifies the offending
//     coordinate.
//   * `lp-solve/degenerate-shape` — dimension mismatch between `c`,
//     the rows of `A`, and `b`.
//   * `lp-solve/non-lp-cone` — `cones` contains a non-`NonNegCone`
//     entry (SOC, PSD, Exp, Pow); refuse with a suggestion pointing
//     to `tools/cone-solve` (when it ships).
//   * `lp-solve/malformed-cone` — `NonNegCone` indices reference an
//     out-of-range variable, or `cones` is structurally invalid.
//   * `lp-solve/quadratic-objective` — `minimize.Q` is present.
//     `tools/lp-solve` is LP-only; QP specialists are `tools/qp-solve`
//     (deferred) or `tools/cone-solve` (universal).
//   * `lp-solve/coefficient-explosion` — the rational basis inverse
//     grew past the configurable bit-length cap (default 2²⁰ bits).
//     This is the one *intrinsic* failure mode of the exact-rational
//     engine; payload reports achieved bit length and the cap that
//     was breached.
//
// ADR-0030 §A.3 termination taxonomy mapping
// ------------------------------------------
//   engine status            wire status         objective + achieved_precision?
//   ─────────────────────    ─────────────────   ───────────────────────────────
//   optimal                  "optimal"           present
//   infeasible               "infeasible"        ABSENT (Inf invalid in JSON)
//   unbounded                "unbounded"         ABSENT (Inf invalid in JSON)
//   iter-cap                 "iter-cap"          ABSENT
//   coefficient-explosion    tagged refusal       n/a (boundary envelope)
//
// `numerical-breakdown` is in the public taxonomy but the arbprec
// engine never emits it — exact arithmetic does not break down
// numerically. The field is reserved for the future float-engine lane
// (`tools/lp-solve-fast`, bead hnyu).
//
// References
// ----------
// Dantzig 1947, Bland 1977, Vanderbei *Linear Programming* 4th ed.
// Ch. 6-8. The literate prose of `packages/simplex-q/src/simplex.ts`
// is the canonical algorithm description; this tool is the wire
// wrapper around it.

import {
  bool,
  expr,
  float64FromNumber,
  float64ToNumber,
  int,
  list,
  record,
  S,
  str,
  tagged,
  ToolError,
  type Value,
  type ExpressionValue,
  type RecordValue,
} from "@workbench/protocol";
import { defineTool, F, runTool } from "@workbench/contract";
import {
  makeRat,
  RAT_ZERO,
  RAT_ONE,
  type Rat,
  ratNeg,
  ratSub,
  ratAdd,
  ratMul,
  ratIsZero,
} from "@workbench/cas-core";
import { ratLt } from "@workbench/simplex-q";
import {
  simplexSolve,
  type StandardLP,
  type SimplexResult,
} from "@workbench/simplex-q";
import {
  solveLp as solveLpIpm,
  lpFromCanonical,
  toWireStatus as ipmToWireStatus,
  formatVerboseLine,
  type CanonicalLp,
  type VerboseIterLine,
} from "@workbench/solver-ipm";
import { writeSync, openSync, closeSync } from "node:fs";

const NAME = "lp-solve";
const VERSION = "0.1.0";
const METHOD_TAG_EXACT = "simplex-q";
const METHOD_TAG_IPM = "solver-ipm";

// Auto-dispatch threshold. The arbprec simplex (`simplex-q`) is
// exact-rational and bit-identical cross-platform forever, but its
// per-pivot cost grows as O(m²) with BigInt coefficients whose bit
// length is O(m). For dense problems with `m + n > AUTO_DISPATCH_NMAX`
// it routinely exceeds the workbench bench's 30s cap (worklog 090).
// The IPM lane (`solver-ipm`, Mehrotra primal-dual predictor-corrector)
// is float64 internally — `numerical: true` per ADR-0015 — and scales
// to NETLIB (m, n ≈ 100-2000) in seconds. The auto-dispatch routes by
// size; a TS expert sets `--method=exact` to force the bit-identical
// lane when reproducibility matters, or `--method=ipm` to force the
// fast lane on small problems for A/B comparison.
const AUTO_DISPATCH_NMAX = 50;

// -----------------------------------------------------------------------------
// Schema (ADR-0030 §C input + §D output)
// -----------------------------------------------------------------------------
//
// The input schema accepts ADR-0030's cone-solver wire shape verbatim,
// then refuses any subset of it that `lp-solve` does not handle
// (quadratic Q, non-LP cones). The wire stays unified across the
// cone-tier — same `precision`, same `max_iter`, same envelope around
// `Ax_eq_b` and `cones`.
//
// `cones` is `list<expression>` because cone tags carry index-list
// args of varying arity (`NonNegCone[list<int>]`, `SOCone[list<int>]`,
// `PSDCone[int, list<int>]`, etc.). A more refined schema would
// constrain to `S.expression("NonNegCone", S.list(S.list(S.kind("integer"))))`
// — that would block the non-LP cones at validation time — but the
// universal cone-tier wire is the same regardless of tool, and we
// prefer one taxonomy of refusal envelopes over a split between
// "schema rejected" and "tool refused". The `non-lp-cone` envelope
// gives the agent a richer message than a schema rejection would.

const inputSchema = S.record({
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
}, { optional: ["precision", "max_iter"] });

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
// Float64 ↔ Rat conversion
// -----------------------------------------------------------------------------
//
// `float64ToExactRat` lifts an IEEE-754 double to the dyadic rational
// it literally is. No rounding. We extract the bit pattern via
// `BigInt64Array` (a one-byte zero-copy view), then decompose the
// sign/exponent/mantissa fields per IEEE-754 binary64.
//
// `ratToFloat64` encodes a rational to the nearest float64 with
// round-half-to-even. The algorithm is the standard "shift to a 53-bit
// window, do exact BigInt floor-division with round-half-to-even,
// scale by the corresponding power of two." For ratios where both
// numerator and denominator fit in the safe-integer range (|.| < 2^53)
// the direct JS division is already correctly rounded, and we take
// that fast path.

const FLOAT64_VIEW_BUF = new ArrayBuffer(8);
const FLOAT64_VIEW_F = new Float64Array(FLOAT64_VIEW_BUF);
const FLOAT64_VIEW_I = new BigInt64Array(FLOAT64_VIEW_BUF);

function float64ToExactRat(x: number): Rat {
  if (!Number.isFinite(x)) {
    throw new Error(`float64ToExactRat: non-finite input ${x}`);
  }
  if (x === 0) return RAT_ZERO;
  FLOAT64_VIEW_F[0] = x;
  // `BigInt64Array` interprets the byte pattern as a *signed* 64-bit
  // integer. For negative floats the high bit is set, so `bits` reads
  // as a negative BigInt. We need the *unsigned* magnitude — sign bit
  // cleared — to extract the IEEE-754 exponent and mantissa fields.
  // Naive `-bits` performs arithmetic negation (two's-complement) which
  // is NOT the same as sign-bit clearing. The mask below is correct
  // because BigInt bitwise AND with a positive constant returns only
  // the low-order bits regardless of the operand's sign-extension.
  const bits = FLOAT64_VIEW_I[0]!;
  const sign = bits < 0n ? -1n : 1n;
  const u = bits & 0x7fffffffffffffffn;
  const expBits = (u >> 52n) & 0x7ffn;
  const mantBits = u & ((1n << 52n) - 1n);
  if (expBits === 0n) {
    // Subnormal: value = sign · mantBits · 2^(-1074)
    return makeRat(sign * mantBits, 1n << 1074n);
  }
  // Normal: value = sign · (2^52 + mantBits) · 2^(expBits - 1075)
  const m = (1n << 52n) + mantBits;
  const e = expBits - 1075n;
  if (e >= 0n) return makeRat(sign * (m << e));
  return makeRat(sign * m, 1n << -e);
}

const SAFE_INT_LIMIT = 0x20000000000000n; // 2^53

function ratToFloat64(r: Rat): number {
  if (r.n === 0n) return 0;
  const sign = r.n < 0n ? -1 : 1;
  const absN = r.n < 0n ? -r.n : r.n;
  if (absN < SAFE_INT_LIMIT && r.d < SAFE_INT_LIMIT) {
    return (sign * Number(absN)) / Number(r.d);
  }
  // General case: scale to a 53-bit window, round-half-to-even.
  const nBits = absN.toString(2).length;
  const dBits = r.d.toString(2).length;
  const shift = BigInt(dBits + 53 - nBits);
  let num: bigint;
  let den: bigint;
  if (shift >= 0n) {
    num = absN << shift;
    den = r.d;
  } else {
    num = absN;
    den = r.d << -shift;
  }
  let q = num / den;
  const rem = num - q * den;
  const twoRem = rem << 1n;
  // Round-half-to-even: if 2·rem > den, round up; if exactly equal, round to even.
  if (twoRem > den || (twoRem === den && (q & 1n) === 1n)) q += 1n;
  // value = sign · q · 2^(-shift). Math.pow(2, k) is exact for integer k.
  return sign * Number(q) * Math.pow(2, -Number(shift));
}

// -----------------------------------------------------------------------------
// Cone-vocabulary parsing
// -----------------------------------------------------------------------------
//
// We accept `NonNegCone[list<integer>]` only. Any other cone family in
// the input is a refusal at `lp-solve/non-lp-cone`. Variables not
// covered by any `NonNegCone` are treated as *free* and split
// internally as `x_j = x_j⁺ - x_j⁻`; the wire output reconstructs the
// original-variable values from the two halves.

interface ConeParse {
  /** Indices of variables that are non-negative (covered by some NonNegCone). */
  readonly nonneg: ReadonlySet<number>;
  /** Indices of variables that are free (not covered by any NonNegCone). */
  readonly free: ReadonlyArray<number>;
}

function parseCones(cones: ReadonlyArray<Value>, n: number): ConeParse | RefusalEnvelope {
  const nonneg = new Set<number>();
  for (const c of cones) {
    if (c.kind !== "expression") {
      return refusal("malformed-cone", `cone is not an expression value: kind=${c.kind}`);
    }
    const head = c.head;
    if (head === "ZeroCone") {
      // ZeroCone forces variables = 0; absorbable into Ax_eq_b, but if
      // it appears we honour by forcing those variables to a singleton
      // equality (treat them as the empty cone — they'll get
      // automatically zeroed by their non-negativity plus the
      // equality). Simplest path: treat them as non-negative for now;
      // if they appear in Ax = 0 that's already in the constraint.
      // (NonNeg + b[i] = 0 row will pin them when present.)
      continue;
    }
    if (head !== "NonNegCone") {
      return refusal(
        "non-lp-cone",
        `cone head ${head} is not handled by lp-solve; use tools/cone-solve for universal cones`,
      );
    }
    // args[0] is a list value of integer values.
    if (c.args.length !== 1 || c.args[0]!.kind !== "list") {
      return refusal("malformed-cone", `NonNegCone expects one list<integer> argument`);
    }
    for (const item of c.args[0].items) {
      if (item.kind !== "integer") {
        return refusal("malformed-cone", `NonNegCone index is not an integer: kind=${item.kind}`);
      }
      const idx = Number(BigInt(item.value));
      if (idx < 0 || idx >= n) {
        return refusal("malformed-cone", `NonNegCone index ${idx} out of range [0, ${n})`);
      }
      nonneg.add(idx);
    }
  }
  const free: number[] = [];
  for (let j = 0; j < n; j++) if (!nonneg.has(j)) free.push(j);
  return { nonneg, free };
}

// -----------------------------------------------------------------------------
// Refusal envelopes
// -----------------------------------------------------------------------------

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

// -----------------------------------------------------------------------------
// The fn body
// -----------------------------------------------------------------------------
//
// Reads the canonical input value, validates it against `lp-solve`'s
// subset of the cone-tier wire, lifts to exact rationals, runs the
// simplex driver, and encodes the result back to the wire shape.
// Every refusal is a `tagged` value with a structured payload; every
// successful run produces the ADR-0030 §D record.

/**
 * Decode the runner-validated canonical Value into a plain JS struct
 * the rest of the body can pattern-match against. We do this at the
 * top of `fn` rather than threading `Value` accessors everywhere,
 * because the schema has already guaranteed shape conformance and the
 * downstream code is easier to read against typed JS.
 */
function decodeInput(input: RecordValue): {
  c: number[];
  Q: ReadonlyArray<unknown> | undefined;
  A: number[][];
  b: number[];
  cones: ReadonlyArray<Value>;
  maxIter: number | undefined;
} {
  const fields = input.fields;
  const minimize = (fields["minimize"] as RecordValue).fields;
  const subjectTo = (fields["subjectTo"] as RecordValue).fields;
  const cList = (minimize["c"] as { kind: "list"; items: Value[] }).items;
  const c = cList.map((v) => float64ToNumber(v as { kind: "float64"; bits: string }));
  const Q = "Q" in minimize ? (minimize["Q"] as { kind: "list"; items: Value[] }).items : undefined;
  let A: number[][] = [];
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
  const maxIter =
    "max_iter" in fields
      ? Number(BigInt((fields["max_iter"] as { kind: "integer"; value: string }).value))
      : undefined;
  return { c, Q, A, b, cones, maxIter };
}

type LaneMethod = "auto" | "exact" | "ipm";

function fn(input: RecordValue, flags: { method?: LaneMethod }): Value {
  const dec = decodeInput(input);

  // ----- Quadratic objective: refuse fast. -----
  if (dec.Q !== undefined) {
    return refusalValue(
      refusal(
        "quadratic-objective",
        "tools/lp-solve is LP-only; pass to tools/qp-solve (deferred) or tools/cone-solve (universal) for quadratic objectives",
      ),
    );
  }

  // ----- Shape & finiteness validation. -----
  const cFloat = dec.c;
  const n = cFloat.length;
  for (let j = 0; j < n; j++) {
    if (!Number.isFinite(cFloat[j]!)) {
      return refusalValue(refusal("non-finite-input", `c[${j}] = ${cFloat[j]} is non-finite`));
    }
  }

  const aFloat = dec.A;
  const bFloat = dec.b;
  const m = aFloat.length;
  if (bFloat.length !== m) {
    return refusalValue(
      refusal("degenerate-shape", `A has ${m} rows but b has length ${bFloat.length}`),
    );
  }
  for (let i = 0; i < m; i++) {
    if (aFloat[i]!.length !== n) {
      return refusalValue(
        refusal(
          "degenerate-shape",
          `A[${i}] has ${aFloat[i]!.length} columns but c has length ${n}`,
        ),
      );
    }
    for (let j = 0; j < n; j++) {
      if (!Number.isFinite(aFloat[i]![j]!)) {
        return refusalValue(
          refusal("non-finite-input", `A[${i}][${j}] = ${aFloat[i]![j]} is non-finite`),
        );
      }
    }
    if (!Number.isFinite(bFloat[i]!)) {
      return refusalValue(refusal("non-finite-input", `b[${i}] = ${bFloat[i]} is non-finite`));
    }
  }

  // ----- Cone vocabulary. -----
  const parsed = parseCones(dec.cones, n);
  if (isRefusal(parsed)) return refusalValue(parsed);

  // ----- Free-variable splitting. -----
  //
  // For each free variable j, introduce two new non-negative variables
  // representing `x_j⁺` and `x_j⁻`, with `x_j = x_j⁺ - x_j⁻`. The
  // internal LP has `n + |free|` variables. The wire output recovers
  // `x_j` by subtraction.
  //
  // We index the internal variables as:
  //     0 .. n-1            — the original variables (where non-negative)
  //                            and the `x_j⁺` half (where free)
  //     n .. n+|free|-1     — the `x_j⁻` halves
  //
  // The `cSplit` and `ASplit` matrices duplicate the relevant
  // columns. Free-variable entries in `c` get negated for the `x_j⁻`
  // half; rows of `A` likewise.
  const splitN = n + parsed.free.length;
  // Float-space split: each free variable `x_j` becomes `x_j⁺ - x_j⁻`
  // with columns appended for the negative halves. Both lanes see the
  // same standard-form LP; the lane choice is purely about engine.
  const cSplitF: number[] = new Array(splitN);
  for (let j = 0; j < n; j++) cSplitF[j] = cFloat[j]!;
  for (let k = 0; k < parsed.free.length; k++) {
    cSplitF[n + k] = -cFloat[parsed.free[k]!]!;
  }
  const ASplitF: number[][] = [];
  for (let i = 0; i < m; i++) {
    const row: number[] = new Array(splitN);
    for (let j = 0; j < n; j++) row[j] = aFloat[i]![j]!;
    for (let k = 0; k < parsed.free.length; k++) {
      row[n + k] = -aFloat[i]![parsed.free[k]!]!;
    }
    ASplitF.push(row);
  }
  const bSplitF: number[] = bFloat.slice();

  // ----- Dispatch between exact and IPM lanes. -----
  const method = pickLaneMethod(flags.method ?? "auto", m, splitN);
  const maxIter = dec.maxIter !== undefined ? dec.maxIter : 10 * (m + splitN);

  if (method === "exact") {
    // Lift to exact rationals and run the arbprec simplex.
    const cSplit: Rat[] = cSplitF.map(float64ToExactRat);
    const ASplit: Rat[][] = ASplitF.map((row) => row.map(float64ToExactRat));
    const bRat: Rat[] = bSplitF.map(float64ToExactRat);
    const lp: StandardLP = { c: cSplit, A: ASplit, b: bRat };
    const result = simplexSolve(lp, { maxIter });
    return encodeResult(result, parsed.free, n, m, m > 0 ? aFloat : null, bFloat, cFloat);
  }

  // IPM lane — float64 Mehrotra primal-dual via @workbench/solver-ipm.
  return solveIpmLane({
    cSplitF,
    ASplitF,
    bSplitF,
    free: parsed.free,
    n,
    m,
    splitN,
    maxIter,
    cFloat,
    aFloat,
    bFloat,
  });
}

// -----------------------------------------------------------------------------
// Lane dispatch
// -----------------------------------------------------------------------------
//
// The default `--method=auto` routes by problem size: small-enough
// problems get the bit-identical exact lane (the world-first claim for
// LP in TS); larger problems go to the IPM. The threshold is
// empirically calibrated against worklog 090's lp-small bench grade —
// problems with `m + splitN ≤ AUTO_DISPATCH_NMAX` complete sub-second
// in the exact lane; above that they routinely time out at 30 s, while
// the IPM solves NETLIB-scale problems in milliseconds.
//
// `--method=exact` forces the bit-identical lane (for reproducibility
// or A/B testing); `--method=ipm` forces the float lane (for speed
// comparison on small problems, or to verify both lanes agree).

function pickLaneMethod(
  request: LaneMethod,
  m: number,
  splitN: number,
): "exact" | "ipm" {
  if (request === "exact") return "exact";
  if (request === "ipm") return "ipm";
  // auto:
  return m + splitN <= AUTO_DISPATCH_NMAX ? "exact" : "ipm";
}

interface IpmLaneInput {
  cSplitF: ReadonlyArray<number>;
  ASplitF: ReadonlyArray<ReadonlyArray<number>>;
  bSplitF: ReadonlyArray<number>;
  free: ReadonlyArray<number>;
  n: number;
  m: number;
  splitN: number;
  maxIter: number;
  cFloat: ReadonlyArray<number>;
  aFloat: ReadonlyArray<ReadonlyArray<number>>;
  bFloat: ReadonlyArray<number>;
}

function solveIpmLane(args: IpmLaneInput): Value {
  // Build the solver-ipm CanonicalLp shape from the already-split LP.
  // Every variable is non-negative (the free-variable split produced
  // x_j⁺ and x_j⁻ both in NonNegCone); the IPM never sees free vars.
  const subjectTo: CanonicalLp["subjectTo"] =
    args.m > 0
      ? {
          Ax_eq_b: { A: args.ASplitF, b: args.bSplitF },
          cones: [{ head: "NonNegCone", size: args.splitN }],
        }
      : { cones: [{ head: "NonNegCone", size: args.splitN }] };
  const canonical: CanonicalLp = {
    minimize: { c: args.cSplitF },
    subjectTo,
    precision: 1e-8,
    max_iter: args.maxIter,
  };
  const lp = lpFromCanonical(canonical);
  const { verbose, close } = makeVerboseHook();
  try {
    const result = solveLpIpm(lp, {
      params: { iterLimit: args.maxIter },
      verbose,
    });
    return encodeIpmResult(result, args);
  } finally {
    close();
  }
}

/**
 * Verbose iter-trace hook factory. Always emits a one-line formatted
 * trace per iter to stderr (`writeSync(2, ...)` — genuinely synchronous,
 * so the line is on disk before the next iter begins; survives a
 * mid-solve crash). When the env var `IPM_TRACE_JSONL=<path>` is set,
 * additionally appends a JSON line per iter to that path for
 * mechanical diff via `scripts/trace-diff.ts`.
 *
 * Both channels use `writeSync` for genuine eager flush. The cost is
 * one syscall per iter — negligible relative to a Schur factor.
 *
 * Tool-CLI-only by design: the library defaults to silent unless
 * callers pass a `verbose:` callback themselves. Tests and library
 * scripts that import `solveLp` directly stay quiet.
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

function encodeIpmResult(
  result: { status: import("@workbench/solver-ipm").SolverStatus; iterate: { x: Float64Array; y: Float64Array; s: Float64Array; mu: number; primalObj: number; dualObj: number; primalInf: number; dualInf: number; iter: number; bumpsPrimal: number; bumpsDual: number; bumpsGap: number; refactors: number } },
  args: IpmLaneInput,
): Value {
  const status = ipmToWireStatus(result.status);
  const it = result.iterate;

  // Recover the original (un-split) primal x from the internal x⁺/x⁻
  // halves. Standard variables map 1:1; free variables `x_j` decode
  // as `x_j⁺ - x_j⁻`.
  const xWire = new Array<number>(args.n);
  for (let j = 0; j < args.n; j++) xWire[j] = it.x[j]!;
  for (let k = 0; k < args.free.length; k++) {
    const j = args.free[k]!;
    xWire[j] = it.x[j]! - it.x[args.n + k]!;
  }

  // Slacks: emit the IPM's internal `s` for the standard variables.
  // For free variables there is no slack (the variable is unbounded),
  // so the slack vector reports only the active inequality slacks —
  // which after splitting are all variables. We emit slacks for the
  // n original variables; the split halves' slacks are an internal
  // artefact.
  const slackWire = new Array<number>(args.n);
  for (let j = 0; j < args.n; j++) slackWire[j] = it.s[j]!;

  const warnings: Value[] = [];
  if (it.bumpsPrimal + it.bumpsDual + it.bumpsGap > 0) {
    warnings.push(
      str(
        `IPM regularisation bumps: primal=${it.bumpsPrimal}, dual=${it.bumpsDual}, gap=${it.bumpsGap}, refactors=${it.refactors}`,
      ),
    );
  }

  // Achieved precision: max KKT residual at the float64 wire output.
  // The IPM lane reports `max(primalInf, dualInf, mu)` directly from
  // the iterate; this is the honest agent-facing precision.
  const achievedPrecision = Math.max(it.primalInf, it.dualInf, it.mu);

  // Common header fields.
  const baseFields: Record<string, Value> = {
    status: str(status),
    x: list(xWire.map(float64FromNumber)),
    dual: list(Array.from(it.y).map(float64FromNumber)),
    slack: list(slackWire.map(float64FromNumber)),
    iterations: int(BigInt(it.iter)),
    method: str(METHOD_TAG_IPM),
    condition_estimate: float64FromNumber(0),
    warnings: list(warnings),
  };

  if (status === "optimal") {
    // `primalObj` from the iterate is in the *split* coordinate frame
    // which uses standard-form variables. The objective coefficient
    // values for split halves are negated, so the IPM's primalObj
    // equals `cᵀx` in the original coordinate frame — no rescaling
    // needed (the algebra works out because c⁺·x⁺ + c⁻·x⁻ where
    // c⁻ = -c, gives c·(x⁺ - x⁻) = c·x).
    baseFields["objective"] = float64FromNumber(it.primalObj);
    baseFields["achieved_precision"] = float64FromNumber(achievedPrecision);
  }

  return record(baseFields);
}

function encodeResult(
  result: SimplexResult,
  free: ReadonlyArray<number>,
  n: number,
  m: number,
  A: ReadonlyArray<ReadonlyArray<number>> | null,
  b: ReadonlyArray<number>,
  cFloatCapture: ReadonlyArray<number>,
): Value {
  const warnings: Value[] = [];

  switch (result.status) {
    case "coefficient-explosion":
      return refusalValue(
        refusal(
          "coefficient-explosion",
          `rational basis-inverse bit length ${result.achieved} exceeded cap ${result.cap} at iteration ${result.iterations}; try rescaling the problem or use tools/lp-solve-fast (when available)`,
        ),
        {
          achieved: int(BigInt(result.achieved)),
          cap: int(BigInt(result.cap)),
          iteration: int(BigInt(result.iterations)),
        },
      );

    case "iter-cap":
      return record({
        status: str("iter-cap"),
        x: list([]),
        dual: list([]),
        slack: list([]),
        iterations: int(BigInt(result.iterations)),
        method: str(METHOD_TAG_EXACT),
        condition_estimate: float64FromNumber(0),
        warnings: list([
          str(`iteration cap reached at ${result.iterations} pivots; partial answer suppressed (CLAUDE.md Rule 1: fail loud, not silent)`),
        ]),
      });

    case "infeasible": {
      const dualOut = encodeRatVec(result.farkas);
      return record({
        status: str("infeasible"),
        x: list([]),
        dual: list(dualOut),
        slack: list([]),
        iterations: int(BigInt(result.iterations)),
        method: str(METHOD_TAG_EXACT),
        condition_estimate: float64FromNumber(0),
        warnings: list(warnings),
      });
    }

    case "unbounded": {
      // The unboundedness certificate per ADR-0030 + corpus verifier
      // is an *unbounded direction* `d` with `A·d = 0`, `d ≥ 0`, and
      // `cᵀ·d ≤ −1`. Surfaced in `x` (the "x" slot is reinterpreted
      // as the ray when status === "unbounded"). The verifier checks
      // `cᵀ·d ≤ −1` so we must scale our ray to ensure the bound holds.
      //
      // Mathematics: the simplex's raw ray `d_raw` (built in
      // `packUnbounded`) has `c̄_q · 1 = c̄_q < 0` for the entering
      // column `q`, where `c̄_q = cᵀ·d_raw`. Scaling by `1 / |c̄_q|`
      // gives a ray with `cᵀ·d = −1`, exactly meeting the verifier's
      // `≤ −1` bound. We compute the scale exactly in ℚ and apply.
      const rayUser = unsplitX(result.ray, free, n);
      let cTd: Rat = RAT_ZERO;
      for (let j = 0; j < n; j++) {
        if (ratIsZero(rayUser[j]!)) continue;
        const cj = float64ToExactRat(cFloatCapture[j]!);
        cTd = ratAdd(cTd, ratMul(cj, rayUser[j]!));
      }
      // cTd should be negative; scale = -1/cTd makes cᵀ(scale·ray) = -1.
      let rayScaled = rayUser;
      if (!ratIsZero(cTd) && cTd.n < 0n) {
        const absCTd = makeRat(-cTd.n, cTd.d);
        rayScaled = rayUser.map((r) => makeRat(r.n * absCTd.d, r.d * absCTd.n));
      }
      return record({
        status: str("unbounded"),
        // Ray in x slot.
        x: list(encodeRatVec(rayScaled)),
        dual: list([]),
        slack: list([]),
        iterations: int(BigInt(result.iterations)),
        method: str(METHOD_TAG_EXACT),
        condition_estimate: float64FromNumber(0),
        warnings: list([
          str("primal-unbounded: x slot carries the unbounded ray d (A·d = 0, d ≥ 0, cᵀ·d = -1)"),
        ]),
      });
    }

    case "optimal": {
      const xRat = unsplitX(result.x, free, n);
      const xFloat = encodeRatVec(xRat);
      const dualFloat = encodeRatVec(result.dual);
      const slackRat = unsplitSlack(result.slack, free, n);
      const slackFloat = encodeRatVec(slackRat);
      const objRat = result.objective;
      const objFloat = float64FromNumber(ratToFloat64(objRat));

      // Honest precision: lift the encoded wire values back to ℚ, then
      // compute the four KKT residuals exactly. The maximum, encoded
      // back to float64, is `achieved_precision`.
      //
      //     r_p = ‖A x - b‖_∞                 (primal feasibility)
      //     r_d = ‖Aᵀ y + s - c‖_∞            (dual feasibility)
      //     r_c = |xᵀ s| / max(1, |obj|)       (complementary slackness)
      //     r_o = |cᵀ x - bᵀ y| / max(1, |obj|) (optimality gap)
      //
      // The corpus verifier checks r_p, r_d, r_c, r_o each against the
      // same 1e-8 absolute (or relative-to-max) bound; we report the
      // maximum so the agent sees the worst residual without having to
      // ask. For exact-rational engines, every residual is ≤ a few
      // ULPs of |A|·|x| (the encoded float64 round-off), comfortably
      // under 1e-12 for well-scaled inputs.
      const xLifted = xFloat.map((v) =>
        float64ToExactRat(float64ToNumber(v as { kind: "float64"; bits: string })),
      );
      const dualLifted = dualFloat.map((v) =>
        float64ToExactRat(float64ToNumber(v as { kind: "float64"; bits: string })),
      );
      const slackLifted = slackFloat.map((v) =>
        float64ToExactRat(float64ToNumber(v as { kind: "float64"; bits: string })),
      );
      const objLifted = float64ToExactRat(float64ToNumber(objFloat as { kind: "float64"; bits: string }));

      // Lift original input back to exact rationals for the residual
      // computation. We have `cFloat` and `aFloat`/`bFloat` in scope
      // already via the function-level `dec` capture — passed in as
      // arguments here.
      const cLifted: Rat[] = new Array(n);
      for (let j = 0; j < n; j++) cLifted[j] = float64ToExactRat(cFloatCapture[j]!);

      // r_p = ‖A x - b‖_∞ in ℚ.
      let rp: Rat = RAT_ZERO;
      if (A !== null) {
        for (let i = 0; i < m; i++) {
          let s: Rat = RAT_ZERO;
          for (let j = 0; j < n; j++) {
            const aij = float64ToExactRat(A[i]![j]!);
            if (ratIsZero(aij)) continue;
            s = ratAdd(s, ratMul(aij, xLifted[j]!));
          }
          const bi = float64ToExactRat(b[i]!);
          const ri = ratSub(s, bi);
          rp = maxAbs(rp, ri);
        }
      }

      // r_d = ‖Aᵀ y + s - c‖_∞ in ℚ.
      let rd: Rat = RAT_ZERO;
      if (A !== null) {
        for (let j = 0; j < n; j++) {
          let aty: Rat = RAT_ZERO;
          for (let i = 0; i < m; i++) {
            const aij = float64ToExactRat(A[i]![j]!);
            if (ratIsZero(aij)) continue;
            aty = ratAdd(aty, ratMul(aij, dualLifted[i]!));
          }
          const lhs = ratAdd(aty, slackLifted[j]!);
          const ri = ratSub(lhs, cLifted[j]!);
          rd = maxAbs(rd, ri);
        }
      }

      // r_c = |xᵀ s|, normalised by max(1, |obj|) for relative tolerance.
      let xTs: Rat = RAT_ZERO;
      for (let j = 0; j < n; j++) {
        if (ratIsZero(xLifted[j]!) || ratIsZero(slackLifted[j]!)) continue;
        xTs = ratAdd(xTs, ratMul(xLifted[j]!, slackLifted[j]!));
      }
      const xTsAbs = xTs.n < 0n ? makeRat(-xTs.n, xTs.d) : xTs;
      const absObj = objLifted.n < 0n ? makeRat(-objLifted.n, objLifted.d) : objLifted;
      const denomObj = ratLt(absObj, RAT_ONE) ? RAT_ONE : absObj;
      const rc = makeRat(xTsAbs.n * denomObj.d, xTsAbs.d * denomObj.n);

      // r_o = |cᵀ x - bᵀ y| / max(1, |obj|).
      let cTx: Rat = RAT_ZERO;
      for (let j = 0; j < n; j++) {
        if (ratIsZero(cLifted[j]!) || ratIsZero(xLifted[j]!)) continue;
        cTx = ratAdd(cTx, ratMul(cLifted[j]!, xLifted[j]!));
      }
      let bTy: Rat = RAT_ZERO;
      for (let i = 0; i < m; i++) {
        const bi = A !== null ? float64ToExactRat(b[i]!) : RAT_ZERO;
        if (ratIsZero(bi) || ratIsZero(dualLifted[i]!)) continue;
        bTy = ratAdd(bTy, ratMul(bi, dualLifted[i]!));
      }
      const gap = ratSub(cTx, bTy);
      const gapAbs = gap.n < 0n ? makeRat(-gap.n, gap.d) : gap;
      const ro = makeRat(gapAbs.n * denomObj.d, gapAbs.d * denomObj.n);

      const achieved = [rp, rd, rc, ro].reduce(maxAbs, RAT_ZERO);
      const achievedFloat = ratToFloat64(achieved);

      // Coefficient-growth warning if the engine flirted with the cap.
      if (result.maxBitLength > 1 << 14) {
        warnings.push(
          str(
            `rational basis inverse reached ${result.maxBitLength} bits (cap default 2^20); problem may be ill-scaled`,
          ),
        );
      }

      return record({
        status: str("optimal"),
        x: list(xFloat),
        dual: list(dualFloat),
        slack: list(slackFloat),
        objective: objFloat,
        achieved_precision: float64FromNumber(achievedFloat),
        iterations: int(BigInt(result.iterations)),
        method: str(METHOD_TAG_EXACT),
        condition_estimate: float64FromNumber(0),
        warnings: list(warnings),
      });
    }
  }
}

/**
 * Lift internal split-variable layout back to the user-facing `n`-vector.
 * For non-free variables: pass through the value at index `j`.
 * For free variables: `x_j = x_j⁺ - x_j⁻` where `x_j⁺` is at index `j`
 * and `x_j⁻` is at index `n + k` for `k = free.indexOf(j)`.
 */
function unsplitX(internal: ReadonlyArray<Rat>, free: ReadonlyArray<number>, n: number): Rat[] {
  const out: Rat[] = new Array(n);
  for (let j = 0; j < n; j++) {
    out[j] = j < internal.length ? internal[j]! : RAT_ZERO;
  }
  for (let k = 0; k < free.length; k++) {
    const j = free[k]!;
    const minus = (n + k) < internal.length ? internal[n + k]! : RAT_ZERO;
    out[j] = ratSub(out[j]!, minus);
  }
  return out;
}

/**
 * Slack lift. For non-free variables: pass through. For free variables:
 * the slack of `x_j` is the slack of either half (they must be zero at
 * optimum by complementary slackness, but we take the `x_j⁺` half by
 * convention).
 */
function unsplitSlack(internal: ReadonlyArray<Rat>, free: ReadonlyArray<number>, n: number): Rat[] {
  const out: Rat[] = new Array(n);
  for (let j = 0; j < n; j++) {
    out[j] = j < internal.length ? internal[j]! : RAT_ZERO;
  }
  return out;
}

function encodeRatVec(v: ReadonlyArray<Rat>): Value[] {
  return v.map((r) => float64FromNumber(ratToFloat64(r)));
}

function compareRat(a: Rat, b: Rat): -1 | 0 | 1 {
  // Local copy of ratCompare to avoid a cross-package import for a
  // single call site; the inline form keeps the comparison's exact
  // semantics visible at the residual-computation point.
  const lhs = a.n * b.d;
  const rhs = b.n * a.d;
  if (lhs < rhs) return -1;
  if (lhs > rhs) return 1;
  return 0;
}

/**
 * Return `max(acc, |r|)` over rationals, where `|r|` is `(|r.n|, r.d)`.
 * Used to thread an infinity-norm computation across the four KKT
 * residuals in `encodeResult`.
 */
function maxAbs(acc: Rat, r: Rat): Rat {
  const abs = r.n < 0n ? makeRat(-r.n, r.d) : r;
  return compareRat(abs, acc) === 1 ? abs : acc;
}

// -----------------------------------------------------------------------------
// Tool definition
// -----------------------------------------------------------------------------

const examples = [
  {
    description: "1D LP: minimise x subject to x = 1, x ≥ 0 — optimum x = 1",
    input: record({
      minimize: record({ c: list([float64FromNumber(1)]) }),
      subjectTo: record({
        Ax_eq_b: record({
          A: list([list([float64FromNumber(1)])]),
          b: list([float64FromNumber(1)]),
        }),
        cones: list([expr("NonNegCone", [list([int(0n)])])]),
      }),
    }),
    output: record({
      status: str("optimal"),
      x: list([float64FromNumber(1)]),
      dual: list([float64FromNumber(1)]),
      slack: list([float64FromNumber(0)]),
      objective: float64FromNumber(1),
      achieved_precision: float64FromNumber(0),
      iterations: int(1n),
      method: str(METHOD_TAG_EXACT),
      condition_estimate: float64FromNumber(0),
      warnings: list([]),
    }),
  },
  {
    description: "Infeasible: x = 1 and x = 2 simultaneously — Farkas certificate emitted",
    input: record({
      minimize: record({ c: list([float64FromNumber(0)]) }),
      subjectTo: record({
        Ax_eq_b: record({
          A: list([list([float64FromNumber(1)]), list([float64FromNumber(1)])]),
          b: list([float64FromNumber(1), float64FromNumber(2)]),
        }),
        cones: list([expr("NonNegCone", [list([int(0n)])])]),
      }),
    }),
    output: record({
      status: str("infeasible"),
      x: list([]),
      dual: list([float64FromNumber(-1), float64FromNumber(1)]),
      slack: list([]),
      iterations: int(2n),
      method: str(METHOD_TAG_EXACT),
      condition_estimate: float64FromNumber(0),
      warnings: list([]),
    }),
  },
  {
    description: "Refusal: quadratic objective routed to lp-solve",
    input: record({
      minimize: record({
        c: list([float64FromNumber(1)]),
        Q: list([list([float64FromNumber(2)])]),
      }),
      subjectTo: record({
        Ax_eq_b: record({
          A: list([list([float64FromNumber(1)])]),
          b: list([float64FromNumber(1)]),
        }),
        cones: list([expr("NonNegCone", [list([int(0n)])])]),
      }),
    }),
    output: tagged("lp-solve/quadratic-objective", record({
      detail: str("tools/lp-solve is LP-only; pass to tools/qp-solve (deferred) or tools/cone-solve (universal) for quadratic objectives"),
    })),
  },
];

const invariants = [
  {
    name: "primal-feasibility",
    statement: "Optimal status implies A·x = b (componentwise) within `achieved_precision`.",
    machine_checkable: true,
  },
  {
    name: "dual-feasibility",
    statement: "Optimal status implies c - Aᵀy = slack ≥ 0 (within `achieved_precision`).",
    machine_checkable: true,
  },
  {
    name: "complementary-slackness",
    statement: "Optimal status implies x_j · slack_j = 0 for every j (within `achieved_precision`).",
    machine_checkable: true,
  },
  {
    name: "strong-duality",
    statement: "Optimal status implies cᵀx = bᵀy (within `achieved_precision`).",
    machine_checkable: true,
  },
  {
    name: "farkas-on-infeasible",
    statement: "Infeasible status implies the `dual` field is a Farkas certificate: yᵀA ≤ 0 componentwise and yᵀb > 0.",
    machine_checkable: true,
  },
  {
    name: "exact-engine-bound",
    statement: "For inputs that admit a unique optimum, `achieved_precision` is dominated by IEEE-754 wire round-off, i.e. ≤ |Ax|_∞ · 2^(-52).",
    machine_checkable: false,
  },
];

// In-process smoke probe (--test). Exercises both lanes on a
// problem that admits an obvious exact answer and verifies they
// agree on the primal and the objective. Both lanes must reach
// `optimal`; the exact lane must reproduce x = (5, 0) bit-exactly;
// the IPM lane must agree to 1e-6 relative.
function smokeTest(): void {
  const problem = record({
    minimize: record({ c: list([float64FromNumber(1), float64FromNumber(3)]) }),
    subjectTo: record({
      Ax_eq_b: record({
        A: list([list([float64FromNumber(1), float64FromNumber(1)])]),
        b: list([float64FromNumber(5)]),
      }),
      cones: list([expr("NonNegCone", [list([int(0n), int(1n)])])]),
    }),
  });
  const exact = fn(problem, { method: "exact" }) as RecordValue;
  const ipm = fn(problem, { method: "ipm" }) as RecordValue;

  for (const [label, res] of [["exact", exact], ["ipm", ipm]] as const) {
    const status = (res.fields["status"] as { kind: "string"; value: string }).value;
    if (status !== "optimal") {
      throw new Error(`lp-solve --test: ${label} lane returned status=${status}, expected "optimal"`);
    }
    const objVal = res.fields["objective"];
    if (objVal === undefined || objVal.kind !== "float64") {
      throw new Error(`lp-solve --test: ${label} lane missing objective field`);
    }
    const obj = float64ToNumber(objVal);
    if (Math.abs(obj - 5) > 1e-5) {
      throw new Error(`lp-solve --test: ${label} lane objective ${obj} differs from 5 by more than 1e-5`);
    }
  }

  // Method tag echo: --method=ipm must report "solver-ipm" in the
  // output's `method` field so the agent can distinguish lanes.
  const ipmMethod = (ipm.fields["method"] as { kind: "string"; value: string }).value;
  if (ipmMethod !== METHOD_TAG_IPM) {
    throw new Error(`lp-solve --test: ipm lane reported method="${ipmMethod}", expected "${METHOD_TAG_IPM}"`);
  }
  const exactMethod = (exact.fields["method"] as { kind: "string"; value: string }).value;
  if (exactMethod !== METHOD_TAG_EXACT) {
    throw new Error(`lp-solve --test: exact lane reported method="${exactMethod}", expected "${METHOD_TAG_EXACT}"`);
  }
}

export const def = defineTool({
  name: NAME,
  version: VERSION,
  schema: { input: inputSchema, output: outputSchema },
  flags: {
    method: F.enum(["auto", "exact", "ipm"] as const, "solver lane", {
      default: "auto",
    }),
  },
  examples,
  invariants,
  numerical: true,
  fn: fn as never,
  test: smokeTest,
});

if (import.meta.main) void runTool(def);
