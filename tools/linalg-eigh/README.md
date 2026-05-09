# linalg-eigh

Symmetric eigendecomposition `A = Q · diag(λ) · Qᵀ` for a real `n × n`
*symmetric* matrix by cyclic Jacobi rotations (Jacobi 1846; Golub & Van
Loan §8.4).  Fifth numerical-tier tool (after `linalg-solve` ADR-0014,
`integrate-1d` ADR-0015 follow-on, `linalg-qr` worklog 043, `linalg-svd`
worklog 044).  Returns *not just* `(Q, λ)` but a record carrying the
reconstruction error `‖A·Q − Q·diag(λ)‖_F / max(‖A‖_F, 1)`, the
orthogonality error `‖QᵀQ − I‖_F`, and the spectral condition number
`|λ_max| / |λ_min|` — everything an agent's planner needs to decide
whether to trust the factorisation, treat A as nearly singular, or
escalate the precision warning.

Library surface (TS-side, no JSON):

```ts
import { matrixFromRows, eigh } from "@workbench/linalg-core";
const A = matrixFromRows([[2, 1], [1, 2]]);
const r = eigh(A);
// r.eigenvalues = [1, 3]
// r.Q is 2×2 with orthonormal columns
// r.reconstructionError ~ 2e-16; r.orthogonalityError ~ 0
```

## Input

```jsonc
{
  "kind": "record",
  "fields": {
    "A": {"kind": "list", "items": [
      {"kind": "list", "items": [{"kind": "float64", "bits": "..."}, ...]},
      ...
    ]}
  }
}
```

`A` is `n × n` (must be square) and *symmetric within tolerance*
(`max|A − Aᵀ| ≤ 100·EPS·max|A|` mirrors the bench's `_is_symmetric`).
Each `float64` carries the 16-hex-char IEEE-754 binary64 bit pattern
(PRD §0.1).  Per ADR-0016 there is **no hard size cap** — large inputs
run with scale-advisory warnings appended to the output's `warnings`
field; only a true allocation OOM raises a `ToolError`.  Cyclic Jacobi
scales as `O(n³ log² n)`: in pure TS, `n=200 ≈ 0.7 s`, `n=500 ≈ 7 s`,
`n=1000 ≈ minutes`.

## Output

Four shapes (ADR-0003 categories):

**Happy path — record:**

```jsonc
{
  "kind": "record",
  "fields": {
    "Q":                      {"kind": "list", "items": [...]},   // n × n orthogonal
    "eigenvalues":            {"kind": "list", "items": [...]},   // length n, ascending
    "reconstruction_error":   {"kind": "float64", ...},   // ||A·Q − Q·diag(λ)||_F / max(||A||_F, 1)
    "orthogonality_error":    {"kind": "float64", ...},   // ||QᵀQ − I||_F
    "condition_number":       {"kind": "float64", ...},   // |λ_max| / max(|λ_min|, EPS·|λ_max|)
    "method":                 {"kind": "string", "value": "jacobi"},
    "warnings":               {"kind": "list", "items": [<strings>]}
  }
}
```

`Q` is the `n × n` orthogonal matrix whose columns are the eigenvectors;
`eigenvalues` are real and sorted **ascending** (the numpy /
`scipy.linalg.eigh` convention).  Column `j` of `Q` is the eigenvector
corresponding to `eigenvalues[j]`.

`reconstruction_error` and `orthogonality_error` are the candidate's
*own self-report* on its own quality.  The bench's verifier
(`bench/linalg-eigh/golden/verify.py`) recomputes both and rejects the
candidate if the reported value disagrees with the recomputation by more
than `1e-6` relative — agent-honest is *enforced*, not just convention.

`condition_number` is `|λ_max| / |λ_min|` when `|λ_min| > 0`, else
clamped to `1/EPS ≈ 4.5e15` to keep the field finite (downstream
consumers compose more cleanly with finite numbers).  This differs from
a singular-value condition: for indefinite `A`, the smallest *magnitude*
eigenvalue determines conditioning of `A⁻¹`.

Warnings are populated when:
- `reconstruction_error > 1e-12` — relative reconstruction is above the
  soft floor;
- `orthogonality_error > 1e-12` — `Q` is above the soft floor;
- `condition_number > 1e12` — `A` is near machine precision;
  downstream `A⁻¹` will amplify noise;
- `n > 500` — scale advisory per ADR-0016 (`assessNumericalScale`).

These are *fields*, not hard refusals — Jacobi is backward-stable
(`O(ε)` orthogonality, independent of `κ(A)`), and the bench's
tolerance has 100× safety on top of Higham 2002 §20.6 / Wilkinson 1965.

**Boundary failures — tagged:**

```jsonc
{
  "kind": "tagged",
  "tag": "linalg-eigh/non-symmetric-input",
  "payload": {"kind": "record", "fields": {
    "row":            {"kind": "integer", "value": "<i>"},
    "col":            {"kind": "integer", "value": "<j>"},
    "value":          {"kind": "string",  "value": "<A[i,j] − A[j,i]>"},
    "max_asymmetry":  {"kind": "string",  "value": "<max|A − Aᵀ|>"}
  }}
}
```

Returned when `max|A − Aᵀ| > 100·EPS·max|A|`.  The agent's planner can
match on the tag, read the asymmetry magnitude, and decide whether to
symmetrise (`A := (A + Aᵀ) / 2`) and retry, or refuse to proceed.

```jsonc
{
  "kind": "tagged",
  "tag": "linalg-eigh/non-finite-input",
  "payload": {"kind": "record", "fields": {
    "row":   {"kind": "integer", "value": "<i>"},
    "col":   {"kind": "integer", "value": "<j>"},
    "value": {"kind": "string", "value": "NaN" | "Infinity" | "-Infinity"}
  }}
}
```

Returned when `A` contains `NaN` or `±Inf`.  The agent can match on the
tag, read the offending coordinate, and decide what to do (clean the
data and retry, or refuse to proceed).

```jsonc
{
  "kind": "tagged",
  "tag": "linalg-eigh/degenerate-shape",
  "payload": {"kind": "record", "fields": {
    "m": {"kind": "integer", "value": "<m>"},
    "n": {"kind": "integer", "value": "<n>"}
  }}
}
```

Returned when `n = 0`.  The algorithm has no answer to give on a
zero-by-zero input; tagging rather than throwing lets a planner
introspect the shape without an opaque exit-1.

**Malformed input — `ToolError` (exit 1):**

- `A` is non-square (`m ≠ n`) — suggestion points at `linalg-svd`
- `A` is non-rectangular (rows of unequal length)
- True allocation OOM (caught and re-thrown with attempted-bytes detail)

## How

Cyclic-by-rows Jacobi (Jacobi 1846; Forsythe-Henrici 1960 for the
cyclic-convergence proof; Golub & Van Loan §8.4 for the modern
algorithm; Demmel-Veselić 1992 for the high-relative-accuracy result).
A "sweep" walks every unordered pair `(p, q)` with `0 ≤ p < q < n`.
For each pair we compute the Jacobi rotation `(c, s)` that diagonalises
the `2 × 2` block `[D[p,p] D[p,q]; D[p,q] D[q,q]]` of the working
matrix `D`, then apply `Jᵀ D J` (similarity transform that preserves
eigenvalues) and accumulate `J` into `Q`.  After convergence (zero
rotations needed in a complete sweep), `D` is diagonal with the
eigenvalues on the diagonal and `Q`'s columns are the eigenvectors.
Eigenvalues are sorted ascending and `Q`'s columns are permuted to
match.

**Why Jacobi, not tridiag + QR (LAPACK DSYTRD + DSTEQR):** both are
admissible by the bench's tolerance regime.  Jacobi wins the
implementation budget at our scale:

- **Half the lines of code, no convergence-edge cases.**  Tridiag+QR
  needs Householder tridiagonalisation, then implicit-shift QR sweeps
  with Wilkinson shifts, deflation, post-sort.  Each piece has subtle
  corner cases.
- **Superior accuracy on small eigenvalues** (Demmel-Veselić 1992).
  Jacobi computes every eigenvalue to high relative accuracy regardless
  of `κ(A)`.
- **At small/mid n, the asymptotic speed gap doesn't matter.**  Jacobi
  is `O(n³ · log² n)`; tridiag+QR is `O(n³)`. Up to `n ≈ 500` the
  constant factors dominate; beyond that ADR-0016's scale warnings
  start firing and the planner can decide whether to wait or escalate
  to FFI (bead `e7y`). A future tridiag+QR port (bead `te-qr`) would
  lift the practical ceiling further without giving up Jacobi for
  ill-conditioned cases.

The substrate (`packages/linalg-core/src/eigh.ts`) accepts any square
matrix and runs Jacobi unconditionally — symmetry is the *caller's*
contract, enforced at the tool layer (above) via the
`linalg-eigh/non-symmetric-input` boundary tag.  This mirrors `qr()`'s
discipline (substrate is permissive on rectangular shape; tool layer
rejects non-finite or degenerate).

References: Jacobi, *Crelle's Journal* 30:51-94, 1846; Forsythe &
Henrici, *Trans. AMS* 94:1-23, 1960; Wilkinson, *The Algebraic
Eigenvalue Problem*, OUP 1965; Demmel & Veselić, *SIAM J. Matrix Anal.
Appl.* 13(4), 1992; Golub & Van Loan, *Matrix Computations*, 4th ed.,
JHU 2013, §8.4; Higham, *Accuracy and Stability of Numerical
Algorithms*, 2nd ed., SIAM 2002, §20.6.

Out of scope (v0.1, all explicitly deferred): generalised symmetric
eigh `A x = λ B x` (bead `geh`); non-Hermitian `linalg-eig` with
complex eigenvalues / Schur (bead `evh`); faster tridiag+QR substrate
(bead `te-qr`); FFI to LAPACK DSYEVD (bead `e7y`); cross-platform
determinism guarantee (`numerical: true`, ADR-0015).

## Invariants

- **deterministic-per-platform**: same input bytes → same output bytes
  on a single platform; `numerical: true` (ADR-0015) records the
  platform fingerprint in provenance.
- **reconstruction**: `‖A·Q − Q·diag(λ)‖_F ≤ 100·ε·n·√n·‖A‖_F`
  (Higham 2002 §20.6 with 100× safety).
- **orthogonality**: `‖QᵀQ − I_n‖_F ≤ 100·ε·n·√n` — independent of
  `κ(A)` (the Jacobi advertisement; Wilkinson 1965; Demmel-Veselić
  1992).
- **eigenvalues-ascending**: `λ[i] ≤ λ[i+1]` for all `i < n−1` (within
  tolerance `100·ε·max(|λ_max|, 1)`) — numpy / LAPACK convention.
- **self-reported-honesty**: reported `reconstruction_error` and
  `orthogonality_error` agree with the verifier's recomputation to
  `1e-6` relative.
- **non-symmetric-tagged**: any `A` with `max|A − Aᵀ| > 100·EPS·max|A|`
  produces `tagged "linalg-eigh/non-symmetric-input"` with the
  offending coordinate and asymmetry magnitude.
- **non-finite-tagged**: any `NaN` or `±Inf` in `A` produces
  `tagged "linalg-eigh/non-finite-input"` with the offending coordinate.
- **degenerate-shape-tagged**: `n = 0` produces
  `tagged "linalg-eigh/degenerate-shape"` with `(m, n)`.
- **scale-warnings-emitted**: for `n > 500`, the `warnings` field
  carries human-readable scale advisories per ADR-0016. Algorithm
  still runs.
- **oom-becomes-toolerror**: a true allocation OOM is caught and
  re-thrown as a `ToolError` carrying the attempted byte count. This
  is the only refusal class for oversize inputs (ADR-0016).
- **non-square-rejected**: non-square `A` raises `ToolError` (the
  suggestion points at `linalg-svd`).
- **non-rectangular-rejected**: ragged `A` raises `ToolError`.

## Validation

`bench/linalg-eigh/` — 46-case golden battery, 316 invariant assertions
(~7 checks per case):

1. `no_tool_error` — clean exit.
2. `shape` — output record has all expected fields.
3. `Q_orthonormal` — `‖QᵀQ − I_n‖_F ≤ tol_orth`
   (Higham 2002 §20.6 with 100× safety; independent of `κ(A)`).
4. `reconstruction` — `‖A·Q − Q·diag(λ)‖_F / max(‖A‖_F, 1) ≤ tol_recon`.
5. `eigenvalues_ascending` — `λ[i] ≤ λ[i+1]` for all `i < n−1`.
6. `self_reported_honesty` — reported errors agree with recomputation
   to `1e-6` relative.
7. `warnings_present_for_large_n` — `n > 500` cases emit `warnings`
   (ADR-0016 scale advisory).

Tier breakdown: A (square SPD random) · B (indefinite) · C (Hilbert
ill-conditioned) · D (near-defective / near-repeated eigenvalues) ·
E (degenerate-shape and non-symmetric refusals) · F (NIST harwell-boeing
SPD matrices) · G (stress: n=500).

**5 NIST harwell-boeing SPD matrices** (`bench/_corpus/harwell-boeing/`):
bcsstk01–05, all symmetric positive-definite, κ ∈ {4.3e3 … 6.8e6},
n ∈ {48 … 153}.

**Stress case:** n=500 (~7s pure TS Jacobi); green with scale warning.

**Mutation-proven** per CLAUDE.md Rule 6.

## Run

```sh
echo '{"kind":"record","fields":{"A":...}}' \
  | bun tools/linalg-eigh/tool.ts
```

Method flag (typed, ADR-0011): `--method=jacobi` (currently the only
choice; the flag exists so v0.2 can add `tridiag-qr` non-breakingly).

## Standard flags

`--schema --examples --invariants --version --help --provenance-of <hash> --test --platform-fingerprint`
