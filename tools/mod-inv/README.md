# mod-inv

Modular inverse: the unique `r ∈ [0, modulus)` with `value · r ≡ 1 (mod modulus)`,
when one exists. Computed via the extended Euclidean algorithm — no
primality assumption on the modulus.

**v0.2** migrated to the record-with-flag output shape per ADR-0003. Older
consumers that expected `tagged "mod-inv/no-inverse"` on the no-inverse
branch must update.

## Input

```jsonc
{
  "kind": "record",
  "fields": {
    "value":   {"kind": "integer", "value": "<decimal>"},
    "modulus": {"kind": "integer", "value": "<decimal, ≥ 2>"}
  }
}
```

Negative `value` is reduced to canonical residue before inversion.

## Output

Always a record:

```jsonc
{
  "kind": "record",
  "fields": {
    "invertible": {"kind": "boolean", "value": <true|false>},
    "inverse":    {"kind": "integer", "value": "<r>"},   // iff invertible=true
    "gcd":        {"kind": "integer", "value": "<g>"}    // always; = 1 iff invertible=true
  }
}
```

`invertible: true` ⇒ `inverse ∈ [0, modulus)` and `gcd = 1`.
`invertible: false` ⇒ `gcd > 1` and the `inverse` field is absent.

## Errors

`ToolError` (exit 1) for malformed inputs:
- input not a record
- missing `value` or `modulus`
- `value` or `modulus` not an integer
- `modulus < 1`

Routine outcomes (gcd > 1, value reducing to 0, etc.) are not errors —
they produce the record above with `invertible: false`.

## Invariants

- **deterministic** — same input bytes → same output bytes.
- **left-inverse** — if `invertible=true`, `(value · inverse) mod modulus = 1`.
- **canonical-range** — if `invertible=true`, `inverse ∈ [0, modulus)`.
- **no-inverse-witness** — if `invertible=false`, `gcd > 1` and `inverse`
  is absent.
- **category-2-shape** — output is the record-with-flag of ADR-0003 in
  every case; never an `int` directly.
- **rejects-malformed-input** — `ToolError`, not a wrong record.

## Run

```sh
echo '{"kind":"record","fields":{"value":{"kind":"integer","value":"3"},"modulus":{"kind":"integer","value":"7"}}}' \
  | bun tools/mod-inv/tool.ts
# → {"fields":{"gcd":{"kind":"integer","value":"1"},"inverse":{"kind":"integer","value":"5"},"invertible":{"kind":"boolean","value":true}},"kind":"record"}

echo '{"kind":"record","fields":{"value":{"kind":"integer","value":"6"},"modulus":{"kind":"integer","value":"9"}}}' \
  | bun tools/mod-inv/tool.ts
# → {"fields":{"gcd":{"kind":"integer","value":"3"},"invertible":{"kind":"boolean","value":false}},"kind":"record"}
```

## See also

- `docs/adr/0003-tool-output-error-patterns.md` for the record-with-flag
  decision.

## Standard flags

`--schema --examples --invariants --version --help --provenance-of <hash> --test`
