// =============================================================================
// cas-verify — decide A = B as elements of Q(x_1, ..., x_n)
// =============================================================================
//
// Equality is decided by cross-multiplication: a/b = c/d iff
// a·d − c·b = 0 in Q[x_1, ..., x_n]. Sound and complete because
// Q[x_1, ..., x_n] is an integral domain (PRD §9.3); no polynomial
// GCD needed.
//
// Schema (ADR-0004)
// -----------------
// Input: record { lhs: any, rhs: any }. Both fields are intentionally
// `S.any()` — the in-scope set is "anything cas-core's expression
// bridge can interpret as a Q(x)-element," and the out-of-scope path
// is part of the contract (record-with-flag, ADR-0003). Tightening
// the schema to "expression" would lose the leaf cases (a single
// integer, a bare symbol).
//
// Output: record-with-flag (ADR-0003). `equal` is always present.
// `reason`, `witness`, `side`, `detail` are conditional and modelled
// as schema-level optionals.

import { bool, expr, int, rat as protocolRat, record, S, str, sym } from "@workbench/protocol";
import { defineTool, runTool } from "@workbench/contract";
import { casVerify } from "@workbench/cas-core";

const NAME = "cas-verify";
const VERSION = "0.3.0";

const inputSchema = S.record({ lhs: S.any(), rhs: S.any() });

// `equal` always present; the others are conditional on the equality
// outcome and the scope. The runner enforces "no extra fields" and
// "all required fields present" so every output of fn must hit this
// shape exactly — a tool that forgot to emit `equal` would fail loud.
const outputSchema = S.record(
  {
    equal: S.kind("boolean"),
    reason: S.union([S.literal(str("not-equal")), S.literal(str("out-of-scope"))]),
    witness: S.any(),
    side: S.union([S.literal(str("lhs")), S.literal(str("rhs"))]),
    detail: S.kind("string"),
  },
  { optional: ["reason", "witness", "side", "detail"] }
);

export const def = defineTool({
  name: NAME,
  version: VERSION,
  schema: { input: inputSchema, output: outputSchema },
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
  fn: (input, _flags) => {
    // Schema runner has already validated `input` is a record
    // {lhs, rhs}. The fields are typed `Value`, no further unwrapping.
    return casVerify({ lhs: input.fields.lhs, rhs: input.fields.rhs });
  },
});

if (import.meta.main) void runTool(def);
