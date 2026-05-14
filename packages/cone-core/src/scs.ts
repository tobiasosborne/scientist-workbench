// =============================================================================
// scs.ts — the SCS operator-splitting iteration
// =============================================================================
//
// `scsSolve` is the substrate behind `tools/cone-solve`: the SCS-style
// alternating-direction iteration on the homogeneous self-dual embedding
// (O'Donoghue et al 2016). It takes a `ConeProblem`, runs the three-step
// iteration to a precision target, and returns a discriminated
// `SCSResult` — a primal–dual solution, an infeasibility/unboundedness
// certificate, an iteration-cap best effort, or a numerical-breakdown
// report. The status discriminant *is* the contract: you cannot read an
// `objective` off an `infeasible` result, by construction of the type.
//
// Ground truth: `docs/ground-truth/convex/scs-algorithm.md`, transcribed
// from `docs/refs/odonoghue-2016-scs.pdf`. The three-step iteration is
// eq (17) §3.2.3 (p. 1051); over-relaxation is §3.3; zero-avoiding
// initialisation is §3.4; the termination taxonomy is §3.5 (evaluated by
// `recoverPrimalDual` in `hsde.ts`); the efficient subspace projection —
// the Sherman–Morrison–Woodbury factorisation-caching scheme — is §4.1
// (p. 1055–1057).
//
// The iteration in one breath (with over-relaxation parameter α):
//
//     ũ   = (I + Q)⁻¹ (u + v)                    — subspace projection (§4.1)
//     ǔ   = α·ũ + (1−α)·u                        — over-relaxation     (§3.3)
//     u⁺  = Π_𝒞 (ǔ − v)                          — cone projection     (§3.2.3)
//     v⁺  = v − ǔ + u⁺                           — dual update         (§3.2.3)
//
// where 𝒞 = ℝⁿ × 𝒦* × ℝ₊ is the cone the embedding's `u` lives in.

import {
  type Matrix,
  type LUResult,
  matZeros,
  set,
  lu,
  luSolve,
  matNorm1,
  hagerOneNormEstimate,
} from "@workbench/linalg-core";
import { type Cone, ConeError, coneDim, dualCone, free, nonNeg, projectCone } from "./cones.js";
import {
  type ConeProblem,
  type Candidate,
  type Tolerances,
  buildHSDE,
  dot,
  recoverPrimalDual,
} from "./hsde.js";
import { applyScaling, equilibrate } from "./scaling.js";
import { makeAnderson } from "./anderson.js";

// -----------------------------------------------------------------------------
// Options and result
// -----------------------------------------------------------------------------

/**
 * Knobs for `scsSolve`. ADR-0030 makes `precision` the single user-facing
 * dial; `maxIter` and `alpha` are the tier's standard `--max-iter` flag
 * and the over-relaxation parameter. The internal tolerance triple
 * (`epsPri`/`epsDual`/`epsGap`/…) is *derived* from `precision`, not
 * exposed — see `tolerancesFromPrecision`.
 */
export interface SCSOpts {
  /**
   * Convergence-precision target — the primal/dual feasibility and gap
   * tolerance. ADR-0030 default `1e-8`. The SCS first-order method is a
   * modest-accuracy solver; sub-`1e-6` targets may hit `iter-cap`
   * (ADR-0030 §B accuracy ceiling), which is reported honestly.
   */
  readonly precision: number;
  /**
   * Iteration cap. ADR-0030 default for the SCS-ADMM path is `2500`.
   * Hitting it returns `status: "iter-cap"` with the best-effort iterate,
   * never a `optimal` lie.
   */
  readonly maxIter: number;
  /**
   * Over-relaxation parameter `α ∈ ]0, 2[` (O'Donoghue §3.3). `α = 1` is
   * the basic iteration; the paper reports `α ≈ 1.5` improves
   * convergence, which is the default here.
   */
  readonly alpha: number;
  /**
   * Anderson-acceleration memory window (ADR-0036). The accelerator keeps
   * the last `andersonMemory` residual- and image-differences and
   * extrapolates through a small least-squares solve, collapsing SCS's
   * slow linear tail. Default `10`. `0` disables acceleration and
   * recovers the exact plain-SCS trajectory — kept for the determinism
   * cross-check and for testing the un-accelerated path.
   */
  readonly andersonMemory: number;
}

/** ADR-0030 + ADR-0036 defaults for the SCS-ADMM path. */
export const DEFAULT_SCS_OPTS: SCSOpts = {
  precision: 1e-8,
  maxIter: 2500,
  alpha: 1.5,
  andersonMemory: 10,
};

/** The five termination classes of ADR-0030 §A.3, as they apply to SCS. */
export type SCSStatus =
  | "optimal"
  | "infeasible"
  | "unbounded"
  | "iter-cap"
  | "numerical-breakdown";

/**
 * The outcome of a solve. A discriminated union: the `status` tells you
 * which fields are present and *what they mean*, so the type itself
 * forbids reading an objective off an infeasible result.
 *
 *  - **optimal** — `x, y, s` are a primal–dual solution; `achievedPrecision`
 *    is the honest max relative residual at termination.
 *  - **infeasible** — the primal is infeasible; `certificate` is a Farkas
 *    `y` (`Aᵀy ≈ 0`, `y ∈ 𝒦*`, `bᵀy = −1`).
 *  - **unbounded** — the primal is unbounded (dual infeasible);
 *    `certificate` is a ray `x` (`−Ax ∈ 𝒦`, `cᵀx = −1`).
 *  - **iter-cap** — `maxIter` hit first. `x, y, s` are the best-effort
 *    iterate (present only if some iterate had `u_τ > 0`);
 *    `achievedPrecision` is its max relative residual — *not* within
 *    `precision`, reported so the caller can decide.
 *  - **numerical-breakdown** — a non-finite iterate or a failed
 *    factorisation; `detail` explains which.
 */
export type SCSResult =
  | {
      readonly status: "optimal";
      readonly x: Float64Array;
      readonly y: Float64Array;
      readonly s: Float64Array;
      readonly objective: number;
      readonly iterations: number;
      readonly achievedPrecision: number;
      /** Hager 1-norm condition estimate of the subspace system `M` (§4.1). */
      readonly conditionEstimate: number;
    }
  | {
      readonly status: "infeasible";
      readonly certificate: Float64Array;
      readonly iterations: number;
      readonly conditionEstimate: number;
    }
  | {
      readonly status: "unbounded";
      readonly certificate: Float64Array;
      readonly iterations: number;
      readonly conditionEstimate: number;
    }
  | {
      readonly status: "iter-cap";
      readonly x?: Float64Array;
      readonly y?: Float64Array;
      readonly s?: Float64Array;
      readonly objective?: number;
      readonly iterations: number;
      readonly achievedPrecision: number;
      /** Hager 1-norm condition estimate of the subspace system `M` (§4.1). */
      readonly conditionEstimate: number;
    }
  | {
      readonly status: "numerical-breakdown";
      readonly iterations: number;
      readonly detail: string;
    };

// -----------------------------------------------------------------------------
// tolerance derivation
// -----------------------------------------------------------------------------

/**
 * Derive the §3.5 tolerance struct from the single `precision` knob, per
 * ADR-0030 §A.2: the primal/dual feasibility and gap tolerances are the
 * knob value directly; the certificate tolerances follow the paper's
 * "all ε equal" default (§6.1).
 */
export function tolerancesFromPrecision(precision: number): Tolerances {
  return {
    epsPri: precision,
    epsDual: precision,
    epsGap: precision,
    epsUnbdd: precision,
    epsInfeas: precision,
  };
}

// -----------------------------------------------------------------------------
// the v0.1 cone-support gate
// -----------------------------------------------------------------------------

/**
 * cone-core v0.1 projects only the LP-complete cone families (nonneg /
 * zero / free; see `cones.ts`). Reject any other family *at setup*, with
 * the `ConeError` that `projectCone` would itself raise — so the failure
 * is loud and immediate, not surfaced mid-iteration after wasted work.
 */
function assertV01Projectable(cones: readonly Cone[]): void {
  for (const K of cones) {
    if (K.kind !== "nonneg" && K.kind !== "zero" && K.kind !== "free") {
      // Provoke the precise ConeError + bead pointer from cones.ts.
      projectCone(new Float64Array(coneDim(K)), K);
    }
  }
}

// -----------------------------------------------------------------------------
// product-cone projection
// -----------------------------------------------------------------------------

/**
 * Project `z` onto the product cone `cones`, block by block. The block
 * dimensions must sum to `z.length` (the caller — `scsSolve` — guarantees
 * this by construction of the embedding cone 𝒞). Returns a fresh array.
 */
function projectProduct(z: Float64Array, cones: readonly Cone[]): Float64Array {
  const out = new Float64Array(z.length);
  let off = 0;
  for (const K of cones) {
    const d = coneDim(K);
    const block = projectCone(z.subarray(off, off + d), K);
    out.set(block, off);
    off += d;
  }
  if (off !== z.length) {
    throw new ConeError(
      `projectProduct: cone blocks summed to ${off}, vector length is ${z.length}`,
    );
  }
  return out;
}

// -----------------------------------------------------------------------------
// the cached subspace projection (§4.1)
// -----------------------------------------------------------------------------

/**
 * Everything precomputed once per solve for the subspace projection
 * `ũ = (I + Q)⁻¹ w`. `M = [[I, Aᵀ], [−A, I]]` depends only on `A`, so its
 * LU factor is computed once; `g = M⁻¹ h` and `denom = 1 + hᵀg` are the
 * Sherman–Morrison–Woodbury rank-1 ingredients (h = [c; b]).
 */
interface SubspaceCache {
  readonly n: number;
  readonly m: number;
  /** LU factor of `M = [[I, Aᵀ], [−A, I]]`, size `(n+m)²`. */
  readonly luM: LUResult;
  /**
   * Hager 1-norm condition estimate of `M` — `‖M‖₁ · ‖M⁻¹‖₁`, the
   * second factor estimated from the cached LU factor. Computed once
   * (M is fixed across the solve) and reported in the result so a
   * caller can read off how well-conditioned the subspace system was.
   */
  readonly conditionEstimate: number;
  /** `h = [c; b]`, length `n + m`. */
  readonly h: Float64Array;
  /** `g = M⁻¹ h`, length `n + m`. */
  readonly g: Float64Array;
  /** `denom = 1 + hᵀ g` — the SMW denominator; nonzero since `I + Q` is invertible. */
  readonly denom: number;
  /** `c`, length `n` — kept for the `ũ_τ` scalar formula. */
  readonly c: Float64Array;
  /** `b`, length `m` — kept for the `ũ_τ` scalar formula. */
  readonly b: Float64Array;
}

/**
 * Assemble `M = [[I, Aᵀ], [−A, I]]` and precompute the SMW ingredients.
 * Returns `null` on a failed factorisation (treated as
 * `numerical-breakdown` by the caller — `M` is invertible in exact
 * arithmetic, so a `null` here means the data is ill-conditioned beyond
 * rescue).
 */
function buildSubspaceCache(A: Matrix, b: Float64Array, c: Float64Array): SubspaceCache | null {
  const n = A.cols;
  const m = A.rows;
  const dim = n + m;

  // M = [[I, Aᵀ], [−A, I]]
  const M = matZeros(dim, dim);
  for (let i = 0; i < n; i++) set(M, i, i, 1); // top-left I
  for (let i = 0; i < m; i++) set(M, n + i, n + i, 1); // bottom-right I
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < m; j++) {
      const a = A.data[j * n + i]!; // A[j][i]
      set(M, i, n + j, a); //  Aᵀ block
      set(M, n + j, i, -a); // −A block
    }
  }

  const luM = lu(M);
  if (luM === null) return null;

  // M is fixed across the whole solve, so its conditioning is computed
  // once here: ‖M‖₁ exactly, ‖M⁻¹‖₁ via the Hager estimator on the LU.
  const conditionEstimate = matNorm1(M) * hagerOneNormEstimate(luM);

  // h = [c; b]
  const h = new Float64Array(dim);
  h.set(c, 0);
  h.set(b, n);

  // g = M⁻¹ h ;  denom = 1 + hᵀg
  const g = luSolve(luM, h);
  const denom = 1 + dot(h, g);
  if (!Number.isFinite(denom) || Math.abs(denom) < 1e-300) return null;

  return { n, m, luM, conditionEstimate, h, g, denom, c, b };
}

/**
 * The subspace projection `ũ = (I + Q)⁻¹ w` (§4.1), via the cached LU
 * factor of `M` and the Sherman–Morrison–Woodbury rank-1 correction:
 *
 *     rhs        = [w_x; w_y] − w_τ · h
 *     p          = M⁻¹ · rhs                       (cached factor)
 *     [ũ_x; ũ_y] = p − g · (hᵀp) / denom            (SMW correction)
 *     ũ_τ        = w_τ + cᵀ ũ_x + bᵀ ũ_y
 *
 * `w` and the returned `ũ` both have length `n + m + 1`.
 */
function subspaceProject(cache: SubspaceCache, w: Float64Array): Float64Array {
  const { n, m, luM, h, g, denom, c, b } = cache;
  const dim = n + m;
  const wTau = w[dim]!;

  // rhs = [w_x; w_y] − w_τ · h
  const rhs = new Float64Array(dim);
  for (let i = 0; i < dim; i++) rhs[i] = w[i]! - wTau * h[i]!;

  // p = M⁻¹ rhs
  const p = luSolve(luM, rhs);

  // SMW: [ũ_x; ũ_y] = p − g · (hᵀp / denom)
  const hTp = dot(h, p);
  const factor = hTp / denom;
  const out = new Float64Array(dim + 1);
  for (let i = 0; i < dim; i++) out[i] = p[i]! - g[i]! * factor;

  // ũ_τ = w_τ + cᵀ ũ_x + bᵀ ũ_y
  let uTau = wTau;
  for (let i = 0; i < n; i++) uTau += c[i]! * out[i]!;
  for (let i = 0; i < m; i++) uTau += b[i]! * out[n + i]!;
  out[dim] = uTau;
  return out;
}

// -----------------------------------------------------------------------------
// scsSolve — the iteration
// -----------------------------------------------------------------------------

/** Whether every entry of a vector is finite. */
function allFinite(v: Float64Array): boolean {
  for (let i = 0; i < v.length; i++) {
    if (!Number.isFinite(v[i]!)) return false;
  }
  return true;
}

/** The honest max relative residual of a candidate, per the §3.5 denominators. */
function maxRelativeResidual(cand: Candidate, bNorm: number, cNorm: number): number {
  const relP = cand.primalResidual / (1 + bNorm);
  const relD = cand.dualResidual / (1 + cNorm);
  // gap is already compared against (1 + |cᵀx| + |bᵀy|); reconstruct it
  const relG = Math.abs(cand.gap) / (1 + Math.abs(cand.objective) + Math.abs(cand.gap - cand.objective));
  return Math.max(relP, relD, relG);
}

/**
 * Solve a convex cone program by the SCS operator-splitting iteration on
 * its homogeneous self-dual embedding.
 *
 * The algorithm (ground truth: `docs/ground-truth/convex/scs-algorithm.md`):
 *
 *  1. **Setup.** `buildHSDE` validates the problem; `buildSubspaceCache`
 *     assembles `M = [[I, Aᵀ], [−A, I]]`, LU-factors it once, and caches
 *     the Sherman–Morrison–Woodbury ingredients (§4.1). The embedding
 *     cone `𝒞 = ℝⁿ × 𝒦* × ℝ₊` is assembled as a product `Cone[]`.
 *
 *  2. **Initialise** (§3.4) `u⁰ = (0,…,0,1)`, `v⁰ = (0,…,0,1)` — the only
 *     entries set are `u_τ = 1` and `v_κ = 1`. This keeps the iteration
 *     away from the embedding's trivial zero solution.
 *
 *  3. **Iterate** (§3.2.3 eq 17 + §3.3 over-relaxation): subspace
 *     projection → over-relaxation → cone projection → dual update.
 *     Every iteration `recoverPrimalDual` runs the §3.5 termination test;
 *     the first of optimal / unbounded / infeasible to fire stops the
 *     loop. A non-finite iterate stops it as `numerical-breakdown`.
 *
 *  4. **Iteration cap.** If `maxIter` passes with no branch firing,
 *     return `iter-cap` carrying the best-effort iterate and its honest
 *     (sub-`precision`) `achievedPrecision` — never an `optimal` lie.
 *
 * Determinism (ADR-0030, `numerical: true`): the iteration is a fixed
 * sequence of IEEE-754 float64 operations in a fixed order — reproducible
 * given `(problem, opts, platform)`. No comparison uses an implicit-zero
 * gate; every threshold is an explicit tolerance.
 *
 * v0.1 cone support is the LP-complete subset (nonneg / zero / free); a
 * problem carrying an SOC / PSD / EXP / POW cone raises `ConeError` at
 * setup (see `assertV01Projectable`).
 */
export function scsSolve(problem: ConeProblem, opts: SCSOpts = DEFAULT_SCS_OPTS): SCSResult {
  // Validate options up front — a bad knob is a programming error.
  if (!(opts.precision > 0) || !Number.isFinite(opts.precision)) {
    throw new ConeError(`scsSolve: precision must be a positive finite number, got ${opts.precision}`);
  }
  if (!Number.isInteger(opts.maxIter) || opts.maxIter < 1) {
    throw new ConeError(`scsSolve: maxIter must be a positive integer, got ${opts.maxIter}`);
  }
  if (!(opts.alpha > 0 && opts.alpha < 2)) {
    throw new ConeError(`scsSolve: alpha must lie in the open interval ]0, 2[, got ${opts.alpha}`);
  }
  if (!Number.isInteger(opts.andersonMemory) || opts.andersonMemory < 0) {
    throw new ConeError(
      `scsSolve: andersonMemory must be a non-negative integer, got ${opts.andersonMemory}`,
    );
  }

  // ── setup ────────────────────────────────────────────────────────────────
  // The iteration runs on the *scaled* problem `Â = D A E` (O'Donoghue
  // §5 — the first-order method stalls on raw NETLIB-grade data); the
  // §3.5 termination test runs on the *original* residuals. So we build
  // two embeddings: `origHsde` (for `recoverPrimalDual`) and `scaledHsde`
  // (for the subspace cache and the iteration vectors).
  const origHsde = buildHSDE(problem);
  assertV01Projectable(origHsde.cones);
  const scaling = equilibrate(problem);
  const scaledHsde = buildHSDE(applyScaling(problem, scaling));
  const { n, m, N, A, b, c, cones } = scaledHsde;

  const cache = buildSubspaceCache(A, b, c);
  if (cache === null) {
    return {
      status: "numerical-breakdown",
      iterations: 0,
      detail: "subspace matrix M = [[I, Aᵀ], [−A, I]] could not be factorised (ill-conditioned data)",
    };
  }

  // The embedding cone 𝒞 = ℝⁿ × 𝒦* × ℝ₊: free block for x, the dual of
  // each slack cone for y, and a nonneg scalar for τ.
  const coneC: Cone[] = [free(n), ...cones.map(dualCone), nonNeg(1)];

  const tol = tolerancesFromPrecision(opts.precision);
  // Relative-residual denominators use the *original* b, c — the
  // candidate `recoverPrimalDual` returns is in original coordinates.
  const bNorm = Math.sqrt(dot(origHsde.b, origHsde.b));
  const cNorm = Math.sqrt(dot(origHsde.c, origHsde.c));
  const { alpha } = opts;

  // ── the fixed-point map φ ────────────────────────────────────────────────
  // One full SCS iteration (§3.2.3 eq 17 + §3.3 over-relaxation) as a map
  // on the embedding pair `z = [u (N); v (N)]`. Extracting it as `φ` lets
  // the Anderson accelerator (ADR-0036) treat the iteration as a generic
  // fixed-point map: `Gz = scsStep(z); z = aa.next(z, Gz)`.
  const scsStep = (z: Float64Array): Float64Array => {
    // w = u + v
    const w = new Float64Array(N);
    for (let i = 0; i < N; i++) w[i] = z[i]! + z[N + i]!;
    // ũ = (I + Q)⁻¹ w   (subspace projection, §4.1)
    const uTilde = subspaceProject(cache, w);
    // ǔ = α·ũ + (1 − α)·u   (over-relaxation, §3.3)
    const uRelax = new Float64Array(N);
    for (let i = 0; i < N; i++) uRelax[i] = alpha * uTilde[i]! + (1 - alpha) * z[i]!;
    // u⁺ = Π_𝒞(ǔ − v)   (cone projection, §3.2.3)
    const uMinusV = new Float64Array(N);
    for (let i = 0; i < N; i++) uMinusV[i] = uRelax[i]! - z[N + i]!;
    const uNext = projectProduct(uMinusV, coneC);
    // pack [u⁺ ; v⁺]   with   v⁺ = v − ǔ + u⁺
    const out = new Float64Array(2 * N);
    for (let i = 0; i < N; i++) {
      out[i] = uNext[i]!;
      out[N + i] = z[N + i]! - uRelax[i]! + uNext[i]!;
    }
    return out;
  };

  // ── initialise (§3.4) ────────────────────────────────────────────────────
  // `z = [u ; v]`; the only nonzero entries are `u_τ = 1` (index N−1) and
  // `v_κ = 1` (index 2N−1) — the zero-avoiding initialisation.
  let z: Float64Array = new Float64Array(2 * N);
  z[N - 1] = 1;
  z[2 * N - 1] = 1;

  const aa = makeAnderson(opts.andersonMemory);
  let lastCandidate: Candidate | undefined;

  // ── iterate: φ-step then Anderson-accelerate (ADR-0036) ──────────────────
  for (let k = 1; k <= opts.maxIter; k++) {
    const Gz = scsStep(z);
    z = aa.next(z, Gz);

    // A non-finite iterate is unrecoverable — ill-conditioning beyond
    // rescue (the accelerator's own safeguard already rejects a
    // non-finite *extrapolate*; this also catches a non-finite plain step).
    if (!allFinite(z)) {
      return {
        status: "numerical-breakdown",
        iterations: k,
        detail: "iterate became non-finite (NaN or ±Infinity) — data ill-conditioned beyond rescue",
      };
    }

    // Termination test (§3.5) on the *original* residuals: `recoverPrimalDual`
    // is given the original embedding plus the `scaling`, so it unscales
    // the iterate back to the original coordinates before checking §3.5.
    const u = z.subarray(0, N);
    const v = z.subarray(N, 2 * N);
    const rec = recoverPrimalDual(u, v, origHsde, tol, scaling);
    switch (rec.kind) {
      case "optimal":
        return {
          status: "optimal",
          x: rec.x,
          y: rec.y,
          s: rec.s,
          objective: rec.objective,
          iterations: k,
          achievedPrecision: maxRelativeResidual(rec, bNorm, cNorm),
          conditionEstimate: cache.conditionEstimate,
        };
      case "primal-infeasible":
        return {
          status: "infeasible",
          certificate: rec.certificate,
          iterations: k,
          conditionEstimate: cache.conditionEstimate,
        };
      case "dual-infeasible":
        return {
          status: "unbounded",
          certificate: rec.certificate,
          iterations: k,
          conditionEstimate: cache.conditionEstimate,
        };
      case "inconclusive":
        if (rec.candidate !== undefined) lastCandidate = rec.candidate;
        break;
    }
  }

  // ── iteration cap ────────────────────────────────────────────────────────
  if (lastCandidate === undefined) {
    // No iterate ever had u_τ > 0 — nothing to read off. Honest precision
    // is "unknown / unbounded" — report +∞ so the caller never mistakes
    // it for a converged answer.
    return {
      status: "iter-cap",
      iterations: opts.maxIter,
      achievedPrecision: Infinity,
      conditionEstimate: cache.conditionEstimate,
    };
  }
  return {
    status: "iter-cap",
    x: lastCandidate.x,
    y: lastCandidate.y,
    s: lastCandidate.s,
    objective: lastCandidate.objective,
    iterations: opts.maxIter,
    achievedPrecision: maxRelativeResidual(lastCandidate, bNorm, cNorm),
    conditionEstimate: cache.conditionEstimate,
  };
}
