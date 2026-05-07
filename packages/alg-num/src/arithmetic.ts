// =============================================================================
// arithmetic.ts — `+, −, ·, /` and unary `−, ⁻¹` on `Root` values
// =============================================================================
//
// What this module is for
// -----------------------
// `Root` values name algebraic numbers; algebraic numbers are closed
// under the four field operations. This module exposes the closure as
// callable functions:
//
//     algNumNeg(α)        : minpoly of `−α` is `f_α(−x)`.
//     algNumInv(α)        : minpoly of `1/α` (α ≠ 0) is `x^n · f_α(1/x)`.
//     algNumAdd(α, β)     : minpoly of `α + β` divides
//                           `Res_y(f_α(y), f_β(x − y))`.
//     algNumSub(α, β)     : `algNumAdd(α, algNumNeg(β))`.
//     algNumMul(α, β)     : minpoly of `α · β` divides
//                           `Res_y(y^{deg f_β} · f_α(x/y), f_β(y))`.
//     algNumDiv(α, β)     : `algNumMul(α, algNumInv(β))`.
//
// All return canonical `Root` values (irreducible minpoly,
// primitive integer-coefficient with positive leading, the within-
// factor `k` index, current isolating interval). The pipeline is:
//
//     (poly, k) — algebraic-arithmetic resultant → polynomial in ℚ[x]
//     factor + canonicalise via `makeRoot(poly, hintInterval, "x")`
//
// where `hintInterval` is computed by interval arithmetic on the
// input intervals. If the initial hint catches multiple roots of the
// resultant (`makeRoot` throws "ambiguous"), we refine the inputs
// (halving each interval width) and retry; termination is guaranteed
// because (a) the resultant has finitely many real roots, (b) two
// distinct algebraic numbers are bounded apart by a positive
// separation (resultant non-vanishing), and (c) bisection halves
// interval widths each iteration.
//
// References
// ----------
// - **Cohen 1993** (GTM 138) §3.6.2 — sum and product minpolys via
//   `Res_y`.
// - **ADR-0018** §"Arithmetic semantics" — the workbench's
//   formalisation of these closures.
// - **SageMath `qqbar.py` / `AlgebraicNumber._add_` / `_mul_`** —
//   the same pipeline in a mature reference implementation.

import {
  type Poly,
  type Rat,
  INT_RING,
  RAT_RING,
  makeRat,
  polyAdd,
  polyConst,
  polyCoeffsInVar,
  polyDegInVar,
  polyIsZero,
  polyMul,
  polySub,
  polyVar,
} from "@workbench/cas-core";
import { squareFree } from "@workbench/poly-factor";

import {
  type RatInterval,
  type Root,
  ROOT_VAR,
  makeRoot,
} from "./root.js";
import { refineRoot, intervalWidth } from "./refine.js";
import { sylvesterResultantInY } from "./resultant.js";

// -----------------------------------------------------------------------------
// algNumNeg — minpoly(−α) is f(−x)
// -----------------------------------------------------------------------------

/**
 * Negate an algebraic number. The minpoly of `−α` is `f_α(−x)` (or
 * its sign-flip if odd-degree). Canonical form preserves primitivity
 * and positive leading coefficient.
 *
 * Index transform: real roots of `f` ascending are `r_0 < r_1 < … <
 * r_{m−1}`; real roots of `f(−x)` ascending are `−r_{m−1} < −r_{m−2}
 * < … < −r_0`. So if `α = r_k`, then `−α = −r_k` is the `(m − 1 − k)`-th
 * real root of `f(−x)`.
 *
 * Interval transform: `α ∈ (lo, hi)` ⇒ `−α ∈ (−hi, −lo)`.
 */
export function algNumNeg(a: Root): Root {
  // Substitute x → −x in the minpoly. f(−x) has alternating-sign
  // coefficients: c_i ↦ (−1)^i · c_i. The result may have negative
  // leading coefficient (when deg is odd); `makeRoot` calls
  // `canonicalIntegerForm` which sign-fixes.
  const negated = substituteNegateX(a.minpoly);
  const negatedRat = liftIntPolyToRat(negated);
  // Hint interval: `(−hi, −lo)`. `makeRoot` recomputes within-factor `k`
  // from the canonical minpoly's real-root list — for an irreducible
  // canonical `f`, `f(−x)` (after sign-fix) is also irreducible; the
  // within-factor `k_new` equals `(m − 1 − a.k)` by the index-reversal
  // induced by negation.
  const hint: RatInterval = {
    lo: ratNeg(a.interval.hi),
    hi: ratNeg(a.interval.lo),
  };
  return makeRoot(negatedRat, hint, ROOT_VAR);
}

// -----------------------------------------------------------------------------
// algNumInv — minpoly(α⁻¹) is `x^n · f(1/x)` for α ≠ 0
// -----------------------------------------------------------------------------

/**
 * Multiplicative inverse of a non-zero algebraic number. Throws if
 * `α = 0` (the only `Root` with a zero algebraic — `Root[x, 0]` —
 * has interval `(0, 0)`).
 *
 * `f(x) = c_n x^n + … + c_0` ⇒ `x^n f(1/x) = c_n + c_{n−1} x + … +
 * c_0 x^n` — coefficient reversal.
 *
 * Interval transform: for an interval that excludes 0, `1/[lo, hi] =
 * [1/hi, 1/lo]` (flip endpoints; both must have the same sign by
 * the exclusion-of-zero precondition).
 */
export function algNumInv(a: Root): Root {
  if (rootIsZero(a)) {
    throw new Error("algNumInv: cannot invert zero");
  }
  const reversed = reverseCoefficients(a.minpoly);
  const reversedRat = liftIntPolyToRat(reversed);

  // Hint interval: `1/[lo, hi]` for an interval that strictly excludes 0
  // (closed-zero endpoints — `lo == 0` or `hi == 0` — are equivalent to
  // straddling zero for the purposes of `ratInv`, which is undefined at
  // zero). VAS frequently emits intervals with `0` as an endpoint
  // (e.g. `3x^2 − 1` produces `(0, 1)` for `+1/√3`); refine such
  // intervals until zero is excluded.
  let aRefined = a;
  while (aRefined.interval.lo.n <= 0n && aRefined.interval.hi.n >= 0n) {
    if (aRefined.interval.lo.n === 0n && aRefined.interval.hi.n === 0n) {
      throw new Error("algNumInv: refinement collapsed to α = 0");
    }
    aRefined = refineRoot(aRefined, {
      maxWidth: scaleRatHalf(intervalWidth(aRefined.interval)),
    });
  }
  const aInt = aRefined.interval;
  const hint: RatInterval = {
    lo: ratInv(aInt.hi),
    hi: ratInv(aInt.lo),
  };
  return makeRoot(reversedRat, hint, ROOT_VAR);
}

// -----------------------------------------------------------------------------
// algNumAdd — minpoly(α + β) divides squarefree(Res_y(f_α(y), f_β(x − y)))
// -----------------------------------------------------------------------------

/**
 * Sum of two algebraic numbers. The minpoly of `α + β` divides the
 * resultant `Res_y(f_α(y), f_β(x − y))`; we factor and select the
 * irreducible factor whose root lies in the interval `α.interval +
 * β.interval` (sum interval). If the sum interval catches multiple
 * factors, we refine `α` and `β` (halving each interval) and retry.
 */
export function algNumAdd(a: Root, b: Root): Root {
  return arithmeticBinop(a, b, computeSumPoly, intervalAdd, "algNumAdd");
}

/**
 * Difference `α − β`. Implemented as `α + (−β)`.
 */
export function algNumSub(a: Root, b: Root): Root {
  return algNumAdd(a, algNumNeg(b));
}

// -----------------------------------------------------------------------------
// algNumMul — minpoly(α · β) divides squarefree(Res_y(y^{deg g} f_α(x/y), f_β(y)))
// -----------------------------------------------------------------------------

/**
 * Product of two algebraic numbers. Pipeline mirrors `algNumAdd`,
 * with the product-resultant substitution and interval-product hint.
 */
export function algNumMul(a: Root, b: Root): Root {
  return arithmeticBinop(a, b, computeProductPoly, intervalMul, "algNumMul");
}

/**
 * Quotient `α / β` (β ≠ 0). Implemented as `α · β⁻¹`.
 */
export function algNumDiv(a: Root, b: Root): Root {
  return algNumMul(a, algNumInv(b));
}

// -----------------------------------------------------------------------------
// arithmeticBinop — shared refine-loop driver
// -----------------------------------------------------------------------------

function arithmeticBinop(
  a0: Root,
  b0: Root,
  computePoly: (a: Poly<bigint>, b: Poly<bigint>) => Poly<Rat>,
  computeHint: (aIv: RatInterval, bIv: RatInterval) => RatInterval,
  opName: string,
): Root {
  // Compute the resultant once — it depends only on the canonical
  // minpolys (a, b's interval state has no effect).
  const resultantRat = computePoly(a0.minpoly, b0.minpoly);
  // Squarefree the result so makeRoot's factor pass has minimal work.
  const sfFactors = squareFree(resultantRat, ROOT_VAR);
  // The squarefree part is the product of distinct factors (each
  // multiplicity-1). Reconstruct.
  let resultantSf: Poly<Rat> = polyConst<Rat>(makeRat(1n, 1n), RAT_RING);
  for (const { factor } of sfFactors) {
    resultantSf = polyMul(resultantSf, factor, RAT_RING);
  }

  let a = a0;
  let b = b0;
  const MAX_REFINEMENTS = 64;
  for (let i = 0; i <= MAX_REFINEMENTS; i++) {
    const hint = computeHint(a.interval, b.interval);
    try {
      return makeRoot(resultantSf, hint, ROOT_VAR);
    } catch (e) {
      const msg = (e as Error).message;
      if (!/ambiguous|no root/i.test(msg)) {
        throw e;
      }
      if (i === MAX_REFINEMENTS) {
        throw new Error(
          `${opName}: failed to disambiguate after ${MAX_REFINEMENTS} refinements (last hint: [${ratStr(hint.lo)}, ${ratStr(hint.hi)}]); possible bug in resultant computation`,
        );
      }
      // Halve each interval and retry.
      const aTarget = scaleRatHalf(intervalWidth(a.interval));
      const bTarget = scaleRatHalf(intervalWidth(b.interval));
      a = refineRoot(a, { maxWidth: aTarget });
      b = refineRoot(b, { maxWidth: bTarget });
    }
  }
  // Unreachable — the loop above either returns or throws.
  throw new Error(`${opName}: internal — exited refinement loop without resolution`);
}

// -----------------------------------------------------------------------------
// Polynomial constructions
// -----------------------------------------------------------------------------

const SUM_X = "x" as const;
const SUM_Y = "y" as const;

/**
 * `computeSumPoly(f, g)` builds `Res_y(f(y), g(x − y))` as a `Poly<Rat>`
 * in the single variable `SUM_X`.
 */
function computeSumPoly(fInt: Poly<bigint>, gInt: Poly<bigint>): Poly<Rat> {
  // Step 1: rename f's variable from ROOT_VAR to SUM_Y.
  const fInY = renameVar(fInt, ROOT_VAR, SUM_Y);
  // Step 2: substitute g's variable: x ↦ x − y. Result is in (x, y).
  const gShifted = substituteVarToXMinusY(gInt, ROOT_VAR, SUM_X, SUM_Y);
  // Step 3: lift to ℚ.
  const fInY_Q = liftIntPolyToRat(fInY);
  const gShifted_Q = liftIntPolyToRat(gShifted);
  // Step 4: resultant in y.
  return sylvesterResultantInY(fInY_Q, gShifted_Q, SUM_Y);
}

/**
 * `computeProductPoly(f, g)` builds `Res_y(y^{deg g} · f(x/y), g(y))`
 * as a `Poly<Rat>` in `SUM_X`. Equivalently, `y^{deg f} · f(x/y) =
 * sum_k c_k · x^k · y^{deg f − k}` (coefficient-reversal in y with
 * x-multiplication on the way).
 *
 * Note: the exponent on `y` is `deg f` (degree of `f` in its variable),
 * NOT `deg g` — Cohen 1993 GTM 138 §3.6.2 gives the formula as
 * `Res_y(y^{deg f} · f(x/y), g(y))`. The bead description's
 * "y^deg(g) · f(x/y)" is a minor transcription glitch; the math
 * requires homogenisation of `f`, hence `y^{deg f}`. (This matches
 * SageMath `qqbar.py::AlgebraicNumber._mul_`.)
 */
function computeProductPoly(fInt: Poly<bigint>, gInt: Poly<bigint>): Poly<Rat> {
  // Step 1: build `y^{deg f} · f(x/y)` directly from `f`'s coefficients.
  const fHom = homogeniseMul(fInt, ROOT_VAR, SUM_X, SUM_Y);
  // Step 2: rename g's variable from ROOT_VAR to SUM_Y.
  const gInY = renameVar(gInt, ROOT_VAR, SUM_Y);
  // Step 3: lift to ℚ.
  const fHom_Q = liftIntPolyToRat(fHom);
  const gInY_Q = liftIntPolyToRat(gInY);
  // Step 4: resultant in y.
  return sylvesterResultantInY(fHom_Q, gInY_Q, SUM_Y);
}

// -----------------------------------------------------------------------------
// Polynomial substitution and structural transforms
// -----------------------------------------------------------------------------

/** Rename variable `from` to `to` in a `Poly<bigint>`.  No-op
 * sort-order issues here: in our use `from` is always the only
 * variable in the input, so the renamed exp lists remain sorted. */
function renameVar(p: Poly<bigint>, from: string, to: string): Poly<bigint> {
  return {
    terms: p.terms.map((t) => ({
      coef: t.coef,
      exp: t.exp.map(([n, e]) =>
        n === from ? ([to, e] as readonly [string, number]) : ([n, e] as readonly [string, number]),
      ),
    })),
  };
}

/** Substitute `var = X − Y` in `p(var)`, producing a polynomial in
 * `X, Y` (and any other variables of `p`). For our usage `p` has
 * only `var`, so the result is a polynomial in `X, Y` over ℤ. */
function substituteVarToXMinusY(
  p: Poly<bigint>,
  varOld: string,
  varX: string,
  varY: string,
): Poly<bigint> {
  const X = polyVar<bigint>(varX, INT_RING);
  const Y = polyVar<bigint>(varY, INT_RING);
  const xMinusY = polySub(X, Y, INT_RING);

  const coeffs = polyCoeffsInVar(p, varOld, INT_RING);   // low-to-high
  let acc: Poly<bigint> = polyConst<bigint>(0n, INT_RING);
  let pow: Poly<bigint> = polyConst<bigint>(1n, INT_RING);   // (X − Y)^0
  for (let k = 0; k < coeffs.length; k++) {
    if (!polyIsZero(coeffs[k]!)) {
      acc = polyAdd(acc, polyMul(coeffs[k]!, pow, INT_RING), INT_RING);
    }
    if (k + 1 < coeffs.length) pow = polyMul(pow, xMinusY, INT_RING);
  }
  return acc;
}

/** Build `y^{deg p} · p(x/y)` from `p(varOld)`, producing a polynomial
 * in `(varX, varY)`. Equivalent to coefficient-reversal:
 * `p(x) = sum c_k x^k`  ⇒  `y^n p(x/y) = sum c_k x^k y^{n − k}`. */
function homogeniseMul(
  p: Poly<bigint>,
  varOld: string,
  varX: string,
  varY: string,
): Poly<bigint> {
  const n = polyDegInVar(p, varOld);
  if (n < 0) return polyConst<bigint>(0n, INT_RING);
  const X = polyVar<bigint>(varX, INT_RING);
  const Y = polyVar<bigint>(varY, INT_RING);
  const coeffs = polyCoeffsInVar(p, varOld, INT_RING);   // low-to-high in varOld
  let acc: Poly<bigint> = polyConst<bigint>(0n, INT_RING);
  for (let k = 0; k <= n; k++) {
    const c = coeffs[k]!;
    if (polyIsZero(c)) continue;
    let term: Poly<bigint> = c;
    for (let i = 0; i < k; i++) term = polyMul(term, X, INT_RING);
    for (let i = 0; i < n - k; i++) term = polyMul(term, Y, INT_RING);
    acc = polyAdd(acc, term, INT_RING);
  }
  return acc;
}

/** Substitute x → −x in a `Poly<bigint>` (flips signs of odd-degree
 * coefficients). Result is the integer-coefficient form; canonicalisation
 * (positive leading, primitive) happens upstream via `makeRoot`. */
function substituteNegateX(p: Poly<bigint>): Poly<bigint> {
  return {
    terms: p.terms.map((t) => {
      let degOfX = 0;
      for (const [n, e] of t.exp) if (n === ROOT_VAR) degOfX = e;
      const sign = degOfX % 2 === 0 ? 1n : -1n;
      return { exp: t.exp, coef: t.coef * sign };
    }),
  };
}

/** Coefficient-reverse a `Poly<bigint>` in `ROOT_VAR`: result is
 * `x^{deg p} · p(1/x)`.
 *
 * cas-core's canonical-form invariant is **terms sorted high-to-low
 * by exponent** (cf. the `polyAdd`/`polyMul` combinators' canonical
 * output). The naive `.map` over an input in canonical (high-to-low)
 * order produces a low-to-high term array — non-canonical. Downstream
 * `factorRatQ` (specifically the Berlekamp + henselLiftMany path) is
 * sensitive to canonical input: with terms out of order the Hensel
 * lift's `f ≡ g₀·h₀ (mod p)` precondition check fails because the
 * mod-p reduction operates per-term. We restore canonical order by
 * reversing the mapped array — which is correct when input is
 * canonical (the smallest-exp input term becomes the largest-exp
 * output term, so a high-to-low input maps to a low-to-high output,
 * which `.reverse()` flips back to high-to-low). For palindromic
 * input like `x⁴ − 4x² + 1` (which became the canary case in worklog
 * 066), this is the difference between a successful inv and a
 * henselLiftPair crash. */
function reverseCoefficients(p: Poly<bigint>): Poly<bigint> {
  const n = polyDegInVar(p, ROOT_VAR);
  const mapped = p.terms.map((t) => {
    let degOfX = 0;
    const restExp: [string, number][] = [];
    for (const [name, e] of t.exp) {
      if (name === ROOT_VAR) degOfX = e;
      else restExp.push([name, e]);
    }
    const newDeg = n - degOfX;
    const newExp: [string, number][] =
      newDeg === 0 ? restExp : [...restExp, [ROOT_VAR, newDeg]];
    return { exp: newExp, coef: t.coef };
  });
  return { terms: mapped.reverse() };
}

// -----------------------------------------------------------------------------
// Interval arithmetic
// -----------------------------------------------------------------------------

function intervalAdd(a: RatInterval, b: RatInterval): RatInterval {
  return {
    lo: ratAdd(a.lo, b.lo),
    hi: ratAdd(a.hi, b.hi),
  };
}

function intervalMul(a: RatInterval, b: RatInterval): RatInterval {
  // Sign-aware product. The product interval is the convex hull of
  // the four corner products. We compute all four and take min/max.
  const products: Rat[] = [
    ratMul(a.lo, b.lo),
    ratMul(a.lo, b.hi),
    ratMul(a.hi, b.lo),
    ratMul(a.hi, b.hi),
  ];
  let lo = products[0]!;
  let hi = products[0]!;
  for (let i = 1; i < 4; i++) {
    if (ratCompare(products[i]!, lo) < 0) lo = products[i]!;
    if (ratCompare(products[i]!, hi) > 0) hi = products[i]!;
  }
  return { lo, hi };
}

// -----------------------------------------------------------------------------
// Internal — small Rat / Poly utilities
// -----------------------------------------------------------------------------

function rootIsZero(r: Root): boolean {
  // The canonical minpoly of 0 is `x` itself: coefficients [0, 1].
  // We could check that pattern, but more robustly: 0 has interval
  // `(0, 0)` (a singleton at 0).
  return r.interval.lo.n === 0n && r.interval.hi.n === 0n;
}

function liftIntPolyToRat(p: Poly<bigint>): Poly<Rat> {
  return {
    terms: p.terms.map((t) => ({ exp: t.exp, coef: makeRat(t.coef, 1n) })),
  };
}

function ratAdd(a: Rat, b: Rat): Rat {
  return makeRat(a.n * b.d + b.n * a.d, a.d * b.d);
}

function ratMul(a: Rat, b: Rat): Rat {
  return makeRat(a.n * b.n, a.d * b.d);
}

function ratNeg(a: Rat): Rat {
  return makeRat(-a.n, a.d);
}

function ratInv(a: Rat): Rat {
  if (a.n === 0n) throw new Error("ratInv: division by zero");
  return makeRat(a.d * (a.n < 0n ? -1n : 1n), a.n < 0n ? -a.n : a.n);
}

function ratCompare(a: Rat, b: Rat): number {
  const lhs = a.n * b.d;
  const rhs = b.n * a.d;
  if (lhs < rhs) return -1;
  if (lhs > rhs) return 1;
  return 0;
}

function ratStr(r: Rat): string {
  return r.d === 1n ? `${r.n}` : `${r.n}/${r.d}`;
}

function scaleRatHalf(r: Rat): Rat {
  return makeRat(r.n, r.d * 2n);
}
