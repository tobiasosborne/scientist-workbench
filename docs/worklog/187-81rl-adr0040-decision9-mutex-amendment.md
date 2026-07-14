# 187 — ADR-0040 §Decision 9 amendment: tier mutex acknowledged, arbprec-only + 53-bit BigFloat wrap canonical (closes `81rl`)

**Date:** 2026-07-14.
**Bead:** `scientist-workbench-81rl` — *Runner mutex prevents per-output
tier conditioning: `{numerical:true, arbprec:true}` → amend ADR-0040
§Decision 9* — successor to the bead every prior cross-reference names
as `gp75` (ADR-0041/0042, worklogs 142/163); `gp75` no longer
exists in the tracker.
**Ground truth:** `packages/contract/src/execute.ts` (the mutex and the
per-output platform write), `tools/special-eval/tool.ts` (the shipped
cross-tier dispatch), ADR-0015/0020/0040.

## Context

ADR-0040 §"Decision 9 — Determinism tier carried per-output" designed
`tools/special-eval` to annotate `{ numerical: true, arbprec: true }`
with the live tier decided per-invocation by `--precision`. The contract
runtime forbids that: `executeToolDef` admits at most one of
{`nondeterministic`, `numerical`, `arbprec`} and throws `ToolError`
otherwise. The T2 build (worklog 139) shipped the workaround — declare
`arbprec: true` only, wrap float64-lane results in 53-bit BigFloat on
the wire — and ADR-0041/0042 inherited it "until the ADR amendment in
bead `gp75` lands." This session landed that amendment, choosing option
(A) from the bead (document the mutex, canonise the wrap) over lifting
the mutex (option B) or splitting the tool (option C).

## What changed

**Verification first (5-reader fan-out).** The bead's claims were
re-verified against the current repo before writing. Confirmed: the
mutex, the arbprec-only declaration, the 53-bit wrap, the never-written
`platform` field. Corrected en route:

* The mutex is NOT at `packages/contract/src/runner.ts:137-146` (the
  citation bead 81rl and worklog 139 both carry) — it has lived in
  `executeToolDef` (`packages/contract/src/execute.ts`) since it was
  born with the ADR-0015 implementation (2026-05-04, two-way;
  generalized three-way with ADR-0020). Git pickaxe shows no mutex
  ever existed in `runner.ts`: the filename was wrong from birth, only
  the line numbers were right (they match `execute.ts`, where the
  check sits at 137-149 today). It fires per-execution on every entry
  point, subprocess and in-process alike.
* The float64 lane is NOT `--precision ≤ 53`: the flag is decimal
  digits, and the shipped cut is `--precision ≤ 15` (decimal ≈ the
  53-bit binary64 mantissa; `tool.ts` `useFloat64 = precisionDecimal
  <= 15`). Even special-eval's own literate header carried the `≤ 53`
  error; ADR-0040's Decision 1 table and §Decision 9 bullets did too.
* §Decision 9's "default `--precision=53` → float64" is doubly wrong:
  the ADR-0020 default is 50 decimal digits, which routes the
  **arb-prec** lane.
* The fingerprint gap is *doubly* structural: even if the mutex were
  lifted, `containsFloat64(output)` would still be false — the wire
  value is `tagged "bigfloat"` over integers, no float64 leaves. Any
  option-B fix would need a new detection mechanism, not just a lifted
  mutex; this strengthened the case for option (A).

**The amendment set (Law 2 lockstep, one edit session):**

* `docs/adr/0040-…md` — §Decision 9 gains the canonical amendment
  paragraph (mutex, corrected thresholds/defaults, `executeToolDef`
  not `runMemoized`, the accepted fingerprint loss, option-B declined
  rationale, gp75→81rl lineage); the Decision 1 wire-surface table row
  and §"Why the wire tool annotates per-output tier conditionally" get
  pointer notes; Status line updated. Original text left in place as
  the historical record (house style: annotate, never rewrite).
* `docs/adr/0015-determinism-tier.md` — item 4 (the platform-write
  branch) gains the cross-reference amendment: cross-tier tools'
  ≤ 53-bit lane is outside this ADR's fingerprint promise, for the two
  independent reasons above; Related list gains ADR-0040.
* `docs/adr/0041-…md` / `docs/adr/0042-…md` — all five "until bead
  `gp75` lands" passages get landed-notes (ADR-0041 §Decision 7,
  §Decision 9, §"Per-output tier dispatch carries the `gp75`
  workaround"; ADR-0042 §Decision 7, §Decision 9): the wrap is
  canonical now, threshold corrected, lineage recorded — the dangling
  `gp75` references resolve. (The first draft annotated only three;
  the review pass below caught the two ADR-0041 misses.)
* `tools/special-eval/tool.ts` — literate header: `≤ 53` → `≤ 15
  decimal` fixed; §"Why arbprec: true and not numerical: true"
  rewritten from provisional ("a future ADR can lift the mutex") to
  canonical, stating plainly that **no special-eval call ever writes a
  provenance `platform` field** and why, and correcting the over-claim
  that the BigFloat wrap makes the float64 lane "bit-deterministic
  across runtimes" (the *encoding* is deterministic; the float64
  *computation* feeding it may depend on the platform's float runtime
  — exactly ADR-0015's tier, minus its fingerprint). Example 1's stale
  description ("default precision (53-bit float64 lane)" — the default
  routes arb-prec) fixed. README regenerated from the header
  (`bun run gen-tool-readme`); the renamed example description renamed
  its golden file (content byte-identical; `--tool special-eval`
  regeneration, 71/71 green).
* Soft-wording strengthened where the mutex was stated as "mutually
  exclusive *in practice*": CLAUDE.md determinism callout (now
  "runner-enforced: `executeToolDef` throws"), `docs/contract.md`,
  `PRD-v0.2.md`, and the `runner.ts` doc-comments on `numerical` /
  `arbprec` (which also mislabelled the throw as "load-time" — it is
  per-execution; `execute.ts`'s own comment fixed likewise). CLAUDE.md,
  contract.md and the `arbprec` doc-comment also gain the one-sentence
  cross-tier convention so an agent reading any of the three normative
  surfaces sees it.
* Review-driven additions (see Frictions): ADR-0020 gains a
  sanctioned-exception amendment note on its no-float64 rule (mirrored
  in the `runner.ts` `arbprec` doc-comment); the
  `arbprec-deterministic-cross-platform` invariant statement is scoped
  to `--precision > 15` with the ≤ 15 lane disclosed;
  `scripts/gen-tool-readme.ts`'s mechanical determinism line keys a
  float64-lane caveat on the `tier-dispatch-by-precision-flag`
  invariant; the ADR-0040 amendment states the store-scoped
  memoization rider and the ADR-0015 amendment the
  `runMemoized`-cannot-platform-skip consequence.

## Why these choices

Option (A) preserved ADR-0040's unified-wire-surface decision at zero
code blast radius, and the verification showed option (B) was even more
expensive than the bead estimated (mutex lift + a per-output platform
detection that BigFloat encoding structurally defeats). The caller's
`--precision ≤ 15` choice *is* the informed waiver — with the honest
store-scoped rider now stated in the amendment: unfingerprinted
≤ 15-lane records are admissible to `runMemoized`/`lookup` on every
platform, so cross-platform cache hits may serve bytes a local
recomputation would not bit-reproduce. A caller needing the
cross-platform contract passes `> 15`.

`gen-tool-readme.ts`'s mechanical determinism line ("bit-identical
cross-platform forever…") initially looked uncorrectable — no manifest
flag distinguishes cross-tier arbprec tools from pure ones — until the
review pass pointed out the regenerated README asserted the
unconditional claim at the top and retracted it in its own How-it-works
section. The declared `tier-dispatch-by-precision-flag` invariant *is*
the manifest marker for "this tool is cross-tier": the generator now
keys the float64-lane caveat on it, and the same scoping fix landed in
the `arbprec-deterministic-cross-platform` invariant statement (whose
"on any runtime / arch / os at any `--precision`" claim contradicted
the amended header) and as a sanctioned-exception note on ADR-0020's
no-float64 rule.

## Frictions surfaced

* `bun run goldens` (full-corpus) exceeds a 2-minute timeout and its
  write-mode **sweeps each tool's goldens dir before rewriting** — the
  killed run left `tools/oracle/goldens/` swept-but-unwritten (caught
  via `git status`, restored from git). Use `--tool <name>` for
  targeted regeneration; a sweep-then-write killed mid-batch silently
  deletes goldens.
* Stale-citation propagation: bead 81rl and worklog 139 both cite the
  mutex at `runner.ts:137-146` — a filename wrong *from birth* (git
  pickaxe: the mutex was born in `execute.ts` with ADR-0015; no
  refactor ever moved it) wearing correct-looking line numbers.
  Plausible citations get copied, not re-derived; re-verify before
  amending ADRs (Rule 3). The review pass caught this shard's own
  first draft inventing a "moved by the ADR-0012 refactor" story to
  explain the mismatch — a fabricated cause is worse than an
  unexplained one.
* The 4-lens adversarial review (findings individually
  refutation-verified) caught six real defects in the first draft of
  this change: the worklog-139 lineage claim, the fabricated refactor
  story, two missed ADR-0041 landed-notes, the contradicting
  `arbprec-deterministic-cross-platform` invariant, the contradicting
  generated determinism line, and the caller-vs-store scoping gap in
  the option-B-declined rationale. A second consistency sweep
  (replacing a lens the first run lost to an API error) caught seven
  more missed *old* surfaces: an interior tool.ts comment still
  asserting the platform field IS written for the float64 lane (the
  exact claim this bead retracts, one file section away from the fix),
  the un-amended "load-time / in practice" mutex text in ADR-0015
  item 1 and ADR-0020 (two spots), ADR-0040 §Decision 7's stale flag
  spec, the methodology handoff still teaching `≤ 53`, `v1-gamma`
  test-file comments, ADR-0041's `--precision=53` acceptance bullet
  (routes arb-prec under shipped semantics), plus the ADR-0041/0042
  Related-header `gp75` citations and a missing pointer in
  `packages/compose/src/lookup.ts` where the store-scoped waiver
  actually behaves. Docs-only changes earn the review gate too — and
  one sweep is not enough.
* The `gp75` → `81rl` rename left four documents' worth of dangling
  bead references that nothing tracked. Renamed/compacted beads that
  are cited in ADRs need their citations updated at rename time.

## Acceptance

* Bead acceptance criteria met: ADR-0040 §Decision 9 amendment
  paragraph ✓; ADR-0015 cross-reference ✓; special-eval README states
  the no-platform-field fact (via the regenerated header section) ✓.
* `bun scripts/generate-goldens.ts --tool special-eval`: 71 written,
  0 failures/mismatches.
* `bun run gen-tool-readme`: regenerated special-eval README, 55
  others current. `gen-catalog`: already current (summary unchanged).
* Full `bun run check`: 111 passed, 7 skipped, 0 failed.

## Pointers

* ADR-0040 §Decision 9 amendment (the canonical statement)
* ADR-0015 item 4 amendment; ADR-0041 §"Per-output tier dispatch
  carries the `gp75` workaround"; ADR-0042 §Decisions 7/9 notes
* `tools/special-eval/tool.ts` §"Why arbprec: true and not
  numerical: true" (regenerates into the README)
* `packages/contract/src/execute.ts` — the mutex + platform write
* Worklogs 139 (the collision), 142 (friction #12), 163 (T2 Bessel)
