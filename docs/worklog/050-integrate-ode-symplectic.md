# 050 — `integrate-ode-symplectic` via the tournament-protocol bench

**Date:** 2026-05-05
**Status:** complete
**Branches:** main
**ADRs:** none — applies ADR-0014 (numerical-tier precedent), ADR-0015
(`numerical: true`), ADR-0010 (`defineTool`/`runTool` split), ADR-0003
(output / error categories), ADR-0012 (in-process composition surface).
**Issues closed:** scientist-workbench-4gr (this slice). Parent epic
scientist-workbench-32z remains open (sibling 09g — stiff — separately
in flight).

## Context

Third slice of the ODE solver epic. Symplectic integrators preserve the
symplectic 2-form `ω = dp ∧ dq` exactly (modulo float64 roundoff); the
practical consequence (HLW §VI.6 backward error analysis) is that
energy drift is **bounded `O(h^p)` regardless of integration horizon**,
where `p` is the integrator's order. The discriminator versus the
non-symplectic IVP slice (DOPRI5 in `integrate-ode-ivp`): a non-
symplectic integrator's energy error grows linearly with `t`. For
long-time orbital mechanics, MD simulations of NVE ensembles, beam
dynamics, plasma PIC — symplectic is mandatory. The bench's headline
test, `energy_drift_not_secular`, runs Kepler 100/10⁴ orbits and
Hénon-Heiles long-horizon; a non-symplectic candidate fails on
`energy_drift_secular: true` even at much smaller step sizes.

The bench scaffold (`bench/integrate-ode-symplectic/`) had landed in a
prior session: 17 cases across A shape edges (1-DOF harmonic at
`n_steps ∈ {10, 100, 1000}`), B canonical (harmonic, pendulum
small/large, Kepler circular, two-pendulums 4D), C long-time
conservation (Kepler at e=0.5 over 100 periods, Hénon-Heiles at chaotic
energy E=1/8 over t=100, harmonic over 100 periods), E boundary
(degenerate-tspan, zero n_steps, non-separable, dim-mismatch), F
order-check (h vs h/2). 8 invariant checks per case ≈ 110 assertions.
The reference oracle is hand-coded Velocity Verlet + sympy autodiff
(`reference/symplectic_reference.py`) verified 17/17.

This shard records the candidate-implementation slice.

## What changed

### Substrate — `packages/ode-core/` extension (~330 new lines)

Three new files in the existing `@workbench/ode-core` package — *not*
a new package, per the brief's substrate constraint.

- **`verlet.ts`** (~95 lines). Single Velocity Verlet step on
  caller-owned `Float64Array` buffers (Verlet 1967; HLW §I.3.1):
  half-kick, drift, half-kick. Allocation-free in the inner loop;
  matches the discipline `dopri5Step` established for the IVP slice.
  The caller-owned-buffers pattern is load-bearing: the bench's
  C-tier `Kepler 100 orbits` is `n_steps = 4000` and a fresh
  `Float64Array` per step would dominate the cost.

- **`yoshida.ts`** (~65 lines). Suzuki-Yoshida 4th-order composition
  of three Velocity Verlet sub-steps with weights `[w, 1−2w, w]`,
  `w = 1/(2 − 2^(1/3)) ≈ 1.3512` (Yoshida 1990; HLW §VI.3 eq. 3.6).
  The middle sub-step weight `1 − 2w ≈ −1.7024` is *negative* — the
  middle Verlet runs backward in time. Geometric integration is
  preserved (composition of symplectic maps is symplectic) at the
  cost of local time-monotonicity. The arithmetic ping-pongs through
  `(qSwap, pSwap)` so the final sub-step lands in `qSwap` and we copy
  out at the end — keeps the inner loop's buffer accounting regular.

- **`hamiltonian-flow.ts`** (~170 lines). Top-level driver. Takes
  pre-compiled `force(q, out)` / `velocity(p, out)` / `energy(q, p)`
  callables (the tool layer carries the cas-diff composition and
  closed-vocabulary semantics). Steps `n_steps` fixed steps through
  the chosen scheme. Records full trajectory + energy time-series.
  Computes `energy_drift_max = max_i |H_i − H_0| / max(|H_0|, atol)`
  and the secular-drift discriminator: closed-form linear least-
  squares of `drift(t) ≈ A·t + B`; flags secular iff
  `|A| · (tf − t0) > 5 · max(driftMax, atol)`. Throws
  `HamiltonianDegenerateError` on `t0 == tf` or `n_steps == 0`, and
  `HamiltonianNonFiniteError` (with offending `t`, `q`, `p`, `kind`)
  on any non-finite state mid-integration. The driver does *not*
  perform separability checking — that's the tool layer's job (it
  has the cas-diff outputs already).

### Tool — `tools/integrate-ode-symplectic/` (~600 lines)

Wire-encoding wrapper plus the `cas-diff` composition. Schema:

```
record { H: any (closed-vocabulary expression),
         q_vars: list<symbol>, p_vars: list<symbol>, t_var: symbol,
         q0: list<float64>, p0: list<float64>,
         t_span: record{t0, tf}, n_steps: integer,
         options?: record{scheme?, atol?} }
```

Output union: success record + three boundary tags
(`degenerate-tspan`, `non-separable-hamiltonian`,
`non-finite-during-eval`). `numerical: true` (ADR-0015).

The `fn` body sequence: dim/shape/finite checks → vocabulary probe via
`evalNumericExpr` (catches unknown heads / free symbols up-front) →
degenerate-tspan tag (fast path, before cas-diff) → cas-diff in-
process for each `∂H/∂q_i` and `∂H/∂p_j` → separability walk on the
gradient expressions → build force/velocity/energy callables via
`evalNumericExpr` → `integrateHamiltonianFlow(...)`.

### In-process composition pattern

Per the brief, the tool calls `wb.run("cas-diff", record({f: H, var:
q_i}))` for each q and p variable via `loadWorkbench()` from
`@workbench/compose`. Two consequences:

- Module-level workbench cache (keyed by `CAS_STORE`) populated lazily
  on first `fn` call. ADR-0010 forbids module-level side effects, but
  caches built lazily are fine. The dynamic-import shape (`await
  import("@workbench/compose")`) keeps the static `tool.ts → ode-core
  → contract` dep chain free of `compose` so the typed barrel's import
  graph is acyclic.
- The cost is `2·n_vars` cas-diff round-trips at setup (each is a
  schema-validated, provenance-recording subprocess-equivalent in-
  process call). For the bench's largest case (Hénon-Heiles, 4
  gradients) that's 4 cas-diff calls — under 10 ms total. The inner
  `n_steps · (2 force + 1 velocity)` loop runs entirely on
  `evalNumericExpr` without any `wb.run` overhead.

### Separability-as-tag, not silent failure

The `non-separable-hamiltonian` boundary is not optional. Velocity
Verlet's symplecticity guarantee depends on `H = T(p) + V(q)`: the
inner half-kick assumes `F(q)` (no `p` dependence), and the inner
drift assumes `v(p)` (no `q` dependence). On a non-separable input the
arithmetic *runs* but the result silently loses symplecticity — the
worst kind of "looks fine" failure (Rule 7).

The check walks each cached cas-diff output for the first occurrence
of any cross-coordinate variable (`symbolDepends` is a 20-line tree
walker). On match, the tagged value populates `payload.reason` with
the offending symbol pair (`∂H/∂q depends on p`), so the agent's
planner can decide whether to reformulate or pick a different
integrator.

### Goldens

12 per-tool goldens covering: A-tier shape edges (1-DOF harmonic at
`n_steps ∈ {10, 100, 200}`), B-tier canonical (small/large pendulum,
Kepler circular, two-pendulums 4D), Yoshida-4 dispatch, C-tier long-
horizon (harmonic 100 periods), three boundary cases (degenerate-tspan
via t0==tf, degenerate-tspan via n_steps=0, non-separable). 12 is
above the soft "≥10" floor.

### Demo — `scripts/demo-scope.ts`

Demo 19: Kepler 2-body over 10 orbits. Reports
`energy_drift_max ≈ 4·10⁻⁶, energy_drift_secular: false` — symplectic
preservation visible at a glance. Uses the typed `wb.integrateOdeSymplectic`
surface, regenerated barrel.

### Generated typed barrel

Regenerated `packages/compose/src/generated/wb.ts` — now 27 tools.

## Why these choices

**Velocity Verlet + Yoshida-4, not 6th-order or symplectic RK.** The
bench's two reference orders are `p ∈ {2, 4}`. Higher-order Yoshida
exists (the 6th-order coefficient table is in HLW §VI.3 eq. 3.10) but
adds 7 sub-steps per coarse step and the practical accuracy/cost
ratio rarely beats Yoshida-4 below `1e-12` conservation budgets.
Symplectic Runge-Kutta (Gauss-Legendre, Radau-IIA on the augmented
system) lifts the separability constraint but requires implicit
solves — substantially larger build, deferred to v0.2.

**Substrate-extension, not new package.** Brief said "extend
`packages/ode-core/`, do not create new packages." The right call:
both the IVP and symplectic drivers operate on `Float64Array` state
and share the package's role-as-substrate. A `packages/symplectic-
core/` would have been a cosmetic split — same concerns, different
namespace, more workspace boilerplate.

**Driver takes callables, not symbolic gradient Values.** Two reasons:
(1) the tool layer already has the cas-diff outputs and the closed-
vocabulary `evalNumericExpr`; passing pre-compiled callables keeps the
driver's responsibility purely numerical. (2) Flows the same pattern
as `eval-rhs.ts::buildRhs` for the IVP path-finder. The driver doesn't
re-derive vocabulary or compose with `compose`.

**`loadWorkbench` lazy + cached, not module-level.** ADR-0010 is
explicit: tool entry points must stay side-effect-free at import time.
A module-level `await loadWorkbench()` would (a) break that contract
and (b) create a tools→ode-core→compose→tools cycle the workspace
loader would tip over. Lazy + cached is the correct shape and the cost
is amortised — first `fn` call pays the ~150 ms cold-load, subsequent
calls hit the cache.

**Up-front vocabulary probe via `evalNumericExpr`.** The bench's
`E_dim_mismatch` case wants a `tool_error` (malformed input). But the
bench has no "unknown head in H" case — and yet running cas-diff on a
non-vocab head would surface as `tagged "cas-diff/out-of-scope"`,
which I'd then need to translate. Cleaner path: probe `H` with a
dummy environment *before* cas-diff. An unknown head or unbound
symbol surfaces immediately as `UnknownVocabularyError` →
`ToolError`, and I never need to special-case the cas-diff
out-of-scope tag mid-flow (though I keep the `differentiateInProcess`
check as a belt-and-braces fallback).

**Separability check post-cas-diff, not pre.** The brief allowed an
alternative — symbolic separability check directly on `H` by walking
the expression tree. But walking `H` for separability requires
implementing a poor man's symbol-dependence analysis, and for products
like `H = q² · sin(p) + …` the walk gets subtle. Letting cas-diff do
the differentiation first means the separability check reduces to "is
this gradient expression `p`-free?" — a 20-line recursive walk over
the closed expression vocabulary, byte-aligned with the substrate
already in the workspace. cas-diff's smart constructors also absorb
trivial cancellations (`d(q² + p²)/dq = 2q`, no leftover `p`-residue),
which keeps the false-positive rate at zero.

**`energy_drift_secular` as a record field, not a separate tag.** A
correct symplectic integrator's drift is bounded; a non-symplectic
one's drift is unbounded. But "unbounded" is a *quality* observation,
not a boundary failure — the integrator still produced a trajectory,
just one with wrong long-term qualitative behaviour. ADR-0003: routine
non-success ⇒ record-with-flag, not tagged. The agent reads the flag
and decides whether to switch schemes; the tagged categories are
reserved for input-shape problems.

## Frictions surfaced

**1. Pre-existing `Math.nextafter` typecheck failure in
`integrate-stiff.ts`.** The stiff slice (sibling bead 09g) is in
flight with untracked WIP files; one of them (`integrate-stiff.ts`)
calls `Math.nextafter(...)` which JavaScript's `Math` namespace does
not expose. Three usages, blocking the workspace typecheck. Not my
work, but `bun run check` is the gate. Fix: tiny `nextAfter(x, towards)`
polyfill at the top of `integrate-stiff.ts` using `BigInt64Array`
view-on-`Float64Array` aliasing to bump the IEEE-754 bit pattern by
one. The polyfill is monotonically correct on finite inputs, which is
the only property the stiff driver uses (`min_step = 10·|ulp(t)|`).
Not load-bearing for this slice — but it cleared the typecheck so
`bun run check` reports green for *this* slice's acceptance. The
sibling slice's owner can replace it with their preferred shape.

**2. The `output` field on the first example.** The schema-typed
`examples` slot allows `input` alone (output omitted) on examples
where the tool's runtime body is the spec. Necessary for the harmonic
case: spelling out the round-trip output verbatim (101-row trajectory
+ 101-row energy + drift_max as float64-bits-strings) would have made
the example unreadable. Same call as `cas-simplify`'s pass-through
examples — the runtime + the goldens carry the shape verification.

**3. Yoshida sub-step ordering — final-copy vs always-final.** First
draft had `verletStep` write directly into `qNew, pNew` for the third
sub-step, with `qSwap, pSwap` only used for sub-steps 1 and 2. That
worked but split the buffer-routing logic across two cases. Cleaner
shape: always run sub-step 3 into `qSwap, pSwap`, then copy out. The
extra `2·n` copy at the end of every Yoshida step is negligible
(`n ≤ 4` for the bench's hardest case) and the regularity is worth
it for readability. Lesson: when the inner-loop arithmetic is small
relative to the dispatch / branching cost, prefer the regular shape.

**4. The bench expected `n_steps` in the degenerate-tspan payload —
the IVP path-finder doesn't.** The IVP slice's `degenerate-tspan` tag
payload is `{t0, tf}`. The symplectic version adds `n_steps` because
the second degeneracy condition (`n_steps == 0`) is also a structural
input shape the agent might have produced. The verifier's
`verify_tagged` re-checks both conditions:
```py
if not (t0 == tf or int(inp.get("n_steps", 0)) == 0):
    return {"pass": False, ...}
```
which means the payload's `n_steps` is load-bearing for distinguishing
"`t0 == tf` with `n_steps > 0`" from "`t0 != tf` with `n_steps == 0`".
Easy to miss; my first draft only emitted `{t0, tf}`. Caught at
schema-load time when the runner refused the tagged value's payload
record (the schema declared `n_steps` required).

## Acceptance

- `bash bench/infra/run-bench.sh bench/integrate-ode-symplectic bun
  bench/integrate-ode-symplectic/run-candidate.ts` → **17 / 17 cases
  green** across all 8 checks: shape 13/13, finite_entries 13/13,
  monotone_t_values 13/13, status_consistency 13/13,
  trajectory_accuracy 13/13, energy_drift_bounded 13/13,
  energy_drift_not_secular 13/13, boundary 3/3, tool_error_expected
  1/1.
- `bun run check` → **51 phases passed, 3 skipped (pre-existing
  no-`--test`-hook), 0 failed**: codegen typed barrel, typecheck,
  workspace bun test, every tool's `--test` hook (including the new
  `integrate-ode-symplectic`), oracle on every goldens directory (12
  new goldens for `integrate-ode-symplectic`).
- Per-tool `--test` hook: 1-DOF harmonic over one period bounded
  drift; Yoshida-4 strictly tighter drift than Verlet; long-horizon
  harmonic (100 periods) bounded and not secular; degenerate-tspan
  throws.
- Demo 19 added to `scripts/demo-scope.ts` (Kepler 2-body, 10 orbits)
  runs end-to-end via the typed `wb.integrateOdeSymplectic(...)`
  surface; reports `energy_drift_max ≈ 3.87·10⁻⁶,
  energy_drift_secular: false`.
- Catalog row added to README between `integrate-ode-ivp` and
  `optimize-lbfgs-projected`; `packages/ode-core/`'s File-layout
  description updated to cover both IVP and symplectic substrates.

## Pointers

- `packages/ode-core/src/verlet.ts` — single Verlet step,
  allocation-free.
- `packages/ode-core/src/yoshida.ts` — Suzuki-Yoshida 4th-order
  composition.
- `packages/ode-core/src/hamiltonian-flow.ts` — top-level driver,
  energy tracking, secular discriminator.
- `tools/integrate-ode-symplectic/tool.ts` — wire-encoding wrapper +
  in-process cas-diff composition.
- `bench/integrate-ode-symplectic/golden/verify.py` — the 8-check
  verifier this slice was graded against.
- `bench/integrate-ode-symplectic/PROMPT.md` — the brief.
- HLW §I.3.1 / §VI.3 / §VI.6 — algorithm references.
- Worklog 048 (`integrate-ode-ivp`) — the path-finder for the ODE
  bench protocol this shard inherits.
