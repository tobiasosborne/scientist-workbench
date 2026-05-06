// =============================================================================
// @workbench/poly-factor — exact univariate factorization over ℚ
// =============================================================================
//
// Substrate package for `tools/poly-factor`. Implements the standard
// pipeline: square-free decomposition (Yun 1976) → factorization over
// `𝔽_p` (Berlekamp 1967) → Hensel lifting (Zassenhaus 1969 quadratic) →
// recombination (van Hoeij 2002).
//
// v0.1: square-free decomposition + two-factor Hensel lifting. Subsequent
// beads add Berlekamp factorisation over 𝔽_p, multi-factor Hensel, and
// van Hoeij recombination. The bench is `bench/poly-factor-q/`;
// ADR-0019 governs verification discipline.

export { squareFree, type SquareFreeFactor } from "./squarefree.js";
export { henselLiftPair, henselLiftMany, type HenselLiftResult } from "./hensel.js";
export { berlekampFactor } from "./berlekamp.js";
export {
  mignotteBound,
  mignotteHenselExponent,
  recombineFactors,
} from "./recombine.js";
export {
  factorPrimitiveSquareFreeZ,
  factorIntZ,
  factorRatQ,
  type IntFactorRecord,
  type IntFactorisation,
  type RatFactorRecord,
  type RatFactorisation,
} from "./factor.js";
