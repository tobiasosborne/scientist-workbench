# `meijer-g-slater-only`

Wire-protocol surface for `@workbench/meijer-core`'s Slater
residue-summation path. Independent of the (forthcoming) top-level
`tools/meijer-g` dispatcher; useful for benching the Slater path in
isolation, for cross-validation against published closed forms, and
for routing inputs that are known to land in the Slater regime.

## I/O contract

```
input:  record { an: list<bigcomplex>,
                 ap: list<bigcomplex>,
                 bm: list<bigcomplex>,
                 bq: list<bigcomplex>,
                 z:  bigcomplex }

output (success):
        record { value: bigcomplex,
                 achieved_precision: integer,
                 method: string,                  // "slater-series-1" | "slater-series-2"
                 series_terms: integer,
                 perturbation_applied: boolean,
                 cancellation_digits_lost: integer,
                 working_precision: integer,
                 warnings: list<string> }

output (refusal): one of
        tagged "meijer-g-slater-only/quarantine-band"      record { reason }
        tagged "meijer-g-slater-only/non-convergent-pfq"   record { reason }
        tagged "meijer-g-slater-only/input-error"          record { reason }
```

`--precision=N` (decimal digits, default 50) is the standard
ADR-0020 arbprec flag.

The `(an, ap, bm, bq)` four-tuple split recovers `(m, n, p, q)` by
length: `m = bm.length`, `n = an.length`, `p = n + ap.length`,
`q = m + bq.length`.

## Examples

```sh
# G^{1,0}_{0,1}(_; 1 | 2)  =  2 · exp(-2)
echo '{
  "kind": "record",
  "fields": {
    "an": {"kind": "list", "items": []},
    "ap": {"kind": "list", "items": []},
    "bm": {"kind": "list", "items": [
      {"kind": "tagged", "tag": "bigcomplex", "payload": {"kind": "record", "fields": {
        "re": {"kind": "tagged", "tag": "bigfloat", "payload": {"kind": "record", "fields": {
          "mantissa": {"kind": "integer", "value": "1"},
          "exponent": {"kind": "integer", "value": "0"},
          "precision": {"kind": "integer", "value": "256"}}}},
        "im": {"kind": "tagged", "tag": "bigfloat", "payload": {"kind": "record", "fields": {
          "mantissa": {"kind": "integer", "value": "0"},
          "exponent": {"kind": "integer", "value": "0"},
          "precision": {"kind": "integer", "value": "256"}}}}}}}
    ]},
    "bq": {"kind": "list", "items": []},
    "z": {"kind": "tagged", "tag": "bigcomplex", "payload": {...}}
  }
}' | bun tools/meijer-g-slater-only/tool.ts --precision=30
```

(In practice, build inputs via `bigcomplexToValue` from
`@workbench/bigfloat` rather than hand-rolling JSON.)

## Refusal tagging

| Tag                                          | Meaning                                                                            |
|----------------------------------------------|------------------------------------------------------------------------------------|
| `meijer-g-slater-only/quarantine-band`       | `\|z\| ≈ 1` and `p == q == m + n` — neither Slater series converges in this band. |
| `meijer-g-slater-only/non-convergent-pfq`    | Inner pFq deferred to a future analytic-continuation revision.                    |
| `meijer-g-slater-only/input-error`           | `m == 0 ∧ n == 0` (no Γ-pole line to close around), or invalid precision dial.    |

Each refusal carries a `reason: string` field with the diagnostic
detail. Callers should route quarantine cases to the eventual
contour-quadrature layer (`hv0.8`); non-convergent-pfq cases to the
asymptotic layer (`hv0.9`).

## See also

* Algorithmic substrate: `packages/meijer-core/`.
* The brief: `tstournament/ts-bench-infra/problems/13-meijer-g/sub-problems/13c-meijerg-numerical-slater/DESCRIPTION.md`.
* The campaign worklog: `docs/worklog/070-meijer-core-slater.md`.
