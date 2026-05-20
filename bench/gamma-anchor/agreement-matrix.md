# PHASE 1 GATE: PASS (0 unexplained, threshold 50)

# bench/gamma-anchor — cross-oracle agreement matrix

Generated: 2026-05-20T06:56:32.213Z
Bead: scientist-workbench-fab6 (Phase 1 GATE per ADR-0042 §"Decision 8" + R5 §6).
Corpus: bench/gamma-anchor/corpus.json (377 inputs).

## Phase 1 Gate Verdict

**PASS** — 0 unexplained findings (threshold 50). Phase 2 substrate beads unblocked.

## Oracles

| oracle | tier | version | records | ok | refused |
|---|---|---|---|---|---|
| `arb` | gold | python-flint 0.8.0 / FLINT C 3.0.1 (Ubuntu libflint-dev 3.0.1-3.1build1) | 377 | 357 | 20 |
| `boost` | silver | Boost.Math 1_83 (header-only) / g++ 13.3.0 | 377 | 295 | 82 |
| `mpmath` | gold | mpmath 1.3.0 / Python 3.12.3 | 377 | 357 | 20 |
| `scipy` | bronze | SciPy 1.17.0 / Python 3.12.3 / NumPy 1.26.4 | 377 | 342 | 35 |
| `wolfram` | gold | Mathematica 14.3.0 for Linux x86 (64-bit) (July 8, 2025) / wolframscript WolframScript 1.13.0 for Linux x86 (64-bit) | 377 | 377 | 0 |

## Tier thresholds

- **gold-gold**: ≥ 48 digits agree at 50dp gold target (60dp working precision; L2/L11 last 2 digits noise)
- **gold-silver**: ≥ 46 digits (Boost cpp_bin_float<50> carries 1-2 ULP at the 50dp boundary)
- **any-bronze**: ≥ 13 digits OR ≤ 256 ULP (SciPy float64 ~15.95 digits; ULP envelope absorbs L_polynew_4 transition noise)
- **zero-crossing-band**: abs-error comparison when both values canonicalise to zero or one is below tier floor
- **within-arb-radius**: disagreement within 2 · Arb value_radius — inside the certified containment ball

## Summary

Total pair-wise comparisons: **3770**
- agreed (value within tier threshold): **3102**
- agreed_refusal (both refused): **71**
- explained (landmine downgrade): **597**
- disagreed_within_tier (warn but within wider band): **0**
- unexplained (real findings): **0**

### Per oracle pair

| pair | total | agreed | explained | unexplained | agree-rate |
|---|---|---|---|---|---|
| arb-boost | 377 | 277 | 100 | 0 | 73.5% |
| arb-mpmath | 377 | 377 | 0 | 0 | 100.0% |
| arb-scipy | 377 | 310 | 67 | 0 | 82.2% |
| arb-wolfram | 377 | 357 | 20 | 0 | 94.7% |
| boost-mpmath | 377 | 277 | 100 | 0 | 73.5% |
| boost-scipy | 377 | 304 | 73 | 0 | 80.6% |
| boost-wolfram | 377 | 281 | 96 | 0 | 74.5% |
| mpmath-scipy | 377 | 310 | 67 | 0 | 82.2% |
| mpmath-wolfram | 377 | 357 | 20 | 0 | 94.7% |
| scipy-wolfram | 377 | 323 | 54 | 0 | 85.7% |

### Per head

| head | total | agreed | explained | unexplained |
|---|---|---|---|---|
| BarnesG | 110 | 44 | 66 | 0 |
| Beta | 130 | 118 | 12 | 0 |
| Digamma | 600 | 512 | 88 | 0 |
| Gamma | 420 | 377 | 43 | 0 |
| GammaDeltaRatio | 20 | 20 | 0 | 0 |
| GammaPDerivative | 40 | 40 | 0 | 0 |
| GammaRatio | 20 | 20 | 0 | 0 |
| IncompleteBeta | 60 | 60 | 0 | 0 |
| IncompleteGammaLower | 260 | 200 | 60 | 0 |
| IncompleteGammaP | 180 | 180 | 0 | 0 |
| IncompleteGammaQ | 240 | 240 | 0 | 0 |
| IncompleteGammaUpper | 360 | 300 | 60 | 0 |
| InverseIncompleteGammaP | 60 | 24 | 36 | 0 |
| InverseIncompleteGammaQ | 60 | 24 | 36 | 0 |
| LogBeta | 40 | 40 | 0 | 0 |
| LogGamma | 280 | 212 | 68 | 0 |
| Pochhammer | 200 | 120 | 80 | 0 |
| Polygamma | 290 | 266 | 24 | 0 |
| Trigamma | 400 | 376 | 24 | 0 |

### Per corpus tier

| tier | total | agreed | explained | unexplained |
|---|---|---|---|---|
| T1 | 920 | 782 | 138 | 0 |
| T2 | 430 | 366 | 64 | 0 |
| T3 | 540 | 457 | 83 | 0 |
| T4 | 400 | 184 | 216 | 0 |
| T5 | 400 | 368 | 32 | 0 |
| T6 | 280 | 268 | 12 | 0 |
| T7 | 400 | 376 | 24 | 0 |
| T8 | 400 | 372 | 28 | 0 |

### Landmine downgrades (warn → info)

Each entry is a pair-wise comparison that *would* be a warning under the tier threshold but is downgraded to `info` because it falls under a documented Gamma landmine class (R5 §6 + ADR-0042 §Decision 8).

| category | count | meaning |
|---|---|---|
| L13-arb-no-inverse-incomplete-gamma | 36 | python-flint 0.8.0 has no native InverseIncompleteGamma{P,Q} |
| L13-mpmath-no-inverse-incomplete-gamma | 36 | mpmath has no native InverseIncompleteGamma{P,Q} (R5 §6 L13) |
| L14-scipy-complex-polygamma-known-refusal | 72 | SciPy 1.17 raises TypeError on complex polygamma/gammainc (R5 §6 L14) |
| L16-no-barnesg-bronze-or-silver | 66 | SciPy / Boost have no BarnesG primitive (R5 §6 L16) |
| L17-pole-asymmetric-refusal | 48 | Pole cell: oracles refuse differently (R5 §6 L17). All honest. |
| L17-pole-limit-vocabulary | 7 | Pole: oracles emit different limit tokens (ComplexInfinity / Infinity / NaN / −Infinity) per R5 §6 L17 |
| L18-boost-digamma-negative-half-integer | 4 | Boost.Math 1.83 digamma is wrong at negative half-integers — reflects to ψ(1/2) instead of ψ(3/2) (DLMF §5.4.13). arb/mpmath/scipy/wolfram + workbench digamma all correct; upstream Boost bug. |
| L_T3_cancellation_stress | 12 | T3 reflection-formula cancellation (ADR-0042 §Decision 3); SciPy float64 cannot bump precision |
| L_T8_digamma_cancellation_stress | 12 | T8 digamma reflection cancellation (corpus-spec.md §T8) |
| L_boost_loggamma_real_only | 52 | Boost lgamma returns log|Γ| (real part only) at negative-real z; gold tier returns analytic continuation (ADR-0042 §LogGamma-real-x<0) |
| L_polynew_4_float64_overflow | 24 | SciPy float64 overflows on unregularised IncompleteGamma{Upper,Lower} at large a; gold/silver return finite |
| boost-beta-positive-args-only | 12 | Boost beta requires a, b > 0 (R5 §3.4); other oracles handle analytic continuation |
| boost-no-complex | 136 | Boost cpp_bin_float has no std::complex instantiation (R5 §3.4) |
| boost-no-pochhammer | 80 | Boost has no Pochhammer primitive (R5 §3.4) |

## Findings (597 total)

Findings include both `unexplained` (real candidate substrate-bugs) and `explained` (landmine-downgraded, info severity, included here for audit).

Per ADR-0042 §Decision 8 thresholds (gold-gold ≥ 48 digits, gold-silver ≥ 46, any-bronze ≥ 13 digits OR ≤ 256 ULP).

| class | input_id | tier | head | a | b | kind | detail | category |
|---|---|---|---|---|---|---|---|---|
| explained | T1-barnesg-001 | T1 | BarnesG | arb | boost | asymmetric-refusal | refused-by boost (boost-no-barnesg) | L16-no-barnesg-bronze-or-silver |
| explained | T1-barnesg-001 | T1 | BarnesG | arb | scipy | asymmetric-refusal | refused-by scipy (L16: SciPy has no barnesg; bronze tier cannot cover this head. Use Wolfram (G2) or mpmath (G3) for gold values.) | L16-no-barnesg-bronze-or-silver |
| explained | T1-barnesg-001 | T1 | BarnesG | boost | mpmath | asymmetric-refusal | refused-by boost (boost-no-barnesg) | L16-no-barnesg-bronze-or-silver |
| explained | T1-barnesg-001 | T1 | BarnesG | boost | wolfram | asymmetric-refusal | refused-by boost (boost-no-barnesg) | L16-no-barnesg-bronze-or-silver |
| explained | T1-barnesg-001 | T1 | BarnesG | mpmath | scipy | asymmetric-refusal | refused-by scipy (L16: SciPy has no barnesg; bronze tier cannot cover this head. Use Wolfram (G2) or mpmath (G3) for gold values.) | L16-no-barnesg-bronze-or-silver |
| explained | T1-barnesg-001 | T1 | BarnesG | scipy | wolfram | asymmetric-refusal | refused-by scipy (L16: SciPy has no barnesg; bronze tier cannot cover this head. Use Wolfram (G2) or mpmath (G3) for gold values.) | L16-no-barnesg-bronze-or-silver |
| explained | T1-barnesg-002 | T1 | BarnesG | arb | boost | asymmetric-refusal | refused-by boost (boost-no-barnesg) | L16-no-barnesg-bronze-or-silver |
| explained | T1-barnesg-002 | T1 | BarnesG | arb | scipy | asymmetric-refusal | refused-by scipy (L16: SciPy has no barnesg; bronze tier cannot cover this head. Use Wolfram (G2) or mpmath (G3) for gold values.) | L16-no-barnesg-bronze-or-silver |
| explained | T1-barnesg-002 | T1 | BarnesG | boost | mpmath | asymmetric-refusal | refused-by boost (boost-no-barnesg) | L16-no-barnesg-bronze-or-silver |
| explained | T1-barnesg-002 | T1 | BarnesG | boost | wolfram | asymmetric-refusal | refused-by boost (boost-no-barnesg) | L16-no-barnesg-bronze-or-silver |
| explained | T1-barnesg-002 | T1 | BarnesG | mpmath | scipy | asymmetric-refusal | refused-by scipy (L16: SciPy has no barnesg; bronze tier cannot cover this head. Use Wolfram (G2) or mpmath (G3) for gold values.) | L16-no-barnesg-bronze-or-silver |
| explained | T1-barnesg-002 | T1 | BarnesG | scipy | wolfram | asymmetric-refusal | refused-by scipy (L16: SciPy has no barnesg; bronze tier cannot cover this head. Use Wolfram (G2) or mpmath (G3) for gold values.) | L16-no-barnesg-bronze-or-silver |
| explained | T1-barnesg-003 | T1 | BarnesG | arb | boost | asymmetric-refusal | refused-by boost (boost-no-barnesg) | L16-no-barnesg-bronze-or-silver |
| explained | T1-barnesg-003 | T1 | BarnesG | arb | scipy | asymmetric-refusal | refused-by scipy (L16: SciPy has no barnesg; bronze tier cannot cover this head. Use Wolfram (G2) or mpmath (G3) for gold values.) | L16-no-barnesg-bronze-or-silver |
| explained | T1-barnesg-003 | T1 | BarnesG | boost | mpmath | asymmetric-refusal | refused-by boost (boost-no-barnesg) | L16-no-barnesg-bronze-or-silver |
| explained | T1-barnesg-003 | T1 | BarnesG | boost | wolfram | asymmetric-refusal | refused-by boost (boost-no-barnesg) | L16-no-barnesg-bronze-or-silver |
| explained | T1-barnesg-003 | T1 | BarnesG | mpmath | scipy | asymmetric-refusal | refused-by scipy (L16: SciPy has no barnesg; bronze tier cannot cover this head. Use Wolfram (G2) or mpmath (G3) for gold values.) | L16-no-barnesg-bronze-or-silver |
| explained | T1-barnesg-003 | T1 | BarnesG | scipy | wolfram | asymmetric-refusal | refused-by scipy (L16: SciPy has no barnesg; bronze tier cannot cover this head. Use Wolfram (G2) or mpmath (G3) for gold values.) | L16-no-barnesg-bronze-or-silver |
| explained | T1-barnesg-004 | T1 | BarnesG | arb | boost | asymmetric-refusal | refused-by boost (boost-no-barnesg) | L16-no-barnesg-bronze-or-silver |
| explained | T1-barnesg-004 | T1 | BarnesG | arb | scipy | asymmetric-refusal | refused-by scipy (L16: SciPy has no barnesg; bronze tier cannot cover this head. Use Wolfram (G2) or mpmath (G3) for gold values.) | L16-no-barnesg-bronze-or-silver |
| explained | T1-barnesg-004 | T1 | BarnesG | boost | mpmath | asymmetric-refusal | refused-by boost (boost-no-barnesg) | L16-no-barnesg-bronze-or-silver |
| explained | T1-barnesg-004 | T1 | BarnesG | boost | wolfram | asymmetric-refusal | refused-by boost (boost-no-barnesg) | L16-no-barnesg-bronze-or-silver |
| explained | T1-barnesg-004 | T1 | BarnesG | mpmath | scipy | asymmetric-refusal | refused-by scipy (L16: SciPy has no barnesg; bronze tier cannot cover this head. Use Wolfram (G2) or mpmath (G3) for gold values.) | L16-no-barnesg-bronze-or-silver |
| explained | T1-barnesg-004 | T1 | BarnesG | scipy | wolfram | asymmetric-refusal | refused-by scipy (L16: SciPy has no barnesg; bronze tier cannot cover this head. Use Wolfram (G2) or mpmath (G3) for gold values.) | L16-no-barnesg-bronze-or-silver |
| explained | T1-barnesg-005 | T1 | BarnesG | arb | boost | asymmetric-refusal | refused-by boost (boost-no-barnesg) | L16-no-barnesg-bronze-or-silver |
| explained | T1-barnesg-005 | T1 | BarnesG | arb | scipy | asymmetric-refusal | refused-by scipy (L16: SciPy has no barnesg; bronze tier cannot cover this head. Use Wolfram (G2) or mpmath (G3) for gold values.) | L16-no-barnesg-bronze-or-silver |
| explained | T1-barnesg-005 | T1 | BarnesG | boost | mpmath | asymmetric-refusal | refused-by boost (boost-no-barnesg) | L16-no-barnesg-bronze-or-silver |
| explained | T1-barnesg-005 | T1 | BarnesG | boost | wolfram | asymmetric-refusal | refused-by boost (boost-no-barnesg) | L16-no-barnesg-bronze-or-silver |
| explained | T1-barnesg-005 | T1 | BarnesG | mpmath | scipy | asymmetric-refusal | refused-by scipy (L16: SciPy has no barnesg; bronze tier cannot cover this head. Use Wolfram (G2) or mpmath (G3) for gold values.) | L16-no-barnesg-bronze-or-silver |
| explained | T1-barnesg-005 | T1 | BarnesG | scipy | wolfram | asymmetric-refusal | refused-by scipy (L16: SciPy has no barnesg; bronze tier cannot cover this head. Use Wolfram (G2) or mpmath (G3) for gold values.) | L16-no-barnesg-bronze-or-silver |
| explained | T1-inverseincompletegammap-001 | T1 | InverseIncompleteGammaP | arb | boost | asymmetric-refusal | refused-by arb (python-flint 0.8.0 has no direct InverseIncompleteGamma{P,Q}; Newton-iteration substitute would not be byte-deterministic) | L13-arb-no-inverse-incomplete-gamma |
| explained | T1-inverseincompletegammap-001 | T1 | InverseIncompleteGammaP | arb | scipy | asymmetric-refusal | refused-by arb (python-flint 0.8.0 has no direct InverseIncompleteGamma{P,Q}; Newton-iteration substitute would not be byte-deterministic) | L13-arb-no-inverse-incomplete-gamma |
| explained | T1-inverseincompletegammap-001 | T1 | InverseIncompleteGammaP | arb | wolfram | asymmetric-refusal | refused-by arb (python-flint 0.8.0 has no direct InverseIncompleteGamma{P,Q}; Newton-iteration substitute would not be byte-deterministic) | L13-arb-no-inverse-incomplete-gamma |
| explained | T1-inverseincompletegammap-001 | T1 | InverseIncompleteGammaP | boost | mpmath | asymmetric-refusal | refused-by mpmath (mpmath has no direct InverseIncompleteGamma{P,Q}; R5 §3.2 documents findroot workaround as non-gold-tier) | L13-mpmath-no-inverse-incomplete-gamma |
| explained | T1-inverseincompletegammap-001 | T1 | InverseIncompleteGammaP | mpmath | scipy | asymmetric-refusal | refused-by mpmath (mpmath has no direct InverseIncompleteGamma{P,Q}; R5 §3.2 documents findroot workaround as non-gold-tier) | L13-mpmath-no-inverse-incomplete-gamma |
| explained | T1-inverseincompletegammap-001 | T1 | InverseIncompleteGammaP | mpmath | wolfram | asymmetric-refusal | refused-by mpmath (mpmath has no direct InverseIncompleteGamma{P,Q}; R5 §3.2 documents findroot workaround as non-gold-tier) | L13-mpmath-no-inverse-incomplete-gamma |
| explained | T1-inverseincompletegammap-002 | T1 | InverseIncompleteGammaP | arb | boost | asymmetric-refusal | refused-by arb (python-flint 0.8.0 has no direct InverseIncompleteGamma{P,Q}; Newton-iteration substitute would not be byte-deterministic) | L13-arb-no-inverse-incomplete-gamma |
| explained | T1-inverseincompletegammap-002 | T1 | InverseIncompleteGammaP | arb | scipy | asymmetric-refusal | refused-by arb (python-flint 0.8.0 has no direct InverseIncompleteGamma{P,Q}; Newton-iteration substitute would not be byte-deterministic) | L13-arb-no-inverse-incomplete-gamma |
| explained | T1-inverseincompletegammap-002 | T1 | InverseIncompleteGammaP | arb | wolfram | asymmetric-refusal | refused-by arb (python-flint 0.8.0 has no direct InverseIncompleteGamma{P,Q}; Newton-iteration substitute would not be byte-deterministic) | L13-arb-no-inverse-incomplete-gamma |
| explained | T1-inverseincompletegammap-002 | T1 | InverseIncompleteGammaP | boost | mpmath | asymmetric-refusal | refused-by mpmath (mpmath has no direct InverseIncompleteGamma{P,Q}; R5 §3.2 documents findroot workaround as non-gold-tier) | L13-mpmath-no-inverse-incomplete-gamma |
| explained | T1-inverseincompletegammap-002 | T1 | InverseIncompleteGammaP | mpmath | scipy | asymmetric-refusal | refused-by mpmath (mpmath has no direct InverseIncompleteGamma{P,Q}; R5 §3.2 documents findroot workaround as non-gold-tier) | L13-mpmath-no-inverse-incomplete-gamma |
| explained | T1-inverseincompletegammap-002 | T1 | InverseIncompleteGammaP | mpmath | wolfram | asymmetric-refusal | refused-by mpmath (mpmath has no direct InverseIncompleteGamma{P,Q}; R5 §3.2 documents findroot workaround as non-gold-tier) | L13-mpmath-no-inverse-incomplete-gamma |
| explained | T1-inverseincompletegammap-003 | T1 | InverseIncompleteGammaP | arb | boost | asymmetric-refusal | refused-by arb (python-flint 0.8.0 has no direct InverseIncompleteGamma{P,Q}; Newton-iteration substitute would not be byte-deterministic) | L13-arb-no-inverse-incomplete-gamma |
| explained | T1-inverseincompletegammap-003 | T1 | InverseIncompleteGammaP | arb | scipy | asymmetric-refusal | refused-by arb (python-flint 0.8.0 has no direct InverseIncompleteGamma{P,Q}; Newton-iteration substitute would not be byte-deterministic) | L13-arb-no-inverse-incomplete-gamma |
| explained | T1-inverseincompletegammap-003 | T1 | InverseIncompleteGammaP | arb | wolfram | asymmetric-refusal | refused-by arb (python-flint 0.8.0 has no direct InverseIncompleteGamma{P,Q}; Newton-iteration substitute would not be byte-deterministic) | L13-arb-no-inverse-incomplete-gamma |
| explained | T1-inverseincompletegammap-003 | T1 | InverseIncompleteGammaP | boost | mpmath | asymmetric-refusal | refused-by mpmath (mpmath has no direct InverseIncompleteGamma{P,Q}; R5 §3.2 documents findroot workaround as non-gold-tier) | L13-mpmath-no-inverse-incomplete-gamma |
| explained | T1-inverseincompletegammap-003 | T1 | InverseIncompleteGammaP | mpmath | scipy | asymmetric-refusal | refused-by mpmath (mpmath has no direct InverseIncompleteGamma{P,Q}; R5 §3.2 documents findroot workaround as non-gold-tier) | L13-mpmath-no-inverse-incomplete-gamma |
| explained | T1-inverseincompletegammap-003 | T1 | InverseIncompleteGammaP | mpmath | wolfram | asymmetric-refusal | refused-by mpmath (mpmath has no direct InverseIncompleteGamma{P,Q}; R5 §3.2 documents findroot workaround as non-gold-tier) | L13-mpmath-no-inverse-incomplete-gamma |
| explained | T1-inverseincompletegammap-004 | T1 | InverseIncompleteGammaP | arb | boost | asymmetric-refusal | refused-by arb (python-flint 0.8.0 has no direct InverseIncompleteGamma{P,Q}; Newton-iteration substitute would not be byte-deterministic) | L13-arb-no-inverse-incomplete-gamma |
| explained | T1-inverseincompletegammap-004 | T1 | InverseIncompleteGammaP | arb | scipy | asymmetric-refusal | refused-by arb (python-flint 0.8.0 has no direct InverseIncompleteGamma{P,Q}; Newton-iteration substitute would not be byte-deterministic) | L13-arb-no-inverse-incomplete-gamma |
| explained | T1-inverseincompletegammap-004 | T1 | InverseIncompleteGammaP | arb | wolfram | asymmetric-refusal | refused-by arb (python-flint 0.8.0 has no direct InverseIncompleteGamma{P,Q}; Newton-iteration substitute would not be byte-deterministic) | L13-arb-no-inverse-incomplete-gamma |
| explained | T1-inverseincompletegammap-004 | T1 | InverseIncompleteGammaP | boost | mpmath | asymmetric-refusal | refused-by mpmath (mpmath has no direct InverseIncompleteGamma{P,Q}; R5 §3.2 documents findroot workaround as non-gold-tier) | L13-mpmath-no-inverse-incomplete-gamma |
| explained | T1-inverseincompletegammap-004 | T1 | InverseIncompleteGammaP | mpmath | scipy | asymmetric-refusal | refused-by mpmath (mpmath has no direct InverseIncompleteGamma{P,Q}; R5 §3.2 documents findroot workaround as non-gold-tier) | L13-mpmath-no-inverse-incomplete-gamma |
| explained | T1-inverseincompletegammap-004 | T1 | InverseIncompleteGammaP | mpmath | wolfram | asymmetric-refusal | refused-by mpmath (mpmath has no direct InverseIncompleteGamma{P,Q}; R5 §3.2 documents findroot workaround as non-gold-tier) | L13-mpmath-no-inverse-incomplete-gamma |
| explained | T1-inverseincompletegammap-005 | T1 | InverseIncompleteGammaP | arb | boost | asymmetric-refusal | refused-by arb (python-flint 0.8.0 has no direct InverseIncompleteGamma{P,Q}; Newton-iteration substitute would not be byte-deterministic) | L13-arb-no-inverse-incomplete-gamma |
| explained | T1-inverseincompletegammap-005 | T1 | InverseIncompleteGammaP | arb | scipy | asymmetric-refusal | refused-by arb (python-flint 0.8.0 has no direct InverseIncompleteGamma{P,Q}; Newton-iteration substitute would not be byte-deterministic) | L13-arb-no-inverse-incomplete-gamma |
| explained | T1-inverseincompletegammap-005 | T1 | InverseIncompleteGammaP | arb | wolfram | asymmetric-refusal | refused-by arb (python-flint 0.8.0 has no direct InverseIncompleteGamma{P,Q}; Newton-iteration substitute would not be byte-deterministic) | L13-arb-no-inverse-incomplete-gamma |
| explained | T1-inverseincompletegammap-005 | T1 | InverseIncompleteGammaP | boost | mpmath | asymmetric-refusal | refused-by mpmath (mpmath has no direct InverseIncompleteGamma{P,Q}; R5 §3.2 documents findroot workaround as non-gold-tier) | L13-mpmath-no-inverse-incomplete-gamma |
| explained | T1-inverseincompletegammap-005 | T1 | InverseIncompleteGammaP | mpmath | scipy | asymmetric-refusal | refused-by mpmath (mpmath has no direct InverseIncompleteGamma{P,Q}; R5 §3.2 documents findroot workaround as non-gold-tier) | L13-mpmath-no-inverse-incomplete-gamma |
| explained | T1-inverseincompletegammap-005 | T1 | InverseIncompleteGammaP | mpmath | wolfram | asymmetric-refusal | refused-by mpmath (mpmath has no direct InverseIncompleteGamma{P,Q}; R5 §3.2 documents findroot workaround as non-gold-tier) | L13-mpmath-no-inverse-incomplete-gamma |
| explained | T1-inverseincompletegammap-006 | T1 | InverseIncompleteGammaP | arb | boost | asymmetric-refusal | refused-by arb (python-flint 0.8.0 has no direct InverseIncompleteGamma{P,Q}; Newton-iteration substitute would not be byte-deterministic) | L13-arb-no-inverse-incomplete-gamma |
| explained | T1-inverseincompletegammap-006 | T1 | InverseIncompleteGammaP | arb | scipy | asymmetric-refusal | refused-by arb (python-flint 0.8.0 has no direct InverseIncompleteGamma{P,Q}; Newton-iteration substitute would not be byte-deterministic) | L13-arb-no-inverse-incomplete-gamma |
| explained | T1-inverseincompletegammap-006 | T1 | InverseIncompleteGammaP | arb | wolfram | asymmetric-refusal | refused-by arb (python-flint 0.8.0 has no direct InverseIncompleteGamma{P,Q}; Newton-iteration substitute would not be byte-deterministic) | L13-arb-no-inverse-incomplete-gamma |
| explained | T1-inverseincompletegammap-006 | T1 | InverseIncompleteGammaP | boost | mpmath | asymmetric-refusal | refused-by mpmath (mpmath has no direct InverseIncompleteGamma{P,Q}; R5 §3.2 documents findroot workaround as non-gold-tier) | L13-mpmath-no-inverse-incomplete-gamma |
| explained | T1-inverseincompletegammap-006 | T1 | InverseIncompleteGammaP | mpmath | scipy | asymmetric-refusal | refused-by mpmath (mpmath has no direct InverseIncompleteGamma{P,Q}; R5 §3.2 documents findroot workaround as non-gold-tier) | L13-mpmath-no-inverse-incomplete-gamma |
| explained | T1-inverseincompletegammap-006 | T1 | InverseIncompleteGammaP | mpmath | wolfram | asymmetric-refusal | refused-by mpmath (mpmath has no direct InverseIncompleteGamma{P,Q}; R5 §3.2 documents findroot workaround as non-gold-tier) | L13-mpmath-no-inverse-incomplete-gamma |
| explained | T1-inverseincompletegammaq-001 | T1 | InverseIncompleteGammaQ | arb | boost | asymmetric-refusal | refused-by arb (python-flint 0.8.0 has no direct InverseIncompleteGamma{P,Q}; Newton-iteration substitute would not be byte-deterministic) | L13-arb-no-inverse-incomplete-gamma |
| explained | T1-inverseincompletegammaq-001 | T1 | InverseIncompleteGammaQ | arb | scipy | asymmetric-refusal | refused-by arb (python-flint 0.8.0 has no direct InverseIncompleteGamma{P,Q}; Newton-iteration substitute would not be byte-deterministic) | L13-arb-no-inverse-incomplete-gamma |
| explained | T1-inverseincompletegammaq-001 | T1 | InverseIncompleteGammaQ | arb | wolfram | asymmetric-refusal | refused-by arb (python-flint 0.8.0 has no direct InverseIncompleteGamma{P,Q}; Newton-iteration substitute would not be byte-deterministic) | L13-arb-no-inverse-incomplete-gamma |
| explained | T1-inverseincompletegammaq-001 | T1 | InverseIncompleteGammaQ | boost | mpmath | asymmetric-refusal | refused-by mpmath (mpmath has no direct InverseIncompleteGamma{P,Q}; R5 §3.2 documents findroot workaround as non-gold-tier) | L13-mpmath-no-inverse-incomplete-gamma |
| explained | T1-inverseincompletegammaq-001 | T1 | InverseIncompleteGammaQ | mpmath | scipy | asymmetric-refusal | refused-by mpmath (mpmath has no direct InverseIncompleteGamma{P,Q}; R5 §3.2 documents findroot workaround as non-gold-tier) | L13-mpmath-no-inverse-incomplete-gamma |
| explained | T1-inverseincompletegammaq-001 | T1 | InverseIncompleteGammaQ | mpmath | wolfram | asymmetric-refusal | refused-by mpmath (mpmath has no direct InverseIncompleteGamma{P,Q}; R5 §3.2 documents findroot workaround as non-gold-tier) | L13-mpmath-no-inverse-incomplete-gamma |
| explained | T1-inverseincompletegammaq-002 | T1 | InverseIncompleteGammaQ | arb | boost | asymmetric-refusal | refused-by arb (python-flint 0.8.0 has no direct InverseIncompleteGamma{P,Q}; Newton-iteration substitute would not be byte-deterministic) | L13-arb-no-inverse-incomplete-gamma |
| explained | T1-inverseincompletegammaq-002 | T1 | InverseIncompleteGammaQ | arb | scipy | asymmetric-refusal | refused-by arb (python-flint 0.8.0 has no direct InverseIncompleteGamma{P,Q}; Newton-iteration substitute would not be byte-deterministic) | L13-arb-no-inverse-incomplete-gamma |
| explained | T1-inverseincompletegammaq-002 | T1 | InverseIncompleteGammaQ | arb | wolfram | asymmetric-refusal | refused-by arb (python-flint 0.8.0 has no direct InverseIncompleteGamma{P,Q}; Newton-iteration substitute would not be byte-deterministic) | L13-arb-no-inverse-incomplete-gamma |
| explained | T1-inverseincompletegammaq-002 | T1 | InverseIncompleteGammaQ | boost | mpmath | asymmetric-refusal | refused-by mpmath (mpmath has no direct InverseIncompleteGamma{P,Q}; R5 §3.2 documents findroot workaround as non-gold-tier) | L13-mpmath-no-inverse-incomplete-gamma |
| explained | T1-inverseincompletegammaq-002 | T1 | InverseIncompleteGammaQ | mpmath | scipy | asymmetric-refusal | refused-by mpmath (mpmath has no direct InverseIncompleteGamma{P,Q}; R5 §3.2 documents findroot workaround as non-gold-tier) | L13-mpmath-no-inverse-incomplete-gamma |
| explained | T1-inverseincompletegammaq-002 | T1 | InverseIncompleteGammaQ | mpmath | wolfram | asymmetric-refusal | refused-by mpmath (mpmath has no direct InverseIncompleteGamma{P,Q}; R5 §3.2 documents findroot workaround as non-gold-tier) | L13-mpmath-no-inverse-incomplete-gamma |
| explained | T1-inverseincompletegammaq-003 | T1 | InverseIncompleteGammaQ | arb | boost | asymmetric-refusal | refused-by arb (python-flint 0.8.0 has no direct InverseIncompleteGamma{P,Q}; Newton-iteration substitute would not be byte-deterministic) | L13-arb-no-inverse-incomplete-gamma |
| explained | T1-inverseincompletegammaq-003 | T1 | InverseIncompleteGammaQ | arb | scipy | asymmetric-refusal | refused-by arb (python-flint 0.8.0 has no direct InverseIncompleteGamma{P,Q}; Newton-iteration substitute would not be byte-deterministic) | L13-arb-no-inverse-incomplete-gamma |
| explained | T1-inverseincompletegammaq-003 | T1 | InverseIncompleteGammaQ | arb | wolfram | asymmetric-refusal | refused-by arb (python-flint 0.8.0 has no direct InverseIncompleteGamma{P,Q}; Newton-iteration substitute would not be byte-deterministic) | L13-arb-no-inverse-incomplete-gamma |
| explained | T1-inverseincompletegammaq-003 | T1 | InverseIncompleteGammaQ | boost | mpmath | asymmetric-refusal | refused-by mpmath (mpmath has no direct InverseIncompleteGamma{P,Q}; R5 §3.2 documents findroot workaround as non-gold-tier) | L13-mpmath-no-inverse-incomplete-gamma |
| explained | T1-inverseincompletegammaq-003 | T1 | InverseIncompleteGammaQ | mpmath | scipy | asymmetric-refusal | refused-by mpmath (mpmath has no direct InverseIncompleteGamma{P,Q}; R5 §3.2 documents findroot workaround as non-gold-tier) | L13-mpmath-no-inverse-incomplete-gamma |
| explained | T1-inverseincompletegammaq-003 | T1 | InverseIncompleteGammaQ | mpmath | wolfram | asymmetric-refusal | refused-by mpmath (mpmath has no direct InverseIncompleteGamma{P,Q}; R5 §3.2 documents findroot workaround as non-gold-tier) | L13-mpmath-no-inverse-incomplete-gamma |
| explained | T1-inverseincompletegammaq-004 | T1 | InverseIncompleteGammaQ | arb | boost | asymmetric-refusal | refused-by arb (python-flint 0.8.0 has no direct InverseIncompleteGamma{P,Q}; Newton-iteration substitute would not be byte-deterministic) | L13-arb-no-inverse-incomplete-gamma |
| explained | T1-inverseincompletegammaq-004 | T1 | InverseIncompleteGammaQ | arb | scipy | asymmetric-refusal | refused-by arb (python-flint 0.8.0 has no direct InverseIncompleteGamma{P,Q}; Newton-iteration substitute would not be byte-deterministic) | L13-arb-no-inverse-incomplete-gamma |
| explained | T1-inverseincompletegammaq-004 | T1 | InverseIncompleteGammaQ | arb | wolfram | asymmetric-refusal | refused-by arb (python-flint 0.8.0 has no direct InverseIncompleteGamma{P,Q}; Newton-iteration substitute would not be byte-deterministic) | L13-arb-no-inverse-incomplete-gamma |
| explained | T1-inverseincompletegammaq-004 | T1 | InverseIncompleteGammaQ | boost | mpmath | asymmetric-refusal | refused-by mpmath (mpmath has no direct InverseIncompleteGamma{P,Q}; R5 §3.2 documents findroot workaround as non-gold-tier) | L13-mpmath-no-inverse-incomplete-gamma |
| explained | T1-inverseincompletegammaq-004 | T1 | InverseIncompleteGammaQ | mpmath | scipy | asymmetric-refusal | refused-by mpmath (mpmath has no direct InverseIncompleteGamma{P,Q}; R5 §3.2 documents findroot workaround as non-gold-tier) | L13-mpmath-no-inverse-incomplete-gamma |
| explained | T1-inverseincompletegammaq-004 | T1 | InverseIncompleteGammaQ | mpmath | wolfram | asymmetric-refusal | refused-by mpmath (mpmath has no direct InverseIncompleteGamma{P,Q}; R5 §3.2 documents findroot workaround as non-gold-tier) | L13-mpmath-no-inverse-incomplete-gamma |
| explained | T1-inverseincompletegammaq-005 | T1 | InverseIncompleteGammaQ | arb | boost | asymmetric-refusal | refused-by arb (python-flint 0.8.0 has no direct InverseIncompleteGamma{P,Q}; Newton-iteration substitute would not be byte-deterministic) | L13-arb-no-inverse-incomplete-gamma |
| explained | T1-inverseincompletegammaq-005 | T1 | InverseIncompleteGammaQ | arb | scipy | asymmetric-refusal | refused-by arb (python-flint 0.8.0 has no direct InverseIncompleteGamma{P,Q}; Newton-iteration substitute would not be byte-deterministic) | L13-arb-no-inverse-incomplete-gamma |
| explained | T1-inverseincompletegammaq-005 | T1 | InverseIncompleteGammaQ | arb | wolfram | asymmetric-refusal | refused-by arb (python-flint 0.8.0 has no direct InverseIncompleteGamma{P,Q}; Newton-iteration substitute would not be byte-deterministic) | L13-arb-no-inverse-incomplete-gamma |
| explained | T1-inverseincompletegammaq-005 | T1 | InverseIncompleteGammaQ | boost | mpmath | asymmetric-refusal | refused-by mpmath (mpmath has no direct InverseIncompleteGamma{P,Q}; R5 §3.2 documents findroot workaround as non-gold-tier) | L13-mpmath-no-inverse-incomplete-gamma |
| explained | T1-inverseincompletegammaq-005 | T1 | InverseIncompleteGammaQ | mpmath | scipy | asymmetric-refusal | refused-by mpmath (mpmath has no direct InverseIncompleteGamma{P,Q}; R5 §3.2 documents findroot workaround as non-gold-tier) | L13-mpmath-no-inverse-incomplete-gamma |
| explained | T1-inverseincompletegammaq-005 | T1 | InverseIncompleteGammaQ | mpmath | wolfram | asymmetric-refusal | refused-by mpmath (mpmath has no direct InverseIncompleteGamma{P,Q}; R5 §3.2 documents findroot workaround as non-gold-tier) | L13-mpmath-no-inverse-incomplete-gamma |
| explained | T1-inverseincompletegammaq-006 | T1 | InverseIncompleteGammaQ | arb | boost | asymmetric-refusal | refused-by arb (python-flint 0.8.0 has no direct InverseIncompleteGamma{P,Q}; Newton-iteration substitute would not be byte-deterministic) | L13-arb-no-inverse-incomplete-gamma |
| explained | T1-inverseincompletegammaq-006 | T1 | InverseIncompleteGammaQ | arb | scipy | asymmetric-refusal | refused-by arb (python-flint 0.8.0 has no direct InverseIncompleteGamma{P,Q}; Newton-iteration substitute would not be byte-deterministic) | L13-arb-no-inverse-incomplete-gamma |
| explained | T1-inverseincompletegammaq-006 | T1 | InverseIncompleteGammaQ | arb | wolfram | asymmetric-refusal | refused-by arb (python-flint 0.8.0 has no direct InverseIncompleteGamma{P,Q}; Newton-iteration substitute would not be byte-deterministic) | L13-arb-no-inverse-incomplete-gamma |
| explained | T1-inverseincompletegammaq-006 | T1 | InverseIncompleteGammaQ | boost | mpmath | asymmetric-refusal | refused-by mpmath (mpmath has no direct InverseIncompleteGamma{P,Q}; R5 §3.2 documents findroot workaround as non-gold-tier) | L13-mpmath-no-inverse-incomplete-gamma |
| explained | T1-inverseincompletegammaq-006 | T1 | InverseIncompleteGammaQ | mpmath | scipy | asymmetric-refusal | refused-by mpmath (mpmath has no direct InverseIncompleteGamma{P,Q}; R5 §3.2 documents findroot workaround as non-gold-tier) | L13-mpmath-no-inverse-incomplete-gamma |
| explained | T1-inverseincompletegammaq-006 | T1 | InverseIncompleteGammaQ | mpmath | wolfram | asymmetric-refusal | refused-by mpmath (mpmath has no direct InverseIncompleteGamma{P,Q}; R5 §3.2 documents findroot workaround as non-gold-tier) | L13-mpmath-no-inverse-incomplete-gamma |
| explained | T1-pochhammer-001 | T1 | Pochhammer | arb | boost | asymmetric-refusal | refused-by boost (boost-no-pochhammer) | boost-no-pochhammer |
| explained | T1-pochhammer-001 | T1 | Pochhammer | boost | mpmath | asymmetric-refusal | refused-by boost (boost-no-pochhammer) | boost-no-pochhammer |
| explained | T1-pochhammer-001 | T1 | Pochhammer | boost | scipy | asymmetric-refusal | refused-by boost (boost-no-pochhammer) | boost-no-pochhammer |
| explained | T1-pochhammer-001 | T1 | Pochhammer | boost | wolfram | asymmetric-refusal | refused-by boost (boost-no-pochhammer) | boost-no-pochhammer |
| explained | T1-pochhammer-002 | T1 | Pochhammer | arb | boost | asymmetric-refusal | refused-by boost (boost-no-pochhammer) | boost-no-pochhammer |
| explained | T1-pochhammer-002 | T1 | Pochhammer | boost | mpmath | asymmetric-refusal | refused-by boost (boost-no-pochhammer) | boost-no-pochhammer |
| explained | T1-pochhammer-002 | T1 | Pochhammer | boost | scipy | asymmetric-refusal | refused-by boost (boost-no-pochhammer) | boost-no-pochhammer |
| explained | T1-pochhammer-002 | T1 | Pochhammer | boost | wolfram | asymmetric-refusal | refused-by boost (boost-no-pochhammer) | boost-no-pochhammer |
| explained | T1-pochhammer-003 | T1 | Pochhammer | arb | boost | asymmetric-refusal | refused-by boost (boost-no-pochhammer) | boost-no-pochhammer |
| explained | T1-pochhammer-003 | T1 | Pochhammer | boost | mpmath | asymmetric-refusal | refused-by boost (boost-no-pochhammer) | boost-no-pochhammer |
| explained | T1-pochhammer-003 | T1 | Pochhammer | boost | scipy | asymmetric-refusal | refused-by boost (boost-no-pochhammer) | boost-no-pochhammer |
| explained | T1-pochhammer-003 | T1 | Pochhammer | boost | wolfram | asymmetric-refusal | refused-by boost (boost-no-pochhammer) | boost-no-pochhammer |
| explained | T1-pochhammer-004 | T1 | Pochhammer | arb | boost | asymmetric-refusal | refused-by boost (boost-no-pochhammer) | boost-no-pochhammer |
| explained | T1-pochhammer-004 | T1 | Pochhammer | boost | mpmath | asymmetric-refusal | refused-by boost (boost-no-pochhammer) | boost-no-pochhammer |
| explained | T1-pochhammer-004 | T1 | Pochhammer | boost | scipy | asymmetric-refusal | refused-by boost (boost-no-pochhammer) | boost-no-pochhammer |
| explained | T1-pochhammer-004 | T1 | Pochhammer | boost | wolfram | asymmetric-refusal | refused-by boost (boost-no-pochhammer) | boost-no-pochhammer |
| explained | T1-pochhammer-005 | T1 | Pochhammer | arb | boost | asymmetric-refusal | refused-by boost (boost-no-pochhammer) | boost-no-pochhammer |
| explained | T1-pochhammer-005 | T1 | Pochhammer | boost | mpmath | asymmetric-refusal | refused-by boost (boost-no-pochhammer) | boost-no-pochhammer |
| explained | T1-pochhammer-005 | T1 | Pochhammer | boost | scipy | asymmetric-refusal | refused-by boost (boost-no-pochhammer) | boost-no-pochhammer |
| explained | T1-pochhammer-005 | T1 | Pochhammer | boost | wolfram | asymmetric-refusal | refused-by boost (boost-no-pochhammer) | boost-no-pochhammer |
| explained | T1-pochhammer-006 | T1 | Pochhammer | arb | boost | asymmetric-refusal | refused-by boost (boost-no-pochhammer) | boost-no-pochhammer |
| explained | T1-pochhammer-006 | T1 | Pochhammer | boost | mpmath | asymmetric-refusal | refused-by boost (boost-no-pochhammer) | boost-no-pochhammer |
| explained | T1-pochhammer-006 | T1 | Pochhammer | boost | scipy | asymmetric-refusal | refused-by boost (boost-no-pochhammer) | boost-no-pochhammer |
| explained | T1-pochhammer-006 | T1 | Pochhammer | boost | wolfram | asymmetric-refusal | refused-by boost (boost-no-pochhammer) | boost-no-pochhammer |
| explained | T1-pochhammer-007 | T1 | Pochhammer | arb | boost | asymmetric-refusal | refused-by boost (boost-no-pochhammer) | boost-no-pochhammer |
| explained | T1-pochhammer-007 | T1 | Pochhammer | boost | mpmath | asymmetric-refusal | refused-by boost (boost-no-pochhammer) | boost-no-pochhammer |
| explained | T1-pochhammer-007 | T1 | Pochhammer | boost | scipy | asymmetric-refusal | refused-by boost (boost-no-pochhammer) | boost-no-pochhammer |
| explained | T1-pochhammer-007 | T1 | Pochhammer | boost | wolfram | asymmetric-refusal | refused-by boost (boost-no-pochhammer) | boost-no-pochhammer |
| explained | T1-pochhammer-008 | T1 | Pochhammer | arb | boost | asymmetric-refusal | refused-by boost (boost-no-pochhammer) | boost-no-pochhammer |
| explained | T1-pochhammer-008 | T1 | Pochhammer | boost | mpmath | asymmetric-refusal | refused-by boost (boost-no-pochhammer) | boost-no-pochhammer |
| explained | T1-pochhammer-008 | T1 | Pochhammer | boost | scipy | asymmetric-refusal | refused-by boost (boost-no-pochhammer) | boost-no-pochhammer |
| explained | T1-pochhammer-008 | T1 | Pochhammer | boost | wolfram | asymmetric-refusal | refused-by boost (boost-no-pochhammer) | boost-no-pochhammer |
| explained | T1-pochhammer-009 | T1 | Pochhammer | arb | boost | asymmetric-refusal | refused-by boost (boost-no-pochhammer) | boost-no-pochhammer |
| explained | T1-pochhammer-009 | T1 | Pochhammer | boost | mpmath | asymmetric-refusal | refused-by boost (boost-no-pochhammer) | boost-no-pochhammer |
| explained | T1-pochhammer-009 | T1 | Pochhammer | boost | scipy | asymmetric-refusal | refused-by boost (boost-no-pochhammer) | boost-no-pochhammer |
| explained | T1-pochhammer-009 | T1 | Pochhammer | boost | wolfram | asymmetric-refusal | refused-by boost (boost-no-pochhammer) | boost-no-pochhammer |
| explained | T2-beta-001 | T2 | Beta | arb | boost | asymmetric-refusal | refused-by boost (std-exception: Error in function boost::math::beta<N5boost14multiprecision6numberINS0_8backends13cpp_bin_floatILj50ELNS2_15digit_base_typeE10EviLi0ELi0EEELNS0_26expression_template_optionE0EEE>(N5boost14multiprecision6numberINS0_8backends13cpp_bin_floatILj50ELNS2_15digit_base_typeE10EviLi0ELi0EEELNS0_26expression_template_optionE0EEE,N5boost14multiprecision6numberINS0_8backends13cpp_bin_floatILj50ELNS2_15digit_base_typeE10EviLi0ELi0EEELNS0_26expression_template_optionE0EEE): The arguments to the beta function must be greater than zero (got a=-0.6999999999999999555910790149937383830547332763671875).) | boost-beta-positive-args-only |
| explained | T2-beta-001 | T2 | Beta | boost | mpmath | asymmetric-refusal | refused-by boost (std-exception: Error in function boost::math::beta<N5boost14multiprecision6numberINS0_8backends13cpp_bin_floatILj50ELNS2_15digit_base_typeE10EviLi0ELi0EEELNS0_26expression_template_optionE0EEE>(N5boost14multiprecision6numberINS0_8backends13cpp_bin_floatILj50ELNS2_15digit_base_typeE10EviLi0ELi0EEELNS0_26expression_template_optionE0EEE,N5boost14multiprecision6numberINS0_8backends13cpp_bin_floatILj50ELNS2_15digit_base_typeE10EviLi0ELi0EEELNS0_26expression_template_optionE0EEE): The arguments to the beta function must be greater than zero (got a=-0.6999999999999999555910790149937383830547332763671875).) | boost-beta-positive-args-only |
| explained | T2-beta-001 | T2 | Beta | boost | scipy | asymmetric-refusal | refused-by boost (std-exception: Error in function boost::math::beta<N5boost14multiprecision6numberINS0_8backends13cpp_bin_floatILj50ELNS2_15digit_base_typeE10EviLi0ELi0EEELNS0_26expression_template_optionE0EEE>(N5boost14multiprecision6numberINS0_8backends13cpp_bin_floatILj50ELNS2_15digit_base_typeE10EviLi0ELi0EEELNS0_26expression_template_optionE0EEE,N5boost14multiprecision6numberINS0_8backends13cpp_bin_floatILj50ELNS2_15digit_base_typeE10EviLi0ELi0EEELNS0_26expression_template_optionE0EEE): The arguments to the beta function must be greater than zero (got a=-0.6999999999999999555910790149937383830547332763671875).) | boost-beta-positive-args-only |
| explained | T2-beta-001 | T2 | Beta | boost | wolfram | asymmetric-refusal | refused-by boost (std-exception: Error in function boost::math::beta<N5boost14multiprecision6numberINS0_8backends13cpp_bin_floatILj50ELNS2_15digit_base_typeE10EviLi0ELi0EEELNS0_26expression_template_optionE0EEE>(N5boost14multiprecision6numberINS0_8backends13cpp_bin_floatILj50ELNS2_15digit_base_typeE10EviLi0ELi0EEELNS0_26expression_template_optionE0EEE,N5boost14multiprecision6numberINS0_8backends13cpp_bin_floatILj50ELNS2_15digit_base_typeE10EviLi0ELi0EEELNS0_26expression_template_optionE0EEE): The arguments to the beta function must be greater than zero (got a=-0.6999999999999999555910790149937383830547332763671875).) | boost-beta-positive-args-only |
| explained | T2-beta-002 | T2 | Beta | arb | boost | asymmetric-refusal | refused-by boost (std-exception: Error in function boost::math::beta<N5boost14multiprecision6numberINS0_8backends13cpp_bin_floatILj50ELNS2_15digit_base_typeE10EviLi0ELi0EEELNS0_26expression_template_optionE0EEE>(N5boost14multiprecision6numberINS0_8backends13cpp_bin_floatILj50ELNS2_15digit_base_typeE10EviLi0ELi0EEELNS0_26expression_template_optionE0EEE,N5boost14multiprecision6numberINS0_8backends13cpp_bin_floatILj50ELNS2_15digit_base_typeE10EviLi0ELi0EEELNS0_26expression_template_optionE0EEE): The arguments to the beta function must be greater than zero (got a=-0.5).) | boost-beta-positive-args-only |
| explained | T2-beta-002 | T2 | Beta | boost | mpmath | asymmetric-refusal | refused-by boost (std-exception: Error in function boost::math::beta<N5boost14multiprecision6numberINS0_8backends13cpp_bin_floatILj50ELNS2_15digit_base_typeE10EviLi0ELi0EEELNS0_26expression_template_optionE0EEE>(N5boost14multiprecision6numberINS0_8backends13cpp_bin_floatILj50ELNS2_15digit_base_typeE10EviLi0ELi0EEELNS0_26expression_template_optionE0EEE,N5boost14multiprecision6numberINS0_8backends13cpp_bin_floatILj50ELNS2_15digit_base_typeE10EviLi0ELi0EEELNS0_26expression_template_optionE0EEE): The arguments to the beta function must be greater than zero (got a=-0.5).) | boost-beta-positive-args-only |
| explained | T2-beta-002 | T2 | Beta | boost | scipy | asymmetric-refusal | refused-by boost (std-exception: Error in function boost::math::beta<N5boost14multiprecision6numberINS0_8backends13cpp_bin_floatILj50ELNS2_15digit_base_typeE10EviLi0ELi0EEELNS0_26expression_template_optionE0EEE>(N5boost14multiprecision6numberINS0_8backends13cpp_bin_floatILj50ELNS2_15digit_base_typeE10EviLi0ELi0EEELNS0_26expression_template_optionE0EEE,N5boost14multiprecision6numberINS0_8backends13cpp_bin_floatILj50ELNS2_15digit_base_typeE10EviLi0ELi0EEELNS0_26expression_template_optionE0EEE): The arguments to the beta function must be greater than zero (got a=-0.5).) | boost-beta-positive-args-only |
| explained | T2-beta-002 | T2 | Beta | boost | wolfram | asymmetric-refusal | refused-by boost (std-exception: Error in function boost::math::beta<N5boost14multiprecision6numberINS0_8backends13cpp_bin_floatILj50ELNS2_15digit_base_typeE10EviLi0ELi0EEELNS0_26expression_template_optionE0EEE>(N5boost14multiprecision6numberINS0_8backends13cpp_bin_floatILj50ELNS2_15digit_base_typeE10EviLi0ELi0EEELNS0_26expression_template_optionE0EEE,N5boost14multiprecision6numberINS0_8backends13cpp_bin_floatILj50ELNS2_15digit_base_typeE10EviLi0ELi0EEELNS0_26expression_template_optionE0EEE): The arguments to the beta function must be greater than zero (got a=-0.5).) | boost-beta-positive-args-only |
| explained | T2-beta-003 | T2 | Beta | arb | boost | asymmetric-refusal | refused-by boost (std-exception: Error in function boost::math::beta<N5boost14multiprecision6numberINS0_8backends13cpp_bin_floatILj50ELNS2_15digit_base_typeE10EviLi0ELi0EEELNS0_26expression_template_optionE0EEE>(N5boost14multiprecision6numberINS0_8backends13cpp_bin_floatILj50ELNS2_15digit_base_typeE10EviLi0ELi0EEELNS0_26expression_template_optionE0EEE,N5boost14multiprecision6numberINS0_8backends13cpp_bin_floatILj50ELNS2_15digit_base_typeE10EviLi0ELi0EEELNS0_26expression_template_optionE0EEE): The arguments to the beta function must be greater than zero (got a=-1.300000000000000044408920985006261616945266723632812).) | boost-beta-positive-args-only |
| explained | T2-beta-003 | T2 | Beta | boost | mpmath | asymmetric-refusal | refused-by boost (std-exception: Error in function boost::math::beta<N5boost14multiprecision6numberINS0_8backends13cpp_bin_floatILj50ELNS2_15digit_base_typeE10EviLi0ELi0EEELNS0_26expression_template_optionE0EEE>(N5boost14multiprecision6numberINS0_8backends13cpp_bin_floatILj50ELNS2_15digit_base_typeE10EviLi0ELi0EEELNS0_26expression_template_optionE0EEE,N5boost14multiprecision6numberINS0_8backends13cpp_bin_floatILj50ELNS2_15digit_base_typeE10EviLi0ELi0EEELNS0_26expression_template_optionE0EEE): The arguments to the beta function must be greater than zero (got a=-1.300000000000000044408920985006261616945266723632812).) | boost-beta-positive-args-only |
| explained | T2-beta-003 | T2 | Beta | boost | scipy | asymmetric-refusal | refused-by boost (std-exception: Error in function boost::math::beta<N5boost14multiprecision6numberINS0_8backends13cpp_bin_floatILj50ELNS2_15digit_base_typeE10EviLi0ELi0EEELNS0_26expression_template_optionE0EEE>(N5boost14multiprecision6numberINS0_8backends13cpp_bin_floatILj50ELNS2_15digit_base_typeE10EviLi0ELi0EEELNS0_26expression_template_optionE0EEE,N5boost14multiprecision6numberINS0_8backends13cpp_bin_floatILj50ELNS2_15digit_base_typeE10EviLi0ELi0EEELNS0_26expression_template_optionE0EEE): The arguments to the beta function must be greater than zero (got a=-1.300000000000000044408920985006261616945266723632812).) | boost-beta-positive-args-only |
| explained | T2-beta-003 | T2 | Beta | boost | wolfram | asymmetric-refusal | refused-by boost (std-exception: Error in function boost::math::beta<N5boost14multiprecision6numberINS0_8backends13cpp_bin_floatILj50ELNS2_15digit_base_typeE10EviLi0ELi0EEELNS0_26expression_template_optionE0EEE>(N5boost14multiprecision6numberINS0_8backends13cpp_bin_floatILj50ELNS2_15digit_base_typeE10EviLi0ELi0EEELNS0_26expression_template_optionE0EEE,N5boost14multiprecision6numberINS0_8backends13cpp_bin_floatILj50ELNS2_15digit_base_typeE10EviLi0ELi0EEELNS0_26expression_template_optionE0EEE): The arguments to the beta function must be greater than zero (got a=-1.300000000000000044408920985006261616945266723632812).) | boost-beta-positive-args-only |
| explained | T2-loggamma-001 | T2 | LogGamma | arb | boost | shape-mismatch | complex vs real | L_boost_loggamma_real_only |
| explained | T2-loggamma-001 | T2 | LogGamma | boost | mpmath | shape-mismatch | real vs complex | L_boost_loggamma_real_only |
| explained | T2-loggamma-001 | T2 | LogGamma | boost | scipy | shape-mismatch | real vs complex | L_boost_loggamma_real_only |
| explained | T2-loggamma-001 | T2 | LogGamma | boost | wolfram | shape-mismatch | real vs complex | L_boost_loggamma_real_only |
| explained | T2-loggamma-002 | T2 | LogGamma | arb | boost | shape-mismatch | complex vs real | L_boost_loggamma_real_only |
| explained | T2-loggamma-002 | T2 | LogGamma | boost | mpmath | shape-mismatch | real vs complex | L_boost_loggamma_real_only |
| explained | T2-loggamma-002 | T2 | LogGamma | boost | scipy | shape-mismatch | real vs complex | L_boost_loggamma_real_only |
| explained | T2-loggamma-002 | T2 | LogGamma | boost | wolfram | shape-mismatch | real vs complex | L_boost_loggamma_real_only |
| explained | T2-loggamma-003 | T2 | LogGamma | arb | boost | shape-mismatch | complex vs real | L_boost_loggamma_real_only |
| explained | T2-loggamma-003 | T2 | LogGamma | boost | mpmath | shape-mismatch | real vs complex | L_boost_loggamma_real_only |
| explained | T2-loggamma-003 | T2 | LogGamma | boost | scipy | shape-mismatch | real vs complex | L_boost_loggamma_real_only |
| explained | T2-loggamma-003 | T2 | LogGamma | boost | wolfram | shape-mismatch | real vs complex | L_boost_loggamma_real_only |
| explained | T2-loggamma-004 | T2 | LogGamma | arb | boost | shape-mismatch | complex vs real | L_boost_loggamma_real_only |
| explained | T2-loggamma-004 | T2 | LogGamma | boost | mpmath | shape-mismatch | real vs complex | L_boost_loggamma_real_only |
| explained | T2-loggamma-004 | T2 | LogGamma | boost | scipy | shape-mismatch | real vs complex | L_boost_loggamma_real_only |
| explained | T2-loggamma-004 | T2 | LogGamma | boost | wolfram | shape-mismatch | real vs complex | L_boost_loggamma_real_only |
| explained | T2-loggamma-005 | T2 | LogGamma | arb | boost | shape-mismatch | complex vs real | L_boost_loggamma_real_only |
| explained | T2-loggamma-005 | T2 | LogGamma | boost | mpmath | shape-mismatch | real vs complex | L_boost_loggamma_real_only |
| explained | T2-loggamma-005 | T2 | LogGamma | boost | scipy | shape-mismatch | real vs complex | L_boost_loggamma_real_only |
| explained | T2-loggamma-005 | T2 | LogGamma | boost | wolfram | shape-mismatch | real vs complex | L_boost_loggamma_real_only |
| explained | T2-loggamma-006 | T2 | LogGamma | arb | boost | shape-mismatch | complex vs real | L_boost_loggamma_real_only |
| explained | T2-loggamma-006 | T2 | LogGamma | boost | mpmath | shape-mismatch | real vs complex | L_boost_loggamma_real_only |
| explained | T2-loggamma-006 | T2 | LogGamma | boost | scipy | shape-mismatch | real vs complex | L_boost_loggamma_real_only |
| explained | T2-loggamma-006 | T2 | LogGamma | boost | wolfram | shape-mismatch | real vs complex | L_boost_loggamma_real_only |
| explained | T2-loggamma-007 | T2 | LogGamma | arb | boost | shape-mismatch | complex vs real | L_boost_loggamma_real_only |
| explained | T2-loggamma-007 | T2 | LogGamma | boost | mpmath | shape-mismatch | real vs complex | L_boost_loggamma_real_only |
| explained | T2-loggamma-007 | T2 | LogGamma | boost | scipy | shape-mismatch | real vs complex | L_boost_loggamma_real_only |
| explained | T2-loggamma-007 | T2 | LogGamma | boost | wolfram | shape-mismatch | real vs complex | L_boost_loggamma_real_only |
| explained | T2-loggamma-008 | T2 | LogGamma | arb | boost | shape-mismatch | complex vs real | L_boost_loggamma_real_only |
| explained | T2-loggamma-008 | T2 | LogGamma | boost | mpmath | shape-mismatch | real vs complex | L_boost_loggamma_real_only |
| explained | T2-loggamma-008 | T2 | LogGamma | boost | scipy | shape-mismatch | real vs complex | L_boost_loggamma_real_only |
| explained | T2-loggamma-008 | T2 | LogGamma | boost | wolfram | shape-mismatch | real vs complex | L_boost_loggamma_real_only |
| explained | T2-pochhammer-001 | T2 | Pochhammer | arb | boost | asymmetric-refusal | refused-by boost (boost-no-pochhammer) | boost-no-pochhammer |
| explained | T2-pochhammer-001 | T2 | Pochhammer | boost | mpmath | asymmetric-refusal | refused-by boost (boost-no-pochhammer) | boost-no-pochhammer |
| explained | T2-pochhammer-001 | T2 | Pochhammer | boost | scipy | asymmetric-refusal | refused-by boost (boost-no-pochhammer) | boost-no-pochhammer |
| explained | T2-pochhammer-001 | T2 | Pochhammer | boost | wolfram | asymmetric-refusal | refused-by boost (boost-no-pochhammer) | boost-no-pochhammer |
| explained | T2-pochhammer-002 | T2 | Pochhammer | arb | boost | asymmetric-refusal | refused-by boost (boost-no-pochhammer) | boost-no-pochhammer |
| explained | T2-pochhammer-002 | T2 | Pochhammer | boost | mpmath | asymmetric-refusal | refused-by boost (boost-no-pochhammer) | boost-no-pochhammer |
| explained | T2-pochhammer-002 | T2 | Pochhammer | boost | scipy | asymmetric-refusal | refused-by boost (boost-no-pochhammer) | boost-no-pochhammer |
| explained | T2-pochhammer-002 | T2 | Pochhammer | boost | wolfram | asymmetric-refusal | refused-by boost (boost-no-pochhammer) | boost-no-pochhammer |
| explained | T2-pochhammer-003 | T2 | Pochhammer | arb | boost | asymmetric-refusal | refused-by boost (boost-no-pochhammer) | boost-no-pochhammer |
| explained | T2-pochhammer-003 | T2 | Pochhammer | boost | mpmath | asymmetric-refusal | refused-by boost (boost-no-pochhammer) | boost-no-pochhammer |
| explained | T2-pochhammer-003 | T2 | Pochhammer | boost | scipy | asymmetric-refusal | refused-by boost (boost-no-pochhammer) | boost-no-pochhammer |
| explained | T2-pochhammer-003 | T2 | Pochhammer | boost | wolfram | asymmetric-refusal | refused-by boost (boost-no-pochhammer) | boost-no-pochhammer |
| explained | T2-pochhammer-004 | T2 | Pochhammer | arb | boost | asymmetric-refusal | refused-by boost (boost-no-pochhammer) | boost-no-pochhammer |
| explained | T2-pochhammer-004 | T2 | Pochhammer | boost | mpmath | asymmetric-refusal | refused-by boost (boost-no-pochhammer) | boost-no-pochhammer |
| explained | T2-pochhammer-004 | T2 | Pochhammer | boost | scipy | asymmetric-refusal | refused-by boost (boost-no-pochhammer) | boost-no-pochhammer |
| explained | T2-pochhammer-004 | T2 | Pochhammer | boost | wolfram | asymmetric-refusal | refused-by boost (boost-no-pochhammer) | boost-no-pochhammer |
| explained | T2-pochhammer-005 | T2 | Pochhammer | arb | boost | asymmetric-refusal | refused-by boost (boost-no-pochhammer) | boost-no-pochhammer |
| explained | T2-pochhammer-005 | T2 | Pochhammer | boost | mpmath | asymmetric-refusal | refused-by boost (boost-no-pochhammer) | boost-no-pochhammer |
| explained | T2-pochhammer-005 | T2 | Pochhammer | boost | scipy | asymmetric-refusal | refused-by boost (boost-no-pochhammer) | boost-no-pochhammer |
| explained | T2-pochhammer-005 | T2 | Pochhammer | boost | wolfram | asymmetric-refusal | refused-by boost (boost-no-pochhammer) | boost-no-pochhammer |
| explained | T3-digamma-001 | T3 | Digamma | arb | scipy | asymmetric-refusal | refused-by arb (nan) | L17-pole-asymmetric-refusal |
| explained | T3-digamma-001 | T3 | Digamma | arb | wolfram | asymmetric-refusal | refused-by arb (nan) | L17-pole-asymmetric-refusal |
| explained | T3-digamma-001 | T3 | Digamma | boost | scipy | asymmetric-refusal | refused-by boost (std-exception: Error in function boost::math::digamma<N5boost14multiprecision6numberINS0_8backends13cpp_bin_floatILj50ELNS2_15digit_base_typeE10EviLi0ELi0EEELNS0_26expression_template_optionE0EEE>(N5boost14multiprecision6numberINS0_8backends13cpp_bin_floatILj50ELNS2_15digit_base_typeE10EviLi0ELi0EEELNS0_26expression_template_optionE0EEE): Evaluation of function at pole 0) | L17-pole-asymmetric-refusal |
| explained | T3-digamma-001 | T3 | Digamma | boost | wolfram | asymmetric-refusal | refused-by boost (std-exception: Error in function boost::math::digamma<N5boost14multiprecision6numberINS0_8backends13cpp_bin_floatILj50ELNS2_15digit_base_typeE10EviLi0ELi0EEELNS0_26expression_template_optionE0EEE>(N5boost14multiprecision6numberINS0_8backends13cpp_bin_floatILj50ELNS2_15digit_base_typeE10EviLi0ELi0EEELNS0_26expression_template_optionE0EEE): Evaluation of function at pole 0) | L17-pole-asymmetric-refusal |
| explained | T3-digamma-001 | T3 | Digamma | mpmath | scipy | asymmetric-refusal | refused-by mpmath (ValueError: polygamma pole) | L17-pole-asymmetric-refusal |
| explained | T3-digamma-001 | T3 | Digamma | mpmath | wolfram | asymmetric-refusal | refused-by mpmath (ValueError: polygamma pole) | L17-pole-asymmetric-refusal |
| explained | T3-digamma-001 | T3 | Digamma | scipy | wolfram | limit-disagree | -Infinity vs ComplexInfinity | L17-pole-limit-vocabulary |
| explained | T3-digamma-006 | T3 | Digamma | arb | scipy | asymmetric-refusal | refused-by arb (nan) | L17-pole-asymmetric-refusal |
| explained | T3-digamma-006 | T3 | Digamma | arb | wolfram | asymmetric-refusal | refused-by arb (nan) | L17-pole-asymmetric-refusal |
| explained | T3-digamma-006 | T3 | Digamma | boost | scipy | asymmetric-refusal | refused-by boost (std-exception: Error in function boost::math::digamma<N5boost14multiprecision6numberINS0_8backends13cpp_bin_floatILj50ELNS2_15digit_base_typeE10EviLi0ELi0EEELNS0_26expression_template_optionE0EEE>(N5boost14multiprecision6numberINS0_8backends13cpp_bin_floatILj50ELNS2_15digit_base_typeE10EviLi0ELi0EEELNS0_26expression_template_optionE0EEE): Evaluation of function at pole -1) | L17-pole-asymmetric-refusal |
| explained | T3-digamma-006 | T3 | Digamma | boost | wolfram | asymmetric-refusal | refused-by boost (std-exception: Error in function boost::math::digamma<N5boost14multiprecision6numberINS0_8backends13cpp_bin_floatILj50ELNS2_15digit_base_typeE10EviLi0ELi0EEELNS0_26expression_template_optionE0EEE>(N5boost14multiprecision6numberINS0_8backends13cpp_bin_floatILj50ELNS2_15digit_base_typeE10EviLi0ELi0EEELNS0_26expression_template_optionE0EEE): Evaluation of function at pole -1) | L17-pole-asymmetric-refusal |
| explained | T3-digamma-006 | T3 | Digamma | mpmath | scipy | asymmetric-refusal | refused-by mpmath (ValueError: polygamma pole) | L17-pole-asymmetric-refusal |
| explained | T3-digamma-006 | T3 | Digamma | mpmath | wolfram | asymmetric-refusal | refused-by mpmath (ValueError: polygamma pole) | L17-pole-asymmetric-refusal |
| explained | T3-digamma-006 | T3 | Digamma | scipy | wolfram | limit-disagree | NaN vs ComplexInfinity | L17-pole-limit-vocabulary |
| explained | T3-digamma-008 | T3 | Digamma | arb | scipy | ulp-agree | ulp=3961 (threshold 256) | L_T3_cancellation_stress |
| explained | T3-digamma-008 | T3 | Digamma | boost | scipy | ulp-agree | ulp=3961 (threshold 256) | L_T3_cancellation_stress |
| explained | T3-digamma-008 | T3 | Digamma | mpmath | scipy | ulp-agree | ulp=3961 (threshold 256) | L_T3_cancellation_stress |
| explained | T3-digamma-008 | T3 | Digamma | scipy | wolfram | ulp-agree | ulp=3961 (threshold 256) | L_T3_cancellation_stress |
| explained | T3-digamma-011 | T3 | Digamma | arb | scipy | asymmetric-refusal | refused-by arb (nan) | L17-pole-asymmetric-refusal |
| explained | T3-digamma-011 | T3 | Digamma | arb | wolfram | asymmetric-refusal | refused-by arb (nan) | L17-pole-asymmetric-refusal |
| explained | T3-digamma-011 | T3 | Digamma | boost | scipy | asymmetric-refusal | refused-by boost (std-exception: Error in function boost::math::digamma<N5boost14multiprecision6numberINS0_8backends13cpp_bin_floatILj50ELNS2_15digit_base_typeE10EviLi0ELi0EEELNS0_26expression_template_optionE0EEE>(N5boost14multiprecision6numberINS0_8backends13cpp_bin_floatILj50ELNS2_15digit_base_typeE10EviLi0ELi0EEELNS0_26expression_template_optionE0EEE): Evaluation of function at pole -2) | L17-pole-asymmetric-refusal |
| explained | T3-digamma-011 | T3 | Digamma | boost | wolfram | asymmetric-refusal | refused-by boost (std-exception: Error in function boost::math::digamma<N5boost14multiprecision6numberINS0_8backends13cpp_bin_floatILj50ELNS2_15digit_base_typeE10EviLi0ELi0EEELNS0_26expression_template_optionE0EEE>(N5boost14multiprecision6numberINS0_8backends13cpp_bin_floatILj50ELNS2_15digit_base_typeE10EviLi0ELi0EEELNS0_26expression_template_optionE0EEE): Evaluation of function at pole -2) | L17-pole-asymmetric-refusal |
| explained | T3-digamma-011 | T3 | Digamma | mpmath | scipy | asymmetric-refusal | refused-by mpmath (ValueError: polygamma pole) | L17-pole-asymmetric-refusal |
| explained | T3-digamma-011 | T3 | Digamma | mpmath | wolfram | asymmetric-refusal | refused-by mpmath (ValueError: polygamma pole) | L17-pole-asymmetric-refusal |
| explained | T3-digamma-011 | T3 | Digamma | scipy | wolfram | limit-disagree | NaN vs ComplexInfinity | L17-pole-limit-vocabulary |
| explained | T3-digamma-013 | T3 | Digamma | arb | scipy | ulp-agree | ulp=3961 (threshold 256) | L_T3_cancellation_stress |
| explained | T3-digamma-013 | T3 | Digamma | boost | scipy | ulp-agree | ulp=3961 (threshold 256) | L_T3_cancellation_stress |
| explained | T3-digamma-013 | T3 | Digamma | mpmath | scipy | ulp-agree | ulp=3961 (threshold 256) | L_T3_cancellation_stress |
| explained | T3-digamma-013 | T3 | Digamma | scipy | wolfram | ulp-agree | ulp=3961 (threshold 256) | L_T3_cancellation_stress |
| explained | T3-digamma-016 | T3 | Digamma | arb | scipy | asymmetric-refusal | refused-by arb (nan) | L17-pole-asymmetric-refusal |
| explained | T3-digamma-016 | T3 | Digamma | arb | wolfram | asymmetric-refusal | refused-by arb (nan) | L17-pole-asymmetric-refusal |
| explained | T3-digamma-016 | T3 | Digamma | boost | scipy | asymmetric-refusal | refused-by boost (std-exception: Error in function boost::math::digamma<N5boost14multiprecision6numberINS0_8backends13cpp_bin_floatILj50ELNS2_15digit_base_typeE10EviLi0ELi0EEELNS0_26expression_template_optionE0EEE>(N5boost14multiprecision6numberINS0_8backends13cpp_bin_floatILj50ELNS2_15digit_base_typeE10EviLi0ELi0EEELNS0_26expression_template_optionE0EEE): Evaluation of function at pole -3) | L17-pole-asymmetric-refusal |
| explained | T3-digamma-016 | T3 | Digamma | boost | wolfram | asymmetric-refusal | refused-by boost (std-exception: Error in function boost::math::digamma<N5boost14multiprecision6numberINS0_8backends13cpp_bin_floatILj50ELNS2_15digit_base_typeE10EviLi0ELi0EEELNS0_26expression_template_optionE0EEE>(N5boost14multiprecision6numberINS0_8backends13cpp_bin_floatILj50ELNS2_15digit_base_typeE10EviLi0ELi0EEELNS0_26expression_template_optionE0EEE): Evaluation of function at pole -3) | L17-pole-asymmetric-refusal |
| explained | T3-digamma-016 | T3 | Digamma | mpmath | scipy | asymmetric-refusal | refused-by mpmath (ValueError: polygamma pole) | L17-pole-asymmetric-refusal |
| explained | T3-digamma-016 | T3 | Digamma | mpmath | wolfram | asymmetric-refusal | refused-by mpmath (ValueError: polygamma pole) | L17-pole-asymmetric-refusal |
| explained | T3-digamma-016 | T3 | Digamma | scipy | wolfram | limit-disagree | NaN vs ComplexInfinity | L17-pole-limit-vocabulary |
| explained | T3-digamma-018 | T3 | Digamma | arb | scipy | ulp-agree | ulp=475 (threshold 256) | L_T3_cancellation_stress |
| explained | T3-digamma-018 | T3 | Digamma | boost | scipy | ulp-agree | ulp=475 (threshold 256) | L_T3_cancellation_stress |
| explained | T3-digamma-018 | T3 | Digamma | mpmath | scipy | ulp-agree | ulp=475 (threshold 256) | L_T3_cancellation_stress |
| explained | T3-digamma-018 | T3 | Digamma | scipy | wolfram | ulp-agree | ulp=475 (threshold 256) | L_T3_cancellation_stress |
| explained | T3-gamma-001 | T3 | Gamma | arb | scipy | asymmetric-refusal | refused-by arb (nan) | L17-pole-asymmetric-refusal |
| explained | T3-gamma-001 | T3 | Gamma | arb | wolfram | asymmetric-refusal | refused-by arb (nan) | L17-pole-asymmetric-refusal |
| explained | T3-gamma-001 | T3 | Gamma | boost | scipy | asymmetric-refusal | refused-by boost (std-exception: Error in function boost::math::tgamma<N5boost14multiprecision6numberINS0_8backends13cpp_bin_floatILj50ELNS2_15digit_base_typeE10EviLi0ELi0EEELNS0_26expression_template_optionE0EEE>(N5boost14multiprecision6numberINS0_8backends13cpp_bin_floatILj50ELNS2_15digit_base_typeE10EviLi0ELi0EEELNS0_26expression_template_optionE0EEE): Evaluation of tgamma at a negative integer 0.) | L17-pole-asymmetric-refusal |
| explained | T3-gamma-001 | T3 | Gamma | boost | wolfram | asymmetric-refusal | refused-by boost (std-exception: Error in function boost::math::tgamma<N5boost14multiprecision6numberINS0_8backends13cpp_bin_floatILj50ELNS2_15digit_base_typeE10EviLi0ELi0EEELNS0_26expression_template_optionE0EEE>(N5boost14multiprecision6numberINS0_8backends13cpp_bin_floatILj50ELNS2_15digit_base_typeE10EviLi0ELi0EEELNS0_26expression_template_optionE0EEE): Evaluation of tgamma at a negative integer 0.) | L17-pole-asymmetric-refusal |
| explained | T3-gamma-001 | T3 | Gamma | mpmath | scipy | asymmetric-refusal | refused-by mpmath (ValueError: gamma function pole) | L17-pole-asymmetric-refusal |
| explained | T3-gamma-001 | T3 | Gamma | mpmath | wolfram | asymmetric-refusal | refused-by mpmath (ValueError: gamma function pole) | L17-pole-asymmetric-refusal |
| explained | T3-gamma-006 | T3 | Gamma | arb | scipy | asymmetric-refusal | refused-by arb (nan) | L17-pole-asymmetric-refusal |
| explained | T3-gamma-006 | T3 | Gamma | arb | wolfram | asymmetric-refusal | refused-by arb (nan) | L17-pole-asymmetric-refusal |
| explained | T3-gamma-006 | T3 | Gamma | boost | scipy | asymmetric-refusal | refused-by boost (std-exception: Error in function boost::math::tgamma<N5boost14multiprecision6numberINS0_8backends13cpp_bin_floatILj50ELNS2_15digit_base_typeE10EviLi0ELi0EEELNS0_26expression_template_optionE0EEE>(N5boost14multiprecision6numberINS0_8backends13cpp_bin_floatILj50ELNS2_15digit_base_typeE10EviLi0ELi0EEELNS0_26expression_template_optionE0EEE): Evaluation of tgamma at a negative integer -1.) | L17-pole-asymmetric-refusal |
| explained | T3-gamma-006 | T3 | Gamma | boost | wolfram | asymmetric-refusal | refused-by boost (std-exception: Error in function boost::math::tgamma<N5boost14multiprecision6numberINS0_8backends13cpp_bin_floatILj50ELNS2_15digit_base_typeE10EviLi0ELi0EEELNS0_26expression_template_optionE0EEE>(N5boost14multiprecision6numberINS0_8backends13cpp_bin_floatILj50ELNS2_15digit_base_typeE10EviLi0ELi0EEELNS0_26expression_template_optionE0EEE): Evaluation of tgamma at a negative integer -1.) | L17-pole-asymmetric-refusal |
| explained | T3-gamma-006 | T3 | Gamma | mpmath | scipy | asymmetric-refusal | refused-by mpmath (ValueError: gamma function pole) | L17-pole-asymmetric-refusal |
| explained | T3-gamma-006 | T3 | Gamma | mpmath | wolfram | asymmetric-refusal | refused-by mpmath (ValueError: gamma function pole) | L17-pole-asymmetric-refusal |
| explained | T3-gamma-006 | T3 | Gamma | scipy | wolfram | limit-disagree | NaN vs ComplexInfinity | L17-pole-limit-vocabulary |
| explained | T3-gamma-011 | T3 | Gamma | arb | scipy | asymmetric-refusal | refused-by arb (nan) | L17-pole-asymmetric-refusal |
| explained | T3-gamma-011 | T3 | Gamma | arb | wolfram | asymmetric-refusal | refused-by arb (nan) | L17-pole-asymmetric-refusal |
| explained | T3-gamma-011 | T3 | Gamma | boost | scipy | asymmetric-refusal | refused-by boost (std-exception: Error in function boost::math::tgamma<N5boost14multiprecision6numberINS0_8backends13cpp_bin_floatILj50ELNS2_15digit_base_typeE10EviLi0ELi0EEELNS0_26expression_template_optionE0EEE>(N5boost14multiprecision6numberINS0_8backends13cpp_bin_floatILj50ELNS2_15digit_base_typeE10EviLi0ELi0EEELNS0_26expression_template_optionE0EEE): Evaluation of tgamma at a negative integer -2.) | L17-pole-asymmetric-refusal |
| explained | T3-gamma-011 | T3 | Gamma | boost | wolfram | asymmetric-refusal | refused-by boost (std-exception: Error in function boost::math::tgamma<N5boost14multiprecision6numberINS0_8backends13cpp_bin_floatILj50ELNS2_15digit_base_typeE10EviLi0ELi0EEELNS0_26expression_template_optionE0EEE>(N5boost14multiprecision6numberINS0_8backends13cpp_bin_floatILj50ELNS2_15digit_base_typeE10EviLi0ELi0EEELNS0_26expression_template_optionE0EEE): Evaluation of tgamma at a negative integer -2.) | L17-pole-asymmetric-refusal |
| explained | T3-gamma-011 | T3 | Gamma | mpmath | scipy | asymmetric-refusal | refused-by mpmath (ValueError: gamma function pole) | L17-pole-asymmetric-refusal |
| explained | T3-gamma-011 | T3 | Gamma | mpmath | wolfram | asymmetric-refusal | refused-by mpmath (ValueError: gamma function pole) | L17-pole-asymmetric-refusal |
| explained | T3-gamma-011 | T3 | Gamma | scipy | wolfram | limit-disagree | NaN vs ComplexInfinity | L17-pole-limit-vocabulary |
| explained | T3-gamma-016 | T3 | Gamma | arb | scipy | asymmetric-refusal | refused-by arb (nan) | L17-pole-asymmetric-refusal |
| explained | T3-gamma-016 | T3 | Gamma | arb | wolfram | asymmetric-refusal | refused-by arb (nan) | L17-pole-asymmetric-refusal |
| explained | T3-gamma-016 | T3 | Gamma | boost | scipy | asymmetric-refusal | refused-by boost (std-exception: Error in function boost::math::tgamma<N5boost14multiprecision6numberINS0_8backends13cpp_bin_floatILj50ELNS2_15digit_base_typeE10EviLi0ELi0EEELNS0_26expression_template_optionE0EEE>(N5boost14multiprecision6numberINS0_8backends13cpp_bin_floatILj50ELNS2_15digit_base_typeE10EviLi0ELi0EEELNS0_26expression_template_optionE0EEE): Evaluation of tgamma at a negative integer -3.) | L17-pole-asymmetric-refusal |
| explained | T3-gamma-016 | T3 | Gamma | boost | wolfram | asymmetric-refusal | refused-by boost (std-exception: Error in function boost::math::tgamma<N5boost14multiprecision6numberINS0_8backends13cpp_bin_floatILj50ELNS2_15digit_base_typeE10EviLi0ELi0EEELNS0_26expression_template_optionE0EEE>(N5boost14multiprecision6numberINS0_8backends13cpp_bin_floatILj50ELNS2_15digit_base_typeE10EviLi0ELi0EEELNS0_26expression_template_optionE0EEE): Evaluation of tgamma at a negative integer -3.) | L17-pole-asymmetric-refusal |
| explained | T3-gamma-016 | T3 | Gamma | mpmath | scipy | asymmetric-refusal | refused-by mpmath (ValueError: gamma function pole) | L17-pole-asymmetric-refusal |
| explained | T3-gamma-016 | T3 | Gamma | mpmath | wolfram | asymmetric-refusal | refused-by mpmath (ValueError: gamma function pole) | L17-pole-asymmetric-refusal |
| explained | T3-gamma-016 | T3 | Gamma | scipy | wolfram | limit-disagree | NaN vs ComplexInfinity | L17-pole-limit-vocabulary |
| explained | T3-loggamma-001 | T3 | LogGamma | arb | boost | shape-mismatch | complex vs real | L_boost_loggamma_real_only |
| explained | T3-loggamma-001 | T3 | LogGamma | boost | mpmath | shape-mismatch | real vs complex | L_boost_loggamma_real_only |
| explained | T3-loggamma-001 | T3 | LogGamma | boost | scipy | shape-mismatch | real vs complex | L_boost_loggamma_real_only |
| explained | T3-loggamma-001 | T3 | LogGamma | boost | wolfram | shape-mismatch | real vs complex | L_boost_loggamma_real_only |
| explained | T3-loggamma-002 | T3 | LogGamma | arb | boost | shape-mismatch | complex vs real | L_boost_loggamma_real_only |
| explained | T3-loggamma-002 | T3 | LogGamma | boost | mpmath | shape-mismatch | real vs complex | L_boost_loggamma_real_only |
| explained | T3-loggamma-002 | T3 | LogGamma | boost | scipy | shape-mismatch | real vs complex | L_boost_loggamma_real_only |
| explained | T3-loggamma-002 | T3 | LogGamma | boost | wolfram | shape-mismatch | real vs complex | L_boost_loggamma_real_only |
| explained | T3-loggamma-003 | T3 | LogGamma | arb | boost | shape-mismatch | complex vs real | L_boost_loggamma_real_only |
| explained | T3-loggamma-003 | T3 | LogGamma | boost | mpmath | shape-mismatch | real vs complex | L_boost_loggamma_real_only |
| explained | T3-loggamma-003 | T3 | LogGamma | boost | scipy | shape-mismatch | real vs complex | L_boost_loggamma_real_only |
| explained | T3-loggamma-003 | T3 | LogGamma | boost | wolfram | shape-mismatch | real vs complex | L_boost_loggamma_real_only |
| explained | T3-loggamma-004 | T3 | LogGamma | arb | boost | shape-mismatch | complex vs real | L_boost_loggamma_real_only |
| explained | T3-loggamma-004 | T3 | LogGamma | boost | mpmath | shape-mismatch | real vs complex | L_boost_loggamma_real_only |
| explained | T3-loggamma-004 | T3 | LogGamma | boost | scipy | shape-mismatch | real vs complex | L_boost_loggamma_real_only |
| explained | T3-loggamma-004 | T3 | LogGamma | boost | wolfram | shape-mismatch | real vs complex | L_boost_loggamma_real_only |
| explained | T4-barnesg-001 | T4 | BarnesG | arb | boost | asymmetric-refusal | refused-by boost (boost-no-complex) | L16-no-barnesg-bronze-or-silver |
| explained | T4-barnesg-001 | T4 | BarnesG | arb | scipy | asymmetric-refusal | refused-by scipy (L16: SciPy has no barnesg; bronze tier cannot cover this head. Use Wolfram (G2) or mpmath (G3) for gold values.) | L16-no-barnesg-bronze-or-silver |
| explained | T4-barnesg-001 | T4 | BarnesG | boost | mpmath | asymmetric-refusal | refused-by boost (boost-no-complex) | L16-no-barnesg-bronze-or-silver |
| explained | T4-barnesg-001 | T4 | BarnesG | boost | wolfram | asymmetric-refusal | refused-by boost (boost-no-complex) | L16-no-barnesg-bronze-or-silver |
| explained | T4-barnesg-001 | T4 | BarnesG | mpmath | scipy | asymmetric-refusal | refused-by scipy (L16: SciPy has no barnesg; bronze tier cannot cover this head. Use Wolfram (G2) or mpmath (G3) for gold values.) | L16-no-barnesg-bronze-or-silver |
| explained | T4-barnesg-001 | T4 | BarnesG | scipy | wolfram | asymmetric-refusal | refused-by scipy (L16: SciPy has no barnesg; bronze tier cannot cover this head. Use Wolfram (G2) or mpmath (G3) for gold values.) | L16-no-barnesg-bronze-or-silver |
| explained | T4-barnesg-002 | T4 | BarnesG | arb | boost | asymmetric-refusal | refused-by boost (boost-no-complex) | L16-no-barnesg-bronze-or-silver |
| explained | T4-barnesg-002 | T4 | BarnesG | arb | scipy | asymmetric-refusal | refused-by scipy (L16: SciPy has no barnesg; bronze tier cannot cover this head. Use Wolfram (G2) or mpmath (G3) for gold values.) | L16-no-barnesg-bronze-or-silver |
| explained | T4-barnesg-002 | T4 | BarnesG | boost | mpmath | asymmetric-refusal | refused-by boost (boost-no-complex) | L16-no-barnesg-bronze-or-silver |
| explained | T4-barnesg-002 | T4 | BarnesG | boost | wolfram | asymmetric-refusal | refused-by boost (boost-no-complex) | L16-no-barnesg-bronze-or-silver |
| explained | T4-barnesg-002 | T4 | BarnesG | mpmath | scipy | asymmetric-refusal | refused-by scipy (L16: SciPy has no barnesg; bronze tier cannot cover this head. Use Wolfram (G2) or mpmath (G3) for gold values.) | L16-no-barnesg-bronze-or-silver |
| explained | T4-barnesg-002 | T4 | BarnesG | scipy | wolfram | asymmetric-refusal | refused-by scipy (L16: SciPy has no barnesg; bronze tier cannot cover this head. Use Wolfram (G2) or mpmath (G3) for gold values.) | L16-no-barnesg-bronze-or-silver |
| explained | T4-barnesg-003 | T4 | BarnesG | arb | boost | asymmetric-refusal | refused-by boost (boost-no-complex) | L16-no-barnesg-bronze-or-silver |
| explained | T4-barnesg-003 | T4 | BarnesG | arb | scipy | asymmetric-refusal | refused-by scipy (L16: SciPy has no barnesg; bronze tier cannot cover this head. Use Wolfram (G2) or mpmath (G3) for gold values.) | L16-no-barnesg-bronze-or-silver |
| explained | T4-barnesg-003 | T4 | BarnesG | boost | mpmath | asymmetric-refusal | refused-by boost (boost-no-complex) | L16-no-barnesg-bronze-or-silver |
| explained | T4-barnesg-003 | T4 | BarnesG | boost | wolfram | asymmetric-refusal | refused-by boost (boost-no-complex) | L16-no-barnesg-bronze-or-silver |
| explained | T4-barnesg-003 | T4 | BarnesG | mpmath | scipy | asymmetric-refusal | refused-by scipy (L16: SciPy has no barnesg; bronze tier cannot cover this head. Use Wolfram (G2) or mpmath (G3) for gold values.) | L16-no-barnesg-bronze-or-silver |
| explained | T4-barnesg-003 | T4 | BarnesG | scipy | wolfram | asymmetric-refusal | refused-by scipy (L16: SciPy has no barnesg; bronze tier cannot cover this head. Use Wolfram (G2) or mpmath (G3) for gold values.) | L16-no-barnesg-bronze-or-silver |
| explained | T4-barnesg-004 | T4 | BarnesG | arb | boost | asymmetric-refusal | refused-by boost (boost-no-complex) | L16-no-barnesg-bronze-or-silver |
| explained | T4-barnesg-004 | T4 | BarnesG | arb | scipy | asymmetric-refusal | refused-by scipy (L16: SciPy has no barnesg; bronze tier cannot cover this head. Use Wolfram (G2) or mpmath (G3) for gold values.) | L16-no-barnesg-bronze-or-silver |
| explained | T4-barnesg-004 | T4 | BarnesG | boost | mpmath | asymmetric-refusal | refused-by boost (boost-no-complex) | L16-no-barnesg-bronze-or-silver |
| explained | T4-barnesg-004 | T4 | BarnesG | boost | wolfram | asymmetric-refusal | refused-by boost (boost-no-complex) | L16-no-barnesg-bronze-or-silver |
| explained | T4-barnesg-004 | T4 | BarnesG | mpmath | scipy | asymmetric-refusal | refused-by scipy (L16: SciPy has no barnesg; bronze tier cannot cover this head. Use Wolfram (G2) or mpmath (G3) for gold values.) | L16-no-barnesg-bronze-or-silver |
| explained | T4-barnesg-004 | T4 | BarnesG | scipy | wolfram | asymmetric-refusal | refused-by scipy (L16: SciPy has no barnesg; bronze tier cannot cover this head. Use Wolfram (G2) or mpmath (G3) for gold values.) | L16-no-barnesg-bronze-or-silver |
| explained | T4-digamma-001 | T4 | Digamma | arb | boost | asymmetric-refusal | refused-by boost (boost-no-complex) | boost-no-complex |
| explained | T4-digamma-001 | T4 | Digamma | boost | mpmath | asymmetric-refusal | refused-by boost (boost-no-complex) | boost-no-complex |
| explained | T4-digamma-001 | T4 | Digamma | boost | scipy | asymmetric-refusal | refused-by boost (boost-no-complex) | boost-no-complex |
| explained | T4-digamma-001 | T4 | Digamma | boost | wolfram | asymmetric-refusal | refused-by boost (boost-no-complex) | boost-no-complex |
| explained | T4-digamma-002 | T4 | Digamma | arb | boost | asymmetric-refusal | refused-by boost (boost-no-complex) | boost-no-complex |
| explained | T4-digamma-002 | T4 | Digamma | boost | mpmath | asymmetric-refusal | refused-by boost (boost-no-complex) | boost-no-complex |
| explained | T4-digamma-002 | T4 | Digamma | boost | scipy | asymmetric-refusal | refused-by boost (boost-no-complex) | boost-no-complex |
| explained | T4-digamma-002 | T4 | Digamma | boost | wolfram | asymmetric-refusal | refused-by boost (boost-no-complex) | boost-no-complex |
| explained | T4-digamma-003 | T4 | Digamma | arb | boost | asymmetric-refusal | refused-by boost (boost-no-complex) | boost-no-complex |
| explained | T4-digamma-003 | T4 | Digamma | boost | mpmath | asymmetric-refusal | refused-by boost (boost-no-complex) | boost-no-complex |
| explained | T4-digamma-003 | T4 | Digamma | boost | scipy | asymmetric-refusal | refused-by boost (boost-no-complex) | boost-no-complex |
| explained | T4-digamma-003 | T4 | Digamma | boost | wolfram | asymmetric-refusal | refused-by boost (boost-no-complex) | boost-no-complex |
| explained | T4-digamma-004 | T4 | Digamma | arb | boost | asymmetric-refusal | refused-by boost (boost-no-complex) | boost-no-complex |
| explained | T4-digamma-004 | T4 | Digamma | boost | mpmath | asymmetric-refusal | refused-by boost (boost-no-complex) | boost-no-complex |
| explained | T4-digamma-004 | T4 | Digamma | boost | scipy | asymmetric-refusal | refused-by boost (boost-no-complex) | boost-no-complex |
| explained | T4-digamma-004 | T4 | Digamma | boost | wolfram | asymmetric-refusal | refused-by boost (boost-no-complex) | boost-no-complex |
| explained | T4-gamma-001 | T4 | Gamma | arb | boost | asymmetric-refusal | refused-by boost (boost-no-complex) | boost-no-complex |
| explained | T4-gamma-001 | T4 | Gamma | boost | mpmath | asymmetric-refusal | refused-by boost (boost-no-complex) | boost-no-complex |
| explained | T4-gamma-001 | T4 | Gamma | boost | scipy | asymmetric-refusal | refused-by boost (boost-no-complex) | boost-no-complex |
| explained | T4-gamma-001 | T4 | Gamma | boost | wolfram | asymmetric-refusal | refused-by boost (boost-no-complex) | boost-no-complex |
| explained | T4-gamma-002 | T4 | Gamma | arb | boost | asymmetric-refusal | refused-by boost (boost-no-complex) | boost-no-complex |
| explained | T4-gamma-002 | T4 | Gamma | boost | mpmath | asymmetric-refusal | refused-by boost (boost-no-complex) | boost-no-complex |
| explained | T4-gamma-002 | T4 | Gamma | boost | scipy | asymmetric-refusal | refused-by boost (boost-no-complex) | boost-no-complex |
| explained | T4-gamma-002 | T4 | Gamma | boost | wolfram | asymmetric-refusal | refused-by boost (boost-no-complex) | boost-no-complex |
| explained | T4-gamma-003 | T4 | Gamma | arb | boost | asymmetric-refusal | refused-by boost (boost-no-complex) | boost-no-complex |
| explained | T4-gamma-003 | T4 | Gamma | boost | mpmath | asymmetric-refusal | refused-by boost (boost-no-complex) | boost-no-complex |
| explained | T4-gamma-003 | T4 | Gamma | boost | scipy | asymmetric-refusal | refused-by boost (boost-no-complex) | boost-no-complex |
| explained | T4-gamma-003 | T4 | Gamma | boost | wolfram | asymmetric-refusal | refused-by boost (boost-no-complex) | boost-no-complex |
| explained | T4-gamma-004 | T4 | Gamma | arb | boost | asymmetric-refusal | refused-by boost (boost-no-complex) | boost-no-complex |
| explained | T4-gamma-004 | T4 | Gamma | boost | mpmath | asymmetric-refusal | refused-by boost (boost-no-complex) | boost-no-complex |
| explained | T4-gamma-004 | T4 | Gamma | boost | scipy | asymmetric-refusal | refused-by boost (boost-no-complex) | boost-no-complex |
| explained | T4-gamma-004 | T4 | Gamma | boost | wolfram | asymmetric-refusal | refused-by boost (boost-no-complex) | boost-no-complex |
| explained | T4-incompletegammalower-001 | T4 | IncompleteGammaLower | arb | boost | asymmetric-refusal | refused-by boost (boost-no-complex) | boost-no-complex |
| explained | T4-incompletegammalower-001 | T4 | IncompleteGammaLower | arb | scipy | asymmetric-refusal | refused-by scipy (TypeError-complex-gammainc) | L14-scipy-complex-polygamma-known-refusal |
| explained | T4-incompletegammalower-001 | T4 | IncompleteGammaLower | boost | mpmath | asymmetric-refusal | refused-by boost (boost-no-complex) | boost-no-complex |
| explained | T4-incompletegammalower-001 | T4 | IncompleteGammaLower | boost | wolfram | asymmetric-refusal | refused-by boost (boost-no-complex) | boost-no-complex |
| explained | T4-incompletegammalower-001 | T4 | IncompleteGammaLower | mpmath | scipy | asymmetric-refusal | refused-by scipy (TypeError-complex-gammainc) | L14-scipy-complex-polygamma-known-refusal |
| explained | T4-incompletegammalower-001 | T4 | IncompleteGammaLower | scipy | wolfram | asymmetric-refusal | refused-by scipy (TypeError-complex-gammainc) | L14-scipy-complex-polygamma-known-refusal |
| explained | T4-incompletegammalower-002 | T4 | IncompleteGammaLower | arb | boost | asymmetric-refusal | refused-by boost (boost-no-complex) | boost-no-complex |
| explained | T4-incompletegammalower-002 | T4 | IncompleteGammaLower | arb | scipy | asymmetric-refusal | refused-by scipy (TypeError-complex-gammainc) | L14-scipy-complex-polygamma-known-refusal |
| explained | T4-incompletegammalower-002 | T4 | IncompleteGammaLower | boost | mpmath | asymmetric-refusal | refused-by boost (boost-no-complex) | boost-no-complex |
| explained | T4-incompletegammalower-002 | T4 | IncompleteGammaLower | boost | wolfram | asymmetric-refusal | refused-by boost (boost-no-complex) | boost-no-complex |
| explained | T4-incompletegammalower-002 | T4 | IncompleteGammaLower | mpmath | scipy | asymmetric-refusal | refused-by scipy (TypeError-complex-gammainc) | L14-scipy-complex-polygamma-known-refusal |
| explained | T4-incompletegammalower-002 | T4 | IncompleteGammaLower | scipy | wolfram | asymmetric-refusal | refused-by scipy (TypeError-complex-gammainc) | L14-scipy-complex-polygamma-known-refusal |
| explained | T4-incompletegammalower-003 | T4 | IncompleteGammaLower | arb | boost | asymmetric-refusal | refused-by boost (boost-no-complex) | boost-no-complex |
| explained | T4-incompletegammalower-003 | T4 | IncompleteGammaLower | arb | scipy | asymmetric-refusal | refused-by scipy (TypeError-complex-gammainc) | L14-scipy-complex-polygamma-known-refusal |
| explained | T4-incompletegammalower-003 | T4 | IncompleteGammaLower | boost | mpmath | asymmetric-refusal | refused-by boost (boost-no-complex) | boost-no-complex |
| explained | T4-incompletegammalower-003 | T4 | IncompleteGammaLower | boost | wolfram | asymmetric-refusal | refused-by boost (boost-no-complex) | boost-no-complex |
| explained | T4-incompletegammalower-003 | T4 | IncompleteGammaLower | mpmath | scipy | asymmetric-refusal | refused-by scipy (TypeError-complex-gammainc) | L14-scipy-complex-polygamma-known-refusal |
| explained | T4-incompletegammalower-003 | T4 | IncompleteGammaLower | scipy | wolfram | asymmetric-refusal | refused-by scipy (TypeError-complex-gammainc) | L14-scipy-complex-polygamma-known-refusal |
| explained | T4-incompletegammalower-004 | T4 | IncompleteGammaLower | arb | boost | asymmetric-refusal | refused-by boost (boost-no-complex) | boost-no-complex |
| explained | T4-incompletegammalower-004 | T4 | IncompleteGammaLower | arb | scipy | asymmetric-refusal | refused-by scipy (TypeError-complex-gammainc) | L14-scipy-complex-polygamma-known-refusal |
| explained | T4-incompletegammalower-004 | T4 | IncompleteGammaLower | boost | mpmath | asymmetric-refusal | refused-by boost (boost-no-complex) | boost-no-complex |
| explained | T4-incompletegammalower-004 | T4 | IncompleteGammaLower | boost | wolfram | asymmetric-refusal | refused-by boost (boost-no-complex) | boost-no-complex |
| explained | T4-incompletegammalower-004 | T4 | IncompleteGammaLower | mpmath | scipy | asymmetric-refusal | refused-by scipy (TypeError-complex-gammainc) | L14-scipy-complex-polygamma-known-refusal |
| explained | T4-incompletegammalower-004 | T4 | IncompleteGammaLower | scipy | wolfram | asymmetric-refusal | refused-by scipy (TypeError-complex-gammainc) | L14-scipy-complex-polygamma-known-refusal |
| explained | T4-incompletegammalower-005 | T4 | IncompleteGammaLower | arb | boost | asymmetric-refusal | refused-by boost (boost-no-complex) | boost-no-complex |
| explained | T4-incompletegammalower-005 | T4 | IncompleteGammaLower | arb | scipy | asymmetric-refusal | refused-by scipy (TypeError-complex-gammainc) | L14-scipy-complex-polygamma-known-refusal |
| explained | T4-incompletegammalower-005 | T4 | IncompleteGammaLower | boost | mpmath | asymmetric-refusal | refused-by boost (boost-no-complex) | boost-no-complex |
| explained | T4-incompletegammalower-005 | T4 | IncompleteGammaLower | boost | wolfram | asymmetric-refusal | refused-by boost (boost-no-complex) | boost-no-complex |
| explained | T4-incompletegammalower-005 | T4 | IncompleteGammaLower | mpmath | scipy | asymmetric-refusal | refused-by scipy (TypeError-complex-gammainc) | L14-scipy-complex-polygamma-known-refusal |
| explained | T4-incompletegammalower-005 | T4 | IncompleteGammaLower | scipy | wolfram | asymmetric-refusal | refused-by scipy (TypeError-complex-gammainc) | L14-scipy-complex-polygamma-known-refusal |
| explained | T4-incompletegammalower-006 | T4 | IncompleteGammaLower | arb | boost | asymmetric-refusal | refused-by boost (boost-no-complex) | boost-no-complex |
| explained | T4-incompletegammalower-006 | T4 | IncompleteGammaLower | arb | scipy | asymmetric-refusal | refused-by scipy (TypeError-complex-gammainc) | L14-scipy-complex-polygamma-known-refusal |
| explained | T4-incompletegammalower-006 | T4 | IncompleteGammaLower | boost | mpmath | asymmetric-refusal | refused-by boost (boost-no-complex) | boost-no-complex |
| explained | T4-incompletegammalower-006 | T4 | IncompleteGammaLower | boost | wolfram | asymmetric-refusal | refused-by boost (boost-no-complex) | boost-no-complex |
| explained | T4-incompletegammalower-006 | T4 | IncompleteGammaLower | mpmath | scipy | asymmetric-refusal | refused-by scipy (TypeError-complex-gammainc) | L14-scipy-complex-polygamma-known-refusal |
| explained | T4-incompletegammalower-006 | T4 | IncompleteGammaLower | scipy | wolfram | asymmetric-refusal | refused-by scipy (TypeError-complex-gammainc) | L14-scipy-complex-polygamma-known-refusal |
| explained | T4-incompletegammalower-007 | T4 | IncompleteGammaLower | arb | boost | asymmetric-refusal | refused-by boost (boost-no-complex) | boost-no-complex |
| explained | T4-incompletegammalower-007 | T4 | IncompleteGammaLower | arb | scipy | asymmetric-refusal | refused-by scipy (TypeError-complex-gammainc) | L14-scipy-complex-polygamma-known-refusal |
| explained | T4-incompletegammalower-007 | T4 | IncompleteGammaLower | boost | mpmath | asymmetric-refusal | refused-by boost (boost-no-complex) | boost-no-complex |
| explained | T4-incompletegammalower-007 | T4 | IncompleteGammaLower | boost | wolfram | asymmetric-refusal | refused-by boost (boost-no-complex) | boost-no-complex |
| explained | T4-incompletegammalower-007 | T4 | IncompleteGammaLower | mpmath | scipy | asymmetric-refusal | refused-by scipy (TypeError-complex-gammainc) | L14-scipy-complex-polygamma-known-refusal |
| explained | T4-incompletegammalower-007 | T4 | IncompleteGammaLower | scipy | wolfram | asymmetric-refusal | refused-by scipy (TypeError-complex-gammainc) | L14-scipy-complex-polygamma-known-refusal |
| explained | T4-incompletegammalower-008 | T4 | IncompleteGammaLower | arb | boost | asymmetric-refusal | refused-by boost (boost-no-complex) | boost-no-complex |
| explained | T4-incompletegammalower-008 | T4 | IncompleteGammaLower | arb | scipy | asymmetric-refusal | refused-by scipy (TypeError-complex-gammainc) | L14-scipy-complex-polygamma-known-refusal |
| explained | T4-incompletegammalower-008 | T4 | IncompleteGammaLower | boost | mpmath | asymmetric-refusal | refused-by boost (boost-no-complex) | boost-no-complex |
| explained | T4-incompletegammalower-008 | T4 | IncompleteGammaLower | boost | wolfram | asymmetric-refusal | refused-by boost (boost-no-complex) | boost-no-complex |
| explained | T4-incompletegammalower-008 | T4 | IncompleteGammaLower | mpmath | scipy | asymmetric-refusal | refused-by scipy (TypeError-complex-gammainc) | L14-scipy-complex-polygamma-known-refusal |
| explained | T4-incompletegammalower-008 | T4 | IncompleteGammaLower | scipy | wolfram | asymmetric-refusal | refused-by scipy (TypeError-complex-gammainc) | L14-scipy-complex-polygamma-known-refusal |
| explained | T4-incompletegammaupper-001 | T4 | IncompleteGammaUpper | arb | boost | asymmetric-refusal | refused-by boost (boost-no-complex) | boost-no-complex |
| explained | T4-incompletegammaupper-001 | T4 | IncompleteGammaUpper | arb | scipy | asymmetric-refusal | refused-by scipy (TypeError-complex-gammainc) | L14-scipy-complex-polygamma-known-refusal |
| explained | T4-incompletegammaupper-001 | T4 | IncompleteGammaUpper | boost | mpmath | asymmetric-refusal | refused-by boost (boost-no-complex) | boost-no-complex |
| explained | T4-incompletegammaupper-001 | T4 | IncompleteGammaUpper | boost | wolfram | asymmetric-refusal | refused-by boost (boost-no-complex) | boost-no-complex |
| explained | T4-incompletegammaupper-001 | T4 | IncompleteGammaUpper | mpmath | scipy | asymmetric-refusal | refused-by scipy (TypeError-complex-gammainc) | L14-scipy-complex-polygamma-known-refusal |
| explained | T4-incompletegammaupper-001 | T4 | IncompleteGammaUpper | scipy | wolfram | asymmetric-refusal | refused-by scipy (TypeError-complex-gammainc) | L14-scipy-complex-polygamma-known-refusal |
| explained | T4-incompletegammaupper-002 | T4 | IncompleteGammaUpper | arb | boost | asymmetric-refusal | refused-by boost (boost-no-complex) | boost-no-complex |
| explained | T4-incompletegammaupper-002 | T4 | IncompleteGammaUpper | arb | scipy | asymmetric-refusal | refused-by scipy (TypeError-complex-gammainc) | L14-scipy-complex-polygamma-known-refusal |
| explained | T4-incompletegammaupper-002 | T4 | IncompleteGammaUpper | boost | mpmath | asymmetric-refusal | refused-by boost (boost-no-complex) | boost-no-complex |
| explained | T4-incompletegammaupper-002 | T4 | IncompleteGammaUpper | boost | wolfram | asymmetric-refusal | refused-by boost (boost-no-complex) | boost-no-complex |
| explained | T4-incompletegammaupper-002 | T4 | IncompleteGammaUpper | mpmath | scipy | asymmetric-refusal | refused-by scipy (TypeError-complex-gammainc) | L14-scipy-complex-polygamma-known-refusal |
| … | … | … | … | … | … | … | … | (197 more — see agreement-data.json) |
