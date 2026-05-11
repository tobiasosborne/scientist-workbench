// @workbench/copt-ipm — pure-TS port of COPT's unified primal-dual IPM.
// Phase A: LP (NonNeg cone).
// Phase B: SDP (PSD cone, NT scaling) — under construction.

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
} from "./solver/Solver.js";
export { formatIterLine, formatIterHeader } from "./solver/LogFormat.js";

// SDP
export { parseSdpaSparse, type SdpaSparseProblem } from "./format/SdpaSparse.js";
export { convertSdpaToSdp, type SdpProblem, type SdpBlock } from "./problem/SdpProblem.js";
export { solveSdp as solveSdpHkm, type SdpSolveResult } from "./solver/SdpSolver.js";
// Primary export: solveSdp = Nesterov-Todd direction (= COPT's default barrier path).
// AHO and HKM kept as alternative directions for A/B comparison.
export { solveSdpNt as solveSdp, solveSdpNt } from "./solver/NtSdpSolver.js";
export { solveSdpAho } from "./solver/AhoSdpSolver.js";
