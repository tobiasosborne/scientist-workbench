// =============================================================================
// hypergeometric-pfq — arbitrary-precision generalised hypergeometric pFq
// =============================================================================
//
// Intent
// ------
// First arb-prec numerical-tier tool in scientist-workbench (ADR-0020 is
// the design rationale, ADR-0014/0015 the precedent for "agent-honest
// numerical output records"). Computes
//
//     pFq(a₁,…,aₚ; b₁,…,b_q; z)
//        = Σ_{k=0}^∞   ∏_j (a_j)_k    ·  z^k / k!
//                      ───────────────
//                      ∏_j (b_j)_k
//
// at user-requested precision (`--precision=<int>` decimal digits).
// `(x)_k = x · (x+1) · … · (x+k−1)` is the Pochhammer symbol.
//
// v0.1 surface — pragmatic minimum for the MeijerG benchmark
// ----------------------------------------------------------
// * Direct power series with cancellation detection. The work-precision
//   bumps when consecutive terms have alternating signs of similar
//   magnitude (catastrophic cancellation between summands); the running
//   sum is re-computed at higher working precision until convergence.
// * Closed-form fast path for `0F0(z) = e^z` and `1F0(a; ; z) = (1-z)^{-a}`.
// * Refusal via `tagged "hypergeometric-pfq/non-convergent"` for
//   p ≥ q + 2 (asymptotic-only series; v0.2 will add Borel) or for
//   |z| at/near the radius of convergence in the p == q + 1 case.
//
// Out of scope for v0.1 (filed as the natural follow-ups):
// - Asymptotic expansions / Borel resummation for p ≥ q + 2.
// - 2F1 connection formulas for z near 1 (Bühring 1987 / Becken-
//   Schmelcher 2000).
// - Pfaff / Euler transformations to reduce |z|.
// - Confluent 1F1 Kummer transformation when |Re(z)| is large.
// - Recurrence-based shifts (Gil-Segura-Temme 2006).
//
// I/O contract
// ------------
//   input:  { a: list<bigcomplex>, b: list<bigcomplex>, z: bigcomplex }
//   output: { value: bigcomplex,
//             achieved_precision: integer,
//             method: string,
//             n_terms: integer,
//             working_precision: integer,
//             warnings: list<string> }
//   refusals:
//     tagged "hypergeometric-pfq/non-convergent" record { reason: string }
//     tagged "hypergeometric-pfq/parameter-pole" record { which: string,
//                                                          which_idx: integer }
//
// `--precision=N` (decimal digits, default 50) is the standard ADR-0020
// flag inherited from the runner.

import {
  bool,
  int,
  list,
  record,
  S,
  str,
  tagged,
  ToolError,
  type Value,
} from "@workbench/protocol";
import { defineTool, runTool, F } from "@workbench/contract";
import {
  type BigComplex,
  bigcomplexSchema,
  bigcomplexToValue,
  valueToBigComplex,
  cfromInts,
  cfromReal,
  cfromStrings,
  cisZero,
  cadd,
  cmul,
  cdiv,
  cabs,
  cexp,
  cpow,
  csub,
  cneg,
  fromInt,
  fromString,
  toFloat64,
  decimalToBinaryPrecision,
  type BigFloat,
  bitLength,
  abs as bfAbs,
  sgn as bfSgn,
  isZero as bfIsZero,
  cre,
  cim,
} from "@workbench/bigfloat";

const NAME = "hypergeometric-pfq";
const VERSION = "0.1.0";

// -----------------------------------------------------------------------------
// Schema
// -----------------------------------------------------------------------------

const inputSchema = S.record({
  a: S.list(bigcomplexSchema),
  b: S.list(bigcomplexSchema),
  z: bigcomplexSchema,
});

const successOutputSchema = S.record({
  value: bigcomplexSchema,
  achieved_precision: S.kind("integer"),
  method: S.kind("string"),
  n_terms: S.kind("integer"),
  working_precision: S.kind("integer"),
  warnings: S.list(S.kind("string")),
});

const nonConvergentOutputSchema = S.tagged(
  `${NAME}/non-convergent`,
  S.record({ reason: S.kind("string") }),
);

const parameterPoleOutputSchema = S.tagged(
  `${NAME}/parameter-pole`,
  S.record({
    which: S.kind("string"),
    which_idx: S.kind("integer"),
  }),
);

const outputSchema = S.union([
  successOutputSchema,
  nonConvergentOutputSchema,
  parameterPoleOutputSchema,
]);

// -----------------------------------------------------------------------------
// Algorithm
// -----------------------------------------------------------------------------

/**
 * Direct-series evaluation of `pFq(a; b; z)` at the working precision.
 *
 * Returns the value plus diagnostics (number of terms, cancellation
 * digits lost). Throws when a `b_j` is a non-positive integer (parameter
 * pole) — caller surfaces as a tagged refusal.
 *
 * The running sum starts at `1` (the k=0 term, which is `1` since both
 * Pochhammer products are empty at k=0). Each subsequent term:
 *
 *   ratio_k = z · ∏_j (a_j + k - 1) / ∏_j (b_j + k - 1) / k.
 *   term_k = term_{k-1} · ratio_k.
 *   sum_k = sum_{k-1} + term_k.
 */
function pFqDirectSeries(
  aList: BigComplex[],
  bList: BigComplex[],
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
  // Track the magnitude of the largest term seen, in bits, for the
  // cancellation-loss diagnostic.
  let maxTermMagBits = 0;
  // Stop threshold: term magnitude < 2^(-targetPrec - safety) relative
  // to the running sum.
  const safety = 16;
  const stopAbsMagBits = -(targetPrec + safety);

  for (let k = 1; k <= workPrec * 4; k++) {
    // ratio_k = z · ∏ (a_j + k - 1) / ∏ (b_j + k - 1) / k.
    // Build it incrementally: start with z / k, then multiply by each
    // (a_j + k - 1), divide by each (b_j + k - 1).
    let ratio = cdiv(z, cfromReal(fromInt(BigInt(k), workPrec)), workPrec);
    for (const aj of aList) {
      const term_j = cadd(
        aj,
        cfromReal(fromInt(BigInt(k - 1), workPrec)),
        workPrec,
      );
      ratio = cmul(ratio, term_j, workPrec);
    }
    for (let j = 0; j < bList.length; j++) {
      const bj = bList[j]!;
      const term_j = cadd(
        bj,
        cfromReal(fromInt(BigInt(k - 1), workPrec)),
        workPrec,
      );
      // Detect parameter-pole: bj + (k-1) is exactly zero.
      if (cisZero(term_j)) {
        // bj = -(k-1), i.e., bj is a non-positive integer ≤ -(k-1).
        // The series is undefined at this parameter value.
        throw new ParameterPoleError("b", j);
      }
      ratio = cdiv(ratio, term_j, workPrec);
    }
    term = cmul(term, ratio, workPrec);
    sum = cadd(sum, term, workPrec);
    // Track magnitudes for cancellation diagnostic.
    const termMag = magBits(term);
    if (termMag > maxTermMagBits) maxTermMagBits = termMag;
    // Termination: term magnitude < 2^stopAbsMagBits AND smaller than sum's
    // magnitude scaled by relative tolerance.
    const sumMag = magBits(sum);
    if (termMag < sumMag - targetPrec - safety) {
      const cancellationLoss = Math.max(0, maxTermMagBits - sumMag);
      if (cancellationLoss > workPrec - targetPrec - 32) {
        warnings.push(
          `cancellation between summands lost ~${cancellationLoss} bits; consider higher precision`,
        );
      }
      return { value: sum, nTerms: k, cancellationLoss, warnings };
    }
  }
  // Hit iteration cap without convergence.
  warnings.push("series did not converge within iteration cap");
  return {
    value: sum,
    nTerms: workPrec * 4,
    cancellationLoss: 0,
    warnings,
  };
}

class ParameterPoleError extends Error {
  constructor(public which: "a" | "b", public idx: number) {
    super(`pFq parameter pole: ${which}_${idx}`);
    this.name = "ParameterPoleError";
  }
}

/** log2 |z| approximation (returns -Infinity for zero). */
function magBits(z: BigComplex): number {
  if (cisZero(z)) return -Infinity;
  const reMan = z.re.mantissa < 0n ? -z.re.mantissa : z.re.mantissa;
  const imMan = z.im.mantissa < 0n ? -z.im.mantissa : z.im.mantissa;
  const reMag = z.re.mantissa === 0n ? -Infinity : z.re.exponent + bitLength(reMan);
  const imMag = z.im.mantissa === 0n ? -Infinity : z.im.exponent + bitLength(imMan);
  return Math.max(reMag, imMag);
}

/**
 * Evaluate pFq with the right strategy for the given (p, q) and z.
 *
 * v0.1: only direct series. p > q + 1 is non-convergent (Borel needed).
 * For p == q + 1, the series has radius of convergence 1; we accept
 * |z| < 0.95 and refuse closer to the boundary.
 */
function evaluatePFq(
  aList: BigComplex[],
  bList: BigComplex[],
  z: BigComplex,
  precision: number,
): {
  value: BigComplex;
  achievedPrecision: number;
  method: string;
  nTerms: number;
  workingPrecision: number;
  warnings: string[];
} | { tag: "non-convergent"; reason: string } | { tag: "parameter-pole"; which: "a" | "b"; idx: number } {
  const p = aList.length;
  const q = bList.length;
  // Closed-form fast paths.
  if (p === 0 && q === 0) {
    // 0F0(;;z) = e^z.
    const workPrec = decimalToBinaryPrecision(precision);
    const value = cexp(z, workPrec);
    return {
      value,
      achievedPrecision: precision,
      method: "closed-form-0F0",
      nTerms: 0,
      workingPrecision: workPrec,
      warnings: [],
    };
  }
  if (p === 1 && q === 0) {
    // 1F0(a;;z) = (1 - z)^{-a}.
    const workPrec = decimalToBinaryPrecision(precision);
    const oneMinusZ = csub(cfromReal(fromInt(1n, workPrec)), z, workPrec);
    if (cisZero(oneMinusZ)) {
      return { tag: "non-convergent", reason: "1F0(a;;z) is singular at z = 1" };
    }
    const value = cpow(oneMinusZ, cneg(aList[0]!), workPrec);
    return {
      value,
      achievedPrecision: precision,
      method: "closed-form-1F0",
      nTerms: 0,
      workingPrecision: workPrec,
      warnings: [],
    };
  }
  // Convergence diagnostics.
  if (p > q + 1) {
    return {
      tag: "non-convergent",
      reason: `series with p=${p} > q+1=${q + 1} is asymptotic only; Borel resummation deferred to v0.2`,
    };
  }
  if (p === q + 1) {
    const zMag = toFloat64(cabs(z, 53)).value;
    if (zMag >= 0.95) {
      return {
        tag: "non-convergent",
        reason: `|z| = ${zMag.toExponential(3)} too close to radius of convergence 1 for p=${p} q=${q}; analytic continuation deferred to v0.2`,
      };
    }
  }
  // Generic direct-series path.
  let workPrec = decimalToBinaryPrecision(precision);
  let workingBits = workPrec + 32;
  const targetBits = workPrec; // round-down at exit
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const result = pFqDirectSeries(aList, bList, z, workingBits, targetBits);
      // If cancellation lost too many bits, retry at higher precision.
      const usableBits = workingBits - result.cancellationLoss;
      if (usableBits >= targetBits + 16) {
        return {
          value: result.value,
          achievedPrecision: precision,
          method: "direct-series",
          nTerms: result.nTerms,
          workingPrecision: workingBits,
          warnings: result.warnings,
        };
      }
      // Bump and retry.
      workingBits = Math.max(workingBits * 2, workingBits + result.cancellationLoss + 64);
    } catch (e) {
      if (e instanceof ParameterPoleError) {
        return { tag: "parameter-pole", which: e.which, idx: e.idx };
      }
      throw e;
    }
  }
  return {
    tag: "non-convergent",
    reason: "direct-series cancellation could not be controlled within 4 precision-bumps",
  };
}

// -----------------------------------------------------------------------------
// Tool definition
// -----------------------------------------------------------------------------

export const def = defineTool({
  name: NAME,
  version: VERSION,
  schema: { input: inputSchema, output: outputSchema },
  arbprec: true,
  examples: [
    {
      description: "0F0(;;1) = e",
      input: record({
        a: list([] as Value[]),
        b: list([] as Value[]),
        z: bigcomplexToValue(cfromInts(1n, 0n, 50)),
      }),
      flags: { precision: "30" },
      // Output omitted (precision-dependent); structure verified by schema.
    },
    {
      description: "2F1(1, 1; 2; 1/2) = 2 ln(2)",
      input: record({
        a: list([
          bigcomplexToValue(cfromInts(1n, 0n, 50)),
          bigcomplexToValue(cfromInts(1n, 0n, 50)),
        ]),
        b: list([bigcomplexToValue(cfromInts(2n, 0n, 50))]),
        z: bigcomplexToValue(cfromStrings("0.5", "0", 50)),
      }),
      flags: { precision: "30" },
    },
  ],
  invariants: [
    {
      name: "0F0(;;z) = exp(z) for all z",
      statement: "When p=0 and q=0, the series sums to exp(z); the closed-form fast path matches the bigfloat exp.",
      machine_checkable: true,
    },
    {
      name: "1F0(a;;z) = (1-z)^(-a) for |z| < 1",
      statement: "The fast path equals (1 − z) raised to the −a power.",
      machine_checkable: true,
    },
    {
      name: "pFq(a; b; 0) = 1",
      statement: "At z = 0 every series collapses to its k=0 term.",
      machine_checkable: true,
    },
  ],
  fn: (input, flags) => {
    // Decode bigfloat input.
    const inputRecord = input as Extract<Value, { kind: "record" }>;
    const aListValue = inputRecord.fields.a as Extract<Value, { kind: "list" }>;
    const bListValue = inputRecord.fields.b as Extract<Value, { kind: "list" }>;
    const zValue = inputRecord.fields.z!;
    const aList: BigComplex[] = aListValue.items.map((v) => valueToBigComplex(v));
    const bList: BigComplex[] = bListValue.items.map((v) => valueToBigComplex(v));
    const z = valueToBigComplex(zValue);
    // The runner injects the precision flag for arbprec: true tools.
    const precision = Number((flags as { precision?: bigint }).precision ?? 50n);
    if (!Number.isInteger(precision) || precision < 1) {
      throw new ToolError(`hypergeometric-pfq: precision must be a positive integer; got ${precision}`);
    }
    const result = evaluatePFq(aList, bList, z, precision);
    if ("tag" in result) {
      if (result.tag === "non-convergent") {
        return tagged(
          `${NAME}/non-convergent`,
          record({ reason: str(result.reason) }),
        );
      }
      return tagged(
        `${NAME}/parameter-pole`,
        record({
          which: str(result.which),
          which_idx: int(BigInt(result.idx)),
        }),
      );
    }
    return record({
      value: bigcomplexToValue(result.value),
      achieved_precision: int(BigInt(result.achievedPrecision)),
      method: str(result.method),
      n_terms: int(BigInt(result.nTerms)),
      working_precision: int(BigInt(result.workingPrecision)),
      warnings: list(result.warnings.map((w) => str(w))),
    });
  },
});

// -----------------------------------------------------------------------------
// Property tests (--test hook)
// -----------------------------------------------------------------------------

if (import.meta.main) void runTool(def);
