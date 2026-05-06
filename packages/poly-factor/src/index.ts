// =============================================================================
// @workbench/poly-factor — exact univariate factorization over ℚ
// =============================================================================
//
// Substrate package for `tools/poly-factor`. Implements the standard
// pipeline: square-free decomposition (Yun 1976) → factorization over
// `𝔽_p` (Berlekamp 1967) → Hensel lifting (Zassenhaus 1969 quadratic) →
// recombination (van Hoeij 2002).
//
// v0.1: square-free only. Subsequent beads add the rest. The bench is
// `bench/poly-factor-q/`; ADR-0019 governs verification discipline.

export { squareFree, type SquareFreeFactor } from "./squarefree.js";
