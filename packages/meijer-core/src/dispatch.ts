// =============================================================================
// dispatch.ts — Adamchik–Marichev + Roach symbolic dispatcher (Layer 4)
// =============================================================================
//
// Three-step pipeline (Adamchik–Marichev 1990 ISSAC §3, simplified to
// the symbolic-recognition direction Roach 1997 names):
//
//   1. **Pattern recognition.** Walk a curated table of reduction
//      rules; for each rule check whether the input `(an, ap, bm, bq)`
//      matches the rule's `PatternSpec`. The first matching rule wins
//      (rules are ordered by specificity within each file).
//
//   2. **Rewrite.** The matched rule's `rewrite(bindings, z)` builds
//      the closed-form `Value` AST in the special-function vocabulary
//      shipped by ADR-0023.
//
//   3. **Canonicalise.** Run the candidate through `casSimplify` (the
//      `Q(x_1..x_n)` ratfn canonicaliser) to absorb local algebraic
//      redundancy. Special-function subterms wrap as
//      `tagged "cas-simplify/out-of-scope"` *around the smallest
//      non-Q(x) subtree* — the multi-point-sampling verifier
//      (`VERIFIER-PROTOCOL.md` §"symbolic check") admits any
//      numerically-equivalent form, so canonicalisation is for human
//      readability, not equivalence.
//
// What this module does NOT do
// ----------------------------
// * **Numerical evaluation.** `meijergSymbolic` returns AST. The
//   numerical-tier evaluators consume it (or, when no rule matches,
//   the input falls through to `meijergSlater` / `meijergContour`).
// * **Recursive MeijerG handling.** Rules whose RHS is itself a
//   smaller MeijerG (some PBM §8.4 entries) emit the bare reduced
//   `MeijerG` head; the layer-7 dispatcher will recurse on it. v0.1
//   has no rule emitting MeijerG.
// * **General pattern syntax beyond `lit-int / lit-rat / free /
//   free-shift`.** v0.1's slot-by-slot matcher covers every starter
//   rule from Bateman §5.6 and DLMF §16.18. Future expansion is
//   additive (ADR-0025 §10).
//
// Parameter-set canonicalisation (ADR-0025 §7)
// -------------------------------------------
// `an`, `ap`, `bm`, `bq` are sorted by canonical-bytes before
// matching; rules are written assuming the canonical order. This
// makes the dispatcher invariant under permutations *within* each
// sub-tuple (the mathematical contract: each Γ-product is symmetric
// in its arguments). Permutations *between* sub-tuples (e.g. moving
// a slot from `bm` to `bq`) are *not* invariances — they change which
// poles the contour encloses.
//
// **Surprise.** `canonicalize` sorts JSON record keys alphabetically,
// so `rational` Values produce `{"den":"...","kind":"rational",
// "num":"..."}` (starts with `{"d`), while `integer` Values produce
// `{"kind":"integer","value":"..."}` (starts with `{"k`). Since
// `{"d` < `{"k` lexicographically, **rationals sort BEFORE integers**
// in the canonical bytes order. Rules in `dispatch-rules/` are
// written assuming this convention. Tests assert the order via
// concrete inputs (e.g. `bm = [rat(1,2), int(1)]` is canonical;
// `bm = [int(1), rat(1,2)]` is reordered to canonical before
// matching).

import { canonicalize, type Value } from "@workbench/protocol";
import { casSimplify } from "@workbench/cas-core";
import type {
  Bindings,
  DispatchResult,
  MeijerGSymbolicParams,
  PatternSpec,
  ReductionRule,
  RelationSpec,
  SlotSpec,
} from "./dispatch-types.js";

import { RULES as BATEMAN_5_6 } from "./dispatch-rules/bateman-5-6.js";
import { RULES as BESSEL_BACKWARD } from "./dispatch-rules/bessel-backward.js";
import { RULES as DLMF_16_18 } from "./dispatch-rules/dlmf-16-18.js";
import { RULES as ERF_FORWARD_FORM_A } from "./dispatch-rules/erf-forward-form-a.js";
import { RULES as ERFC_FORWARD } from "./dispatch-rules/erfc-forward.js";
import { RULES as ERFI_FORWARD } from "./dispatch-rules/erfi-forward.js";

// -----------------------------------------------------------------------------
// Rule registry
// -----------------------------------------------------------------------------
//
// A flat list, ordered by source. Within each source file, the
// rules' relative order is the file's responsibility (most-specific-
// first is the convention; rules with literal slot patterns that
// would also match a more-general `free`-slot rule must come first).

export const ALL_RULES: readonly ReductionRule[] = [
  // Erf-family bridge rules (bead `tc2c` / worklog 137, ADR-0040 §"Decision
  // 5"). Sit FIRST in the registry per R4 §5.a / §5.b ordering
  // discipline: the bridge rules are the most-specific match for their
  // shapes; any future generic rule for the same shape would have to
  // be evaluated AFTER the bridge to preserve round-trip closure.
  // Form A.Erf and Erfi share `(1, 1, 1, 2)` with `[1/2], [], [0],
  // [-1/2]` — they partition cleanly via `zMatch`. Form B
  // (`dlmf-16-18-erf`) has different slot values, no collision.
  ...ERF_FORWARD_FORM_A,
  ...ERFI_FORWARD,
  ...ERFC_FORWARD,
  // Bessel-Y / Bessel-I canonical-form backward rules (beads `1xqq` /
  // `lfet`, R4 §E.3 gap close). Sit before DLMF/Bateman so the
  // canonical-Bessel shapes don't fall through to `no-known-reduction`;
  // their (m,n,p,q) tuples (2,0,1,3) and (1,0,1,3) are NOT covered by
  // any DLMF/Bateman rule today, so ordering is for future-proofing
  // rather than current-disambiguation. See
  // `dispatch-rules/bessel-backward.ts` for the slot-match algebra and
  // soundness contract.
  ...BESSEL_BACKWARD,
  ...DLMF_16_18, // DLMF first — primary contemporary index
  ...BATEMAN_5_6, // Bateman §5.6 for the pre-DLMF starter rules
];

// -----------------------------------------------------------------------------
// Public entry point
// -----------------------------------------------------------------------------

/**
 * Dispatch `MeijerG[(an, ap, bm, bq), z]` against the curated rule
 * table. Returns the first matching rule's rewrite (canonicalised),
 * or `no-known-reduction` if no rule fires.
 *
 * The argument `z` is opaque to the dispatcher — it's threaded
 * verbatim into the matched rule's `rewrite(bindings, z)`. Callers
 * pass whatever Value shape they want symbolically (`sym("z")`,
 * `int(2n)`, `expr("/", [int(1n), int(2n)])`, …).
 */
export function meijergSymbolic(
  params: MeijerGSymbolicParams,
  z: Value,
): DispatchResult {
  const canonical = canonicaliseParams(params);
  for (const rule of ALL_RULES) {
    const bindings = tryMatch(rule.match, canonical, z);
    if (bindings === null) continue;
    let candidate: Value;
    try {
      candidate = rule.rewrite(bindings, z);
    } catch (e) {
      // A rule's rewrite shouldn't throw on a well-bound match; if it
      // does, surface the rule id so debugging is direct.
      throw new Error(
        `meijergSymbolic: rule ${rule.id} threw during rewrite: ${(e as Error).message}`,
      );
    }
    const canonicalised = canonicaliseOutput(candidate);
    return {
      kind: "matched",
      expr: canonicalised,
      ruleId: rule.id,
      ruleSource: rule.source,
      ...(rule.note !== undefined ? { note: rule.note } : {}),
    };
  }
  const { m, n, p, q } = mnpqOf(canonical);
  return {
    kind: "no-known-reduction",
    reason:
      `no rule in the v0.1 dispatch table matches G^{${m},${n}}_{${p},${q}} ` +
      `with the supplied parameter shape; route to the numerical path`,
  };
}

// -----------------------------------------------------------------------------
// Input canonicalisation (ADR-0025 §7)
// -----------------------------------------------------------------------------

function canonicaliseParams(params: MeijerGSymbolicParams): MeijerGSymbolicParams {
  return {
    an: sortByCanonicalBytes(params.an),
    ap: sortByCanonicalBytes(params.ap),
    bm: sortByCanonicalBytes(params.bm),
    bq: sortByCanonicalBytes(params.bq),
  };
}

function sortByCanonicalBytes(xs: readonly Value[]): readonly Value[] {
  const tagged = xs.map((v) => ({ v, key: canonicalize(v) }));
  tagged.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return tagged.map((t) => t.v);
}

function mnpqOf(p: MeijerGSymbolicParams): { m: number; n: number; p: number; q: number } {
  return {
    m: p.bm.length,
    n: p.an.length,
    p: p.an.length + p.ap.length,
    q: p.bm.length + p.bq.length,
  };
}

// -----------------------------------------------------------------------------
// Slot-by-slot matcher (ADR-0025 §4 / §5)
// -----------------------------------------------------------------------------
//
// The matcher is *deliberately small*. v0.1's PatternSpec admits four
// slot kinds and one cross-slot relation; each one is a
// constant-time check on a Value. Rule files curate at hundreds-to-
// thousands scale; the matcher's overhead is the rule-list traversal
// (linear in `ALL_RULES.length`).
//
// Tried but not adopted: a global pattern-trie keyed by `(m, n, p, q)`.
// At v0.1 scale (~40 rules) the constant factor overhead dominates;
// when the table grows past ~200 rules the trie becomes worth it,
// and a future bead can introduce it transparently behind this
// function (the public surface stays identical).

function tryMatch(
  pattern: PatternSpec,
  params: MeijerGSymbolicParams,
  z: Value,
): Bindings | null {
  const got = mnpqOf(params);
  if (
    got.m !== pattern.mnpq.m ||
    got.n !== pattern.mnpq.n ||
    got.p !== pattern.mnpq.p ||
    got.q !== pattern.mnpq.q
  ) {
    return null;
  }
  if (
    pattern.an.length !== params.an.length ||
    pattern.ap.length !== params.ap.length ||
    pattern.bm.length !== params.bm.length ||
    pattern.bq.length !== params.bq.length
  ) {
    return null;
  }

  const bindings: Record<string, Value> = {};

  if (!matchSlots(pattern.an, params.an, bindings)) return null;
  if (!matchSlots(pattern.ap, params.ap, bindings)) return null;
  if (!matchSlots(pattern.bm, params.bm, bindings)) return null;
  if (!matchSlots(pattern.bq, params.bq, bindings)) return null;

  if (pattern.relations) {
    for (const rel of pattern.relations) {
      if (!checkRelation(rel, bindings)) return null;
    }
  }

  // z-argument predicate (ADR-0040 §"Decision 5" / R4 §2.5.1). Absent
  // predicate = "match every z" (current behaviour, every legacy rule
  // continues to fire). The Erf-vs-Erfi disambiguation registers
  // distinct rules with mutually-exclusive `zMatch` predicates on the
  // same `(an, ap, bm, bq)` tuple; first-match-wins, but `zMatch:
  // "no"` declines so the second rule gets its chance.
  if (pattern.zMatch !== undefined) {
    const verdict = pattern.zMatch(z);
    if (verdict === "no") return null;
    // "yes" and "unknown" both fall through to the rewrite path; the
    // difference is documented in dispatch-types.ts and is observable
    // only via rule ordering when multiple zMatch-bearing rules
    // overlap.
  }

  return bindings;
}

function matchSlots(
  slots: readonly SlotSpec[],
  values: readonly Value[],
  bindings: Record<string, Value>,
): boolean {
  for (let i = 0; i < slots.length; i++) {
    if (!matchSlot(slots[i]!, values[i]!, bindings)) return false;
  }
  return true;
}

function matchSlot(
  slot: SlotSpec,
  v: Value,
  bindings: Record<string, Value>,
): boolean {
  switch (slot.kind) {
    case "lit-int":
      return isIntegerEqual(v, slot.value);
    case "lit-rat":
      return isRationalEqual(v, slot.num, slot.den);
    case "free": {
      if (slot.name in bindings) {
        // Repeated `free` with the same name => the second occurrence
        // must equal the first by canonical bytes. (No rule in the
        // starter set uses this; included for forward compatibility.)
        return canonicalize(bindings[slot.name]!) === canonicalize(v);
      }
      bindings[slot.name] = v;
      return true;
    }
    case "free-shift": {
      // The slot value at this position must equal `bindings[name] +
      // shift` if `bindings[name]` is already bound, or — if not yet
      // bound — set `bindings[name] = v - shift`.
      const unshifted = subtractInteger(v, slot.shift);
      if (unshifted === null) return false;
      if (slot.name in bindings) {
        return canonicalize(bindings[slot.name]!) === canonicalize(unshifted);
      }
      bindings[slot.name] = unshifted;
      return true;
    }
  }
}

function checkRelation(rel: RelationSpec, bindings: Bindings): boolean {
  switch (rel.kind) {
    case "integer-difference": {
      const lhs = bindings[rel.lhs];
      const rhs = bindings[rel.rhs];
      if (lhs === undefined || rhs === undefined) return false;
      return isIntegerDifference(lhs, rhs);
    }
  }
}

// -----------------------------------------------------------------------------
// Value-shape predicates
// -----------------------------------------------------------------------------
//
// Rule patterns match against integer / rational literals
// structurally. We do not interpret a `1` written as `rat(1, 1)` as
// matching `lit-int 1`; the canonical form for an integer is the
// `integer` Value (the `rat()` constructor reduces 1/1 to int(1n)
// already, but we still gate on `kind` to be honest about the AST
// level we operate at).

function isIntegerEqual(v: Value, n: number): boolean {
  if (v.kind === "integer") {
    return BigInt(v.value) === BigInt(n);
  }
  if (v.kind === "rational") {
    // `rat()` reduces, so `rat(2, 1)` becomes `int(2n)` at construction.
    // Defensive: a hand-built RationalValue with den=1 is equivalent.
    if (BigInt(v.den) === 1n) return BigInt(v.num) === BigInt(n);
  }
  return false;
}

function isRationalEqual(v: Value, num: number, den: number): boolean {
  if (v.kind === "rational") {
    // `rat()` produces canonical form (gcd-reduced, sign in numerator);
    // we reduce the literal target the same way before comparing.
    const [tn, td] = reduceRatLiteral(num, den);
    return BigInt(v.num) === tn && BigInt(v.den) === td;
  }
  if (v.kind === "integer") {
    // An integer-valued rational literal: `rat(2, 1)` would match
    // `int(2n)`. (Patterns wanting an exact rational shape should
    // not write `lit-rat 2/1`; they should write `lit-int 2`.)
    if (den === 1) return BigInt(v.value) === BigInt(num);
    if (den === -1) return BigInt(v.value) === -BigInt(num);
  }
  return false;
}

function reduceRatLiteral(num: number, den: number): [bigint, bigint] {
  let n = BigInt(num);
  let d = BigInt(den);
  if (d < 0n) {
    n = -n;
    d = -d;
  }
  const g = bigintGcd(n < 0n ? -n : n, d);
  return [n / g, d / g];
}

function bigintGcd(a: bigint, b: bigint): bigint {
  while (b !== 0n) {
    [a, b] = [b, a % b];
  }
  return a;
}

/**
 * Compute `v − k` in the smallest natural Value form. Returns null if
 * `v` is not in the integer / rational subset (the caller's signal
 * that the slot is symbolic and the `free-shift` rule cannot apply).
 */
function subtractInteger(v: Value, k: number): Value | null {
  const kk = BigInt(k);
  if (v.kind === "integer") {
    const r = BigInt(v.value) - kk;
    return { kind: "integer", value: r.toString() };
  }
  if (v.kind === "rational") {
    const num = BigInt(v.num) - kk * BigInt(v.den);
    const den = BigInt(v.den);
    // Rebuild canonical rational; `rat()` would do this for us but
    // we don't import it here to keep the matcher's edges visible.
    const [n2, d2] = reduceRatLiteral(Number(num), Number(den));
    if (d2 === 1n) {
      return { kind: "integer", value: n2.toString() };
    }
    return { kind: "rational", num: n2.toString(), den: d2.toString() };
  }
  // Symbolic / expression / float64 — out of v0.1 free-shift's scope.
  return null;
}

/**
 * Decide whether `lhs − rhs` is an exact integer (positive, negative,
 * or zero) when both lie in the integer / rational subset. Symbolic /
 * mixed inputs return false (no rule in the starter set guards a
 * relation it cannot decide).
 */
function isIntegerDifference(lhs: Value, rhs: Value): boolean {
  const lhsRat = toExactRat(lhs);
  const rhsRat = toExactRat(rhs);
  if (lhsRat === null || rhsRat === null) return false;
  const diffNum = lhsRat.num * rhsRat.den - rhsRat.num * lhsRat.den;
  const diffDen = lhsRat.den * rhsRat.den;
  return diffNum % diffDen === 0n;
}

function toExactRat(v: Value): { num: bigint; den: bigint } | null {
  if (v.kind === "integer") return { num: BigInt(v.value), den: 1n };
  if (v.kind === "rational") return { num: BigInt(v.num), den: BigInt(v.den) };
  return null;
}

// -----------------------------------------------------------------------------
// Output canonicalisation (ADR-0025 §6)
// -----------------------------------------------------------------------------
//
// We pipe the candidate through `casSimplify`. The Q(x) parts
// (polynomial / rational-function arithmetic in `+ - * / ^` over
// integer / rational / symbol leaves) get canonicalised; special-
// function subterms (`Gamma`, `BesselJ`, …) wrap as
// `tagged "cas-simplify/out-of-scope"` around the smallest non-Q(x)
// subtree.
//
// The verifier doesn't care: at K=20 random sample points, the
// numerical equivalence test passes regardless of canonical form.
// Canonicalisation here is for the *human* reader of the dispatched
// expression and for stable goldens.

function canonicaliseOutput(v: Value): Value {
  return casSimplify(v);
}
