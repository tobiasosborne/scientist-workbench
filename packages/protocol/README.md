# @workbench/protocol

The value protocol — ten primitive kinds, their canonical encoding, and the
helpers every tool author touches.

```ts
import {
  // ten primitive constructors
  sym, str, int, rat, float64FromNumber, bool, list, record, expr, tagged,

  // type guards & introspection
  KINDS, isKind, float64ToNumber,

  // canonical encoding & I/O
  canonicalize, parse, encodeString,

  // hashing
  hash, hashCanonicalBytes,

  // validation
  validateValue,

  // schema helpers (ADR-0002)
  SCHEMA_KIND_TAG, kindOf, asSchemaKind,

  // error class
  ToolError, ProtocolError,

  // value types (for fn signatures and pattern-match exhaustiveness)
  type Value, type Kind, type Hash,
  type SymbolValue, type StringValue, type IntegerValue, type RationalValue,
  type Float64Value, type BooleanValue, type ListValue, type RecordValue,
  type ExpressionValue, type TaggedValue,
} from "@workbench/protocol";
```

## The ten kinds

`symbol`, `string`, `integer`, `rational`, `float64`, `boolean`, `list`,
`record`, `expression`, `tagged`. Exhaustive: every `Value` has a discrete
`kind` field that pins to one of these. New domains add `tagged` variants
over the existing ten, never new primitives. See main README §"The value
protocol" for shape detail and PRD §2 for design rationale.

## Constructing values

Always prefer the constructors over raw `{ kind: "...", ... }` literals:

```ts
int(7n)                     // {kind: "integer", value: "7"}
str("hello")                // {kind: "string", value: "hello"}
list([int(1n), int(2n)])    // {kind: "list", items: [...]}
record({ x: int(1n), y: int(2n) })
expr("+", [sym("x"), int(1n)])
tagged("foo/bar", int(0n))
```

Why: the helpers normalise (rationals to lowest terms, integers to
canonical decimal), enforce required fields at compile time, and make
intent visible at the call site. Raw literals are reserved for protocol
internals (canonicalize, parse, validate).

The container constructors — `list`, `record`, `tagged` — are *generic
in their contents*: they preserve the structural type of what you pass
rather than widening to `ListValue` / `RecordValue` / `TaggedValue`. So
`tagged("foo/bar", int(0n))` has type `{kind:"tagged"; tag:string;
payload: IntegerValue}`, and a helper that builds tagged values keeps
that narrow payload type through to its callers — no `as never` cast at
the call site. The narrowed types are still assignable to the wide
variants (covariant subtypes), so existing `Value`-typed code is
unaffected. The schema constructors mirror this: `S.tagged(tag,
S.kind("integer"))` is a `Schema<TaggedValueOf<IntegerValue>>`, so
`ValueOf<…>` threads the payload type through (ADR-0004; bead x0lc).

## Schema annotations (ADR-0002)

When declaring a tool's `schema.input` / `schema.output`, prefer
`kindOf(k)` over arbitrary sample-values when the *kind* is the
load-bearing fact:

```ts
schema: {
  input: record({
    n:        kindOf("integer"),
    direction: kindOf("string"),
    x:        list([kindOf("integer")]),
  }),
  output: list([kindOf("integer")]),
}
```

A schema slot wrapped in `tagged "schema/kind"` is recognised by
registry consumers (notably `tools/registry-search`) and treated as
"any value of the named kind" for filtering purposes.

Sample-values still make sense when a *specific shape* is the
load-bearing fact — heads of expressions, named record fields,
constants:

```ts
schema: {
  input: record({ lhs: expr("<arithmetic>", []), rhs: expr("<arithmetic>", []) }),
  output: record({ equal: bool(true), reason: str("optional") }),
}
```

The two styles compose freely.

## Canonical encoding

`canonicalize(v: Value): string` produces the workbench's strict-JSON
canonical form: keys sorted by UTF-16 code unit, no whitespace, no raw
JSON numbers (every numeric is a string inside `integer`/`rational` or hex
bits inside `float64`), forward slashes unescaped, `null` reserved.

`parse(s: string): Value` is the inverse, with full validation. Round-trip
property tested over 1000 random values.

`hash(v: Value): Hash` is `sha256(canonicalize(v))`, hex-encoded. Equal
canonical bytes ⟹ equal hash ⟹ equal value (modulo collision).

## See also

- main `README.md` for the value protocol table and the canonical-encoding
  rules.
- `PRD-v0.2.md` §2 for design rationale.
- `docs/adr/` for accepted decisions.
