# 111 — `tagged` / `taggedSchema` preserve their payload type (bead x0lc)

> **Scope.** Close bead `x0lc`. Make `tagged` (value constructor) and
> `taggedSchema` (schema constructor) generic in their payload, so a
> helper that builds tagged values keeps the narrow payload type instead
> of widening to `TaggedValue` and forcing an `as never` cast at every
> call site. ~25 LOC of types across `packages/protocol`, no runtime
> behaviour change.

## Context

Bead `x0lc` was filed 2026-05-10 out of D_W1 dogfood friction: the
`@workbench/protocol` container constructors widened their contents to
the `Value` union, so the moment a TS expert *extracts a helper* —
which they do reflexively — narrowing was lost and the helper's callers
needed `as never`. The bead is explicit that this "cuts directly
against the two principles": the workbench is meant to be irresistible
to TS experts, and a constructor that punishes the reflex to factor is
the opposite.

**Law-1 ground-truth check first, and it paid off.** The bead text
claims `list` and `record` widen. They do **not** — `packages/protocol/
src/kinds.ts` already carries a doc-comment block explaining that `list`
and `record` are generic and "preserve the structural type of their
argument (rather than widening to `ListValue` / `RecordValue`)." That
was fixed at some point between the bead being filed and this session.
The bead was stale on two-thirds of its surface. The *actual* remaining
gap was a single constructor: `tagged`, which still read

```ts
export const tagged = (tag: string, payload: Value): TaggedValue => …
```

and its schema-side mirror `taggedSchema`, which accepted a `Schema<P>`
but threw `P` away by returning `Schema<TaggedValue>` — inconsistent
with `listSchema` (`Schema<ListValueOf<E>>`) and `recordSchema`
(`Schema<RecordValueOf<F>>`), which both thread their content type.

## What changed

**`packages/protocol/src/kinds.ts`** — `tagged` is now
`<P extends Value>(tag, payload: P)` returning the inlined structural
type `{readonly kind:"tagged"; readonly tag:string; readonly payload:P}`.
This mirrors exactly how `list` and `record` already inline their return
types (kinds.ts cannot import the `*ValueOf` aliases — `schema.ts`
imports *from* `kinds.ts`, one direction only). `kindOf` keeps its
explicit `: TaggedValue` annotation: a schema-kind annotation
deliberately wants the wide type, and the narrowed return is assignable
to it, so nothing there changed.

**`packages/protocol/src/schema.ts`** — new `TaggedValueOf<P>`
interface beside `ListValueOf<E>` (one type parameter, structurally
narrowed, still a subtype of the wide `TaggedValue`). `taggedSchema`
now returns `Schema<TaggedValueOf<P>>`, so `ValueOf<typeof schema>`
threads the payload type through to tool I/O inference.

**`packages/protocol/src/index.ts`** — `TaggedValueOf` added to the
type re-export block.

**`packages/protocol/test/schema.test.ts`** — a new
`constructor narrowing (compile-time canary)` describe block with two
tests. The runtime `expect`s are incidental; the load-bearing assertions
are the *type annotations* — `const payload: IntegerValue = t.payload`
compiles only if `tagged` stayed narrow, and `const conforming:
ValueOf<typeof ts> = tagged(…, int(3n))` compiles only if both `tagged`
and `taggedSchema` stayed narrow. `bun run typecheck` is the alarm.

**`packages/protocol/README.md`** — the "Constructing values" section
gains a paragraph stating that `list` / `record` / `tagged` are generic
in their contents, that the narrowed types are covariant subtypes of
the wide variants (so existing `Value`-typed code is unaffected), and
that the schema constructors mirror it.

## Why these choices

**Single generic signature, no fallback-overload pair.** The bead
suggested keeping "the wide-union signatures … as fallback overloads."
That is unnecessary: a narrowed return is *assignable to* the wide type
(covariance), so the single generic signature already subsumes every
wide-typed call site. `list` and `record` are the in-repo precedent —
both are single generic signatures with no overload pair — and the
typecheck across the whole workspace passes clean, which proves the
point empirically. Following the established pattern is the more
TS-expert-honest choice and keeps the four container constructors
uniform.

**Inline structural type in `kinds.ts`, named `TaggedValueOf` in
`schema.ts`.** This is not a free choice — the module graph forces it.
`kinds.ts` is upstream of `schema.ts`, so `tagged` cannot reference a
`schema.ts` type; it inlines, exactly as `list`/`record` do. `schema.ts`
*is* the home of the `*ValueOf` family, so `TaggedValueOf` lives there
and `taggedSchema` uses it. The two ended up structurally identical,
which is correct — they describe the same shape from the value side and
the schema side.

## Frictions surfaced

- **The bead was two-thirds stale.** Time spent reading `kinds.ts`
  before editing (Law 1) is what caught it — a session that trusted the
  bead text would have "fixed" `list` and `record` that were already
  generic, and possibly regressed them. Logged on the bead at close.
- **No type-level test infrastructure exists.** The protocol test
  suite has no `Expect`/`Equal` helper. Rather than introduce one for
  a single bead, the canary uses plain typed-assignment + member-access
  — `const x: NarrowType = constructor(...)` fails to compile if the
  constructor widens. It is lower-ceremony and reads as ordinary TS.

## Acceptance

- `bun run typecheck` — clean across the whole workspace; **no call
  site needed an update**, confirming the covariant-subtype reasoning.
- `bun run check:quick` — 4 phases, 0 failed.
- `bun test packages/protocol/` — 100 pass / 0 fail (was 98; +2 canary).
- **Mutation-proven** (Rule 6 / Rule 7): reverting `tagged` to the wide
  `(tag, payload: Value): TaggedValue` signature turns the canary RED
  with the exact expected errors —

  ```
  schema.test.ts(437): Type 'Value' is not assignable to type 'IntegerValue'.
  schema.test.ts(445): Type 'TaggedValue' is not assignable to type 'TaggedValueOf<IntegerValue>'.
  ```

  and *also* breaks `scripts/demo-scope.ts` and `tools/choi-iso/tool.ts`
  — i.e. real call sites already depend on the narrowing, so it is
  genuinely load-bearing, not speculative. Restored → clean.

## Pointers

- Bead: `scientist-workbench-x0lc`.
- Downstream: unblocks `qiv8` (`@workbench/json-bridge` `matrixToValue`
  / `valueToMatrix` helpers) — those helpers can now return narrow
  tagged/list/record types without an `as never` tax.
- ADR-0004 (schema as a first-class type) is the governing decision;
  this is a consistency refinement within it, not a new ADR.
- `packages/protocol/src/{kinds,schema,index}.ts`,
  `packages/protocol/test/schema.test.ts`,
  `packages/protocol/README.md`.
