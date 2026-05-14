# 116 — cone-core convergenceTest hook: termination denominated in the consumer's residual (bead 0xuk)

**Date:** 2026-05-14
**Bead:** scientist-workbench-oxuk (closes)
**Touches:** `packages/cone-core/src/hsde.ts`, `packages/cone-core/src/scs.ts`,
`packages/cone-core/test/hsde.test.ts`, `packages/cone-core/test/scs.test.ts`,
`packages/cone-core/README.md`, `tools/cone-solve/tool.ts`,
`tools/cone-solve/README.md`, `docs/adr/0030-convex-cone-solver-tier.md`

## Context

Bead `rgl8` (worklog 114) fixed an `achieved_precision` over-claim in
`tools/cone-solve` and, doing so, surfaced a deeper incoherence.
`cone-core`'s `scsSolve` decides the `optimal` status from O'Donoghue
2016's §3.5 termination test — the primal/dual/gap relative residuals of
the *embedded translated* problem, in 2-norm, gap term `cᵀx + bᵀy`. But
`cone-solve`'s `precision` contract is denominated in the **§C-wire-form**
KKT residual of the *recovered §C point* — `max(r_p, r_d, r_c)` in
∞-norm with an `xᵀs` complementary-slackness term, exactly what the
corpus `lp-netlib` verifier recomputes. The two measurements differ by a
per-problem factor (0.59–3.08 across the `lp-netlib` profile — not a
fixed ratio). `rgl8`'s stopgap was a post-hoc coherence guard in the
tool: re-label `optimal → iter-cap` whenever the recovered §C residual
exceeded the request. Honest, but pessimistic — a case that *could*
reach the requested precision with a few more iterations was reported
`iter-cap` purely because `scsSolve` stopped early on a looser proxy.

## What changed

**`cone-core` — an optional convergence-test hook.** `recoverPrimalDual`
and `SCSOpts` gain `convergenceTest?: (candidate: Candidate) => boolean`.
When **absent** — the default; `DEFAULT_SCS_OPTS` does not set it —
`scsSolve` is the paper-faithful standalone substrate, §3.5 unchanged.
When **supplied**, the predicate is the *sole arbiter of the `optimal`
status*: branch 1 of `recoverPrimalDual` consults it instead of the
§3.5 relative-residual inequalities. The infeasible / unbounded
certificate branches are untouched — the hook governs `optimal` only —
and `u_τ ≤ 0` still skips branch 1 entirely, so the hook is never
consulted on a point with no readable primal–dual candidate.

**`tools/cone-solve` — supply the §C convergence test.** The §C-dual
recovery logic (`recoverY` / `recoverSlack`, previously inline closures
in `encodeResult`) is extracted to a module-level `recoverDualSlack`,
shared by `encodeResult` and a new per-iteration `convergenceTest`
closure in `fn`. The closure recovers the §C point from each
`Candidate` and returns `kktResidualC(...) ≤ precision` — so `scsSolve`
is driven to the wire criterion directly. `rgl8`'s coherence-guard
re-label branch in `encodeResult` is **retired**: `scsSolve` now only
returns `optimal` once the §C contract is met, so an `optimal` from the
tool means `optimal` with no asterisk. A new `optimal-precision-
coherence` invariant records the contract; `smokeTest` asserts it
numerically (Rule 7).

## Why these choices

Three fixes were weighed (ADR-0030 addendum has the full argument):

1. **The optional hook on `cone-core`** — chosen.
2. **`cone-core` adopts the ∞-norm + `xᵀs` form so its `optimal` matches
   the wire contract** — *structurally impossible*. `cone-core` only ever
   sees the *translated embedded* problem; it never holds the original
   §C `(A, b, c)`. No change to its residual *form* can make it measure
   a residual of a problem it does not have. The translation folds the
   §C primal residual and the cone-membership residual into one embedded
   vector — genuinely different measurements.
3. **`cone-solve` passes `cone-core` a tighter internal `precision` from
   a per-problem amplification estimate** — a bandaid (CLAUDE.md Rule 2).
   The amplification ratio is the very thing that is unpredictable
   (0.59–3.08); correctness-by-estimate is the "looks like it works"
   anti-pattern.

The hook is the `Array.prototype.sort(comparator)` move: the substrate
owns the iteration machinery, the caller owns the decision criterion.
`cone-core` stays a faithful O'Donoghue port *by default* — the hook is
opt-in, the 99-test substrate suite's semantics are fixed — while the
tool that *owns* a wire contract gets the exact lever it needs. This is
the Two Principles applied: a TS expert hands a solver a stopping
predicate without thinking; the predicate *is* the wire contract, so
there is no proxy to be incoherent with.

## Frictions surfaced

- **The iteration-daylight test needed a non-trivial problem.** The
  first cut of "a looser hook stops earlier than §3.5" ran on `min x
  s.t. x ≥ 1` — which converges in 4 iterations flat, leaving no
  daylight between a loose and a tight criterion. Switched to a 2-var
  LP with acceleration off (`andersonMemory: 0`): the plain SCS tail is
  ≈96 iterations to §3.5 versus ≈9 to a `1e-1` gap test — unambiguous.
- **`cone-core`'s `achievedPrecision` semantics had to be pinned, not
  changed.** With a hook deciding `optimal`, `SCSResult.achievedPrecision`
  could be cone-core's embedded residual even when that exceeds the
  caller's threshold (the hook used a different measure). Rather than
  couple `cone-core` to "the caller's number" (which it does not have),
  `achievedPrecision` keeps one fixed meaning — the §3.5 embedded
  residual — documented as such; `cone-solve` recomputes its own
  §C-wire-form figure for the §D output, exactly as it already did.

## Acceptance

- `convergenceTest` hook implemented in `recoverPrimalDual` + `SCSOpts`;
  default-absent leaves the paper-faithful path bit-identical.
- `cone-core`: 99 tests pass (was 90) — new `recoverPrimalDual —
  convergenceTest hook` block (5 tests: false-hook withholds `optimal`,
  true-hook grants it, the `Candidate` is threaded in, `u_τ ≤ 0` skips
  the hook, certificate branches untouched) and `scsSolve —
  convergenceTest hook` block (3 tests: a never-accept hook forces
  `iter-cap`, a sane residual hook reaches `optimal`, a looser hook
  terminates strictly earlier) plus a non-function-hook guard.
- **Mutation-proven** — two perturbations of the hook decision in
  `recoverPrimalDual`, each confirmed RED then restored: hook ignored
  (`false && convergenceTest !== undefined` → 4 fail) and hook inverted
  (`!convergenceTest(candidate)` → 5 fail).
- `tools/cone-solve`: `--test` passes (new `optimal-precision-coherence`
  assertion); 14 goldens unchanged (`generate-goldens --check` clean —
  the small hand-built problems converge identically; the embedded/§C
  gap only bites near-threshold, which is the netlib-scale story).
- **The bead's acceptance metric — profiler optimal-rate climbs.**
  `bench/cone-solve/profile-lp-netlib.ts --only=afiro,sc50a,sc50b,blend,
  scsd1`: **3/5 → 5/5 optimal**. `blend` (was `iter-cap`, §C residual
  1.55e-6) driven ~800 extra iterations to `optimal` at 9.72e-7;
  `scsd1` (was `iter-cap`, 2.88e-6) reached `optimal` in 12 more
  iterations at 8.00e-7 — it sat right at the threshold, the embedded
  test had fired slightly early. afiro/sc50a/sc50b stay `optimal`,
  terminating a touch earlier (their §C test is the easier one).
  `over-claimed-precision 0`, `wrong-status 0`.
- Full `bun run check` — green (see commit).

## Pointers

- `docs/adr/0030-convex-cone-solver-tier.md` — addendum (2026-05-14)
  documenting the hook and the three weighed options.
- `docs/worklog/114-cone-solve-bench-reconciliation.md` — `rgl8`, the
  over-claim fix that surfaced this; its coherence guard was the stopgap
  this bead retires.
- `packages/cone-core/src/scs.ts` `SCSOpts.convergenceTest` /
  `hsde.ts` `recoverPrimalDual` — the hook.
- `tools/cone-solve/tool.ts` `recoverDualSlack` + the `convergenceTest`
  closure in `fn` — the §C-wire-form predicate.
