# 032 — Composition layer MVP (`@workbench/compose`) + provenance lockstep

**Date:** 2026-05-03
**Status:** complete (MVP path)
**Branches:** main
**ADR:** [0012-composition-layer](../adr/0012-composition-layer.md)
**Issues closed:** scientist-workbench-c24 (ADR), -inm (scaffold), -9n1
(loadWorkbench), -23i (Workbench.run), -o8t (provenance lockstep).
**Issues remaining (deferred):** -46z (fluent pipe), -4t5 (typed
barrel), -mtw (lookup), -csa (runMemoized), -e0h (demo-scope.ts).

## Context

Two things landed in the same shard because they were a single
investigation:

1. The headline was the **composition layer**. The bash-pipe surface
   pays ~50 ms of spawn ceremony per hop. For the inner loop (`bun
   tools/expr-parse | bun tools/cas-simplify | bun tools/cas-verify`
   with a 30-line expression iterated dozens of times) that floor
   dominates. ADR-0010 (defineTool/runTool split) and ADR-0011 (typed
   flags) had already made the in-process call possible by removing
   the side-effects-at-import problem and giving us a typed flag
   resolution path. ADR-0012 (now Accepted) is the design pass for
   the layer that exploits both.

2. While orienting, the agent (me) discovered that PRD §3.5 said
   "Provenance write path is OPEN, NOT YET BUILT" while the runner
   had been writing provenance records since the typed-flags shard
   (029, runner.ts:512-531). A round-trip via `mod-pow` →
   `$CAS_STORE/provenance/<hh>/<output_hash>.json` → `--provenance-of`
   confirmed it. Doc lag, not code lag — but a Law 2 violation, and
   §11 winning-criterion 1 ("provenance is re-executable to
   bit-identical result") was structurally untestable while the doc
   said the path didn't exist. Fixing it in this shard kept the work
   bundled.

## What changed

**`docs/adr/0012-composition-layer.md`** (new). Captures the
in-process call semantics, the work-case factor (`executeToolDef`),
the three-move sequencing (MVP → typed barrel → memoization), the
fluent-pipe vs direct-run decision, and the alternatives (run via
`runTool`+RunIO; in-memory-only memo cache; proxy-typed loose
surface; module-import singleton). Hallucination-risk callouts
paired in `CLAUDE.md`: in-process invocations share the orchestrator
process so the no-module-level-side-effects rule is now load-bearing
for compose, and a when-to-prefer table maps inner-loop iteration /
multi-step research / demo scripts to in-process and shell
composition / tool isolation to subprocess.

**`packages/contract/src/execute.ts`** (new, ~280 LOC). Factors the
runner's work case into `executeToolDef(def, input, flags, opts?)`:

- Runs `validate(input, def.schema.input)` → throws `ToolError` on
  fail.
- Calls `def.fn(input, flags)`.
- Runs `validate(output, def.schema.output)` → throws `ToolError` on
  fail.
- Canonicalises output once, hashes the bytes (so we don't pay
  re-canonicalisation inside `hash`), hashes input.
- Writes provenance, captures errors as `provenanceError: Error |
  null` on the result rather than throwing.

Plus two flag helpers for in-process callers — `resolveFlagsForCall`
applies declared defaults + type-validates a partial flags object;
`explicitStringsFromPartial` derives the argv-equivalent string map
for the provenance record (booleans recorded only if true; ints,
strings, enums recorded as the caller's value). The runner's work
case in `runner.ts` collapsed from ~75 LOC to ~25 LOC, calling
`executeToolDef` and surfacing its `provenanceError` as the same
stderr warning it always did.

**`packages/compose/`** (new package, 4 source files + tests + README):

- `errors.ts` — `CompositionError extends ToolError` with
  `toolName` and optional `step` (for the deferred fluent pipe).
- `types.ts` — public `Workbench` and `Pipe` interfaces, full TSDoc on
  every method including the issues that fill in deferred ones.
- `load.ts` — `loadWorkbench(opts)`: walks `findToolsRoot` →
  `listToolEntries` → `importToolDef` in parallel. Failed imports go
  in a partial-discovery `errors` map; the rest of the registry
  stays callable. `tools/<dir>` whose declared `def.name` differs
  from the directory name is keyed by `def.name` and surfaces the
  discrepancy in `errors`. Resolves the provenance store from
  `opts.store` → `CAS_STORE` env → `defaultStore()`.
- `run.ts` — `runWorkbench(tools, name, input, partialFlags, opts)`.
  Looks up `def`, applies defaults via `resolveFlagsForCall`,
  derives explicit-flag strings, hands off to `executeToolDef`.
  `ToolError` from validation gets re-wrapped as `CompositionError`
  carrying the tool name and the underlying error's
  `suggestion`/`detail`.

**Lockstep doc updates (Law 2):**

- `CLAUDE.md` — two new hallucination-risk callouts (compose blast
  radius; in-process vs subprocess decision).
- main `README.md` File layout — `packages/compose/` entry.
- `tsconfig.json` — `paths` entries for `@workbench/compose` and
  `@workbench/linalg-core` (the latter was already imported but
  silently absent from `paths`; opportunistic fix because I touched
  the same lines).
- `PRD-v0.2.md` §0.1 (the "what v0.1 didn't anticipate" bullet
  flipped from open to closed-with-pointer), §3.5 (rewritten from
  OPEN to SETTLED+BUILT, naming the executeToolDef factor as the
  shared-implementation discipline), §10.1 item 2 (struck through).
- `packages/compose/README.md` — usage examples, status, when-to-
  reach-for table mirroring the CLAUDE.md callout.

## Why these choices

**Factor `executeToolDef` rather than route in-process through
`runTool` + RunIO.** Routing through the runner with injected stdin
would have meant canonicalise(input) → string → re-parse → Value on
every in-process call, plus the runner's exit/stderr machinery
running for a consumer that doesn't want it. The factored helper
gives both surfaces the same five-step contract without the
round-trip. The deeper reason is the single-implementation
discipline: ADR-0012's stated goal is that subprocess and in-process
output are byte-identical for the same `(tool, version, input,
explicit-flags)`. The only sound way to keep that promise is to
share the implementation. Both `runTool` and `runWorkbench` now call
the same function, and the existing 18 `--test` hooks plus 350+
goldens proved byte-identical behaviour — `bun run check` passed at
33/33 with zero failures, the strongest verification we have for
"the refactor changed nothing."

**Partial discovery in `loadWorkbench`.** A failed `importToolDef`
on one tool does not throw from the registry constructor; the
failure surfaces in `Workbench.errors` and the rest of the workbench
is fully callable. This matches `registry-search`'s existing
discipline (failure tally to stderr, continues) and is the only
sane default — one bad module would otherwise poison every call
site. Acceptance: with the current 19 tools, `Workbench.errors.size
=== 0`.

**Bool flags don't record `false`.** `parseFlagsFromArgv` cannot
produce `explicit["verbose"] = "false"` because there's no argv
syntax for it (bool is a switch). Mirroring this in
`explicitStringsFromPartial` keeps subprocess and in-process
provenance bytes identical when the caller passes `{verbose:
false}` (which is structurally the default, and shouldn't bloat the
record). For non-bool flags, "explicit" means "the caller passed
this key" regardless of whether the value matches the default —
matches `--mode=exact` being recorded as "exact" even when `exact`
is the default.

**Throw on unknown flag keys at runtime.** The typed barrel (issue
4t5) catches this at compile time. The loose `wb.run` surface
catches it at runtime via `resolveFlagsForCall` — a typo on a flag
name should not silently default. The error message lists the valid
flags; standard "errors that teach" discipline.

**No type-threading in `Pipe`.** A typed `Pipe<I, O>` that walks
through-step types would be elegant but requires either a phantom
type parameter on every `.through()` call (with explicit user
annotation) or a generated barrel that knows every tool's
input/output types statically. The latter is issue 4t5; the fluent
pipe ships with `Value` in/out, and TS-expert callers reach for
`wb.modPow({...})` chained directly when they want type threading.

## Frictions surfaced

**`exactOptionalPropertyTypes` and re-throw.** The natural
`new CompositionError(msg, { suggestion: e.suggestion, detail:
e.detail, ... })` is rejected because `suggestion` could be
`undefined`. Solved with a `wrapToolError` helper that builds the
options conditionally. The TS-expert lesson is that
`exactOptionalPropertyTypes: true` (which the project is right to
have on) makes `{ ...possiblyUndefined }` a compile error — you
either need conditional construction or `Partial<...>` typing on
the receiver. Since the receiver type is the public API, conditional
construction was the right move.

**`spawnBun` API surprise.** The signature is `spawnBun(args,
stdin?, options?)` returning `{ code, stdout, stderr }`, not the
`spawn(args, { stdinBytes, ... })` shape my muscle memory built.
Caught in 30 seconds by reading the export. Worth knowing: the spawn
result uses `code`, not `exitCode`, so consumer tests should match.

**Doc drift caught the work.** PRD §3.5 (provenance writes are
OPEN) was the first thing I named when familiarising. Then the code
showed it was already done. Worklog 029 shipped the writes silently
because they were a pull-along of ADR-0011's explicit-flags
discipline; the docs didn't follow. Cost: ~10 minutes of scaffolded
work investigating a non-bug, but also a fact-check that revealed
the broader §0.1 / §3.5 / §10.1 trio of doc lag. Worth the time.

**Tools-root walk vs explicit toolsRoot.** The default walks up from
`process.cwd()` looking for a `tools/` directory. Tests hit a corner
where pointing `toolsRoot` at a directory that contains no
`tool.ts` files returns an empty registry rather than throwing — I
asserted that as the contract, since "no tools" is a valid (if
boring) workbench. The CLAUDE.md "honest scope" rule applies:
loadWorkbench shouldn't lie about what it found.

## Acceptance

- `bun run check` — 33 phases, 0 failures, 4 skipped (the
  pre-existing typecheck/test/oracle path on every tool, including
  the 350+ goldens that prove byte-identical behaviour after the
  `executeToolDef` refactor).
- `bun test packages/compose/test/` — 10 tests, all green:
  CompositionError surface, loadWorkbench discovery (all 19 tools,
  zero errors), explicit toolsRoot, name filter, `wb.run("mod-pow",
  ...)` returns the right Value, `expr-parse → cas-simplify`
  in-process produces byte-identical bytes to the subprocess
  pipeline, unknown tool name throws CompositionError listing
  alternatives, schema-violating input fails with toolName + path
  detail, provenance record matches subprocess.
- `loadWorkbench` cold-load measured ~150 ms for 19 tools in the
  test environment, within the 200 ms budget the issue named.
- ADR-0012 referenced from `CLAUDE.md` hallucination callouts in
  lockstep.
- Doc lockstep on §0.1 / §3.5 / §10.1 closes scientist-workbench-o8t.

## Pointers

- `docs/adr/0012-composition-layer.md` — the design pass.
- `packages/contract/src/execute.ts` — single implementation of the
  contract's work case.
- `packages/contract/src/runner.ts` — ~25-line work-case body now
  delegating to `executeToolDef`.
- `packages/compose/src/{errors, types, load, run}.ts` — public
  surface.
- `packages/compose/test/compose.test.ts` — surface tests +
  byte-identical-with-subprocess proof + provenance-round-trip
  proof.
- ADRs 0010 (split, foundation), 0011 (typed flags), 0004 (schemas).
- Beads scientist-workbench-{c24, inm, 9n1, 23i, o8t} closed; -46z,
  -4t5, -mtw, -csa, -e0h still open and ready to claim.
