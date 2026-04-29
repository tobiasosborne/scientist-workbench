// =============================================================================
// poly — multivariate sparse polynomial over an arbitrary coefficient ring
// =============================================================================
//
// A monomial is a (variable → exponent) map plus a coefficient in some
// ring R. A polynomial is a sorted list of monomials; canonical form
// has:
//   - every coefficient nonzero (R.isZero(coef) === false);
//   - no two monomials with the same exponent vector;
//   - terms sorted in descending lex order over the alphabetically-
//     sorted variable union.
//
// Pre-ADR-0008 this module hardcoded `Rat` as the coefficient. Post-
// refactor it is generic in `T`, taking a `Ring<T>` parameter at every
// call site that needs to compute with coefficients. Q stays the v0.1
// instance via `RAT_RING` from `rat.ts`; new rings (algebraic numbers,
// finite fields) plug in by passing a different Ring<T> dictionary.
//
// Two design notes worth carrying:
//
//   • Constants behave differently. `polyZero` is universal: an empty
//     monomial list is `Poly<T>` for any T. `polyOne` needs `R.one`,
//     so it's a factory taking the ring. `POLY_ZERO` (typed
//     `Poly<never>`) is preserved as a constant for ergonomic call
//     sites; `POLY_ONE` (typed `Poly<Rat>`) likewise for the Q case.
//   • The exponent representation is unchanged. `Exp` is a sorted list
//     of `[varName, exponent]` pairs, always with non-zero exponents
//     and alphabetically-sorted variable names. Variables can have
//     any string name; canonical form sorts by variable name, then
//     compares exponents in that order.

import { type Ring } from "./ring.js";

export type Exp = ReadonlyArray<readonly [string, number]>;

export interface Monomial<T> {
  readonly exp: Exp;
  readonly coef: T;
}

export interface Poly<T> {
  readonly terms: readonly Monomial<T>[];
}

// `POLY_ZERO` is structurally polymorphic — an empty term list conforms
// to `Poly<T>` for any T because there are no coefficients to constrain.
// Typing it `Poly<never>` lets it be passed where any `Poly<T>` is
// expected via covariance of `readonly Monomial<T>[]`.
export const POLY_ZERO: Poly<never> = { terms: [] };

export function polyZero<T>(): Poly<T> {
  return POLY_ZERO;
}

export function polyOne<T>(R: Ring<T>): Poly<T> {
  return { terms: [{ exp: [], coef: R.one }] };
}

function expKey(e: Exp): string {
  return JSON.stringify(e);
}

function normExp(m: Map<string, number>): Exp {
  const out: [string, number][] = [];
  for (const [k, v] of m) if (v !== 0) out.push([k, v]);
  out.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return out;
}

function expToMap(e: Exp): Map<string, number> {
  const m = new Map<string, number>();
  for (const [k, v] of e) m.set(k, v);
  return m;
}

function expAdd(a: Exp, b: Exp): Exp {
  const m = expToMap(a);
  for (const [k, v] of b) m.set(k, (m.get(k) ?? 0) + v);
  return normExp(m);
}

function expVarsUnion(a: Exp, b: Exp): string[] {
  const s = new Set<string>();
  for (const [k] of a) s.add(k);
  for (const [k] of b) s.add(k);
  return [...s].sort();
}

export function compareExp(a: Exp, b: Exp): number {
  const vars = expVarsUnion(a, b);
  const ma = expToMap(a);
  const mb = expToMap(b);
  for (const v of vars) {
    const ea = ma.get(v) ?? 0;
    const eb = mb.get(v) ?? 0;
    if (ea !== eb) return eb - ea;
  }
  return 0;
}

function expEq(a: Exp, b: Exp): boolean {
  return expKey(a) === expKey(b);
}

function combine<T>(terms: Map<string, Monomial<T>>, R: Ring<T>): Poly<T> {
  const arr: Monomial<T>[] = [];
  for (const t of terms.values()) {
    if (!R.isZero(t.coef)) arr.push(t);
  }
  arr.sort((a, b) => compareExp(a.exp, b.exp));
  return { terms: arr };
}

export function polyAdd<T>(a: Poly<T>, b: Poly<T>, R: Ring<T>): Poly<T> {
  const m = new Map<string, Monomial<T>>();
  for (const t of a.terms) m.set(expKey(t.exp), t);
  for (const t of b.terms) {
    const k = expKey(t.exp);
    const existing = m.get(k);
    if (existing) {
      const sum = R.add(existing.coef, t.coef);
      if (R.isZero(sum)) m.delete(k);
      else m.set(k, { exp: existing.exp, coef: sum });
    } else {
      m.set(k, t);
    }
  }
  return combine(m, R);
}

export function polyNeg<T>(a: Poly<T>, R: Ring<T>): Poly<T> {
  return { terms: a.terms.map((t) => ({ exp: t.exp, coef: R.neg(t.coef) })) };
}

export function polySub<T>(a: Poly<T>, b: Poly<T>, R: Ring<T>): Poly<T> {
  return polyAdd(a, polyNeg(b, R), R);
}

export function polyMul<T>(a: Poly<T>, b: Poly<T>, R: Ring<T>): Poly<T> {
  const m = new Map<string, Monomial<T>>();
  for (const ta of a.terms) {
    for (const tb of b.terms) {
      const exp = expAdd(ta.exp, tb.exp);
      const coef = R.mul(ta.coef, tb.coef);
      if (R.isZero(coef)) continue;
      const k = expKey(exp);
      const existing = m.get(k);
      if (existing) {
        const sum = R.add(existing.coef, coef);
        if (R.isZero(sum)) m.delete(k);
        else m.set(k, { exp, coef: sum });
      } else {
        m.set(k, { exp, coef });
      }
    }
  }
  return combine(m, R);
}

export function polyPow<T>(a: Poly<T>, n: number, R: Ring<T>): Poly<T> {
  if (!Number.isInteger(n)) throw new Error("polyPow: non-integer exponent");
  if (n < 0) throw new Error("polyPow: negative exponent");
  if (n === 0) return polyOne(R);
  if (polyIsZero(a)) return POLY_ZERO;
  let result: Poly<T> = polyOne(R);
  let base = a;
  let e = n;
  while (e > 0) {
    if ((e & 1) === 1) result = polyMul(result, base, R);
    e >>>= 1;
    if (e > 0) base = polyMul(base, base, R);
  }
  return result;
}

export function polyEq<T>(a: Poly<T>, b: Poly<T>, R: Ring<T>): boolean {
  if (a.terms.length !== b.terms.length) return false;
  for (let i = 0; i < a.terms.length; i++) {
    const ta = a.terms[i]!;
    const tb = b.terms[i]!;
    if (!R.eq(ta.coef, tb.coef)) return false;
    if (!expEq(ta.exp, tb.exp)) return false;
  }
  return true;
}

// `polyIsZero` is purely structural — empty term list. Ring-free.
export function polyIsZero<T>(a: Poly<T>): boolean {
  return a.terms.length === 0;
}

export function polyIsOne<T>(a: Poly<T>, R: Ring<T>): boolean {
  return (
    a.terms.length === 1 &&
    a.terms[0]!.exp.length === 0 &&
    R.isOne(a.terms[0]!.coef)
  );
}

// Shape-only check: the polynomial is either zero or a single
// constant-degree term. Ring-free — the caller does not need to know
// which ring's elements are stored, only that the shape is "constant."
export function polyIsConst<T>(a: Poly<T>): boolean {
  return polyIsZero(a) || (a.terms.length === 1 && a.terms[0]!.exp.length === 0);
}

// Returns the constant value if the polynomial is constant, else null.
// For a zero polynomial, returns `R.zero`. (Without R, we'd have to
// return null on zero, which loses information at the call site; the
// Q version had the same behaviour and consumers relied on it.)
export function polyConstValue<T>(a: Poly<T>, R: Ring<T>): T | null {
  if (polyIsZero(a)) return R.zero;
  if (a.terms.length === 1 && a.terms[0]!.exp.length === 0) return a.terms[0]!.coef;
  return null;
}

export function polyConst<T>(c: T, R: Ring<T>): Poly<T> {
  if (R.isZero(c)) return POLY_ZERO;
  return { terms: [{ exp: [], coef: c }] };
}

export function polyVar<T>(name: string, R: Ring<T>): Poly<T> {
  return { terms: [{ exp: [[name, 1]], coef: R.one }] };
}

// Leading coefficient under the canonical descending lex order. For a
// zero polynomial returns `R.zero` (matching the Q version's behaviour
// where `RAT_ZERO` was returned).
export function polyLeadingCoef<T>(a: Poly<T>, R: Ring<T>): T {
  if (polyIsZero(a)) return R.zero;
  return a.terms[0]!.coef;
}
