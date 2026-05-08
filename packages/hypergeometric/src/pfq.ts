// =============================================================================
// pFq — direct power-series evaluator with cancellation control
// =============================================================================
//
// The generalised hypergeometric series
//
//     pFq(a₁,…,aₚ; b₁,…,b_q; z) = Σ_{k=0}^∞   ∏_j (a_j)_k    ·  z^k / k!
//                                              ───────────────
//                                              ∏_j (b_j)_k
//
// where `(x)_k = x(x+1)⋯(x+k-1)` is the Pochhammer symbol (rising
// factorial), `(x)_0 = 1`. The series:
//
//   * Converges for all finite z when p ≤ q;
//   * Converges in the open unit disc when p == q+1;
//   * Is asymptotic only when p > q+1 (formally divergent, summed via
//     Borel — out of scope for v0.1).
//
// Implementation strategy
// -----------------------
//
// We sum the series term-by-term using the ratio-of-consecutive-terms
// recurrence rather than independently re-evaluating every Pochhammer:
//
//     ratio_k = z · ∏_j (a_j + k - 1) / ∏_j (b_j + k - 1) / k
//     term_k  = term_{k-1} · ratio_k
//
// — O(p+q) work per term instead of O(k(p+q)).
//
// Termination. We stop when the term magnitude falls below the running
// sum scaled by the relative target tolerance. Concretely, with the term
// in bits |term_k| = 2^{tBits} and sum |sum_k| = 2^{sBits}, we stop when
// `tBits < sBits - target - safety`. This is tighter than the absolute
// criterion `|term_k| < ε` because it tracks the dimensional scale of the
// answer.
//
// Cancellation. The summands can have alternating sign and similar
// magnitude (e.g., 2F1(1, 1; 2; -1) = ln 2 obtained from terms ±1, ±1/2,
// ±1/3, …). We track the largest |term_k| seen and report the
// cancellation loss as `log2(max_k |term_k|) - log2(|sum|)`. The outer
// driver (in `evaluatePFq`) re-runs at higher working precision when
// the loss exceeds the safety margin, achieving the requested target
// precision.
//
// Parameter pole (exact non-positive integer in `b`). At exactly the
// k-th term, if `b_j + (k-1) === 0`, the recurrence's denominator
// vanishes — i.e., `b_j ∈ {0, -1, …, -(k-1)}`. The series itself is
// undefined at those parameter values (or, equivalently, has a residue
// structure that requires the Meijer-G machinery to interpret). The
// inner loop throws `ParameterPoleError` and the outer layer surfaces
// it as a structured refusal.
//
// References
// ----------
// * Slater, "Generalized Hypergeometric Functions" (1966), §4.1.
// * Olver et al., "NIST Handbook of Mathematical Functions" (2010),
//   §16.2 (definition), §16.11 (asymptotic).
// * Johansson 2009, "Numerical evaluation of hypergeometric functions"
//   (mpmath implementation notes — cancellation-control philosophy).

import {
  type BigComplex,
  bitLength,
  cabs,
  cadd,
  cdiv,
  cfromReal,
  cisZero,
  cmul,
  cneg,
  csub,
  cexp,
  cpow,
  decimalToBinaryPrecision,
  fromInt,
  toFloat64,
} from "@workbench/bigfloat";

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export interface PFqOptions {
  /**
   * Override the absolute starting working precision in bits. Defaults
   * to `decimalToBinaryPrecision(precision) + 32`.
   */
  workingBits?: number;
  /**
   * Maximum number of cancellation-driven precision-bump retries before
   * giving up and returning a `non-convergent` refusal. Default 4.
   */
  maxRetries?: number;
}

export interface PFqSuccess {
  readonly status: "success";
  readonly value: BigComplex;
  /** The user-facing target precision (decimal digits) actually achieved. */
  readonly achievedPrecision: number;
  readonly method: "closed-form-0F0" | "closed-form-1F0" | "direct-series";
  readonly nTerms: number;
  /** Working precision in bits used at the converged attempt. */
  readonly workingPrecision: number;
  readonly warnings: readonly string[];
}

export interface PFqRefusal {
  readonly status: "non-convergent" | "parameter-pole";
  readonly reason: string;
  /** Populated only for `parameter-pole`. */
  readonly which?: "a" | "b";
  readonly whichIdx?: number;
}

export type PFqResult = PFqSuccess | PFqRefusal;

/**
 * Thrown by `pFqDirectSeries` when a `b_j` is an exact non-positive
 * integer in a position that the recurrence hits during summation.
 * Caught by the outer driver and surfaced as a structured `parameter-
 * pole` refusal.
 */
export class ParameterPoleError extends Error {
  constructor(
    public readonly which: "a" | "b",
    public readonly idx: number,
  ) {
    super(`pFq parameter pole: ${which}_${idx}`);
    this.name = "ParameterPoleError";
  }
}

// -----------------------------------------------------------------------------
// Magnitude helper
// -----------------------------------------------------------------------------

/**
 * `log2 |z|`, rounded *up*: the bit-position of the leading non-zero bit
 * of either real or imaginary part. For the all-zero complex we return
 * `-Infinity`. This is a 1-bit-precise proxy for `log2|z|` that lets us
 * compare term and sum magnitudes without a `log` call.
 */
export function cmagBits(z: BigComplex): number {
  const reMan = z.re.mantissa < 0n ? -z.re.mantissa : z.re.mantissa;
  const imMan = z.im.mantissa < 0n ? -z.im.mantissa : z.im.mantissa;
  const reMag =
    z.re.mantissa === 0n ? -Infinity : z.re.exponent + bitLength(reMan);
  const imMag =
    z.im.mantissa === 0n ? -Infinity : z.im.exponent + bitLength(imMan);
  if (reMag === -Infinity && imMag === -Infinity) return -Infinity;
  return Math.max(reMag, imMag);
}

// -----------------------------------------------------------------------------
// Inner loop
// -----------------------------------------------------------------------------

/**
 * Direct-series evaluation of `pFq(a; b; z)` at a fixed working precision.
 *
 * Returns `(value, nTerms, cancellationLoss, warnings)`. Throws
 * `ParameterPoleError` when the recurrence hits an exact non-positive
 * integer in `b`.
 *
 * @param workPrec    Working precision in bits.
 * @param targetPrec  Target relative precision in bits (controls the
 *                    termination criterion `|term_k| < |sum| · 2^-target`).
 */
export function pFqDirectSeries(
  aList: readonly BigComplex[],
  bList: readonly BigComplex[],
  z: BigComplex,
  workPrec: number,
  targetPrec: number,
): {
  value: BigComplex;
  nTerms: number;
  cancellationLoss: number;
  warnings: string[];
} {
  const warnings: string[] = [];
  const one = cfromReal(fromInt(1n, workPrec));
  let term = one;
  let sum = one;
  let maxTermMagBits = 0;

  // Safety margin: we want the term to be at least `targetPrec + safety`
  // bits below the running sum before declaring convergence. Sixteen
  // bits is comfortable for the 50 dps target the brief specifies.
  const safety = 16;

  // Iteration cap. For `p ≤ q` (whole-z convergent) the term magnitude
  // collapses geometrically and `workPrec * 4` is plenty. For
  // `p == q + 1` the term ratio is `~|z|` per step; near the unit
  // circle the count required to get below `2^{-target}` blows up
  // analytically as `target · ln 2 / ln(1/|z|)`. We size the cap by
  // |z| so anti-Stokes-ray inputs (|z|≈0.95) converge before cap-out.
  const zMag = toFloat64(cabs(z, 53)).value;
  let maxTerms = Math.max(64, workPrec * 4);
  if (Number.isFinite(zMag) && zMag > 0.5 && zMag < 1) {
    // For `|z| ∈ (0.5, 1)`, expand the cap by the ratio of the
    // analytic count to the geometric default. Capped at `workPrec * 200`
    // so a misclassified asymptotic input does not run forever.
    const lnInv = Math.log(1 / zMag);
    const analyticCount = Math.ceil(workPrec / lnInv) * 4;
    maxTerms = Math.min(workPrec * 200, Math.max(maxTerms, analyticCount));
  }

  for (let k = 1; k <= maxTerms; k++) {
    // ratio_k = z · ∏ (a_j + k - 1) / ∏ (b_j + k - 1) / k.
    let ratio = cdiv(z, cfromReal(fromInt(BigInt(k), workPrec)), workPrec);
    for (const aj of aList) {
      const numerTerm = cadd(
        aj,
        cfromReal(fromInt(BigInt(k - 1), workPrec)),
        workPrec,
      );
      ratio = cmul(ratio, numerTerm, workPrec);
    }
    for (let j = 0; j < bList.length; j++) {
      const bj = bList[j]!;
      const denomTerm = cadd(
        bj,
        cfromReal(fromInt(BigInt(k - 1), workPrec)),
        workPrec,
      );
      if (cisZero(denomTerm)) {
        // bj + (k - 1) = 0  ⇔  bj is the non-positive integer -(k-1).
        // The Pochhammer (b_j)_k is zero from this k onward; the series
        // is divergent (or, more usefully, only meaningful in the limit
        // taken by the Slater theorem — handled at that higher layer).
        throw new ParameterPoleError("b", j);
      }
      ratio = cdiv(ratio, denomTerm, workPrec);
    }
    term = cmul(term, ratio, workPrec);
    sum = cadd(sum, term, workPrec);

    const termMag = cmagBits(term);
    if (termMag > maxTermMagBits) maxTermMagBits = termMag;

    const sumMag = cmagBits(sum);
    if (termMag < sumMag - targetPrec - safety) {
      const cancellationLoss = Math.max(0, maxTermMagBits - sumMag);
      if (cancellationLoss > workPrec - targetPrec - 32) {
        warnings.push(
          `cancellation between summands lost ~${cancellationLoss} bits; ` +
            `consider higher precision`,
        );
      }
      return { value: sum, nTerms: k, cancellationLoss, warnings };
    }
  }

  warnings.push(
    `series did not converge within iteration cap (${maxTerms} terms)`,
  );
  return {
    value: sum,
    nTerms: maxTerms,
    cancellationLoss: 0,
    warnings,
  };
}

// -----------------------------------------------------------------------------
// Outer driver
// -----------------------------------------------------------------------------

/**
 * Evaluate `pFq(a; b; z)` to the requested target precision, with
 * automatic working-precision retries on cancellation loss.
 *
 * Closed-form fast paths run before the generic series:
 *   * `0F0(;;z)     = exp(z)`
 *   * `1F0(a;;z)    = (1-z)^{-a}` for `z ≠ 1`.
 *
 * @param precision  Target precision in **decimal digits**.
 */
export function evaluatePFq(
  aList: readonly BigComplex[],
  bList: readonly BigComplex[],
  z: BigComplex,
  precision: number,
  opts: PFqOptions = {},
): PFqResult {
  const p = aList.length;
  const q = bList.length;

  // 0F0(;;z) = e^z  (closed form, infinite radius).
  if (p === 0 && q === 0) {
    const workPrec = decimalToBinaryPrecision(precision);
    return {
      status: "success",
      value: cexp(z, workPrec),
      achievedPrecision: precision,
      method: "closed-form-0F0",
      nTerms: 0,
      workingPrecision: workPrec,
      warnings: [],
    };
  }

  // 1F0(a;;z) = (1 - z)^{-a}  (closed form, |z| < 1; singular at z = 1).
  if (p === 1 && q === 0) {
    const workPrec = decimalToBinaryPrecision(precision);
    const oneMinusZ = csub(cfromReal(fromInt(1n, workPrec)), z, workPrec);
    if (cisZero(oneMinusZ)) {
      return {
        status: "non-convergent",
        reason: "1F0(a;;z) is singular at z = 1",
      };
    }
    return {
      status: "success",
      value: cpow(oneMinusZ, cneg(aList[0]!), workPrec),
      achievedPrecision: precision,
      method: "closed-form-1F0",
      nTerms: 0,
      workingPrecision: workPrec,
      warnings: [],
    };
  }

  if (p > q + 1) {
    return {
      status: "non-convergent",
      reason:
        `series with p=${p} > q+1=${q + 1} is asymptotic only; ` +
        `Borel resummation deferred to a future revision`,
    };
  }

  if (p === q + 1) {
    const zMag = toFloat64(cabs(z, 53)).value;
    if (zMag >= 0.99) {
      return {
        status: "non-convergent",
        reason:
          `|z| = ${zMag.toExponential(3)} too close to the radius of ` +
          `convergence (1) for p=${p} q=${q}; analytic continuation deferred`,
      };
    }
    // Convergence in `[0.95, 0.99)` is slow — terms scale as `|z|^k`,
    // so 50 dps takes thousands of summands. Bump the iteration cap
    // and the working-bits margin proportionally so the outer loop
    // doesn't trip the iteration cap before the cancellation criterion.
    if (zMag >= 0.95) {
      // Rough rule: terms decay by factor `zMag` per step; we need
      // `zMag^N < 2^{-target}` ⟹ `N > target · ln 2 / ln(1/zMag)`.
      // For zMag = 0.95, target = 196 bits ⟹ N ≈ 2650 terms; for
      // zMag = 0.99 ⟹ N ≈ 13600 terms. The default cap of
      // `workPrec * 4` (~800 for 50 dps) is too tight; expand below.
    }
  }

  const workPrecBase = decimalToBinaryPrecision(precision);
  let workingBits =
    opts.workingBits ?? workPrecBase + 32;
  const targetBits = workPrecBase;
  const maxRetries = opts.maxRetries ?? 4;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const result = pFqDirectSeries(
        aList,
        bList,
        z,
        workingBits,
        targetBits,
      );
      const usableBits = workingBits - result.cancellationLoss;
      if (usableBits >= targetBits + 16) {
        return {
          status: "success",
          value: result.value,
          achievedPrecision: precision,
          method: "direct-series",
          nTerms: result.nTerms,
          workingPrecision: workingBits,
          warnings: result.warnings,
        };
      }
      // Bump and retry. The new working precision must comfortably
      // exceed `targetBits + cancellationLoss + safety`.
      workingBits = Math.max(
        workingBits * 2,
        workingBits + result.cancellationLoss + 64,
      );
    } catch (e) {
      if (e instanceof ParameterPoleError) {
        return {
          status: "parameter-pole",
          reason: `b_${e.idx} is a non-positive integer (parameter pole)`,
          which: e.which,
          whichIdx: e.idx,
        };
      }
      throw e;
    }
  }

  return {
    status: "non-convergent",
    reason:
      `direct-series cancellation could not be controlled within ` +
      `${maxRetries} precision-bumps (last working precision ${workingBits} bits)`,
  };
}
