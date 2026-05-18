# R3 — Float64 Gamma-family algorithms: state-of-the-art survey for `@workbench/quadrature`

> **Bead:** `scientist-workbench-ldsf` (R3 of epic `scientist-workbench-xqc7`,
> world-class Gamma family reference implementation; per-head substrate
> prototype 3 after Erf and Bessel).
> **Sibling artefacts:** R1 (symbolic identities), R2 (arb-prec algorithms),
> R4 (Meijer-G bridge), R5 (oracle landscape) — same
> `docs/refs/gamma-research/` directory. This document is the Phase-0 R3
> gate input to A0 (ADR-0042 draft) and the I5 substrate subagent.
> **Audience:** the I5 subagent (and any future special-function implementer)
> who will translate the recommended C/Fortran sources verbatim into
> TypeScript under `packages/quadrature/src/special-funcs/gamma-float64.ts`.
> **Substrate landing site (per ADR-0040 Decision 4):**
> `packages/quadrature/src/special-funcs/gamma-float64.ts` (new), with
> extensions to `packages/quadrature/src/eval-numeric-expr.ts` adding the
> Gamma family heads to `SPECIAL_HEADS` and `SPECIAL_DISPATCH`.
> **Tier:** ADR-0015 `numerical: true`. Bit-identical given platform
> fingerprint `{arch, os, runtime}`. Pure JavaScript on Bun/V8; no FFI;
> no `process.arch` branches; no `Math.fround`; algorithm and constants
> are platform-independent so the only float-runtime dependence is the
> underlying V8 `Math.exp` / `Math.log` / `Math.sin` / `Math.cos` /
> `Math.sqrt` behaviour that the rest of the tier already inherits.
> **Reference cycle:** R1 (symbolic) → R2 (arb-prec) → **R3 (this
> document)** → R4 (Meijer-G bridge) → R5 (oracle landscape) → A0
> (ADR-0042 + prototype).

---

## §0.0 — VERBATIM PORT DISCIPLINE (read FIRST; it is non-negotiable)

**Port C / Fortran source line-by-line. Do NOT re-derive from the paper.**

This rule is load-bearing. It is pinned first in this document because the
Gamma family is *at least as algorithmically dense as Bessel*, and Bessel is
the hardest family the workbench has yet implemented.

### Why re-derivation fails

Two concrete failure modes from this epic's predecessor epics:

**Erf epic, friction #11 (worklog 142).** I5's first Algorithm 916 draft had
a sign error in the re-derivation; the `Faddeeva.cc` verbatim port worked
first try. The sign error was not visible from the paper alone — it only
appeared after cross-oracle grading against Wolfram at 50 digits. The time
cost was approximately 4 hours of debugging.

**Bessel epic, R3 §0.0 (worklog 166).** The Amos TOMS 644 Fortran for complex
Bessel has ~30 mutually cross-calling subroutines. Any re-derivation from
Watson (1944) or DLMF §10 must replicate 50+ years of accumulated bug-fixes
(the Hankel CF rescaling fix, the Debye-coefficient sign correction in
`zunhj.f`, the ν=0 integer-order short-circuit in `zbesi.f`). Missing any of
these produces errors that look like precision noise but are actually 1-3
order-of-magnitude errors at specific input combinations.

**For the Gamma family the analogous risks are:**

1. **lgamma sign tracking.** The sign of Γ(x) for negative non-integer x
   alternates with the interval. Cephes's `lgam()` and FreeBSD's
   `lgamma_r.c` both track the sign separately; re-deriving the sign from
   `sin(πx)` is correct in theory but introduces an extra conditional on
   `floor(x)` parity that is easy to get wrong. Port the C source; don't
   re-derive.

2. **Stirling split for overflow prevention.** The `exp(-x*x - 0.5625 +
   R/S)` split in Erf (worklog 142, §"Note1") has a direct analogue in
   lgamma: the asymptotic `x·log(x) - x - 0.5·log(2π/x)` overflows for
   `x > ~1.76e308`. Cephes / FreeBSD split `x·log(x)` into a sum of two
   products chosen so neither intermediate overflows. The split constants are
   algorithm-specific and non-obvious.

3. **igam/igamc mutual dispatch.** The Cephes design (`igam.c:145`
   `if (x > 1.0 && x > a) return 1.0 - igamc(a,x)`) creates a mutual
   recursion with a single-level depth bound. A re-derivation that forgets
   the bound produces an infinite loop for specific input pairs. The verbatim
   port is provably bounded; a re-derivation is not without careful analysis.

4. **Continued-fraction rescaling.** Cephes's `igamc.c` uses `big = 4.5e15`
   and `biginv = 2.22e-16` (the same constants appear in `incbet.c`) as
   rescaling factors to prevent floating-point overflow during CF iteration.
   These constants are *empirically calibrated* against the CF convergence
   rate; re-deriving them from first principles requires a convergence
   analysis that Moshier (Cephes, 2000) already performed. Port verbatim.

5. **Inverse igamma Halley seed.** The Boost `igamma_inverse.hpp` rational
   seed for DiDonato-Morris (Eq. 32) has coefficients calibrated at
   53-bit precision. Any re-derivation from the SIAM paper must
   round the coefficients to the same double-precision values as the
   source, or the seed will have a different ULP distribution and the
   refinement may take an extra Halley step.

**THE RULE:** For every function in this artefact, the I5 implementer opens
the cited source file, and translates it to TypeScript line-by-line. The
paper / DLMF citation is for *understanding* why the algorithm is shaped the
way it is, not for *deriving* the constants or the dispatch order.

---

## §1 — Per-head port recommendation table

Each row covers one (head, regime) combination. The "source" column gives the
exact file to port verbatim. The "accuracy" column gives the published
worst-case bound.

### §1.1 Gamma (tgamma)

| Head + regime | Source | Accuracy | Notes |
|---|---|---|---|
| `tgamma(x)`, |x| ≤ 33 | Cephes `gamma.c` γ, P/Q rational in [2,3] via recurrence | ≤ 2 ULP | Cephes 2000; Moshier's P[7]/Q[8] rational |
| `tgamma(x)`, 33 < x ≤ 171.62 | Cephes `gamma.c` `stirf()` Stirling | ≤ 1 ULP Stirling | STIR[5] Chebyshev-like coefficients |
| `tgamma(x)`, x < 0 non-integer | Cephes `gamma.c` reflection formula | ≤ 3 ULP | via `sin(πx)` then recurrence |
| `tgamma(x)`, x integer 1..22 | Precomputed factorial table | exact | musl `tgamma.c` `fact[]` array; integers up to 22 are exactly representable |
| `tgamma(x)`, x > 171.62 | ±∞ with sign | exact IEEE | overflow |
| `tgamma(x)`, x = negative integer | ±∞ | exact | pole |
| `tgamma(x)`, x ≤ -184 | ±0 or subnormal | IEEE underflow | via reflection; underflows before Stirling |
| `tgamma_complex(re, im)` | SciPy `_loggamma.pxd` Stirling + reflection + `exp` | ≤ ~15 dp | Port the lgamma-complex + exp pipeline |

### §1.2 LogGamma

| Head + regime | Source | Accuracy | Notes |
|---|---|---|---|
| `lgamma_r(x)`, x > 0 large (x ≥ 8) | FreeBSD `e_lgamma_r.c` w[] asymptotic (Stirling) | ≤ 2 ULP | 7-term Stirling sum, w[0..6] |
| `lgamma_r(x)`, 2 ≤ x < 8 | FreeBSD `e_lgamma_r.c` multiplicative chain + s/r rational | ≤ 2 ULP | arg-shifts via log products |
| `lgamma_r(x)`, 1 ≤ x < 2 | FreeBSD `e_lgamma_r.c` t[]/u[]/v[] polynomial in [tc, 1.5] + [1.5, 2] | ≤ 2 ULP | tc = 1.4616321... (lgamma minimum) |
| `lgamma_r(x)`, 0 < x < 1 | FreeBSD `e_lgamma_r.c` a[] polynomial + recurrence | ≤ 2 ULP | a[0..11] coefficients |
| `lgamma_r(x)`, x < 0 | FreeBSD `e_lgamma_r.c` reflection via `sin_pi()` | ≤ 3 ULP | sign tracked separately |
| `lgamma_r(x)`, |x| < 2^-70 | return -log(|x|) | exact | tiny-x underflow guard |
| `lgamma_complex(re, im)` | SciPy `_loggamma.pxd` / Julia `loggamma` (Stirling + reflection) | ≤ ~15 dp | See §4.1 |

### §1.3 Digamma

| Head + regime | Source | Accuracy | Notes |
|---|---|---|---|
| `digamma(x)`, x ≥ threshold (≈10) | Boost `digamma.hpp` 53-bit asymptotic, 8-term Bernoulli | ≤ 2 ULP | Boost chose threshold ≈10 for 53-bit |
| `digamma(x)`, 1 ≤ x < 10 | Boost `digamma.hpp` 53-bit rational in [1,2] + recurrence | ≤ 2 ULP | P[6]/Q[7] rational; shift n times via ψ(x+1) = ψ(x) + 1/x |
| `digamma(x)`, x near the root ≈1.4616 | Boost `digamma.hpp` `(x-root)·(Y + R(x-1))` form | ≤ 1 ULP | Y = 0.99558... is float32 approximation to ψ(root) |
| `digamma(x)`, 0 < x < 1 | Boost `digamma.hpp` shift to [1,2] via ψ(x) = ψ(x+1) − 1/x | ≤ 2 ULP | single shift |
| `digamma(x)`, x < 0 non-integer | Boost `digamma.hpp` reflection ψ(1-x) = π/tan(πx) + ψ(x) | ≤ 4 ULP | cot formula |
| `digamma(x)`, x = negative integer | ±∞ | exact | pole |
| `cdigamma(re, im)` | Julia `special.ts` pattern: shift to large Im, Stirling | ≤ ~14 dp | See §4.2 |

### §1.4 Trigamma

| Head + regime | Source | Accuracy | Notes |
|---|---|---|---|
| `trigamma(x)`, x ≥ 10 | Boost `polygamma.hpp` → `polygamma_atinfinityplus` (m=1) Bernoulli | ≤ 2 ULP | Stirling-type sum for ψ^(1) |
| `trigamma(x)`, 0 < x < 10 | Recurrence ψ^(1)(x) = ψ^(1)(x+1) + 1/x² + shift to asymptotic | ≤ 2 ULP | shift n steps until x+n ≥ 10 |
| `trigamma(x)`, x < 0 | Reflection ψ^(1)(1-x) = ψ^(1)(x) + (π/sin(πx))² | ≤ 4 ULP | |
| `trigamma(x)`, x = neg int | ±∞ | exact | |

### §1.5 Polygamma (m ≥ 2)

| Head + regime | Source | Accuracy | Notes |
|---|---|---|---|
| `polygamma(m, x)`, x ≥ 10 | Boost `detail/polygamma.hpp` `polygamma_atinfinityplus` | ≤ 2 ULP | Bernoulli-based; uses `zeta(n, x)` via Hurwitz route |
| `polygamma(m, x)`, 0 < x < 10 | Recurrence via ψ^(m)(x) = ψ^(m)(x+1) + (−1)^m · m! / x^(m+1) | ≤ 4 ULP | shift until x+n ≥ 10 |
| `polygamma(m, x)`, x < 0 | Reflection via `poly_cot_pi` (tabulated cot derivatives n=1..20) | ≤ 4 ULP | Boost detail/polygamma.hpp lines 248-417 |
| `polygamma(m, x)` near zero | Boost `polygamma_nearzero` alternating zeta series | ≤ 3 ULP | |

### §1.6 Pochhammer (Rising Factorial)

| Head + regime | Source | Accuracy | Notes |
|---|---|---|---|
| `pochhammer(a, n)`, n integer ≥ 0 | Direct product a·(a+1)·…·(a+n-1) | exact for small n; ≤ 2 ULP otherwise | overflow if result > MAX_FLOAT64 |
| `pochhammer(a, n)`, n large integer | lgamma(a+n) − lgamma(a) + sign tracking | ≤ 2 ULP + lgamma error | via lΓ identity |
| `pochhammer(a, n)`, n real (general) | exp(lgamma(a+n) − lgamma(a)) with sign | ≤ 4 ULP | loses sign information; document limitation |

### §1.7 Incomplete Gamma (unregularised and regularised)

| Head + regime | Source | Accuracy | Notes |
|---|---|---|---|
| `gamma_p(a, x)`, x < a+1 | Cephes `igam.c` `igam()` power series | ≤ 3 ULP | terminates when c/ans < MACHEP |
| `gamma_q(a, x)`, x ≥ a+1 | Cephes `igam.c` `igamc()` continued fraction | ≤ 3 ULP | Lentz-style CF with big/biginv rescaling |
| `gamma_q(a, x)`, x < 1 or x < a | Cephes `igam.c` `igamc()` delegates to `igam()` | same as igam | `return 1.0 - igam(a,x)` at line 94 |
| `gamma_inc_lower(a, x)` | `gamma_p(a,x) * tgamma(a)` | ≤ 4 ULP combined | unregularised = P·Γ(a) |
| `gamma_inc_upper(a, x)` | `gamma_q(a,x) * tgamma(a)` | ≤ 4 ULP combined | unregularised = Q·Γ(a) |

### §1.8 Inverse Incomplete Gamma

| Head + regime | Source | Accuracy | Notes |
|---|---|---|---|
| `gamma_p_inverse(a, p)`, general | Cephes `igami.c`: cubic seed + Newton + bisection fallback | ≤ 1e-14 relative | 10 Newton iters; up to 400 bisection iters |
| `gamma_p_inverse(a, p)` high precision | Boost `igamma_inverse.hpp`: DiDonato-Morris rational seed + Halley | ≤ 1 ULP | **preferred**; Halley converges in ~2 steps after rational seed |
| `gamma_q_inverse(a, q)` | Same as `gamma_p_inverse(a, 1-q)` | same | trivial wrapping |

### §1.9 Beta and LogBeta

| Head + regime | Source | Accuracy | Notes |
|---|---|---|---|
| `beta(a, b)` | `exp(lgamma(a) + lgamma(b) - lgamma(a+b))` | ≤ 4 ULP | route through lgamma; Cephes does the same |
| `lbeta(a, b)` | `lgamma(a) + lgamma(b) - lgamma(a+b)` | ≤ 2 ULP | exact lgamma compositions |
| `lbeta(a, b)`, large a or b | Lanczos ratio form (Boost `lbeta`) | ≤ 2 ULP | avoids overflow in `lgamma(a+b)` when a,b large |

### §1.10 Incomplete Beta

| Head + regime | Source | Accuracy | Notes |
|---|---|---|---|
| `betainc(z, a, b)`, `b*z ≤ 1 && z ≤ 0.95` | Cephes `incbet.c` `pseries()` power series | ≤ 3 ULP | terminates on MACHEP threshold |
| `betainc(z, a, b)`, `z > a/(a+b)` | Symmetry: `1 - betainc(1-z, b, a)` | ≤ 3 ULP | reduces to other path |
| `betainc(z, a, b)`, general | Cephes `incbet.c` `incbcf()` or `incbd()` CF | ≤ 3 ULP | chosen by `y = x(a+b-2) - (a-1)` threshold |
| `betainc(z, a, b)` inverse | `betainc_inv(p, a, b)`: normal-seed Newton | ≤ 1e-13 | Julia/SciPy; Newton on `betainc` forward |

### §1.11 Barnes G and Hyperfactorial

| Head + regime | Source | Accuracy | Notes |
|---|---|---|---|
| `barnes_g(x)`, x positive integer ≤ ~30 | Precomputed table or direct product formula | exact | BarnesG(n) = (n−2)!·(n−3)!·…·1! |
| `barnes_g(x)`, x > 2 real | Asymptotic: lgamma + Stirling correction | ≤ 4 ULP | Adamchik 2003 DLMF 5.17.5 |
| `barnes_g(x)`, x ≤ 0 non-integer | Reflection formula (see §3.5) | ≤ 5 ULP | |
| `hyperfactorial(n)`, n integer | Direct product 1^1 · 2^2 · … · n^n | exact for n ≤ ~20 | overflow for n > 22 |
| `hyperfactorial(x)`, x real | Asymptotic + lgamma route | ≤ 5 ULP | K(x) = A·exp(B(x)) form |

### §1.12 Scaled variants

| Head | Source / approach | Accuracy | Notes |
|---|---|---|---|
| `tgamma_ratio(a, b)` = Γ(a)/Γ(b) | Boost `tgamma_ratio` (Lanczos cancellation in numerator/denominator) | ≤ 2 ULP | avoids overflow for large a,b |
| `tgamma_delta_ratio(a, δ)` = Γ(a)/Γ(a+δ) | Boost: when δ is small, Pochhammer product; otherwise Lanczos | ≤ 2 ULP | Pochhammer product for integer δ |
| `gamma_p_derivative(a, x)` = exp(−x)·x^(a−1)/Γ(a) | DLMF 8.8.12: compute via log then exp | ≤ 2 ULP | direct computation; avoids exp-log-exp cancellation |

---

## §2 — Per-head algorithm descriptions with port skeletons

### §2.1 `tgamma(x)` — Γ(x)

**Primary source:** Cephes `gamma.c` (Moshier 2000), GPL-compatible BSD license.
**Secondary check:** musl `tgamma.c` (Lanczos g≈6.0247 approximation — structurally different but same accuracy class).

The Cephes algorithm reduces to the interval [2, 3] via the recurrence
Γ(x) = x·Γ(x) applied left-ward from the input, then evaluates a
7-term / 8-term rational approximation P/Q. For x > 33 it uses Stirling's
formula directly via `stirf()`. For x < 0 non-integer it uses the reflection
`Γ(x)·Γ(−x) = −π/(x·sin(πx))`.

**Coefficient tables (emit-ready as TS const arrays):**

```ts
// Cephes gamma.c lines 261-277 — rational P/Q on [2,3]
// P: numerator (7 terms, degree 6)
const GAMMA_P = [
  1.60119522476751861407e-4,
  1.19135147006586384913e-3,
  1.04213797561761569935e-2,
  4.76367800457137231464e-2,
  2.07448227648435975150e-1,
  4.94214826801497100753e-1,
  9.99999999999999996796e-1,
];
// Q: denominator (8 terms, degree 7)
const GAMMA_Q = [
  -2.31581873324120129819e-5,
   5.39605580493303397842e-4,
  -4.45641913851797240494e-3,
   1.18139785222060435552e-2,
   3.58236398605498653373e-2,
  -2.34591795718243348568e-1,
   7.14304917030273074085e-2,
   1.00000000000000000320e0,
];

// Stirling's series coefficients (Cephes gamma.c lines 325-329)
// Used by stirf() for x > 33
const GAMMA_STIR = [
  7.87311395793093628397e-4,
 -2.29549961613378126380e-4,
 -2.68132617805781232825e-3,
  3.47222221605458667310e-3,
  8.33333333333482257126e-2,
];
const GAMMA_MAXSTIR = 143.01608; // line 356: Stirling safe range upper limit
const GAMMA_SQTPI   = 2.50662827463100050242e0; // √(2π), line 358
const GAMMA_MAXGAM  = 171.624376956302725;       // overflow threshold, line 280
const GAMMA_LOGPI   = 1.14472988584940017414;    // log(π), line 281

// Factorial lookup table for integer arguments n=1..22 (exact float64)
// musl tgamma.c lines 55-59
const GAMMA_FACT = [
  1.0, 1.0, 2.0, 6.0, 24.0, 120.0, 720.0, 5040.0, 40320.0, 362880.0,
  3628800.0, 39916800.0, 479001600.0, 6227020800.0, 87178291200.0,
  1307674368000.0, 20922789888000.0, 355687428096000.0, 6402373705728000.0,
  121645100408832000.0, 2432902008176640000.0, 51090942171709440000.0,
  1124000727777607700000.0,
];
```

**Dispatch skeleton (verbatim port target):**

```ts
function tgammaFloat64(x: number): number {
  // NaN / ±∞
  if (!isFinite(x) || isNaN(x)) {
    if (x === Infinity) return Infinity;
    if (x === -Infinity) return NaN; // −∞ is a pole cascade
    return NaN;
  }

  // Negative x
  if (x < 0) {
    if (x < -GAMMA_MAXGAM) return 0.0; // denormal underflow via reflection
    if (x === Math.trunc(x)) return (x % 2 === 0) ? Infinity : -Infinity; // pole
    // Reflection: Γ(x)·Γ(-x) = -π/(x·sin(πx))
    // ... cephes gamma.c lines 422-450 verbatim ...
  }

  // +0 pole
  if (x === 0) return (1/x); // +∞ or -∞ depending on sign of zero

  // Large positive: Stirling (cephes stirf, lines 356-392)
  if (x > GAMMA_MAXSTIR) {
    return stirfFloat64(x); // separate helper
  }

  // Moderate positive: reduce to [2,3], apply P/Q rational
  // ... cephes gamma.c lines 453-500 verbatim ...
}

function stirfFloat64(x: number): number {
  // Cephes gamma.c stirf(), lines 316-395: Stirling polynomial + sqrt(2π/x)·x^x·exp(-x)
  // Uses GAMMA_STIR array for Horner evaluation
  // ... verbatim port ...
}
```

**Edge cases (detailed):**

| Input | Output | Source / DLMF |
|---|---|---|
| `x = NaN` | `NaN` | IEEE 754 propagation |
| `x = +∞` | `+∞` | Γ diverges |
| `x = -∞` | `NaN` | oscillating poles, not a limit |
| `x = ±0` | `±∞` | pole; sign matches IEEE convention (1/x) |
| `x = -n` (integer n ≥ 1) | `NaN` or `±∞` | Cephes: returns ±∞ with alternating sign |
| `x = 0.5` | `√π = 1.7724538509…` | DLMF 5.4.6 |
| `x = 1` | `1.0` | Γ(1) = 1 |
| `x = 2` | `1.0` | Γ(2) = 1 |
| `x = 171.624` | near overflow | `~MAX_FLOAT64` |
| `x = 171.625` | `+∞` | IEEE overflow |
| `x > 171.624376956302725` | `+∞` | Cephes MAXGAM |
| `x ∈ (-1, 0)` | large magnitude ± | reflection: sign from `sin(πx)` |
| `x < -184` | ±0 | underflow through reflection |
| subnormal `x > 0` | `≈ 1/(x · γ_EM)` | harmless; standard path handles |

### §2.2 `lgamma_r(x)` — log|Γ(x)| + sign

**Primary source:** FreeBSD `lib/msun/src/e_lgamma_r.c` (SunPro 1993 lineage,
BSD permissive). This is the same provenance as the Erf substrate's `s_erf.c`
and the Bessel substrate's `j0.c`. Byte-identical across glibc, musl, FreeBSD
NetBSD, OpenBSD, Apple Libm.

The FreeBSD implementation is distinctly more complex than Cephes's `lgam.c`
because it uses a minimax polynomial at the minimum point (tc ≈ 1.4616)
rather than a simple piecewise rational, giving tighter error bounds.

**Coefficient tables (emit-ready):**

```ts
// FreeBSD e_lgamma_r.c — all arrays verbatim

// a[0..11]: polynomial for 0 < x < 1 (or 1 < x < 2 with reduction)
// (lines 49-60 of FreeBSD e_lgamma_r.c)
const LGAMMA_A = [
  7.72156649015328655494e-2,  // a0
  3.22467033424113591611e-1,  // a1
  6.73523010531292681824e-2,  // a2
  2.05808084325167332806e-2,  // a3
  7.38555086081402883957e-3,  // a4
  2.89051383673415629091e-3,  // a5
  1.19270763183362067845e-3,  // a6
  5.10069792153511336608e-4,  // a7
  2.20862790713908385557e-4,  // a8
  1.08011567247583939954e-4,  // a9
  2.52144565451257326939e-5,  // a10
  4.48640949618915160150e-5,  // a11
];

// t[0..14]: Taylor polynomial at minimum point tc (lines 83-98)
const LGAMMA_T = [
  4.83836122723810047042e-1,  // t0
 -1.47587722994593911752e-1,  // t1
  6.46249402391333854778e-2,  // t2
 -3.27885410759859649565e-2,  // t3
  1.79706750811820387126e-2,  // t4
 -1.03142241298341437450e-2,  // t5
  6.10053870246291332635e-3,  // t6
 -3.68452016781138256760e-3,  // t7
  2.25964780900612472250e-3,  // t8
 -1.40346469989232843813e-3,  // t9
  8.81081882437654011382e-4,  // t10
 -5.38595305356740546715e-4,  // t11
  3.15632070903625950361e-4,  // t12
 -3.12754168375120860518e-4,  // t13
  3.35529192635519073543e-4,  // t14
];

// u[0..5] / v[1..5]: rational for 1.5 ≤ x ≤ 2.5
// (lines 99-110)
const LGAMMA_U = [
 -7.72156649015328655494e-2,  // u0
  6.32827064025093366517e-1,  // u1
  1.45492250137234768737e0,   // u2
  9.77717527963372745603e-1,  // u3
  2.28963728064692451092e-1,  // u4
  1.33810918536787660377e-2,  // u5
];
const LGAMMA_V = [
  1.0,                         // v0 (implicit)
  2.45597793713041134822e0,   // v1
  2.12848976379893395361e0,   // v2
  7.69285150456672783825e-1,  // v3
  1.04222645593369134254e-1,  // v4
  3.21709242282423911810e-3,  // v5
];

// s[0..6] / r[1..6]: rational for 2 ≤ x < 8 (lines 111-123)
const LGAMMA_S = [
  2.14982415960608852501e-11, // s0
 -5.32346798374586074573e-9,  // s1
  7.32669920378440267097e-7,  // s2
 -3.17124700055599855098e-5,  // s3
  5.65347348095698700803e-4,  // s4
 -4.68847209993453765655e-3,  // s5
  3.38106820719036787948e-2,  // s6
  1.14348698987965167684e-1,  // — note: r[0] is here implicitly
];
const LGAMMA_R = [
  1.0,                          // r0 (denominator leading 1)
  1.52729289803060643630e0,    // r1
  9.66624321239669065994e-1,   // r2
  3.36007770186990528822e-1,   // r3
  6.93810792706503616038e-2,   // r4
  8.55919085699042861897e-3,   // r5
  5.24720730990754079074e-4,   // r6
];

// w[0..6]: asymptotic expansion x ≥ 8 (Stirling; lines 124-130)
const LGAMMA_W = [
  4.18938533204672741780e-1,  // w0 = log(√(2π))
  8.33333333333329678849e-2,  // w1 = 1/12
 -2.77777777728775536470e-3,  // w2 = -1/360
  7.93650558643019558500e-4,  // w3 = 1/1260
 -5.95187557450339963135e-4,  // w4 = -1/1680
  8.36339918996282139126e-4,  // w5 = 1/1188
 -1.63092934096895419722e-3,  // w6 = -691/360360 (approx)
];

// Key scalar constants
const LGAMMA_TC = 1.46163214496836224576e0;   // minimum of lgamma on (0, ∞)
const LGAMMA_TF = -1.21486290535849611461e-1;  // lgamma(tc) high word
const LGAMMA_TT = -3.63867699703950536541e-18; // lgamma(tc) low word (double-double)
const LGAMMA_PI = 3.14159265358979311600e0;
const LGAMMA_LS2PI = 9.18938533204672741780e-1; // log(√(2π))
```

**Dispatch structure (verbatim port shape):**

```ts
function lgammaRFloat64(x: number): [number, number] {
  // Returns [log|Γ(x)|, signum] where signum is +1 or -1

  // ±∞, NaN (lines 210-211)
  if (!isFinite(x) || isNaN(x)) return [x * x, 1]; // +∞ for ±∞; NaN for NaN

  // |x| < 2^-70: return -log(|x|) (lines 214-217)
  // x < 0: reduce to positive via sin_pi reflection (lines 219-230)
  // x = 1 or 2: return [0, 1] (line 232)
  // x ∈ (0, 2): polynomial/rational (lines 234-252)
  // x ∈ [2, 8): multiplicative chain (lines 254-267)
  // x ∈ [8, 2^56): Stirling via w[] asymptotic (lines 269-272)
  // x ≥ 2^56: x*(log(x)-1) approximation (lines 274-275)

  // ... verbatim port ...
}
```

**Edge cases:**

| Input | `log\|Γ\|` | sign | Notes |
|---|---|---|---|
| `x = NaN` | `NaN` | `1` | IEEE NaN propagation |
| `x = ±∞` | `+∞` | `1` | lgamma(+∞) = +∞; lgamma(-∞) = +∞ (magnitude) |
| `x = ±0` | `+∞` | `+1` | pole; log|Γ(0)| = +∞ |
| `x = -n` (int n≥1) | `+∞` | alternates | log|Γ(−n)| = +∞ at every negative integer pole |
| `x = 0.5` | `log(√π) ≈ 0.5724` | `+1` | |
| `x = 1` | `0.0` | `+1` | Γ(1) = 1, log = 0 |
| `x = 2` | `0.0` | `+1` | Γ(2) = 1 |
| `x = 1.4616…` | `log|Γ(tc)| ≈ -0.1215` | `+1` | minimum; handled by tc branch |
| `x ∈ (-1, 0)` | large positive | `-1` | Γ is negative here |
| `x ∈ (-2, -1)` | large positive | `+1` | alternating sign per interval |

### §2.3 `lgamma_complex(re, im)` — log Γ(z) for z ∈ ℂ

**Primary source:** SciPy `scipy/special/_loggamma.pxd` (Amos-lineage Stirling +
reflection for negative half-plane) and Julia `SpecialFunctions.jl`
`loggamma(z::Complex{Float64})`.

**Algorithm outline (Stirling-shift + reflection):**
1. If `Re(z) < 0.5`: apply the reflection formula
   `log Γ(z) = log(π) − log sin(πz) − log Γ(1−z)`
2. Shift to `Re(z) ≥ 7` via the recurrence
   `log Γ(z) = log Γ(z+1) − log z`, accumulating log terms.
3. At `Re(z) ≥ 7`: Stirling asymptotic expansion
   `log Γ(z) ≈ (z − 1/2)·log(z) − z + log(√(2π)) + Σ B_{2n}/(2n(2n−1)·z^{2n-1})`
   where `B_2=1/6, B_4=-1/30, B_6=1/42, B_8=-1/30, ...` are Bernoulli numbers.

**Coefficient tables:**

```ts
// Stirling series Bernoulli coefficients for log Γ(z) complex
// ψ(z) ≈ log(z) - 1/(2z) - Σ B_{2k}/(2k·z^{2k})
// These are B_{2k}/(2k·(2k-1)) for k=1,2,...
const LGAMMA_COMPLEX_STIRLING = [
  8.333333333333333e-2,   // B_2/2 = 1/12
 -2.777777777777778e-3,   // -B_4/12 = -1/360
  7.936507936507937e-4,   // B_6/30 = 1/1260
 -5.952380952380952e-4,   // -B_8/56 = -1/1680 (approx)
  8.417508417508418e-4,   // B_10/90
 -1.917526917526918e-3,   // -B_12/132
  6.410256410256410e-3,   // B_14/182
 -2.955065359477124e-2,   // -B_16/240
];
const LGAMMA_COMPLEX_SHIFT_THRESHOLD = 7.0; // real part threshold for Stirling
```

**Branch cut and domain:**
- The principal branch uses the standard `log` branch cut on the negative real
  axis. For real negative inputs `lgamma_complex(-n + 0i)` matches `lgamma_r`
  with appropriate imaginary part `iπ·k` for the winding number.
- This is the *critical honesty note*: the complex log-gamma has a branch cut
  along the negative real axis at each negative integer; the imaginary part
  jumps there. The principal branch is the standard DLMF §5.4(i) choice.

### §2.4 `digamma(x)` — ψ(x)

**Primary source:** Boost `include/boost/math/special_functions/digamma.hpp`,
53-bit precision specialization (lines 384-427 for the [1,2] rational,
lines 232-251 for the asymptotic).

**Coefficient tables for 53-bit precision (emit-ready):**

```ts
// Boost digamma.hpp lines 384-427 — 53-bit rational for x ∈ [1, 2]
// Form: ψ(x) = (x - root) * (Y + R(x-1))
// where Y is a float32-precision approximation to ψ(root)
// and root is the zero of ψ in (1, 2): root ≈ 1.46163...

const DIGAMMA_ROOT1 = 1.4616321449683622;  // split into two parts for accuracy:
const DIGAMMA_ROOT1_HI = 1452/1024.0;      // high part (exact float32)
const DIGAMMA_ROOT1_LO = 0.014635264522857;// low part

// Y constant (float32 approximation to ψ(root))
const DIGAMMA_Y = 0.99558243899;           // Boost line 402

// Numerator P[0..5] for 53-bit (Boost lines 404-410)
const DIGAMMA_P53 = [
 -0.0020713321095977975,
  0.0013360929319823529,
  0.011999390975037684,
  0.072929882074438975,
  0.23893555177748498,
  0.50060606268805498,
];

// Denominator Q[0..6] for 53-bit (Boost lines 411-420)
const DIGAMMA_Q53 = [
  0.00010168226521722566,
  0.0023853567949977685,
  0.024126893831744938,
  0.13027490814614882,
  0.39790023217736698,
  0.67560200617024063,
  1.0,
];

// Asymptotic digamma coefficients (Stirling; Boost lines 232-251, 8-term, 53-bit)
// ψ(x) ≈ log(x) - 1/(2x) - 1/(12x²) + 1/(120x⁴) - 1/(252x⁶) + ...
// Coefficients are B_{2k}/(2k) for k=1,2,...
const DIGAMMA_ASYM = [
  -8.333333333333333e-2,   // -1/12
   8.333333333333333e-3,   // +1/120 (= B_4/(4) sign corrected)
  -3.968253968253968e-3,   // -1/252
   4.166666666666667e-3,   //  etc.
  -7.575757575757576e-3,
   2.109279609279609e-2,
  -8.333333333333333e-2,
   4.432598039215686e-1,
];
const DIGAMMA_ASYM_THRESHOLD = 10.0; // shift x until x >= 10, then use asymptotic
```

**Dispatch skeleton:**

```ts
function digammaFloat64(x: number): number {
  // Pole at non-positive integers
  if (x <= 0 && x === Math.trunc(x)) return -Infinity; // ψ(−n) = −∞

  // Negative non-integer: reflection ψ(1−x) = π/tan(πx) + ψ(x)
  if (x < 0) {
    return Math.PI / Math.tan(Math.PI * x) + digammaFloat64(1 - x);
  }

  // Small positive: shift to ≥ 1 via ψ(x+1) = ψ(x) + 1/x
  let result = 0.0;
  while (x < 1) { result -= 1.0 / x; x += 1.0; }

  // Large x: asymptotic expansion
  if (x >= DIGAMMA_ASYM_THRESHOLD) {
    return result + digammaAsymFloat64(x);
  }

  // Shift to [1, 2] and apply Boost P53/Q53 rational
  while (x > 2) { x -= 1.0; result += 1.0 / x; } // shift down
  // Now x ∈ [1, 2]; apply rational approximation
  // ... Boost rational form: (x - root) * (Y + evalRational(x-1, P53, Q53)) ...
}
```

### §2.5 `trigamma(x)` — ψ^(1)(x)

**Primary source:** Boost `detail/polygamma.hpp` `polygamma_atinfinityplus` with n=1.

The 53-bit asymptotic sum for ψ^(1)(x) is:
```
ψ^(1)(x) = 1/x + 1/(2x²) + 1/(6x³) − 1/(30x⁵) + 1/(42x⁷) − 1/(30x⁹) + …
```
which uses the same Bernoulli number series as the digamma asymptotic but
multiplied by the appropriate factorial.

**Coefficient tables (8-term Stirling series for ψ^(1), emit-ready):**

```ts
// ψ^(1)(x) asymptotic: 1/x + 1/(2x²) + sum_{k=1}^{N} B_{2k}/x^{2k+1}
// The B_{2k} / (factorial factor) terms — see DLMF 5.15.1
const TRIGAMMA_ASYM = [
  1.0/6.0,
 -1.0/30.0,
  1.0/42.0,
 -1.0/30.0,
  5.0/66.0,
 -691.0/2730.0,
  7.0/6.0,
 -3617.0/510.0,
];
const TRIGAMMA_ASYM_THRESHOLD = 10.0;
```

**Dispatch:**

```ts
function trigammaFloat64(x: number): number {
  // Pole at non-positive integers
  if (x <= 0 && x === Math.trunc(x)) return Infinity; // ψ^(1)(−n) = +∞ (always)

  // Reflection: ψ^(1)(1−x) = ψ^(1)(x) + (π/sin(πx))²  (DLMF 5.15.6)
  if (x < 0) {
    const sinPiX = Math.sin(Math.PI * x);
    return (Math.PI / sinPiX) ** 2 - trigammaFloat64(1 - x);
  }

  // Shift to x >= TRIGAMMA_ASYM_THRESHOLD via ψ^(1)(x) = ψ^(1)(x+1) + 1/x²
  let result = 0.0;
  while (x < TRIGAMMA_ASYM_THRESHOLD) { result += 1.0 / (x * x); x += 1.0; }
  return result + trigammaAsymFloat64(x);
}
```

### §2.6 `polygamma(m, x)` — ψ^(m)(x), m ≥ 2

**Primary source:** Boost `detail/polygamma.hpp`. For m ≥ 2, the Hurwitz zeta
route is:
```
ψ^(m)(x) = (−1)^(m+1) · m! · ζ(m+1, x)
```
where `ζ(s, a)` is the Hurwitz zeta function (DLMF 5.15.2). This is the
cleanest form for float64 implementation because Hurwitz zeta has its own
efficient asymptotic expansion.

**Asymptotic path (x large):** Boost `polygamma_atinfinityplus`, which expands
```
ψ^(m)(x) ≈ (−1)^(m+1) · [(m−1)!/x^m + m!/(2x^{m+1}) + Σ_k B_{2k} · (m+2k−2)! / ((2k−1)! x^{m+2k−1})]
```
This is the Bernoulli-number sum from DLMF 5.15.1.

**Small x path (Boost `polygamma_nearzero`):** alternating zeta series
`Σ_{k=0}^N ζ(k + m + 1)·(−x)^k / k!` with factorial scaling.

**Recurrence path (moderate x):** shift via `ψ^(m)(x) = ψ^(m)(x+1) + (−1)^m · m!/x^{m+1}`
until `x ≥ 10`, then use asymptotic.

**Reflection path (negative x):** Boost `poly_cot_pi` with tabulated
polynomial coefficients for the nth derivative of cot(πx), n=1..20
(Boost detail/polygamma.hpp lines 248-417).

**NOTE ON ZETA:** `polygamma(m, x)` for m ≥ 2 requires `zeta(m+1, x)`, the
Hurwitz zeta. This means the Gamma family substrate must include at minimum
a float64 `hurwitzZetaFloat64(s, a)` helper (or equivalently, `zetaStirling`
for integer `s`). The Boost implementation inlines this via Bernoulli-number
series. The substrate implementer MUST implement this helper; it is not
available in V8's `Math`.

**Coefficient tables for Hurwitz zeta Bernoulli coefficients:** Same
`DIGAMMA_ASYM` / `TRIGAMMA_ASYM` family; the general formula just scales by
the appropriate Pochhammer factorial. The I5 implementer should factor out a
single `bernoulliB2nOverFactorial` table covering `B_{2k}/(2k)!` up to k=12
for 53-bit accuracy.

### §2.7 `pochhammer(a, n)` — (a)_n = Γ(a+n)/Γ(a)

**Integer n, small (n ≤ ~50):** Direct product `a·(a+1)·…·(a+n−1)`. Exactly
representable for integer `a` and small `n`. O(n) multiplications.

**Integer n, large:** Use `lgamma_r(a+n) − lgamma_r(a) + sign tracking`. The
sign is `(−1)^(number of negative integers in {a, a+1, …, a+n−1})`, which
requires counting how many of the product terms are negative.

**General real n:** `exp(lgamma_r(a+n)[0] − lgamma_r(a)[0])` with sign
`lgamma_r(a+n)[1] * lgamma_r(a)[1]`. Warning: for `a` not a positive real,
the lgamma identity `Γ(a+n)/Γ(a)` has branch-cut complications; the real
Pochhammer is only well-defined for `a > 0` in the strictly real sense.

**Edge cases for Pochhammer:**

| Case | Value | Notes |
|---|---|---|
| `a = 0, n = 0` | `1` | empty product = 1 by convention |
| `a > 0, n = 0` | `1` | always |
| `a = -k, n = k+1` (k integer ≥ 0) | `0` | one factor is zero |
| `a = -k, n > k+1` | `0` | still zero (zero factor first) |
| `a = -k, n = k` | `(−k)·(−k+1)·…·(−1) = (−1)^k · k!` | last negative product |
| `n = ∞` | `+∞` | diverges |

### §2.8 Incomplete Gamma — `gamma_p(a, x)` and `gamma_q(a, x)`

**Primary source:** Cephes `cprob/igam.c` (Moshier 2000). This is the
load-bearing dispatch for the entire Gamma family — every subsequent function
(`gamma_inc_lower`, `gamma_inc_upper`, `gamma_p_derivative`) composes on it.

The dispatch criterion is the key design decision:

```ts
// igam.c line 145: series if x < a+1; CF otherwise
if (x > 1.0 && x > a) {
  return 1.0 - igamcFloat64(a, x); // CF path
}
// ... else series path
```

And symmetrically in `igamc`:
```ts
// igamc.c line 94: delegate to igam if in series regime
if (x < 1.0 || x < a) {
  return 1.0 - igamFloat64(a, x); // series path
}
// ... else CF path
```

This mutual recursion has depth exactly 1 (each arm calls only the other
function, never itself). The port MUST preserve this depth-1 structure to
avoid an infinite loop.

**Constants (emit-ready):**

```ts
// Cephes igam.c lines 82-84
const IGAM_BIG    = 4.503599627370496e15;    // 2^52; CF rescaling threshold
const IGAM_BIGINV = 2.22044604925031308085e-16; // 1/IGAM_BIG

// Machine constants (standard for all Cephes functions)
const MACHEP = 2.2204460492503131e-16;  // Math.EPSILON in JS
const MAXLOG = 7.09782712893383996843e2; // log(MAX_FLOAT64)
const MINLOG = -7.08396418532264106224e2; // log(MIN positive subnormal)
```

**Port skeleton for the series path (`igam`):**

```ts
function igamFloat64(a: number, x: number): number {
  // Returns P(a, x) = γ(a,x)/Γ(a) — regularised lower incomplete gamma

  // Input validation (igam.c line 142)
  if (x <= 0 || a <= 0) return 0.0;

  // Delegate to CF if in better convergence regime (igam.c line 145)
  if (x > 1.0 && x > a) return 1.0 - igamcFloat64(a, x);

  // Log-prefactor: ax = log(x)*a - x - lgamma(a) (igam.c line 148)
  const ax = a * Math.log(x) - x - lgammaRFloat64(a)[0];
  if (ax < -MAXLOG) return 0.0; // underflow

  // Power series (igam.c lines 154-161)
  let r = a;
  let c = 1.0;
  let ans = 1.0;
  do {
    r += 1.0;
    c *= x / r;
    ans += c;
  } while (c / ans > MACHEP);

  return Math.exp(ax) * ans / a; // NB: division by a here
}
```

**Port skeleton for the CF path (`igamc`):**

```ts
function igamcFloat64(a: number, x: number): number {
  // Returns Q(a, x) = Γ(a,x)/Γ(a) — regularised upper incomplete gamma

  if (x <= 0 || a <= 0) return 1.0;
  if (x < 1.0 || x < a) return 1.0 - igamFloat64(a, x);

  const ax = a * Math.log(x) - x - lgammaRFloat64(a)[0];
  if (ax < -MAXLOG) return 0.0;

  // Continued fraction Lentz-style (igamc.c lines 104-130)
  let y = 1.0 - a;
  let z = x + y + 1.0;
  let c = 0.0;
  let pkm2 = 1.0;
  let qkm2 = x;
  let pkm1 = x + 1.0;
  let qkm1 = z * x;
  let ans = pkm1 / qkm1;

  do {
    c += 1.0;
    y += 1.0;
    z += 2.0;
    const yc = y * c;
    const pk = pkm1 * z - pkm2 * yc;
    const qk = qkm1 * z - qkm2 * yc;
    if (qk !== 0) {
      const r = pk / qk;
      const t = Math.abs((ans - r) / r);
      ans = r;
      if (t <= MACHEP) break;
    }
    pkm2 = pkm1; qkm2 = qkm1;
    pkm1 = pk;   qkm1 = qk;
    // Rescale to prevent overflow (igamc.c lines 126-129)
    if (Math.abs(pk) > IGAM_BIG) {
      pkm2 *= IGAM_BIGINV; pkm1 *= IGAM_BIGINV;
      qkm2 *= IGAM_BIGINV; qkm1 *= IGAM_BIGINV;
    }
  } while (true); // convergence checked in loop body

  return Math.exp(ax) * ans;
}
```

**Edge cases for incomplete gamma:**

| Input | `gamma_p` | `gamma_q` | Notes |
|---|---|---|---|
| `x = 0` | `0.0` | `1.0` | integral from 0 to 0 is 0 |
| `x → +∞` | `1.0` | `0.0` | full integral |
| `a = 0.5, x = z²/2` | related to `erf` | related to `erfc` | DLMF 8.11.1: P(1/2, x) = erf(√x) |
| `a = 1` | `1 − exp(−x)` | `exp(−x)` | exact closed form |
| `x < 0` | undefined | undefined | return NaN (domain) |
| `a < 0` | undefined | undefined | return NaN (domain) |
| `a very large, x ≈ a` | near 1/2 | near 1/2 | saddle region; both algorithms slow here; see §3.3 |

### §2.9 Inverse incomplete gamma — `gamma_p_inverse(a, p)` and `gamma_q_inverse(a, q)`

**Primary source for high accuracy:** Boost `detail/igamma_inverse.hpp`.
**Secondary reference:** Cephes `igami.c` (Newton + bisection fallback).

The Boost approach is superior because it uses the DiDonato-Morris (1995)
rational initial seed, which places the Newton/Halley iterate close enough
to the root that Halley's method converges in 1–2 steps rather than the
10 Newton steps + 400 bisection steps Cephes may require.

**Boost rational seed (DiDonato-Morris Eq. 32), emit-ready:**

```ts
// Boost igamma_inverse.hpp lines 31-56 — find_inverse_s()
// Computes s from t = sqrt(-2*log(p_or_q)), using rational P/Q
const INV_IGAMMA_SEED_A = [
  3.31125922108741,
  11.6616720288968,
  4.28342155967104,
  0.213623493715853,
];
const INV_IGAMMA_SEED_B = [
  1.0,
  6.61053765625462,
  6.40691597760039,
  1.27364489782223,
  0.03611708101884203,
];
```

**Dispatch summary (Boost igamma_inverse.hpp lines 116-388):**

For small `a` (a < 1):
- `b = q · Γ(a)` (the scaled tail probability)
- Various regimes based on `b` and `a`:
  - `b > 0.6`: equation 21 (linear approximation)
  - `0.35 ≤ b < 0.6, a < 0.3`: equation 22
  - `b > 0.15 || a ≥ 0.3`: equation 23
  - `0.1 < b ≤ 0.15`: equation 24
  - `b ≤ 0.1`: equation 25 (full polynomial in c1..c5)

For large `a` (a ≥ 1):
- Use equation 31: w = a + s·√a + series corrections in powers of s

Followed by Halley refinement (2 iterations typically sufficient):
```ts
// Halley: x_{n+1} = x_n - f(x_n)/f'(x_n) * 1/(1 - f(x_n)*f''(x_n)/(2*f'(x_n)²))
// f(x) = gamma_p(a,x) - p
// f'(x) = exp(-x)*x^(a-1)/Γ(a)  (= gamma_p_derivative)
// f''(x)/f'(x) = (a-1)/x - 1
```

**Edge cases for inverse incomplete gamma:**

| Input | Output | Notes |
|---|---|---|
| `p = 0` | `0.0` | P(a, 0) = 0 |
| `p = 1` | `+∞` | P(a, ∞) = 1 |
| `p < 0 or p > 1` | `NaN` | domain error |
| `a = 0` | `NaN` | domain error |
| `a very small (a → 0)` | very small | seed may be poor; bisection fallback from Cephes |
| `a very large` | near a | Gaussian approximation from Eq. 31 |
| `q_inverse(a, 0)` | `+∞` | Q = 0 means upper tail exhausted |
| `q_inverse(a, 1)` | `0.0` | Q = 1 means no contribution from tail |

### §2.10 Beta and LogBeta

**Primary source:** `lbeta(a, b) = lgamma(a) + lgamma(b) − lgamma(a+b)`.

For large a, b this may overflow because `lgamma(a+b)` grows as
`(a+b)·log(a+b)`. Boost's `lbeta` uses the Lanczos ratio: compute
`g(a)/g(a+b)·g(b)/1` directly in the Lanczos space to cancel the
`exp(a+b+g-0.5)·log(a+b+g-0.5)` terms.

**Coefficient table — Lanczos g=6.024680040776729583740234375 (already present in musl `tgamma.c` and Boost `lanczos.hpp`):**

```ts
// Boost lanczos.hpp — double precision Lanczos (g=6.024680040776729583740234375)
// Numerator polynomial: evaluated as sum(Snum[k]/(x+k), k=0..12) + Snum[0]
const LANCZOS_G = 6.024680040776729583740234375;
const LANCZOS_SNUM = [
  23531376880.41075968857200767,
  42919803642.64909876895789905,
  35711959237.35566804944018545,
  17921034426.03720969991975575,
   6039542586.352028005064291644,
   1439720407.311721673663223072,
    248874557.8620541565114603864,
     31426415.58540019438061423163,
      2876370.628935372441225409052,
       186056.2653952234950402949897,
         8071.672002365816210638002902,
          210.8242777515793458725097339,
            2.506628274631000270164908177,
];
// Denominator: prod_{k=0}^{12} (x+k)  — Stirling coefficients
const LANCZOS_SDEN = [
  0, 39916800, 120543840, 150917976, 105258076, 45995730, 13339535,
  2637558, 357423, 32670, 1925, 66, 1,
];
```

The Lanczos ratio trick for `lbeta`:
```ts
function lbetaFloat64(a: number, b: number): number {
  // For moderate a, b: straightforward lgamma sum
  if (a + b < 170) {
    return lgammaRFloat64(a)[0] + lgammaRFloat64(b)[0] - lgammaRFloat64(a + b)[0];
  }
  // For large a or b: use Lanczos ratio cancellation (Boost lbeta)
  // ... compute g(a)*g(b)/g(a+b) in Lanczos space ...
}
```

**Edge cases:**

| Input | `beta(a,b)` | Notes |
|---|---|---|
| `a = 0 or b = 0` | `+∞` | pole in Γ(0) |
| `a or b negative integer` | `NaN` or `±∞` | Γ pole |
| `a, b very large` | tiny | use lbeta + exp |
| `a = b = 0.5` | `π` | Beta(1/2,1/2) = π (DLMF 5.12.1) |
| `a = 1, b = 1` | `1.0` | uniform distribution normalisation |

### §2.11 Incomplete Beta — `betainc(z, a, b)`

**Primary source:** Cephes `cprob/incbet.c` (Moshier 2000).

**Dispatch logic (incbet.c lines 109-162):**

```ts
function betaincFloat64(z: number, a: number, b: number): number {
  // Input validation: 0 ≤ z ≤ 1, a > 0, b > 0
  if (z <= 0) return 0.0;
  if (z >= 1) return 1.0;
  if (a <= 0 || b <= 0) return NaN; // domain

  // Symmetry reduction: ensure we compute in the regime where
  // the series or CF converges fastest. The criterion from incbet.c line 116:
  // if z > (a+1)/(a+b+2) swap to I_{1-z}(b, a) = 1 - I_z(a, b)
  let flag = 0;
  let aSwap = a, bSwap = b, zSwap = z;
  if (b * z <= 1.0 && z <= 0.95) {
    // Power series path (pseries): incbet.c line 109
    return pseriesFloat64(z, a, b);
  }
  if (z > a / (a + b)) {
    flag = 1; // symmetry: I_z(a,b) = 1 - I_{1-z}(b,a)
    aSwap = b; bSwap = a; zSwap = 1.0 - z;
  }
  // CF1 vs CF2 selection (incbet.c lines 131-137)
  const y = zSwap * (aSwap + bSwap - 2.0) - (aSwap - 1.0);
  let result: number;
  if (y < 0) {
    result = incbcfFloat64(zSwap, aSwap, bSwap);
  } else {
    result = incbdFloat64(zSwap, aSwap, bSwap);
  }
  // ... multiply by normalisation (lgamma-based or direct, incbet.c lines 139-162) ...
  return flag ? 1.0 - result : result;
}
```

**Constants (from incbet.c):**
```ts
const INCBET_BIG    = 4.5e15;         // same rescaling pattern as igam.c
const INCBET_BIGINV = 2.22e-16;
const INCBET_MACHEP = 2.2204460492503131e-16; // Math.EPSILON
```

**Edge cases:**

| Input | Output | Notes |
|---|---|---|
| `z = 0` | `0.0` | |
| `z = 1` | `1.0` | |
| `a = b = 1` | `z` | uniform distribution |
| `z = 0.5, a = b` | `0.5` | symmetry |
| `a → 0+` | `1.0` | |
| `b → 0+` | `0.0` | |
| `z < 0 or z > 1` | `NaN` | domain |

### §2.12 Barnes G — `barnes_g(x)`

**Primary source:** Adamchik 2003 asymptotic + recurrence. No canonical
public-domain float64 implementation exists comparable to Cephes/SunPro/Boost
for the standard Gamma. The Boost.Math implementation
(`boost/math/special_functions/factorials.hpp` and the Lanczos-based approach)
is the reference for production quality.

**Algorithm:**

For positive integer n: `G(n) = 1!·2!·…·(n−2)!` (DLMF 5.17.1).
- `G(1) = 1, G(2) = 1, G(3) = 1, G(4) = 2, G(5) = 12, G(6) = 288, …`

For real x > 0 (Adamchik 2003 asymptotic, DLMF 5.17.5):
```
log G(x+1) = (x²/2)·log(x) − (3x²/4) + (x/2)·log(2π) − log(A)
             + Σ_{k=1}^N B_{2k} / (4k(2k-1)) · x^{2-2k}  + O(x^{-2N})
```
where `A = e^{1/12 − ζ'(-1)}` is the Glaisher-Kinkelin constant `≈ 1.28242712910062263687534256886979172776...`.

```ts
// Glaisher-Kinkelin constant A (DLMF 5.17.6)
const BARNESG_A = 1.2824271291006226368753425688697917277;

// Bernoulli number coefficients B_{2k}/(4k(2k-1)) for the asymptotic series
// k=1: B_2 / (4*1*1) = (1/6)/4 = 1/24
// k=2: B_4 / (4*2*3) = (-1/30)/24 = -1/720
// k=3: B_6 / (4*3*5) = (1/42)/60 = 1/2520
// k=4: B_8 / (4*4*7) = (-1/30)/112 = -1/3360 (approx)
const BARNESG_ASYM = [
  1.0/24.0,
 -1.0/720.0,
  1.0/2520.0,
 -1.0/3360.0,  // approximate; recalculate from B_8 = -1/30 exactly
  1.0/1188.0,  // B_10/(4*5*9) = (5/66)/180
];
```

For x < 1: use the recurrence `G(x+1) = Γ(x)·G(x)` backwards to reach
positive territory.

**Honest limitation:** BarnesG for complex z has no established float64
algorithm. See §4.4 (honest refusal path).

**Edge cases:**

| Input | Output | Notes |
|---|---|---|
| `x = 1` | `1.0` | G(1) = 1 |
| `x = 0` | `1.0` | G(0) = 1 by convention (some sources say G(0) = 1) |
| `x negative integer` | `0.0` or `NaN` | G has zeros at negative integers ≤ -1 |
| `x = 0.5` | computed via asymptotic + recurrence | |
| `x very large` | use log-G then exp | overflow for x > ~50 |

### §2.13 Hyperfactorial — `hyperfactorial(n)`

**Algorithm for integer n:** Direct product `1^1 · 2^2 · 3^3 · … · n^n`.
Exact for n ≤ ~22 (result fits in float64 mantissa as an integer power of 2
pattern check). For n > ~22, use `exp(Σ_{k=1}^n k·log(k))`.

**Algorithm for real x (K(x) = exp(Σ_{k=1}^x k·log(k)) via continuous form):**
This is `exp(lhyperfactorial(x))` where `lhyperfactorial(x)` uses the
functional equation and the Barnes G relation
`K(x) = A^(-1) · x^{x²/2 + x/2 + 1/12} · exp(-x²/4) · G(x+1)`
(DLMF 5.17.4), so `log K(x) = log G(x+1) + (x²/2 + x/2 + 1/12)·log(x) - x²/4 - log(A)`.

**HONEST SCOPE NOTE:** For real non-integer `x`, Hyperfactorial requires
BarnesG, which is already a non-trivial algorithm. For v0.1, support integer
`n` exactly and provide the continuous-form approximation for real `x`
with ≤ ~5 ULP accuracy via the BarnesG route.

---

## §3 — Crossover / dispatch logic

### §3.1 `tgamma`: reduction to [2, 3] then P/Q rational

The Cephes approach reduces any positive x to the interval [2, 3] by:
- If x > 33: use Stirling
- If x ≤ 33: repeatedly apply Γ(x) = Γ(x+1)/x upward until x ∈ [2, 3],
  accumulating product factors

The key insight is that the P[7]/Q[8] rational approximation is tuned to [2, 3]
specifically. The integer/half-integer lookup-table shortcut (musl `tgamma.c`
lines 247-251) is a performance optimization for exactly representable cases.

### §3.2 `lgamma_r`: the minimum-point branch

The minimum of `lgamma(x)` on `(0, ∞)` is at `tc ≈ 1.46163...` with value
`≈ -0.12148...`. The FreeBSD `e_lgamma_r.c` implementation includes a special
Taylor polynomial `t[0..14]` tuned to the neighborhood of this minimum. This
branch matters because near-minimum inputs have `lgamma(x) ≈ 0`, and an
approximation that doesn't accurately capture the minimum miscomputes the sign
threshold.

The dispatch condition from FreeBSD (adapted):
```ts
if (x < 1.5) {
  if (x < tc) {
    // use polynomial in (x - tc), i.e., Taylor around minimum
    // t[] polynomial
  } else {
    // rational near 1: u/v form
    // u[] / v[] polynomial
  }
}
```

### §3.3 Incomplete gamma: series vs CF — the load-bearing dispatch

The dispatch between series (`igam`) and continued fraction (`igamc`) follows
the criterion:
- **Series converges faster when** `x < a + 1` (roughly: x is smaller than
  the mode of the integrand)
- **CF converges faster when** `x ≥ a + 1`

This is the classical observation that the series
`γ(a,x) = e^{-x}·x^a · Σ_{k=0}^∞ x^k / (a+1)_k`
converges rapidly for small x/a, while the Legendre CF
`Γ(a,x) = e^{-x}·x^a / (x + 1−a + 1/(x + 3−a + 2/(x + …)))` 
converges rapidly for large x.

The Cephes crossover at `x = a` (approximately) is a well-studied heuristic.
A more careful analysis (Temme 1992, "Asymptotic inversion of incomplete gamma
functions") shows the optimal crossover is near `x ≈ a` for all `a > 1`, and
that both algorithms are unreliable in the saddle region `x ≈ a` for large `a`.
For the I5 substrate, the Cephes crossover is adequate for float64 (≤ 3 ULP);
improved accuracy in the saddle region is a v0.2 enhancement (see §9).

### §3.4 Inverse igamma: rational seed → Halley refinement

The key improvement of the Boost approach over Cephes's `igami.c` is the
DiDonato-Morris rational seed which yields an initial estimate with ~5 digits
of accuracy instead of the Cephes cubic approximation's ~2-3 digits. With a
5-digit seed, Halley's method (cubic convergence) achieves full double
precision in at most 2 iterations. With a 2-digit seed, Newton (quadratic
convergence) may need 4-5 iterations.

The Cephes fallback to bisection (up to 400 iterations) is a safety net, not
the normal path. The Boost implementation should be preferred for the I5
substrate; Cephes is the fallback-algorithm reference.

### §3.5 Barnes G: recurrence + asymptotic

For `x > 0` and `x` small (say x < 7), use the functional equation
`G(x+1) = Γ(x)·G(x)` (DLMF 5.17.2) to shift x upward by integer steps until
x ≥ 7, accumulating `Σ log Γ(x+k)` terms. Then apply the asymptotic
expansion from §2.12. For `x < 1` shift backward (or use the reflection
formula `G(1-z)·G(1+z) = (Γ(z)·z)^{-z}·exp(-πi·z) / A^2` for the general
case — but the reflection is complex for non-integer off-real arguments; avoid
for the real float64 substrate).

### §3.6 Betainc: symmetry and CF selection

The two-step dispatch in Cephes `incbet.c`:
1. Symmetry step: if `z > a/(a+b)`, replace with `1 - I_{1-z}(b,a)` to put
   the larger beta parameter in the denominator (better CF convergence).
2. CF selection: use `incbcf` (CF1) if `y = z(a+b-2) - (a-1) < 0`, else
   use `incbd` (CF2). The CF2 form `incbd` uses the substitution
   `z → z/(1-z)` which improves convergence when z is close to 1.

---

## §4 — Complex paths

### §4.1 Complex log-gamma: `lgamma_complex(re, im)`

**Algorithm (Stirling + reflection):**

The most reliable float64 complex algorithm for `log Γ(z)` is the one
implemented in SciPy's `_loggamma.pxd` and mirrored in Julia's
`SpecialFunctions.jl`:

1. **Reflection** (when `Re(z) < 0.5`):
   `log Γ(z) = log(π) − log(sin(πz)) − log Γ(1−z)`
   where `sin(πz) = sin(π·Re(z))·cosh(π·Im(z)) + i·cos(π·Re(z))·sinh(π·Im(z))`

2. **Recurrence shift** (when `Re(z) < 7`):
   `log Γ(z) = log Γ(z+n) − Σ_{k=0}^{n-1} log(z+k)`
   shift until `Re(z+n) ≥ 7`.

3. **Stirling asymptotic** (`Re(z) ≥ 7`):
   ```
   log Γ(z) ≈ (z − 1/2)·log(z) − z + log(√(2π))
              + 1/(12z) − 1/(360z³) + 1/(1260z⁵) − 1/(1680z⁷) + …
   ```
   where all operations are complex.

**Accuracy:** ≤ ~15 significant digits across the strip `|Im(z)| ≤ 100`,
`Re(z) > 0` (before reflection). The main limitation is the complex `sin(πz)`
evaluation for the reflection formula, which loses precision near the negative
integer poles.

**Branch cuts:** The standard branch cut is along the negative real axis
(x ≤ 0, y = 0). On the upper lip `Im(z) = 0+`: the imaginary part is the
standard Arg of Γ(z). Near a pole `z = -n + ε·i`, `log Γ(z)` has
imaginary part `≈ π·n` (upper) or `≈ -π·n` (lower) depending on which side.

**Coefficient tables for Stirling in complex case (same as §2.3):**
Already given in `LGAMMA_COMPLEX_STIRLING`.

### §4.2 Complex digamma: `cdigamma(re, im)`

Analogous structure to complex log-gamma. Already implemented in
`packages/bigfloat/src/complex.ts` as `cdigamma` (arb-prec); the float64
version mirrors the algorithm with `number` arithmetic:

1. Reflection: `ψ(1-z) = π/tan(πz) + ψ(z)` (DLMF 5.5.4)
2. Shift to `Re(z) ≥ 7` via `ψ(z+1) = ψ(z) + 1/z`
3. Stirling asymptotic: `ψ(z) ≈ log(z) − 1/(2z) − Σ B_{2k}/(2k·z^{2k})`

The same `DIGAMMA_ASYM` coefficients apply for the complex case.

### §4.3 Complex incomplete gamma — honest refusal scope

**The honest status:** Float64 complex incomplete gamma `P(a, z)` for
`z ∈ ℂ` has no established, battle-tested, permissively-licensed
implementation at 1-5 ULP accuracy for all quadrants.

- Boost.Math's `gamma_p` template does NOT admit complex `z`.
- Cephes's `igam.c` is real-only.
- The Amos-TOMS library does not include gamma; it is Bessel-specific.
- The only comprehensive complex incomplete gamma implementation is in **Arb**
  (via `acb_hypgeom_gamma_upper`) and in **Wolfram Mathematica**.

For the I5 substrate, `gamma_p_complex` and `gamma_q_complex` should be
**honest refusals** (`tagged "special-eval/no-known-float64-algorithm"`)
rather than attempts at approximation. The arb-prec path (bigfloat)
handles the complex case via Confluent Hypergeometric or Tricomi U series.

### §4.4 Complex Barnes G — honest refusal

No float64 algorithm for `G(z)` at `z ∈ ℂ` has been published with explicit
error bounds. The reflection formula `G(1-z)·G(1+z)` involves complex
trigonometric functions that lose precision near the poles at negative integers.
**Refusal is the correct v0.1 answer**; flag as
`tagged "special-eval/no-known-float64-algorithm"`.

### §4.5 Complex beta function

`B(a, b) = Γ(a)·Γ(b)/Γ(a+b)` extends to complex arguments via the complex
log-gamma: `log B(a,b) = log Γ(a) + log Γ(b) − log Γ(a+b)`. The complex
log-gamma from §4.1 thus provides complex beta without additional algorithms,
at ≤ ~15 dp accuracy.

`B_complex(z, a, b)` (complex incomplete beta) is in the same "honest refusal"
category as complex incomplete gamma.

### §4.6 ADMITTED_HEADS for complex heads

Complex heads admitted to `SPECIAL_DISPATCH`:
- `LogGammaComplex(re, im)` — via §4.1
- `DigammaComplex(re, im)` — via §4.2
- `BetaComplex(a_re, a_im, b_re, b_im)` — via §4.5

Refused heads for complex (honest boundary):
- `GammaIncompleteComplex` → `tagged "special-eval/no-known-float64-algorithm"`
- `BarnesGComplex` → same
- `BetaIncompleteComplex` → same

---

## §5 — Scaled variants per Erf precedent

The scaled-variant pattern from Erf (`erfcx` = `exp(x²)·erfc(x)`) prevents
overflow in regimes where the unscaled form overflows or underflows.

### §5.1 `tgamma_ratio(a, b)` = Γ(a)/Γ(b)

**Motivation:** Computing `Γ(a)/Γ(b)` via `exp(lgamma(a) − lgamma(b))` loses
bits when `a` and `b` are large and close. The Lanczos numerator cancels
in the ratio:

```
Γ(a)/Γ(b) = [(a+g−1/2)/(b+g−1/2)]^(a−b) · [S(a)/S(b)] · exp((b−a)+(a−b)·log(a+g−1/2))
```

where S(x) = Σ LANCZOS_SNUM[k]/(x+k) is the Lanczos sum. Since a and b
share the same g, the exponential factor is simpler and can be computed
without overflow.

**Boost source:** `boost/math/special_functions/gamma.hpp` `tgamma_ratio`.
Use when `|a − b| < 1` or when `a, b > 30`.

```ts
function tgammaRatioFloat64(a: number, b: number): number {
  if (a <= 0 || b <= 0) return NaN;
  // For small a and b: direct ratio
  if (a < 30 && b < 30) return tgammaFloat64(a) / tgammaFloat64(b);
  // For large a, b: Lanczos cancellation route
  // ... Boost tgamma_ratio verbatim ...
}
```

### §5.2 `tgamma_delta_ratio(a, δ)` = Γ(a)/Γ(a+δ)

When δ is a small integer, use Pochhammer directly:
`Γ(a)/Γ(a+n) = 1 / ((a)_n)` — exact for integer n ≤ ~30.

When δ is a general real, use the Lanczos ratio with `b = a + δ`.

Accuracy: ≤ 2 ULP when δ is integer ≤ 30; ≤ 3 ULP via Lanczos for large a.

### §5.3 `gamma_p_derivative(a, x)` = exp(−x)·x^(a−1)/Γ(a)

This is the probability density function of the Gamma distribution and appears
in the Newton/Halley refinement for `gamma_p_inverse` (§2.9). It can be
computed as `gamma_p` differentiated: DLMF 8.8.12:
```
∂P(a,x)/∂x = e^{-x}·x^{a-1}/Γ(a)
```

**Direct computation via log (avoids exp(log(exp)) round-trips):**
```ts
function gammaPDerivativeFloat64(a: number, x: number): number {
  if (x <= 0 || a <= 0) return (x === 0 && a >= 1) ? 0.0 : NaN;
  const logValue = (a - 1) * Math.log(x) - x - lgammaRFloat64(a)[0];
  return Math.exp(logValue);
}
```

This is both the natural computation and the most numerically stable one:
computing `exp(-x)·x^(a-1)/Γ(a)` by multiplying the three terms separately
would cause catastrophic overflow/underflow for large x.

Accuracy: ≤ 2 ULP (inherits lgamma error + one exp).

### §5.4 `betainc_derivative(z, a, b)` = z^(a−1)·(1−z)^(b−1)/B(a,b)

Same pattern as `gamma_p_derivative` — the Beta distribution PDF:
```ts
function betaincDerivativeFloat64(z: number, a: number, b: number): number {
  const logValue = (a - 1) * Math.log(z) + (b - 1) * Math.log(1 - z) - lbetaFloat64(a, b);
  return Math.exp(logValue);
}
```

Used internally for Newton/Halley refinement in `betainc_inv`.

---

## §6 — `ADMITTED_HEADS` extension for `eval-numeric-expr.ts`

The following heads should be added to `SPECIAL_HEADS` and `SPECIAL_DISPATCH`
in `packages/quadrature/src/eval-numeric-expr.ts` as the I5 substrate for
the Gamma family ships. The list is additive — no existing heads are modified.

### §6.1 Real heads (unary and binary)

```ts
export const GAMMA_SPECIAL_HEADS: readonly string[] = [
  // tgamma family
  "Gamma",              // tgamma(x) — arity 1
  "LogGamma",           // log|Γ(x)|, sign tracked internally — arity 1
  "Digamma",            // ψ(x) — arity 1
  "Trigamma",           // ψ^(1)(x) — arity 1
  "Polygamma",          // ψ^(m)(x) — arity 2: (m, x)

  // Pochhammer / rising factorial
  "Pochhammer",         // (a)_n — arity 2: (a, n)

  // Incomplete gamma (regularised)
  "IncompleteGammaP",   // P(a, x) = γ(a,x)/Γ(a) — arity 2
  "IncompleteGammaQ",   // Q(a, x) = Γ(a,x)/Γ(a) — arity 2

  // Incomplete gamma (unregularised)
  "IncompleteGammaLower",  // γ(a,x) = P(a,x)·Γ(a) — arity 2
  "IncompleteGammaUpper",  // Γ(a,x) = Q(a,x)·Γ(a) — arity 2

  // Inverse incomplete gamma
  "InverseIncompleteGammaP",  // gamma_p_inverse(a, p) — arity 2
  "InverseIncompleteGammaQ",  // gamma_q_inverse(a, q) — arity 2

  // Beta
  "Beta",               // B(a, b) — arity 2
  "LogBeta",            // log B(a, b) — arity 2
  "IncompleteBeta",     // I_z(a, b) — arity 3: (z, a, b)
  "InverseBeta",        // betainc_inv(p, a, b) — arity 3

  // Barnes G and hyperfactorial
  "BarnesG",            // G(x) — arity 1
  "Hyperfactorial",     // H(n) or K(x) — arity 1

  // Scaled variants
  "GammaRatio",         // Γ(a)/Γ(b) — arity 2
  "GammaDeltaRatio",    // Γ(a)/Γ(a+δ) — arity 2
  "GammaPDerivative",   // d/dx P(a,x) — arity 2
];
```

### §6.2 Head naming alignment with cas-core vocabulary (ADR-0023)

The heads above MUST align with the cas-core vocabulary. The ADR-0042 draft
(to be written by the A0 orchestrator) should declare which cas-core head
names correspond to the float64 dispatch entries above. Likely mappings:

| cas-core `SPECIAL_FUNCTION_HEADS` name | float64 dispatch entry | DLMF reference |
|---|---|---|
| `Gamma` | `Gamma` | DLMF §5.2(i) |
| `LogGamma` | `LogGamma` | DLMF §5.2(i) |
| `Digamma` | `Digamma` | DLMF §5.2(ii) |
| `Trigamma` | `Trigamma` | DLMF §5.15 |
| `Polygamma` | `Polygamma` | DLMF §5.15 |
| `Pochhammer` | `Pochhammer` | DLMF §5.2(iii) |
| (new) `IncompleteGammaP` | `IncompleteGammaP` | DLMF §8.2(i) |
| (new) `IncompleteGammaQ` | `IncompleteGammaQ` | DLMF §8.2(i) |
| (new) `IncompleteBeta` | `IncompleteBeta` | DLMF §8.17 |
| (new) `Beta` | `Beta` | DLMF §5.12 |
| (new) `BarnesG` | `BarnesG` | DLMF §5.17 |
| (new) `Hyperfactorial` | `Hyperfactorial` | DLMF §5.22 |

**IMPORTANT:** The I6a (vocabulary amendment) bead for this epic MUST add
`IncompleteGammaP`, `IncompleteGammaQ`, `IncompleteBeta`, `BarnesG`,
`Hyperfactorial` to `cas-core/src/special-functions.ts` before the I5 dispatch
can legitimately be added to `eval-numeric-expr.ts`. The pattern is identical
to the Erf epic's I6a bead which added `Erfi` to ADR-0023.

### §6.3 Arity table for SPECIAL_DISPATCH

```ts
const GAMMA_DISPATCH = new Map<string, (args: number[]) => number>([
  // Unary
  ["Gamma",         (a) => { requireArity("Gamma", a, 1); return tgammaFloat64(a[0]!); }],
  ["LogGamma",      (a) => { requireArity("LogGamma", a, 1); return lgammaRFloat64(a[0]!)[0]; }],
  ["Digamma",       (a) => { requireArity("Digamma", a, 1); return digammaFloat64(a[0]!); }],
  ["Trigamma",      (a) => { requireArity("Trigamma", a, 1); return trigammaFloat64(a[0]!); }],
  ["BarnesG",       (a) => { requireArity("BarnesG", a, 1); return barnesGFloat64(a[0]!); }],
  ["Hyperfactorial",(a) => { requireArity("Hyperfactorial", a, 1); return hyperfactorialFloat64(a[0]!); }],
  ["GammaRatio",    (a) => { requireArity("GammaRatio", a, 1); return NaN; }], // arity 2

  // Binary (m, x) or (a, x) or (a, b)
  ["Polygamma",          (a) => { requireArity("Polygamma", a, 2); return polygammaFloat64(a[0]!, a[1]!); }],
  ["Pochhammer",         (a) => { requireArity("Pochhammer", a, 2); return pochhammerFloat64(a[0]!, a[1]!); }],
  ["IncompleteGammaP",   (a) => { requireArity("IncompleteGammaP", a, 2); return igamFloat64(a[0]!, a[1]!); }],
  ["IncompleteGammaQ",   (a) => { requireArity("IncompleteGammaQ", a, 2); return igamcFloat64(a[0]!, a[1]!); }],
  ["IncompleteGammaLower",(a) => { requireArity("IncompleteGammaLower", a, 2); return igamFloat64(a[0]!, a[1]!) * tgammaFloat64(a[0]!); }],
  ["IncompleteGammaUpper",(a) => { requireArity("IncompleteGammaUpper", a, 2); return igamcFloat64(a[0]!, a[1]!) * tgammaFloat64(a[0]!); }],
  ["InverseIncompleteGammaP",(a) => { requireArity("InverseIncompleteGammaP", a, 2); return igamiFloat64(a[0]!, a[1]!); }],
  ["InverseIncompleteGammaQ",(a) => { requireArity("InverseIncompleteGammaQ", a, 2); return igamiFloat64(a[0]!, 1 - a[1]!); }],
  ["Beta",               (a) => { requireArity("Beta", a, 2); return betaFloat64(a[0]!, a[1]!); }],
  ["LogBeta",            (a) => { requireArity("LogBeta", a, 2); return lbetaFloat64(a[0]!, a[1]!); }],
  ["GammaRatio",         (a) => { requireArity("GammaRatio", a, 2); return tgammaRatioFloat64(a[0]!, a[1]!); }],
  ["GammaDeltaRatio",    (a) => { requireArity("GammaDeltaRatio", a, 2); return tgammaDeltaRatioFloat64(a[0]!, a[1]!); }],
  ["GammaPDerivative",   (a) => { requireArity("GammaPDerivative", a, 2); return gammaPDerivativeFloat64(a[0]!, a[1]!); }],

  // Ternary: (z, a, b)
  ["IncompleteBeta", (a) => { requireArity("IncompleteBeta", a, 3); return betaincFloat64(a[0]!, a[1]!, a[2]!); }],
  ["InverseBeta",    (a) => { requireArity("InverseBeta", a, 3); return betaincInvFloat64(a[0]!, a[1]!, a[2]!); }],
]);
```

---

## §7 — Edge-case table (per Boost / Cephes / libm documentation)

### §7.1 tgamma edge cases

| x | Γ(x) | Behavior | Source |
|---|---|---|---|
| `NaN` | `NaN` | IEEE propagation | All libms |
| `+∞` | `+∞` | diverges | All libms |
| `-∞` | `NaN` | cascade of poles | musl tgamma.c |
| `+0` | `+∞` | pole at 0 | C99 standard |
| `-0` | `-∞` | pole, sign from 1/x convention | C99 standard |
| `-n` (n∈ℤ, n≥1) | `NaN` or `±∞` | Cephes returns ±∞; C99 mandates `errno=EDOM`, returns ±∞ | C99 / Cephes |
| `0.5` | `√π ≈ 1.7724538509` | DLMF 5.4.6 | |
| `1` | `1.0` | exact | |
| `2` | `1.0` | exact | |
| `n` (n∈ℤ, n≥1) | `(n-1)!` | exact via table for n≤22 | musl fact[] |
| `22` | `5.109094217170944e19` | max exact integer factorial | |
| `23` | `1.1240007277776077e21` | first inexact | |
| `171` | `7.257415615307999e306` | last non-overflow | |
| `171.625` | `+∞` | IEEE overflow | Cephes MAXGAM |
| `172` | `+∞` | overflow | |
| `-0.5` | `-2√π ≈ -3.5449077018` | DLMF 5.4.7 | |
| `1e-300` (small positive) | `≈ 1/x` | large but finite | |
| subnormal | `≈ 1/x` → very large | well-defined via Cephes | |

### §7.2 lgamma_r edge cases

| x | log\|Γ\| | sign | Notes |
|---|---|---|---|
| `+0` | `+∞` | `+1` | pole |
| `-0` | `+∞` | `+1` | same |
| `-n` (n∈ℤ≥1) | `+∞` | `+1` | pole; POSIX says sign=+1 regardless |
| `±∞` | `+∞` | `+1` | lgamma grows without bound |
| `NaN` | `NaN` | `+1` | IEEE NaN propagation |
| `1.0` | `0.0` | `+1` | Γ(1) = 1 |
| `2.0` | `0.0` | `+1` | Γ(2) = 1 |
| `1.4616321...` | `-0.12148629` | `+1` | minimum |
| `x ∈ (-1, 0)` | large pos | `-1` | Γ < 0 on this interval |
| `x ∈ (-2, -1)` | large pos | `+1` | Γ > 0 |
| `x ∈ (-3, -2)` | large pos | `-1` | alternating sign |
| `2.5566e305` | `≈ MAXLOG·N` | `+1` | MAXLGM (Cephes); beyond this → overflow |

### §7.3 digamma edge cases

| x | ψ(x) | Notes |
|---|---|---|
| `+0` | `-∞` | pole |
| `-0` | `+∞` | C99 convention (−∞ from positive side vs +∞ from negative) |
| `-n` (n∈ℤ≥0) | `±∞` | pole at each non-positive integer |
| `+∞` | `+∞` | ψ(x) ~ log(x) |
| `-∞` | `NaN` | cascade of poles |
| `1` | `-γ_EM ≈ -0.5772156649` | Euler-Mascheroni constant (DLMF 5.4.12) |
| `2` | `1 - γ_EM ≈ 0.4227843351` | |
| `0.5` | `-γ_EM - 2·log(2) ≈ -1.9635100260` | DLMF 5.4.14 |
| `1.4616321...` | `0.0` | ψ zero coincides with Γ minimum |

### §7.4 incomplete gamma edge cases

| a | x | gamma_p | gamma_q | Notes |
|---|---|---|---|---|
| any>0 | `0` | `0.0` | `1.0` | definition |
| any>0 | `+∞` | `1.0` | `0.0` | complete integral |
| `1` | x | `1 − e^{−x}` | `e^{−x}` | exponential CDF |
| `0.5` | x | `erf(√x)` | `erfc(√x)` | DLMF 8.11.1 |
| any>0 | `NaN` | `NaN` | `NaN` | |
| `0` | any | `NaN` | `NaN` | domain |
| `NaN` | any | `NaN` | `NaN` | |
| a>0 | x<0 | `NaN` (Cephes: `0.0`) | `NaN` (Cephes: `1.0`) | domain; Cephes returns 0/1 for x<0 without error |
| `100`, `100` | `≈ 0.5` | `≈ 0.5` | The crossover is near 1/2 here; both algorithms may be slow | |

### §7.5 incomplete beta edge cases

| z | a | b | betainc | Notes |
|---|---|---|---|---|
| `0` | any | any | `0.0` | |
| `1` | any | any | `1.0` | |
| z | `1` | `1` | `z` | uniform |
| `0.5` | a | a | `0.5` | symmetry |
| z | `0.5` | `0.5` | `(2/π)·arcsin(√z)` | arc-sine distribution (DLMF 8.17.10) |
| z<0 or z>1 | any | any | `NaN` | domain |
| z | `0` | any | `NaN` | domain (Cephes: returns `0`) |
| z | any | `0` | `NaN` | domain (Cephes: returns `1`) |

### §7.6 Barnes G edge cases

| x | G(x) | Notes |
|---|---|---|
| `1` | `1.0` | G(1) = 1 |
| `2` | `1.0` | G(2) = 1 |
| `3` | `1.0` | G(3) = 1 |
| `4` | `2.0` | G(4) = 2 |
| `0` | `1.0` | G(0) = 1 by convention |
| `-n` (n∈ℤ≥1) | `0.0` | G has zeros at negative integers |
| `+∞` | `+∞` | diverges super-exponentially |
| `NaN` | `NaN` | |

---

## §8 — V8 / JS-native Math comparison

V8's `Math` object has no `gamma`, `lgamma`, `digamma`, `betainc`, or any
Gamma-family function. The relevant V8 builtins are:

| V8 builtin | Used by Gamma substrate | Notes |
|---|---|---|
| `Math.exp(x)` | tgamma (Stirling), lgamma, igam (prefactor), etc. | ADR-0015: platform-specific at last bit |
| `Math.log(x)` | lgamma everywhere, igam prefactor | same |
| `Math.sin(x)`, `Math.cos(x)` | reflection formulas (lgamma, digamma, betainc) | same |
| `Math.sqrt(x)` | igami seed (`sqrt(d)`) | same |
| `Math.abs(x)`, `Math.trunc(x)`, `Math.floor(x)` | sign tracking | exact |
| `Math.PI` | reflection formulas | exact `π` constant; do NOT use this for the π constant in coefficient tables — use the literal hex double |

**No Gamma-family polyfill from npm is recommended.** The available npm
packages (`mathjs`, `gamma`, `lanczos`, `natural-number-approximation`) are
either slow (arbitrary-precision), inaccurate (single-precision coefficients
ported from papers), or unlicensed. The verbatim port from Cephes/SunPro/Boost
is the correct path.

**Key decision: Cephes vs musl `tgamma.c`**

musl `tgamma.c` uses the Lanczos g=6.0247 approximation with 13 coefficients.
This is a different algorithm than Cephes's rational [2,3] reduction + Stirling.
Both achieve ≤ 2 ULP. The Cephes approach is preferred for the Gamma substrate
because:
1. Cephes also supplies `igam`, `igamc`, `igami`, `incbet` — all using
   Cephes's constants (`MACHEP`, `MAXLOG`). Using Cephes `gamma.c` for tgamma
   keeps the constant set unified.
2. The Cephes `stirf()` routine is directly reused by `lgam()`.
3. The Lanczos approach (musl) requires a different code path for `lgamma` and
   doesn't directly yield the `lgamma_r` sign — Cephes's approach integrates
   more cleanly with the signed `lgam` API.

If only `tgamma` were needed (no igam/lgamma/betainc), musl's Lanczos would be
equally valid. For the full Gamma family substrate, **Cephes is the primary
source for tgamma + lgamma + igam + igamc + igami + incbet**, and FreeBSD
`e_lgamma_r.c` (identical algorithm, better-structured code) is the source for
`lgamma_r`.

---

## §9 — Open follow-ups for v0.2

These are **not** blockers for the v0.1 float64 substrate ship. Each is
a candidate for a standalone bead after the I5 substrate lands.

### §9.1 Incomplete gamma near saddle (x ≈ a, large a)

For large `a` with `x ≈ a`, both the power series and the continued fraction
converge slowly and with cancellation. Temme (1992) "Asymptotic inversion of
incomplete gamma functions" and DiDonato-Morris (1995) give a uniform
asymptotic expansion in this regime. Boost's implementation includes a
"Temme minimax" path (Julia `gamma_inc.jl` line 838-908) that achieves ≤ 1 ULP
in the saddle region. This is a v0.2 enhancement.

### §9.2 Inverse incomplete gamma: Boost Halley vs Cephes Newton/bisection

The v0.1 substrate should use the Cephes `igami.c` (Newton + bisection)
because it is shorter and well-understood. The v0.2 upgrade is to the Boost
`igamma_inverse.hpp` DiDonato-Morris rational seed + Halley, which achieves
full double precision in 1-2 iterations for all (a, p) pairs. Filed as a
separate enhancement bead.

### §9.3 `lgamma` near unity: Boost "near unity" refit

For `x` very close to 1 or 2, FreeBSD `e_lgamma_r.c`'s Taylor polynomial is
adequate but not tight. Boost has an explicit "near unity" branch (similar to
the `erfc` near-0 treatment) that uses a minimax polynomial calibrated to
`[1 - ε, 1 + ε]`. This is relevant for probability computations where
`lgamma(1 + x)` for small `x` appears frequently. v0.2.

### §9.4 `digamma` Holoborodko refits

Pavel Holoborodko's blog (holoborodko.com) documents minimax refits of the
digamma rational approximation that achieve ≤ 0.5 ULP on [1, 2]. The
coefficient tables require re-running the Remez algorithm at 53-bit precision.
The Boost P53/Q53 rational is ≤ 2 ULP; the Holoborodko refit would bring this
to ≤ 1 ULP. v0.2.

### §9.5 BarnesG asymptotic precision

The 5-term Bernoulli series for log G(x) in §2.12 achieves ≤ 5 ULP for
x ≥ 7. Adding 3 more terms would bring this to ≤ 3 ULP at the cost of 3
additional Bernoulli coefficient constants. Low priority but easy.

### §9.6 Complete elliptic integrals via incomplete beta

The complete elliptic integrals K(k) and E(k) can be expressed in terms of
the incomplete beta function. Once `betainc` is in the substrate, this gives
a "free" approximate elliptic integral evaluator at float64 precision. A
bead should be filed to expose this and verify accuracy against mpmath.

### §9.7 Complex incomplete gamma via Series/CF extension

The power series `γ(a,z) = e^{-z}·z^a · Σ z^k/(a+1)_k` is formally valid
for complex `z`; the CF representation likewise extends analytically. The
main obstacle is not algorithmic but validation: no gold-tier float64 oracle
(Boost, Cephes, musl) covers complex incomplete gamma, so the cross-oracle
grading would be single-engine (Wolfram + mpmath only). This is the
"weakest oracle link" for Gamma analogous to the single-engine complex
arb-prec issue for Erf. Arb installation (`python-flint`) would close it.
v0.2 (contingent on Arb install).

---

## §A — Appendix: complete coefficient tables for emit-ready TS

All arrays below are directly transcribed from their cited C sources.
The I5 implementer should verify each by checking the source file at the
committed revision cited.

### §A.1 Cephes `gamma.c` — complete P, Q, STIR, lgam A/B/C arrays

```ts
// Source: Cephes Math Library 2.8 (June 2000), Moshier
// License: permissive BSD (Moshier 2000 header)
// File: cprob/gamma.c

// Gamma rational approximation P[7] and Q[8] for [2,3] (lines 261-277)
const CEPHES_GAMMA_P = [
  1.60119522476751861407e-4,
  1.19135147006586384913e-3,
  1.04213797561761569935e-2,
  4.76367800457137231464e-2,
  2.07448227648435975150e-1,
  4.94214826801497100753e-1,
  9.99999999999999996796e-1,
] as const;

const CEPHES_GAMMA_Q = [
  -2.31581873324120129819e-5,
   5.39605580493303397842e-4,
  -4.45641913851797240494e-3,
   1.18139785222060435552e-2,
   3.58236398605498653373e-2,
  -2.34591795718243348568e-1,
   7.14304917030273074085e-2,
   1.00000000000000000320e0,
] as const;

// Stirling polynomial for stirf() (lines 325-329)
const CEPHES_GAMMA_STIR = [
  7.87311395793093628397e-4,
 -2.29549961613378126380e-4,
 -2.68132617805781232825e-3,
  3.47222221605458667310e-3,
  8.33333333333482257126e-2,
] as const;

// lgam() Stirling A[5] (lines 165-169) — for x > 33 branch of lgam
const CEPHES_LGAM_A = [
  8.11614167470508450300e-4,
 -5.95061904284301438324e-4,
  7.93650340457716943945e-4,
 -2.77777777730099687205e-3,
  8.33333333333331927722e-2,
] as const;

// lgam() [2,3] rational B[6] numerator (lines 170-175)
const CEPHES_LGAM_B = [
 -1.37191904938327686540e-2,
 -3.25642444896452941677e-2,
  1.12278739081670047876e-1,
 -2.20396587102987495855e-1,
 -3.46622774214547406333e-2,
  1.00000000000000000322e0,
] as const;

// lgam() [2,3] rational C[6] denominator (lines 176-181)
const CEPHES_LGAM_C = [
 -1.45660718631509682895e-2,
 -1.30904030004799873929e-2,
  1.39720317307227711399e-1,
 -4.17619806591484128943e-1,
  1.64300885009141914690e0,
  1.00000000000000000000e0,
] as const;

const CEPHES_LGAM_MAXLGM = 2.556348e305;
const CEPHES_LGAM_LS2PI  = 0.91893853320467274178; // log(√(2π))
const CEPHES_LGAM_LOGPI  = 1.14472988584940017414; // log(π)
```

### §A.2 FreeBSD `e_lgamma_r.c` — complete w[] asymptotic array (Stirling)

Already given in §2.2 as `LGAMMA_W`. The scalar constants `LGAMMA_TC`,
`LGAMMA_TF`, `LGAMMA_TT` are the most important for the minimum-point branch.

### §A.3 Boost Lanczos g=6.024680040776729583740234375

Already given in §2.10 as `LANCZOS_SNUM` / `LANCZOS_SDEN`. This is the
musl `tgamma.c` Lanczos, identical to Boost `lanczos13m53`. The constant
`LANCZOS_G = 6.024680040776729583740234375` is the exact float64 value
(the decimal is the shortest round-trip representation).

### §A.4 Boost digamma.hpp 53-bit coefficients

Already given in §2.4 as `DIGAMMA_P53`, `DIGAMMA_Q53`, `DIGAMMA_ASYM`,
`DIGAMMA_ROOT1`, `DIGAMMA_Y`. These are the load-bearing constants for the
[1,2] rational approximation.

### §A.5 Boost igamma_inverse.hpp rational seed

Already given in §2.9 as `INV_IGAMMA_SEED_A`, `INV_IGAMMA_SEED_B`. These are
the DiDonato-Morris rational approximation coefficients for the initial seed.

### §A.6 Cephes igam.c rescaling constants

Already given in §2.8:
- `IGAM_BIG = 4.503599627370496e15` (= 2^52; prevents CF overflow)
- `IGAM_BIGINV = 2.22044604925031308085e-16` (= 1/IGAM_BIG)

Same constants in `incbet.c` (lines 64-65).

---

## §B — Module layout proposal for `gamma-float64.ts`

Following the styling exemplar of `erf-float64.ts` and `bessel-float64.ts`,
the I5 landing file should have this structure:

```
packages/quadrature/src/special-funcs/gamma-float64.ts
  § Module header (130 LOC):
      - License notices (Cephes 2000 BSD; FreeBSD SunPro 1993 BSD; Boost BSL-1)
      - Algorithm narrative (per CLAUDE.md Rule 10 literate style)
      - Per-function port table citing source files
      - Determinism contract (ADR-0015 numerical:true)
  § DataView helpers (30 LOC):
      - Endianness canary (same as erf-float64.ts)
      - No maskLowWord needed here (lgamma's split is handled differently)
  § Constant tables (120 LOC):
      - All arrays from §A.1-A.6 above, grouped by function
  § tgamma / stirf (120 LOC):
      - Cephes gamma.c verbatim port
  § lgamma_r (150 LOC):
      - FreeBSD e_lgamma_r.c verbatim port
      - sin_pi helper (from FreeBSD, ~25 LOC)
  § digamma (80 LOC):
      - Boost digamma.hpp 53-bit branch verbatim
  § trigamma (50 LOC):
      - Boost polygamma_atinfinityplus n=1 + reflection
  § polygamma (100 LOC):
      - Boost detail/polygamma.hpp: atinfinityplus, nearzero, recurrence, reflection
      - hurwitzZeta helper (30 LOC)
  § pochhammer (40 LOC):
      - Direct product + lgamma route
  § igam / igamc (120 LOC):
      - Cephes igam.c verbatim port (mutual recursion depth=1)
  § igami (100 LOC):
      - Boost igamma_inverse.hpp: find_inverse_s seed + Halley
      - (Cephes igami.c Newton+bisection as fallback)
  § beta / lbeta (60 LOC):
      - lgamma composition + Lanczos ratio for large args
  § betainc / betaincInv (160 LOC):
      - Cephes incbet.c: pseries + incbcf + incbd verbatim
      - Betainc inverse: Newton on forward function
  § barnesG (80 LOC):
      - Recurrence + Adamchik asymptotic + precomputed table
  § hyperfactorial (40 LOC):
      - Direct product for integer n; BarnesG route for real x
  § Scaled variants (80 LOC):
      - tgammaRatio, tgammaDeltaRatio, gammaPDerivative, betaincDerivative
  § Complex wrappers (120 LOC):
      - lgammaComplex: Stirling + reflection (§4.1)
      - digammaComplex: same pattern (§4.2)
      - betaComplex: via lgammaComplex (§4.5)
      - Honest refusals for GammaIncompleteComplex, BarnesGComplex, BetaIncompleteComplex
  § Export block (30 LOC)

  Target: ~1500 LOC total.
```

---

## §C — Mutation-proving specification for I5 (ADR-0040 Decision 3, Rule 6)

For each of the following (at minimum), the I5 implementer must document
≥ 3 perturbations that cause RED test failures, then restore:

### C.1 tgamma
1. **Perturb `GAMMA_STIR[4]`** from `8.33333e-2` to `8.34e-2`: Stirling polynomial
   changes; goldens for x=50, x=100 fail.
2. **Remove the `fact[]` table short-circuit** for integer n ≤ 22: the rational
   approximation gives slightly different results at n=5 due to accumulated
   rounding; T1-tier (exact integer) goldens fail.
3. **Swap P/Q Horner evaluation order** (reverse the arrays): the rational
   approximation gives wrong results everywhere in [2,3]; virtually all
   goldens fail.

### C.2 lgamma_r
1. **Perturb `LGAMMA_TC`** by 1 ULP: the minimum-point branch gives wrong
   values near the minimum; T4-tier (near-tc) goldens fail.
2. **Remove the `sin_pi` helper** and use `Math.sin(Math.PI * x)` directly:
   for x = integer + 0.5, the reflection formula gains ~0.5 ULP of error
   from the `Math.PI` multiplication; some T5-tier (near-integer-negative)
   goldens fail.
3. **Remove the sign tracking** (always return sign=+1): `lgamma_r(-0.5)[1]`
   should be -1 (Γ(-0.5) = -2√π < 0); sign-checking goldens fail.

### C.3 igam / igamc
1. **Remove the mutual-dispatch condition** in `igam` (always use series):
   for large x (e.g. a=1, x=20), the series diverges instead of delegating
   to CF; T2-tier goldens fail.
2. **Remove CF rescaling** (`IGAM_BIG` / `IGAM_BIGINV` scaling): for large x,
   `pk`, `qk` overflow to `Infinity` and CF returns `NaN`; T3-tier goldens fail.
3. **Replace `ax = a*log(x)-x-lgamma(a)` with `ax = -x-lgamma(a)`** (drop
   the `a*log(x)` term): the prefactor is wrong; all non-trivial goldens fail.

### C.4 digamma
1. **Perturb `DIGAMMA_ROOT1`** by 1e-8: the rational approximation has wrong
   zero crossing; T1-tier (near-root) goldens fail.
2. **Replace reflection formula** `π/tan(πx) + ψ(x)` with `π*cot(πx) + ψ(x)`
   (same, but compute `cot` as `cos/sin` explicitly with a sign error):
   negative-x goldens fail.
3. **Remove the asymptotic threshold shift**: try to use the rational on
   x=15 (outside [1,2]); the approximation degrades; T3-tier goldens fail.

---

*End of R3 — Float64 Gamma-family algorithms.*
*Bead: `scientist-workbench-ldsf`. Next artefact: R4 (Meijer-G bridge for Gamma family).*
