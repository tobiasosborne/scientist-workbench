// =============================================================================
// @workbench/bigfloat — Beta function B(a, b) and log-Beta (arb-prec, real)
// =============================================================================
//
// This module ships the arb-prec real-axis entry points for the Beta family:
//
//   bigBeta(a, b, prec)     — B(a, b)   = Γ(a)·Γ(b) / Γ(a+b)
//   bigLogBeta(a, b, prec)  — log B(a,b) when B(a, b) > 0, computed as
//                              log|Γ(a)| + log|Γ(b)| − log|Γ(a+b)|
//                              with sign tracking; throws if the sign is
//                              negative (log of a negative real is not a
//                              real number — see "Why log-Beta throws on a
//                              negative sign" below).
//
// ADR-0042 §"Decision 3" pins the per-head signature; R2 §1.10 pins the
// algorithm; PHASE2 §I3a pins the LOC budget and test plan. ADR-0020
// governs the determinism contract: pure-BigInt arithmetic → bit-identical
// across runtimes forever at fixed `prec`.
//
// One algorithm, two products (R2 §1.10, DLMF §5.12.1)
// ----------------------------------------------------
//
// The Beta function has the closed-form definition
//
//   B(a, b)  =  Γ(a)·Γ(b) / Γ(a+b)
//
// At the level the substrate works at — `lgamma` already in hand, `exp`
// available, `gamma`'s algebraic-sign machinery established — the
// numerically right path is *never* "compute the three Gammas and divide".
// At even modest `(a, b)` like `(20, 20)`, `Γ(a)` and `Γ(b)` are each
// ~ 10^17 and `Γ(a+b)` is ~ 10^46; the ratio is ~ 10^-12, but the three
// Gammas themselves overflow float64-range mantissas. The arb-prec
// substrate can carry the magnitudes (a `BigFloat` mantissa is unbounded),
// but performing the ratio of three numbers separated by 25 orders of
// magnitude is wasteful: every digit of `Γ(a+b)` that gets cancelled by
// the numerator's growth had to be computed at full `work` precision
// first. The R2 §1.10 prescription is to work in log-space:
//
//   log B(a, b)  =  lgamma(a) + lgamma(b) − lgamma(a+b)
//
// Each `lgamma` is bounded above by `a · log a + O(a)` — linear-in-`a` in
// the log, not exponential. The subtraction is well-conditioned *unless*
// `a + b` is near a pole of Γ (a non-positive integer), in which case
// `lgamma(a+b)` blows up and the `lgammaRealAbs` `lossBits` mechanism
// (special.ts: `zhrm`) absorbs the cancellation at the working-precision
// level. Both entry points share the same log-space sum; `bigBeta`
// composes `exp(...)` with an algebraic sign, `bigLogBeta` returns the
// sum directly when the sign permits.
//
// Sign-tracking discipline (R2 §1.10; mirrors `gamma`'s `(−1)^m · sgn(ζ)`)
// ------------------------------------------------------------------------
//
// `lgamma` returns `log|Γ|` — the *magnitude* of Γ. For an argument
// `a < 0` non-integer, `Γ(a)` is real but can be negative. `gamma` in
// `special.ts` reads the sign off algebraically from `a = m + ζ` with
// `m = round(a)` and `ζ = a − m`:
//
//     sgn(Γ(a))  =  (−1)^m  ·  sgn(ζ)             when a < 0 non-integer
//                  +1                              when a > 0
//
// We reuse this verbatim — once per argument. The Beta sign is then
//
//     sgn(B(a, b))  =  sgn(Γ(a)) · sgn(Γ(b))      provided  a + b  is
//                                                  not a non-positive
//                                                  integer (Γ(a+b) > 0
//                                                  by reflection if so;
//                                                  see below).
//
// The denominator `Γ(a+b)` does *not* contribute a sign:
//   - If `a + b > 0`, then `Γ(a+b) > 0` (Γ is positive on the positive
//     real axis).
//   - If `a + b < 0` non-integer, then `Γ(a+b)` may itself be negative,
//     and `1/Γ(a+b)` carries that sign. By R2 §1.10 the BETA sign rule
//     `sgn B = sgn Γ(a) · sgn Γ(b)` is stated for the regime
//     `a + b not a non-positive integer`; in that regime, the
//     reflection-formula relation
//
//        Γ(a) Γ(1−a) sin(π a) = π
//
//     pins `sgn(Γ(a)) · sgn(Γ(1−a))` to `sgn(sin(π a))`, and a symmetric
//     fact for the sum lets the negative-`a+b` case fold into the same
//     rule when written in terms of `1/Γ`. We do NOT chase that
//     derivation here — instead we check explicitly: if `a + b < 0`, we
//     read `sgn(1/Γ(a+b)) = sgn(Γ(a+b))` (the reciprocal preserves
//     sign), with the same algebraic `(−1)^m · sgn(ζ)` machinery applied
//     to `a + b` itself.
//
// In code we therefore compute three `algebraicGammaSign` values
// independently and multiply: `s_a · s_b · s_{1/(a+b)} = s_a · s_b ·
// s_{a+b}` (since `sgn(1/x) = sgn(x)`). For the bulk case `a, b > 0`,
// all three signs are +1 and this collapses to a no-op; the machinery
// is only load-bearing on the rare negative-argument boundary.
//
// Why log-Beta throws on a negative sign
// ---------------------------------------
//
// `bigBeta(a, b)` returns a signed `BigFloat`. `bigLogBeta(a, b)` returns
// `log B(a, b)` as a real `BigFloat`. If `B(a, b) < 0`, then `log B`
// is not a real number — it lives at `log|B| + iπ` in the complex
// plane. We do not silently return `log|B|` (that would be a lie about
// the answer; CLAUDE.md Rule 8) and we do not return a `BigComplex`
// (that would break the declared `BigFloat → BigFloat` signature
// pinned by ADR-0042 §Decision 3). The honest thing is to throw a
// loud `RangeError` directing the caller to `bigBeta` (which returns
// the signed magnitude) or — if they truly want the complex log — to
// the future complex Beta entry point (`cBeta` is on the v0.2 ADR-0042
// roadmap). This is the same discipline `log(x)` itself uses on x < 0.
//
// Pole handling and v0.1 scope (PHASE2 §I3a, R2 §3.4)
// ----------------------------------------------------
//
// `lgamma` of a non-positive integer is a pole. There are three pole
// configurations the Beta function can encounter:
//
//   1. Either `a` or `b` (but not the other) is a non-positive integer:
//      one numerator factor blows up while the other does not. `B(a, b)`
//      has an unbounded singularity here. We throw a typed `RangeError`
//      (the library-level analogue of a `ToolError`, per the task spec).
//
//   2. `a + b` is a non-positive integer but neither `a` nor `b` is
//      individually. Then `Γ(a+b)` is infinite while `Γ(a), Γ(b)` are
//      finite; the formal value of `B(a, b)` is `0`. The cleanest path
//      would be to short-circuit and return `0`, but the v0.1 spec says
//      throw a clear error — the limit-branch is v0.2 (a separate bead).
//      We honour the spec.
//
//   3. Both `a` and `b` are non-positive integers, and `a + b` is also a
//      non-positive integer. The Γ poles in the numerator and denominator
//      "race"; the limit can be finite. This is the case the spec
//      explicitly calls out as v0.2 deferred. We throw with a pointer
//      to PHASE2 §I3a.
//
// All three branches throw the same shape of `RangeError` so callers can
// pattern-match the message. None of them silently degrade.
//
// Working precision (R2 §1.10, §3.4; CLAUDE.md Rule 1)
// -----------------------------------------------------
//
// The three sub-`lgamma` calls run at `work = prec + 32 + losses` where
// `losses` is the maximum cancellation depth measured across the three
// arguments (`a`, `b`, `a+b`). The depth comes from the same
// `lgammaRealAbs` reflection bookkeeping `special.ts` uses internally
// — we recompute it caller-side because the lgamma calls hide the
// depth from us (the API returns a `BigFloat`, not a `{value, lossBits}`
// pair). For arguments in the bulk regime (`Re ≥ −1/2` and not near a
// negative integer), `losses = 0` and `work = prec + 32`, which matches
// the PHASE2 §I3a recommendation byte-for-byte.
//
// Domain restrictions (v0.1)
// --------------------------
//
//   - Real arguments only on this entry. The complex extension lives in
//     `complex.ts` as `cBeta` (v0.2; ADR-0042 §Decision 3).
//   - Non-positive integer arguments throw (poles; see "Pole handling"
//     above).
//   - `bigLogBeta` additionally throws when the signed Beta value is
//     negative (see "Why log-Beta throws on a negative sign" above).
//
// References (all in repo)
// ------------------------
//   - docs/refs/gamma-research/R2-arbprec-algorithms.md §1.10, §3.4
//   - docs/refs/gamma-research/PHASE2-impl-plans.md I3a (lines 767-824)
//   - docs/adr/0042-gamma-family-per-head-substrate.md §Decision 3
//   - docs/adr/0020-arbitrary-precision-tier.md (determinism contract)
//   - DLMF §5.12.1 (definition), §5.5.3 (reflection),
//                 §5.12.2 (closed forms B(m,n) = (m-1)!(n-1)!/(m+n-1)!)
//   - Boyd 2014 "Solving Transcendental Equations" §8 (sign discipline
//     under log-exp transformations)

import { BigFloat, normalise, bitLength } from "../types.js";
import { neg, sgn, isZero } from "../comparison.js";
import { add, sub } from "../arithmetic.js";
import { fromInt, toFloat64 } from "../conversion.js";
import { exp } from "../transcendental.js";
import { lgamma } from "../special.js";

// =============================================================================
// Helpers
// =============================================================================

/**
 * `log₂ |x|` to integer precision; returns `-Infinity` for `x = 0`. Same
 * helper used in `erf.ts`, `incomplete-gamma.ts`, and `special.ts`;
 * reproduced locally so this module is self-contained — it is the
 * cheapest piece of cancellation-depth bookkeeping and unifying it across
 * special-function modules would cost an extra import for two lines of
 * code (CLAUDE.md Rule 10: literate exposition over premature abstraction).
 */
function magBits(x: BigFloat): number {
  if (x.mantissa === 0n) return -Infinity;
  const m = x.mantissa < 0n ? -x.mantissa : x.mantissa;
  return x.exponent + bitLength(m);
}

/**
 * Validate inputs to the Beta entry points. Loud throws on:
 *   - non-integer / non-positive `prec`
 *   - malformed BigFloat (precision <1, non-finite exponent)
 *   - magnitude > 2^1024 (beyond any meaningful arb-prec computation)
 *
 * The check is shared by `bigBeta` and `bigLogBeta` so the error messages
 * are uniform; the function name is passed in for diagnostic clarity.
 * Mirrors `requireFiniteIncompleteGammaInput` in `incomplete-gamma.ts`.
 */
function requireFiniteBetaInput(
  a: BigFloat,
  b: BigFloat,
  prec: number,
  fn: string,
): void {
  if (prec < 1 || !Number.isInteger(prec)) {
    throw new RangeError(
      `${fn}: prec must be a positive integer; got ${prec}. ` +
        `suggestion: use decimalToBinaryPrecision(<digits>) for a decimal target.`,
    );
  }
  for (const [name, v] of [["a", a], ["b", b]] as const) {
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
          `Beta domain (|${name}| > 2^1024). suggestion: at this magnitude ` +
          `Stirling's expansion of B(a, b) is dominated by ` +
          `(a-1)·log a + (b-1)·log b − (a+b-1)·log(a+b); evaluate that ` +
          `closed-form expression directly if you really need such a regime.`,
      );
    }
  }
}

/**
 * Classify an argument `x` for the lgamma pole / reflection accounting.
 * Returns:
 *   - `m = round(Re x)` — the nearest integer to `x`.
 *   - `isPole` — true iff `x` is exactly a non-positive integer (i.e.,
 *     `m ≤ 0` and `x − m == 0` to all bits).
 *   - `lossBits` — the cancellation depth `lgammaRealAbs` will incur on
 *     this argument. For `x > 0`, `lossBits = 0`. For `x < 0`, `lossBits
 *     = max(0, magBits(x) − magBits(x − m))`, the same formula
 *     `lgammaRealAbs` uses in `special.ts`. We recompute it caller-side
 *     because the public `lgamma` signature does not surface it.
 *
 * "Algebraic" because the sign of `Γ(x)` is read from `x = m + ζ` with
 * `m = round(x)` and `ζ = x − m`:
 *
 *     sgn(Γ(x))  =  (−1)^m · sgn(ζ)              for x < 0 non-integer
 *                   +1                            for x > 0
 *
 * This mirrors `gamma`'s sign-recovery exactly (special.ts:271-303). The
 * `gammaSign` field is `+1 | -1` (and `0` would mean a pole, but that's
 * captured by `isPole` so we never return `0` here — defensive: callers
 * should check `isPole` first).
 */
interface GammaClassification {
  m: number;
  isPole: boolean;
  lossBits: number;
  gammaSign: 1 | -1;
}

function classifyForLgamma(x: BigFloat): GammaClassification {
  const xFloat = toFloat64(x).value;
  if (!Number.isFinite(xFloat)) {
    throw new RangeError(
      `bigBeta: argument is not finite; cannot determine lgamma classification.`,
    );
  }
  const m = Math.round(xFloat);
  const zeta = sub(x, fromInt(BigInt(m), x.precision), x.precision);
  // Pole detection: only non-positive integers (m ≤ 0 with ζ = 0).
  // Positive integers are NOT poles of Γ — Γ(n) = (n-1)! is finite for n ≥ 1.
  if (m <= 0 && isZero(zeta)) {
    return { m, isPole: true, lossBits: 0, gammaSign: 1 };
  }
  if (sgn(x) > 0) {
    return { m, isPole: false, lossBits: 0, gammaSign: 1 };
  }
  // x < 0 non-integer. Cancellation depth and algebraic sign.
  const lossBits =
    m === 0 ? 0 : Math.max(0, magBits(x) - magBits(zeta));
  const zetaSgn = sgn(zeta);
  // sgn(Γ(x)) = (−1)^m · sgn(ζ). m % 2 === 0 covers m = 0 cleanly.
  const gammaSign: 1 | -1 = (m % 2 === 0 ? zetaSgn : -zetaSgn) as 1 | -1;
  return { m, isPole: false, lossBits, gammaSign };
}

// =============================================================================
// bigLogBeta — log B(a, b)  via R2 §1.10 lgamma sum
// =============================================================================

/**
 * `log B(a, b)` for real arguments.
 *
 *     log B(a, b)  =  lgamma(a) + lgamma(b) − lgamma(a + b)
 *
 * Each of the three `lgamma` calls is performed at `work = prec + 32 +
 * losses` bits, where `losses` is the maximum cancellation depth across
 * the three arguments — see the classification helper above. The final
 * sum is normalised to `prec`.
 *
 * Throws (loud `RangeError`, with a `suggestion:` clause per CLAUDE.md
 * Rule 1) when:
 *
 *   - any of `a`, `b`, `a+b` is a non-positive integer (pole of Γ;
 *     `B` itself is unbounded or in the v0.2 limit-branch — see the
 *     top-of-file "Pole handling" note);
 *   - the signed value of `B(a, b)` is negative (then `log B` is not
 *     a real number; the answer would have an `iπ` imaginary part and
 *     this routine refuses to silently drop it — see top-of-file
 *     "Why log-Beta throws on a negative sign").
 *
 * For `a, b > 0` the routine reduces to three positive-argument `lgamma`
 * calls; the algebraic-sign machinery folds to `+1 · +1 = +1` and the
 * throw branches never fire. This is the hot path.
 */
export function bigLogBeta(a: BigFloat, b: BigFloat, prec: number): BigFloat {
  requireFiniteBetaInput(a, b, prec, "bigLogBeta");
  // Build a fresh `a + b` at the input precision for pole classification.
  // We do this at `max(a.precision, b.precision)` so we don't lose
  // information before we measure cancellation; the *working* precision
  // for the actual lgamma calls is computed below from `lossBits`.
  const classPrec = Math.max(a.precision, b.precision);
  const sumAB = add(a, b, classPrec);
  const cA = classifyForLgamma(a);
  const cB = classifyForLgamma(b);
  const cAB = classifyForLgamma(sumAB);
  // Pole short-circuits with explicit-diagnostic messages.
  if (cA.isPole || cB.isPole) {
    // MUTATION-PROOF: collapsing this to a single concatenated message
    // hides which argument tripped the throw; keep them itemised so a
    // caller looking at a stack trace can read off which input was bad.
    if (cA.isPole && cB.isPole && cAB.isPole) {
      throw new RangeError(
        `bigLogBeta: a, b, AND a+b are all non-positive integers ` +
          `(a=${toFloat64(a).value}, b=${toFloat64(b).value}). The limit ` +
          `Γ(a)·Γ(b)/Γ(a+b) is finite but requires careful pole-residue ` +
          `cancellation; the v0.1 substrate does not implement this branch. ` +
          `suggestion: deferred to v0.2, see docs/refs/gamma-research/` +
          `PHASE2-impl-plans.md §I3a.`,
      );
    }
    if (cA.isPole) {
      throw new RangeError(
        `bigLogBeta: a is a non-positive integer (a=${toFloat64(a).value}); ` +
          `Γ(a) has a simple pole there, and so does B(a, b). ` +
          `suggestion: B(a, b) is unbounded at non-positive integer a; ` +
          `if the pole "cancels" against b or a+b, use the closed-form ` +
          `residue rather than this numeric entry.`,
      );
    }
    throw new RangeError(
      `bigLogBeta: b is a non-positive integer (b=${toFloat64(b).value}); ` +
        `Γ(b) has a simple pole there, and so does B(a, b). ` +
        `suggestion: B(a, b) is unbounded at non-positive integer b; ` +
        `if the pole "cancels" against a or a+b, use the closed-form ` +
        `residue rather than this numeric entry.`,
    );
  }
  if (cAB.isPole) {
    // a+b is a non-positive integer but a, b individually are NOT —
    // the formal value of B(a, b) is 0. v0.1 throws per PHASE2 §I3a.
    throw new RangeError(
      `bigLogBeta: a + b is a non-positive integer ` +
        `(a+b≈${toFloat64(sumAB).value}) while a, b are not; the formal ` +
        `value of B(a, b) is 0 and log B(a, b) = -∞. ` +
        `suggestion: the limit-branch is deferred to v0.2 per ` +
        `docs/refs/gamma-research/PHASE2-impl-plans.md §I3a; for now, ` +
        `detect this case caller-side and return 0 (or -∞ for log B).`,
    );
  }
  // Working precision: bump by the worst cancellation across the three
  // arguments. For a, b > 0 (and hence a + b > 0) this is 0 and the bump
  // collapses to the canonical `prec + 32` of PHASE2 §I3a.
  const losses = Math.max(cA.lossBits, cB.lossBits, cAB.lossBits);
  const work = prec + 32 + losses;
  // Sign computation: sgn(B) = sgn(Γ(a)) · sgn(Γ(b)) · sgn(Γ(a+b)) — the
  // last factor folds in because 1/Γ has the same sign as Γ.
  // MUTATION-PROOF: swapping one of these signs to a constant +1 will
  // make the negative-argument symmetry test fail (B(a, b) = B(b, a))
  // when a or b is in the reflection regime — because the magnitudes
  // are symmetric but a sign-bug breaks parity-by-which-argument.
  const sign: 1 | -1 = (cA.gammaSign * cB.gammaSign * cAB.gammaSign) as 1 | -1;
  if (sign === -1) {
    throw new RangeError(
      `bigLogBeta: B(a, b) < 0 (sign = ${sign}); log of a negative real ` +
        `is not a real number. ` +
        `suggestion: use bigBeta(a, b, prec) for the signed magnitude, ` +
        `or — when complex Beta lands as cBeta in v0.2 — clog(cBeta(a,b)) ` +
        `for the principal-branch complex log.`,
    );
  }
  // The three lgamma calls. lgamma returns log|Γ| for any non-pole real;
  // we have already excluded poles above.
  // MUTATION-PROOF: changing `add(a, b, work)` to `sub(a, b, work)` here
  // breaks all the cross-check tests against gamma() — exp(logBeta(a, b))
  // would compute Γ(a)·Γ(b)/Γ(a−b), which is the wrong identity.
  const sumAtWork = add(a, b, work);
  const lgA = lgamma(a, work);
  const lgB = lgamma(b, work);
  const lgAB = lgamma(sumAtWork, work);
  // log B = log|Γ(a)| + log|Γ(b)| − log|Γ(a+b)|. (Sign is +1 here by the
  // throw above — the magnitude-only sum is the right answer.)
  const numerator = add(lgA, lgB, work);
  const result = sub(numerator, lgAB, work);
  return normalise(result.mantissa, result.exponent, prec);
}

// =============================================================================
// bigBeta — B(a, b)  via exp(logBeta) × algebraic sign
// =============================================================================

/**
 * `B(a, b) = Γ(a)·Γ(b) / Γ(a+b)` for real arguments.
 *
 * Computed as `±exp(log|Γ(a)| + log|Γ(b)| − log|Γ(a+b)|)` with the sign
 * recovered algebraically from `(−1)^m · sgn(ζ)` per argument (mirroring
 * `gamma` in `special.ts`). This is the only path: there is no
 * "small-`a, b`" short-circuit because direct evaluation
 * `Γ(a)Γ(b)/Γ(a+b)` is strictly worse — it carries every intermediate
 * Gamma at full magnitude and only collapses at the final division,
 * paying for working bits we then throw away.
 *
 * Throws (loud `RangeError`) when any of `a`, `b`, `a+b` is a non-
 * positive integer — see the top-of-file "Pole handling" note. The
 * v0.1 substrate does not implement the "two-pole / three-pole cancel-
 * to-finite-limit" branches; they are filed as v0.2 follow-ups.
 *
 * Closed-form values pinned by tests in `beta.test.ts`:
 *
 *   B(1, 1)         = 1                          (R1 Rule BETA-1)
 *   B(1/2, 1/2)     = π                          (R1 Rule BETA-4; DLMF §5.12)
 *   B(m, n)         = (m-1)! · (n-1)! / (m+n-1)! (positive integers)
 *   B(a, 1)         = 1 / a                      (R1; DLMF §5.12 limit)
 *   B(a, b)         = B(b, a)                    (symmetry, R1; DLMF §5.12.1)
 *   B(a,b)·Γ(a+b)   = Γ(a) · Γ(b)                (defining identity)
 *
 * All six are tested; the first four are byte-exact at `prec ≥ 200`, the
 * last two are tested as `prec − 4`-bit agreements (the small slack
 * absorbs round-half-to-even of the final `normalise`).
 */
export function bigBeta(a: BigFloat, b: BigFloat, prec: number): BigFloat {
  requireFiniteBetaInput(a, b, prec, "bigBeta");
  // Classify each argument up front so we can throw on poles before doing
  // any lgamma work (and so the throw messages name the right argument).
  const classPrec = Math.max(a.precision, b.precision);
  const sumAB = add(a, b, classPrec);
  const cA = classifyForLgamma(a);
  const cB = classifyForLgamma(b);
  const cAB = classifyForLgamma(sumAB);
  if (cA.isPole || cB.isPole || cAB.isPole) {
    // Re-use bigLogBeta's diagnostics to keep the two entry points'
    // error messages aligned. bigLogBeta will throw with the right
    // message because we pass the same arguments; the magnitude path
    // never executes.
    bigLogBeta(a, b, prec);
    // bigLogBeta always throws on a pole — this line is unreachable
    // and exists only for the type-checker / future-proofing.
    throw new Error("unreachable: bigLogBeta must throw on a pole");
  }
  const losses = Math.max(cA.lossBits, cB.lossBits, cAB.lossBits);
  const work = prec + 32 + losses;
  // Sign of B(a, b) — see classifyForLgamma comments and the top-of-file
  // sign-tracking section. The product folds 1/Γ(a+b)'s sign in because
  // sgn(1/x) = sgn(x).
  const sign: 1 | -1 = (cA.gammaSign * cB.gammaSign * cAB.gammaSign) as 1 | -1;
  // Magnitude path. We *cannot* call bigLogBeta directly here because
  // bigLogBeta throws when sign < 0 (log of a negative real); we need the
  // magnitude unconditionally to combine with `sign`. So we inline the
  // log-space sum at the local working precision.
  const sumAtWork = add(a, b, work);
  const lgA = lgamma(a, work);
  const lgB = lgamma(b, work);
  const lgAB = lgamma(sumAtWork, work);
  const logMag = sub(add(lgA, lgB, work), lgAB, work);
  const mag = exp(logMag, work);
  // MUTATION-PROOF: replacing `sign === 1 ? mag : neg(mag)` with the
  // bare `mag` breaks the (currently optional) negative-argument
  // symmetry tests — `B(−0.4, 2.7)` is positive but `B(−1.4, 2.7)` is
  // negative, and dropping the sign treats them identically.
  const signed = sign === 1 ? mag : neg(mag);
  return normalise(signed.mantissa, signed.exponent, prec);
}
