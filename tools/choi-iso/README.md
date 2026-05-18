# choi-iso

Convert between the two equivalent matrix representations of a quantum
channel `Φ : M_{d_in} → M_{d_out}`: the **superoperator matrix** `S`
(of size `d_out² × d_in²`, satisfying `vec(Φ(ρ)) = S · vec(ρ)`) and the
**Choi matrix** `J(Φ)` (of size `(d_in·d_out) × (d_in·d_out)`).

Reach for this tool when you have built a channel in one form and need
to test a property naturally expressed in the other:

- *I built Φ from Kraus operators (so `S = Σ_α K̄_α ⊗ K_α`) and now I
  want to check that it is completely positive* → convert to `J`, test
  `J ⪰ 0`.
- *I built Φ as a Choi state (or received one from a tomography routine)
  and now I want to apply it to a density matrix* → convert to `S`, then
  apply as `vec(Φ(ρ)) = S · vec(ρ)`.

## Input

Discriminated union — the input is a `tagged` value whose tag picks the
direction:

```jsonc
// Forward: superoperator → Choi
{
  "kind": "tagged",
  "tag":  "channel-to-choi",
  "payload": {
    "kind": "record",
    "fields": {
      "channel": <list<list<float64>>>,   // d_out² × d_in²  superoperator matrix
      "dim_in":  <integer>,               // input  Hilbert-space dim
      "dim_out": <integer>                // output Hilbert-space dim
    }
  }
}
```

```jsonc
// Inverse: Choi → superoperator
{
  "kind": "tagged",
  "tag":  "choi-to-channel",
  "payload": {
    "kind": "record",
    "fields": {
      "J":       <list<list<float64>>>,   // (d_in·d_out) × (d_in·d_out)
      "dim_in":  <integer>,
      "dim_out": <integer>
    }
  }
}
```

## Output

Discriminated by the input direction; the matrix-bearing field is named
after what it *is*:

```jsonc
// Forward output
{
  "kind": "record",
  "fields": {
    "J":        <list<list<float64>>>,   // (d_in·d_out)²
    "shape":    <list<integer>>,         // [d_in·d_out, d_in·d_out]
    "warnings": <list<string>>           // currently always empty
  }
}
```

```jsonc
// Inverse output
{
  "kind": "record",
  "fields": {
    "channel":  <list<list<float64>>>,   // d_out² × d_in²
    "shape":    <list<integer>>,
    "warnings": <list<string>>
  }
}
```

## How

The Choi–Jamiołkowski isomorphism is

```
J(Φ) := Σ_{i,j} |i⟩⟨j|_in ⊗ Φ(|i⟩⟨j|)_out.
```

With `Φ` represented as a superoperator matrix `S` in column-stacking vec
(`vec(M)[i + m·j] = M[i, j]`), the index map between `S` and `J` is a
pure permutation of entries:

```
J[i_in·d_out + i_out, j_in·d_out + j_out]
    =  S[i_out + d_out·j_out, i_in + d_in·j_in].
```

This matches Watrous (*Theory of Quantum Information* §2.2), QuTiP's
`to_choi`, Qiskit's `Choi` class, and Wood–Biamonte–Cory
(`arXiv:1111.6950`, Eq. 3.22, the "column convention"). Mixing
column-stacking with row-stacking gives a SWAP-equivalent Choi and is
the single most common bug class in this corner of the literature —
ADR-0034 locks the convention substrate-wide.

The tool itself is a thin wrapper: schema, dim/shape guard, then
`@workbench/qinfo`'s `choi` / `deChoi`. The Matrix is allocated in
`Float64Array` storage; for `dim_in = dim_out = d`, both `S` and `J`
are `d² × d²`, so a single Choi conversion touches `d⁴` float64s.

## Invariants

- **Round-trip.** `deChoi(choi(S, d_in, d_out), d_in, d_out) = S`,
  bit-identical (index permutation only).
- **Identity-channel Choi.** `J(id_d) = |Ω⟩⟨Ω|` where
  `|Ω⟩ = Σ_i |ii⟩` is the unnormalised maximally entangled state —
  rank-1 PSD with `tr(J) = d`.
- **Linearity.** `choi(α·S + β·T) = α·choi(S) + β·choi(T)`.
- **Shape.** Forward: `d_out² × d_in²` → `(d_in·d_out) × (d_in·d_out)`.
  Inverse: vice versa.
- **Transpose map = SWAP.** `J(T)` where `T(ρ) = ρᵀ` equals the SWAP
  matrix; eigenvalues `{−1, 1, 1, 1}` make it the canonical
  positive-but-not-CP witness (Peres–Horodecki).
- **Rejects malformed.** Shape mismatch, non-positive dim, non-finite
  entries → `ToolError`, never a wrong-shaped success record.

## Refusals

All failures of this tool are *malformed input*, so they raise
`ToolError` (per ADR-0003 and the partial-trace precedent). There are
no tagged refusals — the Choi isomorphism is a pure index permutation,
defined for every well-shaped matrix; there is no "out of scope" branch
of the math.

## Worked example: complete-positivity test

```ts
import { typed, loadWorkbench } from "@workbench/compose";
import { tagged } from "@workbench/protocol";
const wb = typed(await loadWorkbench());

// The transpose map T(ρ) = ρᵀ on a qubit — column-stacking superop is SWAP_4.
const T_super = [
  [1, 0, 0, 0],
  [0, 0, 1, 0],
  [0, 1, 0, 0],
  [0, 0, 0, 1],
];

const r = await wb.choiIso(
  tagged("channel-to-choi", {
    channel: T_super,
    dim_in:  2,
    dim_out: 2,
  }),
);
// r.J is SWAP_4 itself — feeding it to linalg-eigh returns eigenvalues
// {-1, 1, 1, 1}.  The single negative eigenvalue proves T is not CP.
```

## See also

- `partial-trace` — `Tr_2(J(Φ)) = I_{d_in}` is the trace-preservation test.
- `partial-transpose` — `(T ⊗ id)(J(Φ))` plus eigenvalue check is the
  PPT entanglement witness.
- `tensor-product` — used to compose channels as `J(Φ ⊗ Ψ) = J(Φ) ⊗ J(Ψ)`
  up to permutation of the qubit ordering.
- `@workbench/qinfo` substrate package — `choi`, `deChoi`, `vec`, `unvec`,
  and the matrix substrate (`Matrix`, `fromNested`, `toNested`).
- ADR-0034 for the design rationale and convention rationale (column-
  stacking lock, input-on-left ordering).

## Run

```sh
echo '{"kind":"tagged","tag":"channel-to-choi","payload":{"kind":"record","fields":{"channel":...,"dim_in":...,"dim_out":...}}}' \
  | bun tools/choi-iso/tool.ts
```

## Standard flags

`--schema --examples --invariants --version --help --provenance-of <hash> --test --platform-fingerprint`
