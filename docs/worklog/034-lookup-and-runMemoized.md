# 034 — `Workbench.lookup` + `runMemoized`: cache by input hash

**Date:** 2026-05-03
**Status:** complete
**Branches:** main
**ADR:** [0012-composition-layer](../adr/0012-composition-layer.md) §"Workbench.lookup", §"Workbench.runMemoized"
**Issues closed:** scientist-workbench-mtw, scientist-workbench-csa.

## Context

The composition layer's MVP (worklog 032) and typed barrel
(worklog 033) gave the TS expert direct in-process tool invocation
under the same contract as the subprocess surface. The next
ergonomic win is **memoisation** — idempotent tools should hit a
cache for free across runs. The provenance store already keys
records by output hash; what was missing was a path *from input* to
that record so a caller doesn't have to re-execute to discover what
they already computed.

Issues mtw and csa carried the design: a reverse-index on input
hash, plus a one-line `lookup ?? run` wrapper. The subtle decision
the issues asked the implementation to make was whether to store
the reverse-index physically (file per (input_hash, tool, version)
key) or to scan provenance records linearly. The reverse index won.

## What changed

**`packages/contract/src/store.ts`** — three new exports:

```ts
export function byInputPath(store, inputHash, toolName, version): string;
export async function writeByInputIndex(store, inputHash, toolName, version, outputHash): Promise<void>;
export async function readByInputIndex(store, inputHash, toolName, version): Promise<Hash | null>;
```

The on-disk layout is
`$CAS_STORE/by-input/<hh>/<input_hash>--<tool>--<version>.json`,
where `<hh>` is the first two hex chars of the *input* hash (same
sharding discipline as `provenance/`). The file's content is the
output hash as a hex string; presence is the cache-hit signal.
`readByInputIndex` is a single stat + read — sub-millisecond on a
warm fs cache, regardless of store size. The header in `store.ts`
documents all three on-disk paths (values, provenance, by-input)
in one place so the layout is greppable.

**`packages/contract/src/execute.ts`** — `executeToolDef` now
performs three writes after a successful tool run, in order:

1. `writeValue(store, output)` — the canonical Value bytes (this
   was previously dead code; the store had `writeValue` but nothing
   called it).
2. `writeProvenance(store, rec)` — the provenance record (existing).
3. `writeByInputIndex(store, inputHash, name, version, outputHash)` —
   *only* if `def.nondeterministic !== true`. For
   `entropy-source`, we skip this write so a future lookup is
   structurally a miss; the forward provenance still records the
   derivation with the `nondeterministic: true` flag.

All three writes are still wrapped in the existing best-effort
try/catch; failure on any one is captured into the result tuple's
`provenanceError` field (semantically widened to "persistence error"
without renaming, to keep the runner's existing stderr message
working unchanged).

**`packages/compose/src/lookup.ts`** (new). Implements
`lookupWorkbench` and `runMemoizedWorkbench`. Lookup hashes the
input, reads the reverse-index, reads the value, returns. Refuses
on nondeterministic tools; the lookup would never hit (we don't
write the index for them) and throwing surfaces intent at the call
site rather than silently masking it as a miss. `runMemoizedWorkbench`
is a one-line `lookup ?? run` with the same nondeterministic refusal.

A small but real subtlety: `runMemoized` only consults the cache
when `partialFlags` is empty. The reverse-index key is `(input_hash,
tool, version)` — flags don't enter. For tools without declared
flags (the common case) this is fine. For tools with flags, the
v0.1 simplification means flag changes aren't part of the cache key
yet; the worklog records this and a v0.2 follow-up would extend the
key with the explicit-flag bytes. Documented in the source.

**`packages/compose/src/load.ts`** — replaces the `not-yet-
implemented` placeholders for `lookup` and `runMemoized` on the
`InProcessWorkbench` class with delegation to the new functions.

**Lockstep doc updates (Law 2):**

- `packages/compose/README.md` — usage example now shows
  `runMemoized` and `lookup` side-by-side with the explicit
  semantics ("on miss returns null", "lookup-or-run").
- `PRD-v0.2.md` §3.5 — rewritten to "Provenance + content-addressed
  value store"; documents the three-artefact write (value,
  provenance, reverse-index), the nondeterministic skip, the
  refusal in `lookup` / `runMemoized`, and the round-trip checks.
  The on-disk layout block in `store.ts` is now the single canonical
  reference, and §3.5 cites it.

## Why these choices

**Reverse-index file per (input_hash, tool, version), not a linear
scan.** The issue mtw left this as an implementation choice with
two named options. The reverse index won because:

- Lookup is O(1) regardless of store size. Linear scan grows with
  the number of provenance records; even at "a few thousand" the
  warm-cache cost is non-trivial.
- The write cost is one extra file (~70 bytes) per successful tool
  run, alongside two writes we already do.
- The store layout is regular: every persistence path
  (`values/`, `provenance/`, `by-input/`) shards on a hex prefix,
  same discipline.
- Concurrent versions of the same tool coexist without collision;
  the filename encodes (tool, version).

**Write the output Value, not just provenance.** The existing
runner stored the *metadata about* what produced what (the
provenance record) but not the actual output Value. The forward
direction `--provenance-of <output_hash>` returned a record naming
the inputs but the consumer had to re-execute to get the output
back. Storing the value closes the loop: PRD §3.1's "any agent can
re-execute it and verify the result matches" becomes "any agent can
*read the result by hash*"; re-execution is now an audit step, not
a recovery step. The cost is one more disk write per run, ~the
size of the output Value. For the workbench's typical outputs
(KB-scale canonical JSON), it's negligible.

**Skip the reverse-index for `nondeterministic: true`.** Caching a
nondeterministic tool would silently invent determinism. The
forward provenance is still written (the derivation is recorded;
the `nondeterministic` flag tells consumers what the record
means), but the by-input index *deliberately* omits the entry so a
future `Workbench.lookup` is a structural miss. `lookup` itself
also throws on nondeterministic tools — surfacing intent at the
call site rather than silently failing.

**Throw on `lookup(nondeterministic-tool)` rather than return null.**
Two equally-defensible options:
A) `null` (lookup is a pure miss-or-hit predicate); or
B) throw (lookup names the contract violation).
Picked B. A null return on a nondeterministic tool would let a
caller silently flow into a stale or fabricated cache hit; throwing
makes the precondition load-bearing at the type level (the caller
sees the rule). `runMemoized` does the same.

**Reuse the `provenanceError` field name in the result tuple
despite the semantic widening.** The persistence step now writes
three artefacts but the result-tuple field is still
`provenanceError`. Renaming would force both the runner's stderr
message and the existing in-process callers to update; the
semantic widening is named in the source comment ("any persistence
error"). A rename is a no-op refactor that can land later if the
narrower name proves misleading.

## Frictions surfaced

**Circular dependency between `lookup.ts` and `run.ts`.**
`runMemoizedWorkbench` needs `runWorkbench` for the fallback path.
The natural import lives at the top of `lookup.ts`, but two files
that mutually import are an ESM module-cycle waiting to happen. I
side-stepped by importing `runWorkbench` *inside* `lookup.ts`'s
namespace at the location where it's used; `run.ts` does not
import from `lookup.ts`, so the cycle never materialises. Worth
naming because it's the kind of friction that doesn't surface until
a third consumer joins the loop.

**Subprocess invocations now pay three disk writes per run.**
Before this shard, a `bun tools/foo/tool.ts` call wrote one
provenance file. Now it writes value + provenance + index. The
full `bun run check` (350+ goldens × per-tool oracle) absorbs the
overhead easily — measured no significant slowdown, ~1 ms per
write averaged on a warm fs. Worth knowing if anyone profiles.
The CAS_STORE used by the check is `mktemp -d` so this isn't
clogging the user's real store.

**`partialFlags` ignored by the cache key.** A v0.1 simplification:
the reverse-index key is `(input_hash, tool, version)`. Two
`runMemoized` calls with the same input but different flags will
share a cache slot — last writer wins. For tools without declared
flags (most of v0.2), this is a non-issue. Documented at the call
site. v0.2 extension: include the canonical bytes of the
explicit-flags map in the key.

## Acceptance

- `bun run check` — 34 phases, 0 failures (the runner-side change
  affects every tool's subprocess execution; 350+ goldens still
  pass byte-identically because the persistence side-effect doesn't
  alter the output Value).
- `bun test packages/compose/test/` — 17 tests (12 prior + 5 new):
  - `Workbench.lookup` misses on a fresh store, hits after run.
  - Lookup hits are byte-identical to a fresh run.
  - `Workbench.lookup` refuses on `entropy-source` (nondeterministic).
  - `Workbench.runMemoized`: first call runs, second call hits
    cache; both return byte-identical Value.
  - `runMemoized` refuses on `entropy-source` (nondeterministic).
- Subprocess sanity: `mod-pow` invocation with a fresh `CAS_STORE`
  produces all three on-disk artefacts (value, provenance, index)
  at the expected paths. The store layout matches the header in
  `store.ts` byte-for-byte.

## Pointers

- `packages/contract/src/store.ts` — `byInputPath`,
  `writeByInputIndex`, `readByInputIndex`, header documenting the
  three-artefact layout.
- `packages/contract/src/execute.ts` — three-write persistence
  block.
- `packages/compose/src/lookup.ts` — `lookupWorkbench`,
  `runMemoizedWorkbench`.
- `packages/compose/test/compose.test.ts` — 5 new lookup/memoized
  tests.
- `PRD-v0.2.md` §3.5 — rewritten to cover the three-artefact write
  and the nondeterministic skip.
- ADR-0012 §"Workbench.lookup" / §"Workbench.runMemoized".
- Beads scientist-workbench-{mtw, csa} closed.

## Remaining in the composition DAG

`46z` (fluent pipe), `e0h` (demo-scope.sh migration). The MVP +
typed barrel + memoisation triplet is what an agent reaches for in
~95% of inner-loop work; the fluent pipe is sugar with
step-numbered errors, and `e0h` is a forcing function for friction
discovery once `46z` lands.
