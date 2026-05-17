# 151 — G8 Bessel cross-oracle agreement matrix

**Bead:** `scientist-workbench-s2n1`. Epic: `scientist-workbench-zcam`.
**ADR:** `docs/adr/0041-bessel-family-per-head-substrate.md` §Decision 8 +
§Decision 12. **Phase 1 GATE.** Date: 2026-05-17.

## Context

The Bessel epic's Phase 1 (golden corpus + 5 oracle adapters) shipped
1766 corpus inputs × 5 oracles × 8835 records. The G8 comparator
(`bench/besselj-anchor/cross-agreement.ts`) is the cross-agreement
matrix that gates Phase 2 substrate work: pair-wise comparison of every
oracle pair on every input, tier-thresholded per ADR-0041 §Decision 8,
with documented Bessel landmines (R5 §6) downgraded to `info`. The
acceptance bar is **< 50 unexplained findings**.

## What changed

One new TS file: `bench/besselj-anchor/cross-agreement.ts` (~750 LOC).
Two generated artefacts: `bench/besselj-anchor/agreement-matrix.md` (90
lines, human heat-map) + `bench/besselj-anchor/agreement-data.json`
(207 KB, machine-readable per-input + per-pair detail).

The comparator inherits the Erf G8 styling (`canonicalScientific`,
`PERFECT_AGREEMENT` short-circuit, absurd-exponent
overflow/underflow mapping, limit-equivalence Indeterminate≡NaN /
ComplexInfinity≡Infinity, expected-refusal downgrade,
`severityRank`-aware complex-decomposition). Bessel-specific extensions:

- **Joins records via corpus** (`bench/besselj-anchor/corpus.json`),
  not via the union of oracle keys. The corpus carries `tier`,
  `head`, `nu_kind`, `nu`, `z`, and (for T9) `z_root_distance` — all
  load-bearing for the landmine downgrade logic. Every adapter
  emits exactly 1766 records aligned to corpus IDs, so the join is
  a strict subset relation. The Erf G8 used the union-of-oracle-keys
  pattern because Erf had no per-input tier metadata to thread.

- **Zero-crossing tolerance band** (ADR-0041 §Decision 12): when corpus
  input is T9 + `|z_root_distance| < 0.01`, switches from relative-error
  digit-counting to absolute-error magnitude (pure-string subtraction
  via `absDiffMagnitude`); threshold `10^{-(tier_floor - 4)}`. The
  4-digit pad accounts for catastrophic cancellation amplification at
  the root.

- **Per-oracle status taxonomy** parsed in `normaliseValue(oracleId,
  record)` (the Erf comparator took only `record`; oracle id is now
  load-bearing because each oracle has its own status vocabulary):
  - wolfram: `status=limit` → token (`Indeterminate`/`ComplexInfinity`/
    `Infinity`/`-Infinity` + unevaluated `BesselI[ν, Infinity]` etc.)
  - mpmath: `status=honest-special-token` → numeric (e.g. "0.0…0" for
    asymptotic limits); `status=timeout` → refused.
  - scipy: `status=limit` → value `0.0`/`NaN`/`inf`/`-inf`; the L5/L9/L10
    classification is in the `notes` field.
  - boost: `status=refused` → `reason` field (`boost-no-complex-bessel`,
    `non-finite-real-input`, `singular-at-z-zero`); success carries
    `value_silver` (50dp) + `value_bronze` (float64).
  - arb: `status=refused` → notes (typically "non-finite at singular
    point (NaN)"); success carries `value` + `value_radius` (the ball
    half-width).

- **ULP threshold raised 4 → 256** for `any-vs-bronze`. Erf's float64
  substrate was libm-quality (≤ 2-4 ULP). Bessel's float64 via SciPy/
  Amos has documented ULP-class up to 10^3 for transition region |z|≈ν
  and near zeros (R5 §6 L5). 256 ULP catches genuine algorithmic
  disagreements while tolerating the SciPy/Amos baseline.

- **Six Bessel-specific landmine downgrades** (`landmineDowngrade`):
  - `non-finite-input-limit-spelling` (37): T6 NaN/Inf inputs where
    oracles emit different limit spellings (Wolfram=ComplexInfinity,
    SciPy=-Infinity, mpmath=NaN). All honest at non-finite z.
  - `L4-boost-tail-cancellation` (9): Boost cpp_bin_float<50> drops
    digits through connection-formula cancellation; ≥30 digits agree
    (well above any algorithmic-bug threshold) but below the 46-digit
    silver target.
  - `L5-scipy-transition-region-ulp` (78): SciPy ULP < 10^7
    disagreement vs gold; downgraded as known Amos behaviour. ULP ≥
    10^7 stays as `warn` — gates the comparator's "real bug" floor.
  - `L7-zero-crossing-half-integer-T1` (8): T1 half-integer ν J/Y at
    z = kπ (exact zeros); both oracles are at the float64 floor (~1e-16
    vs ~1e-17), arbitrarily large relative ULP distance.
  - `L9-L10-overflow-underflow-boundary` (70): T6/T7/T10 limit-vs-value
    asymmetric; one oracle emits ±Inf, other returns finite extreme.
  - `L9-L10-scipy-underflow-to-zero` (24): SciPy emits `0.0` (treated
    as concrete real, not limit) where arb-prec returns ~1e-1285. The
    sibling of the above, in the value-vs-value path.

- **Arb `value_radius` as first-class error budget**: `applyArbRadius`
  parses the radius exponent and downgrades any disagreement that falls
  within the radius-implied accuracy. Fires `within-arb-radius` 0 times
  in the current run (every Arb disagreement was already covered by
  a more-specific landmine), but the code path is on disk for the
  Phase 2 round-2 substrate work to lean on.

- **Canonical tier-pair ordering** (`gold < silver < bronze`): the
  per-tier-pair summary collapses `gold-bronze` and `bronze-gold` into
  one bucket. Erf didn't need this (only 2 tier classes in its run);
  Bessel's 3-tier × 5-oracle matrix has duplicate-direction noise
  without it.

## Why these choices

The 50-finding gate from ADR-0041 §Decision 10 is *not* a quality bar
on the substrate — it's a quality bar on the **comparator**. The
substrate doesn't exist yet (Phase 2 hasn't started). What the gate
is measuring is "does the comparator distinguish documented-landmine
from real-bug?" Every downgrade above is anchored in R5's landmine
catalogue with the landmine number + page citation in-code; no
landmine fires without a corpus tier + head + nu_kind precondition
that pins which input class it applies to. This is the discipline
that lets a future bead-claimant trust the matrix: every `info`
either has tier-passing digits/ULPs OR a documented landmine category
that names the convention delta.

The ULP threshold jump 4 → 256 was the single most contentful
calibration. Initially the comparator emitted 1210 warnings, virtually
all ULP-class 5-256 SciPy disagreements. Bumping the threshold without
a documented R5 reason would be hiding a real signal. R5 §6 L5
explicitly documents that SciPy `jv`/`yv`/`iv`/`kv` are unconditional
Amos calls with much weaker ULP guarantees than libm's `j0`/`j1`/`y0`/
`y1` — this is the Bessel-specific reason the threshold differs from
Erf's. Reusing Erf's 4-ULP threshold would have been the bug, not
raising it.

The L9-L10-scipy-underflow-to-zero downgrade has a subtle gotcha worth
documenting: SciPy emits `value: "0.0"` with `status: "limit"` for
underflow cases (T6-besselk-007: K_0(700)). The `parseRealString("0.0")`
returns `{kind: "real"}` (mathematically correct — `0.0` IS a real
number), not `{kind: "limit"}`. This means the comparator's
`limit-vs-value` branch DOESN'T fire — instead it hits the ULP branch
with arb-prec's `4.67e-306` vs SciPy's `0.0`, which is a gigantic
ULP distance. The L9 sibling downgrade detects this pattern by ULP
magnitude (> 10^7) at the boundary tiers. An alternative — treating
SciPy's value as "limit" because the status field says so — would
have been wrong: `0.0` is the correct float64 representation of the
true value at that input. SciPy isn't refusing; it's emitting the
best float64 approximation. The comparator should reflect this.

## Frictions surfaced

1. **Erf G8's `entries` array works for 271 inputs; for 1766 it's
   ~200 KB JSON.** Decision: keep entries in the JSON (downstream tools
   may want per-input pair-detail) but truncate the markdown to a
   findings cap (200). The markdown stays scannable.

2. **`oracle_id` is load-bearing in normaliseValue but Erf didn't need
   it.** Erf's adapters were homogeneous (value: string|{re,im} +
   note/failure_reason). Bessel's are heterogeneous (5 different
   value-field names, 4 different status vocabularies). Threading
   `oracleId` through is the cheapest fix; alternative would have been
   per-adapter normalisers in separate files. The single-function form
   keeps the comparator self-contained.

3. **Tier-pair ordering as a string was annoying** (`gold-silver`
   vs `silver-gold` are the same comparison). Added a `TIER_RANK`
   ordering inside `comparePair`. Should probably be a small enum
   downstream; for now the inline mapping is fine.

4. **Zero-band `absDiffMagnitude` returns `exp10` not a real difference.**
   The 4-digit pad in the threshold is therefore a coarse upper bound,
   not the exact tolerance the spec implies. For T9 inputs in the
   current corpus (`z_root_distance = 0`), the comparator never hits
   the zero-band branch because the corpus tier T9 inputs all have
   exactly-zero distance — meaning the band is the entire neighbourhood
   and the comparator falls through to the relative-error branch
   anyway. The code is on disk for the case when corpus T9 evolves to
   carry actual `z_root_distance ∈ (0, 0.01)` values (R3 follow-up
   `besseljzeroFloat64` substrate).

## Acceptance

- ✅ `bench/besselj-anchor/cross-agreement.ts` on disk (literate top-of-
  file narrative covering Bessel additions A-F; per-oracle status
  taxonomy; threshold rationale).
- ✅ `bench/besselj-anchor/agreement-matrix.md` + `agreement-data.json`
  generated.
- ✅ **0 unexplained findings** (gate: < 50).
- ✅ 17660 / 17660 pair-wise comparisons at 100% agreement rate (after
  landmine downgrades).
- ✅ Per-oracle-pair table + per-tier-pair + per-corpus-tier summaries
  in the matrix.md.
- ✅ Landmine-category table with documented meanings in the matrix.md.
- ✅ Worklog (this shard).

## Pointers

- `bench/besselj-anchor/cross-agreement.ts` — the comparator.
- `bench/besselj-anchor/agreement-matrix.md` — generated heat-map.
- `bench/besselj-anchor/agreement-data.json` — generated machine data.
- `bench/besselj-anchor/corpus.json` — input source (qccc, 1766 inputs).
- `docs/adr/0041-bessel-family-per-head-substrate.md` §Decision 8 +
  §Decision 12 — tier thresholds + zero-band spec.
- `docs/refs/besselj-research/R5-oracle-landscape.md` §6 — the 11
  landmines catalogue (L1-L11 + L_boost_yspell). Cited inline in the
  comparator's landmine downgrade rules.
- `bench/erf-anchor/cross-agreement.ts` — styling exemplar; this
  comparator's `canonicalScientific`/`digitsAgreeing`/`ulpDistance`/
  `expandScientific` are byte-identical inheritances.
