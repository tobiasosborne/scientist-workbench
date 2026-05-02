// Rational scalars over Q, kept in lowest terms with positive denominator.
// All operations preserve the invariant.
//
// Q is the v0.1 instance of the Ring/Field abstraction in `ring.ts`. The
// `RAT_RING: Field<Rat>` export at the bottom of this file makes Q usable
// with the ring-generic Poly / RatFn machinery from `poly.ts` /
// `ratfn.ts`. (Pre-ADR-0008, those modules called `ratAdd` etc. directly;
// post-refactor, they call `R.add(a, b)` with `R = RAT_RING` for the Q
// case.)

import { gcdBigInt } from "@workbench/protocol";
import { type Field } from "./ring.js";

export interface Rat {
  readonly n: bigint;
  readonly d: bigint;
}

export function makeRat(n: bigint, d: bigint = 1n): Rat {
  if (d === 0n) throw new Error("rat: zero denominator");
  let nn = n;
  let dd = d;
  if (dd < 0n) {
    nn = -nn;
    dd = -dd;
  }
  if (nn === 0n) return RAT_ZERO;
  const g = gcdBigInt(nn, dd);
  return { n: nn / g, d: dd / g };
}

export const RAT_ZERO: Rat = { n: 0n, d: 1n };
export const RAT_ONE: Rat = { n: 1n, d: 1n };
export const RAT_NEG_ONE: Rat = { n: -1n, d: 1n };

export const ratAdd = (a: Rat, b: Rat): Rat => makeRat(a.n * b.d + b.n * a.d, a.d * b.d);
export const ratSub = (a: Rat, b: Rat): Rat => makeRat(a.n * b.d - b.n * a.d, a.d * b.d);
export const ratMul = (a: Rat, b: Rat): Rat => makeRat(a.n * b.n, a.d * b.d);
export const ratNeg = (a: Rat): Rat => ({ n: -a.n, d: a.d });
export const ratEq = (a: Rat, b: Rat): boolean => a.n === b.n && a.d === b.d;
export const ratIsZero = (a: Rat): boolean => a.n === 0n;
export const ratIsOne = (a: Rat): boolean => a.n === 1n && a.d === 1n;
export const ratIsNegOne = (a: Rat): boolean => a.n === -1n && a.d === 1n;
export const ratIsNegative = (a: Rat): boolean => a.n < 0n;

export function ratDiv(a: Rat, b: Rat): Rat {
  if (b.n === 0n) throw new Error("rat: division by zero");
  return makeRat(a.n * b.d, a.d * b.n);
}

export function ratInv(a: Rat): Rat {
  if (a.n === 0n) throw new Error("rat: inverse of zero");
  return makeRat(a.d, a.n);
}

// -----------------------------------------------------------------------------
// RAT_RING — Q as the v0.1 instance of Field<Rat>
// -----------------------------------------------------------------------------
//
// The functions above stay as direct exports for callers that already
// hold `Rat` values and want zero ceremony. RAT_RING bundles them into
// a Field<Rat> dictionary that ring-generic algorithms can consume:
//
//     polyAdd(a, b, RAT_RING)   // Q-coefficient polynomial addition
//
// Every existing internal call site in cas-core that previously used
// `ratAdd` directly threads RAT_RING through the polynomial layer
// instead. The Rat-as-element behaviour is identical; the abstraction
// is now first-class.

export const RAT_RING: Field<Rat> = {
  zero: RAT_ZERO,
  one: RAT_ONE,
  add: ratAdd,
  sub: ratSub,
  mul: ratMul,
  neg: ratNeg,
  eq: ratEq,
  isZero: ratIsZero,
  isOne: ratIsOne,
  fromInt: (n: bigint) => makeRat(n, 1n),
  inv: ratInv,
  div: ratDiv,
};
