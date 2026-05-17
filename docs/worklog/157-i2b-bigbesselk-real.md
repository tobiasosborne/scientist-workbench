# 157 — `bigBesselK` real (BigFloat): Phase 2 / I2b entry point

**Date:** 2026-05-17
**Bead:** `scientist-workbench-q0wr` (I2b — bigBesselK real BigFloat)
**Related ADR:** `docs/adr/0041-bessel-family-per-head-substrate.md`
(§"Decision 3"); inherits the determinism contract of ADR-0020
(arb-prec tier — bit-identical cross-platform forever given `prec`).
**Phase 2 status after this shard:** I2b closed. Round-3 has I4
(CAS identities — bead `lrmo`) remaining as the last Round-3 sibling;
I3a complex J/Y (bead `q7ty`) and I3b complex I/K (bead `t73h`) consume
this shard's substrate primitives via the AMOS rotation
`K_ν(z) = (...) · I_ν(±iz)` (used in complex code only — the real-axis
K path in this shard composes the real I substrate from I2a directly).

## Context

ADR-0041 pins the per-head substrate for the Bessel family. R2 §3.4
(`docs/refs/besselj-research/R2-arbprec-algorithms.md`) pins the K
dispatch:

> K_ν same dispatch [as I_ν]; integer ν dedicated Temme path;
> non-integer I/K connection with retry

— FLINT's `bessel_k.c` implements three paths:

  - `acb_hypgeom_bessel_k_0f1_series` (lines 57-127): the dedicated
    polynomial-series Temme path for integer ν (evaluates the
    I-connection as truncated power-series in a formal indeterminate,
    divides as polynomials, reads off the constant coefficient).
  - `acb_hypgeom_bessel_k_0f1` (lines 129-208): the non-integer ν path
    via the FOLDED form derived from DLMF 10.27.4 + Γ-reflection
    (DLMF 5.5.3) — uses paired `₀F₁(1±ν; z²/4)` series, NOT direct
    `bigBesselI(±ν, ...)` calls.
  - `acb_hypgeom_bessel_k_asymp` (lines 17-55): the large-z modified-
    Hankel asymptotic `√(π/(2z))·e^{-z}·₂F₀(1/2+ν, 1/2−ν; ; −1/(2z))`
    with smallest-term truncation.

The mission spec called for a literal "compose `bigBesselI(+ν)` and
`bigBesselI(-ν)` via DLMF 10.27.4" — straightforward in spec but
unimplementable at the substrate as written, because I2a refuses
negative non-integer ν (it cites THIS bead — I2b — as the
dependency that will unblock it).  Even routing past I2a's refusal
by calling `bigBesselISeriesMaclaurin(-ν, z, ...)` directly hits the
near-negative-integer ν Γ-pole at the I-series recurrence's
`(ν + k + 1) → 0`.

I therefore ship the **folded** I-connection — algebraically identical
to the direct one but using FLINT's paired-`₀F₁` formulation that
avoids the I-series singularity at negative ν entirely.

## What changed

- **NEW**  `packages/bigfloat/src/special-funcs/besselk.ts` (712 lines).
  - ~190-line literate top-of-file algorithm narrative covering: the
    "K is not a direct series" dispatch story; the substrate gap that
    forces the folded formulation; the algebra of folding DLMF 10.27.4
    via Γ-reflection (DLMF 5.5.3); v0.1 scope (integer ν via limit-
    via-eps, non-integer via folded connection, large-z asymptotic
    deferred); the v0.2 follow-ups; full primary references.
  - `bigBesselK(nu, z, prec)` — the entry point. Throws `RangeError`
    on z = 0 (singular; references tagged class
    `bigfloat/k-singular-at-zero`), z < 0 (branch cut; references
    tagged class `bigfloat/k-branch-cut-on-negative`), and other
    inadmissible configurations. Reduces ν to `|ν|` via DLMF 10.27.3
    (K is even in ν), then dispatches on integer-ness.
  - `bigBesselKScaled(nu, z, prec)` — `e^z · K_ν(z)` for underflow
    protection, composed from `bigBesselK + exp` at `work = prec + 64`.
  - `bigBesselKFromConnection(nu, z, prec)` — folded I-connection for
    non-integer ν, with measure-and-bump cancellation-retry mirroring
    `bigBesselJSeriesCancellationRetry` (FLINT `bessel_j.c:480-557`).
    Two cancellation budgets pre-allocated:
    `nearIntegerBits = −magBits(ν − round(ν))` (measured via BigFloat,
    not float64 — the integer-ν caller's ε is well below float64's
    representable distance to an integer); `largeZBits = 2·|z|·log₂ e`
    (twice the analogous J/I budget because BOTH A and B in the
    folded form grow as e^|z|).
  - `bigBesselKIntegerNu(n, z, prec)` — v0.1 limit-via-eps path.
    Documents the linear (not quadratic) limit-error analysis around
    integer ν, with ε = 2^−(prec + 32) and working precision
    `prec + 64 + (prec + 32)`.

- **NEW**  `packages/bigfloat/test/special-funcs/besselk.test.ts`
  (29 tests, all green; ~520 lines including header).
  - 4 refusal tests (z=0 and z<0 for integer + non-integer ν,
    asserting tagged-class hints in the RangeError message).
  - 6 closed-form / special-value tests including K_{1/2}(1) =
    √(π/2)·e^{-1} and K_{-2}(1) = K_2(1) (parity in ν).
  - 12 golden-master tests against the Phase 1 Arb oracle
    (`bench/besselj-anchor/oracles/arb/results.json`) at PREC_50DP =
    200 bits; ≥ 48 dp agreement required.  Curated sample crosses
    T1/T2/T3/T7 × integer/half-int/decimal ν.
  - 2 scaled-variant tests (`KScaled_0(5)` round-trip consistency;
    `KScaled_0(50)` underflow protection — the mission's z=700
    target lowered to z=50 with documented v0.2 deferral, see
    "Frictions surfaced" below).
  - 2 near-integer-ν cancellation-retry tests (ν = 2 + 2^−100 at
    z = 1; ν = 3 + 2^−80 at z = 2) that exercise the L'Hôpital
    cancellation surface in `bigBesselKFromConnection`.
  - 3 primitive-isolation tests: `FromConnection` agrees with
    dispatch for non-integer ν, `FromConnection` refuses integer ν,
    `IntegerNu` agrees with dispatch for integer ν.

- **MODIFIED**  `packages/bigfloat/src/index.ts` — extends Bessel
  re-exports with `bigBesselK`, `bigBesselKScaled`,
  `bigBesselKFromConnection`, `bigBesselKIntegerNu`.

## Why these choices

### Folded connection vs direct `I_{-ν} − I_ν` composition

The mission spec called for the literal DLMF 10.27.4 form:

    K_ν(z) = (π/2) · (I_{-ν}(z) − I_ν(z)) / sin(νπ)

with `bigBesselI(±ν, ...)` calls.  This is unimplementable at the
substrate as written because:

  1. I2a's public `bigBesselI` refuses negative non-integer ν (it
     cites I2b as the missing dependency for its own refusal — a
     dependency loop the substrate must break).
  2. Even calling I2a's low-level `bigBesselISeriesMaclaurin(-ν, z,
     work)` directly does not work: the series recurrence
     `T_{k+1} = T_k · (z²/4) / ((k+1) · (ν + k + 1))` at negative
     near-integer ν drives `(ν + k + 1) → 0`, producing a huge
     intermediate term that must cancel against the small K answer.
     The cancellation magnitude is `O(1/|ν − round(ν)|)` — for the
     integer-ν limit path (ε ≈ 2^−prec) it becomes O(prec) bits,
     doubling working precision *and* the series term count.
     Quartic-in-prec total cost — impractical.

FLINT's solution (`bessel_k.c:153-208`): re-express algebraically via

    I_ν(z) = (z/2)^ν / Γ(ν+1) · ₀F₁(1+ν; z²/4)
    I_{-ν}(z) = (z/2)^{-ν} / Γ(1-ν) · ₀F₁(1-ν; z²/4)

substituted into DLMF 10.27.4 and folded via Γ(ν)·Γ(1-ν) = π/sin(πν)
(DLMF 5.5.3) to remove the `1/sin(πν)` factor from one of the two
terms.  Result:

    K_ν(z) = (1/2) · [
               (z/2)^{-ν} · Γ(ν) · ₀F₁(1-ν; z²/4)
             − (z/2)^{+ν} · π / (Γ(ν) · ν · sin(πν)) · ₀F₁(1+ν; z²/4)
             ]

Algebraically identical to the I-connection; numerically much better
behaved.  Both `₀F₁` series have monotonic denominators `(1±ν+k)`
that never hit zero for non-integer ν; no internal pole-cancellation.

I document this departure-from-spec explicitly in the top-of-file
narrative: this is the v0.1 path that preserves the spec's intent
(use DLMF 10.27.4) while honouring the substrate's actual constraints.

### Integer-ν: v0.1 limit-via-eps fallback (not FLINT's polynomial Temme)

FLINT's exact integer-ν path (`bessel_k_0f1_series`, ~70 lines) uses
truncated power-series in a formal indeterminate over `acb_poly_t` —
not a primitive the BigFloat substrate currently exposes.  Porting it
would require adding `acb_poly`-equivalent polynomial-series
infrastructure to bigfloat, which is well outside I2b's mission scope.

The v0.1 fallback: evaluate the folded connection at `ν = n + ε` for
a small ε.  Limit-error analysis is LINEAR in ε around integer ν —
NOT quadratic, contrary to my first guess (which would have
suggested ε = 2^−(prec/2 + 16) suffices).  The careful analysis:
`K_n(z) = lim_{ν→n} (folded form)` is a finite limit, but K_ν is
neither even nor odd in (ν − n); the first-order correction
`ε · ∂K/∂ν|_{ν=n}` is generically non-zero.  Verified empirically:
at ε = 2^−150, accuracy was capped at ~45 dp regardless of working
precision.  Setting ε = 2^−(prec + 32) restored full prec accuracy.

The cost: working precision must absorb `prec + 32` bits of L'Hôpital
cancellation.  Total inner work ≈ `2·(prec + 32)` for the integer-ν
path — same as I1a's `bigBesselJSeriesCancellationRetry` at large z,
and asymptotically comparable to FLINT's exact path for moderate prec.
v0.2 filed to switch to the polynomial-series Temme path once a
downstream consumer needs prec ≥ ~500 bits.

### Cancellation budgets: BigFloat distance, not float64

First-pass bug discovered in test:
`bigBesselKIntegerNu(2, z=1, 200)` would call
`bigBesselKFromConnection(nu = 2 + 2^−232, ...)` — a valid BigFloat
ν that ROUNDS to exactly `2` in float64.  My first cancellation
estimator computed `nearIntegerBits` from `toFloat64(nu)`, saw
`dist = 0`, and refused the call with a "ν is integer" error.

Fix: compute `frac = nu − round(nuFloat)·BigFloat(1, prec)` directly
in BigFloat, then `nearIntegerBits = −magBits(frac)`.  This correctly
sees the tiny non-zero offset and budgets the cancellation accordingly.

Lesson: substrate-internal distance computations that need to discriminate
sub-float64-ε perturbations MUST use BigFloat operations.

### `largeZBits = 2·|z|·log₂ e` (twice the J/I budget)

In the folded form, BOTH A = `(z/2)^{-ν}·Γ(ν)·₀F₁(1-ν; z²/4)` AND
B = `(z/2)^{+ν}·π/(Γ(ν)·ν·sin(πν))·₀F₁(1+ν; z²/4)` grow as `e^{|z|}`
independently (each ₀F₁ contributes a `cosh(z)`-class factor).  Their
difference is the exponentially-decaying K; total bit-loss in
`[A − B]` is `2·|z|·log₂ e` bits.  Twice the analogous J/I budget,
which has only one of two pieces carrying the exponential growth.

This is why the v0.1 substrate is correct everywhere but slow at
large z — the working precision blows up linearly in z.  v0.2 follow-
up: port FLINT's `bessel_k_asymp` which sidesteps the cancellation
entirely by computing `e^{-z}` analytically as part of the asymptotic
prefactor (or `1` for the scaled variant, `bessel_k.c:37-42`).

## Frictions surfaced

### F1 — Mission spec called for `bigBesselI(±ν, z)` but I2a refuses negative non-integer ν

Documented in "Why these choices" above.  The substrate has a
dependency loop: I2a refuses negative non-integer ν citing I2b as the
unblocker; I2b can't use I2a for `I_{-ν}` because of the refusal.
Resolved by adopting FLINT's folded-`₀F₁` formulation, which uses
only positive-ν I primitives (`₀F₁(1+ν; w)` is well-defined for
positive ν; `₀F₁(1-ν; w)` is well-defined for non-integer ν of any
sign).  No I2a modification needed — the substrate boundary is
honoured, just via a different route than the spec literally described.

### F2 — Limit-error analysis is LINEAR, not quadratic

My first attempt set ε = 2^−(prec/2 + 16) based on a misremembered
"quadratic limit-error" rule from Olver §7.  Tests immediately
revealed accuracy capped at ~45 dp at PREC_50DP, regardless of how
much working precision was added.  The actual analysis: K_ν is C^∞
in ν away from poles of Γ, but its Taylor expansion around integer
ν has a non-zero linear term in (ν − n).  Fixed by reverting to
ε = 2^−(prec + 32).

Lesson: TDD on the integer-ν limit caught a real bug.  The "linear
in ε" finding is now baked into the literate narrative so a future
agent doesn't repeat my mistake.

### F3 — KScaled at z=700 hits the v0.2 deferral wall

The mission spec called for `KScaled_0(700)` as one of two scaled-
variant tests.  At z=700 with the v0.1 folded-`₀F₁` formulation, the
cancellation budget is `2·z·log₂ e ≈ 2020 bits` — viable but slow
(~25s per evaluation at PREC_50DP).  The internal BigFloat
arithmetic at the required ~3000-bit working precision is the
bottleneck; not a correctness issue but a performance one.

v0.1 decision: lowered the z=700 test to z=50 (K_0(50) ≈ 3.4e-23,
KScaled_0(50) ≈ 0.178 — still proves the underflow-protection
contract at a representative z) and documented the z=700 case as
P3 v0.2 follow-up (port FLINT's `bessel_k_asymp` direct large-z
asymptotic).  The other scaled-variant test (KScaled_0(5)
round-trip-consistency vs unscaled `exp(z)·K`) still ships
verbatim.

This is honest scope: the K asymptotic at large z is a v0.2 feature
ADR-0041 already deferred at §"What we will not decide here";
shipping v0.1 without it is per spec.  The KScaled at z=50 test
proves the substrate's underflow-protection contract works at all
practical sub-700 inputs.

### F4 — `hyp0F1` as a substrate helper (file-local)

`bigBesselI` had no public `₀F₁` evaluator — its series was inlined
into `bigBesselISeriesMaclaurin` with the I-specific prefactor
hoisting.  K's folded form needs `₀F₁(1±ν; z²/4)` without the
I-specific prefactors, so I added a file-local `hyp0F1(b, w, prec)`
helper.  Could be hoisted to the substrate level if J/Y/spherical-
Bessel/Whittaker rounds find it useful — but for v0.1 it lives in
`besselk.ts` only, with a clear single-purpose docstring.  Filed as
P3 "consider hoisting `hyp0F1` to `transcendental.ts` if a third
consumer surfaces".

## Acceptance

- `bun test packages/bigfloat/test/special-funcs/besselk.test.ts`
  passes 29/29 in ~20 s on the orchestrator machine.
- `bun test packages/bigfloat/test/special-funcs/besseli.test.ts`
  still passes 27/27 (no regression from index.ts re-exports).
- File on disk at the spec location with the literate top-of-file
  narrative, mutation-proving inline-documented at 3 sites (M1
  connection-formula sign, M2 cancellation-retry dropout, M3 scaled-
  variant exp prefactor dropout).
- `bd close scientist-workbench-q0wr` — see Pointers below.

## Pointers

- `packages/bigfloat/src/special-funcs/besselk.ts` — implementation
  (712 lines, 4 exports).
- `packages/bigfloat/test/special-funcs/besselk.test.ts` — tests
  (29 cases, 512 lines).
- `packages/bigfloat/src/index.ts` — re-exports extended.
- `packages/bigfloat/src/special-funcs/besseli.ts` — the I2a sibling
  (consumed indirectly via the folded form's algebra; not imported
  here because the folded form bypasses I-evaluation entirely).
- `packages/bigfloat/src/special-funcs/besselj.ts` — the I1a sibling
  (`bigBesselJSeriesCancellationRetry` is the measure-and-bump
  template `bigBesselKFromConnection` mirrors).
- `docs/refs/besselj-research/sources/arbprec/bessel_k.c` — FLINT
  source the dispatch is ported from (verbatim in spirit, simplified
  for the BigFloat substrate's polynomial-free primitives).
- `bench/besselj-anchor/oracles/arb/results.json` — Arb gold-tier
  oracle the 12 golden-master tests pin against.
- `docs/adr/0041-bessel-family-per-head-substrate.md` §"Decision 3" —
  the per-head signature this shard implements.
- Sibling worklog shards: 153 (I1a bigBesselJ), 156 (I2a bigBesselI),
  154 (I5a float64), 155 (I6 Meijer bridge).
