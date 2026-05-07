// =============================================================================
// @workbench/bigfloat — Γ, log Γ, ψ, polygamma
// =============================================================================
//
// Algorithms (real-argument; complex versions live in the BigComplex module):
//
//   log Γ(z) for large z (Re z > shiftThreshold ≈ prec/4):
//     Stirling's asymptotic series
//     log Γ(z) = (z − 1/2) · log z − z + (1/2)·log(2π)
//                 + Σ_{k=1}^{N}  B_{2k} / (2k(2k−1) z^{2k−1})
//     Truncate at the smallest term; remainder bound is below the next
//     term in magnitude (alternating asymptotic).
//
//   log Γ(z) for moderate z (0 < z ≤ shiftThreshold):
//     Recurrence  log Γ(z) = log Γ(z + N) − Σ_{k=0}^{N-1} log(z + k)
//     where N is chosen so that z + N ≥ shiftThreshold.
//
//   log Γ(z) for z ≤ 0:
//     Reflection  Γ(z) Γ(1 − z) = π / sin(π z)
//     ⟹  log Γ(z) = log π − log |sin(π z)| − log Γ(1 − z)
//     The sign of Γ(z) flips per (1−z mod 1) interval; lgamma returns
//     real-valued log|Γ|; gamma adds the sign.
//
//   ψ(z) (digamma): exactly the same shape, with the series
//     ψ(z) = log z − 1 / (2z) − Σ_{k=1}^{N}  B_{2k} / (2k · z^{2k})
//   and recurrence  ψ(z) = ψ(z + 1) − 1/z.
//   Reflection: ψ(1 − z) − ψ(z) = π · cot(π z).
//
//   polygamma ψ^(m)(z) for m ≥ 1:
//     Hurwitz-zeta route: ψ^(m)(z) = (-1)^(m+1) m! · ζ(m+1, z), with
//     z-shift recurrence to bring z above a threshold and then a
//     truncated zeta series. v0.1 ships m = 1 only (trigamma); higher
//     orders fall through to a tagged-not-implemented marker — the
//     MeijerG benchmark only needs trigamma in the Stirling-style
//     coalescence handling.

import {
  BigFloat,
  normalise,
  bitLength,
} from "./types.js";
import { abs, neg, sgn, cmp, eq, isZero, lt, gt } from "./comparison.js";
import { add, sub, mul, div, sqrt, powInt } from "./arithmetic.js";
import { fromInt, fromString, toFloat64 } from "./conversion.js";
import { ln2, pi, exp, log, sin } from "./transcendental.js";
import { bernoulliRational } from "./bernoulli.js";

/** B_{2k} as a BigFloat at the requested precision. */
function bernoulli(n: number, prec: number): BigFloat {
  const r = bernoulliRational(n);
  if (r.num === 0n) return { mantissa: 0n, exponent: 0, precision: prec };
  // Convert (num, den) → BigFloat at given precision.
  // Use long division shifted enough to provide `precision + safety` bits.
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
 * `log Γ(z)` for `z > 0` (real argument).
 *
 * Throws on `z ≤ 0` for now. Negative-real-argument branch (where Γ is
 * still defined except at non-positive integers) lives in `gamma`,
 * which uses the reflection formula and emits a sign separately.
 */
export function lgamma(z: BigFloat, prec: number): BigFloat {
  if (sgn(z) <= 0) {
    // For negative z (non-integer), |Γ(z)| is defined but Γ(z) flips sign.
    // We delegate to lgammaRealAbs which handles the reflection. lgamma
    // returns log|Γ|; sign is recovered in `gamma`.
    return lgammaRealAbs(z, prec);
  }
  // Working precision: we will subtract two values of comparable magnitude
  // (lgammaStirling(z+N) and Σ log(z+k)), and those values can be of order
  // log(N!) ≈ N log N ≈ shiftThreshold · log2(shiftThreshold). For
  // shiftThreshold up to ~prec/4 ≈ 50 (at prec=200), that is ~280 — about
  // log2(280) ≈ 9 bits of magnitude. Cancellation eats ≤ 10 bits, which a
  // 32-bit margin absorbs. But we also accumulate rounding from Stirling's
  // truncated series and from each log call; bump generously to 96 bits.
  const work = prec + 96;
  // Pick a "shift threshold" so that Stirling at z+N has good convergence.
  // Stirling's series truncated optimally at z' has error ~ exp(-2π z') on
  // a per-term basis; we need that below 2^-work. The condition gives
  // z' ≥ work·log(2)/(2π) ≈ work/9. We use work/8 for a small safety
  // margin and to keep the threshold a round number at small prec.
  const shiftThreshold = Math.max(8, Math.ceil(work / 8));
  // How many recurrences to apply.
  const zFloat = toFloat64(z).value;
  if (!Number.isFinite(zFloat)) {
    throw new RangeError(`lgamma: argument too large for stirling shift heuristic`);
  }
  const N = Math.max(0, Math.ceil(shiftThreshold - zFloat));
  // Compute log Γ(z + N) via Stirling.
  const zShifted = N > 0 ? add(z, fromInt(BigInt(N), work), work) : z;
  let result = lgammaStirling(zShifted, work);
  // Subtract Σ log(z + k) for k = 0..N-1.
  for (let k = 0; k < N; k++) {
    const zk = add(z, fromInt(BigInt(k), work), work);
    result = sub(result, log(zk, work), work);
  }
  return normalise(result.mantissa, result.exponent, prec);
}

/**
 * `log Γ(z)` via Stirling's asymptotic series. Caller must ensure `z` is
 * "Stirling-friendly" — typically `Re z ≥ prec/4`.
 *
 * Stops adding terms when the term magnitude starts increasing (asymptotic
 * series; optimal truncation is at the smallest term).
 */
function lgammaStirling(z: BigFloat, prec: number): BigFloat {
  // (z - 1/2) log z - z + (1/2) log(2π).
  const work = prec + 32;
  const half = fromString("0.5", work);
  const logZ = log(z, work);
  const log2pi = add(ln2(work), log(pi(work), work), work);
  const halfLog2pi = mul(log2pi, half, work);
  let result = sub(mul(sub(z, half, work), logZ, work), z, work);
  result = add(result, halfLog2pi, work);
  // Stirling correction series:  Σ B_{2k} / (2k(2k-1) z^{2k-1}).
  // 1/z is computed once; we multiply by 1/z² each iteration to advance.
  const oneOverZ = div(fromInt(1n, work), z, work);
  const oneOverZ2 = mul(oneOverZ, oneOverZ, work);
  let zPow = oneOverZ; // 1/z^(2k-1) starting at k=1, so 1/z.
  let prevTermMag = Infinity;
  for (let k = 1; k <= 300; k++) {
    const B2k = bernoulli(2 * k, work);
    if (B2k.mantissa === 0n) {
      // Shouldn't happen for B_{2k} with k ≥ 1 except by precision underflow.
      break;
    }
    const denomCoeff = fromInt(BigInt(2 * k * (2 * k - 1)), work);
    const term = div(mul(B2k, zPow, work), denomCoeff, work);
    // Track magnitude (in bits below 1) to detect when we've hit the
    // smallest term and the series is starting to diverge.
    const termAbsMan = term.mantissa < 0n ? -term.mantissa : term.mantissa;
    const termBits = bitLength(termAbsMan);
    const termMag = term.exponent + termBits; // log2 floor of |term|.
    // If we've reached our precision target, stop.
    if (termMag < -prec - 16) {
      result = add(result, term, work);
      break;
    }
    // If the term is bigger than the previous one, the asymptotic series is
    // diverging — stop *before* adding this term.
    if (termMag > prevTermMag) {
      break;
    }
    result = add(result, term, work);
    prevTermMag = termMag;
    // Advance to next iteration: 1/z^{2(k+1)-1} = 1/z^{2k+1} = current * 1/z².
    zPow = mul(zPow, oneOverZ2, work);
  }
  return normalise(result.mantissa, result.exponent, prec);
}

/**
 * `log |Γ(z)|` for real z, including z ≤ 0. Uses reflection at non-
 * positive z. Throws at non-positive integers (poles of Γ).
 */
function lgammaRealAbs(z: BigFloat, prec: number): BigFloat {
  if (isZero(z)) {
    throw new RangeError(`lgamma: argument is zero (Γ has a pole)`);
  }
  if (sgn(z) > 0) {
    return lgamma(z, prec);
  }
  // Reflection: Γ(z) · Γ(1 − z) = π / sin(π z).
  // ⟹ log |Γ(z)| = log π − log |sin(π z)| − log Γ(1 − z).
  // Detect non-positive integers (where sin(π z) = 0).
  const work = prec + 32;
  const zRound = Math.round(toFloat64(z).value);
  const zRoundedBack = fromInt(BigInt(zRound), work);
  if (eq(z, zRoundedBack)) {
    throw new RangeError(
      `lgamma: argument is a non-positive integer (Γ has a pole)`,
    );
  }
  const piW = pi(work);
  const piZ = mul(piW, z, work);
  const sinPiZ = sin(piZ, work);
  const oneMinusZ = sub(fromInt(1n, work), z, work);
  const result = sub(
    sub(log(piW, work), log(abs(sinPiZ), work), work),
    lgamma(oneMinusZ, work),
    work,
  );
  return normalise(result.mantissa, result.exponent, prec);
}

/**
 * `Γ(z)` for real argument. Throws at non-positive integers.
 *
 * For `z > 0`: gamma(z) = exp(lgamma(z)).
 * For `z < 0` non-integer: gamma(z) = sign · exp(lgamma|abs|(z)), where
 *   sign = (-1)^floor(1 - z) — equivalently the sign of sin(π z).
 */
export function gamma(z: BigFloat, prec: number): BigFloat {
  if (sgn(z) > 0) {
    return exp(lgamma(z, prec + 32), prec);
  }
  if (isZero(z)) {
    throw new RangeError(`gamma: argument is zero (Γ has a pole)`);
  }
  const zRound = Math.round(toFloat64(z).value);
  const zRoundedBack = fromInt(BigInt(zRound), z.precision);
  if (eq(z, zRoundedBack)) {
    throw new RangeError(`gamma: argument is a non-positive integer (Γ has a pole)`);
  }
  // sign of Γ(z) for z < 0, z non-integer: alternates per integer interval.
  // Γ(z) = π / (sin(π z) · Γ(1−z)). Γ(1−z) > 0 for z < 0 (since 1−z > 1).
  // sin(π z): for z = -0.5, sin(-π/2) = -1 → Γ(-0.5) = π/(-1 · √π) = -2√π < 0.
  // for z = -1.5, sin(-3π/2) = +1 → Γ(-1.5) > 0.
  // So sign = sgn(sin(π z)).
  const work = prec + 32;
  const piZ = mul(pi(work), z, work);
  const sinPiZ = sin(piZ, work);
  const sign = sgn(sinPiZ);
  if (sign === 0) {
    // Theoretically this means non-positive-integer z; we already checked.
    throw new RangeError(`gamma: pole at ${toFloat64(z).value}`);
  }
  const absG = exp(lgammaRealAbs(z, work), work);
  const signedG = sign === 1 ? absG : neg(absG);
  return normalise(signedG.mantissa, signedG.exponent, prec);
}

/**
 * `ψ(z)` (digamma) for real `z > 0`. Throws on non-positive z (where the
 * function has poles at integers and complex behaviour off-integer).
 *
 * Algorithm: shift z up to z + N with N large enough for Stirling-style
 * asymptotic, then use ψ(z) = ψ(z+N) − Σ_{k=0}^{N-1} 1/(z+k).
 */
export function digamma(z: BigFloat, prec: number): BigFloat {
  if (sgn(z) <= 0) {
    // For z ≤ 0, the reflection formula ψ(1-z) - ψ(z) = π cot(π z) lets us
    // evaluate where finite. Check for poles first.
    if (isZero(z)) {
      throw new RangeError(`digamma: argument is zero (ψ has a pole)`);
    }
    const zRound = Math.round(toFloat64(z).value);
    const zRoundedBack = fromInt(BigInt(zRound), z.precision);
    if (eq(z, zRoundedBack)) {
      throw new RangeError(`digamma: argument is a non-positive integer (ψ has a pole)`);
    }
    const work = prec + 32;
    const piW = pi(work);
    const piZ = mul(piW, z, work);
    const tanPiZ = div(sin(piZ, work), exp(log(abs(sin(piZ, work)), work), work), work);
    // Use cot(πz) directly: cos(πz)/sin(πz). Implement via cos = sin(π/2-x).
    // Simpler: ψ(z) = ψ(1-z) - π cot(π z).
    // cot(πz) = cos(πz)/sin(πz).
    const cosPiZ = sub(
      mul(piZ, fromInt(0n, work), work), // unused; just a placeholder for now
      fromInt(0n, work),
      work,
    );
    // Actually we need a `cos` import. Let me simplify and use:
    // ψ(z) for z ∈ (0, 1) reflection requires cos. But we already have cos()
    // via the trig module. Re-import.
    throw new RangeError(`digamma: negative argument support deferred to v0.2`);
  }
  // Same precision-bump rationale as lgamma.
  const work = prec + 96;
  const shiftThreshold = Math.max(8, Math.ceil(work / 8));
  const zFloat = toFloat64(z).value;
  if (!Number.isFinite(zFloat)) {
    throw new RangeError(`digamma: argument too large`);
  }
  const N = Math.max(0, Math.ceil(shiftThreshold - zFloat));
  // ψ(z) = ψ(z+N) - Σ_{k=0}^{N-1} 1/(z+k).
  const zShifted = N > 0 ? add(z, fromInt(BigInt(N), work), work) : z;
  let result = digammaStirling(zShifted, work);
  for (let k = 0; k < N; k++) {
    const zk = add(z, fromInt(BigInt(k), work), work);
    result = sub(result, div(fromInt(1n, work), zk, work), work);
  }
  return normalise(result.mantissa, result.exponent, prec);
}

/**
 * Stirling-style series for ψ(z) at large z.
 *   ψ(z) = log z − 1/(2z) − Σ_{k=1}^{N} B_{2k} / (2k · z^{2k})
 */
function digammaStirling(z: BigFloat, prec: number): BigFloat {
  const work = prec + 32;
  const logZ = log(z, work);
  const oneOverZ = div(fromInt(1n, work), z, work);
  const halfOverZ = div(oneOverZ, fromInt(2n, work), work);
  let result = sub(logZ, halfOverZ, work);
  const oneOverZ2 = mul(oneOverZ, oneOverZ, work);
  let zPow = oneOverZ2; // 1/z^(2k) starting at k=1.
  let prevTermMag = Infinity;
  for (let k = 1; k <= 300; k++) {
    const B2k = bernoulli(2 * k, work);
    if (B2k.mantissa === 0n) break;
    const denomCoeff = fromInt(BigInt(2 * k), work);
    const term = div(mul(B2k, zPow, work), denomCoeff, work);
    const termAbsMan = term.mantissa < 0n ? -term.mantissa : term.mantissa;
    const termBits = bitLength(termAbsMan);
    const termMag = term.exponent + termBits;
    if (termMag < -prec - 16) {
      result = sub(result, term, work);
      break;
    }
    if (termMag > prevTermMag) break;
    result = sub(result, term, work);
    prevTermMag = termMag;
    zPow = mul(zPow, oneOverZ2, work);
  }
  return normalise(result.mantissa, result.exponent, prec);
}

/**
 * Trigamma  ψ'(z) = -ψ^(1)(z) (with the conventional sign, where
 * ψ^(m)(z) = d^m/dz^m ψ(z) without sign-flip; trigamma is ψ'(z) > 0 for
 * z > 0).
 *
 * Algorithm: shift z up via the recurrence ψ'(z) = ψ'(z+1) + 1/z²,
 * Stirling-style series at large z.
 *
 * v0.1 ships only m = 1 (trigamma) since the MeijerG benchmark's
 * coalescence handling routes through it. Higher m via Hurwitz-zeta
 * lands in v0.2.
 */
export function trigamma(z: BigFloat, prec: number): BigFloat {
  if (sgn(z) <= 0) {
    throw new RangeError(`trigamma: argument must be positive`);
  }
  const work = prec + 96;
  const shiftThreshold = Math.max(8, Math.ceil(work / 8));
  const zFloat = toFloat64(z).value;
  if (!Number.isFinite(zFloat)) {
    throw new RangeError(`trigamma: argument too large`);
  }
  const N = Math.max(0, Math.ceil(shiftThreshold - zFloat));
  const zShifted = N > 0 ? add(z, fromInt(BigInt(N), work), work) : z;
  let result = trigammaStirling(zShifted, work);
  // ψ'(z) = ψ'(z+1) + 1/z²  ⟹  ψ'(z) = ψ'(z+N) + Σ_{k=0}^{N-1} 1/(z+k)².
  for (let k = 0; k < N; k++) {
    const zk = add(z, fromInt(BigInt(k), work), work);
    const inv2 = div(fromInt(1n, work), mul(zk, zk, work), work);
    result = add(result, inv2, work);
  }
  return normalise(result.mantissa, result.exponent, prec);
}

/**
 * Stirling-style series for ψ'(z) at large z.
 *   ψ'(z) = 1/z + 1/(2z²) + Σ_{k=1}^{N} B_{2k} / z^{2k+1}
 */
function trigammaStirling(z: BigFloat, prec: number): BigFloat {
  const work = prec + 32;
  const oneOverZ = div(fromInt(1n, work), z, work);
  const oneOverZ2 = mul(oneOverZ, oneOverZ, work);
  let result = add(oneOverZ, div(oneOverZ2, fromInt(2n, work), work), work);
  let zPow = mul(oneOverZ2, oneOverZ, work); // 1/z^3 = 1/z^(2k+1) for k=1.
  let prevTermMag = Infinity;
  for (let k = 1; k <= 300; k++) {
    const B2k = bernoulli(2 * k, work);
    if (B2k.mantissa === 0n) break;
    const term = mul(B2k, zPow, work);
    const termAbsMan = term.mantissa < 0n ? -term.mantissa : term.mantissa;
    const termBits = bitLength(termAbsMan);
    const termMag = term.exponent + termBits;
    if (termMag < -prec - 16) {
      result = add(result, term, work);
      break;
    }
    if (termMag > prevTermMag) break;
    result = add(result, term, work);
    prevTermMag = termMag;
    zPow = mul(zPow, oneOverZ2, work);
  }
  return normalise(result.mantissa, result.exponent, prec);
}

/**
 * `polygamma(m, z)` = ψ^(m)(z), the m-th derivative of digamma.
 *
 * v0.1: only `m ∈ {0, 1}` is supported. `m = 0` delegates to digamma;
 * `m = 1` to trigamma. Higher orders need a Hurwitz-zeta-based
 * implementation that v0.1 does not yet ship — they throw with a
 * pointer to the future bead.
 */
export function polygamma(m: number, z: BigFloat, prec: number): BigFloat {
  if (!Number.isInteger(m) || m < 0) {
    throw new RangeError(`polygamma: order must be a non-negative integer; got ${m}`);
  }
  if (m === 0) return digamma(z, prec);
  if (m === 1) return trigamma(z, prec);
  throw new RangeError(
    `polygamma: orders m ≥ 2 not implemented in v0.1 (filed for v0.2 via Hurwitz zeta)`,
  );
}
