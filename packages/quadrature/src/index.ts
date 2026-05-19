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
//   gaussKronrodAdaptiveBC(f, a, b, prec, opts?)
//     Adaptive G7K15 on `(t: BigFloat, prec: number) => BigComplex`.
//     Real integration variable, BigComplex codomain. The natural
//     surface for Mellin-Barnes contour quadrature (consumer:
//     `packages/meijer-core`'s contour layer). ADR-0022 — a faithful
//     lift of the BF driver to BigComplex codomain. Centred-delta K-G
//     identity ports verbatim component-wise; error estimate is the
//     real `cabs(K-G) · |halfLength|`; on real-only integrands the
//     output bytes are identical to `gaussKronrodAdaptiveBF` (asserted
//     by the test suite).
//
// All three share the priority-queue-bisection structure, the agent-
// honest result shape (value + errorEstimate + nEvals + converged +
// warnings), and the same algebraic-exactness contract — K15 is exact
// for polynomials of degree ≤ 23 in any tier. They differ only in
// codomain (real vs complex), precision tier (float64 vs arb-prec),
// the cancellation-stability of the local rule, and the determinism
// contract.
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
  type BigComplexQuadResult,
  type BigComplexQuadOptions,
  BigComplexQuadratureError,
  gaussKronrodAdaptiveBC,
} from "./gauss-kronrod-bc.js";
export {
  type TanhSinhBFOptions,
  tanhSinhAdaptiveBF,
} from "./tanh-sinh-bf.js";
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

// Float64 special-function dispatch (ADR-0040 Decision 4). Adds the
// Erf family (Erf / Erfc / Erfcx / Erfi / InverseErf / InverseErfc)
// to the closed-vocabulary evaluator. Future per-head ADRs extend
// `SPECIAL_HEADS` additively without re-touching `eval-expr.ts`.
export {
  SPECIAL_HEADS,
  ADMITTED_HEADS as ADMITTED_HEADS_WITH_SPECIAL,
  evalNumericExpr as evalNumericExprWithSpecial,
} from "./eval-numeric-expr.js";

// Per-head float64 implementations (ADR-0015 `numerical: true` tier).
// Re-exported so consumers (e.g. `packages/meijer-core`'s bridge
// numerical cross-check, the Phase 1 bench grader) can call directly
// without going through the AST evaluator.
export {
  type ComplexF64,
  erfFloat64,
  erfcFloat64,
  erfcxFloat64,
  erfiFloat64,
  erfInvFloat64,
  erfcInvFloat64,
  wFunctionFloat64,
  wImFloat64,
  erfComplexFloat64,
  erfcComplexFloat64,
  erfcxComplexFloat64,
  erfiComplexFloat64,
  maskLowWord,
} from "./special-funcs/erf-float64.js";

// Float64 Bessel family substrate (ADR-0041 §Decision 4). Inherits
// `numerical: true` (ADR-0015). Six real entry points (J, Y, I, K +
// scaled I, scaled K) + 4 complex (via AMOS-style rotation per R3 §1.6).
export {
  besselJFloat64,
  besselYFloat64,
  besselIFloat64,
  besselKFloat64,
  besselIScaledFloat64,
  besselKScaledFloat64,
  besselJComplexFloat64,
  besselYComplexFloat64,
  besselIComplexFloat64,
  besselKComplexFloat64,
} from "./special-funcs/bessel-float64.js";

// Float64 Gamma family substrate (ADR-0042 §Decision 4). Inherits
// `numerical: true` (ADR-0015). Nineteen ADMITTED_HEADS entries per
// R3 §1 verbatim-port table: Cephes gamma.c (Moshier 2000), FreeBSD
// e_lgamma_r.c (SunPro 1993), Boost.Math digamma/polygamma, Cephes
// igam.c / incbet.c, SciPy _loggamma.pxd (complex paths).
export {
  type LGammaResult,
  gammaFloat64,
  lgammaFloat64,
  digammaFloat64,
  trigammaFloat64,
  polygammaFloat64,
  pochhammerFloat64,
  gammaPFloat64,
  gammaQFloat64,
  incGammaUpperFloat64,
  incGammaLowerFloat64,
  invGammaPFloat64,
  invGammaQFloat64,
  betaFloat64,
  logBetaFloat64,
  gammaRatioFloat64,
  gammaDeltaRatioFloat64,
  gammaPDerivativeFloat64,
  incBetaFloat64,
  barnesGFloat64,
  hyperfactorialFloat64,
  lgammaComplexFloat64,
  gammaComplexFloat64,
  digammaComplexFloat64,
} from "./special-funcs/gamma-float64.js";
