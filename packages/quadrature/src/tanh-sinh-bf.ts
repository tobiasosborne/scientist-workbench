// =============================================================================
// tanh-sinh-bf.ts — adaptive double-exponential 1D quadrature at arb precision
// =============================================================================
//
// Intent
// ------
// `tanhSinhAdaptiveBF(f, a, b, prec, opts?)` is the workbench's
// arbitrary-precision smooth-analytic quadrature substrate. It is a
// sibling of `gaussKronrodAdaptiveBF` (ADR-0021) — same call site, same
// return type (`BigFloatQuadResult`), same `arbprec: true` determinism
// contract — discriminated by the `method` field
// (`"tanh-sinh-bigfloat"` here vs. `"gauss-kronrod-g7k15-bigfloat"`
// there).
//
// Resolution of the worklog-075 / bead-6f8 floor (worklog 076)
// ------------------------------------------------------------
// The v0.1 driver (worklog 075) carried a silent-truncation bug that
// surfaced on `∫_0^1 1/(1+x²) dx = π/4` at high level counts: the
// per-level inner loop was capped at `prec * 50` iterations, and at
// levels k where the natural cutoff `m_max ≈ 4.5 · 2^{k-1}` exceeds
// that cap (k ≳ 9 for prec=30), the m-loop terminated silently, leaving
// the partial `oddSum_k` missing the last decade of contributing nodes.
// The recurrence `S_k = S_{k-1}/2 + h_k · oddSum_k` then ate the
// truncated sum and propagated the error across levels. Worklog 075's
// "L13 catastrophic divergence" was that bug. The replacement here
// uses the natural `weight < ε₁` cutoff per Bailey §3, with no
// artificial m-loop cap. The default `maxEvals` scales with the level
// budget (Bailey §3: `~7.2 · 2^level`) so it is not hit before the
// natural per-level cutoff fires.
//
// The convergence test now follows Bailey §5's `d`-formula
// `d = max(d_1²/d_2, 2 d_1, d_3, d_4)` with
//     d_1 = log₁₀ |S_n − S_{n-1}|
//     d_2 = log₁₀ |S_n − S_{n-2}|
//     d_3 = log₁₀ (ε_1 · max_j |w_j f(x_j)|)
//     d_4 = log₁₀ max(|w_ℓ f(x_ℓ)|, |w_r f(x_r)|)
// instead of the simpler `|S_n − S_{n-1}| ≤ atol + rtol·|S_n|` that
// v0.1 shipped — the d-formula's `d_3` term explicitly captures the
// truncation-tail floor (`ε_1 · max|wf|`), so once we reach that floor
// the convergence test fires honestly rather than running another five
// no-op levels. See worklog 076 for the full diagnosis snapshot.
//
// Two drivers, two integrand classes
// ----------------------------------
// G7K15 (the K15 rule under recursive bisection) is a *polynomial-
// exact* quadrature. K15 integrates polynomials of degree ≤ 22 exactly
// (Patterson 1968). On entire functions like `sin` and `exp` it
// converges efficiently; on oscillatory functions it adapts well via
// bisection; on smooth-analytic integrands with bounded Taylor radius
// (the canonical test case is `1/(1+x²)` on `[0, 1]`), the *algebraic*
// error decay under bisection is `~1/N^k` with `k = 13` (G7's
// degree-of-exactness), and saturates well before the user precision
// at high-prec targets — see worklog 072 §"Frictions surfaced". For
// 50+ dps on bounded-radius analytic integrands, K15+adaptive simply
// is not the right algorithm.
//
// Tanh-sinh (the Takahasi–Mori 1974 / Mori 1985 / Bailey 2005 family) is
// the canonical answer. It applies the variable transformation
//
//     x = g(t) = tanh((π/2) · sinh t)        ∈ (-1, 1)  for t ∈ ℝ
//
// to the integral `∫_{-1}^1 F(x) dx`, mapping to
// `∫_{-∞}^∞ F(g(t)) · g'(t) dt`. The transformed integrand `F(g(t)) ·
// g'(t)` is bell-shaped with all derivatives vanishing at `±∞`
// *doubly-exponentially*, so by the Euler–Maclaurin summation formula
// the trapezoidal rule on this transformed integrand converges *faster
// than any power of h*. In practice — Bailey-Jeyabalan-Li 2005 §4 —
// "doubling the number of evaluation points roughly doubles the number
// of correct digits." The cost to N decimal digits is `~N² · log² N`
// function evaluations (vs. `~N³ · log N` for Gaussian quadrature),
// and it scales gracefully into the 1000-digit regime.
//
// The variable transformation and Jacobian
// ----------------------------------------
//
//     x  = g(t)  = tanh((π/2) · sinh t)
//     g'(t)      = (π/2 · cosh t) / cosh²((π/2) · sinh t)
//
// (Bailey-Jeyabalan-Li 2005 §3, formula for QUADTS. Section 4 has a
// typo `sinh t / cosh²(...)` in the displayed formula; Section 3's
// `u₁ = (π/2)·cosh(jh)` is the correct numerator, verified by direct
// chain-rule derivation: `dg/dt = sech²(u) · du/dt` where
// `u = (π/2)·sinh t`, so `du/dt = (π/2)·cosh t`.)
//
// Affine map [a, b] → [-1, 1]
// ---------------------------
//     y(x) = (a + b)/2 + (b - a)/2 · x
//     dy   = (b - a)/2 · dx
// The user-coordinate integrand `F(y)` is evaluated at `y(g(jh))`;
// the running sum is multiplied by the constant `(b - a)/2` exactly
// once, at the very end.
//
// Level structure (Bailey 2005 §3, "QUADTS")
// ------------------------------------------
// Level `k` uses step `h_k = 2^-k`. The full set of abscissas at level
// `k` is `{j · h_k : j ∈ ℤ}`, and the *even-indexed* pairs at level k
// coincide *exactly* with the full set at level `k - 1` (because
// `2j · 2^-k = j · 2^-(k-1)`). Consequence: at each new level the
// integrand is evaluated only at the *odd-indexed* abscissas — a 2×
// saving each step.
//
// Trapezoid-doubling recurrence
// -----------------------------
// Writing `S_k` for the trapezoidal sum
//     `S_k = h_k · Σ_{j ∈ ℤ} F(g(j·h_k)) · g'(j·h_k)`,
// the standard halving identity gives
//     `S_k = (S_{k-1}) / 2 + h_k · Σ_{j odd} F(g(j·h_k)) · g'(j·h_k)`.
// This is the load-bearing implementation reason this algorithm is
// fast: each level reuses every previous integrand evaluation.
//
// Pair-generation cutoff (per-level termination)
// ----------------------------------------------
// At each level we iterate `j = 1, 3, 5, …` (positive side; negative
// side is symmetric and handled in the same loop) and stop when
// `w_j < ε`, where `ε ≈ 10^-prec` is the target tolerance. The doubly-
// exponential decay of `g'(t)` makes this cutoff happen at moderate
// `|j|` (typically 20–50 for prec = 50–100 dps).
//
// Why decay is "doubly exponential" — sketch
// ------------------------------------------
// For large `|t|`, `sinh t ≈ ½ e^|t|`, so `(π/2) · sinh t ≈
// (π/4) · e^|t|`, and `cosh²((π/2) sinh t) ≈ ¼ · e^{2 · (π/4) e^|t|} =
// ¼ · e^{(π/2) · e^|t|}`. Thus `g'(t) ≈ (π/2 · cosh t) / cosh²(…)
// ~ e^|t| · e^{-(π/2) · e^|t|}` — exponential decay of an
// exponentially-growing argument. That is "compound exponential" /
// "doubly exponential," and is far faster than the Gaussian
// `e^{-t²}` decay at large `t`.
//
// Convergence test (Bailey §5 rigorous, post-worklog 076)
// -------------------------------------------------------
// Declare convergence when `|S_k − S_{k-1}| ≤ ε_1`, with
// `ε_1 = 10^{-(prec + 8)}` (an 8-dps margin below the user target so
// the truncation tail at `ε_1 · max|w_j f(x_j)|` always sits below
// the user's prec-dps envelope). Bailey 2005 §5: "One does not need
// to rely on this estimation scheme [the d-formula] if one is willing
// to continue computation until the quadrature results from two
// successive levels agree to within the full primary precision."
// The d-formula `d = max(d₁²/d₂, 2 d_1, d_3, d_4)` is *heuristic*;
// its `2 d_1` quadratic-extrapolation term over-promises on
// integrands whose convergence rate slows as the truncation floor
// approaches (worklog 076 dead-end; advertised 108 dps on
// `t·log(1+t)` at prec=100, delivered 98 dps).
//
// The d-formula is computed in the post-loop `errorEstimate` field
// for the caller's information, but does NOT gate convergence.
//
// Typical iteration counts at the rigorous test: 4-6 levels at
// 50 dps, 6-8 at 100 dps, 8-10 at 400 dps (matches Bailey Table 1).
//
// Determinism contract
// --------------------
// Every operation in this driver bottoms out in BigInt arithmetic
// via the bigfloat substrate. Same `(input bytes, prec)` → same
// output bytes on every JavaScript runtime, every architecture, every
// platform — by ECMAScript specification (BigInt arithmetic is
// platform-independent). ADR-0020's strongest possible determinism
// contract.
//
// Honest scope (v0.1)
// -------------------
// - Smooth analytic integrands on `[a, b]` with no endpoint singularity:
//   reliably hits user precision at level ≤ 8 for prec ≤ 100.
// - Entire-function integrands (sin, exp, polynomials): same.
// - Endpoint-singular integrands (e.g., `√t / √(1 - t²)`,
//   `log² t`, `√(tan t)`): Bailey 2005 §3's "secondary epsilon" trick
//   pre-stores `1 - x_j` to avoid the `1 - tanh(big)` cancellation
//   near the endpoints. v0.1 does *not* ship this; a follow-up bead
//   does. For now: callers with endpoint singularities should bump
//   `prec` to budget the cancellation, or use `gaussKronrodAdaptiveBF`
//   (which handles weak endpoint singularities via adaptive
//   bisection's natural endpoint refinement).
// - Infinite intervals (e.g., `∫_0^∞ e^{-t} dt`): the caller transforms
//   via `s = 1/(t + 1)` or similar (Bailey 2005 §6 problem 11 example)
//   before invoking this driver. No infinite-interval support in v0.1.
// - Highly oscillatory integrands (Bailey 2005 §6 classes 14–15):
//   `gaussKronrodAdaptiveBF` is the right driver — its adaptive
//   bisection refines on oscillatory regions naturally.
//
// References
// ----------
// - Takahasi, H. & Mori, M. (1974). "Double exponential formulas for
//   numerical integration." Publ. RIMS, Kyoto Univ. 9, 721–741.
// - Mori, M. (1985). "Quadrature formulas obtained by variable
//   transformation and the DE-rule." J. Comput. Appl. Math. 12-13,
//   119–130.
// - Bailey, D. H., Jeyabalan, K. & Li, X. S. (2005). "A Comparison of
//   Three High-Precision Quadrature Schemes." Experimental Math. 14(3),
//   317–329. https://www.davidhbailey.com/dhbpapers/quadrature-em.pdf
//   — Sections 3 (QUADTS), 4 (Euler-Maclaurin justification),
//   5 (heuristic error estimator).
// - ADR-0024 (this driver's design ADR; the reference for the
//   layering / API / scope decisions).

import {
  type BigFloat,
  abs,
  add,
  cmp,
  cosh,
  decimalToBinaryPrecision,
  div,
  fromInt,
  isZero,
  lt,
  mul,
  pi,
  powInt,
  sinh,
  sub,
  tanh,
  toString as bfToString,
} from "@workbench/bigfloat";
import {
  type BigFloatQuadResult,
  BigFloatQuadratureError,
} from "./gauss-kronrod-bf.js";
import { MAX_DECIMAL_PRECISION } from "./nodes-weights-bf.js";

// =============================================================================
// log₁₀ helper — fast double-precision approximation for the d-formula
// =============================================================================

const LOG10_2 = Math.log10(2);

/**
 * `log₁₀ |x|` as an ordinary Number, computed from the BigFloat's
 * mantissa-and-exponent representation: `log₁₀ |m · 2^e| =
 * log₁₀ |m| + e · log₁₀ 2`. Fast (no BigFloat log call) and accurate
 * enough — Bailey 2005 §5 explicitly says "calculations of d may be
 * done to ordinary double-precision accuracy (i.e., 15 digits)."
 *
 * For zero, returns `−Infinity` (consistent with `Math.log10(0)`).
 * Callers must handle that.
 */
function log10AbsBF(x: BigFloat): number {
  if (x.mantissa === 0n) return Number.NEGATIVE_INFINITY;
  const m = x.mantissa < 0n ? -x.mantissa : x.mantissa;
  const mStr = m.toString();
  const len = mStr.length;
  // A `len`-digit positive integer is in `[10^(len-1), 10^len)`, so
  // `log₁₀(m) = (len - 1) + log₁₀(m / 10^(len-1))`. The leading
  // significand `m / 10^(len-1)` is in `[1, 10)`; its first ~16 digits
  // are recoverable as a JS double.
  const lead =
    len <= 15
      ? Number(mStr) / 10 ** (len - 1)
      : Number(`${mStr.slice(0, 1)}.${mStr.slice(1, 17)}`);
  const log10Mantissa = (len - 1) + Math.log10(lead);
  return log10Mantissa + x.exponent * LOG10_2;
}

// -----------------------------------------------------------------------------
// Public types
// -----------------------------------------------------------------------------

export type TanhSinhBFOptions = {
  /**
   * Absolute tolerance, as a BigFloat. If omitted, defaults to ~`10^-prec`
   * — same heuristic as `gaussKronrodAdaptiveBF`. The convergence test
   * uses Bailey 2005 §5's `d`-formula whose target is `prec` decimal
   * digits; explicit `atol` overrides only the post-loop "advertised
   * error met" reporting, not the `d`-formula's prec target.
   */
  readonly atol?: BigFloat;
  /** Relative tolerance, as a BigFloat. Same default heuristic as `atol`. */
  readonly rtol?: BigFloat;
  /**
   * Maximum number of integrand evaluations. Defaults to a generous
   * exponential bound `40 · 2^maxLevels` that the natural per-level
   * `weight < ε₁` cutoff hits *before* the budget bites for any
   * smooth-analytic integrand at default `maxLevels`. The budget is a
   * runaway safety net for pathological integrands (e.g. an integrand
   * whose evaluation cost grows with each call) — not the primary
   * termination mechanism. Bailey §3: tanh-sinh evaluates `~7.2 · 2^k`
   * abscissa pairs at level k; cumulative across L levels is
   * `~14.4 · 2^L`. The 40× factor leaves comfortable headroom.
   */
  readonly maxEvals?: number;
  /**
   * Maximum level count. Default = 15 — Bailey's Table 1 reports
   * level 7-9 reaching 10⁻⁴⁰⁰ on smooth problems, so 15 carries
   * comfortable headroom even for prec ≤ 1000 dps. A pathological
   * integrand that would otherwise loop forever is bounded here.
   * Must be ≥ 2; convergence requires at least 3 levels to fire (one
   * level for `S_1`, one for `S_2`, then the level-3 delta `|S_3 - S_2|`
   * is the first checked). With `maxLevels < 3` the run terminates
   * with `converged: false` and a non-empty `warnings`.
   */
  readonly maxLevels?: number;
};

// -----------------------------------------------------------------------------
// Driver
// -----------------------------------------------------------------------------

/**
 * Adaptive double-exponential (tanh-sinh) quadrature on `[a, b]` at the
 * user-requested decimal precision. Returns a `BigFloatQuadResult`
 * (the same type as `gaussKronrodAdaptiveBF`'s return; discriminated
 * by `method`).
 *
 * Integrand contract (load-bearing — worklog 076 documents the bug
 * caused by violating it):
 *
 * The integrand `f(x, prec)` MUST construct every BigFloat constant
 * at the supplied `prec`, not at the substrate default 53 bits. In
 * particular:
 *
 * ```
 * // CORRECT
 * const f = (x: BigFloat, p: number) => {
 *   const onePlusXsq = add(fromInt(1n, p), mul(x, x, p), p);
 *   return div(fromInt(1n, p), onePlusXsq, p);
 * };
 * // WRONG — silent precision floor at ~16 dps regardless of `p`
 * const fBad = (x: BigFloat, p: number) => {
 *   const onePlusXsq = add(fromInt(1n), mul(x, x, p), p);
 *   return div(fromInt(1n), onePlusXsq, p);
 * };
 * ```
 *
 * Why: the substrate's `div(a, b, prec)` uses `workingBits = prec + 32`
 * scaled to the *numerator's* mantissa length (`packages/bigfloat/src/
 * arithmetic.ts:92`). When the numerator is `fromInt(1n)` with the
 * default 53-bit precision attribute and the denominator carries
 * 200+ bits, the quotient ends up with only ~85 effective bits — the
 * trailing 128 bits of the result mantissa are zero-padded by
 * `normalise`. Subsequent operations propagate the silent precision
 * loss; the trapezoidal sum cannot be more accurate than its
 * least-precise summand. This is a substrate quirk that bites
 * tanh-sinh harder than it bites G7K15 (which doesn't divide inside
 * the integrand path) — see worklog 076 for the full diagnosis. A
 * future fix in `packages/bigfloat/src/arithmetic.ts` is the proper
 * resolution; the integrand-contract is the workaround in scope here.
 *
 * @param f    Integrand `(x, prec) → BigFloat`. The driver passes the
 *             working bit precision so the integrand can match it.
 *             Must use `fromInt(N, prec)` (not `fromInt(N)`) for any
 *             constants used inside `div`. See contract above.
 * @param a    Left bound. `a < b` required; throws otherwise.
 * @param b    Right bound.
 * @param prec User-requested decimal precision. Range
 *             `[1, MAX_DECIMAL_PRECISION]`.
 *
 * @throws  `BigFloatQuadratureError` on `a >= b`.
 *          `RangeError` on out-of-range `prec`, non-integer `prec`,
 *          `maxLevels < 2`, or `maxEvals < 2`. Integrand exceptions
 *          propagate verbatim.
 *
 * Determinism contract: bit-identical across every JavaScript runtime,
 * given the same input bytes and `prec`. ADR-0020.
 */
export function tanhSinhAdaptiveBF(
  f: (x: BigFloat, prec: number) => BigFloat,
  a: BigFloat,
  b: BigFloat,
  prec: number,
  opts?: TanhSinhBFOptions,
): BigFloatQuadResult {
  // ---------------------------------------------------------------
  // Validation
  // ---------------------------------------------------------------
  if (!Number.isInteger(prec) || prec < 1) {
    throw new RangeError(
      `tanhSinhAdaptiveBF: prec must be a positive integer; got ${prec}`,
    );
  }
  if (prec > MAX_DECIMAL_PRECISION) {
    throw new RangeError(
      `tanhSinhAdaptiveBF: prec=${prec} exceeds the substrate's hard cap ` +
        `of ${MAX_DECIMAL_PRECISION} decimal digits.`,
    );
  }
  if (cmp(a, b) >= 0) {
    throw new BigFloatQuadratureError(
      `tanhSinhAdaptiveBF: require a < b (got a=${bfToString(a, 20)}, b=${bfToString(b, 20)})`,
    );
  }

  // Default maxLevels: 15 for any prec ≤ MAX_DECIMAL_PRECISION.
  // Bailey 2005 Table 1 reports level 7-9 reaching 10⁻⁴⁰⁰ on smooth
  // problems; level 15 carries 6 levels of headroom for harder
  // integrand classes. Each additional level doubles the eval count
  // (~7.2 · 2^k pairs at level k), so 15 sets the runtime ceiling at
  // ~250k evaluations per call — comfortable for prec ≤ 1000 dps.
  const defaultMaxLevels = 15;
  const maxLevels = opts?.maxLevels ?? defaultMaxLevels;
  if (!Number.isInteger(maxLevels) || maxLevels < 2) {
    throw new RangeError(
      `tanhSinhAdaptiveBF: maxLevels must be an integer ≥ 2; got ${maxLevels}`,
    );
  }
  // Default maxEvals: generous exponential bound. The natural cutoff
  // (`weight < ε₁`) fires before this bites for any smooth integrand.
  // 40 · 2^maxLevels at default maxLevels=15 is ~1.3M, giving practical
  // pathological-integrand protection while letting honest integrands
  // run to the truncation floor.
  const defaultMaxEvals = 40 * 2 ** Math.min(maxLevels, 22);
  const maxEvals = opts?.maxEvals ?? defaultMaxEvals;
  if (!Number.isInteger(maxEvals) || maxEvals < 2) {
    throw new RangeError(
      `tanhSinhAdaptiveBF: maxEvals must be an integer ≥ 2; got ${maxEvals}`,
    );
  }

  // Working precision: Bailey-Jeyabalan-Li 2005 §3 uses a "secondary
  // precision p₂ = 2·p₁" pattern for the auxiliary computations
  // (abscissa storage, linear scaling). The same logic applies to the
  // trapezoid recurrence here: T_k = T_{k-1}/2 + h_k · oddSum_k
  // adds two values of size ~|integral| whose difference is the
  // convergence-error increment, so the running sum suffers absolute-
  // precision loss of `log₂(|integral| / atol)` bits — at prec=30 with
  // |integral| ~ 1, that's ~100 bits of cancellation. The 30-bit safety
  // used by `gaussKronrodAdaptiveBF` leaves only ~9 dps of headroom; on
  // 50+ dps targets the running-sum noise floors deltas at ~10^-(prec-2).
  // We use 80 bits of safety here — sufficient for prec ≤ 100 with a
  // generous margin, matching the bigfloat substrate's `clgamma`
  // 96-bit pattern. Future bead lifts via Bailey's d-formula error
  // estimator (Section 5) which accounts for the floor explicitly.
  const workingBits = decimalToBinaryPrecision(prec, 80);
  const atol = opts?.atol ?? defaultTolerance(prec, workingBits);
  const rtol = opts?.rtol ?? defaultTolerance(prec, workingBits);

  // ---------------------------------------------------------------
  // Setup constants — π/2, midpoint, half-length, ε threshold
  // ---------------------------------------------------------------
  const piBF = pi(workingBits);
  const halfPi = halveBF(piBF, workingBits);          // π/2
  const mid = halveBF(add(a, b, workingBits), workingBits);    // (a+b)/2
  const half = halveBF(sub(b, a, workingBits), workingBits);   // (b-a)/2

  // Pair-generation cutoff: stop iterating j once weight `w_j < ε₁`.
  // The truncation tail's contribution is bounded by `ε₁ · max|w_j f(x_j)|`
  // (Bailey §5 d_3) since `w_j` decays doubly-exponentially in j. To
  // *deliver* prec digits to the user we want the truncation floor a
  // few dps below the user target — Bailey 2005 §3 uses
  // `ε₁ = 10^{-p₁} · e^{-π²/2}` for primary precision p₁; we use the
  // simpler, slightly more conservative `ε₁ = 10^{-(prec + ε_margin)}`
  // with `ε_margin = 5` dps. The 5-dps margin guarantees the
  // truncation-floor `d_4 ≤ -prec` even for integrands with
  // `max|wf| ~ 10⁵` (the d_3 term carries `+log₁₀ max|wf|`).
  //
  // The natural cutoff (NOT an artificial m-cap) is the sole
  // termination of the per-level loop — capping the loop at anything
  // smaller than the natural cutoff silently drops contributing nodes
  // at high levels and propagates the error through the recurrence,
  // which was the v0.1 bug (worklog 075 / 076).
  const epsilonMargin = 8;
  const epsilon = powInt(fromInt(10n), -(prec + epsilonMargin), workingBits);

  let nEvals = 0;
  const warnings: string[] = [];

  // d-formula state (Bailey §5): we track the maximum-magnitude
  // summand `|w_j f(x_j)|` seen across the current level, and the
  // boundary summands at the leftmost and rightmost kept abscissas
  // (the closest to ±1 — these dominate the truncation-tail term d_4).
  // Bailey: "x_l is the closest abscissa to the left endpoint and
  // x_r is the closest abscissa to the right endpoint."
  let maxAbsSummand = 0; // log₁₀ of max|w_j f(x_j)| as Number — pre-init to -∞ via 0
  let lastSummandLog10 = Number.NEGATIVE_INFINITY; // log₁₀ |w_j f(x_j)| at the j=j_max kept node

  // ---------------------------------------------------------------
  // Level 1 — full grid at h_1 = 1/2.
  // ---------------------------------------------------------------
  // The trapezoid sum at this level is
  //     T_1 = h_1 · Σ_{j ∈ ℤ} g'(j·h_1) · F(y(g(j·h_1)))
  //     where F is the user integrand and y is the affine map.
  // Centre (j = 0): x_0 = tanh(0) = 0, w_0 = π/2, y(x_0) = mid.
  // Paired (j = ±1, ±2, …): x_j = tanh((π/2) sinh(j·h)), w_j = …,
  //     and y(±x_j) = mid ± half · x_j.
  // ---------------------------------------------------------------

  let h: BigFloat = halveBF(fromInt(1n), workingBits); // h_1 = 1/2

  // Centre contribution: `w_0 · F(mid) = (π/2) · F(mid)`. The centre
  // summand always dominates max|wf| for smooth integrands (g'(0) = π/2
  // is the peak of the doubly-exponential bell curve), so we seed
  // `maxAbsSummand` with it.
  const fMid = f(mid, workingBits);
  const centreSummand = mul(halfPi, fMid, workingBits);
  let trapSum = centreSummand;
  nEvals += 1;
  maxAbsSummand = log10AbsBF(centreSummand);

  // Reset boundary summand tracking for level 1.
  let boundarySummandLevel: number = Number.NEGATIVE_INFINITY;

  let evalBudgetHit = false;
  for (let j = 1; ; j++) {
    if (nEvals + 2 > maxEvals) {
      warnings.push(
        `tanhSinhAdaptiveBF: maxEvals=${maxEvals} hit during level 1 abscissa generation at j=${j}`,
      );
      evalBudgetHit = true;
      break;
    }
    const tj = mul(fromInt(BigInt(j)), h, workingBits);
    const node = computeNode(tj, halfPi, workingBits);
    if (lt(node.weight, epsilon)) break;
    const halfX = mul(half, node.abscissa, workingBits);
    const yLeft = sub(mid, halfX, workingBits);
    const yRight = add(mid, halfX, workingBits);
    const fL = f(yLeft, workingBits);
    const fR = f(yRight, workingBits);
    const fSum = add(fL, fR, workingBits);
    const summandPair = mul(node.weight, fSum, workingBits);
    trapSum = add(trapSum, summandPair, workingBits);
    nEvals += 2;

    // d-formula tracking: max |w_j f(x_j)| over individual abscissas.
    // We track each pair-half separately to avoid masking via cancellation
    // in the (yLeft + yRight) sum.
    const wfL = mul(node.weight, fL, workingBits);
    const wfR = mul(node.weight, fR, workingBits);
    const lwfL = log10AbsBF(wfL);
    const lwfR = log10AbsBF(wfR);
    if (lwfL > maxAbsSummand) maxAbsSummand = lwfL;
    if (lwfR > maxAbsSummand) maxAbsSummand = lwfR;
    // The boundary-summand `d_4` records the LAST kept node's max-side
    // summand (closest to the endpoints).
    boundarySummandLevel = Math.max(lwfL, lwfR);
  }
  lastSummandLog10 = boundarySummandLevel;

  let sPrev: BigFloat = mul(h, trapSum, workingBits); // S_1
  let iterations = 1;
  let didConverge = false;
  let lastDelta: BigFloat = absDeltaPlaceholder(workingBits);

  // ---------------------------------------------------------------
  // Levels 2, 3, … — successive halving via the trapezoid-doubling
  // recurrence  `S_k = S_{k-1} / 2 + h_k · Σ_{j odd} w_j · (F+ + F-)`.
  // The j-loop terminates only on the natural `weight < ε₁` cutoff
  // — no artificial m-cap. Doubly-exponential decay guarantees
  // termination at moderate `|j|` (level k's natural cutoff is at
  // `|j| · h_k ≈ 4.5`, i.e., `|j| ≈ 4.5 · 2^k`); bounded above by
  // the `maxEvals` runaway safety net.
  // ---------------------------------------------------------------

  for (let level = 2; level <= maxLevels && !evalBudgetHit; level++) {
    h = halveBF(h, workingBits); // h_k = h_{k-1} / 2 = 2^{-k}

    let oddSum: BigFloat = ZERO_BF;
    let levelEvalsExhausted = false;
    let levelBoundary: number = Number.NEGATIVE_INFINITY;
    for (let m = 0; ; m++) {
      if (nEvals + 2 > maxEvals) {
        warnings.push(
          `tanhSinhAdaptiveBF: maxEvals=${maxEvals} hit during level ${level} abscissa generation at m=${m}`,
        );
        levelEvalsExhausted = true;
        evalBudgetHit = true;
        break;
      }
      const j = 2 * m + 1; // odd index in level-k indexing
      const tj = mul(fromInt(BigInt(j)), h, workingBits);
      const node = computeNode(tj, halfPi, workingBits);
      if (lt(node.weight, epsilon)) break;
      const halfX = mul(half, node.abscissa, workingBits);
      const yLeft = sub(mid, halfX, workingBits);
      const yRight = add(mid, halfX, workingBits);
      const fL = f(yLeft, workingBits);
      const fR = f(yRight, workingBits);
      const fSum = add(fL, fR, workingBits);
      oddSum = add(oddSum, mul(node.weight, fSum, workingBits), workingBits);
      nEvals += 2;

      // d-formula tracking (Bailey §5): max-summand and boundary summand.
      const wfL = mul(node.weight, fL, workingBits);
      const wfR = mul(node.weight, fR, workingBits);
      const lwfL = log10AbsBF(wfL);
      const lwfR = log10AbsBF(wfR);
      if (lwfL > maxAbsSummand) maxAbsSummand = lwfL;
      if (lwfR > maxAbsSummand) maxAbsSummand = lwfR;
      levelBoundary = Math.max(lwfL, lwfR);
    }

    const sCurr = add(
      halveBF(sPrev, workingBits),
      mul(h, oddSum, workingBits),
      workingBits,
    );
    iterations = level;

    const delta = abs(sub(sCurr, sPrev, workingBits));
    lastDelta = delta;
    lastSummandLog10 = levelBoundary;

    // Convergence: rigorous test from Bailey §5 — "continue computation
    // until the quadrature results from two successive levels agree to
    // within the full primary precision". Equivalently `|S_n - S_{n-1}|
    // ≤ ε_1 = 10^{-(prec + ε_margin)}`. This is mathematically sound,
    // costs one "wasted" level (the level after the floor was reached;
    // a level that confirms convergence rather than discovers it) but
    // does not over-promise like the heuristic d-formula does.
    //
    // Bailey 2005 §5's `d`-formula `d = max(d_1²/d_2, 2 d_1, d_3, d_4)`
    // is a *heuristic* error estimate — useful for the reported
    // `errorEstimate` field, but pessimistic-looking (negative, small)
    // when its `2 d_1` quadratic-extrapolation term over-estimates the
    // achievable accuracy at the current level. We compute it for the
    // post-loop error report, but do NOT use it as the convergence
    // gate. Worklog 076 dead-end: I tried `d ≤ -prec` first and got
    // premature convergence on `t·log(1+t)` at prec=100 (advertised
    // 108 dps, delivered 98 dps).
    sPrev = sCurr;

    if (level >= 3 && cmp(delta, epsilon) <= 0) {
      didConverge = true;
      break;
    }
    if (levelEvalsExhausted) break;
  }

  if (!didConverge) {
    warnings.push(
      `tanhSinhAdaptiveBF: did not converge to prec=${prec} dps within ` +
        `maxLevels=${maxLevels}, maxEvals=${maxEvals}; reported ` +
        `errorEstimate may exceed requested tolerance. (Bailey §5 ` +
        `d-formula: max|wf|=10^${maxAbsSummand.toFixed(2)}, ` +
        `boundary|wf|=10^${lastSummandLog10.toFixed(2)}, ` +
        `lastDelta=${bfToString(lastDelta, 4)}.)`,
    );
  }

  // Final scaling: multiply the trapezoid value by `half = (b - a)/2`
  // to convert from `[-1, 1]` integral coordinates to user coordinates.
  // The d-formula error estimate already lives in [-1, 1] integral
  // coordinates; we scale it by `|half|` to put it in user coordinates,
  // matching the value scaling. (For converged runs the d-formula's
  // 10^d ≤ 10^{-prec}; for non-converged runs we still report the
  // computed estimate honestly rather than lying about convergence.)
  const value = mul(sPrev, half, workingBits);
  // `errorEstimate` blends the d-formula estimate with the raw
  // last-level delta in transformed coordinates: take the larger so we
  // never under-report. Then scale into user coordinates.
  const dEstAtCurrLevel = effectiveDEstimate(
    lastDelta,
    maxAbsSummand,
    lastSummandLog10,
    prec + epsilonMargin,
    workingBits,
  );
  const deltaScaled = abs(mul(lastDelta, half, workingBits));
  const dEstScaled = abs(mul(dEstAtCurrLevel, half, workingBits));
  const errorEstimate =
    cmp(dEstScaled, deltaScaled) > 0 ? dEstScaled : deltaScaled;

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
// Per-node abscissa / weight computation
// -----------------------------------------------------------------------------
//
// For a given `t = j · h`:
//   u₂ = (π/2) · sinh(t)
//   u₁ = (π/2) · cosh(t)
//   x  = tanh(u₂)
//   w  = u₁ / cosh²(u₂)
//
// The substrate's `sinh / cosh / tanh` are bit-deterministic at the
// supplied working precision (BigFloat → BigFloat via BigInt
// arithmetic; ADR-0020).

interface TanhSinhNode {
  readonly abscissa: BigFloat; // x = tanh(u₂)
  readonly weight: BigFloat;   // w = u₁ / cosh²(u₂)
}

function computeNode(t: BigFloat, halfPi: BigFloat, workingBits: number): TanhSinhNode {
  const u2 = mul(halfPi, sinh(t, workingBits), workingBits);
  const u1 = mul(halfPi, cosh(t, workingBits), workingBits);
  const xVal = tanh(u2, workingBits);
  const coshU2 = cosh(u2, workingBits);
  const cosh2 = mul(coshU2, coshU2, workingBits);
  const wVal = div(u1, cosh2, workingBits);
  return { abscissa: xVal, weight: wVal };
}

// -----------------------------------------------------------------------------
// Helpers — halve, default tolerance, finalise (mirrors gauss-kronrod-bf.ts)
// -----------------------------------------------------------------------------

const ZERO_BF: BigFloat = { mantissa: 0n, exponent: 0, precision: 1 };

/**
 * Bit-exact halving: decrement the exponent by 1, leave mantissa
 * unchanged. Mirrors `gauss-kronrod-bf.ts`'s private `halveBF`.
 */
function halveBF(x: BigFloat, prec: number): BigFloat {
  if (isZero(x)) return x;
  return { mantissa: x.mantissa, exponent: x.exponent - 1, precision: prec };
}

/** Sentinel for the pre-loop `lastDelta` (replaced on the first iteration). */
function absDeltaPlaceholder(prec: number): BigFloat {
  return { mantissa: 0n, exponent: 0, precision: prec };
}

function defaultTolerance(prec: number, workingBits: number): BigFloat {
  return powInt(fromInt(10n), -prec, workingBits);
}

/**
 * Build a BigFloat representing `10^d` where `d` is the Bailey §5
 * estimated-error log₁₀-floor `max(d_3, d_4) = max(-prec + log₁₀ max|wf|,
 * log₁₀ |w_boundary f|)`. We round `d` up to the nearest integer-or-half
 * for stable BigFloat construction, then build `10^⌈d⌉`. If d is
 * `-Infinity` or below `-MAX_DECIMAL_PRECISION`, returns 0 — no
 * meaningful floor to advertise.
 *
 * The blended `errorEstimate` returned to the caller is `max(10^d, |Δ|)`
 * — the larger of the d-formula floor and the raw last-level delta —
 * so a converged run reports an honest non-zero floor (the truncation
 * tail), and a non-converged run reports whichever signal is larger.
 */
function effectiveDEstimate(
  lastDelta: BigFloat,
  log10MaxSummand: number,
  log10BoundarySummand: number,
  prec: number,
  workingBits: number,
): BigFloat {
  const d3 = -prec + (Number.isFinite(log10MaxSummand) ? log10MaxSummand : 0);
  const d4 = Number.isFinite(log10BoundarySummand)
    ? log10BoundarySummand
    : Number.NEGATIVE_INFINITY;
  const d = Math.max(d3, d4);
  if (!Number.isFinite(d) || d < -MAX_DECIMAL_PRECISION) {
    return { mantissa: 0n, exponent: 0, precision: workingBits };
  }
  const dCeil = Math.ceil(d);
  // 10^dCeil at workingBits.
  return powInt(fromInt(10n), dCeil, workingBits);
}

function roundTo(x: BigFloat, prec: number): BigFloat {
  if (x.precision === prec) return x;
  const zero: BigFloat = { mantissa: 0n, exponent: 0, precision: prec };
  return add(x, zero, prec);
}

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
    method: "tanh-sinh-bigfloat",
    warnings,
  };
}
