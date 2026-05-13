# trace-norm

The Schatten-1 (nuclear / trace) norm `‖M‖₁` of a complex `n × n`
**Hermitian** matrix `M`, computed via the spectral characterisation

```
‖M‖₁ = Σ_k |λ_k(M)|       (Hermitian: |singular values| = |eigenvalues|)
```

The first deliverable of the qinfo v0.2 surface — the spectral
derivative of `linalg-eigh-complex` (ADR-0035 phase 1) that unblocked
it. The workhorse primitive for `trace-distance` (bead `k2xo`,
queued), `fidelity` (bead `2hxf`), and `purity` (bead `2czd`). v0.1
is Hermitian-only; the general (non-Hermitian) lane requires
`linalg-svd-complex` (ADR-0035 phase 2, filed) and is explicitly
deferred — density operators (the qinfo dogfood workload) are
Hermitian, so v0.1 covers the named use cases without compromise.

The output is *not just* the scalar `‖M‖₁` — it also surfaces the
eigenvalues, the spectral condition number, and warnings from the
underlying eigh. Downstream planners (trace-distance, fidelity, the
qinfo v0.2 quartet) compose against the same fixture, gating on the
spectrum directly when they need to.

## Why a planner reaches for this

- **Trace distance**: `T(ρ, σ) = ½ · ‖ρ − σ‖₁`. The optimal
  distinguishing-measurement bound between density operators
  (Helstrom's theorem). Every quantum-info statement about
  state distinguishability routes through this.
- **Fidelity bounds**: `1 − F(ρ, σ) ≤ T(ρ, σ) ≤ √(1 − F²)` —
  Fuchs–van de Graaf. The standard channel between
  operationally-meaningful state distances.
- **Channel norms**: when composed with `partial-trace` and
  `choi-iso`, the trace norm is the diamond-norm primitive for
  channel distinguishability (Watrous §3.3).

## Input

```jsonc
{
  "kind": "record",
  "fields": {
    "M": {
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

`M.re` and `M.im` are both `n × n` (square, same shape). Both fields
are **required** — see ADR-0035 §D2 for the required-`im` discipline.
A Hermitian matrix with no imaginary part still passes `M.im` as
all-zero `list<list<float64>>`; the substrate's cheap fall-through
path (block-diagonal embedding) handles that case efficiently.

Hermiticity is checked within tolerance `max|M − M†| ≤ 100·EPS·max|M|`
(same threshold as `linalg-eigh-complex`). Non-Hermitian inputs refuse
loudly via a tagged boundary; the SVD path (which generalises to
non-Hermitian) is filed under `ov4j` as phase 2.

The matrix is wrapped in a record `{M}` (rather than passed naked)
so the surface can grow additively — a future `hermitian?: boolean`
override, a future weight matrix, etc. — without schema-breaking
edits.

## Output

Three shapes (ADR-0003 categories).

**Happy path — record:**

```jsonc
{
  "kind": "record",
  "fields": {
    "value":            {"kind": "float64", ...},   // ||M||_1 (single scalar, >=0)
    "eigenvalues":      {"kind": "list", "items": [...]},   // length n, real, ascending
    "condition_number": {"kind": "float64", ...},
    "method":           {"kind": "string", "value": "hermitian-via-eigh-complex"},
    "warnings":         {"kind": "list", "items": [<strings>]}
  }
}
```

`value` is the trace norm `Σ_k |λ_k|`. Non-negative by construction.

`eigenvalues` is the real spectrum of `M`, sorted ascending — a
pass-through from the eigh substrate. Free of cost once the eigh has
run; useful as a downstream gate (e.g., "is `ρ` near a pure state?"
→ check whether `eigenvalues[n−1] ≈ 1`).

`condition_number` is `|λ_max| / |λ_min|` (or `1/EPS` clamp for the
indefinite / singular case) — same formula as `linalg-eigh`'s.

Warnings populated when:
- the eigh substrate's `reconstructionError > 1e-12`
- the eigh substrate's `orthogonalityError > 1e-12`
- `condition_number > 1e12` — the trace norm may have lost relative
  accuracy on small eigenvalues
- (eigh-inherited) scale advisories for `2n > 500` per ADR-0016.

**Boundary failures — tagged:**

```jsonc
{
  "kind": "tagged",
  "tag": "trace-norm/non-hermitian-input",
  "payload": {"kind": "record", "fields": {
    "row":            {"kind": "integer", "value": "<i>"},
    "col":            {"kind": "integer", "value": "<j>"},
    "violation":      {"kind": "string",  "value": "|M[i,j] − conj(M[j,i])|"},
    "max_violation":  {"kind": "string",  "value": "max|M − M†|"}
  }}
}
```

Returned when `max|M − M†| > 100·EPS·max|M|`. v0.1 refuses
deliberately — the SVD path that would handle non-Hermitian M
is `linalg-svd-complex` (ADR-0035 §D8 phase 2, filed under `ov4j`).
When that ships, this boundary will be subsumed: a `hermitian?:
boolean` flag (or auto-detection) will dispatch between the two
paths.

```jsonc
{
  "kind": "tagged",
  "tag": "trace-norm/non-finite-input",
  "payload": {"kind": "record", "fields": {
    "row":   {"kind": "integer", "value": "<i>"},
    "col":   {"kind": "integer", "value": "<j>"},
    "part":  {"kind": "string",  "value": "re" | "im"},
    "value": {"kind": "string",  "value": "NaN" | "Infinity" | "-Infinity"}
  }}
}
```

Returned when `M.re` or `M.im` contains `NaN` / `±Inf`. The
planner can identify which part holds the bad value.

```jsonc
{
  "kind": "tagged",
  "tag": "trace-norm/degenerate-shape",
  "payload": {"kind": "record", "fields": {
    "m": {"kind": "integer", "value": "<m>"},
    "n": {"kind": "integer", "value": "<n>"}
  }}
}
```

Returned when `n = 0`. No matrix to norm.

**Malformed input — `ToolError` (exit 1):**

- `M.re` and `M.im` have different `m × n`
- `M.re` is non-square (`m ≠ n`) — suggestion points at
  `linalg-svd-complex` when shipped
- ragged rows in `M.re` or `M.im`
- OOM on the `2n × 2n` embedded buffer (via
  `linalg-eigh-complex`'s OOM guard)

## How

The Hermitian case admits the **spectral characterisation** of the
trace norm:

```
‖M‖₁ := tr(√(M† M))     (general definition)
      = Σ_k σ_k(M)        (singular values; SVD)
      = Σ_k |λ_k(M)|      (Hermitian: singular values = |eigenvalues|)
```

The third equality (Bhatia §IV.2) is the algorithm: route to
`linalg-eigh-complex`, sum absolute values. ~30 lines of work after
the eigh; the rest is decode, Hermiticity check, encode.

Why this isn't `linalg-eigh-complex` with a `--norm` flag: the trace
norm is a *scalar* output that consumers want to compose with (the
downstream qinfo v0.2 quartet); a separate tool gives the planner an
explicit type signature (`record → record{value, eigenvalues, ...}`)
visible to `registry-search`. Method flag would hide that signature
in an enum.

The full substrate-side prose (the embedding identity, the spectrum
correspondence, the MGS cleanup for degenerate eigenspaces) lives in
`packages/linalg-core/src/eigh-complex.ts`; ADR-0035 §D5 covers the
design rationale.

Out of scope (v0.1):
- Non-Hermitian (general complex) `M` — filed as
  `linalg-svd-complex` (ADR-0035 phase 2 under `ov4j`).
- Other Schatten norms (`p = 2` = Hilbert–Schmidt = Frobenius;
  `p = ∞` = spectral norm). Each is a separate scalar consumer of
  the same eigh fixture; if a downstream workload asks, files
  cleanly.
- Operator-norm primitives for non-self-adjoint maps — `diamond
  norm` (CP map distinguishability) lives one composition higher
  (SDP-based; bead filed when needed).

## Invariants

- **deterministic-per-platform**: same input bytes → same output
  bytes on a single platform; `numerical: true` (ADR-0015) records
  the platform fingerprint in provenance.
- **non-negative**: `value ≥ 0` for every successful run.
- **identity-norm**: `‖I_n‖₁ = n` exactly.
- **homogeneity**: `‖cM‖₁ = |c| · ‖M‖₁` for real scalar `c` and
  Hermitian `M`.
- **triangle-inequality**: `‖A + B‖₁ ≤ ‖A‖₁ + ‖B‖₁`.
- **trace-bound**: `‖M‖₁ ≥ |tr(M)|` (the eigenvalue absolute sum
  bounds the eigenvalue sum).
- **density-operator-unity**: `‖ρ‖₁ = 1` for every density operator
  (`ρ ≥ 0`, `tr ρ = 1`).
- **hermitian-spectral-formula**: `‖M‖₁ = Σ_k |λ_k(M)|` for
  Hermitian `M` — Bhatia §IV.2.
- **non-hermitian-tagged**: `max|M − M†| > 100·EPS·max|M|` →
  `tagged "trace-norm/non-hermitian-input"`. Never silently
  Hermitian-symmetrised; never silently routed to SVD.
- **non-finite-tagged**: NaN or ±Inf in `M.re` or `M.im` →
  `tagged "trace-norm/non-finite-input"` with the offending
  coordinate.
- **degenerate-shape-tagged**: `n = 0` →
  `tagged "trace-norm/degenerate-shape"`.
- **shape-mismatch-rejected**: disagreeing `M.re` / `M.im` shapes
  raise `ToolError`.
- **non-square-rejected**: non-square `M.re` raises `ToolError` with
  the suggestion to use `linalg-svd-complex` when shipped.
- **diagnostic-pass-through**: the success record surfaces the eigh
  substrate's eigenvalues and condition number — pass-through
  diagnostics for downstream planners.

## Run

```sh
# Pauli Y: Hermitian; eigenvalues ±1; ||Y||_1 = 2.
echo '{"kind":"record","fields":{"M":{"kind":"record","fields":{"re":{"kind":"list","items":[
  {"kind":"list","items":[{"kind":"float64","bits":"0000000000000000"},{"kind":"float64","bits":"0000000000000000"}]},
  {"kind":"list","items":[{"kind":"float64","bits":"0000000000000000"},{"kind":"float64","bits":"0000000000000000"}]}
]},"im":{"kind":"list","items":[
  {"kind":"list","items":[{"kind":"float64","bits":"0000000000000000"},{"kind":"float64","bits":"bff0000000000000"}]},
  {"kind":"list","items":[{"kind":"float64","bits":"3ff0000000000000"},{"kind":"float64","bits":"0000000000000000"}]}
]}}}}}' | bun tools/trace-norm/tool.ts
```

## Standard flags

`--schema --examples --invariants --version --help --provenance-of <hash> --test --platform-fingerprint`
