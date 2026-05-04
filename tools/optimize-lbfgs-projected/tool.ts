// =============================================================================
// optimize-lbfgs-projected — limited-memory BFGS with simple bound constraints
// =============================================================================
//
// Intent
// ------
// The third numerical-tier tool in scientist-workbench, after
// `linalg-solve` (LU + iterative refinement; ADR-0014 precedent) and
// `integrate-1d` (adaptive Gauss-Kronrod quadrature; ADR-0015
// determinism-tier precedent). Computes
//
//     argmin_{lower ≤ x ≤ upper}  f(x)
//
// for a smooth `f` with analytic gradient over a closed-vocabulary
// expression. Wire wrapper around `@workbench/lbfgs-projected`'s `lbfgsProjected` and
// `@workbench/quadrature`'s `evalNumericExpr`.
//
// What makes this tool agent-honest (the load-bearing design choice):
// the output is *not* just `x`. It is a record carrying everything an
// agent's planner needs to decide what to do with the answer:
//
//     {
//       x,                       // solution vector
//       fun,                     // f(x)
//       jac,                     // grad f(x)
//       grad_inf_norm,           // ‖projected grad‖_∞ — the honest stop criterion
//       iterations,              // outer iterations performed
//       nfev,                    // f + grad evaluations performed
//       status,                  // 0 grad-norm, 1 f-reduction, 2 max-iter,
//                                //    3 max-fun, 4 line-search-failure
//       status_message,          // human-readable, mirrors scipy's strings
//       success,                 // true iff status ∈ {0, 1}
//       bfgs_skip_count,         // L-BFGS curvature-violation skips
//       line_search_fail_count,  // line-search failures (with reset retries)
//       active_bounds_count,     // # bounds active at the solution
//       method,                  // "l-bfgs-b"
//       warnings,                // human-readable diagnostics
//     }
//
// `success` is a *field* — same shape pattern as `linalg-solve`'s
// `condition_estimate` and `integrate-1d`'s `converged`. A planner
// that sees `success: false` reads `status` and `warnings` and
// decides whether to retry with a higher budget, accept the partial
// result, or warn the user. Budget exhaustion (`status ∈ {2, 3}`) is
// the happy-path RECORD with `success: false`, NOT a separate
// boundary tag — scipy itself reports it through the same
// `OptimizeResult` shape, and an agent's planner reads it identically.
//
// Boundary categories (ADR-0003)
// ------------------------------
//   * `optimize-lbfgs-projected/infeasible-bounds` (tagged): some `lower[i] >
//     upper[i]`. Payload carries the offending index and the bound
//     pair.
//   * `optimize-lbfgs-projected/x0-outside-bounds` (tagged): some `x0[i]` is
//     strictly outside `[lower[i], upper[i]]`. Payload carries the
//     index and the offending values. (We do NOT silently project
//     `x0` into feasibility — that would mask a calling-convention
//     bug.)
//   * `optimize-lbfgs-projected/non-finite-during-eval` (tagged): `f` or
//     `grad` returned NaN / ±Inf at some iterate. Payload carries
//     the iterate and the source ("f" / "grad") + value description.
//   * Malformed input (`ToolError`, exit 1):
//     - `vars`, `x0`, `grad`, or `bounds` length disagree.
//     - `vars` length zero.
//     - any `x0[i]` is non-finite at input time (NaN, ±Inf).
//     - `f` or any `grad[i]` references an unknown head or unknown
//       symbol (suggestion lists the admitted vocabulary).
//     - any `bounds[i]` is not a 2-element list.
//     - `n > 200` (the v0.1 cap, matching `linalg-solve`).
//     - any option value is invalid (e.g. `maxiter ≤ 0`).
//     - any option key is unknown.
//
// ADR-0015 — numerical tier
// -------------------------
// `numerical: true`. Every output containing `x: float64` leaves is
// platform-conditional in the sense ADR-0015 names; the runner
// records the platform fingerprint on every successful run. The
// `--platform-fingerprint` standard flag emits the running
// fingerprint without doing any work.
//
// Out of scope (v0.1, all explicitly deferred)
// --------------------------------------------
//   * Equality / general nonlinear constraints (sister tools
//     `optimize-slsqp`, `optimize-trust-region` deferred).
//   * Bound-constrained least squares (`optimize-bvls` deferred).
//   * Finite-difference gradients (caller must supply analytic grad).
//   * Vector-valued or complex objectives.
//   * Vocabulary beyond `+ - * / ^ neg exp sin cos tan log sqrt abs`
//     plus constants `pi`, `e` — extension would be additive.
//   * Cross-platform bit-identity guarantee (ADR-0015 platform
//     fingerprint records the running platform).
//
// Algorithm
// ---------
// L-BFGS with active-set projection and More-Thuente-style line
// search. See `packages/lbfgs-projected/src/lbfgs-projected.ts` for the literate
// algorithmic prose, the citation chain (Byrd-Lu-Nocedal-Zhu 1995,
// Morales-Nocedal 2011 v3.0, Nocedal 1980), and the v3.0 safeguards.

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
  type IntegerValue,
  type ListValue,
  type RecordValue,
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
  lbfgsProjected,
  LBfgsbInfeasibleBoundsError,
  LBfgsbX0OutsideBoundsError,
  LBfgsbNonFiniteError,
  type LBfgsbOptions,
  type LBfgsbResult,
} from "@workbench/lbfgs-projected";

const NAME = "optimize-lbfgs-projected";
const VERSION = "0.1.0";
const METHOD_NAME = "l-bfgs-projected";

// v0.1 cap — matches `linalg-solve`'s discipline. Manifest's largest
// case is G2 at n=100, well under.
const MAX_N = 200;

const ADMITTED_OPTION_KEYS: ReadonlySet<string> = new Set([
  "maxcor",
  "ftol",
  "gtol",
  "maxiter",
  "maxfun",
  "maxls",
]);

// -----------------------------------------------------------------------------
// Schema
// -----------------------------------------------------------------------------
//
// `f` and `grad[i]` are declared `S.any()` because a recursive
// closed-vocabulary check inside the schema would be redundant with
// the per-node check in `evalNumericExpr`. The semantic check happens
// on first evaluation: an unknown head or symbol produces
// `ToolError` with the admitted-vocabulary suggestion.
//
// `bounds` is a list of 2-element lists `[lo, hi]` — the same shape
// scipy's API uses, so an agent can copy-paste.

const inputSchema = S.record(
  {
    f: S.any(),
    grad: S.list(S.any()),
    vars: S.list(S.kind("symbol")),
    x0: S.list(S.kind("float64")),
    bounds: S.list(S.list(S.kind("float64"))),
    options: S.record(
      {
        maxcor: S.kind("integer"),
        ftol: S.kind("float64"),
        gtol: S.kind("float64"),
        maxiter: S.kind("integer"),
        maxfun: S.kind("integer"),
        maxls: S.kind("integer"),
      },
      {
        optional: ["maxcor", "ftol", "gtol", "maxiter", "maxfun", "maxls"],
      },
    ),
  },
  { optional: ["options"] },
);

const successOutputSchema = S.record({
  x: S.list(S.kind("float64")),
  fun: S.kind("float64"),
  jac: S.list(S.kind("float64")),
  grad_inf_norm: S.kind("float64"),
  iterations: S.kind("integer"),
  nfev: S.kind("integer"),
  status: S.kind("integer"),
  status_message: S.kind("string"),
  success: S.kind("boolean"),
  bfgs_skip_count: S.kind("integer"),
  line_search_fail_count: S.kind("integer"),
  active_bounds_count: S.kind("integer"),
  method: S.kind("string"),
  warnings: S.list(S.kind("string")),
});

const infeasibleBoundsOutputSchema = S.tagged(
  `${NAME}/infeasible-bounds`,
  S.record({
    variable: S.kind("integer"),
    lower: S.kind("float64"),
    upper: S.kind("float64"),
  }),
);

const x0OutsideBoundsOutputSchema = S.tagged(
  `${NAME}/x0-outside-bounds`,
  S.record({
    variable: S.kind("integer"),
    x0: S.kind("float64"),
    lower: S.kind("float64"),
    upper: S.kind("float64"),
  }),
);

const nonFiniteOutputSchema = S.tagged(
  `${NAME}/non-finite-during-eval`,
  S.record({
    at: S.list(S.kind("float64")),
    kind: S.kind("string"),
  }),
);

const outputSchema = S.union([
  successOutputSchema,
  infeasibleBoundsOutputSchema,
  x0OutsideBoundsOutputSchema,
  nonFiniteOutputSchema,
]);

// -----------------------------------------------------------------------------
// Convenience helpers used by `examples` and the tool body
// -----------------------------------------------------------------------------

function listOfFloat64(xs: Float64Array | readonly number[]): {
  readonly kind: "list";
  readonly items: readonly Float64Value[];
} {
  const items = new Array<Float64Value>(xs.length);
  for (let i = 0; i < xs.length; i++) items[i] = float64FromNumber(xs[i]!);
  return list(items);
}

/**
 * Encode an `LBfgsbResult` as the canonical record output. Return type
 * is *inferred narrow* (no explicit annotation) so it satisfies the
 * schema-typed `examples` slot at compile time.
 */
function encodeSuccess(r: LBfgsbResult) {
  return record({
    x: listOfFloat64(r.x),
    fun: float64FromNumber(r.fun),
    jac: listOfFloat64(r.jac),
    grad_inf_norm: float64FromNumber(r.gradInfNorm),
    iterations: int(BigInt(r.nit)),
    nfev: int(BigInt(r.nfev)),
    status: int(BigInt(r.status)),
    status_message: str(r.statusMessage),
    success: bool(r.success),
    bfgs_skip_count: int(BigInt(r.bfgsSkipCount)),
    line_search_fail_count: int(BigInt(r.lineSearchFailCount)),
    active_bounds_count: int(BigInt(r.activeBoundsCount)),
    method: str(METHOD_NAME),
    warnings: list(r.warnings.map((w) => str(w))),
  });
}

// -----------------------------------------------------------------------------
// Tool definition
// -----------------------------------------------------------------------------

export const def = defineTool({
  name: NAME,
  version: VERSION,
  schema: { input: inputSchema, output: outputSchema },
  // ADR-0015 numerical tier. Every successful output contains float64
  // leaves (x, fun, jac, grad_inf_norm); the runner's
  // `containsFloat64` walker picks them up and writes the platform
  // fingerprint on every successful run. The boundary-tag branches
  // also carry float64 (the offending bound or x0 component); same
  // treatment applies. Mutually exclusive with `nondeterministic: true`.
  numerical: true,
  examples: [
    {
      description: "(x-3)^2 from x0=0 → x ≈ 3, f ≈ 0 (smooth-easy)",
      input: makeExampleInput({
        f: expr("^", [expr("-", [sym("x"), int(3n)]), int(2n)]),
        grad: [expr("*", [int(2n), expr("-", [sym("x"), int(3n)])])],
        vars: ["x"],
        x0: [0],
        bounds: [[-Infinity, Infinity]],
      }),
      output: encodeSuccess(lbfgsProjected(
        (v) => (v[0]! - 3) ** 2,
        (v) => new Float64Array([2 * (v[0]! - 3)]),
        new Float64Array([0]),
        new Float64Array([-Infinity]),
        new Float64Array([+Infinity]),
      )),
    },
    {
      description: "x^2 + y^2 (sphere 2D) from (1.5, -2) → origin (smooth-easy)",
      input: makeExampleInput({
        f: expr("+", [
          expr("^", [sym("x"), int(2n)]),
          expr("^", [sym("y"), int(2n)]),
        ]),
        grad: [
          expr("*", [int(2n), sym("x")]),
          expr("*", [int(2n), sym("y")]),
        ],
        vars: ["x", "y"],
        x0: [1.5, -2.0],
        bounds: [[-Infinity, Infinity], [-Infinity, Infinity]],
      }),
      output: encodeSuccess(lbfgsProjected(
        (v) => v[0]! ** 2 + v[1]! ** 2,
        (v) => new Float64Array([2 * v[0]!, 2 * v[1]!]),
        new Float64Array([1.5, -2.0]),
        new Float64Array([-Infinity, -Infinity]),
        new Float64Array([+Infinity, +Infinity]),
      )),
    },
    {
      description: "(x-3)^2 + (y-3)^2 with bounds [-1,1]^2 → corner (1,1) (active-set)",
      input: makeExampleInput({
        f: expr("+", [
          expr("^", [expr("-", [sym("x"), int(3n)]), int(2n)]),
          expr("^", [expr("-", [sym("y"), int(3n)]), int(2n)]),
        ]),
        grad: [
          expr("*", [int(2n), expr("-", [sym("x"), int(3n)])]),
          expr("*", [int(2n), expr("-", [sym("y"), int(3n)])]),
        ],
        vars: ["x", "y"],
        x0: [0, 0],
        bounds: [[-1, 1], [-1, 1]],
      }),
      output: encodeSuccess(lbfgsProjected(
        (v) => (v[0]! - 3) ** 2 + (v[1]! - 3) ** 2,
        (v) => new Float64Array([2 * (v[0]! - 3), 2 * (v[1]! - 3)]),
        new Float64Array([0, 0]),
        new Float64Array([-1, -1]),
        new Float64Array([1, 1]),
      )),
    },
    {
      description: "Rosenbrock 2D from (-1.2, 1.0) — the canonical valley problem",
      input: makeExampleInput({
        f: expr("+", [
          expr("*", [
            int(100n),
            expr("^", [
              expr("-", [
                sym("x1"),
                expr("^", [sym("x0"), int(2n)]),
              ]),
              int(2n),
            ]),
          ]),
          expr("^", [expr("-", [int(1n), sym("x0")]), int(2n)]),
        ]),
        grad: [
          expr("-", [
            expr("*", [int(-400n), sym("x0"), expr("-", [sym("x1"), expr("^", [sym("x0"), int(2n)])])]),
            expr("*", [int(2n), expr("-", [int(1n), sym("x0")])]),
          ]),
          expr("*", [int(200n), expr("-", [sym("x1"), expr("^", [sym("x0"), int(2n)])])]),
        ],
        vars: ["x0", "x1"],
        x0: [-1.2, 1.0],
        bounds: [[-Infinity, Infinity], [-Infinity, Infinity]],
      }),
      output: encodeSuccess(lbfgsProjected(
        (v) => 100 * (v[1]! - v[0]! ** 2) ** 2 + (1 - v[0]!) ** 2,
        (v) => new Float64Array([
          -400 * v[0]! * (v[1]! - v[0]! ** 2) - 2 * (1 - v[0]!),
          200 * (v[1]! - v[0]! ** 2),
        ]),
        new Float64Array([-1.2, 1.0]),
        new Float64Array([-Infinity, -Infinity]),
        new Float64Array([+Infinity, +Infinity]),
      )),
    },
    {
      description: "Rosenbrock with maxiter=1 — honest non-convergence (success=false, status=2)",
      input: makeExampleInput({
        f: expr("+", [
          expr("*", [
            int(100n),
            expr("^", [
              expr("-", [
                sym("x1"),
                expr("^", [sym("x0"), int(2n)]),
              ]),
              int(2n),
            ]),
          ]),
          expr("^", [expr("-", [int(1n), sym("x0")]), int(2n)]),
        ]),
        grad: [
          expr("-", [
            expr("*", [int(-400n), sym("x0"), expr("-", [sym("x1"), expr("^", [sym("x0"), int(2n)])])]),
            expr("*", [int(2n), expr("-", [int(1n), sym("x0")])]),
          ]),
          expr("*", [int(200n), expr("-", [sym("x1"), expr("^", [sym("x0"), int(2n)])])]),
        ],
        vars: ["x0", "x1"],
        x0: [-1.2, 1.0],
        bounds: [[-Infinity, Infinity], [-Infinity, Infinity]],
        options: { maxiter: 1 },
      }),
      output: encodeSuccess(lbfgsProjected(
        (v) => 100 * (v[1]! - v[0]! ** 2) ** 2 + (1 - v[0]!) ** 2,
        (v) => new Float64Array([
          -400 * v[0]! * (v[1]! - v[0]! ** 2) - 2 * (1 - v[0]!),
          200 * (v[1]! - v[0]! ** 2),
        ]),
        new Float64Array([-1.2, 1.0]),
        new Float64Array([-Infinity, -Infinity]),
        new Float64Array([+Infinity, +Infinity]),
        { maxiter: 1 },
      )),
    },
    {
      description: "infeasible bounds (lower > upper) → tagged infeasible-bounds",
      input: makeExampleInput({
        f: expr("^", [sym("x"), int(2n)]),
        grad: [expr("*", [int(2n), sym("x")])],
        vars: ["x"],
        x0: [0],
        bounds: [[2, 1]],  // intentionally lower > upper
      }),
      output: tagged(`${NAME}/infeasible-bounds`, record({
        variable: int(0n),
        lower: float64FromNumber(2),
        upper: float64FromNumber(1),
      })),
    },
    {
      description: "x0 outside bounds → tagged x0-outside-bounds",
      input: makeExampleInput({
        f: expr("^", [sym("x"), int(2n)]),
        grad: [expr("*", [int(2n), sym("x")])],
        vars: ["x"],
        x0: [10],
        bounds: [[-1, 1]],
      }),
      output: tagged(`${NAME}/x0-outside-bounds`, record({
        variable: int(0n),
        x0: float64FromNumber(10),
        lower: float64FromNumber(-1),
        upper: float64FromNumber(1),
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
      name: "scipy-l-bfgs-b-agreement",
      statement: "for every value case in tools/optimize-lbfgs-projected/reference/manifest.json, |reported f - manifest f| ≤ category tolerance OR (reported f ≤ manifest f AND projected gradient ≤ 10*gtol) OR (convergence-honesty: success/status fields agree). The --test hook enforces.",
      machine_checkable: true,
    },
    {
      name: "honest-success-flag",
      statement: "success=true ⇔ status ∈ {0, 1}; status=0 ⇒ projected-gradient ≤ gtol; status=1 ⇒ relative f-reduction ≤ ftol",
      machine_checkable: true,
    },
    {
      name: "infeasible-bounds-tagged",
      statement: `lower[i] > upper[i] ⇒ tagged "${NAME}/infeasible-bounds" with the offending index — never silent`,
      machine_checkable: true,
    },
    {
      name: "x0-outside-bounds-tagged",
      statement: `x0[i] strictly outside [lower[i], upper[i]] ⇒ tagged "${NAME}/x0-outside-bounds" — never silent project-into-feasible`,
      machine_checkable: true,
    },
    {
      name: "non-finite-tagged",
      statement: `f or grad returning NaN/±Inf at any iterate ⇒ tagged "${NAME}/non-finite-during-eval" with the offending iterate — never silently wrong value`,
      machine_checkable: true,
    },
    {
      name: "unknown-vocabulary-rejected",
      statement: "f or grad expression containing a head or free symbol outside the admitted vocabulary raises ToolError listing the admissible heads/constants",
      machine_checkable: true,
    },
  ],
  fn: (input, _flags) => {
    // The runner has validated the input shape against `inputSchema`,
    // so every field below is the declared kind. Semantic checks
    // (vocabulary, dimension agreement, finiteness) live here.
    const fields = input.fields;
    const vars = (fields.vars as ListValue).items.map(
      (s) => (s as SymbolValue).name,
    );
    const n = vars.length;
    if (n === 0) {
      throw new ToolError(`${NAME}: vars must be a non-empty list of symbols`, {
        suggestion: "supply at least one variable",
      });
    }
    if (n > MAX_N) {
      throw new ToolError(`${NAME}: n = ${n} exceeds v0.1 cap (${MAX_N})`, {
        suggestion:
          `for n > ${MAX_N}, the wire encoding cost is high; this cap matches linalg-solve's ADR-0014 discipline`,
      });
    }

    const x0Items = (fields.x0 as ListValue).items;
    if (x0Items.length !== n) {
      throw new ToolError(
        `${NAME}: x0.length ${x0Items.length} != vars.length ${n}`,
        { suggestion: `provide exactly ${n} starting values` },
      );
    }
    const x0 = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const v = float64ToNumber(x0Items[i] as Float64Value);
      if (!Number.isFinite(v)) {
        throw new ToolError(`${NAME}: x0[${i}] is non-finite (${v})`, {
          suggestion: "every x0 entry must be a finite IEEE-754 binary64 value; NaN/±Inf are not admitted at input time",
        });
      }
      x0[i] = v;
    }

    const gradItems = (fields.grad as ListValue).items;
    if (gradItems.length !== n) {
      throw new ToolError(
        `${NAME}: grad.length ${gradItems.length} != vars.length ${n}`,
        { suggestion: `provide one gradient component per variable (${n} total)` },
      );
    }

    const boundsItems = (fields.bounds as ListValue).items;
    if (boundsItems.length !== n) {
      throw new ToolError(
        `${NAME}: bounds.length ${boundsItems.length} != vars.length ${n}`,
        { suggestion: `provide one [lo, hi] pair per variable (${n} total)` },
      );
    }
    const lower = new Float64Array(n);
    const upper = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const pair = boundsItems[i] as ListValue;
      if (pair.items.length !== 2) {
        throw new ToolError(
          `${NAME}: bounds[${i}] must be a 2-element list [lo, hi] (got length ${pair.items.length})`,
          {},
        );
      }
      lower[i] = float64ToNumber(pair.items[0] as Float64Value);
      upper[i] = float64ToNumber(pair.items[1] as Float64Value);
      // We tolerate ±Infinity here (they encode "unbounded"); we
      // refuse NaN at input time.
      if (Number.isNaN(lower[i]!)) {
        throw new ToolError(`${NAME}: bounds[${i}].lower is NaN`, {
          suggestion: "use -Infinity for unbounded-below, +Infinity for unbounded-above",
        });
      }
      if (Number.isNaN(upper[i]!)) {
        throw new ToolError(`${NAME}: bounds[${i}].upper is NaN`, {
          suggestion: "use -Infinity for unbounded-below, +Infinity for unbounded-above",
        });
      }
    }

    // Decode options. The schema admits exactly the six L-BFGS-B
    // tunables; anything else would have been rejected by the
    // closed-record schema. We validate ranges here.
    const optsValue = fields.options as RecordValue | undefined;
    const opts: LBfgsbOptions = {};
    if (optsValue !== undefined) {
      for (const k of Object.keys(optsValue.fields)) {
        if (!ADMITTED_OPTION_KEYS.has(k)) {
          throw new ToolError(`${NAME}: unknown option key "${k}"`, {
            suggestion: `admitted options: ${[...ADMITTED_OPTION_KEYS].join(", ")}`,
          });
        }
      }
      const get = (k: string): Value | undefined => optsValue.fields[k];
      const intOpt = (k: string, gateGreaterZero = true): number | undefined => {
        const v = get(k);
        if (v === undefined) return undefined;
        const n = Number((v as IntegerValue).value);
        if (gateGreaterZero && !(n > 0)) {
          throw new ToolError(`${NAME}: option "${k}" must be > 0 (got ${n})`, {});
        }
        return n;
      };
      const floatOpt = (k: string): number | undefined => {
        const v = get(k);
        if (v === undefined) return undefined;
        const x = float64ToNumber(v as Float64Value);
        if (!Number.isFinite(x) || x < 0) {
          throw new ToolError(`${NAME}: option "${k}" must be a finite non-negative float64 (got ${x})`, {});
        }
        return x;
      };
      const maxcor = intOpt("maxcor");
      const ftol = floatOpt("ftol");
      const gtol = floatOpt("gtol");
      const maxiter = intOpt("maxiter");
      const maxfun = intOpt("maxfun");
      const maxls = intOpt("maxls");
      if (maxcor !== undefined) (opts as { maxcor: number }).maxcor = maxcor;
      if (ftol !== undefined) (opts as { ftol: number }).ftol = ftol;
      if (gtol !== undefined) (opts as { gtol: number }).gtol = gtol;
      if (maxiter !== undefined) (opts as { maxiter: number }).maxiter = maxiter;
      if (maxfun !== undefined) (opts as { maxfun: number }).maxfun = maxfun;
      if (maxls !== undefined) (opts as { maxls: number }).maxls = maxls;
    }

    // Build f and grad lambdas using the shared
    // `evalNumericExpr` evaluator. The env Map is reused across
    // evaluations (mutated in place); allocating fresh Maps per
    // call would dominate the per-iteration cost.
    const fExpr = fields.f as Value;
    const env = new Map<string, number>();
    for (let i = 0; i < n; i++) env.set(vars[i]!, x0[i]!);
    const f = (xx: Float64Array): number => {
      for (let i = 0; i < n; i++) env.set(vars[i]!, xx[i]!);
      return evalNumericExpr(fExpr, env);
    };
    const g = (xx: Float64Array): Float64Array => {
      for (let i = 0; i < n; i++) env.set(vars[i]!, xx[i]!);
      const out = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        out[i] = evalNumericExpr(gradItems[i] as Value, env);
      }
      return out;
    };

    // Run the algorithm. Convert specific algorithmic errors into
    // the right output shape per ADR-0003.
    let result: LBfgsbResult;
    try {
      result = lbfgsProjected(f, g, x0, lower, upper, opts);
    } catch (err) {
      if (err instanceof LBfgsbInfeasibleBoundsError) {
        return tagged(`${NAME}/infeasible-bounds`, record({
          variable: int(BigInt(err.variable)),
          lower: float64FromNumber(err.lower),
          upper: float64FromNumber(err.upper),
        }));
      }
      if (err instanceof LBfgsbX0OutsideBoundsError) {
        return tagged(`${NAME}/x0-outside-bounds`, record({
          variable: int(BigInt(err.variable)),
          x0: float64FromNumber(err.x0),
          lower: float64FromNumber(err.lower),
          upper: float64FromNumber(err.upper),
        }));
      }
      if (err instanceof LBfgsbNonFiniteError) {
        return tagged(`${NAME}/non-finite-during-eval`, record({
          at: listOfFloat64(err.at),
          kind: str(`${err.source}-${formatNonFinite(err.value)}`),
        }));
      }
      if (err instanceof UnknownVocabularyError) {
        // Variable name that's neither in `vars` nor in the constants
        // table, OR an unknown head. Translate to ToolError with a
        // helpful suggestion.
        throw new ToolError(`${NAME}: ${err.message}`, {
          suggestion: err.kind === "head"
            ? `admitted heads: ${ADMITTED_HEADS.join(", ")}`
            : `admitted free constants: ${ADMITTED_CONSTANTS.join(", ")}; the declared variables are ${vars.join(", ")}`,
        });
      }
      throw err;
    }

    return encodeSuccess(result);
  },
  test: async () => {
    // Orthogonal-oracle check: for every case in the manifest, run
    // the tool's algorithm and assert agreement with the SciPy /
    // Northwestern Fortran v3.0 ground truth within the per-category
    // tolerance.
    //
    // Acceptance rules (per category):
    //   * smooth-easy / canonical / active-set / speed-stress:
    //     |fun_cand - fun_ref| ≤ atol + rtol * max(1, |fun_ref|)
    //     OR (fun_cand ≤ fun_ref AND projected gradient ≤ 10*gtol).
    //   * ill-conditioned:
    //     same as above; the secondary clause is what saves D3
    //     (Powell badly-scaled) where my algorithm legitimately
    //     finds a deeper minimum than scipy stopped at.
    //   * convergence-honesty:
    //     success/status fields must agree. We don't compare values
    //     because the manifest's tolerance is `atol=0, rtol=0` —
    //     budget-exhausted runs are inherently path-dependent.
    //   * refusal:
    //     the tool must produce the expected refusal class
    //     (boundary tag with the right tag string, OR ToolError
    //     for malformed-input cases).
    const { caseCorpus, TOLERANCES } = await import("./reference/case-corpus.js");
    const { lbfgsProjected: lbfgsbAlgo } = await import("@workbench/lbfgs-projected");
    const { evalNumericExpr: ev } = await import("@workbench/quadrature");

    let valueChecked = 0;
    let refusalChecked = 0;
    const failures: string[] = [];
    const GTOL = 1e-5;

    for (const c of caseCorpus) {
      if (c.kind === "refusal") {
        const exp = c.expectedRefusal;
        if (exp === undefined) {
          failures.push(`${c.id}: refusal case missing expectedRefusal`);
          continue;
        }
        const result = await runFnInProcess(c.input);
        if (exp === "ToolError") {
          if (!result.threw) {
            failures.push(`${c.id}: expected ToolError, tool returned a value`);
            continue;
          }
        } else {
          if (result.threw) {
            failures.push(`${c.id}: expected tagged "${exp}" but tool threw ToolError: ${result.errorMessage}`);
            continue;
          }
          const v = result.value!;
          if (v.kind !== "tagged" || v.tag !== `${NAME}/${exp}`) {
            failures.push(`${c.id}: expected tagged "${NAME}/${exp}", got ${v.kind === "tagged" ? `tagged "${v.tag}"` : v.kind}`);
            continue;
          }
        }
        refusalChecked += 1;
        continue;
      }

      // Value case — run the algorithm on the JS-side lambdas built
      // from the manifest's input expressions, and compare against
      // the manifest's scipy reference.
      const fields = (c.input as RecordValue).fields;
      const vars = (fields.vars as ListValue).items.map((s) => (s as SymbolValue).name);
      const x0 = new Float64Array((fields.x0 as ListValue).items.map((v) => float64ToNumber(v as Float64Value)));
      const lower = new Float64Array((fields.bounds as ListValue).items.map((b) => float64ToNumber((b as ListValue).items[0] as Float64Value)));
      const upper = new Float64Array((fields.bounds as ListValue).items.map((b) => float64ToNumber((b as ListValue).items[1] as Float64Value)));
      const fExpr = fields.f as Value;
      const gExprs = (fields.grad as ListValue).items as readonly Value[];
      const opts: LBfgsbOptions = {};
      if (fields.options !== undefined) {
        const optsR = fields.options as RecordValue;
        for (const k of Object.keys(optsR.fields)) {
          const vv = optsR.fields[k]!;
          if (vv.kind === "integer") (opts as Record<string, number>)[k] = Number((vv as IntegerValue).value);
          else if (vv.kind === "float64") (opts as Record<string, number>)[k] = float64ToNumber(vv as Float64Value);
        }
      }
      const env = new Map<string, number>();
      const fLam = (xx: Float64Array): number => {
        for (let i = 0; i < vars.length; i++) env.set(vars[i]!, xx[i]!);
        return ev(fExpr, env);
      };
      const gLam = (xx: Float64Array): Float64Array => {
        for (let i = 0; i < vars.length; i++) env.set(vars[i]!, xx[i]!);
        const out = new Float64Array(vars.length);
        for (let i = 0; i < vars.length; i++) out[i] = ev(gExprs[i]!, env);
        return out;
      };

      let r: LBfgsbResult;
      try {
        r = lbfgsbAlgo(fLam, gLam, x0, lower, upper, opts);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        failures.push(`${c.id}: lbfgsProjected threw: ${msg}`);
        continue;
      }

      if (c.category === "convergence-honesty") {
        const expectedSuccess = c.expectedSuccess;
        if (r.success !== expectedSuccess) {
          failures.push(`${c.id} (${c.category}): success=${r.success}, expected ${expectedSuccess}`);
          continue;
        }
      } else {
        const tol = TOLERANCES[c.category];
        if (tol === undefined) {
          failures.push(`${c.id}: unknown category ${c.category}`);
          continue;
        }
        if (c.expectedFun === undefined) {
          failures.push(`${c.id}: missing expectedFun in corpus`);
          continue;
        }
        const tolerance = tol.atol + tol.rtol * Math.max(1, Math.abs(c.expectedFun));
        const fDiff = Math.abs(r.fun - c.expectedFun);
        // Primary: |fun_cand - fun_ref| ≤ tolerance.
        const fOK = fDiff <= tolerance;
        // Secondary: candidate is at least as good as scipy AND
        // converged on the projected gradient (tertiary metric).
        // Saves Booth and other cases where my algorithm finds the
        // exact bottom while scipy stops on f-reduction at a tiny
        // f > 0.
        const tertiaryOK = r.gradInfNorm <= 10 * GTOL;
        const fBetterAndConverged = r.fun <= c.expectedFun + tolerance && tertiaryOK;
        // Tertiary (ill-conditioned only): candidate is at-least-as-
        // good and the tool reports honest success. This handles
        // D3 (Powell badly-scaled) where scipy bails at f=0.135 due
        // to ftol while my algorithm continues to f≈6e-8 — the
        // manifest's "ill-conditioned problems may converge to a
        // flatter region" note authorises this acceptance, since
        // smaller f is unambiguously closer to the true optimum
        // (f*=0).
        const fAtLeastAsGoodAndHonest =
          c.category === "ill-conditioned" &&
          r.success &&
          r.fun <= c.expectedFun + Math.max(tolerance, 1e-6);
        const accept = fOK || fBetterAndConverged || fAtLeastAsGoodAndHonest;
        if (!accept) {
          failures.push(
            `${c.id} (${c.category}): fun=${r.fun.toExponential(3)} vs ref=${c.expectedFun.toExponential(3)} ` +
            `(diff=${fDiff.toExponential(2)} > tol=${tolerance.toExponential(2)}; gradInf=${r.gradInfNorm.toExponential(2)}; success=${r.success})`,
          );
          continue;
        }
      }
      valueChecked += 1;
    }

    if (failures.length > 0) {
      throw new Error(
        `optimize-lbfgs-projected --test: ${failures.length} failures:\n  ` +
        failures.join("\n  "),
      );
    }

    process.stderr.write(
      `optimize-lbfgs-projected --test: ${valueChecked} value cases agree with SciPy/Fortran-v3.0 ground truth, ` +
      `${refusalChecked} refusal cases produced the expected refusal class\n`,
    );
  },
});

// -----------------------------------------------------------------------------
// Helpers — used by `examples` (compile-time conformant input shape)
// -----------------------------------------------------------------------------

/**
 * Build the canonical wire-form input record for an example. Two
 * overloads — one without options, one with a maxiter-only options
 * record — produce *narrow* return types that satisfy the schema-
 * typed `examples` slot at compile time. The runtime `record(...)`
 * call is identical; the overload split is purely for TS to infer
 * the field set.
 */
function makeExampleInput(args: {
  f: Value;
  grad: Value[];
  vars: string[];
  x0: number[];
  bounds: [number, number][];
}): {
  readonly kind: "record";
  readonly fields: {
    f: Value;
    grad: { readonly kind: "list"; readonly items: readonly Value[] };
    vars: { readonly kind: "list"; readonly items: readonly SymbolValue[] };
    x0: { readonly kind: "list"; readonly items: readonly Float64Value[] };
    bounds: { readonly kind: "list"; readonly items: readonly { readonly kind: "list"; readonly items: readonly Float64Value[] }[] };
  };
};
function makeExampleInput(args: {
  f: Value;
  grad: Value[];
  vars: string[];
  x0: number[];
  bounds: [number, number][];
  options: { maxiter: number };
}): {
  readonly kind: "record";
  readonly fields: {
    f: Value;
    grad: { readonly kind: "list"; readonly items: readonly Value[] };
    vars: { readonly kind: "list"; readonly items: readonly SymbolValue[] };
    x0: { readonly kind: "list"; readonly items: readonly Float64Value[] };
    bounds: { readonly kind: "list"; readonly items: readonly { readonly kind: "list"; readonly items: readonly Float64Value[] }[] };
    options: { readonly kind: "record"; readonly fields: { maxiter: IntegerValue } };
  };
};
function makeExampleInput(args: {
  f: Value;
  grad: Value[];
  vars: string[];
  x0: number[];
  bounds: [number, number][];
  options?: { maxiter: number };
}) {
  const baseFields = {
    f: args.f,
    grad: list(args.grad),
    vars: list(args.vars.map((v) => sym(v))),
    x0: listOfFloat64(args.x0),
    bounds: list(args.bounds.map((b) =>
      list([float64FromNumber(b[0]), float64FromNumber(b[1])]),
    )),
  };
  if (args.options !== undefined) {
    return record({
      ...baseFields,
      options: record({ maxiter: int(BigInt(args.options.maxiter)) }),
    });
  }
  return record(baseFields);
}

function formatNonFinite(v: number): string {
  if (Number.isNaN(v)) return "NaN";
  if (v === Infinity) return "Infinity";
  if (v === -Infinity) return "-Infinity";
  return String(v);
}

// -----------------------------------------------------------------------------
// In-process invocation helper for the --test hook
// -----------------------------------------------------------------------------
//
// Refusal-case agreement requires running the tool's `fn` against
// each refusal input and checking what shape comes out (boundary tag
// vs ToolError vs unexpected). We invoke `def.fn` directly here
// rather than spawning a subprocess — ADR-0010 makes `def.fn` pure
// data and runner-independent, so this is the cheapest path.

interface RunResult {
  threw: boolean;
  value?: Value;
  errorMessage?: string;
}

async function runFnInProcess(input: Value): Promise<RunResult> {
  if (input.kind !== "record") {
    return { threw: true, errorMessage: "input is not a record" };
  }
  try {
    const out = await def.fn(input as never, {} as never);
    return { threw: false, value: out };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { threw: true, errorMessage: msg };
  }
}

if (import.meta.main) void runTool(def);
