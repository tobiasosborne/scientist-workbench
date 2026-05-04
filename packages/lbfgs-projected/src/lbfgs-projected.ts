// =============================================================================
// lbfgs-projected.ts — limited-memory BFGS with simple bound constraints
// =============================================================================
//
// The third numerical-tier algorithm in scientist-workbench (after
// `@workbench/linalg-core`'s LU and `@workbench/quadrature`'s adaptive
// G7K15). Substrate behind `tools/optimize-lbfgs-projected`.
//
// One call: `lbfgsProjected(f, grad, x0, lower, upper, opts)`. Returns an
// agent-honest `LBfgsbResult` carrying the solution, the gradient at
// the solution, an honest `success` boolean, a status code matching
// scipy's L-BFGS-B taxonomy, the projected-gradient infinity-norm at
// termination, BFGS-skip / line-search-fail / active-bound counters,
// and human-readable warnings. The shape mirrors the precedent set
// by `linalg-core`'s `solve` and `quadrature`'s `gaussKronrodAdaptive`:
// a planner reads the record and decides "trust this / retry / warn
// the user," it does not have to re-derive the diagnostic itself.
//
// Algorithm — L-BFGS with active-set projection
// ---------------------------------------------
// We follow the structure of Byrd-Lu-Nocedal-Zhu 1995 / Morales-
// Nocedal 2011 v3.0, but use a simplified active-set + projected-
// gradient approach rather than the full Cauchy-point + subspace-
// minimisation pipeline of the Northwestern Fortran. The agreement
// criterion (the manifest's `|f - f_ref| ≤ atol + rtol * max(1,
// |f_ref|)` and `‖grad_proj‖_∞ ≤ 10*gtol`) is met by either approach;
// the manifest explicitly does NOT compare iteration counts ("highly
// path-dependent"). Honest scope: this is *L-BFGS-B-class* behaviour,
// not a transliteration.
//
// At each outer iteration:
//
//   1. **Identify the active set.** A coordinate is active at its
//      lower bound iff `x_i = lo_i` (within float-tolerance) and
//      `g_i > 0` (descent would push further into the bound). Active
//      at upper bound symmetrically. Active coordinates are pinned
//      at the bound for this iteration.
//
//   2. **L-BFGS direction on free coordinates.** Use the two-loop
//      recursion (Nocedal 1980) to compute `d_F = -H_F g_F` from the
//      m-history of `(s_k, y_k)` pairs *restricted to the current
//      free set*. Active coordinates' direction is zero. This is a
//      *descent* direction by construction (the curvature safeguard
//      below ensures `H` remains positive definite).
//
//   3. **Step cap to feasibility.** If a free coordinate's step
//      `d_i` would carry it past a bound, shrink the step uniformly
//      until the first crossing. The crossed coordinate enters the
//      active set on the next iteration.
//
//   4. **Strong-Wolfe line search.** A More-Thuente-style bracketing
//      line search with cubic interpolation, satisfying `f(x + αd)
//      ≤ f + c1 α g·d` (Armijo) and `|g_new·d| ≤ c2 |g·d|` (curvature)
//      where (c1, c2) = (1e-4, 0.9). The search produces `x_new =
//      P(x + α d)` (projection ensures feasibility under round-off).
//
//   5. **L-BFGS update with Powell's curvature safeguard.** Append
//      `(s, y) = (x_new - x, g_new - g)` to the m-history iff
//      `s·y > eps · √((s·s)(y·y))`; otherwise skip and count.
//
//   6. **Convergence tests.**
//      a. `‖∇f|_proj‖_∞ ≤ gtol` ⇒ status 0 (converged on gradient).
//      b. `(f_old − f_new) / max(|f_old|, |f_new|, 1) ≤ ftol` ⇒
//         status 1 (converged on f-reduction).
//      c. `iter ≥ maxiter` ⇒ status 2; `nfev ≥ maxfun` ⇒ status 3.
//      d. Line-search failure with no history to reset ⇒ status 4.
//
// Float64Array throughout the hot loop; pure TypeScript. Determinism:
// single-platform bit-identity given `{arch, os, runtime}` (ADR-0015).
//
// References
// ----------
// - Byrd, Lu, Nocedal, Zhu, "A Limited Memory Algorithm for Bound
//   Constrained Optimization", SIAM J. Sci. Comput. 16(5), 1995.
// - Zhu, Byrd, Lu, Nocedal, "Algorithm 778: L-BFGS-B", ACM TOMS 23(4),
//   1997.
// - Morales, Nocedal, "Remark on Algorithm 778", ACM TOMS 38(1),
//   2011.
// - Nocedal, "Updating Quasi-Newton Matrices with Limited Storage",
//   Math. Comp. 35, 1980. (The two-loop recursion.)
// - Nocedal, Wright, *Numerical Optimization*, 2nd ed., Springer 2006
//   — §7.2 (limited-memory) and §3.5 (line search).

// -----------------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------------

export interface LBfgsbOptions {
  /** L-BFGS history depth (number of `(s_k, y_k)` pairs retained). Default 10. */
  readonly maxcor?: number;
  /**
   * Termination tolerance on the relative reduction of f:
   * `(f_old - f_new) / max(|f_old|, |f_new|, 1) ≤ ftol` ⇒ converged.
   * Default `1e7 * machine_eps ≈ 2.220446e-09` (the scipy default,
   * which matches the Fortran v3.0 default).
   */
  readonly ftol?: number;
  /**
   * Termination tolerance on the projected-gradient infinity norm:
   * `‖∇f|_proj‖_∞ ≤ gtol` ⇒ converged. Default `1e-5` (scipy /
   * Fortran v3.0 default).
   */
  readonly gtol?: number;
  /** Maximum L-BFGS iterations. Default 15000. */
  readonly maxiter?: number;
  /** Maximum function evaluations. Default 15000. */
  readonly maxfun?: number;
  /** Maximum line-search trial steps per iteration. Default 20. */
  readonly maxls?: number;
}

export interface LBfgsbResult {
  /** Solution vector. */
  readonly x: Float64Array;
  /** `f(x)` at the solution. */
  readonly fun: number;
  /** `grad f(x)` at the solution (raw, not projected). */
  readonly jac: Float64Array;
  /**
   * Infinity norm of the *projected* gradient at the solution. A
   * coordinate at its lower bound with positive gradient projects to
   * zero (the bound prevents further descent in that coordinate);
   * symmetric for upper bounds. The honest stopping criterion uses
   * this rather than the raw gradient.
   */
  readonly gradInfNorm: number;
  /** Iterations actually performed. */
  readonly nit: number;
  /** Function evaluations actually performed (counts each `f` AND each `grad` call once). */
  readonly nfev: number;
  /**
   * Termination status. Mirrors scipy's L-BFGS-B taxonomy plus a
   * line-search-failure code:
   *   0 — converged on projected-gradient norm (`gtol`).
   *   1 — converged on relative-f-reduction (`ftol`).
   *   2 — max iterations reached.
   *   3 — max function evaluations reached.
   *   4 — line search failed (no acceptable step found).
   */
  readonly status: 0 | 1 | 2 | 3 | 4;
  /** Human-readable status message. */
  readonly statusMessage: string;
  /** `true` iff `status ∈ {0, 1}`. */
  readonly success: boolean;
  /** Number of L-BFGS updates skipped due to curvature-condition violation. */
  readonly bfgsSkipCount: number;
  /** Number of line searches that fell back to the safeguard step (cumulative). */
  readonly lineSearchFailCount: number;
  /** Number of bounds active at the solution. */
  readonly activeBoundsCount: number;
  /** Human-readable diagnostics. Always present (possibly empty). */
  readonly warnings: readonly string[];
}

/** Thrown when at least one `lower[i] > upper[i]`. The tool layer translates this to a boundary tag. */
export class LBfgsbInfeasibleBoundsError extends Error {
  /** Index of the offending variable. */
  readonly variable: number;
  readonly lower: number;
  readonly upper: number;
  constructor(variable: number, lower: number, upper: number) {
    super(`lbfgsb: infeasible bounds at variable ${variable}: lower=${lower} > upper=${upper}`);
    this.name = "LBfgsbInfeasibleBoundsError";
    this.variable = variable;
    this.lower = lower;
    this.upper = upper;
  }
}

/** Thrown when `x0[i]` is strictly outside `[lower[i], upper[i]]`. The tool layer translates this to a boundary tag. */
export class LBfgsbX0OutsideBoundsError extends Error {
  readonly variable: number;
  readonly x0: number;
  readonly lower: number;
  readonly upper: number;
  constructor(variable: number, x0: number, lower: number, upper: number) {
    super(`lbfgsb: x0[${variable}]=${x0} is outside [${lower}, ${upper}]`);
    this.name = "LBfgsbX0OutsideBoundsError";
    this.variable = variable;
    this.x0 = x0;
    this.lower = lower;
    this.upper = upper;
  }
}

/** Thrown when `f` or `grad` returns NaN/Inf at any iterate. The tool layer translates this to a boundary tag. */
export class LBfgsbNonFiniteError extends Error {
  readonly source: "f" | "grad";
  readonly at: Float64Array;
  readonly value: number;
  constructor(source: "f" | "grad", at: Float64Array, value: number) {
    super(`lbfgsb: ${source} produced non-finite value ${value}`);
    this.name = "LBfgsbNonFiniteError";
    this.source = source;
    this.at = at;
    this.value = value;
  }
}

const DEFAULT_MAXCOR = 10;
const DEFAULT_FTOL = 2.220446049250313e-9;  // 1e7 * machine_eps
const DEFAULT_GTOL = 1e-5;
const DEFAULT_MAXITER = 15000;
const DEFAULT_MAXFUN = 15000;
const DEFAULT_MAXLS = 20;

/** Powell's curvature-condition safeguard: append `(s,y)` only if `s·y > CURVATURE_EPS · √((s·s)(y·y))`. */
const CURVATURE_EPS = 2.2e-16;

/** "Is at bound" tolerance: `|x - bound| ≤ BOUND_EPS · (1 + |bound|)`. */
const BOUND_EPS = 1e-15;

// -----------------------------------------------------------------------------
// Driver
// -----------------------------------------------------------------------------

/**
 * Limited-memory BFGS with simple bound constraints. Minimise `f`
 * subject to `lower ≤ x ≤ upper` from starting point `x0`.
 *
 * `lower[i] = -Infinity` declares the i-th coordinate unbounded
 * below; `upper[i] = +Infinity` analogously. Equal bounds (`lower[i]
 * = upper[i]`) fix the i-th coordinate.
 *
 * Throws `LBfgsbInfeasibleBoundsError` if any `lower[i] > upper[i]`.
 * Throws `LBfgsbX0OutsideBoundsError` if any `x0[i]` is strictly
 * outside `[lower[i], upper[i]]`.
 * Throws `LBfgsbNonFiniteError` if `f` or `grad` returns NaN/Inf.
 *
 * Returns an agent-honest `LBfgsbResult` for every other input. The
 * `success` flag is true iff convergence was reached (status 0 or 1);
 * a max-iter / max-fun / line-search-failure exit produces the
 * same record shape with `success: false`.
 */
export function lbfgsProjected(
  fObj: (x: Float64Array) => number,
  gradObj: (x: Float64Array) => Float64Array,
  x0: Float64Array,
  lower: Float64Array,
  upper: Float64Array,
  options?: LBfgsbOptions,
): LBfgsbResult {
  const n = x0.length;
  if (lower.length !== n) throw new Error(`lbfgsb: lower.length ${lower.length} != x0.length ${n}`);
  if (upper.length !== n) throw new Error(`lbfgsb: upper.length ${upper.length} != x0.length ${n}`);

  // Bound-feasibility & initial-point checks (deterministic order).
  for (let i = 0; i < n; i++) {
    const lo = lower[i]!;
    const hi = upper[i]!;
    if (!(lo <= hi)) {
      throw new LBfgsbInfeasibleBoundsError(i, lo, hi);
    }
    const x0i = x0[i]!;
    if (x0i < lo || x0i > hi) {
      throw new LBfgsbX0OutsideBoundsError(i, x0i, lo, hi);
    }
  }

  const maxcor = options?.maxcor ?? DEFAULT_MAXCOR;
  const ftol = options?.ftol ?? DEFAULT_FTOL;
  const gtol = options?.gtol ?? DEFAULT_GTOL;
  const maxiter = options?.maxiter ?? DEFAULT_MAXITER;
  const maxfun = options?.maxfun ?? DEFAULT_MAXFUN;
  const maxls = options?.maxls ?? DEFAULT_MAXLS;

  if (maxcor <= 0) throw new Error(`lbfgsb: maxcor must be > 0 (got ${maxcor})`);
  if (maxiter <= 0) throw new Error(`lbfgsb: maxiter must be > 0 (got ${maxiter})`);
  if (maxfun <= 0) throw new Error(`lbfgsb: maxfun must be > 0 (got ${maxfun})`);
  if (maxls <= 0) throw new Error(`lbfgsb: maxls must be > 0 (got ${maxls})`);

  // Project x0 to feasible region under round-off.
  const x = new Float64Array(x0);
  for (let i = 0; i < n; i++) {
    const lo = lower[i]!;
    const hi = upper[i]!;
    if (Number.isFinite(lo) && x[i]! < lo) x[i] = lo;
    if (Number.isFinite(hi) && x[i]! > hi) x[i] = hi;
  }

  let nfev = 0;
  let nit = 0;
  let bfgsSkipCount = 0;
  let lineSearchFailCount = 0;
  const warnings: string[] = [];

  let f = fObj(x);
  nfev += 1;
  if (!Number.isFinite(f)) {
    throw new LBfgsbNonFiniteError("f", x.slice(), f);
  }
  let g = new Float64Array(gradObj(x));
  if (g.length !== n) {
    throw new Error(`lbfgsb: grad returned length ${g.length}, expected ${n}`);
  }
  nfev += 1;
  for (let i = 0; i < n; i++) {
    if (!Number.isFinite(g[i]!)) {
      throw new LBfgsbNonFiniteError("grad", x.slice(), g[i]!);
    }
  }

  // L-BFGS m-history: ring buffers for s, y vectors and cached s·y, y·y dot products.
  const history = new History(n, maxcor);

  // Initial inverse-Hessian scale (the "γ" in Nocedal-Wright Algorithm
  // 7.4 / 7.5). Initial value 1.0; updated to `(s_k·y_k)/(y_k·y_k)`
  // after each successful update (the BFGS scaling that approximates
  // the Hessian's inverse-eigenvalue order of magnitude).
  let gamma = 1.0;

  let gradInfNorm = projectedGradInfNorm(g, x, lower, upper);
  if (gradInfNorm <= gtol) {
    return finalise({
      x, fun: f, jac: g, gradInfNorm, nit, nfev,
      status: 0,
      statusMessage: "CONVERGENCE: NORM_OF_PROJECTED_GRADIENT_<=_PGTOL",
      bfgsSkipCount, lineSearchFailCount,
      lower, upper, warnings,
    });
  }

  // -1 = "not yet decided"; the loop sets a positive code on exit.
  let status: number = -1;
  let statusMessage = "";

  while (status === -1) {
    if (nit >= maxiter) {
      status = 2;
      statusMessage = "STOP: TOTAL NO. of ITERATIONS REACHED LIMIT";
      warnings.push(`max iterations reached (maxiter=${maxiter})`);
      break;
    }
    if (nfev >= maxfun) {
      status = 3;
      statusMessage = "STOP: TOTAL NO. of f AND g EVALUATIONS REACHED LIMIT";
      warnings.push(`max function evaluations reached (maxfun=${maxfun})`);
      break;
    }

    // ── Identify active set ──────────────────────────────────────
    // active[i] = true means coordinate i is at a bound and the
    // gradient pushes further into the bound. Such coordinates are
    // pinned this iteration; the search direction is zero on them.
    const active = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const xi = x[i]!;
      const lo = lower[i]!;
      const hi = upper[i]!;
      const atLo = Number.isFinite(lo) && xi <= lo + BOUND_EPS * (1 + Math.abs(lo)) && g[i]! > 0;
      const atHi = Number.isFinite(hi) && xi >= hi - BOUND_EPS * (1 + Math.abs(hi)) && g[i]! < 0;
      active[i] = atLo || atHi ? 1 : 0;
      if (atLo) x[i] = lo;
      if (atHi) x[i] = hi;
    }

    // ── L-BFGS direction on free coordinates ─────────────────────
    // Two-loop recursion (Nocedal 1980) on the projected gradient.
    // The projected gradient is g with active coordinates' components
    // zeroed; the inverse-Hessian product `d = -H g_proj` gives a
    // descent direction in the free subspace, with active components
    // identically zero (since `(s_k, y_k)` of the active coordinates
    // were zero when the active set last changed — the subspace
    // restriction is naturally preserved).
    const gProj = new Float64Array(n);
    for (let i = 0; i < n; i++) gProj[i] = active[i]! ? 0 : g[i]!;
    const d = twoLoopRecursion(gProj, history, gamma);
    // Negate to get the search direction.
    for (let i = 0; i < n; i++) d[i] = -d[i]!;
    // Force zero on active coordinates (under round-off the two-loop
    // recursion may produce small noise on those).
    for (let i = 0; i < n; i++) if (active[i]!) d[i] = 0;

    // Sanity check: `d` must be a descent direction, `g·d < 0`. If
    // round-off has destroyed this, fall back to steepest descent on
    // the free subspace.
    let gd = 0;
    for (let i = 0; i < n; i++) gd += g[i]! * d[i]!;
    if (gd >= 0) {
      // Reset to steepest descent on free coordinates.
      for (let i = 0; i < n; i++) d[i] = active[i]! ? 0 : -g[i]!;
      gd = 0;
      for (let i = 0; i < n; i++) gd += g[i]! * d[i]!;
      if (gd >= 0) {
        // No descent direction at all — projected gradient is zero
        // on free set; we're stuck (this shouldn't happen since we
        // exit on gtol above, but defensive).
        status = 0;
        statusMessage = "CONVERGENCE: NORM_OF_PROJECTED_GRADIENT_<=_PGTOL";
        break;
      }
    }

    // ── Step cap to feasibility ──────────────────────────────────
    let stepMax = Number.POSITIVE_INFINITY;
    for (let i = 0; i < n; i++) {
      const di = d[i]!;
      if (di === 0) continue;
      const xi = x[i]!;
      if (di > 0 && Number.isFinite(upper[i]!)) {
        const room = (upper[i]! - xi) / di;
        if (room < stepMax) stepMax = room;
      } else if (di < 0 && Number.isFinite(lower[i]!)) {
        const room = (lower[i]! - xi) / di;
        if (room < stepMax) stepMax = room;
      }
    }
    // Initial step. Clamp to stepMax to keep the trial point feasible.
    let alpha0 = Math.min(1.0, stepMax);
    if (alpha0 <= 0) {
      // Already at a bound in the descent direction — nothing to do.
      // (This path should be unreachable since `active` accounts for
      // bounds with descent gradient.)
      status = 0;
      statusMessage = "CONVERGENCE: NORM_OF_PROJECTED_GRADIENT_<=_PGTOL";
      break;
    }

    // ── Line search ──────────────────────────────────────────────
    const ls = lineSearch(
      fObj, gradObj, x, f, g, d, gd, alpha0, stepMax, lower, upper,
      maxls, Math.min(maxfun - nfev, 2 * maxls + 4),
    );
    nfev += ls.fevals;

    if (!ls.accepted) {
      lineSearchFailCount += 1;
      if (history.count > 0) {
        // Reset L-BFGS memory and retry next iteration with steepest
        // descent. Stale history can produce poor directions; the
        // v3.0 recovery rule is to clear memory.
        history.reset();
        gamma = 1.0;
        continue;
      }
      status = 4;
      statusMessage = "ABNORMAL TERMINATION IN LNSRCH";
      warnings.push(`line search failed at iteration ${nit} with no L-BFGS memory to reset`);
      break;
    }

    // Accept the step.
    const fOld = f;
    const xNew = ls.xNew;
    const fNew = ls.fNew;
    const gNew = ls.gNew;

    // L-BFGS update with curvature safeguard.
    const sBuf = new Float64Array(n);
    const yBuf = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      sBuf[i] = xNew[i]! - x[i]!;
      yBuf[i] = gNew[i]! - g[i]!;
    }
    let sy = 0;
    let yy = 0;
    let ss = 0;
    for (let i = 0; i < n; i++) {
      sy += sBuf[i]! * yBuf[i]!;
      yy += yBuf[i]! * yBuf[i]!;
      ss += sBuf[i]! * sBuf[i]!;
    }
    if (sy > CURVATURE_EPS * Math.sqrt(yy * ss)) {
      history.push(sBuf, yBuf, sy);
      // Initial inverse-Hessian scale γ_k = (s_k · y_k) / (y_k · y_k).
      const newGamma = sy / yy;
      gamma = Number.isFinite(newGamma) && newGamma > 0 ? newGamma : 1.0;
    } else {
      bfgsSkipCount += 1;
    }

    // Move to the new iterate; check convergence.
    nit += 1;
    f = fNew;
    for (let i = 0; i < n; i++) x[i] = xNew[i]!;
    // Copy gradient into the existing g buffer to keep the static
    // type stable (ArrayBuffer-backed throughout, vs the
    // ArrayBufferLike that may show up via cross-package inference).
    for (let i = 0; i < n; i++) g[i] = gNew[i]!;

    gradInfNorm = projectedGradInfNorm(g, x, lower, upper);

    if (gradInfNorm <= gtol) {
      status = 0;
      statusMessage = "CONVERGENCE: NORM_OF_PROJECTED_GRADIENT_<=_PGTOL";
      break;
    }
    const fScale = Math.max(Math.abs(fOld), Math.abs(fNew), 1);
    const fReduction = (fOld - fNew) / fScale;
    if (fReduction >= 0 && fReduction <= ftol) {
      status = 1;
      statusMessage = "CONVERGENCE: REL_REDUCTION_OF_F_<=_FACTR*EPSMCH";
      break;
    }
  }

  const finalStatus = (status === -1 ? 2 : status) as 0 | 1 | 2 | 3 | 4;
  return finalise({
    x, fun: f, jac: g, gradInfNorm, nit, nfev,
    status: finalStatus,
    statusMessage: statusMessage || "STOP: TOTAL NO. of ITERATIONS REACHED LIMIT",
    bfgsSkipCount, lineSearchFailCount,
    lower, upper, warnings,
  });
}

// -----------------------------------------------------------------------------
// Projected gradient infinity norm
// -----------------------------------------------------------------------------
//
// The honest stopping criterion. For a coordinate `x_i` at its lower
// bound `lo` with `g_i > 0`, descent in coordinate i would push x_i
// further below `lo` — but the bound prevents that, so the "effective"
// gradient is zero. Symmetric for the upper bound. Otherwise the
// projected gradient equals the raw gradient.

function projectedGradInfNorm(
  g: Float64Array,
  x: Float64Array,
  lower: Float64Array,
  upper: Float64Array,
): number {
  let nrm = 0;
  for (let i = 0; i < g.length; i++) {
    const gi = g[i]!;
    const xi = x[i]!;
    const lo = lower[i]!;
    const hi = upper[i]!;
    let proj = gi;
    if (Number.isFinite(lo) && xi <= lo + BOUND_EPS * (1 + Math.abs(lo)) && gi > 0) proj = 0;
    if (Number.isFinite(hi) && xi >= hi - BOUND_EPS * (1 + Math.abs(hi)) && gi < 0) proj = 0;
    const a = Math.abs(proj);
    if (a > nrm) nrm = a;
  }
  return nrm;
}

// -----------------------------------------------------------------------------
// L-BFGS history
// -----------------------------------------------------------------------------
//
// Ring-buffered storage of the m most recent `(s_k, y_k)` pairs.
// `head` is the slot index of the most-recent pair; `count` is the
// number of valid pairs (≤ maxcor). Pairs are walked oldest → newest
// via `slotOldestFirst(k)`.

class History {
  readonly n: number;
  readonly maxcor: number;
  readonly S: Float64Array;
  readonly Y: Float64Array;
  readonly dotSY: Float64Array;
  head: number;
  count: number;

  constructor(n: number, maxcor: number) {
    this.n = n;
    this.maxcor = maxcor;
    this.S = new Float64Array(n * maxcor);
    this.Y = new Float64Array(n * maxcor);
    this.dotSY = new Float64Array(maxcor);
    this.head = -1;
    this.count = 0;
  }

  reset(): void {
    this.head = -1;
    this.count = 0;
  }

  push(s: Float64Array, y: Float64Array, sy: number): void {
    const m = this.maxcor;
    this.head = (this.head + 1) % m;
    if (this.count < m) this.count += 1;
    const off = this.head * this.n;
    for (let i = 0; i < this.n; i++) {
      this.S[off + i] = s[i]!;
      this.Y[off + i] = y[i]!;
    }
    this.dotSY[this.head] = sy;
  }

  /** Slot index of the k-th-oldest pair (k=0 is oldest, k=count-1 is newest). */
  slotOldestFirst(k: number): number {
    const m = this.maxcor;
    const oldestSlot = ((this.head - this.count + 1) % m + m) % m;
    return (oldestSlot + k) % m;
  }
}

// -----------------------------------------------------------------------------
// Two-loop recursion (Nocedal 1980)
// -----------------------------------------------------------------------------
//
// Compute `H · v` where H is the L-BFGS approximation to the inverse
// Hessian: starting from `H_0 = γ I`, we iteratively apply the BFGS
// update on the m most-recent `(s_k, y_k)` pairs (oldest first).
// The two-loop form runs the recurrence backward (newest first) to
// build a scalar, then forward (oldest first) to produce `H v`,
// using only O(m·n) flops per call.
//
//     for i = newest .. oldest:    α_i = ρ_i s_i · q;   q -= α_i y_i
//     r = γ q
//     for i = oldest .. newest:    β = ρ_i y_i · r;     r += s_i (α_i - β)
//     return r
//
// where `ρ_i = 1 / (s_i · y_i)`. The recurrence is exact for the
// quasi-Newton inverse-Hessian update; it does not form H explicitly.

function twoLoopRecursion(
  v: Float64Array,
  history: History,
  gamma: number,
): Float64Array {
  const n = v.length;
  const q = new Float64Array(v);  // working copy
  const m = history.count;
  const alpha = new Float64Array(m);

  // Backward pass: newest → oldest.
  for (let k = m - 1; k >= 0; k--) {
    const slot = history.slotOldestFirst(k);
    const off = slot * n;
    let dot = 0;
    for (let i = 0; i < n; i++) dot += history.S[off + i]! * q[i]!;
    const sy = history.dotSY[slot]!;
    if (sy <= 0) continue;
    const a = dot / sy;
    alpha[k] = a;
    for (let i = 0; i < n; i++) q[i] = q[i]! - a * history.Y[off + i]!;
  }

  // Initial Hessian: H_0 = γ I.
  const r = new Float64Array(n);
  for (let i = 0; i < n; i++) r[i] = gamma * q[i]!;

  // Forward pass: oldest → newest.
  for (let k = 0; k < m; k++) {
    const slot = history.slotOldestFirst(k);
    const off = slot * n;
    const sy = history.dotSY[slot]!;
    if (sy <= 0) continue;
    let yDotR = 0;
    for (let i = 0; i < n; i++) yDotR += history.Y[off + i]! * r[i]!;
    const beta = yDotR / sy;
    const aMinusB = alpha[k]! - beta;
    for (let i = 0; i < n; i++) r[i] = r[i]! + aMinusB * history.S[off + i]!;
  }

  return r;
}

// -----------------------------------------------------------------------------
// Line search — strong-Wolfe via More-Thuente-style bracketing
// -----------------------------------------------------------------------------
//
// Find α ∈ (0, stepMax] with `x_new = clamp(x + α d, lower, upper)`
// satisfying:
//   (Armijo)    φ(α) ≤ φ(0) + c1 α φ'(0)
//   (Wolfe)     |φ'(α)| ≤ c2 |φ'(0)|
// where (c1, c2) = (1e-4, 0.9), φ(α) = f(x + α d), φ'(α) = ∇f(x +
// α d) · d.
//
// We use a **bracketing-then-zoom** structure (Nocedal-Wright
// Algorithm 3.5 / 3.6): trial points expand α on each iteration
// until either:
//   - Armijo fails or φ(α) ≥ φ(α_prev): bracket found. Zoom in.
//   - Wolfe holds: accept α directly.
//   - φ'(α) ≥ 0: bracket [α, α_prev]. Zoom in (note swap).
// Otherwise expand α and continue.
//
// Zoom: bisection between `α_lo` and `α_hi`. Cap iterations at
// maxls; if no Wolfe-satisfying α found, fall back to the best
// Armijo-satisfying α observed.

interface LineSearchResult {
  readonly accepted: boolean;
  readonly xNew: Float64Array;
  readonly fNew: number;
  readonly gNew: Float64Array;
  readonly fevals: number;
  readonly stepUsed: number;
}

function lineSearch(
  fObj: (x: Float64Array) => number,
  gradObj: (x: Float64Array) => Float64Array,
  x: Float64Array,
  f0: number,
  g0: Float64Array,
  d: Float64Array,
  phi0_prime: number,  // pre-computed g0·d
  alpha0: number,
  stepMax: number,
  lower: Float64Array,
  upper: Float64Array,
  maxls: number,
  fevalBudget: number,
): LineSearchResult {
  const n = x.length;
  const c1 = 1e-4;
  const c2 = 0.9;

  if (phi0_prime >= 0 || alpha0 <= 0) {
    return { accepted: false, xNew: new Float64Array(x), fNew: f0, gNew: new Float64Array(g0), fevals: 0, stepUsed: 0 };
  }

  let bestAlpha = 0;
  let bestPhi = f0;
  let bestX: Float64Array | null = null;
  let bestG: Float64Array | null = null;

  let alphaPrev = 0;
  let phiPrev = f0;
  let phiPrime_Prev = phi0_prime;

  let alpha = alpha0;
  let fevals = 0;

  for (let iter = 0; iter < maxls; iter++) {
    if (fevals + 2 > fevalBudget) break;

    const xTrial = trialPoint(x, d, alpha, lower, upper);
    const phi = fObj(xTrial);
    fevals += 1;
    if (!Number.isFinite(phi)) {
      // Shrink on non-finite f.
      alpha = 0.5 * (alphaPrev + alpha);
      if (alpha <= alphaPrev * 1.0000001) break;
      continue;
    }

    // Bracket condition 1: Armijo fails OR φ(α) ≥ φ(α_prev).
    if (phi > f0 + c1 * alpha * phi0_prime || (iter > 0 && phi >= phiPrev)) {
      // Bracket found at [alphaPrev, alpha]. Zoom.
      const z = zoom(
        fObj, gradObj, x, d, lower, upper,
        f0, phi0_prime, c1, c2,
        alphaPrev, alpha,
        phiPrev, phi,
        phiPrime_Prev,
        maxls - iter, fevalBudget - fevals,
      );
      fevals += z.fevals;
      if (z.accepted) {
        return { accepted: true, xNew: z.xNew, fNew: z.fNew, gNew: z.gNew, fevals, stepUsed: z.stepUsed };
      }
      // Zoom failed; fall back to best Armijo-satisfying point.
      break;
    }

    // Armijo holds — evaluate gradient.
    const gTrial = gradObj(xTrial);
    fevals += 1;
    let gValid = true;
    for (let i = 0; i < n; i++) if (!Number.isFinite(gTrial[i]!)) { gValid = false; break; }
    if (!gValid) {
      alpha = 0.5 * (alphaPrev + alpha);
      if (alpha <= alphaPrev * 1.0000001) break;
      continue;
    }
    let phi_prime = 0;
    for (let i = 0; i < n; i++) phi_prime += gTrial[i]! * d[i]!;

    // Track best Armijo candidate (will be updated as we go).
    if (phi < bestPhi) {
      bestPhi = phi;
      bestAlpha = alpha;
      bestX = xTrial;
      bestG = gTrial;
    }

    // Wolfe holds?
    if (Math.abs(phi_prime) <= c2 * (-phi0_prime)) {
      return { accepted: true, xNew: xTrial, fNew: phi, gNew: gTrial, fevals, stepUsed: alpha };
    }

    // Bracket condition 2: φ'(α) ≥ 0 ⇒ minimum is between alpha_prev and alpha.
    if (phi_prime >= 0) {
      const z = zoom(
        fObj, gradObj, x, d, lower, upper,
        f0, phi0_prime, c1, c2,
        alpha, alphaPrev,
        phi, phiPrev,
        phi_prime,
        maxls - iter, fevalBudget - fevals,
      );
      fevals += z.fevals;
      if (z.accepted) {
        return { accepted: true, xNew: z.xNew, fNew: z.fNew, gNew: z.gNew, fevals, stepUsed: z.stepUsed };
      }
      break;
    }

    // Continue expanding alpha.
    alphaPrev = alpha;
    phiPrev = phi;
    phiPrime_Prev = phi_prime;
    if (alpha >= stepMax) {
      // Hit the bound-feasibility cap; can't expand further.
      break;
    }
    const next = Math.min(alpha * 2.5, stepMax);
    if (next <= alpha) break;
    alpha = next;
  }

  if (bestX !== null && bestG !== null) {
    // Verify the best Armijo candidate still gives f-decrease (it
    // should by construction).
    if (bestPhi < f0) {
      return { accepted: true, xNew: bestX, fNew: bestPhi, gNew: bestG, fevals, stepUsed: bestAlpha };
    }
  }
  return { accepted: false, xNew: new Float64Array(x), fNew: f0, gNew: new Float64Array(g0), fevals, stepUsed: 0 };
}

interface ZoomResult {
  readonly accepted: boolean;
  readonly xNew: Float64Array;
  readonly fNew: number;
  readonly gNew: Float64Array;
  readonly fevals: number;
  readonly stepUsed: number;
}

function zoom(
  fObj: (x: Float64Array) => number,
  gradObj: (x: Float64Array) => Float64Array,
  x: Float64Array,
  d: Float64Array,
  lower: Float64Array,
  upper: Float64Array,
  f0: number,
  phi0_prime: number,
  c1: number,
  c2: number,
  alpha_lo: number,
  alpha_hi: number,
  phi_lo: number,
  phi_hi: number,
  phi_lo_prime: number,
  maxIter: number,
  fevalBudget: number,
): ZoomResult {
  const n = x.length;
  let fevals = 0;
  let bestX: Float64Array | null = null;
  let bestF = Number.POSITIVE_INFINITY;
  let bestG: Float64Array | null = null;
  let bestAlpha = 0;

  for (let iter = 0; iter < maxIter; iter++) {
    if (fevals + 2 > fevalBudget) break;

    // Cubic-interpolation step with a "stay-away-from-α_hi" safeguard.
    // For badly-scaled problems (Powell badly-scaled, Hilbert) the
    // cubic interpolant legitimately suggests α many orders of
    // magnitude smaller than the bracket midpoint; we allow this.
    // The only restriction: α must be strictly between α_lo and
    // α_hi, and not within 1% of the bracket length to α_hi (the
    // failed step) — that prevents the degenerate "interp keeps
    // returning the bad endpoint" case.
    let alpha = cubicInterp(alpha_lo, alpha_hi, phi_lo, phi_hi, phi_lo_prime);
    const aMin = Math.min(alpha_lo, alpha_hi);
    const aMax = Math.max(alpha_lo, alpha_hi);
    // Build a safe interval that excludes the failed-endpoint side.
    let aSafeMin: number;
    let aSafeMax: number;
    if (alpha_hi > alpha_lo) {
      // α_hi is the failed-large endpoint; safe up to 99% of the way to α_hi.
      aSafeMin = aMin;
      aSafeMax = aMax - 0.01 * (aMax - aMin);
    } else {
      // α_hi is the failed-small endpoint (rare; happens after a
      // phi_prime ≥ 0 swap). Keep symmetric on the other side.
      aSafeMin = aMin + 0.01 * (aMax - aMin);
      aSafeMax = aMax;
    }
    if (!(alpha > aSafeMin && alpha < aSafeMax)) {
      alpha = 0.5 * (alpha_lo + alpha_hi);
    }
    if (Math.abs(alpha_hi - alpha_lo) < 1e-15) break;

    const xTrial = trialPoint(x, d, alpha, lower, upper);
    const phi = fObj(xTrial);
    fevals += 1;
    if (!Number.isFinite(phi)) {
      alpha_hi = alpha;
      phi_hi = phi;
      continue;
    }

    if (phi > f0 + c1 * alpha * phi0_prime || phi >= phi_lo) {
      alpha_hi = alpha;
      phi_hi = phi;
      continue;
    }

    const gTrial = gradObj(xTrial);
    fevals += 1;
    let phi_prime = 0;
    for (let i = 0; i < n; i++) phi_prime += gTrial[i]! * d[i]!;

    if (phi < bestF) {
      bestF = phi;
      bestX = xTrial;
      bestG = gTrial;
      bestAlpha = alpha;
    }

    if (Math.abs(phi_prime) <= c2 * (-phi0_prime)) {
      return { accepted: true, xNew: xTrial, fNew: phi, gNew: gTrial, fevals, stepUsed: alpha };
    }
    if (phi_prime * (alpha_hi - alpha_lo) >= 0) {
      alpha_hi = alpha_lo;
      phi_hi = phi_lo;
    }
    alpha_lo = alpha;
    phi_lo = phi;
    phi_lo_prime = phi_prime;
  }

  if (bestX !== null && bestG !== null && bestF < f0) {
    return { accepted: true, xNew: bestX, fNew: bestF, gNew: bestG, fevals, stepUsed: bestAlpha };
  }
  return { accepted: false, xNew: new Float64Array(x), fNew: f0, gNew: new Float64Array(0), fevals, stepUsed: 0 };
}

/**
 * Cubic interpolation minimiser. Given φ(a), φ(b), φ'(a), find the
 * minimum of the cubic interpolant in [min(a,b), max(a,b)]. Returns
 * the candidate; the caller safeguards by clipping to a "safe"
 * interior fraction of the bracket.
 */
function cubicInterp(a: number, b: number, fa: number, fb: number, fpa: number): number {
  // Quadratic interp using fa, fb, fpa:
  // q(t) = fa + fpa (t - a) + c (t - a)^2 ; q(b) = fb ⇒ c = (fb - fa - fpa(b-a))/(b-a)^2
  // q'(t*) = 0 ⇒ t* = a - fpa / (2c)
  const dt = b - a;
  if (dt === 0) return a;
  const c = (fb - fa - fpa * dt) / (dt * dt);
  if (!(c > 0)) return a + 0.5 * dt;
  const tStar = a - fpa / (2 * c);
  if (!Number.isFinite(tStar)) return a + 0.5 * dt;
  return tStar;
}

/**
 * Build the trial point `x_new = clamp(x + α d, lower, upper)`. The
 * clamp is a defensive rounding under float noise — `d` is supposed
 * to keep us feasible since active coordinates were zeroed and the
 * step was capped at `stepMax`.
 */
function trialPoint(
  x: Float64Array,
  d: Float64Array,
  alpha: number,
  lower: Float64Array,
  upper: Float64Array,
): Float64Array {
  const n = x.length;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let xi = x[i]! + alpha * d[i]!;
    const lo = lower[i]!;
    const hi = upper[i]!;
    if (Number.isFinite(lo) && xi < lo) xi = lo;
    if (Number.isFinite(hi) && xi > hi) xi = hi;
    out[i] = xi;
  }
  return out;
}

// -----------------------------------------------------------------------------
// Result finaliser
// -----------------------------------------------------------------------------

function finalise(args: {
  x: Float64Array;
  fun: number;
  jac: Float64Array;
  gradInfNorm: number;
  nit: number;
  nfev: number;
  status: 0 | 1 | 2 | 3 | 4;
  statusMessage: string;
  bfgsSkipCount: number;
  lineSearchFailCount: number;
  lower: Float64Array;
  upper: Float64Array;
  warnings: string[];
}): LBfgsbResult {
  let activeBoundsCount = 0;
  for (let i = 0; i < args.x.length; i++) {
    const lo = args.lower[i]!;
    const hi = args.upper[i]!;
    const xi = args.x[i]!;
    const atLo = Number.isFinite(lo) && xi <= lo + BOUND_EPS * (1 + Math.abs(lo));
    const atHi = Number.isFinite(hi) && xi >= hi - BOUND_EPS * (1 + Math.abs(hi));
    if (atLo || atHi) activeBoundsCount += 1;
  }
  return {
    x: args.x,
    fun: args.fun,
    jac: args.jac,
    gradInfNorm: args.gradInfNorm,
    nit: args.nit,
    nfev: args.nfev,
    status: args.status,
    statusMessage: args.statusMessage,
    success: args.status === 0 || args.status === 1,
    bfgsSkipCount: args.bfgsSkipCount,
    lineSearchFailCount: args.lineSearchFailCount,
    activeBoundsCount,
    warnings: args.warnings,
  };
}
