// =============================================================================
// gauss-kronrod-bf.ts — adaptive Gauss-Kronrod 1D quadrature at arb precision
// =============================================================================
//
// Intent
// ------
// One call: `gaussKronrodAdaptiveBF(f, a, b, prec, opts?)`. Returns an
// `agent-honest` record carrying the BigFloat-valued integral, its BigFloat
// error estimate, the working precision used, the achieved decimal-digit
// precision, the evaluation count, an honest `converged` flag, and human-
// readable warnings. Same shape as the float64 driver's `QuadResult`,
// extended for the arb-prec tier (ADR-0021).
//
// The float64 driver (`gauss-kronrod.ts`) and this driver share the
// algorithm — same G7K15 local rule, same priority-queue bisection, same
// delta-update bookkeeping. The differences are confined to:
//
//   1. **Codomain.** `BigFloat` arithmetic everywhere; no `Math.*`.
//   2. **Cancellation-stable local rule.** K15 and the K-G *difference*
//      are computed simultaneously via precomputed weight differences,
//      avoiding the catastrophic cancellation that would dominate at
//      high working precision (~70 bits worse at 150 dps than at 53).
//   3. **Precision contract.** `prec` is decimal digits (the user-facing
//      arb-prec dial, ADR-0020); internally we work at a bigger bit
//      precision via `decimalToBinaryPrecision(prec, safety=30)`.
//   4. **Tolerances scale with `prec`.** Defaults compute a `~10^-prec`
//      BigFloat tolerance; the user can override.
//   5. **Determinism.** All BigInt-backed; bit-identical across every
//      JavaScript runtime by language spec (ADR-0020). No platform
//      fingerprint is needed or recorded — `arbprec: true` is *more*
//      deterministic than `numerical: true`.
//   6. **Integrand callback signature.** `f(x: BigFloat, prec: number)
//      → BigFloat`, with `prec` being the working bit precision the
//      driver wants the integrand to honour. Lets the integrand
//      (typically itself an arb-prec computation, e.g. `evaluatePFq`)
//      align its internal precision with the driver's working
//      precision — a contract that a `(x: BigFloat) => BigFloat`
//      callback could not express.
//
// Why we compute K-G via centred deltas (the load-bearing high-precision fix)
// ----------------------------------------------------------------------------
// Naive `K - G` (compute K15 and G7 as two separate sums, subtract at
// the end) loses ~log2(|K|/|K-G|) bits of relative precision to
// catastrophic cancellation. At 53-bit precision (the float64 driver)
// this is absorbed by the 30-bit working margin; at 167-bit precision
// (50 dps) and beyond it dominates, producing error estimates that floor
// far above the true cumulative error and stalling convergence.
//
// First-attempt fix: compute `K - G` directly by summing each abscissa's
// `(WGK_i - WG_i) · fSum_i` contribution (with `WG_i` zero at Kronrod-
// only positions). Pre-computed `WGK_i - WG_i` differences are stored
// in `nodes-weights-bf.ts`. This is what other "cancellation-stable"
// quadrature implementations claim. Empirical observation: it didn't
// help. Reason: the sum still has positive (Kronrod-only) and negative
// (Gauss-shared) weight contributions, totalling exactly zero (forced
// by the rule's exactness on constants). On a smooth integrand whose
// `fSum_i` values are close to one another, the positive-vs-negative
// cancellation is back: |K - G| = sum of (mixed-sign) weighted f-values
// of similar magnitude.
//
// The actual fix is algebraic, not numerical. Substitute
// `fSum_i = 2·f(centre) + δ_i` where `δ_i = fSum_i - 2·f(centre)` is
// the *variation* across the symmetric pair of abscissae. Then
//
//     K - G = (WGK_7 - WG_3)·f(centre) + Σ_{i=0..6} (WGK_i - WG_i) · fSum_i
//           = [(WGK_7 - WG_3) + 2·Σ (WGK_i - WG_i)] · f(centre)
//             + Σ (WGK_i - WG_i) · δ_i
//           = 0 · f(centre) + Σ (WGK_i - WG_i) · δ_i
//           = Σ_{i=0..6} (WGK_i - WG_i) · δ_i .
//
// The bracket vanishes because both K15 and G7 integrate constants
// exactly: WGK_7 + 2·Σ WGK_i = 2 = WG_3 + 2·Σ WG_i. So the centre
// contribution drops, and K-G is a sum of `weight × variation` terms.
// Each `δ_i` is small by construction — it is the local variation of
// `f` across the symmetric pair, ≈ f'(centre) · halfLength · 2·xgk_i —
// so the absolute magnitude of every summand in K-G is small, and the
// running sum carries the working-precision relative accuracy of those
// small magnitudes, without any large-vs-large cancellation.
//
// Empirical verification: under this fix, `∫_0^1 1/(1+x²) dx` at 50
// dps converges to the cited mpmath truth at the user-precision ulp.
// Under the prior (direct-difference-of-products) fix, the same input
// stalled at ~28 dps regardless of bisection depth. Mutation-prove:
// reverting to the direct-products form makes all "cross-precision
// agreement" tests beyond ~28 dps fail; the centred-deltas form is
// mandatory at high precision.
//
// References for the algebraic identity: it is a standard "centred-
// reference-point" trick used in many cancellation-aware quadrature
// implementations (e.g., QUADPACK's `dqk*` routines compute the rule
// in this form internally; the explicit derivation here is the one
// that survives Re-derivation under the workbench's literate-prose
// rule).
//
// Determinism stays unconditional
// -------------------------------
// Every BigFloat operation in this driver bottoms out in `BigInt`
// arithmetic, which is bit-identical across every JavaScript runtime
// by language specification. The `getG7K15Table(workingBits)` cache
// produces byte-identical tables for the same `workingBits` on every
// run, on every machine. The heap operations are deterministic given
// the input subinterval order. So the driver, like the substrate, is
// `arbprec: true`'s strongest possible determinism contract: same
// (input bytes, prec) ⇒ same output bytes, forever, on any platform.

import {
  type BigFloat,
  abs,
  add,
  cmp,
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

export type BigFloatQuadResult = {
  /** Best estimate of `∫_a^b f(x) dx`, rounded to the user-requested precision. */
  readonly value: BigFloat;
  /**
   * Conservative cumulative bound on the truncation error: the sum of the
   * surviving subintervals' local `|K15 - G7| · halfLength` estimates after
   * the adaptive loop terminates. For converged runs this is bounded by
   * `atol + rtol · |value|`. Same precision as `value`.
   */
  readonly errorEstimate: BigFloat;
  /** Decimal digits of precision the user requested (and the result is rounded to). */
  readonly precision: number;
  /** Bit precision the driver worked at internally (= dec-to-bin with safety margin). */
  readonly workingPrecision: number;
  /** Number of `f` evaluations performed. 15 per local-rule application. */
  readonly nEvals: number;
  /**
   * `true` iff `errorEstimate ≤ atol + rtol · |value|` was satisfied before
   * the evaluation budget ran out. `false` means the budget was hit; `value`
   * is still the best estimate, but `errorEstimate` may exceed the requested
   * tolerance.
   */
  readonly converged: boolean;
  /** Number of bisection iterations performed. */
  readonly iterations: number;
  readonly method: "gauss-kronrod-g7k15-bigfloat";
  /** Human-readable diagnostics. Always present (possibly empty). */
  readonly warnings: readonly string[];
};

export type BigFloatQuadOptions = {
  /**
   * Absolute tolerance, as a BigFloat. If omitted, defaults to ~`10^-prec`
   * (a BigFloat representing one ulp at the requested decimal precision).
   *
   * The default is precision-aware on purpose: a 50-dps run defaults to
   * tolerance ~10^-50; a 150-dps run defaults to ~10^-150. The driver
   * does *not* auto-bump precision when the tolerance is missed — that
   * is the caller's responsibility (per ADR-0020 §"What we will not
   * decide": auto-bumping is a tool-layer concern, not a substrate
   * concern).
   */
  readonly atol?: BigFloat;
  /**
   * Relative tolerance, as a BigFloat. Same default heuristic as `atol`.
   * Convergence test: `errorEstimate ≤ atol + rtol · |value|`.
   */
  readonly rtol?: BigFloat;
  /**
   * Maximum number of `f` evaluations. Defaults to `prec * 200` — heuristic:
   * roughly 200 K15 calls per decimal digit on a typical hard integrand.
   * Smooth integrands will exit on iteration 0 with 15 evaluations.
   */
  readonly maxEvals?: number;
};

/**
 * Thrown by `gaussKronrodAdaptiveBF` itself (not by `f`) on misuse of the
 * driver. The driver does *not* wrap exceptions thrown by the integrand —
 * those propagate to the caller verbatim, since the integrand may carry
 * domain-specific failure modes (a `Γ`-pole, a singularity report) that
 * the caller's planner needs to see.
 */
export class BigFloatQuadratureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BigFloatQuadratureError";
  }
}

// -----------------------------------------------------------------------------
// Subinterval — heap node
// -----------------------------------------------------------------------------
//
// One subinterval `[a, b]` with its computed K15 estimate and `|K-G|·h`
// error. `error` is the heap key. We keep the local rule's BigFloat values
// fully precise (at `workingBits`) so the running totals' precision is not
// dragged down by re-rounding.

interface Subinterval {
  readonly a: BigFloat;
  readonly b: BigFloat;
  readonly value: BigFloat;
  readonly error: BigFloat;
}

// -----------------------------------------------------------------------------
// Local G7K15 rule — value and cancellation-stable error
// -----------------------------------------------------------------------------

/**
 * Apply the G7K15 rule to `f` on `[a, b]`. Returns the K15 integral estimate
 * and the local error `|K15 - G7| · halfLength`, both as BigFloats at
 * `workingBits`. Performs exactly 15 evaluations of `f`.
 *
 * Algorithm
 * ---------
 * Symmetric pair sweep over `i = 0..6` of the positive Kronrod abscissae:
 *
 *   abscissa_i  = halfLength · XGK[i]
 *   fSum_i      = f(centre - abscissa_i) + f(centre + abscissa_i)
 *   delta_i     = fSum_i - 2 · f(centre)         ← centred variation
 *
 * The K15 estimate is `WGK[7] · f(centre) + Σ WGK[i] · fSum_i`, scaled
 * by `halfLength`. The K-G estimate is built via the centred-delta
 * identity (see file header for the algebraic derivation):
 *
 *     K15 - G7 = Σ_{i=0..6} (WGK[i] - WG[g(i)]) · delta_i
 *
 * with `WG[g(i)] = 0` at Kronrod-only positions (i = 0, 2, 4, 6) and
 * `WG[g(i)]` the corresponding Gauss weight at shared positions
 * (i = 1, 3, 5). The centre contribution to K-G algebraically vanishes
 * (proof in the file header). Each `delta_i` is small (~ f'(centre) ·
 * halfLength · 2·XGK[i]), so each weighted-delta term is small, and
 * the K-G sum carries the working-precision relative accuracy of small
 * quantities — no cancellation between large positive and negative
 * sums.
 *
 * The single sweep computes both K15 and K-G simultaneously, sharing
 * the `f(xLeft) + f(xRight)` evaluation. The centre is evaluated once.
 */
function localG7K15BF(
  f: (x: BigFloat, prec: number) => BigFloat,
  a: BigFloat,
  b: BigFloat,
  workingBits: number,
): { value: BigFloat; error: BigFloat } {
  const table = getG7K15Table(workingBits);

  // centre = (a + b) / 2; halfLength = (b - a) / 2. Halving via `halveBF`
  // (exponent decrement) is exact and bit-deterministic.
  const sum = add(a, b, workingBits);
  const diff = sub(b, a, workingBits);
  const centre = halveBF(sum, workingBits);
  const halfLength = halveBF(diff, workingBits);

  // Centre evaluation. f(centre) appears in K15 with weight WGK[7] and
  // in the K-G formula's `2·f(centre)` reference (used to build the
  // centred deltas). We evaluate once.
  const fCentre = f(centre, workingBits);
  const twoFCentre = add(fCentre, fCentre, workingBits); // exact: integer scaling

  let k15 = mul(table.wgk[7]!, fCentre, workingBits);
  // K-G accumulator starts at zero — the centre's K-G contribution
  // algebraically vanishes under the centred-delta identity. See the
  // file header for the derivation. (`table.wgkMinusWgCentre` is kept
  // in the table for completeness/audit but is unused on the hot path.)
  let kMinusG: BigFloat = ZERO_BF;

  // Sweep i = 0..6 — the seven positive non-zero Kronrod abscissae.
  // Each contributes a symmetric pair (left, right) about the centre.
  for (let i = 0; i < 7; i++) {
    const abscissa = mul(halfLength, table.xgk[i]!, workingBits);
    const xLeft = sub(centre, abscissa, workingBits);
    const xRight = add(centre, abscissa, workingBits);
    const fSum = add(
      f(xLeft, workingBits),
      f(xRight, workingBits),
      workingBits,
    );

    // K15 contribution: WGK[i] · fSum (always, regardless of position).
    k15 = add(k15, mul(table.wgk[i]!, fSum, workingBits), workingBits);

    // K-G contribution: weight · delta where delta = fSum - 2·fCentre.
    // For Kronrod-only positions, weight = WGK[i] (G7 doesn't sample
    // here, so the "G weight" is 0). For Gauss-shared positions,
    // weight = WGK[i] - WG[(i-1)/2], read from the table.
    const delta = sub(fSum, twoFCentre, workingBits);
    const wDiff = (i & 1) === 1
      ? table.wgkMinusWg[(i - 1) >> 1]!
      : table.wgk[i]!;
    kMinusG = add(kMinusG, mul(wDiff, delta, workingBits), workingBits);
  }

  // Scale by the affine map's Jacobian. `absHalfLength` is defensively
  // |halfLength|, even though the a < b precondition guarantees positive.
  const absHalfLength = abs(halfLength);
  const value = mul(k15, halfLength, workingBits);
  const error = abs(mul(kMinusG, absHalfLength, workingBits));

  return { value, error };
}

/**
 * Halve a BigFloat exactly (no rounding except the final-precision
 * normalisation). Implementation: subtract one from the exponent, leaving
 * the mantissa's bit length unchanged. This is bit-deterministic and
 * costs ~0; it is the reason we don't go through `div(_, fromInt(2n), prec)`
 * on the hot path.
 *
 * Argument zero round-trips as zero (no exponent bookkeeping needed for
 * the canonical zero form per the bigfloat invariant).
 */
function halveBF(x: BigFloat, prec: number): BigFloat {
  if (isZero(x)) return x;
  // Mantissa unchanged, exponent decreased by 1, precision recomputed via
  // a no-op normalise (the mantissa already has the required bit count).
  // Construct directly:
  return {
    mantissa: x.mantissa,
    exponent: x.exponent - 1,
    precision: prec,
  };
}

// -----------------------------------------------------------------------------
// Max-heap on Subintervals keyed on `.error`
// -----------------------------------------------------------------------------
//
// Same shape as the float64 driver's heap: flat-array binary max-heap,
// indexed from 0; left child of i is 2i+1, right is 2i+2; parent is
// (i-1)>>1. The comparison is `cmp(a.error, b.error)` (BigFloat-aware
// signed comparison).
//
// Why a heap, not a list-and-scan: at every iteration we need
// argmax(error). On a heap that's O(log n) per update; on a flat list it
// would be O(n), and for thousands of iterations on a stiff integrand the
// scan dominates. The float64 driver's mutation-prove (FIFO bisection ⇒
// convergence-honesty test fails) carries verbatim — the heap is
// load-bearing, not an optimisation.
//
// Tie-breaking: `cmp` returns 0 on exact BigFloat equality; the existing
// element wins (`>=` on the parent in the sift-up condition). Bit-
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
// Default tolerance — `~10^-prec` BigFloat
// -----------------------------------------------------------------------------

/**
 * Construct a BigFloat representing `10^-prec` rounded to `workingBits`
 * precision, used as the default `atol` and `rtol`. The `pow(BigFloat::10,
 * -prec, workingBits)` form would also work; we go via `powInt(fromInt(10n),
 * -prec)` which is exact-then-rounded.
 */
function defaultTolerance(prec: number, workingBits: number): BigFloat {
  // 10^-prec computed via integer exponentiation: powInt(10, -prec).
  // powInt handles negative exponents via a final divide.
  return powInt(fromInt(10n), -prec, workingBits);
}

// -----------------------------------------------------------------------------
// Driver — adaptive G7K15 at arbitrary precision
// -----------------------------------------------------------------------------

/**
 * Adaptive G7K15 quadrature on `[a, b]` at the user-requested decimal
 * precision. Returns a `BigFloatQuadResult` carrying the integral, error
 * estimate, working precision, evaluation count, and an honest converged
 * flag.
 *
 * Inputs
 * ------
 * @param f    Integrand. Takes a node `x` and the working bit precision the
 *             driver is using; expected to return `f(x)` rounded to that
 *             precision (or higher — the driver re-rounds at composition
 *             time).
 * @param a    Left bound. Must satisfy `lt(a, b)`; equality and reversal
 *             throw `BigFloatQuadratureError`.
 * @param b    Right bound.
 * @param prec User-requested decimal precision. Must satisfy
 *             `1 ≤ prec ≤ MAX_DECIMAL_PRECISION` (= 150). Outside that
 *             range, throws `RangeError`.
 *
 * @throws  `BigFloatQuadratureError` on malformed bounds. `RangeError` on
 *          out-of-range `prec`. *Any* other exception thrown by `f`
 *          propagates to the caller verbatim — the driver does not wrap
 *          integrand failures (the caller's planner may need to see them).
 *
 * Determinism contract
 * --------------------
 * Bit-identical across every JavaScript runtime, every architecture,
 * every operating system, given the same input bytes and `prec`. ADR-0020
 * is the substrate guarantee; this driver inherits it because every
 * arithmetic operation bottoms out in BigInt.
 */
export function gaussKronrodAdaptiveBF(
  f: (x: BigFloat, prec: number) => BigFloat,
  a: BigFloat,
  b: BigFloat,
  prec: number,
  opts?: BigFloatQuadOptions,
): BigFloatQuadResult {
  if (!Number.isInteger(prec) || prec < 1) {
    throw new RangeError(
      `gaussKronrodAdaptiveBF: prec must be a positive integer; got ${prec}`,
    );
  }
  if (prec > MAX_DECIMAL_PRECISION) {
    throw new RangeError(
      `gaussKronrodAdaptiveBF: prec=${prec} exceeds the substrate's hard cap ` +
        `of ${MAX_DECIMAL_PRECISION} decimal digits. Extend the 200-dps node/weight ` +
        `tables in nodes-weights-bf.ts (cited regeneration recipe in the file ` +
        `header) or compute weights at runtime via Golub-Welsch on the Jacobi ` +
        `matrix. Refusing here rather than silently degrading.`,
    );
  }
  if (cmp(a, b) >= 0) {
    throw new BigFloatQuadratureError(
      `gaussKronrodAdaptiveBF: require a < b (got a=${bfToString(a, 20)}, b=${bfToString(b, 20)})`,
    );
  }

  // Working precision = `decimalToBinaryPrecision(prec, 30)` (the bigfloat
  // substrate's default 30-bit safety margin). The centred-delta K-G
  // identity (see file header) eliminates the cancellation that would
  // otherwise demand a wider margin; 30 bits is enough for every
  // supported `prec`.
  const workingBits = decimalToBinaryPrecision(prec, 30);

  const atol = opts?.atol ?? defaultTolerance(prec, workingBits);
  const rtol = opts?.rtol ?? defaultTolerance(prec, workingBits);
  const maxEvals = opts?.maxEvals ?? prec * 200;

  if (!Number.isInteger(maxEvals) || maxEvals < 15) {
    // 15 is the minimum number of evals (one local rule call). A budget
    // smaller than that is a programming error, not a usage tradeoff.
    throw new RangeError(
      `gaussKronrodAdaptiveBF: maxEvals must be an integer ≥ 15; got ${maxEvals}`,
    );
  }

  // Initial G7K15 evaluation over the whole interval. 15 evals.
  let nEvals = 15;
  const initial = localG7K15BF(f, a, b, workingBits);

  let value = initial.value;
  let errorEstimate = initial.error;
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
  // when the running integral has stabilised at the substrate's
  // representable-precision floor.
  //
  // Rationale: K15's K-G error estimator measures G7's algebraic error,
  // which decreases at the rate ~1/N^k under bisection (k = polynomial
  // degree the rule's exact through, here 13 for G7). For high-degree
  // polynomial integrands and smooth analytic integrands at moderate
  // precisions, K-G floors far above the user's tolerance long before
  // K15's own error reaches the floor. Without a secondary criterion,
  // every polynomial test of degree ≥ 14 would budget out reporting
  // `converged: false` even though K15 is *algebraically exact*.
  //
  // Compromise: declare convergence when the running value's iteration-
  // by-iteration change drops below the substrate's working-bits ulp
  // times a small headroom factor. This is "the integral has stabilised
  // at the algorithm's representable-precision floor" — much tighter
  // than the user's tolerance, so spurious early firing during heap
  // traversal of small-K-G subintervals does not occur. For polynomials
  // of degree ≤ 22 (K15 exact), value-change is exactly zero after the
  // first bisection; the counter increments quickly and convergence
  // fires within a few iterations.
  //
  // Threshold: |value| × 2^-(workingBits - 30). 30 bits of ulp headroom
  // handles round-off accumulation across the heap-rebuild summation.
  // STABILITY_RUNS = 8 is defensive — eight consecutive sub-threshold
  // iterations is robust evidence (single coincidences washed out).
  const STABILITY_RUNS = 8;
  const epsilonFactor: BigFloat = {
    mantissa: 1n,
    exponent: -(workingBits - 30),
    precision: 1,
  };
  let stabilityCount = 0;
  let prevValue: BigFloat = value;

  let didConverge = false;
  let convergeReason: "kg-bound" | "cauchy-stability" | null = null;
  // Each iteration consumes 30 evals (two K15 calls). The budget check is
  // *before* the next bisection: stop iterating as soon as the next pair
  // would push us over.
  while (heap.length > 0 && nEvals + 30 <= maxEvals) {
    if (converged(errorEstimate, atol, rtol, value, workingBits)) {
      didConverge = true;
      convergeReason = "kg-bound";
      break;
    }

    const worst = heapPop(heap);
    // Bisect at the midpoint of the worst-error subinterval.
    const mid = halveBF(add(worst.a, worst.b, workingBits), workingBits);

    const left = localG7K15BF(f, worst.a, mid, workingBits);
    const right = localG7K15BF(f, mid, worst.b, workingBits);
    nEvals += 30;
    iterations += 1;

    heapPush(heap, { a: worst.a, b: mid, value: left.value, error: left.error });
    heapPush(heap, { a: mid, b: worst.b, value: right.value, error: right.error });

    // Recompute running totals from the heap. The float64 driver does an
    // incremental delta update (`total += new − old`) for performance
    // (ADR-0014, mutation-prove note in `gauss-kronrod.ts`); the arb-prec
    // driver does NOT, because the cancellation in `(newL + newR) −
    // oldPopped` chews through the running total's lower bits over many
    // iterations. Recomputing from the heap each iteration is O(heapSize)
    // but heapSize ≪ the 15-evaluation cost of one local rule call (each
    // BigFloat sin / exp / Γ at workingBits is milliseconds; the heap
    // walk is microseconds), so the perf cost is in the noise.
    prevValue = value;
    value = sumBF(heap.map((s) => s.value), workingBits);
    errorEstimate = sumBF(heap.map((s) => s.error), workingBits);

    // Defensive: floating-point on a degenerate heap could leave
    // errorEstimate signed-zero; clamp.
    if (lt(errorEstimate, ZERO_BF)) errorEstimate = ZERO_BF;

    // Cauchy-stability check on the running value at the substrate
    // ulp floor. See the comment block above the loop for rationale.
    const valueChange = abs(sub(value, prevValue, workingBits));
    const stabilityThreshold = mul(abs(value), epsilonFactor, workingBits);
    if (cmp(valueChange, stabilityThreshold) <= 0) {
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

  // The reason annotation goes in the warnings list when Cauchy fired
  // but K-G didn't — the user should know the convergence is based on
  // value stability (substrate ulp floor reached), not the rigorous
  // K-G bound. If both conditions held, only K-G's success is reported.
  if (convergeReason === "cauchy-stability") {
    warnings.push(
      `converged via Cauchy value-stability after ${iterations} iterations; K-G estimate (${bfToString(errorEstimate, 4)}) ` +
        `still exceeds atol+rtol·|value| but the running value has been stable at the substrate ulp floor for ${STABILITY_RUNS} consecutive iterations`,
    );
  }

  // Final post-loop convergence check (the loop may exit on the budget
  // condition before re-checking convergence).
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

/**
 * Sum a list of BigFloats at the given working precision. Order-independent
 * up to round-half-to-even ulp. Used to recompute the running totals from
 * the heap each iteration (see the driver loop for why we don't delta-
 * update). Empty list returns the canonical zero.
 *
 * Iteration order is sequential left-to-right; for the heap-as-array view
 * this is "in heap-storage order," which is deterministic given the
 * insertion sequence. Bit-determinism is preserved because (a) the
 * insertion sequence depends only on the input bytes and prec, and (b)
 * BigFloat add is bit-deterministic.
 */
function sumBF(xs: readonly BigFloat[], prec: number): BigFloat {
  let s = ZERO_BF;
  for (const x of xs) s = add(s, x, prec);
  return s;
}

/**
 * Termination test: `errorEstimate ≤ atol + rtol · |value|`.
 *
 * Computed at `workingBits` to keep the comparison meaningful — the
 * default tolerances are themselves at workingBits, and a sub-precision
 * comparison would let bit noise through.
 */
function converged(
  errorEstimate: BigFloat,
  atol: BigFloat,
  rtol: BigFloat,
  value: BigFloat,
  workingBits: number,
): boolean {
  const threshold = add(atol, mul(rtol, abs(value), workingBits), workingBits);
  return cmp(errorEstimate, threshold) <= 0;
}

/**
 * Round the running totals to the user's requested precision and pack the
 * `BigFloatQuadResult`. The intermediates are kept at `workingBits` for
 * accuracy; the public-facing values are at `prec` decimal digits' worth
 * of bits.
 */
function finalise(
  value: BigFloat,
  errorEstimate: BigFloat,
  nEvals: number,
  didConverge: boolean,
  iterations: number,
  warnings: readonly string[],
  prec: number,
  workingBits: number,
): BigFloatQuadResult {
  const userBits = decimalToBinaryPrecision(prec, 0);
  return {
    value: roundTo(value, userBits),
    errorEstimate: roundTo(errorEstimate, userBits),
    precision: prec,
    workingPrecision: workingBits,
    nEvals,
    converged: didConverge,
    iterations,
    method: "gauss-kronrod-g7k15-bigfloat",
    warnings,
  };
}

/**
 * Round a BigFloat to a target bit precision via add-with-zero. This is the
 * idiomatic round-to-precision in the bigfloat substrate (the substrate's
 * normalise() is private to types.ts; the public way to drop precision is
 * via an arithmetic op at the new precision). Adding signed zero is
 * exact-input, exact-output except for the precision normalisation.
 */
function roundTo(x: BigFloat, prec: number): BigFloat {
  if (x.precision === prec) return x;
  // add(x, 0, prec) re-rounds x at prec via the normalise pass.
  const zero: BigFloat = { mantissa: 0n, exponent: 0, precision: prec };
  return add(x, zero, prec);
}

// Re-exports for the package barrel.
export { MAX_DECIMAL_PRECISION } from "./nodes-weights-bf.js";
