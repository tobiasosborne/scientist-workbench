# integrate-ode-stiff

Adaptive **stiff** initial value problem solver

```
dy/dt = f(t, y),   y(t0) = y0,   t ∈ [t0, tf]
```

via **Radau-IIA(5)** — 3-stage 5th-order implicit Runge-Kutta with
collocation at the Radau-IIA quadrature points
`c = ((4 − √6)/10, (4 + √6)/10, 1)`. A-stable, L-stable, stiffly
accurate. The `scipy.integrate.solve_ivp(method='Radau')` algorithm.
Sister tool to `integrate-ode-ivp` (path-finder; non-stiff DOPRI5+PI)
and `integrate-ode-symplectic` (separable-Hamiltonian Verlet/Yoshida).

The discriminator vs `integrate-ode-ivp`: explicit RK methods on a
stiff system either take exponentially many tiny steps (Robertson over
`t = [0, 1e10]` would need `~10²⁰` DOPRI5 steps to remain stable) or
blow up. Radau-IIA's L-stability damps the fast modes regardless of
step size; on Robertson at `rtol = 1e-6`, the substrate completes in
`~150` accepted steps with bounded error throughout.

Library surface (TS-side, no JSON):

```ts
import {
  integrateStiff,
  type IntegrateStiffResult,
} from "@workbench/ode-core";

// Hand-coded RHS for the 2D linear stiff system y0' = -1000 y0, y1' = -y1.
const f = (_t: number, y: Float64Array, out: Float64Array): void => {
  out[0] = -1000 * y[0]!;
  out[1] = -y[1]!;
};
const r: IntegrateStiffResult = integrateStiff(
  f, 0, 1, new Float64Array([1, 1]),
  { rtol: 1e-6, atol: 1e-9, tEval: [0, 0.5, 1] },
);
// r.trajectory[2]  ≈ [exp(-1000) ≈ 0, exp(-1) ≈ 0.3679]
// r.nJacobianEvals > 0  (the implicit method touched J)
```

The tool wrapper auto-derives the symbolic Jacobian via in-process
`cas-diff`, falls back to centred finite-differences if any cell is
out-of-vocabulary, and accepts an optional user-supplied
`options.jacobian` shortcut for hand-tuned cases.

## Input

```jsonc
{
  "kind": "record",
  "fields": {
    "f":      {"kind": "list", "items": [<expression>, ...]},  // n RHS expressions
    "vars":   {"kind": "list", "items": [<symbol>, ...]},       // n state-variable symbols
    "t_var":  {"kind": "symbol", "name": "t"},                  // independent variable
    "y0":     {"kind": "list", "items": [<float64>, ...]},      // n initial values
    "t_span": {
      "kind": "record",
      "fields": {
        "t0": {"kind": "float64", ...},
        "tf": {"kind": "float64", ...}
      }
    },
    "options": {                                                 // optional
      "kind": "record",
      "fields": {
        "rtol":     {"kind": "float64", ...},                    // default 1e-3
        "atol":     {"kind": "float64", ...},                    // default 1e-6
        "max_step": {"kind": "float64", ...},                    // optional cap
        "t_eval":   {"kind": "list", "items": [<float64>, ...]}, // optional output grid
        "method":   {"kind": "string", "value": "radau" | "bdf"},// default "radau"
        "jacobian": {"kind": "list", "items": [                  // optional analytic J
          {"kind": "list", "items": [<expression>, ...]}, ...    // n × n
        ]}
      }
    }
  }
}
```

`f` is required to use the **closed expression vocabulary** shared
across `cas-diff` / `integrate-1d` / `integrate-ode-ivp`:

```
+, -, *, /, ^, neg,
exp, sin, cos, tan, log, sqrt, abs,
asin, acos, atan, sinh, cosh, tanh, asinh, acosh, atanh, log2, log10
```

Constants: `pi`, `e`. Numeric leaves: `integer`, `rational`, `float64`.

## Output

Five shapes (ADR-0003 categories):

**Happy path — record:**

```jsonc
{
  "kind": "record",
  "fields": {
    "trajectory":           {"kind": "list", "items": [...]},  // (n_eval × n_components)
    "t_values":             {"kind": "list", "items": [...]},  // (n_eval,)
    "error_estimate":       {"kind": "float64", ...},   // last accepted local error norm
    "n_evals":              {"kind": "integer", ...},   // total f evaluations
    "n_steps_accepted":     {"kind": "integer", ...},
    "n_steps_rejected":     {"kind": "integer", ...},
    "n_jacobian_evals":     {"kind": "integer", ...},   // count of J(t, y) calls
    "n_lu_decompositions":  {"kind": "integer", ...},   // real + complex factorisations
    "converged":            {"kind": "boolean", ...},
    "status":               {"kind": "string",  ...},   // "success" | "max_step_exceeded" | "tspan_exhausted" | "newton-divergence"
    "method":               {"kind": "string",  "value": "radau-iia-5"},
    "warnings":             {"kind": "list", "items": [<strings>]}
  }
}
```

`n_jacobian_evals > 0` is the load-bearing diagnostic: a candidate that
secretly small-steps explicitly never touches `J`. The bench's
`stiffness_handled` check enforces it.

`n_lu_decompositions` counts the real + complex factor pair per refactor;
structurally `n_lu_decompositions ≥ 2 · n_jacobian_evals` on any
successful step. The Hairer-Wanner 1999 simplified-Newton scheme uses
the eigenvalues of the Butcher matrix `A` to split the (3n × 3n)
Newton system into one real `n × n` solve and one (2n × 2n) real solve
(the complex pair, embedded). 27× cheaper per Newton iteration than
inlining a (3n × 3n) factorisation.

**Boundary failures — tagged:**

```jsonc
{"kind": "tagged", "tag": "integrate-ode-stiff/degenerate-tspan",       "payload": {"t0", "tf"}}
{"kind": "tagged", "tag": "integrate-ode-stiff/non-finite-during-eval", "payload": {"at_t", "at_y", "kind"}}
{"kind": "tagged", "tag": "integrate-ode-stiff/jacobian-singular",      "payload": {"at_t", "at_y", "condition_number"}}
{"kind": "tagged", "tag": "integrate-ode-stiff/method-not-implemented", "payload": {"method"}}
```

`method-not-implemented` is the structural refusal for
`options.method == "bdf"`. The path-finder is single-method (Radau);
BDF, Rosenbrock, and other implicit methods are deferred to a future
slice. The tag carries the requested method name so a planner can route
the request elsewhere or ask the user.

`jacobian-singular` fires when LU factorisation of `(γ/h)I − J` hits
an exactly-singular system. Rare in practice; when it does happen the
payload's `condition_number` tells the planner whether to add `εI`
regularisation or refactor the model.

**Malformed input — `ToolError` (exit 1):**

- `vars` empty.
- `len(f) ≠ len(vars)` or `len(y0) ≠ len(vars)`.
- `options.jacobian` shape ≠ `n × n`.
- any `y0[i]` non-finite at input time.
- non-finite `t0` / `tf`.
- unknown expression head or free symbol in `f` or `options.jacobian`.
- malformed options (unknown key, `rtol ≤ 0`, `atol < 0`,
  `max_step ≤ 0`, unknown method-string).

## How

**Radau-IIA(5)** (Hairer-Wanner Vol II §IV.8). Per accepted step, three
stages `Z_1, Z_2, Z_3` solve the implicit collocation system

```
Z_i = h · Σ_j a_ij · f(t_n + c_j h, y_n + Z_j),    i = 1..3
```

via simplified Newton iteration. Linearising around `(t_n, y_n)` with
`J = ∂f/∂y(t_n, y_n)` gives a (3n × 3n) Newton matrix that the
eigendecomposition of `A⁻¹` factors into one real `n × n` system and
one complex `n × n` system; the complex one embeds as a real `2n × 2n`
LU. Per Newton iteration cost: one real `n × n` LU+solve, one
`2n × 2n` LU+solve. The factorisations are reused across multiple
Newton iterations within a step *and* across multiple steps when `h`
doesn't change.

**Step acceptance** uses Hairer-Wanner's local-error estimator
(eq. IV.8.20): `error = LU_real \ (h·γ·E·F.T + γ·Z[2])`. Step-size
control follows a third-order PI controller (the order used by SciPy
for Radau's step selection).

**Jacobian-staleness logic.** Following SciPy's `_radau.py`,
`recompute_jac = n_iter > 2 and rate > 1e-3`: a fresh Jacobian is
demanded only when Newton convergence rate degraded. On problems
where `J` doesn't change much (linear systems, Robertson's slow
manifold), the same Jacobian gets reused for tens of steps. The PI
controller's exact reuse pattern is implementation-dependent; the
bench's `stiffness_handled` check enforces only the structural floor.

**Symbolic Jacobian setup.** When `options.jacobian` is omitted, the
tool calls `cas-diff` (in-process via `@workbench/compose`) for each
`(i, j)` cell:

```
∂f_i/∂y_j ← wb.run("cas-diff", record({f: f_i, var: sym(y_j)}))
```

The resulting expression `Value`s are cached and compiled to numeric
callables via `evalNumericExpr`. The substrate's per-step Jacobian
refactor calls those callables — no symbolic work per step. If any
cell returns `tagged "cas-diff/out-of-scope"` (rare; the closed
vocabulary covers the bench's RHS expressions), the tool falls back
to the substrate's centred finite-difference Jacobian and pushes a
warning.

The substrate (`packages/ode-core/src/{integrate-stiff, radau,
newton-iteration}.ts`) carries the literate algorithmic prose; this
file is only the wire-encoding wrapper.

## Out of scope (v0.1, deferred)

- **BDF** (backward differentiation formulas). `options.method = "bdf"`
  returns the structural `method-not-implemented` tag. Adding BDF would
  duplicate the substrate's machinery for a small efficiency win; the
  v0.2 question is whether to ship Rosenbrock-W instead.
- **Rosenbrock-W methods.** Useful for moderately-stiff problems where
  Radau's three-stage Newton is overkill. v0.2.
- **DAEs** (differential-algebraic equations). Radau-IIA extends to
  index-1 DAEs; the substrate would need an augmented-system rewrite.
  v0.2.
- **Sparse Jacobian exploitation.** The substrate's LU factorisation
  is dense; on `n > 100` problems with sparse `J` (chemistry, PDE
  semidiscretisations) a sparse path would be a 10×–100× win. The
  numerical-tier FFI bridge (bead `e7y`) is the right escape hatch.
- **Event detection** (root-finding on the trajectory). Deferred to
  v0.2 across the IVP family.
- Vocabulary beyond `cas-diff` / `integrate-1d`'s closed list.

## Invariants

- **deterministic-per-platform**: same input bytes → same output bytes
  on a single platform; `numerical: true` (ADR-0015) records the
  platform fingerprint in provenance.
- **implicit-method-uses-jacobian**: `n_jacobian_evals ≥ 1` on any
  non-degenerate success path. Radau is implicit — every step refactors
  against `J` at least once.
- **lu-pair-per-refactor**: `n_lu_decompositions ≥ 2 · n_jacobian_evals`
  on any successful step (the real + complex pair).
- **monotone-t-values**: `t_values` ascending iff `t0 ≤ tf`,
  descending iff `t0 > tf`; equals `options.t_eval` element-wise when
  supplied.
- **trajectory-shape**: `trajectory` is `(n_eval × n_components)`;
  when `t_eval` omitted, `n_eval = 2` (endpoints only).
- **converged-iff-success**: `converged === (status === "success")` on
  every code path.
- **trajectory-accuracy-vs-reference**: for analytic-oracle inputs,
  `|trajectory − reference|_∞ ≤ 100·rtol·|reference|_∞ + 100·atol` over
  the whole horizon. **No horizon scaling** — Radau is stiffly bounded
  (HW Vol II §IV.10).
- **non-finite-tagged**: `f` or `J` returning NaN/±Inf during
  integration ⇒ `tagged "integrate-ode-stiff/non-finite-during-eval"`
  with `(at_t, at_y, kind)` — never NaN-poisoned trajectory.
- **degenerate-tspan-tagged**: `t0 == tf` ⇒ `tagged
  "integrate-ode-stiff/degenerate-tspan"`.
- **jacobian-singular-tagged**: LU of `(γ/h)I − J` exactly singular ⇒
  `tagged "integrate-ode-stiff/jacobian-singular"` with `(at_t, at_y,
  condition_number)`.
- **method-not-implemented-tagged**: `options.method == "bdf"` ⇒
  `tagged "integrate-ode-stiff/method-not-implemented"` with payload
  `{method: "bdf"}`.
- **unknown-vocabulary-rejected**: `f` or `options.jacobian` containing
  a head or free symbol outside the closed vocabulary raises
  `ToolError`.
- **dim-mismatch-rejected**: `len(f) ≠ len(vars)`, `len(y0) ≠
  len(vars)`, or `options.jacobian` shape ≠ `(n × n)` ⇒ `ToolError`.
- **scale-warnings-emitted**: for `n_components > 100` or
  `n_steps_estimate > 100_000`, the warnings field carries human-
  readable scale advisories per ADR-0016. Algorithm still runs.

## References

- Hairer, E. and Wanner, G. (1996). *Solving Ordinary Differential
  Equations II: Stiff and Differential-Algebraic Problems*, 2nd ed.
  Springer Series in Computational Mathematics 14. §IV.8 (Radau-IIA
  collocation), §IV.10 (implementation), §IV.10 backward stability.
- Hairer, E. and Wanner, G. (1999). "Stiff differential equations
  solved by Radau methods." J. Comput. Appl. Math. 111, 93–111. The
  reference for the simplified-Newton + complex-eigenvalue
  transformation this tool implements.
- SciPy. `scipy/integrate/_ivp/radau.py` — the reference
  implementation. The substrate's algorithmic skeleton mirrors
  `_step_impl` step-for-step.
- Robertson, H. H. (1966). "The solution of a set of reaction rate
  equations." Numerical Analysis: An Introduction, J. Walsh ed., 178–
  182. The canonical stiff test problem.

## Validation

The bench corpus lives in the sibling repo:
`../scientist-workbench-corpus/benchmarks/integrate-ode-stiff/`
(ADR-0028, bead `scientist-workbench-ifng`).  To run the full battery:

```sh
bash scripts/bench-grade.sh integrate-ode-stiff
```

19-case golden battery, 9 invariant checks per case (139 assertions):

1. `shape` — all required fields present including `n_jacobian_evals` and
   `n_lu_decompositions`; correct types; trajectory m×n; status in
   `{success, max_step_exceeded, tspan_exhausted, newton-divergence}`.
2. `finite_entries` — no NaN/Inf in trajectory or error_estimate.
3. `monotone_t_values` — ascending/descending per integration direction;
   matches t_eval element-wise.
4. `status_consistency` — converged iff status==="success"; all five
   counters non-negative.
5. `trajectory_accuracy` — sup-norm error vs SciPy Radau oracle ≤
   100·rtol·|oracle| + 100·atol. **No horizon scaling** — Radau is
   L-stable and stiffly bounded (HW Vol II §IV.10).
6. `self_reported_error_estimate` — error_estimate ≥ 0; ≤ max(1, atol·1e6)
   on success.
7. `stiffness_handled` — n_evals > 0 and n_jacobian_evals > 0 on success
   (structural floor: the implicit method must touch J).
8. `conservation` — conserved-quantity drift ≤ 100·rtol·|tf-t0| where
   applicable.
9. `jacobian_consumed` — if options.jacobian provided, n_jacobian_evals ≥ 1.

**Oracle:** SciPy `solve_ivp(method='Radau', rtol=1e-13)`.

**Mutation-proven** per CLAUDE.md Rule 6.

## Run

```sh
echo '{"kind":"record","fields":{"f":...,"vars":...,"t_var":...,"y0":...,"t_span":...}}' \
  | bun tools/integrate-ode-stiff/tool.ts
```

## Standard flags

`--schema --examples --invariants --version --help --provenance-of <hash> --test --platform-fingerprint`
