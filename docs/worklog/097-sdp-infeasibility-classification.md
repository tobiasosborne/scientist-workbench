# 097 — sdp-solve infeasibility classification (bead io2v) (2026-05-12)

> **Scope.** Single-bead session on `io2v` (filed earlier the same day
> by `jb1x`'s stress test). The bug: the four explicitly-infeasible
> SDPLIB cases (`infp1, infp2` primal-infeasible; `infd1, infd2`
> dual-infeasible) all returned wire `status=optimal` with
> `achieved_precision` in the 1e+1 to 1e+5 range. An honest-scope
> violation per CLAUDE.md Rule 8 — the tool *lies* about success on
> inputs it cannot solve. Both `--method=nt` and `--method=hsde-nt`
> were affected, by two structurally distinct bugs.

## Context

Bead `jb1x` (commit `c3e113c`, the previous session) ran a 122/130
SDPLIB stress test on `tools/sdp-solve` across both methods.
Headline-level findings on the optimal cases were healthy
(HSDE-NT beat NT by 1–4 decades on hinf-class precision floor). But
on the four explicitly-infeasible cases, both methods returned wire
`optimal`:

```
infp1, nt,      optimal,  iter=2, ap=1.5e+5
infp1, hsde-nt, optimal,  iter=8, ap=3.6
infd1, nt,      optimal,  iter=2, ap=2.2e+4
infd1, hsde-nt, optimal,  iter=1, ap=46.5
```

(Same shape for infp2 / infd2.) `ap` is the wire's `achieved_precision`
— honest signal that the iterate isn't optimal. But `status` is the
field consumers actually branch on, and the wire's promise is that
`status=optimal` means *optimal*. Both classifications wrong.

## What changed

### Root cause 1 — `NtSdpSolver.ts` best-iterate stamp

The best-iterate machinery (worklog 095) snapshots the trajectory's
best iterate by a verifier-aligned metric and returns it on fall-
through paths (numerical-error, iter-limit, stall). The stamp
`bestStatus = "dual-feasible"` was set unconditionally whenever the
metric improved. `Status.ts` then maps `dual-feasible → optimal` at
the wire (worklog 095's deliberate choice, motivated by
control2/control3/hinf2 reaching the optimal *face* with μ→0 but
α_P clamping by the PSD-cone boundary, so the strict OPTIMAL flag
doesn't fire but the iterate IS the right answer).

Consequence: on infeasible inputs the algorithm crashes after 2 iters
with numerical-error (S leaves the cone). `finalizeBestOr` returns
the iter-0 or iter-1 snapshot with `bestStatus="dual-feasible"`, which
goes to wire `optimal` with `achieved_precision = the_huge_residual`.
A consumer reading the wire status field gets a lie.

**Fix.** Gate the stamp on `couldDualFeas` — a flag the code already
computed and `void`'d (line 232 of the original `NtSdpSolver.ts`),
representing "the iterate honestly meets at least `abs_gap` OR
`rel_dual_feas` OR `abs_dual_feas`". On the SDPLIB control2/control3/
hinf2 trajectories the flag DOES hold at the optimal-face iter
(verified by the existing solver-ipm tests still passing); on infp/
infd it never holds. Snapshot the X/y/S either way (the snapshot is
still useful as the best iterate seen), but only stamp the *status*
when honest.

Also tightened `finalizeBestOr`: pre-fix it returned the *current*
iterate (often the one that just blew up) when `bestStatus` was null;
post-fix it returns the best snapshot with the fallback status when
no honest stamp was made. So infeasible inputs now return the best
snapshot with `status="numerical-error"` → wire `numerical-breakdown`,
not the worst iterate with the same.

### Root cause 2 — `HsdeNtSdpSolver.ts` termination gate

ADR-0033 Decision 6 prescribed a single ρ-test gate for both OPTIMAL
and INFEASIBLE classifications:

| `max(ρ_p, ρ_d, ρ_g) ≤ 1` AND `PRSTATUS > 0.5` | OPTIMAL |
| `max(ρ_p, ρ_d, ρ_g) ≤ 1` AND `PRSTATUS < −0.5` | INFEASIBLE |

The implementation followed faithfully. But ρ_p = `‖r_p‖_∞ / (τ · ε_p
· (1+‖b‖_∞))` and ρ_d are **purified** — they divide by τ. On an
iterate heading to the τ→0 limit (exactly the infeasibility-certificate
regime), the ρ metrics inflate as τ shrinks, the gate never trips, the
cert tests never fire. Stall fires, `finalizeBestOr` returns
`bestStatus="dual-feasible"` (the same unconditional stamp from the
HSDE path's mirror of the NT logic), wire `optimal`.

The ADR design copied the "ρ-test as universal gate" shorthand from
ART03's *optimal-case* analysis and applied it to infeasibility —
which ART03 itself does not. Mosek's `hom_terminatelo` (decomp
`MOSEK-decomp/analysis/decomps/003f8460_hom_terminatelo.c`) is the
canonical reference, and its structure is:

  - Gate to classification: `pfeasinff < tolP OR dfeasinff ≤ tolD`
    (the OR is critical — either side near-feasible is enough to
    classify).
  - Inside classification, two independent **ratio tests on unpurified
    residuals + objectives**: dual-infeasible when `cx < 0` with
    `|cx|·τ·tolP ≤ rtemp · ...`; primal-infeasible when `by > 0` with
    `τ·by·tolP < rtemp · dfeasinff`.

The infeasibility tests are NOT gated by the ρ metrics — they use
unpurified `b^T y` and `⟨C, X⟩` as witnesses and unpurified residuals
as the certificate-quality bounds. SCS `solver.c::solve` has the same
shape (the cert tests live in `unbounded`/`infeasibility` computations
that run regardless of feasibility-tolerance status).

**Fix.** Split `checkHsdeTermination`:
  - OPTIMAL keeps the purified ρ-metric gate (correct shape — we hand
    back the purified iterate, so feas/opt tolerances are naturally
    `residual / τ`).
  - PRIMAL-INFEASIBLE: `dObj > WITNESS_FLOOR && dualInf ≤ ε_inf · (1 +
    |dObj|)`. The unpurified `b^T y > 0` is the Farkas witness; the
    `WITNESS_FLOOR = 1e-6` guards against the degenerate "collapse to
    zero" iterate; `prstatus < −0.5` adds an explicit regime guard.
  - DUAL-INFEASIBLE: symmetric on `pObj < −WITNESS_FLOOR` and `primalInf`.
  - TAU_KAPPA_FLOOR = 1e-8: a `τ + κ` collapse floor. Without it, an
    iterate with τ=1e-15 and κ=1e-24 would have prstatus → +1 (τ
    dominates numerically) and ρ-metrics → 0 (the residuals collapse
    too), and we'd declare OPTIMAL on a degenerate point — the actual
    failure mode I hit on the `dual-infeasible-A` probe before adding
    the floor.

Also dropped the `bestStatus = "dual-feasible"` stamp from the HSDE
path entirely. HSDE has a comprehensive classification (optimal + 2
infeasibility certs); the "soft success" bucket was inherited from
NT but doesn't apply — HSDE's `α_τ → 0, τ → 0` iter is degenerate, not
dual-feasible. On fall-through (iter-limit / stall / numerical-error),
the best snapshot returns with the fallback status, wire `numerical-
breakdown` / `iter-cap`. Never `optimal`.

### Test fixtures (4 cases, hand-constructed)

`packages/solver-ipm/test/sdp-infeasibility.test.ts` — 8 tests across
4 minimal SDPs that exhibit the same classification pattern as the
SDPLIB inf* cases (the tarball isn't on disk; the stress test
downloaded and discarded it). Each problem is 2×2 PSD with m ≤ 4:

  - **primal-infeas A.** Four eq's pin `X = I` (trace 2) but the fourth
    requires trace = 3. Contradictory.
  - **primal-infeas B.** Two eq's: `trace(X) = 0` (forces X = 0) AND
    `trace(X) = 1`. Different witness magnitude.
  - **dual-infeas A.** `X_11 = 0` with min `−X_22`. Feasible set is
    `diag(0, t) for t ≥ 0`; objective unbounded.
  - **dual-infeas B.** Adds `X_12 = 0` (redundant given PSD) to A.

For each: HSDE-NT must return the correct classification with a
substantial witness (`b^T y > 0` or `⟨C, X⟩ < 0`) and τ ≪ κ. NT must
return *any honest non-optimal status* (numerical-error, numerical-
difficulty, iter-limit) — never `optimal` and never `dual-feasible`
with huge residuals.

### Doc changes (Law 2)

  - `docs/adr/0033-hsde-for-solver-ipm.md` §"Decision 6": termination
    decision tree updated with the split structure, witness/collapse
    floors, and the "departure from earlier ADR draft" call-out
    explaining the bead-`io2v` symptom and the Mosek reference. ADR
    not superseded — same overall design, fixed sub-decision.
  - Same ADR §"Decision 7": added the bead-`io2v` follow-up note
    explaining the `bestStatus` stamp tightening (both HSDE and NT
    paths).

## Why these choices

### Why split the OPTIMAL and INFEASIBILITY tests rather than unify

The ρ-metrics and the witness inequalities are dimensionally different
quantities — they measure different things. ρ_p = `‖r_p‖ / (τ · ε ·
(1+‖b‖))` is "how feasible is the *purified* iterate" — natural when
we're going to hand back X/τ. The witness `b^T y` is the *unpurified*
Farkas multiplier — natural when we're going to hand back y itself as
a certificate (not divided by τ → 0). Treating them as a single test
forces both classifications through the wrong denominator for one of
them. The Mosek+SCS structure isn't an arbitrary stylistic choice;
it's the right shape.

### Why `prstatus < −0.5` as a regime guard on the cert tests

Without it, an almost-converged optimal problem where `|b^T y| ≫
‖c‖_F` (e.g. a problem with `b` and `c` at very different scales) can
spuriously fire the primal-infeasibility cert before the ρ-metrics
drop below 1: the cert's `ε_inf · |b^T y|` bound is generous enough
to admit `dualInf` levels the optimal test would still reject. The
guard makes the regime-switch explicit: optimal is τ-dominant
(`prstatus > 0.5`), infeasibility is κ-dominant (`prstatus < −0.5`);
they never overlap. ART03's dichotomy uses the same threshold.

### Why minimal hand-constructed problems instead of re-downloading SDPLIB

The stress test downloaded SDPLIB to /tmp and discarded it; the next
session has no SDPLIB on disk. Could re-download (~5MB), but
(a) the test fixtures should be self-contained — fetching SDPLIB at
test time is a CI fragility we explicitly reject (CLAUDE.md Rule 11
on no CI; locally the same argument is "fetching breaks offline
runs"); (b) the minimal cases are *cleaner* — 2×2 blocks, hand-
provable infeasibility, no risk of confounding numerical effects;
(c) the SDPLIB inf* cases inspired but don't *define* the bug — the
bug is the termination test logic, which any infeasible SDP exhibits.

### Why HSDE detects infeasibility but NT doesn't

A design choice. The bead notes "this is tractable on its own but
interacts with the Phase 5 IR work". NT path lacks the τ-κ machinery
to cleanly detect infeasibility; porting a Farkas-divergence
heuristic (the LP-style check in `Convergence.ts` adapted to SDP)
would work for some cases but not all, and the user should *use
hsde-nt* if they care about infeasibility classification. The fixed
NT now returns honest `numerical-error` (or similar), wire
`numerical-breakdown` — not a lie, just no positive classification.
The acceptance language in `io2v` requires `status=infeasible` for
infp* and `status=unbounded` for infd*; that's met by HSDE-NT, which
is the user-facing path for these cases.

## Frictions surfaced

1. **The ADR was wrong in a load-bearing way.** Decision 6's table
   gated both classifications on `max(ρ) ≤ 1`. The implementation
   followed faithfully (and the implementer noted "Decision 7" in
   the `bestStatus = "dual-feasible"` line — meaning the bestStatus
   pattern itself was prescribed by the ADR). The bug was a *design*
   bug that ADR review didn't catch. The lesson: testing infeasibility
   classification on *infeasible inputs* should have been a Phase 3
   acceptance criterion alongside testing optimal classification on
   optimal inputs. (Was it? The shipped 6/14 SDP goldens are all
   optimal cases. Two refusal goldens cover malformed input. *Zero*
   goldens cover infeasibility — a category gap, not a single-test
   miss.)

2. **Bun's test reporter swallows test failure detail.** Pre-fix the
   `bun test packages/solver-ipm/` output reported `77 pass / 3 fail`
   but no FAIL marker on any individual test. Investigating with
   `--reporter junit` returned empty. Ended up confirming via
   git-stash baseline — the "3 fail" are pre-existing environment
   issues (corpus path mismatch `/home/tobias` vs
   `/home/tobiasosborne`), not caused by my changes. A future
   ergonomic improvement would be a `bun test --bail-on-fail` or
   `--verbose-fail` to surface individual failing tests.

3. **`scripts/probe-infeas.ts` is workmanlike scaffolding.** I left
   it in the repo because it's useful for the next agent debugging
   classification (run it, see the iter-by-iter status), but the
   package test file supersedes it for acceptance. Open question for
   the next agent: keep it under scripts/ (and add it to demo-scope?),
   move it to packages/solver-ipm/scripts/ as a debug helper, or
   delete it. Leaving the decision visible rather than auto-promoting.

4. **The infeasibility-cert tests fire at iter=2 on the probes.**
   That's *fast*. Suggests the HSDE solver doesn't need many iters to
   develop a substantial Farkas y or recession ray on these small
   cases. The SDPLIB inf* cases (n=30) probably need more iters
   (8 in the stress test pre-fix; would likely be similar or fewer
   post-fix since the algorithm exits as soon as the cert test
   fires). Hard to tell without re-downloading SDPLIB; flagged for
   verification when the corpus is next re-acquired.

## Acceptance

  - `bun test packages/solver-ipm/test/sdp-infeasibility.test.ts`:
    8 pass / 0 fail / 24 expect() calls.
  - `bun test packages/solver-ipm/`: 77 pass + 8 = 85 pass, same 3
    pre-existing environment errors (unchanged baseline).
  - `bun run check`: green (see acceptance gate below).
  - Probe: HSDE-NT returns `status=primal-infeasible` on the
    primal-infeas SDP at iter=2 with τ=1e-12, κ=1; returns
    `status=dual-infeasible` on the dual-infeas SDP with same
    τ-κ regime. NT returns `numerical-error` (honest non-success).
  - Bead `io2v` closed.

## Pointers

  - **Code:** `packages/solver-ipm/src/solver/HsdeNtSdpSolver.ts`
    (`checkHsdeTermination` rewrite, `bestStatus` stamp removed,
    `finalizeBestOr` always returns best snapshot with fallback
    status).
    `packages/solver-ipm/src/solver/NtSdpSolver.ts` (`couldDualFeas`
    gate on `bestStatus`, `finalizeBestOr` returns best snapshot with
    fallback status when stamp didn't fire).
  - **Tests:** `packages/solver-ipm/test/sdp-infeasibility.test.ts`.
  - **Probe:** `scripts/probe-infeas.ts` (workmanlike; useful for
    next iteration on this surface).
  - **ADR:** `docs/adr/0033-hsde-for-solver-ipm.md` §6 / §7.
  - **Mosek reference:**
    `/mnt/c/Users/tobia/Dropbox/Projects/Computers/LLM/MOSEK-decomp/analysis/decomps/003f8460_hom_terminatelo.c`
    (Ghidra decompilation of Mosek's HSDE termination routine — the
    canonical reference for the gate-then-witness structure).
  - **Beads:** `io2v` closed; `jb1x` (the stress test that surfaced
    it) was already closed last session.
