# ADR-0001 — Subprocess plumbing: who owns "where is `bun`?"

**Status:** Accepted (2026-04-28)
**Context:** beads issue scientist-workbench-rpb.1 (F1+F2)
**Supersedes:** —

## Context

The workbench is a polyglot of bun processes spawning bun processes:

```
scripts/check.ts     ──spawns──▶  tools/<name>/tool.ts        (--test, --schema, …)
scripts/check.ts     ──spawns──▶  tools/oracle/tool.ts        (goldens harness)
scripts/generate-    ──spawns──▶  tools/<name>/tool.ts        (regen goldens)
  goldens.ts
tools/oracle/        ──spawns──▶  tools/<target>/tool.ts      (under-test pipe)
  tool.ts
tools/registry-      ──spawns──▶  tools/<name>/tool.ts        (--schema/--version probe)
  list/tool.ts
tools/registry-      ──spawns──▶  tools/<name>/tool.ts        (same)
  search/tool.ts
scripts/validate-    ──spawns──▶  tools/ntt/tool.ts           (cross-validation)
  tournament-ntt.ts
```

Each call site previously had its own `BUN_CMD = process.env.BUN_BIN ?? "bun"`
fallback. Spawn either succeeds, or fails with whatever errno the OS surfaces.

The failure mode that motivates this ADR was discovered porting tstournament
02-NTT into sci-wb on a snap-Bun install:

- `which bun` → `/snap/bin/bun`
- `/snap/bin/bun` is a symlink to `bun-js.bun`, itself a wrapper script
- spawning `/snap/bin/bun` from inside another snap-confined Bun process
  fails with `cannot join mount namespace of pid 1: Operation not permitted`
- the *real* binary lives at `/snap/bun-js/current/_bun/bin/bun` — that
  spawns fine.

Two compounding problems made the failure invisible:

1. The default fallback `"bun"` is name-only; `spawn()` resolves it via
   `PATH` to the snap symlink, which fails. Unless the user knows to
   `export BUN_BIN=/snap/bun-js/current/_bun/bin/bun`, every script silently
   degrades.
2. Several call sites swallow the failure with `try { … } catch { continue; }`.
   The most damaging instance is `tools/registry-search/tool.ts`, which on a
   snap install returns an empty list — indistinguishable from "no tool
   matched the filter."

## Decision

A single owner for "how to invoke bun" lives in `packages/contract/src/spawn.ts`,
exporting:

```ts
export function resolveBunBinary(): string
export function spawnBun(args: string[], stdin?: string): Promise<SpawnResult>
```

The resolver:

1. reads `BUN_BIN` if set;
2. else `PATH`-resolves `bun`;
3. **`realpathSync`s the result** so symlinks (notably the snap chain)
   collapse to the real executable path;
4. **smoke-tests the result** by `spawnSync(real, ["--version"])` — if that
   fails, throws a diagnostic error naming the resolved path and the
   underlying errno;
5. caches.

`spawnBun` uses the resolver. Every internal call site migrates to it.

Silent-catch sites that currently swallow `describeTool`/spawn failures
(notably `tools/registry-search/tool.ts`) replace `catch { continue; }` with:

```ts
catch (err) {
  describeErrors++;
  process.stderr.write(`registry-search: describe ${name} failed: ${err.message}\n`);
  continue;
}
```

and emit a per-result tally to stderr at end of run. `registry-list` already
follows this pattern (errors come back as `record { error, name, path }`);
this ADR codifies it.

## Consequences

**Positive:**

- One place to fix bun-install quirks. snap is the immediate motivator;
  homebrew sandboxing, Windows Store, and Devcontainer scenarios will use the
  same machinery without further ADRs.
- `BUN_BIN` setting is no longer load-bearing on snap installs (resolver
  finds the real binary itself).
- registry-search now gives the agent a discoverable error, not silence.

**Negative:**

- Importing from `node:child_process` is now strictly forbidden in the
  workbench's own scripts and tools (it would re-introduce the bug). New
  contributors must know to use `spawnBun`. A grep-based check in
  `scripts/check.ts` enforces this — see scientist-workbench-rpb.5 (F6).
- The smoke-test (`bun --version` on resolution) costs ~10 ms once per
  process. Acceptable; the alternative is mysterious downstream failures.

**Neutral:**

- The resolver intentionally still honours `BUN_BIN` first. The user remains
  in control; we just stop *requiring* them to know the snap path.

## Test plan

- `bun run check` passes on this machine without `BUN_BIN` exported.
- Mutating spawn.ts to break the resolver (point at a non-existent path)
  causes a loud, descriptive error from the *first* tool in the chain, not
  silent empty results.
- `tools/registry-search` with a deliberately broken tool (e.g. one whose
  `--schema` exits 1) logs the failure to stderr and returns a partial
  result with a tally line.
