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
