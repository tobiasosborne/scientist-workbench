// =============================================================================
// anderson.ts — Type-II Anderson acceleration for fixed-point iterations
// =============================================================================
//
// The SCS operator-splitting iteration (`scs.ts`) is a nonexpansive
// fixed-point map `φ` whose plain iteration `z ← φ(z)` converges
// *linearly and slowly* — the "slow tail convergence" O'Donoghue 2016 §1
// warns about. Anderson acceleration wraps the iteration: at each step it
// forms the next iterate as a combination of a *window* of recent images,
// chosen to minimise the fixed-point residual. No derivatives of `φ`, one
// small least-squares solve per step.
//
// This module ports **Type-II Anderson acceleration** (AA-II) — the
// classical method of Walker-Ni 2011, equivalently the AA-II of
// Zhang-O'Donoghue-Boyd 2018 (arXiv:1808.03971) §2. Ground truth:
// `docs/ground-truth/convex/anderson-acceleration.md`; design rationale
// ADR-0036. Ported from the paper, never from the `scs` C library's `aa`
// module (ADR-0030 §E).
//
// The accelerator is *generic over the fixed-point map*: it accelerates
// any `Float64Array` iteration, knowing nothing about SCS. `scs.ts` wires
// it by treating one SCS iteration as the map `φ` on the embedding pair
// `z = [u; v]`. That keeps `anderson.ts` testable in isolation against a
// simple known contraction.
//
// The algorithm (AA-II, Walker-Ni `β = 1` no-damping form). With residual
// `r(z) = φ(z) − z`, memory window `m`, working window `m_k = min(m, k)`:
//
//   γ^k     = argmin_γ ‖ r_k − R_k γ ‖₂ ,  R_k = [Δr_{k−m_k} … Δr_{k−1}]
//   z_{k+1} = φ(z_k) − G_k γ^k ,           G_k = [Δφ_{k−m_k} … Δφ_{k−1}]
//
// where `Δr_i = r_{i+1} − r_i` are residual differences and
// `Δφ_i = φ(z_{i+1}) − φ(z_i)` image differences. The `m_k × m_k` normal
// equations `(R_kᵀ R_k + λI) γ = R_kᵀ r_k` are solved with a small
// Tikhonov ridge `λ` — the simple stand-in for the paper's Powell-type
// regularisation (ADR-0036 §B).
//
// Determinism (ADR-0015, `numerical: true`): a fixed window `m`, a
// fixed-order normal-equations solve, no implicit-zero gates — the
// accelerated trajectory is bit-identical given the same inputs.

import { type Matrix, matZeros, lu, luSolve } from "@workbench/linalg-core";
import { ConeError } from "./cones.js";

/**
 * A stateful Anderson accelerator over a fixed-point iteration. Drive it
 * one step at a time: compute `Gz = φ(z)` yourself, then call
 * `next(z, Gz)` to get the accelerated next iterate (or, if the safeguard
 * trips, `Gz` itself). `reset()` clears the history.
 */
export interface AndersonAccelerator {
  /**
   * Consume the current point `z` and its image `Gz = φ(z)`; return the
   * next iterate. The returned array is always fresh — neither `z` nor
   * `Gz` is mutated or aliased into the result.
   */
  next(z: Float64Array, Gz: Float64Array): Float64Array;
  /** Drop the entire history — the next `next` call restarts at `m_k = 0`. */
  reset(): void;
}

// Relative Tikhonov-ridge factor on the normal equations. The ridge is
// `λ = RIDGE_REL · trace(RᵀR)/m_k` — strictly *proportional* to the
// actual scale of `RᵀR`, with no absolute floor. An absolute floor (e.g.
// `max(1, …)`) would be catastrophic: deep in SCS's slow tail the
// residual differences are tiny, so `trace(RᵀR)/m_k` can be `~1e-12`,
// and a floored `λ ~ 1e-10` would *swamp the signal* and silently
// switch acceleration off exactly where it is needed most. Keeping `λ`
// proportional means it regularises a rank-deficient `Y_k` without ever
// dominating a well-scaled one. If `RᵀR` is the literal zero matrix
// (fully converged) `λ = 0` and the LU solve's null return triggers the
// restart safeguard — no special-casing needed.
const RIDGE_REL = 1e-10;

// Reject an extrapolate whose 2-norm exceeds this multiple of `‖φ(z)‖₂`
// — an Anderson step that has clearly diverged rather than accelerated.
const EXPLOSION_FACTOR = 1e6;

function dot(a: Float64Array, b: Float64Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
}

function isFiniteVec(v: Float64Array): boolean {
  for (let i = 0; i < v.length; i++) {
    if (!Number.isFinite(v[i]!)) return false;
  }
  return true;
}

/**
 * Construct an Anderson accelerator with memory window `memory`. A
 * `memory` of `0` disables acceleration entirely — `next` returns `Gz`
 * unchanged, recovering the exact plain fixed-point trajectory (used for
 * the determinism cross-check and for testing the un-accelerated path).
 *
 * `memory` must be a non-negative integer; a negative or fractional
 * value is a programming error and throws.
 */
export function makeAnderson(memory: number): AndersonAccelerator {
  if (!Number.isInteger(memory) || memory < 0) {
    throw new ConeError(`makeAnderson: memory must be a non-negative integer, got ${memory}`);
  }

  // Disabled accelerator — the identity wrapper around the plain step.
  if (memory === 0) {
    return {
      next: (_z, Gz) => Gz.slice(),
      reset: () => {},
    };
  }

  // Rolling history. `prevR` / `prevG` hold the previous call's residual
  // and image (AA-II needs only residual- and image-differences, not
  // iterate-differences — that is Type-I's `S_k`); `rCols` / `gCols` are
  // the residual-difference and image-difference columns, oldest-first,
  // length ≤ `memory`.
  let prevR: Float64Array | undefined;
  let prevG: Float64Array | undefined;
  const rCols: Float64Array[] = [];
  const gCols: Float64Array[] = [];

  const reset = (): void => {
    prevR = undefined;
    prevG = undefined;
    rCols.length = 0;
    gCols.length = 0;
  };

  const next = (z: Float64Array, Gz: Float64Array): Float64Array => {
    // r = φ(z) − z, the fixed-point residual of the current point.
    const dim = z.length;
    const r = new Float64Array(dim);
    for (let i = 0; i < dim; i++) r[i] = Gz[i]! - z[i]!;

    // First call of a (re)started window: no difference to form yet —
    // take the plain step and seed the history.
    if (prevR === undefined || prevG === undefined) {
      prevR = r;
      prevG = Gz;
      return Gz.slice();
    }

    // Append the new difference columns Δr, Δφ; evict the oldest if the
    // window is full.
    const dR = new Float64Array(dim);
    const dG = new Float64Array(dim);
    for (let i = 0; i < dim; i++) {
      dR[i] = r[i]! - prevR[i]!;
      dG[i] = Gz[i]! - prevG[i]!;
    }
    rCols.push(dR);
    gCols.push(dG);
    if (rCols.length > memory) {
      rCols.shift();
      gCols.shift();
    }

    // Update the rolling `prev` *before* the safeguard can early-return —
    // the history of residuals/images is independent of whether this
    // step's extrapolation is accepted.
    prevR = r;
    prevG = Gz;

    const mk = rCols.length;

    // Normal equations  (RᵀR + λI) γ = Rᵀr  — `mk × mk`, tiny.
    const RtR: Matrix = matZeros(mk, mk);
    let traceRtR = 0;
    for (let a = 0; a < mk; a++) {
      for (let b = a; b < mk; b++) {
        const v = dot(rCols[a]!, rCols[b]!);
        RtR.data[a * mk + b] = v;
        RtR.data[b * mk + a] = v;
      }
      traceRtR += RtR.data[a * mk + a]!;
    }
    const ridge = RIDGE_REL * (traceRtR / mk);
    for (let a = 0; a < mk; a++) RtR.data[a * mk + a]! += ridge;

    const Rtr = new Float64Array(mk);
    for (let a = 0; a < mk; a++) Rtr[a] = dot(rCols[a]!, r);

    const luRtR = lu(RtR);
    if (luRtR === null) {
      // Degenerate window — the ridge should make this unreachable, but
      // if it happens, restart and take the plain step.
      reset();
      return Gz.slice();
    }
    const gamma = luSolve(luRtR, Rtr);

    // z_{k+1} = φ(z_k) − G_k γ
    const zNext = new Float64Array(dim);
    for (let i = 0; i < dim; i++) {
      let acc = Gz[i]!;
      for (let a = 0; a < mk; a++) acc -= gCols[a]![i]! * gamma[a]!;
      zNext[i] = acc;
    }

    // Safeguard (ADR-0036 §B): a non-finite or exploded extrapolate is
    // rejected — take the plain step and restart the window.
    if (!isFiniteVec(zNext)) {
      reset();
      return Gz.slice();
    }
    let zNextNorm = 0;
    let GzNorm = 0;
    for (let i = 0; i < dim; i++) {
      zNextNorm += zNext[i]! * zNext[i]!;
      GzNorm += Gz[i]! * Gz[i]!;
    }
    if (Math.sqrt(zNextNorm) > EXPLOSION_FACTOR * Math.max(1, Math.sqrt(GzNorm))) {
      reset();
      return Gz.slice();
    }

    return zNext;
  };

  return { next, reset };
}
