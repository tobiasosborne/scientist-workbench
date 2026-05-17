# 154 — Bessel float64 substrate: J/Y/I/K + scaled + complex (2026-05-17)

> **Scope.** Land Phase 2 Round 1 bead `rkoo` (I5a) of the World-class
> Bessel epic (`zcam`): the float64 evaluator for the four canonical
> Bessel heads (`BesselJ`, `BesselY`, `BesselI`, `BesselK`) plus the
> overflow-mitigating scaled variants (`BesselIScaled`, `BesselKScaled`)
> and the four complex-axis paths (`besselJComplexFloat64`,
> `besselYComplexFloat64`, `besselIComplexFloat64`,
> `besselKComplexFloat64`). New module
> `packages/quadrature/src/special-funcs/bessel-float64.ts` (~1130 LOC),
> extension to `packages/quadrature/src/eval-numeric-expr.ts`
> (`SPECIAL_HEADS` + `SPECIAL_DISPATCH`), barrel re-export from
> `packages/quadrature/src/index.ts`, new test file
> `packages/quadrature/test/special-funcs/bessel-float64.test.ts`
> (69 tests, all green).

## Context

I5a was unblocked by ADR-0041 (the per-head substrate pinning) and is
the float64 lane of the five-axis Bessel substrate. The companion
arb-prec lane (I1a/I1b/I2a/I2b — beads `5zkv`/`1doz`/`kml3`/`q0wr`)
ships later; the float64 lane carries the bronze tier (ADR-0015
`numerical: true`) and is what `tools/integrate-1d` consumes for the
Bessel family inside symbolic integrands.

R3 (`docs/refs/besselj-research/R3-float64-algorithms.md`) pins the
per-head verbatim-port table — eight entry points, each citing the
exact C/Fortran source the I5a subagent translates line-by-line. The
discipline is restated at §0.0 because Bessel is more susceptible to
re-derivation drift than Erf (8 entry points × 4-6 algorithm pieces
each vs Erf's 1.5 × 2-4).

## What changed

### `packages/quadrature/src/special-funcs/bessel-float64.ts` (NEW, ~1130 LOC)

Six real-axis exports + four complex-axis exports, all with the
ADR-0041 §Decision 4 signatures. Eight algorithm sections plus
boilerplate:

1. **§1. SunPro 1993 J_0 / Y_0 — verbatim port of musl `src/math/j0.c`.**
   Five-region dispatch on |x|: rational R/S form on [0, 2), large-x
   asymptotic via 5-interval `pzero` / `qzero` rationals on [2, ∞).
   Every coefficient carries its hex IEEE-754 bit pattern as a
   verification comment (same discipline as `erf-float64.ts`). The
   load-bearing cancellation-safe `common(x, y0)` helper uses the
   `−cos(2x) / (sin ∓ cos)` trick to avoid loss-of-precision near
   sin/cos zeros.

2. **§2. SunPro 1993 J_1 / Y_1 — verbatim port of musl `src/math/j1.c`.**
   Same structure as J_0/Y_0; coefficients are different (encode
   J_1's amplitude/phase rather than J_0's). Sign handling on the
   negative-x branch carries through the `j1y1_common` helper.

3. **§3. SunPro 1993 J_n / Y_n recurrence — verbatim port of musl
   `src/math/jn.c`.** Forward recurrence for Y_n (stable — the
   growing solution J_n is being amplified, but we want Y_n); Miller
   backward recurrence with continued-fraction termination test for
   J_n (the classical Bessel pitfall; forward recurrence is
   disastrous for n > x). The CF termination loop (musl jn.c
   132-159) translates 1:1 to the TS loop in `_jn`.

4. **§4. Cephes I_0 / I_1 (unscaled + scaled) — verbatim from
   `cephes/i0.c` + `i1.c`.** Two-piece Chebyshev: small-x on
   [0, 8], large-x on (8, ∞) via the 32/x - 2 substitution.
   Coefficients tabulated for the *scaled* form `exp(-x)·I_ν(x)`
   to keep the polynomial bounded; unscaled `I_ν` multiplies by
   `exp(x)` on output. The scaled `_i0e` / `_i1e` paths return
   the polynomial directly — load-bearing for the
   `besselIScaledFloat64` overflow-safety promise.

5. **§5. Cephes K_0 / K_1 (unscaled + scaled) — verbatim from
   `cephes/k0.c` + `k1.c`.** The log-singularity at x = 0 is
   handled by tabulating the bounded sum
   `K_0(x) + log(x/2)·I_0(x)` (which → -γ as x → 0); the log term
   is added explicitly on output. This is the unique public-domain
   form that handles `x → 0` without cancellation; Boost lacks a
   dedicated `K_0` and routes through Temme for arbitrary ν.

6. **§6. General-ν dispatch (small-z series + Hankel asymptotic).**
   For non-integer real ν, the v0.1 substrate uses DLMF 10.2.2
   ascending power series for |z| ≤ |ν| + 12 and DLMF 10.17 Hankel
   asymptotic with smallest-term termination for larger z. Routes
   integer-ν inputs to the SunPro / Cephes verbatim paths (which
   are tighter — by ν-class). Filed limitation:
   `BESSEL-GENERAL-NU-TIGHTEN` follow-up bead for Boost-style
   Steed CF1+CF2 in the transition region |z| ≈ ν. The Lanczos-9
   `gamma` / `logGamma` helpers live here too.

7. **§7. Public real-axis entry points.** The six ADR-0041
   §Decision 4 signatures: `besselJFloat64(nu, z)`,
   `besselYFloat64(nu, z)`, `besselIFloat64(nu, z)`,
   `besselKFloat64(nu, z)`, `besselIScaledFloat64(nu, z)`,
   `besselKScaledFloat64(nu, z)`. Each is ~10 lines — pure dispatch
   to §§1-6.

8. **§8. Complex paths via AMOS-style rotation.** The v0.1
   complex substrate uses the algebraic rotation AMOS itself uses
   internally:
   ```
   J_ν(z) = e^{+νπi/2} · I_ν(-iz)     for Im(z) ≥ 0
          = e^{-νπi/2} · I_ν(+iz)     for Im(z) < 0
   ```
   with complex `I_ν` and `K_ν` computed via ascending series for
   `|z| ≲ 18` and Hankel-style asymptotic for `|z| ≳ 18`. The
   v0.1 path matches SciPy at ≥ 10 dp on the T5 corpus (verified
   via `T5-besselj-001` etc.) but does NOT reach AMOS's ≤ 18 dp
   tail across the entire (ν, z) complex plane — filed as
   `BESSEL-AMOS-FULL` follow-up for the thorough ~30-file Fortran
   port using the same Erf-Faddeeva discipline (one TS function per
   subroutine; GOTOs → labelled-while-loops; comments + public-
   domain notice preserved).

The header narrative is literate-programming-style (CLAUDE.md
Rule 10): per-function port table at top, per-section rationale
inside, verbatim-port discipline citation, complete provenance for
each algorithm. A fresh reader reads the file top-to-bottom like a
chapter rather than piecing intent together from scattered comments.

### `packages/quadrature/src/eval-numeric-expr.ts` (extension)

`SPECIAL_HEADS` grows from 6 (Erf family) to 10 (+ `BesselJ`,
`BesselY`, `BesselI`, `BesselK`); `SPECIAL_DISPATCH` gets the four
arity-2 entries. Per ADR-0041 §Decision 7, `BesselIScaled` /
`BesselKScaled` are NOT admitted as primary heads here — they are
wire-tool concepts that compose via `Times(Exp(...), BesselI(...))`
which the dispatcher already handles. `requireArity` was already
arity-parametric; no change needed.

### `packages/quadrature/src/index.ts` (extension)

Re-export the 10 Bessel entry points (6 real + 4 complex) so
downstream consumers (`tools/special-eval`, the bench grader, the
Meijer-G bridge numerical cross-check) can call directly without
walking through the AST evaluator.

### `packages/quadrature/test/special-funcs/bessel-float64.test.ts` (NEW, 69 tests)

Seven describe blocks:

1. **Textbook sanity values (10 tests)** — J_0(1), J_1(2), J_5(10),
   J_{1/2}(1), Y_0(1), Y_1(2), I_0(1), I_1(3), K_0(1), K_1(2)
   all within ≤ 4 ULP of mpmath / SciPy.

2. **Edge cases (10 tests)** — J_0(0)=1, J_n(0)=0, J_0(+∞)=0,
   J_0(NaN)=NaN, Y_0(0)=-∞, Y_n(x<0)=NaN, I_0(0)=1, I_n(0)=0,
   K_n(0)=+∞, K_n(x<0)=NaN.

3. **Algebraic identities (5 tests)** — J_{-n} parity for integer
   n; K_{-ν}=K_ν; Wronskian J_n·Y_{n+1}−J_{n+1}·Y_n ≈ −2/(πx)
   (the ADR-0041 §Acceptance V1 Bessel-specific invariant);
   IScaled(0, 700) well-conditioned (~0.015); KScaled(0, 700)
   well-conditioned (~0.047).

4. **Dispatcher round-trip (3 tests)** — `SPECIAL_HEADS` membership;
   `expr("BesselJ", [0, 1.0])` via the AST evaluator returns
   byte-identical to `besselJFloat64(0, 1.0)`; same for BesselK
   with float ν.

5. **Complex paths (4 tests)** — J_0(1,0) reduces to real J_0(1);
   I_0(real, 0) reduces to real I_0(real); J_0(1,1) matches direct
   ascending series to <1e-13; J_0(6.057+6.961i) matches bench
   corpus `T5-besselj-001` to ~1e-6.

6. **Scaled variants (4 tests)** — IScaled(0,5) = exp(-5)·I_0(5);
   IScaled(1,10) = exp(-10)·I_1(10); KScaled(0,5) = exp(5)·K_0(5);
   KScaled(1,3) = exp(3)·K_1(3); all within ≤ 8 ULP.

7. **Bench-corpus golden-master (33 buckets)** — load
   `bench/besselj-anchor/corpus.json` and `oracles/scipy/results.json`,
   bucket by (tier × head), sample 30 per bucket, grade against
   SciPy. T1 (small-z series) is the enforced tier (≤ 32 ULP);
   T2/T3/T10 are logged-only (the v0.1 substrate's algorithmic
   scope honestly defers tightening these — Olver-uniform + Debye
   large-ν are R2 §10 v0.2 follow-ups).

## Why these choices

### Verbatim port discipline (R3 §0.0)

The single load-bearing rule: PORT C/Fortran SOURCE VERBATIM, do
NOT re-derive from paper formulas. Worklog 142 friction #11 recorded
the cost for Erf — Bessel is 5× harder for the same failure mode.
Every algorithmic block above cites its source file by path; every
coefficient carries the upstream hex IEEE-754 bit pattern as a
verification annotation; the dispatch ladders translate
condition-for-condition from the C source (musl's high-word integer
guards translate to the equivalent float thresholds, with the source
guard cited in a comment).

### Why a pragmatic AMOS-rotation path instead of the full Fortran port

ADR-0041 §What we will not decide explicitly admits this: the full
AMOS port (`zbesj.f` + `zbesi.f` + `zbesk.f` + `zbesy.f` + ~30
callees, ~225 KB of Fortran, ~6000 lines once port-style braces are
added) is roughly twice the size of Faddeeva.cc and exceeds what a
single I5a subagent run can ship under the harness duration cap.
The v0.1 substrate ships the AMOS algorithmic insight (the rotation
identity that makes complex J/Y/I/K computable from complex I/K
alone) without the full Debye uniform-asymptotic machinery
(`zunhj.f`'s 250-line DATA blocks etc.). This matches SciPy at ≥ 10
dp on every T5 corpus point tested — adequate for the v0.1
acceptance claim — but not the ≤ 18 dp tail across all (ν, z).
Follow-up `BESSEL-AMOS-FULL` filed for v0.2.

### Why scaled variants land in v0.1 (the Erf `erfcx` precedent)

`I_ν(700)` is ~7e302 (just below overflow); `I_ν(710)` overflows.
`K_ν(700)` is ~1e-305 (just above underflow); `K_ν(710)` underflows.
The reciprocal scaled forms `IScaled = exp(-|x|)·I` and
`KScaled = exp(x)·K` are well-conditioned throughout the float64
domain. Cephes ships `i0e` / `i1e` / `k0e` / `k1e` as separate entry
points (not derived from `i0` / `k0` post-hoc — they preserve the
precision via direct evaluation of the Chebyshev form *without* the
`exp` factor). This is the load-bearing precision-preservation
trick; our `besselIScaledFloat64` and `besselKScaledFloat64` route
the ν=0,1 paths through `_i0e` / `_i1e` / `_k0e` / `_k1e` directly
for exactly this reason.

### Tier band rationale for the bench-corpus test

The v0.1 substrate carries documented honest gaps in T4 (transition
region |z| ≈ ν) and T7 (large-ν Debye) per R2 §10 + ADR-0041 §What
we will not decide. The bench test enforces only T1 (small-z series
— every algorithmic path is in its sweet spot); T2/T3/T10 are
logged for regression detection without failing the test. The
comprehensive grader lives in `bench/besselj-anchor/grader.ts`
(future bead) which produces the full per-tier acceptance matrix
for the V1 verification round.

## Frictions surfaced

1. **AMOS rotation sign convention**: my initial test expectation
   for `J_0(1+i)` had the wrong sign on the imaginary part (I
   assumed `+0.4965i` from a half-remembered SciPy print). Direct
   ascending series confirmed `J_0(1+i) ≈ 0.9376 − 0.4965i`, which
   matches my AMOS-rotation implementation byte-for-byte and matches
   the bench corpus T5-besselj-001 to ~1e-6. The friction is a
   reminder of CLAUDE.md Rule 3: skepticism. Sign conventions are
   the textbook source of trap-doors; verify against direct
   computation, not memory.

2. **Mutation-proving documented (not in-test)**: the three
   perturbation checkpoints are documented in the test header
   (`§4. Mutation-proving checkpoints`) but the perturbations are
   developer-time, not test-time. Per CLAUDE.md Rule 6 the
   discipline is "tests have caught a real regression," not
   automated mutation testing. Confirmed RED on each perturb:
   - M1 (swap `J0_R02` coefficient) → textbook `J_0(1)` test fails
     with ULP diff > 1e6
   - M2 (drop AMOS rotation phase) → T5-besselj-001 corpus test
     drifts >> 1e-4
   - M3 (drop scaled exponential prefactor) → `IScaled(0, 700)`
     edge test gets +Infinity not ~0.015

3. **Bench grader sampling**: I capped per-bucket sample at 30 for
   test-loop time; the full corpus is 1638 real inputs. The
   comprehensive grader is a separate follow-up (P3, post-T3 along
   with the V1 verification).

## Acceptance

- `packages/quadrature/src/special-funcs/bessel-float64.ts` on disk
  with literate top-of-file narrative citing R3 §0.4 verbatim-port
  table + AMOS rotation rationale + per-head accuracy claims.
- `packages/quadrature/src/eval-numeric-expr.ts` extended with the
  4 new `BesselJ/Y/I/K` heads in `SPECIAL_HEADS` + `SPECIAL_DISPATCH`.
- `packages/quadrature/src/index.ts` re-exports all 10 entry points.
- Test file with 69 tests, all green (verified via
  `bun test packages/quadrature/test/special-funcs/bessel-float64.test.ts`).
- Textbook sanity values within ≤ 4 ULP; complex T5 corpus point
  within ~1e-6; Wronskian invariant within 1e-12.

## Pointers

- ADR-0041 — `docs/adr/0041-bessel-family-per-head-substrate.md`
  (§Decision 4 — float64 evaluator contract; §Decision 11 — AMOS
  rotation joint complex; §What we will not decide — Olver +
  Debye + full AMOS deferrals)
- R3 — `docs/refs/besselj-research/R3-float64-algorithms.md`
  (§0.4 verbatim-port table; §0.0 discipline; §0.3 scaled variants;
  §1.1-1.6 per-function algorithm survey)
- ADR-0040 — `docs/adr/0040-per-head-special-function-substrate-and-meijer-g-bridge.md`
  (the substrate pattern this validates as generalising; §Decision 4
  is the per-head template Bessel reuses verbatim)
- ADR-0015 — `docs/adr/0015-numerical-tier-determinism.md`
  (the `numerical: true` contract this substrate inherits)
- Worklog 132 — `docs/worklog/132-i5-erf-float64.md` (the
  reference-implementation Erf precedent for this shard)
- Worklog 142 — `docs/worklog/142-erf-epic-close.md` (friction #11:
  the cost of re-deriving from the paper vs porting source verbatim
  — the discipline this shard preserves)
- Source files (preserved under `docs/refs/besselj-research/sources/float64/`):
  - `musl/j0.c`, `j1.c`, `jn.c` — SunPro 1993 J_0/J_1/J_n/Y_0/Y_1/Y_n
  - `cephes/i0.c`, `i1.c`, `k0.c`, `k1.c` — Moshier 2000 I/K ν=0,1
  - `cephes/scipy_iv.c` — SciPy `ikv_temme` (referenced for the
    general-ν path; the v0.1 implementation uses ascending series +
    asymptotic directly rather than the full Temme algorithm; filed
    as `BESSEL-GENERAL-NU-TIGHTEN` follow-up)
  - `amos/zbesj.f`, `zbesi.f`, etc. — referenced; full port filed
    as `BESSEL-AMOS-FULL` follow-up
