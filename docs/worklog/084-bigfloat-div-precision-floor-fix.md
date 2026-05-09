# 084 — bigfloat `div` precision-floor fix (`scientist-workbench-djp`)

**Date:** 2026-05-09
**Beads:** `scientist-workbench-djp`
**Status:** Closed; substrate fix landed in
`packages/bigfloat/src/arithmetic.ts`. The integrand-contract docstring
on `tanhSinhAdaptiveBF` is downgraded from a load-bearing invariant to
a stylistic recommendation.
**Related:** worklog 077 (the tanh-sinh fix that diagnosed the bug at
the substrate level but worked around it at the integrand level —
filing the substrate fix as `djp`); worklog 075 (the WIP shard whose
hypothesis enumeration missed the substrate); ADR-0020 (the
arbitrary-precision determinism contract this fix preserves).
**Reference:** `packages/bigfloat/src/arithmetic.ts:81-130` (the new
`div`); `packages/bigfloat/src/types.ts:73-132` (`normalise`, the
function whose zero-padding made the floor silent).

## Context

Worklog 077 closed bead `6f8` (the tanh-sinh stall) by adding a
load-bearing integrand-contract docstring on `tanhSinhAdaptiveBF`:
"every BigFloat constant inside the integrand MUST be constructed at
the working precision (`fromInt(N, p)`, not `fromInt(N)`)." The
worked example was

```ts
// CORRECT
const f = (x, p) => div(fromInt(1n, p), add(fromInt(1n, p), mul(x, x, p), p), p);
// WRONG — silent precision floor at ~16 dps regardless of `p`
const fBad = (x, p) => div(fromInt(1n), add(fromInt(1n), mul(x, x, p), p), p);
```

The "WRONG" form floored `1/(1+x²)` at ~16 dps because the substrate's
`div(a, b, prec)` sized its working bits as `prec + 32` *unconditionally*,
ignoring the bit-length differential between `a.mantissa` and `b.mantissa`.
When `bitLength(a.mantissa) = 53` (the default `fromInt(1n)` precision
attribute) and `bitLength(b.mantissa) ≈ 200+` (a hi-prec divisor), the
integer quotient `(a.mantissa << workingBits) / b.mantissa` came out
with only `bitLength(a) + workingBits − bitLength(b) ≈ 85` honest bits.
`normalise` then zero-padded that to the requested `prec`, so the
returned BigFloat had `precision: prec`, mantissa with exactly `prec`
bits set high — but its trailing bits were silent zeros, not honest
digits of `1/x`.

The bead spec captures the diagnosis (the worked example: `div(fromInt(1n),
fromInt(7n, 200), 200)` returns ~26 dps when 60+ dps was requested) and
the proposed fix: "bump `workingBits` in `div` to `max(numeratorBits,
denominatorBits) + 32` (or similar bound)." This shard records the
substrate fix.

## What changed

### `packages/bigfloat/src/arithmetic.ts` — the div fix

The old formula:

```ts
const workingBits = prec + 32;
```

The new formula (with the differential compensation):

```ts
const numBits = bitLength(aAbs);
const denBits = bitLength(bAbs);
const lengthCompensation = denBits > numBits ? denBits - numBits : 0;
const workingBits = prec + 32 + lengthCompensation;
```

The derivation, written into the function's literate prose: the
integer quotient `q = (aAbs << w) / bAbs` has bit length ≈ `numBits +
w − denBits`. To deliver a quotient with at least `prec + 32` honest
bits, we need `w ≥ prec + 32 + denBits − numBits`. The unconditional
`max(0, …)` clamp ensures we never *reduce* the shift below the
original `prec + 32` floor, which preserves byte-identical output for
every previous call where `numBits ≥ denBits`.

Why the differential form, not the bead-spec's `max(numBits, denBits,
prec) + 32` form? The max-based form *over-shifts* in the case where
both `numBits` and `denBits` exceed `prec` — the result still has
≈ `numBits + 32` bits, not `prec + 32`. The differential form hits
exactly `prec + 32` honest bits, which is what the safety margin was
designed for. The bead's spec was a sketch; the verbatim formula
under-specifies the fix. (See §"Frictions surfaced".)

The function's prose was rewritten to explain the new formula and
explicitly state that the determinism contract (ADR-0020) is
preserved: `bitLength` on a `bigint` is bit-deterministic by JS
language spec, so the fix introduces no platform-conditional
behaviour. Same input bytes → same `workingBits` → same quotient →
same output bytes, on any runtime, on any platform, forever.

### `packages/bigfloat/test/arithmetic.test.ts` — 7 djp regression tests

All seven sit inside the existing `describe("div", …)` block, after
the original four. Coverage:

1. **Worked example from worklog 077.** `div(fromInt(1n), fromInt(3n,
   213), 213)` matches `1/3` to 60 dps. (Pre-fix this returned
   `0.33333333333333333333333332902510097…` — silent floor at ~26 dps.)

2. **`1/7` at prec=664 (~200 dps).** `div(fromInt(1n), fromInt(7n,
   664), 664)` matches mpmath's `1/7` to 60 dps.

3. **Symmetric case (hi-prec numerator, low-prec denominator).** This
   case was *not* affected by the bug (the quotient was naturally long
   enough); the test guards against a future "fix" that perturbs the
   short-numerator path while breaking the long-numerator path.

4. **Byte-identity: low-prec and hi-prec dividends produce
   bit-identical results.** This is the central behavioural contract
   `djp` lifts: `div(fromInt(1n), den, p)` and `div(fromInt(1n, p),
   den, p)` must produce byte-identical canonical output. Pre-djp they
   diverged in the low bits.

5. **Cross-validation against `pi(prec)`.** `div(fromInt(1n), pi(664),
   664)` matches mpmath's `1/π` to 60 dps. Independent oracle (mpmath
   strings are external truth).

6. **Shape invariant.** For `prec ∈ {53, 100, 200, 500, 1000}`,
   `div(fromInt(1n), fromInt(7n, prec), prec)` returns a BigFloat with
   `precision === prec` and `bitLength(mantissa) === prec`. The shape
   invariant was satisfied pre-fix too (which is what made the floor
   silent); the test guards against future regressions of the shape.

7. **Determinism check (1000 iterations).** Same input, repeat 1000
   times, verify byte-identical output every time. ADR-0020's
   bit-identity-cross-platform-forever contract.

### `packages/quadrature/test/tanh-sinh-bf.test.ts` — 1 djp regression

A new test inside the existing `1/(1+x²)` describe block:
`∫_0^1 1/(1+x²) dx = π/4 at 100 dps with default-precision integrand
constants`. The integrand uses `fromInt(1n)` (53-bit default) inside
both `add` and `div` — the "WRONG" form per worklog 077's docstring.
Pre-djp this looped at maxLevels with `converged: false` (mutation M4
in worklog 077). Post-djp it converges normally to π/4 at the
requested 100 dps.

### `packages/quadrature/src/tanh-sinh-bf.ts` — integrand-contract demoted

The docstring on `tanhSinhAdaptiveBF` previously carried a
load-bearing "Integrand contract" warning with CORRECT and WRONG
worked examples. Post-djp the warning is downgraded to an "Integrand
convention (recommended; no longer load-bearing post-djp)" recommendation.
The historical-note paragraph at the bottom of the docstring documents
the worklog-077 → worklog-085 chain so future agents can trace the
diagnosis. The `@param f` JSDoc line now reads "Idiomatic style is
`fromInt(N, prec)`; the substrate handles `fromInt(N)` correctly post-djp."

## Why these choices

### Differential form, not max-based form

The bead spec suggested `workingBits = max(numBits, denBits, prec) +
32`. I rejected this in favour of `prec + 32 + max(0, denBits −
numBits)`. The two agree when `numBits + 32 ≤ denBits` (the case the
bug bites in) but diverge when `denBits ≤ numBits`:

* Differential form: `workingBits = prec + 32`, so quotient bits ≈
  `numBits + (prec + 32) − denBits` ≥ `prec + 32`. Honest by at least
  the safety margin.
* Max-based form: `workingBits = numBits + 32`, so quotient bits ≈
  `numBits + (numBits + 32) − denBits = 2·numBits + 32 − denBits`. If
  `numBits = 1000` and `denBits = 53`, the quotient gets ~1979 bits of
  working room then is rounded back to `prec` bits by `normalise`.
  Wasteful.

The differential form is the *minimum sufficient* shift; the max-based
form over-shifts in the long-numerator case. Both deliver ≥ `prec + 32`
honest bits in the short-numerator case. I chose the minimum-sufficient
form because the BigInt shift is O(n) work and we don't want to pay for
unnecessary precision (especially in inner loops like tanh-sinh which
calls `div` per integrand evaluation).

### Tests in `arithmetic.test.ts`, not a new `div-precision.test.ts`

The bead suggested either location. I chose to extend the existing
`describe("div", …)` block because (a) it keeps all div tests in one
place for the next reader to find; (b) the comment block above the new
tests labels them "djp regression" so they're discoverable by grep; (c)
the existing test file already imports everything I need. Creating a
new file would add a second source of truth for "where do I read
about div's precision behaviour."

### `bitLength` from substrate, not recomputation

`packages/bigfloat/src/types.ts` exports `bitLength` (defined at line
51 of that file) as the canonical bit-length function. I re-used it
instead of computing `n.toString(2).length` inline. That keeps the
substrate's bit-determinism property (the comment on the existing
`bitLength` says "BigInt.toString(2) is well-defined and bit-
deterministic across runtimes") in one place.

## Frictions surfaced

### The bead's `max(numeratorBits, denominatorBits, prec) + 32` form is wrong

The bead spec line was

> Proper fix: bump workingBits in div to max(numeratorBits,
> denominatorBits) + 32 (or similar), so the quotient inherits the
> larger mantissa's precision.

Reading it carefully: this delivers ≈ `numBits + 32` quotient bits when
`numBits ≥ denBits + prec`, not the `prec + 32` the safety margin was
designed for. In practice the over-shift doesn't cause bugs (a longer
quotient just gets rounded to `prec` bits by `normalise`) but it's
wasteful work and obscures the invariant.

The differential form `prec + 32 + max(0, denBits − numBits)` is the
*correct* "minimum sufficient" formulation. The max-based form is a
valid sufficient condition but isn't tight.

This isn't a critique of the bead — the spec was a sketch with "or
similar" hedge — but a reminder that bead specs aren't always literally
right; one verifies by working through the math. (Law 3:
ground-truth-before-code applied at this layer too: I derived the
correct formula from the integer-quotient bit-length argument before
implementing, rather than trusting the bead spec verbatim.)

### Mutation-prove for nondeterministic perturbations is harder than expected

I tried four progressively-stronger nondeterministic mutations to
exercise the determinism test:

1. `+ (Math.random() < 0.001 ? 1 : 0)` to `workingBits` — passes (the
   sticky bit absorbs +1-bit perturbations).
2. `+ (Math.random() < 0.5 ? 1 : 0)` to `workingBits` — passes.
3. `+ (Math.random() < 0.5 ? 100 : 0)` to `workingBits` — passes.
4. `(Math.random() < 0.5 ? q | 1n : q & ~1n)` for the sticky bit —
   passes.

The "robustness" of `div` to small workingBits perturbations is a
*correctness property*: the safety margin and round-to-even mean that
small variations in the working precision are absorbed by the
post-`normalise` rounding. The test only triggered RED with a
50-bit-magnitude perturbation `q + (Math.random() < 0.5 ? 1n << 50n :
0n)` directly to the integer quotient.

This is fine — the determinism test guards against *observable*
nondeterminism in the *output*, and small-margin variations are *not*
observable in the output (that's by design). A future agent debugging
a "the determinism test passed, but I changed the implementation" case
should remember that round-to-even hides small perturbations; the test
is for *output* byte-identity, not internal computation byte-identity.

### `meijer-core/test/contour.test.ts` flake (still present, not caused here)

The same test that worklog 077 noted as a workspace-load timeout flake
is also flaky on this branch — it occasionally fails with `timed out
after 60000ms` under workspace test pressure. Not caused by these
changes (this bead only touches `packages/bigfloat/` and
`packages/quadrature/`); see worklog 077 §"`meijer-core/test/
contour.test.ts` flake under load" for the analysis. Flake budget,
not a regression.

## Acceptance

* ✓ Bead `scientist-workbench-djp` resolved. (No actual `bd close` —
  the beads DB is intentionally not bootstrapped in this worktree.)
* ✓ `packages/bigfloat/src/arithmetic.ts::div` — `workingBits` formula
  upgraded from `prec + 32` to `prec + 32 + max(0, denBits − numBits)`,
  with literate prose documenting the derivation.
* ✓ `packages/bigfloat/test/arithmetic.test.ts` — 7 djp regression
  tests added; full bigfloat suite goes from 229 → 238 tests
  (worklog 077's count was stale; new total is 238 + 7 = 245 tests
  in the suite, all pass).
* ✓ `packages/quadrature/test/tanh-sinh-bf.test.ts` — 1 djp regression
  test added; suite goes from 25 → 26 tests, all pass.
* ✓ All existing 25 tanh-sinh tests pass byte-identically (no
  regression on the principled integrand contract).
* ✓ `packages/quadrature/src/tanh-sinh-bf.ts` — integrand-contract
  docstring downgraded from load-bearing invariant to stylistic
  recommendation; historical note added pointing to worklog 084 (this
  shard) for the substrate-fix reference.
* ✓ Mutation-prove protocol exercised against three load-bearing
  invariants: M1 (revert fix entirely) → 4 RED; M2 (numerator-only
  compensation, the bead's wrong-suggestion form) → 4 RED; M3
  (50-bit nondeterministic perturbation) → 3 RED including the
  determinism test. All restored.
* ✓ `bun run check:quick` green at HEAD.

## Pointers

* Substrate: `packages/bigfloat/src/arithmetic.ts:81-130` — the new
  `div`, with literate prose at lines 73-130 explaining the derivation.
* Substrate type: `packages/bigfloat/src/types.ts:51-56` — the
  `bitLength` helper this fix relies on.
* Tests: `packages/bigfloat/test/arithmetic.test.ts:152-285` — the
  djp regression block inside `describe("div", …)`.
* Driver: `packages/quadrature/src/tanh-sinh-bf.ts:296-352` — the
  rewritten `tanhSinhAdaptiveBF` docstring.
* Quadrature regression test: `packages/quadrature/test/
  tanh-sinh-bf.test.ts:194-228` — the post-djp default-precision-
  integrand test.
* Bead body: `scientist-workbench-djp` (filed by worklog 077's
  closing commit; the body cites
  `packages/bigfloat/src/arithmetic.ts:92` as the fix point).
* Worklog 077: `docs/worklog/077-tanh-sinh-fixed.md` §"The actual
  diagnosis path" — the original diagnosis with the worked example
  this fix proves out.
