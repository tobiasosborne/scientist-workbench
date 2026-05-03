# 029 — Typed flag declarations on `ToolDefinition`

**Date:** 2026-05-03
**Status:** complete
**Branches:** main
**ADR:** [0011-typed-flags](../adr/0011-typed-flags.md)
**Issues closed:** scientist-workbench-rej (P1)
**Issues filed:** scientist-workbench-5gl (standard `--verbose`/`--quiet`,
follow-up; P3)

## Context

The runner used a fragile heuristic for argv parsing — greedy
consumption of the next arg as a flag value when it didn't start with
`-`. So `--equal 1` silently became `equal: "1"`; `--mode -2` was
misread as switch + positional. Tool authors received `flags:
Record<string, string>` and string-compared values; typos like
`--moed=exact` passed silently. The `STD_TAKES_VALUE = new Set([
"provenance-of"])` set in `runner.ts` was the smell — it privileged
one flag because the heuristic could not be trusted.

Beads scientist-workbench-rej (P1) tracked the fix. The natural
pairing with worklog 028's `defineTool` / `runTool` split was the
cue: now that the contract's generic surface was clean, adding a
third generic for typed flags was a clean extension rather than a
big-bang rewrite.

## What changed

**`packages/contract/src/flags.ts`** (new, ~280 LOC). Defines the
`F.*` constructor namespace (`F.bool`, `F.str`, `F.int`, `F.enum`),
the `FlagSpec` / `FlagSchema` types, the `FlagsOf<F>` type-level
inference helper, the `parseFlagsFromArgv` parser, and the
`renderFlagsHelp` formatter. The parser implements ADR-0011's strict
declared arity: a bool flag is a switch (no `=value`, no following
value); a value flag (str/int/enum) consumes either an inline
`=value` or the next argv token regardless of its shape. Unknown
flags throw `FlagParseError` carrying a suggestion that lists the
valid set. Unexpected positionals are not caught here — the runner
catches them after parse — but absence of a value for a value-flag
is.

`F.int` strips `_` characters before `BigInt(...)` so callers can
type `--shots=10_000` (resolved decision #3 in the ADR). `F.enum`
preserves literal-union typing via `<const V>` so `flags.mode` is
`"exact" | "structural"`, never widened to `string`. `F.int` enforces
optional `min` / `max` bounds at parse time.

**`packages/contract/src/runner.ts`** — `ToolDefinition` gains a
third generic `Fl extends FlagSchema = Record<string, never>`. The
default makes `FlagsOf<{}>` an empty record, so the 18 existing
tools (which declare no flags) keep their `fn(input, _flags)`
signature unchanged — migration is opt-in. The runner's `STANDARD_FLAGS`
table declares `--help / --version / --schema / --examples /
--invariants / --test / --provenance-of` as flag specs. `mergedFlags`
combines tool flags with the standard set and throws on collisions
(checked inside the try block so a colliding tool surfaces as a
normal stderr + exit 1, not an unhandled exception). The work-case
flag dispatch reads typed fields off the parsed object directly:
`if (stdFlags.help) { ... }`. `STD_TAKES_VALUE` is gone. Help text
is auto-rendered from the merged flag table.

Provenance now records only *explicitly-set* tool flags (not the
standard ones, not defaulted values). Two invocations differing only
in default-overlap produce byte-equal provenance.

**`packages/contract/test/contract.test.ts`** — 22 new tests across
two `describe` blocks: 17 unit tests for the parser (one per
constructor × form, plus type-level fixture, plus help rendering)
and 5 end-to-end tests that drive `runTool(echoDef, io)` with an
in-test `defineTool` that exercises bool/int/enum flags. Total
contract test count: 38 pass, 103 expect calls, 130ms.

**`tools/oracle/tool.ts`** — first migrated tool. Adds `flags: {
verbose: F.bool("emit per-golden progress lines to stderr") }`. When
set, the fn writes one stderr line per golden (`✓ name.golden.json`
or `✗ name.golden.json: <reason>`) — useful for noisy goldens
directories where you want progress before the final summary record.
Bumped to v0.4.0. The canonical results record on stdout is unchanged
either way; the flag only controls stderr noise.

**`tools/oracle/README.md`** — added a "Tool flags" section
(lockstep doc update per Law 2).

**`tools/sturm-find/tool.ts`** — one tiny annotation removed: the
explicit `_flags: Record<string, string>` type on the `fn` param,
which conflicted with the new typed-flag generic. The function body
was unchanged; only the type annotation needed dropping. (All other
17 tools used the inferred-parameter form already and were not
touched.)

**`scripts/new-tool.ts`** — scaffolder template gains a commented-
out `flags: { ... }` block with all four constructor examples, an
import of `F` from `@workbench/contract`, and a comment that the
`fn`'s `_flags` param becomes typed once flags are declared.

**`packages/contract/src/index.ts`** — re-exports the new public
surface: `F`, `FlagParseError`, `parseFlagsFromArgv`,
`renderFlagsHelp`, plus the types `BoolFlag` / `StrFlag` / `IntFlag`
/ `EnumFlag` / `FlagSpec` / `FlagSchema` / `FlagsOf` / `ParsedFlags`.

**`README.md`** — refreshed the "Standard flags" section to describe
the strict-declared-arity rules and point at the auto-generated
`--help` table (lockstep per Law 2).

## Why these choices

**Separate `F.*` namespace from `S.*`.** Schemas describe Values
inside the canonical JSON value protocol; flags describe argv
strings. Conflating them entangles two type systems that share no
vocabulary. Tool authors import `S` from `@workbench/protocol` and
`F` from `@workbench/contract`; the file reads cleanly because the
two namespaces stay separate.

**Short forms (`F.bool/.str/.int/.enum`).** They compose at the call
site (`{ shots: F.int(...), mode: F.enum([...]) }`) and match the
protocol's `int(0n) / str("x") / bool(true)` value constructors —
existing house style. Resolved decision #5 in ADR-0011.

**Strict declared arity, no heuristics.** A TS expert running
`--shots -2` for an int flag expects `-2` to be the value — and a TS
expert running `--equal 1` for a bool switch expects `1` to be a
positional. Both work *only* when the parser knows the declared kind
up front. The old heuristic ("if next arg doesn't start with `-`,
consume it") could not deliver both. Strict arity does.

**Standard flags baked into the runner, merged at parse time.**
Tools never redeclare `--help` or `--version`. A tool's flag whose
name collides with a standard flag throws at runTool entry. This is
the single point where flag-name uniqueness is enforced.

**`Fl extends FlagSchema = Record<string, never>` default.**
`Record<string, never>` is the canonical "empty object" type in TS;
it makes `FlagsOf<{}>` resolve to `{}` cleanly while preserving
covariance. The 18 existing tools' `fn` signatures don't change.

**Provenance records only explicit flags.** Two invocations of a
tool, one passing `--mode=fast` (the default) and one omitting the
flag entirely, produce identical effective behaviour. Recording the
default in provenance would make those two invocations produce
*different* provenance bytes — a leaky abstraction. We record only
what the caller explicitly said, so byte-equality of provenance
tracks byte-equality of *intent*.

**Demo migration: a new flag, not a relocated one.** The ADR
considered moving sturm-find's `shots` field from input record to
CLI flag. Rejected: record fields are canonical and provenance-
hashable in their natural place; CLI flags are for genuinely
CLI-shaped knobs. Adding `--verbose` to oracle gave the demo a
meaningful surface (stderr-progress for noisy goldens) without
duplicating data across two channels.

## Frictions surfaced

**1. `exactOptionalPropertyTypes: true` makes spread-undefined
unsafe.** First attempt at `F.str` did `{ kind: "str", doc, default:
opts?.default }` which gives `default: undefined` — and TS refuses
to assign that to a field declared `default?: string`. Fix: build
the object incrementally, only assigning `default` when actually
present (`if (opts?.default !== undefined) (out as {default?: D}).default
= opts.default`). Same pattern for min/max. Kept `as { default?: D }`
casts narrow so the public type is preserved.

**2. `ToolError({ suggestion: e.suggestion })` rejected when
suggestion is `string | undefined`.** The runner forwards
`FlagParseError` into `ToolError`. With strict optional-property
types, you can't assign a possibly-undefined value into an
`undefined`-not-permitted optional field. Fix: build the options
object conditionally before constructing the error. Same shape as
above.

**3. The standard-flag-collision check threw outside the try
block.** First draft computed `mergedFlags(toolFlags)` before the
`try {`, so a tool with a colliding flag name produced an unhandled
exception instead of the normal stderr + exit 1 path. The test for
this case caught it immediately. Fix: move the check inside the
try block. The lesson is the same one shard 028 ran into: when a
test fails because the *error path* differs from the *happy path*,
look at where the throw originates, not just whether it throws.

**4. `tools/sturm-find/tool.ts` had an explicit `_flags:
Record<string, string>` annotation.** Every other tool used the
inferred-parameter form (`fn: (input, _flags) => ...`). The
explicit annotation conflicted with the new `FlagsOf<Fl>` type.
Just dropping the annotation fixed it; no code change needed in
the body. The lesson for the scaffolder template is to *not* emit
explicit type annotations on `fn`'s parameters — let the inferred
generics do the work. The template was updated accordingly.

**5. Type-level fixtures are runtime tests in disguise.** A test
that says `const fixture: Flags = { ... }` is a compile-time
assertion: if `FlagsOf<F>` infers wrong, tsc fails and `bun run
check` fails on the typecheck phase. The runtime `expect(...)`
calls in the same test are redundant for the type fact but useful
as readability anchors — they make the intent explicit when
someone else reads the test. Worth doing both.

## Acceptance

- `bun run check` is green: 31 phases pass, 4 skipped, 0 failed.
- `bun test packages/contract/test/contract.test.ts` reports 38
  pass, 0 fail, 103 expect calls, ~130ms.
- `STD_TAKES_VALUE` does not appear anywhere in `packages/contract/src/`
  (verified: `grep -r STD_TAKES_VALUE packages/contract/src/` empty).
- Manual smoke: `echo '{...}' | bun tools/oracle/tool.ts --verbose`
  emits 32 progress lines on stderr for the mod-pow goldens
  directory and the canonical record on stdout, both as expected.
- `bun tools/oracle/tool.ts --help` shows both standard and tool
  flag sections with column-aligned defaults.
- `bun tools/mod-pow/tool.ts --moed=exact` (typo) emits
  `mod-pow: unknown flag --moed` to stderr and exits 1.
- The 18 existing tools still typecheck without changes apart from
  the one annotation removal in sturm-find.

## Pointers

- `packages/contract/src/flags.ts` — entire flag system.
- `packages/contract/src/runner.ts:148-163` — `STANDARD_FLAGS`.
- `packages/contract/src/runner.ts:325-333` — `mergedFlags` collision check.
- `packages/contract/src/runner.ts:355-385` — argv parse +
  positional rejection.
- `packages/contract/src/runner.ts:475-485` — provenance flag
  recording (explicit only).
- `packages/contract/test/contract.test.ts:283-411` — parser tests.
- `packages/contract/test/contract.test.ts:413-560` — runTool
  end-to-end tests.
- `tools/oracle/tool.ts:142-161, 220-225` — the migrated demo:
  `flags: { verbose: F.bool(...) }` plus per-golden stderr in fn.
- ADR-0011 — design rationale and the five resolved decisions.
- Beads scientist-workbench-5gl — follow-up for standard
  `--verbose`/`--quiet`.

## Open questions

- **Should `oracle`'s declared `--verbose` merge with a future
  standard `--verbose` once issue 5gl lands?** The natural answer is
  yes: the tool's spec just inherits the standard one, no per-tool
  declaration needed. If a tool's per-flag stderr behaviour differs
  from the standard's "show progress" semantics, that's a code
  smell — the tool should rename its knob.
- **Underscore-stripping is currently `_` only.** Some users type
  spaces or commas (`--shots=10,000`); we don't accept those.
  Probably YAGNI but worth flagging. The error message points at
  underscores explicitly so users learn the supported form.
- **Type-level: should `FlagsOf<F>` produce optional properties for
  no-default flags, or `T | undefined` required properties?** Today
  it's the latter (`name: string | undefined`, not `name?: string`).
  That makes `flags.name` always present in the typed object, just
  potentially undefined. The TS expert's expectation is debatable;
  the runtime semantics are equivalent. Keeping the present-but-
  maybe-undefined form for symmetry with `Record<string, never>`
  default behaviour.
