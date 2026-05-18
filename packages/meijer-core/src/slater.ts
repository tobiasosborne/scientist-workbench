// =============================================================================
// Slater orchestrator — series choice + perturbation + cancellation control
// =============================================================================
//
// `meijergSlater(params, z, precision, opts)` is the package's public
// entry point. It reads the parameters and target precision, applies
// the (p, q, m, n, |z|) series-selection rule, detects integer-spaced
// coalescence in the residue-line parameters, optionally applies the
// deterministic bit-magnitude perturbation (Johansson 2009 blog post),
// runs the chosen Slater series at an inflated working precision, and
// retries with progressively higher working precision when summation
// cancellation between the residue terms exceeds the safety margin.
//
// Return shape — `MeijerGSlaterResult` — is either a `success` record
// with the value plus diagnostics (working precision actually used,
// total inner-pFq summands, cancellation digits lost, whether
// perturbation was applied, warnings) or a structured refusal:
//
//   * `quarantine-band`             |z|≈1 ∧ p=q ∧ m+n=p — neither series
//                                   converges at the contour boundary;
//                                   caller routes to layer-13e contour
//                                   quadrature.
//   * `no-convergent-series`        The chosen series's inner pFq itself
//                                   lies in a non-convergent regime that
//                                   this v0.1 doesn't handle (e.g. Borel
//                                   region).
//   * `non-convergent-pfq`          A ParameterPoleError or non-convergence
//                                   survived all retries even after
//                                   perturbation.
//   * `coalescence-budget-exhausted`  Hard `maxWorkingBits` budget reached
//                                   while still chasing cancellation
//                                   bumps; bead `scientist-workbench-fwsz`
//                                   for the 3+ pole integer-spaced case.
//                                   The dispatcher's caller reads this as
//                                   "this regime needs the higher-order
//                                   closed-form residue (Slater 1966 §5
//                                   `digamma`/`polygamma` formula); v0.1
//                                   doesn't have it".
//   * `input-error`                 The (an, ap, bm, bq) split was
//                                   invalid (e.g. `m == 0 ∧ n == 0` —
//                                   neither series has poles to close).
//
// Working-precision discipline
// ----------------------------
// We work in *bits* internally; `precision` (decimal digits) is the
// user dial. Each inner-pFq call receives the same target precision
// in decimal digits, computed from the current bit-budget.
//
// Initial working bits = `decimalToBinaryPrecision(precision) +
// extra_for_coalescence`, where `extra_for_coalescence` is `64` if no
// coalescence was detected and `2 · target_bits` otherwise (the
// classical `working = 2·target + spare` discipline that absorbs the
// half-precision perturbation).
//
// On retry, working bits doubles up to `maxRetries` times **and** is
// capped by `maxWorkingBits` (default `12 · target_bits + 256`).
// Hitting the cap surfaces `coalescence-budget-exhausted` rather
// than running indefinitely (bead `fwsz`).
//
// Empirical precision estimator (bead `scientist-workbench-7usr`)
// ---------------------------------------------------------------
// When perturbation fires, the simple-pole formula is being treated
// as the `(ε_i − ε_j) → 0` L'Hôpital limit.  The closed-form bound
// on this limit's residual (and on the floating-point cancellation
// noise that survives at finite working precision) is fragile.  The
// honest path: re-run the evaluation at a *different* perturbation
// magnitude — `pertBits + 16` (i.e. ε halved 16 times, ~5 dps
// smaller).  The two answers should agree to whatever precision the
// L'Hôpital limit + cancellation noise actually delivers.  We compute
//
//     achievedPrecision_empirical
//       = floor( -log10( |Δ| / max(|S|, 2^{-targetBits}) ) - 1 )
//
// where `Δ = S_pertBits - S_pertBits+16`, `S = S_pertBits`, and the
// floor of `precision_empirical` is what we report.  This is the
// honesty contract from ADR-0007 / ADR-0027 §4: a tool that lies
// about its precision is inadmissible regardless of correctness.
//
// The cost: one extra residue-summation pass when perturbation is
// applied (no cost on the non-coalescent fast path).  For the
// pathological 3-pole case the second pass also fails to converge,
// so the cap is the load-bearing termination mechanism — but the
// estimator runs *first*, and if both passes succeed we get an
// honest precision figure.

import {
  type BigComplex,
  cadd,
  cfromReal,
  csub,
  decimalToBinaryPrecision,
  fromInt,
} from "@workbench/bigfloat";
import { cmagBits } from "@workbench/hypergeometric";
import {
  detectCoalescence,
  perturbParameters,
} from "./coalescence.js";
import { selectSeries } from "./series-select.js";
import {
  evaluateSeries1,
  evaluateSeries2,
  type ResidueTerm,
} from "./series.js";
import type {
  MeijerGParameters,
  MeijerGSlaterOptions,
  MeijerGSlaterResult,
} from "./types.js";

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

/** Convert a positive bit-precision to the smallest decimal-digit count
 *  that maps back to at least that many bits via
 *  `decimalToBinaryPrecision`. The +30 safety margin in
 *  `decimalToBinaryPrecision` means a small constant suffices. */
function bitsToDecimal(bits: number): number {
  // bits = ceil(decimal · 3.32193) + 30  ⟹  decimal ≥ (bits - 30) / 3.32193.
  // We round up and add 1 for safety.
  return Math.max(1, Math.ceil((bits - 30) / 3.32192809488736) + 1);
}

/**
 * Outcome of a single residue-summation pass at a fixed working
 * precision and (perturbed or non-perturbed) parameter set.
 * Internal-only — the orchestrator uses it to compose the cancellation-
 * bump retry, the empirical-precision estimator, and the eventual
 * external `MeijerGSlaterResult`.
 */
interface PassOutcome {
  readonly status: "success" | "needs-bump" | "refusal";
  /** Successful sum (only meaningful when status = success | needs-bump). */
  readonly sum?: BigComplex;
  /** Cancellation loss between residue terms, in bits. */
  readonly cancellationLossBits?: number;
  /** Total inner-pFq summands across all residue lines. */
  readonly totalNTerms?: number;
  /** Refusal carrier — non-empty iff status = "refusal". */
  readonly refusal?: MeijerGSlaterResult;
  /** Inner-pFq parameter-pole signal — caller should retry with perturbation. */
  readonly innerParameterPole?: boolean;
  /** Prefactor Γ-pole signal (RangeError caught) — same recovery as above. */
  readonly prefactorGammaPole?: boolean;
  /** Last error message captured for diagnostic (RangeError or pFq refusal). */
  readonly errorMessage?: string;
}

/**
 * Run one residue-summation pass at the given `(workingBits, perturb,
 * pertBits)` configuration.  Returns a `PassOutcome` capturing whether
 * the pass succeeded outright, needs a working-precision bump (the
 * cancellation-loss check failed), or refused (inner pFq parameter-pole,
 * prefactor Γ-pole, or non-convergent series).  The outer driver
 * composes these outcomes into the public `MeijerGSlaterResult`.
 *
 * The function is deterministic: same `(params, z, workingBits, perturb,
 * pertBits, series)` ⇒ same `PassOutcome` bytes.  The perturbation's
 * deterministic odd-coefficient pattern (coalescence.ts) is the
 * load-bearing piece for the `arbprec: true` contract.
 */
function runSlaterPass(
  params: MeijerGParameters,
  z: BigComplex,
  series: 1 | 2,
  workingBits: number,
  perturb: boolean,
  pertBits: number,
  targetBits: number,
): PassOutcome {
  const workingDecimal = bitsToDecimal(workingBits);
  const usedParams = perturb
    ? perturbParameters(params, pertBits, workingBits)
    : params;

  let terms: ResidueTerm[];
  try {
    terms =
      series === 1
        ? evaluateSeries1(usedParams, z, workingDecimal, workingBits)
        : evaluateSeries2(usedParams, z, workingDecimal, workingBits);
  } catch (e) {
    // RangeError ⇒ exact non-positive integer fed to a prefactor Γ.
    // Surface as a structured signal; the orchestrator decides whether
    // to retry with perturbation or refuse.
    const message = e instanceof Error ? e.message : String(e);
    if (e instanceof RangeError) {
      return {
        status: "refusal",
        prefactorGammaPole: true,
        errorMessage: message,
      };
    }
    return {
      status: "refusal",
      refusal: {
        status: "non-convergent-pfq",
        reason:
          `Slater prefactor evaluation failed at working precision ` +
          `${workingBits} bits (${message})`,
      },
      errorMessage: message,
    };
  }

  // Survey for inner-pFq refusals.
  for (const t of terms) {
    if (t.innerPFq.status !== "success") {
      const status = t.innerPFq.status;
      return {
        status: "refusal",
        innerParameterPole: status === "parameter-pole",
        refusal: {
          status: "non-convergent-pfq",
          reason: `inner pFq refused: ${t.innerPFq.reason}`,
          innerReason: t.innerPFq.reason,
        },
        errorMessage: t.innerPFq.reason,
      };
    }
  }

  // Sum residue lines, tracking max-term magnitude.
  let sum = cfromReal(fromInt(0n, workingBits));
  let maxTermMagBits = -Infinity;
  let totalNTerms = 0;
  for (const t of terms) {
    sum = cadd(sum, t.value, workingBits);
    const mag = cmagBits(t.value);
    if (mag > maxTermMagBits) maxTermMagBits = mag;
    totalNTerms += t.nTerms;
  }
  const sumMagBits = cmagBits(sum);

  let cancellationLossBits =
    maxTermMagBits === -Infinity || sumMagBits === -Infinity
      ? 0
      : Math.max(0, maxTermMagBits - sumMagBits);

  // Exact-zero sum: legitimate but ambiguous for cancellation accounting.
  // Treat as "all cancellation" and rely on the working budget to be
  // sufficient.
  if (sumMagBits === -Infinity && maxTermMagBits !== -Infinity) {
    cancellationLossBits = maxTermMagBits + targetBits + 64;
  }

  const usableBits = workingBits - cancellationLossBits;
  if (usableBits >= targetBits + 16) {
    return {
      status: "success",
      sum,
      cancellationLossBits,
      totalNTerms,
    };
  }
  return {
    status: "needs-bump",
    sum,
    cancellationLossBits,
    totalNTerms,
  };
}

/**
 * Empirical precision estimate from two evaluations at slightly
 * different perturbation magnitudes.  Returns the integer floor of
 * `-log10(|Δ| / max(|S|, 2^{-targetBits}))` minus a 1-digit safety
 * margin (so we under-report rather than over-report the precision —
 * the honesty contract favours conservative claims).
 *
 * The denominator clamp `max(|S|, 2^{-targetBits})` handles the
 * "result is exactly zero or anomalously tiny" edge case: we report
 * `targetBits` digits of agreement against an absolute floor rather
 * than dividing by a near-zero magnitude.  This matches the user
 * intuition that "agree to 50 dps relative" against a result of
 * magnitude `2^{-200}` is silly — if the L'Hôpital limit *is* small,
 * there's no relative precision to speak of, only absolute.
 *
 * Exported (not just internal) so the bead-`7usr` honesty contract can
 * be tested *directly* — feeding it two deliberately-disagreeing passes
 * and asserting it reports a low figure.  After the `oj5j` substrate fix
 * lifted the former half-integer-spaced low-precision witnesses to full
 * precision, this direct unit test is the load-bearing guard against
 * the estimator silently regressing into over-reporting (it would
 * otherwise need an end-to-end input that genuinely loses precision,
 * and none survives in the 2-pole regime post-`oj5j`).
 */
export function estimateAchievedPrecision(
  sumA: BigComplex,
  sumB: BigComplex,
  workingBits: number,
  targetBits: number,
  userPrecision: number,
): number {
  const delta = csub(sumA, sumB, workingBits);
  const deltaMagBits = cmagBits(delta);
  const sumMagBits = cmagBits(sumA);
  // Clamp the denominator at 2^{-targetBits} so a near-zero result
  // doesn't blow up the relative-precision figure.  (The absolute-
  // precision interpretation is "agree to within 2^{-targetBits} of
  // zero".)
  const denomMagBits =
    sumMagBits === -Infinity ? -targetBits : Math.max(sumMagBits, -targetBits);
  if (deltaMagBits === -Infinity) {
    // Two passes agreed bytewise — empirical precision is the full
    // working precision.  Cap at the user-requested precision.
    return userPrecision;
  }
  const relMagBits = deltaMagBits - denomMagBits;
  // Convert from bits to decimal: dps ≈ −relMagBits / log2(10).
  // 1-digit safety margin reflects the natural slop in the
  // finite-difference-vs-derivative estimator.
  const empiricalDps = Math.floor(-relMagBits / 3.32192809488736) - 1;
  if (empiricalDps < 0) return 0;
  return Math.min(empiricalDps, userPrecision);
}

// -----------------------------------------------------------------------------
// Public entry
// -----------------------------------------------------------------------------

export function meijergSlater(
  params: MeijerGParameters,
  z: BigComplex,
  precision: number,
  opts: MeijerGSlaterOptions = {},
): MeijerGSlaterResult {
  // ------------------------------------------------------------------ inputs
  if (!Number.isInteger(precision) || precision < 1) {
    return {
      status: "input-error",
      reason: `precision must be a positive integer; got ${precision}`,
    };
  }
  const m = params.bm.length;
  const n = params.an.length;
  if (m === 0 && n === 0) {
    return {
      status: "input-error",
      reason:
        "Slater path requires `m + n ≥ 1` (at least one Γ-pole line " +
        "to close the contour around); both `bm` and `an` are empty",
    };
  }

  // ------------------------------------------------------------------ select
  const selection = selectSeries(params, z, opts);
  if (selection.quarantine) {
    return {
      status: "quarantine-band",
      reason:
        `|z| = ${selection.zMag.toExponential(3)} sits in the ` +
        `quarantine band [${opts.quarantineBand?.[0] ?? 0.99}, ` +
        `${opts.quarantineBand?.[1] ?? 1.01}] for ` +
        `p = q = ${selection.p}, m + n = p; neither Slater series ` +
        `converges at this contour boundary`,
    };
  }
  const series = selection.series;
  const method = series === 1 ? "slater-series-1" : "slater-series-2";

  // -------------------------------------------------------- working precision
  const targetBits = decimalToBinaryPrecision(precision);
  const maxRetries = opts.maxRetries ?? 4;
  const maxWorkingBits = opts.maxWorkingBits ?? 12 * targetBits + 256;
  const perturbationMode = opts.perturbation ?? "auto";
  const estimatePrecision = opts.estimatePrecision ?? true;

  // Coalescence detection runs at the half-target tolerance — anything
  // closer than that to integer-spacing is "indistinguishably close"
  // for our target precision, and the perturbation path is correct.
  const coalescenceTolBits = Math.floor(targetBits / 2);
  const coalescence = detectCoalescence(params, series, coalescenceTolBits);

  // Upfront refusal for ≥3-pole integer-spaced coalescence (bead
  // `scientist-workbench-fwsz`).  The Johansson odd-coefficient
  // perturbation breaks pairwise coalescence cleanly, but its
  // cancellation cost grows super-quadratically with cluster size:
  // every pair `(b_i, b_j)` with `b_i − b_j ∈ ℤ` contributes a
  // near-singular `Γ(b_i − b_j + δ)` factor of magnitude `~1/δ`, and
  // the residue-term magnitude grows as `1/δ^{C-1}` where `C` is the
  // cluster size.  At `C = 3` the cancellation is `~3 · pertBits` —
  // the standard `wb = 2·target + 64` discipline runs out of bits, and
  // doubling the working-bits budget repeatedly grows linearly in
  // cluster size while inner-pFq cost grows polynomially.  The honest
  // path for `C ≥ 3` is the closed-form `digamma`/`polygamma`
  // higher-order residue (Slater 1966 §5; Bateman §5.6); v0.1 ships
  // the structured refusal as a placeholder.  When the closed-form
  // path lands, this gate becomes a no-op.
  if (
    coalescence.clusterSize >= 3 &&
    perturbationMode !== "never"
  ) {
    return {
      status: "coalescence-needs-higher-order-residue",
      reason:
        `${coalescence.clusterSize} ${series === 1 ? "`bm`" : "`an`"} parameters lie in the ` +
        `same integer-spacing equivalence class.  The Johansson odd-coefficient ` +
        `perturbation handles 2-pole pairs cleanly, but ≥3-pole clusters require ` +
        `the higher-order Slater 1966 §5 closed-form residue (digamma/polygamma) ` +
        `which v0.1 does not implement.  See bead scientist-workbench-fwsz.`,
    };
  }

  let perturb = false;
  if (perturbationMode === "always") perturb = true;
  else if (perturbationMode === "auto" && coalescence.coalescent) perturb = true;

  // Initial working budget: target + slack for non-coalescent, double-
  // target + slack for coalescent (the classical "working = 2·target +
  // spare" discipline).
  let workingBits = perturb ? 2 * targetBits + 64 : targetBits + 64;

  // ---------------------------------------------------------------- retry loop
  const warnings: string[] = [];
  if (coalescence.coalescent) {
    warnings.push(`coalescence detected: ${coalescence.reason}`);
  }

  // Last successful pass (kept across retries so we can report a
  // best-effort result if the cap is hit).  Undefined on first iteration.
  let lastSuccess:
    | {
        sum: BigComplex;
        cancellationLossBits: number;
        totalNTerms: number;
        workingBits: number;
        pertBits: number;
      }
    | undefined;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    // Hard cap: if we've already exceeded the budget on this attempt's
    // workingBits, refuse rather than churn further (bead `fwsz`).
    if (workingBits > maxWorkingBits) {
      return {
        status: "coalescence-budget-exhausted",
        reason:
          `Slater cancellation-bump retry would exceed maxWorkingBits = ${maxWorkingBits} ` +
          `(attempt ${attempt + 1} would run at ${workingBits} bits); the residue terms cancel ` +
          `faster than the perturbation budget can absorb. This typically indicates ` +
          `${m >= 3 || n >= 3 ? "≥3-pole integer-spaced coalescence — the higher-order Slater 1966 §5 closed-form residue (digamma/polygamma) is needed" : "a coalescence pattern beyond the v0.1 perturbation regime"}.`,
      };
    }

    const pertBits = perturb ? Math.floor(workingBits / 2) : 0;
    const pass = runSlaterPass(
      params,
      z,
      series,
      workingBits,
      perturb,
      pertBits,
      targetBits,
    );

    if (pass.status === "refusal") {
      // RangeError or inner-pFq parameter-pole — try perturbation if
      // we weren't already, otherwise surface the structured refusal.
      if (
        (pass.prefactorGammaPole || pass.innerParameterPole) &&
        !perturb &&
        perturbationMode !== "never"
      ) {
        perturb = true;
        workingBits = 2 * targetBits + 64;
        warnings.push(
          pass.prefactorGammaPole
            ? `recovering from prefactor Γ-pole via perturbation (caught: ${pass.errorMessage})`
            : `recovering from inner-pFq parameter-pole via perturbation`,
        );
        continue;
      }
      return (
        pass.refusal ?? {
          status: "non-convergent-pfq",
          reason: `Slater pass refused: ${pass.errorMessage ?? "unknown"}`,
        }
      );
    }

    // Both `success` and `needs-bump` carry a `sum` and bookkeeping;
    // the only difference is whether we declare convergence now or
    // bump and retry.
    if (pass.status === "success") {
      // Empirical precision estimator (bead `7usr`).  Only runs in the
      // perturbation path — the non-perturbed path already trusts the
      // working-precision bookkeeping (no L'Hôpital approximation, no
      // hidden parameter-perturbation noise).
      let achievedPrecision = precision;
      if (perturb && estimatePrecision) {
        // Run a second pass at a *minimally* smaller perturbation
        // (`pertBits + 1`, i.e. ε halved exactly once).  The two
        // answers should agree to whatever precision the L'Hôpital
        // limit + arithmetic cancellation actually delivers.  The
        // difference's leading order is the L'Hôpital first-derivative
        // term `~ε · kernel'(params)`, which closely tracks the
        // dominant precision-loss mechanism in the perturbation
        // path (bead `scientist-workbench-7usr`).
        //
        // Why `+1` and not `+16`: a larger offset also halves the
        // residue-term magnitude (`|Γ(small)| ∼ 1/ε`), which can push
        // the alt pass past the cancellation-bump threshold.  The
        // smallest meaningful perturbation change keeps both passes
        // at the same working-bits regime so `Δ` reflects the
        // perturbation-induced error, not a working-bits crossing.
        const altPertBits = pertBits + 1;
        const altPass = runSlaterPass(
          params,
          z,
          series,
          workingBits,
          /*perturb=*/ true,
          altPertBits,
          targetBits,
        );
        if (
          (altPass.status === "success" || altPass.status === "needs-bump") &&
          altPass.sum !== undefined
        ) {
          const empirical = estimateAchievedPrecision(
            pass.sum!,
            altPass.sum,
            workingBits,
            targetBits,
            precision,
          );
          if (empirical < precision) {
            warnings.push(
              `empirical precision estimator (perturbation L'Hôpital + cancellation noise): ` +
                `${empirical} dps achievable vs ${precision} requested`,
            );
            achievedPrecision = empirical;
          }
        } else if (altPass.status === "refusal") {
          // Alt pass refused outright — the estimator is inconclusive.
          // Honest fallback: keep the user-requested precision but
          // attach a diagnostic warning so downstream consumers know
          // the precision figure is unverified by the second pass.
          warnings.push(
            `empirical precision estimator inconclusive: alt-perturbation pass refused ` +
              `(${altPass.errorMessage ?? "unknown"}); reported precision unverified`,
          );
        }
      }

      return {
        status: "success",
        value: pass.sum!,
        achievedPrecision,
        method,
        seriesTerms: pass.totalNTerms!,
        perturbationApplied: perturb,
        cancellationDigitsLost: bitsToDecimal(pass.cancellationLossBits!),
        workingPrecision: workingBits,
        warnings,
      };
    }

    // status === "needs-bump"
    lastSuccess = {
      sum: pass.sum!,
      cancellationLossBits: pass.cancellationLossBits!,
      totalNTerms: pass.totalNTerms!,
      workingBits,
      pertBits,
    };
    warnings.push(
      `working precision ${workingBits} bits insufficient ` +
        `(cancellation lost ${pass.cancellationLossBits} bits); doubling`,
    );
    workingBits = Math.max(
      workingBits * 2,
      workingBits + pass.cancellationLossBits! + 96,
    );
  }

  // Retry loop exhausted without convergence.  If we did succeed at
  // *some* attempt (i.e. `lastSuccess` is set), the final maxRetries
  // attempt's `needs-bump` status means the convergence gate was never
  // crossed.  We surface this as `non-convergent-pfq` — the caller's
  // perspective is "Slater path could not converge" regardless of
  // whether the bottleneck was inner pFq, cancellation, or the budget
  // cap.
  void lastSuccess; // diagnostic only — current contract surfaces refusal.
  return {
    status: "non-convergent-pfq",
    reason:
      `Slater path could not converge to ${precision} digits within ` +
      `${maxRetries} working-precision retries ` +
      `(last attempt at ${workingBits} bits)`,
  };
}

