// =============================================================================
// rat-cmp — total order on Rat
// =============================================================================
//
// `@workbench/cas-core` ships `Rat` (BigInt numerator / BigInt denominator,
// normalised to lowest terms with positive denominator) and the field
// arithmetic on it, but the original surface only exposes `ratEq` and
// `ratIsNegative` — no `ratLt` / `ratCompare`. That gap is fine for the
// algebraic-number and Gröbner-basis use cases the substrate was built for,
// since those algorithms never need to *order* rationals; they only need
// "is this zero?" and the field operations.
//
// Simplex needs the order. The ratio test is `argmin_{i : η_i > 0} x_B[i] / η_i`
// and the Bland-rule tiebreaker is "smallest basis index among the argmin
// set" — both require a total order on Rat. We implement it here as a
// three-line shim rather than upstream into cas-core, because (a) the
// algorithm-specific module is the honest home for the routine, (b)
// upstream churn against a settled package is unnecessary, and (c) the
// shim is exactly one cross-multiplication: `a/b < c/d` iff `a*d < c*b`
// when `b, d > 0` (which `makeRat` guarantees).
//
// Numerically: each comparison is one BigInt multiply per side plus one
// BigInt subtraction. For coefficients of ~k bits, ~O(k) work. Equality
// (`ratEq`) is two BigInt equality checks and is dramatically cheaper —
// we re-export it for the rare call site that wants strict equality
// without going through `ratCompare`.

import { type Rat, ratEq } from "@workbench/cas-core";

/**
 * Sign-only result of comparing two rationals.
 *
 * The choice of `-1 | 0 | 1` (a literal union, not `number`) is
 * deliberate: TypeScript narrows callers to the three cases under
 * `switch`/`if`-chains, and the simplex's ratio-test logic reads
 * cleaner against `=== -1` than against a numeric subtraction.
 */
export type Sign = -1 | 0 | 1;

/**
 * `ratCompare(a, b)` returns `-1` if `a < b`, `0` if `a === b`, `1` if `a > b`.
 *
 * Exact over ℚ — there is no tolerance and no edge case. The single
 * subtraction never overflows because BigInt is arbitrary precision; it
 * never loses precision because both operands are already integers (the
 * numerators and denominators of a `Rat` are BigInts).
 *
 * Pre-condition: both inputs are normalised `Rat` values produced by
 * `makeRat` (lowest terms, positive denominator). Direct construction of
 * `{n, d}` literals that violate the invariant is undefined behaviour;
 * callers must go through `makeRat`.
 */
export function ratCompare(a: Rat, b: Rat): Sign {
  // a/b < c/d  iff  a*d - c*b < 0   (when b, d > 0, which makeRat guarantees)
  const lhs = a.n * b.d;
  const rhs = b.n * a.d;
  if (lhs < rhs) return -1;
  if (lhs > rhs) return 1;
  return 0;
}

export const ratLt = (a: Rat, b: Rat): boolean => ratCompare(a, b) === -1;
export const ratLe = (a: Rat, b: Rat): boolean => ratCompare(a, b) !== 1;
export const ratGt = (a: Rat, b: Rat): boolean => ratCompare(a, b) === 1;
export const ratGe = (a: Rat, b: Rat): boolean => ratCompare(a, b) !== -1;

/** `true` iff `a > 0` (numerator-only check; `d > 0` always). */
export const ratIsPositive = (a: Rat): boolean => a.n > 0n;

/** Re-export for call sites that want strict equality without the order. */
export { ratEq };

/**
 * Bit-length of the largest of `|n|`, `|d|` for a Rat. Used by the
 * coefficient-explosion sentinel in the simplex driver — the agent-
 * honest refusal mode for pathological inputs (CLAUDE.md Rule 8).
 *
 * BigInt has no `bitLength` primitive; we use the standard "binary log"
 * via `toString(2).length`. The branch on the empty/zero case keeps the
 * answer `0` for `Rat(0)` (matching the `bitLength(0n) === 0`
 * convention used by `cas-core` and `protocol`).
 */
export function ratBitLength(r: Rat): number {
  const a = r.n < 0n ? -r.n : r.n;
  const b = r.d; // already positive
  const lenA = a === 0n ? 0 : a.toString(2).length;
  const lenB = b === 1n ? 0 : b.toString(2).length;
  return lenA > lenB ? lenA : lenB;
}
