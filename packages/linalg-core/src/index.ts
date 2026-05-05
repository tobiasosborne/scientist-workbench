// =============================================================================
// @workbench/linalg-core — pure-TS dense linear algebra on Float64Array
// =============================================================================
//
// The first numerical-tier package in scientist-workbench. ADR-0014 is
// the design rationale; `docs/numerics-and-vis-2026-04-29.md` is the
// strategic precursor.
//
// Substrate target
// ----------------
// Bun on x86-64 Linux (development platform). No FFI. No subprocess.
// No dependence on `@workbench/protocol` — this package is pure JS-side
// numerics; the wire encoding lives in the tool layer.
//
// Public surface (the agent-irresistible answer to "I have A x = b"):
//
//   import { matrixFromRows, solve } from "@workbench/linalg-core";
//
//   const A = matrixFromRows([[2, 1], [1, 3]]);
//   const b = new Float64Array([4, 5]);
//   const result = solve(A, b);
//   // result === {
//   //   x: Float64Array [7/5, 6/5],
//   //   residualNorm: ~1e-16,
//   //   bNorm: ~6.4,
//   //   conditionEstimate: ~3.2,
//   //   growthFactor: 1,
//   //   method: "lu-partial-pivot",
//   //   iterations: 0,
//   // }

export {
  type Matrix,
  MatrixError,
  matrixFromRows,
  matrixToRows,
  matZeros,
  matIdentity,
  matClone,
  get,
  set,
  matVec,
  vecNorm2,
  vecNormInf,
  matNorm1,
} from "./matrix.js";
export {
  type LUResult,
  lu,
  luInPlace,
  luSolve,
  luSolveTransposed,
  luDet,
} from "./lu.js";
export { hagerOneNormEstimate } from "./hager.js";
export { type SolveResult, solve, solveWithLU } from "./solve.js";
export { type QRResult, qr } from "./qr.js";
export { type SVDResult, type SVDOptions, svd, svdJacobi, svdGolubReinsch } from "./svd.js";
export { type EighResult, eigh } from "./eigh.js";
export {
  type Algorithm as NumericalAlgorithm,
  MemoryExhaustionError,
  assessNumericalScale,
  estimatePeakMemoryMB,
  estimateWallClockSeconds,
  withOomGuard,
} from "./scale.js";
