# 149 — G5 Boost.Math silver+bronze tier adapter for the Bessel corpus

**Bead:** `scientist-workbench-5zxc` (G5 — Phase 1 silver-tier oracle adapter).
**Epic:** `scientist-workbench-zcam` (World-class Bessel J + Y + I + K).
**ADR:** `docs/adr/0041-bessel-family-per-head-substrate.md` (§"Decision 8"
oracle hierarchy: Boost is the silver-tier real-only voice, 12 real cells
covered, all complex refused).
**Research source:** `docs/refs/besselj-research/R5-oracle-landscape.md`
(§2 Boost capability row, §4 Boost probe details, §6 landmines
L_boost_yspell + L4 + L9 + L10).
**Predecessor:** Erf G6 adapter `bench/erf-anchor/oracles/boost/adapter.ts`
(shipped in worklog 142, Erf epic close) — styling exemplar.
**Sibling adapters:** G2 Wolfram (worklog 146), G4 SciPy (worklog 148).
**Date:** 2026-05-17.

## Context

ADR-0041 pins the per-head substrate for the Bessel family (J/Y/I/K) and
identifies six oracle voices across three tiers: gold (Wolfram + mpmath
+ Arb via python-flint), silver (Boost.Math `cpp_bin_float<50>`, real
only), bronze (SciPy + libm + Boost-`<double>`). Phase 1 G5 is the
silver-tier voice — Boost.Math's 50-decimal arb-prec real lane plus a
bonus bronze-tier double lane for the G8 cross-oracle matrix.

R5 §2's load-bearing finding for this adapter: Boost.Math's
`cyl_bessel_*` templates instantiate only on ordered scalar types and
reject `std::complex`. The Erf G6 adapter discovered this empirically
(compile-test 2026-05-16); the Bessel R5 ran the same probe with the
same result. So the silver tier covers 12 of the 24 capability cells
(4 heads × 3 ν-classes × {real} = 12) and refuses the remaining 12
(complex) cleanly.

Two head extensions over the Erf precedent matter:

1. **Two-argument heads.** Every Bessel head takes `(ν, z)` rather
   than Erf's single-argument `z`. ν travels through three classes
   (integer / half-integer / decimal), so the C++ side must sniff the
   `nu` string format at runtime and dispatch to `Real50(nu_str)` or
   `Real50(num)/Real50(den)` for the `"a/b"` form.
2. **Scaled variants.** `BesselIScaled` and `BesselKScaled` have no
   native Boost primitive but are computed by composition at the silver
   tier (`exp(-|z|) * cyl_bessel_i(nu, z)` and `exp(z) * cyl_bessel_k(nu,
   z)`), evaluated in `cpp_bin_float<50>` arithmetic. The huge exponent
   range of `cpp_bin_float<50>` dodges the float64 |z|≈700 over/under-
   flow cliff R5 §6 L9/L10 pin.

R5 §6 L_boost_yspell is the canonical "trap" landmine for this adapter:
Boost spells Y_ν as `cyl_neumann`, NOT `cyl_bessel_y`. A miss-spelled
call fails to compile with a misleading "did you mean cyl_bessel_k?"
suggestion. The C++ source uses `cyl_neumann` correctly at both lanes
and the README pins this prominently for any future reader.

## What changed

Three new artefacts under `bench/besselj-anchor/oracles/boost/` plus a
worklog shard:

- **`bessel-oracle.cpp`** (~620 LOC executable, ~800 lines with literate
  doc-comments). Single C++17 translation unit reading `corpus.json`
  from stdin and writing `results.json` to stdout. Hand-rolled JSON
  parser (lifted verbatim from the Erf G6 oracle — same corpus
  generator, same wire shape, same zero-deps discipline), `cpp_bin_float<50>`
  silver lane, `double` bronze lane, three-way ν-class string sniffer,
  scaled-variant composition in arb-prec arithmetic.
- **`adapter.ts`** (~280 LOC executable, ~376 lines with literate
  header). Pure-TS Bun orchestrator: probe environment (g++ + Boost
  headers) → idempotent compile (mtime-gated) → pipe corpus through
  binary via `spawnSync` → validate `results.json` shape + bucket
  counts → one-line summary. Modelled byte-for-byte on the Erf G6
  adapter; the only structural deltas are the per-record schema
  validation (silver + bronze values rather than one) and the wider
  refused-bucket vocabulary.
- **`README.md`** (~190 lines). Provenance, run-cost, capability table,
  L_boost_yspell + L4 + L9/L10 landmine documentation, ν-parsing matrix,
  expected output counts, output schema, reproducibility note, file
  layout.
- **`.gitignore`** — `build/` only.
- **`results.json`** (24930 lines, ~1.1 MB) — committed silver+bronze
  golden masters for 1766 corpus inputs.

The adapter's structural skeleton (path constants resolved from
`fileURLToPath(import.meta.url)`, probe → assert → build → run → verify
sequencing, `spawnSync` with input buffer, two-pass file-then-parse
validation) is copied verbatim from the Erf G6 adapter per the
orchestrator prompt's "styling exemplar" instruction.

Per-input schema deltas over Erf:

- `value_silver` and `value_bronze` both emitted on success (Erf G6
  emitted one or the other depending on lane); doubles the per-record
  storage by ~120 bytes but feeds the G8 comparator both arb-prec and
  float64 voices without re-running the oracle.
- `status` field added as an explicit `{success, refused, error}`
  enumeration (Erf G6 derived this from the `method` field).
- `reason` field strings reconciled across the three refusal classes:
  `boost-no-complex-bessel` (the prompt's literal text), `non-finite-real-input`
  (T6 ±∞/NaN), `singular-at-z-zero` (T6 z=0 for Y/K — see Friction §1).

Bead status: claimed → in_progress → close-on-completion per CLAUDE.md
Rule 9.

## Why these choices

### Verbatim port of the Erf G6 skeleton

The Erf G6 adapter shipped in worklog 142 with the same shape: TS
probe + g++ compile + corpus-through-binary-via-stdin + results-from-
stdout. Bessel's only structural difference is the two-argument head
dispatch, which adds 5 lines to the C++ argument extractor and zero
lines to the TS adapter (TS doesn't read inputs, just routes JSON).
Re-using the skeleton verbatim means the Bessel oracle inherits Erf
G6's hand-rolled JSON parser, mtime-gated build cache, fail-loud
environment probe, and post-run shape validator without re-deriving
any of them.

### `cyl_neumann` not `cyl_bessel_y` — pre-pinned

R5 §6 L_boost_yspell's documented mistake category is exactly the kind
of thing that costs 30 minutes of compile-error chasing if you miss it.
The C++ source has a load-bearing comment block above the silver
dispatcher pointing this out, and the README puts it in its own H2 with
the wrong spelling crossed out. Belt-and-braces: any future agent reads
either the source or the README before touching the code, and sees the
spelling before reaching for the keyboard.

### Scaled variants computed in `cpp_bin_float<50>`

R5 §6 L9/L10 documented the |z|≈700 over/underflow cliff for I/K in
float64. The silver-tier dodge is to compute the exponential prefactor
in arb-prec arithmetic; `cpp_bin_float<50>`'s exponent range (~2^31 in
binary) is enormous, so `exp(700)` is a perfectly ordinary number to
it. The bronze tier (float64) WILL trip the cliff at extreme `z`, and
we accept that — bronze's contract is "what Boost in float64 produces",
warts and all; the silver lane carries the corrected value alongside.

### Three refusal classes, not one

Erf G6 had two refusal classes (complex, non-finite). Bessel has three
because Y_ν(0) and K_ν(0) are genuine mathematical singularities
(DLMF 10.7.2 / 10.30.2 — both diverge to ±∞). Boost throws
`evaluation_error` with a long mangled-template-name message
containing "Overflow Error". Without explicit classification these
would surface as `status: "error"` and confuse the G8 comparator into
thinking something is broken. The `is_true_zero_string` helper in the
C++ side recognises the corpus's fixed-decimal "0.000…000" form and
routes Y/K-at-zero to `status: "refused" reason: "singular-at-z-zero"`
— honest scope (CLAUDE.md Rule 8) rather than driver error.

The result: **zero `error` records** on the v0.1 corpus. Every input
Boost cannot handle traces to a documented refusal class. If an `error`
record appears in a future run it is signal, not noise.

### Both silver AND bronze values per success record

The G8 comparator wants both at once — silver for gold-tier agreement,
bronze for float64-tier agreement against SciPy / libm. Computing both
in the same C++ binary doubles per-record CPU but is still well under
a millisecond per input; the extra 120 bytes per record × 1578 success
records = ~200 KB total disk overhead, irrelevant. The alternative
(two separate binaries or two passes) would double wall-time and burn
caller boilerplate downstream.

## Frictions surfaced

### 1. Y/K at z=0 — first-run classified as `error`

First run produced 24 `status: "error"` records — all Y_ν(0) and
K_ν(0) for ν ∈ {0, 1, 1/2} (8 records each across Y, K) × 3 ν values.
Boost throws "Overflow Error" with mangled-template-name detail (~600
chars). Adding the `is_true_zero_string` helper and the Y/K-at-zero
classification dropped errors to zero on the second run. The fix took
4 lines of C++ (the helper) + 6 lines of dispatch logic (the
classification). The lesson — copied verbatim from Erf friction-#11 —
is that "evaluation_error" from Boost is a signal worth classifying, not
a black box to surface raw.

### 2. `results.json` not byte-identical across runs

First reproducibility check failed because `elapsed_ms` (wall-clock per
input) varies between runs. The semantic acceptance criterion is the
*value* fields, not timing — verified byte-identical with
`jq '.results[] | {input_id, value_silver, value_bronze, method, status, reason}'`
field projection. Worth documenting in the README so future readers
don't mistake the timing noise for a determinism bug.

### 3. First-run compile cost — 54 seconds

Boost.Math's `cyl_bessel_*` family is heavily templated AND
`cpp_bin_float<50>` quadruples instantiation cost over plain double.
First compile was ~54 s, vs Erf G6's ~5 s for a single template
instantiation. Subsequent runs (mtime-gated) skip straight to execution
in 1.5 s. Documented in the README so the "5 minutes wall-time"
expected ballpark from the orchestrator prompt makes sense: 55 s
one-time compile + 1.5 s/run × however many runs.

### 4. Refusal-bucket count higher than orchestrator-expected

Orchestrator prompt expected ~200 complex refusals. Actual: 128
complex + 60 other (36 non-finite + 24 singular-at-zero) = 188 total
refusals. The difference is that the orchestrator quoted "~200
complex" loosely; the corpus's T5 tier has exactly 128 complex
inputs, plus T6 contributes 36 non-finite + 24 singular = 60. Total
1578 success + 188 refused = 1766 inputs, exactly matching the corpus.

## Acceptance

- `bench/besselj-anchor/oracles/boost/{bessel-oracle.cpp, adapter.ts,
  README.md, .gitignore, results.json}` on disk.
- `bun bench/besselj-anchor/oracles/boost/adapter.ts` succeeds end-to-end
  with `inputs=1766 success=1578 refused_complex=128 refused_other=60
  errors=0`.
- Wall-time: 54 s one-time compile + 1.5 s execution. Total < 1 min on
  warm cache, ~1 min on cold cache.
- `results.json` field-by-field byte-identical across runs for
  `{input_id, value_silver, value_bronze, method, status, reason}`
  (verified via `jq -S` diff). `elapsed_ms` varies (wall-clock noise);
  documented as a diagnostic field.
- Smoke-test value: `BesselI[0, 700]` (corpus input `T6-besseli-007`)
  reproduces byte-identically against R5 §4 worked example
  `cyl_bessel_i(0, 700) = 1.5295933476718737363162072288904508649662689614637e+302`.
- Zero `error` records — every refusal traces to a documented mechanical
  reason (no Boost capability for complex, no string-parser for
  Infinity/NaN, no finite representation for Y/K-at-zero singularity).

## Pointers

- ADR: [`docs/adr/0041-bessel-family-per-head-substrate.md`](../adr/0041-bessel-family-per-head-substrate.md)
  §"Decision 8" + §"Decision 13" (negative-ν branch convention).
- Research: [`docs/refs/besselj-research/R5-oracle-landscape.md`](../refs/besselj-research/R5-oracle-landscape.md)
  §2 capability matrix, §4 Boost probe + worked examples, §6 landmines
  L_boost_yspell + L4 + L9 + L10.
- Predecessor: [`bench/erf-anchor/oracles/boost/adapter.ts`](../../bench/erf-anchor/oracles/boost/adapter.ts)
  + [`bench/erf-anchor/oracles/boost/erf-oracle.cpp`](../../bench/erf-anchor/oracles/boost/erf-oracle.cpp)
  (styling exemplar; shipped worklog 142).
- Sibling worklogs: 146 (G2 Wolfram), 148 (G4 SciPy). G7 (Arb /
  python-flint) is the next gold-tier voice; G8 cross-agreement matrix
  consumes the outputs of G2 + G3 + G4 + G5 + G7.
- Corpus: [`bench/besselj-anchor/corpus.json`](../../bench/besselj-anchor/corpus.json)
  (1766 inputs, 10 tiers, generated 2026-05-17, seed 20260517).
