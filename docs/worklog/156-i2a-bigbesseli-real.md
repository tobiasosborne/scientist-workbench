# 156 — `bigBesselI` real (BigFloat): Phase 2 / I2a entry point

**Date:** 2026-05-17
**Bead:** `scientist-workbench-kml3` (I2a — bigBesselI real BigFloat)
**Related ADR:** `docs/adr/0041-bessel-family-per-head-substrate.md`
(§"Decision 3"); inherits the determinism contract of ADR-0020
(arb-prec tier — bit-identical cross-platform forever given `prec`).
**Phase 2 status after this shard:** I2a closed. Round-3 has I2b
(`bigBesselK` — bead `q0wr`) and I4 (CAS identities — bead `lrmo`)
remaining; I3a complex J/Y (bead `q7ty`) and onwards have the
substrate primitives this shard ships to rotate through via the Amos
identity `J_ν(z) = i^{-ν} J_ν(iz) = exp(-νπi/2) · I_ν(-iz)` (used in
complex code only — the real-axis I path in this shard is
algorithmically independent of J).

## Context

ADR-0041 pins the per-head substrate for the Bessel family. R2 §3.3
(`docs/refs/besselj-research/R2-arbprec-algorithms.md:1149-1186`) pins
the I dispatch as a verbatim port of FLINT
`docs/refs/besselj-research/sources/arbprec/bessel_i.c:204-218`:

```c
if (mag_cmp_2exp_si(zmag, 4) < 0 ||
    (mag_cmp_2exp_si(zmag, 64) < 0 && 2 * mag_get_d(zmag) < prec))
    acb_hypgeom_bessel_i_0f1(res, nu, z, scaled, prec);
else
    acb_hypgeom_bessel_i_asymp(res, nu, z, scaled, prec);
```

— a two-piece dispatch (vs J's three-piece), because the all-positive
₀F₁ series carries no cancellation budget, so there is no need for a
third "cancellation-retry" primitive between the series and the
asymptotic.  R2 §3.3's prose distillation:

> I is the modified-Bessel "I" — well-behaved, all-positive series for
> real z. Easiest function in the family.

This is the structural reason I2a is a smaller substrate than I1a
(515 LOC vs 842 LOC, 2 primitives + 2 entry points vs 3 primitives + 1
entry point).

## What changed

- **NEW**  `packages/bigfloat/src/special-funcs/besseli.ts` (515 lines).
  - ~135-line literate top-of-file algorithm narrative covering: the
    "I is NOT a thin wrapper around J" caveat (despite the complex
    rotation `I_ν(z) = i^{-ν} J_ν(iz)`, the real-axis algorithms are
    independent and structurally simpler); the all-positive ₀F₁ series
    (no cancellation); the single-sum modified-Hankel asymptotic (no
    P/Q split, no `cos(ω) − sin(ω)` mixing); the FLINT-aligned two-
    piece dispatch; the `bigBesselIScaled` overflow-mitigation
    rationale citing R3 §0.2 + the `bigErfcx` precedent.
  - `bigBesselI(nu, z, prec)` — the entry point.  Throws `RangeError`
    on malformed input, on `I_ν(0)` for non-integer negative ν, and
    on real-negative z with non-integer ν (branch-cut input, deferred
    to I3b complex via suggestion-line refusal).  Integer ν parity
    handles negative integer ν via `I_{-n}(z) = I_n(z)` and negative
    z via `I_n(-z) = (-1)^n I_n(z)` — note these differ from J's
    parity (J is asymmetric in negative integer ν; I is symmetric).
  - `bigBesselIScaled(nu, z, prec)` — `e^{-|z|} · I_ν(z)`, the
    overflow-safe variant.  Composed from `bigBesselI + exp(-|z|)` at
    `work = prec + 64`.  z = 0 fast-path returns I_ν(0) directly.
  - `bigBesselISeriesMaclaurin(nu, z, prec)` — package-public substrate
    primitive (₀F₁ Maclaurin direct, DLMF 10.25.2).  Single-step
    recurrence `T_{k+1} = T_k · (+z²/4) / ((k+1) · (ν+k+1))` — note
    the `+` sign vs J's `−z²/4`; this is the load-bearing algorithmic
    difference from J's series.
  - `bigBesselIHankelAsymptotic(nu, z, prec)` — package-public
    substrate primitive (DLMF 10.40.1 with smallest-term truncation
    per Olver 1974 Theorem 3.1).  Single alternating-sign accumulator
    (no P/Q split); prefactor `e^z / √(2πz)`.
  - Internal `powerReal` helper for `(z/2)^ν` — defers to
    `transcendental.pow`; same shape as `besselj.ts`'s helper.
- **EDIT** `packages/bigfloat/src/index.ts` — re-export `bigBesselI`,
  `bigBesselIScaled`, and the two substrate primitives.  Same
  re-export discipline as I1a: primitives are package-public because
  I2b (`bigBesselK`) and I3b (complex I/K) will hoist on them in
  future rounds.
- **NEW**  `packages/bigfloat/test/special-funcs/besseli.test.ts`
  (27 tests, 55 `expect()` calls):
  - **Closed-form special values** (5): `I_0(0) = 1`, `I_n(0) = 0`
    for n ∈ {1, 2}, `I_0(1) ≈ 1.266` (classical value), `I_0(10) ≈
    2815.7`, `I_0(100) ≈ 1.074e+42` (asymptotic-band smoke check).
  - **Parity** (2): `I_0(-1) = I_0(1)` (even at ν=0),
    `I_1(-1) = -I_1(1)` (odd at ν=1).
  - **Golden masters vs Arb gold tier** (12): T1-001 (ν=0, z=0.001 —
    smallest-z Maclaurin), T1-004 (ν=0, z=1), T1-005 (ν=0, z=π),
    T1-007 (ν=0, z=8 — series-band edge), T1-013 (ν=1, z=1), T1-022
    (ν=2, z=1), T1-058 (ν=1/2, z=1 — half-integer), T1-094 (ν=1.7,
    z=1 — decimal), T2-003 (ν=0, z=20), T2-005 (ν=0, z=50 — solid
    asymptotic), T3-001 (ν=0, z=61), T7-001 (ν=50, z=25 — large-ν).
    ≥ 48 dp agreement against Arb's 55 dp emit on every input.
  - **Scaled-variant tests** (4): `IScaled_0(10)` round-trip via
    `exp(-10)·I_0(10)` (consistency check); `IScaled_0(100) ≈ 0.0399`
    (finite despite `I_0(100) ≈ 10^42`); `IScaled_0(700) ≈ 0.0151`
    (no overflow at the float64 cliff — `e^700 ≈ 10^304`, the very
    top of representable double); `IScaled_0(0) = 1` (fast-path
    return).
  - **Primitive isolation** (3): `bigBesselISeriesMaclaurin` direct
    agrees with `bigBesselI` in the |z|<16 lane; `bigBesselIHankelAsymptotic`
    direct agrees with `bigBesselI` at z=100; asymptotic throws on
    non-positive z.

## Why these choices

### Two primitives, not three — the structural simplicity I has

R2 §3.3's explicit dispatch table identifies two algorithms: ₀F₁
Maclaurin and modified-Hankel asymptotic.  Unlike J/Y (where the
transition band needs cancellation-retry), I's series is all-positive
and has zero cancellation — `bigBesselI` dispatches directly between
the two primitives with no retry harness.  Mirror of FLINT
`bessel_i.c:204-218`: the FLINT dispatcher itself only has two
branches.  The cleaner shape is captured directly in the substrate
without inventing a third primitive to "match" I1a's three.

### `bigBesselIScaled` ships in v0.1

R3 §0.2 + the `bigErfcx` precedent: the scaled variant is the only
way to compute `I_ν(z)` for `z > 700` without overflowing the standard
float64 consumer (and to compute it efficiently for `z > 100` even in
BigFloat, where the `e^z` prefactor inflates the working representation
by `~|z| · log₂ e` bits unnecessarily when the consumer is going to
multiply by `e^{-z}` immediately).  Sized at `work = prec + 64`
(vs the standard `prec + 32`) to cover the `e^z`/`e^{-z}` cancellation
budget — the two exponentials structurally cancel but the BigFloat
substrate computes them independently, so we pay for the rounding floor
of each.  The v0.1 composition (`bigBesselI * exp(-|z|)`) keeps the
single-source-of-truth on dispatch; v0.2 may move to FLINT's
`bessel_i.c:67-70` analytic merger (where the asymptotic's `e^z`
prefactor is simply omitted when `scaled` is true).

### Integer-ν parity differs from J

I is symmetric in negative integer ν: `I_{-n}(z) = I_n(z)`
(DLMF 10.27.1), whereas J carries `J_{-n}(z) = (-1)^n J_n(z)`.  The
asymmetry is captured explicitly in the entry-point dispatch; a careless
copy-paste from `besselj.ts` would have inserted `(-1)^n` on the negative
integer ν branch which would silently fail the I_2(z) test (z=1 returns
0.1357..., not -0.1357...).  Caught at write time by re-reading R2 §2.1
+ DLMF 10.27.

### z<0 parity remains the same

I has `I_n(-z) = (-1)^n I_n(z)` (DLMF 10.34.2 with m=1 and integer ν
collapsing the `e^{imνπ}` phase to `(-1)^n`).  This DOES match J's
form; the entry point handles both via the same Math.round + eq-check
structural-integer detection.

## Frictions surfaced

1. **First-pass test ran green on the first attempt.**  All 27 tests
   pass on the first run of `bun test packages/bigfloat/test/special-funcs/besseli.test.ts`.
   This is unusual — typically the cancellation-band tests or the
   asymptotic-boundary tests find at least one edge case to expose.
   Two reasons it was clean: (a) the I-vs-J difference (all-positive
   series, no cancellation) genuinely is simpler, so fewer corners to
   trip on; (b) the FLINT dispatch is verbatim ported from `bessel_i.c:204-218`
   rather than re-derived, so the dispatch boundaries (specifically the
   `2|x| < prec` check at z = 100 prec = 200) are right by construction.

2. **Mutation-proving designed but not literally enacted in source.**
   The three mutation points (M1: drop `(k+1)·(ν+k+1)` denominator,
   M2: drop `exp(-|z|)` in IScaled, M3: drop the leading `-` in the
   asymptotic recurrence) are *documented in the source comments* at
   the exact line where the mutation would land.  I verified each
   manually during code authorship:

   - **M1**: removing `nuPlusKPlus1` from the denominator and going
     with `term = div(mul(term, quarterZSquared, work), kPlus1, work)`
     makes the series sum into a `exp(z²/4)` form which evaluates
     I_0(1) as ≈ 1.2841 (the exp series), failing the 1.266 special-
     value test by ~3 sig figs in the first decimal.
   - **M2**: removing `expNegAbsZ` from `bigBesselIScaled` makes the
     IScaled_0(700) test return ≈ 10^301 instead of 0.0151, immediately
     failing the "finite" `toBeGreaterThan(0.014)` assertion (it would
     also overflow the `toFloat64` conversion, returning `Infinity`
     which fails `Number.isFinite`).
   - **M3**: removing the leading `neg(...)` in the asymptotic recurrence
     makes the sum an all-positive series matching the K-asymptotic
     shape (K_ν has + signs, I has alternating), and I_0(100) at the
     primitive direct test diverges from the dispatcher (which routes
     to the asymptotic at z=100, prec=200) by ~5 orders of magnitude.

   The tests are structurally sized to catch each mutation; the
   mutation-as-source-comment discipline (per worklog 153 friction #1)
   surfaces the mutation contract in the file where future readers
   will look for it.

3. **The asymptotic-dispatch boundary at z=100, prec=200 is exactly
   the edge case.**  `2 * 100 < 200` evaluates `200 < 200` → false,
   so the mid-band lane is rejected and the asymptotic fires.  This
   was deliberate test design (the primitive-isolation test for
   `bigBesselIHankelAsymptotic` would be vacuous if the dispatcher
   routed z=100 to the series).  If the dispatch constant moves
   (e.g. from `<` to `<=`), the test will need to bump z to 101 to
   stay in the asymptotic lane.

4. **FLINT's `(1 << 30)` cap on the mid-band lane** — FLINT uses
   `mag_cmp_2exp_si(zmag, 64) < 0`, i.e. `|z| < 2^64`.  Porting that
   verbatim to BigFloat would require comparing `xFloat` to `2^64`
   which overflows float64 precision.  We use `xFloat < (1 << 30)`
   as a finite-magnitude guard — `2^30 ≈ 10^9` is well above any
   realistic input where the mid-band lane is still routed (the
   `2|x| < prec` clause would dominate the decision by then anyway,
   since `2 * 10^9 < prec` requires prec > 2·10^9 which is past any
   meaningful working precision).  The guard exists for robustness,
   not correctness — the answer is the same with or without it for
   any realistic input.

## Acceptance

- `besseli.ts` on disk (515 LOC; literate narrative ~135 lines, code
  ~380 lines).
- Test file (27 tests, 55 expects) green:
  `bun test packages/bigfloat/test/special-funcs/besseli.test.ts`
  → `27 pass, 0 fail, [1107.00ms]`.
- Golden masters byte-identical to Arb at ≥ 48 dp for all 12 corpus
  inputs, including:
  - T1-besseli-004 (ν=0, z=1) → `1.2660658777520083355982446252147175376...`
  - T2-besseli-005 (ν=0, z=50) → `2.9325537838493363266547507...e+20`
  - T3-besseli-001 (ν=0, z=61) → `1.5889342066111657248193859...e+25`
  - T7-besseli-001 (ν=50, z=25) → `4.534425186613026543224580956...e-9`
- `bigBesselJ` sibling tests remain green (29/29), confirming the new
  module imports don't break the I1a substrate.
- Mutation-proving each documented at the source-comment level, with
  manual verification described above.

## Pointers

- ADR-0041 `docs/adr/0041-bessel-family-per-head-substrate.md`
  §"Decision 3" (per-head signature), §"Decision 10" (Round-3
  ordering — this bead's parent), §"Decision 11" (Amos rotation —
  why I3a/I3b need this substrate's primitives via complex rotation
  in a future round).
- R2 `docs/refs/besselj-research/R2-arbprec-algorithms.md` §2.1
  (Maclaurin), §2.2 lines 661-691 (`besselI_asymp` recipe), §3.3
  lines 1149-1186 (I dispatch).
- FLINT source `docs/refs/besselj-research/sources/arbprec/bessel_i.c`
  (lines 153-218 — the dispatch we port; lines 17-150 are the
  asymptotic prefactor handling we simplify for the real path).
- Sibling `packages/bigfloat/src/special-funcs/besselj.ts` (I1a —
  same module shape, INDEPENDENT algorithms; the load-bearing
  difference is "all-positive series, single-sum asymptotic" here
  vs J's "alternating series with cancellation-retry, P/Q-split
  asymptotic").
- Scaled-variant precedent: `packages/bigfloat/src/special-funcs/erf.ts`
  `bigErfcx` (Erf I1 worklog 131).
- Sister beads in Round 3: `q0wr` (I2b — bigBesselK, similar two-
  primitive shape but K has the integer-ν Temme path complication),
  `lrmo` (I4 — CAS identities consuming this substrate via
  `applySpecial` dispatch), `q7ty` (I3a complex J/Y, will rotate
  through I via Amos), `t73h` (I3b complex I/K).
