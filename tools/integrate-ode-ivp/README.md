# integrate-ode-ivp

Adaptive non-stiff initial-value-problem solver for
`dy/dt = f(t, y), y(t0) = y0` over `t ∈ [t0, tf]` via Dormand-Prince
5(4) (DOPRI5) — the canonical embedded explicit Runge-Kutta pair
behind SciPy's `solve_ivp(method='RK45')` and MATLAB's `ode45`.
First slice of the ODE epic (parent: bead `scientist-workbench-32z`).

Library surface (TS-side, no JSON):

```ts
import { integrate, buildRhs } from "@workbench/ode-core";

// f(t, y) = -y;  y(0) = 1;  evaluate at t = 0, 1, 2, ..., 5
const f = (t: number, y: Float64Array, out: Float64Array) => {
  out[0] = -y[0]!;
};
const r = integrate(f, 0, 5, new Float64Array([1.0]), {
  rtol: 1e-6, atol: 1e-9, tEval: [0, 1, 2, 3, 4, 5],
});
// r.trajectory[5][0] ≈ exp(-5)
// r.status === "success"
```

## Input

```jsonc
{
  "kind": "record",
  "fields": {
    "f":     {"kind": "list", "items": [<expression>, ...]},   // n RHS expressions
    "vars":  {"kind": "list", "items": [<symbol>, ...]},        // n state-var names
    "t_var": {"kind": "symbol", "name": "t"},                  // independent var
    "y0":    {"kind": "list", "items": [<float64>, ...]},       // n initial values
    "t_span": {
      "kind": "record",
      "fields": {
        "t0": {"kind": "float64", "bits": "..."},
        "tf": {"kind": "float64", "bits": "..."}
      }
    },
    "options": {                                                // optional
      "kind": "record",
      "fields": {
        "rtol":     {"kind": "float64", ...},     // default 1e-3
        "atol":     {"kind": "float64", ...},     // default 1e-6
        "max_step": {"kind": "float64", ...},     // optional
        "t_eval":   {"kind": "list",   "items": [<float64>, ...]}  // default [t0, tf]
      }
    }
  }
}
```

`f` is required to use the **closed expression vocabulary** shared
across `cas-diff`, `integrate-1d`, and `optimize-lbfgs-projected`:

```
+, -, *, /, ^, neg,
exp, sin, cos, tan, log, sqrt, abs,
asin, acos, atan, sinh, cosh, tanh, asinh, acosh, atanh, log2, log10
```

Constants: `pi`, `e`. Numeric leaves: `integer`, `rational`, `float64`.
Reverse integration: `tf < t0` integrates backward. Per ADR-0016
there is **no hard `n_components` cap** — large inputs run with
scale-advisory warnings appended to the output's `warnings` field;
only a true allocation OOM raises a `ToolError`.

## Output

Three shapes (ADR-0003 categories):

**Happy path — record:**

```jsonc
{
  "kind": "record",
  "fields": {
    "trajectory":       {"kind": "list", "items": [...]},  // (n_eval × n_components)
    "t_values":         {"kind": "list", "items": [...]},  // (n_eval,) the time grid
    "error_estimate":   {"kind": "float64", ...},   // 1-normalised local error of last accepted step
    "n_evals":          {"kind": "integer", ...},
    "n_steps_accepted": {"kind": "integer", ...},
    "n_steps_rejected": {"kind": "integer", ...},
    "converged":        {"kind": "boolean", "value": true},   // ⇔ status === "success"
    "status":           {"kind": "string", "value": "success"},
    "method":           {"kind": "string", "value": "dormand-prince-45"},
    "warnings":         {"kind": "list", "items": [<strings>]}
  }
}
```

`trajectory[i]` is the state vector at `t_values[i]`. When
`options.t_eval` is supplied, `t_values` equals it element-wise; else
`t_values = [t0, tf]`.

`converged` is a *field*, not a separate boundary category — same
shape pattern as `linalg-solve`'s `condition_estimate` and
`integrate-1d`'s `converged`. A planner reads `converged === false`
and decides whether to retry with tighter tolerances, accept the
partial result, or warn the user.

`error_estimate` is the **1-normalised** norm of the last accepted
step's local error: `||err / (atol + rtol·max(|y|, |y_new|))||_RMS`,
where `< 1` is the controller's accept threshold. The bench's
verifier checks structural finiteness and the bound `≤ atol·1e6`
on success — agent-honest discipline (the controller accepted, so
its self-report must be ≤ 1 in the controller's units).

`status ∈ {"success", "max_step_exceeded", "tspan_exhausted"}`.
`"tspan_exhausted"` fires when the integrator stalls at a
vanishingly small step (< 10·EPS·|t|); the trajectory beyond the
stall point is left at the most-recently-accepted state.

`warnings` are populated when:
- `n_components > 100` — wire-encoding cost noticeable on phone
  deployments;
- `n_components > 1000` — pure-TS vector evaluation becomes a
  bottleneck; FFI bridge recommended (bead `e7y`);
- estimated step count > 100 000 — long-integration regime;
- estimated step count > 1 000 000 — likely stiff; consider
  `integrate-ode-stiff` (bead `09g`);
- estimated peak memory > 100 MB — large fraction of typical
  mobile-browser tab budget.

These are *fields*, not hard refusals — DOPRI5's PI controller is
backward-stable, and the bench's tolerance has 100× safety on top
of HNW Vol I §II.10.

**Boundary failures — tagged:**

```jsonc
{
  "kind": "tagged",
  "tag": "integrate-ode-ivp/degenerate-tspan",
  "payload": {"kind": "record", "fields": {
    "t0": {"kind": "float64", ...},
    "tf": {"kind": "float64", ...}
  }}
}
```

Returned when `t0 == tf`. The integration has no work to do; tagging
rather than returning `(y0)` lets a planner introspect the input
without a spurious "success" record.

```jsonc
{
  "kind": "tagged",
  "tag": "integrate-ode-ivp/non-finite-during-eval",
  "payload": {"kind": "record", "fields": {
    "at_t":  {"kind": "float64", ...},                      // t at which f went non-finite
    "at_y":  {"kind": "list",    "items": [<float64>, ...]},  // y at that point
    "kind":  {"kind": "string",  "value": "NaN" | "Infinity" | "-Infinity"}
  }}
}
```

Returned when `f` produces NaN or ±Inf at any `(t, y)` during
integration (typically a pole or a movable singularity). The agent's
planner can match on the tag, read the offending point, and decide
whether to subdivide the interval, switch to a complex-domain method,
or refuse.

**Malformed input — `ToolError` (exit 1):**

- `vars` empty.
- `len(f) ≠ len(vars)` or `len(y0) ≠ len(vars)`.
- any `y0[i]` non-finite at input time (NaN, ±Inf).
- non-finite `t0` or `tf`.
- unknown expression head or free symbol (suggestion lists admitted
  vocabulary).
- malformed options (e.g. `rtol ≤ 0`, `max_step ≤ 0`, unknown option
  key).
- True allocation OOM (caught and re-thrown).

## How

**Dormand-Prince 5(4)** (Dormand & Prince 1980; HNW Vol I §II.5):
seven stages with FSAL ("First Same As Last"). Per-step cost
amortises to six new `f` evaluations on accepted steps.

**PI controller** (Gustafsson 1991; HNW Vol I §IV.2):
`h_{n+1} = h_n · 0.9 · err_n^(-0.7/p) · err_{n-1}^(0.4/p)` for
order `p = 5`. Falls back to I-only on the first step and on
rejected steps. Multiplicative factor clamped to `[0.2, 10]`.

**Initial step** via the HNW Vol I §II.4 starting-step heuristic
(also reproduced in SciPy `_ivp/common.py::select_initial_step`):
two `f`-evaluations to estimate the leading derivative norm.

**Dense output** for sub-step `t_eval` points via the 4th-order
Hermite continuous extension (HNW Vol I §II.6; Dormand-Prince 1980
§6). The interpolant uses six of the step's seven k-vectors;
polynomial coefficients verbatim from SciPy
`scipy/integrate/_ivp/rk.py::RK45.P`. Linear interpolation between
endpoints would produce ~10⁴× more error and is wrong for any RK
method with a documented dense extension.

**Reverse integration** (`tf < t0`): step size carries the sign;
the controller and dense extension are direction-agnostic.

The substrate (`packages/ode-core/`) carries the literate
algorithmic prose; this file is only the wire-encoding wrapper.

References:
- Hairer, Nørsett, Wanner. *Solving Ordinary Differential Equations
  I — Nonstiff Problems*, 2nd ed. Springer 1993. §II.5 (DOPRI5),
  §II.6 (dense output), §IV.2 (PI control).
- Dormand, Prince. *A family of embedded Runge-Kutta formulae*. J.
  Comput. Appl. Math. 6:19-26, 1980.
- Gustafsson. *Control theoretic techniques for stepsize selection
  in explicit Runge-Kutta methods*. ACM TOMS 17:533-554, 1991.

## Out of scope (v0.1, deferred)

- **Stiff problems** — `integrate-ode-stiff` (bead `09g`) ships
  Radau-IIA / BDF.
- **Symplectic integration** — `integrate-ode-symplectic` (bead
  `4gr`) ships velocity-Verlet / 4th-order symplectic for
  Hamiltonian systems where energy preservation matters.
- **Event detection** (root-finding on the trajectory). Deferred
  to v0.2.
- Vocabulary beyond `cas-diff` / `integrate-1d`'s closed list.
- FFI bridge to a compiled DOPRI5 — bead `e7y`.

## Invariants

- **deterministic-per-platform**: same input bytes → same output
  bytes on a single platform; `numerical: true` (ADR-0015) records
  the platform fingerprint in provenance.
- **fsal-eval-floor**: `n_evals ≥ 6 · n_steps_accepted` — DOPRI5 has
  7 stages with FSAL, so the asymptotic floor is 6 new `f`
  evaluations per accepted step.
- **monotone-t-values**: `t_values` ascending iff `t0 ≤ tf`,
  descending iff `t0 > tf`; equals `options.t_eval` element-wise
  when supplied.
- **trajectory-shape**: `trajectory` is `(n_eval × n_components)`;
  when `t_eval` omitted, `n_eval = 2` (endpoints only).
- **converged-iff-success**: `converged === (status === "success")`
  is enforced on every code path.
- **trajectory-accuracy-vs-reference**: for analytic-oracle inputs,
  `|trajectory − reference|_∞ ≤ 100·rtol·|reference|_∞` over the
  horizon (HNW Vol I §II.10 with 100× safety factor).
- **non-finite-tagged**: `f` returning NaN/±Inf at any `(t, y)` ⇒
  `tagged "integrate-ode-ivp/non-finite-during-eval"` — never
  NaN-poisoned trajectory.
- **degenerate-tspan-tagged**: `t0 == tf` ⇒ `tagged
  "integrate-ode-ivp/degenerate-tspan"` — never a silently empty /
  silently `y0` success record.
- **unknown-vocabulary-rejected**: `f` containing a head or free
  symbol outside the closed vocabulary raises `ToolError` with
  a suggestion listing admitted heads / constants.
- **dim-mismatch-rejected**: `len(f) ≠ len(vars)` or `len(y0) ≠
  len(vars)` ⇒ `ToolError` with the offending lengths.
- **scale-warnings-emitted**: for `n_components > 100` or
  `n_steps_estimate > 100 000`, the `warnings` field carries
  human-readable scale advisories per ADR-0016. Algorithm still
  runs.

## Run

```sh
echo '{"kind":"record","fields":{"f":...,"vars":...,"t_var":...,"y0":...,"t_span":...}}' \
  | bun tools/integrate-ode-ivp/tool.ts
```

## Validation

The bench corpus lives in the sibling repo:
`../scientist-workbench-corpus/benchmarks/integrate-ode-ivp/`
(ADR-0028, bead `scientist-workbench-g6dn`).  To run the full battery:

```sh
bash scripts/bench-grade.sh integrate-ode-ivp
```

29-case golden battery, 7 invariant checks per case (~179 assertions):

1. `shape` — all required fields present, correct types, trajectory m×n.
2. `finite_entries` — no NaN/Inf in trajectory or error_estimate.
3. `monotone_t_values` — ascending/descending per integration direction; matches t_eval element-wise.
4. `status_consistency` — converged iff status==="success"; counters sane.
5. `trajectory_accuracy` — sup-norm error vs DOP853 oracle ≤ 100·rtol·|oracle|·horizon_factor.
6. `self_reported_error_estimate` — error_estimate ≥ 0; ≤ max(1, atol·1e6) on success.
7. `conservation` — conserved-quantity drift ≤ 100·rtol·|tf-t0| where applicable.

**Oracle:** SciPy `solve_ivp(method='DOP853', rtol=1e-13, atol=1e-15)` at
extended precision — orthogonal implementation, same DOPRI5 family,
different floating-point arithmetic order. Comparison threshold `100 ×
rtol × |oracle|`.

**Mutation-proven** per CLAUDE.md Rule 6.

## Standard flags

`--schema --examples --invariants --version --help --provenance-of <hash> --test --platform-fingerprint`
