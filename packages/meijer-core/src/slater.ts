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
//   * `quarantine-band`        |z|≈1 ∧ p=q ∧ m+n=p — neither series
//                              converges at the contour boundary;
//                              caller routes to layer-13e contour
//                              quadrature.
//   * `no-convergent-series`   The chosen series's inner pFq itself
//                              lies in a non-convergent regime that
//                              this v0.1 doesn't handle (e.g. Borel
//                              region).
//   * `non-convergent-pfq`     A ParameterPoleError or non-convergence
//                              survived all retries even after
//                              perturbation.
//   * `input-error`            The (an, ap, bm, bq) split was
//                              invalid (e.g. `m == 0 ∧ n == 0` —
//                              neither series has poles to close).
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
// On retry, working bits doubles up to `maxRetries` times, then we
// fall through to a `non-convergent-pfq` refusal.

import {
  type BigComplex,
  cadd,
  cfromReal,
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
  const perturbationMode = opts.perturbation ?? "auto";

  // Coalescence detection runs at the half-target tolerance — anything
  // closer than that to integer-spacing is "indistinguishably close"
  // for our target precision, and the perturbation path is correct.
  const coalescenceTolBits = Math.floor(targetBits / 2);
  const coalescence = detectCoalescence(params, series, coalescenceTolBits);

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

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const workingDecimal = bitsToDecimal(workingBits);
    const pertBits = perturb ? Math.floor(workingBits / 2) : 0;

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
      // A `RangeError` from `cgamma` on an exact non-positive integer
      // input means we hit a coalescence the half-target detector
      // didn't catch. If we weren't already perturbing, retry with
      // perturbation; otherwise surface a structured refusal.
      if (e instanceof RangeError && !perturb && perturbationMode !== "never") {
        perturb = true;
        workingBits = 2 * targetBits + 64;
        warnings.push(
          `recovering from prefactor Γ-pole via perturbation (caught: ${e.message})`,
        );
        continue;
      }
      return {
        status: "non-convergent-pfq",
        reason:
          `Slater prefactor evaluation failed at working precision ` +
          `${workingBits} bits (` +
          (e instanceof Error ? e.message : String(e)) +
          `)`,
      };
    }

    // Survey for inner-pFq refusals.
    let innerRefusal: { status: "non-convergent" | "parameter-pole"; reason: string } | null = null;
    for (const t of terms) {
      if (t.innerPFq.status !== "success") {
        innerRefusal = t.innerPFq;
        break;
      }
    }
    if (innerRefusal !== null) {
      // If the inner refusal is a parameter-pole and we weren't
      // perturbing, retry with perturbation.
      if (
        innerRefusal.status === "parameter-pole" &&
        !perturb &&
        perturbationMode !== "never"
      ) {
        perturb = true;
        workingBits = 2 * targetBits + 64;
        warnings.push(
          `recovering from inner-pFq parameter-pole via perturbation`,
        );
        continue;
      }
      return {
        status: "non-convergent-pfq",
        reason: `inner pFq refused: ${innerRefusal.reason}`,
        innerReason: innerRefusal.reason,
      };
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

    // Cancellation diagnostic. `cancellationLossBits` is the number of
    // significant bits lost between the largest residue term and the
    // sum (always ≥ 0).
    let cancellationLossBits =
      maxTermMagBits === -Infinity || sumMagBits === -Infinity
        ? 0
        : Math.max(0, maxTermMagBits - sumMagBits);

    // The sum may be exactly zero (e.g., perfectly cancelling residues
    // for special parameter symmetries). That's a legitimate result
    // value — we cannot diagnose loss against `-Infinity`. Treat it as
    // "all cancellation" and rely on the working budget to be
    // sufficient.
    if (sumMagBits === -Infinity && maxTermMagBits !== -Infinity) {
      cancellationLossBits = maxTermMagBits + targetBits + 64;
    }

    const usableBits = workingBits - cancellationLossBits;
    if (usableBits >= targetBits + 16) {
      return {
        status: "success",
        value: sum,
        achievedPrecision: precision,
        method,
        seriesTerms: totalNTerms,
        perturbationApplied: perturb,
        cancellationDigitsLost: bitsToDecimal(cancellationLossBits),
        workingPrecision: workingBits,
        warnings,
      };
    }

    // Bump and retry.
    warnings.push(
      `working precision ${workingBits} bits insufficient ` +
        `(cancellation lost ${cancellationLossBits} bits); doubling`,
    );
    workingBits = Math.max(
      workingBits * 2,
      workingBits + cancellationLossBits + 96,
    );
  }

  return {
    status: "non-convergent-pfq",
    reason:
      `Slater path could not converge to ${precision} digits within ` +
      `${maxRetries} working-precision retries ` +
      `(last attempt at ${workingBits} bits)`,
  };
}

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
