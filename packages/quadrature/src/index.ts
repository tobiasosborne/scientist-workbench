// =============================================================================
// @workbench/quadrature — adaptive 1D Gauss-Kronrod quadrature
// =============================================================================
//
// Substrate behind `tools/integrate-1d` (float64) plus the in-process
// surface for arb-prec consumers (`packages/meijer-core`, eventually
// `tools/meijer-g`). Two adaptive drivers, one algorithm:
//
//   gaussKronrodAdaptive(f, a, b, opts?)
//     Adaptive G7K15 on `(x: number) => number`. Float64.
//     ADR-0014 (numerical tier) and ADR-0015 (numerical-tier
//     determinism — platform-conditional).
//
//   gaussKronrodAdaptiveBF(f, a, b, prec, opts?)
//     Adaptive G7K15 on `(x: BigFloat, prec: number) => BigFloat`.
//     Arbitrary precision. ADR-0020 (arb-prec tier — bit-identical
//     across all runtimes by language spec) and ADR-0021 (this
//     generalisation, including the cancellation-stable error
//     estimator that the high-precision regime requires).
//
// Both share the priority-queue-bisection structure, the agent-honest
// result shape (value + errorEstimate + nEvals + converged + warnings),
// and the same algebraic-exactness contract — K15 is exact for
// polynomials of degree ≤ 23 in either tier. They differ only in
// codomain, the cancellation-stability of the local rule, and the
// determinism contract.
//
// Plus the integrand bridge (float64 only):
//
//   evalNumericExpr(value, env)
//     Numeric evaluation of the closed-vocabulary expression tree
//     `tools/integrate-1d` admits. The arb-prec driver does not have
//     an analogous bridge in v0.1 — its callers (`packages/meijer-core`'s
//     contour layer, et al.) compose BigFloat-typed integrands
//     directly rather than walking a `Value` tree.

export {
  type QuadResult,
  type QuadOptions,
  QuadratureNonFiniteError,
  gaussKronrodAdaptive,
} from "./gauss-kronrod.js";
export {
  type BigFloatQuadResult,
  type BigFloatQuadOptions,
  BigFloatQuadratureError,
  gaussKronrodAdaptiveBF,
} from "./gauss-kronrod-bf.js";
export {
  MAX_DECIMAL_PRECISION,
  type G7K15Table,
  getG7K15Table,
  _clearG7K15TableCacheForTesting,
} from "./nodes-weights-bf.js";
export {
  ADMITTED_HEADS,
  ADMITTED_CONSTANTS,
  UnknownVocabularyError,
  evalNumericExpr,
} from "./eval-expr.js";
