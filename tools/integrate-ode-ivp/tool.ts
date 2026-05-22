// =============================================================================
// integrate-ode-ivp — adaptive non-stiff IVP solver via Dormand-Prince 5(4)
// =============================================================================
//
// Intent
// ------
// First slice of the ODE epic (parent: bead `scientist-workbench-32z`).
// Path-finder for the tournament-protocol applied to time-stepping
// ODE solvers — mirrors the discipline established by `linalg-{solve,
// qr,svd,eigh}` and `integrate-1d` / `optimize-lbfgs-projected`.
//
// Solves
//
//     dy/dt = f(t, y),   y(t0) = y0,   t ∈ [t0, tf]
//
// for non-stiff systems via the Dormand-Prince 5(4) embedded RK pair
// (the SciPy `solve_ivp(method='RK45')` algorithm; the workhorse of
// computational science for non-stiff problems). Step-size control
// via Gustafsson's PI law (1991); FSAL exploited for one-eval-per-
// step amortised cost. Sub-step `t_eval` points evaluated via the
// 4th-order Hermite continuous extension (HNW Vol I §II.6).
//
// What makes this tool agent-honest
// ---------------------------------
// The output is *not* just `(t_values, trajectory)`. It is a record
// carrying everything an agent's planner — or the bench's verifier —
// needs to decide what to do with the answer:
//
//     {
//       trajectory,        // (n_eval × n_components) state at each t_eval
//       t_values,           // (n_eval,) time grid (== t_eval if provided)
//       error_estimate,     // 1-normalised norm of last accepted local error
//       n_evals,             // total f evaluations across accepted + rejected
//       n_steps_accepted,
//       n_steps_rejected,
//       converged,          // true iff status === "success"
//       status,             // "success" | "max_step_exceeded" | "tspan_exhausted"
//       method,             // "dormand-prince-45"
//       warnings,
//     }
//
// `converged` is a *field*, not a separate boundary category — same
// shape pattern as `linalg-solve`'s `condition_estimate` and
// `integrate-1d`'s `converged`. A planner reads `converged === false`
// and decides whether to retry with tighter tolerances, accept the
// partial result, or warn the user.
//
// Boundary categories (ADR-0003)
// ------------------------------
//   * `integrate-ode-ivp/degenerate-tspan` (tagged): `t0 == tf`. Payload
//     `{t0, tf}`.
//   * `integrate-ode-ivp/non-finite-during-eval` (tagged): `f` returned
//     NaN/±Inf at some `(t, y)` during integration. Payload `{at_t,
//     at_y, kind: "NaN"|"Infinity"|"-Infinity"}`.
//   * Malformed input (`ToolError`, exit 1):
//     - `len(f) ≠ len(vars) ≠ len(y0)`: dim mismatch.
//     - unknown expression head or free symbol: vocabulary
//       violation. Suggestion lists admitted heads / constants.
//     - any `y0[i]` non-finite at input time.
//     - non-finite `t0` or `tf`.
//     - malformed options (e.g. `rtol ≤ 0`, `max_step ≤ 0`).
//     - true OOM (RangeError on Float64Array allocation).
//
// ADR-0015 — numerical tier
// -------------------------
// `numerical: true`. Every output containing float64 leaves
// (trajectory, error_estimate, t_values) is platform-conditional in
// the sense ADR-0015 names; the runner records the platform
// fingerprint on every successful run. Mutually exclusive with
// `nondeterministic: true`.
//
// ADR-0016 — no hard cap
// ----------------------
// Per ADR-0016 there is no hard `n_components ≤ 100` cap. Large
// inputs run with measurement-driven scale warnings appended to the
// output's `warnings` field via `assessNumericalScale("ode-rkf45",
// n_components, n_steps_estimate, n_eval_points)`. OOM is the only
// physical refusal.
//
// Out of scope (v0.1, all explicitly deferred)
// --------------------------------------------
//   * Stiff problems — `integrate-ode-stiff` (bead `09g`).
//   * Symplectic / structure-preserving integration —
//     `integrate-ode-symplectic` (bead `4gr`).
//   * Event detection (root-finding on the trajectory).
//   * Vocabulary beyond `cas-diff` / `integrate-1d`.
//
// Algorithm
// ---------
// See `packages/ode-core/` for the literate algorithmic prose:
// `dopri5.ts` (coefficients + single-step), `pi-controller.ts`
// (Gustafsson PI + initial-step heuristic), `integrate.ts` (top-level
// driver with FSAL bookkeeping + dense extension + reverse
// integration). This file is the wire-encoding wrapper only.

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
  type SymbolValue,
  type Value,
} from "@workbench/protocol";
import { defineTool, runTool } from "@workbench/contract";
import {
  ADMITTED_HEADS,
  ADMITTED_CONSTANTS,
  UnknownVocabularyError,
} from "@workbench/quadrature";
import {
  assessNumericalScale,
  buildRhs,
  integrate,
  OdeDegenerateTspanError,
  OdeNonFiniteError,
  type IntegrateOptions,
  type IntegrateResult,
} from "@workbench/ode-core";

const NAME = "integrate-ode-ivp";
const VERSION = "0.1.0";
const METHOD_NAME = "dormand-prince-45";

const DEFAULT_RTOL = 1e-3;
const DEFAULT_ATOL = 1e-6;

const ADMITTED_OPTION_KEYS: ReadonlySet<string> = new Set([
  "rtol",
  "atol",
  "max_step",
  "t_eval",
]);

// -----------------------------------------------------------------------------
// Schema
// -----------------------------------------------------------------------------
//
// `f` is `S.list(S.any())` — the closed-vocabulary check is performed
// per-node by `evalNumericExpr` on first evaluation, exactly mirroring
// `integrate-1d` and `optimize-lbfgs-projected`. `vars` is a list of
// symbols, `t_var` is the independent variable's symbol name.
//
// `options` is closed-record-typed and optional; sub-fields are also
// optional (the tool fills defaults).

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
      },
      { optional: ["rtol", "atol", "max_step", "t_eval"] },
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

const outputSchema = S.union([
  successOutputSchema,
  degenerateTspanOutputSchema,
  nonFiniteOutputSchema,
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

function encodeSuccess(r: IntegrateResult, warnings: readonly string[]) {
  return record({
    trajectory: trajectoryToValue(r.trajectory),
    t_values: listOfFloat64(r.tValues),
    error_estimate: float64FromNumber(r.errorEstimate),
    n_evals: int(BigInt(r.nEvals)),
    n_steps_accepted: int(BigInt(r.nStepsAccepted)),
    n_steps_rejected: int(BigInt(r.nStepsRejected)),
    converged: bool(r.status === "success"),
    status: str(r.status),
    method: str(METHOD_NAME),
    warnings: list(warnings.map((w) => str(w))),
  });
}

// -----------------------------------------------------------------------------
// Examples
// -----------------------------------------------------------------------------
//
// Schema-conformant inputs only: every example's `input` and `output`
// is checked against the schema at tool-load time (the runner enforces).

/**
 * Build a canonical wire-form input record. Narrow-typed return shape
 * lets the schema-typed `examples` slot verify conformance at compile
 * time. Two overloads — with and without `options` — produce the
 * precise record-of-fields type the schema-derived `RecordValueOf`
 * expects. (Same pattern as `optimize-lbfgs-projected`'s
 * `makeExampleInput`.)
 */
function makeInput(args: {
  f: Value[];
  vars: string[];
  t_var: string;
  y0: number[];
  t_span: { t0: number; tf: number };
}): {
  readonly kind: "record";
  readonly fields: {
    f: { readonly kind: "list"; readonly items: readonly Value[] };
    vars: { readonly kind: "list"; readonly items: readonly SymbolValue[] };
    t_var: SymbolValue;
    y0: { readonly kind: "list"; readonly items: readonly Float64Value[] };
    t_span: {
      readonly kind: "record";
      readonly fields: { t0: Float64Value; tf: Float64Value };
    };
  };
};
function makeInput(args: {
  f: Value[];
  vars: string[];
  t_var: string;
  y0: number[];
  t_span: { t0: number; tf: number };
  options: { rtol?: number; atol?: number; max_step?: number; t_eval?: readonly number[] };
}): {
  readonly kind: "record";
  readonly fields: {
    f: { readonly kind: "list"; readonly items: readonly Value[] };
    vars: { readonly kind: "list"; readonly items: readonly SymbolValue[] };
    t_var: SymbolValue;
    y0: { readonly kind: "list"; readonly items: readonly Float64Value[] };
    t_span: {
      readonly kind: "record";
      readonly fields: { t0: Float64Value; tf: Float64Value };
    };
    options: { readonly kind: "record"; readonly fields: Record<string, Value> };
  };
};
function makeInput(args: {
  f: Value[];
  vars: string[];
  t_var: string;
  y0: number[];
  t_span: { t0: number; tf: number };
  options?: { rtol?: number; atol?: number; max_step?: number; t_eval?: readonly number[] };
}) {
  const baseFields = {
    f: list(args.f),
    vars: list(args.vars.map((v) => sym(v))),
    t_var: sym(args.t_var),
    y0: listOfFloat64(args.y0),
    t_span: record({
      t0: float64FromNumber(args.t_span.t0),
      tf: float64FromNumber(args.t_span.tf),
    }),
  };
  if (args.options === undefined) {
    return record(baseFields);
  }
  const optFields: Record<string, Value> = {};
  if (args.options.rtol !== undefined) optFields.rtol = float64FromNumber(args.options.rtol);
  if (args.options.atol !== undefined) optFields.atol = float64FromNumber(args.options.atol);
  if (args.options.max_step !== undefined) optFields.max_step = float64FromNumber(args.options.max_step);
  if (args.options.t_eval !== undefined) optFields.t_eval = listOfFloat64(args.options.t_eval);
  return record({
    ...baseFields,
    options: record(optFields),
  });
}

// -----------------------------------------------------------------------------
// Tool definition
// -----------------------------------------------------------------------------

export const def = defineTool({
  name: NAME,
  version: VERSION,
  summary:
    "Dormand-Prince 5(4) adaptive non-stiff IVP solver (SciPy `RK45` algorithm); agent-honest residual + step counts",
  schema: { input: inputSchema, output: outputSchema },
  // ADR-0015 numerical tier. The output always contains float64
  // leaves on the success branch (trajectory, t_values,
  // error_estimate); the boundary-tag branches also carry float64
  // leaves (the offending t and y vector). The runner's
  // `containsFloat64` walker writes the platform fingerprint on every
  // successful run. Mutually exclusive with `nondeterministic: true`.
  numerical: true,
  examples: [
    {
      description: "scalar exp decay y'=-y, y(0)=1, t∈[0,1]; canonical happy path",
      input: makeInput({
        f: [expr("neg", [sym("y0")])],
        vars: ["y0"],
        t_var: "t",
        y0: [1.0],
        t_span: { t0: 0, tf: 1 },
      }),
      output: encodeSuccess(
        integrate(
          (_t, y, out) => { out[0] = -y[0]!; },
          0, 1, new Float64Array([1.0]),
        ),
        [],
      ),
    },
    {
      description: "2D harmonic oscillator y0'=y1, y1'=-y0; one period; uses dense output",
      input: makeInput({
        f: [sym("y1"), expr("neg", [sym("y0")])],
        vars: ["y0", "y1"],
        t_var: "t",
        y0: [1.0, 0.0],
        t_span: { t0: 0, tf: 2 * Math.PI },
        options: { t_eval: [0, Math.PI / 2, Math.PI, 3 * Math.PI / 2, 2 * Math.PI], rtol: 1e-8, atol: 1e-11 },
      }),
      output: encodeSuccess(
        integrate(
          (_t, y, out) => { out[0] = y[1]!; out[1] = -y[0]!; },
          0, 2 * Math.PI, new Float64Array([1.0, 0.0]),
          { rtol: 1e-8, atol: 1e-11, tEval: [0, Math.PI / 2, Math.PI, 3 * Math.PI / 2, 2 * Math.PI] },
        ),
        [],
      ),
    },
    {
      description: "reverse integration: y'=-y from y(5)=e^-5 back to y(0)=1",
      input: makeInput({
        f: [expr("neg", [sym("y0")])],
        vars: ["y0"],
        t_var: "t",
        y0: [Math.exp(-5)],
        t_span: { t0: 5, tf: 0 },
        options: { t_eval: [5, 4, 3, 2, 1, 0], rtol: 1e-8, atol: 1e-11 },
      }),
      output: encodeSuccess(
        integrate(
          (_t, y, out) => { out[0] = -y[0]!; },
          5, 0, new Float64Array([Math.exp(-5)]),
          { rtol: 1e-8, atol: 1e-11, tEval: [5, 4, 3, 2, 1, 0] },
        ),
        [],
      ),
    },
    {
      description: "degenerate tspan t0==tf → tagged degenerate-tspan",
      input: makeInput({
        f: [expr("neg", [sym("y0")])],
        vars: ["y0"],
        t_var: "t",
        y0: [1.0],
        t_span: { t0: 0, tf: 0 },
      }),
      output: tagged(`${NAME}/degenerate-tspan`, record({
        t0: float64FromNumber(0),
        tf: float64FromNumber(0),
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
      name: "fsal-eval-floor",
      statement: "n_evals ≥ 6·n_steps_accepted (DOPRI5 has 7 stages; FSAL reuses the 7th, so the asymptotic floor is 6 new evals per accepted step)",
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
      statement: "for analytic-oracle inputs, |trajectory − reference|_∞ ≤ 100·rtol·|reference|_∞ over the horizon (HNW Vol I §II.10 with 100× safety factor)",
      machine_checkable: true,
    },
    {
      name: "non-finite-tagged",
      statement: `f returning NaN/±Inf at any (t, y) during integration ⇒ tagged "${NAME}/non-finite-during-eval" with offending (at_t, at_y, kind) — never NaN-poisoned trajectory`,
      machine_checkable: true,
    },
    {
      name: "degenerate-tspan-tagged",
      statement: `t0 == tf ⇒ tagged "${NAME}/degenerate-tspan" — never a (silently empty / silently y0) success record`,
      machine_checkable: true,
    },
    {
      name: "unknown-vocabulary-rejected",
      statement: "f containing a head or free symbol outside the closed vocabulary raises ToolError with a suggestion listing admitted heads/constants",
      machine_checkable: true,
    },
    {
      name: "dim-mismatch-rejected",
      statement: "len(f) ≠ len(vars) or len(y0) ≠ len(vars) ⇒ ToolError with the offending lengths",
      machine_checkable: true,
    },
    {
      name: "scale-warnings-emitted",
      statement: "for n_components > 100 or n_steps_estimate > 100_000, the warnings field carries human-readable scale advisories per ADR-0016. Algorithm still runs.",
      machine_checkable: true,
    },
  ],
  fn: (input, _flags) => {
    // The runner has validated the input shape against `inputSchema`,
    // so structural invariants on each field are already guaranteed.
    // Semantic checks (vocabulary, dim agreement, finite tspan) live
    // here.
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
    }

    // Build the RHS lambda. Vocabulary errors surface from
    // `evalNumericExpr` on first call.
    const fItemValues = fItems as readonly Value[];
    const f = buildRhs(fItemValues, vars, tVar);

    // Collect scale warnings. We need a step-count estimate; without
    // running the integrator we use the caller's t_eval-length as a
    // soft proxy. (The post-run actual count will be in
    // `n_steps_accepted` if a planner needs the truth.)
    const nEvalEstimate = tEval !== undefined ? tEval.length : 2;
    const nStepsEstimate = Math.max(
      nEvalEstimate,
      Math.ceil(Math.abs(tf - t0) * Math.pow(1 / rtol, 1 / 5)),
    );
    const warnings: string[] = assessNumericalScale(
      "ode-rkf45",
      n,
      nStepsEstimate,
      nEvalEstimate,
    );

    // Run.
    let result: IntegrateResult;
    try {
      const opts: IntegrateOptions = { rtol, atol };
      if (maxStep !== undefined) (opts as { maxStep: number }).maxStep = maxStep;
      if (tEval !== undefined) (opts as { tEval: readonly number[] }).tEval = tEval;
      result = integrate(f, t0, tf, y0, opts);
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
            suggestion: `reduce n_components or t_eval length; the FFI bridge (bead scientist-workbench-e7y) is the right escape hatch for production-scale ODE problems`,
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
    // Smoke probe: scalar exp-decay must land within bench tolerance.
    const f = (_t: number, y: Float64Array, out: Float64Array): void => {
      out[0] = -y[0]!;
    };
    const r = integrate(f, 0, 5, new Float64Array([1.0]), {
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
    if (r.nEvals < 6 * r.nStepsAccepted) {
      throw new Error(`test: FSAL invariant violated — n_evals=${r.nEvals} < 6·n_steps_accepted=${6 * r.nStepsAccepted}`);
    }

    // 2D harmonic oscillator: one full period, sub-step dense
    // evaluation forces the Hermite extension on every t_eval row.
    const fHarm = (_t: number, y: Float64Array, out: Float64Array): void => {
      out[0] = y[1]!;
      out[1] = -y[0]!;
    };
    const tEval: number[] = [];
    for (let i = 0; i <= 50; i++) tEval.push((i / 50) * 2 * Math.PI);
    const rH = integrate(fHarm, 0, 2 * Math.PI, new Float64Array([1, 0]), {
      rtol: 1e-8, atol: 1e-11, tEval,
    });
    let maxErr = 0;
    for (let i = 0; i < tEval.length; i++) {
      const t = tEval[i]!;
      const y0Ref = Math.cos(t);
      const y1Ref = -Math.sin(t);
      const e = Math.max(Math.abs(rH.trajectory[i]![0]! - y0Ref), Math.abs(rH.trajectory[i]![1]! - y1Ref));
      if (e > maxErr) maxErr = e;
    }
    if (maxErr > 1e-5) {
      throw new Error(`test: harmonic dense interpolation max err ${maxErr.toExponential(2)} > 1e-5`);
    }

    // Reverse integration: y(5) = exp(-5) → y(0) should be 1.
    const rRev = integrate(f, 5, 0, new Float64Array([Math.exp(-5)]), {
      rtol: 1e-8, atol: 1e-11, tEval: [5, 4, 3, 2, 1, 0],
    });
    if (rRev.status !== "success") {
      throw new Error(`test: reverse exp-decay status=${rRev.status}`);
    }
    if (Math.abs(rRev.trajectory[5]![0]! - 1) > 1e-5) {
      throw new Error(`test: reverse exp-decay at t=0: got ${rRev.trajectory[5]![0]}, expected 1`);
    }
  },
});

if (import.meta.main) void runTool(def);
