// Signed primal-dual regularization + factorization retry for the QP
// augmented system. Ground truth: docs/ground-truth/convex/qp-ipm.md §5.
//
// The existing `factorWith3Way` (Regularization.ts) adds a single
// UNIFORM POSITIVE lift to every diagonal — correct for an SPD Schur,
// but WRONG for the quasidefinite saddle, where it would push the
// negative x-block pivots toward zero and destroy quasidefiniteness. The
// QP path needs the SIGNED scheme: subtract `ρ` from the x-block
// diagonals (more negative), add `δ` to the y-block diagonals (more
// positive). This is Friedlander–Orban primal-dual regularization — a
// proximal step toward a nearby well-posed QP, not a numerical
// perturbation to apologise for.
//
// The DIAGNOSIS is structural and exact, which is the clean part: the
// kernel returns the index of the first pivot that lost its required
// sign, and the block boundary `n` names the culprit directly — a
// failure at row `j < n` is an x-block (primal) loss → bump `ρ`; at
// `j ≥ n` a y-block (dual) loss → bump `δ`. No row-norm heuristic
// (`makeLpDiagnose`) is needed.

import type { QpIterate } from "./QpIterate.js";
import { signedLdltInPlace } from "../linalg/SignedLdlt.js";

export interface QpRegParams {
  /** Multiplicative bump on a block losing definiteness. */
  bump: number;
  /** Floor the escalation level starts from on the first bump. */
  floor: number;
  /** Caps mirror the LP path (`Defaults.ts`): tight primal, large dual headroom. */
  rhoMax: number;
  deltaMax: number;
  maxRefactor: number;
  /** Decay applied to the carried escalation when an iteration factors
   *  cleanly on the first attempt — keeps the regularization from
   *  ratcheting up permanently and capping late-iteration accuracy. */
  decay: number;
}

export const DEFAULT_QP_REG: QpRegParams = {
  bump: 10,
  floor: 1e-12,
  rhoMax: 1e-2,
  deltaMax: 1e2,
  maxRefactor: 20,
  decay: 0.1,
};

export interface QpFactorResult {
  success: boolean;
  /** Failing pivot row of the last failed attempt, or -1 if the first attempt factored. */
  lastFailRow: number;
}

// Copy `it.K0` into `it.Kfac`, apply the current signed escalation
// (`−ρ_e` on the x-diagonals, `+δ_e` on the y-diagonals), and factor
// with `signedLdltInPlace`. On a sign-loss failure, bump the offending
// block's regularizer and retry, up to `maxRefactor`. On clean
// first-attempt success, gently decay the carried escalation.
export function signedFactorWithRetry(
  it: QpIterate,
  params: QpRegParams = DEFAULT_QP_REG,
): QpFactorResult {
  const { n, N } = it;
  let lastFailRow = -1;
  let attempts = 0;

  for (;;) {
    // Working copy + signed escalation lift.
    it.Kfac.set(it.K0);
    if (it.rhoE > 0) {
      for (let j = 0; j < n; j++) it.Kfac[j * N + j] = it.Kfac[j * N + j]! - it.rhoE;
    }
    if (it.deltaE > 0) {
      for (let j = n; j < N; j++) it.Kfac[j * N + j] = it.Kfac[j * N + j]! + it.deltaE;
    }

    const failRow = signedLdltInPlace(it.Kfac, N, n, it.ldltTmp);
    if (failRow < 0) {
      // Clean factorization. Decay the carried escalation if the first
      // attempt succeeded (no bump needed this iteration).
      if (attempts === 0) {
        it.rhoE *= params.decay;
        it.deltaE *= params.decay;
        if (it.rhoE < params.floor) it.rhoE = 0;
        if (it.deltaE < params.floor) it.deltaE = 0;
      }
      return { success: true, lastFailRow };
    }

    lastFailRow = failRow;
    attempts++;
    if (attempts > params.maxRefactor) {
      return { success: false, lastFailRow };
    }

    // Structural diagnosis: which block lost definiteness?
    if (failRow < n) {
      // x-block (primal) — bump ρ.
      it.rhoE = Math.max(it.rhoE, params.floor) * params.bump;
      it.bumpsRho++;
      if (it.rhoE > params.rhoMax) it.rhoE = params.rhoMax;
    } else {
      // y-block (dual) — bump δ.
      it.deltaE = Math.max(it.deltaE, params.floor) * params.bump;
      it.bumpsDelta++;
      if (it.deltaE > params.deltaMax) it.deltaE = params.deltaMax;
    }
    it.refactors++;
  }
}
