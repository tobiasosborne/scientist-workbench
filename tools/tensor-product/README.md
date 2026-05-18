# tensor-product

Kronecker product `A ⊗ B` of two real matrices.

## Input

```json
{
  "kind": "record",
  "fields": {
    "A": <list<list<float64>>>,
    "B": <list<list<float64>>>
  }
}
```

`A` is `m_A × n_A`, `B` is `m_B × n_B`. Both must be non-empty and
rectangular (uniform row length). Non-finite entries (NaN, Infinity)
are rejected as malformed input.

## Output

```json
{
  "kind": "record",
  "fields": {
    "AB": <list<list<float64>>>,       // shape (m_A·m_B, n_A·n_B)
    "shape": <list<integer>>,          // [rows, cols] for ergonomic dispatch
    "warnings": <list<string>>         // currently always empty; reserved
  }
}
```

Element (i, j) of `AB` is `A[⌊i / m_B⌋, ⌊j / n_B⌋] · B[i mod m_B, j mod n_B]`.
Equivalently: `AB` viewed as a block matrix has `(i_A, j_A)`-block
= `A[i_A, j_A] · B`.

## Invariants

- **Shape.** `AB.shape = (m_A · m_B, n_A · n_B)`.
- **Mixed-product law.** `(A ⊗ B)(C ⊗ D) = (A·C) ⊗ (B·D)` whenever the
  matrix products on the right are defined. This is the most decisive
  test — an off-by-permutation kron implementation fails here immediately.
- **Identity.** `I_m ⊗ I_n = I_{m·n}`.
- **Trace.** `tr(A ⊗ B) = tr(A) · tr(B)` (for square A, B).

## Refusals

- **Malformed input.** Empty rows, ragged rows (inconsistent col counts),
  non-finite entries → `ToolError` with `suggestion` describing which
  field and which index. ADR-0003: malformed inputs raise `ToolError`,
  not `tagged`.

## See also

- `partial-trace` (the inverse-ish operation on a tensor-product space).
- `@workbench/qinfo` substrate package — `kron`, `kron2`, plus the
  index-only siblings `partialTrace`, `partialTranspose`, `vec`, `unvec`,
  `choi`, `deChoi` for direct in-process use via `@workbench/compose`.
- ADR-0034 for the qinfo design rationale (storage convention, dims-
  generalisation, complex-from-day-1 on index-only ops, endianness).
