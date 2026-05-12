// =============================================================================
// fglm — DRL → lex Gröbner-basis conversion (Faugère-Gianni-Lazard-Mora 1993)
// =============================================================================
//
// What this module is for
// -----------------------
// The Buchberger main loop (`buchberger.ts`) computes a reduced GB
// under DRL ordering — the cheapest order on most benchmark systems.
// Solution extraction wants a *lex* GB: under lex with `vars[0]` ranked
// highest, the last variable's univariate equation is in the basis,
// and each higher variable is expressed in terms of the lower ones
// (the "elimination" property). Going DRL → lex via Buchberger again
// is wasteful — the FGLM algorithm exploits the fact that we already
// know `dim_ℚ(ℚ[x]/I)` from the DRL basis (it's `|B(G_DRL)|`, the
// natural-basis size) to convert in O(n · |B|³) time, much cheaper
// than recomputing.
//
// Algorithm overview (FGLM 1993 §3 NewBasis)
// ------------------------------------------
//   Input: DRL Gröbner basis G_DRL; lex variable ordering with
//          `vars[0]` highest-ranked.
//   Output: lex Gröbner basis G_lex (reduced).
//
//   1. Compute the natural basis B = monomials *not* in LT_DRL(G_DRL).
//      |B| = D = the degree of the ideal = number of solutions
//      counted with multiplicity.
//   2. For each `m ∈ B`, compute the normal form `NF(m)` mod G_DRL —
//      a ℚ-linear combination of B elements. This builds the
//      multiplication maps `M_{x_i}: B → B` represented as |B|×|B|
//      ℚ-matrices.
//   3. NewBasis traversal: walk monomials in *lex ascending* order
//      starting from `1, x_n, x_n², …, x_n^d, x_{n-1}, x_{n-1}·x_n,
//      …`. At each new monomial `m`:
//        a. Compute `NF(m)` mod G_DRL as a vector in `ℚ^|B|` (using
//           the multiplication maps and the normal form of the
//           previous-monomial step).
//        b. Test whether the current `NF(m)` is a ℚ-linear
//           combination of the normal forms collected so far for the
//           lex-staircase elements. (Linear-algebra check.)
//        c. If linearly dependent, the relation gives a new lex GB
//           element: `m − Σ c_i · m_i` reduces to 0 mod G_DRL.
//           Add this polynomial to G_lex; record the monomial `m` as
//           "barred" — i.e., not part of the lex-staircase.
//        d. If linearly independent, add `(m, NF(m))` to the lex
//           staircase and continue with the next-lex-larger monomial.
//   4. Termination: when every monomial that *could* extend the lex
//      staircase has been processed (in practice, when the count of
//      staircase elements reaches `D`, no further monomial can be
//      independent), stop.
//
// Wire-up details
// ---------------
// The natural basis `B(G_DRL)` is enumerated by ascending DRL order.
// Concretely: degree by degree, within each degree by DRL tiebreak
// over `vars`. We produce `B` as an array of exponent vectors
// (Exp objects) and a parallel index map `expKey → index in B`.
//
// Multiplication maps: `M_{x_i}` is a |B|×|B| matrix where column j
// is the normal form of `x_i · B[j]` expressed as coefficients in B.
// For `x_i · B[j] ∈ B` (a "boundary cross") the column is a unit
// vector; for `x_i · B[j] ∉ B` we have to reduce `x_i · B[j]` mod
// G_DRL and read the coefficients off the result. The reductions
// are O(|G| · |B|) each, total O(n · |B|² · |G|) for building all
// maps. On v0.1 target systems this is fast enough.
//
// References
// ----------
// - Faugère-Gianni-Lazard-Mora 1993, "Efficient Computation of Zero-
//   Dimensional Gröbner Bases by Change of Ordering," J. Symb. Comp.
// - Cox-Little-O'Shea, "Using Algebraic Geometry," Ch.2 §3 — FGLM.

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
  ratAdd,
  ratDiv,
  ratIsZero,
  ratMul,
  ratNeg,
  ratSub,
} from "@workbench/cas-core";

import {
  type MonomialOrder,
  drlOrder,
  expGet,
  lexOrder,
  expAdd,
} from "./monomial-order.js";
import { leadingTerm, monomialAsPoly, polyNormalForm } from "./multidiv.js";
import { isZeroDimensional } from "./buchberger.js";

/**
 * Internal: enumerate the natural basis B(G_DRL) for the given DRL
 * basis. The natural basis is the set of monomials NOT divisible by
 * any leading monomial of `G_DRL`. By CLO Ch.2 §4 Proposition 4
 * (Macaulay's basis theorem), |B(G_DRL)| = dim_ℚ(ℚ[x]/I) when the
 * ideal is zero-dimensional.
 *
 * The enumeration walks monomials by ascending total degree, then
 * within each degree by ascending DRL order. We expand by degree
 * until a "fully covered" check fires: a degree d is fully covered
 * iff every monomial of degree d is divisible by some LT(G_DRL); at
 * that point all higher degrees are also covered (by monotonicity of
 * the LT-divisibility relation).
 */
function naturalBasis(
  gDrl: readonly Poly<Rat>[],
  vars: readonly string[],
  drl: MonomialOrder,
): { exps: (readonly (readonly [string, number])[])[]; index: Map<string, number> } {
  const ltExps: (readonly (readonly [string, number])[])[] = [];
  for (const p of gDrl) {
    const lt = leadingTerm(p, drl);
    if (lt !== null) ltExps.push(lt.exp);
  }

  const exps: (readonly (readonly [string, number])[])[] = [];
  const index = new Map<string, number>();

  // BFS over monomials. Frontier carries unique exponent vectors not
  // yet emitted. We expand by multiplying by each variable in `vars`
  // (which is the standard "neighbours in the integer lattice"
  // generation) and admit the result iff (a) it's not divisible by
  // any LT, (b) it hasn't been emitted yet.
  const seen = new Set<string>();
  const ZERO_EXP: readonly (readonly [string, number])[] = [];
  const queue: { exp: readonly (readonly [string, number])[] }[] = [
    { exp: ZERO_EXP },
  ];
  seen.add(expKey(ZERO_EXP));

  while (queue.length > 0) {
    const cur = queue.shift()!;
    if (anyDivides(ltExps, cur.exp)) continue;
    const key = expKey(cur.exp);
    if (!index.has(key)) {
      index.set(key, exps.length);
      exps.push(cur.exp);
    }
    // Generate neighbours by appending one to each variable's exp.
    for (const v of vars) {
      const next = expIncrement(cur.exp, v);
      const nk = expKey(next);
      if (seen.has(nk)) continue;
      seen.add(nk);
      queue.push({ exp: next });
    }
  }

  // Sort B by ascending DRL order so the natural-basis enumeration is
  // deterministic. (Per RESEARCH-NOTE §4 — fixed enumeration order.)
  const indexed = exps.map((e, i) => ({ e, i }));
  indexed.sort((a, b) => drl.compare(a.e, b.e));
  const sorted: (readonly (readonly [string, number])[])[] = [];
  const newIndex = new Map<string, number>();
  for (const { e } of indexed) {
    newIndex.set(expKey(e), sorted.length);
    sorted.push(e);
  }
  return { exps: sorted, index: newIndex };
}

function anyDivides(
  lts: readonly (readonly (readonly [string, number])[])[],
  exp: readonly (readonly [string, number])[],
): boolean {
  for (const lt of lts) if (expDividesLocal(lt, exp)) return true;
  return false;
}

function expDividesLocal(
  a: readonly (readonly [string, number])[],
  b: readonly (readonly [string, number])[],
): boolean {
  for (const [k, v] of a) {
    if (v <= 0) continue;
    let bv = 0;
    for (const [k2, v2] of b) if (k2 === k) { bv = v2; break; }
    if (bv < v) return false;
  }
  return true;
}

function expKey(e: readonly (readonly [string, number])[]): string {
  // Compact, deterministic, human-readable for debug.
  if (e.length === 0) return "";
  return e.map(([k, v]) => `${k}^${v}`).join(",");
}

function expIncrement(
  e: readonly (readonly [string, number])[],
  v: string,
): readonly (readonly [string, number])[] {
  // Increment exponent of v by 1 (insert in sorted position if absent).
  const out: [string, number][] = [];
  let inserted = false;
  for (const [name, exp] of e) {
    if (!inserted && name > v) {
      out.push([v, 1]);
      inserted = true;
    }
    if (name === v) {
      out.push([v, exp + 1]);
      inserted = true;
    } else {
      out.push([name, exp]);
    }
  }
  if (!inserted) out.push([v, 1]);
  return out;
}

/**
 * Reduce a single monomial `m` modulo G_DRL and return its
 * coefficient vector in the natural basis B. Used both for building
 * the multiplication maps (every `x_i · b ∉ B` is reduced this way)
 * and for the FGLM main-loop monomial reductions.
 *
 * Pre-condition: the ideal is zero-dimensional, so the normal form
 * is a finite ℚ-linear combination of B elements (Macaulay).
 */
function reduceMonomialToBVector(
  exp: readonly (readonly [string, number])[],
  gDrl: readonly Poly<Rat>[],
  drl: MonomialOrder,
  bIndex: Map<string, number>,
  bSize: number,
): Rat[] {
  const m = monomialAsPoly(makeRat(1n, 1n), exp);
  const r = polyNormalForm(m, gDrl, drl);
  return polyToBVector(r, bIndex, bSize);
}

/**
 * Convert a polynomial that is fully reduced w.r.t. G_DRL (i.e., its
 * monomials all lie in B) into its coefficient vector representation.
 */
function polyToBVector(
  p: Poly<Rat>,
  bIndex: Map<string, number>,
  bSize: number,
): Rat[] {
  const v: Rat[] = new Array(bSize).fill(makeRat(0n, 1n));
  if (polyIsZero(p)) return v;
  for (const t of p.terms) {
    const k = expKey(t.exp);
    const idx = bIndex.get(k);
    if (idx === undefined) {
      throw new Error(
        `polyToBVector: monomial ${k || "1"} not in natural basis — `
        + `polynomial was not fully reduced mod G_DRL (a Buchberger bug)`,
      );
    }
    v[idx] = ratAdd(v[idx]!, t.coef);
  }
  return v;
}

/**
 * Build the |B|×|B| multiplication-by-`x_i` matrix. Column j of the
 * matrix is `NF(x_i · B[j])` expressed as a coefficient vector in B.
 *
 * Returns the matrix as `M[col][row]` so that `M[j][r]` is the
 * coefficient of `B[r]` in `NF(x_i · B[j])`. (This matches the
 * "matrix-vector multiply with column j as the image of basis
 * vector e_j" mental model.)
 */
function buildMulMatrix(
  v: string,
  bExps: readonly (readonly (readonly [string, number])[])[],
  bIndex: Map<string, number>,
  gDrl: readonly Poly<Rat>[],
  drl: MonomialOrder,
): Rat[][] {
  const cols: Rat[][] = [];
  for (const b of bExps) {
    const product = expIncrement(b, v);
    cols.push(reduceMonomialToBVector(product, gDrl, drl, bIndex, bExps.length));
  }
  return cols;
}

/**
 * Multiply matrix `M[col][row]` by vector `v[row]` to get the result
 * `result[row] = Σ_col M[col][row] · v[col]`. Plain dense ℚ-matrix-
 * vector multiplication.
 */
function matVec(m: readonly (readonly Rat[])[], v: readonly Rat[]): Rat[] {
  const n = v.length;
  const out: Rat[] = new Array(n).fill(makeRat(0n, 1n));
  for (let col = 0; col < n; col++) {
    if (ratIsZero(v[col]!)) continue;
    const c = m[col]!;
    for (let row = 0; row < n; row++) {
      const term = ratMul(c[row]!, v[col]!);
      if (!ratIsZero(term)) {
        out[row] = ratAdd(out[row]!, term);
      }
    }
  }
  return out;
}

/**
 * Linear-dependence test via column-augmented Gaussian elimination on
 * the staircase matrix. The staircase matrix `S` has columns equal to
 * the previously-collected `NF(m_i)` vectors (one column per lex-
 * staircase monomial). We test whether `target` is a ℚ-linear
 * combination of S's columns; if so, return the coefficients.
 *
 * Implementation uses pivoted row reduction, building a |B|+1 × k+1
 * augmented matrix `[S | target]` and reducing. If the augmented
 * column reduces to zero except in pivots, dependence holds; the
 * coefficients can be read off by back-substitution.
 *
 * Throughout this is exact ℚ arithmetic — no floats, no scaling
 * heuristics.
 */
function linearDependence(
  staircase: readonly Rat[][], // staircase[i] is the i-th NF vector
  target: readonly Rat[],
): { dependent: true; coeffs: Rat[] } | { dependent: false } {
  const k = staircase.length;
  if (k === 0) {
    // 0 vectors span only the zero vector. Target is dependent iff it
    // is zero.
    for (const r of target) if (!ratIsZero(r)) return { dependent: false };
    return { dependent: true, coeffs: [] };
  }
  const n = target.length;
  // Augmented |n| × (k+1) matrix in row-major form.
  const A: Rat[][] = [];
  for (let r = 0; r < n; r++) {
    const row: Rat[] = [];
    for (let c = 0; c < k; c++) row.push(staircase[c]![r]!);
    row.push(target[r]!);
    A.push(row);
  }
  // Gaussian elimination over the first k columns.
  let pivotRow = 0;
  const pivotForCol: number[] = [];
  for (let col = 0; col < k && pivotRow < n; col++) {
    // Find a non-zero entry at or below pivotRow.
    let r = -1;
    for (let rr = pivotRow; rr < n; rr++) {
      if (!ratIsZero(A[rr]![col]!)) { r = rr; break; }
    }
    if (r < 0) {
      pivotForCol.push(-1);
      continue;
    }
    if (r !== pivotRow) {
      const tmp = A[pivotRow]!;
      A[pivotRow] = A[r]!;
      A[r] = tmp;
    }
    const piv = A[pivotRow]![col]!;
    // Scale pivot row to make pivot 1.
    const invPiv = ratDiv(makeRat(1n, 1n), piv);
    for (let c = col; c <= k; c++) {
      A[pivotRow]![c] = ratMul(A[pivotRow]![c]!, invPiv);
    }
    // Eliminate other rows.
    for (let rr = 0; rr < n; rr++) {
      if (rr === pivotRow) continue;
      const factor = A[rr]![col]!;
      if (ratIsZero(factor)) continue;
      for (let c = col; c <= k; c++) {
        A[rr]![c] = ratSub(A[rr]![c]!, ratMul(factor, A[pivotRow]![c]!));
      }
    }
    pivotForCol.push(pivotRow);
    pivotRow++;
  }
  // Check that the augmented column has no non-zero entries below the
  // last pivot row.
  for (let r = pivotRow; r < n; r++) {
    if (!ratIsZero(A[r]![k]!)) return { dependent: false };
  }
  // Read coefficients from the augmented column at the pivot rows.
  const coeffs: Rat[] = new Array(k).fill(makeRat(0n, 1n));
  for (let col = 0; col < k; col++) {
    const pr = pivotForCol[col];
    if (pr === undefined || pr < 0) continue;
    coeffs[col] = A[pr]![k]!;
  }
  return { dependent: true, coeffs };
}

/**
 * Build the polynomial representing the lex GB element when a linear
 * dependence is found. If `m − Σ c_i · m_i` reduces to zero mod
 * G_DRL, this polynomial *is* a member of the ideal — and its leading
 * monomial under lex is `m` (since `m_i` are lex-strictly less than
 * `m` by the FGLM staircase construction). So the polynomial is a
 * valid lex GB element.
 *
 * The output is monicised here (leading coef 1) — the FGLM pass
 * accumulates already-monicised lex GB elements so that the final
 * `interreduce` step in the caller has less work to do.
 */
function buildLexElement(
  m: readonly (readonly [string, number])[],
  staircaseMonomials: readonly (readonly (readonly [string, number])[])[],
  coeffs: readonly Rat[],
): Poly<Rat> {
  // Start with monomial m (coefficient 1).
  let p = monomialAsPoly(makeRat(1n, 1n), m);
  for (let i = 0; i < staircaseMonomials.length; i++) {
    const c = coeffs[i]!;
    if (ratIsZero(c)) continue;
    const term = monomialAsPoly(ratNeg(c), staircaseMonomials[i]!);
    p = polyAdd(p, term, RAT_RING);
  }
  return p;
}

/**
 * `fglm(gDrl, vars)` — convert a reduced DRL Gröbner basis to a
 * reduced lex Gröbner basis with `vars[0]` ranked highest.
 *
 * Pre-condition: `vars` enumerates exactly the variables appearing
 * in the input ideal, in the same order as the DRL basis was
 * computed. The ideal must be zero-dimensional; the function throws
 * if it is not (the caller — `solveGroebner` — should test
 * zero-dimensionality before invoking FGLM and emit the appropriate
 * refusal). Throwing here is honest: a positive-dim ideal has
 * infinite |B|, no termination, no answer.
 *
 * Returns the lex GB sorted by leading monomial in *descending* lex
 * order (so the univariate-in-`vars[n-1]` polynomial sits at the
 * end — matches SymPy/Mathematica convention).
 */
export function fglm(
  gDrl: readonly Poly<Rat>[],
  vars: readonly string[],
): readonly Poly<Rat>[] {
  if (vars.length === 0) return [];

  const drl = drlOrder(vars);
  const lex = lexOrder(vars);

  if (!isZeroDimensional(gDrl, vars, drl)) {
    throw new Error("fglm: input ideal is not zero-dimensional");
  }

  // Special case: G_DRL = [1]. The ideal is the unit ideal; the lex
  // GB is also [1].
  if (gDrl.length === 1) {
    const t = gDrl[0]!.terms;
    if (t.length === 1 && t[0]!.exp.length === 0) {
      return [polyConst<Rat>(makeRat(1n, 1n), RAT_RING)];
    }
  }

  // Step 1: enumerate the natural basis.
  const { exps: B, index: bIndex } = naturalBasis(gDrl, vars, drl);

  // Step 2: build multiplication-by-x_i matrices.
  const mulMaps: Rat[][][] = vars.map((v) =>
    buildMulMatrix(v, B, bIndex, gDrl, drl),
  );
  const mulMapByVar = new Map<string, Rat[][]>();
  vars.forEach((v, i) => mulMapByVar.set(v, mulMaps[i]!));

  // Step 3: NewBasis main loop. We walk lex monomials in *ascending*
  // lex order (smallest first). Per CLO/FGLM, a monomial m is
  // "barred" (added to LT(G_lex)) when its NF mod G_DRL is linearly
  // dependent on the staircase; otherwise it joins the staircase.
  //
  // The lex traversal: starting from `1`, generate monomials by
  // multiplying by `vars[n-1]` (the lex-smallest variable). When the
  // resulting monomial is barred, we *don't* generate descendants
  // through it (per FGLM termination — barred monomials' multiples
  // are also barred, by ideal-of-leading-terms inheritance). We walk
  // in lex-ascending order via a sorted-frontier queue.
  //
  // The standard FGLM lex traversal moves from lower-indexed vars
  // (lex-larger) to higher-indexed vars (lex-smaller) via a
  // monomial-children rule: from `m`, generate children
  // `vars[i] · m` for every i such that no lex-smaller variable is
  // present in m. This generates each monomial exactly once. The
  // canonical reference is FGLM 1993 §3.

  // For senior-grade clarity: we'll use explicit lex enumeration
  // with a "minimal-variable" rule. The rule: from m, enumerate
  // children `m' = vars[i] · m` for each i in [0, n) such that vars[i]
  // is the lex-smallest variable in m' (i.e., no vars[j] with j > i
  // appears in m). This generates each monomial exactly once and in
  // lex-ascending order.

  const staircase: Rat[][] = [];                          // staircase NF vectors
  const staircaseMonomials: (readonly (readonly [string, number])[])[] = [];
  const lexBasis: Poly<Rat>[] = [];

  // The lex-staircase monomials (those NOT in LT_lex(G_lex)) and the
  // lex-barred monomials (those that ARE).
  const barred: (readonly (readonly [string, number])[])[] = [];

  // BFS frontier of monomials to consider in lex-ascending order.
  // Each frontier entry stores the monomial and the *minimum allowed
  // child index* — children are only `vars[i]` with `i ≥ minIdx`.
  // This restriction generates each monomial exactly once. It also
  // ensures we walk in lex-ascending order if we sort the frontier
  // by lex-comparator each pop.
  type FrontierEntry = {
    exp: readonly (readonly [string, number])[];
    minChildIdx: number;
  };
  const frontier: FrontierEntry[] = [{ exp: [], minChildIdx: 0 }];

  while (frontier.length > 0) {
    // Pop lex-smallest entry.
    let bestIdx = 0;
    for (let i = 1; i < frontier.length; i++) {
      if (lex.compare(frontier[i]!.exp, frontier[bestIdx]!.exp) < 0) {
        bestIdx = i;
      }
    }
    const cur = frontier[bestIdx]!;
    frontier.splice(bestIdx, 1);

    // Skip if any barred monomial divides cur (descendant of barred).
    let skipBarred = false;
    for (const bm of barred) {
      if (expDividesLocal(bm, cur.exp)) { skipBarred = true; break; }
    }
    if (skipBarred) continue;

    // Compute NF(cur.exp) as a B-vector. We could cache previous
    // results and step via mulMap-multiplication; for v0.1 simplicity
    // and clarity we just call reduce-monomial-to-B-vector each time.
    const nfVec = reduceMonomialToBVector(cur.exp, gDrl, drl, bIndex, B.length);

    const dep = linearDependence(staircase, nfVec);
    if (dep.dependent) {
      // cur.exp is the LM of a new lex GB element.
      const lexElem = buildLexElement(cur.exp, staircaseMonomials, dep.coeffs);
      lexBasis.push(lexElem);
      barred.push(cur.exp);
      // Don't generate children of cur — they are all barred.
    } else {
      // cur.exp joins the staircase. Generate children.
      staircase.push(nfVec);
      staircaseMonomials.push(cur.exp);

      for (let i = cur.minChildIdx; i < vars.length; i++) {
        const child = expIncrement(cur.exp, vars[i]!);
        frontier.push({ exp: child, minChildIdx: i });
      }
    }

    // Termination shortcut: when staircase has D = |B| entries, no
    // further independent monomial can be found, so any remaining
    // frontier entries are barred. We can stop.
    if (staircase.length >= B.length && frontier.length > 0) {
      // Process remaining frontier as barred (each yields a lex GB
      // element). But a more efficient path: we know each remaining
      // frontier entry is dependent on the existing staircase, so
      // we just process them in lex-ascending order without
      // generating children.
      while (frontier.length > 0) {
        let idx = 0;
        for (let i = 1; i < frontier.length; i++) {
          if (lex.compare(frontier[i]!.exp, frontier[idx]!.exp) < 0) {
            idx = i;
          }
        }
        const e = frontier[idx]!;
        frontier.splice(idx, 1);
        // Skip if barred-descended.
        let isBarredDesc = false;
        for (const bm of barred) {
          if (expDividesLocal(bm, e.exp)) { isBarredDesc = true; break; }
        }
        if (isBarredDesc) continue;
        const nf = reduceMonomialToBVector(e.exp, gDrl, drl, bIndex, B.length);
        const d2 = linearDependence(staircase, nf);
        if (!d2.dependent) {
          // Should not happen given staircase size, but be defensive.
          throw new Error("fglm: unexpected linear independence after staircase saturation");
        }
        const lexElem = buildLexElement(e.exp, staircaseMonomials, d2.coeffs);
        lexBasis.push(lexElem);
        barred.push(e.exp);
      }
    }
  }

  // Step 4: interreduce the lex basis (it should already be very close
  // to reduced, given that we monicised each element on construction;
  // a final sweep ensures tail-reduced uniqueness).
  return interreduceLex(lexBasis, vars, lex);
}

function interreduceLex(
  basis: readonly Poly<Rat>[],
  vars: readonly string[],
  lex: MonomialOrder,
): readonly Poly<Rat>[] {
  // Discard polynomials whose LM is divisible by another's; reduce
  // each survivor's tail by the others; monicise; sort descending.
  const surviving: Poly<Rat>[] = [];
  const lts: { exp: readonly (readonly [string, number])[]; coef: Rat }[] = [];
  for (const p of basis) {
    if (polyIsZero(p)) continue;
    const lt = leadingTerm(p, lex);
    if (lt === null) continue;
    surviving.push(p);
    lts.push({ exp: lt.exp, coef: lt.coef });
  }
  const keep: boolean[] = surviving.map(() => true);
  for (let i = 0; i < surviving.length; i++) {
    if (!keep[i]) continue;
    for (let j = 0; j < surviving.length; j++) {
      if (i === j || !keep[j]) continue;
      if (expDividesLocal(lts[j]!.exp, lts[i]!.exp)) {
        if (!sameExp(lts[j]!.exp, lts[i]!.exp) || j < i) {
          keep[i] = false;
          break;
        }
      }
    }
  }
  let out: Poly<Rat>[] = [];
  for (let i = 0; i < surviving.length; i++) {
    if (keep[i]) out.push(surviving[i]!);
  }

  // Tail reduce.
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < out.length; i++) {
      const others: Poly<Rat>[] = [];
      for (let j = 0; j < out.length; j++) if (j !== i) others.push(out[j]!);
      const r = polyNormalForm(out[i]!, others, lex);
      if (!structEq(r, out[i]!)) {
        out[i] = r;
        changed = true;
      }
    }
  }

  // Monicise.
  const monic: Poly<Rat>[] = [];
  for (const p of out) {
    if (polyIsZero(p)) continue;
    const lt = leadingTerm(p, lex);
    if (lt === null) continue;
    const inv = ratDiv(makeRat(1n, 1n), lt.coef);
    const scaled: Poly<Rat> = {
      terms: p.terms.map((t) => ({ exp: t.exp, coef: ratMul(t.coef, inv) })),
    };
    monic.push(scaled);
  }

  monic.sort((a, b) => {
    const la = leadingTerm(a, lex)!;
    const lb = leadingTerm(b, lex)!;
    return lex.compare(lb.exp, la.exp);
  });

  // Variable-touch reference (keeps the "vars" parameter live for
  // future per-variable sanity checks; not load-bearing today).
  void vars;
  return monic;
}

function sameExp(
  a: readonly (readonly [string, number])[],
  b: readonly (readonly [string, number])[],
): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i]![0] !== b[i]![0] || a[i]![1] !== b[i]![1]) return false;
  }
  return true;
}

function structEq(a: Poly<Rat>, b: Poly<Rat>): boolean {
  if (a.terms.length !== b.terms.length) return false;
  for (let i = 0; i < a.terms.length; i++) {
    const ta = a.terms[i]!;
    const tb = b.terms[i]!;
    if (ta.coef.n !== tb.coef.n || ta.coef.d !== tb.coef.d) return false;
    if (!sameExp(ta.exp, tb.exp)) return false;
  }
  return true;
}

// silence unused-imports linting (kept as named imports for symmetry).
void polySub;
void polyNeg;
void expGet;
void expAdd;
