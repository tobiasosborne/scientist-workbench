// =============================================================================
// @workbench/cone-core — pure-TS convex-cone solver substrate
// =============================================================================
//
// The SCS-style operator-splitting substrate behind the convex-cone solver
// tier (ADR-0030). Three modules:
//
//   cones.ts — the `Cone` primitive, `projectCone`, `dualCone`, `inCone`
//   hsde.ts  — the homogeneous self-dual embedding: `buildHSDE`,
//              `recoverPrimalDual`
//   scs.ts   — the operator-splitting iteration: `scsSolve`
//
// Like `@workbench/linalg-core`, this is a *library, not a tool* — it
// speaks `Float64Array` and a plain TS `Cone` union, never the canonical
// JSON value protocol. The wire encoding (cones-as-`expression` values,
// the `cone-solve` input/output records) lives in the tool layer
// (`tools/cone-solve/tool.ts`). That keeps the substrate free of any
// `@workbench/protocol` dependency — same discipline linalg-core follows.
//
// Algorithm ground truth: `docs/ground-truth/convex/scs-algorithm.md`,
// transcribed from O'Donoghue-Chu-Parikh-Boyd 2016 (`docs/refs/
// odonoghue-2016-scs.pdf`). Ported from the paper, never from `scs.c`
// (CLAUDE.md Law 1 + ADR-0030 §E).

export {
  type Cone,
  type NonNegCone,
  type ZeroCone,
  type FreeCone,
  type SOCone,
  type PSDCone,
  type ExpCone,
  type PowCone,
  ConeError,
  nonNeg,
  zero,
  free,
  coneDim,
  projectCone,
  dualCone,
  inCone,
} from "./cones.js";

export {
  type ConeProblem,
  type HSDEMatrix,
  type Recovered,
  type Candidate,
  type Tolerances,
  type Scaling,
  buildHSDE,
  assembleQ,
  recoverPrimalDual,
  matTransposeVec,
  dot,
} from "./hsde.js";

export { equilibrate, applyScaling } from "./scaling.js";

export { type AndersonAccelerator, makeAnderson } from "./anderson.js";

export {
  type SCSOpts,
  type SCSResult,
  type SCSStatus,
  DEFAULT_SCS_OPTS,
  scsSolve,
  tolerancesFromPrecision,
} from "./scs.js";
