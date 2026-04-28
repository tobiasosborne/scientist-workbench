# @workbench/contract

The contract package is the runtime backbone of every tool. It owns four
concerns:

1. **Tool dispatcher** (`runner.ts`) — the `runTool({...})` entry point that
   every `tools/<name>/tool.ts` calls. Parses argv, handles the standard
   flags (`--schema`, `--examples`, `--invariants`, `--version`,
   `--provenance-of`, `--test`, `--help`/`-h`), reads stdin, validates input,
   runs your `fn`, emits canonical bytes, writes provenance.

2. **Provenance store** (`provenance.ts`, `store.ts`) — content-addressed
   record of every successful run, indexed by output hash. See PRD §3.2.

3. **Registry** (`registry.ts`) — discovery of installed tools plus the
   `describeTool` helper that probes a tool's `--schema`/`--version`/etc.
   Used by `tools/registry-list` and `tools/registry-search`.

4. **Subprocess plumbing** (`spawn.ts`) — the single owner of "where is
   `bun`?". Resolves the bun binary, collapses symlinks (notably the snap
   chain), smoke-tests the result, and exposes `spawnBun(args, stdin?)`.
   See `docs/adr/0001-subprocess-plumbing.md`.

5. **Goldens schema** (`goldens.ts`) — the `GoldenSpec` type that per-tool
   `goldens.spec.ts` files export, used by `scripts/generate-goldens.ts`.

## Public surface

```ts
import {
  // tool dispatcher
  runTool, type ToolDefinition, type ExampleEntry, type InvariantEntry,

  // provenance
  writeProvenance, readProvenance, provenanceToValue, valueToProvenance,
  type ProvenanceRecord,

  // store
  defaultStore, valuePath, provenancePath, writeValue, readValue,
  writeRawProvenance, readRawProvenance,

  // registry
  findToolsRoot, listToolEntries, describeTool, type ToolMetadata,

  // spawn — the only sanctioned subprocess machinery in the workbench
  spawnBun, resolveBunBinary, type SpawnResult,

  // goldens
  type GoldenSpec,
} from "@workbench/contract";
```

## What you should and shouldn't import from here

- ✅ Use `runTool({...})` in every `tool.ts` entry point.
- ✅ Use `spawnBun(...)` in every script or tool that needs to launch a bun
  subprocess. **Do not import `node:child_process` directly** — it
  re-introduces the snap-symlink bug (ADR-0001) and isn't checked.
- ✅ Use `describeTool` if you're writing a registry-shaped tool.
- ❌ Don't reach into the provenance store from a tool's `fn` — `runTool`
  writes provenance for you on every successful run.

## Invariants

The dispatcher's standard flags emit canonical-encoded values matching the
shapes documented in the main README under "Standard flags." If you write a
new tool that breaks those shapes (e.g. emitting a list when `--version`
should emit a record), the registry probe will fail loudly via the new
`spawn.ts` machinery — see ADR-0001.

## See also

- main `README.md` for tool I/O contract and the seven-artefact requirement.
- `PRD-v0.2.md` for design rationale.
- `docs/adr/` for accepted decisions.
