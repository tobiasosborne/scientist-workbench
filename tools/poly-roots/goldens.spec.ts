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
  if (coef === -1n) return expr("neg", [xPow(k)]);
  return expr("*", [int(coef), xPow(k)]);
};

function poly(...terms: [bigint, bigint][]): Value {
  if (terms.length === 0) return int(0n);
  if (terms.length === 1) return term(terms[0]![0], terms[0]![1]);
  return expr("+", terms.map(([c, k]) => term(c, k)));
}

export const goldens: GoldenSpec[] = [
  { description: "linear: x − 3 ⟹ root 3", input: inp(poly([1n, 1n], [-3n, 0n])) },
  { description: "linear with content: 2x + 4 ⟹ root −2", input: inp(poly([2n, 1n], [4n, 0n])) },
  { description: "linear rational: 3x + 1 ⟹ root −1/3", input: inp(poly([3n, 1n], [1n, 0n])) },
  { description: "x² − 1 = (x − 1)(x + 1) ⟹ ±1", input: inp(poly([1n, 2n], [-1n, 0n])) },
  { description: "x² − 5x + 6 ⟹ 2, 3", input: inp(poly([1n, 2n], [-5n, 1n], [6n, 0n])) },
  { description: "x² + 1 — irreducible quadratic ⟹ ±i (sqrt(-1) form)", input: inp(poly([1n, 2n], [1n, 0n])) },
  { description: "x² − 2 ⟹ ±√2", input: inp(poly([1n, 2n], [-2n, 0n])) },
  { description: "x³ − 1 = (x − 1)(x² + x + 1) ⟹ 1 + cyclotomic pair", input: inp(poly([1n, 3n], [-1n, 0n])) },
  { description: "x³ − 6x² + 11x − 6 = (x−1)(x−2)(x−3) ⟹ 1, 2, 3", input: inp(poly([1n, 3n], [-6n, 2n], [11n, 1n], [-6n, 0n])) },
  { description: "x³ + x − 2 — irreducible cubic — Cardano", input: inp(poly([1n, 3n], [1n, 1n], [-2n, 0n])) },
  { description: "x⁴ − 1 ⟹ ±1, ±i (biquadratic)", input: inp(poly([1n, 4n], [-1n, 0n])) },
  { description: "x⁴ − 5x² + 4 = (x²−1)(x²−4) ⟹ ±1, ±2 (biquadratic)", input: inp(poly([1n, 4n], [-5n, 2n], [4n, 0n])) },
  { description: "x⁴ + 1 — irreducible quartic — Ferrari", input: inp(poly([1n, 4n], [1n, 0n])) },
  { description: "(x − 1)² ⟹ root 1 (multiplicity 2)", input: inp(poly([1n, 2n], [-2n, 1n], [1n, 0n])) },
  { description: "(x − 1)³ ⟹ root 1 (multiplicity 3)", input: inp(poly([1n, 3n], [-3n, 2n], [3n, 1n], [-1n, 0n])) },
  { description: "(x − 1)²(x + 1) — mixed multiplicity", input: inp(poly([1n, 3n], [-1n, 2n], [-1n, 1n], [1n, 0n])) },
  { description: "constant: f = 5 ⟹ no roots", input: inp(int(5n)) },
  { description: "deg-5 irreducible quintic ⟹ tagged degree-too-high", input: inp(poly([1n, 5n], [-2n, 1n], [-1n, 0n])) },
  { description: "non-polynomial: sin(x) ⟹ tagged non-polynomial", input: inp(expr("sin", [sym("x")])) },
  { description: "rational function: 1/x ⟹ tagged non-polynomial", input: inp(expr("/", [int(1n), sym("x")])) },
  { description: "multivariate: x·y ⟹ tagged multivariate", input: inp(expr("*", [sym("x"), sym("y")])) },
  { description: "(1/2)·(x² − 1) ⟹ ±1 (rational scaling)", input: inp(expr("*", [rat(1n, 2n), poly([1n, 2n], [-1n, 0n])])) },
];

void int;
void rat;
void record;
void sym;
