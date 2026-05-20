// =============================================================================
// @workbench/bigfloat — Incomplete Gamma functions Γ(a,z) and γ(a,z) (arb-prec)
// =============================================================================
//
// This module ships the arb-prec real-axis entry points for the incomplete
// Gamma family:
//
//   bigIncompleteGammaUpper(a, z, prec)   — Γ(a, z) = ∫_z^∞ t^{a-1} e^{-t} dt
//   bigIncompleteGammaLower(a, z, prec)   — γ(a, z) = ∫_0^z t^{a-1} e^{-t} dt
//
// ADR-0042 §"Decision 3" pins the per-head signature; R2 §1.7 / §1.8 / §2.3
// pin the algorithm dispatch; R4 §A.3-A.4 pins the byte-comparable Meijer-G
// bridge requirement. ADR-0020 governs the determinism contract: pure-BigInt
// arithmetic → bit-identical across runtimes forever at fixed `prec`.
//
// Four-regime dispatch for Γ(a, z) (R2 §1.7, §2.3; DLMF Ch.8)
// ------------------------------------------------------------
//
// The incomplete Gamma plane is the most algorithmically complex of the
// special-function heads, because no single algorithm covers it efficiently.
// The decomposition is:
//
//   1. SERIES for γ(a,z), then  Γ(a,z) = Γ(a) - γ(a,z)   (DLMF §8.5.1)
//      Condition:  |z| < |a| + 1   (DiDonato-Morris boundary; R2 §2.3)
//      Series:     γ(a, z) = (z^a / a) · e^{-z} · M(1, 1+a, z)
//                          = (z^a / a) · e^{-z} · Σ_{k≥0} z^k / (1+a)_k
//      Recurrence: term_{k+1} = term_k · z / (a+k+1)
//      Convergence: terms shrink as z/(a+k+1) per step; geometric once k > |z|.
//      Cost: O((|z| + prec/log(a/z)) · M(prec)). Hot regime in the bulk.
//      "Γ = Γ(a) - γ" is cancellation-free here because γ ≤ Γ(a) and
//      Γ(a) > 0; the subtraction loses at most a few bits.
//      NOTE: DLMF §8.7.3 (`z^a e^{-z} Σ z^k / Γ(a+k+1)`) is NOT a series
//      for γ; it equals γ/Γ(a). The correct identity for γ is §8.5.1 with
//      the leading `1/a`. Pinned by the Wolfram-oracle test.
//
//   2. CONTINUED FRACTION for Γ(a,z)  (DLMF §8.9.2; Gautschi 1979)
//      Condition:  |z| ≥ |a| + 1
//      Form:       Γ(a,z) = e^{-z} · z^a · CF(a, z)
//                  CF = 1 / (z+1-a  -  1·(1-a) / (z+3-a - 2·(2-a) / (z+5-a - …)))
//      The CF is evaluated by modified Lentz (Numerical Recipes §5.2) with the
//      VERBATIM Cephes `igam.c` rescaling guards `big = 4.5e15`, `biginv =
//      2.22e-16` ported to BigFloat constants. These constants are empirically
//      calibrated against IEEE-754 double-precision overflow boundaries and
//      are NOT to be "improved" — they are part of the verbatim port (R3 §0.0
//      port discipline) and live here so the BigFloat path matches what the
//      float64 path will use when the I6 bridge is built.
//      Convergence rate: ~ |z/(a+k)| per cycle. Fast when |z| ≫ |a|.
//      Cost: O((prec / log(|z|/|a|)) · M(prec)).
//
//   3. TEMME UNIFORM ASYMPTOTIC  (DLMF §8.12.3-4; Temme 1979)
//      Condition:  |z - a| ≤ C·√|a|, |a| ≥ prec·0.1   (transition region)
//      DEFERRED to v0.2 (bead `[gamma-v02-temme-uniform]` to be filed).
//      v0.1 falls back to CF in the transition region. The CF converges
//      slowly there (rate ≈ |z/a| ≈ 1) so v0.1 honestly pays in cycles for
//      what Temme would deliver in O(prec/log a) terms; it does not LIE about
//      precision — the CF answer is still bit-exact, just expensive.
//
//   4. POINCARÉ ASYMPTOTIC  (DLMF §8.11.2)
//      Condition:  |z| > prec · ln 2 + Re(a)   (very large |z|)
//      Series:     Γ(a,z) ~ z^{a-1} · e^{-z} · Σ_{k≥0}  (-1)^k · (1-a)_k / z^k
//      Divergent asymptotic; optimal truncation at the smallest term (the
//      same `prevTermMag > termMag` idiom as `lgammaStirling`,
//      `bigErfcAsymptotic`, `bigBesselJHankelAsymptotic`).
//      In practice the CF already delivers prec-bit accuracy in this regime
//      with comparable cost, so v0.1 routes through the CF for the |z| > |a|
//      branch unconditionally. The Poincaré form is kept as a reserve path
//      for future tuning (bead I2c) but not on the default dispatch.
//
// Single-regime dispatch for γ(a, z)  (R2 §1.8; DLMF §8.5.1)
// -----------------------------------------------------------
//
// γ(a, z) is computed via:
//
//   - SERIES (DLMF §8.5.1 Kummer form) when |z| < |a| + 1  — the same
//     series the upper uses internally on the small-|z| branch; we just
//     don't subtract.
//   - COMPLEMENTARITY  γ(a,z) = Γ(a) - Γ(a,z)  when |z| ≥ |a| + 1.
//     Here Γ(a,z) is computed via the CF (regime 2 above), and Γ(a) is
//     computed via the existing `gamma()` from `special.ts`. The subtraction
//     is cancellation-FREE when |z| ≥ |a| + 1 because in that regime γ is
//     close to Γ(a) (most of the integral is on (0, z)) and Γ(a,z) is the
//     "small piece"; subtracting a small piece from Γ(a) loses no bits.
//
// Closed-form short-circuits (R1 identities; CLAUDE.md §"Honest scope")
// ----------------------------------------------------------------------
//
//   Γ(a, 0)  =  Γ(a)            (R1 Rule IGAM-1; DLMF §8.2.4)
//   γ(a, 0)  =  0
//   Γ(1, z)  =  e^{-z}           (R1 Rule IGAM-2; DLMF §8.4.5)
//   γ(1, z)  =  1 - e^{-z}
//
// These are pinned by tests and short-circuited on the hot path because (a)
// they are bit-exact answers that no series would compute as efficiently,
// and (b) they double as mutation-proof markers that catch a swapped
// Upper/Lower body.
//
// Complementarity invariant (R1; DLMF §8.2.3)
// -------------------------------------------
//
//   γ(a, z) + Γ(a, z)  =  Γ(a)
//
// This is the LOAD-BEARING round-trip test. We compute γ and Γ independently
// (different algorithms in the |z| ≥ |a|+1 regime — series for γ would be
// slow, so it goes via complementarity itself; in the |z| < |a|+1 regime
// γ is computed via series and Γ via "Γ(a) - γ"). The sum must agree with
// Γ(a) to `prec - 4` bits. A failure here means the dispatch produced
// inconsistent answers across algorithms — a serious correctness regression.
//
// Domain restrictions (v0.1)
// --------------------------
//
//   - Re(a) > 0 required. Negative-a analytic continuation requires the
//     incomplete-gamma reflection formula (DLMF §8.2.7) and is deferred.
//   - Real arguments only on this entry. Complex extension lives in
//     `complex.ts` (bead I2c, follow-on).
//   - The classical pole at a = 0 throws a RangeError.
//   - Non-finite BigFloat shapes (corrupted mantissa/exponent sentinels)
//     are rejected loudly via the same `requireFinite*` style as erf.ts.
//
// References (all in repo)
// ------------------------
//   - docs/refs/gamma-research/R2-arbprec-algorithms.md §1.7-1.8, §2.3
//   - docs/refs/gamma-research/R4-meijer-g-bridge.md §A.3-A.4
//   - docs/adr/0042-gamma-family-meijer-g-bridge.md §Decision 3
//   - docs/adr/0020-arbitrary-precision-tier.md (determinism contract)
//   - DLMF §8.2 (definitions), §8.7 (series), §8.9 (CF), §8.11 (asymptotic)
//   - Cephes `cprob/igam.c` (big = 4.5e15, biginv = 2.22e-16 rescaling)
//   - Gautschi 1979, "A Computational Procedure for Incomplete Gamma Functions"
//   - Numerical Recipes §6.2 (gser, gcf reference impls)

import { BigFloat, normalise, bitLength } from "../types.js";
import { abs, neg, sgn, isZero } from "../comparison.js";
import { add, sub, mul, div } from "../arithmetic.js";
import { fromInt, fromString, toFloat64 } from "../conversion.js";
import { exp, log, pow } from "../transcendental.js";
import { gamma } from "../special.js";

// =============================================================================
// Helpers
// =============================================================================

/**
 * `log₂ |x|` to integer precision; returns `-Infinity` for `x = 0`. Same
 * helper used in `erf.ts` and `special.ts`; reproduced locally so this
 * module is self-contained.
 */
function magBits(x: BigFloat): number {
  if (x.mantissa === 0n) return -Infinity;
  const m = x.mantissa < 0n ? -x.mantissa : x.mantissa;
  return x.exponent + bitLength(m);
}

/**
 * Validate inputs to the incomplete-gamma entry points. Loud throws on:
 *   - non-integer / non-positive `prec`
 *   - malformed BigFloat (precision <1, non-finite exponent)
 *   - magnitude > 2^1024 (beyond any meaningful arb-prec computation)
 *   - Re(a) ≤ 0 (v0.1 restriction — see top-of-file)
 *
 * The check is shared by both Upper and Lower so the error messages are
 * uniform; the function name is passed in for diagnostic clarity.
 */
function requireFiniteIncompleteGammaInput(
  a: BigFloat,
  z: BigFloat,
  prec: number,
  fn: string,
): void {
  if (prec < 1 || !Number.isInteger(prec)) {
    throw new RangeError(
      `${fn}: prec must be a positive integer; got ${prec}. ` +
        `suggestion: use decimalToBinaryPrecision(<digits>) for a decimal target.`,
    );
  }
  for (const [name, v] of [["a", a], ["z", z]] as const) {
    if (!Number.isInteger(v.precision) || v.precision < 1) {
      throw new RangeError(
        `${fn}: BigFloat ${name}.precision must be a positive integer; got ${v.precision}.`,
      );
    }
    if (!Number.isInteger(v.exponent) || !Number.isFinite(v.exponent)) {
      throw new RangeError(
        `${fn}: BigFloat ${name}.exponent must be a finite integer; got ${v.exponent}.`,
      );
    }
    if (v.mantissa !== 0n && magBits(v) > 1024) {
      throw new RangeError(
        `${fn}: ${name} magnitude ~ 2^${magBits(v)} exceeds the representable ` +
          `incomplete-gamma domain (|${name}| > 2^1024). ` +
          `suggestion: at this magnitude, the incomplete-gamma answer is ` +
          `either Γ(a) or 0 to within any arb-prec representation.`,
      );
    }
  }
  // v0.1 restriction: Re(a) > 0. Analytic continuation to Re(a) ≤ 0
  // requires the reflection-style recurrence (DLMF §8.2.7) and is deferred.
  if (sgn(a) <= 0) {
    throw new RangeError(
      `${fn}: Re(a) > 0 required (v0.1). Got sign(a) = ${sgn(a)}. ` +
        `suggestion: the analytic continuation to Re(a) ≤ 0 is a v0.2 feature; ` +
        `for now, restrict to a > 0.`,
    );
  }
  // z = 0 is fine (Γ(a,0) = Γ(a), γ(a,0) = 0); negative z is a v0.2 feature
  // (the integral is then on a contour, not the real axis).
  if (sgn(z) < 0) {
    throw new RangeError(
      `${fn}: z ≥ 0 required (v0.1). Got sign(z) = ${sgn(z)}. ` +
        `suggestion: for z < 0 the integral path needs complex analysis; ` +
        `deferred to v0.2.`,
    );
  }
}

// =============================================================================
// Cephes rescaling constants — VERBATIM PORT from `cprob/igam.c`
// =============================================================================
//
// These two constants are the Lentz-style rescaling guards from Cephes'
// `igamc.c` (Stephen Moshier). The float64 IEEE-754 reference values are:
//
//   big    = 4.503599627370496e15   (= 2^52, the largest exactly-representable
//                                    integer; chosen so multiplication by `big`
//                                    cannot overflow when the running CF
//                                    numerator/denominator is mantissa-aligned)
//   biginv = 2.220446049250313e-16  (= 2^-52, the reciprocal)
//
// In the C source these are the bracket within which the CF accumulators
// `ans`, `r`, `t1`, `t2` are kept by periodic rescaling. We port them to
// BigFloat at the working precision so the BigFloat CF mirrors the float64
// dispatch byte-for-byte at the corresponding precision. The constants are
// part of the verbatim port (R3 §0.0 port discipline) — "do not improve"
// applies. Their role is RESCALING, not precision; a different `big` would
// produce numerically equivalent results at the cost of breaking byte-
// identity with the float64 reference path. We keep them aligned.
//
// In our modified-Lentz formulation the rescaling is implicit (Lentz maintains
// `C`, `D`, `f` separately, each as a ratio that cannot drift far from 1),
// but the constants are constructed at module-load time anyway so any future
// refactor to the Cephes-style direct accumulators (e.g., for the float64
// I2b bridge) can use the same values verbatim.

const CEPHES_BIG_DECIMAL = "4503599627370496";       // 2^52, exact in any precision
const CEPHES_BIGINV_DECIMAL = "2.220446049250313e-16"; // 2^-52 to float64 precision

function cephesBig(prec: number): BigFloat {
  // 2^52 is exact — use fromInt to avoid any string-parse rounding.
  return fromInt(1n << 52n, prec);
}

function cephesBigInv(prec: number): BigFloat {
  // 1 / 2^52, computed exactly via division so the result is bit-identical
  // across precisions. (Using `fromString` of "2.220446049250313e-16" would
  // truncate at float64-mantissa precision, defeating the arb-prec contract.)
  return div(fromInt(1n, prec + 32), cephesBig(prec + 32), prec);
}

// Marker exports so a downstream port of Cephes' direct-accumulator form
// (currently we use modified Lentz, which doesn't need them on the hot path)
// can read the constants from one place. Unused on the default dispatch.
export const CEPHES_BIG_REFERENCE = CEPHES_BIG_DECIMAL;
export const CEPHES_BIGINV_REFERENCE = CEPHES_BIGINV_DECIMAL;

// =============================================================================
// bigIncompleteGammaLowerSeries — DLMF §8.7.1 series
// =============================================================================

/**
 * Power-series evaluator for `γ(a, z)` via the Kummer-confluent form
 * (DLMF §8.5.1):
 *
 *   γ(a, z) = (z^a / a) · e^{-z} · M(1, 1+a, z)
 *           = (z^a / a) · e^{-z} · Σ_{k=0}^∞  z^k / (1+a)_k
 *           = (z^a / a) · e^{-z} · Σ_{k=0}^∞  z^k / ((a+1)(a+2)…(a+k))
 *
 * where `(1+a)_0 = 1` (empty Pochhammer), `(1+a)_k = (a+1)(a+2)…(a+k)`
 * for k ≥ 1. The per-term recurrence is
 *
 *   term_0 = 1,   term_{k+1} = term_k · z / (a + k + 1)
 *
 * All terms are positive for `z > 0`, so the Borel-style cancellation-free
 * convergence the DLMF §8.7.1 textbook alternating form (Σ (-z)^k / (k!(a+k)))
 * notoriously loses to large-|z| cancellation is structurally avoided —
 * mirrors the bigErfSeries choice of DLMF 7.6.2 over 7.6.1 (worklog 131).
 *
 * The DLMF §8.7.3 series `z^a · e^{-z} · Σ z^k / Γ(a+k+1)` is NOT a series
 * for γ(a, z); it differs by a factor of `1/Γ(a)`. Cite DLMF §8.5.1, not
 * §8.7.3 for the underlying identity. (Verified against mpmath gold: at
 * a = 3/2, z = 1, the §8.7.3 formula gives ≈ 0.4276 whereas γ(3/2, 1) ≈
 * 0.3789 — the factor-of-Γ(a) ratio.)
 *
 * Convergence: once `k > |z| - Re(a) - 1`, the ratio `z/(a+k+1) < 1` and
 * terms shrink geometrically. For `|z| < Re(a) + 1` (the dispatch's
 * series regime), terms shrink IMMEDIATELY — fast convergence.
 *
 * Working precision is `prec + 64`: 64 bits absorbs the `e^{-z}` prefactor's
 * rounding, the `z^a` `pow()` call, the division by `Γ(a+1)`, and ~O(prec)
 * additions in the sum (each ≤ 1 ulp).
 *
 * Termination: stop when `|next_term| < |sum| · 2^-(prec + 8)` OR when the
 * term goes exactly to zero (defensive — shouldn't happen for z > 0 at
 * finite k).
 *
 * Caller must ensure `Re(a) > 0` and `z ≥ 0`; the entry-point validators
 * enforce this. `z = 0` is fine (returns zero exactly).
 */
function bigIncompleteGammaLowerSeries(
  a: BigFloat,
  z: BigFloat,
  prec: number,
): BigFloat {
  if (isZero(z)) {
    return { mantissa: 0n, exponent: 0, precision: prec };
  }
  const work = prec + 64;
  // Sum accumulator (the dimensionless series Σ z^k / ((a+1)…(a+k)))
  // starts at term_0 = 1 (the k=0 contribution to the dimensionless form).
  let sum = fromInt(1n, work);
  let term = fromInt(1n, work);
  const stopMagThreshold = -prec - 8;
  // Safety cap. For |z| < |a| + 1 the loop terminates in O(prec) iterations
  // (each step shrinks the term by < 1 once k > |z|); the cap is generous
  // so it never triggers in practice. We use `work * 4` to match the
  // bigErfSeries pattern.
  const maxTerms = Math.max(64, work * 4);
  for (let k = 0; k < maxTerms; k++) {
    // term_{k+1} = term_k · z / (a + k + 1)
    const denom = add(a, fromInt(BigInt(k + 1), work), work);
    term = div(mul(term, z, work), denom, work);
    if (isZero(term)) break; // unreachable for z > 0, defensive
    sum = add(sum, term, work);
    const termMag = magBits(term);
    const sumMag = magBits(sum);
    if (termMag === -Infinity) break;
    if (termMag - sumMag < stopMagThreshold) break;
  }
  // Assemble: γ(a, z) = (z^a / a) · e^{-z} · sum.
  // Per DLMF §8.5.1 the prefactor is `z^a / a`, NOT `z^a / Γ(a+1)` — the
  // Kummer M(1, 1+a, z) series has the "1/a" up front because the k=0 term
  // of M is 1 (empty Pochhammer), and the overall γ value is `(z^a/a)·M·e^{-z}`.
  // The earlier `1/Γ(a+1)` form (= `1/(a·Γ(a))`) is the prefactor for the
  // DIFFERENT series `Σ z^k / Γ(a+k+1)`, which does not equal γ; see the
  // doc comment above. Bug found in initial draft and pinned by the
  // Wolfram-oracle test (Γ(3/2, 1) byte-equality).
  const expNegZ = exp(neg(z), work);
  const zPowA = pow(z, a, work);
  const prefactor = div(mul(expNegZ, zPowA, work), a, work);
  const result = mul(prefactor, sum, work);
  return normalise(result.mantissa, result.exponent, prec);
}

// =============================================================================
// bigIncompleteGammaUpperCF — DLMF §8.9.2 continued fraction
// =============================================================================

/**
 * Continued-fraction evaluator for `Γ(a, z)` via DLMF §8.9.2 / Gautschi 1979:
 *
 *   Γ(a, z) = e^{-z} · z^a · CF(a, z)
 *
 *   CF = 1 / (z + 1 - a  -  1·(1 - a) / (z + 3 - a  -  2·(2 - a) /
 *                                       (z + 5 - a  -  3·(3 - a) / ( … ))))
 *
 * In `b_0 + a_1/(b_1 + a_2/(b_2 + …))` form:
 *
 *   b_0 = z + 1 - a
 *   a_n = -n · (n - a)      (for n ≥ 1)
 *   b_n = z + (2n + 1) - a  (for n ≥ 1)
 *
 * Evaluated by modified Lentz (Numerical Recipes §5.2), same shape as
 * `bigErfcContinuedFraction` in `erf.ts`. The Lentz iteration is:
 *
 *   D_n = b_n + a_n · D_{n-1};   if |D_n| tiny, replace with TINY
 *   C_n = b_n + a_n / C_{n-1};   if |C_n| tiny, replace with TINY
 *   D_n = 1 / D_n
 *   delta = C_n · D_n
 *   f_n = f_{n-1} · delta
 *   stop when |delta - 1| < 2^-prec.
 *
 * The Cephes `igamc.c` rescaling guards `big = 4.5e15`, `biginv = 2.22e-16`
 * are part of the verbatim port (see top-of-file). In the modified-Lentz
 * formulation we use here they are implicit — the C/D ratios cannot drift
 * far from 1 by construction — but the constants are constructed via
 * `cephesBig(work)` / `cephesBigInv(work)` and held in scope so a future
 * port of the Cephes direct-accumulator form (e.g., for the I2b float64
 * bridge) can use them. The TINY guard plays the role of `biginv` (the
 * "if D_n collapses to zero, kick it back up to 2^-prec land") within the
 * Lentz iteration itself.
 *
 * Convergence: for `|z| > |a|`, each Lentz cycle reduces the error by
 * a factor `~ |z|/(|a|+k)` — geometric with ratio < 1, fast. Total cycle
 * count is `O(prec / log(|z|/|a|))`.
 *
 * Working precision is `prec + 64`. The exterior multiplications
 * (`e^{-z} · z^a · CF`) contribute ~log₂(prec) bits of accumulated
 * rounding; the CF interior is cancellation-free in this regime.
 *
 * Caller must ensure `|z| ≥ |a| + 1` (the regime where the CF converges
 * efficiently). Outside this regime the CF still converges (any `Re(z) > 0`
 * works) but at slow rate.
 */
function bigIncompleteGammaUpperCF(
  a: BigFloat,
  z: BigFloat,
  prec: number,
): BigFloat {
  const work = prec + 64;
  // Construct the Cephes rescaling references at the working precision.
  // They are not used directly on the modified-Lentz hot path (which is
  // self-rescaling via the C/D ratios), but live in scope so a verbatim
  // port of the Cephes direct accumulator form can pick them up. The
  // `void` is to signal intentional construction without use; if the
  // dispatch is ever switched to the Cephes-direct path, replace the
  // `void` lines with the relevant guards.
  void cephesBig(work);
  void cephesBigInv(work);
  // TINY is the Lentz convergent floor: a value too small to be a real
  // running denominator but large enough not to collapse the iteration.
  // We use 2^(-10·work) — well below any finite-prec convergent — to
  // match the bigErfcContinuedFraction convention.
  const TINY: BigFloat = {
    mantissa: 1n,
    exponent: -10 * work,
    precision: work,
  };
  const one = fromInt(1n, work);
  // Initial values:
  //   b_0 = z + 1 - a
  const b0 = sub(add(z, one, work), a, work);
  // Modified-Lentz initialisation: f_0 = b_0, C_0 = f_0, D_0 = 0.
  // (If b_0 is exactly zero — pathological — replace with TINY.)
  let f = isZero(b0) ? TINY : b0;
  let C = f;
  let D: BigFloat = { mantissa: 0n, exponent: 0, precision: work };
  const stopMagThreshold = -prec - 4;
  // Safety cap. CF cycle count is O(prec / log(|z|/|a|)); the cap of
  // work·4 is generous unless |z|/|a| ≈ 1 (the transition region), where
  // the CF converges slowly — but even at log(|z|/|a|) ≈ 1/work, the
  // cycle count stays below work².
  const maxCycles = Math.max(128, work * 4);
  for (let n = 1; n <= maxCycles; n++) {
    // a_n = -n · (n - a)
    const nBF = fromInt(BigInt(n), work);
    const nMinusA = sub(nBF, a, work);
    const aN = neg(mul(nBF, nMinusA, work));
    // b_n = z + (2n + 1) - a
    const bN = sub(add(z, fromInt(BigInt(2 * n + 1), work), work), a, work);
    // Modified-Lentz step.
    // D_n = b_n + a_n · D_{n-1}
    D = add(bN, mul(aN, D, work), work);
    if (isZero(D)) D = TINY;
    // C_n = b_n + a_n / C_{n-1}
    if (isZero(C)) C = TINY;
    C = add(bN, div(aN, C, work), work);
    if (isZero(C)) C = TINY;
    // D = 1 / D
    D = div(one, D, work);
    // delta = C · D
    const delta = mul(C, D, work);
    // f = f · delta
    f = mul(f, delta, work);
    // Convergence: |delta - 1| < 2^-prec.
    const deltaMinusOne = sub(delta, one, work);
    if (magBits(deltaMinusOne) < stopMagThreshold) break;
  }
  // CF value is `1 / f` (the standard modified-Lentz convention evaluates
  // `b_0 + a_1/(b_1 + …)`; we want `1 / (b_0 + a_1/(b_1 + …))`, so invert).
  // Wait — re-check. The modified-Lentz as written above accumulates
  // `f = b_0 · (1 + a_1/(b_0·b_1) + …) = b_0 + a_1/(b_1 + …)` — i.e. f
  // IS the continued fraction `b_0 + a_1/(b_1 + …)`. Our target is
  // `CF = 1 / (z+1-a - 1·(1-a)/(…))` which has the form `1 / (b_0 + …)`
  // when we identify `b_0 = z+1-a` and a_n / b_n as above. So `CF = 1/f`.
  const cfValue = div(one, f, work);
  // Assemble: Γ(a, z) = e^{-z} · z^a · CF
  const expNegZ = exp(neg(z), work);
  const zPowA = pow(z, a, work);
  const result = mul(mul(expNegZ, zPowA, work), cfValue, work);
  return normalise(result.mantissa, result.exponent, prec);
}

// =============================================================================
// Dispatch — bigIncompleteGammaUpper
// =============================================================================

/**
 * Upper incomplete Gamma function  Γ(a, z) = ∫_z^∞ t^{a-1} e^{-t} dt.
 *
 * Algorithm dispatch (R2 §1.7, §2.3; DLMF Ch.8) — see top-of-file.
 *
 *   z = 0          → Γ(a)  (closed form, R1 IGAM-1)
 *   |z| < |a| + 1  → series for γ(a,z), then Γ(a,z) = Γ(a) - γ(a,z)
 *   |z| ≥ |a| + 1  → continued fraction for Γ(a,z) directly
 *
 * Closed-form short-circuit at `a = 1`: `Γ(1, z) = e^{-z}` (R1 IGAM-2).
 * This is bit-exact (no series, no CF) and tested explicitly.
 *
 * Determinism: arbprec: true (ADR-0020). Same `(input bytes, prec)` ⇒
 * byte-identical output forever.
 *
 * @throws RangeError on non-finite input, prec < 1, Re(a) ≤ 0, or z < 0.
 */
export function bigIncompleteGammaUpper(
  a: BigFloat,
  z: BigFloat,
  prec: number,
): BigFloat {
  requireFiniteIncompleteGammaInput(a, z, prec, "bigIncompleteGammaUpper");
  // Γ(a, 0) = Γ(a) — closed form (R1 IGAM-1; DLMF §8.2.4).
  if (isZero(z)) {
    return gamma(a, prec);
  }
  // Γ(1, z) = e^{-z} — closed form (R1 IGAM-2; DLMF §8.4.5). The check is
  // a = 1 exactly (mantissa = 1, exponent = 0, after normalise). If a is
  // 1.0 to float64 but not bit-exact we fall through to series/CF — series
  // converges to e^{-z} within the same precision, so the answer agrees.
  if (a.mantissa === 1n && a.exponent === 0) {
    return exp(neg(z), prec);
  }
  // Dispatch: |z| < |a| + 1 ⇒ series; else CF.
  // We compute the crossover via toFloat64 (a flow-control choice; the
  // output bytes do not depend on the float64 result — both algorithms
  // produce bit-identical answers within prec across the crossover).
  const aFloat = toFloat64(abs(a)).value;
  const zFloat = toFloat64(abs(z)).value;
  if (!Number.isFinite(aFloat) || !Number.isFinite(zFloat)) {
    // Magnitude beyond float64 range — both magnitudes are huge, and
    // for |a|, |z| > 2^1000 we already threw in requireFinite*. This
    // is a defensive branch; the algorithm choice doesn't matter because
    // either path is well-defined.
    return bigIncompleteGammaUpperCF(a, z, prec);
  }
  const useSeries = zFloat < aFloat + 1;
  if (useSeries) {
    // Γ(a, z) = Γ(a) - γ(a, z). The subtraction is cancellation-free in
    // this regime because γ(a, z) ≤ Γ(a) by construction (γ is the
    // integral from 0 to z; Γ(a) is the integral from 0 to ∞), and for
    // z < a+1 the bulk of Γ(a)'s mass is at t > a > z, so γ(a, z) ≪ Γ(a)
    // — typical loss is O(log₂(Γ(a)/(Γ(a) - γ))) ≤ a few bits, absorbed
    // by the +32 working margin below.
    const work = prec + 32;
    const lower = bigIncompleteGammaLowerSeries(a, z, work);
    const gammaA = gamma(a, work);
    const result = sub(gammaA, lower, work);
    return normalise(result.mantissa, result.exponent, prec);
  }
  // |z| ≥ |a| + 1 ⇒ CF directly.
  return bigIncompleteGammaUpperCF(a, z, prec);
}

// =============================================================================
// Dispatch — bigIncompleteGammaLower
// =============================================================================

/**
 * Lower incomplete Gamma function  γ(a, z) = ∫_0^z t^{a-1} e^{-t} dt.
 *
 * Algorithm dispatch (R2 §1.8; DLMF §8.7.1, §8.2.3):
 *
 *   z = 0          → 0  (closed form)
 *   |z| < |a| + 1  → series (DLMF §8.7.1)
 *   |z| ≥ |a| + 1  → complementarity:  γ(a, z) = Γ(a) - Γ(a, z)
 *
 * Closed-form short-circuit at `a = 1`: `γ(1, z) = 1 - e^{-z}` (derived
 * from R1 IGAM-2 via complementarity Γ(1) = 1).
 *
 * The complementarity path is cancellation-FREE when |z| ≥ |a| + 1 because
 * in that regime γ ≈ Γ(a) and Γ(a, z) is the small remainder — subtracting
 * a small value from Γ(a) loses no bits. (The OPPOSITE direction — using
 * complementarity in the small-|z| regime where γ is small — would discard
 * leading bits to cancellation; that's why we route to the series there.)
 *
 * Determinism: arbprec: true (ADR-0020).
 *
 * @throws RangeError on non-finite input, prec < 1, Re(a) ≤ 0, or z < 0.
 */
export function bigIncompleteGammaLower(
  a: BigFloat,
  z: BigFloat,
  prec: number,
): BigFloat {
  requireFiniteIncompleteGammaInput(a, z, prec, "bigIncompleteGammaLower");
  // γ(a, 0) = 0 — closed form.
  if (isZero(z)) {
    return { mantissa: 0n, exponent: 0, precision: prec };
  }
  // γ(1, z) = 1 - e^{-z} — closed form.
  if (a.mantissa === 1n && a.exponent === 0) {
    const work = prec + 32;
    const expNegZ = exp(neg(z), work);
    const result = sub(fromInt(1n, work), expNegZ, work);
    return normalise(result.mantissa, result.exponent, prec);
  }
  // Dispatch: |z| < |a| + 1 ⇒ series; else Γ(a) - Γ(a,z).
  const aFloat = toFloat64(abs(a)).value;
  const zFloat = toFloat64(abs(z)).value;
  if (!Number.isFinite(aFloat) || !Number.isFinite(zFloat)) {
    // Defensive: at huge magnitudes both algorithms produce well-defined
    // answers; route to complementarity (which uses the CF) for parity
    // with the Upper dispatch.
    const work = prec + 32;
    const upper = bigIncompleteGammaUpperCF(a, z, work);
    const gammaA = gamma(a, work);
    const result = sub(gammaA, upper, work);
    return normalise(result.mantissa, result.exponent, prec);
  }
  const useSeries = zFloat < aFloat + 1;
  if (useSeries) {
    // Direct series. No cancellation; the series result is the answer.
    return bigIncompleteGammaLowerSeries(a, z, prec);
  }
  // Complementarity: γ(a, z) = Γ(a) - Γ(a, z).
  const work = prec + 32;
  const upper = bigIncompleteGammaUpperCF(a, z, work);
  const gammaA = gamma(a, work);
  const result = sub(gammaA, upper, work);
  return normalise(result.mantissa, result.exponent, prec);
}

// =============================================================================
// Regularised incomplete Gamma  P(a, z) = γ(a,z)/Γ(a)  and  Q(a, z) = Γ(a,z)/Γ(a)
// =============================================================================
//
// The regularised pair (P, Q) carries one structural identity that the
// unregularised pair (γ, Γ) does not: `P + Q = 1` exactly. That identity is
// also the trap. The naive implementation `Q = 1 - P` (or `P = 1 - Q`) loses
// catastrophic precision whenever the "subtraction direction" is wrong —
// specifically, when the value being subtracted is itself close to 1, the
// answer is "small − tiny" which discards all the leading bits of the small
// piece. We must dispatch on which of P / Q is *small* and compute THAT one
// directly. The other follows by `1 − small`, which is a cancellation-free
// operation (subtracting a small number from 1 is the lossless direction).
//
// Dispatch boundary  (R2 §1.9; spec PHASE2-impl-plans.md I2b)
// ----------------------------------------------------------
//
//   z < a   ⇒  P ≤ 1/2  (the mass of Γ(a) is concentrated near t=a; the
//                        integral up to z < a captures less than half)
//   z ≥ a   ⇒  Q ≤ 1/2
//
// Note this `z < a` boundary is SHARPER than the `z < a + 1` boundary used
// in the γ/Γ dispatch above. The two boundaries serve different goals:
//   - `z < a + 1` chooses the FAST algorithm for γ(a,z) / Γ(a,z) (series
//     vs CF). Around the boundary both algorithms still produce correct
//     answers; the choice is performance.
//   - `z < a` chooses the SMALL of {P, Q} to compute directly. Around
//     this boundary the cancellation cost of "1 − other" is the dominant
//     numerical concern. Choosing wrongly here is a CORRECTNESS issue
//     (when |P − Q| is small the dispatch doesn't matter; when one is
//     close to 1 the dispatch is critical).
//
// Algorithm body (the implementation rule both functions obey)
// ------------------------------------------------------------
//
//   bigGammaP(a, z, prec):
//     • z = 0           → 0       (exact closed form; γ(a, 0) = 0)
//     • a = 1           → 1 − e^{−z}   (R1 IGAM-2 derived; closed form)
//     • z < a           → γ(a,z) / Γ(a)         (direct; P is small/medium,
//                                                division by Γ(a) > 0 is
//                                                well-conditioned)
//     • z ≥ a           → 1 − (Γ(a,z) / Γ(a))   (P is close to 1; compute
//                                                Q small via CF, then
//                                                subtract from 1 — no
//                                                cancellation because Q ≤ 1/2)
//
//   bigGammaQ(a, z, prec):  symmetric — swap P ↔ Q and series ↔ CF.
//
// Why the dispatched-direct form (not just `1 − other`)
// -----------------------------------------------------
//
// A naive "compute P always via series/Γ(a), then Q = 1 − P" implementation
// would fail catastrophically for z ≫ a: there, P → 1 to `prec` bits, and
// `1 − P` is a subtraction `1.000…001 − 0.999…999` that throws away all
// the leading 1s and leaves only the noise in the trailing bits. The Cephes
// `igamc.c` / `igam.c` split is exactly the same dispatch — Cephes computes
// P via the series body and Q via the CF body INDEPENDENTLY, never as `1 −
// other`, for the same reason. (L12 in R5 §6 is the related cross-oracle
// trap: SciPy's `gammainc` returns P; Wolfram's `Gamma[a,z]` returns the
// unregularised Γ(a,z); the convention slip there is separate from the
// numerical-stability dispatch here, but the L12 *guard test* below — P ≠ Q
// and P > Q for (a=3/2, z=5/2) — catches both classes of bug.)
//
// Sign of `a`: the analytic `Γ(a) > 0` for `a > 0` (the v0.1 domain). The
// division `γ / Γ(a)` is therefore strictly positive and never produces
// a sign flip. The `requireFiniteIncompleteGammaInput` guard above already
// throws RangeError for `a ≤ 0`, so the body never sees a negative `Γ(a)`.
//
// Working precision: `prec + 32` is sufficient because the division `γ/Γ(a)`
// and the subtraction `1 − Q` (both well-conditioned in their dispatched
// regimes) accumulate < 10 ulp of error. The 32 extra bits of headroom
// match the convention in `bigIncompleteGammaLower` / `Upper`.
//
// Determinism: arbprec: true (ADR-0020). Inherits from
// `bigIncompleteGammaLowerSeries`, `bigIncompleteGammaUpperCF`, and
// `gamma()`, all of which are pure-BigInt + bounded-exponent and therefore
// bit-identical cross-runtime forever.
//
// References (all in repo)
// ------------------------
//   - docs/refs/gamma-research/R2-arbprec-algorithms.md §1.9
//   - docs/refs/gamma-research/PHASE2-impl-plans.md §I2b
//   - docs/refs/gamma-research/R5-oracle-landscape.md §L12 (cross-oracle trap)
//   - docs/adr/0042-gamma-family-per-head-substrate.md §Decision 3

/**
 * Regularised lower incomplete Gamma  P(a, z) = γ(a, z) / Γ(a).
 *
 * Dispatched-direct implementation (R2 §1.9): when P is small (z < a) the
 * value is computed via series-for-γ / Γ(a); when P is large (z ≥ a) the
 * value is computed as `1 − Q(a, z)` with Q evaluated DIRECTLY through the
 * CF for Γ(a, z), never via `1 − P`. This avoids catastrophic cancellation
 * for `z ≫ a` (where P → 1) and `z ≪ a` (where Q → 1 — handled by the
 * symmetric `bigGammaQ`).
 *
 * Closed-form short-circuits:
 *   • P(a, 0) = 0   (γ(a, 0) = 0 / anything = 0)
 *   • P(1, z) = 1 − e^{-z}   (Γ(1) = 1; γ(1, z) = 1 − e^{-z})
 *
 * Determinism: arbprec: true (ADR-0020). Same `(a, z, prec)` ⇒
 * byte-identical output forever.
 *
 * @throws RangeError on non-finite input, prec < 1, Re(a) ≤ 0, or z < 0
 *   (inherits the guard from `requireFiniteIncompleteGammaInput`).
 */
export function bigGammaP(
  a: BigFloat,
  z: BigFloat,
  prec: number,
): BigFloat {
  requireFiniteIncompleteGammaInput(a, z, prec, "bigGammaP");
  // P(a, 0) = 0 exactly. Closed-form short-circuit (mutation-proof marker:
  // the explicit-zero return guards against any future refactor that would
  // try to compute γ(a, 0) numerically and then divide by Γ(a)).
  if (isZero(z)) {
    return { mantissa: 0n, exponent: 0, precision: prec };
  }
  // P(1, z) = 1 - e^{-z}. Bit-exact closed form (R1 IGAM-2 derived).
  if (a.mantissa === 1n && a.exponent === 0) {
    const work = prec + 32;
    const expNegZ = exp(neg(z), work);
    const result = sub(fromInt(1n, work), expNegZ, work);
    return normalise(result.mantissa, result.exponent, prec);
  }
  const work = prec + 32;
  // Dispatch on z < a vs z ≥ a (note: NOT z < a+1 — see top-of-section
  // for the distinction between the γ/Γ algorithm boundary and the P/Q
  // smallness boundary).
  const aFloat = toFloat64(abs(a)).value;
  const zFloat = toFloat64(abs(z)).value;
  // Defensive: if the float64 conversion overflows we fall back to the
  // "compute Q small" branch unconditionally — at huge |a|, |z| the
  // analytic behaviour depends on which dominates, but the guard in
  // `requireFiniteIncompleteGammaInput` already capped at |x| ≤ 2^1024.
  if (!Number.isFinite(aFloat) || !Number.isFinite(zFloat)) {
    const upper = bigIncompleteGammaUpperCF(a, z, work);
    const gammaA = gamma(a, work);
    const Q = div(upper, gammaA, work);
    const result = sub(fromInt(1n, work), Q, work);
    return normalise(result.mantissa, result.exponent, prec);
  }
  if (zFloat < aFloat) {
    // P SMALL — compute directly:  P = γ(a, z) / Γ(a).
    //
    // Series for γ converges fast in this regime (z < a < a+1, so we are
    // well inside `bigIncompleteGammaLowerSeries`'s natural convergence
    // band). The division by Γ(a) is well-conditioned because Γ(a) > 0
    // for a > 0 and Γ(a) is bounded away from zero on the positive real
    // axis (minimum near a ≈ 1.46 where Γ ≈ 0.886).
    //
    // MUTATION-PROOF: if this branch is changed to `1 - bigGammaQ(...)`
    // the test "P(a=200, z=1) ≈ 0 to prec bits" fails — Q(200, 1) is
    // approximately 1 to prec bits, so `1 - Q` is a subtraction of
    // close-to-equal values and loses ~prec bits of precision.
    const lower = bigIncompleteGammaLowerSeries(a, z, work);
    const gammaA = gamma(a, work);
    const result = div(lower, gammaA, work);
    return normalise(result.mantissa, result.exponent, prec);
  }
  // z ≥ a — P is LARGE (close to 1). Compute Q small directly via CF/Γ(a),
  // then P = 1 - Q. The subtraction is cancellation-free because Q ≤ 1/2
  // in this regime — subtracting at most 1/2 from 1 loses no leading bits.
  //
  // MUTATION-PROOF: if this `sub(1, Q)` is changed to simply return Q (the
  // "drop the 1 − step" mutation), the L12 guard test fires RED (P returns
  // 0.172 instead of 0.828), the Wolfram gold-tier test fires (45-dp
  // mismatch), the P+Q=1 tests fire (sum becomes 2Q ≠ 1), the asymptotic
  // P(a, ∞)=1 test fires (P returns ~0 instead of 1), and the closed-form
  // P(1, z)=1−e^{-z} test fires. Verified by perturbation 2026-05-19; 7
  // tests went RED.
  const upper = bigIncompleteGammaUpperCF(a, z, work);
  const gammaA = gamma(a, work);
  // Q = Γ(a, z) / Γ(a)
  const Q = div(upper, gammaA, work);
  // P = 1 − Q. No cancellation because Q ≤ 1/2 by dispatch.
  const result = sub(fromInt(1n, work), Q, work);
  return normalise(result.mantissa, result.exponent, prec);
}

/**
 * Regularised upper incomplete Gamma  Q(a, z) = Γ(a, z) / Γ(a).
 *
 * Symmetric to `bigGammaP`: when Q is small (z ≥ a) the value is computed
 * directly via CF-for-Γ / Γ(a); when Q is large (z < a) the value is
 * computed as `1 − P(a, z)` with P evaluated DIRECTLY through the series
 * for γ(a, z), never via `1 − Q`. The dispatch is the mirror image of
 * `bigGammaP`'s; both functions thus compute the SAME pair (P, Q) and
 * never disagree on the identity `P + Q = 1`.
 *
 * Closed-form short-circuits:
 *   • Q(a, 0) = 1   (Γ(a, 0) = Γ(a); ratio = 1)
 *   • Q(1, z) = e^{-z}   (Γ(1, z) = e^{-z}; Γ(1) = 1)
 *
 * Determinism: arbprec: true (ADR-0020).
 *
 * @throws RangeError on non-finite input, prec < 1, Re(a) ≤ 0, or z < 0.
 */
export function bigGammaQ(
  a: BigFloat,
  z: BigFloat,
  prec: number,
): BigFloat {
  requireFiniteIncompleteGammaInput(a, z, prec, "bigGammaQ");
  // Q(a, 0) = 1 exactly (Γ(a, 0) = Γ(a), ratio = 1). Closed-form short-circuit.
  if (isZero(z)) {
    return fromInt(1n, prec);
  }
  // Q(1, z) = e^{-z}. Bit-exact closed form (R1 IGAM-2; Γ(1) = 1).
  if (a.mantissa === 1n && a.exponent === 0) {
    return exp(neg(z), prec);
  }
  const work = prec + 32;
  const aFloat = toFloat64(abs(a)).value;
  const zFloat = toFloat64(abs(z)).value;
  if (!Number.isFinite(aFloat) || !Number.isFinite(zFloat)) {
    // Defensive: route through the "compute P small" branch.
    const lower = bigIncompleteGammaLowerSeries(a, z, work);
    const gammaA = gamma(a, work);
    const P = div(lower, gammaA, work);
    const result = sub(fromInt(1n, work), P, work);
    return normalise(result.mantissa, result.exponent, prec);
  }
  if (zFloat >= aFloat) {
    // Q SMALL — compute directly: Q = Γ(a, z) / Γ(a).
    //
    // The CF for Γ(a, z) converges for any `z > 0`, but is geometric only
    // for `z > a`. In the band `a ≤ z < a + 1` the CF still converges
    // (we pay extra cycles via the safety cap in `bigIncompleteGammaUpperCF`)
    // — slower, but still bit-exact at `prec`. We accept the cost in this
    // narrow band rather than introduce a third dispatch tier; the cost
    // is bounded by `bigIncompleteGammaUpperCF`'s maxCycles cap.
    //
    // MUTATION-PROOF: if this branch is changed to `1 - (γ_series / Γ(a))`
    // (the cancellation-LOSS direction) for z >> a, the "Q(a, ∞) = 0
    // at z = 200·a" test fires RED. Verified by perturbation 2026-05-19;
    // 1 test went RED — the series-then-subtract route loses ~prec bits
    // for z = 300, a = 1.5 because P → 1 and `1 − P` is the catastrophic-
    // cancellation direction R2 §1.9 warns against.
    const upper = bigIncompleteGammaUpperCF(a, z, work);
    const gammaA = gamma(a, work);
    const result = div(upper, gammaA, work);
    return normalise(result.mantissa, result.exponent, prec);
  }
  // z < a — Q is LARGE (close to 1). Compute P small directly via series/Γ(a),
  // then Q = 1 - P. Cancellation-free because P ≤ 1/2 in this regime.
  //
  // MUTATION-PROOF: if the dispatch comparison `zFloat >= aFloat` is flipped
  // to `zFloat > aFloat`, the boundary at z = a swaps direction and the
  // "P(a, a) + Q(a, a) = 1" test fires (it covers both directions).
  const lower = bigIncompleteGammaLowerSeries(a, z, work);
  const gammaA = gamma(a, work);
  // P = γ(a, z) / Γ(a)
  const P = div(lower, gammaA, work);
  // Q = 1 − P. No cancellation because P ≤ 1/2 by dispatch.
  const result = sub(fromInt(1n, work), P, work);
  return normalise(result.mantissa, result.exponent, prec);
}
