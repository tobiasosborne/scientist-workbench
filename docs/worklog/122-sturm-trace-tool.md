# 122 — `tools/sturm-trace`: TS source → IR Value (`q0b`)

**Date:** 2026-05-15
**Bead:** `scientist-workbench-q0b` (closes — the natural follow-up to
worklog 121's `r40`)
**Touches:** `tools/sturm-trace/{tool.ts, runner.ts, README.md,
goldens.spec.ts, goldens/, package.json}` (new); `packages/sturm/src/
{runtime.ts, index.ts}` (typed `InvalidWhenBodyError`);
`packages/sturm/test/bell.test.ts` (two new pinning tests); `README.md`
catalog row; `packages/compose/src/generated/wb.ts` (regenerated typed
barrel — now exposes `wb.sturmTrace(...)`); `.gitignore` (scratch dir).

## Context

Worklog 121 (`r40` / ADR-0038) settled the *spec* for the tracer-side
refusal envelope. This shard lands the *tool*. With both in place, the
Sturm stack closes the "source → IR" boundary: an agent can write a
quantum program as plain TypeScript using `@workbench/sturm`'s
`trace(...)` DSL, pipe the source through `sturm-trace`, and feed the
canonical IR Value into `sturm-execute` / `sturm-equivalent` /
`sturm-simplify` / the combinators — exactly the layering ADR-0009's
"agents are TS experts" axiom promised, now reachable by pipe.

## What changed

**`tools/sturm-trace`** is a two-file tool — outer `tool.ts` and inner
`runner.ts` — with the standard 7-artefact shape. Input is
`record{source: string, entry?: string}`. Output is either a channel
IR Value or one of four refusal envelopes (`parse-error`,
`invalid-when-body`, `non-pure-trace`, `non-channel-return`).

The outer/inner split is the load-bearing architectural choice. The
inner runner runs in a fresh Bun subprocess (ADR-0001 `spawnBun`) and
does the dynamic `await import(scratchPath)` + `entry()` + `Channel`-
assertion + canonical-byte emission. The outer tool writes user source
to a workspace-resident scratch file (so Bun's module resolution finds
`@workbench/sturm` by walking up), spawns the runner twice (the
default determinism check, on per the v3 PRD), bit-compares the
canonical bytes, and routes the result.

**`@workbench/sturm` typed `InvalidWhenBodyError`.** The runtime's
`rejectUnderControl` previously threw a free-text `Error`. Replaced
with a subclass carrying `op` (source-primitive name with parens —
`"observe()"`, `"qbool()"`) and `controlWires` (snapshot of the active
`whenStack`) so the runner's catch path uses `instanceof` instead of
regex on the message. The source-primitive → IR-op-head mapping (`qbool
→ prepare`, `qreg → prepare`, `observe → observe`, `ptrace → discard`)
lives in `runner.ts` because the boundary between source-DSL primitives
and ADR-0038's envelope payload is exactly the tracer's responsibility.
Two new tests in `bell.test.ts` pin the typed error (observe-in-when
and qbool-in-when).

**Refusal envelope byte-stability.** Two non-obvious snags required
fixes before the goldens could pass:

1. **Scratch-path scrubbing.** mkdtemp's `run-XXXX` suffix is random;
   error messages embedding the path produce different bytes every
   run. The runner now scrubs both the full file path
   (`...run-XYZ/user.ts` → `<source>`) and its containing directory
   (`...run-XYZ` → `<scratch>`) from every emitted error message
   before writing to stderr.
2. **`non-pure-trace` envelope carries only its message.** The first
   design included `first_preview`/`second_preview` fields with the
   diverging canonical bytes — but those bytes are themselves
   nondeterministic by construction, so the *refusal envelope* would
   have been non-deterministic. Dropped both fields; the message is
   enough — the user has their source and can re-run with
   `--skip-determinism` to compare passes themselves.

**Goldens — 13 entries.** Eight happy paths (empty trace, prepare-
observe, Bell pair, GHZ-3, parametrised ry, symbolic `piOver(2)`, m.if
classical branch, named-entry export) and five refusals (each of the
four refusal classes, plus a separate `non-channel-return` for the
"wrong entry name" sub-case). Two-run stability verified.

**`--test` hook — the round-trip property.** Pins acceptance criterion
4 (round-trip with `sturm-execute`). Three probes: Bell (expects
{00→0.5, 11→0.5}), GHZ-3 (expects {000→0.5, 111→0.5}), and a
deterministic single-prepare-observe (expects {0→1.0}). Pipes the
traced IR through `bun tools/sturm-execute/tool.ts` via `spawnBun` and
asserts the distribution by parsing outcomes + `prob` float64 bits.
The single-prepare-observe case is the smallest probe that exercises
the full pipeline; it's catch-net for any wire-id-bookkeeping bug that
doesn't surface on multi-wire circuits.

**`traceSource` helper factored out of `def.fn`.** Originally the test
hook needed `as never` casts to call `def.fn` with a constructed
`record({...})` Value because the schema narrows `fn`'s input
parameter beyond what TS can re-widen. Pulling the body of `fn` out
into `async function traceSource(source, entry, opts)` lets `test`
call it directly with raw strings — no casts. The same pattern
worklog 118 / 120 / `0y27` / `qiv8` have been retiring elsewhere.

## Why these choices

- **Outer-then-inner split, not a single-file design.** Two reasons.
  First, the runner's job is module-level work (dynamic import,
  module-load-time-exception handling) and the outer's job is contract
  work (input/output schema, refusal envelopes, determinism orchestration).
  Mixing them produces a 500-line file where the agent has to context-
  switch between two unrelated layers. Second, the runner is the
  subprocess entry point — it needs to be invokable by spawnBun with
  argv. A single-file design would have to gate `runTool(def)` *and*
  the runner mode on `import.meta.main` + some flag, doubling the
  surface area. Separate files is cleaner.

- **Forbidden ops = complement-of-{ry, rz}, not an enumeration.**
  Per ADR-0038's load-bearing predicate. The runner doesn't carry a
  list of forbidden op-heads — it just translates the `op` field from
  whatever `InvalidWhenBodyError` was thrown by `rejectUnderControl`
  in `@workbench/sturm`'s runtime. If the IR vocabulary ever grows a
  new non-rotation op-head, the source-DSL's `rejectUnderControl`
  call protects it automatically; the tracer follows.

- **Determinism check on by default, opt-out via `--skip-determinism`.**
  The bead said STURM_CHECK_DETERMINISM=1 by default. `F.bool` flags
  are switches that default to false, so the natural way to encode
  "on by default" is to negative-frame the switch: `--skip-determinism`
  silently absent = check enabled. This matches the existing F.bool
  convention exactly (no need to invent `--no-X` style negation that
  doesn't exist yet).

- **`bennett-missing` envelope deferred — for now folded into
  `parse-error`.** The bead's earlier notes named it as v0.1 scope,
  but `@bennett/core` doesn't exist in this workspace. A user's
  `import { oracle } from "@bennett/core"` surfaces today as
  module-not-found at `await import(scratchPath)`, routed to
  `parse-error`. Once Bennett-TS lands, lifting it to its own class
  is one runner-side conditional. Honest scope beats stub envelopes.

- **Scratch dir lives inside `tools/sturm-trace/`, not `/tmp/`.** Bun
  walks up looking for `node_modules` from the importer's directory.
  A `/tmp/sturm-XXX/user.ts` would fail to resolve `@workbench/sturm`.
  Workspace-resident scratch lets module resolution work without
  per-call environment-variable mangling. The `.gitignore` keeps
  crashed-run residue out of commits.

## Frictions surfaced

- **`F.bool` doesn't accept a `default` option.** The first iteration
  declared `F.bool("...", { default: true })`. TS didn't catch it
  (F.bool's signature ignores the second arg), and the default was
  silently `false` — meaning the determinism check was never running
  on the work case. Caught by the goldens generation step: the
  `Math.random()` source produced byte-identical output across two
  invocations because **only one subprocess ever ran**. Once I added
  stderr-debug logging and saw "DEBUG first" without "DEBUG second",
  the bug was obvious. Lesson: stderr-debug at the suspect call site
  beats reading the source for what should be a binary-typed flag.

- **Module-import caching wasn't the issue.** Spent ~10 minutes
  suspecting that Bun's `await import` was somehow caching across
  spawned subprocesses (it isn't — each process has its own
  module registry). The actual issue was the flag default above; the
  caching theory was a wild goose chase. Lesson — when two subprocess
  invocations of `bun runner.ts <same-args>` produce identical
  results, *first* verify both subprocesses actually ran (by
  side-effect or stderr counter), then theorise about caching.

- **`as never` casts on `def.fn` in the test hook.** Resolved by
  factoring the body of `fn` into `traceSource(source, entry, opts)`
  and having both `fn` and `test` call it. Cleaner architecture, no
  casts — the same shape worklog 118/120 had been pushing on
  elsewhere.

- **mkdtemp's random suffix breaks golden stability.** The scratch
  path appears verbatim in compile-error messages (Bun's TS errors
  cite the file path). First golden run produced perfectly-byte-stable
  output; the *second* run produced different `parse-error.message`
  bytes for the same input. Fixed by scrubbing both the full path
  and the containing dir in the runner before emitting to stderr.

## Acceptance

- **7-artefact contract** — `tool.ts`, `runner.ts`, `README.md`,
  `goldens.spec.ts`, `goldens/`, `package.json` all in place; the
  trailing `if (import.meta.main) void runTool(def);` gate is the
  ADR-0010 idiom.
- **≥10 examples** — 13 goldens (8 happy + 5 refusal). All pass on
  byte-identical re-run (two-pass stability verified manually before
  full check).
- **Determinism property** — implicit in the goldens (each runs
  through the default check) plus the explicit `--test` hook's
  round-trip probes (which run the check on each probe).
- **Round-trip with sturm-execute** — `--test` hook pins Bell, GHZ-3,
  and single-prepare-observe; all three match the textbook
  distribution within 1e-9.
- **Main `README.md` catalog row** — added after `sturm-then`, names
  the four refusal envelopes and the "fifth layer of ADR-0038's
  enforcement" framing.
- **Full `bun run check`** — 97 passed, 7 skipped, 0 failed.

## Pointers

- `docs/adr/0038-coherent-control-restrictions.md` — the spec this
  tool's `invalid-when-body` envelope conforms to (Layer 5; the four
  IR-side layers were already in place).
- `docs/adr/0009-ts-native-frontend-dsl.md` — the design axiom
  ("agents are TS experts; what a TS expert wants is the spec") and
  the source-surface shape this tool consumes.
- `docs/adr/0001-subprocess-plumbing.md` — `spawnBun` resolves
  snap-Bun's mount-namespace corner; the runner inherits that.
- `docs/adr/0003-tool-output-error-patterns.md` — the boundary-
  failure shape (`tagged "<tool>/<class>"`) all four refusal classes
  sit in.
- `tools/sturm-trace/{tool.ts, runner.ts}` — the two-file
  architecture; read top-to-bottom for the literate design.
- `packages/sturm/src/runtime.ts` — `InvalidWhenBodyError` and the
  `rejectUnderControl` call sites.
- bead `q0b` — this shard's tracker, now closed.
- bead `can` — "hardware backend bridges (qpu-execute-* tools)" —
  unblocked by `q0b` per the bead graph.
