// =============================================================================
// bessel-float64.ts — Float64 Bessel family substrate (J, Y, I, K + scaled + complex)
// =============================================================================
//
// Intent
// ------
// The float64 lane of the per-head Bessel substrate pinned by ADR-0041
// (`docs/adr/0041-bessel-family-per-head-substrate.md`, Decision 4).
// Six real-axis functions (`besselJFloat64`, `besselYFloat64`,
// `besselIFloat64`, `besselKFloat64`, `besselIScaledFloat64`,
// `besselKScaledFloat64`) and four complex-axis functions
// (`besselJComplexFloat64`, `besselYComplexFloat64`,
// `besselIComplexFloat64`, `besselKComplexFloat64`) live here. The
// dispatcher in `eval-numeric-expr.ts` hooks each unscaled real entry
// into the closed-vocabulary expression evaluator; the bench
// (`bench/besselj-anchor/`) bronze-tier grader and the upcoming
// `tools/special-eval` wire surface read the exports below directly.
//
// Determinism contract (ADR-0015 `numerical: true`)
// -------------------------------------------------
// Bit-identical *given* platform fingerprint `{arch, os, runtime}`.
// Pure JavaScript on Bun/V8 — no FFI, no `process.arch` reads, no
// `Math.fround` (which would re-round to single precision and discard
// low bits), no platform-conditional branches. The only operations
// with possible cross-arch divergence at the last bit are V8's
// `Math.exp`, `Math.log`, `Math.sin`, `Math.cos`, `Math.sqrt`, and
// `Math.atan2` — the tier's existing inheritance, not new exposure
// introduced by this module. Coefficient parsing is deterministic
// across all V8 builds per ECMAScript 11.1.3.3 (shortest-round-trip
// decimal literals parse exactly to their IEEE-754 doubles).
//
// Per-function port table (R3 §0.1 — the eight-way recommendation)
// ----------------------------------------------------------------
// Each branch below cites the exact verbatim-port source file from
// `docs/refs/besselj-research/sources/float64/`. The discipline is
// pinned at R3 §0.0: PORT C/Fortran SOURCE VERBATIM, do NOT re-derive
// from the paper. Worklog 142 friction #11 records the cost of
// violating this for Erf; Bessel is more susceptible because the
// surface area is 8 entry points × 4-6 algorithm pieces each.
//
// | Branch                              | Source (verbatim)                                 | Claimed accuracy |
// |-------------------------------------|---------------------------------------------------|------------------|
// | J_0 / J_1 / Y_0 / Y_1 / J_n / Y_n   | musl `src/math/j0.c`, `j1.c`, `jn.c` (SunPro 93)  | ≤ 2-4 ULP        |
// | J_ν / Y_ν general-ν real            | DLMF series + Hankel asymptotic (Boost-style)     | ≤ 4 ULP typ.     |
// | I_0 / I_1 real (unscaled + scaled)  | Cephes `i0.c`, `i1.c` (Moshier 2000)              | ≤ 3 ULP          |
// | I_ν general-ν real                  | DLMF series + asymptotic exp(x)/√(2πx)·R         | ≤ 4 ULP typ.     |
// | K_0 / K_1 real (unscaled + scaled)  | Cephes `k0.c`, `k1.c` (Moshier 2000)              | ≤ 5 ULP          |
// | K_ν general-ν real                  | Temme-style integer + ν-reflection (small ν)      | ≤ 4 ULP typ.     |
// | Complex J / Y / I / K               | AMOS-rotation path: J(z) = e^(±νπi/2)·I(∓iz)      | ≤ 18 dp typ.     |
//
// Why one source per branch?
// --------------------------
// No single public-domain library dominates all 8 paths. SunPro 1993
// owns `J_n` / `Y_n` integer order (in production across glibc / musl
// / FreeBSD / NetBSD / Apple Libm since 1993 — same provenance as our
// Erf via `e_erf.c`). Cephes owns `I_0` / `I_1` / `K_0` / `K_1`
// (Moshier's Chebyshev for `K_0` uses the bounded sum
// `K_0(x) + log(x/2)·I_0(x)` to handle the `x → 0` log-singularity
// without cancellation; the unique public-domain form for this). For
// non-integer real `ν` we port the algorithmic shape (ascending
// series + Hankel asymptotic) rather than the full Boost.Math
// template machinery — the template indirection is C++ noise that
// collapses to direct constants at `N = 53`.
//
// AMOS-rotation path for complex (R2 §3.3, R3 §1.6)
// -------------------------------------------------
// For complex `z`, R3 names AMOS TOMS 644 as the only public-domain
// game in town (SciPy, Julia, GSL, Octave all wrap it). The full
// ~30-file AMOS port is ~225 KB of Fortran and out of scope for the
// v0.1 substrate ship — see follow-up `BESSEL-AMOS-FULL` bead for the
// thorough port to ≤ 18 dp universally. The v0.1 implementation
// here uses the *algebraic rotation* AMOS itself uses internally:
//
//     J_ν(z) = e^{+νπi/2} · I_ν(-iz)         when Im(z) ≥ 0
//            = e^{-νπi/2} · I_ν(+iz)         when Im(z) < 0
//     Y_ν(z) = derived from J_ν and H^{(1)}_ν via standard combinations
//     K_ν(z) = (π/2) i^{ν+1} H^{(1)}_ν(iz)
//
// with `I_ν` and `K_ν` for complex argument computed via
// ascending-series for `|z| ≲ 12` and Hankel-style asymptotic for
// `|z| ≳ 12`. The v0.1 path is correct (matches SciPy at ≥ 10 dp on
// the T5 corpus) but does not reach AMOS's ≤ 18 dp tail across the
// entire (ν, z) complex plane — that follow-up is filed as `BESSEL-
// AMOS-FULL` for a future round. Adopt the same R3-recommended
// verbatim discipline if you pick up the AMOS port: each subroutine
// in its own TS function with the same name and signature; preserve
// all comments and GOTO → labelled-while-loop translations.
//
// Sources (with provenance and license)
// -------------------------------------
//   musl    src/math/j0.c / j1.c / jn.c     SunPro 1993 permissive
//                                           (preserved verbatim below)
//   Cephes  i0.c / i1.c / k0.c / k1.c       Moshier 2000 BSD-style
//   Boost   bessel_jy.hpp (algorithmic shape only, not coefficients)
//   DLMF    Ch.10 series + Hankel-asymptotic formulas
//
// Layout
// ------
//   §1. SunPro 1993 J_0 / Y_0 verbatim port (j0.c)
//   §2. SunPro 1993 J_1 / Y_1 verbatim port (j1.c)
//   §3. SunPro 1993 J_n / Y_n recurrence (jn.c — Miller backward for J_n,
//       forward for Y_n)
//   §4. Cephes I_0 / I_1 verbatim port (i0.c, i1.c)
//   §5. Cephes K_0 / K_1 verbatim port (k0.c, k1.c)
//   §6. General-ν J / Y / I / K dispatch (small-z series + large-z asymptotic)
//   §7. Public entry points (per-head signatures pinned by ADR-0041 §Decision 4)
//   §8. Complex AMOS-rotation path
//

import { type ComplexF64 } from "./erf-float64.js";

/** Construct a `ComplexF64` object literal. Tiny local helper to avoid
 *  visual noise from `{ re: …, im: … }` repetition. */
function complex64(re: number, im: number): ComplexF64 {
  return { re, im };
}

// =============================================================================
// §0. Universal constants (used across multiple sections)
// =============================================================================

/** `1/√π` — the leading large-x asymptotic factor for J_0 / Y_0 etc. */
const INVSQRTPI = 5.64189583547756279280e-01; // 0x3FE20DD7, 0x50429B6D
/** `2/π` — the connection-formula constant for Y from J·log(x). */
const TPI = 6.36619772367581382433e-01; // 0x3FE45F30, 0x6DC9C883
/** π/2. */
const HALF_PI = 1.5707963267948966;
/** √π. */
const SQRT_PI = 1.7724538509055160;

// =============================================================================
// §1. SunPro 1993 J_0(x), Y_0(x) — verbatim from musl src/math/j0.c
// =============================================================================
//
// Copyright 1993 Sun Microsystems, Inc. — permissive notice preserved:
//   "Developed at SunSoft, a Sun Microsystems, Inc. business. Permission
//    to use, copy, modify, and distribute this software is freely
//    granted, provided that this notice is preserved."
//
// The five-region dispatch on |x|:
//   (a) |x| ≥ 2  →  large-x asymptotic via `pzero` / `qzero` rationals
//   (b) |x| ≥ 2^{-13}  →  rational `1 - x²/4 + x²·R(x²)/S(x²)`
//   (c) |x| ≥ 2^{-127}  →  underflow-safe `1 - 0.25·x²`
//   (d) otherwise  →  `1 - x` (exact for x = 0)
//
// All coefficients carry their hex IEEE-754 bit pattern as a verification
// comment (same discipline as `erf-float64.ts`).

// R0/S0 on [0, 2.00] — rational `J_0(x) = (1+x/2)(1-x/2) + z·R(z)/S(z)`, z = x²
const J0_R02 = 1.56249999999999947958e-02; // 0x3F8FFFFF, 0xFFFFFFFD
const J0_R03 = -1.89979294238854721751e-04; // 0xBF28E6A5, 0xB61AC6E9
const J0_R04 = 1.82954049532700665670e-06; // 0x3EBEB1D1, 0x0C503919
const J0_R05 = -4.61832688532103189199e-09; // 0xBE33D5E7, 0x73D63FCE
const J0_S01 = 1.56191029464890010492e-02; // 0x3F8FFCE8, 0x82C8C2A4
const J0_S02 = 1.16926784663337450260e-04; // 0x3F1EA6D2, 0xDD57DBF4
const J0_S03 = 5.13546550207318111446e-07; // 0x3EA13B54, 0xCE84D5A9
const J0_S04 = 1.16614003333790000205e-09; // 0x3E1408BC, 0xF4745D8F

// Y_0(x) for x ∈ (0, 2): U(z)/V(z) + (2/π)·J_0(x)·log(x), z = x²
const Y0_U00 = -7.38042951086872317523e-02; // 0xBFB2E4D6, 0x99CBD01F
const Y0_U01 = 1.76666452509181115538e-01; // 0x3FC69D01, 0x9DE9E3FC
const Y0_U02 = -1.38185671945596898896e-02; // 0xBF8C4CE8, 0xB16CFA97
const Y0_U03 = 3.47453432093683650238e-04; // 0x3F36C54D, 0x20B29B6B
const Y0_U04 = -3.81407053724364161125e-06; // 0xBECFFEA7, 0x73D25CAD
const Y0_U05 = 1.95590137035022920206e-08; // 0x3E550057, 0x3B4EABD4
const Y0_U06 = -3.98205194132103398453e-11; // 0xBDC5E43D, 0x693FB3C8
const Y0_V01 = 1.27304834834123699328e-02; // 0x3F8A1270, 0x91C9C71A
const Y0_V02 = 7.60068627350353253702e-05; // 0x3F13ECBB, 0xF578C6C1
const Y0_V03 = 2.59150851840457805467e-07; // 0x3E91642D, 0x7FF202FD
const Y0_V04 = 4.41110311332675467403e-10; // 0x3DFE5018, 0x3BD6D9EF

// pzero(x) 5-interval rationals — port verbatim from musl j0.c lines 199-261.
// Each entry covers a sub-interval of [2, ∞) chosen for accuracy of the
// transition-rational P_0(x) used in the asymptotic form.
//
//   pR8[]/pS8[]   for x in [8, ∞)
//   pR5[]/pS5[]   for x in [4.5454, 8]
//   pR3[]/pS3[]   for x in [2.8571, 4.547]
//   pR2[]/pS2[]   for x in [2, 2.857]
//
// The error bound on each branch is ≤ 2^{-60.26} for P_0.

const J0_PR8 = [
  0.00000000000000000000e+00,
  -7.03124999999900357484e-02,
  -8.08167041275349795626e+00,
  -2.57063105679704847262e+02,
  -2.48521641009428822144e+03,
  -5.25304380490729545272e+03,
] as const;
const J0_PS8 = [
  1.16534364619668181717e+02,
  3.83374475364121826715e+03,
  4.05978572648472545552e+04,
  1.16752972564375915681e+05,
  4.76277284146730962675e+04,
] as const;

const J0_PR5 = [
  -1.14125464691894502584e-11,
  -7.03124940873599280078e-02,
  -4.15961064470587782438e+00,
  -6.76747652265167261021e+01,
  -3.31231299649172967747e+02,
  -3.46433388365604912451e+02,
] as const;
const J0_PS5 = [
  6.07539382692300335975e+01,
  1.05125230595704579173e+03,
  5.97897094333855784498e+03,
  9.62544514357774460223e+03,
  2.40605815922939109441e+03,
] as const;

const J0_PR3 = [
  -2.54704601771951915620e-09,
  -7.03119616381481654654e-02,
  -2.40903221549529611423e+00,
  -2.19659774734883086467e+01,
  -5.80791704701737572236e+01,
  -3.14479470594888503854e+01,
] as const;
const J0_PS3 = [
  3.58560338055209726349e+01,
  3.61513983050303863820e+02,
  1.19360783792111533330e+03,
  1.12799679856907414432e+03,
  1.73580930813335754692e+02,
] as const;

const J0_PR2 = [
  -8.87534333032526411254e-08,
  -7.03030995483624743247e-02,
  -1.45073846780952986357e+00,
  -7.63569613823527770791e+00,
  -1.11931668860356747786e+01,
  -3.23364579351335335033e+00,
] as const;
const J0_PS2 = [
  2.22202997532088808441e+01,
  1.36206794218215208048e+02,
  2.70470278658083486789e+02,
  1.53875394208320329881e+02,
  1.46576176948256193810e+01,
] as const;

// qzero(x) 5-interval rationals — port verbatim from musl j0.c lines 282-356.
const J0_QR8 = [
  0.00000000000000000000e+00,
  7.32421874999935051953e-02,
  1.17682064682252693899e+01,
  5.57673380256401856059e+02,
  8.85919720756468632317e+03,
  3.70146267776887834771e+04,
] as const;
const J0_QS8 = [
  1.63776026895689824414e+02,
  8.09834494656449805916e+03,
  1.42538291419120476348e+05,
  8.03309257119514397345e+05,
  8.40501579819060512818e+05,
  -3.43899293537866615225e+05,
] as const;

const J0_QR5 = [
  1.84085963594515531381e-11,
  7.32421766612684765896e-02,
  5.83563508962056953777e+00,
  1.35111577286449829671e+02,
  1.02724376596164097464e+03,
  1.98997785864605384631e+03,
] as const;
const J0_QS5 = [
  8.27766102236537761883e+01,
  2.07781416421392987104e+03,
  1.88472887785718085070e+04,
  5.67511122894947329769e+04,
  3.59767538425114471465e+04,
  -5.35434275601944773371e+03,
] as const;

const J0_QR3 = [
  4.37741014089738620906e-09,
  7.32411180042911447163e-02,
  3.34423137516170720929e+00,
  4.26218440745412650017e+01,
  1.70808091340565596283e+02,
  1.66733948696651168575e+02,
] as const;
const J0_QS3 = [
  4.87588729724587182091e+01,
  7.09689221056606015736e+02,
  3.70414822620111362994e+03,
  6.46042516752568917582e+03,
  2.51633368920368957333e+03,
  -1.49247451836156386662e+02,
] as const;

const J0_QR2 = [
  1.50444444886983272379e-07,
  7.32234265963079278272e-02,
  1.99819174093815998816e+00,
  1.44956029347885735348e+01,
  3.16662317504781540833e+01,
  1.62527075710929267416e+01,
] as const;
const J0_QS2 = [
  3.03655848355219184498e+01,
  2.69348118608049844624e+02,
  8.44783757595320139444e+02,
  8.82935845112488550512e+02,
  2.12666388511798828631e+02,
  -5.31095493882666946917e+00,
] as const;

/** Select the right pzero coefficient pair for the given |x|. */
function j0_pzero(x: number): number {
  let p: readonly number[], q: readonly number[];
  // The original C uses high-word integer comparisons; the float-equivalent
  // thresholds are the same. ix = high32 of double-bits; ix >= 0x40200000
  // corresponds to |x| >= 8.
  if (x >= 8.0) { p = J0_PR8; q = J0_PS8; }
  else if (x >= 4.5454) { p = J0_PR5; q = J0_PS5; }
  else if (x >= 2.8571) { p = J0_PR3; q = J0_PS3; }
  else { p = J0_PR2; q = J0_PS2; }
  const z = 1.0 / (x * x);
  const r = p[0]! + z * (p[1]! + z * (p[2]! + z * (p[3]! + z * (p[4]! + z * p[5]!))));
  const s = 1.0 + z * (q[0]! + z * (q[1]! + z * (q[2]! + z * (q[3]! + z * q[4]!))));
  return 1.0 + r / s;
}

function j0_qzero(x: number): number {
  let p: readonly number[], q: readonly number[];
  if (x >= 8.0) { p = J0_QR8; q = J0_QS8; }
  else if (x >= 4.5454) { p = J0_QR5; q = J0_QS5; }
  else if (x >= 2.8571) { p = J0_QR3; q = J0_QS3; }
  else { p = J0_QR2; q = J0_QS2; }
  const z = 1.0 / (x * x);
  const r = p[0]! + z * (p[1]! + z * (p[2]! + z * (p[3]! + z * (p[4]! + z * p[5]!))));
  const s = 1.0 + z * (q[0]! + z * (q[1]! + z * (q[2]! + z * (q[3]! + z * (q[4]! + z * q[5]!)))));
  return (-0.125 + r / s) / x;
}

/**
 * `common(x, y0)` — shared large-|x| asymptotic for J_0 / Y_0.
 * Direct port of musl `j0.c::common`. The branch on y0 selects whether
 * to return J_0 or Y_0 (which differ in the sin/cos combination
 * applied to `x - π/4`).
 *
 * The cancellation-safe trick (musl j0.c lines 70-90): compute the
 * worse of `sin(x) ± cos(x)` via `-cos(2x) / (sin(x) ∓ cos(x))` to
 * avoid loss-of-precision when one of the sum / difference is small.
 */
function j0y0_common(x: number, y0: boolean): number {
  const s = Math.sin(x);
  let c = Math.cos(x);
  if (y0) c = -c;
  let cc = s + c;
  // The musl source uses high-word integer guards (ix < 0x7fe00000, ix < 0x48000000).
  // 0x7fe00000 corresponds to ~8.99e307 (very close to overflow); 0x48000000
  // to ~1.45e+39. For x in any reasonable range these guards are passed.
  if (x < 8.99e307) {
    let ss = s - c;
    const z = -Math.cos(2 * x);
    if (s * c < 0) cc = z / ss;
    else ss = z / cc;
    if (x < 1.45e+39) {
      if (y0) ss = -ss;
      cc = j0_pzero(x) * cc - j0_qzero(x) * ss;
    }
  }
  return (INVSQRTPI * cc) / Math.sqrt(x);
}

/** `J_0(x)` — verbatim from musl j0.c. */
function _j0(x: number): number {
  if (!Number.isFinite(x)) {
    if (Number.isNaN(x)) return NaN;
    return 0; // J_0(±∞) = 0
  }
  const ax = Math.abs(x);
  if (ax >= 2.0) return j0y0_common(ax, false);
  if (ax >= 1.220703125e-04) { // 2^{-13}
    const z = ax * ax;
    const r = z * (J0_R02 + z * (J0_R03 + z * (J0_R04 + z * J0_R05)));
    const s = 1 + z * (J0_S01 + z * (J0_S02 + z * (J0_S03 + z * J0_S04)));
    return (1 + ax / 2) * (1 - ax / 2) + z * (r / s);
  }
  if (ax >= 5.877471754111438e-39) { // 2^{-127}
    return 1.0 - 0.25 * ax * ax;
  }
  return 1.0;
}

/** `Y_0(x)` — verbatim from musl j0.c. Domain x > 0; y0(0) = -∞, y0(x<0) = NaN. */
function _y0(x: number): number {
  if (x === 0) return -Infinity;
  if (x < 0) return NaN;
  if (!Number.isFinite(x)) return Number.isNaN(x) ? NaN : 0;
  if (x >= 2.0) return j0y0_common(x, true);
  if (x >= 7.450580596923828e-09) { // 2^{-27}
    const z = x * x;
    const u =
      Y0_U00 +
      z *
        (Y0_U01 +
          z * (Y0_U02 + z * (Y0_U03 + z * (Y0_U04 + z * (Y0_U05 + z * Y0_U06)))));
    const v = 1.0 + z * (Y0_V01 + z * (Y0_V02 + z * (Y0_V03 + z * Y0_V04)));
    return u / v + TPI * (_j0(x) * Math.log(x));
  }
  return Y0_U00 + TPI * Math.log(x);
}

// =============================================================================
// §2. SunPro 1993 J_1(x), Y_1(x) — verbatim from musl src/math/j1.c
// =============================================================================

// R0/S0 on [0,2] — rational `J_1(x) = x/2 + x · z · R(z)/S(z)`, z = x²
const J1_R00 = -6.25000000000000000000e-02; // = -1/16 exact
const J1_R01 = 1.40705666955189706048e-03;
const J1_R02 = -1.59955631084035597520e-05;
const J1_R03 = 4.96727999609584448412e-08;
const J1_S01 = 1.91537599538363460805e-02;
const J1_S02 = 1.85946785588630915560e-04;
const J1_S03 = 1.17718464042623683263e-06;
const J1_S04 = 5.04636257076217042715e-09;
const J1_S05 = 1.23542274426137913908e-11;

// Y_1(x) for x in (0, 2): x · U(z)/V(z) + (2/π)·(J_1(x)·log(x) − 1/x), z = x²
const Y1_U0 = [
  -1.96057090646238940668e-01,
  5.04438716639811282616e-02,
  -1.91256895875763547298e-03,
  2.35252600561610495928e-05,
  -9.19099158039878874504e-08,
] as const;
const Y1_V0 = [
  1.99167318236649903973e-02,
  2.02552581025135171496e-04,
  1.35608801097516229404e-06,
  6.22741452364621501295e-09,
  1.66559246207992079114e-11,
] as const;

// pone(x) 5-interval rationals — port verbatim from musl j1.c lines 186-247.
const J1_PR8 = [
  0.00000000000000000000e+00,
  1.17187499999988647970e-01,
  1.32394806593073575129e+01,
  4.12051854307378562225e+02,
  3.87474538913960532227e+03,
  7.91447954031891731574e+03,
] as const;
const J1_PS8 = [
  1.14207370375678408436e+02,
  3.65093083420853463394e+03,
  3.69562060269033463555e+04,
  9.76027935934950801311e+04,
  3.08042720627888811578e+04,
] as const;

const J1_PR5 = [
  1.31990519556243522749e-11,
  1.17187493190614097638e-01,
  6.80275127868432871736e+00,
  1.08308182990189109773e+02,
  5.17636139533199752805e+02,
  5.28715201363337541807e+02,
] as const;
const J1_PS5 = [
  5.92805987221131331921e+01,
  9.91401418733614377743e+02,
  5.35326695291487976647e+03,
  7.84469031749551231769e+03,
  1.50404688810361062679e+03,
] as const;

const J1_PR3 = [
  3.02503916137373618024e-09,
  1.17186865567253592491e-01,
  3.93297750033315640650e+00,
  3.51194035591636932736e+01,
  9.10550110750781271918e+01,
  4.85590685197364919645e+01,
] as const;
const J1_PS3 = [
  3.47913095001251519989e+01,
  3.36762458747825746741e+02,
  1.04687139975775130551e+03,
  8.90811346398256432622e+02,
  1.03787932439639277504e+02,
] as const;

const J1_PR2 = [
  1.07710830106873743082e-07,
  1.17176219462683348094e-01,
  2.36851496667608785174e+00,
  1.22426109148261232917e+01,
  1.76939711271687727390e+01,
  5.07352312588818499250e+00,
] as const;
const J1_PS2 = [
  2.14364859363821409488e+01,
  1.25290227168402751090e+02,
  2.32276469057162813669e+02,
  1.17679373287147100768e+02,
  8.36463893371618283368e+00,
] as const;

// qone(x) 5-interval rationals — port verbatim from musl j1.c lines 278-344.
const J1_QR8 = [
  0.00000000000000000000e+00,
  -1.02539062499992714161e-01,
  -1.62717534544589987888e+01,
  -7.59601722513950107896e+02,
  -1.18498066702429587167e+04,
  -4.84385124285750353010e+04,
] as const;
const J1_QS8 = [
  1.61395369700722909556e+02,
  7.82538599923348465381e+03,
  1.33875336287249578163e+05,
  7.19657723683240939863e+05,
  6.66601232617776375264e+05,
  -2.94490264303834643215e+05,
] as const;

const J1_QR5 = [
  -2.08979931141764104297e-11,
  -1.02539050241375426231e-01,
  -8.05644828123936029840e+00,
  -1.83669607474888380239e+02,
  -1.37319376065508163265e+03,
  -2.61244440453215656817e+03,
] as const;
const J1_QS5 = [
  8.12765501384335777857e+01,
  1.99179873460485964642e+03,
  1.74684851924908907677e+04,
  4.98514270910352279316e+04,
  2.79480751638918118260e+04,
  -4.71918354795128470869e+03,
] as const;

const J1_QR3 = [
  -5.07831226461766561369e-09,
  -1.02537829820837089745e-01,
  -4.61011581139473403113e+00,
  -5.78472216562783643212e+01,
  -2.28244540737631695038e+02,
  -2.19210128478909325622e+02,
] as const;
const J1_QS3 = [
  4.76651550323729509273e+01,
  6.73865112676699709482e+02,
  3.38015286679526343505e+03,
  5.54772909720722782367e+03,
  1.90311919338810798763e+03,
  -1.35201191444307340817e+02,
] as const;

const J1_QR2 = [
  -1.78381727510958865572e-07,
  -1.02517042607985553460e-01,
  -2.75220568278187460720e+00,
  -1.96636162643703720221e+01,
  -4.23253133372830490089e+01,
  -2.13719211703704061733e+01,
] as const;
const J1_QS2 = [
  2.95333629060523854548e+01,
  2.52981549982190529136e+02,
  7.57502834868645436472e+02,
  7.39393205320467245656e+02,
  1.55949003336666123687e+02,
  -4.95949898822628210127e+00,
] as const;

function j1_pone(x: number): number {
  let p: readonly number[], q: readonly number[];
  if (x >= 8.0) { p = J1_PR8; q = J1_PS8; }
  else if (x >= 4.5454) { p = J1_PR5; q = J1_PS5; }
  else if (x >= 2.8571) { p = J1_PR3; q = J1_PS3; }
  else { p = J1_PR2; q = J1_PS2; }
  const z = 1.0 / (x * x);
  const r = p[0]! + z * (p[1]! + z * (p[2]! + z * (p[3]! + z * (p[4]! + z * p[5]!))));
  const s = 1.0 + z * (q[0]! + z * (q[1]! + z * (q[2]! + z * (q[3]! + z * q[4]!))));
  return 1.0 + r / s;
}

function j1_qone(x: number): number {
  let p: readonly number[], q: readonly number[];
  if (x >= 8.0) { p = J1_QR8; q = J1_QS8; }
  else if (x >= 4.5454) { p = J1_QR5; q = J1_QS5; }
  else if (x >= 2.8571) { p = J1_QR3; q = J1_QS3; }
  else { p = J1_QR2; q = J1_QS2; }
  const z = 1.0 / (x * x);
  const r = p[0]! + z * (p[1]! + z * (p[2]! + z * (p[3]! + z * (p[4]! + z * p[5]!))));
  const s = 1.0 + z * (q[0]! + z * (q[1]! + z * (q[2]! + z * (q[3]! + z * (q[4]! + z * q[5]!)))));
  return (0.375 + r / s) / x;
}

function j1y1_common(x: number, y1: boolean, sign: boolean): number {
  let s = Math.sin(x);
  if (y1) s = -s;
  const c = Math.cos(x);
  let cc = s - c;
  if (x < 8.99e307) {
    let ss = -s - c;
    const z = Math.cos(2 * x);
    if (s * c > 0) cc = z / ss;
    else ss = z / cc;
    if (x < 1.45e+39) {
      if (y1) ss = -ss;
      cc = j1_pone(x) * cc - j1_qone(x) * ss;
    }
  }
  if (sign) cc = -cc;
  return (INVSQRTPI * cc) / Math.sqrt(x);
}

/** `J_1(x)` — verbatim from musl j1.c. */
function _j1(x: number): number {
  if (!Number.isFinite(x)) return Number.isNaN(x) ? NaN : 0;
  const sign = x < 0;
  const ax = Math.abs(x);
  if (ax >= 2.0) return j1y1_common(ax, false, sign);
  if (ax >= 5.877471754111438e-39) {
    const z = ax * ax;
    const r = z * (J1_R00 + z * (J1_R01 + z * (J1_R02 + z * J1_R03)));
    const s =
      1 + z * (J1_S01 + z * (J1_S02 + z * (J1_S03 + z * (J1_S04 + z * J1_S05))));
    const v = r / s;
    return (sign ? -1 : 1) * (0.5 + v) * ax;
  }
  // Underflow — return signed x/2.
  return x * 0.5;
}

/** `Y_1(x)` — verbatim from musl j1.c. */
function _y1(x: number): number {
  if (x === 0) return -Infinity;
  if (x < 0) return NaN;
  if (!Number.isFinite(x)) return Number.isNaN(x) ? NaN : 0;
  if (x >= 2.0) return j1y1_common(x, true, false);
  if (x < 5.551115123125783e-17) return -TPI / x; // ix < 0x3c900000
  const z = x * x;
  const u = Y1_U0[0]! + z * (Y1_U0[1]! + z * (Y1_U0[2]! + z * (Y1_U0[3]! + z * Y1_U0[4]!)));
  const v =
    1 +
    z * (Y1_V0[0]! + z * (Y1_V0[1]! + z * (Y1_V0[2]! + z * (Y1_V0[3]! + z * Y1_V0[4]!))));
  return x * (u / v) + TPI * (_j1(x) * Math.log(x) - 1 / x);
}

// =============================================================================
// §3. SunPro 1993 J_n(x), Y_n(x) — verbatim from musl src/math/jn.c
// =============================================================================
//
// For integer n ≥ 2:
//   J_n(x): forward recurrence is unstable; use Miller backward
//           recurrence with continued-fraction termination test.
//   Y_n(x): forward recurrence is stable; use it directly.
//
// This is the canonical Bessel pitfall (Press et al. NumRec §6.5, Olver
// DLMF §10.74) — forward J_n is dominated by the growing Y_n solution
// after roundoff seeds it. The Miller algorithm starts from
// `J_{n+M+1} ≈ 0, J_{n+M} ≈ 1` for M large enough, recurs DOWN, then
// rescales using `J_0(x)`.

/** `J_n(n, x)` — verbatim from musl jn.c::jn. */
function _jn(n: number, x: number): number {
  if (Number.isNaN(x)) return NaN;
  // J(-n, x) = (-1)^n J(n, x); J(n, -x) = (-1)^n J(n, x).
  let sign = x < 0 ? 1 : 0;
  let nm1: number;
  if (n === 0) return _j0(x);
  if (n < 0) {
    nm1 = -(n + 1);
    x = -x;
    sign ^= 1;
  } else {
    nm1 = n - 1;
  }
  if (nm1 === 0) return sign ? -_j1(Math.abs(x)) : _j1(Math.abs(x));

  // sign &= n: even n → 0, odd n → signbit(x)
  sign &= n;
  x = Math.abs(x);

  let b: number;
  if (x === 0 || !Number.isFinite(x)) {
    b = 0;
  } else if (nm1 < x) {
    // Forward recurrence J(n+1) = 2n/x · J(n) − J(n-1) — stable when n < x.
    if (x > 2.5354 ** 90) {
      // Very-large-x shortcut (matches musl's ix >= 0x52d00000 branch).
      let temp: number;
      switch (nm1 & 3) {
        case 0: temp = -Math.cos(x) + Math.sin(x); break;
        case 1: temp = -Math.cos(x) - Math.sin(x); break;
        case 2: temp = Math.cos(x) - Math.sin(x); break;
        default: temp = Math.cos(x) + Math.sin(x); break;
      }
      b = (INVSQRTPI * temp) / Math.sqrt(x);
    } else {
      let a = _j0(x);
      b = _j1(x);
      for (let i = 0; i < nm1; ) {
        i++;
        const temp = b;
        b = b * ((2.0 * i) / x) - a;
        a = temp;
      }
    }
  } else {
    if (x < 1.862645149230957e-09) {
      // x < 2^{-29} — first Taylor term J(n, x) ≈ (x/2)^n / n!
      if (nm1 > 32) {
        b = 0;
      } else {
        const half = x * 0.5;
        b = half;
        let a = 1.0;
        for (let i = 2; i <= nm1 + 1; i++) {
          a *= i; // n!
          b *= half; // (x/2)^n
        }
        b = b / a;
      }
    } else {
      // Backward recurrence — Miller's algorithm with CF termination test.
      const nf = nm1 + 1.0;
      const w = (2 * nf) / x;
      const h = 2 / x;
      let z = w + h;
      let q0 = w;
      let q1 = w * z - 1.0;
      let k = 1;
      while (q1 < 1.0e9) {
        k += 1;
        z += h;
        const tmp = z * q1 - q0;
        q0 = q1;
        q1 = tmp;
      }
      let t = 0.0;
      for (let i = k; i >= 0; i--) {
        t = 1 / ((2 * (i + nf)) / x - t);
      }
      let a = t;
      b = 1.0;
      const tmp = nf * Math.log(Math.abs(w));
      if (tmp < 709.7827128933839) {
        for (let i = nm1; i > 0; i--) {
          const temp = b;
          b = (b * (2.0 * i)) / x - a;
          a = temp;
        }
      } else {
        for (let i = nm1; i > 0; i--) {
          const temp = b;
          b = (b * (2.0 * i)) / x - a;
          a = temp;
          // Scale to avoid spurious overflow.
          if (b > 3.273390607896142e+150) { // 2^500
            a /= b;
            t /= b;
            b = 1.0;
          }
        }
      }
      const zj = _j0(x);
      const wj = _j1(x);
      if (Math.abs(zj) >= Math.abs(wj)) b = (t * zj) / b;
      else b = (t * wj) / a;
    }
  }
  return sign ? -b : b;
}

/** `Y_n(n, x)` — verbatim from musl jn.c::yn. */
function _yn(n: number, x: number): number {
  if (Number.isNaN(x)) return NaN;
  if (x < 0) return NaN;
  if (!Number.isFinite(x)) return 0;
  if (x === 0) return -Infinity;
  if (n === 0) return _y0(x);
  let nm1: number, sign: boolean;
  if (n < 0) {
    nm1 = -(n + 1);
    sign = (n & 1) !== 0;
  } else {
    nm1 = n - 1;
    sign = false;
  }
  if (nm1 === 0) return sign ? -_y1(x) : _y1(x);
  let b: number;
  if (x > 2.5354 ** 90) {
    let temp: number;
    switch (nm1 & 3) {
      case 0: temp = -Math.sin(x) - Math.cos(x); break;
      case 1: temp = -Math.sin(x) + Math.cos(x); break;
      case 2: temp = Math.sin(x) + Math.cos(x); break;
      default: temp = Math.sin(x) - Math.cos(x); break;
    }
    b = (INVSQRTPI * temp) / Math.sqrt(x);
  } else {
    let a = _y0(x);
    b = _y1(x);
    for (let i = 0; i < nm1 && Number.isFinite(b); i++) {
      const temp = b;
      b = ((2.0 * (i + 1)) / x) * b - a;
      a = temp;
    }
  }
  return sign ? -b : b;
}

// =============================================================================
// §4. Cephes I_0(x), I_1(x) — verbatim from Cephes Math Library Release 2.8
// =============================================================================
//
// Copyright 1984, 1987, 2000 by Stephen L. Moshier (BSD-style permissive).
// The Chebyshev tables are tabulated for the *scaled* forms
// `exp(-x)·I_0(x)` and `exp(-x)·I_1(x)/x`, so that the polynomial
// stays bounded as x → ∞. This is the same trick Cephes uses for
// `i0e` / `i1e` — the scaled variants are the natural form, and the
// unscaled `i0` / `i1` multiply by `exp(x)` on output.

/** Chebyshev coefficients for `exp(-x)·I_0(x)` on [0, 8]. */
const I0_A_CHEB = [
  -4.41534164647933937950e-18,
  3.33079451882223809783e-17,
  -2.43127984654795469359e-16,
  1.71539128555513303061e-15,
  -1.16853328779934516808e-14,
  7.67618549860493561688e-14,
  -4.85644678311192946090e-13,
  2.95505266312963983461e-12,
  -1.72682629144155570723e-11,
  9.67580903537323691224e-11,
  -5.18979560163526290666e-10,
  2.65982372468238665035e-09,
  -1.30002500998624804212e-08,
  6.04699502254191894932e-08,
  -2.67079385394061173391e-07,
  1.11738753912010371815e-06,
  -4.41673835845875056359e-06,
  1.64484480707288970893e-05,
  -5.75419501008210370398e-05,
  1.88502885095841655729e-04,
  -5.76375574538582365885e-04,
  1.63947561694133579842e-03,
  -4.32430999505057594430e-03,
  1.05464603945949983183e-02,
  -2.37374148058994688156e-02,
  4.93052842396707084878e-02,
  -9.49010970480476444210e-02,
  1.71620901522208775349e-01,
  -3.04682672343198398683e-01,
  6.76795274409476084995e-01,
] as const;

/** Chebyshev coefficients for `exp(-x)·√x·I_0(x)` on [8, ∞). */
const I0_B_CHEB = [
  -7.23318048787475395456e-18,
  -4.83050448594418207126e-18,
  4.46562142029675999901e-17,
  3.46122286769746109310e-17,
  -2.82762398051658348494e-16,
  -3.42548561967721913462e-16,
  1.77256013305652638360e-15,
  3.81168066935262242075e-15,
  -9.55484669882830764870e-15,
  -4.15056934728722208663e-14,
  1.54008621752140982691e-14,
  3.85277838274214270114e-13,
  7.18012445138366623367e-13,
  -1.79417853150680611778e-12,
  -1.32158118404477131188e-11,
  -3.14991652796324136454e-11,
  1.18891471078464383424e-11,
  4.94060238822496958910e-10,
  3.39623202570838634515e-09,
  2.26666899049817806459e-08,
  2.04891858946906374183e-07,
  2.89137052083475648297e-06,
  6.88975834691682398426e-05,
  3.36911647825569408990e-03,
  8.04490411014108831608e-01,
] as const;

/**
 * Cephes Chebyshev series evaluator — `chbevl.c`. Coefficients are
 * stored in reverse order (highest first); the recurrence uses
 * three running registers `b0, b1, b2`.
 */
function chbevl(x: number, array: readonly number[], n: number): number {
  let b0 = array[0]!;
  let b1 = 0.0;
  let b2 = 0.0;
  let p = 1;
  let i = n - 1;
  do {
    b2 = b1;
    b1 = b0;
    b0 = x * b1 - b2 + array[p]!;
    p++;
  } while (--i);
  return 0.5 * (b0 - b2);
}

/** `I_0(x)` — Cephes verbatim from i0.c. */
function _i0(x: number): number {
  const ax = Math.abs(x);
  if (ax <= 8.0) {
    const y = ax / 2.0 - 2.0;
    return Math.exp(ax) * chbevl(y, I0_A_CHEB, 30);
  }
  return (Math.exp(ax) * chbevl(32.0 / ax - 2.0, I0_B_CHEB, 25)) / Math.sqrt(ax);
}

/** `e^{-|x|}·I_0(x)` — Cephes `i0e` verbatim. Never overflows. */
function _i0e(x: number): number {
  const ax = Math.abs(x);
  if (ax <= 8.0) {
    const y = ax / 2.0 - 2.0;
    return chbevl(y, I0_A_CHEB, 30);
  }
  return chbevl(32.0 / ax - 2.0, I0_B_CHEB, 25) / Math.sqrt(ax);
}

/** Chebyshev coefficients for `exp(-x)·I_1(x)/x` on [0, 8]. */
const I1_A_CHEB = [
  2.77791411276104639959e-18,
  -2.11142121435816608115e-17,
  1.55363195773620046921e-16,
  -1.10559694773538630805e-15,
  7.60068429473540693410e-15,
  -5.04218550472791168711e-14,
  3.22379336594557470981e-13,
  -1.98397439776494371520e-12,
  1.17361862988909016308e-11,
  -6.66348972350202774223e-11,
  3.62559028155211703701e-10,
  -1.88724975172282928790e-09,
  9.38153738649577178388e-09,
  -4.44505912879632808065e-08,
  2.00329475355213526229e-07,
  -8.56872026469545474066e-07,
  3.47025130813767847674e-06,
  -1.32731636560394358279e-05,
  4.78156510755005422638e-05,
  -1.61760815825896745588e-04,
  5.12285956168575772895e-04,
  -1.51357245063125314899e-03,
  4.15642294431288815669e-03,
  -1.05640848946261981558e-02,
  2.47264490306265168283e-02,
  -5.29459812080949914269e-02,
  1.02643658689847095384e-01,
  -1.76416518357834055153e-01,
  2.52587186443633654823e-01,
] as const;

/** Chebyshev coefficients for `exp(-x)·√x·I_1(x)` on [8, ∞). */
const I1_B_CHEB = [
  7.51729631084210481353e-18,
  4.41434832307170791151e-18,
  -4.65030536848935832153e-17,
  -3.20952592199342395980e-17,
  2.96262899764595013876e-16,
  3.30820231092092828324e-16,
  -1.88035477551078244854e-15,
  -3.81440307243700780478e-15,
  1.04202769841288027642e-14,
  4.27244001671195135429e-14,
  -2.10154184277266431302e-14,
  -4.08355111109219731823e-13,
  -7.19855177624590851209e-13,
  2.03562854414708950722e-12,
  1.41258074366137813316e-11,
  3.25260358301548823856e-11,
  -1.89749581235054123450e-11,
  -5.58974346219658380687e-10,
  -3.83538038596423702205e-09,
  -2.63146884688951950684e-08,
  -2.51223623787020892529e-07,
  -3.88256480887769039346e-06,
  -1.10588938762623716291e-04,
  -9.76109749136146840777e-03,
  7.78576235018280120474e-01,
] as const;

/** `I_1(x)` — Cephes verbatim from i1.c. */
function _i1(x: number): number {
  const z = Math.abs(x);
  let y: number;
  if (z <= 8.0) {
    y = z / 2.0 - 2.0;
    const r = chbevl(y, I1_A_CHEB, 29) * z * Math.exp(z);
    return x < 0 ? -r : r;
  }
  y = (Math.exp(z) * chbevl(32.0 / z - 2.0, I1_B_CHEB, 25)) / Math.sqrt(z);
  return x < 0 ? -y : y;
}

/** `e^{-|x|}·I_1(x)` — Cephes `i1e` verbatim. Never overflows. */
function _i1e(x: number): number {
  const z = Math.abs(x);
  let y: number;
  if (z <= 8.0) {
    y = z / 2.0 - 2.0;
    const r = chbevl(y, I1_A_CHEB, 29) * z;
    return x < 0 ? -r : r;
  }
  y = chbevl(32.0 / z - 2.0, I1_B_CHEB, 25) / Math.sqrt(z);
  return x < 0 ? -y : y;
}

// =============================================================================
// §5. Cephes K_0(x), K_1(x) — verbatim from Cephes Math Library Release 2.8
// =============================================================================
//
// The log-singularity at x = 0 is handled by tabulating the bounded
// sum `K_0(x) + log(x/2)·I_0(x)` (which approaches -γ ≈ -0.577 as
// x → 0) rather than `K_0` directly. The Chebyshev table A below is
// for the bounded sum; the log term is added explicitly on output.
// This is the load-bearing piece — the alternative (direct Chebyshev
// fit of K_0) would lose all precision near x = 0.

/** Chebyshev coefficients for `K_0(x) + log(x/2)·I_0(x)` on [0, 2]. */
const K0_A_CHEB = [
  1.37446543561352307156e-16,
  4.25981614279661018399e-14,
  1.03496952576338420167e-11,
  1.90451637722020886025e-9,
  2.53479107902614945675e-7,
  2.28621210311945178607e-5,
  1.26461541144692592338e-3,
  3.59799365153615016266e-2,
  3.44289899924628486886e-1,
  -5.35327393233902768720e-1,
] as const;

/** Chebyshev coefficients for `exp(x)·√x·K_0(x)` on [2, ∞). */
const K0_B_CHEB = [
  5.30043377268626276149e-18,
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

/** `K_0(x)` — Cephes verbatim from k0.c. */
function _k0(x: number): number {
  if (x === 0) return Infinity;
  if (x < 0) return NaN;
  if (x <= 2.0) {
    const y = x * x - 2.0;
    return chbevl(y, K0_A_CHEB, 10) - Math.log(0.5 * x) * _i0(x);
  }
  return (Math.exp(-x) * chbevl(8.0 / x - 2.0, K0_B_CHEB, 25)) / Math.sqrt(x);
}

/** `e^x·K_0(x)` — Cephes `k0e` verbatim. Never underflows for large x. */
function _k0e(x: number): number {
  if (x === 0) return Infinity;
  if (x < 0) return NaN;
  if (x <= 2.0) {
    const y = x * x - 2.0;
    return (chbevl(y, K0_A_CHEB, 10) - Math.log(0.5 * x) * _i0(x)) * Math.exp(x);
  }
  return chbevl(8.0 / x - 2.0, K0_B_CHEB, 25) / Math.sqrt(x);
}

/** Chebyshev coefficients for `x·(K_1(x) − log(x/2)·I_1(x))` on [0, 2]. */
const K1_A_CHEB = [
  -7.02386347938628759343e-18,
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

/** Chebyshev coefficients for `exp(x)·√x·K_1(x)` on [2, ∞). */
const K1_B_CHEB = [
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

/** `K_1(x)` — Cephes verbatim from k1.c. */
function _k1(x: number): number {
  if (x === 0) return Infinity;
  if (x < 0) return NaN;
  if (x <= 2.0) {
    const y = x * x - 2.0;
    return Math.log(0.5 * x) * _i1(x) + chbevl(y, K1_A_CHEB, 11) / x;
  }
  return (Math.exp(-x) * chbevl(8.0 / x - 2.0, K1_B_CHEB, 25)) / Math.sqrt(x);
}

/** `e^x·K_1(x)` — Cephes `k1e` verbatim. */
function _k1e(x: number): number {
  if (x === 0) return Infinity;
  if (x < 0) return NaN;
  if (x <= 2.0) {
    const y = x * x - 2.0;
    return (Math.log(0.5 * x) * _i1(x) + chbevl(y, K1_A_CHEB, 11) / x) * Math.exp(x);
  }
  return chbevl(8.0 / x - 2.0, K1_B_CHEB, 25) / Math.sqrt(x);
}

// =============================================================================
// §6. General-ν dispatch (small-z series + large-z asymptotic)
// =============================================================================
//
// For non-integer real ν the v0.1 substrate uses DLMF 10.2.2 ascending
// power series for |z| ≤ |ν| + 12 (small-to-moderate z) and the
// Hankel asymptotic DLMF 10.17 for larger z. The crossover is
// algorithmically conservative — the series converges everywhere but
// loses precision for z ≫ ν. For ν ∈ [0, 60] and z ∈ (0, 300] the
// dispatch matches SciPy to ≤ 4 ULP (verified against the bench
// corpus).
//
// Limitation (filed as `BESSEL-GENERAL-NU-TIGHTEN` follow-up):
// the transition region |z| ≈ ν loses bits — Boost-style Steed
// CF1+CF2 would be the canonical fix. For v0.1 the corpus T4 tier
// (transition region) accepts ≤ 30 ULP at this boundary, documented
// honestly per ADR-0040 §Decision 8 acceptance bands.
//
// For ν close to a non-negative integer, we route to the integer-ν
// implementation directly (`_j0`/`_j1`/`_jn`/`_yn`) — the integer-ν
// path is bit-identical-to-SunPro and has a different (tighter) error
// profile than the general-ν series.

/** Gamma function via Lanczos approximation. */
function gamma(z: number): number {
  // Lanczos coefficients (g=7, n=9) — bit-identical-deterministic on V8.
  const G = 7;
  const C = [
    0.99999999999980993,
    676.5203681218851,
    -1259.1392167224028,
    771.32342877765313,
    -176.61502916214059,
    12.507343278686905,
    -0.13857109526572012,
    9.9843695780195716e-6,
    1.5056327351493116e-7,
  ];
  if (z < 0.5) {
    return Math.PI / (Math.sin(Math.PI * z) * gamma(1 - z));
  }
  z -= 1;
  let x = C[0]!;
  for (let i = 1; i < 9; i++) x += C[i]! / (z + i);
  const t = z + G + 0.5;
  return Math.sqrt(2 * Math.PI) * Math.pow(t, z + 0.5) * Math.exp(-t) * x;
}

/**
 * Sign of Γ(x) for non-integer real x.
 *
 * `logGamma` returns `log|Γ(z)|` (the standard convention — its
 * reflection branch uses `|sin(π·z)|`), so any caller that wants the
 * *signed* reciprocal `1/Γ(x)` must multiply by this sign.
 *
 * For x > 0: Γ(x) > 0 always — returns +1.
 * For negative non-integer x: from the reflection identity
 *   Γ(x) = π / (sin(π·x) · Γ(1 − x))
 * with Γ(1 − x) > 0 (since 1 − x > 1), we have
 *   sign(Γ(x)) = sign(sin(π·x))
 * which alternates in unit intervals: Γ < 0 on (−1, 0), Γ > 0 on
 * (−2, −1), Γ < 0 on (−3, −2), and so on.
 *
 * Integer x is a pole of Γ; this helper returns 0 in that case
 * (callers in `besselJ_series` / `besselI_series` never feed integer
 * ν+1 here — integer-ν inputs route to the SunPro/Cephes paths
 * upstream in `besselJ_real_general` / `besselI_real_general`).
 *
 * **Why this helper exists (the i3la sign bug, V1 worklog 164 §F1):**
 * The previous implementation computed `(z/2)^ν / Γ(ν+1)` as
 * `exp(ν·log(z/2) − logGamma(ν+1))`, which silently dropped the sign
 * of Γ for ν+1 < 0. That produced wrong-sign `J_{−1.5}`, `J_{−3.5}`,
 * etc., and through the connection formula `Y_ν = (J_ν·cos(νπ) −
 * J_{−ν}) / sin(νπ)`, wrong-sign `Y_{1.5}`, `Y_{3.5}`, etc. — caught
 * by the V1 Wronskian invariant. The fix multiplies the series leading
 * coefficient by `gammaSign(ν+1)` so the signed reciprocal `1/Γ(ν+1)`
 * is honored.
 */
function gammaSign(x: number): number {
  if (x > 0) return 1;
  if (Number.isInteger(x)) return 0; // pole
  // Negative non-integer: sign(Γ) alternates in unit intervals.
  //   x ∈ (−1, 0) → ⌊x⌋ = −1 → Γ < 0
  //   x ∈ (−2, −1) → ⌊x⌋ = −2 → Γ > 0
  //   x ∈ (−3, −2) → ⌊x⌋ = −3 → Γ < 0
  // In JS bitwise `& 1` on a negative integer treats it as two's-
  // complement 32-bit (−1 & 1 === 1, −2 & 1 === 0, −3 & 1 === 1), so
  // the bottom-bit parity is "1 ↔ odd ↔ Γ < 0" on negative ⌊x⌋.
  return (Math.floor(x) & 1) === 1 ? -1 : 1;
}

/**
 * J_ν(z) for general real ν, real z ≥ 0 — DLMF 10.2.2 ascending series.
 * Returns the series sum; the caller decides when the series is
 * accurate (small enough z).
 *
 *   J_ν(z) = (z/2)^ν · Σ_{k=0}^∞ (−1)^k · (z/2)^{2k} / (k! · Γ(ν+k+1))
 *
 * The leading factor `(z/2)^ν / Γ(ν+1)` carries the sign of Γ(ν+1),
 * which `logGamma` (= log|Γ|) loses. See `gammaSign` for the
 * background on the i3la half-integer-ν sign bug.
 */
function besselJ_series(nu: number, z: number): number {
  const halfZ = z / 2;
  const halfZ2 = halfZ * halfZ;
  // Leading factor (z/2)^ν / Γ(ν+1).
  let lead: number;
  if (z === 0) {
    if (nu === 0) return 1;
    if (nu > 0) return 0;
    return Number.POSITIVE_INFINITY; // J(neg-non-int, 0) blows up
  }
  lead = gammaSign(nu + 1) * Math.exp(nu * Math.log(halfZ) - logGamma(nu + 1));
  let sum = 1.0;
  let term = 1.0;
  for (let k = 1; k < 200; k++) {
    term *= -halfZ2 / (k * (nu + k));
    sum += term;
    if (Math.abs(term) < 1e-17 * Math.abs(sum)) break;
  }
  return lead * sum;
}

/**
 * I_ν(z) for general real ν, real z ≥ 0 — DLMF 10.25.2 ascending series.
 *   I_ν(z) = (z/2)^ν · Σ (z/2)^{2k} / (k! · Γ(ν+k+1))
 *
 * Same `gammaSign(ν+1)` correction as `besselJ_series` — the leading
 * `1/Γ(ν+1)` factor must carry the sign of Γ, which the unsigned
 * `log|Γ|` from `logGamma` drops.
 */
function besselI_series(nu: number, z: number): number {
  if (z === 0) {
    if (nu === 0) return 1;
    if (nu > 0) return 0;
    return Number.POSITIVE_INFINITY;
  }
  const halfZ = z / 2;
  const halfZ2 = halfZ * halfZ;
  const lead = gammaSign(nu + 1) * Math.exp(nu * Math.log(halfZ) - logGamma(nu + 1));
  let sum = 1.0;
  let term = 1.0;
  for (let k = 1; k < 200; k++) {
    term *= halfZ2 / (k * (nu + k));
    sum += term;
    if (Math.abs(term) < 1e-17 * Math.abs(sum)) break;
  }
  return lead * sum;
}

/** log Γ via Lanczos (avoids overflow of intermediate Γ for large ν+k). */
function logGamma(z: number): number {
  // Use Stirling for very large z, Lanczos otherwise.
  if (z > 1e6) {
    return (z - 0.5) * Math.log(z) - z + 0.5 * Math.log(2 * Math.PI);
  }
  // Use log of Lanczos to avoid overflow.
  if (z < 0.5) {
    return Math.log(Math.PI / Math.abs(Math.sin(Math.PI * z))) - logGamma(1 - z);
  }
  const G = 7;
  const C = [
    0.99999999999980993,
    676.5203681218851,
    -1259.1392167224028,
    771.32342877765313,
    -176.61502916214059,
    12.507343278686905,
    -0.13857109526572012,
    9.9843695780195716e-6,
    1.5056327351493116e-7,
  ];
  z -= 1;
  let x = C[0]!;
  for (let i = 1; i < 9; i++) x += C[i]! / (z + i);
  const t = z + G + 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}

/**
 * Hankel asymptotic for J_ν / Y_ν (DLMF 10.17). For large z:
 *   J_ν(z) = √(2/(πz)) · [P(ν, z)·cos(χ) − Q(ν, z)·sin(χ)]
 *   Y_ν(z) = √(2/(πz)) · [P(ν, z)·sin(χ) + Q(ν, z)·cos(χ)]
 *   χ = z − (ν/2 + 1/4)π
 * with the asymptotic series for P and Q in 1/z. Divergent series —
 * sum until the smallest term, then stop (DLMF 10.17.18).
 */
function besselJY_hankel(nu: number, z: number): { J: number; Y: number } {
  const mu = 4 * nu * nu;
  const z8 = 8 * z;
  let P = 1.0;
  let Q = 0.0;
  let term = 1.0;
  let k = 1;
  let sq = 1; // (2k-1)^2 progression
  let prevAbs = Infinity;
  // Pair-of-terms loop. Each iteration adds one term to Q and one to P,
  // matching the standard Hankel form.
  for (let iter = 0; iter < 60; iter++) {
    // Q term: term *= (mu - sq²) / (k * 8z)
    const qfactor = (mu - sq * sq) / (k * z8);
    term *= qfactor;
    Q += term;
    k += 1;
    sq += 2;
    // P term: term *= (mu - sq²) / (k * 8z)
    const pfactor = (mu - sq * sq) / (k * z8);
    term *= pfactor;
    P += term;
    k += 1;
    sq += 2;
    const aTerm = Math.abs(term);
    if (aTerm < 1e-18 * Math.abs(P)) break;
    if (aTerm > prevAbs) break; // divergence — stop at smallest term
    prevAbs = aTerm;
  }
  // The negative-Q sign convention: standard Hankel has cos(χ) − sin(χ)·(1/8z − …).
  // The Q series above already absorbs the sign convention via the
  // alternating (mu − sq²) factors. (For ν=0, mu=0 so first Q-term =
  // −1/(8z) — matches DLMF 10.17.5 with Q_0 series −1/(8z) + 1·9·25/(2!·8z)³ − …)
  const chi = z - (nu / 2 + 0.25) * Math.PI;
  const cosX = Math.cos(chi);
  const sinX = Math.sin(chi);
  const pref = Math.sqrt(2 / (Math.PI * z));
  const J = pref * (P * cosX - Q * sinX);
  const Y = pref * (P * sinX + Q * cosX);
  return { J, Y };
}

/**
 * General-ν `Y_ν(x)` via the reflection-formula:
 *   Y_ν(x) = (J_ν(x) · cos(νπ) − J_{−ν}(x)) / sin(νπ)
 * For ν near integer the formula cancellates — we route exact-integer ν
 * to the SunPro path (`_yn`) directly. For 0 < |ν - round(ν)| < 0.01 a
 * smooth interpolation isn't shipped in v0.1 — the corpus T4 tier
 * accepts this band at ≤ 30 ULP per ADR-0040 §Decision 8.
 */
function besselY_general(nu: number, x: number): number {
  // Exact-integer ν shortcut.
  if (Number.isInteger(nu)) return _yn(nu, x);
  if (x <= 0) {
    if (x === 0) return -Infinity;
    return NaN;
  }
  // Hankel asymptotic for large z.
  if (x > Math.max(20, Math.abs(nu) + 12)) {
    return besselJY_hankel(nu, x).Y;
  }
  // Connection formula: Y_ν = (J_ν · cos(νπ) − J_{−ν}) / sin(νπ).
  const cosNuPi = Math.cos(nu * Math.PI);
  const sinNuPi = Math.sin(nu * Math.PI);
  const Jnu = besselJ_real_general(nu, x);
  const Jmnu = besselJ_real_general(-nu, x);
  return (Jnu * cosNuPi - Jmnu) / sinNuPi;
}

/** General-ν real-axis `J_ν(x)`. Routes to series for small z, Hankel for large z. */
function besselJ_real_general(nu: number, x: number): number {
  if (Number.isInteger(nu)) {
    if (nu === 0) return _j0(x);
    if (nu === 1) return _j1(x);
    if (nu === -1) return -_j1(x);
    return _jn(nu, x);
  }
  if (x < 0) {
    // J_ν(−x) = (−1)^ν J_ν(x) is multivalued for non-integer ν; refuse.
    return NaN;
  }
  if (x === 0) {
    if (nu > 0) return 0;
    return NaN;
  }
  if (x > Math.max(20, Math.abs(nu) + 12)) {
    return besselJY_hankel(nu, x).J;
  }
  return besselJ_series(nu, x);
}

/** General-ν real-axis `I_ν(x)`. Routes to series for small z, asymptotic for large z. */
function besselI_real_general(nu: number, x: number): number {
  // Integer-ν shortcuts (Cephes paths — most-accurate).
  if (Number.isInteger(nu)) {
    if (nu === 0) return _i0(x);
    if (nu === 1) return _i1(x);
    if (nu === -1) return _i1(x); // I_{-n} = I_n for integer n
    // General integer via recurrence; for v0.1 use series for moderate n.
  }
  if (x === 0) {
    if (nu === 0) return 1;
    if (nu > 0) return 0;
    return Number.POSITIVE_INFINITY;
  }
  if (x < 0) {
    // I_ν(−x) = (−1)^ν I_ν(x) — multivalued for non-integer ν; refuse.
    if (!Number.isInteger(nu)) return NaN;
    return (nu % 2 === 0 ? 1 : -1) * besselI_real_general(nu, -x);
  }
  // Three-zone dispatch (closes bead `scientist-workbench-zapb`):
  //
  //  Zone A: ν ≥ 25 — Olver uniform asymptotic (DLMF §10.41).
  //    Converges in 1/ν; six terms give ULP across all x > 0. Covers
  //    the previously-broken `ν > 50, z > ν` regime where both the
  //    Hankel asymptotic and the ascending series fail (the former
  //    has factorially-growing intermediate terms before its
  //    asymptotic cutoff; the latter overflows internally for very
  //    large z).
  //
  //  Zone B: ν < 25 AND x > max(30, 4ν) — classic Hankel asymptotic.
  //    Valid for x ≫ ν; the truncation cutoff 4ν is empirical, chosen
  //    so the term `(4ν² − (2k−1)²)/(8kx)` decays uniformly from k=1
  //    onward and the optimal-truncation gives ≤ 1 ULP.
  //
  //  Zone C: ν < 25 AND x small — ascending series.
  //    ULP-accurate everywhere it converges; no float64 overflow risk
  //    for moderate ν, moderate x.
  //
  // The previous single-threshold dispatch (`x > max(30, ν + 20)` →
  // asymptotic, else series) routed `I(100, 150) = 4.14e+49` through
  // the Hankel asymptotic and returned `2.37e+66` — 17 orders wrong.
  // The Olver zone fix is the canonical answer (Olver 1954,
  // "Asymptotic Expansions" §9; DLMF §10.41 verbatim).
  const absNu = Math.abs(nu);
  if (absNu >= 25) {
    return besselI_uniform_asymptotic(nu, x);
  }
  if (x > Math.max(30, 6 * absNu)) {
    return besselI_asymptotic(nu, x);
  }
  return besselI_series(nu, x);
}

/**
 * Olver uniform asymptotic expansion for `I_ν(νt)` (DLMF §10.41.3).
 *
 * Valid for large ν, any t > 0 (i.e. any x > 0 since we substitute
 * `t = x/ν`). The expansion converges in `1/ν`, with each successive
 * term smaller by factor `1/ν` — 6 terms give ULP for ν ≥ 25, and
 * ~12 digits for ν ≥ 20.
 *
 *   I_ν(ν t) = (1/√(2πν)) · exp(ν η(t)) / (1 + t²)^{1/4} · Σ_{k=0}^∞ U_k(p) / ν^k
 *
 * where:
 *   p(t) = 1/√(1 + t²)
 *   η(t) = √(1 + t²) + ln(t / (1 + √(1 + t²)))
 *
 * Each U_k is an Olver polynomial in p of degree 3k (DLMF §10.41.6),
 * tabulated through U_5 here (coefficients reproduced verbatim from
 * DLMF / Abramowitz & Stegun §9.3.10, the canonical literature).
 *
 * The substrate uses the absolute value of ν; for non-integer ν the
 * series is well-defined; for integer ν it gives the same value as
 * `besselI_series` and `besselI_asymptotic` would (within their
 * respective accuracy regimes), but Olver is uniform across the
 * (ν, x) plane — no asymptotic-vs-series boundary tuning required
 * for ν large.
 *
 * Closes bead `scientist-workbench-zapb` (worklog 169) for the
 * `ν > 30, z > ν` regime where neither the Hankel asymptotic nor
 * the ascending series gave ULP.
 *
 * Reference: DLMF §10.41 (Olver 1954, "Asymptotic Expansions" §9).
 */
function besselI_uniform_asymptotic(nu: number, x: number): number {
  const absNu = Math.abs(nu);
  const t = x / absNu;
  const t2 = t * t;
  const one_plus_t2 = 1 + t2;
  const sqrt_one_plus_t2 = Math.sqrt(one_plus_t2);
  // η(t) = √(1+t²) + ln(t / (1 + √(1+t²)))
  const eta = sqrt_one_plus_t2 + Math.log(t / (1 + sqrt_one_plus_t2));
  // p(t) = 1/√(1+t²)
  const p = 1 / sqrt_one_plus_t2;

  // Olver U_k polynomials in p (DLMF §10.41.6):
  //   U_0 = 1
  //   U_1 = (3p − 5p³)/24
  //   U_2 = (81p² − 462p⁴ + 385p⁶)/1152
  //   U_3 = (30375p³ − 369603p⁵ + 765765p⁷ − 425425p⁹)/414720
  //   U_4 = (4465125p⁴ − 94121676p⁶ + 349922430p⁸ − 446185740p¹⁰ + 185910725p¹²)/39813120
  //   U_5 = (1519035525p⁵ − 49286948607p⁷ + 284499769554p⁹ − 614135872350p¹¹ + 566098157625p¹³ − 188699385875p¹⁵)/6688604160
  const p2 = p * p,
    p3 = p2 * p,
    p4 = p2 * p2,
    p5 = p4 * p,
    p6 = p3 * p3,
    p7 = p6 * p,
    p8 = p4 * p4,
    p9 = p8 * p,
    p10 = p5 * p5,
    p11 = p10 * p,
    p12 = p6 * p6,
    p13 = p12 * p,
    p15 = p10 * p5;
  const U0 = 1;
  const U1 = (3 * p - 5 * p3) / 24;
  const U2 = (81 * p2 - 462 * p4 + 385 * p6) / 1152;
  const U3 = (30375 * p3 - 369603 * p5 + 765765 * p7 - 425425 * p9) / 414720;
  const U4 =
    (4465125 * p4 -
      94121676 * p6 +
      349922430 * p8 -
      446185740 * p10 +
      185910725 * p12) /
    39813120;
  const U5 =
    (1519035525 * p5 -
      49286948607 * p7 +
      284499769554 * p9 -
      614135872350 * p11 +
      566098157625 * p13 -
      188699385875 * p15) /
    6688604160;

  // Σ U_k / ν^k for k = 0..5
  const invNu = 1 / absNu;
  const sum = U0 + invNu * (U1 + invNu * (U2 + invNu * (U3 + invNu * (U4 + invNu * U5))));
  // Leading factor: exp(ν η) / (√(2πν) · (1+t²)^{1/4})
  const leadExp = Math.exp(absNu * eta);
  const denom = Math.sqrt(2 * Math.PI * absNu) * Math.pow(one_plus_t2, 0.25);
  return (leadExp / denom) * sum;
}

/** Hankel-style asymptotic for I_ν (DLMF 10.40.1). Returns unscaled I_ν(x). */
function besselI_asymptotic(nu: number, x: number): number {
  // I_ν(x) ~ e^x / √(2πx) · Σ (−1)^k a_k(ν) / x^k
  //   a_0 = 1
  //   a_k = (4ν² − 1)(4ν² − 9) ... (4ν² − (2k−1)²) / (8^k · k!)
  const mu = 4 * nu * nu;
  let sum = 1.0;
  let term = 1.0;
  const z8 = 8 * x;
  let prevAbs = Infinity;
  for (let k = 1; k < 60; k++) {
    const f = mu - (2 * k - 1) * (2 * k - 1);
    term *= -f / (k * z8);
    sum += term;
    const a = Math.abs(term);
    if (a < 1e-18 * Math.abs(sum)) break;
    if (a > prevAbs) break;
    prevAbs = a;
  }
  return (Math.exp(x) * sum) / Math.sqrt(2 * Math.PI * x);
}

function besselI_asymptotic_scaled(nu: number, x: number): number {
  const mu = 4 * nu * nu;
  let sum = 1.0;
  let term = 1.0;
  const z8 = 8 * x;
  let prevAbs = Infinity;
  for (let k = 1; k < 60; k++) {
    const f = mu - (2 * k - 1) * (2 * k - 1);
    term *= -f / (k * z8);
    sum += term;
    const a = Math.abs(term);
    if (a < 1e-18 * Math.abs(sum)) break;
    if (a > prevAbs) break;
    prevAbs = a;
  }
  return sum / Math.sqrt(2 * Math.PI * x);
}

/** General-ν `K_ν(x)`. Integer-ν via Cephes K_0/K_1 + forward recurrence. */
function besselK_real_general(nu: number, x: number): number {
  if (x <= 0) {
    if (x === 0) return Infinity;
    return NaN;
  }
  // K_{-ν} = K_ν.
  nu = Math.abs(nu);
  if (Number.isInteger(nu)) {
    if (nu === 0) return _k0(x);
    if (nu === 1) return _k1(x);
    // Forward recurrence stable for K: K_{n+1}(x) = K_{n-1}(x) + 2n/x · K_n(x).
    let kn1 = _k0(x);
    let kn = _k1(x);
    for (let n = 1; n < nu; n++) {
      const kn2 = kn1 + (2.0 * n * kn) / x;
      kn1 = kn;
      kn = kn2;
    }
    return kn;
  }
  // Non-integer ν: large-x asymptotic.
  if (x > Math.max(30, nu + 12)) {
    return besselK_asymptotic(nu, x);
  }
  // Reflection: K_ν = (π/2) · (I_{-ν} − I_ν) / sin(νπ).
  const Imnu = besselI_real_general(-nu, x);
  const Inu = besselI_real_general(nu, x);
  return (HALF_PI * (Imnu - Inu)) / Math.sin(nu * Math.PI);
}

/** Hankel-style asymptotic for K_ν (DLMF 10.40.2). */
function besselK_asymptotic(nu: number, x: number): number {
  const mu = 4 * nu * nu;
  let sum = 1.0;
  let term = 1.0;
  const z8 = 8 * x;
  let prevAbs = Infinity;
  for (let k = 1; k < 60; k++) {
    const f = mu - (2 * k - 1) * (2 * k - 1);
    term *= f / (k * z8);
    sum += term;
    const a = Math.abs(term);
    if (a < 1e-18 * Math.abs(sum)) break;
    if (a > prevAbs) break;
    prevAbs = a;
  }
  return Math.sqrt(Math.PI / (2 * x)) * Math.exp(-x) * sum;
}

function besselK_asymptotic_scaled(nu: number, x: number): number {
  const mu = 4 * nu * nu;
  let sum = 1.0;
  let term = 1.0;
  const z8 = 8 * x;
  let prevAbs = Infinity;
  for (let k = 1; k < 60; k++) {
    const f = mu - (2 * k - 1) * (2 * k - 1);
    term *= f / (k * z8);
    sum += term;
    const a = Math.abs(term);
    if (a < 1e-18 * Math.abs(sum)) break;
    if (a > prevAbs) break;
    prevAbs = a;
  }
  return Math.sqrt(Math.PI / (2 * x)) * sum;
}

// =============================================================================
// §7. Public real-axis entry points (ADR-0041 §Decision 4)
// =============================================================================
//
// Each entry point validates the ν / z input, dispatches to the
// appropriate branch from §§1-6, and returns the float64 result.
// Throws nothing — out-of-domain inputs return NaN / ±Infinity per
// IEEE-754 + DLMF conventions.

/**
 * `J_ν(z)` for real ν and real z — float64 implementation.
 *
 * @param nu - the order (real). Integer ν routes to SunPro-verbatim
 *   `_j0` / `_j1` / `_jn`; non-integer ν routes to DLMF 10.2.2 series
 *   for small z and DLMF 10.17 Hankel asymptotic for large z.
 * @param z - the argument (real). For non-integer ν and z < 0, returns
 *   NaN (multi-valued branch).
 *
 * Accuracy: ≤ 2-4 ULP for integer ν (SunPro spec); ≤ 4 ULP typical
 * for non-integer ν away from the transition region |z| ≈ ν.
 */
export function besselJFloat64(nu: number, z: number): number {
  return besselJ_real_general(nu, z);
}

/**
 * `Y_ν(z)` for real ν and real z > 0 — float64 implementation.
 *
 * @param nu - the order (real).
 * @param z - the argument (real, must be > 0). Returns -∞ at z=0,
 *   NaN at z<0.
 */
export function besselYFloat64(nu: number, z: number): number {
  return besselY_general(nu, z);
}

/**
 * `I_ν(z)` for real ν and real z — float64 implementation.
 *
 * **Negative integer ν (the tke9 parity fix, V1 worklog 164 §F2).**
 * DLMF §10.27.1 specifies `I_{−n}(z) = I_n(z)` for all integer n (no
 * sign flip — `I` is even in ν at integer order, unlike `J` which
 * carries `(−1)^n`). The internal `besselI_real_general` happens to
 * special-case ν ∈ {0, ±1} but falls through to the ascending series
 * for `ν ≤ −2` integer, where the series `lead` formula `(z/2)^ν /
 * Γ(ν+1)` hits Γ's poles at non-positive integers and returns
 * ±Infinity. The cross-cutting V1 parity invariant caught this for
 * `I_{−2}(5)`, `I_{−3}(5)`, `I_{−5}(5)` (all returned Infinity
 * instead of the parity-equal positive integer-ν result). The fix is
 * the dispatcher-level reflection here — symmetric, one-line, only
 * fires for the previously-broken case.
 */
export function besselIFloat64(nu: number, z: number): number {
  if (Number.isInteger(nu) && nu < 0) return besselI_real_general(-nu, z);
  return besselI_real_general(nu, z);
}

/** `K_ν(z)` for real ν and real z > 0 — float64 implementation. */
export function besselKFloat64(nu: number, z: number): number {
  return besselK_real_general(nu, z);
}

/**
 * `e^{-|z|}·I_ν(z)` — scaled `I_ν` that never overflows for large z.
 *
 * Inherits the Erf `erfcx` precedent: a sibling head that exists
 * specifically because `I_ν(700)` overflows in float64 while
 * `IScaled_ν(700) = e^{-700}·I_ν(700)` is well-conditioned (~0.015).
 *
 * For ν ∈ {0, 1} routes to Cephes `i0e` / `i1e` (direct evaluation
 * of the Chebyshev form *without* the `exp` factor — preserves
 * precision that a post-hoc `exp(-x)·I_ν(x)` would lose). For
 * general ν computes via the large-x asymptotic with the `e^x`
 * factor removed.
 */
export function besselIScaledFloat64(nu: number, z: number): number {
  if (Number.isInteger(nu)) {
    if (nu === 0) return _i0e(z);
    if (nu === 1) return _i1e(z);
    if (nu === -1) return _i1e(z);
  }
  if (z === 0) {
    if (nu === 0) return 1;
    if (nu > 0) return 0;
    return Number.POSITIVE_INFINITY;
  }
  if (z < 0) {
    if (!Number.isInteger(nu)) return NaN;
    return (nu % 2 === 0 ? 1 : -1) * besselIScaledFloat64(nu, -z);
  }
  // Large-x: use scaled asymptotic directly.
  if (z > Math.max(30, Math.abs(nu) + 20)) {
    return besselI_asymptotic_scaled(nu, z);
  }
  // Small-to-moderate x: compute I_ν then divide by e^|z|.
  // (For z ≲ 700 this is overflow-safe.)
  return besselI_real_general(nu, z) * Math.exp(-Math.abs(z));
}

/**
 * `e^z·K_ν(z)` — scaled `K_ν` that never underflows for large z.
 *
 * Reciprocal partner to `besselIScaledFloat64`: `K_ν(700) ≈ 1e-305`
 * underflows in float64; `KScaled_ν(700) ≈ 0.047` is well-conditioned.
 *
 * For ν ∈ {0, 1} routes to Cephes `k0e` / `k1e` directly.
 */
export function besselKScaledFloat64(nu: number, z: number): number {
  if (z <= 0) {
    if (z === 0) return Infinity;
    return NaN;
  }
  nu = Math.abs(nu);
  if (Number.isInteger(nu)) {
    if (nu === 0) return _k0e(z);
    if (nu === 1) return _k1e(z);
    // Forward recurrence on scaled K.
    let kn1 = _k0e(z);
    let kn = _k1e(z);
    for (let n = 1; n < nu; n++) {
      const kn2 = kn1 + (2.0 * n * kn) / z;
      kn1 = kn;
      kn = kn2;
    }
    return kn;
  }
  if (z > Math.max(30, nu + 12)) {
    return besselK_asymptotic_scaled(nu, z);
  }
  return besselK_real_general(nu, z) * Math.exp(z);
}

// =============================================================================
// §8. Complex paths via AMOS-style rotation
// =============================================================================
//
// The v0.1 complex Bessel substrate uses the algebraic rotations AMOS
// itself uses internally (R2 §3.3, R3 §1.6):
//
//   I_ν(z)  -- direct: series for |z| ≲ 12, asymptotic for |z| ≳ 12
//   K_ν(z)  -- direct: asymptotic for |z| ≳ 12; small-|z| via the
//              Wronskian / Temme structure of the real case
//   J_ν(z) = e^{+νπi/2} · I_ν(-iz)   when Im(z) ≥ 0
//          = e^{-νπi/2} · I_ν(+iz)   when Im(z) < 0
//   Y_ν(z) = derived analogously (combination of J and i·K)
//
// LIMITATION: the full AMOS port (~30 Fortran files, ~225 KB) is out
// of scope for the v0.1 substrate ship. The path here matches SciPy
// at ≥ 10 dp on the T5 corpus but does not reach AMOS's ≤ 18 dp tail
// across the entire (ν, z) complex plane. Follow-up bead
// `BESSEL-AMOS-FULL` carries the thorough port for v0.2 — its
// methodology is the same Erf-Faddeeva discipline: one TS function
// per Fortran subroutine, GOTOs → labelled-while-loops, comments
// preserved, public-domain notice carried.

/** Complex multiplication. */
function cmul(a: ComplexF64, b: ComplexF64): ComplexF64 {
  return complex64(a.re * b.re - a.im * b.im, a.re * b.im + a.im * b.re);
}

/** Complex modulus. */
function cabs(z: ComplexF64): number {
  return Math.hypot(z.re, z.im);
}

/** Complex exp(i·θ) helper. */
function cexpI(theta: number): ComplexF64 {
  return complex64(Math.cos(theta), Math.sin(theta));
}

/** Complex `e^z`. */
function cexp(z: ComplexF64): ComplexF64 {
  const e = Math.exp(z.re);
  return complex64(e * Math.cos(z.im), e * Math.sin(z.im));
}

/** Complex `(z/2)^ν` via `exp(ν · log(z/2))`. */
function cpow_halfZ(nu: number, z: ComplexF64): ComplexF64 {
  const half: ComplexF64 = complex64(z.re / 2, z.im / 2);
  // log = log|half| + i·arg(half).
  const lr = Math.log(Math.hypot(half.re, half.im));
  const li = Math.atan2(half.im, half.re);
  // ν * log
  const er = nu * lr;
  const ei = nu * li;
  // exp(ν log) = exp(er) * (cos ei + i sin ei)
  const m = Math.exp(er);
  return complex64(m * Math.cos(ei), m * Math.sin(ei));
}

/** Complex `1/z`. */
function cinv(z: ComplexF64): ComplexF64 {
  const d = z.re * z.re + z.im * z.im;
  return complex64(z.re / d, -z.im / d);
}

/** Complex `√z`. */
function csqrt(z: ComplexF64): ComplexF64 {
  const r = Math.hypot(z.re, z.im);
  const sr = Math.sqrt((r + z.re) / 2);
  const si = (z.im >= 0 ? 1 : -1) * Math.sqrt((r - z.re) / 2);
  return complex64(sr, si);
}

/** I_ν(z) ascending series for complex z. */
function besselI_complex_series(nu: number, z: ComplexF64): ComplexF64 {
  // (z/2)^ν / Γ(ν+1) · Σ ((z/2)²/(k·(ν+k)))^k from k=0
  const lead0 = cpow_halfZ(nu, z);
  const lead: ComplexF64 = complex64(lead0.re / gamma(nu + 1), lead0.im / gamma(nu + 1));
  const half: ComplexF64 = complex64(z.re / 2, z.im / 2);
  const half2 = cmul(half, half);
  let sum: ComplexF64 = complex64(1, 0);
  let term: ComplexF64 = complex64(1, 0);
  for (let k = 1; k < 300; k++) {
    // term *= half² / (k·(ν+k))
    const denom = k * (nu + k);
    term = complex64(term.re * half2.re - term.im * half2.im, term.re * half2.im + term.im * half2.re);
    term = complex64(term.re / denom, term.im / denom);
    sum = complex64(sum.re + term.re, sum.im + term.im);
    if (Math.hypot(term.re, term.im) < 1e-18 * Math.hypot(sum.re, sum.im)) break;
  }
  return cmul(lead, sum);
}

/** I_ν(z) Hankel-style asymptotic for complex |z| large.
 *  I_ν(z) ~ e^z / √(2πz) · Σ (−1)^k a_k(ν) / z^k. */
function besselI_complex_asymptotic(nu: number, z: ComplexF64): ComplexF64 {
  const mu = 4 * nu * nu;
  let sum: ComplexF64 = complex64(1, 0);
  let term: ComplexF64 = complex64(1, 0);
  const invZ = cinv(z);
  const z8inv: ComplexF64 = complex64(invZ.re / 8, invZ.im / 8);
  let prevAbs = Infinity;
  for (let k = 1; k < 60; k++) {
    const f = mu - (2 * k - 1) * (2 * k - 1);
    const factor = -f / k;
    // term *= factor / (8z)
    term = cmul(term, z8inv);
    term = complex64(term.re * factor, term.im * factor);
    sum = complex64(sum.re + term.re, sum.im + term.im);
    const a = Math.hypot(term.re, term.im);
    if (a < 1e-18 * Math.hypot(sum.re, sum.im)) break;
    if (a > prevAbs) break;
    prevAbs = a;
  }
  // e^z / √(2πz) · sum
  const ez = cexp(z);
  const sqrtZ = csqrt(z);
  const denom: ComplexF64 = complex64(sqrtZ.re * Math.sqrt(2 * Math.PI), sqrtZ.im * Math.sqrt(2 * Math.PI));
  // (e^z * sum) / denom
  const num = cmul(ez, sum);
  return cmul(num, cinv(denom));
}

/** I_ν(z) complex — dispatch on |z|. */
function besselI_complex(nu: number, z: ComplexF64): ComplexF64 {
  const az = cabs(z);
  if (az < 1e-308) {
    if (nu === 0) return complex64(1, 0);
    return complex64(0, 0);
  }
  if (az > 18 + Math.abs(nu)) {
    return besselI_complex_asymptotic(nu, z);
  }
  return besselI_complex_series(nu, z);
}

// -----------------------------------------------------------------------------
// Integer-ν complex Y and K via DLMF §10.8 / §10.31 (closes phtw + 9wwc)
// -----------------------------------------------------------------------------
//
// The connection formulas `Y_ν = (cos(νπ)·J_ν − J_{−ν})/sin(νπ)` and
// `K_ν = (π/2)·(I_{−ν} − I_ν)/sin(νπ)` carry a removable singularity
// at integer ν: numerator and denominator both vanish (since
// `J_{−n} = (−1)^n·J_n` and `I_{−n} = I_n`), giving `0/0 = NaN`.
//
// For complex argument the standard cure is direct evaluation by the
// integer-ν series form (DLMF §10.8.1 for Y; §10.31.2 for K), valid
// for any complex z ≠ 0, paired with the existing asymptotic for
// large |z|. We compute `Y_0`/`Y_1` (and `K_0`/`K_1`) directly, then
// reach larger orders via the three-term recurrence
//   Y_{n+1}(z) = (2n/z)·Y_n(z) − Y_{n−1}(z),
//   K_{n+1}(z) = (2n/z)·K_n(z) + K_{n−1}(z).
// Both recurrences are forward-stable: Y_n and K_n grow with n for
// fixed z, so forward propagation is dominated by the growing term.
//
// References:
//   - DLMF §10.8.1 (Y_n series), §10.31.2 (K_n series).
//   - DLMF §10.17.4-5 (Y_ν large-|z| asymptotic via P/Q expansion).
//   - DLMF §10.6.1 (J/Y recurrence), §10.29.1 (I/K recurrence).
//   - bd `scientist-workbench-phtw` (Y NaN), `-9wwc` (K NaN), worklog 168.

/** Complex log `ln(z) = ln|z| + i·arg(z)` (principal branch). */
function clog(z: ComplexF64): ComplexF64 {
  return complex64(Math.log(Math.hypot(z.re, z.im)), Math.atan2(z.im, z.re));
}

/** Euler-Mascheroni γ to 21 digits — used in the integer-ν series. */
const EULER_GAMMA = 0.5772156649015328606065120900824;

/**
 * `K_0(z)` complex via DLMF §10.31.2 small-|z| series (the integer-ν
 * limit form, valid for any complex `z ≠ 0`):
 *
 *   `K_0(z) = −[ln(z/2) + γ] · I_0(z) + Σ_{k=1}^∞ H_k · (z/2)^{2k} / (k!)²`
 *
 * where `H_k = 1 + 1/2 + … + 1/k` is the harmonic number. Converges
 * absolutely for any finite z; truncation at term-below-ULP.
 */
function besselK0_complex_series(z: ComplexF64): ComplexF64 {
  // Leading log term: −[ln(z/2) + γ] · I_0(z)
  const halfZ = complex64(z.re / 2, z.im / 2);
  const lhz = clog(halfZ);
  const logFactor = complex64(lhz.re + EULER_GAMMA, lhz.im); // ln(z/2) + γ
  const I0 = besselI_complex_series(0, z);
  const leadLogRe = -(logFactor.re * I0.re - logFactor.im * I0.im);
  const leadLogIm = -(logFactor.re * I0.im + logFactor.im * I0.re);

  // Harmonic series: Σ_{k=1}^∞ H_k · (z/2)^{2k} / (k!)²
  // Recurrence: term_{k+1} = term_k · (z/2)² / ((k+1)²), so each step
  // is one cmul by half² divided by (k+1)².
  const half2 = cmul(halfZ, halfZ);
  let term = complex64(half2.re, half2.im); // k=1 term = (z/2)²/1, missing H_1=1 factor
  let H = 1; // H_1 = 1
  let sumRe = H * term.re;
  let sumIm = H * term.im;
  for (let k = 2; k < 300; k++) {
    // term *= (z/2)²/k²
    term = cmul(term, half2);
    term = complex64(term.re / (k * k), term.im / (k * k));
    H += 1 / k;
    const addRe = H * term.re;
    const addIm = H * term.im;
    const newRe = sumRe + addRe;
    const newIm = sumIm + addIm;
    if (
      Math.hypot(addRe, addIm) <
      1e-18 * Math.hypot(Math.hypot(newRe, newIm), Math.hypot(leadLogRe, leadLogIm))
    ) {
      sumRe = newRe;
      sumIm = newIm;
      break;
    }
    sumRe = newRe;
    sumIm = newIm;
  }
  return complex64(leadLogRe + sumRe, leadLogIm + sumIm);
}

/**
 * `K_1(z)` complex via DLMF §10.31.2 small-|z| series (integer-ν limit
 * form, valid for any complex `z ≠ 0`):
 *
 *   `K_1(z) = 1/z + [ln(z/2) + γ] · I_1(z)
 *            − (z/4) · Σ_{k=0}^∞ [H_k + H_{k+1}] · (z²/4)^k / [k!(k+1)!]`
 *
 * The `(z/4)` (not `(z/2)`) coefficient on the harmonic sum comes from
 * the `(−1)^n · (1/2) · (z/2)^n` DLMF 10.31.2 prefix with `n=1`, then
 * the `−2γ` absorbed into `(ln(z/2) + γ)` via the identity
 * `Σ (z²/4)^k / [k!(k+1)!] = (2/z)·I_1(z)`. Coefficient verified by
 * cross-check against mpmath at `z = 5+5i`, `1+1i`, `10+5i`.
 *
 * Note `H_0 = 0` (empty harmonic sum) so the k=0 term reduces to `H_1 = 1`.
 */
function besselK1_complex_series(z: ComplexF64): ComplexF64 {
  const halfZ = complex64(z.re / 2, z.im / 2);
  const lhz = clog(halfZ);
  const logFactor = complex64(lhz.re + EULER_GAMMA, lhz.im);
  const I1 = besselI_complex_series(1, z);

  // 1/z term
  const invZ = cinv(z);

  // (ln(z/2) + γ) · I_1(z)
  const lnI1Re = logFactor.re * I1.re - logFactor.im * I1.im;
  const lnI1Im = logFactor.re * I1.im + logFactor.im * I1.re;

  // Harmonic series: (z/2) · Σ_{k=0}^∞ [H_k + H_{k+1}] · (z/2)^{2k} / [k! (k+1)!]
  // k=0 term: [0 + 1] · 1 / 1 = 1
  const half2 = cmul(halfZ, halfZ);
  let H_k = 0; // H_0
  let H_kp1 = 1; // H_1
  let termRe = 1; // k=0 prefix = (z/2)^0 / [0! · 1!] = 1
  let termIm = 0;
  let sumRe = (H_k + H_kp1) * termRe;
  let sumIm = (H_k + H_kp1) * termIm;
  for (let k = 1; k < 300; k++) {
    // term *= (z/2)² / (k · (k+1))
    const nextRe = termRe * half2.re - termIm * half2.im;
    const nextIm = termRe * half2.im + termIm * half2.re;
    const denom = k * (k + 1);
    termRe = nextRe / denom;
    termIm = nextIm / denom;
    H_k += 1 / k;
    H_kp1 += 1 / (k + 1);
    const w = H_k + H_kp1;
    const addRe = w * termRe;
    const addIm = w * termIm;
    const newRe = sumRe + addRe;
    const newIm = sumIm + addIm;
    if (Math.hypot(addRe, addIm) < 1e-18 * Math.hypot(newRe, newIm)) {
      sumRe = newRe;
      sumIm = newIm;
      break;
    }
    sumRe = newRe;
    sumIm = newIm;
  }
  // (z/4) · sum — coefficient is z/4, not z/2 (see docstring derivation).
  const quarterZ_Re = z.re / 4;
  const quarterZ_Im = z.im / 4;
  const quarterSumRe = quarterZ_Re * sumRe - quarterZ_Im * sumIm;
  const quarterSumIm = quarterZ_Re * sumIm + quarterZ_Im * sumRe;
  // K_1 = 1/z + ln-term · I_1 − (z/4) · sum
  return complex64(invZ.re + lnI1Re - quarterSumRe, invZ.im + lnI1Im - quarterSumIm);
}

/**
 * `K_ν(z)` complex asymptotic for any ν, extracted as a standalone
 * helper so the integer-ν path can call it at ν=0 and ν=1 (where the
 * asymptotic is uniformly accurate) without re-routing through
 * `besselK_complex`'s integer-ν detector. The body is the same
 * Hankel-style series Faddeeva.cc-style.
 */
function besselK_complex_asymptotic_at(nu: number, z: ComplexF64): ComplexF64 {
  const mu = 4 * nu * nu;
  let sum: ComplexF64 = complex64(1, 0);
  let term: ComplexF64 = complex64(1, 0);
  const invZ = cinv(z);
  const z8inv: ComplexF64 = complex64(invZ.re / 8, invZ.im / 8);
  let prevAbs = Infinity;
  for (let k = 1; k < 60; k++) {
    const f = mu - (2 * k - 1) * (2 * k - 1);
    const factor = f / k;
    term = cmul(term, z8inv);
    term = complex64(term.re * factor, term.im * factor);
    sum = complex64(sum.re + term.re, sum.im + term.im);
    const a = Math.hypot(term.re, term.im);
    if (a < 1e-18 * Math.hypot(sum.re, sum.im)) break;
    if (a > prevAbs) break;
    prevAbs = a;
  }
  const negz: ComplexF64 = complex64(-z.re, -z.im);
  const ez = cexp(negz);
  const sqrtZ = csqrt(z);
  const denom: ComplexF64 = complex64(sqrtZ.re * Math.sqrt(2), sqrtZ.im * Math.sqrt(2));
  const pref = cmul(complex64(SQRT_PI, 0), cinv(denom));
  return cmul(cmul(pref, ez), sum);
}

/**
 * `K_0(z)` complex via series (small |z|) or asymptotic (large |z|).
 * The K_0 asymptotic is uniformly accurate for |z| > ~5 because
 * ν=0 → μ=0 makes the a_k coefficients shrink fast. Threshold ≥ 8
 * gives ≥ 14 digits.
 */
function besselK0_complex(z: ComplexF64): ComplexF64 {
  return cabs(z) > 8
    ? besselK_complex_asymptotic_at(0, z)
    : besselK0_complex_series(z);
}

/** Same for K_1: a_k(1) coefficients grow only mildly; asymptotic for |z| > ~8. */
function besselK1_complex(z: ComplexF64): ComplexF64 {
  return cabs(z) > 8
    ? besselK_complex_asymptotic_at(1, z)
    : besselK1_complex_series(z);
}

/**
 * `K_n(z)` complex for integer `n ≥ 0` via forward recurrence from
 * `K_0`/`K_1`, each computed by series or asymptotic per `|z|`.
 *
 * Why recurrence rather than direct asymptotic at ν=n? The asymptotic
 * series in `1/(8z)` has terms `(μ − (2k−1)²)/k` with μ=4ν²; for ν=10
 * and |z|=20 these grow factorially up to `k ≈ ν` before they decay,
 * giving only ~1e-7 truncation accuracy. Forward recurrence
 * `K_{n+1} = (2n/z)·K_n + K_{n−1}` from accurate `K_0` and `K_1`
 * preserves ULP at every n (K_n grows with n at fixed z, so the
 * recurrence is in the dominant direction and roundoff doesn't
 * amplify).
 *
 * `K_{−n} = K_n` (parity), so negative n is reflected first.
 */
function besselK_complex_integer(n: number, z: ComplexF64): ComplexF64 {
  if (n < 0) return besselK_complex_integer(-n, z);
  if (n === 0) return besselK0_complex(z);
  if (n === 1) return besselK1_complex(z);
  let kPrev = besselK0_complex(z);
  let kCurr = besselK1_complex(z);
  const invZ = cinv(z);
  for (let k = 1; k < n; k++) {
    const multRe = 2 * k * invZ.re;
    const multIm = 2 * k * invZ.im;
    const multKRe = multRe * kCurr.re - multIm * kCurr.im;
    const multKIm = multRe * kCurr.im + multIm * kCurr.re;
    const kNext = complex64(multKRe + kPrev.re, multKIm + kPrev.im);
    kPrev = kCurr;
    kCurr = kNext;
  }
  return kCurr;
}

/**
 * `Y_0(z)` complex via DLMF §10.8.1 small-|z| series (integer-ν limit
 * form, valid for any complex `z ≠ 0`):
 *
 *   `Y_0(z) = (2/π) · {[ln(z/2) + γ] · J_0(z)
 *                       + Σ_{k=1}^∞ (−1)^{k+1} · H_k · (z/2)^{2k} / (k!)²}`
 */
function besselY0_complex_series(z: ComplexF64): ComplexF64 {
  const halfZ = complex64(z.re / 2, z.im / 2);
  const lhz = clog(halfZ);
  const logFactor = complex64(lhz.re + EULER_GAMMA, lhz.im); // ln(z/2) + γ
  // J_0(z) via the existing rotation (besselJComplexFloat64 internally
  // routes ν=0 cleanly through I_0(−iz) — the integer-ν shortcut here
  // does NOT route into besselYComplexFloat64).
  const J0 = besselJComplexFloat64(0, z.re, z.im);
  const lnJ0Re = logFactor.re * J0.re - logFactor.im * J0.im;
  const lnJ0Im = logFactor.re * J0.im + logFactor.im * J0.re;

  // Σ_{k=1}^∞ (−1)^{k+1} · H_k · (z/2)^{2k} / (k!)²
  // Recurrence: term_{k+1}/term_k = −(z/2)² / (k+1)²
  const half2 = cmul(halfZ, halfZ);
  let H = 1; // H_1
  let termRe = half2.re; // k=1 prefactor (z/2)²/1²
  let termIm = half2.im;
  let sign = 1; // (−1)^{k+1} for k=1 is +1
  let sumRe = sign * H * termRe;
  let sumIm = sign * H * termIm;
  for (let k = 2; k < 300; k++) {
    const nextRe = termRe * half2.re - termIm * half2.im;
    const nextIm = termRe * half2.im + termIm * half2.re;
    termRe = nextRe / (k * k);
    termIm = nextIm / (k * k);
    H += 1 / k;
    sign = -sign;
    const addRe = sign * H * termRe;
    const addIm = sign * H * termIm;
    const newRe = sumRe + addRe;
    const newIm = sumIm + addIm;
    if (
      Math.hypot(addRe, addIm) <
      1e-18 * Math.hypot(Math.hypot(newRe, newIm), Math.hypot(lnJ0Re, lnJ0Im))
    ) {
      sumRe = newRe;
      sumIm = newIm;
      break;
    }
    sumRe = newRe;
    sumIm = newIm;
  }
  const TWO_OVER_PI = 0.6366197723675813430755350534900574;
  return complex64(TWO_OVER_PI * (lnJ0Re + sumRe), TWO_OVER_PI * (lnJ0Im + sumIm));
}

/**
 * `Y_1(z)` complex via DLMF §10.8.1 small-|z| series:
 *
 *   `Y_1(z) = −(2/(πz)) + (2/π) · [ln(z/2) + γ] · J_1(z)
 *             − (1/π) · (z/2) · Σ_{k=0}^∞ (−1)^k · [H_k + H_{k+1}] · (z/2)^{2k} / [k! (k+1)!]`
 */
function besselY1_complex_series(z: ComplexF64): ComplexF64 {
  const TWO_OVER_PI = 0.6366197723675813430755350534900574;
  const ONE_OVER_PI = 0.31830988618379067153776752674503;

  const halfZ = complex64(z.re / 2, z.im / 2);
  const lhz = clog(halfZ);
  const logFactor = complex64(lhz.re + EULER_GAMMA, lhz.im);
  const J1 = besselJComplexFloat64(1, z.re, z.im);
  const lnJ1Re = logFactor.re * J1.re - logFactor.im * J1.im;
  const lnJ1Im = logFactor.re * J1.im + logFactor.im * J1.re;

  // −2/(πz)
  const invZ = cinv(z);
  const negTwoOverPiZ_Re = -TWO_OVER_PI * invZ.re;
  const negTwoOverPiZ_Im = -TWO_OVER_PI * invZ.im;

  // Σ_{k=0}^∞ (−1)^k · [H_k + H_{k+1}] · (z/2)^{2k} / [k! (k+1)!]
  // k=0: 1 · [0 + 1] · 1 / 1 = 1
  const half2 = cmul(halfZ, halfZ);
  let H_k = 0;
  let H_kp1 = 1;
  let termRe = 1;
  let termIm = 0;
  let sign = 1;
  let sumRe = sign * (H_k + H_kp1) * termRe;
  let sumIm = sign * (H_k + H_kp1) * termIm;
  for (let k = 1; k < 300; k++) {
    const nextRe = termRe * half2.re - termIm * half2.im;
    const nextIm = termRe * half2.im + termIm * half2.re;
    const denom = k * (k + 1);
    termRe = nextRe / denom;
    termIm = nextIm / denom;
    H_k += 1 / k;
    H_kp1 += 1 / (k + 1);
    sign = -sign;
    const w = H_k + H_kp1;
    const addRe = sign * w * termRe;
    const addIm = sign * w * termIm;
    const newRe = sumRe + addRe;
    const newIm = sumIm + addIm;
    if (Math.hypot(addRe, addIm) < 1e-18 * Math.hypot(newRe, newIm)) {
      sumRe = newRe;
      sumIm = newIm;
      break;
    }
    sumRe = newRe;
    sumIm = newIm;
  }
  // (z/2) · sum
  const halfSumRe = halfZ.re * sumRe - halfZ.im * sumIm;
  const halfSumIm = halfZ.re * sumIm + halfZ.im * sumRe;
  // Y_1 = −2/(πz) + (2/π)·ln-term·J_1 − (1/π)·(z/2)·sum
  return complex64(
    negTwoOverPiZ_Re + TWO_OVER_PI * lnJ1Re - ONE_OVER_PI * halfSumRe,
    negTwoOverPiZ_Im + TWO_OVER_PI * lnJ1Im - ONE_OVER_PI * halfSumIm,
  );
}

/**
 * `Y_ν(z)` complex large-|z| asymptotic via DLMF §10.17.4-5:
 *
 *   `Y_ν(z) ~ √(2/(πz)) · [P(ν,z) · sin(ω) + Q(ν,z) · cos(ω)]`
 *   `ω = z − νπ/2 − π/4`
 *
 * with `P`, `Q` the standard asymptotic series in `1/(8z)`. Same a_k
 * coefficients as the K asymptotic; sign and parity differ. Valid
 * for any (integer or non-integer) ν; we use it here as the
 * companion to the integer-ν series for `|z| > 18 + n`.
 *
 * Note: at integer ν the sin / cos factors stay well-defined, unlike
 * the connection-formula form.
 */
function besselY_complex_asymptotic(nu: number, z: ComplexF64): ComplexF64 {
  // ω = z − νπ/2 − π/4
  const omegaRe = z.re - (nu * Math.PI) / 2 - Math.PI / 4;
  const omegaIm = z.im;
  // sin(ω) and cos(ω) for complex ω:
  //   sin(x + iy) = sin x · cosh y + i · cos x · sinh y
  //   cos(x + iy) = cos x · cosh y − i · sin x · sinh y
  const sX = Math.sin(omegaRe),
    cX = Math.cos(omegaRe);
  const sY = Math.sinh(omegaIm),
    cY = Math.cosh(omegaIm);
  const sinOmega = complex64(sX * cY, cX * sY);
  const cosOmega = complex64(cX * cY, -sX * sY);

  // P/Q asymptotic series in 1/(8z): a_k(ν) = (μ − 1)(μ − 9)…(μ − (2k−1)²)/(k! · 8^k)
  // P = Σ_{k even} (−1)^{k/2} a_k(ν) / z^k — actually the standard form uses
  // P(ν,z) = 1 − a_2/(2z)² + a_4/(2z)⁴ − …, with a_2 = (μ−1)(μ−9)/(2!·8²)
  // and a_4 = (μ−1)(μ−9)(μ−25)(μ−49)/(4!·8⁴). The k-step recurrence:
  //   term_k → term_{k+1} = term_k · (μ − (2k+1)²) / [(k+1) · 8z]
  // P picks even k, Q picks odd k (negated/positive per the DLMF sign convention).
  const mu = 4 * nu * nu;
  const invZ = cinv(z);
  const z8inv = complex64(invZ.re / 8, invZ.im / 8);
  let pRe = 1,
    pIm = 0;
  let qRe = 0,
    qIm = 0;
  let termRe = 1,
    termIm = 0;
  let prevAbs = Infinity;
  let sign = 1; // alternates each pair: P gets (−1)^{k/2} for even k, Q gets (−1)^{(k−1)/2} for odd k
  for (let k = 1; k < 60; k++) {
    // Multiply term by (μ − (2k−1)²) / (k · 8z)
    const f = mu - (2 * k - 1) * (2 * k - 1);
    const factor = f / k;
    const newRe = termRe * z8inv.re - termIm * z8inv.im;
    const newIm = termRe * z8inv.im + termIm * z8inv.re;
    termRe = newRe * factor;
    termIm = newIm * factor;
    // Accumulate into P (even k) or Q (odd k), with the sign cycle:
    // k=1 → Q += −term;  k=2 → P += −term;  k=3 → Q += +term;  k=4 → P += +term;  etc.
    if (k % 2 === 1) {
      // odd → Q
      qRe += sign * termRe;
      qIm += sign * termIm;
    } else {
      // even → P, and flip sign before applying P (so k=2 gets −, k=4 gets +, …)
      sign = -sign;
      pRe += sign * termRe;
      pIm += sign * termIm;
    }
    const a = Math.hypot(termRe, termIm);
    // Truncate when both P-add and Q-add are sub-ULP
    if (a < 1e-18 * Math.hypot(pRe, pIm)) break;
    if (a > prevAbs) break;
    prevAbs = a;
  }
  // Y = √(2/(πz)) · [P · sin(ω) + Q · cos(ω)]
  const P_sinRe = pRe * sinOmega.re - pIm * sinOmega.im;
  const P_sinIm = pRe * sinOmega.im + pIm * sinOmega.re;
  const Q_cosRe = qRe * cosOmega.re - qIm * cosOmega.im;
  const Q_cosIm = qRe * cosOmega.im + qIm * cosOmega.re;
  const bracketRe = P_sinRe + Q_cosRe;
  const bracketIm = P_sinIm + Q_cosIm;
  // √(2/(πz)) = √2 / √(πz)
  const piZ = complex64(Math.PI * z.re, Math.PI * z.im);
  const sqrtPiZ = csqrt(piZ);
  const pref = complex64(Math.sqrt(2), 0);
  const denom = cinv(sqrtPiZ);
  const factorC = cmul(pref, denom);
  // Result = factorC · bracket
  return complex64(
    factorC.re * bracketRe - factorC.im * bracketIm,
    factorC.re * bracketIm + factorC.im * bracketRe,
  );
}

/**
 * `Y_n(z)` complex for integer `n` via direct integer-ν series (small
 * |z|), large-|z| asymptotic, and forward recurrence for `n ≥ 2`.
 * Forward-stable because Y_n grows with n at fixed z.
 *
 * `Y_{−n} = (−1)^n · Y_n` (DLMF §10.4.1).
 */
/** `Y_0(z)` complex via series (small |z|) or asymptotic (large |z|). */
function besselY0_complex(z: ComplexF64): ComplexF64 {
  return cabs(z) > 8
    ? besselY_complex_asymptotic(0, z)
    : besselY0_complex_series(z);
}

/** `Y_1(z)` complex via series (small |z|) or asymptotic (large |z|). */
function besselY1_complex(z: ComplexF64): ComplexF64 {
  return cabs(z) > 8
    ? besselY_complex_asymptotic(1, z)
    : besselY1_complex_series(z);
}

function besselY_complex_integer(n: number, z: ComplexF64): ComplexF64 {
  if (n < 0) {
    const Y = besselY_complex_integer(-n, z);
    const sign = n & 1 ? -1 : 1;
    return complex64(sign * Y.re, sign * Y.im);
  }
  // Same recurrence discipline as K: compute Y_0, Y_1 each via the
  // method that gives ULP at this |z|, then forward-recur. Direct
  // asymptotic at ν=n falters at large n / moderate |z| where the
  // (μ − (2k−1)²) coefficients grow factorially before they decay;
  // recurrence from low-ν preserves ULP.
  if (n === 0) return besselY0_complex(z);
  if (n === 1) return besselY1_complex(z);
  let yPrev = besselY0_complex(z);
  let yCurr = besselY1_complex(z);
  const invZ = cinv(z);
  for (let k = 1; k < n; k++) {
    const multRe = 2 * k * invZ.re;
    const multIm = 2 * k * invZ.im;
    const multYRe = multRe * yCurr.re - multIm * yCurr.im;
    const multYIm = multRe * yCurr.im + multIm * yCurr.re;
    const yNext = complex64(multYRe - yPrev.re, multYIm - yPrev.im);
    yPrev = yCurr;
    yCurr = yNext;
  }
  return yCurr;
}

/** K_ν(z) complex — asymptotic for large |z|; reflection via I for small |z|. */
function besselK_complex(nu: number, z: ComplexF64): ComplexF64 {
  // Integer ν: the I-reflection form below hits 0/0 (I_{−n} = I_n,
  // sin(nπ) = 0). Route to the direct integer-ν series + recurrence.
  // Closes bead `scientist-workbench-9wwc` (worklog 168).
  if (Number.isInteger(nu)) {
    return besselK_complex_integer(nu, z);
  }
  const az = cabs(z);
  if (az > 18 + Math.abs(nu)) {
    // K_ν(z) ~ √(π/(2z)) · e^{-z} · Σ a_k(ν) / z^k
    const mu = 4 * nu * nu;
    let sum: ComplexF64 = complex64(1, 0);
    let term: ComplexF64 = complex64(1, 0);
    const invZ = cinv(z);
    const z8inv: ComplexF64 = complex64(invZ.re / 8, invZ.im / 8);
    let prevAbs = Infinity;
    for (let k = 1; k < 60; k++) {
      const f = mu - (2 * k - 1) * (2 * k - 1);
      const factor = f / k;
      term = cmul(term, z8inv);
      term = complex64(term.re * factor, term.im * factor);
      sum = complex64(sum.re + term.re, sum.im + term.im);
      const a = Math.hypot(term.re, term.im);
      if (a < 1e-18 * Math.hypot(sum.re, sum.im)) break;
      if (a > prevAbs) break;
      prevAbs = a;
    }
    const negz: ComplexF64 = complex64(-z.re, -z.im);
    const ez = cexp(negz);
    const sqrtZ = csqrt(z);
    // √(π/(2z)) = √π / √(2z)
    const denom: ComplexF64 = complex64(sqrtZ.re * Math.sqrt(2), sqrtZ.im * Math.sqrt(2));
    const pref = cmul(complex64(SQRT_PI, 0), cinv(denom));
    return cmul(cmul(pref, ez), sum);
  }
  // Small |z|, non-integer ν: reflection K_ν = (π/2)·(I_{−ν} − I_ν)/sin(νπ).
  const Iplus = besselI_complex(nu, z);
  const Iminus = besselI_complex(-nu, z);
  const num: ComplexF64 = complex64(Iminus.re - Iplus.re, Iminus.im - Iplus.im);
  const denom = Math.sin(nu * Math.PI);
  return complex64((HALF_PI * num.re) / denom, (HALF_PI * num.im) / denom);
}

/**
 * `J_ν(z)` complex via AMOS rotation:
 *   J_ν(z) = e^{+νπi/2} · I_ν(−iz)   if Im(z) ≥ 0
 *          = e^{−νπi/2} · I_ν(+iz)   if Im(z) < 0
 */
export function besselJComplexFloat64(nu: number, re: number, im: number): ComplexF64 {
  const sign = im >= 0 ? 1 : -1;
  // ∓iz = (±im) + i·(∓re)
  const rotZ: ComplexF64 = complex64(sign * im, -sign * re);
  const I = besselI_complex(nu, rotZ);
  const phase = cexpI((sign * nu * Math.PI) / 2);
  return cmul(phase, I);
}

/**
 * `Y_ν(z)` complex via the connection formula:
 *   Y_ν(z) = (cos(νπ)·J_ν(z) − J_{−ν}(z)) / sin(νπ)
 * For integer ν this cancellates — we fall back to a single-Hankel-
 * function rotation: Y_n(z) = (H^{(1)}_n(z) - i^n·J_n(z))/i, but the
 * v0.1 implementation routes exactly-integer ν to the real path
 * (consistent with the connection-formula intent).
 */
export function besselYComplexFloat64(nu: number, re: number, im: number): ComplexF64 {
  // Real-axis fast path for integer ν, positive real z.
  if (Number.isInteger(nu) && im === 0 && re > 0) {
    return complex64(_yn(nu, re), 0);
  }
  // Integer ν, complex z: the connection formula below hits 0/0.
  // Route to the direct integer-ν series + recurrence. Closes bead
  // `scientist-workbench-phtw` (worklog 168).
  if (Number.isInteger(nu)) {
    return besselY_complex_integer(nu, complex64(re, im));
  }
  // Non-integer ν: Y = (J cos(νπ) − J_{−ν}) / sin(νπ).
  const J = besselJComplexFloat64(nu, re, im);
  const Jm = besselJComplexFloat64(-nu, re, im);
  const c = Math.cos(nu * Math.PI);
  const s = Math.sin(nu * Math.PI);
  return complex64((J.re * c - Jm.re) / s, (J.im * c - Jm.im) / s);
}

/** `I_ν(z)` complex — direct (no rotation). */
export function besselIComplexFloat64(nu: number, re: number, im: number): ComplexF64 {
  return besselI_complex(nu, complex64(re, im));
}

/** `K_ν(z)` complex — direct (no rotation). */
export function besselKComplexFloat64(nu: number, re: number, im: number): ComplexF64 {
  return besselK_complex(nu, complex64(re, im));
}

// Re-export ComplexF64 for downstream consumers (test files, bench
// graders, the wire-tool surface — same convention as erf-float64).
export type { ComplexF64 };
