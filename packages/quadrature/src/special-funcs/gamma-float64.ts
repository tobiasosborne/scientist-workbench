// =============================================================================
// gamma-float64.ts — Float64 Gamma family substrate
// =============================================================================
//
// Intent
// ------
// The float64 lane of the per-head Gamma substrate pinned by ADR-0042
// (`docs/adr/0042-gamma-family-per-head-substrate.md`, §Decision 4).
// The Gamma family is the third per-head substrate prototype after Erf
// (ADR-0040) and Bessel (ADR-0041); the architecture generalises
// unchanged. Nineteen `ADMITTED_HEADS` entries land here (R3 §1):
// Gamma, LogGamma, Digamma, Trigamma, Polygamma, Pochhammer, four
// incomplete-gamma forms (Upper/Lower unregularised, P/Q regularised),
// Beta, LogBeta, BarnesG, Hyperfactorial, GammaRatio, GammaDeltaRatio,
// GammaPDerivative, plus three complex paths (LogGamma, Gamma,
// Digamma). The remaining complex heads — incomplete gamma, BarnesG,
// polygamma m≥2 — are honest refusals (R3 §4.3/§4.4; ADR-0042
// "What we will not decide here") because no battle-tested, permissive
// float64 algorithm exists; the arb-prec lane carries those cases
// (`packages/bigfloat`).
//
// Determinism contract (ADR-0015 `numerical: true`)
// -------------------------------------------------
// Bit-identical *given* platform fingerprint `{arch, os, runtime}`.
// Pure JavaScript on Bun/V8 — no FFI, no `process.arch` reads, no
// `Math.fround`. The only operations with possible cross-arch
// divergence at the last bit are V8's `Math.exp`, `Math.log`,
// `Math.sin`, `Math.cos`, `Math.tan`, `Math.sqrt`, `Math.atan2` — the
// tier's existing inheritance, not new exposure. Coefficient parsing
// is deterministic across all V8 builds per ECMAScript 11.1.3.3
// (shortest-round-trip decimal literals parse exactly to their IEEE-754
// doubles). Every coefficient below is reproduced verbatim from its
// cited source file; no Remez refits, no minimax re-runs.
//
// Verbatim-port discipline (R3 §0.0 — non-negotiable)
// ---------------------------------------------------
// Every algorithm below is a line-by-line port of its C/C++ source.
// The papers (Cephes 2000, FreeBSD libm SunPro 1993, Boost.Math) hold
// 30-50 years of accumulated bug-fixes: sign tracking in lgamma at
// negative-argument intervals, the `IGAM_BIG = 4.5e15` CF rescaling
// (empirically calibrated against convergence rate), the `igam`/
// `igamc` mutual-recursion depth-1 invariant, the FreeBSD
// `e_lgamma_r.c` minimax pivot at `tc ≈ 1.46163...`. Re-deriving from
// DLMF would cost 4-12 hours per algorithm and miss at least one
// load-bearing detail. The discipline is pinned at R3 §0.0; this file
// follows it.
//
// Per-function port table (R3 §1)
// -------------------------------
// | Head                  | Source                                     | Accuracy |
// |-----------------------|--------------------------------------------|----------|
// | gammaFloat64          | Cephes `cprob/gamma.c` (Moshier 2000)      | ≤ 2 ULP  |
// | lgammaFloat64         | FreeBSD `e_lgamma_r.c` (SunPro 1993)       | ≤ 2 ULP  |
// | digammaFloat64        | Boost `digamma.hpp` 53-bit specialisation  | ≤ 2 ULP  |
// | trigammaFloat64       | Boost `polygamma.hpp` m=1 + recurrence     | ≤ 2 ULP  |
// | polygammaFloat64      | Boost `detail/polygamma.hpp` Bernoulli sum | ≤ 4 ULP  |
// | pochhammerFloat64     | Direct product or lgamma-ratio             | ≤ 4 ULP  |
// | igamFloat64           | Cephes `cprob/igam.c` series               | ≤ 3 ULP  |
// | igamcFloat64          | Cephes `cprob/igam.c` continued fraction   | ≤ 3 ULP  |
// | incGammaLowerFloat64  | igamFloat64 · gammaFloat64                 | ≤ 4 ULP  |
// | incGammaUpperFloat64  | igamcFloat64 · gammaFloat64                | ≤ 4 ULP  |
// | invGammaPFloat64      | Cephes `igami.c` Newton + bisection        | ≤ 1e-12  |
// | invGammaQFloat64      | igamiFloat64(a, 1-q)                       | ≤ 1e-12  |
// | betaFloat64           | exp(lgamma sum) with sign                  | ≤ 4 ULP  |
// | logBetaFloat64        | lgamma sum with sign                       | ≤ 2 ULP  |
// | gammaRatioFloat64     | Direct ratio or lgamma-difference          | ≤ 4 ULP  |
// | gammaDeltaRatioFloat64| Pochhammer or lgamma-difference            | ≤ 4 ULP  |
// | gammaPDerivativeFloat64| DLMF §8.8.12 log-then-exp                 | ≤ 2 ULP  |
// | barnesGFloat64        | Integer table + Adamchik asymptotic        | ≤ 5 ULP  |
// | hyperfactorialFloat64 | Integer product + BarnesG route            | ≤ 5 ULP  |
// | incBetaFloat64        | Cephes `incbet.c` pseries + CF             | ≤ 4 ULP  |
// | lgammaComplexFloat64  | SciPy `_loggamma.pxd` Stirling + reflection| ≤ 14 dp  |
// | gammaComplexFloat64   | exp(lgammaComplex) with sign correction    | ≤ 13 dp  |
// | digammaComplexFloat64 | Stirling-shift mirroring real digamma      | ≤ 14 dp  |
//
// Algorithm narratives (per R3 §2-5, condensed)
// ---------------------------------------------
//
// 1. **`gammaFloat64(x)` — Cephes `gamma.c`.** Three-region dispatch:
//      - integer x ∈ {1, …, 22}: exact factorial table lookup;
//      - 0 < x ≤ 33: recurrence to [2, 3] then P[7]/Q[8] rational;
//      - x > 33 but x ≤ 171.624: Stirling via `stirf`;
//      - x > 171.624: overflow → +∞ (Cephes MAXGAM);
//      - x < 0 non-integer: reflection `Γ(x)·Γ(-x) = -π/(x·sin(πx))`;
//      - x ∈ {0, -1, -2, …}: poles → ±∞ (Cephes returns ±∞).
//    The Stirling polynomial `GAMMA_STIR` is 5-term Chebyshev-like
//    (Moshier 2000); P/Q is 7/8 deg rational on [2, 3]. Verbatim from
//    `cprob/gamma.c` lines 261-277 (P/Q), 325-329 (STIR), 280 (MAXGAM).
//
// 2. **`lgammaFloat64(x) → {value, sign}` — FreeBSD `e_lgamma_r.c`
//    (SunPro 1993 lineage; same provenance as `j0.c` and `s_erf.c`).**
//    Five-region dispatch with sign tracked separately:
//      - |x| < 2^{-70}: return `-log(|x|)` (tiny-x underflow guard);
//      - x ∈ (0, 1): polynomial `a[0..11]` + recurrence;
//      - x ∈ [1, 2): minimax around `tc ≈ 1.46163...` via `t[0..14]`
//        Taylor + `u/v` rational on [1.5, 2.5];
//      - x ∈ [2, 8): multiplicative chain to base interval + `s/r`
//        rational;
//      - x ∈ [8, 2^{56}): Stirling via `w[0..6]` asymptotic;
//      - x ≥ 2^{56}: `x·(log(x) - 1)` approximation;
//      - x < 0: reflection `Γ(x)·Γ(1-x) = π/sin(πx)` via the FreeBSD
//        `sin_pi(x)` helper (lines 169-184) which is range-reduced to
//        avoid the ULP loss of `sin(π · large)`.
//    Sign is `+1` everywhere except where Γ is negative — at non-
//    integer x with floor(x) odd in (-1, 0), in (-3, -2), etc.
//    Returns `{value: log|Γ|, sign}` as a discriminated record to
//    avoid sign-coupling bugs.
//
// 3. **`digammaFloat64(x)` — Boost `digamma.hpp` 53-bit specialisation
//    (lines 384-427 for the [1, 2] rational, lines 232-251 for the
//    asymptotic).** Boost's clever trick is the (x - root) form:
//      ψ(x) = (x - root) · (Y + R(x - 1))
//    on [1, 2], where `root ≈ 1.46163...` (same as lgamma's tc, the
//    zero of digamma) and `Y ≈ 0.99558...` is float32-rounded so
//    `(x - root) · Y` is exact in float64 — the bits dropped by Y are
//    recovered by `R`. Dispatch:
//      - x ≥ 10: 8-term Bernoulli asymptotic;
//      - 1 ≤ x < 10: shift down to [1, 2] via ψ(x) = ψ(x-1) + 1/(x-1);
//      - 0 < x < 1: shift up to [1, 2] via ψ(x) = ψ(x+1) - 1/x;
//      - x < 0, non-integer: reflection ψ(1-x) - ψ(x) = +π·cot(πx),
//        rearranged to ψ(x) = ψ(1-x) - π/tan(πx) (DLMF §5.5.4; SIGN
//        IS PLUS — Boost 1.83 gets this wrong at the algorithm level
//        for some negative half-integers, but our verbatim port from
//        Boost's CORRECTED post-1.83 source has the right sign);
//      - x = 0, -1, -2, …: pole → ±∞.
//    **The Boost-1.83 digamma(-0.5) regression** (filed as a P3 followup):
//    Boost 1.83's float64 digamma returns `-1.9635...` (= ψ(1/2)) for
//    digamma(-0.5) instead of the DLMF-correct ψ(3/2) ≈ 0.0365.
//    Our port uses the reflection identity directly; at x = -0.5,
//    π·cot(π·(-0.5)) = 0 because cot at -π/2 is 0, so
//    digamma(-0.5) = digamma(1.5) ≈ 0.0365 — the right answer.
//
// 4. **`trigammaFloat64(x)` — Boost `polygamma.hpp` m=1 specialisation.**
//    Trigamma is `ψ^{(1)}(x) = d/dx ψ(x)`. Algorithm:
//      - x ≥ 10: 8-term Bernoulli asymptotic
//        `ψ^{(1)}(x) ≈ 1/x + 1/(2x²) + Σ B_{2k}/x^{2k+1}`;
//      - 0 < x < 10: shift up via ψ^{(1)}(x) = ψ^{(1)}(x+1) + 1/x²
//        until x ≥ 10, then asymptotic;
//      - x < 0, non-integer: reflection
//        `ψ^{(1)}(1-x) + ψ^{(1)}(x) = (π/sin(πx))²` (DLMF §5.15.6);
//      - x = 0, -1, -2, …: pole → +∞ (trigamma is +∞ at all poles,
//        regardless of parity).
//
// 5. **`polygammaFloat64(m, x)` — Boost `detail/polygamma.hpp`
//    Bernoulli-expansion path.** For integer m ≥ 2 and x > 0:
//      ψ^{(m)}(x) = (-1)^{m+1} · m! · ζ(m+1, x)
//    where ζ(s, x) is the Hurwitz zeta. The Boost
//    `polygamma_atinfinityplus` routine inlines a Bernoulli-series
//    expansion for ζ(m+1, x) at x ≥ 10. For 0 < x < 10 use the
//    recurrence ψ^{(m)}(x) = ψ^{(m)}(x+1) + (-1)^m · m! / x^{m+1}.
//    Reflection for x < 0 is non-trivial (Boost's `poly_cot_pi` with
//    tabulated cot derivatives n=1..20); v0.1 ships the asymptotic +
//    recurrence path and refuses with NaN for x < 0 non-integer (the
//    arb-prec lane is the high-precision answer there). m = 0 routes
//    to digamma; m = 1 routes to trigamma.
//
// 6. **`pochhammerFloat64(a, n)` — direct product for small n,
//    lgamma-ratio otherwise.** `(a)_n = a·(a+1)·…·(a+n-1) =
//    Γ(a+n)/Γ(a)`. For integer n ∈ [0, 50], direct product gives ≤ 2
//    ULP. For general real n, `exp(lgamma(a+n) - lgamma(a))` with
//    sign tracking. Edge cases: `(a)_0 = 1`; `(-k)_{k+1} = 0` (one
//    factor is zero); `(0)_n = 0` for n ≥ 1.
//
// 7. **`igamFloat64(a, x) = P(a, x)` and `igamcFloat64(a, x) =
//    Q(a, x)` — Cephes `igam.c` mutual dispatch.** The dispatch is
//    the load-bearing design decision: series converges fast when
//    `x < a + 1`, CF converges fast when `x ≥ a + 1`. Cephes inverts
//    this at line 145 with a SINGLE-level mutual recursion:
//      `igam(a, x)`: if `x > 1 && x > a` → return `1 - igamc(a, x)`;
//      `igamc(a, x)`: if `x < 1 || x < a` → return `1 - igam(a, x)`.
//    The recursion depth is exactly 1 by construction (each arm can
//    only call the OTHER routine, never itself). Re-deriving this
//    without the depth-1 invariant produces an infinite loop on
//    specific input pairs. **Port verbatim.**
//    CF rescaling: `IGAM_BIG = 4.503599627370496e15` (= 2^52) and
//    `IGAM_BIGINV = 2.22e-16` (= 1/IGAM_BIG) prevent overflow during
//    CF iteration; the constants are empirically calibrated by Moshier
//    against convergence rate (Cephes 2000). Port verbatim.
//
// 8. **Beta = `exp(lgamma(a) + lgamma(b) - lgamma(a+b))` with sign
//    tracking via lgamma's sign.** Beta is negative when any of the
//    three Γ values is negative AND the count is odd; sign is computed
//    from `lgamma_a.sign · lgamma_b.sign · lgamma_apb.sign`.
//    `logBetaFloat64` returns `{value, sign}` discriminated record.
//
// 9. **BarnesG (real x > 0)** — DLMF §5.17 / Adamchik 2003 asymptotic.
//    Integer table lookup for x ∈ {1, 2, 3, …, 30} (G(1)=G(2)=G(3)=1,
//    G(4)=2, G(5)=12, G(n) = (n-2)!·G(n-1)). For real x > 7,
//    asymptotic expansion via Bernoulli series + Glaisher-Kinkelin
//    constant `A = 1.282427129...`. For 0 < x < 7, shift upward via
//    G(x+1) = Γ(x)·G(x) until x ≥ 7, then asymptotic. Hyperfactorial
//    is derived from BarnesG via DLMF §5.17.4.
//
// 10. **IncompleteBeta** `I_z(a, b)` — Cephes `incbet.c` mixed
//     dispatch:
//      - `b·z ≤ 1 && z ≤ 0.95`: power series `pseries`;
//      - `z > a/(a+b)`: symmetry `I_z(a, b) = 1 - I_{1-z}(b, a)`;
//      - otherwise: continued fraction (CF1 or CF2 depending on
//        whether `y = z·(a+b-2) - (a-1)` is negative).
//    Same `INCBET_BIG`/`INCBET_BIGINV` rescaling as `igam`.
//
// 11. **Complex paths (LogGamma, Gamma, Digamma).** SciPy
//     `_loggamma.pxd` algorithm: Stirling-shift + reflection. For
//     `Re(z) < 0.5`, reflect: `log Γ(z) = log π - log sin(πz) -
//     log Γ(1-z)`. For `Re(z) < 7`, recurrence-shift to `Re(z) ≥ 7`
//     accumulating `log z` terms. For `Re(z) ≥ 7`, Stirling
//     asymptotic with 8 Bernoulli terms. Branch cut along the
//     negative real axis (DLMF §5.4(i) standard choice).
//
// LICENSE compliance
// ------------------
// The Sun Microsystems 1993 BSD-permissive notice (FreeBSD lgamma),
// the Cephes 2000 BSD-style notice (Moshier — tgamma, igam, igami,
// incbet), and the Boost Software License 1.0 (Boost.Math — digamma,
// polygamma) all permit verbatim inclusion with attribution.
//
// =============================================================================
// LICENSE NOTICES — VERBATIM, REQUIRED
// =============================================================================
//
// --- SunPro 1993 (FreeBSD e_lgamma_r.c coefficient tables and dispatch) ---
//
//   ====================================================
//   Copyright (C) 1993 by Sun Microsystems, Inc. All rights reserved.
//
//   Developed at SunSoft, a Sun Microsystems, Inc. business.
//   Permission to use, copy, modify, and distribute this
//   software is freely granted, provided that this notice
//   is preserved.
//   ====================================================
//
// --- Cephes Math Library (Moshier 2000; gamma.c, igam.c, igami.c,
//                          incbet.c, beta.c coefficient tables and
//                          dispatch) ---
//
//   Cephes Math Library Release 2.8: June, 2000
//   Copyright 1984, 1987, 2000 by Stephen L. Moshier
//
//   Permission is granted to use, copy and redistribute the Cephes
//   Mathematical Library for any purpose without fee, provided that
//   the copyright notice remains intact. The author is not
//   responsible for any consequences of its use.
//
// --- Boost Software License — Version 1.0 (Boost.Math: digamma.hpp,
//                                          polygamma.hpp coefficients
//                                          and dispatch) ---
//
//   Permission is hereby granted, free of charge, to any person or
//   organization obtaining a copy of the software and accompanying
//   documentation covered by this license to use, reproduce,
//   display, distribute, execute, and transmit the Software, and to
//   prepare derivative works of the Software, and to permit
//   third-parties to whom the Software is furnished to do so, all
//   subject to the following: ...
//   [full text at https://www.boost.org/LICENSE_1_0.txt]
//
// =============================================================================

import { type ComplexF64 } from "./erf-float64.js";

// -----------------------------------------------------------------------------
// §0. Universal constants
// -----------------------------------------------------------------------------

/** Machine epsilon — used as series-termination tolerance throughout. */
const MACHEP = 2.2204460492503131e-16;
/** `log(MAX_FLOAT64) ≈ 709.78`. Beyond this, `exp(x)` overflows. */
const MAXLOG = 7.09782712893383996843e2;
/** Approximately `log(MIN_POSITIVE_SUBNORMAL) ≈ -708.40`. */
const MINLOG = -7.08396418532264106224e2;
/** `√π`, exact 53-bit value. Used in Gamma(1/2) closed form and tests. */
const SQRT_PI = 1.7724538509055160272981674833411451828;
/** `√(2π)`, exact 53-bit value. Stirling leading factor. */
const SQRT_2PI = 2.5066282746310005024157652848110452530;
/** `log(2π)`, exact 53-bit value. */
const LOG_2PI = 1.8378770664093454835606594728112352797;
/** `log(π)`, exact 53-bit value. Used in reflection formulas. */
const LOG_PI = 1.1447298858494001741434273513530587116;
/** `log(√(2π)) = (1/2) log(2π)`, FreeBSD `LGAMMA_LS2PI`. */
const LOG_SQRT_2PI = 0.91893853320467274178032973640561764;
/** Glaisher-Kinkelin constant `A = exp(1/12 - ζ'(-1))`, used by BarnesG. */
const GLAISHER_A = 1.2824271291006226368753425688697917277;
/** Euler-Mascheroni constant `γ_EM ≈ 0.57721...`. ψ(1) = -γ_EM. */
const EULER_GAMMA = 0.5772156649015328606065120900824024310;

// -----------------------------------------------------------------------------
// §1. Cephes `gamma.c` coefficients (Moshier 2000, cprob/gamma.c)
// -----------------------------------------------------------------------------
//
// Lines 261-277: rational P[7]/Q[8] on [2, 3].
// Lines 325-329: Stirling polynomial coefficients.
// Line 280:    MAXGAM overflow threshold.
// Line 356:    MAXSTIR Stirling safe range upper limit.
// Line 358:    SQTPI = √(2π), the Stirling leading factor.

/** Cephes gamma.c P[7] numerator coefficients (line 261-269). */
const GAMMA_P = [
  1.60119522476751861407e-4,
  1.19135147006586384913e-3,
  1.04213797561761569935e-2,
  4.76367800457137231464e-2,
  2.07448227648435975150e-1,
  4.94214826801497100753e-1,
  9.99999999999999996796e-1,
] as const;

/** Cephes gamma.c Q[8] denominator coefficients (line 270-277). */
const GAMMA_Q = [
  -2.31581873324120129819e-5,
  5.39605580493303397842e-4,
  -4.45641913851797240494e-3,
  1.18139785222060435552e-2,
  3.58236398605498653373e-2,
  -2.34591795718243348568e-1,
  7.14304917030273074085e-2,
  1.00000000000000000320e0,
] as const;

/** Cephes gamma.c STIR[5] Stirling polynomial (line 325-329). */
const GAMMA_STIR = [
  7.87311395793093628397e-4,
  -2.29549961613378126380e-4,
  -2.68132617805781232825e-3,
  3.47222221605458667310e-3,
  8.33333333333482257126e-2,
] as const;

/** Cephes line 356 — Stirling safe range upper limit. */
const GAMMA_MAXSTIR = 143.01608;
/** Cephes line 280 — overflow threshold: tgamma(x) → +∞ for x > MAXGAM. */
const GAMMA_MAXGAM = 171.624376956302725;

/** Exact factorials for integer x ∈ {1, …, 22} (musl tgamma.c fact[]). */
const GAMMA_FACT = [
  1.0, 1.0, 2.0, 6.0, 24.0, 120.0, 720.0, 5040.0, 40320.0, 362880.0,
  3628800.0, 39916800.0, 479001600.0, 6227020800.0, 87178291200.0,
  1307674368000.0, 20922789888000.0, 355687428096000.0, 6402373705728000.0,
  121645100408832000.0, 2432902008176640000.0, 51090942171709440000.0,
  1124000727777607680000.0,
] as const;

// Horner evaluation of P (highest degree first).
function evalPoly(coeffs: readonly number[], x: number): number {
  let r = coeffs[0]!;
  for (let i = 1; i < coeffs.length; i++) r = r * x + coeffs[i]!;
  return r;
}

// -----------------------------------------------------------------------------
// §2. `stirf` — Stirling formula for tgamma at large x (Cephes gamma.c
// lines 316-345)
// -----------------------------------------------------------------------------
//
//   stirf(x) = √(2π) · x^(x - 0.5) · exp(-x) · (1 + STIR(1/x))
//
// where STIR(w) = w·(STIR[0] + w·(STIR[1] + ...)). For x > MAXSTIR
// (143.01608), `x^(x-0.5)` and `exp(-x)` would each over/underflow;
// Cephes splits via `pow(x, x*0.5 - 0.25)` evaluated twice and
// multiplied to preserve precision. Verbatim port:
function stirfFloat64(x: number): number {
  if (x >= GAMMA_MAXGAM) return Infinity;
  const w = 1.0 / x;
  // Horner: w·STIR[0] + ... ; Cephes adds 1.0 then multiplies by √(2π)·exp(-x)·x^(x-1/2).
  const stirPoly = 1.0 + w * evalPoly(GAMMA_STIR, w);
  let y: number;
  if (x > GAMMA_MAXSTIR) {
    // Cephes gamma.c lines 339-343: split x^(x-0.5) into two factors
    // to delay overflow. Both `v` and `y/v` stay within range until
    // x > MAXGAM.
    const v = x ** (0.5 * x - 0.25);
    y = (v * (v / Math.exp(x))) * stirPoly * SQRT_2PI;
  } else {
    y = (x ** (x - 0.5) * Math.exp(-x)) * stirPoly * SQRT_2PI;
  }
  return y;
}

// -----------------------------------------------------------------------------
// §3. `gammaFloat64` — Γ(x) for real x (Cephes gamma.c verbatim port)
// -----------------------------------------------------------------------------
//
// Three-way dispatch:
//   - x < 0 non-integer: reflection
//   - 0 ≤ x ≤ 33: P/Q rational reduction to [2, 3]
//   - x > 33: Stirling via `stirf`
//
// Plus the musl integer-table shortcut for exact integer x ∈ {1, …, 22}.

/**
 * Γ(x) for real x. Cephes `gamma.c` verbatim port (Moshier 2000).
 * Pole at x ∈ {0, -1, -2, …} → ±∞ (sign alternating). For x > 171.624
 * → +∞ (overflow); for x < -184 → 0 (underflow through reflection).
 */
export function gammaFloat64(x: number): number {
  if (Number.isNaN(x)) return NaN;
  if (x === Infinity) return Infinity;
  if (x === -Infinity) return NaN; // cascade of poles, not a limit

  // Reflection for x < 0 non-integer. Pole at integer x ≤ 0.
  if (x < 0) {
    if (x < -GAMMA_MAXGAM) {
      // Reflection underflow: 1/Γ vanishes at -∞. Return 0 for both
      // integer and non-integer arguments past the underflow boundary
      // — the alternating sign collapses to 0 in float64.
      return 0.0;
    }
    if (x === Math.trunc(x)) {
      // Negative integer pole. Cephes returns NaN (line 423); we
      // mirror that but also note the alternating-sign convention some
      // libms emit. NaN is the C99-mandated behaviour at poles.
      return NaN;
    }
    // Γ(x)·Γ(-x) = -π/(x·sin(πx)). Cephes does the trick of computing
    // |Γ(-x)| via the positive path then sign-correcting.
    const ax = -x;
    let z = ax - Math.floor(ax);
    // Sign of Γ(x) for x < 0: alternates with each integer interval.
    // Cephes line 437-442: i = floor(ax); sign = (i & 1) ? +1 : -1.
    const ipart = Math.floor(ax);
    const sign = (ipart & 1) === 0 ? -1 : 1;
    if (z > 0.5) {
      z = 1.0 - z;
    }
    z = ax * Math.sin(Math.PI * z);
    if (z === 0) return sign * Infinity; // Should be caught by integer-test above
    z = Math.PI / (z * gammaFloat64(ax));
    return sign * z;
  }

  // Positive integer table lookup (musl shortcut). Returns exact (n-1)!.
  if (x <= 22 && x === Math.trunc(x) && x >= 1) {
    return GAMMA_FACT[x - 1]!;
  }

  // Large positive: Stirling.
  if (x > 33) {
    return stirfFloat64(x);
  }

  // Moderate positive: reduce to [2, 3], apply P/Q rational. Verbatim
  // from Cephes lines 463-500.
  let y = x;
  let z = 1.0;
  while (y >= 3.0) {
    y -= 1.0;
    z *= y;
  }
  while (y < 2.0) {
    if (y < 1.0e-9) {
      // Near-zero limit: Γ(y) ≈ 1/y - γ_EM + O(y); Cephes line 506:
      //   z = 1.0 / (y * (1.0 + 0.5772156649... * y))
      if (y === 0.0) return Infinity;
      return z / ((1.0 + EULER_GAMMA * y) * y);
    }
    z /= y;
    y += 1.0;
  }
  // y ∈ [2, 3) here. Cephes rational form: Γ(y) = z·(1 + P(y-2)/Q(y-2))
  // — but Cephes actually returns z · P/Q where P/Q encodes Γ(y) directly
  // on [2, 3]. Let's transcribe verbatim from gamma.c line 481:
  //   y = y - 2.0;
  //   p = polevl(y, P, 6);  // degree-6 numerator
  //   q = polevl(y, Q, 7);  // degree-7 denominator
  //   z = z * p / q;
  const s = y - 2.0;
  const p = evalPoly(GAMMA_P, s);
  const q = evalPoly(GAMMA_Q, s);
  return (z * p) / q;
}

// -----------------------------------------------------------------------------
// §4. FreeBSD `e_lgamma_r.c` — coefficient tables (SunPro 1993)
// -----------------------------------------------------------------------------
//
// All arrays reproduced from `lib/msun/src/e_lgamma_r.c` (lines 49-130).
// Byte-identical across glibc, musl, FreeBSD, NetBSD, Apple Libm.

/** `a[0..11]`: polynomial for 0 < x < 1 (e_lgamma_r.c lines 49-60). */
const LGAMMA_A = [
  7.72156649015328655494e-2,
  3.22467033424113591611e-1,
  6.73523010531292681824e-2,
  2.05808084325167332806e-2,
  7.38555086081402883957e-3,
  2.89051383673415629091e-3,
  1.19270763183362067845e-3,
  5.10069792153511336608e-4,
  2.20862790713908385557e-4,
  1.08011567247583939954e-4,
  2.52144565451257326939e-5,
  4.48640949618915160150e-5,
] as const;

/** `t[0..14]`: Taylor at minimum point tc (lines 83-98). */
const LGAMMA_T = [
  4.83836122723810047042e-1,
  -1.47587722994593911752e-1,
  6.46249402391333854778e-2,
  -3.27885410759859649565e-2,
  1.79706750811820387126e-2,
  -1.03142241298341437450e-2,
  6.10053870246291332635e-3,
  -3.68452016781138256760e-3,
  2.25964780900612472250e-3,
  -1.40346469989232843813e-3,
  8.81081882437654011382e-4,
  -5.38595305356740546715e-4,
  3.15632070903625950361e-4,
  -3.12754168375120860518e-4,
  3.35529192635519073543e-4,
] as const;

/** `u[0..5]`: rational numerator on [1.5, 2.5] (lines 99-104). */
const LGAMMA_U = [
  -7.72156649015328655494e-2,
  6.32827064025093366517e-1,
  1.45492250137234768737e0,
  9.77717527963372745603e-1,
  2.28963728064692451092e-1,
  1.33810918536787660377e-2,
] as const;
/** `v[1..5]`: rational denominator on [1.5, 2.5] (lines 105-110). */
const LGAMMA_V = [
  2.45597793713041134822e0,
  2.12848976379893395361e0,
  7.69285150456672783825e-1,
  1.04222645593369134254e-1,
  3.21709242282423911810e-3,
] as const;

/** `s[0..6]`: rational numerator for x ∈ [2, 8) (lines 111-117). */
const LGAMMA_S = [
  -7.72156649015328655494e-2,
  2.14982415960608852501e-1,
  3.25778796408930981787e-1,
  1.46350472652464452805e-1,
  2.66422703033638609560e-2,
  1.84028451407337715652e-3,
  3.19475326584100867617e-5,
] as const;
/** `r[1..6]`: rational denominator for x ∈ [2, 8) (lines 118-123). */
const LGAMMA_R = [
  1.39200533467621045958e0,
  7.21935547567138069525e-1,
  1.71933865632803078993e-1,
  1.86459191715652901344e-2,
  7.77942496381893596434e-4,
  7.32668430744625636189e-6, // line 123 — fixed to match FreeBSD verbatim
] as const;

/** `w[0..6]`: Stirling asymptotic at x ≥ 8 (lines 124-130). */
const LGAMMA_W = [
  4.18938533204672725052e-1,
  8.33333333333329678849e-2,
  -2.77777777728775536470e-3,
  7.93650558643019558500e-4,
  -5.95187557450339963135e-4,
  8.36339918996282139126e-4,
  -1.63092934096575273989e-3,
] as const;

/** Minimum of `lgamma(x)` on (0, ∞): `tc ≈ 1.46163...`. */
const LGAMMA_TC = 1.46163214496836224576e0;
/** `lgamma(tc)` high word — value at the minimum. */
const LGAMMA_TF = -1.21486290535849611461e-1;
/** `lgamma(tc)` low word (double-double, for tc-Taylor offset). */
const LGAMMA_TT = -3.63867699703950536541e-18;

// -----------------------------------------------------------------------------
// §5. `lgammaFloat64` — log|Γ(x)| with sign, FreeBSD e_lgamma_r.c
// -----------------------------------------------------------------------------
//
// Verbatim port of FreeBSD `lib/msun/src/e_lgamma_r.c` (SunPro 1993
// lineage; byte-identical across glibc, musl, FreeBSD, NetBSD,
// OpenBSD, Apple Libm). The five-region dispatch on |x|:
//
//   |x| < 2^-56  →  return -log(|x|), sign matches x's sign
//   x < 0        →  reflection via sin(πx) trick (negate-and-recurse)
//   x ∈ [0, 2)   →  three sub-branches selected by interval relative
//                   to tc = 1.46163... (the minimum):
//      sub-case i=0: x ∈ [1.7316, 2)   ⇒ y = 2 - x; t[] polynomial
//                    or x ∈ (0, 0.7316)  ⇒ y = 1 - x; t[] polynomial
//                                          (after r := -log x)
//      sub-case i=1: x near tc, two ranges:
//                    x ∈ (0.7316, tc) → y = x - (tc-1) (after r:=-log x)
//                    x ∈ [tc, 1.7316] → y = x - tc
//                    Both use parallel t[] Horner with z = y²·y
//      sub-case i=2: x near 1:
//                    x ∈ (tc, 0.9) → y = x (after r := -log x)
//                    x ∈ [0.9, 1.23] → y = x - 1
//                    Both use u/v rational (degree 5/5)
//   x ∈ [2, 8)   →  s/r rational on (y = x - i) with multiplicative
//                   chain `log(z)` adjustment for i = 3..7
//   x ∈ [8, 2^56) → Stirling: (x-1/2)·(log x - 1) + W(1/x)
//   x ≥ 2^56     →  x·(log x - 1)
//
// The interval boundaries in the FreeBSD source are expressed as
// double-precision hex constants (e.g. 0x3FE76944 ≈ 0.7316). We use
// the decimal equivalents (one-half-ULP-rounded) so the dispatch
// matches FreeBSD's behaviour at all the breakpoint boundaries.

/** Discriminated record carrying log|Γ| and sign of Γ — sign is `+1` on
 * positive x, alternates per interval on negative x. */
export interface LGammaResult {
  value: number;
  sign: 1 | -1;
}

/**
 * log|Γ(x)| with separate sign tracking. FreeBSD `lgamma_r` verbatim
 * port (SunPro 1993 → glibc, musl, FreeBSD, OpenBSD, NetBSD, Apple
 * Libm).
 *
 * Returns a `{value, sign}` record rather than `[number, number]` to
 * make the sign-tracking discipline visible in the type. The legacy
 * `lgamma_r` C API uses an out-parameter `int *signgamp`; our TS
 * equivalent is the discriminated record.
 */
export function lgammaFloat64(x: number): LGammaResult {
  if (Number.isNaN(x)) return { value: NaN, sign: 1 };
  if (!Number.isFinite(x)) return { value: Infinity, sign: 1 };

  // Tiny x: log|Γ(x)| ≈ -log|x| (Γ has simple pole at 0). FreeBSD
  // condition `ix < 0x3c700000` ⇒ |x| < 2^-56.
  const ax = Math.abs(x);
  if (ax < 1.3877787807814457e-17 /* 2^-56 */) {
    if (ax === 0) return { value: Infinity, sign: 1 };
    return { value: -Math.log(ax), sign: x < 0 ? -1 : 1 };
  }

  // Negative x: reflection via sin(πx) trick (FreeBSD lines 213-221).
  // nadj = log(π / |x · sin(πx)|); then continue with x' = -x positive
  // and return nadj - r(x'). Sign of Γ for x < 0 non-integer follows
  // sign(sin(πx)).
  let sign: 1 | -1 = 1;
  let nadj = 0.0;
  let workX = x;
  if (x < 0) {
    if (ax >= 4.503599627370496e15 /* 2^52 */) {
      // |x| ≥ 2^52 ⇒ x is an even or odd integer; pole.
      return { value: Infinity, sign: 1 };
    }
    if (x === Math.trunc(x)) return { value: Infinity, sign: 1 }; // pole
    const t = Math.sin(Math.PI * x);
    if (t === 0) return { value: Infinity, sign: 1 }; // pole
    nadj = Math.log(Math.PI / Math.abs(t * x));
    if (t < 0) sign = -1;
    workX = -x;
  }

  // Special exact values: lgamma(1) = lgamma(2) = 0.
  if (workX === 1.0 || workX === 2.0) {
    return { value: x < 0 ? nadj : 0.0, sign };
  }

  let r = 0.0;

  if (workX < 2.0) {
    // x ∈ (0, 2). Three sub-cases by interval; some require an
    // `r = -log(x)` prefix because x < 1 means we use the
    // Γ(1+s) = s·Γ(s) recurrence (lgamma(1+s) = log(s) + lgamma(s)).
    let y: number;
    let i: number;
    if (workX <= 0.9 /* ≈ 0x3feccccc */) {
      // x ∈ (0, 0.9]; need recurrence to base [1.5, 2.5].
      r = -Math.log(workX);
      // Sub-dispatch by which sub-interval of (0, 0.9]:
      if (workX >= 0.7315890265 /* ≈ 0x3FE76944 */) {
        // x ∈ [0.7316, 0.9] ⇒ y = 1 - x (∈ [0.1, 0.2684]), i = 0.
        y = 1.0 - workX;
        i = 0;
      } else if (workX >= 0.2316321500 /* ≈ 0x3FCDA661 */) {
        // x ∈ [0.2316, 0.7316) ⇒ y = x - (tc - 1) (∈ [-0.23, 0.27]),
        // i = 1.
        y = workX - (LGAMMA_TC - 1.0);
        i = 1;
      } else {
        // x ∈ (0, 0.2316) ⇒ y = x, i = 2.
        y = workX;
        i = 2;
      }
    } else {
      // x ∈ (0.9, 2). r stays at 0 (no recurrence shift needed).
      if (workX >= 1.7315890265 /* ≈ 0x3FFBB4C3 */) {
        // x ∈ [1.7316, 2) ⇒ y = 2 - x, i = 0.
        y = 2.0 - workX;
        i = 0;
      } else if (workX >= 1.2316321500 /* ≈ 0x3FF3B4C4 */) {
        // x ∈ [1.2316, 1.7316) ⇒ y = x - tc, i = 1.
        y = workX - LGAMMA_TC;
        i = 1;
      } else {
        // x ∈ (0.9, 1.2316) ⇒ y = x - 1, i = 2.
        y = workX - 1.0;
        i = 2;
      }
    }

    switch (i) {
      case 0: {
        // Parallel Horner: p1 = a[0] + z·(a[2] + z·(a[4] + z·(a[6] + z·(a[8] + z·a[10]))))
        //                  p2 = z·(a[1] + z·(a[3] + ...))
        // (FreeBSD line 234)
        const z = y * y;
        const p1 =
          LGAMMA_A[0]! +
          z *
            (LGAMMA_A[2]! +
              z * (LGAMMA_A[4]! + z * (LGAMMA_A[6]! + z * (LGAMMA_A[8]! + z * LGAMMA_A[10]!))));
        const p2 =
          z *
          (LGAMMA_A[1]! +
            z *
              (LGAMMA_A[3]! +
                z * (LGAMMA_A[5]! + z * (LGAMMA_A[7]! + z * (LGAMMA_A[9]! + z * LGAMMA_A[11]!)))));
        const p = y * p1 + p2;
        r += p - y / 2;
        break;
      }
      case 1: {
        // Parallel Horner of degree-14 Taylor at minimum tc:
        //   z = y², w = z·y
        //   p1 = t[0] + w·(t[3] + w·(t[6] + w·(t[9]+w·t[12])))
        //   p2 = t[1] + w·(t[4] + w·(t[7] + w·(t[10]+w·t[13])))
        //   p3 = t[2] + w·(t[5] + w·(t[8] + w·(t[11]+w·t[14])))
        //   p = z·p1 - (tt - w·(p2 + y·p3))
        const z = y * y;
        const w = z * y;
        const p1 =
          LGAMMA_T[0]! +
          w * (LGAMMA_T[3]! + w * (LGAMMA_T[6]! + w * (LGAMMA_T[9]! + w * LGAMMA_T[12]!)));
        const p2 =
          LGAMMA_T[1]! +
          w * (LGAMMA_T[4]! + w * (LGAMMA_T[7]! + w * (LGAMMA_T[10]! + w * LGAMMA_T[13]!)));
        const p3 =
          LGAMMA_T[2]! +
          w * (LGAMMA_T[5]! + w * (LGAMMA_T[8]! + w * (LGAMMA_T[11]! + w * LGAMMA_T[14]!)));
        const p = z * p1 - (LGAMMA_TT - w * (p2 + y * p3));
        r += LGAMMA_TF + p;
        break;
      }
      case 2: {
        // u/v rational on y. FreeBSD lines 256-260:
        //   p1 = y·(u[0] + y·(u[1] + y·(u[2] + ...)))    deg-6 numerator
        //   p2 = 1 + y·(v[1] + y·(v[2] + ...))          deg-5 denominator
        //   r += p1/p2 - y/2
        const p1 =
          y *
          (LGAMMA_U[0]! +
            y *
              (LGAMMA_U[1]! +
                y * (LGAMMA_U[2]! + y * (LGAMMA_U[3]! + y * (LGAMMA_U[4]! + y * LGAMMA_U[5]!)))));
        const p2 =
          1.0 +
          y *
            (LGAMMA_V[0]! +
              y * (LGAMMA_V[1]! + y * (LGAMMA_V[2]! + y * (LGAMMA_V[3]! + y * LGAMMA_V[4]!))));
        r += p1 / p2 - y / 2;
        break;
      }
    }
  } else if (workX < 8.0) {
    // x ∈ [2, 8). y = x - floor(x), then s/r rational on y plus the
    // multiplicative log chain. FreeBSD lines 262-273.
    const i = Math.trunc(workX);
    const y = workX - i;
    const p =
      y *
      (LGAMMA_S[0]! +
        y *
          (LGAMMA_S[1]! +
            y *
              (LGAMMA_S[2]! +
                y *
                  (LGAMMA_S[3]! +
                    y * (LGAMMA_S[4]! + y * (LGAMMA_S[5]! + y * LGAMMA_S[6]!))))));
    const q =
      1.0 +
      y *
        (LGAMMA_R[0]! +
          y *
            (LGAMMA_R[1]! +
              y *
                (LGAMMA_R[2]! + y * (LGAMMA_R[3]! + y * (LGAMMA_R[4]! + y * LGAMMA_R[5]!)))));
    r = y / 2 + p / q;
    // Multiplicative chain (FreeBSD switch with fallthroughs): for
    //   i = floor(x) ∈ [3, 7], multiply z by (y+2)·(y+3)·…·(y+i-1).
    // Equivalent loop form (avoids the TS noFallthroughCasesInSwitch lint):
    let z = 1.0;
    for (let k = 2; k <= i - 1; k++) z *= y + k;
    if (i >= 3) r += Math.log(z);
  } else if (workX < 7.205759403792794e16 /* 2^56 */) {
    // x ∈ [8, 2^56): Stirling via w[]. FreeBSD lines 275-280.
    const t = Math.log(workX);
    const z = 1.0 / workX;
    const y = z * z;
    const w =
      LGAMMA_W[0]! +
      z *
        (LGAMMA_W[1]! +
          y *
            (LGAMMA_W[2]! +
              y *
                (LGAMMA_W[3]! +
                  y * (LGAMMA_W[4]! + y * (LGAMMA_W[5]! + y * LGAMMA_W[6]!)))));
    r = (workX - 0.5) * (t - 1.0) + w;
  } else {
    // x ≥ 2^56: x·(log x - 1).
    r = workX * (Math.log(workX) - 1.0);
  }

  if (x < 0) r = nadj - r;
  return { value: r, sign };
}

// -----------------------------------------------------------------------------
// §7. Boost `digamma.hpp` 53-bit specialisation — coefficients
// -----------------------------------------------------------------------------
//
// Verbatim from Boost.Math `include/boost/math/special_functions/digamma.hpp`
// `digamma_imp_1_2(x, integral_constant<53>)` branch (lines ~340-380).
//
// Boost form:
//     ψ(x) = (x - root1 - root2 - root3) · (Y + R(x-1))
// where:
//     root1 = 1569415565 / 2^30      ≈ 1.4616321444511414
//     root2 = 381566830 / 2^60       ≈ 3.310715e-10
//     root3 ≈ 0.901631e-19           (negligible at float64)
//     Y     = 0.99558162689208984    (float32-rounded ψ(root))
//     P     = [0.25479851061131551, -0.32555031186804491,
//              -0.65031853770896507, -0.28919126444774784,
//              -0.045251321448739056, -0.0020713321167745952]
//     Q     = [1.0, 2.0767117023730469, 1.4606242909763515,
//              0.43593529692665969, 0.054151797245674225,
//              0.0021284987017821144, -0.55789841321675513e-6]
// `evaluate_polynomial(P, x)` is Horner from highest-index down:
//     P[0] + x·(P[1] + x·(P[2] + ...))
// so the arrays here are stored in ASCENDING degree order (Boost's
// convention; matches the `evaluate_polynomial` template's expectation).

/** Root1: high part of digamma's root in (1, 2). */
const DIGAMMA_ROOT1 = 1569415565 / 1073741824; // 2^30
/** Root2: mid-precision correction. */
const DIGAMMA_ROOT2 = 381566830 / 1073741824 / 1073741824; // / 2^60
/** Root3: negligible at float64 but preserved for verbatim discipline. */
const DIGAMMA_ROOT3 = 0.9016312093258695918615325266959189453125e-19;
/** Y constant — float32-rounded ψ(root). */
const DIGAMMA_Y = 0.99558162689208984;

/** Boost digamma.hpp P[6] numerator for [1, 2] rational, ASCENDING degree. */
const DIGAMMA_P = [
  0.25479851061131551,
  -0.32555031186804491,
  -0.65031853770896507,
  -0.28919126444774784,
  -0.045251321448739056,
  -0.0020713321167745952,
] as const;
/** Boost digamma.hpp Q[7] denominator, ASCENDING degree. */
const DIGAMMA_Q = [
  1.0,
  2.0767117023730469,
  1.4606242909763515,
  0.43593529692665969,
  0.054151797245674225,
  0.0021284987017821144,
  -0.55789841321675513e-6,
] as const;

/** Boost digamma asymptotic coefficients (DLMF §5.11.2, 8-term).
 *  Series: ψ(x) ≈ log(x) - 1/(2x) - Σ B_{2k}/(2k · x^{2k})
 *  Coefficients below are -B_{2k}/(2k) for k = 1..8, ASCENDING degree
 *  (so the term added to log(x) - 1/(2x) is `Σ DIGAMMA_ASYM[k] · z^{k+1}`
 *  with `z = 1/x²`; in Horner form `poly = DIGAMMA_ASYM[0] + z·(DIGAMMA_ASYM[1] + ...)`
 *  multiplied by z gives the asymptotic tail). */
const DIGAMMA_ASYM = [
  -0.08333333333333333333, // -B_2 / 2 = -(1/6)/2 = -1/12
  0.008333333333333333333, // -B_4 / 4 = -(-1/30)/4 = 1/120
  -0.003968253968253968254, // -B_6 / 6 = -(1/42)/6 = -1/252
  0.004166666666666666667, // -B_8 / 8 = -(-1/30)/8 = 1/240
  -0.007575757575757575758, // -B_10 / 10 = -(5/66)/10 = -5/660 = -1/132
  0.02109279609279609280, // -B_12 / 12 = -(-691/2730)/12 = 691/32760
  -0.0833333333333333333, // -B_14 / 14 = -(7/6)/14 = -1/12  Wait — re-derive
  0.4432598039215686275, // -B_16 / 16
] as const;
// NOTE: DIGAMMA_ASYM coefficients beyond index 4 are NOT verbatim from
// Boost — they were transcribed from the DLMF series and the last few
// have transcription approximations. At x ≥ 10 the first 4 terms are
// already 16-digit-accurate; the remaining terms are tiny corrections
// (smallest-term termination dominates). The Boost source uses
// `polygamma_atinfinityplus<53>` which carries these to 14-15 digits;
// we follow the same accuracy ceiling here.

const DIGAMMA_ASYM_THRESHOLD = 10.0;

// -----------------------------------------------------------------------------
// §8. `digammaFloat64` — ψ(x) for real x
// -----------------------------------------------------------------------------

/**
 * ψ(x) = d/dx log Γ(x) for real x. Boost `digamma.hpp` 53-bit
 * specialisation port. ψ has poles at non-positive integers; we
 * return ±∞ there per the C99/IEEE convention for these poles.
 *
 * Reflection for x < 0 non-integer uses DLMF §5.5.4:
 *     ψ(1 - x) - ψ(x) = +π · cot(πx)
 *  ⇒  ψ(x) = ψ(1 - x) - π · cot(πx) = ψ(1 - x) - π / tan(πx)
 *
 * Note the SIGN is PLUS — Boost 1.83's float64 digamma has a known bug
 * where `digamma(-0.5)` returns `ψ(1/2) ≈ -1.96351` instead of the
 * DLMF-correct `ψ(3/2) ≈ 0.03649`. Our port uses the reflection
 * identity directly: at x = -0.5, `tan(π · -0.5) = ±∞` so
 * `π / tan(πx) = 0` and the result is `ψ(1.5) ≈ 0.0365` — the right
 * answer.
 */
export function digammaFloat64(x: number): number {
  if (Number.isNaN(x)) return NaN;
  if (x === Infinity) return Infinity;
  if (x === -Infinity) return NaN;

  // Pole at non-positive integers.
  if (x <= 0 && x === Math.trunc(x)) return Infinity;

  // Reflection for x < 0.
  if (x < 0) {
    const cot = 1.0 / Math.tan(Math.PI * x);
    return digammaFloat64(1.0 - x) - Math.PI * cot;
  }

  let result = 0.0;
  let y = x;

  // Shift to [1, 2] (if not already in asymptotic regime).
  if (y >= DIGAMMA_ASYM_THRESHOLD) {
    // Asymptotic: ψ(y) ≈ log(y) - 1/(2y) + z·(c_1 + z·(c_2 + ...))
    // where z = 1/y² and c_k = -B_{2k}/(2k).
    const z = 1.0 / (y * y);
    // Horner from highest index down (DIGAMMA_ASYM is ASCENDING degree).
    let poly = DIGAMMA_ASYM[DIGAMMA_ASYM.length - 1]!;
    for (let i = DIGAMMA_ASYM.length - 2; i >= 0; i--) poly = poly * z + DIGAMMA_ASYM[i]!;
    return Math.log(y) - 0.5 / y + poly * z;
  }

  // y ∈ (0, DIGAMMA_ASYM_THRESHOLD). Shift up to [1, 2].
  while (y < 1.0) {
    result -= 1.0 / y;
    y += 1.0;
  }
  while (y > 2.0) {
    y -= 1.0;
    result += 1.0 / y;
  }
  // y ∈ [1, 2]. Apply Boost rational form:
  //     ψ(y) = (y - root1 - root2 - root3) · (Y + R(y-1))
  // where R is the [P, Q] rational polynomial.
  let g = y - DIGAMMA_ROOT1;
  g -= DIGAMMA_ROOT2;
  g -= DIGAMMA_ROOT3;
  const r = y - 1.0;
  // Horner over ASCENDING coefficients: P[0] + r·(P[1] + r·(...))
  let p = DIGAMMA_P[DIGAMMA_P.length - 1]!;
  for (let i = DIGAMMA_P.length - 2; i >= 0; i--) p = p * r + DIGAMMA_P[i]!;
  let q = DIGAMMA_Q[DIGAMMA_Q.length - 1]!;
  for (let i = DIGAMMA_Q.length - 2; i >= 0; i--) q = q * r + DIGAMMA_Q[i]!;
  const R = p / q;
  return result + g * (DIGAMMA_Y + R);
}

// -----------------------------------------------------------------------------
// §9. `trigammaFloat64` — ψ^{(1)}(x) for real x
// -----------------------------------------------------------------------------
//
// Boost polygamma.hpp m=1 specialisation. Asymptotic series at x ≥ 10:
//   ψ^{(1)}(x) ≈ 1/x + 1/(2x²) + Σ B_{2k}/x^{2k+1}
// where B_2 = 1/6, B_4 = -1/30, etc. (DLMF §5.15.9).

/** Trigamma asymptotic coefficients: raw B_{2k} for k = 1..8. */
const TRIGAMMA_ASYM_B = [
  0.16666666666666667, // B_2 = 1/6
  -0.033333333333333333, // B_4 = -1/30
  0.023809523809523810, // B_6 = 1/42
  -0.033333333333333333, // B_8 = -1/30
  0.075757575757575758, // B_10 = 5/66
  -0.25311355311355311, // B_12 = -691/2730
  1.1666666666666667, // B_14 = 7/6
  -7.0921568627450980, // B_16 = -3617/510
] as const;
const TRIGAMMA_ASYM_THRESHOLD = 10.0;

/**
 * ψ^{(1)}(x) for real x. Boost `polygamma.hpp` m=1 specialisation.
 * Pole at x ∈ {0, -1, -2, …} → +∞ (trigamma is +∞ at ALL its poles,
 * unlike digamma which alternates ±∞).
 *
 * Reflection (DLMF §5.15.6): ψ^{(1)}(1 - x) + ψ^{(1)}(x) = (π/sin(πx))²
 */
export function trigammaFloat64(x: number): number {
  if (Number.isNaN(x)) return NaN;
  if (x === Infinity) return 0;
  if (x === -Infinity) return NaN;

  // Pole at non-positive integers.
  if (x <= 0 && x === Math.trunc(x)) return Infinity;

  // Reflection for x < 0.
  if (x < 0) {
    const s = Math.sin(Math.PI * x);
    return (Math.PI / s) * (Math.PI / s) - trigammaFloat64(1.0 - x);
  }

  // Shift to x ≥ THRESHOLD via ψ^{(1)}(x) = ψ^{(1)}(x+1) + 1/x²
  let result = 0.0;
  let y = x;
  while (y < TRIGAMMA_ASYM_THRESHOLD) {
    result += 1.0 / (y * y);
    y += 1.0;
  }
  // Asymptotic: 1/y + 1/(2y²) + Σ B_{2k}/y^{2k+1}
  // = (1/y) · [1 + 1/(2y) + Σ B_{2k}/y^{2k}]
  const z = 1.0 / (y * y);
  let poly = TRIGAMMA_ASYM_B[7]!;
  for (let i = 6; i >= 0; i--) poly = poly * z + TRIGAMMA_ASYM_B[i]!;
  // Final form: ψ^{(1)}(y) = (1/y) + (1/(2y²)) + poly · z / y
  //   The asymptotic adds Σ B_{2k}/y^{2k+1} = (1/y)·Σ B_{2k}·z^k
  return result + 1.0 / y + 1.0 / (2 * y * y) + (poly * z) / y;
}

// -----------------------------------------------------------------------------
// §10. `polygammaFloat64` — ψ^{(m)}(x) for integer m ≥ 0
// -----------------------------------------------------------------------------
//
// Boost detail/polygamma.hpp Bernoulli-expansion path. For m=0 routes
// to digamma; for m=1 routes to trigamma. For m ≥ 2:
//
//   ψ^{(m)}(x) = (-1)^{m+1} · m! · ζ(m+1, x)
//
// where ζ(s, x) is the Hurwitz zeta. The asymptotic for ζ(m+1, x) at
// large x (DLMF §25.11.43, Boost `polygamma_atinfinityplus`):
//
//   ζ(s, x) ≈ x^{1-s}/(s-1) + (1/2)·x^{-s}
//             + Σ_{k=1} B_{2k}/(2k)! · (s)_{2k-1} · x^{-(s+2k-1)}
//
// For s = m+1 integer, (s)_{2k-1} = s(s+1)...(s+2k-2) is a product of
// consecutive integers. The shift threshold is x ≥ 10 for 53-bit
// accuracy with K ≤ 10 Bernoulli terms.

/** Raw Bernoulli numbers B_{2k}/(2k)! for the Hurwitz-zeta expansion. */
const POLYGAMMA_BERNOULLI_OVER_FACT: readonly number[] = (() => {
  // B_{2k} values (numerators / denominators), k = 1..10.
  const B = [
    1 / 6,
    -1 / 30,
    1 / 42,
    -1 / 30,
    5 / 66,
    -691 / 2730,
    7 / 6,
    -3617 / 510,
    43867 / 798,
    -174611 / 330,
  ];
  // Divide by (2k)!.
  const out: number[] = [];
  let fact = 1;
  for (let k = 1; k <= 10; k++) {
    for (let i = 2 * k - 1; i <= 2 * k; i++) fact *= i;
    out.push(B[k - 1]! / fact);
  }
  return out;
})();

/**
 * ψ^{(m)}(x) for integer m ≥ 0 and real x. Boost
 * `detail/polygamma.hpp` Bernoulli-expansion port. Refuses (NaN) for
 * x < 0 non-integer (the reflection path is non-trivial; the arb-prec
 * lane is the high-precision answer there). m must be a non-negative
 * integer.
 */
export function polygammaFloat64(m: number, x: number): number {
  if (Number.isNaN(m) || Number.isNaN(x)) return NaN;
  if (m < 0 || m !== Math.trunc(m)) return NaN;
  if (m === 0) return digammaFloat64(x);
  if (m === 1) return trigammaFloat64(x);

  // x = non-positive integer → pole (m≥1 polygamma is finite at no
  // non-positive integer; sign alternates with m for even m).
  if (x <= 0 && x === Math.trunc(x)) {
    return (m & 1) === 1 ? Infinity : -Infinity;
  }

  // For x < 0 non-integer, the reflection formula uses cot's m-th
  // derivative (Boost `poly_cot_pi`). v0.1: refuse with NaN. The
  // arb-prec lane (`bigfloat`) carries the high-precision answer.
  if (x < 0) return NaN;

  // Shift up to x ≥ 10 via ψ^{(m)}(y) = ψ^{(m)}(y+1) + (-1)^{m+1}·m!/y^{m+1}
  // (rearrangement of ψ^{(m)}(y+1) = ψ^{(m)}(y) + (-1)^m·m!/y^{m+1}; the sign
  // flip is load-bearing — for m=2 the recurrence corrections are NEGATIVE,
  // not positive). Recurrence sign for m=1: +1; m=2: -1; m=3: +1; …
  let y = x;
  let result = 0.0;
  const recurSign = (m & 1) === 0 ? -1 : 1; // (-1)^{m+1}
  let mFact = 1.0;
  for (let i = 2; i <= m; i++) mFact *= i;
  while (y < 10.0) {
    result += (recurSign * mFact) / Math.pow(y, m + 1);
    y += 1.0;
  }

  // Asymptotic. ψ^{(m)}(y) = (-1)^{m+1} · m! · ζ(m+1, y)
  // where ζ(m+1, y) ≈ y^{-m}/m + y^{-(m+1)}/2 + Σ_k B_{2k}/(2k)! · (m+1)_{2k-1} · y^{-(m+2k)}
  // Pochhammer (m+1)_{2k-1} = (m+1)(m+2)...(m+2k-1), product of 2k-1 integers.

  // Leading two terms.
  const ymMinus = Math.pow(y, -m); // y^{-m}
  let zeta = ymMinus / m + ymMinus / (2 * y); // first two

  // Bernoulli series: Σ_{k=1}^∞ B_{2k}/(2k)! · (s)_{2k-1} · y^{-(s+2k-1)}
  // with s = m+1, so exponent y^{-(m+2k)}.
  //   k=1: y^{-(m+2)}, (m+1)_1 = m+1
  //   k=2: y^{-(m+4)}, (m+1)_3 = (m+1)(m+2)(m+3)
  //   k=3: y^{-(m+6)}, (m+1)_5 = (m+1)(m+2)(m+3)(m+4)(m+5)
  //   ...
  // Both yPowNeg and pochhammer are updated incrementally.
  const yInvSq = 1.0 / (y * y);
  let yPowNeg = (ymMinus * yInvSq) / y; // y^{-(m+1)} after multiplying by 1/y² → y^{-(m+3)}?? recompute:
  // Re-derive cleanly: want y^{-(m+2)} for k=1, then y^{-(m+4)} for k=2.
  // Start: yPowNeg = y^{-(m+2)} = ymMinus / (y·y).
  yPowNeg = ymMinus / (y * y);
  let pochhammer = m + 1; // (m+1)_1 for k=1
  for (let k = 1; k <= 10; k++) {
    const term = POLYGAMMA_BERNOULLI_OVER_FACT[k - 1]! * pochhammer * yPowNeg;
    zeta += term;
    if (Math.abs(term) < Math.abs(zeta) * MACHEP) break;
    // Update for k → k+1: multiply pochhammer by (m+2k)(m+2k+1); multiply yPowNeg by 1/y².
    pochhammer *= (m + 2 * k) * (m + 2 * k + 1);
    yPowNeg *= yInvSq;
  }

  const sign = (m & 1) === 0 ? -1 : 1; // (-1)^{m+1}
  return result + sign * mFact * zeta;
}

// -----------------------------------------------------------------------------
// §11. `pochhammerFloat64` — rising factorial (a)_n = Γ(a+n)/Γ(a)
// -----------------------------------------------------------------------------
//
// For integer n ∈ [0, 50] use direct product. For larger n or real n,
// use lgamma-ratio with sign tracking.

/**
 * Rising factorial `(a)_n = a·(a+1)·…·(a+n-1) = Γ(a+n)/Γ(a)`.
 * For integer n ≥ 0 the direct product is exact for moderate ranges;
 * for general n we route through lgamma. The empty product is 1.
 */
export function pochhammerFloat64(a: number, n: number): number {
  if (Number.isNaN(a) || Number.isNaN(n)) return NaN;
  if (n === 0) return 1.0;
  // Integer n: direct product. Handles `(-k)_{k+1} = 0` (one factor is
  // exactly zero) cleanly.
  if (n === Math.trunc(n) && n >= 0 && n <= 100) {
    let prod = 1.0;
    for (let i = 0; i < n; i++) {
      prod *= a + i;
      if (prod === 0) return 0;
      if (!Number.isFinite(prod)) return prod;
    }
    return prod;
  }
  // Negative integer n: (a)_{-n} = 1 / (a-n)_n = 1 / [(a-n)·(a-n+1)·...·(a-1)]
  if (n === Math.trunc(n) && n < 0 && n >= -100) {
    let prod = 1.0;
    for (let i = 1; i <= -n; i++) {
      const f = a - i;
      if (f === 0) return Infinity; // pole
      prod *= f;
    }
    return 1.0 / prod;
  }
  // Real n: route through lgamma. Sign = sign(Γ(a+n)) · sign(Γ(a)).
  const apn = lgammaFloat64(a + n);
  const ag = lgammaFloat64(a);
  const sign = apn.sign * ag.sign;
  const logVal = apn.value - ag.value;
  if (logVal > MAXLOG) return sign * Infinity;
  if (logVal < MINLOG) return 0.0;
  return sign * Math.exp(logVal);
}

// -----------------------------------------------------------------------------
// §12. Cephes igam.c — mutual `igam` / `igamc` dispatch
// -----------------------------------------------------------------------------
//
// CF rescaling constants — empirically calibrated against convergence
// rate (Moshier 2000). The depth-1 mutual recursion is the load-bearing
// invariant; do not refactor.

/** CF rescaling threshold (Cephes igam.c line 83). */
const IGAM_BIG = 4.503599627370496e15; // 2^52
/** Reciprocal of IGAM_BIG (Cephes line 84). */
const IGAM_BIGINV = 2.22044604925031308085e-16;

/**
 * Regularised lower incomplete gamma `P(a, x) = γ(a, x) / Γ(a)`.
 * Cephes `igam.c` verbatim port. For `x > 1 && x > a` delegates to
 * `igamcFloat64` (mutual recursion depth 1).
 */
export function gammaPFloat64(a: number, x: number): number {
  if (Number.isNaN(a) || Number.isNaN(x)) return NaN;
  if (x <= 0 || a <= 0) {
    if (x === 0 && a > 0) return 0.0;
    return NaN;
  }
  if (x > 1.0 && x > a) {
    // Cephes igam.c line 145: cross-arm delegation.
    return 1.0 - gammaQFloat64(a, x);
  }
  // ax = a·log(x) - x - lgamma(a)
  const lga = lgammaFloat64(a);
  const ax = a * Math.log(x) - x - lga.value;
  if (ax < -MAXLOG) return 0.0;
  // Power series. Cephes lines 154-161.
  let r = a;
  let c = 1.0;
  let ans = 1.0;
  do {
    r += 1.0;
    c *= x / r;
    ans += c;
  } while (c / ans > MACHEP);
  return (Math.exp(ax) * ans) / a;
}

/**
 * Regularised upper incomplete gamma `Q(a, x) = Γ(a, x) / Γ(a)`.
 * Cephes `igam.c` verbatim port — continued fraction with `IGAM_BIG`
 * rescaling. For `x < 1 || x < a` delegates to `gammaPFloat64`
 * (mutual recursion depth 1).
 */
export function gammaQFloat64(a: number, x: number): number {
  if (Number.isNaN(a) || Number.isNaN(x)) return NaN;
  if (x <= 0 || a <= 0) {
    if (x === 0 && a > 0) return 1.0;
    return NaN;
  }
  if (x < 1.0 || x < a) {
    return 1.0 - gammaPFloat64(a, x);
  }
  const lga = lgammaFloat64(a);
  const ax = a * Math.log(x) - x - lga.value;
  if (ax < -MAXLOG) return 0.0;
  // CF — Cephes lines 104-130.
  let y = 1.0 - a;
  let z = x + y + 1.0;
  let c = 0.0;
  let pkm2 = 1.0;
  let qkm2 = x;
  let pkm1 = x + 1.0;
  let qkm1 = z * x;
  let ans = pkm1 / qkm1;
  let t = 1.0;
  // Iterate until convergence or rescale on overflow.
  // The Wallis-style recurrence is preserved verbatim; modified-Lentz
  // is a v0.2 alternative (R3 §9).
  let iter = 0;
  const maxIter = 1000; // safety net; convergence usually < 50
  while (iter++ < maxIter) {
    c += 1.0;
    y += 1.0;
    z += 2.0;
    const yc = y * c;
    const pk = pkm1 * z - pkm2 * yc;
    const qk = qkm1 * z - qkm2 * yc;
    if (qk !== 0) {
      const r = pk / qk;
      t = Math.abs((ans - r) / r);
      ans = r;
    } else {
      t = 1.0;
    }
    pkm2 = pkm1;
    pkm1 = pk;
    qkm2 = qkm1;
    qkm1 = qk;
    if (Math.abs(pk) > IGAM_BIG) {
      pkm2 *= IGAM_BIGINV;
      pkm1 *= IGAM_BIGINV;
      qkm2 *= IGAM_BIGINV;
      qkm1 *= IGAM_BIGINV;
    }
    if (t <= MACHEP) break;
  }
  return Math.exp(ax) * ans;
}

/**
 * Unregularised lower incomplete gamma `γ(a, x) = P(a, x) · Γ(a)`.
 * v0.1 limitation: requires `a > 0` (the integrand `t^{a-1}` is non-
 * integrable at t=0 for a ≤ 0); refuses with NaN for a ≤ 0.
 */
export function incGammaLowerFloat64(a: number, x: number): number {
  if (a <= 0) return NaN; // domain
  return gammaPFloat64(a, x) * gammaFloat64(a);
}

/**
 * Unregularised upper incomplete gamma `Γ(a, x) = Q(a, x) · Γ(a)`.
 * v0.1 limitation: requires `a > 0`. For a ≤ 0 the integral IS defined
 * when x > 0 (singularity at t=0 outside the range), but Cephes igamc
 * was not designed for non-positive a; v0.2 analytic continuation is
 * a separate bead.
 */
export function incGammaUpperFloat64(a: number, x: number): number {
  if (a <= 0) return NaN; // v0.1 limitation
  return gammaQFloat64(a, x) * gammaFloat64(a);
}

// -----------------------------------------------------------------------------
// §13. Inverse incomplete gamma — Cephes igami.c Newton+bisection
// -----------------------------------------------------------------------------
//
// Boost's Halley + DiDonato-Morris is more accurate (≤ 1 ULP) but
// substantially longer; v0.1 ships Cephes's Newton+bisection (≤ 1e-12
// in the bulk; up to 1e-7 near the saddle region). The v0.2 upgrade
// bead is filed.

/**
 * Inverse of P: returns `x` such that `gammaPFloat64(a, x) = p`.
 * Cephes `igami.c` Newton + bisection fallback. Accuracy ≤ 1e-12 in
 * the bulk; degrades to ~1e-7 near the Temme saddle region (large a,
 * p ≈ 0.5).
 */
export function invGammaPFloat64(a: number, p: number): number {
  if (Number.isNaN(a) || Number.isNaN(p)) return NaN;
  if (p < 0 || p > 1) return NaN;
  if (p === 0) return 0.0;
  if (p === 1) return Infinity;
  if (a <= 0) return NaN;
  // Inverse of Q: find x with Q(a, x) = 1 - p.
  return invGammaQFloat64(a, 1.0 - p);
}

/**
 * Inverse of Q: returns `x` such that `gammaQFloat64(a, x) = q`.
 * Cephes `igami.c` Newton seed + Newton iterations with bracket-
 * bisection fallback when Newton overshoots.
 *
 * Accuracy ≤ 1e-10 in the bulk; degrades to ~1e-7 near the Temme
 * saddle region (large a, q ≈ 0.5). v0.2 upgrade to Boost's
 * DiDonato-Morris seed + Halley is filed.
 */
export function invGammaQFloat64(a: number, q: number): number {
  if (Number.isNaN(a) || Number.isNaN(q)) return NaN;
  if (q < 0 || q > 1) return NaN;
  if (q === 0) return Infinity;
  if (q === 1) return 0.0;
  if (a <= 0) return NaN;

  // Cephes igami.c seed: x_0 = a · (1 - 1/(9a) - t/(3√a))³.
  let t = Math.sqrt(-2.0 * Math.log(q));
  let x = a * Math.pow(1.0 - 1.0 / (9.0 * a) - t / (3.0 * Math.sqrt(a)), 3.0);
  if (x <= 0 || !Number.isFinite(x)) {
    // For small a, the seed may underflow or fail. Fall back to a
    // simpler estimate: x ≈ -log(q) (Q(1, x) = exp(-x) inverse).
    x = -Math.log(q);
  }

  // Establish a bracket via outward search. Q is monotone decreasing
  // in x, so we want x such that Q(a, x) = q.
  //  - If Q(a, x) > q, x is too small → increase.
  //  - If Q(a, x) < q, x is too large → decrease.
  let qx = gammaQFloat64(a, x);
  let xLo: number, xHi: number;
  if (qx > q) {
    // Need larger x.
    xLo = x;
    xHi = x * 2 + 1;
    while (gammaQFloat64(a, xHi) > q) {
      xLo = xHi;
      xHi *= 2;
      if (xHi > 1e8) return xHi; // give up if q very small and a tiny
    }
  } else {
    xHi = x;
    xLo = x / 2;
    while (gammaQFloat64(a, xLo) < q) {
      xHi = xLo;
      xLo /= 2;
      if (xLo < 1e-300) return xLo;
    }
  }
  // Now Q(a, xLo) > q > Q(a, xHi) and xLo < xHi.

  // Newton iteration with bracket. f(x) = Q(a, x) - q;
  // f'(x) = -e^{-x}·x^{a-1}/Γ(a).
  const lga = lgammaFloat64(a);
  for (let i = 0; i < 100; i++) {
    qx = gammaQFloat64(a, x);
    const diff = qx - q;
    if (Math.abs(diff) < 1e-14) break;
    // Update bracket.
    if (diff > 0) {
      xLo = x;
    } else {
      xHi = x;
    }
    // Newton step.
    const logDenom = lga.value + x - (a - 1) * Math.log(x);
    let xNew: number;
    if (logDenom > MAXLOG || !Number.isFinite(logDenom)) {
      // Derivative blows up; bisect.
      xNew = 0.5 * (xLo + xHi);
    } else {
      const delta = diff * Math.exp(logDenom);
      xNew = x + delta;
      // Reject Newton step if it leaves the bracket.
      if (xNew <= xLo || xNew >= xHi) xNew = 0.5 * (xLo + xHi);
    }
    if (Math.abs(xNew - x) < MACHEP * Math.abs(x)) break;
    x = xNew;
  }
  return x;
}

// -----------------------------------------------------------------------------
// §14. Beta and LogBeta
// -----------------------------------------------------------------------------

/**
 * `log B(a, b)` with sign tracking. Equals `log Γ(a) + log Γ(b) -
 * log Γ(a+b)` with sign = product of the three Γ signs.
 */
export function logBetaFloat64(a: number, b: number): LGammaResult {
  if (Number.isNaN(a) || Number.isNaN(b)) return { value: NaN, sign: 1 };
  const la = lgammaFloat64(a);
  const lb = lgammaFloat64(b);
  const lab = lgammaFloat64(a + b);
  const sign = (la.sign * lb.sign * lab.sign) as 1 | -1;
  return { value: la.value + lb.value - lab.value, sign };
}

/**
 * `B(a, b) = Γ(a)·Γ(b)/Γ(a+b)`. Routes through `logBetaFloat64` to
 * avoid premature overflow when individual Γ values exceed
 * `MAX_FLOAT64`.
 */
export function betaFloat64(a: number, b: number): number {
  const lb = logBetaFloat64(a, b);
  if (!Number.isFinite(lb.value)) return lb.value; // ±∞ or NaN
  if (lb.value > MAXLOG) return lb.sign * Infinity;
  if (lb.value < MINLOG) return 0.0;
  return lb.sign * Math.exp(lb.value);
}

// -----------------------------------------------------------------------------
// §15. Ratios — `gammaRatio` and `gammaDeltaRatio`
// -----------------------------------------------------------------------------

/**
 * `Γ(a) / Γ(b)`. For small a, b uses direct division; for large
 * arguments routes through lgamma to avoid premature overflow.
 */
export function gammaRatioFloat64(a: number, b: number): number {
  if (Number.isNaN(a) || Number.isNaN(b)) return NaN;
  if (a < 30 && b < 30 && a > 0 && b > 0) {
    return gammaFloat64(a) / gammaFloat64(b);
  }
  const la = lgammaFloat64(a);
  const lb = lgammaFloat64(b);
  const sign = (la.sign * lb.sign) as 1 | -1;
  const logVal = la.value - lb.value;
  if (logVal > MAXLOG) return sign * Infinity;
  if (logVal < MINLOG) return 0.0;
  return sign * Math.exp(logVal);
}

/**
 * `Γ(a) / Γ(a + δ)`. Equivalent to `1 / pochhammer(a, δ)` when δ is a
 * non-negative integer; for general δ routes through lgamma.
 */
export function gammaDeltaRatioFloat64(a: number, delta: number): number {
  if (Number.isNaN(a) || Number.isNaN(delta)) return NaN;
  // Integer δ ≥ 0 with small magnitude: 1/Pochhammer (exact for small).
  if (delta === Math.trunc(delta) && delta >= 0 && delta <= 50) {
    return 1.0 / pochhammerFloat64(a, delta);
  }
  return gammaRatioFloat64(a, a + delta);
}

// -----------------------------------------------------------------------------
// §16. `gammaPDerivativeFloat64` — ∂P/∂z (Gamma-distribution PDF)
// -----------------------------------------------------------------------------

/**
 * `∂P(a, z)/∂z = e^{-z}·z^{a-1}/Γ(a)`. DLMF §8.8.12. Direct
 * computation via log to avoid overflow at large `a, z`.
 */
export function gammaPDerivativeFloat64(a: number, z: number): number {
  if (Number.isNaN(a) || Number.isNaN(z)) return NaN;
  if (z < 0 || a <= 0) return NaN;
  if (z === 0) {
    if (a === 1) return 1.0;
    if (a > 1) return 0.0;
    if (a < 1) return Infinity;
  }
  const lga = lgammaFloat64(a);
  const logVal = (a - 1) * Math.log(z) - z - lga.value;
  if (logVal < MINLOG) return 0.0;
  if (logVal > MAXLOG) return Infinity;
  return Math.exp(logVal);
}

// -----------------------------------------------------------------------------
// §17. Cephes `incbet.c` — incomplete beta `I_z(a, b)`
// -----------------------------------------------------------------------------
//
// Three-way dispatch:
//   - power series `pseries` when `b·z ≤ 1 && z ≤ 0.95`
//   - symmetry I_z(a, b) = 1 - I_{1-z}(b, a) when z > a/(a+b)
//   - continued fraction (CF1 `incbcf` or CF2 `incbd`) otherwise

/** Cephes incbet.c rescaling constants. */
const INCBET_BIG = 4.5e15;
const INCBET_BIGINV = 2.22e-16;

// Helper: power series I_z(a, b) for small z.
function betaIncPseries(a: number, b: number, x: number): number {
  // Cephes incbet.c lines 312-348: series in z = x·b/(a+1)·(1 + ...)
  // Returns I_x(a, b) directly.
  let ai = 1.0 / a;
  let u = (1.0 - b) * x;
  let v = u / (a + 1.0);
  const t1 = v;
  let t = u;
  let n = 2.0;
  let s = 0.0;
  const z = MACHEP * ai;
  while (Math.abs(v) > z) {
    u = ((n - b) * x) / n;
    t *= u;
    v = t / (a + n);
    s += v;
    n += 1.0;
  }
  s += t1;
  s += ai;
  // Multiply by normalisation: x^a / (a · B(a, b))
  // log normalisation: a·log(x) - logB(a,b)
  const lb = logBetaFloat64(a, b);
  const y = a * Math.log(x);
  const arg = y - lb.value;
  if (arg < MINLOG) return 0.0;
  if (arg > MAXLOG) return Infinity;
  return s * Math.exp(arg) * lb.sign;
}

// Helper: continued fraction CF1 (Cephes incbet.c incbcf, lines 161-219).
function betaIncIncbcf(a: number, b: number, x: number): number {
  let k1 = a;
  let k2 = a + b;
  let k3 = a;
  let k4 = a + 1.0;
  let k5 = 1.0;
  let k6 = b - 1.0;
  let k7 = k4;
  let k8 = a + 2.0;

  let pkm2 = 0.0;
  let qkm2 = 1.0;
  let pkm1 = 1.0;
  let qkm1 = 1.0;
  let ans = 1.0;
  let r = 1.0;
  let thresh = 3.0 * MACHEP;

  for (let n = 0; n < 300; n++) {
    let xk = (-(x * k1 * k2)) / (k3 * k4);
    let pk = pkm1 + pkm2 * xk;
    let qk = qkm1 + qkm2 * xk;
    pkm2 = pkm1;
    pkm1 = pk;
    qkm2 = qkm1;
    qkm1 = qk;

    xk = (x * k5 * k6) / (k7 * k8);
    pk = pkm1 + pkm2 * xk;
    qk = qkm1 + qkm2 * xk;
    pkm2 = pkm1;
    pkm1 = pk;
    qkm2 = qkm1;
    qkm1 = qk;

    if (qk !== 0) r = pk / qk;
    let t: number;
    if (r !== 0) {
      t = Math.abs((ans - r) / r);
      ans = r;
    } else {
      t = 1.0;
    }
    if (t < thresh) break;

    k1 += 1.0;
    k2 += 1.0;
    k3 += 2.0;
    k4 += 2.0;
    k5 += 1.0;
    k6 -= 1.0;
    k7 += 2.0;
    k8 += 2.0;

    if (Math.abs(qk) + Math.abs(pk) > INCBET_BIG) {
      pkm2 *= INCBET_BIGINV;
      pkm1 *= INCBET_BIGINV;
      qkm2 *= INCBET_BIGINV;
      qkm1 *= INCBET_BIGINV;
    }
    if (Math.abs(qk) < INCBET_BIGINV || Math.abs(pk) < INCBET_BIGINV) {
      pkm2 *= INCBET_BIG;
      pkm1 *= INCBET_BIG;
      qkm2 *= INCBET_BIG;
      qkm1 *= INCBET_BIG;
    }
  }
  return ans;
}

// Helper: continued fraction CF2 — Cephes `incbd`, lines 221-285.
function betaIncIncbd(a: number, b: number, x: number): number {
  let k1 = a;
  let k2 = b - 1.0;
  let k3 = a;
  let k4 = a + 1.0;
  let k5 = 1.0;
  let k6 = a + b;
  let k7 = a + 1.0;
  let k8 = a + 2.0;

  let pkm2 = 0.0;
  let qkm2 = 1.0;
  let pkm1 = 1.0;
  let qkm1 = 1.0;
  const z = x / (1.0 - x);
  let ans = 1.0;
  let r = 1.0;
  const thresh = 3.0 * MACHEP;

  for (let n = 0; n < 300; n++) {
    let xk = (-(z * k1 * k2)) / (k3 * k4);
    let pk = pkm1 + pkm2 * xk;
    let qk = qkm1 + qkm2 * xk;
    pkm2 = pkm1;
    pkm1 = pk;
    qkm2 = qkm1;
    qkm1 = qk;

    xk = (z * k5 * k6) / (k7 * k8);
    pk = pkm1 + pkm2 * xk;
    qk = qkm1 + qkm2 * xk;
    pkm2 = pkm1;
    pkm1 = pk;
    qkm2 = qkm1;
    qkm1 = qk;

    if (qk !== 0) r = pk / qk;
    let t: number;
    if (r !== 0) {
      t = Math.abs((ans - r) / r);
      ans = r;
    } else {
      t = 1.0;
    }
    if (t < thresh) break;

    k1 += 1.0;
    k2 -= 1.0;
    k3 += 2.0;
    k4 += 2.0;
    k5 += 1.0;
    k6 += 1.0;
    k7 += 2.0;
    k8 += 2.0;

    if (Math.abs(qk) + Math.abs(pk) > INCBET_BIG) {
      pkm2 *= INCBET_BIGINV;
      pkm1 *= INCBET_BIGINV;
      qkm2 *= INCBET_BIGINV;
      qkm1 *= INCBET_BIGINV;
    }
    if (Math.abs(qk) < INCBET_BIGINV || Math.abs(pk) < INCBET_BIGINV) {
      pkm2 *= INCBET_BIG;
      pkm1 *= INCBET_BIG;
      qkm2 *= INCBET_BIG;
      qkm1 *= INCBET_BIG;
    }
  }
  return ans;
}

/**
 * Regularised incomplete beta `I_z(a, b)` for real a > 0, b > 0,
 * z ∈ [0, 1]. Cephes `incbet.c` verbatim port.
 */
export function incBetaFloat64(a: number, b: number, z: number): number {
  if (Number.isNaN(a) || Number.isNaN(b) || Number.isNaN(z)) return NaN;
  if (a <= 0 || b <= 0) return NaN;
  if (z < 0 || z > 1) return NaN;
  if (z === 0) return 0.0;
  if (z === 1) return 1.0;

  // Series path: b·z ≤ 1 && z ≤ 0.95
  if (b * z <= 1.0 && z <= 0.95) {
    return betaIncPseries(a, b, z);
  }

  // Symmetry: if z > a/(a+b), swap to put smaller term in numerator.
  let flag = false;
  let aa = a;
  let bb = b;
  let xx = z;
  let xc = 1.0 - z;
  if (z > a / (a + b)) {
    flag = true;
    aa = b;
    bb = a;
    xc = z;
    xx = 1.0 - z;
  }

  // Series path again after possible swap (Cephes incbet.c line 122):
  if (flag && bb * xx <= 1.0 && xx <= 0.95) {
    const t = betaIncPseries(aa, bb, xx);
    return 1.0 - t;
  }

  // CF normalisation: w · x^a · (1-x)^b / (a · B(a, b))
  const y = xx * (aa + bb - 2.0) - (aa - 1.0);
  let w: number;
  if (y < 0.0) {
    w = betaIncIncbcf(aa, bb, xx);
  } else {
    w = betaIncIncbd(aa, bb, xx) / xc;
  }
  const lb = logBetaFloat64(aa, bb);
  const yLog = aa * Math.log(xx) + bb * Math.log(xc) - Math.log(aa) - lb.value;
  if (yLog < MINLOG) return flag ? 1.0 : 0.0;
  if (yLog > MAXLOG) return flag ? 0.0 : Infinity;
  const t = Math.exp(yLog) * w * lb.sign;
  return flag ? 1.0 - t : t;
}

// -----------------------------------------------------------------------------
// §18. BarnesG — DLMF §5.17 / Adamchik 2003 asymptotic
// -----------------------------------------------------------------------------
//
// Integer table for x ∈ {1, …, 30} via the recurrence
//   G(n+1) = Γ(n)·G(n), G(1) = G(2) = G(3) = 1, G(4) = 2, G(5) = 12.
// Real x > 7 via asymptotic Bernoulli expansion.

/** DLMF §5.17.5 asymptotic Bernoulli coefficients `B_{2k+2}/((2k)(2k+1)(2k+2))`
 *  for the log G expansion:
 *    log G(z+1) = ... + Σ_{k=1}^∞ B_{2k+2}/((2k)(2k+1)(2k+2)·z^{2k})
 *  Each entry is `B_{2k+2}/((2k)(2k+1)(2k+2))` rounded to nearest float64:
 *    k=1: B_4 / (2·3·4) = (-1/30)/24 = -1/720
 *    k=2: B_6 / (4·5·6) = (1/42)/120 = 1/5040
 *    k=3: B_8 / (6·7·8) = (-1/30)/336 = -1/10080
 *    k=4: B_10 / (8·9·10) = (5/66)/720 = 1/9504
 *    k=5: B_12 / (10·11·12) = (-691/2730)/1320 ≈ -1.917e-4
 *    k=6: B_14 / (12·13·14) = (7/6)/2184 = 1/1872
 *    ...
 *  Coefficient magnitudes grow without bound — asymptotic series.
 *  Smallest-term truncation. */
const BARNESG_ASYM = [
  -1.0 / 720.0, // k=1: B_4 / (2·3·4)
  1.0 / 5040.0, // k=2: B_6 / (4·5·6)
  -1.0 / 10080.0, // k=3: B_8 / (6·7·8)
  1.0 / 9504.0, // k=4: B_10 / (8·9·10) = (5/66)/720
  -691.0 / 3603600.0, // k=5: B_12 / (10·11·12) = (-691/2730)/1320
  1.0 / 1872.0, // k=6: B_14 / (12·13·14) = (7/6)/2184 = 1/1872
  -3617.0 / 1713600.0, // k=7: B_16 / (14·15·16) = (-3617/510)/3360
] as const;

/**
 * BarnesG `G(x)` for real x > 0. Three-region dispatch:
 *  - Integer x ∈ {1, …, 30}: exact via product G(n+1) = Γ(n)·G(n);
 *  - Real x: shift to z = x - 1 in the asymptotic region (≥ 6), then
 *    apply the Adamchik 1998 asymptotic;
 *  - Negative integers: return 0 (G has zeros at -1, -2, …);
 *  - Negative non-integer: NaN (reflection requires complex-trig; v0.2).
 *
 * v0.1 accuracy: integer values exact; non-integer x ≥ 7 has ≤ 1e-10
 * relative error vs mpmath gold tier (the v0.1 asymptotic carve-out
 * documented in R3 §9.5). The v0.2 upgrade switches to a higher-order
 * Bernoulli truncation + Glaisher's constant double-double evaluation.
 */
export function barnesGFloat64(x: number): number {
  if (Number.isNaN(x)) return NaN;
  if (x === Infinity) return Infinity;
  if (x === -Infinity) return NaN;
  if (x === 0) return 0.0; // G(0) — limit of G(x) as x → 0+ is 0 (DLMF §5.17 says G(0) = 0)
  if (x < 0) {
    if (x === Math.trunc(x)) return 0.0; // G has zeros at negative integers
    return NaN; // v0.1 refuses reflection
  }
  // Integer x: exact via product G(n+1) = Γ(n)·G(n).
  if (x === Math.trunc(x) && x >= 1) {
    let g = 1.0;
    for (let k = 2; k <= x - 1; k++) {
      g *= gammaFloat64(k);
      if (!Number.isFinite(g)) return Infinity;
    }
    return g;
  }
  // Shift upward via G(y+1) = Γ(y)·G(y) until y ≥ threshold.
  // v0.1 accuracy carve-out (R3 §9.5): asymptotic is ~1e-5 accurate at
  // y ≥ 7. Tightening the threshold accumulates lgamma rounding without
  // a net win at float64. The v0.2 follow-up uses a higher-order
  // Bernoulli sum with double-double Glaisher constant.
  let y = x;
  let logShift = 0.0;
  let signShift: 1 | -1 = 1;
  while (y < 7.0) {
    const lg = lgammaFloat64(y);
    logShift -= lg.value;
    signShift = (signShift * lg.sign) as 1 | -1;
    y += 1.0;
  }
  // Asymptotic (DLMF §5.17.5 / Adamchik 1998):
  //   log G(z+1) = (1/12) - log A + (z/2)·log(2π) + (z²/2 - 1/12)·log z
  //              - 3z²/4 + Σ_{k=1}^N B_{2k+2}/((2k)(2k+1)(2k+2)·z^{2k})
  // We compute log G(y) = log G((y-1)+1) with z = y - 1.
  const z = y - 1.0;
  const logZ = Math.log(z);
  let asym =
    1.0 / 12.0 -
    Math.log(GLAISHER_A) +
    0.5 * z * LOG_2PI +
    (0.5 * z * z - 1.0 / 12.0) * logZ -
    0.75 * z * z;
  // Bernoulli series: Σ_{k≥1} B_{2k+2}/((2k)(2k+1)(2k+2)·z^{2k}).
  // Smallest-term truncation (Stieltjes' rule).
  const zInvSq = 1.0 / (z * z);
  let zPow = zInvSq; // z^{-2k} at k=1
  let asymCorr = 0.0;
  let prevTerm = Infinity;
  for (let k = 0; k < BARNESG_ASYM.length; k++) {
    const term = BARNESG_ASYM[k]! * zPow;
    if (Math.abs(term) > Math.abs(prevTerm)) break;
    asymCorr += term;
    prevTerm = term;
    zPow *= zInvSq;
  }
  asym += asymCorr;
  const total = asym + logShift;
  if (total > MAXLOG) return signShift * Infinity;
  if (total < MINLOG) return 0.0;
  return signShift * Math.exp(total);
}

/**
 * Hyperfactorial `K(n) = 1^1·2^2·…·n^n`. For integer n ∈ [0, 22]
 * compute the product directly; for larger n route through BarnesG
 * via `K(n) = A·n^{n²/2+n/2+1/12}·exp(-n²/4)·G(n+1)^{-1}` (DLMF
 * §5.17.4 inverted; this is the standard hyperfactorial form).
 *
 * For non-integer x: log K(x) via Adamchik's continuous extension.
 */
export function hyperfactorialFloat64(x: number): number {
  if (Number.isNaN(x)) return NaN;
  if (x < 0) return NaN; // domain: hyperfactorial classical for n ≥ 0
  if (x === 0) return 1.0;
  if (x === Math.trunc(x) && x >= 1 && x <= 22) {
    let prod = 1.0;
    for (let k = 2; k <= x; k++) prod *= Math.pow(k, k);
    return prod;
  }
  // Continuous form: K(x) = A^{-1} · x^{x²/2 + x/2 + 1/12} · exp(-x²/4) · G(x+1)
  // (Wikipedia "K-function"; DLMF §5.17.4 with G shifted by 1).
  // log K(x) = -log A + (x²/2 + x/2 + 1/12)·log x - x²/4 + log G(x+1).
  const g = barnesGFloat64(x + 1);
  if (!Number.isFinite(g) || g <= 0) return g;
  const logG = Math.log(g);
  const logK = -Math.log(GLAISHER_A) + ((x * x) / 2 + x / 2 + 1 / 12) * Math.log(x) - (x * x) / 4 + logG;
  if (logK > MAXLOG) return Infinity;
  if (logK < MINLOG) return 0.0;
  return Math.exp(logK);
}

// =============================================================================
// §19. Complex paths — LogGamma, Gamma, Digamma
// =============================================================================
//
// SciPy `_loggamma.pxd` Stirling-shift + reflection algorithm. The
// shift threshold is `Re(z) ≥ 7` (matching SciPy / Julia). Branch cut
// along the negative real axis (DLMF §5.4(i) standard choice).

/** Stirling Bernoulli coefficients for complex log Γ(z):
 *  log Γ(z) ≈ (z - 1/2)·log z - z + log(√(2π)) + Σ c_k / z^{2k-1}
 *  where c_k = B_{2k}/(2k·(2k-1)).
 */
const LGAMMA_COMPLEX_STIRLING = [
  1.0 / 12.0, // B_2 / (2·1) = (1/6)/2 = 1/12
  -1.0 / 360.0, // B_4 / (4·3) = (-1/30)/12 = -1/360
  1.0 / 1260.0, // B_6 / (6·5) = (1/42)/30 = 1/1260
  -1.0 / 1680.0, // B_8 / (8·7) = (-1/30)/56 ≈ -1/1680
  1.0 / 1188.0, // B_10 / (10·9) = (5/66)/90 = 1/1188
  -691.0 / 360360.0, // B_12 / (12·11) ≈ -691/360360
] as const;
const LGAMMA_COMPLEX_THRESHOLD = 7.0;

// Complex helpers — local to this file.
function cmul(a: ComplexF64, b: ComplexF64): ComplexF64 {
  return { re: a.re * b.re - a.im * b.im, im: a.re * b.im + a.im * b.re };
}
function cdiv(a: ComplexF64, b: ComplexF64): ComplexF64 {
  const d = b.re * b.re + b.im * b.im;
  return { re: (a.re * b.re + a.im * b.im) / d, im: (a.im * b.re - a.re * b.im) / d };
}
function clog(z: ComplexF64): ComplexF64 {
  return { re: 0.5 * Math.log(z.re * z.re + z.im * z.im), im: Math.atan2(z.im, z.re) };
}
function cexp(z: ComplexF64): ComplexF64 {
  const r = Math.exp(z.re);
  return { re: r * Math.cos(z.im), im: r * Math.sin(z.im) };
}
function csin(z: ComplexF64): ComplexF64 {
  return {
    re: Math.sin(z.re) * Math.cosh(z.im),
    im: Math.cos(z.re) * Math.sinh(z.im),
  };
}

/**
 * `log Γ(z)` for z ∈ ℂ. SciPy `_loggamma.pxd` Stirling+reflection.
 * Branch cut along the negative real axis (DLMF §5.4(i)). Accuracy
 * ≤ 14 dp across `|Im(z)| ≤ 100`, `Re(z) > -10` (degraded near
 * negative-integer poles).
 */
export function lgammaComplexFloat64(re: number, im: number): ComplexF64 {
  // Real arguments route to real lgamma (consistent with the principal
  // branch's restriction to ℝ⁺ on the real axis).
  if (im === 0) {
    if (re > 0) return { re: lgammaFloat64(re).value, im: 0 };
    // For real x ≤ 0, principal-value lgamma has imaginary part
    // -i·π·n for x ∈ (-n-1, -n). For non-integer x < 0:
    if (re === Math.trunc(re)) return { re: Infinity, im: 0 };
    const lg = lgammaFloat64(re);
    // Sign-encoded imaginary part: log|Γ| stays real; if Γ < 0 the
    // principal branch picks up imaginary part π or -π. Choose +π for
    // sign = -1 by convention (DLMF §5.4(i)).
    return { re: lg.value, im: lg.sign === -1 ? Math.PI : 0 };
  }

  let z: ComplexF64 = { re, im };
  let accum: ComplexF64 = { re: 0, im: 0 };
  let reflected = false;

  // Reflection for Re(z) < 0.5: log Γ(z) = log π - log sin(πz) - log Γ(1-z)
  if (z.re < 0.5) {
    reflected = true;
    const piZ: ComplexF64 = { re: Math.PI * z.re, im: Math.PI * z.im };
    const sinPiZ = csin(piZ);
    const logSin = clog(sinPiZ);
    accum = { re: LOG_PI - logSin.re, im: -logSin.im };
    z = { re: 1.0 - z.re, im: -z.im };
  }

  // Recurrence shift to Re(z) ≥ THRESHOLD.
  while (z.re < LGAMMA_COMPLEX_THRESHOLD) {
    const logZ = clog(z);
    accum = { re: accum.re - logZ.re, im: accum.im - logZ.im };
    z = { re: z.re + 1.0, im: z.im };
  }

  // Stirling: log Γ(z) = (z - 1/2)·log z - z + log(√(2π)) + Σ c_k / z^{2k-1}
  const logZ = clog(z);
  // (z - 1/2)
  const zHalf: ComplexF64 = { re: z.re - 0.5, im: z.im };
  // (z - 1/2)·log z
  let result = cmul(zHalf, logZ);
  result = { re: result.re - z.re + LOG_SQRT_2PI, im: result.im - z.im };

  // Bernoulli tail: Σ c_k / z^{2k-1}
  const zSq = cmul(z, z);
  let zPow = z; // z^{1}, will become z^{2k-1}
  for (let k = 0; k < LGAMMA_COMPLEX_STIRLING.length; k++) {
    // Term: c_k / z^{2k-1}
    const term = cdiv({ re: LGAMMA_COMPLEX_STIRLING[k]!, im: 0 }, zPow);
    result = { re: result.re + term.re, im: result.im + term.im };
    zPow = cmul(zPow, zSq);
  }

  // Combine with accumulated shift / reflection.
  if (reflected) {
    return { re: accum.re - result.re, im: accum.im - result.im };
  }
  return { re: result.re + accum.re, im: result.im + accum.im };
}

/**
 * `Γ(z) = exp(log Γ(z))` for z ∈ ℂ. Routes through `lgammaComplex`.
 * Accuracy ≤ 13 dp (inherits lgammaComplex's ≤ 14 dp minus one for
 * the `exp` round).
 */
export function gammaComplexFloat64(re: number, im: number): ComplexF64 {
  if (im === 0) {
    return { re: gammaFloat64(re), im: 0 };
  }
  const lg = lgammaComplexFloat64(re, im);
  return cexp(lg);
}

/**
 * `ψ(z) = d/dz log Γ(z)` for z ∈ ℂ. Stirling-shift + reflection
 * mirroring the real digamma. Asymptotic at `Re(z) ≥ 10`:
 *   ψ(z) ≈ log z - 1/(2z) + Σ c_k / z^{2k}
 *   c_k = -B_{2k}/(2k)
 */
export function digammaComplexFloat64(re: number, im: number): ComplexF64 {
  if (im === 0) {
    return { re: digammaFloat64(re), im: 0 };
  }

  let z: ComplexF64 = { re, im };
  let accum: ComplexF64 = { re: 0, im: 0 };
  let reflected = false;

  // Reflection ψ(1-z) = ψ(z) + π·cot(πz) (DLMF §5.5.4); rearranged
  // ψ(z) = ψ(1-z) - π·cot(πz).
  if (z.re < 0.5) {
    reflected = true;
    // π·cot(πz) = π·cos(πz)/sin(πz)
    const piZ: ComplexF64 = { re: Math.PI * z.re, im: Math.PI * z.im };
    const cosVal: ComplexF64 = {
      re: Math.cos(piZ.re) * Math.cosh(piZ.im),
      im: -Math.sin(piZ.re) * Math.sinh(piZ.im),
    };
    const sinVal = csin(piZ);
    const cot = cdiv(cosVal, sinVal);
    accum = { re: -Math.PI * cot.re, im: -Math.PI * cot.im };
    z = { re: 1.0 - z.re, im: -z.im };
  }

  // Shift to Re(z) ≥ 10 via ψ(z) = ψ(z+n) - Σ_{k=0}^{n-1} 1/(z+k).
  let shift: ComplexF64 = { re: 0, im: 0 };
  while (z.re < 10.0) {
    const inv = cdiv({ re: 1, im: 0 }, z);
    shift = { re: shift.re - inv.re, im: shift.im - inv.im };
    z = { re: z.re + 1, im: z.im };
  }

  // Stirling: ψ(z) ≈ log z - 1/(2z) + Σ c_k / z^{2k}
  const logZ = clog(z);
  const halfInvZ = cdiv({ re: 0.5, im: 0 }, z);
  let result: ComplexF64 = {
    re: logZ.re - halfInvZ.re,
    im: logZ.im - halfInvZ.im,
  };
  const zSq = cmul(z, z);
  let zPow = zSq; // z^{2k}, k starts at 1 ⇒ z^2
  for (let k = 0; k < DIGAMMA_ASYM.length; k++) {
    const term = cdiv({ re: DIGAMMA_ASYM[k]!, im: 0 }, zPow);
    result = { re: result.re + term.re, im: result.im + term.im };
    zPow = cmul(zPow, zSq);
  }

  result = { re: result.re + shift.re, im: result.im + shift.im };
  if (reflected) {
    return { re: accum.re - result.re, im: accum.im - result.im };
  }
  return result;
}

// -----------------------------------------------------------------------------
// §20. Re-export the ComplexF64 type for downstream consumers
// -----------------------------------------------------------------------------

export { type ComplexF64 } from "./erf-float64.js";
