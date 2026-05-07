// =============================================================================
// @workbench/bigfloat — types, normalisation, validation
// =============================================================================
//
// A BigFloat is a triple `(mantissa, exponent, precision)` representing the
// real value `mantissa * 2^exponent` with `|mantissa|` constrained to have
// exactly `precision` bits. The constraint is invariant: every BigFloat
// produced by this package satisfies it; every operation re-establishes it.
// MPFR semantics, not mpmath ambient-precision semantics — see ADR-0020 for
// the rationale.
//
// Why per-value precision? Compositional clarity. Every operation takes its
// precision as an explicit argument; reading composed code reveals every
// precision decision at the call site. mpmath's `mp.prec` ambient state is
// invisible at use; MPFR's per-value precision is visible.
//
// Why mantissa as a signed BigInt? `BigInt` arithmetic is bit-identical
// across every JavaScript runtime by language specification — so the
// `arbprec: true` determinism contract (ADR-0020) is satisfied for free.
// The sign embedded in the mantissa keeps the type a flat triple rather
// than a `(sign, |mantissa|, exponent, precision)` quad.
//
// Special values
// --------------
// Zero is canonically `{mantissa: 0n, exponent: 0, precision: <any>}`. The
// precision field is metadata only when the mantissa is zero — every
// operation involving zero re-uses the precision target of the operation.
// NaN and ±∞ are not representable in this package; arithmetic at the
// boundary throws. Higher-level tools that need ∞ / NaN semantics handle
// them at the dispatch layer.

/**
 * An arbitrary-precision binary floating-point number.
 *
 * Invariants (every BigFloat satisfies all of these):
 * 1. `precision >= 1`.
 * 2. If `mantissa === 0n`, then `exponent === 0`. Zero has a canonical form.
 * 3. If `mantissa !== 0n`, then `|mantissa|` has exactly `precision` bits.
 *    Equivalently: the high bit of `|mantissa|` is set.
 * 4. The represented real value is `Number(mantissa) * 2 ** exponent`,
 *    interpreted exactly (not in float64 — both factors are arbitrary-
 *    precision conceptually).
 */
export interface BigFloat {
  readonly mantissa: bigint;
  readonly exponent: number;
  readonly precision: number;
}

/** Compute the bit length of a non-negative BigInt. */
export function bitLength(n: bigint): number {
  if (n === 0n) return 0;
  if (n < 0n) n = -n;
  // BigInt.toString(2) is well-defined and bit-deterministic across runtimes.
  return n.toString(2).length;
}

/**
 * Round-half-to-even normalisation. Takes a raw `(mantissa, exponent)` pair
 * and a target precision; returns a BigFloat satisfying the invariants.
 *
 * The rounding mode is round-half-to-even (banker's rounding), the IEEE-754
 * default. Ties (low bits equal to exactly half) round to the even neighbour.
 *
 * This is the load-bearing helper: every arithmetic operation in the package
 * computes a raw mantissa with potentially many more or fewer bits than the
 * target precision and finishes by calling `normalise(...)`.
 *
 * @param rawMantissa  signed BigInt; need not satisfy invariant (3)
 * @param rawExponent  the exponent of the represented value
 * @param targetPrecision  bits of precision the result should have
 */
export function normalise(
  rawMantissa: bigint,
  rawExponent: number,
  targetPrecision: number,
): BigFloat {
  if (targetPrecision < 1 || !Number.isInteger(targetPrecision)) {
    throw new RangeError(
      `BigFloat precision must be a positive integer; got ${targetPrecision}`,
    );
  }
  if (!Number.isFinite(rawExponent) || !Number.isInteger(rawExponent)) {
    throw new RangeError(
      `BigFloat exponent must be a finite integer; got ${rawExponent}`,
    );
  }
  if (rawMantissa === 0n) {
    return { mantissa: 0n, exponent: 0, precision: targetPrecision };
  }
  const negative = rawMantissa < 0n;
  let absMan = negative ? -rawMantissa : rawMantissa;
  let exp = rawExponent;
  const currentBits = bitLength(absMan);
  if (currentBits < targetPrecision) {
    // Pad: shift mantissa left, exponent down. No bits lost; no rounding.
    const shift = targetPrecision - currentBits;
    absMan = absMan << BigInt(shift);
    exp -= shift;
  } else if (currentBits > targetPrecision) {
    // Truncate with round-half-to-even. The discarded bits split into:
    //   high = top (currentBits - targetPrecision) bits we keep after
    //          interpreting as an integer.
    //   The bit at position (currentBits - targetPrecision - 1), counting
    //          from the LSB end, is the half-bit. The remaining low bits
    //          decide ties.
    const shift = currentBits - targetPrecision;
    const halfBit = 1n << BigInt(shift - 1);
    const lowMask = (1n << BigInt(shift)) - 1n;
    const low = absMan & lowMask;
    let high = absMan >> BigInt(shift);
    if (low > halfBit) {
      high += 1n;
    } else if (low === halfBit) {
      // exact tie: round to even
      if ((high & 1n) === 1n) high += 1n;
    }
    // Rounding-up may have grown the bit length by one (e.g. 0b1111 -> 0b10000).
    // Re-normalise once.
    if (bitLength(high) > targetPrecision) {
      high = high >> 1n;
      exp += 1;
    }
    absMan = high;
    exp += shift;
  }
  return {
    mantissa: negative ? -absMan : absMan,
    exponent: exp,
    precision: targetPrecision,
  };
}

/**
 * Validate that a BigFloat satisfies the package invariants. Returns the
 * value unchanged if valid; throws `BigFloatInvariantError` otherwise.
 *
 * Used in tests and at API boundaries; not on the hot path.
 */
export function validate(a: BigFloat): BigFloat {
  if (!Number.isInteger(a.precision) || a.precision < 1) {
    throw new BigFloatInvariantError(
      `precision must be a positive integer; got ${a.precision}`,
    );
  }
  if (!Number.isInteger(a.exponent) || !Number.isFinite(a.exponent)) {
    throw new BigFloatInvariantError(
      `exponent must be a finite integer; got ${a.exponent}`,
    );
  }
  if (a.mantissa === 0n) {
    if (a.exponent !== 0) {
      throw new BigFloatInvariantError(
        `zero mantissa must have exponent 0; got ${a.exponent}`,
      );
    }
    return a;
  }
  const bits = bitLength(a.mantissa);
  if (bits !== a.precision) {
    throw new BigFloatInvariantError(
      `non-zero mantissa must have exactly ${a.precision} bits; ` +
        `got ${bits} bits (${a.mantissa})`,
    );
  }
  return a;
}

export class BigFloatInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BigFloatInvariantError";
  }
}

/**
 * Convert decimal precision (digits) to binary precision (bits) with a
 * safety margin. Decimal digits is the user-facing dial (per ADR-0020);
 * bits is what the substrate uses internally.
 *
 * `bits = ceil(decimal * log2(10)) + safety` where `safety = 30` is a
 * conservative working-precision margin. log2(10) ≈ 3.3219.
 */
export function decimalToBinaryPrecision(decimal: number, safety = 30): number {
  if (!Number.isInteger(decimal) || decimal < 1) {
    throw new RangeError(
      `decimal precision must be a positive integer; got ${decimal}`,
    );
  }
  // Use the high-precision approximation 3.32192809488736 = log2(10) to 14 dp;
  // the safety margin absorbs any sub-bit error in this conversion.
  return Math.ceil(decimal * 3.32192809488736) + safety;
}
