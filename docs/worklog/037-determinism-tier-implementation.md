# 037 — ADR-0015 implementation: numerical tier wired end-to-end

**Date:** 2026-05-04
**Status:** complete (all six items from ADR-0015 §"Decision" landed,
all branches mutation-proven, full check green)
**Branches:** main
**ADR:** [0015-determinism-tier](../adr/0015-determinism-tier.md)
**Issues closed:** none yet (the design-pass bead `0ck` already closed
in shard 036; this shard is the implementation behind it).
**Issues filed:** none.

## Context

Worklog 036 landed ADR-0015 as a design pass: the cross-Bun-version
measurement, the additive design, the lockstep doc updates. This
shard implements the design end-to-end. The six items from
ADR-0015 §"Decision" all land in this session; mutation-proving
confirms the load-bearing branches are testable; the substrate's
existing 16 linalg-solve goldens still pass byte-equal (the platform
field lives in *provenance*, not in tool *output*, so the byte
contract is preserved).

## What changed

**`packages/protocol/src/walk.ts`** (new). Single export
`containsFloat64(v: Value): boolean` — exhaustive switch over the
closed 10-kind discriminator, short-circuit on the first hit. Cost
O(value size) worst case, O(1) on lucky early-hit. Nine unit tests in
`walk.test.ts` cover every kind, realistic linalg-solve output shape,
realistic exact-symbolic Sturm distribution shape, and the buried-
float64 edge case.

**`packages/contract/src/platform.ts`** (new). Owns the runtime
fingerprint: `currentPlatform()` (reads `process.platform`,
`process.arch` normalised to `x86_64`/`aarch64`/`i386`, runtime
detected via `Bun` global), `platformToValue` / `valueToPlatform`,
`platformHash`, `currentPlatformHash`, `platformFingerprintValue`,
`platformFingerprintBytes`. Three-field `PlatformRecord`
(`{arch, os, runtime}`) — exactly what worklog 036's measurement
justified, no more.

**`packages/contract/src/runner.ts`**. Added `numerical?: boolean`
field to `ToolDefinition` (parallel to `nondeterministic?`, same
optional-flag pattern). Added `--platform-fingerprint` to the
`STANDARD_FLAGS` table; dispatch case in `runTool` calls
`platformFingerprintBytes()`. The flag does no work — pure read of
`process.{arch,platform}` + runtime detection — and is the
discoverability surface for the agent's planner.

**`packages/contract/src/provenance.ts`**. Added `platform?:
PlatformRecord` field to `ProvenanceRecord`; `provenanceToValue`
emits the `platform` key only when present (omitted-when-absent
discipline, same as `nondeterministic`); `valueToProvenance` round-
trips it. Symbolic records' bytes remain byte-identical to their
pre-ADR-0015 form — verified by an explicit `byte-identical to
pre-ADR-0015` test that asserts the canonical string does NOT contain
`"platform"`.

**`packages/contract/src/execute.ts`**. Two additions:
1. **Step 0 — mutual-exclusion check.** A tool asserting both
   `nondeterministic: true` and `numerical: true` fails at the top of
   `executeToolDef` with a `ToolError` that names ADR-0015. Lives
   here (not in `defineTool`) so the failure surfaces consistently
   across every entry point — including in-process callers that
   bypass the runner.
2. **Per-output platform branch.** After output canonicalisation,
   before the writes: if `def.numerical === true && containsFloat64
   (output)`, set `rec.platform = currentPlatform()` and capture
   `currentPlatformHash()` for the reverse-index filename. Same tool,
   different inputs can produce different-tier outputs — the
   provenance reflects what was *actually* computed, per ADR-0007's
   `precision: "exact" | "float64"` precedent.

**`packages/contract/src/store.ts`**. `byInputPath` /
`writeByInputIndex` / `readByInputIndex` gain an optional
`platformHash: Hash | null` argument. When non-null, the filename
suffix `--<platformHash>.json` is appended; symbolic records' index
files keep their pre-ADR-0015 path verbatim (no migration needed).
Two-platform records coexist as two distinct index files for the
same `(input, tool, version)` triple.

**`packages/compose/src/lookup.ts`**. `lookupWorkbench` extended:
for tools with `def.numerical === true`, the running platform's hash
is included in the index lookup key. Symbolic tools' lookup is
unchanged (the platform hash is null, the filename is the pre-ADR
form). One-line change inside the lookup — the rest of the function
is untouched.

**`tools/linalg-solve/tool.ts`**. Added `numerical: true` to the
`defineTool({...})` call with a literate comment pointing at ADR-0015
and ADR-0007. One-line annotation; the rest of the tool is untouched.
Existing 16 goldens still pass byte-equal (oracle-verified by the
full `bun run check`).

## Tests

**Nine new unit tests for `containsFloat64`** in
`packages/protocol/test/walk.test.ts`.

**Twelve new tests in `packages/contract/test/contract.test.ts`**:
- platform helper shape (currentPlatform fields, value round-trip,
  platformHash agreement on equal triples / divergence on different,
  platformFingerprintValue carries record + hash);
- ProvenanceRecord platform round-trip + symbolic-bytes-byte-identical;
- executeToolDef per-output branch: numerical+float64 → platform
  field; numerical+exact → no platform field; symbolic+float64
  output → no platform field (no opt-in); numerical record's
  by-input index includes platform hash in filename;
- mutual exclusion: a tool asserting both flags fails at
  executeToolDef;
- `--platform-fingerprint` standard flag: emits parseable record
  with valid 64-hex hash field.

**Three new tests in `packages/compose/test/compose.test.ts`**:
- linalg-solve same-platform: lookup hits after a run;
- linalg-solve foreign-platform record (fabricated by writing the
  index with a fake platform hash): lookup honestly misses; the
  foreign provenance record IS still in the store, carrying its own
  platform field;
- symbolic tool's lookup is unaffected by platform (mod-pow sanity).

**Mutation-proven on three perturbations:**
1. Skip the platform write entirely (`if (false && ...)`) → 2 tests
   fail RED. Restored → 51 pass.
2. Force `lookupWorkbench`'s `platformHashForLookup` to null → 1
   test fails RED (the same-platform-hits test). Restored → 23 pass.
3. Make `containsFloat64` always return false → 9 tests fail RED
   (the dedicated walk tests + the executeToolDef tests that depend
   on it). Restored → 60 pass.

## End-to-end verification

```sh
bun tools/linalg-solve/tool.ts --platform-fingerprint
# → {"fields":{"fingerprint":{"fields":{"arch":{...,"value":"x86_64"},"os":{...,"value":"linux"},"runtime":{...,"value":"bun"}},...},"hash":{...,"value":"7ed77a07..."}},...}

bun tools/mod-pow/tool.ts --platform-fingerprint
# → identical fingerprint + hash (same running platform, regardless of tool)
```

After running `linalg-solve` with `CAS_STORE` set to a fresh dir:
```sh
bun tools/linalg-solve/tool.ts --provenance-of <output_hash>
# → record { ..., "platform":{"arch":"x86_64","os":"linux","runtime":"bun"}, ... }
```

After running `mod-pow`:
```sh
bun tools/mod-pow/tool.ts --provenance-of <output_hash>
# → record { ... }   ← no "platform" key. Byte-identical to pre-ADR-0015.
```

The agent-irresistibility payoff verified end-to-end: a planner
reading a numerical tool's `--provenance-of <hash>` sees *which*
platform computed it, can compare to its own `--platform-fingerprint`
without re-invoking the tool, and decides admissibility before
spending compute.

## Why these choices (compact recap)

The design rationale is in ADR-0015; the implementation honoured
each named-decision verbatim:

- **`numerical: true` parallel to `nondeterministic: true`** — same
  optional-flag pattern; rejected the unified-tier-enum alternative
  to keep byte-compat and pattern consistency with ADR-0005.
- **Per-output tier conditioning** — `containsFloat64(output)` walks
  the actual output; the platform field is recorded only when the
  output truly has float64 leaves. Same tool can produce different-
  tier outputs (precedent: ADR-0007's `precision`).
- **Three-field `PlatformRecord`** — exactly the fields the
  measurement justified. `runtime_version` deliberately omitted to
  avoid spurious cache misses on Bun upgrades.
- **Lookup-key extension via filename suffix** — different-platform
  records coexist in the store as different index files. Symbolic
  records' filenames unchanged; numerical records' filenames carry
  the platform hash. The lookup function knows which form to look
  for via `def.numerical`.
- **`runMemoized` cache miss returns `null`, not a tagged
  `samePlatform: false`** — the TS expert wants `runMemoized` to
  mean "give me a hit that would match running this here." A
  different-platform record does not satisfy that precondition;
  honest miss + opt-in `--provenance-of` discoverability is the
  right surface area trade.

## Frictions surfaced

**1. Bun installer ignores `BUN_INSTALL` env var.** When trying to
install Bun 1.2.21 to a separate prefix (`BUN_INSTALL=$HOME/.bun-1.2`),
the installer wrote to `~/.bun/bin/` regardless. Workaround: install
1.2.21 (which overwrote the existing latest), copy the binary to
`~/.bun-1.2.21/bin/bun`, then re-install latest to `~/.bun/bin/`.
Both bun versions then coexist; the measurement script can be invoked
under each. **Lesson:** if a future agent wants two Bun versions
side-by-side, plan to copy-then-reinstall rather than trying to use
the installer's prefix flag.

**2. `bd bootstrap --yes` produced a wrong DB.** Documented in
worklog 036 friction (5). Re-confirmed here: `bd import
.beads/issues.jsonl` is the right command after a fresh-clone
bootstrap.

**3. The platform-aware `byInputPath` introduces a backward-compatible
filename schema bifurcation.** Symbolic records' filename is
`<inputHash>--<tool>--<version>.json`; numerical records' is
`...--<platformHash>.json`. The lookup function chooses based on
`def.numerical`, which is fine — but if a tool's `numerical` flag
were ever toggled (false → true) without re-running, old records
would be unfindable from the new lookup path. Filed mentally as a
non-issue today (no tool toggles its annotation), worth naming as a
potential future migration if it becomes one.

**4. `--platform-fingerprint` is a bool flag with no value, but
`STANDARD_FLAGS` formatting needed alignment.** Cosmetic only — the
help-text alignment could be improved if the standard flag list grows
much further. Not a blocker.

**5. Multiple system-reminder nudges to use TaskCreate.** Same as
shards 028–036. Per CLAUDE.md Rule 9 ignored; using beads exclusively.

## Acceptance

- All six items from ADR-0015 §"Decision" landed in code.
- `bun run check` green: 34 phases pass, 4 skipped, 0 failed (~60s
  full check).
- 9 + 12 + 3 = 24 new tests, all passing.
- Mutation-proven on three perturbations (containsFloat64,
  executeToolDef branch, lookup platform conditioning); each fails
  RED with the perturbation, GREEN with restore.
- 16 linalg-solve goldens still pass byte-equal — the platform field
  is in *provenance*, not in *output*, so the public byte contract
  is preserved.
- Symbolic-bytes byte-identical: confirmed by an explicit test
  asserting `"platform"` does not appear in symbolic provenance bytes,
  and by `mod-pow --provenance-of` producing a record without the
  platform key end-to-end.

## Pointers

- `docs/adr/0015-determinism-tier.md` — design.
- `packages/protocol/src/walk.ts` — `containsFloat64`.
- `packages/contract/src/platform.ts` — fingerprint helpers.
- `packages/contract/src/runner.ts` — `numerical?` field +
  `--platform-fingerprint` standard flag.
- `packages/contract/src/provenance.ts` — `platform?` field on
  `ProvenanceRecord`.
- `packages/contract/src/execute.ts` — mutual-exclusion check + per-
  output platform branch.
- `packages/contract/src/store.ts` — platform-suffixed reverse index.
- `packages/compose/src/lookup.ts` — platform-aware lookup.
- `tools/linalg-solve/tool.ts` — `numerical: true` annotation.
- `packages/{protocol,contract,compose}/test/*.test.ts` — the new
  tests.
- `docs/worklog/036-determinism-tier.md` — the design pass that
  preceded this.
