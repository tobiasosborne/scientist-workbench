// =============================================================================
// Parameter coalescence — detection and bit-magnitude perturbation
// =============================================================================
//
// Slater's residue formulae assume *simple* poles in the relevant Γ
// factors. That assumption breaks the moment two of the residue-line
// parameters differ by an integer:
//
//     b_i − b_j ∈ ℤ                 (Series 1 coalescence)
//     a_i − a_j ∈ ℤ                 (Series 2 coalescence)
//     1 + b_h − a_j is a non-positive integer for some `j`
//                                   (parameter-pole inside the inner pFq)
//
// At a coalescence, the simple-pole prefactor `Γ(b_j − b_h)` (or its
// Series-2 mirror) hits a Γ-pole, and the inner pFq's bottom-list
// contains a non-positive integer (parameter pole). Both residues *do*
// have well-defined values — they are higher-order residues — but the
// closed-form formula in `slater.ts` doesn't compute them directly.
//
// Two correct paths exist (Slater 1966 §5.5 vs. Johansson 2009 blog
// post on numerical hypergeometric evaluation):
//
//   (i)  Closed-form higher-order residues with `digamma` / `polygamma`.
//        Mathematically exact; combinatorially intricate; multiplicity
//        > 2 quickly outpaces hand-derivation. Future enhancement.
//
//   (ii) **Bit-magnitude perturbation.** Detect coalescence; perturb
//        every parameter by an independent multiple of `2^{-pertBits}`
//        where `pertBits ≈ working_precision / 2`; re-run Slater's
//        simple-pole formula. The residue prefactors and the inner-
//        pFq bottom parameters are now non-coalescent, all evaluable.
//        The cancellation between the perturbed residue lines absorbs
//        the perturbation; `working_precision = 2·target + spare`
//        leaves the target intact.
//
//        Mathematically this *is* the L'Hôpital limit — the same value
//        the closed-form higher-order residue would produce. The brief
//        (Johansson 2009) recommends this path; we implement it as the
//        v0.1 default.
//
// Determinism note. A randomised perturbation would make our arb-prec
// output non-reproducible run-to-run, violating the `arbprec: true`
// contract (ADR-0020 requires bit-identical output across runtimes for
// fixed input). We therefore use a deterministic odd-coefficient
// pattern:
//
//     δ_i = (2·i + 1) · 2^{-pertBits}      for i = 0, 1, 2, …
//
// — distinct, all of the same sign, and `δ_i − δ_j = 2(i−j)·2^{-pertBits}`
// is a non-zero even multiple of `2^{-pertBits}` for `i ≠ j`. Combined
// with any integer-multiple original coalescence, the perturbed
// difference is `(integer) + 2(i−j)·2^{-pertBits}`, which is non-integer
// (since the second summand is sub-unit and non-zero). Coalescence is
// broken in *every* pair, regardless of original spacing.

import type { BigComplex, BigFloat } from "@workbench/bigfloat";
import {
  add,
  fromInt,
  isZero,
  normalise,
  sgn,
  sub,
  toFloat64,
  abs,
  cabs,
} from "@workbench/bigfloat";
import type { MeijerGParameters } from "./types.js";

// -----------------------------------------------------------------------------
// Detection
// -----------------------------------------------------------------------------

/**
 * Detect coalescence (any pair of `params` whose difference is within
 * `tolerance` of an integer in real part *and* zero in imaginary part).
 *
 * The tolerance is given as `2^{-tolBits}`; values within that of an
 * integer count as coalescent. We default the threshold to half the
 * working precision when the orchestrator calls this — the point at
 * which Johansson's perturbation lives, and below which the
 * cancellation effect would be indistinguishable from a true
 * integer coalescence.
 */
export function hasIntegerSpacedPair(
  params: readonly BigComplex[],
  tolBits: number,
): boolean {
  if (params.length < 2) return false;
  for (let i = 0; i < params.length; i++) {
    for (let j = i + 1; j < params.length; j++) {
      if (differsByInteger(params[i]!, params[j]!, tolBits)) return true;
    }
  }
  return false;
}

/**
 * Size of the largest equivalence class under "differs by an integer"
 * within `params`.  Used by the Slater orchestrator to detect 3+ pole
 * integer-spaced coalescence (bead `scientist-workbench-fwsz`), where
 * the perturbation path's cancellation grows super-quadratically with
 * cluster size and the v0.1 odd-coefficient perturbation alone cannot
 * absorb it within a finite working-bits budget.  The closed-form
 * `digamma`/`polygamma` higher-order residue (Slater 1966 §5) is the
 * mathematical fix; until that ships, the orchestrator emits a
 * structured `coalescence-needs-higher-order-residue` refusal as soon
 * as a cluster of size ≥ 3 is detected.
 *
 * The "differs by an integer" relation is an equivalence relation
 * (reflexive, symmetric, transitive — provided the integer-difference
 * test is exact, which it is to within the `tolBits` threshold), so
 * union-find isn't needed; a single linear pass per parameter suffices
 * for the small parameter counts we ever face (typically `≤ 6`).
 */
export function largestIntegerSpacedClusterSize(
  params: readonly BigComplex[],
  tolBits: number,
): number {
  if (params.length < 2) return params.length;
  // Group parameters into equivalence classes.  Each class is identified
  // by its *first* member (acting as a canonical representative); a new
  // parameter joins the existing class iff it differs by an integer
  // from any prior member.  Linear scan suffices.
  const classes: BigComplex[][] = [];
  for (const p of params) {
    let placed = false;
    for (const cls of classes) {
      if (differsByInteger(p, cls[0]!, tolBits)) {
        cls.push(p);
        placed = true;
        break;
      }
    }
    if (!placed) classes.push([p]);
  }
  let max = 0;
  for (const cls of classes) {
    if (cls.length > max) max = cls.length;
  }
  return max;
}

/**
 * Test `(a − b) ∈ ℤ` to within `2^{-tolBits}` precision in both real
 * and imaginary parts.
 */
export function differsByInteger(
  a: BigComplex,
  b: BigComplex,
  tolBits: number,
): boolean {
  // Compute the difference at higher working precision so the sub-unit
  // imaginary check is meaningful.
  const work = Math.max(a.re.precision, b.re.precision, tolBits + 32);
  const dRe = sub(a.re, b.re, work);
  const dIm = sub(a.im, b.im, work);
  // |Im(diff)| < 2^{-tolBits}.
  if (!magBitsBelow(dIm, -tolBits)) return false;
  // |Re(diff) - round(Re(diff))| < 2^{-tolBits}.
  const reFloat = toFloat64(dRe).value;
  if (!Number.isFinite(reFloat)) return false;
  const roundedFloat = Math.round(reFloat);
  if (!Number.isFinite(roundedFloat) || Math.abs(roundedFloat) > 1e15) {
    // The integer is so large we cannot represent it in float64
    // round-trip safely; fall back to exact: subtract the truncated-int
    // estimate and check again.
    return false;
  }
  const rounded = fromInt(BigInt(roundedFloat), work);
  const drift = sub(dRe, rounded, work);
  return magBitsBelow(drift, -tolBits);
}

/** True iff `|x| < 2^{magBitsThreshold}` (negative threshold ⟹ "very small"). */
function magBitsBelow(x: BigFloat, magBitsThreshold: number): boolean {
  if (isZero(x)) return true;
  // x has `precision` significant bits; its magnitude is roughly
  // `2^(exponent + precision)`. For the comparison we just need the
  // leading-bit position.
  const leadingBitPos = x.exponent + x.precision;
  return leadingBitPos < magBitsThreshold;
}

// -----------------------------------------------------------------------------
// Coalescence summary across all four sub-tuples
// -----------------------------------------------------------------------------

/**
 * Survey the parameters for the kinds of coalescence that the chosen
 * series cares about.
 *
 * Series 1 cares about coalescence in `bm` (the residue lines) and in
 * the inner pFq's bottom list `(1 + b_h − b_j)_{j ≠ h, j ≤ q}`. The
 * second is a derived quantity, but a sufficient condition for it to
 * miss is that no member of `bm ∪ bq` is integer-spaced from a member
 * of `bm`. We check the whole-row condition because a perturbation
 * applied to all four sub-tuples breaks both at once.
 *
 * Series 2 mirrors with `an` and `an ∪ ap`.
 *
 * The returned `clusterSize` is the size of the largest integer-spacing
 * equivalence class on the residue-line parameters (`bm` for series 1,
 * `an` for series 2).  The orchestrator uses `clusterSize ≥ 3` as the
 * trigger for the `coalescence-needs-higher-order-residue` structured
 * refusal — bead `scientist-workbench-fwsz`.
 */
export function detectCoalescence(
  params: MeijerGParameters,
  series: 1 | 2,
  tolBits: number,
): { coalescent: boolean; reason: string; clusterSize: number } {
  if (series === 1) {
    const clusterSize = largestIntegerSpacedClusterSize(params.bm, tolBits);
    if (hasIntegerSpacedPair(params.bm, tolBits)) {
      return {
        coalescent: true,
        reason:
          clusterSize >= 3
            ? `≥${clusterSize} \`bm\` parameters lie in the same integer-spacing equivalence class`
            : "two `bm` parameters differ by an integer",
        clusterSize,
      };
    }
    // Inner pFq's bottom list has `1 + b_h - b_j` for j ≠ h over both
    // bm and bq. Flag if any bm-element is integer-spaced from a bq.
    for (const bh of params.bm) {
      for (const bj of params.bq) {
        if (differsByInteger(bh, bj, tolBits)) {
          return {
            coalescent: true,
            reason: "a `bm` parameter is integer-spaced from a `bq` parameter",
            clusterSize: 1,
          };
        }
      }
    }
    // Inner pFq parameter-pole when `1 + b_h - a_j` is a non-positive
    // integer ⇔ `b_h - a_j` is a negative integer. We catch by
    // observing `a_j - b_h` is a positive integer.
    for (const bh of params.bm) {
      for (const aj of [...params.an, ...params.ap]) {
        if (differsByInteger(aj, bh, tolBits)) {
          return {
            coalescent: true,
            reason:
              "an `a` parameter is integer-spaced from a `bm` parameter " +
              "(inner-pFq parameter-pole risk)",
            clusterSize: 1,
          };
        }
      }
    }
    return { coalescent: false, reason: "", clusterSize: 1 };
  }
  // Series 2 mirror.
  const clusterSize = largestIntegerSpacedClusterSize(params.an, tolBits);
  if (hasIntegerSpacedPair(params.an, tolBits)) {
    return {
      coalescent: true,
      reason:
        clusterSize >= 3
          ? `≥${clusterSize} \`an\` parameters lie in the same integer-spacing equivalence class`
          : "two `an` parameters differ by an integer",
      clusterSize,
    };
  }
  for (const ah of params.an) {
    for (const aj of params.ap) {
      if (differsByInteger(ah, aj, tolBits)) {
        return {
          coalescent: true,
          reason: "an `an` parameter is integer-spaced from an `ap` parameter",
          clusterSize: 1,
        };
      }
    }
  }
  for (const ah of params.an) {
    for (const bj of [...params.bm, ...params.bq]) {
      if (differsByInteger(ah, bj, tolBits)) {
        return {
          coalescent: true,
          reason:
            "a `b` parameter is integer-spaced from an `an` parameter " +
            "(inner-pFq parameter-pole risk)",
          clusterSize: 1,
        };
      }
    }
  }
  return { coalescent: false, reason: "", clusterSize: 1 };
}

// -----------------------------------------------------------------------------
// Perturbation
// -----------------------------------------------------------------------------

/**
 * Apply Johansson's deterministic odd-coefficient perturbation:
 *
 *     params'_i ← params_i + (2·i + 1) · 2^{-pertBits}
 *
 * with the global counter `i` running across `(an, ap, bm, bq)` in
 * declaration order. Returns a fresh `MeijerGParameters` value; the
 * input is not mutated.
 *
 * @param pertBits           Bit-magnitude of the perturbation; the
 *                       perturbation lives at the `2^{-pertBits}` scale.
 * @param workingBits    Working precision in bits used to materialise
 *                       the perturbed values.
 */
export function perturbParameters(
  params: MeijerGParameters,
  pertBits: number,
  workingBits: number,
): MeijerGParameters {
  const counter = { i: 0 };
  return {
    an: params.an.map((p) => perturbOne(p, nextDelta(counter, pertBits, workingBits))),
    ap: params.ap.map((p) => perturbOne(p, nextDelta(counter, pertBits, workingBits))),
    bm: params.bm.map((p) => perturbOne(p, nextDelta(counter, pertBits, workingBits))),
    bq: params.bq.map((p) => perturbOne(p, nextDelta(counter, pertBits, workingBits))),
  };
}

function nextDelta(
  counter: { i: number },
  pertBits: number,
  workingBits: number,
): BigFloat {
  const i = counter.i++;
  const coeff = BigInt(2 * i + 1);
  // δ = coeff · 2^{-pertBits}  =  fromInt(coeff) · 2^{-pertBits}.
  // We materialise it directly: mantissa = coeff, exponent = -pertBits,
  // then normalise to the target precision.
  return normalise(coeff, -pertBits, workingBits);
}

function perturbOne(z: BigComplex, delta: BigFloat): BigComplex {
  const work = Math.max(z.re.precision, delta.precision);
  return {
    re: add(z.re, delta, work),
    im: z.im,
  };
}

// -----------------------------------------------------------------------------
// Magnitude diagnostics (used by the orchestrator)
// -----------------------------------------------------------------------------

/**
 * Compute `log2 |z|` to integer precision (the bit-position of the
 * leading non-zero bit). Returns `-Infinity` for the zero complex.
 *
 * Convenience wrapper duplicating `cmagBits` from
 * `@workbench/hypergeometric` to avoid a backwards dependency edge.
 */
export function magBitsOfComplex(z: BigComplex, workPrec: number): number {
  if (isZero(z.re) && isZero(z.im)) return -Infinity;
  const a = cabs(z, workPrec);
  if (isZero(a)) return -Infinity;
  return a.exponent + a.precision;
}

/** Symmetric wrapper for a real `BigFloat`. */
export function magBitsOfReal(x: BigFloat): number {
  if (isZero(x)) return -Infinity;
  const ax = abs(x);
  return ax.exponent + ax.precision;
}

// -----------------------------------------------------------------------------
// Sign helper (re-exported for the slater orchestrator)
// -----------------------------------------------------------------------------

export { sgn };
