// =============================================================================
// root.ts — `Root[poly, k]`: the algebraic-number naming primitive
// =============================================================================
//
// What this module is for
// -----------------------
// `Root` is the workbench's encoding of "name a particular root of a
// particular polynomial." It is the v0.1 substrate the rest of the
// algebraic-number stack — interval refinement (xkz), equality (6cd),
// resultant-based arithmetic (rti), primitive-element compression
// (5i2) — is built on, and the answer shape `tools/poly-roots` will
// emit for irreducible polynomials of degree ≥ 5 once `yoc` ships.
//
// The decision to name (rather than refuse) high-degree algebraics is
// ADR-0018; this module implements the substrate of that ADR. The
// naming scheme follows Mathematica `Root[]` and SageMath `qqbar` /
// `AA`: a `Root` carries a *minimal polynomial* in canonical form
// (irreducible over ℚ, primitive over ℤ, positive leading coefficient)
// plus an integer index `k` selecting which root of that polynomial.
// Two `Root` values are equal iff their canonical minpolys are equal
// and their indices match.
//
// Scope of v0.1 (this file)
// -------------------------
// **Real roots only.** The constructor accepts a polynomial in ℚ[x]
// plus a *real* isolating-interval hint and returns the canonical
// `Root` whose root lies in the hint. The index `k` is the position
// of the root in the canonical minpoly's *real-root list*, sorted
// ascending — for real-root-only `Root` values this matches ADR-0018's
// "real first ascending, then complex by (Im, Re)" rule (the complex
// half is empty here).
//
// Complex algebraic naming is a future-shard concern: it requires
// complex-root isolation (planar VAS / Pinkert / Pan-Sevriuk),
// which the workbench does not yet ship. Until then, complex
// algebraics live in nested `AlgebraicElement<R>` chains (cas-core,
// ADR-0008) — e.g. `Q[√2][i]` via `Q_SQRT2_I`. The two encodings
// compose: a future bridge promotes a `Root` to an `AlgebraicElement`
// generator (P3-8) for arithmetic in `Q[α]`.
//
// Canonical form (ADR-0018 §"Canonical form of the minimal polynomial")
// ---------------------------------------------------------------------
// The minpoly stored in a `Root` is:
//   1. **Irreducible over ℚ** — the constructor factors any reducible
//      input via `factorRatQ` and selects the unique factor whose root
//      lies in the supplied isolating interval.
//   2. **Primitive (content-stripped over ℤ)** — gcd of integer
//      coefficients is 1.
//   3. **Integer-coefficient** — denominators cleared by LCM.
//   4. **Positive leading coefficient** — sign-flipped if needed.
// Together, (2)–(4) guarantee that two algebraic numbers with the
// same minimal polynomial canonicalise to identical bytes. (1)
// guarantees the minimal-polynomial map is well-defined.
//
// The isolating interval is **runtime state**, not part of the
// canonical bytes (ADR-0018 §"Lazy isolating-interval semantics"):
// determinism (PRD §0.1) requires the same algebraic number to
// canonicalise to the same bytes regardless of how much refinement
// has happened to its interval. This module stores the current
// interval on the `Root` value because the alg-num substrate needs
// it for arithmetic and equality; the *encoding* (encoding.ts)
// drops it on serialisation and re-derives it on parse.
//
// Construction-time disambiguation by interval
// --------------------------------------------
// The canonicalisation step has one subtlety: when the input is
// reducible, *which* irreducible factor names the supplied root?
// The answer is "the factor that has a real root inside the supplied
// isolating-interval hint." Implementing this requires running VAS
// on each candidate factor and looking for an isolating interval
// that lies inside the hint. If exactly one factor matches, that's
// the canonical minpoly. If zero match, the hint is wrong (no root
// of the input lies in it) — caller error. If two or more match,
// the hint is ambiguous (multiple distinct factors have roots in
// it) — caller must refine the hint.
//
// References
// ----------
// - ADR-0018 — `Root[poly, k]` value-protocol primitive.
// - ADR-0008 — `AlgebraicElement<R>` (the *element-of* type that
//   composes with `Root` via primitive-element promotion, P3-8).
// - SageMath `sage/rings/qqbar.py` — closest open-source reference
//   for lazy `(minpoly, interval)` algebraic-number arithmetic.
// - Cohen 1993, *A Course in Computational Algebraic Number Theory*
//   (GTM 138), §3.6 — resultant-based arithmetic (rti / 6cd).

import {
  type Poly,
  type Rat,
  INT_RING,
  RAT_RING,
  makeRat,
  polyConstValue,
  polyCoeffsInVar,
  polyDegInVar,
  polyEq,
  polyFromCoeffsInVar,
  polyIsZero,
  polyVars,
} from "@workbench/cas-core";
import { factorRatQ } from "@workbench/poly-factor";
import { isolateRealRoots, type RealInterval } from "@workbench/real-roots";

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export interface RatInterval {
  readonly lo: Rat;
  readonly hi: Rat;
}

export interface Root {
  /**
   * Canonical minimal polynomial in `ℤ[x]`: irreducible over ℚ,
   * primitive (gcd of coefficients = 1), positive leading coefficient.
   * Stored as a `Poly<bigint>` over the principal variable `"x"` —
   * the variable name is fixed by convention; `Root` does not carry
   * a per-instance variable name (the wire format does not either).
   */
  readonly minpoly: Poly<bigint>;

  /**
   * 0-indexed position of this root in the canonical sort order of
   * the minpoly's roots over ℂ:
   *   - real roots first, ascending by real value;
   *   - then complex roots, lexicographic by `(Im, Re)`.
   * For v0.1 real-only `Root` values, `k ∈ [0, #real-roots)`.
   */
  readonly k: number;

  /**
   * Current rational isolating interval `(lo, hi]` containing the
   * named root. Runtime state — not part of the canonical bytes.
   * Width contracts on demand (xkz: interval Newton); for v0.1 we
   * store the interval VAS produced and never refine.
   *
   * For rational roots, `lo == hi == r` (a singleton).
   */
  readonly interval: RatInterval;
}

/** Variable name used internally for the minpoly. ADR-0018 leaves the
 * name implicit on the wire (`Polynomial[c_0, …, c_n]` is positional);
 * we pick `"x"` as the canonical internal name for the `Poly<bigint>`
 * representation. */
export const ROOT_VAR = "x" as const;

// -----------------------------------------------------------------------------
// makeRoot — the canonical constructor
// -----------------------------------------------------------------------------

/**
 * Construct a canonical `Root` value from a polynomial and an
 * isolating-interval hint identifying which root.
 *
 * @param poly  Polynomial in `ℚ[v]`. May be reducible, may have
 *              rational coefficients, may have non-monic leading
 *              coefficient. Multivariate input is rejected.
 *
 * @param intervalHint  A rational interval `[lo, hi]` (closed; the
 *              endpoints may equal) that contains *exactly one* root
 *              of `poly`. The constructor checks that exactly one
 *              irreducible factor of `poly` has a real root in the
 *              hint and uses that factor as the canonical minpoly.
 *
 * @param v     Principal variable name for `poly`.
 *
 * @returns  A `Root` with canonical minpoly + index k + a (possibly
 *           tightened) interval. The returned interval is always at
 *           least as tight as `intervalHint` (it is the canonical
 *           minpoly's k-th VAS interval, intersected with the hint).
 *
 * @throws  - "input is zero / constant" if `poly` is degree ≤ 0;
 *          - "multivariate input" if `poly` mentions a variable other
 *            than `v`;
 *          - "no root in interval hint" if no factor has a real root
 *            inside the hint;
 *          - "ambiguous interval hint" if multiple distinct factors
 *            have real roots inside the hint.
 */
export function makeRoot(
  poly: Poly<Rat>,
  intervalHint: RatInterval,
  v: string,
): Root {
  if (polyIsZero(poly)) {
    throw new Error("makeRoot: input polynomial is zero");
  }
  if (polyDegInVar(poly, v) < 1) {
    throw new Error("makeRoot: input polynomial has degree < 1");
  }
  for (const u of polyVars(poly)) {
    if (u !== v) {
      throw new Error(
        `makeRoot: input is multivariate (mentions '${u}'); expected only '${v}'`,
      );
    }
  }
  if (ratCompare(intervalHint.lo, intervalHint.hi) > 0) {
    throw new Error(
      `makeRoot: invalid interval hint (lo > hi): lo=${ratStr(intervalHint.lo)}, hi=${ratStr(intervalHint.hi)}`,
    );
  }

  // Step 1 — factor over ℚ. `factorRatQ` returns content + irreducible
  // monic factors. The content does not affect roots; we discard it.
  const { factors } = factorRatQ(poly, v);
  if (factors.length === 0) {
    // Constant input — degree check above should have caught this,
    // but the factorRatQ contract permits an empty factor list when
    // the input is a constant. Defensive.
    throw new Error("makeRoot: input has no polynomial factors (constant)");
  }

  // Step 2 — for each factor, isolate its real roots; for each VAS
  // interval, decide whether the named root lies inside the hint
  // using the sign criterion (see `rootInHint` below). Collect
  // (factor, k) candidates.
  //
  // A factor with two-or-more roots inside the hint is a hard error
  // (the hint is too wide *for that factor*). A factor with exactly
  // one root in the hint becomes a candidate; if multiple distinct
  // factors each have one root in the hint, that's the
  // cross-factor-ambiguous case.
  type Candidate = {
    readonly factorIntCanonical: Poly<bigint>;
    readonly k: number;
    readonly chosenInterval: RealInterval;
  };
  const candidates: Candidate[] = [];
  let perFactorAmbiguity: { readonly factor: Poly<bigint>; readonly count: number } | null = null;

  for (const { factor } of factors) {
    const factorIntCanonical = canonicalIntegerForm(factor, v);
    const coeffsHighToLow = polyToHighToLowRat(factorIntCanonical, v);
    const intervals = isolateRealRoots(coeffsHighToLow);
    const matches: number[] = [];
    for (let i = 0; i < intervals.length; i++) {
      if (rootInHint(factorIntCanonical, intervals[i]!, intervalHint, v)) {
        matches.push(i);
      }
    }
    if (matches.length === 0) continue;
    if (matches.length > 1) {
      perFactorAmbiguity = { factor: factorIntCanonical, count: matches.length };
      continue;
    }
    candidates.push({
      factorIntCanonical,
      k: matches[0]!,
      chosenInterval: intervals[matches[0]!]!,
    });
  }

  if (candidates.length === 0 && perFactorAmbiguity === null) {
    throw new Error(
      `makeRoot: no irreducible factor of the input has a real root in [${ratStr(intervalHint.lo)}, ${ratStr(intervalHint.hi)}]`,
    );
  }
  if (perFactorAmbiguity !== null) {
    // Even a single factor has 2+ roots in the hint — the hint is too
    // wide to identify any single root unambiguously.
    throw new Error(
      `makeRoot: ambiguous interval hint [${ratStr(intervalHint.lo)}, ${ratStr(intervalHint.hi)}] contains ${perFactorAmbiguity.count} real roots of factor ${describePoly(perFactorAmbiguity.factor, v)}; refine the hint`,
    );
  }
  if (candidates.length > 1) {
    // Two distinct factors each have a root in the hint — cross-factor
    // ambiguity. Tighten the hint to isolate a single root of the
    // *whole* input.
    const factorDescs = candidates.map((c) => describePoly(c.factorIntCanonical, v));
    throw new Error(
      `makeRoot: ambiguous interval hint [${ratStr(intervalHint.lo)}, ${ratStr(intervalHint.hi)}] contains roots of multiple distinct irreducible factors (${factorDescs.join("; ")}); refine the hint`,
    );
  }

  const c = candidates[0]!;
  return {
    minpoly: c.factorIntCanonical,
    k: c.k,
    interval: { lo: c.chosenInterval.lo, hi: c.chosenInterval.hi },
  };
}

// -----------------------------------------------------------------------------
// rootCanonicalEq — equality of canonical Roots (cheap path; full
// equality semantics — including handling of non-canonical inputs by
// interval intersection — is bead `6cd`'s job)
// -----------------------------------------------------------------------------

/**
 * Equality test for two `Root` values *both already in canonical form*.
 * Two such roots are equal iff their minpolys are byte-equal and their
 * indices match.
 *
 * This is a partial implementation of ADR-0018 §"Equality semantics":
 * it covers the post-canonicalisation comparison (steps 3–4 of the
 * ADR's algorithm). The full canonicalisation-then-compare path —
 * needed when a `Root` value is reconstructed from a non-canonical
 * polynomial via interval intersection — is bead `scientist-workbench-6cd`.
 */
export function rootCanonicalEq(a: Root, b: Root): boolean {
  if (a.k !== b.k) return false;
  return polyEq(a.minpoly, b.minpoly, INT_RING);
}

// -----------------------------------------------------------------------------
// canonicalIntegerForm — ℚ[v] → primitive ℤ[v] with positive leading coef
// -----------------------------------------------------------------------------

/**
 * Convert a polynomial in `ℚ[v]` to its canonical integer form:
 * clear denominators by LCM, strip integer content by GCD, sign-flip
 * if leading coefficient is negative. The output has integer
 * coefficients with `gcd = 1` and positive leading coefficient — the
 * canonical-form invariants required for the `Root` minpoly.
 *
 * Note that `factorRatQ` already returns *monic* factors over ℚ, so
 * for the construction-pipeline use of this helper the leading
 * coefficient is always `+1` over ℚ; after denominator-clear and
 * content-strip the leading coefficient is automatically positive
 * (it equals the LCM divided by the GCD of integerised coefficients,
 * both positive). The sign-flip step is a defensive no-op there but
 * is correct for arbitrary inputs (e.g. tests building polynomials
 * directly).
 */
export function canonicalIntegerForm(g: Poly<Rat>, v: string): Poly<bigint> {
  if (polyIsZero(g)) throw new Error("canonicalIntegerForm: input is zero");
  const d = polyDegInVar(g, v);
  if (d < 0) throw new Error("canonicalIntegerForm: input is zero");
  if (d === 0) {
    // Constant input — `Root` cannot name a root of a constant.
    throw new Error("canonicalIntegerForm: input is constant (degree 0)");
  }

  // Pull out the low-to-high coefficient list as Rats.
  const coeffPolys = polyCoeffsInVar(g, v, RAT_RING);
  const coeffs: Rat[] = coeffPolys.map((c) => {
    const cv = polyConstValue(c, RAT_RING);
    if (cv === null) {
      throw new Error(
        "canonicalIntegerForm: coefficient is non-constant — input mentions a second variable",
      );
    }
    return cv;
  });

  // Step 1 — clear denominators by LCM.
  let lcm: bigint = 1n;
  for (const c of coeffs) {
    if (c.d <= 0n) {
      throw new Error("canonicalIntegerForm: malformed Rat (non-positive denominator)");
    }
    lcm = lcmBig(lcm, c.d);
  }
  const intCoefs: bigint[] = coeffs.map((c) => c.n * (lcm / c.d));

  // Step 2 — strip content by GCD of |coeffs|.
  let g0: bigint = 0n;
  for (const k of intCoefs) g0 = gcdBig(g0, absBig(k));
  if (g0 === 0n) {
    // Every coefficient is zero — but degree check above ensures degree ≥ 1.
    throw new Error("canonicalIntegerForm: zero polynomial after denom-clear");
  }
  let primCoefs: bigint[] = intCoefs.map((k) => k / g0);

  // Step 3 — sign-fix leading coefficient.
  const lc = primCoefs[primCoefs.length - 1]!;
  if (lc < 0n) {
    primCoefs = primCoefs.map((k) => -k);
  }

  // Build a Poly<bigint> from the low-to-high coefficient list. Drop
  // zero coefficients per polyFromCoeffsInVar's contract; nonzero
  // entries become a single-monomial Poly<bigint>.
  const coefPolys: Poly<bigint>[] = primCoefs.map((k) =>
    k === 0n ? { terms: [] } : { terms: [{ exp: [], coef: k }] },
  );
  return polyFromCoeffsInVar(coefPolys, v, INT_RING);
}

// -----------------------------------------------------------------------------
// Helpers (rat arithmetic and BigInt utilities — local because the
// ones in real-roots/cas-core that we'd want are not exported)
// -----------------------------------------------------------------------------

/**
 * Convert a `Poly<bigint>` to a high-to-low `Rat` coefficient array
 * suitable for `isolateRealRoots`. The conversion is structural —
 * we lift each integer coefficient to a `Rat`-with-denominator-1.
 */
export function polyToHighToLowRat(p: Poly<bigint>, v: string): Rat[] {
  const coeffPolys = polyCoeffsInVar(p, v, INT_RING);
  // coeffPolys is low-to-high; reverse for high-to-low.
  const out: Rat[] = [];
  for (let i = coeffPolys.length - 1; i >= 0; i--) {
    const c = polyConstValue(coeffPolys[i]!, INT_RING);
    out.push(makeRat(c ?? 0n, 1n));
  }
  return out;
}

/**
 * Decide whether the unique root of `g` named by VAS interval `vas`
 * lies inside the closed hint interval `[hint.lo, hint.hi]`.
 *
 * The decision uses the sign criterion + the squarefree property of
 * irreducible factors: VAS guarantees `sign(g(vas.lo)) ≠ sign(g(vas.hi))`
 * for an open isolating interval (the interval brackets exactly one
 * root). Combined with sign at the hint endpoints, the position of
 * the root relative to the hint becomes a finite-case decision:
 *
 *   - If the VAS interval and the hint are disjoint → root is outside
 *     the hint.
 *   - If the VAS interval is fully contained in the hint → root is in
 *     the hint.
 *   - Otherwise (overlap-but-not-contained) we evaluate `g` at the
 *     overlapping hint boundary. If `g(hint.lo)` has the same sign as
 *     `g(vas.lo)`, the sign change has not happened yet at `hint.lo`,
 *     so the root is to the *right* of `hint.lo`. The mirror logic
 *     applies at `hint.hi`. If `g(hint.endpoint) = 0` exactly, the
 *     root *is* that endpoint and the inclusivity rule (closed hint)
 *     places it inside the hint.
 *
 * Singleton VAS intervals (rational roots) take a fast-path: the root
 * is `vas.lo == vas.hi`, and is in the hint iff `hint.lo ≤ root ≤ hint.hi`.
 */
function rootInHint(
  g: Poly<bigint>,
  vas: RealInterval,
  hint: RatInterval,
  v: string,
): boolean {
  // Singleton (rational root): VAS emits `(r, r)` with `g(r) = 0`.
  if (ratCompare(vas.lo, vas.hi) === 0) {
    const r = vas.lo;
    return ratCompare(hint.lo, r) <= 0 && ratCompare(r, hint.hi) <= 0;
  }

  // Disjoint: VAS interval entirely left or entirely right of hint.
  if (ratCompare(vas.hi, hint.lo) < 0) return false;
  if (ratCompare(vas.lo, hint.hi) > 0) return false;

  // VAS fully contained in hint: root in (vas.lo, vas.hi) ⊆ hint.
  const vasInHintLo = ratCompare(hint.lo, vas.lo) <= 0;
  const vasInHintHi = ratCompare(vas.hi, hint.hi) <= 0;
  if (vasInHintLo && vasInHintHi) return true;

  // Overlap-but-not-contained — sign-criterion decision. Both VAS
  // endpoints have nonzero sign (root is interior), and they have
  // opposite signs by VAS construction.
  const sLo = signAtRat(g, vas.lo, v);   // -1 or +1; not 0
  // Check left side: is the root ≥ hint.lo?
  if (!vasInHintLo) {
    // hint.lo lies strictly inside (vas.lo, vas.hi). Evaluate g(hint.lo).
    const sHintLo = signAtRat(g, hint.lo, v);
    if (sHintLo === 0) {
      // Root is exactly at hint.lo. Closed hint includes it ⇒ in hint
      // (subject to the right-side check below).
    } else if (sHintLo === sLo) {
      // Sign hasn't changed yet at hint.lo: root is to the right of
      // hint.lo. Continue to right-side check.
    } else {
      // Sign already changed by hint.lo: root is to the left, outside.
      return false;
    }
  }
  // Check right side: is the root ≤ hint.hi?
  if (!vasInHintHi) {
    // hint.hi lies strictly inside (vas.lo, vas.hi). Evaluate g(hint.hi).
    const sHintHi = signAtRat(g, hint.hi, v);
    const sHi = -sLo;     // opposite of sLo by VAS
    if (sHintHi === 0) {
      // Root is exactly at hint.hi. Closed hint includes it.
    } else if (sHintHi === sHi) {
      // Sign already changed by hint.hi: root is to the left, in hint.
    } else {
      // Sign hasn't changed yet at hint.hi: root is to the right of hint.
      return false;
    }
  }
  return true;
}

/**
 * Sign of `g(r)` for `r ∈ ℚ` and `g ∈ ℤ[v]`. Computed exactly via
 * BigInt Horner: `g(p/q) = N(p, q) / q^d` where `N(p, q) = c_d p^d
 * + c_{d-1} p^{d-1} q + … + c_0 q^d`. Since `q > 0`, the sign of
 * `g(p/q)` equals the sign of `N(p, q)`. We accumulate `N` directly
 * via the recurrence
 *
 *     h_0 = c_d                                (scaled by q^0)
 *     h_{k+1} = h_k · p + c_{d-k-1} · q^{k+1}  (scaled by q^{k+1})
 *
 * which lands at `h_d = N(p, q)` after `d` iterations.
 */
export function signAtRat(g: Poly<bigint>, r: Rat, v: string): -1 | 0 | 1 {
  if (polyIsZero(g)) return 0;
  const coeffPolys = polyCoeffsInVar(g, v, INT_RING);   // low-to-high
  const d = coeffPolys.length - 1;
  if (d < 0) return 0;
  const coeffs: bigint[] = coeffPolys.map(
    (c) => polyConstValue(c, INT_RING) ?? 0n,
  );

  const p = r.n;
  const q = r.d;
  let h: bigint = coeffs[d]!;
  let qPow: bigint = 1n;
  for (let i = d - 1; i >= 0; i--) {
    qPow *= q;
    h = h * p + coeffs[i]! * qPow;
  }
  return h === 0n ? 0 : h < 0n ? -1 : 1;
}

function ratCompare(a: Rat, b: Rat): number {
  // a/b - c/d = (a·d - b·c) / (b·d). Both denominators positive.
  const lhs = a.n * b.d;
  const rhs = b.n * a.d;
  if (lhs < rhs) return -1;
  if (lhs > rhs) return 1;
  return 0;
}

function ratStr(r: Rat): string {
  return r.d === 1n ? `${r.n}` : `${r.n}/${r.d}`;
}

function gcdBig(a: bigint, b: bigint): bigint {
  let aa = absBig(a);
  let bb = absBig(b);
  while (bb !== 0n) {
    const t = aa % bb;
    aa = bb;
    bb = t;
  }
  return aa;
}

function lcmBig(a: bigint, b: bigint): bigint {
  if (a === 0n || b === 0n) return 0n;
  return (absBig(a) / gcdBig(a, b)) * absBig(b);
}

function absBig(x: bigint): bigint {
  return x < 0n ? -x : x;
}

function describePoly(p: Poly<bigint>, v: string): string {
  // Compact ℤ[v] pretty-printer for error messages. Not canonical;
  // the comparison-grade form is the `Poly<bigint>` itself.
  const coeffPolys = polyCoeffsInVar(p, v, INT_RING);
  const parts: string[] = [];
  for (let i = coeffPolys.length - 1; i >= 0; i--) {
    const c = polyConstValue(coeffPolys[i]!, INT_RING) ?? 0n;
    if (c === 0n) continue;
    const sign = c < 0n ? "-" : parts.length === 0 ? "" : "+";
    const mag = absBig(c);
    const term =
      i === 0
        ? `${mag}`
        : i === 1
          ? mag === 1n
            ? `${v}`
            : `${mag}*${v}`
          : mag === 1n
            ? `${v}^${i}`
            : `${mag}*${v}^${i}`;
    parts.push(`${sign}${term}`);
  }
  return parts.join("");
}
