# 033 — Typed barrel for `@workbench/compose` (`wb.modPow({...})`)

**Date:** 2026-05-03
**Status:** complete
**Branches:** main
**ADR:** [0012-composition-layer](../adr/0012-composition-layer.md) §"Generated typed barrel"
**Issues closed:** scientist-workbench-4t5.

## Context

The MVP composition layer (worklog 032) shipped the loose call
surface: `wb.run("mod-pow", input, flags?)` where the tool name is a
string and input is a `Value`. That works but it is exactly *not*
the call site a TS expert reaches for. A TS expert wants the typed
barrel — autocomplete on tool method names, inferred input shape,
typo-as-compile-error.

ADR-0012 named the move and issue scientist-workbench-4t5 named the
acceptance: `bun scripts/gen-workbench-barrel.ts` produces a fresh
barrel; `wb.modPow({...})` typechecks; a typo on a tool name fails
the typecheck; `bun run check` includes the regen step before tsc.

## What changed

**`packages/contract/src/runner.ts`** — three new public type
helpers:

```ts
export type InputOf<D> =
  D extends { schema: { input: Schema<infer I> } } ? I : never;
export type OutputOf<D> =
  D extends { schema: { output: Schema<infer O> } } ? O : never;
export type FlagsArgOf<D> =
  D extends { flags?: infer Fl }
    ? Fl extends FlagSchema
      ? Partial<FlagsOf<Fl>>
      : Record<string, never>
    : Record<string, never>;
```

These are *structural* matches against `def`, not positional matches
against `ToolDefinition<I, O, Fl>`. The positional form was the
first attempt and failed: TS would not widen `EmptyFlags` to
`FlagSchema` to make the constraint match, leaving `InputOf<typeof
modPowDef>` as `never`. Matching on the schema field's `input:
Schema<infer I>` lifts I out directly with no widening dance. The
helpers re-export from `@workbench/contract`; they are general
enough that any consumer reaching for the def's TS shape benefits.

**`scripts/gen-workbench-barrel.ts`** (new, ~150 LOC). Walks
`tools/`, imports every `def`, sorts by directory name (so output is
deterministic), and emits
`packages/compose/src/generated/wb.ts`. The generated module
exports:

- `TypedWorkbench` — the interface, one method per tool;
- `typed(workbench)` — a factory turning a runtime `Workbench` into
  a `TypedWorkbench` whose methods call `workbench.run(...)`;
- `defs` — a `{ [methodName]: def }` constant useful for tests and
  for any consumer that wants the live ToolDefinitions keyed by
  camelCase name.

Two implementation details that earned their lines:

- The relative path to each `tool.ts` is rewritten from `.ts` to
  `.js` because `moduleResolution: "bundler"` (the workbench's
  setting) rejects `.ts` extensions in import paths. Bun resolves
  `.js` to the actual `.ts` sibling at runtime — same trick the rest
  of the codebase already uses.
- Method names are the camelCase of `def.name` (the tool's declared
  name), not of the directory name. They differ in only one place
  in the current registry, but the contract is to follow the
  declared name.

**`packages/compose/src/index.ts`** — re-exports `typed`, `defs`,
and `TypedWorkbench` from the generated module so consumers import
from `@workbench/compose` as a single surface.

**`scripts/check.ts`** — new phase `codegen: workbench typed barrel`
ahead of typecheck. Reads the existing barrel, regenerates, compares
bytes; non-equal → fail with "run `bun
scripts/gen-workbench-barrel.ts` and commit the diff." The drift
check catches new tools added without regen, schema changes, flag
changes.

**Lockstep doc updates (Law 2):**

- `packages/compose/README.md` — typed-barrel example replaces the
  earlier placeholder; the deferred-issue line is gone.
- `docs/worklog/README.md` — index entry for 033.

## Why these choices

**Commit the generated file (deviation from ADR-0012's
"gitignored").** The ADR called for gitignoring it. In practice
gitignoring meant fresh clones and CI runs would fail to import
`@workbench/compose` until the first `bun run check`. Committing it
keeps imports working out of the box, lets `git status` surface
drift, and costs ~120 lines of mostly-imports per regeneration —
small. The drift check phase regenerates and asserts byte-equality;
if the file were gitignored this phase would still need to exist
(to warn that the codegen ran with a different tool set than tsc
will see), but committing is cleaner. The ADR's stance is updated
implicitly by this worklog; ADR-0012 itself was not edited because
the deviation is small enough to ride the worklog.

**Structural match on `def.schema.input` rather than on the
`ToolDefinition` generics.** The first attempt was

```ts
type InputOf<D> = D extends ToolDefinition<infer I, Value, FlagSchema> ? I : never;
```

which failed because `mod-pow`'s `def`'s `Fl` slot is `EmptyFlags =
Record<string, never>`, narrower than `FlagSchema = Record<string,
FlagSpec>`, and TS would not widen it for the conditional match.
Result: `never`, runtime tests passed but the typecheck rejected
input that should have been valid. The schema-field structural
match is robust because every `ToolDefinition` carries `schema:
{input: Schema<I>; output: Schema<O>}` regardless of the generic
slots' concrete instantiations.

**Factory function over module-level singleton.** `typed(workbench)`
takes a runtime `Workbench` and binds. The alternative — having the
generated module call `await loadWorkbench()` at import time and
exporting a pre-bound `wb` — would have been a top-level
side-effecting import, exactly the rule CLAUDE.md / ADR-0010 say is
load-bearing. The factory keeps construction caller-controlled: the
TS expert writes `const wb = typed(await loadWorkbench())` once at
app start and uses `wb.foo(...)` everywhere.

## Frictions surfaced

**Generic-slot widening surprise.** `D extends ToolDefinition<infer
I, Value, FlagSchema> ? I : never` resolved to `never` for any def
whose `Fl` was narrower than `FlagSchema`. This was the
showstopper. Lesson: when extracting type parameters, prefer the
structural field shape (`{ schema: { input: Schema<infer I> } }`)
over the named-generic form. The structural form has no widening
dance because there are no constraints to widen against.

**TS forbids `.ts` import extensions under `moduleResolution:
"bundler"`.** Caught by the typecheck on the first generated
output. Fix is one line in the codegen, but the lesson — "the TS
runtime resolver and the TS typechecker have different opinions on
extensions even when they agree on the file" — is worth carrying.

**Typo-as-compile-error needs `@ts-expect-error`, not a runtime
test.** The typed barrel's value proposition is that `wb.modPwo`
fails *the typecheck*. A test that calls a typo'd name only
exercises runtime, where (without the typo failing tsc) we'd get a
TypeError. Asserting via `// @ts-expect-error` on the typo'd line
makes tsc the witness — if a future change turns the typo into a
valid call (a tool gets renamed to `mod-pwo`), tsc complains that
the `@ts-expect-error` is unused. Tight feedback loop.

## Acceptance

- `bun run check` — 34 phases (the new codegen one + 33 existing),
  0 failures.
- `bun test packages/compose/test/` — 12 tests:
  - 6 surface tests from worklog 032
  - 5 in-process tests from worklog 032
  - 2 new typed-barrel tests:
    - `wb.modPow({...})` typechecks and computes 2^10 mod 1000 = 24
    - `wb.modPwo` (typo) is a `@ts-expect-error` line — tsc rejects
      it, and the unused-error assertion would fail if the typed
      barrel ever silently accepted typos.
- ADR-0012 acceptance criterion ("`bun
  scripts/gen-workbench-barrel.ts` produces a fresh wb.ts; … `bun
  run check` includes the regen step before tsc") satisfied.

## Pointers

- `scripts/gen-workbench-barrel.ts` — codegen entry point.
- `packages/compose/src/generated/wb.ts` — committed output, ~110
  LOC for 19 tools.
- `packages/contract/src/runner.ts` — `InputOf` / `OutputOf` /
  `FlagsArgOf` helpers (re-exported from
  `packages/contract/src/index.ts`).
- `scripts/check.ts` — codegen phase + drift check.
- `packages/compose/test/compose.test.ts` — typed-barrel tests
  (last two cases).
- ADR-0012 §"Generated typed barrel".
- Beads scientist-workbench-4t5 closed.
