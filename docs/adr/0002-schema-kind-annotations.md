# ADR-0002 — Schema kind annotations: `kindOf` over sample values

**Status:** Accepted (2026-04-28)
**Context:** beads issue scientist-workbench-rpb.7 (F8)
**Supersedes:** —

## Context

Every tool declares its I/O surface via `ToolDefinition.schema`:

```ts
{
  input:  Value;
  output: Value;
}
```

Until now, every tool placed a *sample* Value in those slots. For most
tools that worked: `cas-simplify`'s input is `expr("<describe-input>", [])`,
its output is the same shape. The reader sees an expression and infers
"this tool takes/produces expressions."

But sample-values lose information in two specific shapes:

1. **Empty containers.** `list([])` declares "this is a list," but says
   nothing about its element kind. `ntt`'s output schema was `list([])` —
   indistinguishable from a tool that returns `list<string>` or
   `list<record>`.
2. **Arbitrary leaves.** `int(0n)` says "the output is an integer," but
   the specific value `0` is meaningless. A reader has to know the
   convention "leaves are placeholders" to interpret it correctly.

`tools/registry-search` has a `recurseHasKind(v, kind)` helper that walks
sub-trees looking for a given kind. It works against sample-values when
they're populated, but cannot recover anything from an empty list. So an
agent searching the registry for "tools that produce `list<integer>`"
gets either nothing, or every list-producing tool — neither is correct.

## Decision

Introduce a single new schema-marker convention that lives entirely
within the existing tagged-value primitive, no new kinds:

```
tagged "schema/kind" (symbol "integer")
```

means "any value of kind `integer`." Helper:

```ts
export function kindOf(k: Kind): TaggedValue
```

The marker composes naturally inside lists, records, expressions:

```ts
list([kindOf("integer")])                    // list of integers
record({                                     // record with these fields
  n:    kindOf("integer"),
  name: kindOf("string"),
  x:    list([kindOf("integer")]),
})
```

Consumers that walk schemas (notably `registry-search`) recognise the tag
via `asSchemaKind(v)` and treat it as if the value were a member of the
named kind — top-level `topKind` returns the unwrapped kind, and
`recurseHasKind` traverses through the wrapper.

The migration is incremental: tools that already declare their schema
with sample-values keep working. Tools that gain richer kind information
(`ntt`, `mod-pow`, `mod-inv`, eventually all of them) migrate one at a
time. There is no breaking change to the value protocol — `tagged` was
already a kind, this is just a convention on the tag string.

## Why not a parallel "schema-Value" type?

We considered introducing a `SchemaValue` type alongside `Value` —
explicit kinds for "any integer," "list of T," "record of {...}." That's
the path most schema systems take.

We rejected it because:

- The protocol's whole pitch is *ten kinds, exhaustive*. Adding a
  parallel type system doubles the cognitive load on every tool author
  and every consumer.
- `tagged` was specifically designed for "extending the value space
  without growing the protocol." This is exactly that case.
- Tools whose schema is genuinely tied to a sample (e.g. `cas-simplify`'s
  output really *is* always an expression with operator heads) shouldn't
  pay any complexity tax. They keep declaring `expr("<describe>", [])`.

## Consequences

**Positive:**

- `registry-search --output_kind=integer` now distinguishes
  `list<integer>` from `record { x: integer }`.
- Tools that compose downstream (NTT → polynomial multiply → reduce)
  can declare and check their pipeline at the schema level.
- Schema-aware tooling (a future `tool-doc-gen`, an LSP companion, an
  agent's planner) gets a structured surface to reason against.

**Negative:**

- Two ways to declare the same thing: `int(0n)` vs `kindOf("integer")`.
  We pick a default in `CLAUDE.md`: prefer `kindOf` when the *kind* is
  the load-bearing fact; prefer a sample Value when a *specific shape*
  is the load-bearing fact (heads, field names, etc.).
- New tools must know about both. The scaffolder template already
  imports the helpers, so the discovery cost is one comment.

**Neutral:**

- Existing tool schemas keep working unchanged. Migration happens as
  authors edit tools for other reasons.

## Test plan

- `kindOf("integer")` round-trips through `parse(canonicalize(...))`.
- `asSchemaKind` returns the unwrapped kind for the marker, `null` for
  any other tagged value.
- `tools/registry-search` filters correctly on schemas that use the
  marker — verified with the migrated `ntt` schema.
- `bun run check` stays green during the migration.
