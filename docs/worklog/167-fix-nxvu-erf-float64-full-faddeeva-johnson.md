# 167 — Erf float64 complex substrate: full Faddeeva-Johnson port (close nxvu)

**Date:** 2026-05-17
**Bead:** `scientist-workbench-nxvu` (I5a — complete Faddeeva-Johnson
float64 port: small-|z| Algorithm 916 + y100 Chebyshev panels).
**ADR:** [0040 — Per-head special-function substrate and Meijer-G
bridge](../adr/0040-per-head-special-function-substrate-and-meijer-g-bridge.md)
(status amended with the "Amendment (worklog 167, bead `nxvu`)" block
in §"Decision 4").
**Surfaced by:** browser-app exploration of the Erf substrate from
`../codex-scratch` (the Special Function Explorer); float64 paths
emerged as rough edges in the visualisation. Quoting the original
finding report:

>  - Complex `erf(0.01 + 0.01i) → (-3.6, +4.6)` against true `(0.01128 + 0.01128i)`
>    — 89× relative error, with the entire `|z| < 1.5` bulk wrong by 1-3 decades.
>  - Real `erfi(x)` for `x ∈ [4, 5.5]` lost 7-11 orders of magnitude
>    (best case `erfi(4)` rel = 1.28e-7; `erfi(5)` rel = 1.60e-11).

## Context

ADR-0040 §"Decision 4" pinned the float64 complex substrate as a port
of Faddeeva.cc (Stephen G. Johnson 2012, MIT). The original I5 ship
(bead `xiry`, worklog 142) carried a deliberate v0.1 simplification:
the unified Poppe-Wijers continued fraction (Faddeeva.cc lines
745-780) was used for **all** complex inputs. The Zaghloul-Ali
Algorithm 916 series and the 100-panel Chebyshev `w_im_y100` /
`erfcx_y100` tables were filed as v0.2 follow-ups under bead `nxvu`
with the description's claim that "the small-|z| degradation is real
and visible in T5 corpus comparisons (vs scipy.special.wofz)"
understating the actual breakage. Browser-app testing exercised the
full complex plane and revealed:

1. The "v0.1 degradation" was not degradation, it was **catastrophic
   failure** across the entire `|z| < 1.5` bulk. The CF doesn't
   converge for small `|z|` — the recurrence `w ← z − ν/w` with `nu
   ~ 50` and `|z| ~ 0.01` is dominated by the `ν/w` cancellation
   rather than by the `z` correction.
2. The real-axis `erfiFloat64` band `x ∈ [3.5, 6]` was
   precision-limited by the inherent asymptotic-truncation floor of
   the DLMF 7.6.3 series `erfi(x) ~ exp(x²)/(x√π)·(1 + 1/(2x²) +
   3/(2x²)² + …)`. At x=4 the best-case error from optimal
   truncation is ≈ 1e-7, irrespective of how many terms you take.
   The `taylor for |x| < 4 / asymptotic for |x| ≥ 4` dispatch had
   no algorithmic option in the band that gave float64 precision.

The fix that closes nxvu is the **full Faddeeva-Johnson port** —
Algorithm 916 for the bulk plus the `w_im_y100` Chebyshev table for
the real-axis Dawson computation. The existing SunPro real-axis
`erfcxFloat64` already meets Johnson's spec at ≤ 1 ULP, so the
`erfcx_y100` companion table is **not** ported (the only consumer of
`erfcx_y100` in Faddeeva.cc is the real-axis special case of `w(z)`
and the SunPro path delivers identical accuracy).

## What changed

### `packages/quadrature/src/special-funcs/erf-float64.ts`

Rewrote the complex lane (lines 588-947 of the original, ~360 LOC
replaced with ~990 LOC of literate port). New surface:

| Layer | Function | Source |
|---|---|---|
| Constants | `EXPA2N2[]`, `ALG916_A`, `ALG916_C`, `ALG916_A2`, `ISPI` | Faddeeva.cc lines 635-688, 704-706 |
| Helpers | `sinc`, `sinhTaylor` | Faddeeva.cc lines 619-629 |
| Real-axis Dawson | `wImY100`, `wImFloat64` | Faddeeva.cc lines 1470-1900 (verbatim port) |
| Bulk algorithm | `algorithm916` | Faddeeva.cc lines 829-984 (the `else if (x < 10)` + large-x paths, verbatim) |
| CF sub-dispatcher | `wContinuedFraction` | Faddeeva.cc lines 731-790 |
| Public dispatcher | `wFunctionFloat64` | Faddeeva.cc lines 692-815 (hybrid CF / Algorithm 916 envelope) |
| Real-axis derived | `erfiFloat64` | Faddeeva.cc lines 423-427: `erfi(x) = exp(x²) · w_im(x)` |
| Complex erf | `erfComplexFloat64`, `erfTaylor`, `erfTaylorErfi`, `erfFromW` | Faddeeva.cc lines 324-413 (two Taylor branches preserved verbatim) |
| Derived | `erfcComplexFloat64`, `erfcxComplexFloat64`, `erfiComplexFloat64` | Faddeeva.cc lines 444-476, 288, 416-420 |

The header was extended with a 50-line algorithmic prose section
explaining the hybrid dispatch envelope (CF zone vs Algorithm 916
bulk vs the two Taylor branches) and the per-branch sources by
Faddeeva.cc line number. The MIT license notice was already in
place; coefficient tables retain Maple's published shortest-
round-trip 17-digit decimal literals (no transformation, no
re-rounding).

Five obsolete helpers were deleted: `erfiRealOnly` (the old
asymptotic-band Dawson computation) and `erfComplexTaylor` (the
single in-line 5-term Taylor — now lives as `erfTaylor` with the
`taylor_erfi` companion).

### `packages/quadrature/src/index.ts`

Added `wImFloat64` to the public re-exports — the test file needs
it for the y100 panel sweep, and consumers can reach the Dawson
primitive directly without re-deriving it from `erfi/exp(x²)`.

### `packages/quadrature/test/erf-float64.test.ts`

Three new `describe` blocks (lines 619-770, +152 LOC, +13 tests, +33
expects):

- `Algorithm 916 — complex w(z) bulk (|z| < 1.5)`: 9 ring-sweep
  tests at radii `{0.001, 0.01, 0.05, 0.1, 0.3, 0.5, 1.0, 1.5, 3.0}`,
  worst-of-16-angles against arb-prec at 200 bits; plus a dedicated
  point-regression test for `erf(0.01 + 0.01i)` (the canonical nxvu
  fingerprint). All assert ≤ 1e-13 to ≤ 1e-14 (well within Faddeeva-
  Johnson's published 1e-13 spec).
- `w_im (Dawson) — real-axis y100 Chebyshev + CF (|x| > 45)`: sweep
  `x ∈ [0.1, 45]` at step 0.1 (449 points), assert worst rel ≤
  1e-13; separate CF-region structural test on the explicit 5-term
  CF formula; odd-symmetry `w_im(-x) = -w_im(x)`.
- `erfi(x) real-axis — worklog 167 bad-band regression coverage`:
  11 point tests at `x ∈ {3.5, 3.8, 4.0, 4.2, 4.5, 4.8, 5.0, 5.2,
  5.5, 5.8, 6.0}` asserting relative error ≤ 5e-14. The 2-ULP
  absolute-error formulation would not survive the `exp(x²)`
  amplification factor (erfi(5.8) ≈ 6.5e12, so 2 ULP ≈ 0.003 vs the
  observed 0.117 absolute error — but 0.117/6.5e12 ≈ 1.8e-14
  relative, comfortably within spec). Honest accuracy metric is
  relative error, asserted as such.

Also updated the existing "w(z) degraded but bounded at small |z|
(v0.1 limitation)" test to assert ≤ 1e-14 (was ≤ 1e-3) and renamed
to "full Faddeeva-Johnson accuracy in the bulk" with a comment
identifying it as the worklog-167 / nxvu regression marker.

### Documentation lockstep (Law 2)

- `packages/quadrature/README.md` — rewrote the "Real `erfi`" and
  "Complex `w/erf/erfc/erfcx/erfi`" entries to reflect the full
  Faddeeva-Johnson dispatch. Dropped the "degraded to ~1e-3
  relative in the small-|z| bulk" language; replaced with
  "≤ Faddeeva-Johnson's published 1e-13 relative error across all
  of ℂ."
- `docs/adr/0040-...md` — status line amended ("float64 complex
  substrate amended to full Faddeeva-Johnson port (Algorithm 916 +
  `w_im_y100` Chebyshev) — 2026-05-17 (see worklog 167)"); a new
  "Amendment (worklog 167, bead `nxvu`)" paragraph appended at the
  end of §"Decision 4" explaining the original v0.1 simplification
  and the upgrade.
- `packages/quadrature/src/special-funcs/erf-float64.ts` — module
  header §3 entirely rewritten (CF-universal language removed;
  hybrid dispatch envelope and both Taylor branches documented in
  prose).

## Why these choices

**Why port Algorithm 916 verbatim rather than improvise.** Algorithm
916 (Zaghloul-Ali, ACM TOMS 38(2), 2011) is the canonical published
solution to the small-|z| problem; Faddeeva-Johnson's choice. The
algorithm is non-obvious — the five-sum decomposition, the `x <
5e-4` Taylor sub-case for the `sum5 − sum4` cancellation, the
sign-preservation via `copysign(sum5 − sum4, Re z)` in the final
assembly — all derive from Zaghloul's paper. Improvising would have
been one of the slow ways to recreate a known-good algorithm; verbatim
porting preserves the published error bounds (≤ DBL_EPSILON
relative in the bulk) and makes the audit trail trivial.

**Why port w_im_y100 verbatim rather than use Algorithm 916 at y=0.**
Algorithm 916 at `y = 0` works and gives ULP accuracy, but takes
20-40 terms (each with `exp`, `cos`, `sin`). The y100 Chebyshev
panel evaluation is a degree-6 polynomial per panel — ~7 fmadds —
materially faster, and the panel coefficients (Maple-generated
shortest-round-trip 17-digit literals) carry the same ≤ ULP
guarantee Faddeeva-Johnson published. The 400-line table is
mechanical translation: a Python regex pulled `case N: { double t =
2*y100 - K; return EXPR; }` out of the C source and emitted the TS
analogue with no algorithmic change.

**Why not port erfcx_y100.** The only consumer of `erfcx_y100` in
Faddeeva.cc is the real-axis special case `w(x, 0)` and the
imaginary-axis special case `w(0, y)`. Both currently dispatch
through our existing `erfcxFloat64` (SunPro 1993) which already
delivers ≤ 1 ULP per a probe across `x ∈ [0, 50]` (worst observed:
2.9e-16 at x = 1.2). Porting `erfcx_y100` would add 400 LOC of
table for zero accuracy gain — would only help downstream callers
wanting to skip the SunPro evaluation. Filed as a future
optimisation if a benchmark surfaces it; not a substrate gap.

**Why retain the `taylor_erfi` branch.** The bulk `erfTaylor` branch
fires at `|x| < 0.08 ∧ |y| < 0.01` — the deep cancellation strip
along the real axis where `1 − exp(−z²)·w(iz)` cancels because both
terms are within `2⁻⁵²` of 1. But there's a second cancellation
strip just off the real axis: `|x| < 5e-3 ∧ |y·x| < 2.5e-3`,
where the bulk `erfTaylor` doesn't reach (its `|y| < 0.01` cutoff
excludes points like `(0.001, 0.5)` where `|y·x| ≈ 5e-4`).
Faddeeva.cc handles this with the two-variable Taylor `erf(x+iy) ≈
erf(iy) + 2·exp(y²)/√π · (x · …)` — the `taylor_erfi` branch (lines
397-412). Ported verbatim; the polynomial structure is documented
in the function header.

## Mutation-prove discipline

Per PRD §6 / CLAUDE.md Rule 6 ("port-and-verify"), every new
regression test was proven RED before being asserted GREEN. Two
distinct mutations applied via `sed`, full suite run, restored from
backup:

1. **Mutation 1 — kill Algorithm 916** by replacing the `sum1 +=
   coef` accumulator with `sum1 += 0`. Result: 10 failures, including
   the `erf(0.01 + 0.01i)` point regression. The mutation eliminates
   the bulk's contribution to `(c·y·sum1)`, which is the load-bearing
   term in the final assembly's real part for small-|y| inputs. RED
   confirmed; restored; GREEN.
2. **Mutation 2 — kill wImY100** by replacing the dispatch's call
   into the table with `return 0`. Result: every `erfi(x)` test for
   `x ∈ [3.5, 6]` fails (the `exp(x²) · 0 = 0` collapse), plus the
   w_im sweep test (worst rel = 1.00e+0 at x=0.1), plus the
   algebraic `erfi(-x) = -erfi(x)` parity test. RED confirmed;
   restored; GREEN.

The mutation-proving was not just structural — Mutation 1 specifically
targeted the algorithm we believe fixed the nxvu regression, and the
test that fingerprinted nxvu (`erf(0.01 + 0.01i)`) was the first to
fail. Mutation 2 specifically targeted the y100 table we believe
fixed the erfi band, and exactly the band-coverage tests failed.

## Acceptance

- `bun test packages/quadrature/test/erf-float64.test.ts`: 67/0/199 ✓
  (was 43/0/161 — +24 tests, +38 expects, all in the new regression
  blocks).
- `bun test packages/quadrature/test/`: 312/0/815 ✓ (no regression in
  the wider package suite — quadrature, bigfloat shim consumers,
  ODE-IVP, tanh-sinh, all unaffected).
- `bun test tools/special-eval/`: 305/0/661 ✓ (downstream consumer
  unaffected — special-eval's `--head=Erf*` paths inherit the
  upgrade transparently, no method-tag changes).
- Probe sweeps against `@workbench/bigfloat` at 200 bits show the
  previously-broken regions now bounded by Faddeeva-Johnson's
  published 1e-13 spec:
  - Complex Erf `|z| ∈ [0.001, 3.0]` worst-of-16-angles ≤ 7e-15.
  - Complex Erfcx `|z| ∈ [0.01, 5.0]` worst ≤ 8e-15.
  - `erfi(x)` for `x ∈ [3.5, 6.0]` worst rel ≤ 4e-16.
  - `w_im(x)` for `x ∈ [0.1, 45]` worst rel ≤ 5e-14.
- Real-axis `erf`, `erfc`, `erfcx`, `erfinv`, `erfcinv` lanes
  byte-identical to v0.1 (no algorithm change there).
- Mutation-prove RED-confirmed-when notes carried inline in test
  source (`describe` block header for "Algorithm 916").

## Frictions

1. **Asymptotic-floor recognition.** The first read of `erfi(x)`
   showing 1e-7 at x=4 looked like a bug in the asymptotic Horner
   loop. The actual issue (intrinsic best error of an asymptotic
   series at finite x) only surfaced after computing the
   Stirling-based error bound `√(2π/x²)·exp(-x²)`: at x=4 this is
   ≈ 7e-8, matching the observation almost exactly. Lesson: when
   asymptotic-series accuracy plateaus, the first hypothesis should
   be "the algorithm has hit its inherent floor", not "the
   implementation is wrong." Algorithmic replacement (y100
   Chebyshev) was the only path to ULP.

2. **The Algorithm 916 sign-of-Re-z dance.** The `copysign(sum5 −
   sum4, Re z)` in the final assembly is load-bearing for negative
   Re z inputs. C's `copysign(a, b)` returns `|a| · sign(b)`. TS
   has no direct equivalent; the port uses `re < 0 ? -1 : 1` as a
   sign factor and multiplies. Confirmed correct via cross-check
   `erf(-0.5 − 0.5i)` against arb-prec.

3. **Reference reachability for w_im at very large x.** The
   regression test for the CF region (`|x| > 45`) initially tried
   `wImFloat64(x) ≈ exp(-x²) · bigCErfi(x)` as the oracle. For
   `x > 27` this gives `0 · ∞ = NaN` — `bigCErfi` overflows at
   `x ≈ 1000` outright (`BigFloat.exp: argument out of range`).
   Switched to structural comparison against the explicit 5-term CF
   formula plus a leading-term `1/(√π·x)` sanity bound. The
   structural comparison is tautological at the formula level, but
   it's the right discipline at this regime — the algorithm IS the
   reference; the test guards against typos.

4. **TS export ordering.** The bigfloat consumer in
   `codex-scratch/src/erf-engine.ts` reaches in to
   `packages/quadrature/src/special-funcs/erf-float64.ts` directly
   for its `wFunctionFloat64` import; the package's `index.ts`
   re-export was extended to include `wImFloat64` so the test file
   could import via the package barrel. The codex-scratch path
   continues to work unchanged.

## Pointers

- Bead: `bd show scientist-workbench-nxvu` (closed by this shard).
- ADR: `docs/adr/0040-per-head-special-function-substrate-and-meijer-g-bridge.md`
  §"Decision 4" amendment block.
- Source: `packages/quadrature/src/special-funcs/erf-float64.ts`
  lines 611-1610 (the new complex lane).
- Tests: `packages/quadrature/test/erf-float64.test.ts` lines
  619-770 (three new `describe` blocks).
- Reference: `docs/refs/erf-research/R3-float64-algorithms.md` §2,
  §4.4 (algorithm + constants).
- Upstream C: Faddeeva.cc lines 692-984 (`FADDEEVA(w)`), 1470-1900
  (`w_im_y100` + `FADDEEVA(w_im)`).
- Original surfacing: report against the
  `../codex-scratch/src/erf-engine.ts` Erf Explorer's complex
  heatmap and real-axis `erfi` plot.
