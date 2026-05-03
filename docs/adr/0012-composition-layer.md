# ADR-0012 — `@workbench/compose` composition layer

**Status:** Accepted — 2026-05-03
**Beads:** scientist-workbench-c24 (this ADR is the resolution); blocks
the implementation chain inm → 9n1 → 23i → {46z, 4t5, mtw} → {e0h, csa}.
**Related:** ADR-0010 (`defineTool` / `runTool` split — provides
`importToolDef`, the foundation for in-process invocation), ADR-0011
(typed flags — flow through the in-process surface unchanged), ADR-0004
(schemas as first-class — input/output validation must not be skipped
in-process).

## Context

The workbench's existing composition surface is **stdin/stdout pipes**:

```sh
echo '{"kind":"string","value":"(x+1)*(x-1)"}' \
  | bun tools/expr-parse/tool.ts \
  | bun tools/cas-simplify/tool.ts
```

Every `|` is a fresh `bun` process: subprocess fork, TS source load,
schema decode, stdin canonicalisation, JSON parse, schema validation,
`fn` execution, output canonicalisation, stdout write, exit. On the
measured hardware the *floor* per hop is ~50 ms — most of it is the
spawn and the TS load. A 7-tool chain pays seven of those.

That floor is fine when an agent reaches for a single tool from a
shell. It is **the dominant cost** in three workflows that the
workbench wants to be irresistible at:

1. **Inner-loop iteration.** An agent debugging a 30-line expression
   re-runs `expr-parse | cas-simplify | cas-verify` dozens of times.
   Each run pays ~150 ms. The agent's wall-clock cost is dominated by
   spawn ceremony, not by the work.

2. **Multi-step research workflows.** The Sturm Bell-pair demo is
   five hops (`prepare-and-controls → simplify → execute → sample`).
   The Grover demo is more. Multi-tool *is* the value proposition; the
   per-hop tax punishes the value proposition.

3. **Demo and benchmark scripts.** `scripts/demo-scope.sh` is 250
   lines of bash that mostly exists to construct canonical-JSON
   strings, pipe them between subprocesses, and post-process the
   output. The whole script is a workaround for the fact that there is
   no in-process surface.

Three machinery facts make a clean fix possible **now**, where it
wasn't before:

- **ADR-0010** made every `tools/*/tool.ts` an importable module:
  `export const def = defineTool({...})`, gated `void runTool(def)` on
  `import.meta.main`. `await import(toolPath)` returns a live
  `ToolDefinition` with no side effects.
- **ADR-0011** made flags a typed `FlagSchema` on the definition
  itself, with declared defaults. The same `FlagsOf<Fl>` object that
  `runTool` builds from argv can be constructed directly from a TS
  call site.
- **ADR-0004** made schemas first-class TS values. `def.schema.input`
  is already a `Schema<I>` whose generic `I` is the exact TS shape the
  TS expert wants to construct.

The three together mean the composition layer is a thin facade. The
contract — schema validation, output validation, provenance write — is
not weakened, because all three machinery pieces exist as helpers we
can call directly without the runner's IO body.

## Decision

Add `packages/compose/` (`@workbench/compose`), a workspace-internal
TS package that wraps the contract dispatcher's *work case* in three
in-process surfaces: `Workbench.run` (direct call), `Workbench.pipe`
(fluent chain), and `Workbench.lookup` / `runMemoized` (provenance
cache hit by input hash). Tool discovery is automatic via
`loadWorkbench()`.

The package's audience is **the TS expert**. Every choice below
optimises for what a TS expert reaches for. Nothing in the package
changes the wire protocol, weakens the contract, or replaces the
subprocess surface.

### The work-case helper, factored

The runner's work case is currently inlined in `runTool` (lines
469–531 at the time of writing). The composition layer needs the
same logic — schema-validate input, call `fn`, schema-validate output,
canonicalise, write provenance — without the stdin/stdout/exit
plumbing.

Factor it out of `runTool` into a small helper in
`packages/contract/src/runner.ts`:

```ts
export interface ExecuteResult<O extends Value> {
  output: O;
  outputBytes: string;     // canonical
  outputHash: Hash;
  inputHash: Hash;
}

export async function executeToolDef<
  I extends Value, O extends Value, Fl extends FlagSchema,
>(
  def: ToolDefinition<I, O, Fl>,
  input: I,
  flags: FlagsOf<Fl>,
  opts?: { explicitFlags?: Record<string, string>; env?: Record<string, string | undefined> },
): Promise<ExecuteResult<O>>;
```

Both `runTool` and `Workbench.run` call this helper. There is **one**
implementation of the contract, called from two surfaces. This is
non-negotiable — duplicate validation logic across surfaces is
exactly the silent-divergence failure the workbench is trying to
avoid.

### `loadWorkbench(opts?)` — auto-discovery + in-memory registry

```ts
export interface Workbench {
  readonly tools: ReadonlyMap<string, ToolDefinition>;
  readonly errors: ReadonlyMap<string, Error>;  // tool-name → import failure
  run<I extends Value, O extends Value, Fl extends FlagSchema>(
    name: string,
    input: I,
    flags?: Partial<FlagsOf<Fl>>,
  ): Promise<O>;
  pipe<I extends Value>(input: I): Pipe<I>;
  lookup<O extends Value>(name: string, input: Value): Promise<O | null>;
  runMemoized<I extends Value, O extends Value, Fl extends FlagSchema>(
    name: string,
    input: I,
    flags?: Partial<FlagsOf<Fl>>,
  ): Promise<O>;
}

export async function loadWorkbench(opts?: {
  toolsRoot?: string;
  filter?: (name: string) => boolean;
}): Promise<Workbench>;
```

Implementation: walk `findToolsRoot` + `listToolEntries`, call
`importToolDef` for each, populate `tools` on success and `errors` on
failure. Partial discovery is the right behaviour — one broken tool
must not poison the registry; the failure surfaces in `errors` and
the rest of the workbench is callable. This matches how the existing
`registry-search` already handles describe failures (logs to stderr,
continues).

Cold-load budget: ≤ 200 ms for the current 18 tools. This is paid
once per process; subsequent `run` calls are ~the cost of `fn` itself.

### `Workbench.run(name, input, flags)` — direct call

```ts
const wb = await loadWorkbench();
const out = await wb.run(
  "mod-pow",
  record({
    base: int(2n),
    exponent: int(10n),
    modulus: int(1000n),
  }),
);
// out is a Value. To type it, use the typed barrel (below).
```

Schema validation is **not** skippable. ADR-0004's contract is that
input is validated before `fn`, output after — that contract holds in
the in-process surface byte-for-byte. The cost (validate is O(value
size)) is unavoidable, and dwarfed by the spawn it replaces.

Provenance write is **not** skippable. The provenance store is the
substrate of correctness; a tool invoked in-process produces a
provenance record byte-identical to the same tool invoked by
subprocess. This means `runMemoized` (below) can ride the same store
without a parallel index.

### `Workbench.pipe(input)` — fluent chain

```ts
const result = await wb
  .pipe(str("(x+1)*(x-1)"))
  .through("expr-parse")
  .through("cas-simplify")
  .value();
```

`Pipe` is **immutable**. Each `.through(name, flags?)` returns a new
`Pipe` whose internal "steps so far" list is extended. Branches share
a prefix without aliasing. `.value()` resolves and returns
`Promise<Value>`.

Errors mid-pipe report which step failed:

```
CompositionError [pipe step 2 (cas-simplify)]: input does not conform
  to schema (at $.kind): expected one of {expression, integer, ...},
  got "string"
```

The fluent surface intentionally does *not* try to type-thread `O` of
step *N* into `I` of step *N+1*. Threading at TS-type level requires
either a phantom-typed builder (heavy) or a generated barrel (issue
4t5, separate). The fluent API exists for the chain-of-transforms
shape; for type safety on the composition itself, callers use the
generated typed barrel and chain calls directly.

### `Workbench.lookup(name, input)` — provenance cache hit

```ts
const cached = await wb.lookup("mod-pow", input);
if (cached !== null) return cached;
```

Walks the provenance store for a record matching `(tool.name,
tool.version, inputs[0].hash)` where the input hash is computed from
`input` on the fly. On hit, returns the stored output Value (read by
output_hash). On miss, returns `null`.

Storage layout question (deferred to issue mtw): the existing layout
is `provenance/<hh>/<output_hash>.json`, indexed by *output*. Lookup
by input requires either (a) a reverse index `(tool, version,
input_hash) → output_hash` written alongside the provenance record,
or (b) a linear scan acceptable up to a few thousand records. The
issue picks one; this ADR does not — both are within the contract.

The reverse-index path is cheap (one extra file per write under
`provenance-by-input/<hh>/<input_hash>.json` containing the output
hash) and bounds lookup to O(1). It is the recommendation; the issue
makes the call.

### `Workbench.runMemoized(name, input, flags)` — lookup-or-run

```ts
const out = await wb.runMemoized("mod-pow", input);
// First call: runs, writes provenance + (reverse index), returns Value.
// Second call: hits cache, no fn execution, byte-identical Value.
```

A one-line wrapper around `lookup` + `run`. Refuses on tools with
`def.nondeterministic === true` — `entropy-source` consumes OS
randomness; memoising it would silently invent a determinism the
contract does not promise. The refusal is a clear `CompositionError`
("`entropy-source` is nondeterministic; runMemoized cannot guarantee
the precondition"), and the caller falls back to `run`.

### Generated typed barrel — `wb.modPow({...})`

```ts
// packages/compose/src/generated/wb.ts (gitignored, codegenned)
import { def as modPowDef } from "@workbench/tools-mod-pow";
import { def as casVerifyDef } from "@workbench/tools-cas-verify";
// ...

export const wb = {
  modPow: (input: InputOf<typeof modPowDef>, flags?: PartialFlagsOf<typeof modPowDef>) =>
    workbenchRunWith(modPowDef, input, flags),
  casVerify: (input: InputOf<typeof casVerifyDef>, flags?: PartialFlagsOf<typeof casVerifyDef>) =>
    workbenchRunWith(casVerifyDef, input, flags),
  // ...
};
```

Critical TS-expert detail: types flow through *imports*, not through
schema introspection at runtime. The generic helpers
`InputOf<typeof def>` and `OutputOf<typeof def>` extract `I` and `O`
from `ToolDefinition<I, O, Fl>` directly — no decode, no schema
walker, no quasi-evaluation. The generator is pure TS codegen
producing a thin module of imports + named methods.

Two consequences:

- **Autocomplete.** `wb.` shows every tool. Typo on a name is a
  compile error.
- **Inferred call signatures.** `wb.modPow({ base: ..., expoonent: ... })`
  fails to typecheck on the misspelled key, with the exact error a TS
  expert expects.

The codegen runs as a phase of `bun run check`. Output is gitignored.
The generated file's bytes are deterministic; re-running on the same
tool set produces byte-identical output (this is testable).

### Three moves — implementation sequencing

1. **MVP.** ADR-0012 (this), `inm` scaffold, `9n1` `loadWorkbench`,
   `23i` `run`. After this move, an agent can `import { loadWorkbench
   } from "@workbench/compose"` and call any tool in-process. The
   typed surface is `Value`-in, `Value`-out (not yet generated).
2. **Typed barrel.** `4t5` adds the codegenned `wb` object. After
   this move, `wb.modPow({...})` is the standard call site for a TS
   expert; the loose `run("mod-pow", ...)` remains for dynamic-name
   cases.
3. **Memoization.** `mtw` adds `lookup`; `csa` wraps it as
   `runMemoized`. After this move, idempotent expensive tools are
   memoised by input hash for free.

`46z` (fluent `pipe`) and `e0h` (demo-scope.sh migration) sit
alongside move 1, blocked only on `23i`.

## Consequences

**Positive.**

- The dominant cost of multi-tool workflows drops from spawn-bound
  (~50 ms × hops) to fn-bound. For a 7-tool chain that's roughly a
  20× improvement and removes the floor; for a 1-tool call it's about
  the same gain.
- The TS-expert call site is the call site. `wb.modPow({base: int(2n),
  exponent: int(10n), modulus: int(1000n)})` is what a TS expert
  reaches for. The bash-pipe surface stays where it is, for shell
  composition and tool isolation.
- The generated barrel makes typo-as-compile-error the default. Wrong
  tool names, missing input fields, wrong flag types all surface in
  `tsc --noEmit` instead of at runtime.
- The provenance store unifies the two surfaces. A tool run by
  subprocess in week 1 and looked up by `wb.lookup` in week 5
  byte-matches.
- `runMemoized` makes idempotent tools (every tool except
  `entropy-source`) cache for free.

**Negative / accepted.**

- A bad tool's import failure used to be a single tool dying; now it
  blocks `loadWorkbench` from including that tool. Mitigation: partial
  discovery (`Workbench.errors`) so the agent can call any other tool
  while the broken one is offline. Same failure surface as
  `registry-list` today.
- In-process invocation runs `fn` in the *current* process. A tool
  with a TODO `process.exit(...)` or an `import` that mutates a global
  blast-radius's the orchestrator. Mitigation: ADR-0010's hallucination
  callout (no module-level side effects) is now load-bearing for
  `@workbench/compose` too. CLAUDE.md gains a paired callout.
- The generated barrel adds a codegen step to `bun run check`. The
  step is fast (≤ 100 ms for 18 tools) and the output is
  deterministic, but it is a real new build artefact. Acceptable.
- Provenance store contention. If two `runMemoized` calls miss
  simultaneously, both compute and both write. The store is
  content-addressed and last-writer-wins is byte-identical, so the
  race is benign — but worth naming.

## Alternatives considered

**Run every in-process call through `runTool` with injected `RunIO`.**
Cleanest in code (one entry point), but pays canonicalise-input
(Value → string → re-parse → Value) on every call, and consumes the
runner's exit/stderr machinery for an in-process consumer that
doesn't want it. The extracted `executeToolDef` helper gives the same
guarantees without the round-trip.

**Memoize via an in-memory `Map` only, not the provenance store.**
Simpler but loses cross-process / cross-session memoisation. The
provenance store already exists, is durable, and is content-addressed
— riding it costs nothing and gives memoisation across runs.

**Skip the typed barrel, ship only the loose `run(name, input)`.**
The loose surface alone covers dynamic-tool dispatch (e.g.
`registry-search` deciding which tool to call at runtime). It does
*not* cover the inner-loop case where the TS expert is writing
`wb.casSimplify(...)` and wants autocomplete. Both surfaces ship
because both have honest readers; the barrel is the dominant one for
the dominant use.

**Use a TS proxy to type the loose surface dynamically (`wb.modPow(...)`
without codegen).** A `Proxy<typeof Workbench>` could intercept method
access and dispatch at runtime, but TS cannot infer types through a
Proxy without manual type assertions on every call. Codegen produces
honest TS types the LSP understands. The codegen step is the right
trade.

**Bake `loadWorkbench` into a top-level singleton on module import.**
Tempting (one less line at the call site), but violates ADR-0010's
"no module-level side effects" discipline. Caller-controlled
construction is correct.

**Hide schema validation in the in-process path "for speed."**
Rejected unconditionally. The contract is the contract on every
surface. Validation cost is dwarfed by what it replaces.

## Acceptance

- This document exists with Status=Accepted.
- CLAUDE.md gains a hallucination-risk callout naming the in-process
  blast-radius rule (no module-level side effects) and stating when to
  prefer in-process vs subprocess invocation.
- The implementation chain (`inm`, `9n1`, `23i`, `46z`, `4t5`, `mtw`,
  `csa`, `e0h`) lands tracking this ADR; each issue's acceptance
  criteria are unchanged.
- A `--test` or workspace test exercises end-to-end: `loadWorkbench()
  → wb.run("expr-parse", str("(x+1)*(x-1)")) → wb.run("cas-simplify",
  …)` produces the same canonical bytes as the bash pipeline.
- Wall-clock comparison on a 5+ step chain documented in the worklog
  shard tied to `e0h`.

## Pointers

- `packages/contract/src/runner.ts` — current work-case body
  (factor target).
- `packages/contract/src/registry.ts` — `findToolsRoot`,
  `listToolEntries`, `importToolDef` (the discovery foundation).
- `packages/contract/src/provenance.ts` — store layout that
  `lookup` rides on.
- `tools/mod-pow/tool.ts` — typical tool entry point shape; what the
  barrel imports.
- ADRs 0010 (split), 0011 (typed flags), 0004 (schemas), 0005
  (nondeterminism flag — `runMemoized` consumer).
- Beads scientist-workbench-{c24, inm, 9n1, 23i, 46z, 4t5, mtw, csa,
  e0h} — the implementation DAG.
