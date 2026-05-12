// IPM tuning parameters. Defaults: iter cap 500, relative feasibility 1e-8,
// optimality 1e-8, Mehrotra safeguard step 0.99995, three Tikhonov tiers
// (primal/dual/gap) with caps from CLEANROOM_SPEC.md §6.4:
//   cap_p = 1e-2   (primal regularizer — bounded tight, primal-degenerate rows)
//   cap_d = 1e+2   (dual regularizer — large headroom, dual-degenerate rows)
//   cap_g = 1e+2   (gap regularizer — large headroom, generic ill-conditioning)
// The asymmetry is load-bearing: the primal regularizer applies to rows whose
// constraint has nearly zero support after cone scaling — small bumps suffice.
// The dual and gap regularizers absorb generic Schur-matrix conditioning
// blowups, where the entries to lift can be many orders of magnitude. With all
// three capped at 1e-2 (the pre-spec-alignment state), ill-conditioned Schur
// matrices like control3's iter-53 case hit the cap before factorization
// recovers — `numerical-error` exit, no answer.
//
// MAX_REFACTOR = 10 per spec §6.4 (was 20 in the LP path; aligned here).

export interface IpmParams {
  iterLimit: number;
  timeLimitSec: number;
  feasTol: number;
  optTol: number;
  stepFactor: number;
  initialJitter: number;
  jitterMaxPrimal: number;
  jitterMaxDual: number;
  jitterMaxGap: number;
  bumpPrimal: number;
  bumpDual: number;
  bumpGap: number;
  stallIterCap: number;
  logEvery: number;
}

export const DEFAULT_PARAMS: IpmParams = {
  iterLimit: 500,
  timeLimitSec: 600,
  feasTol: 1e-8,
  optTol: 1e-8,
  stepFactor: 0.99995,
  initialJitter: 1e-12,
  jitterMaxPrimal: 1e-2,
  jitterMaxDual: 1e2,
  jitterMaxGap: 1e2,
  bumpPrimal: 10,
  bumpDual: 100,
  bumpGap: 100,
  stallIterCap: 10,
  logEvery: 1,
};
