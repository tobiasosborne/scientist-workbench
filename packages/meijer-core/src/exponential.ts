// =============================================================================
// Meijer-G exponential series E_{p,q}(z) — DLMF 16.11.3 with optimal truncation
// =============================================================================
//
// `evaluateEpq(params, z, branchSign, workingBits)` evaluates the
// **exponential asymptotic series** that complements the algebraic
// `H_{p,q}(z)` series of `asymptotic.ts`. Together (with the Stokes
// multipliers of `stokes.ts`) they assemble the full Braaksma
// connection-formula expansion of `G^{m,n}_{p,q}(z)` for the regimes
// covered by ADR-0039 (bead `egf`, hv0.9.2).
//
// The mathematical specification is DLMF 16.11.3 + 16.11.4-5, reproduced
// in `docs/refs/dlmf-16-11.md` §3. In compact form:
//
//                                                ∞
//   E_{p,q}(z) = (2π)^{(p-q)/2} · κ^{-ν-1/2} · e^{κ z^{1/κ}} · Σ c_k · (κ z^{1/κ})^{ν − k}
//                                              k=0
//
// with the structural parameters
//
//   κ = q − p + 1,           ν = Σ a_ℓ − Σ b_ℓ + (q − p)/2,
//
// and the coefficient recurrence (DLMF 16.11.4-5)
//
//   c_0 = 1,
//   c_k = −1/(k κ) · Σ_{m=0}^{k−1} c_m · e_{k,m}              for k ≥ 1,
//                                       q+1
//   e_{k,m} = Σ (1 − ν − κ b_j + m)_{κ + k − m} · ∏_{ℓ=1..p} (a_ℓ − b_j) /
//             j=1                                 ∏_{ℓ≠j} (b_ℓ − b_j)
//
//   with the convention b_{q+1} = 1.
//
// The series is **divergent for all finite z** (Paris-Kaminski §2.2.3,
// Theorem 2.4); it is **optimally truncated** at
//
//   N* = ⌊ |κ z^{1/κ}| ⌋
//
// at which point the first omitted term is exponentially small relative
// to the leading e^{κ z^{1/κ}} factor (≈ e^{−2 |κ z^{1/κ}|} in the
// growth sector). This is the same N* used in the algebraic-series
// truncation (`findTruncationParisKaminski`), reflecting the universal
// "saddle-point distance to the dominant singularity" interpretation:
// in the algebraic series, |κ z^{1/κ}| is the radius of the optimal-
// truncation ball for the divergent inner ${}_pF_{q-1}(z^{-1})$; here
// in the exponential series it is the radius of the optimal ball for
// the coefficient recurrence's divergent growth.
//
// Branch convention
// =================
//
// The `branchSign` argument selects one of three principal-value
// representatives — *which* analytic-continuation sheet of `E_{p,q}` is
// being computed:
//
//   branchSign = -1  ⇒  E_{p,q}(z e^{-2π i}) (one full rotation clockwise)
//   branchSign =  0  ⇒  E_{p,q}(z)            (principal value)
//   branchSign = +1  ⇒  E_{p,q}(z e^{+2π i}) (one full rotation counter-clockwise)
//
// The rotation acts INSIDE the principal-value root z^{1/κ}. Letting
// `θ = arg z + 2π · branchSign`, we have
//
//   z^{1/κ}  =  |z|^{1/κ} · exp(i θ / κ),
//   log(κ z^{1/κ})  =  log(κ |z|^{1/κ}) + i θ / κ.
//
// The complex powers `(κ z^{1/κ})^{ν − k}` are evaluated via
// `exp((ν − k) · log(κ z^{1/κ}))` using the rotated log so that the
// phase information is consistent with the chosen branch. For κ = 1
// the rotation `e^{±2πi}` is the identity on z, but the series powers
// still pick up phase factors `e^{±2π i (ν − k)} = e^{±2π i ν}` (since
// `e^{∓2π i k} = 1` for integer k). Hence for non-integer ν the three
// branches give distinct values even at κ = 1; this is the load-bearing
// behaviour the κ = 1 Stokes connection formula relies on.
//
// Determinism contract
// ====================
//
// `arbprec: true` (ADR-0020): every operation is BigInt-rooted BigFloat
// or BigComplex arithmetic. No `Math.*` in the numerical path. The
// principal-value root is built explicitly via `cabs` / `carg` /
// `log` / BigFloat division by an integer κ, so the rotated branch
// `branchSign ∈ {−1, 0, +1}` is bit-identical cross-platform forever.
// The coefficient recurrence is rational in the parameters (no
// transcendentals), so `c_k` is exact at working precision modulo
// arithmetic rounding.
//
// What this module does NOT do
// ----------------------------
//
//   * No connection-formula assembly. `evaluateEpq` returns the value
//     of `E_{p,q}` on a specified branch; the caller is responsible for
//     forming `Σ_k S_k · E_{p,q}(z e^{2π i k / κ})` per the Stokes
//     table.
//   * No Berry smoothing across Stokes lines. The smoothing is a
//     property of the Stokes multiplier S_k (handled in `stokes.ts`,
//     ADR-0039 §D5 currently using sharp-switch option C); `E_{p,q}`
//     itself is the same series on either side of a Stokes line.
//   * No precision retry. If the working precision is insufficient to
//     resolve the series, the caller (Part 2 of bead `egf`) decides
//     whether to widen and retry. This module reports `errorEstimate`
//     so the caller has the information it needs.

import {
  type BigComplex,
  type BigFloat,
  add as addBF,
  cabs,
  cadd,
  carg,
  cdiv as cdivBC,
  cexp,
  cfromInts,
  cfromReal,
  cisZero,
  cmul,
  cneg,
  csub,
  div as divBF,
  exp as expBF,
  fromInt,
  log as logBF,
  mul as mulBF,
  neg as negBF,
  pi,
} from "@workbench/bigfloat";
import type { MeijerGParameters } from "./types.js";

// -----------------------------------------------------------------------------
// Public types
// -----------------------------------------------------------------------------

/**
 * Successful evaluation of E_{p,q}(z) on the requested branch.
 *
 * `value` is at `workingBits` precision (no rounding-to-user-precision
 * is performed by this module; that's the caller's job once the
 * contributions are assembled). `nTerms` is the truncation index N* + 1
 * (the count of summands actually included). `errorEstimate` is the
 * magnitude of the first omitted term — the Olver-style asymptotic
 * error bound.
 */
export interface EpqSuccess {
  readonly status: "success";
  readonly value: BigComplex;
  readonly nTerms: number;
  readonly errorEstimate: BigFloat;
  readonly warnings: readonly string[];
}

export interface EpqRefusal {
  readonly status: "non-asymptotic-regime" | "input-error";
  readonly reason: string;
}

export type EpqResult = EpqSuccess | EpqRefusal;

// -----------------------------------------------------------------------------
// Public entry
// -----------------------------------------------------------------------------

/**
 * Evaluate `E_{p,q}(z · e^{i · branchSign · 2π})` per DLMF 16.11.3 at
 * `workingBits` of binary precision, with optimal truncation at
 * `N* = ⌊|κ z^{1/κ}|⌋` and first-omitted-term error estimate.
 *
 * Refuses with `non-asymptotic-regime` when `κ ≤ 0` (the series is
 * undefined outside the κ ≥ 1 regime) and with `input-error` on
 * `z = 0` (the formula has an essential singularity at the origin) or
 * non-finite working precision.
 *
 * The `branchSign` argument is one of `{−1, 0, +1}`, selecting the
 * principal value (`0`) or the one-full-rotation analytic continuation
 * (`±1`). See the module-level comment for the branch convention.
 */
export function evaluateEpq(
  params: MeijerGParameters,
  z: BigComplex,
  branchSign: -1 | 0 | 1,
  workingBits: number,
): EpqResult {
  // ----------------------------------------------------------- inputs
  if (!Number.isInteger(workingBits) || workingBits < 32) {
    return {
      status: "input-error",
      reason: `workingBits must be a positive integer ≥ 32; got ${workingBits}`,
    };
  }
  if (branchSign !== -1 && branchSign !== 0 && branchSign !== 1) {
    return {
      status: "input-error",
      reason: `branchSign must be one of {-1, 0, +1}; got ${branchSign}`,
    };
  }
  if (cisZero(z)) {
    return {
      status: "input-error",
      reason:
        "z = 0: E_{p,q}(z) has an essential singularity at the origin " +
        "(the κ z^{1/κ} exponent diverges). The asymptotic regime " +
        "applies only for z ≠ 0; for small |z|, route to the Slater " +
        "series via meijergSlater.",
    };
  }

  const { an, ap, bm, bq } = params;
  const p = an.length + ap.length;
  const q = bm.length + bq.length;
  const kappa = q - p + 1;

  if (kappa <= 0) {
    return {
      status: "non-asymptotic-regime",
      reason:
        `κ = q − p + 1 = ${kappa} ≤ 0; E_{p,q}(z) is undefined for κ ≤ 0 ` +
        `(the divergent-asymptotic regime where exponential corrections ` +
        `cannot be optimally truncated against the algebraic series). ` +
        `The caller is using E_{p,q} out-of-scope. For κ = 0 (p = q + 1) ` +
        `DLMF 16.11.6 gives the convergent ${"`"}_{q+1}F_q${"`"} identity instead; ` +
        `for κ < 0 (p ≥ q + 2) Borel resummation is required.`,
    };
  }

  // ---------------------------------------------------- structural params
  // ν = Σ_ℓ a_ℓ − Σ_ℓ b_ℓ + (q − p)/2.
  // The sum runs over *all* upper and lower parameters (both `an` and
  // `ap`, both `bm` and `bq`). The `(q − p)/2` constant lives at the
  // BigFloat level (q − p is an integer divided by 2).
  const zero = cfromInts(0n, 0n, workingBits);
  let nu = zero;
  for (const a of an) nu = cadd(nu, a, workingBits);
  for (const a of ap) nu = cadd(nu, a, workingBits);
  for (const b of bm) nu = csub(nu, b, workingBits);
  for (const b of bq) nu = csub(nu, b, workingBits);
  // (q − p) is an integer; add (q − p)/2 as a rational BigFloat.
  const halfQminusP = cfromReal(
    divBF(
      fromInt(BigInt(q - p), workingBits),
      fromInt(2n, workingBits),
      workingBits,
    ),
  );
  nu = cadd(nu, halfQminusP, workingBits);

  // ---------------------------------------------------- z^{1/κ} on the
  //                                                       rotated branch
  // Build z_root = |z|^{1/κ} · exp(i · (arg z + 2π·branchSign) / κ).
  // Use cabs and carg to extract magnitude and principal-value arg;
  // rotate the arg by 2π·branchSign at full precision; divide by κ;
  // construct the rotated root via cexp on a pure-imaginary, scaled by
  // |z|^{1/κ}. This keeps every operation in BigFloat — no float64 in
  // the path. `arbprec: true` is preserved on all three branches.
  const absZ = cabs(z, workingBits);
  const argZ = carg(z, workingBits);
  const piVal = pi(workingBits);
  const twoPi = mulBF(fromInt(2n, workingBits), piVal, workingBits);
  // theta = argZ + 2π · branchSign  (in radians, full BigFloat precision).
  let theta: BigFloat;
  if (branchSign === 1) {
    theta = addBF(argZ, twoPi, workingBits);
  } else if (branchSign === -1) {
    theta = addBF(argZ, negBF(twoPi), workingBits);
  } else {
    theta = argZ;
  }
  // |z|^{1/κ} = exp(log|z| / κ). Refuse when |z| ≤ 0 — but cisZero
  // already handled z = 0; cabs returns a positive BigFloat for any
  // non-zero z, so logBF is safe.
  const logAbsZ = logBF(absZ, workingBits);
  const logAbsZOverK = divBF(
    logAbsZ,
    fromInt(BigInt(kappa), workingBits),
    workingBits,
  );
  const absZToOneOverK = expBF(logAbsZOverK, workingBits);
  // i · theta / κ
  const thetaOverK = divBF(
    theta,
    fromInt(BigInt(kappa), workingBits),
    workingBits,
  );
  // exp(i · thetaOverK) = (cos(θ/κ), sin(θ/κ)). Compute via cexp on
  // an imaginary BigComplex.
  const imaginaryArg: BigComplex = {
    re: fromInt(0n, workingBits),
    im: thetaOverK,
  };
  const phasor = cexp(imaginaryArg, workingBits);
  // z_root = |z|^{1/κ} · phasor (a real scalar times a unit-modulus complex).
  const zRoot = cmul(cfromReal(absZToOneOverK), phasor, workingBits);

  // κ · z^{1/κ}
  const kappaBC = cfromReal(fromInt(BigInt(kappa), workingBits));
  const kz = cmul(kappaBC, zRoot, workingBits);

  // ---------------------------------------------------- truncation index
  // N* = ⌊|κ z^{1/κ}|⌋ — same analytical-N* rule that
  // `findTruncationParisKaminski` uses for the algebraic series. The
  // floor-to-BigInt is via mantissa-shift on a non-negative BigFloat
  // (no float64 in the path).
  const kzMag = cabs(kz, workingBits);
  const NStarBig = floorNonNegativeBigFloatToBigInt(kzMag);
  // Defensive clamp: extremely small |κ z^{1/κ}| (< 1) gives N* = 0; we
  // still include c_0 (so the series has one term). Extremely large
  // |κ z^{1/κ}| would be unreasonable for typical inputs — clamp at a
  // soft cap of 4 · workingBits/4 = workingBits, generous for any
  // realistic asymptotic input. The recurrence cost is quadratic in
  // N*, so the cap matters for performance, not correctness.
  const maxTerms = Math.max(64, workingBits);
  let NStar: number;
  if (NStarBig <= 0n) {
    NStar = 0;
  } else if (NStarBig >= BigInt(maxTerms)) {
    NStar = maxTerms - 1;
  } else {
    NStar = Number(NStarBig);
  }

  // ---------------------------------------------------- log(κ z^{1/κ})
  //                                                       on the rotated
  //                                                       branch
  // For computing (κ z^{1/κ})^{ν − k} on the correct branch, we cannot
  // use the principal-value clog (which would re-fold the rotated arg
  // back into (−π, π]). Build log_kz directly from the rotated phase:
  //
  //   log(κ z^{1/κ}) = log|κ z^{1/κ}| + i · (θ/κ)
  //
  // where θ/κ is the rotated phase (may exceed π in magnitude, which
  // is correct on the non-principal branch).
  const logKzReal = logBF(kzMag, workingBits);
  const logKz: BigComplex = {
    re: logKzReal,
    im: thetaOverK,
  };

  // ---------------------------------------------------- coefficient
  //                                                       recurrence
  // c_0 = 1; c_k = −1/(k κ) · Σ_{m=0..k−1} c_m · e_{k,m}.
  // e_{k,m} = Σ_{j=1..q+1} (1 − ν − κ b_j + m)_{κ+k−m} · poch_factor_j
  // with b_{q+1} = 1 and
  //   poch_factor_j = ∏_{ℓ=1..p} (a_ℓ − b_j) / ∏_{ℓ ≠ j} (b_ℓ − b_j).
  //
  // The j-loop's denominator can hit zero when two `b`'s coincide; in
  // the Meijer-G context this is the parameter-coalescence case which
  // the dispatcher (ADR-0027) handles upstream by routing to a
  // perturbed Slater path. We assume the caller has filtered out
  // coalescent inputs; if a zero denominator appears we surface it as
  // input-error rather than guess at a regularisation.
  const bAug: BigComplex[] = [...bm, ...bq, cfromInts(1n, 0n, workingBits)];
  const aAll: BigComplex[] = [...an, ...ap];
  const pochFactors: BigComplex[] = new Array(q + 1);
  for (let j = 0; j < q + 1; j++) {
    const bj = bAug[j]!;
    let num = cfromInts(1n, 0n, workingBits);
    for (const al of aAll) {
      num = cmul(num, csub(al, bj, workingBits), workingBits);
    }
    let den = cfromInts(1n, 0n, workingBits);
    for (let l = 0; l < q + 1; l++) {
      if (l === j) continue;
      den = cmul(den, csub(bAug[l]!, bj, workingBits), workingBits);
    }
    if (cisZero(den)) {
      return {
        status: "input-error",
        reason:
          `coalescent b-parameters: ∏_{ℓ≠${j}} (b_ℓ − b_${j}) = 0; the ` +
          `coefficient recurrence's denominator vanishes. Two lower ` +
          `parameters of E_{p,q} coincide (including the augmented ` +
          `b_{q+1} = 1). v0.1 does not perturb; route to the Slater ` +
          `path (which handles coalescence via Johansson hmag) or ` +
          `de-coalesce the input.`,
      };
    }
    pochFactors[j] = cdivBC(num, den, workingBits);
  }

  // Build the c_k array up to k = N* + 1 (one extra for the error
  // estimate term). For k = 0 we already have c_0 = 1.
  const cs: BigComplex[] = new Array(NStar + 2);
  cs[0] = cfromInts(1n, 0n, workingBits);
  for (let k = 1; k <= NStar + 1; k++) {
    // Sum over m = 0..k−1 of c_m · e_{k,m}.
    let acc = cfromInts(0n, 0n, workingBits);
    for (let m = 0; m < k; m++) {
      let ekm = cfromInts(0n, 0n, workingBits);
      for (let j = 0; j < q + 1; j++) {
        const bj = bAug[j]!;
        // x = 1 − ν − κ b_j + m  (BigComplex).
        const xReal = csub(
          cadd(
            cfromInts(1n + BigInt(m), 0n, workingBits),
            cneg(nu),
            workingBits,
          ),
          cmul(kappaBC, bj, workingBits),
          workingBits,
        );
        // Pochhammer (x)_n  with n = κ + k − m. Computed iteratively.
        const nPoch = kappa + k - m;
        let poch = cfromInts(1n, 0n, workingBits);
        for (let i = 0; i < nPoch; i++) {
          const xPlusI = cadd(
            xReal,
            cfromInts(BigInt(i), 0n, workingBits),
            workingBits,
          );
          poch = cmul(poch, xPlusI, workingBits);
        }
        ekm = cadd(
          ekm,
          cmul(poch, pochFactors[j]!, workingBits),
          workingBits,
        );
      }
      acc = cadd(acc, cmul(cs[m]!, ekm, workingBits), workingBits);
    }
    // c_k = − acc / (k κ)
    const kKappa = cfromReal(
      fromInt(BigInt(k) * BigInt(kappa), workingBits),
    );
    cs[k] = cneg(cdivBC(acc, kKappa, workingBits));
  }

  // ---------------------------------------------------- assemble the series
  //
  //   (2π)^{(p − q)/2} · κ^{−ν − 1/2} · e^{κ z^{1/κ}} · Σ_{k=0..N*} c_k · (κ z^{1/κ})^{ν − k}
  //
  // (2π)^{(p − q)/2} is a real BigFloat for integer (p − q) (lifted to
  // BigComplex). κ^{−ν − 1/2} uses the principal-value cpow with
  // BigComplex base κ + 0i and complex exponent (−ν − 1/2).
  //
  // The series Σ c_k (κ z^{1/κ})^{ν − k} is computed using the rotated
  // log_kz built above: (κ z^{1/κ})^{ν − k} = exp((ν − k) · log_kz).
  // This carries the branch-dependent phase faithfully on all three
  // branches.

  // (2π)^{(p − q)/2}: cleaner to compute as exp((p−q)/2 · log(2π)).
  const twoPiBF = mulBF(fromInt(2n, workingBits), piVal, workingBits);
  const logTwoPi = logBF(twoPiBF, workingBits);
  const pMinusQOver2 = divBF(
    fromInt(BigInt(p - q), workingBits),
    fromInt(2n, workingBits),
    workingBits,
  );
  const log2piTimesExp = mulBF(pMinusQOver2, logTwoPi, workingBits);
  const twoPiPow = cfromReal(expBF(log2piTimesExp, workingBits));

  // κ^{−ν − 1/2}: compute log_kappa once, then multiply by (−ν − 1/2)
  // as a BigComplex and exponentiate.
  const logKappa = cfromReal(
    logBF(fromInt(BigInt(kappa), workingBits), workingBits),
  );
  const half = cfromReal(
    divBF(
      fromInt(1n, workingBits),
      fromInt(2n, workingBits),
      workingBits,
    ),
  );
  const negNuMinusHalf = cneg(cadd(nu, half, workingBits));
  const kappaPow = cexp(
    cmul(negNuMinusHalf, logKappa, workingBits),
    workingBits,
  );

  const expKz = cexp(kz, workingBits);

  // Build the series sum and capture |c_{N*+1} · (kz)^{ν − (N*+1)}| as
  // the error estimate (the first omitted term magnitude).
  let series = cfromInts(0n, 0n, workingBits);
  let lastTermMag = fromInt(0n, workingBits);
  for (let k = 0; k <= NStar; k++) {
    // (kz)^{ν − k} = exp((ν − k) · log_kz).
    const nuMinusK = csub(
      nu,
      cfromInts(BigInt(k), 0n, workingBits),
      workingBits,
    );
    const power = cexp(
      cmul(nuMinusK, logKz, workingBits),
      workingBits,
    );
    const term = cmul(cs[k]!, power, workingBits);
    series = cadd(series, term, workingBits);
    lastTermMag = cabs(term, workingBits);
  }

  // First-omitted-term magnitude: |c_{N*+1} · (kz)^{ν − (N*+1)}|.
  // This is the Olver / Paris–Kaminski asymptotic-error bound (P&K
  // Theorem 2.4, p. 78).
  const nuMinusNextK = csub(
    nu,
    cfromInts(BigInt(NStar + 1), 0n, workingBits),
    workingBits,
  );
  const nextPower = cexp(
    cmul(nuMinusNextK, logKz, workingBits),
    workingBits,
  );
  const nextTerm = cmul(cs[NStar + 1]!, nextPower, workingBits);
  // Multiply the magnitude by the overall prefactor magnitudes to get
  // the error estimate in the same scale as `value`. The series-level
  // first-omitted term carries through every outer multiplier.
  const outerPrefMag = cabs(
    cmul(twoPiPow, cmul(kappaPow, expKz, workingBits), workingBits),
    workingBits,
  );
  const errorEstimate = mulBF(
    cabs(nextTerm, workingBits),
    outerPrefMag,
    workingBits,
  );
  // Suppress unused-variable warning for lastTermMag — kept as a
  // defensive observable for a future ratio-check warning.
  void lastTermMag;

  // value = (2π)^{(p−q)/2} · κ^{−ν−1/2} · e^{κ z^{1/κ}} · series
  let value = cmul(twoPiPow, kappaPow, workingBits);
  value = cmul(value, expKz, workingBits);
  value = cmul(value, series, workingBits);

  const warnings: string[] = [];
  if (NStar === 0) {
    warnings.push(
      `N* = 0 (|κ z^{1/κ}| < 1); the optimal-truncation includes only ` +
        `c_0 = 1, so the series sum is essentially the leading exponential ` +
        `e^{κ z^{1/κ}} · (κ z^{1/κ})^ν. This is a marginal-asymptotic ` +
        `input — the caller should route to a non-asymptotic method for ` +
        `tighter accuracy.`,
    );
  }
  if (NStar === maxTerms - 1) {
    warnings.push(
      `N* clamped to maxTerms = ${maxTerms}; |κ z^{1/κ}| ≥ maxTerms means ` +
        `the requested input is extreme. The error estimate uses the ` +
        `clamped first-omitted term, which may underestimate the true error.`,
    );
  }

  return {
    status: "success",
    value,
    nTerms: NStar + 1,
    errorEstimate,
    warnings,
  };
}

// -----------------------------------------------------------------------------
// Local helpers
// -----------------------------------------------------------------------------

// `add`, `mul`, `div`, `neg`, `exp`, `log` for `BigFloat` and `cdiv`
// for `BigComplex` are imported under aliases at the top of the file.

/**
 * Floor a non-negative BigFloat to a BigInt, exactly, via mantissa
 * shift. Mirrors the helper in `asymptotic.ts` — duplicated locally
 * rather than imported to keep `exponential.ts` self-contained for
 * future moves to a shared "numerics-utilities" subpackage. No float64
 * in the path; bit-identical cross-platform forever.
 */
function floorNonNegativeBigFloatToBigInt(x: BigFloat): bigint {
  if (x.mantissa === 0n) return 0n;
  if (x.mantissa < 0n) {
    throw new Error(
      `floorNonNegativeBigFloatToBigInt: expected non-negative input; ` +
        `got mantissa=${x.mantissa}`,
    );
  }
  if (x.exponent >= 0) return x.mantissa << BigInt(x.exponent);
  return x.mantissa >> BigInt(-x.exponent);
}
