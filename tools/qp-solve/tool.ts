// tools/qp-solve — convex quadratic-programming specialist of the
// cone-solver tier (ADR-0030 §B; decision record ADR-0044).
//
// Intent
// ------
// A TS expert who has *already classified* their problem as a convex QP
// and wants higher accuracy than `cone-solve`'s 1e-6 ceiling types
// `wb.run("qp-solve", problem)` and gets back a `record` with the primal
// `x`, the equality dual `y`, the bound multipliers `slack`, the
// objective, an honest `achieved_precision`, and — the QP-specific extra
// output — the `active_set`: which `x ≥ 0` bounds are tight at the
// optimum together with their Lagrange multipliers. `qp-solve` is the
// specialist next to the universal `cone-solve`, exactly as `radix-sort`
// sits beside `Array.prototype.sort`: faster and more accurate on the
// known structure (a quadratic objective + the nonnegative orthant),
// with an accuracy ceiling of 1e-10.
//
// The wire-and-engine sandwich
// ----------------------------
// The wire shape is ADR-0030 §C/§D verbatim — the same cone-tier record
// `lp-solve` mirrors — with the single difference that `minimize.Q` (the
// symmetric PSD Hessian) is **required**, not the field `lp-solve`
// declares only to refuse. Between decode and encode runs the
// arbitrary-structure-free numerical core in `@workbench/solver-ipm`:
// `solveQp`, a Mehrotra primal-dual predictor-corrector interior-point
// method whose Newton step factors the *augmented* quasidefinite KKT
// system, not the normal-equations Schur the LP path uses.
//
// Algorithm — why the augmented SQD factorization
// ------------------------------------------------
// The QP Newton step (docs/ground-truth/convex/qp-ipm.md §3) reduces to a
// saddle system whose (1,1) block is `Q + X⁻¹S` — dense, because `Q` is.
// The LP path's further reduction to the `m×m` normal-equations Schur
// `M = A(Q+X⁻¹S)⁻¹Aᵀ` is *available* but **squares the conditioning**:
// near the optimum `X⁻¹S` spans `≈ μ … 1/μ`, so `cond(M) ≈ cond(K)² ≈
// 1e20` at a 1e-10 target — past float64. (The in-tree witness is
// `IterativeRefinement.ts`: the LP normal-equations Schur stalls at
// `pInf ≈ 1.26e-7` on `hinf2` at `cond ≈ 1e13`.) The augmented system
// keeps `cond(K) ≈ 1/μ` — the √ of that — which is the only regime with
// float64 headroom for the 1e-10 ceiling that is this tool's reason to
// exist.
//
// The augmented matrix, dual-regularized, is **symmetric quasidefinite**
// (negative-definite (1,1), positive-definite (2,2)); by Vanderbei's
// theorem it factors stably with a **static-order signed Cholesky LDLᵀ**
// — no pivot search — so the factorization order is a function of `(n,m)`
// alone and the `numerical: true` determinism contract holds with zero
// pivot-determinism surface. Regularization is the signed Friedlander–
// Orban scheme (`−ρ` on the primal block, `+δ` on the dual block), a
// proximal step toward a nearby well-posed QP. See ADR-0044 for the full
// rationale and the rejected alternatives (nested-Schur, Bunch–Kaufman).
//
// Boundary categories (ADR-0003)
// ------------------------------
// Routine non-success is **record-with-flag**: the `status` string
// carries the 5-class termination taxonomy (`optimal` / `infeasible` /
// `unbounded` / `iter-cap` / `numerical-breakdown`), and `objective`/
// `achieved_precision` are absent on the non-optimal classes. Boundary
// failure is **tagged** `qp-solve/<class>`: `non-convex-objective`
// (a non-PSD `Q`), `non-finite-input`, `degenerate-shape`,
// `free-variable-unsupported` (v0.1 requires every variable to be
// declared nonnegative — free variables are an honest out-of-scope, not
// a wrong answer), `malformed-cone`, `non-nonneg-cone` (only the
// nonnegative orthant is in scope — SOC/PSD/EXP/POW go to `cone-solve`).
// Malformed input that violates the schema is a `ToolError` (the runner
// handles it).
//
// Two honest-scope notes (Rule 8). (1) `condition_estimate` is a
// reserved output field: v0.1 emits `0` (a real Hager-1-norm estimate is
// a v0.2 item, bead-tracked) — `0` is the documented placeholder, not a
// computed conditioning. (2) v0.1 has no `precision-unreachable` refusal:
// a converged-but-loose solve is reported as `optimal` carrying a large
// honest `achieved_precision = max(primalInf, dualInf, μ)`; the caller
// reads that field to judge the achieved accuracy. Infeasible / unbounded
// detection uses iteration-bounded Farkas-style certificates inherited
// from the LP path and is best-effort: some hard infeasible instances
// surface as `iter-cap` rather than `infeasible` (bead-tracked v0.2).
//
// References
// ----------
// docs/ground-truth/convex/qp-ipm.md (the transcription this code
// cites); ADR-0030 §B (the tier); ADR-0044 (the augmented-SQD decision);
// Nocedal–Wright Ch.16, Wright 1997 §11, Mehrotra 1992, Vanderbei 1995,
// Friedlander–Orban 2012. Port from paper, never from solver source
// (ADR-0030 §E).

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
  solveQp,
  qpFromCanonical,
  toWireStatus,
  type CanonicalQp,
  type QpProblem,
  type QpSolveResult,
} from "@workbench/solver-ipm";
import { eigh, type Matrix } from "@workbench/linalg-core";

const NAME = "qp-solve";
const VERSION = "0.1.0";
const METHOD_TAG = "solver-ipm-qp-sqd";

// Relative eigenvalue floor for the PSD test of Q (qp-ipm.md §7).
const PSD_REL_FLOOR = 1e-8;

// -----------------------------------------------------------------------------
// Schema (ADR-0030 §C input + §D output, with Q required and active_set added)
// -----------------------------------------------------------------------------

const inputSchema = S.record(
  {
    minimize: S.record({
      c: S.list(S.kind("float64")),
      Q: S.list(S.list(S.kind("float64"))),
    }),
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
      active_set: S.list(
        S.record({ index: S.kind("integer"), multiplier: S.kind("float64") }),
      ),
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
// Refusal envelopes (ADR-0003 boundary failure → tagged "qp-solve/<class>")
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
// Decode (the schema has already guaranteed shape; lift to typed JS)
// -----------------------------------------------------------------------------

interface Decoded {
  c: number[];
  Q: number[][];
  A: number[][];
  b: number[];
  cones: readonly Value[];
  precision: number | undefined;
  maxIter: number | undefined;
}

function decodeInput(input: RecordValue): Decoded {
  const fields = input.fields;
  const minimize = (fields["minimize"] as RecordValue).fields;
  const subjectTo = (fields["subjectTo"] as RecordValue).fields;

  const cList = (minimize["c"] as { kind: "list"; items: Value[] }).items;
  const c = cList.map((v) => float64ToNumber(v as { kind: "float64"; bits: string }));

  const Qrows = (minimize["Q"] as { kind: "list"; items: Value[] }).items;
  const Q = Qrows.map((row) =>
    (row as { kind: "list"; items: Value[] }).items.map((v) =>
      float64ToNumber(v as { kind: "float64"; bits: string }),
    ),
  );

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
  const precision =
    "precision" in fields
      ? float64ToNumber(fields["precision"] as { kind: "float64"; bits: string })
      : undefined;
  const maxIter =
    "max_iter" in fields
      ? Number(BigInt((fields["max_iter"] as { kind: "integer"; value: string }).value))
      : undefined;
  return { c, Q, A, b, cones, precision, maxIter };
}

// Parse the `cones` list into the nonnegative-orthant mask, enforcing the
// v0.1 scope: every variable must be declared in a `NonNegCone`. A
// missing variable is a free variable (`free-variable-unsupported`); any
// non-`NonNegCone` head is out of scope (`non-nonneg-cone`).
function parseConesNonNeg(cones: readonly Value[], n: number): RefusalEnvelope | Uint8Array {
  const mask = new Uint8Array(n);
  for (const cone of cones) {
    if (cone.kind !== "expression") {
      return refusal("malformed-cone", `cone is not an expression: kind=${cone.kind}`);
    }
    const head = cone.head;
    if (head !== "NonNegCone") {
      return refusal(
        "non-nonneg-cone",
        `qp-solve handles only the nonnegative orthant (NonNegCone); got "${head}". Use tools/cone-solve for SOC/PSD/EXP/POW cones.`,
      );
    }
    const args = cone.args ?? [];
    const idxList = args[0];
    if (idxList === undefined || idxList.kind !== "list") {
      return refusal("malformed-cone", `NonNegCone expects a list of integer indices as its argument`);
    }
    for (const idxV of idxList.items) {
      if (idxV.kind !== "integer") {
        return refusal("malformed-cone", `NonNegCone index is not an integer: kind=${idxV.kind}`);
      }
      const idx = Number(BigInt(idxV.value));
      if (idx < 0 || idx >= n) {
        return refusal("malformed-cone", `NonNegCone index ${idx} out of range [0, ${n})`);
      }
      mask[idx] = 1;
    }
  }
  for (let j = 0; j < n; j++) {
    if (mask[j] === 0) {
      return refusal(
        "free-variable-unsupported",
        `variable x[${j}] is not declared nonnegative. qp-solve v0.1 requires every variable in a NonNegCone (standard form x ≥ 0). Split a free variable as x = x⁺ − x⁻, or model it via tools/cone-solve.`,
      );
    }
  }
  return mask;
}

// PSD validation of the (symmetrized) Hessian (qp-ipm.md §7). Returns a
// refusal for a non-convex (indefinite-below-floor) Q, else the spectrum
// summary used for diagnostics.
function validatePsd(Q: number[][], n: number): RefusalEnvelope | { minEig: number; maxEig: number } {
  // Symmetrize for the eigensolver (the decoder's QpProblem build does
  // the same before the solver consumes Q).
  const data = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) data[i * n + j] = 0.5 * (Q[i]![j]! + Q[j]![i]!);
  }
  const mat: Matrix = { rows: n, cols: n, data };
  const { eigenvalues } = eigh(mat);
  const minEig = eigenvalues[0]!;
  const maxEig = eigenvalues[n - 1]!;
  const floor = PSD_REL_FLOOR * Math.max(1, Math.abs(maxEig));
  if (minEig < -floor) {
    return refusal(
      "non-convex-objective",
      `Q is not positive semidefinite: min eigenvalue ${minEig.toExponential(3)} < −${floor.toExponential(3)}. qp-solve solves convex QPs only (Q ⪰ 0).`,
    );
  }
  return { minEig, maxEig };
}

// -----------------------------------------------------------------------------
// fn
// -----------------------------------------------------------------------------

function fn(input: RecordValue): Value {
  const dec = decodeInput(input);
  const n = dec.c.length;

  // ----- Finiteness + shape. -----
  for (let j = 0; j < n; j++) {
    if (!Number.isFinite(dec.c[j]!)) {
      return refusalValue(refusal("non-finite-input", `c[${j}] = ${dec.c[j]} is non-finite`));
    }
  }
  if (dec.Q.length !== n) {
    return refusalValue(
      refusal("degenerate-shape", `Q has ${dec.Q.length} rows but c has length ${n}`),
    );
  }
  for (let i = 0; i < n; i++) {
    if (dec.Q[i]!.length !== n) {
      return refusalValue(
        refusal("degenerate-shape", `Q[${i}] has ${dec.Q[i]!.length} columns but c has length ${n}`),
      );
    }
    for (let j = 0; j < n; j++) {
      if (!Number.isFinite(dec.Q[i]![j]!)) {
        return refusalValue(
          refusal("non-finite-input", `Q[${i}][${j}] = ${dec.Q[i]![j]} is non-finite`),
        );
      }
    }
  }

  const m = dec.A.length;
  if (dec.b.length !== m) {
    return refusalValue(
      refusal("degenerate-shape", `A has ${m} rows but b has length ${dec.b.length}`),
    );
  }
  for (let i = 0; i < m; i++) {
    if (dec.A[i]!.length !== n) {
      return refusalValue(
        refusal("degenerate-shape", `A[${i}] has ${dec.A[i]!.length} columns but c has length ${n}`),
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
      return refusalValue(refusal("non-finite-input", `b[${i}] = ${dec.b[i]} is non-finite`));
    }
  }
  if (n === 0) {
    return refusalValue(refusal("degenerate-shape", `empty problem: c has length 0`));
  }

  // ----- Cone vocabulary / nonnegative-orthant scope. -----
  const mask = parseConesNonNeg(dec.cones, n);
  if (isRefusal(mask)) return refusalValue(mask);

  // ----- Convexity (PSD of Q). -----
  const psd = validatePsd(dec.Q, n);
  if (isRefusal(psd)) return refusalValue(psd);

  // ----- Build the canonical QP and solve. -----
  const precision = dec.precision !== undefined && dec.precision > 0 ? dec.precision : 1e-8;
  const canonical: CanonicalQp = {
    minimize: { c: dec.c, Q: dec.Q },
    subjectTo:
      m > 0
        ? { Ax_eq_b: { A: dec.A, b: dec.b }, cones: [{ head: "NonNegCone", size: n }] }
        : { cones: [{ head: "NonNegCone", size: n }] },
    precision,
    ...(dec.maxIter !== undefined ? { max_iter: dec.maxIter } : {}),
  };
  const qp = qpFromCanonical(canonical);
  const maxIter = dec.maxIter !== undefined ? dec.maxIter : 100;
  const result = solveQp(qp, {
    params: { feasTol: precision, optTol: precision, iterLimit: maxIter },
  });

  return encodeResult(result, qp, precision);
}

// -----------------------------------------------------------------------------
// Encode (ADR-0030 §D record + active_set)
// -----------------------------------------------------------------------------

function encodeResult(result: QpSolveResult, qp: QpProblem, precision: number): Value {
  const status = toWireStatus(result.status);
  const it = result.iterate;

  const warnings: Value[] = [];
  if (it.bumpsRho + it.bumpsDelta > 0) {
    warnings.push(
      str(
        `QP regularisation bumps: rho=${it.bumpsRho}, delta=${it.bumpsDelta}, refactors=${it.refactors}`,
      ),
    );
  }

  const achievedPrecision = Math.max(it.primalInf, it.dualInf, it.mu);

  // active_set: bounds x_i ≥ 0 that are tight at the optimum, with their
  // multipliers s_i (qp-ipm.md §8). Geometric-mean thresholds on the
  // complementarity gap; near-degenerate indices (both small) are omitted
  // rather than asserted (honest scope, Rule 8).
  const sqrtP = Math.sqrt(precision);
  let xInf = 1;
  let sInf = 1;
  for (let j = 0; j < qp.n; j++) {
    xInf = Math.max(xInf, Math.abs(it.x[j]!));
    sInf = Math.max(sInf, Math.abs(it.s[j]!));
  }
  const tolX = sqrtP * xInf;
  const tolS = sqrtP * sInf;
  const activeSet: Value[] = [];
  if (status === "optimal") {
    for (let j = 0; j < qp.n; j++) {
      if (it.x[j]! <= tolX && it.s[j]! >= tolS) {
        activeSet.push(
          record({ index: int(BigInt(j)), multiplier: float64FromNumber(it.s[j]!) }),
        );
      }
    }
  }

  const baseFields: Record<string, Value> = {
    status: str(status),
    x: list(Array.from(it.x.subarray(0, qp.n)).map(float64FromNumber)),
    dual: list(Array.from(it.y).map(float64FromNumber)),
    slack: list(Array.from(it.s.subarray(0, qp.n)).map(float64FromNumber)),
    active_set: list(activeSet),
    iterations: int(BigInt(it.iter)),
    method: str(METHOD_TAG),
    condition_estimate: float64FromNumber(0),
    warnings: list(warnings),
  };
  if (status === "optimal") {
    baseFields["objective"] = float64FromNumber(it.primalObj);
    baseFields["achieved_precision"] = float64FromNumber(achievedPrecision);
  }
  return record(baseFields);
}

// -----------------------------------------------------------------------------
// Examples (→ goldens) — one per code path. Optimal outputs are
// snapshotted by the generator; refusal outputs are exact and provided.
// -----------------------------------------------------------------------------

// NB: these example builders deliberately carry NO explicit return-type
// annotation. `defineTool` infers the precise schema-derived Value types
// for `examples` (under `exactOptionalPropertyTypes`); annotating these
// as `: Value` would widen them and break that inference.
function nnCone(n: number) {
  const idx = [];
  for (let i = 0; i < n; i++) idx.push(int(BigInt(i)));
  return expr("NonNegCone", [list(idx)]);
}
const f = float64FromNumber;
const vecF = (xs: number[]) => list(xs.map(f));
const matF = (rows: number[][]) => list(rows.map(vecF));

const examples = [
  {
    description: "Unconstrained convex QP: min ½xᵀdiag(2,4)x − 2x₁ − 8x₂ ⇒ x* = (1,2)",
    input: record({
      minimize: record({ c: vecF([-2, -8]), Q: matF([[2, 0], [0, 4]]) }),
      subjectTo: record({ cones: list([nnCone(2)]) }),
    }),
  },
  {
    description: "Equality-constrained QP: min ½‖x‖² s.t. x₁+x₂=1 ⇒ x* = (½,½)",
    input: record({
      minimize: record({ c: vecF([0, 0]), Q: matF([[1, 0], [0, 1]]) }),
      subjectTo: record({
        Ax_eq_b: record({ A: matF([[1, 1]]), b: vecF([1]) }),
        cones: list([nnCone(2)]),
      }),
    }),
  },
  {
    description: "Active inequality via slack (PSD-nullspace Q): min ½(x₁²+x₂²) s.t. x₁+x₂−ξ=1 ⇒ x*=(½,½,0), ξ active",
    input: record({
      minimize: record({ c: vecF([0, 0, 0]), Q: matF([[1, 0, 0], [0, 1, 0], [0, 0, 0]]) }),
      subjectTo: record({
        Ax_eq_b: record({ A: matF([[1, 1, -1]]), b: vecF([1]) }),
        cones: list([nnCone(3)]),
      }),
    }),
  },
  {
    description: "Coupled off-diagonal Q with equality: min ½(2x₁²+2x₁x₂+2x₂²)−x₁ s.t. x₁+x₂=1",
    input: record({
      minimize: record({ c: vecF([-1, 0]), Q: matF([[2, 1], [1, 2]]) }),
      subjectTo: record({
        Ax_eq_b: record({ A: matF([[1, 1]]), b: vecF([1]) }),
        cones: list([nnCone(2)]),
      }),
    }),
  },
  {
    description: "Q=0 LP reduction: min x₁+2x₂ s.t. x₁+x₂=1, x≥0 ⇒ x*=(1,0)",
    input: record({
      minimize: record({ c: vecF([1, 2]), Q: matF([[0, 0], [0, 0]]) }),
      subjectTo: record({
        Ax_eq_b: record({ A: matF([[1, 1]]), b: vecF([1]) }),
        cones: list([nnCone(2)]),
      }),
    }),
  },
  {
    description: "Refusal: non-convex (indefinite) Q",
    input: record({
      minimize: record({ c: vecF([0, 0]), Q: matF([[1, 0], [0, -1]]) }),
      subjectTo: record({ cones: list([nnCone(2)]) }),
    }),
    output: tagged(
      "qp-solve/non-convex-objective",
      record({
        detail: str(
          "Q is not positive semidefinite: min eigenvalue -1.000e+0 < −1.000e-8. qp-solve solves convex QPs only (Q ⪰ 0).",
        ),
      }),
    ),
  },
  {
    description: "Refusal: free variable (not declared nonnegative)",
    input: record({
      minimize: record({ c: vecF([0, 0]), Q: matF([[1, 0], [0, 1]]) }),
      subjectTo: record({ cones: list([expr("NonNegCone", [list([int(0n)])])]) }),
    }),
    output: tagged(
      "qp-solve/free-variable-unsupported",
      record({
        detail: str(
          "variable x[1] is not declared nonnegative. qp-solve v0.1 requires every variable in a NonNegCone (standard form x ≥ 0). Split a free variable as x = x⁺ − x⁻, or model it via tools/cone-solve.",
        ),
      }),
    ),
  },
  {
    description: "Refusal: a non-nonnegative cone (out of qp-solve scope)",
    input: record({
      minimize: record({ c: vecF([0, 0]), Q: matF([[1, 0], [0, 1]]) }),
      subjectTo: record({ cones: list([expr("SOCone", [list([int(0n), int(1n)])])]) }),
    }),
    output: tagged(
      "qp-solve/non-nonneg-cone",
      record({
        detail: str(
          'qp-solve handles only the nonnegative orthant (NonNegCone); got "SOCone". Use tools/cone-solve for SOC/PSD/EXP/POW cones.',
        ),
      }),
    ),
  },
  {
    description: "Refusal: non-finite input (NaN in c)",
    input: record({
      minimize: record({ c: list([f(NaN), f(0)]), Q: matF([[1, 0], [0, 1]]) }),
      subjectTo: record({ cones: list([nnCone(2)]) }),
    }),
    output: tagged(
      "qp-solve/non-finite-input",
      record({ detail: str("c[0] = NaN is non-finite") }),
    ),
  },
  {
    description: "Refusal: degenerate shape (Q rows ≠ length of c)",
    input: record({
      minimize: record({ c: vecF([0, 0]), Q: matF([[1]]) }),
      subjectTo: record({ cones: list([nnCone(2)]) }),
    }),
    output: tagged(
      "qp-solve/degenerate-shape",
      record({ detail: str("Q has 1 rows but c has length 2") }),
    ),
  },
  {
    description: "Refusal: malformed cone (index out of range)",
    input: record({
      minimize: record({ c: vecF([0, 0]), Q: matF([[1, 0], [0, 1]]) }),
      subjectTo: record({
        cones: list([expr("NonNegCone", [list([int(0n), int(1n), int(5n)])])]),
      }),
    }),
    output: tagged(
      "qp-solve/malformed-cone",
      record({ detail: str("NonNegCone index 5 out of range [0, 2)") }),
    ),
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
    statement: "Optimal status implies Qx + c − Aᵀy = slack ≥ 0 (within `achieved_precision`).",
    machine_checkable: true,
  },
  {
    name: "complementary-slackness",
    statement: "Optimal status implies x_j · slack_j = 0 for every j (within `achieved_precision`).",
    machine_checkable: true,
  },
  {
    name: "convexity-refusal",
    statement: "A non-PSD Q (min eigenvalue below −1e-8·|λ_max|) is refused with `qp-solve/non-convex-objective`, never solved.",
    machine_checkable: true,
  },
  {
    name: "active-set-certificate",
    statement: "Each reported active index i has x_i ≈ 0 and a nonnegative multiplier slack_i; the active set plus the dual y reconstructs the reduced-KKT stationarity.",
    machine_checkable: true,
  },
  {
    name: "lp-reduction",
    statement: "With Q = 0 the QP reduces to an LP and the optimum agrees with tools/lp-solve.",
    machine_checkable: true,
  },
];

// In-process smoke probe (--test). Asserts genuine invariants (Rule 7)
// across three facets: (1) a known-optimum solve (status/primal/objective/
// method/achieved_precision honesty); (2) the QP-defining `active_set`
// output on a known-active case; (3) the absent-field contract on a
// non-optimal (iter-cap) record.
function fields(v: Value): Record<string, Value> {
  return (v as RecordValue).fields;
}
function strField(v: Value, k: string): string {
  return (fields(v)[k] as { kind: "string"; value: string }).value;
}
function numList(v: Value, k: string): number[] {
  return (fields(v)[k] as { kind: "list"; items: Value[] }).items.map((x) =>
    float64ToNumber(x as { kind: "float64"; bits: string }),
  );
}

function smokeTest(): void {
  // (1) min ½‖x‖² s.t. x₁+x₂=1 ⇒ x* = (½,½), objective ¼.
  const problem = record({
    minimize: record({ c: vecF([0, 0]), Q: matF([[1, 0], [0, 1]]) }),
    subjectTo: record({
      Ax_eq_b: record({ A: matF([[1, 1]]), b: vecF([1]) }),
      cones: list([nnCone(2)]),
    }),
  });
  const res = fn(problem) as RecordValue;
  if (strField(res, "status") !== "optimal") {
    throw new Error(`qp-solve --test: status=${strField(res, "status")}, expected "optimal"`);
  }
  const xs = numList(res, "x");
  if (Math.abs(xs[0]! - 0.5) > 1e-6 || Math.abs(xs[1]! - 0.5) > 1e-6) {
    throw new Error(`qp-solve --test: x=[${xs}] differs from (0.5,0.5) by more than 1e-6`);
  }
  const objV = res.fields["objective"];
  if (objV === undefined || objV.kind !== "float64") {
    throw new Error(`qp-solve --test: missing objective field`);
  }
  if (Math.abs(float64ToNumber(objV) - 0.25) > 1e-6) {
    throw new Error(`qp-solve --test: objective ${float64ToNumber(objV)} ≠ 0.25`);
  }
  if (strField(res, "method") !== METHOD_TAG) {
    throw new Error(`qp-solve --test: method="${strField(res, "method")}", expected "${METHOD_TAG}"`);
  }
  // achieved_precision must be present on optimal and at/below the
  // requested precision (default 1e-8, with a little float64 headroom).
  const apV = res.fields["achieved_precision"];
  if (apV === undefined || apV.kind !== "float64") {
    throw new Error(`qp-solve --test: missing achieved_precision on optimal`);
  }
  if (!(float64ToNumber(apV) <= 1e-6)) {
    throw new Error(`qp-solve --test: achieved_precision ${float64ToNumber(apV)} exceeds 1e-6`);
  }

  // (2) active_set on a known-active case: min ½(x₁²+x₂²) s.t. x₁+x₂−ξ=1
  // ⇒ x*=(½,½,0); the slack ξ (index 2) is binding with multiplier ~½,
  // and the free indices 0,1 are NOT active.
  const activeProblem = record({
    minimize: record({ c: vecF([0, 0, 0]), Q: matF([[1, 0, 0], [0, 1, 0], [0, 0, 0]]) }),
    subjectTo: record({
      Ax_eq_b: record({ A: matF([[1, 1, -1]]), b: vecF([1]) }),
      cones: list([nnCone(3)]),
    }),
  });
  const aRes = fn(activeProblem) as RecordValue;
  if (strField(aRes, "status") !== "optimal") {
    throw new Error(`qp-solve --test: active-set case status=${strField(aRes, "status")}`);
  }
  const activeItems = (aRes.fields["active_set"] as { kind: "list"; items: Value[] }).items;
  const activeIdx = activeItems.map((it) =>
    Number(BigInt((fields(it)["index"] as { kind: "integer"; value: string }).value)),
  );
  if (activeIdx.length !== 1 || activeIdx[0] !== 2) {
    throw new Error(`qp-solve --test: active_set indices=[${activeIdx}], expected exactly [2]`);
  }
  const mult = float64ToNumber(
    fields(activeItems[0]!)["multiplier"] as { kind: "float64"; bits: string },
  );
  if (Math.abs(mult - 0.5) > 1e-3) {
    throw new Error(`qp-solve --test: active multiplier ${mult} differs from 0.5`);
  }

  // (3) absent-field contract: a tiny max_iter forces a non-optimal record
  // (ADR-0003 record-with-flag) with objective/achieved_precision ABSENT.
  const capped = record({
    minimize: record({ c: vecF([0, 0]), Q: matF([[1, 0], [0, 1]]) }),
    subjectTo: record({
      Ax_eq_b: record({ A: matF([[1, 1]]), b: vecF([1]) }),
      cones: list([nnCone(2)]),
    }),
    max_iter: int(1n),
  });
  const cRes = fn(capped) as RecordValue;
  if (strField(cRes, "status") === "optimal") {
    throw new Error(`qp-solve --test: max_iter=1 unexpectedly reached optimal`);
  }
  if (cRes.fields["objective"] !== undefined || cRes.fields["achieved_precision"] !== undefined) {
    throw new Error(`qp-solve --test: non-optimal record must omit objective/achieved_precision`);
  }
}

export const def = defineTool({
  name: NAME,
  version: VERSION,
  summary:
    "Convex QP specialist (ADR-0030): a Mehrotra primal-dual interior-point method factoring the augmented quasidefinite KKT system with a static signed-Cholesky LDLᵀ (ADR-0044); 1e-10 accuracy ceiling, returns the active set.",
  schema: { input: inputSchema, output: outputSchema },
  examples,
  invariants,
  numerical: true,
  fn: fn as never,
  test: smokeTest,
});

if (import.meta.main) void runTool(def);
