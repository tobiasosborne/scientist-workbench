// =============================================================================
// @workbench/bigfloat — exact comparison + sign + abs + neg
// =============================================================================
//
// Comparison, abs, and neg operations are all *exact* — they never round and
// never take a precision argument. Two BigFloats represent the same real
// value if and only if their canonical forms agree; canonical form is what
// `normalise(...)` produces.
//
// The implementations below assume both operands satisfy the package
// invariants. Validation is the caller's responsibility (call `validate(a)`
// at the API boundary if needed; not on the hot path).

import type { BigFloat } from "./types.js";

/**
 * Sign of a BigFloat: -1 if negative, 0 if zero, +1 if positive.
 * Bit-deterministic across runtimes (BigInt comparison is exact).
 */
export function sgn(a: BigFloat): -1 | 0 | 1 {
  if (a.mantissa === 0n) return 0;
  return a.mantissa < 0n ? -1 : 1;
}

/**
 * Absolute value. Exact (no precision argument needed); preserves
 * `precision` and `exponent` fields.
 */
export function abs(a: BigFloat): BigFloat {
  if (a.mantissa < 0n) {
    return { mantissa: -a.mantissa, exponent: a.exponent, precision: a.precision };
  }
  return a;
}

/**
 * Negation. Exact; preserves `precision` and `exponent`.
 */
export function neg(a: BigFloat): BigFloat {
  if (a.mantissa === 0n) return a;
  return { mantissa: -a.mantissa, exponent: a.exponent, precision: a.precision };
}

/**
 * Three-way comparison. Returns -1 if a < b, 0 if a == b (as real values),
 * +1 if a > b. Exact — never rounds.
 *
 * Algorithm: handle sign first; for same-sign non-zero values, compare by
 * comparing `mantissa * 2^exponent` exactly. The trick: align the smaller-
 * exponent value's mantissa up by `(other.exponent - this.exponent)` bits
 * and compare the resulting integers.
 */
export function cmp(a: BigFloat, b: BigFloat): -1 | 0 | 1 {
  const sa = sgn(a);
  const sb = sgn(b);
  if (sa !== sb) return sa < sb ? -1 : 1;
  if (sa === 0) return 0;
  // Same sign, both non-zero. The sign of (a - b) equals sign of (|a| - |b|)
  // for positive a, b; equals -sign of (|a| - |b|) for negative.
  // Compute (|a| - |b|) by aligning exponents, then flip if both negative.
  let aMan = a.mantissa < 0n ? -a.mantissa : a.mantissa;
  let bMan = b.mantissa < 0n ? -b.mantissa : b.mantissa;
  if (a.exponent > b.exponent) {
    aMan = aMan << BigInt(a.exponent - b.exponent);
  } else if (b.exponent > a.exponent) {
    bMan = bMan << BigInt(b.exponent - a.exponent);
  }
  let result: -1 | 0 | 1;
  if (aMan < bMan) result = -1;
  else if (aMan > bMan) result = 1;
  else result = 0;
  return sa === -1 ? (-result as -1 | 0 | 1) : result;
}

export function eq(a: BigFloat, b: BigFloat): boolean {
  return cmp(a, b) === 0;
}
export function lt(a: BigFloat, b: BigFloat): boolean {
  return cmp(a, b) < 0;
}
export function le(a: BigFloat, b: BigFloat): boolean {
  return cmp(a, b) <= 0;
}
export function gt(a: BigFloat, b: BigFloat): boolean {
  return cmp(a, b) > 0;
}
export function ge(a: BigFloat, b: BigFloat): boolean {
  return cmp(a, b) >= 0;
}

/**
 * Test whether the represented value is exactly zero. Equivalent to
 * `sgn(a) === 0`; provided as a clarity helper.
 */
export function isZero(a: BigFloat): boolean {
  return a.mantissa === 0n;
}
