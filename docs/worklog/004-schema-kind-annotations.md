# 004 — F8: schema `kindOf` annotations

**Date:** 2026-04-28
**Status:** complete
**Issues:** scientist-workbench-rpb.7 (closed)
**ADR:** [docs/adr/0002-schema-kind-annotations.md](../adr/0002-schema-kind-annotations.md)

## Context

Every tool declares its I/O surface via `ToolDefinition.schema`, a
record with `input: Value` and `output: Value`. Until this iteration
every tool placed a *sample value* in those slots. For most tools that
worked: `cas-simplify` has input `expr("<describe-input>", [])` and
output `expr("<describe-output>", [])` — a reader infers "this tool
takes/produces expressions."

But sample-values lose information in two specific shapes:

1. **Empty containers.** `list([])` declares "this is a list" and says
   nothing about its element kind. `ntt`'s output schema was
   `list([])` — indistinguishable from a tool that produces
   `list<string>` or `list<record>`.
2. **Arbitrary leaves.** `int(0n)` says "the output is an integer," but
   the specific value `0` is meaningless. A reader has to know the
   convention "leaves are placeholders" to interpret it correctly.

`tools/registry-search` has a `recurseHasKind(v, kind)` helper that
walks sub-trees looking for a given kind. It works against populated
sample-values, but can't recover anything from `list([])`. So an agent
querying "tools that produce `list<integer>`" gets either nothing or
every list-producing tool — neither is correct.

This shipped friction at registry-search level, but the deeper problem
was that schemas weren't carrying the structural information they
should.

## What changed

A single new schema-marker convention, living entirely within the
existing `tagged`-value primitive. No new value-protocol kinds:

```ts
tagged "schema/kind" (symbol "integer")
```

reads as "any value of kind integer." Helper:

```ts
export function kindOf(k: Kind): TaggedValue
```

The marker composes naturally inside lists, records, expressions:

```ts
list([kindOf("integer")])                        // list of integers
record({                                          // record with these fields
  n:    kindOf("integer"),
  name: kindOf("string"),
  x:    list([kindOf("integer")]),
})
```

Inverse helper for consumers:

```ts
export function asSchemaKind(v: Value): Kind | null
```

returns the unwrapped kind for a `schema/kind` annotation, `null` for
anything else. `tools/registry-search`'s helpers were updated:

- `topKind(v)` now returns `asSchemaKind(v) ?? v.kind` — a slot
  declared `kindOf("integer")` is *for matching purposes* an integer.
- `recurseHasKind(v, kind)` treats schema-kind markers as leaves
  matching the named kind (it doesn't recurse into the wrapper's
  symbol payload, which would falsely match "symbol").

Three schemas migrated to demonstrate:

- `tools/ntt`: input `record({ direction: kindOf("string"), modulus:
  kindOf("integer"), n: kindOf("integer"), primitive_root:
  kindOf("integer"), x: list([kindOf("integer")]) })`; output
  `list([kindOf("integer")])`.
- `tools/mod-pow`: input `record({ base, exponent, modulus })` (each
  `kindOf("integer")`); output `kindOf("integer")`.
- `tools/mod-inv`: same shape; the no-inverse migration in shard 006
  added a record output, but the kindOf-on-fields convention was
  already in place.

The protocol package gained a public README documenting the helper
alongside the ten constructors.

## Why these choices

**Tagged-over-tagged, not a parallel SchemaValue type.** We considered
introducing a `SchemaValue` type alongside `Value` — explicit kinds
for "any integer," "list of T," "record of {...}." That's the path
most schema systems take, and it's the path we rejected.

The protocol's whole pitch is *ten kinds, exhaustive*. Adding a
parallel type doubles the cognitive load on every tool author and
every consumer. `tagged` was specifically designed for "extending the
value space without growing the protocol" (PRD §2.3 talks about
foreign-pass-through using exactly this mechanism). Schema-kind
annotations are a clean second use of the same hammer: a tag string
namespaces the convention, the payload carries structure.

**Migration is incremental, not breaking.** Tools that already declare
their schema with sample-values keep working. The `recurseHasKind`
walker handles both forms. New tools (and migrating ones) gain
precision without taxing old tools that were already correct.

**One annotation form, not two.** We considered also wrapping
list-element types: `tagged "schema/list-of" (kindOf "integer")`.
Decided against — `list([kindOf("integer")])` is already maximally
expressive (the list is structural, the element is a kind), and
adding a second wrapper invites two ways to spell the same thing.

## Frictions surfaced

The migration also revealed that the `recurseHasKind` walker was *too
permissive*: even with the new annotations, oracle still appears under
`output_kind=integer` because its output record has integer fields like
`passed`/`failed`/`total`. This is honest behaviour — oracle does
produce integers, just not at the top — but if we want a tighter
filter ("top-level only") we'd need a separate flag. Beyond F8's
scope; a future tightening if and when it bites.

## Acceptance

- 32 unit tests in mod-core test (none directly touching schemas, but
  no regressions).
- `bun run check` (now 14 phases) green.
- Tournament 64/64 still green.
- `registry-search --output_kind=list` finds `ntt`, `oracle`,
  `registry-list`, `registry-search` (4 tools whose top-level output
  is a list).
- `registry-search --output_kind=integer` finds `mod-inv`, `mod-pow`,
  `ntt`, `oracle`, `registry-list` — `ntt` correctly appearing
  because its `list([kindOf("integer")])` schema is recognised at the
  element level. **Before this change, `ntt` would have matched
  nothing useful at all.**

## Pointers

- ADR-0002 — captures decision and the why-not-parallel-schema-type
  rejection.
- `packages/protocol/src/kinds.ts` — `SCHEMA_KIND_TAG`, `kindOf`,
  `asSchemaKind` definitions, with literate-programming preamble.
- `packages/protocol/README.md` (new) — public surface, including the
  helper guidance ("prefer `kindOf` when the kind is the load-bearing
  fact; prefer a sample value when a specific shape is").
- `tools/registry-search/tool.ts` — `topKind` and `recurseHasKind`
  unwrapping logic.
- `CLAUDE.md` §Conventions — schema-annotation rule.
