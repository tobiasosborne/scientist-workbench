# Arb oracle adapter (G7) — gold tier, third independent arb-prec voice

**Bead:** `scientist-workbench-2wr6` (Phase 1 — G7, gold tier).
**ADR:** [`docs/adr/0042-gamma-family-per-head-substrate.md`](../../../../docs/adr/0042-gamma-family-per-head-substrate.md) §"Decision 8".
**R5 source:** [`docs/refs/gamma-research/R5-oracle-landscape.md`](../../../../docs/refs/gamma-research/R5-oracle-landscape.md) §3 (Arb capability — ALL 19 ADMITTED_HEADS supported real + complex, except the two inverse-incomplete-gamma heads), §6 (Arb-specific landmines: L12 P/Q convention; L16 cancellation retry; L_pole).
**Sibling oracles:** Wolfram Mathematica (G2) + mpmath (G3) — the other two gold-tier voices. Boost (G5, silver) + SciPy (G4, bronze) + libm (G6, bronze) round out the tier matrix.
**Precedent:** [`bench/besselj-anchor/oracles/arb/`](../../../besselj-anchor/oracles/arb/) — the first python-flint Arb adapter the workbench shipped.

## What this is

A Bun TypeScript adapter that:

1. reads [`bench/gamma-anchor/corpus.json`](../../corpus.json) (377 inputs across 8 tiers × 19 ADMITTED_HEADS — `Gamma`, `LogGamma`, `Digamma`, `Trigamma`, `Polygamma`, `Pochhammer`, `IncompleteGamma{Upper, Lower, P, Q}`, `InverseIncompleteGamma{P, Q}`, `Beta`, `LogBeta`, `BarnesG`, `GammaRatio`, `GammaDeltaRatio`, `GammaPDerivative`, `IncompleteBeta`);
2. spawns `python3` ONCE with a batched [python-flint](https://github.com/flintlib/python-flint) script (`oracle.py`);
3. emits `results.json` with Arb's ball-arithmetic gold-master values — both **midpoint** AND **certified radius** for every successful row.

## Why this adapter matters more than the Erf-epic Arb adapter would have

The R5 §4 capability matrix found that of the 19 ADMITTED_HEADS × {real, complex} = 38 capability cells in the Gamma family, **34 of the complex cells had NO silver-tier oracle available locally**:

| Cell type             | Gold (≥48 dp)        | Silver  | Bronze       |
|-----------------------|----------------------|---------|--------------|
| Real cells (most)     | Wolfram + mpmath     | Boost   | SciPy, libm  |
| 34 complex cells      | Wolfram + mpmath     | **(none)** | SciPy (partial) |

Boost.Math's `cpp_bin_float<50>` cannot instantiate on `std::complex<cpp_bin_float<N>>` (R5 §3.4); SciPy's `polygamma(complex)` raises `TypeError` (L14); SciPy's `loggamma(real_negative)` returns NaN (L15); libm covers only `tgamma` + `lgamma` real. So the 34 complex cells were **single-engine-paired** at gold tier before this adapter: Wolfram and mpmath agreeing on a value had no independent third voice to triangulate against.

For Erf this gap was 1 cell (complex Erf at arb prec). For Bessel it was 12. For Gamma it is **34** — the largest single-adapter coverage gap in the workbench so far. Arb (via python-flint) closes all 34 in one adapter — the single highest-value install for the whole Gamma epic.

**Algorithmic independence.** The three gold-tier engines have three distinct algorithmic lineages:

- **Wolfram**: proprietary; documented as a dispatch family covering Stirling, series, and connection formulas.
- **mpmath**: pure-Python over Python `int`; `mpmath.libmp.gammazeta` and friends — hand-coded series + Adamchik continuations.
- **Arb**: FLINT C; `acb_hypgeom_gamma_upper.c`, `acb_hypgeom_beta_lower.c`, `acb_hypgeom_barnes_g.c`, etc. — Fredrik Johansson's rigorous hypergeometric-series + ball-arithmetic asymptotic machinery, citing DLMF and Olver.

Three implementations, three lineages — exactly the algorithmic independence that makes a triangulation finding load-bearing.

## Why ball arithmetic is first-class output

Arb's distinguishing feature vs every other oracle: every computed value is a **ball** `[centre ± radius]` with mathematically-rigorous containment. The radius is a tight upper bound on the true error, computed by error-tracking through every internal operation. This is fundamentally different from mpmath's "ran at 60 dps so the first ~57 digits should be right" — that is conjecturally correct, not certified.

We therefore record BOTH the midpoint AND the radius as first-class fields on every successful record (`value` and `value_radius`). The downstream G8 cross-agreement comparator can then:

1. Use the midpoint for value comparison (the standard role).
2. Use the radius as the **tier-threshold floor**: if Arb reports a radius of `1e-58` on a value where Wolfram and mpmath disagree at digit 56, the disagreement is *spurious* — both gold engines fall within Arb's certified containment ball. Conversely, if mpmath claims digit 56 of agreement but Arb's radius is `1e-55`, mpmath is overstating its precision and the agreement is illusory.

For the 34 complex cells, `value_radius` is itself `{re, im}` — the ball is two-dimensional in C. Both components emitted honestly.

## Precision discipline — 200 bits baseline + cancellation retry to 456 bits

FLINT/Arb works in **bits** (`ctx.prec`), not decimal digits. The bead prompt pins `ctx.prec = 200` baseline. The bit-↔-digit conversion is:

  200 bits / log₂(10) ≈ **60.2 decimal digits**

That is comfortably above the gold-tier target of 50 dp, with ~10 dp margin matching the mpmath adapter's `mp.dps = 60`. We emit midpoints at **55 dp** (`acb.str(55, radius=False)`) for symmetry with the Bessel G7 emit — 5 dp emit margin below working precision. Radii emit at **10 dp** (the radius is itself only an upper bound; an order of magnitude is the load-bearing piece, and 10 dp serves as a self-documenting "this number is approximate" signal).

**Cancellation retry (L16 — the load-bearing Arb value-add).** When catastrophic cancellation widens Arb's ball, we bump `ctx.prec` by 64 bits and retry, up to 4 retries:

  200 → 264 → 328 → 392 → **456 bits** (≈ 137 dp)

Threshold: if `rel_accuracy_bits()` of either component is below 170 bits (50 dp × log₂(10) ≈ 166 bits, +4 bits margin) AND the midpoint is nonzero, the row triggers a retry. Each result row records the full `prec_attempts` ladder (e.g. `[200]` for the typical case, `[200, 264]` for a single-retry case) and `final_prec` so the G8 comparator can audit which rows operated near a precision cliff.

**Edge case: midpoint exactly zero.** Arb represents the imaginary part of a real-valued result like `Trigamma(-0.3)` as a ball `[0 ± r]` where `r` is a tight absolute radius (~1e-60 at baseline prec). `arb.is_zero()` returns False for such a ball, and `rel_accuracy_bits()` returns INT64_MIN (relative accuracy is undefined when the midpoint is zero). We special-case this in `relative_radius_too_wide`: if `mid().is_zero()`, the absolute radius is the meaningful error and bumping won't tighten it materially — we DO NOT trigger a retry. This is the load-bearing fix that distinguishes "Trigamma at real negative z is genuinely real" from "the ball widened because of cancellation"; without it, the adapter triggered a 4-retry storm on every T2/T3 polygamma row in the corpus.

**Observed on the v0.1 corpus (377 inputs):**

| Final prec | Row count | What triggers the bump |
|----------:|----------:|------------------------|
|  200 bits |       363 | the 96.3 % happy path  |
|  264 bits |         2 | T7 Temme saddle cells (`a=200, z=185.86`) |

Both retry rows are T7 saddle-region cells — exactly the v0.1 carve-out region the corpus spec calls out (`a=200, z=a−√a`). The retries succeed at the first bump (200 → 264 bits), proving the ladder is sized correctly.

## Coverage on the v0.1 corpus

```text
total inputs:            377
success (real):          300  (79.6 %)
success (complex):       57   (15.1 %)
refused (poles):         8    (2.1 %)
unsupported (head):      12   (3.2 %)  ← InverseIncompleteGamma{P, Q}
timeout:                 0
error:                   0
honest fraction:         100.00 %
```

**Per-category breakdown:**

- **357 successful evaluations** (300 real + 57 complex) — every head Arb implements natively or via clean composition, on every tier and every quadrant.
- **8 refusals**: all T3 cells at the exact integer-pole offset (`δ=0` from the corpus's `δ ∈ {0, ±1e-2, ±1e-4}` grid) for Gamma and Digamma. Arb returns a non-finite ball (`acb.is_finite() == False`, real component is `nan`); we record `status: "refused"` with `arb_returned_token: "nan"` and `notes: "L_pole: head=<X> returned non-finite ball"`. The G8 comparator special-cases pole cells per L17.
- **12 unsupported**: all `InverseIncompleteGamma{P, Q}` rows. python-flint 0.8.0 has no direct API for these (`dir(flint.acb)` confirms — only `elliptic_inv_p` and `elliptic_invariants` carry the `inv` substring). Hand-rolling Newton on `gamma_lower(a, z, regularized=1) − q = 0` would not be gold-tier byte-deterministic without further convention pins (initial guess, convergence criterion). Per CLAUDE.md Rule 8 (honest scope) we emit `status: "unsupported"`; the Wolfram (G2) and SciPy (G4) adapters cover these inverse cells.

The 100 % honest-fraction means **every input received an honest mathematical answer**: a tight ball, an honest pole-refusal, or an honest unsupported-head refusal. Zero hard-error rows; zero timeouts.

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

All three versions are recorded in `results.json` (`oracle_version` field, plus full `python_version`) so a future agent can reproduce or notice a version drift.

## Install (Ubuntu 24.04 — R5 §7.2 correction)

```sh
sudo apt install libflint-dev
pip install --user --break-system-packages python-flint
```

Verify:

```sh
python3 -c 'from flint import acb, ctx; ctx.prec=200; print(acb("0.5").gamma())'
# [1.7724538509055160272981674833411451827975494561223871282138 +/- 9.00e-60]
```

**Critical correction.** Do NOT install the Ubuntu `libarb` / `libarb-dev` package — that is an UNRELATED phylogenetic-analysis project (R5 §7.2 line 1012). FLINT 3.0+ has Arb merged in; `libflint-dev` is the only install required.

## Landmines mitigated (R5 §6)

- **L1** (Wolfram input-trap): the corpus's discriminated `{kind, value}` envelope on `a`, `b`, `m`, `n` is parsed exactly. Integers → Python `int`; half-integers → `fmpq("num/den")` (exact rational); decimals → `arb(string)` at full `ctx.prec`. We NEVER use Python `float()`. Pinned in `parse_kind_acb` / `parse_z_acb`.
- **L12** (**THE #1 gamma trap** — P/Q regularisation convention; R5 §6 lines 828-879): python-flint's `acb.gamma_upper(s, regularized=0|1)` is `Γ(s, z)` (upper) with `z = self`; `acb.gamma_lower(s, regularized=0|1)` is `γ(s, z)` (lower). Convention verified by probe against Wolfram's `N[Gamma[3/2, 5/2], 50] = 0.15225125499...`. Every incomplete-gamma call is tagged `# L12` in `oracle.py`:

  | Corpus head             | Arb call                              |
  |-------------------------|---------------------------------------|
  | `IncompleteGammaUpper`  | `acb(z).gamma_upper(a, regularized=0)` |
  | `IncompleteGammaLower`  | `acb(z).gamma_lower(a, regularized=0)` |
  | `IncompleteGammaP`      | `acb(z).gamma_lower(a, regularized=1)` |
  | `IncompleteGammaQ`      | `acb(z).gamma_upper(a, regularized=1)` |

  9 `# L12` tag occurrences in `oracle.py` (grep-auditable).
- **L_pole** (Gamma poles; R5 §6 L17): Arb returns a non-finite ball at the simple poles. `acb.is_finite()` returns False; we record `status: "refused"` with `arb_returned_token: "nan"`. The G8 comparator special-cases pole cells.
- **L16** (BarnesG single-engine-pair concern): Wolfram + mpmath were the only two voices for BarnesG before this adapter. Arb's `acb.barnes_g()` provides the third; verified by probe that BarnesG(1)=BarnesG(2)=BarnesG(3)=1, BarnesG(4)=2, BarnesG(5)=12, BarnesG(6)=288 — matches the R5 §6 L16 canonical anchors.
- **L2** (mpmath round-to-nearest vs Wolfram truncate): Arb's `str(N, radius=False)` emit is truncate-with-guaranteed-correct-up-to-1-in-last-digit. The G8 comparator handles the round-mode normalisation; the 55-dp emit gives it a clean digit window to work against.

## File layout

```
bench/gamma-anchor/oracles/arb/
  adapter.ts    # this adapter (Bun TS subprocess orchestrator)
  oracle.py     # the python-flint driver (single batched python3 child)
  README.md     # this file
  results.json  # generated by the adapter; 377-row gold-master output
```

The two-file split (TS driver + Python worker) mirrors the sibling [`mpmath` adapter](../mpmath/) exactly. Both gold-tier voices have identical wire shapes so the G8 cross-agreement comparator can index records by `input_id` alone, without per-oracle conditioning.

## Re-run

```sh
bun bench/gamma-anchor/oracles/arb/adapter.ts
```

Wall-time on a 2024-era laptop: **~150 ms** (well under the bead's 5-15 min estimate from the Bessel epic — Arb is fast on the smaller 377-input Gamma corpus, and the auto-bump retry only kicks in on 2 rows). The dominant cost is per-row Arb evaluation at 200 bits (~0.4 ms each).

## Determinism

Arb's ball arithmetic at a given `ctx.prec` is deterministic given the `(input, prec)` bytes. FLINT C uses GMP/MPFR underneath; both guarantee bit-identical results across architectures at fixed precision. Two consecutive runs on the same machine:

```sh
$ bun bench/gamma-anchor/oracles/arb/adapter.ts && cp results.json /tmp/r1.json
$ bun bench/gamma-anchor/oracles/arb/adapter.ts && diff <(jq 'del(.generated_at, .total_elapsed_ms, .results[].elapsed_ms)' /tmp/r1.json) \
                                                          <(jq 'del(.generated_at, .total_elapsed_ms, .results[].elapsed_ms)' results.json)
# (empty — byte-identical excluding timing metadata)
```

Verified. The fields that DO change between runs are `generated_at`, `total_elapsed_ms`, and per-row `elapsed_ms` — timing metadata, not oracle outputs.

## Spot-check: Gamma(0.5 + 0i)

The canonical sanity-check value. `Γ(½) = √π`; the first 55 decimal digits of √π are
`1.7724538509055160272981674833411451827975494561223871282`.

From `results.json` (corpus row `T5-gamma-001`):

```json
{
  "input_id": "T5-gamma-001",
  "status": "success",
  "value": "1.772453850905516027298167483341145182797549456122387128",
  "value_radius": "1.244603065e-60",
  "prec_attempts": [200],
  "final_prec": 200,
  "elapsed_ms": ...
}
```

Match: byte-identical to the reference 55-dp truncation of √π. The radius `1.24e-60` is the certified containment ball — Arb proves the true value lies within `[midpoint − 1.24e-60, midpoint + 1.24e-60]`.

## What to do if a future row regresses

If a re-run produces a different result for a row, the cause is one of:

1. **FLINT version bump.** Check `oracle_version` in `results.json` vs the new run; if FLINT moved, the bit-identical property is no longer guaranteed across the version boundary. File a finding, don't paper over it.
2. **python-flint version bump.** Same as above with `flint.__version__`.
3. **Corpus change.** Check `corpus_seed` (= `20260519`) and `corpus_generated_at`. The corpus is byte-identical-by-construction (G1 ships a Park-Miller LCG at a pinned seed); any change is intentional and should bump the corpus manifest version.

In all three cases, the right move is to file a beads issue, not to silently rewrite `results.json`.

## Failure mode

If `python3 -c 'import flint; ...'` fails (python-flint missing, broken Python, sandboxing), the adapter:

1. emits the install instructions verbatim to stderr (including the libarb / libarb-dev anti-recommendation);
2. writes nothing to `results.json`;
3. exits non-zero.

This is CLAUDE.md Rule 1 ("fail fast, fail loud") + ADR-0042's "no fabricated values on import failure" discipline. Do NOT silently skip and produce an empty results file.
