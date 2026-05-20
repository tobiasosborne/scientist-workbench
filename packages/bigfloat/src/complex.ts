// =============================================================================
// @workbench/bigfloat — BigComplex (arbitrary-precision complex)
// =============================================================================
//
// `BigComplex = { re: BigFloat, im: BigFloat }`. Both components carry their
// own precision — but in practice all operations take a single `prec`
// argument and produce a result with both `re` and `im` at that precision.
//
// MeijerG evaluation runs almost entirely in complex space (the contour
// integrand is complex; the residue sums use complex Γ; the result is
// generally complex on the negative real axis). The functions here are the
// minimum surface needed to bootstrap the Slater path:
//
//   arithmetic:   cadd / csub / cmul / cdiv / cneg / cabs (→ BigFloat)
//   conversion:   cfromReal / cfromInts / cre / cim / cconj
//   functions:    csqrt / cexp / clog / cgamma / clgamma / cdigamma
//
// Complex `sin / cos / atan / pow` and the inverse hyperbolics are
// straightforward (compose the above) and land in a future commit when
// the MeijerG hot path forces them.
//
// Special-function complex extensions (per-head substrate, ADR-0040 / 0041)
// ------------------------------------------------------------------------
//
// The bottom half of this module ships per-head complex-arb-prec
// evaluators alongside the bootstrap surface:
//
//   Erf family (ADR-0040 I3):  bigW + bigCErf / bigCErfc / bigCErfcx / bigCErfi
//   Bessel I/K (ADR-0041 I3a): bigCBesselI / bigCBesselIScaled
//                              bigCBesselK / bigCBesselKScaled
//   Bessel J/Y/H (ADR-0041 I3b): bigCBesselJ / bigCBesselY
//                                bigCHankelH1 / bigCHankelH2
//
// The Bessel I/K complex evaluators are the substrate **foundation** for
// the complex J/Y/H¹/H² lane (I3b): AMOS's TOMS 644 lineage (and FLINT's
// transcription) computes complex J and Y via the rotation
//
//     J_ν(z) = exp(s·νπi/2) · I_ν(-s·iz)                   (DLMF 10.27.6)
//     Y_ν(z) = (-2/π) · exp(-s·νπi/2) · K_ν(-s·iz)         (DLMF 10.27.8 + 10.27.10
//                + s · i · J_ν(z)                            via H¹ = J + iY)
//
// where `s = +1` if `Im(z) ≥ 0`, `s = -1` if `Im(z) < 0`.
//
// so the I/K primitives ship first (I3a, ~816 LOC above); J/Y/H¹/H²
// wrap them algebraically (I3b, ~700 LOC below).  ADR-0041 §"Decision
// 11" pins this round ordering — it is the single non-obvious
// algorithmic insight from R2 §3.3 that distinguishes Bessel's complex
// layer from the per-function-independent shape Erf used.  The reward:
// complex J at large |z| reuses I's series + asymp machinery rather
// than re-deriving a J-specific Hankel asymptotic with the cos(ω)·P −
// sin(ω)·Q mixing — strictly less code, strictly more canonical
// (AMOS's 40-year proven choice).
//
// Note on the Y formula: the ADR sketch wrote `Y = ±(2i/π)·exp(±νπi/2)·
// K_ν(∓iz) − exp(±νπi)·J_ν(z)`, but cross-validation against the Arb
// T5 golden corpus + mpmath revealed that the canonical DLMF-derived
// form is the one above (different sign convention on the J term and
// the K phase prefactor).  The ADR was load-bearing at the level of
// "K_ν(-iz) and J_ν(z) combine algebraically with a phase coefficient
// derived from the AMOS sign-choice"; the precise sign convention
// lives in this file's algorithm comments and is pinned by the
// golden-master suite.
//
// I3b — AMOS sign-choice convention (the load-bearing detail)
// -----------------------------------------------------------
//
// The rotation formula carries a ± choice that AMOS's `ZBESJ.f`
// (TOMS-644 source, the `IF (ZI.LT.0.0D0) GO TO N` branch around lines
// 134-160) selects via the sign of `Im(z)`:
//
//     if  Im(z) ≥ 0   (closed upper half-plane, including +real axis):
//         sign = +1 ⇒ J_ν(z) = exp(+νπi/2) · I_ν(-iz)
//     if  Im(z) < 0   (open lower half-plane):
//         sign = -1 ⇒ J_ν(z) = exp(-νπi/2) · I_ν(+iz)
//
// The geometric reason: the rotated argument `∓iz` carries the new
// real part `Re(∓iz) = ±Im(z)`.  With the AMOS convention, that real
// part is always `≥ 0`:
//
//     sign = +1, Im(z) ≥ 0:  Re(-iz) = +Im(z) ≥ 0   (right half-plane).
//     sign = -1, Im(z) < 0:  Re(+iz) = −Im(z) > 0   (right half-plane).
//
// I_ν has its "canonical-growth" half-plane on `Re(arg) ≥ 0`, where
// the series and the (deferred) asymptotic both converge most
// efficiently and where the cancellation in the connection formulas
// (DLMF 10.27.6) is minimal.  Picking the sign that lands `∓iz` in
// the right half-plane is therefore both correct (no branch-cut
// crossing) AND numerically optimal (smallest cancellation budget).
//
// This is NOT a stylistic choice.  Y_ν inherits the same sign by
// construction (the formula combines J and K_ν(∓iz)).  Dropping the
// sign branch — always using `+i` regardless of `Im(z)` sign — lights
// up the Q3/Q4 golden-master failures by sending z in the lower
// half-plane to `I_ν(+iz)` with `Re(+iz) < 0` (left half-plane, the
// wrong principal-branch sheet for I's connection formulas).  This is
// the M1 mutation below.

import { BigFloat, normalise, bitLength } from "./types.js";
import { abs, neg, sgn, isZero, eq } from "./comparison.js";
import { add, sub, mul, div, sqrt, powInt } from "./arithmetic.js";
import { fromInt, fromFloat64, fromString, toFloat64 } from "./conversion.js";
import {
  ln2,
  pi,
  e,
  exp,
  log,
  sin,
  cos,
  atan2,
} from "./transcendental.js";
import {
  gamma,
  lgamma,
  digamma,
} from "./special.js";
import {
  bigErf,
  bigErfc,
  bigErfcx,
} from "./special-funcs/erf.js";
import {
  bigBesselI,
  bigBesselIScaled,
} from "./special-funcs/besseli.js";
import {
  bigBesselK,
  bigBesselKScaled,
} from "./special-funcs/besselk.js";
import {
  bigBesselJ,
} from "./special-funcs/besselj.js";
import {
  bigBesselY,
} from "./special-funcs/bessely.js";

export interface BigComplex {
  readonly re: BigFloat;
  readonly im: BigFloat;
}

// =============================================================================
// Constructors / accessors
// =============================================================================

/** Real-only BigComplex from a BigFloat (im = 0). */
export function cfromReal(re: BigFloat): BigComplex {
  return { re, im: { mantissa: 0n, exponent: 0, precision: re.precision } };
}

/** BigComplex with integer real and imaginary parts. */
export function cfromInts(re: bigint | number, im: bigint | number, prec: number): BigComplex {
  return { re: fromInt(re, prec), im: fromInt(im, prec) };
}

/** BigComplex with both parts parsed from decimal strings. */
export function cfromStrings(re: string, im: string, prec: number): BigComplex {
  return { re: fromString(re, prec), im: fromString(im, prec) };
}

export function cre(z: BigComplex): BigFloat {
  return z.re;
}

export function cim(z: BigComplex): BigFloat {
  return z.im;
}

/** Complex conjugate. */
export function cconj(z: BigComplex): BigComplex {
  return { re: z.re, im: neg(z.im) };
}

/** Test whether the value is exactly zero (both parts zero). */
export function cisZero(z: BigComplex): boolean {
  return isZero(z.re) && isZero(z.im);
}

// =============================================================================
// Arithmetic
// =============================================================================

export function cadd(a: BigComplex, b: BigComplex, prec: number): BigComplex {
  return { re: add(a.re, b.re, prec), im: add(a.im, b.im, prec) };
}

export function csub(a: BigComplex, b: BigComplex, prec: number): BigComplex {
  return { re: sub(a.re, b.re, prec), im: sub(a.im, b.im, prec) };
}

export function cneg(a: BigComplex): BigComplex {
  return { re: neg(a.re), im: neg(a.im) };
}

/**
 * Complex multiplication. Standard (a.re·b.re − a.im·b.im,
 * a.re·b.im + a.im·b.re), computed at extra working precision to
 * avoid catastrophic cancellation in the real part for cases where
 * a.re·b.re ≈ a.im·b.im.
 */
export function cmul(a: BigComplex, b: BigComplex, prec: number): BigComplex {
  const work = prec + 16;
  const ac = mul(a.re, b.re, work);
  const bd = mul(a.im, b.im, work);
  const ad = mul(a.re, b.im, work);
  const bc = mul(a.im, b.re, work);
  return {
    re: sub(ac, bd, prec),
    im: add(ad, bc, prec),
  };
}

/**
 * Complex division.  (a / b) = (a · conj b) / |b|² .
 *
 * Numerically stable: scales both by the larger of |b.re|, |b.im| before
 * computing |b|² to avoid intermediate over/underflow. (Smith's algorithm.)
 */
export function cdiv(a: BigComplex, b: BigComplex, prec: number): BigComplex {
  if (cisZero(b)) {
    throw new RangeError("BigComplex: division by zero");
  }
  const work = prec + 16;
  const absRe = abs(b.re);
  const absIm = abs(b.im);
  // Smith's algorithm: choose the dominant component to scale by.
  if (sgn(sub(absRe, absIm, work)) >= 0) {
    // |b.re| ≥ |b.im|: r = b.im / b.re; denom = b.re + r·b.im.
    const r = div(b.im, b.re, work);
    const denom = add(b.re, mul(r, b.im, work), work);
    const numRe = add(a.re, mul(a.im, r, work), work);
    const numIm = sub(a.im, mul(a.re, r, work), work);
    return { re: div(numRe, denom, prec), im: div(numIm, denom, prec) };
  }
  // |b.im| > |b.re|: r = b.re / b.im; denom = b.re·r + b.im.
  const r = div(b.re, b.im, work);
  const denom = add(mul(b.re, r, work), b.im, work);
  const numRe = add(mul(a.re, r, work), a.im, work);
  const numIm = sub(mul(a.im, r, work), a.re, work);
  return { re: div(numRe, denom, prec), im: div(numIm, denom, prec) };
}

/**
 * `|z| = sqrt(re² + im²)`. Computed via the safe formula
 *   |z| = max·sqrt(1 + (min/max)²)    (avoids overflow/underflow)
 * for non-zero z.
 */
export function cabs(z: BigComplex, prec: number): BigFloat {
  if (cisZero(z)) return { mantissa: 0n, exponent: 0, precision: prec };
  const work = prec + 16;
  const absRe = abs(z.re);
  const absIm = abs(z.im);
  // max ≥ min ≥ 0.
  let max: BigFloat;
  let min: BigFloat;
  if (sgn(sub(absRe, absIm, work)) >= 0) {
    max = absRe;
    min = absIm;
  } else {
    max = absIm;
    min = absRe;
  }
  if (isZero(max)) {
    return { mantissa: 0n, exponent: 0, precision: prec };
  }
  if (isZero(min)) {
    // |z| = max exactly (other component zero).
    return normalise(max.mantissa, max.exponent, prec);
  }
  const ratio = div(min, max, work);
  const ratio2 = mul(ratio, ratio, work);
  const onePlusRatio2 = add(fromInt(1n, work), ratio2, work);
  const root = sqrt(onePlusRatio2, work);
  return mul(max, root, prec);
}

/**
 * `arg(z)` — principal value in `(−π, π]`. Uses `atan2(im, re)`.
 */
export function carg(z: BigComplex, prec: number): BigFloat {
  if (cisZero(z)) return { mantissa: 0n, exponent: 0, precision: prec };
  return atan2(z.im, z.re, prec);
}

// =============================================================================
// Functions: sqrt, exp, log
// =============================================================================

/**
 * Principal complex square root: `sqrt(z)` with `Re(sqrt(z)) ≥ 0`.
 *
 * Algorithm (numerically stable; from W. Kahan via mpmath / standard refs):
 *   Let r = |z|. Then
 *     re = sqrt((r + |z.re|) / 2)
 *     im = z.im / (2 · re)
 *   when z.re ≥ 0; for z.re < 0, swap roles to avoid catastrophic
 *   cancellation in the real-part formula.
 */
export function csqrt(z: BigComplex, prec: number): BigComplex {
  if (cisZero(z)) {
    return { re: { mantissa: 0n, exponent: 0, precision: prec },
             im: { mantissa: 0n, exponent: 0, precision: prec } };
  }
  const work = prec + 16;
  const r = cabs(z, work);
  const half = fromString("0.5", work);
  if (sgn(z.re) >= 0) {
    const reSq = mul(add(r, z.re, work), half, work);
    const newRe = sqrt(reSq, work);
    const newIm = div(z.im, mul(newRe, fromInt(2n, work), work), work);
    return { re: normalise(newRe.mantissa, newRe.exponent, prec),
             im: normalise(newIm.mantissa, newIm.exponent, prec) };
  }
  // z.re < 0: compute imaginary part first to avoid cancellation.
  const imSq = mul(sub(r, z.re, work), half, work);
  const newImAbs = sqrt(imSq, work);
  const newIm = sgn(z.im) >= 0 ? newImAbs : neg(newImAbs);
  const newRe = div(z.im, mul(newIm, fromInt(2n, work), work), work);
  return { re: normalise(newRe.mantissa, newRe.exponent, prec),
           im: normalise(newIm.mantissa, newIm.exponent, prec) };
}

/**
 * `exp(z) = exp(z.re) · (cos(z.im) + i·sin(z.im))`. Trig argument
 * reduction (modulo 2π) happens inside `sin` / `cos`, so the
 * computation is well-defined for any finite z.
 */
export function cexp(z: BigComplex, prec: number): BigComplex {
  const work = prec + 16;
  const expRe = exp(z.re, work);
  const cosIm = cos(z.im, work);
  const sinIm = sin(z.im, work);
  return {
    re: mul(expRe, cosIm, prec),
    im: mul(expRe, sinIm, prec),
  };
}

/**
 * `log(z) = log|z| + i·arg(z)`. Principal branch, `arg ∈ (−π, π]`.
 * Throws on `z = 0` (where the function has a logarithmic singularity).
 */
export function clog(z: BigComplex, prec: number): BigComplex {
  if (cisZero(z)) {
    throw new RangeError(`BigComplex.clog: argument is zero`);
  }
  const work = prec + 16;
  const r = cabs(z, work);
  const phi = carg(z, work);
  return {
    re: log(r, prec),
    im: normalise(phi.mantissa, phi.exponent, prec),
  };
}

/**
 * `pow(a, b) = exp(b · log(a))`. Principal branch via `clog` /
 * `cexp`. Throws on `a = 0` for non-positive real `b`.
 */
export function cpow(a: BigComplex, b: BigComplex, prec: number): BigComplex {
  if (cisZero(a)) {
    if (sgn(b.re) > 0 && isZero(b.im)) {
      return cfromReal({ mantissa: 0n, exponent: 0, precision: prec });
    }
    throw new RangeError(`BigComplex.cpow: 0^b for non-positive real b`);
  }
  const work = prec + 16;
  return cexp(cmul(b, clog(a, work), work), prec);
}

// =============================================================================
// Special functions for complex argument
// =============================================================================
//
// Stirling and the reflection formula extend to complex z trivially (they
// only require `clog`, `cexp`, `csin` — and the standard recurrence
// `Γ(z+1) = z·Γ(z)`). The implementations below mirror the real-argument
// versions in `special.ts`.

/**
 * `log Γ(z)` for complex z. Stirling + recurrence + reflection across
 * `Re(z) ≤ 1/2`.
 *
 * The principal branch of `log Γ` is taken: `Im(log Γ(z)) ∈ (−π, π]`
 * after each operation, with branch jumps absorbed in the recurrence
 * (each `clog(z+k)` contributes its own branch choice).
 */
export function clgamma(z: BigComplex, prec: number): BigComplex {
  // For real z > 0, defer to the real-argument lgamma.
  if (isZero(z.im) && sgn(z.re) > 0) {
    return cfromReal(lgamma(z.re, prec));
  }
  // Reflection if Re(z) < 1/2.
  const half = fromString("0.5", z.re.precision);
  if (sgn(sub(z.re, half, prec + 16)) < 0) {
    // log Γ(z) = log π − log sin(π z) − log Γ(1 − z).
    return clgammaReflect(z, prec);
  }
  return clgammaShifted(z, prec);
}

/**
 * Stirling-shifted log Γ for `Re(z) ≥ 1/2`. Recurrence shifts z up to
 * a Stirling-friendly threshold, then applies Stirling.
 */
function clgammaShifted(z: BigComplex, prec: number): BigComplex {
  const work = prec + 96;
  const shiftThreshold = Math.max(8, Math.ceil(work / 8));
  const reFloat = toFloat64(z.re).value;
  if (!Number.isFinite(reFloat)) {
    throw new RangeError(`clgamma: Re(z) too large`);
  }
  const N = Math.max(0, Math.ceil(shiftThreshold - reFloat));
  // log Γ(z) = log Γ(z+N) − Σ log(z+k).
  const zShifted: BigComplex = {
    re: add(z.re, fromInt(BigInt(N), work), work),
    im: z.im,
  };
  let result = clgammaStirling(zShifted, work);
  for (let k = 0; k < N; k++) {
    const zk: BigComplex = {
      re: add(z.re, fromInt(BigInt(k), work), work),
      im: z.im,
    };
    result = csub(result, clog(zk, work), work);
  }
  return {
    re: normalise(result.re.mantissa, result.re.exponent, prec),
    im: normalise(result.im.mantissa, result.im.exponent, prec),
  };
}

/**
 * Stirling's series for log Γ at complex z with `Re(z)` Stirling-friendly.
 * Same shape as `lgammaStirling` but every operation is complex.
 */
function clgammaStirling(z: BigComplex, prec: number): BigComplex {
  const work = prec + 32;
  const half: BigComplex = cfromReal(fromString("0.5", work));
  const logZ = clog(z, work);
  const log2pi = add(ln2(work), log(pi(work), work), work);
  const halfLog2pi: BigComplex = cfromReal(mul(log2pi, fromString("0.5", work), work));
  // (z - 1/2) · log z - z + (1/2) log(2π).
  let result = csub(cmul(csub(z, half, work), logZ, work), z, work);
  result = cadd(result, halfLog2pi, work);
  // Stirling correction series:  Σ B_{2k} / (2k(2k-1) z^{2k-1}).
  const oneOverZ = cdiv(cfromReal(fromInt(1n, work)), z, work);
  const oneOverZ2 = cmul(oneOverZ, oneOverZ, work);
  let zPow = oneOverZ;
  let prevTermMag = Infinity;
  // Reuse bernoulli from special.ts (real-valued).
  // We need to import or re-derive — here we duplicate the small helper.
  for (let k = 1; k <= 300; k++) {
    const B2kRat = bernoulliRationalLocal(2 * k);
    if (B2kRat.num === 0n) break;
    const B2kFloat = bernoulliFloat(B2kRat, work);
    if (B2kFloat.mantissa === 0n) break;
    const denomCoeff = fromInt(BigInt(2 * k * (2 * k - 1)), work);
    const term = cdiv(
      cmul(cfromReal(B2kFloat), zPow, work),
      cfromReal(denomCoeff),
      work,
    );
    const termMag = magBits(term);
    if (termMag < -prec - 16) {
      result = cadd(result, term, work);
      break;
    }
    if (termMag > prevTermMag) break;
    result = cadd(result, term, work);
    prevTermMag = termMag;
    zPow = cmul(zPow, oneOverZ2, work);
  }
  return {
    re: normalise(result.re.mantissa, result.re.exponent, prec),
    im: normalise(result.im.mantissa, result.im.exponent, prec),
  };
}

function magBits(z: BigComplex): number {
  // log2 of |z|, approximated. Returns -Infinity for zero.
  if (cisZero(z)) return -Infinity;
  // Use the larger of |re|, |im| as a proxy.
  const reMan = z.re.mantissa < 0n ? -z.re.mantissa : z.re.mantissa;
  const imMan = z.im.mantissa < 0n ? -z.im.mantissa : z.im.mantissa;
  const reMag = z.re.mantissa === 0n ? -Infinity : z.re.exponent + bitLength(reMan);
  const imMag = z.im.mantissa === 0n ? -Infinity : z.im.exponent + bitLength(imMan);
  return Math.max(reMag, imMag);
}

// Local copies of the bernoulli helpers — avoid circular imports between
// `complex.ts` and `special.ts`. Cheap; the rational cache is the
// load-bearing part and lives in `bernoulli.ts`.
import { bernoulliRational } from "./bernoulli.js";
function bernoulliRationalLocal(n: number): { num: bigint; den: bigint } {
  return bernoulliRational(n);
}
function bernoulliFloat(r: { num: bigint; den: bigint }, prec: number): BigFloat {
  if (r.num === 0n) return { mantissa: 0n, exponent: 0, precision: prec };
  const safety = 32;
  const workingBits = prec + safety;
  const sign = r.num < 0n ? -1n : 1n;
  const absNum = sign === -1n ? -r.num : r.num;
  const numShifted = absNum << BigInt(workingBits);
  const q = numShifted / r.den;
  const remainder = numShifted - q * r.den;
  const qWithSticky = remainder === 0n ? q : q | 1n;
  return normalise(sign * qWithSticky, -workingBits, prec);
}

/**
 * Reflection branch of `clgamma` for `Re(z) < 1/2`:
 *
 *     log Γ(z) = log π − log sin(π z) − log Γ(1 − z).
 *
 * Γ's poles are the non-positive integers; the reflection formula sees
 * them through `sin(π z) → 0`. The numerically delicate regime is `z`
 * ε-close to such a pole — `z = m + ζ` with `m = round(Re z)` an integer
 * and `|ζ|` tiny — and the naïve `sin(π z)` is *catastrophically* lossy
 * there (bead oj5j). Two compounding cancellations:
 *
 *   1. forming `π·z` at a fixed working precision truncates the `π·ζ`
 *      information, which lives `≈ −log₂|ζ|` bits *below* `π·m`;
 *   2. `sin`'s own argument reduction then subtracts the large integer
 *      multiple of `π/2`, re-doing the same subtraction.
 *
 * The cure is to reduce `z → ζ` *before* multiplying by π, so the one
 * unavoidable cancellation is localised to the single subtraction
 * `ζ = z − m`, and `π·ζ` is then formed directly from a quantity that
 * already has the right magnitude. We use
 *
 *     sin(π z) = sin(π m + π ζ) = (−1)ᵐ · sin(π ζ),
 *
 * and `sin(π ζ)` is computed via `cexp(±iπζ)` — but now on the *reduced*
 * argument, so the `sin` / `cos` inside `cexp` see a small angle and do
 * no spurious reduction of their own. The residual cancellation that
 * survives (e.g. `exp(−x) − exp(x)` for tiny imaginary `ζ`) is bounded
 * by the same `−log₂|ζ|`, so the working precision is bumped by that
 * measured `lossBits` — the reduction localises the loss, the bump pays
 * for it. For `m = 0` (the region `Re(z) ∈ (−½, ½)`) there is no integer
 * to peel off and the computation is byte-identical to the pre-oj5j
 * code: `ζ = z`, `lossBits = 0`, `work = prec + 32`.
 *
 * Throws on non-positive integer real z (the poles themselves).
 */
function clgammaReflect(z: BigComplex, prec: number): BigComplex {
  const reFloat = toFloat64(z.re).value;
  if (!Number.isFinite(reFloat)) {
    throw new RangeError(`clgamma: Re(z) not finite`);
  }
  // z = m + ζ with m the nearest integer. m ≤ 0 across the whole
  // reflection region (Re z < ½), but we keep the sign general.
  const m = Math.round(reFloat);
  const inPrec = Math.max(z.re.precision, z.im.precision);

  // ζ = z − m, first at the input's own precision: that is the most
  // information about ζ that physically exists. For m = 0 the integer
  // shift is a no-op and ζ is z verbatim — this is what keeps the
  // Re(z) ∈ (−½, ½) region bit-for-bit unchanged.
  let zeta0: BigComplex;
  if (m === 0) {
    zeta0 = z;
  } else {
    zeta0 = { re: sub(z.re, fromInt(BigInt(m), inPrec), inPrec), im: z.im };
  }

  // The pole: z is exactly the non-positive integer m (ζ = 0, z real).
  if (m <= 0 && isZero(z.im) && isZero(zeta0.re)) {
    throw new RangeError(
      `clgamma: argument is a non-positive integer (Γ has a pole)`,
    );
  }

  // Cancellation depth of the formula at this z: how many leading bits
  // the subtraction `z − m` annihilates, equivalently how many bits of
  // `sin(π ζ)` sit below the noise floor of a naïve evaluation. `|z|` is
  // O(|m|) ≥ ½ near a pole; `|ζ|` can be arbitrarily small. The working
  // precision must carry `prec` good bits *below* this loss.
  const lossBits =
    m === 0 ? 0 : Math.max(0, magBits(z) - magBits(zeta0));
  const work = prec + 32 + lossBits;

  // Re-form ζ at the bumped working precision. (For m = 0, zeta is z and
  // `work` is prec + 32 — the downstream calls reproduce the old code.)
  const zeta: BigComplex =
    m === 0
      ? z
      : { re: sub(z.re, fromInt(BigInt(m), work), work), im: z.im };

  const piW = pi(work);
  // sin(π ζ) = (cexp(iπζ) − cexp(−iπζ)) / (2i), with iπζ formed directly
  // from the reduced ζ — small magnitude, so the trig inside `cexp`
  // sees a small angle.
  const piTimesZeta: BigComplex = {
    re: mul(piW, zeta.re, work),
    im: mul(piW, zeta.im, work),
  };
  const iPiZeta: BigComplex = { re: neg(piTimesZeta.im), im: piTimesZeta.re };
  const eIPlus = cexp(iPiZeta, work);
  const eIMinus = cexp(cneg(iPiZeta), work);
  const numer = csub(eIPlus, eIMinus, work);
  // Divide by 2i:  (a + bi) / (2i) = b/2 − (a/2)i.
  const sinPiZeta: BigComplex = {
    re: div(numer.im, fromInt(2n, work), work),
    im: neg(div(numer.re, fromInt(2n, work), work)),
  };
  // sin(π z) = (−1)ᵐ · sin(π ζ). `m % 2 === 0` is the parity test that
  // also holds for negative m (only 0 maps to "even" incorrectly — and
  // 0 is even).
  const sinPiZ: BigComplex =
    m % 2 === 0 ? sinPiZeta : cneg(sinPiZeta);
  if (cisZero(sinPiZ)) {
    throw new RangeError(`clgamma: pole at z = ${reFloat}`);
  }

  // log Γ(1 − z): 1 − z sits far from every pole when z is near one, so
  // this branch is well-conditioned and is computed from z directly.
  const oneMinusZ: BigComplex = {
    re: sub(fromInt(1n, work), z.re, work),
    im: neg(z.im),
  };
  // log π − log sin(π z) − log Γ(1 − z).
  const logPi = cfromReal(log(piW, work));
  const logSin = clog(sinPiZ, work);
  const logGammaOneMinus = clgamma(oneMinusZ, work);
  const result = csub(csub(logPi, logSin, work), logGammaOneMinus, work);
  return {
    re: normalise(result.re.mantissa, result.re.exponent, prec),
    im: normalise(result.im.mantissa, result.im.exponent, prec),
  };
}

/**
 * `Γ(z)` for complex z. `cgamma(z) = cexp(clgamma(z))`. Throws on
 * non-positive integer real z.
 */
export function cgamma(z: BigComplex, prec: number): BigComplex {
  // For real positive z, defer to the real gamma (faster, cleaner).
  if (isZero(z.im) && sgn(z.re) > 0) {
    return cfromReal(gamma(z.re, prec));
  }
  return cexp(clgamma(z, prec + 16), prec);
}

/**
 * `ψ(z)` (digamma) for complex z. Stirling + recurrence + reflection
 * (`ψ(1−z) − ψ(z) = π·cot(π z)`).
 */
export function cdigamma(z: BigComplex, prec: number): BigComplex {
  if (isZero(z.im) && sgn(z.re) > 0) {
    return cfromReal(digamma(z.re, prec));
  }
  const half = fromString("0.5", z.re.precision);
  if (sgn(sub(z.re, half, prec + 16)) < 0) {
    return cdigammaReflect(z, prec);
  }
  return cdigammaShifted(z, prec);
}

function cdigammaShifted(z: BigComplex, prec: number): BigComplex {
  const work = prec + 96;
  const shiftThreshold = Math.max(8, Math.ceil(work / 8));
  const reFloat = toFloat64(z.re).value;
  if (!Number.isFinite(reFloat)) {
    throw new RangeError(`cdigamma: Re(z) too large`);
  }
  const N = Math.max(0, Math.ceil(shiftThreshold - reFloat));
  const zShifted: BigComplex = {
    re: add(z.re, fromInt(BigInt(N), work), work),
    im: z.im,
  };
  let result = cdigammaStirling(zShifted, work);
  for (let k = 0; k < N; k++) {
    const zk: BigComplex = {
      re: add(z.re, fromInt(BigInt(k), work), work),
      im: z.im,
    };
    result = csub(result, cdiv(cfromReal(fromInt(1n, work)), zk, work), work);
  }
  return {
    re: normalise(result.re.mantissa, result.re.exponent, prec),
    im: normalise(result.im.mantissa, result.im.exponent, prec),
  };
}

function cdigammaStirling(z: BigComplex, prec: number): BigComplex {
  const work = prec + 32;
  const logZ = clog(z, work);
  const oneOverZ = cdiv(cfromReal(fromInt(1n, work)), z, work);
  const halfOverZ = cdiv(oneOverZ, cfromReal(fromInt(2n, work)), work);
  let result = csub(logZ, halfOverZ, work);
  const oneOverZ2 = cmul(oneOverZ, oneOverZ, work);
  let zPow = oneOverZ2;
  let prevTermMag = Infinity;
  for (let k = 1; k <= 300; k++) {
    const B2kRat = bernoulliRationalLocal(2 * k);
    if (B2kRat.num === 0n) break;
    const B2kFloat = bernoulliFloat(B2kRat, work);
    if (B2kFloat.mantissa === 0n) break;
    const denomCoeff = fromInt(BigInt(2 * k), work);
    const term = cdiv(
      cmul(cfromReal(B2kFloat), zPow, work),
      cfromReal(denomCoeff),
      work,
    );
    const termMag = magBits(term);
    if (termMag < -prec - 16) {
      result = csub(result, term, work);
      break;
    }
    if (termMag > prevTermMag) break;
    result = csub(result, term, work);
    prevTermMag = termMag;
    zPow = cmul(zPow, oneOverZ2, work);
  }
  return {
    re: normalise(result.re.mantissa, result.re.exponent, prec),
    im: normalise(result.im.mantissa, result.im.exponent, prec),
  };
}

/**
 * Reflection branch of `cdigamma` for `Re(z) < 1/2`:
 *
 *     ψ(z) = ψ(1 − z) − π · cot(π z).
 *
 * `cot(π z)` carries the same near-pole catastrophic cancellation that
 * `sin(π z)` does in `clgammaReflect` — `cot` has simple poles at the
 * integers, so an ε-close `z` makes `cot(π z) ≈ 1/(π ζ)` enormous, and a
 * naïve `cos(π z) / sin(π z)` truncates the `ζ` information when it forms
 * `π·z`. The cure is identical (bead oj5j): reduce `z → ζ = z − m`
 * *before* multiplying by π. `cot` is π-periodic, so here the integer
 * shift drops out entirely —
 *
 *     cot(π z) = cot(π m + π ζ) = cot(π ζ)
 *
 * — no `(−1)ᵐ` sign to carry. Working precision is bumped by the
 * measured cancellation depth `lossBits`, and `m = 0` reproduces the
 * pre-oj5j computation bit-for-bit.
 */
function cdigammaReflect(z: BigComplex, prec: number): BigComplex {
  const reFloat = toFloat64(z.re).value;
  if (!Number.isFinite(reFloat)) {
    throw new RangeError(`cdigamma: Re(z) not finite`);
  }
  const m = Math.round(reFloat);
  const inPrec = Math.max(z.re.precision, z.im.precision);

  // ζ = z − m. For m = 0 the shift is a no-op (ζ is z verbatim), which
  // is what keeps the Re(z) ∈ (−½, ½) region bit-for-bit unchanged.
  const zeta0: BigComplex =
    m === 0
      ? z
      : { re: sub(z.re, fromInt(BigInt(m), inPrec), inPrec), im: z.im };

  // The pole: z is exactly the non-positive integer m (ζ = 0, z real).
  if (m <= 0 && isZero(z.im) && isZero(zeta0.re)) {
    throw new RangeError(
      `cdigamma: argument is a non-positive integer (ψ has a pole)`,
    );
  }

  // Cancellation depth: how many leading bits `z − m` annihilates.
  const lossBits =
    m === 0 ? 0 : Math.max(0, magBits(z) - magBits(zeta0));
  const work = prec + 32 + lossBits;
  const zeta: BigComplex =
    m === 0
      ? z
      : { re: sub(z.re, fromInt(BigInt(m), work), work), im: z.im };

  const piW = pi(work);
  // cot(π z) = cot(π ζ) = cos(π ζ) / sin(π ζ), with iπζ formed directly
  // from the reduced ζ so the trig inside `cexp` sees a small angle.
  const piTimesZeta: BigComplex = {
    re: mul(piW, zeta.re, work),
    im: mul(piW, zeta.im, work),
  };
  const iPiZeta: BigComplex = { re: neg(piTimesZeta.im), im: piTimesZeta.re };
  const ePlus = cexp(iPiZeta, work);
  const eMinus = cexp(cneg(iPiZeta), work);
  const cosPiZeta: BigComplex = {
    re: div(add(ePlus.re, eMinus.re, work), fromInt(2n, work), work),
    im: div(add(ePlus.im, eMinus.im, work), fromInt(2n, work), work),
  };
  const sinPiZeta: BigComplex = {
    re: div(sub(ePlus.im, eMinus.im, work), fromInt(2n, work), work),
    im: neg(div(sub(ePlus.re, eMinus.re, work), fromInt(2n, work), work)),
  };
  if (cisZero(sinPiZeta)) {
    throw new RangeError(`cdigamma: pole at z = ${reFloat}`);
  }
  const cotPiZ = cdiv(cosPiZeta, sinPiZeta, work);
  const piCot = cmul(cfromReal(piW), cotPiZ, work);
  // ψ(1 − z): 1 − z is far from every pole when z is near one — computed
  // from z directly, well-conditioned.
  const oneMinusZ: BigComplex = {
    re: sub(fromInt(1n, work), z.re, work),
    im: neg(z.im),
  };
  const result = csub(cdigamma(oneMinusZ, work), piCot, work);
  return {
    re: normalise(result.re.mantissa, result.re.exponent, prec),
    im: normalise(result.im.mantissa, result.im.exponent, prec),
  };
}

// =============================================================================
// Erf family for complex argument — Karbach-Weideman Faddeeva (ADR-0040 / R2)
// =============================================================================
//
// `bigW(z, prec)` is the complex-arb-prec Faddeeva primitive
//
//     w(z) := e^(-z²) · erfc(-i z)              (Karbach 2014 eq. 1)
//
// from which the four entry points `bigCErf`, `bigCErfc`, `bigCErfcx`,
// `bigCErfi` derive algebraically via DLMF §7.4 / Karbach §2 — each is a
// ~5-10 LOC closed-form composition.
//
// Algorithm pick (per `docs/refs/erf-research/R2-arbprec-algorithms.md`
// §"Faddeeva pick — justification" and the I3 impl plan): **Karbach 2014's
// Weideman-Fourier scheme**. The justification stack:
//
//   1. **Closed-form prec-scaling.** Karbach is the only Faddeeva algorithm
//      whose truncation parameters `(τ_m, N)` have closed-form
//      precision-dependence. Poppe-Wijers + Algorithm 916 (which Stephen
//      Johnson's float64 `Faddeeva.cc` uses) have empirically-fitted `nu`
//      formulae that hold only at double precision; re-deriving them at
//      arb-prec would be a research project of its own. Karbach scales
//      analytically: `τ_m(p) = √(4(p·ln 2 − ln 4))`, `N(p) = ⌈(τ_m/π) ·
//      √(p·ln 2)⌉`.
//   2. **Single algorithm, all `z`.** No region-by-region dispatch with
//      awkward seams. The truncated Fourier sum (Karbach 2014 eq. 37) gives
//      the same convergence rate everywhere in the first quadrant after
//      symmetry reduction.
//   3. **O(p) complex Horner steps per evaluation.** At p = 196 bits
//      (≈ 50 dp), N ≈ 87; at p = 1024 (≈ 300 dp), N ≈ 480. Comparable
//      cost to `cgamma` at the same precision.
//   4. **Mirror symmetry reduces to first quadrant** before the main sum
//      runs, mirroring `clgamma`'s `Re(z) < ½` reflection — a familiar
//      pattern in this module.
//
// Identity table (Karbach §2 / DLMF §7.4):
//
//     erfcx(z) = w(iz)
//     erf(z)   = 1 - e^(-z²) · w(iz)                 for Re(z) ≥ 0
//     erf(z)   = e^(-z²) · w(-iz) - 1                for Re(z) < 0
//     erfc(z)  = e^(-z²) · w(iz)                     for Re(z) ≥ 0
//     erfc(z)  = 2 - e^(-z²) · w(-iz)                for Re(z) < 0
//     erfi(z)  = -i · erf(i z)
//
// The half-plane sign split keeps every derived call away from cancellation
// — for `Re(z) ≥ 0`, `w(iz)` is well-defined and bounded; for `Re(z) < 0`
// the analogous bound holds for `w(-iz)`. The wrong-sign branch would lead
// `exp(-z²) · w(iz)` to grow without bound as `Re(z) → -∞`, which is
// representable in BigFloat (exponent is unbounded) but adds avoidable bit
// loss in the algebra.
//
// Restriction-to-real-axis (load-bearing cross-check)
// ---------------------------------------------------
//
// For `z = x + 0i` with `x ≥ 0` (real, non-negative), `bigCErf(z, prec)`
// must agree *byte-for-byte* with `bigErf(x, prec)` in `.re` and emit
// exactly `0` in `.im`. The naïve path (Karbach formula on `iz = ix` with
// `Re(iz) = 0`, then peel off `1 - exp(-z²)·w(iz)`) would produce a
// numerically-correct answer that *isn't* bit-identical to the real lane:
// different intermediate rounding paths. The cure is to special-case
// `isZero(z.im)` and defer to the I1 / I2 real substrate, mirroring how
// `cgamma` defers to `gamma` for `z = x + 0i, x > 0`. This is the
// load-bearing tie between the I1 and I3 lanes; it surfaces in the
// `bigCErf(complex(x, 0)).re ≡ bigErf(x)` property test.
//
// Stokes-line singularities (Karbach §5.1)
// ----------------------------------------
//
// The Karbach formula eq. 37 has removable singularities at `z_n = ±nπ/τ_m`
// for `n = 0, 1, …, N` (the numerator and denominator both vanish; the
// limit exists but the formula goes 0/0). Within a small disc around each
// `z_n`, Karbach §5.1 prescribes a 5-term Taylor expansion. R2 §5.5 noted
// that "the singularity discs are rare events" at our scales and that a
// flagged refusal is acceptable for v0.1. We follow the literature:
// **detect the disc, throw `RangeError` with `suggestion:` line** naming
// the singular `z_n` and the v0.2 Taylor-disc work. The disc radius at
// double precision is `r ≈ 3e-3`; at arb-prec it scales to `2^(-prec/3)`.
// Following Karbach we keep a fixed-radius `1e-3` (in the BigFloat
// `magBits` sense, ~10 bits) as the loud trigger; any caller landing
// inside gets a clean refusal naming the singularity, not silent garbage.
//
// Coefficient caching (mirrors `_piCache` / `_ln2Cache`)
// ------------------------------------------------------
//
// The Karbach coefficients `a_n = (2√π / τ_m) · exp(-n²π²/τ_m²)` for
// `n = 0, …, N` depend on `prec` (via `τ_m(prec)` and `N(prec)`) but not
// on `z`. They are precomputed at first call per `prec` and cached in a
// `Map<number, KarbachEntry>` — the same pattern as the `_piCache` /
// `_ln2Cache` in `transcendental.ts:41-43`. At `prec = 1024` the cache
// entry is ~60 KB; at `prec = 3322` (~1000 dp), ~480 KB. Negligible.
//
// References (all in repo)
// ------------------------
//   - docs/adr/0040-per-head-special-function-substrate-and-meijer-g-bridge.md
//     §"Decision 3"
//   - docs/refs/erf-research/R2-arbprec-algorithms.md §4.4-§5.5
//   - docs/refs/erf-research/PHASE2-impl-plans.md §"I3"
//   - packages/bigfloat/src/special-funcs/erf.ts (I1 real-axis substrate)
//   - DLMF §7.2 (Faddeeva), §7.4 (identity table), §7.10 (derivatives)

/**
 * Karbach-Weideman truncation parameters, derived from `prec` (in bits).
 *
 *   τ_m(p) = √(4·(p·ln 2 − ln 4))    integration cutoff
 *   N(p)   = ⌈(τ_m/π) · √(p·ln 2 + log(2√π/τ_m))⌉ + 1   Fourier term count
 *
 * Derivation (R2 §4.4): `a_N < 2^-p ⟹ N²π² / τ_m² > p·ln 2 + log(2√π/τ_m)`.
 *
 * The `+ 1` on N is a safety bump (Karbach paper's published numbers
 * match for `(p=53) → (12, 23)`; the `+1` keeps us comfortably in the
 * "headroom" regime that the Karbach truncation-error bound assumes).
 *
 * Returns `Number`-valued parameters. `τ_m` here is the **float64
 * approximation** used to size the loop (the N computation) and as a
 * sanity reference; the **actual** τ_m consumed by `karbachCoeffs` is
 * recomputed at full BigFloat working precision (see the body of
 * `karbachCoeffs`). The float64 value is correct to ~16 dp; that is
 * fine for choosing N (any over- or under-count of one or two terms is
 * harmless), but `a_n` and `(τ_m z)` need full precision because they
 * feed every iteration. Bit-determinism is preserved because the
 * coefficient table is generated from the BigFloat τ_m deterministically
 * and cached.
 */
function karbachParams(prec: number): { tau_m: number; N: number } {
  const eps = Math.pow(2, -prec);
  const tau_m = Math.sqrt(-4 * Math.log(eps / 4));
  const N_real = (tau_m / Math.PI) *
    Math.sqrt(prec * Math.LN2 + Math.log(2 * Math.sqrt(Math.PI) / tau_m));
  return { tau_m, N: Math.ceil(N_real) + 1 };
}

interface KarbachEntry {
  readonly prec: number;
  readonly tau_m: BigFloat;
  readonly N: number;
  readonly a: readonly BigFloat[];    // length N + 1; a[n] = (2√π / τ_m) · exp(-n²π²/τ_m²)
  readonly piOverTau: BigFloat;       // π / τ_m, used by the singularity check
  // Pre-emitted (nπ) values at working precision — the main loop hits each one.
  readonly nPi: readonly BigFloat[];  // length N + 1; nPi[n] = n · π
  readonly nPiSq: readonly BigFloat[]; // length N + 1; nPiSq[n] = (n·π)²
}

/**
 * Per-precision Karbach coefficient cache. Keyed on the `prec` argument
 * passed to `bigW`; first call at a given prec generates the table,
 * subsequent calls reuse the cached entry byte-identically. Mirrors the
 * `_piCache` / `_ln2Cache` / `_eCache` pattern in `transcendental.ts`.
 *
 * Note: the cache is keyed on `prec` literally — *not* on the input z's
 * precision or magnitude. The same Karbach table serves every `z` at a
 * given `prec`; this is the load-bearing reason the per-`prec` precompute
 * is admissible. R2 §4.5 has the memory-cost analysis (~60 KB at p=1024).
 */
const _karbachCache = new Map<number, KarbachEntry>();

function karbachCoeffs(prec: number): KarbachEntry {
  const cached = _karbachCache.get(prec);
  if (cached) return cached;
  // Working precision: a generous `prec + 64` margin. τ_m enters every
  // coefficient via the `a_n = (2√π/τ_m) · exp(-(nπ/τ_m)²)` formula, so
  // its precision directly determines the accuracy of every `a_n`. The
  // load-bearing detail: τ_m is computed in **BigFloat** (not float64)
  // for `prec ≥ 80` — a float64 τ_m has relative error ~2^-52, which
  // propagates to each `a_n` as `2(nπ/τ_m)² · δτ_m/τ_m`, peaking at
  // `2·p·ln2 · 2^-52 ≈ 2p · 1.1e-16` at n=N. At prec=400 that's a
  // ~9e-14 floor in every `a_n` — gives only ~13 dp of accuracy. The
  // BigFloat τ_m path delivers full prec-precision throughout.
  const work = prec + 64;
  const { N } = karbachParams(prec);
  const piW = pi(work);
  // Compute τ_m at working precision in BigFloat.
  //   τ_m(p) = √(4·(p·ln 2 - ln 4)) = 2·√(p·ln 2 - 2·ln 2) = 2·√((p-2)·ln 2)
  // (since ln 4 = 2 ln 2).
  const ln2W = ln2(work);
  const pMinus2 = fromInt(BigInt(prec - 2), work);
  const insideSqrt = mul(pMinus2, ln2W, work);
  const halfTau = sqrt(insideSqrt, work);
  const tau_mWork = mul(fromInt(2n, work), halfTau, work);
  // Build the coefficient table using the BigFloat τ_m.
  const sqrtPiW = sqrt(piW, work);
  const twoSqrtPi = mul(fromInt(2n, work), sqrtPiW, work);
  const twoSqrtPiOverTau = div(twoSqrtPi, tau_mWork, work);
  const piOverTau = div(piW, tau_mWork, work);
  // a_n = (2√π / τ_m) · exp(-n²π²/τ_m²). Compute (nπ/τ_m)² once and reuse.
  const a: BigFloat[] = new Array(N + 1);
  const nPi: BigFloat[] = new Array(N + 1);
  const nPiSq: BigFloat[] = new Array(N + 1);
  for (let n = 0; n <= N; n++) {
    const nPiW = mul(fromInt(BigInt(n), work), piW, work);
    const nPiOverTau = div(nPiW, tau_mWork, work);
    const sq = mul(nPiOverTau, nPiOverTau, work);
    const expTerm = exp(neg(sq), work);
    a[n] = mul(twoSqrtPiOverTau, expTerm, work);
    nPi[n] = nPiW;
    nPiSq[n] = mul(nPiW, nPiW, work);
  }
  const entry: KarbachEntry = { prec, tau_m: tau_mWork, N, a, piOverTau, nPi, nPiSq };
  _karbachCache.set(prec, entry);
  return entry;
}

/**
 * `magBits(z)` for a BigFloat — the integer log₂ of |z|, used by the
 * singularity-disc check inside `bigW`. Returns `-Infinity` for exact
 * zero. Local copy (the existing `magBits` in this module operates on
 * `BigComplex`); kept inline so the Faddeeva block reads top-down without
 * cross-section helper hunting.
 */
function bfMagBits(x: BigFloat): number {
  if (x.mantissa === 0n) return -Infinity;
  const m = x.mantissa < 0n ? -x.mantissa : x.mantissa;
  return x.exponent + bitLength(m);
}

/**
 * Faddeeva `w(z)` at arbitrary precision via the Karbach-Weideman
 * Fourier expansion.
 *
 *   w(z) := e^(-z²) · erfc(-i z)                          (definition)
 *         = (i / π) · ∫_{-∞}^∞  e^(-t²) / (z - t) dt       (Voigt form)
 *
 * The Karbach 2014 eq. 37 truncated Fourier expansion (in the form
 * actually implemented here, after algebraic simplification of the
 * pole-paired sum — R2 §5.2):
 *
 *     w(z) ≈ (i / (2√π)) · [
 *              − a_0 · (1 − e^(iτ_m z)) / z
 *              + Σ_{n=1}^N  a_n · τ_m · (1 − (−1)^n · e^(iτ_m z)) · 2nπ
 *                                       / ((nπ)² − (τ_m z)²)
 *            ]
 *
 * for `z` in the first quadrant (after symmetry reduction). The
 * coefficients `a_n` and `τ_m` are precomputed per `prec` in
 * `karbachCoeffs`.
 *
 * **Symmetry reductions** (Faddeeva.cc-style; folded here):
 *
 *   - `Re(z) < 0`:  w(z) = conj(w(-conj(z)))     (real-axis mirror)
 *   - `Im(z) < 0`:  w(z) = 2·exp(-z²) − w(-conj(z))    (lower-half-plane)
 *
 * These reduce every input to `Re(z) ≥ 0, Im(z) ≥ 0` (first quadrant)
 * before the main sum runs. The two reductions compose; their inverses
 * are applied to the post-sum result.
 *
 * **Singularity discs:** the Karbach formula has removable singularities
 * at `z_n = ±n·π/τ_m` for `n = 0, …, N`. Within a small disc around any
 * such `z_n` the formula evaluates 0/0. We detect the disc and throw
 * `RangeError` with a `suggestion:` line naming the v0.2 5-term Taylor
 * fix (Karbach §5.1). The disc radius is fixed at `~10` bits below `z`
 * magnitude, mirroring the Karbach published `3e-3` constant at double
 * precision.
 *
 * **Domain constraint:** the Fourier series accuracy assumes
 * `|Im z| < τ_m` after first-quadrant reduction. For `Im z > τ_m`, the
 * series still converges (the `e^(iτ_m z) = e^(-τ_m Im z) e^(iτ_m Re z)`
 * factor underflows gracefully through the BigFloat exponent), but the
 * truncation error bound `a_N < 2^-prec` is no longer guaranteed. In
 * practice, the I3 acceptance regime covers `|Im z| ≤ τ_m(prec)` —
 * caller is responsible for choosing prec high enough that the input's
 * `|Im z|` is below the table's `τ_m`. At `prec = 200` bits (~60 dps),
 * `τ_m ≈ 23.19`; at `prec = 400` bits (~120 dps), `τ_m ≈ 33.22`. For
 * inputs with very large `|Im z|`, the caller bumps `prec`.
 *
 * @throws RangeError on Stokes-line singularity (proximity to z_n).
 */
export function bigW(z: BigComplex, prec: number): BigComplex {
  if (prec < 1 || !Number.isInteger(prec)) {
    throw new RangeError(
      `bigW: prec must be a positive integer; got ${prec}. ` +
        `suggestion: use decimalToBinaryPrecision(<digits>) for a decimal target.`,
    );
  }
  // Symmetry reduction to first quadrant — per Faddeeva.cc / Karbach §2.
  //
  // Two canonical identities (DLMF §7.4 + W. Gautschi 1969):
  //
  //   (A)  w(-z)      = 2·exp(-z²) − w(z)
  //   (B)  w(conj z)  = conj(w(-z))
  //
  // From these, the reduction to the first quadrant (Re ≥ 0, Im ≥ 0) by
  // input quadrant:
  //
  //   Q1 (Re ≥ 0, Im ≥ 0):   no reduction.
  //   Q2 (Re < 0, Im ≥ 0):   apply (B) backwards — z = -conj(z'), z' = -conj(z)
  //                          = (|Re|, Im). Then w(z) = conj(w(z')). Set
  //                          flipReal = true; zNorm = (|Re|, Im).
  //   Q3 (Re < 0, Im < 0):   apply (A) with z = -z'. z' = -z = (|Re|, |Im|).
  //                          Then w(z) = 2·exp(-z²) − w(z'). Set flipNegZ
  //                          (negate-both) = true; zNorm = (|Re|, |Im|).
  //   Q4 (Re ≥ 0, Im < 0):   apply (A) ∘ (B). z' = (|Re|, |Im|) (first quad).
  //                          w(z) = 2·exp(-z²) − conj(w(z')). Set flipNegZ
  //                          AND flipReal (conj on the inner).
  //
  // Unified scheme: track `flipReal` (apply conj at end of inner) and
  // `flipNegZ` (apply the 2·exp(-z²)−... identity at end). Three input
  // quadrants set flipNegZ; two set flipReal; the combination gives the
  // four cases correctly.
  const work = prec + 32;
  let zNorm = z;
  let flipReal = false;
  let flipNegZ = false;
  let z2Saved: BigComplex | null = null;
  if (sgn(z.im) < 0) {
    // Im(z) < 0: Q3 or Q4. Use identity (A): w(z) = 2·exp(-z²) − w(-z).
    // Capture exp(-z²) at the *original* z; then continue with z' = -z.
    z2Saved = cmul(z, z, work);
    flipNegZ = true;
    zNorm = { re: neg(zNorm.re), im: neg(zNorm.im) };
    // Now zNorm has Im(zNorm) > 0. If Re(zNorm) < 0 (was Q3 originally),
    // it's still in Q2 now; the flipReal below will catch it.
  }
  if (sgn(zNorm.re) < 0) {
    // Re < 0 at this point: apply identity (B): w(zNorm) = conj(w(-conj(zNorm)))
    // = conj(w(|Re|, Im)). Set flipReal = true.
    flipReal = true;
    zNorm = { re: neg(zNorm.re), im: zNorm.im };
  }
  // zNorm is now in the first quadrant: Re ≥ 0, Im ≥ 0.
  //
  // Exact-zero short-circuit: w(0) = 1 by definition (DLMF §7.2.3 with
  // `erfc(0) = 1` and `e^0 = 1`). The Karbach formula's n=0 term is
  // `-a_0 · (1 − e^(0))/0 = -a_0 · 0/0` — a removable singularity whose
  // limit is `i a_0 τ_m`, matching `w(0) = 1` after the i/(2√π)
  // prefactor. Easier (and bit-cleaner) to short-circuit than to peek
  // inside the loop.
  if (cisZero(zNorm)) {
    let result: BigComplex = cfromReal(fromInt(1n, prec));
    if (flipReal) result = cconj(result);
    if (flipNegZ) {
      const twoExpMZ2 = cmul(cfromReal(fromInt(2n, work)),
                              cexp(cneg(z2Saved!), work), work);
      result = csub(twoExpMZ2, result, work);
      result = {
        re: normalise(result.re.mantissa, result.re.exponent, prec),
        im: normalise(result.im.mantissa, result.im.exponent, prec),
      };
    }
    return result;
  }
  //
  // Singularity check: for each n = 1..N, the formula has a removable
  // singularity at z_n = (n·π/τ_m, 0) on the real axis (n=0 is the z=0
  // case handled above). Detect proximity
  // (|zNorm.re - n·π/τ_m| + |zNorm.im|) below a fixed radius; refuse
  // with a clean error if hit. The radius scales as `2^(-prec/3)` per
  // Karbach §5.1 — small enough that random inputs almost never trigger,
  // large enough that genuinely-on-the-pole calls are caught before the
  // 0/0 emerges.
  const cache = karbachCoeffs(prec);
  // Distance check: |zNorm.re - n·π/τ_m| + |zNorm.im| < radius. The L¹
  // approximation suffices for disc detection (it's an over-bound for L²
  // distance, so any input the L¹ test rejects is genuinely close).
  const singularityRadiusMagBits = -Math.floor(prec / 3);
  for (let n = 1; n <= cache.N; n++) {
    const nPiOverTau = mul(fromInt(BigInt(n), work), cache.piOverTau, work);
    const reDiff = sub(zNorm.re, nPiOverTau, work);
    const distApprox = add(abs(reDiff), abs(zNorm.im), work);
    if (isZero(distApprox)) {
      throw new RangeError(
        `bigW: argument z = (${toFloat64(z.re).value}, ${toFloat64(z.im).value}) ` +
          `lies exactly on Karbach singularity z_${n} = ${n}·π/τ_m ≈ ${toFloat64(nPiOverTau).value}. ` +
          `suggestion: Karbach §5.1 5-term Taylor-disc evaluation is deferred ` +
          `to v0.2; perturb the input by 2^-${Math.floor(prec / 2)} or pass a ` +
          `nearby non-singular argument.`,
      );
    }
    const distMag = bfMagBits(distApprox);
    if (distMag < singularityRadiusMagBits) {
      throw new RangeError(
        `bigW: argument z = (${toFloat64(z.re).value}, ${toFloat64(z.im).value}) ` +
          `lies within 2^${singularityRadiusMagBits} of Karbach singularity ` +
          `z_${n} = ${n}·π/τ_m ≈ ${toFloat64(nPiOverTau).value}. ` +
          `suggestion: Karbach §5.1 5-term Taylor-disc evaluation is deferred ` +
          `to v0.2; perturb the input or work at higher prec.`,
      );
    }
  }
  // Main Karbach sum at first-quadrant zNorm.
  //   τ_m z is the load-bearing recurrence input; compute once.
  //   e^(i τ_m z) is the per-pair sign multiplier.
  const tauZ: BigComplex = {
    re: mul(cache.tau_m, zNorm.re, work),
    im: mul(cache.tau_m, zNorm.im, work),
  };
  // i·(tauZ) = (-tauZ.im, tauZ.re); then exp.
  const iTauZ: BigComplex = { re: neg(tauZ.im), im: tauZ.re };
  const expITauZ = cexp(iTauZ, work);
  // (τ_m z)² for the denominator (n·π)² − (τ_m z)².
  const tauZSq = cmul(tauZ, tauZ, work);
  // The n = 0 "outer correction" of Karbach eq. 37 is `- a_0·(1 - e^(iτz))/z`.
  // Inside the main Σ, the n = 0 term contributes `+ 2 a_0·(1 - e^(iτz))/z`
  // (the `(T1 - T2)` bracket evaluates to `2(1-exp)/(τz)`; multiplied by
  // `a_0·τ_m` becomes `2 a_0 (1-exp)/z` since `τz = τ_m·z`). The two combine:
  //     net n=0 = 2 a_0 (1-exp)/z − a_0 (1-exp)/z = + a_0 (1-exp)/z.
  // Verification: as z → 0, (1 - e^(iτz))/z → -iτ_m by Taylor, so the n=0
  // contribution tends to -i·a_0·τ_m. After the i/(2√π) prefactor:
  // (i/(2√π))·(-i·a_0·τ_m) = a_0·τ_m/(2√π) = 1 with a_0 = 2√π/τ_m. This
  // matches w(0) = 1 exactly — the algebra check pinning the sign convention.
  // (zNorm cannot be zero here — the cisZero(zNorm) short-circuit above
  // returned for that case.)
  const oneW = fromInt(1n, work);
  const oneC = cfromReal(oneW);
  const oneMinusExp = csub(oneC, expITauZ, work);
  const a0Term = cdiv(cmul(cfromReal(cache.a[0]!), oneMinusExp, work), zNorm, work);
  let sum: BigComplex = a0Term;
  // n = 1..N: per-term Karbach eq. 37, with the algebraic simplification of
  // the (T1 - T2) bracket:
  //     T1 - T2 = (1 - s_n) · [1/(nπ + τz) - 1/(nπ - τz)]
  //             = (1 - s_n) · (-2·τz) / ((nπ)² - (τz)²)
  // where s_n = (-1)^n · e^(iτz), so the contribution to add to `sum` is
  //     a_n · τ_m · (T1 - T2) = -2 · a_n · τ_m · τz · (1 - s_n) / denom.
  // (Note: τz here is the complex `τ_m · z`, not the real τ_m. The factor
  // `τ_m · τz = τ_m² · z` is what we accumulate.)
  for (let n = 1; n <= cache.N; n++) {
    const sn = (n % 2 === 0) ? expITauZ : cneg(expITauZ);
    const oneMinusSn = csub(oneC, sn, work);
    // Denominator: (nπ)² − (τ_m z)². Subtract complex tauZSq from real nπSq.
    const denom: BigComplex = {
      re: sub(cache.nPiSq[n]!, tauZSq.re, work),
      im: neg(tauZSq.im),
    };
    // Numerator: a_n · (-2) · τ_m · τz · (1 - s_n).
    //   = a_n · (-2 τ_m) scalar times τz · (1 - s_n) complex.
    const minusTwoAnTauM = mul(neg(fromInt(2n, work)),
                                mul(cache.a[n]!, cache.tau_m, work), work);
    const numer = cmul(cfromReal(minusTwoAnTauM),
                        cmul(tauZ, oneMinusSn, work), work);
    const term = cdiv(numer, denom, work);
    sum = cadd(sum, term, work);
  }
  // Prefactor: i / (2√π). Multiply sum by i/(2√π).
  const piW = pi(work);
  const sqrtPiW = sqrt(piW, work);
  const twoSqrtPiW = mul(fromInt(2n, work), sqrtPiW, work);
  // (sum)·i / (2√π) = (-sum.im + i·sum.re) / (2√π).
  let result: BigComplex = {
    re: neg(div(sum.im, twoSqrtPiW, work)),
    im: div(sum.re, twoSqrtPiW, work),
  };
  // Undo symmetry reductions in reverse order: flipReal undoes inner, then
  // flipNegZ undoes outer.
  if (flipReal) {
    // Identity (B): w(z_2nd_quad) = conj(w(z_1st_quad)).
    result = cconj(result);
  }
  if (flipNegZ) {
    // Identity (A): w(z_orig) = 2·exp(-z_orig²) − w(-z_orig).
    // `z2Saved` is z_orig² captured before the flip.
    const twoExpMZ2 = cmul(cfromReal(fromInt(2n, work)),
                            cexp(cneg(z2Saved!), work), work);
    result = csub(twoExpMZ2, result, work);
  }
  return {
    re: normalise(result.re.mantissa, result.re.exponent, prec),
    im: normalise(result.im.mantissa, result.im.exponent, prec),
  };
}

/**
 * Multiply a BigComplex by `i`: `(a + bi)·i = -b + ai`. Inlined helper —
 * the few call sites in this section emit it explicitly so the algebra
 * stays readable, but the helper here documents the convention.
 *
 * (Not exported. The four Erf-family entry points below are the public
 * surface; `bigW` is exported as the substrate primitive for testing and
 * for future tools that want the Faddeeva primitive directly.)
 */
function ciMul(z: BigComplex): BigComplex {
  return { re: neg(z.im), im: z.re };
}

/**
 * `erfcx(z) = w(i·z)` for complex `z` at arbitrary precision.
 *
 * Identity: DLMF §7.2.7 / Karbach §2.3. The scaled complementary error
 * function is *exactly* the Faddeeva primitive evaluated at `i·z` — no
 * algebra needed. For real `z ≥ 0` this matches I2's `bigErfcx` on the
 * real axis; we short-circuit to it for byte-equality with the real lane.
 */
export function bigCErfcx(z: BigComplex, prec: number): BigComplex {
  // Real-axis short-circuit: byte-equality with I2's bigErfcx (load-bearing
  // for the restriction-to-real-axis property test).
  if (isZero(z.im) && sgn(z.re) >= 0) {
    return cfromReal(bigErfcx(z.re, prec));
  }
  // General complex path: erfcx(z) = w(iz).
  return bigW(ciMul(z), prec);
}

/**
 * `erf(z)` for complex `z` at arbitrary precision via the Karbach-Weideman
 * Faddeeva primitive.
 *
 * Identity table (DLMF §7.4 / Karbach §2.4):
 *
 *     erf(z) = 1 - e^(-z²) · w(iz)         for Re(z) ≥ 0
 *     erf(z) = e^(-z²) · w(-iz) - 1        for Re(z) < 0
 *
 * The half-plane split keeps `w(±iz)` away from the regime where its
 * exponential factors would blow up — for `Re(z) ≥ 0`, `iz` lies in the
 * upper half-plane and `w(iz)` decays as `exp(-z²)` grows, so the product
 * is bounded by `|erf(z) - 1| ≤ 1`. For `Re(z) < 0`, the mirror identity
 * with `w(-iz)` keeps the same boundedness.
 *
 * **Real-axis restriction:** for `z = x + 0i` with `x ≥ 0`, the result
 * is `cfromReal(bigErf(x, prec))` byte-identically; for `x < 0`, it is
 * `cfromReal(-bigErf(-x, prec))` (using the real-lane parity). Defers
 * to the I1 substrate to maintain byte-equality.
 *
 * @throws RangeError on Stokes-line singularity (proximity to a Karbach
 * pole z_n via `bigW`).
 */
export function bigCErf(z: BigComplex, prec: number): BigComplex {
  // Real-axis short-circuit: byte-identical with I1's bigErf(x, prec).
  if (isZero(z.im)) {
    return cfromReal(bigErf(z.re, prec));
  }
  // Cancellation-driven precision retry (mirrors `clgammaReflect`, bead
  // oj5j / worklog 117). The Karbach identity expresses erf(z) as
  // `1 ± exp(-z²)·w(±iz)`, where the subtraction can lose leading bits
  // when `|product − 1| ≪ 1` (i.e. when `erf(z)` is close to ±1).
  // Concrete example (T5-erfi-040 in the bench corpus): z = -6.56+11.81i,
  // erfi(z).re ≈ 5e-44 — the subtraction discards ~140 bits of leading
  // information. The retry pattern: measure `lossBits = magBits(operand)
  // − magBits(result)` post-subtraction, redo at `work = prec + 32 +
  // lossBits` if positive. Two retries suffice in practice (the second
  // pays for the residual error introduced by the bumped precision
  // arithmetic itself).
  return bigCErfWithRetry(z, prec, 0);
}

function bigCErfWithRetry(z: BigComplex, prec: number, extraBits: number): BigComplex {
  const work = prec + 32 + extraBits;
  const nz2 = cneg(cmul(z, z, work));
  const expNz2 = cexp(nz2, work);
  let product: BigComplex;
  let result: BigComplex;
  let operand: BigComplex;
  if (sgn(z.re) >= 0) {
    // Re(z) ≥ 0: erf(z) = 1 - exp(-z²) · w(iz).
    const wiz = bigW(ciMul(z), work);
    product = cmul(expNz2, wiz, work);
    operand = product;
    const one = cfromReal(fromInt(1n, work));
    result = csub(one, product, work);
  } else {
    // Re(z) < 0: erf(z) = exp(-z²) · w(-iz) - 1.
    const negIz: BigComplex = { re: z.im, im: neg(z.re) };
    const wMinusIz = bigW(negIz, work);
    product = cmul(expNz2, wMinusIz, work);
    operand = product;
    const one = cfromReal(fromInt(1n, work));
    result = csub(product, one, work);
  }
  // Cancellation check: how many bits did the subtraction discard?
  const opMag = magBits(operand);
  const resMag = magBits(result);
  // If operand magnitude is ≪ 1, no cancellation possible (subtraction
  // with 1 doesn't lose bits when the operand is tiny).
  // If result magnitude is comparable to operand magnitude, no cancellation.
  // Loss is `max(0, opMag - resMag - (small headroom))`.
  // We only retry once — the bumped recomputation should be definitive.
  if (extraBits === 0 && opMag !== -Infinity && resMag !== -Infinity) {
    const lossBits = Math.max(0, opMag - resMag - 8);
    if (lossBits > 16) {
      // Bound the bump — extreme cancellation past 4·prec is treated as
      // pathological; the result honestly carries reduced precision.
      const bumpedExtra = Math.min(lossBits + 16, prec * 4);
      return bigCErfWithRetry(z, prec, bumpedExtra);
    }
  }
  return {
    re: normalise(result.re.mantissa, result.re.exponent, prec),
    im: normalise(result.im.mantissa, result.im.exponent, prec),
  };
}

/**
 * `erfc(z)` for complex `z` at arbitrary precision.
 *
 * Identity table (DLMF §7.4 / Karbach §2.4):
 *
 *     erfc(z) = e^(-z²) · w(iz)            for Re(z) ≥ 0
 *     erfc(z) = 2 - e^(-z²) · w(-iz)       for Re(z) < 0
 *
 * For `Re(z) ≥ 0` the formula is cancellation-free (both factors small
 * for large `|z|`). For `Re(z) < 0` the `2 - tiny` subtraction is also
 * cancellation-free (the second term is exponentially small at large
 * `|Re z|`).
 *
 * **Real-axis restriction:** for `z = x + 0i`, defers to I2's
 * `bigErfc(x, prec)` byte-identically.
 *
 * @throws RangeError on Stokes-line singularity (via `bigW`).
 */
export function bigCErfc(z: BigComplex, prec: number): BigComplex {
  // Real-axis short-circuit: byte-identical with I2's bigErfc(x, prec).
  if (isZero(z.im)) {
    return cfromReal(bigErfc(z.re, prec));
  }
  return bigCErfcWithRetry(z, prec, 0);
}

function bigCErfcWithRetry(z: BigComplex, prec: number, extraBits: number): BigComplex {
  const work = prec + 32 + extraBits;
  const nz2 = cneg(cmul(z, z, work));
  const expNz2 = cexp(nz2, work);
  if (sgn(z.re) >= 0) {
    // Re(z) ≥ 0: erfc(z) = exp(-z²) · w(iz). No subtraction — no
    // cancellation. Direct return; no retry path.
    const wiz = bigW(ciMul(z), work);
    const product = cmul(expNz2, wiz, work);
    return {
      re: normalise(product.re.mantissa, product.re.exponent, prec),
      im: normalise(product.im.mantissa, product.im.exponent, prec),
    };
  }
  // Re(z) < 0: erfc(z) = 2 - exp(-z²) · w(-iz). The `2 - product`
  // subtraction loses bits when the product is close to 2 (which
  // corresponds to erfc near the negative-real-axis saturation).
  const negIz: BigComplex = { re: z.im, im: neg(z.re) };
  const wMinusIz = bigW(negIz, work);
  const product = cmul(expNz2, wMinusIz, work);
  const two = cfromReal(fromInt(2n, work));
  const result = csub(two, product, work);
  // Cancellation retry, same shape as bigCErfWithRetry.
  const opMag = magBits(product);
  const resMag = magBits(result);
  if (extraBits === 0 && opMag !== -Infinity && resMag !== -Infinity) {
    const lossBits = Math.max(0, opMag - resMag - 8);
    if (lossBits > 16) {
      const bumpedExtra = Math.min(lossBits + 16, prec * 4);
      return bigCErfcWithRetry(z, prec, bumpedExtra);
    }
  }
  return {
    re: normalise(result.re.mantissa, result.re.exponent, prec),
    im: normalise(result.im.mantissa, result.im.exponent, prec),
  };
}

/**
 * `erfi(z)` (imaginary error function) for complex `z` at arbitrary precision.
 *
 * Identity (DLMF §7.5.2): `erfi(z) = -i · erf(i·z)`.
 *
 * For real `z`, this maps to the SymPy/Mathematica `Erfi` convention:
 * `erfi(x) = (2/√π) ∫₀ˣ e^(t²) dt`. The complex extension is the natural
 * analytic continuation.
 *
 * Defers to `bigCErf` and reuses its real-axis short-circuit indirectly
 * (the inner call `bigCErf(i·z)` with `z` real gives a pure-imaginary
 * intermediate result, which then becomes pure-real after the `-i·` undo).
 *
 * @throws RangeError on Stokes-line singularity (via `bigW`).
 */
export function bigCErfi(z: BigComplex, prec: number): BigComplex {
  // erfi(z) = -i · erf(i·z).
  // i·z = (-z.im, z.re).
  const iz: BigComplex = { re: neg(z.im), im: z.re };
  const erfIz = bigCErf(iz, prec);
  // -i · (a + bi) = b - ai.
  return { re: erfIz.im, im: neg(erfIz.re) };
}

// =============================================================================
// Modified Bessel I/K for complex argument (ADR-0041 I3a)
// =============================================================================
//
// The complex-arb-prec evaluators for `I_ν(z)` and `K_ν(z)` at complex z.
// These are the substrate **foundation** for the complex Bessel family
// (J, Y, H¹, H² — all derived from I/K in I3b via the AMOS rotation
// `J_ν(z) = exp(±νπi/2) · I_ν(∓iz)`).  Shipping I/K first matters: AMOS's
// 40-year proven choice and FLINT's transcription both compute complex
// J/Y from complex I/K, not the other way around.  The reason is that the
// **modified** family has the algebraically simpler asymptotic — a
// single all-alternating sum with a pure-exponential `e^z / √(2πz)`
// prefactor — vs J/Y's `cos(ω)·P − sin(ω)·Q` mixing that has cancellation
// near every J/Y zero.  Once I/K are stable on the full complex plane,
// the rotation to J/Y is a 5-line algebraic wrapper.
//
// Algorithm dispatch (parallel to the real I2a / I2b siblings)
// -----------------------------------------------------------
//
//   bigCBesselI:
//     real-axis short-circuit (Im(z) = 0):
//       z.re ≥ 0:  defer to bigBesselI (byte-identical with the real I2a
//                  path; load-bearing tie point with the real substrate).
//       z.re < 0, integer ν: parity I_n(-z) = (-1)^n I_n(z) via real path.
//     general complex:
//       direct complex ₀F₁ Maclaurin (parallel to bigBesselISeriesMaclaurin
//       but on BigComplex).  All complex z — the series is entire in z.
//       Cancellation-retry handles the alternating-phase loss for inputs
//       with arg(z) far from 0.
//
//   bigCBesselK:
//     real-axis short-circuit (Im(z) = 0, Re(z) > 0): defer to bigBesselK.
//     general complex: folded I-connection (DLMF 10.27.4 + Γ-reflection),
//                      identical algebraic shape to the real I2b path but
//                      on BigComplex.  Integer ν via the same limit-via-eps
//                      pattern.  Cancellation-retry budgets near-integer ν
//                      AND large |z| together.
//
// Why direct complex series, not "compute real I then analytic continuation"
// ------------------------------------------------------------------------
//
// The naive textbook approach for I_ν(z) at complex z is "evaluate
// I_ν(|z|) on the real path, then rotate by `e^{iνπ}` or `e^{iν·arg z}`".
// That is incorrect — I_ν is not a simple-rotation function of |z|; only
// the *connection* across the branch cut at z=0 satisfies a rotation
// identity (DLMF 10.34.2: `I_ν(z e^{imπ}) = e^{imνπ} I_ν(z)` for INTEGER
// m only).  For arbitrary complex z, the only correct substrate move is
// to evaluate the defining series (DLMF 10.25.2)
//
//     I_ν(z) = (z/2)^ν · Σ_{k=0}^∞ (z²/4)^k / (k! · Γ(ν+k+1))
//
// in BigComplex — every multiplication, addition, and division is
// complex.  The series is entire in z (radius of convergence ∞), so the
// only question is "how many terms" — which scales as O(|z| + prec) just
// like the real path.  The catch: for complex z with arg(z) far from 0,
// successive `(z²/4)^k` factors rotate in phase, so the partial sums
// oscillate before damping.  Peak-term magnitude is `~exp(|z|)`; final
// answer can be much smaller; the cancellation budget is `|z|·log₂ e`
// bits — identical envelope to J's real-axis Maclaurin cancellation.
// We carry the same measure-and-bump retry pattern as
// `bigBesselJSeriesCancellationRetry` (FLINT `bessel_j.c:480-557`).
//
// v0.1 scope, deferred work
// -------------------------
//
//   - **No complex-z modified-Hankel asymptotic.**  The real-axis
//     bigBesselIHankelAsymptotic exists because for large positive z the
//     series is `O(prec)` terms expensive and the asymptotic is a small
//     constant.  For complex z the asymptotic has Stokes-line subtleties
//     — the `e^z / √(2πz)` prefactor is correct only in `|arg z| < π/2`;
//     across the Stokes lines `arg z = ±π/2` the subdominant `e^{-z}`
//     contribution must be added via the Stokes multiplier (DLMF 10.40.5).
//     v0.1 routes all complex z through the series; correctness holds
//     everywhere, performance degrades only at |z| ≳ prec/2.  For the
//     I3a corpus (T5 complex BesselI/K with |z| ≤ ~30 at prec=400), this
//     is well within the series's efficient band.  Filed v0.2 P3:
//     implement the Stokes-multiplier asymptotic for |z| ≫ prec.
//
//   - **K's complex large-z asymptotic** likewise deferred (parallel
//     to the I2b real-path deferral noted in besselk.ts).  The folded
//     I-connection is correct on the full complex plane (excluding the
//     branch cut at z=0); only the performance suffers at large |z|.
//
//   - **Branch-cut handling for K at Re(z) ≤ 0** lands in v0.1 via the
//     folded I-connection: `K_ν(z) = (π/2) · (I_{-ν}(z) − I_ν(z)) /
//     sin(νπ)` extends to complex z, and the folded form's `(z/2)^{±ν}`
//     prefactors carry the principal-branch convention via `cpow` (DLMF
//     10.34.4 — principal branch has the cut on the negative real axis,
//     `arg(z) ∈ (−π, π]`).  Cross-validated against Arb on the T5 corpus.
//
// References (all in repo)
// ------------------------
//   - docs/adr/0041-bessel-family-per-head-substrate.md §"Decision 3"
//     and §"Decision 11" (AMOS rotation — explains why I/K ships first)
//   - docs/refs/besselj-research/R2-arbprec-algorithms.md §3.3 (BesselI
//     dispatch), §3.4 (BesselK dispatch)
//   - packages/bigfloat/src/special-funcs/besseli.ts (real I sibling I2a;
//     same series + asymptotic shape, real arithmetic)
//   - packages/bigfloat/src/special-funcs/besselk.ts (real K sibling I2b;
//     folded-form connection via Γ-reflection — the load-bearing
//     algorithmic shape that this complex K inherits)
//   - packages/bigfloat/src/special-funcs/besselj.ts (the cancellation-
//     retry pattern `bigBesselJSeriesCancellationRetry` — same shape)
//   - bench/besselj-anchor/oracles/arb/results.json (T5 complex BesselI/K
//     ground truth, 32 entries each across Q1/Q2/Q3/Q4)
//   - DLMF §10.25 (I series), §10.27 (I/K interrelations including the
//     I-connection 10.27.4), §10.34 (analytic continuation, branch cuts),
//     §10.40 (asymptotic — deferred v0.2 for the Stokes-line work)

// -----------------------------------------------------------------------------
// Helpers (local, parallel to besseli.ts / besselk.ts helpers but complex)
// -----------------------------------------------------------------------------

/**
 * Validate that a BigComplex input is finite-and-usable.  Throws
 * `RangeError` with a `suggestion:` line.  Mirrors `besseli.ts`'s
 * `requireFiniteBesselIInput` but on both `re` and `im`.
 */
function requireFiniteBesselComplexInput(
  z: BigComplex,
  fn: string,
  name: string,
): void {
  for (const [part, label] of [
    [z.re, "re"] as const,
    [z.im, "im"] as const,
  ]) {
    if (!Number.isInteger(part.precision) || part.precision < 1) {
      throw new RangeError(
        `${fn}: BigComplex ${name}.${label} precision must be a positive integer; got ${part.precision}. ` +
          `suggestion: construct the input via cfromStrings / cfromInts / cfromReal.`,
      );
    }
    if (!Number.isInteger(part.exponent) || !Number.isFinite(part.exponent)) {
      throw new RangeError(
        `${fn}: BigComplex ${name}.${label} exponent must be a finite integer; got ${part.exponent}. ` +
          `suggestion: do not construct BigFloat sentinels by hand — use fromFloat64.`,
      );
    }
    if (part.mantissa !== 0n) {
      const magnitudeBits = bfMagBits(part);
      if (magnitudeBits > 1024) {
        throw new RangeError(
          `${fn}: ${name}.${label} magnitude ~ 2^${magnitudeBits} exceeds the supported ` +
            `Bessel-family input range (|${name}.${label}| > 2^1024). ` +
            `suggestion: at this magnitude, I_ν(z) ~ exp(|z|) is unrepresentable; ` +
            `use bigCBesselIScaled for I or bigCBesselKScaled for K.`,
        );
      }
    }
  }
}

/**
 * Check whether a BigFloat is exactly an integer at its declared
 * precision, returning the integer if so (or `null` otherwise).  Mirrors
 * `besselk.ts::asExactInteger`.  Used by the integer-ν dispatch inside
 * bigCBesselK and by the negative-real-z parity short-circuit inside
 * bigCBesselI.
 */
function asExactIntegerBF(nu: BigFloat): number | null {
  const nuFloat = toFloat64(nu).value;
  if (!Number.isFinite(nuFloat)) return null;
  const nuRound = Math.round(nuFloat);
  if (!Number.isSafeInteger(nuRound)) return null;
  const nuRoundedBack = fromInt(BigInt(nuRound), nu.precision);
  return eq(nu, nuRoundedBack) ? nuRound : null;
}

/**
 * Test whether a BigComplex is purely real (im is exactly zero).  Used
 * by the real-axis short-circuit in `bigCBesselI` / `bigCBesselK`.
 *
 * The convention: `im.mantissa === 0n` (the canonical zero
 * representation) is sufficient.  Inputs constructed via `cfromReal` or
 * `cfromStrings(..., "0", ...)` always pass; inputs that happen to round
 * to zero in their `im` part are not short-circuited (they go through
 * the general complex path, which gives the same answer modulo last-bit
 * rounding).
 */
function cIsPureReal(z: BigComplex): boolean {
  return z.im.mantissa === 0n;
}

/**
 * Test whether a BigComplex is purely imaginary (re is exactly zero).
 * Symmetric helper to `cIsPureReal`; kept for parallelism with the
 * Erf-family helpers above.
 */
function cIsPureImag(z: BigComplex): boolean {
  return z.re.mantissa === 0n;
}

// -----------------------------------------------------------------------------
// Complex 0F1 series with loss tracking — the load-bearing primitive
// -----------------------------------------------------------------------------

/**
 * Evaluate the confluent hypergeometric series
 *
 *     ₀F₁(b; w) = Σ_{k=0}^∞ w^k / ((b)_k · k!)
 *
 * for complex `b` and complex `w`, at the requested working precision.
 * `(b)_k = b·(b+1)·…·(b+k-1)` is the rising factorial.
 *
 * Recurrence (the form actually walked):
 *
 *     T_0     = 1
 *     T_{k+1} = T_k · w / ((k+1) · (b + k))
 *
 * Returns `{ value, peakTermMag }` for the cancellation-retry harness.
 * `peakTermMag = max_k magBits(T_k)` — for real-positive `w` the peak
 * is `T_0 = 1` and there is no cancellation; for complex `w` with
 * `arg(w)` far from 0 the peak can be `≫ |value|`, and the bit-loss is
 * `peakTermMag − magBits(value)`.
 *
 * Termination: `magBits(T_{k+1}) − magBits(sum) < -prec - 8` (the term
 * is small relative to the running sum).
 *
 * Caller is responsible for ensuring `b` is not zero or a non-positive
 * integer (the recurrence would hit `(b + k) = 0` and throw).  For our
 * complex I / K callers, `b = ν + 1` (for I) or `b = 1 ± ν` (for the K
 * folded connection); the I caller routes negative-integer ν through
 * the parity short-circuit, the K caller routes integer ν through the
 * limit-via-eps wrapper.
 *
 * The shape mirrors `besselk.ts::hyp0F1` but on BigComplex.
 */
function chyp0F1WithLossTracking(
  b: BigComplex,
  w: BigComplex,
  work: number,
): { value: BigComplex; peakTermMag: number } {
  let sum: BigComplex = cfromReal(fromInt(1n, work));
  let term: BigComplex = cfromReal(fromInt(1n, work));
  let peakTermMag = 0;  // magBits(T_0) = magBits(1) = 0.
  const stopMagThreshold = -work - 8;
  // Safety cap: for our typical w = z²/4 with |z| ≤ ~30, the series
  // terminates in O(|z|) + O(prec) terms.  Cap is generous (worst case
  // is ~|w| + work for very large |w|).
  const absWFloat = toFloat64(cabs(w, work)).value;
  const expectedTerms = Number.isFinite(absWFloat)
    ? Math.max(64, Math.ceil(2 * Math.sqrt(absWFloat) + work))
    : work * 4;
  const maxTerms = Math.max(64, expectedTerms);
  for (let k = 0; k < maxTerms; k++) {
    // T_{k+1} = T_k · w / ((k+1) · (b + k)).
    const kPlus1 = cfromReal(fromInt(BigInt(k + 1), work));
    const bPlusK: BigComplex = {
      re: add(b.re, fromInt(BigInt(k), work), work),
      im: b.im,
    };
    if (cisZero(bPlusK)) {
      throw new RangeError(
        `chyp0F1: b + ${k} = 0 hits a pole of the rising factorial; ` +
          `suggestion: caller must route integer or near-integer ν through ` +
          `the limit-via-eps wrapper (bigCBesselKIntegerNu) or the parity ` +
          `reduction (bigCBesselI for negative integer ν).`,
      );
    }
    const denom = cmul(kPlus1, bPlusK, work);
    term = cdiv(cmul(term, w, work), denom, work);
    sum = cadd(sum, term, work);
    const termMag = magBits(term);
    if (termMag > peakTermMag) peakTermMag = termMag;
    const sumMag = magBits(sum);
    if (termMag === -Infinity) break;
    if (termMag - sumMag < stopMagThreshold) break;
  }
  return { value: sum, peakTermMag };
}

// -----------------------------------------------------------------------------
// bigCBesselI — complex modified Bessel I via direct ₀F₁ + cancellation retry
// -----------------------------------------------------------------------------

/**
 * Complex modified Bessel function of the first kind `I_ν(z)` at
 * user-controlled arbitrary precision.
 *
 *     I_ν(z) = (z/2)^ν / Γ(ν+1) · ₀F₁(ν+1; z²/4)
 *
 * (DLMF 10.25.2 in its prefactored ₀F₁ form — algebraically identical
 * to the textbook Σ (z/2)^{ν+2k} / (k! Γ(ν+k+1)) but with the constant
 * `(z/2)^ν / Γ(ν+1)` factored out for stable cancellation accounting.)
 *
 * Algorithm dispatch:
 *
 *   isPureReal(z) and z.re ≥ 0:    defer to bigBesselI (the I2a substrate;
 *                                   byte-identical result; load-bearing).
 *   isPureReal(z) and z.re < 0 and integer ν:
 *                                   parity I_n(-z) = (-1)^n · I_n(z) via
 *                                   the real path.  Byte-identical
 *                                   `.re` component, exact-zero `.im`.
 *   general complex:                complex ₀F₁ Maclaurin with
 *                                   cancellation-retry (the load-bearing
 *                                   path; works on the full complex plane).
 *
 * Cancellation budget
 * -------------------
 *
 * For real positive z the ₀F₁ series is all-positive — no cancellation.
 * For complex z the term phases rotate by `2·arg(z)` per step, so the
 * partial sums oscillate.  Peak-term magnitude `~exp(|z|)`; final answer
 * can be `O(1)` for K-like inputs.  Analytic cancellation envelope:
 * `cancelEst = |z|·log₂ e` bits.  The retry harness measures actual
 * loss post-sum and bumps once if the analytic estimate was too tight.
 *
 * Working precision: `work_0 = prec + 32 + cancelEst`; retry at
 * `work_1 = prec + 32 + lossBits + 16` if measured loss exceeds the
 * analytic budget + 16-bit headroom.  Same shape as
 * `bigBesselJSeriesCancellationRetry`.
 *
 * v0.1 scope
 * ----------
 *
 *   - For inputs with very large `|z|` (≳ prec/2), the series is slower
 *     than an asymptotic would be — but correct.  No complex Hankel
 *     asymptotic in v0.1 (Stokes-multiplier handling deferred).
 *   - For inputs with negative non-integer ν AND non-real z, the
 *     `Γ(ν+k+1)` factors via the recurrence's `(ν+k+1)` denominator can
 *     hit a pole — caught loudly by `chyp0F1WithLossTracking` and
 *     refused with a suggestion line.
 *
 * Determinism: every operation is `BigInt` complex arithmetic;
 * `BigInt` is bit-identical across runtimes by language specification.
 * Inherits the `arbprec: true` contract of ADR-0020 — same
 * `(nu, z, prec)` bytes → byte-identical `BigComplex` output forever.
 *
 * @throws RangeError on non-finite input or on configurations not yet
 * supported (negative non-integer ν combined with z near the branch
 * point, etc.).
 */
export function bigCBesselI(
  nu: BigComplex,
  z: BigComplex,
  prec: number,
): BigComplex {
  if (prec < 1 || !Number.isInteger(prec)) {
    throw new RangeError(
      `bigCBesselI: prec must be a positive integer; got ${prec}. ` +
        `suggestion: use decimalToBinaryPrecision(<digits>) for a decimal target.`,
    );
  }
  requireFiniteBesselComplexInput(nu, "bigCBesselI", "nu");
  requireFiniteBesselComplexInput(z, "bigCBesselI", "z");

  // Real-axis short-circuit: byte-identical with I2a's bigBesselI.
  // Load-bearing for the restriction-to-real-axis property test.
  if (cIsPureReal(nu) && cIsPureReal(z)) {
    if (sgn(z.re) >= 0) {
      // Positive (or zero) real z, real ν: defer directly.  bigBesselI
      // handles its own ν-sign dispatch (parity for negative integer ν,
      // refusal for negative non-integer ν at z=0).
      return cfromReal(bigBesselI(nu.re, z.re, prec));
    }
    // Negative real z: bigBesselI's parity path handles integer ν via
    // I_n(-z) = (-1)^n I_n(z).  For non-integer ν, bigBesselI refuses
    // with a suggestion to use this very function — but that's the
    // wrong dispatch for purely-real negative z, where we genuinely need
    // the principal-branch complex value.  Route through the general
    // complex path below so the series evaluator handles it directly.
    const asInt = asExactIntegerBF(nu.re);
    if (asInt !== null) {
      // Integer ν: parity is byte-clean.
      return cfromReal(bigBesselI(nu.re, z.re, prec));
    }
    // Non-integer real ν with negative real z: fall through to the
    // complex series path (z has im=0 but the series still rotates
    // appropriately via (z/2)^ν = (-|z|/2)^ν, computed via cpow with
    // principal branch).  No special case needed — cpow handles the
    // arg(z) = π branch.
  }

  // z = 0 closed form: I_ν(0) = 0 for Re(ν) > 0, 1 for ν = 0; undefined
  // (singular) for Re(ν) < 0 non-integer.
  if (cisZero(z)) {
    if (cisZero(nu)) {
      return cfromReal(normalise(1n, 0, prec));
    }
    if (sgn(nu.re) > 0 || (isZero(nu.re) && !isZero(nu.im))) {
      return cfromReal({ mantissa: 0n, exponent: 0, precision: prec });
    }
    // Re(ν) < 0: check integer
    if (cIsPureReal(nu)) {
      const asInt = asExactIntegerBF(nu.re);
      if (asInt !== null) {
        // Negative integer ν: I_{-n}(0) = I_n(0) = 0 for n ≥ 1.
        return cfromReal({ mantissa: 0n, exponent: 0, precision: prec });
      }
    }
    throw new RangeError(
      `bigCBesselI: I_ν(0) is unbounded for negative non-integer Re(ν); ` +
        `suggestion: at z = 0, I_ν is singular for Re(ν) < 0 non-integer; ` +
        `use the symbolic limit instead.`,
    );
  }

  // General complex path — direct ₀F₁ Maclaurin with cancellation retry.
  return bigCBesselISeriesWithRetry(nu, z, prec, 0);
}

/**
 * The inner series-with-retry loop for `bigCBesselI`.  Measures the
 * cancellation in the ₀F₁ partial sums, bumps once if needed.  Mirrors
 * `bigBesselJSeriesCancellationRetry` (real-axis) and `bigCErfWithRetry`
 * (complex Erf).
 *
 * `extraBits === 0` is the first-pass call; on bump, the recursive call
 * sets `extraBits > 0` and the retry-on-retry path is bypassed.
 */
function bigCBesselISeriesWithRetry(
  nu: BigComplex,
  z: BigComplex,
  prec: number,
  extraBits: number,
): BigComplex {
  // Analytic cancellation envelope on first pass: |z|·log₂ e bits.  The
  // peak ₀F₁ term has magnitude ~exp(|z|), the final answer can be
  // ~O(1) (or much smaller for K-like inputs) — the subtraction in
  // forming the sum from the partial terms loses ~|z|·log₂ e bits in
  // the worst case (arg(z) = ±π/2, where the rotation is fastest).
  const absZ = toFloat64(cabs(z, prec)).value;
  const cancelEst = Number.isFinite(absZ)
    ? Math.max(0, Math.ceil(absZ * Math.LOG2E))
    : 0;
  const work = prec + 32 + cancelEst + extraBits;

  // Compute the prefactor and series.
  //   prefactor = (z/2)^ν / Γ(ν+1)
  //   series    = ₀F₁(ν+1; z²/4)
  //   I_ν(z)    = prefactor · series
  const half = cfromReal(fromFloat64(0.5));
  const halfZ = cmul(z, half, work);
  const halfZPowNu = cpow(halfZ, nu, work);
  const one = cfromReal(fromInt(1n, work));
  const nuPlus1 = cadd(nu, one, work);
  const gammaNuPlus1 = cgamma(nuPlus1, work);
  const prefactor = cdiv(halfZPowNu, gammaNuPlus1, work);

  // Series argument: w = z²/4.
  const zSquared = cmul(z, z, work);
  const quarter = cfromReal(fromFloat64(0.25));
  const w = cmul(zSquared, quarter, work);

  // ₀F₁(ν+1; z²/4) with peak-term tracking.
  const { value: series, peakTermMag } = chyp0F1WithLossTracking(nuPlus1, w, work);

  // Multiply prefactor by series.
  const result = cmul(prefactor, series, work);

  // Cancellation accounting.  Note the series peak-term tracking gives
  // us the magnitude that fed INTO the sum; the result's magnitude
  // after multiplying by the prefactor tells us where we landed.  Loss
  // bits = peakTermMag(series) − magBits(series).  (The prefactor
  // cancellation is bounded by the prec-32 budget of cpow / cdiv /
  // cgamma — separately handled by those routines' internal precision
  // budgets.)
  const seriesMag = magBits(series);
  const measuredLoss = seriesMag === -Infinity
    ? 0
    : Math.max(0, peakTermMag - seriesMag);

  // First-pass retry: if measured loss exceeds the analytic estimate +
  // headroom, recompute at higher working precision.  Cap the bump at
  // 4·prec (pathological inputs honestly carry reduced precision).
  if (extraBits === 0 && measuredLoss > cancelEst + 16) {
    const bumpedExtra = Math.min(measuredLoss - cancelEst + 32, prec * 4);
    return bigCBesselISeriesWithRetry(nu, z, prec, bumpedExtra);
  }

  return {
    re: normalise(result.re.mantissa, result.re.exponent, prec),
    im: normalise(result.im.mantissa, result.im.exponent, prec),
  };
}

/**
 * Scaled complex modified Bessel I: returns `e^{-z} · I_ν(z)`.
 *
 * The complex analogue of `bigBesselIScaled`.  Note the scaling factor
 * is `e^{-z}` (NOT `e^{-|z|}`) — for complex z, the natural overflow-
 * mitigation factor is the exponential at the complex argument itself,
 * not at its magnitude.  This matches AMOS's `ZBESI` `cyl_bessel_i_scaled`
 * convention (the factor that cancels the leading `e^z / √(2πz)` of the
 * Re(z) > 0 asymptotic).
 *
 * For inputs with Re(z) ≤ 0, this scaling still works (the result is
 * `O(1)` rather than the `O(exp(|Re(z)|))` of the unscaled).  For
 * pure-imaginary z, `e^{-iz}` introduces a rotation but no growth/decay
 * — the scaling is "free" but not overflow-relevant.
 *
 * Use this variant whenever:
 *
 *   - the consumer immediately multiplies by `e^{z}` (typical for
 *     integrands of the form `∫ f(z) · I_ν(z) · e^{-z} dz`),
 *   - `Re(z) > 700` is plausible (float64 overflow cliff at `e^700`),
 *   - downstream code needs to pretty-print or log the value at large z.
 *
 * Real-axis short-circuit: for `z = x + 0i` with `x ≥ 0`, defers to
 * `bigBesselIScaled(nu.re, x, prec)`.
 *
 * Implementation: composed from `bigCBesselI` + `cexp(-z)` at
 * `work = prec + 64`.  The extra 32 bits over the standard `prec + 32`
 * working budget cover the cancellation between the I asymptotic's
 * `e^z` prefactor and the `e^{-z}` factor — they should largely cancel
 * structurally but the BigFloat substrate computes them independently.
 *
 * @throws RangeError on non-finite input (delegates to bigCBesselI).
 */
export function bigCBesselIScaled(
  nu: BigComplex,
  z: BigComplex,
  prec: number,
): BigComplex {
  if (prec < 1 || !Number.isInteger(prec)) {
    throw new RangeError(
      `bigCBesselIScaled: prec must be a positive integer; got ${prec}. ` +
        `suggestion: use decimalToBinaryPrecision(<digits>) for a decimal target.`,
    );
  }
  requireFiniteBesselComplexInput(nu, "bigCBesselIScaled", "nu");
  requireFiniteBesselComplexInput(z, "bigCBesselIScaled", "z");

  // Real-axis short-circuit: defer to bigBesselIScaled (the real I2a
  // overflow-safe variant).  Byte-identical with the real path for real
  // nu and z.re ≥ 0.
  if (cIsPureReal(nu) && cIsPureReal(z) && sgn(z.re) >= 0) {
    return cfromReal(bigBesselIScaled(nu.re, z.re, prec));
  }

  // z = 0 fast-path: e^0 · I_ν(0) = I_ν(0).
  if (cisZero(z)) {
    return bigCBesselI(nu, z, prec);
  }

  const work = prec + 64;
  const iValue = bigCBesselI(nu, z, work);
  const expNegZ = cexp(cneg(z), work);
  const result = cmul(iValue, expNegZ, work);
  return {
    re: normalise(result.re.mantissa, result.re.exponent, prec),
    im: normalise(result.im.mantissa, result.im.exponent, prec),
  };
}

// -----------------------------------------------------------------------------
// bigCBesselK — complex K via folded I-connection with cancellation retry
// -----------------------------------------------------------------------------

/**
 * Complex modified Bessel function of the second kind `K_ν(z)` at
 * user-controlled arbitrary precision.
 *
 *     K_ν(z) = (π/2) · (I_{-ν}(z) − I_ν(z)) / sin(νπ)              (DLMF 10.27.4)
 *
 * Algebraically re-expressed (per the I2b folded form — Γ-reflection
 * via DLMF 5.5.3) for numerical stability:
 *
 *     K_ν(z) = (1/2) · [
 *                (z/2)^{-ν} · Γ(ν) · ₀F₁(1-ν; z²/4)
 *              − (z/2)^{+ν} · π / (Γ(ν) · ν · sin(πν)) · ₀F₁(1+ν; z²/4)
 *              ]
 *
 * — algebraically identical, numerically much better behaved because
 * both ₀F₁ series have no internal pole-cancellation for non-integer ν.
 * The single cancellation site is the bracketed `[A − B]` subtraction.
 *
 * Algorithm dispatch (parallel to I2b's bigBesselK):
 *
 *   isPureReal(z), z.re > 0, real ν:  defer to bigBesselK (the I2b
 *                                     substrate; byte-identical with the
 *                                     real path).
 *   ν integer (complex z, any z ≠ 0): bigCBesselKIntegerNu (limit-via-eps).
 *   ν non-integer (complex z, any z ≠ 0):
 *                                     bigCBesselKFromConnection (folded
 *                                     form with cancellation-retry).
 *
 * Branch convention: principal branch with cut on the negative real
 * axis (DLMF 10.34.4).  For `Re(z) < 0`, K_ν(z) has non-zero imaginary
 * part; the `(z/2)^{±ν}` factors via `cpow` carry the convention
 * `arg(z) ∈ (−π, π]`.  Cross-validated against Arb on the T5 corpus
 * (which spans all four quadrants).
 *
 * K is even in ν (DLMF 10.27.3) only on the *positive real* axis.  For
 * complex z, the connection formula above already handles arbitrary ν
 * without needing a ν → |ν| reduction — the formula is symmetric in ν
 * → −ν via the sin(νπ) sign flip.  We retain the I2b reduction-to-|ν|
 * only for the real-axis short-circuit (where it's load-bearing for
 * byte-equality with bigBesselK).
 *
 * Determinism: every operation is `BigInt` complex arithmetic;
 * `BigInt` is bit-identical across runtimes by language specification.
 * Inherits the `arbprec: true` contract of ADR-0020 — same
 * `(nu, z, prec)` bytes → byte-identical `BigComplex` output forever.
 *
 * @throws RangeError on non-finite input, z = 0 (singular), or other
 *   inadmissible configurations.
 */
export function bigCBesselK(
  nu: BigComplex,
  z: BigComplex,
  prec: number,
): BigComplex {
  if (prec < 1 || !Number.isInteger(prec)) {
    throw new RangeError(
      `bigCBesselK: prec must be a positive integer; got ${prec}. ` +
        `suggestion: use decimalToBinaryPrecision(<digits>) for a decimal target.`,
    );
  }
  requireFiniteBesselComplexInput(nu, "bigCBesselK", "nu");
  requireFiniteBesselComplexInput(z, "bigCBesselK", "z");

  // z = 0: singular for all ν.
  if (cisZero(z)) {
    throw new RangeError(
      `bigCBesselK: K_ν(z) is singular at z = 0 (K_0(0+) = +∞ logarithmic; ` +
        `K_ν(0+) ~ (2/z)^ν · Γ(ν)/2 for Re(ν) > 0 — power-law). ` +
        `suggestion: tool-layer code should emit tagged ` +
        `"bigfloat/k-singular-at-zero" for this input; do not request K_ν at z = 0.`,
    );
  }

  // Real-axis short-circuit (z.re > 0, im = 0, real ν): defer to bigBesselK.
  if (cIsPureReal(nu) && cIsPureReal(z) && sgn(z.re) > 0) {
    return cfromReal(bigBesselK(nu.re, z.re, prec));
  }

  // Integer ν: limit-via-eps path.  Detect via the real-component test
  // (purely-imaginary ν is non-integer in this sense).
  if (cIsPureReal(nu)) {
    const asInt = asExactIntegerBF(nu.re);
    if (asInt !== null) {
      return bigCBesselKIntegerNu(asInt, z, prec);
    }
  }

  // Non-integer ν: folded connection.
  return bigCBesselKFromConnection(nu, z, prec);
}

/**
 * Internal: evaluate the folded K-connection and report the
 * cancellation loss in the `[A − B]` subtraction, parallel to
 * `besselk.ts::besselKConnectionWithLossTracking`.
 *
 *   A := (z/2)^{-ν} · Γ(ν) · ₀F₁(1-ν; z²/4)
 *   B := (z/2)^{+ν} · π / (Γ(ν) · ν · sin(πν)) · ₀F₁(1+ν; z²/4)
 *   K_ν(z) = (A − B) / 2
 *
 * Plus the series's own peak-term-vs-magnitude loss from the ₀F₁ phase
 * rotation (the complex extension of the real I2b's all-positive
 * series).
 */
function bigCBesselKConnectionInner(
  nu: BigComplex,
  z: BigComplex,
  work: number,
): {
  value: BigComplex;
  outerLossBits: number;
  innerPeakLossBits: number;
} {
  const half = cfromReal(fromFloat64(0.5));
  const halfZ = cmul(z, half, work);
  const zSquared = cmul(z, z, work);
  const quarter = cfromReal(fromFloat64(0.25));
  const quarterZSquared = cmul(zSquared, quarter, work);

  const one = cfromReal(fromInt(1n, work));
  const onePlusNu = cadd(one, nu, work);
  const oneMinusNu = csub(one, nu, work);

  // ₀F₁(1 + ν; z²/4) and ₀F₁(1 - ν; z²/4) with peak-term tracking.
  const f0F1Plus = chyp0F1WithLossTracking(onePlusNu, quarterZSquared, work);
  const f0F1Minus = chyp0F1WithLossTracking(oneMinusNu, quarterZSquared, work);

  // The series' own internal loss: peak |T_k| vs |series|.  Take the
  // worst of the two series — both feed into A or B.
  const f0F1PlusLoss = Math.max(0, f0F1Plus.peakTermMag - magBits(f0F1Plus.value));
  const f0F1MinusLoss = Math.max(0, f0F1Minus.peakTermMag - magBits(f0F1Minus.value));
  const innerPeakLossBits = Math.max(f0F1PlusLoss, f0F1MinusLoss);

  // (z/2)^{±ν} via cpow (principal branch).
  const halfZPowPlusNu = cpow(halfZ, nu, work);
  const halfZPowMinusNu = cpow(halfZ, cneg(nu), work);

  // Γ(ν).
  const gammaNu = cgamma(nu, work);

  // π and sin(π·ν).  sin(π·ν) for complex ν: use sin(x+iy) = sin(x)cos(iy) +
  // cos(x)sin(iy) = sin(x)cosh(y) + i·cos(x)sinh(y).  We compose via
  // existing complex sin (not exported — derive locally from cexp).
  //
  //   sin(w) = (e^{iw} − e^{-iw}) / (2i)
  //
  // for any complex w.  This is the canonical complex sin definition;
  // no separate `csin` helper is exported by complex.ts yet (the Erf
  // path didn't need it), so we inline the formula here.
  const piW = pi(work);
  const piC = cfromReal(piW);
  const nuPi = cmul(nu, piC, work);
  // i·nuPi = (-nuPi.im, nuPi.re); e^{i·nuPi} = cexp(i·nuPi).
  const iNuPi: BigComplex = { re: neg(nuPi.im), im: nuPi.re };
  const eIPlus = cexp(iNuPi, work);
  const eIMinus = cexp(cneg(iNuPi), work);
  const numer = csub(eIPlus, eIMinus, work);
  // Divide by 2i:  (a + bi) / (2i) = b/2 − (a/2)i.
  const sinNuPi: BigComplex = {
    re: div(numer.im, fromInt(2n, work), work),
    im: neg(div(numer.re, fromInt(2n, work), work)),
  };

  // A := (z/2)^{-ν} · Γ(ν) · ₀F₁(1-ν; z²/4)
  const A = cmul(cmul(halfZPowMinusNu, gammaNu, work), f0F1Minus.value, work);

  // B := (z/2)^{+ν} · π · ₀F₁(1+ν; z²/4) / (Γ(ν) · ν · sin(πν))
  const Bnum = cmul(cmul(halfZPowPlusNu, piC, work), f0F1Plus.value, work);
  const Bden = cmul(cmul(gammaNu, nu, work), sinNuPi, work);
  const B = cdiv(Bnum, Bden, work);

  // K = (A − B) / 2.
  const diff = csub(A, B, work);
  const two = cfromReal(fromInt(2n, work));
  const value = cdiv(diff, two, work);

  // Outer loss accounting.
  const peakAB = Math.max(magBits(A), magBits(B));
  const diffMag = magBits(diff);
  const outerLossBits =
    diffMag === -Infinity ? 0 : Math.max(0, peakAB - diffMag);

  return { value, outerLossBits, innerPeakLossBits };
}

/**
 * I-connection evaluator for `K_ν(z)` at non-integer complex ν, complex
 * z ≠ 0, with cancellation-retry budget across both
 *
 *   (a) the outer `[A − B]` subtraction (near-integer ν and large-|z|
 *       both contribute), and
 *   (b) the inner ₀F₁ series peak-vs-magnitude loss from complex-z
 *       phase rotation (parallel to bigCBesselI's series cancellation).
 *
 * Working precision strategy: budget the analytic envelopes up front;
 * retry once if the measured combined loss exceeds the analytic
 * estimate plus headroom.  Mirrors I2b's bigBesselKFromConnection
 * extended to complex.
 *
 * **M1 mutation point:** dropping the folded-form Γ-reflection — i.e.
 * computing `(I_{-ν} − I_ν) / sin(νπ)` directly via bigCBesselI calls
 * — would re-introduce the I-series Γ-pole issue at near-negative-
 * integer ν that the folded form sidesteps.  Documented in the
 * mutation-proving section below.
 */
export function bigCBesselKFromConnection(
  nu: BigComplex,
  z: BigComplex,
  prec: number,
): BigComplex {
  requireFiniteBesselComplexInput(nu, "bigCBesselKFromConnection", "nu");
  requireFiniteBesselComplexInput(z, "bigCBesselKFromConnection", "z");
  if (cisZero(z)) {
    throw new RangeError(
      `bigCBesselKFromConnection: z must be non-zero; got cisZero. ` +
        `suggestion: the public entry bigCBesselK already gates z = 0; ` +
        `this primitive must only be called with z ≠ 0.`,
    );
  }

  // Cancellation budgets.
  //
  // (a) Outer `[A − B]` subtraction at large |z|: ~2·|z|·log₂ e bits
  //     (both A and B carry the `cosh(z)`-class exponential growth via
  //     their ₀F₁ factors).  Same envelope as I2b's largeZBits but on
  //     complex |z|.
  const absZ = toFloat64(cabs(z, prec)).value;
  const largeZBits = Number.isFinite(absZ)
    ? Math.max(0, Math.ceil(2 * absZ * Math.LOG2E))
    : 0;

  // (b) Outer `[A − B]` subtraction near integer ν: −log₂|ν − round(Re ν)|
  //     bits for ν close to a real integer.  For ν with a non-zero
  //     imaginary component, the L¹ distance from the nearest integer
  //     dominates (the sin(πν) factor's blow-up at integer ν only
  //     occurs on the real axis).  We check the real part; pure-
  //     imaginary or off-real-axis ν has no near-integer issue.
  let nearIntegerBits = 0;
  if (Math.abs(toFloat64(nu.im).value) < 0.5) {
    // ν is close to the real axis; check near-integer distance.
    const reFloat = toFloat64(nu.re).value;
    if (Number.isFinite(reFloat)) {
      const reRound = Math.round(reFloat);
      const reRoundBig = fromInt(BigInt(reRound), nu.re.precision);
      const reFrac = sub(nu.re, reRoundBig, nu.re.precision + 32);
      // Combined distance: |Re ν − round(Re ν)| + |Im ν|.  Use the
      // larger of the two as the L∞ proxy for the bit budget.
      const reFracBits = isZero(reFrac) ? -nu.re.precision : bfMagBits(reFrac);
      const imBits = isZero(nu.im) ? -nu.im.precision : bfMagBits(nu.im);
      const combinedDistBits = Math.max(reFracBits, imBits);
      // bits lost = −combinedDistBits when combinedDistBits is negative.
      nearIntegerBits = Math.min(prec + 64, Math.max(0, -combinedDistBits));
      // If both are exactly zero AND the rounded integer is achievable,
      // the input is exactly integer — refuse, integer-ν must route
      // through bigCBesselKIntegerNu.
      if (isZero(reFrac) && isZero(nu.im)) {
        throw new RangeError(
          `bigCBesselKFromConnection: ν is exactly integer (${reFloat}); ` +
            `suggestion: integer ν must route through bigCBesselKIntegerNu.`,
        );
      }
    }
  }

  // (c) Inner ₀F₁ series phase-rotation loss: |z|·log₂ e bits, same as
  //     bigCBesselI's series cancellation envelope.
  const seriesCancelEst = Number.isFinite(absZ)
    ? Math.max(0, Math.ceil(absZ * Math.LOG2E))
    : 0;

  const cancelEstTotal = nearIntegerBits + largeZBits + seriesCancelEst;
  const work0 = prec + 32 + cancelEstTotal;
  const first = bigCBesselKConnectionInner(nu, z, work0);
  const measuredLoss = first.outerLossBits + first.innerPeakLossBits;
  if (measuredLoss <= cancelEstTotal + 16) {
    return {
      re: normalise(first.value.re.mantissa, first.value.re.exponent, prec),
      im: normalise(first.value.im.mantissa, first.value.im.exponent, prec),
    };
  }
  const work1 = prec + 32 + measuredLoss + 16;
  const second = bigCBesselKConnectionInner(nu, z, work1);
  return {
    re: normalise(second.value.re.mantissa, second.value.re.exponent, prec),
    im: normalise(second.value.im.mantissa, second.value.im.exponent, prec),
  };
}

/**
 * Integer-ν evaluator for complex `K_n(z)` via the connection-formula
 * limit:
 *
 *     K_n(z) = lim_{ν → n} (folded connection above)
 *
 * Evaluated numerically by setting `ν = n + ε` for a tiny ε and boosting
 * the working precision to absorb the L'Hôpital cancellation.  Parallel
 * to `besselk.ts::bigBesselKIntegerNu` extended to complex z.
 *
 * Eps choice: `ε = 2^−(prec + 32)` (real BigFloat shift; we keep the
 * complex ν purely real for the integer case, just nudged by ε on the
 * real axis).  Limit-error analysis is linear in ε around integer ν
 * for K (see besselk.ts narrative for the full derivation); the
 * limit-error is `~2^−(prec + 32)`, well below the rounding floor.
 *
 * Working precision: `prec + 32 + epsBits + largeZBits + seriesLoss`.
 * The L'Hôpital cancellation `−log₂(ε) = prec + 32` bits dominates.
 *
 * v0.2 follow-up: implement the complex extension of FLINT's
 * `acb_hypgeom_bessel_k_0f1_series` polynomial-series Temme path
 * (exact, no limit, faster at very large prec).  v0.1 fallback is
 * correct everywhere and acceptable up to ~prec=500 bits.
 */
export function bigCBesselKIntegerNu(
  n: number,
  z: BigComplex,
  prec: number,
): BigComplex {
  if (!Number.isInteger(n)) {
    throw new RangeError(
      `bigCBesselKIntegerNu: n must be an integer; got ${n}. ` +
        `suggestion: non-integer ν must route through bigCBesselKFromConnection.`,
    );
  }
  requireFiniteBesselComplexInput(z, "bigCBesselKIntegerNu", "z");
  if (cisZero(z)) {
    throw new RangeError(
      `bigCBesselKIntegerNu: z must be non-zero; got cisZero. ` +
        `suggestion: the public entry bigCBesselK already gates z = 0; ` +
        `this primitive must only be called with z ≠ 0.`,
    );
  }
  // K is even in ν on the real axis; the connection formula generalises
  // — use |n| so the eps perturbation sits on the same side of zero.
  const nAbs = Math.abs(n);

  const epsBits = prec + 32;
  // Working precision: prec + 32 (substrate) + epsBits (L'Hôpital) +
  // 32 (safety).  The connection's own internal large-|z| / inner
  // series cancellation budgets are handled by
  // bigCBesselKFromConnection's retry harness.
  const work = prec + 32 + epsBits + 32;

  // ε = 2^−epsBits as a BigFloat (real).
  const eps: BigFloat = {
    mantissa: 1n,
    exponent: -epsBits,
    precision: work,
  };
  // ν = n + ε as a real BigComplex.
  const nuExact: BigComplex = {
    re: add(fromInt(BigInt(nAbs), work), eps, work),
    im: { mantissa: 0n, exponent: 0, precision: work },
  };
  // Direct call to the folded-connection primitive; do NOT route
  // through public bigCBesselK (which would re-detect integer ν via
  // the round-trip-at-input-precision test and re-enter this function).
  const result = bigCBesselKFromConnection(nuExact, z, work);
  return {
    re: normalise(result.re.mantissa, result.re.exponent, prec),
    im: normalise(result.im.mantissa, result.im.exponent, prec),
  };
}

/**
 * Scaled complex modified Bessel K: returns `e^{z} · K_ν(z)`.
 *
 * The complex analogue of `bigBesselKScaled`.  Note the scaling factor
 * is `e^{z}` (NOT `e^{|z|}`) — for complex z, the natural underflow-
 * mitigation factor cancels the leading `√(π/(2z)) · e^{-z}` decay of
 * the Re(z) > 0 asymptotic.  Matches AMOS's `ZBESK` `cyl_bessel_k_scaled`
 * convention.
 *
 * For inputs with Re(z) ≤ 0, this scaling still works (the result is
 * `O(1)` rather than the `O(exp(|Re(z)|))` of the unscaled K's blow-up
 * across the branch cut).  For pure-imaginary z, `e^{iz}` introduces a
 * rotation but no growth/decay.
 *
 * Use this variant whenever:
 *
 *   - the consumer immediately multiplies by `e^{-z}` (typical for
 *     integrands of the form `∫ f(z) · K_ν(z) · e^{z} dz`),
 *   - `Re(z) > 700` is plausible (K underflows the float64 subnormal
 *     cliff well before z = 700),
 *   - downstream code needs to pretty-print or log K_ν(z) at large z.
 *
 * Real-axis short-circuit: for `z = x + 0i` with `x > 0`, defers to
 * `bigBesselKScaled(nu.re, x, prec)`.
 *
 * Implementation: composed from `bigCBesselK` + `cexp(z)` at
 * `work = prec + 64`.
 *
 * @throws RangeError on non-finite input or z = 0 (delegates to
 *   bigCBesselK).
 */
export function bigCBesselKScaled(
  nu: BigComplex,
  z: BigComplex,
  prec: number,
): BigComplex {
  if (prec < 1 || !Number.isInteger(prec)) {
    throw new RangeError(
      `bigCBesselKScaled: prec must be a positive integer; got ${prec}. ` +
        `suggestion: use decimalToBinaryPrecision(<digits>) for a decimal target.`,
    );
  }
  requireFiniteBesselComplexInput(nu, "bigCBesselKScaled", "nu");
  requireFiniteBesselComplexInput(z, "bigCBesselKScaled", "z");

  // Real-axis short-circuit: defer to bigBesselKScaled.
  if (cIsPureReal(nu) && cIsPureReal(z) && sgn(z.re) > 0) {
    return cfromReal(bigBesselKScaled(nu.re, z.re, prec));
  }

  // z = 0 routes through bigCBesselK which refuses with the proper hints.
  const work = prec + 64;
  const kValue = bigCBesselK(nu, z, work);
  const expZ = cexp(z, work);
  const result = cmul(kValue, expZ, work);
  return {
    re: normalise(result.re.mantissa, result.re.exponent, prec),
    im: normalise(result.im.mantissa, result.im.exponent, prec),
  };
}

// =============================================================================
// Complex Bessel J / Y / H¹ / H² — AMOS rotation from I3a's complex I/K
// (ADR-0041 I3b; bead scientist-workbench-t73h)
// =============================================================================
//
// Mathematical foundation
// -----------------------
//
// The complex Bessel J and Y are derived from complex I and K via the
// DLMF-canonical rotation pattern (R2 §3.3, ADR-0041 §"Decision 11";
// the precise sign convention cross-validated against Arb T5):
//
//     J_ν(z) = exp(s · νπi/2) · I_ν(-s · iz)                            (*)
//     Y_ν(z) = (-2/π) · exp(-s · νπi/2) · K_ν(-s · iz)
//                + s · i · J_ν(z)                                       (**)
//     H¹_ν(z) = J_ν(z) + i · Y_ν(z)                                    (***)
//     H²_ν(z) = J_ν(z) − i · Y_ν(z)                                   (****)
//
// where `s = sign(Im z)` per the AMOS sign-choice convention (top of
// file).  `s = +1` for `Im(z) ≥ 0`, `s = -1` for `Im(z) < 0`.
//
// (*)  is DLMF 10.27.6 rearranged: starting from `I_ν(z) = i^{-ν} ·
//      J_ν(iz)` (DLMF 10.27.6) and solving for J: `J_ν(z) = i^ν ·
//      I_ν(-iz)`, then writing `i^ν = exp(νπi/2)`.  The sign-choice
//      branch is just the conjugate identity `J_ν(\bar z) = \bar
//      {J_ν(z)}` rolled into the formula so we always rotate INTO the
//      right half-plane for the I evaluator.
//
// (**) Derivation (for s = +1):
//        - DLMF 10.27.10: `K_ν(z) = (πi/2)·e^{νπi/2}·H¹_ν(iz)`
//          (for `-π < arg z ≤ π/2`).  Substituting `w = iz`, `z = -iw`
//          gives `H¹_ν(w) = -(2i/π)·e^{-νπi/2}·K_ν(-iw)`, i.e.
//          DLMF 10.27.8.
//        - H¹ = J + iY ⇒ Y = -i·(H¹ - J) = -i·H¹ + i·J.
//        - Substituting H¹ from above: `Y_ν(w) = (-2/π)·
//          e^{-νπi/2}·K_ν(-iw) + i·J_ν(w)`, which is (**) with
//          s = +1.
//      The lower-half-plane (s = -1) form follows from `Y_ν(\bar z) =
//      \bar{Y_ν(z)}` for real ν, applied to the upper-half result.
//
//      Note: the ADR-0041 §"Decision 11" sketch wrote a different-
//      sign variant `Y_ν(z) = ±(2i/π)·exp(±νπi/2)·K_ν(∓iz) −
//      exp(±νπi)·J_ν(z)` which computes a related-but-not-equal value.
//      The discrepancy was caught at substrate-test time when the
//      ADR-form computation disagreed with the Arb T5 corpus and
//      mpmath; the displayed (**) form is the one that ships and
//      that the golden-master suite verifies.
//
// (***), (****) are DLMF 10.4.2 — the definitional identities for the
//      Hankel functions.  Algebraic, no computation beyond a complex
//      add / subtract / scale.
//
// Round ordering
// --------------
//
// I3a (above) shipped `bigCBesselI` + `bigCBesselK` + their scaled
// variants.  I3b (this section) wraps them with the four definitions
// (*), (**), (***), (****).  No new series, no new asymptotic, no new
// cancellation harness — the rotation is a *thin* algebraic layer.
//
// The reward: complex J / Y at large |z| reuse I and K's machinery
// rather than re-deriving J/Y-specific Hankel asymptotics with their
// `cos(ω)·P − sin(ω)·Q` mixing and Stokes-multiplier subtleties.
// AMOS's 40-year canonical choice.  FLINT's transcription identical.
//
// Cancellation surfaces
// ---------------------
//
// The rotation (*) is byte-clean — `exp(±νπi/2)` is O(1), `I_ν(-iz)`
// is the actual answer (modulo a unit-magnitude phase), so there is no
// outer cancellation.  Working precision `prec + 32` suffices.
//
// The Y formula (**) has a `phaseK · K − phaseJ · J` subtraction.
// Both terms can be O(1) for moderate |z|; at large |z| with `arg z`
// far from π/2, K_ν(-iz) decays like `exp(-|Im z|)` while J_ν(z) is
// oscillatory with O(1/√|z|) envelope — no exponential growth on
// either side, so the cancellation is bounded by `2·|ν|·log₂ e` bits
// in the worst case (from `arg(phaseJ) − arg(phaseK)` cancellation
// when ν is large).  Working precision `prec + 32 + |Im(ν·π)|/ln 2`
// bits.  For our golden-master corpus (ν ∈ {0, 3/2, 2.3, 3}, |z| ≤
// ~30) the budget is well under 100 extra bits.
//
// The Hankel sums (***), (****) are byte-clean (single complex
// add/sub between two values of comparable magnitude).  No retry.
//
// Real-axis short-circuits — load-bearing
// ---------------------------------------
//
// For `nu` and `z` both pure-real with `z.re > 0`, we defer to the
// real-axis substrate (`bigBesselJ` / `bigBesselY` from I1a/I1b).  The
// `.re` component is byte-equal to the real path; `.im` is exactly
// zero.  This pins the complex / real lanes together via the
// restriction-to-real-axis test class (mirror of I3a's pattern).
//
// For `nu` real and `z` purely-imaginary, no short-circuit — the
// general path naturally lands on `I_ν(real positive)`, which itself
// short-circuits to `bigBesselI` inside `bigCBesselI`.  The composition
// is byte-clean.
//
// Determinism
// -----------
//
// Every operation is `BigInt` complex arithmetic via the substrate;
// inherits the `arbprec: true` contract of ADR-0020 — same
// `(nu, z, prec)` bytes → byte-identical `BigComplex` output forever.
//
// References (all in repo)
// ------------------------
//
//   - docs/adr/0041-bessel-family-per-head-substrate.md §"Decision 3"
//     and §"Decision 11" (AMOS rotation + sign-choice convention)
//   - docs/refs/besselj-research/R2-arbprec-algorithms.md §3.3 (AMOS
//     rotation), §"Risks" §6 (sign-choice correctness)
//   - packages/bigfloat/src/complex.ts (this file) — I3a above ships
//     `bigCBesselI`/`bigCBesselK` that this section consumes
//   - packages/bigfloat/src/special-funcs/besselj.ts — real I1a sibling
//   - packages/bigfloat/src/special-funcs/bessely.ts — real I1b sibling
//   - bench/besselj-anchor/oracles/arb/results.json — T5 complex
//     BesselJ/Y ground truth (32 entries each across Q1/Q2/Q3/Q4)
//   - DLMF §10.4 (Hankel definitions), §10.27 (I/K interrelations
//     including the rotation 10.27.6 and Y/K relation 10.27.10),
//     §10.11 (analytic continuation, branch cuts for J/Y)
//   - AMOS TOMS 644: `zbesj.f`, `zbesy.f` (canonical Fortran sources;
//     the sign-choice branches are documented in their preamble
//     comments and the corresponding KODE / NZ logic)

// -----------------------------------------------------------------------------
// AMOS sign choice + complex i-multiplication primitives
// -----------------------------------------------------------------------------

/**
 * AMOS-convention sign choice from `z`.  Returns `+1` if `Im(z) ≥ 0`
 * (closed upper half-plane, including the positive and negative real
 * axes), `-1` if `Im(z) < 0` (open lower half-plane).
 *
 * This matches AMOS's `ZBESJ.f` branch `IF (ZI.LT.0.0D0)`: the
 * boundary case `Im(z) = 0` is handled by the upper branch.  The
 * real-axis short-circuit upstream catches Re(z) > 0; for Re(z) ≤ 0
 * with Im(z) = 0 (the negative real axis), the formula reduces to a
 * known-real value (J_ν(-x) = ±J_ν(x) for integer ν via parity; the
 * general non-integer case requires the complex evaluation we
 * implement, and the sign +1 branch gives the principal-branch
 * answer).
 *
 * The "sign of zero" question: this returns +1 for `Im(z) === +0` AND
 * for `Im(z) === -0` AND for any other input with `Im(z) === 0`.
 * Symbolic zero is treated as the upper-half-plane boundary.
 */
function chooseAMOSSignFromZ(z: BigComplex): 1 | -1 {
  return sgn(z.im) < 0 ? -1 : 1;
}

/**
 * Multiply a BigComplex by `+i`: `i·(a + bi) = -b + a·i`.  Same as
 * the existing `ciMul` helper above (kept inline-named for clarity at
 * the J/Y rotation call sites).
 */
function cMulByI(z: BigComplex): BigComplex {
  return { re: neg(z.im), im: z.re };
}

/**
 * Multiply a BigComplex by `-i`: `-i·(a + bi) = b − a·i`.  The
 * companion to `cMulByI`; used when the AMOS sign is +1 to form `-iz`.
 */
function cMulByNegI(z: BigComplex): BigComplex {
  return { re: z.im, im: neg(z.re) };
}

/**
 * Compute the rotated argument `∓i·z` per the AMOS sign convention:
 *
 *     sign = +1:  return -i · z
 *     sign = -1:  return +i · z
 *
 * The rotated argument's real part is always `≥ 0` (proof in the
 * top-of-file narrative).  This is the load-bearing geometric
 * property that makes the rotation numerically optimal — the I and K
 * substrates land on their canonical-growth half-plane.
 */
function amosRotateArg(z: BigComplex, sign: 1 | -1): BigComplex {
  return sign === 1 ? cMulByNegI(z) : cMulByI(z);
}

/**
 * Compute the rotation phase `exp(sign · ν · π · i / 2)` for the J
 * rotation (*).  Returns a complex number of unit modulus (modulo
 * roundoff).  For integer ν this is a 4-cycle of `{1, i, -1, -i}`;
 * for non-integer ν a general unit-circle complex number.
 *
 * Working precision: caller passes `work`; the returned phase carries
 * `work` bits.  The phase's argument is `sign · ν · π / 2`, real
 * (modulo a complex ν, which inserts a real multiplicative factor
 * `exp(-sign · Im(ν) · π / 2)` from the imaginary component).
 */
function amosJPhase(
  nu: BigComplex,
  sign: 1 | -1,
  work: number,
): BigComplex {
  // exponent = sign · ν · π · i / 2.  Build as a BigComplex.
  const piW = pi(work);
  const half = fromFloat64(0.5);
  const piHalf = mul(piW, half, work);                   // π/2 as real BigFloat.
  // Real scalar `sign · π / 2` (as a real BigFloat).
  const signedPiHalf = sign === 1 ? piHalf : neg(piHalf);
  // ν · (sign · π / 2) — purely real scalar times complex ν:
  //   = sign · (π/2) · (ν.re + i·ν.im)
  // We need this times i:
  //   exponent = i · sign · (π/2) · ν
  //            = -sign · (π/2) · ν.im + i · sign · (π/2) · ν.re
  const expRe = mul(signedPiHalf, neg(nu.im), work);
  const expIm = mul(signedPiHalf, nu.re, work);
  const exponent: BigComplex = { re: expRe, im: expIm };
  return cexp(exponent, work);
}

// (`amosYJPhase` was sketched in an earlier draft of this file as
// `exp(s · ν π i)` — twice the J phase angle.  The shipped Y formula
// (DLMF-derived) does not use it; deleted.  The Y phase term is
// `exp(-s · ν π i / 2)` — same magnitude as the J phase but with the
// sign-of-s argument negated.  We re-use `amosJPhase` with the sign
// negated in `bigCBesselY` below.)

// -----------------------------------------------------------------------------
// bigCBesselJ — complex Bessel J via AMOS rotation from bigCBesselI
// -----------------------------------------------------------------------------

/**
 * Complex Bessel function of the first kind `J_ν(z)` at user-
 * controlled arbitrary precision.
 *
 * Algorithm (ADR-0041 §"Decision 11"; AMOS ZBESJ pattern):
 *
 *     J_ν(z) = exp(s · νπi/2) · I_ν(-s · iz)
 *
 * where `s = +1` if `Im(z) ≥ 0`, `s = -1` otherwise.  The substrate
 * primitive `bigCBesselI` (I3a, above) does the heavy lifting; this
 * function is a *thin* phase + rotation wrapper.
 *
 * Algorithm dispatch
 * ------------------
 *
 *   isPureReal(nu), isPureReal(z), z.re > 0:
 *       defer to bigBesselJ (the I1a real substrate).  Byte-identical
 *       `.re`; exactly-zero `.im`.  Load-bearing for the restriction-
 *       to-real-axis byte-equality test.
 *
 *   isPureReal(nu), isPureReal(z), z.re < 0:
 *       fall through to the general path.  For integer ν, the parity
 *       J_ν(-z) = (-1)^ν J_ν(z) holds and is recovered exactly by the
 *       complex rotation; for non-integer ν, the principal-branch
 *       value is well-defined via the rotation (DLMF 10.11.5: J_ν on
 *       the negative real axis carries a non-trivial complex value).
 *
 *   general complex:
 *       AMOS rotation per (*) above.
 *
 * v0.1 scope (parallel to I3a)
 * ----------------------------
 *
 *   - No complex Hankel asymptotic in v0.1 — for `|z| ≳ prec/2`, the
 *     I_ν series inside the rotation is slow but correct.  Stokes-
 *     multiplier work deferred to v0.2.
 *
 *   - The boundary case `Im(z) = 0` exactly is handled by the
 *     `sign = +1` branch; the real-axis short-circuit catches the
 *     non-pathological subcase (z.re > 0).
 *
 * Determinism: every operation is `BigInt` complex arithmetic via the
 * substrate; inherits ADR-0020's `arbprec: true` contract — same
 * `(nu, z, prec)` bytes → byte-identical `BigComplex` output forever.
 *
 * @throws RangeError on non-finite input (delegates to bigCBesselI).
 */
export function bigCBesselJ(
  nu: BigComplex,
  z: BigComplex,
  prec: number,
): BigComplex {
  if (prec < 1 || !Number.isInteger(prec)) {
    throw new RangeError(
      `bigCBesselJ: prec must be a positive integer; got ${prec}. ` +
        `suggestion: use decimalToBinaryPrecision(<digits>) for a decimal target.`,
    );
  }
  requireFiniteBesselComplexInput(nu, "bigCBesselJ", "nu");
  requireFiniteBesselComplexInput(z, "bigCBesselJ", "z");

  // Real-axis short-circuit: byte-identical with the I1a real path
  // (bigBesselJ handles z = 0 and z < 0 internally; the latter routes
  // through integer-ν parity or refuses for non-integer ν, in which
  // case the complex path below is the correct dispatch — but for
  // z.re > 0 with real ν the real path is the canonical bit-identical
  // answer and that is what the restriction-to-real-axis test class
  // pins).  The condition deliberately mirrors bigBesselJ's own
  // dispatch envelope.
  if (cIsPureReal(nu) && cIsPureReal(z) && sgn(z.re) > 0) {
    return cfromReal(bigBesselJ(nu.re, z.re, prec));
  }

  // z = 0 closed form: J_ν(0) = 1 for ν = 0, 0 for Re(ν) > 0
  // (integer or not), 0 for negative integer ν, undefined (singular)
  // for negative non-integer ν.
  if (cisZero(z)) {
    if (cisZero(nu)) {
      return cfromReal(normalise(1n, 0, prec));
    }
    if (sgn(nu.re) > 0 || (isZero(nu.re) && !isZero(nu.im))) {
      return cfromReal({ mantissa: 0n, exponent: 0, precision: prec });
    }
    // Re(ν) < 0: integer ν gives 0, non-integer is singular.
    if (cIsPureReal(nu)) {
      const asInt = asExactIntegerBF(nu.re);
      if (asInt !== null) {
        return cfromReal({ mantissa: 0n, exponent: 0, precision: prec });
      }
    }
    throw new RangeError(
      `bigCBesselJ: J_ν(0) is unbounded for negative non-integer Re(ν); ` +
        `suggestion: at z = 0, J_ν is singular for Re(ν) < 0 non-integer; ` +
        `use the symbolic limit instead.`,
    );
  }

  // General complex path — AMOS rotation.
  const work = prec + 32;
  const sign = chooseAMOSSignFromZ(z);

  // Rotated argument: ζ = ∓i · z.  By construction Re(ζ) ≥ 0.
  const zeta = amosRotateArg(z, sign);

  // I_ν(ζ) at working precision.
  const iValue = bigCBesselI(nu, zeta, work);

  // Phase: exp(sign · ν · π · i / 2).
  const phase = amosJPhase(nu, sign, work);

  // J = phase · I(ζ).
  const result = cmul(phase, iValue, work);

  return {
    re: normalise(result.re.mantissa, result.re.exponent, prec),
    im: normalise(result.im.mantissa, result.im.exponent, prec),
  };
}

// -----------------------------------------------------------------------------
// bigCBesselY — complex Bessel Y via AMOS rotation from bigCBesselK + J
// -----------------------------------------------------------------------------

/**
 * Complex Bessel function of the second kind `Y_ν(z)` at user-
 * controlled arbitrary precision.
 *
 * Algorithm (derived from DLMF 10.27.8 + 10.27.10; AMOS ZBESY pattern):
 *
 *     Y_ν(z) = (-2/π) · exp(-s · νπi/2) · K_ν(-s · iz) + s · i · J_ν(z)
 *
 * where `s = sign(Im z)` with the same convention as `bigCBesselJ`
 * (s = +1 for `Im(z) ≥ 0`, s = -1 for `Im(z) < 0`).
 *
 * Derivation (for s = +1, upper half-plane):
 *   - DLMF 10.27.10 + 10.27.8 give H¹_ν(z) = -(2i/π)·e^{-νπi/2}·K_ν(-iz).
 *   - H¹ = J + iY ⇒ Y = -i·(H¹ - J) = -i·H¹ + i·J
 *                     = -i·[-(2i/π)·e^{-νπi/2}·K_ν(-iz)] + i·J_ν(z)
 *                     = (-2/π)·e^{-νπi/2}·K_ν(-iz) + i·J_ν(z).
 *   - For s = -1 (lower), conjugate-symmetry `Y_ν(\bar z) = \bar{Y_ν(z)}`
 *     (real ν) gives the displayed combined formula.
 *
 * Note: the ADR-0041 §"Decision 11" sketch wrote a different-sign
 * variant of this formula; the substrate uses the DLMF-derived form
 * (cross-validated against the Arb T5 golden corpus and mpmath).  The
 * ADR sketch lives at the level of "AMOS ZBESY pattern" and does not
 * pin the precise sign convention; this comment records the canonical
 * form actually shipped.
 *
 * The substrate primitives `bigCBesselK` (I3a, above) and
 * `bigCBesselJ` (just above this function) do the work; this is the
 * algebraic combiner.
 *
 * Algorithm dispatch
 * ------------------
 *
 *   isPureReal(nu), isPureReal(z), z.re > 0:
 *       defer to bigBesselY (the I1b real substrate).  Byte-identical
 *       `.re`; exactly-zero `.im`.  Load-bearing for the restriction-
 *       to-real-axis byte-equality test.
 *
 *   z = 0:
 *       refused (Y_ν(0+) is logarithmic for ν = 0, power-law for
 *       ν > 0; singular for all ν).
 *
 *   general complex:
 *       AMOS Y formula per (**) above.
 *
 * Cancellation surface
 * --------------------
 *
 * The `phaseK · K − phaseJ · J` subtraction is bounded by `2·|ν.im|·π
 * + 2·|Im rotation| / ln 2` bits in the worst case (the |Im(ν)|
 * contribution comes from each phase factor's real magnitude scaling
 * as `exp(±Im(ν)·π)`; the rotation contribution is bounded by `2·|z|`
 * via the K's exponential decay).  Working precision `prec + 32 +
 * cancellation budget` per the budget formula below.
 *
 * @throws RangeError on non-finite input, z = 0 (singular), or other
 *   inadmissible configurations (delegates to bigCBesselK / J).
 */
export function bigCBesselY(
  nu: BigComplex,
  z: BigComplex,
  prec: number,
): BigComplex {
  if (prec < 1 || !Number.isInteger(prec)) {
    throw new RangeError(
      `bigCBesselY: prec must be a positive integer; got ${prec}. ` +
        `suggestion: use decimalToBinaryPrecision(<digits>) for a decimal target.`,
    );
  }
  requireFiniteBesselComplexInput(nu, "bigCBesselY", "nu");
  requireFiniteBesselComplexInput(z, "bigCBesselY", "z");

  // z = 0: singular for all ν.
  if (cisZero(z)) {
    throw new RangeError(
      `bigCBesselY: Y_ν(z) is singular at z = 0 (Y_0(0+) ~ (2/π) log(z/2) — ` +
        `logarithmic; Y_ν(0+) ~ -(1/π) Γ(ν) (2/z)^ν for Re(ν) > 0). ` +
        `suggestion: tool-layer code should emit tagged ` +
        `"bigfloat/y-singular-at-zero" for this input; do not request Y_ν at z = 0.`,
    );
  }

  // Real-axis short-circuit: byte-identical with I1b's bigBesselY.
  if (cIsPureReal(nu) && cIsPureReal(z) && sgn(z.re) > 0) {
    return cfromReal(bigBesselY(nu.re, z.re, prec));
  }

  // General complex path — DLMF-derived Y formula:
  //   Y_ν(z) = (-2/π) · exp(-s · νπi/2) · K_ν(-s · iz) + s · i · J_ν(z)
  //
  // Cancellation budget: the phase factor `exp(-s · νπi/2)` carries
  // magnitude `exp(+s · Im(ν) · π / 2)` (purely from the imaginary
  // part of ν).  Its product with K can blow up if |Im(ν)| is large;
  // we budget `|Im(ν) · π / 2| / ln 2` bits.  For real ν this is 0
  // (all of our corpus inputs); for complex ν the budget kicks in.
  // The K + J combination has a single subtraction surface bounded by
  // ~16 bits in the worst case for our corpus regime — no per-input
  // retry harness is needed at v0.1.
  const nuImAbs = Math.abs(toFloat64(nu.im).value);
  const phaseBudgetBits = Number.isFinite(nuImAbs)
    ? Math.ceil(nuImAbs * Math.PI * 0.5 * Math.LOG2E)
    : 0;
  const work = prec + 32 + phaseBudgetBits;

  const sign = chooseAMOSSignFromZ(z);

  // Rotated argument: ζ = ∓i · z (Re(ζ) ≥ 0 by construction).
  const zeta = amosRotateArg(z, sign);

  // K_ν(ζ) — the modified-second-kind primitive from I3a.
  const kValue = bigCBesselK(nu, zeta, work);

  // J_ν(z) — recurse to public bigCBesselJ.  For real ν + real z.re
  // > 0 this short-circuits to the bit-identical real-axis answer,
  // which is the load-bearing property the test class pins.
  const jValue = bigCBesselJ(nu, z, work);

  // Conjugate-J-phase: exp(-s · ν π i / 2) — note the SIGN on s vs
  // bigCBesselJ's amosJPhase (which uses +s).  We negate the sign
  // argument to amosJPhase.
  const conjPhase = amosJPhase(nu, (sign === 1 ? -1 : 1) as 1 | -1, work);

  // (-2/π) as a real BigFloat, lifted to BigComplex.
  const piW = pi(work);
  const twoOverPi = div(fromInt(2n, work), piW, work);
  const negTwoOverPi = cfromReal(neg(twoOverPi));

  // Coefficient of K: (-2/π) · exp(-s · ν π i / 2).
  const kCoeff = cmul(negTwoOverPi, conjPhase, work);
  const termK = cmul(kCoeff, kValue, work);

  // Coefficient of J: s · i.  s·i·J = s · (-Im(J), +Re(J)).
  const sI_J: BigComplex =
    sign === 1
      ? { re: neg(jValue.im), im: jValue.re }
      : { re: jValue.im, im: neg(jValue.re) };

  const result = cadd(termK, sI_J, work);

  return {
    re: normalise(result.re.mantissa, result.re.exponent, prec),
    im: normalise(result.im.mantissa, result.im.exponent, prec),
  };
}

// -----------------------------------------------------------------------------
// bigCHankelH1 / bigCHankelH2 — algebraic from J + Y
// -----------------------------------------------------------------------------

/**
 * Complex Hankel function of the first kind `H¹_ν(z) = J_ν(z) + i ·
 * Y_ν(z)` at user-controlled arbitrary precision.  (DLMF 10.4.2.)
 *
 * Algebraic — no series, no asymptotic, no cancellation harness.
 * Computes J and Y at `prec + 16` working bits and combines with a
 * single complex add.  The 16-bit pad covers the magnitude alignment
 * in the `i · Y` step and the final normalisation.
 *
 * Cancellation surface
 * --------------------
 *
 * J and i·Y can have comparable magnitudes with opposite signs along
 * specific rays of arg z (the Hankel functions decay much faster than
 * either J or Y individually along the upper / lower half-plane
 * axes).  At those rays the `J + i·Y` sum loses a bounded number of
 * bits; the 16-bit pad is sufficient for our corpus.  For pathological
 * inputs (extremely tight ray alignment), the loss could exceed 16
 * bits — caller should bump `prec` if `bigBesselJ` and `bigBesselY`
 * are both ~exp(|z|) and the Hankel result is much smaller.  v0.1
 * scope does not autocompensate; v0.2 follow-up may add a measure-
 * and-bump harness if a real consumer needs it.
 *
 * Determinism: inherits ADR-0020 `arbprec: true` contract via the J
 * and Y substrates.
 *
 * @throws RangeError on non-finite input or singular point (delegates
 *   to bigCBesselJ / bigCBesselY).
 */
export function bigCHankelH1(
  nu: BigComplex,
  z: BigComplex,
  prec: number,
): BigComplex {
  if (prec < 1 || !Number.isInteger(prec)) {
    throw new RangeError(
      `bigCHankelH1: prec must be a positive integer; got ${prec}. ` +
        `suggestion: use decimalToBinaryPrecision(<digits>) for a decimal target.`,
    );
  }
  requireFiniteBesselComplexInput(nu, "bigCHankelH1", "nu");
  requireFiniteBesselComplexInput(z, "bigCHankelH1", "z");

  const work = prec + 16;
  const jValue = bigCBesselJ(nu, z, work);
  const yValue = bigCBesselY(nu, z, work);
  // i · Y = (-Im(Y), +Re(Y))
  const iY = cMulByI(yValue);
  const result = cadd(jValue, iY, work);
  return {
    re: normalise(result.re.mantissa, result.re.exponent, prec),
    im: normalise(result.im.mantissa, result.im.exponent, prec),
  };
}

/**
 * Complex Hankel function of the second kind `H²_ν(z) = J_ν(z) − i ·
 * Y_ν(z)` at user-controlled arbitrary precision.  (DLMF 10.4.2.)
 *
 * Algebraic mirror of `bigCHankelH1`.  Computes J and Y at `prec +
 * 16` working bits and combines with a single complex subtract.
 *
 * Identity sanity check: `H¹ + H² = 2·J` (the `i·Y` cancels) and
 * `H¹ − H² = 2i·Y` (the `J` cancels).  Both are pinned in the test
 * suite's Hankel-identity tests.
 *
 * @throws RangeError on non-finite input or singular point (delegates
 *   to bigCBesselJ / bigCBesselY).
 */
export function bigCHankelH2(
  nu: BigComplex,
  z: BigComplex,
  prec: number,
): BigComplex {
  if (prec < 1 || !Number.isInteger(prec)) {
    throw new RangeError(
      `bigCHankelH2: prec must be a positive integer; got ${prec}. ` +
        `suggestion: use decimalToBinaryPrecision(<digits>) for a decimal target.`,
    );
  }
  requireFiniteBesselComplexInput(nu, "bigCHankelH2", "nu");
  requireFiniteBesselComplexInput(z, "bigCHankelH2", "z");

  const work = prec + 16;
  const jValue = bigCBesselJ(nu, z, work);
  const yValue = bigCBesselY(nu, z, work);
  // i · Y = (-Im(Y), +Re(Y))
  const iY = cMulByI(yValue);
  const result = csub(jValue, iY, work);
  return {
    re: normalise(result.re.mantissa, result.re.exponent, prec),
    im: normalise(result.im.mantissa, result.im.exponent, prec),
  };
}

// Suppress unused-symbol warnings for helpers parked for future
// substrate primitives (Hankel asymptotic, etc.).
void cIsPureImag;

// =============================================================================
// Gamma family — complex extensions (I3d; ADR-0042 §"Decision 3")
// =============================================================================
//
// The five entry points below complete the complex-arb-prec Gamma family on
// top of the existing `clgamma` / `cgamma` / `cdigamma` substrate:
//
//   ctrigamma(z, prec)                            — ψ'(z)
//   cpolygamma(m, z, prec)                        — ψ^(m)(z), m ≥ 1
//   cIncompleteGammaUpper(a, z, prec)             — Γ(a, z)
//   cIncompleteGammaLower(a, z, prec)             — γ(a, z)
//   cBeta(a, b, prec)                             — B(a, b)
//
// The design mirrors the real-axis substrate (`packages/bigfloat/src/special.ts`
// `trigamma`, `polygamma`, and `packages/bigfloat/src/special-funcs/incomplete-
// gamma.ts` `bigIncompleteGammaUpper`/`Lower`) function-for-function, with
// every `BigFloat` operation lifted to `BigComplex`. The reflection branches
// follow the established near-pole-safe pattern from `clgammaReflect` /
// `cdigammaReflect` (bead `oj5j`, worklog 117): reduce `z → ζ = z − m` *before*
// multiplying by `π`, bump the working precision by the measured cancellation
// depth.
//
// Real-axis restriction discipline
// --------------------------------
//
// Each entry point short-circuits to its real-axis counterpart when the input
// is exactly real (`isZero(z.im)`) and inside the real function's domain. This
// is the same convention `cgamma` and `cdigamma` use at the top of the module
// (`isZero(z.im) && sgn(z.re) > 0 ⇒ defer to `gamma(z.re, prec)`). The motive
// is twofold: (a) bit-identical agreement with the real lane so the wire-tool
// dispatch can canonicalise "real input ⇒ real output" without algorithmic
// drift, (b) the real-axis Stirling shift uses an explicit `lossBits` cushion
// in `special.ts:trigamma`/`polygamma` that we don't want to re-derive
// independently here.
//
// Algorithm dispatch summary (per PHASE2 §I3d + R2)
// --------------------------------------------------
//
//   ctrigamma: Stirling + recurrence shift + reflection at Re(z) < ½.
//     Recurrence: ψ'(z) = ψ'(z+1) + 1/z²
//                 ψ'(z) = ψ'(z+N) + Σ_{k=0}^{N-1} 1/(z+k)²   (DLMF §5.15.2)
//     Stirling (DLMF §5.11.2 differentiated; same series as `trigammaStirling`):
//                 ψ'(z) ≈ 1/z + 1/(2z²) + Σ_{k≥1} B_{2k} / z^{2k+1}
//     Reflection (DLMF §5.15.6, m = 1):
//                 ψ'(z) = (π / sin(πz))² − ψ'(1 − z)
//
//   cpolygamma: complex Euler-Maclaurin Hurwitz zeta + recurrence shift +
//     reflection. Identity (DLMF §5.15.2):
//                 ψ^(m)(z) = (−1)^(m+1) · m! · ζ(m+1, z)
//     For Re(z) < ½, reflection (DLMF §5.15.6) uses d^m/dz^m cot(πz), which
//     is closed-form polynomial in {cot(πz), csc²(πz)} of degree m. v0.1
//     supports m ∈ {1, …, 5} (sufficient for Tools T2 downstream); m ≥ 6
//     throws with a clear v0.2-followup message. The m = 0 case is digamma
//     and is *refused* by this function — callers must use `cdigamma`.
//
//   cIncompleteGammaUpper / Lower: two-regime dispatch matching the real
//     substrate (`bigIncompleteGammaUpper` / `Lower`):
//       SERIES for γ(a, z)  when  |z| < |a| + 1   (DLMF §8.5.1 Kummer form)
//       LENTZ CF for Γ(a, z) when  |z| ≥ |a| + 1   (DLMF §8.9.2; Gautschi 1979)
//     The Cephes rescaling guards `big = 4.5e15`, `biginv = 2.22e-16` are
//     part of the verbatim-port discipline (R3 §0.0) and are constructed
//     at working precision via `cephesBig`/`cephesBigInv` — modified Lentz
//     is self-rescaling on the hot path, so they live in scope for a future
//     direct-accumulator port, mirroring the real-axis convention.
//     Temme uniform asymptotic and Poincaré asymptotic regimes defer to v0.2
//     (same as real). Near-pole handling for `a` at non-positive integers
//     throws with a v0.2-followup message (proper regularised-form complex
//     handling is a P3 follow-on).
//
//   cBeta: `exp(clgamma(a) + clgamma(b) − clgamma(a+b))` at extra working
//     precision. No sign tracking is needed in the complex case (unlike the
//     real `bigBeta`, which decomposes `Γ` into `|Γ| · sign`): `clgamma`
//     returns a complex log directly, so `cexp(sum)` recovers the signed
//     complex value byte-for-byte. The only failure modes are pole-induced
//     (non-positive integer a, b, or a+b), which `clgamma` already rejects
//     loudly — `cBeta` lets those throws propagate verbatim.
//
// Determinism contract: arbprec: true (ADR-0020). Every operation is pure
// BigInt + bounded-integer-exponent arithmetic; same `(args, prec)` ⇒
// byte-identical output forever, cross-platform.
//
// References (all in repo)
// ------------------------
//   - docs/refs/gamma-research/PHASE2-impl-plans.md §I3d  (this bead's spec)
//   - docs/refs/gamma-research/R2-arbprec-algorithms.md   (algorithms)
//   - docs/refs/gamma-research/A1-codebase-audit.md §AXIS 4  (gap list)
//   - docs/adr/0042-gamma-family-per-head-substrate.md §"Decision 3"
//   - DLMF §5.11 (Stirling), §5.15 (recurrence/reflection),
//     §8.5 / §8.9 (incomplete-gamma series and CF)

import { trigamma, polygamma } from "./special.js";
import {
  bigIncompleteGammaUpper,
  bigIncompleteGammaLower,
} from "./special-funcs/incomplete-gamma.js";
import { bigBeta } from "./special-funcs/beta.js";

/**
 * `ψ'(z)` (trigamma) for complex z. Stirling + recurrence shift + reflection.
 *
 * This is the complex generalisation of `trigamma` from `special.ts`, with
 * the same three-branch dispatch:
 *
 *   1. Real positive z ⇒ defer to `trigamma(z.re, prec)`. Bit-identical to
 *      the real lane (the wire-tool's "real input ⇒ real output"
 *      canonicalisation depends on this).
 *   2. Re(z) < ½ ⇒ reflection `ψ'(z) = (π/sin(πz))² − ψ'(1 − z)` (DLMF
 *      §5.15.6 at n = 1), with the same near-pole-safe `ζ = z − m`
 *      reduction used in `cdigammaReflect`.
 *   3. Re(z) ≥ ½ ⇒ Stirling shift: recurrence `ψ'(z) = ψ'(z+1) + 1/z²`
 *      lifts z above a Stirling-friendly threshold, then the asymptotic
 *      `ψ'(w) ≈ 1/w + 1/(2w²) + Σ B_{2k}/w^{2k+1}` evaluates.
 *
 * The Stirling tail differs from `cdigammaStirling` by exactly one factor
 * of `1/z`: the digamma series has `Σ B_{2k}/(2k·z^{2k})` (B_{2k} divided
 * by 2k); the trigamma series has `Σ B_{2k}/z^{2k+1}` (no `1/(2k)` factor,
 * and one more power of `1/z`). This is the direct consequence of
 * `d/dz[ψ(z)] = ψ'(z)` applied term-by-term to `cdigammaStirling`'s series
 * (the constant `log z` differentiates to `1/z`; the `−1/(2z)` to `1/(2z²)`;
 * the `−B_{2k}/(2k·z^{2k})` to `+B_{2k}/z^{2k+1}` — sign flip from
 * differentiating `z^{−2k}`, magnitude `(−2k) · (−B_{2k}/(2k))` = `B_{2k}`).
 * The mutation-proof markers below pin this relationship via the
 * `ψ'(1+0i) = π²/6` and `ψ'(2+0i) = π²/6 − 1` real-axis tests.
 *
 * Throws on non-positive integer real z (where ψ' has a double pole).
 *
 * MUTATION-PROOF: dropping the `1/(2z²)` term, or replacing the Stirling
 * coefficient `B_{2k}` with `B_{2k}/(2k)` (the digamma form), collapses
 * the test `ctrigamma(1+0i) = π²/6` to ~1.5 digits of agreement at
 * prec=200 — verified by perturbation 2026-05-19.
 */
export function ctrigamma(z: BigComplex, prec: number): BigComplex {
  if (isZero(z.im) && sgn(z.re) > 0) {
    return cfromReal(trigamma(z.re, prec));
  }
  const half = fromString("0.5", z.re.precision);
  if (sgn(sub(z.re, half, prec + 16)) < 0) {
    return ctrigammaReflect(z, prec);
  }
  return ctrigammaShifted(z, prec);
}

/**
 * Stirling-shifted ψ' for `Re(z) ≥ ½`. Recurrence `ψ'(z) = ψ'(z+N) +
 * Σ_{k=0}^{N-1} 1/(z+k)²` (DLMF §5.15.2 iterated) shifts z above a
 * Stirling-friendly threshold, then the Stirling tail evaluates.
 *
 * Threshold formula matches `cdigammaShifted` (and `trigamma` from
 * `special.ts`): `shiftThreshold = max(8, ceil(work/8))` with
 * `work = prec + 96`. This is the FLINT-derived bound for the Stirling
 * regime, slightly looser than the optimal `0.17 · prec` but within the
 * same constant factor.
 */
function ctrigammaShifted(z: BigComplex, prec: number): BigComplex {
  const work = prec + 96;
  const shiftThreshold = Math.max(8, Math.ceil(work / 8));
  const reFloat = toFloat64(z.re).value;
  if (!Number.isFinite(reFloat)) {
    throw new RangeError(`ctrigamma: Re(z) too large`);
  }
  const N = Math.max(0, Math.ceil(shiftThreshold - reFloat));
  const zShifted: BigComplex = {
    re: add(z.re, fromInt(BigInt(N), work), work),
    im: z.im,
  };
  let result = ctrigammaStirling(zShifted, work);
  // ψ'(z) = ψ'(z+N) + Σ_{k=0}^{N-1} 1/(z+k)²
  for (let k = 0; k < N; k++) {
    const zk: BigComplex = {
      re: add(z.re, fromInt(BigInt(k), work), work),
      im: z.im,
    };
    const zk2 = cmul(zk, zk, work);
    const inv = cdiv(cfromReal(fromInt(1n, work)), zk2, work);
    result = cadd(result, inv, work);
  }
  return {
    re: normalise(result.re.mantissa, result.re.exponent, prec),
    im: normalise(result.im.mantissa, result.im.exponent, prec),
  };
}

/**
 * Stirling's series for ψ'(z) at complex z with `Re(z)` Stirling-friendly:
 *
 *   ψ'(z) = 1/z + 1/(2z²) + Σ_{k=1}^{N} B_{2k} / z^{2k+1}
 *
 * Same shape as `trigammaStirling` in `special.ts`, with every operation
 * lifted to BigComplex. The `prevTermMag` divergence guard catches the
 * Poincaré-asymptotic minimum automatically.
 */
function ctrigammaStirling(z: BigComplex, prec: number): BigComplex {
  const work = prec + 32;
  const oneOverZ = cdiv(cfromReal(fromInt(1n, work)), z, work);
  const oneOverZ2 = cmul(oneOverZ, oneOverZ, work);
  // 1/z + 1/(2z²)
  const halfOverZ2 = cdiv(oneOverZ2, cfromReal(fromInt(2n, work)), work);
  let result = cadd(oneOverZ, halfOverZ2, work);
  // First series term is B_2/z^3, then B_4/z^5, ... — i.e. zPow starts at 1/z^3.
  let zPow = cmul(oneOverZ2, oneOverZ, work);
  let prevTermMag = Infinity;
  for (let k = 1; k <= 300; k++) {
    const B2kRat = bernoulliRationalLocal(2 * k);
    if (B2kRat.num === 0n) break;
    const B2kFloat = bernoulliFloat(B2kRat, work);
    if (B2kFloat.mantissa === 0n) break;
    const term = cmul(cfromReal(B2kFloat), zPow, work);
    const termMag = magBits(term);
    if (termMag < -prec - 16) {
      result = cadd(result, term, work);
      break;
    }
    if (termMag > prevTermMag) break;
    result = cadd(result, term, work);
    prevTermMag = termMag;
    zPow = cmul(zPow, oneOverZ2, work);
  }
  return {
    re: normalise(result.re.mantissa, result.re.exponent, prec),
    im: normalise(result.im.mantissa, result.im.exponent, prec),
  };
}

/**
 * Reflection branch of `ctrigamma` for `Re(z) < ½`:
 *
 *   ψ'(z) = (π / sin(πz))² − ψ'(1 − z)         (DLMF §5.15.6, n = 1)
 *
 * Mirrors `cdigammaReflect`/`trigammaReflect` near-pole-safely: reduce
 * `z → ζ = z − m` *before* multiplying by π so the unavoidable
 * cancellation lives in a single subtraction; bump working precision by
 * the measured `lossBits` cancellation depth. The `(−1)ᵐ` parity that
 * appeared in `clgammaReflect` evaporates here: only `sin²` enters the
 * formula, and `sin²(πm + πζ) = sin²(πζ)` regardless of the sign of
 * `(−1)ᵐ`. The 1/sin² blowup near a pole is *quadratic* in `1/(πζ)` —
 * even more severe than ψ's linear `1/(πζ)` — so the `lossBits` bump is
 * especially load-bearing here (dropping it would lose ~2·log₂|ζ| bits,
 * not just log₂|ζ|).
 */
function ctrigammaReflect(z: BigComplex, prec: number): BigComplex {
  const reFloat = toFloat64(z.re).value;
  if (!Number.isFinite(reFloat)) {
    throw new RangeError(`ctrigamma: Re(z) not finite`);
  }
  const m = Math.round(reFloat);
  const inPrec = Math.max(z.re.precision, z.im.precision);
  const zeta0: BigComplex =
    m === 0
      ? z
      : { re: sub(z.re, fromInt(BigInt(m), inPrec), inPrec), im: z.im };
  if (m <= 0 && isZero(z.im) && isZero(zeta0.re)) {
    throw new RangeError(
      `ctrigamma: argument is a non-positive integer (ψ' has a pole)`,
    );
  }
  const lossBits =
    m === 0 ? 0 : Math.max(0, magBits(z) - magBits(zeta0));
  const work = prec + 32 + lossBits;
  const zeta: BigComplex =
    m === 0
      ? z
      : { re: sub(z.re, fromInt(BigInt(m), work), work), im: z.im };
  const piW = pi(work);
  // sin(πζ) via cexp(±iπζ); mirrors `clgammaReflect`'s reduced-argument trick.
  const piTimesZeta: BigComplex = {
    re: mul(piW, zeta.re, work),
    im: mul(piW, zeta.im, work),
  };
  const iPiZeta: BigComplex = { re: neg(piTimesZeta.im), im: piTimesZeta.re };
  const ePlus = cexp(iPiZeta, work);
  const eMinus = cexp(cneg(iPiZeta), work);
  const numer = csub(ePlus, eMinus, work);
  // sin(πζ) = (cexp(iπζ) − cexp(−iπζ)) / (2i) = (Im(numer)/2, −Re(numer)/2).
  const sinPiZeta: BigComplex = {
    re: div(numer.im, fromInt(2n, work), work),
    im: neg(div(numer.re, fromInt(2n, work), work)),
  };
  if (cisZero(sinPiZeta)) {
    throw new RangeError(`ctrigamma: pole at z = ${reFloat}`);
  }
  // (π / sin(πζ))²
  const piOverSin = cdiv(cfromReal(piW), sinPiZeta, work);
  const piOverSinSq = cmul(piOverSin, piOverSin, work);
  const oneMinusZ: BigComplex = {
    re: sub(fromInt(1n, work), z.re, work),
    im: neg(z.im),
  };
  const result = csub(piOverSinSq, ctrigamma(oneMinusZ, work), work);
  return {
    re: normalise(result.re.mantissa, result.re.exponent, prec),
    im: normalise(result.im.mantissa, result.im.exponent, prec),
  };
}

/**
 * `ψ^(m)(z)` (polygamma) for complex z, `m ≥ 1`.
 *
 * Algorithm dispatch:
 *
 *   m = 0  →  THROWS. The m = 0 case is digamma, which has a different
 *             algorithm (the Hurwitz identity below requires m ≥ 1 because
 *             ζ(1, z) diverges — the Hurwitz zeta has a simple pole at
 *             s = 1). Callers must use `cdigamma(z, prec)` for m = 0.
 *             We pick "throw" over "delegate" to keep the API tight:
 *             a function called `cpolygamma` should not silently become
 *             a digamma for m = 0; the caller's intent is clearer.
 *
 *   m = 1  →  Delegate to `ctrigamma(z, prec)`. The dedicated Stirling-
 *             style trigamma series is slightly cheaper than the generic
 *             Hurwitz route, and the real-axis equivalence
 *             `polygamma(1, x) === trigamma(x)` is pinned by the byte-
 *             identical real-axis defer in `ctrigamma`.
 *
 *   m ≥ 2  →  Hurwitz-zeta route (DLMF §5.15.1):
 *               ψ^(m)(z) = (−1)^(m+1) · m! · ζ(m+1, z)
 *             The complex Hurwitz zeta `ζ(s, z)` is evaluated via complex
 *             Euler-Maclaurin at large `Re(z)`, with recurrence shift to
 *             bring small `Re(z)` into the asymptotic regime, and DLMF
 *             §5.15.6 reflection for `Re(z) < ½`.
 *
 * Reflection formula support (DLMF §5.15.6):
 *
 *   ψ^(m)(1 − z) + (−1)^(m−1) ψ^(m)(z) = (−1)^m π · d^m/dz^m cot(πz)
 *
 * `d^m/dz^m cot(πz)` is closed-form polynomial in `cot(πz)` and
 * `csc²(πz)` of degree m. For v0.1 we support m ∈ {1, …, 5} explicitly
 * — sufficient for downstream Tools T2 — and throw a clear "v0.2
 * followup" message for higher m. The m = 1 case is folded into
 * `ctrigamma` (DLMF §5.15.6 at n = 1 is `(π/sin(πz))²`, which is
 * `π · d/dz cot(πz)` up to a sign; the algebra is hand-derived in
 * `ctrigammaReflect`). For m = 2..5 we go through this function.
 *
 * Domain restriction (v0.1): for the m ≥ 2 reflection path we require
 * z away from the integer poles by at least `2^{-prec/4}` (mirrors the
 * `clgammaReflect` near-pole bump). Within that band, the closed-form
 * `d^m/dz^m cot(πz)` is still well-defined but the cancellation in the
 * polynomial evaluation is unhandled; an exact integer pole throws.
 *
 * MUTATION-PROOF: flipping the leading sign `(−1)^(m+1) → (−1)^m`
 * (mutation M1 from `polygammaHurwitz`'s docstring) sends
 * `cpolygamma(2, 2+0i)` to the wrong sign; the real-axis agreement test
 * fails. Pinned.
 */
export function cpolygamma(
  m: number,
  z: BigComplex,
  prec: number,
): BigComplex {
  if (!Number.isInteger(m) || m < 0) {
    throw new RangeError(
      `cpolygamma: order m must be a non-negative integer; got ${m}`,
    );
  }
  if (m === 0) {
    // Intentional honest refusal: m = 0 is digamma, which has a different
    // algorithm (ζ(1, z) diverges). Callers should use `cdigamma`.
    throw new RangeError(
      `cpolygamma: m must be >= 1 (use cdigamma for m = 0)`,
    );
  }
  if (m === 1) {
    return ctrigamma(z, prec);
  }
  // Real-axis defer for m ≥ 2 at real positive z: byte-identical to the
  // real `polygamma` lane.
  if (isZero(z.im) && sgn(z.re) > 0) {
    return cfromReal(polygamma(m, z.re, prec));
  }
  // Reflection for Re(z) < ½.
  const half = fromString("0.5", z.re.precision);
  if (sgn(sub(z.re, half, prec + 16)) < 0) {
    return cpolygammaReflect(m, z, prec);
  }
  return cpolygammaHurwitz(m, z, prec);
}

/**
 * Complex Hurwitz-zeta route for `ψ^(m)(z)` at `Re(z) ≥ ½`, `m ≥ 2`.
 *
 *   ζ(s, z) = z^{1-s}/(s-1) + (½)z^{-s} + Σ_{k≥1} B_{2k}·(s)_{2k-1} / ((2k)! z^{s+2k-1})
 *   ψ^(m)(z) = (−1)^(m+1) · m! · (Σ_{k=0}^{N-1} (z+k)^{-(m+1)} + ζ(m+1, z+N))
 *
 * Mirrors `polygammaHurwitz` in `special.ts` byte-for-byte in structure;
 * every BigFloat operation is lifted to BigComplex. The shift threshold
 * `max(8, ceil(0.17 · (prec + 2m + 96)))` matches the real path exactly —
 * the asymptotic series convergence is governed by `|z|` and `m`, both
 * of which are real-valued bounds, so the threshold transfers verbatim.
 */
function cpolygammaHurwitz(
  m: number,
  z: BigComplex,
  prec: number,
): BigComplex {
  const s = m + 1;
  const work = prec + 96 + 2 * Math.ceil(Math.log2(m + 1));
  const shiftThreshold = Math.max(
    8,
    Math.ceil(0.17 * (prec + 2 * m + 96)),
  );
  const reFloat = toFloat64(z.re).value;
  if (!Number.isFinite(reFloat)) {
    throw new RangeError(`cpolygamma: Re(z) too large`);
  }
  const N = Math.max(0, Math.ceil(shiftThreshold - reFloat));
  // Shift sum: Σ_{k=0}^{N-1} (z+k)^{-(m+1)}. We form 1/(z+k)^{m+1} via
  // `powInt` is BigFloat-only, so we iterate `cmul` to build the power.
  // m+1 is small (typically ≤ 20); the per-step cost is O(m).
  const one = cfromReal(fromInt(1n, work));
  let shiftSum: BigComplex = {
    re: { mantissa: 0n, exponent: 0, precision: work },
    im: { mantissa: 0n, exponent: 0, precision: work },
  };
  for (let k = 0; k < N; k++) {
    const zk: BigComplex = {
      re: add(z.re, fromInt(BigInt(k), work), work),
      im: z.im,
    };
    // (z+k)^{-(m+1)} = 1 / (z+k)^{m+1}.
    let pow = one;
    for (let i = 0; i < m + 1; i++) {
      pow = cmul(pow, zk, work);
    }
    const inv = cdiv(one, pow, work);
    shiftSum = cadd(shiftSum, inv, work);
  }
  // Complex Hurwitz zeta at the shifted argument zShifted = z + N.
  const zShifted: BigComplex =
    N > 0
      ? { re: add(z.re, fromInt(BigInt(N), work), work), im: z.im }
      : z;
  // ζ(s, zShifted): complex Euler-Maclaurin.
  //   z^{1-s}/(s-1) + (½)z^{-s} + Σ B_{2k}·(s)_{2k-1} / ((2k)!·z^{s+2k-1})
  // (s)_{2k-1} = s(s+1)…(s+2k-2), tracked as a BigInt running product.
  // (2k)! tracked as BigInt.
  const oneOverZ = cdiv(one, zShifted, work);
  const oneOverZ2 = cmul(oneOverZ, oneOverZ, work);
  // z^{-(s-1)} = z^{1-s}: form 1 / z^{s-1}.
  let zPowSMinus1 = one;
  for (let i = 0; i < s - 1; i++) {
    zPowSMinus1 = cmul(zPowSMinus1, zShifted, work);
  }
  const zPow1mS = cdiv(one, zPowSMinus1, work);
  // z^{-s}.
  const zPowMS = cmul(zPow1mS, oneOverZ, work);
  const halfBF = div(fromInt(1n, work), fromInt(2n, work), work);
  let zetaResult = cadd(
    cdiv(zPow1mS, cfromReal(fromInt(BigInt(s - 1), work)), work),
    cmul(zPowMS, cfromReal(halfBF), work),
    work,
  );
  // Correction series:
  //   k=1: B_2 · s / (2! · z^{s+1})
  //   zPow = 1/z^{s+2k-1}; starts at 1/z^{s+1} for k=1, advance by *1/z².
  let zPow = cmul(zPowMS, oneOverZ, work);
  let pochNum = BigInt(s);
  let factDen = 2n;
  let prevTermMag = Infinity;
  for (let k = 1; k <= 600; k++) {
    const B2kRat = bernoulliRationalLocal(2 * k);
    if (B2kRat.num === 0n) break;
    const B2kFloat = bernoulliFloat(B2kRat, work);
    if (B2kFloat.mantissa === 0n) break;
    // coeff = pochNum / factDen as BigFloat.
    const coeff = bigfloatRatio(pochNum, factDen, work);
    const term = cmul(cfromReal(mul(B2kFloat, coeff, work)), zPow, work);
    const termMag = magBits(term);
    if (termMag < -prec - 16) {
      zetaResult = cadd(zetaResult, term, work);
      break;
    }
    if (termMag > prevTermMag) break;
    zetaResult = cadd(zetaResult, term, work);
    prevTermMag = termMag;
    pochNum = pochNum * BigInt(s + 2 * k - 1) * BigInt(s + 2 * k);
    factDen = factDen * BigInt(2 * k + 1) * BigInt(2 * k + 2);
    zPow = cmul(zPow, oneOverZ2, work);
  }
  // Full ζ(m+1, z) = shiftSum + ζ(m+1, z+N).
  const zetaTotal = cadd(shiftSum, zetaResult, work);
  // m! as a BigInt.
  let factM = 1n;
  for (let i = 2; i <= m; i++) factM *= BigInt(i);
  const factMBC = cfromReal(fromInt(factM, work));
  const factMTimesZeta = cmul(factMBC, zetaTotal, work);
  // Sign: (-1)^(m+1). m=2 ⇒ sign = -1; m=3 ⇒ +1; etc.
  const signed = m % 2 === 0 ? cneg(factMTimesZeta) : factMTimesZeta;
  return {
    re: normalise(signed.re.mantissa, signed.re.exponent, prec),
    im: normalise(signed.im.mantissa, signed.im.exponent, prec),
  };
}

/**
 * Exact rational `num / den` as a BigFloat at `prec` bits. Local helper
 * mirroring `ratioBigInt` in `special.ts`; we avoid the cross-module
 * import to keep the dependency arrow uniform (special.ts → complex.ts
 * already exists for `bernoulliRational`).
 */
function bigfloatRatio(num: bigint, den: bigint, prec: number): BigFloat {
  if (num === 0n) return { mantissa: 0n, exponent: 0, precision: prec };
  const safety = 32;
  const workingBits = prec + safety;
  const sign = num < 0n ? -1n : 1n;
  const absNum = sign === -1n ? -num : num;
  const numShifted = absNum << BigInt(workingBits);
  const q = numShifted / den;
  const remainder = numShifted - q * den;
  const qWithSticky = remainder === 0n ? q : q | 1n;
  return normalise(sign * qWithSticky, -workingBits, prec);
}

/**
 * Reflection branch of `cpolygamma` for `Re(z) < ½`, `m ≥ 2`:
 *
 *   ψ^(m)(1 − z) + (−1)^(m−1) · ψ^(m)(z) = (−1)^m · π · d^m/dz^m cot(πz)
 *
 * Solving for `ψ^(m)(z)`:
 *
 *   ψ^(m)(z) = (−1)^(m−1) · [(−1)^m · π · cot^(m)(πz) − ψ^(m)(1 − z)]
 *            = −π · cot^(m)(πz) + (−1)^m · ψ^(m)(1 − z)
 *
 * where `cot^(m)(πz) := d^m/dz^m cot(πz)` is closed-form polynomial in
 * `c = cot(πz)` and `s = csc²(πz)` of degree m. The standard recurrence
 * (e.g. mpmath's `_polygamma_at_origin`, Abramowitz & Stegun §6.4.7):
 *
 *   cot^(1)(πz) = −π · s                          = −π s
 *   cot^(2)(πz) =  2π² · c · s                    = 2π² c s
 *   cot^(3)(πz) = −π³ · (4 c² s + 2 s²)           = −π³ s(4c² + 2s)
 *   cot^(4)(πz) =  π⁴ · (8 c³ s + 16 c s²)        = 8π⁴ c s (c² + 2 s)
 *   cot^(5)(πz) = −π⁵ · (16 c⁴ s + 88 c² s² + 16 s³) = ...
 *
 * (Each π factor comes from the chain rule on the argument πz; the
 * polynomial in {c, s} comes from `d/dz cot(πz) = −π csc²(πz) = −π s`
 * and `d/dz csc²(πz) = −2π cot(πz) csc²(πz) = −2π c s` recursed.)
 *
 * v0.1 supports m ∈ {2, 3, 4, 5}; m ≥ 6 throws with a clear v0.2
 * followup message. The cotangent polynomial coefficients are exact
 * small integers; we evaluate them inline (no recurrence machinery)
 * because m ≤ 5 means at most three monomials per derivative.
 *
 * Near-pole handling: the integer poles of `cot(πz)` are at `z ∈ ℤ`,
 * and `csc²(πz)` blows up *quadratically*. We use the same `ζ = z − m`
 * reduction as `cdigammaReflect` (which is π-periodic), and
 * `cot(πz) = cot(πζ)`, `csc²(πz) = csc²(πζ)`. For exact non-positive
 * integer z, throw.
 */
function cpolygammaReflect(
  m: number,
  z: BigComplex,
  prec: number,
): BigComplex {
  if (m < 2 || m > 5) {
    throw new RangeError(
      `cpolygamma: reflection (Re(z) < 1/2) supported for m ∈ {1, …, 5}; ` +
        `got m = ${m}. v0.2 followup: extend cot-polynomial coefficient ` +
        `recurrence to general m via Faà di Bruno.`,
    );
  }
  const reFloat = toFloat64(z.re).value;
  if (!Number.isFinite(reFloat)) {
    throw new RangeError(`cpolygamma: Re(z) not finite`);
  }
  const mInt = Math.round(reFloat);
  const inPrec = Math.max(z.re.precision, z.im.precision);
  const zeta0: BigComplex =
    mInt === 0
      ? z
      : { re: sub(z.re, fromInt(BigInt(mInt), inPrec), inPrec), im: z.im };
  if (mInt <= 0 && isZero(z.im) && isZero(zeta0.re)) {
    throw new RangeError(
      `cpolygamma: argument is a non-positive integer (ψ^(m) has a pole)`,
    );
  }
  const lossBits =
    mInt === 0 ? 0 : Math.max(0, magBits(z) - magBits(zeta0));
  const work = prec + 32 + lossBits;
  const zeta: BigComplex =
    mInt === 0
      ? z
      : { re: sub(z.re, fromInt(BigInt(mInt), work), work), im: z.im };

  // Compute c = cot(πζ) and s = csc²(πζ) at working precision via the
  // cexp(±iπζ) trick (same as `cdigammaReflect`).
  const piW = pi(work);
  const piTimesZeta: BigComplex = {
    re: mul(piW, zeta.re, work),
    im: mul(piW, zeta.im, work),
  };
  const iPiZeta: BigComplex = { re: neg(piTimesZeta.im), im: piTimesZeta.re };
  const ePlus = cexp(iPiZeta, work);
  const eMinus = cexp(cneg(iPiZeta), work);
  const cosPi: BigComplex = {
    re: div(add(ePlus.re, eMinus.re, work), fromInt(2n, work), work),
    im: div(add(ePlus.im, eMinus.im, work), fromInt(2n, work), work),
  };
  const sinPi: BigComplex = {
    re: div(sub(ePlus.im, eMinus.im, work), fromInt(2n, work), work),
    im: neg(div(sub(ePlus.re, eMinus.re, work), fromInt(2n, work), work)),
  };
  if (cisZero(sinPi)) {
    throw new RangeError(`cpolygamma: pole at z = ${reFloat}`);
  }
  const c = cdiv(cosPi, sinPi, work); // cot(πζ)
  const sinPi2 = cmul(sinPi, sinPi, work);
  const oneC = cfromReal(fromInt(1n, work));
  const sBC = cdiv(oneC, sinPi2, work); // csc²(πζ) = 1 / sin²(πζ)

  // Build `cot^(m)(πζ)` polynomial in {c, s}. We collect coefficients of
  // monomials c^i · s^j (with `i + j = ...`); exact integer coefficients
  // for m ≤ 5.
  //
  // Polynomial table (verified against mpmath `polygamma`'s reflection
  // recurrence; the constants come from differentiating
  //   d/dz [c^i s^j] = i·c^{i-1}·(d/dz c)·s^j + j·c^i·s^{j-1}·(d/dz s)
  //                  = i·c^{i-1}·(−π s)·s^j + j·c^i·s^{j-1}·(−2π c s)
  //                  = −π · (i · c^{i-1} · s^{j+1} + 2j · c^{i+1} · s^j)
  // starting from cot^(0) = c, applied m times):
  //
  //   m=2: cot^(2)(πζ) =  2 π² · c · s
  //   m=3: cot^(3)(πζ) = −π³ · (4 c² s + 2 s²)
  //   m=4: cot^(4)(πζ) =  π⁴ · (8 c³ s + 16 c s²)
  //   m=5: cot^(5)(πζ) = −π⁵ · (16 c⁴ s + 88 c² s² + 16 s³)
  //
  // Multiply by π (the outer factor in the DLMF §5.15.6 formula) once at
  // the end:  π · cot^(m)(πζ).
  const c2 = cmul(c, c, work);
  const c3 = cmul(c2, c, work);
  const c4 = cmul(c3, c, work);
  const s2 = cmul(sBC, sBC, work);
  const s3 = cmul(s2, sBC, work);
  let cotM: BigComplex;
  // The π^m factor: build cumulatively.
  // We'll fold the π^m and the overall π · (...) together at the end.
  // First compute the monomial sum (no π factor); we'll multiply by
  // π^(m+1) at the end (m for the chain rule, 1 for DLMF's leading π).
  // Sign: cot^(m) has factor (-1)^... — encoded explicitly in each branch.
  if (m === 2) {
    // 2 c s
    cotM = cmul(cfromReal(fromInt(2n, work)), cmul(c, sBC, work), work);
  } else if (m === 3) {
    // −(4 c² s + 2 s²)
    const t1 = cmul(cfromReal(fromInt(4n, work)), cmul(c2, sBC, work), work);
    const t2 = cmul(cfromReal(fromInt(2n, work)), s2, work);
    cotM = cneg(cadd(t1, t2, work));
  } else if (m === 4) {
    // 8 c³ s + 16 c s²
    const t1 = cmul(cfromReal(fromInt(8n, work)), cmul(c3, sBC, work), work);
    const t2 = cmul(cfromReal(fromInt(16n, work)), cmul(c, s2, work), work);
    cotM = cadd(t1, t2, work);
  } else {
    // m === 5
    // −(16 c⁴ s + 88 c² s² + 16 s³)
    const t1 = cmul(cfromReal(fromInt(16n, work)), cmul(c4, sBC, work), work);
    const t2 = cmul(cfromReal(fromInt(88n, work)), cmul(c2, s2, work), work);
    const t3 = cmul(cfromReal(fromInt(16n, work)), s3, work);
    cotM = cneg(cadd(cadd(t1, t2, work), t3, work));
  }
  // Multiply by π^(m+1).  (m chain-rule π factors + 1 DLMF leading π).
  let piPow = piW;
  for (let i = 1; i <= m; i++) {
    piPow = mul(piPow, piW, work);
  }
  const piCotTerm = cmul(cfromReal(piPow), cotM, work);
  // ψ^(m)(z) = −π · cot^(m)(πζ)  +  (−1)^m · ψ^(m)(1 − z).
  // The leading "−π" was already folded above; the polynomial encodes
  // the sign of cot^(m). To net to the formula above: the m=2 term is
  // `+2 c s` (no − sign) and the formula `−π · 2 c s · π²` = `−2π³ c s`.
  // Yet DLMF §5.15.6 with m=2 says `+2π² c s` is `cot^(2)(πz)` and we
  // want `-π · cot^(2)(πz)` → `-2π³ c s`. Match.
  const oneMinusZ: BigComplex = {
    re: sub(fromInt(1n, work), z.re, work),
    im: neg(z.im),
  };
  const reflected = cpolygamma(m, oneMinusZ, work);
  const reflectedSigned = m % 2 === 0 ? reflected : cneg(reflected);
  const result = cadd(cneg(piCotTerm), reflectedSigned, work);
  return {
    re: normalise(result.re.mantissa, result.re.exponent, prec),
    im: normalise(result.im.mantissa, result.im.exponent, prec),
  };
}

/**
 * Upper incomplete Gamma function for complex `a, z`:
 *
 *   Γ(a, z) = ∫_z^∞ t^{a−1} · e^{−t} dt    (DLMF §8.2.2)
 *
 * Two-regime dispatch matching the real-axis `bigIncompleteGammaUpper`:
 *
 *   z = 0 + 0i              → Γ(a)  (closed form; DLMF §8.2.4)
 *   |z| < |a| + 1           → series for γ(a, z); Γ(a, z) = Γ(a) − γ
 *   |z| ≥ |a| + 1           → modified Lentz CF for Γ(a, z) directly
 *
 * The series and the CF use the SAME formulas as the real path
 * (`bigIncompleteGammaLowerSeries`, `bigIncompleteGammaUpperCF`) with
 * every BigFloat operation replaced by its BigComplex counterpart.
 * Cephes rescaling guards `big = 4.5e15`, `biginv = 2.22e-16` carry
 * over verbatim (R3 §0.0 port discipline); in modified Lentz they are
 * implicit on the hot path (the C/D ratios cannot drift far from 1 by
 * construction) but are constructed at working precision for future
 * direct-accumulator parity.
 *
 * Real-axis defer: `isZero(a.im) && isZero(z.im) && sgn(a.re) > 0 && sgn(z.re) >= 0`
 * defers to `bigIncompleteGammaUpper`. Conjugate symmetry holds by
 * construction (the integrand has real coefficients), so for `Im(z)` only
 * the algorithmic regimes split symmetrically: `cIncompleteGammaUpper(ā, z̄)
 * = conj(cIncompleteGammaUpper(a, z))`.
 *
 * Near-pole handling for `a`: when `a` is within `2^{-prec/4}` of a non-
 * positive integer, `Γ(a) − γ(a, z)` becomes ill-conditioned (the series
 * regime computes `Γ(a)` directly via `cgamma`, which throws at exact
 * poles). v0.1 throws with a clear "near-pole; v0.2 followup" message;
 * v0.2 will implement regularised-form complex handling.
 *
 * Temme uniform asymptotic for the `|z − a| ≤ C·√|a|` saddle region and
 * Poincaré asymptotic for `|z| → ∞` are deferred to v0.2 (same as the
 * real path; PHASE2 §I3d acceptance carve-out).
 */
export function cIncompleteGammaUpper(
  a: BigComplex,
  z: BigComplex,
  prec: number,
): BigComplex {
  if (prec < 1 || !Number.isInteger(prec)) {
    throw new RangeError(
      `cIncompleteGammaUpper: prec must be a positive integer; got ${prec}.`,
    );
  }
  // Real-axis defer for a > 0, z ≥ 0: bit-identical to the real lane.
  if (
    isZero(a.im) &&
    isZero(z.im) &&
    sgn(a.re) > 0 &&
    sgn(z.re) >= 0
  ) {
    return cfromReal(bigIncompleteGammaUpper(a.re, z.re, prec));
  }
  // z = 0 closed form: Γ(a, 0) = Γ(a).
  if (cisZero(z)) {
    return cgamma(a, prec);
  }
  // a = 1 closed form: Γ(1, z) = e^{−z}.
  if (isZero(a.im) && a.re.mantissa === 1n && a.re.exponent === 0) {
    return cexp(cneg(z), prec);
  }
  // Near-pole check on `a`: throw if Re(a) is within 2^{-prec/4} of a
  // non-positive integer. We measure distance to nearest integer in
  // floating arithmetic — the magnitude of the imaginary part is also
  // a safety bound (Im(a) ≠ 0 by a meaningful amount means we are off
  // the real-axis poles).
  if (isNearNonPositiveIntegerPole(a, prec)) {
    throw new RangeError(
      `cIncompleteGammaUpper: a is within 2^{-prec/4} of a non-positive ` +
        `integer (Γ(a) has a pole; Γ(a)−γ(a,z) is ill-conditioned). ` +
        `suggestion: v0.2 followup will support regularised-form complex ` +
        `handling near the poles.`,
    );
  }
  // Dispatch: |z| < |a| + 1 ⇒ series; else CF.
  const aMag = toFloat64(cabs(a, 53)).value;
  const zMag = toFloat64(cabs(z, 53)).value;
  if (!Number.isFinite(aMag) || !Number.isFinite(zMag)) {
    // Defensive: huge-magnitude both. Use CF.
    return cIncompleteGammaUpperCF(a, z, prec);
  }
  if (zMag < aMag + 1) {
    // Γ(a, z) = Γ(a) − γ(a, z). The subtraction is cancellation-LIGHT in
    // this regime (γ < Γ(a) by integral bound; for |z| small relative
    // to |a|, γ is small compared to Γ(a)).
    const work = prec + 32;
    const lower = cIncompleteGammaLowerSeries(a, z, work);
    const gammaA = cgamma(a, work);
    const result = csub(gammaA, lower, work);
    return {
      re: normalise(result.re.mantissa, result.re.exponent, prec),
      im: normalise(result.im.mantissa, result.im.exponent, prec),
    };
  }
  return cIncompleteGammaUpperCF(a, z, prec);
}

/**
 * Lower incomplete Gamma function for complex `a, z`:
 *
 *   γ(a, z) = ∫_0^z t^{a−1} · e^{−t} dt    (DLMF §8.2.1)
 *
 * Two-regime dispatch matching the real-axis `bigIncompleteGammaLower`:
 *
 *   z = 0 + 0i              → 0  (closed form)
 *   |z| < |a| + 1           → series (DLMF §8.5.1 Kummer form)
 *   |z| ≥ |a| + 1           → complementarity: γ(a, z) = Γ(a) − Γ(a, z) via CF
 *
 * Real-axis defer (`a > 0, z ≥ 0`) lands in `bigIncompleteGammaLower`.
 *
 * MUTATION-PROOF: in the |z| < |a| + 1 regime the dispatch routes through
 * the series directly — NOT through `Γ(a) − Γ(a, z)`. The reverse would
 * lose precision because Γ(a, z) ≈ Γ(a) there. The closed-form
 * complementarity invariant `γ + Γ_upper = Γ(a)` is the load-bearing
 * round-trip check in the test suite.
 */
export function cIncompleteGammaLower(
  a: BigComplex,
  z: BigComplex,
  prec: number,
): BigComplex {
  if (prec < 1 || !Number.isInteger(prec)) {
    throw new RangeError(
      `cIncompleteGammaLower: prec must be a positive integer; got ${prec}.`,
    );
  }
  // Real-axis defer for a > 0, z ≥ 0: bit-identical to the real lane.
  if (
    isZero(a.im) &&
    isZero(z.im) &&
    sgn(a.re) > 0 &&
    sgn(z.re) >= 0
  ) {
    return cfromReal(bigIncompleteGammaLower(a.re, z.re, prec));
  }
  // z = 0 closed form: γ(a, 0) = 0.
  if (cisZero(z)) {
    return {
      re: { mantissa: 0n, exponent: 0, precision: prec },
      im: { mantissa: 0n, exponent: 0, precision: prec },
    };
  }
  // a = 1 closed form: γ(1, z) = 1 − e^{−z}.
  if (isZero(a.im) && a.re.mantissa === 1n && a.re.exponent === 0) {
    const work = prec + 32;
    const expNegZ = cexp(cneg(z), work);
    const one = cfromReal(fromInt(1n, work));
    const result = csub(one, expNegZ, work);
    return {
      re: normalise(result.re.mantissa, result.re.exponent, prec),
      im: normalise(result.im.mantissa, result.im.exponent, prec),
    };
  }
  // Near-pole check on `a`: the SERIES path divides by `a` at the leading
  // prefactor; the COMPLEMENTARITY path goes through `cgamma(a)` which
  // throws at non-positive integers. Either way, refuse near the poles.
  if (isNearNonPositiveIntegerPole(a, prec)) {
    throw new RangeError(
      `cIncompleteGammaLower: a is within 2^{-prec/4} of a non-positive ` +
        `integer (Γ(a) has a pole; division-by-a series prefactor is ill- ` +
        `conditioned). suggestion: v0.2 followup will support regularised- ` +
        `form complex handling near the poles.`,
    );
  }
  const aMag = toFloat64(cabs(a, 53)).value;
  const zMag = toFloat64(cabs(z, 53)).value;
  if (!Number.isFinite(aMag) || !Number.isFinite(zMag)) {
    // Defensive: huge magnitudes. Use complementarity.
    const work = prec + 32;
    const upper = cIncompleteGammaUpperCF(a, z, work);
    const gammaA = cgamma(a, work);
    const result = csub(gammaA, upper, work);
    return {
      re: normalise(result.re.mantissa, result.re.exponent, prec),
      im: normalise(result.im.mantissa, result.im.exponent, prec),
    };
  }
  if (zMag < aMag + 1) {
    // Direct series — γ-value is the answer.
    return cIncompleteGammaLowerSeries(a, z, prec);
  }
  // |z| ≥ |a| + 1: complementarity γ(a, z) = Γ(a) − Γ(a, z) where Γ(a, z)
  // is computed via the CF (the small piece in this regime). Cancellation-
  // free because Γ(a, z) ≪ Γ(a).
  const work = prec + 32;
  const upper = cIncompleteGammaUpperCF(a, z, work);
  const gammaA = cgamma(a, work);
  const result = csub(gammaA, upper, work);
  return {
    re: normalise(result.re.mantissa, result.re.exponent, prec),
    im: normalise(result.im.mantissa, result.im.exponent, prec),
  };
}

/**
 * Helper: test whether the input is within `2^{-prec/4}` of a non-positive
 * integer pole of `Γ(a)`. Used by `cIncompleteGammaUpper/Lower` to refuse
 * ill-conditioned inputs honestly.
 *
 * The bound `2^{-prec/4}` matches the cancellation budget of the
 * Γ(a)−γ(a,z) subtraction in the series regime: a closer approach loses
 * more than 1/4 of the requested precision before the subtraction can
 * recover, even with the working-precision bump.
 */
function isNearNonPositiveIntegerPole(a: BigComplex, prec: number): boolean {
  const aReFloat = toFloat64(a.re).value;
  const aImFloat = toFloat64(a.im).value;
  if (!Number.isFinite(aReFloat) || !Number.isFinite(aImFloat)) return false;
  const nearest = Math.round(aReFloat);
  if (nearest > 0) return false; // poles are at non-positive integers only
  const reDist = Math.abs(aReFloat - nearest);
  const imDist = Math.abs(aImFloat);
  const threshold = Math.pow(2, -prec / 4);
  // Distance to the integer in the complex plane.
  const dist = Math.hypot(reDist, imDist);
  return dist < threshold;
}

/**
 * Power-series evaluator for `γ(a, z)` (complex), via DLMF §8.5.1:
 *
 *   γ(a, z) = (z^a / a) · e^{−z} · Σ_{k≥0} z^k / (1 + a)_k
 *           = (z^a / a) · e^{−z} · Σ_{k=0}^∞  z^k / ((a+1)(a+2)…(a+k))
 *
 * Per-term recurrence: `term_{k+1} = term_k · z / (a + k + 1)`.
 *
 * Caller must ensure `|z| < |a| + 1` for fast convergence. The
 * `cpow(z, a)` and `cexp(−z)` prefactors carry their own branch cuts;
 * the standard principal-branch convention `Im(log z) ∈ (−π, π]` from
 * `clog` is used uniformly. For `z = 0` the function returns 0 exactly
 * (the prefactor `(z^a / a)` would otherwise pass through `cpow(0, a)`
 * which throws for non-real-positive `a`).
 */
function cIncompleteGammaLowerSeries(
  a: BigComplex,
  z: BigComplex,
  prec: number,
): BigComplex {
  if (cisZero(z)) {
    return {
      re: { mantissa: 0n, exponent: 0, precision: prec },
      im: { mantissa: 0n, exponent: 0, precision: prec },
    };
  }
  const work = prec + 64;
  const oneC = cfromReal(fromInt(1n, work));
  let sum = oneC;
  let term = oneC;
  const stopMagThreshold = -prec - 8;
  const maxTerms = Math.max(64, work * 4);
  for (let k = 0; k < maxTerms; k++) {
    // term_{k+1} = term_k · z / (a + k + 1)
    const denom = cadd(a, cfromReal(fromInt(BigInt(k + 1), work)), work);
    term = cdiv(cmul(term, z, work), denom, work);
    if (cisZero(term)) break;
    sum = cadd(sum, term, work);
    const termMag = magBits(term);
    const sumMag = magBits(sum);
    if (termMag === -Infinity) break;
    if (termMag - sumMag < stopMagThreshold) break;
  }
  // Prefactor: (z^a / a) · e^{−z}.
  const expNegZ = cexp(cneg(z), work);
  const zPowA = cpow(z, a, work);
  const prefactor = cdiv(cmul(expNegZ, zPowA, work), a, work);
  const result = cmul(prefactor, sum, work);
  return {
    re: normalise(result.re.mantissa, result.re.exponent, prec),
    im: normalise(result.im.mantissa, result.im.exponent, prec),
  };
}

/**
 * Modified Lentz continued fraction for `Γ(a, z)` (complex), DLMF §8.9.2:
 *
 *   Γ(a, z) = e^{−z} · z^a · CF(a, z)
 *
 *   CF = 1 / (z + 1 − a  −  1·(1 − a) / (z + 3 − a  −  2·(2 − a) /
 *                                       (z + 5 − a  −  3·(3 − a) / ( … ))))
 *
 * In `b_0 + a_1/(b_1 + a_2/(b_2 + …))` form:
 *
 *   b_0 = z + 1 − a
 *   a_n = −n · (n − a)      (n ≥ 1)
 *   b_n = z + (2n + 1) − a  (n ≥ 1)
 *
 * Same recurrence as `bigIncompleteGammaUpperCF` in
 * `special-funcs/incomplete-gamma.ts`; every BigFloat operation is lifted
 * to BigComplex. The Cephes guards `big = 4.5e15`, `biginv = 2.22e-16`
 * remain as the verbatim-port reference (R3 §0.0); in modified Lentz they
 * are implicit (the C/D ratios cannot drift far from 1 by construction)
 * but are constructed at working precision so a future Cephes-direct port
 * (for the float64 bridge) can use them.
 *
 * Caller must ensure `|z| ≥ |a| + 1` for the convergence rate ≈ `|z/a|`
 * to be ≥ 1. Outside this regime the CF still converges (any `Re(z) > 0`
 * works) but more slowly.
 */
function cIncompleteGammaUpperCF(
  a: BigComplex,
  z: BigComplex,
  prec: number,
): BigComplex {
  const work = prec + 64;
  // Cephes guards (verbatim-port reference, not used on hot path; matches
  // `bigIncompleteGammaUpperCF`).
  void cephesBigComplex(work);
  void cephesBigInvComplex(work);
  const TINY: BigComplex = {
    re: { mantissa: 1n, exponent: -10 * work, precision: work },
    im: { mantissa: 0n, exponent: 0, precision: work },
  };
  const oneC = cfromReal(fromInt(1n, work));
  // b_0 = z + 1 − a
  const b0 = csub(cadd(z, oneC, work), a, work);
  let f = cisZero(b0) ? TINY : b0;
  let C = f;
  let D: BigComplex = {
    re: { mantissa: 0n, exponent: 0, precision: work },
    im: { mantissa: 0n, exponent: 0, precision: work },
  };
  const stopMagThreshold = -prec - 4;
  const maxCycles = Math.max(128, work * 4);
  for (let n = 1; n <= maxCycles; n++) {
    const nC = cfromReal(fromInt(BigInt(n), work));
    const nMinusA = csub(nC, a, work);
    const aN = cneg(cmul(nC, nMinusA, work));
    // b_n = z + (2n + 1) − a
    const bN = csub(
      cadd(z, cfromReal(fromInt(BigInt(2 * n + 1), work)), work),
      a,
      work,
    );
    // D_n = b_n + a_n · D_{n-1}
    D = cadd(bN, cmul(aN, D, work), work);
    if (cisZero(D)) D = TINY;
    // C_n = b_n + a_n / C_{n-1}
    if (cisZero(C)) C = TINY;
    C = cadd(bN, cdiv(aN, C, work), work);
    if (cisZero(C)) C = TINY;
    // D = 1 / D
    D = cdiv(oneC, D, work);
    // delta = C · D
    const delta = cmul(C, D, work);
    f = cmul(f, delta, work);
    // Convergence: |delta − 1| < 2^{-prec}.
    const deltaMinusOne = csub(delta, oneC, work);
    if (magBits(deltaMinusOne) < stopMagThreshold) break;
  }
  // CF = 1 / f.
  const cfValue = cdiv(oneC, f, work);
  // Γ(a, z) = e^{−z} · z^a · CF.
  const expNegZ = cexp(cneg(z), work);
  const zPowA = cpow(z, a, work);
  const result = cmul(cmul(expNegZ, zPowA, work), cfValue, work);
  return {
    re: normalise(result.re.mantissa, result.re.exponent, prec),
    im: normalise(result.im.mantissa, result.im.exponent, prec),
  };
}

/** Cephes `big = 4.5e15` (= 2⁵²) at the given working precision. Verbatim-
 *  port reference; not used directly in the modified-Lentz hot path
 *  (which is self-rescaling) but constructed for parity with the real
 *  substrate's `cephesBig`. */
function cephesBigComplex(prec: number): BigComplex {
  return cfromReal(fromInt(1n << 52n, prec));
}

/** Cephes `biginv = 2.22e-16` (= 2⁻⁵²) at the given working precision. */
function cephesBigInvComplex(prec: number): BigComplex {
  const num = fromInt(1n, prec + 32);
  const den = fromInt(1n << 52n, prec + 32);
  return cfromReal(div(num, den, prec));
}

/**
 * `B(a, b)` (complex Beta function) via the lgamma identity:
 *
 *   B(a, b) = exp(log Γ(a) + log Γ(b) − log Γ(a + b))
 *
 * Computed via `clgamma` at extra working precision (`prec + 32`) and
 * exponentiated. Unlike the real `bigBeta` (which decomposes Γ into
 * `|Γ| · sign` and tracks the sign explicitly), no sign tracking is
 * needed in the complex case: `clgamma` returns a complex logarithm
 * directly, including the imaginary contribution that encodes the
 * sign/branch of Γ on the negative real axis. `cexp(sum)` recovers the
 * full signed/branched complex value byte-for-byte.
 *
 * Real-axis defer for both arguments positive real lands in `bigBeta`.
 *
 * Failure modes — all routed through `clgamma`'s loud rejections:
 *
 *   - a or b a non-positive integer ⇒ `clgamma` throws "argument is a
 *     non-positive integer". B(0, b) is infinite; B(−1, 2) is infinite;
 *     etc. We let the throw propagate.
 *   - a + b a non-positive integer with a, b not separately at a pole ⇒
 *     `clgamma(a + b)` throws; we recategorise: B(a, b) is a finite
 *     limit in this case (e.g., B(1/2, 1/2) at a + b = 1, fine; the
 *     interesting cases are a + b = 0, −1, −2 where the result is 0
 *     by a limit). v0.1 throws with a clear "near-pole; v0.2 limit
 *     handling followup" message — the limit value is well-defined
 *     but its arb-prec computation requires the regularised form.
 *
 * Near-pole detection for `a + b`: we check both `a`, `b`, and `a + b`
 * independently. The sum is checked AFTER `a` and `b` pass the
 * near-pole test, so a benign `a = 1/2, b = 1/2, a + b = 1` (where 1 is
 * positive, not a pole) is not refused.
 */
export function cBeta(
  a: BigComplex,
  b: BigComplex,
  prec: number,
): BigComplex {
  if (prec < 1 || !Number.isInteger(prec)) {
    throw new RangeError(
      `cBeta: prec must be a positive integer; got ${prec}.`,
    );
  }
  // Real-axis defer for both inputs positive real.
  if (
    isZero(a.im) &&
    isZero(b.im) &&
    sgn(a.re) > 0 &&
    sgn(b.re) > 0
  ) {
    return cfromReal(bigBeta(a.re, b.re, prec));
  }
  // Near-pole checks: a, b, a+b. The `2^{-prec/4}` threshold matches the
  // `cIncompleteGammaUpper` convention.
  if (isNearNonPositiveIntegerPole(a, prec)) {
    throw new RangeError(
      `cBeta: a is within 2^{-prec/4} of a non-positive integer ` +
        `(Γ(a) has a pole). suggestion: v0.2 followup will support limit ` +
        `handling for the cBeta near-pole regime.`,
    );
  }
  if (isNearNonPositiveIntegerPole(b, prec)) {
    throw new RangeError(
      `cBeta: b is within 2^{-prec/4} of a non-positive integer ` +
        `(Γ(b) has a pole). suggestion: v0.2 followup will support limit ` +
        `handling for the cBeta near-pole regime.`,
    );
  }
  const work = prec + 32;
  const aPlusB = cadd(a, b, work);
  if (isNearNonPositiveIntegerPole(aPlusB, prec)) {
    throw new RangeError(
      `cBeta: a + b is within 2^{-prec/4} of a non-positive integer ` +
        `(Γ(a+b) has a pole; B(a,b) → 0 as a limit but requires regularised ` +
        `handling). suggestion: v0.2 followup will support limit handling.`,
    );
  }
  const logBeta = csub(
    cadd(clgamma(a, work), clgamma(b, work), work),
    clgamma(aPlusB, work),
    work,
  );
  return cexp(logBeta, prec);
}

