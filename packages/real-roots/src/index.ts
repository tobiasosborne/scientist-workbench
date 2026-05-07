// Public surface of @workbench/real-roots.
//
// Vincent-Akritas-Strzebonski (VAS) continued-fraction real-root
// isolation with the Local-Max Quadratic (LMQ) bound. Operates on
// squarefree univariate polynomials in ℚ[x]; returns rational
// isolating intervals (open `(lo, hi)` for irrational, singleton
// `(r, r)` for rational).
//
// Reference: SymPy `dup_isolate_real_roots_sqf` (BSD,
// `sympy/polys/rootisolation.py`). The TS port follows source line-
// by-line; comments cross-reference. Bench: `bench/real-root-isolate`.
//
// ADRs: 0017 (solution-set shape), 0018 (Root[poly,k] composition),
// 0019 (bench discipline). Bead: `scientist-workbench-rra`.

export { type RealInterval, isolateRealRoots } from "./isolate.js";
export { lmqUpperBoundLog2, lmqLowerBoundFloor } from "./lmq.js";
export {
  signVariations,
  shift,
  scale,
  mirror,
  reverse,
  rshift,
  evalAt,
  clearDenominators,
} from "./dense.js";
