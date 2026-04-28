# 008 — Schema as a first-class type

**Date:** 2026-04-28
**Status:** complete
**Branches:** main
**Issues:** scientist-workbench-ktd (closes); related closure of 73m, 7q0,
1d9 (doc-lockstep drift fixed in the same edit cycle).

## Context

A code review of v0.2 surfaced 27 findings. The largest one was that
the schema in `ToolDefinition` was a `Value`, not a type: tool authors
declared `expr("<arithmetic expression over Q>", [])` or
`record({tool_path: str("..."), goldens_dir: str("...")})` and the
runner did nothing with it beyond echoing it under `--schema`. The
problems compounded:

1. Every tool reimplemented the same input-validation shim
   (`expectIntegerField` in `mod-pow`, `parseNttInput` in `ntt`, the
   `if (input.kind !== "record")` ceremony in `cas-verify` and
   `oracle`). Schemas knew the shape; the runner refused to use it.
2. `registry-search` walked the sample-value tree heuristically,
   pattern-matching on top-level kinds and ad-hoc deep mentions. That
   is documentation lookup masquerading as type query.
3. The agent-substrate thesis (PRD §6.3 — "plan a composition by
   *type*, not by name") cannot be honoured if the type is an example.

The hint language already in `@workbench/json-bridge`
(`kindOf` leaves, `list([elementHint])`, `record({k: hk})`) was the
right vocabulary in the wrong place.

## What changed

ADR-0004 formalises the design. The implementation:

- **`packages/protocol/src/schema.ts`** (new). Tagged-union
  `SchemaNode` over nine cases: `any`, `kind`, `literal`, `list`,
  `tuple`, `record`, `expression`, `tagged`, `union`. Wrapped in
  `Schema<V extends Value>`, where `V` is a phantom type parameter
  inferred from the constructors. `S.record({a: S.kind("integer"),
  b: S.kind("string")})` produces
  `Schema<{kind: "record"; fields: {a: IntegerValue; b: StringValue}}>`.
  Optional fields are threaded via a `const O extends readonly (keyof
  F & string)[]` parameter and a mapped-type split that places
  optional keys on the `?:`-typed half of an intersection.
- **`validate(v, s): ConformanceResult`**. Walks the schema tree
  depth-first, producing a `{ok: false, failure: {path, message}}` on
  the first mismatch. Path tracking uses a parent-link `PathFrame`
  rather than array spreading: the happy path allocates nothing for
  bookkeeping, paths are reconstructed lazily on failure. (The
  pattern subsumes beads issue `lbl` for the schema module; the
  remaining call sites in `canonical.ts` / `validate.ts` will be
  migrated under that issue.)
- **`encodeSchema` / `decodeSchema`**. Each schema node has a
  canonical Value encoding. `--schema` emits these bytes; consumers
  decode them. `S.kind(k)` encodes to the same wire form as
  `kindOf(k)` (ADR-0002), so the existing wire vocabulary is
  preserved.
- **`schemaTopKind`, `schemaMentionsKind`, `schemaExpressionHead`**.
  First-class queries on Schema for registry-search to use instead of
  walking sample values.
- **`defineTool({...})`**. Identity wrapper that lets TS infer `I, O`
  at the call site. `runTool(def)` validates input against
  `def.schema.input` *before* calling `fn`, and validates output
  against `def.schema.output` after. The non-conforming-output path
  is loud (`ToolError`), per ADR-0004's honest-scope reasoning. A
  tool-load-time hook checks every example conforms to the declared
  schema, so example/schema drift surfaces immediately.
- **63 schema tests** in `packages/protocol/test/schema.test.ts`
  covering happy/unhappy paths for every node, optional/required
  fields, closed-record extras, union first-match-wins, transport
  round-trip, wire compatibility with `kindOf`, and the top-level
  helpers.

All nine tools migrated:

- `mod-pow`, `mod-inv`, `ntt` — strict record schemas with kind-typed
  fields. The hand-rolled `expectIntegerField` shims are gone; `fn`
  reads `input.fields.base.value` directly knowing the runner has
  validated.
- `expr-parse` — input `S.kind("string")`; output a literal-driven
  union `S.expression("+") | S.expression("-") | ... | S.kind("integer")
  | S.kind("rational") | S.kind("symbol")`.
- `cas-simplify` — `S.any()` on both sides (the in-scope set is "any
  Value the simplifier can interpret"; output is "any canonical
  Value, possibly with `cas-simplify/out-of-scope` wraps"). Both
  ends are deliberately broad — the alternative was to lie.
- `cas-verify` — input `record { lhs: any, rhs: any }`; output the
  ADR-0003 record-with-flag with optional `reason`, `witness`,
  `side`, `detail`.
- `oracle` — input has an enum `mode` modelled as a literal-union
  optional field; output describes its full result-record shape
  including the per-golden result-list element shape.
- `registry-list`, `registry-search` — both consume a record of
  optional filters; both decode each tool's `--schema` via
  `decodeSchema` and reason on real `Schema` objects via the
  top-level helpers.

The wire format for `--schema` changed from "sample value" to
"encoded Schema." `describeTool` decodes on the way in; consumers
work with `Schema` directly. CLAUDE.md is explicit about no
backwards-compat shims for design changes; this is a clean break.

Two protocol-package tweaks the work depended on:

- `record` and `list` constructors are now generic in the
  field/element types, preserving narrow inferred Value shapes
  through schema-typed slots. The widened return types
  (`RecordValue`, `ListValue`) are still satisfied by structural
  subtyping; existing callers are unaffected.
- `ExampleEntry`'s `input` and `output` use `NoInfer<I>` / `NoInfer<O>`
  so example types do not leak into `defineTool`'s I/O inference.
  Without this, a tool with an example that omits an optional field
  would have `fn` see a narrower input type than the schema declares.

Lockstep doc updates:

- README catalog — `mod-pow`, `mod-inv`, `ntt` added (closes
  scientist-workbench-73m).
- README file layout — `mod-core`, `json-bridge` listed (closes
  scientist-workbench-7q0).
- README — new "The schema language" section; the contract section
  now references `defineTool`, schema-driven validation, and example
  conformance.
- PRD §0.1, §2.2 — `string` documented as primitive #10 (closes
  scientist-workbench-1d9). §0.1 §4 acknowledges ADR-0004.
- PRD §4.1, §4.2 — interface and required-artefacts sections rewritten
  for the schema-typed contract. §10.1 next-actions list updated.
- CLAUDE.md — "Conventions worth knowing" updated: schemas are the
  vocabulary, `S.*` are the constructors, `defineTool` is the entry.
- ADR-0004 itself.

## Why these choices

**Schema in `@workbench/protocol`, not a separate package.** Schema is
conceptually downstream of `Value`; every layer above values uses it.
A separate `@workbench/schema` package would force every tool to
declare a third workspace dep, and json-bridge would have a circular
relationship with it. Protocol is the right level.

**Tagged union for `SchemaNode`, not class hierarchy.** Schemas must
be pure data so they round-trip through canonicalisation, hash to a
content-address, and survive transport without reconstructing class
identities. `tag`-discriminated objects are the only honest shape for
that — and TS narrows them cleanly without the ceremony of methods.

**Phantom `V` over a runtime tagged-union type.** The alternative was
a separate `ValueOf<S>` type alias and no `Schema<V>` parameter at
all; `defineTool({schema: {input: someSchema}, fn})` would then need
the user to write `(input: ValueOf<typeof someSchema>, _) => ...`
explicitly. Phantom-typed `Schema<V>` lets the inference happen at
the constructor site, threaded through every helper, with the user
writing `fn: (input, _flags) => ...`.

**`NoInfer` on examples.** Discovered the hard way during oracle's
migration: TS picks `I` from the union of (schema-implied type) ∪
(example-input type) and lands on the narrower one when an example
omits an optional field. `NoInfer` says "this position checks but
does not infer," which makes the schema unambiguously the source of
truth. TS 5.4+ feature; the workspace is on 5.6.

**Closed records, no open mode.** Open records would silently accept
typos (`--moed=exact` against a `mode` field). Strict closed records
catch them. We can add `S.record(F, {extras: "allow"})` later if a
genuine use surfaces — none has yet.

**No predicate / refinement nodes.** A schema like `S.where(s, p)`
where `p` is a TS predicate would not round-trip — schemas are
values. Domain-specific constraints (modulus = 998244353; n divides
p − 1) live in `fn` bodies as `ToolError` checks. The schema
declares the type; the body declares the predicate. We may later add
a structurally-encoded refinement vocabulary; we don't have it yet.

**Output validation is loud, not soft.** ADR-0003 says a tool that
silently produces a wrong-shaped output is broken even if it computes
the right answer. The runner now enforces that: a non-conforming
output throws `ToolError`. The cost is one schema walk per output —
linear, well within the 100ms cold-start budget.

## Frictions surfaced

- **`const` type-parameter inference is path-sensitive.** I initially
  declared `RecordSchemaOptions<F, O>` as a named interface and
  threaded `O` through it. TS's `const O` modifier did not propagate
  the literal-array narrowing through the indirection — `O` widened
  to `string[]` and the optional half of `RecordValueOf` collapsed.
  Inlining the options-object type at the function signature
  (`options?: { readonly optional?: O }`) fixed it.
- **Example-input inference vs schema inference.** TS's bidirectional
  inference put example types on equal footing with the schema and
  picked the narrower. `NoInfer<I>` was the textbook fix; spotting
  that this was the cause took longer than fixing it.
- **`exactOptionalPropertyTypes: true` on phantom-typed records.**
  When `decodeSchema` reconstructs a record schema from the wire, it
  has only runtime-string optional keys, not literal-typed ones. The
  resulting schema's `V` widens to "every field optional," which
  `exactOptionalPropertyTypes` rejects as not assignable to
  `RecordValue`. Resolved by hand-constructing the `SchemaNode` in
  the decode path and returning `Schema<Value>` (the wire format
  doesn't carry refinement-level type information anyway).
- **Generic helper typing in the runner.** `helpText(def)` and
  `checkExamplesAgainstSchema(def)` had to become generic in `<I, O>`
  because the variance of `ToolDefinition<I, O>` doesn't allow
  casting a specific instantiation to the default. Trivial fix; the
  initial form with `as ToolDefinition` casts gave a confusing
  variance error.

## Acceptance

- `bun tsc --noEmit` is clean across all packages and tools.
- `bun test` — 181 pass / 0 fail across 15 files.
- `bun run check` — 14 phases pass, 4 skipped (tools without `--test`
  hooks), 0 fail. Includes typecheck, workspace tests, every tool's
  `--test` hook, and oracle on every tool's goldens (202 total).
- `bun run goldens` regenerates all 202 goldens cleanly.
- ADR-0004 filed; all the relevant sections of README, PRD,
  CLAUDE.md updated in the same landing.

## Pointers

- `docs/adr/0004-schema-as-first-class-type.md` — the decision.
- `packages/protocol/src/schema.ts` — the implementation.
- `packages/protocol/test/schema.test.ts` — 63 tests, the conformance
  battery and transport round-trip.
- `packages/contract/src/runner.ts` — `defineTool`, the runner's
  input/output validation hooks, the example-conformance check.
- `tools/mod-pow/tool.ts` — the canonical example of a migrated
  tool: hand-rolled validation gone, `fn` body reads typed fields.
- ADR-0002 — `kindOf` is now the wire form for `S.kind`; preserved.
- ADR-0003 — record-with-flag and tagged-out-of-scope, both
  expressible at the schema level.
