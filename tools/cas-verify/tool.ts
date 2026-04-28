// cas-verify — decide A = B as elements of Q(x_1,...,x_n).
// Input:  record { lhs: Value, rhs: Value }
// Output: record { equal: boolean, reason?: string, witness?: Value, side?: string, detail?: string }
//
// Equality is decided by cross-multiplication: a/b = c/d  iff  a*d - c*b = 0
// in Q[x_1,...,x_n]. Sound and complete because Q[x_1,...,x_n] is an integral
// domain (PRD §9.3); no polynomial GCD needed.

import {
  bool,
  expr,
  int,
  rat as protocolRat,
  record,
  str,
  sym,
  ToolError,
  type Value,
} from "@workbench/protocol";
import { runTool } from "@workbench/contract";
import { casVerify } from "@workbench/cas-core";

const NAME = "cas-verify";
const VERSION = "0.2.0";

void runTool({
  name: NAME,
  version: VERSION,
  schema: {
    input: record({ lhs: expr("<lhs>", []), rhs: expr("<rhs>", []) }),
    output: record({
      equal: bool(true),
      reason: str("optional: not-equal | out-of-scope"),
      witness: expr("<lhs - rhs canonical form, present iff equal=false and reason=not-equal>", []),
      side: str("optional: lhs | rhs (present iff reason=out-of-scope)"),
      detail: str("optional: explanation for out-of-scope"),
    }),
  },
  examples: [
    {
      description: "trivial identity",
      input: record({ lhs: sym("x"), rhs: sym("x") }),
      output: record({ equal: bool(true) }),
    },
    {
      description: "(x^2 - 1)/(x - 1) = x + 1 — verified despite no GCD reduction",
      input: record({
        lhs: expr("/", [
          expr("-", [expr("^", [sym("x"), int(2n)]), int(1n)]),
          expr("-", [sym("x"), int(1n)]),
        ]),
        rhs: expr("+", [sym("x"), int(1n)]),
      }),
      output: record({ equal: bool(true) }),
    },
    {
      description: "(x+1)^2 expands to x^2 + 2x + 1",
      input: record({
        lhs: expr("^", [expr("+", [sym("x"), int(1n)]), int(2n)]),
        rhs: expr("+", [
          expr("^", [sym("x"), int(2n)]),
          expr("*", [int(2n), sym("x")]),
          int(1n),
        ]),
      }),
      output: record({ equal: bool(true) }),
    },
    {
      description: "inequality emits a witness for lhs - rhs",
      input: record({
        lhs: expr("+", [sym("x"), int(1n)]),
        rhs: expr("+", [sym("x"), int(2n)]),
      }),
      output: record({ equal: bool(false), reason: str("not-equal"), witness: int(-1n) }),
    },
    {
      description: "rational coefficient algebra",
      input: record({
        lhs: expr("+", [expr("*", [protocolRat(1n, 2n), sym("x")]), expr("*", [protocolRat(1n, 2n), sym("x")])]),
        rhs: sym("x"),
      }),
      output: record({ equal: bool(true) }),
    },
    {
      description: "out-of-scope: lhs has unknown head sin",
      input: record({ lhs: expr("sin", [sym("x")]), rhs: sym("x") }),
      output: record({
        detail: str("unknown head \"sin\""),
        equal: bool(false),
        reason: str("out-of-scope"),
        side: str("lhs"),
      }),
    },
  ],
  invariants: [
    { name: "soundness", statement: "if equal=true then lhs and rhs denote the same element of Q(x)", machine_checkable: false },
    { name: "completeness-in-scope", statement: "if both sides are in scope and lhs≡rhs in Q(x), then equal=true", machine_checkable: false },
    { name: "symmetry", statement: "verify(a,b).equal = verify(b,a).equal whenever both sides are in scope", machine_checkable: true },
    { name: "deterministic", statement: "same input → same output bytes", machine_checkable: true },
    { name: "honest-scope", statement: "out-of-scope inputs return equal=false with reason='out-of-scope', not a wrong answer", machine_checkable: false },
  ],
  fn: (input: Value, _flags: Record<string, string>): Value => {
    if (input.kind !== "record") {
      throw new ToolError(`cas-verify: input must be a record {lhs, rhs} (got kind ${input.kind})`, {
        suggestion: "wrap as {\"kind\":\"record\",\"fields\":{\"lhs\":<expr>,\"rhs\":<expr>}}",
      });
    }
    const lhs = input.fields["lhs"];
    const rhs = input.fields["rhs"];
    if (!lhs) throw new ToolError("cas-verify: missing field 'lhs'", {});
    if (!rhs) throw new ToolError("cas-verify: missing field 'rhs'", {});
    return casVerify({ lhs, rhs });
  },
});
