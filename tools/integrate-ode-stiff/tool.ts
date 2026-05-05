// =============================================================================
// integrate-ode-stiff — adaptive stiff IVP solver via Radau-IIA(5)
// =============================================================================
//
// Intent
// ------
// Second numerical-IVP slice of the ODE epic (parent: bead
// `scientist-workbench-32z`, this slice: `scientist-workbench-09g`).
// Sister tool to `integrate-ode-ivp` (path-finder, Dormand-Prince 5(4))
// and `integrate-ode-symplectic` (separable-Hamiltonian Verlet/Yoshida).
//
// Solves
//
//     dy/dt = f(t, y),   y(t0) = y0,   t ∈ [t0, tf]
//
// for **stiff** systems via Radau-IIA(5) — 3-stage 5th-order implicit
// Runge-Kutta with collocation at the Radau-IIA quadrature points
// `c = ((4 − √6)/10, (4 + √6)/10, 1)`. A-stable, L-stable, stiffly
// accurate. The `scipy.integrate.solve_ivp(method='Radau')` algorithm.
// Per-step Newton iteration on the (3n × 3n) implicit system uses the
// **simplified-Newton + complex-eigenvalue transformation** (Hairer-
// Wanner 1999): the eigenvalues of the Butcher matrix `A` factor the
// (3n × 3n) Newton system into one real `n × n` solve and one
// (2n × 2n) real solve (the complex pair, embedded). 27× cheaper per
// Newton iteration than inlining a (3n × 3n) factorisation.
//
// What makes this tool agent-honest
// ---------------------------------
// Mirrors `integrate-ode-ivp`'s record shape, with two new bookkeeping
// fields that a planner *must* see to verify the candidate is doing
// implicit work:
//
//     {
//       trajectory,            // (n_eval × n_components)
//       t_values,              // (n_eval,)
//       error_estimate,        // 1-normalised norm of last accepted local error
//       n_evals,               // total f evaluations across accepted + rejected + FD-J
//       n_steps_accepted,
//       n_steps_rejected,
//       n_jacobian_evals,      // count of J(t, y) calls (analytic or FD)
//       n_lu_decompositions,   // count of LU factorisations (real + complex)
//       converged,
//       status,                // success | max_step_exceeded | tspan_exhausted | newton-divergence
//       method,                // "radau-iia-5"
//       warnings,
//     }
//
// `n_jacobian_evals > 0` is the bench's `stiffness_handled` discriminator:
// a candidate that secretly does explicit small-stepping never touches J.
// `n_lu_decompositions ≥ 2 · n_jacobian_evals` reflects the real + complex
// pair per refactor.
//
// Boundary categories (ADR-0003)
// ------------------------------
//   * `integrate-ode-stiff/degenerate-tspan`        — `t0 == tf`. Payload `{t0, tf}`.
//   * `integrate-ode-stiff/non-finite-during-eval`  — `f` or analytic-J returned NaN/±Inf.
//                                                     Payload `{at_t, at_y, kind}`.
//   * `integrate-ode-stiff/jacobian-singular`       — Newton matrix exactly singular.
//                                                     Payload `{at_t, at_y, condition_number}`.
//   * `integrate-ode-stiff/method-not-implemented`  — `options.method == "bdf"` (the only
//                                                     allowed alt-method that this tool
//                                                     refuses *structurally* rather than
//                                                     implementing). Payload `{method}`.
//   * Malformed input (`ToolError`, exit 1):
//     - `len(f) ≠ len(vars) ≠ len(y0)`
//     - unknown expression head / free symbol in `f` or in user-supplied `options.jacobian`
//     - non-finite `y0[i]`, `t0`, `tf`
//     - malformed options (`rtol ≤ 0`, `atol < 0`, `max_step ≤ 0`,
//       unknown method-string, ill-shaped jacobian matrix)
//
// In-process composition (ADR-0012)
// ---------------------------------
// When the user does NOT supply `options.jacobian`, the tool composes
// `cas-diff` (in-process via `@workbench/compose`'s `loadWorkbench`) for
// each (i, j) cell of the symbolic Jacobian:
//
//     ∂f_i/∂y_j ← wb.run("cas-diff", record({f: f_i, var: sym(y_j)}))
//
// If any cell returns `tagged "cas-diff/out-of-scope"` (e.g. `f` contains
// a head outside the closed differentiation vocabulary), the tool falls
// back to the substrate's centred-FD Jacobian and pushes a warning.
// The cached symbolic-Jacobian Values are compiled to numeric callables
// via `evalNumericExpr` and assembled into a single `(t, y, Jout)`
// closure that the substrate calls on every refactor.
//
// User-supplied `options.jacobian` (a list of lists of expression Values)
// short-circuits the `cas-diff` composition and is wired into the same
// closure shape — cheaper for repeated calls and useful when the user
// has a hand-tuned Jacobian.
//
// The workbench is built lazily per process and cached at module scope
// (same pattern as `integrate-ode-symplectic`). ADR-0010 forbids
// module-level side effects; this code's only top-level effect is
// gated by `if (import.meta.main) void runTool(def)`.
//
// ADR-0015 — numerical tier
// -------------------------
// `numerical: true`. Outputs containing float64 leaves (trajectory,
// t_values, error_estimate, jacobian-singular tag's payload) are
// platform-conditional in the sense ADR-0015 names; the runner records
// the platform fingerprint on every successful run. Mutually exclusive
// with `nondeterministic: true`.
//
// ADR-0016 — no hard cap
// ----------------------
// Per ADR-0016 there is no hard `n_components` cap. Large inputs run
// with measurement-driven scale warnings appended to `warnings` via
// `assessNumericalScale("ode-radau", n_components, n_steps_estimate,
// n_eval_points)`. The `ode-radau` algorithm tag accounts for the
// O(n³) LU dominating per-step cost above n ≈ 50.
//
// Out of scope (v0.1, all explicitly deferred)
// --------------------------------------------
//   * BDF — `options.method == "bdf"` returns the boundary tag.
//   * Symplectic / structure-preserving on stiff systems —
//     `integrate-ode-symplectic` for separable-H non-stiff.
//   * Event detection (root-finding on the trajectory).
//   * Vocabulary beyond `cas-diff` / `integrate-1d`.
//
// Algorithm
// ---------
// See `packages/ode-core/src/integrate-stiff.ts` for the literate
// algorithmic prose: top-level driver, Jacobian-staleness logic
// (recompute when `n_iter > 2` and rate `> 1e-3`), step-rejection,
// dense-output emission via the cubic Hermite-collocation interpolant
// from HW Vol II eq. IV.8.21. `radau.ts` carries the simplified-Newton
// step itself plus the eigenvalue-split factorisation. This file is
// the wire-encoding wrapper only.

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
  sym,
  tagged,
  ToolError,
  type Float64Value,
  type ListValue,
  type RecordValue,
  type StringValue,
  type SymbolValue,
  type Value,
} from "@workbench/protocol";
import { defineTool, runTool } from "@workbench/contract";
import {
  ADMITTED_HEADS,
  ADMITTED_CONSTANTS,
  evalNumericExpr,
  UnknownVocabularyError,
} from "@workbench/quadrature";
import {
  assessNumericalScale,
  buildRhs,
  integrateStiff,
  OdeDegenerateTspanError,
  OdeJacobianSingularError,
  OdeNonFiniteError,
  type IntegrateStiffOptions,
  type IntegrateStiffResult,
} from "@workbench/ode-core";

const NAME = "integrate-ode-stiff";
const VERSION = "0.1.0";
const METHOD_NAME = "radau-iia-5";

const DEFAULT_RTOL = 1e-3;
const DEFAULT_ATOL = 1e-6;

const ADMITTED_OPTION_KEYS: ReadonlySet<string> = new Set([
  "rtol",
  "atol",
  "max_step",
  "t_eval",
  "method",
  "jacobian",
]);

// "radau" is the only implemented method; "bdf" is the structurally-
// refused sibling that boundary-tags `method-not-implemented`. Anything
// else is malformed input.
const ADMITTED_METHODS: ReadonlySet<string> = new Set(["radau", "bdf"]);

// -----------------------------------------------------------------------------
// Schema
// -----------------------------------------------------------------------------
//
// `f` is `S.list(S.any())` — closed-vocabulary check is performed by
// `evalNumericExpr` on first call (matching the path-finder). `options`
// is closed-record-typed and optional; nested `options.jacobian` is a
// list-of-lists of expression Values when present.

const inputSchema = S.record(
  {
    f: S.list(S.any()),
    vars: S.list(S.kind("symbol")),
    t_var: S.kind("symbol"),
    y0: S.list(S.kind("float64")),
    t_span: S.record({
      t0: S.kind("float64"),
      tf: S.kind("float64"),
    }),
    options: S.record(
      {
        rtol: S.kind("float64"),
        atol: S.kind("float64"),
        max_step: S.kind("float64"),
        t_eval: S.list(S.kind("float64")),
        method: S.kind("string"),
        jacobian: S.list(S.list(S.any())),
      },
      { optional: ["rtol", "atol", "max_step", "t_eval", "method", "jacobian"] },
    ),
  },
  { optional: ["options"] },
);

const successOutputSchema = S.record({
  trajectory: S.list(S.list(S.kind("float64"))),
  t_values: S.list(S.kind("float64")),
  error_estimate: S.kind("float64"),
  n_evals: S.kind("integer"),
  n_steps_accepted: S.kind("integer"),
  n_steps_rejected: S.kind("integer"),
  n_jacobian_evals: S.kind("integer"),
  n_lu_decompositions: S.kind("integer"),
  converged: S.kind("boolean"),
  status: S.kind("string"),
  method: S.kind("string"),
  warnings: S.list(S.kind("string")),
});

const degenerateTspanOutputSchema = S.tagged(
  `${NAME}/degenerate-tspan`,
  S.record({
    t0: S.kind("float64"),
    tf: S.kind("float64"),
  }),
);

const nonFiniteOutputSchema = S.tagged(
  `${NAME}/non-finite-during-eval`,
  S.record({
    at_t: S.kind("float64"),
    at_y: S.list(S.kind("float64")),
    kind: S.kind("string"),
  }),
);

const jacobianSingularOutputSchema = S.tagged(
  `${NAME}/jacobian-singular`,
  S.record({
    at_t: S.kind("float64"),
    at_y: S.list(S.kind("float64")),
    condition_number: S.kind("float64"),
  }),
);

const methodNotImplementedOutputSchema = S.tagged(
  `${NAME}/method-not-implemented`,
  S.record({
    method: S.kind("string"),
  }),
);

const outputSchema = S.union([
  successOutputSchema,
  degenerateTspanOutputSchema,
  nonFiniteOutputSchema,
  jacobianSingularOutputSchema,
  methodNotImplementedOutputSchema,
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

function trajectoryToValue(rows: readonly Float64Array[]): {
  readonly kind: "list";
  readonly items: readonly { readonly kind: "list"; readonly items: readonly Float64Value[] }[];
} {
  const out = new Array<{ readonly kind: "list"; readonly items: readonly Float64Value[] }>(rows.length);
  for (let i = 0; i < rows.length; i++) out[i] = listOfFloat64(rows[i]!);
  return list(out);
}

function encodeSuccess(r: IntegrateStiffResult, warnings: readonly string[]) {
  return record({
    trajectory: trajectoryToValue(r.trajectory),
    t_values: listOfFloat64(r.tValues),
    error_estimate: float64FromNumber(r.errorEstimate),
    n_evals: int(BigInt(r.nEvals)),
    n_steps_accepted: int(BigInt(r.nStepsAccepted)),
    n_steps_rejected: int(BigInt(r.nStepsRejected)),
    n_jacobian_evals: int(BigInt(r.nJacobianEvals)),
    n_lu_decompositions: int(BigInt(r.nLUDecompositions)),
    converged: bool(r.status === "success"),
    status: str(r.status),
    method: str(METHOD_NAME),
    warnings: list(warnings.map((w) => str(w))),
  });
}

// -----------------------------------------------------------------------------
// Lazy in-process workbench (ADR-0012, mirroring integrate-ode-symplectic)
// -----------------------------------------------------------------------------

interface MinimalWorkbench {
  run(name: string, input: Value): Promise<Value>;
}

let cachedWorkbenchByStore: Map<string, Promise<MinimalWorkbench>> | undefined;

async function getWorkbench(): Promise<MinimalWorkbench> {
  if (cachedWorkbenchByStore === undefined) {
    cachedWorkbenchByStore = new Map();
  }
  const storeKey = process.env["CAS_STORE"] ?? "<default>";
  let promise = cachedWorkbenchByStore.get(storeKey);
  if (promise === undefined) {
    promise = (async () => {
      const { loadWorkbench } = await import("@workbench/compose");
      return await loadWorkbench();
    })();
    cachedWorkbenchByStore.set(storeKey, promise);
  }
  return promise;
}

// -----------------------------------------------------------------------------
// Symbolic Jacobian via in-process cas-diff
// -----------------------------------------------------------------------------
//
// Returns an `n × n` matrix of expression Values, or `null` if any cell
// fell back to `tagged "cas-diff/out-of-scope"` — in that case the tool
// uses the substrate's centred-FD Jacobian and emits a warning. Other
// cas-diff failure modes (a `ToolError` thrown from cas-diff for unknown
// vocabulary) propagate up so the agent sees the underlying cause.

async function deriveSymbolicJacobian(
  wb: MinimalWorkbench,
  fItems: readonly Value[],
  vars: readonly string[],
): Promise<readonly (readonly Value[])[] | null> {
  const n = vars.length;
  const J: Value[][] = new Array(n);
  for (let i = 0; i < n; i++) {
    const row = new Array<Value>(n);
    for (let j = 0; j < n; j++) {
      const out = await wb.run(
        "cas-diff",
        record({ f: fItems[i]!, var: sym(vars[j]!) }),
      );
      if (out.kind === "tagged" && out.tag === "cas-diff/out-of-scope") {
        return null; // Caller falls back to FD-Jacobian.
      }
      row[j] = out;
    }
    J[i] = row;
  }
  return J;
}

// -----------------------------------------------------------------------------
// Build (t, y, Jout) closure from a symbolic Jacobian matrix
// -----------------------------------------------------------------------------
//
// One Map<string, number> env shared across all n² cells; the inner loop
// mutates it for every (t, y, J) call. NaN/Inf in any cell raises
// `OdeNonFiniteError` so the substrate translates to the boundary tag.

function buildAnalyticJacobian(
  Jcells: readonly (readonly Value[])[],
  vars: readonly string[],
  tVar: string,
): (t: number, y: Float64Array, Jout: Float64Array) => void {
  const env = new Map<string, number>();
  env.set(tVar, 0);
  for (const v of vars) env.set(v, 0);
  const n = vars.length;
  return (t: number, y: Float64Array, Jout: Float64Array): void => {
    env.set(tVar, t);
    for (let i = 0; i < n; i++) env.set(vars[i]!, y[i]!);
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        const v = evalNumericExpr(Jcells[i]![j]!, env);
        if (!Number.isFinite(v)) {
          const kind: "NaN" | "Infinity" | "-Infinity" =
            Number.isNaN(v) ? "NaN" : v > 0 ? "Infinity" : "-Infinity";
          throw new OdeNonFiniteError(t, new Float64Array(y), kind);
        }
        Jout[i * n + j] = v;
      }
    }
  };
}

// -----------------------------------------------------------------------------
// Tool definition
// -----------------------------------------------------------------------------

export const def = defineTool({
  name: NAME,
  version: VERSION,
  schema: { input: inputSchema, output: outputSchema },
  numerical: true,
  examples: [
    {
      description: "scalar mild-stiff y'=-y, y(0)=1, t∈[0,1]; canonical happy path with t_eval",
      input: record({
        f: list([expr("neg", [sym("y0")])]),
        vars: list([sym("y0")]),
        t_var: sym("t"),
        y0: list([float64FromNumber(1.0)]),
        t_span: record({
          t0: float64FromNumber(0),
          tf: float64FromNumber(1),
        }),
        options: record({
          t_eval: list([0, 1].map((x) => float64FromNumber(x))),
        }),
      }),
      // Output omitted — value-bearing (numerical-tier).
    },
    {
      description: "degenerate tspan t0 == tf yields tagged degenerate-tspan",
      input: record({
        f: list([expr("neg", [sym("y0")])]),
        vars: list([sym("y0")]),
        t_var: sym("t"),
        y0: list([float64FromNumber(1.0)]),
        t_span: record({
          t0: float64FromNumber(0),
          tf: float64FromNumber(0),
        }),
      }),
      output: tagged(`${NAME}/degenerate-tspan`, record({
        t0: float64FromNumber(0),
        tf: float64FromNumber(0),
      })),
    },
    {
      description: "options.method == 'bdf' yields tagged method-not-implemented",
      input: record({
        f: list([expr("neg", [sym("y0")])]),
        vars: list([sym("y0")]),
        t_var: sym("t"),
        y0: list([float64FromNumber(1.0)]),
        t_span: record({
          t0: float64FromNumber(0),
          tf: float64FromNumber(1),
        }),
        options: record({
          method: str("bdf"),
        }),
      }),
      output: tagged(`${NAME}/method-not-implemented`, record({
        method: str("bdf"),
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
      name: "implicit-method-uses-jacobian",
      statement: "n_jacobian_evals ≥ 1 on any non-degenerate success path — Radau is implicit, every step refactors against J at least once",
      machine_checkable: true,
    },
    {
      name: "lu-pair-per-refactor",
      statement: "n_lu_decompositions counts real + complex factorisations; structurally n_lu_decompositions ≥ 2·n_jacobian_evals on any successful step",
      machine_checkable: true,
    },
    {
      name: "monotone-t-values",
      statement: "t_values ascending iff t0 ≤ tf, descending iff t0 > tf; equals options.t_eval element-wise when supplied",
      machine_checkable: true,
    },
    {
      name: "trajectory-shape",
      statement: "trajectory is (n_eval × n_components); when t_eval omitted, n_eval = 2 (endpoints only)",
      machine_checkable: true,
    },
    {
      name: "converged-iff-success",
      statement: `converged === (status === "success") — every code path in the driver enforces this`,
      machine_checkable: true,
    },
    {
      name: "trajectory-accuracy-vs-reference",
      statement: "for analytic-oracle inputs, |trajectory − reference|_∞ ≤ 100·rtol·|reference|_∞ + 100·atol over the whole horizon (Radau is stiffly bounded — no horizon scaling factor; HW Vol II §IV.10)",
      machine_checkable: true,
    },
    {
      name: "non-finite-tagged",
      statement: `f or J returning NaN/±Inf during integration ⇒ tagged "${NAME}/non-finite-during-eval" with offending (at_t, at_y, kind)`,
      machine_checkable: true,
    },
    {
      name: "degenerate-tspan-tagged",
      statement: `t0 == tf ⇒ tagged "${NAME}/degenerate-tspan" — never a (silently empty / silently y0) success record`,
      machine_checkable: true,
    },
    {
      name: "jacobian-singular-tagged",
      statement: `LU factorisation of the Newton matrix (γ/h)I − J hitting an exactly-singular system ⇒ tagged "${NAME}/jacobian-singular" with (at_t, at_y, condition_number) — never a NaN-poisoned trajectory`,
      machine_checkable: true,
    },
    {
      name: "method-not-implemented-tagged",
      statement: `options.method == "bdf" ⇒ tagged "${NAME}/method-not-implemented" with payload {method: "bdf"} — structural refusal, the path-finder is single-method (Radau)`,
      machine_checkable: true,
    },
    {
      name: "unknown-vocabulary-rejected",
      statement: "f or options.jacobian containing a head or free symbol outside the closed vocabulary raises ToolError with a suggestion listing admitted heads/constants",
      machine_checkable: true,
    },
    {
      name: "dim-mismatch-rejected",
      statement: "len(f) ≠ len(vars), len(y0) ≠ len(vars), or options.jacobian shape ≠ (n × n) ⇒ ToolError with the offending lengths",
      machine_checkable: true,
    },
    {
      name: "scale-warnings-emitted",
      statement: "for n_components > 100 or n_steps_estimate > 100_000, the warnings field carries human-readable scale advisories per ADR-0016. Algorithm still runs.",
      machine_checkable: true,
    },
  ],
  fn: async (input, _flags): Promise<Value> => {
    // Runner has validated input shape; semantic checks (vocabulary,
    // dim agreement, finite tspan) live here.
    const fields = input.fields;

    const varsItems = (fields.vars as ListValue).items;
    const vars = varsItems.map((s) => (s as SymbolValue).name);
    const tVar = (fields.t_var as SymbolValue).name;
    const n = vars.length;
    if (n === 0) {
      throw new ToolError(`${NAME}: vars must be a non-empty list of symbols`, {
        suggestion: "supply at least one state variable",
      });
    }

    const fItems = (fields.f as ListValue).items;
    if (fItems.length !== n) {
      throw new ToolError(
        `${NAME}: f.length ${fItems.length} != vars.length ${n}`,
        {
          suggestion: `provide one RHS expression per state variable (got ${fItems.length} expressions for ${n} variables)`,
        },
      );
    }

    const y0Items = (fields.y0 as ListValue).items;
    if (y0Items.length !== n) {
      throw new ToolError(
        `${NAME}: y0.length ${y0Items.length} != vars.length ${n}`,
        {
          suggestion: `provide one initial value per state variable (got ${y0Items.length} values for ${n} variables)`,
        },
      );
    }

    const y0 = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const v = float64ToNumber(y0Items[i] as Float64Value);
      if (!Number.isFinite(v)) {
        throw new ToolError(
          `${NAME}: y0[${i}] is non-finite (${v})`,
          {
            suggestion: "every y0 entry must be a finite IEEE-754 binary64 value; NaN/±Inf are not admitted at input time",
          },
        );
      }
      y0[i] = v;
    }

    const tspanFields = (fields.t_span as RecordValue).fields;
    const t0 = float64ToNumber(tspanFields.t0 as Float64Value);
    const tf = float64ToNumber(tspanFields.tf as Float64Value);
    if (!Number.isFinite(t0) || !Number.isFinite(tf)) {
      throw new ToolError(
        `${NAME}: t_span.t0 and t_span.tf must be finite (got t0=${t0}, tf=${tf})`,
        {},
      );
    }

    // Decode options.
    const optsValue = fields.options as RecordValue | undefined;
    let rtol = DEFAULT_RTOL;
    let atol = DEFAULT_ATOL;
    let maxStep: number | undefined = undefined;
    let tEval: number[] | undefined = undefined;
    let methodOpt: string | undefined = undefined;
    let userJacobianCells: readonly (readonly Value[])[] | undefined = undefined;
    if (optsValue !== undefined) {
      for (const k of Object.keys(optsValue.fields)) {
        if (!ADMITTED_OPTION_KEYS.has(k)) {
          throw new ToolError(
            `${NAME}: unknown option key "${k}"`,
            { suggestion: `admitted options: ${[...ADMITTED_OPTION_KEYS].join(", ")}` },
          );
        }
      }
      if (optsValue.fields.rtol !== undefined) {
        rtol = float64ToNumber(optsValue.fields.rtol as Float64Value);
        if (!Number.isFinite(rtol) || rtol <= 0) {
          throw new ToolError(`${NAME}: options.rtol must be a finite positive float64 (got ${rtol})`, {});
        }
      }
      if (optsValue.fields.atol !== undefined) {
        atol = float64ToNumber(optsValue.fields.atol as Float64Value);
        if (!Number.isFinite(atol) || atol < 0) {
          throw new ToolError(`${NAME}: options.atol must be a finite non-negative float64 (got ${atol})`, {});
        }
      }
      if (optsValue.fields.max_step !== undefined) {
        maxStep = float64ToNumber(optsValue.fields.max_step as Float64Value);
        if (!Number.isFinite(maxStep) || maxStep <= 0) {
          throw new ToolError(`${NAME}: options.max_step must be a finite positive float64 (got ${maxStep})`, {});
        }
      }
      if (optsValue.fields.t_eval !== undefined) {
        const tEvalItems = (optsValue.fields.t_eval as ListValue).items;
        tEval = new Array<number>(tEvalItems.length);
        for (let i = 0; i < tEvalItems.length; i++) {
          const v = float64ToNumber(tEvalItems[i] as Float64Value);
          if (!Number.isFinite(v)) {
            throw new ToolError(`${NAME}: options.t_eval[${i}] is non-finite (${v})`, {});
          }
          tEval[i] = v;
        }
      }
      if (optsValue.fields.method !== undefined) {
        methodOpt = (optsValue.fields.method as StringValue).value;
        if (!ADMITTED_METHODS.has(methodOpt)) {
          throw new ToolError(
            `${NAME}: unknown method "${methodOpt}"`,
            {
              suggestion: `admitted methods: ${[...ADMITTED_METHODS].join(", ")}; "radau" is implemented; "bdf" structurally tags method-not-implemented`,
            },
          );
        }
      }
      if (optsValue.fields.jacobian !== undefined) {
        const jacItems = (optsValue.fields.jacobian as ListValue).items;
        if (jacItems.length !== n) {
          throw new ToolError(
            `${NAME}: options.jacobian must be ${n}×${n}; got ${jacItems.length} rows`,
            {},
          );
        }
        const cells: Value[][] = new Array(n);
        for (let i = 0; i < n; i++) {
          const row = (jacItems[i] as ListValue).items;
          if (row.length !== n) {
            throw new ToolError(
              `${NAME}: options.jacobian row ${i} has length ${row.length}, expected ${n}`,
              {},
            );
          }
          cells[i] = [...row] as Value[];
        }
        userJacobianCells = cells;
      }
    }

    // BDF refusal — boundary tag (structural refusal, not malformed).
    if (methodOpt === "bdf") {
      return tagged(`${NAME}/method-not-implemented`, record({
        method: str("bdf"),
      }));
    }

    // Build the RHS lambda. Vocabulary errors surface from
    // `evalNumericExpr` on first call inside the integrator.
    const fItemValues = fItems as readonly Value[];
    const f = buildRhs(fItemValues, vars, tVar);

    // Resolve the Jacobian source.
    //
    //   1. user-supplied symbolic cells: build the closure directly;
    //   2. else: compose `cas-diff` for each (i, j); on out-of-scope
    //      anywhere fall back to the substrate's FD path with a warning;
    //   3. else: undefined (substrate uses centred-FD).
    let jacobianClosure:
      | ((t: number, y: Float64Array, Jout: Float64Array) => void)
      | undefined = undefined;
    const warnings: string[] = [];

    if (userJacobianCells !== undefined) {
      try {
        jacobianClosure = buildAnalyticJacobian(userJacobianCells, vars, tVar);
      } catch (err) {
        if (err instanceof UnknownVocabularyError) {
          throw new ToolError(`${NAME}: options.jacobian — ${err.message}`, {
            suggestion: err.kind === "head"
              ? `admitted heads: ${ADMITTED_HEADS.join(", ")}`
              : `admitted free constants: ${ADMITTED_CONSTANTS.join(", ")}; the declared variables are ${vars.join(", ")}; the independent variable is "${tVar}"`,
          });
        }
        throw err;
      }
    } else {
      // Symbolic via cas-diff (in-process). Out-of-scope on any cell
      // ⇒ FD fallback with a warning.
      try {
        const wb = await getWorkbench();
        const Jcells = await deriveSymbolicJacobian(wb, fItemValues, vars);
        if (Jcells === null) {
          warnings.push(
            `cas-diff returned out-of-scope on at least one ∂f_i/∂y_j cell; ` +
            `falling back to centred finite-difference Jacobian (substrate default)`,
          );
        } else {
          jacobianClosure = buildAnalyticJacobian(Jcells, vars, tVar);
        }
      } catch (err) {
        // cas-diff might raise a ToolError for an unknown vocabulary
        // head — that's malformed input from the user (f contains an
        // unsupported head) and should propagate.
        if (err instanceof ToolError) throw err;
        if (err instanceof UnknownVocabularyError) {
          throw new ToolError(`${NAME}: ${err.message}`, {
            suggestion: err.kind === "head"
              ? `admitted heads: ${ADMITTED_HEADS.join(", ")}`
              : `admitted free constants: ${ADMITTED_CONSTANTS.join(", ")}; the declared variables are ${vars.join(", ")}; the independent variable is "${tVar}"`,
          });
        }
        throw err;
      }
    }

    // Scale warnings (pre-run estimate). Step-count proxy: t_eval length
    // or order-3 step heuristic (Radau's error-controller uses order-3
    // for step selection).
    const nEvalEstimate = tEval !== undefined ? tEval.length : 2;
    const nStepsEstimate = Math.max(
      nEvalEstimate,
      Math.ceil(Math.abs(tf - t0) * Math.pow(1 / rtol, 1 / 4)),
    );
    warnings.push(
      ...assessNumericalScale(
        "ode-radau",
        n,
        nStepsEstimate,
        nEvalEstimate,
      ),
    );

    // Run the substrate.
    let result: IntegrateStiffResult;
    try {
      const opts: IntegrateStiffOptions = { rtol, atol };
      if (maxStep !== undefined) (opts as { maxStep: number }).maxStep = maxStep;
      if (tEval !== undefined) (opts as { tEval: readonly number[] }).tEval = tEval;
      if (jacobianClosure !== undefined) {
        (opts as {
          jacobian: (t: number, y: Float64Array, Jout: Float64Array) => void;
        }).jacobian = jacobianClosure;
      }
      result = integrateStiff(f, t0, tf, y0, opts);
    } catch (err) {
      if (err instanceof OdeDegenerateTspanError) {
        return tagged(`${NAME}/degenerate-tspan`, record({
          t0: float64FromNumber(err.t0),
          tf: float64FromNumber(err.tf),
        }));
      }
      if (err instanceof OdeNonFiniteError) {
        return tagged(`${NAME}/non-finite-during-eval`, record({
          at_t: float64FromNumber(err.atT),
          at_y: listOfFloat64(err.atY),
          kind: str(err.kind),
        }));
      }
      if (err instanceof OdeJacobianSingularError) {
        return tagged(`${NAME}/jacobian-singular`, record({
          at_t: float64FromNumber(err.atT),
          at_y: listOfFloat64(err.atY),
          condition_number: float64FromNumber(err.conditionNumber),
        }));
      }
      if (err instanceof UnknownVocabularyError) {
        throw new ToolError(`${NAME}: ${err.message}`, {
          suggestion: err.kind === "head"
            ? `admitted heads: ${ADMITTED_HEADS.join(", ")}`
            : `admitted free constants: ${ADMITTED_CONSTANTS.join(", ")}; the declared variables are ${vars.join(", ")}; the independent variable is "${tVar}"`,
        });
      }
      if (err instanceof RangeError && /Invalid array length|Invalid typed array length/.test(err.message)) {
        throw new ToolError(
          `${NAME}: out of memory: ${err.message}`,
          {
            suggestion: `reduce n_components or t_eval length; the FFI bridge (bead scientist-workbench-e7y) is the right escape hatch for production-scale stiff problems`,
          },
        );
      }
      throw err;
    }

    if (!result.status.startsWith("success")) {
      warnings.push(
        `integration ended with status="${result.status}" before reaching tf; the trajectory beyond the stall point uses the most recently accepted state`,
      );
    }
    return encodeSuccess(result, warnings);
  },
  test: () => {
    // Smoke probe: scalar exp-decay must land within bench tolerance
    // and report a positive n_jacobian_evals. (Uses the substrate
    // directly — the wire wrapper's round-trip is exercised by
    // `bun run goldens`.)
    const f = (_t: number, y: Float64Array, out: Float64Array): void => {
      out[0] = -y[0]!;
    };
    const r = integrateStiff(f, 0, 5, new Float64Array([1.0]), {
      rtol: 1e-6, atol: 1e-9, tEval: [0, 1, 2, 3, 4, 5],
    });
    if (r.status !== "success") {
      throw new Error(`test: scalar exp-decay status=${r.status}, expected "success"`);
    }
    if (r.trajectory.length !== 6) {
      throw new Error(`test: trajectory length ${r.trajectory.length}, expected 6`);
    }
    for (let i = 0; i <= 5; i++) {
      const expected = Math.exp(-i);
      const got = r.trajectory[i]![0]!;
      const tol = 100 * 1e-6 * Math.max(Math.abs(expected), 1) + 100 * 1e-9;
      if (Math.abs(got - expected) > tol) {
        throw new Error(
          `test: exp-decay at t=${i}: got ${got}, expected ${expected} (tol ${tol.toExponential(2)})`,
        );
      }
    }
    if (r.nJacobianEvals < 1) {
      throw new Error(
        `test: n_jacobian_evals=${r.nJacobianEvals} on Radau success path — implicit method must use J`,
      );
    }
    if (r.nLUDecompositions < 2 * r.nJacobianEvals) {
      throw new Error(
        `test: n_lu_decompositions=${r.nLUDecompositions} < 2·n_jacobian_evals=${2 * r.nJacobianEvals} — real + complex pair invariant`,
      );
    }

    // 2D linear-stiff: dy/dt = [-1000 y0, -y1]. The fast mode dies in
    // O(1/1000); a correct stiff solver clears t=1 with bounded error.
    const fStiff = (_t: number, y: Float64Array, out: Float64Array): void => {
      out[0] = -1000 * y[0]!;
      out[1] = -y[1]!;
    };
    const rS = integrateStiff(
      fStiff, 0, 1, new Float64Array([1, 1]),
      { rtol: 1e-6, atol: 1e-9, tEval: [0, 0.5, 1] },
    );
    if (rS.status !== "success") {
      throw new Error(`test: 2D stiff status=${rS.status}`);
    }
    // y0(1) = exp(-1000) ≈ 0; y1(1) = exp(-1)
    const expected = Math.exp(-1);
    const got = rS.trajectory[2]![1]!;
    const tol = 100 * 1e-6 * Math.max(Math.abs(expected), 1) + 100 * 1e-9;
    if (Math.abs(got - expected) > tol) {
      throw new Error(
        `test: 2D stiff y1(1): got ${got}, expected ${expected} (tol ${tol.toExponential(2)})`,
      );
    }

    // Degenerate-tspan throws.
    let threwDegen = false;
    try {
      integrateStiff(f, 0, 0, new Float64Array([1.0]));
    } catch (e) {
      if (e instanceof OdeDegenerateTspanError) threwDegen = true;
    }
    if (!threwDegen) {
      throw new Error(`test: t0==tf did not throw OdeDegenerateTspanError`);
    }
  },
});

if (import.meta.main) void runTool(def);
