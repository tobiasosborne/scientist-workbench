// =============================================================================
// yoshida.ts — Suzuki-Yoshida 4th-order symplectic composition
// =============================================================================
//
// Intent
// ------
// The Suzuki-Yoshida composition lifts a second-order time-symmetric
// symplectic method (Velocity Verlet) to a fourth-order one by stepping
// three times per coarse step with carefully-chosen sub-step weights:
//
//     S₄(h) = S₂(w₁·h) ∘ S₂(w₂·h) ∘ S₂(w₃·h)
//
// where `S₂` is one Velocity Verlet step and the weights satisfy
//
//     w₁ + w₂ + w₃ = 1   (consistency)
//     w₁³ + w₂³ + w₃³ = 0  (4th-order condition)
//
// with `w₁ = w₃ = w` for time-reversal symmetry. Solving yields the
// canonical Yoshida 1990 constants (also reproduced in HLW §VI.3
// equation 3.6):
//
//     w  = 1 / (2 − 2^(1/3)) ≈ 1.3512071919596578
//     w₁ = w₃ = w
//     w₂ = 1 − 2w ≈ −1.7024143839193153
//
// Note `w₂` is *negative* — the middle Verlet step runs *backward* in
// time. That is not a numerical accident; it is the price of pushing
// from order 2 to order 4 through a symmetric composition. The geometry
// is still preserved (each sub-step is itself symplectic; composition
// of symplectic maps is symplectic), only the local time-monotonicity
// is broken.
//
// Cost per Yoshida-4 coarse step: three Verlet sub-steps × (2 force
// + 1 velocity evals) = 6 force + 3 velocity evaluations. Verlet alone
// is 2 force + 1 velocity per step. So Yoshida-4 is 3× more expensive
// per coarse step but ~h² = 100× more accurate at typical step sizes —
// a net 30× efficiency win for sub-1e-8 conservation budgets.
//
// References
// ----------
//   - Yoshida, H. (1990). "Construction of higher order symplectic
//     integrators." Physics Letters A 150(5-7), 262-268.
//   - Suzuki, M. (1991). "General theory of fractal path integrals
//     with applications to many-body theories and statistical
//     physics." J. Math. Phys. 32, 400-407.
//   - Hairer, Lubich, Wanner. *Geometric Numerical Integration*, 2nd
//     ed. §VI.3 — composition methods, table of coefficients.

import { verletStep } from "./verlet.js";

/** Suzuki-Yoshida `w` constant. The 4th-order weights are `[w, 1-2w, w]`. */
export const YOSHIDA_W: number = 1.0 / (2.0 - Math.cbrt(2.0));

/** The 4th-order Suzuki-Yoshida sub-step weights. */
export const YOSHIDA_WEIGHTS: readonly [number, number, number] = [
  YOSHIDA_W,
  1.0 - 2.0 * YOSHIDA_W,
  YOSHIDA_W,
];

/**
 * One Yoshida 4th-order step. Three Velocity Verlet sub-steps with
 * weights `[w, 1−2w, w]`. All buffers are caller-owned and reused
 * across sub-steps; one extra `Float64Array` buffer (`qSwap` / `pSwap`)
 * per coordinate is required to ping-pong the state across sub-steps.
 *
 * The arguments mirror `verletStep`:
 *   - `q`, `p`         — input state (read-only). Length `n`.
 *   - `qNew`, `pNew`   — output state, written in place. Length `n`.
 *   - `qSwap`, `pSwap` — scratch state buffers for sub-step ping-pong.
 *                         Length `n`.
 *   - `pHalf`, `forceBuf`, `velBuf` — Verlet's per-step scratch.
 *                         Length `n`.
 *   - `force`, `velocity` — gradient callables; same contract as for
 *                            Verlet.
 *
 * The composition reads:
 *
 *     (q, p) → S₂(w₁·h) → (qSwap, pSwap)
 *            → S₂(w₂·h) → (qNew,  pNew)
 *            → S₂(w₃·h) → (qSwap, pSwap)
 *
 * with one final copy `(qSwap, pSwap) → (qNew, pNew)`. We choose the
 * ping-pong order so the *final* sub-step lands in `qSwap` / `pSwap`
 * and we copy out — keeping the arithmetic regular.
 */
export function yoshida4Step(
  q: Float64Array,
  p: Float64Array,
  h: number,
  qNew: Float64Array,
  pNew: Float64Array,
  qSwap: Float64Array,
  pSwap: Float64Array,
  pHalf: Float64Array,
  forceBuf: Float64Array,
  velBuf: Float64Array,
  force: (q: Float64Array, out: Float64Array) => void,
  velocity: (p: Float64Array, out: Float64Array) => void,
): void {
  const [w1, w2, w3] = YOSHIDA_WEIGHTS;
  const n = q.length;

  // Sub-step 1: (q, p) → (qSwap, pSwap) over h₁ = w₁·h.
  verletStep(q, p, w1 * h, qSwap, pSwap, pHalf, forceBuf, velBuf, force, velocity);

  // Sub-step 2: (qSwap, pSwap) → (qNew, pNew) over h₂ = w₂·h (negative).
  verletStep(qSwap, pSwap, w2 * h, qNew, pNew, pHalf, forceBuf, velBuf, force, velocity);

  // Sub-step 3: (qNew, pNew) → (qSwap, pSwap) over h₃ = w₃·h.
  verletStep(qNew, pNew, w3 * h, qSwap, pSwap, pHalf, forceBuf, velBuf, force, velocity);

  // Final copy from the swap buffer to the caller's output.
  for (let i = 0; i < n; i++) {
    qNew[i] = qSwap[i]!;
    pNew[i] = pSwap[i]!;
  }
}
