# @workbench/ode-core

Adaptive non-stiff initial-value-problem (IVP) integration on
`Float64Array`. Substrate behind `tools/integrate-ode-ivp`.

```ts
import { integrate, buildRhs } from "@workbench/ode-core";

// f(t, y) = -y;  y(0) = 1;  evaluate at t=0,1,2,...
const f = (t: number, y: Float64Array, out: Float64Array) => {
  out[0] = -y[0]!;
};
const r = integrate(f, 0, 5, new Float64Array([1.0]), {
  rtol: 1e-6, atol: 1e-9, tEval: [0, 1, 2, 3, 4, 5],
});
// r.trajectory[5] ≈ Float64Array [exp(-5)]
// r.nStepsAccepted ~ 30; r.nStepsRejected typically 0 on smooth problems
// r.status === "success" iff every t_eval was reached
```

## Algorithm

**Dormand-Prince 5(4)** (DOPRI5; Dormand & Prince 1980): the canonical
embedded explicit Runge-Kutta pair. Seven stages with FSAL ("First
Same As Last" — the 7th stage of an accepted step is the 1st stage
of the next, saving one `f` evaluation per accepted step). The 5th-
order solution advances; the 4th-order embedded estimate drives the
adaptive step-size controller.

**PI controller** (Gustafsson 1991; HNW Vol I §IV.2):
`h_{n+1} = h_n · safety · (1 / err_n)^α · (err_{n-1})^β` with
`α = 0.7/p, β = 0.4/p, p = 5`. The PI law damps the oscillations the
pure-I controller exhibits on stiff edges and is the default in SciPy
`solve_ivp(method='RK45')` and MATLAB `ode45` since the late 1990s.

**Initial step** via the HNW Vol I §II.4 starting-step heuristic
(also reproduced in SciPy `_ivp/common.py::select_initial_step`):
two `f`-evaluations to estimate the leading derivative norm.

**Dense output** via the 4th-order Hermite continuous extension
(HNW Vol I §II.6; Dormand-Prince 1980 §6). The interpolant uses six
of the step's seven k-vectors; the polynomial coefficients are
verbatim from SciPy `scipy/integrate/_ivp/rk.py::RK45.P`. We do not
linearly interpolate between accepted-step endpoints — the bench's
`H_dense_*` cases probe this.

References:
- Hairer, Nørsett, Wanner. *Solving Ordinary Differential Equations
  I — Nonstiff Problems*, 2nd ed. Springer 1993. §II.5 (DOPRI5),
  §II.6 (dense output), §IV.2 (PI control).
- Dormand, Prince. *A family of embedded Runge-Kutta formulae*. J.
  Comput. Appl. Math. 6:19-26, 1980.
- Gustafsson. *Control theoretic techniques for stepsize selection
  in explicit Runge-Kutta methods*. ACM TOMS 17:533-554, 1991.

## Surface

- `integrate(f, t0, tf, y0, opts?)` — top-level driver. Returns
  `{ trajectory, tValues, errorEstimate, nEvals, nStepsAccepted,
     nStepsRejected, status }`. Reverse integration via `tf < t0`.
- `buildRhs(fExprs, vars, tVar)` — adapter that turns a list of
  closed-vocabulary expression `Value`s into a `(t, y, out) => void`
  RHS. Reuses `@workbench/quadrature::evalNumericExpr`; same
  vocabulary as `cas-diff` / `integrate-1d` / `optimize-lbfgs-projected`.
- `dopri5Step(...)` — single-step routine on Float64Array (allocation-
  free). Useful for substrate composition (event detection, dense
  trajectory recording) deferred to v0.2.
- `dopri5DenseEval(theta, h, yN, k1..k7, out)` — Hermite continuous
  extension at `θ ∈ [0, 1]` between accepted endpoints.
- `nextStepFactor(errNorm, errPrevNorm?)` — PI controller, exposed
  for harness use.
- `selectInitialStep(...)` — HNW §II.4 starting-step heuristic.
- `assessNumericalScale("ode-rkf45", n_components, n_steps_estimate)`
  — measurement-driven warning strings (ADR-0016 pattern). No hard
  caps; the agent reads the strings and decides.

## Errors

- `OdeNonFiniteError` — `f` returned NaN/±Inf at some `(t, y)`. The
  tool layer translates this to `tagged "integrate-ode-ivp/non-finite-
  during-eval"` (ADR-0003 boundary failure).
- `OdeDegenerateTspanError` — `t0 == tf`. The tool layer translates
  this to `tagged "integrate-ode-ivp/degenerate-tspan"`.
- `UnknownVocabularyError` (re-thrown from
  `@workbench/quadrature`) — the user's expression contains a head or
  symbol outside the closed vocabulary. The tool layer translates
  this to `ToolError`.

## Out of scope (v0.1, deferred)

- **Stiff problems.** DOPRI5 is explicit; on stiff systems it
  rejects steps relentlessly and the controller times out. Sister
  tool `integrate-ode-stiff` (bead `scientist-workbench-09g`) will
  ship Radau-IIA / BDF.
- **Symplectic integration.** DOPRI5 is non-symplectic — energy
  drift is `O(rtol · t)`. For Hamiltonian systems where structure
  preservation matters, sister tool `integrate-ode-symplectic` (bead
  `scientist-workbench-4gr`) will ship velocity-Verlet / 4th-order
  symplectic.
- **Event detection.** Root-finding on the trajectory is its own
  beast (Brent + dense extension). Deferred to a v0.2 bead.
- **Vocabulary beyond `cas-diff` / `integrate-1d`.** Extension is
  additive.
