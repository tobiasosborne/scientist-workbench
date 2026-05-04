// =============================================================================
// @workbench/quadrature — adaptive 1D Gauss-Kronrod quadrature
// =============================================================================
//
// The second numerical-tier package in scientist-workbench (after
// `@workbench/linalg-core`). Substrate behind `tools/integrate-1d`.
//
// Surface
// -------
//   gaussKronrodAdaptive(f, a, b, opts?)  — adaptive G7K15 with global
//                                            priority-queue bisection.
//                                            Returns an agent-honest
//                                            `QuadResult`.
//   evalNumericExpr(value, env)            — numeric evaluation of the
//                                            closed-vocabulary expression
//                                            tree the tool admits.
//
// Both surfaces are pure TypeScript on float64; the wire encoding
// lives in the tool layer (`tools/integrate-1d/tool.ts`). ADR-0010's
// `defineTool`/`runTool` split lets one implementation serve both the
// in-process surface and the subprocess one.

export {
  type QuadResult,
  type QuadOptions,
  QuadratureNonFiniteError,
  gaussKronrodAdaptive,
} from "./gauss-kronrod.js";
export {
  ADMITTED_HEADS,
  ADMITTED_CONSTANTS,
  UnknownVocabularyError,
  evalNumericExpr,
} from "./eval-expr.js";
