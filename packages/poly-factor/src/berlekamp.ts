// =============================================================================
// berlekamp.ts — univariate factorization over 𝔽_p (Berlekamp 1967)
// =============================================================================
//
// What this module computes
// -------------------------
// Given a **square-free monic** polynomial `f ∈ 𝔽_p[v]` of positive
// degree, return the list of monic irreducible factors `f = f₁·f₂·…·fᵣ`
// over `𝔽_p[v]`. Square-freeness is a precondition: callers strip
// repeated factors via Yun's decomposition (`squareFree` in
// `squarefree.js`) before reaching here. Monicity is required to
// guarantee a canonical factorisation (without it the result is unique
// only up to scalar units).
//
// Why Berlekamp 1967, not Cantor-Zassenhaus 1981
// ----------------------------------------------
// Berlekamp is **deterministic**. The bead `scientist-workbench-p3d`
// names Berlekamp explicitly; the workbench's discipline (ADR-0005)
// requires nondeterministic operations to consume an externalised
// `entropy: string` field. Cantor-Zassenhaus is probabilistic
// (random splittings) and therefore would need to be wired through
// the entropy protocol. Berlekamp's deterministic linear-algebraic
// structure plays well with the workbench's "same input bytes ⟹
// bit-identical output bytes" contract without any entropy plumbing.
//
// Algorithm — Berlekamp's classical 1967 algorithm
// ------------------------------------------------
// The key fact: in the quotient ring `R = 𝔽_p[v] / (f)`, the Frobenius
// endomorphism `φ(a) = a^p` is `𝔽_p`-linear. The *Berlekamp subalgebra*
// `B = {a ∈ R : φ(a) = a}` is an `𝔽_p`-vector space whose dimension
// equals the number of distinct irreducible factors of `f`. Computing
// `B` then "splitting" `f` along non-constant elements of `B` recovers
// every irreducible factor.
//
//     1.  Build the `n × n` matrix `M` over `𝔽_p`, where
//         `M[i][j] = ` coefficient of `v^i` in `v^{p·j} mod f`.
//         Equivalently: `M` represents the action of Frobenius on the
//         basis `{1, v, v², …, v^{n-1}}` of `R`.
//     2.  Compute the kernel of `M − I` over `𝔽_p`. The kernel is the
//         coordinate representation of the Berlekamp subalgebra `B`.
//         Its dimension `r` is the number of irreducible factors.
//     3.  The all-constants element `(1, 0, 0, …, 0)` always lies in
//         the kernel (constants are Frobenius-fixed). Pick a non-constant
//         basis element `b(v)`. For each `c ∈ 𝔽_p`, compute
//         `gcd(f, b(v) − c)`. The non-trivial gcds **split `f`** into
//         coprime factors of `f` (Berlekamp's splitting lemma): every
//         irreducible factor of `f` is contained in exactly one such gcd.
//     4.  Recurse on each non-trivial split until `r` irreducible
//         factors are isolated.
//
// References
// ----------
// • Berlekamp, *Factoring polynomials over finite fields*, BSTJ 46
//   (1967), pp. 1853-1859. The original.
// • Geddes-Czapor-Labahn, *Algorithms for Computer Algebra* §8.4.
// • Cox-Little-O'Shea, *Ideals, Varieties, and Algorithms* §4.6
//   (the local PDF at `docs/ground-truth/factor/cox-little-oshea-…`).
// • SymPy `gf_berlekamp` in `polys/galoistools.py` for cross-reference.

import {
  type Poly,
  fpField,
  polyConst,
  polyDegInVar,
  polyDivRemMonic,
  polyEq,
  polyFromCoeffsInVar,
  polyGcd,
  polyIsZero,
  polyMul,
  polySub,
  polyVar,
} from "@workbench/cas-core";

/**
 * Berlekamp factorisation of a square-free monic polynomial over 𝔽_p.
 *
 * @param f  Square-free monic polynomial in `𝔽_p[v]`. Coefficients
 *           are integers in `[0, p)`. Square-freeness is a
 *           precondition — strip multiplicities via Yun first.
 * @param p  Prime. Must be ≥ 2. Primality is the caller's contract;
 *           if `p` is composite the kernel computation may produce
 *           wrong factors silently (linear algebra "works" over any
 *           ring but Berlekamp's correctness rests on `𝔽_p` being a
 *           field).
 * @param v  Principal variable name.
 *
 * @returns  A list of monic irreducible factors of `f` over `𝔽_p[v]`,
 *           in no particular order. `[f]` if `f` is already
 *           irreducible. `[]` if `f` has degree 0 (a unit; no
 *           non-constant factors).
 *
 * @throws  If `f` has degree < 1 — degree 0 is allowed (returns []),
 *          but the zero polynomial throws because the Berlekamp
 *          subalgebra is undefined.
 * @throws  If `f` is not monic in `v`.
 */
export function berlekampFactor(
  f: Poly<bigint>,
  p: bigint,
  v: string,
): Poly<bigint>[] {
  if (p < 2n) throw new RangeError(`berlekampFactor: prime must be ≥ 2 (got ${p})`);
  if (polyIsZero(f)) throw new Error("berlekampFactor: zero polynomial");
  const n = polyDegInVar(f, v);
  if (n < 0) throw new Error("berlekampFactor: zero polynomial");
  if (n === 0) return [];                   // degree-0 monic ≡ constant 1; no factors.
  if (n === 1) return [f];                  // linear ⟹ irreducible.

  const F = fpField(p);
  if (!isMonicIn(f, v, F)) {
    throw new Error("berlekampFactor: input must be monic in '" + v + "'");
  }

  // Build the Frobenius matrix: M[i][j] = coef of v^i in v^{p·j} mod f.
  const M = buildFrobeniusMatrix(f, p, v, n);
  // M ← M − I  (in 𝔽_p; if a diagonal entry was 0 we pick up −1 ≡ p−1).
  for (let i = 0; i < n; i++) {
    M[i]![i] = mod(M[i]![i]! - 1n, p);
  }

  // Compute the kernel basis: vectors x ∈ 𝔽_p^n with M·x = 0.
  // (The "Berlekamp subalgebra basis" — each basis vector is the
  // coefficient vector of a polynomial b(v) in `R` with b^p ≡ b (mod f).)
  const kernel = nullspaceModP(M, n, p);

  // Convert kernel vectors to polynomials.
  const basisPolys = kernel.map((vec) => coefVecToPoly(vec, v, F));

  // The kernel always contains the constant polynomial 1 (= (1, 0, …, 0)).
  // Filter it out; the remaining `r − 1` non-constant polynomials are
  // the splitting elements.
  const nonConstBasis = basisPolys.filter((b) => polyDegInVar(b, v) > 0);
  if (nonConstBasis.length === 0) {
    // r = 1 — `f` is already irreducible mod p.
    return [f];
  }

  // Iteratively split. Start with the working list of factors = [f] and
  // walk through each non-constant basis element b. For each b and
  // each c ∈ 𝔽_p, replace any current factor `g` by the partition
  // `[gcd(g, b − c), g / gcd(g, b − c)]` — the splitting lemma
  // guarantees this partition has at least one non-trivial split for
  // some pair (b, c) when `g` is reducible. Done when we have `r`
  // factors.
  const r = kernel.length;
  let factors: Poly<bigint>[] = [f];

  for (const b of nonConstBasis) {
    if (factors.length >= r) break;
    for (let cInt = 0n; cInt < p; cInt++) {
      if (factors.length >= r) break;
      const bMinusC = polySub(b, polyConst<bigint>(cInt, F), F);
      const newFactors: Poly<bigint>[] = [];
      for (const g of factors) {
        if (polyDegInVar(g, v) <= 1) {
          newFactors.push(g);
          continue;
        }
        const gcd_gb = polyGcd(g, bMinusC, F);
        const dG = polyDegInVar(gcd_gb, v);
        if (dG <= 0 || dG === polyDegInVar(g, v)) {
          // Trivial split: gcd is a unit, or gcd is g itself.
          newFactors.push(g);
        } else {
          // Non-trivial split: g = gcd · (g / gcd).
          const quotient = polyDivRemMonic(g, gcd_gb, v, F).q;
          newFactors.push(gcd_gb, quotient);
        }
      }
      factors = newFactors;
    }
  }

  return factors;
}

// -----------------------------------------------------------------------------
// internal helpers
// -----------------------------------------------------------------------------

/**
 * Build the Frobenius matrix `M[i][j] = ` coef of `v^i` in `v^{p·j} mod f`.
 * Output is a row-major `n × n` matrix of bigints, all in `[0, p)`.
 *
 * Strategy: compute `xp = v^p mod f` via square-and-multiply (`O(n²·log p)`),
 * then build successive rows by `pow_j ← (pow_{j-1} · xp) mod f`
 * (`O(n²)` per row, `O(n³)` total). The whole construction is
 * `O(n²·log p + n³)`.
 */
function buildFrobeniusMatrix(
  f: Poly<bigint>,
  p: bigint,
  v: string,
  n: number,
): bigint[][] {
  const F = fpField(p);
  const rOne = polyConst<bigint>(1n, F);
  const xp = polyPowMod(polyVar<bigint>(v, F), p, f, v, F);

  // Row 0 = v^0 = 1; row j (j ≥ 1) = (row j-1) · xp mod f.
  const rows: Poly<bigint>[] = new Array(n);
  rows[0] = rOne;
  for (let j = 1; j < n; j++) {
    const prod = polyMul(rows[j - 1]!, xp, F);
    rows[j] = polyDivRemMonic(prod, f, v, F).r;
  }

  // Convert each row polynomial to its length-n coefficient vector.
  // M[i][j] is the coef of v^i in row j (i.e. in v^{p·j} mod f).
  const M: bigint[][] = Array.from({ length: n }, () =>
    new Array<bigint>(n).fill(0n),
  );
  for (let j = 0; j < n; j++) {
    const row = rows[j]!;
    for (const t of row.terms) {
      let pv = 0;
      for (const [name, exp] of t.exp) if (name === v) pv = exp;
      // Defensive: pv must be in [0, n) since `row` is reduced mod f.
      if (pv < n) M[pv]![j] = t.coef;
    }
  }
  return M;
}

/**
 * Polynomial exponentiation modulo a monic divisor over a field.
 * Computes `g^e mod f` where `f` is monic in `v`. Used for
 * `v^p mod f` in Frobenius matrix construction.
 *
 * Square-and-multiply over the ring `F[v] / (f)`. The reduction at
 * each step is `polyDivRemMonic`, valid because `f` is monic.
 */
function polyPowMod<T>(
  g: Poly<T>,
  e: bigint,
  f: Poly<T>,
  v: string,
  F: { readonly one: T; readonly mul: (a: T, b: T) => T; readonly add: (a: T, b: T) => T; readonly sub: (a: T, b: T) => T; readonly neg: (a: T) => T; readonly eq: (a: T, b: T) => boolean; readonly isZero: (a: T) => boolean; readonly isOne: (a: T) => boolean; readonly fromInt: (n: bigint) => T; readonly zero: T; readonly inv: (a: T) => T; readonly div: (a: T, b: T) => T },
): Poly<T> {
  if (e < 0n) throw new RangeError("polyPowMod: negative exponent");
  let result = polyConst<T>(F.one, F);
  let base = polyDivRemMonic(g, f, v, F).r;
  let ee = e;
  while (ee > 0n) {
    if ((ee & 1n) === 1n) {
      const prod = polyMul(result, base, F);
      result = polyDivRemMonic(prod, f, v, F).r;
    }
    ee >>= 1n;
    if (ee > 0n) {
      const sq = polyMul(base, base, F);
      base = polyDivRemMonic(sq, f, v, F).r;
    }
  }
  return result;
}

/**
 * Right null space of `M` (interpreted `n × n`) over `𝔽_p`.
 *
 * Returns a list of basis vectors (as `bigint[]` of length `n`,
 * coefficients in `[0, p)`). The list spans the kernel `{x : M·x = 0}`.
 *
 * Algorithm: row-reduce `M` to RREF, identify pivot vs. free columns,
 * each free column generates one basis vector by setting that free
 * variable to 1, all other free variables to 0, and back-solving the
 * pivot variables.
 */
function nullspaceModP(M: bigint[][], n: number, p: bigint): bigint[][] {
  // Work on a deep copy so we don't mutate the caller's matrix.
  const A: bigint[][] = M.map((row) => row.slice());
  const F = fpField(p);

  // Pivot tracking. `pivotCol[r] = c` means row r's pivot is at column c.
  const pivotCol: number[] = new Array(n).fill(-1);
  let row = 0;
  for (let col = 0; col < n && row < n; col++) {
    // Find a row at index ≥ `row` with non-zero entry in `col`.
    let pivot = -1;
    for (let r = row; r < n; r++) {
      if (A[r]![col]! !== 0n) {
        pivot = r;
        break;
      }
    }
    if (pivot === -1) continue;            // free column

    // Swap pivot row up.
    if (pivot !== row) {
      const tmp = A[row]!; A[row] = A[pivot]!; A[pivot] = tmp;
    }

    // Normalise pivot row to have leading 1.
    const lead = A[row]![col]!;
    if (lead !== 1n) {
      const inv = F.inv(lead);
      for (let c = col; c < n; c++) {
        A[row]![c]! = mod(A[row]![c]! * inv, p);
      }
    }

    // Eliminate this column from all other rows.
    for (let r = 0; r < n; r++) {
      if (r === row) continue;
      const factor = A[r]![col]!;
      if (factor === 0n) continue;
      for (let c = col; c < n; c++) {
        A[r]![c]! = mod(A[r]![c]! - factor * A[row]![c]!, p);
      }
    }

    pivotCol[row] = col;
    row++;
  }

  // Identify free columns and build a basis vector for each.
  const isPivotCol = new Array<boolean>(n).fill(false);
  const colToRow = new Array<number>(n).fill(-1);
  for (let r = 0; r < n; r++) {
    if (pivotCol[r]! >= 0) {
      isPivotCol[pivotCol[r]!] = true;
      colToRow[pivotCol[r]!] = r;
    }
  }

  const basis: bigint[][] = [];
  for (let freeCol = 0; freeCol < n; freeCol++) {
    if (isPivotCol[freeCol]) continue;
    const vec = new Array<bigint>(n).fill(0n);
    vec[freeCol] = 1n;
    // For each pivot row, the pivot variable is x_{pivotCol[r]}.
    // Equation: x_{pivotCol[r]} + Σ_{c free} A[r][c] · x_c = 0.
    // So x_{pivotCol[r]} = − A[r][freeCol] (only this free variable
    // is non-zero in our setting; we set the others to 0).
    for (let r = 0; r < n; r++) {
      const pc = pivotCol[r]!;
      if (pc < 0) continue;
      vec[pc] = mod(-A[r]![freeCol]!, p);
    }
    basis.push(vec);
    void colToRow;  // colToRow held for clarity in the equations above.
  }
  return basis;
}

/** `coefs[i]` is the `v^i` coefficient — return the corresponding `Poly<bigint>` over `F`. */
function coefVecToPoly(
  coefs: bigint[],
  v: string,
  F: ReturnType<typeof fpField>,
): Poly<bigint> {
  const cs: Poly<bigint>[] = coefs.map((c) => polyConst<bigint>(c, F));
  return polyFromCoeffsInVar(cs, v, F);
}

/** Canonical residue mod p in [0, p). */
function mod(a: bigint, p: bigint): bigint {
  let r = a % p;
  if (r < 0n) r += p;
  return r;
}

/** True iff `f` is monic in `v` viewed as a poly over the field `F`. */
function isMonicIn(
  f: Poly<bigint>,
  v: string,
  F: ReturnType<typeof fpField>,
): boolean {
  if (polyIsZero(f)) return false;
  const d = polyDegInVar(f, v);
  if (d < 0) return false;
  for (const t of f.terms) {
    let pv = 0;
    for (const [name, exp] of t.exp) if (name === v) pv = exp;
    if (pv === d) return F.isOne(t.coef);
  }
  return false;
}

void polyEq;  // re-export-only; kept for symmetry with the rest of cas-core's surface.
