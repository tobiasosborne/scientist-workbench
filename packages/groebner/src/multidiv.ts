// =============================================================================
// multidiv — multivariate polynomial division under a supplied monomial order
// =============================================================================
//
// Why this module exists
// ----------------------
// `cas-core`'s `polyDivRemMonic` is *univariate* in design: it takes a
// principal variable `v` and treats the dividend and divisor as
// polynomials in `v` whose coefficients live in the polynomial ring of
// the other variables. That is the right substrate for Hensel lift and
// the Berlekamp factorisation pipeline. It is the wrong substrate for
// Buchberger reduction, which needs to ask:
//
//   "Given a polynomial `f` and a list of polynomials `G = [g_1, …,
//    g_s]`, compute the canonical normal form `r = f mod G` where
//    every monomial of `r` is *not* divisible by any LM(g_i) under
//    the supplied monomial order."
//
// This is multivariate polynomial division — the algorithm in CLO
// Ch.2 §3 Theorem 3 (p.64). The output is the unique remainder for
// the given `(G, order)` pair (note that the *quotients* depend on the
// order in which divisors are tried, but the remainder under reduced
// GB conditions is unique — that's the Gröbner basis property).
//
// The algorithm
// -------------
// Initialise `q_i := 0` for each divisor, `r := 0`, `p := f`.
// While `p ≠ 0`:
//   1. Find the leading term of `p` under `order`.
//   2. For each i (in caller-supplied order of `G`), test whether
//      `LM(g_i)` divides `LM(p)`. On the first match:
//        a. let `t = LT(p) / LT(g_i)` (the monomial-coefficient ratio).
//        b. accumulate `q_i += t`.
//        c. `p := p - t * g_i`.
//        d. continue the outer loop.
//   3. If no divisor's LM divides LM(p), move LT(p) to the remainder:
//        r := r + LT(p); p := p - LT(p).
// Return `(quotients, remainder)`.
//
// The remainder is *unique* under the supplied order when `G` is a
// Gröbner basis; otherwise the remainder may depend on the order in
// which the divisors are tried, even if all leading-term tests succeed.
// (CLO Ch.2 §3 Example 4 — same `f`, same `G`, divisor order swapped;
// quotient changes; remainder also changes if `G` is not GB.) This is
// why the Buchberger main loop runs a "remainder mod current basis"
// reduction at every iteration: it doesn't matter that the basis isn't
// a GB *yet* — what matters is that we get *some* deterministic
// remainder to feed back as a new basis element if non-zero.
//
// References
// ----------
// - CLO 4th ed. Ch.2 §3 Theorem 3 p.64 — division algorithm.
// - CLO 4th ed. Ch.2 §3 Example 4 p.65-66 — non-uniqueness without GB.
// - Buchberger 1979 §2 — the same algorithm in the original 1965
//   formulation.

import {
  type Poly,
  type Rat,
  type Monomial,
  RAT_RING,
  polyAdd,
  polyConst,
  polyIsZero,
  polyNeg,
  ratIsZero,
} from "@workbench/cas-core";
import { makeRat, ratDiv, ratMul } from "@workbench/cas-core";

import {
  type MonomialOrder,
  expAdd,
  expDivides,
  expSub,
} from "./monomial-order.js";

/**
 * Find the leading monomial of `p` under `order`. Returns `null` for
 * the zero polynomial. The caller should never be calling this on a
 * zero polynomial during Buchberger — every reduction tests
 * `polyIsZero(p)` first — but the null return keeps the contract
 * defensible.
 *
 * Implementation: linear scan. cas-core's term-list canonical form is
 * fixed lex-over-alphabetised-vars, *not* the user-supplied order, so
 * `terms[0]` is *not* the leading term under arbitrary `order`.
 * Materially this is the difference between "Gröbner basis under
 * grevlex with vars=[x, y, z]" and "Gröbner basis under whatever lex
 * cas-core stored" — the bench would hand back a wrong basis for
 * grevlex requests if we relied on `terms[0]`.
 */
export function leadingTerm(
  p: Poly<Rat>,
  order: MonomialOrder,
): Monomial<Rat> | null {
  if (polyIsZero(p)) return null;
  let best: Monomial<Rat> = p.terms[0]!;
  for (let i = 1; i < p.terms.length; i++) {
    const t = p.terms[i]!;
    if (order.compare(t.exp, best.exp) > 0) best = t;
  }
  return best;
}

/**
 * Leading coefficient — the rational scalar of the leading term, or
 * `RAT_ZERO` for the zero polynomial. Convenience over `leadingTerm`.
 */
export function leadingCoef(
  p: Poly<Rat>,
  order: MonomialOrder,
): Rat {
  const lt = leadingTerm(p, order);
  if (lt === null) return makeRat(0n, 1n);
  return lt.coef;
}

/**
 * Build a polynomial consisting of a single monomial: scalar `coef`
 * times the monomial `exp`. Returns the zero polynomial when `coef`
 * is zero (canonical-form invariant).
 */
export function monomialAsPoly(
  coef: Rat,
  exp: readonly (readonly [string, number])[],
): Poly<Rat> {
  if (ratIsZero(coef)) return polyConst<Rat>(makeRat(0n, 1n), RAT_RING);
  return { terms: [{ exp, coef }] };
}

/**
 * Multiply `p` by the monomial `coef · exp` term-by-term. Avoids the
 * full `polyMul` overhead (no like-term combination across multiple
 * factor terms) — single-monomial multiplication is just exponent
 * addition and coefficient multiplication on each input term.
 */
export function polyMulMonomial(
  p: Poly<Rat>,
  coef: Rat,
  exp: readonly (readonly [string, number])[],
): Poly<Rat> {
  if (ratIsZero(coef) || polyIsZero(p)) {
    return polyConst<Rat>(makeRat(0n, 1n), RAT_RING);
  }
  const newTerms = p.terms.map<Monomial<Rat>>((t) => ({
    exp: expAdd(t.exp, exp),
    coef: ratMul(t.coef, coef),
  }));
  // expAdd produces a freshly-sorted Exp; coefficients stay non-zero
  // because both factors are non-zero. Canonical-form invariant of
  // Poly<Rat> is preserved iff the result has no duplicate exp keys —
  // and it can't, because we did not change the *relative* term order
  // (we shifted every exp by the same `exp`, a monotone operation in
  // any monomial order, and the input had no duplicates).
  return { terms: newTerms };
}

/**
 * Result of multivariate polynomial division.
 *
 * `quotients[i]` is the polynomial `q_i` such that
 *   f = q_1 * g_1 + ... + q_s * g_s + r,
 * with `r = remainder` and every monomial of `r` not divisible by any
 * LM(g_i) under `order`. The `quotients` array has the same length and
 * order as the input divisor list.
 */
export interface MultiDivResult {
  readonly quotients: readonly Poly<Rat>[];
  readonly remainder: Poly<Rat>;
}

/**
 * Multivariate polynomial division of `f` by the list `divisors`
 * under `order`. Implements CLO Ch.2 §3 Theorem 3.
 *
 * Pre-conditions: every divisor is non-zero, the input polynomial is
 * a `Poly<Rat>` in canonical form. We don't validate these (the
 * Buchberger main loop guarantees them by construction); a defensive
 * check would slow the inner loop.
 *
 * Throws on a zero divisor (would otherwise loop forever or produce
 * a division-by-zero on the leading-coef quotient step). This is the
 * one defensive check we do keep.
 */
export function polyMultiDivRem(
  f: Poly<Rat>,
  divisors: readonly Poly<Rat>[],
  order: MonomialOrder,
): MultiDivResult {
  for (let i = 0; i < divisors.length; i++) {
    if (polyIsZero(divisors[i]!)) {
      throw new Error(`polyMultiDivRem: divisor #${i} is the zero polynomial`);
    }
  }

  const ZERO = polyConst<Rat>(makeRat(0n, 1n), RAT_RING);
  const quotients: Poly<Rat>[] = divisors.map(() => ZERO);
  let remainder: Poly<Rat> = ZERO;
  let working: Poly<Rat> = f;

  // Pre-compute leading terms of divisors — they don't change during
  // the loop. A cache shaves a constant factor off the divisibility
  // test, which dominates the inner loop on small systems.
  const divisorLT: Monomial<Rat>[] = divisors.map((g) => {
    const lt = leadingTerm(g, order);
    if (lt === null) {
      throw new Error("polyMultiDivRem: divisor is zero (caught after the explicit check?)");
    }
    return lt;
  });

  // Outer loop: repeatedly identify LT(working), try each divisor's
  // LM-divides-LM test, and either reduce or move-to-remainder.
  while (!polyIsZero(working)) {
    const ltW = leadingTerm(working, order);
    if (ltW === null) break; // unreachable given polyIsZero check
    let didReduce = false;
    for (let i = 0; i < divisors.length; i++) {
      const ltD = divisorLT[i]!;
      if (expDivides(ltD.exp, ltW.exp)) {
        // t := LT(working) / LT(divisor_i)  (monomial / monomial = monomial)
        const tCoef = ratDiv(ltW.coef, ltD.coef);
        const tExp = expSub(ltW.exp, ltD.exp);
        // q_i := q_i + t
        const tPoly = monomialAsPoly(tCoef, tExp);
        quotients[i] = polyAdd(quotients[i]!, tPoly, RAT_RING);
        // working := working - t * divisor_i
        const minusTimesD = polyNeg(polyMulMonomial(divisors[i]!, tCoef, tExp), RAT_RING);
        working = polyAdd(working, minusTimesD, RAT_RING);
        didReduce = true;
        break;
      }
    }
    if (!didReduce) {
      // No LM divides — move the leading term of `working` to the
      // remainder. The "leading term" here is exactly `ltW`; we built
      // it above.
      const ltPoly = monomialAsPoly(ltW.coef, ltW.exp);
      remainder = polyAdd(remainder, ltPoly, RAT_RING);
      const minusLT = polyNeg(ltPoly, RAT_RING);
      working = polyAdd(working, minusLT, RAT_RING);
    }
  }

  return { quotients, remainder };
}

/**
 * Convenience: full normal-form reduction. Same as
 * `polyMultiDivRem(f, divisors, order).remainder`, but skips
 * allocating the quotient list when the caller doesn't need it.
 *
 * Buchberger's main loop only consults `remainder`; the quotient
 * list is useful for ideal-membership certificates and for the
 * (debug-only) reconstruction `f = Σ q_i g_i + r`. Keeping a separate
 * entry point for the no-quotient path avoids an O(|G| · |f|) of
 * unnecessary allocations on the hot Buchberger path.
 */
export function polyNormalForm(
  f: Poly<Rat>,
  divisors: readonly Poly<Rat>[],
  order: MonomialOrder,
): Poly<Rat> {
  return polyMultiDivRem(f, divisors, order).remainder;
}
