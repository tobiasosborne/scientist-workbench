// =============================================================================
// Mellin-Barnes contour quadrature — direct numerical evaluation of MeijerG
// =============================================================================
//
// `meijergContour(params, z, precision, opts)` is the v0.1 of layer 5 of
// the seven-layer MeijerG numerical evaluator (PLAN.md, hv0.8). It
// computes
//
//                     1     ⌠   ∏Γ(b_j − s) · ∏Γ(1 − a_j + s)
//      G(...; z) = ──────  ⎮  ──────────────────────────────────  z^s ds
//                    2πi    ⌡L  ∏Γ(1 − b_j + s) · ∏Γ(a_j − s)
//
// directly, by parameterising the contour `L` as a vertical line
// `Re(s) = c, t ∈ ℝ` and applying the arb-prec adaptive G7K15 driver
// `gaussKronrodAdaptiveBC` (ADR-0022) to the truncated real interval
// `[-T, T]`. Returns either a `MeijerGContourSuccess` record (with the
// value plus diagnostics — contour parameter `c`, truncation `T`,
// evaluation count, working precision, warnings) or a structured
// refusal:
//
//   * `non-convergent-contour`  `2(m+n) ≤ p+q` — the integrand does
//                               not decay along a vertical line; this
//                               v0.1 cannot handle the case (asymptotic
//                               layer hv0.9 is the right home).
//   * `no-valid-contour`        `max{Re(a_j)} − 1 ≥ min{Re(b_j)}` —
//                               the upper-pole and lower-pole clusters
//                               overlap; no vertical contour separates
//                               them. A future bead can introduce
//                               contour deformation (DLMF §16.17.2).
//   * `input-error`             precision out of range, or the
//                               quadrature driver raised on the
//                               integrand (typically a Γ-pole
//                               coincident with a sample point — the
//                               midpoint contour avoids the obvious
//                               hazards but cannot guarantee against
//                               every arrangement).
//
// Algorithm summary
// -----------------
// 1. **Validate inputs** — `precision` integer ≥ 1; refuse non-
//    decaying contour `2(m+n) ≤ p+q` and overlapping pole clusters.
// 2. **Choose contour `c`** — default is the midpoint of the safe
//    interval `(max{Re(a_j)} − 1, min{Re(b_j)})`. Caller may override
//    via `opts.contourRe`.
// 3. **Build integrand** — `t ↦ M(c + it)` with all Γ products and
//    the `z^s = exp(s · log z)` factor evaluated at `workingBits`.
//    The `log z` is computed once and closed over.
// 4. **Choose truncation `T`** — start from the asymptotic estimate
//    `T_init = ceil(X · log(2) / (π · α))` where
//    `X = precision · log2(10) + 20` (the dB-magnitude headroom we
//    want past the user precision) and `α = (2(m+n) − (p+q)) / 2` is
//    the asymptotic decay rate from Stirling. Verify by sampling the
//    integrand at `±T_init` and double T until both tail magnitudes
//    fall below `2^-X · |peak|`. Caller may override via
//    `opts.truncate`.
// 5. **Quadrature** — `gaussKronrodAdaptiveBC(integrand, -T, T,
//    precision, { maxEvals })`. The driver's structured-refusal
//    surface is folded into our `MeijerGContourRefusal` envelope.
// 6. **Prefactor** — multiply by `1/(2π)`. (The `1/(2πi)` of the
//    integral-definition combines with `ds = i dt` on the contour to
//    leave a real `1/(2π)` prefactor; the `i` factors out of the
//    BigComplex integrand cleanly.)
// 7. **Round** to user precision and pack the result.
//
// Determinism contract
// --------------------
// Every operation in this orchestrator bottoms out in `BigInt`
// arithmetic via the bigfloat / bigcomplex substrate. The G7K15 driver
// is bit-deterministic by ADR-0020/0022; the truncation search is
// deterministic given the integrand and precision. So the orchestrator
// is `arbprec: true`'s strongest determinism contract: same
// `(params, z, precision, opts)` ⇒ same output bytes, forever, on any
// platform.
//
// What this v0.1 does *not* handle
// --------------------------------
//   * Branch-cut handling at `z` on the negative real axis — the
//     `clog(z)` / `cexp(s·log z)` factor uses the principal branch
//     `arg z ∈ (−π, π]`; consumers crossing the branch cut need to
//     route via the dispatcher (hv0.10) which checks for the cut.
//   * Asymmetric contour placement / steepest-descent deformation —
//     the contour is parallel to the imaginary axis; saddle-point
//     deformation (Paris-Kaminski 2001 ch.2) is deferred to a future
//     bead when the asymptotic layer (hv0.9) lands and the dispatcher
//     can route between Slater / contour / asymptotic intelligently.
//   * Adaptive contour offset for asymmetric `arg(z)` cases — the
//     `e^{-t·arg(z)}` factor in `z^s` shifts the integrand peak away
//     from `t = 0` for non-real `z`. The symmetric truncation `[-T,
//     T]` is conservative (covers both peaks); a future v0.2 can
//     centre the contour on the actual peak.
//   * Outer cancellation-detection retries (the Slater path's
//     "doubling-bumped working precision on cancellation loss"
//     pattern). Mellin-Barnes cancellation behaviour is qualitatively
//     different (smooth analytic integrand, no per-residue Γ-product
//     blow-up), so the inner driver's working margin is sufficient at
//     v0.1; if a stress case turns up it can be filed as a follow-up.

import {
  type BigComplex,
  type BigFloat,
  abs,
  add,
  cabs,
  cadd,
  cdiv,
  cexp,
  cfromReal,
  cgamma,
  clog,
  cmp,
  cmul,
  csub,
  decimalToBinaryPrecision,
  div,
  fromInt,
  fromString,
  isZero,
  mul,
  neg,
  pi,
  powInt,
  sub,
  toString as bfToString,
} from "@workbench/bigfloat";
import {
  type BigComplexQuadResult,
  gaussKronrodAdaptiveBC,
} from "@workbench/quadrature";
import type { MeijerGParameters } from "./types.js";

// -----------------------------------------------------------------------------
// Public types
// -----------------------------------------------------------------------------

export interface MeijerGContourOptions {
  /**
   * Override the default contour `Re(s) = c`. Must satisfy
   * `max{Re(a_j)} − 1 < c < min{Re(b_j)}` for the integrand to be
   * pole-free on the contour; the orchestrator does *not* re-validate
   * caller-supplied `c` (caller takes ownership of correctness).
   */
  readonly contourRe?: BigFloat;
  /**
   * Override the auto-selected symmetric truncation `|t| ≤ T`. Useful
   * for diagnostic runs (sweep T, see how the result moves) or when
   * the caller has prior knowledge of the integrand's tail shape.
   */
  readonly truncate?: BigFloat;
  /**
   * Maximum number of integrand evaluations (passed to the quadrature
   * driver). Default: `precision · 200` — same as the inner driver.
   */
  readonly maxEvals?: number;
}

/** Successful evaluation. */
export interface MeijerGContourSuccess {
  readonly status: "success";
  readonly value: BigComplex;
  readonly achievedPrecision: number;
  readonly method: "mellin-barnes";
  /** The contour real part `c` actually used. */
  readonly contourRe: BigFloat;
  /** The symmetric truncation `T` actually used (integrate over [−T, T]). */
  readonly truncate: BigFloat;
  /** Number of integrand evaluations performed by the inner driver. */
  readonly nEvals: number;
  /** Inner driver's `converged` flag. */
  readonly converged: boolean;
  readonly workingPrecision: number;
  readonly warnings: readonly string[];
}

/** Structured refusal — emit as a `tagged` value at the wire boundary. */
export interface MeijerGContourRefusal {
  readonly status:
    | "non-convergent-contour"
    | "no-valid-contour"
    | "input-error";
  readonly reason: string;
}

export type MeijerGContourResult =
  | MeijerGContourSuccess
  | MeijerGContourRefusal;

// -----------------------------------------------------------------------------
// Public entry
// -----------------------------------------------------------------------------

export function meijergContour(
  params: MeijerGParameters,
  z: BigComplex,
  precision: number,
  opts: MeijerGContourOptions = {},
): MeijerGContourResult {
  // --------------------------------------------------------------- inputs
  if (!Number.isInteger(precision) || precision < 1) {
    return {
      status: "input-error",
      reason: `precision must be a positive integer; got ${precision}`,
    };
  }
  const { an, ap, bm, bq } = params;
  const m = bm.length;
  const n = an.length;
  const p = n + ap.length;
  const q = m + bq.length;

  if (m === 0 && n === 0) {
    return {
      status: "input-error",
      reason:
        "Mellin-Barnes contour with m = n = 0 has trivial Γ-products " +
        "(numerator = 1); the integral is `(1/2π) ∫ z^s ds` with no " +
        "decay — refusing rather than producing nonsense",
    };
  }

  // ---------------------------------------------------- decay-rate check
  // Asymptotic decay rate of the integrand on a vertical line: from
  // Stirling, |Γ(σ ± it)| ~ √(2π) · |t|^{σ−1/2} · exp(−π|t|/2). Net
  // decay over the m + n numerator-Γ minus (p − n) + (q − m) =
  // (p + q − m − n) denominator-Γ:
  //
  //     net exponent = (m + n − (p + q − m − n)) / 2 · π · |t|
  //                  = (2(m + n) − (p + q)) / 2 · π · |t|
  //                  = α · π · |t|
  //
  // For decay (and thus a convergent integral on the real axis t ∈ ℝ)
  // we need α > 0. If `decayOrder = 2(m+n) − (p+q) ≤ 0`, the integrand
  // grows or oscillates without decay; the vertical-line contour does
  // not converge. The asymptotic layer (hv0.9) is the right home.
  const decayOrder = 2 * (m + n) - (p + q);
  if (decayOrder <= 0) {
    return {
      status: "non-convergent-contour",
      reason:
        `Mellin-Barnes vertical contour requires 2(m+n) > p+q for decay; ` +
        `got 2·(${m}+${n}) = ${2 * (m + n)} ≤ ${p}+${q} = ${p + q}. ` +
        `Use the Slater path (if convergent in this regime) or the asymptotic ` +
        `layer (hv0.9, forthcoming) instead.`,
    };
  }
  const alpha = decayOrder / 2; // > 0

  // ---------------------------------------------- working precision
  const workingBits = decimalToBinaryPrecision(precision, 30);

  // ---------------------------------------------- contour location `c`
  // Constraint (DLMF §16.17.2): max{Re(a_j)} − 1 < c < min{Re(b_j)},
  // so that all `Γ(b_j − s)` poles lie to the *right* of the contour
  // and all `Γ(1 − a_j + s)` poles to the *left*. With m + n ≥ 1, at
  // least one of `bm` (lower bound side) or `an` (upper bound side)
  // is non-empty; the constraint is well-defined whenever both exist.
  // For `bq`/`ap`-only cases, the constraint applies *only* to the
  // active side — but our v0.1 enforces `m + n ≥ 1` (above), so at
  // least one Γ pole-cluster is active.
  let c: BigFloat;
  if (opts.contourRe) {
    c = opts.contourRe;
  } else {
    const allUpper = [...an, ...ap]; // all `a_j` (Γ(1−a+s) and Γ(a−s) poles)
    const allLower = [...bm, ...bq]; // all `b_j` (Γ(b−s) and Γ(1−b+s) poles)
    // max{Re(a_j)} over all p upper params (poles at s = a_j − 1 − k
    // come from Γ(1−a_j+s); poles at s = a_j + k come from Γ(a_j−s)).
    // The contour must avoid both; the closer-to-the-contour cluster
    // dictates `c`. For the constraint, the relevant bound is
    // `max{Re(a_j) − 1}` from the Γ(1−a+s) poles.
    let maxAjReMinus1: BigFloat | null = null;
    for (const aj of allUpper) {
      const cand = sub(aj.re, fromInt(1n, workingBits), workingBits);
      if (maxAjReMinus1 === null || cmp(cand, maxAjReMinus1) > 0) {
        maxAjReMinus1 = cand;
      }
    }
    let minBjRe: BigFloat | null = null;
    for (const bj of allLower) {
      if (minBjRe === null || cmp(bj.re, minBjRe) < 0) {
        minBjRe = bj.re;
      }
    }
    if (maxAjReMinus1 !== null && minBjRe !== null) {
      // Both sides active: midpoint of the open interval.
      if (cmp(maxAjReMinus1, minBjRe) >= 0) {
        return {
          status: "no-valid-contour",
          reason:
            `No valid vertical contour: max{Re(a_j)} − 1 = ${bfToString(maxAjReMinus1, 6)} ` +
            `≥ min{Re(b_j)} = ${bfToString(minBjRe, 6)}. The Γ-pole clusters ` +
            `overlap; a deformed contour (DLMF §16.17.2 case 3) would be required ` +
            `but is not implemented in v0.1.`,
        };
      }
      c = halveBF(add(maxAjReMinus1, minBjRe, workingBits), workingBits);
    } else if (maxAjReMinus1 !== null) {
      // Only upper poles: place c half a unit to the right.
      c = add(maxAjReMinus1, fromString("0.5", workingBits), workingBits);
    } else if (minBjRe !== null) {
      // Only lower poles: place c half a unit to the left.
      c = sub(minBjRe, fromString("0.5", workingBits), workingBits);
    } else {
      // Unreachable: m + n ≥ 1 ⇒ at least one of allUpper/allLower
      // is non-empty (an or bm contributes to it). Defensive fallback.
      c = fromInt(0n, workingBits);
    }
  }

  // ---------------------------------------------- z must be non-zero
  // `z^s = exp(s · log z)` is undefined at `z = 0`. Surface this
  // honestly rather than letting clog throw an opaque RangeError.
  if (isZero(z.re) && isZero(z.im)) {
    return {
      status: "input-error",
      reason: "z = 0; Mellin-Barnes integrand contains z^s which is undefined at z = 0",
    };
  }

  // logZ computed once at workingBits and closed over by the integrand.
  // The integrand is invoked many times (15 · iterations + truncation
  // sampling); avoiding repeated `clog` is significant.
  const logZ = clog(z, workingBits);

  // ---------------------------------------------- integrand
  const integrand = (t: BigFloat, prec: number): BigComplex => {
    return mellinBarnesIntegrand(params, z, c, t, logZ, prec);
  };

  // ---------------------------------------------- truncation `T`
  let T: BigFloat;
  if (opts.truncate) {
    T = opts.truncate;
  } else {
    T = pickTruncation(integrand, alpha, precision, workingBits);
  }

  // ---------------------------------------------- quadrature
  const negT = neg(T);
  const quadOpts =
    opts.maxEvals !== undefined ? { maxEvals: opts.maxEvals } : undefined;
  let quadResult: BigComplexQuadResult;
  try {
    quadResult = gaussKronrodAdaptiveBC(
      integrand,
      negT,
      T,
      precision,
      quadOpts,
    );
  } catch (e) {
    // Driver throws on misuse (a≥b, prec out of range) or the
    // integrand throws (a Γ-pole coincident with a sample point —
    // shouldn't happen on the midpoint contour but defensively
    // surfaced).
    return {
      status: "input-error",
      reason: `quadrature failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  // ---------------------------------------------- prefactor 1/(2π)
  // The Mellin-Barnes definition has 1/(2πi) outside the integral.
  // With `s = c + it, ds = i dt`, the i in ds combines with the i in
  // 1/(2πi) to leave 1/(2π). The integrand returns BigComplex; the
  // 1/(2π) prefactor multiplies both components.
  const twoPi = mul(fromInt(2n, workingBits), pi(workingBits), workingBits);
  const inv2Pi = div(fromInt(1n, workingBits), twoPi, workingBits);
  const value: BigComplex = {
    re: mul(quadResult.value.re, inv2Pi, workingBits),
    im: mul(quadResult.value.im, inv2Pi, workingBits),
  };

  // ---------------------------------------------- finalise
  const userBits = decimalToBinaryPrecision(precision, 0);
  const warnings: string[] = [...quadResult.warnings];
  if (opts.contourRe === undefined) {
    warnings.push(`auto-selected contour Re(s) = ${bfToString(c, 6)}`);
  }
  if (opts.truncate === undefined) {
    warnings.push(`auto-selected truncation |t| ≤ ${bfToString(T, 6)}`);
  }
  return {
    status: "success",
    value: {
      re: roundTo(value.re, userBits),
      im: roundTo(value.im, userBits),
    },
    achievedPrecision: precision,
    method: "mellin-barnes",
    contourRe: c,
    truncate: T,
    nEvals: quadResult.nEvals,
    converged: quadResult.converged,
    workingPrecision: workingBits,
    warnings,
  };
}

// -----------------------------------------------------------------------------
// Integrand
// -----------------------------------------------------------------------------

/**
 * Build the Mellin-Barnes integrand at `s = c + it`.
 *
 *   M(s) = [Π_{j ∈ bm} Γ(b_j − s)  ·  Π_{j ∈ an} Γ(1 − a_j + s)]
 *          /
 *          [Π_{j ∈ bq} Γ(1 − b_j + s)  ·  Π_{j ∈ ap} Γ(a_j − s)]
 *          ·  z^s
 *
 * `logZ` is closed over (computed once at workingBits) so the call-
 * site doesn't recompute on every quadrature node. `prec` is the
 * working precision the quadrature driver is honouring; we route it
 * through every Γ / cexp / cmul.
 *
 * Performance note. The integrand is invoked `15 · iterations`
 * times during quadrature plus a small number of times for the
 * truncation search. Each invocation does `m + n + (p − n) + (q − m)`
 * `cgamma` calls (8 per evaluation for an `(m=n=p=q=2)` shape — Bessel
 * class). The cgamma cost dominates everything else; that's a
 * reasonable cost model.
 */
function mellinBarnesIntegrand(
  params: MeijerGParameters,
  z: BigComplex,
  c: BigFloat,
  t: BigFloat,
  logZ: BigComplex,
  prec: number,
): BigComplex {
  const { an, ap, bm, bq } = params;
  const s: BigComplex = { re: c, im: t };
  const one = cfromReal(fromInt(1n, prec));
  const onePlusS = cadd(one, s, prec);

  // z^s = exp(s · log z).
  const sLogZ = cmul(s, logZ, prec);
  const zPowS = cexp(sLogZ, prec);

  // Numerator Γ-products.
  let numer = one;
  for (const bj of bm) {
    numer = cmul(numer, cgamma(csub(bj, s, prec), prec), prec);
  }
  for (const aj of an) {
    // Γ(1 - a_j + s) = Γ((1 + s) - a_j).
    numer = cmul(numer, cgamma(csub(onePlusS, aj, prec), prec), prec);
  }

  // Denominator Γ-products.
  let denom = one;
  for (const bj of bq) {
    // Γ(1 - b_j + s) = Γ((1 + s) - b_j).
    denom = cmul(denom, cgamma(csub(onePlusS, bj, prec), prec), prec);
  }
  for (const aj of ap) {
    denom = cmul(denom, cgamma(csub(aj, s, prec), prec), prec);
  }

  return cmul(cdiv(numer, denom, prec), zPowS, prec);
}

// -----------------------------------------------------------------------------
// Truncation selection
// -----------------------------------------------------------------------------

/**
 * Auto-pick the symmetric truncation `T` such that the integrand
 * magnitude at `±T` falls below `2^-X` of the integrand peak, where
 * `X = precision · log2(10) + 20` (precision-relative threshold with
 * a 20-bit headroom for the truncated tail's contribution to the
 * final integral).
 *
 * Strategy:
 *
 * 1. Asymptotic estimate. Decay rate `α` ⇒ `T_init = ceil(X · log(2)
 *    / (π · α))`. For prec=50, α=0.5: `T_init ≈ 80`.
 *
 * 2. Verify by sampling. Evaluate `cabs(integrand(±T_init))` and
 *    compare to `cabs(integrand(0))` (the peak proxy — for
 *    `arg(z) = 0` and symmetric integrands this *is* the peak; for
 *    asymmetric `arg(z)` the actual peak shifts slightly, but the
 *    `|integrand(0)|` proxy is conservative for our threshold check).
 *
 * 3. If the larger of `|integrand(±T)|` exceeds `peakAbs · 2^-X`,
 *    double T and retry. Cap at 20 doublings (covers any reasonable
 *    case; runaway would indicate a bug elsewhere).
 *
 * Returns the chosen T as a BigFloat at workingBits.
 */
function pickTruncation(
  integrand: (t: BigFloat, prec: number) => BigComplex,
  alpha: number,
  precision: number,
  workingBits: number,
): BigFloat {
  // Asymptotic estimate.
  const X = precision * Math.log2(10) + 20;
  const tInitFloat = Math.max(4, Math.ceil((X * Math.log(2)) / (Math.PI * alpha)));

  // Peak proxy.
  const zero = fromInt(0n, workingBits);
  const peakAbs = cabs(integrand(zero, workingBits), workingBits);

  // If peak is exactly zero (degenerate input), any T works — pick the
  // asymptotic estimate and let the quadrature driver report.
  if (isZero(peakAbs)) {
    return fromInt(BigInt(tInitFloat), workingBits);
  }

  // Threshold: peakAbs · 2^-X. Compute as `peakAbs · 2^-X` via powInt
  // (X is a positive number, possibly large).
  const xCeil = Math.ceil(X);
  const twoNegX = powInt(fromInt(2n), -xCeil, workingBits);
  const threshold = mul(peakAbs, twoNegX, workingBits);

  let T = fromInt(BigInt(tInitFloat), workingBits);
  for (let attempts = 0; attempts < 20; attempts++) {
    const negT = neg(T);
    const tailLeft = cabs(integrand(negT, workingBits), workingBits);
    const tailRight = cabs(integrand(T, workingBits), workingBits);
    const maxTail = cmp(tailLeft, tailRight) >= 0 ? tailLeft : tailRight;
    if (cmp(maxTail, threshold) <= 0) return T;
    // Double T.
    T = mul(T, fromInt(2n, workingBits), workingBits);
  }
  // Out of doublings — return current T; quadrature reports as best
  // it can. (Reaching this branch indicates the integrand decays
  // dramatically slower than the Stirling estimate — possibly a bug
  // in the integrand, possibly a degenerate parameter arrangement.
  // The quadrature driver will report `converged: false` and a
  // warning, which is the honest surface.)
  return T;
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

/**
 * Halve a BigFloat exactly (mantissa unchanged, exponent decremented).
 * Mirrors the BF/BC drivers' `halveBF` helper (which is private to
 * those modules); the bigfloat package doesn't yet export a public
 * `halve` primitive. Bit-deterministic; `prec` controls the result's
 * stored precision only.
 */
function halveBF(x: BigFloat, prec: number): BigFloat {
  if (isZero(x)) return x;
  return {
    mantissa: x.mantissa,
    exponent: x.exponent - 1,
    precision: prec,
  };
}

/**
 * Round a BigFloat to a target bit precision via add-with-zero. Same
 * idiom as the quadrature drivers' `roundTo`.
 */
function roundTo(x: BigFloat, prec: number): BigFloat {
  if (x.precision === prec) return x;
  const zero: BigFloat = { mantissa: 0n, exponent: 0, precision: prec };
  return add(x, zero, prec);
}
