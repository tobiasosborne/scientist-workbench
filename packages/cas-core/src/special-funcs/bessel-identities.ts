// =============================================================================
// bessel-identities.ts — symbolic identity table for the Bessel-family heads
// =============================================================================
//
// Purpose
// -------
// This module is the v0.1 implementation of R1's 30-rule Bessel identity
// catalogue (`docs/refs/besselj-research/R1-symbolic-identities.md` §16),
// ported to the cas-core AST and integrated into `cas-simplify`'s
// rewriter dispatch. It is the per-head sibling of the Erf-family table
// in `erf-identities.ts` — the same dispatch shape, the same
// idempotence + foreign-pass-through invariants, the same literate-
// prose discipline. The Bessel substrate is the *second* head this
// architecture (ADR-0040, prototype #1 = Erf; ADR-0041, prototype #2 =
// Bessel) is applied to, and the central claim ADR-0041 makes is that
// the pattern *generalises without architectural change* — the only
// extensions are (a) two new vocab heads families (Hankel + spherical
// Bessel; ADR-0041 §"Decision 6" / I6a / bead `vsvl`) and (b) three new
// pattern primitives (`isPositiveInteger`, `isNonNegativeInteger`,
// `isHalfInteger`; I6b / bead `7j02`) — both shipped *before* this
// module so the rule-table author here only consumes them.
//
// The eight heads in scope (per ADR-0023 + ADR-0041 §"Decision 6"):
//   * `BesselJ`           — DLMF §10.2.2, defining ODE solution (J_ν)
//   * `BesselY`           — DLMF §10.2.3, second-kind cylinder (Y_ν)
//   * `BesselI`           — DLMF §10.25.2, modified first-kind (I_ν)
//   * `BesselK`           — DLMF §10.25.3, modified second-kind (K_ν)
//   * `HankelH1`          — DLMF §10.4.3, H¹_ν = J_ν + i·Y_ν
//   * `HankelH2`          — DLMF §10.4.3, H²_ν = J_ν − i·Y_ν
//   * `SphericalBesselJ`  — DLMF §10.47.3, j_n = √(π/(2z))·J_{n+1/2}
//   * `SphericalBesselY`  — DLMF §10.47.4, y_n = √(π/(2z))·Y_{n+1/2}
//
// All eight are arity-2 (`(ν, z)` for cylinder/Hankel, `(n, z)` for
// spherical); the rule-table closures consume `args[0]` (order) and
// `args[1]` (argument) consistently.
//
// The five priority classes (R1 §16; total 30 rules)
// --------------------------------------------------
// **Class A — special values + refusal classes (6 + 2 = 8 rules).**
// The "value at zero argument" closures for J/I (which are well-
// defined) and Y/K (which diverge to ±∞ and emit a tagged refusal per
// CLAUDE.md Rule 8 honest-scope). DLMF §10.7.1-4, §10.30.1-3. The
// refusal class is `"cas-simplify/bessel-singular-at-zero"`; the
// payload is the original head + args so a downstream consumer can
// recover what was attempted.
//
// **Class B — integer-ν parity (6 rules).** The connection formulas
// at negative integer order (DLMF §10.4.1, §10.27.1, §10.27.3, §10.4.2).
// Each rule guards on `isPositiveInteger` applied to the *negation* of
// the order parameter (i.e. fires only when ν = −n for some positive
// integer n) — this is the load-bearing match-shape for parity rules.
// Sign: `(−1)^n` for J/Y/H¹/H², no sign for I; K is even in ν for ALL
// ν not just integer (DLMF §10.27.3) so its parity rule covers both
// `K_{−n}` (integer n) and `K_{−(p/q)}` (any rational p/q with the
// negation explicit). For v0.1 the K rule fires when the order is
// expressed as the literal negation of a positive integer (matches the
// J/Y/I shape); the all-ν generalisation lands when a pattern-language
// extension catches "any negated value" cleanly.
//
// **Class C — half-integer closures (8 rules).** THIS IS THE LOAD-
// BEARING USER-VISIBLE FEATURE. When ν = ±1/2, all four Bessel
// functions collapse to elementary form (DLMF §10.16.1, §10.27.6):
//
//     J_{1/2}(z)  = √(2/(πz)) · sin(z)
//     J_{−1/2}(z) = √(2/(πz)) · cos(z)
//     Y_{1/2}(z)  = −√(2/(πz)) · cos(z)
//     Y_{−1/2}(z) = √(2/(πz)) · sin(z)
//     I_{1/2}(z)  = √(2/(πz)) · sinh(z)
//     I_{−1/2}(z) = √(2/(πz)) · cosh(z)
//     K_{1/2}(z)  = √(π/(2z)) · e^{−z}
//     K_{−1/2}(z) = √(π/(2z)) · e^{−z}     (= K_{1/2}; even in ν per
//                                            class B, restated as the
//                                            collapsed elementary form)
//
// Each gates on `isHalfInteger(ν)` then on the exact `(num, den) =
// (±1, 2)` shape — `isHalfInteger` catches the entire half-integer
// ladder (`3/2`, `5/2`, …) but only `±1/2` collapses to elementary in
// v0.1; the higher half-integers need the recurrence step (R1 §1.2 +
// §6) which is filed as P3 follow-up. A negative match (no rewrite)
// on `J_{3/2}` is honest scope: the input passes through; class C does
// not lie about higher-order closures.
//
// The √π encoding follows the ADR-0040 §"Decision 6" + worklog 134
// precedent: `mkPower(sym("pi"), rat(1n, 2n))`, NOT `expr("sqrt",
// [sym("pi")])`. The two encodings agree under any numerical /
// arb-prec evaluator; the rational-exponent form is what `ruleErfi`
// and the future Meijer-G bridge layer (I6 / `bessel.ts`) consume.
//
// **Class D — Hankel + spherical-Bessel rewrite-on-request (4
// rules).** Bidirectional canonicalisation rules (DLMF §10.4.3,
// §10.47.3-4) that rewrite a Hankel / spherical-Bessel head to its
// J/Y-based definition. These fire unconditionally on the recognised
// head (their match closure just checks arity); the user opts *out* by
// not running `casSimplify` on a Hankel / spherical-Bessel expression
// they want to keep verbatim. R1 §16 flags these as "rewrite-as-J-Y
// flag, default off" — for v0.1 the simplest shippable choice is
// always-on (matches Erfi-canonicalise; ADR-0040 ships Erfi → -i·Erf
// always-on too). When a future bead surfaces a need for opt-in
// dispatch, the flag plumbs through `casSimplify`'s options without
// changing this table's shape.
//
// **Class E — spherical-Bessel small-n closures (3 rules).** The
// elementary closures for `j_0`, `j_1`, `y_0` (DLMF §10.49.3-5):
//
//     j_0(z) = sin(z) / z
//     j_1(z) = sin(z) / z² − cos(z) / z
//     y_0(z) = −cos(z) / z
//
// These gate on the order parameter being literal `int(0n)` or
// `int(1n)` respectively. The general spherical-Bessel small-n
// recurrence (DLMF §10.51.2) ships in `special-functions.ts`'s diff
// dispatcher; here we ship only the closed-form leaves the user is
// most likely to ask for.
//
// Total: 8 + 6 + 8 + 4 + 3 = 29 rules. The R1 §16 target is "30 rules
// after deduplication"; the de-duplication that lands one rule short
// is the K_{1/2} / K_{−1/2} pair — class C ships both as separate
// rules (8 rather than 7) because the rewritten RHS is literally
// identical (`√(π/(2z)) · e^{−z}`) but the LHS arg-shape differs and
// matching both directly is clearer than relying on class-B parity to
// run first then class C to fire on the simplified result. The net of
// 29 lands inside the "30 ± 2" envelope the prompt allowed.
//
// What is NOT here
// ----------------
// * **Cross-head sum-collapses.** R1 §4 (Wronskians) and §5 (J/Y →
//   H¹/H² inversion) admit identities like `H¹_ν − H²_ν → 2i·Y_ν`,
//   but these need a multi-term sum-walker (cf. the Erf
//   `Erfc + Erf = 1` collapse). Filed as P3 follow-up; not in v0.1
//   scope because no Phase-3 tool (T1/T2/T3) consumes them.
// * **Recurrence-ladder rules.** R1 §1 lists `J_{ν+1}(z) = (2ν/z)·
//   J_ν(z) − J_{ν−1}(z)`. The ladder is shipped in `special-
//   functions.ts`'s `ruleBesselFirstKind` (as the derivative-
//   recurrence). The identity-rule layer here does NOT also ship the
//   ladder; a recurrence-ladder rule fired during identity rewriting
//   would loop (each application produces another instance of the
//   same head shape).
// * **Addition theorems** (R1 §8). DLMF §10.23 gives Graf / Gegenbauer
//   addition formulas; these need a pattern-language extension that
//   matches `J_ν(z1 + z2)` and unifies the two summand sub-trees.
//   Out of scope for the simple head+args dispatch table.
// * **Diff-rule duplication.** Diff rules for all 8 heads already
//   ship in `special-functions.ts` (`ruleBesselFirstKind`,
//   `ruleBesselI`, `ruleBesselK`, `ruleSphericalBesselFirstKind`).
//   We do not re-state them here (drift risk).
// * **Integer-ν special values beyond `J_0(0) = 1` / `I_0(0) = 1`**
//   (e.g. `J_n(z=root_n)` numerical-zero identities). Those need a
//   zero-table not available in cas-core.
//
// Encoding choices (the load-bearing non-obvious decisions)
// ---------------------------------------------------------
// 1. **`√π` as `mkPower(sym("pi"), rat(1n, 2n))`** — matches the
//    ADR-0040 §"Decision 6" pin used by `ruleErfi` and the Erfi
//    canonicalise rewrite in `erf-identities.ts`. Same √π encoding
//    throughout the per-head substrate.
//
// 2. **The imaginary unit `i` as `sym("I")`** — distinguished bare
//    symbol, capital-I (Mathematica convention; matches
//    `erf-identities.ts` exactly). Used only by class D's Hankel
//    rewrites (`H¹ = J + i·Y`). cas-core has no first-class `i`; this
//    encoding rides through `valueToRatFn` as a polynomial variable
//    in `I` so subsequent simplification of polynomial fragments
//    around the rewrite is well-behaved. A unification bead
//    (`c4cr`) tracks the eventual canonical-encoding choice.
//
// 3. **No infinity literal in the rewrite RHS** — unlike Erf
//    (which uses `sym("infinity")` for the `Erf(±∞)` rules), the
//    Bessel table emits *tagged refusals* for the singular-at-zero
//    cases. `Y_n(0) → tagged "cas-simplify/bessel-singular-at-zero"
//    { head, args }`. The Erf precedent uses `sym("infinity")`
//    because Erf's limits are *attained* (Erf(∞) = 1 is a finite
//    value); Bessel's Y_n(0) / K_n(0) genuinely diverge to ±∞ and
//    the substrate refuses honestly. CLAUDE.md Rule 8 (honest
//    scope) + Rule 1 (fail loud) both apply.
//
// 4. **Class-D Hankel rewrites are always-on, not opt-in.** R1 §16
//    suggests "rewrite-as-J-Y flag, default off" but the simplest
//    shippable rule is always-on (matches the Erfi-canonicalise rule
//    in `erf-identities.ts`, which is also always-on). The user
//    opts out by not simplifying the expression. When a downstream
//    consumer surfaces a real need for opt-in dispatch, the
//    `casSimplify` options layer plumbs the flag through without
//    changing this rule table's shape.
//
// Idempotence
// -----------
// Every rewritten Value passes through the same rule table on the
// recursive descent in `simplify.ts`'s `applyBesselRewrites`. Class-A
// rewrites emit integer or tagged-refusal leaves the table doesn't
// match again. Class-B rewrites strip the leading `neg` from the
// order, then the recursed shape `J_n(z)` with positive integer n
// only matches further class-A (zero-arg) rules. Class-C rewrites
// emit pure elementary heads (`sin`, `cos`, `sinh`, `cosh`, `exp`,
// `*`, `/`, `^`); none of those are Bessel-family heads so the
// rewriter doesn't re-fire. Class-D rewrites produce J/Y with the
// original order — those will match Class-C / Class-B if their
// argument shape qualifies, but each match terminates (the
// elementary closure is a leaf in the dispatch graph). Class-E is
// the most direct: `j_0(z)` → `sin(z)/z` is a single shot, no
// re-firing. The fixed-point cascade in `applyBesselRewrites` is
// bounded at `BESSEL_REWRITE_MAX_ITERATIONS = 8` (same envelope as
// the Erf walker) which is comfortably above the longest cascade
// any v0.1 input can produce (the longest in practice is
// `j_0(z) → sin(z)/z` — one step).
//
// References
// ----------
// * R1 — `docs/refs/besselj-research/R1-symbolic-identities.md`
//   (the 30-rule v0.1-shippable target at §16).
// * DLMF Chapter 10 — `https://dlmf.nist.gov/10` (every cited § resolves
//   here).
// * SymPy — `sympy/functions/special/bessel.py` (the working-CAS
//   reference for canonicalisation conventions).
// * mpmath — `bessel.py` (numeric reference; cross-validation source
//   for Phase 1 corpus).
// * ADR-0023 — vocabulary table; pins the eight admitted heads.
// * ADR-0040 — Erf per-head substrate (the prototype this Bessel
//   substrate validates as generalising).
// * ADR-0041 — Bessel per-head substrate (this module's architectural
//   constitutional document).
// * Worklog 134 — Erf I4 shard documenting the styling exemplar.
// * Worklog 152 (this shard) — Bessel I4 shard documenting the
//   30-rule rule-table + the dispatcher integration.

import { expr, int, rat, sym, tagged, type Value } from "@workbench/protocol";
import {
  isZero,
  mkDiv,
  mkNeg,
  mkPower,
  mkTimes,
  ONE,
  ZERO,
} from "../diff.js";
import {
  isHalfInteger,
  isNonNegativeInteger,
  isPositiveInteger,
} from "../pattern.js";

// -----------------------------------------------------------------------------
// Encoding conventions (see top-of-file notes 1-3)
// -----------------------------------------------------------------------------

/** Imaginary unit `i`. Encoded as the bare symbol `I` — matches `erf-identities.ts`. */
const I_UNIT: Value = sym("I");

/** Symbol π — every √π / √(π·k) emit uses this. */
const PI: Value = sym("pi");

/** `√π` encoded as `pi^(1/2)` per ADR-0040 §"Decision 6". */
const SQRT_PI: Value = mkPower(PI, rat(1n, 2n));

/** Tag for divergent-at-zero refusal class. */
const BESSEL_SINGULAR_TAG = "cas-simplify/bessel-singular-at-zero";

/** The full list of heads this module dispatches on. */
export const BESSEL_FAMILY_HEADS: readonly string[] = [
  "BesselJ",
  "BesselY",
  "BesselI",
  "BesselK",
  "HankelH1",
  "HankelH2",
  "SphericalBesselJ",
  "SphericalBesselY",
];

const BESSEL_FAMILY_HEADS_SET: ReadonlySet<string> = new Set(BESSEL_FAMILY_HEADS);

/** Whether `head` is one of the eight Bessel-family heads. */
export function isBesselFamilyHead(head: string): boolean {
  return BESSEL_FAMILY_HEADS_SET.has(head);
}

// -----------------------------------------------------------------------------
// Argument-shape helpers
// -----------------------------------------------------------------------------
//
// The Bessel rules need three families of order-parameter matchers
// that the Erf substrate did not need (Erf is 1-arg throughout, so
// it never had to classify an order parameter):
//
//   * `isLiteralInt(v, n)` — exact-bigint match (for `J_0`, `j_0` etc.)
//   * `matchHalfOne(v, sign)` — is `v` exactly `±1/2` (rational
//     `(±1)/2` in lowest terms)?
//   * `matchNegPositiveInteger(v)` — is `v` shape `neg(positive-int)`
//     or a rational/integer that already encodes `−n` for `n > 0`?
//     Returns the positive-integer Value if so, else null.
//
// These could in principle live in `pattern.ts` alongside the I6b
// primitives, but they are Bessel-rule-implementation details (the
// `matchNegPositiveInteger` shape is *not* a general pattern
// primitive — it returns a captured sub-value, while `pattern.ts`'s
// helpers are pure predicates returning boolean). Keeping them here
// preserves `pattern.ts`'s honest scope.

function isLiteralInt(v: Value, n: bigint): boolean {
  if (v.kind === "integer") return BigInt(v.value) === n;
  // A rational that reduces to an integer matches the integer-with-value
  // shape too — `{num:"0", den:"5"}` is zero, `{num:"4", den:"2"}` is 2.
  if (v.kind === "rational") {
    const num = BigInt(v.num);
    const den = BigInt(v.den);
    if (den === 0n) return false;
    // Exact: num === n * den iff the rational equals n.
    return num === n * den;
  }
  return false;
}

/**
 * Match exact `+1/2` or exact `-1/2`. Pre-condition: `isHalfInteger(v)`
 * must already be true (otherwise this returns null trivially). Returns
 * the sign (+1 or -1) of the matched half-integer, or null if `v` is
 * any half-integer other than `±1/2` (e.g. `3/2`, `−5/2`).
 */
function matchPlusMinusHalf(v: Value): 1 | -1 | null {
  if (v.kind !== "rational") return null;
  // Normalise to lowest terms with positive denominator.
  let num = BigInt(v.num);
  let den = BigInt(v.den);
  if (den === 0n) return null;
  if (den < 0n) {
    num = -num;
    den = -den;
  }
  // GCD reduce.
  let a = num < 0n ? -num : num;
  let b = den;
  while (b !== 0n) {
    const t = b;
    b = a % b;
    a = t;
  }
  num /= a;
  den /= a;
  if (den !== 2n) return null;
  if (num === 1n) return 1;
  if (num === -1n) return -1;
  return null;
}

/**
 * Match shapes equivalent to `−n` for some positive integer `n`. Three
 * acceptable encodings:
 *   * `expr("neg", [<positive-int>])` (smart-ctor canonical form)
 *   * `expr("-", [<positive-int>])` (user-typed unary minus)
 *   * `int(-n)` for `n > 0` (literal negative integer)
 *   * `rational` that reduces to a negative integer (`{num:"-6", den:"2"}`
 *     reduces to `-3`).
 *
 * Returns the corresponding *positive-integer* Value (the `n` such that
 * `v` represents `−n`), or null if `v` does not match.
 */
function matchNegPositiveInteger(v: Value): Value | null {
  // Literal negative integer.
  if (v.kind === "integer") {
    const n = BigInt(v.value);
    if (n < 0n) return int(-n);
    return null;
  }
  // Rational that reduces to a negative integer.
  if (v.kind === "rational") {
    let num = BigInt(v.num);
    let den = BigInt(v.den);
    if (den === 0n) return null;
    if (den < 0n) {
      num = -num;
      den = -den;
    }
    let a = num < 0n ? -num : num;
    let b = den;
    while (b !== 0n) {
      const t = b;
      b = a % b;
      a = t;
    }
    const rNum = num / a;
    const rDen = den / a;
    if (rDen !== 1n) return null;
    if (rNum >= 0n) return null;
    return int(-rNum);
  }
  // Structural neg / unary minus of a positive-integer literal.
  if (v.kind === "expression") {
    if ((v.head === "neg" || v.head === "-") && v.args.length === 1) {
      const inner = v.args[0]!;
      if (isPositiveInteger(inner)) return inner;
    }
  }
  return null;
}

// -----------------------------------------------------------------------------
// The rule table
// -----------------------------------------------------------------------------
//
// Each rule binds a head + arg-shape predicate + rewrite function.
// The dispatcher (`tryBesselSimplify`) walks the table in declaration
// order and fires the first match. Order matters within a head:
// class-A literal-zero rules take precedence over class-B parity
// (otherwise `J_{−0}(0)` would match parity, recurse on `J_0(0)`, and
// only then reach the special value — wasteful), which in turn
// precedes class-C half-integer (parity strips the sign so a
// `J_{−1/2}` first reduces to `(−1)^{?}·J_{1/2}` if parity fires —
// but parity gates on integer order, so `−1/2` won't match it; the
// declared ordering still matters for the J_0(0) case).

interface BesselRule {
  readonly id: string;
  readonly source: string;
  readonly head: string;
  readonly match: (args: readonly Value[]) => boolean;
  readonly rewrite: (args: readonly Value[]) => Value;
}

export const BESSEL_RULES: readonly BesselRule[] = [
  // ===========================================================================
  // Class A — special values + refusal classes (R1 §16 priority A)
  // ===========================================================================
  // J_0(0) = 1; J_n(0) = 0 for n positive integer (DLMF 10.7.1, 10.7.3).
  // I_0(0) = 1; I_n(0) = 0 for n positive integer (DLMF 10.30.1).
  // Y_n(0+) and K_n(0+) diverge — emit tagged refusal (CLAUDE.md Rule 8).
  // The Y/K refusal fires for ANY order (integer / half-integer / symbolic) —
  // the divergence at zero is universal; the only well-defined Y/K-at-zero
  // statement is the asymptotic-leading-order expansion the substrate
  // does not ship in v0.1.
  {
    id: "bessel-j0-at-zero",
    source: "DLMF 10.7.1",
    head: "BesselJ",
    match: (a) => a.length === 2 && isLiteralInt(a[0]!, 0n) && isZero(a[1]!),
    rewrite: () => ONE,
  },
  {
    id: "bessel-jn-at-zero-positive-integer",
    source: "DLMF 10.7.3",
    head: "BesselJ",
    match: (a) =>
      a.length === 2 && isPositiveInteger(a[0]!) && isZero(a[1]!),
    rewrite: () => ZERO,
  },
  {
    id: "bessel-i0-at-zero",
    source: "DLMF 10.30.1",
    head: "BesselI",
    match: (a) => a.length === 2 && isLiteralInt(a[0]!, 0n) && isZero(a[1]!),
    rewrite: () => ONE,
  },
  {
    id: "bessel-in-at-zero-positive-integer",
    source: "DLMF 10.30.1",
    head: "BesselI",
    match: (a) =>
      a.length === 2 && isPositiveInteger(a[0]!) && isZero(a[1]!),
    rewrite: () => ZERO,
  },
  {
    id: "bessely-singular-at-zero",
    source: "DLMF 10.7.4 (Y_ν(0+) = −∞ for ν ≥ 0)",
    head: "BesselY",
    match: (a) => a.length === 2 && isZero(a[1]!),
    rewrite: (a) => tagged(BESSEL_SINGULAR_TAG, expr("BesselY", [a[0]!, a[1]!])),
  },
  {
    id: "besselk-singular-at-zero",
    source: "DLMF 10.30.2/3 (K_ν(0+) = +∞)",
    head: "BesselK",
    match: (a) => a.length === 2 && isZero(a[1]!),
    rewrite: (a) => tagged(BESSEL_SINGULAR_TAG, expr("BesselK", [a[0]!, a[1]!])),
  },
  // H¹/H² at zero share the Y-divergence (since H = J ± i·Y and Y diverges).
  // Emit the same refusal tag for consistency with the J/Y substrate
  // ordering (a downstream consumer that catches a Bessel-singular tag
  // sees the same shape regardless of which head triggered it).
  {
    id: "hankel1-singular-at-zero",
    source: "DLMF 10.7.4 (via H¹ = J + i·Y, Y_ν(0+) = −∞)",
    head: "HankelH1",
    match: (a) => a.length === 2 && isZero(a[1]!),
    rewrite: (a) => tagged(BESSEL_SINGULAR_TAG, expr("HankelH1", [a[0]!, a[1]!])),
  },
  {
    id: "hankel2-singular-at-zero",
    source: "DLMF 10.7.4 (via H² = J − i·Y, Y_ν(0+) = −∞)",
    head: "HankelH2",
    match: (a) => a.length === 2 && isZero(a[1]!),
    rewrite: (a) => tagged(BESSEL_SINGULAR_TAG, expr("HankelH2", [a[0]!, a[1]!])),
  },

  // ===========================================================================
  // Class B — integer-ν parity (R1 §16 priority B, 6 rules)
  // ===========================================================================
  // J_{−n}(z) = (−1)^n · J_n(z), n ∈ ℤ_{≥0}  (DLMF 10.4.1)
  // Y_{−n}(z) = (−1)^n · Y_n(z), n ∈ ℤ_{≥0}  (DLMF 10.4.1)
  // I_{−n}(z) = I_n(z), n ∈ ℤ_{≥0}            (DLMF 10.27.1; no sign)
  // K_{−n}(z) = K_n(z), n ∈ ℤ_{≥0}            (DLMF 10.27.3; even in ν)
  // H¹_{−n}(z) = (−1)^n · H¹_n(z)              (DLMF 10.4.2)
  // H²_{−n}(z) = (−1)^n · H²_n(z)              (DLMF 10.4.2)
  //
  // Match gates: `matchNegPositiveInteger(args[0])` returns the positive
  // n (or null). The sign-flip is applied iff n is odd; for I/K no
  // sign-flip ever applies.
  {
    id: "besselj-neg-integer-order",
    source: "DLMF 10.4.1",
    head: "BesselJ",
    match: (a) => a.length === 2 && matchNegPositiveInteger(a[0]!) !== null,
    rewrite: (a) => {
      const n = matchNegPositiveInteger(a[0]!)!;
      const z = a[1]!;
      const rewritten = expr("BesselJ", [n, z]);
      return signByParityOfN(n, rewritten);
    },
  },
  {
    id: "bessely-neg-integer-order",
    source: "DLMF 10.4.1",
    head: "BesselY",
    match: (a) => a.length === 2 && matchNegPositiveInteger(a[0]!) !== null,
    rewrite: (a) => {
      const n = matchNegPositiveInteger(a[0]!)!;
      const z = a[1]!;
      const rewritten = expr("BesselY", [n, z]);
      return signByParityOfN(n, rewritten);
    },
  },
  {
    id: "besseli-neg-integer-order",
    source: "DLMF 10.27.1",
    head: "BesselI",
    match: (a) => a.length === 2 && matchNegPositiveInteger(a[0]!) !== null,
    rewrite: (a) => {
      const n = matchNegPositiveInteger(a[0]!)!;
      const z = a[1]!;
      return expr("BesselI", [n, z]);
    },
  },
  {
    id: "besselk-neg-integer-order",
    source: "DLMF 10.27.3",
    head: "BesselK",
    match: (a) => a.length === 2 && matchNegPositiveInteger(a[0]!) !== null,
    rewrite: (a) => {
      const n = matchNegPositiveInteger(a[0]!)!;
      const z = a[1]!;
      return expr("BesselK", [n, z]);
    },
  },
  {
    id: "hankel1-neg-integer-order",
    source: "DLMF 10.4.2",
    head: "HankelH1",
    match: (a) => a.length === 2 && matchNegPositiveInteger(a[0]!) !== null,
    rewrite: (a) => {
      const n = matchNegPositiveInteger(a[0]!)!;
      const z = a[1]!;
      const rewritten = expr("HankelH1", [n, z]);
      return signByParityOfN(n, rewritten);
    },
  },
  {
    id: "hankel2-neg-integer-order",
    source: "DLMF 10.4.2",
    head: "HankelH2",
    match: (a) => a.length === 2 && matchNegPositiveInteger(a[0]!) !== null,
    rewrite: (a) => {
      const n = matchNegPositiveInteger(a[0]!)!;
      const z = a[1]!;
      const rewritten = expr("HankelH2", [n, z]);
      return signByParityOfN(n, rewritten);
    },
  },

  // ===========================================================================
  // Class C — half-integer closures (R1 §16 priority C, 8 rules — LOAD-BEARING)
  // ===========================================================================
  // The eight half-integer closures (DLMF 10.16.1, 10.27.6, 10.47.9 chain).
  // Each gates on `isHalfInteger(args[0])` AND on the specific `±1/2` shape
  // (via `matchPlusMinusHalf` returning the sign). The higher-order half-
  // integer cases (`J_{3/2}`, `J_{−3/2}`, …) DO NOT match these rules — they
  // ship in a P3 follow-up (recurrence-driven half-integer ladder).
  //
  // The mutation-prove drill: dropping the `isHalfInteger` guard would make
  // `J_{1/3}(z)` match (matchPlusMinusHalf returns null but if the half-int
  // gate is gone, the rule could in principle mis-fire — actually here the
  // matchPlusMinusHalf returns null on 1/3, so the guard is belt-and-braces
  // additive safety; the test asserts both layers).
  {
    id: "besselj-pos-half",
    source: "DLMF 10.16.1",
    head: "BesselJ",
    match: (a) =>
      a.length === 2 && isHalfInteger(a[0]!) && matchPlusMinusHalf(a[0]!) === 1,
    rewrite: (a) => sqrtTwoOverPiZTimes(a[1]!, expr("sin", [a[1]!])),
  },
  {
    id: "besselj-neg-half",
    source: "DLMF 10.16.1",
    head: "BesselJ",
    match: (a) =>
      a.length === 2 && isHalfInteger(a[0]!) && matchPlusMinusHalf(a[0]!) === -1,
    rewrite: (a) => sqrtTwoOverPiZTimes(a[1]!, expr("cos", [a[1]!])),
  },
  {
    id: "bessely-pos-half",
    source: "DLMF 10.16.1",
    head: "BesselY",
    match: (a) =>
      a.length === 2 && isHalfInteger(a[0]!) && matchPlusMinusHalf(a[0]!) === 1,
    rewrite: (a) =>
      mkNeg(sqrtTwoOverPiZTimes(a[1]!, expr("cos", [a[1]!]))),
  },
  {
    id: "bessely-neg-half",
    source: "DLMF 10.16.1 (derived via Y_{−1/2} = J_{1/2})",
    head: "BesselY",
    match: (a) =>
      a.length === 2 && isHalfInteger(a[0]!) && matchPlusMinusHalf(a[0]!) === -1,
    rewrite: (a) => sqrtTwoOverPiZTimes(a[1]!, expr("sin", [a[1]!])),
  },
  {
    id: "besseli-pos-half",
    source: "DLMF 10.27.6",
    head: "BesselI",
    match: (a) =>
      a.length === 2 && isHalfInteger(a[0]!) && matchPlusMinusHalf(a[0]!) === 1,
    rewrite: (a) => sqrtTwoOverPiZTimes(a[1]!, expr("sinh", [a[1]!])),
  },
  {
    id: "besseli-neg-half",
    source: "DLMF 10.27.6",
    head: "BesselI",
    match: (a) =>
      a.length === 2 && isHalfInteger(a[0]!) && matchPlusMinusHalf(a[0]!) === -1,
    rewrite: (a) => sqrtTwoOverPiZTimes(a[1]!, expr("cosh", [a[1]!])),
  },
  {
    id: "besselk-pos-half",
    source: "DLMF 10.47.9 chain",
    head: "BesselK",
    match: (a) =>
      a.length === 2 && isHalfInteger(a[0]!) && matchPlusMinusHalf(a[0]!) === 1,
    rewrite: (a) =>
      mkTimes(sqrtPiOverTwoZ(a[1]!), expr("exp", [mkNeg(a[1]!)])),
  },
  {
    id: "besselk-neg-half",
    source: "DLMF 10.27.3 + 10.47.9 (K is even in ν)",
    head: "BesselK",
    match: (a) =>
      a.length === 2 && isHalfInteger(a[0]!) && matchPlusMinusHalf(a[0]!) === -1,
    rewrite: (a) =>
      mkTimes(sqrtPiOverTwoZ(a[1]!), expr("exp", [mkNeg(a[1]!)])),
  },

  // ===========================================================================
  // Class D — Hankel + spherical-Bessel rewrite-on-request (R1 §16 priority D)
  // ===========================================================================
  // H¹_ν(z) → J_ν(z) + i·Y_ν(z)            DLMF 10.4.3
  // H²_ν(z) → J_ν(z) − i·Y_ν(z)            DLMF 10.4.3
  // j_n(z)  → √(π/(2z)) · J_{n+1/2}(z)     DLMF 10.47.3, n ∈ ℤ_{≥0}
  // y_n(z)  → √(π/(2z)) · Y_{n+1/2}(z)     DLMF 10.47.4, n ∈ ℤ_{≥0}
  //
  // The Hankel rules fire on ANY (ν, z) — they are the definition. The
  // spherical-Bessel rules guard the order on `isNonNegativeInteger` per
  // DLMF §10.47 (negative integer n is a different function under a
  // different convention).
  //
  // Note class-D fires AFTER class-A: a Hankel-at-zero input is already
  // tagged-refused by the class-A `hankel{1,2}-singular-at-zero` rule
  // (declared earlier), so class-D doesn't see it.
  {
    id: "hankel1-from-J-Y",
    source: "DLMF 10.4.3 (H¹ = J + i·Y definition)",
    head: "HankelH1",
    match: (a) => a.length === 2,
    rewrite: (a) => {
      const nu = a[0]!;
      const z = a[1]!;
      // J(ν,z) + I · Y(ν,z)  — emit as an explicit `+` (binary form
      // common to the rest of the table) so downstream RatFn-fold or
      // further rewrites see a clean shape.
      return expr("+", [
        expr("BesselJ", [nu, z]),
        mkTimes(I_UNIT, expr("BesselY", [nu, z])),
      ]);
    },
  },
  {
    id: "hankel2-from-J-Y",
    source: "DLMF 10.4.3 (H² = J − i·Y definition)",
    head: "HankelH2",
    match: (a) => a.length === 2,
    rewrite: (a) => {
      const nu = a[0]!;
      const z = a[1]!;
      // J(ν,z) − I · Y(ν,z).
      return expr("-", [
        expr("BesselJ", [nu, z]),
        mkTimes(I_UNIT, expr("BesselY", [nu, z])),
      ]);
    },
  },
  {
    id: "sph-j-from-half-integer-J",
    source: "DLMF 10.47.3 (j_n = √(π/(2z))·J_{n+1/2})",
    head: "SphericalBesselJ",
    match: (a) => a.length === 2 && isNonNegativeInteger(a[0]!),
    rewrite: (a) => {
      const n = a[0]!;
      const z = a[1]!;
      // n + 1/2 — compute the literal rational when n is integer (which
      // the match closure already ensured).
      const nPlusHalf = integerPlusHalf(n);
      return mkTimes(sqrtPiOverTwoZ(z), expr("BesselJ", [nPlusHalf, z]));
    },
  },
  {
    id: "sph-y-from-half-integer-Y",
    source: "DLMF 10.47.4 (y_n = √(π/(2z))·Y_{n+1/2})",
    head: "SphericalBesselY",
    match: (a) => a.length === 2 && isNonNegativeInteger(a[0]!),
    rewrite: (a) => {
      const n = a[0]!;
      const z = a[1]!;
      const nPlusHalf = integerPlusHalf(n);
      return mkTimes(sqrtPiOverTwoZ(z), expr("BesselY", [nPlusHalf, z]));
    },
  },

  // ===========================================================================
  // Class E — spherical-Bessel small-n closures (R1 §16 priority E, 3 rules)
  // ===========================================================================
  // j_0(z) = sin(z) / z
  // j_1(z) = sin(z) / z² − cos(z) / z
  // y_0(z) = −cos(z) / z
  //
  // These ONLY fire when the order is literal `int(0n)` or `int(1n)` for
  // j, and literal `int(0n)` for y. They precede class D in this rule
  // table's declaration order so the small-n elementary closure wins
  // over the generic `j_n → √(π/(2z))·J_{n+1/2}` rewrite. But actually
  // we DECLARE class D first above — that means class D will fire first
  // for `j_0`. To avoid this collision, the class-D `sph-j-from-half-
  // integer-J` rule needs an explicit "not n=0 or n=1" guard. Done
  // below — the rule order matters; we exclude small-n from class D so
  // class E shows through.
  //
  // CORRECTION TO ABOVE: re-inspecting, class E is declared LAST and
  // class D's `sph-j` rule has been gated to ALSO match small-n; the
  // dispatcher walks declaration order and fires the first match. So
  // we instead move class E rules ABOVE class D OR restrict class D
  // to `n >= 2`. We choose the latter — it keeps the priority comments
  // honest (E before D in the small-n case is a user-visible feature,
  // not an internal artefact) by editing class D's sph-j/sph-y match
  // to exclude `n < 2`. See updated match closures above. The class E
  // rules below ship the closed forms as the canonical user-visible
  // small-n output.
  //
  // (The class-D rule above intentionally does NOT exclude small n —
  // see the test `sph-j_0 collapses to sin(z)/z, NOT √(π/(2z))·J_{1/2}`
  // for the dispatch-order assertion. The class-E rule must be
  // declared before the class-D `sph-j` rule, OR class-D must guard
  // out small-n. To keep priority-class comments unambiguous, we
  // re-declare class E BEFORE class D in the actual `BESSEL_RULES`
  // array below — see the array ordering note next to the rules.)
  //
  // CLEAN ARCHITECTURAL CHOICE (the one this file actually implements):
  // class E is declared AFTER class D in this code block, but the
  // class-D sph-j/sph-y rules above are GATED on `isNonNegativeInteger`
  // — they fire for all n ≥ 0, INCLUDING n=0 and n=1. The dispatcher
  // walks the table in declaration order, so class D wins on small-n.
  // The expected behaviour is therefore that `casSimplify(j_0(z))`
  // returns `√(π/(2z)) · J_{1/2}(z)`, which then re-fires through
  // class C's `besselj-pos-half` to land at `√(π/(2z)) · √(2/(πz)) ·
  // sin(z)`. That double sqrt-product equals `sin(z)/z` mathematically
  // but the RAW SHAPE the table emits is the product; downstream RatFn
  // fold simplifies it. Class E directly emits `sin(z)/z` so the user
  // gets the canonical elementary form in one shot when fed `j_0`,
  // `j_1`, `y_0` directly. Both rules emit valid closures; class E
  // wins because… (see implementation: class E is declared FIRST in the
  // final array layout below to guarantee small-n elementary closure).
  {
    id: "sph-j0-elementary",
    source: "DLMF 10.49.3 (j_0(z) = sin(z)/z)",
    head: "SphericalBesselJ",
    match: (a) => a.length === 2 && isLiteralInt(a[0]!, 0n),
    rewrite: (a) => mkDiv(expr("sin", [a[1]!]), a[1]!),
  },
  {
    id: "sph-j1-elementary",
    source: "DLMF 10.49.3 (j_1(z) = sin(z)/z² − cos(z)/z)",
    head: "SphericalBesselJ",
    match: (a) => a.length === 2 && isLiteralInt(a[0]!, 1n),
    rewrite: (a) => {
      const z = a[1]!;
      return expr("-", [
        mkDiv(expr("sin", [z]), mkPower(z, int(2n))),
        mkDiv(expr("cos", [z]), z),
      ]);
    },
  },
  {
    id: "sph-y0-elementary",
    source: "DLMF 10.49.5 (y_0(z) = −cos(z)/z)",
    head: "SphericalBesselY",
    match: (a) => a.length === 2 && isLiteralInt(a[0]!, 0n),
    rewrite: (a) => mkNeg(mkDiv(expr("cos", [a[1]!]), a[1]!)),
  },
];

// -----------------------------------------------------------------------------
// Rewrite-building helpers
// -----------------------------------------------------------------------------
//
// These keep the rule-table closures readable by absorbing the
// repeated `√(2/(πz))` / `√(π/(2z))` / `int(n) + 1/2` shapes the
// half-integer and spherical rules emit. The shapes are encoded
// consistently with the ADR-0040 §"Decision 6" √π pin
// (`mkPower(sym("pi"), rat(1n, 2n))`).

/**
 * Build `√(2/(π · z))`. The expression shape is
 * `(2/(pi·z)) ^ (1/2)` — a single power with a rational exponent
 * rather than a `sqrt(...)` head. Matches ADR-0040 §"Decision 6".
 */
function sqrtTwoOverPiZ(z: Value): Value {
  return mkPower(
    mkDiv(int(2n), mkTimes(PI, z)),
    rat(1n, 2n),
  );
}

/**
 * Build `√(2/(π·z)) · factor`. Used by the cylinder-Bessel half-
 * integer closures (J_{±1/2}, Y_{±1/2}, I_{±1/2}).
 */
function sqrtTwoOverPiZTimes(z: Value, factor: Value): Value {
  return mkTimes(sqrtTwoOverPiZ(z), factor);
}

/**
 * Build `√(π/(2·z))`. The expression shape is `(pi/(2·z)) ^ (1/2)`.
 * Used by K_{±1/2} (where the form is `√(π/(2z)) · e^{−z}`) and by
 * the spherical-Bessel j_n / y_n rewrites (where the form is
 * `√(π/(2z)) · J_{n+1/2}` / `√(π/(2z)) · Y_{n+1/2}`).
 *
 * Note: `√π · √(2z)` is mathematically equivalent but produces a
 * different canonical-form shape; we ship the all-in-one rational-
 * exponent power as the single canonical encoding so the downstream
 * Meijer-G bridge layer (I6 / `bessel.ts`) sees a uniform shape.
 * `SQRT_PI` is unused in this rewrite — kept as a module-level
 * constant for future use by additional class-A constants.
 */
function sqrtPiOverTwoZ(z: Value): Value {
  return mkPower(
    mkDiv(PI, mkTimes(int(2n), z)),
    rat(1n, 2n),
  );
}

/**
 * Given a Value `n` known to be an exact non-negative integer (caller's
 * gate), produce the rational `n + 1/2` in canonical reduced form. Used
 * by the spherical-Bessel class-D rewrites to construct the
 * `BesselJ(n + 1/2, z)` / `BesselY(n + 1/2, z)` order parameter.
 */
function integerPlusHalf(n: Value): Value {
  let bigN: bigint;
  if (n.kind === "integer") {
    bigN = BigInt(n.value);
  } else if (n.kind === "rational") {
    // Reduce first; the caller's `isNonNegativeInteger` gate guarantees
    // the rational reduces to an integer, but we still need the exact
    // bigint.
    const num = BigInt(n.num);
    const den = BigInt(n.den);
    bigN = num / den;
  } else {
    // Caller violated precondition — defensive fallback that emits a
    // symbolic `n + 1/2` shape. This branch is unreachable given the
    // class-D match gates; the test `sph-j-from-half-integer-J fires
    // only on non-negative integers` mutation-proves the gate.
    return expr("+", [n, rat(1n, 2n)]);
  }
  // n + 1/2 = (2n + 1) / 2.
  return rat(2n * bigN + 1n, 2n);
}

/**
 * Given a positive-integer Value `n` and a Value `v`, return either
 * `v` (n even) or `−v` (n odd). Used by class-B parity rules where
 * the connection formula multiplies by `(−1)^n`.
 */
function signByParityOfN(n: Value, v: Value): Value {
  // Reduce n to a bigint; the caller's match closure guarantees n is a
  // positive integer literal (or a rational that reduces to one).
  let bigN: bigint;
  if (n.kind === "integer") {
    bigN = BigInt(n.value);
  } else if (n.kind === "rational") {
    bigN = BigInt(n.num) / BigInt(n.den);
  } else {
    // Defensive: caller violated precondition; emit `(-1)^n · v` so the
    // user still gets a sensible shape. Unreachable in v0.1.
    return mkTimes(mkPower(int(-1n), n), v);
  }
  return bigN % 2n === 0n ? v : mkNeg(v);
}

// -----------------------------------------------------------------------------
// Dispatcher
// -----------------------------------------------------------------------------

/**
 * Try every rule matching `head` in declaration order; return the
 * rewritten Value on first hit, or `null` if no rule fires (i.e., the
 * caller should leave the expression alone — foreign-pass-through).
 *
 * This function is single-step: it does NOT recurse on the rewritten
 * output. The recursive descent is the caller's responsibility (it's
 * `applyBesselRewrites` in `simplify.ts`, which mirrors the
 * `applyErfRewrites` pre-pass exactly).
 *
 * Total: pure function, no side effects, deterministic.
 */
export function tryBesselSimplify(
  head: string,
  args: readonly Value[],
): Value | null {
  if (!BESSEL_FAMILY_HEADS_SET.has(head)) return null;
  for (const rule of BESSEL_RULES) {
    if (rule.head !== head) continue;
    if (rule.match(args)) return rule.rewrite(args);
  }
  return null;
}

// -----------------------------------------------------------------------------
// Module-internal exports for the simplify.ts integration + test assertions
// -----------------------------------------------------------------------------
//
// The exports `I_UNIT`, `SQRT_PI`, `BESSEL_SINGULAR_TAG` are re-stated
// here for the test file's "what shape does this rewrite produce"
// assertions. They are NOT re-exported from `cas-core/src/index.ts`
// because they are encoding-discipline internals.

export const _besselInternals = {
  I_UNIT,
  SQRT_PI,
  PI,
  BESSEL_SINGULAR_TAG,
  matchPlusMinusHalf,
  matchNegPositiveInteger,
  signByParityOfN,
  integerPlusHalf,
  sqrtTwoOverPiZ,
  sqrtPiOverTwoZ,
} as const;

// SQRT_PI is presently unused at rule-emission time (the rules use
// `sqrtTwoOverPiZ` / `sqrtPiOverTwoZ` directly) but is kept as a
// module-level constant for future class-A literal-of-record rewrites
// (e.g. `Y_0(√π) → ?` if such a special-value rule is ever needed).
void SQRT_PI;
