# 119 — `lgamma` / `gamma` real-argument near-pole reflection: zhrm's pair with oj5j

**Date:** 2026-05-15
**Bead:** scientist-workbench-zhrm (closes)
**Touches:** `packages/bigfloat/src/special.ts`,
`packages/bigfloat/test/special.test.ts`

## Context

`zhrm` was filed two days ago, during the `oj5j` fix (worklog 117), as
its real-argument sibling: the *complex* reflection paths
`clgammaReflect` and `cdigammaReflect` had been fixed by reducing
`z → ζ = z − m` before multiplying by π and bumping the working
precision by the measured cancellation depth `lossBits`. The
real-argument reflection in `packages/bigfloat/src/special.ts` —
`lgammaRealAbs`, plus `gamma`'s sign-detection on negative `z` — carried
the byte-identical latent bug. `oj5j` left it filed rather than
silently carried; this shard closes it.

## What changed

**One file: `packages/bigfloat/src/special.ts`. Two reflection paths
fixed.**

### `lgammaRealAbs` — port the `oj5j` reformulation

The reflection formula `log |Γ(z)| = log π − log |sin(π z)| − log Γ(1 −
z)` had the same two compounding cancellations the complex path did:

1. `π·z = π·m + π·ζ` formed at `work = prec + 32` truncated the `π·ζ`
   information (living `≈ −log₂|ζ|` bits below `π·m`);
2. `sin`'s `reduceModPiOver2` re-subtracted the large integer multiple
   of `π/2`, re-doing the same cancellation.

Fix is the direct port: reduce `z → ζ = z − m` *first* (`m = round(Re
z)`), bump `work` by the measured `lossBits = max(0, magBits(z) −
magBits(ζ₀))`, then form `sin(π · ζ)` on the reduced argument. Because
`log |·|` is sign-blind, the `(−1)ᵐ` from the identity `sin(π z) = (−1)ᵐ
sin(π ζ)` drops out — we just take `|sin(π ζ)|`. The `m = 0` region
(`z ∈ (−½, ½)`) is byte-identical to the pre-fix code by construction:
`ζ = z`, `lossBits = 0`, `work = prec + 32`. The `magBits` helper is a
local `zMagBits` mirror of the complex-side helper (no cross-file
plumbing for a trivial bit-length read).

### `gamma`'s sign detection — replace `sgn(sin(πz))` with the algebraic identity

This is the *more interesting* half of the fix, and not what `zhrm`'s
own description proposed. The pre-fix code computed `sgn(sin(πz))` at
`work = prec + 32` *purely to read its sign*. Near a pole, that
computation has two failure modes:

- the magnitude gets annihilated to zero by the same two cancellations
  above, and `sgn` returns 0;
- `gamma` then throws `RangeError: pole at z = ...` for an input that's
  merely *close to* but not at a pole — a false-positive pole, an
  honest-scope failure of a different shape than the `lgamma` digit
  loss.

The right answer is to never compute `sin` at all. The sign of
`Γ(z)` for `z < 0` is a structural fact about which integer interval
`z` lies in:

    sgn(Γ(z)) = sgn(sin(π z))
              = sgn((−1)ᵐ · sin(π ζ))           where z = m + ζ, m = round(z)
              = (−1)ᵐ · sgn(ζ)                  since |ζ| ≤ ½ ⇒ sgn(sin πζ) = sgn(ζ)

`m` is the rounded integer; `sgn(ζ)` is the sign of a real subtraction
`z − m`. Both are *exact*, computable in O(1) bit operations, with no
precision loss anywhere. The pole detection moves to the explicit
`isZero(ζ)` check it already needed; everything else falls out.

This is a TS-expert-want answer: the pre-fix code was using a numerical
hammer for a structural job. The replacement is shorter, exact, can't
spuriously throw, and is bit-faster (no `sin`, no `mul`, no
`pi(work)`). The fact that the bead description proposed only the
oj5j-style port — adequate but more work and only a partial fix — and
the algebraic identity emerged from looking at the code is the kind of
finding that makes the Two Laws (ground truth before code) worth
keeping.

## Why these choices

- **`zMagBits` local mirror of `magBits`.** The complex-side helper
  lives inside `complex.ts` as a static module-internal function (it's
  not exported). Re-exporting it just to read the bit-length of a real
  `BigFloat` would be cross-file noise for a 3-line helper; replicating
  the 3 lines is the cheaper hygiene choice. Both helpers' bit-length
  identity is identical — `exponent + bitLength(|mantissa|)` — and a
  divergence between them would only matter if both were maintained
  separately *and* either was performance-critical. Neither is.
- **`gamma`'s rewrite is the right scope creep.** Strictly,
  `zhrm`'s description named `lgammaRealAbs` as the bug. But the
  `sgn(sin(πz))` sign-detection is the same bug — same file, same near-
  pole cancellation, same "fail with a different shape" symptom. By
  Rule 2 (no bandaids, all bugs are deep) and given that the fix is
  *smaller* than the lgamma fix (5 lines instead of the reduction
  scaffolding), leaving it would be exactly the dishonest-scope
  pattern the rule forbids. Updated the bead's notes inline in the
  worklog and commit.
- **The real `digamma` reflection stub left alone.** Lines 313-340 of
  `special.ts` still contain a `digamma`-for-negative-z stub that
  throws `digamma: negative argument support deferred to v0.2`. It
  *contains* obviously latent code with the same near-pole pattern
  (`mul(piZ, z, work)`, `sin(piZ, work)`) including some literal dead
  placeholder. But it is gated behind an unconditional throw — there
  is no live execution path. Filling the stub is its own piece of
  work (`v0.2` per the existing comment); the near-pole correctness
  will naturally come along with whoever does that work, with the
  oj5j/zhrm template right there to copy. Touching it here would be
  scope creep into a different feature.

## Frictions surfaced

- **`toString(r, n)` returns `n` significant digits, not `n` after the
  decimal point.** I asserted the m=0 control value `lgamma(-0.3) ≈
  1.464840050857602507008478634780` (30 chars after the decimal) and
  got back the 29-char `1.46484005085760250700847863478` — the trailing
  zero was past the requested significance. A 5-second fix once
  measured, but a 60-second pause to realise that's what TS was telling
  me.
- **The bead description's diagnosis was incomplete.** It proposed
  porting the oj5j reformulation to `lgammaRealAbs` and noted that
  real `digamma`'s reflection was stubbed. It didn't flag `gamma`'s
  sign-detection as a separate failure mode — and that one is
  arguably *more* user-visible (a spurious throw, vs. a precision
  loss). The Two Laws caught it: opening the file and reading the
  whole reflection cluster top-to-bottom, rather than just jumping to
  the named function, surfaced the sibling bug. A subagent dispatched
  with the bead description alone would likely have missed it.

## Acceptance

- **`bigfloat` test suite: 267 pass / 0 fail** (was 257; +10 new in
  the `gamma / lgammaRealAbs — near-pole reflection precision (bead
  zhrm)` block). Four near-pole shapes (`m = -1, -3, -10`; including
  the `oj5j` `ε = 1e-69` witness scale) each assert *full requested
  precision* for `lgamma(z)` at 30 and 50 dps, *plus* an assertion
  that `gamma(z)` does not throw and matches the 160-dps reference.
- **Mutation-proven** (Rule 6):
  - revert `lgammaRealAbs` to the `πz`-first form → **6 of 10 RED**
    (every near-pole assertion at the precision-loss scale);
  - revert `gamma`'s algebraic sign-detection to `sgn(sin(πz, prec +
    32))` → the "does not throw spuriously" assertion RED (the deep
    near-pole cases hit the false-positive throw).
- **`m = 0` control pinned.** `lgamma(-0.3)` value asserted byte-
  precise at 30 dps — catches any unintended regression to the pre-fix
  path inside the `Re z ∈ (−½, ½)` region.
- **Exact-pole guard pinned.** `Γ(-2)` and `lgamma(-2)` both still
  throw `/pole/` — the reduction `ζ = z − m` puts integers exactly at
  `ζ = 0` and the explicit `isZero(ζ)` check catches them, *not* the
  pre-fix `eq(z, fromInt(BigInt(round(z)), z.precision))` round-trip.
- Full `bun run check` — green (see commit).

## Pointers

- `docs/adr/0020-arbitrary-precision-tier.md` — the `arbprec` tier this
  substrate underpins.
- `docs/worklog/117-cgamma-near-pole-reflection-fix.md` — `oj5j`, the
  complex-path sibling; the diagnosis there is the canonical
  reference for *why* this fix is shaped the way it is.
- `packages/bigfloat/src/special.ts` — `lgammaRealAbs` (the reduction),
  `gamma` (the algebraic-identity sign-detection), `zMagBits` (the
  local bit-length helper).
- `packages/bigfloat/test/special.test.ts` — the new `gamma /
  lgammaRealAbs — near-pole reflection precision (bead zhrm)` block.
