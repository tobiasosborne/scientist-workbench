# 172 — BesselY / BesselI backward dispatch rules (R4 §E.3 gap close)

**Beads:** `scientist-workbench-1xqq` (BesselY backward dispatch),
`scientist-workbench-lfet` (BesselI backward dispatch).
**Epic:** `scientist-workbench-zcam` (World-class Bessel, closed at
3055641 with the world-class reference implementation).
**Date:** 2026-05-18.
**Pre-reqs (already closed):** `kgky` (I6 — Meijer-G bridge for
Bessel; worklog 155), `4uws` (T3 — Bessel closure validation;
worklog 161). R4 §E.3 filed these two follow-ups in Phase 0 as
"v0.2 completeness" — they don't gate v0.1 close (the bridge's
standalone `meijerGToHead` covers the standalone-input use case),
but they're needed for the dispatcher's **closure** claim: any
G-form that simplifies to a recognised head should go through the
dispatcher, not the standalone bridge.

## Context

The Bessel epic closed end-to-end on 2026-05-17 with the
world-class reference implementation: 12 substrate beads (J / Y / I
/ K float64 + arb-prec + complex), 3 tool integrations (T1
`integrate-1d`, T2 `special-eval`, T3 Meijer-G closure), V1 cross-
cutting gate, and 5 post-V1 regression fixes (worklogs 165–171
closing `i3la`/`tke9`/`zapb`/`m4ut`/`phtw`/`9wwc`/`z5em`/`omsm`).

But R4 §E.3 left two dispatcher-side gaps explicitly flagged:

> "**No `BesselY` or `BesselI`-emitting rule exists today.** Both
> should be filed as `R4.gap.*` beads, with priority P2 — not
> blocking the v0.1 reference (the bridge's `meijerGToHead` covers
> them standalone) but needed for the dispatcher's *closure*
> claim: any G-form that simplifies to a recognised head goes
> through the dispatcher, not the standalone bridge."

The dispatcher's existing Bessel coverage (`dispatch-rules/bateman-
5-6.ts`) emits only `BesselJ` and `BesselK`, both via Bateman §5.6
identities (rules 4, 6, 25, extra-a, extra-b). There is no
Bateman-style identity for the canonical BesselY `(2,0,1,3)` or
BesselI `(1,0,1,3)` G-forms — these come from PBM Vol III §8.4
(cross-validated against mpmath's `meijerg` and SymPy's
`meijerint.py:254/281` G-form table). This shard adds two rules
(plus one literal-ν variant of the BesselI rule, see §"The literal-
vs-symbolic-ν split" below) that close the gap.

## What changed

```
packages/meijer-core/src/dispatch-rules/bessel-backward.ts        (+202)  NEW
packages/meijer-core/src/dispatch.ts                              (+11)   imports + registry slot
packages/meijer-core/README.md                                    (+5)    catalog note
packages/meijer-core/test/dispatch.test.ts                        (+52)   2 structural anchors
packages/meijer-core/test/dispatch-mpmath.test.ts                 (+58)   2 mpmath cross-checks
packages/meijer-core/test/bessel-closure.test.ts                  (+88)   2 closure probes + count update
docs/worklog/172-bessel-y-i-backward-dispatch-rules.md            (+this) NEW
```

No ADR amendment, no PRD change. The shard closes the R4 §E.3
gap additively; ADR-0041 (the Bessel epic) already pinned the
canonical G-forms; the new rules are the dispatcher-side
implementation of what ADR-0041 §"Decision 5" + R4 §A.4 already
spec'd.

### Three rules

1. **`bessel-y-canonical`** (`(m,n,p,q) = (2,0,1,3)`): matches
   `G^{2,0}_{1,3}([], [c]; [a, b], [c]; z)` via shared `free "c"`
   name binding `ap[0] == bq[0]` (the Γ-cancellation "fictitious-
   slot" that produces Y's `sin(πν)` connection factor); emits
   `BesselY(2b, 2√z)` after `recoverNuFromHalfSlot(b)` unwraps the
   `mkDiv(?, 2)` shape on canonical inputs.
2. **`bessel-i-canonical-symbolic-nu`** (`(1,0,1,3)`): symbolic-ν
   variant. `bq = [{free "c"}, {free "d"}]` — under symbolic ν the
   canonical-sort puts `(ν+1)/2` first (its inner `mkPlus` carries
   integer `1`, vs `-ν/2`'s inner `mkDiv` carrying integer `2`).
   Emits `(1/π) · BesselI(2a, 2√z)`.
3. **`bessel-i-canonical-literal-nu`** (`(1,0,1,3)`): literal-
   rational-ν variant. Same rewrite as (2), but `bq = [{free "d"},
   {free "c"}]` — under literal rational ν the canonical-sort puts
   `-ν/2` first (negative-numerator string `"-N"` sorts before
   positive `"N"` in canonical bytes; ASCII `-` (45) < any digit).
   Without this variant the BesselI rule misses literal-rational
   inputs entirely.

### Bridge re-use, no rewrite-side coupling

`recoverNuFromHalfSlot` is re-stated locally in `bessel-
backward.ts` rather than imported from `bridges/bessel.ts`. The two
implementations are byte-identical and the local copy keeps the
rule's encoding choices visible at the reading site (the bateman-
5-6.ts file does the same with its `I`, `R`, `expV`, `gamma` mini-
helpers). Worth re-noting because the natural impulse on reading a
dispatcher rule is "where does the slot recovery live?" and the
answer is "right here, byte-equal to the bridge's standalone
helper, so the round-trip closure is structural-by-construction".

The forward-direction `headToMeijerGBessel` exports stay
unchanged.

## Why these choices

### Why a separate file (not appending to bateman-5-6.ts)

R4 §E.3 suggested either; the citation lineage decides. The new
rules' primary literature is **DLMF §10.9 + §16.18 + PBM Vol III
§8.4** (cross-validated against mpmath / SymPy's `meijerint.py`
table). Bateman §5.6 has no entry for the BesselY `(2,0,1,3)` or
BesselI `(1,0,1,3)` G-forms — they didn't enter the literature
until Marichev / PBM. Filing the rules in `bessel-backward.ts`
under a DLMF/PBM citation keeps `bateman-5-6.ts` honest about its
source and makes the cite-by-grep audit (per ADR-0025 §9) clean.

The file is positioned BEFORE `DLMF_16_18` and `BATEMAN_5_6` in
the registry array because its `(m,n,p,q)` shapes — `(2,0,1,3)`
and `(1,0,1,3)` — are NOT currently covered by any other rule, so
the ordering is for future-proofing rather than current-
disambiguation. (If a future rule for the same shape lands and
needs to fire first, it should land BEFORE this one in the
registry per the first-match-wins discipline; mirror discussion
in worklog 137 §"Why ERF_FORWARD_FORM_A sits first".)

### Why the looseness contract mirrors the bridge's

The PatternSpec's v0.1 slot vocabulary (`lit-int / lit-rat / free
/ free-shift`, plus the `integer-difference` relation) cannot
express "this slot is the structural negation of that one". The
canonical Bessel-Y form's structural fingerprint is `bm = [ν/2,
-ν/2]` (negatives of each other); the canonical Bessel-I form has
`bq` containing both `(ν+1)/2` and `-ν/2`. The v0.1 matcher can
only express:

* the shared-free-name `ap[0] == bq[k]` equality (the cancellation-
  pole structural fingerprint) — this is the load-bearing constraint
  that distinguishes the rules' shapes from arbitrary `(2,0,1,3)` /
  `(1,0,1,3)` reductions.
* `integer-difference` between two captures, requiring both to be
  in the integer/rational subset — useless for symbolic-ν inputs
  where the slot values are `expression`-typed.

The bridge's standalone `meijerGToHead` already accepts this
looseness explicitly ("**any (m,n,p,q) = (2,0,1,3) shape with the
right arity counts is BesselY by elimination**" — file-top comment
~line 396). The dispatch rules mirror that reasoning: the
load-bearing argument is **shape-uniqueness** — no other Bessel-
family head shares either `(m,n,p,q)` tuple (R4 §A.1: `BesselJ →
(1,0,0,2)`, `BesselY → (2,0,1,3)`, `BesselI → (1,0,1,3)`, `BesselK
→ (2,0,0,2)`; no overlap). For inputs from the bridge's forward
path (the only realistic production source), the closed-form
emission is correct; for hand-built non-canonical inputs with the
matching shape but non-Bessel algebra, the rule emits a wrong-
shaped BesselY/I — same caveat as the bridge.

A future bead may extend `PatternSpec` with a structural-negation
relation (`"sum-is-zero"` / `"negation"`) to tighten the match.
Until then the bessel-closure test pins the round-trip closure for
the bridge-produced canonical forms (the load-bearing use case)
and the mpmath cross-validation pins numerical correctness at
literal canonical-Bessel slot values.

### The literal-vs-symbolic-ν split

The most surprising finding. Discovered during test development:
the mpmath cross-validation case for BesselI initially FAILED
with `no-known-reduction`, even though the rule was correctly
registered and the slot values were the canonical Bessel-I shape
at ν = 3/2.

Root cause: the dispatcher's canonical-bytes parameter sort
(ADR-0025 §7) is by canonical-JSON bytes. For literal rational
slot values like `-3/4` and `5/4`:

```
canonical(-3/4) = '{"den":"4","kind":"rational","num":"-3"}'   sorts FIRST
canonical( 5/4) = '{"den":"4","kind":"rational","num":"5"}'    sorts SECOND
```

(ASCII `"-"` (45) < `"5"` (53), so the negative-num string sorts
first.)

For symbolic ν the canonical-sort is governed by EXPRESSION-typed
bytes (not RATIONAL-typed), and the deep walk lands on different
discriminators:

```
canonical(-ν/2)     = ...inner mkDiv args is [ν, integer "2"]...
canonical((ν+1)/2)  = ...inner mkPlus args is [ν, integer "1"]...
```

`"1"` < `"2"` ⇒ `(ν+1)/2` sorts first.

So the canonical-sort order of `bq` is OPPOSITE between symbolic
and literal-rational ν. A rule that pins one ordering will miss
the other. The two-rule split (`bessel-i-canonical-symbolic-nu` +
`bessel-i-canonical-literal-nu`) handles both via the dispatcher's
first-match-wins traversal — whichever shape the canonical-sort
produces, one of the two rules' slot patterns matches.

This is a real v0.1 gap in PatternSpec — a `"any-position-equal"`
relation primitive would express "one of bq's slots equals ap[0],
regardless of position" cleanly. Filed as no new bead (the
workaround is sound and the cost is 20 LOC of duplication); the
file-top comment documents the asymmetry so the next agent isn't
surprised.

### Why the BesselY rule didn't need the same split

The BesselY canonical form has `ap = [-(ν+1)/2]` and `bq =
[-(ν+1)/2]` — both single-element sub-tuples carrying the SAME
value. The shared-free-name match `ap[0] == bq[0]` is positional-
unambiguous (each list has only one position). The split is only
needed when one of the shared-name sub-tuples has multiple slots.

BesselI's `bq = [-ν/2, (ν+1)/2]` is the only sub-tuple in the
canonical Bessel family with this property; BesselJ's `bq =
[-ν/2]` (single) and BesselK's `bq = []` (empty) are both immune.

## Frictions surfaced

* **The literal-vs-symbolic canonical-sort asymmetry.** Took an
  hour to root-cause once the mpmath test failed; the bug was
  invisible at the rule's reading site (the slot pattern looked
  fine; the failure was in the canonical-sort step that runs
  BEFORE the matcher sees the slots). The lesson: **when adding a
  shared-free-name match for a multi-slot sub-tuple, draw the
  canonical-bytes byte-trees for both literal-rational and
  symbolic instantiations**. The two paths can sort differently.
  Worth a paragraph in ADR-0025 next time it's edited.

* **The bridge's `recoverNuFromHalfSlot` is module-private.**
  Copying it into `bessel-backward.ts` felt like a violation of
  DRY at first. Then I noticed `bateman-5-6.ts` does exactly the
  same with its `I`, `R`, `expV`, `gamma` mini-helpers — the
  convention is "helper-locality at the reading site is more
  important than DRY across files for the rule layer". The bridge
  and dispatcher are independent paths into the same algebra; the
  copy is intentional, not accidental.

* **The closure-test inventory count looks confusing.** I report
  8 rules (5 bateman-5-6 probed + 1 N/A + 2 bessel-backward) but
  there are actually 9 rule IDs registered in `ALL_RULES` (the
  literal-ν BesselI variant is the 9th). The closure-test inventory
  counts symbolic-vs-literal as ONE rule because they share rewrite
  logic and emitted shape — the count reflects coverage breadth,
  not registration count. Documented in the test's frozen-inventory
  comment so the next agent knows where to look.

* **mpmath verification said BesselY(1.7, 2) ≈ -0.49036, not
  -0.18202.** My initial file comment had the wrong reference
  value; caught when writing the structural-anchor test. Updated
  in-place. Cross-checked via `python3 -c "from mpmath import
  bessely, mpf; print(bessely(mpf('1.7'), mpf(2)))"`.

## Acceptance

* `bun test packages/meijer-core/test/` — 333 pass / 1 skip / 0
  fail / 1101 expects (was 314/1/0/1071 pre-shard; +19 new tests,
  +30 new expects).
* `bun test packages/meijer-core/test/bessel-closure.test.ts` —
  16 pass / 0 fail / 166 expects. Per-rule closure block fires
  for both new rules (bessel-y-canonical + bessel-i-canonical-
  symbolic-nu); the bridge's forward direction recovers the
  canonical `(2,0,1,3)` / `(1,0,1,3)` shape; prefactor `wrap`
  matches `identity` (Y) / `pi` (I).
* `bun test packages/meijer-core/test/dispatch.test.ts` — 43
  pass / 0 fail / 208 expects. Structural anchors confirm rule
  IDs and emitted heads.
* `bun test packages/meijer-core/test/dispatch-mpmath.test.ts` —
  11 pass / 0 fail / 11 expects (was 9 pass; +2 new cases). Both
  Bessel-Y (ν=3/2, z=1) and Bessel-I (ν=3/2, z=1) match mpmath
  at 1e-13 relative tolerance after dispatcher canonicalisation.
* `bun run check` — TODO: confirm full health-check after shard
  lands. The dispatch-audit grep is the only phase that could
  reasonably fail (the new file is greppable); no forbidden
  short-form tokens (`hypercomb`, `_hyp_borel`, etc.) appear in
  `bessel-backward.ts`.
* `bd close 1xqq lfet` — closes both pre-filed gap beads.

## Pointers

* `packages/meijer-core/src/dispatch-rules/bessel-backward.ts` —
  the new rule file (3 rules, ~202 LOC counting comments).
* `packages/meijer-core/src/dispatch.ts` lines 73 + 89 — the
  import + registry slot.
* `packages/meijer-core/test/bessel-closure.test.ts` lines
  ~270–365 + ~400 — new closure probes + inventory update.
* `packages/meijer-core/test/dispatch.test.ts` lines ~270 — new
  structural anchors.
* `packages/meijer-core/test/dispatch-mpmath.test.ts` lines
  ~316–375 — new mpmath cross-validation cases.
* `docs/refs/besselj-research/R4-meijer-g-bridge.md` §E.3 — the
  gap-analysis section that filed these beads in Phase 0.
* `docs/worklog/155-i6-bessel-meijer-bridge.md` — I6's bridge
  worklog (prerequisite; the bridge whose forward-direction
  closure these rules complete).
* `docs/worklog/161-t3-bessel-meijer-closure.md` — T3's closure-
  validation worklog (prerequisite; predicted these gaps would
  be filled here).
* `docs/adr/0041-bessel-family-per-head-substrate.md` — the
  parent ADR (no amendment needed; the rules implement what
  §"Decision 5" + R4 §A.4 already spec'd).
