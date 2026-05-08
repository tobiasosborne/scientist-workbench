# `meijer-g-asymptotic-only`

The Braaksma far-field asymptotic for the Meijer G-function
`G^{m,n}_{p,q}(z)` in the principal sector `|arg z| < π/2 − π/64`,
exposed as an isolated tool. Calls
`@workbench/meijer-core`'s `meijergAsymptotic` (ADR-0026); v0.1
ships the **algebraic dominant asymptotic** truncated at its
optimal index per Olver §3.7 ("superasymptotic").

When to reach for this tool over the Slater / contour siblings:

| Caller's situation | Right tool |
|---|---|
| Generic `(m, n, p, q, z)` with `|z|` away from 1 and `q ≥ p` | `meijer-g-slater-only` |
| `|z| ≈ 1` and `p = q` (Slater quarantine) | `meijer-g-contour-only` (forthcoming wire wrapper); for now use `@workbench/meijer-core::meijergContour` |
| `|z| ≫ p + q` AND `|arg z| < π/2 − π/64` | **this tool** |
| `|arg z| ≥ π/2 − π/64` (secondary sector / Stokes line) | refuse; hv0.10 dispatcher routes to contour quadrature |
| `|z| < 1` | refuse; route to Slater |

## Input

```jsonc
{
  "kind": "record",
  "fields": {
    "an": { "kind": "list", "items": [/* upper params, Γ(1−a+s) factors */] },
    "ap": { "kind": "list", "items": [/* upper params, Γ(a−s) factors  */] },
    "bm": { "kind": "list", "items": [/* lower params, Γ(b−s) factors  */] },
    "bq": { "kind": "list", "items": [/* lower params, Γ(1−b+s) factors */] },
    "z":  { /* bigcomplex */ }
  }
}
```

Each parameter is a `bigcomplex` (the protocol-encoded BigComplex
from `@workbench/bigfloat`). Length convention: `m = bm.length`,
`n = an.length`, `p = an.length + ap.length`,
`q = bm.length + bq.length`.

## Output

### Success

```jsonc
{
  "kind": "record",
  "fields": {
    "value":                 { /* bigcomplex */ },
    "achieved_precision":    { "kind": "integer", "value": "50" },
    "method":                { "kind": "string",  "value": "braaksma-algebraic" },
    "n_terms":               { "kind": "integer", "value": "120" },
    "optimal_term_indices":  { "kind": "list",    "items": [/* per-pole k* */] },
    "error_estimate":        { /* bigfloat: Σ_h |B_h z^{a_h-1} t_{k*+1}| */ },
    "sector":                { "kind": "string",  "value": "principal" },
    "working_precision":     { "kind": "integer", "value": "200" },
    "warnings":              { "kind": "list",    "items": [/* string warnings */] }
  }
}
```

### Refusals (each as `tagged` per ADR-0003)

| Tag | Meaning |
|---|---|
| `meijer-g-asymptotic-only/stokes-line` | `\|arg z\|` near `π/2 − π/64`; v0.1's algebraic-only answer is unreliable. |
| `meijer-g-asymptotic-only/secondary-sector` | `\|arg z\| > π/2 − π/64`; deferred to hv0.9.5. |
| `meijer-g-asymptotic-only/small-z` | `\|z\| < 1`; route to Slater. |
| `meijer-g-asymptotic-only/non-asymptotic-regime` | First-step ratio non-shrinking; not asymptotic at this `\|z\|`. |
| `meijer-g-asymptotic-only/no-pole-residues` | `n = 0`; right-closing residues unavailable. Symmetric n=0 case is hv0.9.4. |
| `meijer-g-asymptotic-only/input-error` | Invalid precision, or Γ-prefactor pole (no perturbation in v0.1). |

## How

Asymptotic regime: `|z| → ∞` in the principal sector. The Slater
Series 2 sums residues at the upper poles `s = a_h + k - 1`
(`h = 1..n`, `k = 0, 1, 2, …`) of the Mellin–Barnes integrand.
When `q ≥ p` this sum *converges*; when `p > q` it *diverges* but
is asymptotic in the Poincaré sense. Either way the optimal-
truncation rule (Olver §3.7) tells us where to stop: at the
index `k*` where the term magnitude is smallest. The error is
`~|t_{k*+1}|`.

We compute exactly this:

1. For each `h`, generate inner-pFq terms via the recurrence used
   by Slater Series 2's pFq sub-evaluator;
2. Find `k*_h` = index of the smallest term;
3. Multiply the partial sum by the Slater Series 2 prefactor
   `B_h · z^{a_h - 1}`;
4. Sum over `h = 1..n`.

Algorithmic citation: Braaksma 1964 (*Compositio Mathematica*
**15**: 239–341); Paris–Kaminski 2001 ch. 2; DLMF §16.11; Luke
1969 §5; Olver 1974 §3.7. ADR-0026 pins the v0.1 design in the
workbench.

## Invariants

- **deterministic**: same input bytes + same precision → same
  output bytes (`arbprec: true`).
- **principal-sector only**: `secondary-sector` / `stokes-line`
  refusals for inputs outside the v0.1 cap; never wrong-valued
  output.
- **small-z refusal**: `|z| < 1` ⇒ refuse, never wrong-valued.
- **n=0 refusal**: `n = 0` ⇒ refuse with `no-pole-residues`;
  the dual `|z| → 0` asymptotic is hv0.9.4.
- **method-agreement with Slater**: where both paths apply, the
  values agree to the user-stated precision modulo the asymptotic
  error estimate.

## Run

```sh
echo '<input json>' | bun tools/meijer-g-asymptotic-only/tool.ts --precision=50
```

## Standard flags

`--schema --examples --invariants --version --help --provenance-of <hash> --test --precision=N`

## See also

- `tools/meijer-g-slater-only` — Slater residue sum (the
  convergent-series sibling).
- `tools/meijer-g-symbolic-only` — Adamchik–Marichev symbolic
  dispatch.
- `packages/meijer-core` — the algorithmic substrate; this tool
  is a thin wire wrapper.
- `docs/adr/0026-meijerg-asymptotic.md` — design pin.
- `docs/worklog/077-meijerg-asymptotic.md` — shipping shard.
