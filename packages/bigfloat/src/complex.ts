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

import { BigFloat, normalise, bitLength } from "./types.js";
import { abs, neg, sgn, isZero } from "./comparison.js";
import { add, sub, mul, div, sqrt, powInt } from "./arithmetic.js";
import { fromInt, fromString, toFloat64 } from "./conversion.js";
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
