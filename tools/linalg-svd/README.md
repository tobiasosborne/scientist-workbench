# linalg-svd

Singular value decomposition `A = U · diag(S) · Vᵀ` for a real `m × n`
matrix by one-sided Jacobi (Demmel-Veselić 1992).  Fourth numerical-tier
tool (after `linalg-solve` ADR-0014, `integrate-1d` ADR-0015 follow-on,
and `linalg-qr` worklog 043).  Returns *not just* `(U, S, Vᵀ)` but a
record carrying the reconstruction error `‖U·diag(S)·Vᵀ − A‖_F /
max(‖A‖_F, 1)`, both orthogonality errors `‖UᵀU − I‖_F` and
`‖Vt·Vtᵀ − I‖_F`, the condition number `S[0]/S[k-1]`, and the numerical
rank — everything an agent's planner needs to decide whether to trust the
factorisation, treat the matrix as rank-deficient, or escalate the
precision warning.

Library surface (TS-side, no JSON):

```ts
import { matrixFromRows, svd } from "@workbench/linalg-core";
const A = matrixFromRows([[1, 2, 3], [4, 5, 6], [7, 8, 10], [1, 0, 1], [0, 1, 0]]);
const r = svd(A, "reduced");
// r.U is 5×3 with orthonormal columns; r.Vt is 3×3 with orthonormal rows.
// r.S is [17.46, 1.19, 0.87]; r.rankEstimate = 3.
// r.reconstructionError ~ 2e-16; orthogonalityErrorU ~ 6e-16.
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
(PRD §0.1).  Per ADR-0016 there is **no hard size cap** — large
inputs run with scale-advisory warnings appended to the output's
`warnings` field; only a true allocation OOM raises a `ToolError`.
One-sided Jacobi scales as `O(n³ log² n)`: in pure TS, `n=500 ≈ 18 s`,
`n=1000 ≈ 3.5 min`. The Golub-Reinsch path (deferred to bead `71f`)
will lift the practical ceiling another ~1.5 orders of magnitude.

## Output

Three shapes (ADR-0003 categories):

**Happy path — record:**

```jsonc
{
  "kind": "record",
  "fields": {
    "U":                       {"kind": "list", "items": [...]},  // m × k (reduced) or m × m (complete)
    "S":                       {"kind": "list", "items": [...]},  // length k
    "Vt":                      {"kind": "list", "items": [...]},  // k × n (reduced) or n × n (complete)
    "mode":                    {"kind": "string", "value": "reduced" | "complete"},
    "reconstruction_error":    {"kind": "float64", ...},   // ||U·diag(S)·Vᵀ − A||_F / max(||A||_F, 1)
    "orthogonality_error_U":   {"kind": "float64", ...},   // ||UᵀU − I||_F
    "orthogonality_error_Vt":  {"kind": "float64", ...},   // ||Vt·Vtᵀ − I||_F
    "condition_number":        {"kind": "float64", ...},   // S[0] / max(S[k-1], EPS·S[0])
    "rank_estimate":           {"kind": "integer", ...},   // count of S_i > max(m,n)·EPS·S[0]
    "method":                  {"kind": "string", "value": "one-sided-jacobi"},
    "warnings":                {"kind": "list", "items": [<strings>]}
  }
}
```

For `mode = "reduced"`: `U` is `m × min(m, n)`, `S` has length `min(m, n)`,
`Vt` is `min(m, n) × n`.
For `mode = "complete"`: `U` is `m × m`, `S` has length `min(m, n)`,
`Vt` is `n × n`.  The extra `m − k` columns of `U` span the orthogonal
complement of `A`'s column space; the extra `n − k` rows of `Vt` span
`A`'s null space.

`reconstruction_error`, `orthogonality_error_U`, and
`orthogonality_error_Vt` are the candidate's *own self-report* on its
own quality.  The bench's verifier (`bench/linalg-svd/golden/verify.py`)
recomputes all three and rejects the candidate if the reported value
disagrees with the recomputation by more than `1e-6` relative —
agent-honest is *enforced*, not just convention.

`condition_number` is `S[0] / S[k-1]` when `S[k-1] > 0`, else
`S[0] / (EPS · S[0]) = 1/EPS ≈ 4.5e15`.  (Capped at `1/EPS` rather than
`Infinity` because finite numbers compose better.)

`rank_estimate` counts singular values exceeding the LAPACK-standard
relative threshold `max(m, n) · EPS · S[0]`.

Warnings are populated when:
- `reconstruction_error > 1e-12` — relative reconstruction is above
  the soft floor;
- `orthogonality_error_U > 1e-12` or `orthogonality_error_Vt > 1e-12` —
  one of the orthonormal factors is above the soft floor;
- `condition_number > 1e12` — `A` is near machine precision;
  downstream pseudo-inverse will amplify noise.

These are *fields*, not hard refusals — Jacobi is backward-stable
(`O(ε)` orthogonality, independent of `κ(A)`), and the bench's
tolerance has 100× safety on top of Higham 2002 §20.3 / Demmel-Veselić
1992.

**Boundary failures — tagged:**

```jsonc
{
  "kind": "tagged",
  "tag": "linalg-svd/non-finite-input",
  "payload": {"kind": "record", "fields": {
    "row":   {"kind": "integer", "value": "<i>"},
    "col":   {"kind": "integer", "value": "<j>"},
    "value": {"kind": "string", "value": "NaN" | "Infinity" | "-Infinity"}
  }}
}
```

Returned when `A` contains `NaN` or `±Inf`.  The agent's planner can
match on the tag, read the offending coordinate, and decide what to do
(e.g. clean the data and retry, or refuse to proceed).

```jsonc
{
  "kind": "tagged",
  "tag": "linalg-svd/degenerate-shape",
  "payload": {"kind": "record", "fields": {
    "m": {"kind": "integer", "value": "<m>"},
    "n": {"kind": "integer", "value": "<n>"}
  }}
}
```

Returned when `m = 0` or `n = 0`.  The algorithm has no answer to give
on a zero-by-anything input; tagging rather than throwing lets a
planner introspect the shape without an opaque exit-1.

**Malformed input — `ToolError` (exit 1):**

- `A` is not rectangular (rows of unequal length)
- `m · n > 200 · 200` (suggestion points to bead `wmm`)
- `mode` is not `"reduced"` or `"complete"`

## How

One-sided Jacobi (Demmel-Veselić 1992; Drmač 1997 for the per-pair
tolerance test; Golub & Van Loan §8.5).  Diagonalises `AᵀA` *implicitly*
by orthogonal column rotations of `A`: for each column pair `(p, q)`,
compute the Jacobi rotation that diagonalises the 2×2 block of `AᵀA`,
then apply it from the right to both `A` and the accumulated `V`.  After
convergence, the columns of `A · V` are orthogonal with norms equal to
the singular values; left singular vectors come from normalising those
columns.

**Why Jacobi, not Golub-Reinsch:** both are admissible by the bench's
tolerance regime.  Jacobi wins the implementation budget at the
small-to-mid scale this tool routinely sees:

- **Half the lines of code, no convergence-edge cases.**  Golub-Reinsch
  needs Householder bidiagonalisation, accumulation of `U₁` and `V₁`,
  Demmel-Kahan implicit-shift QR sweeps with shift selection,
  deflation, post-sort.  Each piece has subtle corner cases.
- **Superior accuracy on small singular values** (Demmel-Veselić 1992,
  Drmač 1997).  Bidiagonalisation followed by QR can lose half the
  digits on the smallest singular values when `A` has a wide range of
  column norms.
- **At small/mid n, the asymptotic speed gap doesn't matter.**  Jacobi is
  `O(mn² · log n)` per sweep with `O(log n)` sweeps; Golub-Reinsch is
  `O(mn² + n³)`. Up to `n ≈ 500` the constant factors dominate; beyond
  that, ADR-0016's scale warnings start firing and the planner can
  decide whether to wait or escalate to FFI (bead `e7y`). A future
  Golub-Reinsch port (bead `71f` follow-up) will lift the practical
  ceiling further without giving up Jacobi for ill-conditioned cases.

The algorithm wants the worked-on matrix at least as tall as it is
wide, so for `m < n` we transpose internally and swap `U ↔ V` at the
end.  Singular values are sorted descending after extraction; rank-
deficient (zero-norm) columns of the worked matrix are completed via
modified Gram-Schmidt against the already-extracted unit vectors.
Complete-mode extends `U` and `Vᵀ` by Gram-Schmidt against the
existing orthonormal partial bases.

References: Demmel & Veselić, *SIAM J. Matrix Anal. Appl.* 13(4),
1992; Drmač, *SIAM J. Sci. Comput.* 18(4), 1997; Golub & Van Loan,
*Matrix Computations*, 4th ed., JHU 2013, §8.5; Higham, *Accuracy and
Stability of Numerical Algorithms*, 2nd ed., SIAM 2002, §20.3.

Out of scope (v0.1, all explicitly deferred): generalised SVD,
randomised SVD, truncated SVD (bead 71f); `m·n > 200·200` (bead `wmm`);
FFI to LAPACK DGESDD (bead `e7y`); cross-platform determinism guarantee
(`numerical: true`, ADR-0015).

## Invariants

- **deterministic-per-platform**: same input bytes → same output bytes
  on a single platform; `numerical: true` (ADR-0015) records the
  platform fingerprint in provenance.
- **reconstruction**: `‖U · diag(S) · Vᵀ − A‖_F ≤ 100·ε·max(m,n)·√min(m,n)·‖A‖_F`
  (Higham 2002 §20.3 with 100× safety).
- **orthogonality-U / orthogonality-Vt**: both `‖UᵀU − I‖_F` and
  `‖Vt·Vtᵀ − I‖_F` are `≤ 100·ε·max(m,n)·√q` — independent of `κ(A)`
  (the Jacobi advertisement; Demmel-Veselić 1992).
- **S-non-negative-descending**: `S[i] ≥ 0` for all `i`, and `S[i] ≥
  S[i+1]` for `i < k−1` (within tolerance `100·ε·S[0]`).
- **self-reported-honesty**: reported `reconstruction_error`,
  `orthogonality_error_U`, and `orthogonality_error_Vt` agree with the
  verifier's recomputation to `1e-6` relative.
- **rank-estimate-LAPACK-threshold**: `rank_estimate` counts singular
  values exceeding `max(m,n)·ε·S[0]`.
- **non-finite-tagged**: any `NaN` or `±Inf` in `A` produces
  `tagged "linalg-svd/non-finite-input"` with the offending coordinate.
- **degenerate-shape-tagged**: `m = 0` or `n = 0` produces
  `tagged "linalg-svd/degenerate-shape"` with `(m, n)`.
- **size-cap-rejected**: `m·n > 40000` raises `ToolError` pointing at
  bead `wmm` (the v0.2 follow-up).
- **non-rectangular-rejected**: ragged `A` raises `ToolError`.

## Run

```sh
echo '{"kind":"record","fields":{"A":...,"mode":{"kind":"string","value":"reduced"}}}' \
  | bun tools/linalg-svd/tool.ts
```

Method flag (typed, ADR-0011): `--method=one-sided-jacobi` (currently
the only choice; the flag exists so v0.2 can add `golub-reinsch`
non-breakingly).

## Standard flags

`--schema --examples --invariants --version --help --provenance-of <hash> --test --platform-fingerprint`
