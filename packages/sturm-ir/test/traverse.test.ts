// traverse.test.ts — visitor invocation order, cases-arm descent.

import { describe, expect, test } from "bun:test";
import { rat, sym } from "@workbench/protocol";
import {
  casesOp,
  channel,
  observeOp,
  prepareOp,
  ryOp,
  traverseChannel,
  wire,
  type Op,
} from "../src/index.js";

describe("traverseChannel", () => {
  test("visits top-level ops in document order", () => {
    const ops: Op[] = [
      prepareOp(rat(0n, 1n), 0n),
      ryOp(0n, sym("π"), []),
      observeOp(0n, "r"),
    ];
    const c = channel([], [], ops);
    const seen: string[] = [];
    traverseChannel(c, (op) => seen.push(op.head));
    expect(seen).toEqual(["prepare", "ry", "observe"]);
  });

  test("visits cases op then trueArm then falseArm in order", () => {
    const c = channel(
      [],
      [wire(1n, "quantum", "qubit")],
      [
        prepareOp(rat(0n, 1n), 0n),
        prepareOp(rat(0n, 1n), 1n),
        observeOp(0n, "r"),
        casesOp(
          "r",
          [ryOp(1n, sym("a"), []), ryOp(1n, sym("b"), [])],
          [ryOp(1n, sym("c"), [])]
        ),
      ]
    );

    const seen: { head: string; depth: number; arm: string | null }[] = [];
    traverseChannel(c, (op, ctx) => {
      const last = ctx.branchPath[ctx.branchPath.length - 1];
      seen.push({
        head: op.head,
        depth: ctx.branchPath.length,
        arm: last ? last[0] : null,
      });
    });

    expect(seen).toEqual([
      { head: "prepare", depth: 0, arm: null },
      { head: "prepare", depth: 0, arm: null },
      { head: "observe", depth: 0, arm: null },
      { head: "cases", depth: 0, arm: null },
      { head: "ry", depth: 1, arm: "true" },
      { head: "ry", depth: 1, arm: "true" },
      { head: "ry", depth: 1, arm: "false" },
    ]);
  });

  test("branchPath includes index within the arm", () => {
    const c = channel(
      [],
      [wire(1n, "quantum", "qubit")],
      [
        prepareOp(rat(0n, 1n), 0n),
        prepareOp(rat(0n, 1n), 1n),
        observeOp(0n, "r"),
        casesOp(
          "r",
          [ryOp(1n, sym("a"), []), ryOp(1n, sym("b"), [])],
          []
        ),
      ]
    );
    const indices: number[] = [];
    traverseChannel(c, (op, ctx) => {
      if (op.head === "ry") {
        const last = ctx.branchPath[ctx.branchPath.length - 1]!;
        indices.push(last[1]);
      }
    });
    expect(indices).toEqual([0, 1]);
  });

  test("visitor not called for an empty body", () => {
    const c = channel([], [], []);
    let n = 0;
    traverseChannel(c, () => n++);
    expect(n).toBe(0);
  });
});
