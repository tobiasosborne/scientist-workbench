// =============================================================================
// gauss-kronrod.ts — adaptive Gauss-Kronrod 1D quadrature (G7K15)
// =============================================================================
//
// Intent
// ------
// One call: `gaussKronrodAdaptive(f, a, b, opts)`. Returns an
// `agent-honest` record carrying not just the integral value but a
// calibrated error estimate, the number of `f` evaluations spent, an
// honest `converged` boolean, and human-readable warnings. The shape
// mirrors the precedent set by `@workbench/linalg-core`'s `solve`:
// a planner reads the record and decides "trust this / retry / warn
// the user," it does not have to re-derive the diagnostic itself.
//
// Algorithm — global adaptive G7K15 with priority-queue bisection
// ---------------------------------------------------------------
// The local rule is QUADPACK's `dqk15`: a 7-point Gauss-Legendre rule
// nested inside a 15-point Kronrod extension over `[-1, 1]`, mapped
// affinely to a working subinterval. The Kronrod extension reuses the
// 7 Gauss nodes and adds 8 more (chosen to maximise the rule's
// algebraic-exactness order under the constraint of node reuse —
// Kronrod 1965). On a subinterval `[α, β]`:
//
//     centre        = (α + β) / 2
//     halfLength    = (β - α) / 2
//     K15(f) * halfLength      ≈ ∫_α^β f
//     |K15 - G7| * halfLength  ≈ local truncation error
//
// The K15 estimate has algebraic-exactness order 23 (exact for any
// polynomial of degree ≤ 23); the G7 estimate has order 13. The
// difference is therefore *very* sensitive to the smoothness of `f`
// near the subinterval, which is exactly the signal the global
// adaptive driver needs.
//
// We *do not* implement QUADPACK's full Piessens-1983 §1.5.1 error
// rescaling (`min(1, (200 |K-G| / asc)^1.5)` etc.) in v0.1. The
// simpler `|K - G| * halfLength` estimate is a *conservative* upper
// bound on the local truncation error for smooth integrands; it
// over-estimates rather than under-estimates, which keeps the
// `converged` flag honest. The brief explicitly authorises this; the
// sister tool `linalg-equiv` (bead 2t4) is the right place for the
// full QUADPACK error-rescaling story.
//
// The global driver maintains a max-heap of subintervals keyed on
// local error estimate. Each iteration pops the subinterval with the
// largest error, bisects it at the midpoint, evaluates K15 + G7 on
// the two halves, and pushes them back onto the heap. The running
// totals (integral, error) are updated *by delta* — `total +=
// leftNew + rightNew - oldPopped`, same for error — so we never pay
// O(heap size) to re-sum. Termination:
//
//     errorEstimate ≤ atol + rtol * |value|   ⇒  converged = true
//     nEvals        ≥ maxEvals                ⇒  converged = false (budget)
//
// The heap is a flat-array binary max-heap, indexed from 0; left
// child of i is 2i+1, right is 2i+2, parent is (i-1)>>1. Operations:
// `heapPush` (sift up), `heapPop` (extract max + sift down).
// O(log n) per operation; n is bounded by 2 × iterations.
//
// References
// ----------
//   * Kahaner, Moler & Nash, *Numerical Methods and Software* (1989),
//     Ch. 5 — general adaptive-quadrature framework.
//   * Piessens, de Doncker, Überhuber & Kahaner, *QUADPACK* (1983) —
//     the Fortran reference. `dqk15.f` is the local rule we port.
//   * Galassi et al., *GNU Scientific Library Reference Manual*,
//     §16.4 — `gsl/integration/qk15.c` (BSD-equivalent reimpl). The
//     numerical constants below are taken verbatim from GSL's
//     `qk15.c`, where they are documented as "evaluated with 80
//     decimal digit arithmetic by L. W. Fullerton, Bell Labs, Nov.
//     1981" — well above the float64 precision we round them to.

// -----------------------------------------------------------------------------
// G7K15 nodes and weights
// -----------------------------------------------------------------------------
//
// Symmetric about zero — only the non-negative half is stored. Index
// convention matches GSL `qk15.c` (which in turn matches QUADPACK):
//
//   * `XGK[7]` is the centre (x = 0).
//   * `XGK[1], XGK[3], XGK[5]` are the (positive) Gauss-Legendre nodes.
//     Their negative reflections are also Gauss nodes.
//   * `XGK[0], XGK[2], XGK[4], XGK[6]` are the Kronrod-only positive
//     nodes (chosen to optimally extend the 7-point Gauss rule).
//
// `WG[3]` is the centre weight of the 7-point Gauss rule; `WG[0..2]`
// are the weights of the three positive Gauss nodes (each applied
// twice, by symmetry). Total weight: `2*(WG[0]+WG[1]+WG[2]) + WG[3]
// = 2.0`, confirming the rule integrates `1` over `[-1, 1]` exactly.
//
// `WGK[7]` is the centre Kronrod weight; `WGK[0..6]` are the weights
// of the seven positive Kronrod nodes. Same parity check: their
// symmetric sum is 2.0.
//
// Source: gsl/integration/qk15.c (Brian Gough, GSL 2.x).
// Verified: Σ wg = 2 to 1e-15; Σ wgk = 2 to 1e-15; centre weights
// match the QUADPACK Fortran source (dqk15.f) byte-for-byte.

const XGK: readonly number[] = [
  0.991455371120812639206854697526329,
  0.949107912342758524526189684047851,
  0.864864423359769072789712788640926,
  0.741531185599394439863864773280788,
  0.586087235467691130294144838258730,
  0.405845151377397166906606412076961,
  0.207784955007898467600689403773245,
  0.0,
];

const WG: readonly number[] = [
  0.129484966168869693270611432679082,
  0.279705391489276667901467771423780,
  0.381830050505118944950369775488975,
  0.417959183673469387755102040816327,
];

const WGK: readonly number[] = [
  0.022935322010529224963732008058970,
  0.063092092629978553290700663189204,
  0.104790010322250183839876322541518,
  0.140653259715525918745189590510238,
  0.169004726639267902826583426598550,
  0.190350578064785409913256402421014,
  0.204432940075298892414161999234649,
  0.209482141084727828012999174891714,
];

// -----------------------------------------------------------------------------
// QuadResult — agent-honest output
// -----------------------------------------------------------------------------

export type QuadResult = {
  /** Best estimate of `∫_a^b f(x) dx`. */
  readonly value: number;
  /**
   * Conservative cumulative bound on the truncation error: the sum of
   * the surviving subintervals' local `|K15 - G7| * halfLength`
   * estimates after the adaptive loop terminates. For converged runs
   * this is bounded by `atol + rtol * |value|`.
   */
  readonly errorEstimate: number;
  /** Number of `f` evaluations performed. 15 per local rule call. */
  readonly nEvals: number;
  /**
   * `true` iff `errorEstimate ≤ atol + rtol * |value|` was satisfied
   * before the evaluation budget ran out. `false` means the budget
   * was hit; `value` is still the best estimate but `errorEstimate`
   * may exceed the requested tolerance.
   */
  readonly converged: boolean;
  /** Number of bisection iterations performed (= subintervals popped). */
  readonly iterations: number;
  readonly method: "gauss-kronrod-g7k15";
  /**
   * Human-readable diagnostics. Always present (possibly empty) so
   * the consumer can iterate without a null check. Tool layer
   * surfaces these to the agent.
   */
  readonly warnings: readonly string[];
};

export type QuadOptions = {
  /** Absolute tolerance. Default 1e-10. */
  readonly atol?: number;
  /** Relative tolerance. Default 1e-8. */
  readonly rtol?: number;
  /** Maximum function evaluations. Default 10000. */
  readonly maxEvals?: number;
};

const DEFAULT_ATOL = 1e-10;
const DEFAULT_RTOL = 1e-8;
const DEFAULT_MAX_EVALS = 10000;

// -----------------------------------------------------------------------------
// Local G7K15 rule
// -----------------------------------------------------------------------------

/**
 * Heap node: one subinterval `[a, b]`, with its computed K15 integral
 * estimate and its `|K-G|*halfLength` error estimate. `error` is the
 * heap key.
 */
type Subinterval = {
  readonly a: number;
  readonly b: number;
  readonly value: number;
  readonly error: number;
};

/**
 * Apply the G7K15 rule to `f` on `[a, b]`. Returns the K15 integral
 * estimate (the better one) and the local error estimate `|K - G| *
 * halfLength`.
 *
 * Performs exactly 15 evaluations of `f`. Symmetric pairs are
 * computed at `centre ± halfLength * x_i` for `i = 0..6`; the centre
 * is evaluated once.
 *
 * Mirrors `gsl_integration_qk` (GSL 2.x, integration/qk.c) restricted
 * to the n=8 (i.e., G7K15) case, with the Piessens error rescaling
 * deferred — see the file header for why.
 */
function gaussKronrod15(
  f: (x: number) => number,
  a: number,
  b: number,
): { value: number; error: number } {
  const centre = 0.5 * (a + b);
  const halfLength = 0.5 * (b - a);
  const absHalfLength = Math.abs(halfLength);

  const fCentre = f(centre);

  // The Kronrod estimate gets the centre weight (the "8th" entry).
  let kronrod = fCentre * WGK[7]!;
  // The 7-point Gauss rule's centre weight is WG[3] (index 8/2 - 1 = 3).
  let gauss = fCentre * WG[3]!;

  // Sweep i = 0..6 (the seven positive non-zero Kronrod nodes). Each
  // contributes a symmetric pair to the Kronrod sum. The
  // odd-i positions also coincide with positive Gauss nodes — those
  // additionally contribute to the Gauss sum, with the corresponding
  // Gauss weight `WG[(i-1)/2]`.
  for (let i = 0; i < 7; i++) {
    const abscissa = halfLength * XGK[i]!;
    const fLeft = f(centre - abscissa);
    const fRight = f(centre + abscissa);
    const fSum = fLeft + fRight;
    kronrod += WGK[i]! * fSum;
    if (i % 2 === 1) {
      // Positive Gauss-Legendre node. WG[0] for i=1, WG[1] for i=3,
      // WG[2] for i=5. Centre handled above.
      gauss += WG[(i - 1) >> 1]! * fSum;
    }
  }

  // Scale by the Jacobian of the affine map `[-1,1] → [a,b]`.
  const value = kronrod * halfLength;
  // Difference between the order-23 and order-13 estimates, scaled by
  // the same Jacobian (use absHalfLength so reversed intervals would
  // still produce a non-negative error — but the caller guarantees
  // a < b so this is a defensive choice).
  const error = Math.abs(kronrod - gauss) * absHalfLength;

  return { value, error };
}

// -----------------------------------------------------------------------------
// Max-heap on Subintervals keyed on `.error`
// -----------------------------------------------------------------------------
//
// A flat array, indexed from 0. Children of i are 2i+1, 2i+2;
// parent is (i-1) >> 1. We always extract the *max-error*
// subinterval (greedy: focus refinement where error is highest),
// hence "max-heap."
//
// Why a heap, not a list-and-scan: at every iteration we need
// argmax(error). On a heap that's O(log n) per update; on a flat
// list it would be O(n), and with thousands of iterations that
// becomes the dominant cost. The integration tests in
// `quadrature.test.ts` mutation-prove this — ripping out the heap
// and using FIFO bisection causes the convergence-flag-honesty test
// to fail (the budget runs out before the oscillation is resolved).

function heapPush(heap: Subinterval[], item: Subinterval): void {
  heap.push(item);
  // Sift up.
  let i = heap.length - 1;
  while (i > 0) {
    const parent = (i - 1) >> 1;
    if (heap[parent]!.error >= heap[i]!.error) break;
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
  // Sift down.
  const n = heap.length;
  let i = 0;
  for (;;) {
    const left = 2 * i + 1;
    const right = 2 * i + 2;
    let best = i;
    if (left < n && heap[left]!.error > heap[best]!.error) best = left;
    if (right < n && heap[right]!.error > heap[best]!.error) best = right;
    if (best === i) break;
    const tmp = heap[i]!;
    heap[i] = heap[best]!;
    heap[best] = tmp;
    i = best;
  }
  return top;
}

// -----------------------------------------------------------------------------
// Adaptive driver
// -----------------------------------------------------------------------------

export class QuadratureNonFiniteError extends Error {
  /** The argument at which `f` produced a non-finite value. */
  readonly atX: number;
  /** The non-finite value `f(atX)` produced (NaN, +Inf, or -Inf). */
  readonly fValue: number;
  constructor(atX: number, fValue: number) {
    super(`gaussKronrodAdaptive: f produced non-finite value ${fValue} at x = ${atX}`);
    this.name = "QuadratureNonFiniteError";
    this.atX = atX;
    this.fValue = fValue;
  }
}

/**
 * Adaptive G7K15 quadrature on `[a, b]`. Returns a `QuadResult` with
 * value, error estimate, evaluation count, and an honest converged
 * flag.
 *
 * Throws `QuadratureNonFiniteError` if `f` ever produces a non-finite
 * value (NaN, +Inf, -Inf) at any quadrature node. The tool layer
 * translates this into a `tagged "integrate-1d/non-finite-during-eval"`
 * boundary value (ADR-0003 boundary failure: the input was valid but
 * outside the tool's declared scope of finite-valued integrands).
 *
 * Throws `Error` (not the subclass) if `a >= b` — the tool layer
 * catches this earlier and translates to `tagged
 * "integrate-1d/degenerate-interval"`. The library guard is a
 * defensive check; correct callers never trigger it.
 */
export function gaussKronrodAdaptive(
  f: (x: number) => number,
  a: number,
  b: number,
  opts?: QuadOptions,
): QuadResult {
  if (!Number.isFinite(a) || !Number.isFinite(b)) {
    throw new Error(`gaussKronrodAdaptive: bounds must be finite (got a=${a}, b=${b})`);
  }
  if (a >= b) {
    throw new Error(`gaussKronrodAdaptive: require a < b (got a=${a}, b=${b})`);
  }

  const atol = opts?.atol ?? DEFAULT_ATOL;
  const rtol = opts?.rtol ?? DEFAULT_RTOL;
  const maxEvals = opts?.maxEvals ?? DEFAULT_MAX_EVALS;

  // Wrap `f` to fail loudly on non-finite values. We pay one
  // `Number.isFinite` call per evaluation; for the inner loop of an
  // adaptive method this is in the noise compared to the user
  // integrand cost (one `Math.exp` or similar dominates).
  const fGuarded = (x: number): number => {
    const v = f(x);
    if (!Number.isFinite(v)) throw new QuadratureNonFiniteError(x, v);
    return v;
  };

  // Initial G7K15 evaluation over the whole interval. 15 evals.
  let nEvals = 15;
  const initial = gaussKronrod15(fGuarded, a, b);

  let value = initial.value;
  let errorEstimate = initial.error;
  let iterations = 0;
  const warnings: string[] = [];

  // Already converged on the first pass — skip the heap entirely.
  // Cheap-and-common case for smooth integrands on small intervals.
  if (errorEstimate <= atol + rtol * Math.abs(value)) {
    return {
      value,
      errorEstimate,
      nEvals,
      converged: true,
      iterations,
      method: "gauss-kronrod-g7k15",
      warnings,
    };
  }

  // Otherwise: priority-queue bisection.
  const heap: Subinterval[] = [];
  heapPush(heap, { a, b, value: initial.value, error: initial.error });

  let converged = false;
  // Each iteration evaluates 15 + 15 = 30 new function values. The
  // budget check is *before* the next bisection: we stop iterating
  // as soon as the next pair would push us over.
  while (heap.length > 0 && nEvals + 30 <= maxEvals) {
    if (errorEstimate <= atol + rtol * Math.abs(value)) {
      converged = true;
      break;
    }

    const worst = heapPop(heap);
    const mid = 0.5 * (worst.a + worst.b);

    const left = gaussKronrod15(fGuarded, worst.a, mid);
    const right = gaussKronrod15(fGuarded, mid, worst.b);
    nEvals += 30;
    iterations += 1;

    // Update running totals by delta. The popped subinterval's
    // contribution is replaced by the two children's contributions;
    // doing this incrementally keeps the per-iteration cost O(log
    // heapSize) rather than O(heapSize).
    value += left.value + right.value - worst.value;
    errorEstimate += left.error + right.error - worst.error;

    // Floating-point can take `errorEstimate` slightly negative when
    // local refinement hugely improves the estimate. Clamp to zero —
    // negative cumulative error is meaningless and would defeat the
    // termination check below.
    if (errorEstimate < 0) errorEstimate = 0;

    heapPush(heap, { a: worst.a, b: mid, value: left.value, error: left.error });
    heapPush(heap, { a: mid, b: worst.b, value: right.value, error: right.error });
  }

  // Final post-loop convergence check (the loop may exit on the
  // budget condition before re-checking convergence).
  if (errorEstimate <= atol + rtol * Math.abs(value)) {
    converged = true;
  }

  if (!converged) {
    warnings.push(
      `did not converge to atol=${atol.toExponential(2)} rtol=${rtol.toExponential(2)} within maxEvals=${maxEvals}; reported errorEstimate may exceed requested tolerance`,
    );
  }

  return {
    value,
    errorEstimate,
    nEvals,
    converged,
    iterations,
    method: "gauss-kronrod-g7k15",
    warnings,
  };
}
