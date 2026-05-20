// =============================================================================
// @workbench/bigfloat — Pochhammer symbol  (a)_n  (rising factorial, arb-prec)
// =============================================================================
//
// This module ships the arb-prec real-axis entry point for the rising
// factorial / Pochhammer symbol:
//
//   bigPochhammer(a, n, prec)  —  (a)_n  =  a · (a+1) · (a+2) · … · (a+n−1)
//
// DLMF §5.2.4 defines the empty-product case `(a)_0 = 1` for *any* `a`
// (including the poles of Γ), and DLMF §5.2.5 records the closed form
// `(a)_n = Γ(a+n) / Γ(a)` valid whenever both Gammas are finite. The
// substrate uses both: the empty-product convention guards the n = 0
// branch, and the Gamma-ratio identity is the algorithmic engine of the
// large-`n` / non-integer-`n` path.
//
// ADR-0042 §"Decision 3" pins the per-head signature `(a, n, prec) →
// BigFloat`; R2 §1.6 and §2.9 pin the algorithm dispatch; PHASE2 §I3b
// (lines 827-874) pins the LOC budget and test plan. ADR-0020 governs
// the determinism contract: pure-BigInt arithmetic → bit-identical across
// runtimes forever at fixed `prec`.
//
// Two-path dispatch (R2 §1.6, §2.9)
// ----------------------------------
//
// Pochhammer is the only special-function head in this family with a
// genuinely *cheap* fast path. For `n` a small non-negative integer, the
// direct product
//
//     (a)_n  =  Π_{k=0}^{n-1}  (a + k)
//
// is `n` BigFloat multiplies and `n` BigFloat adds, all at working
// precision `prec + 16` — bounded above by `O(n · M(prec))` where
// `M(prec)` is the BigInt-multiply cost (sub-quadratic for the BigInt
// runtimes Bun and Node both use). For `n ≤ 20` at `prec = 200` this
// pays roughly 20 multiplies; the Gamma-ratio path pays two `lgamma`
// evaluations each at `O(prec · ?·M(prec))` — concretely R2 §2.9
// estimates `lgamma ≈ 50·M(prec)`, so the crossover sits at `n ≈ 100`
// in the abstract complexity model. We pick the considerably more
// conservative threshold `n_direct = 20` because the direct product
// also (a) keeps the exact-integer fast cases byte-exact via `fromInt`
// (so `(1)_n = n!` to all bits, not just to `prec − ε` bits), and
// (b) sidesteps the lgamma reflection branch entirely when `a` is in
// the negative-non-integer regime — the direct path's sign emerges
// from the product itself, no algebraic-sign bookkeeping required.
//
// The other path — Gamma-ratio via `lgamma`:
//
//     (a)_n  =  exp(lgamma(a + n) − lgamma(a))   with sign tracking
//
// — is used when `n` is non-integer (the direct product is undefined
// in that case; rising factorial extends to real `n` only through the
// Gamma representation) or when `n` is integer but ≥ `n_direct`. The
// sign machinery is *byte-identical to `bigBeta`*'s — same
// `algebraicGammaSign` classification, same `(−1)^m · sgn(ζ)` reading
// off `m = round(x)`, same `lossBits` accounting absorbed into the
// working precision. We do not factor out a shared helper because
// (CLAUDE.md Rule 10: literate exposition over premature abstraction)
// each special-function head documents its own sign discipline in
// place; the parallel structure is the documentation.
//
// Cancellation zeros at non-positive integer `a` (R2 §2.9, §3.5)
// ---------------------------------------------------------------
//
// A negative integer argument `a = −m` with `m ∈ {0, 1, 2, …}` is the
// fascinating case. By the direct-product definition,
//
//     (−m)_n  =  (−m)(−m+1)(−m+2) … (−m+n−1)
//
// and one of those factors is `(−m + m) = 0` whenever `n > m`. The
// product collapses to *exactly zero* — not "underflows to zero", but
// vanishes by an algebraic factor. This is the "polynomial truncation"
// regime that makes `(−m)_n` show up in finite-degree-polynomial
// hypergeometric closed forms: `₂F₁(−m, b; c; z)` is a polynomial of
// degree `m` in `z` precisely because the `(−m)_k / k!` factor zeroes
// the series past `k = m`. The Gamma-ratio formula `Γ(a+n)/Γ(a)` is
// a `∞ / ∞` indeterminate form here (both Gammas hit poles); only
// the direct product gives the right answer at the boundary.
//
// We therefore special-case the "a is a non-positive integer, n > -a"
// branch *before* dispatching: the answer is exactly zero, no work
// needed. Detecting this is the same `m = round(a) ∧ isZero(a − m)`
// pattern the rest of the family uses. The cleaner statement is
// "if `a + k = 0` for some integer `k ∈ [0, n)`, return 0" — but
// because `a` and the integer `k` are involved, the condition is
// "round(a) is a non-positive integer (call it −m), 0 ≤ m ≤ n−1, and
// the fractional part of `a` is exactly zero". When all three hold,
// return `0` exactly at the requested `prec`.
//
// For positive non-integer `a` near a negative integer (a + k ≈ 0 in
// the interior), there is *no* exact-zero — the product is small but
// nonzero — and R2 §3.5 flags the cancellation risk. We follow §3.5's
// recommendation: if the direct-product path is selected and the
// interval `[a, a+n)` straddles a negative integer (i.e. `floor(a) +
// n > 0 > floor(a)`), route through the Gamma-ratio path even when
// `n ≤ n_direct`. The Gamma-ratio's `lgammaRealAbs` absorbs the
// cancellation via `lossBits` exactly as it does in `bigBeta`.
//
// Negative `n` (the v0.2 deferral)
// --------------------------------
//
// `(a)_{−n}` for positive `n` is defined by `1 / ((a−1)(a−2)…(a−n))`
// (DLMF §5.2.5; it's the *reciprocal* rising factorial, equivalent to
// `Γ(a−n)/Γ(a)`). The substrate could implement it as the obvious
// reciprocal product, but the v0.1 scope (PHASE2 §I3b) does not include
// it — no consumer in the Gamma-family epic needs `(a)_{−n}`, and
// shipping it would force us to commit to a sign convention for the
// `a` near a non-positive integer / `n` "crosses a pole" interactions
// that DLMF treats separately. We throw a clear `RangeError` pointing
// at the v0.2 scope, mirroring `bigBeta`'s treatment of its own v0.2
// deferrals.
//
// Working precision (R2 §1.6, §3.5)
// ----------------------------------
//
// Direct-product path: `work = prec + 16`. The product accumulates at
// most `log₂ n + log₂(|a| + n)` bits of magnitude growth across `n`
// steps; 16 extra bits absorb the final-normalise round-half-to-even
// across that growth comfortably for `n ≤ 20`. Larger `n` would push
// us into the Gamma-ratio regime anyway.
//
// Gamma-ratio path: `work = prec + 32 + losses`, the same convention
// `bigBeta` uses. `losses` is the maximum `lgammaRealAbs` cancellation
// depth across `a` and `a + n`; it is `0` in the bulk regime and only
// fires when an argument is in the reflection regime near a negative
// integer (PHASE2 §I3a / R2 §3.4 pattern).
//
// Determinism contract
// --------------------
//
// `arbprec: true` (ADR-0020). Pure-BigInt arithmetic on both paths; the
// classification step uses `toFloat64(...).value` only for the cheap
// `m = round(...)` initial guess, then re-verifies on a fresh
// `sub(a, fromInt(BigInt(m), ...), ...)` at full precision. Same
// `(a, n, prec)` bytes → byte-identical output forever.
//
// Domain restrictions (v0.1)
// --------------------------
//
//   - Real arguments only on this entry. The complex extension is on
//     the ADR-0042 v0.2 roadmap as `cPochhammer`.
//   - Negative integer `n` throws (the reciprocal-rising-factorial
//     deferral; see above).
//   - Non-integer negative `n` throws — it would be `Γ(a+n)/Γ(a)`, the
//     same algorithm, but the v0.1 spec restricts `n ≥ 0` and we are
//     not surreptitiously broadening scope.
//   - Non-positive integer `a` with `n` integer ≥ |a| + 1 → returns 0
//     exactly (the polynomial-truncation regime; see above).
//   - Non-positive integer `a` with `n` integer ≤ |a| → routes through
//     the direct-product path (the empty-product or no-zero-factor case;
//     yields a finite signed result).
//
// References (all in repo)
// ------------------------
//   - docs/refs/gamma-research/R2-arbprec-algorithms.md §1.6, §2.9, §3.5
//   - docs/refs/gamma-research/PHASE2-impl-plans.md §I3b (lines 827-874)
//   - docs/adr/0042-gamma-family-per-head-substrate.md §Decision 3
//   - docs/adr/0020-arbitrary-precision-tier.md (determinism contract)
//   - DLMF §5.2.4 (definition), §5.2.5 (Γ-ratio identity)
//   - packages/bigfloat/src/special-funcs/beta.ts ("sister" sign-tracking
//     module; same `classifyForLgamma` pattern)

import { BigFloat, normalise, bitLength } from "../types.js";
import { isZero, sgn } from "../comparison.js";
import { add, sub, mul } from "../arithmetic.js";
import { fromInt, toFloat64 } from "../conversion.js";
import { exp } from "../transcendental.js";
import { lgamma } from "../special.js";

// =============================================================================
// Tuning constant
// =============================================================================

/**
 * Direct-product vs Gamma-ratio crossover for integer `n`.
 *
 * R2 §2.9's abstract-complexity crossover is `n ≈ 100`; the more
 * conservative choice `20` here additionally gives the
 * exact-integer-byte-exactness property: for `a` an integer / rational
 * with bounded denominator, the direct product is fully exact through
 * `n ≤ N_DIRECT` (no `lgamma` reflection-rounding in the path). The
 * value is wired into a single constant rather than a per-call argument
 * because (a) the only consumers we currently anticipate are
 * hypergeometric series with `n ≤ ~ prec/4` (rarely past a few dozen),
 * and (b) keeping it constant makes the cross-validation test (`n = 20`
 * direct vs `n = 20 + ε` Gamma-ratio) a meaningful regression check on
 * dispatch correctness.
 */
const N_DIRECT = 20;

// =============================================================================
// Helpers (verbatim parallel to beta.ts; deliberate code-duplication for
// literate per-module exposition — see top-of-file commentary)
// =============================================================================

/**
 * `log₂ |x|` to integer precision; returns `-Infinity` for `x = 0`. The
 * same helper appears in `beta.ts`, `incomplete-gamma.ts`, `erf.ts`, and
 * `special.ts`; reproduced locally so this module is self-contained
 * (CLAUDE.md Rule 10).
 */
function magBits(x: BigFloat): number {
  if (x.mantissa === 0n) return -Infinity;
  const m = x.mantissa < 0n ? -x.mantissa : x.mantissa;
  return x.exponent + bitLength(m);
}

/**
 * Classify an argument `x` for the `lgamma` reflection accounting.
 *
 * Returns:
 *   - `m = round(Re x)` — the nearest integer to `x`.
 *   - `isPole` — true iff `x` is exactly a non-positive integer (i.e.,
 *     `m ≤ 0` and `x − m == 0` to all bits).
 *   - `lossBits` — the cancellation depth `lgammaRealAbs` will incur on
 *     this argument. For `x > 0`, `lossBits = 0`. For `x < 0` non-integer,
 *     `lossBits = max(0, magBits(x) − magBits(x − m))`, the same formula
 *     `lgammaRealAbs` uses internally.
 *   - `gammaSign` — the algebraic sign of `Γ(x)`: `(−1)^m · sgn(ζ)` for
 *     `x < 0` non-integer, `+1` for `x > 0` (mirrors `gamma`'s
 *     sign-recovery at `special.ts:271-303`).
 *
 * This is the byte-identical helper from `beta.ts`. It is reproduced here
 * (not imported) because each special-function module is meant to be
 * read top-to-bottom; importing the helper would force a reader to
 * cross-reference `beta.ts` to understand how `bigPochhammer` handles
 * signs. The duplication is intentional and the test-suite asserts
 * value-equivalence (the crossover test pins direct ≡ Gamma-ratio via
 * the algebraic sign at `n = 20`).
 */
interface GammaClassification {
  m: number;
  isPole: boolean;
  lossBits: number;
  gammaSign: 1 | -1;
}

function classifyForLgamma(x: BigFloat): GammaClassification {
  const xFloat = toFloat64(x).value;
  if (!Number.isFinite(xFloat)) {
    throw new RangeError(
      `bigPochhammer: argument is not finite; cannot determine lgamma classification.`,
    );
  }
  const m = Math.round(xFloat);
  const zeta = sub(x, fromInt(BigInt(m), x.precision), x.precision);
  // Pole detection: only non-positive integers (m ≤ 0 with ζ = 0).
  if (m <= 0 && isZero(zeta)) {
    return { m, isPole: true, lossBits: 0, gammaSign: 1 };
  }
  if (sgn(x) > 0) {
    return { m, isPole: false, lossBits: 0, gammaSign: 1 };
  }
  // x < 0 non-integer. Cancellation depth and algebraic sign.
  const lossBits = m === 0 ? 0 : Math.max(0, magBits(x) - magBits(zeta));
  const zetaSgn = sgn(zeta);
  // sgn(Γ(x)) = (−1)^m · sgn(ζ). m % 2 === 0 covers m = 0 cleanly.
  const gammaSign: 1 | -1 = (m % 2 === 0 ? zetaSgn : -zetaSgn) as 1 | -1;
  return { m, isPole: false, lossBits, gammaSign };
}

/**
 * Try to read `n` as a non-negative integer (in the
 * non-negative-integer-only fast-path sense). Returns the integer if
 * `n` represents an exact non-negative integer ≥ 0 and ≤ 2^31; returns
 * `null` otherwise. The upper bound `2^31` is deliberately loose —
 * `N_DIRECT = 20` is what actually matters, but a caller could ask for
 * `(2)_30` and we still detect-as-integer correctly.
 *
 * Detection strategy: `normalise` strips low zero bits, so a BigFloat
 * built from `fromInt` has `mantissa · 2^exponent` integer-valued *by
 * construction*, but the canonical-form's `exponent` may still be
 * negative (the mantissa is left-padded to `precision` bits, with
 * `exponent = -(precision - bits(value)) ≤ 0`). The robust test is
 * not `exponent ≥ 0`; it is "the value is integer-valued",
 * computed by checking that `n − round(toFloat64(n))` is exactly zero
 * at `n`'s precision — the same `isZero(zeta)` discipline
 * `classifyForLgamma` uses, but specialised to "is this an integer?"
 * rather than "is this a Γ-pole?".
 *
 * Returns `null` for negative `n`, non-integer `n`, or any `n`
 * magnitude outside `[0, 2^31)`. The caller is then responsible for
 * the Gamma-ratio dispatch (or the negative-`n` throw).
 */
function tryIntegerN(n: BigFloat): number | null {
  if (n.mantissa === 0n) return 0;
  if (n.mantissa < 0n) return null;
  // Magnitude check via toFloat64.  Integers in `[0, 2^53)` are exactly
  // representable in float64; we want a tighter upper bound here to
  // catch silly inputs early.
  const asFloat = toFloat64(n).value;
  if (!Number.isFinite(asFloat) || asFloat < 0 || asFloat >= 2_147_483_648) {
    return null;
  }
  // Integer test: |n - round(asFloat)| must be exactly zero at n's
  // precision.  `Math.round` is exact for any float64 with magnitude
  // < 2^31, and `sub` followed by `isZero` is the canonical "exact
  // integer-valued" check across the rest of the substrate.
  const m = Math.round(asFloat);
  const zeta = sub(n, fromInt(BigInt(m), n.precision), n.precision);
  if (!isZero(zeta)) return null;
  return m;
}

// =============================================================================
// bigPochhammer — (a)_n via direct product or Gamma-ratio with sign
// =============================================================================

/**
 * Rising factorial / Pochhammer symbol `(a)_n` for real arguments.
 *
 * `(a)_n  =  a · (a+1) · (a+2) · … · (a+n−1)` for non-negative integer
 * `n` (DLMF §5.2.4), with the empty-product convention `(a)_0 = 1` for
 * any `a` (including poles of Γ). The definition extends to real `n`
 * via `(a)_n = Γ(a+n)/Γ(a)` (DLMF §5.2.5); this module ships both
 * paths and dispatches between them.
 *
 * Dispatch (R2 §1.6, §2.9; see top-of-file commentary):
 *
 *   - **n = 0**: short-circuit, return `1` exactly. Valid for ANY `a`,
 *     including poles, by the empty-product convention.
 *
 *   - **a a non-positive integer with `n > −round(a)` and `n` an
 *     integer**: short-circuit, return `0` exactly. The product passes
 *     through a literal zero factor at `a + k = 0` (the
 *     polynomial-truncation regime of `(−m)_n` for `n > m`).
 *
 *   - **n a non-negative integer ≤ `N_DIRECT` and `[a, a+n)` does NOT
 *     straddle a negative integer**: direct product
 *     `Π_{k=0}^{n-1} (a+k)` at `work = prec + 16`.
 *
 *   - **otherwise (n large, n non-integer, or zero-crossing risk)**:
 *     Gamma-ratio `sign · exp(lgamma(a+n) − lgamma(a))` at
 *     `work = prec + 32 + lossBits`, with the algebraic sign read from
 *     `(−1)^{m_a+m_{a+n}} · sgn(ζ_a · ζ_{a+n})` per the same
 *     classification helper `bigBeta` uses.
 *
 * Throws (loud `RangeError`):
 *
 *   - `n` is negative (reciprocal rising factorial; deferred to v0.2).
 *   - `n` is negative-non-integer (would compute as `Γ(a+n)/Γ(a)` but
 *     the v0.1 spec restricts `n ≥ 0`).
 *   - `n = 0` is short-circuited *before* pole detection on `a`, so
 *     `bigPochhammer(0, 0, prec) = 1` (the universal empty-product),
 *     not a throw. This is the DLMF §5.2.4 convention.
 *   - `a` and `a+n` are both poles of Γ but the polynomial-truncation
 *     short-circuit didn't fire (theoretically impossible given the
 *     short-circuit, kept as a defensive throw): the Gamma-ratio is
 *     `∞/∞` and the answer is not derivable from this surface.
 *   - `prec` not a positive integer; BigFloat arguments malformed.
 *
 * Closed-form values pinned by tests in `pochhammer.test.ts`:
 *
 *   (a)_0           = 1                            (any a; DLMF §5.2.4)
 *   (1)_n           = n!                           (positive integer n)
 *   (3/2)_3         = (3/2)(5/2)(7/2) = 105/8     (R2 §1.6 worked example)
 *   (−m)_n          = 0  for integer n > m ≥ 0    (polynomial truncation)
 *   (a)_{n+1}       = (a)_n · (a + n)             (recurrence; DLMF §5.2.4)
 */
export function bigPochhammer(
  a: BigFloat,
  n: BigFloat,
  prec: number,
): BigFloat {
  // -------------------------------------------------------------------
  // Input validation (CLAUDE.md Rule 1: fail loud with a suggestion).
  // -------------------------------------------------------------------
  if (prec < 1 || !Number.isInteger(prec)) {
    throw new RangeError(
      `bigPochhammer: prec must be a positive integer; got ${prec}. ` +
        `suggestion: use decimalToBinaryPrecision(<digits>) for a decimal target.`,
    );
  }
  for (const [name, v] of [
    ["a", a],
    ["n", n],
  ] as const) {
    if (!Number.isInteger(v.precision) || v.precision < 1) {
      throw new RangeError(
        `bigPochhammer: BigFloat ${name}.precision must be a positive integer; got ${v.precision}.`,
      );
    }
    if (!Number.isInteger(v.exponent) || !Number.isFinite(v.exponent)) {
      throw new RangeError(
        `bigPochhammer: BigFloat ${name}.exponent must be a finite integer; got ${v.exponent}.`,
      );
    }
  }

  // Negative `n` is the v0.2 deferral (reciprocal rising factorial). Throw
  // loud and point at PHASE2 §I3b.
  // MUTATION-PROOF: relaxing this to `sgn(n) < 0 && isZero(n)` (i.e., a
  // typo treating zero as negative) would route n = 0 into the throw and
  // break (a)_0 = 1 — the universal-empty-product test catches this.
  if (sgn(n) < 0) {
    throw new RangeError(
      `bigPochhammer: negative n is not supported in v0.1 ` +
        `(got n ≈ ${toFloat64(n).value}). The reciprocal rising factorial ` +
        `(a)_{-n} = 1 / ((a-1)(a-2)…(a-n)) = Γ(a-n)/Γ(a) is well-defined ` +
        `for non-pole a but is deferred to v0.2 per ` +
        `docs/refs/gamma-research/PHASE2-impl-plans.md §I3b. ` +
        `suggestion: file a v0.2 bead, or compute the reciprocal product ` +
        `manually if your n is a small positive integer.`,
    );
  }

  // -------------------------------------------------------------------
  // n = 0 short-circuit: (a)_0 = 1 for ANY a (DLMF §5.2.4 empty product).
  // This is unconditional — it must succeed even when a is a pole.
  // -------------------------------------------------------------------
  // MUTATION-PROOF: replacing this with `return fromInt(1n, prec)` *after*
  // a pole check on `a` would break `bigPochhammer(0, 0, prec) = 1`
  // (the universal empty-product convention). The test `(a)_0 = 1 for
  // a ∈ {0, -1, ..., 1, 2.7}` will go RED if pole-check precedes n=0.
  if (isZero(n)) {
    return fromInt(1n, prec);
  }

  // -------------------------------------------------------------------
  // Classify `a` for the polynomial-truncation short-circuit (a = −m,
  // integer; product passes through zero when n is integer ≥ m+1) and
  // for downstream sign tracking.
  // -------------------------------------------------------------------
  const cA = classifyForLgamma(a);
  const nAsInt = tryIntegerN(n);

  // Polynomial-truncation: a is a non-positive integer (a = -m for
  // m ≥ 0) and n is an integer such that the product range [a, a+n)
  // contains the zero factor a + m = 0. Equivalent condition:
  // nAsInt > -cA.m (with cA.m = -m, so -cA.m = m).
  // MUTATION-PROOF: changing the inequality to `nAsInt >= -cA.m` (off-
  // by-one too generous) would zero out (-3)_3 = (-3)(-2)(-1) = -6 —
  // the off-by-one is caught by the (-m)_m boundary tests, which assert
  // the NONZERO product just below the truncation.
  if (cA.isPole && nAsInt !== null && nAsInt > -cA.m) {
    return { mantissa: 0n, exponent: 0, precision: prec };
  }

  // -------------------------------------------------------------------
  // Direct-product path: n is a non-negative integer ≤ N_DIRECT.
  //
  // Routing nuance — three sub-cases of "a is negative" that matter:
  //
  //   (i)   a is a non-positive integer with n ≤ -a: the product is
  //         a sequence of negative integers stopping BEFORE the zero
  //         factor.  Direct product is the right answer (and the only
  //         answer — the Γ-ratio path can't handle this because
  //         Γ(a) is at a pole).  E.g., (-3)_3 = (-3)(-2)(-1) = -6.
  //   (ii)  a is negative NON-integer with floor(a) + n ≥ 0: the
  //         product range [a, a+n) straddles a negative integer.  No
  //         zero factor (a non-integer means a + k ≠ 0 for any integer
  //         k), but the product factor (a + k) is small in magnitude
  //         near the crossing, raising R2 §3.5 cancellation risk.
  //         Route through Γ-ratio to absorb cancellation via
  //         lgammaRealAbs's lossBits accounting.
  //   (iii) a > 0 (or a ≥ -n+1, i.e., the product stays in the same
  //         sign half-plane): no zero-crossing risk; direct product is
  //         straightforwardly correct and the fast path.
  //
  // For (i), going direct is REQUIRED — Γ-ratio would throw on the
  // a-pole.  For (ii), going Γ-ratio is REQUIRED for precision.  For
  // (iii), direct is preferred for speed and exactness.
  // -------------------------------------------------------------------
  if (nAsInt !== null && nAsInt <= N_DIRECT) {
    // Compute whether the product range straddles a negative integer
    // for non-integer negative a.  For integer-pole a, we know the
    // zero-factor check already passed (truncation didn't fire), so
    // n ≤ -cA.m and the product stays strictly negative — no
    // cancellation risk, direct product is exact.
    let crossesZero = false;
    if (sgn(a) < 0 && !cA.isPole) {
      const aFloat = toFloat64(a).value;
      const floorA = Math.floor(aFloat);
      // The product `a, a+1, …, a + n - 1` crosses zero when
      // floor(a) + n ≥ 0 (the last factor is ≥ 0 while the first is
      // < 0).  R2 §3.5 cancellation risk: a + k is small in magnitude
      // near the crossing, so we route through Γ-ratio to absorb it
      // via lgammaRealAbs's lossBits.
      if (floorA + nAsInt >= 0) {
        crossesZero = true;
      }
    }

    if (!crossesZero) {
      // Direct product Π_{k=0}^{n-1} (a + k) at work = prec + 16.
      // MUTATION-PROOF: dropping the `+ 16` (so work = prec) makes the
      // accumulator lose 1 bit per step on the recurrence test
      // (a)_{n+1} = (a)_n · (a + n) — the n=10 case for (2.7)_n
      // would fall below the prec - 4 bits agreement bar.
      const work = prec + 16;
      let acc = fromInt(1n, work);
      for (let k = 0; k < nAsInt; k++) {
        const factor = add(a, fromInt(BigInt(k), work), work);
        acc = mul(acc, factor, work);
      }
      return normalise(acc.mantissa, acc.exponent, prec);
    }
    // Fall through to Gamma-ratio path for zero-crossing risk.
  }

  // -------------------------------------------------------------------
  // Gamma-ratio path: (a)_n = sign · exp(lgamma(a+n) − lgamma(a)),
  // with sign = sgn(Γ(a+n)) / sgn(Γ(a)) = sgn(Γ(a+n)) · sgn(Γ(a))
  // (since 1/sgn = sgn for ±1). R2 §1.6, mirrors bigBeta.
  // -------------------------------------------------------------------
  // Build `a + n` at the input precision for classification first; the
  // working precision for the actual lgamma calls absorbs cancellation
  // bits measured below.
  const classPrec = Math.max(a.precision, n.precision);
  const aPlusN = add(a, n, classPrec);
  const cAN = classifyForLgamma(aPlusN);

  // Pole handling — these are exceptional cases the n = 0 short-circuit
  // and the polynomial-truncation short-circuit didn't catch:
  //
  //   - cA.isPole (a is a non-positive integer) but cAN is NOT a pole:
  //     the Γ-ratio Γ(a+n)/Γ(a) has `Γ(a) = ∞` in the denominator and
  //     finite `Γ(a+n)`, giving 0. This is a "limit-of-the-ratio is
  //     zero" case — algebraically the answer IS zero (it's the same
  //     ((-m)_n with non-integer n ≥ -a -m → small contribution from
  //     `Γ(a)` pole). For v0.1 we route this through the polynomial-
  //     truncation short-circuit when n is integer, and throw otherwise
  //     (real non-integer n with integer-pole a is an unusual ask).
  //
  //   - cAN.isPole (a+n is a non-positive integer) but cA is NOT a pole:
  //     Γ(a+n) = ∞ in the numerator. The Pochhammer is unbounded here.
  //
  //   - both poles: limit-of-ratio of two infinities; v0.2 territory.
  if (cA.isPole) {
    // n must be non-integer in this branch (integer n was handled by
    // the polynomial-truncation short-circuit). Honest refusal.
    throw new RangeError(
      `bigPochhammer: a is a non-positive integer (a≈${toFloat64(a).value}) ` +
        `but n is not integer (n≈${toFloat64(n).value}); ` +
        `Γ(a) has a pole and the limit (a)_n = lim_{a'→a} Γ(a'+n)/Γ(a') ` +
        `requires careful pole-residue handling deferred to v0.2 per ` +
        `docs/refs/gamma-research/PHASE2-impl-plans.md §I3b. ` +
        `suggestion: if you expect a polynomial-truncation zero, pass ` +
        `n as an exact integer; otherwise file a v0.2 bead.`,
    );
  }
  if (cAN.isPole) {
    throw new RangeError(
      `bigPochhammer: a + n is a non-positive integer ` +
        `(a+n≈${toFloat64(aPlusN).value}); Γ(a+n) has a pole and (a)_n ` +
        `is unbounded. ` +
        `suggestion: this regime is genuinely singular — check whether ` +
        `your caller intended a different convention (e.g. (a)_n as a ` +
        `coefficient that should be picked up from a residue formula).`,
    );
  }

  // Working precision bumped by the worst cancellation depth across the
  // two arguments. Matches the bigBeta convention (`prec + 32 +
  // losses`); see top-of-file "Working precision" section.
  const losses = Math.max(cA.lossBits, cAN.lossBits);
  const work = prec + 32 + losses;

  // Sign: sgn((a)_n) = sgn(Γ(a+n)) · sgn(Γ(a)) (the reciprocal Γ in the
  // denominator preserves sign; sgn(1/x) = sgn(x)).
  // MUTATION-PROOF: dropping one of the two factors (constant +1)
  // collapses the negative-a sign to whatever the other Gamma gives,
  // which breaks the (-2.5)_3 vs (-2.5)_4 sign prediction tests.
  const sign: 1 | -1 = (cA.gammaSign * cAN.gammaSign) as 1 | -1;

  // Magnitude path via log-space subtraction.
  const aPlusNAtWork = add(a, n, work);
  const lgA = lgamma(a, work);
  const lgAN = lgamma(aPlusNAtWork, work);
  // MUTATION-PROOF: swapping the subtraction order (lgA − lgAN) computes
  // Γ(a)/Γ(a+n) = (1/(a)_n), the reciprocal. The recurrence-identity
  // test (a)_{n+1} = (a)_n · (a + n) would go RED on every case.
  const logMag = sub(lgAN, lgA, work);
  const mag = exp(logMag, work);

  // Apply algebraic sign and normalise to caller-requested precision.
  const signed =
    sign === 1
      ? mag
      : { mantissa: -mag.mantissa, exponent: mag.exponent, precision: mag.precision };
  return normalise(signed.mantissa, signed.exponent, prec);
}
