# special-eval

The umbrella per-head arb-prec / float64 evaluator for the Erf family,
covering the wire surface defined by ADR-0040 §"Decision 7". One tool
dispatches across six closed-vocabulary heads — `Erf`, `Erfc`, `Erfcx`,
`Erfi`, `InverseErf`, `InverseErfc` — and across two determinism tiers
(float64 / arb-prec) behind a single `--head=<name>` flag. The
agent's mental model is "give me Erf at this argument, this precision";
the cross-tier dispatch and the per-head substrate dispatch live behind
the same wire schema.

This is the v0.1 instantiation of the per-head substrate pattern; future
heads (Bessel, Whittaker, ParabolicCylinder, Legendre family) plug into
the same umbrella additively.

## Input

```jsonc
{
  "kind": "record",
  "fields": {
    "head": {"kind": "string", "value": "Erf"},
    "args": {                                       // either a real list
      "kind": "list",
      "items": [{"kind": "float64", "bits": "..."}]
    }
  }
}
```

Or for complex evaluation:

```jsonc
{
  "kind": "record",
  "fields": {
    "head": {"kind": "string", "value": "Erf"},
    "args": {
      "kind": "record",
      "fields": {
        "re": {"kind": "list", "items": [{"kind": "float64", "bits": "..."}]},
        "im": {"kind": "list", "items": [{"kind": "float64", "bits": "..."}]}
      }
    }
  }
}
```

Every v0.1 head is arity 1, so the `args` list (real) or `re` / `im`
parallel lists (complex) contain exactly one entry. The list-of-args
shape preserves the door for future multi-parameter heads
(`BesselJ(order, argument)`) without breaking the wire.

## Output

Three shapes (ADR-0003 categories):

### Happy path — record

```jsonc
{
  "kind": "record",
  "fields": {
    "value":               <bigfloat | bigcomplex tagged value>,
    "method":              {"kind": "string", "value": "erf-sunpro-1993" | "erf-borel-series-or-asymptotic" | "erf-karbach-weideman" | "erf-faddeeva-johnson" | "erf-blair-1976-inverse"},
    "achieved_precision":  {"kind": "integer", "value": "53" | "<bits>"},
    "warnings":            {"kind": "list", "items": [<strings>]}
  }
}
```

`achieved_precision` is the bits-of-precision actually delivered. At
`--precision ≤ 15` (decimal) it is `53` (float64 lane); at `--precision
> 15` it is the corresponding binary precision (e.g. `--precision=50`
gives `197` bits via `ceil(50 * log2(10)) + 30` safety margin).

`method` is the algorithmic-lineage tag (an audit-trail surface for a
planner's downstream debugging):

- `erf-sunpro-1993` — float64 real Erf / Erfc / Erfcx / Erfi (Sun
  Microsystems 1993 algorithm; the canonical libm Erf reference; ≤ 1 ULP
  `erf`, ≤ 2 ULP `erfc`).
- `erf-faddeeva-johnson` — float64 complex via `w(z)` (Stephen Johnson
  2012; MIT-licensed Faddeeva.cc port).
- `erf-blair-1976-inverse` — float64 inverses (Blair-Edwards-Johnson
  1976 rational approximants).
- `erf-borel-series-or-asymptotic` — arb-prec real lane (Arb-style
  series/asymptotic dispatch on the derived crossover
  `x_c(prec) = √(prec · ln 2)`; series uses DLMF 7.6.2 Borel form).
- `erf-karbach-weideman` — arb-prec complex (Karbach 2014 /
  Weideman-Fourier with closed-form `(τ_m, N)` precision-scaling).

The `value` field is a `tagged "bigfloat"` (real) or `tagged "bigcomplex"`
(complex) — both encodings of ADR-0020's arb-prec value protocol. The
float64 lane wraps its result in a 53-bit BigFloat so the wire schema
is uniform across tiers.

### Boundary failure — tagged

Four refusal classes:

```jsonc
{"kind": "tagged", "tag": "special-eval/unknown-head",
 "payload": {"kind": "record",
             "fields": {"head": {"kind": "string", "value": "BesselJ"},
                        "admitted": {"kind": "list",
                                     "items": [{"kind": "string", "value": "Erf"}, ...]}}}}
```

```jsonc
{"kind": "tagged", "tag": "special-eval/non-finite-input",
 "payload": {"kind": "record",
             "fields": {"which": {"kind": "string", "value": "args[0]"},
                        "value": {"kind": "string", "value": "NaN" | "Infinity" | "-Infinity"}}}}
```

```jsonc
{"kind": "tagged", "tag": "special-eval/degenerate-shape",
 "payload": {"kind": "record",
             "fields": {"detail": {"kind": "string", "value": "..."}}}}
```

```jsonc
{"kind": "tagged", "tag": "special-eval/no-known-representation",
 "payload": {"kind": "record",
             "fields": {"head": {"kind": "string", "value": "InverseErf"},
                        "axis": {"kind": "string", "value": "complex" | "real"},
                        "reason": {"kind": "string", "value": "..."}}}}
```

- `unknown-head` — `head` is not in the v0.1 Erf-family vocabulary.
- `non-finite-input` — NaN or ±Inf in any args slot.
- `degenerate-shape` — args list length doesn't match head arity, OR
  complex `re` / `im` list lengths don't match each other.
- `no-known-representation` — caller requested arb-prec InverseErf /
  InverseErfc (Phase 2 substrate gap — Newton-on-bigErf wasn't shipped),
  OR caller requested complex InverseErf / InverseErfc at any precision
  (multi-valued Riemann surface; R3 §3 — SciPy, Boost, Julia all
  decline).

### Malformed input — `ToolError` (exit 1)

- Input record missing `head` or `args` field.
- `precision` flag not a positive integer.
- args record missing `re` / `im` fields, or those fields are not
  `list<float64>`.

## How — per-head per-tier dispatch table

| head | real float64 | real arb-prec | complex float64 | complex arb-prec |
|---|---|---|---|---|
| `Erf`         | `erfFloat64` | `bigErf` | `erfComplexFloat64` | `bigCErf` |
| `Erfc`        | `erfcFloat64` | `bigErfc` | `erfcComplexFloat64` | `bigCErfc` |
| `Erfcx`       | `erfcxFloat64` | `bigErfcx` | `erfcxComplexFloat64` | `bigCErfcx` |
| `Erfi`        | `erfiFloat64` | via `bigCErfi` | `erfiComplexFloat64` | `bigCErfi` |
| `InverseErf`  | `erfInvFloat64` | refuse | refuse | refuse |
| `InverseErfc` | `erfcInvFloat64` | refuse | refuse | refuse |

Real arb-prec Erfi routes through `bigCErfi(x + 0i)` and takes the real
part — the substrate doesn't ship a separate `bigErfi` because the
identity `Erfi(x) = Im of bigCErfi result on the imaginary axis` makes
it redundant.

### Per-output tier dispatch

`--precision ≤ 15` (decimal digits) routes the float64 lane; `> 15`
routes the arb-prec lane. The output is always encoded as a `bigfloat` /
`bigcomplex` so the wire schema is uniform across tiers. The agent's
planner reads `achieved_precision` to discover the live tier:
`achieved_precision == 53` means float64; `> 53` means arb-prec.

This is the per-output tier conditioning ADR-0040 §"Decision 9" pins —
same tool, different-tier outputs on different precision flag values.
The default precision is `50` (decimal digits, the ADR-0020 default),
which routes arb-prec.

## Determinism tier — `arbprec: true`

This tool is annotated `arbprec: true` (ADR-0020): bit-deterministic
cross-platform forever given an explicit `--precision=<int>` flag.
`BigInt` arithmetic is bit-identical across every JavaScript runtime by
language specification, so the substrate inherits the strongest
determinism contract the workbench has.

Note: ADR-0040 §"Decision 9" describes the ideal tool annotation as
`{ numerical: true, arbprec: true }` (per-output tier conditioning).
The runner's mutex (`executeToolDef`) admits at most one of these flags
today; the practical resolution is the single `arbprec: true`
annotation. At `--precision ≤ 15` the underlying float64 substrate is
platform-conditional (ADR-0015), but the BigFloat encoding that wraps
it normalises to a bit-identical wire payload on any single platform
— a future ADR can lift the mutex to support per-output tier
conditioning across both flags simultaneously.

## Invariants

Each invariant is asserted by the `--test` hook:

- **arbprec-deterministic-cross-platform** — Same input bytes +
  `--precision` → byte-identical output on any runtime / arch / os
  (ADR-0020).
- **tier-dispatch-by-precision-flag** — `--precision ≤ 15` routes
  float64; `> 15` routes arb-prec. `achieved_precision` discloses the
  live tier.
- **honest-no-known-representation** — Complex InverseErf /
  InverseErfc refuse always (R3 §3); arb-prec InverseErf / InverseErfc
  refuse at `--precision > 15` (Phase 2 substrate gap); float64 real
  InverseErf / InverseErfc remain available.
- **parity-real-arbprec** — `bigErf(-x, prec) == -bigErf(x, prec)`
  byte-identically (DLMF §7.4.1).
- **erfc-plus-erf-identity** — `bigErf(x, prec) + bigErfc(x, prec)
  == 1` byte-identically (the substrate's I2 guarantee, worklog 135).
- **restriction-to-real-axis** — `bigCErf(x + 0i, prec).re` agrees
  with `bigErf(x, prec)` to ≥ `prec - 8` bits; `.im` is zero by
  construction (load-bearing real ↔ complex cross-tier consistency).
- **non-finite-input-tagged** — NaN / ±Inf in any args slot →
  tagged `special-eval/non-finite-input` — never silent wrong value.
- **unknown-head-tagged** — head outside the v0.1 vocabulary →
  tagged `special-eval/unknown-head` with the admitted list.
- **degenerate-shape-tagged** — complex args with mismatched re/im
  list lengths → tagged `special-eval/degenerate-shape` — never a
  silent zero-fill.

## Run

```sh
# Default: precision 50 decimal digits (arb-prec lane)
echo '{"kind":"record","fields":{
  "head":{"kind":"string","value":"Erf"},
  "args":{"kind":"list","items":[{"kind":"float64","bits":"3fe0000000000000"}]}
}}' | bun tools/special-eval/tool.ts

# Explicit high-precision arb-prec
echo '{"kind":"record","fields":{
  "head":{"kind":"string","value":"Erfc"},
  "args":{"kind":"list","items":[{"kind":"float64","bits":"4034000000000000"}]}
}}' | bun tools/special-eval/tool.ts --precision=200

# Complex Erf at z = 1 + i
echo '{"kind":"record","fields":{
  "head":{"kind":"string","value":"Erf"},
  "args":{"kind":"record","fields":{
    "re":{"kind":"list","items":[{"kind":"float64","bits":"3ff0000000000000"}]},
    "im":{"kind":"list","items":[{"kind":"float64","bits":"3ff0000000000000"}]}
  }}
}}' | bun tools/special-eval/tool.ts --precision=50

# Float64 lane (precision ≤ 15 routes float64)
echo '{"kind":"record","fields":{
  "head":{"kind":"string","value":"InverseErf"},
  "args":{"kind":"list","items":[{"kind":"float64","bits":"3fe0000000000000"}]}
}}' | bun tools/special-eval/tool.ts --precision=10
```

## Out of scope (v0.1, all deliberate)

- **Real arb-prec InverseErf / InverseErfc.** Phase 2 substrate gap;
  Newton-on-bigErf was spec'd in I5 but deferred. The float64 path
  remains available; future bead with a concrete consumer can lift.
- **Complex InverseErf / InverseErfc at any precision.** Multi-valued
  Riemann surface; no canonical computational form. R3 §3.
- **Future heads (Bessel, Whittaker, …).** The substrate pattern is
  reusable; per-head ADRs cover each. The wire surface is additive —
  a new head is one row in the dispatch table plus its substrate.
- **Multi-parameter heads (`BesselJ(order, argument)`).** The args
  list/record shape supports them by construction; only the dispatch
  table needs extension.

## Standard flags

`--head=<name> --precision=<int> --schema --examples --invariants
--version --help --provenance-of <hash> --test --platform-fingerprint`

`--precision=<int>` (decimal digits, default 50, min 1, max 100_000) is
the standard ADR-0020 flag inherited from the runner. The provenance
record captures it as part of the input identity, so different
precisions cache to different output hashes.

## References

- **ADR-0040** — Per-head special-function substrate + bidirectional
  Meijer-G bridge. The architectural rationale; §"Decision 7" is this
  tool's spec.
- **ADR-0020** — Arbitrary-precision tier (`arbprec: true` +
  `--precision`).
- **ADR-0015** — Numerical tier (the float64 lane's underlying
  contract).
- **ADR-0023** — Closed-vocabulary special-function table.
- **R1**–**R5** under `docs/refs/erf-research/` — the five-axis
  research record (symbolic / arb-prec / float64 / Meijer bridge /
  oracles).
- **Substrate packages:** `@workbench/bigfloat` (arb-prec); 
  `@workbench/quadrature` (float64).

## Closes

Bead `scientist-workbench-d6s`'s scope for the Erf head (per-head
arbprec evaluator umbrella, P2 — per ADR-0040 §"Decision 7"). The
substrate pattern generalises to every future head admitted to the
ADR-0023 vocabulary; this tool is the umbrella they all plug into.
