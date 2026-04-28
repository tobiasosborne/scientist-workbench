# ADR-0004 — Schema as a first-class type

**Status:** Accepted (2026-04-28)
**Context:** beads issue scientist-workbench-ktd
**Supersedes:** complements ADR-0002 (`kindOf` annotations were the
shadow form of the same idea)

## Context

A `ToolDefinition` declares a schema for the tool's input and output.
In v0.2 the type was `{ input: Value; output: Value }`: the schema was
just *a sample value*, sometimes annotated with `kindOf("integer")`
(per ADR-0002), often a documentation string dressed as an
`expression` (`expr("<arithmetic expression over Q>", [])`). Three
problems compounded:

1. **The schema is documentation, not a contract.** A registry-search
   filter on `input_kind = "string"` walks the sample value tree
   looking for a top-level kind or a sub-tree match. That is heuristic
   pattern-matching against an example, not predicate evaluation
   against a type.

2. **The runner cannot validate inputs.** `runTool` parses stdin into
   a `Value` and hands it to `fn`. Every tool then re-implements the
   same handful of checks: "input must be a record; field `base` must
   be an integer; field `direction` must be `"forward"` or
   `"inverse"`." Read `tools/ntt/tool.ts:42–95` (50 lines of
   hand-rolled record validation) or `tools/mod-pow/tool.ts:23–35`
   (the `expectIntegerField` helper). The schema *already describes*
   what those checks need to enforce; the work happens twice.

3. **The agent-substrate thesis depends on schema being a type.** PRD
   §6.3 frames discoverability as "plan a composition by *type*, not
   by name." For an agent to compose tools correctly without running
   them, the type it reads from `--schema` must be the type the
   composed pipeline will actually accept. A sample-value can't
   support that. A schema language can.

The hint language already lives in `@workbench/json-bridge`
(`packages/json-bridge/src/index.ts:101–172`): `kindOf("integer")` for
leaves, `list([elementHint])` and `record({k: hk, …})` for structure.
That is — modulo packaging — already the schema language we need. This
ADR promotes it.

## Decision

Introduce a `Schema` type, distinct from `Value`, in
`@workbench/protocol`. Wire it into `ToolDefinition` and have the
`runTool` dispatcher validate both input and output against the
declared schema.

### The Schema type

`Schema<V extends Value>` is a runtime tagged union over schema nodes,
with a phantom type parameter `V` that captures the kind of `Value`
the schema describes. The phantom is never written at runtime; it
exists so that constructors compose at the type level:

```ts
S.record({ base: S.kind("integer"), modulus: S.kind("integer") })
//  : Schema<{ kind: "record"; fields: { base: IntegerValue; modulus: IntegerValue } }>
```

Schema nodes:

| Node           | Conforming Value                                                |
|----------------|-----------------------------------------------------------------|
| `any`          | every Value                                                     |
| `kind k`       | a Value with `value.kind === k`                                 |
| `literal v0`   | a Value canonically equal to `v0`                               |
| `list e`       | a `ListValue` whose every item conforms to `e`                  |
| `tuple [s_i]`  | a `ListValue` of length `n` with `items[i]` conforming to `s_i` |
| `record F O`   | a `RecordValue` with all required fields (= keys of F minus O) present and conforming, optional fields O if present conforming, no extras |
| `expression h? a?` | an `ExpressionValue` whose head matches `h` if specified and whose args match `a` (a tuple) if specified |
| `tagged t? p`  | a `TaggedValue` whose tag matches `t` if specified and whose payload conforms to `p` |
| `union [s_i]`  | conforms iff some `s_i` matches                                 |

Three deliberate omissions:

- **No recursive schemas.** A schema cannot reference itself. We have
  no use case in the v0.2 tools that needs it; recursion would
  motivate a `S.lazy(() => …)` form, which we add when the first
  recursive case lands.
- **No predicate / refinement nodes.** No `S.where(s, p)` where `p` is
  a TypeScript predicate. Schemas remain pure data so they
  round-trip through the value protocol.
- **No "open" records.** Every record schema is closed: extras throw.
  Strictness is the contract; loose records would let drift in.

### Conformance

`validate(v: Value, s: Schema): ConformanceResult` walks the schema
node-by-node and returns either `{ ok: true }` or `{ ok: false;
failure: { path, message } }`. The path is a dotted JSON-pointer-like
chain to the offending node, reconstructed lazily — the happy path
allocates nothing for path bookkeeping.

`conforms(v, s): v is V` is the type-narrowing sugar.

Literal equality is decided by canonical-bytes comparison
(`canonicalize(v) === canonicalize(literal)`). This is the same
equivalence the rest of the system uses for content addressing, so
schema literals participate in the protocol without inventing a
second equivalence relation.

Union evaluation is **first match wins** ordered by declaration. We
collect failures from non-matching alternatives and surface them in
the failure message when no alternative matches.

### Schema-as-Value transport

`--schema` must emit canonical bytes. We define a stable Value
encoding for every schema node:

```
any            → tagged "schema/any"        sym "any"
kind k         → tagged "schema/kind"       sym k
literal v      → tagged "schema/literal"    v
list e         → tagged "schema/list"       <encoded e>
tuple [s_i]    → tagged "schema/tuple"      list [<encoded s_i>]
record F O     → tagged "schema/record"     record { fields: record { k: <encoded F[k]>, … },
                                                      optional: list [str k_i, …] }
expression h a → tagged "schema/expression" record { head?: str, args?: list [<encoded s_i>] }
tagged t p     → tagged "schema/tagged"     record { tag?: str, payload: <encoded p> }
union [s_i]    → tagged "schema/union"      list [<encoded s_i>]
```

The encoding satisfies:
- `decodeSchema(encodeSchema(s))` is structurally equal to `s`.
- `encodeSchema` is deterministic (canonical-bytes equal for equal
  schemas).
- The pre-existing `kindOf(k)` value is exactly `encodeSchema(S.kind(k))`,
  so consumers that already understand `kindOf` keep working. ADR-0002
  is preserved as the wire-level form.

Registry tools (`registry-list`, `registry-search`) read `--schema`
output, decode it as a Schema, and reason on the Schema directly
rather than pattern-matching against a sample value.

### Runner integration

`runTool` validates the parsed input against `def.schema.input`
*before* calling `fn`. On failure it throws a `ToolError` whose
message includes the dotted path to the violation. Tool functions can
therefore trust their input as already-narrowed-to-the-schema and
drop their hand-rolled `expectIntegerField` / `parseNttInput` shims.

`runTool` also validates `fn`'s output against `def.schema.output`
before writing it to stdout. A non-conforming output is an internal
contract violation: the tool says it produces values of a certain
shape and produced something else. We surface this loudly rather than
shipping a bad value with a "honest scope" badge — honest scope is
about declining work, not about lying about what was done.

`defineTool({...})` (a typed identity wrapper around the
`ToolDefinition`) is added so authors get type inference at the call
site without writing `runTool({...} satisfies ToolDefinition<…>)`.

### Examples must conform

The `examples` array's `input`/`output` fields must conform to the
declared schema. We check this once at tool-load time, fast enough to
keep cold start under budget but loud enough to catch drift between
schema and examples at the moment they drift. A failing example is a
load-time error.

## Migration

This is a breaking change to the `ToolDefinition` shape. We do it as
one atomic landing rather than a backwards-compatibility shim:

1. Add `Schema` and `S` to `@workbench/protocol`.
2. Add `validate` / `conforms` / `encodeSchema` / `decodeSchema`.
3. Update `ToolDefinition.schema` to `{ input: Schema; output: Schema }`.
4. Migrate all nine tools (`expr-parse`, `cas-simplify`, `cas-verify`,
   `oracle`, `registry-list`, `registry-search`, `mod-pow`, `mod-inv`,
   `ntt`).
5. Update `registry.ts` `describeTool` to decode the new wire format.
6. Update `tools/registry-search/tool.ts` to filter on Schema.
7. Update README, PRD, CLAUDE.md.

CLAUDE.md is explicit that backwards-compat shims are not how we
iterate. The substrate is small enough that all-at-once is the right
shape.

## Consequences

**Positive.**
- Tool authors stop hand-rolling input validation.
- Examples are checked against the schema at tool load.
- Outputs that violate their declared shape fail loudly.
- Registry-search reasons over a real type, not a sample.
- The schema language is a single language across hint-driven JSON
  bridging, contract declarations, and registry filtering.

**Negative.**
- The protocol package grows. Schema lives there because it is
  conceptually downstream of `Value` and used by every layer above.
- Cold start gains a per-example conformance check (≤ 1 ms per
  typical tool; budget remains comfortable).
- The phantom type parameter on `Schema<V>` produces TS errors that
  are sometimes harder to read than non-generic ones. We accept this
  trade for the value of accurate `fn` input typing.

## Alternatives considered

**Stick with sample values.** Rejected: see the three problems in
context. A substrate that pretends documentation is a contract will
rot.

**Use Zod / a TS-only schema library.** Rejected: schemas must
round-trip through the value protocol so the registry can query
them without spawning the tool. Zod schemas don't serialize to a
canonical, content-addressed form. We'd end up with two schema
languages — one for TS, one for transport — and that drift is
exactly the failure mode this project was built to avoid.

**Generate schemas from TypeScript types.** Rejected: would tie the
substrate to the TypeScript type system as a source of truth. The
protocol explicitly erases the implementation language at the
boundary (PRD §1.3 pillar 4). A schema must be a value, not a TS
artefact.

**Open records by default.** Rejected: closed by default catches
typos (`--moed=exact`, a misspelled field) at the boundary. The
strict mode is what makes the schema useful as a contract.

## Pointers

- `packages/protocol/src/schema.ts` — the implementation.
- `packages/protocol/test/schema.test.ts` — conformance battery.
- `packages/contract/src/runner.ts` — `runTool` validation hooks.
- ADR-0002 — `kindOf` annotations (now the wire form for `S.kind`).
- ADR-0003 — output-error patterns (Schema lets us name the three
  output-shape categories at the type level).
