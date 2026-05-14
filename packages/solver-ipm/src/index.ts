// @workbench/solver-ipm — Mehrotra primal-dual interior-point method
// (Mehrotra 1992 predictor-corrector) for LP (NonNeg cone) and SDP
// (PSD cone, Nesterov-Todd scaling).

export type {
  CanonicalLp,
  ConeBlock,
  NonNegConeBlock,
  PsdConeBlock,
  SolveStatus,
  SolveSuccess,
} from "./format/CanonicalLp.js";
export { lpFromCanonical, type LpProblem } from "./problem/LpProblem.js";
export { DEFAULT_PARAMS, type IpmParams } from "./solver/Defaults.js";
export { makeIterate, type Iterate, type SolverStatus } from "./solver/Iterate.js";
export {
  solveLp,
  type SolveResult,
  type SolveOptions,
  type IterLogLine,
  type VerboseIterLine,
} from "./solver/Solver.js";
export {
  formatIterLine,
  formatIterHeader,
  formatVerboseLine,
} from "./solver/LogFormat.js";
export {
  type TraceLine,
  parseCoptLog,
  parseMosekLog,
  parseGurobiLog,
} from "./solver/TraceLog.js";
export { toWireStatus, type WireStatus } from "./solver/Status.js";
export {
  type HsdeResiduals,
  type HsdeStatus,
  type HsdeLpIterate,
  type HsdeSdpIterate,
} from "./solver/HsdeIterate.js";
export {
  hsdeLpMaxStep,
  hsdeSdpMaxStep,
  tauKappaMaxStep,
} from "./solver/HsdeStepLength.js";
export {
  solveHsdeLp,
  type HsdeLpSolveResult,
} from "./solver/HsdeLpSolver.js";
export {
  solveHsdeSdpNt,
  type HsdeSdpSolveResult,
} from "./solver/HsdeNtSdpSolver.js";

// SDP
export { parseSdpaSparse, type SdpaSparseProblem } from "./format/SdpaSparse.js";
export { convertSdpaToSdp, type SdpProblem, type SdpBlock } from "./problem/SdpProblem.js";
export { solveSdp as solveSdpHkm, type SdpSolveResult } from "./solver/SdpSolver.js";
// Primary export: solveSdp = Nesterov-Todd direction (Todd-Toh-Tütüncü 1998).
// AHO (Alizadeh-Haeberly-Overton 1997) and HKM (Helmberg-Kojima-Monteiro 1996)
// kept as alternative directions for A/B comparison.
export { solveSdpNt as solveSdp, solveSdpNt } from "./solver/NtSdpSolver.js";
export { solveSdpAho } from "./solver/AhoSdpSolver.js";
