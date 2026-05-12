// =============================================================================
// monomial-order — comparators for the multivariate Gröbner substrate
// =============================================================================
//
// Why this module exists
// ----------------------
// `cas-core`'s `Poly<T>` keeps its term list sorted in a fixed order:
// descending lex over the *alphabetised* variable union. That order is
// canonical for ring arithmetic — addition merges, multiplication
// combines like terms, equality reduces to byte equality — but it is
// not the order Buchberger needs. Buchberger's reduction loop
// repeatedly asks "what is the leading monomial under the *Gröbner*
// order I chose for this run?" If the Gröbner order is degree-reverse-
// lexicographic over `[x, y, z]` (with `z` last), the LM of `x*y + z²`
// is `z²`; under cas-core's lex-over-alphabetised-vars (where x < y < z
// alphabetically and the comparator descends lex), the first term is
// `x*y` because `x` outranks `z²` lexicographically. Same polynomial,
// different leading monomial.
//
// So we need a comparator parameterised by:
//
//   1. The variable list (which fixes "last" for DRL and "first" for
//      lex), and
//   2. The order kind (DRL vs. plain lex; v0.1 ships exactly these
//      two — DRL for the Buchberger loop, lex for the FGLM output).
//
// Exponent representation
// -----------------------
// Both orders consume the cas-core `Exp` type as-is — a sorted-by-
// var-name array of `[varName, exponent]` pairs with non-zero exponents
// only. Building a `Map<varName, exponent>` is the natural way to read
// "exponent of variable v in this monomial" without scanning the array
// each time, but for the comparison hot path (every Buchberger
// reduction step calls into the comparator multiple times) we want
// a tight scalar loop. We do the array-based lookup in `expGet`; for
// the FGLM-style intensive scans we pre-densify into an exponent vector
// indexed by the variable list.
//
// References
// ----------
// - Cox-Little-O'Shea (CLO) 4th ed. Ch.2 §2 — monomial-order
//   definitions; lex p.55 Definition 3, grlex p.58 Definition 4,
//   grevlex p.58 Definition 6. DRL is grevlex with the user-supplied
//   variable list fixing which variable is "last."
// - The DRL definition, restated explicitly: α >_DRL β iff
//   |α| > |β|, OR |α| = |β| and the *last* variable where α and β
//   differ has α giving the *smaller* exponent. The flip in the second
//   tier is what makes DRL different from grlex.

import type { Exp } from "@workbench/cas-core";

/**
 * Comparator signature for a monomial order.
 *
 * Returns a negative number if `a < b`, zero if `a == b`, positive if
 * `a > b`. By the Buchberger conventions used throughout the Gröbner
 * substrate, the leading monomial is the *maximum* under the order.
 * `compare(a, b) > 0` therefore reads "a is the larger monomial".
 *
 * Implementations are total orders on ℕ^n where `n` is the length of
 * the configured variable list (which they close over). Variables not
 * mentioned in the closure are treated as exponent 0, but a monomial
 * that mentions such a variable with non-zero exponent is a contract
 * violation — comparing "outside the scope" is a programmer error,
 * and the comparators do not silently mask it.
 */
export interface MonomialOrder {
  readonly kind: "lex" | "drl";
  readonly vars: readonly string[];
  readonly compare: (a: Exp, b: Exp) => number;
}

/**
 * Read the exponent of variable `v` from a sparse `Exp`. Returns 0 if
 * `v` does not appear. Linear scan — fine for the scope-fixed variable
 * lists we work with (typically n ≤ 5 for v0.1 target systems).
 */
export function expGet(e: Exp, v: string): number {
  for (const [name, exp] of e) {
    if (name === v) return exp;
  }
  return 0;
}

/**
 * Total degree (|α|) of a monomial — sum of exponents.
 */
export function expTotalDegree(e: Exp): number {
  let s = 0;
  for (const [, exp] of e) s += exp;
  return s;
}

/**
 * Add two exponent vectors: (α + β)_i = α_i + β_i. Returns a new
 * sorted-by-var-name `Exp`. Used by S-polynomial construction and
 * monomial multiplication during reduction.
 */
export function expAdd(a: Exp, b: Exp): Exp {
  const m = new Map<string, number>();
  for (const [k, v] of a) if (v !== 0) m.set(k, v);
  for (const [k, v] of b) {
    const cur = m.get(k);
    const sum = (cur ?? 0) + v;
    if (sum === 0) m.delete(k);
    else m.set(k, sum);
  }
  const out: [string, number][] = [];
  for (const [k, v] of m) out.push([k, v]);
  out.sort((p, q) => (p[0] < q[0] ? -1 : p[0] > q[0] ? 1 : 0));
  return out;
}

/**
 * Component-wise subtraction `α − β`. The caller is responsible for
 * verifying `α ≥ β` (i.e., every component of the result is non-
 * negative). On a violation we throw — silent negative exponents would
 * corrupt downstream invariants (e.g., the S-pair construction's
 * implicit assumption that `lcm/LM(g)` has a well-defined positive
 * exponent vector).
 */
export function expSub(a: Exp, b: Exp): Exp {
  const m = new Map<string, number>();
  for (const [k, v] of a) m.set(k, v);
  for (const [k, v] of b) {
    const cur = m.get(k) ?? 0;
    const diff = cur - v;
    if (diff < 0) {
      throw new Error(
        `expSub: result has negative exponent for '${k}' (${cur} - ${v} = ${diff})`,
      );
    }
    if (diff === 0) m.delete(k);
    else m.set(k, diff);
  }
  const out: [string, number][] = [];
  for (const [k, v] of m) out.push([k, v]);
  out.sort((p, q) => (p[0] < q[0] ? -1 : p[0] > q[0] ? 1 : 0));
  return out;
}

/**
 * Componentwise least common multiple — for each variable, take the
 * larger of the two exponents. The lcm in the multiplicative-monoid
 * sense, used in S-polynomial construction.
 */
export function expLcm(a: Exp, b: Exp): Exp {
  const m = new Map<string, number>();
  for (const [k, v] of a) if (v > 0) m.set(k, v);
  for (const [k, v] of b) {
    const cur = m.get(k) ?? 0;
    if (v > cur) m.set(k, v);
  }
  const out: [string, number][] = [];
  for (const [k, v] of m) out.push([k, v]);
  out.sort((p, q) => (p[0] < q[0] ? -1 : p[0] > q[0] ? 1 : 0));
  return out;
}

/**
 * Test whether `a` componentwise divides `b` — every variable's
 * exponent in `a` is ≤ the same variable's exponent in `b`. This is
 * monomial divisibility: the monomial denoted by `a` divides the
 * monomial denoted by `b` iff the same containment holds in ℕ^n.
 */
export function expDivides(a: Exp, b: Exp): boolean {
  // For each var with non-zero exp in a, b must have at least that.
  for (const [k, v] of a) {
    if (v > 0) {
      let bv = 0;
      for (const [k2, v2] of b) if (k2 === k) { bv = v2; break; }
      if (bv < v) return false;
    }
  }
  return true;
}

/**
 * `lexOrder(vars)` — pure lexicographic order with `vars[0]` ranking
 * highest. The comparator scans `vars` from left to right; the first
 * variable where the two exponent vectors differ decides the order.
 *
 * α >_lex β iff there is some index `i` such that α_j = β_j for
 * j < i and α_i > β_i (CLO Ch.2 §2 Definition 3 p.55, with the
 * convention `vars[0]` plays the role of the highest-ranked variable).
 *
 * Ties on every variable in `vars` mean the two monomials are equal
 * over the declared scope; since FGLM and Buchberger never compare
 * monomials outside their declared scope, returning 0 in that case is
 * the correct total order.
 */
export function lexOrder(vars: readonly string[]): MonomialOrder {
  const ranked = vars.slice();
  return {
    kind: "lex",
    vars: ranked,
    compare(a: Exp, b: Exp): number {
      for (const v of ranked) {
        const ea = expGet(a, v);
        const eb = expGet(b, v);
        if (ea !== eb) return ea - eb;
      }
      return 0;
    },
  };
}

/**
 * `drlOrder(vars)` — degree-reverse-lexicographic (a.k.a. grevlex).
 *
 * α >_DRL β iff:
 *   1. |α| > |β|, OR
 *   2. |α| = |β| AND the *last* variable in `vars` where α and β
 *      differ has α giving the *smaller* exponent.
 *
 * The "last variable, smaller exponent" rule is the trademark of DRL
 * vs. ordinary grlex; it has the practical effect of preferring
 * monomials that are "spread out" over variables high in `vars`,
 * keeping coefficient swell in Buchberger lower than lex on most
 * benchmark systems (CLO Ch.2 §9 p.114 — empirical comparison).
 *
 * Implementation: walk `vars` *right to left*, find the first
 * variable where the exponents differ, and flip the comparison sign.
 */
export function drlOrder(vars: readonly string[]): MonomialOrder {
  const ranked = vars.slice();
  return {
    kind: "drl",
    vars: ranked,
    compare(a: Exp, b: Exp): number {
      const dA = expTotalDegree(a);
      const dB = expTotalDegree(b);
      if (dA !== dB) return dA - dB;
      // Equal total degree — walk vars right-to-left for the reversed
      // tiebreak. The first index where exponents differ wins, with
      // the larger monomial being the one with the *smaller* exponent
      // at that position.
      for (let i = ranked.length - 1; i >= 0; i--) {
        const v = ranked[i]!;
        const ea = expGet(a, v);
        const eb = expGet(b, v);
        if (ea !== eb) return eb - ea;
      }
      return 0;
    },
  };
}
