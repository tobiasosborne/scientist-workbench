# linalg-qr

Householder QR factorisation `A = Q · R` for a real `m × n` matrix.
Third numerical-tier tool (after `linalg-solve` ADR-0014 and
`integrate-1d` ADR-0015 follow-on). Returns *not just* `(Q, R)` but a
record carrying the diagonal of `R` (rank diagnostic), the
reconstruction error `‖Q·R − A‖_F / max(‖A‖_F, 1)`, and the
orthogonality error `‖QᵀQ − I‖_F` — everything an agent's planner needs
to decide whether to trust the factorisation or treat the matrix as
rank-deficient.

Library surface (TS-side, no JSON):

```ts
import { matrixFromRows, qr } from "@workbench/linalg-core";
const A = matrixFromRows([[1, 2, 3], [4, 5, 6], [7, 8, 10], [1, 0, 1], [0, 1, 0]]);
const r = qr(A, "reduced");
// r.Q is 5×3 with orthonormal columns; r.R is 3×3 upper triangular.
// r.reconstructionError ~ 6.5e-16; r.orthogonalityError ~ 1.2e-15.
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
    "mode": {"kind": "string", "value": "reduced"}   // optional; default "reduced"
  }
}
```

`A` is `m × n` (must be rectangular), each row of equal length. `mode`
is optional: `"reduced"` (the LAPACK economy default) or `"complete"`.
Each `float64` carries the 16-hex-char IEEE-754 binary64 bit pattern
(PRD §0.1). v0.1 caps `m·n` at `200·200`; larger inputs are rejected
with a pointer to the blob-by-hash follow-up bead.

## Output

Three shapes (ADR-0003 categories):

**Happy path — record:**

```jsonc
{
  "kind": "record",
  "fields": {
    "Q":                    {"kind": "list", "items": [...]},  // m × k matrix
    "R":                    {"kind": "list", "items": [...]},  // k × n matrix
    "mode":                 {"kind": "string", "value": "reduced" | "complete"},
    "diagonal_R":           {"kind": "list", "items": [...]},  // diag(R), length min(m,n)
    "reconstruction_error": {"kind": "float64", ...},          // ||Q·R − A||_F / max(||A||_F, 1)
    "orthogonality_error":  {"kind": "float64", ...},          // ||QᵀQ − I||_F
    "method":               {"kind": "string", "value": "householder"},
    "warnings":             {"kind": "list", "items": [<strings>]}
  }
}
```

For `mode = "reduced"`: `Q` is `m × min(m, n)`, `R` is `min(m, n) × n`.
For `mode = "complete"`: `Q` is `m × m`, `R` is `m × n` (bottom `m − n`
rows of `R` are exactly zero when `m > n`).

`reconstruction_error` and `orthogonality_error` are the candidate's
*own self-report* on its own quality. The bench's verifier
(`bench/linalg-qr/golden/verify.py`) recomputes both and rejects the
candidate if the reported value disagrees with the recomputation by
more than `1e-6` relative — agent-honest is *enforced*, not just
convention.

Warnings are populated when:
- `reconstruction_error > 1e-12` — relative reconstruction is above
  the soft floor;
- `orthogonality_error > 1e-12` — Q's columns are above the soft
  orthogonality floor.

These are *fields*, not hard refusals — Householder is backward-stable
(`O(ε)` orthogonality, independent of `κ(A)`), and the bench's
tolerance has 100× safety on top of Higham 2002 Thm 19.4.

**Boundary failures — tagged:**

```jsonc
{
  "kind": "tagged",
  "tag": "linalg-qr/non-finite-input",
  "payload": {"kind": "record", "fields": {
    "row":   {"kind": "integer", "value": "<i>"},
    "col":   {"kind": "integer", "value": "<j>"},
    "value": {"kind": "string", "value": "NaN" | "Infinity" | "-Infinity"}
  }}
}
```

Returned when `A` contains `NaN` or `±Inf`. The agent's planner can
match on the tag, read the offending coordinate, and decide what to do
(e.g. clean the data and retry, or refuse to proceed).

```jsonc
{
  "kind": "tagged",
  "tag": "linalg-qr/degenerate-shape",
  "payload": {"kind": "record", "fields": {
    "m": {"kind": "integer", "value": "<m>"},
    "n": {"kind": "integer", "value": "<n>"}
  }}
}
```

Returned when `m = 0` or `n = 0`. The algorithm has no answer to give
on a zero-by-anything input; tagging rather than throwing lets a
planner introspect the shape without an opaque exit-1.

**Malformed input — `ToolError` (exit 1):**

- `A` is not rectangular (rows of unequal length)
- `m · n > 200 · 200` (suggestion points to bead `wmm`)
- `mode` is not `"reduced"` or `"complete"`

## How

Householder reflections (Golub & Van Loan, *Matrix Computations*, 4th
ed., §5.2.1). LAPACK DGEQRF storage: Householder vectors stored below
the diagonal of the work array, `τ` in a separate length-`k` vector,
`R` in the upper triangle. Backward accumulation of `Q` from right to
left to keep the running orthogonality at machine epsilon (Golub &
Van Loan §5.1.6).

**Why Householder, not Gram-Schmidt:** Householder gives
`‖QᵀQ − I‖_F = O(ε)` *independent of* `κ(A)`. Modified Gram-Schmidt
gives `O(κ · ε)` — fails on Hilbert-8 (`κ ≈ 1.5e10` ⇒ orth error
`≈ 3e-6`). Classical Gram-Schmidt gives `O(κ² · ε)` — fails already
on Hilbert-6. The bench's `Q_orthonormal` check pins
`tol_orth = 100 · ε · m · √k` independent of `κ`, which is exactly
the promise Householder makes.

References: Wilkinson, *The Algebraic Eigenvalue Problem*, OUP 1965;
Higham, *Accuracy and Stability of Numerical Algorithms*, 2nd ed.,
SIAM 2002, Thm 19.4 (backward stability of Householder QR); Golub &
Van Loan, *Matrix Computations*, 4th ed., JHU 2013, §§5.1–5.2.

Out of scope (v0.1, all explicitly deferred): pivoting QR (column-
pivoted, rank-revealing, bead 71f); SVD / eigendecomposition (bead
71f); `m·n > 200·200` (bead `wmm`); FFI to LAPACK DGEQRF (bead `e7y`);
cross-platform determinism guarantee (`numerical: true`, ADR-0015).

## Invariants

- **deterministic-per-platform**: same input bytes → same output bytes
  on a single platform; `numerical: true` (ADR-0015) records the
  platform fingerprint in provenance.
- **reconstruction**: `‖Q·R − A‖_F ≤ 100·ε·max(m,n)·√min(m,n)·‖A‖_F`
  (Higham 2002 Thm 19.4 with 100× safety).
- **orthogonality**: `‖QᵀQ − I_k‖_F ≤ 100·ε·m·√k` — independent of
  `κ(A)`. The Householder discriminator.
- **R-upper-triangular**: `R[i,j] = 0` for `i > j` within the
  `min(m,n)` block; for `mode=complete` with `m > n`, the bottom
  `(m-n)` rows of `R` are exactly zero.
- **self-reported-honesty**: reported `reconstruction_error` and
  `orthogonality_error` agree with the verifier's recomputation to
  `1e-6` relative — no quietly inflated numbers.
- **non-finite-tagged**: any `NaN` or `±Inf` in `A` produces
  `tagged "linalg-qr/non-finite-input"` with the offending coordinate
  — never silently propagated through the algorithm.
- **degenerate-shape-tagged**: `m = 0` or `n = 0` produces
  `tagged "linalg-qr/degenerate-shape"` with `(m, n)` — never an
  unhelpful exit-1.
- **size-cap-rejected**: `m·n > 40000` raises `ToolError` pointing
  at bead `wmm` (the v0.2 follow-up).
- **non-rectangular-rejected**: ragged `A` raises `ToolError`.

## Run

```sh
echo '{"kind":"record","fields":{"A":...,"mode":{"kind":"string","value":"reduced"}}}' \
  | bun tools/linalg-qr/tool.ts
```

Method flag (typed, ADR-0011): `--method=householder` (currently the
only choice; the flag exists so v0.2 can add `givens` or
`blocked-householder` non-breakingly).

## Standard flags

`--schema --examples --invariants --version --help --provenance-of <hash> --test --platform-fingerprint`
