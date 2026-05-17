// =============================================================================
// @workbench/bigfloat — Modified Bessel function of the first kind `I_ν(z)` (arb-prec)
// =============================================================================
//
// This module ships the arb-prec real-axis entry points for the modified
// Bessel I family:
//
//   bigBesselI(nu, z, prec)        — real ν, real z; the user-visible entry
//   bigBesselIScaled(nu, z, prec)  — exp(-|z|) · I_ν(z); the overflow-safe variant
//
// plus the two substrate primitives the dispatch routes over (paralleling
// `bigBesselJSeriesMaclaurin` / `bigBesselJHankelAsymptotic` in the
// sister `besselj.ts`, but ALGORITHMICALLY INDEPENDENT — see below):
//
//   bigBesselISeriesMaclaurin  — DLMF 10.25.2 ₀F₁ Maclaurin (all-positive)
//   bigBesselIHankelAsymptotic — DLMF 10.40.1 modified-Hankel asymptotic
//                                (divergent, smallest-term truncation;
//                                 single alternating series, NO P/Q split)
//
// ADR-0041 §"Decision 3" pins the per-head signature and the algorithm
// dispatch; ADR-0020 pins the determinism contract this substrate must
// honour (bit-identical across runtimes forever, given fixed `prec` bits).
//
// I is NOT a thin wrapper around J — they are algorithmically independent
// -----------------------------------------------------------------------
//
// In *complex* code, `I_ν(z) = i^{-ν} · J_ν(iz)` (DLMF 10.27.6); this is
// the rotation Amos uses for complex J via real I (R2 §3.3, AMOS ZBESJ).
// But that identity is the WRONG tool for real-axis I evaluation — running
// J through a complex rotation when both ν and z are real is strictly more
// work, strictly more cancellation, and structurally upside-down (the
// modified series is the simpler form; the unmodified Hankel branch is
// the harder one with its `cos(ω) P − sin(ω) Q` mixing). For the real
// arb-prec path, I has its OWN series and its OWN asymptotic, both
// strictly simpler than J's. That's why I2a is a separate substrate bead
// from I1a, even though the J↔I rotation tangles them in I3a/I3b complex.
//
// Two structural differences from J's real path that matter:
//
//   1. **The series is all-positive** (DLMF 10.25.2):
//        I_ν(z) = (z/2)^ν · Σ_{k=0}^∞ (z²/4)^k / (k! · Γ(ν+k+1))
//      No alternation ⇒ NO cancellation between successive terms ⇒
//      NO cancellation-retry harness needed. Compare J's same series
//      with `(-z²/4)^k`: J's peak-term magnitude is ~exp(|z|), J's
//      answer is O(1/√z), so J loses `~1.44|z|` bits to cancellation.
//      I's peak-term magnitude is *also* ~exp(|z|), but I's answer
//      is *also* ~exp(|z|)/√(2π|z|) — they cancel structurally, no
//      bit-loss. The series-band working precision is therefore plain
//      `prec + 32`, no cancellation budget.
//
//   2. **The asymptotic is a single sum** (DLMF 10.40.1):
//        I_ν(z) ~ (e^z / √(2πz)) · Σ_{k=0}^∞ (-1)^k · a_k(ν) / z^k
//      where the `a_k(ν)` are the same Hankel coefficients as J/Y, but
//      there is NO `cos(ω) P − sin(ω) Q` split — just one alternating
//      sum multiplied by `e^z / √(2πz)`. The asymptotic is divergent
//      (Poincaré); we use the same smallest-term truncation as J's
//      Hankel branch, but with no mixing between two sums. The
//      cancellation surface that exists in J's Hankel branch — near
//      a zero of `J_ν` — has no analogue here: I_ν(z) > 0 for real
//      ν ≥ 0 and real z > 0 (no zeros), so the answer never goes
//      near zero, no zero-crossing tolerance band needed.
//
// FLINT-aligned dispatch (R2 §3.3 + `bessel_i.c:204-218`)
// --------------------------------------------------------
//
//   z = 0:                  closed form (1 if ν=0, 0 if ν>0)
//   z < 0:                  parity I_n(-z) = (-1)^n · I_n(z) for integer ν;
//                           non-integer negative-z is a branch-cut input
//                           (deferred to I3b complex via tagged refusal).
//   |z| < 16:               ₀F₁ Maclaurin direct (FLINT's `mag_cmp_2exp_si(zmag, 4) < 0`).
//   |z| < 2^64 and 2|z| < p: ₀F₁ Maclaurin direct (FLINT's broader 0F1 region).
//   otherwise:              modified-Hankel asymptotic.
//
// The threshold structure is FLINT's verbatim, ported from the lines
// noted above. In particular the absolute |z| < 16 lane runs the series
// even at very small prec — the all-positive series converges in
// O(|z| + prec/log₂(prec/|z|)) terms there, comparable to or cheaper
// than the asymptotic's optimal truncation point of k* ≈ 4|z|.
//
// Why `bigBesselIScaled` exists — overflow mitigation (R3 §0.2)
// -------------------------------------------------------------
//
// I_ν(z) grows as `e^z / √(2πz)` for large z; at z = 700, `e^z ≈ 10^304`
// which sits at the very top of float64 representable range; at z = 800,
// `e^z` overflows even BigFloat's exponent storage if it ever ends up
// converted (the float64 oracle, plotted values, etc.). The scaled
// variant `e^{-|z|} · I_ν(z)` is O(1/√z) for all z — it never blows up,
// is always representable, and is what downstream consumers want when
// they need `I_ν(z)` at large argument (typically inside an integrand
// where another factor `e^{-z}` or `e^{-z²/2}` is multiplying anyway).
//
// Precedent: Erf's `bigErfcx` is the same idea (`e^{x²} · erfc(x)`),
// shipped exactly to avoid the `x > 27` underflow cliff. SciPy's `ive`,
// AMOS's `cyl_bessel_i_scaled`, Boost's `cyl_bessel_i_prime` all ship
// this scaled variant. The wire-tool flag `--scaled` (ADR-0041
// §Decision 7) selects between this and the unscaled entry.
//
// **Implementation note:** for v0.1 we implement `bigBesselIScaled` as
// `bigBesselI(nu, z, work) * exp(-|z|, work)` at `work = prec + 64`.
// This pays one extra `exp(z)` per call but keeps the substrate single-
// source-of-truth on dispatch (one routine to test, one set of golden
// masters). The slightly-more-clever FLINT implementation merges the
// `exp(-z)` into the asymptotic's `exp(z)` prefactor analytically
// (`bessel_i.c:67-70`: when `scaled`, the prefactor is `1` instead of
// `exp(z)`); we may swap to that implementation in v0.2 once a
// downstream consumer is measured to be `bigBesselIScaled`-bound.
//
// References (all in repo)
// ------------------------
//   - docs/adr/0041-bessel-family-per-head-substrate.md §"Decision 3"
//   - docs/adr/0020-arbitrary-precision-tier.md
//   - docs/refs/besselj-research/R2-arbprec-algorithms.md §2.1 (series),
//     §2.2 (I asymptotic, lines 661-691), §3.3 (I dispatch, lines 1149-1186)
//   - docs/refs/besselj-research/sources/arbprec/bessel_i.c
//     (FLINT acb_hypgeom; lines 153-218 are the dispatch we port; lines
//     17-150 are the asymptotic prefactor handling we simplify for the
//     real path)
//   - packages/bigfloat/src/special-funcs/besselj.ts (sibling — same
//     module shape, INDEPENDENT algorithms)
//   - packages/bigfloat/src/special-funcs/erf.ts (`bigErfcx` is the
//     scaled-variant precedent)
//   - DLMF §10.25 (defining series I_ν), §10.27 (I/K interrelations),
//     §10.34 (analytic continuation, branch-cut), §10.40 (asymptotic)

import { BigFloat, normalise, bitLength } from "../types.js";
import { abs, neg, sgn, isZero, eq } from "../comparison.js";
import { add, sub, mul, div, sqrt } from "../arithmetic.js";
import { fromInt, fromFloat64, toFloat64 } from "../conversion.js";
import { pi, exp, pow } from "../transcendental.js";
import { gamma } from "../special.js";

// =============================================================================
// Helpers
// =============================================================================

/**
 * `log₂ |x|` to integer precision; returns `-Infinity` for `x = 0`.  Used
 * by smallest-term truncation tracking.  Local copy of the same shape
 * used in `besselj.ts`, `erf.ts`, `special.ts`, `complex.ts`.
 */
function magBits(x: BigFloat): number {
  if (x.mantissa === 0n) return -Infinity;
  const m = x.mantissa < 0n ? -x.mantissa : x.mantissa;
  return x.exponent + bitLength(m);
}

/**
 * Validate that a BigFloat input is finite-and-usable.  Throws
 * `RangeError` with a `suggestion:` line.  Mirrors the same validator
 * shape used in `besselj.ts` / `erf.ts`.
 */
function requireFiniteBesselIInput(x: BigFloat, fn: string, name: string): void {
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
    // Same 2^1024 loud cliff as `besselj.ts`.  In practice this never
    // trips for any real-axis input that fits in a double, but for I
    // particularly it is the right place to fail loud rather than emit
    // a BigFloat whose exponent has overflowed integer-representation.
    if (magnitudeBits > 1024) {
      throw new RangeError(
        `${fn}: ${name} magnitude ~ 2^${magnitudeBits} exceeds the supported ` +
          `Bessel-family input range (|${name}| > 2^1024). ` +
          `suggestion: at this magnitude, I_ν(z) ~ exp(z) is unrepresentable in ` +
          `any reasonable BigFloat; use bigBesselIScaled instead (= exp(-|z|) · I_ν(z), ` +
          `which is O(1/√z) for all z).`,
      );
    }
  }
}

// =============================================================================
// bigBesselISeriesMaclaurin — DLMF 10.25.2 ₀F₁ Maclaurin (all-positive)
// =============================================================================

/**
 * Power-series evaluator for `I_ν(z)` via the defining Maclaurin
 * (DLMF 10.25.2):
 *
 *   I_ν(z) = (z/2)^ν · Σ_{k=0}^∞ (z²/4)^k / (k! · Γ(ν+k+1))
 *
 * Reformulated as a prefactored ₀F₁:
 *
 *   I_ν(z) = (z/2)^ν / Γ(ν+1) · ₀F₁(; ν+1; z²/4)
 *          = prefactor · Σ_{k=0}^∞ T_k
 *   T_0    = 1
 *   T_{k+1}= T_k · (z²/4) / ((k+1) · (ν+k+1))
 *
 * **All terms are positive** for real ν ≥ 0 and real z ≥ 0.  No
 * alternation, no cancellation, no measure-and-bump retry harness.
 * This is the structural reason I's substrate is simpler than J's: the
 * raw series IS the cancellation-safe series.
 *
 * Algorithm: walk the recurrence; sum; terminate when
 * `|T_{k+1}| < |sum| · 2^-(prec + 8)`.  The `+ 8` is a guard against
 * the final few terms contributing to the last bits of the rounded
 * answer.
 *
 * Convergence: terms peak at `k ≈ |z|/2` and shrink geometrically
 * thereafter with ratio `≈ (z/(2k))²`.  Total term count for prec p ≈
 * `|z|/2 + p · ln 2 / ln(2k/|z|) ≈ |z|/2 + p` at the asymptote — the
 * SAME asymptotic count as J's series, but each I term is cheaper
 * because we skip the sign-tracking.
 *
 * Working precision is `prec + 32`: 32 bits absorbs the prefactor's
 * `pow` + `gamma` rounding, the `~p` cumulative additions, and the
 * final multiplications.  **NO cancellation budget is allocated** —
 * the series has no cancellation, period.  Contrast J's series, where
 * the caller must either know `ν > z²/4` (FLINT short-circuit) or
 * call the cancellation-retry wrapper.  Here, *every* caller is safe.
 *
 * Special-case fast path: ν integer and ν > 0 ⇒ I_ν(0) = 0;
 *                         ν = 0           ⇒ I_0(0) = 1.
 * Handled inside `bigBesselI` rather than here, because the prefactor
 * `(z/2)^ν` for non-integer ν at z = 0 is the multi-valued boundary
 * the caller must already have resolved.
 *
 * @throws RangeError on non-finite ν or z (via requireFiniteBesselIInput).
 */
export function bigBesselISeriesMaclaurin(
  nu: BigFloat,
  z: BigFloat,
  prec: number,
): BigFloat {
  requireFiniteBesselIInput(nu, "bigBesselISeriesMaclaurin", "nu");
  requireFiniteBesselIInput(z, "bigBesselISeriesMaclaurin", "z");
  if (isZero(z)) {
    // I_ν(0) = 0 for Re(ν) > 0, 1 for ν = 0.  We do not reach here for
    // non-positive non-integer ν (the public entry point validates that).
    if (isZero(nu)) return normalise(1n, 0, prec);
    if (sgn(nu) > 0) return { mantissa: 0n, exponent: 0, precision: prec };
    throw new RangeError(
      `bigBesselISeriesMaclaurin: I_ν(0) undefined for ν < 0 non-integer; ` +
        `suggestion: use the connection I_{-n}(z) = I_n(z) at integer ν, ` +
        `or evaluate symbolically.`,
    );
  }
  const work = prec + 32;
  // Build the recurrence ingredient.
  //   quarterZSquared := +z² / 4   (the constant in T_{k+1}/T_k — NOTE
  //   the sign! J uses -z²/4; I uses +z²/4 because of the all-positive
  //   modified-series.  M1 mutation point: dropping the +/- sign here
  //   makes the routine compute J instead, which fails the I_0(1)≈1.266
  //   special-value test.)
  const zSquared = mul(z, z, work);
  const quarter = fromFloat64(0.25);
  const quarterZSquared = mul(zSquared, quarter, work);
  // Series sum; T_0 = 1.
  let sum = fromInt(1n, work);
  let term = fromInt(1n, work);
  // Termination threshold: |next_term| < |sum| · 2^-(prec + 8).
  const stopMagThreshold = -prec - 8;
  // Safety cap.  Total term count ≈ |z|/2 + prec — generously bounded
  // by work · 4.  The asymptotic regime is *not* routed through this
  // primitive — its caller bounds |z|.
  const absZFloat = toFloat64(abs(z)).value;
  const expectedTerms = Number.isFinite(absZFloat) ? absZFloat / 2 + work : work * 4;
  const maxTerms = Math.max(64, Math.ceil(expectedTerms * 2) + 32);
  for (let k = 0; k < maxTerms; k++) {
    //   T_{k+1} = T_k · (z²/4) / ((k+1) · (ν + k + 1))
    //
    // M1 mutation point: dropping the `(k+1)·(ν+k+1)` denominator term
    // (using only `(k+1)`, say) makes the series sum a geometric form
    // that diverges or produces wildly wrong values.  Verified by
    // commenting out `nuPlusKPlus1` and watching I_0(1) blow up.
    const kPlus1 = fromInt(BigInt(k + 1), work);
    const nuPlusKPlus1 = add(nu, kPlus1, work);
    // Skip the pole at ν+k+1 = 0 — never reached for ν ≥ 0
    // (the dispatcher routes negative integer ν through I_{-n}(z) = I_n(z),
    // never to direct Maclaurin on a negative-integer ν).
    if (isZero(nuPlusKPlus1)) {
      throw new RangeError(
        `bigBesselISeriesMaclaurin: ν + ${k + 1} = 0 hits Γ pole; ` +
          `suggestion: dispatch should route negative integer ν through I_{-n} = I_n.`,
      );
    }
    const denom = mul(kPlus1, nuPlusKPlus1, work);
    term = div(mul(term, quarterZSquared, work), denom, work);
    sum = add(sum, term, work);
    const termMag = magBits(term);
    const sumMag = magBits(sum);
    if (termMag === -Infinity) break;
    if (termMag - sumMag < stopMagThreshold) break;
  }
  // Prefactor: (z/2)^ν / Γ(ν+1).
  //
  // For integer non-negative ν, (z/2)^ν is exact via the integer
  // fast-path of `transcendental.pow`.  For half-integer / general
  // real positive ν, `pow` falls through to `exp(ν · log(z/2))`.
  // `gamma(ν+1)` handles arbitrary positive real argument.
  const half = fromFloat64(0.5);
  const halfZ = mul(z, half, work);
  const halfZPowNu = powerReal(halfZ, nu, work);
  const one = fromInt(1n, work);
  const gammaNuPlus1 = gamma(add(nu, one, work), work);
  const prefactor = div(halfZPowNu, gammaNuPlus1, work);
  const result = mul(prefactor, sum, work);
  return normalise(result.mantissa, result.exponent, prec);
}

/**
 * `(base)^exponent` for `base > 0`, real `exponent`.  Defers to the
 * standard `transcendental.pow` to inherit its integer fast-path *and*
 * the `exp(ν · log(base))` fall-through.  Local helper to document the
 * call-site intent and to share shape with `besselj.ts`'s `powerReal`.
 *
 * `base = 0` is gated by `isZero(z)` short-circuiting in
 * `bigBesselISeriesMaclaurin` before this helper is called, so
 * `base > 0` is the load-bearing precondition.
 */
function powerReal(base: BigFloat, exponent: BigFloat, prec: number): BigFloat {
  if (isZero(exponent)) return normalise(1n, 0, prec);
  if (isZero(base)) {
    return { mantissa: 0n, exponent: 0, precision: prec };
  }
  return pow(base, exponent, prec);
}

// =============================================================================
// bigBesselIHankelAsymptotic — DLMF 10.40.1 (optimal truncation)
// =============================================================================

/**
 * Asymptotic evaluator for `I_ν(z)` at large positive `z`, via the
 * modified-Hankel expansion (DLMF 10.40.1, R2 §2.2 lines 661-691):
 *
 *   I_ν(z) ~ (e^z / √(2πz)) · Σ_{k=0}^∞ (-1)^k · a_k(ν) / z^k
 *
 * coefficients `a_k(ν) = (4ν² − 1)(4ν² − 9) · ··· · (4ν² − (2k−1)²) /
 * (k! · 8^k)` — the SAME a_k as J's Hankel, but the modified-Hankel
 * form has NO P/Q split, no `cos(ω) − sin(ω)` mixing, no phase argument
 * `ω = z − νπ/2 − π/4`.  Just one alternating sum with `(-1)^k` and a
 * pure-exponential prefactor.
 *
 * Per-term recurrence (folding the `1/z^k` into the running term):
 *
 *   T_0 = 1
 *   T_{k+1} = - T_k · (4ν² − (2k+1)²) / (8 · (k+1) · z)
 *
 * The leading `-` carries the `(-1)^k` alternation.  Note the contrast
 * with J's Hankel: there, the alternation feeds into separate P and Q
 * accumulators with a 4-periodic sign cycle; here, every term goes
 * into a single `sum` accumulator with the simpler 2-periodic sign.
 *
 * **The series diverges** if summed to infinity (Poincaré asymptotic).
 * Optimal truncation: track per-term magnitude; the moment
 * `|T_{k+1}| > |T_k|` we stop and return the partial sum.  The
 * Poincaré remainder at optimal truncation is bounded by twice the
 * magnitude of the first omitted term (Olver 1974 Theorem 3.1,
 * DLMF 10.40 remainder bound).  Mirrors `lgammaStirling`
 * (`packages/bigfloat/src/special.ts:117`), `bigErfcAsymptotic`, and
 * `bigBesselJHankelAsymptotic`.
 *
 * Caller is responsible for ensuring `z > 0`; the asymptotic is *only*
 * useful when `|z| > z_c_Hankel(prec)` (≈ prec/2 — same crossover as
 * J's Hankel because the same `a_k` coefficient suppression rate
 * `1/(8|z|)` per term governs both).  Throws on non-positive z.
 *
 * Cancellation surface: NONE.  Unlike J's Hankel (which has cancellation
 * near zeros of J_ν via `cos(ω) P − sin(ω) Q ≈ 0`), I_ν(z) > 0 for
 * real ν ≥ 0, real z > 0 — there are no real zeros.  Successive
 * alternating-term cancellation in the asymptotic sum itself is benign
 * up to the truncation index because the term ratio is monotonically
 * decreasing (DLMF 10.40.2 envelope) — by the time the terms cancel
 * meaningfully, we've already truncated.
 *
 * Working precision is `prec + 32`.  The prefactor `e^z` is O(e^z)
 * (NOT O(1)!) — at `z = 200`, `e^z ≈ 10^87`, so the prefactor pushes
 * the working representation up by ~289 bits of integer-part.  This is
 * fine for BigFloat (the exponent is just an int), but it's the reason
 * the scaled variant exists: when *consumed* into a downstream computation
 * that immediately multiplies by `e^{-z}` (as quadrature integrands
 * typically do), this giant prefactor flips back to O(1) and the
 * intermediate magnitude was wasted.  `bigBesselIScaled` skips the
 * round-trip.
 */
export function bigBesselIHankelAsymptotic(
  nu: BigFloat,
  z: BigFloat,
  prec: number,
): BigFloat {
  requireFiniteBesselIInput(nu, "bigBesselIHankelAsymptotic", "nu");
  requireFiniteBesselIInput(z, "bigBesselIHankelAsymptotic", "z");
  if (sgn(z) <= 0) {
    throw new RangeError(
      `bigBesselIHankelAsymptotic: z must be positive; got sign ${sgn(z)}. ` +
        `suggestion: for negative real z use the parity I_n(-z) = (-1)^n I_n(z) ` +
        `(integer ν) in the dispatcher; non-integer negative ν or non-integer ν ` +
        `with negative z requires the complex branch (DLMF 10.34.2 branch cut).`,
    );
  }
  const work = prec + 32;
  // μ := 4ν², the parameter that feeds the coefficient recurrence.
  const fourNuSquared = mul(fromInt(4n, work), mul(nu, nu, work), work);
  // Single alternating sum.  T_0 = 1.
  let term = fromInt(1n, work);
  let sum = fromInt(1n, work);
  let prevTermMag = Infinity;
  const eightZ = mul(fromInt(8n, work), z, work);
  // Safety cap. Smallest-term index k* ≈ 4|z| (R2 §2.2); cap is generous.
  const maxTerms = Math.max(64, work * 4);
  for (let k = 0; k < maxTerms; k++) {
    // T_{k+1} = - T_k · (4ν² − (2k+1)²) / (8 (k+1) z).
    //
    // M3 mutation point: dropping the leading `-` (i.e. using
    // `term = div(...)` without `neg`) makes the asymptotic an
    // all-positive sum, which is the K-asymptotic NOT the I-asymptotic.
    // I_0(100) ≈ 1.07e+42 then comes out as a wildly different magnitude.
    const twoKPlus1 = 2 * k + 1;
    const twoKPlus1Squared = fromInt(BigInt(twoKPlus1 * twoKPlus1), work);
    const numerCoeff = sub(fourNuSquared, twoKPlus1Squared, work);
    const denom = mul(fromInt(BigInt(k + 1), work), eightZ, work);
    term = neg(div(mul(term, numerCoeff, work), denom, work));
    const termMag = magBits(term);
    if (termMag === -Infinity) {
      // Exact zero — happens iff 4ν² = (2k+1)² exactly, i.e. ν is a
      // half-integer and the recurrence hits its termination at k_stop.
      // I_{n+1/2}(z) is in fact representable as a finite combination
      // of `sinh` and `cosh`; the asymptotic terminates naturally here.
      break;
    }
    // Optimal-truncation rule: if this term is larger than the previous
    // one, the series is diverging — STOP without adding.
    if (termMag > prevTermMag) {
      break;
    }
    sum = add(sum, term, work);
    prevTermMag = termMag;
    // Termination on absolute term size below the precision floor.
    if (termMag < -prec - 8) {
      break;
    }
  }
  // Prefactor e^z / √(2πz).
  const expZ = exp(z, work);
  const piVal = pi(work);
  const two = fromInt(2n, work);
  const twoPiZ = mul(two, mul(piVal, z, work), work);
  const sqrtTwoPiZ = sqrt(twoPiZ, work);
  const prefactor = div(expZ, sqrtTwoPiZ, work);
  const result = mul(prefactor, sum, work);
  return normalise(result.mantissa, result.exponent, prec);
}

// =============================================================================
// bigBesselI — the entry point
// =============================================================================

/**
 * Real-axis modified Bessel function of the first kind at user-controlled
 * precision.
 *
 *   I_ν(z) = (z/2)^ν · Σ_{k=0}^∞ (z²/4)^k / (k! · Γ(ν+k+1))
 *
 * Algorithm dispatch (R2 §3.3 + DLMF §10.40 + FLINT `bessel_i.c:204-218`):
 *
 *   z = 0:                   closed form (1 if ν=0, 0 if ν>0 integer,
 *                            error otherwise).
 *   z < 0:                   reflect via I_n(-z) = (-1)^n I_n(z)
 *                            (integer ν) — non-integer negative-z input
 *                            errors with a `suggestion:` line pointing
 *                            at complex-z dispatch (deferred to I3b).
 *   |z| < 16                 → Maclaurin direct (FLINT's |z| < 2^4 lane).
 *   |z| < 2^64 AND 2|z| < p  → Maclaurin direct (FLINT's broader 0F1 region).
 *   otherwise                → modified-Hankel asymptotic.
 *
 * Determinism: every operation is `BigInt` + bounded-integer-exponent
 * arithmetic; `BigInt` is bit-identical across runtimes by language
 * specification.  Inherits the `arbprec: true` contract of ADR-0020 —
 * same `(nu, z, prec)` bytes → byte-identical output forever.
 *
 * @throws RangeError on non-finite input or on configurations not yet
 * supported (negative non-integer ν with z = 0, negative non-integer
 * z, etc.).
 */
export function bigBesselI(nu: BigFloat, z: BigFloat, prec: number): BigFloat {
  requireFiniteBesselIInput(nu, "bigBesselI", "nu");
  requireFiniteBesselIInput(z, "bigBesselI", "z");
  if (prec < 1 || !Number.isInteger(prec)) {
    throw new RangeError(
      `bigBesselI: prec must be a positive integer; got ${prec}. ` +
        `suggestion: use decimalToBinaryPrecision(<digits>) for a decimal target.`,
    );
  }
  // z = 0 closed forms.
  if (isZero(z)) {
    if (isZero(nu)) return normalise(1n, 0, prec);
    if (sgn(nu) > 0) return { mantissa: 0n, exponent: 0, precision: prec };
    // ν < 0: I_n(0) = 0 still holds for negative integer ν via the
    // identity I_{-n}(z) = I_n(z) and I_n(0) = 0 for n > 0; but for
    // non-integer negative ν, I_ν(z) ~ (z/2)^ν / Γ(ν+1) → ∞ at z = 0.
    const nuFloat = toFloat64(nu).value;
    if (Number.isFinite(nuFloat)) {
      const nuRound = Math.round(nuFloat);
      const nuRoundedBack = fromInt(BigInt(nuRound), nu.precision);
      if (eq(nu, nuRoundedBack)) {
        // Integer negative ν: I_{-n}(0) = I_n(0) = 0 for n ≥ 1.
        return { mantissa: 0n, exponent: 0, precision: prec };
      }
    }
    throw new RangeError(
      `bigBesselI: I_ν(0) is unbounded for negative non-integer ν; ` +
        `suggestion: at z = 0, I_ν is singular for Re(ν) < 0 non-integer; ` +
        `use the symbolic limit instead.`,
    );
  }
  // Real negative z: route through parity for integer ν, refuse for
  // non-integer ν (would need complex-z dispatch, I3b).
  //
  // Per DLMF 10.34.2: I_ν(z · e^{i m π}) = e^{i m ν π} · I_ν(z).  For
  // m = 1 (i.e. negative real z) and integer ν, the phase is
  // `e^{i ν π} = (-1)^ν` — the parity rule.  For non-integer ν, the
  // phase is a non-real complex number and the result is complex.
  if (sgn(z) < 0) {
    const nuFloat = toFloat64(nu).value;
    if (Number.isFinite(nuFloat)) {
      const nuRound = Math.round(nuFloat);
      const nuRoundedBack = fromInt(BigInt(nuRound), nu.precision);
      if (eq(nu, nuRoundedBack)) {
        // I_ν(-z) = (-1)^ν I_ν(z) for integer ν.
        const positiveResult = bigBesselI(nu, neg(z), prec);
        return (nuRound & 1) === 0 ? positiveResult : neg(positiveResult);
      }
    }
    throw new RangeError(
      `bigBesselI: real negative z with non-integer ν requires the complex ` +
        `branch (I_ν has a branch point at z=0 for non-integer ν, DLMF 10.34.2); ` +
        `not yet supported on the real arb-prec path. ` +
        `suggestion: route through the complex evaluator bigCBesselI (I3b; ` +
        `bead scientist-workbench-t73h) once it ships.`,
    );
  }
  // Negative integer ν: I_{-n}(z) = I_n(z) (DLMF 10.27.1).  Note this
  // is DIFFERENT from J's parity I_{-n} = +I_n vs J_{-n} = (-1)^n J_n —
  // the modified-Bessel I family is symmetric in integer ν.
  if (sgn(nu) < 0) {
    const nuFloat = toFloat64(nu).value;
    if (Number.isFinite(nuFloat)) {
      const nuRound = Math.round(nuFloat);
      const nuRoundedBack = fromInt(BigInt(nuRound), nu.precision);
      if (eq(nu, nuRoundedBack)) {
        return bigBesselI(neg(nu), z, prec);
      }
    }
    // Non-integer negative ν is in principle reachable on the real path
    // via I_{-ν}(z) = I_ν(z) + (2/π) sin(νπ) K_ν(z) (DLMF 10.27.2), but
    // that requires bigBesselK which is I2b (bead q0wr), shipping
    // jointly with this bead.  Refuse cleanly until I2b lands.
    throw new RangeError(
      `bigBesselI: negative non-integer ν requires bigBesselK (I2b); ` +
        `not yet wired in I2a. ` +
        `suggestion: until I2b lands, evaluate I_{-ν}(z) via the connection ` +
        `formula I_{-ν}(z) = I_ν(z) + (2/π) sin(νπ) K_ν(z) manually, or ` +
        `wait for the joint I/K substrate.`,
    );
  }
  // z > 0, ν ≥ 0: the main dispatch.  FLINT pattern, `bessel_i.c:212-216`.
  //
  //   if |z| < 16:                                  → 0F1
  //   if |z| < 2^64 AND 2|z| < prec:                → 0F1
  //   else:                                          → asymptotic
  //
  // M_dispatch mutation point: tightening "|z| < 16" to "|z| < 4" routes
  // z = 5..15 to the asymptotic which is wildly inaccurate there.  Tested
  // by flipping the constant and watching I_0(8) diverge from the golden.
  const absX = abs(z);
  const xFloat = toFloat64(absX).value;
  // Small-z lane #1: |z| < 16.  FLINT's `mag_cmp_2exp_si(zmag, 4) < 0`.
  if (Number.isFinite(xFloat) && xFloat < 16) {
    return bigBesselISeriesMaclaurin(nu, absX, prec);
  }
  // Mid-z lane: |z| < 2^64 AND 2|z| < prec.  FLINT's broader 0F1 region.
  // The 2^64 cap is a finite-magnitude guard for FLINT's internal mag_t;
  // we keep the same condition for portability of the dispatch (xFloat
  // is finite here since we've already passed the < 16 lane).
  if (Number.isFinite(xFloat) && xFloat < (1 << 30) && 2 * xFloat < prec) {
    return bigBesselISeriesMaclaurin(nu, absX, prec);
  }
  // Asymptotic lane: |z| large relative to prec.
  return bigBesselIHankelAsymptotic(nu, absX, prec);
}

// =============================================================================
// bigBesselIScaled — exp(-|z|) · I_ν(z), the overflow-safe variant
// =============================================================================

/**
 * Scaled modified Bessel I: returns `e^{-|z|} · I_ν(z)`.
 *
 * Same `(nu, z, prec)` contract as `bigBesselI`; the result is finite
 * and O(1/√z) for all positive z (no overflow even at z = 1e6).  Use
 * this variant whenever:
 *
 *   - the consumer immediately multiplies by `e^{-z}` (typical for
 *     integrands of the form `∫ f(z) · I_ν(z) · e^{-z} dz`),
 *   - `z > 700` is even remotely plausible (float64 cliff),
 *   - downstream code needs to pretty-print or log the value at large z.
 *
 * Precedent: `bigErfcx` (Erf scaled complementary).  See R3 §0.2 +
 * ADR-0041 §"Decision 4" + AMOS's `cyl_bessel_i_scaled`.
 *
 * Implementation: composed from `bigBesselI` + `exp(-|z|)` at
 * `work = prec + 64`.  The extra 32 bits over the standard `prec + 32`
 * working budget cover the cancellation between `e^z` (in I's
 * asymptotic prefactor) and the `e^{-z}` factor we apply afterwards —
 * the two should largely cancel structurally, but the BigFloat
 * substrate computes them independently, so we pay for the rounding
 * floor of each.  At very large z (z = 700, work = 200), this works
 * out to `e^z` and `e^{-z}` cancelling to ~700·log₂(e) ≈ 1010 bits of
 * total magnitude span — well within our work budget when prec ≤ ~900,
 * marginal beyond that.  For higher precision at very large z, a future
 * follow-up could implement the FLINT trick (`bessel_i.c:67-70`:
 * merge `exp(-z)` into the asymptotic prefactor analytically so the
 * `e^z` is never formed at all); v0.1 keeps the simple composition.
 *
 * **M2 mutation point:** dropping the `exp(-|z|)` factor (returning
 * `bigBesselI(nu, z, prec)` directly) makes `bigBesselIScaled(0, 700)`
 * return `~10^304` instead of `~0.015`, immediately failing the
 * overflow-protection test.
 *
 * @throws RangeError on non-finite input (delegates to `bigBesselI`).
 */
export function bigBesselIScaled(
  nu: BigFloat,
  z: BigFloat,
  prec: number,
): BigFloat {
  requireFiniteBesselIInput(nu, "bigBesselIScaled", "nu");
  requireFiniteBesselIInput(z, "bigBesselIScaled", "z");
  if (prec < 1 || !Number.isInteger(prec)) {
    throw new RangeError(
      `bigBesselIScaled: prec must be a positive integer; got ${prec}. ` +
        `suggestion: use decimalToBinaryPrecision(<digits>) for a decimal target.`,
    );
  }
  // z = 0 fast-path: e^0 · I_ν(0) = I_ν(0).  Delegate; no scaling change.
  if (isZero(z)) {
    return bigBesselI(nu, z, prec);
  }
  const work = prec + 64;
  // |z| absolute value — handles both sign branches uniformly.  For
  // negative z with integer ν the underlying bigBesselI will apply its
  // own parity reflection; e^{-|z|} prefix is sign-insensitive by
  // construction.
  const absZ = abs(z);
  const iValue = bigBesselI(nu, z, work);
  const expNegAbsZ = exp(neg(absZ), work);
  const result = mul(iValue, expNegAbsZ, work);
  return normalise(result.mantissa, result.exponent, prec);
}
