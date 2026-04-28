// Rational scalars over Q, kept in lowest terms with positive denominator.
// All operations preserve the invariant.

export interface Rat {
  readonly n: bigint;
  readonly d: bigint;
}

function gcdBigInt(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) {
    const t = x % y;
    x = y;
    y = t;
  }
  return x;
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
