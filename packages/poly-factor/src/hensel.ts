// =============================================================================
// hensel.ts — quadratic Hensel lifting from 𝔽_p to ℤ[x]/(p^k)
// =============================================================================
//
// What this module computes
// -------------------------
// Given a primitive monic polynomial `f ∈ ℤ[x]` and a coprime
// factorisation `f ≡ g₀ · h₀ (mod p)` with `g₀, h₀` representable as
// `Poly<bigint>` (canonical residues in `[0, p)`), `henselLiftPair`
// returns `(g, h)` with
//
//     f ≡ g · h   (mod p^k)
//     g ≡ g₀      (mod p)
//     h ≡ h₀      (mod p)
//     lc(h) = 1                      (monic, preserved invariant)
//
// for any caller-chosen target precision `k ≥ 1`. The lift step doubles
// the precision per iteration, so the total number of iterations is
// `⌈log₂ k⌉` rather than `k − 1` — that's the "quadratic" in
// "quadratic Hensel lifting" (Knuth TAOCP 2 §4.6.2 Algorithm D).
//
// Why this is the right substrate
// -------------------------------
// Berlekamp factorisation produces irreducible factors mod a chosen
// prime `p`. To recover the ℤ-factorisation, one needs those mod-p
// factors lifted to mod `p^k` for `k` large enough that the Mignotte
// bound on the integer coefficients of any true ℤ[x]-factor of `f`
// fits inside `[−p^k/2, p^k/2)`. After lifting, recombination
// (Zassenhaus subset-sum or van Hoeij LLL) selects which subsets of
// the lifted factors correspond to true integer factors. This module
// is the second arrow in the chain — between Berlekamp and
// recombination.
//
// Why two-factor and not multi-factor (yet)
// -----------------------------------------
// The bead `scientist-workbench-0fy` describes the two-factor case
// explicitly. Multi-factor lifting is the standard recursive trick:
// pair the Berlekamp output into two halves, lift the pair, recurse
// on each half. That's a follow-up bead. Shipping the pair-step solid
// first is the right discipline — multi-factor is `O(r · log k)`
// pair-step calls; getting the pair-step right is most of the work.
//
// Algorithm — one Hensel step (m → m²)
// ------------------------------------
// Given (m, f, g, h, s, t) with `f ≡ g·h (mod m)`, `s·g + t·h ≡ 1 (mod m)`,
// `lc(h) = 1`, and the size constraints `deg(s) < deg(h)`,
// `deg(t) < deg(g)`, compute (G, H, S, T) mod `m²`:
//
//     1.  e = f − g·h                    (≡ 0 mod m, generally ≠ 0 mod m²)
//     2.  e ← e mod m²
//     3.  (q, r) = polyDivRemMonic(s·e, h)   (long division in ℤ[x] by monic h)
//     4.  G = g + t·e + q·g    mod m²
//     5.  H = h + r            mod m²
//     6.  (b is the residual of the Bezout identity at precision m²)
//         b = s·G + t·H − 1     (≡ 0 mod m, generally ≠ 0 mod m²)
//     7.  b ← b mod m²
//     8.  (c, d) = polyDivRemMonic(s·b, H)
//     9.  S = s − d            mod m²
//    10.  T = t − t·b − c·G    mod m²
//
// The single delicate point: step 3 and step 8 both require that the
// divisor be monic. `lc(h) = 1` by precondition; `lc(H) = lc(h) +
// lc(r) = 1 + 0 = 1` because `deg(r) < deg(h)`, so `H` retains the
// monicity invariant from step to step. The `lc(g) = 1` precondition
// is *not* required by the math — the original Knuth statement allows
// non-monic `g` — but for our v0.1 we assert it because (a) the upstream
// Berlekamp output is normalised to monic mod-p factors, (b) it makes
// the test surface simpler, and (c) breaking it adds fiddly book-
// keeping with negligible value for the Phase-2 path.
//
// Reference: SymPy `dup_zz_hensel_step` in `polys/factortools.py`
// (verbatim transcription of Gathen-Gerhard 1999 §15.4); the staged
// PDF copy at `docs/ground-truth/factor/sympy-factortools.py:223`.

import {
  type Poly,
  INT_RING,
  fpField,
  polyAdd,
  polyConst,
  polyDegInVar,
  polyDivRemMonic,
  polyExtGcd,
  polyIsOne,
  polyIsZero,
  polyMul,
  polySub,
  polyTrunc,
} from "@workbench/cas-core";

export interface HenselLiftResult {
  /** Lifted factor congruent to `g₀` mod p, satisfying `g ≡ g₀ (mod p)` and `f ≡ g·h (mod p^k)`. */
  readonly g: Poly<bigint>;
  /** Lifted factor congruent to `h₀` mod p; monic (lc(h) = 1) by construction. */
  readonly h: Poly<bigint>;
  /** Precision modulus actually achieved: equal to `p^k` exactly. */
  readonly modulus: bigint;
}

/**
 * Quadratic Hensel lift of a two-factor mod-p factorisation to
 * mod `p^k`. See module-level prose for the algorithm and references.
 *
 * @param f       Primitive monic ℤ[x]-polynomial in variable `v`.
 * @param g0      Mod-p factor; `Poly<bigint>` with coefficients in [0, p).
 * @param h0      Mod-p factor; `Poly<bigint>` with coefficients in [0, p).
 *                Must satisfy `lc(h0) = 1` (monic in `v`).
 * @param p       The prime. Must be ≥ 2; primality is the caller's
 *                contract — `polyExtGcd` over `fpField(p)` may throw on
 *                non-prime moduli when an inverse fails to exist.
 * @param k       Target precision exponent, ≥ 1. The output satisfies
 *                `f ≡ g·h (mod p^k)` exactly; if the caller passes
 *                `k = 1`, the inputs are returned (after truncation)
 *                because the precondition is already the postcondition.
 * @param v       Principal variable name.
 *
 * @throws If `gcd(g0, h0) ≠ 1` in `𝔽_p[v]` (precondition violation —
 *         Hensel cannot lift non-coprime factorisations).
 * @throws If `f ≢ g0·h0 (mod p)` (precondition violation).
 * @throws If `lc(h0) ≢ 1 (mod p)` (precondition violation).
 * @throws If `p < 2` or `k < 1`.
 */
export function henselLiftPair(
  f: Poly<bigint>,
  g0: Poly<bigint>,
  h0: Poly<bigint>,
  p: bigint,
  k: number,
  v: string,
): HenselLiftResult {
  if (p < 2n) throw new RangeError(`henselLiftPair: prime must be ≥ 2 (got ${p})`);
  if (!Number.isInteger(k) || k < 1) {
    throw new RangeError(`henselLiftPair: precision k must be a positive integer (got ${k})`);
  }
  if (polyIsZero(f)) throw new Error("henselLiftPair: input polynomial f is zero");

  // Normalise inputs into canonical [0, p) representation. We are forgiving
  // here — accepting any Poly<bigint> with arbitrary integer coefs and
  // reducing — because the upstream Berlekamp surface may emit balanced
  // residues and the symmetry vs. canonical question is best resolved at
  // this boundary, once.
  const g_init = polyTrunc(g0, p);
  const h_init = polyTrunc(h0, p);

  // Check `lc_v(h_init) = 1` mod p.
  const F = fpField(p);
  if (!isMonicIn(h_init, v)) {
    throw new Error(
      `henselLiftPair: precondition lc(h₀) = 1 violated; h₀ must be monic in '${v}' mod p`,
    );
  }

  // Verify f ≡ g·h (mod p). This catches an off-by-one or wrong-prime
  // bug at the boundary rather than letting it manifest as gibberish
  // on iteration 1.
  const product_mod_p = polyTrunc(polyMul(g_init, h_init, INT_RING), p);
  const f_mod_p = polyTrunc(f, p);
  if (!polyEqInt(product_mod_p, f_mod_p)) {
    throw new Error(
      "henselLiftPair: precondition f ≡ g₀·h₀ (mod p) violated",
    );
  }

  // Compute Bezout (s, t) over 𝔽_p[v]: s·g + t·h ≡ 1 mod p. Throws
  // (via polyExtGcd's normalisation) if g, h share a non-trivial factor
  // mod p.
  const ext = polyExtGcd(g_init, h_init, v, F);
  if (!polyIsOne(ext.g, F)) {
    throw new Error(
      "henselLiftPair: precondition gcd(g₀, h₀) = 1 in 𝔽_p[v] violated",
    );
  }
  // ext.s and ext.t are in 𝔽_p[v] coefs (in [0, p)). Re-truncate them
  // through INT_RING-aware arithmetic — they are already canonical
  // [0, p) but we want them as Poly<bigint> for the integer-arithmetic
  // body of the loop (no semantic change; just type-level posture).
  let s = polyTrunc(ext.s, p);
  let t = polyTrunc(ext.t, p);

  // The lift loop. After iteration j (starting from j = 0) we have
  // congruences mod m_j = p^{2^j}. We exit as soon as m_j ≥ p^k, then
  // truncate the result to exactly p^k.
  let g = g_init;
  let h = h_init;
  let m = p;

  const targetModulus = bigPow(p, k);

  // k = 1 case: precondition equals postcondition. Just return the
  // truncated inputs and the (s, t) we computed.
  if (k === 1) {
    return { g, h, modulus: targetModulus };
  }

  // Each iteration squares m. The cap of `k` iterations is generous —
  // the true bound is ⌈log₂ k⌉ — but bounded loops are a defensive
  // habit. If we somehow run k iterations without reaching p^k, that's
  // an algorithm bug worth surfacing.
  for (let iter = 0; iter < k; iter++) {
    if (m >= targetModulus) break;
    const M = m * m;

    // e = (f − g·h) mod M.   By precondition this is 0 mod m, generally
    // non-zero mod M.
    const e = polyTrunc(polySub(f, polyMul(g, h, INT_RING), INT_RING), M);

    // (q, r) = (s·e) ÷ h, monic division.
    const se = polyMul(s, e, INT_RING);
    const { q, r } = polyDivRemMonic(se, h, v, INT_RING);
    const q_M = polyTrunc(q, M);
    const r_M = polyTrunc(r, M);

    // G = g + t·e + q·g; H = h + r.
    const te = polyMul(t, e, INT_RING);
    const qg = polyMul(q_M, g, INT_RING);
    const G = polyTrunc(polyAdd(g, polyAdd(te, qg, INT_RING), INT_RING), M);
    const H = polyTrunc(polyAdd(h, r_M, INT_RING), M);

    // b = s·G + t·H − 1. ≡ 0 mod m, generally non-zero mod M.
    const sG = polyMul(s, G, INT_RING);
    const tH = polyMul(t, H, INT_RING);
    const oneInt = polyConst<bigint>(1n, INT_RING);
    const b = polyTrunc(polySub(polyAdd(sG, tH, INT_RING), oneInt, INT_RING), M);

    // (c, d) = (s·b) ÷ H, monic division.
    const sb = polyMul(s, b, INT_RING);
    const { q: c, r: d } = polyDivRemMonic(sb, H, v, INT_RING);
    const c_M = polyTrunc(c, M);
    const d_M = polyTrunc(d, M);

    // S = s − d; T = t − t·b − c·G.
    const tb = polyMul(t, b, INT_RING);
    const cG = polyMul(c_M, G, INT_RING);
    const S = polyTrunc(polySub(s, d_M, INT_RING), M);
    const T = polyTrunc(
      polySub(polySub(t, tb, INT_RING), cG, INT_RING),
      M,
    );

    g = G;
    h = H;
    s = S;
    t = T;
    m = M;
  }

  // We may have overshot p^k (e.g., k = 5 ran 3 iterations to m = p^8).
  // Truncate to the requested modulus exactly.
  return {
    g: polyTrunc(g, targetModulus),
    h: polyTrunc(h, targetModulus),
    modulus: targetModulus,
  };
}

// -----------------------------------------------------------------------------
// internal helpers
// -----------------------------------------------------------------------------

/** `lc_v(p) = 1` over ℤ — for `Poly<bigint>` polynomials. */
function isMonicIn(p: Poly<bigint>, v: string): boolean {
  if (polyIsZero(p)) return false;
  const d = polyDegInVar(p, v);
  if (d < 0) return false;
  for (const t of p.terms) {
    let pv = 0;
    for (const [name, exp] of t.exp) if (name === v) pv = exp;
    if (pv === d) return t.coef === 1n;
  }
  return false;
}

/**
 * Equality on `Poly<bigint>` without going through a ring's `eq` —
 * cheaper than `polyEq(a, b, INT_RING)` only by an inlined-call's
 * worth, but the type signature makes the call site read correctly
 * (the caller is comparing canonical-form integer polynomials).
 */
function polyEqInt(a: Poly<bigint>, b: Poly<bigint>): boolean {
  if (a.terms.length !== b.terms.length) return false;
  for (let i = 0; i < a.terms.length; i++) {
    if (a.terms[i]!.coef !== b.terms[i]!.coef) return false;
    const ea = a.terms[i]!.exp, eb = b.terms[i]!.exp;
    if (ea.length !== eb.length) return false;
    for (let j = 0; j < ea.length; j++) {
      if (ea[j]![0] !== eb[j]![0]) return false;
      if (ea[j]![1] !== eb[j]![1]) return false;
    }
  }
  return true;
}

function bigPow(base: bigint, exp: number): bigint {
  let r = 1n;
  let b = base;
  let e = exp;
  while (e > 0) {
    if ((e & 1) === 1) r *= b;
    e >>>= 1;
    if (e > 0) b = b * b;
  }
  return r;
}

// =============================================================================
// Multi-factor Hensel — divide-and-conquer over henselLiftPair
// =============================================================================
//
// What this function does
// -----------------------
// Generalises `henselLiftPair` from the two-factor case `f ≡ g·h (mod p)`
// to the `r`-factor case `f ≡ f₁·f₂·…·fᵣ (mod p)`. Each input mod-p
// factor is monic, square-free, and pairwise coprime to the others
// (the standard output shape of Berlekamp factorisation). The result is
// `[F₁, F₂, …, Fᵣ]` with
//
//     f ≡ F₁ · F₂ · … · Fᵣ   (mod p^k)
//     Fᵢ ≡ fᵢ                (mod p)        for every `i`
//     each Fᵢ monic in `v`.
//
// Why the divide-and-conquer pairing
// ----------------------------------
// The recursion: split `[f₁, …, fᵣ]` into halves, multiply each half
// mod `p` to form a coprime pair `(g, h)` with `f ≡ g·h (mod p)`, run
// `henselLiftPair` to get `(G, H)` with `f ≡ G·H (mod p^k)`, then
// recurse: lift the "left" mod-p factor list to mod `p^k` factors of
// `G`, and the "right" list to mod `p^k` factors of `H`. The recursion
// has depth `⌈log₂ r⌉` and total cost `O(r · log r · pair-cost)`.
//
// Reference: SymPy `dup_zz_hensel_lift` in `polys/factortools.py`
// (transcription of Gathen-Gerhard 1999 §15.5).

/**
 * Multi-factor quadratic Hensel lift.
 *
 * @param f         Primitive monic ℤ[x]-polynomial in variable `v`.
 * @param modPFactors  List of monic, pairwise coprime, square-free
 *                  mod-p factors of `f` (Berlekamp output). Each
 *                  represented as `Poly<bigint>` with coefficients in
 *                  `[0, p)`. Their product mod `p` must equal `f mod p`.
 * @param p         The prime.
 * @param k         Target precision exponent. `≥ 1`.
 * @param v         Principal variable name.
 *
 * @returns  `r` lifted factors `[F₁, …, Fᵣ]` with `f ≡ ∏ Fᵢ (mod p^k)`
 *           and `Fᵢ ≡ fᵢ (mod p)`.
 */
export function henselLiftMany(
  f: Poly<bigint>,
  modPFactors: readonly Poly<bigint>[],
  p: bigint,
  k: number,
  v: string,
): Poly<bigint>[] {
  if (p < 2n) throw new RangeError(`henselLiftMany: prime must be ≥ 2 (got ${p})`);
  if (!Number.isInteger(k) || k < 1) {
    throw new RangeError(`henselLiftMany: precision k must be a positive integer (got ${k})`);
  }
  if (modPFactors.length === 0) return [];
  if (modPFactors.length === 1) {
    // Sole factor: f is already that factor (mod p), and we just
    // truncate f to mod p^k.
    return [polyTrunc(f, bigPow(p, k))];
  }

  const r = modPFactors.length;
  const mid = r >> 1;
  const left = modPFactors.slice(0, mid);
  const right = modPFactors.slice(mid);

  // Build half-products mod p.
  let g0: Poly<bigint> = polyConst<bigint>(1n, INT_RING);
  for (const fi of left) g0 = polyTrunc(polyMul(g0, fi, INT_RING), p);
  let h0: Poly<bigint> = polyConst<bigint>(1n, INT_RING);
  for (const fi of right) h0 = polyTrunc(polyMul(h0, fi, INT_RING), p);

  // Lift the half-pair.
  const { g: G, h: H } = henselLiftPair(f, g0, h0, p, k, v);

  // Recurse on each half. The new "f" for the left subtree is `G` (the
  // mod-p^k product of the left factors); its mod-p factor list is the
  // unchanged `left`.
  const liftedLeft = henselLiftMany(G, left, p, k, v);
  const liftedRight = henselLiftMany(H, right, p, k, v);

  return [...liftedLeft, ...liftedRight];
}
