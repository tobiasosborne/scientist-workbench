# 005 — F7: `@workbench/json-bridge` package

**Date:** 2026-04-28
**Status:** complete
**Issues:** scientist-workbench-rpb.6 (closed)

## Context

The 02-NTT port (shard 001) needed a translation layer between the
tournament's raw-JSON shape and sci-wb's canonical encoding:

- tournament: `{"n": 7, "direction": "forward", "modulus": "998244353",
  "x": ["1", "2", "3", "4", "5", "6", "7"]}` — JSON numbers, strings,
  array.
- canonical: an `IntegerValue` for each numeric, a `StringValue` for
  direction, a `ListValue` of `IntegerValue`s for `x`, all wrapped in a
  sorted-key `RecordValue`. All numerics are decimal-strings; no raw
  JSON numbers.

The first cut at `scripts/validate-tournament-ntt.ts` translated by
hand: ~30 lines of `int(BigInt(t.n))`-shaped code, with a parallel
chunk on the way out. Worked, but wouldn't compose: every benchmark
in the catalogue (FFT, LLL, Stoer-Wagner, blossom, Schreier-Sims,
Buchberger, PSLQ, Risch, Shewchuk, dtoa/strtod) will hit the same
need with different field names.

A reusable translator was the only sensible answer. The interesting
design question was *how the translator decides which JSON shape maps
to which canonical kind*: JSON `"7"` could be `integer` or `string`;
JSON `1.5` could be `float64` or `rational`. Guessing in a content-
addressed system is how you get hash drift.

## What changed

A new package — `packages/json-bridge` — with two operations:

```ts
jsonToCanonical(json: unknown, hint: Value): Value
canonicalToJson(value: Value, opts?: JsonBridgeOptions): unknown
```

The forward direction is **hint-driven**. Hints are themselves `Value`s
written with the schema-kind vocabulary from shard 004:

| Hint                          | Means                                            |
|-------------------------------|--------------------------------------------------|
| `kindOf("integer")`           | parse this JSON node as integer                  |
| `kindOf("rational")`          | parse as rational ({num,den}, "a/b", or integer) |
| `kindOf("float64")`           | parse as float64 (number or 16-hex-bits string)  |
| `kindOf("string")`            | string passes through                            |
| `kindOf("boolean")`           | boolean passes through                           |
| `kindOf("symbol")`            | string becomes the symbol name                   |
| `list([elementHint])`         | JSON array; recurse with elementHint per item    |
| `record({k: hint, ...})`      | JSON object; field-by-field; hint-keys required  |
| `tagged("foo", innerHint)`    | wrap parsed value with this tag                  |

JSON keys not mentioned in the hint are silently dropped (robust
adapters); hinted keys missing from the JSON are an error.

The reverse direction is unambiguous on the kind axis but tunable on
the encoding axis:

```ts
interface JsonBridgeOptions {
  integerEncoding?:  "smart" | "string" | "number"  // default smart
  rationalEncoding?: "fraction" | "slash"           // default fraction
  float64Encoding?:  "number" | "hex"               // default number
}
```

`"smart"` integer encoding picks JSON number when `|v| < 2^53`, JSON
string otherwise — losslessly. `"string"` always strings (matches the
tournament's residue convention). `"number"` always numbers (throws on
overflow).

Records emit with keys sorted alphabetically (matching canonical
encoding). Expressions and tagged values emit a structural form
(`{kind, head, args}` or `{kind, tag, payload}`) so downstream
consumers can reconstruct.

`scripts/validate-tournament-ntt.ts` was refactored to use the bridge:
a hint declaration plus two function calls replaced the ~30 lines of
hand-rolled translation. 64/64 tournament cases still pass.

## Why these choices

**Hint-driven forward, encoding-tunable reverse.** Asymmetric on
purpose. Forward is ambiguous (JSON has fewer types than the protocol;
"7" could be either), so we demand a hint. Reverse is unambiguous on
the kind axis but the *target wire format* is ambiguous (an integer
emitted as a JSON number or a JSON string is the same value), so we
take an option.

**Hints are `Value`s, not a separate hint type.** Reusing `kindOf` and
the structural value forms (`list`, `record`) means a reader who knows
the protocol already knows the hint vocabulary. Same helpers, same
canonicalisation, same parse/canonicalize contract.

**Strict on missing hinted keys, lax on extras.** The asymmetry matches
how external corpora drift: tournament JSON might add metadata fields
in a future revision (those should be silently dropped — robust); but
if a hinted field isn't there, the canonical translation can't
proceed (so we fail loudly). A future strict-mode flag could flip the
extras behaviour, but we err on the side of robust adapters by default.

**Decimal-string rationals not auto-supported.** `"1.25"` is
ambiguous: is it `float64` or `rational(5n, 4n)`? The bridge accepts
fraction-objects or `"a/b"` for rational input. Decimal strings are
a future enhancement gated by an explicit `decimalAsRational` flag, if
it ever becomes load-bearing.

## Frictions surfaced

Mostly small ergonomic ones:

1. The `JsonBridgeError` carries a dotted path (`$.x.3`). Implementing
   it required threading `path` through every recursive call. A
   future refactor might use a thrown-and-decorated approach to avoid
   the parameter wart, but the current form is debuggable.

2. The reverse direction emits expressions as a structural
   `{kind:"expression", head, args}` JSON record because expressions
   have no natural raw-JSON form. This is honest but means
   round-tripping an expression-bearing value through `canonicalToJson`
   then `jsonToCanonical` requires a hint that says "this is a
   structural expression form" — which we don't currently provide.
   Acceptable: expressions belong to `expr-parse`'s string surface,
   not to JSON-shaped external data.

## Acceptance

- 32 unit tests covering every kind, both directions, round-trip,
  error paths.
- Mutation-proven: flipping `int(BigInt(json))` to add `+ 1n` causes
  6 tests to fail. The tests are load-bearing.
- `scripts/validate-tournament-ntt.ts` refactored: ~30 lines of
  hand-rolled translation collapse to a hint declaration plus two
  calls. 64/64 tournament cases still pass exactly.
- `bun run check` (14 phases) green.

## Pointers

- `packages/json-bridge/src/index.ts` — literate package source.
- `packages/json-bridge/README.md` — agent-facing summary with the
  full hint table and the tournament example worked through.
- `scripts/validate-tournament-ntt.ts` — the canonical adapter
  pattern; copy this shape for future ports.
- ADR-0002 — `kindOf` is the underlying convention this package leans
  on; the bridge is a second consumer of the same vocabulary.
