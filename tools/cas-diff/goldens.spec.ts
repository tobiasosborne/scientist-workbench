import { expr, int, rat, record, sym } from "@workbench/protocol";
import type { GoldenSpec } from "@workbench/contract";

// Per-tool goldens. `bun scripts/generate-goldens.ts` runs the tool
// against each input and writes the canonical `{input, output}` record
// into goldens/. The corpus below covers every rule branch (atoms,
// linearity, product, quotient, power × {const-exp, const-base,
// general}, six transcendentals + abs, chain rule) plus the demo
// motivation (`scripts/demo-min-integral.ts`'s integrand differentiated
// wrt `a`) and the two out-of-scope refusal classes.

const x = sym("x");
const y = sym("y");
const a = sym("a");

export const goldens: GoldenSpec[] = [
  // Atoms
  { description: "d(7)/dx = 0", input: record({ f: int(7n), var: x }) },
  { description: "d(3/7)/dx = 0", input: record({ f: rat(3n, 7n), var: x }) },
  { description: "d(pi)/dx = 0", input: record({ f: sym("pi"), var: x }) },
  { description: "d(x)/dx = 1", input: record({ f: x, var: x }) },
  { description: "d(y)/dx = 0", input: record({ f: y, var: x }) },

  // Sum / difference / neg
  { description: "d(x + y)/dx = 1", input: record({ f: expr("+", [x, y]), var: x }) },
  { description: "d(x - y)/dx = 1", input: record({ f: expr("-", [x, y]), var: x }) },
  { description: "d(y - x)/dx = neg(1)", input: record({ f: expr("-", [y, x]), var: x }) },
  { description: "d(-x)/dx = neg(1) (unary minus)", input: record({ f: expr("-", [x]), var: x }) },
  { description: "d(neg(x))/dx = neg(1)", input: record({ f: expr("neg", [x]), var: x }) },
  { description: "d(neg(neg(x)))/dx = 1 (double-negation collapses)",
    input: record({ f: expr("neg", [expr("neg", [x])]), var: x }) },

  // Product rule
  { description: "d(2·x)/dx = 2", input: record({ f: expr("*", [int(2n), x]), var: x }) },
  { description: "d(x·y)/dx = y", input: record({ f: expr("*", [x, y]), var: x }) },
  { description: "d(x·x)/dx = x + x  (product rule, no like-term combine)",
    input: record({ f: expr("*", [x, x]), var: x }) },

  // Quotient rule
  { description: "d(1/x)/dx = -1/x²", input: record({ f: expr("/", [int(1n), x]), var: x }) },
  { description: "d(x/(x²-49))/dx (the demo's denominator pattern)",
    input: record({
      f: expr("/", [x, expr("+", [expr("^", [x, int(2n)]), int(-49n)])]),
      var: x,
    }) },

  // Power rule branches
  { description: "d(x²)/dx = 2x  (constant exponent)",
    input: record({ f: expr("^", [x, int(2n)]), var: x }) },
  { description: "d(x³)/dx = 3·x²", input: record({ f: expr("^", [x, int(3n)]), var: x }) },
  { description: "d(x^(3/2))/dx (rational exponent)",
    input: record({ f: expr("^", [x, rat(3n, 2n)]), var: x }) },
  { description: "d(2^x)/dx = 2^x · log(2)  (exp rule)",
    input: record({ f: expr("^", [int(2n), x]), var: x }) },

  // Transcendentals
  { description: "d(sin(x))/dx = cos(x)", input: record({ f: expr("sin", [x]), var: x }) },
  { description: "d(cos(x))/dx = neg(sin(x))", input: record({ f: expr("cos", [x]), var: x }) },
  { description: "d(tan(x))/dx = 1/cos(x)²", input: record({ f: expr("tan", [x]), var: x }) },
  { description: "d(exp(x))/dx = exp(x)", input: record({ f: expr("exp", [x]), var: x }) },
  { description: "d(log(x))/dx = 1/x", input: record({ f: expr("log", [x]), var: x }) },
  { description: "d(sqrt(x))/dx = 1/(2·sqrt(x))", input: record({ f: expr("sqrt", [x]), var: x }) },
  { description: "d(|x|)/dx = x/|x|", input: record({ f: expr("abs", [x]), var: x }) },

  // Chain rule
  { description: "d(sin(2·x))/dx (chain rule, smart-constructor folds the constant factor)",
    input: record({ f: expr("sin", [expr("*", [int(2n), x])]), var: x }) },
  { description: "d(exp(-x²))/dx (chain rule with neg + power)",
    input: record({
      f: expr("exp", [expr("neg", [expr("^", [x, int(2n)])])]),
      var: x,
    }) },

  // Multivariate (the demo motivation)
  { description: "d(p(x,a))/da on the demo's full integrand",
    input: record({
      f: expr("/", [
        expr("*", [
          expr("*", [
            expr("-", [int(1n), expr("*", [a, x])]),
            expr("+", [int(2n), x]),
          ]),
          expr("+", [rat(3n, 7n), expr("*", [a, x])]),
        ]),
        expr("+", [expr("^", [x, int(2n)]), int(-49n)]),
      ]),
      var: a,
    }) },

  // Out-of-scope refusals
  { description: "unknown head (gamma) → tagged out-of-scope",
    input: record({ f: expr("gamma", [x]), var: x }) },
  { description: "deeply nested unknown head (erf) → tagged out-of-scope",
    input: record({ f: expr("+", [x, expr("erf", [x])]), var: x }) },
];
