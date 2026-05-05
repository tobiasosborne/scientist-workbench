// =============================================================================
// integrate-ode-symplectic — symplectic flow integration for separable H
// =============================================================================
//
// Intent
// ------
// Third slice of the ODE epic (parent: bead `scientist-workbench-32z`,
// this slice: `scientist-workbench-4gr`). Integrates separable
// Hamiltonian systems
//
//     H(q, p) = T(p) + V(q),   dq/dt = ∂H/∂p,   dp/dt = −∂H/∂q
//
// via:
//
//   * **Velocity Verlet** (2nd-order; default). One Verlet step per
//     coarse step. The MD workhorse.
//   * **Yoshida-4** (4th-order; `options.scheme = "yoshida-4"`). Three
//     Verlet sub-steps with Suzuki-Yoshida composition coefficients
//     `[w, 1−2w, w]` where `w = 1/(2 − 2^(1/3))`.
//
// Reference: Hairer-Lubich-Wanner *Geometric Numerical Integration*
// §I.3.1 (Verlet), §VI.3 (Yoshida composition), §VI.6 (backward error
// analysis: why energy drift is bounded `O(h^p)` for symplectic methods
// regardless of horizon — the discriminator versus DOPRI5 on Kepler).
//
// What makes this tool agent-honest
// ---------------------------------
// The output carries everything a planner needs to reason about
// symplecticity:
//
//     {
//       q_trajectory,            // (n_steps+1 × |q|)
//       p_trajectory,            // (n_steps+1 × |p|)
//       t_values,                 // (n_steps+1,) uniform grid t0..tf
//       energy,                   // (n_steps+1,) H(q_i, p_i) at each step
//       energy_drift_max,         // max |H_i − H_0| / max(|H_0|, atol)
//       energy_drift_secular,     // linear-fit-vs-time discriminator
//       n_evals,                  // gradient evaluations
//       n_steps,
//       converged,                // ⇔ status === "success"
//       status,                   // "success" | "non-finite-during-eval"
//       method,                   // "velocity-verlet" | "yoshida-4"
//       warnings,
//     }
//
// `energy_drift_secular` is the load-bearing diagnostic: a correct
// symplectic integrator on a separable H *never* sets it true. A
// non-symplectic candidate submitted on the same bench would fail the
// long-time tier-C cases (Kepler 100 periods, Hénon-Heiles, harmonic
// 100 periods) on this discriminator.
//
// Boundary categories (ADR-0003)
// ------------------------------
//   * `integrate-ode-symplectic/degenerate-tspan` (tagged): `t0 == tf`
//     or `n_steps == 0`. Payload `{t0, tf, n_steps}`.
//   * `integrate-ode-symplectic/non-separable-hamiltonian` (tagged):
//     `∂H/∂q_i` depends on some `p_j`, or `∂H/∂p_j` depends on some
//     `q_i`. Velocity Verlet's symplecticity guarantee depends on
//     separability — non-separable inputs need implicit symplectic
//     methods (Gauss-Legendre, Radau-IIA on the augmented system),
//     deferred to v0.2. Payload `{reason}`.
//   * `integrate-ode-symplectic/non-finite-during-eval` (tagged): a step
//     produced NaN/±Inf, or `H` evaluated non-finite, mid-integration.
//     Payload `{at_t, at_q, at_p, kind}`.
//   * Malformed input (`ToolError`, exit 1):
//     - `len(q_vars) ≠ len(p_vars)`: H must have equal-dim coordinates.
//     - `len(q_vars) ≠ len(q0)` or `len(p_vars) ≠ len(p0)`: dim
//       mismatch.
//     - empty `q_vars` / `p_vars`.
//     - any `q0[i]` / `p0[i]` non-finite at input time.
//     - non-finite `t0` / `tf`.
//     - `n_steps < 0` (note: `n_steps == 0` is a *boundary*, not a
//       malformed input, since the agent's intent is structurally
//       legible).
//     - unknown expression head or free symbol in `H`: vocabulary
//       violation. Suggestion lists admitted heads / constants.
//     - malformed options.
//
// In-process composition (ADR-0012)
// ---------------------------------
// At setup the tool calls `wb.run("cas-diff", record({f: H, var: q_i}))`
// (and similarly for each `p_j`) to produce symbolic `∂H/∂q_i` and
// `∂H/∂p_j` expression Values. These are cached and compiled to
// numeric callables via `evalNumericExpr` from `@workbench/quadrature`.
// The inner Verlet loop calls those callables — no symbolic work per
// step.
//
// The workbench is built lazily on the first `fn` invocation and
// cached at module scope. Building it every call would dominate the
// integration cost (~150 ms cold load). The cache is keyed by store
// path so different `CAS_STORE` paths get different workbenches
// (provenance writes from cas-diff's runs land in the right place).
//
// ADR-0015 — numerical tier
// -------------------------
// `numerical: true`. Every output containing float64 leaves
// (trajectories, energy, drift_max) is platform-conditional in the
// sense ADR-0015 names; the runner records the platform fingerprint
// on every successful run. Mutually exclusive with `nondeterministic:
// true`.

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
  HamiltonianDegenerateError,
  HamiltonianNonFiniteError,
  type HamiltonianFlowCallables,
  type HamiltonianFlowResult,
  type HamiltonianScheme,
  integrateHamiltonianFlow,
} from "@workbench/ode-core";

const NAME = "integrate-ode-symplectic";
const VERSION = "0.1.0";

const ADMITTED_OPTION_KEYS: ReadonlySet<string> = new Set(["scheme", "atol"]);
const ADMITTED_SCHEMES: ReadonlySet<string> = new Set(["verlet", "yoshida-4"]);

// -----------------------------------------------------------------------------
// Schema
// -----------------------------------------------------------------------------
//
// `H` is `S.any()` mirroring `cas-diff` / `integrate-1d` /
// `integrate-ode-ivp`: the closed-vocabulary check happens lazily
// (`evalNumericExpr` raises `UnknownVocabularyError`) rather than in
// the schema, so error messages can carry the offending head string.

const inputSchema = S.record(
  {
    H: S.any(),
    q_vars: S.list(S.kind("symbol")),
    p_vars: S.list(S.kind("symbol")),
    t_var: S.kind("symbol"),
    q0: S.list(S.kind("float64")),
    p0: S.list(S.kind("float64")),
    t_span: S.record({
      t0: S.kind("float64"),
      tf: S.kind("float64"),
    }),
    n_steps: S.kind("integer"),
    options: S.record(
      {
        scheme: S.kind("string"),
        atol: S.kind("float64"),
      },
      { optional: ["scheme", "atol"] },
    ),
  },
  { optional: ["options"] },
);

const successOutputSchema = S.record({
  q_trajectory: S.list(S.list(S.kind("float64"))),
  p_trajectory: S.list(S.list(S.kind("float64"))),
  t_values: S.list(S.kind("float64")),
  energy: S.list(S.kind("float64")),
  energy_drift_max: S.kind("float64"),
  energy_drift_secular: S.kind("boolean"),
  n_evals: S.kind("integer"),
  n_steps: S.kind("integer"),
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
    n_steps: S.kind("integer"),
  }),
);

const nonSeparableOutputSchema = S.tagged(
  `${NAME}/non-separable-hamiltonian`,
  S.record({
    reason: S.kind("string"),
  }),
);

const nonFiniteOutputSchema = S.tagged(
  `${NAME}/non-finite-during-eval`,
  S.record({
    at_t: S.kind("float64"),
    at_q: S.list(S.kind("float64")),
    at_p: S.list(S.kind("float64")),
    kind: S.kind("string"),
  }),
);

const outputSchema = S.union([
  successOutputSchema,
  degenerateTspanOutputSchema,
  nonSeparableOutputSchema,
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

function encodeSuccess(r: HamiltonianFlowResult, warnings: readonly string[]) {
  return record({
    q_trajectory: trajectoryToValue(r.qTrajectory),
    p_trajectory: trajectoryToValue(r.pTrajectory),
    t_values: listOfFloat64(r.tValues),
    energy: listOfFloat64(r.energy),
    energy_drift_max: float64FromNumber(r.energyDriftMax),
    energy_drift_secular: bool(r.energyDriftSecular),
    n_evals: int(BigInt(r.nEvals)),
    n_steps: int(BigInt(r.nSteps)),
    converged: bool(true),
    status: str("success"),
    method: str(r.method),
    warnings: list(warnings.map((w) => str(w))),
  });
}

// -----------------------------------------------------------------------------
// Symbol-dependence walker
// -----------------------------------------------------------------------------
//
// Used twice: (i) on `H` itself, to detect free symbols outside the
// declared `(q_vars, p_vars, t_var, "pi", "e")` vocabulary; (ii) on
// each cas-diff'd partial derivative, to detect cross-coordinate
// dependencies (∂H/∂q must not depend on any `p_j`, and vice versa)
// — the separability check.
//
// `symbolDepends(node, names)` returns the *first* name in `names`
// the expression mentions, or `undefined` if none. It walks the full
// expression tree.

function symbolDepends(
  node: Value,
  names: ReadonlySet<string>,
): string | undefined {
  switch (node.kind) {
    case "symbol":
      return names.has(node.name) ? node.name : undefined;
    case "expression": {
      for (const arg of node.args) {
        const r = symbolDepends(arg, names);
        if (r !== undefined) return r;
      }
      return undefined;
    }
    case "integer":
    case "rational":
    case "float64":
    case "string":
    case "boolean":
      return undefined;
    case "list":
    case "record":
    case "tagged":
      // These are not part of the closed expression vocabulary, but
      // walking them defensively keeps the function total. cas-diff
      // would already have refused such inputs upstream.
      return undefined;
  }
}

// -----------------------------------------------------------------------------
// Lazy in-process workbench
// -----------------------------------------------------------------------------
//
// ADR-0010 forbids module-level side effects. ADR-0012 prefers
// in-process composition over subprocess spawn. Reconciling the two:
// build the workbench lazily on first `fn` call and cache it under
// the active `CAS_STORE` path. Subsequent calls reuse the cached
// instance — the load is amortised across the session.

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
      // Dynamic import keeps `@workbench/compose` out of this module's
      // dep chain at static-import time. The runner imports our `def`
      // to read schema/examples/invariants without ever needing a
      // workbench; the workbench is paid for only when `fn` runs.
      const { loadWorkbench } = await import("@workbench/compose");
      return await loadWorkbench();
    })();
    cachedWorkbenchByStore.set(storeKey, promise);
  }
  return promise;
}

// -----------------------------------------------------------------------------
// cas-diff in-process: produce the symbolic ∂H/∂q_i / ∂H/∂p_j Values.
// -----------------------------------------------------------------------------
//
// The brief specifies `wb.run("cas-diff", record({f: H, var: q_i}))`.
// cas-diff's output is either a happy-path expression Value or a
// `tagged "cas-diff/out-of-scope"` boundary; the latter means H
// contains a head outside the closed differentiation vocabulary, which
// we surface as a `ToolError` (malformed input — H is not in scope).

async function differentiateInProcess(
  wb: MinimalWorkbench,
  H: Value,
  varSym: SymbolValue,
): Promise<Value> {
  const out = await wb.run(
    "cas-diff",
    record({ f: H, var: varSym }),
  );
  if (out.kind === "tagged" && out.tag === "cas-diff/out-of-scope") {
    throw new ToolError(
      `${NAME}: H contains a head or Value kind outside the closed differentiation vocabulary (cas-diff out-of-scope on ∂/∂${varSym.name})`,
      {
        suggestion: `admitted heads: ${ADMITTED_HEADS.join(", ")}; admitted constants: ${ADMITTED_CONSTANTS.join(", ")}`,
      },
    );
  }
  return out;
}

// -----------------------------------------------------------------------------
// Build evaluator callables from cached gradient expressions
// -----------------------------------------------------------------------------
//
// The Verlet driver wants three callables:
//   * `force(q, out)`    — fills `out[i] = −∂H/∂q_i(q)`. For separable
//                           H this is independent of `p`; we still
//                           accept the env layout `{q_vars, p_vars}`
//                           because `evalNumericExpr` is symbol-driven
//                           and the driver writes `q` into the env;
//                           `p` is left at its previous binding (which
//                           in the separable case never appears in the
//                           expression).
//   * `velocity(p, out)` — fills `out[i] = ∂H/∂p_i(p)`.
//   * `energy(q, p)`     — returns `H(q, p)`.
//
// The shared env Map is reused across calls (allocation-free in inner
// loop). Default bindings for `q_vars`, `p_vars`, and `t_var` (= 0)
// are set once at construction time.

function buildCallables(
  H: Value,
  dHdq: readonly Value[],
  dHdp: readonly Value[],
  qVars: readonly string[],
  pVars: readonly string[],
  tVar: string,
): HamiltonianFlowCallables {
  const env = new Map<string, number>();
  env.set(tVar, 0);
  for (const v of qVars) env.set(v, 0);
  for (const v of pVars) env.set(v, 0);
  const nQ = qVars.length;
  const nP = pVars.length;

  return {
    force(q: Float64Array, out: Float64Array): void {
      // out[i] = −∂H/∂q_i at the given q
      for (let i = 0; i < nQ; i++) env.set(qVars[i]!, q[i]!);
      for (let i = 0; i < nQ; i++) {
        out[i] = -evalNumericExpr(dHdq[i]!, env);
      }
    },
    velocity(p: Float64Array, out: Float64Array): void {
      // out[i] = ∂H/∂p_i at the given p
      for (let i = 0; i < nP; i++) env.set(pVars[i]!, p[i]!);
      for (let i = 0; i < nP; i++) {
        out[i] = evalNumericExpr(dHdp[i]!, env);
      }
    },
    energy(q: Float64Array, p: Float64Array): number {
      for (let i = 0; i < nQ; i++) env.set(qVars[i]!, q[i]!);
      for (let i = 0; i < nP; i++) env.set(pVars[i]!, p[i]!);
      return evalNumericExpr(H, env);
    },
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
      description: "1-DOF harmonic H = (q² + p²)/2 over one period; energy bounded ~1e-12",
      input: record({
        H: expr("/", [
          expr("+", [
            expr("^", [sym("q"), int(2n)]),
            expr("^", [sym("p"), int(2n)]),
          ]),
          int(2n),
        ]),
        q_vars: list([sym("q")]),
        p_vars: list([sym("p")]),
        t_var: sym("t"),
        q0: list([float64FromNumber(1.0)]),
        p0: list([float64FromNumber(0.0)]),
        t_span: record({
          t0: float64FromNumber(0),
          tf: float64FromNumber(2 * Math.PI),
        }),
        n_steps: int(100n),
      }),
      // Output omitted — the example is a structure-shape probe; the
      // runtime body is what's spec'd against the bench. (cas-diff
      // round-trip would make this prohibitively long to spell out
      // verbatim here.)
    },
    {
      description: "degenerate tspan t0 == tf → tagged degenerate-tspan",
      input: record({
        H: expr("/", [
          expr("+", [
            expr("^", [sym("q"), int(2n)]),
            expr("^", [sym("p"), int(2n)]),
          ]),
          int(2n),
        ]),
        q_vars: list([sym("q")]),
        p_vars: list([sym("p")]),
        t_var: sym("t"),
        q0: list([float64FromNumber(1.0)]),
        p0: list([float64FromNumber(0.0)]),
        t_span: record({
          t0: float64FromNumber(0),
          tf: float64FromNumber(0),
        }),
        n_steps: int(10n),
      }),
      output: tagged(`${NAME}/degenerate-tspan`, record({
        t0: float64FromNumber(0),
        tf: float64FromNumber(0),
        n_steps: int(10n),
      })),
    },
    {
      description: "n_steps == 0 → tagged degenerate-tspan",
      input: record({
        H: expr("/", [
          expr("+", [
            expr("^", [sym("q"), int(2n)]),
            expr("^", [sym("p"), int(2n)]),
          ]),
          int(2n),
        ]),
        q_vars: list([sym("q")]),
        p_vars: list([sym("p")]),
        t_var: sym("t"),
        q0: list([float64FromNumber(1.0)]),
        p0: list([float64FromNumber(0.0)]),
        t_span: record({
          t0: float64FromNumber(0),
          tf: float64FromNumber(1),
        }),
        n_steps: int(0n),
      }),
      output: tagged(`${NAME}/degenerate-tspan`, record({
        t0: float64FromNumber(0),
        tf: float64FromNumber(1),
        n_steps: int(0n),
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
      name: "energy-drift-bounded",
      statement: "for separable H integrated over [t0, tf] with step h, the energy drift max_i |H(q_i, p_i) − H(q_0, p_0)| / max(|H_0|, atol) is bounded ≤ 100·h^p·drift_constant for the integrator's order p (Verlet: 2; Yoshida-4: 4) — HLW §VI.6 backward error analysis",
      machine_checkable: true,
    },
    {
      name: "energy-drift-not-secular-on-separable-H",
      statement: "for any separable H integrated over arbitrarily long horizon, energy_drift_secular is false. The discriminator: a non-symplectic candidate would fail this on Kepler 100/10⁴ orbits; a correct symplectic integrator never sets it true",
      machine_checkable: true,
    },
    {
      name: "trajectory-shape",
      statement: "q_trajectory has shape (n_steps+1, |q_vars|); p_trajectory has shape (n_steps+1, |p_vars|); t_values, energy length n_steps+1",
      machine_checkable: true,
    },
    {
      name: "monotone-uniform-t-values",
      statement: "t_values are uniformly spaced t0..tf with step h = (tf−t0)/n_steps. Symplectic integrators are fixed-step by design",
      machine_checkable: true,
    },
    {
      name: "converged-iff-success",
      statement: `converged === (status === "success") — every code path enforces this`,
      machine_checkable: true,
    },
    {
      name: "non-separable-h-tagged",
      statement: `H with ∂H/∂q_i depending on any p_j (or ∂H/∂p_j depending on any q_i) ⇒ tagged "${NAME}/non-separable-hamiltonian" with reason — never silently produces wrong-quality output`,
      machine_checkable: true,
    },
    {
      name: "degenerate-tspan-tagged",
      statement: `t0 == tf or n_steps == 0 ⇒ tagged "${NAME}/degenerate-tspan" — never a (silently empty / silently y0) success record`,
      machine_checkable: true,
    },
    {
      name: "non-finite-tagged",
      statement: `step or H-evaluation producing NaN/±Inf ⇒ tagged "${NAME}/non-finite-during-eval" with offending (at_t, at_q, at_p, kind) — never NaN-poisoned trajectory`,
      machine_checkable: true,
    },
    {
      name: "unknown-vocabulary-rejected",
      statement: "H containing a head or free symbol outside the closed vocabulary raises ToolError with a suggestion listing admitted heads/constants",
      machine_checkable: true,
    },
    {
      name: "dim-mismatch-rejected",
      statement: "len(q_vars) ≠ len(p_vars), len(q_vars) ≠ len(q0), or len(p_vars) ≠ len(p0) ⇒ ToolError with the offending lengths",
      machine_checkable: true,
    },
  ],
  fn: async (input, _flags): Promise<Value> => {
    // The runner has validated the input shape against `inputSchema`,
    // so structural invariants on each field are already guaranteed.
    // Semantic checks (vocabulary, dim agreement, finite tspan) live
    // here.
    const fields = input.fields;

    const qVarsItems = (fields.q_vars as ListValue).items;
    const pVarsItems = (fields.p_vars as ListValue).items;
    const qVars = qVarsItems.map((s) => (s as SymbolValue).name);
    const pVars = pVarsItems.map((s) => (s as SymbolValue).name);
    const tVar = (fields.t_var as SymbolValue).name;
    const nQ = qVars.length;
    const nP = pVars.length;

    if (nQ === 0) {
      throw new ToolError(`${NAME}: q_vars must be non-empty`, {
        suggestion: "supply at least one position coordinate",
      });
    }
    if (nQ !== nP) {
      throw new ToolError(
        `${NAME}: q_vars.length ${nQ} != p_vars.length ${nP}`,
        {
          suggestion: "Hamiltonian flow requires equal-dim q and p (one momentum per coordinate)",
        },
      );
    }

    const q0Items = (fields.q0 as ListValue).items;
    const p0Items = (fields.p0 as ListValue).items;
    if (q0Items.length !== nQ) {
      throw new ToolError(
        `${NAME}: q0.length ${q0Items.length} != q_vars.length ${nQ}`,
        { suggestion: `provide one initial value per q variable` },
      );
    }
    if (p0Items.length !== nP) {
      throw new ToolError(
        `${NAME}: p0.length ${p0Items.length} != p_vars.length ${nP}`,
        { suggestion: `provide one initial value per p variable` },
      );
    }

    const q0 = new Float64Array(nQ);
    for (let i = 0; i < nQ; i++) {
      const v = float64ToNumber(q0Items[i] as Float64Value);
      if (!Number.isFinite(v)) {
        throw new ToolError(
          `${NAME}: q0[${i}] is non-finite (${v})`,
          { suggestion: "every q0 entry must be a finite IEEE-754 binary64 value" },
        );
      }
      q0[i] = v;
    }
    const p0 = new Float64Array(nP);
    for (let i = 0; i < nP; i++) {
      const v = float64ToNumber(p0Items[i] as Float64Value);
      if (!Number.isFinite(v)) {
        throw new ToolError(
          `${NAME}: p0[${i}] is non-finite (${v})`,
          { suggestion: "every p0 entry must be a finite IEEE-754 binary64 value" },
        );
      }
      p0[i] = v;
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

    const nStepsBig = (fields.n_steps as { value: string }).value;
    const nSteps = Number(nStepsBig);
    if (!Number.isInteger(nSteps) || nSteps < 0) {
      throw new ToolError(
        `${NAME}: n_steps must be a non-negative integer (got ${nStepsBig})`,
        {},
      );
    }

    // Decode options.
    let scheme: HamiltonianScheme = "velocity-verlet";
    let atol = 1e-9;
    const optsValue = fields.options as RecordValue | undefined;
    if (optsValue !== undefined) {
      for (const k of Object.keys(optsValue.fields)) {
        if (!ADMITTED_OPTION_KEYS.has(k)) {
          throw new ToolError(
            `${NAME}: unknown option key "${k}"`,
            { suggestion: `admitted options: ${[...ADMITTED_OPTION_KEYS].join(", ")}` },
          );
        }
      }
      if (optsValue.fields.scheme !== undefined) {
        const s = (optsValue.fields.scheme as StringValue).value;
        if (!ADMITTED_SCHEMES.has(s)) {
          throw new ToolError(
            `${NAME}: unknown scheme "${s}"`,
            { suggestion: `admitted schemes: ${[...ADMITTED_SCHEMES].join(", ")}` },
          );
        }
        scheme = s === "yoshida-4" ? "yoshida-4" : "velocity-verlet";
      }
      if (optsValue.fields.atol !== undefined) {
        atol = float64ToNumber(optsValue.fields.atol as Float64Value);
        if (!Number.isFinite(atol) || atol <= 0) {
          throw new ToolError(
            `${NAME}: options.atol must be a finite positive float64 (got ${atol})`,
            {},
          );
        }
      }
    }

    // Degenerate-tspan boundary tag (t0 == tf or n_steps == 0). We
    // detect *before* attempting cas-diff so a degenerate input that
    // would otherwise stress the differentiator returns the structural
    // tag the agent expects.
    if (t0 === tf || nSteps === 0) {
      return tagged(`${NAME}/degenerate-tspan`, record({
        t0: float64FromNumber(t0),
        tf: float64FromNumber(tf),
        n_steps: int(BigInt(nSteps)),
      }));
    }

    const H = fields.H as Value;

    // Up-front vocabulary check on H itself — catches unknown free
    // symbols (e.g. an undeclared variable) before cas-diff runs. We
    // probe `evalNumericExpr` at a dummy point with all declared
    // symbols bound; an unknown head or a free symbol outside
    // (q_vars ∪ p_vars ∪ {t_var, "pi", "e"}) raises
    // UnknownVocabularyError, which we translate to ToolError.
    const probeEnv = new Map<string, number>();
    probeEnv.set(tVar, 0);
    for (const v of qVars) probeEnv.set(v, 0);
    for (const v of pVars) probeEnv.set(v, 0);
    try {
      // The result is unused; we just want the head/symbol check.
      void evalNumericExpr(H, probeEnv);
    } catch (err) {
      if (err instanceof UnknownVocabularyError) {
        throw new ToolError(`${NAME}: ${err.message}`, {
          suggestion: err.kind === "head"
            ? `admitted heads: ${ADMITTED_HEADS.join(", ")}`
            : `admitted free constants: ${ADMITTED_CONSTANTS.join(", ")}; the declared variables are q_vars=${qVars.join(",")}, p_vars=${pVars.join(",")}, t_var="${tVar}"`,
        });
      }
      throw err;
    }

    // Compose with cas-diff in-process: derive ∂H/∂q_i and ∂H/∂p_j
    // symbolically. The workbench is built once per process and
    // reused across `fn` calls.
    const wb = await getWorkbench();
    const dHdq = new Array<Value>(nQ);
    const dHdp = new Array<Value>(nP);
    for (let i = 0; i < nQ; i++) {
      dHdq[i] = await differentiateInProcess(wb, H, sym(qVars[i]!));
    }
    for (let j = 0; j < nP; j++) {
      dHdp[j] = await differentiateInProcess(wb, H, sym(pVars[j]!));
    }

    // Separability: ∂H/∂q_i must not contain any p_j; ∂H/∂p_j must
    // not contain any q_i. Walk the cas-diff outputs and report the
    // first cross-coordinate dependency found.
    const pNameSet = new Set(pVars);
    const qNameSet = new Set(qVars);
    for (let i = 0; i < nQ; i++) {
      const offending = symbolDepends(dHdq[i]!, pNameSet);
      if (offending !== undefined) {
        return tagged(`${NAME}/non-separable-hamiltonian`, record({
          reason: str(`∂H/∂${qVars[i]!} depends on ${offending}`),
        }));
      }
    }
    for (let j = 0; j < nP; j++) {
      const offending = symbolDepends(dHdp[j]!, qNameSet);
      if (offending !== undefined) {
        return tagged(`${NAME}/non-separable-hamiltonian`, record({
          reason: str(`∂H/∂${pVars[j]!} depends on ${offending}`),
        }));
      }
    }

    // Build the gradient + energy callables and run the driver.
    const callables = buildCallables(H, dHdq, dHdp, qVars, pVars, tVar);
    const warnings: string[] = [];

    let result: HamiltonianFlowResult;
    try {
      result = integrateHamiltonianFlow(q0, p0, t0, tf, nSteps, callables, {
        scheme,
        atol,
      });
    } catch (err) {
      if (err instanceof HamiltonianDegenerateError) {
        // Belt-and-braces — already screened above, but the driver
        // throws on its own check too, so we honour both code paths.
        return tagged(`${NAME}/degenerate-tspan`, record({
          t0: float64FromNumber(err.t0),
          tf: float64FromNumber(err.tf),
          n_steps: int(BigInt(err.nSteps)),
        }));
      }
      if (err instanceof HamiltonianNonFiniteError) {
        return tagged(`${NAME}/non-finite-during-eval`, record({
          at_t: float64FromNumber(err.atT),
          at_q: listOfFloat64(err.atQ),
          at_p: listOfFloat64(err.atP),
          kind: str(err.kind),
        }));
      }
      if (err instanceof UnknownVocabularyError) {
        // A subterm outside the closed vocabulary slipped past the
        // probe (this can happen if e.g. a `tan(q)` near a pole was
        // never reached at the probe point but is hit during the
        // integration loop — UnknownVocabularyError covers head
        // unknowns; the symbol-level case is screened by the probe).
        throw new ToolError(`${NAME}: ${err.message}`, {
          suggestion: err.kind === "head"
            ? `admitted heads: ${ADMITTED_HEADS.join(", ")}`
            : `admitted free constants: ${ADMITTED_CONSTANTS.join(", ")}; the declared variables are q_vars=${qVars.join(",")}, p_vars=${pVars.join(",")}, t_var="${tVar}"`,
        });
      }
      if (err instanceof RangeError && /Invalid array length|Invalid typed array length/.test(err.message)) {
        throw new ToolError(
          `${NAME}: out of memory: ${err.message}`,
          {
            suggestion: `reduce n_steps or n_components; the FFI bridge (bead scientist-workbench-e7y) is the right escape hatch for production-scale ODE problems`,
          },
        );
      }
      throw err;
    }

    return encodeSuccess(result, warnings);
  },
  test: () => {
    // Smoke probe: 1-DOF harmonic oscillator over one period must
    // return a bounded energy drift and (with one period sampled) a
    // non-secular flag. Uses the substrate directly rather than going
    // through the wire-encoding wrapper — the wire wrapper's own
    // round-trip is tested by `bun run goldens`.
    const H = expr("/", [
      expr("+", [
        expr("^", [sym("q"), int(2n)]),
        expr("^", [sym("p"), int(2n)]),
      ]),
      int(2n),
    ]);
    const dHdq = sym("q");      // d/dq of (q²+p²)/2
    const dHdp = sym("p");      // d/dp of (q²+p²)/2
    const callables = buildCallables(H, [dHdq], [dHdp], ["q"], ["p"], "t");
    const r = integrateHamiltonianFlow(
      new Float64Array([1]),
      new Float64Array([0]),
      0, 2 * Math.PI, 100, callables,
    );
    if (r.method !== "velocity-verlet") {
      throw new Error(`test: method=${r.method}, expected velocity-verlet`);
    }
    if (r.qTrajectory.length !== 101) {
      throw new Error(`test: q_trajectory length ${r.qTrajectory.length}, expected 101`);
    }
    if (r.energyDriftSecular) {
      throw new Error(`test: harmonic over one period reported energy_drift_secular: true`);
    }
    if (r.energyDriftMax > 1e-2) {
      throw new Error(`test: harmonic energy_drift_max ${r.energyDriftMax.toExponential(2)} > 1e-2`);
    }
    // After one full period the harmonic returns to (1, 0) modulo h².
    const qFinal = r.qTrajectory[100]![0]!;
    const pFinal = r.pTrajectory[100]![0]!;
    if (Math.abs(qFinal - 1) > 1e-1 || Math.abs(pFinal) > 1e-1) {
      throw new Error(
        `test: harmonic final state (${qFinal}, ${pFinal}) far from (1, 0)`,
      );
    }

    // Yoshida-4 must do strictly better on the same problem.
    const r4 = integrateHamiltonianFlow(
      new Float64Array([1]),
      new Float64Array([0]),
      0, 2 * Math.PI, 100, callables,
      { scheme: "yoshida-4" },
    );
    if (r4.method !== "yoshida-4") {
      throw new Error(`test: yoshida method=${r4.method}, expected yoshida-4`);
    }
    if (r4.energyDriftMax >= r.energyDriftMax) {
      throw new Error(
        `test: yoshida-4 drift ${r4.energyDriftMax.toExponential(2)} >= verlet drift ${r.energyDriftMax.toExponential(2)} — Yoshida-4 should be strictly more accurate`,
      );
    }

    // Long-time conservation: harmonic over 100 periods, drift bounded
    // and not secular. This is the discriminator a non-symplectic
    // candidate would fail.
    const rLong = integrateHamiltonianFlow(
      new Float64Array([1]),
      new Float64Array([0]),
      0, 100 * 2 * Math.PI, 10_000, callables,
    );
    if (rLong.energyDriftSecular) {
      throw new Error(`test: harmonic 100 periods flagged secular drift — symplectic integrator should never do that`);
    }
    if (rLong.energyDriftMax > 1e-2) {
      throw new Error(`test: harmonic 100 periods drift ${rLong.energyDriftMax.toExponential(2)} > 1e-2 — bounded?`);
    }

    // Degenerate tspan throws.
    let threwDegen = false;
    try {
      integrateHamiltonianFlow(
        new Float64Array([1]),
        new Float64Array([0]),
        0, 0, 10, callables,
      );
    } catch (e) {
      if (e instanceof HamiltonianDegenerateError) threwDegen = true;
    }
    if (!threwDegen) {
      throw new Error(`test: t0==tf did not throw HamiltonianDegenerateError`);
    }
  },
});

if (import.meta.main) void runTool(def);
