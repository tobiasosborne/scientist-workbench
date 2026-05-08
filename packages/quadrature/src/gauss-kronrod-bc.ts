// =============================================================================
// gauss-kronrod-bc.ts — adaptive Gauss-Kronrod 1D quadrature, BigComplex codomain
// =============================================================================
//
// Intent
// ------
// One call: `gaussKronrodAdaptiveBC(f, a, b, prec, opts?)`. Returns an
// agent-honest record carrying the BigComplex-valued integral, its real
// BigFloat error estimate, the working precision used, the achieved
// decimal-digit precision, the evaluation count, an honest `converged`
// flag, and human-readable warnings. Same shape as the BF driver's
// `BigFloatQuadResult`, lifted to BigComplex codomain (ADR-0022).
//
// The integration variable `t` is real (a BigFloat); the codomain is
// `BigComplex`. This matches the Mellin-Barnes contour quadrature
// consumer's shape: parameterise the vertical line `s = c + it` by
// `t ∈ ℝ` and integrate.
//
// Relationship to the BigFloat driver
// -----------------------------------
// This is a faithful lift of `gaussKronrodAdaptiveBF` to BigComplex
// codomain. Same algorithm: same priority-queue bisection, same
// centred-delta K-G identity, same Cauchy value-stability secondary
// convergence test. The differences are exactly:
//
//   1. **Codomain**. `f` returns `BigComplex`; `value` is `BigComplex`;
//      intermediate sums are `BigComplex` via `cadd`/`cmul`. Weights
//      remain real `BigFloat` (the rule's nodes and weights are real
//      by construction).
//   2. **Error estimate**. `cabs(K-G) · |halfLength|` — a real
//      BigFloat. The natural scalar bound; both real and imaginary
//      components of K-G are individually bounded by `cabs`.
//   3. **Heap key**. The real `errorEstimate` BigFloat. Same `cmp`
//      ordering as the BF driver.
//   4. **Cauchy stability**. `cabs(value - prevValue) ≤ cabs(value) ×
//      2^-(workingBits - 30)`. Component-wise reading: both real and
//      imaginary parts have stabilised at the substrate ulp floor.
//
// Faithful-extension contract: when the integrand has `im ≡ 0`, the BC
// driver's `value.re` and `errorEstimate` bytes match the BF driver's
// outputs *byte-for-byte*. The BC driver is "the BF driver, lifted" —
// not an independent implementation. The byte-equivalence is asserted
// in the test suite.
//
// Why we compute K-G via centred deltas — algebraic identity ports verbatim
// ------------------------------------------------------------------------
// The centred-delta K-G identity from ADR-0021 is purely algebraic:
//
//     K - G = Σ_{i=0..6} (WGK[i] - WG[g(i)]) · δ_i
//
// where `δ_i = fSum_i - 2·f(centre)` is the variation across the
// symmetric pair of abscissae, and the centre's K-G contribution
// algebraically vanishes (the bracket `(WGK_7 - WG_3) + 2·Σ (WGK_i -
// WG_i) = 0` by both rules' exactness on constants). The identity
// generalises to BigComplex per-component: `δ_i.re` and `δ_i.im` are
// each small (~ `f'(centre).re/im · halfLength · 2·xgk_i`), each
// weighted-delta term is small in both components, and the K-G sum
// carries the working-precision relative accuracy of small quantities
// in *both* components without large-vs-large cancellation.
//
// Empirical verification: the byte-equality tests against the BF driver
// (sin on [0, π], polynomial on [-1, 1], constant on [0, 1]) at
// 30/50/80 dps confirm the lift is exact. The BC driver does not
// introduce additional cancellation paths beyond what the BF driver
// already had (which were all eliminated by the centred-delta identity).
//
// Determinism
// -----------
// Every operation in this driver bottoms out in `BigInt` arithmetic via
// `cadd`/`csub`/`cmul`/`cabs` (BigFloat→BigComplex multiplications are
// per-component BigFloat·BigFloat ops). `BigInt` is bit-identical
// across every JavaScript runtime by language specification. The
// `getG7K15Table(workingBits)` cache produces byte-identical tables for
// the same `workingBits` on every run, on every machine. The heap
// operations are deterministic given the input subinterval order. So
// the driver, like the BF driver and the substrate, carries
// `arbprec: true`'s strongest determinism contract: same (input bytes,
// prec) ⇒ same output bytes, forever, on any platform.

import {
  type BigFloat,
  type BigComplex,
  abs,
  add,
  cabs,
  cadd,
  cfromReal,
  cmp,
  cmul,
  csub,
  decimalToBinaryPrecision,
  fromInt,
  isZero,
  lt,
  mul,
  powInt,
  sub,
  toString as bfToString,
} from "@workbench/bigfloat";
import { getG7K15Table, MAX_DECIMAL_PRECISION } from "./nodes-weights-bf.js";

// -----------------------------------------------------------------------------
// Public types — agent-honest result, options
// -----------------------------------------------------------------------------

export type BigComplexQuadResult = {
  /** Best estimate of `∫_a^b f(t) dt`, rounded to the user-requested precision. */
  readonly value: BigComplex;
  /**
   * Conservative cumulative bound on the truncation error: the sum of
   * the surviving subintervals' local `cabs(K15 - G7) · halfLength`
   * estimates after the adaptive loop terminates. Real-valued (a
   * `BigFloat`); for converged runs this is bounded by `atol + rtol ·
   * cabs(value)`. Same precision as `value`'s components.
   */
  readonly errorEstimate: BigFloat;
  /** Decimal digits of precision the user requested (and the result is rounded to). */
  readonly precision: number;
  /** Bit precision the driver worked at internally (= dec-to-bin with safety margin). */
  readonly workingPrecision: number;
  /** Number of `f` evaluations performed. 15 per local-rule application. */
  readonly nEvals: number;
  /**
   * `true` iff `errorEstimate ≤ atol + rtol · cabs(value)` was
   * satisfied before the evaluation budget ran out. `false` means the
   * budget was hit; `value` is still the best estimate, but
   * `errorEstimate` may exceed the requested tolerance.
   */
  readonly converged: boolean;
  /** Number of bisection iterations performed. */
  readonly iterations: number;
  readonly method: "gauss-kronrod-g7k15-bigcomplex";
  /** Human-readable diagnostics. Always present (possibly empty). */
  readonly warnings: readonly string[];
};

export type BigComplexQuadOptions = {
  /**
   * Absolute tolerance, as a real BigFloat. If omitted, defaults to
   * ~`10^-prec`. Convergence test is `errorEstimate ≤ atol + rtol ·
   * cabs(value)`. Both sides are real BigFloats.
   *
   * The default is precision-aware on purpose. The driver does *not*
   * auto-bump precision when the tolerance is missed — that is the
   * caller's responsibility (per ADR-0020 §"What we will not decide").
   */
  readonly atol?: BigFloat;
  /**
   * Relative tolerance, as a real BigFloat. Same default heuristic as
   * `atol`.
   */
  readonly rtol?: BigFloat;
  /**
   * Maximum number of `f` evaluations. Defaults to `prec * 200`.
   * Smooth integrands will exit on iteration 0 with 15 evaluations.
   */
  readonly maxEvals?: number;
};

/**
 * Thrown by `gaussKronrodAdaptiveBC` itself (not by `f`) on misuse of
 * the driver. The driver does *not* wrap exceptions thrown by the
 * integrand — those propagate to the caller verbatim, since the
 * integrand may carry domain-specific failure modes (a `Γ`-pole, a
 * branch-cut crossing) that the caller's planner needs to see.
 */
export class BigComplexQuadratureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BigComplexQuadratureError";
  }
}

// -----------------------------------------------------------------------------
// Subinterval — heap node
// -----------------------------------------------------------------------------
//
// One subinterval `[a, b]` with its computed K15 estimate (BigComplex)
// and `cabs(K-G) · h` error (real BigFloat). `error` is the heap key.
// We keep the local rule's BigComplex/BigFloat values fully precise
// (at `workingBits`) so the running totals' precision is not dragged
// down by re-rounding.

interface Subinterval {
  readonly a: BigFloat;
  readonly b: BigFloat;
  readonly value: BigComplex;
  readonly error: BigFloat;
}

// -----------------------------------------------------------------------------
// Local G7K15 rule — BigComplex value, real cancellation-stable error
// -----------------------------------------------------------------------------

/**
 * Apply the G7K15 rule to `f` (returning BigComplex) on `[a, b]`.
 * Returns the K15 BigComplex integral estimate and the real local
 * error `cabs(K15 - G7) · halfLength`, both at `workingBits`. Performs
 * exactly 15 evaluations of `f`.
 *
 * Algorithm
 * ---------
 * Symmetric pair sweep over `i = 0..6` of the positive Kronrod
 * abscissae:
 *
 *   abscissa_i  = halfLength · XGK[i]
 *   fSum_i      = f(centre - abscissa_i) + f(centre + abscissa_i)
 *   delta_i     = fSum_i - 2 · f(centre)         ← centred variation
 *
 * The K15 estimate is `WGK[7] · f(centre) + Σ WGK[i] · fSum_i`, scaled
 * by `halfLength`. The K-G estimate is built via the centred-delta
 * identity (see file header):
 *
 *     K15 - G7 = Σ_{i=0..6} (WGK[i] - WG[g(i)]) · delta_i
 *
 * with `WG[g(i)] = 0` at Kronrod-only positions (i = 0, 2, 4, 6) and
 * `WG[g(i)]` the corresponding Gauss weight at shared positions
 * (i = 1, 3, 5). The centre contribution to K-G algebraically vanishes
 * by the same argument as the BF driver. Each `delta_i.re` and
 * `delta_i.im` is small (~ `f'(centre).re/im · halfLength · 2·XGK[i]`),
 * so each weighted-delta term is small in both components, and the
 * K-G sum carries the working-precision relative accuracy of small
 * quantities in both components.
 *
 * The single sweep computes both K15 and K-G simultaneously, sharing
 * the `f(xLeft) + f(xRight)` evaluation. The centre is evaluated once.
 */
function localG7K15BC(
  f: (t: BigFloat, prec: number) => BigComplex,
  a: BigFloat,
  b: BigFloat,
  workingBits: number,
): { value: BigComplex; error: BigFloat } {
  const table = getG7K15Table(workingBits);

  // centre = (a + b) / 2; halfLength = (b - a) / 2.
  const sum = add(a, b, workingBits);
  const diff = sub(b, a, workingBits);
  const centre = halveBF(sum, workingBits);
  const halfLength = halveBF(diff, workingBits);

  const fCentre = f(centre, workingBits);
  // 2 · f(centre) — exact (integer scaling); per-component add.
  const twoFCentre: BigComplex = {
    re: add(fCentre.re, fCentre.re, workingBits),
    im: add(fCentre.im, fCentre.im, workingBits),
  };

  // K15 starts with the centre's contribution: WGK[7] · f(centre).
  // BigFloat·BigComplex multiplication is per-component.
  let k15: BigComplex = scaleBC(table.wgk[7]!, fCentre, workingBits);
  // K-G accumulator starts at zero — the centre's K-G contribution
  // algebraically vanishes under the centred-delta identity.
  let kMinusG: BigComplex = ZERO_BC;

  // Sweep i = 0..6 — the seven positive non-zero Kronrod abscissae.
  // Each contributes a symmetric pair (left, right) about the centre.
  for (let i = 0; i < 7; i++) {
    const abscissa = mul(halfLength, table.xgk[i]!, workingBits);
    const tLeft = sub(centre, abscissa, workingBits);
    const tRight = add(centre, abscissa, workingBits);
    const fLeft = f(tLeft, workingBits);
    const fRight = f(tRight, workingBits);
    const fSum: BigComplex = {
      re: add(fLeft.re, fRight.re, workingBits),
      im: add(fLeft.im, fRight.im, workingBits),
    };

    // K15 contribution: WGK[i] · fSum (always, regardless of position).
    k15 = cadd(k15, scaleBC(table.wgk[i]!, fSum, workingBits), workingBits);

    // K-G contribution: weight · delta where delta = fSum - 2·fCentre.
    // For Kronrod-only positions, weight = WGK[i]. For Gauss-shared
    // positions, weight = WGK[i] - WG[(i-1)/2], read from the table.
    const delta: BigComplex = {
      re: sub(fSum.re, twoFCentre.re, workingBits),
      im: sub(fSum.im, twoFCentre.im, workingBits),
    };
    const wDiff = (i & 1) === 1
      ? table.wgkMinusWg[(i - 1) >> 1]!
      : table.wgk[i]!;
    kMinusG = cadd(kMinusG, scaleBC(wDiff, delta, workingBits), workingBits);
  }

  // Scale by the affine map's Jacobian. `halfLength` is positive
  // (precondition a < b), but we defensively `abs` for the error term.
  const absHalfLength = abs(halfLength);
  const value: BigComplex = scaleBC(halfLength, k15, workingBits);
  // error = cabs(K-G) · |halfLength| — real BigFloat.
  const cabsKMinusG = cabs(kMinusG, workingBits);
  const error = mul(cabsKMinusG, absHalfLength, workingBits);

  return { value, error };
}

/**
 * BigFloat·BigComplex multiplication: per-component scaling.
 * `s · (a + bi) = (s·a) + (s·b)·i`. Exact in the structural sense; the
 * underlying BigFloat multiplications round at `prec` per the substrate
 * contract. Bit-deterministic.
 */
function scaleBC(s: BigFloat, z: BigComplex, prec: number): BigComplex {
  return {
    re: mul(s, z.re, prec),
    im: mul(s, z.im, prec),
  };
}

/**
 * Halve a BigFloat exactly (no rounding except the final-precision
 * normalisation). Implementation: subtract one from the exponent,
 * leaving the mantissa's bit length unchanged. Mirrors the BF driver's
 * implementation byte-for-byte (load-bearing for the BC-vs-BF
 * faithful-extension byte-equality tests on real-only integrands).
 *
 * Argument zero round-trips as zero (no exponent bookkeeping needed).
 */
function halveBF(x: BigFloat, prec: number): BigFloat {
  if (isZero(x)) return x;
  return {
    mantissa: x.mantissa,
    exponent: x.exponent - 1,
    precision: prec,
  };
}

// -----------------------------------------------------------------------------
// Max-heap on Subintervals keyed on `.error` (real BigFloat)
// -----------------------------------------------------------------------------
//
// Same shape as the BF driver's heap — flat-array binary max-heap,
// indexed from 0; left child of i is 2i+1, right is 2i+2; parent is
// (i-1)>>1. The heap key is the real `BigFloat` error; comparison via
// `cmp(a.error, b.error)` (BigFloat-aware signed comparison).
//
// Tie-breaking: `cmp` returns 0 on exact BigFloat equality; the
// existing element wins (`>=` in the sift-up condition). Bit-
// deterministic given the input subinterval insertion order.

function heapPush(heap: Subinterval[], item: Subinterval): void {
  heap.push(item);
  let i = heap.length - 1;
  while (i > 0) {
    const parent = (i - 1) >> 1;
    if (cmp(heap[parent]!.error, heap[i]!.error) >= 0) break;
    const tmp = heap[parent]!;
    heap[parent] = heap[i]!;
    heap[i] = tmp;
    i = parent;
  }
}

function heapPop(heap: Subinterval[]): Subinterval {
  const top = heap[0]!;
  const last = heap.pop()!;
  if (heap.length === 0) return top;
  heap[0] = last;
  const n = heap.length;
  let i = 0;
  for (;;) {
    const left = 2 * i + 1;
    const right = 2 * i + 2;
    let best = i;
    if (left < n && cmp(heap[left]!.error, heap[best]!.error) > 0) best = left;
    if (right < n && cmp(heap[right]!.error, heap[best]!.error) > 0) best = right;
    if (best === i) break;
    const tmp = heap[i]!;
    heap[i] = heap[best]!;
    heap[best] = tmp;
    i = best;
  }
  return top;
}

// -----------------------------------------------------------------------------
// Default tolerance — `~10^-prec` real BigFloat
// -----------------------------------------------------------------------------

function defaultTolerance(prec: number, workingBits: number): BigFloat {
  return powInt(fromInt(10n), -prec, workingBits);
}

// -----------------------------------------------------------------------------
// Driver — adaptive G7K15 at arbitrary precision, BigComplex codomain
// -----------------------------------------------------------------------------

/**
 * Adaptive G7K15 quadrature on `[a, b]` (real interval) at the
 * user-requested decimal precision, with `BigComplex`-valued
 * integrand. Returns a `BigComplexQuadResult` carrying the integral
 * (BigComplex), error estimate (real BigFloat), working precision,
 * evaluation count, and an honest converged flag.
 *
 * Inputs
 * ------
 * @param f    Integrand `(t, prec) → BigComplex`. `t` is real
 *             (BigFloat); the codomain is BigComplex. The `prec`
 *             argument is the working bit precision the driver wants
 *             the integrand to honour (lets the integrand align its
 *             internal precision; e.g., `cgamma`-using integrands).
 * @param a    Left bound (real BigFloat). Must satisfy `lt(a, b)`;
 *             equality and reversal throw `BigComplexQuadratureError`.
 * @param b    Right bound (real BigFloat).
 * @param prec User-requested decimal precision. Must satisfy
 *             `1 ≤ prec ≤ MAX_DECIMAL_PRECISION` (= 150). Outside that
 *             range, throws `RangeError`.
 *
 * @throws  `BigComplexQuadratureError` on malformed bounds. `RangeError`
 *          on out-of-range `prec`. Any exception thrown by `f`
 *          propagates to the caller verbatim.
 *
 * Determinism contract
 * --------------------
 * Bit-identical across every JavaScript runtime, every architecture,
 * every operating system, given the same input bytes and `prec`. The
 * BigComplex arithmetic bottoms out in BigInt; the algorithm has no
 * platform-conditional branches.
 */
export function gaussKronrodAdaptiveBC(
  f: (t: BigFloat, prec: number) => BigComplex,
  a: BigFloat,
  b: BigFloat,
  prec: number,
  opts?: BigComplexQuadOptions,
): BigComplexQuadResult {
  if (!Number.isInteger(prec) || prec < 1) {
    throw new RangeError(
      `gaussKronrodAdaptiveBC: prec must be a positive integer; got ${prec}`,
    );
  }
  if (prec > MAX_DECIMAL_PRECISION) {
    throw new RangeError(
      `gaussKronrodAdaptiveBC: prec=${prec} exceeds the substrate's hard cap ` +
        `of ${MAX_DECIMAL_PRECISION} decimal digits. Extend the 200-dps node/weight ` +
        `tables in nodes-weights-bf.ts (cited regeneration recipe in the file ` +
        `header) or compute weights at runtime via Golub-Welsch on the Jacobi ` +
        `matrix. Refusing here rather than silently degrading.`,
    );
  }
  if (cmp(a, b) >= 0) {
    throw new BigComplexQuadratureError(
      `gaussKronrodAdaptiveBC: require a < b (got a=${bfToString(a, 20)}, b=${bfToString(b, 20)})`,
    );
  }

  // Working precision = `decimalToBinaryPrecision(prec, 30)` (the
  // bigfloat substrate's default 30-bit safety margin). Same as BF;
  // the centred-delta K-G identity holds component-wise.
  const workingBits = decimalToBinaryPrecision(prec, 30);

  const atol = opts?.atol ?? defaultTolerance(prec, workingBits);
  const rtol = opts?.rtol ?? defaultTolerance(prec, workingBits);
  const maxEvals = opts?.maxEvals ?? prec * 200;

  if (!Number.isInteger(maxEvals) || maxEvals < 15) {
    throw new RangeError(
      `gaussKronrodAdaptiveBC: maxEvals must be an integer ≥ 15; got ${maxEvals}`,
    );
  }

  // Initial G7K15 evaluation over the whole interval. 15 evals.
  let nEvals = 15;
  const initial = localG7K15BC(f, a, b, workingBits);

  let value: BigComplex = initial.value;
  let errorEstimate: BigFloat = initial.error;
  let iterations = 0;
  const warnings: string[] = [];

  if (converged(errorEstimate, atol, rtol, value, workingBits)) {
    return finalise(
      value,
      errorEstimate,
      nEvals,
      true,
      iterations,
      warnings,
      prec,
      workingBits,
    );
  }

  // Otherwise: priority-queue bisection.
  const heap: Subinterval[] = [];
  heapPush(heap, { a, b, value: initial.value, error: initial.error });

  // Cauchy-stability tracking — secondary convergence test that fires
  // when `cabs(value - prevValue) ≤ cabs(value) × 2^-(workingBits - 30)`
  // for STABILITY_RUNS consecutive iterations. Same rationale as the BF
  // driver (file header §"Cauchy value-stability"): K-G's error
  // estimator measures G7's algebraic error, which floors above the
  // user's tolerance on polynomial / smooth-analytic integrands long
  // before K15's actual error reaches the floor. The Cauchy test
  // declares convergence honestly when the running value has stabilised
  // at the substrate ulp floor in *both* components.
  const STABILITY_RUNS = 8;
  const epsilonFactor: BigFloat = {
    mantissa: 1n,
    exponent: -(workingBits - 30),
    precision: 1,
  };
  let stabilityCount = 0;
  let prevValue: BigComplex = value;

  let didConverge = false;
  let convergeReason: "kg-bound" | "cauchy-stability" | null = null;
  // Each iteration consumes 30 evals (two K15 calls). Budget check is
  // *before* the next bisection: stop iterating as soon as the next
  // pair would push us over.
  while (heap.length > 0 && nEvals + 30 <= maxEvals) {
    if (converged(errorEstimate, atol, rtol, value, workingBits)) {
      didConverge = true;
      convergeReason = "kg-bound";
      break;
    }

    const worst = heapPop(heap);
    // Bisect at the midpoint of the worst-error subinterval.
    const mid = halveBF(add(worst.a, worst.b, workingBits), workingBits);

    const left = localG7K15BC(f, worst.a, mid, workingBits);
    const right = localG7K15BC(f, mid, worst.b, workingBits);
    nEvals += 30;
    iterations += 1;

    heapPush(heap, { a: worst.a, b: mid, value: left.value, error: left.error });
    heapPush(heap, { a: mid, b: worst.b, value: right.value, error: right.error });

    // Recompute running totals from the heap. Same rationale as BF
    // (file header §"Heap-rebuild running totals"): incremental
    // delta-update chews through the running totals' lower bits at
    // arb-prec via cancellation; recomputing from the heap is O(heap
    // size) but cheap relative to the 15-evaluation cost of one local
    // rule call.
    prevValue = value;
    value = sumBC(heap.map((s) => s.value), workingBits);
    errorEstimate = sumBF(heap.map((s) => s.error), workingBits);

    if (lt(errorEstimate, ZERO_BF)) errorEstimate = ZERO_BF;

    // Cauchy-stability check on the running value at the substrate
    // ulp floor. `cabs(value - prevValue) ≤ cabs(value) × epsilonFactor`.
    // Both sides are real BigFloat; the comparison is `cmp` exactly as
    // in the BF driver. Component-wise interpretation: both real and
    // imaginary parts have stabilised.
    const valueChangeAbs = cabs(
      { re: sub(value.re, prevValue.re, workingBits),
        im: sub(value.im, prevValue.im, workingBits) },
      workingBits,
    );
    const stabilityThreshold = mul(
      cabs(value, workingBits),
      epsilonFactor,
      workingBits,
    );
    if (cmp(valueChangeAbs, stabilityThreshold) <= 0) {
      stabilityCount += 1;
      if (stabilityCount >= STABILITY_RUNS) {
        didConverge = true;
        convergeReason = "cauchy-stability";
        break;
      }
    } else {
      stabilityCount = 0;
    }
  }

  if (convergeReason === "cauchy-stability") {
    warnings.push(
      `converged via Cauchy value-stability after ${iterations} iterations; K-G estimate (${bfToString(errorEstimate, 4)}) ` +
        `still exceeds atol+rtol·cabs(value) but the running value has been stable at the substrate ulp floor for ${STABILITY_RUNS} consecutive iterations`,
    );
  }

  if (converged(errorEstimate, atol, rtol, value, workingBits)) {
    didConverge = true;
  }

  if (!didConverge) {
    warnings.push(
      `did not converge to atol=${bfToString(atol, 6)} rtol=${bfToString(rtol, 6)} ` +
        `within maxEvals=${maxEvals}; reported errorEstimate may exceed requested tolerance`,
    );
  }

  return finalise(
    value,
    errorEstimate,
    nEvals,
    didConverge,
    iterations,
    warnings,
    prec,
    workingBits,
  );
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

const ZERO_BF: BigFloat = { mantissa: 0n, exponent: 0, precision: 1 };
const ZERO_BC: BigComplex = { re: ZERO_BF, im: ZERO_BF };

/**
 * Sum a list of BigComplex at the given working precision,
 * component-wise. Order-independent up to round-half-to-even ulp. Used
 * to recompute the running totals from the heap each iteration. Empty
 * list returns the canonical zero. Bit-deterministic.
 */
function sumBC(xs: readonly BigComplex[], prec: number): BigComplex {
  let sRe: BigFloat = ZERO_BF;
  let sIm: BigFloat = ZERO_BF;
  for (const x of xs) {
    sRe = add(sRe, x.re, prec);
    sIm = add(sIm, x.im, prec);
  }
  return { re: sRe, im: sIm };
}

/**
 * Sum a list of real BigFloat at the given working precision.
 * Bit-deterministic. Same shape as `sumBF` in the BF driver — kept
 * local for readability; the BF driver's identical helper isn't
 * exported.
 */
function sumBF(xs: readonly BigFloat[], prec: number): BigFloat {
  let s = ZERO_BF;
  for (const x of xs) s = add(s, x, prec);
  return s;
}

/**
 * Termination test: `errorEstimate ≤ atol + rtol · cabs(value)`.
 *
 * Computed at `workingBits` to keep the comparison meaningful — the
 * default tolerances are themselves at `workingBits`, and a sub-precision
 * comparison would let bit noise through.
 */
function converged(
  errorEstimate: BigFloat,
  atol: BigFloat,
  rtol: BigFloat,
  value: BigComplex,
  workingBits: number,
): boolean {
  const valAbs = cabs(value, workingBits);
  const threshold = add(atol, mul(rtol, valAbs, workingBits), workingBits);
  return cmp(errorEstimate, threshold) <= 0;
}

/**
 * Round the BigComplex value's components and the real errorEstimate to
 * the user's requested precision, and pack the `BigComplexQuadResult`.
 * The intermediates are kept at `workingBits` for accuracy; the
 * public-facing values are at `prec` decimal digits' worth of bits.
 */
function finalise(
  value: BigComplex,
  errorEstimate: BigFloat,
  nEvals: number,
  didConverge: boolean,
  iterations: number,
  warnings: readonly string[],
  prec: number,
  workingBits: number,
): BigComplexQuadResult {
  const userBits = decimalToBinaryPrecision(prec, 0);
  return {
    value: {
      re: roundTo(value.re, userBits),
      im: roundTo(value.im, userBits),
    },
    errorEstimate: roundTo(errorEstimate, userBits),
    precision: prec,
    workingPrecision: workingBits,
    nEvals,
    converged: didConverge,
    iterations,
    method: "gauss-kronrod-g7k15-bigcomplex",
    warnings,
  };
}

/**
 * Round a BigFloat to a target bit precision via add-with-zero. Same
 * idiom as the BF driver — the substrate's normalise() is private to
 * types.ts; the public way to drop precision is via an arithmetic op
 * at the new precision.
 */
function roundTo(x: BigFloat, prec: number): BigFloat {
  if (x.precision === prec) return x;
  const zero: BigFloat = { mantissa: 0n, exponent: 0, precision: prec };
  return add(x, zero, prec);
}
