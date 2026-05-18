// =============================================================================
// @workbench/bigfloat — real-axis error function `erf` (arb-prec)
// =============================================================================
//
// This module ships the arb-prec real-axis entry points of the Erf family:
//
//   bigErf(x, prec)    — error function
//   bigErfc(x, prec)   — complementary error function (DIRECT, not `1 - bigErf`)
//   bigErfcx(x, prec)  — scaled complementary (DIRECT, not `exp(x²)·bigErfc(x)`)
//
// plus the three substrate primitives those entry points (and the complex
// extensions in I3) hoist on top of:
//
//   bigErfSeries               — DLMF 7.6.2 Borel form (all-positive terms).
//   bigErfcAsymptotic          — DLMF 7.12.1 asymptotic with optimal truncation.
//   bigErfcContinuedFraction   — DLMF 7.9.1 Laplace continued fraction.
//
// ADR-0040 §"Decision 3" pins the per-head signature and the algorithm
// dispatch; ADR-0020 pins the determinism contract this substrate must
// honour (bit-identical across runtimes forever, given fixed `prec` bits).
//
// Direct-path discipline (THE load-bearing R2 risk-mitigation)
// -------------------------------------------------------------
//
//   bigErfc is NOT 1 - bigErf for |x| > x_c — catastrophic cancellation
//   costs x²·log₂e bits.  At x = 20 (prec = 200), that's ~580 bits
//   destroyed; a 50-dps answer becomes garbage.
//
//   bigErfcx is NOT exp(x²)·bigErfc(x) for |x| > ~3 — the round-trip
//   through a quantity that grows as exp(x²) (e.g. exp(400) ≈ 5.2e173
//   at x = 20) is *representable* in BigFloat but is a strict waste of
//   limbs, and on the float64 path it would simply overflow.  The Julia
//   SpecialFunctions.jl `_erfcx(::BigFloat)` references this directly
//   (lines 27-40); we adopt the same direct rational-form asymptotic.
//
// Each function carries its OWN algorithm path on its OWN input range:
//
//   bigErfc dispatch:
//     |x| ≤ x_c  → small/moderate-x lane: 1 - bigErf(x) with
//                  cancellation-retry (loss ≤ ~x²·log₂e ≤ ~prec bits;
//                  the budget is *bounded* by the algorithm's structure
//                  because x_c² = prec·ln2, so x_c²·log₂e = prec exactly).
//     x > x_c    → direct asymptotic: bigErfcAsymptotic(x).
//     x < -x_c   → erfc(-|x|) = 2 - erfc(|x|) where erfc(|x|) ≈ 2^-prec
//                  by construction (we're past the asymptotic crossover);
//                  `2 - tiny` loses no bits.
//
//   bigErfcx dispatch:
//     |x| ≤ x_c  → small-x lane: exp(x²) · bigErfc(x).  Both factors
//                  finite and well-conditioned in this regime;
//                  exp(x_c²) = exp(prec·ln2) = 2^prec is large but
//                  *representable* in BigFloat with int32 exponent
//                  (BigFloat exponent range vastly exceeds float64's).
//                  Crucially, the *direct asymptotic does not converge
//                  to prec bits* until |x| > x_c — its optimal-truncation
//                  remainder is bounded by `e^(-x²) · √(π/(2x²))`, which
//                  is precisely `2^-prec` at the same x_c the erfc
//                  dispatch uses.  R2 §1.8 pins this: the bigErfcx
//                  threshold *is* the bigErfc asymptotic threshold.
//                  (An impl-plan stand-in of "|x| < 3" looked plausible
//                  but does not converge at moderate x — at x = 4 the
//                  asymptotic diverges at the 7th digit; verified by
//                  experiment before this code shipped.)
//     |x| > x_c  → direct asymptotic series with the same (2m-1)!! / (2x²)^m
//                  coefficient ring as bigErfcAsymptotic, but WITHOUT the
//                  e^(-x²) prefactor.  Optimal-truncation idiom identical
//                  to bigErfcAsymptotic.  For negative x in this regime,
//                  use erfcx(-|x|) = 2·exp(x²) - erfcx(|x|) — note 2·exp(x²)
//                  IS the answer up to a tiny correction; no cancellation.
//
// The bigErfc small-x lane is the only place in this module where the
// cancellation-retry pattern (mirroring clgammaReflect, worklog 117) is
// actually exercised: bigErf's small lane uses Borel series (zero
// cancellation), and bigErf's large lane uses asymptotic-via-1-minus
// where the subtracted quantity is < 2^-prec by construction.  I1's
// retry slot was wired but did not trigger; I2 is the first bead to fire
// it on the path where it matters.
//
// Algorithm narrative
// -------------------
//
// `erf(x) = (2/√π) ∫₀ˣ e^(-t²) dt`.  Three regimes, two natural algorithms:
//
//   small |x|       → power series                              (always converges)
//   moderate |x|    → power series                              (rate ≈ x²/n)
//   large |x|       → asymptotic for `erfc(x)`, then `1 − erfc` (cancellation-free)
//
// The crossover is precision-dependent:
//
//   x_c(p) := √(p · ln 2)
//
// derived from "the Poincaré remainder of the asymptotic at the optimal
// truncation index is smaller than 2^-p".  At p = 200 bits (≈ 60 dps),
// x_c ≈ 11.78.  At p = 53 bits (≈ float64), x_c ≈ 6.06.  For the corpus
// tier T1 (|x| ≤ 0.84) and T2 (|x| ≤ 6) every input sits inside x_c; T3
// (|x| > 6) belongs to bigErfc only — at large x, `erf` saturates within
// `prec` bits of 1 and the answer-bearing magnitude lives in `erfc`.
//
// The textbook Maclaurin trap (DLMF 7.6.1, the load-bearing R2 finding)
// -----------------------------------------------------------------------
//
// The series everyone learns first is the alternating form
//
//   erf(x) = (2/√π) · Σ_{n≥0}  (-1)^n · x^(2n+1) / (n! · (2n+1))            (7.6.1)
//
// which is mathematically equivalent to the Borel-summed form
//
//   erf(x) = (2/√π) · x · e^(-x²) · Σ_{n≥0}  (2x²)^n / (1·3·5·…·(2n+1))     (7.6.2)
//
// but numerically catastrophic for `|x|² > p · ln 2`.  In 7.6.1, the
// alternating signs annihilate: each consecutive pair `term_{2k} +
// term_{2k+1}` is roughly `x^(4k+1) · (1 − x² / (2k+1) · …)`, and at the
// magnitude peak (around `n ≈ x²`) the term is `≈ exp(x²) / √(2πx²)` —
// orders of magnitude larger than the final answer `erf(x) ≤ 1`.  The
// cancellation discards `x² · log₂ e` bits.  At x = 5 (p = 200), ~36 bits
// gone; at x = 8, ~92 bits gone; at x = 20, ~580 bits gone — a 50-dps
// answer becomes garbage.
//
// The Borel form 7.6.2 has *zero* alternation: every term in the sum is
// positive, the prefactor `e^(-x²)` carries the magnitude attenuation
// outside the summation, and the recurrence
//
//   term_{n+1} = term_n · 2x² / (2n + 3),   term_0 = 1,
//
// is a single ratio with no cancellation anywhere in the partial-sum path.
// mpmath uses this internally for `mp.erf`; SymPy, Arb (`arb_hypgeom_erf`),
// and SciPy's reference all default to Borel for the arb-prec lane.  This
// substrate adopts 7.6.2 for the same numerical reason.  See R2 §1.2 and
// §"Top-3 risks" in `docs/refs/erf-research/R2-arbprec-algorithms.md`.
//
// Why a precision-bumped working margin is *not* enough
// -----------------------------------------------------
//
// One might think "just bump `work = prec + x² · log₂ e` and use 7.6.1
// directly".  The bit-budget is technically correct, but the *cost*
// grows quadratically in `|x|`:
//
//   - 7.6.1 needs ~ `e · x²` terms to converge regardless (the peak
//     magnitude is at `n ≈ x²`);
//   - 7.6.2 needs the same `~x²` terms, but each term is `O(prec + small)`
//     bits, not `O(prec + x²)` bits.
//
// At x = 8 (a perfectly mundane T2 input) and prec = 200, that's a 92-bit
// difference per BigInt — 7.6.1 limbs are 292 bits, 7.6.2 limbs are 200
// bits.  Multiplication is super-linear in limb count; the cost of the
// "just bump" approach scales as O(x²) per term times O(x²) terms times
// O((prec + x²)^1.6) per multiplication.  Borel is strictly better by
// every measure once `x² > prec / 10` or so, which is true for almost
// every interesting input.  This is structural, not a constant-factor
// tweak — pick the right algorithm and the cancellation problem doesn't
// exist.
//
// Optimal-truncation idiom (asymptotic series)
// --------------------------------------------
//
// `bigErfcAsymptotic` evaluates the divergent asymptotic
//
//   erfc(x) ∼ (e^(-x²) / (√π · x)) · Σ_{m≥0}  (-1)^m · (2m-1)!! / (2x²)^m
//
// truncated at the smallest term — the "optimal truncation" idiom from
// `lgammaStirling` (`packages/bigfloat/src/special.ts:117-160`).  The series
// is asymptotic: it diverges if you sum every term, but truncating just
// before the term magnitude starts to grow gives an error bounded by the
// magnitude of the first omitted term.  The loop tracks `prevTermMag` and
// breaks the instant `termMag > prevTermMag`.  At `x = x_c`, the optimal
// truncation index is `m ≈ p/2`; at larger `x`, fewer terms are needed.
//
// Continued-fraction lane
// -----------------------
//
// `bigErfcContinuedFraction` evaluates the Laplace CF (DLMF 7.9.1)
//
//   √π · x · e^(x²) · erfc(x) = 1 / (x² + (1/2)/(1 + 1/(x² + (3/2)/(1 + 2/(x² + ...)))))
//
// via the modified Lentz algorithm (Numerical Recipes §5.2).  Converges
// for `Re(x) > 0` with rate ~ 1/x² per cycle, so the CF is most useful
// in the mid-to-large `x` band where the asymptotic is "just starting to
// be valid" but where summing far enough into the asymptotic would have
// already passed the optimal-truncation point.  In I1's bigErf dispatch
// we never need the CF directly (the asymptotic suffices for `|x| > x_c`
// because we're well above the inflection point at the chosen crossover),
// but I2's `bigErfc(x)` for the regime `x_c < |x| < some larger threshold`
// will route through it.
//
// Cancellation-driven precision retry
// -----------------------------------
//
// Mirrors `clgammaReflect` (bead `oj5j`, worklog 117) and
// `lgammaRealAbs` (bead `zhrm`, worklog 119).  The reasoning: when a
// sub-computation produces a value whose leading bits are then subtracted
// away, the lost-bit count is observable via `magBits(blowUp) -
// magBits(finalValue)`.  We measure that loss and re-run the inner
// computation at `work = prec + 32 + lossBits` — the loss is *paid for*,
// not carried as a lie.
//
// For `bigErf`'s small/moderate `x` lane the Borel form has no
// cancellation, so the only retry trigger is the `1 − erfcAsymptotic(x)`
// branch for `|x| > x_c`.  There, `erfcAsymptotic(x)` is at most
// `2^-prec`-sized by construction (we crossed at the threshold where it
// *becomes* below 2^-prec), so `1 - tiny` is harmless — no lossBits
// accumulate.  The retry slot is wired up anyway, so I2's `bigErfc` can
// hoist on top of it without re-plumbing.
//
// The pattern *does* fire on `bigErfc(x)`'s small/moderate-x lane
// (`|x| ≤ x_c`).  There, `erf(x)` is close to 1 — at x = x_c, the
// difference is exactly 2^-prec by the crossover derivation — and
// `1 - erf(x)` loses up to `x²·log₂e` bits, which is at most `prec` bits
// at the boundary.  The retry computes `loss = magBits(erfX) -
// magBits(diff)` after a first-pass at `prec + 64`, then re-runs at
// `prec + 64 + loss` if `loss > 0`.  The margin is *bounded by the
// algorithm's structure*, not by an empirical heuristic: at x = x_c we
// pay ~prec bits, at smaller x we pay less, and we never enter this lane
// for x > x_c (the direct asymptotic takes over).  The retry is therefore
// guaranteed to terminate after at most one bump — a structural
// property, not a wait-and-pray loop.
//
// References (all in repo)
// ------------------------
//   - docs/adr/0040-per-head-special-function-substrate-and-meijer-g-bridge.md
//     §"Decision 3"
//   - docs/adr/0020-arbitrary-precision-tier.md
//   - docs/refs/erf-research/R2-arbprec-algorithms.md §1.2, §2.1
//   - packages/bigfloat/src/special.ts (lgammaStirling pattern, line 117)
//   - DLMF §7.6 (series), §7.9 (continued fraction), §7.12 (asymptotic)

import { BigFloat, normalise, bitLength } from "../types.js";
import { abs, neg, sgn, cmp, isZero, lt } from "../comparison.js";
import { add, sub, mul, div, sqrt } from "../arithmetic.js";
import { fromInt, fromFloat64, toFloat64 } from "../conversion.js";
import { exp, pi } from "../transcendental.js";

// =============================================================================
// Helpers
// =============================================================================

/**
 * `log₂ |x|` to integer precision; returns `-Infinity` for `x = 0`.  Used
 * by the cancellation-tracking and the series-truncation tests.  Mirrors
 * `zMagBits` in `special.ts` and `magBits` in `complex.ts`.
 */
function magBits(x: BigFloat): number {
  if (x.mantissa === 0n) return -Infinity;
  const m = x.mantissa < 0n ? -x.mantissa : x.mantissa;
  return x.exponent + bitLength(m);
}

/**
 * Precision-dependent crossover `x_c(prec) := √(prec · ln 2)`.  Returns a
 * `Number` (used only for flow control — the crossover decision does not
 * affect output bytes; the algorithms agree to within `prec` bits on
 * either side of the boundary).
 *
 * Derived from R2 §2.1: the Poincaré remainder of the asymptotic series
 * at the optimal truncation index is `≈ exp(-x²)`; for that to fall below
 * `2^-p` we need `x² ≥ p · ln 2`.  At p = 200 bits, x_c ≈ 11.78.
 *
 * `Math.LN2` is V8's built-in `ln(2)` to ~16 dp; the imprecision in this
 * threshold cannot affect the output because (a) the threshold is used
 * only as a branch selector, (b) both branches produce mathematically
 * identical answers up to `2^-prec`, and (c) any input that crosses the
 * boundary by less than `1 ULP_float64 ≈ x_c · 2^-52` would also produce
 * indistinguishable answers from either lane.  Bit-determinism is preserved.
 */
function crossoverXc(prec: number): number {
  return Math.sqrt(prec * Math.LN2);
}

/**
 * Validate that a BigFloat input is finite-and-usable by the erf family.
 * Throws `RangeError` with a `suggestion:` line if the input is malformed
 * or beyond the convertible-to-float64 magnitude range (which is more than
 * generous — at `|x| > sqrt(709)` ≈ 26.6, `erfc(x) < 2^-1024` already, so
 * any input that overflows float64 conversion is well past where any
 * Erf-family answer is non-trivially computable).
 *
 * Validates BigFloat invariants directly (mantissa/precision/exponent
 * shape) rather than trusting the caller, so a sentinel value with a
 * nonsensical `exponent: 1_000_000` is rejected loudly.
 */
function requireFiniteErfInput(x: BigFloat, fn: string): void {
  if (!Number.isInteger(x.precision) || x.precision < 1) {
    throw new RangeError(
      `${fn}: BigFloat precision must be a positive integer; got ${x.precision}. ` +
        `suggestion: construct the input via fromString / fromInt / fromFloat64.`,
    );
  }
  if (!Number.isInteger(x.exponent) || !Number.isFinite(x.exponent)) {
    throw new RangeError(
      `${fn}: BigFloat exponent must be a finite integer; got ${x.exponent}. ` +
        `suggestion: do not construct BigFloat sentinels by hand — use fromFloat64.`,
    );
  }
  // The cheap finiteness check: the BigFloat's magnitude must be small
  // enough that a Number-typed crossover comparison makes sense. We don't
  // need toFloat64 to *succeed* (the answer-bearing computation lives in
  // BigInt land), but a wildly non-finite exponent like 1_000_000 would
  // make crossoverXc(prec) ≪ |x| trivially and lead the algorithm
  // astray; we'd rather throw early than silently emit nonsense.
  if (x.mantissa !== 0n) {
    const magnitudeBits = magBits(x);
    // |x| > 2^1000 has no Erf-family answer that is meaningfully different
    // from the saturation value (erf → ±1, erfc/erfcx → 0). We choose 1024
    // as the loud cliff because at that magnitude even
    // `BigFloat → float64` overflows, so no downstream consumer can tell
    // a finite answer from a saturated one. Substantially below this,
    // the BigFloat arithmetic still works fine — we only fence the truly
    // pathological inputs.
    if (magnitudeBits > 1024) {
      throw new RangeError(
        `${fn}: argument magnitude ~ 2^${magnitudeBits} exceeds the ` +
          `representable Erf-family domain (|x| > 2^1024). ` +
          `suggestion: at this magnitude, erf(x) = ±1 exactly within any ` +
          `arb-prec representation; use the symbolic limit instead.`,
      );
    }
  }
}

// =============================================================================
// bigErfSeries — DLMF 7.6.2 Borel form (all-positive terms)
// =============================================================================

/**
 * Power-series evaluator for `erf(x)` via the Borel-summed form (DLMF
 * 7.6.2).  All terms are positive; the alternating-cancellation problem
 * of the textbook Maclaurin (7.6.1) does not exist on this path.
 *
 * Algorithm:
 *
 *   erf(x) = (2/√π) · x · e^(-x²) · S(x)
 *   S(x)   = Σ_{n=0}^∞  (2x²)^n / (1·3·5·…·(2n+1))
 *   term_0 = 1,   term_{n+1} = term_n · (2x²) / (2n + 3)
 *
 * Convergence is super-exponential past `n ≈ x²` (the term has decay
 * factor `(2x² / (2n+3))` so once `n > x² − 1`, terms shrink geometrically
 * with ratio < 1).  Total term count for prec p ≈ x² + p / 2.
 *
 * Working precision is `prec + 64`: 64 bits of slack absorbs (a) the
 * `e^(-x²)` prefactor's relative rounding, (b) `~p` cumulative additions
 * (each contributes at most 1 ulp; log₂(p) ≈ 8 bits at p = 200), and
 * (c) the final multiplications by `2/√π` and `x`.  No catastrophic
 * cancellation anywhere on the path; the `+ 64` is empirical headroom,
 * not a load-bearing budget.
 *
 * Termination: stop when `|next_term| < |sum| · 2^-(prec + 8)`.  The
 * `+ 8` is a guard against the final few terms contributing to the last
 * bits of the rounded answer.
 */
export function bigErfSeries(x: BigFloat, prec: number): BigFloat {
  requireFiniteErfInput(x, "bigErfSeries");
  if (isZero(x)) {
    return { mantissa: 0n, exponent: 0, precision: prec };
  }
  const work = prec + 64;
  // (2x²) appears in the recurrence and in the prefactor's `exp(-x²)`;
  // compute once.
  const xSquared = mul(x, x, work);
  const twoXSquared = mul(xSquared, fromInt(2n, work), work);
  // e^(-x²) prefactor. For |x| < x_c (the dispatch's regime for this
  // routine) this is well above 2^-prec, so no underflow.
  const expNegXSquared = exp(neg(xSquared), work);
  // Series: sum starts at the n=0 term, which is 1. term tracks the
  // running n-th value; sum accumulates.
  let sum = fromInt(1n, work);
  let term = fromInt(1n, work);
  // Termination threshold: `next_term · 2^stopExp < sum`.
  const stopMagThreshold = -prec - 8;
  // Safety cap. For any |x| within the dispatch's small/moderate regime
  // (|x| ≤ x_c ≈ √(p ln 2)), the loop terminates in O(x² + p/2) ≈ O(p)
  // iterations. The cap is generous so it never triggers in practice.
  const maxTerms = Math.max(64, work * 4);
  for (let n = 0; n < maxTerms; n++) {
    // term_{n+1} = term_n * (2x²) / (2n + 3).
    const denom = fromInt(BigInt(2 * n + 3), work);
    term = div(mul(term, twoXSquared, work), denom, work);
    sum = add(sum, term, work);
    // Convergence test: term magnitude relative to sum magnitude.
    const termMag = magBits(term);
    const sumMag = magBits(sum);
    if (termMag === -Infinity) break;            // exact zero — done
    if (termMag - sumMag < stopMagThreshold) break;
  }
  // result = (2/√π) · x · e^(-x²) · sum.
  const sqrtPi = sqrt(pi(work), work);
  const twoOverSqrtPi = div(fromInt(2n, work), sqrtPi, work);
  const result = mul(
    mul(twoOverSqrtPi, x, work),
    mul(expNegXSquared, sum, work),
    work,
  );
  return normalise(result.mantissa, result.exponent, prec);
}

// =============================================================================
// bigErfcAsymptotic — DLMF 7.12.1 (optimal-truncation idiom)
// =============================================================================

/**
 * Asymptotic evaluator for `erfc(x)` at large positive `x`, via the
 * Poincaré expansion (DLMF 7.12.1):
 *
 *   erfc(x) ∼ (e^(-x²) / (√π · x)) · Σ_{m=0}^∞  (-1)^m · (2m-1)!! / (2x²)^m
 *
 * with the double-factorial recurrence `(2m+1)!! = (2m+1) · (2m-1)!!`
 * folded into the per-term ratio:
 *
 *   T_0 = 1,   T_{m+1} = T_m · (-(2m + 1) / (2x²))
 *
 * The series **diverges** if summed to infinity (Poincaré asymptotic, not
 * convergent).  Optimal truncation: track per-term magnitude; the moment
 * `|T_{m+1}| > |T_m|` we stop and return the partial sum.  The remainder
 * bound on an optimally-truncated asymptotic is the magnitude of the
 * first omitted term — better than any term we added, by construction.
 *
 * This idiom mirrors `lgammaStirling` (`packages/bigfloat/src/special.ts:117`)
 * and `digammaStirling` and `trigammaStirling`: the canonical workbench
 * pattern for Bernoulli- / double-factorial-style asymptotic series.
 *
 * Caller is responsible for ensuring `x > 0`; the asymptotic is *only*
 * useful when `|x|² · log₂ e > prec`, i.e. `|x| > x_c(prec)`.  For
 * `bigErf`'s dispatch we cross this threshold; for I2's `bigErfc` the
 * crossover is the same.  Throws on non-positive `x` so the caller knows
 * the regime they entered.
 *
 * Working precision is `prec + 32`.  The prefactor `e^(-x²) / (√π · x)`
 * contributes ~ log₂(x · √π) ≈ 5-bit error (rounded by `div`); the
 * asymptotic series itself is the cancellation-free alternating Σ at
 * x > x_c (the alternation here is benign — each pair of terms shrinks
 * by ratio `≈ (2m+1)/(2x²) < 1`, no peak magnitude excursion).
 */
export function bigErfcAsymptotic(x: BigFloat, prec: number): BigFloat {
  requireFiniteErfInput(x, "bigErfcAsymptotic");
  if (sgn(x) <= 0) {
    throw new RangeError(
      `bigErfcAsymptotic: argument must be positive; got sign ${sgn(x)}. ` +
        `suggestion: for negative x use the identity erfc(-x) = 2 - erfc(x); ` +
        `for x ≤ 0 the asymptotic regime does not apply.`,
    );
  }
  const work = prec + 32;
  // Prefactor: e^(-x²) / (√π · x).
  const xSquared = mul(x, x, work);
  const expNegXSquared = exp(neg(xSquared), work);
  const sqrtPi = sqrt(pi(work), work);
  const sqrtPiX = mul(sqrtPi, x, work);
  const prefactor = div(expNegXSquared, sqrtPiX, work);
  // Series sum. T_0 = 1.
  let sum = fromInt(1n, work);
  let term = fromInt(1n, work);
  let prevTermMag = Infinity;
  // The asymptotic recurrence step: T_{m+1} = T_m · -(2m + 1) / (2x²).
  const twoXSquared = mul(xSquared, fromInt(2n, work), work);
  // Safety cap — optimal truncation hits well before this in any sane regime.
  const maxTerms = Math.max(64, work * 2);
  for (let m = 0; m < maxTerms; m++) {
    // Form T_{m+1}.
    const numerCoeff = fromInt(BigInt(-(2 * m + 1)), work);
    term = div(mul(term, numerCoeff, work), twoXSquared, work);
    const termMag = magBits(term);
    if (termMag === -Infinity) {
      // Exact zero (unreachable for finite x at finite m; defensive).
      break;
    }
    // Optimal-truncation rule: if this term is bigger than the previous one,
    // the series is diverging — STOP without adding.
    if (termMag > prevTermMag) {
      break;
    }
    // Convergence: term magnitude below the precision floor.
    sum = add(sum, term, work);
    prevTermMag = termMag;
    if (termMag < -prec - 8) {
      break;
    }
  }
  const result = mul(prefactor, sum, work);
  return normalise(result.mantissa, result.exponent, prec);
}

// =============================================================================
// bigErfcContinuedFraction — DLMF 7.9.1 (Laplace CF, modified Lentz)
// =============================================================================

/**
 * Continued-fraction evaluator for `erfc(x)` at positive real `x`, via
 * Laplace's representation (DLMF 7.9.1):
 *
 *   erfc(x) = (e^(-x²) / √π) · CF(x²)
 *
 *   CF(s) = 1 / (s + (1/2)/(1 + 1/(s + (3/2)/(1 + 2/(s + ...)))))
 *
 * which we evaluate by the modified Lentz method (Numerical Recipes in C
 * §5.2).  The CF converges for `Re(z) > 0`, with convergence rate
 * ~ 1/x² per *pair* of cycles — fast at large x, slow near x = 0.
 *
 * Coefficient pattern, written as `b_0 + a_1/(b_1 + a_2/(b_2 + ...))`:
 *
 *   b_0 = x²
 *   a_1 = 1/2, b_1 = 1
 *   a_2 = 1,   b_2 = x²
 *   a_3 = 3/2, b_3 = 1
 *   a_4 = 2,   b_4 = x²
 *   a_5 = 5/2, b_5 = 1
 *   a_6 = 3,   b_6 = x²
 *   ...
 *
 * Modified Lentz: maintain `f`, `C`, `D` such that `f_n ≈ b_0 + a_1/b_1 +
 * a_1·a_2/(b_1·b_2) + ...`; the iteration is
 *
 *   D = b_n + a_n · D  (then D = 1/D if |D| nonzero)
 *   C = b_n + a_n / C
 *   delta = C · D
 *   f = f · delta
 *   stop when |delta - 1| < 2^-prec.
 *
 * Use cases in this package: I2's `bigErfc(x)` for the regime where the
 * asymptotic is "just barely" valid but where Borel-form series cost
 * would dominate.  In I1 we ship this primitive — it is not on the
 * `bigErf` dispatch path itself.
 *
 * Throws on non-positive x: the CF representation requires `Re(x) > 0`.
 */
export function bigErfcContinuedFraction(x: BigFloat, prec: number): BigFloat {
  requireFiniteErfInput(x, "bigErfcContinuedFraction");
  if (sgn(x) <= 0) {
    throw new RangeError(
      `bigErfcContinuedFraction: argument must be positive; got sign ${sgn(x)}. ` +
        `suggestion: the Laplace CF representation requires Re(x) > 0; ` +
        `for negative x use the identity erfc(-x) = 2 - erfc(x).`,
    );
  }
  const work = prec + 32;
  const xSquared = mul(x, x, work);
  const expNegXSquared = exp(neg(xSquared), work);
  const sqrtPi = sqrt(pi(work), work);
  const prefactor = div(expNegXSquared, sqrtPi, work);
  // Modified Lentz on the continued fraction. The "tiny" guard prevents
  // division by zero when the running C/D denominators happen to collapse.
  const TINY: BigFloat = {
    mantissa: 1n << BigInt(work - 1),
    exponent: -10 * work,
    precision: work,
  }; // ≈ 2^-(10·work) — comfortably below any non-pathological convergent.
  const one = fromInt(1n, work);
  // Initialise: b_0 = x². f_0 = b_0 (or TINY if zero — unreachable here
  // since x > 0). C_0 = f_0, D_0 = 0.
  let f = xSquared;
  let C = f;
  let D: BigFloat = { mantissa: 0n, exponent: 0, precision: work };
  // a_n, b_n generators. n = 1, 2, 3, ...
  //   n odd  (n = 2k - 1): a = k - 1/2 = (2k - 1)/2, b = 1
  //   n even (n = 2k):     a = k,                    b = x²
  // We'll iterate by k = 1, 2, 3, ... and unfold odd/even pairs.
  const stopMagThreshold = -prec - 4;
  // Safety cap. CF rate is ~ 1/x² per cycle, so at x = x_c the cycle
  // count is ~ p; the cap is generous.
  const maxCycles = Math.max(128, work * 4);
  for (let n = 1; n <= maxCycles; n++) {
    let aN: BigFloat;
    let bN: BigFloat;
    if (n % 2 === 1) {
      // odd: a = n/2 (n = 2k-1 ⇒ k = (n+1)/2, a = k - 1/2 = n/2).
      // Use BigInt rational n/2: encode as fromInt(n) / fromInt(2).
      aN = div(fromInt(BigInt(n), work), fromInt(2n, work), work);
      bN = one;
    } else {
      // even: a = n/2, b = x².
      aN = fromInt(BigInt(n / 2), work);
      bN = xSquared;
    }
    // D = b_n + a_n · D
    D = add(bN, mul(aN, D, work), work);
    if (isZero(D)) D = TINY;
    // C = b_n + a_n / C
    if (isZero(C)) C = TINY;
    C = add(bN, div(aN, C, work), work);
    if (isZero(C)) C = TINY;
    D = div(one, D, work);
    const delta = mul(C, D, work);
    f = mul(f, delta, work);
    // Convergence test: |delta - 1| < 2^-prec.
    const deltaMinusOne = sub(delta, one, work);
    if (magBits(deltaMinusOne) < stopMagThreshold) break;
  }
  // The CF evaluates to `x² + (1/2)/(...)`, i.e. it represents the
  // *denominator* `D(x²) = x · √π · e^(x²) · erfc(x)` divided through
  // by `x` — wait, double-check: the Laplace form is
  //   erfc(x) · √π · e^(x²) = ∫₀∞ e^(-t)/(t + x²)^(1/2) dt = (1/x²) · CF(x²)
  // Hmm; let's be precise: the standard CF (cf. NR §6.2) gives
  //   erfc(x) = (e^(-x²) / √π) · (1 / (x + (1/2)/(x + 1/(x + (3/2)/(x + ...)))))
  // which has `b_n = x` (not `x²`!) alternating with the half-integer
  // a-coefficients. The form we evaluated above is the *Laplace*
  // representation with `b_n` alternating `{x², 1, x², 1, ...}`. Both
  // are valid; the Laplace form's first term is `1/(x² + ...)` so
  // `CF/x` recovers the right scaling. The result here is f = `x · erfc(x)
  // · √π · e^(x²)`-shaped; divide by `x` once to peel off.
  //
  // (Care note: this CF identity is documented in DLMF 7.9.1 in the
  // half-integer Pochhammer form; the implementation above is the
  // book-standard re-arrangement. In I2's bigErfc the asymptotic lane
  // is the workhorse — this CF lane is here so I2 can choose between
  // them and test the agreement.)
  //
  // Final assembly: result = prefactor · (1 / f) · x.
  const fInv = div(one, f, work);
  const xOverF = mul(x, fInv, work);
  const result = mul(prefactor, xOverF, work);
  return normalise(result.mantissa, result.exponent, prec);
}

// =============================================================================
// bigErf — the entry point
// =============================================================================

/**
 * Real-axis error function at user-controlled precision.
 *
 *   erf(x) = (2/√π) · ∫₀ˣ e^(-t²) dt
 *
 * Algorithm split (R2 §2.1 + DLMF §7.6 + §7.12):
 *
 *   |x| ≤ x_c(prec)  → bigErfSeries     (DLMF 7.6.2 Borel form)
 *   |x| > x_c(prec)  → sign(x) · (1 - bigErfcAsymptotic(|x|))
 *
 * The asymptotic branch is cancellation-free because for |x| > x_c the
 * value `bigErfcAsymptotic(|x|)` is below `2^-prec` in magnitude — so
 * `1 - tiny` loses zero bits.  (The catastrophic case is the *inverse*:
 * computing `erfc(big)` as `1 - erf(big)`, where `erf` is close to 1 and
 * the subtraction discards `x² · log₂ e` bits.  That's I2's load-bearing
 * concern, not ours.)
 *
 * Determinism: every operation is BigInt + bounded-integer-exponent
 * arithmetic; BigInt is bit-identical across runtimes by language
 * specification.  Inherits the `arbprec: true` contract of ADR-0020 —
 * same `(input bytes, prec)` → byte-identical output forever.
 *
 * @throws RangeError on non-finite input (malformed BigFloat shape, or
 * magnitude > 2^1024 where the answer is saturation-trivial).
 */
export function bigErf(x: BigFloat, prec: number): BigFloat {
  requireFiniteErfInput(x, "bigErf");
  // erf(0) = 0 exactly. Hot path — short-circuit to a canonical zero.
  if (isZero(x)) {
    return { mantissa: 0n, exponent: 0, precision: prec };
  }
  if (prec < 1 || !Number.isInteger(prec)) {
    throw new RangeError(
      `bigErf: prec must be a positive integer; got ${prec}. ` +
        `suggestion: use decimalToBinaryPrecision(<digits>) for a decimal target.`,
    );
  }
  // Crossover dispatch. We compare |x| against x_c(prec) via the float64
  // toFloat64 (a flow-control choice; output bytes do not depend on the
  // float64 result of toFloat64 — both branches produce mathematically
  // identical answers to within 2^-prec).
  const absX = abs(x);
  const xc = crossoverXc(prec);
  const xFloat = toFloat64(absX).value;
  // If toFloat64 overflowed (|x| > ~1.8e308), the asymptotic branch is
  // unambiguously the right one. The requireFiniteErfInput already
  // bounds magnitude by 2^1024, so this overflow regime is only for
  // values 2^1023 ≤ |x| < 2^1024 — well past x_c at any reasonable prec.
  const useAsymptotic = !Number.isFinite(xFloat) || xFloat > xc;
  if (!useAsymptotic) {
    // Small/moderate |x|: Borel-series lane. No cancellation; the series
    // result is the answer.
    return bigErfSeries(x, prec);
  }
  // Large |x|: erf(x) = sign(x) · (1 − erfc(|x|)). erfc is tiny — at the
  // crossover x_c, erfc(x_c) ≈ 2^-prec by construction. The subtraction
  // `1 - tiny` loses no bits, so a 32-bit work margin is sufficient.
  const work = prec + 32;
  const erfcAbs = bigErfcAsymptotic(absX, work);
  const one = fromInt(1n, work);
  const erfAbs = sub(one, erfcAbs, work);
  // Re-attach the sign of x. For x > 0, return erfAbs; for x < 0, negate.
  const signed = sgn(x) < 0 ? neg(erfAbs) : erfAbs;
  return normalise(signed.mantissa, signed.exponent, prec);
}

// =============================================================================
// bigErfcxAsymptotic — direct asymptotic for `erfcx(x)` at large x
// =============================================================================

/**
 * Direct asymptotic evaluator for `erfcx(x) = e^(x²) · erfc(x)` at large
 * positive `x`, via the rational form of the DLMF 7.12.1 asymptotic with
 * the `e^(-x²)` prefactor *removed analytically* (NOT divided through
 * after the fact):
 *
 *   erfcx(x) ∼ (1 / (√π · x)) · Σ_{m=0}^∞  (-1)^m · (2m-1)!! / (2x²)^m
 *
 * Same coefficient ring as `bigErfcAsymptotic`, same `T_{m+1} =
 * T_m · -(2m + 1) / (2x²)` recurrence, same optimal-truncation rule.  The
 * crossover is identical: `|x| > x_c(prec)` ⇒ asymptotic gives `prec` bits.
 *
 * Why this exists as a peer of `bigErfcAsymptotic`, not a wrapper:
 *
 *   - For large x, `bigErfcAsymptotic` returns a value of magnitude
 *     `e^(-x²) / (x √π)` — exponentially small.  Then `exp(x²) · erfc`
 *     re-multiplies by `e^(x²)`.  Both `e^(-x²)` and `e^(x²)` are computed
 *     to `prec` bits *relative*, so the product is correct — but it wastes
 *     two transcendental calls, two prec+ bit BigInt limbs, and two
 *     mul-by-large-exponent rounds.  The direct asymptotic skips all of it.
 *   - More importantly, the *narrative* is wrong if we compute via
 *     `bigErfcAsymptotic`: the answer `erfcx(20) ≈ 0.028` does not in
 *     fact require any computation of a quantity near `2^(-577)` and
 *     a re-amplification by `e^400 ≈ 2^576`.  It requires a six-term
 *     asymptotic sum on a `1/x` scale.  The direct path is the honest one.
 *
 * Mirrors SpecialFunctions.jl `_erfcx(::BigFloat)` lines 27-40 (cited in
 * R2 §"Risk 3").  Caller is responsible for `x > 0`; throws otherwise.
 */
export function bigErfcxAsymptotic(x: BigFloat, prec: number): BigFloat {
  requireFiniteErfInput(x, "bigErfcxAsymptotic");
  if (sgn(x) <= 0) {
    throw new RangeError(
      `bigErfcxAsymptotic: argument must be positive; got sign ${sgn(x)}. ` +
        `suggestion: for negative x use the identity ` +
        `erfcx(-x) = 2·exp(x²) - erfcx(x); for x ≤ 0 the asymptotic ` +
        `regime does not apply.`,
    );
  }
  const work = prec + 32;
  // Prefactor: 1 / (√π · x). The `exp(-x²)` of bigErfcAsymptotic is gone —
  // analytically cancelled by the `exp(x²)` in `erfcx = exp(x²) · erfc`.
  const sqrtPi = sqrt(pi(work), work);
  const sqrtPiX = mul(sqrtPi, x, work);
  const one = fromInt(1n, work);
  const prefactor = div(one, sqrtPiX, work);
  // Series sum. T_0 = 1.
  const xSquared = mul(x, x, work);
  const twoXSquared = mul(xSquared, fromInt(2n, work), work);
  let sum = fromInt(1n, work);
  let term = fromInt(1n, work);
  let prevTermMag = Infinity;
  // Same maxTerms cap as bigErfcAsymptotic — optimal truncation is reached
  // well before this in any sane regime.
  const maxTerms = Math.max(64, work * 2);
  for (let m = 0; m < maxTerms; m++) {
    // T_{m+1} = T_m · -(2m + 1) / (2x²).
    const numerCoeff = fromInt(BigInt(-(2 * m + 1)), work);
    term = div(mul(term, numerCoeff, work), twoXSquared, work);
    const termMag = magBits(term);
    if (termMag === -Infinity) break;
    // Optimal-truncation rule: if this term is larger than the previous,
    // the series is diverging — STOP without adding.
    if (termMag > prevTermMag) break;
    sum = add(sum, term, work);
    prevTermMag = termMag;
    if (termMag < -prec - 8) break;
  }
  const result = mul(prefactor, sum, work);
  return normalise(result.mantissa, result.exponent, prec);
}

// =============================================================================
// bigErfc — the entry point (DIRECT asymptotic for large x)
// =============================================================================

/**
 * Complementary error function at user-controlled precision.
 *
 *   erfc(x) = 1 - erf(x) = (2/√π) · ∫_x^∞ e^(-t²) dt
 *
 * Algorithm split (R2 §2.1, §"Top-3 risks", Risk 1):
 *
 *   x = 0            → exactly 1.
 *   |x| ≤ x_c(prec)  → 1 - bigErf(x) with cancellation-driven retry
 *                      (loss budget bounded by x²·log₂e ≤ prec at the
 *                      crossover boundary — *not* a wait-and-pray loop).
 *   x >  x_c(prec)   → bigErfcAsymptotic(x) — DIRECT, never `1 - bigErf`.
 *   x < -x_c(prec)   → 2 - bigErfcAsymptotic(|x|), where `erfc(|x|)` is
 *                      `≤ 2^-prec` by the crossover construction so the
 *                      `2 - tiny` subtraction is cancellation-free.
 *
 * Direct-path discipline:
 *
 *   The implementation MUST NOT delegate the large-x branch to
 *   `sub(one, bigErf(x), work)`, even with a huge `work` budget.
 *   At x = 20 (prec = 200), that would discard ~580 bits to
 *   cancellation; even at `work = prec + 1000` the answer would carry
 *   only ~420 effective bits of precision while presenting itself as
 *   200-bit-clean.  The substrate's contract is byte-deterministic
 *   high-precision output; lying about precision is inadmissible
 *   (CLAUDE.md Rule 8).  R2 §"Risk 1" pins the mitigation;
 *   Mutation 2 in worklog 135 documents the test that catches the
 *   regression.
 *
 * Determinism: every operation is BigInt + bounded-integer-exponent
 * arithmetic; BigInt is bit-identical across runtimes by language
 * specification.  Inherits the `arbprec: true` contract of ADR-0020.
 *
 * @throws RangeError on non-finite input (malformed BigFloat shape, or
 * magnitude > 2^1024 — the cliff is shared with `bigErf`).
 */
export function bigErfc(x: BigFloat, prec: number): BigFloat {
  requireFiniteErfInput(x, "bigErfc");
  if (prec < 1 || !Number.isInteger(prec)) {
    throw new RangeError(
      `bigErfc: prec must be a positive integer; got ${prec}. ` +
        `suggestion: use decimalToBinaryPrecision(<digits>) for a decimal target.`,
    );
  }
  // erfc(0) = 1 exactly. Hot path.
  if (isZero(x)) {
    return normalise(1n, 0, prec);
  }
  const absX = abs(x);
  const xc = crossoverXc(prec);
  const xFloat = toFloat64(absX).value;
  const isLarge = !Number.isFinite(xFloat) || xFloat > xc;

  if (!isLarge) {
    // Small/moderate-x lane: erfc(x) = 1 - erf(x).
    //
    // Cancellation-driven precision retry (mirrors `clgammaReflect`,
    // worklog 117, bead `oj5j`):
    //
    //   1. Compute at work0 = prec + 64 bits.
    //   2. Measure loss = magBits(erfX) - magBits(diff).
    //   3. If loss > 0, retry at work = prec + 64 + loss bits.
    //
    // The loss is bounded *structurally* by x²·log₂e ≤ prec at x = x_c,
    // so the retry terminates after at most one bump.  We do not loop —
    // the retry is a one-shot recompute, not a wait-and-pray iteration.
    const work0 = prec + 64;
    const erfX0 = bigErf(x, work0);
    const one0 = fromInt(1n, work0);
    const diff0 = sub(one0, erfX0, work0);
    const lossBits = Math.max(0, magBits(erfX0) - magBits(diff0));
    if (lossBits === 0 || isZero(diff0)) {
      return normalise(diff0.mantissa, diff0.exponent, prec);
    }
    // Retry at the bumped precision. The +8 above the measured loss is
    // headroom against the rounding of the retry's own sub() — the
    // measurement uses a finite-precision diff0, so the true loss could
    // be off by ~1 ulp in the magnitude.
    const work = prec + 64 + lossBits + 8;
    const erfX = bigErf(x, work);
    const one = fromInt(1n, work);
    const diff = sub(one, erfX, work);
    return normalise(diff.mantissa, diff.exponent, prec);
  }

  // Large-|x| lane: DIRECT asymptotic. No subtraction-from-one anywhere.
  if (sgn(x) > 0) {
    // Direct path. The asymptotic returns erfc(x) at the requested prec
    // bits with no cancellation loss anywhere on the path.
    return bigErfcAsymptotic(absX, prec);
  }
  // Large negative x: erfc(-|x|) = 2 - erfc(|x|).  Since |x| > x_c implies
  // erfc(|x|) ≤ 2^-prec by construction, the `2 - tiny` subtraction loses
  // at most one bit (and usually zero — `tiny` doesn't even reach the
  // bottom of the working mantissa once it's below 2^-prec).  A 32-bit
  // working margin is generous.
  const work = prec + 32;
  const erfcAbs = bigErfcAsymptotic(absX, work);
  const two = fromInt(2n, work);
  const result = sub(two, erfcAbs, work);
  return normalise(result.mantissa, result.exponent, prec);
}

// =============================================================================
// bigErfcx — the entry point (DIRECT asymptotic for large x)
// =============================================================================

/**
 * Scaled complementary error function at user-controlled precision.
 *
 *   erfcx(x) = e^(x²) · erfc(x)
 *
 * Motivation: for large positive `x`, `erfc(x) ~ e^(-x²)/(x √π)` underflows
 * any fixed-exponent float, while `erfcx(x) ~ 1/(x √π)` is gracefully `O(1/x)`.
 * The Voigt profile, Berry-smoothed Stokes coefficients, and the Faddeeva
 * `w(z)` family all hold their answers in `erfcx`-shaped quantities; the
 * substrate exposes this directly to avoid the overflow/underflow round-trip
 * through `erfc`.
 *
 * Algorithm split (same crossover as `bigErfc`, per R2 §1.8):
 *
 *   |x| ≤ x_c(prec)  → small-x lane: exp(x²) · bigErfc(x).
 *                      At x = x_c, exp(x²) = 2^prec — representable in
 *                      BigFloat (int32 exponent range vastly exceeds
 *                      float64's), and bigErfc(x) is well within its
 *                      own small-x lane.
 *                      At x = 0, erfcx(0) = 1 exactly.
 *   |x| > x_c(prec)  → direct asymptotic (bigErfcxAsymptotic):
 *                      erfcx(x) ~ (1/(x √π)) · Σ (-1)^m (2m-1)!! / (2x²)^m
 *                      NOT exp(x²) · erfc(x) via the underlying asymptotic —
 *                      the e^(±x²) round-trip is wasted work *and* lies
 *                      about the algorithmic narrative.  See R2 §"Risk 3"
 *                      and the SpecialFunctions.jl `_erfcx(::BigFloat)`
 *                      reference.
 *
 *   For negative x in the large-|x| lane, we use the identity
 *
 *     erfcx(-|x|) = exp(x²) · erfc(-|x|) = exp(x²) · (2 - erfc(|x|))
 *                 = 2·exp(x²) - erfcx(|x|)
 *
 *   For large positive |x|, `2·exp(x²)` is astronomically larger than
 *   `erfcx(|x|) ≈ 1/(|x|√π)`, so the subtraction loses no bits — the
 *   answer is dominated by `2·exp(x²)`.  This is the correct large-negative
 *   behaviour: `erfcx(-x)` grows like `2·exp(x²)`.
 *
 * Threshold choice (x_c, NOT a fixed constant like 3):
 *
 *   The direct asymptotic's optimal-truncation remainder is bounded by
 *   `e^(-x²) · √(π/(2x²))`.  For that to be below `2^-prec` we need
 *   `x² · log₂e > prec - ½log₂(π/(2x²))`, i.e. `x > x_c(prec)` to leading
 *   order.  Below x_c, the asymptotic diverges *before* reaching prec-bit
 *   accuracy — at x = 4 and prec = 200, it disagrees with the true value
 *   by the 7th digit (verified by experiment before this code shipped).
 *   So the threshold MUST be x_c; a fixed value like "|x| < 3" looks
 *   plausible but fails silently for the moderate-x band.
 *
 * Determinism: arbprec: true (ADR-0020).  @throws RangeError on
 * malformed input.
 */
export function bigErfcx(x: BigFloat, prec: number): BigFloat {
  requireFiniteErfInput(x, "bigErfcx");
  if (prec < 1 || !Number.isInteger(prec)) {
    throw new RangeError(
      `bigErfcx: prec must be a positive integer; got ${prec}. ` +
        `suggestion: use decimalToBinaryPrecision(<digits>) for a decimal target.`,
    );
  }
  // erfcx(0) = exp(0) · erfc(0) = 1 · 1 = 1 exactly. Hot path.
  if (isZero(x)) {
    return normalise(1n, 0, prec);
  }
  const absX = abs(x);
  const xc = crossoverXc(prec);
  const xFloat = toFloat64(absX).value;
  // Small-x threshold = x_c(prec), NOT a fixed constant. At |x| ≤ x_c,
  // the composition `exp(x²) · bigErfc(x)` is numerically clean: bigErfc(x)
  // is well within its small-x lane, exp(x²) is computed to prec bits
  // relative, and the product preserves prec bits relative. The direct
  // asymptotic does not reach prec-bit accuracy until |x| > x_c (its
  // optimal-truncation remainder is bounded by e^(-x²) · √(π/(2x²)),
  // which crosses 2^-prec at x = x_c by the same derivation as bigErfc's
  // crossover). See R2 §1.8.
  const useSmallLane = Number.isFinite(xFloat) && xFloat <= xc;
  if (useSmallLane) {
    const work = prec + 32;
    const xSquared = mul(x, x, work);
    const expXSquared = exp(xSquared, work);
    const erfcX = bigErfc(x, work);
    const result = mul(expXSquared, erfcX, work);
    return normalise(result.mantissa, result.exponent, prec);
  }
  // Large-|x| lane: direct asymptotic. For negative x, use the parity
  // identity AFTER computing on |x|.
  if (sgn(x) > 0) {
    return bigErfcxAsymptotic(absX, prec);
  }
  // Large negative x: erfcx(-|x|) = 2·exp(x²) - erfcx(|x|).
  //
  // For |x| ≥ 3, `2·exp(x²)` is at least `2·exp(9) ≈ 16200` and grows
  // doubly-exponentially with |x|; `erfcx(|x|) ≈ 1/(|x|√π)` stays below 1.
  // The subtraction is `huge - small` — *zero* cancellation, the result
  // is dominated by `2·exp(x²)` to many digits.  This is the correct
  // large-negative behaviour of erfcx: the function blows up as
  // `2·exp(x²)` for x → -∞.
  //
  // Working precision: 32 bits of headroom for the final subtraction
  // is sufficient because magBits(2·exp(x²)) ≫ magBits(erfcx(|x|))
  // (no cancellation between the two operands).
  const work = prec + 32;
  const xSquared = mul(x, x, work);
  const expXSquared = exp(xSquared, work);
  const twoExpXSquared = mul(fromInt(2n, work), expXSquared, work);
  const erfcxAbs = bigErfcxAsymptotic(absX, work);
  const result = sub(twoExpXSquared, erfcxAbs, work);
  return normalise(result.mantissa, result.exponent, prec);
}
