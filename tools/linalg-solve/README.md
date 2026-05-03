# linalg-solve

Solve `A x = b` for a square dense float64 matrix. The first
numerical-tier tool in scientist-workbench (ADR-0014). Returns *not
just* `x` but a record carrying the residual, the 1-norm condition
estimate, the LU growth factor, and a list of human-readable warnings —
everything an agent's planner needs to decide whether to trust the
answer or try a different approach.

Library surface (TS-side, no JSON):

```ts
import { matrixFromRows, solve } from "@workbench/linalg-core";
const A = matrixFromRows([[2, 1], [1, 3]]);
const b = new Float64Array([4, 5]);
const r = solve(A, b)!;
// r.x ≈ [1.4, 1.2], r.residualNorm ≈ 0, r.conditionEstimate ≈ 3.2
```

## Input

```jsonc
{
  "kind": "record",
  "fields": {
    "A": {"kind": "list", "items": [
      {"kind": "list", "items": [{"kind": "float64", "bits": "..."}, ...]},
      ...
    ]},
    "b": {"kind": "list", "items": [{"kind": "float64", "bits": "..."}, ...]}
  }
}
```

A is `n × n` (must be square), b is length `n`. Each `float64` carries
the 16-hex-char IEEE-754 binary64 bit pattern (PRD §0.1). v0.1 caps `n`
at 200; larger inputs are rejected with a pointer to the blob-by-hash
follow-up bead.

## Output

Two shapes (ADR-0003 categories):

**Happy path — record:**

```jsonc
{
  "kind": "record",
  "fields": {
    "x": {"kind": "list", "items": [...]},
    "residual_norm":      {"kind": "float64", ...},  // ||A x - b||_2
    "b_norm":             {"kind": "float64", ...},  // ||b||_2
    "condition_estimate": {"kind": "float64", ...},  // κ_1(A) — Hager
    "growth_factor":      {"kind": "float64", ...},  // pivot growth
    "method":             {"kind": "string", "value": "lu-partial-pivot"},
    "iterations":         {"kind": "integer", "value": "0" | "1"},
    "warnings":           {"kind": "list", "items": [<strings>]}
  }
}
```

Warnings are populated when:
- `growth_factor > 1e6` — LU may be backward-unstable;
- `condition_estimate > 1e10` — problem is ill-posed;
- `residual_norm / b_norm > 1e-8` — solution may be inaccurate.

**Boundary failure — tagged:**

```jsonc
{
  "kind": "tagged",
  "tag": "linalg-solve/singular",
  "payload": {"kind": "record", "fields": {"pivot_row": {"kind": "integer", "value": "<row>"}}}
}
```

Returned when a pivot is exactly zero. The agent's planner can match
on the tag and decide what to do (e.g. fall back to least-squares once
that tool exists — bead 71f).

**Malformed input — `ToolError` (exit 1):**

- A non-square (with dimensions reported)
- `rows(A) ≠ length(b)`
- any non-finite (NaN / ±Inf) entry in A or b (path-into-tree reported)
- `n > 200` (suggestion points to bead `wmm`)
- `n = 0` (empty matrix)

## How

LU with partial pivoting, in-place packed L+U storage, optional
single-step iterative refinement, Hager 1-norm condition estimator.
All algorithms in pure TypeScript on `Float64Array` (no FFI). See
`packages/linalg-core/src/{matrix,lu,hager,solve}.ts` for the literate
algorithmic prose.

References: Higham, *Accuracy and Stability of Numerical Algorithms*,
2nd ed. (Chapter 9; Algorithm 14.4); Trefethen & Bau, *Numerical
Linear Algebra* (Lectures 20–22).

Out of scope (v0.1): other decompositions (QR, SVD, eigenvalues, bead
71f), iterative methods, sparse matrices, complex arithmetic, n > 200
(bead `wmm`), FFI BLAS path (bead `e7y`), cross-platform determinism
guarantee (ADR-0015 / bead `0ck`).

## Invariants

- **deterministic**: same input bytes → same output bytes
  (single-platform — ADR-0015 will tier this).
- **round-trip-residual**: for every successful solve,
  `||A x - b||_2 ≤ residual_norm + machine epsilon`.
- **non-square-rejected, dim-mismatch-rejected, non-finite-rejected,
  size-cap-rejected**: malformed input fails loud (`ToolError`).
- **singular-tagged**: exactly singular A produces
  `tagged "linalg-solve/singular"`, never a silently wrong `x`.

## Run

```sh
echo '{"kind":"record","fields":{"A":...,"b":...}}' | bun tools/linalg-solve/tool.ts
```

Method flag (typed, ADR-0011): `--method=lu` (currently the only
choice; the flag exists so v0.2's QR addition is non-breaking).

## Standard flags

`--schema --examples --invariants --version --help --provenance-of <hash> --test`
