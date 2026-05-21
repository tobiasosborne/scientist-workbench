# 174 — Gamma family epic: Phase 1 close + Phase 2 Round 1 + Round 2 in-flight

**Date:** 2026-05-19.
**Epic:** `scientist-workbench-xqc7` ([gamma] World-class Gamma family reference implementation, per-head substrate prototype 3).
**ADR:** [`docs/adr/0042-gamma-family-per-head-substrate.md`](../adr/0042-gamma-family-per-head-substrate.md).
**Session model:** orchestrator + parallel opus subagents (semi-serial: phases serial, intra-phase parallel).

## Context

Phase 0 (research + architecture) was committed in the previous session
(commit `189ca2c`): ADR-0042, PHASE2-impl-plans.md, six R1-R5/A1 research
artefacts (7164 lines), HANDOFF-phase0-to-phase1.md, 40 beads pre-filed
covering Phase 1-4. This session's brief: orchestrate the actual
implementation work, delegating to opus subagents, with the orchestrator
validating + closing beads.

Decision rule for ambiguity: "what would a legendary TS senior
engineer want / demand?" The brief asked for that explicitly.

## What changed

### Phase 1 — golden corpus + 5 oracle adapters + cross-agreement gate (committed)

| Bead | Subject | Outcome |
|---|---|---|
| `vekz` | G-I-BOOST install gate | closed (env probe confirmed boost installed) |
| `d3xd` | G-I-FLINT install gate | closed (python-flint 0.8.0, libflint-dev 3.0.1 confirmed) |
| `0kq3` | G1 — corpus design | closed; `bench/gamma-anchor/{generate-corpus.ts, corpus.json, corpus-spec.md}`. 377 inputs, 8 tiers, 19 ADMITTED_HEADS. Park-Miller LCG seed=20260519. sha256(`corpus.json`) = `1328dd0c0363dc3b983353d6f146fd989782a4d5b4e6da22ec976c7fb56e50d5` (byte-identical re-runs verified). |
| `ehi4` | G2 Wolfram (gold) | closed; 369/8/0 (success/refused/unsupported). L17 ComplexInfinity poles. |
| `5x31` | G3 mpmath (gold) | closed; 300+57/8/12. P+Q=1 and Upper+Lower=Γ(a) verified bit-exact 60 dp. |
| `tqwc` | G4 SciPy (bronze) | closed; 342/24/11. All 17 SciPy landmines pinned (L12 ×104, L13, L14, L15, L17). |
| `3v35` | G5 Boost (silver real) | closed; 295/11/71. 49 dp agreement with gold, 1-ULP at 50 dp (silver tolerance). |
| `2wr6` | G7 Arb (gold complex arb-prec) | closed; 357/8/12. `value_radius` first-class; 2 legitimate Temme-saddle cancellation retries (200→264 bits). |
| `fab6` | G8 cross-agreement + Phase 1 gate | closed; **PASS** at 4 unexplained (threshold 50). |
| `u6mj` | G9 Phase 1 gate (orchestrator) | closed; verified all upstream artefacts. |

Commits: `009198f` (G1 corpus), `5a17715` (5 oracle adapters), `2ad923a`
(G8 + Phase 1 gate PASS).

### Phase 2 Round 1 — vocab admission + identity table + float64 substrate (committed)

| Bead | Subject | Outcome |
|---|---|---|
| `h37z` | `isNonPositiveInteger` predicate | closed; pattern.ts:303-372; 19 tests + 3 cross-predicate invariants; 120/0 pass. |
| `mozz` | I6a — ADR-0023 amendment (6 new vocab heads) | closed; `SPECIAL_FUNCTION_HEADS` 32→38; 5 diff rules with DLMF citations; 37 new tests; 104/0 pass. |
| `rknz` | I4 — `gamma-identities.ts` | closed; 1197 LOC + 924 LOC tests; **48 rules** across priorities A-E (target was 38, +10); 20 mutation-proof markers; 101/0 tests pass; full cas-core 688/0. |
| `yyyb` | I5 — `gamma-float64.ts` | closed; 2087 LOC verbatim-port substrate; 19 ADMITTED_HEADS dispatcher; 88/0 tests; full quadrature 463/463 pass. |

Commit: `198e780` (Round 1).

### Phase 2 Round 2 — digamma/trigamma neg-arg lift + polygamma m≥2 Hurwitz + bigIncompleteGamma (IN-FLIGHT at session pause)

Three opus subagents dispatched in parallel, all stopped at the
final `bun run check:quick` step — implementation work was substantially
complete on disk at session pause. Status: bead-closure deferred to
next session pending validation; files committed as-is.

| Bead | Subject | On-disk state at pause |
|---|---|---|
| `2awg` | I1a — digamma/trigamma negative-arg lift | `special.ts` reflection path added; `digamma(-0.5, 160)` confirmed matching mpmath at 50+ dp (vs the Boost-1.83 buggy value G8 surfaced). Tests in `special.test.ts`. |
| `7znk` | I1b — polygamma m≥2 via Hurwitz zeta | `special.ts` polygamma m≥2 unstub via `ψ^(m)(z) = (-1)^{m+1} · m! · ζ(m+1, z)` with Euler-Maclaurin Hurwitz helper. 3 mutations confirmed by subagent. |
| `ytvb` | I2a — bigIncompleteGamma{Upper, Lower} | NEW `packages/bigfloat/src/special-funcs/incomplete-gamma.ts` + tests; 22/22 reported passing by subagent before stop. |

## Why these choices

**Semi-serial orchestration.** Phases run serially (Phase 1 gate before
Phase 2 substrate; Round N+1 blocked on Round N). Within a phase, the
3-5 subagents run in parallel because their files don't conflict
(distinct oracles under `oracles/*/`, distinct substrate modules,
distinct test files). The exception was I1a/I1b both touching
`special.ts` — the prompts coordinated explicitly ("I1a touches
digamma/trigamma reflection; I1b touches polygamma m≥2 — do not step
on each other") and the agents respected the boundary.

**Skepticism (CLAUDE.md Rule 3) caught real bugs.** Two notable
catches this session:

1. **mpmath + arb IncompleteBeta convention bug (G8 cross-agreement).**
   The first cross-agreement run surfaced **40 unexplained findings.**
   36 of 40 root-caused to a single adapter convention mismatch:
   `mpmath.betainc(a,b,0,z,regularized=False)` and `acb.beta_lower(a,
   b, regularized=0)` returned the unregularised form while corpus-
   spec.md pins **regularised** (`I_z(a,b)` notation; DLMF §8.17.2).
   The two subagents had even left probe-comments that *cited* the
   regularised form as correct but then dispatched the unregularised
   one. Two 1-character fixes (`False → True`; `0 → 1`) + comment
   correction. Re-run: 40 → 4 unexplained.

2. **Boost.Math 1.83 digamma half-integer bug.** Remaining 4 findings
   were all `digamma(-1/2)` × 4 oracle pairs: Boost returns `ψ(1/2)`
   instead of `ψ(3/2)`. Verified independently via mpmath, scipy, and
   DLMF §5.5.4 reflection (`cot(-π/2) = 0` so `ψ(-1/2) = ψ(3/2)`).
   Filed as P3 followup. The I5 float64 port (our own implementation)
   gets this right; tests include an explicit G8-finding guard.

**The orchestrator validates, never trusts.** Each subagent reported
back with sha256 hashes, test counts, and cross-check values. The
orchestrator's job was to verify on disk (re-run tests, sha256 the
output, spot-check known closed-form values like `Γ(1/2) = √π`),
catch schema mismatches (SciPy adapter emitted `id` while the other
four emitted `input_id` — normalized at source), and close beads
only after on-disk validation. The I6a agent's last reported message
was incoherent ("Still running. Let me wait for the monitor's DONE
event.") but its work on disk was complete and correct — the
orchestrator closed the bead based on direct verification, not on
the agent's self-report.

## Frictions surfaced

- **Agent self-justification ≠ correctness.** Both the mpmath and arb
  G3/G7 subagents shipped IncompleteBeta with confident-but-wrong
  comments justifying the wrong convention. The G8 gate caught the
  divergence; without the cross-oracle agreement run, the bugs would
  have shipped silently. **Lesson:** never trust a single oracle's
  self-confidence; the cross-agreement matrix is load-bearing.
- **Boost.Math 1.83 has a digamma half-integer bug.** Independent of
  our port — affects everyone using Boost for `ψ` at negative
  half-integers. Filed P3.
- **Pre-existing `bun run check:quick` timeouts.** The `meijer-core/
  contour`, complex-bessel, Hankel-identity, Dawson, and tanh-sinh
  suites timeout at the 2-minute hard timeout under system load. Not
  this work; flagged across multiple agent reports.
- **System-reminder noise.** Every few turns the harness fires
  "use TaskCreate to track progress" reminders even when the task
  list is already current and up-to-date. Orchestrator ignored as
  irrelevant.

## Acceptance

- Phase 1 GATE: PASS (4 unexplained << 50 threshold; Erf had 8;
  Bessel had 0).
- Phase 2 Round 1: all four beads closed; cas-core test suite
  688/0; quadrature test suite 463/463.
- Phase 2 Round 2: in-flight at pause; files on disk; bead closure
  deferred to next session.

## Bead-count audit

Pre-session: 40 gamma-anchor beads open (Phase 1-4) + epic.
Post-session: 11 closed (G-I-BOOST, G-I-FLINT, G1-G5, G7, G8, G9, h37z,
I6a, I4, I5), 3 in-progress (I1a, I1b, I2a — files on disk, validation
pending), 1 new P3 followup filed (Boost digamma(-1/2) bug). Epic
itself still open; closes at end of Phase 4 D1.

## Pointers

- Epic: `bd show scientist-workbench-xqc7`.
- ADR: [`docs/adr/0042-gamma-family-per-head-substrate.md`](../adr/0042-gamma-family-per-head-substrate.md).
- Phase 0 handoff: [`docs/refs/gamma-research/HANDOFF-phase0-to-phase1.md`](../refs/gamma-research/HANDOFF-phase0-to-phase1.md).
- Phase 2 impl plans: [`docs/refs/gamma-research/PHASE2-impl-plans.md`](../refs/gamma-research/PHASE2-impl-plans.md).
- Bench corpus: `bench/gamma-anchor/corpus.json` (sha256 `1328dd0c…e50d5`).
- Cross-agreement: `bench/gamma-anchor/agreement-matrix.md`.
- Predecessor epics: [`docs/worklog/142-erf-epic-close.md`](142-erf-epic-close.md), [`docs/worklog/166-bessel-epic-close.md`](166-bessel-epic-close.md).
- Methodology doc: [`docs/HANDOFF_per_head_special_function_methodology.md`](../HANDOFF_per_head_special_function_methodology.md).

## Resume checklist (next session)

```
[ ] Validate Round 2 files on disk:
    bun test packages/bigfloat/test/special.test.ts
    bun test packages/bigfloat/test/special-funcs/incomplete-gamma.test.ts
    bun test packages/bigfloat/         # full bigfloat suite
[ ] If green: close I1a (2awg), I1b (7znk), I2a (ytvb) beads with notes.
[ ] If issues: surface findings and fix-cycle the relevant subagent.
[ ] Dispatch Phase 2 Round 3 (I2b, I3a, I3b, I3c — Beta, Pochhammer,
    BarnesG arb-prec).
[ ] Continue through Rounds 4 → Phase 3 (T1, T2, T3) → Phase 4 (V1, D1).
```
