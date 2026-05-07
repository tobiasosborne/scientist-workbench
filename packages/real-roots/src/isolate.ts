// =============================================================================
// isolate.ts — top-level: real-root isolation over ℚ[x]
// =============================================================================
//
// `isolateRealRoots(coeffs)` accepts a squarefree univariate polynomial
// in ℚ[x] (as a high-to-low coefficient array of `Rat`) and returns a
// list of disjoint isolating intervals — open `(lo, hi)` for irrational
// roots, singletons `(r, r)` for rational roots — covering every real
// root exactly once, in ascending order. The output matches SymPy's
// `Poly.intervals()` shape modulo the rational-endpoint bisection
// cadence (which is implementation-specific).
//
// Squarefree precondition is the caller's responsibility — VAS depends
// on the sign-change ↔ root bijection, which fails for repeated factors.
// `tools/real-root-isolate` (the wire envelope) refuses non-squarefree
// inputs with `tagged "real-root-isolate/not-squarefree"`.
//
// Algorithm:
//   1. Clear denominators (ℚ → ℤ; preserves real roots).
//   2. Strip leading zeros (canonical-form input).
//   3. Detect root at zero via `f(0) = 0 ↔ trailing coef = 0`; emit
//      singleton (0, 0) and divide out `x` factor.
//   4. Isolate negative roots via VAS on `f(-x)`, then negate intervals.
//   5. Isolate positive roots via VAS on `f(x)`.
//   6. Sort all intervals ascending.

import { type Rat, makeRat, ratIsZero, ratIsNegative } from "@workbench/cas-core";
import {
  clearDenominators,
  evalAt,
  mirror,
  rshift,
  strip,
  trailing,
} from "./dense.js";
import { type Mobius, inner_isolate_positive } from "./vas.js";

export interface RealInterval {
  readonly lo: Rat;
  readonly hi: Rat;
}

/**
 * Isolate the real roots of a squarefree polynomial `f ∈ ℚ[x]`.
 *
 * @param coeffs — coefficient array in **high-to-low** order:
 *   `[c_n, c_{n-1}, …, c_0]` represents `c_n·x^n + … + c_0`. Length
 *   must be ≥ 1 (zero polynomial rejected).
 *
 * Throws on degree < 1 (constant) or zero polynomial; the value-protocol
 * tool wrapper translates that to `ToolError` per ADR-0003.
 */
export function isolateRealRoots(coeffs: readonly Rat[]): RealInterval[] {
  if (coeffs.length === 0) {
    throw new Error("isolateRealRoots: zero polynomial");
  }
  let intCoeffs = strip(clearDenominators(coeffs));
  if (intCoeffs.length === 0) {
    throw new Error("isolateRealRoots: zero polynomial after denom-clear");
  }
  if (intCoeffs.length === 1) {
    // Constant polynomial — no roots.
    return [];
  }

  const intervals: RealInterval[] = [];

  // Step 1 — strip x^j factor (root at zero with multiplicity j; we
  // only need its presence/absence since input is squarefree).
  if (trailing(intCoeffs) === 0n) {
    intervals.push({ lo: makeRat(0n, 1n), hi: makeRat(0n, 1n) });
    let k = 0;
    while (intCoeffs.length > 1 && trailing(intCoeffs) === 0n) {
      intCoeffs = rshift(intCoeffs, 1);
      k++;
    }
    if (k > 1) {
      // Squarefree ⇒ at most one factor of x. Defensive: never reached
      // under the precondition.
      throw new Error(
        `isolateRealRoots: input not squarefree (x^${k} factor at zero)`,
      );
    }
    if (intCoeffs.length === 1) {
      // After stripping zero root, only a constant remains.
      return intervals;
    }
  }

  // Step 2 — negative roots via mirror.
  const negLeaves = inner_isolate_positive(mirror(intCoeffs));
  for (const leaf of negLeaves) {
    const [lo, hi] = mobiusToInterval(leaf.M);
    // Negate and swap (mirror x → -x flips and reverses the interval).
    intervals.push({ lo: ratNegate(hi), hi: ratNegate(lo) });
  }

  // Step 3 — positive roots.
  const posLeaves = inner_isolate_positive(intCoeffs);
  for (const leaf of posLeaves) {
    const [lo, hi] = mobiusToInterval(leaf.M);
    intervals.push({ lo, hi });
  }

  // Step 4 — sort ascending by `lo` (irrational + singleton).
  intervals.sort((a, b) => ratCompare(a.lo, b.lo));
  return intervals;
}

/**
 * Convert a Möbius transform `M = (a, b, c, d)` to an interval pair
 * `(M(0), M(∞)) = (b/d, a/c)`, sorted ascending. The recursion's
 * invariant guarantees `c > 0` and `d > 0` at every leaf reached
 * through `refineUntilFinite` (the unbounded `(0, ∞)` case is
 * eliminated before exit).
 *
 * Singleton encoding: `(r, r, 1, 1)` (or any `(r, r, c, c)` with `c
 * != 0`) represents the rational singleton at `b/d == a/c`.
 */
function mobiusToInterval(M: Mobius): [Rat, Rat] {
  if (M.c === 0n) {
    // Should never happen post-refineUntilFinite. Defensive.
    throw new Error(`mobiusToInterval: c == 0 (unbounded interval)`);
  }
  const s = makeRat(M.b, M.d);
  const t = makeRat(M.a, M.c);
  return ratCompare(s, t) <= 0 ? [s, t] : [t, s];
}

function ratCompare(a: Rat, b: Rat): number {
  // a/b - c/d = (a·d - b·c) / (b·d). Both denominators positive.
  const lhs = a.n * b.d;
  const rhs = b.n * a.d;
  if (lhs < rhs) return -1;
  if (lhs > rhs) return 1;
  return 0;
}

function ratNegate(r: Rat): Rat {
  if (ratIsZero(r)) return r;
  return ratIsNegative(r) ? makeRat(-r.n, r.d) : makeRat(-r.n, r.d);
}
