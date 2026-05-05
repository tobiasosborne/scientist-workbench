// =============================================================================
// verlet.ts — single Velocity Verlet step for separable Hamiltonian flow
// =============================================================================
//
// Intent
// ------
// Velocity Verlet (Verlet 1967; Hairer-Lubich-Wanner *Geometric Numerical
// Integration* §I.3.1) is the second-order symplectic integrator for
// separable Hamiltonian systems
//
//     H(q, p) = T(p) + V(q),   dq/dt = ∂H/∂p,   dp/dt = −∂H/∂q.
//
// One step from `(q_n, p_n)` to `(q_{n+1}, p_{n+1})` over step `h`:
//
//     p_{n+½} = p_n + (h/2) · F(q_n)         // half kick (F = −∂V/∂q)
//     q_{n+1} = q_n + h · v(p_{n+½})         // drift (v = ∂T/∂p)
//     p_{n+1} = p_{n+½} + (h/2) · F(q_{n+1}) // half kick
//
// For separable H the inner `v(p)` depends only on `p` (no `q`); the
// inner `F(q)` depends only on `q` (no `p`). That is exactly what makes
// Velocity Verlet symplectic and explicit: each sub-step solves a
// trivially-integrable 1D-in-each-coordinate flow. Non-separable H
// breaks the decoupling — the implicit symplectic methods (Gauss-
// Legendre, Radau-IIA on the augmented system) are required there, and
// are a substantially larger build deferred to v0.2.
//
// Why allocation-free
// -------------------
// The driver in `hamiltonian-flow.ts` calls `verletStep` `n_steps` times
// per integration; for the bench's tier-C `Kepler 100 periods` case
// `n_steps = 4000`. A fresh `Float64Array` per step would dominate the
// per-step cost. Like `dopri5Step`, this routine takes caller-owned
// scratch buffers (`pHalf`, `force`, `velocity`) and writes into them.
// The caller's `qNew` / `pNew` are also caller-owned — written in place,
// never allocated.
//
// FYI: structure-preservation has nothing to do with the per-step
// arithmetic and everything to do with the *shape* of the update. The
// kicker-drift-kicker pattern preserves the symplectic 2-form `dp ∧ dq`
// exactly (modulo float64 round-off; HLW §VI.6 backward error analysis).
// What that buys you in practice is bounded energy drift `O(h^p)` over
// arbitrarily long integration horizons — the discriminator the bench
// uses to grade the result.
//
// References
// ----------
//   - Verlet, L. (1967). "Computer experiments on classical fluids. I.
//     Thermodynamical properties of Lennard-Jones molecules." Phys. Rev.
//     159(1), 98-103.
//   - Hairer, Lubich, Wanner. *Geometric Numerical Integration*, 2nd ed.
//     Springer 2006. §I.3.1 (Velocity Verlet); §VI.6 (backward error
//     analysis: why energy drift is bounded `O(h^p)` for symplectic
//     methods regardless of horizon).

/**
 * One Velocity Verlet step on caller-owned `Float64Array` buffers.
 *
 * Layout:
 *   - `q`, `p`   — current state. Read-only on entry. Length `n`.
 *   - `qNew`, `pNew` — output state. Written in place. Length `n`.
 *   - `pHalf`    — scratch buffer for the half-kick momentum. Length `n`.
 *   - `forceBuf` — scratch buffer for `−∂V/∂q` evaluated at the current
 *                  `q`. Length `n`.
 *   - `velBuf`   — scratch buffer for `∂T/∂p` evaluated at `pHalf`.
 *                  Length `n`.
 *   - `force(q, out)`    — fills `out[i] = −∂H/∂q_i(q, p)` evaluated at
 *                          the `q` argument. For separable H the result
 *                          is independent of `p`; the driver holds that
 *                          invariant by construction of the cached
 *                          symbolic gradients.
 *   - `velocity(p, out)` — fills `out[i] = ∂H/∂p_i(q, p)` at the given
 *                          `p`. For separable H the result is independent
 *                          of `q`.
 *
 * The routine performs three sub-steps:
 *
 *   1. Compute `force` at `q`; set `pHalf = p + (h/2)·force`.
 *   2. Compute `velocity` at `pHalf`; set `qNew = q + h·velocity`.
 *   3. Compute `force` at `qNew`; set `pNew = pHalf + (h/2)·force`.
 *
 * Total: two `force` evaluations and one `velocity` evaluation per step.
 * The first `force(q)` of the *next* step coincides with the second
 * `force(qNew)` of the current step — but Velocity Verlet does not
 * exploit the FSAL pattern (the first half-kick of the next step
 * produces a *new* `pHalf`, and the gradient is `q`-only, so the cache
 * could be carried; we leave the optimisation for v0.2 since the per-
 * step floor is set by the symbolic-gradient eval cost, not the function
 * dispatch).
 */
export function verletStep(
  q: Float64Array,
  p: Float64Array,
  h: number,
  qNew: Float64Array,
  pNew: Float64Array,
  pHalf: Float64Array,
  forceBuf: Float64Array,
  velBuf: Float64Array,
  force: (q: Float64Array, out: Float64Array) => void,
  velocity: (p: Float64Array, out: Float64Array) => void,
): void {
  const n = q.length;
  const halfH = 0.5 * h;

  // 1. Half kick: p_{n+½} = p_n + (h/2) · F(q_n).
  force(q, forceBuf);
  for (let i = 0; i < n; i++) {
    pHalf[i] = p[i]! + halfH * forceBuf[i]!;
  }

  // 2. Drift: q_{n+1} = q_n + h · v(p_{n+½}).
  velocity(pHalf, velBuf);
  for (let i = 0; i < n; i++) {
    qNew[i] = q[i]! + h * velBuf[i]!;
  }

  // 3. Half kick: p_{n+1} = p_{n+½} + (h/2) · F(q_{n+1}).
  force(qNew, forceBuf);
  for (let i = 0; i < n; i++) {
    pNew[i] = pHalf[i]! + halfH * forceBuf[i]!;
  }
}
