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
import { fromInt, fromFloat64, fromString, toFloat64 } from "./conversion.js";

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
 * `atan(x)` for `|x| < 1`. Used by `pi` and by the full `atan` (via the
 * reduction step). Throws if `|x| ≥ 1`.
 *
 * For best convergence, callers should reduce |x| ≤ 0.5 before invoking;
 * we provide that reduction internally via a Möbius identity in the
 * 0.5 < |x| < 1 range.
 */
export function atanSmall(x: BigFloat, prec: number): BigFloat {
  // Validate |x| < 1.
  const oneW = fromInt(1n, prec);
  if (cmp(abs(x), oneW) >= 0) {
    throw new RangeError(`BigFloat.atanSmall: argument |x| must be < 1`);
  }
  if (isZero(x)) return { mantissa: 0n, exponent: 0, precision: prec };
  // For 0.5 < |x| < 1, reduce via atan(x) = π/4 + atan((x-1)/(x+1)).
  // The transform sends 0.5 → -1/3, 0.99 → -1/199, etc., so the recursive
  // call always lands in |·| ≤ 0.5 where Taylor converges fast.
  const half = fromString("0.5", prec);
  if (cmp(abs(x), half) > 0) {
    const work = prec + 32;
    const xW: BigFloat = { mantissa: x.mantissa, exponent: x.exponent, precision: work };
    const oneL = fromInt(1n, work);
    const reduced = div(sub(xW, oneL, work), add(xW, oneL, work), work);
    const sign = sgn(x);
    if (sign === 1) {
      // x > 0.5: atan(x) = π/4 + atan(reduced) where reduced ∈ (-1/3, 0).
      const piW = pi(work);
      const piOver4 = div(piW, fromInt(4n, work), work);
      const result = add(piOver4, atanSmall(reduced, work), work);
      return normalise(result.mantissa, result.exponent, prec);
    }
    // x < -0.5: atan(x) = -π/4 + atan(reduced) where reduced ∈ (0, 1/3) is
    // positive (since (x-1)/(x+1) is positive when x < -1, but here x ∈ (-1, -0.5)
    // so x-1 < 0 and x+1 > 0 → reduced < 0; and we negate via symmetry of atan).
    // Use atan(x) = -atan(-x).
    const result = neg(atanSmall(neg(x), prec));
    return result;
  }
  // |x| ≤ 0.5: direct Taylor.
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

// =============================================================================
// Trigonometry — sin, cos, tan, asin, acos, atan, atan2
// =============================================================================

/**
 * Reduce x to (q, r) with x = q · π/2 + r, |r| ≤ π/4, q ∈ {0,1,2,3} (mod 4).
 *
 * Used as the first step of sin and cos. The reduction is exact at
 * `work` precision; the `q` is a small integer (the quadrant); `r` is
 * a BigFloat in (-π/4, π/4].
 */
function reduceModPiOver2(
  x: BigFloat,
  work: number,
): { q: number; r: BigFloat } {
  const piW = pi(work);
  const piOver2 = div(piW, fromInt(2n, work), work);
  // q = round(x / (π/2)). Use float64 estimate, refine.
  const xOverPiHalf = div(x, piOver2, work);
  const xFloat = toFloat64(xOverPiHalf).value;
  if (!Number.isFinite(xFloat) || !Number.isSafeInteger(Math.round(xFloat))) {
    throw new RangeError(`BigFloat.sin/cos: argument too large for trig reduction`);
  }
  const qInt = Math.round(xFloat);
  const r = sub(x, mul(fromInt(BigInt(qInt), work), piOver2, work), work);
  // Normalise q to {0, 1, 2, 3}.
  const qMod = ((qInt % 4) + 4) % 4;
  return { q: qMod, r };
}

/**
 * `sin(x)`. Argument reduction modulo π/2; halving + Taylor on the reduced
 * value; quadrant lookup to recover sin from sin(r) or cos(r).
 *
 * Halving reduction: sin(2y) = 2·sin(y)·cos(y); we halve the reduced r
 * `m = ceil(sqrt(prec))` times and Taylor on the halved value, then
 * de-halve via sin/cos identities.
 */
export function sin(x: BigFloat, prec: number): BigFloat {
  if (isZero(x)) return { mantissa: 0n, exponent: 0, precision: prec };
  const work = prec + 32;
  const { q, r } = reduceModPiOver2(x, work);
  // After reduction, sin(x) = ±sin(r) or ±cos(r) depending on q.
  // q=0: sin(x) = sin(r);  q=1: sin(x) = cos(r);
  // q=2: sin(x) = -sin(r); q=3: sin(x) = -cos(r).
  const { sin: sinR, cos: cosR } = sinCosSmall(r, work);
  let result: BigFloat;
  switch (q) {
    case 0: result = sinR; break;
    case 1: result = cosR; break;
    case 2: result = neg(sinR); break;
    case 3: result = neg(cosR); break;
    default: throw new Error("unreachable");
  }
  return normalise(result.mantissa, result.exponent, prec);
}

/**
 * `cos(x)`. Argument reduction modulo π/2; halving + Taylor; quadrant
 * lookup analogous to sin.
 */
export function cos(x: BigFloat, prec: number): BigFloat {
  if (isZero(x)) {
    return { mantissa: 1n << BigInt(prec - 1), exponent: -(prec - 1), precision: prec };
  }
  const work = prec + 32;
  const { q, r } = reduceModPiOver2(x, work);
  // q=0: cos(r); q=1: -sin(r); q=2: -cos(r); q=3: sin(r).
  const { sin: sinR, cos: cosR } = sinCosSmall(r, work);
  let result: BigFloat;
  switch (q) {
    case 0: result = cosR; break;
    case 1: result = neg(sinR); break;
    case 2: result = neg(cosR); break;
    case 3: result = sinR; break;
    default: throw new Error("unreachable");
  }
  return normalise(result.mantissa, result.exponent, prec);
}

/**
 * `tan(x) = sin(x) / cos(x)`. Throws when cos(x) is zero (x = π/2 + k·π).
 */
export function tan(x: BigFloat, prec: number): BigFloat {
  const work = prec + 32;
  const s = sin(x, work);
  const c = cos(x, work);
  if (isZero(c)) {
    throw new RangeError(`BigFloat.tan: argument is at a pole (x = π/2 + k·π)`);
  }
  return div(s, c, prec);
}

/**
 * Compute sin and cos together for |x| ≤ π/4 by halving + Taylor.
 *
 * Halving: pick m = ceil(sqrt(prec)); compute sin(x/2^m) and cos(x/2^m)
 * via Taylor, then de-halve via sin(2y) = 2·sin(y)·cos(y) and
 * cos(2y) = 1 − 2·sin²(y).
 */
function sinCosSmall(x: BigFloat, prec: number): { sin: BigFloat; cos: BigFloat } {
  if (isZero(x)) {
    return {
      sin: { mantissa: 0n, exponent: 0, precision: prec },
      cos: fromInt(1n, prec),
    };
  }
  const m = Math.max(0, Math.ceil(Math.sqrt(prec)));
  // x / 2^m, exact.
  const xSmall: BigFloat = {
    mantissa: x.mantissa,
    exponent: x.exponent - m,
    precision: x.precision,
  };
  // Taylor: sin(y) = y - y³/6 + y⁵/120 - ...
  //         cos(y) = 1 - y²/2 + y⁴/24 - ...
  const y2 = mul(xSmall, xSmall, prec);
  let sinSum: BigFloat = xSmall;
  let cosSum: BigFloat = fromInt(1n, prec);
  let sinTerm: BigFloat = xSmall; // y^(2k+1) / (2k+1)! ; start k=0
  let cosTerm: BigFloat = fromInt(1n, prec); // y^(2k) / (2k)! ; start k=0
  let k = 1;
  const stopThreshold = -(prec + 16);
  while (true) {
    // Update cos term: y^(2k) / (2k)! = cosTerm_{k-1} * y² / ((2k-1)·2k).
    cosTerm = neg(div(mul(cosTerm, y2, prec), fromInt((2 * k - 1) * 2 * k, prec), prec));
    cosSum = add(cosSum, cosTerm, prec);
    // Update sin term: y^(2k+1) / (2k+1)! = sinTerm_{k-1} * y² / ((2k)·(2k+1)).
    sinTerm = neg(div(mul(sinTerm, y2, prec), fromInt(2 * k * (2 * k + 1), prec), prec));
    sinSum = add(sinSum, sinTerm, prec);
    const cosBits = bitLength(cosTerm.mantissa < 0n ? -cosTerm.mantissa : cosTerm.mantissa);
    const sinBits = bitLength(sinTerm.mantissa < 0n ? -sinTerm.mantissa : sinTerm.mantissa);
    if (
      (cosTerm.mantissa === 0n || cosTerm.exponent + cosBits < stopThreshold) &&
      (sinTerm.mantissa === 0n || sinTerm.exponent + sinBits < stopThreshold)
    ) {
      break;
    }
    k += 1;
    if (k > prec + 1000) break;
  }
  // De-halve m times: sin(2y) = 2·sin(y)·cos(y); cos(2y) = 1 − 2·sin²(y).
  let sn = sinSum;
  let cs = cosSum;
  for (let i = 0; i < m; i++) {
    const newSin = mul(mul(sn, cs, prec), fromInt(2n, prec), prec);
    const sn2 = mul(sn, sn, prec);
    const newCos = sub(fromInt(1n, prec), mul(sn2, fromInt(2n, prec), prec), prec);
    sn = newSin;
    cs = newCos;
  }
  return { sin: sn, cos: cs };
}

/**
 * `atan(x)` for any finite x. Combines `atanSmall` with the standard
 * reduction `atan(x) = sgn(x)·π/2 − atan(1/x)` for `|x| ≥ 1`. The
 * boundary `|x| = 1` is also handled by the reciprocal path (1/1 = 1
 * is the fixed point — but we short-circuit to ±π/4 for clarity).
 */
export function atan(x: BigFloat, prec: number): BigFloat {
  if (isZero(x)) return { mantissa: 0n, exponent: 0, precision: prec };
  const work = prec + 32;
  const oneW = fromInt(1n, work);
  const xW: BigFloat = { mantissa: x.mantissa, exponent: x.exponent, precision: work };
  const cmpResult = cmp(abs(xW), oneW);
  if (cmpResult < 0) {
    return atanSmall(x, prec);
  }
  if (cmpResult === 0) {
    // atan(±1) = ±π/4 exactly.
    const piOver4 = div(pi(prec), fromInt(4n, prec), prec);
    return sgn(x) === 1 ? piOver4 : neg(piOver4);
  }
  // |x| > 1: atan(x) = sgn(x)·π/2 − atan(1/x).
  const reciprocal = div(oneW, xW, work);
  const piOver2 = div(pi(work), fromInt(2n, work), work);
  const result = sub(
    sgn(x) === 1 ? piOver2 : neg(piOver2),
    atanSmall(reciprocal, work),
    work,
  );
  return normalise(result.mantissa, result.exponent, prec);
}

/**
 * `atan2(y, x)`. Standard four-quadrant arctangent.
 */
export function atan2(y: BigFloat, x: BigFloat, prec: number): BigFloat {
  const sx = sgn(x);
  const sy = sgn(y);
  if (sx === 0 && sy === 0) {
    // Conventionally atan2(0,0) = 0.
    return { mantissa: 0n, exponent: 0, precision: prec };
  }
  if (sx === 0) {
    // ±π/2.
    const piW = pi(prec);
    const piOver2 = div(piW, fromInt(2n, prec), prec);
    return sy === 1 ? piOver2 : neg(piOver2);
  }
  const work = prec + 32;
  const piW = pi(work);
  const yOverX = div(y, x, work);
  const baseAtan = atan(yOverX, work);
  if (sx === 1) {
    return normalise(baseAtan.mantissa, baseAtan.exponent, prec);
  }
  // x < 0: atan2 = atan(y/x) ± π depending on sign of y.
  const offset = sy >= 0 ? piW : neg(piW);
  const result = add(baseAtan, offset, work);
  return normalise(result.mantissa, result.exponent, prec);
}

/**
 * `asin(x)` for `|x| ≤ 1`. Uses asin(x) = atan(x / sqrt(1 - x²)).
 */
export function asin(x: BigFloat, prec: number): BigFloat {
  if (isZero(x)) return { mantissa: 0n, exponent: 0, precision: prec };
  const work = prec + 32;
  const oneW = fromInt(1n, work);
  const absX = abs(x);
  if (cmp(absX, oneW) > 0) {
    throw new RangeError(`BigFloat.asin: argument |x| must be ≤ 1`);
  }
  // |x| = 1: asin(1) = π/2; asin(-1) = -π/2.
  if (cmp(absX, oneW) === 0) {
    const piOver2 = div(pi(prec), fromInt(2n, prec), prec);
    return sgn(x) === 1 ? piOver2 : neg(piOver2);
  }
  // x / sqrt(1 - x²).
  const x2 = mul(x, x, work);
  const denom = sqrt(sub(oneW, x2, work), work);
  return atan(div(x, denom, work), prec);
}

/**
 * `acos(x)` for `|x| ≤ 1`. acos(x) = π/2 − asin(x).
 */
export function acos(x: BigFloat, prec: number): BigFloat {
  const work = prec + 32;
  const piOver2 = div(pi(work), fromInt(2n, work), work);
  return sub(piOver2, asin(x, work), prec);
}

// =============================================================================
// Hyperbolics — sinh, cosh, tanh, asinh, acosh, atanh
// =============================================================================

/**
 * `sinh(x) = (exp(x) − exp(−x)) / 2`. For small |x| use Taylor to avoid
 * subtractive cancellation.
 */
export function sinh(x: BigFloat, prec: number): BigFloat {
  if (isZero(x)) return { mantissa: 0n, exponent: 0, precision: prec };
  const xFloat = toFloat64(x).value;
  if (Math.abs(xFloat) < 0.5) {
    // Taylor: sinh(x) = x + x³/6 + x⁵/120 + ... (all positive terms).
    const work = prec + 32;
    const x2 = mul(x, x, work);
    let sum: BigFloat = x;
    let term: BigFloat = x;
    let n = 1;
    const stopThreshold = -(prec + 16);
    while (true) {
      term = div(mul(term, x2, work), fromInt(2 * n * (2 * n + 1), work), work);
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
  const work = prec + 16;
  const ePos = exp(x, work);
  const eNeg = exp(neg(x), work);
  const diff = sub(ePos, eNeg, work);
  return div(diff, fromInt(2n, work), prec);
}

/**
 * `cosh(x) = (exp(x) + exp(−x)) / 2`. Always ≥ 1.
 */
export function cosh(x: BigFloat, prec: number): BigFloat {
  if (isZero(x)) return fromInt(1n, prec);
  const work = prec + 16;
  const ePos = exp(x, work);
  const eNeg = exp(neg(x), work);
  const sum = add(ePos, eNeg, work);
  return div(sum, fromInt(2n, work), prec);
}

/**
 * `tanh(x) = sinh(x) / cosh(x)`. Stable formulation: for large |x| the
 * computation can saturate; use tanh(x) = expm1(2x) / (expm1(2x) + 2)
 * which stays in [-1, 1] cleanly.
 */
export function tanh(x: BigFloat, prec: number): BigFloat {
  if (isZero(x)) return { mantissa: 0n, exponent: 0, precision: prec };
  const work = prec + 32;
  const twoX = mul(x, fromInt(2n, work), work);
  const e1 = expm1(twoX, work);
  const denom = add(e1, fromInt(2n, work), work);
  return div(e1, denom, prec);
}

/**
 * `asinh(x) = log(x + sqrt(x² + 1))`. Always real.
 */
export function asinh(x: BigFloat, prec: number): BigFloat {
  if (isZero(x)) return { mantissa: 0n, exponent: 0, precision: prec };
  const work = prec + 32;
  const x2 = mul(x, x, work);
  const root = sqrt(add(x2, fromInt(1n, work), work), work);
  return log(add(x, root, work), prec);
}

/**
 * `acosh(x) = log(x + sqrt(x² − 1))` for x ≥ 1.
 */
export function acosh(x: BigFloat, prec: number): BigFloat {
  const oneW = fromInt(1n, prec);
  if (cmp(x, oneW) < 0) {
    throw new RangeError(`BigFloat.acosh: argument must be ≥ 1`);
  }
  const work = prec + 32;
  const x2 = mul(x, x, work);
  const root = sqrt(sub(x2, fromInt(1n, work), work), work);
  return log(add(x, root, work), prec);
}

/**
 * `atanh(x) = ½·log((1 + x)/(1 − x))` for `|x| < 1`.
 */
export function atanh(x: BigFloat, prec: number): BigFloat {
  if (isZero(x)) return { mantissa: 0n, exponent: 0, precision: prec };
  const oneW = fromInt(1n, prec);
  if (cmp(abs(x), oneW) >= 0) {
    throw new RangeError(`BigFloat.atanh: argument |x| must be < 1`);
  }
  const work = prec + 32;
  const numer = add(fromInt(1n, work), x, work);
  const denom = sub(fromInt(1n, work), x, work);
  const ratio = div(numer, denom, work);
  const half = log(ratio, work);
  return div(half, fromInt(2n, work), prec);
}

// =============================================================================
// General power: a^b for non-integer b.
// =============================================================================

/**
 * `pow(a, b) = exp(b · log(a))` for `a > 0`. Throws on `a ≤ 0` (for
 * non-integer `b`); for integer `b`, defer to `powInt`.
 */
export function pow(a: BigFloat, b: BigFloat, prec: number): BigFloat {
  // Integer-power fast path.
  const bFloat = toFloat64(b).value;
  if (Number.isFinite(bFloat) && Number.isSafeInteger(bFloat)) {
    // Verify b is exactly the integer (no fractional bits).
    const bAsInt = fromInt(BigInt(bFloat), b.precision);
    if (eq(bAsInt, b)) {
      return powInt(a, bFloat, prec);
    }
  }
  // Real-power path.
  if (sgn(a) <= 0) {
    if (isZero(a)) {
      if (sgn(b) > 0) return { mantissa: 0n, exponent: 0, precision: prec };
      throw new RangeError(`BigFloat.pow: 0^b for b ≤ 0`);
    }
    throw new RangeError(`BigFloat.pow: negative base for non-integer exponent`);
  }
  const work = prec + 32;
  return exp(mul(b, log(a, work), work), prec);
}
