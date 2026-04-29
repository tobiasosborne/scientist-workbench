# entropy-source

The workbench's privileged nondeterministic primitive. Reads `n_bytes` of
OS-randomness via Web Crypto `getRandomValues` and returns a hex-encoded
byte string plus a label naming the source.

This is the **only** tool in v0.2 that legitimately fails the strict-
determinism contract. Every other tool that consumes randomness — quantum
sampling, future Monte-Carlo, hardware bridges — takes its bytes as a typed
`entropy: string` field on its input record and stays deterministic given
those bytes. `entropy-source` is the bridge from "the world's randomness"
to "a value in the canonical protocol," and concentrates the contract
relaxation in one auditable place.

The tool's manifest carries `nondeterministic: true`, which propagates
into the provenance record so a consumer reading `--provenance-of <hash>`
can tell that this output is a single observed sample, not a value
re-derivable from inputs alone.

See [`docs/adr/0005-externalised-entropy.md`](../../docs/adr/0005-externalised-entropy.md)
for the design rationale.

## Input

```jsonc
{"kind":"record","fields":{"n_bytes":{"kind":"integer","value":"32"}}}
```

`n_bytes` must be in `[1, 1_048_576]`.

## Output

```jsonc
{
  "kind": "record",
  "fields": {
    "bytes":       {"kind": "string", "value": "<2 * n_bytes lowercase hex chars>"},
    "source_kind": {"kind": "string", "value": "os-urandom"}
  }
}
```

`bytes` is lowercase hex (no `0x` prefix), exactly `2 * n_bytes` characters.
`source_kind` is the literal `"os-urandom"`; the schema admits a
literal-string union so future hardware-RNG sources can extend the
vocabulary additively without breaking existing consumers.

## How

Calls `crypto.getRandomValues(new Uint8Array(n_bytes))`, chunked in 65 536-
byte blocks (the Web Crypto per-call ceiling). Each byte is encoded as
two lowercase hex digits via `.toString(16).padStart(2, "0")`. O(n).

## Invariants

- **byte-count** — `output.bytes.length == 2 * input.n_bytes`.
- **hex-format** — `output.bytes` matches `/^[0-9a-f]*$/`.
- **source-kind-pinned** — `output.source_kind == "os-urandom"`.
- **nondeterministic-by-design** — two invocations with the same input
  produce different output bytes with probability `1 - 2^(-8 * n_bytes)`.
  The only tool in v0.2 with this property.
- **rejects-zero / rejects-over-cap** — out-of-range `n_bytes` raises
  `ToolError` with a remediation `suggestion`.

## Goldens

Goldens are intentionally empty. Byte-equal goldens are nonsensical for a
tool whose output varies by definition; the `--test` hook is the load-
bearing verification surface and asserts every shape invariant
(byte-count, hex, source-kind, nondeterminism) by spawning the tool
twice and comparing the outputs structurally rather than literally.
The empty `goldens/` directory is honoured by `bun run check`'s oracle
phase, which simply skips tools with no `*.golden.json` files. See
`goldens.spec.ts` for the prose rationale.

## Run

```sh
echo '{"kind":"record","fields":{"n_bytes":{"kind":"integer","value":"32"}}}' \
  | bun tools/entropy-source/tool.ts
```

## Standard flags

`--schema --examples --invariants --version --help --provenance-of <hash> --test`
