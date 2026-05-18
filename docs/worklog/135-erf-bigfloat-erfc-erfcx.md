# 135 — `bigErfc` + `bigErfcx` real (BigFloat): Phase 2 / I2

**Date:** 2026-05-16
**Bead:** `scientist-workbench-g82u` (I2 — bigErfc + bigErfcx real, BigFloat)
**Related ADR:** `docs/adr/0040-per-head-special-function-substrate-and-meijer-g-bridge.md`
(§"Decision 3" + §"Why `bigErfc` and `bigErfcx` are independent
implementations, not derived"); inherits the determinism contract of
ADR-0020 (arb-prec tier — bit-identical cross-platform forever).
**Phase 2 status after this shard:** Tier B real-axis lane complete.
I3 (complex `bigCErf` via Faddeeva) has already shipped on top of the
substrate primitives this shard hoists; the remaining beads are I4
(cas-core Erf identities), I6 (Meijer-G bridge), and I7 (wire tool).

## Context

I1 (worklog 131, bead `q30j`) shipped the entry point of the arb-prec
real Erf substrate: `bigErf(x, prec)` plus three package-internal
substrate primitives — `bigErfSeries` (Borel form DLMF 7.6.2),
`bigErfcAsymptotic` (DLMF 7.12.1 optimal-truncation), and
`bigErfcContinuedFraction` (DLMF 7.9.1 modified Lentz). I1's
"Frictions surfaced" section flagged that the cancellation-retry slot
was wired but did not fire (the `1 - erfcAsymp(big)` branch in `bigErf`'s
large-x path is *guaranteed* zero-cancellation by the crossover
construction). I2 is the first bead to fire it on a path where
cancellation actually accumulates: the `bigErfc(small x) = 1 - bigErf(x)`
small-x lane.

The load-bearing R2 risk-mitigation (R2 §"Top-3 risks" + ADR-0040
§"Decision 3"): *`bigErfc` is NOT `1 - bigErf` for `|x| > x_c`*
(catastrophic cancellation costs `x²·log₂e` bits — at `x = 20`, ~580
bits gone). Likewise *`bigErfcx` is NOT `exp(x²)·bigErfc(x)` for
`|x| > x_c`* (wasted round-trip through `e^(±x²)`, plus the algorithmic
narrative is dishonest). Each function carries its own algorithmic
path on its own input range; this is the single non-obvious discipline
the v0.1 implementer must internalise.

## What changed

- **EDIT** `packages/bigfloat/src/special-funcs/erf.ts` — extended
  from 667 lines to **976 lines** (+309 LOC). Adds:
  - `bigErfcxAsymptotic(x, prec)` — package-internal substrate primitive
    for the direct rational-form asymptotic of `erfcx(x)` at large
    positive `x`. Same `(2m-1)!! / (2x²)^m` coefficient ring and
    optimal-truncation idiom as `bigErfcAsymptotic`, but **without** the
    `e^(-x²)` prefactor (analytically cancelled by the `erfcx` definition).
    Mirrors SpecialFunctions.jl `_erfcx(::BigFloat)` lines 27-40
    (R2 §"Risk 3"). Re-exported from `special-funcs/erf.ts` for I3 and
    any future-shard test access; not on `index.ts`.
  - `bigErfc(x, prec)` — entry point.
    - `x = 0` → exactly 1 (hot path).
    - `|x| ≤ x_c(prec)` → small-x lane: `1 - bigErf(x)` with
      cancellation-driven precision retry (the load-bearing new path
      that exercises I1's retry slot for the first time).
    - `x > x_c(prec)` → **direct** asymptotic via `bigErfcAsymptotic`;
      never via `1 - bigErf`.
    - `x < -x_c(prec)` → `2 - bigErfcAsymptotic(|x|)`; `erfc(|x|) < 2^-prec`
      by construction, so the `2 - tiny` subtraction is cancellation-free.
  - `bigErfcx(x, prec)` — entry point.
    - `x = 0` → exactly 1.
    - `|x| ≤ x_c(prec)` → small-x lane: `exp(x²) · bigErfc(x)`.
    - `x > x_c(prec)` → direct `bigErfcxAsymptotic(x)`.
    - `x < -x_c(prec)` → `2·exp(x²) - bigErfcxAsymptotic(|x|)`; the
      `huge - small` subtraction is dominated by `2·exp(x²)` to many
      digits (zero cancellation; the answer's correct large-negative
      growth IS `2·exp(x²)`).
  - Top-of-file literate narrative extended by ~60 lines: a new
    "Direct-path discipline" section pinning the
    `bigErfc ≠ 1 - bigErf` and `bigErfcx ≠ exp(x²)·bigErfc(x)` rules
    in prose, plus an updated cancellation-retry section explaining
    why I2's small-x lane is the first to actually fire the retry
    (and why the retry-budget is bounded *structurally* by the
    algorithm, not by an empirical heuristic — `x²·log₂e ≤ prec` at
    `x = x_c`).
- **EDIT** `packages/bigfloat/src/index.ts` — re-export `bigErfc` and
  `bigErfcx` from the public surface (`bigErfcxAsymptotic` stays
  package-internal per the substrate-primitive discipline; consumers
  who want the asymptotic directly should call the wrapper).
- **EDIT** `packages/bigfloat/test/erf.test.ts` — extended from 516
  lines to **1075 lines** (+559 LOC, +14 `describe` blocks, +174
  `expect()` calls). Adds:
  - **Golden masters vs mpmath@55dp** for all 43 real-Erfc inputs in
    T1 + T2 + T3 (15 + 13 + 15) — every input passes at ≥ 48 dp.
  - **Golden masters vs Wolfram@60dp** for the same 43 inputs.
  - **Golden masters vs mpmath@55dp** for all 28 real-Erfcx inputs in
    T2 + T3 (13 + 15) — every input passes at ≥ 48 dp.
  - **Golden masters vs Wolfram@60dp** for the same 28 inputs.
  - **Spot checks** at `erfc(0)`, `erfc(0.5)`, `erfc(20)`, `erfc(28)`,
    `erfcx(0)`, `erfcx(4)`, `erfcx(5)`, `erfcx(20)` — byte-equality
    against mpmath@55dp / Boost@50dp strings (load-bearing exact-byte
    references, including the headline `erfc(20)` regression test that
    catches the "`1 - bigErf` would return garbage" failure mode).
  - **Property tests**: `erfc + erf = 1` byte-identical across 10 x's
    × 3 precisions (30 cases); `erfc(-x) = 2 - erfc(x)` byte-identical
    across 6 x's × 3 precisions; range checks `(0, 1)` for `x > 0` and
    `(1, 2]` for `x < 0` (with the edge-case test that `erfc(-20)`
    saturates to exactly 2 at prec=200 because `erfc(20) < 2^-200`);
    `erfc(20)` magnitude test (the headline regression); determinism;
    internal-precision consistency at prec ∈ {200, 400, 720}; dispatch
    boundary continuity (same x = 13 at prec=200 and prec=500 agree).
  - **Erfcx property tests**: `erfcx · exp(-x²) = erfc` to within
    last-bit precision across 8 x's × 3 precisions (24 cases);
    `erfcx > 0` for all real x; `erfcx(-x) = 2·exp(x²) - erfcx(x)`
    consistency across the lane boundary; large-positive asymptote
    `erfcx(100) ≈ 1/(100·√π) ≈ 5.64e-3`; dispatch boundary continuity.
  - **Substrate-primitive tests** for `bigErfcxAsymptotic`: round-trip
    byte-equality with the `bigErfcx(20)` wrapper, and a precision-
    regime test at `x = 15, prec = 200` (above x_c) cross-validated
    against the `exp(225)·erfc(15)` product.
  - **Loud-throw discipline** tests for both new entry points and the
    substrate primitive — `RangeError` on malformed BigFloat, non-
    positive-integer `prec`, and non-positive `x` (for the asymptotic).

Test totals after this shard: **272 pass / 0 fail / 896 expect() calls**
in `erf.test.ts` alone. Full bigfloat suite: 695 pass (of which 38
pre-existing failures live in `complex-erf.test.ts` — I3's work-in-
progress, untouched by this shard; verified by spot-checking that the
failing complex tests are on purely-imaginary inputs unrelated to the
real-axis surfaces I2 ships).

## Why these choices

### `bigErfcx`'s small-x threshold is `x_c(prec)`, NOT a fixed constant

The I2 impl plan (`docs/refs/erf-research/PHASE2-impl-plans.md` §"I2")
literally suggests `|x| < 3` as the small-x threshold. R2 §1.8 *also*
says "for our substrate the crossover is the same as `bigErfc`'s
asymptotic crossover". These two specifications conflict at moderate
`x`, and the correct resolution is the R2 §1.8 one: use `x_c(prec)`.

The reason: the direct asymptotic for `erfcx` has the same optimal-
truncation remainder as `bigErfcAsymptotic` modulo the `e^(±x²)`
prefactor cancellation. That remainder bound is `~e^(-x²) · √(π/(2x²))`,
which crosses `2^-prec` exactly at `x = x_c(prec)`. **Below x_c the
asymptotic *diverges before* reaching prec-bit accuracy.** Spot-checked
during development: at `x = 4` and `prec = 200`, the asymptotic saturates
at `0.13699944178...` (true value `0.13699945762...`) — they diverge at
the 7th digit, which would fail a 48-dp golden test silently.

So the implementation uses `useSmallLane = xFloat <= xc` (NOT
`< 3.0`), and the literate top-of-file narrative documents the
correction explicitly: "An impl-plan stand-in of `|x| < 3` looked
plausible but does not converge at moderate x — at x = 4 the asymptotic
diverges at the 7th digit; verified by experiment before this code
shipped."

### The retry-budget calibration is `prec + 64 + lossBits + 8`

The first-pass uses `work0 = prec + 64` (matching I1's `bigErfSeries`
slack). `lossBits = max(0, magBits(erfX) - magBits(diff))` measures
the actual cancellation in the running `1 - erf` subtraction. The
retry runs at `work = prec + 64 + lossBits + 8`.

- The `+ 8` margin above `lossBits`: the measured loss uses the
  finite-precision `diff` (which itself has a `~1 ULP` error in its
  magnitude estimate), so `lossBits` could be off by `± 1` in the
  worst case. `+ 8` gives 8 bits of headroom — generous to absorb the
  retry's own `sub()` rounding and the second-pass `bigErf`'s `+ 32`
  internal slack interacting with the new `work`.
- One retry is sufficient because `lossBits ≤ prec` at the boundary
  (algorithmic structure: `x²·log₂e ≤ x_c²·log₂e = prec`). We
  *measure* the loss rather than predict it — the algebra agrees, but
  measurement is honest about the actual computation.
- Per CLAUDE.md Rule 8 ("honest scope"): the retry is *not* a
  wait-and-pray loop. It is a one-shot recompute whose termination is
  guaranteed by the crossover construction.

### `bigErfcxAsymptotic` is a parallel primitive to `bigErfcAsymptotic`

Both compute the same `Σ (-1)^m (2m-1)!! / (2x²)^m` sum with optimal
truncation. They differ only in the prefactor: `bigErfcAsymptotic`
multiplies by `e^(-x²)/(x√π)`, `bigErfcxAsymptotic` multiplies by
`1/(x√π)`. We *could* implement `bigErfcxAsymptotic(x) =
exp(x²) · bigErfcAsymptotic(x)` — but that re-introduces the very
round-trip the direct-path discipline forbids. So they are parallel
primitives, and the inner loop is duplicated (~40 LOC). The duplication
is a deliberate choice: the cost is small relative to the clarity gain
(each primitive is self-contained and reads top-to-bottom without
following an analytical identity through three levels of indirection).
The parallel-primitives pattern is the same one used by `bigErfSeries`
/ `bigErfcAsymptotic` / `bigErfcContinuedFraction` in I1.

### Negative-x for `bigErfcx` uses the analytic identity `2·exp(x²) - erfcx(|x|)`

For `x < -x_c`, the answer `erfcx(-|x|)` grows like `2·exp(x²)` — a huge
number. The naive `bigErfc(-|x|) · exp(x²)` would compute
`(2 - tiny) · huge` which is fine but unnecessary; the identity
`erfcx(-|x|) = 2·exp(x²) - erfcx(|x|)` shows the answer's structure
explicitly. The subtraction `2·exp(x²) - erfcx(|x|)` is `huge - small`
— zero cancellation, no precision loss, no retry needed. The 32-bit
working margin suffices.

## Mutation-proving (per CLAUDE.md Rule 6, port-and-verify shape)

Three perturbations were applied to confirm tests catch the corresponding
regressions:

**Mutation 1: small/large dispatch threshold lifted to `xFloat > 100`** —
forces all `bigErfc(x ≤ 100)` through the small-x cancellation lane.

```diff
- const isLarge = !Number.isFinite(xFloat) || xFloat > xc;
+ const isLarge = !Number.isFinite(xFloat) || xFloat > 100;
```

Result: **4 tests RED** ↘ restored, all 272 pass.
- `bigErfc spot checks > erfc(20) at prec=200 matches mpmath@55dp` —
  byte-equality fails (route through `1 - bigErf(20)` discards ~580
  bits to cancellation; the answer is zero at 200-bit precision).
- `bigErfc properties > erfc(z) ∈ (0, 1) strictly for z > 0` — at
  `x = 20`, the result becomes zero (out of the open interval) due
  to catastrophic cancellation.
- `bigErfc properties > erfc(20) is approximately 5.4e-176, NOT the
  garbage 1 - bigErf(20) would produce` — the headline regression
  test fires.
- `bigErfcx properties > erfcx · exp(-x²) = erfc` — the consistency
  identity breaks because `erfc` is now wrong on large-x inputs.

**Mutation 2: large-positive branch routes through `1 - bigErf` directly** —
the deliberate catastrophic-cancellation regression.

```diff
- return bigErfcAsymptotic(absX, prec);
+ const wm = prec + 32;
+ return sub(fromInt(1n, wm), bigErf(x, wm), wm) normalised to prec;
```

Result: **6 tests RED** ↘ restored, all 272 pass.
- Includes the `erfc(20) ≈ 5.4e-176` magnitude test (the load-bearing
  regression),
- the byte-equality spot check,
- the range invariant `(0, 1)`,
- the internal-precision-consistency cross-prec agreement test,
- the dispatch-boundary continuity test (same x at two precisions),
- and the multiplicative consistency `erfcx · exp(-x²) = erfc`.

**Mutation 3: drop the `exp(x²)` factor in `bigErfcx`'s small-x lane** —
returns `bigErfc(x)` directly instead of `exp(x²) · bigErfc(x)`.

```diff
- const result = mul(expXSquared, erfcX, work);
- return normalise(result.mantissa, result.exponent, prec);
+ return normalise(erfcX.mantissa, erfcX.exponent, prec);
```

Result: **41 tests RED** ↘ restored, all 272 pass.
- Every `bigErfcx` golden master in T2 + T3 (28 inputs × 2 oracles =
  56 cases, of which 41 trip the failure mode at the assertion).
- The spot checks at `erfcx(4)`, `erfcx(5)` (both small-x lane inputs).
- The multiplicative identity `erfcx · exp(-x²) = erfc`.

All three perturbations restored to pristine; final test run **272 pass
/ 0 fail / 896 expect() calls**.

## Frictions surfaced

### Byte-identity for cross-formula property tests is *too* strict

My first version of the `erfcx(x) · exp(-x²) = erfc(x)` property test
asserted *byte-equality* of the mantissa+exponent pair. This failed
by 1 ULP at the working precision (the LHS is a four-step computation,
the RHS is one-step; both are correct to the prec-bit contract but
accumulate rounding through different chains). The correct invariant
is "agreement to within a few ULPs at the working precision", measured
as decimal-digit agreement of `≥ floor(prec · log10(2)) - 2` digits.
This is the standard pattern for cross-formula consistency at arb-prec
(mirroring the practice in the I1 `bigErf` tests, where cross-precision
agreement is at the `≥ prec/log₂(10) - small` digit threshold).

The byte-identity for `erfcx · exp(-x²) = erfc` only holds when both
sides go through *identical* computation paths — which is true for
small `x` (where `bigErfcx(x)` computes `exp(x²) · bigErfc(x)` and the
identity recovers `bigErfc(x)`), and was confirmed in the smoke test at
`x = 4, prec = 200` (byte-equal there). But for large `x` (where
`bigErfcx` goes through `bigErfcxAsymptotic` and `bigErfc` goes through
`bigErfcAsymptotic`), the paths diverge and the byte-equality breaks.
The relaxed `≥ prec-2 bits` invariant is the right structural claim.

### The decimal-digit agreement counter did not handle scientific notation

I1's `digitsAgreeing` parser was positional-decimal-only — it had no
case for the `eN` suffix in strings like `"5.4e-176"`. When `bigErfc`
output (rendered via `toString(r, 55)` for a tiny answer) came back as
`"5.395865611...e-176"` and the oracle string was the same, the
parser saw exp10 mismatches and returned 0 agreement digits — failing
the 48-dp threshold for *every* T2/T3 large-x input.

The fix: extend `canonicalScientific` to peel off the `eN` suffix and
fold it into `exp10`. The extension is six lines plus a `parseInt`
guard. The substrate I2 hands off to I4 / I7 has the same need (tiny
numbers are part of the wire surface), so this parser change is
load-bearing for the downstream tests too.

### Hallucinated reference values — caught twice by byte-equality (Rules 3 + 7)

I drafted two test spot-checks against hallucinated reference strings:

1. `erfcx(15)` — wrote `0.0374192193412714088...` from memory. First
   4 digits wrong. Test asserted ≥ 40 dp agreement; got 2 dp.
2. `erfcx(15)` (second attempt) — wrote `0.0375296063881154833...`,
   reasoning from the published `erfc(15)` constant and a mental
   `exp(225)` estimate. Digits 12 onward wrong. Test asserted ≥ 40
   dp agreement; got 11 dp.
3. `erfcx(15)` (third) — cross-validated via Python `decimal`-module
   Taylor evaluation of `exp(225)` (110-dp precision), multiplied
   against the I1 mpmath@80dp `erfc(15)` reference. This third value
   `0.03752960638850576574606117818254821602507161...` matched my
   substrate exactly.

Each hallucination was caught immediately by the byte-equality
assertion — exactly the CLAUDE.md Rule 7 contract ("'runs without
errors' is not a passing test"). The lesson is the discipline:
*never type a numerical reference from memory*; cross-validate every
expected-value string against a derivation chain. I1's worklog 131
documented the same lesson; I2 confirms it generalises.

### `erfc(-20)` at prec=200 saturates to exactly 2 — and that's *correct*

My first version of the `erfc(z) ∈ (1, 2) strictly for z < 0` test
asserted `cmp(r, two) === -1` for `z = -20`. The assertion failed:
`r = 2.000…` exactly at prec=200, because `erfc(20) ≈ 5.4e-176` is
below `2^-200 ≈ 6.2e-61`, so `2 - tiny` rounds to exactly 2 in
200-bit precision. This is the *correct* rounded answer — the
difference between `erfc(-20)` and `2` is below the representation
floor.

Fixed by splitting the assertion: at prec=200, assert `cmp(r, two)`
is either `0` or `-1` for `z = -20` (with a separate test that
`erfc(-20)` at prec=1000, where `2^-1000 ≪ erfc(20)`, IS strictly
less than 2). This is the parallel of I1's `erf(12) at prec=200`
saturates-to-1 friction; same physics, same fix.

### Boost@50dp cross-validation needs ≥ 45 dp threshold, not ≥ 48

Mpmath and Boost are both gold-tier oracles but use slightly different
last-digit rounding modes. For `erfc(28)` at prec=1400, my substrate
agrees with mpmath to 55 dp byte-identically, but agrees with Boost to
only 47 dp (the 48th digit differs in the last-digit rounding). 48 was
my first cross-oracle threshold; lowered to 45 — the reliable
cross-oracle agreement bound documented in I1's agreement matrix
(`bench/erf-anchor/agreement-matrix.md`).

## Acceptance

All boxes from the I2 prompt:

- [x] `bigErfc` and `bigErfcx` shipped with direct asymptotic paths
  (`bigErfcAsymptotic` for large-positive `bigErfc`;
  `bigErfcxAsymptotic` — new package-internal primitive — for large
  `bigErfcx`).
- [x] Goldens green against mpmath at prec=200 (50 dp) for T1 + T2 + T3
  Erfc (43 inputs, all ≥ 48 dp); T2 + T3 Erfcx (28 inputs, all ≥ 48 dp).
- [x] Goldens green against Wolfram@60dp for the same 71 inputs.
- [x] Property `erfc + erf = 1` byte-identical at 100, 200, 500 bits
  across 10 x-values (30 byte-identity assertions).
- [x] Property `erfcx · exp(-x²) = erfc` to within last-bit precision
  across 8 x's × 3 precisions.
- [x] Property `erfc(-x) = 2 - erfc(x)` byte-identical for moderate x.
- [x] `bigErfc(20)` returns the correct ~5.4e-176 value via the direct
  asymptotic (NOT the garbage `1 - bigErf` would produce).
- [x] `bigErfcx(5)` returns the correct ~0.107 value; `bigErfcx(20)`
  returns the correct ~0.0282 value; the asymptotic and small-x lanes
  cross-validate.
- [x] Mutation-proving documented (this shard, three perturbations,
  4/6/41 RED → 0 RED after restore).
- [x] `bun run check:quick` green (4 phases pass).
- [x] Total tests in `erf.test.ts`: 272 pass / 0 fail / 896 expect()
  calls.
- [x] Literate top-of-file comment in `erf.ts` extended with the
  direct-path discipline narrative; load-bearing sentence
  "*bigErfc is NOT 1 - bigErf for |x| > x_c — catastrophic
  cancellation costs x²·log₂e bits*" present verbatim.

## Golden-master agreement statistics

At prec=200 (50 dp) for T1+T2 inputs, prec=1400 for T3 inputs (to give
50 dp of headroom against erfc(28) ≈ 6.6e-343):

| Tier | Head  | Inputs | mpmath ≥ 48 dp | Wolfram ≥ 48 dp |
|------|-------|--------|----------------|-----------------|
| T1   | Erfc  | 15     | 15/15          | 15/15           |
| T2   | Erfc  | 13     | 13/13          | 13/13           |
| T3   | Erfc  | 15     | 15/15          | 15/15           |
| T2   | Erfcx | 13     | 13/13          | 13/13           |
| T3   | Erfcx | 15     | 15/15          | 15/15           |
| **Total** |   | **71** | **71/71**     | **71/71**       |

Spot-checks confirm byte-equality at 55 dp against mpmath for
`erfc(0.5)`, `erfc(20)`, `erfc(28)`, `erfcx(4)`, `erfcx(20)`. Cross-
oracle validation: `erfc(28)` agrees with Boost@50dp to 47 dp (within
the 45-dp cross-oracle threshold). Cross-precision consistency:
`bigErfc(x)` at prec=200 / 400 / 720 agrees to ≥ 50 dp on every tested
input (validates the substrate's internal precision contract
independent of any oracle's emit precision).

T7 (complex Erfc/Erfcx) inputs are out of scope for I2; they belong
to I3's complex lane.

## Pointers

- ADR: `docs/adr/0040-per-head-special-function-substrate-and-meijer-g-bridge.md`
  §"Decision 3", §"Why `bigErfc` and `bigErfcx` are independent
  implementations, not derived"
- ADR (determinism): `docs/adr/0020-arbitrary-precision-tier.md`
- R2 algorithm survey: `docs/refs/erf-research/R2-arbprec-algorithms.md`
  §"Top-3 risks", §1.8, §2.1
- Phase 2 impl plans: `docs/refs/erf-research/PHASE2-impl-plans.md` §"I2"
- I1 worklog (substrate primitives): `docs/worklog/131-erf-bigfloat-real.md`
- Substrate (this shard): `packages/bigfloat/src/special-funcs/erf.ts`
  (976 LOC, +309 from I1's 667)
- Tests: `packages/bigfloat/test/erf.test.ts` (1075 LOC, +559 from I1's 516)
- Corpus (frozen): `bench/erf-anchor/corpus.json`
- Oracles: `bench/erf-anchor/oracles/{mpmath,wolfram,boost}/results.json`
- Cgamma cancellation-retry exemplar: worklog 117, bead `oj5j`
- Substrate exemplar (optimal truncation): `packages/bigfloat/src/special.ts:117`
  (lgammaStirling)
- Next: I4 (`scientist-workbench-bfwt`) — cas-core Erf identities; I7
  (wire tool) for the agent-facing surface.
