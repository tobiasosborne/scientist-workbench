// =============================================================================
// @workbench/simplex-q — exact-rational LP simplex substrate
// =============================================================================
//
// Public barrel. The package's intended-public surface is the
// `simplexSolve` function and the `StandardLP` / `SimplexResult` types
// that frame it; everything else here is re-exported as a courtesy for
// downstream tests, future tools, and the literate doc-comments that
// cite the helpers by name.
//
// Consumers:
//   • `tools/lp-solve` (today) — wraps `simplexSolve` in the ADR-0030
//     float64 wire schema.
//   • `tools/lp-solve-fast` (future, bead hnyu) — adds the float64 lane
//     using a different basis substrate (`@workbench/linalg-core`'s LU
//     with Bartels-Golub update) but the same orchestration shape.
//   • `tools/lp-solve-ipm` (future, bead prfp) — Mehrotra IPM lane; uses
//     `@workbench/cas-core`'s `Rat` directly for KKT residuals but does
//     not share the simplex driver.
//
// See `docs/adr/0031-lp-solve-arbprec-engine.md` for the design rationale
// and `packages/simplex-q/README.md` for the algorithm walkthrough.

export {
  simplexSolve,
  type StandardLP,
  type SimplexOpts,
  type SimplexResult,
  type SimplexOptimal,
  type SimplexInfeasible,
  type SimplexUnbounded,
  type SimplexIterCap,
  type SimplexCoeffExplosion,
  ratBitLength,
} from "./simplex.js";

export {
  type BasisInverse,
  type RatMatrix,
  type RatVector,
  identityBasisInverse,
  solveBasis,
  solveBasisT,
  pivotUpdate,
  basisBitLength,
  ratDot,
  ratVecNeg,
} from "./basis.js";

export {
  type Sign,
  ratCompare,
  ratLt,
  ratLe,
  ratGt,
  ratGe,
  ratIsPositive,
  ratEq,
} from "./rat-cmp.js";
