# ADR-0010 — `defineTool` (pure data) / `runTool` (IO bound) split

**Status:** Accepted — 2026-05-03
**Beads:** scientist-workbench-yth (this ADR is the resolution)
**Related:** ADR-0001 (subprocess plumbing), ADR-0002 (kindOf wire form),
ADR-0004 (schema as first-class type), beads scientist-workbench-tyq
(registry-cache follow-up, unblocked by this ADR)

## Context

Two coupled limitations in the v0.2 runner:

1. **Tool entry points were unconditionally side-effecting.** Every
   `tools/<name>/tool.ts` ended with `void runTool(def);`. A bare
   top-level call meant that `await import(toolPath)` from any other
   module would *spawn* the tool — read stdin, execute `fn`, write to
   stdout, write a provenance record. There was no way to introspect
   a tool's metadata in-process without effectively running it.

2. **`runTool` talked directly to the process.** `process.argv`,
   `process.stdin`, `process.stdout`, `process.stderr`, `process.exit`,
   and `process.env` were named at fixed call sites in the body.
   `runTool` could not be invoked from a test, from another tool, or
   from any harness that wanted to drive the dispatcher without owning
   the parent process.

Together those two facts meant the `registry-list` / `registry-search`
flow had to spawn each tool four times (`--version`, `--schema`,
`--examples`, `--invariants`) to assemble a metadata record. With ~20
tools, a single `registry-list` paid ~80 subprocess spawns and ~80
schema decodes for data that *already lives* in the imported module.
The follow-up beads issue scientist-workbench-tyq ("cache tool
metadata") was blocked on solving this first: there is no point caching
something whose primary cost is the unnecessary spawn.

## Decision

Split the contract API into a pure-data definition and an IO-bound
dispatcher, and gate the dispatcher's invocation on a runtime
`import.meta.main` check at every tool entry point.

### `defineTool({...})` — pure data

A typed identity wrapper around `ToolDefinition<I, O>`. Its only job
is to fix `I` and `O` from the inline `schema` so that the `fn`
parameter is narrowed at the call site. It performs no IO and has
been in place since ADR-0004; this ADR formalises its role as the
*primary* construction site.

```ts
export const def = defineTool({
  name: "mod-pow",
  version: "0.2.0",
  schema: { input: S.record({...}), output: S.kind("integer") },
  examples: [...],
  invariants: [...],
  fn: (input, _flags) => /* input is already narrowed to the record type */,
});
```

`def` is exported, importable, and inert.

### `runTool(def, io?)` — IO bound, injectable

`runTool` accepts an optional `RunIO` whose fields override `argv`,
`stdin`, `stdout`, `stderr`, `exit`, and `env` independently. Defaults
are the real process bindings; callers that supply none keep
production behaviour byte-identical.

```ts
export interface RunIO {
  argv?: string[];
  stdin?: () => Promise<string>;
  stdout?: (chunk: string) => void;
  stderr?: (chunk: string) => void;
  exit?: (code: number) => never;
  env?: Record<string, string | undefined>;
}
```

Two design choices worth naming:

- **`exit` returns `never`.** The production binding terminates the
  process, so no code after `r.exit(...)` ever runs. The test binding
  throws an `ExitSignal` (a typed Error subclass) carrying the code
  so callers can assert on it.
- **`stdin` is a thunk, not a string.** The dispatcher only awaits it
  in the work case; metadata flags never read stdin. A thunk keeps
  the test surface compatible with both eager strings and lazy
  streams.

### The `import.meta.main` gate

Every `tools/*/tool.ts` ends with:

```ts
export const def = defineTool({...});

if (import.meta.main) void runTool(def);
```

Bun (and Node 22+) sets `import.meta.main` to `true` when the file is
the program entry point. Importing the module from elsewhere flips
the gate to `false`, the `runTool` call is skipped, and the importer
gets `def` without consuming stdin.

### Registry consequences

`packages/contract/src/registry.ts` `describeTool` is now a single
dynamic import:

```ts
export async function importToolDef(toolPath: string): Promise<ToolDefinition> {
  const mod = (await import(toolPath)) as { def?: unknown };
  if (mod.def === undefined) throw new Error("...not exporting def...");
  return mod.def as ToolDefinition;
}
```

The four `spawnBun` calls per tool are gone. The `decodeSchema` step
on the registry path is gone — `def.schema.input` is already a real
`Schema` object, not a wire-form Value. Output bytes from the
`exampleToValue` / `invariantToValue` rendering match the previous
`--examples` / `--invariants` output verbatim because both the runner
and the registry now use the same helper functions out of
`packages/contract/src/metadata.ts`.

## Consequences

**Positive.**

- `def.fn(input, flags)` is unit-testable from `bun test` without a
  subprocess. Property tests for tool internals can live in
  workspace tests instead of behind `--test` hooks.
- `runTool(def, { argv: ["--version"], stdout: capture, ... })` makes
  the dispatcher itself exercisable. The new test suite at
  `packages/contract/test/contract.test.ts` covers metadata flags,
  the work case, and the error path with no spawn.
- Registry calls no longer pay 4× spawn-per-tool. With 20 tools,
  `registry-list` drops from ~80 subprocess starts to ~20 dynamic
  imports of TS source — orders of magnitude faster, and stable
  enough to make caching (issue tyq) a clean follow-up.
- Tool authors writing `bun scripts/new-tool.ts <name>` get the new
  shape by default; the scaffolder template was updated in lockstep.

**Negative / accepted.**

- Tool modules must now be **side-effect free at import time** apart
  from the gated `runTool` call. A future tool that does
  `console.log(...)` or reads a file at module top level breaks the
  registry. Today all 18 tools are clean; the rule is a hallucination-
  risk callout in CLAUDE.md so future agents don't reintroduce
  side effects.
- `import.meta.main` is a Bun / Node 22+ feature. The workbench's
  substrate is fixed to TS-on-Bun (PRD §1.3), so this is not a
  portability cost in practice.
- Dynamic-importing tool TS sources at registry time means the
  registry runs *all* tool top-level code (imports, helper consts).
  Cold cost is dominated by Bun's TS load path, which is still much
  faster than spawning. A cache (tyq) brings this to amortised zero.

## Alternatives considered

**A separate `ToolModule` interface that bundles `def` + a
`run()` method.** Considered and rejected. It bloats the entry-point
surface and obscures the fact that `def` is the canonical artefact;
the `runTool(def)` shape keeps the dispatcher external and the data
named.

**A generated `tools/registry.ts` that statically imports every
tool.** Faster at import time (no fs walk), but requires regeneration
on every tool addition and couples the registry's compilation to the
tool set. The dynamic-import path keeps tools auto-discovered with no
codegen step, in exchange for a small one-time TS-source-load cost
per tool that the cache will eliminate.

**Keep `runTool` IO-coupled and add a separate `inspectTool`
function.** Rejected — it duplicates the metadata code path. The
runner's `--examples` / `--invariants` output and the registry's
in-process render must agree byte-for-byte; the only sound way is to
share helpers, which this ADR does via `packages/contract/src/metadata.ts`.

## Acceptance

- `bun run check` is green (31 phases, 0 failures).
- `packages/contract/test/contract.test.ts` includes seven new tests
  that drive `defineTool`, `importToolDef`, `describeTool`, and
  `runTool(def, io)` end-to-end without spawning.
- `grep -c "if (import.meta.main) void runTool(def);" tools/*/tool.ts`
  reports `1` for all 18 tools.
- The scaffolder template (`scripts/new-tool.ts`) emits the new
  shape; running `bun scripts/new-tool.ts <name>` produces a tool
  that imports cleanly and runs cleanly.

## Pointers

- `packages/contract/src/runner.ts` — `RunIO`, `ExitSignal`,
  `defineTool`, `runTool` (~440 LOC).
- `packages/contract/src/registry.ts` — `importToolDef`,
  `describeTool` (no more spawning).
- `packages/contract/src/metadata.ts` — shared `exampleToValue` /
  `invariantToValue` helpers.
- `packages/contract/test/contract.test.ts` — the in-process
  surface tests.
- `tools/*/tool.ts:<last-line>` — `if (import.meta.main) void runTool(def);`.
- Beads scientist-workbench-tyq — cache tool metadata (now
  unblocked).
- Beads scientist-workbench-rej — typed flag declarations (sibling
  refactor; not blocked by this one).
