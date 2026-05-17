// =============================================================================
// @workbench/bigfloat — Bessel function of the second kind `Y_ν(z)` (arb-prec)
// =============================================================================
//
// This module ships the arb-prec real-axis entry point for the Bessel
// Y family (Y is also called the Weber / Neumann function in classical
// references — Boost spells the entry point `cyl_neumann`, ADR-0041
// §"Decision 8" L_boost_yspell):
//
//   bigBesselY(nu, z, prec)        — real ν, real positive z; the user-visible entry
//
// plus two internal primitives the dispatch routes over:
//
//   bigBesselYConnection   — DLMF 10.2.3 J/J(-ν) connection formula
//                            `Y_ν(z) = (J_ν(z) cos(νπ) − J_{-ν}(z)) / sin(νπ)`,
//                            with measure-and-bump cancellation-retry
//                            around the near-integer-ν L'Hôpital site.
//                            Used directly for non-integer ν AND as the
//                            inner kernel of the integer-ν limit path.
//   bigBesselYIntegerNu    — v0.1 limit-via-ε path: evaluate the same
//                            connection at ν = n + ε with ε = 2^−(prec+32)
//                            at boosted working precision.  Mirror of
//                            `bigBesselKIntegerNu` (worklog 157).
//
// ADR-0041 §"Decision 3" pins the per-head signature and the algorithm
// dispatch; §"Decision 13" pins the negative-real-ν branch convention
// (we match Wolfram's behaviour: exactly-integer ν → integer-ν path;
// non-integer ν → connection formula with cancellation-retry); ADR-0020
// pins the determinism contract this substrate must honour (bit-identical
// across runtimes forever, given fixed `prec` bits).
//
// Why a J/J(-ν) connection rather than the FLINT `Y_n via K_n(iz)` rotation
// ------------------------------------------------------------------------
//
// FLINT's `acb_hypgeom_bessel_y.c:36-80` computes integer-ν Y_n on the
// complex plane via the identity
//
//   Y_n(z) = -2·i^n · K_n(iz) / π − phase(z) · i · J_n(z)
//
// (R2 §3.2 lines 1121-1147).  That is *the* algorithmically right thing
// to do because it sidesteps the connection formula's 0/0 cancellation
// at integer ν entirely.  It requires a complex-K substrate
// (`bigCBesselK`) which has not yet shipped — the I3b bead `t73h` is
// blocked on Round 3 completing.  For v0.1 we therefore use the same
// **limit-via-ε** trick I2b adopted for K_n: evaluate the non-integer
// connection at `ν = n + ε` with ε small enough that the limit-error is
// vastly below the rounding floor, and absorb the L'Hôpital cancellation
// with boosted working precision.
//
// Numerical analysis pinning the ε choice (the I2b lesson, worklog 157):
// The limit-error is **linear** in ε around an integer-ν singularity:
//   Y_n(z) − Y(n+ε, z) = ε · ∂Y/∂ν|_{ν=n} + O(ε²)
// — not quadratic, despite the L'Hôpital limit's superficial symmetry.
// With ε = 2^−(prec/2 + 16) (the quadratic-error budget) the limit-error
// would be ~2^−(prec/2 + 16) — *catastrophically wrong* at the prec
// floor (this is exactly what I2b worklog 157 friction #2 documented).
// With ε = 2^−(prec + 32) (linear-error budget) the limit-error is
// ~2^−(prec + 32) — vastly below `2^−prec`.  **M3 mutation point**: the
// test `Y(1 + 1e-30, 1) ≈ Y_1(1)` catches a regression to the quadratic
// budget by going RED loudly.
//
// v0.2 follow-up: port FLINT's complex-K rotation when I3b ships
// (bigCBesselK).  The integer-ν path will then dispatch directly via
// the K_n(iz) identity, gaining ~50% perf on integer-ν inputs and
// eliminating the limit-error entirely (the rotation is algebraic,
// not limit-based).  v0.1 limit-via-ε is correct at all precisions
// tested in the corpus (PREC_50DP = 200 bits) and acceptable up to
// ~500 bits, beyond which the 2× working-precision penalty becomes
// noticeable.
//
// Why bypass I1a's wrapper refusal via the exported primitives
// -------------------------------------------------------------
//
// I1a's `bigBesselJ` refuses non-integer negative ν with a `suggestion:`
// line that points directly at this module ("until I1b lands, evaluate
// J_{-ν}(z) via the connection formula ... or wait for the joint J/Y
// substrate").  The refusal is a politeness — the underlying series
// (Maclaurin) and asymptotic (Hankel) are mathematically well-defined
// for any real ν on z > 0; the wrapper just lacks a J(-ν) story for
// real-axis use.  Y's connection formula REQUIRES J_{-ν} for non-integer
// ν.  We bypass the wrapper refusal by calling the exported primitives
// `bigBesselJSeriesMaclaurin` / `bigBesselJHankelAsymptotic` /
// `bigBesselJSeriesCancellationRetry` directly with negative ν; we
// reimplement I1a's small-/transition-/large-z dispatch locally
// (`evalJAnyNu`) so the negative-ν path traverses the same code path
// as the positive-ν path — same series, same asymptotic, same
// cancellation-retry — just without the wrapper's input gate.
//
// This is **load-bearing**: routing through `bigBesselJ(-nu, z, work)`
// would throw at every non-integer ν call, which is the dominant
// case (half-integer, decimal-ν, near-integer all hit here).
//
// Cancellation surface (the I2b retry-harness pattern)
// ----------------------------------------------------
//
// The connection formula `Y = (Jν cos(νπ) − J(-ν)) / sin(νπ)` has its
// single cancellation site at the sin(νπ) division.  Two regimes:
//
//   (a) Near-integer ν: as ν → n, sin(νπ) → 0 as `π·(ν − n)`, and the
//       numerator `Jν cos(νπ) − J(-ν)` also → 0 with the SAME leading
//       order.  Their ratio is the finite limit Y_n.  Bit-loss in the
//       subtraction scales as `−log₂|ν − round(ν)|`.
//
//   (b) Near a zero of J: the connection's numerator can shrink while
//       the answer Y_ν stays O(1).  This is a relative-error blowup
//       rather than an absolute one — Y is finite, but the relative
//       precision delivered shrinks.  Bounded by `−log₂|J_ν(z)|` bits
//       near the J zero.  The cross-agreement comparator handles this
//       via the zero-crossing tolerance band (ADR-0041 §Decision 12,
//       L7); the substrate doesn't need a special-case (the retry
//       harness measures the loss empirically and bumps).
//
// The retry harness:
//   1. Estimate `nearIntegerBits = −magBits(ν − round(ν))` via BigFloat
//      semantics (NOT float64 — the integer-ν caller's ε is well below
//      float64's representable distance to an integer; rounding `ν =
//      n + 2^−p` to float64 just gives `n`, which would either refuse
//      the call or under-budget by `p` bits).  This is the same
//      load-bearing observation as I2b worklog 157 friction #1.
//   2. First-pass at `work_0 = prec + 32 + nearIntegerBits`.
//   3. Measure post-hoc `lossBits = max(magBits(Jν cos(νπ)), magBits(Jmnu))
//      − magBits(numerator)`.  If exceeds estimate + 16 bits, re-run at
//      `work_1 = prec + 32 + lossBits + 16`.  Terminates after one bump
//      (the analytic estimate is an upper bound, modulo finite-precision
//      magnitude measurement noise ~1 bit).
//
// **M2 mutation point**: dropping the retry harness — i.e., using
// `work = prec + 32` directly without bumping — makes the near-integer
// ν tests fail because the inner numerator subtraction loses `−log₂|ν −
// n|` bits to L'Hôpital cancellation, leaving 0 useful bits at the prec
// floor for `ε ≈ 2^−100`.
//
// **M1 mutation point**: swapping the numerator subtraction sign
// (`Jν cos(νπ) − J(-ν)` → `Jν cos(νπ) + J(-ν)`) produces catastrophically
// wrong answers — the sum is dominated by `J(-ν)` which has the WRONG
// sign for small z and integer-near ν.  Verified by the golden-master
// suite (every T1 input goes RED) and the special-value Y_0(1) ≈ 0.0883
// test (returns ~2 instead).
//
// References (all in repo)
// ------------------------
//   - docs/adr/0041-bessel-family-per-head-substrate.md §"Decision 3"
//     + §"Decision 13" (negative-real-ν branch convention)
//   - docs/adr/0020-arbitrary-precision-tier.md
//   - docs/refs/besselj-research/R2-arbprec-algorithms.md §3.2
//   - docs/refs/besselj-research/sources/arbprec/bessel_y.c (FLINT
//     acb_hypgeom; lines 36-80 are the integer-ν K(iz) rotation we
//     defer to v0.2 once I3b ships)
//   - packages/bigfloat/src/special-funcs/besselk.ts (I2b sibling;
//     the limit-via-ε pattern this module mirrors)
//   - packages/bigfloat/src/special-funcs/besselj.ts (I1a sibling;
//     exported primitives we dispatch on for J_{±ν})
//   - DLMF §10.2.3 (defining connection), §10.4 (integer-ν definition
//     via limit), §10.34 (analytic continuation, branch-cut)
//   - docs/worklog/157-i2b-bigbesselk-real.md (the I2b pattern lineage)

import { BigFloat, normalise, bitLength } from "../types.js";
import { abs, neg, sgn, isZero, eq } from "../comparison.js";
import { add, sub, mul, div } from "../arithmetic.js";
import { fromInt, fromFloat64, toFloat64 } from "../conversion.js";
import { pi, sin, cos } from "../transcendental.js";
import {
  bigBesselJ,
  bigBesselJSeriesMaclaurin,
  bigBesselJHankelAsymptotic,
  bigBesselJSeriesCancellationRetry,
} from "./besselj.js";

// =============================================================================
// Helpers
// =============================================================================

/**
 * `log₂ |x|` to integer precision; returns `-Infinity` for `x = 0`.
 * Used by the cancellation-loss tracking in `bigBesselYConnection` and
 * by the near-integer-ν distance measurement that sizes the working
 * precision.  Local copy of the same shape used in `besselj.ts`,
 * `besselk.ts`, `erf.ts`, `special.ts`, `complex.ts`.
 */
function magBits(x: BigFloat): number {
  if (x.mantissa === 0n) return -Infinity;
  const m = x.mantissa < 0n ? -x.mantissa : x.mantissa;
  return x.exponent + bitLength(m);
}

/**
 * Validate that a BigFloat input is finite-and-usable.  Throws
 * `RangeError` with a `suggestion:` line.  Mirrors `besselj.ts` /
 * `besselk.ts`.
 */
function requireFiniteBesselYInput(x: BigFloat, fn: string, name: string): void {
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
          `suggestion: at this magnitude the connection-formula inputs are at the ` +
          `edge of BigFloat representability — bound your input.`,
      );
    }
  }
}

/**
 * Round-trip a BigFloat to test "is this exactly an integer at this
 * precision?".  Returns the integer value if so, else `null`.  Mirrors
 * `besselk.ts::asExactInteger`.
 *
 * Load-bearing for dispatch: the integer-ν Y path uses the limit-via-ε
 * routine; non-integer ν uses the connection-formula primitive.  The
 * `eq(nu, roundTrip)` test at the input precision is the canonical
 * "exactly integer" detector — a BigFloat constructed via `fromInt(n)`
 * trivially passes; a BigFloat constructed via `fromString("1.0000...")`
 * with trailing zeros also passes (the trailing fractional bits are
 * exactly zero); `fromString("1.5")` does NOT pass (rounds to a
 * different integer or to non-integer).
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
 * Crossover threshold below which the Hankel asymptotic does not yet
 * deliver `prec` bits of accuracy.  Same form as
 * `besselj.ts::crossoverZcHankel` — `z_c_Hankel(p) := p / 2` (FLINT-
 * conservative).  We re-derive locally rather than import to keep
 * `besselj.ts`'s dispatch logic encapsulated; the crossover is a
 * substrate-wide constant, not a J-specific tuning parameter.
 */
function crossoverZcHankel(prec: number): number {
  return prec / 2;
}

/**
 * Evaluate `J_ν(z)` for ANY real ν (including negative non-integer) on
 * a positive real z, by direct dispatch onto I1a's exported primitives.
 *
 * I1a's wrapper `bigBesselJ` refuses non-integer negative ν with a
 * `suggestion:` line pointing at I1b — the present module.  The
 * refusal is policy, not algorithm: the underlying Maclaurin series and
 * Hankel asymptotic are mathematically well-defined for all real ν on
 * z > 0 (the only ν-pole is at the gamma function in the prefactor,
 * which lives at ν = -1, -2, -3, ... — exactly the integer negative ν
 * we route through I1a's integer-parity fast path).  This helper
 * bypasses the wrapper for the non-integer-negative-ν case.
 *
 * Dispatch mirrors `bigBesselJ`'s small-/transition-/large-z structure
 * (besselj.ts lines 741-842), with one simplification: the negative-z
 * branch is impossible (caller guarantees z > 0) and the negative-
 * integer-ν branch is moot (caller invokes `bigBesselJ` directly for
 * those, via the integer-parity flag).
 *
 * Working precision flows through unchanged; the caller is responsible
 * for sizing it to absorb cancellation downstream of this evaluator.
 *
 * **Why this lives here and not in `besselj.ts`**: I1a's wrapper refusal
 * is the documented v0.1 contract — agents calling `bigBesselJ`
 * directly with `-1.5` should get the loud RangeError, not a silent
 * fall-through.  The bypass is a Y-specific implementation detail of
 * the connection-formula path; it belongs in the consumer (here) not
 * in the producer.
 *
 * @throws RangeError on non-finite ν or z (propagated from the
 *   primitives' validators).
 */
function evalJAnyNu(nu: BigFloat, z: BigFloat, prec: number): BigFloat {
  // Caller guarantees z > 0; defensive check kept loud.
  if (sgn(z) <= 0) {
    throw new RangeError(
      `evalJAnyNu: z must be positive; got sign ${sgn(z)}. ` +
        `suggestion: bigBesselY validates z > 0 upstream; the connection ` +
        `primitive must only be called with z > 0.`,
    );
  }
  const absZFloat = toFloat64(abs(z)).value;
  const zc = crossoverZcHankel(prec);
  // Small-z lane: |z| < 8.  Maclaurin direct (cancellation negligible).
  if (Number.isFinite(absZFloat) && absZFloat < 8) {
    return bigBesselJSeriesMaclaurin(nu, z, prec);
  }
  // Large-z lane: |z| > z_c_Hankel.  Hankel asymptotic.
  if (!Number.isFinite(absZFloat) || absZFloat > zc) {
    return bigBesselJHankelAsymptotic(nu, z, prec);
  }
  // Transition band: 8 ≤ |z| ≤ z_c.  Two sub-cases (FLINT short-circuit
  // for ν > z²/4, otherwise cancellation-retry).
  const nuFloat = toFloat64(nu).value;
  const absNuFloat = Number.isFinite(nuFloat) ? Math.abs(nuFloat) : Infinity;
  const zSquaredOver4 = (absZFloat * absZFloat) / 4;
  // Note we compare `|ν|` against `z²/4` — for negative ν the J series
  // term magnitude depends on `|ν + k|` not on the sign of ν per se;
  // the FLINT short-circuit's cancellation-suppression argument applies
  // identically (the `Γ(ν+k+1)` denominator becomes `Γ(−|ν|+k+1)` which
  // grows in `k` exactly the same way once `k > |ν|`).
  if (Number.isFinite(absNuFloat) && absNuFloat > zSquaredOver4) {
    return bigBesselJSeriesMaclaurin(nu, z, prec);
  }
  return bigBesselJSeriesCancellationRetry(nu, z, prec);
}

// =============================================================================
// bigBesselYConnection — DLMF 10.2.3 J/J(-ν) connection (non-integer ν)
// =============================================================================

/**
 * Connection-formula evaluator for `Y_ν(z)` at non-integer real ν, real
 * positive z:
 *
 *   Y_ν(z) = (J_ν(z) · cos(νπ) − J_{-ν}(z)) / sin(νπ)         (DLMF 10.2.3)
 *
 * Cancellation surface
 * --------------------
 *
 * The single cancellation site is the numerator subtraction
 * `J_ν cos(νπ) − J_{-ν}` and the simultaneous denominator vanishing
 * `sin(νπ) → 0` as ν → n.  Both go to zero at the same rate
 * (L'Hôpital-style), giving a finite limit Y_n that the integer-ν
 * dispatch evaluates via `bigBesselYIntegerNu`.  For "merely close to
 * integer" ν, the dispatch routes here and the retry harness absorbs
 * the bit-loss.
 *
 * Cancellation budget (analytic estimate, mirrored from `besselk.ts`):
 *
 *   nearIntegerBits ≈ −log₂|ν − round(ν)|
 *
 * — measured via BigFloat semantics (see the comment in
 * `bigBesselKFromConnection`, worklog 157 friction #1: float64
 * `round(toFloat64(nu))` either matches the wrong integer or rounds to
 * an integer when ν is `n + 2^−p` with `p > 53`, leading to either a
 * spurious refusal or a catastrophic under-budget).
 *
 * Note: unlike K's `bigBesselKFromConnection`, the Y connection has NO
 * exponential-growth cancellation budget.  Both `J_ν(z)` and `J_{-ν}(z)`
 * are O(1/√z) at large z (Hankel asymptotic), so the numerator
 * subtraction never carries a `2|z|·log₂ e` budget the way K's
 * connection does.  The only loss is the L'Hôpital one at near-integer ν.
 *
 * Working precision
 * -----------------
 *
 *   first pass:  `work_0 = prec + 32 + nearIntegerBits`
 *   retry pass (if measured loss exceeds estimate + 16):
 *                `work_1 = prec + 32 + lossBits + 16`
 *
 * Terminates after at most one bump (same termination argument as
 * `bigBesselJSeriesCancellationRetry` and `bigBesselKFromConnection`:
 * the analytic estimate is an upper bound modulo ~1 bit of
 * magnitude-measurement noise).
 *
 * Caller is responsible for ensuring ν is NOT exactly integer (the
 * dispatcher routes integer ν through `bigBesselYIntegerNu`) and
 * z > 0 (the public entry validates).
 *
 * **M1 mutation point**: swapping the numerator subtraction sign
 * (`J_ν cos(νπ) − J_{-ν}` → `J_ν cos(νπ) + J_{-ν}`) makes every
 * golden-master test go catastrophically RED.
 *
 * **M2 mutation point**: dropping the retry harness — i.e., not bumping
 * `work` when `lossBits > cancelEst + 16` — makes the near-integer-ν
 * tests fail by `~lossBits − headroom` digits.
 */
export function bigBesselYConnection(
  nu: BigFloat,
  z: BigFloat,
  prec: number,
): BigFloat {
  requireFiniteBesselYInput(nu, "bigBesselYConnection", "nu");
  requireFiniteBesselYInput(z, "bigBesselYConnection", "z");
  if (sgn(z) <= 0) {
    throw new RangeError(
      `bigBesselYConnection: z must be positive; got sign ${sgn(z)}. ` +
        `suggestion: the public entry bigBesselY already gates z ≤ 0; this ` +
        `primitive must only be called with z > 0.`,
    );
  }
  // Near-integer ν distance, measured via BigFloat (the
  // float64-mismatch trap from worklog 157 applies identically here).
  const nuFloat = toFloat64(nu).value;
  let nearIntegerBits = 0;
  if (Number.isFinite(nuFloat)) {
    const nuRound = Math.round(nuFloat);
    const nuRoundBig = fromInt(BigInt(nuRound), nu.precision);
    const frac = sub(nu, nuRoundBig, nu.precision + 32);
    if (isZero(frac)) {
      throw new RangeError(
        `bigBesselYConnection: ν is exactly integer (${nuFloat}); ` +
          `suggestion: integer ν must route through bigBesselYIntegerNu.`,
      );
    }
    const fracMagBits = magBits(frac);
    // fracMagBits < 0 for any non-integer ν within ±1/2 of round(ν);
    // −fracMagBits is the bit-loss the L'Hôpital site will inflict.
    // Cap at prec+64 to bound pathological cases (calling with
    // ν = n + 2^−(prec+1000) is technically valid; the cap converges
    // the cancellation budget to a number the retry harness can absorb).
    nearIntegerBits = Math.min(prec + 64, Math.max(0, -fracMagBits));
  }
  const cancelEst = nearIntegerBits;
  const work0 = prec + 32 + cancelEst;
  const first = besselYConnectionWithLossTracking(nu, z, work0);
  if (first.lossBits <= cancelEst + 16) {
    return normalise(first.value.mantissa, first.value.exponent, prec);
  }
  // Pay for the measured loss explicitly.  Termination: bounded by the
  // same analytic envelope plus 16-bit headroom; one bump suffices.
  const work1 = prec + 32 + first.lossBits + 16;
  const second = besselYConnectionWithLossTracking(nu, z, work1);
  return normalise(second.value.mantissa, second.value.exponent, prec);
}

/**
 * Internal: evaluate the J/J(-ν) connection and report the cancellation
 * loss in the `Jν cos(νπ) − J(-ν)` numerator subtraction.
 *
 *   numerator   = J_ν(z) · cos(νπ) − J_{-ν}(z)
 *   denominator = sin(νπ)
 *   Y_ν(z)      = numerator / denominator
 *
 * Returns `{ value, lossBits }`.  Loss is measured as
 * `max(|J_ν cos(νπ)|, |J_{-ν}|) − |numerator|` in bits.
 *
 * Both `J_ν` and `J_{-ν}` are computed via `evalJAnyNu` (which routes
 * onto I1a's exported primitives directly, bypassing the wrapper's
 * non-integer-negative-ν refusal).  `cos(νπ)` and `sin(νπ)` are
 * computed via `transcendental.{cos,sin}` at full working precision —
 * the BigFloat argument-reduction handles the periodicity correctly,
 * with no mod-2π preprocessing required.
 */
function besselYConnectionWithLossTracking(
  nu: BigFloat,
  z: BigFloat,
  work: number,
): { value: BigFloat; lossBits: number } {
  // J_ν(z), J_{-ν}(z) — both at working precision.  `evalJAnyNu` is the
  // load-bearing helper that lets us call J with negative non-integer ν
  // without tripping I1a's wrapper refusal.
  const Jnu = evalJAnyNu(nu, z, work);
  const Jmnu = evalJAnyNu(neg(nu), z, work);
  // cos(νπ), sin(νπ) — `pi(work)` is the cached high-precision π;
  // `sin`/`cos` reduce arguments internally so no mod-2π prep needed.
  const piVal = pi(work);
  const nuPi = mul(nu, piVal, work);
  const cosNuPi = cos(nuPi, work);
  const sinNuPi = sin(nuPi, work);
  // Numerator: J_ν cos(νπ) − J_{-ν}.
  const jNuCos = mul(Jnu, cosNuPi, work);
  const numerator = sub(jNuCos, Jmnu, work);
  // Y = numerator / sin(νπ).
  const value = div(numerator, sinNuPi, work);
  // Loss accounting.  Peak intermediate is max(|jNuCos|, |Jmnu|);
  // numerator is their difference.  Bit-loss = peak − |numerator|.
  const peakMag = Math.max(magBits(jNuCos), magBits(Jmnu));
  const numMag = magBits(numerator);
  const lossBits = numMag === -Infinity ? 0 : Math.max(0, peakMag - numMag);
  return { value, lossBits };
}

// =============================================================================
// bigBesselYIntegerNu — v0.1 limit-via-ε path for integer ν
// =============================================================================

/**
 * Integer-ν evaluator for `Y_n(z)` via the connection-formula limit:
 *
 *   Y_n(z) = lim_{ν → n} (J_ν(z) cos(νπ) − J_{-ν}(z)) / sin(νπ)    (DLMF 10.4.2)
 *
 * We evaluate the limit numerically by setting `ν = n + ε` for a tiny
 * ε and boosting the working precision to absorb the L'Hôpital
 * cancellation.  Mirrors `bigBesselKIntegerNu` (worklog 157).
 *
 * Eps choice: `ε = 2^−(prec + 32)`.  Linear-error analysis around an
 * integer-ν singularity (NOT quadratic — see the literate header
 * narrative for the I2b lesson):
 *
 *   Y_n(z) − Y(n+ε, z) = ε · ∂Y/∂ν|_{ν=n} + O(ε²)
 *
 * With ε = 2^−(prec + 32) and `∂Y/∂ν|_{ν=n}` bounded near O(1) for
 * typical inputs, the limit-error is `~2^−(prec + 32)`, vastly below
 * the final rounding floor at `2^−prec`.
 *
 * **M3 mutation point**: using ε = 2^−(prec/2 + 16) (the quadratic-
 * error budget that the I2b friction-#2 documented as wrong) makes the
 * integer-ν golden-master tests fail by ~prec/2 digits — i.e., at
 * prec=200 you get ~30 dp agreement instead of the required ≥ 48 dp.
 * The test `Y_1(1) ≈ −0.7812` matches the canonical value at full
 * agreement under the linear-error budget; under the quadratic budget
 * it loses half its digits.
 *
 * Working precision: `prec + 32 + (prec + 32) + 32` = `2·(prec + 32) +
 * 32`.  The `prec + 32` is the substrate budget; another `prec + 32`
 * absorbs the L'Hôpital cancellation (the `sin(νπ)` denominator's
 * magBits is `−log₂(1/ε) = −(prec + 32)`); the trailing 32 is safety.
 * Asymptotically `O(prec)` work; the constant factor (2×) is the price
 * of v0.1 limit-via-ε vs the v0.2 FLINT complex-K rotation.
 *
 * v0.2 follow-up: port FLINT `acb_hypgeom_bessel_y.c:36-80`
 * (`Y_n(z) = -2 i^n K_n(iz)/π − phase(z) i J_n(z)`) once I3b ships
 * `bigCBesselK`.  Exact (no limit); ~1.5× faster (no L'Hôpital
 * precision blow-up).  Filed P3 follow-up under epic zcam.
 *
 * Caller is responsible for ensuring `n` is integer (the dispatcher
 * routes integer ν here) and z > 0.
 */
export function bigBesselYIntegerNu(
  n: number,
  z: BigFloat,
  prec: number,
): BigFloat {
  if (!Number.isInteger(n)) {
    throw new RangeError(
      `bigBesselYIntegerNu: n must be an integer; got ${n}. ` +
        `suggestion: non-integer ν must route through bigBesselYConnection.`,
    );
  }
  requireFiniteBesselYInput(z, "bigBesselYIntegerNu", "z");
  if (sgn(z) <= 0) {
    throw new RangeError(
      `bigBesselYIntegerNu: z must be positive; got sign ${sgn(z)}. ` +
        `suggestion: the public entry bigBesselY already gates z ≤ 0; this ` +
        `primitive must only be called with z > 0.`,
    );
  }
  // Y is NOT even-or-odd in ν as a function — for negative integer ν
  // we use DLMF 10.4.1: `Y_{-n}(z) = (-1)^n · Y_n(z)`.  This is the
  // J-family parity (J_{-n} = (-1)^n J_n) carried through the
  // connection formula; verified independently at PREC_50DP against
  // Wolfram for n ∈ {-1, -2, -3}.
  const nAbs = Math.abs(n);
  const epsBits = prec + 32;
  // Working precision: prec + 32 (substrate) + epsBits (L'Hôpital
  // absorption) + 32 (safety).
  const work = prec + 32 + epsBits + 32;
  // ε = 2^−epsBits as a BigFloat.
  const eps: BigFloat = {
    mantissa: 1n,
    exponent: -epsBits,
    precision: work,
  };
  // ν = n + ε at the boosted working precision.  We perturb the
  // positive |n| (= nAbs), not the signed n, because the integer-ν
  // parity sign correction is applied after the limit evaluation —
  // this keeps the cancellation harness in `bigBesselYConnection`
  // operating on the small-|ν| side where its analytic budget is tight.
  const nuExact = add(fromInt(BigInt(nAbs), work), eps, work);
  // Direct call to the connection primitive; do NOT route through
  // public `bigBesselY` (which would re-detect integer ν via the
  // round-trip-at-input-precision test and re-enter this function —
  // infinite recursion).
  const limit = bigBesselYConnection(nuExact, z, work);
  // Apply DLMF 10.4.1 parity for negative-integer-ν inputs.
  const signed = n < 0 && (nAbs & 1) === 1 ? neg(limit) : limit;
  return normalise(signed.mantissa, signed.exponent, prec);
}

// =============================================================================
// bigBesselY — the entry point
// =============================================================================

/**
 * Real-axis Bessel function of the second kind at user-controlled
 * precision.  Also known as the Weber function (mpmath:
 * `bessely`/`weber`) or the Neumann function (Boost: `cyl_neumann` —
 * NOT `cyl_bessel_y`, per ADR-0041 §"Decision 8" L_boost_yspell).
 *
 *   Y_ν(z) = (J_ν(z) · cos(νπ) − J_{-ν}(z)) / sin(νπ)         (DLMF 10.2.3)
 *
 * The companion of J on the real axis: at large z, J and Y form the
 * orthogonal pair `√(2/(πz)) cos(z − νπ/2 − π/4)` and
 * `√(2/(πz)) sin(z − νπ/2 − π/4)`; at z → 0+, Y diverges
 * (logarithmically for ν=0, as a power of z for ν > 0) while J
 * remains bounded (= 1 for ν=0, vanishes for ν > 0).
 *
 * Algorithm dispatch (R2 §3.2 + DLMF §10.2 + §10.4 + ADR-0041
 * §"Decision 3" + §"Decision 13"):
 *
 *   z = 0:           refuse — Y_ν(0+) = −∞ for all real ν, but the
 *                    divergence is logarithmic (ν=0) or power-law (ν>0);
 *                    tagged class `bigfloat/y-singular-at-zero`.
 *   z < 0:           refuse — Y has a branch cut along the negative
 *                    real axis (DLMF 10.11.5); tagged class
 *                    `bigfloat/y-branch-cut-on-negative`.
 *   ν integer (any z > 0):     bigBesselYIntegerNu — limit-via-ε path.
 *   ν non-integer (any z > 0): bigBesselYConnection — DLMF 10.2.3 with
 *                              cancellation-retry.
 *
 * Determinism: every operation is `BigInt` + bounded-integer-exponent
 * arithmetic; `BigInt` is bit-identical across runtimes by language
 * specification.  Inherits the `arbprec: true` contract of ADR-0020 —
 * same `(nu, z, prec)` bytes → byte-identical output forever.
 *
 * Convention note (ADR-0041 §"Decision 13"): for negative non-integer
 * ν, the connection formula above defines `Y_{-ν}` via the same
 * subtraction with `J_{-ν}` taking the role of `J_ν`.  We do not
 * special-case negative ν in the dispatch — the connection formula
 * works for any non-integer ν (positive or negative); for negative
 * integer ν we apply DLMF 10.4.1 parity `Y_{-n}(z) = (-1)^n Y_n(z)`
 * inside `bigBesselYIntegerNu`.  This matches Wolfram's behaviour at
 * non-integer ν and is the convention pinned by ADR-0041 §"Decision 13"
 * landmine L3.
 *
 * @throws RangeError on non-finite input, z ≤ 0 (singular / branch cut),
 *   or other inadmissible configurations.
 */
export function bigBesselY(nu: BigFloat, z: BigFloat, prec: number): BigFloat {
  requireFiniteBesselYInput(nu, "bigBesselY", "nu");
  requireFiniteBesselYInput(z, "bigBesselY", "z");
  if (prec < 1 || !Number.isInteger(prec)) {
    throw new RangeError(
      `bigBesselY: prec must be a positive integer; got ${prec}. ` +
        `suggestion: use decimalToBinaryPrecision(<digits>) for a decimal target.`,
    );
  }
  // z = 0: singular for all real ν (Y_ν(0+) → −∞).
  if (isZero(z)) {
    throw new RangeError(
      `bigBesselY: Y_ν(z) is singular at z = 0 (Y_0(0+) ~ (2/π) log(z/2) — ` +
        `logarithmic; Y_ν(0+) ~ -(1/π) Γ(ν) (2/z)^ν for ν > 0 — power-law). ` +
        `suggestion: tool-layer code should emit tagged "bigfloat/y-singular-at-zero" ` +
        `for this input; do not request Y_ν at z = 0.`,
    );
  }
  // z < 0: branch cut.
  if (sgn(z) < 0) {
    throw new RangeError(
      `bigBesselY: Y_ν(z) has a branch cut along the negative real axis ` +
        `(DLMF 10.11.5); not defined as a real-valued function for z < 0. ` +
        `suggestion: tool-layer code should emit tagged ` +
        `"bigfloat/y-branch-cut-on-negative" for this input; route through ` +
        `the complex evaluator bigCBesselY (I3a; bead scientist-workbench-q7ty) ` +
        `once it ships.`,
    );
  }
  // Integer ν: limit-via-ε integer path.  Handles all integer ν
  // (positive, zero, and negative — the parity sign is applied inside).
  // ν = 0 trivially `asExactInteger` returns 0.
  const asInt = asExactInteger(nu);
  if (asInt !== null) {
    return bigBesselYIntegerNu(asInt, z, prec);
  }
  // Non-integer ν: connection formula with cancellation-retry.  Works
  // for both positive and negative non-integer ν — the
  // `bigBesselYConnection` primitive is sign-agnostic in ν (it computes
  // both J_ν and J_{-ν} regardless of the sign of ν).
  return bigBesselYConnection(nu, z, prec);
}
