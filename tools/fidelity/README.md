# fidelity

The **Uhlmann fidelity** between two density operators ρ, σ on the
same d-dimensional Hilbert space:

```
F(ρ, σ) = (tr √(√ρ · σ · √ρ))²   ∈   [0, 1].
```

The operationally-meaningful state-overlap metric. `F = 1` iff
`ρ = σ`; `F = 0` iff ρ and σ have orthogonal support. For pure
states `F(|ψ⟩⟨ψ|, |φ⟩⟨φ|) = |⟨ψ|φ⟩|²` — the squared transition
amplitude. The **fourth and final** deliverable of the qinfo v0.2
surface, completing the trio with `trace-distance` and pairing
against it via the Fuchs–van de Graaf inequality
(Fuchs & van de Graaf 1999):

```
1 − √F(ρ, σ)   ≤   D(ρ, σ)   ≤   √(1 − F(ρ, σ)).
```

Demo-scope #26 exercises this inequality numerically — a probe
that exists because both `D` and `F` finally ship in the same
session.

## Why a planner reaches for this

- **State similarity** beyond what trace-distance measures. Trace
  distance saturates at 1 on a wide class of "very
  distinguishable" state pairs; fidelity discriminates among them
  more finely (it is strictly convex in the second argument).
- **Channel benchmarking.** `F(ρ_in, Φ(ρ_in))` is the standard
  metric for "how well does the channel Φ preserve ρ"; averaging
  over a state ensemble gives **process fidelity** (Bowdrey et al.
  2002) / **average fidelity** (Nielsen 2002).
- **Bures geodesic.** `arccos(√F) ∈ [0, π/2]` is the Riemannian
  geodesic distance on the space of density operators under the
  Bures metric. Surfaced as `bures_angle` in the output for
  consumers doing fidelity-loss optimisation.
- **Pure-state overlap.** For two pure states the formula reduces
  to `|⟨ψ|φ⟩|²` — the universally cited "how aligned are these
  state vectors" scalar.

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

Identical wire shape to `trace-distance`. Both `rho` and `sigma`
use the canonical complex-matrix wire shape (ADR-0035 §D2): `re`
and `im` both **required**, shape-matched, `n × n` square. The
v0.2 quartet shares one matrix wire convention.

Hermiticity is checked within tolerance `max|M − M†| ≤ 100·EPS·max|M|`
on each input separately (same threshold as `linalg-eigh-complex`).
Non-Hermitian inputs refuse via a tagged boundary that names which
input is bad. **Positive-semidefiniteness** is *not* a refusal —
the algorithm clamps near-zero negative eigenvalues to 0 and
warns on hard-negative violations beyond `1e-9 · max|λ|`. This is
a conservative honest-scope choice: callers using `fidelity` as a
diagnostic on "almost-density" matrices get a useful answer with
a warning rather than a refusal.

## Output

Three shapes (ADR-0003 categories).

**Happy path — record:**

```jsonc
{
  "kind": "record",
  "fields": {
    "value":       {"kind": "float64", ...},  // F(ρ, σ) ∈ [0, 1]
    "sqrt_value":  {"kind": "float64", ...},  // √F — Bhattacharyya overlap
    "bures_angle": {"kind": "float64", ...},  // arccos(√F) ∈ [0, π/2] radians
    "method":      {"kind": "string", "value": "hermitian-eigh-spectral-sqrt"},
    "warnings":    {"kind": "list", "items": [<strings>]}
  }
}
```

- `value` is the scalar `F(ρ, σ)`. Non-negative by construction;
  in `[0, 1]` for valid density operators.
- `sqrt_value` is `√F`. Useful as the Bhattacharyya overlap and as
  the input to the Fuchs–van de Graaf bounds. Cost: one
  `Math.sqrt` after F. Surfaced because *every* downstream
  consumer of fidelity also wants `√F`.
- `bures_angle` is `arccos(min(1, √F))` in radians — the
  Riemannian geodesic distance under the Bures metric. The
  `min(1, √F)` guards against floating-point `√F = 1 + 1e-16`
  producing `NaN` from `arccos`.
- `method` is the literal string `"hermitian-eigh-spectral-sqrt"`,
  distinguishing this from a future Block-encoding or
  variational-fidelity path.

Warnings populated when:

- `|tr(ρ) − 1| > 1e-9` or `|tr(σ) − 1| > 1e-9` — input may not be
  a valid density operator.
- `value > 1 + 1e-9` — definitive sign at least one input is not
  PSD-with-trace-1 (the bound F ≤ 1 requires this).
- ρ or `√ρ·σ·√ρ` has an eigenvalue below `−1e-9 · max|λ|` —
  hard-negative PSD violation. Computation proceeds with the
  negative-eigenspace contribution clamped to 0.
- Underlying `eighComplex` exceeded soft floors on reconstruction
  or orthogonality error.

**Boundary failures — tagged** (same set as `trace-distance`):

- `fidelity/non-hermitian-input` with `which ∈ {"rho", "sigma"}`.
- `fidelity/non-finite-input` with `which`.
- `fidelity/shape-mismatch` with `(rho_n, sigma_n)`.
- `fidelity/degenerate-shape` with `which`.

**Malformed input — `ToolError` (exit 1):**

- `ρ.re` and `ρ.im` (or `σ.re` and `σ.im`) have disagreeing shapes
- non-square `ρ.re` or `σ.re`
- ragged rows

## How

The Uhlmann formula `F(ρ, σ) = (tr √(√ρ · σ · √ρ))²` admits a
clean spectral algorithm because every intermediate matrix is
Hermitian PSD whenever ρ and σ are:

1. **Decode** ρ and σ (Hermitian-check + non-finite-check +
   shape-mismatch + degenerate-shape gates).
2. **Spectral √ρ.** Run `eighComplex(ρ)` ⇒ `ρ = Q · diag(λ) · Q†`.
   Build `√ρ = Q · diag(√max(λ, 0)) · Q†`. Negative-eigenvalue
   clamp handles near-PSD round-off; hard negatives warn.
3. **Inner matrix.** Compute `M = √ρ · σ · √ρ` via two complex
   matmuls. Hermitian PSD by construction when both inputs are
   PSD; the sandwich preserves Hermiticity even when σ is only
   Hermitian.
4. **Spectral trace-of-sqrt.** Run `eighComplex(M)` ⇒ eigenvalues
   μ_k. For a Hermitian PSD M, `tr √M = Σ_k √μ_k`. Same
   PSD-clamp discipline as step 2.
5. **Square.** `F = (Σ_k √max(μ_k, 0))²`.

Total cost: three `eighComplex` calls + two `complexMatmul`s,
each `O(n³)`. The heaviest of the qinfo v0.2 trio, but still a
thin tool on the existing substrate.

**Why spectral, not iterative.** Newton iteration for the matrix
square root converges quadratically but requires solving a linear
system at each step; the spectral path is one O(n³) eigh and is
exact (up to eigh accuracy) without iteration tolerances.
Spectral wins on small-to-medium n; iterative becomes attractive
only for n where the eigh cost dominates (n ≳ 10³).

**Why not call `trace-norm` on the inner matrix.** For Hermitian
PSD M, `‖M‖₁ = tr M = Σ λ` (since all eigenvalues are non-
negative). But we want `tr √M = Σ √λ`, not the trace norm of M.
Calling `trace-norm` on M would give `Σ λ`, not `Σ √λ`. The
"trace-of-square-root" computation is intrinsically eigh-based;
trace-norm is a different consumer of the same eigh.

Out of scope (v0.1):

- Non-Hermitian inputs. Density operators are Hermitian by
  definition; if a workload asks for fidelity of a non-Hermitian
  operator, the question is ill-posed.
- Newton-iteration matrix square root for large n.
- Process / average fidelity (these are caller-side compositions
  over an ensemble of states).

## Invariants

- **deterministic-per-platform**: same input bytes → same output
  bytes on a single platform; `numerical: true` (ADR-0015) records
  the platform fingerprint in provenance.
- **non-negative**: `value ≥ 0` for every successful run.
- **symmetry**: `F(ρ, σ) = F(σ, ρ)` — Uhlmann's theorem proves
  symmetry despite the asymmetric definition (Watrous §3.2).
- **identity**: `F(ρ, ρ) = 1` for any density operator ρ.
- **density-operator-upper-bound**: `F(ρ, σ) ≤ 1`; saturated iff
  `ρ = σ`.
- **pure-pure-overlap**: `F(|ψ⟩⟨ψ|, |φ⟩⟨φ|) = |⟨ψ|φ⟩|²`.
- **pure-vs-max-mixed**: `F(|ψ⟩⟨ψ|, I/d) = 1/d` for any pure
  state on a d-dimensional Hilbert space.
- **orthogonal-pure-states-zero**: `F = 0` iff `⟨ψ|φ⟩ = 0`.
- **fuchs-van-de-graaf-lower**:
  `1 − √F(ρ, σ) ≤ D(ρ, σ)` — pairs against `tools/trace-distance`.
- **fuchs-van-de-graaf-upper**:
  `D(ρ, σ) ≤ √(1 − F(ρ, σ))` — likewise.
- **bures-angle-range**: `bures_angle ∈ [0, π/2]`; equals 0 iff
  `F = 1`, equals π/2 iff `F = 0`.
- **uhlmann-spectral-formula**: `F = (Σ √max(μ_k, 0))²` where μ
  is the spectrum of `√ρ σ √ρ`.
- **non-hermitian-tagged**, **non-finite-tagged**,
  **shape-mismatch-tagged**, **degenerate-shape-tagged** — same
  envelope as `trace-distance`.
- **psd-clamp-warned**: negative eigenvalues below `−1e-9·max|λ|`
  in either ρ or M = √ρσ√ρ raise a soft warning; computation
  proceeds with the negative eigenspace contributing 0.
- **non-square-rejected**: non-square ρ or σ → `ToolError`.

## Run

```sh
# F(|0><0|, I/2) = 1/2 — pure vs maximally mixed
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
}}' | bun tools/fidelity/tool.ts
```

## Standard flags

`--schema --examples --invariants --version --help --provenance-of <hash> --test --platform-fingerprint`
