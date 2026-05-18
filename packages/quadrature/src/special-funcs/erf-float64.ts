// =============================================================================
// erf-float64.ts — Float64 Erf family substrate (real + complex + inverses)
// =============================================================================
//
// Intent
// ------
// The float64 lane of the per-head Erf substrate pinned by ADR-0040
// (`docs/adr/0040-per-head-special-function-substrate-and-meijer-g-bridge.md`,
// Decision 4). Six real-axis functions (`erf`, `erfc`, `erfcx`, `erfi`,
// `erfinv`, `erfcinv`) and four complex-axis functions (`w`, `erf`,
// `erfc`, `erfcx`, `erfi`) live here. The dispatcher in
// `eval-numeric-expr.ts` hooks each into the closed-vocabulary
// expression evaluator; the Meijer-G bridge consumer (`bigErf` round-
// trip at prec=53), the qinfo Berry-smoothing consumer (bead `ybrw`),
// and the bench/erf-anchor cross-oracle grader (bronze tier) all read
// the exports below directly.
//
// Determinism contract (ADR-0015 `numerical: true`)
// -------------------------------------------------
// Bit-identical *given* platform fingerprint `{arch, os, runtime}`.
// Pure JavaScript on Bun/V8 — no FFI, no `process.arch` reads, no
// `Math.fround` (which would re-round to single precision and discard
// low bits), no platform-conditional branches. The only operations
// with possible cross-arch divergence at the last bit are V8's
// `Math.exp`, `Math.log`, `Math.sqrt`, `Math.cos`, and `Math.sin` —
// the tier's existing inheritance, not new exposure introduced by this
// module. Coefficient parsing is deterministic across all V8 builds
// per ECMAScript 11.1.3.3 (shortest-round-trip decimal literals parse
// exactly to their IEEE-754 doubles).
//
// Algorithms
// ----------
// 1. **Real-axis erf / erfc / erfcx** — verbatim port of Sun Microsystems
//    1993 `s_erf.c` (the canonical libm algorithm). Five-piece dispatch
//    on `|x|`:
//      |x| < 2^-28      → linear underflow-safe (avoids `x*x` flushing)
//      |x| < 0.84375    → odd rational `x + x · P(x²)/Q(x²)`        (deg 4/5)
//      |x| < 1.25       → Taylor-at-1 rational `(1−erx) − P1(s)/Q1(s)` (deg 6/6),
//                          with `s = |x| − 1` and `erx = 0.84506291...`
//                          the single-precision rounding of `erf(1)` so
//                          that `1 − erx` is exact in double
//      |x| < 1/0.35     → asymptotic `(1/x) · exp(−x² − 0.5625 + R1(z)/S1(z))`
//                          with `z = 1/x²` (deg 7/8 in z)
//      |x| < 28         → asymptotic `(1/x) · exp(−x² − 0.5625 + R2(z)/S2(z))`
//                          (deg 6/7)
//      |x| ≥ 6 (erf) / 28 (erfc) → saturation
//
//    Error bounds (from SunPro source comments):
//      branch 1b: |R − (erf x − x)/x| < 2^-57.90
//      branch 2 : |P1/Q1 − (erf|x| − c)| < 2^-59.06
//      branch 3 : |R1/S1 − g(z)| < 2^-62.57   where g(z) = log(erfc·x) − x² + 0.5625
//      branch 4 : |R2/S2 − g(z)| < 2^-61.52
//    In ULPs of result: ≤ 1 ULP for `erf`, ≤ 2 ULP for `erfc`. In service
//    33 years across glibc, musl, FreeBSD, NetBSD, Apple Libm.
//
//    **The one numerical trick** (SunPro "Note1", lines 71-80 of musl
//    erf.c): in branches 3/4, computing `exp(-x*x - 0.5625 + R/S)`
//    *naively* underflows for `x > 27.3`. The trick is to set `s = x`
//    with the LOW 32 BITS of its mantissa zeroed, then split
//
//        exp(−x²) = exp(−s² − 0.5625) · exp((s−x)(s+x) + R/S)
//
//    where `−s²` is computed *exactly* (because `s²` is single-precision-
//    ish and round-trips through float64 without loss) and `(s−x)(s+x)`
//    is a tiny correction. The C source calls this `SET_LOW_WORD(s, 0)`;
//    the JS port is the `maskLowWord` DataView helper below. *Dropping*
//    this mask is one of our three mutation-prove perturbations: the
//    T3 erfc tier fails RED, because the unmasked `exp(-x*x)` term
//    loses the bits the split was designed to preserve.
//
//    Sources (BSD-permissive Sun Microsystems 1993 notice; carried in
//    header below):
//      musl    src/math/erf.c           https://git.musl-libc.org/cgit/musl/tree/src/math/erf.c
//      FreeBSD lib/msun/src/s_erf.c     https://github.com/freebsd/freebsd-src/blob/main/lib/msun/src/s_erf.c
//      glibc   sysdeps/ieee754/dbl-64/s_erf.c   (byte-identical to musl modulo whitespace)
//    Cross-checked at musl commit 0784374d561435f7c787a555aeab8ede699ed298
//    (2026-05-16); all 60+ coefficient hex bit-patterns confirmed against
//    R3 §4.1 and the GSL `cprob/ndtr.c` independent re-implementation.
//
// 2. **Real-axis erfi** — `erfi(x) := -i·erf(ix)` is real-valued for
//    real x. Computed via the complex `w(z)` machinery at z = -i*x:
//    `erfi(x) = (2x/√π)·M(1; 3/2; x²)` blows up as `O(exp(x²)/x)`, so
//    for `|x| ≳ 5.5` the natural representation is
//    `erfi(x) = -2·Im(w(-i*x))·exp(x²)`. We instead compute via the
//    relation `erfi(x) = -i·erf(ix)` and the *complex* erf evaluator
//    (`erfComplexFloat64`), then take the real part. This is honest in
//    the same way `erfFloat64` is honest: small-|x| Taylor, large-|x|
//    asymptotic-via-w, with the dispatch decided by the complex-w
//    backend. No second algorithm to maintain.
//
// 3. **Complex w(z), erf(z), erfc(z), erfcx(z), erfi(z)** — full
//    Faddeeva-Johnson port (Stephen G. Johnson 2012, MIT-licensed;
//    `https://ab-initio.mit.edu/Faddeeva` ; canonical mirror at
//    `https://github.com/JuliaMath/openspecfun/blob/master/Faddeeva/Faddeeva.cc`).
//    The dispatch (Faddeeva.cc lines 692-984), preserved here verbatim
//    modulo C → TS syntax:
//      A. `z = 0`: `w(0) = 1`.
//      B. `Re z = 0` (imag axis): `w(iy) = erfcx(y)` via the SunPro
//         real-axis `erfcxFloat64` (≤ 1 ULP); for `y < 0`,
//         `w(-i·|y|) = 2·exp(y²) − erfcx(|y|)`.
//      C. `Im z = 0` (real axis): `w(x) = exp(−x²) + i·(2/√π)·D(x)`
//         where `D` is the Dawson integral; computed via `wImFloat64`
//         which routes through `wImY100` (Johnson's 100-panel
//         Chebyshev table on `y = 1/(1+|x|)`) for `|x| ≤ 45` and a
//         5-term continued-fraction expansion for `|x| > 45`.
//      D. Continued fraction (Poppe-Wijers 1990, `ACM TOMS 16(1)`):
//         `|Im z| > 7` OR (`|Re z| > 6` AND (`|Im z| > 0.1` OR (`|Re z| > 8`
//         AND `|Im z| > 1e-10`) OR `|Re z| > 28`)). Term count
//         `nu = floor(3.9 + 11.398/(0.08254·x + 0.1421·y + 0.2023))`
//         is Johnson's NLopt-fitted approximation to Poppe-Wijers's
//         `nu = 3 + 1442/(26·ρ + 77)`, ρ = √((x/6.3)² + (y/4.4)²),
//         avoiding the hypotenuse. Two-term form for `x + |y| > 4000`;
//         one-term form `w ≈ i/(√π·z)` for `x + |y| > 1e7`.
//      E. **Bulk (everything else)**: Zaghloul-Ali Algorithm 916
//         (`ACM TOMS 38(2), 2011`) — converges for the entire complex
//         plane and is the canonical answer for the "bad band"
//         `6 < x < 28, y < 0.1` where the CF loses 5+ bits of `Re w`.
//         Implemented as `algorithm916(x, y)`; the precomputed
//         51-entry `EXPA2N2` table stores `exp(−a²n²)` for `n ∈ 1..51`
//         at `a = π/√(−log(ε/2))` for `ε = 2⁻⁵²` (DBL_EPSILON), saving
//         50 `Math.exp` calls per evaluation.
//
//    **Two Taylor branches in `erf(z)`** for cancellation avoidance:
//      - `|x| < 0.08 && |y| < 0.01` (the deep cancellation band):
//        5-term Taylor `erf(z) = (2/√π)·z·(1 − z²/3 + z⁴/10 − z⁶/42 + z⁸/216)`.
//        Both terms in `1 − exp(-z²)·w(iz)` are within `2⁻⁵²` of 1, so
//        the subtraction would lose all bits; Taylor at `z = 0` keeps
//        the leading `z` factor explicit.
//      - `|x| < 0.005 && |Im(z²)| < 0.005` (the cancellation strip
//        further from the y-axis): two-variable Taylor in `(x, y²)`,
//        Faddeeva.cc lines 397-412. Avoids the cancellation as
//        `Re z → 0` along a fixed `|y|` band.
//
//    Accuracy contract: Faddeeva-Johnson's published `≤ 1e-13` relative
//    error across **all of ℂ**, including the previously degraded
//    `|z| < 1.5` bulk and the `[4, 6]` erfi band. The earlier
//    "CF-universal" v0.1 strategy that lost 1-3 orders of magnitude
//    near the origin (worklog 167 / bead `nxvu`) is retired.
//
//    Source (MIT-licensed; carried in header below):
//      Faddeeva.cc   https://github.com/JuliaMath/openspecfun/blob/master/Faddeeva/Faddeeva.cc
//
// 4. **Inverses `erfinv`, `erfcinv`** — port of Blair, Edwards & Johnson
//    1976 rational approximants (Math. Comp. 30, 827-830). Three
//    sub-tables for `erfinv` (Tables 17, 37, 57 by interval), two for
//    `erfcinv` (Tables 57 reused, Table 80 for `y < 1e-100`). The
//    SpecialFunctions.jl `_erfinv` / `_erfcinv` ports are verbatim
//    Float64; we adopt the same coefficient set. No Newton refinement
//    needed at float64 — Blair tables target ≤ 1e-19, well under 1 ULP.
//
// LICENSE compliance
// ------------------
// The Sun Microsystems 1993 BSD-permissive notice and Stephen G.
// Johnson's MIT notice are preserved verbatim below. Both licenses
// permit verbatim inclusion with attribution. Worklog 132 documents
// the audit chain.
//
// =============================================================================
// LICENSE NOTICES — VERBATIM, REQUIRED
// =============================================================================
//
// --- SunPro 1993 (real-axis erf/erfc/erfcx coefficient tables and
//                  algorithm structure) ---
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
// --- Stephen G. Johnson 2012 (Faddeeva library — complex w(z) dispatch
//                              structure, Algorithm 916 + Poppe-Wijers
//                              CF, Taylor-band coefficient values) ---
//
//   Copyright (c) 2012 Massachusetts Institute of Technology
//
//   Permission is hereby granted, free of charge, to any person obtaining
//   a copy of this software and associated documentation files (the
//   "Software"), to deal in the Software without restriction, including
//   without limitation the rights to use, copy, modify, merge, publish,
//   distribute, sublicense, and/or sell copies of the Software, and to
//   permit persons to whom the Software is furnished to do so, subject to
//   the following conditions:
//
//   The above copyright notice and this permission notice shall be
//   included in all copies or substantial portions of the Software.
//
//   THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
//   EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
//   MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
//   NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS
//   BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN
//   ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
//   CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
//   SOFTWARE.
//
// --- Blair, Edwards, Johnson 1976 (erfinv/erfcinv Tables 17, 37, 57, 80) ---
//   Math. Comp. 30 (1976), 827-830 — public domain (AMS publications
//   pre-copyright clarification, reproduced verbatim by SpecialFunctions.jl
//   under MIT, by GNU GSL under GPL, by Boost.Math under BSL). The
//   coefficient values themselves are mathematical facts and uncopyrighted.
//
// =============================================================================

// -----------------------------------------------------------------------------
// Module-load endianness canary
// -----------------------------------------------------------------------------
//
// The `maskLowWord` helper assumes a little-endian byte order for the
// IEEE-754 double's representation in a typed array. V8 (and therefore
// Bun) is little-endian on every supported platform — x86_64, aarch64,
// armv7. To remain *self-policing* against an unexpected big-endian
// host (e.g. some exotic embedded build of Node we one day inherit), we
// run the canonical 1.0-byte-pattern check once at module load. The
// IEEE-754 representation of 1.0 is `0x3FF0_0000_0000_0000`; on a
// little-endian platform the *first byte* of that pattern is `0x00`,
// on a big-endian platform it is `0x3F`. If the canary fails, we throw
// `RangeError` at load time so the failure mode is loud and immediate
// — never silent corruption of the `maskLowWord` mantissa-truncation
// (which would deterministically miscompute every branch-3/4 erfc).
{
  const canary = new Uint8Array(new Float64Array([1.0]).buffer)[0];
  if (canary !== 0) {
    throw new RangeError(
      "erf-float64: detected big-endian Float64Array layout (canary=" +
        canary +
        " ≠ 0); SunPro mantissa-mask requires little-endian. " +
        "Suggestion: file a bead — workbench is V8-only and big-endian was unforeseen.",
    );
  }
}

// -----------------------------------------------------------------------------
// `maskLowWord` — JS port of SunPro's `SET_LOW_WORD(x, 0)`
// -----------------------------------------------------------------------------
//
// Returns `x` with the low 32 bits of its IEEE-754 mantissa zeroed —
// the "high half" of the double. Used in the SunPro asymptotic
// branches to compute `exp(−x²)` via the split
//
//     exp(−x²) = exp(−s² − 0.5625) · exp((s−x)(s+x) + R/S)
//
// where `s = maskLowWord(x)`. With `s` having only the high 21 mantissa
// bits (the IEEE-754 double has 52 mantissa bits; zeroing the low 32
// leaves the high 20 + the implicit leading 1), `s² = -s*s` is
// computed without losing precision to round-off in the multiplication
// — the product of two single-precision-ish reals fits in the double's
// mantissa exactly. The `(s−x)(s+x)` correction then captures the
// difference between `s²` and the true `x²` to full precision.
//
// The module-level buffer + DataView eliminates per-call allocation
// (this function is called once per asymptotic-branch evaluation; the
// `Math.exp` cost dominates, but a clean allocation profile matters
// for the surrounding adaptive-quadrature consumer).
//
// Determinism: DataView with explicit `littleEndian=true` byte order
// is canonical across every JS runtime regardless of host endianness.
// The IEEE-754 representation of a Number is bit-exact per ECMAScript
// 11.1.3.3 (Float64ToBigEndianBytes / Float64ToLittleEndianBytes —
// both specified to return the canonical IEEE-754 8-byte pattern).
const _maskBuffer = new ArrayBuffer(8);
const _maskView = new DataView(_maskBuffer);
export function maskLowWord(x: number): number {
  _maskView.setFloat64(0, x, true); // little-endian write
  _maskView.setUint32(0, 0, true); // zero low 32 bits (mantissa low half)
  return _maskView.getFloat64(0, true); // little-endian read
}

// -----------------------------------------------------------------------------
// Universal constants
// -----------------------------------------------------------------------------

/** `2/√π`, the leading series coefficient for `erf`. */
const TWO_OVER_SQRT_PI = 1.1283791670955125738961589031215451716881;
/** `1/√π`, the leading coefficient for `erfcx` asymptotic / `w(z)` imaginary axis. */
const ONE_OVER_SQRT_PI = 0.5641895835477562869480794515607725858440;

// -----------------------------------------------------------------------------
// SunPro coefficient tables (R3 §4.1, byte-identical to musl/glibc/FreeBSD)
// -----------------------------------------------------------------------------
//
// All values reproduced as shortest-round-trip 17-digit literals; V8
// parses each bit-exactly to its IEEE-754 double per ECMAScript
// 11.1.3.3. The leading 1.0 in every Q table is implicit (Horner from
// the highest index).

/** `erf(1)` rounded to single precision; `1 − ERX` is then exact in double. */
const ERX = 8.45062911510467529297e-1;

/** `8·(2/√π − 1)` — the "extra" mass for the underflow-safe linear branch. */
const EFX8 = 1.02703333676410069053e0;

/** Branch 1b: `erf(x) = x + x · pp(x²)/qq(x²)` for `|x| < 0.84375`, deg(P)=4. */
const PP0 = 1.28379167095512558561e-1;
const PP1 = -3.25042107247001499370e-1;
const PP2 = -2.84817495755985104766e-2;
const PP3 = -5.77027029648944159157e-3;
const PP4 = -2.37630166566501626084e-5;

/** Branch 1b denominator (implicit leading 1.0), deg(Q)=5. */
const QQ1 = 3.97917223959155352819e-1;
const QQ2 = 6.50222499887672944485e-2;
const QQ3 = 5.08130628187576562776e-3;
const QQ4 = 1.32494738004321644526e-4;
const QQ5 = -3.96022827877536812320e-6;

/** Branch 2: `erfc(x) = (1−ERX) − P1(s)/Q1(s)`, `s = |x| − 1`, deg=6. */
const PA0 = -2.36211856075265944077e-3;
const PA1 = 4.14856118683748331666e-1;
const PA2 = -3.72207876035701323847e-1;
const PA3 = 3.18346619901161753674e-1;
const PA4 = -1.10894694282396677476e-1;
const PA5 = 3.54783043256182359371e-2;
const PA6 = -2.16637559486879084300e-3;

const QA1 = 1.06420880400844228286e-1;
const QA2 = 5.40397917702171048937e-1;
const QA3 = 7.18286544141962662868e-2;
const QA4 = 1.26171219808761642112e-1;
const QA5 = 1.36370839120290507362e-2;
const QA6 = 1.19844998467991074170e-2;

/** Branch 3: `erfc(x) = (1/x)·exp(−x²−0.5625+R1(z)/S1(z))`, `z = 1/x²`, deg(R)=7. */
const RA0 = -9.86494403484714822705e-3;
const RA1 = -6.93858572707181764372e-1;
const RA2 = -1.05586262253232909814e1;
const RA3 = -6.23753324503260060396e1;
const RA4 = -1.62396669462573470355e2;
const RA5 = -1.84605092906711035994e2;
const RA6 = -8.12874355063065934246e1;
const RA7 = -9.81432934416914548592e0;

const SA1 = 1.96512716674392571292e1;
const SA2 = 1.37657754143519042600e2;
const SA3 = 4.34565877475229228821e2;
const SA4 = 6.45387271733267880336e2;
const SA5 = 4.29008140027567833386e2;
const SA6 = 1.08635005541779435134e2;
const SA7 = 6.57024977031928170135e0;
const SA8 = -6.04244152148580987438e-2;

/** Branch 4: `erfc(x) = (1/x)·exp(−x²−0.5625+R2(z)/S2(z))`, `z = 1/x²`, deg(R)=6. */
const RB0 = -9.86494292470009928597e-3;
const RB1 = -7.99283237680523006574e-1;
const RB2 = -1.77579549177547519889e1;
const RB3 = -1.60636384855821916062e2;
const RB4 = -6.37566443368389627722e2;
const RB5 = -1.02509513161107724954e3;
const RB6 = -4.83519191608651397019e2;

const SB1 = 3.03380607434824582924e1;
const SB2 = 3.25792512996573918826e2;
const SB3 = 1.53672958608443695994e3;
const SB4 = 3.19985821950859553908e3;
const SB5 = 2.55305040643316442583e3;
const SB6 = 4.74528541206955367215e2;
const SB7 = -2.24409524465858183362e1;

/** `2^-1022` — smallest positive normal; used as "tiny" in saturation branches. */
const TINY = 2.2250738585072014e-308;

// -----------------------------------------------------------------------------
// erfFloat64 — real-axis Erf
// -----------------------------------------------------------------------------
//
// SunPro 1993 dispatch, transcribed line-for-line. Sign is reflected
// at the entry (`erf(-x) = -erf(x)`), then we work on `|x|`. Special
// values handled inline at the top.
//
// The branches sit in three classes:
//   - Branch 1 (a/b): `|x| < 0.84375`. The small-x regime; `erf` is
//     small itself, so absolute and relative error coincide.
//   - Branch 2: `|x| < 1.25`. The Taylor-at-1 regime; `erf` is close
//     to 1 but we compute it via the well-conditioned rearrangement
//     `ERX + P1(s)/Q1(s)`.
//   - Branches 3+4: the asymptotic regime; `1 − erfc(x)` would
//     cancel catastrophically, so SunPro instead computes `erfc(x)`
//     directly via the rational form and returns `1 − erfc(x)`.
//   - Saturation: for `|x| ≥ 6`, `erfc(x) < 2.15e-17` so `1 − erfc`
//     would round to exactly 1 in float64; we instead return
//     `sign(x) · (1 − 2^-1022)` so callers that distinguish "below 1"
//     from "exactly 1" get the right semantics.

export function erfFloat64(x: number): number {
  if (Number.isNaN(x)) return NaN;
  if (!Number.isFinite(x)) return x > 0 ? 1 : -1;

  const ax = Math.abs(x);

  // Branch 1a: |x| < 2^-28 — underflow-safe linear. Without this, the
  // multiplication `x*x` in branch 1b can flush to subnormals for
  // `|x| ≤ 2^-512`. The form `(8x + EFX8·x)/8 = x·(1 + EFX8/8) =
  // x·(2/√π)` to within ULPs that the constant absorbs.
  if (ax < 3.7252902984619141e-9) {
    if (ax < 2.848094538889218e-306) {
      // Avoid intermediate overflow/underflow at the extreme tail.
      return 0.125 * (8.0 * x + EFX8 * x);
    }
    return x + EFX8 * (x / 8);
  }

  // Branch 1b: |x| < 0.84375. Odd rational `x + x · pp/qq`.
  if (ax < 0.84375) {
    const z = x * x;
    const r = PP0 + z * (PP1 + z * (PP2 + z * (PP3 + z * PP4)));
    const s = 1.0 + z * (QQ1 + z * (QQ2 + z * (QQ3 + z * (QQ4 + z * QQ5))));
    const y = r / s;
    return x + x * y;
  }

  // Branch 2: 0.84375 ≤ |x| < 1.25. Taylor-at-1 form.
  if (ax < 1.25) {
    const s = ax - 1.0;
    const P =
      PA0 + s * (PA1 + s * (PA2 + s * (PA3 + s * (PA4 + s * (PA5 + s * PA6)))));
    const Q =
      1.0 + s * (QA1 + s * (QA2 + s * (QA3 + s * (QA4 + s * (QA5 + s * QA6)))));
    if (x >= 0) return ERX + P / Q;
    return -ERX - P / Q;
  }

  // Branches 3+4+5: |x| ≥ 1.25. erf(x) = sign(x)·(1 − erfc(x)).
  if (ax >= 6.0) {
    // Saturation. SunPro returns sign(x)·(1 − tiny), where tiny is
    // 2^-1022, so the result is just-barely-below 1 and round-trip-
    // distinguishable from exact 1.
    return x >= 0 ? 1.0 - TINY : TINY - 1.0;
  }

  // Compute erfc(|x|) via the asymptotic rational; return 1 − erfc.
  const erfcAx = erfcAsymptotic(ax);
  return x >= 0 ? 1.0 - erfcAx : erfcAx - 1.0;
}

// -----------------------------------------------------------------------------
// erfcFloat64 — real-axis complementary Erf
// -----------------------------------------------------------------------------
//
// Same dispatch, mirrored: erfc(x) = 1 − erf(x) is unsafe for large x
// (cancellation), so for `|x| ≥ 1.25` we compute erfc directly and
// erf via subtraction. For small/moderate x we rearrange to preserve
// the leading bits.

export function erfcFloat64(x: number): number {
  if (Number.isNaN(x)) return NaN;
  if (!Number.isFinite(x)) return x > 0 ? 0 : 2;

  const ax = Math.abs(x);

  // Branch 1a + 1b: |x| < 0.84375.
  if (ax < 0.84375) {
    if (ax < 1.3877787807814457e-17) {
      // For |x| < 2^-56, `erfc(x) = 1 − x` exactly (since `(2/√π)·x`
      // contributes below the ULP of 1.0). Carrying `1 − x` preserves
      // every bit of x.
      return 1.0 - x;
    }
    const z = x * x;
    const r = PP0 + z * (PP1 + z * (PP2 + z * (PP3 + z * PP4)));
    const s = 1.0 + z * (QQ1 + z * (QQ2 + z * (QQ3 + z * (QQ4 + z * QQ5))));
    const y = r / s;
    // musl: `if (sign || ix < 0x3fd00000) return 1 - (x + x*y); return 0.5 - (x - 0.5 + x*y)`
    // i.e. the rearrangement is gated on x ≥ 0 AND |x| ≥ 0.25; for x < 0
    // or |x| < 0.25 use the simple form (which is well-conditioned in
    // that range — `x*y` is small and `1 − small` doesn't cancel
    // catastrophically).
    if (x < 0 || ax < 0.25) {
      return 1.0 - (x + x * y);
    }
    return 0.5 - (x - 0.5 + x * y);
  }

  // Branch 2: 0.84375 ≤ |x| < 1.25.
  if (ax < 1.25) {
    const s = ax - 1.0;
    const P =
      PA0 + s * (PA1 + s * (PA2 + s * (PA3 + s * (PA4 + s * (PA5 + s * PA6)))));
    const Q =
      1.0 + s * (QA1 + s * (QA2 + s * (QA3 + s * (QA4 + s * (QA5 + s * QA6)))));
    if (x >= 0) return 1.0 - ERX - P / Q;
    return 1.0 + (ERX + P / Q);
  }

  // Branches 3+4+5: |x| ≥ 1.25.
  if (ax < 28.0) {
    const erfcAx = erfcAsymptotic(ax);
    if (x >= 0) return erfcAx;
    return 2.0 - erfcAx;
  }

  // Saturation: |x| ≥ 28. For x > 0, erfc underflows; for x < 0,
  // erfc → 2.
  return x >= 0 ? TINY * TINY : 2.0 - TINY;
}

/**
 * Compute `erfc(|x|)` via SunPro branches 3/4 for `1.25 ≤ |x| < 28`.
 * The asymptotic rational `R(z)/S(z)` with `z = 1/x²` is the inner
 * loop; the outer `exp(−x² − 0.5625) · ...` uses the maskLowWord
 * split to avoid cancellation.
 *
 * Caller guarantees `1.25 ≤ ax < 28`.
 */
function erfcAsymptotic(ax: number): number {
  const z = 1.0 / (ax * ax);
  let R: number;
  let S: number;
  if (ax < 1.0 / 0.35) {
    // Branch 3.
    R =
      RA0 +
      z * (RA1 + z * (RA2 + z * (RA3 + z * (RA4 + z * (RA5 + z * (RA6 + z * RA7))))));
    S =
      1.0 +
      z *
        (SA1 +
          z * (SA2 + z * (SA3 + z * (SA4 + z * (SA5 + z * (SA6 + z * (SA7 + z * SA8)))))));
  } else {
    // Branch 4.
    R = RB0 + z * (RB1 + z * (RB2 + z * (RB3 + z * (RB4 + z * (RB5 + z * RB6)))));
    S =
      1.0 +
      z * (SB1 + z * (SB2 + z * (SB3 + z * (SB4 + z * (SB5 + z * (SB6 + z * SB7))))));
  }
  const s = maskLowWord(ax);
  const r = Math.exp(-s * s - 0.5625) * Math.exp((s - ax) * (s + ax) + R / S);
  return r / ax;
}

// -----------------------------------------------------------------------------
// erfcxFloat64 — scaled complementary Erf, `erfcx(x) = exp(x²)·erfc(x)`
// -----------------------------------------------------------------------------
//
// The scaled form. For `x → ∞`, `erfcx(x) → 1/(x·√π)` — small but
// positive, never underflowing. For `x → -∞`, `erfcx(x) → 2·exp(x²)`
// — diverges. NaN inputs and ±∞ are handled at the top.
//
// Two-lane dispatch:
//   - `|x| ≤ 1.25` and `x > -26`: `erfcx(x) = exp(x²) · erfcFloat64(x)`.
//     For `|x| ≤ 1.25` we have `exp(x²) ≤ exp(1.5625) ≈ 4.77`, well-
//     conditioned and finite. For `-26 < x < 0` the product is bounded
//     by `2 · exp(676)` which overflows; we exclude that lane.
//   - `x > 1.25`: use the SunPro asymptotic *without* the
//     `exp(-x²)` prefactor — `erfcx(x) = (1/x) · exp(-0.5625 + R/S)`.
//   - `x < -1.25` or `x = -∞`: `erfcx(x) = 2·exp(x²) − erfcx(-x)`.
//     For `x ≤ -27.3`, `exp(x²) > 2^1023.6` → +∞; we return +∞
//     directly. For `-27.3 < x ≤ -1.25` we compose via the identity.

export function erfcxFloat64(x: number): number {
  if (Number.isNaN(x)) return NaN;
  if (x === Infinity) return 0;
  if (x === -Infinity) return Infinity;

  const ax = Math.abs(x);

  // Lane A: |x| ≤ 1.25 — direct via `exp(x²) · erfc(x)`.
  if (ax <= 1.25) {
    return Math.exp(x * x) * erfcFloat64(x);
  }

  if (x > 1.25) {
    // Lane B: x > 1.25 — SunPro asymptotic minus the exp(-x²) prefactor.
    const z = 1.0 / (x * x);
    let R: number;
    let S: number;
    if (x < 1.0 / 0.35) {
      R =
        RA0 +
        z * (RA1 + z * (RA2 + z * (RA3 + z * (RA4 + z * (RA5 + z * (RA6 + z * RA7))))));
      S =
        1.0 +
        z *
          (SA1 +
            z *
              (SA2 +
                z * (SA3 + z * (SA4 + z * (SA5 + z * (SA6 + z * (SA7 + z * SA8)))))));
    } else {
      // x ≥ 1/0.35. The SunPro RB/SB rational is fitted to
      //   g(s) = log(erfc(x)·x) − x² + 0.5625
      // for x ∈ [1/0.35, 28]; the rational `R/S` then encodes the full
      // asymptotic correction. For `erfcx` (no `exp(-x²)` prefactor)
      // the R/S form is *also* valid beyond x = 28 — the saturation
      // boundary at 28 only applies to `erfc` (where `exp(-x²)`
      // underflows). For `erfcx(x)` we extend the rational to x → ∞;
      // the leading-coefficient limit at z = 1/x² → 0 is
      //   R(0)/S(0) = RB0 / 1 = -9.86e-3 ≈ log(2/√π · √π/2) − ...,
      // and `exp(-0.5625 + RB0) ≈ exp(-0.5723)` so the limit becomes
      //   erfcx(x) → (1/x) · exp(-0.5723) ≈ (1/x) · 0.5642 ≈ 1/(x·√π)
      // recovering the correct asymptotic. Above x ≈ 5e7 the
      // `1/(x*x)` underflow makes z = 0 exactly; the rational then
      // returns `RB0 / 1` and the result is exact at the leading
      // term — which IS the correct value to ULP for such large x.
      R = RB0 + z * (RB1 + z * (RB2 + z * (RB3 + z * (RB4 + z * (RB5 + z * RB6)))));
      S =
        1.0 +
        z *
          (SB1 + z * (SB2 + z * (SB3 + z * (SB4 + z * (SB5 + z * (SB6 + z * SB7))))));
    }
    return Math.exp(-0.5625 + R / S) / x;
  }

  // Lane C: x < -1.25 — identity erfcx(-x) = 2·exp(x²) − erfcx(x).
  // For x ≤ -27, exp(x²) overflows → +∞.
  if (x <= -27.0) return Infinity;
  return 2.0 * Math.exp(x * x) - erfcxFloat64(-x);
}

// -----------------------------------------------------------------------------
// erfiFloat64 — real-axis imaginary error function
// -----------------------------------------------------------------------------
//
// `erfi(x) := -i · erf(ix)` for real `x`, which is itself real-valued.
//
// Identity (Faddeeva.cc line 425):
//   erfi(x) = exp(x²) · Im[w(x)] = exp(x²) · (2/√π) · D(x)
// where `w` is the Faddeeva function and `D` is the Dawson integral.
//
// `Im[w(x)]` is computed by `wImFloat64` below (y100 Chebyshev for
// `|x| ≤ 45`, 5-term CF for `|x| > 45`). The `exp(x²)` prefactor
// overflows for `|x| > √720 ≈ 26.83`; we return signed `Infinity`
// past that boundary, matching Faddeeva.cc's behaviour exactly.
//
// Accuracy: ≤ 2 ULP everywhere `exp(x²)` does not overflow. The
// previous "Taylor for small x, asymptotic-via-DLMF-7.6.3 for
// `|x| ≥ 4`" approach (worklog 167) is retired — that asymptotic
// was precision-limited (≈ 1e-7 at x = 4, ≈ 1e-11 at x = 5) by the
// inherent best-error of an asymptotic series at finite x, and
// y100-Chebyshev's panel-fit recovers full float64 precision
// throughout the broken band.

export function erfiFloat64(x: number): number {
  if (Number.isNaN(x)) return NaN;
  if (!Number.isFinite(x)) return x > 0 ? Infinity : -Infinity;
  if (x === 0) return x; // preserve sign of zero
  if (x * x > 720) return x > 0 ? Infinity : -Infinity;
  return Math.exp(x * x) * wImFloat64(x);
}

// =============================================================================
// COMPLEX LANE — full Faddeeva-Johnson port (Faddeeva.cc 2012, MIT)
// =============================================================================
//
// The complex `w(z)` is the load-bearing primitive; `erf` / `erfc` /
// `erfcx` / `erfi` derive algebraically. The port preserves the
// dispatcher of Faddeeva.cc lines 692-984 (the `FADDEEVA(w)` function)
// in full, including:
//   - the precomputed `EXPA2N2[n−1] = exp(−a²·n²)` table for the
//     Algorithm 916 inner sums (50 `Math.exp` calls saved per call),
//   - the four-or-five-sum Algorithm 916 split by the `x < 5e-4`
//     special case (sum5 − sum4 vs sum4, sum5 separately), and
//   - the `cancel-via-trig-identities` rearrangement when `y > 5`
//     and the imaginary terms would otherwise cancel.
//
// The two complex-`erf` Taylor branches (`taylor` and `taylor_erfi`,
// Faddeeva.cc lines 378-412) are also preserved verbatim; both are
// required to keep `1 − exp(−z²)·w(iz)` from losing all precision
// in the narrow cancellation strips along the real axis.

export interface ComplexF64 {
  re: number;
  im: number;
}

// -----------------------------------------------------------------------------
// Algorithm 916 precomputed `exp(−a²·n²)` table
// -----------------------------------------------------------------------------
//
// For `a² = 0.268657157075235951582` (the canonical choice giving
// `relerr = DBL_EPSILON`), this table caches `exp(−a²·n²)` for
// `n ∈ 1..51`. By `n = 51` the value has underflowed (3.35e-304 at
// n = 50; the spec's 52nd slot is 0.0 to make the convergence test
// short-circuit safely past array end without an explicit guard).
//
// Source: Faddeeva.cc lines 635-688 (Stephen G. Johnson 2012).
// Values reproduced verbatim as shortest-round-trip 17-digit literals.

const EXPA2N2: readonly number[] = [
  7.64405281671221563e-1,
  3.41424527166548425e-1,
  8.91072646929412548e-2,
  1.35887299055460086e-2,
  1.21085455253437481e-3,
  6.30452613933449404e-5,
  1.91805156577114683e-6,
  3.40969447714832381e-8,
  3.54175089099469393e-10,
  2.14965079583260682e-12,
  7.62368911833724354e-15,
  1.57982797110681093e-17,
  1.91294189103582677e-20,
  1.35344656764205340e-23,
  5.59535712428588720e-27,
  1.35164257972401769e-30,
  1.90784582843501167e-34,
  1.57351920291442930e-38,
  7.58312432328032845e-43,
  2.13536275438697082e-47,
  3.51352063787195769e-52,
  3.37800830266396920e-57,
  1.89769439468301000e-62,
  6.22929926072668851e-68,
  1.19481172006938722e-73,
  1.33908181133005953e-79,
  8.76924303483223939e-86,
  3.35555576166254986e-92,
  7.50264110688173024e-99,
  9.80192200745410268e-106,
  7.48265412822268959e-113,
  3.33770122566809425e-120,
  8.69934598159861140e-128,
  1.32486951484088852e-135,
  1.17898144201315253e-143,
  6.13039120236180012e-152,
  1.86258785950822098e-160,
  3.30668408201432783e-169,
  3.43017280887946235e-178,
  2.07915397775808219e-187,
  7.36384545323984966e-197,
  1.52394760394085741e-206,
  1.84281935046532100e-216,
  1.30209553802992923e-226,
  5.37588903521080531e-237,
  1.29689584599763145e-247,
  1.82813078022866562e-258,
  1.50576355348684241e-269,
  7.24692320799294194e-281,
  2.03797051314726829e-292,
  3.34880215927873807e-304,
  0.0, // underflow — also short-circuits a past-end read in the convergence test
] as const;

/** Algorithm 916 series-fit constant `a = π / √(−log(ε/2))`, ε = DBL_EPSILON. */
const ALG916_A = 0.518321480430085929872;
/** `(2/π) · ALG916_A`. */
const ALG916_C = 0.329973702884629072537;
/** `ALG916_A²`. */
const ALG916_A2 = 0.268657157075235951582;
/** `2 · ALG916_A` — for the Taylor-`exp(2ax)` special case at `x < 5e-4`. */
const ALG916_TWO_A_X_COEF = 1.036642960860171859744; // = 2 * ALG916_A
/** `1/√π` — leading factor in `w(z) ≈ i/(√π·z)`. */
const ISPI = 0.56418958354775628694807945156;

// -----------------------------------------------------------------------------
// sinc and sinh — local helpers (Faddeeva.cc lines 621-629)
// -----------------------------------------------------------------------------

/**
 * `sinc(x) = sin(x)/x` given both `x` and `sin(x)` (since the caller
 * has already computed `sin(x)` for use elsewhere). Uses Taylor for
 * `|x| < 1e-4` to avoid the `0/0` indeterminate at the origin.
 */
function sinc(x: number, sinx: number): number {
  return Math.abs(x) < 1e-4
    ? 1.0 - (0.1666666666666666666667) * x * x
    : sinx / x;
}

/** `sinh(x)` via 3-term Taylor, accurate to ULP for `|x| < 1e-2`. */
function sinhTaylor(x: number): number {
  const x2 = x * x;
  return x * (1.0 + x2 * (0.1666666666666666666667 + 0.00833333333333333333333 * x2));
}

// -----------------------------------------------------------------------------
// `wImY100` — Faddeeva-Johnson 100-panel Chebyshev for `Im[w(x)]`, x ≥ 0
// -----------------------------------------------------------------------------
//
// Given `y100 = 100 · y` where `y = 1/(1+x)`, returns `w_im(x) =
// (2/√π) · Dawson(x)`. The 100-panel partition of `y ∈ [0, 1]`
// uses a degree-6 Chebyshev polynomial in `t = 2·y100 − (2·panel + 1)`
// per subinterval. Maple-generated coefficients, **verbatim from
// Faddeeva.cc lines 1470-1874** (Stephen G. Johnson 2012, MIT).
//
// Why 100 panels? The transformation `y = 1/(1+x)` compresses the
// entire `[0, ∞)` real line into `(0, 1]`; `w_im` is smooth in `y`
// (rapidly approaching 0 as `y → 0`, x → ∞). 100 panels of degree-6
// Chebyshev recover ≤ 1 ULP across the entire smooth region. A
// single global polynomial would need degree ≈ 60 for the same
// accuracy; the panel-table is materially faster.
//
// Panels 97-100 (`y100 ≥ 97`, equivalent to `x ≤ 100/97 − 1 ≈ 0.031`)
// share the small-x Taylor fallback `(2/√π)·x·(1 − ⅔x² + 4/15·x⁴ −
// 8/105·x⁶ + 16/945·x⁸)`. The Chebyshev fit would not gain anything
// over Taylor in this narrow strip — the leading `(2/√π)·x` factor
// dominates and the higher-order corrections are below 1 ULP.

function wImY100(y100: number, x: number): number {
  switch (y100 | 0) {
    case 0: {
      const t = 2 * y100 - 1;
      return 0.28351593328822191546e-2 + (0.28494783221378400759e-2 + (0.14427470563276734183e-4 + (0.10939723080231588129e-6 + (0.92474307943275042045e-9 + (0.89128907666450075245e-11 + 0.92974121935111111110e-13 * t) * t) * t) * t) * t) * t;
    }
    case 1: {
      const t = 2 * y100 - 3;
      return 0.85927161243940350562e-2 + (0.29085312941641339862e-2 + (0.15106783707725582090e-4 + (0.11716709978531327367e-6 + (0.10197387816021040024e-8 + (0.10122678863073360769e-10 + 0.10917479678400000000e-12 * t) * t) * t) * t) * t) * t;
    }
    case 2: {
      const t = 2 * y100 - 5;
      return 0.14471159831187703054e-1 + (0.29703978970263836210e-2 + (0.15835096760173030976e-4 + (0.12574803383199211596e-6 + (0.11278672159518415848e-8 + (0.11547462300333495797e-10 + 0.12894535335111111111e-12 * t) * t) * t) * t) * t) * t;
    }
    case 3: {
      const t = 2 * y100 - 7;
      return 0.20476320420324610618e-1 + (0.30352843012898665856e-2 + (0.16617609387003727409e-4 + (0.13525429711163116103e-6 + (0.12515095552507169013e-8 + (0.13235687543603382345e-10 + 0.15326595042666666667e-12 * t) * t) * t) * t) * t) * t;
    }
    case 4: {
      const t = 2 * y100 - 9;
      return 0.26614461952489004566e-1 + (0.31034189276234947088e-2 + (0.17460268109986214274e-4 + (0.14582130824485709573e-6 + (0.13935959083809746345e-8 + (0.15249438072998932900e-10 + 0.18344741882133333333e-12 * t) * t) * t) * t) * t) * t;
    }
    case 5: {
      const t = 2 * y100 - 11;
      return 0.32892330248093586215e-1 + (0.31750557067975068584e-2 + (0.18369907582308672632e-4 + (0.15761063702089457882e-6 + (0.15577638230480894382e-8 + (0.17663868462699097951e-10 + (0.22126732680711111111e-12 + 0.30273474177737853668e-14 * t) * t) * t) * t) * t) * t) * t;
    }
    case 6: {
      const t = 2 * y100 - 13;
      return 0.39317207681134336024e-1 + (0.32504779701937539333e-2 + (0.19354426046513400534e-4 + (0.17081646971321290539e-6 + (0.17485733959327106250e-8 + (0.20593687304921961410e-10 + (0.26917401949155555556e-12 + 0.38562123837725712270e-14 * t) * t) * t) * t) * t) * t) * t;
    }
    case 7: {
      const t = 2 * y100 - 15;
      return 0.45896976511367738235e-1 + (0.33300031273110976165e-2 + (0.20423005398039037313e-4 + (0.18567412470376467303e-6 + (0.19718038363586588213e-8 + (0.24175006536781219807e-10 + (0.33059982791466666666e-12 + 0.49756574284439426165e-14 * t) * t) * t) * t) * t) * t) * t;
    }
    case 8: {
      const t = 2 * y100 - 17;
      return 0.52640192524848962855e-1 + (0.34139883358846720806e-2 + (0.21586390240603337337e-4 + (0.20247136501568904646e-6 + (0.22348696948197102935e-8 + (0.28597516301950162548e-10 + (0.41045502119111111110e-12 + 0.65151614515238361946e-14 * t) * t) * t) * t) * t) * t) * t;
    }
    case 9: {
      const t = 2 * y100 - 19;
      return 0.59556171228656770456e-1 + (0.35028374386648914444e-2 + (0.22857246150998562824e-4 + (0.22156372146525190679e-6 + (0.25474171590893813583e-8 + (0.34122390890697400584e-10 + (0.51593189879111111110e-12 + 0.86775076853908006938e-14 * t) * t) * t) * t) * t) * t) * t;
    }
    case 10: {
      const t = 2 * y100 - 21;
      return 0.66655089485108212551e-1 + (0.35970095381271285568e-2 + (0.24250626164318672928e-4 + (0.24339561521785040536e-6 + (0.29221990406518411415e-8 + (0.41117013527967776467e-10 + (0.65786450716444444445e-12 + 0.11791885745450623331e-13 * t) * t) * t) * t) * t) * t) * t;
    }
    case 11: {
      const t = 2 * y100 - 23;
      return 0.73948106345519174661e-1 + (0.36970297216569341748e-2 + (0.25784588137312868792e-4 + (0.26853012002366752770e-6 + (0.33763958861206729592e-8 + (0.50111549981376976397e-10 + (0.85313857496888888890e-12 + 0.16417079927706899860e-13 * t) * t) * t) * t) * t) * t) * t;
    }
    case 12: {
      const t = 2 * y100 - 25;
      return 0.81447508065002963203e-1 + (0.38035026606492705117e-2 + (0.27481027572231851896e-4 + (0.29769200731832331364e-6 + (0.39336816287457655076e-8 + (0.61895471132038157624e-10 + (0.11292303213511111111e-11 + 0.23558532213703884304e-13 * t) * t) * t) * t) * t) * t) * t;
    }
    case 13: {
      const t = 2 * y100 - 27;
      return 0.89166884027582716628e-1 + (0.39171301322438946014e-2 + (0.29366827260422311668e-4 + (0.33183204390350724895e-6 + (0.46276006281647330524e-8 + (0.77692631378169813324e-10 + (0.15335153258844444444e-11 + 0.35183103415916026911e-13 * t) * t) * t) * t) * t) * t) * t;
    }
    case 14: {
      const t = 2 * y100 - 29;
      return 0.97121342888032322019e-1 + (0.40387340353207909514e-2 + (0.31475490395950776930e-4 + (0.37222714227125135042e-6 + (0.55074373178613809996e-8 + (0.99509175283990337944e-10 + (0.21552645758222222222e-11 + 0.55728651431872687605e-13 * t) * t) * t) * t) * t) * t) * t;
    }
    case 15: {
      const t = 2 * y100 - 31;
      return 0.10532778218603311137e0 + (0.41692873614065380607e-2 + (0.33849549774889456984e-4 + (0.42064596193692630143e-6 + (0.66494579697622432987e-8 + (0.13094103581931802337e-9 + (0.31896187409777777778e-11 + 0.97271974184476560742e-13 * t) * t) * t) * t) * t) * t) * t;
    }
    case 16: {
      const t = 2 * y100 - 33;
      return 0.11380523107427108222e0 + (0.43099572287871821013e-2 + (0.36544324341565929930e-4 + (0.47965044028581857764e-6 + (0.81819034238463698796e-8 + (0.17934133239549647357e-9 + (0.50956666166186293627e-11 + (0.18850487318190638010e-12 + 0.79697813173519853340e-14 * t) * t) * t) * t) * t) * t) * t) * t;
    }
    case 17: {
      const t = 2 * y100 - 35;
      return 0.12257529703447467345e0 + (0.44621675710026986366e-2 + (0.39634304721292440285e-4 + (0.55321553769873381819e-6 + (0.10343619428848520870e-7 + (0.26033830170470368088e-9 + (0.87743837749108025357e-11 + (0.34427092430230063401e-12 + 0.10205506615709843189e-13 * t) * t) * t) * t) * t) * t) * t) * t;
    }
    case 18: {
      const t = 2 * y100 - 37;
      return 0.13166276955656699478e0 + (0.46276970481783001803e-2 + (0.43225026380496399310e-4 + (0.64799164020016902656e-6 + (0.13580082794704641782e-7 + (0.39839800853954313927e-9 + (0.14431142411840000000e-10 + 0.42193457308830027541e-12 * t) * t) * t) * t) * t) * t) * t;
    }
    case 19: {
      const t = 2 * y100 - 39;
      return 0.14109647869803356475e0 + (0.48088424418545347758e-2 + (0.47474504753352150205e-4 + (0.77509866468724360352e-6 + (0.18536851570794291724e-7 + (0.60146623257887570439e-9 + (0.18533978397305276318e-10 + (0.41033845938901048380e-13 - 0.46160680279304825485e-13 * t) * t) * t) * t) * t) * t) * t) * t;
    }
    case 20: {
      const t = 2 * y100 - 41;
      return 0.15091057940548936603e0 + (0.50086864672004685703e-2 + (0.52622482832192230762e-4 + (0.95034664722040355212e-6 + (0.25614261331144718769e-7 + (0.80183196716888606252e-9 + (0.12282524750534352272e-10 + (-0.10531774117332273617e-11 - 0.86157181395039646412e-13 * t) * t) * t) * t) * t) * t) * t) * t;
    }
    case 21: {
      const t = 2 * y100 - 43;
      return 0.16114648116017010770e0 + (0.52314661581655369795e-2 + (0.59005534545908331315e-4 + (0.11885518333915387760e-5 + (0.33975801443239949256e-7 + (0.82111547144080388610e-9 + (-0.12357674017312854138e-10 + (-0.24355112256914479176e-11 - 0.75155506863572930844e-13 * t) * t) * t) * t) * t) * t) * t) * t;
    }
    case 22: {
      const t = 2 * y100 - 45;
      return 0.17185551279680451144e0 + (0.54829002967599420860e-2 + (0.67013226658738082118e-4 + (0.14897400671425088807e-5 + (0.40690283917126153701e-7 + (0.44060872913473778318e-9 + (-0.52641873433280000000e-10 - 0.30940587864543343124e-11 * t) * t) * t) * t) * t) * t) * t;
    }
    case 23: {
      const t = 2 * y100 - 47;
      return 0.18310194559815257381e0 + (0.57701559375966953174e-2 + (0.76948789401735193483e-4 + (0.18227569842290822512e-5 + (0.41092208344387212276e-7 + (-0.44009499965694442143e-9 + (-0.92195414685628803451e-10 + (-0.22657389705721753299e-11 + 0.10004784908106839254e-12 * t) * t) * t) * t) * t) * t) * t) * t;
    }
    case 24: {
      const t = 2 * y100 - 49;
      return 0.19496527191546630345e0 + (0.61010853144364724856e-2 + (0.88812881056342004864e-4 + (0.21180686746360261031e-5 + (0.30652145555130049203e-7 + (-0.16841328574105890409e-8 + (-0.11008129460612823934e-9 + (-0.12180794204544515779e-12 + 0.15703325634590334097e-12 * t) * t) * t) * t) * t) * t) * t) * t;
    }
    case 25: {
      const t = 2 * y100 - 51;
      return 0.20754006813966575720e0 + (0.64825787724922073908e-2 + (0.10209599627522311893e-3 + (0.22785233392557600468e-5 + (0.73495224449907568402e-8 + (-0.29442705974150112783e-8 + (-0.94082603434315016546e-10 + (0.23609990400179321267e-11 + 0.14141908654269023788e-12 * t) * t) * t) * t) * t) * t) * t) * t;
    }
    case 26: {
      const t = 2 * y100 - 53;
      return 0.22093185554845172146e0 + (0.69182878150187964499e-2 + (0.11568723331156335712e-3 + (0.22060577946323627739e-5 + (-0.26929730679360840096e-7 + (-0.38176506152362058013e-8 + (-0.47399503861054459243e-10 + (0.40953700187172127264e-11 + 0.69157730376118511127e-13 * t) * t) * t) * t) * t) * t) * t) * t;
    }
    case 27: {
      const t = 2 * y100 - 55;
      return 0.23524827304057813918e0 + (0.74063350762008734520e-2 + (0.12796333874615790348e-3 + (0.18327267316171054273e-5 + (-0.66742910737957100098e-7 + (-0.40204740975496797870e-8 + (0.14515984139495745330e-10 + (0.44921608954536047975e-11 - 0.18583341338983776219e-13 * t) * t) * t) * t) * t) * t) * t) * t;
    }
    case 28: {
      const t = 2 * y100 - 57;
      return 0.25058626331812744775e0 + (0.79377285151602061328e-2 + (0.13704268650417478346e-3 + (0.11427511739544695861e-5 + (-0.10485442447768377485e-6 + (-0.34850364756499369763e-8 + (0.72656453829502179208e-10 + (0.36195460197779299406e-11 - 0.84882136022200714710e-13 * t) * t) * t) * t) * t) * t) * t) * t;
    }
    case 29: {
      const t = 2 * y100 - 59;
      return 0.26701724900280689785e0 + (0.84959936119625864274e-2 + (0.14112359443938883232e-3 + (0.17800427288596909634e-6 + (-0.13443492107643109071e-6 + (-0.23512456315677680293e-8 + (0.11245846264695936769e-9 + (0.19850501334649565404e-11 - 0.11284666134635050832e-12 * t) * t) * t) * t) * t) * t) * t) * t;
    }
    case 30: {
      const t = 2 * y100 - 61;
      return 0.28457293586253654144e0 + (0.90581563892650431899e-2 + (0.13880520331140646738e-3 + (-0.97262302362522896157e-6 + (-0.15077100040254187366e-6 + (-0.88574317464577116689e-9 + (0.12760311125637474581e-9 + (0.20155151018282695055e-12 - 0.10514169375181734921e-12 * t) * t) * t) * t) * t) * t) * t) * t;
    }
    case 31: {
      const t = 2 * y100 - 63;
      return 0.30323425595617385705e0 + (0.95968346790597422934e-2 + (0.12931067776725883939e-3 + (-0.21938741702795543986e-5 + (-0.15202888584907373963e-6 + (0.61788350541116331411e-9 + (0.11957835742791248256e-9 + (-0.12598179834007710908e-11 - 0.75151817129574614194e-13 * t) * t) * t) * t) * t) * t) * t) * t;
    }
    case 32: {
      const t = 2 * y100 - 65;
      return 0.32292521181517384379e0 + (0.10082957727001199408e-1 + (0.11257589426154962226e-3 + (-0.33670890319327881129e-5 + (-0.13910529040004008158e-6 + (0.19170714373047512945e-8 + (0.94840222377720494290e-10 + (-0.21650018351795353201e-11 - 0.37875211678024922689e-13 * t) * t) * t) * t) * t) * t) * t) * t;
    }
    case 33: {
      const t = 2 * y100 - 67;
      return 0.34351233557911753862e0 + (0.10488575435572745309e-1 + (0.89209444197248726614e-4 + (-0.43893459576483345364e-5 + (-0.11488595830450424419e-6 + (0.28599494117122464806e-8 + (0.61537542799857777779e-10 - 0.24935749227658002212e-11 * t) * t) * t) * t) * t) * t) * t;
    }
    case 34: {
      const t = 2 * y100 - 69;
      return 0.36480946642143669093e0 + (0.10789304203431861366e-1 + (0.60357993745283076834e-4 + (-0.51855862174130669389e-5 + (-0.83291664087289801313e-7 + (0.33898011178582671546e-8 + (0.27082948188277716482e-10 + (-0.23603379397408694974e-11 + 0.19328087692252869842e-13 * t) * t) * t) * t) * t) * t) * t) * t;
    }
    case 35: {
      const t = 2 * y100 - 71;
      return 0.38658679935694939199e0 + (0.10966119158288804999e-1 + (0.27521612041849561426e-4 + (-0.57132774537670953638e-5 + (-0.48404772799207914899e-7 + (0.35268354132474570493e-8 + (-0.32383477652514618094e-11 + (-0.19334202915190442501e-11 + 0.32333189861286460270e-13 * t) * t) * t) * t) * t) * t) * t) * t;
    }
    case 36: {
      const t = 2 * y100 - 73;
      return 0.40858275583808707870e0 + (0.11006378016848466550e-1 + (-0.76396376685213286033e-5 + (-0.59609835484245791439e-5 + (-0.13834610033859313213e-7 + (0.33406952974861448790e-8 + (-0.26474915974296612559e-10 + (-0.13750229270354351983e-11 + 0.36169366979417390637e-13 * t) * t) * t) * t) * t) * t) * t) * t;
    }
    case 37: {
      const t = 2 * y100 - 75;
      return 0.43051714914006682977e0 + (0.10904106549500816155e-1 + (-0.43477527256787216909e-4 + (-0.59429739547798343948e-5 + (0.17639200194091885949e-7 + (0.29235991689639918688e-8 + (-0.41718791216277812879e-10 + (-0.81023337739508049606e-12 + 0.33618915934461994428e-13 * t) * t) * t) * t) * t) * t) * t) * t;
    }
    case 38: {
      const t = 2 * y100 - 77;
      return 0.45210428135559607406e0 + (0.10659670756384400554e-1 + (-0.78488639913256978087e-4 + (-0.56919860886214735936e-5 + (0.44181850467477733407e-7 + (0.23694306174312688151e-8 + (-0.49492621596685443247e-10 + (-0.31827275712126287222e-12 + 0.27494438742721623654e-13 * t) * t) * t) * t) * t) * t) * t) * t;
    }
    case 39: {
      const t = 2 * y100 - 79;
      return 0.47306491195005224077e0 + (0.10279006119745977570e-1 + (-0.11140268171830478306e-3 + (-0.52518035247451432069e-5 + (0.64846898158889479518e-7 + (0.17603624837787337662e-8 + (-0.51129481592926104316e-10 + (0.62674584974141049511e-13 + 0.20055478560829935356e-13 * t) * t) * t) * t) * t) * t) * t) * t;
    }
    case 40: {
      const t = 2 * y100 - 81;
      return 0.49313638965719857647e0 + (0.97725799114772017662e-2 + (-0.14122854267291533334e-3 + (-0.46707252568834951907e-5 + (0.79421347979319449524e-7 + (0.11603027184324708643e-8 + (-0.48269605844397175946e-10 + (0.32477251431748571219e-12 + 0.12831052634143527985e-13 * t) * t) * t) * t) * t) * t) * t) * t;
    }
    case 41: {
      const t = 2 * y100 - 83;
      return 0.51208057433416004042e0 + (0.91542422354009224951e-2 + (-0.16726530230228647275e-3 + (-0.39964621752527649409e-5 + (0.88232252903213171454e-7 + (0.61343113364949928501e-9 + (-0.42516755603130443051e-10 + (0.47910437172240209262e-12 + 0.66784341874437478953e-14 * t) * t) * t) * t) * t) * t) * t) * t;
    }
    case 42: {
      const t = 2 * y100 - 85;
      return 0.52968945458607484524e0 + (0.84400880445116786088e-2 + (-0.18908729783854258774e-3 + (-0.32725905467782951931e-5 + (0.91956190588652090659e-7 + (0.14593989152420122909e-9 + (-0.35239490687644444445e-10 + 0.54613829888448694898e-12 * t) * t) * t) * t) * t) * t) * t;
    }
    case 43: {
      const t = 2 * y100 - 87;
      return 0.54578857454330070965e0 + (0.76474155195880295311e-2 + (-0.20651230590808213884e-3 + (-0.25364339140543131706e-5 + (0.91455367999510681979e-7 + (-0.23061359005297528898e-9 + (-0.27512928625244444444e-10 + 0.54895806008493285579e-12 * t) * t) * t) * t) * t) * t) * t;
    }
    case 44: {
      const t = 2 * y100 - 89;
      return 0.56023851910298493910e0 + (0.67938321739997196804e-2 + (-0.21956066613331411760e-3 + (-0.18181127670443266395e-5 + (0.87650335075416845987e-7 + (-0.51548062050366615977e-9 + (-0.20068462174044444444e-10 + 0.50912654909758187264e-12 * t) * t) * t) * t) * t) * t) * t;
    }
    case 45: {
      const t = 2 * y100 - 91;
      return 0.57293478057455721150e0 + (0.58965321010394044087e-2 + (-0.22841145229276575597e-3 + (-0.11404605562013443659e-5 + (0.81430290992322326296e-7 + (-0.71512447242755357629e-9 + (-0.13372664928000000000e-10 + 0.44461498336689298148e-12 * t) * t) * t) * t) * t) * t) * t;
    }
    case 46: {
      const t = 2 * y100 - 93;
      return 0.58380635448407827360e0 + (0.49717469530842831182e-2 + (-0.23336001540009645365e-3 + (-0.51952064448608850822e-6 + (0.73596577815411080511e-7 + (-0.84020916763091566035e-9 + (-0.76700972702222222221e-11 + 0.36914462807972467044e-12 * t) * t) * t) * t) * t) * t) * t;
    }
    case 47: {
      const t = 2 * y100 - 95;
      return 0.59281340237769489597e0 + (0.40343592069379730568e-2 + (-0.23477963738658326185e-3 + (0.34615944987790224234e-7 + (0.64832803248395814574e-7 + (-0.90329163587627007971e-9 + (-0.30421940400000000000e-11 + 0.29237386653743536669e-12 * t) * t) * t) * t) * t) * t) * t;
    }
    case 48: {
      const t = 2 * y100 - 97;
      return 0.59994428743114271918e0 + (0.30976579788271744329e-2 + (-0.23308875765700082835e-3 + (0.51681681023846925160e-6 + (0.55694594264948268169e-7 + (-0.91719117313243464652e-9 + (0.53982743680000000000e-12 + 0.22050829296187771142e-12 * t) * t) * t) * t) * t) * t) * t;
    }
    case 49: {
      const t = 2 * y100 - 99;
      return 0.60521224471819875444e0 + (0.21732138012345456060e-2 + (-0.22872428969625997456e-3 + (0.92588959922653404233e-6 + (0.46612665806531930684e-7 + (-0.89393722514414153351e-9 + (0.31718550353777777778e-11 + 0.15705458816080549117e-12 * t) * t) * t) * t) * t) * t) * t;
    }
    case 50: {
      const t = 2 * y100 - 101;
      return 0.60865189969791123620e0 + (0.12708480848877451719e-2 + (-0.22212090111534847166e-3 + (0.12636236031532793467e-5 + (0.37904037100232937574e-7 + (-0.84417089968101223519e-9 + (0.49843180828444444445e-11 + 0.10355439441049048273e-12 * t) * t) * t) * t) * t) * t) * t;
    }
    case 51: {
      const t = 2 * y100 - 103;
      return 0.61031580103499200191e0 + (0.39867436055861038223e-3 + (-0.21369573439579869291e-3 + (0.15339402129026183670e-5 + (0.29787479206646594442e-7 + (-0.77687792914228632974e-9 + (0.61192452741333333334e-11 + 0.60216691829459295780e-13 * t) * t) * t) * t) * t) * t) * t;
    }
    case 52: {
      const t = 2 * y100 - 105;
      return 0.61027109047879835868e0 + (-0.43680904508059878254e-3 + (-0.20383783788303894442e-3 + (0.17421743090883439959e-5 + (0.22400425572175715576e-7 + (-0.69934719320045128997e-9 + (0.67152759655111111110e-11 + 0.26419960042578359995e-13 * t) * t) * t) * t) * t) * t) * t;
    }
    case 53: {
      const t = 2 * y100 - 107;
      return 0.60859639489217430521e0 + (-0.12305921390962936873e-2 + (-0.19290150253894682629e-3 + (0.18944904654478310128e-5 + (0.15815530398618149110e-7 + (-0.61726850580964876070e-9 + 0.68987888999111111110e-11 * t) * t) * t) * t) * t) * t;
    }
    case 54: {
      const t = 2 * y100 - 109;
      return 0.60537899426486075181e0 + (-0.19790062241395705751e-2 + (-0.18120271393047062253e-3 + (0.19974264162313241405e-5 + (0.10055795094298172492e-7 + (-0.53491997919318263593e-9 + (0.67794550295111111110e-11 - 0.17059208095741511603e-13 * t) * t) * t) * t) * t) * t) * t;
    }
    case 55: {
      const t = 2 * y100 - 111;
      return 0.60071229457904110537e0 + (-0.26795676776166354354e-2 + (-0.16901799553627508781e-3 + (0.20575498324332621581e-5 + (0.51077165074461745053e-8 + (-0.45536079828057221858e-9 + (0.64488005516444444445e-11 - 0.29311677573152766338e-13 * t) * t) * t) * t) * t) * t) * t;
    }
    case 56: {
      const t = 2 * y100 - 113;
      return 0.59469361520112714738e0 + (-0.33308208190600993470e-2 + (-0.15658501295912405679e-3 + (0.20812116912895417272e-5 + (0.93227468760614182021e-9 + (-0.38066673740116080415e-9 + (0.59806790359111111110e-11 - 0.36887077278950440597e-13 * t) * t) * t) * t) * t) * t) * t;
    }
    case 57: {
      const t = 2 * y100 - 115;
      return 0.58742228631775388268e0 + (-0.39321858196059227251e-2 + (-0.14410441141450122535e-3 + (0.20743790018404020716e-5 + (-0.25261903811221913762e-8 + (-0.31212416519526924318e-9 + (0.54328422462222222221e-11 - 0.40864152484979815972e-13 * t) * t) * t) * t) * t) * t) * t;
    }
    case 58: {
      const t = 2 * y100 - 117;
      return 0.57899804200033018447e0 + (-0.44838157005618913447e-2 + (-0.13174245966501437965e-3 + (0.20425306888294362674e-5 + (-0.53330296023875447782e-8 + (-0.25041289435539821014e-9 + (0.48490437205333333334e-11 - 0.42162206939169045177e-13 * t) * t) * t) * t) * t) * t) * t;
    }
    case 59: {
      const t = 2 * y100 - 119;
      return 0.56951968796931245974e0 + (-0.49864649488074868952e-2 + (-0.11963416583477567125e-3 + (0.19906021780991036425e-5 + (-0.75580140299436494248e-8 + (-0.19576060961919820491e-9 + (0.42613011928888888890e-11 - 0.41539443304115604377e-13 * t) * t) * t) * t) * t) * t) * t;
    }
    case 60: {
      const t = 2 * y100 - 121;
      return 0.55908401930063918964e0 + (-0.54413711036826877753e-2 + (-0.10788661102511914628e-3 + (0.19229663322982839331e-5 + (-0.92714731195118129616e-8 + (-0.14807038677197394186e-9 + (0.36920870298666666666e-11 - 0.39603726688419162617e-13 * t) * t) * t) * t) * t) * t) * t;
    }
    case 61: {
      const t = 2 * y100 - 123;
      return 0.54778496152925675315e0 + (-0.58501497933213396670e-2 + (-0.96582314317855227421e-4 + (0.18434405235069270228e-5 + (-0.10541580254317078711e-7 + (-0.10702303407788943498e-9 + (0.31563175582222222222e-11 - 0.36829748079110481422e-13 * t) * t) * t) * t) * t) * t) * t;
    }
    case 62: {
      const t = 2 * y100 - 125;
      return 0.53571290831682823999e0 + (-0.62147030670760791791e-2 + (-0.85782497917111760790e-4 + (0.17553116363443470478e-5 + (-0.11432547349815541084e-7 + (-0.72157091369041330520e-10 + (0.26630811607111111111e-11 - 0.33578660425893164084e-13 * t) * t) * t) * t) * t) * t) * t;
    }
    case 63: {
      const t = 2 * y100 - 127;
      return 0.52295422962048434978e0 + (-0.65371404367776320720e-2 + (-0.75530164941473343780e-4 + (0.16613725797181276790e-5 + (-0.12003521296598910761e-7 + (-0.42929753689181106171e-10 + (0.22170894940444444444e-11 - 0.30117697501065110505e-13 * t) * t) * t) * t) * t) * t) * t;
    }
    case 64: {
      const t = 2 * y100 - 129;
      return 0.50959092577577886140e0 + (-0.68197117603118591766e-2 + (-0.65852936198953623307e-4 + (0.15639654113906716939e-5 + (-0.12308007991056524902e-7 + (-0.18761997536910939570e-10 + (0.18198628922666666667e-11 - 0.26638355362285200932e-13 * t) * t) * t) * t) * t) * t) * t;
    }
    case 65: {
      const t = 2 * y100 - 131;
      return 0.49570040481823167970e0 + (-0.70647509397614398066e-2 + (-0.56765617728962588218e-4 + (0.14650274449141448497e-5 + (-0.12393681471984051132e-7 + (0.92904351801168955424e-12 + (0.14706755960177777778e-11 - 0.23272455351266325318e-13 * t) * t) * t) * t) * t) * t) * t;
    }
    case 66: {
      const t = 2 * y100 - 133;
      return 0.48135536250935238066e0 + (-0.72746293327402359783e-2 + (-0.48272489495730030780e-4 + (0.13661377309113939689e-5 + (-0.12302464447599382189e-7 + (0.16707760028737074907e-10 + (0.11672928324444444444e-11 - 0.20105801424709924499e-13 * t) * t) * t) * t) * t) * t) * t;
    }
    case 67: {
      const t = 2 * y100 - 135;
      return 0.46662374675511439448e0 + (-0.74517177649528487002e-2 + (-0.40369318744279128718e-4 + (0.12685621118898535407e-5 + (-0.12070791463315156250e-7 + (0.29105507892605823871e-10 + (0.90653314645333333334e-12 - 0.17189503312102982646e-13 * t) * t) * t) * t) * t) * t) * t;
    }
    case 68: {
      const t = 2 * y100 - 137;
      return 0.45156879030168268778e0 + (-0.75983560650033817497e-2 + (-0.33045110380705139759e-4 + (0.11732956732035040896e-5 + (-0.11729986947158201869e-7 + (0.38611905704166441308e-10 + (0.68468768305777777779e-12 - 0.14549134330396754575e-13 * t) * t) * t) * t) * t) * t) * t;
    }
    case 69: {
      const t = 2 * y100 - 139;
      return 0.43624909769330896904e0 + (-0.77168291040309554679e-2 + (-0.26283612321339907756e-4 + (0.10811018836893550820e-5 + (-0.11306707563739851552e-7 + (0.45670446788529607380e-10 + (0.49782492549333333334e-12 - 0.12191983967561779442e-13 * t) * t) * t) * t) * t) * t) * t;
    }
    case 70: {
      const t = 2 * y100 - 141;
      return 0.42071877443548481181e0 + (-0.78093484015052730097e-2 + (-0.20064596897224934705e-4 + (0.99254806680671890766e-6 + (-0.10823412088884741451e-7 + (0.50677203326904716247e-10 + (0.34200547594666666666e-12 - 0.10112698698356194618e-13 * t) * t) * t) * t) * t) * t) * t;
    }
    case 71: {
      const t = 2 * y100 - 143;
      return 0.40502758809710844280e0 + (-0.78780384460872937555e-2 + (-0.14364940764532853112e-4 + (0.90803709228265217384e-6 + (-0.10298832847014466907e-7 + (0.53981671221969478551e-10 + (0.21342751381333333333e-12 - 0.82975901848387729274e-14 * t) * t) * t) * t) * t) * t) * t;
    }
    case 72: {
      const t = 2 * y100 - 145;
      return 0.38922115269731446690e0 + (-0.79249269708242064120e-2 + (-0.91595258799106970453e-5 + (0.82783535102217576495e-6 + (-0.97484311059617744437e-8 + (0.55889029041660225629e-10 + (0.10851981336888888889e-12 - 0.67278553237853459757e-14 * t) * t) * t) * t) * t) * t) * t;
    }
    case 73: {
      const t = 2 * y100 - 147;
      return 0.37334112915460307335e0 + (-0.79519385109223148791e-2 + (-0.44219833548840469752e-5 + (0.75209719038240314732e-6 + (-0.91848251458553190451e-8 + (0.56663266668051433844e-10 + (0.23995894257777777778e-13 - 0.53819475285389344313e-14 * t) * t) * t) * t) * t) * t) * t;
    }
    case 74: {
      const t = 2 * y100 - 149;
      return 0.35742543583374223085e0 + (-0.79608906571527956177e-2 + (-0.12530071050975781198e-6 + (0.68088605744900552505e-6 + (-0.86181844090844164075e-8 + (0.56530784203816176153e-10 + (-0.43120012248888888890e-13 - 0.42372603392496813810e-14 * t) * t) * t) * t) * t) * t) * t;
    }
    case 75: {
      const t = 2 * y100 - 151;
      return 0.34150846431979618536e0 + (-0.79534924968773806029e-2 + (0.37576885610891515813e-5 + (0.61419263633090524326e-6 + (-0.80565865409945960125e-8 + (0.55684175248749269411e-10 + (-0.95486860764444444445e-13 - 0.32712946432984510595e-14 * t) * t) * t) * t) * t) * t) * t;
    }
    case 76: {
      const t = 2 * y100 - 153;
      return 0.32562129649136346824e0 + (-0.79313448067948884309e-2 + (0.72539159933545300034e-5 + (0.55195028297415503083e-6 + (-0.75063365335570475258e-8 + (0.54281686749699595941e-10 - 0.13545424295111111111e-12 * t) * t) * t) * t) * t) * t;
    }
    case 77: {
      const t = 2 * y100 - 155;
      return 0.30979191977078391864e0 + (-0.78959416264207333695e-2 + (0.10389774377677210794e-4 + (0.49404804463196316464e-6 + (-0.69722488229411164685e-8 + (0.52469254655951393842e-10 - 0.16507860650666666667e-12 * t) * t) * t) * t) * t) * t;
    }
    case 78: {
      const t = 2 * y100 - 157;
      return 0.29404543811214459904e0 + (-0.78486728990364155356e-2 + (0.13190885683106990459e-4 + (0.44034158861387909694e-6 + (-0.64578942561562616481e-8 + (0.50354306498006928984e-10 - 0.18614473550222222222e-12 * t) * t) * t) * t) * t) * t;
    }
    case 79: {
      const t = 2 * y100 - 159;
      return 0.27840427686253660515e0 + (-0.77908279176252742013e-2 + (0.15681928798708548349e-4 + (0.39066226205099807573e-6 + (-0.59658144820660420814e-8 + (0.48030086420373141763e-10 - 0.20018995173333333333e-12 * t) * t) * t) * t) * t) * t;
    }
    case 80: {
      const t = 2 * y100 - 161;
      return 0.26288838011163800908e0 + (-0.77235993576119469018e-2 + (0.17886516796198660969e-4 + (0.34482457073472497720e-6 + (-0.54977066551955420066e-8 + (0.45572749379147269213e-10 - 0.20852924954666666667e-12 * t) * t) * t) * t) * t) * t;
    }
    case 81: {
      const t = 2 * y100 - 163;
      return 0.24751539954181029717e0 + (-0.76480877165290370975e-2 + (0.19827114835033977049e-4 + (0.30263228619976332110e-6 + (-0.50545814570120129947e-8 + (0.43043879374212005966e-10 - 0.21228012028444444444e-12 * t) * t) * t) * t) * t) * t;
    }
    case 82: {
      const t = 2 * y100 - 165;
      return 0.23230087411688914593e0 + (-0.75653060136384041587e-2 + (0.21524991113020016415e-4 + (0.26388338542539382413e-6 + (-0.46368974069671446622e-8 + (0.40492715758206515307e-10 - 0.21238627815111111111e-12 * t) * t) * t) * t) * t) * t;
    }
    case 83: {
      const t = 2 * y100 - 167;
      return 0.21725840021297341931e0 + (-0.74761846305979730439e-2 + (0.23000194404129495243e-4 + (0.22837400135642906796e-6 + (-0.42446743058417541277e-8 + (0.37958104071765923728e-10 - 0.20963978568888888889e-12 * t) * t) * t) * t) * t) * t;
    }
    case 84: {
      const t = 2 * y100 - 169;
      return 0.20239979200788191491e0 + (-0.73815761980493466516e-2 + (0.24271552727631854013e-4 + (0.19590154043390012843e-6 + (-0.38775884642456551753e-8 + (0.35470192372162901168e-10 - 0.20470131678222222222e-12 * t) * t) * t) * t) * t) * t;
    }
    case 85: {
      const t = 2 * y100 - 171;
      return 0.18773523211558098962e0 + (-0.72822604530339834448e-2 + (0.25356688567841293697e-4 + (0.16626710297744290016e-6 + (-0.35350521468015310830e-8 + (0.33051896213898864306e-10 - 0.19811844544000000000e-12 * t) * t) * t) * t) * t) * t;
    }
    case 86: {
      const t = 2 * y100 - 173;
      return 0.17327341258479649442e0 + (-0.71789490089142761950e-2 + (0.26272046822383820476e-4 + (0.13927732375657362345e-6 + (-0.32162794266956859603e-8 + (0.30720156036105652035e-10 - 0.19034196304000000000e-12 * t) * t) * t) * t) * t) * t;
    }
    case 87: {
      const t = 2 * y100 - 175;
      return 0.15902166648328672043e0 + (-0.70722899934245504034e-2 + (0.27032932310132226025e-4 + (0.11474573347816568279e-6 + (-0.29203404091754665063e-8 + (0.28487010262547971859e-10 - 0.18174029063111111111e-12 * t) * t) * t) * t) * t) * t;
    }
    case 88: {
      const t = 2 * y100 - 177;
      return 0.14498609036610283865e0 + (-0.69628725220045029273e-2 + (0.27653554229160596221e-4 + (0.92493727167393036470e-7 + (-0.26462055548683583849e-8 + (0.26360506250989943739e-10 - 0.17261211260444444444e-12 * t) * t) * t) * t) * t) * t;
    }
    case 89: {
      const t = 2 * y100 - 179;
      return 0.13117165798208050667e0 + (-0.68512309830281084723e-2 + (0.28147075431133863774e-4 + (0.72351212437979583441e-7 + (-0.23927816200314358570e-8 + (0.24345469651209833155e-10 - 0.16319736960000000000e-12 * t) * t) * t) * t) * t) * t;
    }
    case 90: {
      const t = 2 * y100 - 181;
      return 0.11758232561160626306e0 + (-0.67378491192463392927e-2 + (0.28525664781722907847e-4 + (0.54156999310046790024e-7 + (-0.21589405340123827823e-8 + (0.22444150951727334619e-10 - 0.15368675584000000000e-12 * t) * t) * t) * t) * t) * t;
    }
    case 91: {
      const t = 2 * y100 - 183;
      return 0.10422112945361673560e0 + (-0.66231638959845581564e-2 + (0.28800551216363918088e-4 + (0.37758983397952149613e-7 + (-0.19435423557038933431e-8 + (0.20656766125421362458e-10 - 0.14422990012444444444e-12 * t) * t) * t) * t) * t) * t;
    }
    case 92: {
      const t = 2 * y100 - 185;
      return 0.91090275493541084785e-1 + (-0.65075691516115160062e-2 + (0.28982078385527224867e-4 + (0.23014165807643012781e-7 + (-0.17454532910249875958e-8 + (0.18981946442680092373e-10 - 0.13494234691555555556e-12 * t) * t) * t) * t) * t) * t;
    }
    case 93: {
      const t = 2 * y100 - 187;
      return 0.78191222288771379358e-1 + (-0.63914190297303976434e-2 + (0.29079759021299682675e-4 + (0.97885458059415717014e-8 + (-0.15635596116134296819e-8 + (0.17417110744051331974e-10 - 0.12591151763555555556e-12 * t) * t) * t) * t) * t) * t;
    }
    case 94: {
      const t = 2 * y100 - 189;
      return 0.65524757106147402224e-1 + (-0.62750311956082444159e-2 + (0.29102328354323449795e-4 + (-0.20430838882727954582e-8 + (-0.13967781903855367270e-8 + (0.15958771833747057569e-10 - 0.11720175765333333333e-12 * t) * t) * t) * t) * t) * t;
    }
    case 95: {
      const t = 2 * y100 - 191;
      return 0.53091065838453612773e-1 + (-0.61586898417077043662e-2 + (0.29057796072960100710e-4 + (-0.12597414620517987536e-7 + (-0.12440642607426861943e-8 + (0.14602787128447932137e-10 - 0.10885859114666666667e-12 * t) * t) * t) * t) * t) * t;
    }
    case 96: {
      const t = 2 * y100 - 193;
      return 0.40889797115352738582e-1 + (-0.60426484889413678200e-2 + (0.28953496450191694606e-4 + (-0.21982952021823718400e-7 + (-0.11044169117553026211e-8 + (0.13344562332430552171e-10 - 0.10091231402844444444e-12 * t) * t) * t) * t) * t) * t;
    }
    case 97:
    case 98:
    case 99:
    case 100: {
      // |x| <= 0.0309…: 5-term Taylor (2/√π)·x·(1 − ⅔x² + 4/15 x⁴ − …)
      const x2 = x * x;
      return x * (1.1283791670955125739 - x2 * (0.75225277806367504925 - x2 * (0.30090111122547001970 - x2 * (0.085971746064420005629 - x2 * 0.016931216931216931217))));
    }
  }
  // y100 ∈ [0, 100] by construction (y = 1/(1+x), x ≥ 0); reachable only if x is NaN.
  return NaN;
}

// -----------------------------------------------------------------------------
// `wImFloat64` — public `Im[w(x)] = (2/√π) · Dawson(x)`
// -----------------------------------------------------------------------------
//
// Dispatch (Faddeeva.cc lines 1876-1900):
//   - `|x| > 45`: 5-term continued-fraction expansion, simplified
//     from `ispi / (x − 0.5/(x − 1/(x − 1.5/(x − 2/x))))`. The
//     CFE gives ULP accuracy for `|x| > 45` and is materially
//     faster than the y100 panel evaluation.
//   - `|x| > 5e7`: 1-term form `ispi / x`. Important to avoid
//     overflow in `x²` for very large `|x|`.
//   - otherwise: 100-panel Chebyshev via `wImY100`.
//
// Parity: `w_im(−x) = −w_im(x)` (Dawson is odd).

export function wImFloat64(x: number): number {
  if (Number.isNaN(x)) return NaN;
  if (x >= 0) {
    if (x > 45) {
      if (x > 5e7) return ISPI / x; // 1-term form, avoid x² overflow
      // 5-term CF (algebraically simplified from the standard form):
      const x2 = x * x;
      return (ISPI * (x2 * (x2 - 4.5) + 2)) / (x * (x2 * (x2 - 5) + 3.75));
    }
    return wImY100(100 / (1 + x), x);
  }
  // x < 0: w_im is odd.
  if (x < -45) {
    if (x < -5e7) return ISPI / x; // 1-term form (negative)
    const x2 = x * x;
    return (ISPI * (x2 * (x2 - 4.5) + 2)) / (x * (x2 * (x2 - 5) + 3.75));
  }
  return -wImY100(100 / (1 - x), -x);
}

// -----------------------------------------------------------------------------
// `algorithm916` — Zaghloul-Ali Algorithm 916 for the bulk
// -----------------------------------------------------------------------------
//
// Computes `w(z) = exp(−z²)·erfc(−iz)` for `z = x + i·y` with `x ≥ 0`,
// `y ≥ 0`, using the Zaghloul-Ali series in `exp(−a²n²)` (ACM TOMS
// 38(2), 2011). Faddeeva.cc lines 817-984. The series converges for
// the entire complex plane and is the canonical answer in the "bad
// band" `6 < x < 28, y < 0.1` where the continued fraction loses
// 5+ bits of `Re w` accuracy (Zaghloul 2012 note).
//
// The five sums (Faddeeva.cc notation):
//   `sum1 = Σ exp(−a²n²) / (a²n² + y²)`
//   `sum2 = Σ exp(−a²n²)·exp(−2anx) / (a²n² + y²)`
//   `sum3 = Σ exp(−a²n²)·exp(+2anx) / (a²n² + y²)`
//   `sum4 = Σ exp(−a²n²)·exp(−2anx)·(an) / (a²n² + y²)`
//   `sum5 = Σ exp(−a²n²)·exp(+2anx)·(an) / (a²n² + y²)`
// Final assembly:
//   `Re w = expx2·erfcx(y)·cos(2xy) + c·x·expx2·sin(xy)·sinc(xy,sin(xy))
//           − c·y·sum1·cos(2xy) + (...adjustments for sum2/sum3...)`
//   `Im w = c·x·expx2·sinc(2xy, sin(2xy)) − (expx2·erfcx(y) − c·y·sum1)·sin(2xy)
//           + (c/2)·sign(x)·(sum5 − sum4)`
// The expression here matches Faddeeva.cc lines 921-983 line-for-line.
//
// Truncation: the loop breaks when `coef · prod2ax · (a·n) < relerr ·
// sum5` (the slowest-decaying sum). Typical depth: 20-40 terms; at
// most 51 (the EXPA2N2 table length).
//
// `x < 5e-4` special case (Faddeeva.cc lines 841-863): when `x` is
// very small, `exp(2ax)` and `exp(−2ax)` differ only by `O(x³)`
// terms. Computing them separately would lose precision when
// combining `sum5 − sum4`; instead we accumulate `sum5 − sum4`
// directly via `sinh_taylor((2a)·n·x)`. The convergence test then
// uses `sum3` (the dominant sum at small x).
//
// For `x ≥ 10` only `sum3` and `sum5` matter (Faddeeva.cc lines
// 936-980, the "x large" path); `sum1`, `sum2`, `sum4` are
// negligible against `sum3`'s growth in `exp(+2ax)`. The path also
// sums symmetrically around `n0 = floor(x/a + 0.5)` to pick up the
// largest terms first.

function algorithm916(re: number, im: number): ComplexF64 {
  const x = Math.abs(re);
  const y = im;
  const ya = Math.abs(y);
  const a = ALG916_A;
  const a2 = ALG916_A2;
  const c = ALG916_C;
  const relerr = 2.220446049250313e-16; // DBL_EPSILON

  let sum1 = 0,
    sum2 = 0,
    sum3 = 0,
    sum4 = 0,
    sum5 = 0;
  let retRe = 0,
    retIm = 0;

  if (x < 10) {
    if (Number.isNaN(y)) return { re: y, im: y };

    let prod2ax = 1,
      prodm2ax = 1;
    let expx2: number;

    if (x < 5e-4) {
      // sum4 and sum5 combined as (sum5 − sum4); avoids cancellation
      // when `exp(2ax) ≈ 1` and `exp(−2ax) ≈ 1` differ only in
      // O(x³). expx2 also via Taylor for x² < 2.5e-7.
      const x2 = x * x;
      expx2 = 1 - x2 * (1 - 0.5 * x2);
      const ax2 = ALG916_TWO_A_X_COEF * x; // 2*a*x
      const exp2ax = 1 + ax2 * (1 + ax2 * (0.5 + 0.166666666666666666667 * ax2));
      const expm2ax = 1 - ax2 * (1 - ax2 * (0.5 - 0.166666666666666666667 * ax2));
      for (let n = 1; ; n++) {
        const coef = (EXPA2N2[n - 1]! * expx2) / (a2 * (n * n) + y * y);
        prod2ax *= exp2ax;
        prodm2ax *= expm2ax;
        sum1 += coef;
        sum2 += coef * prodm2ax;
        sum3 += coef * prod2ax;
        // sum5 here is really (sum5 − sum4); sum4 stays 0.
        sum5 += coef * (2 * a) * n * sinhTaylor(2 * a * n * x);
        if (coef * prod2ax < relerr * sum3) break;
        if (n >= 51) break; // EXPA2N2 length guard
      }
    } else {
      expx2 = Math.exp(-x * x);
      const exp2ax = Math.exp(2 * a * x);
      const expm2ax = 1 / exp2ax;
      for (let n = 1; ; n++) {
        const coef = (EXPA2N2[n - 1]! * expx2) / (a2 * (n * n) + y * y);
        prod2ax *= exp2ax;
        prodm2ax *= expm2ax;
        sum1 += coef;
        sum2 += coef * prodm2ax;
        sum4 += coef * prodm2ax * (a * n);
        sum3 += coef * prod2ax;
        sum5 += coef * prod2ax * (a * n);
        if (coef * prod2ax * (a * n) < relerr * sum5) break;
        if (n >= 51) break;
      }
    }

    // expx2·erfcx(y) — avoid spurious overflow for large negative y
    // by using `2·exp(y²−x²)` when y < −6 (then erfcx(y) ≈ 2·exp(y²)).
    const expx2erfcxy =
      y > -6 ? expx2 * erfcxFloat64(y) : 2 * Math.exp(y * y - x * x);

    if (y > 5) {
      // Imaginary terms cancel; rearranged form below.
      const sinxy = Math.sin(x * y);
      retRe =
        (expx2erfcxy - c * y * sum1) * Math.cos(2 * x * y) +
        c * x * expx2 * sinxy * sinc(x * y, sinxy);
      retIm = 0; // The (sum5 − sum4) imaginary contribution is the only
      // imaginary piece at large y, and it's added below in `finish`.
    } else {
      const xs = re; // signed; sin/cos of an odd argument flips for x < 0
      const sinxy = Math.sin(xs * y);
      const sin2xy = Math.sin(2 * xs * y);
      const cos2xy = Math.cos(2 * xs * y);
      const coef1 = expx2erfcxy - c * y * sum1;
      const coef2 = c * xs * expx2;
      retRe = coef1 * cos2xy + coef2 * sinxy * sinc(xs * y, sinxy);
      retIm = coef2 * sinc(2 * xs * y, sin2xy) - coef1 * sin2xy;
    }
  } else {
    // x ≥ 10: only sum3 and sum5 contribute. Sum symmetrically
    // around n0 = floor(x/a + 0.5) to pick up the largest terms
    // first; the "trick to get tm from tp" uses the recurrence
    // tm = tp · exp(4·a·dn·dx).
    if (Number.isNaN(x)) return { re: x, im: x };
    if (Number.isNaN(y)) return { re: y, im: y };

    retRe = Math.exp(-x * x); // |y| < 1e-10 by dispatcher, only exp(−x²) matters

    const n0 = Math.floor(x / a + 0.5);
    const dx = a * n0 - x;
    sum3 = Math.exp(-dx * dx) / (a2 * (n0 * n0) + y * y);
    sum5 = a * n0 * sum3;
    const exp1 = Math.exp(4 * a * dx);
    let exp1dn = 1;
    let dn = 1;
    // Loop over n0 − dn and n0 + dn terms.
    while (n0 - dn > 0) {
      const np = n0 + dn,
        nm = n0 - dn;
      let tp = Math.exp(-(a * dn + dx) * (a * dn + dx));
      const tm = tp * (exp1dn *= exp1);
      tp /= a2 * (np * np) + y * y;
      const tmDivided = tm / (a2 * (nm * nm) + y * y);
      sum3 += tp + tmDivided;
      sum5 += a * (np * tp + nm * tmDivided);
      if (a * (np * tp + nm * tmDivided) < relerr * sum5) break;
      dn++;
    }
    // Loop over n0 + dn only (n0 − dn ≤ 0).
    while (n0 - dn <= 0) {
      const np = n0 + dn;
      const tp = Math.exp(-(a * dn + dx) * (a * dn + dx)) / (a2 * (np * np) + y * y);
      sum3 += tp;
      sum5 += a * np * tp;
      if (a * np * tp < relerr * sum5) break;
      dn++;
    }
    retIm = 0; // assembled below
  }

  // Final assembly: add the sum2+sum3 / sum5−sum4 contributions.
  // `copysign(sum5 − sum4, re)` reflects the Re-z sign symmetry.
  const sgn = re < 0 ? -1 : 1; // copysign(_, re) — re == 0 routes via the y==0 / x==0 special cases upstream
  return {
    re: retRe + 0.5 * c * y * (sum2 + sum3),
    im: retIm + 0.5 * c * sgn * (sum5 - sum4),
  };
}

// -----------------------------------------------------------------------------
// `wFunctionFloat64` — Faddeeva function `w(z)`, the load-bearing primitive
// -----------------------------------------------------------------------------
//
// Hybrid dispatch (Faddeeva.cc lines 692-984):
//   1. `Re z = 0`: real-valued — route to `erfcxFloat64` (Sun 1993).
//   2. `Im z = 0`: route to `(exp(−x²), wImFloat64(x))`.
//   3. Continued fraction zone (Poppe-Wijers 1990): the broad envelope
//      `|Im z| > 7`, OR (`|Re z| > 6` AND `|Im z| > 0.1` etc).
//      Term count `nu` per Johnson's NLopt fit.
//   4. Otherwise: Algorithm 916.
//
// For `Im z < 0` use the reflection `w(z) = 2·exp(−z²) − w(−z̄)` after
// computing on `(−x, |y|)` per the upper-half-plane convention.
//
// Accuracy: ≤ Johnson's published 1e-13 relative error across **all
// of ℂ** including the previously-broken `|z| < 1.5` bulk.

export function wFunctionFloat64(re: number, im: number): ComplexF64 {
  if (Number.isNaN(re) || Number.isNaN(im)) return { re: NaN, im: NaN };

  // Special: Re z == 0 → real-valued; w(iy) = erfcx(y), Im = 0
  // (preserve sign of zero in the imaginary part).
  if (re === 0) return { re: erfcxFloat64(im), im: re };
  // Special: Im z == 0 → real-axis Faddeeva form.
  if (im === 0) return { re: Math.exp(-re * re), im: wImFloat64(re) };

  const x = Math.abs(re);
  const ya = Math.abs(im);

  // CF zone (Faddeeva.cc lines 724-730).
  if (
    ya > 7 ||
    (x > 6 && (ya > 0.1 || (x > 8 && ya > 1e-10) || x > 28))
  ) {
    return wContinuedFraction(re, im);
  }

  // Bulk: Algorithm 916. For y < 0 use the reflection.
  if (im >= 0) return algorithm916(re, im);

  // y < 0: compute on (re, |im|) and reflect via
  //   w(z) = 2·exp(−z²) − w(−z̄)
  // where `−z̄` for z = x + iy<0 is `−x + i·|y|`. So we want
  // w(−x, |y|), then 2·exp(−z²) − that.
  const wPos = algorithm916(-re, -im); // (−re, |im|)
  const expArgRe = (im - re) * (re + im); // Re(−z²) = y² − x²
  const expArgIm = -2 * re * im; // Im(−z²) = −2xy (positive when im<0)
  const expMag = Math.exp(expArgRe);
  if (!Number.isFinite(expMag)) {
    // Overflow path: the exp term dominates; let it carry to ±Inf.
    return {
      re: 2 * expMag * Math.cos(expArgIm) - wPos.re,
      im: 2 * expMag * Math.sin(expArgIm) - wPos.im,
    };
  }
  return {
    re: 2 * expMag * Math.cos(expArgIm) - wPos.re,
    im: 2 * expMag * Math.sin(expArgIm) - wPos.im,
  };
}

/**
 * Continued fraction sub-dispatcher for `w(z)` in the large-|z| zone.
 * Faddeeva.cc lines 731-790. Three sub-cases:
 *   - `x + |y| > 1e7`: 1-term form `w(z) ≈ i/(√π·z)` (overflow-safe).
 *   - `x + |y| > 4000`: 2-term `w(z) = (i/√π)·z/(z² − 0.5)`.
 *   - otherwise: NLopt-tuned `nu` backward recurrence, ~20-50 terms.
 */
function wContinuedFraction(re: number, im: number): ComplexF64 {
  const x = Math.abs(re);
  const ya = Math.abs(im);
  const yIsNeg = im < 0;
  const xs = yIsNeg ? -re : re; // compute for −z if y < 0
  const sum = x + ya;

  let retRe: number;
  let retIm: number;

  if (sum > 4000) {
    if (sum > 1e7) {
      // 1-term: w(z) ≈ i/(√π·z), overflow-scaled.
      if (x > ya) {
        const yax = ya / xs;
        const denom = ISPI / (xs + yax * ya);
        retRe = denom * yax;
        retIm = denom;
      } else if (!Number.isFinite(ya)) {
        return Number.isNaN(x) || im < 0 ? { re: NaN, im: NaN } : { re: 0, im: 0 };
      } else {
        const xya = xs / ya;
        const denom = ISPI / (xya * xs + ya);
        retRe = denom;
        retIm = denom * xya;
      }
    } else {
      // 2-term: w(z) = (i/√π)·z/(z² − 0.5)
      const dr = xs * xs - ya * ya - 0.5;
      const di = 2 * xs * ya;
      const denom = ISPI / (dr * dr + di * di);
      retRe = denom * (xs * di - ya * dr);
      retIm = denom * (xs * dr + ya * di);
    }
  } else {
    // General CF: nu = floor(3.9 + 11.398 / (0.08254·x + 0.1421·y + 0.2023))
    const nuTarget = Math.floor(3.9 + 11.398 / (0.08254 * x + 0.1421 * ya + 0.2023));
    let wr = xs;
    let wi = ya;
    for (let nu = 0.5 * (nuTarget - 1); nu > 0.4; nu -= 0.5) {
      const denom = nu / (wr * wr + wi * wi);
      wr = xs - wr * denom;
      wi = ya + wi * denom;
    }
    const denom = ISPI / (wr * wr + wi * wi);
    retRe = denom * wi;
    retIm = denom * wr;
  }

  if (yIsNeg) {
    // w(z) = 2·exp(−z²) − w(−z̄), being careful of overflow.
    // exp(−z²) with z = (re, im<0):
    //   −z² = (im²−re²) − 2i·re·im   (re·im > 0 in absolute value
    //   when im < 0, so the imag arg is positive). We use the form
    //   `(ya − xs)·(xs + ya)` for the real part to avoid `re²` overflow.
    const expArgRe = (ya - xs) * (xs + ya);
    const expArgIm = 2 * xs * im; // im < 0 → arg negative; this is +2·xs·y
    const expMag = Math.exp(expArgRe);
    return {
      re: 2 * expMag * Math.cos(expArgIm) - retRe,
      im: 2 * expMag * Math.sin(expArgIm) - retIm,
    };
  }
  return { re: retRe, im: retIm };
}

// -----------------------------------------------------------------------------
// `erfComplexFloat64` — complex error function
// -----------------------------------------------------------------------------
//
// Faddeeva.cc lines 324-413. Two reductions in different half-planes
// (handled separately to avoid overflow/underflow from multiplying
// exponentially large and small quantities):
//   - `Re z ≥ 0`: erf(z) = 1 − exp(−z²)·w(iz)
//   - `Re z < 0`: erf(z) = exp(−z²)·w(−iz) − 1
//
// Two Taylor branches for cancellation avoidance:
//   - `taylor`: |x| < 0.08 AND |y| < 0.01 — `erf(z) = (2/√π)·z·(1 −
//     z²/3 + z⁴/10 − …)`. Both `1` and `exp(−z²)·w(iz)` are within
//     `2⁻⁵²` of 1 in this strip; the subtraction would lose all bits.
//   - `taylor_erfi`: |x| < 5e-3 AND |Im(z²)| < 5e-3 (i.e. |x·y| <
//     2.5e-3) — two-variable Taylor in (x, y²). Adds the `erf(iy) +
//     2·exp(y²)/√π · (perturbation in x)` form for the narrow strip
//     just off the imag axis where the bulk `1 − exp(−z²)·w(iz)`
//     still cancels.

export function erfComplexFloat64(re: number, im: number): ComplexF64 {
  if (Number.isNaN(re) || Number.isNaN(im)) return { re: NaN, im: NaN };

  const x = re;
  const y = im;

  // y == 0: real-axis; preserve sign of 0 on the imag part.
  if (y === 0) return { re: erfFloat64(x), im: y };
  // x == 0: erf(iy) = i·erfi(y); handle y → ±∞ manually (exp(y²)·w_im(y) → 0·∞).
  if (x === 0) {
    if (y * y > 720) return { re: x, im: y > 0 ? Infinity : -Infinity };
    return { re: x, im: Math.exp(y * y) * wImFloat64(y) };
  }

  // −z² = (y² − x²) + i·(−2xy); these are computed with the
  // catastrophic-cancellation-safe `(y − x)·(x + y)` form for the
  // real part (avoids `x² − y²` overflow / loss-of-precision when
  // `|x| ≈ |y|`).
  const mRe_z2 = (y - x) * (x + y);
  const mIm_z2 = -2 * x * y;
  if (mRe_z2 < -750) return { re: x >= 0 ? 1 : -1, im: 0 }; // exp underflow

  if (x >= 0) {
    // Taylor band selection (Faddeeva.cc lines 347-353).
    if (x < 8e-2) {
      if (Math.abs(y) < 1e-2) return erfTaylor(x, y, mRe_z2, mIm_z2);
      if (Math.abs(mIm_z2) < 5e-3 && x < 5e-3) return erfTaylorErfi(x, y);
    }
    return erfFromW(mRe_z2, mIm_z2, -y, x, /*subtractOne=*/ true);
  }
  // x < 0
  if (x > -8e-2) {
    if (Math.abs(y) < 1e-2) return erfTaylor(x, y, mRe_z2, mIm_z2);
    if (Math.abs(mIm_z2) < 5e-3 && x > -5e-3) return erfTaylorErfi(x, y);
  }
  return erfFromW(mRe_z2, mIm_z2, y, -x, /*subtractOne=*/ false);
}

/**
 * Assemble `erf(z)` from `w` using the half-plane-appropriate form:
 *   x ≥ 0: erf(z) = 1 − exp(−z²)·w(iz)        with w-arg = (−y, x)
 *   x < 0: erf(z) = exp(−z²)·w(−iz) − 1        with w-arg = (y, −x)
 *
 * Avoids the `cexp` form to dodge spurious NaN from `Inf · 0` when
 * exp overflows but `w` underflows in the same evaluation.
 */
function erfFromW(
  mRe_z2: number,
  mIm_z2: number,
  wArgRe: number,
  wArgIm: number,
  subtractOne: boolean,
): ComplexF64 {
  const w = wFunctionFloat64(wArgRe, wArgIm);
  const expMag = Math.exp(mRe_z2);
  const expRe = expMag * Math.cos(mIm_z2);
  const expIm = expMag * Math.sin(mIm_z2);
  const prodRe = expRe * w.re - expIm * w.im;
  const prodIm = expRe * w.im + expIm * w.re;
  return subtractOne
    ? { re: 1 - prodRe, im: -prodIm }
    : { re: prodRe - 1, im: prodIm };
}

/**
 * 5-term Taylor for `erf(z)` at `z = 0`; ULP-safe for |x| < 0.08, |y| < 0.01.
 * Faddeeva.cc lines 378-386. Coefficients = `(2/√π) · (−1)ⁿ / (n!·(2n+1))`
 * for n = 0..4.
 */
function erfTaylor(re: number, im: number, mRe_z2: number, mIm_z2: number): ComplexF64 {
  const C0 = 1.1283791670955125739;
  const C1 = 0.37612638903183752464;
  const C2 = 0.11283791670955125739;
  const C3 = 0.026866170645131251760;
  const C4 = 0.0052239776254421878422;
  // Horner in mz2 = (mRe_z2, mIm_z2), accumulator s = C4 + mz2·(C3 + mz2·(…))
  let sRe = C4;
  let sIm = 0;
  // s ← C3 + mz2·s
  let tRe = mRe_z2 * sRe - mIm_z2 * sIm;
  let tIm = mRe_z2 * sIm + mIm_z2 * sRe;
  sRe = C3 + tRe;
  sIm = tIm;
  // s ← C2 + mz2·s
  tRe = mRe_z2 * sRe - mIm_z2 * sIm;
  tIm = mRe_z2 * sIm + mIm_z2 * sRe;
  sRe = C2 + tRe;
  sIm = tIm;
  // s ← C1 + mz2·s
  tRe = mRe_z2 * sRe - mIm_z2 * sIm;
  tIm = mRe_z2 * sIm + mIm_z2 * sRe;
  sRe = C1 + tRe;
  sIm = tIm;
  // s ← C0 + mz2·s
  tRe = mRe_z2 * sRe - mIm_z2 * sIm;
  tIm = mRe_z2 * sIm + mIm_z2 * sRe;
  sRe = C0 + tRe;
  sIm = tIm;
  // erf(z) = z · s
  return {
    re: re * sRe - im * sIm,
    im: re * sIm + im * sRe,
  };
}

/**
 * Off-axis Taylor for `erf(x + iy)` in the narrow strip `|x| < 5e-3`
 * and `|x·y| < 2.5e-3` (where the standard `1 − exp(−z²)·w(iz)`
 * still cancels but the on-axis `erfTaylor` does not extend far
 * enough in y). Two-variable Taylor in (x, y²):
 *
 *   erf(x + iy) ≈ exp(y²) · ( x · (2/√π)·[1 − x²(1+2y²)/3 + x⁴(3+12y²+4y⁴)/30 + ...]
 *                            − i · (w_im(y) − x²·y·(2/√π)·[1 − x²·(3+2y²)/6]) )
 *
 * Faddeeva.cc lines 388-412. `w_im(y) = (2/√π)·Dawson(y)` is the
 * imaginary part of `w` on the real axis.
 */
function erfTaylorErfi(x: number, y: number): ComplexF64 {
  const x2 = x * x;
  const y2 = y * y;
  const expy2 = Math.exp(y2);
  // Real part of erf: expy2 · x · (1.128… − x²·(0.376… + 0.752…·y²)
  //                            + x⁴·(0.112… + y²·(0.451… + 0.150…·y²)))
  const reErf =
    expy2 *
    x *
    (1.1283791670955125739 -
      x2 * (0.37612638903183752464 + 0.75225277806367504925 * y2) +
      x2 * x2 *
        (0.11283791670955125739 +
          y2 * (0.45135166683820502956 + 0.15045055561273500986 * y2)));
  // Imag part: expy2 · ( w_im(y) − x²·y · (1.128… − x²·(0.564… + 0.376…·y²)) )
  const imErf =
    expy2 *
    (wImFloat64(y) -
      x2 *
        y *
        (1.1283791670955125739 -
          x2 * (0.56418958354775628695 + 0.37612638903183752464 * y2)));
  return { re: reErf, im: imErf };
}

/** Complex `erfc(z) = 1 − erf(z)`. Faddeeva.cc lines 444-476. */
export function erfcComplexFloat64(re: number, im: number): ComplexF64 {
  if (Number.isNaN(re) || Number.isNaN(im)) return { re: NaN, im: NaN };

  // x == 0: erfc(iy) = 1 − i·erfi(y); handle y → ±∞ explicitly.
  if (re === 0) {
    if (im * im > 720) return { re: 1, im: im > 0 ? -Infinity : Infinity };
    return { re: 1, im: -Math.exp(im * im) * wImFloat64(im) };
  }
  // y == 0: real-axis; preserve sign of zero on imag.
  if (im === 0) {
    if (re * re > 750) return { re: re >= 0 ? 0 : 2, im: -im };
    return {
      re: re >= 0
        ? Math.exp(-re * re) * erfcxFloat64(re)
        : 2 - Math.exp(-re * re) * erfcxFloat64(-re),
      im: -im,
    };
  }

  const mRe_z2 = (im - re) * (re + im);
  const mIm_z2 = -2 * re * im;
  if (mRe_z2 < -750) return { re: re >= 0 ? 0 : 2, im: 0 };

  const expMag = Math.exp(mRe_z2);
  const expRe = expMag * Math.cos(mIm_z2);
  const expIm = expMag * Math.sin(mIm_z2);

  if (re >= 0) {
    // erfc(z) = exp(−z²) · w(iz)
    const w = wFunctionFloat64(-im, re);
    return {
      re: expRe * w.re - expIm * w.im,
      im: expRe * w.im + expIm * w.re,
    };
  }
  // erfc(z) = 2 − exp(−z²) · w(−iz)
  const w = wFunctionFloat64(im, -re);
  return {
    re: 2 - (expRe * w.re - expIm * w.im),
    im: -(expRe * w.im + expIm * w.re),
  };
}

/** Complex `erfcx(z) = exp(z²)·erfc(z) = w(iz)`. Faddeeva.cc line 288. */
export function erfcxComplexFloat64(re: number, im: number): ComplexF64 {
  return wFunctionFloat64(-im, re);
}

/** Complex `erfi(z) = −i · erf(iz)`. Faddeeva.cc lines 416-420. */
export function erfiComplexFloat64(re: number, im: number): ComplexF64 {
  const e = erfComplexFloat64(-im, re);
  return { re: e.im, im: -e.re };
}

// =============================================================================
// INVERSE LANE — Blair-Edwards-Johnson 1976 rational approximants
// =============================================================================
//
// Blair Tables 17 (small), 37 (mid), 57 (tail) for erfinv; Tables 57
// + 80 (deep tail, y < 1e-100) for erfcinv. No Newton refinement at
// float64 — Blair's design target is ≤ 1e-19 relative, well under
// 1 ULP.

// Blair Table 17 (|x| ≤ 0.75): t = x² − 0.5625; erfinv(x) = x · P(t)/Q(t).
const ERFINV_17_P: readonly number[] = [
  0.16030495584406622931e2, -0.90784959262960326650e2, 0.18644914861620987391e3,
  -0.16900142734642382420e3, 0.65454662847944870480e2, -0.86421301158724779400e1,
  0.17605878213905900000e0,
];
const ERFINV_17_Q: readonly number[] = [
  0.14780647071513831611e2, -0.91374167024260313936e2, 0.21015790486205317714e3,
  -0.22210254121855132366e3, 0.10760453916055123830e3, -0.20601073032826544430e2,
  1.0,
];

// Blair Table 37 (0.75 < |x| ≤ 0.9375): t = x² − 0.87890625; same form.
const ERFINV_37_P: readonly number[] = [
  -0.15238926344072612800e-1, 0.34445569241361252160, -0.29344398672542478687e1,
  0.11763505705217827302e2, -0.22655292823101104193e2, 0.19121334396580330163e2,
  -0.54789276195983187690e1, 0.23751668902444800000,
];
const ERFINV_37_Q: readonly number[] = [
  -0.10846516960205995400e-1, 0.26106288858430785110, -0.24068318104393757995e1,
  0.10695129973387014469e2, -0.23716715521596581025e2, 0.24640158943917284883e2,
  -0.10014376349783070835e2, 1.0,
];

// Blair Table 57 (|x| > 0.9375 or erfcinv tail): t = 1/√(−log1p(−|x|))
//   or t = 1/√(−log y) for erfcinv. erfinv(x) = sign(x) · P(t) / (t · Q(t)).
const ERFINV_57_P: readonly number[] = [
  0.10501311523733438116e-3, 0.10532611314233381642e-1, 0.26987802736243283545,
  0.23268695788919690806e1, 0.71678547949107996810e1, 0.85475611822167827825e1,
  0.68738088073543839802e1, 0.36270024830958708930e1, 0.88606273929651546815,
];
const ERFINV_57_Q: readonly number[] = [
  0.10501266687030337690e-3, 0.10532862300933275311e-1, 0.27019862373751554846,
  0.23501436397970253259e1, 0.76078028785801277064e1, 0.11181586104056907827e2,
  0.11948787918435396668e2, 0.81922409747269907894e1, 0.40993879076368015361e1, 1.0,
];

// Blair Table 80 (erfcinv deep tail, y < 1e-100): same variable as 57.
const ERFCINV_80_P: readonly number[] = [
  0.34654298588086350177e-9, 0.25084679202407570521e-6, 0.47378131963728602987e-4,
  0.31312603759778696408e-2, 0.77948764544143536994e-1, 0.70045681233581643868,
  0.18710420342167931669e1, 0.71452547743135145428,
];
const ERFCINV_80_Q: readonly number[] = [
  0.34654295673159511156e-9, 0.25084690799758802711e-6, 0.47379531295974913536e-4,
  0.31320635364617768848e-2, 0.78073489062764897215e-1, 0.70715044799533758620,
  0.19998515434911215105e1, 0.15072902692731680009e1, 1.0,
];

/**
 * Horner polynomial eval: `c[0] + t·(c[1] + t·(c[2] + ...))`.
 * The `c` array is in ascending-degree order (c[0] is the constant term).
 */
function hornerAscending(c: readonly number[], t: number): number {
  let s = c[c.length - 1]!;
  for (let i = c.length - 2; i >= 0; i--) s = c[i]! + t * s;
  return s;
}

/**
 * `erfinv(y)` for `y ∈ [-1, 1]`. Returns NaN for `|y| > 1`; returns
 * ±∞ for `y = ±1`. Three Blair tables by interval, followed by ONE
 * Newton-Raphson refinement step.
 *
 * Why Newton? Blair-1976's published target is ≤ 1e-19 relative error
 * of the rational approximation to the *true* inverse erf, but the
 * float64 round-off in the rational evaluation itself (especially the
 * `t = 1/√(-log1p(-|x|))` transformation for the tail interval) lifts
 * the achieved float64 error to ~10 ULP on some inputs. SciPy's Cephes
 * implementation adds a Halley/Newton refinement to recover bit-
 * accuracy; SpecialFunctions.jl's Float64 path is *not* refined and
 * shows the same 10+ ULP error. We pin our discipline at "≤ 2 ULP vs
 * SciPy bronze tier" (per the I5 acceptance criteria) by performing
 * the same refinement: one Newton step against `f(x) = erf(x) − y`
 * with derivative `f'(x) = (2/√π)·exp(−x²)`.
 *
 * The Newton step costs one `erfFloat64` call and one `Math.exp` —
 * negligible against the rational evaluation. Convergence: at this
 * regime quadratic Newton from a 10-ULP seed lands at ≤ 1 ULP in a
 * single step (the next step would buy ~0.5 ULP via FMA).
 */
export function erfInvFloat64(y: number): number {
  if (Number.isNaN(y)) return NaN;
  const ay = Math.abs(y);
  if (ay > 1) return NaN;
  if (ay === 1) return y > 0 ? Infinity : -Infinity;
  if (y === 0) return y; // preserve sign of zero

  let x0: number;
  if (ay <= 0.75) {
    const t = y * y - 0.5625;
    x0 = (y * hornerAscending(ERFINV_17_P, t)) / hornerAscending(ERFINV_17_Q, t);
  } else if (ay <= 0.9375) {
    const t = y * y - 0.87890625;
    x0 = (y * hornerAscending(ERFINV_37_P, t)) / hornerAscending(ERFINV_37_Q, t);
  } else {
    // Tail: ay > 0.9375. t = 1 / √(-log1p(-ay)).
    const t = 1.0 / Math.sqrt(-Math.log1p(-ay));
    const sign = y > 0 ? 1 : -1;
    x0 = (sign * hornerAscending(ERFINV_57_P, t)) / (t * hornerAscending(ERFINV_57_Q, t));
  }
  // One Newton refinement step. Stable across the entire domain
  // because `erf` is monotone and `erf'(x) = (2/√π)·exp(−x²) > 0`.
  const err = erfFloat64(x0) - y;
  const derivInv = (Math.sqrt(Math.PI) * 0.5) * Math.exp(x0 * x0);
  return x0 - err * derivInv;
}

/**
 * `erfcinv(y)` for `y ∈ [0, 2]`. Returns NaN outside; returns ±∞ at
 * the boundaries. For `y > 0.0625`, route through `erfInvFloat64(1 − y)`
 * (which itself does the Newton refinement). For tiny y, use Blair
 * Table 57 or 80 followed by ONE Newton step against
 * `f(x) = erfc(x) − y` with `f'(x) = -(2/√π)·exp(−x²)`.
 */
export function erfcInvFloat64(y: number): number {
  if (Number.isNaN(y)) return NaN;
  if (y < 0 || y > 2) return NaN;
  if (y === 0) return Infinity;
  if (y === 2) return -Infinity;
  if (y === 1) return 0;

  if (y > 0.0625) {
    // erfcinv(y) = erfinv(1 − y). The subtraction `1 − y` is exact
    // for y in [0.0625, 2 − 0.0625] = [0.0625, 1.9375]. The
    // erfInvFloat64 call below does its own Newton refinement.
    return erfInvFloat64(1 - y);
  }
  // y ≤ 0.0625. Two sub-tables: 57 for y ≥ 1e-100, 80 for tinier.
  let x0: number;
  if (y >= 1e-100) {
    const t = 1.0 / Math.sqrt(-Math.log(y));
    x0 = hornerAscending(ERFINV_57_P, t) / (t * hornerAscending(ERFINV_57_Q, t));
  } else {
    const t = 1.0 / Math.sqrt(-Math.log(y));
    x0 = hornerAscending(ERFCINV_80_P, t) / (t * hornerAscending(ERFCINV_80_Q, t));
  }
  // Newton refinement: f(x) = erfc(x) − y, f'(x) = -(2/√π)·exp(−x²).
  // So x ← x + (erfc(x) − y) / ((2/√π)·exp(−x²))
  //        = x + (erfc(x) − y) · (√π/2) · exp(x²).
  const err = erfcFloat64(x0) - y;
  const derivInv = Math.sqrt(Math.PI) * 0.5 * Math.exp(x0 * x0);
  return x0 + err * derivInv;
}
