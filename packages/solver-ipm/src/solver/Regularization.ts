// =============================================================================
// Regularization — adaptive 3-way Tikhonov for the Schur complement factor
// =============================================================================
//
// The single most distinctive engineering refinement in COPT's default
// barrier path (per `analysis/PD_IPM_DEEP.md` §"Adaptive Tikhonov" and
// `CLEANROOM_SPEC.md` §6 in the COPT-decomp research). Every iteration of
// the unified LP+SDP main loop factors the Schur complement `M Δy = h`;
// when `M` is poorly conditioned, indefinite, or numerically singular
// (which it routinely is on real problems), naive Cholesky fails.
//
// The textbook fix is uniform Tikhonov lift: factor `M + δI` for some small
// `δ`. This works but over-regularises: lifting all of `M` by `δ` damages
// well-conditioned components to fix ill-conditioned ones. COPT's refinement
// — and the spec's — is to **diagnose the source of ill-conditioning and
// lift only the relevant tier**. Three tiers:
//
//   δ_p (primal regularizer, cap 1e-2, bump ×10)
//     — applied when the failing row's constraint norm is tiny vs the
//       global constraint scale (primal-degenerate row). Tight cap because
//       a small bump usually suffices.
//
//   δ_d (dual regularizer, cap 1e+2, bump ×100)
//     — applied when the failing row's RHS magnitude is tiny vs the global
//       RHS scale (dual-degenerate constraint). Large headroom because the
//       lift may need to span many orders of magnitude.
//
//   δ_g (gap regularizer, cap 1e+2, bump ×100)
//     — the generic fallback: applied when neither primal nor dual
//       diagnostics fire. This is the "rank-deficient Schur" case (e.g.,
//       LP infeasibility certificates with proportional constraint rows,
//       SDP `control3`'s late-iteration Cholesky breakdown). Large
//       headroom because rank-deficient Schurs may need substantial lift.
//
// The diagonal lift actually applied is the **sum** `(δ_p + δ_d + δ_g)·I`
// per spec §6.1. The diagnose-kind heuristic decides which counter to bump
// when factorization fails; the cumulative lift is what Cholesky sees.
//
// Diagnose-kind: spec §6.5's v1 simple rule
// -----------------------------------------
// After `choleskyInPlace` fails at row `r`:
//
//   • PRIMAL if `‖A_r‖ < 1e-10 · ‖A‖_global`  (degenerate primal row)
//   • DUAL   if `|h_r| < 1e-10 · ‖h‖_∞`        (degenerate dual constraint)
//   • else GAP                                  (generic ill-conditioning)
//
// For LP, `‖A_r‖` is the row ∞-norm of constraint r. For SDP, it's the
// per-constraint Frobenius norm summed across cone blocks. `h` is the
// Schur RHS, which isn't available at factor time (it's built per
// predictor/corrector pass), so the v1 rule restricts to PRIMAL-vs-GAP
// discrimination and leaves DUAL as a v2 refinement. This is honest and
// matches `CLEANROOM_SPEC.md` §6.5's "more sophisticated diagnoser is a
// v2 concern" disclaimer.
//
// Per-iteration adaptive init: NOT implemented in v1
// --------------------------------------------------
// Spec §6.3 prescribes "if `refactor_in_iter > 5`, tighten initial δs for
// next iter; else reset to default." The current implementation carries
// δs across iterations unconditionally. This is a minor deviation; with
// diagnose-kind targeting the right tier, the bumps stay small and
// carry-over rarely matters. Adaptive init is a future refinement.
//
// API contract
// ------------
// • `factorWith3Way(M, m, Lchol, reg, params, diagnose)` — factor with
//   adaptive retry. Returns `true` on success (Lchol contains factor);
//   `false` on permanent failure (all caps exhausted).
// • `makeLpDiagnose(A, m, n)` — diagnose helper for LP path.
// • `makeSdpDiagnose(blocks, m)` — diagnose helper for SDP path.
// • Both diagnose helpers pre-compute row norms once and close over them
//   so the per-retry diagnose call is `O(1)`.
//
// Reference: PD_IPM_DEEP.md §"Adaptive Tikhonov regularization" + the
// IPM_LOOP_CHEATSHEET.md §4 escalation logic + CLEANROOM_SPEC.md §6.
// The COPT decomp at `FUN_006efa20` (Schur build) and `FUN_006efac0`
// (Cholesky factor) document the canonical implementation pattern.

import { choleskyInPlace } from "../linalg/Cholesky.js";
import type { SdpBlock } from "../problem/SdpProblem.js";

export type RegKind = "primal" | "dual" | "gap";

/**
 * Mutable per-iterate regularisation state. The three δ counters carry
 * over across iterations (subject to spec §6.3's "tighten if heavy
 * bumps" refinement, not implemented in v1).
 */
export interface RegState {
  jitterPrimal: number;
  jitterDual: number;
  jitterGap: number;
  bumpsPrimal: number;
  bumpsDual: number;
  bumpsGap: number;
  refactors: number;
}

/**
 * Regularisation parameters. Defaults supplied per the spec §6.4 caps:
 * `cap_p = 1e-2`, `cap_d = 1e+2`, `cap_g = 1e+2`. Bump factors per spec:
 * primal ×10, dual ×100, gap ×100. `MAX_REFACTOR = 10` per spec §6.4.
 */
export interface RegParams {
  initialJitter: number;
  jitterMaxPrimal: number;
  jitterMaxDual: number;
  jitterMaxGap: number;
  bumpPrimal: number;
  bumpDual: number;
  bumpGap: number;
  maxRefactor: number;
}

/**
 * Diagnose function: given the row `failRow` at which Cholesky reports a
 * non-positive pivot, return which regularisation tier to bump.
 *
 * Pre-computed and closed over row-norm context — see `makeLpDiagnose` /
 * `makeSdpDiagnose`. The trivial diagnose `() => "gap"` is also valid
 * (corresponds to blind GAP-only escalation, a simpler baseline).
 */
export type DiagnoseFn = (failRow: number) => RegKind;

/**
 * Build a diagnose function for the LP path.
 *
 * The classification is PRIMAL if `‖A_r‖_∞ < threshold · ‖A‖_∞`, else
 * `defaultKind`. Default `threshold = 1e-6` (much looser than the SDP
 * variant's `1e-10`) and `defaultKind = "primal"` together encode the
 * empirical observation: NETLIB LP problems are typically *all* primal-
 * regularization-dominated (brandy/lotfi/F_infeasible_3var_sum all need
 * δ_p ≤ 1e-2 to recover, not the spec's δ_g ≤ 1e+2). Routing routine
 * failures to GAP — the strict spec §6.5 reading — overshoots on LP
 * because the GAP regulariser's `cap_g = 1e+2` damps the iterate enough
 * to suppress Farkas-direction growth and degrade the late-iteration
 * objective. The SDP variant uses the spec-strict rule because PSD
 * Schur matrices genuinely need the wider GAP headroom (control3-class
 * cases hit Cholesky breakdown without it).
 */
export function makeLpDiagnose(
  A: Float64Array,
  m: number,
  n: number,
  opts: { threshold?: number; defaultKind?: RegKind } = {},
): DiagnoseFn {
  const rowNorms = new Float64Array(m);
  let globalNorm = 0;
  for (let i = 0; i < m; i++) {
    let rn = 0;
    for (let j = 0; j < n; j++) {
      const a = Math.abs(A[i * n + j]!);
      if (a > rn) rn = a;
    }
    rowNorms[i] = rn;
    if (rn > globalNorm) globalNorm = rn;
  }
  const thresh = (opts.threshold ?? 1e-6) * Math.max(globalNorm, 1e-300);
  const defaultKind = opts.defaultKind ?? "primal";
  return (failRow: number): RegKind => {
    if (failRow < 0 || failRow >= m) return defaultKind;
    return rowNorms[failRow]! < thresh ? "primal" : defaultKind;
  };
}

/**
 * Build a diagnose function for the SDP path. The "row norm" of
 * constraint `i` is `√(Σ_b ‖A_i^b‖_F²)` — the Frobenius norm of the
 * constraint as a block-diagonal matrix. All other semantics match the
 * LP variant.
 */
export function makeSdpDiagnose(blocks: readonly SdpBlock[], m: number): DiagnoseFn {
  const rowNorms = new Float64Array(m);
  let globalNorm = 0;
  for (let i = 0; i < m; i++) {
    let sq = 0;
    for (const b of blocks) {
      const Ai = b.A[i]!;
      for (let k = 0; k < Ai.length; k++) sq += Ai[k]! * Ai[k]!;
    }
    const rn = Math.sqrt(sq);
    rowNorms[i] = rn;
    if (rn > globalNorm) globalNorm = rn;
  }
  const threshold = 1e-10 * Math.max(globalNorm, 1e-300);
  return (failRow: number): RegKind => {
    if (failRow < 0 || failRow >= m) return "gap";
    return rowNorms[failRow]! < threshold ? "primal" : "gap";
  };
}

/**
 * Trivial GAP-only diagnose. Useful for unit tests and as a fallback
 * for callers that don't want to pre-compute row norms.
 */
export const gapOnlyDiagnose: DiagnoseFn = () => "gap";

/**
 * Factor a symmetric `m × m` matrix `M` (row-major) into its Cholesky
 * factor `Lchol`, with adaptive 3-way Tikhonov regularisation.
 *
 * On success, returns `true` with `Lchol` containing the lower-triangular
 * factor of `M + (δ_p + δ_d + δ_g)·I`. On permanent failure (every tier
 * capped without producing a clean factor), returns `false`.
 *
 * The retry loop tries up to `params.maxRefactor` factorisations. Each
 * failed factorisation diagnoses the kind of failure (PRIMAL / DUAL /
 * GAP) and bumps the corresponding regulariser. When the diagnosed tier
 * is capped, falls through to GAP → DUAL → PRIMAL in order, mirroring
 * the spec's "any tier with headroom" recovery.
 *
 * Mutates `reg` and `Lchol`. Does not mutate `M`.
 */
export function factorWith3Way(
  M: Float64Array,
  m: number,
  Lchol: Float64Array,
  reg: RegState,
  params: RegParams,
  diagnose: DiagnoseFn,
): boolean {
  for (let attempt = 0; attempt < params.maxRefactor; attempt++) {
    Lchol.set(M);
    const lift = reg.jitterPrimal + reg.jitterDual + reg.jitterGap;
    const info = choleskyInPlace(Lchol, m, lift);
    if (info < 0) return true;

    const kind = diagnose(info);
    if (tryBump(reg, params, kind)) {
      reg.refactors++;
      continue;
    }
    // Diagnosed tier is capped — fall through to other tiers in priority
    // order (gap → dual → primal). This matches the spec's "if a tier is
    // capped, escalate to the next tier" recovery pattern.
    const fallback: RegKind[] = ["gap", "dual", "primal"].filter(
      (k) => k !== kind,
    ) as RegKind[];
    let bumped = false;
    for (const k of fallback) {
      if (tryBump(reg, params, k)) {
        bumped = true;
        break;
      }
    }
    if (!bumped) return false;
    reg.refactors++;
  }
  return false;
}

/**
 * Bump the given tier by its bump factor, capped at the tier's ceiling.
 * Returns false if the tier is already at its cap (caller should escalate).
 *
 * Uses `Math.max(jitter, 1e-12)` so the first bump from `initialJitter=0`
 * doesn't stay at zero (the multiplicative bump needs a non-zero base).
 */
function tryBump(reg: RegState, params: RegParams, kind: RegKind): boolean {
  switch (kind) {
    case "primal":
      if (reg.jitterPrimal >= params.jitterMaxPrimal) return false;
      reg.jitterPrimal = Math.min(
        Math.max(reg.jitterPrimal, 1e-12) * params.bumpPrimal,
        params.jitterMaxPrimal,
      );
      reg.bumpsPrimal++;
      return true;
    case "dual":
      if (reg.jitterDual >= params.jitterMaxDual) return false;
      reg.jitterDual = Math.min(
        Math.max(reg.jitterDual, 1e-12) * params.bumpDual,
        params.jitterMaxDual,
      );
      reg.bumpsDual++;
      return true;
    case "gap":
      if (reg.jitterGap >= params.jitterMaxGap) return false;
      reg.jitterGap = Math.min(
        Math.max(reg.jitterGap, 1e-12) * params.bumpGap,
        params.jitterMaxGap,
      );
      reg.bumpsGap++;
      return true;
  }
}

/**
 * Convert the LP-side `IpmParams` shape (carried per Iterate) into the
 * shared `RegParams` shape. Used by call sites that already have
 * `IpmParams` in scope.
 */
export function regParamsFromIpm(p: {
  initialJitter: number;
  jitterMaxPrimal: number;
  jitterMaxDual: number;
  jitterMaxGap: number;
  bumpPrimal: number;
  bumpDual: number;
  bumpGap: number;
}, maxRefactor: number): RegParams {
  return {
    initialJitter: p.initialJitter,
    jitterMaxPrimal: p.jitterMaxPrimal,
    jitterMaxDual: p.jitterMaxDual,
    jitterMaxGap: p.jitterMaxGap,
    bumpPrimal: p.bumpPrimal,
    bumpDual: p.bumpDual,
    bumpGap: p.bumpGap,
    maxRefactor,
  };
}
