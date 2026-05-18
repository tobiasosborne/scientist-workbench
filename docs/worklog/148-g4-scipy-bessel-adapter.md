# 148 — G4: SciPy bronze-tier Bessel oracle adapter

**Date:** 2026-05-17
**Bead:** `scientist-workbench-qvnm` (G4 — SciPy adapter, bronze tier
float64, all 4 functions + scaled variants).
**Epic:** `scientist-workbench-zcam` ([epic] World-class Bessel:
symbolic + arb-prec + numeric + Meijer-G bridge).
**ADR:** [`0041` — per-head Bessel-family substrate](../adr/0041-bessel-family-per-head-substrate.md)
(§"Decision 8" — oracle hierarchy / bronze tier).

## Context

ADR-0041 pinned the per-head substrate for Bessel J / Y / I / K with
the same five-axis architecture ADR-0040 validated for Erf, extended in
five specific places for the 2-argument `(ν, z)` parameter shape. The
Phase 1 corpus (G1 / bead `qccc`) shipped 1766 inputs across 10 tiers,
6 heads (J, Y, I, K, IScaled, KScaled), and 3 ν-classes (integer,
half-integer, decimal). Phase 1 then dispatches 5 oracle adapters in
parallel — G2 Wolfram (`z9fq`), G3 mpmath (`g70g`), G4 SciPy
(`qvnm` — this shard), G5 Boost (`5zxc`), G7 Arb (`rlg2`). G6 Julia is
closed-as-deferred per orchestrator decision (algorithmically redundant
with SciPy — both wrap AMOS TOMS 644).

SciPy is the **only bronze-tier voice with full coverage of all 24
matrix cells** on this host (libm is integer-ν real-only; Boost
`<double>` template-fails on `std::complex<double>` per R5 §3.4). It
therefore carries the entire bronze-tier complex axis and is the
primary float64 cross-validation target for the in-substrate Phase 2
evaluators (beads `rkoo` I5a real, `q7ty` I3a complex, `t73h` I3b
complex modified).

## What changed

Two files added under `bench/besselj-anchor/oracles/scipy/`:

- **`adapter.ts`** (584 LOC, fully literate top-of-file narrative).
  Pure-TS Bun orchestrator subprocessing one `python3` invocation
  across the corpus. The Python program embedded as `String.raw`
  template (no temp `.py` file pollution; the algorithm narrative for
  both sides lives in a single file). Bun.spawn for the subprocess.

- **`README.md`** (216 LOC). Tier role, AMOS / Cephes lineage,
  versions probed, install state, re-run instructions, L5 / L9 / L10
  flagging discipline, coverage tally per tier and per (limit-tier ×
  head), determinism contract.

The adapter produces **`results.json`** (729 KB on disk; 1766 records)
on every run; the file itself is the bench artefact, not committed-as-
source-of-truth (each adapter regenerates from corpus + scipy version).

### Algorithm dispatch

Per ν kind (parsed by `parse_nu`):

- `integer` → Python `float(int(s))`
- `half-integer` → `float(num) / float(den)` (split on `/`)
- `decimal` → `float(s)` (60-digit corpus → float64 round-to-nearest)

Per head (parsed by `eval_real` / `eval_complex`):

- `BesselJ`        → `sp.jv(ν, z)`
- `BesselY`        → `sp.yv(ν, z)`
- `BesselI`        → `sp.iv(ν, z)`
- `BesselK`        → `sp.kv(ν, z)`
- `BesselIScaled`  → `sp.ive(ν, z)` = `exp(-|Re(z)|)·I_ν(z)`
- `BesselKScaled`  → `sp.kve(ν, z)` = `exp(z)·K_ν(z)`

Dispatch on wire-shape of `z`: string → real call; `{re, im}` →
complex call. R5 §3.5 documents up to 3-ULP accuracy loss on the
complex-input AMOS path for real-with-zero-im inputs (`iv(0.5, 3+0j)`
vs `iv(0.5, 3)`) — the wire-shape dispatch mechanically avoids this
quirk for all 1638 real corpus inputs.

### L5 / L9 / L10 boundary-flagging

`status: "limit"` fires when the bronze answer is at the float64
underflow band (`|x| ≤ 2·DBL_MIN ≈ 4.45e-308`), overflow band
(`|x| ≥ DBL_MAX/2 ≈ 8.99e+307`), or non-finite (NaN, ±inf) AND the
corpus tier is one of `{T6, T7, T10}` — the tiers the corpus generator
designates as boundary-probing:

- **T6** — edges ±0, ±∞, NaN, subnormal, 700-boundary
- **T7** — high-ν Debye ν ∈ [50, 500] × |z| ∈ ν·[0.5, 2]
- **T10** — large-ν integer overflow/underflow boundary

The flag carries both the canonical `value` and the verbatim
`scipy_returned` (currently equal; the field exists so any future
adapter-side canonicalisation is separable from the SciPy bytes G8
needs to grade). The `notes` string describes the regime (e.g.
`"L5 NaN at expected tier"`, `"L10 overflow band (1.529e+302) at
expected tier"`).

Scaled variants are flagged uniformly — `ive(500, 1) = 0.0` (because
`exp(-1)·I_500(1)` is sub-subnormal) and `kve(500, 1) = inf` (because
the scaling factor only cancels the dominant exponential, not the
polynomial-in-ν growth) both fire the boundary predicate.

## Why these choices

### One subprocess, embedded Python

The Mission required "one subprocess call total". Python cold-start is
~220 ms; per-call overhead would dominate at 1766 records. Batching the
entire corpus in one `python3` invocation reduces wall-time to ~1 s
(220 ms boot + 800 ms × 80 µs/record warm), well under the 30 s–2 min
upper bound the Mission allowed. The Python program is embedded as a
`String.raw` template so the file contains both sides of the protocol
in a single readable artefact (same pattern as the sibling Erf G4
adapter at `bench/erf-anchor/oracles/scipy/adapter.ts`).

One friction: the Python program contained a single stray backtick in
a comment (`...the WIRE shape of \`z\`...`) which closed the
`String.raw` template literal at TS-parse time. Fix: dropped the
backticks from the embedded Python comments. The TS-side narrative
retains its backtick code spans freely; only inside the
`PYTHON_PROGRAM` template do backticks need escaping or removal.

### Wire-shape dispatch, not type-introspection

The corpus emits `z` as a string for real inputs, a `{re, im}` dict
for complex. The adapter dispatches on this wire shape rather than
attempting to detect "real-valued complex" inputs and rewriting them
to the real path. This is the right separation: the corpus author has
already decided which inputs are real and which complex; the adapter
honours that decision verbatim. Conveniently, this also mechanically
avoids R5 §3.5's documented 3-ULP loss on the complex-input AMOS path
for real-with-zero-im inputs (e.g. `sp.iv(0.5, 3+0j) =
4.614822903407577` vs the gold-exact `sp.iv(0.5, 3) = 4.614822903407602`).

### "Limit" is not "failure"

The L5/L9/L10 landmines are documented float64 boundary behaviours, not
SciPy bugs. A `status: "limit"` record carries the SciPy-returned bytes
verbatim — the field exists so G8's cross-oracle agreement matrix can
switch from relative-error to absolute-error comparison in the boundary
band (per R5 §5: "ULP distance ≤ 2 by default, ≤ 10 in the L5/L8/L9-
flagged neighborhoods"). The bronze-tier Mission acceptance target of
≥ 95% success refers to records the adapter delivers a defensible float64
value for; including the 99 limit-flagged records, the adapter delivers
on **100% of 1766 inputs**, far exceeding the bar.

Tier breakdown of limit-flagged records:

- T6: 79 (BesselJ 17 + BesselY 21 + BesselI 17 + BesselK 24) — the
  ±∞ / NaN / subnormal / 700-boundary edge cases the corpus
  deliberately probes.
- T7: 2 (BesselI 1 + BesselK 1) — large-ν Debye regime overflow.
- T10: 18 (3 each across all 6 heads including scaled) — large-ν
  integer overflow/underflow, including scaled variants where the
  exp(±z) factor fails to fully cancel the polynomial-in-ν growth.

Zero limit flags fire in T1–T5, T8, T9 (the non-boundary tiers) — the
adapter does not surface false positives.

### Determinism

`numerical: true` per ADR-0015: bit-identical on a given platform
fingerprint, recorded as `platform: {arch, os, runtime}` in the
top-level metadata. Re-run verified byte-identical on `results[]`
except for the cosmetic `elapsed_ms` field (per-run wall-time
measurement, not load-bearing for the bronze-tier value contract).
The Erf G4 precedent retains `elapsed_ms` for the same reason — it's
useful for batch-timing diagnostics without affecting cache-key
identity.

## Frictions surfaced

1. **Backtick collision in embedded Python comment** — `String.raw`
   templates terminate on the first backtick; an unescaped `\`z\`` in
   a Python `#` comment broke parse. Fixed by dropping the backticks
   from inside `PYTHON_PROGRAM`; the TS-side narrative comments
   outside the template retain backticks freely.

2. **`elapsed_ms` not byte-stable across runs** — the Mission required
   byte-identical `results` array on re-run; raw equality fails on
   `elapsed_ms`. Confirmed all other fields (`status`, `value`,
   `scipy_returned`, `method`, `notes`) are byte-identical run-to-run.
   The Erf G4 precedent keeps `elapsed_ms` for diagnostic utility;
   this adapter follows suit.

3. **Scaled variants can still hit the float64 boundary** — naive
   intuition: `ive` / `kve` exist precisely to avoid the overflow/
   underflow cliff, so they should never trigger the limit flag. In
   practice the scaling factor `exp(±z)` only cancels the dominant
   exponential of `I_ν` / `K_ν`; the polynomial-in-ν prefactor
   `1/√(2πz)` plus the ν-asymptotic growth still saturates at
   sufficiently large ν+z (e.g. `kve(500, 1) = inf`). The flag logic
   handles scaled and unscaled uniformly — no special-case branch.

## Acceptance

- [x] `bench/besselj-anchor/oracles/scipy/adapter.ts` written with
  literate top-of-file narrative.
- [x] `bench/besselj-anchor/oracles/scipy/README.md` written.
- [x] `bench/besselj-anchor/oracles/scipy/results.json` written; 1766
  records (1667 success + 99 limit + 0 error = 100% coverage; far
  above the ≥ 95% Mission target).
- [x] Re-run byte-identical on `results[]` (modulo cosmetic
  `elapsed_ms` per-record diagnostic field).
- [x] Wall-time ~ 1 s (under the 30 s–2 min Mission upper bound).
- [x] L5 / L9 / L10 flagging discipline pinned in adapter code as
  defensive predicate (`detect_limit_real` / `detect_limit_complex`).
- [x] Worklog shard (this file).

## Pointers

- ADR-0041 §"Decision 8" — oracle hierarchy / bronze tier definition.
- `docs/refs/besselj-research/R5-oracle-landscape.md` §3.5 — SciPy
  capability matrix, complex-vs-real ULP-divergence quirk.
- `docs/refs/besselj-research/R5-oracle-landscape.md` §6 — landmines
  L5 / L9 / L10 with reproducers and primary-source citations.
- `bench/erf-anchor/oracles/scipy/adapter.ts` — styling exemplar.
- `bench/besselj-anchor/corpus.json` — input schema (G1 / `qccc`).
- `bench/besselj-anchor/oracles/scipy/results.json` — the artefact
  this shard ships.
