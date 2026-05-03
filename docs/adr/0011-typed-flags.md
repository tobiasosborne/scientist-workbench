# ADR-0011 — Typed flag declarations on `ToolDefinition`

**Status:** Accepted — 2026-05-03
**Beads:** scientist-workbench-rej (P1; this ADR is the design pass)
**Related:** ADR-0004 (schema as first-class type — pattern is mirrored
here), ADR-0010 (defineTool/runTool split — this ADR extends the same
generic surface), ADR-0009 (the agents-are-TS-experts axiom that drives
the design choices below)

## Context

The current runner parses argv into `Record<string, string>` and hands
it to `fn` as flags. Three problems follow:

1. **Heuristic disambiguation.** `parseArgv` greedily consumes the
   next arg as a flag value when it does not start with `-`. So a
   boolean `--equal` followed by positional `1` silently becomes
   `--equal=1`; `--mode -2` (a value-flag with a negative-number
   value) is misread as switch + positional. The `STD_TAKES_VALUE =
   new Set(["provenance-of"])` set at runner.ts is a smell — it
   privileges one flag because the heuristic could not be trusted.

2. **No type information at the call site.** `fn(input, flags)` sees
   `flags: Record<string, string>`. A typo (`--moed=exact` instead of
   `--mode=exact`) passes silently. String-comparing values is the
   tool author's burden every time.

3. **No declared surface to drive `--help` from.** Help text is
   hand-written or absent.

The fix mirrors what ADR-0004 did for input/output: declare the shape
once, infer the typed surface from it, validate at the boundary,
fail loudly on drift.

## The axiom

ADR-0009: agents are TS experts; what a TS expert wants is the spec.
Every design call below was made by asking that question.

## Decision

### A new `F.*` constructor namespace for flag specs

Separate from `S.*` (value-protocol schemas) because the concerns are
different: schemas describe Values inside the protocol; flags describe
CLI strings parsed by the runner. Conflating them would entangle two
type systems that have no reason to share a vocabulary.

```ts
// packages/contract/src/flags.ts

export interface BoolFlag { kind: "bool"; doc: string }
export interface StrFlag<D extends string | undefined = undefined> {
  kind: "str"; doc: string; default?: D;
}
export interface IntFlag<D extends bigint | undefined = undefined> {
  kind: "int"; doc: string; default?: D; min?: bigint; max?: bigint;
}
export interface EnumFlag<
  V extends readonly string[],
  D extends V[number] | undefined = undefined,
> {
  kind: "enum"; doc: string; values: V; default?: D;
}

export type FlagSpec =
  | BoolFlag
  | StrFlag<string | undefined>
  | IntFlag<bigint | undefined>
  | EnumFlag<readonly string[], string | undefined>;

export const F = {
  bool: (doc: string): BoolFlag => ({ kind: "bool", doc }),
  str: <D extends string | undefined = undefined>(
    doc: string, opts?: { default?: D },
  ): StrFlag<D> => ({ kind: "str", doc, default: opts?.default }),
  int: <D extends bigint | undefined = undefined>(
    doc: string, opts?: { default?: D; min?: bigint; max?: bigint },
  ): IntFlag<D> => ({ kind: "int", doc, ...opts }),
  enum: <const V extends readonly string[], D extends V[number] | undefined = undefined>(
    values: V, doc: string, opts?: { default?: D },
  ): EnumFlag<V, D> => ({ kind: "enum", doc, values, default: opts?.default }),
};

export type FlagSchema = Record<string, FlagSpec>;
```

### Type inference: `FlagsOf<F>`

The fn body sees a typed object whose property types are derived from
the declared specs. Defaults make a field non-optional; their absence
makes it `T | undefined`.

```ts
type FlagValueOf<S extends FlagSpec> =
  S extends BoolFlag ? boolean :
  S extends IntFlag<infer D> ? (D extends bigint ? bigint : bigint | undefined) :
  S extends StrFlag<infer D> ? (D extends string ? string : string | undefined) :
  S extends EnumFlag<infer V, infer D> ?
    (D extends V[number] ? V[number] : V[number] | undefined) :
  never;

export type FlagsOf<F extends FlagSchema> = { [K in keyof F]: FlagValueOf<F[K]> };
```

`flags.shots` is `bigint` if `shots: F.int(..., { default: 100n })`,
or `bigint | undefined` if no default. `flags.mode` is
`"exact" | "structural"` for an enum with a default; `… | undefined`
without one. The `F.enum`'s `<const V>` parameter preserves the literal
union — we do not widen to `string`.

### `ToolDefinition` gains a third generic, defaulted

```ts
export interface ToolDefinition<
  I extends Value = Value,
  O extends Value = Value,
  Fl extends FlagSchema = Record<string, never>,  // {} default
> {
  name: string;
  version: string;
  schema: { input: Schema<I>; output: Schema<O> };
  flags?: Fl;
  examples: ExampleEntry<I, O>[];
  invariants: InvariantEntry[];
  fn: (input: I, flags: FlagsOf<Fl>) => O | Promise<O>;
  test?: () => void | Promise<void>;
  nondeterministic?: boolean;
}
```

The `Fl extends FlagSchema = Record<string, never>` default means the
18 tools that currently take no flags get `FlagsOf<{}> = {}` — their
`fn` signature does not change. They keep the underscore convention:
`fn: (input, _flags) => ...`. Migration is opt-in per tool.

### Strict declared arity. No heuristics.

The argv parser becomes a two-pass operation:

1. **Tokenise.** Walk argv producing `{flag, value?}` pairs and a
   list of positionals. `--flag=value` is one pair; `--flag` is a
   pair with no value (yet); a bare token is a positional.
2. **Resolve.** For each `{flag}` (no value): if the flag's declared
   spec is `bool`, treat as a switch; if it is value-typed, the
   *next token in argv order* is its value (if available and not
   itself a `--flag`-shaped token); else error
   `expected value for --<flag>`.

Concretely, the four forms a TS expert expects:

| form | declared as | result |
|------|-------------|--------|
| `--equal` | bool | `equal: true` |
| `--equal --other` | bool, then bool | `equal: true, other: true` |
| `--mode exact` | enum | `mode: "exact"` |
| `--mode=exact` | enum | `mode: "exact"` |
| `--equal 1` | bool | `equal: true; positional ["1"]` |
| `--mode -2` | int (signed) | `mode: -2n` |
| `--mode=-2` | int | `mode: -2n` |
| `--moed exact` | undeclared | reject: "unknown flag --moed; valid: --mode, --shots, …" |

The `STD_TAKES_VALUE` set goes away. The runner derives "this flag
takes a value" from the merged spec table.

### Standard flags live in the runner, not per-tool

Tools do not redeclare `--help`, `--schema`, `--examples`,
`--invariants`, `--version`, `--provenance-of`, `--test`, or `-h`.
The runner has a baked-in `STANDARD_FLAGS: FlagSchema` and **merges**
it with the tool's declared flags before parsing. A tool that
declares a flag whose name collides with a standard flag fails at
load time.

### Help text auto-generated

The runner formats the merged flag table on `--help`. Each entry's
`doc` is the description; the `kind` plus default are summarised
(e.g. `--shots <int> (default: 100)`).

### Unknown flags reject loudly

A `--foo` not in the merged table → `ToolError` with the message
`unknown flag --foo` and a suggestion listing the valid set.

### Unexpected positional args reject

Today no tool consumes positionals; `parsed.positional` is silently
discarded. With the new strict mode, an unexpected positional is a
`ToolError` with the same suggestion shape. (Internally, the runner
still uses positional-shaped tokens during the resolve pass for
space-separated value flags, but a *leftover* positional after
resolution is the error.)

### Flag names are the developer's keystrokes verbatim

The flag's CLI name is exactly the schema's property key. If the
developer writes `shots`, the CLI flag is `--shots` and access is
`flags.shots`. If they write `max-shots`, the CLI flag is
`--max-shots` and access is `flags["max-shots"]`. No camelCase /
kebab-case transform. Type-system spec axiom: what you write is what
you see.

The convention recommendation (in CLAUDE.md after this lands): prefer
single-word flag names; for multi-word flags, kebab-case is Unix
convention and the bracket-notation access cost is fine because it
is rare.

## Migration

- **All 18 tools today** declare no `flags` field. Their `fn`
  signature does not change because the default `Fl = {}` makes
  `FlagsOf<{}> = {}`.
- **Oracle's `mode`** is currently an *input record field* — a
  protocol Value, not a CLI flag. It stays where it is. (Whether to
  *also* surface it as a `--mode` flag is a separate question; if
  yes, it becomes the canonical migration example.)
- **`tools/oracle/tool.ts:111`** currently forwards goldens-spec
  `flags: {[k]: v}` as `--${k}=${v}` to spawned tools. This still
  works because string-keyed unknown flags will now error. Action:
  goldens specs that pass flags must declare them in the target
  tool's schema first. Today no goldens.spec.ts does this (audited).
- **Scaffolder template** gains a commented-out `flags: { ... }`
  block and an import of `F` from `@workbench/contract`. New tools
  start in the typed-flags shape.

## Test plan

1. **Unit tests for the parser** in `packages/contract/test/`:
   - All four argv forms in the table above, against synthesised
     specs, assert the resolved typed object.
   - Type-level fixtures: `expectTypeOf<FlagsOf<{shots: F.int(…,
     {default: 100n})}>>().toEqualTypeOf<{shots: bigint}>()`. Use
     `bun test`'s type-assertion helpers or a `expect-type` shim.
   - Unknown flag → ToolError with the suggestion list.
   - Bool flag invoked with `=value` → ToolError.
   - Value flag invoked as bare switch with no following value →
     ToolError.
   - Int out of declared bounds → ToolError.
2. **In-process via `runTool(def, io)`**: feed argv with various
   shapes, assert the captured stdout matches the expected typed
   handling.
3. **Migration smoke**: pick one tool (proposal: a fresh, simple one
   — sturm-find, since its `shots` parameter is currently an input
   field but is morally a CLI knob) and migrate it as the
   acceptance demo.

## Resolved decisions (recorded for the implementation that follows)

These five calls were surfaced for the user; all five resolved to the
TS-expert-best-in-class-library default on 2026-05-03.

1. **Demo migration target.** Add a *new* flag (`--verbose` on
   `oracle` for richer per-golden output) rather than relocating an
   existing input-record field. Record-shaped knobs are
   provenance-hashable in their canonical place; flags are for
   genuinely CLI-shaped knobs. Don't duplicate.

2. **`--quiet` / `--verbose` as standard flags.** Defer. Filed as a
   follow-up beads issue. `rej` stays focused on the type machinery.

3. **Underscore-grouped int literals (`--shots=10_000`).** Yes —
   strip `_` before `BigInt(...)`. A TS expert who types
   `10_000` expects it to work.

4. **`F.enum` value type in v1.** String-only. Future enums over
   other types can come later when motivated.

5. **Naming.** Short forms — `F.bool / F.str / F.int / F.enum`.
   Compose better and match protocol's `int(0n) / str("x")` /
   `bool(true)` constructors.

## Acceptance (when this ADR ships as Accepted)

- `packages/contract/src/flags.ts` exists with the constructors and
  `FlagsOf<F>` inference.
- `packages/contract/src/runner.ts` parses argv against the merged
  standard + tool flag schema; `STD_TAKES_VALUE` is gone.
- `packages/contract/test/contract.test.ts` covers the parser table
  above plus type-level fixtures.
- One tool migrated end-to-end with a real CLI flag and goldens
  reflecting it.
- `--help` text auto-generated from the merged flag table.
- Scaffolder template emits the new shape.
- Worklog 029 documents the iteration.
- README "Standard flags" table and "Writing a new tool" section
  refreshed.

## Pointers

- `packages/contract/src/runner.ts:148-182` — current `STD_TAKES_VALUE`
  + `parseArgv` that this ADR replaces.
- ADR-0004 (`docs/adr/0004-schema-as-first-class-type.md`) — pattern
  reference: declare-once, infer-typed, validate-at-boundary.
- ADR-0010 (`docs/adr/0010-tool-module-shape.md`) — the recent split
  this builds on; `Fl` is the third generic on the same shape.
- ADR-0009 (`docs/adr/0009-ts-native-frontend-dsl.md`) — the
  axiom invoked throughout.
- Beads scientist-workbench-rej — the issue this ADR resolves.
