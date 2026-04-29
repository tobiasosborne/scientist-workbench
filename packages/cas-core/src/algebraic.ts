// =============================================================================
// algebraic — algebraic-number rings R[α]/(p(α)) over an arbitrary base ring
// =============================================================================
//
// Why this file exists
// --------------------
// cas-core's v0.1 worked exclusively over Q. Real CAS systems (FriCAS,
// SymPy, Maple, Mathematica) all support algebraic-number rings as a
// first-class capability — for arithmetic over `Q[√2]`, `Q[i]`, `Q[√2,
// i]`, cyclotomic fields `Q[ζ_n]`, and beyond. This module is rung 2
// of the cas-core roadmap (see `docs/cas-core-roadmap.md`,
// ADR-0008): it adds algebraic-number support as a generic
// construction over any field `R`, producing a new `Field<T>` that
// can be plugged into the same polynomial machinery.
//
// The construction
// ----------------
// Given a base field `R` and a *monic, irreducible* polynomial
// `p(α) ∈ R[α]` of degree `n`, we form the quotient field
//
//     R[α]/(p(α)) = { a₀ + a₁·α + … + a_{n−1}·α^{n−1} : aᵢ ∈ R }
//
// with arithmetic computed in `R[α]` and then reduced modulo `p(α)`.
// An element is a coefficient list `[a₀, a₁, …, a_{n−1}]` in low-to-
// high degree order.
//
// Concrete examples:
//
//   • Q[√2]: base R = Q, p(α) = α² − 2 (i.e., minimalPoly =
//     [-2, 0, 1] = lowest-to-highest). Element 1 is [1]; element √2
//     is [0, 1]; (1 + √2)² = 3 + 2√2 = [3, 2].
//
//   • Q[i]: p(α) = α² + 1, minimalPoly = [1, 0, 1].
//
//   • Q[√2, i]: tower construction. Build Q[√2] first, then form
//     `Q[√2][β]/(β² + 1)` using Q[√2] as the base. An element of
//     Q[√2, i] is a pair `[c, d]` where each of c, d is itself a
//     Q[√2] element (i.e., a Q-rational pair). Multiplication
//     interleaves the relations: i² = −1 within the outer level,
//     and √2² = 2 within the inner level (no cross-coupling because
//     the chain is well-typed).
//
// Why chain (not flat)
// --------------------
// Two natural designs (per ADR-0008): "flat"
// `R[α₁,…,αₖ]/(p₁,…,pₖ)` with simultaneous Gröbner reduction, or
// "chain" with each generator adjoined to the previous level. Chain
// wins for v0.2:
//
//   • Implementation is multiplication-then-poly-divide-by-minPoly,
//     which we already have the primitives for.
//   • Flat would require Gröbner basis machinery cas-core does not
//     yet have.
//   • The chain ordering for `Q[√2, i]` is well-founded (irrational
//     extension first, imaginary second). The Q-basis is
//     `{1, √2, i, √2·i}` regardless of ordering.
//
// What this module exposes
// ------------------------
//   • `AlgebraicElement<R>` — typed element: a coefficient list.
//   • `AlgebraicRingSpec<R>` — the construction recipe.
//   • `algebraicRing<R>(spec)` — the constructor; returns a
//     `Field<AlgebraicElement<R>>` plug-compatible with `Poly<T>`,
//     `RatFn<T>`, and any future generic algorithm.
//   • Pre-built instances `Q_SQRT2`, `Q_I`, `Q_SQRT2_I` for the v0.2
//     consumers (sturm-execute needs `Q_SQRT2_I` for Clifford+T
//     amplitudes).

import { type Field, type Ring } from "./ring.js";
import { makeRat, type Rat, RAT_RING } from "./rat.js";

// -----------------------------------------------------------------------------
// AlgebraicElement<R> — coefficient list in low-to-high degree order
// -----------------------------------------------------------------------------
//
// `coefs.length ≤ deg(minimalPoly)` after canonical reduction. The
// constructor below trims trailing zeros so that two elements with the
// same Q-vector representation hash to the same `coefs` array.

export interface AlgebraicElement<R> {
  readonly coefs: readonly R[];
}

export interface AlgebraicRingSpec<R> {
  readonly base: Field<R>;
  /**
   * The minimal polynomial of the generator α, as a low-to-high
   * coefficient list. Must be monic (last coef = base.one) and
   * irreducible over `base`. The constructor checks the monic
   * condition; irreducibility is the caller's responsibility — a
   * non-irreducible minimal polynomial would make the quotient a
   * non-field, breaking inverse.
   */
  readonly minimalPoly: readonly R[];
  /**
   * A short human-readable name for the generator, used in error
   * messages and in the `algebraicElementToString` helper. E.g.,
   * "√2" for Q[√2], "i" for Q[i].
   */
  readonly generatorName: string;
}

// -----------------------------------------------------------------------------
// Internal helpers — coefficient-list polynomial arithmetic over R
// -----------------------------------------------------------------------------
//
// We don't reuse `Poly<T>` from `poly.ts` because that's the
// multivariate sparse representation, which is overkill for the
// dense univariate polynomials in `α` we're manipulating here. A
// flat array is simpler and matches the FriCAS implementation
// pattern.

function trimZeros<R>(coefs: readonly R[], base: Ring<R>): R[] {
  let end = coefs.length;
  while (end > 0 && base.isZero(coefs[end - 1]!)) end--;
  return coefs.slice(0, end);
}

function listAdd<R>(a: readonly R[], b: readonly R[], base: Ring<R>): R[] {
  const n = Math.max(a.length, b.length);
  const out: R[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const ai = i < a.length ? a[i]! : base.zero;
    const bi = i < b.length ? b[i]! : base.zero;
    out[i] = base.add(ai, bi);
  }
  return trimZeros(out, base);
}

function listSub<R>(a: readonly R[], b: readonly R[], base: Ring<R>): R[] {
  const n = Math.max(a.length, b.length);
  const out: R[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const ai = i < a.length ? a[i]! : base.zero;
    const bi = i < b.length ? b[i]! : base.zero;
    out[i] = base.sub(ai, bi);
  }
  return trimZeros(out, base);
}

function listNeg<R>(a: readonly R[], base: Ring<R>): R[] {
  return a.map((x) => base.neg(x));
}

function listMul<R>(a: readonly R[], b: readonly R[], base: Ring<R>): R[] {
  if (a.length === 0 || b.length === 0) return [];
  const out: R[] = new Array(a.length + b.length - 1).fill(base.zero);
  for (let i = 0; i < a.length; i++) {
    if (base.isZero(a[i]!)) continue;
    for (let j = 0; j < b.length; j++) {
      if (base.isZero(b[j]!)) continue;
      out[i + j] = base.add(out[i + j]!, base.mul(a[i]!, b[j]!));
    }
  }
  return trimZeros(out, base);
}

// Reduce a polynomial `coefs` modulo a monic polynomial `minPoly`.
// Assumes `minPoly` is monic (leading coef = base.one). Returns the
// remainder, of degree strictly less than deg(minPoly).
function reduceModMinPoly<R>(
  coefs: readonly R[],
  minPoly: readonly R[],
  base: Field<R>
): R[] {
  const n = minPoly.length - 1; // degree of minPoly
  const work = [...coefs];
  // Process from highest degree downward.
  while (work.length > n) {
    const lead = work[work.length - 1]!;
    if (base.isZero(lead)) {
      work.pop();
      continue;
    }
    // The leading term is `lead · α^(work.length - 1)`. Since
    // α^n ≡ -(c_0 + … + c_{n-1}·α^{n-1}) (from p(α) = 0 and p monic),
    // we have α^(work.length - 1) = α^(shift) · α^n where
    // shift = work.length - 1 - n. Subtract `lead · α^shift · (α^n
    // expansion)` from work.
    const shift = work.length - 1 - n;
    // Subtract lead * α^shift * minPoly's lower coefs from work.
    // (We don't subtract the α^n term itself — that's the leading
    // term we're cancelling.)
    for (let i = 0; i < n; i++) {
      const idx = i + shift;
      const subtract = base.mul(lead, minPoly[i]!);
      work[idx] = base.sub(work[idx]!, subtract);
    }
    work.pop(); // leading term is now exactly cancelled
  }
  return trimZeros(work, base);
}

// Polynomial division with remainder over R[α], where R is a field.
// Returns { q, r } with `a = b·q + r` and deg(r) < deg(b).
function polyDivMod<R>(
  a: readonly R[],
  b: readonly R[],
  base: Field<R>
): { q: R[]; r: R[] } {
  if (b.length === 0) throw new Error("polyDivMod: division by zero polynomial");
  const lcB = b[b.length - 1]!;
  if (base.isZero(lcB)) throw new Error("polyDivMod: leading coef of divisor is zero");
  const r = [...a];
  const dB = b.length - 1;
  const qLen = Math.max(0, r.length - dB);
  const q: R[] = new Array(qLen).fill(base.zero);
  while (r.length - 1 >= dB && r.length > 0) {
    const lcR = r[r.length - 1]!;
    if (base.isZero(lcR)) {
      r.pop();
      continue;
    }
    const factor = base.div(lcR, lcB);
    const shift = r.length - 1 - dB;
    q[shift] = factor;
    for (let i = 0; i <= dB; i++) {
      const subtract = base.mul(factor, b[i]!);
      r[i + shift] = base.sub(r[i + shift]!, subtract);
    }
    // The leading term should be zero now; pop trailing zeros.
    while (r.length > 0 && base.isZero(r[r.length - 1]!)) r.pop();
  }
  return { q: trimZeros(q, base), r };
}

// Extended Euclidean algorithm over R[α]: returns {g, s, t} with
// a·s + b·t = g and g a (possibly non-monic) gcd. We use it for
// computing inverses modulo minPoly: when minPoly is irreducible,
// gcd(element, minPoly) is a unit (constant), and the corresponding
// `s` modulo minPoly gives `element⁻¹` after division by the unit.
function polyExtGcd<R>(
  a: readonly R[],
  b: readonly R[],
  base: Field<R>
): { g: R[]; s: R[]; t: R[] } {
  // (s, t, g) such that a·s + b·t = g, starting with
  // s0=1, t0=0, g0=a; s1=0, t1=1, g1=b.
  let r0 = [...a];
  let r1 = [...b];
  let s0: R[] = [base.one];
  let s1: R[] = [];
  let t0: R[] = [];
  let t1: R[] = [base.one];
  while (r1.length > 0) {
    const { q } = polyDivMod(r0, r1, base);
    const r2 = listSub(r0, listMul(q, r1, base), base);
    const s2 = listSub(s0, listMul(q, s1, base), base);
    const t2 = listSub(t0, listMul(q, t1, base), base);
    r0 = r1;
    r1 = r2;
    s0 = s1;
    s1 = s2;
    t0 = t1;
    t1 = t2;
  }
  return { g: r0, s: s0, t: t0 };
}

// -----------------------------------------------------------------------------
// algebraicRing — the public constructor
// -----------------------------------------------------------------------------

export function algebraicRing<R>(
  spec: AlgebraicRingSpec<R>
): Field<AlgebraicElement<R>> {
  const base = spec.base;
  const minPoly = spec.minimalPoly;
  if (minPoly.length < 2) {
    throw new Error(
      `algebraicRing: minimalPoly must have degree ≥ 1, got ${minPoly.length - 1}`
    );
  }
  if (!base.isOne(minPoly[minPoly.length - 1]!)) {
    throw new Error(
      `algebraicRing: minimalPoly must be monic (leading coef = base.one)`
    );
  }
  const name = spec.generatorName;

  // Build canonical-form helpers bound to this ring's spec.
  const canonical = (coefs: readonly R[]): AlgebraicElement<R> => ({
    coefs: trimZeros(coefs, base),
  });

  const zero: AlgebraicElement<R> = { coefs: [] };
  const one: AlgebraicElement<R> = { coefs: [base.one] };

  return {
    zero,
    one,

    add: (a, b) => canonical(listAdd(a.coefs, b.coefs, base)),

    sub: (a, b) => canonical(listSub(a.coefs, b.coefs, base)),

    mul: (a, b) => {
      const product = listMul(a.coefs, b.coefs, base);
      return canonical(reduceModMinPoly(product, minPoly, base));
    },

    neg: (a) => canonical(listNeg(a.coefs, base)),

    eq: (a, b) => {
      // Compare via canonical-form length and coefficients. Both
      // sides have already been normalised by their constructors,
      // so a structural element-wise compare is sound.
      if (a.coefs.length !== b.coefs.length) return false;
      for (let i = 0; i < a.coefs.length; i++) {
        if (!base.eq(a.coefs[i]!, b.coefs[i]!)) return false;
      }
      return true;
    },

    isZero: (a) => a.coefs.length === 0,

    isOne: (a) =>
      a.coefs.length === 1 && base.isOne(a.coefs[0]!),

    fromInt: (n) => {
      if (n === 0n) return zero;
      return canonical([base.fromInt(n)]);
    },

    inv: (a) => {
      if (a.coefs.length === 0) {
        throw new Error(`algebraicRing(${name}): inverse of zero`);
      }
      // Bezout: find s such that a·s ≡ 1 (mod minPoly). Since
      // minPoly is irreducible over base, gcd(a, minPoly) is a unit
      // (a non-zero constant in base). Then a · (s/g) ≡ 1.
      const { g, s } = polyExtGcd(a.coefs, minPoly, base);
      if (g.length !== 1 || base.isZero(g[0]!)) {
        // Should not happen if minPoly is genuinely irreducible. If
        // the caller passed a reducible minPoly, we may land here.
        throw new Error(
          `algebraicRing(${name}): inverse failed — minPoly may be reducible (gcd had degree ${g.length - 1})`
        );
      }
      const gInv = base.inv(g[0]!);
      const sNorm = s.map((x) => base.mul(x, gInv));
      // Reduce s modulo minPoly so the result is in canonical form.
      return canonical(reduceModMinPoly(sNorm, minPoly, base));
    },

    div: (a, b) => {
      // div(a, b) = mul(a, inv(b)). Implemented using the closure's
      // own `mul` and `inv`. We can't reach `this` cleanly inside an
      // object literal; we recompute locally.
      if (b.coefs.length === 0) {
        throw new Error(`algebraicRing(${name}): division by zero`);
      }
      const { g, s } = polyExtGcd(b.coefs, minPoly, base);
      if (g.length !== 1 || base.isZero(g[0]!)) {
        throw new Error(
          `algebraicRing(${name}): division failed — minPoly may be reducible`
        );
      }
      const gInv = base.inv(g[0]!);
      const bInvCoefs = reduceModMinPoly(
        s.map((x) => base.mul(x, gInv)),
        minPoly,
        base
      );
      const product = listMul(a.coefs, bInvCoefs, base);
      return canonical(reduceModMinPoly(product, minPoly, base));
    },
  };
}

// -----------------------------------------------------------------------------
// Convenience: build an AlgebraicElement<R> from a coefficient list
// -----------------------------------------------------------------------------
//
// `algElement(coefs, base)` produces a canonical-form element. Mostly
// useful in tests and for tool authors constructing elements
// directly.

export function algElement<R>(
  coefs: readonly R[],
  base: Ring<R>
): AlgebraicElement<R> {
  return { coefs: trimZeros(coefs, base) };
}

// -----------------------------------------------------------------------------
// Pre-built instances for the v0.2 consumers
// -----------------------------------------------------------------------------
//
// `Q_SQRT2`, `Q_I`, `Q_SQRT2_I` are the three immediately useful
// algebraic extensions: real quadratic, imaginary, and the tower
// `Q[√2][i]` that sturm-execute will use for Clifford+T amplitudes.
// Other extensions can be built on demand by callers.

const RAT_NEG_TWO: Rat = makeRat(-2n);

/** `Q[√2] = Q[α]/(α² − 2)`. */
export const Q_SQRT2: Field<AlgebraicElement<Rat>> = algebraicRing({
  base: RAT_RING,
  minimalPoly: [RAT_NEG_TWO, RAT_RING.zero, RAT_RING.one],
  generatorName: "√2",
});

/** `Q[i] = Q[α]/(α² + 1)`. */
export const Q_I: Field<AlgebraicElement<Rat>> = algebraicRing({
  base: RAT_RING,
  minimalPoly: [RAT_RING.one, RAT_RING.zero, RAT_RING.one],
  generatorName: "i",
});

/**
 * `Q[√2, i] = Q[√2][β]/(β² + 1)`. Tower: Q ⊂ Q[√2] ⊂ Q[√2][i]. An
 * element is a 2-coefficient list over Q[√2], i.e., `[c, d]`
 * representing `c + d·i` where `c` and `d` are themselves
 * Q[√2]-elements. The full Q-basis is `{1, √2, i, √2·i}` — useful
 * for sanity-checking element representations.
 */
export const Q_SQRT2_I: Field<AlgebraicElement<AlgebraicElement<Rat>>> =
  algebraicRing({
    base: Q_SQRT2,
    minimalPoly: [Q_SQRT2.one, Q_SQRT2.zero, Q_SQRT2.one],
    generatorName: "i",
  });

// -----------------------------------------------------------------------------
// Helpers for constructing common Q[√2, i] elements
// -----------------------------------------------------------------------------
//
// The full tower notation is verbose: `Q_SQRT2_I.add(Q_SQRT2_I.one,
// algElement([Q_SQRT2.zero, algElement([RAT_RING.zero, RAT_RING.one],
// RAT_RING)], Q_SQRT2))` for `1 + √2·i` is unreadable. These
// helpers make typical construction direct.

/** Q[√2] element `a + b·√2` from rationals a, b. */
export function qSqrt2(a: Rat, b: Rat): AlgebraicElement<Rat> {
  return algElement([a, b], RAT_RING);
}

/** Q[i] element `a + b·i` from rationals a, b. */
export function qI(a: Rat, b: Rat): AlgebraicElement<Rat> {
  return algElement([a, b], RAT_RING);
}

/**
 * Q[√2, i] element from four Q-rationals on the basis
 * `{1, √2, i, √2·i}`: `a + b·√2 + c·i + d·√2·i`.
 */
export function qSqrt2I(
  a: Rat,
  b: Rat,
  c: Rat,
  d: Rat
): AlgebraicElement<AlgebraicElement<Rat>> {
  // Outer level: [c0, c1] where c0 = a + b·√2 (real part) and
  //                            c1 = c + d·√2 (i-coefficient).
  return algElement([qSqrt2(a, b), qSqrt2(c, d)], Q_SQRT2);
}
