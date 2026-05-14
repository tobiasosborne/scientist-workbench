// =============================================================================
// IterativeRefinement.ts — fixed-precision iterative refinement on the
// regularised Cholesky back-substitution
// =============================================================================
//
// Why this exists
// ---------------
// Every iteration of the HSDE LP and NT-SDP solvers assembles the Schur
// complement `M`, factors `Lchol = chol(M + reg·I)` via `factorWith3Way`, and
// back-substitutes three right-hand sides through `Lchol`. The 3-way Tikhonov
// regulariser is what keeps the factorisation alive on the rank-deficient,
// badly-scaled Schurs that real SDPLIB / NETLIB instances throw at it — but it
// is also a *lie*. `choleskySolveInPlace(Lchol, rhs)` returns `dy` such that
// `(M + reg·I)·dy ≈ rhs`, whereas the algorithm wants `M·dy ≈ rhs` against the
// *unperturbed* `M`. On `hinf2` the Schur condition number reaches ~1e+13
// (verbose trace `Mdiag=[4.8e+7, 1.0e+13]`), and the back-substitution stalls
// the whole solver at `pInf ≈ 1.26e-7` from iter ~36 onward — the precision
// floor this tier exists to break.
//
// Iterative refinement (Higham, "Accuracy and Stability of Numerical
// Algorithms", 2nd ed., Ch. 12; the SDPT3 v4 Schur solve; ECOS `kkt.c`) is the
// classical fix. The factored `Lchol` is reused as a cheap *approximate*
// solver for the *exact* system `M·dy = rhs`:
//
//     dy ← Lchol \ rhs                    (initial, regularised, approximate)
//     repeat:
//       e   ← rhs − M·dy                  (residual against UNPERTURBED M)
//       if ‖e‖∞ small enough: stop
//       corr ← Lchol \ e                  (correction, same factor)
//       dy  ← dy + corr                   (only if it actually helps)
//
// Even though the residual `e` is computed in plain float64 (no extended
// precision), refinement still buys back decades of accuracy whenever the
// contraction condition holds — Higham §12.1. It is not guaranteed to help on
// every system, which is why each step is a *trial*: the correction is applied
// only if it reduces the residual, and the loop bails on stagnation. That
// honesty — "IR can occasionally fail to help" — is SDPT3 §2.5's explicit
// caveat and is built into the control flow here.
//
// Determinism
// -----------
// Pure float64 arithmetic over `Float64Array`, no allocation, no platform
// branch — bit-identical given the platform fingerprint, exactly like the rest
// of the `numerical: true` solver (ADR-0015). Tier-0's `nitref1/2/3` trace
// fields exist precisely so the diagnostic pipeline can see where this loop
// fires; this function returns the count it writes there.

import { choleskySolveInPlace } from "./Cholesky.js";
import { vecNormInf } from "../solver/Residuals.js";

/**
 * Solve `M·dy = rhs` accurately by Cholesky back-substitution plus
 * fixed-precision iterative refinement, and return the number of refinement
 * steps that were actually *accepted*.
 *
 * Arguments:
 *  - `M`       — the `m × m` row-major symmetric Schur complement, **un**-
 *                regularised. The residual is computed against this matrix,
 *                never against `M + reg·I` (that is the whole point — see
 *                HANDOFF §5.1). `factorWith3Way` copies `M` into `Lchol`
 *                before factoring, so the caller's `M` is intact here.
 *  - `m`       — dimension.
 *  - `Lchol`   — the lower-triangular Cholesky factor of `M + reg·I`, as
 *                produced by `factorWith3Way`. Unchanged across refinement
 *                steps — the same approximate solver is reused.
 *  - `rhs`     — the `m`-vector right-hand side. Read-only here.
 *  - `dy`      — output; the caller owns it. On return holds the refined
 *                solution.
 *  - `workE`   — caller-allocated `m`-vector scratch (the residual).
 *  - `workCorr`— caller-allocated `m`-vector scratch (the correction).
 *  - `maxIter` — refinement-step cap (ECOS uses 9; HANDOFF §4.2 default).
 *  - `tolRel`  — relative residual tolerance; refinement stops once
 *                `‖e‖∞ < tolRel·(1 + ‖rhs‖∞)`. ECOS `LINSYSACC`, default
 *                `1e-14`.
 *  - `stagnationFactor` — once a step improves the residual by less than this
 *                factor, further steps are deemed unproductive and the loop
 *                stops. ECOS `IRERRFACT`, default `6`.
 *
 * Both scratch vectors are caller-allocated so a solve does not allocate
 * per-iteration; the two-buffer discipline below is deliberate and is what
 * makes the trial-and-rollback correct (see the inline note at the rollback).
 */
export function solveWithIR(
  M: Float64Array,
  m: number,
  Lchol: Float64Array,
  rhs: Float64Array,
  dy: Float64Array,
  workE: Float64Array,
  workCorr: Float64Array,
  maxIter = 9,
  tolRel = 1e-14,
  stagnationFactor = 6,
): number {
  // Initial back-substitution: dy ≈ (M + reg·I)⁻¹ rhs.
  dy.set(rhs);
  choleskySolveInPlace(Lchol, m, dy);

  const rhsNorm = vecNormInf(rhs);
  const convTol = tolRel * (1 + rhsNorm);

  // workE holds the residual of the *currently accepted* dy.
  residual(M, m, rhs, dy, workE);

  let prevErrNorm = Infinity;
  let nitref = 0;

  for (let k = 0; k < maxIter; k++) {
    const errNorm = vecNormInf(workE);

    // (1) Converged: the regularised solve is already accurate enough.
    if (errNorm < convTol) break;

    // (2) Stagnated: the previous accepted step bought less than a
    //     `stagnationFactor`× reduction, so further steps are unlikely to
    //     pay. `prevErrNorm` is the accepted residual norm one step ago;
    //     on k = 0 it is +∞ so this never triggers on the first step.
    if (prevErrNorm / errNorm < stagnationFactor) break;

    // (3) Trial step. Solve for the correction with the same factor, then
    //     apply it *in place* on dy. `workCorr` still holds the correction
    //     after this — that is what makes the rollback below exact.
    workCorr.set(workE);
    choleskySolveInPlace(Lchol, m, workCorr);
    for (let i = 0; i < m; i++) dy[i] = dy[i]! + workCorr[i]!;

    // Residual of the trial dy. We overwrite `workE` here — safe, because
    // `errNorm` (the accepted residual norm) is already captured as a
    // scalar, and `workCorr` (not `workE`) is what the rollback needs.
    // The HANDOFF §4.2 sketch's bug was overwriting the *correction*
    // buffer with the trial residual, leaving nothing to undo with.
    residual(M, m, rhs, dy, workE);
    const trialErrNorm = vecNormInf(workE);

    if (trialErrNorm > errNorm) {
      // The correction made the residual worse — fixed-precision IR is not
      // monotone in general (Higham §12.1; SDPT3 §2.5). Roll dy back to the
      // last accepted iterate and stop. `workCorr` is untouched since the
      // update, so the undo is exact.
      for (let i = 0; i < m; i++) dy[i] = dy[i]! - workCorr[i]!;
      break;
    }

    // Accepted: dy and workE already hold the refined iterate and its
    // residual; carry errNorm forward for the next stagnation test.
    prevErrNorm = errNorm;
    nitref++;
  }

  return nitref;
}

/**
 * Write `out = rhs − M·dy` for symmetric row-major `M` (`m × m`). Plain
 * float64 GEMV — `O(m²)` per call, the dominant cost of refinement; tolerable
 * for the `m ≤ ~100` Schur sizes the solver sees on SDPLIB / NETLIB, revisit
 * with a blocked GEMV if `m` grows past a few hundred (HANDOFF §5.2, §5.6).
 */
function residual(
  M: Float64Array,
  m: number,
  rhs: Float64Array,
  dy: Float64Array,
  out: Float64Array,
): void {
  for (let i = 0; i < m; i++) {
    let s = 0;
    const row = i * m;
    for (let j = 0; j < m; j++) s += M[row + j]! * dy[j]!;
    out[i] = rhs[i]! - s;
  }
}
