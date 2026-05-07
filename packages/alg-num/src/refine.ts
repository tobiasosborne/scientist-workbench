// =============================================================================
// refine.ts — lazy isolating-interval refinement (bead `xkz`)
// =============================================================================
//
// What this module is for
// -----------------------
// A `Root` carries an isolating interval — a rational rectangle around
// the named algebraic number. The interval VAS produced at construction
// time is "tight enough to disambiguate `k` against the canonical
// minpoly's other real roots", but no tighter. Downstream consumers
// often need a *narrower* interval:
//
//   • Equality testing of two `Root` values whose construction histories
//     differ (bead `6cd`) compares minpolys + indices but, in the
//     subtle case of two non-canonical inputs sharing a single root,
//     needs interval intersection to pick out the right factor.
//   • Numerical evaluation of a `Root` value (rendering it as a
//     `float64`, plotting it, sanity-checking against an oracle) needs
//     `(hi − lo) ≤ 2^{-precision}`.
//   • Cross-`Root` arithmetic (bead `rti`) needs intervals disjoint
//     from each other and from the resultant polynomial's other roots.
//
// `refineRoot` provides the operation: take a `Root` and a target
// width (or bit-precision), return a new `Root` with the same canonical
// `(minpoly, k)` and a tighter interval. The returned interval still
// brackets the named algebraic; the canonical bytes are unchanged
// (interval is runtime state per ADR-0018 §"Lazy isolating-interval
// semantics").
//
// Algorithm: rational bisection
// -----------------------------
// We bisect the open interval `(lo, hi)` repeatedly. At each step,
// evaluate `sign(g(m))` for `m = (lo + hi) / 2`:
//
//   • If `sign(g(m)) = 0`, the root is exactly `m`; return the
//     singleton interval `(m, m)`. (Possible for rational roots whose
//     denominator divides into the bisection cadence.)
//   • Otherwise, compare `sign(g(m))` to `sign(g(lo))`. If equal, the
//     root lies in `(m, hi)` — replace `lo` with `m`. Otherwise it
//     lies in `(lo, m)` — replace `hi` with `m`. The bracket
//     invariant `sign(g(lo)) ≠ sign(g(hi))` is preserved.
//
// Each step halves the width. To reach width `2^{-bits}` from width
// `w_0` requires `⌈log_2(w_0 / 2^{-bits})⌉` iterations. Each iteration
// runs one `signAtRat` (`O(d)` BigInt mul/add over polynomial degree
// `d`). Linear convergence is sufficient for the bit-precision
// regimes the workbench operates in (≤ 256 bits typical; 1024 bits at
// the high end). The bead's "quadratic" interval-Newton is a future
// optimisation: viable, more code, larger BigInts mid-iteration; we
// defer it until benchmarks show the need.
//
// References
// ----------
// - **Bisection method** — classical; correctness is by Bolzano +
//   squarefree property (the irreducible minpoly is squarefree, so
//   exactly one sign change per real root).
// - Moore 1966 / Hansen 1992 (interval Newton) — the bead's spec
//   target, deferred.
// - ADR-0018 §"Lazy isolating-interval semantics" — interval is
//   runtime state, refinement does not change canonical bytes.

import {
  type Poly,
  type Rat,
  makeRat,
} from "@workbench/cas-core";

import {
  type Root,
  type RatInterval,
  ROOT_VAR,
  signAtRat,
} from "./root.js";

// -----------------------------------------------------------------------------
// Public surface
// -----------------------------------------------------------------------------

export interface RefineTarget {
  /**
   * Refine until `interval.hi − interval.lo ≤ maxWidth`. Must be
   * positive. Mutually exclusive with `bits`.
   */
  readonly maxWidth?: Rat;
  /**
   * Refine until `interval.hi − interval.lo ≤ 2^{-bits}`. Must be
   * non-negative. Mutually exclusive with `maxWidth`. The bit-precision
   * idiom is the typical caller surface — `refineRoot(r, { bits: 64 })`
   * gives an interval narrower than 64-bit float resolution.
   */
  readonly bits?: number;
}

/**
 * Refine a `Root`'s isolating interval until its width meets `target`.
 *
 * The returned `Root` has the same canonical minpoly + index `k`
 * (`rootCanonicalEq(refineRoot(r, t), r) === true`) and a possibly
 * tighter interval. If the current interval is already at-or-below
 * the target width, the returned `Root` is the input unchanged.
 *
 * For singleton intervals (rational roots: `lo == hi`), refinement is
 * a no-op — the interval is already exact.
 */
export function refineRoot(r: Root, target: RefineTarget): Root {
  // Singleton (rational root): can't refine; nothing to do.
  if (ratCompare(r.interval.lo, r.interval.hi) === 0) return r;

  const maxWidth = computeMaxWidth(target);
  if (maxWidth === null) {
    throw new Error("refineRoot: target must specify exactly one of `maxWidth` or `bits`");
  }
  if (ratIsNonPositive(maxWidth)) {
    throw new Error(
      `refineRoot: maxWidth must be positive; got ${maxWidth.n}/${maxWidth.d}`,
    );
  }

  // Already at-or-below target: no work.
  if (!ratGT(intervalWidth(r.interval), maxWidth)) return r;

  const refined = bisectInterval(r.minpoly, r.interval, maxWidth, ROOT_VAR);
  return { ...r, interval: refined };
}

/** Width `hi − lo` of an interval as a `Rat`. */
export function intervalWidth(iv: RatInterval): Rat {
  const num = iv.hi.n * iv.lo.d - iv.lo.n * iv.hi.d;
  const den = iv.hi.d * iv.lo.d;
  return makeRat(num, den);
}

// -----------------------------------------------------------------------------
// Bisection — the inner loop
// -----------------------------------------------------------------------------

function bisectInterval(
  g: Poly<bigint>,
  initial: RatInterval,
  maxWidth: Rat,
  v: string,
): RatInterval {
  let lo = initial.lo;
  let hi = initial.hi;

  // Cache sLo (the sign at the lower endpoint). The bracket invariant
  // is `signAtRat(g, lo) ≠ signAtRat(g, hi)` (or one is zero, in which
  // case lo or hi is itself the root and we degenerate to a singleton).
  let sLo = signAtRat(g, lo, v);
  if (sLo === 0) return { lo, hi: lo };
  // Defensive: if hi is itself a root, return (hi, hi).
  if (signAtRat(g, hi, v) === 0) return { lo: hi, hi };

  // Defensive iteration cap: refining a width-W interval to width
  // `maxWidth` takes `⌈log_2(W / maxWidth)⌉` steps. For W = 1 and
  // maxWidth = 2^{-1024} that's 1024 — never exceeds a few thousand
  // for any sensible target. The cap protects against pathological
  // BigInt inputs (e.g., a target that's never attainable due to a
  // bug in caller's `maxWidth` construction).
  const MAX_ITERS = 8192;
  let iter = 0;

  while (ratGT(ratSub(hi, lo), maxWidth)) {
    if (iter++ >= MAX_ITERS) {
      throw new Error(
        `refineRoot: bisection did not converge in ${MAX_ITERS} iterations — `
          + `target maxWidth ${maxWidth.n}/${maxWidth.d} may be unreachable`,
      );
    }

    const m = ratMid(lo, hi);
    const sM = signAtRat(g, m, v);
    if (sM === 0) {
      // The midpoint is exactly the root.
      return { lo: m, hi: m };
    }
    if (sM === sLo) {
      // Same sign as lo — root is in (m, hi).
      lo = m;
    } else {
      // Opposite sign — root is in (lo, m).
      hi = m;
    }
  }
  return { lo, hi };
}

// -----------------------------------------------------------------------------
// Internal helpers
// -----------------------------------------------------------------------------

function computeMaxWidth(target: RefineTarget): Rat | null {
  const hasMaxWidth = target.maxWidth !== undefined;
  const hasBits = target.bits !== undefined;
  if (hasMaxWidth === hasBits) return null;     // both or neither
  if (hasMaxWidth) return target.maxWidth!;
  // hasBits — convert to 2^{-bits} as a Rat. `bits` may be 0 (target
  // is `≤ 1`); we admit it. Negative `bits` is rejected.
  const b = target.bits!;
  if (!Number.isInteger(b) || b < 0) {
    throw new Error(`refineRoot: bits must be a non-negative integer; got ${b}`);
  }
  return makeRat(1n, 1n << BigInt(b));
}

function ratMid(a: Rat, b: Rat): Rat {
  // (a + b) / 2 = (a.n * b.d + b.n * a.d) / (2 · a.d · b.d).
  return makeRat(a.n * b.d + b.n * a.d, 2n * a.d * b.d);
}

function ratSub(a: Rat, b: Rat): Rat {
  return makeRat(a.n * b.d - b.n * a.d, a.d * b.d);
}

function ratGT(a: Rat, b: Rat): boolean {
  // Both denominators are positive in canonical Rat form.
  return a.n * b.d > b.n * a.d;
}

function ratCompare(a: Rat, b: Rat): number {
  const lhs = a.n * b.d;
  const rhs = b.n * a.d;
  if (lhs < rhs) return -1;
  if (lhs > rhs) return 1;
  return 0;
}

function ratIsNonPositive(r: Rat): boolean {
  return r.n <= 0n;
}
