import { expr, int, rat, record, sym, type Value } from "@workbench/protocol";
import type { GoldenSpec } from "@workbench/contract";

const x = sym("x");

function inp(f: Value): Value {
  return record({ f, var: x });
}

const xPow = (k: bigint): Value =>
  k === 1n ? sym("x") : expr("^", [sym("x"), int(k)]);

const term = (coef: bigint, k: bigint): Value => {
  if (k === 0n) return int(coef);
  if (coef === 1n) return xPow(k);
  if (coef === -1n) return expr("*", [int(-1n), xPow(k)]);
  return expr("*", [int(coef), xPow(k)]);
};

function poly(...terms: [bigint, bigint][]): Value {
  if (terms.length === 0) return int(0n);
  if (terms.length === 1) return term(terms[0]![0], terms[0]![1]);
  return expr("+", terms.map(([c, k]) => term(c, k)));
}

export const goldens: GoldenSpec[] = [
  { description: "linear: 2x − 4 ⟹ singleton at 2", input: inp(poly([2n, 1n], [-4n, 0n])) },
  { description: "linear rational: 3x − 1 ⟹ open (0, 1)", input: inp(poly([3n, 1n], [-1n, 0n])) },
  { description: "x² − 2 ⟹ open intervals around ±√2", input: inp(poly([1n, 2n], [-2n, 0n])) },
  { description: "x² + 1 — no real roots ⟹ empty list", input: inp(poly([1n, 2n], [1n, 0n])) },
  { description: "x² − 5x + 6 ⟹ singletons at 2 and 3", input: inp(poly([1n, 2n], [-5n, 1n], [6n, 0n])) },
  { description: "x³ − 3x + 1 — casus irreducibilis ⟹ 3 open intervals", input: inp(poly([1n, 3n], [-3n, 1n], [1n, 0n])) },
  { description: "x³ − x ⟹ singletons at -1, 0, 1 (root at zero)", input: inp(poly([1n, 3n], [-1n, 1n])) },
  { description: "x⁴ − 1 ⟹ ±1 singletons (no real ±i)", input: inp(poly([1n, 4n], [-1n, 0n])) },
  { description: "T_4 = 8x⁴ − 8x² + 1 ⟹ 4 irrationals in (-1, 1)", input: inp(poly([8n, 4n], [-8n, 2n], [1n, 0n])) },
  { description: "(x − 1)² ⟹ tagged not-squarefree", input: inp(poly([1n, 2n], [-2n, 1n], [1n, 0n])) },
  { description: "(x − 1)²(x + 1) ⟹ tagged not-squarefree", input: inp(poly([1n, 3n], [-1n, 2n], [-1n, 1n], [1n, 0n])) },
  { description: "constant: f = 5 ⟹ empty interval list", input: inp(int(5n)) },
  { description: "non-polynomial: sin(x) ⟹ tagged non-polynomial", input: inp(expr("sin", [sym("x")])) },
  { description: "rational function: 1/x ⟹ tagged non-polynomial", input: inp(expr("/", [int(1n), sym("x")])) },
  { description: "multivariate: x·y ⟹ tagged multivariate", input: inp(expr("*", [sym("x"), sym("y")])) },
];

void int;
void rat;
void record;
void sym;
