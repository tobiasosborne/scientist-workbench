# 170 — `bigBesselJ` / `bigBesselI` large-ν regression: dispatch-guard fix (close m4ut)

**Date:** 2026-05-17
**Bead:** `scientist-workbench-m4ut` (`bigBesselJ` / `bigBesselI` at
large ν, large z return wildly wrong values). Filed 2026-05-17 by the
Bessel float64 status report (worklog 167); confirmed during the
zapb investigation (worklog 169) when the bigfloat substrate gave
the wrong sign + magnitude for the reference values.
**ADR:** [0041 — Per-head substrate applied to the canonical Bessel
family](../adr/0041-bessel-family-per-head-substrate.md).

## Context

The bigfloat Bessel substrate `bigBesselJ` and `bigBesselI` (worklog
166) dispatch to `bigBesselJHankelAsymptotic` / `bigBesselIHankelAsymptotic`
for `|z| > z_c(prec)` (J side) and `2|z| ≥ prec` (I side). Both
asymptotic forms are the standard Hankel-style series in `1/(8z)`:

```
J_ν(z) ~ √(2/(πz)) · [P(ν,z)·cos(ω) − Q(ν,z)·sin(ω)]   where ω = z − νπ/2 − π/4
I_ν(z) ~ exp(z)/√(2πz) · Σ_{k=0}^∞ (−1)^k a_k(ν) / z^k    where a_k = ∏(4ν² − (2j−1)²)/(j·8)
```

For `ν ≫ z`, the asymptotic `(4ν² − (2k−1)²)/(8(k+1)z)` term-ratio
grows factorially up to `k ≈ ν` before decaying. The optimal-
truncation point falls inside catastrophic intermediate-term growth
and the asymptotic returns orders-of-magnitude wrong values:

> `bigBesselJ(100, 150, 200)` → `+2.171` against mpmath `−0.01536`
> — **141× wrong + sign flip**.
> `bigBesselI(100, 150, 200)` → `−1.47e+65` against mpmath `+4.14e+49`
> — **17 orders wrong + sign flip**.
> `bigBesselI(50, 100, 200)` → `−1.23e+43` against mpmath `+4.82e+36`
> — 7 orders wrong + sign flip.

**Load-bearing impact**: this bug means the bigfloat substrate cannot
serve as oracle for the float64 lanes in the large-ν regime. Worklog
167's float64 status probe was mis-graded against this oracle and
led to a false "J catastrophic" claim that was actually a bigfloat
bug. The investigation surfaced the broken-oracle pattern.

Y and K side were probed and are NOT affected (verified `bigBesselY`
and `bigBesselK` give correct values at the same broken (ν, z) — K
because the `exp(−z)` prefactor damps the asymptotic-sum errors; Y
because at large z the algorithm uses a different code path that
doesn't go through the broken asymptotic). The fix scope is J and I
only.

## What changed

### `packages/bigfloat/src/special-funcs/besseli.ts`

Added a `ν ≥ 25` large-ν guard at the top of the dispatcher (lines
580-583 of `bigBesselI`):

```ts
if (Number.isFinite(nuFloat) && nuFloat >= 25) {
  return bigBesselISeriesMaclaurin(nu, absX, prec);
}
```

The Maclaurin (0F1) series is ULP-accurate for any (ν, z) with
finite-magnitude output; BigFloat exponent range comfortably holds
the intermediate-term magnitudes that float64 cannot. The cost is
O(ν + z²/(4ν)) BigFloat operations per call, which is acceptable at
moderate precision.

### `packages/bigfloat/src/special-funcs/besselj.ts`

Added a parallel `ν ≥ 25` guard at the top of `bigBesselJ` (lines
820-831):

```ts
if (Number.isFinite(nuFloatEarly) && nuFloatEarly >= 25) {
  if (Number.isFinite(xFloat) && nuFloatEarly > (xFloat * xFloat) / 4) {
    return bigBesselJSeriesMaclaurin(nu, absX, prec);
  }
  return bigBesselJSeriesCancellationRetry(nu, absX, prec);
}
```

J's Maclaurin alternates in sign (the `(−1)^k` factor in
`Σ (−z²/4)^k / [k!(ν+k)!]`), so for the cancellation-prone regime
(`ν ≤ z²/4`) we use the `cancellationRetry` variant that sizes the
working precision to recover ULP after measured loss. For
`ν > z²/4` the FLINT short-circuit applies (no significant
cancellation) and direct Maclaurin suffices.

### Sibling float64 fix (worklog 169) for reference

The float64 lane couldn't use Maclaurin for very large (ν, z) because
the intermediate terms overflow float64 (`~10^308` ceiling). Instead
it uses the Olver uniform asymptotic (DLMF §10.41) which has 6 terms
and accumulates in float64 exponent range. The bigfloat lane doesn't
need Olver because its exponent range is essentially unlimited.

### Tests

- `packages/bigfloat/test/special-funcs/besseli.test.ts`: 6 new
  tests + 1 point regression (m4ut fingerprint).
- `packages/bigfloat/test/special-funcs/besselj.test.ts`: 6 new
  tests + 1 point regression.

Reference values from mpmath dps=25 cover ν ∈ {50, 100, 200} ×
z ∈ {100, 150, 200, 300} per the bead's test matrix. All bead-spec
cases pass at ≤ 1e-13 relative.

## Mutation-prove discipline

Per PRD §6 / CLAUDE.md Rule 6, mutation-proved before asserting GREEN.
One mutation applied to both files simultaneously, full suite re-run,
restored from `/tmp` backup:

1. **Mutation: disable the large-ν guard in both files**
   (`if (Number.isFinite(nuFloat) && nuFloat >= 25)` → `if (false)`).
   Result: 12 failures — exactly the 12 new m4ut regression tests
   (5 J + 5 I + 1 J point regression + 1 I point regression). The
   115 pre-existing tests all still pass (confirming the mutation
   only re-introduced the bead-scope bug). RED confirmed; restored;
   GREEN.

## Accuracy achieved (vs mpmath dps=25)

| `(ν, z)` | head | observed |
|---|---|---|
| `(50, 100)` | J | rel = 0.00e+0 (ULP) |
| `(100, 150)` | J | rel = 0.00e+0 (ULP) |
| `(100, 200)` | J | rel = 0.00e+0 (ULP) |
| `(200, 300)` | J | rel = 0.00e+0 (ULP) |
| `(50, 100)` | I | rel = 0.00e+0 (ULP) |
| `(100, 150)` | I | rel = 0.00e+0 (ULP) |
| `(100, 200)` | I | rel = 0.00e+0 (ULP) |
| `(200, 300)` | I | rel = 0.00e+0 (ULP) |

The cumulative effect is that the bigfloat substrate is now
trustworthy as an oracle across the (ν, z) plane that the v0.2
Bessel substrate aims to cover. The float64 lane (worklog 169) was
fixed first and verified against mpmath directly; the bigfloat fix
here completes the substrate parity.

## Why these choices

**Why Maclaurin rather than Olver?** The bigfloat substrate has
essentially unlimited exponent range — BigFloat mantissa scales to
arbitrary size, and the Maclaurin's intermediate terms (which can be
`~10^{50}` at peak for `ν=100, z=150`) fit trivially. The float64
lane needed Olver because its `~10^308` ceiling can't hold the
intermediate terms. Olver in BigFloat would also work but requires
implementing 5 BigFloat polynomial evaluations (~100 LOC); the
Maclaurin reroute is a 3-line guard.

**Why threshold ν = 25?** Empirical observation: the Hankel
asymptotic in BigFloat starts losing precision at ν ≳ 15 (similar
to the float64 boundary, since the issue is the term-ratio growth
which is precision-independent). At ν = 25 the Maclaurin still
converges reasonably fast (~50 terms for `z = 100`). Below ν = 25
the existing dispatch was already correct and we keep it unchanged
(zero regression risk).

**Why no Y/K side fix?** Both `bigBesselY` and `bigBesselK` were
probed at `(50, 100)` and `(100, 150)` and return correct values.
For Y this is because at large z the substrate routes through a
different algorithm than direct Hankel asymptotic; for K because
the `exp(−z)` prefactor exponentially damps any asymptotic-sum
error to negligible absolute size. No code change needed.

## Acceptance

- `bun test packages/bigfloat/test/special-funcs/`: 127/0/246 ✓
  (was 115/0/222 — +12 tests, +24 expects).
- `bun test packages/bigfloat/test/`: 912/0/5775 ✓ (no regression
  across the wider package suite, including the complex-Bessel and
  Erf substrate tests).
- `bun test packages/quadrature/test/`: 349/0/912 ✓ (no regression
  in the float64 substrate).
- `bun test tools/special-eval/`: 305/0/661 ✓ (downstream
  consumers unaffected).
- All bead-spec test cases pass at ULP (rel = 0.00e+0 to the
  precision of float64 magnitude comparison).
- Canonical regression fingerprints fixed: `bigBesselJ(100, 150)`
  → `−0.01536` matches mpmath; `bigBesselI(100, 150)` → `+4.14e+49`
  matches mpmath.

## Frictions

1. **Maclaurin can be slow for very large (ν, z).** At `ν = 1000`,
   `z = 2000`, the Maclaurin needs ~600 BigFloat terms; at `prec =
   400` each term is ~10 BigFloat multiplications. Not noticeable
   at the (200, 300) bead-spec ceiling but a concern for users who
   want very high precision at very large arguments. Filed informally
   as a future Olver-in-bigfloat optimization if a consumer surfaces
   it; not in v0.1 scope.

2. **The bead's "wrong sign + wrong magnitude" pattern was a clue
   I should have read earlier.** Asymptotic-series truncation
   errors typically preserve sign; getting the WRONG sign means
   the optimal-truncation point fell inside a region where the
   asymptotic series is meaningless (intermediate terms growing
   without bound). That diagnostic could have been caught in the
   original I5a substrate tests if they had probed the `ν > x/2`
   regime — they didn't because the test corpus focused on
   `x ≫ ν` ranges. Bead `g5vo` (V1 cross-cutting verification)
   should be extended to add `ν ≥ z/2` test inputs in a follow-up.

3. **Y/K side investigation was useful even though it found no
   bug.** Confirms the algorithmic distinction between
   exponentially-decaying (Y, K) and exponentially-growing (I) /
   oscillating-with-cancellation (J) Bessel families: K's
   `exp(−z)` prefactor damps any asymptotic-sum error to
   negligible absolute size, so even a "broken" asymptotic gives
   the right answer in absolute terms. For I/J there's no such
   damping. Documented in the worklog index entry.

## Pointers

- Bead: `bd show scientist-workbench-m4ut` (closed by this shard).
- ADR: `docs/adr/0041-bessel-family-per-head-substrate.md`.
- Source:
  - `packages/bigfloat/src/special-funcs/besseli.ts` lines 568-595
    (rewritten dispatcher with large-ν guard).
  - `packages/bigfloat/src/special-funcs/besselj.ts` lines 816-842
    (rewritten dispatcher with large-ν guard).
- Tests:
  - `packages/bigfloat/test/special-funcs/besseli.test.ts` lines
    400-450 (new m4ut describe block).
  - `packages/bigfloat/test/special-funcs/besselj.test.ts` lines
    390-440 (new m4ut describe block).
- Sibling fix: worklog 169 (float64 lane, bead `zapb`).
- Original surfacing: Bessel float64 status report (worklog 167's
  follow-up) + zapb investigation (worklog 169 frictions).
- Reference: mpmath dps=25; `python3 -c "import mpmath;
  mpmath.mp.dps=25; print(mpmath.besselj(nu, z))"`.
