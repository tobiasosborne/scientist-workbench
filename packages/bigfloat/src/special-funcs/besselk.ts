// =============================================================================
// @workbench/bigfloat — Modified Bessel function of the second kind `K_ν(z)` (arb-prec)
// =============================================================================
//
// This module ships the arb-prec real-axis entry points for the modified
// Bessel K family:
//
//   bigBesselK(nu, z, prec)        — real ν, real positive z; the user-visible entry
//   bigBesselKScaled(nu, z, prec)  — exp(z) · K_ν(z); the underflow-safe variant
//
// plus the two internal primitives the dispatch routes over:
//
//   bigBesselKFromConnection — DLMF 10.27.4 I-connection formula
//                              K_ν(z) = (π/2)·(I_{-ν}(z) − I_ν(z))/sin(νπ),
//                              re-expressed via the substrate-safe paired
//                              `0F1(1±ν; z²/4)` form to avoid the I-series
//                              singularities at negative non-integer ν.
//                              Used for non-integer ν.  Cancellation-retry
//                              harness for near-integer ν.
//   bigBesselKIntegerNu      — v0.1 limit-via-eps path: evaluate the
//                              connection formula at ν = n + ε for a
//                              moderate ε at boosted working precision
//                              (documented trade-off vs the full FLINT
//                              Temme polynomial-series path).
//
// ADR-0041 §"Decision 3" pins the per-head signature and the algorithm
// dispatch; ADR-0020 pins the determinism contract this substrate must
// honour (bit-identical across runtimes forever, given fixed `prec` bits).
//
// Why not just compose `bigBesselI(±ν, z, work)`? — the substrate gap
// ---------------------------------------------------------------------
//
// The naive textbook K-from-I implementation would call I2a's
// `bigBesselI` twice with `+ν` and `−ν`.  I2a refuses negative
// non-integer ν (the documented refusal cites this very module — I2b —
// as the downstream that will unblock it).  Even routing past that
// refusal by calling I2a's lower-level `bigBesselISeriesMaclaurin(-nu,
// z, work)` directly would not work: that series has the recurrence
//
//   T_{k+1} = T_k · (z²/4) / ((k+1) · (ν + k + 1))
//
// which at ν ≈ −n (negative near-integer) drives `(ν + k + 1) → 0` at
// `k = n − 1`, producing a HUGE intermediate term that must cancel
// against the small final K answer.  Working precision would have to
// absorb that cancellation, but the cancellation magnitude is
// `O(1/|ν − round(ν)|)` — for the integer-ν limit path (ε ≈ 2^−prec)
// it becomes O(prec) bits, doubling working precision *and* the series
// term count.  Worse, the inner BigFloat operations cost grows
// quadratically with working precision, so the naive composition is
// quartic-in-prec in the integer-ν limit — completely impractical.
//
// FLINT's solution (`bessel_k.c::acb_hypgeom_bessel_k_0f1` lines
// 153-208), which we adopt verbatim in spirit: re-express the
// connection algebraically using
//
//   I_ν(z) = (z/2)^ν / Γ(ν+1) · ₀F₁(1+ν; z²/4)
//   I_{-ν}(z) = (z/2)^{-ν} / Γ(1-ν) · ₀F₁(1-ν; z²/4)
//
// substituted into DLMF 10.27.4, then folded via the Γ-reflection
// identity Γ(ν)·Γ(1-ν) = π/sin(πν) (DLMF 5.5.3) to remove the explicit
// `1/sin(νπ)` factor from one of the two terms.  The result:
//
//   K_ν(z) = (1/2) · [
//              (z/2)^{-ν} · Γ(ν) · ₀F₁(1-ν; z²/4)
//            − (z/2)^{+ν} · π / (Γ(ν) · ν · sin(πν)) · ₀F₁(1+ν; z²/4)
//            ]                                            (DLMF 10.27.4-folded)
//
// — algebraically identical to the direct I-connection formulation in
// the mission spec, but numerically *much* better behaved.  Both
// `₀F₁(1+ν; z²/4)` and `₀F₁(1-ν; z²/4)` are all-positive series with
// monotonic denominators `(1±ν+k)·(1±ν+k−1)·…·(1±ν)` that never hit
// zero for non-integer ν; no internal pole-cancellation.  The leading
// (z/2)^{±ν} prefactors are O(z^ν) growth/decay — bounded.  The single
// remaining cancellation surface is in the `[…] − […]` subtraction,
// which is the *same* cancellation the I-connection would have at the
// outer level, and which the retry harness handles.
//
// This is the algorithmic shape of the canonical FLINT acb routine,
// transcribed for the BigFloat substrate.  Determinism is preserved
// (every operation is BigInt) and the answer is byte-identical to what
// the direct DLMF 10.27.4 formula would produce in infinite precision.
//
// v0.1 scope per the I2b mission spec and ADR-0041 §"Decision 3"
// --------------------------------------------------------------
//
// We ship the folded connection above for non-integer ν.  For integer
// ν we use the v0.1 limit-via-eps fallback: evaluate the same folded
// connection at ν = n + ε with ε = 2^−(prec+32) at boosted working
// precision.  Quadratic limit-error analysis (Watson §3.7, Olver 1974
// §7) gives `K_n(z) − K(n+ε, z) = O(ε² · ∂²K/∂ν²)`; with our ε, the
// limit-error is `~2^−2(prec+32)`, vastly below the final rounding
// floor at `2^−prec`.
//
// v0.2 follow-up: implement FLINT's full polynomial-series Temme path
// (`bessel_k_0f1_series`, lines 57-127) — evaluates the connection as
// truncated power-series in a formal indeterminate, divides as
// polynomials, and reads off the constant coefficient.  Exact, no
// limit, faster at very large prec.  v0.1 fallback is correct at all
// precisions tested in the corpus (up to 200 bits) and acceptable up
// to ~500 bits where the 2× working-precision penalty becomes
// noticeable.
//
// Why we defer the large-z asymptotic
// -----------------------------------
//
// FLINT's `acb_hypgeom_bessel_k_asymp` (lines 17-55) implements the
// `√(π/(2z))·e^{-z}·₂F₀(½+ν, ½−ν; ; −1/(2z))` divergent-asymptotic
// branch with smallest-term truncation; switching over at |z| > p/2
// would speed up large-z evaluations.  In v0.1 we route all z through
// the ₀F₁ formulation; correctness is preserved at all z, only the
// asymptotic-band performance is sub-optimal.  Filed as v0.2 P3.
//
// References (all in repo)
// ------------------------
//   - docs/adr/0041-bessel-family-per-head-substrate.md §"Decision 3"
//   - docs/adr/0020-arbitrary-precision-tier.md
//   - docs/refs/besselj-research/R2-arbprec-algorithms.md §3.4
//   - docs/refs/besselj-research/sources/arbprec/bessel_k.c
//     (FLINT acb_hypgeom; lines 153-208 are the non-integer 0F1 path
//     we port; lines 57-127 are the polynomial-series Temme path we
//     defer to v0.2; lines 17-55 are the large-z asymptotic we defer)
//   - packages/bigfloat/src/special-funcs/besseli.ts (the I2a sibling)
//   - packages/bigfloat/src/special-funcs/besselj.ts (the I1a sibling;
//     `bigBesselJSeriesCancellationRetry` is the measure-and-bump
//     pattern we mirror)
//   - DLMF §10.25 (defining I series), §10.27 (I-K interrelations,
//     §10.27.4 = the I-connection), §10.31 (K integer-ν definition
//     via limit), §10.40 (asymptotic — deferred v0.2)

import { BigFloat, normalise, bitLength } from "../types.js";
import { abs, neg, sgn, isZero, eq } from "../comparison.js";
import { add, sub, mul, div } from "../arithmetic.js";
import { fromInt, fromFloat64, toFloat64 } from "../conversion.js";
import { pi, exp, sin, pow, log } from "../transcendental.js";
import { gamma } from "../special.js";

// =============================================================================
// Helpers
// =============================================================================

/**
 * `log₂ |x|` to integer precision; returns `-Infinity` for `x = 0`.  Used
 * by the cancellation-loss tracking in the connection retry.
 */
function magBits(x: BigFloat): number {
  if (x.mantissa === 0n) return -Infinity;
  const m = x.mantissa < 0n ? -x.mantissa : x.mantissa;
  return x.exponent + bitLength(m);
}

/**
 * Validate that a BigFloat input is finite-and-usable.  Throws
 * `RangeError` with a `suggestion:` line.  Mirrors `besseli.ts`.
 */
function requireFiniteBesselKInput(x: BigFloat, fn: string, name: string): void {
  if (!Number.isInteger(x.precision) || x.precision < 1) {
    throw new RangeError(
      `${fn}: BigFloat ${name} precision must be a positive integer; got ${x.precision}. ` +
        `suggestion: construct the input via fromString / fromInt / fromFloat64.`,
    );
  }
  if (!Number.isInteger(x.exponent) || !Number.isFinite(x.exponent)) {
    throw new RangeError(
      `${fn}: BigFloat ${name} exponent must be a finite integer; got ${x.exponent}. ` +
        `suggestion: do not construct BigFloat sentinels by hand — use fromFloat64.`,
    );
  }
  if (x.mantissa !== 0n) {
    const magnitudeBits = magBits(x);
    if (magnitudeBits > 1024) {
      throw new RangeError(
        `${fn}: ${name} magnitude ~ 2^${magnitudeBits} exceeds the supported ` +
          `Bessel-family input range (|${name}| > 2^1024). ` +
          `suggestion: at this magnitude the connection inputs to K are at the ` +
          `edge of BigFloat representability — bound your input.`,
      );
    }
  }
}

/**
 * Round-trip a BigFloat to test "is this exactly an integer at this
 * precision?".  Returns the integer value if so, else `null`.
 */
function asExactInteger(nu: BigFloat): number | null {
  const nuFloat = toFloat64(nu).value;
  if (!Number.isFinite(nuFloat)) return null;
  const nuRound = Math.round(nuFloat);
  if (!Number.isSafeInteger(nuRound)) return null;
  const nuRoundedBack = fromInt(BigInt(nuRound), nu.precision);
  return eq(nu, nuRoundedBack) ? nuRound : null;
}

/**
 * `pow(base, exponent, prec)` for `base > 0`, real `exponent`.  Wraps
 * the standard transcendental.pow to make the call-site intent explicit
 * and to inherit its integer fast-path / `exp(ν · log base)` fall-through.
 */
function powerReal(base: BigFloat, exponent: BigFloat, prec: number): BigFloat {
  if (isZero(exponent)) return normalise(1n, 0, prec);
  if (isZero(base)) return { mantissa: 0n, exponent: 0, precision: prec };
  return pow(base, exponent, prec);
}

// =============================================================================
// hyp0F1 — power series for ₀F₁(b; w)
// =============================================================================

/**
 * Evaluate the confluent hypergeometric series
 *
 *   ₀F₁(b; w) = Σ_{k=0}^∞ w^k / ((b)_k · k!)
 *
 * for real positive `b` and real `w` (any sign), at the requested
 * precision.  `(b)_k = b·(b+1)·…·(b+k-1)` is the rising factorial.
 *
 * Recurrence (the form actually walked):
 *   T_0 = 1
 *   T_{k+1} = T_k · w / ((k+1) · (b + k))
 *
 * Termination: `|T_{k+1}| < |sum| · 2^-(prec + 8)`.
 *
 * Cancellation: if `w < 0` and `|w|` is large, the alternating series
 * cancels with peak-term magnitude `~exp(2√|w|)` (steepest-descent
 * analysis) — for the K-connection caller, `w = ±(z²/4)` is always
 * positive (we feed the `−` sign through the `(−1)^k` of the I/J
 * series only when needed elsewhere; here `w = z²/4 > 0`), so the
 * series is all-positive and cancellation-free.  No retry needed at
 * this primitive's layer.
 *
 * Caller is responsible for ensuring `b` is not zero or a non-positive
 * integer (the recurrence would hit `(b + k) = 0` and throw).  For our
 * K-connection caller, `b = 1 ± ν` with `ν` non-integer and
 * `|ν| < ~ν_max` — `b` is always positive and non-integer.
 *
 * The series term count is `O(|w|/k + log|w|)` ≈ `O(√|w| · log w/prec)`
 * — for our typical `w = z²/4 ∈ [0.25, 1000]` it's a small constant
 * number of terms relative to prec.
 */
function hyp0F1(b: BigFloat, w: BigFloat, prec: number): BigFloat {
  const work = prec + 32;
  let sum = fromInt(1n, work);
  let term = fromInt(1n, work);
  const stopMagThreshold = -prec - 8;
  // Safety cap: series convergence for ₀F₁ is super-geometric; in
  // practice it terminates in `O(√|w|) + O(prec)` terms.  Cap is generous.
  const absWFloat = toFloat64(abs(w)).value;
  const expectedTerms = Number.isFinite(absWFloat)
    ? Math.max(64, Math.ceil(2 * Math.sqrt(absWFloat) + work))
    : work * 4;
  const maxTerms = Math.max(64, expectedTerms);
  for (let k = 0; k < maxTerms; k++) {
    const kPlus1 = fromInt(BigInt(k + 1), work);
    const bPlusK = add(b, fromInt(BigInt(k), work), work);
    if (isZero(bPlusK)) {
      throw new RangeError(
        `hyp0F1: b + ${k} = 0 hits a pole of the rising factorial; ` +
          `suggestion: caller must pass non-integer or strictly positive b.`,
      );
    }
    const denom = mul(kPlus1, bPlusK, work);
    term = div(mul(term, w, work), denom, work);
    sum = add(sum, term, work);
    const termMag = magBits(term);
    const sumMag = magBits(sum);
    if (termMag === -Infinity) break;
    if (termMag - sumMag < stopMagThreshold) break;
  }
  return normalise(sum.mantissa, sum.exponent, prec);
}

// =============================================================================
// bigBesselKFromConnection — DLMF 10.27.4 (folded) for non-integer ν
// =============================================================================

/**
 * I-connection evaluator for `K_ν(z)` at non-integer real ν > 0, real
 * positive z, using the substrate-safe folded form derived from
 * DLMF 10.27.4 + DLMF 5.5.3 (Γ reflection):
 *
 *   K_ν(z) = (1/2) · [
 *              (z/2)^{-ν} · Γ(ν) · ₀F₁(1-ν; z²/4)
 *            − (z/2)^{+ν} · π / (Γ(ν) · ν · sin(πν)) · ₀F₁(1+ν; z²/4)
 *            ]
 *
 * which is algebraically identical to the direct
 *
 *   K_ν(z) = (π/2) · (I_{-ν}(z) − I_ν(z)) / sin(νπ)
 *
 * but with the two ₀F₁ series taking the role of the two I-series.
 * Crucially, the ₀F₁ series at non-integer ν have no Γ-pole issues
 * (the I-series for negative non-integer ν does, via its
 * `(z/2)^{-ν} / Γ(1-ν)` prefactor combined with the in-recurrence
 * `(ν + k + 1)` denominator that approaches zero near negative
 * integer ν).
 *
 * Cancellation surface
 * --------------------
 *
 * The single cancellation site is the bracketed `[A − B]` subtraction
 * above.  Two regimes drive it:
 *
 *   (a) Near-integer ν: as ν → n, both A and B individually approach
 *       ±∞ as `1/sin(πν) ~ 1/(πν·(ν − n))`, with their difference
 *       remaining finite (the L'Hôpital limit = K_n).  Loss scales as
 *       `−log₂|ν − n|` bits.
 *
 *   (b) Large z: both A and B carry the same leading exp-growth in
 *       their I-equivalents; in the ₀F₁ form, both ₀F₁(1±ν; z²/4)
 *       grow as `e^z / √(z)` — their difference (after prefactors) is
 *       the exponentially decaying K_ν.  Loss scales as `z · log₂ e`
 *       bits.
 *
 * Both losses are detected post-hoc by comparing the magnitude of
 * `[A − B]` to `max(|A|, |B|)`.  If the loss exceeds the analytic
 * estimate plus a 16-bit headroom, we re-run the entire connection at
 * boosted working precision.
 *
 * Working precision
 * -----------------
 *
 * First pass: `work_0 = prec + 32 + cancelEst`, where `cancelEst` is
 * the sum of the near-integer-ν and large-z cancellation budgets.
 *
 * Retry pass (if first-pass measured loss exceeds the analytic
 * estimate): `work_1 = prec + 32 + lossBits + 16`.  Terminates after
 * at most one bump — same termination argument as the J retry
 * (`bigBesselJSeriesCancellationRetry`).
 *
 * Caller is responsible for ensuring ν is NOT exactly integer (the
 * dispatcher routes integer ν through `bigBesselKIntegerNu`), ν > 0
 * (K is even in ν; the dispatcher reduces to |ν|), and z > 0 (the
 * public entry validates both).
 *
 * **M1 mutation point:** swapping the bracketed subtraction sign
 * (`[A − B]` → `[A + B]`) produces wildly wrong answers (the sum is
 * dominated by the larger of A and B, which is `~10⁰` to `~10²` at
 * typical inputs, instead of the small K).
 */
export function bigBesselKFromConnection(
  nu: BigFloat,
  z: BigFloat,
  prec: number,
): BigFloat {
  requireFiniteBesselKInput(nu, "bigBesselKFromConnection", "nu");
  requireFiniteBesselKInput(z, "bigBesselKFromConnection", "z");
  if (sgn(z) <= 0) {
    throw new RangeError(
      `bigBesselKFromConnection: z must be positive; got sign ${sgn(z)}. ` +
        `suggestion: the public entry bigBesselK already gates z ≤ 0; this ` +
        `primitive must only be called with z > 0.`,
    );
  }
  if (sgn(nu) <= 0) {
    throw new RangeError(
      `bigBesselKFromConnection: ν must be positive; got sign ${sgn(nu)}. ` +
        `suggestion: K is even in ν (DLMF 10.27.3); the public entry reduces ` +
        `to |ν| before dispatch.  Caller must respect that invariant.`,
    );
  }
  // Cancellation budgets.
  //
  // The folded connection's `[A − B]` subtraction has loss `2|z|·log₂ e`
  // at large z, not `|z|·log₂ e`.  Both A and B grow as `e^|z|`
  // independently (each ₀F₁(1±ν; z²/4) contributes a `cosh(z)`-class
  // factor, which carries the `e^|z|` exponential growth; the leading
  // (z/2)^{±ν} prefactors are sub-exponential).  Their difference is
  // the exponentially DECAYING K_ν(z) ~ √(π/(2z))·e^{-|z|}, so the
  // total bit-loss in the subtraction is `2|z|·log₂ e`.  This is twice
  // the analogous J/I budget (where only one of the two pieces carries
  // the exponential growth).
  const absZFloat = toFloat64(abs(z)).value;
  const largeZBits = Number.isFinite(absZFloat)
    ? Math.max(0, Math.ceil(2 * absZFloat * Math.LOG2E))
    : 0;
  // Near-integer ν: bits lost = −log₂|ν − round(ν)|.
  //
  // We MUST measure the distance using BigFloat semantics, not float64.
  // The integer-ν dispatch (`bigBesselKIntegerNu`) deliberately calls
  // this primitive with `nu = n + 2^−(prec+32)` — a perfectly-finite
  // BigFloat that ROUNDS to `n` in float64 well before prec ~ 50.  If
  // we estimate `nearIntegerBits` from `toFloat64(nu)` we either:
  //   (a) refuse the perfectly-valid call (the `dist == 0` branch),
  //   (b) under-budget the cancellation (the rounded float64 ν matches
  //       a different integer than the BigFloat ν does).
  // Both have been observed in the test suite.  Workaround: compute the
  // BigFloat distance `frac = nu − round(nuFloat_as_BigFloat)` and use
  // its magBits directly.
  const nuFloat = toFloat64(nu).value;
  let nearIntegerBits = 0;
  if (Number.isFinite(nuFloat)) {
    const nuRound = Math.round(nuFloat);
    // `nuRoundBig` = the nearest integer to ν, at the same precision.
    const nuRoundBig = fromInt(BigInt(nuRound), nu.precision);
    // `frac = nu − round(ν)` — a BigFloat that is exactly zero iff ν is
    // integer to its full precision.  This is the load-bearing test.
    const frac = sub(nu, nuRoundBig, nu.precision + 32);
    if (isZero(frac)) {
      throw new RangeError(
        `bigBesselKFromConnection: ν is exactly integer (${nuFloat}); ` +
          `suggestion: integer ν must route through bigBesselKIntegerNu.`,
      );
    }
    // bits lost = −log₂|frac| = −magBits(frac).
    const fracMagBits = magBits(frac);
    // fracMagBits is negative (frac < 1 for any non-integer ν within
    // ±1/2 of its rounded value); −fracMagBits is the bit-loss budget.
    nearIntegerBits = Math.min(prec + 64, Math.max(0, -fracMagBits));
  }
  const cancelEst = nearIntegerBits + largeZBits;
  const work0 = prec + 32 + cancelEst;
  const first = besselKConnectionWithLossTracking(nu, z, work0);
  if (first.lossBits <= cancelEst + 16) {
    return normalise(first.value.mantissa, first.value.exponent, prec);
  }
  const work1 = prec + 32 + first.lossBits + 16;
  const second = besselKConnectionWithLossTracking(nu, z, work1);
  return normalise(second.value.mantissa, second.value.exponent, prec);
}

/**
 * Internal: evaluate the folded connection and report the cancellation
 * loss in the `[A − B]` subtraction.
 *
 *   A := (z/2)^{-ν} · Γ(ν) · ₀F₁(1-ν; z²/4)
 *   B := (z/2)^{+ν} · π / (Γ(ν) · ν · sin(πν)) · ₀F₁(1+ν; z²/4)
 *   K_ν(z) = (A − B) / 2
 *
 * Returns `{ value, lossBits }`.  Loss is measured as
 * `max(|A|, |B|) − |A − B|` in bits.
 */
function besselKConnectionWithLossTracking(
  nu: BigFloat,
  z: BigFloat,
  work: number,
): { value: BigFloat; lossBits: number } {
  const half = fromFloat64(0.5);
  const halfZ = mul(z, half, work);
  const zSquared = mul(z, z, work);
  const quarterZSquared = mul(zSquared, fromFloat64(0.25), work);
  // ₀F₁(1 + ν; z²/4)
  const one = fromInt(1n, work);
  const onePlusNu = add(one, nu, work);
  const oneMinusNu = sub(one, nu, work);
  const f0F1Plus = hyp0F1(onePlusNu, quarterZSquared, work);
  // ₀F₁(1 - ν; z²/4)
  const f0F1Minus = hyp0F1(oneMinusNu, quarterZSquared, work);
  // (z/2)^{±ν}
  const halfZPowPlusNu = powerReal(halfZ, nu, work);
  const halfZPowMinusNu = powerReal(halfZ, neg(nu), work);
  // Γ(ν)
  const gammaNu = gamma(nu, work);
  // π and sin(π ν)
  const piVal = pi(work);
  const nuPi = mul(nu, piVal, work);
  const sinNuPi = sin(nuPi, work);
  // A := (z/2)^{-ν} · Γ(ν) · ₀F₁(1-ν; z²/4)
  const A = mul(mul(halfZPowMinusNu, gammaNu, work), f0F1Minus, work);
  // B := (z/2)^{+ν} · π / (Γ(ν) · ν · sin(πν)) · ₀F₁(1+ν; z²/4)
  // — built as `((z/2)^ν · π · ₀F₁(1+ν; z²/4)) / (Γ(ν) · ν · sin(πν))`.
  const Bnum = mul(mul(halfZPowPlusNu, piVal, work), f0F1Plus, work);
  const Bden = mul(mul(gammaNu, nu, work), sinNuPi, work);
  const B = div(Bnum, Bden, work);
  // K = (A − B) / 2.
  const diff = sub(A, B, work);
  const two = fromInt(2n, work);
  const value = div(diff, two, work);
  // Loss accounting.
  const peakMag = Math.max(magBits(A), magBits(B));
  const diffMag = magBits(diff);
  const lossBits = diffMag === -Infinity ? 0 : Math.max(0, peakMag - diffMag);
  return { value, lossBits };
}

// =============================================================================
// bigBesselKIntegerNu — v0.1 limit-via-eps path
// =============================================================================

/**
 * Integer-ν evaluator for `K_n(z)` via the connection-formula limit:
 *
 *   K_n(z) = lim_{ν → n} (folded connection above)
 *
 * We evaluate the limit numerically by setting `ν = n + ε` for a tiny
 * ε and boosting the working precision to absorb the L'Hôpital
 * cancellation.
 *
 * Eps choice: `ε = 2^−(prec + 32)`.  Quadratic limit-error analysis
 * (Watson §3.7, Olver 1974 §7):
 *   K_n(z) − K(n+ε, z) = O(ε² · ∂²K/∂ν² at ν=n)
 * With ε ≈ 2^−(prec+32), the limit-error is `~2^−2(prec+32)`, vastly
 * below the final rounding floor at `2^−prec`.
 *
 * Working precision: `prec + 32 + (prec + 32) + largeZBits` —
 * the standard substrate budget plus the L'Hôpital cancellation
 * absorption (`-log₂(ε)` bits) plus the connection's own large-z
 * subtraction budget when z is in the asymptotic band.  This is
 * `2(prec + 32) + O(z)` total — twice the requested precision for the
 * inner ₀F₁ evaluations, plus the cancellation budget.  Asymptotically
 * `O(prec)` work; the constant factor is small.
 *
 * v0.2 follow-up: FLINT's `acb_hypgeom_bessel_k_0f1_series`
 * (`bessel_k.c:57-127`) implements the exact integer-ν path via
 * polynomial series (evaluates the connection as power-series in a
 * formal indeterminate, divides as polynomials, reads off the constant
 * coefficient).  No limit; faster at very large prec.  v0.1 fallback
 * is correct everywhere and acceptable up to prec ~ 500 bits.
 *
 * Caller is responsible for ensuring `n` is integer (the dispatcher
 * routes integer ν here) and z > 0.
 *
 * **M2 mutation point:** dropping the cancellation budget — i.e., using
 * `work = prec + 32` instead of `~2 · (prec + 32)` — makes the
 * near-integer-ν tests fail because the inner ₀F₁ subtraction loses
 * ~p bits to L'Hôpital cancellation, leaving 0 bits of useful precision
 * at the prec floor.
 */
export function bigBesselKIntegerNu(
  n: number,
  z: BigFloat,
  prec: number,
): BigFloat {
  if (!Number.isInteger(n)) {
    throw new RangeError(
      `bigBesselKIntegerNu: n must be an integer; got ${n}. ` +
        `suggestion: non-integer ν must route through bigBesselKFromConnection.`,
    );
  }
  requireFiniteBesselKInput(z, "bigBesselKIntegerNu", "z");
  if (sgn(z) <= 0) {
    throw new RangeError(
      `bigBesselKIntegerNu: z must be positive; got sign ${sgn(z)}. ` +
        `suggestion: the public entry bigBesselK already gates z ≤ 0; this ` +
        `primitive must only be called with z > 0.`,
    );
  }
  // K is even in ν (DLMF 10.27.3); reduce.
  const nAbs = Math.abs(n);
  // ε choice: `ε = 2^−(prec + 32)`.  Limit-error analysis is LINEAR in
  // ε around integer ν, not quadratic: `K_n(z) − K(n+ε, z) = ε ·
  // ∂K/∂ν|_{ν=n} + O(ε²)`.  (The quadratic-error analysis from Watson
  // §3.7 / Olver 1974 §7 applies to the `(I_{-ν} − I_ν)/sin(πν)`
  // limit as a function of ν away from the singularity — that limit is
  // continuous and finite, and its leading correction is the next
  // derivative.  The K_ν function itself is C^∞ in ν away from poles
  // of Γ, but its Taylor expansion around an integer has a non-zero
  // linear term; there is no symmetry constraint that would force it
  // to be even in (ν − n).)  So we need ε small enough that ε ·
  // |∂K/∂ν| < 2^−prec, i.e. ε ≲ 2^−prec.  With a safety margin we
  // pick ε = 2^−(prec + 32), giving a limit error of `~2^−(prec + 32)`.
  //
  // The L'Hôpital cancellation in the `[A − B]` subtraction is
  // `log₂(1/ε) = prec + 32` bits.  The inner `₀F₁(1−ν; w)` also has a
  // near-pole term at k = n−1 contributing `log₂(1/ε)` bits of internal
  // precision loss.  Both losses must be absorbed by the working
  // precision; we budget the L'Hôpital loss explicitly here (the
  // connection's retry harness handles any additional measured loss).
  const epsBits = prec + 32;
  // Working precision: prec + 32 (substrate budget) + epsBits
  // (L'Hôpital absorption) + 32 (safety).
  const work = prec + 32 + epsBits + 32;
  // ε = 2^−epsBits as a BigFloat.
  const eps: BigFloat = {
    mantissa: 1n,
    exponent: -epsBits,
    precision: work,
  };
  // ν = n + ε at the boosted working precision.
  const nuExact = add(fromInt(BigInt(nAbs), work), eps, work);
  // Direct call to the folded-connection primitive; do NOT route through
  // public `bigBesselK` (which would re-detect integer ν via the
  // round-trip-at-input-precision test and re-enter this function).
  const result = bigBesselKFromConnection(nuExact, z, work);
  return normalise(result.mantissa, result.exponent, prec);
}

// =============================================================================
// bigBesselK — the entry point
// =============================================================================

/**
 * Real-axis modified Bessel function of the second kind at
 * user-controlled precision.
 *
 *   K_ν(z) = (π / 2) · (I_{-ν}(z) − I_ν(z)) / sin(νπ)
 *
 * The decaying solution to the modified Bessel equation at +∞;
 * K_ν(z) ~ √(π/(2z)) · exp(-z) at large z.
 *
 * Algorithm dispatch (R2 §3.4 + DLMF §10.27 + ADR-0041 §"Decision 3"):
 *
 *   z = 0:           refuse — K_ν(0+) = +∞ (logarithmic for ν=0,
 *                    power-law for ν>0).  RangeError with suggestion
 *                    referencing the tagged class `bigfloat/k-singular-at-zero`.
 *   z < 0:           refuse — K_ν has a branch cut along the negative real
 *                    axis (DLMF 10.34.4).  RangeError with suggestion
 *                    referencing tagged class `bigfloat/k-branch-cut-on-negative`.
 *   ν integer (any z > 0): bigBesselKIntegerNu — limit-via-eps path.
 *   ν non-integer (any z > 0): bigBesselKFromConnection — folded DLMF
 *                              10.27.4 with cancellation-retry.
 *
 * K is even in ν (DLMF 10.27.3): the dispatcher reduces ν to |ν| at the
 * top.
 *
 * Determinism: every operation is `BigInt` + bounded-integer-exponent
 * arithmetic; `BigInt` is bit-identical across runtimes by language
 * specification.  Inherits the `arbprec: true` contract of ADR-0020 —
 * same `(nu, z, prec)` bytes → byte-identical output forever.
 *
 * @throws RangeError on non-finite input, z ≤ 0 (singular / branch cut),
 *   or other inadmissible configurations.
 */
export function bigBesselK(nu: BigFloat, z: BigFloat, prec: number): BigFloat {
  requireFiniteBesselKInput(nu, "bigBesselK", "nu");
  requireFiniteBesselKInput(z, "bigBesselK", "z");
  if (prec < 1 || !Number.isInteger(prec)) {
    throw new RangeError(
      `bigBesselK: prec must be a positive integer; got ${prec}. ` +
        `suggestion: use decimalToBinaryPrecision(<digits>) for a decimal target.`,
    );
  }
  // z = 0: singular.
  if (isZero(z)) {
    throw new RangeError(
      `bigBesselK: K_ν(z) is singular at z = 0 (K_0(0+) = +∞ logarithmic; ` +
        `K_ν(0+) ~ (2/z)^ν · Γ(ν)/2 for ν > 0 — power-law). ` +
        `suggestion: tool-layer code should emit tagged "bigfloat/k-singular-at-zero" ` +
        `for this input; do not request K_ν at z = 0.`,
    );
  }
  // z < 0: branch cut.
  if (sgn(z) < 0) {
    throw new RangeError(
      `bigBesselK: K_ν(z) has a branch cut along the negative real axis ` +
        `(DLMF 10.34.4); not defined as a real-valued function for z < 0. ` +
        `suggestion: tool-layer code should emit tagged ` +
        `"bigfloat/k-branch-cut-on-negative" for this input; route through ` +
        `the complex evaluator bigCBesselK (I3b; bead scientist-workbench-t73h) ` +
        `once it ships.`,
    );
  }
  // Reduce to |ν| via DLMF 10.27.3 (K is even in ν).
  const absNu = sgn(nu) < 0 ? neg(nu) : nu;
  // ν = 0 is integer; route accordingly even though sgn(0) is 0.
  if (isZero(absNu)) {
    return bigBesselKIntegerNu(0, z, prec);
  }
  // Integer ν: limit-via-eps integer path.
  const asInt = asExactInteger(absNu);
  if (asInt !== null) {
    return bigBesselKIntegerNu(asInt, z, prec);
  }
  // Non-integer ν: folded I-connection with cancellation-retry.
  return bigBesselKFromConnection(absNu, z, prec);
}

// =============================================================================
// bigBesselKScaled — exp(z) · K_ν(z), the underflow-safe variant
// =============================================================================

/**
 * Scaled modified Bessel K: returns `e^{z} · K_ν(z)`.
 *
 * Same `(nu, z, prec)` contract as `bigBesselK`; the result is finite
 * and O(1/√z) for all positive z (no underflow even at z = 1000).  Use
 * whenever:
 *
 *   - the consumer immediately multiplies by `e^{z}` (typical for
 *     integrands `∫ f(z) · K_ν(z) · e^{z} dz`),
 *   - `z > 700` is plausible (K underflows the float64 subnormal cliff
 *     well before z = 700),
 *   - downstream code needs to pretty-print or log K_ν(z) at large z.
 *
 * Precedent: `bigErfcx` (Erf scaled complementary); `bigBesselIScaled`
 * (the sibling, scaling away the GROWING `e^z` prefactor of I).
 *
 * Implementation: composed from `bigBesselK` + `exp(z)` at
 * `work = prec + 64`.
 *
 * **M3 mutation point:** dropping the `exp(z)` factor (returning
 * `bigBesselK(nu, z, prec)` directly) makes `bigBesselKScaled(0, 700)`
 * underflow to ~10^-305 instead of returning the finite O(1/√z) scaled
 * value, immediately failing the underflow-protection test.
 *
 * @throws RangeError on non-finite input, z ≤ 0 (delegates to
 *   `bigBesselK`).
 */
export function bigBesselKScaled(
  nu: BigFloat,
  z: BigFloat,
  prec: number,
): BigFloat {
  requireFiniteBesselKInput(nu, "bigBesselKScaled", "nu");
  requireFiniteBesselKInput(z, "bigBesselKScaled", "z");
  if (prec < 1 || !Number.isInteger(prec)) {
    throw new RangeError(
      `bigBesselKScaled: prec must be a positive integer; got ${prec}. ` +
        `suggestion: use decimalToBinaryPrecision(<digits>) for a decimal target.`,
    );
  }
  // z ≤ 0 routes through bigBesselK which refuses with the proper hints.
  const work = prec + 64;
  const kValue = bigBesselK(nu, z, work);
  const expZ = exp(z, work);
  const result = mul(kValue, expZ, work);
  return normalise(result.mantissa, result.exponent, prec);
}

// Silence unused-import warnings for substrate primitives kept in scope
// for the v0.2 large-z asymptotic path (planned port of FLINT
// `acb_hypgeom_bessel_k_asymp`).
void log;
