# The value protocol & invocation

> **Tier 3 reference.** This is the operational reference an agent reads
> on demand — after the Tier-0 `README.md` bootstrap, after the Tier-1
> `bun wb.ts` tool index, alongside the Tier-2 `bun wb.ts <tool>` schema.
> Reach it from the discovery CLI: `bun wb.ts protocol`. The design
> rationale is canonical in `PRD-v0.2.md`; this file is the operational
> projection of it.

---

## The value protocol

Ten primitive kinds, exhaustive over the `kind` discriminator. A tool that
pattern-matches `value.kind` covers every case.

| kind | shape |
|---|---|
| `symbol` | `{kind, name, namespace?}` |
| `string` | `{kind, value}` |
| `integer` | `{kind, value: <decimal-string>}` |
| `rational` | `{kind, num: <decimal-string>, den: <decimal-string>}` (lowest terms, den > 0) |
| `float64` | `{kind, bits: <16 lowercase hex chars, big-endian IEEE-754>}` |
| `boolean` | `{kind, value: bool}` |
| `list` | `{kind, items: Value[]}` |
| `record` | `{kind, fields: {string → Value}}` |
| `expression` | `{kind, head, args: Value[]}` |
| `tagged` | `{kind, tag, payload: Value}` |

**Canonical encoding.** Strict JSON subset:

- Object keys sorted by UTF-16 code units.
- No whitespace anywhere.
- **No raw JSON numbers.** All numerics live inside `integer` / `rational` /
  `float64` whose number-bearing fields are *strings*. `{"value":1}` is
  invalid; write `{"value":"1"}`.
- Forward slash is never escaped (`/`, never `\/`).
- `null` is reserved and unused.

Spec & implementation: `packages/protocol/src/canonical.ts`. Round-trip
property tested over 1000 random values.

**Content addressing.** `hash(value) = sha256(canonicalize(value))`,
hex-encoded (64 chars). Equal canonical bytes ⟹ equal hash ⟹ equal value
(modulo collision).

**Foreign-pass-through invariant.** Tools touch only the kinds they declare.
Subterms outside a tool's scope must round-trip verbatim, either passed
through or wrapped in a `tagged` value with the tool's name in the tag
(e.g. `tagged "cas-simplify/out-of-scope"`). PRD §2.3.

**Complex matrices on the wire** (ADR-0035). The canonical wire shape for a
complex matrix — input or output of any `linalg-*-complex` tool — is
`record{re: list<list<float64>>, im: list<list<float64>>}` with both fields
**required** and shape-matched. A Hermitian matrix with known-zero imaginary
part still passes `im: [[0, …], …]` explicitly. Per-cell complex
(`list<list<record{re, im}>>`) is rejected: bulk numerics travel as
single-kind `list<…>` leaves, not nested records. The optional-`im`
`Matrix` shape used inside `@workbench/qinfo` for its index-only operations
(`tensor-product`, `partial-trace`, `partial-transpose`, `choi-iso`) is a
*substrate* convention; the *wire* requires both parts.

---

## Tool invocation

Every tool follows the same shape:

```sh
echo '<canonical-json-input>' | bun tools/<name>/tool.ts [--flag=value ...]
```

Pipe linearly to compose:

```sh
echo '{"kind":"string","value":"(x+1)*(x-1)"}' \
  | bun tools/expr-parse/tool.ts \
  | bun tools/cas-simplify/tool.ts
# → x^2 + (-1)
```

Errors go to stderr with non-zero exit. The `ToolError` shape carries a
`suggestion` line where applicable.

---

## Standard flags (every tool)

| flag | emits |
|---|---|
| `--schema` | `{input, output}` representative shapes |
| `--examples` | list of `{description, input, output? \| error?, flags?}` records |
| `--invariants` | list of `{name, statement, machine_checkable?}` records |
| `--version` | `{name, version}` record |
| `--provenance-of <hash>` | derivation tree for that output hash, or `tagged "provenance/not-found"` |
| `--test` | run in-process property tests; exits 0 pass, 1 fail, 2 no hook |
| `--help`, `-h` | human-readable usage |

Tool-specific flags follow `--key=value` or `--key value`. Tools declare
their flags via the `F.*` constructors (`F.bool`, `F.str`, `F.int`,
`F.enum`) on the `flags` field of `defineTool`; the runner parses argv
against the merged standard + tool flag schema with **strict declared
arity** (ADR-0011). A boolean switch followed by a positional leaves the
positional unconsumed; a value-flag without an inline `=` consumes exactly
the next argv token regardless of shape (so `--shots -2` works as expected).
Unknown flags, unexpected positionals, or out-of-range int values reject
loudly with a suggestion. `F.int` accepts underscore-grouped literals
(`--shots=10_000`). Run any tool with `--help` to see the auto-rendered
flag table.

The discovery CLI `bun wb.ts <tool>` pretty-prints a tool's `--schema`,
`--examples`, and `--invariants` without you having to assemble the raw
invocation.

---

## The schema language

Tools declare their input/output **shapes**, not example values. The schema
language (ADR-0004) is structural recursion over a small set of
constructors:

```ts
import { S } from "@workbench/protocol";

const inputSchema = S.record({
  base: S.kind("integer"),
  exponent: S.kind("integer"),
  modulus: S.kind("integer"),
});

const outputSchema = S.kind("integer");
```

Available constructors: `S.any()`, `S.kind(k)`, `S.literal(v)`, `S.list(e)`,
`S.tuple([...])`, `S.record({...}, {optional?})`, `S.expression(head?,
args?)`, `S.tagged(tag?, payload)`, `S.union([...])`. Records are closed by
default — extras throw. Optional fields are declared in the second
argument.

Two consequences any tool author should expect:

- The runner validates input against `schema.input` *before* `fn` runs, and
  output against `schema.output` after. A tool author no longer hand-rolls
  `expectIntegerField` or `parseFooInput` shims; the runner narrows the
  input to the schema's TypeScript type and the body trusts it. Output
  non-conformance is an internal contract violation and fails loudly.
- Examples must conform to the declared schema. The runner checks this at
  tool-load time, so drift between the schema and the canonical examples
  surfaces immediately.

Schemas are pure data and round-trip through the value protocol: `--schema`
emits canonical bytes a registry consumer can decode (`decodeSchema`)
without spawning the tool. Top-level kind queries, deep-mention queries, and
expression-head queries are first-class via `schemaTopKind`,
`schemaMentionsKind`, and `schemaExpressionHead`.

Three deliberate omissions: no recursive schemas, no predicate refinements,
no open records. ADR-0004 is the canonical reference for the design and the
rationale.

---

## Discoverability

Plan a composition by *type*, not by name (PRD §6.3). The discovery CLI
wraps this:

```sh
# what consumes a string?
bun wb.ts search --consumes string

# what produces a record?
bun wb.ts search --produces record
```

`wb search` is a thin wrapper over the `registry-search` tool. The raw
tool surface is still available:

```sh
echo '{"kind":"record","fields":{"input_kind":{"kind":"string","value":"string"}}}' \
  | bun tools/registry-search/tool.ts
```

Filters: `input_kind`, `output_kind`, `head` (matches the top-level head of
`schema.output`), `name_substring`. All AND-conjoined. The current schema is
a representative example value, so kind-filtering matches both the top level
and any sub-value of the schema.

---

## Provenance

Every successful tool run writes a record indexed by output hash:

```
$CAS_STORE/provenance/<hh>/<output_hash>.json
```

where `<hh>` = first two hex chars of the output hash. Default store:
`$HOME/.scientist-workbench/cas-store`. Override with `CAS_STORE=<path>`.

The record shape (PRD §3.2):

```json
{
  "tool":        {"name": "...", "version": "..."},
  "inputs":      [{"name": "stdin", "hash": "..."}],
  "flags":       {"key": "value", ...},
  "output_hash": "..."
}
```

Look up a derivation through any tool's `--provenance-of`:

```sh
bun tools/cas-verify/tool.ts --provenance-of <output-hash>
```

Re-execute by piping the same input bytes back through the same tool
version. Determinism is contractually required ⟹ same output bytes ⟹ same
output hash ⟹ same provenance record.
