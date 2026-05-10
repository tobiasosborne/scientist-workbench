// =============================================================================
// @workbench/groebner — multivariate Gröbner-basis substrate over ℚ
// =============================================================================
//
// Substrate package implementing Buchberger's algorithm with sugar +
// Gebauer-Möller, FGLM order-conversion, and shape-lemma extraction.
// The public surface is consumed by:
//
//   • `tools/groebner-basis` — the standalone GB tool (corpus bench
//     `groebner-basis`).
//   • `packages/solve` — the multivariate-poly dispatch lane that
//     uses `solveGroebner` to produce ADR-0017-shaped solution sets.
//
// Algorithmic recap (from RESEARCH-NOTE-x8d.md §2):
//
//   §2-A representation   — `Poly<Rat>` from cas-core; supplied
//                           monomial order via the comparator
//                           interface here, not via `terms[0]`.
//   §2-B pair selection   — sloppy sugar; deterministic (i, j) lex
//                           tiebreak.
//   §2-C pair pruning     — Buchberger Crit 1 (coprime LM) + Crit 2
//                           (Gebauer-Möller chain), short-circuited.
//   §2-D interreduction   — always; output is the unique reduced GB.
//   §2-E zero-dim test    — pure-power LM check, ordering-independent
//                           (Macaulay; CLO Ch.5 §3 Theorem 6).
//   §2-F FGLM + shape     — DRL → lex; refuse on shape failure (Q2-1).
//   §2-G deferred         — F4, RUR, complex algebraic naming.

export {
  type MonomialOrder,
  drlOrder,
  expAdd,
  expDivides,
  expGet,
  expLcm,
  expSub,
  expTotalDegree,
  lexOrder,
} from "./monomial-order.js";

export {
  type MultiDivResult,
  leadingCoef,
  leadingTerm,
  monomialAsPoly,
  polyMulMonomial,
  polyMultiDivRem,
  polyNormalForm,
} from "./multidiv.js";

export {
  type BuchbergerResult,
  buchbergerReduced,
  isZeroDimensional,
  sPolynomial,
} from "./buchberger.js";

export { fglm } from "./fglm.js";

export {
  type ExtractResult,
  type ExtractRefusal,
  type ExtractedSolutionSet,
  detectShapePosition,
  extractShapeSolutions,
} from "./shape-extract.js";

export {
  type GroebnerSolveResult,
  type GroebnerSolveSuccess,
  type GroebnerSolveRefusal,
  solveGroebner,
} from "./solve-groebner.js";
