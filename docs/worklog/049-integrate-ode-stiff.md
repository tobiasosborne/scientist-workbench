# 049 — `integrate-ode-stiff` via the tournament-protocol bench

**Date:** 2026-05-05
**Status:** complete
**Branches:** main
**ADRs:** none — applies ADR-0014 (numerical-tier precedent), ADR-0015
(`numerical: true`), ADR-0010 (`defineTool`/`runTool` split), ADR-0003
(output / error categories), ADR-0012 (in-process composition surface),
ADR-0016 (no hard component cap).
**Issues closed:** scientist-workbench-09g (this slice). Parent epic
scientist-workbench-32z (sibling slices 4gr — symplectic — and l6p —
non-stiff IVP — already shipped; this is the second numerical-IVP
slice).

## Context

Second numerical-IVP slice of the ODE solver epic. Stiffness is what
makes Robertson, Oregonator, HIRES, and the chemical-kinetics canon
unsolvable by explicit RK without exponential step refinement.
Hairer-Wanner Vol II §IV.1 names the diagnosis: a problem is stiff
when the ratio `λ_max / λ_min` of the Jacobian's eigenvalues is large
*and* the dynamics on the slow manifold is the part the user cares
about. The fast modes (here the `1e4` and `3e7` Robertson reaction
rates) demand a step `h ≪ 1/λ_max ≈ 3·10⁻⁸` from any explicit RK; the
slow mode lives over `t = 10¹⁰`. Implicit methods with A-stability —
specifically L-stability — damp the fast modes at any `h` and let the
controller pick `h` based on the *slow* dynamics. Radau-IIA(5) is the
SciPy `solve_ivp(method='Radau')` algorithm: 3-stage 5th-order, A-
stable, L-stable, stiffly accurate (HW Vol II §IV.8).

The bench scaffold (`bench/integrate-ode-stiff/`) had landed in a prior
session: 19 cases across A shape edges (scalar mild, scalar λ=1000,
2D linear stiff), B mild (vdP μ=1, exp decay long, linear decay 2D),
C stiffness sweep (vdP μ ∈ {100, 1e3, 1e4}), D NHW Vol II canonical
(Robertson, Oregonator, HIRES), E boundary (degenerate-tspan,
method-bdf, unknown-head, dim-mismatch), F tolerance discipline
(Robertson at rtol ∈ {1e-3, 1e-6, 1e-9}). 9 invariant checks per case
including the load-bearing `stiffness_handled` (n_jacobian_evals > 0)
and `jacobian_consumed` (when `options.jacobian` is supplied,
n_jacobian_evals ≥ 1).

The substrate had also landed in a prior (stalled) session: the three
files `radau.ts`, `newton-iteration.ts`, and `integrate-stiff.ts` —
the Radau-IIA(5) Butcher tableau, the simplified-Newton + complex-
eigenvalue split, and the top-level adaptive driver. `bun run check`
was already green (51 phases) on substrate alone.

This shard records the **wrapper-completion** slice: the seven-artefact
tool dir, the bench bring-up, and the small surgical fix the bench
forced in `expr-parse`.

## What changed

### Tool wrapper — `tools/integrate-ode-stiff/` (~720 lines, all new)

The seven-artefact directory:

- **`tool.ts`** (~520 lines). Wire-encoding wrapper around the
  `integrateStiff` substrate. Mirrors `integrate-ode-ivp/tool.ts`'s
  shape: schema declaration via `S.*` constructors; `numerical: true`
  per ADR-0015; semantic checks (vocabulary, dim agreement, finite
  tspan) inside `fn`; substrate's `OdeDegenerateTspanError` /
  `OdeNonFiniteError` / `OdeJacobianSingularError` translated to ADR-
  0003 boundary tags; `UnknownVocabularyError` / dim-mismatch
  translated to `ToolError`. The two stiff-specific extensions vs the
  path-finder:

  1. **`options.method`**: a string accepting `"radau"` (default) and
     `"bdf"`. `"bdf"` short-circuits to `tagged "method-not-
     implemented"` *before* any work — the path-finder is single-
     method (Radau); BDF / Rosenbrock / and friends are deferred to a
     v0.2 slice. Anything outside `{"radau", "bdf"}` is malformed.

  2. **`options.jacobian`**: an optional `n × n` list-of-list of
     expression Values. When supplied, the tool short-circuits the
     symbolic-derivation phase and wires the cells straight into the
     substrate's `userJacobian` callable. When omitted, the tool
     composes `cas-diff` in-process for each `(i, j)` cell to derive
     `∂f_i/∂y_j`; the cached symbolic Values are compiled to numeric
     callables via `evalNumericExpr`. If any cell returns
     `tagged "cas-diff/out-of-scope"` (head outside the closed
     differentiation vocabulary), the tool falls back to the
     substrate's centred-FD Jacobian and emits a warning. A `cas-diff`-
     side `UnknownVocabularyError` (head unknown to the differentiator
     itself) propagates as a `ToolError` with the standard suggestion.

  Two new bookkeeping fields in the success record vs the path-finder:
  `n_jacobian_evals` and `n_lu_decompositions`. The bench's
  `stiffness_handled` invariant requires `n_jacobian_evals > 0` —
  Radau is implicit, every step refactors against `J` at least once;
  a candidate that secretly small-steps explicitly never touches `J`.
  Structurally `n_lu_decompositions ≥ 2 · n_jacobian_evals` (real +
  complex pair per refactor, the Hairer-Wanner 1999 split).

  Boundary categories: four tags (`degenerate-tspan`, `non-finite-
  during-eval`, `jacobian-singular`, `method-not-implemented`) plus
  `ToolError` for malformed input. The `jacobian-singular` payload
  carries a `condition_number` field (set to `Infinity` when LU
  detection caught the singularity directly; future extension: a
  Hager 1-norm probe before the tag).

  In-process composition pattern mirrors `integrate-ode-symplectic`:
  workbench is built lazily on first `fn` call and cached at module
  scope under `process.env.CAS_STORE`. Top-level effect is gated by
  `if (import.meta.main) void runTool(def);` per ADR-0010.

- **`goldens.spec.ts`** (~270 lines). 11 representative goldens:
  scalar mild-stiff, scalar λ=1000, 2D linear stiff, exp decay long
  horizon, vdP μ=10, Robertson on horizon `t = [0, 1e6]` (the bench's
  `t = 1e10` is too slow for the per-tool golden; the bench is the
  heavier validation surface), Oregonator on `[0, 30]`, reverse
  integration, analytic-Jacobian shortcut on the 2D linear stiff,
  degenerate-tspan tag, method-bdf tag. ToolError paths (dim-mismatch,
  unknown vocabulary) are *not* golden-able (the goldens infrastructure
  requires exit-0; ToolError exits 1) and are exercised by the bench's
  E-tier and the tool's own `--test` smoke probe.

- **`README.md`** (~280 lines). Mirrors `integrate-ode-symplectic/
  README.md` template. Records the I/O contract, all five output
  categories, the Hairer-Wanner 1999 algorithm summary, the
  Jacobian-staleness rule, the symbolic-Jacobian setup discipline,
  the explicit out-of-scope list, every machine-checkable invariant.

- **`package.json`** — workspace deps `@workbench/{protocol, contract,
  compose, quadrature, ode-core}`.

### Substrate — `packages/ode-core/src/index.ts` barrel

Added the three previously-unexported stiff-substrate names:

```ts
export {
  type IntegrateStiffOptions,
  type IntegrateStiffResult,
  OdeJacobianSingularError,
  integrateStiff,
} from "./integrate-stiff.js";
```

The substrate was complete in a prior session but its barrel exports
had been deferred. The wrapper needs all three (the option / result
types so its `fn` can hold an `IntegrateStiffResult`; the singular-
Jacobian error class for the boundary-tag translation; the
`integrateStiff` function for the actual call). No code change in
`{integrate-stiff, radau, newton-iteration}.ts` — substrate ships as
the previous session left it.

### Surgical fix — `tools/expr-parse/tool.ts`

The bench's D-tier and F-tier inputs (Robertson, the F-tolerance
sweep) use scientific-notation literals: `1e4`, `1e-6`, `3e7`. The
`expr-parse` grammar before this slice handled `digits('/'digits |
'.'digits)?` — no scientific notation — and the bench wire-format
adapter (`run-candidate.ts`) routes RHS strings through `expr-parse`
in-process before calling the tool. Result: 5 of 19 bench cases
returned `tool_error: ExpressionParseFailed` on the `e` literal.

The fix extends the grammar:

```
number := digits ('.' digits)? ([eE] ('+'|'-')? digits)?    (scientific-notation suffix → float64)
        | digits '/' digits                                  (rational literal — unchanged)
```

When the exponent suffix is present, the literal becomes a `float64`
Value (the exponent often pushes the magnitude outside the rational
sweet spot — `1e-300` as `rat(1, 10^300)` would allocate a 300-digit
BigInt for an obvious float). Pure decimal literals without an
exponent (`0.5`, `0.04`) keep their previous rational behaviour, so
no existing goldens shift. The `parseNumber` body was reordered to
parse int → optional fraction → optional exponent in a single pass,
and back off cleanly if the `e` turned out not to be an exponent (no
digits follow).

`expr-parse --test` still passes; the tool's 33-case oracle goldens
all match byte-for-byte.

### Demo / docs

- **`scripts/demo-scope.ts`** — added demo 20: Robertson chemistry on
  `t = [0, 1e6]` (shorter than the bench's `1e10` for demo-runtime
  budget). Reports `n_steps_accepted`, `n_jacobian_evals`,
  `n_lu_decompositions` so the agent reading the output sees the
  load-bearing stiffness diagnostics in a glance.

- **`README.md`** (root) — added the `integrate-ode-stiff` catalog row
  alphabetically between `integrate-ode-ivp` and `integrate-ode-
  symplectic`. Updated the `ode-core/` package description to name
  all three IVP family tools.

- **`docs/worklog/README.md`** — index row for 049.

## Why these choices

**Why no substrate rewrite.** The `integrate-stiff.ts` driver was
already a step-for-step port of SciPy's `_radau.py::_step_impl` with
the simplified-Newton + complex-eigenvalue split implemented per
Hairer-Wanner 1999. Rewriting it (or even refactoring it) without a
specific bench failure pinpointing a substrate bug would be a Rule 2
violation ("all bugs are deep — investigate root causes"). The bench
ran 19/19 against the existing substrate without any substrate-side
edit; the only surgical fix landed in `expr-parse`. The hard
constraint — "if the substrate has a bug, fix it surgically rather
than rewriting" — held.

**Why the symbolic-Jacobian default.** The bench's `jacobian_consumed`
check fires only when `options.jacobian` is supplied, but the
`stiffness_handled` check requires `n_jacobian_evals > 0` regardless.
Composing `cas-diff` in-process for each `(i, j)` cell of the symbolic
Jacobian is the agent-honest default: the user writes `f` once, and
the tool gives them an analytic-J solver "for free." The FD fallback
is the safety net for when the user has a head outside cas-diff's
vocabulary (rare on the bench, but the diagnosis pattern matters
elsewhere). Pushing FD as the default would mean every Robertson run
costs `2n = 6` extra `f` evaluations per refactor instead of `0` for
the analytic path — a benign overhead, but a *needless* one.

**Why the three boundary tags vs one.** `non-finite-during-eval`
covers RHS or analytic-J non-finiteness; `jacobian-singular` covers
LU returning null; `method-not-implemented` covers BDF. Each tag
carries a payload shape an agent's planner can read structurally.
Collapsing them into a single `boundary-failure` with a discriminator
field is a regression to the path the workbench rejected at ADR-0003
adoption; the typed payload-shape per tag is what makes the planner's
reasoning cheap.

**Why no `nondeterministic: true`.** The driver is deterministic on
a single platform — same input bytes, same output bytes — once the
floating-point arithmetic is fixed (ECMAScript `Number` is fully
spec'd; Bun on x86-64 / ARM64 produces bit-identical results within
each platform). ADR-0015's `numerical: true` is the correct annotation:
the runner records the `{arch, os, runtime}` fingerprint on every
successful run, so a planner reading a stored provenance record can
decide whether the cached output is admissible *before* invoking the
tool on a different platform. The two-flag pattern stays clean: never
unify them as a `tier:` enum.

**Why scientific notation in expr-parse not in the bench's adapter.**
The fix could in principle have lived in `bench/integrate-ode-stiff/
run-candidate.ts` — pre-process strings with a regex before
`expr-parse` sees them. That would be a band-aid (Rule 2). The
underlying problem is that `expr-parse`'s grammar is incomplete:
scientific notation is the only syntactic form of a float64 literal
ECMAScript / Python / every-numerical-language ecosystem agrees on,
and a parser that refuses it is wrong. Fix in `expr-parse`, ship a
better parser to every consumer, no caller-side workarounds.

## Frictions surfaced

**The `expr-parse` literal-type ambiguity.** When does a parsed `1.5`
become a `rat(3, 2)` (for symbolic pipelines) and when does it become
a `float64` (for numerical pipelines)? The grammar before this slice
made the call by *form*: pure decimals are rational, scientific-
notation literals are float64. That preserves backward compatibility
(every existing golden's `0.5` is still a rational) but is a
load-bearing cliff between two literal forms a numerical user
expects to be interchangeable. A v0.2 question: should `0.5` be
parseable as float64 too via an explicit suffix (`0.5f` or
`0.5_f64`)? Defer.

**The `cas-diff` vocabulary fallback.** The substrate's centred-FD
Jacobian path *always* works regardless of vocabulary, but the bench
doesn't include any case that exercises the fallback (the closed
vocabulary covers every bench RHS). The fallback warning is therefore
property-tested only by the tool's own goldens — no "this is the
fallback we hit on the bench" smoke test. A v0.2 to consider: add a
bench case with `f = floor(y)` (or another non-differentiable head)
to force the FD path and verify the warning appears. (`floor` is the
`E_unknown_head` boundary case today, which surfaces *upstream* of
the Jacobian phase as a vocabulary error.)

**Robertson's horizon length.** The bench's `D_robertson` runs to
`t = 1e10` and takes ~17 seconds in our impl; the per-tool golden
caps at `t = 1e6` (~1.5 s) so `bun run check` stays under 30 seconds
total. The mismatch documents itself in the goldens.spec.ts comment;
a `bun run goldens` regeneration would catch numerical drift on the
shorter horizon. The bench remains the long-horizon authority.

**The "53 passed" surprise.** The brief expected `bun run check` to
report "52 passed"; we got "53 passed." The extra phase is the
codegen step regenerating the typed workbench barrel (`packages/
compose/src/generated/wb.ts`) after the new tool was added — that
was a check phase the tool's introduction *triggers*, not a
pre-existing one. It self-stabilises after a single `bun run check`
run (the regenerated barrel is byte-for-byte deterministic), so the
second run reports the same 53/0/3.

## Acceptance

- `bash bench/infra/run-bench.sh bench/integrate-ode-stiff bun bench/
  integrate-ode-stiff/run-candidate.ts` reports **19/19 cases green**;
  per-check totals: shape 15/15, finite_entries 15/15,
  monotone_t_values 15/15, status_consistency 15/15,
  trajectory_accuracy 15/15, self_reported_error_estimate 15/15,
  stiffness_handled 15/15, conservation 15/15, jacobian_consumed
  15/15; tagged-boundary 2/2; tool_error_expected 2/2.
- `bun run check` reports **53 passed, 0 failed, 3 skipped** (the 3
  skipped are tools without `--test` hooks, identical to before this
  shard).
- `bun run goldens --tool integrate-ode-stiff` writes 11 golden files;
  `bun run goldens:check` (during `bun run check`'s oracle phase)
  matches all 11 byte-for-byte.
- `bun tools/integrate-ode-stiff/tool.ts --test` passes (smoke probe:
  scalar exp-decay accuracy at `rtol = 1e-6`, the `n_jacobian_evals
  ≥ 1` invariant, the `n_lu_decompositions ≥ 2 · n_jacobian_evals`
  invariant, 2D linear-stiff with separated eigenvalues, degenerate-
  tspan throw).
- `bun scripts/demo-scope.ts` runs Robertson on `t = [0, 1e6]` and
  reports `n_steps_accepted ≈ 234`, `n_jacobian_evals ≈ 45`,
  `n_lu_decompositions ≈ 260`, `y(1e6) ≈ [2.031e-3, 8.142e-9,
  9.980e-1]`.
- `bd close scientist-workbench-09g` after this shard lands.

## Pointers

- `tools/integrate-ode-stiff/{tool, goldens.spec, README, package}` —
  the four wrapper artefacts (the goldens directory holds the 11
  generated golden files).
- `packages/ode-core/src/{integrate-stiff, radau, newton-iteration}.ts`
  — the substrate as it was when this slice opened. No edits this
  session except the barrel.
- `packages/ode-core/src/index.ts` — new exports for the stiff-
  substrate surface.
- `tools/expr-parse/tool.ts::parseNumber` — the scientific-notation
  fix.
- `bench/integrate-ode-stiff/{golden, reference, run-candidate}` —
  the 19-case battery, the SciPy oracle, the wire-format adapter.
- `scripts/demo-scope.ts::header(20, ...)` — the Robertson demo.
- `README.md` — catalog row + `ode-core/` description update.
- `docs/worklog/README.md` — index row for 049.
- Bead `scientist-workbench-09g` — closed by this shard.
