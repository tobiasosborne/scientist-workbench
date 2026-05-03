// =============================================================================
// poly-gcd — multivariate polynomial GCD over a field
// =============================================================================
//
// ADR-0013. Given two polynomials a, b ∈ Field<T>[x_1, ..., x_n], compute
// their greatest common divisor as a polynomial in the same ring,
// normalised to be monic (leading coefficient under canonical lex order
// equal to R.one).
//
// The algorithm is the classical Brown–Collins subresultant PRS made
// recursive on variables. The shape:
//
//   1. If one of the inputs is zero, the GCD is the monic associate of
//      the other.
//   2. If both are constants (no variables), the GCD is `R.one` for
//      non-zero inputs (in a field, every non-zero is a unit).
//   3. Otherwise, pick the alphabetically-first variable `v` that
//      appears in either input. View both as univariate in `v` over
//      the integral domain `D = Field<T>[other vars]`.
//   4. Compute `contentA, contentB ∈ D` — the GCDs of the coefficient
//      polynomials when each input is viewed as univariate in `v`.
//      These calls recurse on (n−1) variables.
//   5. Divide each input by its content to get the primitive parts.
//   6. Run subresultant PRS on the primitive parts; the result is a
//      primitive polynomial in `v` over `D`.
//   7. The final GCD is `gcd(contentA, contentB) · primitiveGcd`,
//      made monic at the very top of the recursion.
//
// Subresultant PRS itself: a sequence F_1, F_2, F_3, ... of pseudo-
// remainders, each scaled by a `β_k` factor derived from the
// subresultant theorem so that intermediate coefficients stay
// bounded — polynomial-time in the input size, not exponential.
// References: Knuth TAOCP §4.6.1; Geddes/Czapor/Labahn ch. 7;
// Brown 1971 "On Euclid's Algorithm and the Computation of Polynomial
// Greatest Common Divisors."
//
// Why the substrate fits without new categories
// ---------------------------------------------
// `ring.ts` declares only `Ring<T>` and `Field<T>`. ADR-0013 commits to
// keeping it that way: the algorithm uses only field operations on T
// (add, sub, mul, neg, div, inv, eq, isZero, isOne, fromInt) and
// polynomial-ring operations on `Poly<T>`. There is no need for a
// separate `EuclideanDomain<T>` or `GcdDomain<T>` interface — the
// polynomial side handles UFD-shaped reasoning structurally.

import {
  type Exp,
  type Monomial,
  type Poly,
  POLY_ZERO,
  compareExp,
  polyAdd,
  polyCoeffsInVar,
  polyConst,
  polyConstValue,
  polyDegInVar,
  polyEq,
  polyFromCoeffsInVar,
  polyIsConst,
  polyIsZero,
  polyMul,
  polyNeg,
  polyOne,
  polyPow,
  polySub,
  polyVars,
  polyZero,
} from "./poly.js";
import { type Field, type Ring } from "./ring.js";

// -----------------------------------------------------------------------------
// Exact division
// -----------------------------------------------------------------------------
//
// `polyDivExact(a, b, R)` returns `q` such that `a = b · q` exactly.
// Throws if `b ∤ a`. Used internally by content extraction, by the
// subresultant β-division step, and externally by `ratFnReduce` (and
// any other consumer that wants to divide out a known-exact factor).
//
// Algorithm
// ---------
// If `b` is constant, every coefficient of `a` divides through by
// `b`'s constant value (a field element). Otherwise pick a variable
// of `b`, view `a` and `b` as univariate in that variable, do
// standard long division, and verify the remainder is zero. Each
// "leading-coefficient division" is itself a recursive `polyDivExact`
// in one fewer variable; the recursion bottoms out at the constant
// case.

export function polyDivExact<T>(a: Poly<T>, b: Poly<T>, R: Field<T>): Poly<T> {
  if (polyIsZero(b)) throw new Error("polyDivExact: division by zero");
  if (polyIsZero(a)) return polyZero<T>();

  // Constant divisor: pure coefficient-wise division.
  if (polyIsConst(b)) {
    const c = polyConstValue(b, R)!;
    if (R.isZero(c)) throw new Error("polyDivExact: division by zero");
    return {
      terms: a.terms.map((t) => ({ exp: t.exp, coef: R.div(t.coef, c) })),
    };
  }

  // Pick a main variable. Use the alphabetically-first variable of
  // `b`; that's deterministic and ensures we always make progress.
  const bVars = polyVars(b);
  const v = bVars[0]!;
  const degA = polyDegInVar(a, v);
  const degB = polyDegInVar(b, v);

  if (degA < degB) {
    // `a` has lower degree in `v` than `b`; division is impossible
    // unless `a` is zero (already handled). Either way, exact division
    // fails.
    throw new Error(
      `polyDivExact: dividend has degree ${degA} in '${v}', divisor has degree ${degB} — no exact quotient`,
    );
  }

  const aCoeffs = polyCoeffsInVar(a, v, R);
  const bCoeffs = polyCoeffsInVar(b, v, R);
  const lcB = bCoeffs[degB]!;

  // Working coefficient list, mutated in place. Length is degA + 1.
  // We pad with zeros up to the same length so the indexing math
  // below stays simple.
  const working: Poly<T>[] = aCoeffs.slice();
  while (working.length < degA + 1) working.push(polyZero<T>());

  const qCoeffs: Poly<T>[] = new Array(degA - degB + 1).fill(polyZero<T>());

  for (let i = degA - degB; i >= 0; i--) {
    const lead = working[degB + i]!;
    if (polyIsZero(lead)) {
      qCoeffs[i] = polyZero<T>();
      continue;
    }
    // Each leading-coefficient division is recursive — one fewer
    // variable, since `lead` and `lcB` are coefficients in `v` (so
    // their variable sets exclude `v`). The recursion's depth is
    // bounded by the variable count.
    const q = polyDivExact(lead, lcB, R);
    qCoeffs[i] = q;
    for (let j = 0; j <= degB; j++) {
      working[i + j] = polySub(working[i + j]!, polyMul(q, bCoeffs[j]!, R), R);
    }
  }

  // Verify the remainder is zero.
  for (let k = 0; k < degB; k++) {
    if (!polyIsZero(working[k]!)) {
      throw new Error(
        `polyDivExact: not exact — non-zero remainder at degree ${k} in '${v}'`,
      );
    }
  }

  return polyFromCoeffsInVar(qCoeffs, v, R);
}

// -----------------------------------------------------------------------------
// Pseudo-division
// -----------------------------------------------------------------------------
//
// View `a` and `b` as univariate polynomials in `v` with coefficients
// in the integral domain `D = Poly<T>[other vars]`. Returns `(q, r)`
// such that
//
//     lc_v(b)^{deg_v(a) − deg_v(b) + 1} · a  =  q · b + r,
//     deg_v(r) < deg_v(b).
//
// The point of pseudo-division is to do the "Euclidean" step over an
// integral domain that is *not* a field — the leading coefficient of
// `b` (an element of `D`) is not invertible, but a sufficiently high
// power of it is enough to drive long division to completion with
// every step's quotient still living in `D`.
//
// Used by the subresultant PRS loop. Not exported — the surface is
// `polyGcd` and `polyDivExact`; consumers should not need pseudo-
// division directly.

interface PseudoDivResult<T> {
  readonly q: Poly<T>;
  readonly r: Poly<T>;
}

function polyPseudoDivide<T>(
  a: Poly<T>,
  b: Poly<T>,
  v: string,
  R: Field<T>,
): PseudoDivResult<T> {
  if (polyIsZero(b)) throw new Error("polyPseudoDivide: divisor is zero");
  const degA = polyDegInVar(a, v);
  const degB = polyDegInVar(b, v);

  if (polyIsZero(a) || degA < degB) {
    return { q: polyZero<T>(), r: a };
  }

  const aCoeffs = polyCoeffsInVar(a, v, R);
  const bCoeffs = polyCoeffsInVar(b, v, R);
  const lcB = bCoeffs[degB]!;

  // Premultiply `a` by `lc(b)^(deg a − deg b + 1)`. After this
  // scaling, every leading-coefficient division during long division
  // is exact — that's what makes pseudo-division stay in `D`.
  const delta = degA - degB + 1;
  const scale = polyPow(lcB, delta, R);
  const working: Poly<T>[] = aCoeffs.map((c) => polyMul(c, scale, R));
  while (working.length < degA + 1) working.push(polyZero<T>());

  const qCoeffs: Poly<T>[] = new Array(degA - degB + 1).fill(polyZero<T>());

  for (let i = degA - degB; i >= 0; i--) {
    const lead = working[degB + i]!;
    if (polyIsZero(lead)) {
      qCoeffs[i] = polyZero<T>();
      continue;
    }
    // Exact division by `lcB` is guaranteed because of the
    // premultiplication: after scaling by `lc(b)^δ`, the leading
    // coefficient at every step has at least one factor of `lc(b)`
    // available. (This is the classical pseudo-division correctness.)
    const q = polyDivExact(lead, lcB, R);
    qCoeffs[i] = q;
    for (let j = 0; j <= degB; j++) {
      working[i + j] = polySub(working[i + j]!, polyMul(q, bCoeffs[j]!, R), R);
    }
  }

  const rCoeffs = working.slice(0, degB);
  return {
    q: polyFromCoeffsInVar(qCoeffs, v, R),
    r: polyFromCoeffsInVar(rCoeffs, v, R),
  };
}

// -----------------------------------------------------------------------------
// Subresultant PRS — the inner loop of multivariate GCD
// -----------------------------------------------------------------------------
//
// Given primitive polynomials `a, b ∈ D[v]` (where `D` is the
// polynomial ring of the other variables), compute their GCD in `D[v]`
// as another primitive polynomial. The algorithm produces a sequence
// F_1 = a, F_2 = b, F_3, F_4, ... where each F_{k+1} comes from
// pseudo-dividing F_{k-1} by F_k and then dividing the remainder by a
// scaling factor β_k. The β_k is chosen so that the division is exact
// in D — that's the Brown–Collins subresultant theorem.
//
// Recurrence (Brown 1971):
//
//   ψ_2 = −1
//   β_2 = (−1)^{δ_1 + 1}     where δ_1 = deg(F_1) − deg(F_2) ≥ 0
//
//   For k ≥ 2, after computing F_{k+1}:
//     δ_k = deg(F_k) − deg(F_{k+1})
//     ψ_{k+1} = (−lc(F_k))^{δ_{k-1}} · ψ_k^{1 − δ_{k-1}}        (in D)
//     β_{k+1} = (−lc(F_k)) · ψ_{k+1}^{δ_k}                       (in D)
//   F_{k+2} = pseudoRemainder(F_k, F_{k+1}) / β_{k+1}
//
// The exponent `1 − δ_{k-1}` is non-positive when `δ_{k-1} ≥ 1`; the
// expression really means `(−lc(F_k))^{δ_{k-1}}` divided by
// `ψ_k^{δ_{k-1} − 1}`, which the subresultant theorem guarantees is
// exact in D. We compute it as a `polyDivExact`.
//
// The loop terminates when the remainder becomes zero; the last
// non-zero F_k is the GCD up to associates (in D[v]).

function polySubresultantPRS<T>(
  a: Poly<T>,
  b: Poly<T>,
  v: string,
  R: Field<T>,
): Poly<T> {
  // Edge cases first. If either is zero, the GCD in D[v] is the other
  // (the caller divides by content separately, so we just return it).
  if (polyIsZero(a)) return b;
  if (polyIsZero(b)) return a;

  let F_prev: Poly<T>, F_curr: Poly<T>;
  if (polyDegInVar(a, v) >= polyDegInVar(b, v)) {
    F_prev = a;
    F_curr = b;
  } else {
    F_prev = b;
    F_curr = a;
  }

  const negOne = polyConst(R.fromInt(-1n), R);
  let psi: Poly<T> = negOne;

  // δ_1 = deg(F_1) − deg(F_2). β_2 = (−1)^{δ_1 + 1}.
  const delta1 = polyDegInVar(F_prev, v) - polyDegInVar(F_curr, v);
  let beta: Poly<T> = ((delta1 + 1) % 2 === 0)
    ? polyConst(R.one, R)
    : negOne;

  let prevDelta = delta1;

  // The PRS loop. Each iteration pseudo-divides F_prev by F_curr,
  // scales the remainder by β to obtain F_next, then advances.

  for (let safety = 0; safety < 1000; safety++) {
    const { r } = polyPseudoDivide(F_prev, F_curr, v, R);
    if (polyIsZero(r)) {
      // F_curr divides F_prev; F_curr is the GCD up to associates in D[v].
      return F_curr;
    }
    const F_next = polyDivExact(r, beta, R);

    // Advance F_prev / F_curr.
    const degCurr = polyDegInVar(F_curr, v);
    const degNext = polyDegInVar(F_next, v);
    const delta = degCurr - degNext;

    // Compute ψ_{k+1}. The formula (−lc(F_curr))^{δ_{k-1}} ·
    // ψ^{1 − δ_{k-1}} = (−lc(F_curr))^{δ_{k-1}} / ψ^{δ_{k-1} − 1}
    // when δ_{k-1} ≥ 1; equals ψ when δ_{k-1} = 0.
    const lcCurrCoeffs = polyCoeffsInVar(F_curr, v, R);
    const lcCurr = lcCurrCoeffs[degCurr]!;
    const negLcCurr = polyNeg(lcCurr, R);

    let psi_next: Poly<T>;
    if (prevDelta === 0) {
      psi_next = psi;
    } else if (prevDelta === 1) {
      psi_next = negLcCurr;
    } else {
      const num = polyPow(negLcCurr, prevDelta, R);
      const den = polyPow(psi, prevDelta - 1, R);
      psi_next = polyDivExact(num, den, R);
    }

    // β_{k+1} = (−lc(F_curr)) · ψ_{k+1}^{δ_k}.
    const beta_next = polyMul(negLcCurr, polyPow(psi_next, delta, R), R);

    F_prev = F_curr;
    F_curr = F_next;
    psi = psi_next;
    beta = beta_next;
    prevDelta = delta;
  }
  throw new Error("polySubresultantPRS: did not terminate within 1000 iterations");
}

// -----------------------------------------------------------------------------
// Content / primitive part
// -----------------------------------------------------------------------------
//
// `polyContent(a, v, R)` views `a` as univariate in `v` over `D = Poly[other vars]`
// and returns the GCD in `D` of its coefficient polynomials. The
// content is itself a polynomial in the other variables.
//
// `polyPrimitivePart(a, v, R)` is `a / content(a, v)`: the primitive
// associate of `a` viewed in `v`. By construction, the GCD of its
// coefficients is `R.one`.

function polyContent<T>(a: Poly<T>, v: string, R: Field<T>): Poly<T> {
  if (polyIsZero(a)) return polyZero<T>();
  const coeffs = polyCoeffsInVar(a, v, R);
  let g: Poly<T> = polyZero<T>();
  for (const c of coeffs) {
    g = polyGcd(g, c, R);
    if (polyEq(g, polyOne(R), R)) return g;  // already a unit; can't shrink further
  }
  return g;
}

function polyPrimitivePart<T>(a: Poly<T>, v: string, R: Field<T>): Poly<T> {
  if (polyIsZero(a)) return polyZero<T>();
  const c = polyContent(a, v, R);
  if (polyIsZero(c)) return polyZero<T>();
  if (polyEq(c, polyOne(R), R)) return a;
  return polyDivExact(a, c, R);
}

// -----------------------------------------------------------------------------
// Monic normalisation
// -----------------------------------------------------------------------------
//
// Make a polynomial monic by dividing out its leading coefficient.
// "Leading" here means under the canonical descending-lex ordering
// already enforced by `compareExp` — i.e., the coefficient of the
// term that sorts first in `a.terms`. This coefficient is in `T` (a
// field element), not a polynomial, because lex ordering picks a
// single monomial.

function polyMakeMonic<T>(a: Poly<T>, R: Field<T>): Poly<T> {
  if (polyIsZero(a)) return a;
  const lc = a.terms[0]!.coef;
  if (R.isOne(lc)) return a;
  const inv = R.inv(lc);
  return {
    terms: a.terms.map((t) => ({ exp: t.exp, coef: R.mul(t.coef, inv) })),
  };
}

// -----------------------------------------------------------------------------
// Top-level: polyGcd
// -----------------------------------------------------------------------------
//
// Multivariate GCD via recursion on variables. The result is the
// monic associate (lex-leading coefficient = R.one) by convention.
//
// Edge cases:
//   gcd(0, 0) = 0 — by convention; the "common divisor of zero" is
//                   itself zero.
//   gcd(p, 0) = monic(p) — every non-zero polynomial divides 0.
//   gcd(p, c) for constant non-zero c = R.one — c is a unit; the
//                                                gcd in a UFD is the
//                                                monic-of-1.
//   gcd of two constants: R.one if either is non-zero, else 0.

export function polyGcd<T>(
  a: Poly<T>,
  b: Poly<T>,
  R: Field<T>,
): Poly<T> {
  if (polyIsZero(a) && polyIsZero(b)) return polyZero<T>();
  if (polyIsZero(a)) return polyMakeMonic(b, R);
  if (polyIsZero(b)) return polyMakeMonic(a, R);

  // Constant-on-either-side: in a field, every non-zero element is a
  // unit, so the GCD is R.one.
  if (polyIsConst(a) || polyIsConst(b)) return polyOne(R);

  // Pick a main variable. The alphabetically-first variable of the
  // *intersection* of `a`'s and `b`'s variables is best — if a
  // variable appears in only one polynomial, it cannot be in the
  // GCD anyway, and picking it as main forces a vacuous recursion.
  // Fall back to the union if the intersection is empty (one input
  // is "constant in v" for every shared v — meaning they share no
  // variables, in which case the GCD is in the constant ring).
  const aVars = polyVars(a);
  const bVars = polyVars(b);
  const sharedVars = aVars.filter((v) => bVars.includes(v));

  if (sharedVars.length === 0) {
    // No variable in common: the GCD is a unit (R.one) because in
    // Poly<Field>, two polynomials sharing no variables share no
    // non-trivial divisors.
    return polyOne(R);
  }

  const v = sharedVars[0]!;

  // Recurse on the (n−1)-variable content ring.
  const contentA = polyContent(a, v, R);
  const contentB = polyContent(b, v, R);
  const primA = polyDivExact(a, contentA, R);
  const primB = polyDivExact(b, contentB, R);

  // GCD of the primitive parts via subresultant PRS, viewed in `v`.
  const primGcdRaw = polySubresultantPRS(primA, primB, v, R);
  // The PRS result is primitive *up to a unit* in D[v]. Make it
  // primitive by taking its primitive part.
  const primGcd = polyPrimitivePart(primGcdRaw, v, R);

  // GCD of contents (one fewer variable; recursive call).
  const contentGcd = polyGcd(contentA, contentB, R);

  const result = polyMul(contentGcd, primGcd, R);
  return polyMakeMonic(result, R);
}

// -----------------------------------------------------------------------------
// Re-exports for tests
// -----------------------------------------------------------------------------
//
// The lower-level helpers are package-private in spirit but exported
// here for the test surface — `polyContent` and `polyPrimitivePart`
// need to be probed independently to mutation-prove the algorithm.
// Consumers outside cas-core should use `polyGcd` and `polyDivExact`.

export {
  polyContent as _polyContentForTests,
  polyPrimitivePart as _polyPrimitivePartForTests,
  polyMakeMonic as _polyMakeMonicForTests,
  polyPseudoDivide as _polyPseudoDivideForTests,
};

// Suppress unused-import warnings for symbols we expose only via re-export above.
// (The project's tsc config does not flag unused module-local imports, but the
// ones below are referenced exclusively through these re-exports.)
type _Refs = [Exp, Monomial<unknown>, typeof POLY_ZERO, typeof compareExp, typeof polyAdd];
const _refs: _Refs | null = null;
void _refs;
