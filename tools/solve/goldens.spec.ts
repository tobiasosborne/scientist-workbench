import { expr, int, list, record, sym, type Value } from "@workbench/protocol";
import type { GoldenSpec } from "@workbench/contract";

// Coefficient negation lives in integer literals; `neg` head is
// out-of-vocabulary for valueToRatFn (Q[x] vocab: + - * / ^).
const xPow = (k: bigint, v = "x"): Value =>
  k === 1n ? sym(v) : expr("^", [sym(v), int(k)]);

const term = (coef: bigint, k: bigint, v = "x"): Value => {
  if (k === 0n) return int(coef);
  if (coef === 1n) return xPow(k, v);
  if (coef === -1n) return expr("*", [int(-1n), xPow(k, v)]);
  return expr("*", [int(coef), xPow(k, v)]);
};

function poly1(coefs: [bigint, bigint][], v = "x"): Value {
  if (coefs.length === 0) return int(0n);
  if (coefs.length === 1) return term(coefs[0]![0], coefs[0]![1], v);
  return expr("+", coefs.map(([c, k]) => term(c, k, v)));
}

function inp(eqs: Value[], vars: string[]): Value {
  return record({
    eqs: list(eqs),
    vars: list(vars.map((v) => sym(v))),
  });
}

export const goldens: GoldenSpec[] = [
  // ── Linear ────────────────────────────────────────────────────────────────
  {
    description: "linear unique: x + y = 3, x − y = 1 ⟹ x=2, y=1",
    input: inp(
      [
        // x + y - 3
        expr("+", [sym("x"), sym("y"), int(-3n)]),
        // x - y - 1
        expr("-", [expr("-", [sym("x"), sym("y")]), int(1n)]),
      ],
      ["x", "y"],
    ),
  },
  {
    description: "linear deg-1 single: 2x − 6 ⟹ x = 3",
    input: inp([poly1([[2n, 1n], [-6n, 0n]])], ["x"]),
  },
  {
    description: "linear deg-1 single rational: 3x + 1 ⟹ x = -1/3",
    input: inp([poly1([[3n, 1n], [1n, 0n]])], ["x"]),
  },
  {
    description: "linear inconsistent: x + y = 1, x + y = 2 ⟹ no solution",
    input: inp(
      [
        expr("+", [sym("x"), sym("y"), int(-1n)]),
        expr("+", [sym("x"), sym("y"), int(-2n)]),
      ],
      ["x", "y"],
    ),
  },
  {
    description: "linear under-determined: x + y = 3 in (x, y) ⟹ branch",
    input: inp([expr("+", [sym("x"), sym("y"), int(-3n)])], ["x", "y"]),
  },
  {
    description: "linear 3x3 unique: typical small system",
    input: inp(
      [
        // x + 2y + 3z - 6
        expr("+", [
          sym("x"),
          expr("*", [int(2n), sym("y")]),
          expr("*", [int(3n), sym("z")]),
          int(-6n),
        ]),
        // 2x + y + z - 4
        expr("+", [
          expr("*", [int(2n), sym("x")]),
          sym("y"),
          sym("z"),
          int(-4n),
        ]),
        // x - y + z - 1
        expr("+", [
          sym("x"),
          expr("*", [int(-1n), sym("y")]),
          sym("z"),
          int(-1n),
        ]),
      ],
      ["x", "y", "z"],
    ),
  },

  // ── Univariate polynomial ─────────────────────────────────────────────────
  {
    description: "univariate quadratic: x² − 5x + 6 ⟹ {2, 3}",
    input: inp([poly1([[1n, 2n], [-5n, 1n], [6n, 0n]])], ["x"]),
  },
  {
    description: "univariate quadratic irreducible: x² + 1 ⟹ ±i",
    input: inp([poly1([[1n, 2n], [1n, 0n]])], ["x"]),
  },
  {
    description: "univariate quadratic irrational roots: x² − 2 ⟹ ±√2",
    input: inp([poly1([[1n, 2n], [-2n, 0n]])], ["x"]),
  },
  {
    description: "univariate cubic with rational roots: x³ − x ⟹ {-1, 0, 1}",
    input: inp([poly1([[1n, 3n], [-1n, 1n]])], ["x"]),
  },
  {
    description: "univariate cubic factored: x³ − 1 = (x−1)(x²+x+1)",
    input: inp([poly1([[1n, 3n], [-1n, 0n]])], ["x"]),
  },
  {
    description: "univariate quartic biquadratic: x⁴ − 5x² + 4 ⟹ ±1, ±2",
    input: inp([poly1([[1n, 4n], [-5n, 2n], [4n, 0n]])], ["x"]),
  },
  {
    description: "univariate multiplicity: (x − 1)² = x² − 2x + 1 ⟹ x = 1 (×2)",
    input: inp([poly1([[1n, 2n], [-2n, 1n], [1n, 0n]])], ["x"]),
  },

  // ── Refusals ──────────────────────────────────────────────────────────────
  {
    description: "deg-5 irreducible quintic ⟹ tagged solve/high-degree-irreducible",
    // x⁵ + 2x + 2 (Eisenstein at p=2)
    input: inp([poly1([[1n, 5n], [2n, 1n], [2n, 0n]])], ["x"]),
  },
  {
    description: "transcendental sin(x) = 0 ⟹ branched: arcsin(0) + 2πk_1, π−arcsin(0) + 2πk_2",
    input: inp([expr("sin", [sym("x")])], ["x"]),
  },
  {
    description: "transcendental cos(x) − 1/2 = 0 ⟹ ±arccos(1/2) + 2πk",
    input: inp([expr("-", [expr("cos", [sym("x")]), expr("/", [int(1n), int(2n)])])], ["x"]),
  },
  {
    description: "transcendental exp(x) − 5 = 0 ⟹ x = log(5) (single branch)",
    input: inp([expr("-", [expr("exp", [sym("x")]), int(5n)])], ["x"]),
  },
  {
    description: "transcendental tan(x) = 0 ⟹ arctan(0) + π·k",
    input: inp([expr("tan", [sym("x")])], ["x"]),
  },
  {
    description: "transcendental abs(x) − 3 = 0 ⟹ x ∈ {3, -3}",
    input: inp([expr("-", [expr("abs", [sym("x")]), int(3n)])], ["x"]),
  },
  {
    description: "compound: sin(2x) = 0 ⟹ x = (arcsin(0) + 2πk_0)/2 ∨ x = (π − arcsin(0) + 2πk_1)/2",
    input: inp([expr("sin", [expr("*", [int(2n), sym("x")])])], ["x"]),
  },
  {
    description: "compound: exp(3x + 1) = 5 ⟹ x = (log(5) − 1) / 3",
    input: inp([
      expr("-", [
        expr("exp", [expr("+", [expr("*", [int(3n), sym("x")]), int(1n)])]),
        int(5n),
      ]),
    ], ["x"]),
  },
  {
    description: "rational function: 1/x = 0 ⟹ tagged solve/foreign-vocabulary",
    input: inp([expr("/", [int(1n), sym("x")])], ["x"]),
  },
  {
    description: "bilinear: x · y = 1 ⟹ tagged solve/multivariate-non-zero-dim",
    input: inp(
      [expr("-", [expr("*", [sym("x"), sym("y")]), int(1n)])],
      ["x", "y"],
    ),
  },
  {
    description: "circle: x² + y² = 1 ⟹ tagged solve/multivariate-non-zero-dim",
    input: inp(
      [expr("+", [
        expr("^", [sym("x"), int(2n)]),
        expr("^", [sym("y"), int(2n)]),
        int(-1n),
      ])],
      ["x", "y"],
    ),
  },
  {
    description: "parametric: a·x − 1 in solve-for-x ⟹ tagged solve/parametric-non-trivial",
    input: inp(
      [expr("-", [expr("*", [sym("a"), sym("x")]), int(1n)])],
      ["x"],
    ),
  },
  {
    description: "constant equation: 5 = 0 in x ⟹ tagged solve/constant-equation",
    input: inp([int(5n)], ["x"]),
  },
];

void int;
void list;
void record;
void sym;
