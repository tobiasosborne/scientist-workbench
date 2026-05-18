# linalg-svd-complex

Singular value decomposition `M = U · diag(S) · V†` for a complex
`m × n` matrix via **complex one-sided Jacobi** (Hari-Veselić 1987).
The complex sibling of `linalg-svd`; the second deliverable of
ADR-0035's "complex linalg tier" (alongside the shipped
`linalg-eigh-complex` and the filed `linalg-solve-complex`). Returns
*not just* `(U, S, Vh)` but a record carrying the reconstruction
error `‖M − U · diag(S) · Vh‖_F / max(‖M‖_F, 1)`, the unitarity
errors `‖U† U − I‖_F` and `‖Vh · Vh† − I‖_F`, the spectral condition
number `S[0] / S[k-1]`, and the LAPACK-threshold rank estimate —
everything a planner needs to decide whether to trust the
factorisation, treat `M` as numerically rank-deficient, or escalate
the precision warning.

Library surface (TS-side, no JSON):

```ts
import { complexFromNested, svdComplex } from "@workbench/linalg-core";

// 2×2 complex Hermitian H = [[1, i], [-i, 1]]: rank 1, singular values [2, 0]
const H = complexFromNested([[1, 0], [0, 1]], [[0, 1], [-1, 0]]);
const r = svdComplex(H);
// r.S            = Float64Array [2, 0]
// r.U has 2×2 complex columns (re, im Float64Arrays)
// r.V has 2×2 complex columns (Vh is wired as r.V's conjugate transpose)
// r.rankEstimate = 1
// r.reconstructionError ~ 1e-16
```

The qinfo substrate's `Matrix` type (optional `im`) bridges to
`ComplexMatrix` via `complexFromQinfo` — a real matrix with zero
imaginary part round-trips without surprise (allocates the zero
buffer for you).

## Input

```jsonc
{
  "kind": "record",
  "fields": {
    "re":   {"kind": "list", "items": [<list<float64>>, ...]},
    "im":   {"kind": "list", "items": [<list<float64>>, ...]},
    "mode": {"kind": "string", "value": "reduced" | "complete"}   // optional, default "reduced"
  }
}
```

`re` and `im` are both `m × n` (matching rectangular shape — see
ADR-0035 §D2 for why `im` is *required* rather than optional). For a
real-valued matrix the caller still passes `im` as an all-zero
`list<list<float64>>`; the complex Jacobi path runs with the
imaginary-arithmetic terms vanishing — same result as the cheap
real path with `im=0` round-off.

`mode` selects the output shape:

| mode | `U`     | `Vh`    | when to use |
|------|---------|---------|-------------|
| `reduced` (default) | `m × k` | `k × n` | numerical work — minimal storage, all the singular vectors that matter |
| `complete` | `m × m` | `n × n` | when you need the full orthonormal bases (e.g., `ker(M†)` or `ker(M)`) |

Both modes return the same `k = min(m, n)` singular values (the
complete-mode extra columns of `U` / `Vh` correspond to implicit
zero singular values).

Per ADR-0016 there is **no hard size cap** — large inputs run with
scale-advisory warnings; only a true allocation OOM raises a
`ToolError`. Cost is ~4× a hypothetical native complex
bidiagonal-QR variant (complex Jacobi is `O(n³ log n)`; complex
bidiagonal-QR is `O(n³)` with a small constant). At qinfo
dogfood-scale (`max(m, n) ≤ 256`), the constant-factor difference
is invisible — under 0.5 s at `n=128`. A v0.2 bidiagonal-QR variant
(if ever justified by a workload) is filed under `ov4j`.

## Output

Three shapes (ADR-0003 categories).

**Happy path — record:**

```jsonc
{
  "kind": "record",
  "fields": {
    "U":  {"kind": "record", "fields": {                  // complex m × q
      "re": {"kind": "list", "items": [...]},
      "im": {"kind": "list", "items": [...]}
    }},
    "S":  {"kind": "list", "items": [...]},               // length k, real, descending
    "Vh": {"kind": "record", "fields": {                  // complex q' × n (V conjugate transpose)
      "re": {"kind": "list", "items": [...]},
      "im": {"kind": "list", "items": [...]}
    }},
    "mode":                  {"kind": "string", "value": "reduced" | "complete"},
    "reconstruction_error":  {"kind": "float64", ...},
    "orthogonality_error_U": {"kind": "float64", ...},
    "orthogonality_error_Vh":{"kind": "float64", ...},
    "condition_number":      {"kind": "float64", ...},
    "rank_estimate":         {"kind": "integer", ...},
    "method":                {"kind": "string", "value": "complex-one-sided-jacobi"},
    "warnings":              {"kind": "list", "items": [<strings>]}
  }
}
```

`U` is the `m × q` left singular vectors; `Vh = V†` is the `q' × n`
*conjugate transpose* of the right singular vectors (NumPy
convention, parallel to the real tool's `Vt = Vᵀ`). The
factorisation reads directly: `M = U · diag(S) · Vh`.

`S` is **real** (singular values are non-negative real by spectral
theorem) and sorted **descending** (LAPACK / `np.linalg.svd`
convention).

Emitting `S` as `list<float64>` (not `list<record{re, im}>` of
always-zero-imaginary) is deliberate. Singular values are real;
pretending otherwise would lie about what the algorithm produces.

`reconstruction_error`, `orthogonality_error_U`, and
`orthogonality_error_Vh` are the candidate's own self-report on its
own quality, computed in **complex** arithmetic (the `M · V`
product, the `U† U − I` and `Vh · Vh† − I` Frobenius norms). The
downstream bench verifier (corpus side, filed under `ov4j`) will
recompute all three against `np.linalg.svd(M)` and reject the
candidate on disagreement > `1e-6` relative — agent-honest is
*enforced*.

`condition_number` is `S[0] / S[k-1]` when `S[k-1] > 0`, else
capped at `1/EPS ≈ 4.5e15`. `rank_estimate` counts singular values
exceeding `max(m, n) · EPS · S[0]` — the LAPACK-standard
numerical-rank threshold (LAPACK DGESDD, `MATRIX_RANK` semantics).

Warnings populated when:
- `reconstruction_error > 1e-12`
- `orthogonality_error_U > 1e-12`
- `orthogonality_error_Vh > 1e-12`
- `condition_number > 1e12`
- `max(m, n) > 500` — scale advisory per ADR-0016

These are *fields*, not refusals — complex one-sided Jacobi inherits
the relative-accuracy property of real Jacobi (Demmel-Veselić 1992;
Drmač 1997 §4), and the bench's tolerance has 100× safety on Higham
2002 §21.

**Boundary failures — tagged:**

```jsonc
{
  "kind": "tagged",
  "tag": "linalg-svd-complex/non-finite-input",
  "payload": {"kind": "record", "fields": {
    "row":   {"kind": "integer", "value": "<i>"},
    "col":   {"kind": "integer", "value": "<j>"},
    "part":  {"kind": "string",  "value": "re" | "im"},
    "value": {"kind": "string",  "value": "NaN" | "Infinity" | "-Infinity"}
  }}
}
```

Returned when `re` or `im` contains `NaN` / `±Inf`. The planner can
identify which part holds the bad value.

```jsonc
{
  "kind": "tagged",
  "tag": "linalg-svd-complex/degenerate-shape",
  "payload": {"kind": "record", "fields": {
    "m": {"kind": "integer", "value": "<m>"},
    "n": {"kind": "integer", "value": "<n>"}
  }}
}
```

Returned when `m = 0` or `n = 0`. No answer to give on an empty
matrix.

**Malformed input — `ToolError` (exit 1):**

- `re` and `im` have different `m × n` (no single complex matrix to
  operate on).
- ragged rows in `re` or `im`.
- `mode` is a string other than `"reduced"` or `"complete"`.
- True allocation OOM on the working buffers (caught and re-thrown
  with attempted-bytes detail).

Unlike `linalg-eigh-complex`, **non-square `re` is NOT an error**:
SVD is defined for any `m × n`. The substrate routes `m < n` inputs
through `M†` internally and swaps `U ↔ V` at the end.

## How

**Complex one-sided Jacobi** (Hari-Veselić 1987; one-sided variant
of Brent-Luk 1985). One-sided Jacobi diagonalises `M† M` *implicitly*
by complex unitary column rotations of `M`. The key identity:
if `M = U · Σ · V†`, then `M† M = V · Σ² · V†`, so a sequence of
right-rotations `V` that orthogonalises the columns of `M · V`
reveals both `Σ` (column norms) and `U` (normalised orthogonal
columns).

**Why not the real-symplectic embedding** (the trick that works for
`linalg-eigh-complex`). ADR-0035 §D8: *"the symplectic embedding
buys nothing for SVD."* The embedding's eigenvalue-pairing argument
relies on the spectral theorem's `Q · diag(λ) · Q†` structure;
SVD's distinct `U` and `V` don't fit the pairing pattern, so the
analogous 2m × 2n real-embedded SVD produces singular values paired
with messy interleaving and no algorithmic shortcut. Native complex
Jacobi runs directly on `M` with complex Jacobi rotations and
retains the relative-accuracy property without the embedding's 8×
flop overhead.

**Per-pair update** for columns `(p, q)` of the work matrix `W`:

1. Form the 2×2 Gram-matrix entries `α = ‖W[:, p]‖²`, `β =
   ‖W[:, q]‖²`, `γ = ⟨W[:, p], W[:, q]⟩`. `α` and `β` are real;
   `γ` is complex.
2. Skip if `|γ|² ≤ ε² · α · β` (Drmač 1997 §4.2 per-pair tolerance
   — the relative-accuracy test).
3. **Phase extraction** (the complex-specific step real Jacobi
   doesn't need). Set `e^{-iθ} = conj(γ) / |γ|` so the next rotation
   sees a real Gram inner product `γ' = |γ|`.
4. Real Jacobi tangent recipe on `[[α, |γ|], [|γ|, β]]`:
   `ζ = (β − α) / (2|γ|)`, `t = sgn(ζ) / (|ζ| + √(1 + ζ²))`, `c =
   1 / √(1 + t²)`, `s = t · c`.
5. Apply the combined complex rotation
   ```
   W[:, p] ← c · W[:, p] − s · e^{-iθ} · W[:, q]
   W[:, q] ← s · W[:, p] + c · e^{-iθ} · W[:, q]
   ```
   to columns p and q of W and to the V accumulator (initialised as
   the complex identity).

**Convergence.** Hari-Veselić 1987 §3 proves monotone decrease of
the off-diagonal mass `Σ_{p<q} |⟨W[:,p], W[:,q]⟩|²` each rotation;
empirical bounds give O(log n) sweeps to machine precision. We cap
at 60 sweeps (same as real Jacobi).

**Post-processing.** Column norms of W at convergence are the
singular values; `U_work[:, j] = W[:, j] / σ_j` are the left
singular vectors. Sort `σ` descending; permute U and V accordingly.
For `m < n` we worked on `M†`, so swap `(U, V) ← (V, U)` at the
end (SVD of `M†` is `V · Σ · U†`). For complete mode, extend `U`
and `V` to square via complex Gram-Schmidt.

Full algorithm prose with reference citations lives in
`packages/linalg-core/src/svd-complex.ts`.

**Wire emits `Vh = V†`** (conjugate transpose), parallel to the real
tool's `Vt = Vᵀ` and matching NumPy's `np.linalg.svd` return. The
substrate keeps `V` itself so the substrate-side reconstruction
diagnostic can use `M · V − U · diag(S)` directly without an extra
adjoint allocation.

References: Forsythe & Henrici, *Trans. AMS* 94:1-23, 1960 (the
first complex-matrix Jacobi SVD); Brent & Luk, *SIAM J. Sci. Stat.
Comput.* 6(1):69-84, 1985 (the one-sided variant used here);
Hari & Veselić, *SIAM J. Sci. Stat. Comp.* 8(5):741-754, 1987
(convergence proof for complex one-sided Jacobi); Demmel & Veselić,
*SIAM J. Matrix Anal. Appl.* 13(4):1204-1245, 1992 (the
relative-accuracy property); Drmač, *SIAM J. Sci. Comput.*
18(4):1200-1222, 1997 (per-pair tolerance test); Higham,
*Accuracy and Stability of Numerical Algorithms*, 2nd ed., SIAM
2002, §10 (complex matrices) + §21 (SVD backward stability). See
ADR-0035 for the design decisions and worklog 127 for the
iteration.

Out of scope (v0.1, explicitly deferred):
- Complex bidiagonal + implicit-shift QR (LAPACK ZGESDD) — `O(n³)`
  with a small constant, would be the right path when a workload
  at `n > 1000` justifies the porting work. v0.2 follow-up under
  `ov4j` if ever needed.
- FFI to LAPACK ZGESVD / ZGESDD (bead `e7y`).
- Generalised SVD (`H · x = λ · B · x` analog) — different surface,
  separate bead.
- Randomised SVD for very large rectangular matrices — bead `71f`.

## Invariants

- **deterministic-per-platform**: same input bytes → same output
  bytes on a single platform; `numerical: true` (ADR-0015) records
  the platform fingerprint in provenance.
- **reconstruction**: `‖M − U · diag(S) · Vh‖_F ≤
  100·ε·max(m,n)·√min(m,n)·‖M‖_F` (Higham 2002 §21; complex
  one-sided Jacobi inherits the real bound; Hari-Veselić 1987).
- **orthogonality-U**: `‖U† U − I_q‖_F ≤ 100·ε·m·√q` — independent
  of `κ(M)`; Demmel-Veselić 1992 relative-accuracy carries to
  complex case (Drmač 1997 §4).
- **orthogonality-Vh**: `‖Vh · Vh† − I_q'‖_F ≤ 100·ε·n·√q'`.
- **S-non-negative-descending-real**: `S[i] ≥ 0` and `S[i] ≥
  S[i+1]` (within tolerance `100·ε·S[0]`); `S` is `list<float64>`
  (not `list<record{re, im}>`).
- **self-reported-honesty**: reported `reconstruction_error`,
  `orthogonality_error_U`, and `orthogonality_error_Vh` agree with
  `np.linalg.svd(M)` recomputation to `1e-6` relative.
- **rank-estimate-LAPACK-threshold**: `rank_estimate` counts
  singular values exceeding `max(m, n) · EPS · S[0]`.
- **non-finite-tagged**: any `NaN` or `±Inf` in `re` or `im` produces
  `tagged "linalg-svd-complex/non-finite-input"`.
- **degenerate-shape-tagged**: `m = 0` or `n = 0` produces
  `tagged "linalg-svd-complex/degenerate-shape"`.
- **shape-mismatch-rejected**: `re` and `im` with disagreeing
  `rows × cols` raises `ToolError`.
- **rectangular-input-supported**: `m ≠ n` is supported (unlike
  `linalg-eigh-complex`); `m < n` routes via `M†` internally.
- **real-input-cheap-path**: all-zero `im` runs through the complex
  path with imaginary-arithmetic terms vanishing.
- **scale-warnings-emitted**: `max(m, n) > 500` emits scale
  advisories per ADR-0016.
- **oom-becomes-toolerror**: true allocation OOM caught and
  re-thrown as `ToolError` with attempted byte count.

## Run

```sh
# 2×2 Hermitian H = [[1, i], [-i, 1]] (rank 1, singular values [2, 0]):
echo '{"kind":"record","fields":{
  "re":{"kind":"list","items":[
    {"kind":"list","items":[{"kind":"float64","bits":"3ff0000000000000"},
                            {"kind":"float64","bits":"0000000000000000"}]},
    {"kind":"list","items":[{"kind":"float64","bits":"0000000000000000"},
                            {"kind":"float64","bits":"3ff0000000000000"}]}
  ]},
  "im":{"kind":"list","items":[
    {"kind":"list","items":[{"kind":"float64","bits":"0000000000000000"},
                            {"kind":"float64","bits":"3ff0000000000000"}]},
    {"kind":"list","items":[{"kind":"float64","bits":"bff0000000000000"},
                            {"kind":"float64","bits":"0000000000000000"}]}
  ]}
}}' | bun tools/linalg-svd-complex/tool.ts
```

Method flag (typed, ADR-0011): `--method=complex-one-sided-jacobi`
(currently the only choice; the flag exists so a future complex
bidiagonal-QR variant can be added non-breakingly).

## Standard flags

`--schema --examples --invariants --version --help --provenance-of <hash> --test --platform-fingerprint`
