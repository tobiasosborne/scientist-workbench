// =============================================================================
// @workbench/bigfloat — Γ, log Γ, ψ, polygamma
// =============================================================================
//
// Algorithms (real-argument; complex versions live in the BigComplex module):
//
//   log Γ(z) for large z (Re z > shiftThreshold ≈ prec/4):
//     Stirling's asymptotic series
//     log Γ(z) = (z − 1/2) · log z − z + (1/2)·log(2π)
//                 + Σ_{k=1}^{N}  B_{2k} / (2k(2k−1) z^{2k−1})
//     Truncate at the smallest term; remainder bound is below the next
//     term in magnitude (alternating asymptotic).
//
//   log Γ(z) for moderate z (0 < z ≤ shiftThreshold):
//     Recurrence  log Γ(z) = log Γ(z + N) − Σ_{k=0}^{N-1} log(z + k)
//     where N is chosen so that z + N ≥ shiftThreshold.
//
//   log Γ(z) for z ≤ 0:
//     Reflection  Γ(z) Γ(1 − z) = π / sin(π z)
//     ⟹  log Γ(z) = log π − log |sin(π z)| − log Γ(1 − z)
//     The sign of Γ(z) flips per (1−z mod 1) interval; lgamma returns
//     real-valued log|Γ|; gamma adds the sign.
//
//   ψ(z) (digamma): exactly the same shape, with the series
//     ψ(z) = log z − 1 / (2z) − Σ_{k=1}^{N}  B_{2k} / (2k · z^{2k})
//   and recurrence  ψ(z) = ψ(z + 1) − 1/z.
//   Reflection: ψ(1 − z) − ψ(z) = π · cot(π z).
//
//   polygamma ψ^(m)(z) for m ≥ 1:
//     Hurwitz-zeta route: ψ^(m)(z) = (-1)^(m+1) m! · ζ(m+1, z), with
//     z-shift recurrence to bring z above a threshold and then a
//     truncated zeta series. v0.1 ships m = 1 only (trigamma); higher
//     orders fall through to a tagged-not-implemented marker — the
//     MeijerG benchmark only needs trigamma in the Stirling-style
//     coalescence handling.

import {
  BigFloat,
  normalise,
  bitLength,
} from "./types.js";
import { abs, neg, sgn, cmp, eq, isZero, lt, gt } from "./comparison.js";
import { add, sub, mul, div, sqrt, powInt } from "./arithmetic.js";
import { fromInt, fromString, toFloat64 } from "./conversion.js";
import { ln2, pi, exp, log, sin, cos } from "./transcendental.js";
import { bernoulliRational } from "./bernoulli.js";
import { bigHurwitzZeta } from "./special-funcs/zeta.js";

/** B_{2k} as a BigFloat at the requested precision. */
function bernoulli(n: number, prec: number): BigFloat {
  const r = bernoulliRational(n);
  if (r.num === 0n) return { mantissa: 0n, exponent: 0, precision: prec };
  // Convert (num, den) → BigFloat at given precision.
  // Use long division shifted enough to provide `precision + safety` bits.
  const safety = 32;
  const workingBits = prec + safety;
  const sign = r.num < 0n ? -1n : 1n;
  const absNum = sign === -1n ? -r.num : r.num;
  const numShifted = absNum << BigInt(workingBits);
  const q = numShifted / r.den;
  const remainder = numShifted - q * r.den;
  const qWithSticky = remainder === 0n ? q : q | 1n;
  return normalise(sign * qWithSticky, -workingBits, prec);
}

/**
 * `log Γ(z)` for `z > 0` (real argument).
 *
 * Throws on `z ≤ 0` for now. Negative-real-argument branch (where Γ is
 * still defined except at non-positive integers) lives in `gamma`,
 * which uses the reflection formula and emits a sign separately.
 */
export function lgamma(z: BigFloat, prec: number): BigFloat {
  if (sgn(z) <= 0) {
    // For negative z (non-integer), |Γ(z)| is defined but Γ(z) flips sign.
    // We delegate to lgammaRealAbs which handles the reflection. lgamma
    // returns log|Γ|; sign is recovered in `gamma`.
    return lgammaRealAbs(z, prec);
  }
  // Working precision: we will subtract two values of comparable magnitude
  // (lgammaStirling(z+N) and Σ log(z+k)), and those values can be of order
  // log(N!) ≈ N log N ≈ shiftThreshold · log2(shiftThreshold). For
  // shiftThreshold up to ~prec/4 ≈ 50 (at prec=200), that is ~280 — about
  // log2(280) ≈ 9 bits of magnitude. Cancellation eats ≤ 10 bits, which a
  // 32-bit margin absorbs. But we also accumulate rounding from Stirling's
  // truncated series and from each log call; bump generously to 96 bits.
  const work = prec + 96;
  // Pick a "shift threshold" so that Stirling at z+N has good convergence.
  // Stirling's series truncated optimally at z' has error ~ exp(-2π z') on
  // a per-term basis; we need that below 2^-work. The condition gives
  // z' ≥ work·log(2)/(2π) ≈ work/9. We use work/8 for a small safety
  // margin and to keep the threshold a round number at small prec.
  const shiftThreshold = Math.max(8, Math.ceil(work / 8));
  // How many recurrences to apply.
  const zFloat = toFloat64(z).value;
  if (!Number.isFinite(zFloat)) {
    throw new RangeError(`lgamma: argument too large for stirling shift heuristic`);
  }
  const N = Math.max(0, Math.ceil(shiftThreshold - zFloat));
  // Compute log Γ(z + N) via Stirling.
  const zShifted = N > 0 ? add(z, fromInt(BigInt(N), work), work) : z;
  let result = lgammaStirling(zShifted, work);
  // Subtract Σ log(z + k) for k = 0..N-1.
  for (let k = 0; k < N; k++) {
    const zk = add(z, fromInt(BigInt(k), work), work);
    result = sub(result, log(zk, work), work);
  }
  return normalise(result.mantissa, result.exponent, prec);
}

/**
 * `log Γ(z)` via Stirling's asymptotic series. Caller must ensure `z` is
 * "Stirling-friendly" — typically `Re z ≥ prec/4`.
 *
 * Stops adding terms when the term magnitude starts increasing (asymptotic
 * series; optimal truncation is at the smallest term).
 */
function lgammaStirling(z: BigFloat, prec: number): BigFloat {
  // (z - 1/2) log z - z + (1/2) log(2π).
  const work = prec + 32;
  const half = fromString("0.5", work);
  const logZ = log(z, work);
  const log2pi = add(ln2(work), log(pi(work), work), work);
  const halfLog2pi = mul(log2pi, half, work);
  let result = sub(mul(sub(z, half, work), logZ, work), z, work);
  result = add(result, halfLog2pi, work);
  // Stirling correction series:  Σ B_{2k} / (2k(2k-1) z^{2k-1}).
  // 1/z is computed once; we multiply by 1/z² each iteration to advance.
  const oneOverZ = div(fromInt(1n, work), z, work);
  const oneOverZ2 = mul(oneOverZ, oneOverZ, work);
  let zPow = oneOverZ; // 1/z^(2k-1) starting at k=1, so 1/z.
  let prevTermMag = Infinity;
  for (let k = 1; k <= 300; k++) {
    const B2k = bernoulli(2 * k, work);
    if (B2k.mantissa === 0n) {
      // Shouldn't happen for B_{2k} with k ≥ 1 except by precision underflow.
      break;
    }
    const denomCoeff = fromInt(BigInt(2 * k * (2 * k - 1)), work);
    const term = div(mul(B2k, zPow, work), denomCoeff, work);
    // Track magnitude (in bits below 1) to detect when we've hit the
    // smallest term and the series is starting to diverge.
    const termAbsMan = term.mantissa < 0n ? -term.mantissa : term.mantissa;
    const termBits = bitLength(termAbsMan);
    const termMag = term.exponent + termBits; // log2 floor of |term|.
    // If we've reached our precision target, stop.
    if (termMag < -prec - 16) {
      result = add(result, term, work);
      break;
    }
    // If the term is bigger than the previous one, the asymptotic series is
    // diverging — stop *before* adding this term.
    if (termMag > prevTermMag) {
      break;
    }
    result = add(result, term, work);
    prevTermMag = termMag;
    // Advance to next iteration: 1/z^{2(k+1)-1} = 1/z^{2k+1} = current * 1/z².
    zPow = mul(zPow, oneOverZ2, work);
  }
  return normalise(result.mantissa, result.exponent, prec);
}

/**
 * `log |Γ(z)|` for real z, including z ≤ 0. Uses reflection at non-
 * positive z. Throws at non-positive integers (poles of Γ).
 *
 * The reflection branch (`z < 0`) is the real-argument sibling of
 * `clgammaReflect` and carried the byte-identical near-pole
 * cancellation that bead `oj5j` (worklog 117) fixed for the complex
 * path. Bead `zhrm`, this fix: write `z = m + ζ` with `m = round(z)`
 * and reduce *before* multiplying by π. The two compounding
 * cancellations the naïve form suffers are
 *
 *   1. forming `π·z` at `work = prec + 32` truncates the `π·ζ`
 *      information, which lives `≈ −log₂|ζ|` bits below `π·m`;
 *   2. `sin`'s argument reduction then re-subtracts the large integer
 *      multiple of `π/2`, re-doing the same large cancellation.
 *
 * Reducing first localises the one unavoidable cancellation to the
 * single subtraction `ζ = z − m`; the integer shift drops out by
 * periodicity, `sin(π z) = (−1)ᵐ · sin(π ζ)`, and since `log |sin|`
 * is sign-blind the `(−1)ᵐ` evaporates from the formula — we just
 * use `|sin(π ζ)|`. Working precision is bumped by the measured
 * cancellation depth `lossBits`, so the loss is *paid for*, not
 * carried as a lie about the answer.
 */
function lgammaRealAbs(z: BigFloat, prec: number): BigFloat {
  if (isZero(z)) {
    throw new RangeError(`lgamma: argument is zero (Γ has a pole)`);
  }
  if (sgn(z) > 0) {
    return lgamma(z, prec);
  }
  // Reflection: Γ(z) · Γ(1 − z) = π / sin(π z).
  // ⟹ log |Γ(z)| = log π − log |sin(π z)| − log Γ(1 − z).
  const reFloat = toFloat64(z).value;
  if (!Number.isFinite(reFloat)) {
    throw new RangeError(`lgamma: argument not finite`);
  }
  // ζ = z − m, formed first at the input's own precision so we don't
  // round-trip information through `work` before measuring it.
  const m = Math.round(reFloat);
  const inPrec = z.precision;
  const zeta0 = sub(z, fromInt(BigInt(m), inPrec), inPrec);
  // The pole: z is exactly the non-positive integer m.
  if (m <= 0 && isZero(zeta0)) {
    throw new RangeError(
      `lgamma: argument is a non-positive integer (Γ has a pole)`,
    );
  }
  // Cancellation depth: how many leading bits `z − m` annihilates.
  // For m = 0 (z in (−½, ½)) there is no integer to peel off and
  // `lossBits = 0`, so the computation is byte-identical to the
  // pre-`zhrm` code — change is confined to z ≤ −½ where the genuine
  // cancellation lives.
  const lossBits =
    m === 0 ? 0 : Math.max(0, zMagBits(z) - zMagBits(zeta0));
  const work = prec + 32 + lossBits;
  // Re-form ζ at the bumped working precision.
  const zeta =
    m === 0 ? z : sub(z, fromInt(BigInt(m), work), work);
  const piW = pi(work);
  // sin(π ζ) at small ζ — `sin`'s own reduction does no spurious work
  // here because `π · ζ` is genuinely small, not a delta around a large
  // multiple of `π/2`. `|sin(π ζ)|` is what enters `log`; the
  // `(−1)ᵐ` sign from `sin(π z) = (−1)ᵐ sin(π ζ)` is irrelevant under
  // the absolute value.
  const sinPiZeta = sin(mul(piW, zeta, work), work);
  const oneMinusZ = sub(fromInt(1n, work), z, work);
  const result = sub(
    sub(log(piW, work), log(abs(sinPiZeta), work), work),
    lgamma(oneMinusZ, work),
    work,
  );
  return normalise(result.mantissa, result.exponent, prec);
}

/**
 * `log₂ |x|` to integer precision; `-Infinity` for x = 0. Mirrors the
 * `magBits` helper in `complex.ts` (`zhrm` shares the
 * cancellation-depth measurement with `oj5j`).
 */
function zMagBits(x: BigFloat): number {
  if (x.mantissa === 0n) return -Infinity;
  const m = x.mantissa < 0n ? -x.mantissa : x.mantissa;
  return x.exponent + m.toString(2).length;
}

/**
 * `Γ(z)` for real argument. Throws at non-positive integers.
 *
 * For `z > 0`: gamma(z) = exp(lgamma(z)).
 * For `z < 0` non-integer: gamma(z) = sign · exp(lgammaRealAbs(z)),
 * where the sign follows from
 *
 *     sgn(Γ(z)) = sgn(sin(π z))                  (since Γ(1−z) > 0 for z < 0)
 *               = sgn((−1)ᵐ · sin(π ζ))           (z = m + ζ, m = round(z))
 *               = (−1)ᵐ · sgn(ζ)                 (sin is monotone near 0,
 *                                                  |ζ| ≤ ½ ⇒ sgn(sinπζ) = sgn(ζ))
 *
 * which is *exact* — no `sin` call, no precision loss, no near-pole
 * `sgn` collapse. The pre-`zhrm` code formed `sin(π z)` at
 * `work = prec + 32` *purely to read its sign*; for a z ε-close to a
 * pole the value would be annihilated to zero and `sgn` would return 0,
 * triggering a spurious "pole at z" `RangeError` even though z was
 * merely *near* a pole, not at one. The algebraic-identity sign
 * detection is the right tool here — the sign is a structural fact
 * about which interval z lies in, not something we need a numeric
 * computation to discover. (Bead `zhrm`.)
 */
export function gamma(z: BigFloat, prec: number): BigFloat {
  if (sgn(z) > 0) {
    return exp(lgamma(z, prec + 32), prec);
  }
  if (isZero(z)) {
    throw new RangeError(`gamma: argument is zero (Γ has a pole)`);
  }
  // z = m + ζ. The pole detection is the *only* one needed — the sign
  // is then read off `m` and `sgn(ζ)` algebraically.
  const reFloat = toFloat64(z).value;
  if (!Number.isFinite(reFloat)) {
    throw new RangeError(`gamma: argument not finite`);
  }
  const m = Math.round(reFloat);
  const zeta = sub(z, fromInt(BigInt(m), z.precision), z.precision);
  if (m <= 0 && isZero(zeta)) {
    throw new RangeError(`gamma: argument is a non-positive integer (Γ has a pole)`);
  }
  // sign = (−1)ᵐ · sgn(ζ). `m % 2 === 0` covers m = 0 cleanly too,
  // since 0 is even and (−1)⁰ = 1. `sgn(zeta)` here is exact —
  // `zeta` is a real subtraction `z − m`, its sign is a structural
  // property of the input, not a derived numerical quantity.
  const zetaSgn = sgn(zeta);
  if (zetaSgn === 0) {
    // Unreachable: m === round(z), if zeta is zero then z is integer
    // and we returned above. Kept as a defensive check.
    throw new RangeError(`gamma: pole at ${reFloat}`);
  }
  const sign = (m % 2 === 0 ? zetaSgn : -zetaSgn) as 1 | -1;
  const work = prec + 32;
  const absG = exp(lgammaRealAbs(z, work), work);
  const signedG = sign === 1 ? absG : neg(absG);
  return normalise(signedG.mantissa, signedG.exponent, prec);
}

/**
 * `ψ(z)` (digamma) for real `z`. Throws at non-positive integers
 * (`z ∈ {0, −1, −2, …}`), where ψ has simple poles.
 *
 * For `z > 0`: shift `z` up to `z + N` with `N` large enough for the
 * Stirling-style asymptotic, then use `ψ(z) = ψ(z+N) − Σ_{k=0}^{N−1}
 * 1/(z+k)`.
 *
 * For `z < 0` non-integer: reflection (DLMF §5.5.4),
 *
 *     ψ(1 − z) − ψ(z) = π · cot(π z)
 *   ⟹ ψ(z) = ψ(1 − z) − π · cot(π z)             — note the MINUS.
 *
 * The sign is load-bearing. An earlier draft of the surrounding R2/PHASE2
 * narratives had `+ π · cot(π z)` here; at half-integer z (cot = 0) the
 * mistake is invisible, but at e.g. z = −0.3 (mpmath gold ψ(−0.3) ≈
 * +2.1124, ψ(1.3) ≈ −0.1694, π · cot(−0.3π) ≈ −2.2818) the wrong sign
 * yields ψ(1.3) + π·cot(−0.3π) ≈ −2.4513 — wrong magnitude AND wrong
 * sign. The tests below pin this with at least one non-half-integer
 * negative argument.
 *
 * Numerical conditioning: `cot(π z)` carries the same near-pole
 * catastrophic cancellation that bead `oj5j` (worklog 117) fixed for the
 * complex path in `cdigammaReflect` — `cot` has simple poles at the
 * integers, so an ε-close `z = m + ζ` makes `cot(π z) ≈ 1/(π ζ)`
 * enormous, and a naïve `cos(π z) / sin(π z)` truncates the `ζ`
 * information when it forms `π · z`. The real-axis cure mirrors the
 * complex one byte-for-byte: reduce `ζ = z − round(z)` *before*
 * multiplying by π. `cot` is π-periodic, so the integer shift drops
 * out entirely (no `(−1)ᵐ` sign to carry), and `cot(π z) = cot(π ζ)`
 * with `ζ ∈ [−½, ½]`. The cancellation depth `lossBits = magBits(z) −
 * magBits(ζ)` is folded into the working precision so the loss is
 * *paid for*, not silently swallowed.
 *
 * For `trigamma`, see the analogous reflection (DLMF §5.15.6 at n = 1)
 * in that function's docstring.
 */
export function digamma(z: BigFloat, prec: number): BigFloat {
  if (sgn(z) <= 0) {
    return digammaReflect(z, prec);
  }
  // Same precision-bump rationale as lgamma.
  const work = prec + 96;
  const shiftThreshold = Math.max(8, Math.ceil(work / 8));
  const zFloat = toFloat64(z).value;
  if (!Number.isFinite(zFloat)) {
    throw new RangeError(`digamma: argument too large`);
  }
  const N = Math.max(0, Math.ceil(shiftThreshold - zFloat));
  // ψ(z) = ψ(z+N) - Σ_{k=0}^{N-1} 1/(z+k).
  const zShifted = N > 0 ? add(z, fromInt(BigInt(N), work), work) : z;
  let result = digammaStirling(zShifted, work);
  for (let k = 0; k < N; k++) {
    const zk = add(z, fromInt(BigInt(k), work), work);
    result = sub(result, div(fromInt(1n, work), zk, work), work);
  }
  return normalise(result.mantissa, result.exponent, prec);
}

/**
 * Stirling-style series for ψ(z) at large z.
 *   ψ(z) = log z − 1/(2z) − Σ_{k=1}^{N} B_{2k} / (2k · z^{2k})
 */
function digammaStirling(z: BigFloat, prec: number): BigFloat {
  const work = prec + 32;
  const logZ = log(z, work);
  const oneOverZ = div(fromInt(1n, work), z, work);
  const halfOverZ = div(oneOverZ, fromInt(2n, work), work);
  let result = sub(logZ, halfOverZ, work);
  const oneOverZ2 = mul(oneOverZ, oneOverZ, work);
  let zPow = oneOverZ2; // 1/z^(2k) starting at k=1.
  let prevTermMag = Infinity;
  for (let k = 1; k <= 300; k++) {
    const B2k = bernoulli(2 * k, work);
    if (B2k.mantissa === 0n) break;
    const denomCoeff = fromInt(BigInt(2 * k), work);
    const term = div(mul(B2k, zPow, work), denomCoeff, work);
    const termAbsMan = term.mantissa < 0n ? -term.mantissa : term.mantissa;
    const termBits = bitLength(termAbsMan);
    const termMag = term.exponent + termBits;
    if (termMag < -prec - 16) {
      result = sub(result, term, work);
      break;
    }
    if (termMag > prevTermMag) break;
    result = sub(result, term, work);
    prevTermMag = termMag;
    zPow = mul(zPow, oneOverZ2, work);
  }
  return normalise(result.mantissa, result.exponent, prec);
}

/**
 * Reflection branch of `digamma` for `z ≤ 0`:
 *
 *     ψ(z) = ψ(1 − z) − π · cot(π z)            (DLMF §5.5.4, rearranged).
 *
 * The real-axis sibling of `cdigammaReflect` (`complex.ts`, bead `oj5j` /
 * worklog 117). Same near-pole cancellation cure: write `z = m + ζ` with
 * `m = round(z)` and reduce ζ *before* multiplying by π. `cot` is
 * π-periodic so `cot(π z) = cot(π ζ)` exactly — no `(−1)ᵐ` to carry.
 * Working precision is bumped by the measured cancellation depth
 * `lossBits = magBits(z) − magBits(ζ)` so the truncation loss the
 * reduction surfaces is genuinely paid for. For `m = 0` (z in (−½, ½))
 * the lossBits is zero and the path is byte-identical to the unreduced
 * naïve form modulo the reflection itself.
 *
 * Throws at exact non-positive integers (`z = m, m ≤ 0`, ζ = 0) — the
 * actual poles of ψ. The pole check has to happen *after* the
 * reduction is formed (so the integer detection is exact at the input's
 * own precision), but *before* the work-bump (so we don't waste
 * arithmetic on an input we're about to reject).
 */
function digammaReflect(z: BigFloat, prec: number): BigFloat {
  // Pole detection at z = 0: ζ = z − 0 = z, but we want to surface a
  // dedicated message for the most common pole case.
  if (isZero(z)) {
    throw new RangeError(`digamma: argument is zero (ψ has a pole)`);
  }
  const reFloat = toFloat64(z).value;
  if (!Number.isFinite(reFloat)) {
    throw new RangeError(`digamma: argument not finite`);
  }
  const m = Math.round(reFloat);
  const inPrec = z.precision;
  // ζ = z − m, formed at the input's own precision so we measure the
  // cancellation against the input — not against a reformed-at-`work`
  // copy that's already lost the leading-bit information.
  const zeta0 = m === 0 ? z : sub(z, fromInt(BigInt(m), inPrec), inPrec);
  if (m <= 0 && isZero(zeta0)) {
    throw new RangeError(
      `digamma: argument is a non-positive integer (ψ has a pole)`,
    );
  }
  // Cancellation depth: how many leading bits `z − m` annihilates.
  // For `m = 0` no integer is peeled off and `lossBits = 0`.
  const lossBits =
    m === 0 ? 0 : Math.max(0, zMagBits(z) - zMagBits(zeta0));
  const work = prec + 32 + lossBits;
  // Re-form ζ at the bumped working precision.
  const zeta = m === 0 ? z : sub(z, fromInt(BigInt(m), work), work);
  const piW = pi(work);
  // π · ζ at the working precision — small magnitude when z is near
  // an integer, well-conditioned for `sin` / `cos` since the trig
  // reduction has no large-multiple-of-π/2 to peel off.
  const piZeta = mul(piW, zeta, work);
  const sinPiZeta = sin(piZeta, work);
  const cosPiZeta = cos(piZeta, work);
  // `sinPiZeta` is zero exactly when ζ ∈ {0, ±1, …} ∩ [−½, ½] — i.e.
  // ζ = 0 — which we've already rejected above (`isZero(zeta0)`).
  // A defensive throw here would only fire on a genuine substrate
  // failure (sin's argument reduction collapsing a non-zero input to
  // zero); we let `div` raise that naturally.
  const cotPiZ = div(cosPiZeta, sinPiZeta, work);
  const piCot = mul(piW, cotPiZ, work);
  // ψ(1 − z): 1 − z is far from every non-positive-integer pole when z
  // is near one (1 − z is near a *positive* integer there), so the
  // recursive call enters the positive branch and never recurses.
  const oneMinusZ = sub(fromInt(1n, work), z, work);
  const result = sub(digamma(oneMinusZ, work), piCot, work);
  return normalise(result.mantissa, result.exponent, prec);
}

/**
 * Trigamma  ψ'(z) for real z. Throws at non-positive integers (poles).
 *
 * For `z > 0`: shift up via the recurrence `ψ'(z) = ψ'(z+1) + 1/z²` and
 * Stirling-style series at large z.
 *
 * For `z < 0` non-integer: reflection (DLMF §5.15.6 at n = 1),
 *
 *     ψ'(1 − z) + ψ'(z) = (π / sin(π z))²
 *   ⟹ ψ'(z) = (π / sin(π z))² − ψ'(1 − z).
 *
 * Sign: PLUS-on-LHS / MINUS-on-rearranged — opposite to digamma. The
 * `1/sin²(π z)` term is even in `m` (sin² is integer-shift-invariant up
 * to sign-then-squared), so the integer shift drops out cleanly:
 * `1/sin²(π z) = 1/sin²(π ζ)`. Same lossBits accounting as
 * `digammaReflect`; the `1/sin² ≈ 1/(π ζ)²` blowup near integer ζ is
 * even more aggressive than ψ's `1/(π ζ)`, so the working-precision
 * bump is more load-bearing here, not less.
 *
 * v0.1 ships only m = 0 (digamma) and m = 1 (trigamma); higher m via
 * Hurwitz-zeta lands in v0.2.
 */
export function trigamma(z: BigFloat, prec: number): BigFloat {
  if (sgn(z) <= 0) {
    return trigammaReflect(z, prec);
  }
  const work = prec + 96;
  const shiftThreshold = Math.max(8, Math.ceil(work / 8));
  const zFloat = toFloat64(z).value;
  if (!Number.isFinite(zFloat)) {
    throw new RangeError(`trigamma: argument too large`);
  }
  const N = Math.max(0, Math.ceil(shiftThreshold - zFloat));
  const zShifted = N > 0 ? add(z, fromInt(BigInt(N), work), work) : z;
  let result = trigammaStirling(zShifted, work);
  // ψ'(z) = ψ'(z+1) + 1/z²  ⟹  ψ'(z) = ψ'(z+N) + Σ_{k=0}^{N-1} 1/(z+k)².
  for (let k = 0; k < N; k++) {
    const zk = add(z, fromInt(BigInt(k), work), work);
    const inv2 = div(fromInt(1n, work), mul(zk, zk, work), work);
    result = add(result, inv2, work);
  }
  return normalise(result.mantissa, result.exponent, prec);
}

/**
 * Stirling-style series for ψ'(z) at large z.
 *   ψ'(z) = 1/z + 1/(2z²) + Σ_{k=1}^{N} B_{2k} / z^{2k+1}
 */
function trigammaStirling(z: BigFloat, prec: number): BigFloat {
  const work = prec + 32;
  const oneOverZ = div(fromInt(1n, work), z, work);
  const oneOverZ2 = mul(oneOverZ, oneOverZ, work);
  let result = add(oneOverZ, div(oneOverZ2, fromInt(2n, work), work), work);
  let zPow = mul(oneOverZ2, oneOverZ, work); // 1/z^3 = 1/z^(2k+1) for k=1.
  let prevTermMag = Infinity;
  for (let k = 1; k <= 300; k++) {
    const B2k = bernoulli(2 * k, work);
    if (B2k.mantissa === 0n) break;
    const term = mul(B2k, zPow, work);
    const termAbsMan = term.mantissa < 0n ? -term.mantissa : term.mantissa;
    const termBits = bitLength(termAbsMan);
    const termMag = term.exponent + termBits;
    if (termMag < -prec - 16) {
      result = add(result, term, work);
      break;
    }
    if (termMag > prevTermMag) break;
    result = add(result, term, work);
    prevTermMag = termMag;
    zPow = mul(zPow, oneOverZ2, work);
  }
  return normalise(result.mantissa, result.exponent, prec);
}

/**
 * Reflection branch of `trigamma` for `z ≤ 0`:
 *
 *     ψ'(z) = (π / sin(π z))² − ψ'(1 − z)       (DLMF §5.15.6 at n = 1).
 *
 * Mirrors `digammaReflect` byte-for-byte in structure: pole detection,
 * `ζ = z − round(z)`, `lossBits` measurement, `work = prec + 32 +
 * lossBits`, then reduce the trig argument before multiplying by π.
 * `sin(π z) = (−1)ᵐ sin(π ζ)`, but only `sin²` enters the formula so
 * the `(−1)ᵐ` evaporates: `(π / sin(π z))² = (π / sin(π ζ))²`.
 *
 * The 1/sin² blowup near a pole is `≈ 1/(π ζ)²` — quadratic, where
 * `digamma`'s cot was linear — so the `lossBits` bump is even more
 * load-bearing. Dropping it would lose ~2 · log₁₀|ζ| digits at z near
 * −n, not ~log₁₀|ζ|.
 */
function trigammaReflect(z: BigFloat, prec: number): BigFloat {
  if (isZero(z)) {
    throw new RangeError(`trigamma: argument is zero (ψ' has a pole)`);
  }
  const reFloat = toFloat64(z).value;
  if (!Number.isFinite(reFloat)) {
    throw new RangeError(`trigamma: argument not finite`);
  }
  const m = Math.round(reFloat);
  const inPrec = z.precision;
  const zeta0 = m === 0 ? z : sub(z, fromInt(BigInt(m), inPrec), inPrec);
  if (m <= 0 && isZero(zeta0)) {
    throw new RangeError(
      `trigamma: argument is a non-positive integer (ψ' has a pole)`,
    );
  }
  const lossBits =
    m === 0 ? 0 : Math.max(0, zMagBits(z) - zMagBits(zeta0));
  const work = prec + 32 + lossBits;
  const zeta = m === 0 ? z : sub(z, fromInt(BigInt(m), work), work);
  const piW = pi(work);
  const piZeta = mul(piW, zeta, work);
  const sinPiZeta = sin(piZeta, work);
  // (π / sin(π ζ))²
  const piOverSin = div(piW, sinPiZeta, work);
  const piOverSinSq = mul(piOverSin, piOverSin, work);
  const oneMinusZ = sub(fromInt(1n, work), z, work);
  const result = sub(piOverSinSq, trigamma(oneMinusZ, work), work);
  return normalise(result.mantissa, result.exponent, prec);
}

/**
 * `ψ^(m)(z)` for `m ≥ 2`, real `z > 0`, via the Hurwitz-zeta route.
 *
 * Algorithm (R2 §2.2, PHASE2-impl-plans §I1b, mirroring Boost.Math's
 * `polygamma_atinfinityplus`):
 *
 *   1. Identity (DLMF §5.15.2):
 *          ψ^(m)(z) = (-1)^(m+1) · m! · ζ(m+1, z)        m ≥ 1.
 *
 *   2. Recurrence shift (DLMF §5.15.5):
 *          ψ^(m)(z) = ψ^(m)(z+N)  −  (-1)^m · m! · Σ_{k=0}^{N-1} (z+k)^{-(m+1)}.
 *      Choose N so `z + N > shiftThreshold ≈ 0.17·(prec + 2m + 96)`,
 *      large enough for the Euler-Maclaurin asymptotic at step 3.
 *
 *   3. Evaluate `ζ(m+1, z)` via the standalone Hurwitz-zeta substrate
 *      `bigHurwitzZeta` (`special-funcs/zeta.ts`). That function is itself
 *      self-shifting — it owns the recurrence shift internally — so the
 *      decomposition `ζ(m+1, z) = Σ_{k<N}(z+k)^{-(m+1)} + ζ(m+1, z+N)`
 *      that v0.1 spelled out by hand here is now encapsulated. We hand it
 *      the *already-margined* working precision `work` (see below) so its
 *      internal precision schedule reproduces, to the bit, what the v0.1
 *      inline helper produced — `bigHurwitzZeta` deliberately does not add
 *      its own outer margin, which is what keeps this path byte-identical
 *      across the ADR-0042 §Decision 12 extraction.
 *
 *   4. Multiply by `(-1)^(m+1) · m!` to recover `ψ^(m)(z)`:
 *          ψ^(m)(z) = (-1)^(m+1) · m! · ζ(m+1, z).
 *
 * Why the shift is non-optional: the Euler-Maclaurin series inside
 * `bigHurwitzZeta` is Poincaré-asymptotic in 1/z, and the (s)_{2k-1}
 * Pochhammer factor grows like (2k)! / m!, so at small `z` even the
 * smallest term is large and we cannot reach `2^-prec` accuracy. The
 * shift trades `N ≈ shiftThreshold − z` arithmetic operations for an
 * asymptotic series that actually converges to the noise floor — and it
 * now lives where it belongs, inside the zeta substrate.
 *
 * MUTATION-PROOF MARKERS this function pins:
 *   M1. The leading sign is `(-1)^(m+1)`. Flipping to `(-1)^m` changes
 *       the sign of every output; `polygamma(2, 1) = −2ζ(3)` flips
 *       sign and the golden test goes RED.
 *   M2. The Hurwitz-zeta order is `m + 1`, not `m`. The identity
 *       `ψ^(m)(z) = (-1)^(m+1) · m! · ζ(m+1, z)` (DLMF §5.15.2) is an
 *       order-`m+1` zeta; passing `m` evaluates the wrong function and
 *       `polygamma(2, 1)` mismatches `−2ζ(3)`.
 *   M3. The factorial multiplier is `m!`, not `(m+1)!` or `(m-1)!`.
 *       `polygamma(3, 1) = 3! · ζ(4) = π⁴/15`; a wrong factorial scales
 *       the answer and the golden goes RED.
 *
 * Domain: real `z > 0`. The reflection branch (DLMF §5.15.6, involving
 * derivatives of `cot(π z)`) is deferred to v0.2; for `z ≤ 0` this
 * function throws, matching the behaviour of `trigamma` pre-`zhrm`
 * historically (the I1a / digamma-trigamma-reflection bead is the
 * parallel lift that adds reflection for m = 0, 1).
 */
function polygammaHurwitz(m: number, z: BigFloat, prec: number): BigFloat {
  if (sgn(z) <= 0) {
    // Reflection for m ≥ 2 deferred — see docstring.
    throw new RangeError(
      `polygamma: m ≥ 2 with z ≤ 0 not implemented (reflection branch deferred to v0.2)`,
    );
  }
  // Working precision: bump by 96 bits as for the digamma/trigamma path,
  // plus extra room for the factorial(m!) multiplier which contributes
  // about `m · log2(m)` bits of magnitude that can amplify rounding.
  // Appendix B prescription: `work = prec + 96 + 2 · ceil(log2(m + 1))`.
  const work = prec + 96 + 2 * Math.ceil(Math.log2(m + 1));
  const zFloat = toFloat64(z).value;
  if (!Number.isFinite(zFloat)) {
    throw new RangeError(`polygamma: argument too large`);
  }
  // ζ(m+1, z) via the standalone self-shifting Hurwitz-zeta substrate.
  // `bigHurwitzZeta` internally applies the recurrence shift past
  // `hurwitzShiftThreshold(work, m+1)` — which is exactly the historical
  // `max(8, ceil(0.17·(prec+2m+96)))` with `prec` replaced by `work` and
  // `m = (m+1)-1` — then runs the Euler-Maclaurin core. Handing it `work`
  // (rather than `prec`) means it reproduces the v0.1 inline computation
  // bit-for-bit; see step 3 of the docstring above.
  const zetaTotal = bigHurwitzZeta(m + 1, z, work);
  // m! as a BigInt; convert once to BigFloat. m is small (typical use
  // m ∈ [2, 20]), so the BigInt factorial is cheap and exact.
  let factM = 1n;
  for (let i = 2; i <= m; i++) factM *= BigInt(i);
  const factMBF = fromInt(factM, work);
  // Sign: (-1)^(m+1). Even m ⇒ sign = -1; odd m ⇒ sign = +1.
  const signed =
    m % 2 === 0 ? neg(mul(factMBF, zetaTotal, work)) : mul(factMBF, zetaTotal, work);
  return normalise(signed.mantissa, signed.exponent, prec);
}

/**
 * `polygamma(m, z)` = ψ^(m)(z), the m-th derivative of digamma.
 *
 * Dispatch by order:
 *   m = 0: delegate to `digamma` (the m=0 polygamma is the digamma itself).
 *   m = 1: delegate to `trigamma` (the dedicated Stirling-style series is
 *          slightly cheaper than the general Hurwitz route, and the
 *          existing tests pin it byte-identical).
 *   m ≥ 2: route through `polygammaHurwitz` — the Hurwitz-zeta /
 *          Euler-Maclaurin algorithm described above (R2 §2.2).
 *
 * The trigamma vs polygamma-m≥2 split is by design, not by accident.
 * `trigamma`'s series `ψ'(z) = 1/z + 1/(2z²) + Σ B_{2k}/z^{2k+1}` is
 * just the m=1 specialisation of the Euler-Maclaurin Hurwitz formula
 * — but it's been in the codebase since v0.1 with golden tests pinning
 * it to 50 decimal places, so re-routing it through the generic helper
 * would change exactly nothing observable and would risk byte-level
 * regression. Keep the specialised path; let `polygammaHurwitz` handle
 * the m ≥ 2 case it was designed for.
 *
 * Hallucination warning: `m = 0` is NOT a special case of the Hurwitz
 * identity — `ψ^(0)(z) = ψ(z) = -γ + Σ (1/k − 1/(z+k-1))` is finite,
 * but `ζ(1, z)` diverges (the Hurwitz zeta has a simple pole at s = 1).
 * The identity `ψ^(m)(z) = (-1)^(m+1) · m! · ζ(m+1, z)` requires `m ≥ 1`
 * for this reason. Hence the dispatch routes m=0 to `digamma` directly.
 */
export function polygamma(m: number, z: BigFloat, prec: number): BigFloat {
  if (!Number.isInteger(m) || m < 0) {
    throw new RangeError(`polygamma: order must be a non-negative integer; got ${m}`);
  }
  if (m === 0) return digamma(z, prec);
  if (m === 1) return trigamma(z, prec);
  return polygammaHurwitz(m, z, prec);
}
