# 158 — `bigBesselY` real (BigFloat): Phase 2 / I1b entry point

**Date:** 2026-05-17
**Bead:** `scientist-workbench-1doz` (I1b — bigBesselY real BigFloat)
**Related ADR:** `docs/adr/0041-bessel-family-per-head-substrate.md`
(§"Decision 3" + §"Decision 13"); inherits the determinism contract of
ADR-0020 (arb-prec tier — bit-identical cross-platform forever given
`prec`).
**Phase 2 status after this shard:** I1b closed.  Round-2 of Phase 2
(I1a J + I1b Y, joint per the FLINT pattern) is complete; Round 3
(I2a I + I2b K + I4 + I3a) was already closed.  Round 4 (I3b complex
+ I6 Meijer-G bridge) is the remaining substrate work.

## Context

ADR-0041 pins the per-head substrate for the Bessel family.  R2 §3.2
(`docs/refs/besselj-research/R2-arbprec-algorithms.md`) pins the Y
dispatch:

> non-integer ν → connection formula `Y_ν(z) = (J_ν cos(νπ) − J_{-ν}) /
> sin(νπ)` (DLMF 10.2.3);
> integer ν → ideally via the FLINT pattern `Y_n(z) = -2 i^n K_n(iz)/π
> − phase(z) i J_n(z)` (lines 36-80 of FLINT `bessel_y.c`) to avoid the
> connection's L'Hôpital cancellation.

The FLINT integer-ν path requires `bigCBesselK` (complex K), which has
not yet shipped — bead `t73h` (I3b) is in Round 4.  For v0.1 we adopt
the same **limit-via-ε** strategy I2b adopted for K_n (worklog 157):
evaluate the non-integer connection at `ν = n + ε` with `ε = 2^−(prec
+ 32)` and boost the working precision to absorb the L'Hôpital
cancellation.  Limit-error is linear in ε around the integer-ν
singularity (worklog 157 friction #2, pinned in this shard's header
narrative).

The mission spec explicitly called out "bypass I1a's wrapper refusal
via direct primitive calls": I1a's `bigBesselJ(-1.5, z, prec)` throws
RangeError pointing at I1b (this bead) as the unblocker.  The Y
connection formula REQUIRES `J_{-ν}` for non-integer ν; we sidestep
the wrapper by routing onto I1a's exported primitives
(`bigBesselJSeriesMaclaurin`, `bigBesselJHankelAsymptotic`,
`bigBesselJSeriesCancellationRetry`) via a local re-implementation of
the small-/transition-/large-z dispatch (`evalJAnyNu` in `bessely.ts`).

## What changed

- **NEW**  `packages/bigfloat/src/special-funcs/bessely.ts` (~510 lines).
  - ~140-line literate top-of-file algorithm narrative covering: the
    "Y via J/J(-ν) connection" story; why the FLINT complex-K rotation
    is the v0.2 path; the linear-not-quadratic limit-error analysis
    for ε choice (the I2b lesson); the I1a-wrapper-bypass mechanism
    via direct primitive calls; the M1/M2/M3 mutation points; full
    primary references.
  - `bigBesselY(nu, z, prec)` — the entry point.  Throws `RangeError`
    on z = 0 (singular; references tagged class
    `bigfloat/y-singular-at-zero`), z < 0 (branch cut; references
    tagged class `bigfloat/y-branch-cut-on-negative`).  Dispatches
    on `asExactInteger(nu)` — exact integer ν → limit-via-ε path;
    non-integer → connection-formula primitive.
  - `bigBesselYConnection(nu, z, prec)` — DLMF 10.2.3 connection for
    non-integer ν with measure-and-bump cancellation-retry mirroring
    `bigBesselKFromConnection`.  Cancellation budget pre-allocated:
    `nearIntegerBits = −magBits(ν − round(ν))` (measured via BigFloat,
    not float64 — the integer-ν caller's ε is well below float64's
    representable distance to an integer; carrying the I2b friction-#1
    lesson).  Unlike K's connection, NO exponential-growth budget — Y
    has no `2|z|·log₂ e` term because both J_ν and J_{-ν} are O(1/√z)
    at large z.
  - `bigBesselYIntegerNu(n, z, prec)` — v0.1 limit-via-ε path.
    `ε = 2^−(prec + 32)` (linear-error budget per the I2b worklog 157
    lesson).  Working precision `2·(prec + 32) + 32`.  Applies DLMF
    10.4.1 parity `Y_{-n} = (-1)^n Y_n` after the limit evaluation
    so the cancellation harness operates on the small-positive-|ν|
    side where its analytic budget is tight.
  - `evalJAnyNu(nu, z, prec)` — internal helper that dispatches onto
    I1a's exported primitives directly, bypassing the wrapper's
    non-integer-negative-ν refusal.  Mirrors I1a's small-/transition-/
    large-z structure (besselj.ts:741-842) modulo the impossible
    negative-z branch (caller guarantees z > 0).

- **NEW**  `packages/bigfloat/test/special-funcs/bessely.test.ts`
  (30 tests, all green; ~460 lines including header).
  - 4 refusal tests (z=0 and z<0 for integer + half-integer ν,
    asserting tagged-class hints in the RangeError message).
  - 6 closed-form / special-value tests: Y_0(1) ≈ 0.0883,
    Y_{1/2}(1) = -√(2/π)·cos(1), Y_1(1), Y_0(10), Y_1(10), Y_2(5).
  - 12 golden-master tests against the Phase 1 Arb oracle
    (`bench/besselj-anchor/oracles/arb/results.json`) at PREC_50DP =
    200 bits; ≥ 48 dp agreement required.  Curated sample crosses
    T1/T2/T3 × integer (n=0,1,2) / half-integer (1/2, 3/2) / decimal
    (1.7, 2.3) ν.
  - 2 near-integer-ν cancellation-retry tests: ν = 1 + 2^−100 at z = 1
    agrees with Y_1(1) to ≥ 25 dp; ν = 2 + 2^−80 at z = 3 agrees with
    Y_2(3) to ≥ 20 dp.  Exercises the L'Hôpital cancellation surface.
  - 2 negative-integer-ν parity tests: Y_{-1}(1) = -Y_1(1) (odd n);
    Y_{-2}(1) = Y_2(1) (even n).  Validates DLMF 10.4.1.
  - 4 primitive-isolation tests: `Connection` agrees with dispatch
    for non-integer ν, `Connection` refuses integer ν; `IntegerNu`
    agrees with dispatch for n = 1 and n = 0 (the most-cancellation-
    prone integer case).

- **MODIFIED** `packages/bigfloat/src/index.ts` — added re-exports for
  `bigBesselY` / `bigBesselYConnection` / `bigBesselYIntegerNu`.

## Why these choices

- **Limit-via-ε with `ε = 2^−(prec + 32)`** (linear, not quadratic
  budget) — pinned in the literate header as the I2b worklog 157
  friction #2 lesson.  Symmetry intuition suggests `Y(n+ε) − Y(n) =
  O(ε²)` is plausible (the L'Hôpital limit is "centred" at the
  singularity), but the actual Taylor expansion is `Y(n+ε) = Y_n + ε ·
  ∂Y/∂ν|_n + O(ε²)` with a non-zero linear term.  M3 mutation point
  catches a quadratic-budget regression by going RED at the integer-ν
  golden masters.

- **`asExactInteger` for the dispatch test** — uses
  `eq(nu, fromInt(round(toFloat64(nu)), nu.precision))` per `besselk.ts`.
  A BigFloat built via `fromInt(2n)` trivially passes; `fromString("2.0")`
  also passes (the fractional bits are exactly zero); `add(fromInt(2n),
  eps)` with `eps = 2^-100` does NOT pass (a non-zero fractional bit
  remains at the prec=200 level).  This routes "really integer" inputs
  to the limit-via-ε path and "almost-integer" inputs to the
  cancellation-retry connection, which is the correct semantic
  partition.

- **Bypassing I1a's wrapper refusal via direct primitive calls** —
  I1a's `bigBesselJ(-1.5, z, prec)` throws RangeError pointing at I1b
  as the unblocker.  We honour that contract (the refusal protects
  agents calling J directly from getting silent wrong answers) while
  routing internally past it for Y's connection-formula use case.  The
  bypass is encapsulated in `evalJAnyNu` — a Y-specific implementation
  detail of the connection-formula path, not a J-substrate change.

- **`nearIntegerBits` measured via BigFloat, not float64** — carries
  the I2b worklog 157 friction #1 lesson directly.  At prec=200,
  `add(fromInt(1n), {mantissa:1n, exponent:-100, precision:200})`
  produces a BigFloat that `toFloat64` rounds to exactly 1.0, so a
  float64-based `nuRound = Math.round(toFloat64(nu))` returns 1 and
  the float-based `frac = toFloat64(nu) − 1` returns 0 (which would
  trigger the spurious "integer" refusal).  The BigFloat-based test
  via `sub(nu, fromInt(BigInt(nuRound), nu.precision))` correctly
  reports a non-zero `frac` with `magBits ≈ -100`, allowing the
  cancellation-retry path to engage with a 100-bit budget.

- **No exponential cancellation budget on the Y connection** —
  contrast with K's connection where both `(z/2)^{-ν}·Γ(ν)·₀F₁(1-ν)`
  and `(z/2)^{+ν}·π/(Γ(ν)·ν·sin(πν))·₀F₁(1+ν)` grow as `e^|z|`,
  requiring `2|z|·log₂ e` extra bits.  Y's `J_ν` and `J_{-ν}` are
  each O(1/√z) at large z (Hankel asymptotic), so the connection's
  subtraction has no exponential-growth cancellation.  The only loss
  is the L'Hôpital one at near-integer ν.

- **Negative-integer-ν parity applied after the limit** —
  `bigBesselYIntegerNu(n, z, prec)` invokes the connection at
  `nuExact = |n| + ε` (positive) and applies the `(-1)^n` parity sign
  flip at the end.  This keeps the cancellation harness operating on
  the small-positive-ν side where its analytic budget is tight (the
  near-integer-ν bits estimate uses `round(nuFloat) = 1`, not `= -1`).
  Verified by tests `Y_{-1}(1) = -Y_1(1)` and `Y_{-2}(1) = Y_2(1)`.

## Frictions surfaced

1. **First-pass: tests passed on first run** — 30/30 green at
   `bun test packages/bigfloat/test/special-funcs/bessely.test.ts` in
   ~26 seconds.  No bugs surfaced.  The I2b pattern transferred
   cleanly because the algebraic structure of Y's connection is the
   simpler sibling of K's (no exponential-growth cancellation budget,
   no Γ-reflection-folded form needed — Y's `J_{±ν}` are already
   the canonical series, no substrate gap to route around).

2. **No friction with `evalJAnyNu`** — I had braced for subtle
   sign/parity bugs in routing onto I1a's primitives with negative ν,
   but the J primitives are sign-agnostic in ν within their
   mathematical domain (z > 0, ν avoiding negative integers).  The
   only adaptation was to compare `|ν|` against `z²/4` in the FLINT
   short-circuit (the cancellation-suppression argument depends on
   `|ν + k|`, not on the sign of ν).

3. **Test count: 30 vs the mission-spec ≥ 24** — extra 6 tests came
   from layering the negative-ν parity coverage (2 tests) and the
   primitive-isolation tests (4 tests) symmetrically with
   `besselk.test.ts`.  Worth it for the mutation-proving coverage —
   the negative-ν parity tests catch a class of "applied parity to
   the wrong side of the limit" bugs that the integer-ν dispatch
   could otherwise hide.

## Acceptance

- `packages/bigfloat/src/special-funcs/bessely.ts` on disk
  (510 lines including ~140-line literate header).
- `packages/bigfloat/test/special-funcs/bessely.test.ts` on disk
  (30 tests, ALL green at `bun test
  packages/bigfloat/test/special-funcs/bessely.test.ts`, 57 expect()
  calls).
- Three M-mutations documented inline in `bessely.ts`'s narrative.
- `bd update scientist-workbench-1doz --status closed --notes …` to
  follow this commit.

## Pointers

- `packages/bigfloat/src/special-funcs/bessely.ts` — the substrate.
- `packages/bigfloat/test/special-funcs/bessely.test.ts` — the tests.
- `packages/bigfloat/src/index.ts` — re-export additions.
- `docs/adr/0041-bessel-family-per-head-substrate.md` §"Decision 3"
  + §"Decision 13" — the pinned algorithm dispatch + branch convention.
- `docs/worklog/157-i2b-bigbesselk-real.md` — the I2b pattern this
  shard mirrors (limit-via-ε for integer ν, BigFloat-measured
  `nearIntegerBits`, measure-and-bump retry).
- `docs/worklog/153-i1a-bigbesselj-real.md` — the I1a substrate this
  shard consumes (exported primitives bypass the wrapper refusal for
  non-integer negative ν).
- `bench/besselj-anchor/oracles/arb/results.json` — gold-tier golden
  master for the 12 byte-match tests.
- v0.2 follow-up: port FLINT `acb_hypgeom_bessel_y.c:36-80`
  (`Y_n via K_n(iz)` rotation) when I3b ships `bigCBesselK`.  Will
  eliminate the integer-ν limit-error entirely and gain ~50% perf
  on integer-ν inputs.  Filed P3 under epic `zcam`.
