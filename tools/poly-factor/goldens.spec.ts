import { expr, int, rat, record, sym, type Value } from "@workbench/protocol";
import type { GoldenSpec } from "@workbench/contract";

const x = sym("x");

/** `record { f, var: x }`. */
function inp(f: Value): Value {
  return record({ f, var: x });
}

// Polynomial expression builders for the goldens.
const xPow = (k: bigint): Value =>
  k === 1n ? sym("x") : expr("^", [sym("x"), int(k)]);

// Coefficient negation lives in the integer literal — `neg` head is
// out-of-vocabulary for `valueToRatFn` (which accepts only `+ - * / ^`).
const term = (coef: bigint, k: bigint): Value => {
  if (k === 0n) return int(coef);
  if (coef === 1n) return xPow(k);
  if (coef === -1n) return expr("*", [int(-1n), xPow(k)]);
  return expr("*", [int(coef), xPow(k)]);
};

/** Sum of (coef, power) pairs into an `+`-headed expression. */
function poly(...terms: [bigint, bigint][]): Value {
  if (terms.length === 0) return int(0n);
  if (terms.length === 1) return term(terms[0]![0], terms[0]![1]);
  // For + we don't need to handle negatives specially — `int(-3n)` is valid.
  return expr("+", terms.map(([c, k]) => term(c, k)));
}

export const goldens: GoldenSpec[] = [
  // ── A. shape edges ────────────────────────────────────────────────────────
  {
    description: "constant: f = 5",
    input: inp(int(5n)),
  },
  {
    description: "linear monic: x − 3",
    input: inp(poly([1n, 1n], [-3n, 0n])),
  },
  {
    description: "linear with content: 2x + 4",
    input: inp(poly([2n, 1n], [4n, 0n])),
  },
  {
    description: "x² + 1 — irreducible deg-2 over ℚ",
    input: inp(poly([1n, 2n], [1n, 0n])),
  },
  {
    description: "x² − 4 — splits into two linear factors",
    input: inp(poly([1n, 2n], [-4n, 0n])),
  },
  // ── B. random low-degree primitive ────────────────────────────────────────
  {
    description: "x² + 5x + 6 = (x+2)(x+3)",
    input: inp(poly([1n, 2n], [5n, 1n], [6n, 0n])),
  },
  {
    description: "x³ − 1 = (x − 1)(x² + x + 1)",
    input: inp(poly([1n, 3n], [-1n, 0n])),
  },
  {
    description: "x³ + 2x² − 5x − 6 = (x+3)(x+1)(x−2)",
    input: inp(poly([1n, 3n], [2n, 2n], [-5n, 1n], [-6n, 0n])),
  },
  {
    description: "x⁴ − 1 = (x−1)(x+1)(x²+1)",
    input: inp(poly([1n, 4n], [-1n, 0n])),
  },
  {
    description: "x⁴ + 1 — irreducible deg-4 over ℚ",
    input: inp(poly([1n, 4n], [1n, 0n])),
  },
  {
    description: "x⁵ − x⁴ − 2x³ + 2x² + x − 1 = (x − 1)³(x + 1)²",
    input: inp(poly([1n, 5n], [-1n, 4n], [-2n, 3n], [2n, 2n], [1n, 1n], [-1n, 0n])),
  },
  // ── C. cyclotomics ────────────────────────────────────────────────────────
  {
    description: "Φ₃ = x² + x + 1 — irreducible cyclotomic",
    input: inp(poly([1n, 2n], [1n, 1n], [1n, 0n])),
  },
  {
    description: "Φ₅ = x⁴ + x³ + x² + x + 1 — irreducible cyclotomic",
    input: inp(poly([1n, 4n], [1n, 3n], [1n, 2n], [1n, 1n], [1n, 0n])),
  },
  {
    description: "Φ₈ = x⁴ + 1 — irreducible cyclotomic",
    input: inp(poly([1n, 4n], [1n, 0n])),
  },
  {
    description: "Φ₁₂ = x⁴ − x² + 1 — irreducible cyclotomic",
    input: inp(poly([1n, 4n], [-1n, 2n], [1n, 0n])),
  },
  // ── E. square-laden ───────────────────────────────────────────────────────
  {
    description: "(x − 1)² = x² − 2x + 1",
    input: inp(poly([1n, 2n], [-2n, 1n], [1n, 0n])),
  },
  {
    description: "(x − 1)³ = x³ − 3x² + 3x − 1",
    input: inp(poly([1n, 3n], [-3n, 2n], [3n, 1n], [-1n, 0n])),
  },
  {
    description: "(x − 1)²(x + 1)² = x⁴ − 2x² + 1",
    input: inp(poly([1n, 4n], [-2n, 2n], [1n, 0n])),
  },
  // ── F. larger coefficients ────────────────────────────────────────────────
  {
    description: "(x − 10)(x + 10) = x² − 100",
    input: inp(poly([1n, 2n], [-100n, 0n])),
  },
  {
    description: "(x − 7)(x + 13)(x − 5) = x³ + x² − 121x + 455",
    input: inp(poly([1n, 3n], [1n, 2n], [-121n, 1n], [455n, 0n])),
  },
  // ── G. content / scaling ──────────────────────────────────────────────────
  {
    description: "7·(x − 1) = 7x − 7",
    input: inp(poly([7n, 1n], [-7n, 0n])),
  },
  {
    description: "−5·(x³ − 1) = −5x³ + 5",
    input: inp(poly([-5n, 3n], [5n, 0n])),
  },
  {
    description: "(2/3)·(x² + x + 1) — rational content",
    input: inp(expr("*", [
      rat(2n, 3n),
      poly([1n, 2n], [1n, 1n], [1n, 0n]),
    ])),
  },
  // ── H. refusals ───────────────────────────────────────────────────────────
  {
    description: "non-polynomial: sin(x) → tagged out-of-scope",
    input: inp(expr("sin", [sym("x")])),
  },
  {
    description: "rational function: 1/x → tagged out-of-scope",
    input: inp(expr("/", [int(1n), sym("x")])),
  },
  {
    description: "transcendental: exp(x) → tagged out-of-scope",
    input: inp(expr("exp", [sym("x")])),
  },
  {
    description: "multivariate: x·y → tagged out-of-scope",
    input: inp(expr("*", [sym("x"), sym("y")])),
  },
];

void int;
void rat;
void record;
void sym;
