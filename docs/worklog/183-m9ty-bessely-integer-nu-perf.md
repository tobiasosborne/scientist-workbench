# 183 — bigBesselY integer-ν de-double-count (closes `m9ty`)

**Date:** 2026-06-26.
**Bead:** `scientist-workbench-m9ty` — *bigBesselY asymptotic-band test
timeouts under load (Y_1(10), Y_{-2}(1))*.
**Ground truth:** `packages/bigfloat/src/special-funcs/bessely.ts`
(the integer-ν limit-via-ε path), `docs/adr/0020-arbitrary-precision-tier.md`
(determinism contract), `docs/adr/0041-bessel-family-per-head-substrate.md`
§"Decision 3"/§"Decision 13" (the algorithm dispatch this code implements).

## Context

`bun test packages/bigfloat/test/special-funcs/bessely.test.ts` took
**45.7 s** for 30 tests; individual integer-ν asymptotic-band cases
(`Y_1(10)` ≈ 2.9 s, `Y_{-2}(1)` ≈ 1.8 s) brushed the 5000 ms default Bun
timeout under parallel load. Profiling at PREC_50DP = 200 bits showed the
**integer-ν path is ~10× slower than the non-integer path** (1.2–2.9 s vs
~190 ms per call) — not a load flake but a structural cost.

Root cause (Rule 2 — all bugs are deep). `bigBesselY` evaluates integer
ν via the connection-formula limit `Y_n = lim_{ν→n} (J_ν cos νπ − J_{−ν})
/ sin νπ`, perturbing `ν = n + ε` with `ε = 2^−(prec+32)` and boosting the
working precision to absorb the L'Hôpital cancellation. The bug:
`bigBesselYIntegerNu` boosted a local `work = 2·prec+96` *and then passed
`work` as the **output precision** argument to `bigBesselYConnection`*.
The connection's own measure-and-bump retry harness then sized its
first-pass working precision to `work0 = prec_arg + 32 + nearIntegerBits`
— with `prec_arg = work = 2·prec+96` and `nearIntegerBits = −magBits(ε) ≈
prec+32`, that is `work0 = 3·prec+160 ≈ 760 bits` at prec=200. The
`prec+32` L'Hôpital cancellation budget was counted **twice**: once in the
caller's `work` boost, once in the connection's `nearIntegerBits`. The
extra ~296 internal bits did *zero* work — measured `lossBits` was
identical (226–233) in both modes.

## What changed

**One-line dispatch fix** (`bessely.ts`, `bigBesselYIntegerNu`):

```diff
- const limit = bigBesselYConnection(nuExact, z, work);
+ const limit = bigBesselYConnection(nuExact, z, prec);
```

Pass the **original target `prec`**, not the boosted `work`. The
connection's retry harness then sizes `work0 = prec+32+nearIntegerBits ≈
2·prec+64 ≈ 464 bits`, absorbing the cancellation budget exactly **once**.
`nuExact = n + ε` is still constructed at the high `work` precision so ε is
not rounded away — only the *output precision demanded from the
connection* changed.

**Literate-header lockstep** (Law 2 / Rule 10). The "Working precision"
paragraph and the in-function comments previously described `work` as the
evaluation precision that "absorbs the L'Hôpital cancellation". That is now
false: `work` sizes only the *construction* of `ν = n + ε`; the
cancellation is absorbed inside `bigBesselYConnection`. The header was
rewritten to say who absorbs what, and to record the double-count as the
historical bug this shard fixed.

## Why these choices

**De-double-count, not a timeout bump.** The bead offered two paths —
speed up the hot path, or (if irreducible) raise the per-test timeout. A
genuine 3–4× win with byte-identical output makes the timeout bump the
wrong tool: the cost was *not* irreducible, it was double-counted. After
the fix every individual test runs in ≤ ~0.8 s standalone (≈ 2.3 s even at
3× contention) — comfortably under 5000 ms — so no timeout annotation was
added.

**`2·prec+64` is the floor for v0.1, not a number to shave further.** The
two `evalJAnyNu` calls (J_ν and J_{−ν}) are ~100% of the runtime; trig and
the final combine are < 1%. The `2×` factor is the irreducible L'Hôpital
tax of limit-via-ε: `prec+32` substrate + `prec+32` cancellation. The only
way below it is the v0.2 FLINT `Y_n(z) = −2 iⁿ K_n(iz)/π − …` rotation
(algebraic, no limit), which is blocked on `bigCBesselK` (I3b) and remains
filed under epic `zcam`.

**`besselk` is deliberately NOT given the same fix.** The header calls
`bigBesselYIntegerNu` a "mirror of `bigBesselKIntegerNu`", which made the
sibling the obvious next suspect. It is the wrong suspect. K's folded
connection puts `1/sin(νπ)` *inside* a huge term `B ≈ 2^(prec)` that is
then subtracted (`A − B`); sin's ~`prec`-bit relative error becomes an
**absolute** error that swamps the O(1) result — a *second* `prec`-sized
cancellation site the magnitude-based loss tracker cannot measure. K
genuinely needs ~`3·prec` internal bits; its caller's `work` boost
supplies the *unmeasured* budget and is load-bearing. Applying the naive Y
fix to K yields a wrong `K_1(1)` = 0.6146 (correct 0.6019). So no "besselk
has the same bug" bead was filed — the premise is refuted. (`besseli` has
no limit-via-ε path at all — closed-form parity + Maclaurin recurrence —
so it cannot share the bug.)

## Frictions surfaced

- **A red-team subagent left the one-line code edit applied** in the
  working tree (it was instructed to use throwaway scratch scripts).
  Verified via `git diff` that the residual change was *exactly* the
  intended `work → prec` edit and nothing else, and that all three
  reviewers had validated byte-identical output for precisely this change
  by calling the exported `bigBesselYConnection` directly (independent of
  the source dispatch line). Kept it; applied the header lockstep on top.
  Rule 3 in action — the diff was checked against the repo, not trusted.
- **The "mirror of besselk" framing nearly invited a misdiagnosis.** The
  adversarial reviewer that was charged with checking the sibling *refuted*
  the same-bug hypothesis with a concrete wrong-answer measurement. Had the
  fix been mirrored mechanically onto K "for consistency", it would have
  shipped a catastrophic correctness regression. The asymmetry (Y is a
  ratio of two equally-tiny quantities → one measurable cancellation site;
  K folds 1/sin into a subtracted giant → a second unmeasurable site) is
  now recorded in this shard so the next agent does not re-attempt it.

## Acceptance

- `bun test …/bessely.test.ts` (isolation): **45.7 s → 16.5 s**, 30 pass /
  0 fail. Worst standalone integer-ν call ≈ 0.77 s (was 2.9 s).
- Full `bun test packages/bigfloat/` (under load): **1185 pass / 3 fail /
  246 s** — all 30 `bessely.test.ts` tests pass under load (not in the fail
  list). The 3 failures are **pre-existing load-dependent timeouts in other
  files** (`bigCBesselY` T5 complex golden ≈ 5.0 s; `barnes-g`
  functional-equation ×2, ≈ 10.8 s / 5.9 s), not caused by this change —
  `barnes-g.test.ts` passes 24/24 in isolation (22.6 s), so they are
  full-suite parallel-contention flakes, not correctness failures. Filed as
  `scientist-workbench-sgec` (a separate class from m9ty: same
  brushing-the-5000ms-timeout symptom, different functions, not the same
  double-count — the red-team proved besselk's analogous boost is
  load-bearing, so each needs its own root-cause).
- **Byte-identical output**: red-team verified `ulpDiff = 0` at the full
  200-bit output (not merely ≤ 1 ULP) for all sampled integer-ν cases incl.
  the golden inputs and negative-parity `Y_{−2}(1)`; agreement holds at
  prec=400 (115 dp) and within 1e-40 of the first `Y_0` zero. No
  ADR-0020 violation (pure BigInt; only an integer working-precision
  parameter changed); no stored-golden break (the byte-exact tests are
  live-vs-live through the same path; goldens use ≥ 48 dp tolerance).
- **Mutation-proof (M3)**: perturbing `epsBits` from `prec + 32` to
  `⌊prec/2⌋ + 16` (the quadratic-ε budget) drove the integer-ν golden
  `T1-bessely-013` **RED at 35 dp** vs the required ≥ 48 dp — the test
  still catches an ε-budget regression on the path this shard touched.
  Restored → GREEN.
- `bun run check`: **109 passed / 7 skipped / 0 failed** (exit 0). The
  workspace `bun test` phase passed — the `sgec` timeouts are intermittent
  and did not fire this run (they fired only in the dedicated max-contention
  `bun test packages/bigfloat/` run above), confirming the load-dependent
  diagnosis.

## Pointers

- Fix + header: `packages/bigfloat/src/special-funcs/bessely.ts`
  (`bigBesselYIntegerNu`, the `bigBesselYConnection(nuExact, z, prec)`
  call + the "Working precision" header note).
- Sibling that does **not** get this fix, with the reason:
  `packages/bigfloat/src/special-funcs/besselk.ts` (`bigBesselKIntegerNu`
  → `bigBesselKFromConnection`); the A − B subtraction at `besselk.ts`
  ~447-472 is the second, unmeasurable cancellation site.
- Determinism contract: `docs/adr/0020-arbitrary-precision-tier.md`.
- Algorithm dispatch: `docs/adr/0041-bessel-family-per-head-substrate.md`
  §"Decision 3" / §"Decision 13".
- v0.2 follow-up (avoids the limit-via-ε tax entirely): FLINT K(iz)
  rotation, blocked on `bigCBesselK` (I3b), filed under epic `zcam`.
- Lineage: the limit-via-ε pattern came from I2b
  (`docs/worklog/157-i2b-bigbesselk-real.md`).
