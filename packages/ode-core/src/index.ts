// =============================================================================
// @workbench/ode-core — adaptive non-stiff IVP integration on Float64Array
// =============================================================================
//
// Sixth numerical-tier package in scientist-workbench (after `linalg-
// core`, `quadrature`, `lbfgs-projected`). Substrate behind
// `tools/integrate-ode-ivp`.
//
// Surface
// -------
//   integrate(f, t0, tf, y0, opts)   — adaptive DOPRI5 + PI with FSAL
//                                      and Hermite continuous extension.
//                                      Returns an agent-honest record.
//   buildRhs(fExprs, vars, tVar)     — vector-RHS adapter over the
//                                      closed expression vocabulary
//                                      (`@workbench/quadrature`'s
//                                      `evalNumericExpr`).
//   assessNumericalScale(...)        — measurement-driven warning
//                                      strings (ADR-0016 pattern).
//
// All surfaces are pure TypeScript on float64; the wire encoding lives
// in the tool layer (`tools/integrate-ode-ivp/tool.ts`). ADR-0010's
// `defineTool`/`runTool` split lets one implementation serve both the
// in-process surface and the subprocess one.

export {
  type IntegrateOptions,
  type IntegrateResult,
  OdeNonFiniteError,
  OdeDegenerateTspanError,
  integrate,
} from "./integrate.js";

export { buildRhs } from "./eval-rhs.js";

export {
  type Algorithm as OdeAlgorithm,
  assessNumericalScale,
  estimatePeakMemoryMB,
  estimateWallClockSeconds,
} from "./scale.js";

export {
  ORDER as DOPRI5_ORDER,
  N_STAGES as DOPRI5_N_STAGES,
  dopri5Step,
  dopri5DenseEval,
} from "./dopri5.js";

export {
  nextStepFactor,
  selectInitialStep,
  MIN_FACTOR as PI_MIN_FACTOR,
  MAX_FACTOR as PI_MAX_FACTOR,
} from "./pi-controller.js";
