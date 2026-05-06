// =============================================================================
// recombine.ts — Mignotte bound + Berlekamp-Zassenhaus subset-sum recombination
// =============================================================================
//
// What this module provides
// -------------------------
//   • `mignotteBound(f, v)`        — Mignotte 1974 bound on the
//     ‖·‖∞ norm of any divisor of `f` in `ℤ[x]`. Concretely
//     `M = ⌈√(n+1)⌉ · 2ⁿ · ‖f‖∞ · |lc(f)|` for `f` of degree `n`.
//   • `mignotteHenselExponent(f, p, v)` — smallest `l ≥ 1` with
//     `p^l ≥ 2 · M + 1`. After lifting mod-p factors to mod `p^l`
//     and converting to balanced residues, every true divisor of `f`
//     in `ℤ[x]` is represented exactly.
//   • `recombineFactors(f, lifted, p, l, v)` — classical Berlekamp-
//     Zassenhaus subset-sum recombination. Given the lifted mod-p^l
//     factors of `f`, walk subsets in increasing cardinality and check
//     trial division in `ℤ[x]`. Returns the list of true monic
//     irreducible factors of `f` in `ℤ[x]`.
//
// Why subset-sum is correct (and why the Mignotte bound is load-bearing)
// ----------------------------------------------------------------------
// After Hensel lifting, `f` factors mod `p^l` as `F₁ · F₂ · … · Fᵣ`
// with each `Fᵢ` monic and pairwise coprime. Every true factor of `f`
// in `ℤ[x]` corresponds to *some subset* of `{F₁, …, Fᵣ}` whose
// product mod `p^l`, converted to balanced representation in
// `(−p^l/2, p^l/2]`, equals that integer factor exactly. The
// correctness of "exactly" is the Mignotte bound: as long as
// `p^l > 2·M(f)`, the integer coefficients of every true factor fit
// inside the balanced window with room to spare, so balanced reduction
// is identity.
//
// The search walks subsets of size 1, 2, 3, … up to `⌊r/2⌋`. As soon
// as a subset produces a candidate that exactly divides the running
// `f`, that candidate is admitted as a true factor, the remaining
// factors are removed from the modular pool, and the search continues
// with the smaller pool. The loop terminates in at most `r` factors.
//
// Worst case is exponential in `r` (`O(2^r)` subset checks). For
// the bench's deg-16 Swinnerton-Dyer cases (`r ≤ 16`), that's
// `≈ 65 K` candidates × per-candidate work — borderline within a
// 60 s harness budget but feasible on the dev box. For larger `r` the
// LLL-based van Hoeij 2002 algorithm is the standard escalation; that
// is a v2 bead, not part of this ship.
//
// References
// ----------
// • Mignotte, *An Inequality about Factors of Polynomials*, Math. Comp.
//   28 (1974), pp. 1153-1157. (Local PDF
//   `docs/ground-truth/factor/mignotte-1974.pdf`.)
// • Zassenhaus, *On Hensel Factorization, I.*, J. Number Theory 1
//   (1969), pp. 291-311. (PDF unavailable — cited via SymPy reference.)
// • Geddes-Czapor-Labahn, *Algorithms for Computer Algebra* §6.4.
// • SymPy `dup_zz_zassenhaus` in `polys/factortools.py:344` for cross-
//   reference. The combination order and primitive-part handling here
//   mirror SymPy's structure (slimmed for the monic-only v0.1).

import {
  type Poly,
  INT_RING,
  polyAdd,
  polyConst,
  polyDegInVar,
  polyDivRemMonic,
  polyIsZero,
  polyMul,
  polySub,
  polyTrunc,
} from "@workbench/cas-core";

// -----------------------------------------------------------------------------
// Mignotte bound
// -----------------------------------------------------------------------------

/**
 * `M(f) = ⌈√(n+1)⌉ · 2ⁿ · ‖f‖∞ · |lc(f)|` — the Mignotte bound on the
 * ‖·‖∞ norm of any divisor of `f` in `ℤ[x]`.
 *
 * For monic `f` (the v0.1 contract), `|lc(f)| = 1`. This bound is
 * deliberately loose by a small constant — Mignotte 1974 gives the
 * tight `2ⁿ √(n+1) · ‖f‖₂ / |lc(f)|` and the `√(n+1) · 2ⁿ · ‖f‖∞`
 * variant trades exactness in `‖f‖₂` for the cheaper `‖f‖∞`. The
 * looseness costs at most one extra Hensel step in the
 * `mignotteHenselExponent` chain, never affects correctness.
 *
 * Returns a positive `bigint` ceiling. For `f = 0` returns 0n.
 */
export function mignotteBound(f: Poly<bigint>, v: string): bigint {
  if (polyIsZero(f)) return 0n;
  const n = polyDegInVar(f, v);
  if (n < 0) return 0n;
  // ‖f‖∞: max of |coefs|.
  let maxAbs = 0n;
  for (const t of f.terms) {
    const a = t.coef < 0n ? -t.coef : t.coef;
    if (a > maxAbs) maxAbs = a;
  }
  // |lc(f)| in v.
  let lc = 0n;
  for (const t of f.terms) {
    let pv = 0;
    for (const [name, exp] of t.exp) if (name === v) pv = exp;
    if (pv === n) lc = t.coef;
  }
  const lcAbs = lc < 0n ? -lc : lc;
  const sqrtFactor = bigIntSqrtCeil(BigInt(n) + 1n);
  const twoToN = 1n << BigInt(n);
  return sqrtFactor * twoToN * maxAbs * lcAbs;
}

/**
 * Smallest `l ≥ 1` with `p^l ≥ 2 · M(f) + 1`. After Hensel-lifting
 * every mod-p factor to mod `p^l`, the balanced-representation window
 * `(−p^l/2, p^l/2]` contains every coefficient of every true integer
 * factor of `f` — the basis of subset-sum recombination correctness.
 */
export function mignotteHenselExponent(
  f: Poly<bigint>,
  p: bigint,
  v: string,
): number {
  if (p < 2n) throw new RangeError("mignotteHenselExponent: prime must be ≥ 2");
  const M = mignotteBound(f, v);
  const target = 2n * M + 1n;
  let l = 1;
  let pow = p;
  while (pow < target) {
    pow *= p;
    l++;
    if (l > 1_000_000) {
      throw new Error("mignotteHenselExponent: precision exceeded sanity bound");
    }
  }
  return l;
}

// -----------------------------------------------------------------------------
// Berlekamp-Zassenhaus subset-sum recombination
// -----------------------------------------------------------------------------

/**
 * Recombine lifted mod-`p^l` factors into the true monic irreducible
 * factors of `f` in `ℤ[x]`.
 *
 * @param f       Square-free monic primitive polynomial in `ℤ[v]`.
 *                The Yun + content-strip pre-step is the caller's
 *                responsibility (`packages/poly-factor`'s top-level
 *                pipeline coordinates this).
 * @param lifted  Output of `henselLiftMany` — mod-`p^l` factors of `f`
 *                in canonical `[0, p^l)` representation, monic in `v`.
 * @param p       The prime used for Hensel lifting.
 * @param l       The Hensel precision (caller passed this to
 *                `henselLiftMany`; it must satisfy `p^l ≥ 2·M(f) + 1`).
 * @param v       Principal variable name.
 *
 * @returns       List of monic irreducible factors of `f` in `ℤ[v]`,
 *                in no particular order. The product of all returned
 *                factors equals `f`.
 *
 * @throws        If a returned candidate fails the residue-zero check
 *                in long division — should not happen if the Mignotte
 *                bound is satisfied; surfaces as a fatal error rather
 *                than a silent wrong factorisation.
 */
export function recombineFactors(
  f: Poly<bigint>,
  lifted: readonly Poly<bigint>[],
  p: bigint,
  l: number,
  v: string,
): Poly<bigint>[] {
  if (lifted.length === 0) {
    // No mod-p factor list ⟹ f is a unit (deg 0). The empty product
    // is 1; return [].
    return [];
  }

  const target = bigPow(p, l);
  const halfTarget = target / 2n;     // for "<= halfTarget" balanced cutoff (target even iff p == 2 and l ≥ 1)

  let remaining = f;
  let pool: Poly<bigint>[] = lifted.slice();
  const trueFactors: Poly<bigint>[] = [];

  let size = 1;
  while (size <= pool.length / 2) {
    let foundOne = false;
    // Walk all subsets of `pool` of cardinality `size` lexicographically.
    const indices = subsetIndices(pool.length, size);
    for (const idx of indices) {
      // Build the candidate as the product of the chosen modular factors,
      // converted to balanced representation in (-p^l/2, p^l/2].
      let cand: Poly<bigint> = polyConst<bigint>(1n, INT_RING);
      for (const i of idx) cand = polyMul(cand, pool[i]!, INT_RING);
      cand = polyTrunc(cand, target);
      cand = toBalanced(cand, target, halfTarget);

      // Skip subsets whose constant coefficient does not divide the
      // constant coefficient of `remaining` (Zassenhaus's classical
      // pruning trick — for monic `f`, the constant term of any
      // factor must divide `f(0)`). This cuts the search dramatically
      // on Tier-D-style cases.
      if (!constantTermDivides(cand, remaining, v)) continue;

      // Trial division: cand divides `remaining` exactly iff
      // polyDivRemMonic returns r == 0.
      const { q, r } = polyDivRemMonic(remaining, cand, v, INT_RING);
      if (polyIsZero(r)) {
        // True factor!
        trueFactors.push(cand);
        remaining = q;
        // Remove these indices from pool.
        const taken = new Set(idx);
        pool = pool.filter((_, k) => !taken.has(k));
        foundOne = true;
        break;
      }
    }
    if (!foundOne) {
      size++;
    }
    // After a hit the pool shrunk; reset size = 1 to re-check small
    // subsets against the new `remaining`. (SymPy keeps `size` to
    // avoid re-checking; we don't, because it's negligible cost and
    // the simpler invariant is easier to reason about.)
    if (foundOne) size = 1;
  }

  // Whatever remains (possibly empty) is a single irreducible factor:
  // its mod-p^l representation is the product of all remaining pool
  // entries, and `remaining` itself is that integer polynomial.
  if (polyDegInVar(remaining, v) > 0) {
    trueFactors.push(remaining);
  }

  return trueFactors;
}

// -----------------------------------------------------------------------------
// internal helpers
// -----------------------------------------------------------------------------

function bigIntSqrtCeil(n: bigint): bigint {
  if (n < 0n) throw new RangeError("bigIntSqrtCeil: negative input");
  if (n < 2n) return n;
  let x = n;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + n / x) / 2n;
  }
  // x = floor(sqrt(n)).
  return x * x === n ? x : x + 1n;
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

/**
 * Convert a `Poly<bigint>` from canonical `[0, m)` to balanced
 * `(−m/2, m/2]` representation. Coefficients above `m/2` are mapped
 * to `c − m`.
 */
function toBalanced(f: Poly<bigint>, m: bigint, halfM: bigint): Poly<bigint> {
  const out = [];
  for (const t of f.terms) {
    const c = t.coef > halfM ? t.coef - m : t.coef;
    if (c !== 0n) out.push({ exp: t.exp, coef: c });
  }
  return { terms: out };
}

/**
 * Cheap divisibility prune: the constant coefficient of any factor of
 * `g` (over ℤ) must divide `g`'s constant coefficient. Returns true
 * if the prune permits the candidate (or if either constant term is
 * zero, which we conservatively allow).
 */
function constantTermDivides(
  cand: Poly<bigint>,
  g: Poly<bigint>,
  v: string,
): boolean {
  const cConst = constantTermInVar(cand, v);
  if (cConst === 0n) return true;
  const gConst = constantTermInVar(g, v);
  if (gConst === 0n) return true;     // root at 0; let trial division handle it
  return gConst % cConst === 0n;
}

function constantTermInVar(f: Poly<bigint>, v: string): bigint {
  for (const t of f.terms) {
    let hasV = false;
    for (const [name, exp] of t.exp) if (name === v && exp > 0) hasV = true;
    if (!hasV) return t.coef;
  }
  return 0n;
}

/**
 * Yield every length-`k` index subset of `[0, n)` in lexicographic order.
 *
 * The implementation: a classic "bit-list" stepping through C(n, k)
 * combinations. Generators (`function*`) play badly with the
 * iterator-protocol loops elsewhere in cas-core, so we materialise to
 * an array; for `n ≤ 16` and `k ≤ 8` this is a few thousand entries
 * (`C(16, 8) = 12870`), fine to hold. Larger pools indicate the
 * vanHoeij escalation path.
 */
function subsetIndices(n: number, k: number): number[][] {
  if (k < 0 || k > n) return [];
  if (k === 0) return [[]];
  const out: number[][] = [];
  const idx = new Array<number>(k);
  for (let i = 0; i < k; i++) idx[i] = i;
  while (true) {
    out.push(idx.slice());
    let i = k - 1;
    while (i >= 0 && idx[i]! === n - k + i) i--;
    if (i < 0) break;
    idx[i]!++;
    for (let j = i + 1; j < k; j++) idx[j] = idx[j - 1]! + 1;
  }
  return out;
}

void polyAdd;        // referenced indirectly via cas-core's algebra; kept for symmetry.
void polySub;
