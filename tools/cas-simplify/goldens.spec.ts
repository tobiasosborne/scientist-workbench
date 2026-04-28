import { bool, expr, int, list, rat, str, sym, tagged } from "@workbench/protocol";
import type { GoldenSpec } from "@workbench/contract";
import { SIMPLIFY_TAG } from "@workbench/cas-core";

void str;
void list;
void SIMPLIFY_TAG;

export const goldens: GoldenSpec[] = [
  { description: "integer leaf", input: int(0n) },
  { description: "negative integer leaf", input: int(-3n) },
  { description: "rational leaf", input: rat(2n, 3n) },
  { description: "symbol leaf", input: sym("x") },
  { description: "1 + 1 = 2", input: expr("+", [int(1n), int(1n)]) },
  { description: "x + 0 = x", input: expr("+", [sym("x"), int(0n)]) },
  { description: "x - x = 0", input: expr("-", [sym("x"), sym("x")]) },
  { description: "0 * x = 0", input: expr("*", [int(0n), sym("x")]) },
  { description: "1 * x = x", input: expr("*", [int(1n), sym("x")]) },
  { description: "x * 1 = x", input: expr("*", [sym("x"), int(1n)]) },
  { description: "double negation", input: expr("-", [expr("-", [sym("x")])]) },
  { description: "(x+1)*(x-1) expands", input: expr("*", [expr("+", [sym("x"), int(1n)]), expr("-", [sym("x"), int(1n)])]) },
  { description: "(x+1)^2 expands", input: expr("^", [expr("+", [sym("x"), int(1n)]), int(2n)]) },
  { description: "(x+1)^3 expands", input: expr("^", [expr("+", [sym("x"), int(1n)]), int(3n)]) },
  { description: "x^0 = 1", input: expr("^", [sym("x"), int(0n)]) },
  { description: "x^1 = x", input: expr("^", [sym("x"), int(1n)]) },
  { description: "rational coefficient survives", input: expr("*", [rat(3n, 4n), sym("x")]) },
  { description: "rational + rational coefficient", input: expr("+", [expr("*", [rat(1n, 2n), sym("x")]), expr("*", [rat(1n, 3n), sym("x")])]) },
  { description: "two-variable monomial", input: expr("*", [sym("x"), sym("y")]) },
  { description: "two-variable expansion", input: expr("*", [expr("+", [sym("x"), sym("y")]), expr("+", [sym("x"), sym("y")])]) },
  { description: "rational function unreduced", input: expr("/", [expr("-", [expr("^", [sym("x"), int(2n)]), int(1n)]), expr("-", [sym("x"), int(1n)])]) },
  { description: "1/x stays as 1/x", input: expr("/", [int(1n), sym("x")]) },
  { description: "x/y stays as x/y", input: expr("/", [sym("x"), sym("y")]) },
  { description: "(x/y) + 1 = (x+y)/y", input: expr("+", [expr("/", [sym("x"), sym("y")]), int(1n)]) },
  { description: "negative coefficient", input: expr("*", [int(-2n), sym("x")]) },
  { description: "additive inverse via -", input: expr("-", [int(0n), sym("x")]) },
  { description: "unknown head wraps", input: expr("sin", [sym("x")]) },
  { description: "unknown head with simplifiable arg", input: expr("sin", [expr("+", [sym("x"), sym("x")])]) },
  { description: "unknown head with deeper structure", input: expr("matmul", [sym("A"), expr("+", [sym("B"), sym("B")])]) },
  { description: "tagged passes through inside out-of-scope", input: expr("foo", [tagged("foreign", int(7n))]) },
  { description: "string leaf is out of scope (cas does not interpret strings)", input: { kind: "string", value: "hello" } },
  { description: "boolean leaf is out of scope", input: bool(true) },
  { description: "list leaf wraps as out-of-scope", input: { kind: "list", items: [int(1n), int(2n)] } },
  { description: "x^2 - 2*x + 1 stays as a sum of monomials", input: expr("+", [expr("^", [sym("x"), int(2n)]), expr("-", [int(0n), expr("*", [int(2n), sym("x")])]), int(1n)]) },
  { description: "(a+b)^2 = a^2 + 2ab + b^2", input: expr("^", [expr("+", [sym("a"), sym("b")]), int(2n)]) },
];
