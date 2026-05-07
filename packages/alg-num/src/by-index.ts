// =============================================================================
// by-index.ts — `makeRootByIndex` (bead `6cd`)
// =============================================================================
//
// What this module is for
// -----------------------
// `makeRoot` (root.ts) names an algebraic by *interval hint*. The
// caller knows where the root lives and we look it up. But several
// downstream sites *don't* have an interval — they have an index into
// some ordered list of roots:
//
//   • `valueToRoot` parses a wire-encoded `Root[poly, k]` whose `k` is
//     defined as "k-th real root of `poly` in ascending order." If
//     `poly` is reducible (a contract violation by the producer, but
//     possible from agent-handcrafted input or upstream-incanonical
//     output), we have to factor and re-index.
//   • `rti`'s arithmetic (sum / product of two `Root` values) computes
//     a resultant whose root is the answer — but the resultant is
//     reducible in general, and identifying the right factor + index
//     is part of the canonicalisation contract.
//   • Future tools that emit `Root[]` from algorithms with their own
//     ordering (FGLM, primitive-element extraction).
//
// This file ships `makeRootByIndex(poly, k, v): Root`. Strategy:
//
//   1. Factor `poly` over ℚ (`factorRatQ`).
//   2. For each factor, isolate its real roots (`isolateRealRoots`).
//   3. Build a flat `(factorIntCanonical, internalK, interval)` list
//      across all factors.
//   4. Sort it ascending by *real-value* of the named root. Two roots
//      from the same factor have disjoint VAS intervals (by VAS
//      construction), so direct interval comparison works. Two roots
//      from *different* factors may have overlapping VAS intervals;
//      we bisect both intervals until disjoint, then compare.
//      Termination: distinct algebraic numbers are bounded apart by a
//      positive separation (a consequence of resultant non-vanishing
//      between the two minpolys), so bisection halves the gap and
//      eventually disjoints.
//   5. Pick the `k`-th entry; build the canonical `Root` from its
//      `(factorIntCanonical, internalK, interval)`.
//
// This matches ADR-0018 §"Equality semantics" step 1 — the
// canonicalisation-by-interval-intersection that handles
// "constructed from a non-canonical minpoly." Two `Root` values that
// passed through any of the workbench's constructors are canonical
// by construction; equality reduces to `rootCanonicalEq`.
//
// References
// ----------
// - ADR-0018 — `Root[poly, k]`; equality semantics step 1.
// - SageMath `qqbar.py` — equivalent canonicalise-by-isolation pass
//   for parsing user-supplied algebraic numbers.

import {
  type Poly,
  type Rat,
  makeRat,
  polyDegInVar,
  polyIsZero,
  polyVars,
} from "@workbench/cas-core";
import { factorRatQ } from "@workbench/poly-factor";
import { isolateRealRoots, type RealInterval } from "@workbench/real-roots";

import {
  type Root,
  type RatInterval,
  ROOT_VAR,
  canonicalIntegerForm,
  polyToHighToLowRat,
  signAtRat,
} from "./root.js";

// -----------------------------------------------------------------------------
// makeRootByIndex
// -----------------------------------------------------------------------------

/**
 * Construct a canonical `Root` value from a polynomial and a global
 * 0-indexed real-root selector `k`.
 *
 * The algebraic number is "the `k`-th real root of `poly` in ascending
 * order over ℝ." The constructor factors `poly`, identifies which
 * irreducible factor contains the named root, and returns the canonical
 * `Root` (with a possibly-different "k" — the index of the named root
 * within that factor's own ascending real-root list).
 *
 * @throws  - "input is zero / constant" if `poly` is degree ≤ 0;
 *          - "multivariate input" if `poly` mentions a variable other
 *            than `v`;
 *          - "k out of range" if `poly` has fewer than `k + 1` real
 *            roots.
 */
export function makeRootByIndex(
  poly: Poly<Rat>,
  k: number,
  v: string,
): Root {
  if (polyIsZero(poly)) {
    throw new Error("makeRootByIndex: input polynomial is zero");
  }
  if (polyDegInVar(poly, v) < 1) {
    throw new Error("makeRootByIndex: input polynomial has degree < 1");
  }
  for (const u of polyVars(poly)) {
    if (u !== v) {
      throw new Error(
        `makeRootByIndex: input is multivariate (mentions '${u}'); expected only '${v}'`,
      );
    }
  }
  if (!Number.isInteger(k) || k < 0) {
    throw new Error(`makeRootByIndex: k must be a non-negative integer; got ${k}`);
  }

  // Step 1 — factor over ℚ.
  const { factors } = factorRatQ(poly, v);
  if (factors.length === 0) {
    throw new Error("makeRootByIndex: input has no polynomial factors (constant)");
  }

  // Step 2 — for each factor, isolate its real roots.
  type FactorRoot = {
    readonly factorIntCanonical: Poly<bigint>;
    readonly internalK: number;
    interval: RealInterval;
  };
  const allRoots: FactorRoot[] = [];
  for (const { factor } of factors) {
    const factorIntCanonical = canonicalIntegerForm(factor, v);
    const intervals = isolateRealRoots(polyToHighToLowRat(factorIntCanonical, v));
    for (let i = 0; i < intervals.length; i++) {
      allRoots.push({
        factorIntCanonical,
        internalK: i,
        interval: { lo: intervals[i]!.lo, hi: intervals[i]!.hi },
      });
    }
  }

  if (k >= allRoots.length) {
    throw new Error(
      `makeRootByIndex: k=${k} ≥ number of real roots (${allRoots.length})`,
    );
  }

  // Step 3 — sort by real-value. Two roots from the same factor have
  // disjoint intervals; cross-factor intervals may overlap and require
  // bisection. The comparator below mutates `interval` to reflect
  // refinement performed during the sort — that's intentional, and
  // amortises the refinement cost across multiple comparisons.
  allRoots.sort((a, b) => compareRoots(a, b));

  const chosen = allRoots[k]!;
  return {
    minpoly: chosen.factorIntCanonical,
    k: chosen.internalK,
    interval: chosen.interval,
  };
}

// -----------------------------------------------------------------------------
// compareRoots — interval-bisection comparator for roots of distinct
// (or identical) irreducible polynomials
// -----------------------------------------------------------------------------

interface FactorRootMut {
  readonly factorIntCanonical: Poly<bigint>;
  readonly internalK: number;
  interval: RealInterval;
}

function compareRoots(a: FactorRootMut, b: FactorRootMut): number {
  // Same factor — VAS guarantees disjoint intervals for distinct
  // roots of the same polynomial; ascending-by-`lo` is the correct
  // ordering.
  if (a.factorIntCanonical === b.factorIntCanonical) {
    return ratCompare(a.interval.lo, b.interval.lo);
  }

  // Different factors — bisect both intervals until they are disjoint
  // (or one collapses to a singleton matching the other's bracket).
  // Termination is guaranteed because two distinct algebraic numbers
  // are bounded apart by a positive separation (resultant of the two
  // minpolys is nonzero), so each bisection halves the gap and the
  // intervals eventually disjoint.
  let i = 0;
  const MAX_ITERS = 8192;     // defence; matches `refine.ts`
  while (intervalsOverlap(a.interval, b.interval)) {
    if (i++ >= MAX_ITERS) {
      throw new Error(
        "compareRoots: bisection did not disjoint two intervals in 8192 iterations — "
          + "possible bug in input (two factors share a root?)",
      );
    }
    a.interval = bisectStep(a.factorIntCanonical, a.interval);
    b.interval = bisectStep(b.factorIntCanonical, b.interval);
  }
  return ratCompare(a.interval.lo, b.interval.lo);
}

// -----------------------------------------------------------------------------
// Internal — bisection step + interval geometry
// -----------------------------------------------------------------------------

function bisectStep(g: Poly<bigint>, iv: RatInterval): RatInterval {
  // Singleton: cannot refine.
  if (ratCompare(iv.lo, iv.hi) === 0) return iv;
  const m = ratMid(iv.lo, iv.hi);
  const sM = signAtRat(g, m, ROOT_VAR);
  if (sM === 0) return { lo: m, hi: m };
  const sLo = signAtRat(g, iv.lo, ROOT_VAR);
  if (sM === sLo) return { lo: m, hi: iv.hi };
  return { lo: iv.lo, hi: m };
}

function intervalsOverlap(a: RatInterval, b: RatInterval): boolean {
  return ratCompare(a.lo, b.hi) <= 0 && ratCompare(b.lo, a.hi) <= 0;
}

function ratCompare(a: Rat, b: Rat): number {
  const lhs = a.n * b.d;
  const rhs = b.n * a.d;
  if (lhs < rhs) return -1;
  if (lhs > rhs) return 1;
  return 0;
}

function ratMid(a: Rat, b: Rat): Rat {
  // (a + b) / 2.  `makeRat` reduces to lowest terms — the comparator
  // stays correct under canonical form, and downstream code that
  // reads the returned `Root.interval` benefits from canonical rats.
  return makeRat(a.n * b.d + b.n * a.d, 2n * a.d * b.d);
}
