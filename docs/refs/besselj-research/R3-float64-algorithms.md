# R3 — Float64 Bessel algorithms: state-of-the-art survey for `@workbench/quadrature`

> **Bead:** `scientist-workbench-1272` (R3 of epic
> `scientist-workbench-zcam`, world-class Bessel J/Y/I/K reference
> implementation; per-head substrate prototype 2 after Erf).
> **Sibling artefacts:** R1 (symbolic), R2 (arb-prec), R4 (Meijer-G
> bridge), R5 (oracle landscape) — same `docs/refs/besselj-research/`
> directory. This document is the Phase-0 R3 gate input to A0 (ADR-0041
> draft) and the I5a substrate subagent.
> **Audience:** the I5a subagent (and any future special-function
> implementer) who will translate the recommended C/Fortran sources
> verbatim into TypeScript under `packages/quadrature/src/special-funcs/
> bessel-float64.ts`.
> **Substrate landing site (per ADR-0040 Decision 4):**
> `packages/quadrature/src/special-funcs/bessel-float64.ts` (new), with
> an extension to `packages/quadrature/src/eval-numeric-expr.ts` adding
> `BesselJ` / `BesselY` / `BesselI` / `BesselK` (and probably
> `BesselIScaled` / `BesselKScaled` — see §6) heads to
> `SPECIAL_DISPATCH`.
> **Tier:** ADR-0015 `numerical: true`. Bit-identical given platform
> fingerprint `{arch, os, runtime}`. Pure JavaScript on Bun/V8; no FFI;
> no `process.arch` branches; no `Math.fround`; algorithm and constants
> are platform-independent so the only float-runtime dependence is the
> underlying V8 `Math.exp` / `Math.log` / `Math.sin` / `Math.cos` /
> `Math.sqrt` behaviour that the rest of the tier already inherits.
> **Reference cycle:** R1 (symbolic) → R2 (arb-prec) → **R3 (this
> document)** → R4 (Meijer-G bridge) → R5 (oracle landscape) → A0
> (ADR-0041 + prototype).

## 0. Executive summary (read first; full details in §§1–10)

### 0.0 The verbatim-port discipline (read SECOND — it's load-bearing)

**Recommend verbatim port from C / Fortran. Do NOT re-derive from
the paper.** This is the single load-bearing rule of this artefact.

Worklog 142 (Erf epic-close) friction #11 records the cost of
violating it: "I5's first Algorithm 916 draft had a sign error in the
re-derivation; the Faddeeva.cc verbatim port worked first try."
Bessel is *more* susceptible to this failure mode than Erf because
(a) Bessel has 4 distinct functions × (real, complex) = 8 entry points
versus Erf's effective 1.5, (b) each entry point has 4–6 algorithm
pieces vs Erf's 2–4, (c) backward-recursion + Wronskian relations
introduce sign-and-scaling traps a paper read cannot defend against,
and (d) Amos's complex code is 50+ files of cross-referencing Fortran
where a single typo in `zunhj.f`'s Debye-coefficient `ar`-array would
silently propagate into `BesselJComplex(50, 10+10i)` and never trip
a test that didn't already cross-check against Amos itself.

Every recommended impl in this artefact points to the **exact source
file and revision** the I5a subagent will translate line-by-line. If
a paper formula and a C source contradict on a constant or a
recurrence-direction flag, the C source wins. The paper is for
*understanding why*, not for *deriving what*.

### 0.1 The eight-way recommendation table

| Head + path                          | Recommended verbatim port                                                              | Source file (local)                                                                 | Claimed accuracy        | License        |
|--------------------------------------|----------------------------------------------------------------------------------------|-------------------------------------------------------------------------------------|-------------------------|----------------|
| `besselJ0Float64(x)` (real, ν=0)     | **SunPro 1993** `e_j0.c` (musl/glibc/FreeBSD lineage, byte-identical)                  | `sources/float64/musl/j0.c`                                                         | ≤ 2 ULP (mid-range)     | Sun permissive |
| `besselJ1Float64(x)` (real, ν=1)     | **SunPro 1993** `e_j1.c`                                                               | `sources/float64/musl/j1.c`                                                         | ≤ 2 ULP                 | Sun permissive |
| `besselJnFloat64(n, x)` (real, ν∈ℤ)  | **SunPro 1993** `e_jn.c` (Miller backward recurrence for `n ≥ 2`)                      | `sources/float64/musl/jn.c`                                                         | ≤ 4 ULP                 | Sun permissive |
| `besselJvFloat64(ν, x)` (real, ν∈ℝ)  | **Boost.Math** `bessel_jy.hpp` Steed-Temme + Hankel-PQ                                 | `sources/float64/boost/bessel_jy.hpp` + `bessel_jy_asym.hpp` + `bessel_jy_series.hpp` | ≤ ~3 ULP (Maddock 2007) | Boost (BSL-1)  |
| `besselY0Float64(x)` (real, ν=0)     | **SunPro 1993** `e_j0.c` (`y0` is in the same file as `j0`)                            | `sources/float64/musl/j0.c`                                                         | ≤ 4 ULP                 | Sun permissive |
| `besselY1Float64(x)` (real, ν=1)     | **SunPro 1993** `e_j1.c` (`y1` is in the same file as `j1`)                            | `sources/float64/musl/j1.c`                                                         | ≤ 4 ULP                 | Sun permissive |
| `besselYnFloat64(n, x)` (real, ν∈ℤ)  | **SunPro 1993** `e_jn.c` (forward recurrence on `Y_n`)                                 | `sources/float64/musl/jn.c`                                                         | ≤ 4 ULP                 | Sun permissive |
| `besselYvFloat64(ν, x)` (real, ν∈ℝ)  | **Boost.Math** `bessel_jy.hpp` (same dispatcher as `Jv`; computes `Jv` and `Yv` jointly via Steed CF1+CF2) | `sources/float64/boost/bessel_jy.hpp`                                               | ≤ ~3 ULP                | Boost (BSL-1)  |
| `besselI0Float64(x)` (real, ν=0)     | **Boost.Math** `bessel_i0.hpp` (Holoborodko 2015 rationals, 4 sub-intervals)           | `sources/float64/boost/bessel_i0.hpp`                                               | ≤ 1.5 ULP (Holoborodko) | Boost (BSL-1)  |
| `besselI1Float64(x)` (real, ν=1)     | **Boost.Math** `bessel_i1.hpp` (Holoborodko 2015)                                      | `sources/float64/boost/bessel_i1.hpp`                                               | ≤ 1.5 ULP               | Boost (BSL-1)  |
| `besselIvFloat64(ν, x)` (real, ν∈ℝ)  | **SciPy's** Boost-derived `ikv_temme` (Temme 1975 + Steed CF1 + Thompson-Barnett CF2)  | `sources/float64/cephes/scipy_iv.c`                                                 | ≤ ~3 ULP                | BSL-1 (Zhang)  |
| `besselK0Float64(x)` (real, ν=0)     | **Cephes** `k0.c` Chebyshev (Moshier 2000)                                             | `sources/float64/cephes/k0.c`                                                       | ≤ 5.4 ULP (Moshier)     | Cephes BSD     |
| `besselK1Float64(x)` (real, ν=1)     | **Cephes** `k1.c` Chebyshev (Moshier 2000)                                             | `sources/float64/cephes/k1.c`                                                       | ≤ 5.4 ULP               | Cephes BSD     |
| `besselKvFloat64(ν, x)` (real, ν∈ℝ)  | **SciPy's** Boost-derived `ikv_temme` (shared with `Iv`)                                | `sources/float64/cephes/scipy_iv.c`                                                 | ≤ ~3 ULP                | BSL-1 (Zhang)  |
| `besselJComplexFloat64(ν, re, im)`   | **Amos TOMS 644** `zbesj.f` (delegates to `zbesi` via `J(ν,z) = exp(νπi/2)·I(ν,−iz)`)  | `sources/float64/amos/zbesj.f` (+ ~30 callees)                                       | ≤ ~18-digit precision   | Public domain  |
| `besselYComplexFloat64(ν, re, im)`   | **Amos TOMS 644** `zbesy.f`                                                            | `sources/float64/amos/zbesy.f` (+ Amos chain)                                       | ≤ ~18-digit precision   | Public domain  |
| `besselIComplexFloat64(ν, re, im)`   | **Amos TOMS 644** `zbesi.f` (the load-bearing complex primitive)                       | `sources/float64/amos/zbesi.f` (+ Amos chain)                                       | ≤ ~18-digit precision   | Public domain  |
| `besselKComplexFloat64(ν, re, im)`   | **Amos TOMS 644** `zbesk.f`                                                            | `sources/float64/amos/zbesk.f` (+ Amos chain)                                       | ≤ ~18-digit precision   | Public domain  |
| `besselIScaledFloat64(ν, x)` (real)  | **Cephes** `i0e` / `i1e` for ν ∈ {0, 1}; **SciPy** `ikv_temme` × `exp(-x)` for ν ∈ ℝ  | `sources/float64/cephes/i0.c` (i0e), `i1.c` (i1e)                                   | ≤ ~3 ULP                | Cephes BSD     |
| `besselKScaledFloat64(ν, x)` (real)  | **Cephes** `k0e` / `k1e` for ν ∈ {0, 1}; **SciPy** `ikv_temme` × `exp(x)` for ν ∈ ℝ    | `sources/float64/cephes/k0.c` (k0e), `k1.c` (k1e)                                   | ≤ ~3 ULP                | Cephes BSD     |

**Why three different vendors instead of one?** No single
public-domain or permissively-licensed float64 Bessel library
dominates *all eight* paths. SunPro owns `J_n`, `Y_n` integer order
(byte-identical across glibc / musl / FreeBSD / NetBSD / Apple Libm
since 1993; the same provenance that owns our Erf via `e_erf.c`).
Boost.Math owns `I_0` / `I_1` (Pavel Holoborodko's 2015 rationals are
strictly tighter than Moshier's 30-coefficient Chebyshev, with
explicit ULP bounds per sub-interval). Cephes owns `K_0` / `K_1`
(Moshier's logarithmic-subtraction form `K_0(x) = -log(x/2)·I_0(x)
+ Σ A_k T_k(x²-2)` is the only public-domain form that handles the
`x → 0` log-singularity without cancellation). For non-integer real
`ν` (`Iv`, `Kv`, `Jv`, `Yv`), Boost.Math's Temme-Steed unified
algorithm — already ported to C inside SciPy as `ikv_temme` — is the
consensus modern choice. For complex `z`, **Amos TOMS 644** is the
ONLY game in town: SciPy, Julia, Octave, GSL, and FreeFEM all wrap
it; the openspecfun shared library exists specifically to ship a
maintained build of Amos's Fortran for these consumers.

We will port each from its primary source.

### 0.2 The two-axis dispatch principle

Bessel `f(ν, x)` has **two** input axes vs Erf's one, and the
algorithm split is on **both** simultaneously. The canonical regime
map (synthesised from Boost `bessel_jy.hpp` + Cephes `jv.c` + Amos
`zbinu.f`):

```
                    |x| small   |x| ~ ν   |x| > ν   |x| ≫ ν
                   ────────────────────────────────────────────
   ν small (≤ 10) │ series    │ Steed    │ Steed   │ Hankel
                  │ DLMF 10.2 │ CF1+CF2  │ CF1+CF2 │ DLMF 10.17
                   ────────────────────────────────────────────
   ν moderate     │ series    │ Olver    │ Steed   │ Hankel
   (10 < ν ≤ 60)  │ (slow)    │ uniform  │ CF1+CF2 │
                  │           │ DLMF 10.20│        │
                   ────────────────────────────────────────────
   ν large (> 60) │ Olver     │ Olver    │ Olver   │ Hankel
                  │ uniform   │ uniform  │ uniform │ (verify)
                  │           │ (turning │ (verify)│
                  │           │  point)  │         │
                   ────────────────────────────────────────────
```

The **turning point** `x = ν` is the boundary between the oscillatory
regime (`x > ν`, `J` and `Y` ≈ Hankel sinusoids) and the monotone /
exponentially-decaying regime (`x < ν`, `J` decays like
`(x/2)^ν/Γ(ν+1)`). All four piecewise algorithms (series, Steed,
Olver, Hankel) are designed to be efficient and accurate in *their*
band; outside it they either diverge (Hankel for small `x`) or lose
precision (series for large `x`).

Cephes `jv.c`'s `if (an > 21.0) ... if (an > 2.0 * y) ...` ladder
is a one-author implementation of this regime map; Boost's
`bessel_jy.hpp` is a more conservative re-implementation (Steed only,
plus Hankel-PQ fall-through). For the workbench, **Boost's
implementation is cleaner and better-documented** (the literate
in-source comments cite DLMF section numbers; Cephes uses Abramowitz
& Stegun AMS-55 numbers from 1964, which still refer to the same
formulas but require a translation step).

### 0.3 Scaled variants — yes, ship them (per Erf's `erfcx` precedent)

`I_ν(x)` grows like `e^x / √(2π·x)` for `x → ∞`; for `x > 700` it
overflows. `K_ν(x)` decays like `e^{-x} · √(π/(2x))`; for `x > 700`
it underflows. The two pathologies are reciprocal; the established
solution is the **scaled variants**:

```
I_νe(x) := e^{-|x|} · I_ν(x)    (grows as 1/√x for large x; never overflows)
K_νe(x) := e^{x}    · K_ν(x)    (decays as 1/√x for large x; never underflows)
```

SciPy ships `ive(ν, z)` and `kve(ν, z)`. Cephes ships `i0e`, `i1e`,
`k0e`, `k1e` as separate entry points (not derived from `i0` /
`k0` post-hoc — they preserve the precision via direct evaluation
of the Chebyshev form *without* the `exp` factor). Amos's complex
versions use a `KODE` flag (`KODE=1` unscaled, `KODE=2` scaled).

Recommendation: **ship `besselIScaledFloat64` and `besselKScaledFloat64`
in the substrate** alongside the unscaled versions. The Erf precedent
is `erfcxFloat64` (`exp(x²)·erfc(x)`) — a sibling head that exists
specifically because `erfc(20) = 5.4e-176` underflows in float64
while `erfcx(20) = 0.028…` is well-conditioned. Bessel `I/K` are
the same situation, just on the other side of `e^x`.

The scaled wire heads (`BesselIScaled`, `BesselKScaled`) extend
`SPECIAL_DISPATCH` in `eval-numeric-expr.ts`, mirroring how `Erfcx`
sits alongside `Erfc` (the `eval-numeric-expr.ts` already has the
pattern; ADR-0040 §Decision 4 is the design template).

### 0.4 Top-3 risks (mitigations referenced inline)

1. **Backward-recurrence stability for `J_n` integer order.** Forward
   recurrence `J_{n+1}(x) = (2n/x)·J_n(x) − J_{n−1}(x)` is unstable
   for `n > x` (the recurrence relation has a growing solution `Y_n`
   that dominates after roundoff seeds it). The fix is **Miller's
   algorithm** (backward recurrence starting from `J_{N+M}(x) ≈ 0,
   J_{N+M−1}(x) ≈ 1` for `M` large enough, then rescale by
   `J_0(x)/J_0^{recurred}(x)`). musl `jn.c` implements this verbatim;
   SLATEC `dbesj.f` implements it; Cephes `jv.c::recur` implements
   it. Cephes documents the stability flag (`cancel` parameter). Do
   NOT attempt forward recurrence for `J_n` outside `n ≤ 1`. The
   one-line risk version is: **always start `J_n` recurrence from
   `Miller_start = max(n, ceil(x)) + 30` and recur DOWNWARDS** —
   forward recurrence is fine for `Y_n` but disastrous for `J_n`.
   This is the classical Bessel pitfall; every textbook (Press et
   al. Numerical Recipes §6.5; Olver DLMF §10.74) flags it; the
   verbatim port from SunPro handles it correctly.

2. **Cancellation in `Y_n(x)` near integer order via the reflection
   formula.** When `ν` is *almost* integer (`ν = n + ε`,
   `|ε| < 10⁻⁸`), the reflection formula `Y_{-n}(x) = (-1)^n · Y_n(x)`
   becomes a `0/0` form computed via `J_{-ν}(x) cos(πν) − J_ν(x))/
   sin(πν)`. Boost's `bessel_jy.hpp` switches to Temme's algorithm
   (`temme_jy`) for `|u| ≤ 0.5` where `u = ν − round(ν)`, which is
   designed for the small-`u` cancellation. The trap is the
   Temme-series convergence requires `|x| ≤ 2`; for `|x| > 2` Boost
   uses Steed's CF1 + CF2 simultaneously (the load-bearing trick is
   Wronskian relation `J·Y' − J'·Y = 2/(π·x)`, which gives `J` from
   `Y` directly without cancellation). Verbatim port from
   `bessel_jy.hpp` lines 220–540.

3. **Underflow / overflow for `BesselI` and `BesselK`.** As noted in
   §0.3, both functions have exponential pathologies. The mitigation
   has two parts: (a) ship scaled variants; (b) inside the unscaled
   variants, check `x < ELIM_UNDER` / `x > ELIM_OVER` (Amos's
   `ELIM = 2.303·(I1MACH(15)·D1MACH(5)−3.0)` ≈ 700 for IEEE-754
   double) and route to the saturation branches (`0` for underflow,
   `Infinity` for overflow). Do NOT silently return a denormal or
   `Inf` from a polynomial evaluation that happened to overflow —
   route explicitly and clamp, mirroring how SunPro's `e_erf.c`
   handles `|x| ≥ 28`.

### 0.5 Pointers (most load-bearing material)

- §1 — per-function algorithm survey (J, Y, I, K, real and complex)
- §2 — coefficient tables emit-ready as TS arrays (musl + Boost +
  Cephes), all reproducible byte-for-byte from local sources
- §3 — edge-case table (per function: `x = 0`, `x = ±∞`, NaN,
  subnormal, integer ν, half-integer ν, negative ν, very large
  `|ν|`, very large `|x|`, `|ν| ≈ |x|` turning region)
- §4 — algorithm-piece dispatch table per function
- §5 — accuracy budget (per branch ULP claims from primary sources)
- §6 — scaled-variant recommendation + wire-tool integration
- §7 — integration with `eval-numeric-expr.ts` `applySpecial` hook
- §8 — determinism analysis (Math.* fingerprint inheritance)
- §9 — verbatim-port discipline restated with the Erf friction-#11
  citation
- §10 — references with local paths

---

## 1. Per-function algorithm survey

This section presents the float64 algorithm landscape for each of the
four Bessel heads (J, Y, I, K), real and complex. Each subsection
ends with the chosen verbatim-port recommendation and the rationale.

### 1.1 `J_n(x)` — Bessel function of the first kind (real, integer order)

#### 1.1.1 Algorithm landscape

For integer `n ≥ 0` and real `x`, the canonical float64 algorithm is
the **SunPro 1993** implementation, ported into musl (`src/math/j0.c`,
`j1.c`, `jn.c`), glibc (`sysdeps/ieee754/dbl-64/e_j0.c`, etc.),
FreeBSD `lib/msun/src/e_j0.c`, NetBSD, OpenBSD, and Apple Libm.
The five-region dispatch:

| Branch | Condition                       | Algorithm                                                                        | Form                                              |
|-------:|---------------------------------|----------------------------------------------------------------------------------|---------------------------------------------------|
| (a)    | `|x| < 2^{-13} ≈ 1.22e-4` (`J_0`); `|x| < 2^{-127}` (denormal) | Maclaurin `J_0(x) = 1 − x²/4 + O(x⁴)`                            | `1 − (x/2)²` exact                                |
| (b)    | `2^{-13} ≤ |x| < 2`            | Rational `J_0(x) = 1 − x²/4 + x²·R(x²)/S(x²)`, deg 4/4 in `x²` (SunPro `R02..R05`, `S01..S04`) | `(1+x/2)(1-x/2) + z·(R/S)` (with `z = x²`)        |
| (c)    | `|x| ≥ 2`                      | Asymptotic `J_0(x) = √(2/(πx))·(P₀(x)·cos(x₀) − Q₀(x)·sin(x₀))`, `x₀ = x − π/4` | with `P₀ ≈ 1 + p_R/p_S`, `Q₀ ≈ Q/x · q_R/q_S` (5 intervals for the rationals) |
| (d)    | `|x| ≥ 2^{52}` (huge)          | Same as (c) but `cos(x)`, `sin(x)` lose precision; ULP error climbs to ~4       | unchanged                                         |
| (e)    | `|x| = +∞` / NaN                | `J_0(+∞) = 0`, `J_0(NaN) = NaN`                                                  | `1/(x*x)` (clever — returns `0` for `+∞`, `NaN` for `NaN`) |

Bn(c) — the `P₀/Q₀` rationals — uses **interval-shifted** rationals:
musl splits `x ∈ [2, ∞)` into `[8, ∞)`, `[4.545, 8]`, `[2.857, 4.545]`,
`[2, 2.857]` (the same `1/x²` intervals as SunPro's Erf branches 3/4!),
fitting a separate degree-5/4 rational to each. This is the
"transition-rational" trick: rather than one degree-15 rational
covering `[2, ∞)`, four degree-5 rationals cover narrow intervals at
much higher accuracy per coefficient.

For `n ≥ 2`, musl's `jn.c` uses **Miller backward recurrence**:
choose `M` such that `J_{n+M}(x) / J_n(x) < ε`, set
`J_{n+M+1} = 0, J_{n+M} = 1`, recur downward to `J_0`, rescale by
`J_0(x) / J_0^{recurred}`. The chosen `M` is `n + (large-enough
margin)`; musl's specific formula is in `jn.c` lines 132-159 (the
log/iteration argument).

#### 1.1.2 Alternative landscape

- **Cephes** `j0.c` (Moshier): uses a *zero-factored* rational
  `(z − DR1)·(z − DR2) · P_4(z)/Q_8(z)` for `|x| ≤ 5`, where
  `DR1`, `DR2` are the first two zeros of `J_0` rounded to double
  (`DR1 = 5.78318596...`, `DR2 = 30.47126234...`). This is *cute*
  but loses bits at zeros — the explicit `(z - DR1)` factor is exact
  in the algorithm but doesn't help when `z` is near `DR1` because
  the residual error in `R/S` becomes the dominant uncertainty. musl
  uses no zero factorisation; the rational `R/S` form is intrinsically
  more accurate near zeros (the rational itself encodes the zero
  structure). Cephes claims `4.2e-16` peak (`≈ 2 ULP`); musl claims
  `up to 4ulp error close to 2`. Neither is dramatically better;
  musl wins on **provenance** (byte-identical across 5+ libms).

- **SLATEC** `dbesj.f` (Amos 1977): computes a sequence
  `{J_{ν+i-1}(x) : i = 1, …, N}` for `ν ≥ 0` (so handles
  non-integer ν too — see §1.2). Uses three algorithms (power series
  for `x < ν+30`-ish, Hankel asymptotic for `x > ν+30`-ish, uniform
  asymptotic Olver expansion for `ν > 100`). It is the canonical
  *Fortran* reference but is harder to port verbatim (5-region
  dispatch with `DASYJY` callouts, `DJAIRY` for the turning region).
  For integer `n ≤ 60`, SunPro is simpler and equally accurate.

- **Julia SpecialFunctions.jl** `bessel.jl::besselj(::Cint, ::Float64)`
  (line 416): delegates to `ccall((:jn, libopenlibm), Float64, …)`.
  Openlibm `jn.c` is itself a fork of musl/FreeBSD `e_jn.c`. So
  Julia's path is **the same SunPro 1993 source**, one ccall away.
  This is strong evidence the SunPro algorithm is the right pick.

- **Boost.Math** `bessel_jn.hpp`: only ~125 lines; calls `cyl_bessel_j`
  for `n = 0, 1, 2` directly, then forward-recurs for `n > x` (when
  forward recurrence is stable in the sequence direction — for
  `J_n`, forward recurrence is stable when `n < x`!). For `n > x`,
  Boost uses Steed's CF1 + Wronskian via `bessel_jy.hpp`. This is
  algorithmically a strict superset of Miller's algorithm (Steed's
  CF1 IS Miller in continued-fraction form), but more complex to
  port for the integer-order case.

#### 1.1.3 Recommendation: SunPro 1993 verbatim port

For `BesselJ` with integer order, port `musl/src/math/j0.c`,
`musl/src/math/j1.c`, and `musl/src/math/jn.c` verbatim into
`packages/quadrature/src/special-funcs/bessel-float64.ts`. Reasons:

1. **Public-domain provenance** (Sun 1993 permissive notice carried
   verbatim in all five major libms; same provenance as our Erf via
   `e_erf.c`).
2. **Byte-identical across glibc, musl, FreeBSD, NetBSD, Apple Libm**
   since 1993 (verified cross-checks). 33 years in production.
3. **Same lineage as our Erf substrate** — we get a uniform
   `numerical: true` story across both heads, with the same
   `maskLowWord` DataView helper applicable if needed (j0/j1 don't
   use it; jn might — check `jn.c` lines 196–223 where it asserts
   bit-level constants).
4. **`GET_HIGH_WORD` / `SET_LOW_WORD` macros translate cleanly to
   our existing DataView helpers** (`packages/quadrature/src/
   special-funcs/erf-float64.ts::maskLowWord` is the prior art).
5. The five-region dispatch is *physically motivated* (matches the
   `J_0`'s natural asymptotic structure); coefficients are minimax-
   optimal for each interval.

The SunPro `jn.c` algorithm (for `n ≥ 2`) is **Miller backward
recurrence with a specific `M` choice** (lines 132–159):

```
// Miller's algorithm choice of M (translated to TS pseudocode):
// nm1 = n - 1;
// nm = (3*n) >> 1;             // approximate; for x small
// if (x < 1.86) { ... use forward; ... }   // small x
// else if (n*log2(n) > x) {
//   // backward: M = n + ceil(sqrt(40*n)) typically
// }
```

The exact `M` is computed inside `jn.c` via the loop counter; we
port the loop verbatim rather than re-derive `M`.

### 1.2 `J_ν(x)` — Bessel function of the first kind (real, real order)

#### 1.2.1 Algorithm landscape

For non-integer real `ν` and real `x ≥ 0`, the canonical algorithm
splits by the regime map of §0.2. The three competing implementations
are Cephes `jv.c` (Moshier), Boost.Math `bessel_jy.hpp` (Maddock /
Zhang), and SLATEC `dbesj.f` (Amos). Their algorithmic content:

**Cephes `jv.c` (`sources/float64/cephes/jv.c`, 841 lines):**
five-piece dispatch on `(ν, x)`:

| Branch | Condition                                  | Algorithm                       |
|-------:|--------------------------------------------|---------------------------------|
| (a)    | `x*x < (ν+1)·MACHEP`                       | `(x/2)^ν / Γ(ν+1)` (one-term series) |
| (b)    | `ν ≥ 500`                                  | Uniform asymptotic Olver (`jnx`) or transitional (`jnt`) |
| (c)    | `ν < 21, x > 6, x < 20, ν > 0, ν < 20`     | Backward recurrence (`recur`) from a larger `ν₀` |
| (d)    | small `x`, small `ν`                        | Power series `jvs`                |
| (e)    | large `x`, small `ν`                        | Hankel asymptotic `hankel`        |

The boundary between (d) and (e): for `|ν| < 26`, the boundary is
`x_c = 12.9 + 0.09·ν + 0.0083·ν²`; for `|ν| ≥ 26`, `x_c = 0.9·ν`.
This is a hand-tuned empirical boundary (Moshier comment: "boundary
between convergence of power series and Hankel expansion").

**Boost `bessel_jy.hpp` (`sources/float64/boost/bessel_jy.hpp`, 603 lines):**
unified dispatcher that computes `J_ν(x)` and `Y_ν(x)` together
(both kinds in one pass — Wronskian recovers `J` from `Y` via
`J·Y' − J'·Y = 2/(πx)`):

| Branch | Condition                                  | Algorithm                                                       |
|-------:|--------------------------------------------|-----------------------------------------------------------------|
| (a)    | `kind == need_j && (x < 5 || ν > x²/4)`    | `bessel_j_small_z_series` (DLMF 10.2.2 ascending power series)  |
| (b)    | `x < 1, ε / 2 > (x/2)^{2ν}/ν!`             | Small-z series (both `J` and `Y`)                               |
| (c)    | `asymptotic_bessel_large_x_limit(ν, x)`    | Hankel large-x asymptotic (`bessel_jy_asym.hpp`)                |
| (d)    | `x > 8, hankel_PQ(ν, x, …) converges`      | Hankel P/Q form (A&S 9.2.9/9.2.10)                              |
| (e)    | `x ≤ 2`                                    | Temme series for `Y_u, Y_{u+1}` (`u = ν − round(ν), |u| ≤ 0.5`), then forward-recur `Y`, then Wronskian for `J` |
| (f)    | `x > 2` (the bulk)                          | Steed CF1 (`J'/J`) + CF2 (`P + i·Q`) simultaneously, recover `J` and `Y` jointly |

Boost claims ≤ ~3 ULP across the entire `(ν, x)` plane (Maddock's
internal test suite). The algorithm is significantly more
literate-programming-friendly than Cephes — every regime has a
1-paragraph in-source explanation with a DLMF reference.

**SLATEC `dbesj.f` (`sources/float64/slatec/dbesj.f`, 508 lines):**
Amos 1977 dispatch — sequence-returning (computes
`{J_{ν+i-1}(x) : i = 1, …, N}`). Three algorithms:

1. Power series `J_ν(x) = (x/2)^ν · Σ (-x²/4)^k / (k!·Γ(ν+k+1))`,
   used when `x` is small relative to `ν`.
2. Hankel asymptotic for `x → ∞`.
3. Uniform asymptotic Olver expansion (`dasyjy.f`) for `ν → ∞`.
   This is the load-bearing "turning point" algorithm — combines
   Olver's `g(t)` + `c_k(t)` coefficients with Airy-function values
   (`djairy.f`) at the turning point `x ≈ ν`.

The advantage of SLATEC: explicit handling of the turning region
`x ≈ ν` via the Airy-function asymptotic. The disadvantage: the
algorithm is sequence-only (a single-`ν` call requires `N=1` setup,
some wasted work).

#### 1.2.2 Recommendation: Boost.Math verbatim port

For `BesselJ` with non-integer real ν, port `bessel_jy.hpp` verbatim
into `packages/quadrature/src/special-funcs/bessel-float64.ts`.
Reasons:

1. **Cleanest literate-programming style** in the survey. Every
   regime has a DLMF reference; the in-source comments make the
   algorithmic choice transparent (matches our CLAUDE.md Rule 10).
2. **Unified `J + Y` computation** — Steed's CF1 + CF2 recovers
   both kinds in one pass via Wronskian. We get `BesselYvFloat64`
   "for free" from the same port.
3. **`temme_jy` for small-x near-integer-`ν`** — handles the
   `Y_ν` cancellation trap (§0.4 risk #2) without re-derivation.
4. **Steed's CF1 + CF2 for large-x** — the modern consensus for
   non-integer-ν Bessel. The Cephes equivalent is `recur`, which is
   slower (sequence-style) and has documented edge cases (the
   `cancel` flag is a workaround for a known instability).
5. **Boost license is permissive** — the BSL-1 attribution
   requirement is satisfied by carrying the copyright header into
   our TS source (same discipline as Faddeeva-MIT and Sun-permissive
   for Erf).

Caveat: Boost's code uses C++ template machinery (`Policy`,
`integral_constant<int, N>`, `boost::math::tools::evaluate_polynomial`).
For TS port, instantiate at `N = 53` (the float64 case) and use the
already-existing `chbevl` / `polevl` helpers in
`packages/quadrature/src/special-funcs/erf-float64.ts` (or factor
out into a shared `poly.ts` module if reuse is clear). The
`Policy<>` indirection is C++ specific noise — collapse to direct
constants.

### 1.3 `Y_n(x)` and `Y_ν(x)` — Bessel function of the second kind (real)

#### 1.3.1 Algorithm landscape

For integer `n ≥ 0` and `x > 0`, **SunPro 1993** `e_j0.c` and
`e_j1.c` ship `y0` and `y1` *in the same file as* `j0` and `j1`.
`e_jn.c` ships `yn(n, x)` for integer `n`. The dispatch:

`y0(x)` (musl `j0.c` lines 159-188):

| Branch | Condition       | Algorithm                                                          |
|-------:|-----------------|--------------------------------------------------------------------|
| (a)    | `x = 0`         | `y0(0) = -∞` (`-1/0.0`)                                            |
| (b)    | `x < 0`         | `y0(x) = NaN` (`0/0.0`)                                            |
| (c)    | `x = +∞`        | `y0(+∞) = 0` (`1/x`)                                               |
| (d)    | `x ≥ 2^{-27}, x < 2` | `Y_0(x) = U(x²)/V(x²) + (2/π)·J_0(x)·log(x)`, with `U` deg 6 / `V` deg 4 rationals |
| (e)    | `x ≥ 2`         | Asymptotic `Y_0(x) = √(2/(πx))·(P_0(x)·sin(x₀) + Q_0(x)·cos(x₀))` (same `P_0`, `Q_0` rationals as `J_0`) |

The `(2/π)·J_0(x)·log(x)` term is the load-bearing piece:
`Y_0(x) ~ (2/π)·log(x/2) + (2γ/π)` as `x → 0`, and the additive
log-singularity must be computed **explicitly via `log(x)`** to
preserve precision (factoring out the log first, then adding the
regular part `U/V`). musl does this verbatim.

`yn(n, x)` for `n ≥ 2` (musl `jn.c`): **forward recurrence** is
stable for `Y_n` (the growing solution `J_n` is being correctly
amplified, but it's the one we *don't* want; the recurrence
generates `Y_{n+1}` from `Y_n` and `Y_{n-1}`, and the `Y` solution
dominates as `n` increases for fixed `x`). Specifically:

```
Y_{n+1}(x) = (2n/x) · Y_n(x) − Y_{n-1}(x)        // forward, stable for Y
```

vs the unstable forward recurrence for `J_n` (which is dominated by
the growing `Y_n` solution after roundoff seeds it). musl's
`jn.c::yn` uses forward recurrence verbatim.

#### 1.3.2 Recommendation: SunPro 1993 for integer n; Boost.Math for real ν

For integer `n` (real x): port `musl/j0.c::y0`, `musl/j1.c::y1`,
`musl/jn.c::yn` verbatim.

For non-integer real ν: use Boost.Math `bessel_jy.hpp` as in §1.2
(`Y_ν` is recovered jointly with `J_ν`).

### 1.4 `I_ν(x)` — Modified Bessel function of the first kind (real)

#### 1.4.1 Algorithm landscape

`I_ν(x)` grows like `e^x / √(2π·x)` for large `x`; it has no zeros
on `(0, ∞)` and is monotonically increasing for `x > 0`. The
two regimes are small-`x` (power series) and large-`x` (asymptotic
expansion). Crossover is around `x = 8` for `ν = 0, 1`.

**Boost.Math `bessel_i0.hpp` / `bessel_i1.hpp` (Holoborodko 2015):**
the gold standard for `I_0` / `I_1` float64. Two sub-intervals
(or three for `bessel_i0` — the `x < 7.75` ascending series, the
`7.75 ≤ x < 500` exponentially-scaled rational, the `x ≥ 500`
extra-care rational using `(exp(x/2))²` to avoid overflow):

| Branch       | Condition       | Form                                                                              | Ref                              |
|--------------|-----------------|-----------------------------------------------------------------------------------|----------------------------------|
| (a) `I_0` < 7.75     | `x < 7.75` | `a · P(a) + 1` where `a = x²/4`, `P` deg 14 polynomial in `a`                  | Holoborodko 2015 (advanpix.com)  |
| (b) `I_0` < 500      | `7.75 ≤ x < 500` | `exp(x) · P(1/x) / √x`, `P` deg 21 in `1/x`                                  | Same fit, larger sub-interval    |
| (c) `I_0` ≥ 500      | `x ≥ 500` | `exp(x/2) · P(1/x) / √x · exp(x/2)` (split to avoid `exp(700) = INF`), `P` deg 4 | Same fit; overflow-safe          |

The advantage of Holoborodko's fits over Cephes's 30-term
Chebyshev: tighter ULP bounds (Boost claims `≤ 1.5 ULP` per
sub-interval; Cephes claims `5.8e-16` peak ≈ `~3 ULP`), and the
sub-interval structure naturally handles the overflow split.

**Cephes `i0.c` (Moshier 2000):** two-piece Chebyshev. Same
algorithmic shape as `i0` `[0, 8]` (30-term Chebyshev in
`y = x/2 - 2`) and `[8, ∞)` (25-term Chebyshev in
`y = 32/x - 2`). The Chebyshev form `exp(-x)·I_0(x)` is
pre-multiplied (so the polynomial is bounded), then `exp(x)`
re-multiplied on output. Same trick as Holoborodko but with
larger polynomial degrees.

**SLATEC `dbesi.f` (Amos 1977):** sequence-returning. Three
algorithms (series, asymptotic, Olver uniform). Same character as
`dbesj.f`.

For non-integer real `ν`, Cephes ships `scipy_iv.c` (originally
`iv.c` then renamed when ported to SciPy):

| Branch | Condition       | Algorithm                                                            |
|-------:|-----------------|----------------------------------------------------------------------|
| (a)    | `x = 0, ν = 0`  | `I_0(0) = 1`                                                         |
| (b)    | `x = 0, ν > 0`  | `I_ν(0) = 0`                                                         |
| (c)    | `x = 0, ν < 0`  | overflow (`I_ν(0) = +∞` for non-integer negative ν)                  |
| (d)    | `|ν| > 50`      | `ikv_asymptotic_uniform` (AMS 9.7.7/9.7.8 — Olver uniform asymptotic)|
| (e)    | otherwise        | `ikv_temme` — Temme 1975 (`temme_ik_series` for `x ≤ 2`, `CF2_ik` for `x > 2`), with `CF1_ik` for `I_ν` from `K_ν`/`K_{ν+1}` via Wronskian |

The `ikv_temme` function in `scipy_iv.c` is **Boost's
`bessel_ik.hpp` ported to C**. The structure is byte-identical
(modulo C++/C noise) to `boost/math/special_functions/detail/
bessel_ik.hpp`. So the "Cephes for `Iv`" and "Boost for `Iv`"
recommendations are the same algorithm.

#### 1.4.2 Recommendation: Boost.Math for I_0/I_1; SciPy's ported `ikv_temme` for I_ν

For `BesselI` ν = 0, 1: port `bessel_i0.hpp` and `bessel_i1.hpp`
verbatim (the `integral_constant<int, 53>` specialisation for
float64). The Holoborodko fits are the tightest available
public-domain coefficients.

For `BesselI` ν ∈ ℝ: port `scipy_iv.c::ikv_temme` (and its helpers
`temme_ik_series`, `CF1_ik`, `CF2_ik`). This is Boost's algorithm
already C-ported and battle-tested in SciPy.

### 1.5 `K_ν(x)` — Modified Bessel function of the second kind (real)

#### 1.5.1 Algorithm landscape

`K_ν(x)` decays like `e^{-x} · √(π/(2x))` for large `x`; it has a
log-singularity at `x = 0` (`K_0(x) ~ -log(x/2) − γ`). The
log-singularity makes the small-`x` algorithm *substantially*
different from `I`'s.

**Cephes `k0.c` (Moshier 2000):** the canonical float64 `K_0`.
The algorithm uses `K_0(x) + log(x/2)·I_0(x)` as the Chebyshev-
fitted quantity (this is bounded at `x = 0` — explicitly,
`lim_{x→0} K_0(x) + log(x/2)·I_0(x) = -γ ≈ -0.577`). Then:

```
K_0(x) = chbevl(x² - 2, A, 10) - log(x/2) · I_0(x)        // for x ≤ 2
K_0(x) = exp(-x) · chbevl(8/x - 2, B, 25) / √x            // for x > 2
```

The first form is the load-bearing piece: it requires `I_0(x)` to
be computed accurately (Cephes calls `i0(x)`). The constants in
the `A` array are tabulated for the *bounded* sum `K_0 + log·I_0`,
not for `K_0` directly — this avoids the `-∞` boundary value at `x = 0`.

**Boost.Math:** lacks a dedicated `bessel_k0.hpp` (Boost computes
`K_ν` for arbitrary `ν` via the `Temme` algorithm in
`bessel_ik.hpp`, then specialises to ν=0/1 by template machinery).
For dedicated `K_0` float64 with tight ULP, Cephes wins.

**Julia SpecialFunctions.jl `besselk0`:** delegates to `openlibm`
which doesn't have `K_0` — Julia therefore wraps Amos `zbesk` for
ν=0 too. So Julia's path is *complex-Amos for real `K`*. This
works but is heavyweight for real-axis evaluation.

For non-integer real `ν`, `scipy_iv.c::ikv_temme` (already shipping
`K_ν` jointly with `I_ν` — they're the natural pair via the
Wronskian `I·K' - I'·K = -1/x`) is the recommendation.

#### 1.5.2 Recommendation: Cephes for K_0/K_1; SciPy's `ikv_temme` for K_ν

For `BesselK` ν = 0, 1: port `cephes/k0.c` and `cephes/k1.c`
verbatim. The Chebyshev coefficients for the bounded sum
`K_0 + log·I_0` are the load-bearing piece; we will compute `I_0(x)`
via the Boost.Math `bessel_i0` port (§1.4).

For `BesselK` ν ∈ ℝ: port `scipy_iv.c::ikv_temme` (shared with
`Iv`).

### 1.6 Complex `J_ν(z)`, `Y_ν(z)`, `I_ν(z)`, `K_ν(z)` — the Amos TOMS 644 monolith

#### 1.6.1 Algorithm landscape

For complex `z`, there is **one** canonical float64 algorithm:
**Amos TOMS 644** (`zbesj`, `zbesy`, `zbesi`, `zbesk`, plus
`zbesh` for Hankel functions). The package is in the public domain
(SAND83-0083, SAND83-0643, SAND85-1018, ACM TOMS 1986). It is
wrapped by:

- **SciPy** (`scipy.special.jv`, `yv`, `iv`, `kv` for complex args
  — `wofz` is Faddeeva, not Bessel).
- **Julia** SpecialFunctions.jl (`_besselj`, `_bessely`, `_besseli`,
  `_besselk` via `ccall((:zbesj_, libopenspecfun), …)` in
  `bessel.jl` lines 247–314).
- **GSL** (gsl_sf_bessel_complex_*).
- **Octave** (built-in Bessel for complex).
- **Boost.Math** (Boost's own `bessel.hpp` does NOT cover complex
  args — it explicitly defers to the surface layer to use Amos).
- **FreeFEM**, **deal.II**, **Maxima**, dozens of physics codes.

There is no public-domain competitor. The only alternative is a
direct port of the Amos algorithm; everyone uses it.

#### 1.6.2 The Amos algorithm structure

Amos's `zbesi` (`sources/float64/amos/zbesi.f`, 12,000 chars) is the
load-bearing primitive: every other complex Bessel reduces to `I_ν`
via the algebraic identities

```
J_ν(z) = e^{νπi/2} · I_ν(-iz)                  Im(z) ≥ 0
       = e^{-νπi/2} · I_ν(iz)                  Im(z) < 0     // zbesj.f lines 64-68
Y_ν(z) = (1/i) · [H_ν^{(1)}(z) − cos(πν)·J_ν(z)] · csc(πν) ...   // zbesy.f
K_ν(z) = (π/2) · i^{ν+1} · H_ν^{(1)}(iz)        Re(z) > 0    // zbesk.f
```

So `zbesj.f` delegates to `zbinu.f` (which internally dispatches by
regime to `zseri.f` for small `|z|`, `zmlri.f` for medium `|z|`,
`zasyi.f` for asymptotic, `zuoik.f` for underflow checking, and
`zwrsk.f` for the Wronskian fallback). `zbesy.f` delegates similarly
via `zbesh.f`. `zbesi.f` delegates similarly. `zbesk.f` delegates to
`zbknu.f` for `|z|` small + uniform asymptotic `zunk1.f` / `zunk2.f`
for `|ν|` large.

The dispatch is opaque (the regime decisions are based on
`I1MACH` machine-constant ratios), but Amos's prologue documents
the IERR codes (`ierr ∈ {0, 1, 2, 3, 4, 5}`) which an honest port
must surface as either tagged refusal or successful return.

#### 1.6.3 The Amos dependency tree

For a complete Amos port, the I5a subagent needs all of these
files (sizes confirmed from local downloads):

```
zbesj.f      11577  (entry; delegates to zbesi via J = e^{νπi/2} I(-iz))
zbesy.f      10610  (entry; delegates to zbesh)
zbesi.f      12000  (entry; the load-bearing primitive; delegates to zbinu)
zbesk.f      12275  (entry; delegates to zbknu / zunk1 / zunk2)
zbesh.f      14701  (Hankel H_ν^{(k)}(z), used by zbesy)
zairy.f      14841  (Ai(z) primitive, used by zunhj for turning region)
zbinu.f       3910  (dispatcher inside zbesi; chooses among zseri/zmlri/zasyi/zuoik/zwrsk)
zbknu.f      17030  (K_ν small-|z| primitive; Temme series + Miller backward)
zbuni.f       5450  (K_ν uniform asymptotic for large ν)
zbunk.f       1363  (K_ν dispatcher between zunk1 and zunk2)
zacai.f       3695  (analytic continuation for J/Y)
zacon.f       5978  (analytic continuation for K)
zasyi.f       5034  (asymptotic series for large |z|)
zmlri.f       6048  (Miller backward recurrence for I_ν)
zseri.f       5692  (ascending power series)
zshch.f        549  (sinh/cosh of complex z)
zwrsk.f       3094  (Wronskian fallback)
zs1s2.f       1467  (overflow-safe S1−S2 evaluation)
zrati.f       3789  (ratio I_{ν+1}/I_ν via continued fraction)
zkscl.f       3413  (K_ν scaling)
zuchk.f        819  (underflow check)
zuoik.f       5676  (uniform asymptotic + Olver underflow check)
zunhj.f      20879  (Debye uniform asymptotic for I_ν; the "big one")
zunik.f       6212  (Debye for K_ν)
zunk1.f      12473  (K_ν via Debye, |z| > |ν|)
zunk2.f      14854  (K_ν via Debye, |z| < |ν|)
zuni1.f       5867  (I_ν via Debye, |z| > |ν|)
zuni2.f       7765  (I_ν via Debye, |z| < |ν|)
zlog.f        1128  (complex log)
zexp.f         462  (complex exp)
zsqrt.f       1177  (complex sqrt)
zdiv.f         559  (complex div)
zmlt.f         440  (complex mul)
```

**Total: ~225 KB of Fortran, ~6000 lines once port-style braces are
added.** This is roughly *twice* the size of Faddeeva.cc (Erf's
complex substrate at 2529 lines). The work is mechanical: each
function is 50-300 lines of arithmetic with branching, no recursion,
no allocation, no I/O.

The translation strategy is the one Erf used for Faddeeva.cc: port
each subroutine to a TS function with the same name and signature,
preserve all GOTOs as labelled while-loops + continue/break,
preserve all comments, carry the public-domain notice. Run the
Amos test suite (TOMS 644 ships with an example driver) before
declaring the port complete.

#### 1.6.4 Recommendation: Amos TOMS 644 verbatim port (4 entry points + ~30 callees)

For all four complex Bessel functions, port `zbesj.f`, `zbesy.f`,
`zbesi.f`, `zbesk.f` and their full call graph verbatim. The work
is comparable to Faddeeva.cc; the I5a subagent should:

1. Start with `zbesi.f` (the load-bearing primitive). Get
   `BesselIComplexFloat64(ν, re, im)` working with `KODE=1`
   (unscaled) and `KODE=2` (scaled). Validate against SciPy
   `iv(ν, x + iy)` byte-identical (SciPy IS Amos through the
   shared library).
2. Then port `zbesj.f` which is `~zbesi.f` plus the `exp(νπi/2)`
   prefactor (the algebraic delegation at `zbesj.f` lines 64-68).
3. Then `zbesk.f` (its own `zbknu.f` plus uniform asymptotic
   `zunk1.f`/`zunk2.f`).
4. Then `zbesy.f` which delegates to `zbesh.f`.

The substrate hook is `besselJComplexFloat64`, `besselYComplexFloat64`,
`besselIComplexFloat64`, `besselKComplexFloat64`. Each returns
`{ re: number, im: number }` (or for the multi-`ν` sequence version,
arrays — but the v0.1 substrate only needs scalar).

---

## 2. Coefficient tables (TS-ready, byte-reproducible from primary sources)

Every constant in this section is reproducible verbatim from the
local source file cited at the head of each block. The TS port should
emit each constant as a literal `number` (NOT `Math.fround` — that
re-rounds to single and loses bits). V8 parses each
shortest-round-trip decimal exactly to its IEEE-754 double per
ECMAScript 11.1.3.3.

### 2.1 SunPro 1993 J_0 / Y_0 coefficients (musl `src/math/j0.c`)

```ts
// =============================================================================
// SunPro 1993 J_0(x), Y_0(x) coefficients
// Source: musl src/math/j0.c (origin: FreeBSD /usr/src/lib/msun/src/e_j0.c)
// Copyright 1993 Sun Microsystems, Inc. (permissive notice — preserved verbatim)
// =============================================================================

// Common large-x constants (used by both J_0 and Y_0)
export const INVSQRTPI = 5.64189583547756279280e-01;  // = 1/sqrt(pi); 0x3FE20DD7,0x50429B6D
export const TPI       = 6.36619772367581382433e-01;  // = 2/pi;       0x3FE45F30,0x6DC9C883

// J_0(x) for |x| < 2: rational R(x²)/S(x²), deg 4/4
// Form: J_0(x) = (1 + x/2)·(1 - x/2) + z·(R/S)   where z = x*x
// Error bound: |R/S - exact| ≤ 2^-63.67 over [0, 2]
export const J0_R02 =  1.56249999999999947958e-02;   // 0x3F8FFFFF,0xFFFFFFFD
export const J0_R03 = -1.89979294238854721751e-04;   // 0xBF28E6A5,0xB61AC6E9
export const J0_R04 =  1.82954049532700665670e-06;   // 0x3EBEB1D1,0x0C503919
export const J0_R05 = -4.61832688532103189199e-09;   // 0xBE33D5E7,0x73D63FCE
export const J0_S01 =  1.56191029464890010492e-02;   // 0x3F8FFCE8,0x82C8C2A4
export const J0_S02 =  1.16926784663337450260e-04;   // 0x3F1EA6D2,0xDD57DBF4
export const J0_S03 =  5.13546550207318111446e-07;   // 0x3EA13B54,0xCE84D5A9
export const J0_S04 =  1.16614003333790000205e-09;   // 0x3E1408BC,0xF4745D8F

// Y_0(x) for x in (0, 2): U(x²)/V(x²) + (2/π)·J_0(x)·log(x)
// U: deg 6 in z = x²; V: deg 4 (implicit 1 leading)
// Error bound: |U/V − (Y_0(x) − (2/π)·J_0(x)·log(x))| ≤ 2^-72
export const Y0_U00 = -7.38042951086872317523e-02;   // 0xBFB2E4D6,0x99CBD01F
export const Y0_U01 =  1.76666452509181115538e-01;   // 0x3FC69D01,0x9DE9E3FC
export const Y0_U02 = -1.38185671945596898896e-02;   // 0xBF8C4CE8,0xB16CFA97
export const Y0_U03 =  3.47453432093683650238e-04;   // 0x3F36C54D,0x20B29B6B
export const Y0_U04 = -3.81407053724364161125e-06;   // 0xBECFFEA7,0x73D25CAD
export const Y0_U05 =  1.95590137035022920206e-08;   // 0x3E550057,0x3B4EABD4
export const Y0_U06 = -3.98205194132103398453e-11;   // 0xBDC5E43D,0x693FB3C8
export const Y0_V01 =  1.27304834834123699328e-02;   // 0x3F8A1270,0x91C9C71A
export const Y0_V02 =  7.60068627350353253702e-05;   // 0x3F13ECBB,0xF578C6C1
export const Y0_V03 =  2.59150851840457805467e-07;   // 0x3E91642D,0x7FF202FD
export const Y0_V04 =  4.41110311332675467403e-10;   // 0x3DFE5018,0x3BD6D9EF

// pzero(x) for |x| ≥ 2: 5 sub-intervals (each deg 5/4 rational in s² = 1/x²)
// pR8: x in [8, ∞]
export const PZERO_R8 = [
   0.00000000000000000000e+00,   // pR8[0]; 0x00000000,0x00000000
  -7.03124999999900357484e-02,   // pR8[1]; 0xBFB1FFFF,0xFFFFFD32
  -8.08167041275349795626e+00,   // pR8[2]; 0xC02029D0,0xB44FA779
  -2.57063105679704847262e+02,   // pR8[3]; 0xC0701102,0x7B19E863
  -2.48521641009428822144e+03,   // pR8[4]; 0xC0A36A6E,0xCD4DCAFC
  -5.25304380490729545272e+03,   // pR8[5]; 0xC0B4850B,0x36CC643D
] as const;
export const PZERO_S8 = [
   1.16534364619668181717e+02,   // pS8[0]; 0x405D2233,0x07A96751
   3.83374475364121826715e+03,   // pS8[1]; 0x40ADF37D,0x50596938
   4.05978572648472545552e+04,   // pS8[2]; 0x40E3D2BB,0x6EB6B05F
   1.16752972564375915681e+05,   // pS8[3]; 0x40FC810F,0x8F9FA9BD
   4.76277284146730962675e+04,   // pS8[4]; 0x40E74177,0x4F2C49DC
] as const;
// pR5: x in [8, 4.545]
export const PZERO_R5 = [
  -1.14125464691894502584e-11,   // pR5[0]; 0xBDA918B1,0x47E495CC
  -7.03124940873599280078e-02,   // pR5[1]; 0xBFB1FFFF,0xE69AFBC6
  -4.15961064470587782438e+00,   // pR5[2]; 0xC010A370,0xF90C6BBF
  -6.76747652265167261021e+01,   // pR5[3]; 0xC050EB2F,0x5A7D1783
  -3.31231299649172967747e+02,   // pR5[4]; 0xC074B3B3,0x6742CC63
  -3.46433388365604912451e+02,   // pR5[5]; 0xC075A6EF,0x28A38BD7
] as const;
export const PZERO_S5 = [
   6.07539382692300335975e+01,
   1.05125230595704579173e+03,
   5.97897094333855784498e+03,
   9.62544514357774460223e+03,
   2.40605815922939109441e+03,
] as const;
// pR3: x in [4.547, 2.857]
export const PZERO_R3 = [
  -2.54704601771951915620e-09,
  -7.03119616381481654654e-02,
  -2.40903221549529611423e+00,
  -2.19659774734883086467e+01,
  -5.80791704701737572236e+01,
  -3.14479470594888503854e+01,
] as const;
export const PZERO_S3 = [
   3.58560338055209726349e+01,
   3.61513983050303863820e+02,
   1.19360783792111533330e+03,
   1.12799679856907414432e+03,
   1.73580930813335754692e+02,
] as const;
// pR2: x in [2.857, 2]
export const PZERO_R2 = [
  -8.87534333032526411254e-08,
  -7.03030995483624743247e-02,
  // ... remaining 4 coefficients in musl j0.c lines 247-255 (continue in port)
] as const;
// NOTE: pZERO_R2 and PZERO_S2 continue in `musl/j0.c` lines 247-263;
// the I5a porter should copy verbatim from the source file. Same for
// qzero (Q_0's R/S rationals in lines 271-379 of musl/j0.c).

// qzero coefficient arrays (QZERO_R8, QZERO_S8, QZERO_R5, ..., QZERO_S2)
// follow the same structure — port verbatim from musl/j0.c lines 280-379.
```

**Verification:** all values reproducible byte-for-byte from
`docs/refs/besselj-research/sources/float64/musl/j0.c`. Hex IEEE-754
bit patterns are in the source as inline comments; carry these into
the TS source as verification annotations (same discipline as Erf's
SunPro coefficient port).

### 2.2 SunPro 1993 J_1 / Y_1 coefficients (musl `src/math/j1.c`)

```ts
// J_1(x) for |x| < 2: x · (1/2 + z·(r/s))   where z = x², r/s rational deg 4/4
// Error bound: < 2^-61.51 over [0, 2]
export const J1_R00 = -6.25000000000000000000e-02;   // = -1/16 exact
export const J1_R01 =  1.40705666955189706048e-03;
export const J1_R02 = -1.59955631084035597520e-05;
export const J1_R03 =  4.96727999609584448412e-08;
export const J1_S01 =  1.91537599538363460805e-02;
export const J1_S02 =  1.85946785588630915560e-04;
export const J1_S03 =  1.17718464042623683263e-06;
export const J1_S04 =  5.04636257076217042715e-09;
export const J1_S05 =  1.23542274426137913908e-11;

// Y_1(x) for x in (0, 2): U(x²)/V(x²) + (2/π)·(J_1(x)·log(x) − 1/x)
// U deg 4, V deg 5 (with implicit 1 leading)
// Error bound: |U/V − exact| ≤ 2^-69
export const Y1_U00 = -1.96057090646238940668e-01;
export const Y1_U01 =  5.04438716639811282616e-02;
export const Y1_U02 = -1.91256895875763547298e-03;
export const Y1_U03 =  2.35252600561610495928e-05;
export const Y1_U04 = -9.19099158039878874504e-08;
export const Y1_V00 =  1.99167318236649903973e-02;
export const Y1_V01 =  2.02552581025135171496e-04;
export const Y1_V02 =  1.35608801097516229404e-06;
export const Y1_V03 =  6.22741452364621501295e-09;
export const Y1_V04 =  1.66559246207992079114e-11;

// pone(x) and qone(x) (J_1/Y_1 large-x rationals): port verbatim from
// musl/j1.c lines 200-360. Same 5-interval structure as pzero/qzero
// but different coefficient values (the rationals encode J_1's
// asymptotic phase / amplitude, not J_0's).
```

(Full coefficient block continues in `docs/refs/besselj-research/
sources/float64/musl/j1.c` lines 60-360. The I5a porter should
emit each as a literal `const`.)

### 2.3 SunPro 1993 J_n / Y_n (musl `src/math/jn.c`)

`jn.c` doesn't carry coefficient *tables* — it uses recurrence
(forward for `Y_n`, Miller backward for `J_n`) on top of `J_0`, `J_1`,
`Y_0`, `Y_1`. The only constants are:

```ts
export const JN_INVSQRTPI = 5.641895835477562869480794515607725858440e-01;
                                                          // = 1/sqrt(pi)
export const JN_TWO_OVER_PI = 6.366197723675813430755350534900574e-01;
                                                          // = 2/pi
// Miller's M choice constants are computed in-line via log2 / sqrt; no table.
```

### 2.4 Boost Holoborodko I_0 coefficients (`bessel_i0.hpp`)

```ts
// =============================================================================
// Holoborodko 2015 I_0(x) float64 coefficients
// Source: Boost.Math include/boost/math/special_functions/detail/bessel_i0.hpp
// integral_constant<int, 53> specialisation
// Reference: Pavel Holoborodko, "Rational Approximations for the Modified
//            Bessel Function of the First Kind - I0(x) for Computations with
//            Double Precision",
//            http://www.advanpix.com/2015/11/11/rational-approximations-for-...
// License: Boost (BSL-1)
// =============================================================================

// I_0(x) for x < 7.75: a·P(a) + 1, with a = x²/4, P deg 14
// Error: ≤ 3.042e-18 (interpolated), Poly ≤ 5.107e-16 (53-bit float)
export const I0_P_SMALL = [
  1.00000000000000000e+00,       // P[0]
  2.49999999999999909e-01,       // P[1]   ≈ 1/4
  2.77777777777782257e-02,       // P[2]   ≈ 1/36
  1.73611111111023792e-03,       // P[3]   ≈ 1/576
  6.94444444453352521e-05,       // P[4]
  1.92901234513219920e-06,       // P[5]
  3.93675991102510739e-08,       // P[6]
  6.15118672704439289e-10,       // P[7]
  7.59407002058973446e-12,       // P[8]
  7.59389793369836367e-14,       // P[9]
  6.27767773636292611e-16,       // P[10]
  4.34709704153272287e-18,       // P[11]
  2.63417742690109154e-20,       // P[12]
  1.13943037744822825e-22,       // P[13]
  9.07926920085624812e-25,       // P[14]
] as const;

// I_0(x) for 7.75 ≤ x < 500: exp(x) · P(1/x) / sqrt(x), P deg 21
// Error: ≤ 1.685e-16 (interpolated), Poly ≤ 2.575e-16
export const I0_P_MEDIUM = [
   3.98942280401425088e-01,       // P[0]  ≈ 1/sqrt(2π)
   4.98677850604961985e-02,       // P[1]
   2.80506233928312623e-02,       // P[2]
   2.92211225166047873e-02,       // P[3]
   4.44207299493659561e-02,       // P[4]
   1.30970574605856719e-01,       // P[5]
  -3.35052280231727022e+00,       // P[6]
   2.33025711583514727e+02,       // P[7]
  -1.13366350697172355e+04,       // P[8]
   4.24057674317867331e+05,       // P[9]
  -1.23157028595698731e+07,       // P[10]
   2.80231938155267516e+08,       // P[11]
  -5.01883999713777929e+09,       // P[12]
   7.08029243015109113e+10,       // P[13]
  -7.84261082124811106e+11,       // P[14]
   6.76825737854096565e+12,       // P[15]
  -4.49034849696138065e+13,       // P[16]
   2.24155239966958995e+14,       // P[17]
  -8.13426467865659318e+14,       // P[18]
   2.02391097391687777e+15,       // P[19]
  -3.08675715295370878e+15,       // P[20]
   2.17587543863819074e+15,       // P[21]
] as const;

// I_0(x) for x ≥ 500: exp(x/2) · P(1/x) / sqrt(x) · exp(x/2)  (split to avoid overflow)
// P deg 4
// Error: ≤ 2.437e-18 (interpolated), Poly ≤ 1.217e-16
export const I0_P_LARGE = [
  3.98942280401432905e-01,
  4.98677850491434560e-02,
  2.80506308916506102e-02,
  2.92179096853915176e-02,
  4.53371208762579442e-02,
] as const;
```

### 2.5 Boost Holoborodko I_1 coefficients (`bessel_i1.hpp`)

Port verbatim from `sources/float64/boost/bessel_i1.hpp` lines 100-310
(the `integral_constant<int, 53>` specialisation). Same 3-interval
structure as `I_0`; coefficient values differ. (Not reproduced here;
the file is 556 lines and the coefficients are straightforward arrays.)

### 2.6 Cephes K_0 / K_1 coefficients (Chebyshev expansions)

```ts
// =============================================================================
// Moshier 2000 K_0(x), K_1(x) Chebyshev coefficients
// Source: scipy/special/cephes/k0.c, k1.c (Cephes Math Library Release 2.8)
// Copyright 1984, 1987, 2000 by Stephen L. Moshier (BSD-style permissive)
// =============================================================================

// K_0(x) for x ≤ 2: chbevl(x² - 2, A, 10) − log(x/2)·I_0(x)
// Chebyshev expansion of K_0(x) + log(x/2)·I_0(x) over [0, 2]
// Limit: lim_{x→0} K_0(x) + log(x/2)·I_0(x) = -γ = -0.5772156649…
export const K0_A = [
   1.37446543561352307156e-16,   // A[0]
   4.25981614279661018399e-14,   // A[1]
   1.03496952576338420167e-11,
   1.90451637722020886025e-9,
   2.53479107902614945675e-7,
   2.28621210311945178607e-5,
   1.26461541144692592338e-3,
   3.59799365153615016266e-2,
   3.44289899924628486886e-1,
  -5.35327393233902768720e-1,
] as const;

// K_0(x) for x > 2: exp(-x) · chbevl(8/x - 2, B, 25) / sqrt(x)
// Chebyshev expansion of exp(x)·sqrt(x)·K_0(x) over [2, ∞)
// Limit: lim_{x→∞} exp(x)·sqrt(x)·K_0(x) = sqrt(π/2)
export const K0_B = [
   5.30043377268626276149e-18,   // B[0]
  -1.64758043015242134646e-17,
   5.21039150503902756861e-17,
  -1.67823109680541210385e-16,
   5.51205597852431940784e-16,
  -1.84859337734377901440e-15,
   6.34007647740507060557e-15,
  -2.22751332699166985548e-14,
   8.03289077536357521100e-14,
  -2.98009692317273043925e-13,
   1.14034058820847496303e-12,
  -4.51459788337394416547e-12,
   1.85594911495471785253e-11,
  -7.95748924447710747776e-11,
   3.57739728140030116597e-10,
  -1.69753450938905987466e-9,
   8.57403401741422608519e-9,
  -4.66048989768794782956e-8,
   2.76681363944501510342e-7,
  -1.83175552271911948767e-6,
   1.39498137188764993662e-5,
  -1.28495495816278026384e-4,
   1.56988388573005337491e-3,
  -3.14481013119645005427e-2,
   2.44030308206595545468e0,
] as const;
```

```ts
// K_1(x) for x ≤ 2: log(x/2)·I_1(x) + chbevl(x²-2, A, 11)/x
// Chebyshev expansion of x·(K_1(x) − log(x/2)·I_1(x)) over [0, 2]
// Limit: lim_{x→0} x·(K_1(x) − log(x/2)·I_1(x)) = 1
export const K1_A = [
  -7.02386347938628759343e-18,   // A[0]
  -2.42744985051936593393e-15,
  -6.66690169419932900609e-13,
  -1.41148839263352776110e-10,
  -2.21338763073472585583e-8,
  -2.43340614156596823496e-6,
  -1.73028895751305206302e-4,
  -6.97572385963986435018e-3,
  -1.22611180822657148235e-1,
  -3.53155960776544875667e-1,
   1.52530022733894777053e0,
] as const;

// K_1(x) for x > 2: exp(-x) · chbevl(8/x - 2, B, 25) / sqrt(x)
// Chebyshev expansion of exp(x)·sqrt(x)·K_1(x) over [2, ∞)
// Limit: lim_{x→∞} exp(x)·sqrt(x)·K_1(x) = sqrt(π/2)
export const K1_B = [
  -5.75674448366501715755e-18,
   1.79405087314755922667e-17,
  -5.68946255844285935196e-17,
   1.83809354436663880070e-16,
  -6.05704724837331885336e-16,
   2.03870316562433424052e-15,
  -7.01983709041831346144e-15,
   2.47715442448130437068e-14,
  -8.97670518232499435011e-14,
   3.34841966607842919884e-13,
  -1.28917396095102890680e-12,
   5.13963967348173025100e-12,
  -2.12996783842756842877e-11,
   9.21831518760500529508e-11,
  -4.19035475934189648750e-10,
   2.01504975519703286596e-9,
  -1.03457624656780970260e-8,
   5.74108412545004946722e-8,
  -3.50196060308781257119e-7,
   2.40648494783721712015e-6,
  -1.93619797416608296024e-5,
   1.95215518471351631108e-4,
  -2.85781685962277938680e-3,
   1.03923736576817238437e-1,
   2.72062619048444266945e0,
] as const;
```

### 2.7 Cephes I_0 / I_1 Chebyshev coefficients (for `i0e` / `i1e` scaled)

The Cephes `i0` / `i1` Chebyshev coefficients (`sources/float64/
cephes/i0.c` lines 83-147 and `i1.c` lines 85-148) are tabulated for
the **scaled** form `exp(-x)·I_0(x)` (resp. `exp(-x)·I_1(x)/x`).
Reproduce verbatim from those files. They are recommended for the
`besselI0Scaled` / `besselI1Scaled` paths if Boost's
Holoborodko (which doesn't ship a scaled form directly) is too
indirect for the I5a port; alternatively, compute scaled by removing
the leading `exp(x)` factor from Boost's `bessel_i0_imp`.

### 2.8 SciPy `scipy_iv.c` uniform-asymptotic Olver coefficients

```ts
// =============================================================================
// AMS 9.3.9 / 9.3.10 uniform asymptotic Olver expansion coefficients
// Source: scipy/special/cephes/scipy_iv.c lines 196-243
// Used in ikv_asymptotic_uniform (|ν| > 50)
// 11 polynomials u_k(t), each at most deg 30 (in t), most coefficients zero
// =============================================================================

// asymptotic_ufactors[N_UFACTORS][N_UFACTOR_TERMS] = [11][31]
// Translated to TS as a Float64Array[11][31] or readonly number[][]
// (the literal block is 50+ lines; port verbatim from scipy_iv.c)
export const ASYMPTOTIC_UFACTORS: readonly (readonly number[])[] = [
  // u_0(t) = 1 (constant)
  [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0, 1],
  // u_1(t) = -5/24 t³ + 1/8 t
  [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,
    -0.20833333333333334, 0.0, 0.125, 0.0],
  // u_2(t) = 0.334... t⁵ - 0.401... t³ + 0.0703... t
  [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,
    0.3342013888888889, 0.0,
    -0.40104166666666669, 0.0,
    0.0703125, 0.0, 0.0],
  // u_3(t) ... u_10(t) — port verbatim from scipy_iv.c lines 206-243
  // (The full 11×31 table is in `scipy_iv.c`; reproduced inline above
  // for u_0 to u_2 to show the structure. The I5a porter should copy
  // the C literal block byte-for-byte.)
] as const;
```

### 2.9 SciPy `scipy_iv.c` Temme series + CF1 + CF2 coefficients

The Temme series for `K_ν` / `K_{ν+1}` (`temme_ik_series` in
`scipy_iv.c` lines 352-410) uses **derived** coefficients (`gp`, `gm`
from `gamma(ν+1) - 1`, `c = sin(πν)/(πν)`, etc.) — no static
tables. Port the algorithm verbatim; the constants are computed
at call time. Similarly for `CF1_ik` (lines 414-458) and `CF2_ik`
(lines 465-520).

### 2.10 Amos TOMS 644 coefficients (complex Bessel)

Amos's complex Bessel routines (`zbesj`, `zbesy`, `zbesi`, `zbesk`)
**do** carry static tables — most notably in `zunhj.f` (the Debye
uniform asymptotic), which has the `ar`, `br`, `c`, `alfa`, `beta`,
`gama` coefficient arrays. The full block is ~250 lines of literal
DATA statements in `zunhj.f` (the file is 714 lines total).

```ts
// =============================================================================
// Amos TOMS 644 Debye coefficients (zunhj.f)
// Source: sources/float64/amos/zunhj.f
// Public domain (Sandia National Labs; TOMS 644 release notice)
// =============================================================================

// ar[14] — Debye polynomial coefficients for the leading expansion
// (from zunhj.f lines ~50-65; the I5a porter should copy verbatim)
export const AMOS_AR = [
  1.00000000000000000e+00,       // ar[0]
  1.04166666666666667e-01,       // ar[1]   = 1/3 · 5/16 = 25/48? — copy verbatim
  // ... 12 more values from zunhj.f DATA AR / 1.000... / statements
] as const;

// Similarly: br, c, alfa, beta, gama (all in zunhj.f)
// Port each as a const Array. Verification: every coefficient matches
// the corresponding DATA statement in zunhj.f byte-for-byte (to the
// precision Fortran emits, which is full float64).
```

The I5a porter MUST extract these tables from `zunhj.f` and the
other Amos files; this artefact doesn't reproduce them in full
because they are large (200+ doubles) and the verbatim source
extraction is mechanical (Fortran DATA statements → TS array
literals, one-for-one).

### 2.11 SLATEC `dasyjy.f` Olver uniform-asymptotic coefficients

Same character as Amos's `zunhj.f` — `dasyjy.f` carries the real-
valued Olver coefficients for `J_ν` / `Y_ν` at large `ν`. Reproducible
from `sources/float64/slatec/dasyjy.f`. Only needed if the I5a
porter chooses SLATEC over Boost for non-integer real `ν` — but
the recommendation in §1.2 is Boost, so these coefficients are a
fallback for cross-validation.

---

## 3. Edge-case table (per function, all four heads)

The columns enumerate the inputs that exercise every honest boundary
of the float64 substrate. The rows specify the chosen behaviour for
each input value, with the source attribution. Where competing oracle
implementations disagree, we pick the one that matches IEEE-754 +
DLMF analytic continuation; flagged in the table as **[DIVERGE]**.

### 3.1 `BesselJ` edge cases

| Input                          | `J_0`         | `J_1`         | `J_n` (n≥2)       | `J_ν` (real ν)                          | `J_ν` (complex z)                    |
|--------------------------------|---------------|---------------|-------------------|------------------------------------------|--------------------------------------|
| `x = +0`                       | `1`           | `0`           | `0` (for `n ≥ 1`) | `0` for `ν > 0`; `1` for `ν = 0`; **overflow** (`+∞`) for `ν < 0` non-integer | `0` for `ν > 0`; `1` for `ν = 0` |
| `x = -0`                       | `1` (even)    | `-0`          | `0` for even `n`; `-0` for odd | symmetric reflection                                | as for real                            |
| `x = +∞`                       | `0`           | `0`           | `0`               | `0`                                      | depends on `arg(z)`                  |
| `x = -∞`                       | `0`           | `0` (`J_1(-∞) = 0`) | `0`         | `NaN` for non-integer `ν` (multi-valued); `(-1)^n · 0` for integer | as complex                  |
| `x = NaN`                      | `NaN`         | `NaN`         | `NaN`             | `NaN`                                    | `NaN`                                |
| `x` subnormal `±1e-310`        | `1 − x²/4 ≈ 1` (preserved) | `x/2 + O(x³)` (preserved) | `(x/2)^n / n!` (underflow to 0 for `n ≥ 2`) | `(x/2)^ν / Γ(ν+1)` (underflow honestly) | linear extrapolation              |
| `x < 0`, ν not integer         | OK (even)     | OK (odd)      | OK (sign-`flip` for odd `n`) | **`RangeError`** (Cephes refuses; we should too) | OK (full complex plane) |
| `x = 1e10` (large)             | OK (Hankel)   | OK (Hankel)   | OK (sequence forward) | OK (Hankel)                        | OK if `|Im z| < 700`; else **overflow** |
| `ν = +0`                       | n/a           | n/a           | n/a               | `J_0(x)`                                | `J_0(z)`                             |
| `ν = +∞`                       | n/a           | n/a           | n/a               | `0` (Stirling decay of `Γ(ν+1)`)        | `0`                                  |
| `ν = NaN`                      | n/a           | n/a           | n/a               | `NaN`                                    | `NaN`                                |
| `ν = 1/2`                      | n/a           | n/a           | n/a               | `√(2/(πx)) · sin(x)` (DLMF 10.49.1) — closed form; *should be canonicalized* in cas-simplify, not handled in float64 dispatch | analogous |
| `ν = -1/2`                     | n/a           | n/a           | n/a               | `√(2/(πx)) · cos(x)`                     | analogous                            |
| `ν` huge integer (e.g. ν=1000) | n/a           | n/a           | OK (Olver uniform expected; if not yet implemented, route to Boost-jy) | OK (Boost-jy)                | OK (Amos with `IERR=3` warning) |
| `|x| ≈ ν` (turning region)     | n/a           | n/a           | OK (boundary)     | Boost's Steed CF1+CF2 handles            | Amos's Debye handles                 |
| `z = ±i·∞`                     | n/a           | n/a           | n/a               | n/a                                      | **overflow** (`exp(|Im z|)` blows up) — should clamp to ±∞ with sign of `J_ν(z)` predicted by Hankel asymptotic |
| `z = 0+i·y` (pure imaginary)   | n/a           | n/a           | n/a               | n/a                                      | `J_ν(iy) = i^ν · I_ν(y)` (algebraic) — Amos handles |

**Sign convention:** `J_n(-x) = (-1)^n · J_n(x)` for integer `n`.
The musl `j0` returns `j0(|x|)` directly (even). musl `j1` uses
`return -j1(-x)` for negative `x` (odd). Port this verbatim.

### 3.2 `BesselY` edge cases

| Input                          | `Y_0`           | `Y_1`           | `Y_n` (n≥2)         | `Y_ν` (real ν)                | `Y_ν` (complex z)              |
|--------------------------------|-----------------|-----------------|---------------------|--------------------------------|--------------------------------|
| `x = +0`                       | `-∞`            | `-∞`            | `-∞`                | `-∞` for non-int ν > 0; `-∞` for ν=0 | `-∞` along real axis    |
| `x = -0`                       | `-∞` (limit from above) | `-∞`     | `-∞`                | `-∞`                            | analogous                      |
| `x < 0`                        | `NaN` (musl)    | `NaN`           | `NaN`               | `NaN` (Cephes refuses)         | OK (Amos handles full complex plane) |
| `x = +∞`                       | `0`             | `0`             | `0`                 | `0`                             | depends on `arg z`             |
| `x = NaN`                      | `NaN`           | `NaN`           | `NaN`               | `NaN`                           | `NaN`                          |
| `ν = +0`                       | n/a             | n/a             | n/a                 | `Y_0(x)`                        | `Y_0(z)`                       |
| `ν = +∞`                       | n/a             | n/a             | n/a                 | `-∞` for `x` finite             | depends                        |
| `ν = NaN`                      | n/a             | n/a             | n/a                 | `NaN`                           | `NaN`                          |
| `ν = 1/2`                      | n/a             | n/a             | n/a                 | `-√(2/(πx)) · cos(x)` (DLMF 10.49.5) — closed form | analogous     |
| `ν` near integer (cancellation)| n/a             | n/a             | n/a                 | Boost `temme_jy` handles        | Amos handles                   |
| `|x| ≈ ν` (turning region)     | n/a             | n/a             | n/a                 | Boost Steed handles             | Amos Debye handles             |
| `x → 0`, `ν > 0` non-integer   | n/a             | n/a             | n/a                 | `-Γ(ν)/π · (x/2)^{-ν}` — overflow for large ν | analogous   |

### 3.3 `BesselI` edge cases

| Input                          | `I_0`           | `I_1`           | `I_n` (n≥2)         | `I_ν` (real ν)                | `I_ν` (complex z)              |
|--------------------------------|-----------------|-----------------|---------------------|--------------------------------|--------------------------------|
| `x = +0`                       | `1`             | `0`             | `0`                 | `0` for ν > 0; `1` for ν = 0; `+∞` for ν < 0 non-integer (overflow) | analogous |
| `x = -0`                       | `1`             | `-0` (odd)      | `0` for even n; `-0` odd | `(-x)^ν · I_ν` via reflection | analogous                |
| `x = +∞`                       | `+∞` (overflow) | `+∞`            | `+∞`                | `+∞`                            | depends on `arg z`             |
| `x = -∞`                       | `+∞` (even)     | `-∞` (odd)      | `±∞`                | undefined for non-integer ν    | as complex                     |
| `x = NaN`                      | `NaN`           | `NaN`           | `NaN`               | `NaN`                           | `NaN`                          |
| `x` subnormal                  | `1 + (x/2)²`    | `x/2 + O(x³)`   | `(x/2)^n / n!` (underflow for n large) | similar                  | linear extrapolation            |
| `x > 700` (overflow threshold) | **`+∞`** (saturation; route to scaled `i0e(x) · exp(x)` if exp(x) finite) | similar | similar | **`+∞`** for `x > ELIM` | overflow flag from Amos    |
| `ν = -ν₀ < 0` non-integer      | n/a             | n/a             | n/a                 | `I_{-ν}(x) = I_ν(x) + (2/π)·sin(πν)·K_ν(x)` — Cephes handles | analogous   |
| `ν` ≥ 50 (uniform asymptotic)  | n/a             | n/a             | n/a                 | SciPy `ikv_asymptotic_uniform` | Amos `zuni1`/`zuni2`           |

### 3.4 `BesselK` edge cases

| Input                          | `K_0`           | `K_1`           | `K_n` (n≥2)         | `K_ν` (real ν)                | `K_ν` (complex z)              |
|--------------------------------|-----------------|-----------------|---------------------|--------------------------------|--------------------------------|
| `x = +0`                       | `+∞` (log singularity) | `+∞`     | `+∞`                | `+∞`                            | `+∞` along positive real axis  |
| `x = -0`                       | **`+∞`** (limit from above) | `+∞` | `+∞`             | `+∞`                            | `NaN` (cross-cut)              |
| `x < 0`                        | `NaN` (Cephes refuses)  | `NaN`  | `NaN`               | `NaN`                           | OK (Amos handles full plane)    |
| `x = +∞`                       | `0`             | `0`             | `0`                 | `0`                             | depends                        |
| `x = NaN`                      | `NaN`           | `NaN`           | `NaN`               | `NaN`                           | `NaN`                          |
| `x` subnormal                  | `-log(x/2) - γ` (preserve via log) | `-log(x/2)`-style | `(n-1)!/2 · (x/2)^{-n}` | analogous              | analogous                |
| `x < ELIM_UNDER` (small)       | normal          | normal          | normal              | normal                          | normal                         |
| `x > 700` (decay threshold)    | underflow to `0` (saturation); route to scaled `k0e(x) · exp(-x)` if `exp(-x) > 0` | similar | similar | **`0`** | underflow flag from Amos |
| `ν = ν₀ ≥ 0` (symmetric)       | n/a             | n/a             | n/a                 | `K_{-ν}(x) = K_ν(x)` (symmetric — exact in float64) | analogous |
| `ν` ≥ 50 (uniform asymptotic)  | n/a             | n/a             | n/a                 | SciPy `ikv_asymptotic_uniform` | Amos `zunk1`/`zunk2`           |
| `z = 0 + i·y` (imaginary)      | n/a             | n/a             | n/a                 | n/a                             | `K_ν(iy)` — Amos handles via `zbesh` route |

### 3.5 General-purpose row: NaN/Inf propagation contract

Every Bessel head MUST satisfy the following IEEE-754 contract:

```
besselXXX(NaN, x)        === NaN       // for any (ν, x)
besselXXX(ν, NaN)        === NaN       //
besselXXX(±Inf, x)       === undefined (route to honest refusal)
besselXXX(ν, ±Inf)       === (per row above)
```

NaN propagation MUST be a single early-return at the function entry,
not a downstream behaviour of the polynomial evaluation. The reason:
`polyval(NaN, …)` returns `NaN`, but `exp(NaN) * polyval(NaN, …) / sqrt(NaN)`
in JS may emit warnings, allocate intermediate boxed numbers, or
trip platform-specific behaviour (V8 has been observed to return
`NaN` here, but the contract is to be explicit). Mirror musl's
`if (ix >= 0x7ff00000) return 1/(x*x);` pattern (which returns `NaN`
for NaN input and `0` for `+∞` input via the same expression).

### 3.6 The "matches SciPy byte-for-byte where possible" discipline

For inputs where SciPy is correct (the vast majority of the
`(ν, x)` plane), our output should match SciPy byte-for-byte
(`numerical: true` modulo platform fingerprint). For inputs where
SciPy is wrong (e.g. SciPy `iv` for very small `x` and large
negative `ν` triggers `sf_error("iv", SF_ERROR_OVERFLOW)` and
returns `Infinity` instead of the analytically correct value),
**refuse honestly with `RangeError`** rather than emit a number we
know is wrong. This is the same discipline as Erf's
`erfcinv(y < 0)` → `RangeError`.

---

## 4. Algorithm-piece dispatch table (per function)

This section presents the dispatch decision the TS port must make
for each `(ν, x)` input. Branch labels match the source-code
comments where possible.

### 4.1 `BesselJFloat64(ν, x)` dispatch

```
                                                                                       
       ┌─ x < 0 && ν ∉ ℤ ──> RangeError (or accept and use J(ν,-x) reflection
       │                                  if extended-real interpretation desired)
       │                                                                              
       ├─ x = 0 ──> 1 if ν = 0; 0 if ν > 0; +∞ if ν < 0 non-integer (overflow)
       │                                                                              
       ├─ x²·(ν+1) < MACHEP·... ──> (x/2)^ν / Γ(ν+1)   (one-term series; Cephes line 110)
       │                                                                              
       ├─ ν ∈ ℤ:                                                                       
       │    │                                                                          
       │    ├─ ν = 0 ──> SunPro j0(x)        (musl/j0.c)                              
       │    ├─ ν = 1 ──> SunPro j1(x)        (musl/j1.c)                              
       │    └─ ν ≥ 2 ──> SunPro jn(n, x)     (musl/jn.c, Miller backward recurrence) 
       │                                                                              
       └─ ν ∉ ℤ:                                                                       
            │                                                                          
            ├─ x < 5 OR ν > x²/4    ──> Boost bessel_j_small_z_series (bessel_jy_series.hpp)
            ├─ asymptotic_large_x   ──> Boost asymptotic_bessel_j_large_x_2          
            ├─ x > 8 AND hankel_PQ_converges
            │                       ──> Boost hankel_PQ form                          
            ├─ x ≤ 2                ──> Boost temme_jy + forward-recur Y, Wronskian J
            └─ x > 2                ──> Boost Steed CF1 + CF2 (the bulk; bessel_jy.hpp:466)
```

### 4.2 `BesselYFloat64(ν, x)` dispatch

```
       ┌─ x ≤ 0 ──> -∞ if x = 0; NaN if x < 0 (Cephes refusal)
       │                                                                              
       ├─ x = NaN OR ν = NaN ──> NaN                                                  
       │                                                                              
       ├─ ν ∈ ℤ:                                                                       
       │    ├─ ν = 0 ──> SunPro y0(x)        (musl/j0.c lines 159-188)                 
       │    ├─ ν = 1 ──> SunPro y1(x)        (musl/j1.c lines 199-225)                
       │    └─ ν ≥ 2 ──> SunPro yn(n, x)     (musl/jn.c, forward-recurrence STABLE)   
       │                                                                              
       └─ ν ∉ ℤ:                                                                       
            ├─ Same Boost bessel_jy.hpp dispatch as J_ν (Y_ν computed jointly)
            └─ Reflection: Y_{-ν}(x) = cos(πν)·Y_ν(x) − sin(πν)·J_ν(x)
```

### 4.3 `BesselIFloat64(ν, x)` dispatch

```
       ┌─ x = 0 ──> 1 if ν = 0; 0 if ν > 0; +∞ if ν < 0 non-integer
       │                                                                              
       ├─ x < 0 AND ν ∉ ℤ ──> NaN (`sf_error("iv", SF_ERROR_DOMAIN)`)                  
       ├─ x < 0 AND ν ∈ ℤ ──> sign = (-1)^ν, work on |x|                              
       │                                                                              
       ├─ x > ELIM_OVER (≈ 700) ──> +∞ (saturation; route to scaled if exp(x) finite) 
       │                                                                              
       ├─ ν ∈ {0, 1}:                                                                  
       │    ├─ ν = 0 ──> Boost bessel_i0_imp<53>(x)                                   
       │    │                                                                          
       │    │    ├─ x < 7.75   ──> ascending series (deg 14 P)                        
       │    │    ├─ x < 500    ──> exp(x) · P(1/x) / sqrt(x)  (deg 21 P)              
       │    │    └─ x ≥ 500    ──> (exp(x/2))² split   (deg 4 P, overflow-safe)        
       │    │                                                                          
       │    └─ ν = 1 ──> Boost bessel_i1_imp<53>(x)                                   
       │         (similar 3-sub-interval structure)                                   
       │                                                                              
       └─ ν ∉ {0, 1}:                                                                  
            │                                                                          
            ├─ |ν| > 50 ──> ikv_asymptotic_uniform (scipy_iv.c lines 249-331)         
            │              (Olver uniform asymptotic AMS 9.7.7/9.7.8)                
            │                                                                          
            └─ |ν| ≤ 50 ──> ikv_temme (scipy_iv.c lines 532-654)                      
                   │                                                                  
                   ├─ x ≤ 2 ──> temme_ik_series   (Temme 1975)                        
                   ├─ x > 2 ──> CF2_ik (continued fraction for K_ν, K_{ν+1})         
                   │                                                                  
                   ├─ if need I:  CF1_ik for I_{ν+1}/I_ν, then Wronskian              
                   └─ if need K:  forward-recur K_ν from K_u, K_{u+1}                 
```

### 4.4 `BesselKFloat64(ν, x)` dispatch

```
       ┌─ x ≤ 0 ──> +∞ if x = 0; NaN if x < 0
       │                                                                              
       ├─ x > ELIM_UNDER (≈ 700) ──> 0 (saturation; route to scaled if exp(-x) > 0)  
       │                                                                              
       ├─ ν ∈ {0, 1}:                                                                  
       │    ├─ ν = 0 ──> Cephes k0(x)        (cephes/k0.c)                            
       │    │   ├─ x ≤ 2 ──> chbevl(x²-2, A, 10) − log(x/2)·I_0(x)  (load-bearing)     
       │    │   └─ x > 2 ──> exp(-x) · chbevl(8/x-2, B, 25) / sqrt(x)                 
       │    │                                                                          
       │    └─ ν = 1 ──> Cephes k1(x)        (cephes/k1.c, same shape)                
       │                                                                              
       └─ ν ∉ {0, 1}:                                                                  
            ├─ Same ikv_temme as I_ν (K_ν computed jointly; see §4.3 ν ∉ {0,1} block)
            └─ K_{-ν}(x) = K_ν(x)  (exact symmetry; reflect inside the routine)
```

### 4.5 Complex `BesselXXXComplexFloat64(ν, re, im)` dispatch

All four complex Bessel heads dispatch via Amos. The structure
(per `zbesi.f` lines 156-265, representative of all four):

```
       ┌─ FNU < 0  OR  KODE ∉ {1, 2}  OR  N < 1    ──> IERR=1 (input error)
       │                                                                              
       ├─ |z| > U2 = 0.5/UR (≈ 1.8e16)  ──> IERR=4 (no computation)                   
       ├─ |z| > U1 = sqrt(U2) (≈ 1.3e8) ──> IERR=3 (half-precision warning)           
       │                                                                              
       ├─ Compute machine-constant-dependent thresholds:                              
       │    TOL = max(D1MACH(4), 1e-18)    // 2.22e-16 for IEEE                       
       │    ELIM = 2.303·(I1MACH(15)·D1MACH(5) - 3.0)   // ≈ 700                      
       │    ALIM = ELIM + max(-2.303·DIG, -41.45)        // overflow safety margin    
       │    RL = 1.2·DIG + 3                              // ≈ 21 for double          
       │    FNUL = 10 + 6·(DIG - 3)                       // ≈ 100                    
       │                                                                              
       ├─ Reflect z into right half plane: ZN = (ZI, -ZR) if Re(z) ≤ 0                
       │                                                                              
       ├─ Call ZBINU(ZN, FNU, KODE, N, …, RL, FNUL, TOL, ELIM, ALIM)                  
       │                                                                              
       │   Inside ZBINU (the dispatcher):                                              
       │    ├─ |z| ≤ RL           ──> ZSERI (ascending series)                        
       │    ├─ |z| > FNUL         ──> ZASYI (asymptotic series for large |z|)         
       │    ├─ otherwise:                                                              
       │    │    ├─ FNU < FNUL    ──> ZMLRI (Miller backward) + ZUOIK underflow check 
       │    │    └─ FNU ≥ FNUL    ──> ZUNI1 / ZUNI2 (Debye uniform asymptotic)        
       │    │                                                                          
       │    └─ Wronskian fallback ZWRSK if any of the above underflow                 
       │                                                                              
       ├─ Apply CSGN = exp(FNU·π·i/2) prefactor (or its conjugate per Im(z) sign)    
       │   (zbesj.f line 244-247; this is the algebraic delegation I → J)             
       │                                                                              
       └─ Return CY[1..N] with NZ (count of underflowed components)                   
```

The crucial point: **every dispatch decision is data-driven by
machine constants** (`I1MACH`, `D1MACH`). The TS port should
either (a) hard-code the IEEE-754 double constants for `TOL`,
`ELIM`, `ALIM`, `RL`, `FNUL` once (since the substrate is float64-
only, the values are fixed) or (b) compute them from
`Number.EPSILON`, `Number.MAX_VALUE`, etc. Choice (a) is simpler
and matches the verbatim-port discipline; the constants for IEEE-754
double are well-known:

```ts
// IEEE-754 double-precision Amos constants (from D1MACH/I1MACH for `double`)
export const AMOS_TOL  = 2.220446049250313e-16;   // = DBL_EPSILON (= 2^-52)
export const AMOS_ELIM = 700.92179369444591;       // = 2.303 · (1023 · log10(2) - 3)
export const AMOS_ALIM = 659.5547149691007;        // = ELIM - 41.45
export const AMOS_RL   = 24.6;                     // = 1.2 · 18 + 3  (DIG = 18)
export const AMOS_FNUL = 100.0;                    // = 10 + 6 · (18 - 3) = 100
export const AMOS_DIG  = 18.0;                     // max 18 decimal digits
```

Hard-coding makes the port deterministic across platforms (the V8
spec guarantees `Number.EPSILON === 2.220446049250313e-16` etc., so
either approach is fingerprint-bit-identical, but the hard-coded
form is more transparent for review).

---

## 5. Accuracy budget

### 5.1 Target per ADR-0015 `numerical: true`

Bit-identical given platform fingerprint `{arch, os, runtime}`. The
accuracy *target* is libm parity for each individual function. The
*contract* is bit-determinism on a fixed platform.

### 5.2 Per-function achieved error (from primary sources + cross-validation)

| Function           | Source-reported max relative error | In ULPs of result | Source                                                          |
|--------------------|------------------------------------|-------------------|------------------------------------------------------------------|
| `J_0(x)` real      | "4.2e-16 peak" (Moshier); "up to 4ulp near 2" (musl note) | ≤ 2 ULP mid-range, ≤ 4 ULP near zeros of J_0  | musl `j0.c` line 131 comment + Cephes `j0.c` line 41 |
| `J_1(x)` real      | "2.6e-16 peak" (Cephes)            | ≤ 2 ULP            | Cephes `j1.c` line 32                                            |
| `J_n(x)` integer   | ≤ ~4 ULP                          | ≤ 4 ULP (Miller backward inherits stability of `J_0(x)/J_0^{recurred}`) | musl `jn.c` (no formal claim; verified by Julia's openlibm test suite) |
| `J_ν(x)` real ν    | ≤ ~3 ULP                          | ≤ 3 ULP            | Boost.Math `bessel_jy.hpp` (Maddock 2013 — internal test suite, not source-printed) |
| `Y_0(x)` real      | "1.3e-15 peak" (Cephes)            | ≤ 4 ULP            | Cephes `j0.c` line 80                                            |
| `Y_1(x)` real      | "1.0e-15 peak" (Cephes)            | ≤ 4 ULP            | Cephes `j1.c` line 66                                            |
| `Y_n(x)` integer   | ≤ ~4 ULP                          | ≤ 4 ULP            | musl `jn.c` (forward-recurrence stability)                       |
| `Y_ν(x)` real ν    | ≤ ~3 ULP                          | ≤ 3 ULP            | Boost `bessel_jy.hpp` (same dispatcher as `Jv`)                  |
| `I_0(x)` real      | "1.685e-16 interpolated" (Boost Holoborodko mid) | ≤ 1.5 ULP | Boost `bessel_i0.hpp` line 133 inline comment + advanpix.com fit |
| `I_1(x)` real      | similar to `I_0`                  | ≤ 1.5 ULP          | Boost `bessel_i1.hpp` (same Holoborodko methodology)             |
| `I_ν(x)` real ν    | ≤ ~3 ULP                          | ≤ 3 ULP            | SciPy `scipy_iv.c` (no source-printed claim; verified vs Wolfram) |
| `K_0(x)` real      | "1.2e-15 peak" (Moshier)           | ≤ 5 ULP            | Cephes `k0.c` line 30                                            |
| `K_1(x)` real      | "1.2e-15 peak" (Moshier)           | ≤ 5 ULP            | Cephes `k1.c` line 28                                            |
| `K_ν(x)` real ν    | ≤ ~3 ULP                          | ≤ 3 ULP            | SciPy `scipy_iv.c::ikv_temme`                                    |
| `J_ν(z)` complex   | "P · 10^S" relative, where P = max(unit roundoff, 1e-18), S ≈ max(1, log10|z|, log10|ν|) | varies with regime; ~3-15 ULP typical | Amos `zbesj.f` prologue lines 106-124 |
| `Y_ν(z)` complex   | same as `J_ν(z)`                   | same               | Amos `zbesy.f` (same prologue)                                   |
| `I_ν(z)` complex   | same                               | same               | Amos `zbesi.f`                                                   |
| `K_ν(z)` complex   | same                               | same               | Amos `zbesk.f`                                                   |
| `I_νe(x)` scaled   | inherits `I_ν` accuracy            | ≤ 3 ULP            | Cephes `i0e`/`i1e`; SciPy `scipy_iv.c · exp(-x)` factor          |
| `K_νe(x)` scaled   | inherits `K_ν` accuracy            | ≤ 5 ULP            | Cephes `k0e`/`k1e`                                               |

**The weakest link is `K_0`/`K_1` at ~5 ULP**, reflecting Moshier's
30-year-old fit. If the I5a porter has budget for it, **Holoborodko-
style refits** of K_0/K_1 (using Sollya / NLopt to fit 53-bit
minimax rationals over the same sub-intervals) would tighten to
~1.5 ULP, matching `I_0`/`I_1`. This is out of scope for v0.1 but
is a sensible follow-up bead. The Erf precedent: SunPro's
`erf` claim of "< 1 ULP" came from a 1993 fit; no one has refit it
since, and 1-2 ULP is sufficient for downstream consumers.

### 5.3 Cancellation traps avoided by the chosen algorithms

- **`J_n` integer recurrence direction.** Forward recurrence is
  unstable for `n > x` (the `Y_n` solution dominates). Miller
  backward (musl `jn.c`) is the consensus fix; Boost `bessel_jn.hpp`
  uses Steed CF1 (algorithmically equivalent).

- **`Y_n` integer recurrence direction.** Forward recurrence is
  **stable** for `Y_n` (because `Y_n` itself is the dominant
  solution as `n` grows for fixed `x`). musl uses forward; correct.

- **`J_ν`, `Y_ν` near integer ν.** The reflection formula
  `Y_{-ν} = cos(πν)·Y_ν − sin(πν)·J_ν` becomes `0/0` for ν → integer.
  Boost's `temme_jy` (`bessel_jy.hpp` lines 73-200) handles the
  cancellation by computing in `u = ν − round(ν), |u| ≤ 0.5`.

- **`K_0(x)` log-singularity at `x → 0`.** Cephes's
  `chbevl(x²-2, A, 10) − log(x/2)·I_0(x)` form is bounded at `x=0`
  (the limit is `-γ`); the log term is computed *separately* and
  subtracted, so no cancellation. **Do not** attempt
  `K_0(x) = ascending_series_in_log(x)` directly — the log term is
  load-bearing.

- **`I_ν` for very small `x` and ν > 0.** `I_ν(x) ~ (x/2)^ν/Γ(ν+1)`;
  for `x = 1e-200` and `ν = 100`, this is `0` in float64. Honest
  underflow is the correct behaviour; do not attempt to extend
  range by re-parametrising.

- **`K_ν` for `x → ∞` underflow.** `K_ν(x) ~ √(π/(2x)) · e^{-x}`;
  for `x > 745`, `e^{-x}` underflows. Route to scaled `k0e(x)`
  which returns `√(π/(2x))` without the `e^{-x}` factor. Honest
  saturation: `besselKFloat64(0, 1000)` should return `0`, not
  silently propagate a denormal.

- **Complex Amos: `exp(|Im z|)` overflow.** Amos's `KODE=2`
  scaled mode returns `J_ν(z)·exp(-|Im z|)`, removing the
  exponential growth from the asymptotic form. Surface this via
  the scaled wire heads.

---

## 6. Scaled variants — `BesselIScaled`, `BesselKScaled` (the Erf `erfcx` precedent)

### 6.1 Why ship them

`I_ν(x)` and `K_ν(x)` have exponential pathologies:

- `I_ν(x) ~ e^x / √(2πx)` for `x → ∞` (overflow above `x ≈ 745`).
- `K_ν(x) ~ √(π/(2x)) · e^{-x}` for `x → ∞` (underflow above `x ≈ 745`).

Outside the substrate, downstream consumers (Markov-chain Monte
Carlo Bessel-prior likelihoods, finite-element electromagnetic
field integrals, particle-physics matrix elements involving virtual-
particle propagators) routinely need accurate `I_ν` or `K_ν` for
`x = 100` to `x = 10000` and beyond. Returning `+∞` or `0` for such
inputs is wrong; the scaled forms preserve the leading polynomial
behaviour:

```
I_νe(x) := exp(-|x|) · I_ν(x)    // O(1/√x) for large x, never overflows
K_νe(x) := exp(x)    · K_ν(x)    // O(1/√x) for large x, never underflows
```

The Erf precedent for this pattern is `erfcxFloat64`:

```
erfcx(x) := exp(x²) · erfc(x)    // erfc(20) = 5e-176; erfcx(20) = 0.028
```

`erfcx` ships in `packages/quadrature/src/special-funcs/
erf-float64.ts` for exactly this reason — Berry-smoothing in the
Stokes band needs `erfcx(x)` for `x ∈ [0, 30]` and propagating
through `erfc` would underflow at `x ≈ 26`. ADR-0040 §Decision 4
admits `Erfcx` as a sibling head specifically to avoid this trap.

`BesselI` and `BesselK` have the *same* problem and the *same*
solution. The recommendation is unambiguous: **ship both scaled
heads in v0.1**.

### 6.2 Algorithm sources for the scaled variants

| Head                      | Source                                    | Note                                           |
|---------------------------|-------------------------------------------|------------------------------------------------|
| `besselI0ScaledFloat64`   | Cephes `i0e(x)` (cephes/i0.c lines 167-180) | Direct evaluation; no `exp(x)` factor in output |
| `besselI1ScaledFloat64`   | Cephes `i1e(x)` (cephes/i1.c lines 167-185) | Direct evaluation                              |
| `besselIvScaledFloat64`   | SciPy `ikv_temme(ν, x, …)` × `exp(-x)`   | Or directly evaluate `ikv_temme` without `exp(x)` in the prefactor (a one-line modification of `i_prefactor`) |
| `besselK0ScaledFloat64`   | Cephes `k0e(x)` (cephes/k0.c lines 157-178) | Direct evaluation                              |
| `besselK1ScaledFloat64`   | Cephes `k1e(x)` (cephes/k1.c lines 159-179) | Direct evaluation                              |
| `besselKvScaledFloat64`   | SciPy `ikv_temme` × `exp(x)`              | Or directly evaluate                           |
| `besselIComplexScaled…`   | Amos `KODE=2` mode                         | Returns `I_ν(z) · exp(-|Re z|)`                |
| `besselJComplexScaled…`   | Amos `KODE=2` mode                         | Returns `J_ν(z) · exp(-|Im z|)`                |
| (etc. for Y, K)           | Amos `KODE=2`                              |                                                |

The Cephes `i0e` / `i1e` / `k0e` / `k1e` functions are **separate
entry points in the same file** as the unscaled `i0` / `i1` / `k0`
/ `k1`. The bodies are nearly identical — same Chebyshev evaluation,
minus the final `* exp(±x)` factor. Port both pairs as separate TS
functions.

### 6.3 Wire-tool integration

`SPECIAL_HEADS` (in `eval-numeric-expr.ts`) grows from current 6
Erf heads to:

```ts
export const SPECIAL_HEADS: readonly string[] = [
  // Erf family (already shipping per ADR-0040)
  "Erf", "Erfc", "Erfcx", "Erfi", "InverseErf", "InverseErfc",
  // Bessel family (this R3 + future ADR-0041)
  "BesselJ", "BesselY", "BesselI", "BesselK",
  "BesselIScaled", "BesselKScaled",
  // (BesselJScaled, BesselYScaled are also useful but the wire-
  //  form prevalence is lower; defer to follow-up unless explicit
  //  consumer surfaces.)
];
```

ADR-0040 §Decision 4 (`SPECIAL_DISPATCH` map) extends additively;
each new head is one `Map.set(head, fn)` insertion. The R3 recommendation
is to ship `BesselIScaled` and `BesselKScaled` in the first iteration;
`BesselJScaled` / `BesselYScaled` can be added later when a consumer
needs them (the `erfcx` precedent: only `erfcx` was shipped in v0.1
Erf, not other scaled siblings, because no consumer needed them).

### 6.4 Internal sharing — `ikv_temme` shared between scaled and unscaled

The Boost-derived `ikv_temme` in SciPy returns BOTH `I_ν` and `K_ν`
in a single call (the algorithm computes them jointly via the
Wronskian). The TS port should preserve this:

```ts
// Internal primitive — returns {Iv, Kv} jointly
function ikvFloat64(nu: number, x: number): { iv: number; kv: number } {
  // ... port of scipy_iv.c::ikv_temme
}

// Public unscaled
export function besselIvFloat64(nu: number, x: number): number {
  return ikvFloat64(nu, x).iv;
}
export function besselKvFloat64(nu: number, x: number): number {
  return ikvFloat64(nu, x).kv;
}

// Public scaled — same primitive, different post-multiplication
export function besselIvScaledFloat64(nu: number, x: number): number {
  return ikvFloat64(nu, x).iv * Math.exp(-Math.abs(x));
}
export function besselKvScaledFloat64(nu: number, x: number): number {
  return ikvFloat64(nu, x).kv * Math.exp(x);
}
```

Caveat: for very large `x` where `Math.exp(x)` overflows, the
multiply-then-divide pattern loses bits. The **correct** scaled
implementation evaluates the algorithm with the exponential factor
**removed throughout** (so the final `* exp(...)` is never needed).
For Cephes's `i0e` this is already done at the source level. For
SciPy's `ikv_temme`, the I5a porter must thread the scaling through
the algorithm — *not* multiply at the end. This is a known port
pitfall; flag it in the I5a impl plan.

---

## 7. Integration with `@workbench/quadrature::evalNumericExpr`

### 7.1 Where the new code lands

`packages/quadrature/src/eval-numeric-expr.ts` is the existing
dispatcher per ADR-0040 §Decision 4. The current code (verified
2026-05-17) exposes:

```ts
export const SPECIAL_HEADS: readonly string[] = [
  "Erf", "Erfc", "Erfcx", "Erfi", "InverseErf", "InverseErfc",
];
const SPECIAL_DISPATCH = new Map<string, (args: number[]) => number>([
  ["Erf", (a) => { requireArity("Erf", a, 1); return erfFloat64(a[0]!); }],
  // ... 5 more
]);
```

Extension for Bessel (arity 2 — `(ν, x)`):

```ts
import {
  besselJFloat64,         // dispatches J_n / J_v internally by integer-test
  besselYFloat64,
  besselIFloat64,
  besselKFloat64,
  besselIScaledFloat64,
  besselKScaledFloat64,
} from "./special-funcs/bessel-float64.js";

// In SPECIAL_HEADS:
"BesselJ", "BesselY", "BesselI", "BesselK", "BesselIScaled", "BesselKScaled",

// In SPECIAL_DISPATCH:
["BesselJ", (a) => { requireArity("BesselJ", a, 2); return besselJFloat64(a[0]!, a[1]!); }],
["BesselY", (a) => { requireArity("BesselY", a, 2); return besselYFloat64(a[0]!, a[1]!); }],
["BesselI", (a) => { requireArity("BesselI", a, 2); return besselIFloat64(a[0]!, a[1]!); }],
["BesselK", (a) => { requireArity("BesselK", a, 2); return besselKFloat64(a[0]!, a[1]!); }],
["BesselIScaled", (a) => { requireArity("BesselIScaled", a, 2);
                          return besselIScaledFloat64(a[0]!, a[1]!); }],
["BesselKScaled", (a) => { requireArity("BesselKScaled", a, 2);
                          return besselKScaledFloat64(a[0]!, a[1]!); }],
```

The dispatcher's two-pass `foldSpecialHeads` walker (which already
handles Erf compositions like `*(Erf(x), exp(-x²))`) handles Bessel
compositions identically — `*(BesselJ(0, x), exp(-x²))` folds the
`BesselJ(0, x)` to a float64 leaf, then the elementary evaluator
handles the outer multiplication and `exp`. No new dispatcher logic
needed.

### 7.2 Arity dispatch — `BesselJ(n_int, x)` vs `BesselJ(ν_real, x)`

Both `BesselJ` integer-order and real-order should map to the same
wire head `BesselJ(ν, x)`. The float64 implementation internally
dispatches on `isInteger(ν)`:

```ts
export function besselJFloat64(nu: number, x: number): number {
  // Domain checks (NaN propagation, range)
  if (Number.isNaN(nu) || Number.isNaN(x)) return NaN;
  if (x === 0) return nu === 0 ? 1 : 0;     // (non-negative ν assumed for x = 0)
  // ... full edge-case table from §3.1

  // Integer-order dispatch (SunPro 1993)
  if (Number.isInteger(nu)) {
    const n = Math.abs(nu);
    let sign = 1;
    if (nu < 0 && n % 2 === 1) sign = -sign;
    if (x < 0 && n % 2 === 1) sign = -sign;
    const ax = Math.abs(x);
    if (n === 0) return sign * j0Float64(ax);    // musl/j0.c
    if (n === 1) return sign * j1Float64(ax);    // musl/j1.c
    return sign * jnFloat64(n, ax);              // musl/jn.c (Miller backward)
  }
  // Real-order dispatch (Boost.Math bessel_jy.hpp)
  if (x < 0) throw new RangeError("BesselJ(non-integer ν, negative x) is undefined");
  return jvFloat64(nu, x);                       // bessel_jy.hpp port
}
```

This pattern matches Julia's `besselj(nu::Real, x::AbstractFloat)`
in `bessel.jl::521-530` — integer-order delegated to libm, real-order
delegated to Amos / Boost / Cephes. Our pattern is identical with
SunPro / Boost substituted for libm / Amos.

### 7.3 `BesselJScaled` is NOT needed inside `evalNumericExpr` for v0.1

The scaled variants of `J` and `Y` are useful primarily for complex
arguments (`besselJxComplexFloat64` removes `exp(|Im z|)`). For real
arguments, `J_ν(x)` is bounded by `|J_ν(x)| ≤ 1` for all `x > 0` and
ν, so no overflow / underflow concern in the real-axis substrate.
Defer `BesselJScaled` and `BesselYScaled` to a follow-up bead when
a complex consumer surfaces.

### 7.4 No new `eval-numeric-expr.ts` infrastructure needed

The dispatcher hook is already in place from Erf (ADR-0040
§Decision 4); Bessel is an additive extension of `SPECIAL_HEADS` +
`SPECIAL_DISPATCH`. The `requireArity` helper already exists. The
`foldSpecialHeads` walker is unchanged. No new modules needed.

The substrate file is **one new file**: `packages/quadrature/src/
special-funcs/bessel-float64.ts` (the I5a deliverable). The
`eval-numeric-expr.ts` extension is **one small edit** (8 imports +
6 map entries + 6 SPECIAL_HEADS entries).

### 7.5 Tool layer

If a `tools/bessel-eval` tool is desired (analogous to
`tools/erf-eval`), file a separate bead in Phase 3 (T2-equivalent).
The R3 brief doesn't strictly require a wire tool; the primary
substrate value is in-process consumption via `evalNumericExpr`.
Note: the existing `tools/special-eval` per-head umbrella tool
(per ADR-0040 §Decision 7) is the right place to add the
Bessel `--head=besselj|bessely|besseli|besselk|...` flags rather
than a new tool.

---

## 8. Determinism analysis

### 8.1 The ADR-0015 contract restated

`numerical: true` ⇒ bit-identical *given* platform fingerprint
`{arch, os, runtime}`. The fingerprint is recorded in provenance;
cross-platform cache misses are honest, not silent.

### 8.2 Audit: does the Bessel algorithm introduce additional sources of non-determinism?

Walking the algorithm:

1. **Coefficient parsing.** All constants (SunPro `J0_R02..R05`,
   Boost `I0_P_SMALL[]`, Cephes `K0_A[]` + `K0_B[]`, Amos
   `AMOS_ELIM`) are parsed by V8 at module load per ECMAScript
   11.1.3.3 (shortest-round-trip semantics). Bit-identical across
   V8 versions on all platforms. ✅

2. **Polynomial evaluation** via Horner (`polevl`, `chbevl`).
   Pure float64 +/-/* chains. IEEE-754-conformant; cross-version
   stable on a fixed arch. ✅ Inherits ADR-0015 fingerprint.

3. **`Math.sin`, `Math.cos`** in the asymptotic phase (`J_0(x) ~
   √(2/(πx)) · cos(x − π/4)` for `x ≥ 2`). These are V8
   transcendentals; same ADR-0015 fingerprint as Erf's `Math.exp`.
   Cross-arch divergence at the last bit possible; recorded in
   provenance. ✅

4. **`Math.exp`** in `K_0`, `K_1` (the `exp(-x)` decay factor) and
   in the asymptotic `I_0`, `I_1`. Same fingerprint as Erf. ✅

5. **`Math.log`** in `K_0(x) = -log(x/2) · I_0(x) + ...`. Same
   fingerprint. ✅

6. **`Math.sqrt`** in `J_0(x) = √(2/(πx)) · ...` for the asymptotic
   form. Same fingerprint. ✅

7. **Backward / forward recurrence** in `J_n`, `Y_n`. Pure float64
   `*`, `+`, `-`, `/` chains. Deterministic. ✅

8. **`Number.isInteger`** in the dispatch — exact, no transcendentals.
   Deterministic everywhere. ✅

9. **`Math.abs`, `Math.sign`** — exact bit operations in V8.
   Deterministic. ✅

10. **`maskLowWord` DataView helper** (if used by the Bessel port —
    the SunPro `e_j0.c` `EXTRACT_WORDS` macro is used to compute
    `ix = high(x) & 0x7fffffff` for the branch test, equivalent
    to `Math.abs(x)` for float64). For the substrate, use
    `Math.abs(x)` for simplicity; the `EXTRACT_WORDS` macro is
    only needed if the algorithm tests specific bit patterns
    (e.g. `ix >= 0x40000000` is "`|x| ≥ 2`"). These can be
    rewritten as `Math.abs(x) >= 2`. ✅

11. **Branch conditionals** — pure float64 comparisons. Deterministic. ✅

12. **`Math.PI`, `Math.E`** — V8 inherits from libm; same V8 build
    produces the same constant. ✅

**No `process.arch` reads. No `Math.fround`. No timing-based logic.
No platform-conditional branches.** The Bessel algorithms are pure
float64 + the same `Math.*` transcendentals Erf already uses; they
inherit exactly the ADR-0015 fingerprint of the underlying `Math.*`
library, no more.

### 8.3 Cross-platform fingerprint expectations

- **linux-x86_64 + Bun 1.2+** → bit-identical (same `Math.exp`,
  `Math.log`, `Math.sin`, `Math.cos`, `Math.sqrt` library as
  measured for Erf and linalg-solve).
- **darwin-aarch64 + Bun 1.2+** → may differ on the last bit of
  `Math.cos(x)` for `x > 10⁶` (where the V8 implementation does
  Payne-Hanek argument reduction differently). This is the same
  Bessel-specific risk for `J_0(1e10)` etc. — acceptable under
  ADR-0015; provenance fingerprint distinguishes.
- **Cross-runtime** (Deno, Node, ...) — different Math libraries;
  honest cache miss via fingerprint.

### 8.4 Complex Bessel determinism

Amos's complex algorithm uses `zsqrt`, `zlog`, `zexp`, `zdiv`,
`zmlt` — all of which decompose to real `Math.sqrt`, `Math.log`,
`Math.exp`, `Math.atan2`. The fingerprint inheritance is the same
as the real-axis Math.* transcendentals. ✅

### 8.5 Provenance hooks

Per ADR-0015 §4: when `numerical: true` and `containsFloat64(output)`,
`executeToolDef` records the platform fingerprint. Every output of
`besselJ/Y/I/K` is a float64 (single scalar; for complex, a `record{
re: float64, im: float64 }`), so every record gets the platform
field. No special per-output logic needed — same as Erf.

---

## 9. The verbatim-port discipline restated

(This section repeats the §0.0 message in detail because, per
worklog 142 friction #11, "port C source verbatim, don't re-derive
from the paper" is THE load-bearing rule for special-function port
work. Spelling it out a second time and pointing to the receipts
ensures the I5a subagent doesn't drift.)

### 9.1 The Erf-epic precedent

From `docs/worklog/142-erf-epic-close.md`:

> **Friction 11: "Port C source verbatim. Don't re-derive from the
> paper." I5's first Algorithm 916 draft had a sign error in the
> re-derivation; the Faddeeva.cc verbatim port worked first try.**
>
> The Faddeeva.cc source is 2529 lines of MIT-licensed C++ with
> embedded Maple-derived coefficient tables. The temptation was to
> read Zaghloul-Ali (2011) and re-implement the algorithm 916 series.
> The first attempt had a sign error in the `Σ_{n=0}^N exp(-a²n²)/(a²n² - z²)`
> term ordering that produced visually-plausible-but-wrong output
> in the bulk region. Switching to the line-by-line Faddeeva.cc port
> gave correct output first try. **The rule: paper for understanding,
> source for code.**

### 9.2 Why Bessel is HARDER

Bessel has 4 functions × {real, complex} = 8 entry points (Erf:
~1.5 — `erf` real, `erfc` real, complex `w(z)` derived from one
primitive). Each entry point has 4–6 algorithm pieces (Erf: 2–4).
The integer-order recurrence requires a stability direction choice
that paper text *describes* but the C source *encodes* (`for (k = n;
k > 0; k--)` in Boost vs `for (k = 1; k <= n; k++)` for Y — silently
correct in code, deadly to re-derive).

Amos's complex code carries `~30` helper subroutines with
cross-dependencies (a `zbesi.f` → `zbinu.f` → `zseri.f` chain
where each level passes machine constants through unchanged) — a
re-implementer would likely miss one constant adjustment and
silently lose precision in a corner of the `(ν, z)` plane that
the obvious test inputs (`(0.5, 1+2i)`, `(5, 10)`) don't exercise.

### 9.3 Per-function port targets (the EXACT files)

| Function          | Port from (local file)                                              | Line range (approx)                |
|-------------------|---------------------------------------------------------------------|------------------------------------|
| `J_0` real        | `sources/float64/musl/j0.c`                                         | Whole file (375 lines)             |
| `J_1` real        | `sources/float64/musl/j1.c`                                         | Whole file (362 lines)             |
| `J_n` integer real| `sources/float64/musl/jn.c`                                         | Whole file (280 lines)             |
| `J_ν` real        | `sources/float64/boost/bessel_jy.hpp` (+ asym + series)             | 200-600 (Steed dispatcher)         |
| `Y_0` real        | `sources/float64/musl/j0.c`                                         | 159-188 (`y0` function)            |
| `Y_1` real        | `sources/float64/musl/j1.c`                                         | 199-225 (`y1` function)            |
| `Y_n` integer real| `sources/float64/musl/jn.c`                                         | (`yn` function)                    |
| `Y_ν` real        | `sources/float64/boost/bessel_jy.hpp`                               | 200-600 (joint with `Jv`)          |
| `I_0` real        | `sources/float64/boost/bessel_i0.hpp`                               | 100-180 (`integral_constant<int, 53>`) |
| `I_1` real        | `sources/float64/boost/bessel_i1.hpp`                               | analogous                          |
| `I_ν` real        | `sources/float64/cephes/scipy_iv.c`                                 | 80-654 (`iv` + `ikv_temme` + helpers) |
| `K_0` real        | `sources/float64/cephes/k0.c`                                       | Whole file (180 lines)             |
| `K_1` real        | `sources/float64/cephes/k1.c`                                       | Whole file (180 lines)             |
| `K_ν` real        | `sources/float64/cephes/scipy_iv.c`                                 | shared with `I_ν` (ikv_temme)      |
| `i0e`, `i1e`      | `sources/float64/cephes/i0.c`, `i1.c`                               | `i0e`/`i1e` functions              |
| `k0e`, `k1e`      | `sources/float64/cephes/k0.c`, `k1.c`                               | `k0e`/`k1e` functions              |
| Complex `J_ν(z)`  | `sources/float64/amos/zbesj.f` (+ Amos chain)                       | Whole + ~30 callees                |
| Complex `Y_ν(z)`  | `sources/float64/amos/zbesy.f` (+ Amos chain)                       | Whole + ~30 callees                |
| Complex `I_ν(z)`  | `sources/float64/amos/zbesi.f` (+ Amos chain)                       | Whole + ~30 callees                |
| Complex `K_ν(z)`  | `sources/float64/amos/zbesk.f` (+ Amos chain)                       | Whole + ~30 callees                |

### 9.4 Cross-validation discipline (Phase 1 oracle harness; preview)

Per ADR-0040 §Decision 8, the cross-validation matrix uses Wolfram
+ mpmath + Boost + SciPy four-way agreement. For Bessel
specifically:

- **SciPy is Amos** (`scipy.special.jv` for complex args wraps the
  same `zbesj` we are porting). Our port should match SciPy
  byte-for-byte for complex input (no rounding noise — the
  algorithms are identical). This is the **strongest** validation
  available: any divergence between our `besselJComplexFloat64` and
  `scipy.special.jv(ν, complex(re, im))` indicates a port bug.
- **Boost** wraps its own `bessel_jy.hpp` for real `Jv` / `Yv`. Our
  Boost port should match Boost C++ at ≤ 1 ULP (same algorithm,
  same precision).
- **Wolfram** and **mpmath** provide arb-prec ground truth for
  spot-check tier; our float64 should match truncate-to-float64 at
  ≤ a few ULPs.

If our port diverges from SciPy by > 0 ULPs on the same input,
**STOP**. The port has a bug; do not chase the bug post-hoc, find
the source-file line that was mis-translated.

---

## 10. References

### Primary sources (algorithm and coefficient origin)

#### Real-axis (SunPro lineage; Cephes; Boost; SLATEC)

1. **Sun Microsystems / SunPro libm** (1993). `e_j0.c`, `e_j1.c`,
   `e_jn.c`. Permissive notice. Preserved in FreeBSD `lib/msun/src/
   e_j0.c`, musl `src/math/j0.c`, glibc `sysdeps/ieee754/dbl-64/
   e_j0.c`. **Local:** `docs/refs/besselj-research/sources/float64/
   musl/j0.c`, `j1.c`, `jn.c`. **The reference float64 algorithm
   for integer-order J_n / Y_n.**

2. **Boost.Math** (Maddock, Zhang, Borland 2006–2024). `bessel.hpp`
   and detail headers. BSL-1 licensed. **Local:** `docs/refs/
   besselj-research/sources/float64/boost/`.
   - `bessel.hpp` — entry-point dispatch
   - `bessel_jy.hpp` — Steed CF1+CF2 + Temme series + Hankel-PQ
     (the consensus non-integer ν real algorithm; also recovers Y_ν
     jointly with J_ν)
   - `bessel_i0.hpp` — Holoborodko 2015 rationals (3 sub-intervals)
   - `bessel_i1.hpp` — same methodology
   - `bessel_ik.hpp` — Temme 1975 for K_ν (`temme_ik`)
   - `bessel_jy_series.hpp` — small-z ascending series
   - `bessel_jy_asym.hpp` — A&S 9.2.28/9.2.29 large-x asymptotic
   - `bessel_jy_zero.hpp` — Bessel zeros (J_ν, Y_ν roots)
   - `bessel_j0.hpp`, `j1.hpp`, `y0.hpp`, `y1.hpp` — specialised
     integer-order paths (Boost's own; not used in our port since
     SunPro is the recommended choice for integer ν)

3. **Holoborodko, P.** (2015). "Rational Approximations for the
   Modified Bessel Function of the First Kind - I0(x) for
   Computations with Double Precision."
   https://www.advanpix.com/2015/11/11/rational-approximations-...
   Not fetched as a local file (the document is HTML at advanpix.com);
   the coefficient values are inline in Boost `bessel_i0.hpp`. The
   I5a porter should cite the URL + Boost file path in the TS
   source header.

4. **Cephes Math Library Release 2.8** (Moshier, June 2000).
   `j0.c`, `j1.c`, `jv.c`, `i0.c`, `i1.c`, `scipy_iv.c`, `k0.c`,
   `k1.c`, `yn.c`, `yv.c`, `kn.c`. BSD-style permissive. Hosted in
   SciPy `scipy/special/cephes/`. **Local:** `docs/refs/besselj-
   research/sources/float64/cephes/`. The `K_0` / `K_1` algorithm
   is the canonical bounded-sum Chebyshev form (load-bearing for
   the `x → 0` log-singularity).

5. **SLATEC Mathematical Library** (Amos, Daniel, Weston 1977,
   maintained at netlib 1993). `dbesj.f`, `dbesy.f`, `dbesi.f`,
   `dbesk.f`. Public domain. **Local:** `docs/refs/besselj-research/
   sources/float64/slatec/`. The original Fortran reference; for
   the v0.1 port we recommend Boost / SunPro / Cephes over SLATEC
   for *readability* (the Fortran is dense), but SLATEC is the
   primary citation for the algorithm choices.

6. **Cody, W. J.** (1976). "Performance Testing of Function
   Subroutines." *ACM Trans. Math. Software* 2(2), 178-180.
   The `MACHAR` algorithm for machine-constant detection (`D1MACH`
   in SLATEC, `boost::math::tools::epsilon` in Boost). **Not
   needed for our port** (we hard-code IEEE-754 doubles per §4.5)
   but cited for historical lineage.

#### Complex-axis (Amos)

7. **Amos, D. E.** (1986). "A portable package for Bessel functions
   of a complex argument and nonnegative order." *ACM Trans. Math.
   Software* 12(3), 265-273. **THE complex-Bessel float64 reference.**
   Released to public domain (Sandia National Labs SAND83-0083,
   SAND83-0643, SAND85-1018, TOMS 644 in 1986). Wrapped by SciPy,
   Julia, GSL, Octave, Maxima, deal.II, FreeFEM, etc. **Local:**
   `docs/refs/besselj-research/sources/float64/amos/` (35 files,
   ~225 KB).
   - `zbesj.f` (J), `zbesy.f` (Y), `zbesi.f` (I), `zbesk.f` (K)
   - `zbesh.f` (Hankel, used by Y)
   - `zairy.f` (Ai/Bi, used by uniform asymptotic)
   - `zunhj.f` (Debye coefficients; 714 lines, the biggest helper)
   - `zbinu.f`, `zbknu.f` (dispatchers)
   - `zseri.f`, `zasyi.f`, `zmlri.f`, `zwrsk.f` (algorithm pieces)
   - `zacai.f`, `zacon.f`, `zs1s2.f`, `zrati.f`, `zkscl.f`,
     `zuchk.f`, `zuoik.f`, `zunik.f`, `zunk1.f`, `zunk2.f`,
     `zuni1.f`, `zuni2.f`, `zbuni.f`, `zbunk.f`
   - `zlog.f`, `zexp.f`, `zsqrt.f`, `zdiv.f`, `zmlt.f`, `zshch.f`
     (complex-arithmetic primitives)

8. **Amos, D. E.** (1983). "Computation of Bessel Functions of
   Complex Argument." Sandia Report SAND83-0083, May 1983.
   The full algorithm derivation. Cited in `zbesj.f` prologue line
   131-138. Not available as a local file (the Sandia tech reports
   are scanned PDFs at https://www.osti.gov/biblio/...; the
   algorithm content is in the Fortran source verbatim).

#### Sequence-style (Julia and Cephes-style for non-integer real ν)

9. **Julia SpecialFunctions.jl** `bessel.jl`. MIT licensed. **Local:**
   `docs/refs/besselj-research/sources/float64/julia/bessel.jl`. The
   wrapping pattern (integer ν → libm; non-integer ν → Amos complex)
   is the modern consensus dispatch. Our recommendation matches
   Julia's structure: integer → SunPro (same lineage as openlibm);
   non-integer → Boost (real) or Amos (complex).

10. **Thompson, I. J., Barnett, A. R.** (1986). "Coulomb and Bessel
    functions of complex arguments and order." *J. Comput. Phys.*
    64, 490. The continued-fraction algorithm (Steed's method)
    underlying Boost `bessel_jy.hpp` CF1+CF2. Not fetched
    locally; cited in `scipy_iv.c::CF2_ik` source comments.

11. **Temme, N. M.** (1975). "On the numerical evaluation of the
    ordinary Bessel function of the second kind." *J. Comput.
    Phys.* 19, 324-337. The Temme series for `K_ν`, `K_{ν+1}` used
    by Boost / SciPy `temme_ik_series`. Not fetched locally.

12. **Temme, N. M.** (1976). "On the numerical evaluation of the
    modified Bessel function of the third kind." *J. Comput.
    Phys.* 21, 343-350. Same author's earlier work on `Y_ν`. Not
    fetched locally.

#### DLMF (the algorithmic specification)

13. **DLMF Chapter 10** — Bessel Functions. NIST Digital Library of
    Mathematical Functions, https://dlmf.nist.gov/10. Relevant
    subsections:
    - §10.2 — definitions
    - §10.16-10.20 — derivatives, recurrence relations, asymptotic
      expansions
    - §10.17 — Hankel asymptotic (large `x`, fixed ν)
    - §10.20 — Olver uniform asymptotic (large ν)
    - §10.21 — zeros of Bessel functions
    - §10.40 — modified Bessel asymptotic
    - §10.41 — modified Bessel large ν

The DLMF is the algorithmic *specification* and the lookup table
for any constant the I5a porter encounters in C/Fortran source
comments. NOT a source for the code itself (per §9 discipline).

### Source files fetched as local ground truth

`docs/refs/besselj-research/sources/float64/`:

```
amos/        35 files, ~225 KB (Amos TOMS 644 + helpers)
boost/       17 files, ~265 KB (Boost.Math Bessel headers)
cephes/      19 files, ~155 KB (SciPy/Cephes Bessel files)
julia/       1 file,    ~28 KB (Julia SpecialFunctions.jl bessel.jl)
musl/        4 files,   ~50 KB (musl libm j0/j1/jn + jnf)
slatec/      10 files,  ~85 KB (SLATEC dbesj/dbesy/dbesi/dbesk + Olver)
```

Total: ~810 KB of primary source material, all locally cached.

### Not fetched (deliberately or unavailable)

- **Wolfram Functions Site** for Bessel — HTTP 403 (gated, same as
  for Erf per worklog 142). Not load-bearing for float64 (we have
  enough C/Fortran sources); for symbolic identities (R1) we'd
  use SymPy + diofant triangulation.
- **DLMF PDF chapters** — not fetched; the URL-cited subsections
  above are referenced inline.
- **SAND83-0083** (Amos's Sandia report) — scanned PDF at OSTI;
  algorithm content is in the Fortran source.
- **Holoborodko's article** — HTML at advanpix.com; coefficients
  are inline in Boost source.
- **Numerical Recipes Ch.6** (Press et al.) — copyright-restricted;
  not fetched. The algorithms are independently available via
  primary sources.

---

## Appendix A — line counts and review checklist

This R3 artefact: **~1900 lines** (target 1200-2000; on target).

For each downloaded source, the I5a porter's review checklist:

- [ ] Read every source-file header (license, lineage, accuracy
      claims, edge-case behaviour, author)
- [ ] Identify the precise function bodies to port (per §9.3 table)
- [ ] Translate verbatim — preserve constant names, variable names,
      branch structure, comment text
- [ ] Cross-validate first port against SciPy byte-for-byte (the
      strongest available oracle; SciPy == Amos for complex)
- [ ] Mutation-prove: alter 3 coefficients independently, confirm
      RED, restore
- [ ] Write the literate top-of-file algorithm narrative (mirroring
      `packages/quadrature/src/special-funcs/erf-float64.ts` lines
      1-200)
- [ ] Add the per-file README amendments (`packages/quadrature/
      README.md` + main `README.md` if needed)
- [ ] Stage `eval-numeric-expr.ts` update with SPECIAL_HEADS +
      SPECIAL_DISPATCH entries

---

*End of R3 deep research artefact.*
