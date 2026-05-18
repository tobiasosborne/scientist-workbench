# mpmath oracle adapter (G3)

**Bead:** `scientist-workbench-m7q0` (Phase 1 — G3, gold tier).
**ADR:** [`docs/adr/0040-per-head-special-function-substrate-and-meijer-g-bridge.md`](../../../../docs/adr/0040-per-head-special-function-substrate-and-meijer-g-bridge.md) §"Decision 8".
**R5 source:** [`docs/refs/erf-research/R5-oracle-landscape.md`](../../../../docs/refs/erf-research/R5-oracle-landscape.md) §2.2 (mpmath worked example).
**Sibling oracle:** Wolfram Mathematica (G2) — the second gold-tier voice. The
two engines IS the cross-validation baseline R5 §"Headline finding"
established three-way agreement on.

## What this is

A Bun TypeScript adapter that:

1. reads `bench/erf-anchor/corpus.json` (271 inputs across 8 tiers and 6 heads);
2. spawns `python3` ONCE with a batched mpmath script;
3. emits `results.json` with arb-prec golden-master values at 55 decimal
   digits each.

## Probed versions

```text
$ python3 --version
Python 3.12.3
$ python3 -c 'import mpmath; print(mpmath.__version__)'
1.3.0
```

Both versions are recorded inside every `results.json` record
(`oracle_version`, `python_version`) so a future agent can reproduce.

## Precision discipline — 60 dps compute, 55 dp emit

- `mp.dps = 60`: 10 decimal digits above the gold-tier target of 50.
  This absorbs mpmath's internal rounding at dispatch boundaries
  (e.g. its `erfc` mid-asymptotic crossover near `|x| ≈ 6`).
- `mpmath.nstr(value, 55, strip_zeros=False)`: 5 decimal digits above the
  gold-tier target. Trimming 5 dps off the working precision sheds the
  trailing-noise residue from mpmath's last-digit rounding so that — when
  the G8 cross-agreement comparator compares mpmath to Wolfram — both
  oracles' emitted strings have shed their last-digit rounding-mode
  noise.

The choice is documented at the head of `adapter.ts`. **Do not change it
without updating G8.**

### The landmine this margin addresses (ADR-0040 §"Decision 8 landmine 2")

mpmath's `nstr` rounds-to-nearest; Wolfram's `N[]` truncates. Without
the 5-dp emit-vs-compute margin, the 50th displayed digit can differ by
1 ULP between the two oracles even when both are internally correct.
The 60/55 spread + the G8 canonicalisation step closes the gap.

## Coverage

After running the adapter against the v0.1 corpus:

```text
total inputs: 271
successful:   269
refused:        2  (Erfc and Erfcx at z = MAX_DOUBLE = 1.7976...e+308)
elapsed:    ~635 ms
```

Both refusals are honest: the composition `erfcx(z) = exp(z²)·erfc(z)`
overflows mpmath's int→float bridge when `z² > 2^1023`, and even
mpmath's native `erfc` at such inputs internally triggers the same
overflow path. These are recorded with `failure_reason` set; the G8
cross-agreement comparator must compare refusal-vs-refusal as agreement
when both gold oracles refuse the same input.

## Function-call discipline

mpmath ships `mp.erf`, `mp.erfc`, `mp.erfi`, and `mp.erfinv` directly.
For two heads in the corpus mpmath has no native function:

- **`Erfcx(z) = exp(z²) · erfc(z)`** — composed. Both operands are
  computed independently at `mp.dps = 60`; the product is correctly
  rounded to `mp.dps`. ADR-0040 §"Decision 3" warns NOT to derive
  `bigErfcx` this way *in the substrate* (catastrophic cancellation
  in the substrate's float64 hand-off path), but for the *oracle*
  the composition is fine — mpmath holds full precision through the
  multiply. Refuses on `z = MAX_DOUBLE` (overflow).
- **`InverseErfc(y) = erfinv(1 - y)`** — composed. For `y ∈ (0, 2)`
  the subtraction `1 - y` is exact at 60 dps and the corpus's smallest
  `y` is `1e-50`, leaving ~10 dps of margin. Newton convergence inside
  mpmath's `erfinv` is quadratic and bounded by `mp.dps`.

These two compositions are documented in the adapter's `evaluate`
dispatch.

## Edge-case sentinels

Corpus T6 emits `Infinity`, `-Infinity`, and `NaN` tokens for inputs that
have no finite decimal representation. The adapter parses these to
`mpmath.inf`, `-mpmath.inf`, and `mpmath.nan` respectively, runs the
target head, and emits the same tokens back when mpmath returns
infinite or NaN values. Observed:

| Input                       | Erf      | Erfc     | Erfcx        | Erfi       |
|-----------------------------|----------|----------|--------------|------------|
| `+0` / `-0` / subnormal     | `0.0`    | `1.0`    | `1.0`        | `0.0`      |
| `+Infinity`                 | `1.0`    | `0.0`    | `NaN`        | `Infinity` |
| `-Infinity`                 | `-1.0`   | `2.0`    | `Infinity`   | `-Infinity`|
| `NaN`                       | `NaN`    | `NaN`    | `NaN`        | `NaN`      |
| `MAX_DOUBLE` (1.79...e+308) | `1.0`    | *refused*| *refused*    | `1.38...e+14035097408404254459...` (huge but finite) |

`Erfcx(+∞) = NaN` is the mathematically-honest answer for the
composition `exp(∞²)·erfc(∞) = ∞·0` (indeterminate as a literal
product). The analytic limit IS `0`, but the substrate (ADR-0040
§"Decision 3") computes Erfcx via the Karbach-Weideman direct path
rather than the composition for exactly this reason.

## Re-run

```sh
bun bench/erf-anchor/oracles/mpmath/adapter.ts
```

Determinism: byte-identical re-runs given identical `corpus.json` +
identical mpmath / python3 versions. Both versions are inside every
result record.

## Failure mode

If `python3 -c 'import mpmath'` fails (mpmath missing, broken Python,
sandboxing) the adapter:

1. appends a timestamped diagnostic block to this README;
2. writes nothing to `results.json`;
3. exits non-zero.

This is the CLAUDE.md Rule 1 ("fail fast, fail loud") discipline. Do
NOT silently skip and produce an empty results file.
