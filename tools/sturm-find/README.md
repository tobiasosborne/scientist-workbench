# sturm-find

Grover's search algorithm packaged as a workbench tool. Given an
`n_bits` register width and a list of marked classical values, builds
the Grover circuit via `@workbench/sturm-lib`, runs it through
`sturm-execute` for the analytic Born distribution, and (when
`shots > 0`) draws samples through `sturm-sample`.

The tool itself is a thin wrapper — every interesting decision lives
in the underlying packages. It exists so the algorithm is reachable
from the standard pipe-tool interface.

## Input

```jsonc
{
  "kind": "record",
  "fields": {
    "n_bits": { "kind": "integer", "value": "3" },
    "marked": { "kind": "list", "items": [
      { "kind": "integer", "value": "5" }
    ]},
    "shots":   { "kind": "integer", "value": "100" },     // optional
    "entropy": { "kind": "string",  "value": "<hex>" }    // required if shots > 0
  }
}
```

- `n_bits ∈ [1, 3]` — the v0.1 cap. `mcz` (the multi-controlled Z used
  in the diffusion and oracle) currently supports n ∈ {1, 2, 3}; n ≥ 4
  needs an ancilla cascade with full CCNOTs (deferred).
- `marked` — distinct integers in `[0, 2^n_bits)`. Non-empty.
- `shots`, `entropy` — opt-in sampling. 8 hex bytes per shot.

## Output

```jsonc
{
  "kind": "record",
  "fields": {
    "distribution": <sturm-execute analytic distribution>,
    "samples":      <sturm-sample result, only when shots > 0>,
    "iterations":   { "kind": "integer", "value": "..." }
  }
}
```

Out-of-scope inputs (n_bits > 3, empty marked, marked entry out of
range, shots > 0 with no entropy) raise a `ToolError` with
`suggestion`, exit code 1.

## How

`optimalIters(N, M) = ⌊π/4 · √(N/M)⌋` (Brassard et al. 2002, Theorem 3).
The library `find` builds a `Channel<[], []>` that:
1. allocates `n_bits` qubits in `|0⟩^n`,
2. applies `H⊗n`,
3. for each iteration: phase-flip the marked subset, then diffuse
   `(H⊗n · X⊗n · MCZ · X⊗n · H⊗n)`,
4. observes every bit, LSB-first — refs `r0..r(n-1)`.

Predicted Grover behavior:

| n_bits | M  | iterations | P(marked) closed form           |
|--------|----|------------|--------------------------------|
| 2      | 1  | 1          | sin²(3 · π/6) = 1.0             |
| 3      | 1  | 2          | sin²(5 · arcsin(1/√8)) ≈ 0.9453  |
| 3      | 2  | 1          | sin²(3 · arcsin(√(2/8))) ≈ 0.78  |
| 3      | 4  | 1          | sin²(3 · arcsin(√(4/8))) = 0.5   |

## Invariants

- **deterministic** — same input bytes → same output bytes (symbolic
  tier, ADR-0015 — bit-identical cross-platform forever, given fixed
  entropy input).
- **probabilities-sum-to-one** — distribution `prob` sums to 1 within 1e-9.
- **marked-state-amplified** — n=2 single-marked → P(marked) = 1.
- **optimal-iterations** — uses Brassard et al. 2002 Theorem 3.
- **honest-scope-bounds** — n_bits ∈ [1, 3]; marked non-empty distinct.

## Run

```sh
# Find 5 in a 3-bit search space (analytic distribution only).
echo '{"kind":"record","fields":{"n_bits":{"kind":"integer","value":"3"},"marked":{"kind":"list","items":[{"kind":"integer","value":"5"}]}}}' \
  | bun tools/sturm-find/tool.ts

# With sampling (need entropy from entropy-source first).
echo '{"kind":"record","fields":{"n_bytes":{"kind":"integer","value":"800"}}}' \
  | bun tools/entropy-source/tool.ts \
  | tee /tmp/ent.json
```

## Standard flags

`--schema --examples --invariants --version --help --provenance-of <hash> --test`
