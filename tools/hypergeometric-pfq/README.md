# hypergeometric-pfq

Arbitrary-precision generalised hypergeometric function `pFq(a₁,…,aₚ; b₁,…,b_q; z)`.
The first `arbprec: true` numerical-tier tool in scientist-workbench (ADR-0020);
the convergent inner series that `@workbench/meijer-core`'s Slater path and
Braaksma asymptotic path both consume. Returns not just a value but a full
agent-honest record carrying `achieved_precision`, `working_precision`,
`n_terms`, and `warnings` — everything a planner needs to decide whether to
trust the result or retry at higher precision.

Substrate: `@workbench/hypergeometric` (extracted worklog 070 so Slater can
share the evaluator without round-tripping through the value protocol). The
tool is a thin wire-protocol wrapper around `evaluatePFq`.

## Input

```jsonc
{
  "kind": "record",
  "fields": {
    "a": { "kind": "list", "items": [/* bigcomplex */] },  // p numerator params
    "b": { "kind": "list", "items": [/* bigcomplex */] },  // q denominator params
    "z": /* bigcomplex */                                    // argument
  }
}
```

Each `a_i`, `b_j`, and `z` is a `bigcomplex` encoded via `bigcomplexSchema`
from `@workbench/bigfloat`. `p = a.length`, `q = b.length` — the classic
classification is `pFq`.

Standard flag: `--precision=<int>` (decimal digits, default 50). The
`precision` value is part of the input identity: different precisions cache
to different output hashes.

## Output

Three shapes (ADR-0003 categories):

### Happy path — record

```jsonc
{
  "kind": "record",
  "fields": {
    "value":              /* bigcomplex — the pFq value at the requested precision */,
    "achieved_precision": { "kind": "integer", "value": "50"  },  // decimal digits confirmed
    "method":             { "kind": "string",  "value": "direct-series" | "closed-form-0F0" | "closed-form-1F0" | ... },
    "n_terms":            { "kind": "integer", "value": "240" },  // terms summed in the series
    "working_precision":  { "kind": "integer", "value": "180" },  // bits used internally
    "warnings":           { "kind": "list",    "items": [/* string */] }
  }
}
```

`achieved_precision` is the number of decimal digits the tool confirms (may
exceed `--precision` for easy cases; equals the requested floor on success).
`working_precision` reveals the internal precision bump applied by the
cancellation-driven retry logic. `n_terms` counts terms summed; for the
closed-form paths it is `0`.

### Boundary failure — tagged non-convergent

```jsonc
{
  "kind": "tagged",
  "tag": "hypergeometric-pfq/non-convergent",
  "payload": { "kind": "record", "fields": { "reason": { "kind": "string", "value": "..." } } }
}
```

Returned when the series does not converge in the accessible regime: `p = q+1`
with `|z| ≥ 0.99` (analytic continuation deferred), `p > q+1` and `|z| ≥ 1`
(asymptotic-only; use `meijer-g` dispatcher), or the iteration cap exhausted
at the requested working precision.

### Boundary failure — tagged parameter-pole

```jsonc
{
  "kind": "tagged",
  "tag": "hypergeometric-pfq/parameter-pole",
  "payload": { "kind": "record", "fields": {
    "which":     { "kind": "string",  "value": "b" },
    "which_idx": { "kind": "integer", "value": "0" }
  }}
}
```

Returned when a denominator parameter `b_j` is a non-positive integer: the
Pochhammer symbol `(b_j)_k` has a zero in the denominator at `k = -b_j`,
which makes the pFq undefined (or requires regularisation that the tool does
not attempt in v0.1).

## Convergence regime table

| Case | Behaviour |
|---|---|
| `p ≤ q` | Series converges for all `z ∈ ℂ`; computes to requested precision. |
| `p = q + 1`, `\|z\| < 0.99` | Convergent inside the unit disk (radius of convergence = 1); computes to requested precision. |
| `p = q + 1`, `\|z\| ≥ 0.99` | Deferred: `non-convergent` (analytic continuation via Pfaff/Euler/Bühring is v0.2). |
| `p > q + 1`, `\|z\| < 1` | Formal power series diverges; `non-convergent`. Route to `meijer-g` (asymptotic). |

## Algorithm

Direct power series (Pearson-Olver-Porter 2017 §3):

```
T_k = T_{k-1} · ∏_j (a_j + k − 1) / [(b_j + k − 1) · k]
pFq(a; b; z) = Σ_{k=0}^∞ T_k
```

accumulated in `BigInt`-backed `BigComplex` arithmetic at
`working_precision` bits. The outer driver tracks *cancellation* — the
ratio of peak partial-sum magnitude to final result magnitude — and bumps
`working_precision` by `1.5 × log2(cancellation)` bits when cancellation
is detected, then retries. This is the Pearson-Olver-Porter precision-bump
strategy; it ensures `achieved_precision` decimal digits survive the
subtraction.

Fast paths (closed-form, no series):

- **0F0(;;z) = exp(z)** — always.
- **1F0(a;;z) = (1−z)^{−a}** — for `|z| < 1`.

These activate when `p = q = 0` or `p = 1, q = 0`, short-circuiting the
series entirely. `method` field names the fast path.

## Determinism

`arbprec: true` (ADR-0020): bit-identical cross-platform forever given a
fixed `--precision=N`. `BigInt` arithmetic is specified by the ECMAScript
standard to be exact; no floating-point divergence is possible. Different
values of `--precision` cache to different output hashes (the precision
value is part of the tool's input identity).

## Validation

Bench corpus: `../scientist-workbench-corpus/benchmarks/hypergeometric-pfq/`
(migrated from `bench/hypergeometric-pfq/` per ADR-0028). 53-case golden
battery, 302 invariant assertions (worklog 079):

| Tier | Cases | Description |
|---|---|---|
| 0 — closed-form anchors | 11 | `0F0(;;z) = exp(z)` and `1F0(a;;z) = (1−z)^{−a}` at multiple `z` values |
| A — generic happy path | 15 | `1F1`, `2F1`, `2F0`, `3F2` at moderate `z` |
| B — large parameters | 10 | `a_j`, `b_j` ∈ {10…75}, tests numerical stability |
| C — near-unit-circle | 8 | `\|z\| ∈ {0.90, 0.95, 0.98}` where cancellation is severe |
| D — parameter coalescence | 5 | `a_i = b_j` (near-pole, Kummer-identity collapse) |
| E — refusal cases | 4 | `\|z\| ≥ 0.99` and `p = q+1`; `b_j` non-positive integer |

**Oracles:** mpmath at `dps = max(80, precision+30)` (primary) + Wolfram at
the same precision (cross-check). Agreement required at the per-case
`tolerance_rel` before any case is committed to `golden/expected.json`.

**Mutation-proven:** 5 perturbations (doubled truth → `value_accuracy` RED;
tag swapped for value → `boundary_envelope` RED; `1e-30` value perturbation
→ `value_accuracy` RED; over-reported `achieved_precision` → RED; unknown
`method` string → `method_admissible` RED). All 5 RED on mutated candidates,
GREEN on the canonical candidate.

**Wire tests:** 35 cases in `tools/hypergeometric-pfq/tool.test.ts`
covering closed-form fast paths, Kummer identities, and refusal envelopes.

## Substrate

`@workbench/hypergeometric` (worklog 070 refactor for `meijer-core::Slater`
sharing). `@workbench/meijer-core`'s Slater path calls `evaluatePFq` `m`
or `n` times per Meijer G invocation; round-tripping through the value
protocol on every inner call would dominate wall-clock. The in-process
surface keeps the same `arbprec: true` byte-identical contract (ADR-0012).

## Run

```sh
# 0F0(;;1) = e  at 50 digits
echo '{"kind":"record","fields":{"a":{"kind":"list","items":[]},"b":{"kind":"list","items":[]},"z":{"kind":"record","fields":{"re":{"kind":"string","value":"1"},"im":{"kind":"string","value":"0"}}}}}' \
  | bun tools/hypergeometric-pfq/tool.ts --precision=50
```

## Standard flags

`--schema --examples --invariants --version --help --provenance-of <hash> --test --precision=<int>`

## Pointers

- ADR-0020 — `arbprec: true` determinism tier; `--precision` standard flag.
- `docs/worklog/069-bigfloat-and-pfq-shipped.md` — initial hv0.3 ship.
- `docs/worklog/070-meijer-core-slater.md` — refactor that extracted
  `@workbench/hypergeometric` from the tool.
- `docs/worklog/071-bigfloat-exp-false-alarm-and-hardening.md` — bigfloat
  hardening work (exp precision edge cases).
- `docs/worklog/079-bench-hypergeometric-pfq.md` — the bench (hv0.4).
- `docs/worklog/084-bigfloat-div-precision-floor-fix.md` — bigfloat div
  precision-floor fix that affected pFq precision on near-coalescence cases.
- `packages/hypergeometric/` — the algorithmic substrate.
- Pearson, Olver, Porter (2017). "Numerical methods for the computation
  of the confluent and Gauss hypergeometric functions." *Numer. Algorithms*
  74 (2017), 821–866.
- Slater, *Generalized Hypergeometric Functions* (1966), §4.1.
- DLMF §16.2 (definition), §16.11 (asymptotic expansions).
