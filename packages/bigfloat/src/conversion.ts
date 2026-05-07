// =============================================================================
// @workbench/bigfloat — conversion to/from native JS numerics
// =============================================================================
//
// Every BigFloat operation eventually crosses the boundary into native
// JavaScript types. The conversions live here:
//
//   fromInt        — exact (a JS bigint or safe-integer Number)
//   fromFloat64    — exact (every finite float64 has an exact binary
//                    expansion fitting in 53 bits + an exponent in [-1074, 1023])
//   fromRational   — round-to-precision (the conversion that *can* round)
//   fromString     — round-to-precision (parses a decimal string)
//   toString       — round-to-N decimal digits (for human output)
//   toFloat64      — round to nearest float64 (best-effort with overflow flag)
//
// The exact conversions never take a precision argument. The lossy ones
// always do, and they round-half-to-even via `normalise(...)`.

import { BigFloat, normalise, bitLength } from "./types.js";

/**
 * Convert a JS bigint or safe integer to a BigFloat. Exact — the value is
 * representable without loss, regardless of the precision argument's
 * working precision (the result will simply have enough bits to encode
 * the integer plus padding to `precision`).
 */
export function fromInt(n: bigint | number, precision = 53): BigFloat {
  let big: bigint;
  if (typeof n === "number") {
    if (!Number.isInteger(n) || !Number.isFinite(n)) {
      throw new RangeError(`fromInt expects a safe integer; got ${n}`);
    }
    big = BigInt(n);
  } else {
    big = n;
  }
  if (big === 0n) {
    return { mantissa: 0n, exponent: 0, precision };
  }
  // Strip trailing zero bits to obtain a canonical (oddMantissa, exp) pair.
  // Then `normalise` will pad / round as needed.
  let absBig = big < 0n ? -big : big;
  let exp = 0;
  while ((absBig & 1n) === 0n) {
    absBig >>= 1n;
    exp += 1;
  }
  const sign = big < 0n ? -1n : 1n;
  return normalise(sign * absBig, exp, precision);
}

/**
 * Convert a finite float64 to a BigFloat. Exact: every finite IEEE-754
 * binary64 has an exact binary expansion; we extract the (sign, mantissa,
 * exponent) triple and rebuild as a BigFloat at sufficient precision.
 *
 * NaN and ±Inf throw — they are not representable in this package.
 */
export function fromFloat64(x: number): BigFloat {
  if (!Number.isFinite(x)) {
    throw new RangeError(`fromFloat64 expects a finite number; got ${x}`);
  }
  if (x === 0) {
    return { mantissa: 0n, exponent: 0, precision: 53 };
  }
  // Disassemble the float64 bit pattern.
  const buf = new ArrayBuffer(8);
  new Float64Array(buf)[0] = x;
  const u32 = new Uint32Array(buf);
  const lo = u32[0]!;
  const hi = u32[1]!;
  const sign = (hi & 0x80000000) !== 0 ? -1n : 1n;
  const expRaw = (hi >>> 20) & 0x7ff;
  const fracHi = hi & 0xfffff;
  const fracBigPart = (BigInt(fracHi) << 32n) | BigInt(lo);
  let mantissaUnsigned: bigint;
  let unbiasedExp: number;
  if (expRaw === 0) {
    // Subnormal. No implicit leading 1; mantissa is the fraction bits.
    if (fracBigPart === 0n) {
      // We checked x === 0 above, so this is unreachable.
      return { mantissa: 0n, exponent: 0, precision: 53 };
    }
    mantissaUnsigned = fracBigPart;
    unbiasedExp = 1 - 1023 - 52; // == -1074
  } else {
    // Normal. Implicit leading 1.
    mantissaUnsigned = (1n << 52n) | fracBigPart;
    unbiasedExp = expRaw - 1023 - 52;
  }
  // Strip trailing zero bits to canonicalise.
  while ((mantissaUnsigned & 1n) === 0n && mantissaUnsigned !== 0n) {
    mantissaUnsigned >>= 1n;
    unbiasedExp += 1;
  }
  // Bit length of the stripped mantissa is the precision; for a normalised
  // float this is in [1, 53]. We use that as the BigFloat precision so the
  // representation is exact and minimally normalised.
  const prec = bitLength(mantissaUnsigned);
  return normalise(sign * mantissaUnsigned, unbiasedExp, prec);
}

/**
 * Best-effort conversion to a JS float64, with overflow / underflow
 * reporting. Returns `{value, overflow}`:
 *
 * - If |a| ≥ 2^1024, returns `{value: ±Infinity, overflow: "overflow"}`.
 * - If |a| < 2^-1074 and a !== 0, returns `{value: ±0, overflow: "underflow"}`.
 * - Otherwise returns `{value: <best float64 approximation>, overflow: null}`.
 *
 * The float64 result is the nearest representable double per round-half-
 * to-even.
 */
export function toFloat64(a: BigFloat): {
  value: number;
  overflow: null | "overflow" | "underflow";
} {
  if (a.mantissa === 0n) return { value: 0, overflow: null };
  // Rebuild a 53-bit-precision BigFloat by re-rounding `a` to 53 bits.
  // Then assemble the float64 bit pattern.
  const rounded = normalise(a.mantissa, a.exponent, 53);
  const negative = rounded.mantissa < 0n;
  let absMan = negative ? -rounded.mantissa : rounded.mantissa;
  let exp = rounded.exponent;
  // After normalise to 53 bits, |absMan| has exactly 53 bits set with
  // top bit = 1. The IEEE-754 binary64 format wants the implicit leading
  // 1 stripped, leaving a 52-bit fraction.
  // Currently: absMan ∈ [2^52, 2^53), exp is the binary exponent.
  // The "biased exponent" expected by float64 = exp + 52 + 1023 = exp + 1075.
  let biased = exp + 1075;
  if (biased >= 0x7ff) {
    return {
      value: negative ? -Infinity : Infinity,
      overflow: "overflow",
    };
  }
  if (biased <= 0) {
    // Subnormal range. Need to shift the mantissa right by (1 - biased) bits.
    const shift = 1 - biased;
    if (shift > 53) {
      return {
        value: negative ? -0 : 0,
        overflow: "underflow",
      };
    }
    // Re-round to subnormal precision.
    const halfBit = 1n << BigInt(shift - 1);
    const lowMask = (1n << BigInt(shift)) - 1n;
    const low = absMan & lowMask;
    let high = absMan >> BigInt(shift);
    if (low > halfBit) {
      high += 1n;
    } else if (low === halfBit) {
      if ((high & 1n) === 1n) high += 1n;
    }
    absMan = high;
    biased = 0;
    if (absMan === 0n) {
      return { value: negative ? -0 : 0, overflow: "underflow" };
    }
  } else {
    // Normal: strip the implicit leading 1.
    absMan = absMan & ((1n << 52n) - 1n);
  }
  const buf = new ArrayBuffer(8);
  const u32 = new Uint32Array(buf);
  const lo = Number(absMan & 0xffffffffn);
  const hi = Number((absMan >> 32n) & 0xfffffn) | (biased << 20) | (negative ? 0x80000000 : 0);
  u32[0] = lo;
  u32[1] = hi >>> 0;
  return { value: new Float64Array(buf)[0]!, overflow: null };
}

/**
 * Convert a BigFloat to a decimal string with `digits` significant figures.
 *
 * The output is in scientific notation when the value's magnitude is far
 * from 1, plain decimal otherwise (the boundaries are picked to match
 * mpmath's defaults: scientific if exponent ≥ digits or exponent ≤ -5).
 *
 * Round-half-to-even via integer arithmetic on BigInt — no float64 in the
 * path, so the result is bit-deterministic.
 */
export function toString(a: BigFloat, digits = 15): string {
  if (digits < 1 || !Number.isInteger(digits)) {
    throw new RangeError(`toString digits must be a positive integer; got ${digits}`);
  }
  if (a.mantissa === 0n) {
    if (digits === 1) return "0";
    return `0.${"0".repeat(digits - 1)}`;
  }
  const negative = a.mantissa < 0n;
  const absMan = negative ? -a.mantissa : a.mantissa;
  // Compute the value as a decimal mantissa with `digits + extra` significant
  // figures, then round to `digits`. The extra margin absorbs any error in
  // the binary→decimal conversion.
  const extra = 4;
  // Find decimal exponent k such that 10^(k-1) ≤ |a| < 10^k.
  // |a| = absMan * 2^exponent, so log10(|a|) = log10(absMan) + exponent * log10(2).
  // We want digits10 = k such that the decimal mantissa is integer with
  // exactly `digits + extra` digits.
  // Strategy: compute m * 10^(digits+extra-1) / |a| = ... no easier:
  //
  //   We want   absMan * 2^exponent  =  D * 10^(decExp - digits - extra + 1)
  //   where D is a (digits+extra)-digit integer.
  //
  // Rearranging:  D = absMan * 2^exponent * 10^(digits+extra-1-decExp).
  //
  // Pick decExp = floor(log10(|a|)) + 1 (so D is just under 10^(digits+extra)).
  // Use BigInt math for the conversion.
  const log10_2 = Math.log10(2);
  const log10_absMan_approx = absMan.toString().length - 1; // crude floor(log10(absMan))
  const log10_value_approx =
    Math.floor(log10_absMan_approx + a.exponent * log10_2);
  // We want: D ≈ |a| * 10^(digits+extra-1-decExp), so D has digits+extra digits.
  // decExp is chosen so that 10^(decExp-1) ≤ |a| < 10^decExp.
  // First-cut decExp: log10_value_approx + 1.
  let decExp = log10_value_approx + 1;
  const totalDigits = digits + extra;
  // Compute D = absMan * 2^exponent * 10^(totalDigits - decExp)  (as BigInt, exactly).
  const targetExp = totalDigits - decExp;
  // numerator = absMan; multiplier = 10^targetExp if positive, else divide.
  let D: bigint;
  if (targetExp >= 0) {
    // D = absMan * 2^exponent * 10^targetExp
    if (a.exponent >= 0) {
      D = absMan * (1n << BigInt(a.exponent)) * 10n ** BigInt(targetExp);
    } else {
      // D = absMan * 10^targetExp / 2^(-exponent)  with rounding
      const num = absMan * 10n ** BigInt(targetExp);
      const den = 1n << BigInt(-a.exponent);
      D = roundDiv(num, den);
    }
  } else {
    // 10^targetExp is fractional; multiply absMan * 2^exp / 10^(-targetExp)
    if (a.exponent >= 0) {
      const num = absMan * (1n << BigInt(a.exponent));
      const den = 10n ** BigInt(-targetExp);
      D = roundDiv(num, den);
    } else {
      const num = absMan;
      const den = (1n << BigInt(-a.exponent)) * 10n ** BigInt(-targetExp);
      D = roundDiv(num, den);
    }
  }
  // D may need a one-shot decExp correction — log10 approximation can be off
  // by 1.
  const tenPowTotal = 10n ** BigInt(totalDigits);
  if (D >= tenPowTotal) {
    D = roundDiv(D, 10n);
    decExp += 1;
  } else if (D < tenPowTotal / 10n) {
    D = D * 10n;
    decExp -= 1;
  }
  // Round D to `digits` significant digits (drop the `extra` trailing).
  const tenExtra = 10n ** BigInt(extra);
  const halfTen = tenExtra / 2n;
  const rem = D % tenExtra;
  let rounded = D / tenExtra;
  if (rem > halfTen) {
    rounded += 1n;
  } else if (rem === halfTen) {
    if ((rounded & 1n) === 1n) rounded += 1n;
  }
  // Rounding-up may have grown to `digits + 1` digits.
  if (rounded >= 10n ** BigInt(digits)) {
    rounded = rounded / 10n;
    decExp += 1;
  }
  let mantStr = rounded.toString();
  // Pad on the left if `rounded` happens to be smaller than expected (rare
  // but safe).
  if (mantStr.length < digits) {
    mantStr = "0".repeat(digits - mantStr.length) + mantStr;
  }
  // Format. Use scientific if decExp ≥ digits or decExp ≤ -5 (mpmath default).
  // Otherwise use plain.
  const signStr = negative ? "-" : "";
  if (decExp > digits || decExp <= -5) {
    // Scientific: D.DDDDe±NN
    const intDigit = mantStr[0]!;
    const fracDigits = digits > 1 ? mantStr.slice(1) : "";
    const expSign = decExp - 1 >= 0 ? "+" : "-";
    const expAbs = Math.abs(decExp - 1).toString();
    return `${signStr}${intDigit}${digits > 1 ? "." + fracDigits : ""}e${expSign}${expAbs}`;
  }
  // Plain decimal: place the decimal point after `decExp` integer digits.
  if (decExp <= 0) {
    // 0.000...DDD
    return `${signStr}0.${"0".repeat(-decExp)}${mantStr}`;
  }
  if (decExp >= digits) {
    // DDD000... (no fractional part); pad with trailing zeros.
    return `${signStr}${mantStr}${"0".repeat(decExp - digits)}`;
  }
  // Decimal point in the middle.
  return `${signStr}${mantStr.slice(0, decExp)}.${mantStr.slice(decExp)}`;
}

/**
 * Banker's-rounded integer division of non-negative BigInts.
 * Returns floor(num/den) rounded half-to-even.
 */
function roundDiv(num: bigint, den: bigint): bigint {
  if (den <= 0n) {
    throw new RangeError(`roundDiv denominator must be positive; got ${den}`);
  }
  const q = num / den;
  const r = num - q * den;
  const twiceR = r * 2n;
  if (twiceR > den) return q + 1n;
  if (twiceR < den) return q;
  // tie: round to even
  return (q & 1n) === 1n ? q + 1n : q;
}

/**
 * Parse a decimal string like `"1.5"`, `"-3.14e-2"`, `"42"` into a BigFloat
 * at the given binary precision. Round-half-to-even.
 *
 * Accepts the grammar:  `[+-]? (\d+ ('.' \d*)? | '.' \d+) ([eE] [+-]? \d+)?`
 *
 * Whitespace is not stripped — caller's responsibility.
 */
export function fromString(s: string, precision: number): BigFloat {
  const m = /^([+-]?)(\d+)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$|^([+-]?)\.(\d+)(?:[eE]([+-]?\d+))?$/.exec(s);
  if (!m) {
    throw new RangeError(`fromString: cannot parse "${s}" as a decimal`);
  }
  let sign: bigint;
  let intPart: string;
  let fracPart: string;
  let expStr: string | undefined;
  if (m[1] !== undefined) {
    sign = m[1] === "-" ? -1n : 1n;
    intPart = m[2]!;
    fracPart = m[3] ?? "";
    expStr = m[4];
  } else {
    sign = m[5] === "-" ? -1n : 1n;
    intPart = "";
    fracPart = m[6]!;
    expStr = m[7];
  }
  const decExp = expStr !== undefined ? parseInt(expStr, 10) : 0;
  // Combined integer mantissa = (intPart + fracPart), interpret as BigInt.
  // Decimal exponent = decExp - fracPart.length.
  const combined = intPart + fracPart;
  if (combined.length === 0) {
    throw new RangeError(`fromString: cannot parse "${s}" as a decimal`);
  }
  // Strip leading zeros for BigInt parsing.
  let bigCombined = BigInt(combined);
  if (bigCombined === 0n) {
    return { mantissa: 0n, exponent: 0, precision };
  }
  const decimalShift = decExp - fracPart.length;
  // Value = bigCombined * 10^decimalShift.
  // Convert to (mantissa, exponent_2): mantissa = bigCombined * 10^decimalShift
  // when decimalShift >= 0; else mantissa = bigCombined / 10^(-decimalShift)
  // with appropriate rounding via the normaliser.
  if (decimalShift >= 0) {
    const exact = bigCombined * 10n ** BigInt(decimalShift);
    return fromInt(sign * exact, precision);
  }
  // Need to compute bigCombined / 10^k at the requested binary precision.
  const k = -decimalShift;
  const den = 10n ** BigInt(k);
  // Pick a working number of bits sufficient to recover `precision` bits
  // post-division. We shift the numerator left by `precision + 64` bits
  // before integer-dividing to give plenty of room.
  const workingBits = precision + 64;
  const numShifted = bigCombined << BigInt(workingBits);
  const q = numShifted / den;
  const r = numShifted - q * den;
  // Use the remainder to set a sticky bit for round-to-nearest-even.
  // We pass `q` (mostly) into normalise with an offset exponent and rely on
  // normalise's rounding. The remainder being non-zero biases the rounding
  // slightly: if `r` is non-zero, the value is strictly larger than `q *
  // 2^-workingBits * 10^k * sign`. To capture that, we OR a sticky bit into
  // the LSB of q if r > 0 (this affects the round-half-to-even decision
  // when q's discarded low bits are exactly half — rare in practice).
  const qWithSticky = r === 0n ? q : q | 1n;
  return normalise(sign * qWithSticky, -workingBits, precision);
}
