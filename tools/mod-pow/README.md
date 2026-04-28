# mod-pow

Modular exponentiation: `base^exponent mod modulus`. Square-and-multiply on
bigint, no Montgomery overhead — appropriate for the general-purpose case.
For NTT-internal modular work see the `ntt` tool, which uses a fast
Montgomery path frozen for its supported prime.

## Input

```jsonc
{
  "kind": "record",
  "fields": {
    "base":     {"kind": "integer", "value": "<decimal>"},
    "exponent": {"kind": "integer", "value": "<decimal, ≥ 0>"},
    "modulus":  {"kind": "integer", "value": "<decimal, ≥ 1>"}
  }
}
```

Negative bases are reduced to canonical residue before exponentiation.

## Output

`{"kind":"integer","value":"<r>"}` with `0 ≤ r < modulus`.

## Errors

- `exponent < 0` — rejected with suggestion to use `mod-inv` first.
- `modulus < 1` — rejected.

## Invariants

- **deterministic** — same input bytes → same output bytes.
- **canonical-range** — output ∈ `[0, modulus)`.
- **agrees-with-iterated-mul** — for small exponents, equals iterated
  multiplication; the `--test` hook verifies this.
- **fermat-for-prime-modulus** — `modPow(a, p−1, p) = 1` when `p` is prime
  and `gcd(a, p) = 1`.

## Run

```sh
echo '{"kind":"record","fields":{"base":{"kind":"integer","value":"2"},"exponent":{"kind":"integer","value":"10"},"modulus":{"kind":"integer","value":"1000"}}}' \
  | bun tools/mod-pow/tool.ts
# → {"kind":"integer","value":"24"}
```

## Standard flags

`--schema --examples --invariants --version --help --provenance-of <hash> --test`
