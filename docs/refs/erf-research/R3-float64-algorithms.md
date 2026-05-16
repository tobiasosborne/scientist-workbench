# R3 — Float64 Erf algorithms: state-of-the-art survey for `@workbench/quadrature`

> **Bead:** scientist-workbench-1i5z (R3 of epic `43hw`, world-class Erf).
> **Substrate:** `packages/quadrature/src/eval-numeric-expr.ts` (to-be-created;
> the current `evalNumericExpr` lives in `eval-expr.ts` and explicitly
> excludes `erf` — "tier-3, file separately when motivated" — that filing
> is now).
> **Tier:** ADR-0015 `numerical: true`. Bit-identical given platform
> fingerprint `{arch, os, runtime}`. Pure JavaScript; no FFI; no
> `process.arch` branches; algorithm and constants are platform-
> independent so the only float-runtime dependence is the underlying
> V8 `Math.exp`/`Math.log`/division-rounding behaviour that the rest of
> the tier already inherits.
> **Reference cycle:** R1 (symbolic identities) → R2 (arb-prec) → **R3
> (this document)** → R4 (Meijer-G bridge) → A0 (ADR-0040 + prototype).

## 0. Executive summary (read first; full details in §§1–8)

### 0.1 Recommended real-axis split (the dispatch table)

The Sun/SunPro/FreeBSD/musl/glibc lineage is the consensus float64
algorithm. It is byte-identical across all five of those libm
implementations, has been in service since 1993, and has known
worst-case error ≤ 1 ULP for `erf` and ≤ 2 ULP for `erfc` on the
entire real line. **Adopt it verbatim.**

| Branch | Condition (on `|x|`)   | Algorithm                                          | Formula                                                       | Error bound (source)        |
|-------:|------------------------|----------------------------------------------------|---------------------------------------------------------------|-----------------------------|
| (a)    | `< 2⁻²⁸ ≈ 3.7e-9`      | linear `(8x + efx8·x)/8` — underflow-safe Maclaurin| `erf(x) ≈ (2/√π)·x = 1.128379…·x`                             | exact to ulp (analytic)     |
| (b)    | `< 0.84375`            | odd rational `x + x·P(x²)/Q(x²)` — Sun §1          | `erf(x) = x + x·R(x²)`,  `R = pp/qq` (deg 4/deg 5)            | `\|R−(erf x−x)/x\|≤2⁻⁵⁷·⁹⁰` |
| (c)    | `< 1.25`               | Taylor-at-1 rational `(1−erx) − P1(s)/Q1(s)`, s=|x|−1 | `erfc(x) = (1−c) − P1(s)/Q1(s)`, c≈0.84506291 single-prec | `\|P1/Q1−(erf\|x\|−c)\|≤2⁻⁵⁹·⁰⁶` |
| (d)    | `< 1/0.35 ≈ 2.857`     | asymptotic rational in `z=1/x²`                    | `erfc(x) = (1/x)·exp(−x²−0.5625+R1(z)/S1(z))`                 | `\|R1/S1−f\|≤2⁻⁶²·⁵⁷`       |
| (e)    | `< 6` (for erf) / `< 28` (for erfc) | asymptotic rational, second piece     | `erfc(x) = (1/x)·exp(−x²−0.5625+R2(z)/S2(z))`                 | `\|R2/S2−f\|≤2⁻⁶¹·⁵²`       |
| (f)    | `≥ 6` (erf) / `≥ 28` (erfc) | saturation                                    | `erf(x) = sign(x)·(1−2⁻¹⁰²²)`, `erfc(x) = ±tiny² or 2−tiny`   | exact at IEEE limits        |

Symmetry: `erf(−x) = −erf(x)`, `erfc(−x) = 2 − erfc(x)`. Apply once at
the entry, then work on `|x|`.

Key constants (all from the SunPro 1993 source, byte-identical in musl,
glibc, FreeBSD msun, NetBSD, OpenBSD, Apple Libm):

- `erx = 0.84506291151046752929687500` (the value of `erf(1)` rounded
  to single-precision so that `1−erx` is exact in double).
- `efx8 = 1.02703333676410069053e+00` (the "extra 0.027…" so that
  `(8x + efx8·x)/8 = x·(1 + efx8/8) ≈ x·(2/√π)` exactly for tiny x).
- `0.5625 = 9/16` (exact in float64 — chosen so the additive constant
  in the asymptotic exponential decomposition is representable).
- `2/√π = 1.1283791670955125738961589031215451716881…` (the universal
  series coefficient).

### 0.2 Recommended complex-z algorithm: Faddeeva-Johnson

For `erf(z), erfc(z), erfcx(z), w(z)` on `z ∈ ℂ` use a hybrid:

- **Large `|z|`** (`|y|>7` *or* (`x>6` and not the bad-band)):
  Poppe-Wijers continued fraction (ACM TOMS 16(1), 1990) with
  Johnson's tuned term-count formula
  `nu ≈ 3 + 1442/(26·ρ + 77)`, ρ = `√((x/6.3)² + (y/4.4)²)`.
- **Moderate `|z|`** (everything else *except* the bad band):
  Zaghloul-Ali Algorithm 916 (ACM TOMS 38(2), 2011). A tail-bounded
  series in `exp(−a²n²)` with `a = π/√(−log(ε/2)) ≈ 0.5183` for
  `ε = 2⁻⁵²`.
- **Bad band** (`6<x<28, y<~0.1`): Algorithm 916 (continued fraction
  is fast but loses 5+ bits in `Re w` here per Zaghloul 2012 note).
- **Real-`x` axis**: separate `erfcx_y100` lookup-table-of-Chebyshev
  (Johnson 2012, 100 Chebyshev panels of degree 6–7 over `y = 1/(1+x)`)
  and `w_im_y100` Dawson-style table.

This is the Faddeeva-Johnson library (MIT, 2012; openspecfun-hosted
mirror at `JuliaMath/openspecfun:Faddeeva/Faddeeva.cc`, 2529 LOC).
**Adopt the algorithm and the coefficient tables verbatim**; the
implementation cleanly separates "what's hard" (the y100 tables —
~1500 LOC of Maple-generated Chebyshev coefficients) from "what's
easy" (the ~700-LOC dispatcher and continued-fraction loops).

Accuracy: Johnson claims ≤ 13 digits relative error across the entire
complex plane (i.e., `≤ 2⁻⁴³ ≈ 1.1e-13`); in practice the Chebyshev
panels deliver close to 1 ULP on the real axis.

### 0.3 Inverse-function plan

For `erfinv(x)` and `erfcinv(x)` on the real axis: **Blair-Edwards-Johnson
1976** rational approximants, exactly as used in
SpecialFunctions.jl `_erfinv(::Float64)` / `_erfcinv(::Float64)`. Three
intervals for each:

- `erfinv`, `|x| ≤ 0.75`: Blair Table 17 (deg 6/deg 6 rational in
  `t = x² − 0.5625`).
- `erfinv`, `0.75 < |x| ≤ 0.9375`: Blair Table 37 (deg 7/deg 7 in
  `t = x² − 0.87890625`).
- `erfinv`, `|x| > 0.9375`: Blair Table 57 (deg 8/deg 9 in
  `t = 1/√(−log(1−|x|))`).
- `erfcinv(y) = erfinv(1−y)` for `y > 0.0625`.
- `erfcinv`, `1e-100 ≤ y ≤ 0.0625`: Blair Table 57 in `t = 1/√(−log y)`.
- `erfcinv`, `y < 1e-100`: Blair Table 80 (deg 7/deg 8 in same `t`).

Accuracy: Blair tables target relative error `≈ 1e-19` for the
underlying rational; the float64 implementation thus delivers 1 ULP
on `erfinv` over its full domain. The SpecialFunctions.jl tables are
the cleanest TS-ready emission target — see §4.3 for the literal
values.

### 0.4 Top-3 risks (mitigations referenced inline below)

1. **Catastrophic cancellation in `erf(x)` for `x ≳ 6`** — `erf` is
   computed as `1 − erfc`, but `erfc(6)` is already 2.15e-17. SunPro's
   answer: saturate to `1 − 2⁻¹⁰²²` for `|x| ≥ 6`. ✅ Built into the
   musl dispatch.
2. **Asymptotic-series divergence threshold** — the `R/S` rational in
   branches (d)/(e) is fitted to `g(s) = log(erfc(x)·x) − x² + 0.5625`.
   The `−0.5625` shift is critical: it makes `g` smooth across the
   crossover between the two ranges, so the same form serves
   `[1.25, 2.857]` and `[2.857, 28]` with separate `(R,S)` coefficient
   tables. **Do not** try to refit on a different interval split.
3. **Wire-protocol float64 round-trip** — `evalNumericExpr` already
   reads `float64` leaves via `float64ToNumber` from
   `@workbench/protocol`; the constants in §4 will be emitted as
   literal JS `number` doubles, which V8 parses bit-exact for
   shortest-round-trip representations. Generation script must emit
   the same 17-digit shortest-round-trip form the C constants use
   (e.g. `1.28379167095512558561e-01`), not an arbitrary decimal
   length, to avoid platform-dependent rounding during source parse.

### 0.5 Pointers

Full details in §§1–8 below. Most load-bearing:

- §4.1 — musl `erf.c` coefficient tables (verbatim, all 60+ doubles).
- §4.3 — Blair-1976 `erfinv`/`erfcinv` Float64 tables.
- §5 — accuracy budget per branch (1-2 ULP target, met by adopted
  algorithms).
- §7 — concrete dispatch sketch for the new
  `evalNumericExpr` extension point in `eval-numeric-expr.ts`.
- §8 — determinism: pure JS, no platform branches, all coefficients
  cross-platform-stable; the only V8-dependent operation is
  `Math.exp` (already in the tier).

---

## 1. Recommended algorithm split — real `x`

### 1.1 Why the SunPro/musl algorithm and no other

Five reference implementations were inspected for this study:

1. **Cephes** (Moshier, 1984–2000) — `cprob/ndtr.c`. Uses a single
   rational `polevl(z, T, 4)/p1evl(z, U, 5)` (degree 4/degree 5 in
   `z = x²`) for `|x| < 1`, then `1 − erfc` for `|x| ≥ 1`; `erfc`
   uses two rational pieces in `x` (not `1/x²` like SunPro), split at
   `|x| = 8`. Claimed accuracy IEEE: peak 1.3e-15, RMS 2.2e-16
   (`= 6 ULPs peak`). One generation older than the SunPro algorithm;
   slower convergence on `|x|>4` because the asymptotic variable is
   `x` (not `1/x²`) so the polynomials must do more work.
2. **musl libm** — `src/math/erf.c`, line-for-line port of FreeBSD
   `s_erf.c`, which is the 1993 SunPro source. **All 60+ coefficients
   identical** to glibc `sysdeps/ieee754/dbl-64/s_erf.c`. Claims
   sub-ULP per the source comment ("0.84375 is chosen to guarantee
   the error is less than one ulp for erf"). This is the de-facto
   reference.
3. **glibc libm** — identical to musl. Same SunPro origin.
4. **Boost.Math** — `boost/math/special_functions/erf.hpp`. Uses
   interval-shifted rationals: `erfc(x) = exp(−x²)·(C + R(x−B))/x`
   on moderate intervals, `erfc(x) = exp(−x²)·(C + R(1/x))/x` for
   large x. Reports peak ε ≈ 1.5 (GNU C++) for `erf` mid-range. A
   genuinely different parametrisation, and slightly tighter on some
   intervals, but the coefficient tables are not in the public-domain
   tradition — they are Boost-license, fit by John Maddock with NLopt
   to undocumented targets. Less suitable as a transparent reference;
   harder to cite a paper or table.
5. **Faddeeva-Johnson** real-axis path — delegates to the system
   `erf(double)` when available (C99/C++11), else falls back to
   `1 − exp(−x²)·erfcx(x)` using its own `erfcx_y100` table. For our
   purposes we *cannot* delegate to a system `erf` (we are the
   provider), so this path reduces to "implement erfcx, derive erf".
   That is technically possible but couples real-axis `erf` to
   100 KB of Chebyshev tables that exist primarily for complex-z
   accuracy. Wasteful.

**Decision: adopt the SunPro/musl algorithm verbatim** for real-axis
`erf`/`erfc`/`erfcx`. Reasons:

- Public domain (Sun 1993 permissive notice), citable, byte-identical
  in five major libms, in production since 1993.
- The five-region dispatch is *physically motivated*: it tracks the
  natural transition from "near-zero series" to "near-1 expansion"
  to "asymptotic" to "saturation," and the crossover constants
  (`0.84375`, `1.25`, `1/0.35`, `6`, `28`) are *chosen for ULP-level
  accuracy*, not for convenience.
- The same coefficient set serves both `erf` and `erfc` — the
  algorithm computes `erfc` first in the outer branches and derives
  `erf = 1 − erfc`; no separate fits needed.
- Source-level documentation is the gold standard: every coefficient
  is annotated with both its decimal value and the exact IEEE-754
  bits (e.g. `1.28379167095512558561e-01 /* 0x3FC06EBA, 0x8214DB68 */`).
  This is *exactly* what an agent reading our future TS source wants.

### 1.2 The dispatch table, restated with branch numbers

The numbering matches the SunPro source-code comment block (`Method:
1..5`). Branches (a)/(b) in §0.1 are both inside SunPro branch 1; the
split is whether `|x| < 2⁻²⁸` (underflow protection).

```
// erf(x) and erfc(x) for x ≥ 0; reflect for x < 0 at the entry.
//
// Method: domain table
//   Branch 1a:  |x| < 2^-28    erf(x)  = (8x + efx8·x) / 8
//   Branch 1b:  |x| < 0.84375  erf(x)  = x + x · pp(x²)/qq(x²)
//                              erfc(x) = 1 − erf(x)        if |x| ≤ 0.25
//                                      = 0.5 − (x − 0.5 + x · pp/qq)
//                                                          if 0.25 < |x| < 0.84375
//                                                          (this rearrangement
//                                                          preserves ulps via
//                                                          the 0.5 split)
//   Branch 2:   |x| < 1.25     erfc(x) = (1 − erx) − P1(s)/Q1(s)   s = |x| − 1
//                              erf(x)  = sign(x) · (erx + P1(s)/Q1(s))
//   Branch 3:   |x| < 1/0.35   erfc(x) = (1/x) · exp(−x² − 0.5625 + R1(1/x²)/S1(1/x²))
//                              erf(x)  = 1 − erfc(x)
//   Branch 4:   |x| < 28       erfc(x) = (1/x) · exp(−x² − 0.5625 + R2(1/x²)/S2(1/x²))
//                              erf(x)  = sign(x) · (1 − erfc(x))   if |x| < 6
//                              erf(x)  = sign(x) · (1 − 2^-1022)   if 6 ≤ |x| < 28
//   Branch 5:   |x| ≥ 28       erf(x)  = sign(x) · (1 − 2^-1022)
//                              erfc(x) = 2^-1022 · 2^-1022          if x > 0  (underflow)
//                                      = 2 − 2^-1022                 if x < 0
//
// For erfcx(x) = exp(x²) · erfc(x): bypass the multiplication by exp(−x² − 0.5625)
// in branches 3 and 4 and return the rational form directly:
//   erfcx(x) = (1/x) · exp(−0.5625) · exp(R(z)/S(z))   (z = 1/x²)
// For branches 1 and 2 compute erfcx(x) = exp(x²) · erfc(x) directly via Math.exp;
// the multiplication is well-conditioned in this range.
```

### 1.3 The single critical compensation: `exp(−x²) = exp(−s²) · exp((s−x)(s+x))`

In branches 3 and 4 the asymptotic returns `(1/x) · exp(−x² − 0.5625 + R/S)`.
Computed naively as `exp(−x*x − 0.5625 + R/S) / x`, this *underflows*
when `x*x > 745` (i.e. `x > 27.3`), so SunPro splits:

- Set `s = x` but with the low 32 bits of its float64 mantissa zeroed
  (musl uses `SET_LOW_WORD(z, 0)` — see §7.2 for the JS equivalent).
- Then `−x² = −s² + (s−x)(s+x)`, where `−s²` is computed exactly to
  the precision of `s` (which is single-precision-ish so `s²` is
  representable exactly), and `(s−x)(s+x)` is a tiny correction.
- Final form: `exp(−s² − 0.5625) · exp((s−x)(s+x) + R/S) / x`.

This is the "Note1" in the SunPro header (lines 71–80 of musl
`erf.c`). It is the only non-trivial numerical trick in the algorithm;
the rest is straight rational evaluation.

**JS port note:** there is no `SET_LOW_WORD` in JS. The equivalent is
to round `x` to the nearest representable value with the low 32 bits
of mantissa zeroed:

```ts
// Equivalent of SunPro's `SET_LOW_WORD(z, 0)`.
function maskLowMantissa(x: number): number {
  const buf = new ArrayBuffer(8);
  const dv = new DataView(buf);
  dv.setFloat64(0, x, true);     // little-endian to match x86 layout
  dv.setUint32(0, 0, true);      // zero low 32 mantissa bits
  return dv.getFloat64(0, true);
}
```

This is pure JS, deterministic, no `process.arch` branch. The
little-endian layout is *always* little-endian inside DataView regardless
of host endianness, so the result is the same on every platform.

### 1.4 `erfcx(x)` — derivation

`erfcx(x) := exp(x²) · erfc(x)` — the scaled complementary error
function. Useful because `erfc` underflows for `x > ~26.5` (where
`exp(−x²) < 2⁻¹⁰²²`) but `erfcx(x) ≈ 1/(x·√π) > 0` for arbitrarily
large `x`. Also the natural quantity in the asymptotic series.

Real-axis algorithm:

- **`x < 0` or `|x| < 1.25`** (branches 1–2 in §1.2 terms): compute
  `erfc(x)` from the rational, then `erfcx(x) = exp(x²) · erfc(x)`.
  For `|x| < 1.25`, `exp(x²) ≤ exp(1.5625) ≈ 4.77` — well-conditioned.
- **`|x| ≥ 1.25`** (branches 3–4): the rational form *already* computes
  `exp(−x² − 0.5625 + R/S) · ...`; just *omit* the leading `exp(−x²)`
  and return `(1/x) · exp(−0.5625) · exp(R/S)`.
- **Very large `x`** (Johnson 2012 line 1444): for `x > 50`, switch
  to the continued-fraction-derived 5-term polynomial
  `erfcx(x) ≈ (1/(x√π)) · ((x²(x²+4.5) + 2) / (x²(x²+5) + 3.75))`;
  for `x > 5e7` use the single-term `1/(x√π)`.

### 1.5 Edge constants (full IEEE values)

| Name      | Value (full precision)                  | Role                                                 |
|-----------|-----------------------------------------|------------------------------------------------------|
| `2/√π`    | `1.1283791670955125738961589031215451716881` | leading series coefficient                      |
| `1/√π`    | `0.5641895835477562869480794515607725858440` | leading erfcx coefficient                       |
| `erx`     | `0.84506291151046752929687500000000000000`   | `erf(1)` rounded to single (so `1−erx` is exact)|
| `efx8`    | `1.02703333676410069053`                | musl tiny-x linear coefficient (= `8·(2/√π − 1)`)    |
| `0.5625`  | `9/16 = 0.5625` (exact)                 | asymptotic-shift constant in branches 3 & 4          |
| `2⁻²⁸`    | `3.7252902984619140625e-09` (exact)     | tiny-x threshold                                     |
| `2⁻⁵⁶`    | `1.387778780781445675529539585113525e-17`| `erfc` "almost-1" threshold (`erfc(x) ≈ 1 − x`)     |
| `2⁻¹⁰²²`  | `2.2250738585072013831e-308`            | smallest normal — used as "tiny" saturation         |
| `0.84375` | `27/32 = 0.84375` (exact)               | branch-1 / branch-2 split                            |
| `1.25`    | `1.25` (exact)                          | branch-2 / branch-3 split                            |
| `1/0.35`  | `≈ 2.85714285714285714`                 | branch-3 / branch-4 split                            |
| `6.0`     | `6` (exact)                             | erf saturation threshold                             |
| `28.0`    | `28` (exact)                            | erfc saturation threshold                            |

---

## 2. Recommended algorithm split — complex `z`

### 2.1 The Faddeeva function

```
w(z) := exp(−z²) · erfc(−i z)    (the Faddeeva / scaled complementary error function)
erfc(z) = exp(−z²) · w(i z)       for Im(z) ≥ 0
erf(z)  = 1 − erfc(z)
erfcx(z) = w(i z)                 (i.e., `w` is the natural complex erfcx)
```

All four complex error functions reduce to `w(z)`. So the algorithm
decision is: **how do we compute `w(z)` to ≤ 1e-13 relative error
across all of `ℂ`?**

### 2.2 The Faddeeva-Johnson hybrid (the canonical answer)

Stephen G. Johnson's 2012 MIT-licensed Faddeeva library is the
modern consensus implementation. It is used by Julia (via
`openspecfun`), GSL (as an option), and dozens of physics
codes. The algorithm:

| Region                                   | Algorithm                       | Source                              |
|------------------------------------------|---------------------------------|-------------------------------------|
| `|Im z| > 7`                             | Continued fraction (CF)         | Poppe-Wijers 1990                   |
| `|Re z| > 6, |Im z| > 0.1`               | CF                              | Poppe-Wijers 1990                   |
| `|Re z| > 8, |Im z| > 1e-10`             | CF                              | Poppe-Wijers 1990                   |
| `|Re z| > 28`                            | CF                              | (or 1-term `i/(√π z)` if z>1e7)    |
| `Im z = 0` (real axis)                   | `erfcx_y100` lookup-Chebyshev   | Johnson 2012 (1500 LOC of tables)   |
| `Re z = 0` (imaginary axis)              | `w_im_y100` lookup-Chebyshev    | Johnson 2012                        |
| **Everything else** (the "bulk")         | Zaghloul-Ali Algorithm 916      | ACM TOMS 38(2), 2011                |

**Why not pure Poppe-Wijers everywhere?** Because the continued
fraction loses 5+ bits of relative accuracy in `Re w` for `6 < x < 28`
and `y < 0.1` (the "bad band"). Zaghloul flagged this in his 2012
note; Johnson's library switches to Alg. 916 in that band.

**Why not pure Alg. 916 everywhere?** Because Alg. 916 is a series in
`exp(−a²n²)` that needs up to ~64 terms for ulp-level accuracy; for
large `|z|` the CF is 5–10× faster. Johnson originally used Alg. 916
for all `z` and benchmarked; the hybrid wins.

**Term count for Poppe-Wijers CF:** Johnson uses `nu ≈ 3 + 1442/(26·ρ
+ 77)` where `ρ = √((x/6.3)² + (y/4.4)²)` (an NLopt-fitted
approximation to a more exact form). The constants `x₀ = 6.3`,
`y₀ = 4.4` are from the original Poppe-Wijers paper. Typical depth:
~20 terms for `|z| ~ 10`, ~6 terms for `|z| ~ 100`.

**Algorithm 916 parameter:** `a = π/√(−log(ε/2)) ≈ 0.5183` for
`ε = 2⁻⁵²` (DBL_EPSILON). The series is:

```
w(z) = (i/π) · ∫_{-∞}^{+∞} exp(−t²) / (z − t) dt
     ≈ (2a/π) · z · Σ_{n=0}^N  exp(−a²n²) / (a²n² − z²)    + correction terms
```

Truncation `N` chosen adaptively until the trailing exponential
factor falls below the requested relative error. Typical `N ≈ 20–40`
for `|z| < 5`.

### 2.3 Special handling at the axes

- **`Im(z) = 0`** (real axis): `w(x) = exp(−x²) + i · (2/√π)·Dawson(x)`.
  The real part is straight `Math.exp(−x²)`; the imaginary part needs
  the Dawson integral, computed via `w_im_y100` — a 100-panel
  Chebyshev lookup over `y = 1/(1+|x|)`. Same shape as `erfcx_y100`.
- **`Re(z) = 0`** (imaginary axis): `w(iy) = erfcx(y)` for `y ≥ 0`
  (real-valued). Routes directly to the real-axis `erfcx`.
- **`z = 0`**: `w(0) = 1` exactly.

### 2.4 Small-`|z|` Taylor for `erf(z)` (complex)

`erf(z)` for small `|z|` is computed *not* via the `1 − exp(−z²)·w(iz)`
identity (catastrophic cancellation; both terms are near 1), but via
the Taylor series at `z = 0`:

```
erf(z) = (2/√π) · z · (1 − z²/3 + z⁴/10 − z⁶/42 + z⁸/216 − …)
       = z · (1.1283791670955125739 + (−z²)·(0.37612638903183752464
                                   + (−z²)·(0.11283791670955125739
                                   + (−z²)·(0.026866170645131251760
                                   + (−z²)·0.0052239776254421878422))))
```

Johnson's library switches to this Taylor for `|x| < 0.08` AND
`|y| < 0.01` — the "cancellation band." 5 terms suffice for ULP
accuracy in this region. Coefficients = `(2/√π) · (−1)ⁿ/(n!·(2n+1))`
for `n = 0..4`.

### 2.5 The verdict for our substrate

**Adopt Faddeeva-Johnson verbatim.** Specifically:

1. Port the 2529-LOC `Faddeeva.cc` to TS (`linalg-core`-style
   numeric module under `packages/quadrature` or its own new package
   `packages/erf-numeric`).
2. The `erfcx_y100` and `w_im_y100` Chebyshev tables (the bulk of the
   code) translate as straight `Float64Array` constants. Each panel
   is degree 6 or 7, so each panel is 7 or 8 doubles; 100 panels =
   ~750 doubles per function = 6 KB per table.
3. The CF and Alg. 916 inner loops are short (~30 lines each) and
   port one-for-one with `Math.exp`, `Math.cos`, `Math.sin`,
   `Math.log`.
4. The MIT license permits inclusion verbatim (with attribution).

There is **no in-house algorithm** worth designing here. Faddeeva-
Johnson is the world's best public-domain-or-MIT float64 complex
erf, and the work was specifically motivated by the same concern we
have ("avoid 5-bit accuracy loss in `Re w` for the bad band").

---

## 3. Inverse-function plan — real `x`

### 3.1 `erfinv(x)` for `x ∈ (−1, 1)`

Use the **Blair-Edwards-Johnson 1976** rational approximants, as in
SpecialFunctions.jl `_erfinv(::Float64)`. Three intervals:

| Range          | Variable                  | Numerator deg | Denominator deg | Source        |
|----------------|---------------------------|---------------|-----------------|---------------|
| `|x| ≤ 0.75`   | `t = x² − 0.5625`         | 6             | 6               | Blair Table 17|
| `0.75 < |x| ≤ 0.9375` | `t = x² − 0.87890625`   | 7             | 7               | Blair Table 37|
| `|x| > 0.9375` | `t = 1/√(−log(1−|x|))`    | 8             | 9               | Blair Table 57|

The transformation `t = x² − const` shifts the rational's centre to
roughly the middle of each interval, minimising the Chebyshev-like
error envelope. For the tail interval, `t = 1/√(−log(1−|x|))` is the
canonical "make the function smooth in a new coordinate" trick — as
`|x| → 1`, `−log(1−|x|) → ∞`, so `t → 0`; the inverse-erf grows like
`√(−log(1−|x|))`, hence `erfinv ≈ Q(t)/(t·P(t))` is smooth at `t=0`.

The coefficient values are reproduced in §4.3 — all literal doubles,
all attributable to Blair 1976.

### 3.2 `erfcinv(y)` for `y ∈ (0, 2)`

| Range                | Strategy                                        |
|----------------------|-------------------------------------------------|
| `y > 0.0625`         | Reduce: `erfcinv(y) = erfinv(1 − y)`            |
| `1e-100 ≤ y ≤ 0.0625`| Blair Table 57 (same as `erfinv` tail), `t = 1/√(−log y)` |
| `y < 1e-100`         | Blair Table 80 (deg 7/deg 8), same variable     |

The Table-80 fallback is for **extreme survival-function inversion**
— it lets `erfcinv` cover the full `y ∈ (0, 2)` domain down to
`y ≈ 5e-324` (the smallest positive denormal). The reduction
`erfinv(1−y)` would fail for tiny `y` because `1 − y` is exact only
when `y < eps`, after which `1 − y` rounds to `1.0` and `erfinv(1.0)
= +∞`. So the tail tables are *load-bearing* for ill-conditioned
statistical inputs.

### 3.3 Newton-refinement option (not needed for Float64)

For BigFloat, SpecialFunctions.jl uses one Newton step:
`Δx = (√π/2) · (erf(x) − y) · exp(x²)`. For Float64 the Blair table
output is already 1 ULP, so Newton is **not** needed; *if* we wanted
0.5-ULP correctness for `erfinv` we could add one Newton step (cost:
one `erf` evaluation + one `Math.exp`), but the standard libm
discipline is 1 ULP, so leaving Blair's output unrefined matches
Julia, R, and SciPy behaviour.

### 3.4 No complex `erfinv` (out of scope)

The complex inverse error function `erf⁻¹(z)` is a multi-valued
function on a Riemann surface. The DLMF (§7.17) discusses it but
gives no canonical computational form; SpecialFunctions.jl, GSL, and
Boost.Math all decline to implement complex `erfinv`. Defer to a
future ADR; not in scope for R3.

---

## 4. Coefficient tables (TS-ready)

All values are reproduced verbatim from the cited primary source so
each can be cross-checked against the original. The TS port should
emit each constant as a literal `number` in JavaScript (not
`Math.fround` — that would discard low bits). V8 parses each
shortest-round-trip decimal exactly to its IEEE-754 double.

### 4.1 musl `erf.c` coefficients (Sun 1993 / FreeBSD msun lineage)

Each row: name, JS-ready value, comment.

```ts
// Special constants
export const ERX  = 0.84506291151046752929687500;   // = erf(1) rounded to single precision
                                                    // so (1 - ERX) is exact in double.
export const EFX8 = 1.02703333676410069053;         // = 8 * (2/sqrt(pi) - 1)
                                                    // for the tiny-x linearisation.

// Branch 1 (|x| < 0.84375):  erf(x) = x + x * pp(x^2) / qq(x^2)
//   pp(z) is degree 4 in z = x^2;  qq(z) is degree 5 (leading 1 implicit).
// Source: musl src/math/erf.c, Sun Microsystems 1993.
// Error bound: |R - (erf(x)-x)/x| < 2^-57.90  (from source comment)
export const PP = [
   1.28379167095512558561e-01,  // pp0
  -3.25042107247001499370e-01,  // pp1
  -2.84817495755985104766e-02,  // pp2
  -5.77027029648944159157e-03,  // pp3
  -2.37630166566501626084e-05,  // pp4
] as const;
export const QQ = [
  // implicit 1.0 leading
   3.97917223959155352819e-01,  // qq1
   6.50222499887672944485e-02,  // qq2
   5.08130628187576562776e-03,  // qq3
   1.32494738004321644526e-04,  // qq4
  -3.96022827877536812320e-06,  // qq5
] as const;

// Branch 2 (0.84375 ≤ |x| < 1.25):  let s = |x| - 1
//   erfc(x) = (1 - ERX) - P1(s) / Q1(s)   for x > 0
//   erf(x)  = sign(x) * (ERX + P1(s) / Q1(s))
// Error bound: |P1/Q1 - (erf|x|-c)| < 2^-59.06
export const PA = [
  -2.36211856075265944077e-03,  // pa0
   4.14856118683748331666e-01,  // pa1
  -3.72207876035701323847e-01,  // pa2
   3.18346619901161753674e-01,  // pa3
  -1.10894694282396677476e-01,  // pa4
   3.54783043256182359371e-02,  // pa5
  -2.16637559486879084300e-03,  // pa6
] as const;
export const QA = [
  // implicit 1.0 leading
   1.06420880400844228286e-01,  // qa1
   5.40397917702171048937e-01,  // qa2
   7.18286544141962662868e-02,  // qa3
   1.26171219808761642112e-01,  // qa4
   1.36370839120290507362e-02,  // qa5
   1.19844998467991074170e-02,  // qa6
] as const;

// Branch 3 (1.25 ≤ |x| < 1/0.35 ≈ 2.857):
//   erfc(x) = (1/x) · exp(−x² − 0.5625 + R1(z)/S1(z))    where z = 1/x²
//   R1 is degree 7 in z;  S1 is degree 8 (implicit leading 1).
// Error bound: |R1/S1 - g(z)| < 2^-62.57   where g(z) = log(erfc(x)·x) - x² + 0.5625
export const RA = [
  -9.86494403484714822705e-03,  // ra0
  -6.93858572707181764372e-01,  // ra1
  -1.05586262253232909814e+01,  // ra2
  -6.23753324503260060396e+01,  // ra3
  -1.62396669462573470355e+02,  // ra4
  -1.84605092906711035994e+02,  // ra5
  -8.12874355063065934246e+01,  // ra6
  -9.81432934416914548592e+00,  // ra7
] as const;
export const SA = [
  // implicit 1.0 leading
   1.96512716674392571292e+01,  // sa1
   1.37657754143519042600e+02,  // sa2
   4.34565877475229228821e+02,  // sa3
   6.45387271733267880336e+02,  // sa4
   4.29008140027567833386e+02,  // sa5
   1.08635005541779435134e+02,  // sa6
   6.57024977031928170135e+00,  // sa7
  -6.04244152148580987438e-02,  // sa8
] as const;

// Branch 4 (1/0.35 ≤ |x| < 28):
//   erfc(x) = (1/x) · exp(−x² − 0.5625 + R2(z)/S2(z))    where z = 1/x²
//   R2 is degree 6 in z;  S2 is degree 7 (implicit leading 1).
// Error bound: |R2/S2 - g(z)| < 2^-61.52
export const RB = [
  -9.86494292470009928597e-03,  // rb0
  -7.99283237680523006574e-01,  // rb1
  -1.77579549177547519889e+01,  // rb2
  -1.60636384855821916062e+02,  // rb3
  -6.37566443368389627722e+02,  // rb4
  -1.02509513161107724954e+03,  // rb5
  -4.83519191608651397019e+02,  // rb6
] as const;
export const SB = [
  // implicit 1.0 leading
   3.03380607434824582924e+01,  // sb1
   3.25792512996573918826e+02,  // sb2
   1.53672958608443695994e+03,  // sb3
   3.19985821950859553908e+03,  // sb4
   2.55305040643316442583e+03,  // sb5
   4.74528541206955367215e+02,  // sb6
  -2.24409524465858183362e+01,  // sb7
] as const;
```

**Verification:** these 60+ values are reproducible byte-for-byte from
`musl-1.2.x:src/math/erf.c`, `glibc:sysdeps/ieee754/dbl-64/s_erf.c`,
`FreeBSD/sys/lib/libc/x86_64/sys/s_erf.c`. The hex IEEE-754 forms are
in the C source as comments — they should be carried into our TS as
verification comments so an agent can confirm bit-equality.

### 4.2 Taylor-series coefficients (complex erf, small `|z|`)

```ts
// erf(z) = (2/sqrt(pi)) * z * (1 - z²/3 + z⁴/10 - z⁶/42 + z⁸/216 - ...)
// Reorganised as horner in mz2 = -z²:
//   erf(z) = z * (c0 + mz2*(c1 + mz2*(c2 + mz2*(c3 + mz2*c4))))
// where c_n = (2/sqrt(pi)) / (n! * (2n+1)) (negative sign absorbed into mz2).
// 5 terms suffice for ULP accuracy on |z| < 0.1 (Faddeeva-Johnson 2012).
export const ERF_TAYLOR = [
  1.1283791670955125739,     // (2/sqrt(pi)) / (0! * 1)
  0.37612638903183752464,    // (2/sqrt(pi)) / (1! * 3)
  0.11283791670955125739,    // (2/sqrt(pi)) / (2! * 5)  · (1/2!) factor pre-applied
  0.026866170645131251760,   // (2/sqrt(pi)) / (3! * 7)
  0.0052239776254421878422,  // (2/sqrt(pi)) / (4! * 9)
] as const;
```

### 4.3 Blair-1976 `erfinv` Float64 coefficients

```ts
// erfinv, |x| <= 0.75  (Blair Table 17)
// Variable: t = x*x - 0.5625
// Form: erfinv(x) = x * P(t) / Q(t)
// Reference: Blair, Edwards & Johnson, "Rational Chebyshev approximations
//            for the inverse of the error function", Math. Comp. 30 (1976), 827-830.
//            Table 17 (Float64 target, JM 0.75).
export const ERFINV_TAB17_P = [
   0.16030495584406622931e+2,   // P_0
  -0.90784959262960326650e+2,   // P_1
   0.18644914861620987391e+3,   // P_2
  -0.16900142734642382420e+3,   // P_3
   0.65454662847944870480e+2,   // P_4
  -0.86421301158724779400e+1,   // P_5
   0.17605878213905900000e+0,   // P_6
] as const;
export const ERFINV_TAB17_Q = [
   0.14780647071513831611e+2,   // Q_0
  -0.91374167024260313936e+2,   // Q_1
   0.21015790486205317714e+3,   // Q_2
  -0.22210254121855132366e+3,   // Q_3
   0.10760453916055123830e+3,   // Q_4
  -0.20601073032826544430e+2,   // Q_5
   1.0,                          // Q_6  (explicit leading 1)
] as const;

// erfinv, 0.75 < |x| <= 0.9375  (Blair Table 37)
// Variable: t = x*x - 0.87890625
export const ERFINV_TAB37_P = [
  -0.15238926344072612800e-1,
   0.34445569241361252160,
  -0.29344398672542478687e+1,
   0.11763505705217827302e+2,
  -0.22655292823101104193e+2,
   0.19121334396580330163e+2,
  -0.54789276195983187690e+1,
   0.23751668902444800000,
] as const;
export const ERFINV_TAB37_Q = [
  -0.10846516960205995400e-1,
   0.26106288858430785110,
  -0.24068318104393757995e+1,
   0.10695129973387014469e+2,
  -0.23716715521596581025e+2,
   0.24640158943917284883e+2,
  -0.10014376349783070835e+2,
   1.0,
] as const;

// erfinv, |x| > 0.9375  (Blair Table 57)
// Variable: t = 1 / sqrt(-log1p(-|x|))
// Form: erfinv(x) = P(t) / (sign(x) * t * Q(t))
export const ERFINV_TAB57_P = [
   0.10501311523733438116e-3,
   0.10532611314233381642e-1,
   0.26987802736243283545,
   0.23268695788919690806e+1,
   0.71678547949107996810e+1,
   0.85475611822167827825e+1,
   0.68738088073543839802e+1,
   0.36270024830958708930e+1,
   0.88606273929651546815,
] as const;
export const ERFINV_TAB57_Q = [
   0.10501266687030337690e-3,
   0.10532862300933275311e-1,
   0.27019862373751554846,
   0.23501436397970253259e+1,
   0.76078028785801277064e+1,
   0.11181586104056907827e+2,
   0.11948787918435396668e+2,
   0.81922409747269907894e+1,
   0.40993879076368015361e+1,
   1.0,
] as const;

// erfcinv, y < 1e-100  (Blair Table 80)
// Variable: t = 1 / sqrt(-log(y))
// Form: erfcinv(y) = P(t) / (t * Q(t))
export const ERFCINV_TAB80_P = [
   0.34654298588086350177e-9,
   0.25084679202407570521e-6,
   0.47378131963728602987e-4,
   0.31312603759778696408e-2,
   0.77948764544143536994e-1,
   0.70045681233581643868,
   0.18710420342167931669e+1,
   0.71452547743135145428,
] as const;
export const ERFCINV_TAB80_Q = [
   0.34654295673159511156e-9,
   0.25084690799758802711e-6,
   0.47379531295974913536e-4,
   0.31320635364617768848e-2,
   0.78073489062764897215e-1,
   0.70715044799533758620,
   0.19998515434911215105e+1,
   0.15072902692731680009e+1,
   1.0,
] as const;
```

### 4.4 Algorithm 916 + Poppe-Wijers control constants (complex `w(z)`)

```ts
// Faddeeva-Johnson 2012, Faddeeva.cc lines 700-710.
// For relerr = DBL_EPSILON ≈ 2.22e-16:
export const ALG916_a   = 0.518321480430085929872;  // π / sqrt(-log(eps/2))
export const ALG916_c   = 0.329973702884629072537;  // (2/π) * a
export const ALG916_a2  = 0.268657157075235951582;  // a²

// For other relerr targets:
//   a  = pi / sqrt(-log(relerr/2))
//   c  = (2/pi) * a
//   a² = a*a

// Poppe-Wijers term count (Johnson's NLopt-tuned version):
//   nu(rho) ≈ 3 + 1442/(26·rho + 77)
//   rho = sqrt((x/x0)² + (y/y0)²)
//   x0 = 6.3,  y0 = 4.4    (from Poppe-Wijers 1990)
//
// Special cases inside Johnson's CF dispatch:
//   nu == 1 if x + |y| > 1e7   (w(z) ≈ i/(sqrt(π)·z))
//   nu == 2 if x + |y| > 4000  (5-term truncated CF)
//   otherwise compute nu from formula above (typical 5-50)

export const ISPI = 0.56418958354775628694807945156;  // 1 / sqrt(pi)
```

### 4.5 Asymptotic-series coefficients (DLMF 7.12.1)

For verification / fallback only — *not* used in the dispatch above
because the rational `R(z)/S(z)` forms (branches 3 & 4) dominate.

```ts
// erfc(x) ~ exp(-x²) / (x*sqrt(π)) * Σ_{k=0}^∞  (-1)^k · (2k-1)!! / (2x²)^k
//        =  exp(-x²) / (x*sqrt(π)) * (1 - 1/(2x²) + 3/(2x²)² - 15/(2x²)³ + 105/(2x²)⁴ - ...)
// Coefficients: c_k = (-1)^k · (2k-1)!! / 2^k   (so each term is c_k / x^(2k))
//   c_0 = 1
//   c_1 = -0.5
//   c_2 = 0.75
//   c_3 = -1.875
//   c_4 = 6.5625
//   c_5 = -29.53125
//   c_6 = 162.421875
//   c_7 = -1055.7421875
// Diverges asymptotically; optimal truncation N_opt ≈ x² (terms decrease then grow).
```

The Sun/musl branches 3-4 *don't* use this directly; they fit a
rational to `g(s) = log(erfc(x)·x) − x² + 0.5625` which absorbs the
asymptotic structure into the rational form, eliminating divergence.

---

## 5. Accuracy budget

### 5.1 Target

`numerical: true` tier (ADR-0015): **bit-identical given platform
fingerprint**. The accuracy *target* is libm parity: ≤ 1 ULP for
`erf`, ≤ 2 ULP for `erfc`. The *contract* is that two runs on the
same platform produce the same bytes.

### 5.2 Per-branch achieved error (from primary sources)

| Function | Branch          | Source-reported max relative error | In ULPs of result |
|----------|-----------------|------------------------------------|-------------------|
| `erf`    | 1 (tiny / `< 0.84375`) | `< 2⁻⁵⁷·⁹⁰ ≈ 5.3e-18`           | ≤ 1 ULP           |
| `erf`    | 2 (`< 1.25`)           | `< 2⁻⁵⁹·⁰⁶ ≈ 1.6e-18`           | ≤ 1 ULP           |
| `erfc`   | 3 (`< 2.857`)          | `< 2⁻⁶²·⁵⁷ ≈ 1.4e-19`           | ≤ 1 ULP after `exp` |
| `erfc`   | 4 (`< 28`)             | `< 2⁻⁶¹·⁵² ≈ 2.9e-19`           | ≤ 2 ULP after `exp` |
| `erfcx`  | 3 (`< 2.857`)          | rational `R/S` bound only        | ≤ 1 ULP           |
| `erfcx`  | 4 (`< 28`)             | rational `R/S` bound only        | ≤ 1 ULP           |
| `erfinv` | Blair Tab 17/37/57     | ≤ 1e-19 (Blair 1976 design target) | ≤ 1 ULP         |
| `erfcinv`| Blair Tab 57/80        | ≤ 1e-19                          | ≤ 1 ULP           |
| `w(z)`   | Alg. 916 + CF hybrid   | ≤ 1.3e-13 (Johnson 2012 claim)   | ≤ ~600 ULP        |

**The complex `w` is the weakest link.** Johnson's 1.3e-13 claim
corresponds to ~13 decimal digits or ~43 mantissa bits — about
10⁻³ relative to a perfect IEEE-754 round. This is the published
state of the art; doing better requires algorithmic innovation
(Karbach, Weideman, multi-precision intermediate) that no
public-domain implementation has demonstrated for the entire
complex plane at float64.

**For real-axis `erf`/`erfc`/`erfcx`/`erfinv`/`erfcinv`** the budget
is 1 ULP and we meet it via the SunPro and Blair algorithms.

### 5.3 Cancellation traps avoided by the dispatch

- **`erf(x)` for `x` slightly > 0.84375**: Sun branch 2 returns `erf
  = ERX + P1(s)/Q1(s)` with `s = x − 1`. `ERX = 0.84506291`; `P1/Q1`
  is small for `|s| < 0.16`. No cancellation.
- **`erfc(x)` for tiny `x`** (`|x| < 2⁻⁵⁶`): musl returns `1.0 − x`
  exactly (no rational eval). For `2⁻⁵⁶ < |x| < 0.25`, returns
  `1.0 − (x + x·y)` straight. For `0.25 < |x| < 0.84375`, the
  rearrangement `0.5 − (x − 0.5 + x·y)` preserves the `0.5` digit
  exactly via the constant pre-subtraction.
- **`erf(x)` for `x ≳ 6`**: returns `sign(x)·(1 − 2⁻¹⁰²²)`. The
  alternative `1 − erfc(x)` would round to `1.0` (loss of all
  bits); the saturation preserves the "sub-1" semantics for the
  small fraction of code that distinguishes.

---

## 6. Edge-case table

| Input           | `erf`              | `erfc`              | `erfcx`             | `erfinv`             | `erfcinv`            |
|-----------------|--------------------|---------------------|---------------------|----------------------|----------------------|
| `+0`            | `+0`               | `1`                 | `1`                 | `+0`                 | `+∞`                 |
| `-0`            | `-0`               | `1`                 | `1`                 | `-0`                 | n/a (`y > 0`)        |
| `+∞`            | `1`                | `+0`                | `+0` (asymptotic)   | n/a (input ≤ 1)      | n/a                  |
| `-∞`            | `-1`               | `2`                 | `+∞` (`exp(∞)`)     | n/a                  | n/a                  |
| `NaN`           | `NaN`              | `NaN`               | `NaN`               | `NaN`                | `NaN`                |
| subnormal `±x`  | `±(2/√π)·x` (linear, no underflow) | `1 ∓ (2/√π)·x` (preserves bit of x) | `1` (since `exp(x²) → 1`) | `±(√π/2)·x` (linear)| huge (table 80)|
| `0.84375 − ulp` | branch 1 transitions cleanly | likewise | likewise | branch Tab17 boundary | n/a |
| `0.84375`       | branch 2           | branch 2            | branch 2            | Tab37 boundary       | n/a                  |
| `1.0`           | `0.842700793…` (Branch 2: erf(1)=erx+P1/Q1, P1(0)=pa0=−2.36e-3) | `0.157299206…` | `≈ 0.4275836…` (erfcx(1) = e·(1−erf(1))) | `0.4769362762…` | n/a |
| `6.0`           | `1 − 2⁻¹⁰²²` (saturation) | `2.151971e-17`     | `0.09397628…` (rational) | n/a            | n/a                  |
| `28.0`          | `1 − 2⁻¹⁰²²`       | `2⁻¹⁰²² · 2⁻¹⁰²²` (underflow) | `~0.0201…` | n/a              | n/a                  |
| `1e10`          | `1`                | `0` (underflow)     | `5.64e-11` (= `1/(√π·x)`) | n/a            | n/a                  |
| `x = 1.0` (erfinv)| n/a               | n/a                 | n/a                 | `+∞`                 | n/a                  |
| `x = -1.0` (erfinv)| n/a              | n/a                 | n/a                 | `-∞`                 | n/a                  |
| `|x| > 1` (erfinv)| n/a               | n/a                 | n/a                 | **`ToolError`** (malformed) | n/a          |
| `y = 0` (erfcinv) | n/a               | n/a                 | n/a                 | n/a                  | `+∞`                 |
| `y = 2` (erfcinv) | n/a               | n/a                 | n/a                 | n/a                  | `-∞`                 |
| `y < 0 or y > 2`  | n/a               | n/a                 | n/a                 | n/a                  | **`ToolError`**      |

**Sign preservation:** the SunPro algorithm preserves sign of zero
via `1 − 2*sign + 1/x` for NaN/inf, but in JS the cleaner form is
`x === 0 ? x : ...` (returns `+0` or `-0` matching input).

**Underflow/overflow:** all branches use bounded constants. The
only operation that can `Math.exp(−x²)` → 0 is in `erfc(x)` for
`x > 27.3`; the dispatch checks `|x| ≥ 28` and returns `tiny²` =
`2⁻²⁰⁴⁴`, which is itself `0` in float64. The `erfcx` branch never
underflows — it returns `(1/x)·exp(−0.5625)·exp(R/S) ≈ 1/(x·√π)` for
large `x`.

---

## 7. Integration with `@workbench/quadrature::evalNumericExpr`

### 7.1 Where the new code lands

`evalNumericExpr` lives in `packages/quadrature/src/eval-expr.ts`
(line numbers as of 2026-05-16). The current vocabulary explicitly
excludes erf:

```ts
// Out of scope (deliberate, v0.1)
// ...No `gamma`/`erf`/Bessel functions (require a numerical
// implementation beyond `Math.*`; tier-3, file separately when
// motivated).
```

R3 motivates the filing. The plan:

1. **New module** `packages/quadrature/src/eval-numeric-expr.ts` (or
   keep editing `eval-expr.ts` — the user-facing message under bead
   `R3` is *new file* per orchestration framing). Hosts the
   numeric-only evaluator that supports the closed vocab *plus*
   `erf`/`erfc`/`erfcx`/`erfinv`/`erfcinv`. The current
   `eval-expr.ts` keeps its name as the *integrand evaluator* used by
   `tools/integrate-1d`; the new file is its sibling that adds the
   special-function vocabulary.
2. **New package** `packages/erf-float64` (or inline into
   `@workbench/quadrature` if scope stays small) — pure-TS port of
   the SunPro algorithm + Blair tables + Faddeeva-Johnson port.
   Exports `erf`, `erfc`, `erfcx`, `erfinv`, `erfcinv` (real-axis),
   plus `wOfZ`, `erfComplex`, `erfcComplex`, `erfcxComplex`.
3. **Extend `applyHead`** in the numeric evaluator with new branches:

   ```ts
   case "erf":     return erf(unaryArg("erf", args, env));
   case "erfc":    return erfc(unaryArg("erfc", args, env));
   case "erfcx":   return erfcx(unaryArg("erfcx", args, env));
   case "erfinv":  return erfinv(unaryArg("erfinv", args, env));
   case "erfcinv": return erfcinv(unaryArg("erfcinv", args, env));
   ```

4. **Extend `ADMITTED_HEADS`** with the same five names.

5. **Schema discipline (ADR-0003 / ADR-0023):** `erfinv` and
   `erfcinv` have domain restrictions. The contract is:
   - In-domain `x ∈ [−1, 1]` → return the value (NaN for `|x|>1` is
     fine *inside* `evalNumericExpr`, which is faithful to IEEE-754).
   - The quadrature driver (`gaussKronrodAdaptive`) catches non-finite
     and surfaces the boundary tag — same discipline as `log(negative)`
     today. No change to driver code.

### 7.2 The `evalSpecial(head, evaluatedArgs)` extension point — does it exist?

Per the brief: "proposed dispatch (probably in `evalSpecial(head,
evaluatedArgs)` extension point)." Checking
`packages/quadrature/src/eval-expr.ts` — **there is no
`evalSpecial`** in the current code. The dispatch is a single
`switch (head)` inside `applyHead`. The cleanest extension is:

**Option A — extend the existing switch in `applyHead`** (5 added
lines, no new abstraction). Simplest; consistent with existing
shape; what the rest of the vocab does.

**Option B — split into `applyMath(head, args, env)` (Math.* heads)
and `applySpecial(head, args, env)` (erf/gamma/Bessel)** with a
dispatcher choosing between them. Adds an abstraction; pays off when
the special-function vocab reaches ~5+ heads (which it will when
gamma, beta, the Bessels arrive). The R3 epic alone adds 5 heads —
already enough.

**Recommendation:** Option B at the R3 implementation moment. The
split lands cleanly because:

- `applyMath` stays slim (current ~20 cases).
- `applySpecial` is a fresh switch — opens cleanly for R3's 5
  additions, and the gamma/Bessel siblings (filed separately) can
  drop into the same dispatcher without re-touching the math path.
- The `evalNumericExpr` entry stays exactly as today (the only
  change is one new `import`).

Sketch:

```ts
// packages/quadrature/src/eval-numeric-expr.ts (NEW, sibling of eval-expr.ts)
import { erf, erfc, erfcx, erfinv, erfcinv } from "@workbench/erf-float64";
import { evalNumericExpr as evalCore, applyHead as applyMath, ADMITTED_HEADS as MATH_HEADS } from "./eval-expr.js";

const SPECIAL_HEADS = ["erf", "erfc", "erfcx", "erfinv", "erfcinv"] as const;
type SpecialHead = typeof SPECIAL_HEADS[number];
const SPECIAL_HEADS_SET = new Set<string>(SPECIAL_HEADS);

export function applySpecial(head: SpecialHead, args: readonly Value[], env: Map<string, number>): number {
  const x = evalNumericExpr(args[0]!, env);  // unary only for now
  switch (head) {
    case "erf":     return erf(x);
    case "erfc":    return erfc(x);
    case "erfcx":   return erfcx(x);
    case "erfinv":  return erfinv(x);
    case "erfcinv": return erfcinv(x);
  }
}

export function evalNumericExpr(e: Value, env: Map<string, number>): number {
  if (e.kind === "expression" && SPECIAL_HEADS_SET.has(e.head)) {
    return applySpecial(e.head as SpecialHead, e.args, env);
  }
  return evalCore(e, env);
}

export const ADMITTED_HEADS = [...MATH_HEADS, ...SPECIAL_HEADS] as const;
```

### 7.3 The bit-level helper for SunPro's `SET_LOW_WORD`

As noted in §1.3, the asymptotic-branch trick needs a "mask low 32
mantissa bits to zero" operation. The JS equivalent:

```ts
// Returns `x` with the low 32 bits of its mantissa zeroed, i.e.,
// truncated to "high half" precision. Used in the SunPro asymptotic
// erfc/erfcx branches to compute exp(−x²) without losing precision
// to cancellation.
//
// Deterministic across platforms: DataView always uses little-endian
// when explicitly told, regardless of host endianness, and the JS
// number → IEEE-754 round-trip is bit-exact per ECMAScript 11.1.3.3.
const FLOAT_MASK_BUFFER = new ArrayBuffer(8);
const FLOAT_MASK_VIEW = new DataView(FLOAT_MASK_BUFFER);
export function maskLowMantissa(x: number): number {
  FLOAT_MASK_VIEW.setFloat64(0, x, true);  // little-endian
  FLOAT_MASK_VIEW.setUint32(0, 0, true);   // zero low 32 mantissa bits
  return FLOAT_MASK_VIEW.getFloat64(0, true);
}
```

The buffer is module-level (allocated once); no GC pressure inside
the hot loop.

### 7.4 `linalg-core` placement vs `@workbench/erf-float64`

The R3 epic implicitly creates *the world's best Erf substrate*. Two
co-equal motivations:

- **Quadrature integrand vocabulary** — `evalNumericExpr` consumption.
- **Other tools / packages** that want `erf` directly without going
  through the integrand evaluator (Berry-smoothing in `meijer-core`,
  e.g., per bead `ybrw` "bigErfc(x, prec) arbprec — unlocks Berry
  smoothing in Stokes band").

This argues for a **standalone `@workbench/erf-float64` package**, not
a buried-in-quadrature module. The quadrature package then imports
the float64 surface; the arb-prec sibling (R2 / `bigErfc`) lives in
`@workbench/erf-bigfloat` or `@workbench/erf-arbprec`. This mirrors
the `@workbench/linalg-core` (float64) vs implicit arb-prec linalg
split per ADR-0014.

### 7.5 Tool layer

If a `tools/erf` tool is desired (the brief doesn't strictly require
one), it would be a thin `defineTool` wrapper:

```ts
input: S.record({
  x:    S.kind("float64"),
  kind: S.kind("string"),  // one of "erf"|"erfc"|"erfcx"|"erfinv"|"erfcinv"
})
output: S.kind("float64")
```

with the `--kind` enum flag exposed per ADR-0011. But the
*primary* substrate value is in-process consumption; the tool wrapper
is a follow-up.

---

## 8. Determinism analysis

### 8.1 The ADR-0015 contract restated

`numerical: true` ⇒ bit-identical *given* platform fingerprint
`{arch, os, runtime}`. The fingerprint records the platform; the
runtime cache hits only on matching fingerprints. Cross-platform
divergence is admissible but recorded.

### 8.2 Sources of float64 non-determinism in V8

V8's `Math.exp`, `Math.log`, `Math.sin`, `Math.cos`, `Math.sqrt`,
division, and FMA are all IEEE-754-compliant per the ECMAScript
spec, but their *last-bit results* depend on the underlying CPU
math library (which V8 may delegate to via SIMD `vrsqrt`, AVX-512
`vexp2`, etc.) on some platforms. The Bun/V8 implementation on
linux-x86_64 produces bit-identical results across versions 1.2.21 ↔
1.3.13 (per the ADR-0015 measurement, `docs/data/cross-bun-stability/`).

### 8.3 Audit: does our algorithm introduce *additional* sources?

Walking the algorithm:

1. **Coefficient parsing.** Constants like `1.28379167095512558561e-01`
   are parsed by V8 at module load. ECMAScript 11.1.3.3 specifies
   round-to-nearest-even; V8 implements this correctly. **Bit-identical
   across V8 versions on all platforms.**
2. **Horner evaluation** of `pp(z), qq(z), pa(s), qa(s), ra(z),
   sa(z), rb(z), sb(z), P(t), Q(t)`. Pure float64 add/multiply chains.
   IEEE-754-conformant, cross-version stable on a fixed arch.
   **Inherits ADR-0015 fingerprint.**
3. **Division** in `P/Q`. IEEE-754 round-to-nearest-even.
   Cross-arch-stable on conformant CPUs (x86_64, aarch64). **Inherits.**
4. **`Math.exp`** in the asymptotic branches and `erfcx`. The
   ADR-0015-relevant operation. **Inherits.**
5. **`Math.log`** in the inverse-erf tail branches (`-log1p(-|x|)`).
   **Inherits.**
6. **`Math.sqrt`** in the inverse-erf tail (`sqrt(-log1p(...))`).
   **Inherits.**
7. **`maskLowMantissa`** (DataView setFloat64/getFloat64). The
   little-endian flag forces canonical byte order; the IEEE-754
   double is stored as a fixed bit pattern regardless of host
   endianness. **Bit-identical across all platforms.**
8. **Branch comparisons** (`x < 0.84375`, `ix < 0x3feb0000`). Pure
   float64 comparisons. Deterministic everywhere.
9. **`Math.PI`, `Math.E`** — V8 inherits these from libm; same V8
   build produces the same constant. **Inherits.**
10. **No transcendentals beyond `Math.exp`/`Math.log`/`Math.sqrt`** —
    no `Math.sin`/`Math.cos` (used only in `Faddeeva.w` for the
    complex case via `cos(mIm_z2), sin(mIm_z2)`). For real-axis erf,
    no trig.

**No `process.arch` reads. No `Math.fround` (which would coerce to
single and re-round). No timing-based logic. No platform-conditional
branches.** The algorithm is pure float64 arithmetic with constants
parsed by the JS engine; it carries exactly the ADR-0015 fingerprint
of the underlying `Math.*` library, no more.

### 8.4 Cross-platform fingerprint expectations

- **linux-x86_64 + Bun 1.2+** → bit-identical (measured for linalg-solve;
  same `Math.exp`/`Math.log` library).
- **darwin-aarch64 + Bun 1.2+** → may differ on the last bit of
  `Math.exp(−x²)` results in branches 3-4; this is the cross-arch
  question bead `auz` exists to measure. **Acceptable** under
  ADR-0015 — the platform field on provenance distinguishes.
- **Cross-runtime** (e.g. running through Deno or Node) — different
  Math libraries; provenance fingerprint differs; cache miss is
  honest.

### 8.5 The complex-`w(z)` algorithm: same fingerprint

The Alg. 916 series uses `Math.exp(-a²n²)` per term. Either:

- **Precomputed table** at relerr=DBL_EPSILON (Faddeeva.cc does
  this — line 840): a `static const double expa2n2[]` of 100 values.
  These are literal constants parsed at load, bit-identical across
  platforms. ✅
- **On-the-fly** for non-default relerr: one `Math.exp` per term.
  ADR-0015 fingerprint applies. ✅

The CF loop in Poppe-Wijers is pure float64 +/-/*//; no
transcendentals. ✅

`Math.cos`/`Math.sin` appear in `Faddeeva::erf(cmplx)` for the
`exp(-Re_z²)·(cos(Im_z²)+i·sin(Im_z²))` exterior. These are V8
transcendentals; same ADR-0015 fingerprint.

### 8.6 Provenance hooks

Per ADR-0015 §4: when `numerical: true` and `containsFloat64(output)`
is true, `executeToolDef` records the platform fingerprint. Every
output of `erf`/`erfc`/`erfcx`/`erfinv`/`erfcinv` is a float64 (single
scalar), so every record gets the platform field. No special
per-output logic needed.

---

## 9. Coda — what we are not committing to in R3

R3 is **research only** (per the brief: "Research only. Do not modify
source."). The artefacts this document produces, in declining order
of certainty:

1. **The dispatch and coefficient choices** — committed. The SunPro
   algorithm is the world-standard; adopting it verbatim is the
   responsible move.
2. **The package layout sketch** (`@workbench/erf-float64`) — a
   recommendation, to be confirmed in A0 (ADR-0040) drafting.
3. **The integration mechanics** (`applySpecial` extension) — a
   sketch, not a port. The port is its own bead (likely under A0).
4. **The complex-w algorithm choice** — Faddeeva-Johnson MIT verbatim
   is the consensus pick; the 2529-LOC porting work is itself a
   future bead.
5. **The inverse-erf Blair tables** — committed. SpecialFunctions.jl
   inherits these from Blair 1976; we adopt the same emitted values.

What R3 explicitly does **not** decide:

- **Whether complex erf is in scope for the v0.1 substrate** —
  `evalNumericExpr` currently handles only real `f: (x: number) →
  number` integrands. Complex erf is needed for the Berry-smoothing
  path (`meijer-core`'s Stokes band) but not for `tools/integrate-1d`.
  Defer.
- **Complex `erfinv`** — out of scope. No public-domain canonical form.
- **Higher-derivative `erf'(x) = (2/√π)·exp(−x²)`** — trivial to add
  as a sibling head if needed.
- **Symbolic identities** that would let `erf(α·x + β)` reduce to a
  call on the canonical form — that's R1 (symbolic) territory, not R3.

---

## 10. References

### Primary sources (algorithm and coefficient origin)

1. **Sun Microsystems / SunPro libm** (1993). `s_erf.c`. Permissive
   "Copyright 1993 by Sun Microsystems, Inc." notice. Preserved in
   FreeBSD `lib/msun/src/s_erf.c`, musl `src/math/erf.c`, glibc
   `sysdeps/ieee754/dbl-64/s_erf.c`, NetBSD `lib/libm/src/s_erf.c`,
   Apple Libm. **The reference float64 algorithm.**
2. **Cody, W. J.** (1969). "Rational Chebyshev approximations for the
   error function." *Math. Comp.* 23, 631–637. Original Chebyshev
   tables; the basis of *almost* every later float64 erf.
3. **Hastings, C., Jr.** (1955). *Approximations for Digital
   Computers*. Princeton Univ. Press. The 1950s pre-Cody fits
   (less accurate, historical interest only).
4. **Schonfelder, J. L.** (1978). "Chebyshev expansions for the
   error and related functions." *Math. Comp.* 32, 1232–1240.
   Higher-accuracy Chebyshev fits; cited by Boost.
5. **Blair, J. M., Edwards, C. A., Johnson, J. H.** (1976). "Rational
   Chebyshev approximations for the inverse of the error function."
   *Math. Comp.* 30, 827–830. The Float64 `erfinv` Tables 17/37/57
   and `erfcinv` Tables 57/80 — used verbatim by SpecialFunctions.jl
   (and by inheritance us).
6. **Strecok, A. J.** (1968). "On the calculation of the inverse of
   the error function." *Math. Comp.* 22, 144–158. Pre-Blair
   approach; superseded for accuracy.
7. **Poppe, G. P. M., Wijers, C. M. J.** (1990). "More efficient
   computation of the complex error function." *ACM TOMS* 16(1),
   38–46. **The continued-fraction algorithm for `w(z)` at large |z|.**
   Term-count formula `nu = 3 + 1442/(26ρ + 77)`.
8. **Gautschi, W.** (1970). "Efficient computation of the complex
   error function." *SIAM J. Numer. Anal.* 7(1), 187–198.
   The original CF (Poppe-Wijers improved on it).
9. **Zaghloul, M. R., Ali, A. N.** (2011). "Algorithm 916: Computing
   the Faddeyeva and Voigt functions." *ACM TOMS* 38(2), Art. 15.
   **The series algorithm for moderate |z|, used by Faddeeva-Johnson.**
10. **Johnson, S. G.** (2012). Faddeeva package, MIT.
    `https://ab-initio.mit.edu/Faddeeva`. Mirror at
    `JuliaMath/openspecfun:Faddeeva/Faddeeva.cc`. **The canonical
    public-domain-licence float64 complex erf.**
11. **DLMF §7** — Olver, F. W. J. et al., *NIST Digital Library of
    Mathematical Functions*. §7.6 (Taylor at 0), §7.9 (continued
    fractions, 7.9.1–7.9.3), §7.12 (asymptotic expansion 7.12.1),
    §7.17 (inverse erf). The notation reference.

### Source-code mirrors inspected

- musl `src/math/erf.c` — https://git.musl-libc.org/cgit/musl/plain/src/math/erf.c
- glibc — `sourceware.org/git` mirror; byte-identical to musl modulo
  whitespace.
- Cephes — `https://netlib.org/cephes/cprob.tgz` extracted to
  `cprob/ndtr.c` (contains `erf`, `erfc`, `ndtr`).
- SpecialFunctions.jl — https://github.com/JuliaMath/SpecialFunctions.jl/blob/master/src/erf.jl
  — the inverse-erf Blair tables, verbatim Float64.
- Faddeeva.cc — https://github.com/JuliaMath/openspecfun/blob/main/Faddeeva/Faddeeva.cc
  (2529 LOC).
- Boost.Math erf — https://github.com/boostorg/math/blob/develop/include/boost/math/special_functions/detail/erf_inv.hpp
  — inspected for cross-reference; not the algorithm chosen, but
  validates that Boost's accuracy claims (≤ 2 ε) match the SunPro
  algorithm's claims (≤ 1 ULP).

### Project-internal pointers

- `packages/quadrature/src/eval-expr.ts` — the host of the
  evaluator extension.
- `docs/adr/0014-first-numerical-tier.md` — substrate philosophy.
- `docs/adr/0015-determinism-tier.md` — `numerical: true` contract.
- `docs/adr/0023-cas-core-special-function-vocabulary.md` — the
  cousin ADR for special-function vocab in the symbolic layer.
- Beads `43hw` (epic) → `1i5z` (R3) → `9jpm` (R2 arb-prec) → `kvfu`
  (R1 symbolic) → `lnux` (R4 Meijer bridge) → `ss5o` (A0 ADR-0040).
