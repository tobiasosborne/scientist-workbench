// =============================================================================
// dense.ts — dense univariate ℤ[x] polynomial primitives for VAS-LMQ
// =============================================================================
//
// Convention: a polynomial is `bigint[]` with high-to-low coefficients.
// `[c_n, c_{n-1}, ..., c_0]` represents `c_n·x^n + … + c_0`. The empty
// array is the zero polynomial. Leading-zero coefficients are stripped
// in canonical form (top of array is non-zero).
//
// The high-to-low convention matches SymPy's `dup_*` family
// (`sympy/polys/densetools.py`), which is the BSD-licensed reference
// the VAS-LMQ port follows line-by-line. A TS-native low-to-high
// representation would force every line of the port to flip indices
// — a multiplier of bug surface for a routine cosmetic gain. Match
// the source.
//
// All arithmetic is over ℤ (BigInt). VAS-LMQ enters with an integer-
// coefficient polynomial — `clearDenominators` is the only ℚ → ℤ
// bridge — and stays integer for the entire recursion (the
// transformations `shift`, `scale`, `mirror` preserve ℤ-coefficient
// polynomials when the parameter is in ℤ).
//
// The exception: `lmq.ts` (LMQ bound) returns a `bigint` (the integer
// upper bound on positive roots — actually `2^k` where `k = max(P) +
// 1`). Endpoint reconstruction at the very end of the algorithm
// produces ℚ; that's a `Rat` in `isolate.ts`.

import { type Rat, makeRat } from "@workbench/cas-core";

// -----------------------------------------------------------------------------
// Construction / canonicalisation
// -----------------------------------------------------------------------------

/** Strip leading zeros (top of the high-to-low array). */
export function strip(f: bigint[]): bigint[] {
  let i = 0;
  while (i < f.length && f[i] === 0n) i++;
  return f.slice(i);
}

/** Degree (`-1` for the zero polynomial — matches SymPy's `dup_degree`). */
export function degree(f: readonly bigint[]): number {
  return f.length - 1;
}

/** Leading coefficient `c_n`. Throws on the zero polynomial. */
export function leading(f: readonly bigint[]): bigint {
  if (f.length === 0) throw new Error("leading: zero polynomial");
  return f[0]!;
}

/** Trailing coefficient `c_0`. `0n` for the zero polynomial. */
export function trailing(f: readonly bigint[]): bigint {
  if (f.length === 0) return 0n;
  return f[f.length - 1]!;
}

// -----------------------------------------------------------------------------
// Negate / mirror / scale / shift / reverse
// -----------------------------------------------------------------------------

/** `−f`. */
export function negate(f: readonly bigint[]): bigint[] {
  return f.map((c) => -c);
}

/**
 * `f(−x)`. In the high-to-low convention, this flips the sign of every
 * coefficient at an *odd power of x*. Index `n − i` in the array holds
 * the coefficient of `x^i`; odd `i` ↔ array indices of the same parity
 * as `n − 1`. SymPy's loop walks `range(len(f) − 2, −1, −2)`, which
 * picks every other index starting from `n − 1` and stepping down — the
 * indices whose corresponding power is odd.
 */
export function mirror(f: readonly bigint[]): bigint[] {
  const out = [...f];
  for (let i = out.length - 2; i >= 0; i -= 2) out[i] = -out[i]!;
  return out;
}

/**
 * `f(a·x)` — Horner-style: multiply the coefficient of `x^k` by `a^k`,
 * which is the index `n − k` slot times `a^k`. SymPy walks high-to-low
 * accumulating `b = a^k`.
 */
export function scale(f: readonly bigint[], a: bigint): bigint[] {
  if (f.length === 0) return [];
  const out = [...f];
  let b = a;
  for (let i = out.length - 2; i >= 0; i--) {
    out[i] = b * out[i]!;
    b = b * a;
  }
  return out;
}

/**
 * `f(x + a)` — Taylor shift via finite differences. The classical
 * `O(n^2)` integer method: starting from the high coefficient, repeatedly
 * fold `a · f[j]` into `f[j+1]`. SymPy's `dup_shift` is identical.
 */
export function shift(f: readonly bigint[], a: bigint): bigint[] {
  if (a === 0n) return [...f];
  const out = [...f];
  const n = out.length - 1;
  for (let i = n; i > 0; i--) {
    for (let j = 0; j < i; j++) out[j + 1] = out[j + 1]! + a * out[j]!;
  }
  return out;
}

/**
 * `x^n · f(1/x)` — reverse the coefficient list. In the high-to-low
 * convention, this is just `[c_0, c_1, …, c_n]`. Used in two places:
 * computing the LMQ *lower* bound (= `1 / LMQ_upper(reverse(f))`), and
 * the second VAS branch transformation `f → x^d · f(1/(x+1))`.
 *
 * Strips trailing zeros of the original (= leading zeros of the
 * reversed array) so the result is canonical.
 */
export function reverse(f: readonly bigint[]): bigint[] {
  const out = [...f].reverse();
  return strip(out);
}

/**
 * Right-shift by `k` powers — `f / x^k` when `f` is divisible by `x^k`.
 * For the VAS use case `k = 1` after we've detected `f(0) = 0` (a root
 * at zero); the high-to-low array drops the trailing zero(s).
 */
export function rshift(f: readonly bigint[], k: number): bigint[] {
  if (k <= 0) return [...f];
  return f.slice(0, f.length - k);
}

// -----------------------------------------------------------------------------
// Evaluation / sign-change count
// -----------------------------------------------------------------------------

/** Horner evaluation `f(x)` over ℤ. */
export function evalAt(f: readonly bigint[], x: bigint): bigint {
  let r = 0n;
  for (const c of f) r = r * x + c;
  return r;
}

/**
 * Descartes' sign-change count: number of times consecutive non-zero
 * coefficients differ in sign. Zeros are skipped (not sign-changes).
 *
 * For a polynomial in `ℤ[x]`, the number of *positive* real roots
 * equals this count *modulo 2* — Descartes' rule of signs (1637).
 * Combined with Vincent's theorem (1836), it's the recursion's "stop
 * when count ≤ 1" decision.
 */
export function signVariations(f: readonly bigint[]): number {
  let prev = 0n;
  let k = 0;
  for (const c of f) {
    if (c * prev < 0n) k++;
    if (c !== 0n) prev = c;
  }
  return k;
}

// -----------------------------------------------------------------------------
// ℚ → ℤ bridge
// -----------------------------------------------------------------------------

/**
 * Clear denominators: given coefficients in ℚ, return the equivalent
 * ℤ-coefficient polynomial (multiplied by the LCM of all denominators).
 * Real roots are unchanged by ℚ-scaling (`f(x) = 0 ↔ c·f(x) = 0` for
 * any `c ≠ 0`), so this is a free reduction.
 *
 * Returns the integer-coefficient poly directly; the dropped scaling
 * factor is irrelevant to root *positions*.
 */
export function clearDenominators(coeffs: readonly Rat[]): bigint[] {
  if (coeffs.length === 0) return [];
  // LCM of denominators.
  let lcm = 1n;
  for (const c of coeffs) {
    const d = c.d;
    lcm = (lcm * d) / gcd(lcm, d);
  }
  const out: bigint[] = [];
  for (const c of coeffs) {
    out.push((c.n * lcm) / c.d);
  }
  return out;
}

/** Reverse direction: ℤ-coefficient polynomial back to ℚ. */
export function toRationalCoeffs(f: readonly bigint[]): Rat[] {
  return f.map((c) => makeRat(c, 1n));
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function gcd(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) {
    [x, y] = [y, x % y];
  }
  return x;
}

/** Integer base-2 logarithm rounded down: `floor(log2(|x|))`. Throws on 0. */
export function ilog2Floor(x: bigint): number {
  if (x === 0n) throw new Error("ilog2Floor: zero");
  let n = x < 0n ? -x : x;
  let k = -1;
  while (n > 0n) {
    n >>= 1n;
    k++;
  }
  return k;
}

/** Integer base-2 logarithm rounded up: `ceil(log2(|x|))`. */
export function ilog2Ceil(x: bigint): number {
  const f = ilog2Floor(x);
  // If x is exactly a power of 2 then floor == ceil.
  return (1n << BigInt(f)) === (x < 0n ? -x : x) ? f : f + 1;
}
