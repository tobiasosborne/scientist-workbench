# ntt

Number-Theoretic Transform over `F_p` with `p = 998244353` and primitive
root `g = 3`. Arbitrary length `n` with `n | (p − 1) = 2²³ · 7 · 17`.

```
forward:  X_k = Σ_j x_j · ω_n^(j·k)            (mod p)
inverse:  x_j = n⁻¹ · Σ_k X_k · ω_n^(−j·k)     (mod p)
```

with `ω_n = g^((p − 1)/n) mod p`.

## How

- **Power-of-two `n`** — iterative Cooley-Tukey, in-place, single
  bit-reversal up front, Montgomery REDC inner loop with `R = 2³²`.
- **Other `n`** — Bluestein chirp-z reduces to a length-`L` (next power of
  two `≥ 2n − 1`) circular convolution, evaluated by the same power-of-two
  NTT.

`v0.1` supports `modulus = 998244353` only (Montgomery constants are
frozen for this prime). Other moduli are rejected with a `ToolError` —
honest scope.

## Input

```jsonc
{
  "kind": "record",
  "fields": {
    "n":              {"kind": "integer", "value": "<decimal, ≥ 0, divides p−1>"},
    "modulus":        {"kind": "integer", "value": "998244353"},
    "primitive_root": {"kind": "integer", "value": "3"},
    "direction":      {"kind": "string",  "value": "forward" | "inverse"},
    "x":              {"kind": "list", "items": [<integer in [0, p)>, ...]}
  }
}
```

`|x|` must equal `n`. Each residue must lie in `[0, p)`.

## Output

```jsonc
{"kind": "list", "items": [<integer in [0, p)>, ...]}    // length n
```

## Invariants

- **deterministic** — same input bytes → same output bytes.
- **canonical-range** — every output residue lies in `[0, p)`.
- **round-trip** — `ntt(ntt(x, forward), inverse) = x` exactly (mod p).
- **agrees-with-schoolbook** — output equals the literal `O(n²)` DFT sum
  mod `p` (the `--test` hook checks this against an independent oracle).
- **linearity** — `ntt(α·x + β·y) ≡ α·ntt(x) + β·ntt(y) (mod p)`.
- **honest-scope** — `modulus ≠ 998244353` (or `primitive_root ≠ 3`) raises
  `ToolError`, never produces a wrong residue.

## Run

```sh
echo '{"kind":"record","fields":{"direction":{"kind":"string","value":"forward"},"modulus":{"kind":"integer","value":"998244353"},"n":{"kind":"integer","value":"4"},"primitive_root":{"kind":"integer","value":"3"},"x":{"kind":"list","items":[{"kind":"integer","value":"1"},{"kind":"integer","value":"0"},{"kind":"integer","value":"0"},{"kind":"integer","value":"0"}]}}}' \
  | bun tools/ntt/tool.ts
# → list of four "1"s
```

## Cross-validation

The `tstournament` benchmark ships 64 golden cases for the same
specification. `scripts/validate-tournament-ntt.ts` translates each case
into the canonical sci-wb encoding, pipes it through this tool, and
compares the residue lists to the tournament's `expected.json`.

## Standard flags

`--schema --examples --invariants --version --help --provenance-of <hash> --test`
