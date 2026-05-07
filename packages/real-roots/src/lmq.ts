// =============================================================================
// lmq.ts — Local Max Quadratic positive-root bounds (Akritas-Strzebonski-Vigklas)
// =============================================================================
//
// LMQ is the headline efficiency improvement of VAS over earlier
// real-root isolators. The bound is:
//
//     LMQ_upper(f) = 2^{1 + max_k q_k}
//
// where `q_k` (one per negative coefficient `c_k`) is the smallest
// quotient `floor((t_j + log2(−c_k) − log2(c_j)) / (j − k))` over all
// later positive coefficients `c_j`, and `t_j` counts the number of
// times slot `j` has been "consumed" as the denominator partner for
// some earlier negative `c_k` (each consumption increments `t_j`).
//
// `LMQ_lower(f) = 1 / LMQ_upper(reverse(f))` — the lower bound on
// positive roots is the reciprocal of the upper bound on the reversed
// polynomial's positive roots (the standard `x ↔ 1/x` duality).
//
// The exponent `max(P) + 1` can be **negative** when the polynomial's
// negative-coefficient magnitudes are dominated by later positive
// coefficients (e.g., `f = x − 100` has all positive roots in `[16,
// 200]`, so the LMQ lower bound is 16 — coming from `LMQ_upper(reverse
// f)` returning `2^{-4} = 1/16`). The return type is therefore a
// rational `2^k` represented by its exponent `k`, not a bigint.
//
// Reference: Akritas, "Linear and Quadratic Complexity Bounds on the
// Values of the Positive Roots of Polynomials," J. Universal Comp.
// Sci. 15(3): 523-537, 2009 — the LMQ definition is verbatim.
// SymPy's `dup_root_upper_bound` is the line-by-line port reference.

import { ilog2Floor, leading, negate, reverse } from "./dense.js";

/**
 * LMQ upper bound on the *positive* real roots of `f`, returned as the
 * power-of-2 exponent `k` such that the bound is `2^k`. The `2^k` form
 * is the natural output of LMQ; the caller can compare exponents
 * directly without ever materialising the integer `2^k`, which avoids
 * a wasteful exponentiation when the exponent is large.
 *
 * Returns `null` when no negative coefficient exists (no positive
 * roots ⇒ no bound needed; the caller must short-circuit via
 * sign-variation count).
 *
 * The polynomial is interpreted in low-to-high order *for the bound
 * computation* (the source paper writes coefficients `c_0, c_1, …,
 * c_n` indexed by power), so the high-to-low input array is reversed
 * internally. SymPy does the same `f = list(reversed(f))` step.
 */
export function lmqUpperBoundLog2(fHighToLow: readonly bigint[]): number | null {
  if (fHighToLow.length === 0) return null;
  let f = [...fHighToLow];
  if (leading(f) < 0n) f = negate(f);
  const c = [...f].reverse();
  const n = c.length;
  const t = new Array<number>(n).fill(1);
  const P: number[] = [];

  for (let i = 0; i < n; i++) {
    if (c[i]! >= 0n) continue;
    const a = ilog2Floor(-c[i]!);
    const QL: { q: number; j: number }[] = [];

    for (let j = i + 1; j < n; j++) {
      if (c[j]! <= 0n) continue;
      // q = t[j] + a - log2(c[j])  ;  bound exponent = floor(q / (j - i)).
      const q = t[j]! + a - ilog2Floor(c[j]!);
      QL.push({ q: Math.floor(q / (j - i)), j });
    }

    if (QL.length === 0) continue;

    let best = QL[0]!;
    for (const item of QL) {
      if (item.q < best.q || (item.q === best.q && item.j < best.j)) best = item;
    }
    t[best.j]! += 1;
    P.push(best.q);
  }

  if (P.length === 0) return null;
  return Math.max(...P) + 1;
}

/**
 * `floor(LMQ_lower(f))` as a bigint — the integer shift amount the
 * VAS recursion uses. By definition `LMQ_lower(f) = 1 / LMQ_upper(
 * reverse(f)) = 2^{-upperRev}`, so:
 *
 *     floor(2^{-k}) = 0           if k > 0
 *                   = 1           if k == 0
 *                   = 2^{-k}      if k < 0
 *
 * Returns `0n` when there's no negative coefficient in `reverse(f)`
 * (the bound is undefined; the caller skips the shift step).
 */
export function lmqLowerBoundFloor(fHighToLow: readonly bigint[]): bigint {
  const k = lmqUpperBoundLog2(reverse(fHighToLow));
  if (k === null) return 0n;
  if (k > 0) return 0n;
  if (k === 0) return 1n;
  return 1n << BigInt(-k);
}
