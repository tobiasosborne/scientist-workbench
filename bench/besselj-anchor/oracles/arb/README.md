# Arb oracle adapter (G7) — gold tier, third independent arb-prec voice

**Bead:** `scientist-workbench-rlg2` (Phase 1 — G7, gold tier).
**ADR:** [`docs/adr/0041-bessel-family-per-head-substrate.md`](../../../../docs/adr/0041-bessel-family-per-head-substrate.md) §"Decision 8".
**R5 source:** [`docs/refs/besselj-research/R5-oracle-landscape.md`](../../../../docs/refs/besselj-research/R5-oracle-landscape.md) §3.8 + §7 ("strong install recommendation").
**Sibling oracles:** Wolfram Mathematica (G2) + mpmath (G3) — the other two gold-tier voices.

## What this is

A Bun TypeScript adapter that:

1. reads `bench/besselj-anchor/corpus.json` (1766 inputs across 10 tiers and
   6 heads: BesselJ, BesselY, BesselI, BesselK, BesselIScaled, BesselKScaled);
2. spawns `python3` ONCE with a batched [python-flint](https://github.com/flintlib/python-flint) script;
3. emits `results.json` with Arb's ball-arithmetic gold-master values — both
   **midpoint** AND **certified radius** for every successful row.

## Why this adapter matters more than the Erf-epic Arb adapter would have

The R5 capability matrix (§4) found that of the 24 Bessel-family capability
cells (4 heads × 3 ν-classes × {real, complex}), the 12 **complex** cells
had NO silver-tier oracle available locally:

| Cell type             | Gold (≥48 dp)        | Silver  | Bronze       |
|-----------------------|----------------------|---------|--------------|
| 12 real cells         | Wolfram + mpmath     | Boost   | SciPy, libm  |
| 12 complex cells      | Wolfram + mpmath     | **(none)** | SciPy     |

Boost.Math does not ship `std::complex<cpp_bin_float<N>>` (R5 §3.4); SciPy is
float64 (bronze). So the 12 complex cells were **single-engine-paired** at
gold tier before this adapter: Wolfram and mpmath agreeing on a value had no
independent third voice to triangulate against.

For Erf this gap was 1 cell (complex Erf at arb prec). For Bessel it is 12.
Arb (via python-flint) closes all 12 in one adapter — the single highest-
value install for the whole Bessel epic.

**Algorithmic independence.** The three gold-tier engines have three
distinct algorithmic lineages:

- **Wolfram**: proprietary; documented as a dispatch family covering
  power-series, asymptotic-series, and continued-fraction paths.
- **mpmath**: pure-Python; `mpmath.libmp.libbessel` — hand-coded power-
  series + Hankel asymptotic.
- **Arb**: FLINT C; `acb_hypgeom_bessel_{j,y,i,k}.c` — Fredrik Johansson's
  rigorous hypergeometric-series + ball-arithmetic asymptotics, citing
  Olver and DLMF.

Three implementations, three lineages — exactly the algorithmic independence
that makes a triangulation finding load-bearing.

## Why ball arithmetic is first-class output

Arb's distinguishing feature vs every other oracle: every computed value is
a **ball** `[centre ± radius]` with mathematically-rigorous containment.
The radius is a tight upper bound on the true error, computed by error-
tracking through every internal operation. This is fundamentally different
from mpmath's "ran at 60 dps so the first ~57 digits should be right" —
that is conjecturally correct, not certified.

We therefore record BOTH the midpoint AND the radius as first-class fields
on every successful record (`value` and `value_radius`). The downstream G8
cross-agreement comparator can then:

1. Use the midpoint for value comparison (the standard role).
2. Use the radius as the **tier-threshold floor**: if Arb reports a radius
   of `1e-58` on a value where Wolfram and mpmath disagree at digit 56, the
   disagreement is *spurious* — both gold engines fall within Arb's
   certified containment ball. Conversely, if mpmath claims digit 56 of
   agreement but Arb's radius is `1e-55`, mpmath is overstating its
   precision and the agreement is illusory.

This is the comparator-input ADR-0041 §"Decision 8" mentions when it calls
Arb "the missing third voice that returns a certified error bound rather
than a conjecturally-correct value."

For the 12 complex cells `value_radius` is itself `{re, im}` — the ball is
two-dimensional in C. Both components emitted honestly.

## Probed versions

```text
$ python3 --version
Python 3.12.3
$ python3 -c 'import flint; print(flint.__version__)'
0.8.0
$ apt-cache show libflint-dev | head -2
Package: libflint-dev
Version: 3.0.1-3.1build1
```

All three versions are recorded inside every `results.json` record so a
future agent can reproduce or notice a version drift.

## Install (Ubuntu 24.04 — R5 §7 correction)

```sh
sudo apt install libflint-dev
pip install --user --break-system-packages python-flint
```

**Critical correction to Erf-era R5.** The Erf recommendation
`apt install libflint-dev libflint-arb-dev` is **stale** for Ubuntu 24.04 —
FLINT 3.0+ has Arb merged in; `libflint-arb-dev` no longer exists. The
Ubuntu `libarb` / `libarb-dev` package is an UNRELATED phylogenetic-
analysis project — do **NOT** install it.

Verify:

```sh
python3 -c 'from flint import acb, ctx; ctx.dps=60; print(acb(2).bessel_j(acb(3)))'
# [0.128943249474402051098793332969239835269993725282460233864440 +/- 4.66e-61]
```

## Precision discipline — 60 dps baseline + auto-bump to 360 dps

Baseline: `ctx.dps = 60`, emit at 55 dp midpoint + 10 dp radius. This is
the standard 10-dps compute margin / 5-dps emit margin pattern matching
G3 (mpmath); see G3's README for the rationale.

**Auto-bump on insufficient accuracy.** Arb reports per-result accuracy
as a number of relative bits (`arb.rel_accuracy_bits()`). If the result
at the baseline dps does not carry enough accurate bits to support the
emit precision (target: ≥ `55 × 3.33 + 4 ≈ 188 bits`), we bump
`ctx.dps += 60` and retry — up to 6 attempts (final dps = 360). This is
the precision-retry pattern ADR-0041 §"Decision 3" mandates for the
bigfloat substrate; it applies here for exactly the same reason.

Observed on the 1766-input corpus:

| dps used | row count |  what triggers the bump |
|---------:|----------:|------------------------|
|       60 |      1442 | the 81.6% happy path   |
|      120 |       312 | mostly `BesselK` real-z 1 ≤ z ≤ 80 plateau |
|      180 |        10 | `BesselKScaled` integer-ν z ≈ 80 cancellation |
|      300 |         2 | extreme transition-region |

Each result row records the final `compute_dps` used and the achieved
`acc_bits`, so G8 can see at-a-glance which rows operated near a
precision cliff.

The 5-dps emit-vs-baseline margin matches G3's truncation discipline so
G8 can apply the SAME tier threshold to Wolfram, mpmath, and Arb without
per-oracle conditioning.

## Scaled variants — Arb's native `scaled=True`

For `BesselIScaled` ($e^{-|\mathrm{Re}\,z|}\cdot I_\nu(z)$) and `BesselKScaled`
($e^z\cdot K_\nu(z)$) we use python-flint's native
`acb.bessel_i(nu, scaled=True)` and `acb.bessel_k(nu, scaled=True)` rather
than naive `exp(z) * bessel_k(nu, z)` multiplication. The naive path
loses ~30 dp of precision for `K_ν(80)` (the value is ~10^-35 but the
exp factor is ~10^+34, so the round-trip multiplication blows up the
ball radius). Arb's internal scaled path preserves precision.

Convention matches R3 §0.4 (SciPy `ive` / `kve`, AMOS ZBESI / ZBESK
scaling-flag semantics) — the workbench substrate inherits the same
convention via R3's verbatim-port discipline.

## Coverage

After running the adapter on the v0.1 corpus:

```text
total inputs: 1766
successful:   1718  (97.28%)
refused:        48  (all T6 mathematical-singularity edges)
errors:          0
elapsed:      ~5 s
```

**Per-cell coverage excluding the T6 singular edges: 100% on all 26 cells.**
The 48 refusals are all T6 inputs at the mathematical singularities of
the relevant function — Arb honestly returns `nan`, and we honestly
record `status: refused`:

| Refusal class             | Why mathematically refused                        |
|---------------------------|---------------------------------------------------|
| `Y_ν(0)` (15 inputs)      | Diverges to `-∞` for all ν                       |
| `K_ν(0)` (12 inputs)      | Diverges to `+∞` for all ν                       |
| `BesselJ/Y(NaN)` (4)      | NaN input → NaN output                            |
| `I_ν(±∞)` (6)             | Diverges to `+∞`; sign-ambiguous for `-∞`        |
| `K_ν(±∞)` (6)             | Arb returns nan (no special-case for this limit) |
| `BesselK(NaN)` etc. (5)   | NaN input → NaN output                            |

CLAUDE.md Rule 1 ("fail fast, fail loud") + ADR-0040 §"Decision 3"
(record-with-flag for routine non-success): refusal-vs-refusal across
oracles counts as **agreement** in the G8 cross-agreement matrix when
both gold engines refuse the same input.

## Re-run

```sh
bun bench/besselj-anchor/oracles/arb/adapter.ts
```

Wall-time on a 2024-era laptop: ~5 s (well under the 5-15 min estimated in
the bead description — Arb is fast, and the auto-bump retry only kicks in
on ~18% of rows). The dominant per-row cost is the T6-cell precision-cliff
bump retries.

## Determinism

Arb's ball arithmetic at a given `ctx.dps` is deterministic given the
`(input, dps)` bytes. The midpoint and radius are bit-identical across
re-runs on the same FLINT version. Verified by diffing two consecutive
runs: every field except `elapsed_ms` and the envelope `generated_at`
is byte-identical. `elapsed_ms` is wall-time noise; the math is reproducible.

Re-runs across machines: byte-identical given the same FLINT version
(FLINT C arithmetic is deterministic across architectures; `python-flint`
is a thin wrapper that does no extra rounding).

## Landmines mitigated (R5 §6)

- **L9** (K_ν underflow at z > 700): Arb's ball arithmetic handles this
  gracefully — `K_0(1500)` returns `[1.17e-653 +/- 4.12e-713]`, a valid
  ball with tight radius. Scaled variant path is the auto-bump beneficiary.
- **L10** (I_ν overflow at z > 700): same — `I_50(1)` returns `[2.93e-80 +/-
  3.77e-140]`. Native `scaled=True` path handles overflow regime.
- **L3** (negative-real-ν branch convention): Arb follows DLMF §10.4.1
  (the `+sin(νπ)·J_ν` connection — verified in adapter probe transcript
  pinned in source comments). The adapter does not second-guess.
- **L11** (trailing-noise digits at emit floor): for Arb this is NOT a
  landmine — the radius IS the trailing-noise quantification. G8 uses
  Arb's radius to compute the legitimate digit-agreement floor for
  Wolfram-vs-mpmath comparisons.
- **L8** (integer-vs-near-integer-ν algorithm switch): Arb is a single
  dispatch family (`acb_hypgeom`); no observable integer/non-integer
  split. This makes Arb the canonical reference for that band.
- **K_ν / Y_ν singular points**: honest refusal per ADR-0040 §"Decision 3".

## Failure mode

If `python3 -c 'import flint; ...'` fails (python-flint missing, broken
Python, sandboxing), the adapter:

1. appends a timestamped diagnostic block to this README;
2. writes nothing to `results.json`;
3. exits non-zero.

This is CLAUDE.md Rule 1 ("fail fast, fail loud") + ADR-0040's "no
fabricated values on import failure" discipline. Do NOT silently skip
and produce an empty results file.

## File layout

```
bench/besselj-anchor/oracles/arb/
  adapter.ts      # this adapter (Bun TS subprocess orchestrator)
  README.md       # this file
  results.json    # generated by the adapter; 1766-row gold-master output
```

## What to do if a future row regresses

If a re-run produces a different result for a row, the cause is one of:

1. **FLINT version bump.** Check `oracle_version` in `results.json` vs
   the new run; if FLINT moved, the bit-identical property is no longer
   guaranteed across the version boundary. File a finding, don't paper
   over it.
2. **python-flint version bump.** Same as above with `flint.__version__`.
3. **Corpus change.** Check `corpus_generated_at` and `corpus_seed`. The
   corpus is byte-identical-by-construction (G1 ships a Park-Miller LCG
   at a pinned seed); any change is intentional and should bump the
   corpus manifest version.

In all three cases, the right move is to file a beads issue, not to
silently rewrite `results.json`.
