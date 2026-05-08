// =============================================================================
// @workbench/meijer-core — public types
// =============================================================================
//
// The Meijer G-function in the parameter convention used by Slater 1966
// and Wolfram `MeijerG`:
//
//     G^{m,n}_{p,q}\!\Big(\!\begin{array}{c}a_1,…,a_p\\ b_1,…,b_q\end{array}\Big| z\Big)
//
// where the upper parameters `(a_1,…,a_p)` and lower parameters
// `(b_1,…,b_q)` split into named sub-tuples by their role in the
// Mellin-Barnes integrand:
//
//   `an` ≡ (a_1,…,a_n)        — upper params with `Γ(1 - a_j + s)` factors;
//   `ap` ≡ (a_{n+1},…,a_p)    — upper params with `Γ(a_j - s)` factors
//                               (denominator side);
//   `bm` ≡ (b_1,…,b_m)        — lower params with `Γ(b_j - s)` factors
//                               (numerator side, source of the Series-1 poles);
//   `bq` ≡ (b_{m+1},…,b_q)    — lower params with `Γ(1 - b_j + s)` factors
//                               (denominator side).
//
// The (m, n, p, q) integers are recovered from the lengths of the four
// arrays: `m = bm.length`, `n = an.length`, `p = an.length + ap.length`,
// `q = bm.length + bq.length`. Input validity requires `0 ≤ m ≤ q` and
// `0 ≤ n ≤ p`, both implied by the array layout.

import type { BigComplex } from "@workbench/bigfloat";

/**
 * Parameters of `G^{m,n}_{p,q}` in the four-tuple split.
 *
 * Order within each sub-tuple is preserved verbatim (the residue
 * formulas reference parameters by index). Reordering within `an` or
 * `bm` is mathematically harmless — those products are symmetric — but
 * we don't normalise on input because the caller's order is sometimes
 * meaningful (e.g., for diagnostics, coalescence reporting).
 */
export interface MeijerGParameters {
  readonly an: readonly BigComplex[];
  readonly ap: readonly BigComplex[];
  readonly bm: readonly BigComplex[];
  readonly bq: readonly BigComplex[];
}

/** Which Slater series was used (or forced). */
export type SeriesChoice = 1 | 2;

/**
 * Options for `meijergSlater`.
 */
export interface MeijerGSlaterOptions {
  /**
   * Override the (p, q, m, n, |z|)-driven series-selection rule.
   * Useful for the self-test that the two series agree where both
   * converge.
   */
  readonly forceSeries?: SeriesChoice;

  /**
   * The "quarantine band" around `|z| = 1` in the awkward case
   * `p == q ∧ m + n == p`, where neither Slater series converges to
   * within the inner-pFq's accepted region. Inputs with `|z|` in
   * `[lo, hi]` short-circuit to a structured refusal that the caller
   * can route to the contour-integration layer.
   *
   * Default: `[0.99, 1/0.99]` — sized to the inner-pFq's refusal
   * threshold so that any `|z|` admitting either series's inner
   * argument lands as a Slater success rather than a downstream
   * pFq-non-convergent surprise.
   */
  readonly quarantineBand?: readonly [number, number];

  /**
   * Cap on outer cancellation-driven precision-bump retries. Default 4.
   * Each retry doubles the working precision; the default lets us
   * control up to ~`64 · 2^4 = 1024` extra bits of cancellation.
   */
  readonly maxRetries?: number;

  /**
   * Force the perturbation path on or off. Default: `"auto"`, meaning
   * apply Johansson `hmag` perturbation iff coalescence is detected
   * among the residue-line parameters. `"always"` is useful for
   * regression tests (forces the perturbation path even on
   * non-coalescent inputs); `"never"` lets the caller see the raw
   * parameter-pole refusal.
   */
  readonly perturbation?: "auto" | "always" | "never";
}

/** Successful evaluation. */
export interface MeijerGSlaterSuccess {
  readonly status: "success";
  readonly value: BigComplex;
  readonly achievedPrecision: number;
  readonly method: "slater-series-1" | "slater-series-2";
  /** Total number of inner-pFq summands across all residue lines. */
  readonly seriesTerms: number;
  /** Whether Johansson `hmag` perturbation was applied. */
  readonly perturbationApplied: boolean;
  /**
   * Decimal digits of cancellation observed between the residue terms.
   * When this approaches the working precision the answer's accuracy
   * is reduced; the outer driver retries at higher working precision
   * to absorb the loss before returning.
   */
  readonly cancellationDigitsLost: number;
  readonly workingPrecision: number;
  readonly warnings: readonly string[];
}

/** Structured refusal — emit as a `tagged` value at the wire boundary. */
export interface MeijerGSlaterRefusal {
  readonly status:
    | "quarantine-band"
    | "no-convergent-series"
    | "non-convergent-pfq"
    | "input-error";
  readonly reason: string;
  /** When the inner pFq itself refused, surface its reason verbatim. */
  readonly innerReason?: string;
}

export type MeijerGSlaterResult =
  | MeijerGSlaterSuccess
  | MeijerGSlaterRefusal;
