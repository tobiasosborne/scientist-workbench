// cas-simplify — canonicalise an expression value over Q[x_1,...,x_n] / Q(x_1,...,x_n).
// Foreign subterms (heads outside +-*/^, non-numeric leaves, tagged values, etc.)
// are wrapped in `tagged "cas-simplify/out-of-scope"`, with their children
// recursively simplified where possible. See PRD §2.3.
//
// No polynomial GCD: (x^2 - 1)/(x - 1) is NOT reduced to x + 1. Use cas-verify
// (which uses cross-multiplication) to decide that equality, or wait for cas-reduce.

import {
  bool,
  canonicalize,
  expr,
  hash,
  int,
  list,
  rat as protocolRat,
  record,
  str,
  sym,
  tagged,
  type Value,
} from "@workbench/protocol";
import { runTool } from "@workbench/contract";
import { casSimplify, SIMPLIFY_TAG } from "@workbench/cas-core";

const NAME = "cas-simplify";
const VERSION = "0.2.0";

void runTool({
  name: NAME,
  version: VERSION,
  schema: {
    input: expr("<arithmetic expression over Q with symbol indeterminates>", []),
    output: expr("<canonical sum-of-monomials, or num/den ratfn, or tagged out-of-scope>", []),
  },
  examples: [
    {
      description: "literal collapses",
      input: expr("+", [int(1n), int(1n)]),
      output: int(2n),
    },
    {
      description: "(x+1)(x-1) expands",
      input: expr("*", [expr("+", [sym("x"), int(1n)]), expr("-", [sym("x"), int(1n)])]),
      output: expr("+", [expr("^", [sym("x"), int(2n)]), int(-1n)]),
    },
    {
      description: "rational coefficient survives",
      input: expr("*", [protocolRat(3n, 4n), sym("x")]),
      output: expr("*", [protocolRat(3n, 4n), sym("x")]),
    },
    {
      description: "x - x simplifies to 0",
      input: expr("-", [sym("x"), sym("x")]),
      output: int(0n),
    },
    {
      description: "double negative",
      input: expr("-", [expr("-", [sym("x")])]),
      output: sym("x"),
    },
    {
      description: "unknown head wraps as tagged out-of-scope",
      input: expr("sin", [sym("x")]),
      output: tagged(SIMPLIFY_TAG, expr("sin", [sym("x")])),
    },
    {
      description: "out-of-scope still simplifies arithmetic children",
      input: expr("sin", [expr("+", [sym("x"), sym("x")])]),
      output: tagged(SIMPLIFY_TAG, expr("sin", [expr("*", [int(2n), sym("x")])])),
    },
    {
      description: "rational function does not reduce by GCD",
      input: expr("/", [
        expr("-", [expr("^", [sym("x"), int(2n)]), int(1n)]),
        expr("-", [sym("x"), int(1n)]),
      ]),
      output: expr("/", [
        expr("+", [expr("^", [sym("x"), int(2n)]), int(-1n)]),
        expr("+", [sym("x"), int(-1n)]),
      ]),
    },
  ],
  invariants: [
    { name: "idempotent", statement: "simplify(simplify(v)) = simplify(v)", machine_checkable: true },
    { name: "deterministic", statement: "same input → same output bytes", machine_checkable: true },
    {
      name: "foreign-pass-through",
      statement: "out-of-scope subterms preserved verbatim inside `tagged \"cas-simplify/out-of-scope\"`",
      machine_checkable: true,
    },
    {
      name: "no-gcd-reduction",
      statement: "rational functions are NOT reduced by polynomial GCD (use cas-verify or wait for cas-reduce)",
      machine_checkable: false,
    },
  ],
  fn: (input: Value, _flags: Record<string, string>): Value => casSimplify(input),
  test: () => {
    const probes: Value[] = [
      int(0n),
      sym("x"),
      expr("+", [int(1n), int(1n)]),
      expr("*", [expr("+", [sym("x"), int(1n)]), expr("-", [sym("x"), int(1n)])]),
      expr("sin", [sym("x")]),
    ];
    for (const v of probes) {
      const a = canonicalize(casSimplify(v));
      const b = canonicalize(casSimplify(casSimplify(v)));
      if (a !== b) {
        throw new Error(`cas-simplify not idempotent on ${JSON.stringify(v)}`);
      }
      const ha = hash(casSimplify(v));
      const hb = hash(casSimplify(v));
      if (ha !== hb) throw new Error(`cas-simplify not deterministic`);
    }
    void list;
    void record;
    void bool;
    void str;
  },
});
