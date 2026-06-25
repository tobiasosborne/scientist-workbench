# 184 — Bessel epic (`zcam`) tracker reconciliation: 24 stale-open beads closed

**Date:** 2026-06-26.
**Beads:** closes `scientist-workbench-zcam` (epic) + 23 of its children
(`5zkv 1doz kml3 q0wr q7ty t73h lrmo kgky 1xqq lfet 4uws rkoo unno qccc
z9fq g70g 5zxc rlg2 s2n1 92db g5vo qvnm 5zqt`); re-scopes `pp7j` → P3
(kept open). Audit workflow: `wqkhg74bf`.
**Ground truth:** `docs/worklog/166-bessel-epic-close.md` (the authoritative
2026-05-17 epic-close record) + `docs/adr/0041-bessel-family-per-head-substrate.md`
(Status: Implemented).

## Context

Mid-session, after closing `m9ty` (worklog 183), I went to pick up the next
ready bead. The top two — `qt6m` (zInverse→argsInverse rename) and `7j02`
(pattern predicates) — both turned out **already fully implemented but never
closed**. Two stale-open beads in a row is a signal, not a coincidence.

Reading `docs/worklog/166-bessel-epic-close.md` resolved it. The Bessel epic
`zcam` was **substantively closed on 2026-05-17**: ADR-0041 was flipped to
*Implemented*, a 432-line epic-close worklog shipped with a bead-count audit
(*"31 initial → 38 closed + 9 follow-ups = 45 beads"*), and the whole per-head
substrate (J/Y/I/K across symbolic + arb-prec real & complex + float64 +
Meijer-G bridge) landed. **But the 38 documented `bd close` operations never
reached the tracker** — a DB / multi-device sync gap. So `bd ready` was
surfacing ~25 already-shipped beads as if they were open work, misleading
every session that landed here (including, very nearly, this one — I almost
"implemented" two finished features).

Rule 3 in the large: a worklog shard is a frozen claim; the tracker is a
frozen claim; neither is authoritative until checked against the files. Here
they disagreed, and the *files* (the actual shipped substrate + a green
`bun run check`) were the tiebreaker.

## What changed

No source code changed. This shard records a **tracker-state reconciliation**:
the `bd` issue DB was brought back into agreement with the shipped repo and
with worklog 166.

**1. Evidence-based audit (workflow `wqkhg74bf`, 6 parallel agents).** Rather
than trust worklog 166's "38 closed" claim wholesale (it is itself a frozen
snapshot), each of the 25 open `zcam` beads was re-verified against the
*current* repo: does the named deliverable exist, match the bead's acceptance,
and carry tests? Agents returned `done | partial | not-started` verdicts with
`file:line` evidence and a close-note. Result: **21 done, 2 partial, 0
not-started**.

**2. Orchestrator spot-checks (Rule 3 on the subagents).** Before closing
anything I independently verified the load-bearing claims: `docs/worklog/166-…`
exists; ADR-0041 line 3 = *Implemented*; `BESSEL_RULES` (29 rules) at
`bessel-identities.ts:418`; all four `bigCBessel{J,Y,I,K}` in `complex.ts`;
the bidirectional bridge (`headToMeijerG`/`meijerGToHead`); the
`bessel-{y,i}-canonical` backward dispatch rules registered in `dispatch.ts`;
and **both** "partial" gaps (no Bessel goldens in `integrate-1d/goldens/`; no
`jn_zeros` in the scipy adapter). Every spot-check corroborated the audit.

**3. Closes.** 21 verified-done beads + `5zqt` (D1, docs-lockstep) closed.
`bd close` initially refused: the `zcam` children carry a dense, partly
**cyclic** "blocked-by" graph (e.g. `1doz` ↔ `q0wr`) — stale planning metadata
that cannot be topologically ordered. Because each bead's completion was
independently verified (not inferred from the graph), `bd close --force` is the
correct override. `qvnm` (G4) closed **by obviation** — its 4 functions +
scaled variants shipped and the T9-zeros it named are validated through the G1
corpus's gold-oracle `z_root` design + the G8/G9 cross-agreement gate (`92db`
PASS, 0 unexplained findings), so an independent scipy `jn_zeros` locator is
redundant. The epic `zcam` closed last, matching worklog 166's intent.

**4. `pp7j` (T1) re-scoped to P3, kept open.** The only genuine residual. T1's
substantive deliverable shipped (integrate-1d dispatches the Bessel family in
integrands + 4 DLMF closed-form integral anchor tests + a dispatcher-composition
oracle; worklog 160/166), but there are no dedicated Bessel integrand *golden
files* and only `BesselJ` integrands are exercised (per-function J/Y/I/K breadth
is covered at the eval layer by T2/`unno`'s 24 goldens). Downgraded to a P3
v0.2-polish follow-up rather than closed — honest scope: the gap is real but
non-gating, joining the epic's intended deferred-follow-up set.

## Why these choices

**Reconcile, don't re-implement.** The fast path was to pick `qt6m`/`7j02` and
"do" them — which would have re-derived finished work and, worse, risked
diverging from the shipped implementation. Verifying-then-closing is strictly
better: it makes `bd ready` trustworthy again at the cost of an audit.

**Audit before bulk-close.** Closing ~24 beads on worklog 166's say-so alone
would inherit any overstatement in that snapshot (and it *did* overstate two:
`pp7j` and `qvnm`). The parallel audit + orchestrator spot-checks caught both,
so `pp7j` stayed open and `qvnm` closed with an explicit obviation note instead
of a false "done".

**`--force` is honest here, dangerous in general.** Overriding a dependency
gate is normally a smell. It is correct *only* because completion was
established independently of the (cyclic, stale) edges. The cycle itself
(`1doz` ↔ `q0wr`) proves the edges were never a real ordering constraint.

## Frictions surfaced

- **The tracker silently lagged a shipped epic by ~25 beads.** The `.beads`
  JSONL sync vehicle exists precisely to prevent this; the gap suggests the
  2026-05-17 closes were made on a device whose export never reached git, or a
  `bd` DB that was later rebuilt. Worth watching: if other closed-in-worklog
  epics (Erf `43hw`, Gamma `xqc7`) show the same lag, a one-time audit of each
  is warranted.
- **`bd close` of a list is all-or-nothing-per-item and stops being obvious
  under `grep`.** The first attempt closed only the 5 dependency-leaf beads and
  the refusals were filtered out by a `grep 'Closed'`; the full output
  (`cannot close … blocked by open issues …`) is what revealed the cyclic
  graph. Lesson: read the *full* `bd close` output, not a success-filtered tail.
- **Worklog 166 used "goldens" loosely for T1** (it pointed at in-test anchors
  in `tool.test.ts`, not `goldens/*.json`). The audit's literal reading flagged
  the mismatch — a useful catch that kept `pp7j` honestly open rather than
  rubber-stamped.

## Acceptance

- `bd stats`: Open **147 → 121**, Closed **322 → 349** (+27 this session,
  incl. `m9ty`/`qt6m`/`7j02`), Ready **115 → 113**.
- Open `zcam`-family beads now: only the intended deferred follow-ups —
  `pp7j` (P3, re-scoped), the worklog-166 P3 list (`bguf`, `l62y`, `uldg`,
  and the others), `sgec` (new perf bead), and `d6s` (a meijer-core
  per-head-arbprec-evaluator bead **outside this audit's scope** — left open
  pending its own assessment).
- No source change; the green `bun run check` from worklog 183 (109/7/0) is the
  standing proof the closed deliverables pass.

## Pointers

- Epic-close record (authoritative): `docs/worklog/166-bessel-epic-close.md`.
- Audit workflow transcript: `wqkhg74bf` (6-agent evidence sweep).
- ADR: `docs/adr/0041-bessel-family-per-head-substrate.md` (Implemented).
- Still genuinely open (not stale): `pp7j` (T1 integrand goldens, P3),
  `d6s` (meijer per-head arbprec evaluator — unaudited), `sgec` (arb-prec
  test timeouts), and the worklog-166 P3 follow-ups.
- Sibling epics to spot-check for the same tracker lag: `43hw` (Erf),
  `xqc7` (Gamma).
