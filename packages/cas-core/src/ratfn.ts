// Rational function = num / den, with sign-normalised denominator
// (leading coef of den positive). Equality decided by cross-multiplication
// over Q[x_1,...,x_n] — no GCD required (PRD §9.3).

import {
  type Poly,
  POLY_ONE,
  POLY_ZERO,
  polyAdd,
  polyEq,
  polyIsOne,
  polyIsZero,
  polyLeadingCoef,
  polyMul,
  polyNeg,
  polySub,
} from "./poly.js";
import { type Rat, ratIsNegative } from "./rat.js";

export interface RatFn {
  readonly num: Poly;
  readonly den: Poly;
}

export function makeRatFn(num: Poly, den: Poly): RatFn {
  if (polyIsZero(den)) throw new Error("ratFn: zero denominator");
  if (polyIsZero(num)) return RATFN_ZERO;
  const lc: Rat = polyLeadingCoef(den);
  if (ratIsNegative(lc)) {
    return { num: polyNeg(num), den: polyNeg(den) };
  }
  return { num, den };
}

export const RATFN_ZERO: RatFn = { num: POLY_ZERO, den: POLY_ONE };
export const RATFN_ONE: RatFn = { num: POLY_ONE, den: POLY_ONE };

export function ratFnFromPoly(p: Poly): RatFn {
  return makeRatFn(p, POLY_ONE);
}

export function ratFnAdd(a: RatFn, b: RatFn): RatFn {
  return makeRatFn(polyAdd(polyMul(a.num, b.den), polyMul(b.num, a.den)), polyMul(a.den, b.den));
}

export function ratFnSub(a: RatFn, b: RatFn): RatFn {
  return makeRatFn(polySub(polyMul(a.num, b.den), polyMul(b.num, a.den)), polyMul(a.den, b.den));
}

export function ratFnMul(a: RatFn, b: RatFn): RatFn {
  return makeRatFn(polyMul(a.num, b.num), polyMul(a.den, b.den));
}

export function ratFnDiv(a: RatFn, b: RatFn): RatFn {
  if (polyIsZero(b.num)) throw new Error("ratFnDiv: division by zero");
  return makeRatFn(polyMul(a.num, b.den), polyMul(a.den, b.num));
}

export function ratFnNeg(a: RatFn): RatFn {
  return { num: polyNeg(a.num), den: a.den };
}

export function ratFnPow(a: RatFn, n: number): RatFn {
  if (!Number.isInteger(n)) throw new Error("ratFnPow: non-integer exponent");
  if (n === 0) return RATFN_ONE;
  if (n < 0) {
    if (polyIsZero(a.num)) throw new Error("ratFnPow: zero to negative power");
    return ratFnPow(makeRatFn(a.den, a.num), -n);
  }
  let result = RATFN_ONE;
  let base = a;
  let e = n;
  while (e > 0) {
    if ((e & 1) === 1) result = ratFnMul(result, base);
    e >>>= 1;
    if (e > 0) base = ratFnMul(base, base);
  }
  return result;
}

// a/b = c/d  iff  a*d - c*b = 0  in Q[x_1,...,x_n] (an integral domain).
export function ratFnEq(a: RatFn, b: RatFn): boolean {
  return polyIsZero(polySub(polyMul(a.num, b.den), polyMul(b.num, a.den)));
}

export function ratFnIsZero(a: RatFn): boolean {
  return polyIsZero(a.num);
}

export function ratFnIsConst(a: RatFn): boolean {
  return polyIsOne(a.den) && a.num.terms.length <= 1 && (a.num.terms[0]?.exp.length ?? 0) === 0;
}

// Structural equality on the (already sign-normalised) representation.
// Two RatFns produced by the same construction yield the same canonical form;
// two RatFns that differ only by a polynomial GCD do NOT — use ratFnEq for that.
export function ratFnStructuralEq(a: RatFn, b: RatFn): boolean {
  return polyEq(a.num, b.num) && polyEq(a.den, b.den);
}
