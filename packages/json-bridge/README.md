# @workbench/json-bridge

Translate between raw JSON (the world outside the workbench) and canonical
`Value` (the world inside).

External JSON-shaped data — benchmark goldens, upstream APIs, configuration
files, the entire tstournament corpus — uses JSON numbers, JSON arrays, and
key orders that the canonical encoding does not. This package owns the
translation in one place so every downstream port is a hint declaration
plus a function call, not a hand-rolled adapter.

## Public surface

```ts
import {
  jsonToCanonical, canonicalToJson,
  type JsonBridgeOptions, JsonBridgeError,
} from "@workbench/json-bridge";
```

### Forward: raw JSON → canonical Value

`jsonToCanonical(json, hint)` walks the JSON guided by a *hint tree*. Hints
are themselves `Value`s, written with the same vocabulary as tool schemas:

| Hint                          | Means                                            |
|-------------------------------|--------------------------------------------------|
| `kindOf("integer")`           | parse the JSON node as an integer                |
| `kindOf("rational")`          | parse as rational ({num,den}, "a/b", or integer) |
| `kindOf("float64")`           | parse as float64 (number or 16-hex-bits string)  |
| `kindOf("string")`            | string passes through                            |
| `kindOf("boolean")`           | boolean passes through                           |
| `kindOf("symbol")`            | string becomes the symbol name                   |
| `list([elementHint])`         | JSON array; recurse with elementHint per item    |
| `record({k: hint, ...})`      | JSON object; field-by-field, hint-keys required  |
| `tagged("foo", innerHint)`    | wrap the parsed value with this tag              |

JSON keys not mentioned in the hint are silently dropped. Hinted keys
missing from the JSON are an error.

The forward direction is hint-driven by design: JSON `"7"` could be an
integer or a string; JSON `1.5` could be a float64 or a rational. We do
not guess — guessing in a content-addressed system is how you get hash
drift.

### Reverse: canonical Value → raw JSON

`canonicalToJson(value, opts?)` is unambiguous on the kind axis but
tunable on the encoding axis:

```ts
interface JsonBridgeOptions {
  integerEncoding?:  "smart"     // number when |v| < 2^53, else string  (default)
                  |  "string"    // always JSON string
                  |  "number";   // always JSON number; throws on overflow
  rationalEncoding?: "fraction"  // {"num":"<n>","den":"<d>"}             (default)
                  |  "slash";    // "<n>/<d>"
  float64Encoding?:  "number"    // JSON number, lossy past round-trip    (default)
                  |  "hex";      // 16-hex-char bits string, lossless
}
```

Records emit with keys sorted alphabetically (matching canonical encoding).
Expressions and tagged values emit a structural form (`{kind, head, args}`
or `{kind, tag, payload}`) so downstream consumers can reconstruct.

## The tournament example

```ts
import { kindOf, list, record } from "@workbench/protocol";
import { jsonToCanonical, canonicalToJson } from "@workbench/json-bridge";

const NTT_INPUT_HINT = record({
  direction:      kindOf("string"),
  modulus:        kindOf("integer"),
  n:              kindOf("integer"),
  primitive_root: kindOf("integer"),
  x:              list([kindOf("integer")]),
});

// raw tournament JSON → canonical
const canonical = jsonToCanonical(tournamentInput, NTT_INPUT_HINT);

// canonical → tournament-shaped JSON (every integer as a string,
// matching their convention)
const back = canonicalToJson(canonical, { integerEncoding: "string" });
```

This is exactly what `scripts/validate-tournament-ntt.ts` does: read raw
JSON, hint-translate, run the canonical-encoded value through the
`tools/ntt/tool.ts` subprocess, parse the canonical-encoded output, and
compare residue lists.

## Errors

`JsonBridgeError` carries a dotted path (`$`, `$.foo`, `$.x.3`) pointing
at the offending JSON position. Callers should surface the message and
path together so a 27,000-line goldens file with one bad case is
debuggable.

## See also

- ADR-0002 (`docs/adr/0002-schema-kind-annotations.md`) for the `kindOf`
  convention this package leans on.
- main README §"The value protocol" for the canonical encoding.
