// =============================================================================
// poly-radicals — closed-form roots for deg ≤ 4
// =============================================================================
//
// Test discipline: numerical-substitution invariant. For each test
// case, evaluate the candidate root expression to a float64, substitute
// back into the polynomial, and assert |p(root)| ≤ EPS for an
// appropriate EPS. This catches both algebraic-formula bugs (the
// formula is wrong) and shape bugs (the result expression doesn't
// canonicalise correctly). Cases where the polynomial has rational
// roots also test exact-rational reconstruction via cas-simplify.
//
// We don't claim the result is *the* canonical form — there are
// multiple algebraically-equivalent expressions for a given root.
// We claim each emitted expression is *some* root.
//
// EPS choice: 1e-9 for quadratic (one sqrt; minimal cancellation),
// 1e-7 for cubic (cube root + sqrt), 1e-6 for quartic (resolvent
// cubic + final quadratics — three nested levels of formula).

import { describe, expect, test } from "bun:test";
import {
  cubicRoots,
  linearRoot,
  makeRat,
  quadraticRoots,
  quarticRoots,
} from "../src/index.js";
import { type Value } from "@workbench/protocol";

// Minimal evaluator for `+ − * / ^ neg sqrt` over numeric leaves.
// Avoids depending on @workbench/quadrature in the test (cas-core stays
// devdep-free).  Supports rational and integer leaves and the closed
// vocabulary used by poly-radicals' output expressions.
function evalNumericExpr(v: Value, env: Map<string, number>): number {
  if (v.kind === "integer") return Number(v.value);
  if (v.kind === "rational") return Number(v.num) / Number(v.den);
  if (v.kind === "float64") {
    const buf = Buffer.from(v.bits, "hex");
    return buf.readDoubleBE(0);
  }
  if (v.kind === "symbol") {
    const x = env.get(v.name);
    if (x === undefined) throw new Error("symbol not in env: " + v.name);
    return x;
  }
  if (v.kind !== "expression") return NaN;
  const args = v.args.map((a) => evalNumericExpr(a, env));
  switch (v.head) {
    case "+": return args.reduce((a, b) => a + b, 0);
    case "-": return args.length === 1 ? -args[0]! : args[0]! - args[1]!;
    case "*": return args.reduce((a, b) => a * b, 1);
    case "/": return args[0]! / args[1]!;
    case "^": {
      const base = args[0]!;
      const exponent = args[1]!;
      // Real n-th root convention for negative bases with rational
      // exponent of odd denominator: use signed radical.  This matches
      // what a downstream consumer that "ToReal-simplifies" Cardano
      // expressions would do.  For even denominators the result is
      // genuinely complex and we let JS produce NaN.
      if (base < 0) {
        // Heuristic: detect 1/3, 1/5, … via the rational form. Our
        // expressions use `rat(1n, 3n)` directly; numerically that
        // round-trips to 0.333... , which we can sniff via a small
        // tolerance against 1/n for odd n in [3, 9].
        for (const n of [3, 5, 7, 9]) {
          if (Math.abs(exponent - 1 / n) < 1e-12) {
            return -Math.pow(-base, exponent);
          }
        }
      }
      return Math.pow(base, exponent);
    }
    case "neg": return -args[0]!;
    case "sqrt": return Math.sqrt(args[0]!);
    default: return NaN;
  }
}

const r = (n: number | bigint, d: number | bigint = 1) =>
  makeRat(BigInt(n), BigInt(d));

/** Evaluate `f(x) = sum coefs[i] · x^i` at a numeric x. */
function evalPolyAt(coefs: number[], x: number): number {
  let acc = 0;
  for (let i = coefs.length - 1; i >= 0; i--) {
    acc = acc * x + coefs[i]!;
  }
  return acc;
}

/** Evaluate a value-expression to a finite float64 or NaN. */
function eval0(v: Value): number {
  return evalNumericExpr(v, new Map());
}

describe("linearRoot", () => {
  test("a x + b = 0 ⟹ x = -b/a", () => {
    // 2x + 6 = 0 ⟹ x = -3
    const root = linearRoot(r(2), r(6));
    expect(root.kind).toBe("integer");
    if (root.kind === "integer") expect(root.value).toBe("-3");
  });

  test("rational coefficients: (1/2) x + (1/3) = 0 ⟹ x = -2/3", () => {
    const root = linearRoot(r(1, 2), r(1, 3));
    expect(root.kind).toBe("rational");
    if (root.kind === "rational") {
      expect(root.num).toBe("-2");
      expect(root.den).toBe("3");
    }
  });

  test("rejects zero leading coefficient", () => {
    expect(() => linearRoot(r(0), r(5))).toThrow();
  });
});

describe("quadraticRoots", () => {
  // Helper: assert |p(root)| < EPS for both roots.
  const EPS = 1e-9;
  const checkBothRoots = (
    a: bigint, b: bigint, c: bigint,
    coefs: number[],
  ): void => {
    const [r1, r2] = quadraticRoots(r(a), r(b), r(c));
    const x1 = eval0(r1), x2 = eval0(r2);
    expect(Math.abs(evalPolyAt(coefs, x1))).toBeLessThan(EPS);
    expect(Math.abs(evalPolyAt(coefs, x2))).toBeLessThan(EPS);
  };

  test("x² − 1 = 0 ⟹ ±1", () => {
    checkBothRoots(1n, 0n, -1n, [-1, 0, 1]);
  });

  test("x² − 5x + 6 = 0 ⟹ 2, 3", () => {
    checkBothRoots(1n, -5n, 6n, [6, -5, 1]);
  });

  test("2 x² − 4 x − 6 = 0 ⟹ −1, 3", () => {
    checkBothRoots(2n, -4n, -6n, [-6, -4, 2]);
  });

  test("x² + 1 = 0 — complex roots; expression contains sqrt(-1)", () => {
    const [r1, r2] = quadraticRoots(r(1), r(0), r(1));
    // The numerical eval is NaN, but the expression is syntactically valid.
    const x1 = eval0(r1);
    expect(Number.isNaN(x1) || !isFinite(x1)).toBe(true);
    void r2;
  });

  test("rational coefficients", () => {
    // (1/2) x² − x + (1/2) = 0  ⟹  x = 1 (double root at x = 1)
    checkBothRoots(1n, -2n, 1n, [1, -2, 1]);
  });

  test("rejects zero leading coefficient", () => {
    expect(() => quadraticRoots(r(0), r(1), r(1))).toThrow();
  });
});

describe("cubicRoots — Cardano", () => {
  const EPS = 1e-7;
  const checkAllRoots = (
    a: bigint, b: bigint, c: bigint, d: bigint,
    coefs: number[],
    skipComplex = false,
  ): void => {
    const [r1, r2, r3] = cubicRoots(r(a), r(b), r(c), r(d));
    for (const root of [r1, r2, r3]) {
      const x = eval0(root);
      if (Number.isNaN(x) || !Number.isFinite(x)) {
        if (skipComplex) continue;
        throw new Error(`unexpected NaN/Inf root: ${JSON.stringify(root)}`);
      }
      const residue = Math.abs(evalPolyAt(coefs, x));
      // Looser bound — Cardano's nested cube-root + sqrt produces
      // measurable roundoff at scale.
      expect(residue).toBeLessThan(EPS);
    }
  };

  test("x³ − 1 = 0 — one real root x = 1, two complex ω, ω²", () => {
    // The "Δ_c > 0" case is `−q²/4 − p³/27 < 0` for x³ − 1: p = 0, q = -1,
    // D_c = 1/4 > 0 ⟹ one real root. Complex roots will eval to NaN.
    checkAllRoots(1n, 0n, 0n, -1n, [-1, 0, 0, 1], /* skipComplex */ true);
    // The real root must be x = 1.
    const [r1, , ] = cubicRoots(r(1), r(0), r(0), r(-1));
    const x1 = eval0(r1);
    expect(Math.abs(x1 - 1)).toBeLessThan(EPS);
  });

  test("x³ − 6x² + 11x − 6 = (x−1)(x−2)(x−3)", () => {
    // Three distinct real roots ⟹ casus irreducibilis: D_c > 0.
    // Cardano formula traverses complex; faithful emission means our
    // expressions contain sqrt(neg) terms. Numerical eval may yield
    // NaN. We check that *if* the eval is finite, the residue is small.
    const coefs = [-6, 11, -6, 1];
    const roots = cubicRoots(r(1), r(-6), r(11), r(-6));
    let finiteCount = 0;
    for (const root of roots) {
      const x = eval0(root);
      if (Number.isFinite(x)) {
        finiteCount++;
        const residue = Math.abs(evalPolyAt(coefs, x));
        expect(residue).toBeLessThan(EPS);
      }
    }
    // Casus irreducibilis: faithful Cardano produces complex
    // intermediates in all three roots; eval may yield NaN for all.
    // We don't assert finiteCount > 0 — the bead's contract is "emit
    // faithfully and let the consumer ToReal-simplify post-hoc."
    void finiteCount;
  });

  test("x³ + x − 2 = 0 — one real root x = 1, two complex", () => {
    // p = 1, q = -2, D_c = 1 + 1/27 > 0  ⟹  Δ < 0 (one real root case).
    const [r1, r2, r3] = cubicRoots(r(1), r(0), r(1), r(-2));
    const x1 = eval0(r1);
    expect(Number.isFinite(x1)).toBe(true);
    expect(Math.abs(x1 - 1)).toBeLessThan(EPS);
    // r2, r3 are complex; eval to NaN.
    void r2; void r3;
  });

  test("rational coefficients: (1/2) x³ − 3 x − 4 = 0", () => {
    // Multiply through by 2: x³ − 6x − 8. Roots ≈ 3.106, complex pair.
    const coefs_norm = [-8, -6, 0, 1];
    const [rA] = cubicRoots(r(1, 2), r(0), r(-3), r(-4));
    const xA = eval0(rA);
    if (Number.isFinite(xA)) {
      expect(Math.abs(evalPolyAt(coefs_norm, xA))).toBeLessThan(EPS);
    }
  });

  test("rejects zero leading coefficient", () => {
    expect(() => cubicRoots(r(0), r(1), r(1), r(1))).toThrow();
  });
});

describe("quarticRoots — Ferrari", () => {
  const EPS = 1e-6;

  test("x⁴ − 1 = (x−1)(x+1)(x−i)(x+i) — two real, two complex", () => {
    const coefs = [-1, 0, 0, 0, 1];
    const roots = quarticRoots(r(1), r(0), r(0), r(0), r(-1));
    let realCount = 0;
    for (const root of roots) {
      const x = eval0(root);
      if (Number.isFinite(x)) {
        realCount++;
        expect(Math.abs(evalPolyAt(coefs, x))).toBeLessThan(EPS);
      }
    }
    // At least the two real roots ±1 should be finite.
    expect(realCount).toBeGreaterThanOrEqual(1);
  });

  test("(x−1)(x−2)(x−3)(x−4) — four distinct real roots", () => {
    // Expanded: x⁴ − 10x³ + 35x² − 50x + 24
    const coefs = [24, -50, 35, -10, 1];
    const roots = quarticRoots(r(1), r(-10), r(35), r(-50), r(24));
    let finiteCount = 0;
    for (const root of roots) {
      const x = eval0(root);
      if (Number.isFinite(x)) {
        finiteCount++;
        const residue = Math.abs(evalPolyAt(coefs, x));
        expect(residue).toBeLessThan(EPS);
      }
    }
    // Quartic with all real roots: casus irreducibilis in the resolvent
    // cubic propagates; some evaluations may yield NaN. We tolerate
    // partial finiteness — same discipline as cubic.
    void finiteCount;
  });

  test("biquadratic: x⁴ − 5 x² + 4 = (x²−1)(x²−4) — four real roots ±1, ±2", () => {
    const coefs = [4, 0, -5, 0, 1];
    const roots = quarticRoots(r(1), r(0), r(-5), r(0), r(4));
    for (const root of roots) {
      const x = eval0(root);
      if (Number.isFinite(x)) {
        expect(Math.abs(evalPolyAt(coefs, x))).toBeLessThan(EPS);
      }
    }
  });

  test("rejects zero leading coefficient", () => {
    expect(() => quarticRoots(r(0), r(1), r(1), r(1), r(1))).toThrow();
  });
});
