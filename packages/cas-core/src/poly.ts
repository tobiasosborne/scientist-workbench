// Multivariate sparse polynomial over Q in named indeterminates.
// A monomial is a (variable → exponent) map plus a rational coefficient.
// A polynomial is a sorted list of monomials; canonical form has:
//   - every coefficient nonzero;
//   - no two monomials with the same exponent vector;
//   - terms sorted in descending lex order over the alphabetically-sorted variable union.

import {
  type Rat,
  RAT_ONE,
  RAT_ZERO,
  ratAdd,
  ratEq,
  ratIsZero,
  ratMul,
  ratNeg,
} from "./rat.js";

export type Exp = ReadonlyArray<readonly [string, number]>;

export interface Monomial {
  readonly exp: Exp;
  readonly coef: Rat;
}

export interface Poly {
  readonly terms: readonly Monomial[];
}

export const POLY_ZERO: Poly = { terms: [] };
export const POLY_ONE: Poly = { terms: [{ exp: [], coef: RAT_ONE }] };

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

function combine(terms: Map<string, Monomial>): Poly {
  const arr: Monomial[] = [];
  for (const t of terms.values()) {
    if (!ratIsZero(t.coef)) arr.push(t);
  }
  arr.sort((a, b) => compareExp(a.exp, b.exp));
  return { terms: arr };
}

export function polyAdd(a: Poly, b: Poly): Poly {
  const m = new Map<string, Monomial>();
  for (const t of a.terms) m.set(expKey(t.exp), t);
  for (const t of b.terms) {
    const k = expKey(t.exp);
    const existing = m.get(k);
    if (existing) {
      const sum = ratAdd(existing.coef, t.coef);
      if (ratIsZero(sum)) m.delete(k);
      else m.set(k, { exp: existing.exp, coef: sum });
    } else {
      m.set(k, t);
    }
  }
  return combine(m);
}

export function polyNeg(a: Poly): Poly {
  return { terms: a.terms.map((t) => ({ exp: t.exp, coef: ratNeg(t.coef) })) };
}

export function polySub(a: Poly, b: Poly): Poly {
  return polyAdd(a, polyNeg(b));
}

export function polyMul(a: Poly, b: Poly): Poly {
  const m = new Map<string, Monomial>();
  for (const ta of a.terms) {
    for (const tb of b.terms) {
      const exp = expAdd(ta.exp, tb.exp);
      const coef = ratMul(ta.coef, tb.coef);
      if (ratIsZero(coef)) continue;
      const k = expKey(exp);
      const existing = m.get(k);
      if (existing) {
        const sum = ratAdd(existing.coef, coef);
        if (ratIsZero(sum)) m.delete(k);
        else m.set(k, { exp, coef: sum });
      } else {
        m.set(k, { exp, coef });
      }
    }
  }
  return combine(m);
}

export function polyPow(a: Poly, n: number): Poly {
  if (!Number.isInteger(n)) throw new Error("polyPow: non-integer exponent");
  if (n < 0) throw new Error("polyPow: negative exponent");
  if (n === 0) return POLY_ONE;
  if (polyIsZero(a)) return POLY_ZERO;
  let result = POLY_ONE;
  let base = a;
  let e = n;
  while (e > 0) {
    if ((e & 1) === 1) result = polyMul(result, base);
    e >>>= 1;
    if (e > 0) base = polyMul(base, base);
  }
  return result;
}

export function polyEq(a: Poly, b: Poly): boolean {
  if (a.terms.length !== b.terms.length) return false;
  for (let i = 0; i < a.terms.length; i++) {
    const ta = a.terms[i]!;
    const tb = b.terms[i]!;
    if (!ratEq(ta.coef, tb.coef)) return false;
    if (!expEq(ta.exp, tb.exp)) return false;
  }
  return true;
}

export function polyIsZero(a: Poly): boolean {
  return a.terms.length === 0;
}

export function polyIsOne(a: Poly): boolean {
  return (
    a.terms.length === 1 &&
    a.terms[0]!.exp.length === 0 &&
    ratEq(a.terms[0]!.coef, RAT_ONE)
  );
}

export function polyIsConst(a: Poly): boolean {
  return polyIsZero(a) || (a.terms.length === 1 && a.terms[0]!.exp.length === 0);
}

export function polyConstValue(a: Poly): Rat | null {
  if (polyIsZero(a)) return RAT_ZERO;
  if (a.terms.length === 1 && a.terms[0]!.exp.length === 0) return a.terms[0]!.coef;
  return null;
}

export function polyConst(c: Rat): Poly {
  if (ratIsZero(c)) return POLY_ZERO;
  return { terms: [{ exp: [], coef: c }] };
}

export function polyVar(name: string): Poly {
  return { terms: [{ exp: [[name, 1]], coef: RAT_ONE }] };
}

export function polyLeadingCoef(a: Poly): Rat {
  if (polyIsZero(a)) return RAT_ZERO;
  return a.terms[0]!.coef;
}
