# partial-trace

Trace out one or more subsystems of an operator on a tensor-product
Hilbert space.

## Input

```json
{
  "kind": "record",
  "fields": {
    "M":         <list<list<float64>>>,   // d × d operator, d = ∏ dims
    "dims":      <list<integer>>,         // subsystem dimensions
    "trace_out": <list<integer>>          // subsystem indices to trace out
  }
}
```

Subsystem indexing convention: `dims[0]` is the **leftmost** tensor factor.
For `dims = [2, 2, 2]` (three qubits), `trace_out = [1]` traces out the
middle qubit, leaving an operator on qubits 0 and 2 in the 4 × 4 reduced
space.

`trace_out` may be a single index in a list, or several. Multi-subsystem
trace is implemented as a fold of single-subsystem traces from high to low
index.

## Output

```json
{
  "kind": "record",
  "fields": {
    "reduced":      <list<list<float64>>>,   // d_kept × d_kept
    "reduced_dims": <list<integer>>,         // post-trace dim list
    "shape":        <list<integer>>,         // [d_kept, d_kept]
    "warnings":     <list<string>>           // currently always empty
  }
}
```

`d_kept = ∏_{k ∉ trace_out} dims[k]`.

`reduced_dims` is the dim list after tracing — useful for chaining further
partial-trace calls without re-deriving from `dims` and `trace_out`.

## Invariants

- **Trace preservation.** `tr(reduced) = tr(M)`.
- **Product state.** `partial-trace(A ⊗ B, dims=[d_A, d_B], trace_out=[1])`
  returns `tr(B) · A`. This is the defining property — the most decisive
  test for correctness.
- **Linearity.** `Tr_k(α M + β N) = α Tr_k(M) + β Tr_k(N)`.
- **Maximally mixed reduction.** The Bell state `|Φ+⟩⟨Φ+|` reduces to
  `I/2` on either subsystem (canonical entanglement signature).

## Refusals

- **Malformed input.** `dims` empty or containing non-positive entries;
  `M`'s shape doesn't match `∏ dims`; `trace_out` contains out-of-range
  indices; ragged / non-finite `M` entries → `ToolError`.

## Worked example: Bell-state reduction

```ts
import { typed, loadWorkbench } from "@workbench/compose";
const wb = typed(await loadWorkbench());

// |Φ+⟩⟨Φ+| as a 4×4 matrix.
const bell = [
  [0.5, 0,   0,   0.5],
  [0,   0,   0,   0  ],
  [0,   0,   0,   0  ],
  [0.5, 0,   0,   0.5],
];

const r = await wb.partialTrace({ M: bell, dims: [2, 2], trace_out: [1] });
// r.reduced === [[0.5, 0], [0, 0.5]]   — i.e. I/2, the maximally mixed state.
```

## See also

- `tensor-product` (the constructive side: `A ⊗ B`).
- `@workbench/qinfo` substrate package — `partialTrace` (general path),
  `partialTracePure` (pure-state SVD path, O(d · rank) for state vectors),
  and the index-only siblings `partialTranspose`, `vec`, `unvec`, `choi`,
  `deChoi` for direct in-process use via `@workbench/compose`.
- ADR-0034 for the qinfo design rationale (dims-generalisation, endianness,
  the reshape-and-sum algorithm, Hastings-style fast paths deferred to v0.3).
