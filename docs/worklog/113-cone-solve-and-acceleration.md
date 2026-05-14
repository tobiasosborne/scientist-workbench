# 113 — tools/cone-solve, §5 scaling, and Anderson acceleration (2026-05-14)

> **Scope.** Build `tools/cone-solve` over the `cone-core` substrate
> (bead `2ivi`); grade it against the `lp-netlib` corpus; and — when
> grading exposed SCS's slow-tail convergence — add O'Donoghue §5 data
> scaling and Type-II Anderson acceleration (ADR-0036, bead `k9mm`) to
> `cone-core`. The headline of this shard is a **finding**: a pure-SCS
> universal cone-solver, even correctly accelerated, cannot pass a
> `1e-8` (or even `1e-6`) NETLIB verifier in tractable iterations on the
> small/medium tier — that is the algorithm class, and it is what the
> LP *specialist* exists for (ADR-0030 §B).

## Context

`cone-core` v0.1 (worklog 112) shipped the LP-complete SCS substrate.
`tools/cone-solve` is the universal-primary tool that wraps it — the
ADR-0030 §C/§D wire, the §C→O'Donoghue translation, the §C recovery.
The plan: build the tool, grade it `21/21` on `lp-netlib` per the
worklog-089 onramp, close `2ivi`.

## What changed

**`tools/cone-solve`** (seven artefacts). Reuses the `lp-solve` §C/§D
wire shape verbatim. `decodeInput` checks finiteness + dimension
consistency (schema-uncatchable) and returns `degenerate-shape` /
`non-finite-input` refusals. `parseCones` accepts the LP-complete subset
(`NonNegCone` / `ZeroCone` / `FreeCone`), refuses `SOCone` / `PSDCone` /
`ExpCone` / `PowCone` with `unsupported-cone` naming the cone-core
sub-beads, refuses `minimize.Q` with `quadratic-objective`. `translate`
builds the O'Donoghue-form `ConeProblem` — `A' = [A ; S]` (S the −eⱼ
selection matrix), `cones' = [zero(m), …𝒦]` — and the `coneRowOfVar` map.
`encodeResult` recovers the §C point (`x = x'`, `y = −y'_eq`,
`slack = y'_cone` re-indexed) and emits the §D record; the five status
classes are all the record, only malformed input is a tagged envelope
(worklog 089 "status is honest"). 14 goldens, `--test` hook, README.

**`cone-core` — `conditionEstimate`** on `SCSResult` (Hager 1-norm
estimate of the subspace matrix `M`, computed once from the cached LU) —
so the §D `condition_estimate` field is honest, not a placeholder.
Dogfooding `cone-solve` revealed the need.

**`cone-core/scaling.ts`** — Ruiz data equilibration (O'Donoghue §5,
the §5 un-deferral worklog 112 anticipated). `equilibrate` computes
diagonals `D, E` driving the rows/columns of `D A E` toward unit
∞-norm; `applyScaling` builds the rescaled problem. `scsSolve` iterates
on the *scaled* embedding; `recoverPrimalDual` gains a `scaling`
parameter and unscales the iterate back to the *original* coordinates
before the §3.5 test runs — the paper's "Scaled Termination Criteria".

**`cone-core/anderson.ts` + ADR-0036** — Type-II Anderson acceleration.
A generic windowed-least-squares extrapolator for any `Float64Array`
fixed-point map: `makeAnderson(memory).next(z, Gz)`. `scs.ts` extracts
one SCS iteration as the map `φ` on `z = [u; v]` and the loop becomes
`Gz = scsStep(z); z = aa.next(z, Gz)`. On by default
(`SCSOpts.andersonMemory = 10`; `0` recovers the exact plain trajectory).
Ground truth `docs/ground-truth/convex/anderson-acceleration.md`,
transcribed from Zhang-O'Donoghue-Boyd 2018 / Walker-Ni 2011.

## Why these choices

**`SCSResult` is a discriminated union, the wire record is flat.** The
substrate return is keyed on `status` so the *type* forbids reading an
`objective` off an `infeasible` result; `cone-solve` flattens it to the
ADR-0030 §D record at the wire. The "irresistible to a TS expert" read
of the honest-status requirement.

**AA-II, not the paper's headline Type-I.** Type-I (a multi-secant
Jacobian estimate) needs the paper's Powell-type regularisation +
Gram-Schmidt restart globalisation to be stable. AA-II is the robust
classical method — one tall-skinny least-squares, no Jacobian estimate,
a light safeguard. ADR-0036 §A. Type-I is the documented v0.2 move.

**The accelerator is generic over the fixed-point map.** `makeAnderson`
knows nothing about SCS — it accelerates any `Float64Array` iteration.
That made it *testable in isolation* against known contractions, which
is exactly how the ridge bug below was caught and the speedup proven.

## Frictions surfaced

This shard is mostly friction. Three findings, in order of discovery.

**1. Plain SCS does not converge on NETLIB in tractable time.** The
first grade run: `0/21`, every case `status_consistency` fail — all
`iter-cap`. Measured iterations to reach the verifier's `1e-8`:
`afiro` (51×27) ~2 960, `adlittle` (138×56) **~117 000**, `forplan` /
`scsd1` not reached in 240 s. This is *exactly* the slow tail
convergence O'Donoghue 2016 §1 warns about — the implementation is
faithful, the algorithm is just modest-accuracy. Scaling (lever 1) was
necessary but moved the needle only slightly.

**2. The bench gate contradicts ADR-0030 §B.** The `lp-netlib` verifier
hard-requires `1e-8` KKT residuals. ADR-0030 §B states `cone-solve`'s
accuracy ceiling is `1e-6`. Worklog 089's "`cone-solve` 21/21" onramp
target conflated the universal solver with the LP *specialist* —
`tools/lp-solve` already exists and *is* the `1e-8` NETLIB gate (its
exact-rational simplex / Mehrotra IPM lanes reach `ε_machine`). The
universal SCS solver is the `1e-6` path by design.

**3. Anderson acceleration is correct — and a ridge bug nearly hid it.**
The first AA-wired grade: `afiro` 2 962→2 387, `adlittle`
117 388→113 547 — a ~20% improvement, nowhere near the order-of-magnitude
AA should give. Sanity-checking `makeAnderson` *in isolation* on a slow
scalar contraction (φ(x)=0.99x+0.01): plain 2 292 iters → **AA 4 iters**;
a 2-D two-mode linear map: 23 015 → **8**. So the accelerator was
correct; the gating was wrong. The bug: the Tikhonov ridge was
`λ = 1e-10·max(1, trace(RᵀR)/m_k)` — the `max(1, …)` absolute floor
*swamps the signal* deep in SCS's slow tail, where `trace(RᵀR)/m_k` is
`~1e-12`. Fix: a strictly *proportional* ridge `λ = 1e-10·trace(RᵀR)/m_k`,
no floor. After the fix: `afiro` 2 962→1 805, `sc50a` reaches `1e-6` in
~37 565, `adlittle` still ~105 000.

**The load-bearing lesson.** Even with a correct, ridge-fixed AA-II,
`cone-solve` does not reach the NETLIB verifier tolerance on the
small/medium tier in tractable iterations — *not at `1e-8`, and not even
at the `1e-6` ADR-0030 ceiling* (`adlittle` and `brandy` `iter-cap` at
`1e-6` after 50 000 iterations). AA-II crushes *smooth/linear* maps but
the SCS map is **nonsmooth** (the cone projection has kinks) — which is
the entire reason the Zhang-O'Donoghue-Boyd paper's contribution is
Type-I + Powell globalisation *for the nonsmooth case*. AA-II is the
right v0.1 thing to have built (correct, mutation-proven, a genuine
improvement, the foundation Type-I extends), but it does not on its own
make a pure-SCS universal solver bench-competitive with an interior-point
method. That is structural, and it is what ADR-0030 §B's specialist tier
is *for*.

## Acceptance

- `bun run typecheck` — clean across the workspace.
- `bun test packages/cone-core/` — **72 pass** (62 + 10 new
  `anderson.test.ts`), 0 fail. AA tests **mutation-proven**: the update
  sign-flip → 4 fails, a dropped residual-difference column → 2 fails;
  restored → 72 pass.
- `cone-solve --test` passes; 14 goldens regenerated post-AA.
- `cone-core` is **correct end-to-end**: on `afiro`, `cone-solve`
  returns `status: "optimal"`, `objective −464.7531425…` (the
  Gurobi/Mosek consensus is `−464.7531428573`), `achieved_precision`
  honestly reported.
- The accelerator is **proven correct in isolation** — 2 292→4 and
  23 015→8 iteration collapses on known contractions.
- `bun run check` — full gate green.

**Not met:** the worklog-089 `cone-solve 21/21 lp-netlib` gate. The
bench reconciliation — re-profile the verifier to `1e-6` for the
universal tool, accept a partial gate, or invest in Type-I + Powell
globalisation — is an open project-direction question surfaced for the
user. `2ivi` stays in progress pending that call; `k9mm` (the AA
implementation) is complete.

## Pointers

- Beads: `2ivi` (`tools/cone-solve`, in progress — bench reconciliation
  open); `k9mm` (Anderson acceleration — complete).
- ADR-0036 (`docs/adr/0036-anderson-acceleration-cone-tier.md`).
- Ground truth: `docs/ground-truth/convex/anderson-acceleration.md`,
  `docs/ground-truth/convex/scs-algorithm.md`.
- worklog 112 (`cone-core` v0.1 substrate), worklog 089 (the LP-bench
  onramp whose `21/21` target this shard re-examines).
- `packages/cone-core/src/{scaling,anderson}.ts`,
  `packages/cone-core/test/anderson.test.ts`, `tools/cone-solve/`.
