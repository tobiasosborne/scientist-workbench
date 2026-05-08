// =============================================================================
// dispatch-types.ts — public types for the symbolic dispatch layer
// =============================================================================
//
// ADR-0025 §3 / §4 pin these shapes. Each rule in
// `dispatch-rules/<source>.ts` is a literal `ReductionRule` record:
// the TS expert reading the rule sees a citation, a structural match
// shape, and a `rewrite` function that builds the closed-form
// expression. No string DSL, no plugin loader, no auto-discovery.
//
// The `PatternSpec` shape is *deliberately ad-hoc* in v0.1. Every
// published Bateman / DLMF rule we curate fits one of the four
// `SlotSpec` kinds (`lit-int`, `lit-rat`, `free`, `free-shift`). When
// (if) a future rule from PBM §8.4 needs a richer pattern grammar, a
// follow-up bead extends this file additively. The closed enumeration
// is what makes the rule files readable.

import type { Value } from "@workbench/protocol";

/**
 * One slot of a parameter sub-tuple (`an[i]`, `bm[j]`, etc.).
 *
 *   * `lit-int`    — exact integer literal (e.g. `0`, `1`).
 *   * `lit-rat`    — exact rational literal (e.g. `1/2`, `3/2`).
 *   * `free`       — captured variable; the entire Value at that slot
 *                    becomes a binding in the rewrite.
 *   * `free-shift` — captured variable plus a known integer shift; the
 *                    binding is the *unshifted* value (i.e. for slot
 *                    `{ kind: "free-shift", name: "a", shift: 1 }`
 *                    matching the Value `3`, the binding `a` is `2`).
 *                    Useful for rules like
 *                    `G^{1,1}_{2,2}({a, a-1}; ...)` where two slots
 *                    differ by a known integer.
 */
export type SlotSpec =
  | { readonly kind: "lit-int"; readonly value: number }
  | { readonly kind: "lit-rat"; readonly num: number; readonly den: number }
  | { readonly kind: "free"; readonly name: string }
  | { readonly kind: "free-shift"; readonly name: string; readonly shift: number };

/**
 * Cross-slot integer-relation guard.
 *
 *   * `integer-difference` — `bindings[lhs] − bindings[rhs] ∈ ℤ`.
 *     The dispatcher computes the difference of the two captured
 *     Values (rational arithmetic if either is rational; symbolic
 *     refusal otherwise) and admits the rule iff the result is an
 *     exact integer. This guards rules like Bateman 5.6.5 where two
 *     parameters' difference must be an integer for the closed form
 *     to apply.
 */
export type RelationSpec =
  | { readonly kind: "integer-difference"; readonly lhs: string; readonly rhs: string };

/**
 * The full match shape. The `(m, n, p, q)` integers are required to
 * agree with the *length-derived* counts of the input; the slot
 * arrays are matched in order against the canonicalised input.
 *
 * The `relations` field is optional; an absent / empty array means
 * "no cross-slot guards."
 */
export interface PatternSpec {
  readonly mnpq: { readonly m: number; readonly n: number; readonly p: number; readonly q: number };
  readonly an: readonly SlotSpec[];
  readonly ap: readonly SlotSpec[];
  readonly bm: readonly SlotSpec[];
  readonly bq: readonly SlotSpec[];
  readonly relations?: readonly RelationSpec[];
}

/**
 * Bindings produced by a successful match. The map keys are the
 * `name`s of `free` / `free-shift` slots; values are the captured
 * (post-shift, where applicable) Values.
 */
export type Bindings = Readonly<Record<string, Value>>;

/**
 * One reduction rule: pattern + rewrite + citation. ADR-0025 §3.
 *
 * The `id` is the stable diagnostics handle (e.g. `"bateman-5-6-1"`).
 * The `source` is the human-readable citation (e.g. `"Bateman §5.6 (1)"`).
 * The `note` is free-form prose for the reader (e.g. the closed-form
 * RHS in conventional notation).
 */
export interface ReductionRule {
  readonly id: string;
  readonly source: string;
  readonly note?: string;
  readonly match: PatternSpec;
  readonly rewrite: (bindings: Bindings, z: Value) => Value;
}

/**
 * Result of `meijergSymbolic`. Either a matched rule fired and the
 * closed-form `expr` is in the special-function vocabulary, or no
 * rule fired and the caller should route to the numerical path.
 *
 * Per ADR-0003: `no-known-reduction` is a *boundary failure* —
 * well-formed input, outside the rule table's coverage. The wire
 * wrapper turns it into `tagged "meijer-g-symbolic-only/no-known-reduction"`.
 */
export type DispatchResult =
  | {
      readonly kind: "matched";
      readonly expr: Value;
      readonly ruleId: string;
      readonly ruleSource: string;
      readonly note?: string;
    }
  | {
      readonly kind: "no-known-reduction";
      readonly reason: string;
    };

/**
 * Symbolic input parameters. Each Value lives in the protocol's
 * `integer / rational / symbol / expression` subset; the dispatcher
 * does not attempt to interpret `float64` / `complex` / arbitrary
 * `tagged` values as parameters (such inputs route to the numerical
 * path or refuse).
 */
export interface MeijerGSymbolicParams {
  readonly an: readonly Value[];
  readonly ap: readonly Value[];
  readonly bm: readonly Value[];
  readonly bq: readonly Value[];
}
