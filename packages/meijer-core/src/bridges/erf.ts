// =============================================================================
// bridges/erf.ts — bidirectional head ↔ Meijer-G bridge for the Erf family
// =============================================================================
//
// Purpose
// -------
// Per ADR-0040 §"Decision 5" and R4 §1–§3 (`docs/refs/erf-research/R4-
// meijer-g-bridge.md`), this module pins the canonical bidirectional
// bridge between the Erf-family heads (`Erf`, `Erfc`, `Erfi`, and the
// honestly-refused inverses `InverseErf`, `InverseErfc`) and the Meijer
// G-function on the wire.
//
//   * `headToMeijerG(head, args)` — forward bridge. Given a head name and
//     its argument list, returns a `ForwardBridge` (G-form + prefactor
//     `wrap` + `zInverse` closure) on success, or `null` when the head is
//     out-of-scope (either honestly-refused like `InverseErf` / `InverseErfc`,
//     or simply not in this bridge module's scope).
//
//   * `meijerGToHead(form, prefactor?)` — backward bridge. Pattern-matches
//     a `MeijerGForm` against the canonical Erf-family G-forms; on hit,
//     returns `{ head, args }` byte-identically (via the inverse-z trick
//     described in `types.ts`). Returns `null` when no rule matches —
//     this IS the correct refusal contract (ADR-0003 boundary failure;
//     the caller falls back to a different bridge or to the numerical
//     evaluator).
//
// Canonical G-form table (R4 §1)
// ------------------------------
// Wolfram convention `MeijerG[{{a_top},{a_bot}}, {{b_top},{b_bot}}, z]`,
// with `(m, n, p, q)` derived from sub-tuple lengths:
//
//   | Head      | (m,n,p,q) | an    | ap  | bm        | bq      | z-sub | prefactor |
//   |-----------|-----------|-------|-----|-----------|---------|-------|-----------|
//   | Erf(z)    | (1,1,1,2) | [1/2] | []  | [0]       | [-1/2]  | z²    | z/√π      |
//   | Erfc(z)   | (2,0,1,2) | []    | [1] | [0, 1/2]  | []      | z²    | 1/√π      |
//   | Erfi(z)   | (1,1,1,2) | [1/2] | []  | [0]       | [-1/2]  | -z²   | z/√π      |
//   | Erf⁻¹     | NONE — DLMF §7.17 power-series-only; no closed Meijer-G form     |
//   | Erfc⁻¹    | NONE — same                                                       |
//
// Cross-validated against SymPy `erf._eval_rewrite_as_meijerg`, diofant
// g-functions table, mpmath docs, and the Adamchik–Marichev / PBM Vol 3
// §8.4 lineage. The Wolfram Functions Site PDFs were HTTP-403 from this
// harness; the triangulation through three independent open-source CASes
// pins the table.
//
// Encoding conventions — MUST match cas-core/src/special-funcs/erf-identities.ts
// ----------------------------------------------------------------------------
//   * `√π` is `mkPower(sym("pi"), rat(1n, 2n))` — ADR-0040 §"Decision 6"
//     pin used by `ruleErfi` and by I4's Erf identity table. The bridge
//     uses the same encoding so the simplify ↔ bridge round-trip is
//     byte-identical after canonicalisation.
//   * The imaginary unit `i` is `sym("I")`. This module does NOT emit `i`
//     directly (Erf, Erfc, Erfi all live on the real axis in the bridge's
//     canonical-args case), but the convention is documented here for the
//     downstream `cas-simplify` ↔ bridge composition (Erfi(z) = −i · Erf(iz)
//     per A3; if `cas-simplify` rewrites Erfi via A3 and the user then
//     bridges, the rewritten form's `i` must be the same encoding).
//
// The `zInverse` closure trick (R4 §3, ADR-0040 §"Why `zInverse`")
// ----------------------------------------------------------------
// For Erf and Erfi the z-substitution is `z → ±z²` (the sign distinguishing
// the two heads). The naïve backward bridge would compute `√(g.z)` to
// recover `z`, but `√(z²) = |z|` over ℝ and is multi-valued over ℂ. A
// round-trip `headToMeijerG("Erf", [-1])` → `meijerGToHead(...)` would
// hand back `Erf(1)`, not `Erf(-1)` — the bridge would silently corrupt
// the sign.
//
// The fix is to record the original `args` in a closure on the
// `ForwardBridge` record. The backward bridge that the *forward bridge
// produced* recovers the args via `zInverse()`, byte-identically, without
// computing any square root. For backward calls on G-forms NOT produced
// by this bridge's forward (e.g. a user-constructed G), the backward
// matcher reconstructs the args from the G-form's `z`-slot directly:
//   * Erf / Erfc: args = [√(z)] (formally — we emit `mkPower(z, rat(1, 2))`
//     and let the caller's `cas-simplify` reduce it where possible).
//   * Erfi: args = [√(−z)] (we strip a leading unary `neg` from `z` if
//     present and emit `mkPower(stripped, rat(1, 2))`; if not present we
//     wrap as `mkPower(mkNeg(z), rat(1, 2))`).
//
// The honest contract this gives is:
//   * Round-trips through this module's own `headToMeijerG`: byte-identical
//     (proven in `test/bridges-erf.test.ts`).
//   * Backward calls on user-constructed G-forms: honest AST emission that
//     `cas-simplify` may or may not simplify further; the bridge does not
//     pretend to know the un-substituted argument that produced an
//     arbitrary `g.z`.
//
// Erf vs Erfi disambiguation
// --------------------------
// Erf and Erfi share an identical parameter tuple `(an, ap, bm, bq) =
// ([1/2], [], [0], [-1/2])`; only the z-substitution sign distinguishes
// them. The standalone `meijerGToHead(form)` therefore needs to inspect
// the z-slot's sign:
//
//   * `+u²`-shaped z (positive square, or any non-`neg`-headed Value):
//     emit `Erf`.
//   * `−u²`-shaped z (explicitly `expr("neg", [...])` or `expr("-",
//     [single])` wrapped): emit `Erfi`.
//
// The dispatcher's per-rule files (`erf-forward-form-a.ts`,
// `erfi-forward.ts`) use the parallel `PatternSpec.zMatch` extension
// shipped in this iteration to apply the same discrimination at the
// dispatch level.
//
// References
// ----------
//   * ADR-0040 — per-head special-function substrate; §"Decision 5" pins
//     the bridge API; §"Decision 6" pins the `√π` and `Erfi` conventions.
//   * R4 — `docs/refs/erf-research/R4-meijer-g-bridge.md`; §1 canonical
//     table, §2 backward matcher signatures, §3 API proposal, §5
//     pattern-matcher subtleties.
//   * `packages/cas-core/src/special-funcs/erf-identities.ts` — I4's
//     identity table; the encoding conventions here cross-reference.
//   * SymPy `error_functions.py::erf._eval_rewrite_as_meijerg` —
//     cross-validation source (per ADR-0025 §9 audit, used only for
//     research validation, never as a porting source).

import { rat, sym, type Value } from "@workbench/protocol";
import {
  mkDiv,
  mkNeg,
  mkPower,
  mkTimes,
} from "@workbench/cas-core";
import type { ForwardBridge, MeijerGForm } from "./types.js";

// -----------------------------------------------------------------------------
// Encoding helpers
// -----------------------------------------------------------------------------
//
// Builders for the literals the canonical G-forms use. Kept local (not
// re-exported) so the module's encoding choices stay byte-identical with
// the I4 identity table without spreading the convention across the
// package's public surface.

const SQRT_PI: Value = mkPower(sym("pi"), rat(1n, 2n));
const HALF: Value = rat(1n, 2n);
const NEG_HALF: Value = rat(-1n, 2n);
const ZERO_INT: Value = { kind: "integer", value: "0" };
const ONE_INT: Value = { kind: "integer", value: "1" };
const TWO_INT: Value = { kind: "integer", value: "2" };

/** `z²` as `mkPower(z, 2)`. Used for the Erf / Erfc z-substitution. */
function zSquared(z: Value): Value {
  return mkPower(z, TWO_INT);
}

/** `−z²` as `mkNeg(mkPower(z, 2))`. Used for the Erfi z-substitution. */
function negZSquared(z: Value): Value {
  return mkNeg(zSquared(z));
}

// -----------------------------------------------------------------------------
// Forward bridge
// -----------------------------------------------------------------------------

/**
 * Forward bridge: head name + arguments → canonical Meijer-G form.
 *
 * Returns:
 *   * `ForwardBridge` on success (Erf, Erfc, Erfi with a single argument).
 *   * `null` for the honestly-refused inverses (`InverseErf`, `InverseErfc`) —
 *     no Meijer-G representation exists for these per DLMF §7.17 (the
 *     inverses have only power-series and asymptotic-expansion forms; no
 *     closed Mellin-Barnes integrand). The caller routes to the DLMF
 *     7.17.2 power-series numerical evaluator (or `tools/special-eval`'s
 *     `tagged "special-eval/no-known-representation"`).
 *   * `null` for any head not in this bridge module's scope — the caller
 *     can try the next bridge (when more land) or fall back.
 *
 * Argument-arity check: the three bridged heads all take exactly one
 * argument. Any other arity returns `null` (honest scope) rather than
 * throwing — the head name was recognised but the call shape isn't
 * bridge-able.
 */
export function headToMeijerG(
  head: string,
  args: readonly Value[],
): ForwardBridge | null {
  if (args.length !== 1) {
    // Erf, Erfc, Erfi are all single-argument. InverseErf, InverseErfc
    // too. A call with any other arity is malformed for the bridge's
    // purposes; null-return is the honest answer.
    if (head === "InverseErf" || head === "InverseErfc") return null;
  }

  switch (head) {
    case "Erf": {
      if (args.length !== 1) return null;
      const z = args[0]!;
      const gForm: MeijerGForm = {
        an: [HALF],
        ap: [],
        bm: [ZERO_INT],
        bq: [NEG_HALF],
        z: zSquared(z),
      };
      // Prefactor `z/√π · G`. Encoded as `mkTimes(mkDiv(z, √π), g)` so
      // the simplify pipeline sees the same grouping the existing cas-core
      // identity table uses (matches A3 / Erfi-canonicaliser shape).
      const wrap = (g: Value): Value => mkTimes(mkDiv(z, SQRT_PI), g);
      const zInverse = (): readonly Value[] => [z];
      return { gForm, wrap, zInverse };
    }

    case "Erfc": {
      if (args.length !== 1) return null;
      const z = args[0]!;
      const gForm: MeijerGForm = {
        an: [],
        ap: [ONE_INT],
        bm: [ZERO_INT, HALF],
        bq: [],
        z: zSquared(z),
      };
      // Prefactor `(1/√π) · G` — Erfc has no `z` factor (R4 §1.c, the
      // shape `(2, 0, 1, 2)` is the right-closing Bessel-K-family form).
      const wrap = (g: Value): Value => mkDiv(g, SQRT_PI);
      const zInverse = (): readonly Value[] => [z];
      return { gForm, wrap, zInverse };
    }

    case "Erfi": {
      if (args.length !== 1) return null;
      const z = args[0]!;
      // Same parameter tuple as Erf; the z-substitution is `−z²` instead
      // of `+z²`. R4 §1.b: erfi(z) = −i · erf(iz), and the Meijer-G form
      // is obtained from Erf's by flipping the z-sign.
      const gForm: MeijerGForm = {
        an: [HALF],
        ap: [],
        bm: [ZERO_INT],
        bq: [NEG_HALF],
        z: negZSquared(z),
      };
      // Prefactor identical to Erf's `z/√π · G`. The G itself encodes
      // the `i`-flip via its `−z²` slot.
      const wrap = (g: Value): Value => mkTimes(mkDiv(z, SQRT_PI), g);
      const zInverse = (): readonly Value[] => [z];
      return { gForm, wrap, zInverse };
    }

    case "InverseErf":
    case "InverseErfc": {
      // Honest refusal per R4 §1 + §6: no Meijer-G representation exists
      // in the literature for the inverse error functions. The bridge
      // *recognises* these heads (they aren't unknown — they're known-
      // unrepresentable) and returns `null` rather than throwing.
      return null;
    }

    default:
      // Not in this bridge module's scope — caller can try the next
      // bridge or fall back. Null-return composes additively with future
      // bridge modules (a top-level `headToMeijerG` could iterate over
      // every registered bridge and return the first non-null).
      return null;
  }
}

// -----------------------------------------------------------------------------
// Backward bridge — standalone path (no forward-pass closure)
// -----------------------------------------------------------------------------
//
// This path runs when a user (or another tool) hands the bridge a
// `MeijerGForm` that wasn't produced by this module's own `headToMeijerG`.
// The matcher inspects the parameter quintuple structurally and, on hit,
// reconstructs the head's arguments from the G-form's `z`-slot.
//
// For Erf / Erfc / Erfi the z-substitution is `z → ±z²`; the
// reconstruction `arg ← √(±z)` is honest but emits literal `mkPower`
// expressions that `cas-simplify` may or may not reduce further. Round-
// trips through this module's own forward bridge use the `zInverse`
// closure instead and recover byte-identically (see `test/bridges-erf.test.ts`).

/**
 * Backward bridge: a Meijer-G form → originating head + args, when the
 * form matches one of the three canonical Erf-family shapes. Returns
 * `null` when no rule matches — the caller falls back to a different
 * bridge or to the numerical evaluator.
 *
 * The optional `prefactor` parameter is part of the R4 §3.a hybrid API:
 * the matcher does not currently verify it against the canonical
 * prefactor (the verification is harder than it looks because canonical-
 * form equality through `cas-simplify` is non-trivial for the
 * `z/√π · ...` shape). Today the parameter is accepted for API stability
 * — future iterations may add the verification step. Callers that need
 * round-trip byte-identity should call `headToMeijerG(...).zInverse()`
 * directly, NOT this standalone backward bridge.
 *
 * For G-forms with the `(1, 1, 1, 2)` Erf/Erfi shape, the z-sign
 * discriminator (`isExplicitlyNegated(z)`) selects which head fires:
 *
 *   * `z`-slot is *explicitly* negated (top-level `neg`/`-` wrapper):
 *     emit `Erfi`.
 *   * `z`-slot is anything else (literal, raw `mkPower(z, 2)`, sym, etc.):
 *     emit `Erf`.
 *
 * The discrimination is purely structural — it does NOT attempt to
 * evaluate sign numerically. A G-form whose `z` numerically equals `-4`
 * but is encoded as `int(-4)` (rather than `neg(int(4))`) will route to
 * `Erf` — that's the cost of staying byte-faithful to the wire shape per
 * R4 §5.e. The standalone backward bridge is meant for AST-level
 * round-trips; numerical equivalence is the verifier's job.
 */
export function meijerGToHead(
  form: MeijerGForm,
  // `prefactor` is part of the R4 §3.a hybrid surface — kept for API
  // stability and forward compatibility (a future iteration may verify
  // it). Currently unused; the leading underscore signals intent without
  // suppressing the linter's "unused parameter" warning per house style.
  prefactor?: Value,
): { head: string; args: readonly Value[] } | null {
  // Touch `prefactor` so TS doesn't complain about the unused parameter
  // and so callers can pass it without compiler-friction; the parameter
  // exists for the future verification path documented above.
  void prefactor;

  const mnpq = mnpqOf(form);

  // ---------------------------------------------------------------------------
  // Erf / Erfi family — shape (1, 1, 1, 2), an=[1/2], ap=[], bm=[0], bq=[-1/2]
  // ---------------------------------------------------------------------------
  if (mnpq.m === 1 && mnpq.n === 1 && mnpq.p === 1 && mnpq.q === 2) {
    if (
      form.an.length === 1 &&
      isRationalEqual(form.an[0]!, 1n, 2n) &&
      form.ap.length === 0 &&
      form.bm.length === 1 &&
      isIntegerEqual(form.bm[0]!, 0n) &&
      form.bq.length === 1 &&
      isRationalEqual(form.bq[0]!, -1n, 2n)
    ) {
      // Disambiguate Erf vs Erfi by the z-slot's leading sign. See R4
      // §5.e + the file-top "Erf vs Erfi disambiguation" comment.
      if (isExplicitlyNegated(form.z)) {
        // Erfi: z-slot was `−u²` for some `u`; strip the leading `neg`
        // and emit `args = [√u]`. The user-visible reconstruction is
        // `√(−z_slot)`; we compute it as `√(inner_of_neg)` to keep the
        // shape clean for the common case `−(z²)` where the inner is a
        // power that `cas-simplify` recognises.
        const innerOfNeg = stripExplicitNeg(form.z)!;
        return { head: "Erfi", args: [mkPower(innerOfNeg, HALF)] };
      }
      // Erf: emit `args = [√z_slot]`.
      return { head: "Erf", args: [mkPower(form.z, HALF)] };
    }
  }

  // ---------------------------------------------------------------------------
  // Erfc family — shape (2, 0, 1, 2), an=[], ap=[1], bm=[0, 1/2], bq=[]
  // ---------------------------------------------------------------------------
  //
  // Canonical-bytes ordering of `bm` puts the rational `1/2` BEFORE the
  // integer `0` (`{"d` < `{"k`; see `dispatch.ts` §"Surprise"). We accept
  // EITHER lexical order so a hand-built form (`[int(0), rat(1, 2)]`)
  // matches; the standalone backward bridge does not run through the
  // dispatcher's canonical-sort pre-pass.
  if (mnpq.m === 2 && mnpq.n === 0 && mnpq.p === 1 && mnpq.q === 2) {
    if (
      form.an.length === 0 &&
      form.ap.length === 1 &&
      isIntegerEqual(form.ap[0]!, 1n) &&
      form.bm.length === 2 &&
      form.bq.length === 0
    ) {
      // bm in either order: {[0, 1/2], [1/2, 0]}. We commit to the math
      // (Γ-products are symmetric in their args), not the lexical sort.
      const bm0 = form.bm[0]!;
      const bm1 = form.bm[1]!;
      const matches =
        (isIntegerEqual(bm0, 0n) && isRationalEqual(bm1, 1n, 2n)) ||
        (isRationalEqual(bm0, 1n, 2n) && isIntegerEqual(bm1, 0n));
      if (matches) {
        return { head: "Erfc", args: [mkPower(form.z, HALF)] };
      }
    }
  }

  // No rule matched — honest refusal.
  return null;
}

// -----------------------------------------------------------------------------
// Value-shape predicates (local; the dispatcher has its own versions but
// we keep this module standalone so it can be used outside the dispatch
// pipeline)
// -----------------------------------------------------------------------------

function mnpqOf(form: MeijerGForm): { m: number; n: number; p: number; q: number } {
  return {
    m: form.bm.length,
    n: form.an.length,
    p: form.an.length + form.ap.length,
    q: form.bm.length + form.bq.length,
  };
}

function isIntegerEqual(v: Value, n: bigint): boolean {
  if (v.kind === "integer") return BigInt(v.value) === n;
  if (v.kind === "rational" && BigInt(v.den) === 1n) {
    return BigInt(v.num) === n;
  }
  return false;
}

function isRationalEqual(v: Value, num: bigint, den: bigint): boolean {
  // Reduce target to canonical form (gcd-reduced, sign in numerator).
  let n = num;
  let d = den;
  if (d < 0n) {
    n = -n;
    d = -d;
  }
  const g = bigintGcd(n < 0n ? -n : n, d);
  const tn = n / g;
  const td = d / g;
  if (v.kind === "rational") {
    return BigInt(v.num) === tn && BigInt(v.den) === td;
  }
  if (v.kind === "integer" && td === 1n) {
    return BigInt(v.value) === tn;
  }
  return false;
}

function bigintGcd(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) {
    [x, y] = [y, x % y];
  }
  return x;
}

/**
 * True iff `v` is *explicitly* wrapped in a top-level `neg` / unary `-`.
 * Mirrors `matchNegFree` in `cas-core/src/special-funcs/erf-identities.ts`
 * — the bridge's z-sign discriminator MUST match the cas-core convention
 * so round-trips through the I4 identity table compose cleanly.
 *
 * Does NOT match `int(-n)` or `rat(-n, d)` literals — those are *literal*
 * negatives, not structural unary-neg wrappers. The discriminator is
 * deliberately conservative: an Erfi forward bridge always emits
 * `mkNeg(mkPower(z, 2))` (a structural `neg`), so the backward path
 * recovers Erfi only on that shape.
 */
function isExplicitlyNegated(v: Value): boolean {
  if (v.kind !== "expression") return false;
  if (v.head === "neg" && v.args.length === 1) return true;
  if (v.head === "-" && v.args.length === 1) return true;
  return false;
}

/**
 * Strip one layer of explicit `neg` / unary `-`; returns the inner Value
 * or `null` if `v` isn't explicitly negated. Companion to
 * `isExplicitlyNegated`; called after the predicate has returned `true`.
 */
function stripExplicitNeg(v: Value): Value | null {
  if (v.kind !== "expression") return null;
  if ((v.head === "neg" || v.head === "-") && v.args.length === 1) {
    return v.args[0]!;
  }
  return null;
}
