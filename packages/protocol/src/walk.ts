// =============================================================================
// walk.ts — Value-tree predicates and traversal helpers
// =============================================================================
//
// Small, sharp utilities for walking a Value tree without rewriting it. Today
// this file holds one predicate — `containsFloat64` — but the convention is:
// any future "does this Value tree have / count / collect kind X" predicate
// belongs here, alongside its siblings, rather than scattered across consumer
// packages.
//
// `containsFloat64` is load-bearing for ADR-0015's per-execution determinism-
// tier conditioning: a tool annotated `numerical: true` only writes the
// `platform` field on its provenance record when the *actual* output contains
// at least one float64 leaf. Same tool, different inputs can produce
// different-tier outputs (ADR-0007's `precision: "exact" | "float64"`
// pattern); the provenance record reflects what was *actually* computed,
// not what the tool *might* compute.
//
// The walk is shallow-by-default semantics over the closed 10-kind discriminator
// (the `switch (v.kind)` is exhaustive; missing a case is a TypeScript error).

import type { Value } from "./kinds.js";

/**
 * Returns true iff the Value tree contains at least one `float64` leaf.
 *
 * Walks all 10 kinds via the canonical `kind` discriminator; short-circuits
 * on the first hit. Cost: O(value size) worst case (a Value of pure exact
 * leaves), O(1) on lucky early-hit. The walk does not allocate.
 *
 * Used by `executeToolDef` to decide whether a `numerical: true` tool's
 * provenance record gets a `platform` field. Symbolic outputs (no float64
 * anywhere — pure integer/rational/string/symbol/expression trees) get
 * none; outputs with any float64 leaf get the platform fingerprint.
 */
export function containsFloat64(v: Value): boolean {
  switch (v.kind) {
    case "float64":
      return true;
    case "symbol":
    case "string":
    case "integer":
    case "rational":
    case "boolean":
      return false;
    case "list":
      for (const item of v.items) {
        if (containsFloat64(item)) return true;
      }
      return false;
    case "record":
      for (const k of Object.keys(v.fields)) {
        if (containsFloat64(v.fields[k]!)) return true;
      }
      return false;
    case "expression":
      for (const arg of v.args) {
        if (containsFloat64(arg)) return true;
      }
      return false;
    case "tagged":
      return containsFloat64(v.payload);
  }
}
