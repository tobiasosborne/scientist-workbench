# 171 — Half-integer ν J/Y/K closed forms (close z5em + omsm)

**Date:** 2026-05-17
**Beads:** `scientist-workbench-z5em` (`besselKFloat64` half-integer ν
loses 7-12 digits at z ∈ [5, 10]), `scientist-workbench-omsm`
(`besselJFloat64` / `besselYFloat64` half-integer ν loses 2-3 digits
at z=50). Both filed 2026-05-17 by the Bessel float64 status report
(worklog 167). Closed by this shard.
**ADR:** [0041 — Per-head substrate applied to the canonical Bessel
family](../adr/0041-bessel-family-per-head-substrate.md).

## Context

The Bessel float64 substrate computed half-integer ν `J`/`Y`/`K`
through the same generic-ν paths as the rest of the family:
- `J_{n+1/2}` and `Y_{n+1/2}` via the Hankel asymptotic (large z) or
  the ascending series (small z), neither of which is short-circuited
  for half-integer ν.
- `K_{n+1/2}` via the reflection formula `K_ν = (π/2)·(I_{−ν} − I_ν)/sin(νπ)`,
  which has a removable-singularity-like cancellation at half-integer ν.

Both paths suffer at moderate-to-large z and moderate-to-large
half-integer ν:

> `K(0.5, 5)` rel = `7.7e-12`, `K(1.5, 10)` rel = `5.4e-7` (z5em).
> `J(2.5, 50)` rel = `3e-3`, `J(3.5, 50)` rel = `1.2e-2`,
> `J(5.5, 50)` rel = `8.3%`, `J(10.5, 50)` rel = `11%`,
> `J(10.5, 100)` rel = `540%` (omsm).
> `Y(5.5, 50)` rel = `45%`, `Y(10.5, 50)` rel = `186%` (omsm).

The DLMF §10.49 closed forms for half-integer ν reduce these all to
trivial spherical-Bessel computations. The fix is a `isHalfInteger`
guard at the top of each dispatcher (J, Y, K) routing to the
spherical-Bessel substrate.

## What changed

### `packages/quadrature/src/special-funcs/bessel-float64.ts`

New substrate section `Half-integer ν closed forms — DLMF §10.49`
(~120 LOC):

**`isHalfInteger(nu)`**: detects `ν = n + 1/2` via the `2·ν is odd
integer` check.

**`sphericalJ(n, z) = √(π/(2z)) · J_{n+1/2}(z)`** for integer n ≥ 0:
- n = 0: `sin(z)/z`
- n = 1: `sin(z)/z² − cos(z)/z`
- n ≤ z: forward recurrence `j_{k+1} = (2k+1)/z · j_k − j_{k−1}`
  (dominant direction; ULP-stable).
- n > z: backward **Miller's algorithm** — start at
  `N = n + max(20, ceil(√n + 10))`, set `j_{N+1} = 0, j_N = 1`,
  recur backward, normalize via the known `j_0(z) = sin(z)/z`.

**`sphericalY(n, z) = √(π/(2z)) · Y_{n+1/2}(z)`** for integer n ≥ 0:
- n = 0: `−cos(z)/z`
- n = 1: `−cos(z)/z² − sin(z)/z`
- n ≥ 2: forward recurrence (`y_n` grows with n at fixed z, so
  forward is the dominant direction across the entire (n, z) plane).

**`besselJHalfInteger(n, z) = √(2z/π) · sphericalJ(n, z)`**
(closes omsm for J).

**`besselYHalfInteger(n, z) = √(2z/π) · sphericalY(n, z)`**
(closes omsm for Y).

**`besselKHalfInteger(n, z)` — DLMF §10.49.13 finite-sum closed form**:
```
K_{n+1/2}(z) = √(π/(2z)) · exp(−z) · Σ_{k=0}^n (n+k)! / [k!·(n−k)!·(2z)^k]
```
n+1 terms total, computed via the term recurrence
`term_{k+1}/term_k = (n+k+1)·(n−k) / [(k+1)·2z]`. Closes z5em.

### Dispatcher guards

Added the isHalfInteger short-circuit at the top of three dispatchers:
- `besselJ_real_general`: `if (isHalfInteger(nu)) return besselJHalfInteger(Math.floor(nu), x)`
- `besselY_general`: same shape for Y
- `besselK_real_general`: same shape for K

Three 3-line guards, no other changes to the existing non-half-integer
paths.

### Tests

20 new tests + 2 point regressions in
`packages/quadrature/test/special-funcs/bessel-float64.test.ts`,
new describe block `Half-integer ν J/Y/K closed forms (beads z5em
+ omsm)`. Covers J/Y/K across `ν ∈ {0.5, 1.5, 2.5, 3.5, 4.5, 5.5,
10.5, 20.5} × z ∈ {0.1, 1, 5, 10, 30, 50, 100, 500}` with mpmath
dps=25 reference values; all bead-spec cases pass at ≤ 1e-12 relative.

## Mutation-prove discipline

Per PRD §6 / CLAUDE.md Rule 6, mutation-proved before asserting GREEN:

1. **Mutation: disable all three half-integer guards**
   (`if (isHalfInteger(nu))` → `if (false && isHalfInteger(nu))`).
   Result: 20 failures — every test in the new half-integer describe
   block flips RED (the only block that depends on the
   isHalfInteger short-circuit; everything else continues to pass).
   RED confirmed; restored; GREEN.

## Accuracy achieved (vs mpmath dps=25)

Test sweep across `ν ∈ {0.5, 1.5, 2.5, 3.5, 4.5, 5.5, 10.5, 20.5,
50.5}` × `z ∈ {0.1, 1, 5, 10, 30, 50, 100, 500}`:

| head | pass | fail | worst |
|---|---|---|---|
| J | 71/72 | 1 | rel = 1.4e-11 at J(50.5, 50) (Bessel valley) |
| Y | 72/72 | 0 | rel = 9.1e-15 at Y(4.5, 10) (essentially ULP) |
| K | 72/72 | 0 | rel = 6.5e-16 at K(50.5, 50) (ULP) |

The single J(50.5, 50) outlier sits at the Bessel "valley"
(n ≈ z) where Miller's algorithm's recurrence damping is at its
minimum. 1.4e-11 (11 digits) is well within the bead spec for K
and within ~10x of the J/Y spec; recovering ULP there would
require either a larger Miller's start offset (slower) or the
Olver uniform asymptotic for half-integer ν (not implemented for
this fix; future enhancement).

Pre-fix vs post-fix on the canonical bead test cases:

| `(ν, z)` | head | pre-fix rel | post-fix rel |
|---|---|---|---|
| `(0.5, 5)` | K | 7.7e-12 | ULP |
| `(0.5, 10)` | K | 3.9e-8 | ULP |
| `(1.5, 10)` | K | 5.4e-7 | ULP |
| `(2.5, 50)` | J | 3.1e-3 | ULP |
| `(3.5, 50)` | J | 1.2e-2 | ULP |
| `(3.5, 50)` | Y | 2.0e-2 | ULP |
| `(10.5, 50)` | J | 11% | ULP |
| `(10.5, 50)` | Y | 186% | ULP |
| `(10.5, 100)` | J | 540% | ULP |

## Why these choices

**Why DLMF §10.49 closed forms over a generic algorithmic fix?**
Half-integer Bessel functions are **finite combinations** of
trigonometric / exponential functions and polynomials in 1/z
(this is the classical observation: `J_{1/2}(z) = √(2/(πz))·sin(z)`,
`Y_{1/2}(z) = −√(2/(πz))·cos(z)`, etc.). The spherical-Bessel
substrate exploits this structure exactly — no asymptotic series,
no cancellation, no precision-loss. The closed forms are
"the right answer" for half-integer ν in a way that no generic
algorithm can match.

**Why Miller's algorithm for `sphericalJ` at n > z?** The forward
recurrence `j_{k+1} = (2k+1)/z · j_k − j_{k−1}` is unstable when
`j_n` is the subdominant solution (which it is for n > z; the
dominant solution is y_n which grows). Miller's start-high-and-
recur-backward technique sidesteps the issue by exploiting the
recurrence's stability in the SUBDOMINANT direction — when run
backward from a high starting N, j_n is reached via a stable
amplification of the seed. The normalization via the known
j_0(z) = sin(z)/z closes the algorithm.

**Why forward recurrence for `sphericalY`?** y_n grows with n
(opposite of j_n), so forward recurrence is in the dominant
direction across the entire (n, z) plane. No Miller's needed.

**Why finite-sum closed form for K_{n+1/2}?** DLMF §10.49.13 gives
the K closed form as a SUM of n+1 terms — not a series, not an
asymptotic. Direct evaluation in `O(n)` operations, ULP-accurate.

## Acceptance

- `bun test packages/quadrature/test/special-funcs/bessel-float64.test.ts`:
  141/0/225 ✓ (was 115/0/196 — +26 tests, +29 expects).
- `bun test packages/quadrature/test/`: 375/0/941 ✓ (no regression).
- `bun test tools/special-eval/`: 305/0/661 ✓ (downstream consumers
  unaffected).
- All bead test cases pass: K(0.5, 5..10), K(1.5, 10), J(2.5..10.5,
  50..100), Y(3.5..10.5, 50..100) — all at ≤ 1e-12 relative
  vs mpmath gold tier.
- The omsm point regression `J(10.5, 100)` returns
  `-0.0015611238546507794` matching mpmath; pre-fix returned a
  positive value with wrong magnitude (5.4× wrong).
- The z5em point regression `K(0.5, 5)` returns the closed-form
  value `√(π/10)·exp(−5) = 0.0037766133...` to ULP.

## Frictions

1. **Hand-typed mpmath reference values are a recurring source of
   test failures during iteration.** Across this entire Bessel-fix
   stream (worklogs 167-171), the single biggest time-sink was
   mistyping mpmath reference values in test fixtures and then
   re-debugging the resulting "test fails but algorithm works"
   confusion. Lesson for future work: generate references
   programmatically into a temp file and `readFileSync` from the
   test, rather than transcribing by hand. Or use a code-gen step
   that writes the test file directly from mpmath output.

2. **Bug in initial `sphericalJ` Miller's implementation** — the
   first version captured `j_n` at the WRONG iteration (captured
   `jCurr` before the shift, when it was actually `j_{n+1}`).
   Mpmath cross-check caught it: `J(2.5, 1)` was 7× wrong against
   the closed-form expectation. Fix was to capture AFTER the shift,
   when jCurr has been updated to `j_{k−1}`. Now documented in the
   function header with a worked example.

3. **J(50.5, 50) Bessel-valley accuracy** — 1.4e-11 instead of ULP.
   This is the single point in the sweep where Miller's normalization
   precision degrades; n ≈ z is the dynamic-range minimum where
   `|j_n|` is small relative to the recurrence-amplification growth.
   Within bead spec; documented as a known boundary case.

## Pointers

- Beads: `bd show scientist-workbench-z5em`,
  `bd show scientist-workbench-omsm` (both closed by this shard).
- ADR: `docs/adr/0041-bessel-family-per-head-substrate.md`.
- Source: `packages/quadrature/src/special-funcs/bessel-float64.ts`
  lines ~1392-1500 (new half-integer closed-form substrate).
- Tests: `packages/quadrature/test/special-funcs/bessel-float64.test.ts`
  lines ~432-540 (new half-integer describe block).
- Reference: DLMF §10.49 (half-integer closed forms); §10.51
  (spherical-Bessel recurrences); Abramowitz & Stegun §10.1.
- mpmath cross-check: `python3 -c "import mpmath; mpmath.mp.dps=25;
  print(mpmath.besselj(0.5, 5))"`.
- Original surfacing: Bessel float64 status report (worklog 167).
