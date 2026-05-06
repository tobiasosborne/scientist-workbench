// Exact linear solving over Q via Bareiss fraction-free Gaussian
// elimination (Bareiss 1968, Math. Comp. 22(103) 565-578, §II.A.2 Eq. 8).
//
// This module is the substrate for `tools/linsolve-q`. It implements the
// one-step variant: `a_ij^(k) = (a_kk^(k-1) * a_ij^(k-1) - a_ik^(k-1) *
// a_kj^(k-1)) / a_{k-1,k-1}^(k-2)` with sentinels `a_00^(-1) = 1`,
// `a_ij^(0) = a_ij`. The integer-preserving property — the divisor
// always evenly divides the numerator over Z — is Sylvester's identity
// (§I of the paper). For rational inputs the analogous claim holds
// over Q: the divisor exactly divides the numerator over Q.
//
// Why Bareiss and not naive Gauss-Jordan over Q: naive elimination
// blows up the bit length of intermediate fractions; Bareiss exploits
// Sylvester's identity to keep intermediates bounded by Hadamard's
// bound on submatrix determinants. For dense n×n integer inputs, this
// is O(n^3) arithmetic ops at O(n·log‖A‖) bits per op, vs naive's
// O(n^3) ops at O(2^n)-bit-blown rationals (worst case).
//
// The two-step variant (Eq. 7 of §II.A.3, p.568) gives a constant-
// factor speedup; deferred to a v2 bead.
//
// Public surface:
//   bareissSolve(A, b) -> LinSolveResult
//
// Output shape distinguishes:
//   - kind: 'unique'           — full column rank, single solution
//   - kind: 'under-determined' — rank < n, parametric form via free vars
//   - kind: 'inconsistent'     — rank(A) < rank([A|b])
//
// Each carries `maxIntermediateBitLength`: the largest bit length seen
// across all intermediate values during elimination. The bench's
// Tier-H bit-budget check reads this to detect implementations that
// secretly do naive ℚ-Gaussian; Bareiss bounds it by Hadamard, naive
// blows it up exponentially. (PRD §0.1 / ADR-0019 §1.)
//
// The function is pure: no I/O, no global state, no `Date.now`,
// deterministic over the same input bytes. Per the workbench's default
// determinism tier (ADR-0015, no `numerical: true` annotation): the
// computation lives entirely in `bigint` arithmetic, so the output is
// bit-identical cross-platform forever.

import {
  type Rat,
  RAT_ONE,
  RAT_ZERO,
  ratAdd,
  ratDiv,
  ratEq,
  ratIsZero,
  ratMul,
  ratNeg,
  ratSub,
} from "./rat.js";

/**
 * Affine combination of rational constants and `t_<i>` free variables.
 *
 * `c` is the constant term; `coeffs` maps free-variable name to the
 * coefficient on that variable. Absent entries mean coefficient zero.
 *
 * Example: `5 - (2/3)·t_0 + 1·t_1` is
 *   { c: 5/1, coeffs: Map { "t_0" -> -2/3, "t_1" -> 1/1 } }.
 *
 * The bench wire format flattens this to a string like
 * `"5 - 2/3*t_0 + t_1"`; the conversion is the responsibility of the
 * tool wrapper, not the substrate.
 */
export interface Affine {
  readonly c: Rat;
  readonly coeffs: ReadonlyMap<string, Rat>;
}

const AFFINE_ZERO: Affine = { c: RAT_ZERO, coeffs: new Map() };

function affineConst(c: Rat): Affine {
  return { c, coeffs: new Map() };
}

function affineSym(name: string): Affine {
  return { c: RAT_ZERO, coeffs: new Map([[name, RAT_ONE]]) };
}

function affineAdd(a: Affine, b: Affine): Affine {
  const coeffs = new Map(a.coeffs);
  for (const [k, v] of b.coeffs) {
    const existing = coeffs.get(k) ?? RAT_ZERO;
    const sum = ratAdd(existing, v);
    if (ratIsZero(sum)) coeffs.delete(k);
    else coeffs.set(k, sum);
  }
  return { c: ratAdd(a.c, b.c), coeffs };
}

function affineNeg(a: Affine): Affine {
  const coeffs = new Map<string, Rat>();
  for (const [k, v] of a.coeffs) coeffs.set(k, ratNeg(v));
  return { c: ratNeg(a.c), coeffs };
}

function affineSub(a: Affine, b: Affine): Affine {
  return affineAdd(a, affineNeg(b));
}

function affineScale(a: Affine, k: Rat): Affine {
  if (ratIsZero(k)) return AFFINE_ZERO;
  const coeffs = new Map<string, Rat>();
  for (const [name, v] of a.coeffs) coeffs.set(name, ratMul(v, k));
  return { c: ratMul(a.c, k), coeffs };
}

/**
 * Result discriminated union returned by `bareissSolve`.
 *
 * The `*BitLength` field reports the largest bit length observed
 * across any intermediate value during elimination. The bench's
 * Tier-H check uses this to distinguish honest Bareiss (Hadamard-
 * bounded) from naive ℚ-Gaussian (bit-blown).
 */
export type LinSolveResult =
  | LinSolveUnique
  | LinSolveUnderDetermined
  | LinSolveInconsistent;

export interface LinSolveUnique {
  readonly kind: "unique";
  readonly x: ReadonlyArray<Rat>;
  readonly rank: number;
  readonly maxIntermediateBitLength: number;
}

export interface LinSolveUnderDetermined {
  readonly kind: "under-determined";
  /** Length-n list; positionally aligned with the input columns. */
  readonly x: ReadonlyArray<Affine>;
  /** Free-variable names introduced; t_0, t_1, …, t_{n-rank-1}. */
  readonly freeVars: ReadonlyArray<string>;
  readonly rank: number;
  readonly maxIntermediateBitLength: number;
}

export interface LinSolveInconsistent {
  readonly kind: "inconsistent";
  readonly rank: number;
  readonly augmentedRank: number;
  readonly maxIntermediateBitLength: number;
}

/**
 * Solve A·x = b exactly over Q via Bareiss one-step fraction-free
 * elimination.
 *
 * @param A   m×n rational matrix; outer length is m, inner length is n.
 *            Must be rectangular (every row the same length); ragged
 *            input throws.
 * @param b   length-m rational vector. Length mismatch throws.
 *
 * @returns A `LinSolveResult` discriminated by `kind`.
 *
 * @throws Error on malformed input (ragged, shape mismatch). Boundary
 *         cases like `m=0` or `n=0` are not errors — they have well-
 *         defined exact answers handled inline.
 */
export function bareissSolve(
  A: ReadonlyArray<ReadonlyArray<Rat>>,
  b: ReadonlyArray<Rat>,
): LinSolveResult {
  const m = A.length;
  const n = m > 0 ? A[0]!.length : 0;
  if (b.length !== m) {
    throw new Error(
      `bareissSolve: |b|=${b.length} but A has ${m} rows`,
    );
  }
  for (let i = 0; i < m; i++) {
    if (A[i]!.length !== n) {
      throw new Error(
        `bareissSolve: ragged A — row 0 has ${n} cols, row ${i} has ${A[i]!.length}`,
      );
    }
  }

  // ----- Boundary cases -----
  if (m === 0) {
    if (n === 0) {
      return {
        kind: "unique",
        x: [],
        rank: 0,
        maxIntermediateBitLength: 0,
      };
    }
    return {
      kind: "under-determined",
      x: Array.from({ length: n }, (_, j) => affineSym(`t_${j}`)),
      freeVars: Array.from({ length: n }, (_, j) => `t_${j}`),
      rank: 0,
      maxIntermediateBitLength: 0,
    };
  }
  if (n === 0) {
    // m×0: solvable iff every entry of b is zero.
    const allZero = b.every((bi) => ratIsZero(bi));
    if (allZero) {
      return {
        kind: "unique",
        x: [],
        rank: 0,
        maxIntermediateBitLength: 0,
      };
    }
    return {
      kind: "inconsistent",
      rank: 0,
      augmentedRank: b.filter((bi) => !ratIsZero(bi)).length > 0 ? 1 : 0,
      maxIntermediateBitLength: 0,
    };
  }

  // ----- Augmented matrix M = [A | b], stored mutably -----
  // Inner cells are Rat values; we mutate in place across the
  // elimination passes. (The input is `readonly`; we copy.)
  const M: Rat[][] = [];
  for (let i = 0; i < m; i++) {
    const row: Rat[] = new Array(n + 1);
    for (let j = 0; j < n; j++) row[j] = A[i]![j]!;
    row[n] = b[i]!;
    M.push(row);
  }

  let prevPivot: Rat = RAT_ONE; // a_00^(-1) = 1 (Bareiss sentinel)
  const pivotColForRow: number[] = [];
  let pivotRow = 0;
  let maxBitLength = 0;

  const trackBits = (r: Rat): void => {
    const bl = bitLength(r.n);
    const dl = bitLength(r.d);
    const m_ = bl > dl ? bl : dl;
    if (m_ > maxBitLength) maxBitLength = m_;
  };

  for (let col = 0; col < n; col++) {
    // 1. Find non-zero pivot at or below pivotRow in this column.
    let nz = -1;
    for (let i = pivotRow; i < m; i++) {
      if (!ratIsZero(M[i]![col]!)) {
        nz = i;
        break;
      }
    }
    if (nz === -1) continue; // free column

    // 2. Swap into pivotRow.
    if (nz !== pivotRow) {
      const tmp = M[pivotRow]!;
      M[pivotRow] = M[nz]!;
      M[nz] = tmp;
    }

    // 3. Bareiss reduction for every other row.
    const Mkk = M[pivotRow]![col]!;
    for (let i = 0; i < m; i++) {
      if (i === pivotRow) continue;
      const Mik = M[i]![col]!;
      if (ratIsZero(Mik)) continue;
      for (let j = 0; j < n + 1; j++) {
        const newVal = ratDiv(
          ratSub(ratMul(Mkk, M[i]![j]!), ratMul(Mik, M[pivotRow]![j]!)),
          prevPivot,
        );
        M[i]![j] = newVal;
        trackBits(newVal);
      }
      M[i]![col] = RAT_ZERO; // guarantee
    }

    prevPivot = Mkk;
    pivotColForRow.push(col);
    pivotRow += 1;
    if (pivotRow === m) break;
  }

  const rank = pivotRow;
  const pivotColSet = new Set(pivotColForRow);
  const freeCols: number[] = [];
  for (let c = 0; c < n; c++) if (!pivotColSet.has(c)) freeCols.push(c);

  // ----- Inconsistency check -----
  // After elimination, rows beyond `rank` should have zero coefficient
  // parts. If any has a non-zero augmented entry, the system is
  // inconsistent.
  for (let i = rank; i < m; i++) {
    let coefAllZero = true;
    for (let j = 0; j < n; j++) {
      if (!ratIsZero(M[i]![j]!)) {
        coefAllZero = false;
        break;
      }
    }
    if (coefAllZero && !ratIsZero(M[i]![n]!)) {
      return {
        kind: "inconsistent",
        rank,
        augmentedRank: rank + 1,
        maxIntermediateBitLength: maxBitLength,
      };
    }
  }

  // ----- Unique solution path -----
  if (freeCols.length === 0) {
    const x: Rat[] = new Array(n).fill(RAT_ZERO);
    for (let r = rank - 1; r >= 0; r--) {
      const col = pivotColForRow[r]!;
      let s = M[r]![n]!;
      for (let j = col + 1; j < n; j++) {
        s = ratSub(s, ratMul(M[r]![j]!, x[j]!));
      }
      x[col] = ratDiv(s, M[r]![col]!);
      trackBits(x[col]!);
    }
    return {
      kind: "unique",
      x,
      rank,
      maxIntermediateBitLength: maxBitLength,
    };
  }

  // ----- Under-determined: parametric form -----
  // Each free column c gets a fresh `t_<index>`; index is the position
  // in `freeCols`, NOT the column index itself.
  const freeVars = freeCols.map((_, i) => `t_${i}`);
  const x: Affine[] = new Array(n);
  for (let i = 0; i < freeCols.length; i++) {
    x[freeCols[i]!] = affineSym(freeVars[i]!);
  }
  // Pivot columns: solve via back-substitution, building affine
  // combinations.
  for (let r = rank - 1; r >= 0; r--) {
    const col = pivotColForRow[r]!;
    let s: Affine = affineConst(M[r]![n]!);
    for (let j = col + 1; j < n; j++) {
      const coeff = M[r]![j]!;
      if (ratIsZero(coeff)) continue;
      s = affineSub(s, affineScale(x[j]!, coeff));
    }
    const pivot = M[r]![col]!;
    // Divide every term by the pivot.
    const invPivot = ratDiv(RAT_ONE, pivot);
    x[col] = affineScale(s, invPivot);
  }
  return {
    kind: "under-determined",
    x,
    freeVars,
    rank,
    maxIntermediateBitLength: maxBitLength,
  };
}

/**
 * Bit length of a `bigint` (number of bits needed to represent its
 * absolute value). Zero has bit length 0; ±1 has bit length 1.
 *
 * Replicates `BigInt.prototype.bit_length()` from Python; not yet a
 * built-in in JS.
 */
function bitLength(n: bigint): number {
  if (n === 0n) return 0;
  let v = n < 0n ? -n : n;
  let bits = 0;
  while (v > 0n) {
    v >>= 1n;
    bits++;
  }
  return bits;
}

/**
 * Format an `Affine` as a string like `"5 - 2/3*t_0 + t_1"`.
 * The format is human-readable and SymPy-parseable (with `*` between
 * coefficient and free variable). Used by the bench wire adapter and
 * by the tool wrapper.
 *
 * Free-variable order in the output follows alphabetical / insertion
 * order: `t_0` before `t_1`, etc. The constant term comes first if
 * non-zero; if everything is zero, returns `"0"`.
 */
export function affineToString(a: Affine): string {
  const parts: string[] = [];
  if (!ratIsZero(a.c)) parts.push(formatRat(a.c));
  // Sort free-variable names by their numeric index so output is
  // deterministic regardless of insertion order.
  const names = [...a.coeffs.keys()].sort((x, y) => {
    const ix = parseInt(x.replace(/^t_/, ""), 10);
    const iy = parseInt(y.replace(/^t_/, ""), 10);
    return ix - iy;
  });
  for (const name of names) {
    const coeff = a.coeffs.get(name)!;
    if (ratIsZero(coeff)) continue;
    const isFirst = parts.length === 0;
    if (coeff.n === 1n && coeff.d === 1n) {
      parts.push(isFirst ? name : `+ ${name}`);
    } else if (coeff.n === -1n && coeff.d === 1n) {
      parts.push(isFirst ? `-${name}` : `- ${name}`);
    } else {
      const isNeg = coeff.n < 0n;
      const mag = isNeg
        ? formatRat({ n: -coeff.n, d: coeff.d })
        : formatRat(coeff);
      if (isFirst) {
        parts.push(isNeg ? `-${mag}*${name}` : `${mag}*${name}`);
      } else {
        parts.push(isNeg ? `- ${mag}*${name}` : `+ ${mag}*${name}`);
      }
    }
  }
  if (parts.length === 0) return "0";
  return parts.join(" ");
}

/** Format a Rat as a canonical-form rational string (matches Python). */
export function formatRat(r: Rat): string {
  if (r.d === 1n) return r.n.toString();
  return `${r.n}/${r.d}`;
}

/** Parse a canonical-form rational string. Strict; rejects malformed input. */
export function parseRat(s: string): Rat {
  const m = /^(-?\d+)(?:\/(\d+))?$/.exec(s.trim());
  if (!m) throw new Error(`parseRat: not a canonical rational: ${s}`);
  const n = BigInt(m[1]!);
  const d = m[2] !== undefined ? BigInt(m[2]) : 1n;
  if (d === 0n) throw new Error(`parseRat: zero denominator: ${s}`);
  // Use a fresh makeRat-like normalization to canonicalize.
  // (Inline to avoid the import cycle.)
  return reduceRat(n, d);
}

function reduceRat(n: bigint, d: bigint): Rat {
  if (d === 0n) throw new Error("zero denominator");
  let nn = n;
  let dd = d;
  if (dd < 0n) {
    nn = -nn;
    dd = -dd;
  }
  if (nn === 0n) return RAT_ZERO;
  const g = gcdAbs(nn, dd);
  return { n: nn / g, d: dd / g };
}

function gcdAbs(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) {
    const t = y;
    y = x % y;
    x = t;
  }
  return x;
}
