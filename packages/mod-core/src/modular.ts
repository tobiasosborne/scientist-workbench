// Generic modular arithmetic over bigint. No dependence on a specific modulus.
// Used by tools/mod-pow and tools/mod-inv. NTT-internal modular work uses
// Montgomery reduction in ntt.ts; that's a separate fast-path layer.

/**
 * Modular exponentiation: base^exp mod modulus.
 *
 * - modulus must be ≥ 1.
 * - exp must be ≥ 0.
 * - Result is the canonical residue in [0, modulus).
 *
 * Throws on illegal arguments. Negative bases are reduced modulo `modulus`
 * up front, so `modPow(-1n, 3n, 5n) === 4n`.
 */
export function modPow(base: bigint, exp: bigint, modulus: bigint): bigint {
  if (modulus < 1n) throw new RangeError(`modPow: modulus must be ≥ 1 (got ${modulus})`);
  if (exp < 0n) throw new RangeError(`modPow: exponent must be ≥ 0 (got ${exp}); use mod-inv first if you want a negative power`);
  if (modulus === 1n) return 0n;
  let r = 1n;
  let b = base % modulus;
  if (b < 0n) b += modulus;
  let e = exp;
  while (e > 0n) {
    if ((e & 1n) === 1n) r = (r * b) % modulus;
    b = (b * b) % modulus;
    e >>= 1n;
  }
  return r;
}

export interface ModInvResult {
  /** True iff `value` is invertible modulo `modulus` (i.e. gcd(value, modulus) = 1). */
  readonly invertible: boolean;
  /** The inverse, in [0, modulus), when `invertible`. Else `null`. */
  readonly inverse: bigint | null;
  /** gcd(|value|, modulus). When ≠ 1, the value is not invertible. */
  readonly gcd: bigint;
}

/**
 * Modular inverse via the extended Euclidean algorithm. Works for any
 * modulus (no primality assumption); returns `{invertible: false}` when
 * gcd(value, modulus) ≠ 1.
 *
 * - modulus must be ≥ 1.
 * - If `value` is negative, its inverse is computed modulo `modulus` and
 *   returned in [0, modulus).
 * - For modulus = 1, every value is "≡ 0 (mod 1)" — there is no
 *   meaningful inverse; we return `{invertible: false, gcd: 1n}` to keep
 *   the contract simple. Callers should guard against modulus = 1.
 */
export function modInv(value: bigint, modulus: bigint): ModInvResult {
  if (modulus < 1n) throw new RangeError(`modInv: modulus must be ≥ 1 (got ${modulus})`);
  if (modulus === 1n) {
    // The only residue is 0; inverse is undefined. Caller-visible contract:
    // not invertible, gcd reported as 1 (since gcd(anything, 1) = 1, but the
    // ring is the zero ring and has no units worth naming).
    return { invertible: false, inverse: null, gcd: 1n };
  }
  // Extended Euclid on (a, m) where a = value mod m.
  let a = value % modulus;
  if (a < 0n) a += modulus;
  let old_r = a, r = modulus;
  let old_s = 1n, s = 0n;
  while (r !== 0n) {
    const q = old_r / r;
    [old_r, r] = [r, old_r - q * r];
    [old_s, s] = [s, old_s - q * s];
  }
  const g = old_r;
  if (g !== 1n) return { invertible: false, inverse: null, gcd: g };
  let inv = old_s % modulus;
  if (inv < 0n) inv += modulus;
  return { invertible: true, inverse: inv, gcd: 1n };
}
