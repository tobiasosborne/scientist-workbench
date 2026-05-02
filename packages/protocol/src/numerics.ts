// Numeric primitives shared across the protocol package — and exported
// for downstream packages (cas-core's `rat.ts`) that would otherwise
// re-implement them.
//
// These three values are *load-bearing for the canonical encoding*.
// `INT_RE` and `F64_BITS_RE` define what the protocol calls a
// well-formed integer-string and float64-bits-string respectively;
// `gcdBigInt` is the reduction step that puts every `RationalValue`
// into lowest terms. Drift between two copies of any of them would
// quietly corrupt the wire format — a `RationalValue` could fail to
// match the regex used by the *other* validator, an integer-string
// produced by one site could be rejected by the next. This file is
// the single source so that drift is structurally impossible.

/**
 * Canonical integer-string regex.
 *
 * Matches: `0`, a positive decimal with no leading zero, or any of
 * the above prefixed by `-`. Rejects: leading zeros (`07`), the
 * empty string, and `-0`. Used by `IntegerValue.value`,
 * `RationalValue.num`, and `RationalValue.den`.
 */
export const INT_RE = /^-?(0|[1-9][0-9]*)$/;

/**
 * Canonical float64 bit-pattern regex: exactly 16 lowercase hex
 * digits encoding big-endian IEEE-754 binary64. Used by
 * `Float64Value.bits`. Rejects mixed-case, shorter / longer strings,
 * and any non-hex character.
 */
export const F64_BITS_RE = /^[0-9a-f]{16}$/;

/**
 * Greatest common divisor over the integers, returned as a positive
 * `bigint`. By convention `gcd(0, 0) = 0`. Used to canonicalise
 * rationals into lowest terms — `RationalValue` requires
 * `gcd(num, den) = 1` and `den > 0`, and that invariant is checked
 * by `validateValue` and established by `rat()` and `makeRat()`.
 *
 * Implemented by Euclid's algorithm on bigints. Pure; no allocation
 * beyond the bigint arithmetic itself.
 */
export function gcdBigInt(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) {
    const t = x % y;
    x = y;
    y = t;
  }
  return x;
}
