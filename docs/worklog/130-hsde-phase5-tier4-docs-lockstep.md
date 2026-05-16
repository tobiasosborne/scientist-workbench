# 130 — HSDE Phase 5 Tier 4: docs-lockstep close-out (2026-05-16)

> **Scope.** Close beads `rqbm` (Tier 4) + `qmrv` (parent bug). Mark the
> three predecessor handoffs (`HANDOFF_solver_ipm_hsde.md`,
> `HANDOFF_solver_ipm_hsde_part2.md`, `HANDOFF_solver_ipm_qmrv.md`) as
> superseded with headers pointing at the per-tier worklogs that landed
> the work (106 / 110 / 128 / 129). Refresh the root README catalog row
> and `tools/sdp-solve/README.md`'s lane table to reflect HSDE+IR as
> the default and the actual corpus grade (5/6 cases, 64/66 invariants).
> This shard is admin-only — no algorithm changes; CLAUDE.md Law 2
> (docs in lockstep with code).

## Context

Bead `rqbm` was written assuming the Phase 5 work would land in a
single shard at slot `097`. That slot was occupied by a different
piece of work (`097-sdp-infeasibility-classification.md`, 2026-05-14)
before Phase 5 started; the four Phase 5 tiers each landed their own
worklog (106 / 110 / 128 / 129). Tier 4's "write worklog 097"
acceptance is reinterpreted: write a short close-out shard (this one,
130) and refresh the doc surface so a reader landing cold on `sdp-solve`
sees the Phase 5 outcome, not the pre-Phase-5 handoffs.

## What changed

### Predecessor handoff supersession headers

Three handoffs gain `> **SUPERSEDED — 2026-05-16.**` blockquotes
at their top:

- `docs/HANDOFF_solver_ipm_hsde.md` — Phase 0-2 playbook. Header
  points at part-2 + the per-tier worklogs; preserves the original
  TL;DR (αP-collapse diagnosis) as historical context, names the
  Phase 5 verdict's refinement (the αP-collapse *is* fixed by HSDE,
  but the remaining 1-case gap is purification arithmetic, not the
  cone-boundary clamp the original handoff diagnosed).
- `docs/HANDOFF_solver_ipm_hsde_part2.md` — Phase 5 playbook. Header
  summarises each tier's outcome and the Phase 6 verdict; preserves
  the full document below since it's still the canonical "why the
  τ-κ tracking is load-bearing" explanation.
- `docs/HANDOFF_solver_ipm_qmrv.md` — the pre-HSDE Ruiz handoff,
  whose diagnosis was wrong. Header marks it as a Rule 2 ("all bugs
  are deep") cautionary tale: a fix that addresses a symptom
  (`|y|` large) without investigating the cause produces 200 LOC that
  doesn't help. Preserved as the historical artefact that motivates
  why Phase 5 reads the references end-to-end.

### Root `README.md` sdp-solve catalog row

The row now describes `--method=auto` as routing to HSDE-NT (was: NT),
drops the "A/B-grade today pending Phase 5 IR" qualifier on the
HSDE lane (Phase 5 has shipped), names the soft-success branch
inline, and updates the bench grade to **5/6 cases, 64/66 invariants**
with the per-failure breakdown (`hinf2 primal_feasibility +
complementary_slackness` only — the Phase 6 gate). Worklog
cross-references (106 / 110 / 128 / 129) point at the per-tier
implementation history.

### `tools/sdp-solve/README.md` lane table

The lane table grows from 4 rows (method choices) to a 4-row table
that reorders `--method=auto, hsde-nt` first (matching the
default), pushes `nt` down with the explicit "kept as the legacy
primal-dual NT path for A/B + trace-diff" note, and adds the
soft-success branch reference per ADR-0033 §"Decision 9 — Tier-3
amendment". A new "Bench grade" paragraph after the lane table
records the corpus outcome.

### Bead state

- `rqbm` (Tier 4) closes via this shard.
- `qmrv` (parent bug) closes — Phase 5 lifted the corpus invariant
  count from 63/66 (worklog 095 baseline) to 64/66, structurally
  resolved the αP-collapse via HSDE's homogenization, and routed
  control2 + control3 to strict / soft `optimal`. The remaining
  hinf2 1-case gap is honestly Phase 6 territory per ADR-0033's
  Tier-2 amendment; closing `qmrv` with that outcome rather than
  carrying it open (the bead diagnosed the right structural cause
  even if the bench grade isn't 6/6 in float64).
- `y3qd` already closed (worklog 129).
- `ki4c` (Phase 4 stretch: tighten corpus TOL_KKT) remains open;
  the float64 floor verdict argues against tightening for now (it
  would regress more cases). A future Phase 6 ADR + impl can revisit.

## Why these choices

### Supersession headers, not file deletion

Each handoff carries 300-700 lines of design reasoning that informed
the implementation. Deleting them leaves the worklogs as the only
record of "why we did it this way" — fine for a snapshot reader,
worse for an agent who lands cold on the part-2 handoff via a
search-index hit. A SUPERSEDED header at the top preserves the
historical artefact AND points the reader at the canonical current
documentation. The handoff documents themselves are part of the
ground-truth assembly Phase 5 was supposed to read — they earned
their preservation.

### Catalog rows name the soft-success branch inline

The bench grade can't be understood without the soft-success branch:
"5/6 cases" is the same as the baseline NT solver but for materially
different reasons. The catalog row spells out the difference (HSDE
soft success, μ-test, mirrors legacy NT's `couldDualFeas`) so an
agent reading the row alone gets the right mental model. The
alternative — a one-line "see ADR-0033 for details" — pushes the
reader into a 600-line ADR for a 2-sentence diagnosis.

### `qmrv` closes with an honest outcome, not a victory lap

The bead's original "lift to 6/6" goal isn't met in float64 — that's
honest scope. But `qmrv`'s root-cause diagnosis (the αP-collapse in
the non-HSDE iterate space) was correct, and the fix it proposed
(HSDE) is the fix that landed. Closing the bead is the right move:
the bug is structurally fixed; the residual gap is a different bug
(float64 representation), filed implicitly via the ADR-0033
Tier-2 amendment + Phase 6 stub-ADR-to-be. Carrying `qmrv` open
forever as "still 1/6 short" misrepresents the work.

## Acceptance

- `bunx tsc --noEmit` — pass (no code changes, but verify anyway).
- `bun test packages/solver-ipm/test/hsde-precision.test.ts` — 14
  pass / 2 skip / 0 fail (unchanged from Tier 3).
- Three handoff documents carry the SUPERSEDED headers; the
  preserved original content is byte-identical below the new
  blockquotes.
- Root README's sdp-solve catalog row reflects HSDE default + bench
  grade.
- `tools/sdp-solve/README.md` lane table reordered with HSDE first
  and bench grade paragraph added.
- Beads `rqbm`, `qmrv` close.

## Pointers

- Per-tier history — worklogs 106 (Tier 0), 110 (Tier 1), 128 (Tier
  2), 129 (Tier 3); this shard (130) for the Tier 4 close-out.
- ADR-0033 §"Decision 9" + its Tier-2 + Tier-3 amendments for the
  current Phase 5 verdict.
- Phase 6 path — `BfHsdeNtSdpSolver` skeleton (separate ADR when
  next agent claims the work); covers `hinf2 primal_feasibility +
  complementary_slackness` invariants; preserves `arbprec: true`
  determinism contract per ADR-0020.
- The three superseded handoff documents — read for "why" context,
  not as canonical "what is true now" docs.
