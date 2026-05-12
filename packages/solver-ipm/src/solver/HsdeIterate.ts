// Type definitions for the HSDE (Homogeneous Self-Dual Embedding) IPM
// path. Pure types — no algorithm, no factory. The Phase 1 / Phase 2
// solvers (`HsdeLpSolver.ts`, `HsdeNtSdpSolver.ts`) own iterate
// construction and may extend the shape with implementation-specific
// scratch buffers without touching this file. Keep this surface
// minimal — the iterate fields below are the *contract*, not the
// totality of what an implementation needs.
//
// Design choice: HSDE adds two scalar variables `τ` (primal
// homogenization) and `κ` (dual homogenization) to the iterate. The
// HSDE block (Mosek capi.pdf eq. 13.8) is:
//
//     A·x − b·τ            = 0      (primal feasibility, residual r_p)
//     A^T·y + s − c·τ      = 0      (dual feasibility, residual r_d)
//     −c^T·x + b^T·y − κ   = 0      (gap feasibility, residual r_g)
//                  x^T·s + τ·κ = 0  (homogenized complementarity)
//
// Two HSDE-vs-legacy distinctions to keep in mind everywhere these
// types appear:
//
//   1. μ-denominator is `n + 1`, NOT `n`. The HSDE iterate has n
//      cone slots and one τκ slot, so the complementarity measure
//      `μ = (x^T s + τ κ) / (n + 1)` averages over `n + 1`
//      slots. The legacy non-HSDE solvers divide by `n`.
//
//   2. The reported solution is the *purified* iterate
//      `(x*, y*, s*) / τ*`. The iterate carried through the loop is
//      unpurified — the snapshot/best-iterate fields likewise hold
//      the unpurified form (see ADR-0033 §"Hazard §3.3"). Division
//      by τ* happens once, at return.
//
// References: ADR-0033 (this port's design decisions); Andersen 2009
// (`docs/refs/andersen-2009-homogeneous-self-dual.pdf`) eq. 3 for the
// HSDE block; Mosek capi.pdf §13.3 for the column/residual schema.

import type { SolverStatus } from "./Iterate.js";

// ─────────────────────────────────────────────────────────────────────
// Residuals
// ─────────────────────────────────────────────────────────────────────

/**
 * The three HSDE residuals and the complementarity measure. Residual
 * sign conventions follow Mosek capi.pdf eq. 13.8 (and Andersen 2009
 * eq. 3, which is algebraically the same with rearrangement):
 *
 *   r_p = A·x − b·τ          ∈ R^m
 *   r_d = A^T·y + s − c·τ    ∈ R^n  (LP)  /  R^{n×n} per block (SDP)
 *   r_g = −c^T·x + b^T·y − κ ∈ R
 *
 * `pres`, `dres`, `gres` are the normalized (relative) scaled
 * versions used by the convergence test — Mosek's ρ_p, ρ_d, ρ_g
 * (capi.pdf §13.3.2). The log columns PFEAS / DFEAS / GFEAS show
 * un-normalized `‖r_p‖_∞`, `‖r_d‖_∞`, `|r_g|`; the termination
 * check uses the τ-divided ρ-form.
 *
 * `prstatus = (b^T y − c^T x) / max(‖b‖_∞, ‖c‖_∞, 1)` — converges
 * to +1 on the optimal branch (τ → 1, κ → 0) and to −1 on the
 * infeasibility-certificate branch (τ → 0, κ → 1). The sign
 * threshold ±0.5 selects the termination branch (see ADR-0033
 * §"Decision 6").
 */
export interface HsdeResiduals {
  /** `‖r_p‖_∞` — primal infeasibility, un-normalized. */
  primalInf: number;
  /** `‖r_d‖_∞` — dual infeasibility, un-normalized. */
  dualInf: number;
  /** `|r_g|` — gap infeasibility, un-normalized. */
  gapInf: number;
  /** μ = (x·s + τκ) / (n + 1) — homogenized complementarity. */
  mu: number;
  /** ρ_p — scaled primal residual (≤ 1 ⇒ primal feasible to tol). */
  pres: number;
  /** ρ_d — scaled dual residual (≤ 1 ⇒ dual feasible to tol). */
  dres: number;
  /** ρ_g — scaled gap residual (≤ 1 ⇒ gap closed to tol). */
  gres: number;
  /** Primal-dual relative status indicator (∈ [−1, +1]). */
  prstatus: number;
}

// ─────────────────────────────────────────────────────────────────────
// Status — alias for solver-ipm's SolverStatus
// ─────────────────────────────────────────────────────────────────────

/**
 * HSDE termination status. Reuses the existing `SolverStatus`
 * taxonomy from `Iterate.ts` — HSDE's termination dichotomy maps
 * naturally onto it:
 *
 *   τ > 0, κ → 0, ρ ≤ 1, PRSTATUS > +0.5  →  "optimal"
 *   τ → 0, κ > 0, c^T x* < 0              →  "dual-infeasible"   (x* is certificate)
 *   τ → 0, κ > 0, b^T y* > 0              →  "primal-infeasible" (y* is certificate)
 *   max(ρ) ≤ near_rel · ε, soft success   →  "dual-feasible"     (worklog 095 soft-success bucket)
 *   ρ > 1, μ stalled, τ tiny              →  "numerical-difficulty"
 *   iter ≥ iterLimit                      →  "iter-limit"  (best-iterate returned)
 *   wall clock > timeLimit                →  "time-limit"  (best-iterate returned)
 *
 * The taxonomy is not extended — the existing vocabulary is
 * sufficient. See `Status.ts` for the wire-protocol mapping.
 */
export type HsdeStatus = SolverStatus;

// ─────────────────────────────────────────────────────────────────────
// LP HSDE iterate
// ─────────────────────────────────────────────────────────────────────

/**
 * The LP HSDE iterate carries the same `(x, y, s)` triple as the
 * legacy LP solver, augmented by the two homogenization scalars
 * `τ > 0` and `κ > 0`.
 *
 * Cone: `x ∈ R^n_+`, `s ∈ R^n_+`.
 *
 * The minimum surface defined here is intentionally small — the
 * fields below are what every HSDE LP implementation must carry.
 * Implementation-specific scratch (Schur workspace, scaled
 * directions, predictor-corrector cache, regularization state)
 * lives in the solver module and is not part of the contract.
 */
export interface HsdeLpIterate {
  m: number;
  n: number;
  /** Primal cone variables, x ∈ R^n_+. */
  x: Float64Array;
  /** Dual multipliers, y ∈ R^m (unconstrained). */
  y: Float64Array;
  /** Dual slacks, s ∈ R^n_+. */
  s: Float64Array;
  /** Primal homogenization scalar, τ > 0. */
  tau: number;
  /** Dual homogenization scalar, κ > 0. */
  kappa: number;
  /** Current residuals + complementarity + ρ-scaled forms + PRSTATUS. */
  residuals: HsdeResiduals;
  /** Iteration counter (0-indexed; incremented per IPM iter). */
  iter: number;
  /** Termination state — `"running"` until a terminal status sticks. */
  status: HsdeStatus;
}

// ─────────────────────────────────────────────────────────────────────
// SDP HSDE iterate
// ─────────────────────────────────────────────────────────────────────

/**
 * The SDP HSDE iterate. Per-block PSD matrices `X_b`, `S_b` stored
 * as full row-major n×n `Float64Array` (matching the existing
 * `NtSdpSolver` layout — packed lower-triangular is a v2 storage
 * optimisation that doesn't matter for correctness). The
 * homogenization scalars `τ, κ` are *global*, not per-block: there
 * is one τ and one κ for the whole SDP problem.
 *
 * Cone: each `X_b ∈ S^{n_b}_+`, each `S_b ∈ S^{n_b}_+`.
 *
 * The dual residual `r_d` is naturally per-block (one symmetric
 * n_b × n_b matrix per cone). The primal residual `r_p` is a
 * single m-vector (the m linear constraints) and the gap residual
 * is a scalar — these stay flat.
 */
export interface HsdeSdpIterate {
  m: number;
  /** Per-block matrix size; `blockSizes[b]` = n_b. */
  blockSizes: number[];
  /** Per-block primal PSD matrix, X_b ∈ S^{n_b}_+. Flat row-major. */
  X: Float64Array[];
  /** Dual multipliers, y ∈ R^m. */
  y: Float64Array;
  /** Per-block dual PSD slack, S_b ∈ S^{n_b}_+. Flat row-major. */
  S: Float64Array[];
  /** Primal homogenization scalar, τ > 0. */
  tau: number;
  /** Dual homogenization scalar, κ > 0. */
  kappa: number;
  /** Current residuals + complementarity + ρ-scaled forms + PRSTATUS. */
  residuals: HsdeResiduals;
  /** Iteration counter. */
  iter: number;
  /** Termination state. */
  status: HsdeStatus;
}
