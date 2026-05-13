# trace-distance

The **trace distance** between two density operators ρ, σ on the
same d-dimensional Hilbert space:

```
D(ρ, σ) = ½ · ‖ρ − σ‖₁   ∈   [0, 1]
        = ½ · Σ_k |λ_k(ρ − σ)|       (spectral characterisation; Bhatia §IV.2)
```

The operationally-meaningful state-distinguishability metric. By
**Helstrom's theorem** (1969), the maximum probability of correctly
guessing which of two equally-likely states (ρ vs σ) was prepared,
by any quantum measurement followed by an optimal classical
decision, is

```
P_distinguish = ½ · (1 + D(ρ, σ)).
```

Two states with D = 1 are perfectly distinguishable; with D = 0 they
are identical. The third deliverable of the qinfo v0.2 surface,
composing on the same `eighComplex` substrate as `trace-norm`: the
difference `ρ − σ` of two Hermitian matrices is Hermitian, so the
spectral formula applies verbatim and we halve.

## Why a planner reaches for this

- **Distinguishability bounds.** Helstrom is the tight bound for
  one-shot state-discrimination — any downstream cost-of-information
  argument routes through it.
- **Fidelity ↔ trace-distance** (Fuchs–van de Graaf 1999):
  `1 − F(ρ, σ) ≤ D(ρ, σ) ≤ √(1 − F(ρ, σ)²)`. Once `tools/fidelity`
  ships (bead `2hxf`), the pair `D` and `F` characterises two
  operationally-meaningful state distances; this tool is the `D`
  side.
- **Channel distinguishability** via the diamond norm
  (Watrous §3.3): `D_◇(Φ, Ψ) = sup_ρ D((Φ ⊗ I)(ρ), (Ψ ⊗ I)(ρ))`.
  The supremum is an SDP; the inner state-distance is this tool
  composed across choices of ρ.

## Input

```jsonc
{
  "kind": "record",
  "fields": {
    "rho":   {"kind": "record", "fields": {
      "re": {"kind": "list", "items": [/* n × n */]},
      "im": {"kind": "list", "items": [/* n × n */]}
    }},
    "sigma": {"kind": "record", "fields": {
      "re": {"kind": "list", "items": [/* n × n */]},
      "im": {"kind": "list", "items": [/* n × n */]}
    }}
  }
}
```

Both `rho` and `sigma` use the same canonical complex-matrix wire
shape as `trace-norm` and `purity` (ADR-0035 §D2): `re` and `im` are
both **required**, shape-matched, and `n × n` square. A real
Hermitian density matrix passes `im` as an all-zero
`list<list<float64>>`.

Hermiticity is checked within tolerance `max|M − M†| ≤ 100·EPS·max|M|`
on each input separately (same threshold as `linalg-eigh-complex`).
Non-Hermitian inputs refuse via a tagged boundary that names which
input is bad (`which` ∈ `{"rho", "sigma"}`).

## Output

Three shapes (ADR-0003 categories).

**Happy path — record:**

```jsonc
{
  "kind": "record",
  "fields": {
    "value":    {"kind": "float64", ...},  // D(ρ, σ) — single non-negative scalar
    "method":   {"kind": "string", "value": "hermitian-eigh-of-difference"},
    "warnings": {"kind": "list", "items": [<strings>]}
  }
}
```

- `value` is the scalar D(ρ, σ). Non-negative by construction; in
  `[0, 1]` for valid density operators (warned if outside).
- `method` is the literal string `"hermitian-eigh-of-difference"`
  so a caller comparing provenance records can distinguish from
  any future alternative algorithm (e.g. a direct SVD path for
  the general non-Hermitian case).

Warnings populated when:

- `|tr(ρ) − 1| > 1e-9` or `|tr(σ) − 1| > 1e-9` — input may not be a
  valid density operator. The tool *still computes* D because the
  spectral formula is well-defined for any two Hermitian matrices;
  the warning is informational.
- `value > 1 + 1e-9` — definitive sign that at least one input is
  not a density operator (the bound D ≤ 1 requires PSD + trace 1).
- The underlying `eighComplex` exceeded soft floors on reconstruction
  error, orthogonality error, or condition number — pass-through
  diagnostics from the eigh substrate.

The single output field `value` is *deliberately minimal* compared
to `trace-norm`'s `value + eigenvalues + condition_number`. The
eigenvalues here are of `ρ − σ`, which is a derived intermediate
matrix; a planner who wants those should call `trace-norm` on the
difference directly. Keeping `trace-distance` lean ensures the
type signature (`record → record{value, method, warnings}`)
narrows the registry-search planner cleanly to "compute the D
scalar."

**Boundary failures — tagged:**

```jsonc
{
  "kind": "tagged",
  "tag": "trace-distance/non-hermitian-input",
  "payload": {"kind": "record", "fields": {
    "which":          {"kind": "string", "value": "rho" | "sigma"},
    "row":            {"kind": "integer", "value": "<i>"},
    "col":            {"kind": "integer", "value": "<j>"},
    "violation":      {"kind": "string",  "value": "|M[i,j] − conj(M[j,i])|"},
    "max_violation":  {"kind": "string",  "value": "max|M − M†|"}
  }}
}
```

Returned when either input exceeds Hermiticity tolerance. The
`which` field names the offending input; the `(row, col)` locates
the worst pointwise violation. ρ is checked first.

```jsonc
{
  "kind": "tagged",
  "tag": "trace-distance/non-finite-input",
  "payload": {"kind": "record", "fields": {
    "which": {"kind": "string", "value": "rho" | "sigma"},
    "row":   {"kind": "integer", "value": "<i>"},
    "col":   {"kind": "integer", "value": "<j>"},
    "part":  {"kind": "string",  "value": "re" | "im"},
    "value": {"kind": "string",  "value": "NaN" | "Infinity" | "-Infinity"}
  }}
}
```

Returned on NaN / ±Inf in either input. `which` names the input,
`(row, col, part)` locate the bad cell.

```jsonc
{
  "kind": "tagged",
  "tag": "trace-distance/shape-mismatch",
  "payload": {"kind": "record", "fields": {
    "rho_n":   {"kind": "integer", "value": "<n_ρ>"},
    "sigma_n": {"kind": "integer", "value": "<n_σ>"}
  }}
}
```

Returned when ρ and σ have different square dimensions. The trace
distance is only defined between operators on the same Hilbert
space; embedding into a common dimension is the caller's
responsibility.

```jsonc
{
  "kind": "tagged",
  "tag": "trace-distance/degenerate-shape",
  "payload": {"kind": "record", "fields": {
    "which": {"kind": "string", "value": "rho" | "sigma"},
    "m": {"kind": "integer", "value": "<m>"},
    "n": {"kind": "integer", "value": "<n>"}
  }}
}
```

Returned when either input has `n = 0`. No matrices to compare.

**Malformed input — `ToolError` (exit 1):**

- `ρ.re` and `ρ.im` (or `σ.re` and `σ.im`) have disagreeing shapes
- non-square `ρ.re` or `σ.re`
- ragged rows in any list-of-lists

## How

The Hermitian case admits the **spectral characterisation** of the
trace norm:

```
‖M‖₁ = Σ_k |λ_k(M)|     for Hermitian M.       (Bhatia §IV.2)
```

The difference of two Hermitian matrices is Hermitian, so

```
D(ρ, σ) = ½ ‖ρ − σ‖₁ = ½ Σ_k |λ_k(ρ − σ)|.
```

The algorithm is

1. Decode `ρ.re, ρ.im, σ.re, σ.im` into flat `Float64Array(n²)`,
   folding in non-finite detection (→ tagged), degenerate-shape
   check, and `maxAbs` for the Hermiticity tolerance.
2. Validate `n_ρ = n_σ`; refuse via `shape-mismatch` tag otherwise.
3. Hermiticity gate on each input separately (separate `which` tag
   payloads).
4. Compute `M = ρ − σ` entry-wise (still Hermitian by linearity).
5. Call `eighComplex(M)`; sum `|λ_k|`; halve.

Out of scope (v0.1):

- Non-Hermitian inputs (e.g. operators that aren't density
  matrices). The general lane needs `linalg-svd-complex` (ADR-0035
  phase 2, filed under `ov4j`). When that ships, this tool will
  gain a soft-PSD-check that warns rather than refuses on non-PSD
  Hermitian inputs.

## Invariants

- **deterministic-per-platform**: same input bytes → same output
  bytes on a single platform; `numerical: true` (ADR-0015) records
  the platform fingerprint in provenance.
- **non-negative**: `value ≥ 0` for every successful run (Schatten
  norm is non-negative).
- **symmetry**: `D(ρ, σ) = D(σ, ρ)` — the trace norm is invariant
  under `ρ − σ ↔ σ − ρ` negation (eigenvalues sign-flip; absolute
  values unchanged).
- **identity-of-indiscernibles**: `D(ρ, ρ) = 0` — and conversely,
  `D = 0 ⇒ ρ = σ` (Schatten-1 separates points).
- **triangle-inequality**: `D(ρ, τ) ≤ D(ρ, σ) + D(σ, τ)` for any
  three density operators.
- **density-operator-upper-bound**: `D(ρ, σ) ≤ 1` for any two
  density operators (both PSD with trace 1).
- **orthogonal-pure-states-saturate**: `D(|ψ⟩⟨ψ|, |φ⟩⟨φ|) = 1` iff
  `⟨ψ|φ⟩ = 0`.
- **pure-vs-max-mixed**: `D(|ψ⟩⟨ψ|, I/d) = 1 − 1/d` for any pure
  state on a d-dimensional Hilbert space.
- **helstrom-distinguishing-probability** (informational): the
  maximum probability of distinguishing two equally-likely states
  ρ vs σ is `(1 + D(ρ, σ))/2`.
- **spectral-formula**: `D(ρ, σ) = (1/2) · Σ_k |λ_k(ρ − σ)|` — the
  algorithm's defining identity.
- **non-hermitian-tagged**: either input violating Hermiticity →
  `tagged "trace-distance/non-hermitian-input"` with `which` ∈
  `{"rho", "sigma"}`.
- **non-finite-tagged**: NaN or ±Inf in any input → `tagged
  "trace-distance/non-finite-input"` with `which`.
- **shape-mismatch-tagged**: `n_ρ ≠ n_σ` → `tagged
  "trace-distance/shape-mismatch"`.
- **degenerate-shape-tagged**: `n = 0` for either input → `tagged
  "trace-distance/degenerate-shape"`.
- **shape-mismatch-within-rejected**: `ρ.re ≠ ρ.im` or
  `σ.re ≠ σ.im` shapes → `ToolError`.
- **non-square-rejected**: non-square ρ or σ → `ToolError`.

## Run

```sh
# D(|0><0|, I/2) = 1/2 — pure vs maximally mixed
echo '{"kind":"record","fields":{
  "rho":   {"kind":"record","fields":{
    "re": {"kind":"list","items":[
      {"kind":"list","items":[{"kind":"float64","bits":"3ff0000000000000"},{"kind":"float64","bits":"0000000000000000"}]},
      {"kind":"list","items":[{"kind":"float64","bits":"0000000000000000"},{"kind":"float64","bits":"0000000000000000"}]}
    ]},
    "im": {"kind":"list","items":[
      {"kind":"list","items":[{"kind":"float64","bits":"0000000000000000"},{"kind":"float64","bits":"0000000000000000"}]},
      {"kind":"list","items":[{"kind":"float64","bits":"0000000000000000"},{"kind":"float64","bits":"0000000000000000"}]}
    ]}
  }},
  "sigma": {"kind":"record","fields":{
    "re": {"kind":"list","items":[
      {"kind":"list","items":[{"kind":"float64","bits":"3fe0000000000000"},{"kind":"float64","bits":"0000000000000000"}]},
      {"kind":"list","items":[{"kind":"float64","bits":"0000000000000000"},{"kind":"float64","bits":"3fe0000000000000"}]}
    ]},
    "im": {"kind":"list","items":[
      {"kind":"list","items":[{"kind":"float64","bits":"0000000000000000"},{"kind":"float64","bits":"0000000000000000"}]},
      {"kind":"list","items":[{"kind":"float64","bits":"0000000000000000"},{"kind":"float64","bits":"0000000000000000"}]}
    ]}
  }}
}}' | bun tools/trace-distance/tool.ts
```

## Standard flags

`--schema --examples --invariants --version --help --provenance-of <hash> --test --platform-fingerprint`
