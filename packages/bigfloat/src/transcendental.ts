// =============================================================================
// @workbench/bigfloat — exp / log / atan via series with argument reduction
// =============================================================================
//
// All transcendentals here use Taylor / power series at their core. Speed
// is not the goal at v0.1 — *correctness* is. At 50-200 decimal digits, a
// well-reduced Taylor series is fast enough for the MeijerG benchmark; we
// can later replace pieces with AGM (for log at very high precision) or
// Brent–McMillan (for high-precision Γ) without changing the contract.
//
// Argument reduction matters because Taylor series converge slowly far from
// the expansion point and round-off accumulates. The standard reductions:
//
//   exp:  x = k·ln(2) + r,  |r| ≤ ln(2)/2.  Then exp(x) = 2^k · exp(r).
//         Further reduce: r' = r / 2^m,  exp(r) = exp(r')^(2^m).
//   log:  x = m · 2^k where m ∈ [1, 2).  log(x) = k·ln(2) + log(m).
//         For log(m) use atanh series:  log((1+u)/(1-u)) = 2·atanh(u),
//         where m = (1+u)/(1-u) gives u = (m-1)/(m+1).
//   atan: |x| ≤ 1.  Taylor:  atan(x) = x - x^3/3 + x^5/5 - ...
//         For |x| > 1 use the identity (later commit).
//
// Working precision: every operation bumps internal precision by a margin
// (`prec + extra`) so accumulated rounding stays below the user's target.
// `extra` is a bit-budget that scales with the iteration count of the
// dominant series — typically 32 bits is plenty for ≤ 1000-dps targets.

import {
  BigFloat,
  normalise,
  bitLength,
  decimalToBinaryPrecision,
} from "./types.js";
import { abs, neg, sgn, cmp, eq, isZero } from "./comparison.js";
import { add, sub, mul, div, sqrt, powInt } from "./arithmetic.js";
import { fromInt, fromFloat64, toFloat64 } from "./conversion.js";

// =============================================================================
// Constants — cached per-precision.
// =============================================================================

let _ln2Cache: BigFloat | null = null;
let _piCache: BigFloat | null = null;
let _eCache: BigFloat | null = null;

/**
 * `ln(2)` to the requested precision. Cached: subsequent calls at the same
 * or lower precision return the cached value rounded down.
 *
 * Algorithm: the geometric series  ln(2) = Σ_{k=1}^∞  1 / (k · 2^k).
 * Converges with ratio 1/2 per term — so `prec + 8` terms suffice.
 */
export function ln2(prec: number): BigFloat {
  if (_ln2Cache !== null && _ln2Cache.precision >= prec) {
    return normalise(_ln2Cache.mantissa, _ln2Cache.exponent, prec);
  }
  const work = prec + 32;
  // Compute Σ 1/(k * 2^k) until terms drop below 2^-(prec+16).
  let sum: BigFloat = { mantissa: 0n, exponent: 0, precision: work };
  // Start from k=1.
  // term_k = 1 / (k * 2^k) = 2^-k / k.
  // We can iterate: term_{k+1} = term_k * k / (2 * (k+1)).
  let term: BigFloat = { mantissa: 1n << BigInt(work - 1), exponent: -(work - 1) - 1, precision: work };
  // term_1 = 1 / (1 * 2) = 1/2 = mantissa (1<<work-1), exp -(work-1) - 1 = -(work).
  // Verify: value = (1<<work-1) * 2^(-work) = 2^-1 = 1/2. ✓
  let k = 1;
  // Threshold: stop when |term| < 2^-(prec+16).
  const stopExpThreshold = -(prec + 16);
  while (true) {
    sum = add(sum, term, work);
    // Compute next term: term_{k+1} = term_k * k / (2 * (k+1)).
    const numerator = mul(term, fromInt(k, work), work);
    const denominator = fromInt(2 * (k + 1), work);
    term = div(numerator, denominator, work);
    k += 1;
    // Stop when the next term is below the threshold.
    if (term.mantissa === 0n || term.exponent + bitLength(term.mantissa < 0n ? -term.mantissa : term.mantissa) < stopExpThreshold) {
      break;
    }
    // Safety bail — prevents runaway in pathological cases.
    if (k > work + 1000) break;
  }
  // Fold the final small term in for one extra bit of accuracy.
  sum = add(sum, term, work);
  _ln2Cache = sum;
  return normalise(sum.mantissa, sum.exponent, prec);
}

/**
 * `e` (Euler's number) to the requested precision. Cached.
 *
 * Algorithm: `e = exp(1)`. Computed via the Taylor series of exp at 1,
 * which is identical to Σ 1/k!.
 */
export function e(prec: number): BigFloat {
  if (_eCache !== null && _eCache.precision >= prec) {
    return normalise(_eCache.mantissa, _eCache.exponent, prec);
  }
  const work = prec + 32;
  // e = Σ_{k=0}^∞ 1/k!.
  let sum: BigFloat = fromInt(1n, work); // k=0 term
  let term: BigFloat = fromInt(1n, work); // running 1/k!
  let k = 1;
  const stopExpThreshold = -(prec + 16);
  while (true) {
    term = div(term, fromInt(k, work), work);
    sum = add(sum, term, work);
    if (
      term.mantissa === 0n ||
      term.exponent + bitLength(term.mantissa < 0n ? -term.mantissa : term.mantissa) < stopExpThreshold
    ) {
      break;
    }
    k += 1;
    if (k > work + 1000) break;
  }
  _eCache = sum;
  return normalise(sum.mantissa, sum.exponent, prec);
}

/**
 * π to the requested precision. Cached.
 *
 * Algorithm: Machin's formula  π = 16·atan(1/5) − 4·atan(1/239).
 * atan converges geometrically with ratio |x|² per pair of terms, so the
 * 1/5 term has ratio 1/25 and the 1/239 term has ratio 1/57121 — both
 * fast at any reasonable precision.
 *
 * For very high precision (≥ a few thousand dps) AGM-based π would be
 * faster; not the bottleneck for MeijerG.
 */
export function pi(prec: number): BigFloat {
  if (_piCache !== null && _piCache.precision >= prec) {
    return normalise(_piCache.mantissa, _piCache.exponent, prec);
  }
  const work = prec + 32;
  // atan(1/5) and atan(1/239) at working precision.
  const a = atanSmall(div(fromInt(1n, work), fromInt(5n, work), work), work);
  const b = atanSmall(div(fromInt(1n, work), fromInt(239n, work), work), work);
  const sixteenA = mul(a, fromInt(16n, work), work);
  const fourB = mul(b, fromInt(4n, work), work);
  const result = sub(sixteenA, fourB, work);
  _piCache = result;
  return normalise(result.mantissa, result.exponent, prec);
}

// =============================================================================
// Transcendental functions
// =============================================================================

/**
 * `exp(x)`. Argument reduction `x = k·ln(2) + r` with `|r| ≤ ln(2)/2`,
 * then a sub-reduction `r' = r / 2^m` followed by Taylor on `r'` and
 * repeated squaring back to `exp(r)`.
 *
 * The choice `m = ceil(sqrt(prec))` is the standard heuristic — it
 * balances Taylor-series convergence against squaring cost.
 */
export function exp(x: BigFloat, prec: number): BigFloat {
  if (isZero(x)) {
    // exp(0) = 1
    const one: BigFloat = { mantissa: 1n << BigInt(prec - 1), exponent: -(prec - 1), precision: prec };
    return one;
  }
  const work = prec + 32;
  const ln2_w = ln2(work);
  // k = round(x / ln2). Use float64 estimate first, then refine.
  const xFloat = toFloat64(x).value;
  if (!Number.isFinite(xFloat)) {
    throw new RangeError(
      `BigFloat.exp: argument too extreme to convert to float64 (${x.mantissa}·2^${x.exponent})`,
    );
  }
  const kEstimate = Math.round(xFloat / Math.LN2);
  if (!Number.isSafeInteger(kEstimate)) {
    throw new RangeError(
      `BigFloat.exp: argument out of range (kEstimate=${kEstimate})`,
    );
  }
  // r = x - k·ln(2).
  const kBig = fromInt(BigInt(kEstimate), work);
  const r = sub(x, mul(kBig, ln2_w, work), work);
  // Sub-reduction: r' = r / 2^m, with m chosen so that |r'| ≤ 2^-sqrtPrec roughly.
  const m = Math.max(0, Math.ceil(Math.sqrt(prec)));
  // r' = r * 2^-m, exact.
  const rPrime: BigFloat = {
    mantissa: r.mantissa,
    exponent: r.exponent - m,
    precision: r.precision,
  };
  // Taylor series for exp(r').
  let sum: BigFloat = fromInt(1n, work);
  let term: BigFloat = fromInt(1n, work);
  let n = 1;
  const stopThreshold = -(prec + 16);
  while (true) {
    // term_n = term_{n-1} * r' / n.
    term = div(mul(term, rPrime, work), fromInt(n, work), work);
    sum = add(sum, term, work);
    if (
      term.mantissa === 0n ||
      term.exponent + bitLength(term.mantissa < 0n ? -term.mantissa : term.mantissa) < stopThreshold
    ) {
      break;
    }
    n += 1;
    if (n > work + 1000) break;
  }
  // Square `m` times to recover exp(r).
  let expR = sum;
  for (let i = 0; i < m; i++) {
    expR = mul(expR, expR, work);
  }
  // Multiply by 2^k: shift exponent.
  const result: BigFloat = {
    mantissa: expR.mantissa,
    exponent: expR.exponent + kEstimate,
    precision: expR.precision,
  };
  return normalise(result.mantissa, result.exponent, prec);
}

/**
 * `log(x)` for `x > 0`. Throws on non-positive input.
 *
 * Algorithm: argument reduction to bring `m ∈ [1, 2)`, then atanh series:
 *
 *     m = (1 + u)/(1 - u) ⇒ u = (m - 1)/(m + 1) ∈ [0, 1/3).
 *
 *     log(m) = 2 · atanh(u) = 2 · (u + u³/3 + u⁵/5 + u⁷/7 + ...)
 *
 * The series converges with ratio `u²` per term — for `u ≤ 1/3` that's
 * 1/9, so prec + 8 terms suffice in practice.
 */
export function log(x: BigFloat, prec: number): BigFloat {
  if (sgn(x) <= 0) {
    throw new RangeError(`BigFloat.log: non-positive argument`);
  }
  // log(1) = 0
  const one = fromInt(1n, prec);
  if (eq(x, one)) {
    return { mantissa: 0n, exponent: 0, precision: prec };
  }
  const work = prec + 32;
  // Reduce x = m * 2^k with m ∈ [1, 2). Strategy: pick the binary exponent
  // such that |mantissa| / 2^precision is in [1, 2). Easiest: rebuild as a
  // BigFloat with exponent set so the value normalises to [1, 2).
  // Concretely: at full precision `prec`, |mantissa| has precision bits
  // (top bit set), so the value is in [2^exponent + (precision-1),
  //   2^(exponent + precision)).
  // To get m ∈ [1, 2), set the new exponent to -(precision - 1) and the
  // shift amount k = original.exponent + precision - 1.
  const xPositive: BigFloat = sgn(x) === 1 ? x : abs(x);
  const k = xPositive.exponent + xPositive.precision - 1;
  const m: BigFloat = {
    mantissa: xPositive.mantissa,
    exponent: -(xPositive.precision - 1),
    precision: xPositive.precision,
  };
  // u = (m - 1) / (m + 1).
  const oneW = fromInt(1n, work);
  const u = div(sub(m, oneW, work), add(m, oneW, work), work);
  // Taylor: 2 * (u + u^3/3 + u^5/5 + ...).
  const u2 = mul(u, u, work);
  let sum: BigFloat = u;
  let term: BigFloat = u; // running u^(2n+1) before division by (2n+1)
  let n = 1;
  const stopThreshold = -(prec + 16);
  while (true) {
    term = mul(term, u2, work); // now u^(2n+1)
    const contribution = div(term, fromInt(2 * n + 1, work), work);
    sum = add(sum, contribution, work);
    if (
      contribution.mantissa === 0n ||
      contribution.exponent + bitLength(contribution.mantissa < 0n ? -contribution.mantissa : contribution.mantissa) < stopThreshold
    ) {
      break;
    }
    n += 1;
    if (n > work + 1000) break;
  }
  // logM = 2 * sum
  const logM = mul(sum, fromInt(2n, work), work);
  // log(x) = k * ln(2) + logM
  const result = add(mul(fromInt(BigInt(k), work), ln2(work), work), logM, work);
  return normalise(result.mantissa, result.exponent, prec);
}

/**
 * `expm1(x) = exp(x) - 1`. Accurate near 0 by avoiding the subtractive
 * cancellation that `exp(x) - 1` would suffer.
 *
 * Algorithm: same as `exp`, but the final result is `exp(r')^(2^m) * 2^k - 1`
 * computed in a way that avoids cancellation when `x` is small. For small
 * `|x|`, the Taylor series for `expm1` directly gives `x + x²/2 + x³/6 + …`.
 *
 * We split: if |x| < 0.5, use the direct expm1 series. Otherwise compute
 * `exp(x) - 1` directly (the cancellation is only severe for very small x).
 */
export function expm1(x: BigFloat, prec: number): BigFloat {
  if (isZero(x)) return { mantissa: 0n, exponent: 0, precision: prec };
  // Threshold |x| < 1/2.
  const xFloat = toFloat64(x).value;
  if (Math.abs(xFloat) < 0.5) {
    const work = prec + 32;
    let sum: BigFloat = { mantissa: 0n, exponent: 0, precision: work };
    let term: BigFloat = fromInt(1n, work);
    // Taylor: expm1(x) = x + x²/2 + x³/6 + ... = Σ_{n=1}^∞ x^n / n!.
    const stopThreshold = -(prec + 16);
    let n = 1;
    while (true) {
      term = div(mul(term, x, work), fromInt(n, work), work);
      sum = add(sum, term, work);
      if (
        term.mantissa === 0n ||
        term.exponent + bitLength(term.mantissa < 0n ? -term.mantissa : term.mantissa) < stopThreshold
      ) {
        break;
      }
      n += 1;
      if (n > work + 1000) break;
    }
    return normalise(sum.mantissa, sum.exponent, prec);
  }
  // |x| ≥ 0.5: direct exp - 1 is accurate.
  return sub(exp(x, prec + 4), fromInt(1n, prec + 4), prec);
}

/**
 * `log1p(x) = log(1 + x)`. Accurate near 0.
 */
export function log1p(x: BigFloat, prec: number): BigFloat {
  if (isZero(x)) return { mantissa: 0n, exponent: 0, precision: prec };
  // Threshold |x| < 1/2: use atanh-based series directly with u = x/(2+x).
  const xFloat = toFloat64(x).value;
  if (Math.abs(xFloat) < 0.5) {
    const work = prec + 32;
    // u = x / (2 + x). log(1+x) = 2 * atanh(u).
    const u = div(x, add(fromInt(2n, work), x, work), work);
    const u2 = mul(u, u, work);
    let sum: BigFloat = u;
    let term: BigFloat = u;
    let n = 1;
    const stopThreshold = -(prec + 16);
    while (true) {
      term = mul(term, u2, work);
      const contribution = div(term, fromInt(2 * n + 1, work), work);
      sum = add(sum, contribution, work);
      if (
        contribution.mantissa === 0n ||
        contribution.exponent + bitLength(contribution.mantissa < 0n ? -contribution.mantissa : contribution.mantissa) < stopThreshold
      ) {
        break;
      }
      n += 1;
      if (n > work + 1000) break;
    }
    return mul(sum, fromInt(2n, prec), prec);
  }
  return log(add(fromInt(1n, prec + 4), x, prec + 4), prec);
}

// =============================================================================
// Internal: atan for |x| < 1 (Taylor). Exposed as `atan` later when the
// |x| ≥ 1 branch is added.
// =============================================================================

/**
 * `atan(x)` for `|x| < 1`. Used by `pi` and (eventually) by the public
 * `atan`. Throws if `|x| ≥ 1` — the caller must handle the reduction.
 */
export function atanSmall(x: BigFloat, prec: number): BigFloat {
  // Validate |x| < 1.
  const oneW = fromInt(1n, prec);
  if (cmp(abs(x), oneW) >= 0) {
    throw new RangeError(`BigFloat.atanSmall: argument |x| must be < 1`);
  }
  if (isZero(x)) return { mantissa: 0n, exponent: 0, precision: prec };
  const work = prec + 32;
  // atan(x) = x - x³/3 + x⁵/5 - x⁷/7 + ...
  const x2 = mul(x, x, work);
  let sum: BigFloat = x;
  let term: BigFloat = x;
  let n = 1;
  const stopThreshold = -(prec + 16);
  while (true) {
    // term_n = -term_{n-1} * x²; contribution = term_n / (2n+1).
    term = neg(mul(term, x2, work));
    const contribution = div(term, fromInt(2 * n + 1, work), work);
    sum = add(sum, contribution, work);
    if (
      contribution.mantissa === 0n ||
      contribution.exponent + bitLength(contribution.mantissa < 0n ? -contribution.mantissa : contribution.mantissa) < stopThreshold
    ) {
      break;
    }
    n += 1;
    if (n > work + 1000) break;
  }
  return normalise(sum.mantissa, sum.exponent, prec);
}
