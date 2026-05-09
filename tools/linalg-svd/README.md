# linalg-svd

Singular value decomposition `A = U · diag(S) · Vᵀ` for a real `m × n`
matrix.  Fourth numerical-tier tool (after `linalg-solve` ADR-0014,
`integrate-1d` ADR-0015 follow-on, and `linalg-qr` worklog 043).
**Dual-algorithm dispatch** (worklog 046): one-sided Jacobi
(Demmel-Veselić 1992) for `max(m, n) ≤ 500`, Golub-Reinsch (Householder
bidiagonalisation + Demmel-Kahan implicit-shift QR; Demmel & Kahan 1990)
above. Returns *not just* `(U, S, Vᵀ)` but a record carrying the
reconstruction error `‖U·diag(S)·Vᵀ − A‖_F / max(‖A‖_F, 1)`, both
orthogonality errors `‖UᵀU − I‖_F` and `‖Vt·Vtᵀ − I‖_F`, the condition
number `S[0]/S[k-1]`, the numerical rank, and the `method` field that
names the backend that ran — everything an agent's planner needs to
decide whether to trust the factorisation, treat the matrix as
rank-deficient, or escalate the precision warning.

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
The dispatch threshold (`max(m, n) ≤ 500`) routes between two
backends: one-sided Jacobi scales as `O(n³ log² n)` and is
interactive to ~n=500 (~18 s); Golub-Reinsch scales as `O(n³)` and
extends the practical ceiling to ~n=2000 (~5 min on dev-box; ~25 s
at n=1000 vs Jacobi's ~3.5 min — the dispatch headline).

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
    "method":                  {"kind": "string", "value": "one-sided-jacobi" | "golub-reinsch"},
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
- `mode` is not `"reduced"` or `"complete"`
- a true allocation OOM (`RangeError` on `Float64Array` allocation) —
  caught and re-thrown as `ToolError` carrying attempted-bytes detail
  (ADR-0016; the only refusal class for oversize inputs).

## How

Two backends, dispatched by problem size at the substrate (worklog
046; `packages/linalg-core/src/svd.ts`):

- **One-sided Jacobi** (Demmel-Veselić 1992; Drmač 1997; Golub & Van
  Loan §8.5).  Diagonalises `AᵀA` *implicitly* by orthogonal column
  rotations of `A`: for each column pair `(p, q)`, compute the Jacobi
  rotation that diagonalises the 2×2 block of `AᵀA`, then apply it
  from the right to both `A` and the accumulated `V`.  After
  convergence, the columns of `A · V` are orthogonal with norms equal
  to the singular values; left singular vectors come from normalising
  those columns.  High relative accuracy on every singular value
  *independent of `κ(A)`* (Demmel-Veselić 1992 — the discriminator
  vs Golub-Reinsch on the smallest singular values).  Cost
  `O(mn² log² n)`.

- **Golub-Reinsch** (Golub & Kahan 1965, Demmel & Kahan 1990, Golub &
  Van Loan §8.6).  Two stages:
  1. Householder bidiagonalisation `A = U₁ · B · V₁ᵀ` where `B` is
     real upper-bidiagonal. Alternates left and right reflectors that
     zero successive sub-diagonal columns and super-super-diagonal
     rows.
  2. Demmel-Kahan implicit-shift QR sweeps on `B`: chase a "bulge"
     introduced by the Wilkinson shift down the bidiagonal via
     alternating right and left Givens rotations until each `β[i]`
     deflates. Update `U₁` and `V₁` in place.
  Compose `U = U₁ · U₂`, `V = V₁ · V₂`, fix signs (negative σ ↦
  flip column of V), sort by σ descending.  Cost `O(mn² + n³)` with
  small constants.

The dispatch threshold sits at `max(m, n) = 500`: below it, Jacobi's
small-σ accuracy advantage dominates; above it, Golub-Reinsch's ~5–10×
speed advantage dominates and the n³ scaling becomes the binding
constraint.  The choice is configurable via the `--method` flag
(`"auto"` is the default; `"one-sided-jacobi"` and `"golub-reinsch"`
force a backend), and the `method` output field always names the
backend that ran.  Both backends:

- handle `m < n` by transposing internally and swapping `U ↔ V` at
  the end (the algorithms want at least as many rows as columns);
- sort singular values descending after extraction;
- complete rank-deficient (zero-σ) columns via Gram-Schmidt against
  the already-extracted unit vectors; complete-mode extends `U` and
  `Vᵀ` by Gram-Schmidt against the existing orthonormal partial
  bases.

References: Demmel & Veselić, *SIAM J. Matrix Anal. Appl.* 13(4),
1992; Drmač, *SIAM J. Sci. Comput.* 18(4), 1997; Demmel & Kahan,
*SIAM J. Sci. Stat. Comput.* 11(5), 1990; Golub & Kahan, *J. SIAM
Numer. Anal. Ser. B* 2(2), 1965; Golub & Van Loan, *Matrix
Computations*, 4th ed., JHU 2013, §§8.5–8.6; Higham, *Accuracy and
Stability of Numerical Algorithms*, 2nd ed., SIAM 2002, §20.3.

Out of scope: generalised SVD, randomised SVD, truncated SVD (bead
71f); FFI to LAPACK DGESDD (bead `e7y`); cross-platform determinism
guarantee (`numerical: true`, ADR-0015).

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
- **scale-warnings-emitted**: `max(m, n) > 500` populates the
  `warnings` field with measurement-driven advisories (estimated
  wall-clock + memory footprint per ADR-0016); the algorithm still
  runs.
- **oom-becomes-toolerror**: a true allocation OOM is caught and
  re-thrown as `ToolError` carrying attempted-byte count.
- **non-rectangular-rejected**: ragged `A` raises `ToolError`.

## Validation

`bench/linalg-svd/` — 55-case golden battery, 440 invariant assertions
(8 checks per case):

1. `no_tool_error` — clean exit.
2. `shape` — output record has all expected fields.
3. `U_orthonormal` — `‖UᵀU − I_k‖_F ≤ tol_orth` (Higham 2002 §20.3).
4. `Vt_orthonormal` — `‖Vt·Vtᵀ − I_k‖_F ≤ tol_orth`.
5. `S_non_negative_descending` — all `S[i] ≥ 0` and
   `S[i] ≥ S[i+1]` within tolerance `100·ε·S[0]`.
6. `reconstruction` — `‖U·diag(S)·Vᵀ − A‖_F / max(‖A‖_F, 1) ≤ tol_recon`
   (Higham 2002 §20.3 with 100× safety).
7. `self_reported_honesty` — all three reported errors agree with
   recomputation to `1e-6` relative.
8. `warnings_present_for_large_n` — `max(m, n) > 500` cases have
   non-empty `warnings` field (ADR-0016).

Tier breakdown mirrors `linalg-qr`; additionally, Jacobi vs
Golub-Reinsch dispatch is verified: the `method` field must be
`"one-sided-jacobi"` for `n ≤ 500` and `"golub-reinsch"` for `n > 500`
(or the explicit force via `--method`).

**5 NIST harwell-boeing structural matrices** (`bench/_corpus/harwell-
boeing/`): same bcsstk01–05 corpus as `linalg-qr`; all 5 symmetric
positive-definite (consistent with `eigh` stress cases).

**Stress cases:** n=500 (~17.6s Jacobi; dispatches to Golub-Reinsch
in the uncapped regime) added post-ADR-0016.

**Mutation-proven** per CLAUDE.md Rule 6.

## Run

```sh
echo '{"kind":"record","fields":{"A":...,"mode":{"kind":"string","value":"reduced"}}}' \
  | bun tools/linalg-svd/tool.ts
```

Method flag (typed, ADR-0011): `--method={auto,one-sided-jacobi,golub-reinsch}`
(default `auto`; auto dispatches by `max(m, n)` against the 500
threshold; the explicit values force a backend for tests/benchmarks).

## Standard flags

`--schema --examples --invariants --version --help --provenance-of <hash> --test --platform-fingerprint`
