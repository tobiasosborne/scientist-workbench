# 114 — cone-solve bench reconciliation: the universal-tier discipline (2026-05-14)

> **Scope.** Resolve the open project-direction question worklog 113
> left on bead `2ivi` (`tools/cone-solve`): a pure-SCS universal solver
> cannot pass the `lp-netlib` `1e-8` verifier in tractable iterations.
> The resolution is ADR-0037 — `lp-netlib` is the *LP specialist's*
> gate, `cone-solve` v0.1 is gated by its seven-artefact contract, and
> its relationship to `lp-netlib` is a tracked `1e-6` *profile*. Build
> the profiler that makes that real. The headline of this shard is a
> **finding the profiler forced**: building the honest profiler caught
> a real Rule-8 `achieved_precision` over-claim in `cone-solve` (bead
> `rgl8`), and fixing that surfaced a deeper termination-criterion
> incoherence (bead `oxuk`). `2ivi` closes — but only after the tool
> was made genuinely honest, not before.

## Context

Worklog 113 shipped `tools/cone-solve` correct but left `2ivi`
*in progress*: graded against the corpus `lp-netlib` suite it scored
`0/21`, and the shard framed that as an open question with three
options ("re-profile the verifier to 1e-6, accept a partial gate, or
invest in Type-I + Powell globalisation").

Reading the ground truth — ADR-0030 §B, the corpus `manifest.toml` +
`verifier_protocol.md` + `run-candidate.ts`, worklog 089 — showed the
framing conflated three things (ADR-0037 §Context lays them out): a
**recording error** (worklog 089 invented a "`cone-solve` 21/21
`lp-netlib`" target that handed the *universal* tool the *specialist's*
1e-8 gate; the corpus `run-candidate.ts` itself defaults
`CANDIDATE_TOOL=lp-solve`), an **algorithm limitation already known**
(ADR-0036 §A — AA-II collapses smooth tails, the SCS map is nonsmooth),
and the **genuine question** (what *is* `cone-solve`'s v0.1 gate). The
position — taken, not escalated, per the two principles — is ADR-0037.

## What changed

**ADR-0037 — universal-tier bench discipline.** Decisions A–E:
`lp-netlib` / `lp-small` are `lp-solve`'s gates, unchanged; `cone-solve`
v0.1 is gated by its seven-artefact contract like every other tool; the
`lp-netlib`-at-`1e-6` profile is a tracked health metric, not a release
bar; the `max_iter` default is corrected; Type-I + Powell is filed as
the v0.2 lever (bead `1s32`). It *extends* ADR-0036's reasoning rather
than overriding it — ADR-0036 rightly rejected "lower the verifier bar"
as a primary fix; ADR-0037 observes `cone-solve` was never in that
verifier's jurisdiction.

**`bench/cone-solve/profile-lp-netlib.ts`** — the universal-tier
profiler, the durable artefact of the reconciliation. It runs the 21
`lp-netlib` problems through `cone-solve` at the tool's own `1e-6`
contract, reusing the corpus bridge verbatim (byte-identical wire path
to the graded path), and scores by the honest-scope contract: an
optimal-rate *metric* plus two *zero-tolerance* honesty checks —
`wrong-status` and `over-claimed-precision`. The second independently
recomputes the three §C-wire-form KKT residuals from the candidate's
returned `(x, dual, slack)` — the Rule-8 lie detector.

**`tools/cone-solve` — bug `rgl8` fixed.** The profiler caught a real
over-claim (Frictions, below). `encodeResult` now recomputes
`achieved_precision` as the §C-wire-form `max(r_p, r_d, r_c)` of the
*recovered* point (`kktResidualC`), not `cone-core`'s embedded-form
residual; `iter-cap` emits the field too; a coherence guard re-labels
`optimal → iter-cap` when the honest §C residual exceeds `precision`;
and `smokeTest` gained a *real* `honest-precision` check (it had been
declared `machine_checkable` but never exercised — Rule 7). Six goldens
regenerated (the `achieved_precision` bits of the optimal cases).

**`max_iter` default `2500 → 50000`** (`DEFAULT_SCS_OPTS`, `cone-core`
`scs.ts`; ADR-0037 §D, superseding ADR-0030 §A.1). The profile's
genuine optima need a budget this size (`sc50a` 37565 iterations); the
old `2500` capped solvable problems. Zero test or golden churn — verified.

## Why these choices

**The profiler scores honesty pass/fail, optimal-rate as a metric.**
The mistake worklog 089 made was freezing a *rate* as a release bar.
A universal first-order solver's optimal-rate *moves* (it climbs with
`1s32`); freezing any N either blocks a correct tool or rubber-stamps
regressions. So the profiler's exit code gates on the two honesty
checks only — a `wrong-status` or `over-claimed-precision` is a Rule-8
bug, full stop — and reports the optimal-rate as a tracked number.

**`achieved_precision` is measured on what the tool returns, the way
the consumer measures it.** The `rgl8` fix lives in the *tool* layer,
not `cone-core`: `cone-core` honestly describes *its* O'Donoghue
embedded form; the §C-wire-form residual of the recovered point is a
wire concern, and wire concerns live in the tool (worklog 112's
discipline). `kktResidualC` is the verifier's checks 4/6/7 verbatim, so
the honest-scope contract holds *by construction*.

**The coherence guard re-labels rather than lies.** Once
`achieved_precision` was honest, `status: optimal` with
`achieved_precision > precision` became visible — incoherent. A TS
expert wants `optimal ⟹ achieved_precision ≤ precision` with no
asterisk. The guard makes that hold. It is not a lie-shuffle: the
re-labelled result is a best-effort iterate with an honest residual
worse than requested — *exactly* the `iter-cap` contract.

## Frictions surfaced

This shard is mostly friction — the good kind: the profiler did its job.

**1. The first profiler check was wrong, and cried wolf.** The initial
`over-claimed-precision` check compared the objective to the oracle
consensus — and false-flagged `blend` (`achieved_precision` 9.8e-7,
objective 3.3e-6 from the oracle). That conflated the KKT residual the
tool reports with the objective's distance to the optimum; a ~1e-6 KKT
residual *consistently* yields a few×1e-6 objective error for a
first-order method. Fixed: the profiler recomputes the *actual* §C KKT
residuals — and *that* is what caught the real bug.

**2. The real over-claim — `scsd1`, bead `rgl8`.** With the corrected
check, `scsd1` showed `achieved_precision = 9.35e-7` while the true
§C-wire-form residual was `2.88e-6` — a ~3× under-claim, the exact
Rule-8 lie. Root cause (deep, per Rule 2): `cone-solve` forwarded
`cone-core`'s `achievedPrecision`, the O'Donoghue §3.5 residual of the
*internal embedded translated* problem in 2-norm — gap-based, with no
`xᵀs` term and a denominator ~2× the verifier's. The §C-form residual
of the *recovered* point is a different, larger number. And the
`honest-precision` invariant was declared `machine_checkable` but
`smokeTest` never checked it — so it sailed through.

**3. Fixing `rgl8` surfaced `oxuk`.** With `achieved_precision` honest,
`scsd1` and `blend` showed `status: optimal` alongside an
`achieved_precision` (2.88e-6, 1.55e-6) *worse than the 1e-6 request*:
`cone-core`'s embedded-form §3.5 termination test is *looser* than the
§C-wire-form precision contract. The embedded→§C amplification measured
across the profile ranges 0.59–3.08 — not a fixed factor, so a "solve
to `precision / SAFETY`" guess is not robust. The stopgap (the `rgl8`
coherence guard) re-labels; the proper fix — a termination test
denominated in the consumer-form residual — is `oxuk`, a real
`cone-core` design change that needs its own treatment, not a rush job
inside `rgl8`. Honest first (`rgl8`), better next (`oxuk` and `1s32`).

## Acceptance

- `bun run check` — full gate green: 95 passed, 7 skipped, 0 failed.
  `cone-solve` oracle 14/14 (the six regenerated optimal goldens
  included).
- `cone-solve --test` passes, now *including* a real numerical
  `honest-precision` recomputation+assertion.
- The profiler is **self-mutation-proof at scale**: it caught `rgl8`
  pre-fix (`over-claimed-precision 1 ✗ scsd1`) and reads `0 ✓` post-fix
  — revert the `kktResidualC` recompute and it goes RED again.
- Honest `lp-netlib` profile, fixed tool, `precision=1e-6`,
  `max_iter=50000` (`claimed_prec` is the tool's `achieved_precision`;
  `recomp_kkt` is the profiler's independent §C recomputation — equal
  everywhere both exist; `—` is the honest "no recoverable iterate,
  τ never positive" case):

```
case       m    n    status     iters  claimed_prec  recomp_kkt   sec
---------- ---- ---- ---------- ------ ------------- ------------ -----
afiro      27   51   optimal      1711      5.48e-7      5.48e-7    0.5
sc50b      50   78   optimal     21259      6.40e-7      6.40e-7    2.9
sc50a      50   78   optimal     37565      8.39e-7      8.39e-7    4.8
scsd1      77  760   iter-cap     1588      2.88e-6      2.88e-6   13.4   ← re-labelled (rgl8 guard)
blend      74  114   iter-cap     5824      1.55e-6      1.55e-6    2.3   ← re-labelled (rgl8 guard)
adlittle   56  138   iter-cap    50000      1.06e-5      1.06e-5   15.3
bore3d    245  346   iter-cap    50000      7.60e-5      7.60e-5  116.9
recipe    186  299   iter-cap    50000      5.02e-4      5.02e-4   56.9
share2b    96  162   iter-cap    50000      9.56e-4      9.56e-4   19.5
kb2        52   77   iter-cap    50000      1.25e-3      1.25e-3    6.3
beaconfd  173  295   iter-cap    50000      1.44e-3      1.44e-3   83.9
sc205     205  317   iter-cap    50000      1.82e-3      1.82e-3   70.0
stocfor1  117  165   iter-cap    50000      2.81e-4      2.81e-4   21.4
sc105     105  163   iter-cap    50000      1.74e-2      1.74e-2   20.2
brandy    220  303   iter-cap    50000      1.62e-2      1.62e-2   86.1
boeing2   239  378   iter-cap    50000            —            —  136.0
forplan   183  514   iter-cap    50000            —            —  175.0
israel    174  316   iter-cap    50000            —            —   57.2
lotfi     153  366   iter-cap    50000            —            —   60.3
scagr7    129  185   iter-cap    50000            —            —   21.4
share1b   117  253   iter-cap    50000            —            —   30.6

  optimal 3/21 (afiro, sc50a, sc50b) · iter-cap 18/21 · timeout 0/21
  wrong-status 0 ✓ · over-claimed-precision 0 ✓
```

  `optimal` now genuinely means `achieved_precision ≤ precision`; the
  3/21 is the *honest* rate (pre-fix it read 5/21, with `blend` and
  `scsd1` `optimal`-but-over-tolerance). The iter-cap residuals span
  `1.06e-5` (`adlittle`, close) to `1.62e-2` (`brandy`, far) — SCS's
  honest spread, the metric `1s32` exists to lift.
- 6 `cone-solve` goldens regenerated (`achieved_precision` bits of the
  optimal cases); 07/08 and the 6 refusals byte-unchanged.
- `bd` state: `2ivi` closed; `rgl8` closed; `1s32` + `oxuk` filed open.

## Pointers

- ADR-0037 (`docs/adr/0037-universal-tier-bench-discipline.md`) — the
  decision; supersedes worklog 089's `cone-solve` gate (banner added
  to 089).
- `bench/cone-solve/profile-lp-netlib.ts` — the universal-tier profiler.
- Beads: `2ivi` (closed), `rgl8` (the over-claim — closed), `1s32`
  (Type-I + Powell v0.2 lever), `oxuk` (SCS-termination vs wire
  contract).
- worklog 112 (`cone-core` substrate), worklog 113 (`cone-solve` build
  + the open question this shard resolves), worklog 089 (the withdrawn
  gate).
- `tools/cone-solve/tool.ts` (`kktResidualC`, the coherence guard,
  `smokeTest`), `packages/cone-core/src/scs.ts` (`DEFAULT_SCS_OPTS`).
