# linalg-eigh-complex

Hermitian eigendecomposition `H = Q · diag(λ) · Q†` for a complex
`n × n` *Hermitian* matrix via the real-symplectic embedding
(Goedecker 1999; Day & Heroux 2001) composed with the existing real
cyclic-Jacobi `eigh` (`tools/linalg-eigh`). The complex sibling of
`linalg-eigh`; the first deliverable of ADR-0035's "complex linalg
tier" alongside `linalg-svd-complex` and `linalg-solve-complex` (both
filed). Returns *not just* `(Q, λ)` but a record carrying the
reconstruction error `‖H·Q − Q·diag(λ)‖_F / max(‖H‖_F, 1)`, the
unitarity error `‖Q† Q − I‖_F`, and the spectral condition number
`|λ_max| / |λ_min|` — everything a planner needs to decide whether
to trust the factorisation, treat `H` as nearly singular, or escalate
the precision warning.

Library surface (TS-side, no JSON):

```ts
import { complexFromNested, eighComplex } from "@workbench/linalg-core";

// Pauli Y matrix: re=0, im=[[0,-1],[1,0]]
const Y = complexFromNested([[0,0],[0,0]], [[0,-1],[1,0]]);
const r = eighComplex(Y);
// r.eigenvalues = Float64Array [-1, 1]
// r.Q has 2×2 complex columns (re, im Float64Arrays)
// r.reconstructionError ~ 1e-16; r.orthogonalityError ~ 1e-16
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
    "re": {"kind": "list", "items": [
      {"kind": "list", "items": [{"kind": "float64", "bits": "..."}, ...]},
      ...
    ]},
    "im": {"kind": "list", "items": [
      {"kind": "list", "items": [{"kind": "float64", "bits": "..."}, ...]},
      ...
    ]}
  }
}
```

`re` and `im` are both `n × n` (square, same shape — see ADR-0035 §D2
for why `im` is *required* rather than optional). For a Hermitian
matrix with no imaginary part the caller still passes `im` as an
all-zero `list<list<float64>>`; the embedded real eigh then runs on
`A` twice through the block-diagonal `H̃ = [[A, 0]; [0, A]]` (the
cheap fall-through path).

Hermiticity is checked *within tolerance*: `max|H − H†| ≤
100·EPS·max|H|` mirrors `linalg-eigh`'s `_is_symmetric`. The
imaginary part must satisfy `im[i,j] = -im[j,i]` (antisymmetric);
the real part must be symmetric; the diagonal of `im` must be zero.

Per ADR-0016 there is **no hard size cap** — large inputs run with
scale-advisory warnings; only a true allocation OOM raises a
`ToolError`. Cost is 8× a hypothetical native complex-Jacobi (the
embedding doubles the working dimension; real cyclic Jacobi runs on
`2n × 2n` ⟹ `8·` real-Jacobi flops). In pure TS, `n=100 ≈ 1 s`,
`n=200 ≈ 8 s`. Native complex Householder + complex implicit-shift
QR is a v0.2 follow-up under `ov4j` when a workload justifies the
constant-factor win.

## Output

Four shapes (ADR-0003 categories).

**Happy path — record:**

```jsonc
{
  "kind": "record",
  "fields": {
    "Q": {                                  // complex n × n unitary
      "kind": "record",
      "fields": {
        "re": {"kind": "list", "items": [...]},
        "im": {"kind": "list", "items": [...]}
      }
    },
    "eigenvalues":            {"kind": "list", "items": [...]},  // length n, real, ascending
    "reconstruction_error":   {"kind": "float64", ...},
    "orthogonality_error":    {"kind": "float64", ...},
    "condition_number":       {"kind": "float64", ...},
    "method":                 {"kind": "string", "value": "real-symplectic-embedding"},
    "warnings":               {"kind": "list", "items": [<strings>]}
  }
}
```

`Q` is the `n × n` complex unitary whose columns are the eigenvectors.
`eigenvalues` are **real** (Hermitian spectral theorem) and sorted
**ascending** (numpy / `np.linalg.eigh` convention). Column `j` of `Q`
is the eigenvector corresponding to `eigenvalues[j]`.

Emitting `eigenvalues` as `list<float64>` (not
`list<record{re, im}>` of always-zero-imaginary) is deliberate —
ADR-0035 §D3. Hermitian eigenvalues are real; pretending otherwise
would lie about what the algorithm produces.

`reconstruction_error` and `orthogonality_error` are the candidate's
own self-report on its own quality, computed in **complex** arithmetic
(the `H·Q` product, the `Q† Q − I` Frobenius norm). The downstream
bench verifier (corpus side, filed under `ov4j`) will recompute both
against `np.linalg.eigh(H)` and reject the candidate on disagreement
> `1e-6` relative — agent-honest is *enforced*.

`condition_number` is `|λ_max| / |λ_min|` when `|λ_min| > 0`, else
clamped to `1/EPS ≈ 4.5e15`. Same formula as the real case; complex
Hermitian eigenvalues are still real-valued numbers on which
`|·|` is well-defined.

Warnings populated when:
- `reconstruction_error > 1e-12`
- `orthogonality_error > 1e-12`
- `condition_number > 1e12`
- `2n > 500` — scale advisory per ADR-0016 (the embedded `H̃` is
  `2n × 2n`; we report against the embedded size, not the user-facing
  `n`, because that's what the algorithm actually computes against).

These are *fields*, not refusals — the embedding inherits the
backward-stability of real cyclic Jacobi verbatim, and the bench's
tolerance has 100× safety on Higham 2002 §20.6.

**Boundary failures — tagged:**

```jsonc
{
  "kind": "tagged",
  "tag": "linalg-eigh-complex/non-hermitian-input",
  "payload": {"kind": "record", "fields": {
    "row":            {"kind": "integer", "value": "<i>"},
    "col":            {"kind": "integer", "value": "<j>"},
    "violation":      {"kind": "string",  "value": "|H[i,j] − conj(H[j,i])|"},
    "max_violation":  {"kind": "string",  "value": "max|H − H†|"}
  }}
}
```

Returned when `max|H − H†| > 100·EPS·max|H|`. The planner can match
on the tag, read the violation magnitude, and decide whether to
Hermitian-symmetrise (`H := (H + H†) / 2`) and retry.

```jsonc
{
  "kind": "tagged",
  "tag": "linalg-eigh-complex/non-finite-input",
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
  "tag": "linalg-eigh-complex/degenerate-shape",
  "payload": {"kind": "record", "fields": {
    "m": {"kind": "integer", "value": "<m>"},
    "n": {"kind": "integer", "value": "<n>"}
  }}
}
```

Returned when `n = 0`. No answer to give on an empty matrix.

**Malformed input — `ToolError` (exit 1):**

- `re` and `im` have different `m × n` (no single complex matrix to
  operate on).
- `re` is non-square (`m ≠ n`) — suggestion points at
  `linalg-svd-complex` (filed under `ov4j`) when it ships.
- ragged rows in `re` or `im`.
- True allocation OOM on the `2n × 2n` embedded buffer (caught and
  re-thrown with attempted-bytes detail).

## How

**Real-symplectic embedding.** For Hermitian `H = A + iB` with `A`
real-symmetric and `B` real-antisymmetric, define

```
H̃ = ⎡  A   -B ⎤      (size 2n × 2n)
     ⎣  B    A ⎦
```

`H̃ᵀ = [[Aᵀ, Bᵀ]; [-Bᵀ, Aᵀ]] = [[A, -B]; [B, A]] = H̃` (using `Aᵀ = A`
and `Bᵀ = -B`), so `H̃` is real-symmetric and has a real-orthogonal
eigendecomposition. The spectrum of `H̃` is the spectrum of `H`,
*each eigenvalue with multiplicity 2*: for a complex eigenvector
`q = u + iw` of `H` with `H q = λ q`, the real vector `v = (u, w) ∈
ℝ^{2n}` satisfies `H̃ v = λ v`, and `J(v) := (-w, u)` is a second
eigenvector with the same `λ`.

The algorithm runs the existing real cyclic-Jacobi `eigh` on `H̃`
unchanged — zero new spectral code in v0.1. Then:

1. `H̃` returns eigenvalues sorted ascending; they come in pairs.
   Take every other: `λ[k] = λ̃[2k]`.
2. Take column `2k` of `Q̃` and split it: top half is `u_k ∈ ℝ^n`,
   bottom half is `w_k ∈ ℝ^n`. Set `Q[:, k] = u_k + i w_k`.
3. Run complex Modified Gram-Schmidt on `Q`'s columns.

The MGS pass is defence-in-depth for degenerate-eigenvalue cases.
For non-degenerate eigenvalues, the columns are already
complex-orthonormal by the Hermitian spectral theorem (a real-
orthogonal `v_a ⊥ v_b` combined with the automatic `v_a ⊥ J(v_b)`
within `λ_b`'s eigenspace cancels both real and imaginary parts of
`q_a* q_b`). For degenerate eigenvalues — multiplicity > 1 — real
eigh picks an arbitrary orthonormal basis of the `2m`-dimensional
embedded eigenspace, and adjacent pairs may not be `J`-related; MGS
canonicalises this. Within a degenerate eigenspace any orthonormal
basis is a valid eigenvector basis, so MGS does not increase the
reconstruction error.

Full algorithm prose with reference citations lives in
`packages/linalg-core/src/eigh-complex.ts`.

**Why not native complex Householder + complex implicit-shift QR**
(LAPACK ZHETRD + ZSTEQR, the ZHEEVD path). Both are admissible by
the bench's tolerance regime; the native-complex path is ~4× faster
in the constant factor (`n³` complex flops = `4n³` real flops, vs
`(2n)³ = 8n³` real flops for the embedding). At the qinfo
dogfood-scale (`n ≤ 256` dense) the constant-factor difference is
invisible — under 1 s at `n=128`. The embedding ships in v0.1 because
it reuses `eigh.ts` *verbatim* — zero new spectral code — and inherits
its backward-stability properties (Higham 2002 §20.6) without
re-analysis. v0.2 follow-up (filed under `ov4j`) ports native complex
Householder when a workload at `n > 1000` justifies the work.

The substrate (`packages/linalg-core/src/eigh-complex.ts`) accepts
any square `ComplexMatrix` and runs the embedding unconditionally —
Hermiticity is the *caller's* contract, enforced at the tool layer
via the `linalg-eigh-complex/non-hermitian-input` boundary tag.

References: Goedecker, *Rev. Mod. Phys.* 71:1085-1123, 1999 (the
embedding in DFT); Day & Heroux, *SIAM J. Sci. Comput.*
23(2):480-498, 2001 (backward-stability analysis); Higham,
*Accuracy and Stability of Numerical Algorithms*, 2nd ed., SIAM
2002, §10 (complex matrices) + §20.6 (symmetric eigenproblem
backward stability, inherited verbatim); Watrous, *Theory of Quantum
Information*, Cambridge 2018, §1.1 (the upstream qinfo motivation).
See ADR-0035 for the design decisions and worklog 100 for the
iteration.

Out of scope (v0.1, explicitly deferred):
- Non-Hermitian complex eigendecomposition (`linalg-eig`, bead `evh`)
  — eigenvalues complex; eigenvectors may not span.
- Generalised Hermitian-definite eigh `H x = λ B x` (bead `geh`).
- Native complex Householder + implicit-shift QR — ADR-0035 §D5 v0.2
  follow-up.
- FFI to LAPACK ZHEEVD (bead `e7y`).

## Invariants

- **deterministic-per-platform**: same input bytes → same output
  bytes on a single platform; `numerical: true` (ADR-0015) records
  the platform fingerprint in provenance.
- **reconstruction**: `‖H·Q − Q·diag(λ)‖_F ≤ 100·ε·n·√n·‖H‖_F`
  (Higham 2002 §20.6 inherited through the embedding).
- **unitarity**: `‖Q† Q − I_n‖_F ≤ 100·ε·n·√n` — independent of
  `κ(H)`; complex MGS guarantees this even on degenerate eigenspaces.
- **eigenvalues-real**: every eigenvalue is real (Hermitian spectral
  theorem). Substrate emits `Float64Array`; wire emits
  `list<float64>`.
- **eigenvalues-ascending**: `λ[i] ≤ λ[i+1]` for all `i < n−1`
  (within tolerance `100·ε·max(|λ_max|, 1)`).
- **self-reported-honesty**: reported `reconstruction_error` and
  `orthogonality_error` agree with `np.linalg.eigh(H)` recomputation
  to `1e-6` relative on every bench corpus case.
- **non-hermitian-tagged**: any `H` with `max|H − H†| > 100·EPS·max|H|`
  produces `tagged "linalg-eigh-complex/non-hermitian-input"` with
  the offending coordinate and violation magnitude.
- **non-finite-tagged**: any `NaN` or `±Inf` in `re` or `im` produces
  `tagged "linalg-eigh-complex/non-finite-input"` with `(row, col,
  part, value)`.
- **degenerate-shape-tagged**: `n = 0` produces
  `tagged "linalg-eigh-complex/degenerate-shape"` with `(m, n)`.
- **shape-mismatch-rejected**: `re` and `im` with disagreeing
  `rows × cols` raises `ToolError`.
- **non-square-rejected**: non-square `re` raises `ToolError` (the
  suggestion points at `linalg-svd-complex` when shipped).
- **real-input-cheap-path**: all-zero `im` exercises the
  block-diagonal embedding — equivalent to running real `eigh` on `A`
  with eigenvalues paired and eigenvectors trivially lifted.
- **scale-warnings-emitted**: for `2n > 500`, the `warnings` field
  carries human-readable scale advisories per ADR-0016.
- **oom-becomes-toolerror**: a true allocation OOM on the embedded
  `2n × 2n` buffer is caught and re-thrown as `ToolError` with the
  attempted byte count.

## Run

```sh
# Pauli Y as canonical complex Hermitian input:
echo '{"kind":"record","fields":{"re":{"kind":"list","items":[
  {"kind":"list","items":[{"kind":"float64","bits":"0000000000000000"},
                          {"kind":"float64","bits":"0000000000000000"}]},
  {"kind":"list","items":[{"kind":"float64","bits":"0000000000000000"},
                          {"kind":"float64","bits":"0000000000000000"}]}
]},"im":{"kind":"list","items":[
  {"kind":"list","items":[{"kind":"float64","bits":"0000000000000000"},
                          {"kind":"float64","bits":"bff0000000000000"}]},
  {"kind":"list","items":[{"kind":"float64","bits":"3ff0000000000000"},
                          {"kind":"float64","bits":"0000000000000000"}]}
]}}}' | bun tools/linalg-eigh-complex/tool.ts
```

Method flag (typed, ADR-0011): `--method=real-symplectic-embedding`
(currently the only choice; the flag exists so v0.2 can add
`complex-jacobi` non-breakingly).

## Standard flags

`--schema --examples --invariants --version --help --provenance-of <hash> --test --platform-fingerprint`
