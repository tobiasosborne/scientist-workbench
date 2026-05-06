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

// -----------------------------------------------------------------------------
// Variable-view helpers
// -----------------------------------------------------------------------------
//
// Polynomial GCD (ADR-0013) and any future algorithm that needs to treat
// a multivariate polynomial as univariate in some chosen variable —
// pseudo-division, content/primitive-part decomposition, Hermite
// reduction, partial-fraction decomposition — all need the same set
// of small operations: ask the degree in a variable, peel off the
// coefficient at each power of that variable (which is itself a
// polynomial in the *other* variables), rebuild the whole from such
// a decomposition.
//
// These functions are intentionally ring-aware (they take a `Ring<T>`
// for the coefficient operations), but they don't need a field — they
// don't divide. Treat them as the algebraic counterpart to `compareExp`
// + `expAdd`: low-level structural manipulation that any higher-level
// algorithm can layer on.

/**
 * Returns the set of distinct variable names that appear with non-zero
 * exponent anywhere in `a`, sorted alphabetically. The empty array
 * means `a` is constant (or zero).
 */
export function polyVars<T>(a: Poly<T>): string[] {
  const s = new Set<string>();
  for (const t of a.terms) {
    for (const [v] of t.exp) s.add(v);
  }
  return [...s].sort();
}

/**
 * Degree of `a` in the variable `v`. Returns 0 if `v` does not appear
 * (the polynomial is constant in `v`); returns `-1` for the zero
 * polynomial. The `-1` sentinel matches the convention `deg(0) = -∞`
 * collapsed onto an integer; callers must handle the zero case
 * specially anyway.
 */
export function polyDegInVar<T>(a: Poly<T>, v: string): number {
  if (polyIsZero(a)) return -1;
  let max = 0;
  for (const t of a.terms) {
    for (const [name, exp] of t.exp) {
      if (name === v && exp > max) max = exp;
    }
  }
  return max;
}

/**
 * View `a` as a univariate polynomial in `v` over the polynomial ring
 * of the other variables: returns `[c_0, c_1, ..., c_d]` where each
 * `c_i` is itself a `Poly<T>` (in the variables other than `v`) and
 * `a = c_0 + c_1 · v + c_2 · v² + ... + c_d · v^d`.
 *
 * The coefficient list always has length `polyDegInVar(a, v) + 1`
 * (or zero, for the zero polynomial). Trailing zeros are not trimmed;
 * if the actual coefficient at some power is zero, the corresponding
 * slot holds `polyZero`.
 */
export function polyCoeffsInVar<T>(a: Poly<T>, v: string, R: Ring<T>): Poly<T>[] {
  if (polyIsZero(a)) return [];
  const d = polyDegInVar(a, v);
  const out: Map<number, Monomial<T>[]> = new Map();
  for (let i = 0; i <= d; i++) out.set(i, []);
  for (const t of a.terms) {
    let powerOfV = 0;
    const restExp: [string, number][] = [];
    for (const [name, exp] of t.exp) {
      if (name === v) powerOfV = exp;
      else restExp.push([name, exp]);
    }
    out.get(powerOfV)!.push({ exp: restExp, coef: t.coef });
  }
  const result: Poly<T>[] = [];
  for (let i = 0; i <= d; i++) {
    const terms = out.get(i)!;
    // Each term has its variable list already missing `v`; its exp is
    // already sorted because the source `t.exp` was sorted and we
    // just deleted one entry. Coefficients are still non-zero
    // (canonical-form invariant of `a`).
    result.push({ terms });
  }
  return result;
}

/**
 * Inverse of `polyCoeffsInVar`: given coefficient polynomials
 * `[c_0, ..., c_d]` (each in variables other than `v`), build the
 * polynomial `c_0 + c_1 · v + ... + c_d · v^d`.
 *
 * Each `c_i` may be the zero polynomial; those terms contribute
 * nothing. The result is in canonical form (sorted, deduplicated, no
 * zero-coef terms).
 */
export function polyFromCoeffsInVar<T>(
  coeffs: readonly Poly<T>[],
  v: string,
  R: Ring<T>,
): Poly<T> {
  const m = new Map<string, Monomial<T>>();
  for (let i = 0; i < coeffs.length; i++) {
    const c = coeffs[i]!;
    if (polyIsZero(c)) continue;
    for (const t of c.terms) {
      // Splice `v^i` into the (already sorted) exponent list.
      const newExp: [string, number][] = [];
      let inserted = false;
      for (const [name, exp] of t.exp) {
        if (!inserted && name > v && i > 0) {
          newExp.push([v, i]);
          inserted = true;
        }
        newExp.push([name, exp]);
      }
      if (!inserted && i > 0) newExp.push([v, i]);
      const key = JSON.stringify(newExp);
      const existing = m.get(key);
      if (existing) {
        const sum = R.add(existing.coef, t.coef);
        if (R.isZero(sum)) m.delete(key);
        else m.set(key, { exp: newExp, coef: sum });
      } else {
        m.set(key, { exp: newExp, coef: t.coef });
      }
    }
  }
  const arr = [...m.values()];
  arr.sort((a, b) => compareExp(a.exp, b.exp));
  return { terms: arr };
}

/**
 * Partial derivative `∂a/∂v`.
 *
 * For each term `c · m`, where `m` is a monomial in many variables and
 * `m = v^k · m'` (m' has no `v`), the derivative wrt `v` is
 * `k · c · v^(k-1) · m'`. Terms with no `v` (i.e. `k = 0`) drop out.
 *
 * The integer factor `k` is embedded into the coefficient ring via
 * `R.fromInt(BigInt(k))` — every commutative ring with unity admits this
 * embedding (`n ↦ n · 1`). `polyDeriv` therefore needs only a `Ring<T>`,
 * not a `Field<T>` — derivative is not a Euclidean operation.
 *
 * Used by Yun's square-free decomposition (`packages/poly-factor`) and
 * by future poly-aware substrate (e.g., Sturm sequences for real-root
 * isolation).
 */
export function polyDeriv<T>(a: Poly<T>, v: string, R: Ring<T>): Poly<T> {
  if (polyIsZero(a)) return polyZero<T>();
  const out: Monomial<T>[] = [];
  for (const t of a.terms) {
    let powerOfV = 0;
    let posV = -1;
    for (let i = 0; i < t.exp.length; i++) {
      if (t.exp[i]![0] === v) {
        powerOfV = t.exp[i]![1];
        posV = i;
        break;
      }
    }
    if (powerOfV === 0) continue;             // term has no `v`; derivative drops it
    const factor = R.fromInt(BigInt(powerOfV));
    const newCoef = R.mul(t.coef, factor);
    if (R.isZero(newCoef)) continue;          // characteristic-p collapse (irrelevant for Q but free)
    let newExp: [string, number][];
    if (powerOfV === 1) {
      // `v^1 → v^0`, drop the entry entirely.
      newExp = [];
      for (let i = 0; i < t.exp.length; i++) {
        if (i !== posV) newExp.push([t.exp[i]![0], t.exp[i]![1]]);
      }
    } else {
      // Decrement the exponent in place.
      newExp = t.exp.map(([n, e], i) =>
        i === posV ? [n, e - 1] as [string, number] : [n, e] as [string, number],
      );
    }
    out.push({ exp: newExp, coef: newCoef });
  }
  // `out` is built in input-term order; re-sort to keep the canonical
  // exponent ordering invariant. Duplicate keys do not arise (the
  // input had no duplicates and we only decremented one exponent
  // monotonically).
  out.sort((a, b) => compareExp(a.exp, b.exp));
  return { terms: out };
}

// -----------------------------------------------------------------------------
// Univariate long division by a monic divisor
// -----------------------------------------------------------------------------
//
// `polyDivRemMonic(a, b, v, R)` — view `a` and `b` as univariate
// polynomials in `v` (their coefficients may live in the polynomial ring
// of the other variables) and divide with remainder. Returns `(q, r)`
// such that `a = q · b + r` with `deg_v(r) < deg_v(b)`.
//
// The constraint vs. the more general `polyDivExact` and `polyPseudoDivide`:
// `b` must be **monic in `v`** — `lc_v(b) = R.one`. Long division by a
// monic divisor needs no division at any step (each elimination
// subtracts `lead(working) · b · v^k`), so the substrate is `Ring<T>`,
// not `Field<T>`. This is the form the Hensel lift step needs:
// `dup_div(s · e, h)` over ℤ[x] where `h` is monic.
//
// Throws on `b = 0`, on `b` not monic in `v` (so callers can't
// silently get bad results), and on `deg_v(b) = 0` (a zero-degree
// monic divisor is trivial — the quotient is the input scaled by 1
// and `r = 0`; the function returns that exact result rather than
// throwing, so the caller's loop logic doesn't need a special case).

export function polyDivRemMonic<T>(
  a: Poly<T>,
  b: Poly<T>,
  v: string,
  R: Ring<T>,
): { q: Poly<T>; r: Poly<T> } {
  if (polyIsZero(b)) throw new Error("polyDivRemMonic: divisor is zero");
  const degB = polyDegInVar(b, v);
  if (degB < 0) throw new Error("polyDivRemMonic: divisor is zero");

  // Verify lc_v(b) = R.one.
  const bCoeffs = polyCoeffsInVar(b, v, R);
  const lcB = bCoeffs[degB]!;
  // `lcB` is itself a Poly<T> in the *other* variables; it must be the
  // constant polynomial `R.one`. For univariate `b`, this is the
  // single-monomial poly `{exp:[], coef:R.one}`.
  if (!polyIsOne(lcB, R)) {
    throw new Error("polyDivRemMonic: divisor is not monic in '" + v + "'");
  }

  if (degB === 0) {
    // Divisor is the constant 1 (since it's monic of degree 0). q = a, r = 0.
    return { q: a, r: polyZero<T>() };
  }

  if (polyIsZero(a)) {
    return { q: polyZero<T>(), r: polyZero<T>() };
  }
  const degA = polyDegInVar(a, v);
  if (degA < degB) {
    return { q: polyZero<T>(), r: a };
  }

  const aCoeffs = polyCoeffsInVar(a, v, R);
  const working: Poly<T>[] = aCoeffs.slice();
  while (working.length < degA + 1) working.push(polyZero<T>());

  const qCoeffs: Poly<T>[] = new Array(degA - degB + 1).fill(polyZero<T>());

  for (let i = degA - degB; i >= 0; i--) {
    const lead = working[degB + i]!;
    if (polyIsZero(lead)) {
      qCoeffs[i] = polyZero<T>();
      continue;
    }
    // Monic divisor → no division required at the elimination step.
    qCoeffs[i] = lead;
    for (let j = 0; j <= degB; j++) {
      working[i + j] = polySub(working[i + j]!, polyMul(lead, bCoeffs[j]!, R), R);
    }
  }

  const rCoeffs = working.slice(0, degB);
  return {
    q: polyFromCoeffsInVar(qCoeffs, v, R),
    r: polyFromCoeffsInVar(rCoeffs, v, R),
  };
}
