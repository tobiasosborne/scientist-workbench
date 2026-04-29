// =============================================================================
// traverse — visitor pattern for Channel bodies
// =============================================================================
//
// Why this file exists
// --------------------
// Several Sturm tools want to walk every op in a channel: gate counts,
// `sturm-simplify`'s rewrite engine, `sturm-execute`'s amplitude
// evolution, the equivalence-checker's matrix builder. Hand-rolling a
// recursive walker in each tool drifts: one tool forgets that `cases`
// arms contain ops; another walks them but doesn't propagate the
// `controls` of an enclosing context.
//
// `traverseChannel(c, visitor)` is the canonical walker. It descends
// into `cases` arms in document order (true-arm first, then false-
// arm) and invokes `visitor(op, ctx)` for every op encountered.
//
// The `VisitContext` carries:
//   • `branchPath` — a list of `["true" | "false", index]` pairs
//     identifying the current cases nesting; empty at the top level.
//
// `branchPath` is mostly useful for tools that want to report
// failures with a precise path or that want to associate state with
// arm depth.
//
// Note on controls. Per ADR-0006, `when(q) do … end` is *already
// lowered* into the `controls` field on inner `ry`/`rz` ops at IR
// build time — there is no `when` op-node, no implicit ambient
// controls stack the visitor must maintain. The ops carry their full
// control-set in their own `controls` field. The visitor does not
// re-thread an ambient stack; consumers that want to know the
// total controls of an op just read `op.controls`.
//
// (An earlier sketch of this file in shard 009 mentioned a "controls-
// stack maintenance" responsibility for the visitor. That was a
// holdover from a representation where `when` was its own op-node.
// The IR pivoted away from that during the ADR-0006 design — see
// the ADR's "Alternatives considered" section. The visitor's job is
// simpler than the planning shard suggested.)

import { type Channel, type Op } from "./nodes.js";

export interface VisitContext {
  /**
   * The chain of cases-arm choices traversed to reach the current
   * op. Empty at the top level. Entries are `["true" | "false",
   * <op-index in arm>]` pairs. The deepest pair is the current arm.
   */
  readonly branchPath: readonly (readonly ["true" | "false", number])[];
}

/**
 * A visitor invoked once per op in document order. The visitor
 * function may inspect the op and the surrounding context; its
 * return value is ignored. Throw to abort traversal.
 */
export type OpVisitor = (op: Op, ctx: VisitContext) => void;

const ROOT_CTX: VisitContext = { branchPath: [] };

function visitOp(op: Op, ctx: VisitContext, visitor: OpVisitor): void {
  visitor(op, ctx);
  if (op.head === "cases") {
    for (let i = 0; i < op.trueArm.length; i++) {
      const child: VisitContext = {
        branchPath: [...ctx.branchPath, ["true", i] as const],
      };
      visitOp(op.trueArm[i]!, child, visitor);
    }
    for (let i = 0; i < op.falseArm.length; i++) {
      const child: VisitContext = {
        branchPath: [...ctx.branchPath, ["false", i] as const],
      };
      visitOp(op.falseArm[i]!, child, visitor);
    }
  }
}

/**
 * Walk a channel's body in document order, descending into `cases`
 * arms (true-arm first, then false-arm). Calls `visitor(op, ctx)`
 * once for every op encountered, including the `cases` op itself
 * (visited *before* its arms).
 */
export function traverseChannel(c: Channel, visitor: OpVisitor): void {
  for (let i = 0; i < c.body.length; i++) {
    visitOp(c.body[i]!, ROOT_CTX, visitor);
  }
}
