# 161 — Bessel-family dispatcher ↔ bridge closure validation (ADR-0041 T3)

**Date:** 2026-05-17
**Bead:** `scientist-workbench-4uws` (T3 — meijer-g closure validation, Bessel epic Phase 3)
**Epic:** `scientist-workbench-zcam` (World-class Bessel J + Y + I + K)
**ADR:** ADR-0041 §"Decision 5" (bridge API), Bessel R4 §A.4 (4 canonical G-forms) + §E (existing dispatch-rule survey)
**Prereqs (closed):** I6 (`kgky`, worklog 155 — Meijer-G bridge for Bessel)
**Exemplar:** worklog 138 (Erf T3 — `erf-closure.test.ts`)

## Context

ADR-0041 §"Decision 10" defines Phase 3 as tool integration: once the
substrate beads (Phase 2, I6 / `kgky` shipping in worklog 155) ship, the
bridge-vs-dispatcher round-trip must *close* — the dispatcher's
Bessel-emitting rules must produce expressions whose extracted head +
args feed cleanly back through I6's `headToMeijerGBessel` forward bridge
to a canonical R4 §A.4 G-form. Anything that doesn't close is either:

- a bug in the dispatch rule (its G-form doesn't match R4 §A.4's
  canonical form per Bessel-family — P2, gates v0.1), OR
- an incomplete I6 backward matcher (the rule's G-form needs additional
  `meijerGToHead` coverage — P3, doesn't gate v0.1 because the bridge
  already covers the standalone case), OR
- a *mirror-form* coexistence (e.g. the `z → 1/z` Mellin involution of
  `bateman-5-6-5`) — documented as N/A per R4 §E.2, NOT a finding.

This bead is the closure-validation harness: walk every Bessel-emitting
rule, run it, peel off `cas-simplify/out-of-scope` wrappers, extract the
load-bearing head + args, feed back through the bridge, compare against
R4 §A.4's pinned canonical `(m,n,p,q)` tuples + prefactors.

The contract being verified is what ADR-0041's "world's best Bessel"
claim rests on for the symbolic layer: a Meijer-G that *names* a
Bessel-family head must round-trip to that head's canonical G-form. If
it doesn't, the symbolic pipeline has an internally-inconsistent
representation — the user could get different goldens depending on which
path (dispatcher or bridge) the planner happens to take.

T3-Bessel is the **second** per-head closure-validation harness in the
workbench — Erf T3 (worklog 138) was the first. Bessel additionally
validates the closure pattern for **2-argument heads** (the first 2-arg
head to land); the `argsInverse` closure (renamed from `zInverse` in
I6-prep per ADR-0041 §"Decision 5") returns a 2-element `[nu, z]` list
arity-agnostically.

## What changed

```
packages/meijer-core/test/bessel-closure.test.ts   (+524)  NEW
docs/worklog/161-t3-bessel-meijer-closure.md       (+this) NEW
```

No source modifications to `packages/meijer-core/src/` — per the bead's
explicit constraint and CLAUDE.md Rule 8 ("honest scope"). Closure
validation is a verifier, not a fixer; all five round-trip-compatible
rules close cleanly today and the one mirror-form rule is documented as
N/A by design. No follow-up beads filed by T3 itself; pre-existing R4
§E.3 gaps (BesselY / BesselI generic dispatch rules) remain open per
their pre-filed beads `1xqq` / `lfet`.

### Rule survey

Discovered by grepping `packages/meijer-core/src/dispatch-rules/` for
emissions of `BesselJ` / `BesselY` / `BesselI` / `BesselK` heads.
All six entries live in `dispatch-rules/bateman-5-6.ts`:

| # | Rule id | Shape | Emitted head | Closes? |
|---|---|---|---|---|
| 1 | `bateman-5-6-25` | (2,0,0,2) | `BesselK` (`2·K_0(2√z)`) | ✓ |
| 2 | `bateman-5-6-4` | (2,0,0,2) | `BesselK` (`2·z^{(a+b)/2}·K_{a-b}(2√z)`) | ✓ |
| 3 | `bateman-5-6-5` | (0,2,2,0) | `BesselK` (mirror `z → 1/z`) | N/A — bridge does not emit `m=0` shapes |
| 4 | `bateman-5-6-extra-b` | (1,0,0,2) | `BesselJ` (`J_0(2√z)`) | ✓ |
| 5 | `bateman-5-6-extra-a` | (1,0,0,2) | `BesselJ` (`J_{-1}(2√z)`) | ✓ |
| 6 | `bateman-5-6-6` | (1,0,0,2) | `BesselJ` (`z^{(b₁+b₂)/2}·J_{b₁-b₂}(2√z)`) | ✓ |

**Rules surveyed:** 6 of 6.
**Round-trip closes cleanly:** 5 / 5 (of bridge-compatible).
**Mirror-form rules (N/A by design):** 1 / 1 documented.
**Findings filed:** 0.

R4 §E's verbatim claim — "5 of 5 Bessel-emitting rules round-trip
clean" — holds post-I6. This is the success outcome the bead's sanity
rails predicted.

### Anatomy of the round-trip

The test's file-top narrative explains the *structural* nature of the
closure: byte-identity of the recovered `nu` / `z` back to the rule's
original input is NOT the contract, because the rule's emission
deliberately reshapes its arguments (e.g. `bateman-5-6-25` emits
`K_0(2√z)`, so the extracted `z`-arg is `2·z^{1/2}` not the rule's
input `z`). The bridge then emits `z²/4` of that, which is
`(2·z^{1/2})²/4 = z` *mathematically* but structurally a nested-power
AST that `cas-simplify` does NOT reduce (multi-valued root surface;
see `bridges/bessel.ts` file-top "The `argsInverse` closure trick").

The load-bearing comparison is on `(m,n,p,q)` + prefactor, NOT on the
recovered slots' byte content. The closure-validation test asserts the
canonical R4 §A.4 `(m,n,p,q)` tuple is recovered exactly for each head:

| Head | (m,n,p,q) | Prefactor `wrap` |
|---|---|---|
| BesselJ | (1,0,0,2) | identity (`g`) |
| BesselY | (2,0,1,3) | identity (`g`) |
| BesselI | (1,0,1,3) | `π · g` |
| BesselK | (2,0,0,2) | `(1/2) · g` |

Byte-identical `argsInverse()` round-trip is verified separately on the
extracted `[nu, z]` — the closure captures those *extracted* args
verbatim, so `argsInverse()` returns them unchanged. (Byte-identity all
the way back to the rule's *input* z would require pushing through the
rule's emission shape, which is unrelated to the closure contract.)

### Mirror-form rule (`bateman-5-6-5` — N/A)

`bateman-5-6-5` matches shape (0,2,2,0) and emits `2·z^{...}·K_{a-b}
(2/√z)` — the `z → 1/z` Mellin-involution mirror of `bateman-5-6-4`.
The bridge does NOT emit `(0,2,2,0)` — all four bridged heads have
`m ≥ 1` (every canonical Bessel-family G-form has non-empty `bm`).
Therefore `bateman-5-6-5` is for a DIFFERENT backward path (e.g. a
hypergeometric reduction that produces the `(0,2,2,0)` shape) —
independent of the bridge, per R4 §E.2: "Bridge forward never emits
this shape. N/A (rule is for a different backward path)."

The test documents this with a dedicated `describe` block that fires
the mirror-form rule, extracts the `BesselK` head, calls the bridge on
it, and verifies the bridge re-emits the canonical `(2,0,0,2)` shape
(NOT the mirror's `(0,2,2,0)`). This is the load-bearing fact: a
round-trip through the bridge is path-independent of which dispatch
rule originally produced the `BesselK` head. A complementary sanity
test confirms `bm.length ≥ 1` for every bridged head — if the bridge
ever starts emitting `m=0` shapes, the N/A documentation needs
revisiting.

## Why these choices

### Why `(m,n,p,q)` + prefactor, not slot byte-identity

The slot bytes depend on the extracted `nu` shape, which depends on the
rule's emission shape, which depends on the rule's input. Three layers
of indirection means any slot byte-identity assertion would either be
contingent on rule internals (fragile to refactor) or tautological
(asserting the bridge re-emits what the bridge would emit). `(m,n,p,q)`
+ prefactor are the load-bearing canonical invariants from R4 §A.4 —
they're what distinguishes the four heads structurally and numerically.

### Why hand-rolled probes, not auto-discovery

The test pins a FROZEN INVENTORY of 5 + 1 rules. Auto-discovery
("walk every rule, synthesise an input, check whether the emission
contains a Bessel head") would require a per-rule input synthesiser
(some rules need literal values that fit narrow predicates; some have
`free-shift` slots that need shift-aware inputs). The hand-rolled list
is fewer LOC and keeps the inventory explicit — when a future agent
adds a new Bessel-emitting rule, the inventory count test fails and
forces them to add a probe row. That's coverage discipline by
construction.

### Why mutation-prove with two distinct mutations

Per CLAUDE.md Rule 6, "tests have caught a real regression" is the
contract. Two mutations were performed and reverted:

1. **Prefactor mutation**: replace BesselK's `wrap = g → (1/2)·g` with
   `wrap = g → g`. Result: 2 closure tests fail (the two BesselK rules).
   Prefactor assertion catches it ✓.
2. **Shape mutation**: append an extra slot to BesselJ's `bm` (making
   `m = 2` instead of `m = 1`). Result: 3 closure tests fail (the three
   BesselJ rules). `(m,n,p,q)` assertion catches it ✓.

Both mutations were restored; 14/14 pass post-restore. The test
asserts load-bearing invariants — not just "didn't throw."

### Why N/A documentation in the test, not just the worklog

A test that *explicitly* exercises the mirror-form rule and asserts the
bridge's bm shape `m=0` invariant is a regression anchor: if the bridge
ever starts emitting `(0,2,2,0)` shapes (it shouldn't), the
documentation flags as outdated and the agent revisits R4 §E.2. The
N/A status isn't passive — it's pinned by an executable assertion.

## Frictions surfaced

- **The `bateman-5-6-6` probe needed careful input choice**. The
  generic free-slot rule `(b₁, b₂)` is preceded in dispatch order by
  more-specific literal rules (`bateman-5-6-extra-b` for `(0, 0)`,
  `bateman-5-6-extra-a` for `(-1/2, 1/2)`). Picking `(1/2, -1/2)` ensures
  canonical-bytes sort doesn't accidentally land on `(-1/2, 1/2)` and
  divert to `extra-a` — the bm and bq sub-tuples are sorted
  *independently*, so the order within `bm = [b₁]` vs `bq = [b₂]` is
  preserved. Verified empirically that the dispatcher hits `bateman-5-6-6`,
  not `extra-a`.

- **`bateman-5-6-4` canonical-bytes sort**. With input `bm = [rat(-1, 2),
  rat(1, 2)]` the dispatcher sorts to `[rat(-1, 2), rat(1, 2)]` (smaller
  bytes first; `{"d` < `{"d` ties go to the smaller `num`). So `a` binds
  to `-1/2` and `b` to `1/2`. The emitted `BesselK(a-b, ·) =
  BesselK(-1, ·)`; K is even (`K_{-ν} = K_ν`) so this is mathematically
  `K_1`, but the bridge takes the literal `-1` for ν and emits the
  correct shape regardless. The closure assertion is shape-based, not
  value-based, so this works.

- **The N/A rule (`bateman-5-6-5`) test almost wasn't possible**. The
  rule's `(0,2,2,0)` shape input is `an = [a, b], ap = [], bm = [], bq = []`.
  Inputs `[R(1, 2), R(3, 2)]` (with `a-b = -1`, K_{-1} = K_1) successfully
  fires the rule without coalescence-blocking the `Γ`-prefactor. Picking
  e.g. `[I(0), I(0)]` would have caused a different problem (degenerate
  `Γ(1+0-0) = Γ(1) = 1` is OK actually but rules with `free` slots vs
  `lit-int` may interact differently with the dispatcher's first-match-
  wins ordering — `bateman-5-6-5` is the only `(0,2,2,0)` rule so this
  isn't an issue, but the input choice was nontrivial).

## Acceptance

- `bun test packages/meijer-core/test/bessel-closure.test.ts` — 14
  pass, 0 fail, 128 expect calls.
- Mutation-prove: 2 distinct mutations (prefactor, shape) each cause
  the expected number of closure-test failures; restored cleanly.
- R4 §E's "5 of 5 Bessel-emitting rules round-trip clean" claim holds
  post-I6 — 0 T3 findings filed.
- Inventory test pins the 6-rule frozen count (5 probed + 1 N/A);
  future Bessel-emitting rules force inventory update.

## Pointers

- `packages/meijer-core/test/bessel-closure.test.ts` — the closure test
  itself (524 LOC, 14 tests).
- `packages/meijer-core/src/dispatch-rules/bateman-5-6.ts` — the 6
  Bessel-emitting dispatch rules.
- `packages/meijer-core/src/bridges/bessel.ts` — I6's forward bridge
  (~360 LOC, exported as `headToMeijerGBessel` / `meijerGToHeadBessel`).
- `docs/refs/besselj-research/R4-meijer-g-bridge.md` §E — the original
  Phase 0 survey + per-rule round-trip analysis.
- `docs/worklog/138-meijer-g-erf-closure-validation.md` — Erf T3
  styling exemplar (1-arg version of this pattern).
- `docs/worklog/155-i6-bessel-meijer-bridge.md` — I6's bridge worklog
  (prerequisite).
- ADR-0041 §"Decision 5" — bridge API + 4 canonical G-forms.

## Pre-existing gaps (NOT T3 findings)

R4 §E.3 surfaced two gaps in Phase 0; both pre-filed:

- `scientist-workbench-1xqq` (P2) — no `BesselY`-emitting dispatcher
  rule today. The standalone `meijerGToHeadBessel` covers BesselY at
  the bridge layer, but the symbolic dispatcher's pattern table does
  not yet reduce to it. Filed for post-T3 follow-up.
- `scientist-workbench-lfet` (P2) — same gap for `BesselI`.

Neither blocks the Bessel epic v0.1 close (the bridge covers the
standalone case; future dispatch rules can land additively).
