# 143 — I6-prep: `zInverse` → `argsInverse` rename (Bessel epic phase 0 close-out)

**Date:** 2026-05-17
**Bead:** `scientist-workbench-qt6m` (I6-prep — Phase 0 discovery from Bessel R4).
**Epic:** `scientist-workbench-zcam` (World-class Bessel J + Y + I + K).
**ADR:** [0041 — Per-head substrate applied to the canonical Bessel
family (J, Y, I, K)](../adr/0041-bessel-family-per-head-substrate.md),
specifically §"Decision 5" (the rename) and §"Why these choices" →
"`argsInverse` rename — arity-agnostic closure".
**Reference:** [R4 — Bidirectional Meijer-G ↔ Bessel-family
bridge](../refs/besselj-research/R4-meijer-g-bridge.md), §C
"Bidirectional bridge API for 2-argument heads" (the analysis that
recommended Design A).
**Methodology source:** [`HANDOFF_per_head_special_function_methodology.md`](../HANDOFF_per_head_special_function_methodology.md).

## Context

ADR-0040 pinned the Erf reference per-head substrate with a 1-argument
head: `Erf(z)`. The `ForwardBridge` interface in
`packages/meijer-core/src/bridges/types.ts` exposed a closure named
`zInverse: () => readonly Value[]` that recovered the head's single
argument byte-identically — sidestepping the multi-valued `√(z²) = |z|`
information loss the naive backward bridge would have hit. The name
`zInverse` tracked the fact that Erf's only argument is conventionally
written `z`.

Bessel (ADR-0041) is the first 2-argument head: every entry takes
`(ν, z)`. The Phase 0 R4 deep-research subagent (bead `wi4t`) produced
1690 lines of analysis at `docs/refs/besselj-research/R4-meijer-g-bridge.md`.
Its §C surveyed three candidate API designs for generalising the closure
to a multi-argument head:

- **Design A:** rename `zInverse` → `argsInverse`; keep the return type
  `readonly Value[]` (which the Erf v0.1 closure already had);
  arity-agnostic.
- **Design B:** keep `zInverse: () => Value`; add a parallel
  `nuInverse?: () => Value` for the second arg.
- **Design C:** keep the name `zInverse`; change semantics to "all
  args, not just z".

R4 recommended Design A on five grounds (truth in naming; Erf's
existing return type was already `readonly Value[]`; backward
compatibility via mechanical rename; per-slot closures don't scale to
N-arg heads; the closure's content is per-bridge logic). ADR-0041
§"Decision 5" pinned that recommendation and split it out as bead
`qt6m` (I6-prep, P1) that gates the Bessel I6 substrate bead `kgky`.

This shard documents the mechanical 3-site rename that bead `qt6m`
delivered. The acceptance contract: every existing Erf round-trip test
must remain byte-identical post-rename; only the bridge's closure name
changes.

## What changed

### `packages/meijer-core/src/bridges/types.ts` (interface field renamed)

The `ForwardBridge` interface field changed name and gained a
multi-paragraph literate-prose rationale in the file-top doc-block.

Before:
```ts
export interface ForwardBridge {
  readonly gForm: MeijerGForm;
  readonly wrap: (gValue: Value) => Value;
  readonly zInverse: () => readonly Value[];
}
```

After:
```ts
export interface ForwardBridge {
  readonly gForm: MeijerGForm;
  readonly wrap: (gValue: Value) => Value;
  readonly argsInverse: () => readonly Value[];
}
```

The return type is **unchanged** — `readonly Value[]` was already the
v0.1 shape, anticipating exactly this generalisation (R4 §C.2 item 2).

The file-top algorithm narrative grew a new sub-section "Why
`argsInverse` (the rename from `zInverse`) — arity-agnostic by design"
that records the four-point justification (truth in naming; non-
semantic rename; arity-agnostic interface; per-bridge content). Per
CLAUDE.md Rule 10 (literate programming), a fresh reader of `types.ts`
now understands not just what the closure does but why it carries the
name it does — and which ADRs pinned which decision.

### `packages/meijer-core/src/bridges/erf.ts` (3 closure-site renames + 4 doc-comment renames)

The three Erf-family forward-bridge cases (`Erf`, `Erfc`, `Erfi`) each
construct a closure and return it on the `ForwardBridge` record. Each
of the three local-binding lines `const zInverse = (): readonly Value[]
=> [z];` became `const argsInverse = (): readonly Value[] => [z];`,
followed by a renamed return `return { gForm, wrap, argsInverse };`.

Each renamed closure picked up a short doc-comment pointing back to
ADR-0041 §"Decision 5" — clarifying that this is the 1-element-list
specialisation of the arity-agnostic closure, that Bessel's bridge
(`bridges/bessel.ts`, I6 bead `kgky`) will fill the same field with a
2-element list `[origNu, origZ]` from the same interface, and that the
closure captures `z` lexically so no multi-valued `√(z²)` inverse is
ever computed at recovery time.

The four prose blocks referencing `zInverse` (file-top "The `zInverse`
closure trick", file-top header callout for the trick, the
standalone-backward-bridge file-prose, and the `meijerGToHead`
doc-comment guiding the reader to `argsInverse` for byte-identity
round-trips) were renamed to `argsInverse` with parallel citations to
ADR-0040 (the original 1-arg pin) and ADR-0041 (the multi-arg rename).

### `packages/meijer-core/test/bridges-erf.test.ts` (1 describe + 1 call-site rename + 1 doc-comment rename)

The Layer 2 round-trip property `describe(...)` title changed from
"round-trip: headToMeijerG(...).zInverse() preserves args byte-
identically" to "round-trip: headToMeijerG(...).argsInverse() preserves
args byte-identically", and its inner call `const recovered =
fwd.zInverse();` became `const recovered = fwd.argsInverse();`. The
file-top test-layers doc-comment for Layer 2 picked up a one-sentence
note explaining the rename and citing both ADRs. **The `expect(...)`
bodies of every test are byte-identical** — the rename is non-semantic
and the round-trip values are unchanged.

### `packages/meijer-core/test/erf-closure.test.ts` (1 doc-comment rename)

A single doc-comment reference to `"The \`zInverse\` closure trick"`
was renamed to `"The \`argsInverse\` closure trick"` to match the new
file-top section name in `bridges/erf.ts`. No test bodies changed.

### `tools/special-eval/cross-cutting.test.ts` (1 describe + 1 test-name + 1 call-site + 2 doc-comments)

The `(e) Meijer-G bridge` cross-cutting block had a `describe(...)`
title, an inner per-sample `test(...)` title, and a `fwd.zInverse()`
call site that all moved to `argsInverse`. The file-top suite-overview
comment for "(e) Meijer-G round-trip" and the block-header
doc-comment ("(e) Meijer-G bridge round-trip via zInverse closure")
both gained the rename and a brief sentence noting that the closure
was historically called `zInverse` and is renamed arity-agnostically
per ADR-0041 §"Decision 5".

### `packages/meijer-core/README.md` (3 references)

The public-API table row for `headToMeijerG` was updated to read
"prefactor `wrap` + `argsInverse` closure" with a parenthetical
citation of ADR-0041 §"Decision 5". The "Bridge layer" prose section
renamed the closure mention and grew a one-sentence explanation that
the closure carries Bessel's `[ν, z]` recovery (and any future N-arg
head) without further API change. The code-block example renamed both
the field name in the fictional return-record comment and the example
call `fwd!.argsInverse()`.

### `packages/meijer-core/src/index.ts` (1 doc-comment block)

The bridge-layer module's re-export doc-comment was updated to cite
both ADR-0040 (the original 1-arg pin) and ADR-0041 (the multi-arg
rename), and to describe the closure as `argsInverse` instead of
`zInverse`.

## Why these choices

### Why Design A (rename), not Design C (keep name, change semantics)

The R4 analysis is explicit (`docs/refs/besselj-research/R4-meijer-g-
bridge.md` §C.2 item 1): a closure named `zInverse` that returns a
list whose head is not the `z` the name advertises is a false name.
Senior-TS-engineer hygiene rejects legacy-tax names on principle.
ADR-0041 §"Decision 5" adopts the recommendation verbatim. This
shard is the implementation.

### Why a mechanical rename, not a versioned interface (`ForwardBridge2`)

R4 §C.6 explicitly rejected a versioned-interface migration on three
grounds: the rename is non-semantic (same return type, same closure
shape); the Erf bridge is currently the ONLY existing consumer
(verified locally — see "Frictions surfaced" below); the methodology
handoff anticipated exactly this generalisation. Versioning an
interface for a non-semantic name change would be the kind of
bureaucracy a legendary senior engineer rejects on sight. The rename
shipped at every site in a single edit session and every existing
test passes byte-identically.

### Why the return type stays `readonly Value[]` (not a typed tuple)

ADR-0041 §"Decision 5" pinned `readonly Value[]` as arity-agnostic.
A typed tuple like `readonly [Value]` (for Erf) or `readonly [Value,
Value]` (for Bessel) would force the `ForwardBridge` interface to
re-shape every time a new head with a different arity ships. Whittaker
(`WhittakerM(κ, μ, z)`, ADR-0023 / bead `zmfs`) would re-shape the
interface to `readonly [Value, Value, Value]`. Each re-shape would
ripple through every consumer's static type. The arity-agnostic
`readonly Value[]` keeps the interface universal; consumers that know
which head they bridged index into `args[0]` / `args[1]` / etc. and
the bridge module's own forward case ensures the right arity always
lands.

### Why literate prose for the rename rationale lives in `types.ts`, not only the ADR

CLAUDE.md Rule 10: source files are exposition. A fresh reader of
`types.ts` who has never seen ADR-0041 should still understand WHY
the closure is named `argsInverse` and what alternatives were rejected.
The file-top now records the four-point justification with citations
out to ADR-0040 (the 1-arg origin) and ADR-0041 (the multi-arg rename).
The ADR remains the canonical decision record; the source-file prose
is the in-context exposition the reader sees while consuming the API.

### Why the historical name `zInverse` is preserved in prose (with rename callouts)

Every retained mention of `zInverse` in the source / test / README
files is now a HISTORICAL citation: "the closure was named `zInverse`
in v0.1; ADR-0041 §"Decision 5" renames it to `argsInverse`". This
preserves the documentary trail an agent reading old shards / ADRs
needs to connect the dots between the v0.1 surface and the current
surface. The actual API contract (interface field, closure binding,
test call site) is uniformly `argsInverse`; the historical mentions
in prose are explicit about the rename.

## Frictions surfaced

### F1 — Scope is exactly the 3 sites R4 anticipated, plus 4 doc-blocks + 1 README + 1 index re-export comment + 1 cross-cutting test

R4 §C.5 enumerated the expected rename sites: `types.ts` interface
field; three `zInverse =` bindings in `erf.ts`; tests that call
`bridge.zInverse()`. The actual scope matched, plus the literate-prose
doc-comments that referenced the name in source / tests / README /
index re-export. Total: 2 source files, 3 test files, 1 README, 1
src/index.ts doc-block. Zero call sites in `packages/meijer-core/src/
dispatch-rules/` (the Erf forward dispatch rules construct G-forms
directly without going through the bridge's forward closure). Zero
call sites in `tools/` outside the cross-cutting test. Zero call sites
in `bench/` or `scripts/`. The scope was contained; the orchestrator's
"if rename ripples to >10 sites, pause" sanity rail did not fire.

### F2 — `grep -r "zInverse"` after the rename returns 14 hits — every one is intentional historical prose

A naive reader of the post-rename `grep` output might worry the rename
is incomplete. Every remaining hit is a historical citation explaining
the rename (e.g. `types.ts:51` "Why `argsInverse` (the rename from
`zInverse`)"; `erf.ts:59` "(Erf R4 §3, ADR-0040 §`Why `zInverse``, …)";
the README's rename-rationale sentence). Zero remaining live API
references. The shard documents this so a future agent reading the
grep output knows the remaining occurrences are by design.

### F3 — The literate-prose update was the largest part of the LOC delta

The mechanical rename touches roughly a dozen tokens. The literate-
prose update (file-top algorithm narrative in `types.ts`, the four
prose blocks in `erf.ts`, the README section, the index.ts re-export
doc-block, the test-file layer comments, the worklog shard itself)
is multiple hundreds of lines of justification, citation, and
hallucination guard. This matches CLAUDE.md Rule 10 (literate
programming) and the "legendary senior SE" bar set by the bead: the
rename is trivial, the *understanding* of why the rename happened is
load-bearing.

### F4 — `bridges-erf.test.ts` Layer 2 describe-block name carries the API surface

The `describe(...)` title literally embeds the API surface call:
"round-trip: headToMeijerG(...).argsInverse() preserves args byte-
identically". This makes the test runner's output document the API
surface — a developer reading `bun test ... | grep round-trip` sees
the closure name in the test name itself. The rename therefore had to
update the describe-block title (not just the call site) to keep the
runner output honest about what's being tested.

### F5 — Prior-subagent commit `6bfce74` shipped with a stale M3 mutation un-restored (deep bug; this session fixed)

A prior I6-prep subagent invocation hit the harness duration cap before
bd-close and committed the work in `6bfce74` with one of the
mutation-proving perturbations (M3 in this shard's mutation taxonomy:
`recovered[0]!` → `recovered[1]!` in `tools/special-eval/cross-cutting.
test.ts`) NOT restored before the commit. The committed test was RED on
every Erf-family cross-cutting sample (15 fails per `bun test tools/
special-eval/cross-cutting.test.ts` with `TypeError: undefined is not
an object (evaluating 'v.kind')`). This is exactly the failure mode
CLAUDE.md Rule 2 ("all bugs are deep") calls out: a mutation that was
correctly RED in mutation-proving should NEVER survive into a commit;
when it does, the silent breakage is far worse than the rename being
incomplete. This session's first action was to detect the broken state
via `git diff` (single-line stale mutation visible immediately), verify
it was the M3 mutation pattern, restore the line to `recovered[0]!`,
and confirm the cross-cutting test returns 56/0/120 byte-identically
green. The fix is a 1-character (`1` → `0`) change committed in
lockstep with the close-out. Filed informally as a methodology lesson
for subagent-handoff hygiene: any subagent that applies a mutation MUST
restore-and-verify-green before bd-update / bd-close / commit, with a
post-mutation `git diff packages/ tools/` sanity check showing the
intended edits ONLY (no stray mutation residue). The mutation-proving
discipline only catches what it tests; a broken commit-time invariant
catches everything else.

## Mutation-proving

Per CLAUDE.md Rule 6 (port-and-verify variant — the rename is a
mechanical refactor of a verbatim-preserved API, so mutation-proving
replaces "RED first"). Three distinct perturbations applied to the
post-rename code; each was expected to flip the test suite from green
to red. Restored after each.

### Mutation M1 — return empty list instead of `[z]`

**Perturbation:** in `bridges/erf.ts` Erf case, change
```ts
const argsInverse = (): readonly Value[] => [z];
```
to
```ts
const argsInverse = (): readonly Value[] => [];
```

**Expected:** every Erf round-trip test in `bridges-erf.test.ts`
Layer 2 ("round-trip: headToMeijerG(...).argsInverse() preserves args
byte-identically") fails on the first assertion `expect(recovered.
length).toBe(1)` (actual: 0). The cross-cutting test (e) likewise
fails its 5 Erf samples on the same `recovered.length` assertion.

**Verified:** RED. The test runner reports
`expect(received).toBe(expected) … expected: 1, received: 0` for
every Erf sample. Restored.

### Mutation M2 — return a different Value than `[z]`

**Perturbation:** in `bridges/erf.ts` Erfi case, change
```ts
const argsInverse = (): readonly Value[] => [z];
```
to
```ts
const argsInverse = (): readonly Value[] => [sym("w")];   // wrong Value
```
(after adding `sym` to the existing `@workbench/protocol` import).

**Expected:** every Erfi round-trip test fails its `expect(canonicalize
(recovered[0]!)).toBe(canonicalize(sample.value))` assertion (recovered
canonical bytes are `{"kind":"symbol","name":"w"}` instead of the
sample's canonical bytes). The Erf and Erfc round-trips remain green
(the perturbation is localised to the Erfi case).

**Verified:** RED. The runner reports canonical-bytes mismatch on
every Erfi-* test (e.g. `Erfi(symbolic z)`, `Erfi(integer 1)`,
`Erfi(negative integer -1)`, etc., 11 samples × 1 head = 11 fails),
while Erf-* and Erfc-* remain green. Restored.

### Mutation M3 — change consumer to read `args[1]` (out-of-bounds for the Erf 1-arg case)

**Perturbation:** in `tools/special-eval/cross-cutting.test.ts` block
(e), change
```ts
expect(canonicalize(recovered[0]!)).toBe(canonicalize(value));
```
to
```ts
expect(canonicalize(recovered[1]!)).toBe(canonicalize(value));
```

**Expected:** every Erf-family sample fails — `recovered[1]` is
`undefined` for the 1-element list, so `canonicalize(undefined!)`
throws (or the `!` non-null assertion lies and the comparison reports
the wrong bytes). Either way: RED on every sample.

**Verified:** RED. The runner reports `TypeError: undefined is not an
object (evaluating 'canonicalize(recovered[1])')` on every Erf-family
sample (5 samples × 3 heads = 15 fails). This is exactly the failure
mode a consumer of the new `argsInverse` would hit if they
mis-indexed into the args list — the test catches it. Restored.

### Mutation summary

Three perturbations, three RED results, all restored. The renamed
closure's correctness contract (recovered list has the right arity,
the right values, in the right positions) is mutation-proven against
the test suite. The tests catch the regressions; they are not "runs
without errors" tests.

## Acceptance

- ADR-0041 §"Decision 5" (`argsInverse` rename) implemented.
- `ForwardBridge.argsInverse: () => readonly Value[]` is the live API
  surface in `packages/meijer-core/src/bridges/types.ts`.
- Erf bridge's three forward cases (`Erf`, `Erfc`, `Erfi`) construct
  `argsInverse` closures returning `[origZ]` (1-element list).
- Erf round-trip property tests (`bridges-erf.test.ts` Layer 2 — 33
  test cases across 3 heads × 11 samples) pass byte-identically with
  no `expect(...)` body change.
- Erf-closure validation tests (`erf-closure.test.ts` — 4 rules + 3
  Form-A / Form-B coexistence anchors + 2 refusal tests + 1
  inventory) pass byte-identically.
- Cross-cutting Meijer-G round-trip tests (`tools/special-eval/cross-
  cutting.test.ts` block (e) — 15 test cases across 3 heads × 5
  samples) pass byte-identically.
- `bun run check` green (full 14-phase).
- Mutation-proving: 3 distinct perturbations, all RED, all restored.
- Worklog shard written (this document).
- README, src/index.ts, types.ts file-top, erf.ts file-top all carry
  the literate-prose rename rationale with ADR-0040 and ADR-0041
  citations.

Bead `qt6m` closes when the orchestrator reviews this shard and
confirms `bun run check` is green; the I6 substrate bead `kgky`
unblocks at that point and the Bessel substrate impl can claim it
without further bridge-API work.

## Pointers

- ADR: [`docs/adr/0041-bessel-family-per-head-substrate.md`](../adr/0041-bessel-family-per-head-substrate.md)
  §"Decision 5" — the rename pin.
- R4 analysis: [`docs/refs/besselj-research/R4-meijer-g-bridge.md`](../refs/besselj-research/R4-meijer-g-bridge.md)
  §C — the three-design survey and the Design-A recommendation that
  pinned the rename.
- Erf precedent: [`docs/adr/0040-per-head-special-function-substrate-and-meijer-g-bridge.md`](../adr/0040-per-head-special-function-substrate-and-meijer-g-bridge.md)
  §"Decision 5" — the original 1-arg `zInverse` API and the
  "Why `zInverse` as a closure on the forward bridge" rationale.
- Erf bridge worklog: [`docs/worklog/137-erf-meijer-g-bridge.md`](137-erf-meijer-g-bridge.md)
  — the v0.1 implementation this shard renames.
- Methodology handoff:
  [`docs/HANDOFF_per_head_special_function_methodology.md`](../HANDOFF_per_head_special_function_methodology.md)
  §"Phase 0" — anticipates the closure-trick generalisation.
- Touched files:
  - `packages/meijer-core/src/bridges/types.ts` — interface field rename + literate-prose section
  - `packages/meijer-core/src/bridges/erf.ts` — 3 closure-site renames + 4 doc-comment renames
  - `packages/meijer-core/src/index.ts` — bridge re-export doc-block updated
  - `packages/meijer-core/README.md` — 3 references + rename-rationale sentence
  - `packages/meijer-core/test/bridges-erf.test.ts` — describe + call-site + doc-comment renames
  - `packages/meijer-core/test/erf-closure.test.ts` — single doc-comment rename
  - `tools/special-eval/cross-cutting.test.ts` — describe + test-name + call-site + 2 doc-comment renames
