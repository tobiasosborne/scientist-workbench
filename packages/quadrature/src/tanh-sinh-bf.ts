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
// Convergence test (v0.1)
// -----------------------
// Declare convergence when `|S_k − S_{k-1}| ≤ atol + rtol · |S_k|`.
// The quadratic-convergence-on-correct-digits behaviour means this
// fires at level 4–6 for typical smooth integrands at 50 dps,
// 6–8 at 100 dps. Bailey 2005 §5's heuristic
// `d = max(d₁²/d₂, 2d₁, d₃, d₄)` is more aggressive (it uses the
// quadratic-convergence assumption to predict the *next* level's
// error from the current and previous deltas); v0.1 ships the
// simpler form, follow-up bead lifts the heuristic.
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

// -----------------------------------------------------------------------------
// Public types
// -----------------------------------------------------------------------------

export type TanhSinhBFOptions = {
  /**
   * Absolute tolerance, as a BigFloat. If omitted, defaults to ~`10^-prec`
   * — same heuristic as `gaussKronrodAdaptiveBF`. Convergence test:
   * `|S_k − S_{k-1}| ≤ atol + rtol · |S_k|`.
   */
  readonly atol?: BigFloat;
  /** Relative tolerance, as a BigFloat. Same default heuristic as `atol`. */
  readonly rtol?: BigFloat;
  /**
   * Maximum number of integrand evaluations. Defaults to `prec * 200`.
   * Tanh-sinh's typical eval count for smooth integrands is `~7.2 · 2^level`
   * (Bailey 2005 §3); the budget is hit only on pathological inputs.
   */
  readonly maxEvals?: number;
  /**
   * Maximum level count. Default = `prec` (each level roughly doubles the
   * achieved precision, so `prec` levels is comfortably more than needed
   * for prec dps). Must be ≥ 2 — the convergence delta-test requires at
   * least two levels.
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
 * @param f    Integrand `(x, prec) → BigFloat`. The driver passes the
 *             working bit precision so the integrand can match it.
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

  const maxLevels = opts?.maxLevels ?? prec;
  if (!Number.isInteger(maxLevels) || maxLevels < 2) {
    throw new RangeError(
      `tanhSinhAdaptiveBF: maxLevels must be an integer ≥ 2; got ${maxLevels}`,
    );
  }
  const maxEvals = opts?.maxEvals ?? prec * 200;
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

  // Pair-generation cutoff: stop iterating j once weight w_j < ε.
  // The truncation tail's contribution is bounded by ε · O(1) since
  // w_j decays doubly-exponentially in j (geometric tail at any base).
  // Bailey 2005 §3 uses ε₁ = 10^{-p} for primary precision p; we
  // follow that.
  const epsilon = powInt(fromInt(10n), -prec, workingBits);

  // Defensive cap on per-level j-iteration: doubly-exponential decay
  // means we usually stop at |j| ~ 30; a runaway integrand could
  // theoretically push higher, so cap at prec * 50 to bound runtime.
  const maxPerLevel = prec * 50;

  let nEvals = 0;
  const warnings: string[] = [];

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

  // Centre contribution: w_0 · F(mid) = (π/2) · F(mid).
  let trapSum = mul(halfPi, f(mid, workingBits), workingBits);
  nEvals += 1;

  for (let j = 1; j <= maxPerLevel; j++) {
    const tj = mul(fromInt(BigInt(j)), h, workingBits);
    const node = computeNode(tj, halfPi, workingBits);
    if (lt(node.weight, epsilon)) break;
    if (nEvals + 2 > maxEvals) {
      warnings.push(
        `tanhSinhAdaptiveBF: maxEvals=${maxEvals} hit during level 1 abscissa generation at j=${j}`,
      );
      break;
    }
    const halfX = mul(half, node.abscissa, workingBits);
    const yLeft = sub(mid, halfX, workingBits);
    const yRight = add(mid, halfX, workingBits);
    const fSum = add(
      f(yLeft, workingBits),
      f(yRight, workingBits),
      workingBits,
    );
    trapSum = add(
      trapSum,
      mul(node.weight, fSum, workingBits),
      workingBits,
    );
    nEvals += 2;
  }

  let sPrev: BigFloat = mul(h, trapSum, workingBits); // S_1
  let iterations = 1;
  let didConverge = false;
  let lastDelta: BigFloat = absDeltaPlaceholder(workingBits);

  // ---------------------------------------------------------------
  // Levels 2, 3, … — successive halving via the trapezoid-doubling
  // recurrence  S_k = S_{k-1} / 2 + h_k · Σ_{j odd} w_j (F+ + F-).
  // ---------------------------------------------------------------

  for (let level = 2; level <= maxLevels; level++) {
    h = halveBF(h, workingBits); // h_k = h_{k-1} / 2 = 2^{-k}

    let oddSum: BigFloat = ZERO_BF;
    let levelEvalsExhausted = false;
    for (let m = 0; m < maxPerLevel; m++) {
      if (nEvals + 2 > maxEvals) {
        warnings.push(
          `tanhSinhAdaptiveBF: maxEvals=${maxEvals} hit during level ${level} abscissa generation at m=${m}`,
        );
        levelEvalsExhausted = true;
        break;
      }
      const j = 2 * m + 1; // odd index in level-k indexing
      const tj = mul(fromInt(BigInt(j)), h, workingBits);
      const node = computeNode(tj, halfPi, workingBits);
      if (lt(node.weight, epsilon)) break;
      const halfX = mul(half, node.abscissa, workingBits);
      const yLeft = sub(mid, halfX, workingBits);
      const yRight = add(mid, halfX, workingBits);
      const fSum = add(
        f(yLeft, workingBits),
        f(yRight, workingBits),
        workingBits,
      );
      oddSum = add(
        oddSum,
        mul(node.weight, fSum, workingBits),
        workingBits,
      );
      nEvals += 2;
    }

    const sCurr = add(
      halveBF(sPrev, workingBits),
      mul(h, oddSum, workingBits),
      workingBits,
    );
    iterations = level;

    // Convergence test: |S_curr − S_prev| ≤ atol + rtol · |S_curr|.
    const delta = abs(sub(sCurr, sPrev, workingBits));
    const tolBound = add(
      atol,
      mul(rtol, abs(sCurr), workingBits),
      workingBits,
    );
    lastDelta = delta;

    sPrev = sCurr;

    if (cmp(delta, tolBound) <= 0) {
      didConverge = true;
      break;
    }
    if (levelEvalsExhausted) break;
  }

  if (!didConverge) {
    warnings.push(
      `tanhSinhAdaptiveBF: did not converge to atol=${bfToString(atol, 6)} ` +
        `rtol=${bfToString(rtol, 6)} within maxLevels=${maxLevels}, ` +
        `maxEvals=${maxEvals}; reported errorEstimate may exceed ` +
        `requested tolerance.`,
    );
  }

  // Final scaling: multiply the trapezoid value by `half = (b - a)/2`
  // to convert from `[-1, 1]` integral coordinates to user coordinates.
  // Same scaling for the error estimate (the delta IS our error estimate
  // in transformed coordinates; multiplied by `half` it lives in user
  // coordinates).
  const value = mul(sPrev, half, workingBits);
  const errorEstimate = abs(mul(lastDelta, half, workingBits));

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
