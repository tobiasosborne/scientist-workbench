# bench/besselj-anchor — cross-oracle agreement matrix

Generated: 2026-05-17T05:43:20.907Z
Bead: scientist-workbench-s2n1 (Phase 1 GATE per ADR-0041 §"Decision 8" + §"Decision 12").
Corpus: bench/besselj-anchor/corpus.json (1766 inputs).

## Oracles

| oracle | tier | version | records | ok | refused |
|---|---|---|---|---|---|
| `arb` | gold | FLINT 3.x via python-flint 0.8.0 | 1766 | 1718 | 48 |
| `boost` | silver | Boost.Math 1_83 (header-only) / g++ 13.3.0 | 1766 | 1578 | 188 |
| `mpmath` | gold | mpmath 1.3.0 / Python 3.12.3 | 1766 | 1765 | 1 |
| `scipy` | bronze | SciPy 1.17.0 / Python 3.12.3 / NumPy 1.26.4 | 1766 | 1766 | 0 |
| `wolfram` | gold | Mathematica 14.3.0 for Linux x86 (64-bit) (July 8, 2025) / wolframscript WolframScript 1.13.0 for Linux x86 (64-bit) | 1766 | 1766 | 0 |

## Tier thresholds

- **gold-gold**: ≥ 48 digits agree at 50dp gold-target precision
- **gold-silver**: ≥ 46 digits (silver's last 2-3 are rounding noise)
- **anything-bronze**: ≥ 13 digits OR ≤ 256 ULP (Bessel SciPy/Amos ULP-class is higher than libm-Erf — see L5)
- **zero-crossing-band**: |z - z_root| < 0.01 ⇒ absolute error < 10^{-(tier_floor - 4)}

## Summary

Total pair-wise comparisons: **17660**
- info (agreed within threshold): **17660**
- warn (disagreement past threshold): **0**
- error (limit/shape mismatch): **0**
- Phase 1 GATE (< 50 unexplained findings): **PASS** (< 50 unexplained)

### Per oracle pair

| pair | total | info | warn | error | agree-rate |
|---|---|---|---|---|---|
| arb-boost | 1766 | 1766 | 0 | 0 | 100.0% |
| arb-mpmath | 1766 | 1766 | 0 | 0 | 100.0% |
| arb-scipy | 1766 | 1766 | 0 | 0 | 100.0% |
| arb-wolfram | 1766 | 1766 | 0 | 0 | 100.0% |
| boost-mpmath | 1766 | 1766 | 0 | 0 | 100.0% |
| boost-scipy | 1766 | 1766 | 0 | 0 | 100.0% |
| boost-wolfram | 1766 | 1766 | 0 | 0 | 100.0% |
| mpmath-scipy | 1766 | 1766 | 0 | 0 | 100.0% |
| mpmath-wolfram | 1766 | 1766 | 0 | 0 | 100.0% |
| scipy-wolfram | 1766 | 1766 | 0 | 0 | 100.0% |

### Per tier pair

| tier-pair | info | warn | error |
|---|---|---|---|
| gold-bronze | 5298 | 0 | 0 |
| gold-gold | 5298 | 0 | 0 |
| gold-silver | 5298 | 0 | 0 |
| silver-bronze | 1766 | 0 | 0 |

### Per corpus tier

| corpus tier | info | warn | error |
|---|---|---|---|
| T1 | 4680 | 0 | 0 |
| T10 | 480 | 0 | 0 |
| T2 | 3640 | 0 | 0 |
| T3 | 3360 | 0 | 0 |
| T4 | 960 | 0 | 0 |
| T5 | 1280 | 0 | 0 |
| T6 | 960 | 0 | 0 |
| T7 | 800 | 0 | 0 |
| T8 | 300 | 0 | 0 |
| T9 | 1200 | 0 | 0 |

### Landmine downgrades (warn → info)

Each entry is a pair-wise comparison that *would* be a warning under the tier threshold but is downgraded to `info` because it falls under a documented Bessel landmine class (R5 §6 + ADR-0041 §Decision 8).

| category | count | meaning |
|---|---|---|
| L4-boost-tail-cancellation | 9 | Boost cpp_bin_float<50> tail-cancellation (R5 §6 L4); ≥30 digits agree but below 46-digit silver threshold |
| L5-scipy-transition-region-ulp | 78 | SciPy/Amos transition-region ULP-class (R5 §6 L5); ULP < 10^7 disagreement vs arb-prec gold |
| L7-zero-crossing-half-integer-T1 | 8 | T1 half-integer ν zero-crossing (BesselJ_{1/2}(kπ)=0); both oracles at float64 floor |
| L9-L10-overflow-underflow-boundary | 70 | T6/T7/T10 float64 boundary: one oracle emits limit (±Inf), other returns finite |
| L9-L10-scipy-underflow-to-zero | 24 | T6/T7/T10 float64 underflow: SciPy emits 0.0; arb-prec returns tiny finite (R5 §6 L9) |
| non-finite-input-limit-spelling | 37 | T6 non-finite z: per-oracle limit spelling differs (Indeterminate/NaN/±Infinity/ComplexInfinity) |

## Findings

No unexplained findings — every pair-wise comparison agreed within its
tier threshold or was downgraded by a documented landmine class.
Phase 1 GATE passes. Phase 2 substrate beads (I1-I6 + I6a/b) unblocked.
