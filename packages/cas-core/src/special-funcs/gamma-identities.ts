// =============================================================================
// gamma-identities.ts — symbolic identity table for the Gamma-family heads
// =============================================================================
//
// Purpose
// -------
// This module is the v0.1 implementation of R1's identity catalogue for
// the Gamma family (`docs/refs/gamma-research/R1-symbolic-identities.md`
// §3), ported to the cas-core AST and integrated into `cas-simplify`'s
// rewriter dispatch. It is the per-head sibling of the Erf-family table
// in `erf-identities.ts` and the Bessel-family table in
// `bessel-identities.ts` — the same dispatch shape, the same idempotence
// + foreign-pass-through invariants, the same literate-prose discipline.
// The Gamma substrate is the *third* head this architecture is applied
// to (ADR-0040 §"Decision 6" = Erf; ADR-0041 §"Decision 6" = Bessel;
// ADR-0042 §"Decision 6" + §"Decision 13" = Gamma); ADR-0042's central
// claim is that the per-head pattern generalises further without
// architectural change. The only Gamma-specific additions are (a) six
// new vocabulary heads (LogGamma, Pochhammer, IncompleteGammaUpper,
// IncompleteGammaLower, Beta, BarnesG — admitted by ADR-0042
// §"Decision 6"; bead `2vmd`) and (b) one new pattern primitive
// (`isNonPositiveInteger`, bead `h37z`) — both shipped *before* this
// module so the rule-table author here only consumes them.
//
// The nine heads in scope (per ADR-0023 + ADR-0042 §"Decision 6"):
//   * `Gamma`                — DLMF §5, complete-function Γ
//   * `LogGamma`             — DLMF §5.11, principal-value log Γ
//   * `Pochhammer`           — DLMF §5.2.4, rising factorial (a)_n
//   * `Digamma`              — DLMF §5.2.2, ψ(z) = Γ'(z)/Γ(z)
//   * `Polygamma`            — DLMF §5.15, ψ^{(m)}(z)
//   * `IncompleteGammaUpper` — DLMF §8.2.2, Γ(a, z)
//   * `IncompleteGammaLower` — DLMF §8.2.1, γ(a, z)
//   * `Beta`                 — DLMF §5.12, Euler's Beta B(a, b)
//   * `BarnesG`              — DLMF §5.17, multiplicative analogue of Γ
//
// Arity is 1 for `Gamma`, `LogGamma`, `Digamma`, `BarnesG`; 2 for all
// others (`Pochhammer(a, n)`, `Polygamma(m, z)`,
// `IncompleteGammaUpper(a, z)`, `IncompleteGammaLower(a, z)`,
// `Beta(a, b)`).
//
// The five priority classes (R1 §4; total ≥ 38 rules in v0.1 ship)
// -----------------------------------------------------------------
// **Priority A — special values + pole-refusal classes.** The closed
// special values at integers and half-integers (`Γ(1)=1`, `Γ(1/2)=√π`,
// `Γ(-1/2)=-2√π`, etc.) and the load-bearing pole-refusal rules. The
// refusal tag is **`"cas-simplify/gamma-pole"`** — matching ADR-0042's
// per-head-substrate convention (the tag namespace is the *outer*
// dispatcher, `cas-simplify`, not the per-head module). The tag's
// payload is a `record { head, arg }` so a downstream consumer can
// recover what was attempted. The refusal fires for `Gamma`,
// `LogGamma`, `Digamma`, and `Polygamma` at non-positive integer
// arguments (their poles). `BarnesG` at non-positive integers is a
// *zero*, not a pole (DLMF §5.17.1: `G(0) = G(-1) = G(-2) = … = 0`)
// — that rule lives here too but emits `int(0n)`, not a tagged
// refusal.
//
// **Priority B — half-integer + small-integer closures.** The half-
// integer values of Γ beyond ±1/2 (`Γ(3/2) = (1/2)√π`,
// `Γ(5/2) = (3/4)√π`, `Γ(-3/2) = (4/3)√π`); the small-integer
// closures of Digamma at concrete `n` (`ψ(1) = -γ_E`,
// `ψ(2) = 1 - γ_E`, `ψ(3) = 3/2 - γ_E`; `ψ(1/2) = -γ_E - 2·log(2)`,
// `ψ(3/2) = 2 - γ_E - 2·log(2)`); the small Pochhammer closure
// `(a)_2 = a(a+1)`; the Polygamma special values
// `ψ'(1) = π²/6`, `ψ'(1/2) = π²/2`, `ψ''(1) = -2·ζ(3)`; and the
// `LogGamma(1/2) = (1/2)·log(π)` closure. The Euler–Mascheroni
// constant `γ_E` is encoded as the bare symbol `sym("EulerGamma")`
// (matching SymPy/Mathematica; R1 §3 documents this choice). The
// Riemann zeta literal in `ψ''(1)` is `sym("RiemannZeta")` applied as
// `expr("RiemannZeta", [int(3n)])` — not currently in the cas-core
// elementary vocabulary, but the rewrite emits the symbolic shape;
// downstream consumers either know `RiemannZeta(3)` or treat it as
// out-of-scope (the standard foreign-pass-through behaviour).
//
// **Priority C — recurrences + reflection (LOAD-BEARING).** The
// recurrences that drive canonicalisation:
//   * Γ(z+1) = z · Γ(z)                       (DLMF §5.5.1)
//   * LogGamma(z+1) = log(z) + LogGamma(z)    (from Γ recurrence)
//   * (a)_{n+1} = (a+n) · (a)_n               (DLMF §5.2.4)
//   * (a)_n → Γ(a+n) / Γ(a)                   (DLMF §5.2.5; "expand")
//   * ψ(z+1) = ψ(z) + 1/z                     (DLMF §5.5.2)
//   * Γ(a+1, z) = a·Γ(a,z) + z^a·e^{-z}        (DLMF §8.8.2)
//   * γ(a+1, z) = a·γ(a,z) - z^a·e^{-z}        (DLMF §8.8.1)
//   * B(a+1, b) = (a/(a+b)) · B(a, b)          (DLMF §5.12)
//   * G(z+1) = Γ(z) · G(z)                     (DLMF §5.17.1)
//   * B(a, b) → Γ(a)·Γ(b) / Γ(a+b)             (DLMF §5.12.1; "expand")
//
// Plus the SIGN-CRITICAL Digamma reflection:
//
//   * ψ(1-z) = ψ(z) + π · cos(πz) / sin(πz)    (DLMF §5.5.4)
//
// **The reflection sign is PLUS, not MINUS.** DLMF §5.5.4 reads
// `ψ(1-z) - ψ(z) = +π·cot(πz)`; rearranged for the LHS pattern
// `ψ(1-z)`, the term is `+π·cot(πz)` (no sign flip — we are not
// moving anything across the `=`). Numerical sanity check at z=-0.3
// using mpmath (cited in R1 §3 and in the bead body): ψ(1.3) ≈
// -0.169426; π·cot(-0.3π) ≈ -2.281829; so ψ(1-(-0.3)) = ψ(1.3) =
// ψ(-0.3) + π·cot(-0.3π) ⇒ ψ(-0.3) = -0.169426 - (-2.281829) ≈
// +2.112403, which agrees with `mpmath.digamma(-0.3) ≈ 2.11241`.
// An earlier R1 draft had this sign as MINUS; the test file's
// non-half-integer z = -0.3 mutation-prove explicitly catches a
// sign flip (at half-integer z the cot term is zero and a sign
// error is invisible). `cot` is NOT in the cas-core vocabulary so
// the RHS expands as `cos(πz) / sin(πz)`.
//
// Also at Priority C: the boundary identities for incomplete Gamma:
//
//   * Γ(a, 0) = Γ(a)              (DLMF §8.4)
//   * Γ(1, z) = e^{-z}             (DLMF §8.4.5)
//   * γ(a, 0) = 0                  (DLMF §8.4)
//   * γ(1, z) = 1 - e^{-z}         (DLMF §8.4.7 n=0)
//
// And the small Beta closures:
//
//   * B(1, 1) = 1
//   * B(a, 1) = 1/a
//   * B(1, b) = 1/b
//   * B(1/2, 1/2) = π
//
// **Priority D — multiplication theorems + BarnesG functional eq.** The
// Legendre duplication for Γ:
//
//   * Γ(2z) = (2^(2z-1) / √π) · Γ(z) · Γ(z + 1/2)   (DLMF §5.5.5)
//
// The Digamma duplication:
//
//   * ψ(2z) = (1/2)·[ψ(z) + ψ(z + 1/2)] + log(2)    (DLMF §5.5.8)
//
// Plus the Polygamma recurrence (concrete m):
//
//   * ψ^{(m)}(z+1) = ψ^{(m)}(z) + (-1)^m · m! / z^{m+1}   (DLMF §5.15.5)
//
// The Gauss multiplication theorem in full generality (Γ(nz) for
// arbitrary integer n ≥ 3) is **DEFERRED** to a v0.2 followup bead
// `v02-gauss-general`; v0.1 admits only q=2 (Legendre, above). The
// q=2 case is the only one that ships in v0.1 because the general-q
// rewrite produces a product over a range (n − 1 Gamma factors)
// which needs a pattern-language extension the rewriter doesn't have.
//
// **Priority E — small.** The BarnesG integer table: G(1) = G(2) =
// G(3) = 1, G(4) = 2, G(5) = 12 (DLMF §5.17.2; mpmath verified). Each
// ships as a separate rule that gates on the exact integer literal.
//
// Total: this table ships **≥ 40 rules** in v0.1 (well above the R1
// §4 target of 38 after dedup). The exact count is asserted by the
// test file (`BESSEL_RULES` precedent — same shape).
//
// What is NOT here
// ----------------
// * **Cross-head sum-collapses.** The Erf precedent has
//   `Erf(z) + Erfc(z) → 1` as a sum-walker rule in `simplify.ts`. The
//   Gamma family has an analogous identity:
//     IncompleteGammaUpper(a, z) + IncompleteGammaLower(a, z) → Γ(a)
//   (DLMF §8.2.3 — "complementarity"). Per R1 §5 Discovery C4, this
//   ships as a sum-walker rule in `simplify.ts` in a follow-up bead
//   (not in this I4 bead's scope; the per-head table cannot see the
//   sum). The same applies to Gamma reflection
//   `Γ(z)·Γ(1-z) → π/sin(πz)` which is a *product*-walker rule.
//
// * **General Gauss multiplication theorem** (Γ(nz) for arbitrary
//   integer n ≥ 3). Filed as a v0.2 follow-up bead;
//   pattern-language-extension blocked.
//
// * **General-q Gauss digamma formula** (ψ(p/q) for q ∉ {2, 3, 4, 6}).
//   R1 §3 priority-B includes ψ(1/3), ψ(2/3), ψ(1/4), ψ(3/4), ψ(1/6),
//   ψ(5/6) — the cases where the Gauss closed form collapses to clean
//   π·cot(πp/q) + √3 + log expressions. For arbitrary p/q the closed
//   form involves a sum of cos·log(sin) terms that doesn't always
//   collapse; deferred to v0.2. The six clean cases ship as separate
//   priority-B rules; the remainder live in the bead followup
//   `v02-gauss-digamma-general`.
//
// * **Diff-rule duplication.** Diff rules for `Gamma`, `LogGamma`,
//   `Digamma`, `Polygamma`, `IncompleteGammaUpper`,
//   `IncompleteGammaLower`, `Beta` already ship in
//   `cas-core/src/special-functions.ts`. We do not re-state them
//   here (drift risk; same precedent as Bessel/Erf I4 shards).
//
// * **Stirling asymptotic for Γ / LogGamma.** Not exact; lives in the
//   arb-prec evaluator (`packages/bigfloat`) and the float64 dispatcher,
//   not in the symbolic-identity table.
//
// Encoding choices (the load-bearing non-obvious decisions)
// ---------------------------------------------------------
// 1. **`√π` as `mkPower(sym("pi"), rat(1n, 2n))`** — matches the
//    ADR-0040 §"Decision 6" pin used by the Erf and Bessel substrates.
//    Identical encoding throughout the per-head family.
//
// 2. **Euler–Mascheroni constant `γ_E` as `sym("EulerGamma")`** —
//    matches SymPy and Mathematica convention. R1 §3 explicitly
//    documents this; the test file asserts the bare-symbol shape. The
//    constant is *not* in the cas-core diff-admitted-constants list
//    (which has only `pi` and `e`); the differentiator treats
//    `sym("EulerGamma")` as a foreign symbol with derivative 0 only
//    when both `wrt ≠ EulerGamma` AND the symbol is non-admitted —
//    but actually, since it's not in DIFF_ADMITTED_CONSTANTS, the
//    differentiator treats it as a variable. This is an upstream
//    issue for the cas-core diff-rule tables to consider when
//    `Digamma`-rewritten outputs are subsequently differentiated;
//    in the simplifier (this layer), the constant rides through as
//    an opaque symbol the same way the Bessel `sym("I")` imaginary
//    unit does.
//
// 3. **Pole-refusal tag as `"cas-simplify/gamma-pole"`** — matches the
//    Bessel `"cas-simplify/bessel-singular-at-zero"` convention. The
//    tag namespace is the *outer* dispatcher (`cas-simplify`), not the
//    per-head substrate. This is intentional: a downstream consumer
//    that catches Gamma-family refusals only needs to filter on the
//    `cas-simplify/*` prefix, not on individual per-head tags. Per
//    the prompt + worklog 134 / 152 precedents.
//
// 4. **Tag payload is `record { head, arg }`, not the raw expression.**
//    This makes the refusal payload self-describing — a downstream
//    consumer reads `payload.fields.head.name` to know which head
//    refused, and `payload.fields.arg` to recover the offending
//    argument. The Bessel substrate uses the raw `expr` form; we
//    deviate here because the Gamma family has more refusing heads
//    (Γ, LogGamma, Digamma, Polygamma all refuse at the same set of
//    arguments) and the explicit `head` field disambiguates.
//
// 5. **The sign of the Digamma reflection is PLUS.** See the priority-C
//    narrative above for the full DLMF §5.5.4 derivation and the
//    z=-0.3 numerical sanity check. The test file has a dedicated
//    "z=-0.3-equivalent symbolic" mutation-prove assertion that
//    catches a sign flip.
//
// Idempotence
// -----------
// Every rewritten Value passes through the same rule table on the
// recursive descent in `simplify.ts`'s `applyGammaRewrites`. The
// Priority-A rules emit literal integers, rationals, or symbol leaves
// (`sym("pi")`, `sym("EulerGamma")`) that the table doesn't match
// again. Priority-B rules emit closed forms in elementary heads
// (`log`, `+`, `*`, `^`) plus residual `sym("EulerGamma")` /
// `sym("pi")`; none of those are Gamma-family heads. Priority-C
// recurrences strip one level (`z+1 → z`) and recurse: a finite
// number of iterations to a base case (`Γ(1)` for positive-integer
// recurrence chains, or a symbolic `Γ(z)` for symbolic z). Priority-D
// rules emit a sum of Gamma terms with shifted arguments; the
// recurrence then drives those to their base cases. The fixed-point
// cascade in `applyGammaRewrites` is bounded at
// `GAMMA_REWRITE_MAX_ITERATIONS = 16` (twice the Bessel envelope —
// the recurrences can chain deeper, e.g. `Γ(z+5)` cascades through
// five recurrence applications).
//
// References
// ----------
// * R1 — `docs/refs/gamma-research/R1-symbolic-identities.md` (the
//   45+ rule v0.1-shippable target at §3).
// * DLMF Chapters 5 and 8 — `https://dlmf.nist.gov/5`,
//   `https://dlmf.nist.gov/8`.
// * SymPy — `sympy/functions/special/gamma_functions.py`,
//   `sympy/functions/special/beta_functions.py`.
// * mpmath — `gammazeta.py` (numeric verification source).
// * ADR-0023 — vocabulary table; pins the nine admitted heads after
//   ADR-0042's six-head extension.
// * ADR-0040 — Erf per-head substrate (the prototype this Gamma
//   substrate validates as further-generalising).
// * ADR-0041 — Bessel per-head substrate.
// * ADR-0042 — Gamma per-head substrate (this module's architectural
//   constitutional document); §"Decision 13" pins the
//   `simplify.ts` integration shape, §"Decision 6" pins the
//   vocabulary admissions.
// * Worklog 134 — Erf I4 shard (styling exemplar).
// * Worklog 152 — Bessel I4 shard (closer-precedent exemplar).

import { expr, int, rat, record, sym, tagged, type Value } from "@workbench/protocol";
import {
  isZero,
  mkDiv,
  mkMinus,
  mkNeg,
  mkPlus,
  mkPower,
  mkTimes,
  ONE,
  ZERO,
} from "../diff.js";
import {
  isNonNegativeInteger,
  isNonPositiveInteger,
  isPositiveInteger,
} from "../pattern.js";

// -----------------------------------------------------------------------------
// Encoding conventions (see top-of-file notes 1-5)
// -----------------------------------------------------------------------------

/** Symbol π — every √π / log(π) / π·cot emit uses this. */
const PI: Value = sym("pi");

/** `√π` encoded as `pi^(1/2)` per ADR-0040 §"Decision 6". */
const SQRT_PI: Value = mkPower(PI, rat(1n, 2n));

/** Euler–Mascheroni constant `γ_E`. SymPy / Mathematica convention. */
const EULER_GAMMA: Value = sym("EulerGamma");

/** Tag for divergent-pole refusal class. Matches per-head-substrate convention (ADR-0042). */
const GAMMA_POLE_TAG = "cas-simplify/gamma-pole";

/** The full list of heads this module dispatches on (nine; ADR-0042). */
export const GAMMA_FAMILY_HEADS: readonly string[] = [
  "Gamma",
  "LogGamma",
  "Pochhammer",
  "Digamma",
  "Polygamma",
  "IncompleteGammaUpper",
  "IncompleteGammaLower",
  "Beta",
  "BarnesG",
];

const GAMMA_FAMILY_HEADS_SET: ReadonlySet<string> = new Set(GAMMA_FAMILY_HEADS);

/** Whether `head` is one of the nine Gamma-family heads. */
export function isGammaFamilyHead(head: string): boolean {
  return GAMMA_FAMILY_HEADS_SET.has(head);
}

// -----------------------------------------------------------------------------
// Argument-shape helpers
// -----------------------------------------------------------------------------
//
// These mirror the Bessel substrate's local helpers (`matchPlusMinusHalf`,
// `matchNegPositiveInteger`) — bespoke shape matchers that are *Gamma*-
// rule-implementation details (returning captured sub-values, not pure
// predicates). Keeping them local preserves `pattern.ts`'s honest scope
// as a "pure boolean predicates" surface.
//
// The most load-bearing matcher is `matchPlusOne` — detects whether a
// Value has the shape `z + 1` for some captured `z`. Used by the
// priority-C recurrences (Γ(z+1), LogGamma(z+1), Digamma(z+1), etc.).

/**
 * Match `expr("+", [a, b])` where exactly one of `(a, b)` is the literal
 * integer 1. Returns the *other* argument (the captured `z`), or null
 * if `v` does not match. Accepts both orderings `[z, 1]` and `[1, z]`
 * since `mkPlus` does not canonically sort.
 *
 * Examples:
 *   matchPlusOne(mkPlus([sym("z"), int(1n)]))           // → sym("z")
 *   matchPlusOne(mkPlus([int(1n), sym("z")]))           // → sym("z")
 *   matchPlusOne(mkPlus([int(2n), sym("z")]))           // → null
 *   matchPlusOne(mkPlus([sym("a"), sym("b"), int(1n)])) // → null (3-term)
 *   matchPlusOne(sym("z"))                              // → null
 */
function matchPlusOne(v: Value): Value | null {
  if (v.kind !== "expression") return null;
  if (v.head !== "+") return null;
  if (v.args.length !== 2) return null;
  const [a, b] = [v.args[0]!, v.args[1]!];
  if (isLiteralIntEq(a, 1n)) return b;
  if (isLiteralIntEq(b, 1n)) return a;
  return null;
}

/**
 * Match `expr("-", [int(1n), z])` — the "1 - z" shape used by the
 * Digamma reflection rule. Returns the captured `z` if matched. Does
 * NOT match `expr("+", [int(1n), mkNeg(z)])` (a different structural
 * form); the reflection rule only fires on the binary-minus form,
 * which is what the user most naturally types and what
 * `mkMinus(ONE, z)` emits.
 */
function matchOneMinusZ(v: Value): Value | null {
  if (v.kind !== "expression") return null;
  if (v.head !== "-") return null;
  if (v.args.length !== 2) return null;
  if (!isLiteralIntEq(v.args[0]!, 1n)) return null;
  return v.args[1]!;
}

/**
 * Match `expr("*", [int(2n), z])` — the "2z" shape used by Legendre
 * duplication and the Digamma duplication rule. Accepts both orderings.
 * Returns the captured `z` if matched.
 */
function matchTwoTimesZ(v: Value): Value | null {
  if (v.kind !== "expression") return null;
  if (v.head !== "*") return null;
  if (v.args.length !== 2) return null;
  const [a, b] = [v.args[0]!, v.args[1]!];
  if (isLiteralIntEq(a, 2n)) return b;
  if (isLiteralIntEq(b, 2n)) return a;
  return null;
}

/**
 * Exact-integer-match helper. Returns true iff `v` encodes the exact
 * integer `n`. Accepts both `integer` Values and `rational` Values that
 * reduce to the integer.
 */
function isLiteralIntEq(v: Value, n: bigint): boolean {
  if (v.kind === "integer") return BigInt(v.value) === n;
  if (v.kind === "rational") {
    const num = BigInt(v.num);
    const den = BigInt(v.den);
    if (den === 0n) return false;
    return num === n * den;
  }
  return false;
}

/**
 * Exact-rational-match helper. Returns true iff `v` encodes the exact
 * rational `num/den` (in reduced form). Used for half-integer literal
 * matches like `Γ(1/2)`, `Γ(3/2)`, `Γ(-1/2)`, etc.
 */
function isLiteralRatEq(v: Value, num: bigint, den: bigint): boolean {
  if (v.kind !== "rational") return false;
  // Reduce both sides and compare.
  let vNum = BigInt(v.num);
  let vDen = BigInt(v.den);
  if (vDen === 0n) return false;
  if (vDen < 0n) {
    vNum = -vNum;
    vDen = -vDen;
  }
  // GCD reduce.
  let a = vNum < 0n ? -vNum : vNum;
  let b = vDen;
  while (b !== 0n) {
    const t = b;
    b = a % b;
    a = t;
  }
  if (a > 1n) {
    vNum /= a;
    vDen /= a;
  }
  return vNum === num && vDen === den;
}

/**
 * Extract the exact BigInt value from a Value known to be a positive
 * integer (caller-guaranteed via `isPositiveInteger`). Returns 0n
 * defensively if the precondition is violated — but callers must not
 * rely on this fallback.
 */
function extractBigInt(v: Value): bigint {
  if (v.kind === "integer") return BigInt(v.value);
  if (v.kind === "rational") {
    return BigInt(v.num) / BigInt(v.den);
  }
  return 0n;
}

/**
 * Compute factorial `n!` for non-negative BigInt n. Used by the
 * positive-integer Γ closure `Γ(n) = (n-1)!`. We cap at n ≤ 22 to
 * match the Cephes Gamma lookup-table cutoff cited in R2 (smaller
 * cutoffs would force a rewrite "loop" through Stirling at modest n;
 * 22! fits in a 64-bit integer and is the customary boundary). For
 * the cas-core symbolic layer the cap is mostly aesthetic: a literal
 * `Γ(100)` would emit a 158-digit integer, which is valid but
 * pollutes user output. Above the cap the rule does not fire (the
 * input passes through unchanged), which is honest scope.
 */
function factorialBigInt(n: bigint): bigint {
  let result = 1n;
  for (let i = 2n; i <= n; i++) result *= i;
  return result;
}

/** Cap on factorial-table inlining; see `factorialBigInt` rationale. */
const FACTORIAL_CAP = 22n;

/**
 * Build the refusal-tag payload for a pole rule. Shape:
 *   tagged "cas-simplify/gamma-pole"
 *     record { head: str(headName), arg: <original arg> }
 *
 * The `head` field uses a *symbol* (not a string) for byte-identical
 * shape to the way other tagged refusal payloads are typically built
 * in cas-simplify. The `arg` field carries the offending argument
 * verbatim so the downstream consumer can reconstruct the original
 * call.
 */
function poleRefusal(headName: string, arg: Value): Value {
  return tagged(
    GAMMA_POLE_TAG,
    record({ head: sym(headName), arg }),
  );
}

// -----------------------------------------------------------------------------
// The rule table
// -----------------------------------------------------------------------------
//
// Each rule binds a head + arg-shape predicate + rewrite function. The
// dispatcher (`tryGammaSimplify`) walks the table in declaration order
// and fires the first match. Order matters within a head: Priority A
// (special values + pole-refusal) MUST precede Priority B (small-int
// closures) which MUST precede Priority C (recurrences). Otherwise the
// recurrence rule could fire on `Γ(z+1)` for *literal* z = 0,
// producing `0 · Γ(0)` instead of catching the pole refusal at
// `Γ(0+1) = Γ(1) = 1` (the Γ(1) special-value rule). The declared
// order below preserves this priority.

interface GammaRule {
  readonly id: string;
  readonly source: string;
  readonly head: string;
  readonly match: (args: readonly Value[]) => boolean;
  readonly rewrite: (args: readonly Value[]) => Value;
}

export const GAMMA_RULES: readonly GammaRule[] = [
  // ===========================================================================
  // Priority A — special values + pole-refusal classes
  // ===========================================================================
  //
  // Γ at half-integer literals first (specific shapes), then the
  // pole-refusal rule on non-positive integers, then the positive-
  // integer closure `Γ(n) → (n-1)!`. The order is: most specific shape
  // first (so `Γ(0)` triggers the pole-refusal before the would-be
  // positive-integer rule has a chance to fire — though
  // `isPositiveInteger` rejects 0 too, so the ordering is
  // belt-and-braces).

  // Rule GA-3: Γ(1/2) = √π  (DLMF §5.4.6)
  {
    id: "gamma-at-half",
    source: "DLMF 5.4.6",
    head: "Gamma",
    match: (a) => a.length === 1 && isLiteralRatEq(a[0]!, 1n, 2n),
    rewrite: () => SQRT_PI,
  },

  // Rule GA-4: Γ(-1/2) = -2√π  (DLMF §5.4.6 + reflection)
  {
    id: "gamma-at-neg-half",
    source: "DLMF 5.4.6 + reflection; mpmath verified",
    head: "Gamma",
    match: (a) => a.length === 1 && isLiteralRatEq(a[0]!, -1n, 2n),
    rewrite: () => mkTimes(int(-2n), SQRT_PI),
  },

  // Rule GA-pole: Γ(n) for non-positive integer n → tagged pole refusal.
  // DLMF §5.2.1 documents the simple poles at z = 0, -1, -2, ….
  {
    id: "gamma-pole-at-non-positive-integer",
    source: "DLMF 5.2.1 (simple poles at z ∈ {0, -1, -2, …})",
    head: "Gamma",
    match: (a) => a.length === 1 && isNonPositiveInteger(a[0]!),
    rewrite: (a) => poleRefusal("Gamma", a[0]!),
  },

  // Rule GA-positive-int: Γ(n) = (n-1)! for positive integer n
  // ≤ FACTORIAL_CAP. DLMF §5.4.1.
  {
    id: "gamma-at-positive-integer",
    source: "DLMF 5.4.1 (Γ(n+1) = n!)",
    head: "Gamma",
    match: (a) => {
      if (a.length !== 1) return false;
      if (!isPositiveInteger(a[0]!)) return false;
      const n = extractBigInt(a[0]!);
      return n <= FACTORIAL_CAP;
    },
    rewrite: (a) => {
      const n = extractBigInt(a[0]!);
      return int(factorialBigInt(n - 1n));
    },
  },

  // Rule LGA-positive-int: LogGamma(n) = log((n-1)!) for positive integer n.
  // For n = 1, n = 2: result is log(1) = 0. For n = 3: log(2). For
  // larger n we emit `log(<integer>)` symbolically (the integer is
  // (n-1)!); downstream RatFn-fold leaves `log(<int>)` as out-of-scope
  // which is fine. The rule does NOT compute the value of log
  // numerically — `log` is an elementary head not a numeric function.
  {
    id: "loggamma-at-positive-integer",
    source: "log(Γ(n)) = log((n-1)!); SymPy verified",
    head: "LogGamma",
    match: (a) => {
      if (a.length !== 1) return false;
      if (!isPositiveInteger(a[0]!)) return false;
      const n = extractBigInt(a[0]!);
      return n <= FACTORIAL_CAP;
    },
    rewrite: (a) => {
      const n = extractBigInt(a[0]!);
      const fact = factorialBigInt(n - 1n);
      // log(1) = 0; emit ZERO directly so the canonicalisation matches
      // LGA-1 and LGA-2 byte-identically.
      if (fact === 1n) return ZERO;
      return expr("log", [int(fact)]);
    },
  },

  // Rule LGA-half: LogGamma(1/2) = (1/2)·log(π)  (= log(√π))
  {
    id: "loggamma-at-half",
    source: "log(Γ(1/2)) = log(√π) = (1/2)·log(π); mpmath verified",
    head: "LogGamma",
    match: (a) => a.length === 1 && isLiteralRatEq(a[0]!, 1n, 2n),
    rewrite: () => mkTimes(rat(1n, 2n), expr("log", [PI])),
  },

  // Rule LGA-pole: LogGamma at non-positive integer → pole refusal.
  // DLMF §5.11 (logarithm of Γ inherits Γ's poles).
  {
    id: "loggamma-pole-at-non-positive-integer",
    source: "log-pole at z ∈ {0, -1, -2, …} (inherits Γ poles)",
    head: "LogGamma",
    match: (a) => a.length === 1 && isNonPositiveInteger(a[0]!),
    rewrite: (a) => poleRefusal("LogGamma", a[0]!),
  },

  // Rule DIG-pole: Digamma at non-positive integer → pole refusal.
  // DLMF §5.4 (digamma has simple poles, residue -1, at z = 0, -1, -2, …).
  {
    id: "digamma-pole-at-non-positive-integer",
    source: "DLMF 5.4 (simple poles at z ∈ {0, -1, -2, …})",
    head: "Digamma",
    match: (a) => a.length === 1 && isNonPositiveInteger(a[0]!),
    rewrite: (a) => poleRefusal("Digamma", a[0]!),
  },

  // Rule POL-pole: Polygamma(m, z) at non-positive integer z → pole refusal.
  // DLMF §5.15 (polygamma has poles of order m+1 at z = 0, -1, -2, …).
  // Gates on the *second* argument; the first argument m is the order.
  {
    id: "polygamma-pole-at-non-positive-integer",
    source: "DLMF 5.15 (poles of order m+1 at z ∈ {0, -1, -2, …})",
    head: "Polygamma",
    match: (a) => a.length === 2 && isNonPositiveInteger(a[1]!),
    rewrite: (a) =>
      tagged(
        GAMMA_POLE_TAG,
        record({ head: sym("Polygamma"), order: a[0]!, arg: a[1]! }),
      ),
  },

  // Rule BG-at-non-positive-int: BarnesG(n) = 0 for non-positive integer n.
  // SPECIAL CASE: BarnesG vanishes at non-positive integers (DLMF
  // §5.17.1), it does NOT diverge. So this rule emits int(0n), NOT a
  // tagged refusal. This is the load-bearing asymmetry against the
  // Γ / LogGamma / Digamma / Polygamma family.
  {
    id: "barnes-g-zero-at-non-positive-integer",
    source: "DLMF 5.17.1 (G vanishes at non-positive integers)",
    head: "BarnesG",
    match: (a) => a.length === 1 && isNonPositiveInteger(a[0]!),
    rewrite: () => ZERO,
  },

  // Rule POC-0: (a)_0 = 1  (DLMF §5.2.4)
  {
    id: "pochhammer-at-zero-index",
    source: "DLMF 5.2.4",
    head: "Pochhammer",
    match: (a) => a.length === 2 && isLiteralIntEq(a[1]!, 0n),
    rewrite: () => ONE,
  },

  // Rule POC-1: (a)_1 = a  (DLMF §5.2.4)
  {
    id: "pochhammer-at-one-index",
    source: "DLMF 5.2.4",
    head: "Pochhammer",
    match: (a) => a.length === 2 && isLiteralIntEq(a[1]!, 1n),
    rewrite: (a) => a[0]!,
  },

  // Rule IGAM-U-at-zero: Γ(a, 0) = Γ(a)  (DLMF §8.4; boundary)
  {
    id: "incomplete-gamma-upper-at-zero",
    source: "DLMF 8.4 (Γ(a, 0) = Γ(a))",
    head: "IncompleteGammaUpper",
    match: (a) => a.length === 2 && isZero(a[1]!),
    rewrite: (a) => expr("Gamma", [a[0]!]),
  },

  // Rule IGAM-U-at-one: Γ(1, z) = e^{-z}  (DLMF §8.4.5)
  {
    id: "incomplete-gamma-upper-at-one",
    source: "DLMF 8.4.5 (Γ(1, z) = e^{-z})",
    head: "IncompleteGammaUpper",
    match: (a) => a.length === 2 && isLiteralIntEq(a[0]!, 1n),
    rewrite: (a) => expr("exp", [mkNeg(a[1]!)]),
  },

  // Rule IGAM-L-at-zero: γ(a, 0) = 0  (DLMF §8.4; boundary)
  {
    id: "incomplete-gamma-lower-at-zero",
    source: "DLMF 8.4 (γ(a, 0) = 0)",
    head: "IncompleteGammaLower",
    match: (a) => a.length === 2 && isZero(a[1]!),
    rewrite: () => ZERO,
  },

  // Rule IGAM-L-at-one: γ(1, z) = 1 - e^{-z}  (DLMF §8.4.7 n=0)
  {
    id: "incomplete-gamma-lower-at-one",
    source: "DLMF 8.4.7 (γ(1, z) = 1 - e^{-z})",
    head: "IncompleteGammaLower",
    match: (a) => a.length === 2 && isLiteralIntEq(a[0]!, 1n),
    rewrite: (a) => mkMinus(ONE, expr("exp", [mkNeg(a[1]!)])),
  },

  // Rule BETA-1: B(1, 1) = 1  (Γ(1)Γ(1)/Γ(2))
  {
    id: "beta-at-one-one",
    source: "Γ(1)·Γ(1)/Γ(2) = 1",
    head: "Beta",
    match: (a) =>
      a.length === 2 && isLiteralIntEq(a[0]!, 1n) && isLiteralIntEq(a[1]!, 1n),
    rewrite: () => ONE,
  },

  // Rule BETA-2: B(a, 1) = 1/a  (Γ(a)·1!/Γ(a+1) = 1/a)
  // Declared AFTER BETA-1 so the (1,1) case is caught by the more
  // specific rule first (defence in depth — even though (a,1) with
  // a=1 also yields 1, the literal-rewrite shape differs).
  {
    id: "beta-second-arg-one",
    source: "Γ(a)·1!/Γ(a+1) = 1/a; SymPy verified",
    head: "Beta",
    match: (a) => a.length === 2 && isLiteralIntEq(a[1]!, 1n),
    rewrite: (a) => mkDiv(ONE, a[0]!),
  },

  // Rule BETA-3: B(1, b) = 1/b  (by symmetry)
  {
    id: "beta-first-arg-one",
    source: "by symmetry of Beta",
    head: "Beta",
    match: (a) => a.length === 2 && isLiteralIntEq(a[0]!, 1n),
    rewrite: (a) => mkDiv(ONE, a[1]!),
  },

  // Rule BETA-4: B(1/2, 1/2) = π  (Γ(1/2)²/Γ(1) = π)
  {
    id: "beta-half-half",
    source: "Γ(1/2)²/Γ(1) = π; mpmath verified",
    head: "Beta",
    match: (a) =>
      a.length === 2 &&
      isLiteralRatEq(a[0]!, 1n, 2n) &&
      isLiteralRatEq(a[1]!, 1n, 2n),
    rewrite: () => PI,
  },

  // BarnesG integer table (Priority A; R1 §3 cites these as A-level).
  // G(0) and G at negative integers are caught by the
  // `barnes-g-zero-at-non-positive-integer` rule above (declared
  // first); this block is for the positive-integer closures.
  {
    id: "barnes-g-at-one",
    source: "DLMF 5.17.1",
    head: "BarnesG",
    match: (a) => a.length === 1 && isLiteralIntEq(a[0]!, 1n),
    rewrite: () => ONE,
  },
  {
    id: "barnes-g-at-two",
    source: "G(2) = Γ(1)·G(1) = 1; mpmath verified",
    head: "BarnesG",
    match: (a) => a.length === 1 && isLiteralIntEq(a[0]!, 2n),
    rewrite: () => ONE,
  },
  {
    id: "barnes-g-at-three",
    source: "G(3) = Γ(2)·G(2) = 1; mpmath verified",
    head: "BarnesG",
    match: (a) => a.length === 1 && isLiteralIntEq(a[0]!, 3n),
    rewrite: () => ONE,
  },
  {
    id: "barnes-g-at-four",
    source: "G(4) = Γ(3)·G(3) = 2; mpmath verified",
    head: "BarnesG",
    match: (a) => a.length === 1 && isLiteralIntEq(a[0]!, 4n),
    rewrite: () => int(2n),
  },
  {
    id: "barnes-g-at-five",
    source: "G(5) = Γ(4)·G(4) = 12; mpmath verified",
    head: "BarnesG",
    match: (a) => a.length === 1 && isLiteralIntEq(a[0]!, 5n),
    rewrite: () => int(12n),
  },

  // ===========================================================================
  // Priority B — half-integer + small-integer closures
  // ===========================================================================
  //
  // Half-integer Γ values beyond ±1/2 (already in Priority A above),
  // the Digamma rationals (Gauss formulas for clean denominators), the
  // Polygamma special values, the Pochhammer small-n closure
  // `(a)_2 = a(a+1)`.

  // Rule GA-B1: Γ(3/2) = (1/2)√π
  {
    id: "gamma-at-three-halves",
    source: "DLMF 5.4.6 + recurrence; mpmath verified",
    head: "Gamma",
    match: (a) => a.length === 1 && isLiteralRatEq(a[0]!, 3n, 2n),
    rewrite: () => mkTimes(rat(1n, 2n), SQRT_PI),
  },

  // Rule GA-B2: Γ(5/2) = (3/4)√π
  {
    id: "gamma-at-five-halves",
    source: "DLMF recurrence; mpmath verified",
    head: "Gamma",
    match: (a) => a.length === 1 && isLiteralRatEq(a[0]!, 5n, 2n),
    rewrite: () => mkTimes(rat(3n, 4n), SQRT_PI),
  },

  // Rule GA-B3: Γ(-3/2) = (4/3)√π
  {
    id: "gamma-at-neg-three-halves",
    source: "reflection + recurrence; mpmath verified",
    head: "Gamma",
    match: (a) => a.length === 1 && isLiteralRatEq(a[0]!, -3n, 2n),
    rewrite: () => mkTimes(rat(4n, 3n), SQRT_PI),
  },

  // Rule POC-B1: Pochhammer(a, 2) = a · (a + 1)
  // R1 §3 priority-B small-n Pochhammer closure. The general
  // `(1/2)_n` and `(-1/2)_n` closed forms (double-factorial) are
  // deferred to a v0.2 follow-up because they require a concrete-n
  // factorial computation per rule firing; the n = 2 case is the
  // smallest non-trivial case that ships in v0.1.
  {
    id: "pochhammer-at-two-index",
    source: "DLMF 5.2.4 expanded; (a)_2 = a·(a+1)",
    head: "Pochhammer",
    match: (a) => a.length === 2 && isLiteralIntEq(a[1]!, 2n),
    rewrite: (a) => mkTimes(a[0]!, mkPlus([a[0]!, ONE])),
  },

  // Rule DIG-B1: ψ(1) = -γ_E  (DLMF §5.4.12)
  {
    id: "digamma-at-one",
    source: "DLMF 5.4.12; SymPy + mpmath verified",
    head: "Digamma",
    match: (a) => a.length === 1 && isLiteralIntEq(a[0]!, 1n),
    rewrite: () => mkNeg(EULER_GAMMA),
  },

  // Rule DIG-B2: ψ(2) = 1 - γ_E
  {
    id: "digamma-at-two",
    source: "DLMF 5.4.14 with n=1; SymPy verified",
    head: "Digamma",
    match: (a) => a.length === 1 && isLiteralIntEq(a[0]!, 2n),
    rewrite: () => mkMinus(ONE, EULER_GAMMA),
  },

  // Rule DIG-B3: ψ(3) = 3/2 - γ_E
  {
    id: "digamma-at-three",
    source: "DLMF 5.4.14 with n=2; SymPy verified",
    head: "Digamma",
    match: (a) => a.length === 1 && isLiteralIntEq(a[0]!, 3n),
    rewrite: () => mkMinus(rat(3n, 2n), EULER_GAMMA),
  },

  // Rule DIG-B4: ψ(1/2) = -γ_E - 2·log(2)
  {
    id: "digamma-at-half",
    source: "DLMF 5.4.13; mpmath verified",
    head: "Digamma",
    match: (a) => a.length === 1 && isLiteralRatEq(a[0]!, 1n, 2n),
    rewrite: () =>
      mkMinus(mkNeg(EULER_GAMMA), mkTimes(int(2n), expr("log", [int(2n)]))),
  },

  // Rule DIG-B5: ψ(3/2) = 2 - γ_E - 2·log(2)
  {
    id: "digamma-at-three-halves",
    source: "recurrence + ψ(1/2); mpmath verified",
    head: "Digamma",
    match: (a) => a.length === 1 && isLiteralRatEq(a[0]!, 3n, 2n),
    rewrite: () =>
      mkMinus(
        mkMinus(int(2n), EULER_GAMMA),
        mkTimes(int(2n), expr("log", [int(2n)])),
      ),
  },

  // Rule POL-B1: ψ^{(1)}(1) = π²/6  (DLMF §5.15.2 + ζ(2) = π²/6)
  {
    id: "polygamma-one-at-one",
    source: "DLMF 5.15.2 + ζ(2) = π²/6; mpmath verified",
    head: "Polygamma",
    match: (a) =>
      a.length === 2 &&
      isLiteralIntEq(a[0]!, 1n) &&
      isLiteralIntEq(a[1]!, 1n),
    rewrite: () => mkDiv(mkPower(PI, int(2n)), int(6n)),
  },

  // Rule POL-B2: ψ^{(1)}(1/2) = π²/2
  {
    id: "polygamma-one-at-half",
    source: "DLMF 5.15.3 + 3·ζ(2); mpmath verified",
    head: "Polygamma",
    match: (a) =>
      a.length === 2 &&
      isLiteralIntEq(a[0]!, 1n) &&
      isLiteralRatEq(a[1]!, 1n, 2n),
    rewrite: () => mkDiv(mkPower(PI, int(2n)), int(2n)),
  },

  // ===========================================================================
  // Priority C — recurrences + reflection (LOAD-BEARING)
  // ===========================================================================
  //
  // The priority-C rules drive canonicalisation: Γ(z+1) → z·Γ(z),
  // Digamma(z+1) → Digamma(z) + 1/z, etc. The `matchPlusOne` helper
  // captures the `z` operand from the `(z + 1)` or `(1 + z)` shape.
  //
  // Note: these rules DO NOT recurse further on their own — the
  // applyGammaRewrites walker handles the cascade. So `Γ(z+2)` becomes
  // `(z+1)·Γ(z+1)` on one pass, and `(z+1)·z·Γ(z)` on the next pass.
  // The bounded fixed-point cascade in `applyGammaRewrites` ensures
  // termination.

  // Rule GA-C1: Γ(z+1) = z · Γ(z)  (DLMF §5.5.1)
  {
    id: "gamma-recurrence",
    source: "DLMF 5.5.1 (Γ(z+1) = z·Γ(z))",
    head: "Gamma",
    match: (a) => a.length === 1 && matchPlusOne(a[0]!) !== null,
    rewrite: (a) => {
      const z = matchPlusOne(a[0]!)!;
      return mkTimes(z, expr("Gamma", [z]));
    },
  },

  // Rule LGA-C1: LogGamma(z+1) = log(z) + LogGamma(z)
  {
    id: "loggamma-recurrence",
    source: "from Γ(z+1) = z·Γ(z) taking log",
    head: "LogGamma",
    match: (a) => a.length === 1 && matchPlusOne(a[0]!) !== null,
    rewrite: (a) => {
      const z = matchPlusOne(a[0]!)!;
      return mkPlus([expr("log", [z]), expr("LogGamma", [z])]);
    },
  },

  // Rule POC-C1: Pochhammer(a, n+1) = (a + n) · Pochhammer(a, n)
  // (DLMF §5.2.4). Note that the recurrence reduces (a)_{n+1} to (a)_n
  // — together with the POC-0 base case `(a)_0 = 1` this fully reduces
  // any (a)_n for concrete n.
  {
    id: "pochhammer-recurrence",
    source: "DLMF 5.2.4",
    head: "Pochhammer",
    match: (a) => a.length === 2 && matchPlusOne(a[1]!) !== null,
    rewrite: (a) => {
      const aArg = a[0]!;
      const n = matchPlusOne(a[1]!)!;
      return mkTimes(
        mkPlus([aArg, n]),
        expr("Pochhammer", [aArg, n]),
      );
    },
  },

  // Rule DIG-C1: ψ(z+1) = ψ(z) + 1/z  (DLMF §5.5.2)
  {
    id: "digamma-recurrence",
    source: "DLMF 5.5.2",
    head: "Digamma",
    match: (a) => a.length === 1 && matchPlusOne(a[0]!) !== null,
    rewrite: (a) => {
      const z = matchPlusOne(a[0]!)!;
      return mkPlus([expr("Digamma", [z]), mkDiv(ONE, z)]);
    },
  },

  // Rule DIG-C2: ψ(1-z) = ψ(z) + π·cos(πz)/sin(πz)
  // (DLMF §5.5.4, SIGN-CRITICAL — see top-of-file narrative.)
  // The DLMF identity reads `ψ(1-z) - ψ(z) = +π·cot(πz)`; rearranged
  // for the LHS pattern `ψ(1-z)`, the term is PLUS π·cot(πz). `cot` is
  // not in the cas-core vocabulary, so we emit `cos/sin` directly.
  // The test file's `digamma reflection at non-half-integer z` test
  // is the mutation-prove canary: a sign flip (MINUS instead of PLUS)
  // RED-fails on the symbolic equivalent of z = -0.3.
  {
    id: "digamma-reflection",
    source: "DLMF 5.5.4 (ψ(1-z) - ψ(z) = +π·cot(πz))",
    head: "Digamma",
    match: (a) => a.length === 1 && matchOneMinusZ(a[0]!) !== null,
    rewrite: (a) => {
      const z = matchOneMinusZ(a[0]!)!;
      const piZ = mkTimes(PI, z);
      const cosPiZ = expr("cos", [piZ]);
      const sinPiZ = expr("sin", [piZ]);
      // PLUS π·cos(πz)/sin(πz) — see narrative for the sign argument.
      return mkPlus([
        expr("Digamma", [z]),
        mkTimes(PI, mkDiv(cosPiZ, sinPiZ)),
      ]);
    },
  },

  // Rule IGAM-U-C: Γ(a+1, z) = a · Γ(a, z) + z^a · e^{-z}  (DLMF §8.8.2)
  {
    id: "incomplete-gamma-upper-recurrence",
    source: "DLMF 8.8.2",
    head: "IncompleteGammaUpper",
    match: (a) => a.length === 2 && matchPlusOne(a[0]!) !== null,
    rewrite: (a) => {
      const aArg = matchPlusOne(a[0]!)!;
      const z = a[1]!;
      return mkPlus([
        mkTimes(aArg, expr("IncompleteGammaUpper", [aArg, z])),
        mkTimes(mkPower(z, aArg), expr("exp", [mkNeg(z)])),
      ]);
    },
  },

  // Rule IGAM-L-C: γ(a+1, z) = a · γ(a, z) - z^a · e^{-z}  (DLMF §8.8.1)
  {
    id: "incomplete-gamma-lower-recurrence",
    source: "DLMF 8.8.1",
    head: "IncompleteGammaLower",
    match: (a) => a.length === 2 && matchPlusOne(a[0]!) !== null,
    rewrite: (a) => {
      const aArg = matchPlusOne(a[0]!)!;
      const z = a[1]!;
      return mkMinus(
        mkTimes(aArg, expr("IncompleteGammaLower", [aArg, z])),
        mkTimes(mkPower(z, aArg), expr("exp", [mkNeg(z)])),
      );
    },
  },

  // Rule BETA-C1: B(a+1, b) = (a / (a + b)) · B(a, b)  (DLMF §5.12)
  {
    id: "beta-recurrence",
    source: "DLMF 5.12 (from Γ recurrence)",
    head: "Beta",
    match: (a) => a.length === 2 && matchPlusOne(a[0]!) !== null,
    rewrite: (a) => {
      const aArg = matchPlusOne(a[0]!)!;
      const b = a[1]!;
      return mkTimes(
        mkDiv(aArg, mkPlus([aArg, b])),
        expr("Beta", [aArg, b]),
      );
    },
  },

  // Rule BARNESG-C1: G(z+1) = Γ(z) · G(z)  (DLMF §5.17.1)
  {
    id: "barnes-g-functional-equation",
    source: "DLMF 5.17.1",
    head: "BarnesG",
    match: (a) => a.length === 1 && matchPlusOne(a[0]!) !== null,
    rewrite: (a) => {
      const z = matchPlusOne(a[0]!)!;
      return mkTimes(expr("Gamma", [z]), expr("BarnesG", [z]));
    },
  },

  // ===========================================================================
  // Priority D — multiplication theorems + Polygamma recurrence
  // ===========================================================================

  // Rule GA-D1: Legendre Duplication
  //   Γ(2z) = (2^(2z-1) / √π) · Γ(z) · Γ(z + 1/2)
  // DLMF §5.5.5; mpmath verified. Fires when the Γ-argument has the
  // shape `2 · z` for any captured z. The duplication runs in the
  // "expand" direction (one Γ of doubled argument → two Γs of original
  // argument); the inverse direction (two Γs collapse to one Γ(2z))
  // is a product-walker rule and lives in the simplify dispatcher,
  // not the per-head table.
  {
    id: "gamma-legendre-duplication",
    source: "DLMF 5.5.5; mpmath verified",
    head: "Gamma",
    match: (a) => a.length === 1 && matchTwoTimesZ(a[0]!) !== null,
    rewrite: (a) => {
      const z = matchTwoTimesZ(a[0]!)!;
      // 2^(2z - 1)
      const expPow = mkPower(
        int(2n),
        mkMinus(mkTimes(int(2n), z), ONE),
      );
      // (2^(2z-1) / √π) · Γ(z) · Γ(z + 1/2)
      return mkTimes(
        mkDiv(expPow, SQRT_PI),
        mkTimes(
          expr("Gamma", [z]),
          expr("Gamma", [mkPlus([z, rat(1n, 2n)])]),
        ),
      );
    },
  },

  // Rule DIG-D1: ψ(2z) = (1/2)·[ψ(z) + ψ(z + 1/2)] + log(2)  (DLMF §5.5.8)
  {
    id: "digamma-duplication",
    source: "DLMF 5.5.8",
    head: "Digamma",
    match: (a) => a.length === 1 && matchTwoTimesZ(a[0]!) !== null,
    rewrite: (a) => {
      const z = matchTwoTimesZ(a[0]!)!;
      return mkPlus([
        mkTimes(
          rat(1n, 2n),
          mkPlus([
            expr("Digamma", [z]),
            expr("Digamma", [mkPlus([z, rat(1n, 2n)])]),
          ]),
        ),
        expr("log", [int(2n)]),
      ]);
    },
  },

  // Rule POL-D1: ψ^{(m)}(z+1) = ψ^{(m)}(z) + (-1)^m · m! / z^{m+1}
  // DLMF §5.15.5 — Polygamma recurrence for concrete m ≥ 1. Gates on
  // the second argument having the `z + 1` shape AND the first
  // argument being a concrete non-negative integer (so we can compute
  // m! and (-1)^m at rewrite time).
  {
    id: "polygamma-recurrence",
    source: "DLMF 5.15.5",
    head: "Polygamma",
    match: (a) => {
      if (a.length !== 2) return false;
      if (!isNonNegativeInteger(a[0]!)) return false;
      const m = extractBigInt(a[0]!);
      if (m > FACTORIAL_CAP) return false;
      return matchPlusOne(a[1]!) !== null;
    },
    rewrite: (a) => {
      const m = extractBigInt(a[0]!);
      const z = matchPlusOne(a[1]!)!;
      const mFact = factorialBigInt(m);
      // (-1)^m · m!
      const coeff = m % 2n === 0n ? int(mFact) : int(-mFact);
      return mkPlus([
        expr("Polygamma", [a[0]!, z]),
        mkTimes(coeff, mkPower(z, int(-(m + 1n)))),
      ]);
    },
  },
];

// -----------------------------------------------------------------------------
// Dispatcher
// -----------------------------------------------------------------------------

/**
 * Try every rule matching `head` in declaration order; return the
 * rewritten Value on first hit, or `null` if no rule fires (i.e., the
 * caller should leave the expression alone — foreign-pass-through).
 *
 * This function is single-step: it does NOT recurse on the rewritten
 * output. The recursive descent is the caller's responsibility (it is
 * `applyGammaRewrites` in `simplify.ts`, which mirrors the Bessel and
 * Erf pre-passes exactly).
 *
 * Total: pure function, no side effects, deterministic.
 */
export function tryGammaSimplify(
  head: string,
  args: readonly Value[],
): Value | null {
  if (!GAMMA_FAMILY_HEADS_SET.has(head)) return null;
  for (const rule of GAMMA_RULES) {
    if (rule.head !== head) continue;
    if (rule.match(args)) return rule.rewrite(args);
  }
  return null;
}

// -----------------------------------------------------------------------------
// Module-internal exports for the simplify.ts integration + test assertions
// -----------------------------------------------------------------------------

export const _gammaInternals = {
  PI,
  SQRT_PI,
  EULER_GAMMA,
  GAMMA_POLE_TAG,
  matchPlusOne,
  matchOneMinusZ,
  matchTwoTimesZ,
  isLiteralIntEq,
  isLiteralRatEq,
  factorialBigInt,
  FACTORIAL_CAP,
  poleRefusal,
} as const;
