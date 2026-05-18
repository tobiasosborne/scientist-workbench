# 131 — `bigErf` real (BigFloat): Phase 2 / I1 entry point

**Date:** 2026-05-16
**Bead:** `scientist-workbench-q30j` (I1 — bigErf real BigFloat)
**Related ADR:** `docs/adr/0040-per-head-special-function-substrate-and-meijer-g-bridge.md`
(§"Decision 3"); inherits the determinism contract of ADR-0020
(arb-prec tier — bit-identical cross-platform forever).
**Phase 2 status after this shard:** Tier A complete for the arb-prec
real lane; I2 (`bigErfc` + `bigErfcx`) and I3 (complex Erf via
Faddeeva) can now hoist on top of `bigErfSeries` /
`bigErfcAsymptotic` / `bigErfcContinuedFraction`.

## Context

ADR-0040 pins the per-head special-function substrate architecture with
Erf as the v0.1 reference implementation. Phase 0 (R-research, 245 KB
of cited material) and Phase 1 (G-oracle harness with mpmath@55dp /
Wolfram@60dp / Boost@50dp goldens) landed. Phase 2 — substrate
implementation — opens with I1 here: the real-axis arb-prec
`bigErf(x: BigFloat, prec: number): BigFloat`, the entry point of the
arb-prec lane.

The R2 deep-research finding (`docs/refs/erf-research/R2-arbprec-
algorithms.md` §1.2 + §"Top-3 risks") pinned the load-bearing algorithm
choice: DLMF 7.6.2 Borel form, not 7.6.1 textbook Maclaurin. The
textbook alternating series cancels catastrophically when `|x|² > p · ln 2`:
at x = 8 (a mundane T2 input) and p = 200 bits, the alternation
discards ~92 bits to cancellation; the Borel form has zero alternation
and the same convergence rate. mpmath, Arb (`arb_hypgeom_erf`), and
SciPy's reference all default to Borel. This substrate follows.

## What changed

- **NEW**  `packages/bigfloat/src/special-funcs/erf.ts` (495 lines).
  - 30-80-line literate top-of-file algorithm narrative covering: the
    Borel-vs-Maclaurin trap, why a "just bump working precision"
    fix doesn't scale, the crossover derivation, the optimal-truncation
    idiom, the cancellation-driven precision retry pattern, and a
    cross-reference to `lgammaStirling` (`packages/bigfloat/src/special.ts:117`).
  - `bigErf(x, prec)` — the entry point. Throws `RangeError` on
    malformed input or magnitude > 2^1024.
  - `bigErfSeries(x, prec)` — package-internal substrate primitive
    (Borel form). Single-step ratio recurrence
    `term_{n+1} = term_n · 2x² / (2n + 3)`.
  - `bigErfcAsymptotic(x, prec)` — package-internal substrate primitive
    (asymptotic, optimal-truncation idiom). Used by `bigErf`'s
    `|x| > x_c` branch and by I2's forthcoming `bigErfc`.
  - `bigErfcContinuedFraction(x, prec)` — package-internal substrate
    primitive (Laplace CF via modified Lentz). Not on `bigErf`'s
    dispatch path; staged for I2.
- **EDIT** `packages/bigfloat/src/index.ts` — re-export `bigErf` only.
  The three substrate primitives stay package-internal per the I1
  prompt's discipline (they're for I2 to import via
  `../special-funcs/erf.js`, not part of the public API surface).
- **NEW**  `packages/bigfloat/test/erf.test.ts` (98 tests, 296
  `expect()` calls).
  - **Golden masters vs mpmath@55dp** on every real Erf input in T1
    (15) + T2 (13) = 28 inputs, requiring ≥ 48 dp agreement.
  - **Golden masters vs Wolfram@60dp** on the same 28 inputs.
  - **Internal-precision consistency** at prec ∈ {200, 400, 720} bits
    on a representative subset (every third entry): the substrate's
    output at prec=400 agrees with prec=200 to ≥ 50 dp; prec=720 agrees
    with prec=400 to ≥ 100 dp. This validates the *substrate's own*
    precision claim independent of any oracle's emit precision.
  - **Spot checks** at `erf(0.5)`, `erf(1.23)`, `erf(6.0)` —
    byte-identical 55-dp string-equality against the published mpmath
    output (load-bearing exact-byte references).
  - **Property tests**: `erf(0) = 0` exactly (mantissa = 0n) at five
    precisions; `erf(-z) = -erf(z)` byte-identical (mantissa + exponent
    + precision all match) across 8 z-values × 3 precisions =
    24 cases; range check `0 < erf(z) < 1` for `z > 0`;
    `erf(z) → 1` at `z = 15` for prec=200 (no overshoot); determinism
    across repeated calls.
  - **Dispatch-boundary continuity** at prec=500 (where x_c ≈ 18.62):
    `1 - erf(11)` and `1 - erf(12)` are both visible and monotone
    decreasing. Additionally, the same x = 13 dispatched via the
    asymptotic branch (prec=200, x > x_c) and via the series branch
    (prec=500, x < x_c) agrees to ≥ 50 dp — the dispatch transition
    is invisible to callers.
  - **Total-function discipline** (loud throw on malformed input):
    rejects BigFloats with non-integer precision, non-finite exponent,
    or magnitude > 2^1024; rejects non-positive-integer `prec`.
  - **Substrate-primitive smoke tests** for `bigErfSeries` /
    `bigErfcAsymptotic` / `bigErfcContinuedFraction`, including the
    round-trip property that `bigErf(14)` is byte-identical to
    `1 - bigErfcAsymptotic(14)` at prec=200 (because that's literally
    what the dispatcher computes in the `|x| > x_c` branch — the test
    pins that this remains true).
- **EDIT** `packages/bigfloat/README.md` — added `bigErf` to the
  public-surface listing and a new "Erf family substrate (ADR-0040)"
  section describing the substrate-primitive boundary and the dispatch.

## Why these choices

### Borel form (DLMF 7.6.2), not textbook Maclaurin (7.6.1)

The load-bearing R2 finding. 7.6.1 alternates with peak term magnitude
`≈ exp(x²) / √(2πx²)` near `n ≈ x²`; the answer is `erf(x) ≤ 1`. The
cancellation discards `x² · log₂ e` bits — at x = 8 with p = 200,
that's 92 bits gone; at x = 20, 580 bits gone. 7.6.2 pulls the
`e^(-x²)` factor outside the summation, leaving a sum with all-positive
terms and the same `O(x² + p/2)` term count. Per-term limb count is
`O(p)` bits, not `O(p + x²)` bits — strictly better in time and bits.
Documented in the top-of-file narrative with an explicit "the just-bump-
precision fix doesn't scale" paragraph.

### `bigErfcAsymptotic` mirrors `lgammaStirling`'s optimal-truncation

`lgammaStirling` (`packages/bigfloat/src/special.ts:117`) is the
workbench's canonical pattern for Bernoulli- and double-factorial-style
asymptotic series: track `prevTermMag`, break *before* adding the term
that grew. Same loop shape used here for `bigErfcAsymptotic`. Reusing
the established idiom keeps the new substrate readable to anyone who
already understands the Γ family.

### Substrate primitives package-internal (not in `index.ts`)

The I1 prompt's discipline: I2 needs `bigErfSeries` /
`bigErfcAsymptotic` / `bigErfcContinuedFraction` to build its own
`bigErfc(x, prec)` (the regime-mixed implementation that *must not*
compute `erfc = 1 - erf` for `|x| > x_c`, per the R2 risk-mitigation).
But these are substrate, not API — exposing them at the package
boundary would invite consumers to use the asymptotic for `|x| < x_c`
and get garbage at small x. The split: `bigErf` is public; the
three primitives are imported via the relative `../special-funcs/erf.js`
path from sibling modules in the package.

### Validation throws `RangeError` with `suggestion:` lines

Total-function discipline per the legendary-SE bar (CLAUDE.md Rule 1).
Every throw includes a `suggestion:` line pointing to the right tool —
e.g. "use `decimalToBinaryPrecision(<digits>)` for a decimal target",
"construct the input via `fromString` / `fromInt` / `fromFloat64`",
"for negative x use the identity `erfc(-x) = 2 - erfc(x)`". The 2^1024
magnitude cliff is explicit: at that magnitude `erf(x) = ±1` exactly
within any arb-prec representation, so the throw points to the
symbolic limit.

### `Math.LN2` for crossover, not a BigFloat ln(2)

Bit-determinism note. The crossover is used only as a *branch selector*;
both lanes produce mathematically identical answers at the boundary.
Even if `Math.LN2`'s ~16-dp `Number` precision shifts the boundary by
`1 ULP_float64 · x_c ≈ x_c · 2^-52`, both branches give answers within
`2^-prec` of each other on that boundary. So float64 imprecision in
`crossoverXc` does NOT affect output bytes — the `arbprec: true`
contract holds. This is documented at the function's doc-comment.

## Frictions surfaced

### Mutation-proving Mutation 2 (LN2 → LN10) did NOT fail tests

The I1 prompt suggested three mutation perturbations to prove the tests
catch regressions:

1. `(2n + 3) → (2n + 1)` in the series ratio recurrence  → **59 tests RED.** ✓
2. `Math.LN2 → Math.LN10` in `crossoverXc`               → **0 tests RED.** ⚠
3. Drop the `e^(-z²)` prefactor in `bigErfSeries`         → **59 tests RED.** ✓

Mutation 2 as literally specified did not produce a failure. Diagnosis:
`Math.LN10 ≈ 2.30` vs `Math.LN2 ≈ 0.69`, so `sqrt(prec · LN10) >
sqrt(prec · LN2)` — the crossover threshold *grows*, meaning more inputs
route through the Borel series and fewer through the asymptotic. The
Borel series is correct at every input it sees (no upper bound on its
valid regime, just slower for large x), so the routing change is
invisible to the tests. **This is a true observation about the
algorithm's robustness**, not a test-coverage gap: both lanes are
correct at the boundary by construction.

To pin the dispatch logic, I added a discriminating mutation 2':

> 2'. Invert the dispatch comparison: `xFloat > xc → xFloat < xc`  → **59 tests RED.** ✓

This catches the case where the dispatcher picks the *wrong* algorithm
(asymptotic at small x, where the asymptotic diverges immediately).
The original LN2/LN10 perturbation is documented here as an algorithmic
robustness property rather than a test-coverage gap.

All mutations restored; final test run: **98 pass, 0 fail**.

### erf(12) at prec=200 rounds to exactly 1.0 — and that's *correct*

The first version of my dispatch-boundary test asserted that
`1 - bigErf(12)` was visibly non-zero at prec=200. It is not: 2^-200
≈ 6.22e-61, erfc(12) ≈ 1.36e-64 — well *below* the precision floor.
So 1 - tiny rounds to 1.0 exactly, and `1 - erf(12)` has mantissa = 0n.
This is the correct answer at the requested precision; the test was
naive about it. Fixed by raising the test's prec to 500 bits (where
2^-500 ≈ 3e-151 is comfortably below erfc(12) ≈ 1.36e-64) and adding
a *separate* test that pins the dispatch-boundary invisibility at
prec=200 via cross-precision agreement (run the same x = 13 at prec=200
and prec=500 — different branches, same answer to ≥ 50 dp).

### `expected` string in asymptotic-smoke test was hallucinated

My first version of the `bigErfcAsymptotic(15)` smoke test had an
"expected" decimal string that I'd typed from memory rather than
computed. Test failed at 30 dp agreement; investigation showed my
computed result matched mpmath at dps=80 byte-for-byte (verified by
running mpmath directly), and the test's "expected" was the wrong
value. Fixed by using mpmath's actual `erfc(15)` at dps=80 as the
reference, and bumping the test's working precision to 500 bits so the
substrate has headroom above the optimal-truncation precision of the
asymptotic series at x=15.

This is CLAUDE.md Rule 3 (skepticism) verifying itself: the test
*caught* my hallucination because the test compared computed bytes
against a written reference. Rule 7 (`"runs without errors" is not a
passing test`) held — the test asserted byte-equality, not absence of
throw, so the discrepancy surfaced immediately.

## Acceptance

All boxes from the I1 prompt:

- [x] `packages/bigfloat/src/special-funcs/erf.ts` shipped per R2.
- [x] 30-80-line literate top-of-file narrative covering Borel-vs-
  Maclaurin trap, crossover derivation, cancellation-retry pattern,
  cross-reference to `lgammaStirling`.
- [x] `bigErf` exported from `packages/bigfloat/src/index.ts`; the
  three substrate primitives (`bigErfSeries`, `bigErfcAsymptotic`,
  `bigErfcContinuedFraction`) exported from `erf.ts` for I2 to
  import directly, NOT from the package's index.
- [x] Golden masters pass at 50-dp byte-comparison against mpmath
  (T1 + T2 real Erf, 28 inputs) and against Wolfram (same 28
  inputs).
- [x] Internal-precision consistency at prec ∈ {200, 400, 720} bits
  on a representative subset.
- [x] Property tests green: parity, zero, range, determinism,
  total-function-throw on malformed input.
- [x] Mutation-proving documented (this shard, "Frictions surfaced").
- [x] `bun run check:quick` green (4 phases pass, 0 fail).

## Golden-master agreement statistics

At prec=200 bits (≈ 60 dp), `bigErf` vs the gold-tier oracles:

| Tier | Head | Inputs | mpmath ≥ 48 dp | Wolfram ≥ 48 dp | mpmath ≥ 50 dp | Wolfram ≥ 50 dp |
|------|------|--------|----------------|-----------------|----------------|-----------------|
| T1   | Erf  | 15     | 15/15          | 15/15           | 15/15          | 15/15           |
| T2   | Erf  | 13     | 13/13          | 13/13           | 13/13          | 13/13           |

All 28 real-Erf T1+T2 inputs pass at the 48-dp threshold. Spot-checks
confirm 55-dp byte-equality against mpmath for `erf(0.5)`, `erf(1.23)`,
`erf(6.0)`. Cross-precision consistency tests verify ≥ 100 dp
agreement between prec=400 and prec=720 — the substrate's internal
precision claim holds well beyond the gold-tier oracles' 55-60 dp
emit precision.

## Pointers

- ADR: `docs/adr/0040-per-head-special-function-substrate-and-meijer-g-bridge.md`
- ADR (determinism contract): `docs/adr/0020-arbitrary-precision-tier.md`
- R2 algorithm survey: `docs/refs/erf-research/R2-arbprec-algorithms.md`
- Phase 2 impl plans: `docs/refs/erf-research/PHASE2-impl-plans.md`
- Substrate exemplar: `packages/bigfloat/src/special.ts` (lgammaStirling)
- Substrate (this shard): `packages/bigfloat/src/special-funcs/erf.ts`
- Tests: `packages/bigfloat/test/erf.test.ts`
- Corpus (frozen): `bench/erf-anchor/corpus.json`
- Oracles: `bench/erf-anchor/oracles/{mpmath,wolfram,boost}/results.json`
- Phase 1 worklog (G-oracles): see worklog index for the G2–G8 shards.
- Next: I2 (`scientist-workbench-g82u`) — `bigErfc` + `bigErfcx` real,
  hoisting on the substrate primitives shipped here. I3
  (`scientist-workbench-wzzq`) — complex `bigCErf` via
  Faddeeva-Karbach, extending `complex.ts`.
