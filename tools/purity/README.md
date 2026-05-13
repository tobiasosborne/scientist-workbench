# purity

The **purity** `γ(ρ) = tr(ρ²)` of a complex `n × n` Hermitian
density operator ρ, computed via the entrywise sum-of-squares
identity that follows from Hermiticity:

```
γ(ρ) = tr(ρ²) = Σ_{i,j} ρ_{ij} · ρ_{ji}                       (general)
              = Σ_{i,j} ρ_{ij} · conj(ρ_{ij})                  (Hermitian)
              = Σ_{i,j} |ρ_{ij}|²
              = Σ_{i,j} (re_{ij}² + im_{ij}²).
```

The second deliverable of the qinfo v0.2 surface, sibling to
[`trace-norm`](../trace-norm/README.md). Unlike trace-norm, purity
needs **no eigendecomposition**: the Hermitian structure collapses
`tr(ρ²)` to a one-pass sum of squared entries. O(n²) — strictly
cheaper than trace-norm.

For a density operator ρ on a d-dimensional Hilbert space,
γ(ρ) ∈ [1/d, 1]: γ = 1 exactly on the rank-1 pure states
ρ = |ψ⟩⟨ψ|, and γ = 1/d on the maximally mixed state I/d.
Equivalently, `γ(ρ) = Σ_k λ_k²` where `λ` is the (real) spectrum of
ρ; the entrywise formula and the spectral formula agree exactly for
Hermitian ρ because the spectrum is unitarily invariant.

## Why a planner reaches for this

- **State-mixing thermometer.** `γ(ρ) = 1` ⇔ ρ pure;
  `γ(ρ) < 1` quantifies how mixed. Faster than the von Neumann
  entropy (which requires eigenvalues) when all you need is
  "is ρ near a pure state?" — the `is_pure_within_tolerance`
  field on the success record is the named answer.
- **Decoherence diagnostics.** Track γ across the trajectory of a
  noisy channel's output to quantify environment-induced
  decoherence; loss of purity is the quantitative signature of
  entanglement with an environment.
- **Entanglement witness in compositions.** Compose with
  `partial-trace`: γ(tr_B ρ_AB) = 1 iff ρ_AB is a product state
  on the AB bipartition.

## Input

```jsonc
{
  "kind": "record",
  "fields": {
    "rho": {
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
  }
}
```

`rho.re` and `rho.im` are both `n × n` (square, same shape). Both
fields are **required** — see ADR-0035 §D2 for the required-`im`
discipline that lets "this value is complex" read from the schema.
A real Hermitian density matrix (e.g. a classical-bit mixture) still
passes `rho.im` as an all-zero `list<list<float64>>`.

Hermiticity is checked within tolerance `max|ρ − ρ†| ≤ 100·EPS·max|ρ|`
(same threshold as `linalg-eigh-complex` and `trace-norm`).
Non-Hermitian inputs refuse loudly via a tagged boundary — purity
of a non-Hermitian matrix is not generally real, not in [0,1], and
does not measure mixedness, so we don't compute a misleading scalar.

The matrix is wrapped in a record `{rho}` so the surface can grow
additively — a future `tolerance?: float64` flag, a future
non-density-mode override — without schema-breaking edits.

## Output

Three shapes (ADR-0003 categories).

**Happy path — record:**

```jsonc
{
  "kind": "record",
  "fields": {
    "value":                     {"kind": "float64", ...},   // γ(ρ) = tr(ρ²)
    "trace":                     {"kind": "float64", ...},   // tr(ρ) — free diagnostic
    "is_pure_within_tolerance":  {"kind": "boolean", "value": true|false},
    "method":                    {"kind": "string", "value": "hermitian-sum-of-squares"},
    "warnings":                  {"kind": "list", "items": [<strings>]}
  }
}
```

- `value` is `γ(ρ)`. Non-negative by construction; equal to
  Σ_{i,j} (re² + im²) over all `n²` entries.
- `trace` is `tr(ρ) = Σ_i re[i,i]` — a free byproduct of the one-pass
  computation, surfaced so callers can check ρ is in fact a density
  matrix (`tr(ρ) ≈ 1`) without re-decoding.
- `is_pure_within_tolerance` is `|γ − 1| ≤ 1e-9` — the named flag the
  bead asks for, equal to "is ρ a rank-1 projector?" within that
  tolerance.
- `method` is the literal string `"hermitian-sum-of-squares"`
  (versus the `"hermitian-via-eigh-complex"` of trace-norm) so a
  caller comparing provenance records can tell which algorithm
  produced the value.

Warnings populated when:

- `|tr(ρ) − 1| > 1e-9` — ρ may not be a valid density operator. We
  *still compute* `γ = tr(ρ²)` because the formula is well-defined
  for any Hermitian matrix; the warning lets the caller decide
  whether to trust it as a "purity" or to treat it as `tr(A²)` of a
  general Hermitian observable.
- `γ > 1 + 1e-9` — definitive evidence that ρ is *not* a density
  operator: a Hermitian PSD matrix with `tr ≤ 1` has `tr(A²) ≤ 1`.
- `γ < 1/n − 1e-9` — definitive evidence that ρ is *not* a density
  operator: a density operator on a d-dim Hilbert space has
  `tr(ρ²) ≥ 1/d`.

The Pauli matrices (each Hermitian with eigenvalues ±1) all return
`γ = 2` with `tr = 0` and the warning "rho may not be a valid
density matrix" — purity is computed honestly, the interpretation
is up to the caller.

**Boundary failures — tagged:**

```jsonc
{
  "kind": "tagged",
  "tag": "purity/non-hermitian-input",
  "payload": {"kind": "record", "fields": {
    "row":            {"kind": "integer", "value": "<i>"},
    "col":            {"kind": "integer", "value": "<j>"},
    "violation":      {"kind": "string",  "value": "|M[i,j] − conj(M[j,i])|"},
    "max_violation":  {"kind": "string",  "value": "max|M − M†|"}
  }}
}
```

Returned when `max|ρ − ρ†| > 100·EPS·max|ρ|`. The payload's
`(row, col)` locates the worst off-diagonal violation; for a
diagonal violation `(i, i)` the formula reduces to `2 · |im[i,i]|`,
i.e. a Hermitian matrix has a real diagonal.

```jsonc
{
  "kind": "tagged",
  "tag": "purity/non-finite-input",
  "payload": {"kind": "record", "fields": {
    "row":   {"kind": "integer", "value": "<i>"},
    "col":   {"kind": "integer", "value": "<j>"},
    "part":  {"kind": "string",  "value": "re" | "im"},
    "value": {"kind": "string",  "value": "NaN" | "Infinity" | "-Infinity"}
  }}
}
```

Returned when `rho.re` or `rho.im` contains `NaN` / `±Inf`. The
planner can identify which part holds the bad value.

```jsonc
{
  "kind": "tagged",
  "tag": "purity/degenerate-shape",
  "payload": {"kind": "record", "fields": {
    "m": {"kind": "integer", "value": "<m>"},
    "n": {"kind": "integer", "value": "<n>"}
  }}
}
```

Returned when `n = 0`. No matrix to compute purity of.

**Malformed input — `ToolError` (exit 1):**

- `rho.re` and `rho.im` have different `m × n`
- `rho.re` is non-square (`m ≠ n`)
- ragged rows in `rho.re` or `rho.im`

## How

The Hermitian case admits the **entrywise sum-of-squares**
characterisation derived in the intent paragraph above. The
algorithm is

1. Decode the input wire shape into flat `Float64Array(n²)` for
   `re` and `im`, folding in non-finite detection (→ tagged) and a
   per-cell `|ρ_{ij}|` walk to compute `maxAbs` for the
   Hermiticity tolerance.
2. Hermiticity gate at `100·EPS·maxAbs`. Refuse on violation.
3. One O(n²) pass over the buffers: accumulate
   `value += re[i,j]² + im[i,j]²` (γ for Hermitian ρ) and
   `trace += re[i,i]` (tr ρ).
4. Emit the happy-path record.

Why this *isn't* "eigh + Σ λ²": for Hermitian ρ the two formulas
agree exactly (the spectrum is unitarily invariant, and
`tr(ρ²) = tr(QΛ²Q†) = Σ λ_k²`), but the entrywise sum sidesteps the
O(n³) eigendecomposition. For non-Hermitian ρ the two formulas
*disagree* — `tr(A²)` is not Σ |λ_k|² in general — but purity of a
non-density matrix is meaningless, so the Hermitian gate is the
right place to reject.

Why this isn't `trace-norm` with a `--squared` flag: `tr(ρ²)` and
`Σ|λ_k|` are different scalars, with different invariants, served
by different downstream callers; bundling them into a method
enum on the same tool would hide the type signature from
`registry-search`. Each scalar gets its own tool.

Out of scope (v0.1):

- Non-Hermitian general A — `tr(A²)` is well-defined but is not
  purity; if a workload asks, files as a new tool.
- Renyi entropies `S_α(ρ)` for `α ≠ 2`. The α = 2 Renyi entropy is
  `−log γ(ρ)`, so this tool computes its kernel; the log is a
  caller-side composition.

## Invariants

- **deterministic-per-platform**: same input bytes → same output
  bytes on a single platform; `numerical: true` (ADR-0015) records
  the platform fingerprint in provenance.
- **non-negative**: `value ≥ 0` for every successful run.
- **pure-state-unity**: `γ(|ψ⟩⟨ψ|) = 1` for every rank-1 pure state.
- **max-mixed-bound**: `γ(I_d/d) = 1/d` exactly.
- **density-operator-upper-bound**: `γ(ρ) ≤ 1` for every density
  operator; saturated iff ρ is pure.
- **hermitian-sum-of-squares-formula**:
  `γ(ρ) = Σ_{i,j} (re² + im²)` for Hermitian ρ.
- **unitary-invariance**: `γ(U ρ U†) = γ(ρ)` for any unitary U.
- **trace-pass-through**: the success record surfaces `tr(ρ)` for
  caller-side density-matrix validation.
- **non-hermitian-tagged**: `max|ρ − ρ†| > 100·EPS·max|ρ|` →
  `tagged "purity/non-hermitian-input"`. Never silently
  Hermitian-symmetrised.
- **non-finite-tagged**: NaN or ±Inf → `tagged "purity/non-finite-input"`.
- **degenerate-shape-tagged**: `n = 0` → `tagged "purity/degenerate-shape"`.
- **shape-mismatch-rejected**: disagreeing re/im shapes → `ToolError`.
- **non-square-rejected**: non-square ρ → `ToolError`.

## Run

```sh
# rho = |0><0| pure state; γ = 1, is_pure = true.
echo '{"kind":"record","fields":{"rho":{"kind":"record","fields":{"re":{"kind":"list","items":[
  {"kind":"list","items":[{"kind":"float64","bits":"3ff0000000000000"},{"kind":"float64","bits":"0000000000000000"}]},
  {"kind":"list","items":[{"kind":"float64","bits":"0000000000000000"},{"kind":"float64","bits":"0000000000000000"}]}
]},"im":{"kind":"list","items":[
  {"kind":"list","items":[{"kind":"float64","bits":"0000000000000000"},{"kind":"float64","bits":"0000000000000000"}]},
  {"kind":"list","items":[{"kind":"float64","bits":"0000000000000000"},{"kind":"float64","bits":"0000000000000000"}]}
]}}}}}' | bun tools/purity/tool.ts
```

## Standard flags

`--schema --examples --invariants --version --help --provenance-of <hash> --test --platform-fingerprint`
