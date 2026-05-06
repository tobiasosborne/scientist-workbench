// =============================================================================
// @workbench/solve — top-level Solve dispatcher substrate
// =============================================================================
//
// Substrate package for `tools/solve`. The classifier decides which
// substrate path applies (linear / univariate-poly / unsupported);
// the dispatcher executes the path and returns an ADR-0017-shaped
// result. The tool wraps the result for emission.
//
// v0.1 lanes: linear systems over ℚ (via bareissSolve in cas-core),
// univariate polynomial equations (via factorRatQ + radical solvers).
// Multivariate-non-zero-dim (Gröbner basis), transcendental (invert-
// and-substitute), and parametric inputs surface as honest refusals.

export {
  classifyInput,
  type ClassifiedLinear,
  type ClassifiedUnivariatePoly,
  type ClassifiedUnsupported,
  type ClassifyResult,
} from "./classify.js";

export {
  dispatchClassified,
  type Solution,
  type SolveSuccess,
  type SolveRefusal,
  type SolveResult,
} from "./dispatch.js";
