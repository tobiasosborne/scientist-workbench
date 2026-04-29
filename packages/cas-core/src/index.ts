// Public surface of @workbench/cas-core.
//
// As of ADR-0008, cas-core is ring-generic: Poly<T>, RatFn<T>, and the
// arithmetic functions over them take an explicit Ring<T> / Field<T>.
// Q is the v0.1 instance via RAT_RING. Future rings (algebraic numbers,
// finite fields, p-adic, modular Z/nZ) plug in as new Field<T>
// dictionaries.
//
// For ergonomic use over Q, RATFN_ZERO and RATFN_ONE are pre-bound
// constants. POLY_ZERO is structurally polymorphic (Poly<never>) and
// can be passed where any Poly<T> is expected.

export { type Ring, type Field } from "./ring.js";

export {
  type Rat,
  RAT_ONE,
  RAT_ZERO,
  RAT_NEG_ONE,
  RAT_RING,
  makeRat,
  ratAdd,
  ratSub,
  ratMul,
  ratDiv,
  ratInv,
  ratNeg,
  ratEq,
  ratIsZero,
  ratIsOne,
  ratIsNegOne,
  ratIsNegative,
} from "./rat.js";

export {
  type Exp,
  type Monomial,
  type Poly,
  POLY_ZERO,
  polyZero,
  polyOne,
  polyAdd,
  polySub,
  polyMul,
  polyNeg,
  polyPow,
  polyEq,
  polyIsZero,
  polyIsOne,
  polyIsConst,
  polyConstValue,
  polyConst,
  polyVar,
  polyLeadingCoef,
  compareExp,
} from "./poly.js";

export {
  type RatFn,
  type RatFnOptions,
  RATFN_ZERO,
  RATFN_ONE,
  makeRatFn,
  makeRatFnQ,
  ratFnZero,
  ratFnOne,
  ratFnFromPoly,
  ratFnAdd,
  ratFnSub,
  ratFnMul,
  ratFnDiv,
  ratFnNeg,
  ratFnPow,
  ratFnEq,
  ratFnIsZero,
  ratFnIsConst,
  ratFnStructuralEq,
} from "./ratfn.js";

export {
  CasOutOfScopeError,
  valueToRatFn,
  ratFnToValue,
  polyToValue,
  ratFnConstValue,
} from "./expr-bridge.js";

export { SIMPLIFY_TAG, casSimplify } from "./simplify.js";
export { type VerifyInput, casVerify } from "./verify.js";

export {
  type AlgebraicElement,
  type AlgebraicRingSpec,
  algebraicRing,
  algElement,
  Q_SQRT2,
  Q_I,
  Q_SQRT2_I,
  qSqrt2,
  qI,
  qSqrt2I,
} from "./algebraic.js";
