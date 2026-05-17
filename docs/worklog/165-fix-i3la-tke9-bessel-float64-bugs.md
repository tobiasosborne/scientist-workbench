# 165 — Fix V1-found bugs: i3la (Y sign) + tke9 (I parity) in bessel-float64 (2026-05-17)

> **Scope.** Close two P1 follow-up beads filed by the V1 cross-cutting
> verification gate (worklog 164): `scientist-workbench-i3la`
> (`besselYFloat64` wrong sign at odd-half-integer ν) and
> `scientist-workbench-tke9` (`besselIFloat64` returns ±Infinity at
> negative integer ν ≥ 2). Both bugs scoped to the I5a float64
> substrate (`packages/quadrature/src/special-funcs/bessel-float64.ts`);
> the arb-prec substrates were verified correct by V1 (worklog 164
> §F1, §F2). Fixes are surgical (≤ 30 LOC delta total), backed by 9
> new regression tests, and the 9 XFAIL tests in the V1 cross-cutting
> suite are un-skipped — V1 suite goes from 240 pass / 9 skip / 0 fail
> to **249 pass / 0 skip / 0 fail**.

## Context

V1 worklog 164 §F1 and §F2 documented two real substrate bugs the
cross-cutting Wronskian (§(i)) and integer-ν parity (§(j)) invariants
caught. Both were scoped to the I5a float64 substrate; both were
filed as P1 follow-ups blocked by `rkoo` (the I5a bead). With the
epic-close D1 bead pending, these two fixes unblock the final V1
delivery (0 documented xfails in the cross-cutting suite).

The bead specs pinned both the diagnosis and the fix shape; this
shard implements them with the literate-programming discipline
CLAUDE.md Rule 10 requires (per-fix doc-comment expansions citing the
root cause and the V1 finding).

## What changed

### `packages/quadrature/src/special-funcs/bessel-float64.ts` (3 edits, ~30 LOC)

#### Fix 1 — `gammaSign` helper + uses in `besselJ_series` / `besselI_series`

Root cause of i3la: the ascending-series leading factor
`(z/2)^ν / Γ(ν+1)` was computed as `Math.exp(ν·log(halfZ) −
logGamma(ν+1))`. `logGamma` returns `log|Γ|` (its reflection-formula
branch wraps `sin(π·z)` in `Math.abs` — the conventional definition),
so the leading factor lost the sign of Γ whenever ν+1 < 0 with
|Γ(ν+1)| < 0. Concretely:

- `J_{−1.5}(z)`: `logGamma(−0.5)` returns `log(2√π) ≈ 1.265` —
  correct for `log|Γ(−0.5)|`. But Γ(−0.5) = −2√π is **negative**;
  the series result was off by a sign.
- The connection formula `Y_ν = (J_ν·cos(νπ) − J_{−ν}) / sin(νπ)` at
  ν = 1.5 reduces to `Y_1.5 = J_{−1.5}`, so the wrong sign on
  `J_{−1.5}` propagated to `Y_1.5`. Same for `Y_3.5 = -J_{-3.5}`.
- ν ∈ {0.5, 2.5, 4.5, …} were unaffected because Γ(1.5), Γ(3.5), …
  are all positive — the sign drop only fires at odd-half-integer ν
  where the gamma argument lands on (−1, 0), (−3, −2), … (intervals
  with negative Γ).

The fix is a tiny `gammaSign(x)` helper that returns sign(Γ(x)) for
non-integer x by exploiting the reflection identity
`sign(Γ(x)) = sign(sin(π·x))` for negative non-integer x — implemented
as a bottom-bit parity check on `Math.floor(x)`. Both
`besselJ_series` and `besselI_series` multiply their `lead` by
`gammaSign(ν+1)`. Integer ν is unreachable here (those route to
SunPro/Cephes paths upstream).

Subtle JS gotcha: `Math.floor(-0.5) & 1` is `1` (because `-1` in
32-bit two's complement has the low bit set), `Math.floor(-1.5) & 1`
is `0`, `Math.floor(-2.5) & 1` is `1`. So the right test is
`(floor & 1) === 1 ? -1 : 1` — a sign-table walk would have
mis-derived it. Verified directly against `mpmath.gamma` at ν+1 ∈
{−0.5, −1.5, −2.5}.

#### Fix 2 — top-of-dispatcher reflection in `besselIFloat64`

Root cause of tke9: `besselI_real_general` integer-ν shortcuts
handled only ν ∈ {0, ±1}; ν ≤ −2 fell through to the ascending
series, where `Γ(ν+1)` hits a pole and the result blew up to ±Infinity.
DLMF §10.27.1 specifies `I_{−n}(z) = I_n(z)` for **all** integer n
(no sign flip — `I` is even in ν at integer order). Fix mirrors the
existing ν=±1 special case at the public-entry level:

```ts
if (Number.isInteger(nu) && nu < 0) return besselI_real_general(-nu, z);
```

One line, localised, only affects the previously-broken case.
Verified `I_{−2}(5) === I_2(5)` (byte-identical, not just close), and
same for n=3, 5.

### `packages/quadrature/test/special-funcs/bessel-float64.test.ts` (+9 tests)

New `describe("V1 cross-cutting regressions (i3la, tke9)")` block
with 9 tests:

- 4 for i3la: `Y_{1.5}(5)`, `Y_{3.5}(10)`, `Y_{1.5}(2)` matching the
  Arb gold within 1e-12 (`toBeCloseTo(value, 12)`); the root-cause
  test `J_{-1.5}(5)` at the same tolerance; a no-regression check
  that `Y_{0.5}(5)` and `Y_{2.5}(5)` (the even-half-integer ν that
  was *never* broken) still match within 1e-12.
- 4 for tke9: `I_{-2}(5) === I_2(5)`, `I_{-3}(5) === I_3(5)`,
  `I_{-5}(5) === I_5(5)` (byte-identical parity), and a finiteness +
  closeness check on `I_{-2}(5) ≈ 17.5056`.

Tolerance choice: `toBeCloseTo(..., 12)` rather than ULP-bounded
because the general-ν Y path goes through divisive cancellation in
the connection formula, which has a documented ~1e-12 ceiling at
v0.1. The bug under test was a SIGN flip (gross error), so the right
invariant is "matches Arb to 12 dp", not "within 8 ULPs".

### `tools/special-eval/bessel-cross-cutting.test.ts` (3 edits)

- Updated the ν=2.5 Wronskian sample header comment (no longer a
  documented gap — sw-i3la closed).
- Un-skipped the 3 i3la `test.skip(...)` calls (ν=2.5 Wronskian at
  z ∈ {1, 5, 10}) → regular `test(...)`. Renamed prefix from
  `XFAIL (sw-i3la): ...` to `... within 1e-13 (sw-i3la fix)`.
- Replaced the 6 tke9 `test.skip(...)` calls (`I_{-n}(z) = I_n(z)`
  for n ∈ {2, 3, 5} × z ∈ {1, 5}) by folding n=1 and n ∈ {2, 3, 5}
  into a single loop — total 8 tests, all running, all green.

V1 cross-cutting suite final tally: **249 pass / 0 skip / 0 fail /
541 expect() calls** (was 240/9/0/532 at end of worklog 164).

## Why these choices

### Minimal-blast-radius fixes — no refactor

The bead specs explicitly said "targeted changes — do NOT refactor
unrelated code in bessel-float64.ts." The two fixes touch exactly
three locations: one new helper (`gammaSign`), two `lead = ...` lines
(adding the `gammaSign(nu+1) *` factor), and one one-line check at
the top of `besselIFloat64`. Total LOC delta ~30 (most of which is
the literate-programming doc-comments per Rule 10).

### `gammaSign` helper rather than fixing `logGamma`

I considered fixing `logGamma` to return signed `logΓ` (or returning
`(log|Γ|, sign(Γ))`), but the change is a wider invariant break —
every existing caller assumes `logGamma` returns `log|Γ|` (the
mathematical-library convention). A scoped helper used only at the
two known-broken call sites is safer and the literate-programming
comment makes the convention explicit.

### Test tolerance: `toBeCloseTo` not `ulpDiff`

The half-integer Y values go through divisive cancellation (the
connection-formula denominator `sin(νπ)` is ±1 at half-integer ν,
but the numerator J_ν·cos(νπ) − J_{−ν} loses several decimal digits
to cancellation). Existing T2/T3-tier ULP budgets in this file are
8-12; at ν=3.5, z=10 the Arb-vs-float64 disagreement is ~5e-15
absolute (~197 ULPs of the small Y value). Pinning to 12 dp via
`toBeCloseTo` captures the sign-restoration invariant the test
exists for, without coupling to a ULP budget that the substrate's
general-ν path doesn't promise.

## Frictions surfaced

### F1 — Sign-derivation slip in `gammaSign`

First version of `gammaSign` had the parity inverted (returned `+1`
where `-1` was correct). Caught immediately by re-running the J_-1.5(5)
sanity probe — output was still wrong-sign, even though `gammaSign`
had been added. The derivation slip: `Math.floor(-0.5) = -1`,
`-1 & 1 = 1` in JS (two's-complement low bit). The wrong branch was
`(floor & 1) === 0 ? -1 : 1`; the correct one is the *opposite*
mapping. Re-verified against `mpmath.gamma(-0.5)` and corrected.
Lesson reinforces CLAUDE.md Rule 3 ("skepticism" — verify against
the oracle, not against your derivation).

### F2 — Existing connection-formula tolerance limit

The Y_{3.5}(10) value via the connection formula is only good to
~12-13 dp; the I5a substrate's general-ν Y path doesn't promise more.
The V1 test (`tools/special-eval/bessel-cross-cutting.test.ts`) was
already using a 1e-13 absolute tolerance via `Math.abs(lhs - rhs)`
which is the right shape; only the regression-test tolerance in
`bessel-float64.test.ts` needed adjustment from ULP-bounded to
absolute-bounded. No substrate change needed — the bug was the sign
flip, not the precision.

## Acceptance

- [x] Fix 1 (`gammaSign` + uses) shipped in `packages/quadrature/src/
  special-funcs/bessel-float64.ts` — minimal targeted change.
- [x] Fix 2 (top-of-dispatcher reflection in `besselIFloat64`) shipped
  — one-line guard.
- [x] 9 new regression tests in `bessel-float64.test.ts`, all named
  with the closing bead-id (`i3la:` / `tke9:` prefix); 78 / 0 fail.
- [x] All 9 XFAIL tests in `tools/special-eval/bessel-cross-cutting.
  test.ts` un-skipped; 249 / 0 fail / 0 skip.
- [x] `bun test packages/quadrature/test/` — 288 / 0 fail (all
  quadrature tests still green; no regression elsewhere).
- [x] `bun test tools/special-eval/bessel-cross-cutting.test.ts` —
  249 / 0 / 0 / 541 expects (was 240 / 9 / 0 / 532 at worklog 164).
- [x] No `bun run check` (per orchestrator instruction — run post-merge).

## Pointers

- Beads closed: `scientist-workbench-i3la` (P1, Y half-integer sign) +
  `scientist-workbench-tke9` (P1, I negative-integer parity).
- Parent V1 worklog: `docs/worklog/164-v1-bessel-cross-cutting.md`
  (§F1 + §F2 — discovery details).
- I5a substrate worklog: `docs/worklog/154-i5a-bessel-float64.md`
  (context for the file being fixed).
- ADR-0041: `docs/adr/0041-bessel-family-per-head-substrate.md`.
- V1 cross-cutting test: `tools/special-eval/bessel-cross-cutting.test.ts`.
- Regression tests: `packages/quadrature/test/special-funcs/bessel-
  float64.test.ts` §3a.
- Next: D1 (epic close + docs lockstep finalisation, bead is the
  last open Phase 4 item for the Bessel epic).
