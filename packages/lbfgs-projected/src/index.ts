// =============================================================================
// @workbench/lbfgs-projected — limited-memory BFGS with simple bound constraints
// =============================================================================
//
// The third numerical-tier package in scientist-workbench (after
// `@workbench/linalg-core` and `@workbench/quadrature`). Substrate
// behind `tools/optimize-lbfgs-projected`.
//
// Public surface
// --------------
//   lbfgsProjected(f, grad, x0, lower, upper, opts?)  — minimise f subject to
//                                                        box constraints; returns
//                                                        an agent-honest
//                                                        `LBfgsbResult`.
//   LBfgsbInfeasibleBoundsError                — thrown for `lower[i] > upper[i]`.
//   LBfgsbX0OutsideBoundsError                 — thrown for x0 outside bounds.
//   LBfgsbNonFiniteError                       — thrown when f or grad
//                                                 returns NaN / ±Inf.
//
// Pure TypeScript on `Float64Array`; the wire encoding lives in the
// tool layer (`tools/optimize-lbfgs-projected/tool.ts`). ADR-0010's
// `defineTool`/`runTool` split lets one implementation serve both the
// in-process surface and the subprocess one.
//
// Algorithm: Byrd-Lu-Nocedal-Zhu 1995, with Morales-Nocedal 2011 v3.0
// safeguards. See `lbfgs-projected.ts` for the literate algorithmic prose and
// the citation chain.

export {
  type LBfgsbOptions,
  type LBfgsbResult,
  LBfgsbInfeasibleBoundsError,
  LBfgsbX0OutsideBoundsError,
  LBfgsbNonFiniteError,
  lbfgsProjected,
} from "./lbfgs-projected.js";
