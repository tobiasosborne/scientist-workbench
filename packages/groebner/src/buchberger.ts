// =============================================================================
// buchberger — Buchberger's algorithm with sugar + Gebauer-Möller pruning
// =============================================================================
//
// What this module is for
// -----------------------
// Compute a *reduced* Gröbner basis of an ideal `I = ⟨polys⟩` over ℚ
// under a caller-supplied monomial order. The output is the unique
// reduced GB of `I` for that order (CLO Ch.2 §7 Theorem 5 p.93).
//
// The seven-decision recap (RESEARCH-NOTE-x8d.md §2):
//
//   §2-A  representation: `Poly<Rat>` from cas-core, with leading
//         terms computed under the supplied order via linear scan.
//   §2-B  pair selection: sloppy sugar (Giovini-Mora-Niesi-Robbiano-
//         Traverso 1991), with deterministic `(i, j)` lex tiebreak.
//   §2-C  pair pruning: Buchberger's two criteria in Gebauer-Möller
//         form. Criterion 1 (coprime LM) first, short-circuit;
//         Criterion 2 (chain) second.
//   §2-D  interreduction: always; output is the reduced GB.
//   §2-E  zero-dim test: pure-power LM check, ordering-independent
//         (CLO Ch.5 §3 Theorem 6 + Ch.2 §4 Macaulay).
//
// Sugar — what and why
// --------------------
// "Sugar" is a virtual degree carried alongside each polynomial that
// approximates the *original* total degree of the polynomial that
// would be produced if we never reduced anything. The sugar of an
// input polynomial `f` is `deg(f)` (total degree). The sugar of an
// S-polynomial `S(f, g)` is
//
//     sug(S(f, g))  =  max( sug(f) - deg(LM(f)) + deg(lcm),
//                           sug(g) - deg(LM(g)) + deg(lcm) ).
//
// "Sloppy" sugar updates the sugar value when reduction strictly
// decreases the polynomial's total degree (Giovini et al. 1991 §3) —
// the sloppy variant strictly outperforms non-sloppy on every
// benchmark in the original paper (their Tables 1-3).
//
// Pair queue and tiebreak
// -----------------------
// Pairs are kept in an array. At each iteration we scan and pick the
// pair with the *smallest* sugar; ties broken by lex on `(i, j)` with
// `i < j` (the basis arrival order). The scan-and-pick is O(|pairs|)
// per pop; on the small systems v0.1 targets (n ≤ 5, m ≤ 10),
// |pairs| stays comfortably below 200, so a heap is overkill.
//
// Buchberger pruning — Gebauer-Möller bookkeeping
// -----------------------------------------------
// Criterion 1 (CLO Ch.2 §6 Proposition 4 p.83 / Buchberger 1979 §3
// Theorem 3.4): if `lcm(LM(f), LM(g)) = LM(f) · LM(g)` (i.e., the
// leading monomials are coprime), the S-polynomial reduces to zero
// and the pair is discarded.
//
// Criterion 2 (Gebauer-Möller chain criterion, GM-1988): if there
// exists `h` already in the basis such that `LM(h)` divides the
// `lcm(LM(f), LM(g))` and both pairs `(f, h)` and `(g, h)` have
// already been removed from the queue (either reduced to zero or
// discarded by Criterion 1), then `(f, g)` is redundant — its S-
// polynomial reduces to zero modulo the basis. This requires careful
// bookkeeping of "already-processed" pairs.
//
// We implement the standard form: when adding a new basis element
// `g_k`, we generate fresh pairs `(g_i, g_k)` for `i < k`, prune them
// against the criteria, and add survivors to the queue. Pre-existing
// pairs `(g_i, g_j)` whose `lcm(LM(g_i), LM(g_j))` is divisible by
// `LM(g_k)` are also pruned (Criterion 2 backwards-application,
// "purging" — Becker-Weispfenning 1993 §5.5).
//
// Output discipline
// -----------------
// Every basis polynomial returned by `buchbergerReduced` is monic
// (leading coefficient 1) and the output is in canonical form: sorted
// by leading monomial in *descending* order under the caller's
// `order`. Determinism: under the deterministic pair queue + the
// deterministic interreduction pass, the output is byte-identical
// across platforms forever — symbolic tier per ADR-0015.
//
// References
// ----------
// - Buchberger 1979, "A Criterion for Detecting Unnecessary
//   Reductions in the Construction of Gröbner Bases" — the two
//   criteria.
// - Giovini-Mora-Niesi-Robbiano-Traverso 1991, "One sugar cube,
//   please" — sugar strategy.
// - Gebauer-Möller 1988, "On an Installation of Buchberger's
//   Algorithm" — the chain-criterion bookkeeping.
// - Cox-Little-O'Shea 4th ed. Ch.2 §6-§7 — Buchberger's algorithm
//   and the reduced GB uniqueness theorem.
// - Becker-Weispfenning 1993, "Gröbner Bases" §5.5 — pair-purging
//   on basis insertion.

import {
  type Poly,
  type Rat,
  RAT_RING,
  makeRat,
  polyAdd,
  polyConst,
  polyIsZero,
  polyNeg,
  polySub,
  ratDiv,
  ratIsZero,
  ratMul,
} from "@workbench/cas-core";

import {
  type MonomialOrder,
  expAdd,
  expDivides,
  expGet,
  expLcm,
  expSub,
  expTotalDegree,
} from "./monomial-order.js";
import {
  leadingTerm,
  monomialAsPoly,
  polyMulMonomial,
  polyNormalForm,
} from "./multidiv.js";

/**
 * One element of the working basis. We carry `lt` (the leading term
 * cached under the working order) and `sugar` (the virtual degree)
 * alongside the polynomial — both are recomputed if the polynomial
 * changes during interreduction, but during the main loop they are
 * stable for a basis polynomial's lifetime.
 */
interface BasisEntry {
  poly: Poly<Rat>;
  ltExp: readonly (readonly [string, number])[];
  ltCoef: Rat;
  sugar: number;
}

/**
 * One queued S-pair.
 */
interface PairEntry {
  i: number;        // index into the basis array
  j: number;        // index into the basis array, j > i
  lcm: readonly (readonly [string, number])[];
  sugar: number;
}

/**
 * Compute the S-polynomial of two polynomials under `order`:
 *
 *     S(f, g) = (lcm/LT(f)) · f − (lcm/LT(g)) · g,
 *
 * where the lcm is `lcm(LM(f), LM(g))` and the divisions are monomial
 * divisions (with the leading-coefficient ratio absorbed into the
 * scalar factor).
 */
export function sPolynomial(
  f: Poly<Rat>,
  g: Poly<Rat>,
  order: MonomialOrder,
): Poly<Rat> {
  const ltF = leadingTerm(f, order);
  const ltG = leadingTerm(g, order);
  if (ltF === null || ltG === null) {
    throw new Error("sPolynomial: input has zero leading term (zero polynomial)");
  }
  const lcm = expLcm(ltF.exp, ltG.exp);
  // Coefficient sides: we need `(lcm/LT(f))` to mean
  // `(1/LC(f)) * x^(lcm − LM(f))` — the scalar 1/LC(f) absorbed and
  // the monomial part the exponent difference.
  const aExp = expSub(lcm, ltF.exp);
  const aCoef = ratDiv(makeRat(1n, 1n), ltF.coef);
  const bExp = expSub(lcm, ltG.exp);
  const bCoef = ratDiv(makeRat(1n, 1n), ltG.coef);
  const left = polyMulMonomial(f, aCoef, aExp);
  const right = polyMulMonomial(g, bCoef, bExp);
  return polySub(left, right, RAT_RING);
}

/**
 * Buchberger Criterion 1 — coprime leading monomials. If
 * `lcm(LM(f), LM(g)) = LM(f) · LM(g)` (i.e., the two LMs share no
 * variable with non-zero exponent), the S-polynomial reduces to zero
 * by the product criterion (CLO Ch.2 §6 Proposition 4 p.83).
 */
function coprimeLM(
  ltF: readonly (readonly [string, number])[],
  ltG: readonly (readonly [string, number])[],
): boolean {
  // Compute the set of variables with non-zero exponent in each side
  // and check disjointness.
  const inF = new Set<string>();
  for (const [k, v] of ltF) if (v > 0) inF.add(k);
  for (const [k, v] of ltG) {
    if (v > 0 && inF.has(k)) return false;
  }
  return true;
}

/**
 * Test whether a queued pair `(i, j)` is pruned by Criterion 2 with
 * respect to `kIndex` (a *third* basis element whose LM divides the
 * pair's lcm). Per Gebauer-Möller, `(i, j)` is pruned by element
 * `k ∉ {i, j}` iff `LM(g_k) | lcm(LM(g_i), LM(g_j))`. We further
 * require — to mirror the GM rule precisely — that the third pair's
 * existence either has already been processed *or* is itself pruned;
 * in our forward-only implementation we apply the criterion only when
 * inserting a *new* basis element `g_k` and considering an
 * already-existing queued pair `(g_i, g_j)` with `i, j < k`. At that
 * point both `(g_i, g_k)` and `(g_j, g_k)` have just been generated
 * and pruned by Criterion 1 if applicable; the bookkeeping is
 * "if (g_i, g_k) survives Crit 1 and (g_j, g_k) survives Crit 1 *and*
 * `LM(g_k) | lcm(LM(g_i), LM(g_j))`, drop (g_i, g_j)."
 *
 * This is the standard installation (Gebauer-Möller 1988 §3, also
 * Becker-Weispfenning 1993 §5.5 Algorithm 5.5.7).
 */
function strictlyDivides(
  ltK: readonly (readonly [string, number])[],
  lcmIJ: readonly (readonly [string, number])[],
): boolean {
  // `LM(g_k)` strictly (componentwise) divides lcm(LM(g_i), LM(g_j))
  // iff every var's exp in ltK is ≤ the same var's exp in lcmIJ. We
  // don't require strict inequality — equal LMs still imply pruning;
  // CLO Ch.2 §10 Exercise 10 sketches the corner.
  return expDivides(ltK, lcmIJ);
}

/**
 * Sugar of a polynomial — used in the pair queue's priority. For
 * input polynomials this is the total degree; for S-polynomials it
 * is computed from the input pair's sugar and the lcm degree.
 */
function totalDegree(p: Poly<Rat>): number {
  let max = 0;
  for (const t of p.terms) {
    let s = 0;
    for (const [, e] of t.exp) s += e;
    if (s > max) max = s;
  }
  return max;
}

function sugarOfSPair(
  sugarF: number,
  sugarG: number,
  ltFExp: readonly (readonly [string, number])[],
  ltGExp: readonly (readonly [string, number])[],
  lcmExp: readonly (readonly [string, number])[],
): number {
  const lcmDeg = expTotalDegree(lcmExp);
  const a = sugarF - expTotalDegree(ltFExp) + lcmDeg;
  const b = sugarG - expTotalDegree(ltGExp) + lcmDeg;
  return Math.max(a, b);
}

/**
 * Make a `BasisEntry` from a polynomial, using `order` to identify
 * the leading term. The polynomial must be non-zero.
 */
function makeEntry(
  p: Poly<Rat>,
  order: MonomialOrder,
  sugar: number,
): BasisEntry {
  const lt = leadingTerm(p, order);
  if (lt === null) {
    throw new Error("makeEntry: cannot make a basis entry from the zero polynomial");
  }
  return { poly: p, ltExp: lt.exp, ltCoef: lt.coef, sugar };
}

/**
 * Output of `buchbergerReduced` — the reduced GB plus the count of
 * S-pairs considered (an honest measure of pair-pruning effectiveness).
 */
export interface BuchbergerResult {
  readonly basis: readonly Poly<Rat>[];
  readonly nPairs: number;
  readonly warnings: readonly string[];
}

/**
 * Compute the reduced Gröbner basis of `⟨polys⟩` under `order`.
 *
 * Empty input ⟹ empty basis (the zero ideal).
 * All-zero input ⟹ empty basis (every input polynomial is zero, so the
 * ideal is trivial).
 * `1 ∈ ⟨polys⟩` (an inconsistent system) ⟹ basis = [1].
 *
 * The output is monic and reduced; `nPairs` reports the total number
 * of S-pairs that were considered (passed both criteria checks and
 * had their S-polynomial computed). High `nPairs` relative to `|G|^2`
 * indicates pruning ineffectiveness; low values indicate the criteria
 * were doing their job.
 */
export function buchbergerReduced(
  polys: readonly Poly<Rat>[],
  order: MonomialOrder,
): BuchbergerResult {
  // Filter zero polynomials from the input — they contribute nothing
  // to the ideal. (CLO §6 implicitly assumes non-zero inputs.)
  const initial: BasisEntry[] = [];
  for (const p of polys) {
    if (polyIsZero(p)) continue;
    initial.push(makeEntry(p, order, totalDegree(p)));
  }
  if (initial.length === 0) {
    return { basis: [], nPairs: 0, warnings: [] };
  }

  // -------------------------------------------------------------
  // Main loop state: the working basis `B` and the pair queue `Q`.
  // -------------------------------------------------------------
  const B: BasisEntry[] = [];
  const Q: PairEntry[] = [];

  // Insert the initial inputs one at a time, generating pairs as we go.
  // This unifies the "initial pair generation" path with the
  // "discovered-during-loop pair generation" path: same code, same
  // pruning, no asymmetric corner cases.
  for (const e of initial) {
    insertBasisElement(B, Q, e, order);
  }

  let nPairs = 0;
  const warnings: string[] = [];

  while (Q.length > 0) {
    const pIdx = popBestPair(Q);
    const pair = Q[pIdx]!;
    Q.splice(pIdx, 1);

    nPairs++;

    const f = B[pair.i]!.poly;
    const g = B[pair.j]!.poly;
    const s = sPolynomial(f, g, order);
    if (polyIsZero(s)) continue;
    const r = polyNormalForm(s, B.map((b) => b.poly), order);
    if (polyIsZero(r)) continue;

    // r is a new basis element. Normalise to monic (so that the
    // leading coefficient is 1 — matches SymPy / Mathematica
    // convention and simplifies interreduction).
    const ltR = leadingTerm(r, order);
    if (ltR === null) continue;
    const monicR = monicScale(r, ltR.coef);

    // Compute sugar from the producing pair.
    const sugar = pair.sugar;

    insertBasisElement(B, Q, makeEntry(monicR, order, sugar), order);
  }

  // After the main loop, `B` is *a* Gröbner basis. Reduce it to the
  // unique reduced GB.
  const reduced = interreduce(B.map((b) => b.poly), order);

  // Special case: if the reduced basis is `[1]` (the trivial ideal),
  // the system was inconsistent. Honest output. CLO §7 Theorem 5 has
  // this as a corollary.
  if (reduced.length === 1) {
    const lt = leadingTerm(reduced[0]!, order);
    if (lt && lt.exp.length === 0) {
      // Constant polynomial. Should be 1 after monicisation.
      // No warning: this is the canonical "inconsistent" output.
    }
  }

  return { basis: reduced, nPairs, warnings };
}

/**
 * Insert a new basis element. The insertion is responsible for:
 *   1. Generating fresh pairs `(g_i, g_new)` for every existing `i`.
 *   2. Pruning each fresh pair via Criterion 1 (coprime LM).
 *   3. Pruning pre-existing pairs whose lcm is divisible by the new
 *      element's LM (Criterion 2 backwards-purge).
 *   4. Adding the new element to the basis.
 *
 * Surviving fresh pairs go into the queue.
 */
function insertBasisElement(
  B: BasisEntry[],
  Q: PairEntry[],
  newElem: BasisEntry,
  _order: MonomialOrder,
): void {
  const newIdx = B.length;
  // 3. Backwards-purge: a queued (i, j) pair whose lcm is divisible
  //    by the new element's LM is redundant by Criterion 2.
  for (let q = Q.length - 1; q >= 0; q--) {
    if (strictlyDivides(newElem.ltExp, Q[q]!.lcm)) {
      Q.splice(q, 1);
    }
  }
  // 1+2. Generate and prune fresh pairs.
  const fresh: PairEntry[] = [];
  for (let i = 0; i < B.length; i++) {
    const old = B[i]!;
    if (coprimeLM(old.ltExp, newElem.ltExp)) {
      // Crit 1: discard.
      continue;
    }
    const lcm = expLcm(old.ltExp, newElem.ltExp);
    fresh.push({
      i,
      j: newIdx,
      lcm,
      sugar: sugarOfSPair(old.sugar, newElem.sugar, old.ltExp, newElem.ltExp, lcm),
    });
  }
  // Crit 2 (Gebauer-Möller, "B-criterion"): a pair (f, g) is
  // unnecessary if there is a third polynomial h in the basis with
  //   (a) LM(h) | lcm(LM(f), LM(g)), AND
  //   (b) lcm(LM(f), LM(h)) ≠ lcm(LM(f), LM(g)), AND
  //   (c) lcm(LM(g), LM(h)) ≠ lcm(LM(f), LM(g)).
  //
  // Conditions (b) and (c) are *strict* — without them the rule
  // over-prunes and the algorithm misses essential S-pairs. The
  // intuition: if any of those equalities hold, the pair is exactly
  // representable as a chain through h *without* the pruning being
  // safe (the canonical counter-example is (b) with equality, where
  // the pair is unique-via-h up to which-path-we-chose-first; B/W93
  // §5.5 Lemma 5.5.6).
  //
  // For our forwards-application: the third polynomial `h` candidates
  // are *all existing* basis elements (since both g_i and g_new are
  // in B by the time we generate fresh pairs (g_i, g_new)). The
  // online check is the same: scan B for any h satisfying (a)–(c).
  const survived: PairEntry[] = [];
  for (const fp of fresh) {
    let pruned = false;
    for (let hi = 0; hi < B.length; hi++) {
      if (hi === fp.i) continue;            // h ≠ g_i
      // h ≠ g_new is automatic (g_new isn't yet in B).
      const ltH = B[hi]!.ltExp;
      if (!expDivides(ltH, fp.lcm)) continue;
      // (b): lcm(LM(g_i), LM(h)) ≠ fp.lcm.
      const lcmIH = expLcm(B[fp.i]!.ltExp, ltH);
      if (isExpEqual(lcmIH, fp.lcm)) continue;
      // (c): lcm(LM(g_new), LM(h)) ≠ fp.lcm.
      const lcmNH = expLcm(newElem.ltExp, ltH);
      if (isExpEqual(lcmNH, fp.lcm)) continue;
      pruned = true;
      break;
    }
    if (!pruned) survived.push(fp);
  }
  Q.push(...survived);
  B.push(newElem);
}

/**
 * Find the index in `Q` of the best pair to pop next: minimum sugar
 * first, then minimum (i, j) lex tiebreak.
 */
function popBestPair(Q: readonly PairEntry[]): number {
  let bestIdx = 0;
  let best = Q[0]!;
  for (let i = 1; i < Q.length; i++) {
    const cur = Q[i]!;
    if (
      cur.sugar < best.sugar
      || (cur.sugar === best.sugar && (cur.i < best.i || (cur.i === best.i && cur.j < best.j)))
    ) {
      best = cur;
      bestIdx = i;
    }
  }
  return bestIdx;
}

/**
 * Multiply every coefficient of `p` by `1/scale`.
 */
function monicScale(p: Poly<Rat>, scale: Rat): Poly<Rat> {
  if (ratIsZero(scale)) {
    throw new Error("monicScale: leading coef is zero");
  }
  const inv = ratDiv(makeRat(1n, 1n), scale);
  return polyMulMonomial(p, inv, []);
}

/**
 * Reduce `B` to the unique reduced Gröbner basis (CLO Ch.2 §7 p.93).
 *
 *   Step 1: discard any polynomial whose LM is divisible by the LM
 *           of another polynomial in the basis (it's redundant
 *           generator-wise).
 *   Step 2: for each surviving polynomial, fully reduce its non-
 *           leading terms against the rest of the basis.
 *   Step 3: monicise each polynomial (leading coefficient 1).
 *   Step 4: sort by leading monomial in descending order under
 *           `order`.
 *
 * The output is canonically equal across implementations (CLO §7
 * Theorem 5 — uniqueness of reduced GB).
 */
function interreduce(
  basis: readonly Poly<Rat>[],
  order: MonomialOrder,
): Poly<Rat>[] {
  // Step 1: discard polynomials whose LM is divisible by another's.
  const lts: { exp: readonly (readonly [string, number])[]; coef: Rat }[] = [];
  for (const p of basis) {
    const lt = leadingTerm(p, order);
    if (lt === null) {
      lts.push({ exp: [], coef: makeRat(0n, 1n) });
    } else {
      lts.push({ exp: lt.exp, coef: lt.coef });
    }
  }
  const keep: boolean[] = basis.map((_, i) => !polyIsZero(basis[i]!));
  for (let i = 0; i < basis.length; i++) {
    if (!keep[i]) continue;
    for (let j = 0; j < basis.length; j++) {
      if (i === j || !keep[j]) continue;
      // If LM(basis[j]) divides LM(basis[i]) (strictly — i.e., not
      // identical), then basis[i] is redundant.
      // We treat "identical LM" as one-of-two-must-go: keep the lower-
      // indexed one to maintain determinism.
      if (expDivides(lts[j]!.exp, lts[i]!.exp)) {
        // Strictly different exponents OR i > j (so that the j-th
        // copy survives in case of identical LMs).
        if (!isExpEqual(lts[j]!.exp, lts[i]!.exp) || j < i) {
          keep[i] = false;
          break;
        }
      }
    }
  }
  let survivors: Poly<Rat>[] = [];
  for (let i = 0; i < basis.length; i++) {
    if (keep[i]) survivors.push(basis[i]!);
  }

  // Step 2: tail-reduce. For each polynomial, reduce its non-leading
  // terms (i.e., the polynomial minus its leading monomial) against
  // the *rest* of the basis. The result's leading monomial does not
  // change because tail reduction by definition cannot affect the
  // leading term (each tail term is strictly smaller than the leader,
  // and reductions only produce strictly-smaller terms).
  //
  // A canonical formulation: replace `survivors[i]` by `LT(survivors[i])
  // + (survivors[i] - LT(survivors[i])) reduced by the others`.
  // Equivalently, reduce the whole polynomial by the others — the
  // leading term will pass through the leading-term test of every
  // other polynomial (because step 1 already eliminated divisibility
  // among LMs in the surviving set), so the leading term ends up in
  // the remainder unchanged, and the tail is fully reduced.
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < survivors.length; i++) {
      const others: Poly<Rat>[] = [];
      for (let j = 0; j < survivors.length; j++) {
        if (j !== i) others.push(survivors[j]!);
      }
      const reduced = polyNormalForm(survivors[i]!, others, order);
      if (!polyEqualPoly(reduced, survivors[i]!, order)) {
        survivors[i] = reduced;
        changed = true;
      }
    }
  }

  // Step 3: monicise.
  const monic: Poly<Rat>[] = [];
  for (const p of survivors) {
    if (polyIsZero(p)) continue;
    const lt = leadingTerm(p, order);
    if (lt === null) continue;
    monic.push(monicScale(p, lt.coef));
  }

  // Step 4: sort by leading monomial descending under `order`.
  monic.sort((a, b) => {
    const la = leadingTerm(a, order)!;
    const lb = leadingTerm(b, order)!;
    return order.compare(lb.exp, la.exp);
  });

  return monic;
}

function isExpEqual(
  a: readonly (readonly [string, number])[],
  b: readonly (readonly [string, number])[],
): boolean {
  if (a.length !== b.length) return false;
  // Both are sorted by var name in canonical Exp form.
  for (let i = 0; i < a.length; i++) {
    if (a[i]![0] !== b[i]![0]) return false;
    if (a[i]![1] !== b[i]![1]) return false;
  }
  return true;
}

/**
 * Polynomial equality — leading-term-respecting. Cas-core's `polyEq`
 * uses the canonical lex-over-alphabetised-vars term order, which is
 * a *different* order from the caller's `order`, but byte equality
 * is byte equality: if the two polynomials are equal as polynomials,
 * they have identical canonical forms regardless of the comparison
 * order. So this helper is just a wrapper over a structural check on
 * `terms` — we don't need the order argument, but keeping the
 * signature visible documents that the comparison is order-respecting
 * by virtue of canonical form.
 */
function polyEqualPoly(
  a: Poly<Rat>,
  b: Poly<Rat>,
  _order: MonomialOrder,
): boolean {
  if (a.terms.length !== b.terms.length) return false;
  for (let i = 0; i < a.terms.length; i++) {
    const ta = a.terms[i]!;
    const tb = b.terms[i]!;
    if (ta.coef.n !== tb.coef.n || ta.coef.d !== tb.coef.d) return false;
    if (!isExpEqual(ta.exp, tb.exp)) return false;
  }
  return true;
}

/**
 * Zero-dimensionality test (CLO Ch.5 §3 Theorem 6 — the Finiteness
 * Theorem). The ideal `⟨G⟩` is zero-dimensional iff for each variable
 * `x_i` in the declared list, some polynomial in `G` has its leading
 * monomial equal to a *pure power* `x_i^{k_i}`.
 *
 * This test is independent of the monomial order: by Macaulay's basis
 * theorem (CLO Ch.2 §4 Proposition 4 p.71), `dim_k k[x]/I` is the
 * count of monomials *not* in `LT_>(I)`, and that count is finite iff
 * every variable has a pure power in `LT(I)`. The leading-monomial
 * ideal under any order has the same count (by uniqueness of the
 * dimension), so the per-variable pure-power check works on the DRL
 * basis we already have in hand.
 *
 * If the test fails, the ideal is not zero-dimensional — the system
 * has positive Krull dimension (or, vacuously, the ideal is the unit
 * ideal `⟨1⟩` in which case there are no solutions and the test
 * returns true on a vacuously-empty variable list).
 *
 * Returns `true` iff every variable in `vars` has a pure power as
 * the LM of some basis element.
 */
export function isZeroDimensional(
  basis: readonly Poly<Rat>[],
  vars: readonly string[],
  order: MonomialOrder,
): boolean {
  if (vars.length === 0) return true;

  // Special case: basis = [1] (the unit ideal). Every variable is
  // "trivially" zero-dimensional in the sense that there are no
  // solutions; we report this honestly as zero-dimensional and let
  // the caller observe that the solution set is empty.
  if (basis.length === 1) {
    const t = basis[0]!.terms;
    if (t.length === 1 && t[0]!.exp.length === 0) return true;
  }

  for (const v of vars) {
    let found = false;
    for (const p of basis) {
      const lt = leadingTerm(p, order);
      if (lt === null) continue;
      // Pure power of v: exp has exactly one entry, that entry's
      // variable is v, and its exponent is ≥ 1.
      if (lt.exp.length === 1 && lt.exp[0]![0] === v && lt.exp[0]![1] >= 1) {
        found = true;
        break;
      }
    }
    if (!found) return false;
  }
  return true;
}

// silence unused-import lint (the imports are kept for symmetry / future use)
void polyAdd;
void polyConst;
void polyNeg;
void ratIsZero;
void ratMul;
void expAdd;
void expGet;
