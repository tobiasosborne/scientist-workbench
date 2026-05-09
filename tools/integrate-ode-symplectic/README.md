# integrate-ode-symplectic

Symplectic integrator for separable Hamiltonian systems

```
H(q, p) = T(p) + V(q),   dq/dt = ∂H/∂p,   dp/dt = −∂H/∂q
```

via **Velocity Verlet** (2nd-order, default; the MD workhorse) or
**Yoshida-4** (4th-order Suzuki-Yoshida composition of three Verlet
sub-steps). Third slice of the ODE epic (parent: bead
`scientist-workbench-32z`); `integrate-ode-ivp` (path-finder) ships
non-stiff IVP via DOPRI5+PI; `integrate-ode-stiff` (deferred) ships
implicit methods for stiff systems.

The discriminator vs `integrate-ode-ivp`: a non-symplectic integrator's
energy error grows linearly with `t` (`O(t · h^p)`). A symplectic
integrator's energy error is **bounded `O(h^p)` regardless of horizon**
(Hairer-Lubich-Wanner *Geometric Numerical Integration* §VI.6 backward
error analysis). For long-time orbital mechanics, MD simulations of NVE
ensembles, beam dynamics, plasma PIC — symplectic is mandatory.

Library surface (TS-side, no JSON):

```ts
import {
  integrateHamiltonianFlow,
  type HamiltonianFlowCallables,
} from "@workbench/ode-core";

// H = (q² + p²)/2: 1-DOF harmonic. Hand-coded gradients for the demo.
const callables: HamiltonianFlowCallables = {
  force:    (q, out) => { out[0] = -q[0]!; },          // -∂H/∂q = -q
  velocity: (p, out) => { out[0] =  p[0]!; },          //  ∂H/∂p =  p
  energy:   (q, p)   => 0.5 * (q[0]! ** 2 + p[0]! ** 2),
};
const r = integrateHamiltonianFlow(
  new Float64Array([1]), new Float64Array([0]),
  0, 2 * Math.PI, 100, callables,
);
// r.energyDriftMax       ~ 1e-3 for Verlet at h = T/100
// r.energyDriftSecular === false  (oscillatory, not linear-growth)
```

The tool wrapper auto-derives `force` / `velocity` / `energy` from a
single `H` expression via `cas-diff` (in-process). Callers compose
without hand-deriving gradients.

## Input

```jsonc
{
  "kind": "record",
  "fields": {
    "H":      <expression>,                          // single Hamiltonian expression
    "q_vars": {"kind": "list", "items": [<symbol>, ...]},  // n position coords
    "p_vars": {"kind": "list", "items": [<symbol>, ...]},  // n conjugate momenta
    "t_var":  {"kind": "symbol", "name": "t"},        // independent var (informational; H may depend on t for Hamiltonians with explicit time)
    "q0":     {"kind": "list", "items": [<float64>, ...]},  // n initial positions
    "p0":     {"kind": "list", "items": [<float64>, ...]},  // n initial momenta
    "t_span": {
      "kind": "record",
      "fields": {
        "t0": {"kind": "float64", "bits": "..."},
        "tf": {"kind": "float64", "bits": "..."}
      }
    },
    "n_steps": {"kind": "integer", "value": "..."},   // fixed step count
    "options": {                                       // optional
      "kind": "record",
      "fields": {
        "scheme": {"kind": "string", "value": "verlet" | "yoshida-4"},  // default verlet
        "atol":   {"kind": "float64", ...}              // default 1e-9 (drift normalisation)
      }
    }
  }
}
```

`H` is required to use the **closed expression vocabulary** shared
across `cas-diff` / `integrate-1d` / `integrate-ode-ivp`:

```
+, -, *, /, ^, neg,
exp, sin, cos, tan, log, sqrt, abs,
asin, acos, atan, sinh, cosh, tanh, asinh, acosh, atanh, log2, log10
```

Constants: `pi`, `e`. Numeric leaves: `integer`, `rational`, `float64`.

`H` must be **separable**: `∂H/∂q_i` independent of every `p_j`, and
`∂H/∂p_j` independent of every `q_i`. Velocity Verlet's symplecticity
guarantee depends on this. Non-separable inputs surface as a
`tagged "integrate-ode-symplectic/non-separable-hamiltonian"` rather
than producing wrong-quality output.

## Output

Four shapes (ADR-0003 categories):

**Happy path — record:**

```jsonc
{
  "kind": "record",
  "fields": {
    "q_trajectory":         {"kind": "list", "items": [...]},  // (n_steps+1 × |q_vars|)
    "p_trajectory":         {"kind": "list", "items": [...]},  // (n_steps+1 × |p_vars|)
    "t_values":             {"kind": "list", "items": [...]},  // (n_steps+1,) uniform t0..tf
    "energy":               {"kind": "list", "items": [...]},  // (n_steps+1,) H(q_i, p_i)
    "energy_drift_max":     {"kind": "float64", ...},   // max |H_i − H_0| / max(|H_0|, atol)
    "energy_drift_secular": {"kind": "boolean", ...},   // linear-fit-vs-time discriminator
    "n_evals":              {"kind": "integer", ...},
    "n_steps":              {"kind": "integer", ...},
    "converged":            {"kind": "boolean", "value": true},
    "status":               {"kind": "string",  "value": "success"},
    "method":               {"kind": "string",  "value": "velocity-verlet" | "yoshida-4"},
    "warnings":             {"kind": "list", "items": [<strings>]}
  }
}
```

`energy_drift_secular` is the load-bearing diagnostic. A correct
symplectic integrator on a separable H *never* sets it `true`. The
discriminator: a non-symplectic candidate would fail this on Kepler 100
or 10⁴ orbital periods.

`energy_drift_max` is normalised by `max(|H_0|, atol)` — agent-honest
in the sense that drift on a Hamiltonian with `H_0 ≈ 0` is reported in
absolute units, not as a meaningless ∞.

**Boundary failures — tagged:**

```jsonc
{"kind": "tagged", "tag": "integrate-ode-symplectic/degenerate-tspan",          "payload": {"t0", "tf", "n_steps"}}
{"kind": "tagged", "tag": "integrate-ode-symplectic/non-separable-hamiltonian", "payload": {"reason": "..."}}
{"kind": "tagged", "tag": "integrate-ode-symplectic/non-finite-during-eval",    "payload": {"at_t", "at_q", "at_p", "kind"}}
```

The non-separable check runs **before** the integration loop opens —
the tool routes `H` through `cas-diff` symbolically, walks each
partial derivative, and tags immediately on the first cross-coordinate
dependency.

**Malformed input — `ToolError` (exit 1):**

- `q_vars` / `p_vars` empty.
- `len(q_vars) ≠ len(p_vars)` (Hamiltonian flow needs equal-dim q/p).
- `len(q0) ≠ len(q_vars)` or `len(p0) ≠ len(p_vars)`.
- any `q0[i]` / `p0[i]` non-finite at input time.
- non-finite `t0` / `tf`.
- `n_steps < 0` (zero is a *boundary*, not malformed input).
- unknown expression head or free symbol in `H`.
- malformed options (unknown key, `atol ≤ 0`, unknown scheme).

## How

**Velocity Verlet** (Verlet 1967; HLW §I.3.1):

```
p_{n+½} = p_n     + (h/2) · F(q_n)            // half kick
q_{n+1} = q_n     +  h    · v(p_{n+½})        // drift
p_{n+1} = p_{n+½} + (h/2) · F(q_{n+1})        // half kick
```

with `F(q) = −∂H/∂q` and `v(p) = ∂H/∂p`. Two `force` evaluations and
one `velocity` evaluation per step. Allocation-free in the inner loop.

**Yoshida-4** (Yoshida 1990; HLW §VI.3 eq. 3.6):

```
S_4(h) = S_2(w·h) ∘ S_2((1−2w)·h) ∘ S_2(w·h),    w = 1/(2 − 2^(1/3))
```

where `S_2` is one Velocity Verlet step. `1 − 2w ≈ −1.7024…` is
**negative** — the middle sub-step runs backward in time. That is the
price of pushing from order 2 to order 4 through a symmetric
composition; the geometry is still preserved. Three Verlet sub-steps
per coarse step → ~3× cost, ~h² = 100× tighter drift at typical step
sizes — net 30× efficiency win for sub-`1e-8` conservation budgets.

**Symbolic gradient setup.** The tool calls `cas-diff` (in-process via
`@workbench/compose`'s `loadWorkbench`) for each `q_i` and `p_j`:

```
∂H/∂q_i ← wb.run("cas-diff", record({f: H, var: sym(q_i)}))
```

The resulting expression `Value`s are cached and compiled to numeric
callables via `@workbench/quadrature`'s `evalNumericExpr`. The inner
Verlet loop calls those callables — no symbolic work per step.

**Separability check.** Each cached `∂H/∂q_i` is walked recursively;
if it mentions any `p_vars` symbol the input is non-separable (and
analogously for `∂H/∂p_j` mentioning `q_vars`). The first dependency
found populates `payload.reason`.

The substrate (`packages/ode-core/src/{verlet, yoshida, hamiltonian-flow}.ts`)
carries the literate algorithmic prose; this file is only the
wire-encoding wrapper.

## Out of scope (v0.1, deferred)

- **Non-separable Hamiltonians.** Velocity Verlet's symplecticity
  depends on separability; the implicit symplectic methods
  (Gauss-Legendre, Radau-IIA on the augmented system) are a
  substantially larger build, deferred to v0.2.
- **Adaptive step control.** Symplectic integrators are inherently
  fixed-step. Adaptive symplectic with reversible step control exists
  (Hairer-Söderlind 2005) but is non-trivial to make symplectic; v0.2.
- **6th-order Yoshida or symplectic Runge-Kutta.** The order-2 / order-4
  pair covers the practical accuracy regimes; higher-order is a v0.2
  question.
- **Time-dependent Hamiltonians** `H(q, p, t)`. Verlet handles
  autonomous `H(q, p)`; non-autonomous Hs need the augmented (q, p, t,
  E) system or a different scheme.
- **Event detection** (root-finding on the trajectory). Deferred to
  v0.2.
- Vocabulary beyond `cas-diff` / `integrate-1d`'s closed list.
- FFI bridge to a compiled symplectic integrator — bead `e7y`.

## Invariants

- **deterministic-per-platform**: same input bytes → same output bytes
  on a single platform; `numerical: true` (ADR-0015) records the
  platform fingerprint in provenance.
- **energy-drift-bounded**: for separable H integrated over `[t0, tf]`
  with step `h`, the energy drift `max_i |H(q_i, p_i) − H(q_0, p_0)| /
  max(|H_0|, atol)` is bounded `≤ 100 · h^p · drift_constant` for the
  integrator's order `p` (Verlet: 2; Yoshida-4: 4) — HLW §VI.6
  backward error analysis.
- **energy-drift-not-secular-on-separable-H**: for any separable H
  integrated over arbitrarily long horizon, `energy_drift_secular` is
  `false`. The discriminator: a non-symplectic candidate would fail
  this on Kepler 100/10⁴ orbits.
- **trajectory-shape**: `q_trajectory` is `(n_steps+1, |q_vars|)`,
  `p_trajectory` is `(n_steps+1, |p_vars|)`, `t_values` and `energy`
  length `n_steps+1`.
- **monotone-uniform-t-values**: `t_values` are uniformly spaced
  `t0..tf` with step `h = (tf − t0) / n_steps`.
- **converged-iff-success**: `converged === (status === "success")`.
- **non-separable-h-tagged**: H with `∂H/∂q_i` depending on any `p_j`
  (or `∂H/∂p_j` depending on any `q_i`) ⇒
  `tagged "integrate-ode-symplectic/non-separable-hamiltonian"`.
- **degenerate-tspan-tagged**: `t0 == tf` or `n_steps == 0` ⇒
  `tagged "integrate-ode-symplectic/degenerate-tspan"`.
- **non-finite-tagged**: a step or H-evaluation producing NaN/±Inf ⇒
  `tagged "integrate-ode-symplectic/non-finite-during-eval"` with
  offending `(at_t, at_q, at_p, kind)`.
- **unknown-vocabulary-rejected**: H containing a head or free symbol
  outside the closed vocabulary raises `ToolError`.
- **dim-mismatch-rejected**: `len(q_vars) ≠ len(p_vars)`,
  `len(q_vars) ≠ len(q0)`, or `len(p_vars) ≠ len(p0)` ⇒ `ToolError`.

## References

- Hairer, Lubich, Wanner. *Geometric Numerical Integration:
  Structure-Preserving Algorithms for Ordinary Differential Equations*,
  2nd ed. Springer 2006. §I.3.1 (Verlet); §VI.3 (composition methods,
  Yoshida); §VI.6 (backward error analysis).
- Verlet, L. (1967). "Computer experiments on classical fluids. I.
  Thermodynamical properties of Lennard-Jones molecules." Phys. Rev.
  159(1), 98-103.
- Yoshida, H. (1990). "Construction of higher order symplectic
  integrators." Phys. Lett. A 150(5-7), 262-268.
- Suzuki, M. (1991). "General theory of fractal path integrals with
  applications to many-body theories and statistical physics." J.
  Math. Phys. 32, 400-407.

## Validation

Golden battery migrated to corpus per ADR-0028 (bead `scientist-workbench-yj80`):
`scientist-workbench-corpus/benchmarks/integrate-ode-symplectic/` — 17 cases,
95 invariants, graded via `bash scripts/bench-grade.sh integrate-ode-symplectic`.

Local bench removed (freed ~1.7 MB).  The corpus verifier (`verify.ts`) ports all
7 Python invariants from `verify.py` with byte-identical tolerances.

`bench/integrate-ode-symplectic/` (former) — 17-case golden battery, 8 invariant
checks per case (~136 assertions):

1. `no_tool_error` — clean exit.
2. `shape` — output record has all required fields.
3. `converged_true` — `converged === true` on success cases.
4. `trajectory_shape` — `q_trajectory` is `(n_steps+1, |q_vars|)`,
   `p_trajectory` is `(n_steps+1, |p_vars|)`.
5. `monotone_uniform_t_values` — `t_values` uniformly spaced `t0..tf`
   with step `h = (tf − t0) / n_steps`.
6. `energy_drift_bounded` — `energy_drift_max ≤ 100 · h^p ·
   drift_constant` for integrator order `p` (HLW §VI.6 with 100×
   safety).
7. **`energy_drift_not_secular`** — `energy_drift_secular === false`
   for all separable-H cases. The headline discriminator: a
   non-symplectic candidate on Kepler 100 orbits or an NVE MD
   simulation fails this while `energy_drift_max` might still look
   finite in the short term.
8. `non_separable_tagged` — non-separable H produces the boundary
   tag, never wrong-quality output.

Cases include: harmonic oscillator (Verlet + Yoshida-4), Kepler orbit
(100 periods, long-horizon conservation), NVE Lennard-Jones pair,
Hénon-Heiles (chaotic), and non-separable-H refusal cases.

**Tolerances:** HLW §VI.6 backward-error bound ×100 safety factor,
consistent with the linalg and ODE-IVP benches.

**Mutation-proven** per CLAUDE.md Rule 6.

## Run

```sh
echo '{"kind":"record","fields":{"H":...,"q_vars":...,"p_vars":...,"t_var":...,"q0":...,"p0":...,"t_span":...,"n_steps":...}}' \
  | bun tools/integrate-ode-symplectic/tool.ts
```

## Standard flags

`--schema --examples --invariants --version --help --provenance-of <hash> --test --platform-fingerprint`
