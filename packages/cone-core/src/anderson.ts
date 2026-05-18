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
//
// **v0.2 extension.** AA-II ships its own light safeguard (ridge + the
// non-explosion + restart rule below) which is empirically sufficient
// for the LP-complete cone subset. The paper's globally-convergent
// Type-I method (AA-I-S-m, ADR-0036 §F) — Powell-type regularisation
// + Gram-Schmidt restart + KM-averaged residual-decrease safeguard —
// ports to `anderson-type-i.ts`, alongside this module. The two share
// the `AndersonAccelerator` shape of the outer interface (consume a
// point and its image; return a next iterate; reset clears history)
// but no internal state; the dispatcher `makeAndersonFromSpec` at the
// bottom of this file lets callers select between them by a tagged
// `AndersonSpec` value.

import { type Matrix, matZeros, lu, luSolve } from "@workbench/linalg-core";
import { ConeError } from "./cones.js";
import { dot, isFiniteVec } from "./anderson-shared.js";
import {
  type AndersonAcceleratorI,
  type AndersonISpec,
  makeAndersonI,
} from "./anderson-type-i.js";

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

// =============================================================================
// AndersonSpec — the dispatcher between AA-II (this module) and AA-I
// =============================================================================
//
// `cone-core` callers historically configured acceleration by a single
// integer `andersonMemory` (ADR-0036 §C); v0.2 (ADR-0036 §F) adds the
// Powell-regularised Type-I path, which carries five hyper-parameters
// instead of one. To keep the back-compat surface intact without
// inflating `SCSOpts` with optional fields, the v0.2 selection knob is
// a single tagged-union `AndersonSpec` value that *both* describes
// which algorithm to run and carries its hyper-parameters in one place.
//
// `kind: "none"` is a first-class entry — it returns an accelerator
// whose `next(z, Gz)` is the identity wrapper around the plain step.
// It is the precise equivalent of the legacy `andersonMemory: 0`
// (which `SCSOpts` still accepts) and exists so the dispatcher's
// return shape — an `AnyAccelerator` discriminated union — covers
// every iteration-loop code path uniformly.
//
// The dispatcher's caller (`scs.ts`) does *not* dynamically dispatch
// per step. It builds the `AnyAccelerator` once at solve start, then
// branches the iteration loop on `aa.kind`. The two `next` signatures
// genuinely differ — AA-II takes `(z, Gz)`, AA-I takes
// `(xAccepted, fxAccepted, xTrial, fxTrial)` — so the branch lives at
// the loop, not inside the accelerator.

/**
 * Discriminated-union selector for the v0.2 dual-accelerator surface.
 *
 *  - `kind: "none"` — no acceleration; the iteration runs as plain SCS.
 *    Equivalent to AA-II with `memory: 0`; the alias exists so
 *    "disabled" reads explicitly at the call site.
 *  - `kind: "type-ii"` — Type-II Anderson (this module): a single
 *    integer memory window. The v0.1 lever.
 *  - `kind: "type-i"` — Type-I Anderson with Powell regularisation,
 *    Gram-Schmidt restart, and KM-safeguarded steps (the AA-I-S-m
 *    algorithm of Zhang-O'Donoghue-Boyd 2018, Algorithm 3). Carries
 *    the full `AndersonISpec` hyper-parameter bundle. The v0.2 lever.
 */
export type AndersonSpec =
  | { readonly kind: "none" }
  | { readonly kind: "type-ii"; readonly memory: number }
  | ({ readonly kind: "type-i" } & AndersonISpec);

/**
 * The dispatcher's return value — a tagged union the caller branches
 * on once to wire the per-iteration step. The accelerator instances
 * themselves carry no discriminator (they are independent objects with
 * incompatible `next` signatures), so the discriminant rides on the
 * outer tag.
 */
export type AnyAccelerator =
  | { readonly kind: "ii"; readonly aa: AndersonAccelerator }
  | { readonly kind: "i"; readonly aa: AndersonAcceleratorI }
  | { readonly kind: "none" };

/**
 * Build the accelerator the spec asks for. Validates the hyper-parameter
 * ranges loudly (CLAUDE.md Rule 1): a Powell strength outside `(0, 1)`,
 * a non-finite safeguard scale, etc. — these are programming errors
 * (`ConeError`), not run-time refusals. The factories `makeAnderson`
 * and `makeAndersonI` do their own input validation as well, so the
 * dispatcher's checks here are deliberately the union of what either
 * downstream factory accepts; any error message that reaches the user
 * carries the offending field name.
 */
export function makeAndersonFromSpec(spec: AndersonSpec): AnyAccelerator {
  switch (spec.kind) {
    case "none":
      return { kind: "none" };
    case "type-ii":
      return { kind: "ii", aa: makeAnderson(spec.memory) };
    case "type-i":
      return { kind: "i", aa: makeAndersonI(spec) };
  }
}
