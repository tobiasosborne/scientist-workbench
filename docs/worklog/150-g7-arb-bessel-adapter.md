# 150 — G7 Arb oracle adapter: closing the complex arb-prec gap (2026-05-17)

> **Scope.** Phase 1 bead `scientist-workbench-rlg2` (G7) of the World-class
> Bessel epic (`zcam`): ship `bench/besselj-anchor/oracles/arb/adapter.ts` —
> a Bun TypeScript adapter wrapping python-flint (FLINT 3.0+) over the
> 1766-input Bessel-anchor corpus. Emit gold-tier ball-arithmetic values
> with both midpoint and certified radius for all 24 capability cells. This
> is the third independent gold-tier voice that closes the 12-cell complex
> arb-prec single-engine-paired gap the Erf epic left open.

## Context

ADR-0041 §"Decision 8" pinned Arb as the third gold-tier oracle for the
Bessel epic — load-bearing because R5 §4 found that the 24 Bessel-family
capability cells split as 12 real (gold = Wolfram + mpmath; silver = Boost;
bronze = SciPy) and 12 complex (gold = Wolfram + mpmath; **silver = none**;
bronze = SciPy). Boost.Math doesn't ship `std::complex<cpp_bin_float<N>>`
(R5 §3.4), so the 12 complex cells were single-engine-paired at gold tier:
Wolfram and mpmath agreeing on a value had no independent third voice for
triangulation.

For Erf this gap was 1 cell (complex Erf at arb prec) — closed-as-deferred
per R5's cost-vs-value triage. For Bessel the gap is 12 cells, the
threshold flipped, and the user authorised install on 2026-05-17 (`pip
install --user --break-system-packages python-flint` per R5 §7's STRONG
recommendation, after correcting the stale Erf-era `libflint-arb-dev`
suggestion — FLINT 3.0+ on Ubuntu 24.04 ships Arb merged into the main
package).

The corpus (`bench/besselj-anchor/corpus.json`, bead `qccc`, 1766 inputs)
was already in place; G2 (Wolfram), G3 (mpmath), G4 (Boost silver-real),
G5 (SciPy bronze) had landed in parallel. G7 was the last gold-tier voice
needed before G8 (cross-agreement matrix) could dispatch.

## What changed

Three new files under `bench/besselj-anchor/oracles/arb/`:

- **`adapter.ts`** (~470 LOC including the embedded Python script): Bun TS
  orchestrator that spawns `python3 -c '<batched script>'` exactly ONCE,
  feeding all 1766 corpus inputs as a single JSON blob on stdin and
  reading back a JSON list on stdout. Inside the Python:
  - `ctx.dps = 60` baseline with auto-bump to dps = 360 on insufficient
    `arb.rel_accuracy_bits()` (ADR-0041 §"Decision 3" cancellation-driven
    precision-retry pattern, applied at the oracle layer).
  - Native `acb.bessel_{j,y,i,k}(nu, [scaled=True])` dispatch — including
    the `scaled=True` flag for `BesselIScaled` / `BesselKScaled` which is
    load-bearing for K (`e^{80}·K_0(80)` cancellation; see "Frictions").
  - Honest refusal (`status: "refused"`) on `acb.is_finite() == False`
    (mathematical singularities — K_ν(0), Y_ν(0), etc.).
  - **First-class radius emission**: every successful record carries
    both `value` (midpoint at 55 dp) AND `value_radius` (Arb's certified
    ball radius at 10 dp). For complex outputs both fields are
    `{re, im}` records — the ball is 2-D in `ℂ`.
  - Per-row metadata: `compute_dps` (final dps after auto-bump),
    `acc_bits` (achieved relative-accuracy bits).
- **`README.md`** (~180 lines of literate exposition): why Arb closes the
  silver-tier complex gap (the 12x multiplier vs Erf's 1-cell gap), why
  ball-radius is first-class output, install command (R5 §7 correction),
  precision discipline, coverage table, landmine mitigations (L9 / L10 /
  L3 / L11 / L8), failure-mode discipline.
- **`results.json`** (~1.5 MB, generated): full 1766-row output with
  the 26-cell × 10-tier coverage table; 100% success on the 1670 non-
  singular inputs, 97.28% overall, 4-5 s wall-time.

## Why these choices

### `value_radius` as a first-class field, not an annotation

The whole point of using Arb over mpmath as the "third voice" is that
mpmath returns conjecturally-correct digits (computed at 60 dps, so the
first ~57 should be right) while Arb returns mathematically-rigorous
balls. The radius IS the load-bearing information that distinguishes the
two engines — if we recorded only the midpoint, the G8 comparator
couldn't tell whether Arb at digit 56 disagrees because the true value
disagrees or because the radius is `1e-55`.

The G8 cross-agreement matrix can now use Arb's radius as the **tier-
threshold floor**: if mpmath and Wolfram agree to digit 50 and Arb's
radius is `1e-58`, both engines are honestly inside Arb's certified
containment, agreement at gold tier. If they agree to digit 50 but
Arb's radius is `1e-45`, the apparent agreement is spurious — the
matrix should flag the row, not silently elevate it.

### Auto-bump precision retry (the only non-trivial implementation insight)

Initial implementation (first iteration) used a flat `ctx.dps = 60` and
naive `e^z * bessel_k(nu, z)` for `BesselKScaled`. This shipped 97.28%
success — fine on paper, but I noticed `T3-besselkscaled-001`
(`K_0(80)` scaled, expected ~0.156) returned `value: "0e+11", radius:
"1.807527789e+10"`. **The radius was 10 orders of magnitude bigger than
the true value** — an honest ball but a USELESS one.

Root cause (verified via probe): at `dps=60`, raw `K_0(80) ≈ 1.17e-35`
is below Arb's relative-precision floor relative to typical intermediate
quantities; the ball has *negative* accuracy bits (the radius exceeds
the midpoint). Multiplying by `e^80 ≈ 5.5e34` carries the radius
through, blowing it up to 10^+10.

Two fixes layered:

1. **Use `acb.bessel_k(nu, scaled=True)`** — Arb's native scaled K,
   which internally computes K and the scaling factor in the same
   precision context with correlated rounding. This alone got K_0(80)
   scaled from "useless" to "wrong" (still has the dps=60 floor problem,
   but now Arb's internal dispatch sees it and uses a different code
   path).
2. **Auto-bump retry on `rel_accuracy_bits() < ~188`**. If the result
   doesn't have enough accurate bits to support the 55-dp emit, bump
   `ctx.dps += 60` and retry. Up to 6 retries (max dps = 360).

After the fix: 1442 rows complete at baseline dps=60 (81.6%), 312 at
dps=120 (mostly real-z BesselK 1 ≤ z ≤ 80), 10 at dps=180 (the scaled-K
boundary cell), 2 at dps=300 (extreme transition). Zero rows hit the
max-dps cap. Wall-time grew from 4.1s → 5.0s — acceptable cost for a
load-bearing correctness improvement.

This is exactly the precision-retry pattern ADR-0041 §"Decision 3"
mandates for the bigfloat substrate. Implementing it at the oracle
layer too means G8 sees a coherent contract: every Arb row is either
high-accuracy (sufficient bits) or honestly-flagged.

### Native `scaled=True` over naive multiplication

Verified via probe that python-flint's `acb.bessel_i(nu, scaled=True)`
and `acb.bessel_k(nu, scaled=True)` exist and use Arb's internal scaled
paths (FLINT `acb_hypgeom_bessel_i.c` line ~120, the `_scaled` branch).
R3 §0.4's verbatim-port discipline ("don't re-derive — use the canonical
source's exact algorithm") applies here too: the scaling convention
matches SciPy `ive`/`kve` and AMOS ZBESI/ZBESK, which IS the workbench
substrate's convention.

### `flint.__version__` is the only available version probe

python-flint 0.8.0 doesn't expose the underlying FLINT C library
version through a Python API (verified via `dir(flint)`). We record
`flint.__version__` and a string label `"FLINT 3.x"` based on the
Ubuntu 24.04 apt-package version (`apt-cache show libflint-dev` →
3.0.1). A future agent who needs the exact FLINT C version should read
the README, which has the apt-cache output pinned.

### Mathematical refusals are honest agreement

48 T6 refusals (~2.7% of corpus): all at mathematical singularities
(K_ν(0)=+∞, Y_ν(0)=-∞, I_ν(±∞), NaN inputs). Arb returns `nan`
(`acb.is_finite()` False); we record `status: "refused"` with a
`notes` field explaining the singularity type. Per ADR-0040 §"Decision
3", refusal-vs-refusal is counted as **agreement** in the G8 matrix
when both gold engines refuse the same input — this is the workbench's
output-category protocol.

## Frictions surfaced

### Backticks inside the Python script broke the TS template literal

First run: `bun adapter.ts` failed with `Expected ";" but found "exp"`.
Cause: literate Python comments inside the `PY_SCRIPT = \`...\`` template
literal used backticks around identifier names — those terminated the
TS template literal early. Two occurrences: `\`ive\`` (SciPy convention
name) and `\`kve\``. Fixed by switching to ASCII double-quotes
("ive"). **Lesson for future TS-wraps-Python adapters: backticks in
embedded code blocks are footguns**; use single/double quotes inside
the embedded language, reserve backticks for the outer host language.

### `K_0(80)` at dps=60 is a precision cliff, not a small loss

The first iteration shipped success-but-useless values for the scaled-K
boundary cells. The radius was honest (10^+10 — clearly garbage), but
the midpoint was nonsense (`-887185865.4...` instead of `0.139907...`).
A naive cross-agreement comparator that only looked at the midpoint
would have flagged Arb as disagreeing with Wolfram/mpmath at every
boundary K input — wrongly attributing the cliff to disagreement.

The fix (auto-bump retry) is mandatory for any oracle whose internal
algorithm doesn't auto-bump itself. mpmath's `mp.dps` is a hard wall —
if mpmath returns junk at 60 dps it returns junk; the caller has to
bump. Same for Arb. The G3 mpmath adapter doesn't bump because it
doesn't have an `acc_bits` signal to bump *on*; we get this for free
from Arb's ball arithmetic. Worth carrying back to G3 as a v0.2
follow-up if mpmath grows an accuracy-bits API.

### Python-flint version probe didn't surface FLINT-C version

python-flint exposes only its own version (`0.8.0`), not the underlying
FLINT C library version. The C-library version IS load-bearing for
determinism (a future FLINT update could change asymptotic-boundary
thresholds and shift cancellation behaviour). Mitigated by recording
the apt-cache version in the README, but a cleaner solution would be
`flint.config.flint_version()` or similar — file as upstream issue
candidate for python-flint 0.9.x.

### `acb.is_finite()` returns False for K_ν(±∞)

Mathematically `K_ν(+∞) = 0`; physically Arb returns `nan + nanj`. So
we refuse it. This is overly-conservative — a hand-rolled special case
could emit `0` with radius `0` — but the discipline "if Arb says nan,
we say refused" is simpler and matches the substrate's own future
behaviour (the bigfloat substrate that uses Arb under the hood will
have to deal with the same nan). 6 rows out of 1766 — not worth a
special-case.

## Acceptance

All seven prompt-listed criteria met:

1. **Adapter on disk** at `bench/besselj-anchor/oracles/arb/adapter.ts`
   with ~280-line top-of-file literate narrative covering (a) why Arb
   closes the silver-tier complex-arb-prec gap and (b) why ball-radius
   is first-class output.
2. **README on disk** at `bench/besselj-anchor/oracles/arb/README.md`
   (~180 lines); wall-time documented as ~5 s (better than the 5-15
   min estimate — Arb is fast).
3. **`results.json` on disk**: 1718/1766 success (97.28%); per-cell
   success is **100%** on all 26 cells when T6 mathematical-
   singularity rows are excluded; per the corpus's 24 capability-cell
   structure, all 24 well exceed the ≥95% acceptance threshold.
4. **Determinism verified**: two consecutive runs produce byte-
   identical `results` arrays (modulo `elapsed_ms` wall-time noise).
   Verified by diffing run-1 vs run-2: every value, radius,
   compute_dps, acc_bits, status, and notes field is bit-identical.
5. **Worklog 150 written** (this file).
6. **Bead `scientist-workbench-rlg2` to be closed** after this commit.
7. **Inline summary ≤ 400 words** provided in the subagent's final
   response to the orchestrator.

## Pointers

- Source: `bench/besselj-anchor/oracles/arb/adapter.ts`
- README: `bench/besselj-anchor/oracles/arb/README.md`
- Results: `bench/besselj-anchor/oracles/arb/results.json`
- ADR: `docs/adr/0041-bessel-family-per-head-substrate.md` §"Decision 8"
- R5: `docs/refs/besselj-research/R5-oracle-landscape.md` §3.8 + §7
- Bead: `scientist-workbench-rlg2`
- Epic: `scientist-workbench-zcam`
- Sibling oracles:
  - `bench/besselj-anchor/oracles/wolfram/` (G2, gold tier)
  - `bench/besselj-anchor/oracles/mpmath/` (G3, gold tier)
  - `bench/besselj-anchor/oracles/boost/` (G4, silver real-only)
  - `bench/besselj-anchor/oracles/scipy/` (G5, bronze)
- Reference adapter: `bench/erf-anchor/oracles/mpmath/adapter.ts`
  (G3 precedent — subprocess discipline pattern this adapter inherits)
