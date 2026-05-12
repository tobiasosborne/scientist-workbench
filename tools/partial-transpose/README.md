# partial-transpose

Transpose on selected subsystems of an operator on a tensor-product
Hilbert space — the operational primitive behind the Peres–Horodecki
entanglement-detection criterion.

## Input

```jsonc
{
  "kind": "record",
  "fields": {
    "M":           <list<list<float64>>>,   // d × d operator, d = ∏ dims
    "dims":        <list<integer>>,         // subsystem dimensions
    "transposeOn": <list<integer>>          // subsystem indices to transpose
  }
}
```

Subsystem indexing convention: `dims[0]` is the **leftmost** tensor
factor (matches `partial-trace` / `tensor-product` / the rest of qinfo).
For `dims = [2, 2]`, `transposeOn = [1]` transposes only the *second*
qubit. Order within `transposeOn` does not matter — the operation is a
coordinate-wise swap, not a sequence.

## Output

```jsonc
{
  "kind": "record",
  "fields": {
    "M_pt":     <list<list<float64>>>,   // same shape as M
    "shape":    <list<integer>>,         // [d, d]
    "warnings": <list<string>>           // currently always empty
  }
}
```

## How

Pure index permutation:

```
PT_S(M)[I, J]  =  M[I_S↔J_S, J_S↔I_S]
```

where for each subsystem index `s ∈ S`, the row's s-th component is
taken from the column's s-th component and vice versa. The substrate
`@workbench/qinfo`'s `partialTranspose` does the index arithmetic on
row-major `Float64Array` storage; this tool wraps it.

This is the most algorithmically trivial of the qinfo ops and the most
conceptually subtle. The cost is `O(d²)` index work with one
multiplication/modulo per subsystem per (I, J) pair; no spectral
decomposition, no arithmetic on entries.

## Invariants

- **Involution.** `PT_S(PT_S(M)) = M` for any `S` and any `M`. Applying
  the same partial transpose twice is the identity.
- **Whole-system PT = full transpose.** `PT_{0,…,n−1}(M) = Mᵀ`.
- **Empty set is identity.** `PT_∅(M) = M`.
- **Product state.** `PT_S(A ⊗ B)` on the B subsystem equals `A ⊗ Bᵀ`;
  the transpose-on-A case is symmetric.
- **Bell-state witness (Peres–Horodecki).** `PT` on one qubit of
  `|Φ+⟩⟨Φ+|` equals `(1/2) SWAP`, whose min eigenvalue is `−1/2`. That
  single negative number certifies entanglement. On `2×2` and `2×3`
  systems the PPT criterion is necessary *and* sufficient; on larger
  systems it is a one-sided witness (PPT-but-entangled "bound entangled"
  states exist on `3×3` and beyond, Horodecki³ 1998).
- **Shape preserving.** `M_pt` has the same shape as `M`.
- **Rejects malformed.** Shape mismatch, out-of-range or duplicate
  subsystem indices, non-finite entries → `ToolError`.

## Refusals

All failures of this tool are *malformed input*, so they raise
`ToolError` (per ADR-0003 and the partial-trace precedent). There are
no tagged refusals — the partial-transpose operation has no "out of
scope" branch of the math; it is defined for every well-shaped matrix,
and any rejection is a contract violation by the caller.

## Worked example: PPT entanglement witness

```ts
import { typed, loadWorkbench } from "@workbench/compose";
const wb = typed(await loadWorkbench());

// |Φ+⟩⟨Φ+| = (1/2)(|00⟩+|11⟩)(⟨00|+⟨11|).
const bell = [
  [0.5, 0,   0,   0.5],
  [0,   0,   0,   0  ],
  [0,   0,   0,   0  ],
  [0.5, 0,   0,   0.5],
];

const pt = await wb.partialTranspose({
  M:           bell,
  dims:        [2, 2],
  transposeOn: [1],
});
// pt.M_pt === (1/2)·SWAP_4 = [[0.5,0,0,0],[0,0,0.5,0],[0,0.5,0,0],[0,0,0,0.5]]

const eig = await wb.linalgEigh({ A: pt.M_pt });
// eig.eigenvalues includes -0.5 → |Φ+⟩ is entangled (Peres-Horodecki).
```

## See also

- `partial-trace` — sibling: trace out subsystems (rather than transpose).
- `choi-iso` — partial transpose on the *Choi* matrix is `(T ⊗ id)(J(Φ))`,
  the recipe by which the transpose map's not-CP-ness becomes visible
  via eigenvalues (see the catalog row for choi-iso for the
  end-to-end demo).
- `@workbench/qinfo` substrate package — `partialTranspose`,
  `partialTrace`, `kron`, `vec`, `unvec`, `choi`, `deChoi`.
- ADR-0034 §D6 — partial-transpose design rationale (pure index
  permutation, dims-generalisation, the Bell-state worked example).
- Peres, *PRL* 77, 1413 (1996) — the original criterion.
- Horodecki, Horodecki, Horodecki, *PLA* 223, 1 (1996) — necessity-and-
  sufficiency on `2×2` and `2×3`.

## Run

```sh
echo '{"kind":"record","fields":{"M":...,"dims":...,"transposeOn":...}}' \
  | bun tools/partial-transpose/tool.ts
```

## Standard flags

`--schema --examples --invariants --version --help --provenance-of <hash> --test --platform-fingerprint`
