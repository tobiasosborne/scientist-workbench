# 028 — defineTool / runTool split, registry without spawning

**Date:** 2026-05-03
**Status:** complete
**Branches:** main
**ADR:** [0010-tool-module-shape](../adr/0010-tool-module-shape.md)
**Issues closed:** scientist-workbench-yth (P1)

## Context

`packages/contract/src/runner.ts` previously talked directly to
`process.argv`/`stdin`/`stdout`/`stderr`/`exit`/`env` at fixed call
sites, and every `tools/*/tool.ts` ended with a bare top-level `void
runTool(def);`. Two things followed from that.

First, importing a tool module from anywhere else *ran* the tool —
read stdin, executed `fn`, wrote provenance. There was no in-process
metadata read. Second, the registry (`packages/contract/src/registry.ts`)
shelled out four times per tool to assemble each `ToolMetadata`
record. With 18 tools today, a single `registry-list` paid 72
subprocess spawns to read data that already lives in the imported
module.

Beads scientist-workbench-yth captured the fix; the dependent issue
scientist-workbench-tyq ("cache tool metadata") was waiting on it
because there is no point caching subprocess output when the
subprocess itself is unnecessary.

## What changed

**`packages/contract/src/runner.ts`** — `runTool` now accepts an
optional `RunIO` whose fields override `argv`, `stdin`, `stdout`,
`stderr`, `exit`, `env` independently. Defaults are the production
process bindings; nothing about the production code path changes.
Test bindings throw a typed `ExitSignal extends Error` carrying the
exit code so callers can assert on it. Every place that used to
read `process.*` now goes through a resolved `r` object.

**`packages/contract/src/metadata.ts`** (new, ~50 LOC). Shared
`exampleToValue` / `invariantToValue` helpers, lifted out of
`runner.ts` so both the runner (`--examples` / `--invariants`) and
the registry (in-process metadata render) produce byte-identical
output through the same code.

**`packages/contract/src/registry.ts`** — `describeTool` now does a
single dynamic `await import(toolPath)`, reads `mod.def`, and
renders the metadata from the live `ToolDefinition`. The four
`spawnBun` calls per tool are gone. `decodeSchema` is gone from this
path because nothing was ever encoded — `def.schema.input` is
already a real `Schema`. New helper `importToolDef` is exported for
direct use by tests and downstream tooling.

**All 18 `tools/*/tool.ts`** — the trailing line changed from
`void runTool(def);` to `if (import.meta.main) void runTool(def);`.
Bun (and Node 22+) sets `import.meta.main` true only when the
module is the entry point, so dynamic-importing for metadata is
side-effect free.

**`scripts/new-tool.ts`** — the scaffolder template was updated to
emit the new shape (`export const def = defineTool({...})` plus the
`import.meta.main` gate) and to use `S.any()` placeholders for the
schema instead of the legacy `expr("<describe-input>", [])` ADR-0002
form. New tools start in the right shape automatically.

**`packages/contract/test/contract.test.ts`** — seven new tests
under `describe("ADR-0010 …")`. They cover: importToolDef returns
without spawning; describeTool emits the canonical metadata;
`def.fn(input, {})` is callable in-process and returns the
2^10 mod 1000 = 24 answer; `runTool(def, { argv: ["--version"], ... })`
writes canonical bytes to a captured stdout; the work case runs
end-to-end with injected stdin/stdout/env (`CAS_STORE` redirected
to a temp dir); the error path raises `ExitSignal` with code 1
and matching stderr; importing the tool module is fast and
side-effect free.

**`packages/contract/src/index.ts`** — re-exports `RunIO`,
`ExitSignal`, `importToolDef`, `exampleToValue`, `invariantToValue`.

**Lockstep doc updates** — ADR-0010 captures the design; this
worklog shard captures the iteration; the README's "Writing a new
tool" / contract sections still describe the same on-disk layout
(no row added or removed); CLAUDE.md gains a hallucination-risk
callout reminding future agents that tool modules must stay
side-effect-free at import time apart from the gated `runTool`
call.

## Why these choices

**Optional `RunIO`, not a required argument.** The 18 existing
tools all call `runTool(def)` (no second argument); their
production behaviour must not change. An optional parameter
defaulted to the real process bindings keeps the entry-point shape
identical and adds zero overhead at the call site. The injectable
surface is opt-in for tests and harnesses.

**`exit` returns `never`, signal as a typed Error.** The
production binding is `process.exit`, which terminates. Tests need
`runTool` to halt, but a `void` return wouldn't let TS narrow
control flow after `r.exit(...)`. The `never` return type plus a
test-side `throw new ExitSignal(code)` gives both: TS narrows
correctly, and tests catch a typed value carrying the code.

**`import.meta.main` over a top-level guard variable.** Considered:
`if (process.argv[1]?.endsWith("/tool.ts")) runTool(def);`. Rejected
— fragile to symlinks, build paths, and the wrapper-script case.
Bun's `import.meta.main` is the canonical, single-line answer and is
documented as the way to detect entry-point status. Node 22+ ships
the same field, so even a Node fallback is safe.

**Dynamic import over a generated registry index.** Considered: a
`tools/registry.ts` that statically imports every tool by name.
Faster at registry-call time (no fs walk), but introduces a codegen
step and couples the registry's compilation to the tool set. The
dynamic-import path keeps the auto-discovery story intact and pays
a small per-call TS-source-load cost; the cache (issue tyq, now
unblocked) erases it.

**Shared metadata helpers, not duplicated rendering.** The runner
emits `--examples` / `--invariants` and the registry emits its
in-process record. Both must agree byte-for-byte (otherwise an
agent reading the registry would get a different shape than an
agent shelling out to `--examples`). Lifting `exampleToValue` and
`invariantToValue` to `metadata.ts` and having both consumers call
the same code is the only durable way to keep them in lockstep.

## Frictions surfaced

**1. TS narrowing through a struct-field `never` is conservative.**
The first attempt at the test branch had:

```ts
if (def.test === undefined) {
  r.stderr(...);
  r.exit(2);   // signature: (code: number) => never
}
await def.test();   // TS error: possibly undefined
```

TS does not narrow `def.test` after `r.exit(2)` even though `r.exit`
is declared `(code: number) => never`. The narrowing only works
through *direct* function calls whose return type is `never`, not
through field accesses on a captured object. Fix: alias the
function (`const t = def.test; if (t === undefined) { ...; r.exit(2);
return; } await t();`) and add an explicit `return` after `r.exit`
so the control flow is unambiguous.

**2. `let exitCode: number | null = null` narrows to `null` under
strict TS.** A test wrote `let exitCode: number | null = null;`
intending the field to be filled by the captured-exit closure. TS
narrowed `exitCode` to the `null` branch and then refused
`expect(exitCode).toBe(1)`. Fix: drop the bookkeeping variable and
read the code directly off the thrown `ExitSignal`.

**3. The registry no longer needs `parse` or `decodeSchema`.** The
old `describeTool` parsed each subprocess's stdout JSON and decoded
the wire-form schema. Both steps are gone now — `def.schema.input`
*is* a `Schema`, never a wire-form Value. This is a small but
load-bearing simplification: it means a future schema constructor
that does not yet have an `encodeSchema` round-trip (e.g. recursive
schemas, if we ever add them) would not break the registry.

**4. The scaffolder's old template predated ADR-0004.** The
`tools/<name>/tool.ts` template still wrote `expr("<describe-input>",
[])` in the schema slot. That's the ADR-0002 "kindOf example value"
shape, which has been wrong since ADR-0004 made schemas first-class.
Updating to `S.any()` was a cheap lockstep doc fix that should have
ridden along with shard 008 and didn't. Caught and fixed here.

**5. Three rounds of system-reminders nudged toward TaskCreate
during this work.** CLAUDE.md Rule 9 names beads as the only
tracker; the reminders were ignored per rule. Worth recording the
friction so a future agent doesn't second-guess the policy when
they see the same nudge.

## Acceptance

- `bun run check` is green: 31 phases pass, 4 skipped (tools without
  `--test` hooks), 0 failed. Full run takes ~50s.
- `bun test packages/contract/test/contract.test.ts` reports 16
  pass, 0 fail, 46 expect calls. The 7 new ADR-0010 tests are part
  of that count.
- `grep -c "if (import.meta.main) void runTool(def);" tools/*/tool.ts`
  prints `1` for all 18 tool entry points.
- Manual sanity check: `bun -e 'import { importToolDef } from
  "@workbench/contract"; const def = await importToolDef("/abs/path/
  tools/mod-pow/tool.ts"); console.log(def.name, def.version)'`
  prints `mod-pow 0.2.0` without consuming stdin or writing to the
  CAS store.
- Beads `bd show scientist-workbench-yth` updates from `OPEN
  (claimed)` to `CLOSED` after this shard ships.

## Pointers

- `packages/contract/src/runner.ts:108-180` — `RunIO`, `ExitSignal`,
  `resolveIO`.
- `packages/contract/src/runner.ts:300-320` — `runTool` signature
  with optional `io`.
- `packages/contract/src/runner.ts:425-433` — `ExitSignal`
  propagation in the catch block (don't double-handle an explicit
  exit).
- `packages/contract/src/registry.ts:80-110` — `importToolDef` and
  the new `describeTool`.
- `packages/contract/src/metadata.ts` — the shared metadata helpers.
- `packages/contract/test/contract.test.ts:130-260` — the seven
  ADR-0010 tests.
- `tools/mod-pow/tool.ts:113` — the canonical example of the new
  entry-point shape (`export const def = defineTool({...}); if
  (import.meta.main) void runTool(def);`).
- `scripts/new-tool.ts:227-289` — the updated scaffolder template.
- ADR-0010 — the design rationale and the alternatives considered.
- Beads scientist-workbench-tyq — registry metadata cache, now
  unblocked.

## Open questions

- **Should the registry warm-cache imports across calls?** A single
  `registry-list` invocation imports every tool's TS source once;
  back-to-back calls re-import. Bun caches `import()` by URL, so
  this is amortised at the engine level, but a cross-process cache
  (issue tyq) would still help cold starts. Out of scope for this
  shard.
- **Is `import.meta.main` correct under `bun build --compile` once
  that lands?** Bun's docs say yes — compiled binaries set
  `import.meta.main` on the entry point — but the workbench has
  not yet exercised that path. Worth verifying before the v1
  compile-deferred bullet in README is closed.
