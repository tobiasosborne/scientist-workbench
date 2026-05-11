// Defaults from FUN_00727f80 + the convergence-test tolerances of FUN_00732a50.
// COPT's free-trial defaults: iter cap 500, relative feasibility 1e-8.

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
  jitterMaxDual: 1e-2,
  jitterMaxGap: 1e-2,
  bumpPrimal: 10,
  bumpDual: 100,
  bumpGap: 100,
  stallIterCap: 10,
  logEvery: 1,
};
