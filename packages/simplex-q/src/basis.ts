// =============================================================================
// basis — explicit rational basis inverse with product-form rank-1 update
// =============================================================================
//
// Intent
// ------
// Maintain the inverse of the simplex method's m×m basis matrix B over ℚ,
// exactly, across pivots, in O(m²) work per pivot. Every other primitive in
// the simplex orchestrator (`simplex.ts`) reduces to either a matrix-vector
// product against `B⁻¹` or a rank-1 update of `B⁻¹` after a basis swap.
//
// Why store the inverse explicitly (rather than a factored form)
// --------------------------------------------------------------
// Three forms are reasonable for the simplex inner loop:
//
//   1. Explicit B⁻¹ + rank-1 product-form update on swap.
//   2. LU factorisation of B + eta-file growing one elementary column-
//      operation per swap; periodic refactorisation when the eta-file
//      reaches length m (the Bartels-Golub family).
//   3. Bareiss-style fraction-free elimination redone from scratch per pivot.
//
// Form (3) is O(m³) per pivot and dies past m≈50; rejected.
//
// Form (2) is the textbook industrial-strength choice for *float* simplex,
// because it lets us limit the depth of η products (and thus the accumulated
// numerical drift) by refactoring. The drift motivation evaporates over ℚ —
// exact arithmetic never drifts — and the bookkeeping cost of the
// refactor-policy machinery becomes pure overhead. We defer form (2) to a
// future revision if the bench tells us coefficient growth is worse than
// form (1) at parity (open question §2 in ADR-0031).
//
// Form (1) is what we ship in v0.1. It is O(m²) per pivot (the same
// asymptotic as form (2)), it is *literally fifteen lines of arithmetic*
// for the update step, and it is the form Dantzig's original 1947 paper
// describes. The form's downside — accumulated entry-size growth in B⁻¹
// from successive rank-1 updates — is bounded in well-conditioned LP by the
// classical Cramer-rule / Edmonds 1967 result, and is monitored at the
// driver level via `maxBitLength`. Pathological inputs hit the refusal
// envelope (`tagged "lp-solve/coefficient-explosion"`) rather than
// silently truncating.
//
// The rank-1 update derivation (Dantzig 1963, Vanderbei §6.4)
// -----------------------------------------------------------
// Let B be the current basis matrix, with column ℓ being the one we are
// about to swap out for a new column `a_q` (the entering variable's
// column in `A`). The new basis matrix is
//
//     B' = B + (a_q - B e_ℓ) e_ℓᵀ
//        = B (I + (B⁻¹ a_q - e_ℓ) e_ℓᵀ)
//        = B E
//
// where `E` is the elementary matrix that agrees with the identity except
// its ℓ-th column is `η := B⁻¹ a_q`. The inverse of E is the elementary
// matrix `E⁻¹` whose ℓ-th column is `(-η₀/η_ℓ, …, 1/η_ℓ, …, -η_{m-1}/η_ℓ)ᵀ`,
// and so
//
//     B'⁻¹ = E⁻¹ B⁻¹.
//
// Expanding row-by-row:
//
//     row_ℓ(B'⁻¹) = row_ℓ(B⁻¹) / η_ℓ                              (the pivot row)
//     row_k(B'⁻¹) = row_k(B⁻¹) - (η_k / η_ℓ) row_ℓ(B⁻¹)     for k ≠ ℓ
//
// That is exactly the row-eliminate step of Gauss-Jordan, with η in the
// pivot column and the leaving-basis row ℓ as the pivot row. The function
// `pivotUpdate` below is the implementation, in twelve lines of code.
//
// Pre/post conditions of the data structure
// -----------------------------------------
// A `BasisInverse` is a dense `m × m` rational matrix stored as
// `ReadonlyArray<ReadonlyArray<Rat>>` (outer index = row, inner = column).
// All public-facing functions are *pure*: they never mutate the input;
// `pivotUpdate` allocates and returns a fresh matrix. The simplex
// orchestrator threads the inverse through `let invB = pivotUpdate(...)`
// rather than maintaining mutable state, which keeps the invariant that
// the value at any program point is the inverse of *the* basis matrix at
// that point — no ambiguity around partially-updated states.
//
// Determinism
// -----------
// Every operation in this module is exact rational arithmetic. The result
// of any function depends only on the value of its inputs, not on any
// global state or floating-point rounding mode. Bit-identical across
// platforms forever.
//
// References
// ----------
// Dantzig 1963 *Linear Programming and Extensions* §11-3 ("The revised
// simplex method"). Vanderbei *Linear Programming* 4th ed. §6.4 ("Updating
// the basis inverse"). Both derivations are presented with the column-
// vector convention used here; if you read Chvátal *Linear Programming*
// §7 instead, note that Chvátal's η points to the *leaving* column rather
// than the *entering* column — the sign convention flips and the update
// formula has a stray minus.

import {
  type Rat,
  ratAdd,
  ratSub,
  ratMul,
  ratDiv,
  ratNeg,
  ratIsZero,
  RAT_ZERO,
  RAT_ONE,
} from "@workbench/cas-core";
import { ratBitLength } from "./rat-cmp.js";

/**
 * Dense rational matrix. Rows are the outer dimension; columns the inner.
 * Both readonly because every public function returns a fresh matrix
 * rather than mutating an existing one — see the module header.
 */
export type RatMatrix = ReadonlyArray<ReadonlyArray<Rat>>;
export type RatVector = ReadonlyArray<Rat>;

/**
 * A `BasisInverse` is the inverse `B⁻¹` of the current basis matrix,
 * stored densely. The wrapping struct is intentionally trivial — it
 * exists to make the type signatures self-documenting rather than to
 * carry extra fields. (If the eta-file revision lands, this is the
 * place that gains the `etaUpdates` list without changing the public
 * surface.)
 */
export interface BasisInverse {
  /** `B⁻¹` as a dense `m × m` rational matrix. */
  readonly invB: RatMatrix;
  /** Rows = columns of `B⁻¹` = `m` (the number of equality constraints). */
  readonly m: number;
}

/**
 * Construct the initial basis inverse for Phase 1, where the basis is the
 * artificial identity. `B = I_m` ⇒ `B⁻¹ = I_m`. The single allocation
 * here is the *only* O(m²) cost the driver pays before the first pivot.
 */
export function identityBasisInverse(m: number): BasisInverse {
  const invB: Rat[][] = [];
  for (let i = 0; i < m; i++) {
    const row: Rat[] = new Array(m);
    for (let j = 0; j < m; j++) row[j] = i === j ? RAT_ONE : RAT_ZERO;
    invB.push(row);
  }
  return { invB, m };
}

/**
 * Compute `B⁻¹ v` — the column `v` expressed in the basis's coordinates.
 *
 * This is the workhorse of the simplex inner loop: it is called once per
 * pivot to compute `η = B⁻¹ a_q` (the entering column in basis space, used
 * by the ratio test) and once to compute `x_B = B⁻¹ b` (the basic
 * variable values; for the v0.1 driver we recompute this from scratch
 * after each pivot, which is dominated by the pivot's own O(m²) cost).
 *
 * O(m²) rational operations. The result is the same length as `v` and
 * the same length as the rows of `invB` — the caller is responsible for
 * ensuring `v.length === bi.m`.
 */
export function solveBasis(bi: BasisInverse, v: RatVector): Rat[] {
  const { invB, m } = bi;
  if (v.length !== m) {
    throw new Error(`solveBasis: v has length ${v.length}, expected ${m}`);
  }
  const out: Rat[] = new Array(m);
  for (let i = 0; i < m; i++) {
    let s: Rat = RAT_ZERO;
    const row = invB[i]!;
    for (let j = 0; j < m; j++) {
      const a = row[j]!;
      if (ratIsZero(a)) continue;
      const b = v[j]!;
      if (ratIsZero(b)) continue;
      s = ratAdd(s, ratMul(a, b));
    }
    out[i] = s;
  }
  return out;
}

/**
 * Compute `B⁻ᵀ w` — used for the dual variables `y = B⁻ᵀ c_B`. Identical
 * structure to `solveBasis` with row/column swapped. O(m²).
 */
export function solveBasisT(bi: BasisInverse, w: RatVector): Rat[] {
  const { invB, m } = bi;
  if (w.length !== m) {
    throw new Error(`solveBasisT: w has length ${w.length}, expected ${m}`);
  }
  const out: Rat[] = new Array(m);
  for (let j = 0; j < m; j++) {
    let s: Rat = RAT_ZERO;
    for (let i = 0; i < m; i++) {
      const a = invB[i]![j]!;
      if (ratIsZero(a)) continue;
      const b = w[i]!;
      if (ratIsZero(b)) continue;
      s = ratAdd(s, ratMul(a, b));
    }
    out[j] = s;
  }
  return out;
}

/**
 * Apply the product-form rank-1 update for a simplex pivot.
 *
 * Given the current `B⁻¹`, the pivot column `η = B⁻¹ a_q` (already
 * computed by the caller; the driver computes it once and reuses it for
 * both the ratio test and this update), and the leaving-basis position
 * `ℓ` (an integer in `[0, m)` chosen by the ratio test), produce the new
 * basis inverse for the basis matrix that results from swapping out the
 * ℓ-th basis variable and replacing it with the entering variable.
 *
 * Precondition: `η[ℓ] !== 0`. The simplex driver guarantees this — the
 * ratio test only selects rows where `η[i] > 0`. Calling with `η[ℓ] === 0`
 * is a bug in the driver, not user input, so we throw.
 *
 * Cost: O(m²) rational operations. Allocates a fresh `m × m` matrix.
 *
 * Implementation note: the literal form
 *
 *     row_ℓ' = row_ℓ / η_ℓ
 *     row_k' = row_k - (η_k / η_ℓ) row_ℓ        for k ≠ ℓ
 *
 * has a subtle reading: in the second line, `row_ℓ` is the *old* pivot
 * row, not the *updated* one. We compute the scaled pivot row first
 * (into `newPivotRow`) and use it as the multiplier source for the other
 * rows, so that the old row is read-only throughout. This matches
 * Vanderbei §6.4 exactly.
 */
export function pivotUpdate(
  bi: BasisInverse,
  eta: RatVector,
  leavingRow: number,
): BasisInverse {
  const { invB, m } = bi;
  if (eta.length !== m) {
    throw new Error(
      `pivotUpdate: |eta|=${eta.length}, expected ${m}`,
    );
  }
  if (leavingRow < 0 || leavingRow >= m) {
    throw new Error(
      `pivotUpdate: leavingRow=${leavingRow} out of range [0, ${m})`,
    );
  }
  const pivot = eta[leavingRow]!;
  if (ratIsZero(pivot)) {
    throw new Error(
      `pivotUpdate: eta[${leavingRow}] is zero — driver bug, ratio test should have excluded this row`,
    );
  }

  // 1. Compute the scaled pivot row: row_ℓ' = (1/η_ℓ) row_ℓ
  const oldPivotRow = invB[leavingRow]!;
  const newPivotRow: Rat[] = new Array(m);
  for (let j = 0; j < m; j++) {
    newPivotRow[j] = ratDiv(oldPivotRow[j]!, pivot);
  }

  // 2. Eliminate from every other row: row_k' = row_k - η_k * row_ℓ'
  const out: Rat[][] = new Array(m);
  for (let k = 0; k < m; k++) {
    if (k === leavingRow) {
      out[k] = newPivotRow;
      continue;
    }
    const etaK = eta[k]!;
    const oldRow = invB[k]!;
    if (ratIsZero(etaK)) {
      // Untouched row — share the array reference (immutability lets us).
      out[k] = oldRow as Rat[];
      continue;
    }
    const newRow: Rat[] = new Array(m);
    for (let j = 0; j < m; j++) {
      newRow[j] = ratSub(oldRow[j]!, ratMul(etaK, newPivotRow[j]!));
    }
    out[k] = newRow;
  }

  return { invB: out, m };
}

/**
 * Compute the largest bit-length of any entry in `B⁻¹`. Used by the
 * driver to monitor coefficient growth and emit the `coefficient-explosion`
 * refusal envelope when the cap is exceeded.
 *
 * The metric is intentionally simple: `max(bitlen(num), bitlen(den))`
 * over all `m²` entries. A more refined metric (sum of bit-lengths,
 * entropy, etc.) is possible but provides no operational advantage —
 * the cap is a *cutoff*, not a precise budget, and the max-bit-length
 * captures the failure mode (one entry blowing up dwarfs the rest).
 *
 * O(m²) work, dominated by the bit-length probe on each entry. Called
 * once per pivot in the driver.
 */
export function basisBitLength(bi: BasisInverse): number {
  let mx = 0;
  for (let i = 0; i < bi.m; i++) {
    const row = bi.invB[i]!;
    for (let j = 0; j < bi.m; j++) {
      const b = ratBitLength(row[j]!);
      if (b > mx) mx = b;
    }
  }
  return mx;
}

// -----------------------------------------------------------------------------
// Small helpers used by the simplex driver and exposed for testing.
// -----------------------------------------------------------------------------

/**
 * Dot product `aᵀb` over ℚ. Used by the driver to compute reduced costs,
 * objective values, and primal/dual residuals.
 *
 * Note the early-out on zero operands — it is *load-bearing* in two
 * places. (1) The reduced-cost computation against sparse columns of `A`
 * (typical NETLIB problems have <10% non-zero density) gets a 10× speed-up
 * because most multiplications never happen. (2) BigInt multiplication of
 * a 1000-bit number by zero is cheap but a 1000-bit number by another
 * 1000-bit number is a quadratic-time operation, so the early-out turns
 * a million BigInt mults into a few thousand even when the rationals are
 * formally non-zero everywhere except a handful of positions.
 */
export function ratDot(a: RatVector, b: RatVector): Rat {
  if (a.length !== b.length) {
    throw new Error(`ratDot: length mismatch ${a.length} vs ${b.length}`);
  }
  let s: Rat = RAT_ZERO;
  for (let i = 0; i < a.length; i++) {
    const ai = a[i]!;
    if (ratIsZero(ai)) continue;
    const bi = b[i]!;
    if (ratIsZero(bi)) continue;
    s = ratAdd(s, ratMul(ai, bi));
  }
  return s;
}

/**
 * Negate every entry of a vector. Used to flip the sign convention on
 * objective coefficients during the maximise → minimise normalisation
 * in the wire wrapper (`tools/lp-solve/tool.ts`). Out-of-place for
 * immutability.
 */
export function ratVecNeg(v: RatVector): Rat[] {
  const out: Rat[] = new Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = ratNeg(v[i]!);
  return out;
}
