// =============================================================================
// ring — abstract algebraic structure over which Poly and RatFn are defined
// =============================================================================
//
// Why this file exists
// --------------------
// cas-core was born hardcoded over Q: `Poly` carried `Rat` coefficients,
// `polyAdd` directly called `ratAdd`, and any extension to a new
// coefficient ring meant duplicating the polynomial machinery. ADR-0008
// commits to the ring-generic refactor that makes a polynomial over Q
// and a polynomial over Q[√2, i] run the *same* algorithms; only the
// coefficient operations change.
//
// This module declares the abstract interface every coefficient ring
// satisfies. Concrete instances live alongside their concrete element
// types — `RAT_RING: Field<Rat>` lives in `rat.ts`, the algebraic-
// numbers ring lives in `algebraic.ts` (next issue), future rings
// each live with their value type.
//
// Design notes
// ------------
// We expose two abstractions:
//
//   • `Ring<T>` — the minimum interface for polynomial arithmetic
//     (zero, one, add, sub, mul, neg, eq, isZero, isOne, fromInt).
//     This is what `polyAdd`, `polyMul`, `polyEq` need.
//   • `Field<T>` — extends Ring with `inv` and `div`. Required for
//     operations that need division: rational-function arithmetic,
//     polynomial GCD via extended Euclid, algebraic-number inverse.
//
// We deliberately *do not* import FriCAS's full categorical hierarchy
// (CommutativeRing, IntegralDomain, GcdDomain, UFD, …). We add a
// category only when a concrete operation needs it — discipline that
// keeps the surface from sprawling. If polynomial GCD lands as a
// generic algorithm over `EuclideanDomain<T>`, that interface earns
// its place; until then, it doesn't exist.
//
// `fromInt` is required (not optional) because polynomial arithmetic
// over any ring frequently needs to embed integer constants — e.g.,
// the binomial-style multiplications inside `polyPow`. Every
// commutative ring with unity admits an integer embedding (Z → R via
// `n ↦ n·1`), so the requirement is not restrictive.

export interface Ring<T> {
  readonly zero: T;
  readonly one: T;
  readonly add: (a: T, b: T) => T;
  readonly sub: (a: T, b: T) => T;
  readonly mul: (a: T, b: T) => T;
  readonly neg: (a: T) => T;
  readonly eq: (a: T, b: T) => boolean;
  readonly isZero: (a: T) => boolean;
  readonly isOne: (a: T) => boolean;
  readonly fromInt: (n: bigint) => T;
}

export interface Field<T> extends Ring<T> {
  /** Multiplicative inverse. Throws if `a` is the zero element. */
  readonly inv: (a: T) => T;
  /** Division. Throws if `b` is the zero element. */
  readonly div: (a: T, b: T) => T;
}
