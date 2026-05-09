// =============================================================================
// @workbench/bigfloat — core arithmetic at user-specified precision
// =============================================================================
//
// The four-operations + sqrt. Each takes an explicit `prec` argument
// (binary bits, not decimal digits) and rounds the result to that precision
// via `normalise(...)` (round-half-to-even).
//
// Algorithm shapes:
//
//   add(a, b, prec): align exponents (shift the larger-exponent value's
//                    mantissa up so both share the smaller exponent),
//                    add as BigInts, normalise.
//
//   sub(a, b, prec): add(a, neg(b), prec). Negation is exact, so subtraction
//                    inherits add's correctness.
//
//   mul(a, b, prec): mantissa product, exponent sum, normalise.
//
//   div(a, b, prec): shift the dividend left by enough working bits to give
//                    `prec + safety` bits of quotient, integer-divide, set
//                    sticky bit from remainder, normalise.
//
//   sqrt(a, prec):   shift the radicand mantissa left by `2*prec + safety`
//                    bits (with the exponent absorbing a /2), Newton-iterate
//                    on the integer square root, normalise. Negative input
//                    throws (caller wanting complex sqrt uses BigComplex).
//
// All operations preserve the bit-determinism invariant (BigInt arithmetic
// is bit-identical across runtimes by language spec), so the resulting
// `tools/<arbprec-tool>` outputs are bit-identical cross-platform.

import { BigFloat, normalise, bitLength } from "./types.js";
import { neg } from "./comparison.js";

/**
 * Sum of two BigFloats at the requested precision.
 *
 * Algorithm: align exponents to the smaller of the two; add aligned
 * mantissas (BigInt addition is exact); normalise.
 */
export function add(a: BigFloat, b: BigFloat, prec: number): BigFloat {
  if (a.mantissa === 0n) return normalise(b.mantissa, b.exponent, prec);
  if (b.mantissa === 0n) return normalise(a.mantissa, a.exponent, prec);
  let aMan = a.mantissa;
  let bMan = b.mantissa;
  let exp: number;
  if (a.exponent >= b.exponent) {
    aMan = aMan << BigInt(a.exponent - b.exponent);
    exp = b.exponent;
  } else {
    bMan = bMan << BigInt(b.exponent - a.exponent);
    exp = a.exponent;
  }
  return normalise(aMan + bMan, exp, prec);
}

export function sub(a: BigFloat, b: BigFloat, prec: number): BigFloat {
  return add(a, neg(b), prec);
}

/**
 * Product. Mantissa = a.man * b.man (exact BigInt); exponent = sum.
 */
export function mul(a: BigFloat, b: BigFloat, prec: number): BigFloat {
  if (a.mantissa === 0n || b.mantissa === 0n) {
    return { mantissa: 0n, exponent: 0, precision: prec };
  }
  return normalise(a.mantissa * b.mantissa, a.exponent + b.exponent, prec);
}

/**
 * Quotient at the requested precision. Throws on division by zero.
 *
 * Algorithm: shift the dividend up by enough working bits so that the
 * integer quotient `(a.man << workingBits) / b.man` carries at least
 * `prec + safety` bits, integer-divide, OR a sticky bit from the remainder,
 * normalise. The sticky bit is what ensures correct round-half-to-even on
 * lossy divisions: it makes the discarded part strictly greater than half
 * if and only if the *true* discarded part is greater than half.
 *
 * Sizing the shift — the worklog-077 / `djp` fix
 * ----------------------------------------------
 *
 * The integer quotient `q = (aAbs << w) / bAbs` has bit length roughly
 * `bitLength(aAbs) + w - bitLength(bAbs)`. To deliver a quotient mantissa
 * with at least `prec + safety` honest bits, the shift `w` must satisfy
 *
 *     w ≥ prec + safety + bitLength(bAbs) − bitLength(aAbs).
 *
 * The original implementation used `w = prec + 32` unconditionally — which
 * is correct iff `bitLength(aAbs) ≥ bitLength(bAbs)`. When the dividend's
 * mantissa is shorter than the divisor's (the canonical case: `fromInt(1n)`
 * with the substrate's 53-bit default precision attribute, divided by a
 * 200-bit divisor at `prec = 200`), the integer quotient comes out short,
 * and `normalise` zero-pads it on the right to satisfy the `bitLength ==
 * precision` invariant. The result *looks* fully precise — the
 * `precision` field is `prec`, the mantissa has exactly `prec` bits — but
 * its trailing bits are zeros, not honest digits of the quotient. Worklog
 * 077 diagnosed this as the "silent precision floor" that bit tanh-sinh
 * harder than Gauss-Kronrod (tanh-sinh divides inside the integrand
 * evaluation; G7K15 does not).
 *
 * The fix is to make `w` track the bit-length differential when the
 * divisor is the longer mantissa, while never *reducing* the shift below
 * the original `prec + 32` floor (so the existing 229-test suite remains
 * byte-identical for every call where the dividend was already ≥ as long
 * as the divisor — which covers every existing call site that respects
 * the integrand contract documented in `tanh-sinh-bf.ts`). Concretely:
 *
 *     w = prec + safety + max(0, bitLength(bAbs) − bitLength(aAbs)).
 *
 * Equivalently: `w = max(prec + safety, prec + safety + denBits − numBits)`.
 *
 * Determinism contract (ADR-0020) is preserved: `bitLength` on a `bigint`
 * is bit-deterministic across runtimes by language specification, so the
 * fix introduces no platform-conditional behaviour. Same input bytes →
 * same `w` → same `q`/`r` → same canonical output bytes, on any runtime
 * and any platform, forever.
 */
export function div(a: BigFloat, b: BigFloat, prec: number): BigFloat {
  if (b.mantissa === 0n) {
    throw new RangeError("BigFloat: division by zero");
  }
  if (a.mantissa === 0n) {
    return { mantissa: 0n, exponent: 0, precision: prec };
  }
  // Sign of result = sign of (a.man * b.man); split sign from magnitude.
  const aSign = a.mantissa < 0n ? -1n : 1n;
  const bSign = b.mantissa < 0n ? -1n : 1n;
  const signResult = aSign * bSign;
  const aAbs = aSign === -1n ? -a.mantissa : a.mantissa;
  const bAbs = bSign === -1n ? -b.mantissa : b.mantissa;
  // Working bits: enough to cover the target precision plus a 32-bit
  // safety margin for round-to-even ambiguity, *plus* a compensating term
  // when the divisor's mantissa is the longer of the two. See the
  // function's prose for the derivation. The compensating term is zero
  // for the `numBits ≥ denBits` case, preserving every previous call's
  // working-bit count and therefore its byte-identical output.
  const numBits = bitLength(aAbs);
  const denBits = bitLength(bAbs);
  const lengthCompensation = denBits > numBits ? denBits - numBits : 0;
  const workingBits = prec + 32 + lengthCompensation;
  // We want q ≈ (a.man * 2^workingBits) / b.man, with sticky-bit handling.
  const num = aAbs << BigInt(workingBits);
  const q = num / bAbs;
  const r = num - q * bAbs;
  const qWithSticky = r === 0n ? q : q | 1n;
  // Resulting value: signResult * q * 2^(a.exp - b.exp - workingBits).
  return normalise(
    signResult * qWithSticky,
    a.exponent - b.exponent - workingBits,
    prec,
  );
}

/**
 * Square root at the requested precision. Throws on negative input — the
 * caller wanting a complex sqrt should use `BigComplex.sqrt`.
 *
 * Algorithm: ensure the working mantissa has at least `2*prec + safety`
 * bits, with the exponent adjusted so that the integer-square-root of the
 * mantissa gives a result with `prec + safety/2` bits. Then Newton-iterate
 * to obtain the exact integer square root (with rounding).
 *
 * Newton iteration on integer sqrt is the standard textbook algorithm; it
 * converges quadratically and the integer-arithmetic guard makes it
 * round-correct.
 */
export function sqrt(a: BigFloat, prec: number): BigFloat {
  if (a.mantissa < 0n) {
    throw new RangeError(`BigFloat.sqrt: negative argument (${a.mantissa})`);
  }
  if (a.mantissa === 0n) {
    return { mantissa: 0n, exponent: 0, precision: prec };
  }
  // To get `prec` bits of precision in sqrt, the working mantissa needs
  // 2*prec + safety bits. We may also need to pre-multiply by 2 to make
  // the resulting exponent even.
  const safety = 32;
  const targetWorkingBits = 2 * prec + safety;
  let workMan = a.mantissa;
  let workExp = a.exponent;
  const currentBits = bitLength(workMan);
  if (currentBits < targetWorkingBits) {
    const shift = targetWorkingBits - currentBits;
    workMan = workMan << BigInt(shift);
    workExp -= shift;
  }
  // Ensure workExp is even (sqrt of 2^odd needs a half-power; we absorb
  // by shifting the mantissa up by one and decrementing the exponent).
  if (workExp % 2 !== 0) {
    workMan = workMan << 1n;
    workExp -= 1;
  }
  // Now compute integer sqrt of workMan via Newton iteration.
  const sqrtMan = isqrt(workMan);
  // The sqrt's exponent is workExp / 2.
  const sqrtExp = workExp / 2;
  // The integer sqrt may be off by < 1 in the last bit; the sticky-bit
  // trick: if sqrtMan^2 < workMan, we have a non-zero residual that should
  // bias rounding upward. OR a sticky bit accordingly.
  const residual = workMan - sqrtMan * sqrtMan;
  const finalMan = residual === 0n ? sqrtMan : sqrtMan | 1n;
  return normalise(finalMan, sqrtExp, prec);
}

/**
 * Integer square root of a non-negative BigInt. Returns the largest q
 * such that q*q ≤ n. Newton iteration with integer initial guess.
 */
function isqrt(n: bigint): bigint {
  if (n < 0n) throw new RangeError("isqrt: negative argument");
  if (n < 2n) return n;
  // Initial guess: 2^(ceil(bitLen/2)).
  const bits = bitLength(n);
  let q = 1n << BigInt((bits + 1) >> 1);
  // Newton: q_{k+1} = (q_k + n/q_k) / 2. Stops when not decreasing.
  while (true) {
    const qNext = (q + n / q) >> 1n;
    if (qNext >= q) {
      // q is a fixed point or growing — return q (the textbook result).
      return q;
    }
    q = qNext;
  }
}

/**
 * Exponentiation by an integer power. Exact when |power| is small;
 * otherwise normalised to `prec`.
 *
 * Algorithm: square-and-multiply on the integer power. Negative powers are
 * a single division at the end.
 */
export function powInt(a: BigFloat, n: number, prec: number): BigFloat {
  if (!Number.isInteger(n)) {
    throw new RangeError(`powInt: exponent must be integer; got ${n}`);
  }
  if (n === 0) {
    if (a.mantissa === 0n) {
      // 0^0 is conventionally 1 in many CAS environments; we follow that.
    }
    return { mantissa: 1n << BigInt(prec - 1), exponent: -(prec - 1), precision: prec };
  }
  if (a.mantissa === 0n) {
    if (n < 0) throw new RangeError("BigFloat.powInt: 0 to a negative power");
    return { mantissa: 0n, exponent: 0, precision: prec };
  }
  let absN = Math.abs(n);
  let base: BigFloat = a;
  // Initial result = 1 (will be replaced by `base` on first odd bit).
  let result: BigFloat | null = null;
  // Use slightly more working precision than `prec` to absorb compounding rounding.
  const work = prec + 16;
  while (absN > 0) {
    if ((absN & 1) === 1) {
      result = result === null ? base : mul(result, base, work);
    }
    absN >>>= 1;
    if (absN > 0) {
      base = mul(base, base, work);
    }
  }
  if (result === null) {
    // unreachable: absN > 0 was checked above
    throw new Error("BigFloat.powInt: internal error");
  }
  if (n < 0) {
    const one = { mantissa: 1n << BigInt(work - 1), exponent: -(work - 1), precision: work };
    result = div(one, result, work);
  }
  return normalise(result.mantissa, result.exponent, prec);
}
