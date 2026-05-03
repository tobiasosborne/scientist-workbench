// =============================================================================
// ratfn — rational function = num / den, generic over the coefficient ring
// =============================================================================
//
// A rational function is a pair (num, den) of polynomials over some
// ring R, with the convention that the leading coefficient of `den`
// is "positive" in the sense the ring chooses to expose. For Q, that
// means the canonical sign-normalisation `ratIsNegative(lc(den)) ⇒
// flip both signs`. For more abstract rings, the construction is
// generalised in `makeRatFn`'s `signNormalise` parameter — but for
// rings without a natural sign (e.g., a finite field), the
// normalisation is the identity.
//
// Equality is decided by cross-multiplication: `a/b = c/d  iff  a·d −
// c·b = 0` in the polynomial ring. This is sound and complete over
// any integral domain — *no GCD required*. Q[x_1,…,x_n] is an
// integral domain; so are polynomial rings over any field. We do not
// (yet) support coefficient rings that aren't integral domains. (PRD
// §9.3.)
//
// Pre-ADR-0008 this module hardcoded `Rat` as the polynomial
// coefficient. Post-refactor, every operation takes `R: Field<T>` (a
// field, not just a ring — division is the whole point of rational
// functions). The Q case threads `RAT_RING` through; algebraic-number
// rational functions thread the algebraic ring's Field<T>.

import {
  type Poly,
  polyAdd,
  polyEq,
  polyIsOne,
  polyIsZero,
  polyLeadingCoef,
  polyMul,
  polyNeg,
  polyOne,
  polySub,
  polyZero,
} from "./poly.js";
import { polyDivExact, polyGcd } from "./poly-gcd.js";
import { type Field } from "./ring.js";
import { type Rat, ratIsNegative } from "./rat.js";

export interface RatFn<T> {
  readonly num: Poly<T>;
  readonly den: Poly<T>;
}

// `signNormalise` is the optional ring-aware step that picks a
// canonical sign for the (num, den) pair. The Q case uses
// `ratIsNegative` on the leading coef of `den`. Other rings can opt
// out (no-op) or implement their own normalisation.
export interface RatFnOptions<T> {
  readonly signNormalise?: (leadingCoefOfDen: T) => boolean;
}

export function makeRatFn<T>(
  num: Poly<T>,
  den: Poly<T>,
  R: Field<T>,
  opts?: RatFnOptions<T>
): RatFn<T> {
  if (polyIsZero(den)) throw new Error("ratFn: zero denominator");
  if (polyIsZero(num)) return ratFnZero(R);
  // ADR-0013: reduce to lowest terms before sign-normalisation. Every
  // RatFn produced through `makeRatFn` is in canonical lowest-terms
  // form, so `ratFnStructuralEq` becomes the strong equality (no two
  // representations of the same field element survive in different
  // shapes). The cost is one polyGcd per construction; acceptable for
  // the workbench's typical input sizes.
  const reduced = ratFnReduce({ num, den }, R);
  const lc = polyLeadingCoef(reduced.den, R);
  const flip = opts?.signNormalise?.(lc) ?? false;
  if (flip) {
    return { num: polyNeg(reduced.num, R), den: polyNeg(reduced.den, R) };
  }
  return reduced;
}

/**
 * Reduce a rational function to lowest terms by dividing num and den
 * by their polynomial GCD. Idempotent on already-reduced inputs (the
 * GCD is `R.one`, so no division happens).
 *
 * Most callers should not need to invoke this directly — `makeRatFn`
 * already calls it. It's exported for callers that bypass the
 * constructor (e.g., consumers reading a stored RatFn whose origin
 * predates ADR-0013) or that want to make the cost explicit at a
 * particular call site.
 */
export function ratFnReduce<T>(rf: RatFn<T>, R: Field<T>): RatFn<T> {
  if (polyIsZero(rf.num)) return rf;
  if (polyIsOne(rf.den, R)) return rf;
  const g = polyGcd(rf.num, rf.den, R);
  if (polyIsOne(g, R)) return rf;
  return {
    num: polyDivExact(rf.num, g, R),
    den: polyDivExact(rf.den, g, R),
  };
}

// Q-specific shortcut: the Q `signNormalise` flips sign when the
// leading coef of `den` is negative.
const Q_SIGN_NORMALISE = (lc: Rat): boolean => ratIsNegative(lc);

// Both zero and one are factory functions: zero needs `polyOne(R)`
// for its denominator (a zero denominator would be undefined), and
// one obviously needs `R.one` for both numerator and denominator.
// Q-bound constants `RATFN_ZERO` and `RATFN_ONE` are exported below
// for callers that already know they're working over Q.
export function ratFnZero<T>(R: Field<T>): RatFn<T> {
  return { num: polyZero<T>(), den: polyOne(R) };
}

export function ratFnOne<T>(R: Field<T>): RatFn<T> {
  return { num: polyOne(R), den: polyOne(R) };
}

export function ratFnFromPoly<T>(p: Poly<T>, R: Field<T>): RatFn<T> {
  return makeRatFn(p, polyOne(R), R);
}

export function ratFnAdd<T>(a: RatFn<T>, b: RatFn<T>, R: Field<T>): RatFn<T> {
  return makeRatFn(
    polyAdd(polyMul(a.num, b.den, R), polyMul(b.num, a.den, R), R),
    polyMul(a.den, b.den, R),
    R
  );
}

export function ratFnSub<T>(a: RatFn<T>, b: RatFn<T>, R: Field<T>): RatFn<T> {
  return makeRatFn(
    polySub(polyMul(a.num, b.den, R), polyMul(b.num, a.den, R), R),
    polyMul(a.den, b.den, R),
    R
  );
}

export function ratFnMul<T>(a: RatFn<T>, b: RatFn<T>, R: Field<T>): RatFn<T> {
  return makeRatFn(polyMul(a.num, b.num, R), polyMul(a.den, b.den, R), R);
}

export function ratFnDiv<T>(a: RatFn<T>, b: RatFn<T>, R: Field<T>): RatFn<T> {
  if (polyIsZero(b.num)) throw new Error("ratFnDiv: division by zero");
  return makeRatFn(polyMul(a.num, b.den, R), polyMul(a.den, b.num, R), R);
}

export function ratFnNeg<T>(a: RatFn<T>, R: Field<T>): RatFn<T> {
  return { num: polyNeg(a.num, R), den: a.den };
}

export function ratFnPow<T>(a: RatFn<T>, n: number, R: Field<T>): RatFn<T> {
  if (!Number.isInteger(n)) throw new Error("ratFnPow: non-integer exponent");
  if (n === 0) return ratFnOne(R);
  if (n < 0) {
    if (polyIsZero(a.num)) throw new Error("ratFnPow: zero to negative power");
    return ratFnPow(makeRatFn(a.den, a.num, R), -n, R);
  }
  let result: RatFn<T> = ratFnOne(R);
  let base = a;
  let e = n;
  while (e > 0) {
    if ((e & 1) === 1) result = ratFnMul(result, base, R);
    e >>>= 1;
    if (e > 0) base = ratFnMul(base, base, R);
  }
  return result;
}

// a/b = c/d  iff  a*d - c*b = 0  in Poly<T> (an integral domain when
// T is a field).
export function ratFnEq<T>(a: RatFn<T>, b: RatFn<T>, R: Field<T>): boolean {
  return polyIsZero(polySub(polyMul(a.num, b.den, R), polyMul(b.num, a.den, R), R));
}

export function ratFnIsZero<T>(a: RatFn<T>): boolean {
  return polyIsZero(a.num);
}

export function ratFnIsConst<T>(a: RatFn<T>, R: Field<T>): boolean {
  return polyIsOne(a.den, R) && a.num.terms.length <= 1 && (a.num.terms[0]?.exp.length ?? 0) === 0;
}

// Structural equality on the (already sign-normalised) representation.
// Two RatFns produced by the same construction yield the same
// canonical form; two RatFns that differ only by a polynomial GCD
// reduction do NOT — use `ratFnEq` for that.
export function ratFnStructuralEq<T>(a: RatFn<T>, b: RatFn<T>, R: Field<T>): boolean {
  return polyEq(a.num, b.num, R) && polyEq(a.den, b.den, R);
}

// -----------------------------------------------------------------------------
// Q-specific exports for backward compatibility and ergonomic use
// -----------------------------------------------------------------------------
//
// The Q case is so common that we keep the Q-bound `RATFN_ZERO` and
// `RATFN_ONE` constants, plus a Q-specific `makeRatFnQ` that auto-
// passes the Q sign-normalisation. These are convenience exports;
// internally they thread RAT_RING through the generic functions
// above.

import { RAT_RING } from "./rat.js";

export const RATFN_ZERO: RatFn<Rat> = ratFnZero(RAT_RING);
export const RATFN_ONE: RatFn<Rat> = ratFnOne(RAT_RING);

export function makeRatFnQ(num: Poly<Rat>, den: Poly<Rat>): RatFn<Rat> {
  return makeRatFn(num, den, RAT_RING, { signNormalise: Q_SIGN_NORMALISE });
}
