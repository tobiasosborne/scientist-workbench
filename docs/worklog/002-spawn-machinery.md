# 002 — F1+F2: subprocess plumbing centralised

**Date:** 2026-04-28
**Status:** complete
**Issues:** scientist-workbench-rpb.1 (closed)
**ADR:** [docs/adr/0001-subprocess-plumbing.md](../adr/0001-subprocess-plumbing.md)

## Context

The workbench is a polyglot of bun processes spawning bun processes:
`scripts/check.ts` runs each tool's `--test` hook then asks `oracle` to
diff goldens, which itself spawns the tool under test;
`scripts/generate-goldens.ts` regenerates goldens by piping fresh inputs
through every tool; `tools/registry-list` and `tools/registry-search`
invoke each tool's `--schema` / `--version` / `--examples` /
`--invariants` flags to build their results. Six call sites total, plus
the new `scripts/validate-tournament-ntt.ts` from shard 001.

Every one of those call sites had its own:

```ts
const BUN_CMD = process.env["BUN_BIN"] ?? "bun";
spawn(BUN_CMD, args, ...);
```

In a vanilla install, `which bun` returns a path, `spawn(...)` works,
and nobody thinks about it. The trouble started when porting 02-NTT on
this machine — bun installed via snap. `which bun` reports
`/snap/bin/bun`, which is a symlink to `bun-js.bun`, itself a wrapper.
Spawning it from inside another snap-confined Bun process fails with:

```
Error: cannot join mount namespace of pid 1: Operation not permitted
```

The actual binary lives at `/snap/bun-js/current/_bun/bin/bun`. Spawn
that directly, everything works.

Two compounding bugs amplified the failure:

1. The default fallback `"bun"` (string, not absolute path) silently
   resolves to the snap symlink and degrades — *unless* the user knows
   to `export BUN_BIN=/snap/bun-js/current/_bun/bin/bun`.
2. `tools/registry-search` and similar swallowed `describeTool`
   failures with bare `try { ... } catch { continue; }`. On a snap
   install where every spawn fails, the loop produces an empty list —
   indistinguishable from "no tool matched the filter."

## What changed

A single new module — `packages/contract/src/spawn.ts` — owns "where
is `bun`?" Exports:

```ts
resolveBunBinary(): string         // realpath-collapsed, smoke-tested, cached
spawnBun(args, stdin?): Promise<SpawnResult>
```

Resolution order:

1. honour `BUN_BIN` if set
2. else `process.execPath` if running under bun (`globalThis.Bun !== undefined`)
3. else PATH walk for `bun`
4. `realpathSync` the result (collapses snap symlinks to real binary)
5. smoke-test by `spawnSync(real, ["--version"])` — fails loud if the
   resolved binary can't be invoked
6. cache for the rest of the process

Step 2 was added after step 4 alone proved insufficient: inside a
snap-confined bun process, `existsSync('/snap/bin/bun')` returns false
(the snap mount-namespace hides its own anchor). `process.execPath` is
the most authoritative source — the path of the binary actually
running this code.

Five call sites migrated to `spawnBun`:

- `packages/contract/src/registry.ts` (`describeTool` queries each tool's
  metadata flags)
- `tools/oracle/tool.ts` (runs the tool under test)
- `scripts/generate-goldens.ts` (regenerates per-tool goldens)
- `scripts/check.ts` (typecheck, bun test, per-tool --test, oracle phases)
- `scripts/validate-tournament-ntt.ts` (cross-validator)

The silent catch in `tools/registry-search/tool.ts` was replaced with
a counted, logged failure path:

```ts
catch (err) {
  describeErrors++;
  process.stderr.write(`registry-search: describe ${name} failed: ${err.message}\n`);
  continue;
}
```

with a per-result tally line at end of run if any failed. `registry-list`
already followed this pattern; the ADR codifies it.

## Why these choices

**Single owner over per-site fallbacks.** Six call sites with the same
defensive code duplicates the bug. One ADR, one module, six imports.

**`process.execPath` over PATH walk under bun.** PATH walking via
`existsSync` was attractive — until snap. The `globalThis.Bun` runtime
hint plus `execPath` is the cleanest answer; PATH is the fallback for
plain-Node consumers and tests.

**Smoke-test cost the ~10 ms.** Tempting to skip and let downstream
spawn surface the error. We took the cost: the alternative is a
mysterious failure ten seconds into a check run, which is much worse
than a 10 ms startup cost on the first call.

**Loud failures, not silent.** The behaviour change is the point.
`registry-search` returning an empty list when 9/9 tools failed
metadata-probe was the worst-case bug: not a wrong answer, just a
truthful-looking lie.

## Frictions surfaced

The smoke-test caught a corner I hadn't anticipated: snap-confined bun
can't `existsSync` its own `/snap/bin/bun` symlink path. That motivated
adding the `process.execPath` fallback (step 2 above). Without it, even
running `bun tools/registry-search/tool.ts` directly from a shell
where `bun` worked would fail inside the resolver.

## Acceptance

- `bun run check` passes with `BUN_BIN` *unset* — was previously
  required.
- Cross-validator: 64/64 tournament cases pass with `BUN_BIN` unset.
- Bad `BUN_BIN` (`BUN_BIN=/nonexistent/bun`) gives a loud, descriptive
  error at the *first* spawn point, not a silent empty result ten
  phases in.
- `registry-search` with a deliberately broken tool logs the failure
  to stderr and emits a tally line.

## Pointers

- ADR-0001 — captures the decision and the bug-history.
- `packages/contract/src/spawn.ts` — the literate-programming source
  with the resolution-ladder reasoning inline.
- `packages/contract/README.md` — public surface of the contract
  package, including `spawnBun`.
- main `README.md` §Substrate — agent-facing note about snap installs.
- `CLAUDE.md` — conventions section: "use `spawnBun`, never
  `node:child_process`."
