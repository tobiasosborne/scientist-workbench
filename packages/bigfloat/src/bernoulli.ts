// =============================================================================
// @workbench/bigfloat — Bernoulli numbers (exact rationals, cached)
// =============================================================================
//
// Bernoulli numbers B_n appear in Stirling's series for log Γ and in the
// Stirling-style series for the digamma function. We compute them as
// exact rationals via the standard recurrence
//
//   Σ_{k=0}^{n}  C(n+1, k) · B_k  =  0     for n ≥ 1,   B_0 = 1
//
//   ⟹  B_n = -(1 / (n+1)) · Σ_{k=0}^{n-1}  C(n+1, k) · B_k
//
// All odd B_n with n > 1 are zero — we still produce them but the cache
// stores them as `(0n, 1n)`.
//
// Cache: the rational form `(num, den)` for each n in `Map<number, [bigint,
// bigint]>`. Cheap; ~64 distinct B_n cover Stirling-series truncation for
// precisions up to ~600 dps.

const cache: Map<number, { num: bigint; den: bigint }> = new Map();

function getCached(n: number): { num: bigint; den: bigint } | null {
  return cache.get(n) ?? null;
}

function reduceFraction(num: bigint, den: bigint): { num: bigint; den: bigint } {
  if (den === 0n) throw new Error("reduceFraction: zero denominator");
  if (num === 0n) return { num: 0n, den: 1n };
  let n = num < 0n ? -num : num;
  let d = den < 0n ? -den : den;
  while (d !== 0n) {
    const r = n % d;
    n = d;
    d = r;
  }
  // n is gcd; ensure positive denominator.
  const sign = num < 0n !== den < 0n ? -1n : 1n;
  return { num: sign * ((num < 0n ? -num : num) / n), den: (den < 0n ? -den : den) / n };
}

function addFraction(a: { num: bigint; den: bigint }, b: { num: bigint; den: bigint }): { num: bigint; den: bigint } {
  return reduceFraction(a.num * b.den + b.num * a.den, a.den * b.den);
}

function mulFraction(a: { num: bigint; den: bigint }, b: { num: bigint; den: bigint }): { num: bigint; den: bigint } {
  return reduceFraction(a.num * b.num, a.den * b.den);
}

function binomCoeff(n: bigint, k: bigint): bigint {
  if (k < 0n || k > n) return 0n;
  if (k === 0n || k === n) return 1n;
  // Use the multiplicative formula. C(n,k) = n! / (k!(n-k)!) =
  // ∏_{i=1}^{k} (n-k+i)/i. Build up exactly with integer division at each step.
  if (k > n - k) k = n - k;
  let num = 1n;
  let den = 1n;
  for (let i = 1n; i <= k; i++) {
    num *= n - k + i;
    den *= i;
  }
  return num / den;
}

/**
 * Compute B_n as an exact rational. Cached.
 *
 * `B_0 = 1, B_1 = -1/2, B_2 = 1/6, B_3 = 0, B_4 = -1/30, ...`
 */
export function bernoulliRational(n: number): { num: bigint; den: bigint } {
  if (!Number.isInteger(n) || n < 0) {
    throw new RangeError(`bernoulli: n must be a non-negative integer; got ${n}`);
  }
  const cached = getCached(n);
  if (cached !== null) return cached;
  if (n === 0) {
    const result = { num: 1n, den: 1n };
    cache.set(0, result);
    return result;
  }
  if (n === 1) {
    // B_1 = -1/2 (the "standard" or "Knuth" convention; some sources use +1/2).
    // We use the convention consistent with the generating function
    // x/(e^x - 1) = Σ B_n x^n / n!, which gives B_1 = -1/2.
    const result = { num: -1n, den: 2n };
    cache.set(1, result);
    return result;
  }
  if (n % 2 === 1) {
    const result = { num: 0n, den: 1n };
    cache.set(n, result);
    return result;
  }
  // B_n = -(1/(n+1)) · Σ_{k=0}^{n-1} C(n+1, k) · B_k.
  let sum: { num: bigint; den: bigint } = { num: 0n, den: 1n };
  const nPlus1Big = BigInt(n + 1);
  for (let k = 0; k < n; k++) {
    const coeff = binomCoeff(nPlus1Big, BigInt(k));
    if (coeff === 0n) continue;
    const Bk = bernoulliRational(k);
    if (Bk.num === 0n) continue;
    sum = addFraction(sum, mulFraction({ num: coeff, den: 1n }, Bk));
  }
  const result = reduceFraction(-sum.num, sum.den * BigInt(n + 1));
  cache.set(n, result);
  return result;
}
