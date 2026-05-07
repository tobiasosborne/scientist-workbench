// =============================================================================
// vas.ts — Vincent-Akritas-Strzebonski continued-fraction real-root isolation
// =============================================================================
//
// The core recursion. Operates on integer-coefficient polynomials in the
// high-to-low SymPy convention (`bigint[]`). Tracks an evolving Möbius
// transform `M = (a, b, c, d)` representing the linear-fractional map
//
//     M(x) = (a·x + b) / (c·x + d)
//
// applied to the original recursion variable. At any leaf where the
// transformed polynomial has *exactly one* positive root, the original
// polynomial has *exactly one* root in the interval whose endpoints are
// `M(0) = b/d` and `M(∞) = a/c` (sorted). The recursion subdivides the
// positive real axis by the two Möbius transformations:
//
//     branch 1 (translate):   x → x + 1     ↦  sub-interval (b/d, (a+b)/(c+d))
//     branch 2 (invert+shift): x → 1/(x+1)  ↦  sub-interval ((a+b)/(c+d), a/c)
//
// Combined with Vincent's theorem (1836) — the recursion's leaves are
// reached when the polynomial's Descartes sign-variation count is 0 or
// 1, decidable in `O(deg·n_coefs)` integer ops — and Akritas-
// Strzebonski-Vigklas's LMQ bound (2008) controlling the recursion
// depth, this is the VAS-LMQ algorithm.
//
// Reference: SymPy's `dup_inner_isolate_real_roots` and
// `dup_step_refine_real_root` (BSD,
// `sympy/polys/rootisolation.py`). The TS port follows the source line
// by line; comments cross-reference. The reference polynomial bank in
// `bench/real-root-isolate` is the correctness gate.
//
// Output: a list of `(M, polyAtLeaf)` pairs. The endpoint extraction
// is in `isolate.ts`.

import {
  degree,
  evalAt,
  reverse,
  rshift,
  shift,
  signVariations,
  trailing,
} from "./dense.js";
import { lmqLowerBoundFloor } from "./lmq.js";

/**
 * Möbius transform `M = (a, b, c, d)` representing `M(x) = (a·x + b) /
 * (c·x + d)`. The four entries are bigints; the transform is finite
 * everywhere except `x = -d/c` (avoided by the recursion's invariants).
 */
export interface Mobius {
  readonly a: bigint;
  readonly b: bigint;
  readonly c: bigint;
  readonly d: bigint;
}

/** Identity `M(x) = x`: `(a, b, c, d) = (1, 0, 0, 1)`. */
export const MOBIUS_ID: Mobius = { a: 1n, b: 0n, c: 0n, d: 1n };

/** A leaf of the recursion: `(transformed-polynomial, accumulated-Möbius)`. */
export interface Leaf {
  readonly f: bigint[];
  readonly M: Mobius;
}

/**
 * Single step of the positive-root refinement recursion. Used by the
 * `while (M.c == 0n)` loop below to convert an unbounded leaf interval
 * `(b/d, ∞)` into a bounded one. SymPy's `dup_step_refine_real_root`,
 * lines 223-267.
 *
 * Returns the updated `(f, M)` pair after exactly one bisection step.
 */
function stepRefine(f: bigint[], M: Mobius): Leaf {
  let { a, b, c, d } = M;

  // Singleton (a == b, c == d): no work to do.
  if (a === b && c === d) return { f, M };

  const Aeff = lmqLowerBoundFloor(f);

  if (Aeff >= 1n) {
    f = shift(f, Aeff);
    b = Aeff * a + b;
    d = Aeff * c + d;
    if (evalAt(f, 0n) === 0n) {
      // `M(0) = b/d` is a singleton root.
      return { f, M: { a: b, b, c: d, d } };
    }
  }

  // Branch 1: translate by 1.
  let fNext = shift(f, 1n);
  const a1 = a;
  const b1 = a + b;
  const c1 = c;
  const d1 = c + d;

  if (evalAt(fNext, 0n) === 0n) {
    // `M_new(0) = (a+b)/(c+d)` is a singleton root.
    return { f: fNext, M: { a: b1, b: b1, c: d1, d: d1 } };
  }

  const k = signVariations(fNext);
  if (k === 1) {
    return { f: fNext, M: { a: a1, b: b1, c: c1, d: d1 } };
  }

  // Branch 2: x → 1/(x+1) on the *original* `f` (not the shifted one).
  let fAlt = shift(reverse(f), 1n);
  if (evalAt(fAlt, 0n) === 0n) fAlt = rshift(fAlt, 1);
  return {
    f: fAlt,
    M: { a: b, b: a + b, c: d, d: c + d },
  };
}

/**
 * Refine a Möbius leaf into a finite-endpoint interval (`c > 0`). Used
 * by the inner-isolate recursion when the leaf's `c == 0` (corresponding
 * to an unbounded interval `(b/d, ∞)`). SymPy's
 * `dup_inner_refine_real_root`, the `while not c` loop, lines 278-280.
 *
 * The loop terminates because each `stepRefine` either lands on a
 * singleton (b/d == a/c at finite values) or enters a `c > 0` regime
 * within finitely many steps (the recursion's correctness theorem).
 */
function refineUntilFinite(f: bigint[], M: Mobius): Leaf {
  let cur: Leaf = { f, M };
  let safety = 0;
  while (cur.M.c === 0n) {
    cur = stepRefine([...cur.f], cur.M);
    if (++safety > 1024) {
      throw new Error(
        `vas.refineUntilFinite: failed to converge after 1024 steps; degree=${degree(cur.f)}`,
      );
    }
  }
  return cur;
}

/**
 * Isolate the *positive* real roots of `f`. Returns a list of leaves
 * `{f, M}` such that `M(0)` and `M(∞)` are the rational endpoints of
 * an interval enclosing exactly one positive real root of the
 * original input polynomial. Singleton roots (rational positive roots)
 * are returned as `M = (r, r, 1, 1)` (so both endpoints equal `r`).
 *
 * The empty list means `f` has no positive real roots. SymPy's
 * `dup_inner_isolate_real_roots`, lines 358-470. Stack-based DFS to
 * keep the JS stack from blowing on high-degree inputs.
 */
export function inner_isolate_positive(f: readonly bigint[]): Leaf[] {
  const k0 = signVariations(f);
  if (k0 === 0) return [];

  if (k0 === 1) {
    return [refineUntilFinite([...f], MOBIUS_ID)];
  }

  const roots: Leaf[] = [];
  const stack: { M: Mobius; f: bigint[]; k: number }[] = [
    { M: MOBIUS_ID, f: [...f], k: k0 },
  ];

  while (stack.length > 0) {
    const cur = stack.pop()!;
    let { a, b, c, d } = cur.M;
    let g = cur.f;
    let k = cur.k;

    const A = lmqLowerBoundFloor(g);

    if (A >= 1n) {
      g = shift(g, A);
      b = A * a + b;
      d = A * c + d;

      if (trailing(g) === 0n) {
        // `M(0) = b/d` is a rational root.
        roots.push({ f: g, M: { a: b, b, c: d, d } });
        g = rshift(g, 1);
      }

      k = signVariations(g);
      if (k === 0) continue;
      if (k === 1) {
        roots.push(refineUntilFinite(g, { a, b, c, d }));
        continue;
      }
    }

    // Branch 1: g → g(x + 1).
    let f1 = shift(g, 1n);
    let a1 = a;
    let b1 = a + b;
    let c1 = c;
    let d1 = c + d;
    let r = 0;

    if (trailing(f1) === 0n) {
      roots.push({ f: f1, M: { a: b1, b: b1, c: d1, d: d1 } });
      f1 = rshift(f1, 1);
      r = 1;
    }

    let k1 = signVariations(f1);
    let k2 = k - k1 - r;

    let a2 = b;
    let b2 = a + b;
    let c2 = d;
    let d2 = c + d;

    let f2: bigint[] | null = null;
    if (k2 > 1) {
      f2 = shift(reverse(g), 1n);
      if (trailing(f2) === 0n) f2 = rshift(f2, 1);
      k2 = signVariations(f2);
    }

    // Recurse on the smaller-k branch first (SymPy heuristic: depth
    // proportional to k of the branch).
    if (k1 < k2) {
      [a1, a2] = [a2, a1];
      [b1, b2] = [b2, b1];
      [c1, c2] = [c2, c1];
      [d1, d2] = [d2, d1];
      const fSwap = f1;
      f1 = f2!;
      f2 = fSwap;
      [k1, k2] = [k2, k1];
    }

    // Process branch 1.
    if (k1 > 0) {
      if (f1 === null) {
        // Lazy materialization (only happens if we swapped).
        f1 = shift(reverse(g), 1n);
        if (trailing(f1) === 0n) f1 = rshift(f1, 1);
      }
      if (k1 === 1) {
        roots.push(refineUntilFinite(f1, { a: a1, b: b1, c: c1, d: d1 }));
      } else {
        stack.push({ M: { a: a1, b: b1, c: c1, d: d1 }, f: f1, k: k1 });
      }
    }

    // Process branch 2.
    if (k2 > 0) {
      if (f2 === null) {
        f2 = shift(reverse(g), 1n);
        if (trailing(f2) === 0n) f2 = rshift(f2, 1);
      }
      if (k2 === 1) {
        roots.push(refineUntilFinite(f2, { a: a2, b: b2, c: c2, d: d2 }));
      } else {
        stack.push({ M: { a: a2, b: b2, c: c2, d: d2 }, f: f2, k: k2 });
      }
    }
  }

  return roots;
}
