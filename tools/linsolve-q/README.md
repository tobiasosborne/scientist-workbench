# `linsolve-q` — exact linear solving over ℚ

Solve `A · x = b` exactly when the coefficients live in ℚ. Every
operation runs in `bigint` arithmetic; the answer is bit-identical
cross-platform forever (default determinism tier, ADR-0015).

## Algorithm

**Bareiss fraction-free Gaussian elimination, one-step variant**
(Bareiss 1968, *Math. Comp.* 22(103) §II.A.2 Eq. 8). Local PDF:
`docs/ground-truth/linear/bareiss-1968-mathcomp.pdf`.

The integer-preserving claim — that intermediate values stay bounded
by Hadamard's bound on submatrix determinants — is what distinguishes
honest Bareiss from naive ℚ-Gaussian (which bit-blows exponentially).
The bench at `bench/linsolve-q/` verifies this via Tier-H stress cases
that report a `max intermediate bit length` budget the candidate must
respect.

## Schema

```ts
input:  record { A: list<list<integer | rational>>, b: list<integer | rational> }
output: record {
  vars: list<symbol>,                   // x_0, x_1, ..., x_{n-1}
  solutions: list<record {
    bindings: list<record { var: symbol, value: <integer | rational | expression> }>,
    branches: list<symbol>              // [] for unique; t_0..t_{free-1} for under-det
  }>,
  completeness: 'complete' | 'finite-rep-of-infinite',
  warnings: list<string>
}
| tagged "linsolve-q/inconsistent" with payload
  record { rank: integer, augmented_rank: integer, warnings: list<string> }
```

The output shape is **ADR-0017**'s solution-set form, adapted for
linear:

- `kind = unique`: 1 solution, n bindings each carrying a rational
  value, `branches: []`, `completeness: 'complete'`.
- `kind = under-determined`: 1 solution carrying n bindings whose
  values are arithmetic expressions in the free variables `t_i`,
  `branches` listing those `t_i`, `completeness: 'finite-rep-of-infinite'`.
- `kind = inconsistent`: tagged refusal, no `solutions`.

## Examples

### Unique

```sh
echo '{"kind":"record","fields":{"A":{"kind":"list","items":[{"kind":"list","items":[{"kind":"integer","value":"3"}]}]},"b":{"kind":"list","items":[{"kind":"integer","value":"6"}]}}}' \
  | bun tools/linsolve-q/tool.ts
```

→ `vars: [x_0]`, one solution with `bindings: [{x_0 → 2}]`,
   `completeness: 'complete'`.

### Under-determined

`x + 2y = 5` ⇒ x is determined by y. Output:

```jsonc
{
  "vars": ["x_0", "x_1"],
  "solutions": [{
    "bindings": [
      {"var": "x_0", "value": "5 + (-2)*t_0"},   // i.e. 5 − 2·t_0
      {"var": "x_1", "value": "t_0"}
    ],
    "branches": ["t_0"]
  }],
  "completeness": "finite-rep-of-infinite",
  "warnings": ["max intermediate bit length: ..."]
}
```

The affine value `5 + (-2)·t_0` is encoded as a workbench expression
`expr("+", [int(5), expr("*", [int(-2), sym("t_0")])])` — composes
cleanly with `cas-simplify` and the rest of the symbolic pipeline.

### Inconsistent

`1·x = 3, 2·x = 7` ⇒ no solution. Output is
`tagged "linsolve-q/inconsistent"` with payload
`{ rank: 1, augmented_rank: 2, warnings: [...] }`. The
augmented rank exceeding the matrix rank is the Rouché-Capelli
witness.

## Boundary cases

- **0×0** → unique, `x: []`, `rank: 0`, `completeness: 'complete'`.
- **m×0** with all-zero `b` → unique with `x: []`. With non-zero
  `b` → inconsistent.
- **Ragged `A`** → `ToolError` (malformed input, not a refusal).
- **`|b| ≠ rows(A)`** → `ToolError`.

## Determinism + integer-preserving

- **Determinism**: pure `bigint` arithmetic; same input bytes ⇒ same
  output bytes. Default determinism tier (no `numerical: true`).
- **Integer-preserving (the headline)**: every intermediate value is
  itself a determinant of an integer submatrix (Sylvester's identity
  §I of Bareiss); bit-length stays bounded by Hadamard. The
  `max intermediate bit length` warning reports the actual maximum
  observed; the bench reads this to detect implementations that
  secretly do naive ℚ-Gaussian.

## What this is NOT

- **Not numerical**. Use `linalg-solve` for `float64`; use this for
  exact arithmetic.
- **Not for ℝ-valued or symbolic-coefficient inputs**. Coefficients
  must be rational. Symbolic coefficients require a different
  algorithm (Cramer's rule on `RatFn<T>`) — defer to a future bead.
- **Not a least-squares solver**. Inconsistent ⇒ refusal, not
  best-fit.

## References

- **Bareiss 1968** "Sylvester's Identity and Multistep Integer-
  Preserving Gaussian Elimination", *Math. Comp.* 22(103). Local
  PDF + extended Argonne tech report under
  `docs/ground-truth/linear/`.
- **ADR-0017** solution-set value-protocol shape.
- **ADR-0019** solve bench discipline (this tool's bench complies).
- **`packages/cas-core/src/linsolve.ts`** — pure substrate.
- **`bench/linsolve-q/`** — 46-case 8-check golden master.
