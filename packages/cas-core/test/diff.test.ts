// =============================================================================
// diff.test.ts — property tests for the symbolic differentiator
// =============================================================================
//
// Two layers:
//
// 1. Rule-by-rule unit tests. For each head in the table, build a small
//    expression and assert that `differentiate` returns the expected
//    closed form (asserted by structural equality on canonicalised
//    output, so smart-constructor identities are baked in).
//
// 2. Property-style numerical cross-check. For a corpus of expressions
//    that are differentiable on R\{0}, evaluate `differentiate(f, x)`
//    at random points using `evalNumericExpr`, and compare to a centred
//    finite-difference of `f` at the same points. Centred FD has
//    truncation error O(h²); for h = 1e-6 and float64 round-off we
//    expect agreement to within ~1e-7 relative — we test against 1e-6
//    to leave headroom for the badly-conditioned probes.
//
// Mutation-prove: each rule's test is small enough that a typo in the
// rule (e.g., dropping the chain-rule factor, swapping numerator and
// denominator in the quotient rule, missing the negative sign on cos)
// fails one or more cases. The numerical cross-check is the
// independent oracle — same algorithm property tested through a
// completely orthogonal computation (FD of the original function).

import { describe, expect, test } from "bun:test";
import { canonicalize, expr, float64FromNumber, int, rat, sym, type Value } from "@workbench/protocol";
import { evalNumericExpr } from "@workbench/quadrature";
import {
  CasDiffOutOfScopeError,
  DIFF_ADMITTED_HEADS,
  differentiate,
} from "../src/diff.js";

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

const x = sym("x");
const y = sym("y");

function eq(a: Value, b: Value): boolean {
  return canonicalize(a) === canonicalize(b);
}

/** Convenience: differentiate wrt `x`. */
function diff(e: Value, wrt = x): Value {
  return differentiate(e, wrt);
}

// -----------------------------------------------------------------------------
// Rule-by-rule unit tests
// -----------------------------------------------------------------------------

describe("differentiate — atoms and variables", () => {
  test("d(integer)/dx = 0", () => {
    expect(eq(diff(int(7n)), int(0n))).toBe(true);
    expect(eq(diff(int(-3n)), int(0n))).toBe(true);
  });

  test("d(rational)/dx = 0", () => {
    expect(eq(diff(rat(3n, 7n)), int(0n))).toBe(true);
  });

  test("d(float64)/dx = 0", () => {
    expect(eq(diff(float64FromNumber(2.5)), int(0n))).toBe(true);
  });

  test("d(pi)/dx = 0; d(e)/dx = 0", () => {
    expect(eq(diff(sym("pi")), int(0n))).toBe(true);
    expect(eq(diff(sym("e")), int(0n))).toBe(true);
  });

  test("d(x)/dx = 1; d(y)/dx = 0", () => {
    expect(eq(diff(x), int(1n))).toBe(true);
    expect(eq(diff(y), int(0n))).toBe(true);
  });

  test("namespaced symbols are distinct from bare ones", () => {
    const xNS = sym("x", "ns");
    expect(eq(diff(xNS), int(0n))).toBe(true);
    expect(eq(differentiate(x, xNS), int(0n))).toBe(true);
  });
});

describe("differentiate — sum, difference, neg", () => {
  test("linearity: d(x + y)/dx = 1 + 0 (smart-constructed to 1)", () => {
    expect(eq(diff(expr("+", [x, y])), int(1n))).toBe(true);
  });

  test("d(x - y)/dx = 1 (smart-constructed: 1 - 0 = 1)", () => {
    expect(eq(diff(expr("-", [x, y])), int(1n))).toBe(true);
  });

  test("d(y - x)/dx = -1 (smart-constructed: 0 - 1 = neg(1))", () => {
    expect(eq(diff(expr("-", [y, x])), expr("neg", [int(1n)]))).toBe(true);
  });

  test("d(-x)/dx = -1 (unary minus)", () => {
    expect(eq(diff(expr("-", [x])), expr("neg", [int(1n)]))).toBe(true);
  });

  test("d(neg(x))/dx = neg(1)", () => {
    expect(eq(diff(expr("neg", [x])), expr("neg", [int(1n)]))).toBe(true);
  });

  test("d(neg(neg(x)))/dx = 1 (double negation collapses)", () => {
    expect(eq(diff(expr("neg", [expr("neg", [x])])), int(1n))).toBe(true);
  });

  test("multi-arg sum: d(x + y + 7)/dx = 1", () => {
    expect(eq(diff(expr("+", [x, y, int(7n)])), int(1n))).toBe(true);
  });
});

describe("differentiate — product rule", () => {
  test("d(2·x)/dx = 2 (constant·variable)", () => {
    expect(eq(diff(expr("*", [int(2n), x])), int(2n))).toBe(true);
  });

  test("d(x·y)/dx = y (other factor is treated as constant)", () => {
    expect(eq(diff(expr("*", [x, y])), y)).toBe(true);
  });

  test("d(x·x)/dx by product rule = x + x  (not yet folded into 2x)", () => {
    expect(eq(diff(expr("*", [x, x])), expr("+", [x, x]))).toBe(true);
  });

  test("d(x·y·z)/dx with z constant = y·z", () => {
    const z = sym("z");
    expect(eq(diff(expr("*", [x, y, z])), expr("*", [y, z]))).toBe(true);
  });
});

describe("differentiate — quotient rule", () => {
  test("d(1/x)/dx = (0·x - 1·1)/x² = neg(1)/x²", () => {
    const result = diff(expr("/", [int(1n), x]));
    expect(eq(result, expr("/", [expr("neg", [int(1n)]), expr("^", [x, int(2n)])]))).toBe(true);
  });

  test("d(x/y)/dx with y constant = (1·y - x·0)/y² = y/y²", () => {
    const result = diff(expr("/", [x, y]));
    // (1·y - x·0)/y² → y / y² (the inner mkTimes(0, x) makes 0; mkMinus(y, 0) = y)
    expect(eq(result, expr("/", [y, expr("^", [y, int(2n)])]))).toBe(true);
  });
});

describe("differentiate — power rule branches", () => {
  test("power rule (constant exponent): d(x²)/dx = 2·x", () => {
    expect(eq(diff(expr("^", [x, int(2n)])), expr("*", [int(2n), x]))).toBe(true);
  });

  test("power rule with rational exponent: d(x^(3/2))/dx = (3/2)·x^(1/2)", () => {
    const result = diff(expr("^", [x, rat(3n, 2n)]));
    expect(eq(result, expr("*", [rat(3n, 2n), expr("^", [x, rat(1n, 2n)])]))).toBe(true);
  });

  test("exp rule (constant base): d(2^x)/dx = 2^x · log(2)", () => {
    const result = diff(expr("^", [int(2n), x]));
    expect(
      eq(result, expr("*", [expr("^", [int(2n), x]), expr("log", [int(2n)])])),
    ).toBe(true);
  });

  test("d(x⁰)/dx = 0  (smart-constructor fast path: x⁰ = 1, derivative = 0)", () => {
    // The power rule short-circuits because both the constant-exponent
    // path and the constant-result of x^0 land on 0 either way.
    expect(eq(diff(expr("^", [x, int(0n)])), int(0n))).toBe(true);
  });

  test("d(x¹)/dx = 1  (constant-exponent branch with mkPower(x, 0) = 1)", () => {
    expect(eq(diff(expr("^", [x, int(1n)])), int(1n))).toBe(true);
  });
});

describe("differentiate — transcendentals (chain rule)", () => {
  test("d(sin(x))/dx = cos(x)", () => {
    expect(eq(diff(expr("sin", [x])), expr("cos", [x]))).toBe(true);
  });

  test("d(cos(x))/dx = neg(sin(x))", () => {
    expect(eq(diff(expr("cos", [x])), expr("neg", [expr("sin", [x])]))).toBe(true);
  });

  test("d(exp(x))/dx = exp(x)", () => {
    expect(eq(diff(expr("exp", [x])), expr("exp", [x]))).toBe(true);
  });

  test("d(log(x))/dx = 1/x", () => {
    expect(eq(diff(expr("log", [x])), expr("/", [int(1n), x]))).toBe(true);
  });

  test("d(sqrt(x))/dx = 1/(2·sqrt(x))", () => {
    expect(
      eq(
        diff(expr("sqrt", [x])),
        expr("/", [int(1n), expr("*", [int(2n), expr("sqrt", [x])])]),
      ),
    ).toBe(true);
  });

  test("d(tan(x))/dx = 1/cos(x)²", () => {
    expect(
      eq(
        diff(expr("tan", [x])),
        expr("/", [int(1n), expr("^", [expr("cos", [x]), int(2n)])]),
      ),
    ).toBe(true);
  });

  test("d(|x|)/dx = x/|x|  (sign(x) on R\\{0})", () => {
    expect(eq(diff(expr("abs", [x])), expr("/", [x, expr("abs", [x])]))).toBe(true);
  });

  test("chain rule: d(sin(2·x))/dx = cos(2·x) · 2", () => {
    const f = expr("sin", [expr("*", [int(2n), x])]);
    const expected = expr("*", [expr("cos", [expr("*", [int(2n), x])]), int(2n)]);
    expect(eq(diff(f), expected)).toBe(true);
  });
});

// -----------------------------------------------------------------------------
// Out-of-scope refusals
// -----------------------------------------------------------------------------

describe("differentiate — out-of-scope refusals", () => {
  test("unknown head → CasDiffOutOfScopeError(kind=head)", () => {
    expect(() => diff(expr("gamma", [x]))).toThrow(CasDiffOutOfScopeError);
    try {
      diff(expr("gamma", [x]));
    } catch (e) {
      expect(e).toBeInstanceOf(CasDiffOutOfScopeError);
      expect((e as CasDiffOutOfScopeError).kind).toBe("head");
      expect((e as CasDiffOutOfScopeError).identifier).toBe("gamma");
    }
  });

  test("unknown head deep in expression → still raises", () => {
    const e = expr("+", [x, expr("erf", [x])]);
    expect(() => diff(e)).toThrow(CasDiffOutOfScopeError);
  });

  test("string/list/record/tagged/boolean → CasDiffOutOfScopeError(kind=value-kind)", () => {
    for (const v of [
      { kind: "string", value: "hi" } as Value,
      { kind: "list", items: [] } as Value,
      { kind: "record", fields: {} } as Value,
      { kind: "tagged", tag: "t", payload: int(0n) } as Value,
      { kind: "boolean", value: true } as Value,
    ]) {
      expect(() => differentiate(v, x)).toThrow(CasDiffOutOfScopeError);
    }
  });
});

// -----------------------------------------------------------------------------
// Numerical cross-check via centred finite differences
// -----------------------------------------------------------------------------
//
// For each corpus expression `f`, pick a few interior evaluation
// points; evaluate the symbolic derivative `df/dx` (via cas-diff →
// evalNumericExpr) and the centred FD of `f` at those points; assert
// agreement to relative tolerance 1e-6. Independent oracle: the FD
// evaluation never sees the symbolic derivative, so a wrong rule shows
// up here as a numerical mismatch.

const FD_H = 1e-6;
const FD_TOL = 1e-6;

interface FdProbe {
  description: string;
  expr: Value;
  points: number[]; // x values to test at (must avoid singularities of f and f')
}

const FD_CORPUS: FdProbe[] = [
  { description: "constant", expr: int(7n), points: [-1, 0.5, 2] },
  { description: "x", expr: x, points: [-2, 0, 1.5] },
  { description: "x²", expr: expr("^", [x, int(2n)]), points: [-1.5, 0.7, 2.3] },
  { description: "x³ - 2x + 1", expr: expr("+", [
    expr("^", [x, int(3n)]),
    expr("neg", [expr("*", [int(2n), x])]),
    int(1n),
  ]), points: [-1.2, 0, 0.8, 2] },
  { description: "1/x", expr: expr("/", [int(1n), x]), points: [-2, -0.3, 0.4, 1.5] },
  { description: "x/(1+x²)", expr: expr("/", [x,
    expr("+", [int(1n), expr("^", [x, int(2n)])]),
  ]), points: [-1.3, 0, 0.5, 2.7] },
  { description: "sin(x)", expr: expr("sin", [x]), points: [-2, 0, 1, 3] },
  { description: "cos(x)", expr: expr("cos", [x]), points: [-2, 0, 1, 3] },
  { description: "tan(x)", expr: expr("tan", [x]), points: [-1, 0, 0.5, 1.2] },
  { description: "exp(x)", expr: expr("exp", [x]), points: [-2, 0, 1, 2] },
  { description: "log(x)", expr: expr("log", [x]), points: [0.3, 1, 2, 5] },
  { description: "sqrt(x)", expr: expr("sqrt", [x]), points: [0.3, 1, 2, 5] },
  { description: "abs(x)", expr: expr("abs", [x]), points: [-2, -0.5, 0.5, 2] },
  { description: "sin(x²)", expr: expr("sin", [expr("^", [x, int(2n)])]), points: [-1.5, 0.5, 1.7] },
  { description: "exp(-x²)", expr: expr("exp", [
    expr("neg", [expr("^", [x, int(2n)])]),
  ]), points: [-2, -0.5, 0.5, 2] },
  { description: "log(1 + x²)", expr: expr("log", [
    expr("+", [int(1n), expr("^", [x, int(2n)])]),
  ]), points: [-1.5, 0, 1.5] },
  { description: "x · sin(x)", expr: expr("*", [x, expr("sin", [x])]), points: [-2, 0.7, 2.3] },
  { description: "(x - 3)² (binary minus)", expr: expr("^", [
    expr("-", [x, int(3n)]),
    int(2n),
  ]), points: [-1, 0, 2, 5] },
  { description: "(2+x)/(x²-49)  [the demo integrand's a⁰ piece, ÷ 3/7]",
    expr: expr("/", [
      expr("+", [int(2n), x]),
      expr("+", [expr("^", [x, int(2n)]), int(-49n)]),
    ]),
    points: [-0.9, -0.3, 0.4, 0.9] },
];

describe("differentiate — finite-difference cross-check (orthogonal oracle)", () => {
  for (const probe of FD_CORPUS) {
    test(`FD agrees on: ${probe.description}`, () => {
      const dExpr = differentiate(probe.expr, x);
      for (const x0 of probe.points) {
        const fdEnv = (xv: number): Map<string, number> => new Map([["x", xv]]);
        const fPlus = evalNumericExpr(probe.expr, fdEnv(x0 + FD_H));
        const fMinus = evalNumericExpr(probe.expr, fdEnv(x0 - FD_H));
        const fdEstimate = (fPlus - fMinus) / (2 * FD_H);
        const dValue = evalNumericExpr(dExpr, fdEnv(x0));
        const denom = Math.max(Math.abs(fdEstimate), 1);
        const relErr = Math.abs(dValue - fdEstimate) / denom;
        if (relErr > FD_TOL) {
          throw new Error(
            `FD mismatch at ${probe.description}, x=${x0}: ` +
              `cas-diff=${dValue}, FD=${fdEstimate}, relErr=${relErr.toExponential(3)}`,
          );
        }
      }
    });
  }
});

// -----------------------------------------------------------------------------
// Heads coverage — every admitted head is exercised somewhere
// -----------------------------------------------------------------------------

describe("differentiate — coverage sanity", () => {
  test("every admitted head appears in the FD corpus", () => {
    const headsHit = new Set<string>();
    for (const probe of FD_CORPUS) {
      collectHeads(probe.expr, headsHit);
    }
    const missing = DIFF_ADMITTED_HEADS.filter((h) => !headsHit.has(h));
    // `*` and `+` are pervasive; this guards against silently dropping
    // a transcendental from the corpus.
    expect(missing).toEqual([]);
  });
});

function collectHeads(v: Value, into: Set<string>): void {
  if (v.kind === "expression") {
    into.add(v.head);
    for (const a of v.args) collectHeads(a, into);
  }
}
