# 153 — `bigBesselJ` real (BigFloat): Phase 2 / I1a entry point

**Date:** 2026-05-17
**Bead:** `scientist-workbench-5zkv` (I1a — bigBesselJ real BigFloat)
**Related ADR:** `docs/adr/0041-bessel-family-per-head-substrate.md`
(§"Decision 3"); inherits the determinism contract of ADR-0020
(arb-prec tier — bit-identical cross-platform forever given `prec`).
**Phase 2 status after this shard:** I1a closed. I1b (`bigBesselY` —
bead `1doz`, joint with J per the FLINT pattern) now has the
substrate primitives to hoist on top of, and the broader Round-2
substrate is one bead from done.

## Context

ADR-0041 pins the per-head substrate for the canonical Bessel family
(J, Y, I, K) as the second instantiation of the pattern ADR-0040
established with Erf. Phase 1 shipped the gold-tier oracle harness
(Wolfram + mpmath + Arb + Boost + SciPy, agreement matrix in
`bench/besselj-anchor/agreement-matrix.md`, 0 unexplained findings
across 17 660 pair-wise comparisons). Phase 2 substrate Round 1
(I6-prep `argsInverse` rename, I6a vocab admission, I6b pattern
primitives, I5a float64 dispatcher) landed. This shard is Round 2
— the arb-prec real-axis lane.

R2's load-bearing finding: Bessel's Hankel asymptotic terms shrink as
`1/(8|z|)` per step, not Erf's `1/(2z²)`. The crossover
`z_c_Hankel(p) = p/2` (FLINT-conservative factor-2 form from
`bessel_j.c:592`) is therefore *linear* in precision, not square-root.
At p = 200 bits, `z_c_Hankel ≈ 100` vs Erf's `x_c ≈ 11.8`. Bessel
needs an order of magnitude larger |z| to enter the asymptotic
regime; the transition band 8 ≤ |z| ≤ p/2 is much wider and is where
the cancellation-retry pattern actually fires.

The alternating Maclaurin (DLMF 10.2.2) cancels with peak-term-to-
answer ratio `≈ exp(|z|) · √(1/(2π|z|))` (Stirling) — at z = 50, ~72
bits destroyed; at z = 100, ~145 bits. The cancellation-retry pattern
(mirroring `clgammaReflect` worklog 117 bead `oj5j` and `bigErfc` Erf
I1 worklog 131) sizes the *first-pass* working precision with FLINT's
analytic `|z| · log₂ e` estimate, then measures the empirical loss
post-hoc and re-runs at `prec + 32 + L_measured + 16` if the analytic
estimate fell short. One bump suffices structurally.

## What changed

- **NEW**  `packages/bigfloat/src/special-funcs/besselj.ts` (842 lines).
  - ~150-line literate top-of-file algorithm narrative covering: the
    FLINT-aligned three-piece dispatch, the linear-in-precision Hankel
    crossover (vs Erf's square-root), the alternating-Maclaurin
    cancellation budget, the Hankel `P/Q` form with Boost's angle-
    addition phase trick (avoiding large-`ω` mod-2π reduction), the
    optimal-truncation idiom (cross-ref `lgammaStirling`
    `packages/bigfloat/src/special.ts:117`), and the cancellation-
    driven precision retry pattern.
  - `bigBesselJ(nu, z, prec)` — the entry point. Throws `RangeError`
    on malformed input, on `J_ν(0)` for non-integer negative ν, and
    on real-negative z with non-integer ν (deferred to I3a complex
    branch).
  - `bigBesselJSeriesMaclaurin(nu, z, prec)` — package-public
    substrate primitive (₀F₁ Maclaurin direct, DLMF 10.2.2). Single-
    step recurrence `T_{k+1} = T_k · (-z²/4) / ((k+1) · (ν+k+1))`.
    No cancellation accounting; for cancellation safety, callers use
    the retry wrapper.
  - `bigBesselJHankelAsymptotic(nu, z, prec)` — package-public
    substrate primitive (DLMF 10.17.5-6 with smallest-term truncation
    per Olver 1974 Theorem 3.1). `P`/`Q` accumulators alternating
    every other recurrence step; `sin/cos(ω)` via the addition
    formula on `sin(z), cos(z), sin(φ), cos(φ)` with `φ = νπ/2 + π/4`.
  - `bigBesselJSeriesCancellationRetry(nu, z, prec)` — package-public
    cancellation-retry harness around the Maclaurin. FLINT-pattern
    measure-and-bump; first-pass at `prec + 32 + cancelEst`, retry
    at `prec + 32 + L_measured + 16` if `L_measured > cancelEst + 16`.
  - Internal `besselJMaclaurinWithLossTracking` (returns `{ value,
    lossBits }`) keeps the retry encapsulated without forcing the
    public Maclaurin to track loss it doesn't use.
  - Internal `powerReal` helper for `(z/2)^ν` — defers to
    `transcendental.pow` to pick up its integer fast-path; only
    exists to document the call site's intent.
- **EDIT** `packages/bigfloat/src/index.ts` — re-export `bigBesselJ`
  plus the three substrate primitives. The primitives are exported
  (not kept package-internal as Erf I1 did) because I1b's `bigBesselY`
  joint-substrate per the FLINT pattern needs them in a sister
  module, and the I3a complex path will rotate through them via
  `J_ν(z) = exp(±νπi/2) · I_ν(∓iz)` (Decision 11).
- **NEW**  `packages/bigfloat/test/special-funcs/besselj.test.ts`
  (29 tests, 57 `expect()` calls):
  - **Closed-form special values** (6): `J_0(0) = 1`, `J_n(0) = 0`
    for n ∈ {1, 2, 3}, `J_{1/2}(0) = 0`, `J_0(2π) ≈ 0.220`.
  - **Parity** (3): `J_0(-1) = J_0(1)`, `J_1(-1) = -J_1(1)`,
    `J_{-3}(2) = -J_3(2)` (integer-ν reflection).
  - **Golden masters vs Arb gold tier** (12): T1-001 (ν=0,
    z=0.001), T1-005 (ν=0, z≈π — negative answer), T1-013 (ν=1,
    z=1), T1-022 (ν=2, z=1), T1-058 (ν=1/2, z=1 — half-integer),
    T1-094 (ν=1.7, z=1 — decimal ν), T2-001 (ν=0, z=8.5 — boundary),
    T2-003 (ν=0, z=20 — cancellation territory), T2-005 (ν=0, z=50
    — deep cancellation), T3-001 (ν=0, z=61 — Hankel asymptotic),
    T3-010 (ν=1, z=150 — deep Hankel), T7-001 (ν=50, z=25 — large-ν
    Maclaurin via `ν > z²/4` short-circuit). ≥ 48 dp agreement
    against Arb's 55 dp emit on every input.
  - **Cancellation-retry** (4): `J_0(50)` at prec ∈ {53, 100, 200},
    `J_0(100)` at prec = 200; each compares prec to prec+200 cross-
    precision agreement to ≥ floor(prec × 0.301 − 2) dp.
  - **Primitive isolation** (4): each of the three substrate
    primitives directly invoked in its dispatcher band, agreeing
    with the public entry point byte-identically. Plus an asymptotic-
    on-non-positive-z error-path test.

## Why these choices

### Three primitives, parallel to the Erf shape

The R2 dispatch table (§3.1) explicitly identifies three distinct
algorithms: ₀F₁ Maclaurin (small `|z|`), Hankel asymptotic (large
`|z|`), and Maclaurin-with-cancellation-retry (transition band).
Each gets its own primitive — mirror of Erf's `bigErfSeries` /
`bigErfcAsymptotic` / `bigErfcContinuedFraction`. The retry wrapper
*is* the third primitive (not a wrapper over the first); the
first-primitive `bigBesselJSeriesMaclaurin` is the raw form, used
when the dispatcher has already proven cancellation is not a
concern (via the FLINT `ν > z²/4` short-circuit, or `|z| < 8`).

### `argsInverse` is the bridge's concern, not this module's

The bridge-API rename (`zInverse → argsInverse`, ADR-0041 §Decision 5
via bead I6-prep `qt6m`) lands in `packages/meijer-core/`. This module
honours the per-axis package split exactly: `bigfloat` is the
arb-prec axis, nothing about the Meijer-G bridge or the cas-core
identity layer leaks in.

### Public substrate primitives (vs Erf I1's package-internal stance)

Erf I1 kept its three substrate primitives package-internal because
the public API was a single entry point `bigErf`. Bessel I1a is
different: I1b (`bigBesselY`) ships next, joint with J per the FLINT
pattern (`bessel_y.c:36-80` uses J as a building block); I3a complex
J rotates through I via Amos; the substrate primitives are
genuinely shared. Re-exporting them now avoids a churn-cycle when
I1b lands.

### Boost angle-addition trick for the Hankel phase

`ω = z − νπ/2 − π/4` is itself large for large z. The naive recipe
"compute ω, then `sin(ω), cos(ω)` via mod-2π reduction" loses
`log₂(|z|)` bits to the mod-reduction. The addition formula

```
cos(ω) = cos(z) · cos(φ) + sin(z) · sin(φ)
sin(ω) = sin(z) · cos(φ) − cos(z) · sin(φ)
```

with `φ = νπ/2 + π/4` keeps the only mod-2π reduction on `sin(z)`
and `cos(z)` — the workbench's `transcendental.sin/cos` handles
that with full working precision. For moderate ν (≤ work / 2
bits worth), `φ` is small and the φ-side trig is clean. Boost
`bessel_jy_asym.hpp:99-127` uses the same pattern.

## Frictions surfaced

1. **Mutation-proving M1 (asymptotic crossover) initially passed
   under both correct and mutated values** — flipping `p/2` to `p`
   doesn't break the test suite because the cancellation-retry path
   handles the now-wider transition band correctly. The mutation
   that actually catches the regression is `p/2 → 5` (route to
   asymptotic too aggressively), which fails 5 tests because at
   z = 20 the asymptotic does not converge to prec bits. The
   weaker mutation form (flip to `p`) is not a load-bearing
   regression precisely because the substrate has structural
   redundancy in the transition band — both paths converge there.

2. **Mutation-proving M2 (disable cancellation-retry bump) also
   passes initially**, because the *first-pass* working precision
   already includes the analytic `cancelEst = |z| · log₂ e` budget.
   The mutation that actually catches loss-of-cancellation handling
   is `prec + 32 + cancelEst → prec + 32` AND disabling the retry.
   Then 5 tests fail at the cancellation-retry-cross-precision
   tests. This pins that *one* of {first-pass budget, retry bump}
   must be present — both being absent destroys the prec budget.

3. **`git stash` interaction with the orchestrator's auto-commit
   path** caused a moment of confusion mid-development: stashing
   to verify "is this failure pre-existing?" and popping back
   resulted in the orchestrator committing the un-stashed work to
   `a6327a4` (the broader Round-2 commit). The pop succeeded; the
   file is on disk and committed; no work was lost. Lesson: in a
   subagent thread with active auto-commit, stash/pop is *not*
   the right way to A/B test against `HEAD`.

4. **The pre-existing failing test `tools/integrate-1d/tool.test.ts`
   "∫ BesselJ(0, x) dx — head outside the admitted vocabulary"** is
   broken by Phase-2-Round-1's vocab admission of BesselJ (I6a bead
   `vsvl`); the test was rotated to `WhittakerM` in source but the
   bead description in the failure output is stale. Not this bead's
   concern; T1 (`integrate-1d` Bessel admission) will resolve.

## Acceptance

- `besselj.ts` on disk (842 LOC).
- Test file (29 tests, 57 expects) green: `bun test
  packages/bigfloat/test/special-funcs/besselj.test.ts`.
- Full `bun test packages/bigfloat/` green (762 / 762 passing).
- Golden masters byte-identical to Arb:
  `bigBesselJ(50, 25, 200)` returns
  `9.756159428022981530865670519464567322140467804367045583e-12`
  matching `bench/besselj-anchor/oracles/arb/results.json`
  T7-besselj-001 byte-for-byte at 55 dp.
- Mutation-proving (M1', M2', M3) each catches the targeted
  regression as documented above.
- `bun run check:quick` green on the bigfloat axis (the single
  workspace failure is pre-existing and unrelated; verified via
  `git stash`).

## Pointers

- ADR-0041 `docs/adr/0041-bessel-family-per-head-substrate.md`
  §"Decision 3" (per-head signature), §"Decision 10" (Round-2
  ordering), §"Decision 12" (zero-crossing tolerance, deferred to
  cross-agreement comparator).
- R2 `docs/refs/besselj-research/R2-arbprec-algorithms.md` §3.1
  (BesselJ dispatch table), §2.1 (Maclaurin), §2.2 (Hankel).
- FLINT source `docs/refs/besselj-research/sources/arbprec/bessel_j.c`
  (esp. lines 480-595 — the dispatch we port).
- Styling exemplar `packages/bigfloat/src/special-funcs/erf.ts`
  (Erf I1 — same three-primitive shape, different algorithm).
- Cancellation-retry exemplars: `clgammaReflect` (worklog 117,
  bead `oj5j`), `bigErfc` (Erf I1 worklog 131).
- Sister beads in Round 2: `1doz` (I1b — bigBesselY, joint with J),
  `kml3` (I2a — bigBesselI), `q0wr` (I2b — bigBesselK).
