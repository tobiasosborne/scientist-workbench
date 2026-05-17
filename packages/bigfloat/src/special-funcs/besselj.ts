// =============================================================================
// @workbench/bigfloat — Bessel function of the first kind `J_ν(z)` (arb-prec)
// =============================================================================
//
// This module ships the arb-prec real-axis entry point for the Bessel
// J family:
//
//   bigBesselJ(nu, z, prec)            — real ν, real z; the user-visible entry
//
// plus the three substrate primitives the entry point dispatches over
// (paralleling `bigErfSeries` / `bigErfcAsymptotic` /
// `bigErfcContinuedFraction` in the sister `erf.ts`):
//
//   bigBesselJSeriesMaclaurin          — DLMF 10.2.2 ₀F₁ Maclaurin (direct)
//   bigBesselJHankelAsymptotic         — DLMF 10.17.5-6 Hankel asymptotic
//                                        (divergent, smallest-term truncation
//                                         per Olver 1974 §3 / DLMF 10.17.13-14)
//   bigBesselJSeriesCancellationRetry  — Maclaurin with measured cancellation
//                                        loss → precision bump → recompute
//                                        (FLINT bessel_j.c:480-595 pattern)
//
// ADR-0041 §"Decision 3" pins the per-head signature and the algorithm
// dispatch; ADR-0020 pins the determinism contract this substrate must
// honour (bit-identical across runtimes forever, given fixed `prec` bits).
//
// FLINT-aligned three-piece dispatch (the load-bearing R2 finding)
// ----------------------------------------------------------------
//
// R2 §3.1 + FLINT `acb_hypgeom/bessel_j.c:579-595` pin the dispatch:
//
//   z = 0:                    closed form (1 if ν=0, 0 if ν>0)
//   |z| < min(8, 2|z| < p):   ₀F₁ Maclaurin direct.  Cheap, no
//                             cancellation problem when |z| is small
//                             relative to the leading-term magnitude.
//   |z| > z_c_Hankel(p):      Hankel asymptotic with smallest-term
//                             truncation.  z_c_Hankel(p) := p / 2.
//                             The factor-2 conservative margin is FLINT's
//                             (`bessel_j.c:592` comment "We are a bit more
//                             conservative and use the factor 2").
//   transition (in between):  ₀F₁ Maclaurin with cancellation-driven
//                             precision retry: measure
//                             `lossBits = magBits(peakTerm) - magBits(sum)`
//                             after a first-pass, bump
//                             `work = prec + 32 + lossBits`, recompute.
//   ν > z²/4 short-circuit:   FLINT comment "If nu > |z|²/4, no significant
//                             cancellation in 0F1" — skip the retry path,
//                             route straight to plain Maclaurin even when
//                             z is in the cancellation band.
//
// `z_c_Hankel(p)` is LINEAR in precision — fundamentally different from
// Erf's `x_c(p) = √(p · ln 2)`.  Bessel's Hankel terms shrink only as
// `1/(8|z|)` per step (Erf's Borel terms shrank as `1/(2z²)`); the
// crossover where the smallest term of the divergent asymptotic falls
// below `2^-prec` is therefore at `|z| ≈ p · ln 2 / 2 ≈ 0.347 p`, not
// `√(p · ln 2)`.  At p = 200 bits (≈ 60 dps), `z_c_Hankel ≈ 70` (vs
// `x_c_Erf ≈ 11.8`).  Bessel needs an order of magnitude larger |z| to
// enter the asymptotic regime.  This is the structural reason the
// transition band exists and matters.
//
// Cancellation in the alternating Maclaurin (R2 §2.1 + FLINT `:480`)
// -------------------------------------------------------------------
//
// `J_ν(z) = Σ_{k=0}^∞ (-z²/4)^k / (k! · Γ(ν+k+1)) · (z/2)^ν`
//
// is alternating.  Terms peak at `k_peak ≈ |z|/2` with magnitude
// `~exp(|z|) / √(2π|z|)` (Stirling), while the *answer* `J_ν(z)` is
// `O(1/√z)` by the Hankel asymptotic.  The cancellation budget is
// therefore
//
//   cancellation_bits ≈ |z| · log₂ e − (1/2) log₂ |z|
//                     ≈ 1.44 |z| − 0.72 log₂ |z|
//
// — at z = 10, ~14 bits; at z = 50, ~70 bits; at z = 70, ~98 bits, which
// already eats a 96-bit working precision dry.  The cancellation-retry
// pattern (mirroring `clgammaReflect` worklog 117 bead `oj5j` and
// `bigErfc` Erf I1 worklog 131) measures the loss empirically rather than
// trying to bound it analytically — the empirical bound includes
// integration over the ν dimension, which the analytic bound conservatively
// over-estimates by 2-3× in practice.
//
// Why `(2/√(πz)) · (cos(ω) P − sin(ω) Q)` for the Hankel branch
// --------------------------------------------------------------
//
// The Hankel form (DLMF 10.17.5-6):
//
//   J_ν(z) ~ √(2/(πz)) · [cos(ω) · P_ν(z) − sin(ω) · Q_ν(z)]
//
// where `ω = z − νπ/2 − π/4`, and `P` and `Q` are even/odd asymptotic
// sums in `1/z`:
//
//   P_ν(z) = Σ_{k=0}^∞ (-1)^k · a_{2k}(ν) / z^{2k}
//   Q_ν(z) = Σ_{k=0}^∞ (-1)^k · a_{2k+1}(ν) / z^{2k+1}
//
// `a_k(ν) = (4ν² − 1)(4ν² − 9) · ··· · (4ν² − (2k−1)²) / (k! · 8^k)`,
// with the term ratio
//
//   a_{k+1}/a_k = (4ν² − (2k+1)²) / ((k+1) · 8)
//
// (DLMF 10.17.1).  This is the cleanest Bessel asymptotic — `P` and `Q`
// are each O(1) sums, `cos(ω)` and `sin(ω)` are O(1), the prefactor
// `√(2/(πz))` is O(1/√z); no internal cancellation in the asymptotic
// itself.  The only cancellation surface is near a *zero of J_ν*, where
// `cos(ω) P − sin(ω) Q ≈ 0` — but those zeros are by definition where
// the answer is near zero, so the relative error from cancellation there
// is bounded by the absolute error of either summand.  We accept this and
// document it as a known asymptotic-branch limitation; the corpus G8
// comparator uses absolute error inside the zero-crossing tolerance band
// (`|z - z_root| < 0.01`, ADR-0041 §Decision 12).
//
// The optimal-truncation idiom mirrors `lgammaStirling`
// (`packages/bigfloat/src/special.ts:117-160`) and the Erf asymptotic
// (`packages/bigfloat/src/special-funcs/erf.ts:bigErfcAsymptotic`):
// track the per-term magnitude; the moment `|term_{k+1}| > |term_k|`,
// the series has bottomed-out at its smallest term — stop and return
// the partial sum.  The Poincaré remainder bound (Olver 1974 Theorem 3.1)
// guarantees the error is bounded by twice the magnitude of the first
// omitted term, modulated by a slowly-growing `χ(m) ≈ √(πm/2)` factor
// that does not change the leading exponential behaviour.
//
// Cancellation-driven precision retry (the FLINT pattern)
// -------------------------------------------------------
//
// Mirrors `clgammaReflect` (bead `oj5j`, worklog 117), `bigErfc` Erf I1
// (worklog 131), and FLINT's own retry harness in
// `acb_hypgeom_bessel_j_powser` (`bessel_j.c:480-557`).  The reasoning:
// when the alternating Maclaurin's peak term magnitude exceeds the
// returned sum magnitude by `L` bits, exactly those `L` bits of the
// working precision were destroyed by cancellation.  We measure `L`
// post-hoc on a first-pass result at `work_0 = prec + 32 + cancelEst`
// bits (where `cancelEst ≈ |z| · log₂ e` is the analytic estimate that
// FLINT's `:585` uses to size the *initial* working precision), then if
// the *measured* loss exceeds the analytic estimate by more than
// `headroom` bits, we re-run at `work_1 = prec + 32 + L_measured + 16`.
//
// The retry terminates after at most one bump because the second pass's
// `L_measured` is bounded by the same analytic `cancelEst` plus a
// constant headroom (the analytic bound is the upper envelope on the
// cancellation; the empirical loss is below it modulo finite-precision
// rounding of the magnitude measurement itself, ~1 bit).
//
// References (all in repo)
// ------------------------
//   - docs/adr/0041-bessel-family-per-head-substrate.md §"Decision 3"
//   - docs/adr/0020-arbitrary-precision-tier.md
//   - docs/refs/besselj-research/R2-arbprec-algorithms.md §2.1, §2.2, §3.1
//   - docs/refs/besselj-research/sources/arbprec/bessel_j.c
//     (FLINT acb_hypgeom; lines 480-595 are the dispatch we port)
//   - packages/bigfloat/src/special-funcs/erf.ts (styling exemplar;
//     `bigErfcAsymptotic` is the smallest-term-truncation template)
//   - packages/bigfloat/src/special.ts (lgammaStirling at :117 is the
//     canonical workbench optimal-truncation idiom)
//   - DLMF §10.2 (defining series), §10.17 (Hankel asymptotic),
//     §10.41 (Debye — deferred per R2 v0.1 scope)

import { BigFloat, normalise, bitLength } from "../types.js";
import { abs, neg, sgn, isZero, eq } from "../comparison.js";
import { add, sub, mul, div, sqrt } from "../arithmetic.js";
import { fromInt, fromFloat64, toFloat64 } from "../conversion.js";
import { pi, sin, cos, pow } from "../transcendental.js";
import { gamma } from "../special.js";

// =============================================================================
// Helpers
// =============================================================================

/**
 * `log₂ |x|` to integer precision; returns `-Infinity` for `x = 0`.  Used
 * by cancellation-loss tracking and smallest-term truncation.  Local
 * copy of the same shape used in `erf.ts`, `special.ts`, and `complex.ts`.
 */
function magBits(x: BigFloat): number {
  if (x.mantissa === 0n) return -Infinity;
  const m = x.mantissa < 0n ? -x.mantissa : x.mantissa;
  return x.exponent + bitLength(m);
}

/**
 * Crossover threshold below which the Hankel asymptotic does not yet
 * deliver `prec` bits of accuracy.  Per R2 §1.3, derived from the
 * smallest-term magnitude `≈ e^(-2|z|)` of the optimally-truncated
 * asymptotic falling below `2^-prec`:
 *
 *   e^(-2|z|) < 2^-prec ⇒ |z| > prec · ln(2) / 2 ≈ 0.347 · prec
 *
 * FLINT uses the factor-2 conservative form `2|z| > prec` at
 * `bessel_j.c:592` ("We are a bit more conservative and use the factor
 * 2") — i.e. `|z| > prec / 2`.  We adopt the same FLINT-aligned form
 * so dispatch is byte-identical to the canonical reference at the
 * boundary.  The conservative `prec / 2` (vs the tight `0.347 · prec`)
 * adds a small constant-factor of extra series term count in the band
 * `0.347p < |z| < 0.5p`, never miscalibrates accuracy.
 *
 * `Math.LN2` is V8's `ln(2)` to ~16 dp; the imprecision is irrelevant
 * because (a) the threshold is used only as a branch selector, (b) both
 * branches produce mathematically identical answers to within 2^-prec
 * at and across the boundary, (c) the FLINT factor-2 conservative form
 * doesn't even *use* `Math.LN2` — it's a pure `prec/2` integer divide.
 * Bit-determinism is preserved.
 */
function crossoverZcHankel(prec: number): number {
  return prec / 2;
}

/**
 * Analytic cancellation estimate `|z| · log₂ e` bits — the leading-order
 * bound on bits destroyed by the alternating Maclaurin's peak-term /
 * answer ratio.  Mirrors FLINT `bessel_j.c:585` ("the cancellation
 * estimate `|z| · 1.4426`").  Used to size the *first-pass* working
 * precision; the retry uses the empirically-measured loss.
 */
function cancelBitsEstimate(absZFloat: number): number {
  if (!Number.isFinite(absZFloat)) return 0;
  return Math.max(0, Math.ceil(absZFloat * Math.LOG2E));
}

/**
 * Validate that a BigFloat input is finite-and-usable.  Throws
 * `RangeError` with a `suggestion:` line.  Mirrors the same validator
 * shape used in `erf.ts`.
 */
function requireFiniteBesselInput(x: BigFloat, fn: string, name: string): void {
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
    // The Bessel cliff is more generous than Erf's because J/Y are
    // O(1/√z) — they remain non-trivially computable to ~floor of any
    // reasonable BigFloat precision for any finite z.  We use the same
    // 2^1024 loud cliff for consistency; in practice this never trips
    // for any real-axis input that fits in a double.
    if (magnitudeBits > 1024) {
      throw new RangeError(
        `${fn}: ${name} magnitude ~ 2^${magnitudeBits} exceeds the supported ` +
          `Bessel-family input range (|${name}| > 2^1024). ` +
          `suggestion: at this magnitude, asymptotic forms converge so fast ` +
          `that the substrate's accounting becomes structural — use the ` +
          `Hankel form directly with a symbolic z.`,
      );
    }
  }
}

// =============================================================================
// bigBesselJSeriesMaclaurin — DLMF 10.2.2 ₀F₁ Maclaurin (direct)
// =============================================================================

/**
 * Power-series evaluator for `J_ν(z)` via the defining Maclaurin
 * (DLMF 10.2.2):
 *
 *   J_ν(z) = (z/2)^ν · Σ_{k=0}^∞ (-z²/4)^k / (k! · Γ(ν+k+1))
 *
 * Reformulated as a prefactored ₀F₁:
 *
 *   J_ν(z) = (z/2)^ν / Γ(ν+1) · ₀F₁(; ν+1; -z²/4)
 *          = prefactor · Σ_{k=0}^∞ T_k
 *   T_0    = 1
 *   T_{k+1}= T_k · (-z²/4) / (k+1) / (ν+k+1)
 *
 * Algorithm: walk the recurrence; sum; terminate when
 * `|T_{k+1}| < |sum| · 2^-(prec + 8)`.  The `+ 8` is a guard against
 * the final few terms contributing to the last bits of the rounded
 * answer.
 *
 * Convergence: terms peak at `k ≈ |z|/2` and shrink geometrically
 * thereafter with ratio `≈ (z/2k)²`.  Total term count for prec p ≈
 * `|z|/2 + p / log₂(2k/|z|) ≈ |z|/2 + p` at the asymptote.
 *
 * Cancellation: this is the *raw* Maclaurin — it carries the alternating
 * cancellation when `|z| > prec / log₂ e ≈ 0.69 · prec`.  Callers that
 * cannot bound `|z|` analytically must hoist on
 * `bigBesselJSeriesCancellationRetry` instead, which adds the
 * measure-loss-and-retry harness around this routine.
 *
 * Working precision is `prec + 32`: 32 bits absorbs the prefactor's
 * `pow` + `gamma` rounding, the `~p` cumulative additions, and the
 * final multiplications.  NO cancellation budget is allocated here —
 * if the caller wants cancellation safety, they call the retry wrapper.
 *
 * Special-case fast path: ν integer and ν > 0 ⇒ J_ν(0) = 0;
 *                         ν = 0           ⇒ J_0(0) = 1.
 * Handled inside `bigBesselJ` rather than here, because the prefactor
 * `(z/2)^ν` for non-integer ν at z = 0 is the multi-valued boundary
 * the caller must already have resolved.
 *
 * @throws RangeError on non-finite ν or z (via requireFiniteBesselInput).
 */
export function bigBesselJSeriesMaclaurin(
  nu: BigFloat,
  z: BigFloat,
  prec: number,
): BigFloat {
  requireFiniteBesselInput(nu, "bigBesselJSeriesMaclaurin", "nu");
  requireFiniteBesselInput(z, "bigBesselJSeriesMaclaurin", "z");
  if (isZero(z)) {
    // J_ν(0) = 0 for Re(ν) > 0, 1 for ν = 0.  We do not reach here for
    // non-positive non-integer ν (the public entry point validates that).
    if (isZero(nu)) return normalise(1n, 0, prec);
    if (sgn(nu) > 0) return { mantissa: 0n, exponent: 0, precision: prec };
    throw new RangeError(
      `bigBesselJSeriesMaclaurin: J_ν(0) undefined for ν < 0 non-integer; ` +
        `suggestion: use the connection J_{-ν}(z) = (-1)^n J_n(z) at integer ν, ` +
        `or evaluate symbolically.`,
    );
  }
  const work = prec + 32;
  // Build the recurrence ingredients.
  //   negQuarterZSquared := -z² / 4   (the constant in T_{k+1}/T_k)
  const zSquared = mul(z, z, work);
  const quarter = fromFloat64(0.25);
  const negQuarterZSquared = neg(mul(zSquared, quarter, work));
  // Series sum; T_0 = 1.
  let sum = fromInt(1n, work);
  let term = fromInt(1n, work);
  // Termination threshold: |next_term| < |sum| · 2^-(prec + 8).
  const stopMagThreshold = -prec - 8;
  // Safety cap.  Total term count ≈ |z|/2 + prec — generously bounded
  // by work · 4 for any input the dispatcher routes here.  The asymptotic
  // regime is *not* routed through this primitive — its caller bounds |z|.
  const absZFloat = toFloat64(abs(z)).value;
  const expectedTerms = Number.isFinite(absZFloat) ? absZFloat / 2 + work : work * 4;
  const maxTerms = Math.max(64, Math.ceil(expectedTerms * 2) + 32);
  for (let k = 0; k < maxTerms; k++) {
    //   T_{k+1} = T_k · (-z²/4) / ((k+1) · (ν + k + 1))
    const kPlus1 = fromInt(BigInt(k + 1), work);
    const nuPlusKPlus1 = add(nu, kPlus1, work);
    // Skip the pole at integer ν+k+1 = 0 — never reached for ν ≥ 0
    // (the dispatcher routes negative non-integer ν through the reflection
    // formula, never to direct Maclaurin).
    if (isZero(nuPlusKPlus1)) {
      throw new RangeError(
        `bigBesselJSeriesMaclaurin: ν + ${k + 1} = 0 hits Γ pole; ` +
          `suggestion: dispatch should route negative integer ν through reflection.`,
      );
    }
    const denom = mul(kPlus1, nuPlusKPlus1, work);
    term = div(mul(term, negQuarterZSquared, work), denom, work);
    sum = add(sum, term, work);
    const termMag = magBits(term);
    const sumMag = magBits(sum);
    if (termMag === -Infinity) break;
    if (termMag - sumMag < stopMagThreshold) break;
  }
  // Prefactor: (z/2)^ν / Γ(ν+1).
  //
  // For integer non-negative ν, (z/2)^ν = powInt path; gamma(ν+1) = ν!
  // (exact in rational form, but we go through the real gamma for
  // uniformity — gamma is exact-to-prec at positive integers via
  // lgamma + exp, mirror of the cgamma path).
  //
  // For half-integer / general real positive ν, we need `pow(z/2, ν)`
  // which `transcendental.pow` handles via `exp(ν · log(z/2))` for
  // non-integer exponent.  `gamma(ν+1)` handles arbitrary positive
  // real argument.
  const half = fromFloat64(0.5);
  const halfZ = mul(z, half, work);
  // Inline the pow-by-real-exponent to avoid the integer fast-path
  // overhead for the half-integer common case (it pays a powInt round-
  // trip otherwise).  The non-integer-exponent branch is just
  // `exp(ν · log(z/2))`.
  const halfZPowNu = powerReal(halfZ, nu, work);
  const one = fromInt(1n, work);
  const gammaNuPlus1 = gamma(add(nu, one, work), work);
  const prefactor = div(halfZPowNu, gammaNuPlus1, work);
  const result = mul(prefactor, sum, work);
  return normalise(result.mantissa, result.exponent, prec);
}

/**
 * `(base)^exponent` for `base > 0`, real `exponent`.  Inlined to avoid
 * the integer-fast-path round-trip when exponent is half-integer.
 *
 * `base = 0` returns 0 for positive exponent (the only call site that
 * could reach here is bigBesselJSeriesMaclaurin's prefactor, which is
 * gated by `isZero(z)` short-circuiting to the closed form before this
 * helper is called — so base > 0 is the load-bearing precondition).
 */
function powerReal(base: BigFloat, exponent: BigFloat, prec: number): BigFloat {
  if (isZero(exponent)) return normalise(1n, 0, prec);
  if (isZero(base)) {
    // sgn(exponent) > 0 by caller construction; 0^positive = 0.
    return { mantissa: 0n, exponent: 0, precision: prec };
  }
  // Defer to the standard transcendental.pow — it has the
  // integer-fast-path *and* the exp(ν log base) fall-through.  Inlining
  // the exp/log here would force a worst-case path for integer ν that
  // costs one extra log + exp (~prec · log prec ops); the powInt branch
  // is cheaper.
  return pow(base, exponent, prec);
}

// =============================================================================
// bigBesselJHankelAsymptotic — DLMF 10.17.5-6 (optimal truncation)
// =============================================================================

/**
 * Asymptotic evaluator for `J_ν(z)` at large positive `z`, via the
 * Hankel expansion (DLMF 10.17.5):
 *
 *   J_ν(z) ~ √(2/(πz)) · [cos(ω) · P_ν(z) − sin(ω) · Q_ν(z)]
 *
 * with `ω = z − νπ/2 − π/4` and
 *
 *   P_ν(z) = Σ_{k≥0} (-1)^k · a_{2k}(ν) / z^{2k}
 *   Q_ν(z) = Σ_{k≥0} (-1)^k · a_{2k+1}(ν) / z^{2k+1}
 *
 * coefficients `a_k(ν) = (4ν² − 1)(4ν² − 9) · ··· · (4ν² − (2k−1)²) /
 * (k! · 8^k)` with the recurrence (DLMF 10.17.1)
 *
 *   a_{k+1} / a_k = (4ν² − (2k+1)²) / (8 · (k+1))
 *
 * folded into the per-term ratio `T_k = a_k / z^k`:
 *
 *   T_0 = 1
 *   T_{k+1} = T_k · (4ν² − (2k+1)²) / (8 · (k+1) · z)
 *
 * `P` accumulates `T_0, -T_2, T_4, …`; `Q` accumulates `T_1, -T_3, T_5, …`.
 *
 * The series **diverges** if summed to infinity (Poincaré asymptotic).
 * Optimal truncation: track per-term magnitude; the moment
 * `|T_{k+1}| > |T_k|` we stop and return the partial sums.  The
 * Poincaré remainder at optimal truncation is bounded by twice the
 * magnitude of the first omitted term (Olver 1974 Theorem 3.1,
 * DLMF 10.17.13-14).  This idiom mirrors `lgammaStirling` (
 * `packages/bigfloat/src/special.ts:117`) and `bigErfcAsymptotic`.
 *
 * Caller is responsible for ensuring `z > 0`; the asymptotic is *only*
 * useful when `|z| > z_c_Hankel(prec)`.  Throws on non-positive `z`.
 *
 * Phase argument `ω` handling:
 *   For large `z`, `ω = z − νπ/2 − π/4` itself is large, but `sin(ω)`
 *   and `cos(ω)` only depend on `ω mod 2π`.  We compute `sin(ω)` and
 *   `cos(ω)` via the angle-addition expansion
 *
 *     cos(ω) = cos(z) · cos(νπ/2 + π/4) + sin(z) · sin(νπ/2 + π/4)
 *     sin(ω) = sin(z) · cos(νπ/2 + π/4) − cos(z) · sin(νπ/2 + π/4)
 *
 *   (Boost `bessel_jy_asym.hpp:99-127` pattern).  This keeps `cos(z)`
 *   and `sin(z)` as the only argument-reduction surface; the ν-dependent
 *   phase `νπ/2 + π/4` is computed at full working precision.  For
 *   moderate ν (≤ work / 2 bits worth) this is cleaner than forming
 *   `ω` then reducing mod 2π in one shot.
 *
 * Working precision is `prec + 32`.  The prefactor `√(2/(πz))` is
 * O(1/√z) (no cancellation in `√`).  The P/Q series themselves are O(1)
 * with no internal cancellation when truncated at the optimal point
 * (the alternation is benign because successive-term ratios shrink
 * monotonically up to the truncation index).  The only cancellation
 * surface is `cos(ω) P − sin(ω) Q` near a zero of `J_ν` — handled by
 * the dispatcher upstream via the corpus zero-crossing tolerance band
 * (ADR-0041 §Decision 12), not by this primitive.
 */
export function bigBesselJHankelAsymptotic(
  nu: BigFloat,
  z: BigFloat,
  prec: number,
): BigFloat {
  requireFiniteBesselInput(nu, "bigBesselJHankelAsymptotic", "nu");
  requireFiniteBesselInput(z, "bigBesselJHankelAsymptotic", "z");
  if (sgn(z) <= 0) {
    throw new RangeError(
      `bigBesselJHankelAsymptotic: z must be positive; got sign ${sgn(z)}. ` +
        `suggestion: for negative real z use the parity J_ν(-z) = (-1)^ν J_ν(z) ` +
        `(integer ν) or the reflection formula in the dispatcher; the asymptotic ` +
        `is defined for the principal sector |arg z| < π only.`,
    );
  }
  const work = prec + 32;
  // μ := 4ν², the parameter that feeds the coefficient recurrence.
  const fourNuSquared = mul(fromInt(4n, work), mul(nu, nu, work), work);
  // P, Q running sums.  P_0 = 1, Q_0 = T_1 = (4ν² − 1) / (8 · 1 · z).
  // Walk T_k for k = 0, 1, 2, … via the recurrence
  //   T_{k+1} = T_k · (4ν² − (2k+1)²) / (8 · (k+1) · z)
  // Alternating accumulation: P gets +T_0, −T_2, +T_4, …; Q gets
  // +T_1, −T_3, +T_5, ….
  let term = fromInt(1n, work); // T_0
  let P = fromInt(1n, work);     // = +T_0
  let Q: BigFloat = { mantissa: 0n, exponent: 0, precision: work };
  let prevTermMag = Infinity;
  const eightZ = mul(fromInt(8n, work), z, work);
  // Safety cap. Smallest-term index k* ≈ 4|z| (R2 §2.2); cap is generous.
  const maxTerms = Math.max(64, work * 4);
  for (let k = 0; k < maxTerms; k++) {
    // T_{k+1} = T_k · (4ν² − (2k+1)²) / (8 (k+1) z).
    const twoKPlus1 = 2 * k + 1;
    const twoKPlus1Squared = fromInt(BigInt(twoKPlus1 * twoKPlus1), work);
    const numerCoeff = sub(fourNuSquared, twoKPlus1Squared, work);
    const denom = mul(fromInt(BigInt(k + 1), work), eightZ, work);
    term = div(mul(term, numerCoeff, work), denom, work);
    const termMag = magBits(term);
    if (termMag === -Infinity) {
      // Exact zero — happens iff 4ν² = (2k+1)² exactly, i.e. ν is a
      // half-integer and the recurrence hits its termination at k_stop.
      // J_{n+1/2}(z) is in fact representable as a finite trig
      // combination; the asymptotic terminates naturally here.
      break;
    }
    // Optimal-truncation rule: if this term is larger than the previous
    // one, the series is diverging — STOP without adding.
    if (termMag > prevTermMag) {
      break;
    }
    // Add T_{k+1} into the appropriate accumulator with the alternating sign.
    // k+1 even (i.e., k odd) ⇒ T_{k+1} contributes to P, sign (−1)^((k+1)/2);
    // k+1 odd  (i.e., k even) ⇒ T_{k+1} contributes to Q, sign (−1)^(k/2).
    //
    // Concretely:
    //   k = 0 ⇒ T_1 into Q with sign +.
    //   k = 1 ⇒ T_2 into P with sign −.
    //   k = 2 ⇒ T_3 into Q with sign −.
    //   k = 3 ⇒ T_4 into P with sign +.
    //   k = 4 ⇒ T_5 into Q with sign +.
    // Pattern: into-P every other step starting k=1; into-Q every other
    // starting k=0.  Sign cycles 4-periodic: +Q, −P, −Q, +P, +Q, −P, ….
    const phase = k % 4;
    const signedTerm =
      phase === 0 || phase === 3 ? term : neg(term);
    if (k % 2 === 0) {
      Q = add(Q, signedTerm, work);
    } else {
      P = add(P, signedTerm, work);
    }
    prevTermMag = termMag;
    // Termination on absolute term size below the precision floor.
    if (termMag < -prec - 8) {
      break;
    }
  }
  // Compute sin(z), cos(z) for the angle-addition decomposition of
  // sin(ω), cos(ω), where ω = z − νπ/2 − π/4.
  const sZ = sin(z, work);
  const cZ = cos(z, work);
  // Phase offset φ := νπ/2 + π/4.
  const piVal = pi(work);
  const halfNu = mul(nu, fromFloat64(0.5), work);
  const phi = add(
    mul(halfNu, piVal, work),
    mul(piVal, fromFloat64(0.25), work),
    work,
  );
  const sPhi = sin(phi, work);
  const cPhi = cos(phi, work);
  // cos(ω) = cos(z − φ) = cos(z) cos(φ) + sin(z) sin(φ)
  // sin(ω) = sin(z − φ) = sin(z) cos(φ) − cos(z) sin(φ)
  const cOmega = add(mul(cZ, cPhi, work), mul(sZ, sPhi, work), work);
  const sOmega = sub(mul(sZ, cPhi, work), mul(cZ, sPhi, work), work);
  // Prefactor √(2/(πz)).
  const two = fromInt(2n, work);
  const piZ = mul(piVal, z, work);
  const twoOverPiZ = div(two, piZ, work);
  const amplitude = sqrt(twoOverPiZ, work);
  // J_ν(z) = amplitude · (cos(ω) P − sin(ω) Q).
  const combined = sub(mul(cOmega, P, work), mul(sOmega, Q, work), work);
  const result = mul(amplitude, combined, work);
  return normalise(result.mantissa, result.exponent, prec);
}

// =============================================================================
// bigBesselJSeriesCancellationRetry — measure loss, bump precision, recompute
// =============================================================================

/**
 * Cancellation-driven precision-retry wrapper around
 * `bigBesselJSeriesMaclaurin`.  The FLINT `bessel_j.c:480-557` pattern,
 * adapted to BigFloat: when the alternating Maclaurin's intermediate
 * peak-term magnitude exceeds the returned-sum magnitude by `L` bits,
 * exactly those `L` bits of the working precision were consumed by
 * cancellation.  Measure `L`, bump `work = prec + 32 + L + 16`,
 * recompute.
 *
 * Three differences from the raw `bigBesselJSeriesMaclaurin`:
 *
 *   1. The first-pass working precision is `work_0 = prec + 32 + cancelEst`
 *      where `cancelEst ≈ |z| · log₂ e` is the analytic upper bound on
 *      bits-destroyed-by-cancellation (FLINT `:585`).  This typically
 *      delivers prec-bit accuracy on the first pass.
 *
 *   2. The series loop tracks `peakTermMag = max_k magBits(T_k)` rather
 *      than only the per-iteration termination check.  Post-loop, we
 *      compute `lossBits = peakTermMag − magBits(sum)`.
 *
 *   3. If `lossBits > cancelEst + 16` (the analytic estimate was too
 *      generous), we re-run with `work_1 = prec + 32 + lossBits + 16`.
 *      The retry terminates after at most one bump because the second
 *      pass's `lossBits` is bounded by the same `cancelEst` plus the
 *      headroom — there is no wait-and-pray loop.
 *
 * For `|z|` small (≤ 8) or `ν > z²/4`, the cancellation bits are zero
 * or near-zero, the first pass at `work_0 = prec + 32 + (maybe 12)`
 * delivers, and the retry slot is wired but does not fire.  The retry
 * fires in the transition band `8 < |z| < z_c_Hankel(prec)` with
 * `ν < z²/4`, which is exactly where R2 §3.1 routes to this primitive.
 *
 * Mirrors `clgammaReflect` (worklog 117 bead `oj5j`) and `bigErfc` Erf
 * I1 (worklog 131) precision-retry harness.
 */
export function bigBesselJSeriesCancellationRetry(
  nu: BigFloat,
  z: BigFloat,
  prec: number,
): BigFloat {
  requireFiniteBesselInput(nu, "bigBesselJSeriesCancellationRetry", "nu");
  requireFiniteBesselInput(z, "bigBesselJSeriesCancellationRetry", "z");
  if (isZero(z)) {
    if (isZero(nu)) return normalise(1n, 0, prec);
    if (sgn(nu) > 0) return { mantissa: 0n, exponent: 0, precision: prec };
    throw new RangeError(
      `bigBesselJSeriesCancellationRetry: J_ν(0) undefined for ν < 0 non-integer`,
    );
  }
  const absZFloat = toFloat64(abs(z)).value;
  const cancelEst = cancelBitsEstimate(absZFloat);
  const work0 = prec + 32 + cancelEst;
  const first = besselJMaclaurinWithLossTracking(nu, z, work0);
  // If the measured loss is within the analytic estimate plus headroom,
  // the first pass is already prec-bit-clean — emit.
  if (first.lossBits <= cancelEst + 16) {
    return normalise(first.value.mantissa, first.value.exponent, prec);
  }
  // Bump: pay for the measured loss explicitly.  The retry's own series
  // will exhibit a `lossBits` bounded by the same analytic envelope, so
  // we are guaranteed termination in one bump.
  const work1 = prec + 32 + first.lossBits + 16;
  const second = besselJMaclaurinWithLossTracking(nu, z, work1);
  return normalise(second.value.mantissa, second.value.exponent, prec);
}

/**
 * Internal: run the Maclaurin series and *also* report the
 * peak-term-vs-sum loss.  Same algorithm as
 * `bigBesselJSeriesMaclaurin`, but with the running-peak tracker exposed
 * to the cancellation-retry wrapper.
 *
 * Returning a `{ value, lossBits }` record rather than a plain BigFloat
 * keeps the retry harness clean — the caller doesn't have to re-derive
 * the loss from the inputs.
 */
function besselJMaclaurinWithLossTracking(
  nu: BigFloat,
  z: BigFloat,
  work: number,
): { value: BigFloat; lossBits: number } {
  // Body inline-mirrors `bigBesselJSeriesMaclaurin` but tracks
  // peakTermMag.  We avoid calling the public routine to (a) keep the
  // tracking encapsulated, (b) save a redundant precision normalise.
  const zSquared = mul(z, z, work);
  const quarter = fromFloat64(0.25);
  const negQuarterZSquared = neg(mul(zSquared, quarter, work));
  let sum = fromInt(1n, work);
  let term = fromInt(1n, work);
  let peakTermMag = 0; // T_0 = 1 ⇒ magBits = 0.
  const stopMagThreshold = -work + 8; // slightly tighter than prec-only
  const absZFloat = toFloat64(abs(z)).value;
  const expectedTerms = Number.isFinite(absZFloat) ? absZFloat / 2 + work : work * 4;
  const maxTerms = Math.max(64, Math.ceil(expectedTerms * 2) + 32);
  for (let k = 0; k < maxTerms; k++) {
    const kPlus1 = fromInt(BigInt(k + 1), work);
    const nuPlusKPlus1 = add(nu, kPlus1, work);
    if (isZero(nuPlusKPlus1)) {
      throw new RangeError(
        `besselJMaclaurinWithLossTracking: ν + ${k + 1} = 0 hits Γ pole`,
      );
    }
    const denom = mul(kPlus1, nuPlusKPlus1, work);
    term = div(mul(term, negQuarterZSquared, work), denom, work);
    const termMag = magBits(term);
    if (termMag !== -Infinity && termMag > peakTermMag) {
      peakTermMag = termMag;
    }
    sum = add(sum, term, work);
    const sumMag = magBits(sum);
    if (termMag === -Infinity) break;
    if (termMag - sumMag < stopMagThreshold) break;
  }
  // Prefactor (z/2)^ν / Γ(ν+1).
  const half = fromFloat64(0.5);
  const halfZ = mul(z, half, work);
  const halfZPowNu = powerReal(halfZ, nu, work);
  const one = fromInt(1n, work);
  const gammaNuPlus1 = gamma(add(nu, one, work), work);
  const prefactor = div(halfZPowNu, gammaNuPlus1, work);
  const value = mul(prefactor, sum, work);
  // Loss accounting.  The prefactor is O(1) at moderate ν and z, so it
  // doesn't move the cancellation budget by more than a few bits — we
  // measure loss on the post-prefactor value as the load-bearing
  // quantity (matches FLINT's `bessel_j.c:537` "acc" calculation).
  const valueMag = magBits(value);
  const lossBits = Math.max(0, peakTermMag - valueMag);
  return { value, lossBits };
}

// =============================================================================
// bigBesselJ — the entry point
// =============================================================================

/**
 * Real-axis Bessel function of the first kind at user-controlled precision.
 *
 *   J_ν(z) = (z/2)^ν · Σ_{k=0}^∞ (-z²/4)^k / (k! · Γ(ν+k+1))
 *
 * Algorithm dispatch (R2 §3.1 + DLMF §10.17 + FLINT `bessel_j.c:579-595`):
 *
 *   z = 0:                   closed form (1 if ν=0, 0 if ν>0 integer,
 *                            error otherwise).
 *   z < 0:                   reflect via J_ν(-z) = (-1)^ν J_ν(z)
 *                            (integer ν) — non-integer negative-z input
 *                            errors with a `suggestion:` line pointing
 *                            at complex-z dispatch (deferred to I3a).
 *   |z| < 8                  → Maclaurin direct (small-z, no cancellation
 *                              problem because peak-term magnitude is
 *                              `≲ exp(|z|) ≈ exp(8) ≈ 12 bits`).
 *   |z| > z_c_Hankel(prec)   → Hankel asymptotic (smallest-term
 *                              truncation, Olver bound).
 *                              z_c_Hankel(p) := p / 2 (FLINT-conservative).
 *   transition (8 ≤ |z| ≤ p/2):
 *     ν > z²/4               → Maclaurin direct (FLINT comment "no
 *                              significant cancellation in 0F1" — the
 *                              `Γ(ν+k+1)` denominator suppresses term
 *                              magnitude before cancellation can build).
 *     otherwise              → Maclaurin with cancellation-retry.
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
export function bigBesselJ(nu: BigFloat, z: BigFloat, prec: number): BigFloat {
  requireFiniteBesselInput(nu, "bigBesselJ", "nu");
  requireFiniteBesselInput(z, "bigBesselJ", "z");
  if (prec < 1 || !Number.isInteger(prec)) {
    throw new RangeError(
      `bigBesselJ: prec must be a positive integer; got ${prec}. ` +
        `suggestion: use decimalToBinaryPrecision(<digits>) for a decimal target.`,
    );
  }
  // z = 0 closed forms.
  if (isZero(z)) {
    if (isZero(nu)) return normalise(1n, 0, prec);
    if (sgn(nu) > 0) return { mantissa: 0n, exponent: 0, precision: prec };
    // ν < 0: J_n(0) = 0 still holds for negative integer ν via the
    // parity J_{-n}(z) = (-1)^n J_n(z) and J_n(0) = 0 for n > 0; but
    // for non-integer negative ν, J_ν(0) is unbounded.  Detect integer
    // structurally.
    const nuFloat = toFloat64(nu).value;
    if (Number.isFinite(nuFloat)) {
      const nuRound = Math.round(nuFloat);
      const nuRoundedBack = fromInt(BigInt(nuRound), nu.precision);
      if (eq(nu, nuRoundedBack)) {
        // Integer negative ν: J_{-n}(0) = 0 for n ≥ 1.
        return { mantissa: 0n, exponent: 0, precision: prec };
      }
    }
    throw new RangeError(
      `bigBesselJ: J_ν(0) is unbounded for negative non-integer ν; ` +
        `suggestion: at z = 0, J_ν is singular for Re(ν) < 0 non-integer; ` +
        `use the symbolic limit instead.`,
    );
  }
  // Real negative z: route through parity for integer ν, refuse for
  // non-integer ν (would need complex-z dispatch, I3a).
  if (sgn(z) < 0) {
    const nuFloat = toFloat64(nu).value;
    if (Number.isFinite(nuFloat)) {
      const nuRound = Math.round(nuFloat);
      const nuRoundedBack = fromInt(BigInt(nuRound), nu.precision);
      if (eq(nu, nuRoundedBack)) {
        // J_ν(-z) = (-1)^ν J_ν(z) for integer ν.
        const positiveResult = bigBesselJ(nu, neg(z), prec);
        return (nuRound & 1) === 0 ? positiveResult : neg(positiveResult);
      }
    }
    throw new RangeError(
      `bigBesselJ: real negative z with non-integer ν requires the complex ` +
        `branch (J_ν has a branch point at z=0 for non-integer ν); not yet ` +
        `supported on the real arb-prec path. ` +
        `suggestion: route through the complex evaluator bigCBesselJ (I3a; ` +
        `bead scientist-workbench-q7ty) once it ships.`,
    );
  }
  // Negative non-integer ν: the connection formula
  //   J_{-ν}(z) = cos(νπ) J_ν(z) − sin(νπ) Y_ν(z)
  // requires bigBesselY, which is deferred to I1b (bead 1doz).  For
  // negative integer ν we use J_{-n} = (-1)^n J_n.
  if (sgn(nu) < 0) {
    const nuFloat = toFloat64(nu).value;
    if (Number.isFinite(nuFloat)) {
      const nuRound = Math.round(nuFloat);
      const nuRoundedBack = fromInt(BigInt(nuRound), nu.precision);
      if (eq(nu, nuRoundedBack)) {
        const positiveNuResult = bigBesselJ(neg(nu), z, prec);
        return (nuRound & 1) === 0 ? positiveNuResult : neg(positiveNuResult);
      }
    }
    throw new RangeError(
      `bigBesselJ: negative non-integer ν requires bigBesselY (I1b); ` +
        `not yet wired in I1a. ` +
        `suggestion: until I1b lands, evaluate J_{-ν}(z) via the connection ` +
        `formula J_{-ν}(z) = cos(νπ) J_ν(z) − sin(νπ) Y_ν(z) manually, or ` +
        `wait for the joint J/Y substrate.`,
    );
  }
  // z > 0, ν ≥ 0: the main dispatch.
  const absX = abs(z);
  const xFloat = toFloat64(absX).value;
  const zc = crossoverZcHankel(prec);
  // Small-z lane: |z| < 8.  Maclaurin direct (cancellation negligible).
  if (Number.isFinite(xFloat) && xFloat < 8) {
    return bigBesselJSeriesMaclaurin(nu, absX, prec);
  }
  // Large-z lane: |z| > z_c_Hankel.  Hankel asymptotic.
  if (!Number.isFinite(xFloat) || xFloat > zc) {
    return bigBesselJHankelAsymptotic(nu, absX, prec);
  }
  // Transition band: 8 ≤ |z| ≤ z_c.  Two sub-cases.
  //
  // FLINT short-circuit (`bessel_j.c:553-557`): "If nu > |z|²/4, no
  // significant cancellation in 0F1" — the Γ(ν+k+1) denominator
  // suppresses term magnitude before cancellation builds, so the
  // straight Maclaurin suffices.  Check via toFloat64 — we only need
  // an order-of-magnitude comparison.
  const nuFloat = toFloat64(nu).value;
  const zSquaredOver4 = (xFloat * xFloat) / 4;
  if (Number.isFinite(nuFloat) && nuFloat > zSquaredOver4) {
    return bigBesselJSeriesMaclaurin(nu, absX, prec);
  }
  // The interesting middle: alternating Maclaurin with measure-and-bump.
  return bigBesselJSeriesCancellationRetry(nu, absX, prec);
}
