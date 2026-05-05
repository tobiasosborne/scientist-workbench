// =============================================================================
// hamiltonian-flow.ts — top-level driver for symplectic flow integration
// =============================================================================
//
// Intent
// ------
// Given a separable Hamiltonian `H(q, p) = T(p) + V(q)`, integrate the
// flow `dq/dt = ∂H/∂p, dp/dt = −∂H/∂q` from `(q₀, p₀)` at `t₀` to time
// `t_f` over `n_steps` fixed time steps using either:
//
//   * **Velocity Verlet** (2nd-order, default; one Verlet step per
//     coarse step).
//   * **Yoshida-4** (4th-order Suzuki-Yoshida composition; three Verlet
//     steps per coarse step).
//
// Records the trajectory `(q_i, p_i)` at every grid point, the energy
// `H(q_i, p_i)` at every grid point, the maximum normalised drift
// `max_i |H_i − H_0| / max(|H_0|, atol)`, and the secular-drift flag
// (linear-fit-vs-time discriminator).
//
// Architectural decision: the gradients enter as pre-compiled callables
// ----------------------------------------------------------------------
// `packages/ode-core/` deliberately does *not* depend on `@workbench/
// compose` or `@workbench/cas-core`. Doing so would force a circular
// load (`tools/integrate-ode-symplectic` → `ode-core` → `compose` →
// `tools/cas-diff`) that breaks the workspace layering. The pattern
// instead — same as `eval-rhs.ts` for the IVP driver — is that the
// *tool layer* takes responsibility for parsing `H` and computing
// `∂H/∂q_i`, `∂H/∂p_i` symbolically. The tool layer then hands the
// driver three callable bundles:
//
//   * `force(q, out)`    — fills `out[i] = −∂H/∂q_i`. For separable H
//                          the result is independent of `p`. The tool
//                          layer enforces separability by checking the
//                          symbolic gradients before constructing the
//                          callables.
//   * `velocity(p, out)` — fills `out[i] = ∂H/∂p_i`. Independent of `q`.
//   * `energy(q, p)`     — returns `H(q, p)`.
//
// This keeps the driver allocation-free in the inner loop and lets the
// tool layer choose its own gradient-derivation route (cas-diff in-
// process via `wb.run("cas-diff", ...)`, or hand-coded gradients for
// internal callers, or a finite-difference fallback for testing).
//
// Boundary signals
// ----------------
//   * `HamiltonianDegenerateError` — `t0 == tf` or `n_steps == 0`. The
//     tool layer translates to `tagged "<name>/degenerate-tspan"`.
//   * `HamiltonianNonFiniteError` — at any step, the resulting `q`,
//     `p`, or `H(q, p)` is non-finite. Carries the *previous* finite
//     state (last accepted point) plus the offending time, mirroring
//     `OdeNonFiniteError` from the IVP driver. Tool layer translates
//     to `tagged "<name>/non-finite-during-eval"`.
//
// Non-separability check
// ----------------------
// We do NOT perform symbolic separability checking inside this driver.
// The check is the *tool layer*'s job (it already has the cas-diff
// outputs and the closed expression vocabulary). If a non-separable H
// reaches the driver, Velocity Verlet's `force(q, out)` and
// `velocity(p, out)` callables would still execute — but the result
// would silently lose its symplecticity guarantee, which is the worst
// kind of "looks fine but isn't" failure mode (Rule 7). The discipline
// is: the tool layer rejects non-separable H *before* constructing the
// driver callables.
//
// Energy-drift secular discriminator
// ----------------------------------
// A correct symplectic integrator on a separable H has *bounded*
// energy drift `O(h^p)` for arbitrarily long horizons (HLW §VI.6
// backward error analysis, Theorem 6.1). A non-symplectic integrator's
// drift grows linearly with `t`. The discriminator: fit the drift
// time-series `drift(t) = |H(t) − H(0)| / max(|H(0)|, atol)` to a
// linear model `A·t + B` and check whether `|A| · (t_f − t_0)` is
// large compared to the bounded oscillation magnitude `B`.
//
// Operational rule (cf. the bench's `verify.py`):
//
//     secular := |A| · (t_f − t_0) > 5 · max(drift_max, atol)
//
// The 5× factor is calibrated for canonical separable problems: a
// symplectic integrator has `drift_max ≈ 2·B` (the oscillation peak)
// with `|A|·tspan ≪ B`, so the ratio `|A|·tspan / drift_max ≈ 0`. A
// non-symplectic integrator on the same problem typically has
// `|A|·tspan / drift_max ≈ 1` (the linear part dominates the
// oscillation by tspan-end), so the threshold cleanly separates them.

import { verletStep } from "./verlet.js";
import { yoshida4Step } from "./yoshida.js";

/** Boundary signal: `t0 == tf` or `n_steps == 0`. The driver throws this so
 *  the tool layer can return `tagged "<name>/degenerate-tspan"`. */
export class HamiltonianDegenerateError extends Error {
  readonly t0: number;
  readonly tf: number;
  readonly nSteps: number;
  constructor(t0: number, tf: number, nSteps: number) {
    super(`HamiltonianDegenerateError: t0=${t0}, tf=${tf}, n_steps=${nSteps}`);
    this.name = "HamiltonianDegenerateError";
    this.t0 = t0;
    this.tf = tf;
    this.nSteps = nSteps;
  }
}

/** Boundary signal: a step or H-evaluation produced a non-finite value. */
export class HamiltonianNonFiniteError extends Error {
  readonly atT: number;
  readonly atQ: Float64Array;
  readonly atP: Float64Array;
  readonly kind: "NaN" | "Infinity" | "-Infinity" | "non-finite-H";
  constructor(
    atT: number,
    atQ: Float64Array,
    atP: Float64Array,
    kind: "NaN" | "Infinity" | "-Infinity" | "non-finite-H",
  ) {
    super(
      `HamiltonianNonFiniteError: ${kind} at t = ${atT}, q = [${Array.from(atQ).join(", ")}], p = [${Array.from(atP).join(", ")}]`,
    );
    this.name = "HamiltonianNonFiniteError";
    this.atT = atT;
    this.atQ = atQ;
    this.atP = atP;
    this.kind = kind;
  }
}

export type HamiltonianScheme = "velocity-verlet" | "yoshida-4";

export interface HamiltonianFlowOptions {
  /** Which symplectic scheme to use. Default `"velocity-verlet"`. */
  readonly scheme?: HamiltonianScheme;
  /** Absolute tolerance for normalising the energy drift denominator
   *  (`max(|H_0|, atol)`). Default `1e-9`, mirroring the bench's
   *  `golden/verify.py`. */
  readonly atol?: number;
}

export interface HamiltonianFlowCallables {
  /** Fill `out[i] = −∂H/∂q_i(q)`. For separable H, independent of `p`. */
  readonly force: (q: Float64Array, out: Float64Array) => void;
  /** Fill `out[i] = ∂H/∂p_i(p)`. For separable H, independent of `q`. */
  readonly velocity: (p: Float64Array, out: Float64Array) => void;
  /** Compute `H(q, p)` for energy tracking. */
  readonly energy: (q: Float64Array, p: Float64Array) => number;
}

export interface HamiltonianFlowResult {
  /** `(n_steps + 1) × len(q0)` trajectory of `q` values, row-major as an
   *  array of `Float64Array` rows. */
  readonly qTrajectory: readonly Float64Array[];
  /** `(n_steps + 1) × len(p0)` trajectory of `p` values. */
  readonly pTrajectory: readonly Float64Array[];
  /** `(n_steps + 1)` time-grid points. Uniformly spaced
   *  `t_i = t0 + i · h` with `h = (tf − t0) / n_steps`. */
  readonly tValues: Float64Array;
  /** `(n_steps + 1)` energy values `H(q_i, p_i)`. */
  readonly energy: Float64Array;
  /** `max_i |H(q_i, p_i) − H(q_0, p_0)| / max(|H_0|, atol)`. */
  readonly energyDriftMax: number;
  /** Linear-fit secular-drift discriminator: `true` iff the drift
   *  time-series shows clear linear growth. A correct symplectic
   *  integrator on a separable H must have this `false`. */
  readonly energyDriftSecular: boolean;
  /** Total gradient evaluations: `(2 force + 1 velocity) · n_steps`
   *  for Verlet, `3×` that for Yoshida-4. */
  readonly nEvals: number;
  readonly nSteps: number;
  /** Method tag for output. */
  readonly method: HamiltonianScheme;
}

/**
 * Integrate a separable Hamiltonian flow from `(q0, p0)` at `t0` to
 * time `tf` over `nSteps` uniformly-spaced steps.
 *
 * Records the full trajectory and energy time-series. The caller's
 * `force` / `velocity` / `energy` callables are responsible for
 * carrying the symbolic-derivative + closed-vocabulary semantics; the
 * driver is purely numeric.
 *
 * Throws `HamiltonianDegenerateError` on `t0 == tf` or `nSteps == 0`,
 * and `HamiltonianNonFiniteError` on any non-finite state during the
 * integration.
 */
export function integrateHamiltonianFlow(
  q0: Float64Array,
  p0: Float64Array,
  t0: number,
  tf: number,
  nSteps: number,
  callables: HamiltonianFlowCallables,
  options: HamiltonianFlowOptions = {},
): HamiltonianFlowResult {
  const scheme: HamiltonianScheme = options.scheme ?? "velocity-verlet";
  const atol = options.atol ?? 1e-9;

  if (t0 === tf || nSteps === 0) {
    throw new HamiltonianDegenerateError(t0, tf, nSteps);
  }

  const nQ = q0.length;
  const nP = p0.length;
  const h = (tf - t0) / nSteps;

  // Per-step working storage. Allocate once, reuse forever.
  const q = new Float64Array(q0);
  const p = new Float64Array(p0);
  const qNew = new Float64Array(nQ);
  const pNew = new Float64Array(nP);
  const qSwap = new Float64Array(nQ);
  const pSwap = new Float64Array(nP);
  const pHalf = new Float64Array(nP);
  const forceBuf = new Float64Array(nQ);
  const velBuf = new Float64Array(nP);

  // Trajectory storage. (n_steps + 1) rows; we own the rows.
  const m = nSteps + 1;
  const qTrajectory: Float64Array[] = new Array(m);
  const pTrajectory: Float64Array[] = new Array(m);
  const tValues = new Float64Array(m);
  const energy = new Float64Array(m);

  qTrajectory[0] = new Float64Array(q);
  pTrajectory[0] = new Float64Array(p);
  tValues[0] = t0;
  const H0 = callables.energy(q, p);
  if (!Number.isFinite(H0)) {
    throw new HamiltonianNonFiniteError(t0, q, p, "non-finite-H");
  }
  energy[0] = H0;

  // Per-step eval count: Verlet does 2 force + 1 velocity per step;
  // Yoshida-4 does three Verlet sub-steps. Track total component
  // evaluations the way the bench expects (`n_evals` is reported as a
  // count of gradient-callable invocations, not individual scalar ops).
  const evalsPerStep = scheme === "yoshida-4" ? 9 : 3;

  for (let i = 0; i < nSteps; i++) {
    if (scheme === "yoshida-4") {
      yoshida4Step(
        q, p, h, qNew, pNew,
        qSwap, pSwap, pHalf, forceBuf, velBuf,
        callables.force, callables.velocity,
      );
    } else {
      verletStep(
        q, p, h, qNew, pNew,
        pHalf, forceBuf, velBuf,
        callables.force, callables.velocity,
      );
    }

    // Non-finite detection: any new q or p NaN/±Inf, or H non-finite.
    // Mirrors `OdeNonFiniteError` semantics. The "previous-state" we
    // attach is `(q, p)` — the last finite point — plus the offending
    // target time `t = t0 + (i + 1) · h`.
    const tNew = t0 + (i + 1) * h;
    for (let j = 0; j < nQ; j++) {
      const v = qNew[j]!;
      if (!Number.isFinite(v)) {
        const kind: "NaN" | "Infinity" | "-Infinity" =
          Number.isNaN(v) ? "NaN" : v > 0 ? "Infinity" : "-Infinity";
        throw new HamiltonianNonFiniteError(
          tNew, new Float64Array(qNew), new Float64Array(pNew), kind,
        );
      }
    }
    for (let j = 0; j < nP; j++) {
      const v = pNew[j]!;
      if (!Number.isFinite(v)) {
        const kind: "NaN" | "Infinity" | "-Infinity" =
          Number.isNaN(v) ? "NaN" : v > 0 ? "Infinity" : "-Infinity";
        throw new HamiltonianNonFiniteError(
          tNew, new Float64Array(qNew), new Float64Array(pNew), kind,
        );
      }
    }
    const Hi = callables.energy(qNew, pNew);
    if (!Number.isFinite(Hi)) {
      throw new HamiltonianNonFiniteError(
        tNew, new Float64Array(qNew), new Float64Array(pNew), "non-finite-H",
      );
    }

    // Commit. Copy state forward; record trajectory + energy.
    for (let j = 0; j < nQ; j++) q[j] = qNew[j]!;
    for (let j = 0; j < nP; j++) p[j] = pNew[j]!;
    qTrajectory[i + 1] = new Float64Array(q);
    pTrajectory[i + 1] = new Float64Array(p);
    tValues[i + 1] = tNew;
    energy[i + 1] = Hi;
  }

  // Energy-drift diagnostics. The denominator is `max(|H₀|, atol)` —
  // matches the bench verifier's normalisation.
  const denom = Math.max(Math.abs(H0), atol);
  let driftMax = 0;
  for (let i = 0; i < m; i++) {
    const d = Math.abs(energy[i]! - H0) / denom;
    if (d > driftMax) driftMax = d;
  }

  // Secular-drift discriminator: linear fit `drift(t) ≈ A·(t − t0) + B`
  // and threshold `|A| · (tf − t0)` against `5 · max(driftMax, atol)`.
  // The fit is closed-form least squares on a uniform grid.
  let secular = false;
  if (m >= 4) {
    let sumT = 0, sumD = 0, sumTT = 0, sumTD = 0;
    for (let i = 0; i < m; i++) {
      const ti = tValues[i]! - t0;
      const di = Math.abs(energy[i]! - H0) / denom;
      sumT += ti;
      sumD += di;
      sumTT += ti * ti;
      sumTD += ti * di;
    }
    const meanT = sumT / m;
    const meanD = sumD / m;
    const ssTT = sumTT - m * meanT * meanT;
    if (ssTT > 0) {
      const slope = (sumTD - m * meanT * meanD) / ssTT;
      const totalSpan = tf - t0;
      secular = Math.abs(slope) * Math.abs(totalSpan) > 5 * Math.max(driftMax, atol);
    }
  }

  return {
    qTrajectory,
    pTrajectory,
    tValues,
    energy,
    energyDriftMax: driftMax,
    energyDriftSecular: secular,
    nEvals: evalsPerStep * nSteps,
    nSteps,
    method: scheme,
  };
}
