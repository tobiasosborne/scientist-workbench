# 117 — clgamma / cdigamma near-pole reflection: catastrophic-cancellation fix (bead oj5j)

**Date:** 2026-05-14
**Bead:** scientist-workbench-oj5j (closes); scientist-workbench-zhrm (files — real-argument sibling)
**Touches:** `packages/bigfloat/src/complex.ts`,
`packages/bigfloat/test/complex.test.ts`, `packages/bigfloat/README.md`

## Context

`oj5j` was filed during the `7usr` diagnosis: `cgamma` (hence `clgamma`)
loses ~50 dps of working precision when evaluated near an integer pole.
The witness in the bead — `Γ(-1 − 2.32e-69)` at `workingBits = 458`
diverges from the 800-bit answer at digit 12. `@workbench/meijer-core`
had *worked around* it with the empirical precision estimator (worklog
085 / `7usr`): `achievedPrecision` is honestly reported as ~14 dps for
half-integer-spaced 2-pole cases instead of lying. Honest, but a
ceiling — the bead's thesis is that a *substrate* fix removes the
ceiling, lifting those same cases to 30+ dps.

The reflection branch `clgammaReflect` implements
`log Γ(z) = log π − log sin(π z) − log Γ(1 − z)` for `Re(z) < ½`. Γ's
poles are the non-positive integers, seen here through `sin(π z) → 0`.
The delicate regime is `z = m + ζ` with `m = round(Re z)` an integer
and `|ζ|` tiny.

## Root cause — two compounding cancellations

The pre-fix code formed `π·z` at a fixed `work = prec + 32` *before*
`sin`'s argument reduction:

1. `π·z ≈ π·m + π·ζ`. The `π·ζ` term lives `≈ −log₂|ζ|` bits *below*
   `π·m`. At `work = prec + 32` it is truncated away — the information
   is destroyed before `sin` is ever called.
2. `sin`'s own `reduceModPiOver2` then subtracts the large integer
   multiple of `π/2` from `π·z` — re-doing the exact same catastrophic
   subtraction.

Net loss `≈ (−log₁₀|ζ| − 9)` digits of the *requested* precision,
independent of how much precision the input `z` actually carried.
Confirmed empirically: `Γ(-1 − 1e-20)` agreed to only ~20 significant
digits at any requested `prec` — a flat ~10-digit loss, exactly the
32-bit `work` margin being entirely consumed by the cancellation.

`cdigammaReflect` (`ψ(z) = ψ(1 − z) − π cot(π z)`) carries the
byte-identical bug — `cot(π z)` has poles at the integers and the naïve
`cos(π z)/sin(π z)` truncates the same way.

## What changed

**Reduce `z → ζ` *before* multiplying by π.** Write `z = m + ζ`,
`m = round(Re z)`. The one unavoidable cancellation is now localised to
the single subtraction `ζ = z − m`; `π·ζ` is then formed directly from a
quantity that already has the right magnitude, so the `sin`/`cos` inside
`cexp` see a small angle and do no spurious reduction of their own. The
integer shift drops out by periodicity:

    sin(π z) = (−1)ᵐ · sin(π ζ)        cot(π z) = cot(π ζ)

**Bump the working precision by the measured cancellation depth.**

    lossBits = max(0, magBits(z) − magBits(zeta0))
    work     = prec + 32 + lossBits

`lossBits` is exactly how many leading bits `z − m` annihilates — so
after the bump `ζ` carries `prec + 32` good bits *below* the loss, and
everything downstream inherits them. The bump self-regulates: a
higher-precision input simply means `ζ` has more good bits to spare; an
input that does not carry `prec + lossBits` bits hits an honest ceiling
(it cannot manufacture precision the caller never supplied) rather than
lying.

**`m = 0` is byte-identical to the pre-oj5j code.** For
`Re(z) ∈ (−½, ½)` there is no integer to peel off: `ζ = z` (the same
object), `lossBits = 0`, `work = prec + 32`, and every downstream call
reproduces the old computation bit-for-bit. Only `Re(z) ≤ −½` arguments
— where the genuine cancellation lives — see new behaviour. This is the
deliberate minimal-churn choice (see below).

**Both reflection paths fixed.** `cdigammaReflect` got the identical
reformulation in the same edit — same file, same root cause; leaving
the byte-identical bug in the sibling function would be exactly the
bandaid Rule 2 forbids.

## Why these choices

- **Kept the `cexp(±iπζ)/2i` structure rather than introducing a proper
  `csin`.** A first-principles `csin(w) = sin(wᵣ)cosh(wᵢ) + i cos(wᵣ)sinh(wᵢ)`
  would be the more precision-robust primitive (it avoids the residual
  `exp(−x) − exp(x)` cancellation for tiny *imaginary* `ζ`). But it
  changes the arithmetic for *every* reflection input including `m = 0`,
  churning the most common path's goldens. The `cexp`-on-reduced-`ζ`
  form keeps `m = 0` bit-identical and confines all change to
  `Re(z) ≤ −½`. The residual `exp(−x) − exp(x)` cancellation is itself
  bounded by `−log₂|ζ|`, i.e. by `lossBits` — so the adaptive `work`
  bump already pays for it. A first-principles `csin` is filed thinking
  for the day the hot path genuinely forces it; it is not forced yet.
- **`work` base margin stays at 32.** Bumping the base to match the
  `prec + 96` Stirling path would have churned every `Re(z) ≤ −½` golden
  for no correctness reason — the structural fix is the `lossBits` term,
  not the base.
- **The real-argument path (`lgammaRealAbs`, `digamma` in `special.ts`)
  carries the identical latent bug but is left to a sibling bead
  (`zhrm`).** Different file, different golden-churn surface (the real
  `gamma` path), and `oj5j`'s stated acceptance is the *complex*
  meijer-core estimator. Honest decomposition, not scope creep.

## Frictions surfaced

- **The first reproduction script was ill-posed.** It constructed `z` at
  the *same* precision as the requested output, so the input never
  carried spare bits — and at 30 dps, `−1 − 1e-45` literally rounds to
  the pole `−1` and threw. That masked the *internal* loss behind a
  legitimate "input precision insufficient" ceiling. The bead's real
  scenario is a *high-precision* `z` with loss purely internal to the
  reflection branch; the corrected witness carries `z` at a high
  reference precision and varies only the requested output precision.
- **`docs/CLAUDE.md`'s "`bun run check` ~25s" is badly stale.**
  `packages/meijer-core/test/contour.test.ts` alone is **4m26s** on this
  box (arb-prec adaptive K-G quadrature, `cgamma` 4–8× per integrand
  point; the file already carries a 240s per-test timeout). The full
  `bun test` phase is minutes, not seconds. A `bun run check` that
  *looked* hung at 5 minutes was almost certainly progressing normally
  through contour — it was killed prematurely once before the real
  measurement was taken. Rule 3: measure, do not assume.
- **The `7usr` honesty-contract test over-achieved — the only test in
  the whole repo that the fix broke.** `slater.test.ts`'s
  "perturbation-driven case (`bm = [1/2, 3/2]`, `z = 3/2`) reports honest
  <50 dps" asserted `achievedPrecision < 50` — an assertion that
  *encoded the pre-oj5j ~14-dps ceiling*. With the substrate fixed, the
  two perturbation passes agree byte-wise, so the empirical estimator
  honestly reports the full 50-dps cap. This is the bead *succeeding*
  past its own "~14 → ~30 dps" acceptance criterion, not a regression —
  but it had to be verified, not assumed. Independent oracle: mpmath
  1.3.0 at `mp.dps = 120`, `meijerg([[],[]], [[1/2,3/2],[]], 3/2)` =
  `0.2360792489967351632828526287199412575064991060086073436674…` — the
  Slater value agrees to **≥ 54 digits**, so `achievedPrecision = 50` is
  genuinely honest. The test was re-pointed: it now asserts
  `achievedPrecision === 50` *and* cross-checks the value against the
  embedded mpmath oracle (proving the *value* is honest, not just the
  *number*). The `7usr` honesty contract kept its teeth — its
  anti-over-reporting witness moved from a now-stale end-to-end input to
  a direct unit test of `estimateAchievedPrecision` (now `export`ed):
  feed it two deliberately-disagreeing passes, assert it reports low.
  Mutation-proven — replacing the estimator body with the pre-`7usr`
  `return userPrecision` bug turns that guard RED.

## Acceptance

- `packages/bigfloat` — 257 tests pass (245 prior + 12 new). New block
  `clgamma / cdigamma — near-pole reflection precision (bead oj5j)`:
  five near-pole shapes (real `m=-1,-3`; complex `m=-1,-2`; the bead's
  `ε = 1e-69` witness scale) each asserted to deliver the *full*
  requested precision for both `clgamma` and `cdigamma`, plus an
  exact-pole-still-throws guard and an `m = 0` byte-identical-region
  check.
- **Mutation proof:** the pre-fix `πz`-first form collapses the
  `ε = 1e-69` cases to ~21 / ~41 agreeing digits at the 30 / 50 dps
  requests — a hard RED on every new assertion. Confirmed by the
  standalone witness during development before the regression block was
  committed.
- **Zero golden drift.** All 94 `oracle:` phases of `bun run check`
  pass unchanged — the `m = 0` byte-identical design held: every
  downstream meijer-g / hypergeometric / quadrature golden is untouched.
  The change is fully surgical; only `Re(z) ≤ −½` near-pole inputs see
  new (more accurate) behaviour, and no committed golden exercised one.
- `contour.test.ts` — **245 s**, 10/10 pass: *faster* than the 266 s
  pre-change baseline (run-to-run variance; no slowdown from the
  adaptive `work` bump — near-pole integrand points are rare on a
  pole-separated contour).
- The bead's acceptance metric — the meijer-core empirical estimator on
  the 2-pole half-integer witness `bm = [1/2, 3/2]`, `z = 3/2` rises
  from ~14 dps to the **full 50 dps**, *over-achieving* the bead's
  stated "~14 → ~30 dps" target. Verified honest against mpmath at 120
  dps (≥ 54-digit agreement) — see Frictions.
- Full `bun run check` — green; the one test the fix broke
  (`slater.test.ts`'s `7usr` over-achievement) re-pointed and
  re-verified, `bun test packages/meijer-core` 172/172 pass.
- Sibling bead `scientist-workbench-zhrm` filed for the identical latent
  cancellation in the real-argument path (`lgammaRealAbs`,
  `special.ts`) — out of scope for `oj5j` (different file, different
  golden surface), tracked rather than silently carried.

## Pointers

- `docs/adr/0020-arbitrary-precision-tier.md` — the `arbprec: true` tier
  this substrate underpins.
- `packages/bigfloat/src/complex.ts` — `clgammaReflect`,
  `cdigammaReflect` (the reformulation).
- `packages/bigfloat/test/complex.test.ts` — the regression block.
- `packages/bigfloat/README.md` § "Near-pole reflection precision" — the
  user-facing note, parallel to the `div` precision-floor section.
- `docs/worklog/084-bigfloat-div-precision-floor-fix.md` — the prior
  precision-margin fix in the same package; same shape of bug, same
  shape of fix.
- bead `scientist-workbench-zhrm` — the real-argument sibling
  (`lgammaRealAbs`).
