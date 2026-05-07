// =============================================================================
// resultant.ts — univariate resultant via Sylvester matrix + Bareiss
// =============================================================================
//
// What this module is for
// -----------------------
// `Res_y(f, g)` for `f, g ∈ R[y]` (univariate polynomials in `y` with
// coefficients in some ring `R`) is the polynomial-arithmetic primitive
// that lets us compute the *minimal polynomial of an algebraic-number
// arithmetic operation* without ever evaluating the algebraics
// numerically (Cohen GTM 138 §3.6.2):
//
//     minpoly(α + β) ⊆ squarefree( Res_y(f_α(y), f_β(x − y)) )
//     minpoly(α · β) ⊆ squarefree( Res_y(y^{deg f_β} · f_α(x/y), f_β(y)) )
//
// In our setting `R = ℚ[x]` (the variable of the resulting minpoly).
// The Sylvester matrix of `f, g` in `y` is `(deg_y(f) + deg_y(g))`-
// square; its determinant is the resultant. Each entry is a polynomial
// in `ℚ[x]`.
//
// Algorithm
// ---------
// **Bareiss elimination** (Bareiss 1968) over the integral domain
// `ℚ[x]`. At each step we reduce sub-rows `i > k` against the pivot
// row `k`, normalising by the previous pivot so intermediate
// quantities stay polynomials (no fractions of polynomials introduced
// even though the *coefficients* of those polynomials are already in
// the field ℚ — the savings is in keeping the polynomial degrees
// bounded). The standard Bareiss recurrence `M[i][j] ← (M[i][j]·M[k][k]
// − M[i][k]·M[k][j]) / prevPivot` is exact in `ℚ[x]` by Bareiss's
// theorem; we use `polyDivExact` (which throws if division is not
// exact — a useful sanity canary).
//
// `O(n³)` polynomial operations where `n = deg_y(f) + deg_y(g)`.
// For our typical use (Roots of degree ≤ 10), `n ≤ 20`, comfortably
// within reach.
//
// References
// ----------
// - **Bareiss 1968**, *Sylvester's identity and multistep integer-
//   preserving Gaussian elimination*, Math Comp 22, 565–578.
// - **Cohen 1993** (GTM 138), §3.5.3 (Sylvester matrix), §3.6.2
//   (resultant for sum/product of algebraic numbers).
// - **cas-core::polySubresultantPRS** (`packages/cas-core/src/poly-gcd.ts`)
//   — an alternative algorithm for the same quantity. We could
//   factor through that path, but exposing it would require
//   restructuring cas-core; the Sylvester path is self-contained
//   here and the cost is comparable for small `n`.

import {
  type Poly,
  type Rat,
  RAT_RING,
  makeRat,
  polyAdd,
  polyConst,
  polyDegInVar,
  polyDivExact,
  polyIsZero,
  polyMul,
  polyNeg,
  polySub,
} from "@workbench/cas-core";

// -----------------------------------------------------------------------------
// Public entry — sylvesterResultantInY
// -----------------------------------------------------------------------------

/**
 * Compute the resultant `Res_y(f, g)` where `f, g ∈ ℚ[y]` (or, more
 * generally, `ℚ[x][y]` — coefficients in `y` may themselves be
 * polynomials in `x`). The result is a polynomial in `ℚ[x]` (the
 * `y` variable is eliminated).
 *
 * @param f   polynomial in `y`, coefficients are `Poly<Rat>` in other variables
 * @param g   polynomial in `y`, same coefficient ring
 * @param y   variable to eliminate
 * @returns   `Poly<Rat>` over the variables of `f, g` excluding `y`
 *
 * Special cases:
 *   - If either input is zero in `y`, `Res = 0` by convention.
 *   - If `deg_y(f) = 0`, `Res = lc_y(f)^{deg_y(g)}` (and symmetric).
 */
export function sylvesterResultantInY(
  f: Poly<Rat>,
  g: Poly<Rat>,
  y: string,
): Poly<Rat> {
  if (polyIsZero(f) || polyIsZero(g)) {
    return polyConst<Rat>(makeRat(0n, 1n), RAT_RING);
  }

  const n = polyDegInVar(f, y);
  const m = polyDegInVar(g, y);

  if (n < 0 || m < 0) {
    return polyConst<Rat>(makeRat(0n, 1n), RAT_RING);
  }

  // Coefficients in `y`, low-to-high. Each is a `Poly<Rat>` in the
  // other variables.
  const fCoeffs = polyCoeffsInVar(f, y, n);
  const gCoeffs = polyCoeffsInVar(g, y, m);

  // Edge case: deg_y(f) = 0 — `f` is a constant in `y` (a polynomial in
  // the other variables). Then Res = f^{deg_y(g)} (sign-aware in
  // higher-degree cases; for our usage f's leading coef in y is
  // nonzero and constant-in-y means f is just that single
  // coefficient).
  if (n === 0) return polyPow(fCoeffs[0]!, m);
  if (m === 0) return polyPow(gCoeffs[0]!, n);

  // Build the Sylvester matrix. Size N×N where N = n + m.
  //
  //   Row 0:        [c_n, c_{n−1}, …, c_0, 0, 0, …, 0]                 ← shift 0
  //   Row 1:        [ 0,  c_n,    …, c_1, c_0, 0, …, 0]                ← shift 1
  //   Row m−1:      [ 0,   0,     …,                  c_n, …, c_0]    ← shift m−1
  //   Row m:        [d_m, d_{m−1},…, d_0, 0, 0, …, 0]                 ← shift 0
  //   Row m+1:      [ 0,  d_m,    …, d_1, d_0, 0, …, 0]                ← shift 1
  //   Row m+n−1:    [ 0,   0,     …,                  d_m, …, d_0]    ← shift n−1
  //
  // (`c_i` = `f`'s coefficient at `y^i`; `d_j` = `g`'s coefficient at `y^j`.)
  const N = n + m;
  const M: Poly<Rat>[][] = [];
  const ZERO = polyConst<Rat>(makeRat(0n, 1n), RAT_RING);

  for (let i = 0; i < m; i++) {
    const row: Poly<Rat>[] = [];
    for (let j = 0; j < N; j++) {
      const idx = j - i;     // column j in row i is c_{n − (j − i)} ⇒ flag if 0 ≤ j-i ≤ n
      if (idx < 0 || idx > n) row.push(ZERO);
      else row.push(fCoeffs[n - idx]!);
    }
    M.push(row);
  }
  for (let i = 0; i < n; i++) {
    const row: Poly<Rat>[] = [];
    for (let j = 0; j < N; j++) {
      const idx = j - i;
      if (idx < 0 || idx > m) row.push(ZERO);
      else row.push(gCoeffs[m - idx]!);
    }
    M.push(row);
  }

  return bareissDeterminant(M);
}

// -----------------------------------------------------------------------------
// Bareiss determinant in ℚ[x]
// -----------------------------------------------------------------------------

/**
 * `det(M)` for `M` a square matrix of `Poly<Rat>` entries, computed
 * via Bareiss elimination. Mutates a local copy of `M`.
 *
 * Bareiss recurrence:
 *
 *     M'_{ij} = (M_{ij} · M_{kk} − M_{ik} · M_{kj}) / prevPivot
 *
 * where `prevPivot = M_{k−1, k−1}` (or `1` when `k = 0`). The
 * division is exact in any integral domain (Bareiss 1968,
 * *Sylvester's identity and multistep integer-preserving Gaussian
 * elimination*); `polyDivExact` validates this and throws if the
 * implementation drifts from the algorithm.
 *
 * Row-swaps for zero pivots flip the sign of the determinant; we
 * track parity in `signFlips`. If at some pivot stage the entire
 * remaining column is zero, the matrix is singular and `det = 0`.
 */
function bareissDeterminant(input: readonly (readonly Poly<Rat>[])[]): Poly<Rat> {
  const N = input.length;
  if (N === 0) return polyConst<Rat>(makeRat(1n, 1n), RAT_RING);
  // Mutable working copy.
  const M: Poly<Rat>[][] = input.map((row) => row.slice());

  const ZERO = polyConst<Rat>(makeRat(0n, 1n), RAT_RING);
  const ONE = polyConst<Rat>(makeRat(1n, 1n), RAT_RING);

  let prevPivot: Poly<Rat> = ONE;
  let signFlips = 0;

  for (let k = 0; k < N - 1; k++) {
    // Find a non-zero pivot; swap rows if needed.
    if (polyIsZero(M[k]![k]!)) {
      let swapWith = -1;
      for (let i = k + 1; i < N; i++) {
        if (!polyIsZero(M[i]![k]!)) {
          swapWith = i;
          break;
        }
      }
      if (swapWith === -1) {
        // Column is zero from k downwards — singular.
        return ZERO;
      }
      const tmp = M[k]!;
      M[k] = M[swapWith]!;
      M[swapWith] = tmp;
      signFlips++;
    }

    const pivot = M[k]![k]!;
    for (let i = k + 1; i < N; i++) {
      const colI_k = M[i]![k]!;
      for (let j = k + 1; j < N; j++) {
        // M[i][j] = (M[i][j] · pivot − colI_k · M[k][j]) / prevPivot
        const num = polySub(
          polyMul(M[i]![j]!, pivot, RAT_RING),
          polyMul(colI_k, M[k]![j]!, RAT_RING),
          RAT_RING,
        );
        M[i]![j] = k === 0 ? num : polyDivExact(num, prevPivot, RAT_RING);
      }
      // The leading column of row i is now zero implicitly; we don't
      // bother to write it.
    }
    prevPivot = pivot;
  }

  let det = M[N - 1]![N - 1]!;
  if (signFlips % 2 !== 0) det = polyNeg(det, RAT_RING);
  return det;
}

// -----------------------------------------------------------------------------
// Internal helpers — coefficient extraction and polynomial powers
// over `ℚ[x][y]`
// -----------------------------------------------------------------------------

/**
 * Coefficients of `p` viewed as a polynomial in `y`, low-to-high
 * (`p = sum_i c_i · y^i`). Each `c_i` is a `Poly<Rat>` in the
 * remaining variables.
 *
 * Differs from cas-core's `polyCoeffsInVar` only in that we *don't*
 * pad with `polyZero` for missing degrees up to `polyDegInVar`; we
 * use the supplied `degree` argument directly. This gives caller
 * full control.
 */
function polyCoeffsInVar(p: Poly<Rat>, v: string, degree: number): Poly<Rat>[] {
  const coeffs: Poly<Rat>[] = [];
  for (let i = 0; i <= degree; i++) {
    coeffs.push({ terms: [] });
  }
  for (const t of p.terms) {
    let powerOfV = 0;
    const restExp: [string, number][] = [];
    for (const [name, exp] of t.exp) {
      if (name === v) powerOfV = exp;
      else restExp.push([name, exp]);
    }
    if (powerOfV > degree) continue;
    coeffs[powerOfV] = polyAdd(
      coeffs[powerOfV]!,
      { terms: [{ exp: restExp, coef: t.coef }] },
      RAT_RING,
    );
  }
  return coeffs;
}

function polyPow(p: Poly<Rat>, n: number): Poly<Rat> {
  if (n === 0) return polyConst<Rat>(makeRat(1n, 1n), RAT_RING);
  let acc = p;
  for (let i = 1; i < n; i++) acc = polyMul(acc, p, RAT_RING);
  return acc;
}
