// =============================================================================
// pattern.ts — pattern-condition predicates over the cas-core Value AST
// =============================================================================
//
// This module is the canonical home for *pure pattern-condition predicates*:
// total functions `(v: Value) => boolean` that classify a Value's
// number-theoretic shape (integer? positive integer? half-integer?) without
// any rewriting, simplification, or side effects. They exist to be plumbed
// into rule-table `match` closures in the per-head special-function
// identity modules (`src/special-funcs/erf-identities.ts`,
// `src/special-funcs/bessel-identities.ts`, future heads) so a single
// implementation of "is this Value a half-integer?" sits behind every rule
// that needs it.
//
// Why a dedicated module, not a kitchen-sink alongside diff.ts?
// ------------------------------------------------------------
// `diff.ts` ships `isZero` / `isOne` for *smart-constructor short-
// circuiting* — they exist primarily so `mkPlus([ZERO, x])` can fold to
// `x`. Their reach is the arithmetic ring of the AST. The predicates in
// THIS file have a different job: they are *pattern guards* in
// declarative rule tables. Specifically:
//
//   - `isPositiveInteger` is consulted by Bessel J/I-at-zero rules to
//     fire only when the order `n` is in `ℤ_{>0}` (DLMF §10.2 / §10.25),
//     never on a symbolic or fractional `ν`.
//   - `isNonNegativeInteger` is consulted by the spherical-Bessel rules
//     to fire only when `n ∈ ℤ_{≥0}` per DLMF §10.47 (which restricts
//     the order to non-negative integers; negative `n` is a *different*
//     function under a different convention).
//   - `isHalfInteger` is the load-bearing primitive for the half-
//     integer-closure rule family (R1 §16 priority-class C). The eight
//     closures `J_{1/2}(z) = √(2/(π z))·sin(z)`, `J_{-1/2}(z) =
//     √(2/(π z))·cos(z)`, and their Y/I/K-siblings, all gate on
//     `isHalfInteger(ν)`. The entire half-integer ladder rests on this
//     one predicate firing correctly on rationals shaped `(2k+1)/2`.
//
// Keeping these in `diff.ts` would conflate the smart-constructor and
// pattern-guard concerns and force every consumer of one to import the
// other transitively. The R1-discovered Bessel rule table (~30 rules
// across J/Y/I/K) will live in `src/special-funcs/bessel-identities.ts`
// and imports ONLY this module's predicates — not the diff substrate.
//
// Why three predicates, not one parametric helper?
// -------------------------------------------------
// R1 §14.2 lists a `isIntegerLiteralCondition(v, (n: bigint) => boolean)`
// generalisation that would subsume all three. We declined the
// generalisation for v0.1 because:
//
//   1. The three concrete shapes are the *only* shapes any current rule
//      needs. Adding a higher-order helper "in case" violates honest-
//      scope (CLAUDE.md Rule 8).
//   2. Rule-table call sites read as English with three named predicates
//      (`isHalfInteger(args[0])`); they read as Lisp with one
//      `isIntegerLiteralCondition(args[0], (n) => n >= 0n)`. The named
//      form is the documentation.
//   3. When the next head needs a fourth shape (e.g. `isOddInteger` for
//      a parity rule), it joins this file as a named predicate. The
//      generalisation can land later, drop-in compatible, when ≥ 5
//      callsites would simplify by collapsing.
//
// Domain coverage
// ---------------
// Every predicate accepts a Value and returns a boolean — total
// function, never throws, never returns `undefined`. Non-numeric Value
// kinds (`symbol`, `string`, `expression`, `list`, `record`, `tagged`,
// `boolean`, `float64`) return `false`. This matches the rule-table
// dispatcher's expectation: a match that doesn't apply returns `false`,
// never an exception (per CLAUDE.md Rule 1 — the predicate's CONTRACT
// is to classify shapes, not to validate input).
//
// `integer` and `rational` are the two number kinds the protocol's
// canonical encoding admits (PRD §0.1 — no raw JSON numbers; all
// numerics live inside `integer` / `rational` / `float64`). `float64`
// is intentionally NOT classified here: the pattern guards exist to
// fire on *exact* literal orders. A user passing `float64FromNumber(0.5)`
// has volunteered into the floating-point world and the symbolic
// simplifier must not pretend they meant the exact rational `1/2`.
// The `quadrature` substrate handles float64 inputs; the cas-core
// symbolic substrate does not.
//
// Canonical-vs-raw rationals
// --------------------------
// `RationalValue` is required by `validate.ts` to be in lowest terms
// with positive denominator. The `rat()` factory enforces this
// canonicalisation eagerly via GCD reduction and denominator-sign
// normalisation. So `rat(4n, 2n)` reduces to `{num:"2", den:"1"}` and
// — strictly per the validator — should round-trip as an integer.
// However, a Value produced by RAW LITERAL construction (e.g. tests,
// JSON-bridge inputs that bypass `rat()`) may not be canonical. The
// predicates in this file therefore reduce by GCD internally before
// classifying. This makes `isHalfInteger({kind:"rational", num:"4",
// den:"2"})` return `false` (= 2 reduced, an integer), `isHalfInteger(
// {kind:"rational", num:"5", den:"2"})` return `true`, and
// `isHalfInteger({kind:"rational", num:"6", den:"4"})` return `false`
// (= 3/2 in raw form, but the predicate reduces to 3/2 and... wait,
// 3/2 IS half-integer). The contract is "would this Value, after
// reduction to lowest terms, satisfy the predicate?" — the
// mathematical reading, not the literal-bytes reading.
//
// BigInt arithmetic throughout
// ----------------------------
// Numerators and denominators are arbitrary-size by protocol
// (`packages/protocol/src/kinds.ts` stores them as `string`). We parse
// with `BigInt(...)` and compare in BigInt space, never lifting to
// `Number`. A 1000-digit numerator inside `isHalfInteger` is handled
// without loss of precision. The cost is negligible — these predicates
// run inside rule-table `match` closures called once per rewriter
// dispatch, not in inner loops.
//
// References
// ----------
// * `docs/refs/besselj-research/R1-symbolic-identities.md` §14
//   ("Pattern-primitive gaps — Discovery B") — the literature
//   justification for these three primitives.
// * `docs/adr/0041-bessel-family-per-head-substrate.md` §Decision 6 —
//   the architectural pin: `packages/cas-core/src/pattern.ts` extends
//   with `isPositiveInteger`, `isNonNegativeInteger`, `isHalfInteger`.
//   `isNonPositiveInteger` joins the family for the Gamma-family pole-
//   refusal rules (Phase 2 I4, bead `scientist-workbench-h37z`): Γ, LogGamma,
//   Digamma all have simple poles at the non-positive integers
//   `{0, -1, -2, …}` and the identity rules must refuse to fire there
//   with a `tagged "<head>/pole"` rather than emitting a divergent
//   answer. The predicate joins as a named member by the same Rule 8 /
//   honest-scope argument that motivated the original three.
// * `packages/cas-core/src/special-funcs/erf-identities.ts` — the
//   styling exemplar; per-head pattern predicates currently live there
//   (`isZeroLiteral`, `isPosInfinity`, etc.) and are bespoke. Future
//   refactor opportunity (R1 §14.2): promote those to this module too.
// * `packages/protocol/src/kinds.ts` — `IntegerValue` / `RationalValue`
//   shape definitions. `validate.ts` enforces canonical form on the
//   wire; the helpers here also tolerate raw-literal (non-canonical)
//   forms.

import type { Value } from "@workbench/protocol";

// -----------------------------------------------------------------------------
// Internal helpers
// -----------------------------------------------------------------------------

/**
 * Parse an `IntegerValue` field to a `BigInt`. The protocol validator
 * (`packages/protocol/src/validate.ts:checkInt`) guarantees the string
 * matches `/^-?(0|[1-9][0-9]*)$/` for validated values; this helper
 * relies on `BigInt`'s built-in parser which accepts the same form
 * (and a superset including leading `+`, which the predicates do not
 * accept because the validator rejects it — we never see such strings
 * from validated Values, and if a raw literal slips through, we let
 * `BigInt` throw and the predicate returns `false` via the surrounding
 * `try` ... but we deliberately do NOT catch here. A malformed integer
 * literal in a Value is a programmer error upstream of the simplifier;
 * crashing with context (CLAUDE.md Rule 1) beats silently classifying
 * `"+3"` as "not a positive integer" when the user clearly meant +3).
 */
function bigintOfIntegerValueField(s: string): bigint {
  return BigInt(s);
}

/**
 * Reduce a raw rational `(num, den)` (as BigInts, with `den > 0`) to
 * lowest terms. Returns `[reducedNum, reducedDen]`. The protocol's
 * `rat()` factory already does this, but a Value constructed via raw
 * literal (e.g. `{kind:"rational", num:"4", den:"2"}`) may not be
 * reduced; we reduce internally so `isHalfInteger` classifies on the
 * mathematical value, not the literal bytes.
 *
 * Precondition: `den > 0n`. The caller (`normalizeRational`) handles
 * the sign-flip when the raw `den` is negative.
 */
function reduceFraction(num: bigint, den: bigint): [bigint, bigint] {
  // Euclidean GCD on absolute values; sign stays with the numerator.
  let a = num < 0n ? -num : num;
  let b = den;
  while (b !== 0n) {
    const t = b;
    b = a % b;
    a = t;
  }
  // `a` is gcd(|num|, den) ≥ 1 (since den > 0); division is exact.
  return [num / a, den / a];
}

/**
 * Normalise a `RationalValue` to the canonical `(num, den)` pair as
 * BigInts: `den > 0`, in lowest terms. Returns `null` if the rational
 * is structurally degenerate (`den = 0n`) — the predicates treat
 * degenerate rationals as "not an integer / not a half-integer" rather
 * than throwing, because the predicate contract is total. Validated
 * Values never trigger this branch (the validator rejects `den = 0`);
 * raw-literal Values might.
 */
function normalizeRational(v: { num: string; den: string }): [bigint, bigint] | null {
  let num = BigInt(v.num);
  let den = BigInt(v.den);
  if (den === 0n) return null;
  if (den < 0n) {
    num = -num;
    den = -den;
  }
  return reduceFraction(num, den);
}

// -----------------------------------------------------------------------------
// Public predicates
// -----------------------------------------------------------------------------

/**
 * isPositiveInteger — true iff `v` encodes the exact integer `n` with
 * `n ≥ 1`.
 *
 * Accepts:
 *   - `IntegerValue` with `value > 0` (e.g. `int(1n)`, `int(42n)`).
 *   - `RationalValue` that reduces to an integer `> 0` (e.g.
 *     `{kind:"rational", num:"6", den:"3"}` reduces to `2/1` — a
 *     positive integer; returns `true`).
 *
 * Rejects (returns `false`):
 *   - Zero (`int(0n)`); the boundary is `≥ 1`, not `≥ 0`. Use
 *     `isNonNegativeInteger` if zero should pass.
 *   - Negative integers (`int(-1n)`, `int(-42n)`).
 *   - Non-integer rationals (`rat(3n, 2n)`).
 *   - `float64`, `symbol`, `string`, `expression`, `list`, `record`,
 *     `tagged`, `boolean`.
 *
 * Used by:
 *   - Bessel J / I "order at zero argument" rules: `J_n(0) = 0` for
 *     `n ∈ ℤ_{>0}` (DLMF §10.2.4). The rule must NOT fire on
 *     `J_0(0) = 1` (handled by a separate rule) and must NOT fire on
 *     symbolic ν.
 *   - Future parity-class rules that require strict positivity (e.g.
 *     "the inverse `1/n!` term in a series is well-defined only for
 *     `n ≥ 1`").
 *
 * Examples:
 *   isPositiveInteger(int(1n))           // true
 *   isPositiveInteger(int(0n))           // false (zero is not positive)
 *   isPositiveInteger(int(-3n))          // false
 *   isPositiveInteger(rat(6n, 3n))       // true  (= 2)
 *   isPositiveInteger(rat(3n, 2n))       // false (= 3/2)
 *   isPositiveInteger(sym("n"))          // false (symbolic)
 */
export function isPositiveInteger(v: Value): boolean {
  if (v.kind === "integer") {
    return bigintOfIntegerValueField(v.value) > 0n;
  }
  if (v.kind === "rational") {
    const reduced = normalizeRational(v);
    if (reduced === null) return false;
    const [num, den] = reduced;
    return den === 1n && num > 0n;
  }
  return false;
}

/**
 * isNonNegativeInteger — true iff `v` encodes the exact integer `n`
 * with `n ≥ 0`.
 *
 * Accepts:
 *   - `IntegerValue` with `value ≥ 0` (e.g. `int(0n)`, `int(1n)`,
 *     `int(42n)`).
 *   - `RationalValue` that reduces to an integer `≥ 0` (e.g.
 *     `{kind:"rational", num:"0", den:"5"}` reduces to `0/1`; returns
 *     `true`).
 *
 * Rejects (returns `false`):
 *   - Negative integers (`int(-1n)`).
 *   - Non-integer rationals (`rat(3n, 2n)`).
 *   - `float64`, `symbol`, `string`, `expression`, `list`, `record`,
 *     `tagged`, `boolean`.
 *
 * Used by:
 *   - Spherical-Bessel rules: DLMF §10.47.3 restricts the order `n`
 *     to `ℤ_{≥0}` for `j_n(z)` and `y_n(z)`. Any rewrite that emits a
 *     spherical-Bessel head MUST guard the order parameter through this
 *     predicate; otherwise the rewrite is unsound for the negative-
 *     integer or half-integer cases (which call for different
 *     functions or different closures).
 *   - Series-truncation rules where the upper bound is `n ∈ ℤ_{≥0}`
 *     (an empty product / sum at `n = 0` is well-defined; the rule
 *     should fire there).
 *
 * Examples:
 *   isNonNegativeInteger(int(0n))         // true (zero is non-negative)
 *   isNonNegativeInteger(int(1n))         // true
 *   isNonNegativeInteger(int(-1n))        // false
 *   isNonNegativeInteger(rat(0n, 5n))     // true (= 0)
 *   isNonNegativeInteger(rat(7n, 2n))     // false (= 7/2)
 *   isNonNegativeInteger(sym("n"))        // false (symbolic)
 */
export function isNonNegativeInteger(v: Value): boolean {
  if (v.kind === "integer") {
    return bigintOfIntegerValueField(v.value) >= 0n;
  }
  if (v.kind === "rational") {
    const reduced = normalizeRational(v);
    if (reduced === null) return false;
    const [num, den] = reduced;
    return den === 1n && num >= 0n;
  }
  return false;
}

/**
 * isNonPositiveInteger — true iff `v` encodes the exact integer `n`
 * with `n ≤ 0`.
 *
 * The "dual" of `isNonNegativeInteger`. The boundary is `≤ 0`, which
 * includes zero: zero is both non-negative and non-positive (it is the
 * shared boundary of the two half-lines). The two predicates therefore
 * are NOT a partition — they overlap on `{0}` and together cover the
 * integers without leaving a hole.
 *
 * Accepts:
 *   - `IntegerValue` with `value ≤ 0` (e.g. `int(0n)`, `int(-1n)`,
 *     `int(-42n)`).
 *   - `RationalValue` that reduces to an integer `≤ 0` (e.g.
 *     `{kind:"rational", num:"-4", den:"2"}` reduces to `-2/1`;
 *     returns `true`).
 *
 * Rejects (returns `false`):
 *   - Positive integers (`int(1n)`, `int(42n)`).
 *   - Non-integer rationals (`rat(-1n, 2n)` → `-1/2` is not an exact
 *     integer; returns `false`).
 *   - `float64` — even `float64FromNumber(0.0)` and
 *     `float64FromNumber(-3.0)` return `false`. Exact-integer-ness is
 *     by Value KIND, not by representable equality: a user who passed
 *     `float64(0.0)` opted into the floating-point world and the
 *     symbolic pole-refusal rule must NOT fire (the user might have
 *     meant `0.0 + ε`).
 *   - `symbol`, `string`, `expression`, `list`, `record`, `tagged`,
 *     `boolean`.
 *
 * Used by (LOAD-BEARING — the gamma-identities module does not ship
 * without this predicate):
 *   - Γ(n) at `n ∈ {0, -1, -2, …}`: simple poles. Phase 2 I4 rule
 *     refuses to fire with `tagged "gamma/pole"`.
 *   - LogGamma(n) at the same locations: simple log-poles. Phase 2 I4
 *     rule refuses with `tagged "loggamma/pole"`.
 *   - Digamma ψ(n) at the same locations: simple poles. Phase 2 I4
 *     rule refuses with `tagged "digamma/pole"`.
 *   - Polygamma ψ^{(m)}(n) at the same locations for m ≥ 1: poles of
 *     order m+1. Phase 2 I4 rule refuses with
 *     `tagged "polygamma/pole"`.
 *
 * Mirrors `isPositiveInteger` / `isNonNegativeInteger` / `isHalfInteger`
 * exactly: BigInt arithmetic on the canonical reduced form; accepts
 * both `integer` and reduced `rational` Value kinds; the rational path
 * reduces by GCD internally so raw non-canonical literals (e.g.
 * `{kind:"rational", num:"-4", den:"2"}`) classify on the mathematical
 * value, not the literal bytes.
 *
 * Examples:
 *   isNonPositiveInteger(int(0n))                                  // true   (0 is non-positive)
 *   isNonPositiveInteger(int(-3n))                                 // true
 *   isNonPositiveInteger(int(1n))                                  // false
 *   isNonPositiveInteger(rat(-4n, 2n))                             // true   (reduces to -2)
 *   isNonPositiveInteger(rat(-1n, 2n))                             // false  (= -1/2 not integer)
 *   isNonPositiveInteger(sym("n"))                                 // false
 *   isNonPositiveInteger(float64FromNumber(0))                     // false  (float64, not exact)
 */
export function isNonPositiveInteger(v: Value): boolean {
  if (v.kind === "integer") {
    return bigintOfIntegerValueField(v.value) <= 0n;
  }
  if (v.kind === "rational") {
    const reduced = normalizeRational(v);
    if (reduced === null) return false;
    const [num, den] = reduced;
    return den === 1n && num <= 0n;
  }
  return false;
}

/**
 * isHalfInteger — true iff `v` encodes a half-integer, i.e. a number
 * of the form `n + 1/2` for some integer `n` (positive, negative, or
 * zero). Equivalently: a rational `p / q` whose reduced form has
 * `q = 2` and odd `p`.
 *
 * Accepts:
 *   - `RationalValue` that reduces to `(odd)/2`. Both positive
 *     (`rat(1n, 2n)`, `rat(7n, 2n)`) and negative (`rat(-1n, 2n)`,
 *     `rat(-5n, 2n)`) half-integers qualify. Raw non-reduced forms
 *     (`{kind:"rational", num:"6", den:"4"}` = `3/2`) are reduced
 *     before classifying — this case returns `true`.
 *
 * Rejects (returns `false`):
 *   - Integers (`int(3n)`). An integer is `n + 0`, not `n + 1/2`.
 *     This is the subtle one: `{kind:"rational", num:"4", den:"2"}`
 *     reduces to `2/1` — an integer, NOT a half-integer; returns
 *     `false`. The mutation-prove test specifically guards this.
 *   - Rationals with reduced denominator ≠ 2 (`rat(5n, 3n)` →
 *     `false`; `rat(1n, 4n)` → `false`).
 *   - `float64`, `symbol`, `string`, `expression`, `list`, `record`,
 *     `tagged`, `boolean`.
 *
 * Used by (LOAD-BEARING — none of these ship without this predicate):
 *   - The eight half-integer-closure rules in
 *     `src/special-funcs/bessel-identities.ts` (R1 §16 priority-class
 *     C, ADR-0041 §Decision 6). Examples:
 *       J_{1/2}(z)  = √(2/(π z)) · sin(z)
 *       J_{-1/2}(z) = √(2/(π z)) · cos(z)
 *       Y_{1/2}(z)  = -√(2/(π z)) · cos(z)
 *       I_{1/2}(z)  = √(2/(π z)) · sinh(z)
 *       K_{1/2}(z)  = √(π/(2 z)) · e^{-z}
 *     plus four siblings. Each rule's `match` closure invokes
 *     `isHalfInteger(args[0])` to gate the rewrite on the order
 *     parameter; firing on a non-half-integer ν would produce a
 *     wrong-shaped answer (CLAUDE.md Rule 8 — honest scope).
 *   - The bridge between `BesselJ_{n+1/2}` and `SphericalBesselJ_n`
 *     (DLMF §10.47.3): `j_n(z) = √(π/(2z)) · J_{n+1/2}(z)`. A rewrite
 *     in the J → spherical-J direction guards `isHalfInteger(ν)` (and
 *     additionally `isNonNegativeInteger((ν - 1/2))`).
 *
 * Examples:
 *   isHalfInteger(rat(1n, 2n))            // true   (= 1/2)
 *   isHalfInteger(rat(7n, 2n))            // true   (= 7/2)
 *   isHalfInteger(rat(-3n, 2n))           // true   (= -3/2)
 *   isHalfInteger(rat(0n, 2n))            // false  (= 0, an integer)
 *   isHalfInteger(rat(4n, 2n))            // false  (= 2, an integer)
 *   isHalfInteger(rat(5n, 3n))            // false  (denominator 3, not 2)
 *   isHalfInteger(int(3n))                // false  (an integer)
 *   isHalfInteger(sym("nu"))              // false  (symbolic)
 */
export function isHalfInteger(v: Value): boolean {
  if (v.kind !== "rational") return false;
  const reduced = normalizeRational(v);
  if (reduced === null) return false;
  const [num, den] = reduced;
  // After reduction, half-integers are exactly `(odd)/2`. Note: in
  // lowest terms, `den = 2` already implies `num` is odd (gcd(num, 2)
  // = 1 means `num` is not divisible by 2). The explicit oddness check
  // is therefore redundant given a correct reduction step — but it
  // costs nothing and documents the invariant for the reader; the
  // belt-and-braces shape also self-tests the reducer in mutation-
  // prove drills (perturb the reducer, this check catches the slip).
  if (den !== 2n) return false;
  // Odd-num check; both `1n` (positive odd remainder) and `-1n`
  // (negative odd remainder) are odd. JavaScript's `%` preserves the
  // sign of the dividend for BigInt, so `(-5n) % 2n === -1n` and
  // `5n % 2n === 1n`. The test "remainder is not zero" captures both.
  return num % 2n !== 0n;
}
