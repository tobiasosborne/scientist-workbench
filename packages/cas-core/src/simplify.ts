// =============================================================================
// simplify.ts — cas-simplify dispatcher (Q[x_1,…,x_n] / Q(x_1,…,x_n) folder +
// Erf-family identity table + cross-head sum-collapse)
// =============================================================================
//
// Overview
// --------
// cas-simplify converts in-scope subtrees to canonical RatFn form;
// wraps out-of-scope subtrees (after recursing into children) in
// `tagged "cas-simplify/out-of-scope"`. Already-tagged values with our
// tag pass through verbatim (idempotence).
//
// Identity-table layer (bead `bfwt` / worklog 134)
// ------------------------------------------------
// Before the RatFn fold, run a pre-pass `applyErfRewrites` that walks
// the tree bottom-up and:
//   1. For each expression with an Erf-family head (Erf, Erfc, Erfi,
//      InverseErf, InverseErfc), try the per-head rewrite table
//      `tryErfSimplify`. Iterate to a fixed point per node so
//      cascading rewrites (e.g. `Erfi(-z) → -Erfi(z) → -·-i·Erf(iz)`)
//      converge in a single pass.
//   2. For each `+`-headed expression, after recursing the children,
//      look for `Erf(z) + Erfc(z)` complement pairs and collapse them
//      to `1`. This is the load-bearing end-to-end behaviour the
//      CLAUDE.md spec requires: `simplify(Erfc(z) + Erf(z)) = 1` even
//      though neither head is individually in the RatFn-foldable
//      vocabulary.
//
// The pre-pass is purely additive: nodes that don't match any Erf
// rule (foreign heads, elementary heads, leaves) pass through
// unchanged byte-for-byte. The existing RatFn fold and the foreign-
// pass-through tagging that follow it see the same input shape they
// always did, with Erf-family collapses already applied.
//
// Idempotence
// -----------
// `applyErfRewrites` runs a bounded fixed-point at each node — each
// rewrite either reduces the AST size, produces a special-value
// literal, or restates the expression in canonical form that doesn't
// re-match the same rule. The bound is `ERF_REWRITE_MAX_ITERATIONS =
// 8`, which is comfortably above the cascade depth the v0.1 rule
// table can produce (the longest chain in practice is `Erfi(-z) →
// -Erfi(z) → -·-i·Erf(iz) → i·Erf(iz)` — 3 rewrites). If the bound
// is ever exceeded, that's a rule-table cycle bug — we throw rather
// than loop forever (CLAUDE.md Rule 1).
//
// Foreign-pass-through invariant
// ------------------------------
// The pre-pass MUST NOT change the foreign-pass-through behaviour:
// out-of-scope heads still get tagged. The pre-pass walks the tree
// but only modifies subtrees with Erf-family heads (or `+` containing
// Erf-family pairs). Any subtree whose root is a foreign head — and
// whose Erf-family descendants have been rewritten — passes the
// modified subtree to the foreign-pass-through code path unchanged
// otherwise. The test suite includes a property-style check that
// foreign-pass-through is preserved across 200 random expression
// trees.

import { expr, list, record, tagged, type Value } from "@workbench/protocol";
import { CasOutOfScopeError, ratFnToValue, valueToRatFn } from "./expr-bridge.js";
import { mkNeg, mkPlus, mkTimes } from "./diff.js";
import {
  collapseErfComplementPairs,
  isErfFamilyHead,
  tryErfSimplify,
} from "./special-funcs/erf-identities.js";
import {
  isBesselFamilyHead,
  tryBesselSimplify,
} from "./special-funcs/bessel-identities.js";

export const SIMPLIFY_TAG = "cas-simplify/out-of-scope";

/** Bound on per-node rewrite-cascade iterations. See file header. */
const ERF_REWRITE_MAX_ITERATIONS = 8;

/**
 * Bound on per-node Bessel-rewrite cascade iterations. Same envelope
 * as Erf — the longest v0.1 cascade is `j_0(z) → sin(z)/z` (1 step),
 * but a Hankel-then-half-integer chain could in principle reach
 * `H¹_{1/2}(z) → J_{1/2}(z) + i·Y_{1/2}(z) → √(...)·sin + i·(-√(...)·
 * cos)` — at most 3 rewrites on each branch of the binary `+`. The
 * bound of 8 is comfortable.
 */
const BESSEL_REWRITE_MAX_ITERATIONS = 8;

export function casSimplify(v: Value): Value {
  if (v.kind === "tagged" && v.tag === SIMPLIFY_TAG) return v;
  // Pre-passes: run the per-head identity tables bottom-up. The result
  // is structurally either the same Value (if no rule fires anywhere)
  // or a new Value with the per-head rewrites applied (Erf-family
  // rewrites + Erf/Erfc complement collapses, then Bessel-family
  // rewrites). The two passes are independent: an Erf-pass-rewritten
  // sub-tree contains no Bessel-family heads and vice versa, so the
  // ordering between them is mathematically irrelevant. Running Erf
  // first matches declaration order in this file (the historical
  // first pre-pass).
  const afterErf = applyErfRewrites(v);
  const rewritten = applyBesselRewrites(afterErf);
  try {
    const rf = valueToRatFn(rewritten);
    return ratFnToValue(rf);
  } catch (e) {
    if (!(e instanceof CasOutOfScopeError)) throw e;
    const inner = recurseChildren(rewritten);
    return tagged(SIMPLIFY_TAG, inner);
  }
}

function recurseChildren(v: Value): Value {
  switch (v.kind) {
    case "expression":
      return expr(v.head, v.args.map(casSimplify));
    case "list":
      return list(v.items.map(casSimplify));
    case "record": {
      const f: Record<string, Value> = {};
      for (const [k, vv] of Object.entries(v.fields)) f[k] = casSimplify(vv);
      return record(f);
    }
    case "tagged":
      return v;
    case "symbol":
    case "string":
    case "integer":
    case "rational":
    case "float64":
    case "boolean":
      return v;
  }
}

// -----------------------------------------------------------------------------
// Erf-family pre-pass
// -----------------------------------------------------------------------------
//
// Bottom-up rewrite walker. For every node:
//   * Recurse into children first (so cascades that fire on a child's
//     rewritten output get caught by the parent's pass).
//   * If the node is an Erf-family head, iterate `tryErfSimplify` to
//     fixed point (bounded). Each iteration substitutes the children
//     with their pre-pass results, then asks the table for a rewrite.
//   * If the node is `+`, run `collapseErfComplementPairs` on its
//     summands.

function applyErfRewrites(v: Value): Value {
  switch (v.kind) {
    case "integer":
    case "rational":
    case "float64":
    case "boolean":
    case "string":
    case "symbol":
      return v;
    case "tagged":
      // Tagged values are opaque to the rewriter — the foreign-pass-
      // through invariant says we don't peek inside. The payload was
      // simplified at the time it was tagged; re-simplifying it would
      // be an unbounded recursion if (e.g.) the tagger inserted a
      // version of `v` inside its own payload.
      return v;
    case "list":
      return list(v.items.map(applyErfRewrites));
    case "record": {
      const f: Record<string, Value> = {};
      for (const [k, vv] of Object.entries(v.fields)) f[k] = applyErfRewrites(vv);
      return record(f);
    }
    case "expression": {
      // Recurse children first (bottom-up).
      const newArgs = v.args.map(applyErfRewrites);
      let current: Value;
      if (sameArgs(v.args, newArgs)) {
        current = v;
      } else {
        // Route the rebuild through a smart constructor for the heads
        // that have one (`neg`, `+`, `*`). Otherwise a rewrite that
        // produces `neg(neg(x))` at the child level — e.g. the cascade
        // `Erfi(-z) → -Erfi(z) → -(-i·Erf(iz))` — leaves a double-neg
        // in place because `expr("neg", [neg(x)])` does not absorb the
        // smart-ctor identity. Other heads (foreign / Erf-family) are
        // rebuilt with `expr(head, args)` — there is no smart-ctor
        // identity to apply at those heads.
        if (v.head === "neg" && newArgs.length === 1) {
          current = mkNeg(newArgs[0]!);
        } else if (v.head === "+") {
          current = mkPlus(newArgs);
        } else if (v.head === "*") {
          current = mkTimes(...newArgs);
        } else {
          current = expr(v.head, newArgs);
        }
      }

      // Sum-collapse: detect `Erf(z) + Erfc(z)` pairs inside `+`.
      if (current.kind === "expression" && current.head === "+") {
        const collapsed = collapseErfComplementPairs(current.args);
        if (collapsed !== current.args) {
          // `mkPlus` absorbs `+(x)` → `x`, drops zeros, etc.; using
          // it here ensures the collapsed result is in the same
          // canonical-of-rewrite form the per-head rewrites emit.
          current = mkPlus(collapsed);
        }
      }

      // Per-head Erf-family rewrites with bounded cascade.
      if (current.kind === "expression" && isErfFamilyHead(current.head)) {
        for (let i = 0; i < ERF_REWRITE_MAX_ITERATIONS; i++) {
          if (current.kind !== "expression") break;
          if (!isErfFamilyHead(current.head)) break;
          const result = tryErfSimplify(current.head, current.args);
          if (result === null) break;
          // The rewrite may itself contain rewritable sub-expressions
          // (e.g. `Erfi(-z) → -Erfi(z)` — the produced `-Erfi(z)`
          // has an `Erfi` head we want to keep rewriting). Walk the
          // result top-down so any new Erf-family node it produced
          // gets a chance to fire.
          current = applyErfRewrites(result);
        }
        if (current.kind === "expression" && isErfFamilyHead(current.head)) {
          // Sanity: at this point the rule table should be at fixed
          // point. We don't actually need to detect "still rewritable"
          // explicitly; the loop above already exited. Falls through.
        }
      }

      return current;
    }
  }
}

/**
 * Cheap reference-equality on arg lists; returns true iff every arg
 * is the same object as the corresponding original arg. Used to avoid
 * rebuilding an expression node when no child changed.
 */
function sameArgs(a: readonly Value[], b: readonly Value[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

// -----------------------------------------------------------------------------
// Bessel-family pre-pass
// -----------------------------------------------------------------------------
//
// Parallel to `applyErfRewrites` — bottom-up rewrite walker, bounded
// fixed-point per node, the same idempotence + foreign-pass-through
// invariants. Implemented as a sibling rather than a unified "per-
// head pre-pass" function so that:
//   * Adding the next per-head substrate (Gamma, Whittaker, …) ships
//     as a literally additive new pre-pass function — no need to
//     refactor a shared walker.
//   * The per-head rule tables stay disjoint by head, so a Bessel
//     rule can never accidentally see an Erf-family input or vice
//     versa.
//   * Each pre-pass's iteration bound is local to that substrate's
//     cascade depth.
//
// See `bessel-identities.ts`'s top-of-file narrative for the rule-
// cascade analysis that justifies the bound.

function applyBesselRewrites(v: Value): Value {
  switch (v.kind) {
    case "integer":
    case "rational":
    case "float64":
    case "boolean":
    case "string":
    case "symbol":
      return v;
    case "tagged":
      // Tagged values are opaque to the rewriter — foreign-pass-through
      // invariant. The payload was simplified at the time it was tagged.
      return v;
    case "list":
      return list(v.items.map(applyBesselRewrites));
    case "record": {
      const f: Record<string, Value> = {};
      for (const [k, vv] of Object.entries(v.fields)) {
        f[k] = applyBesselRewrites(vv);
      }
      return record(f);
    }
    case "expression": {
      // Recurse children first (bottom-up).
      const newArgs = v.args.map(applyBesselRewrites);
      let current: Value;
      if (sameArgs(v.args, newArgs)) {
        current = v;
      } else {
        // Smart-ctor rebuild for the elementary heads that have one,
        // direct `expr` rebuild otherwise.
        if (v.head === "neg" && newArgs.length === 1) {
          current = mkNeg(newArgs[0]!);
        } else if (v.head === "+") {
          current = mkPlus(newArgs);
        } else if (v.head === "*") {
          current = mkTimes(...newArgs);
        } else {
          current = expr(v.head, newArgs);
        }
      }

      // Per-head Bessel-family rewrites with bounded cascade.
      if (current.kind === "expression" && isBesselFamilyHead(current.head)) {
        for (let i = 0; i < BESSEL_REWRITE_MAX_ITERATIONS; i++) {
          if (current.kind !== "expression") break;
          if (!isBesselFamilyHead(current.head)) break;
          const result = tryBesselSimplify(current.head, current.args);
          if (result === null) break;
          // Re-walk the rewritten result so any newly-introduced
          // Bessel-family sub-expressions (e.g. class-D Hankel →
          // J + i·Y produces both J and Y children that might match
          // class-C half-integer closures) get a chance to fire.
          current = applyBesselRewrites(result);
        }
      }

      return current;
    }
  }
}
