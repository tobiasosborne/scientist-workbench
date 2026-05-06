// =============================================================================
// classifyInput — test the dispatch-lane verdict for various inputs
// =============================================================================

import { describe, expect, test } from "bun:test";
import {
  RAT_RING,
  makeRat,
  polyAdd,
  polyConst,
  polyMul,
  polyVar,
  type Poly,
  type Rat,
} from "@workbench/cas-core";
import { classifyInput } from "../src/index.js";

const x = polyVar<Rat>("x", RAT_RING);
const y = polyVar<Rat>("y", RAT_RING);
const z = polyVar<Rat>("z", RAT_RING);
const c = (n: number, d: number = 1): Poly<Rat> =>
  polyConst<Rat>(makeRat(BigInt(n), BigInt(d)), RAT_RING);

describe("classifyInput", () => {
  test("single linear equation in single variable → univariate-poly (deg 1)", () => {
    // 2x + 4 = 0 (poly degree 1, but classifier treats as univariate-poly
    // when m=1, n=1). The dispatcher then handles it via radicals
    // (linearRoot).
    const eq = polyAdd(polyMul(c(2), x, RAT_RING), c(4), RAT_RING);
    const result = classifyInput([eq], ["x"]);
    expect(result.kind).toBe("univariate-poly");
  });

  test("single quadratic → univariate-poly", () => {
    // x² − 5x + 6 = 0
    const eq = polyAdd(
      polyAdd(polyMul(x, x, RAT_RING), polyMul(c(-5), x, RAT_RING), RAT_RING),
      c(6),
      RAT_RING,
    );
    const result = classifyInput([eq], ["x"]);
    expect(result.kind).toBe("univariate-poly");
    if (result.kind === "univariate-poly") {
      expect(result.varName).toBe("x");
    }
  });

  test("two linear equations in two variables → linear", () => {
    // x + y - 3 = 0
    // x - y - 1 = 0
    const eq1 = polyAdd(polyAdd(x, y, RAT_RING), c(-3), RAT_RING);
    const eq2 = polyAdd(polyAdd(x, polyAdd(c(0), polyMul(c(-1), y, RAT_RING), RAT_RING), RAT_RING), c(-1), RAT_RING);
    const result = classifyInput([eq1, eq2], ["x", "y"]);
    expect(result.kind).toBe("linear");
    if (result.kind === "linear") {
      expect(result.A.length).toBe(2);
      expect(result.b.length).toBe(2);
      // A row 0: [1, 1] (coef of x, coef of y) for x + y - 3
      expect(result.A[0]![0]!.n).toBe(1n);
      expect(result.A[0]![1]!.n).toBe(1n);
      // b[0] = -(-3) = 3
      expect(result.b[0]!.n).toBe(3n);
    }
  });

  test("three linear equations in three variables → linear", () => {
    // x + 2y + 3z - 6 = 0
    // 2x + y + z - 4 = 0
    // x - y + z - 1 = 0
    const buildEq = (a: number, b: number, cc: number, k: number): Poly<Rat> =>
      polyAdd(
        polyAdd(
          polyAdd(polyMul(c(a), x, RAT_RING), polyMul(c(b), y, RAT_RING), RAT_RING),
          polyMul(c(cc), z, RAT_RING),
          RAT_RING,
        ),
        c(-k),
        RAT_RING,
      );
    const eqs = [
      buildEq(1, 2, 3, 6),
      buildEq(2, 1, 1, 4),
      buildEq(1, -1, 1, 1),
    ];
    const result = classifyInput(eqs, ["x", "y", "z"]);
    expect(result.kind).toBe("linear");
    if (result.kind === "linear") {
      expect(result.A.length).toBe(3);
      expect(result.A[0]).toEqual([makeRat(1n, 1n), makeRat(2n, 1n), makeRat(3n, 1n)]);
      expect(result.b[0]!).toEqual(makeRat(6n, 1n));
    }
  });

  test("nonlinear multivariate → unsupported (multivariate-non-zero-dim)", () => {
    // x² + y² - 1 = 0  (nonlinear, two-variable circle)
    const eq = polyAdd(
      polyAdd(polyMul(x, x, RAT_RING), polyMul(y, y, RAT_RING), RAT_RING),
      c(-1),
      RAT_RING,
    );
    const result = classifyInput([eq], ["x", "y"]);
    expect(result.kind).toBe("unsupported");
    if (result.kind === "unsupported") {
      expect(result.reasonClass).toBe("multivariate-non-zero-dim");
    }
  });

  test("bilinear x · y = 1 → not linear (cross-term)", () => {
    // x · y - 1 = 0  ; classifier should NOT flag this as linear
    const eq = polyAdd(polyMul(x, y, RAT_RING), c(-1), RAT_RING);
    const result = classifyInput([eq], ["x", "y"]);
    expect(result.kind).toBe("unsupported");
  });

  test("foreign symbol → unsupported (parametric-non-trivial)", () => {
    const a = polyVar<Rat>("a", RAT_RING);
    // a · x - 1 = 0 in solve-for-x: `a` is a foreign parameter.
    const eq = polyAdd(polyMul(a, x, RAT_RING), c(-1), RAT_RING);
    const result = classifyInput([eq], ["x"]);
    expect(result.kind).toBe("unsupported");
    if (result.kind === "unsupported") {
      expect(result.reasonClass).toBe("parametric-non-trivial");
    }
  });

  test("constant equation → unsupported (constant-equation)", () => {
    // 5 = 0, no var; classifier rejects because deg < 1 in vars[0].
    const eq = c(5);
    const result = classifyInput([eq], ["x"]);
    expect(result.kind).toBe("unsupported");
    if (result.kind === "unsupported") {
      expect(result.reasonClass).toBe("constant-equation");
    }
  });

  test("empty input → unsupported", () => {
    expect(classifyInput([], ["x"]).kind).toBe("unsupported");
    expect(classifyInput([x], []).kind).toBe("unsupported");
  });

  test("under-determined linear (more vars than independent equations)", () => {
    // x + y - 1 = 0
    // 2x + 2y - 2 = 0   (dependent)
    // Classifier still says "linear" — the *solver* (bareissSolve) will
    // detect the under-determined-ness via rank.
    const eq1 = polyAdd(polyAdd(x, y, RAT_RING), c(-1), RAT_RING);
    const eq2 = polyAdd(
      polyAdd(polyMul(c(2), x, RAT_RING), polyMul(c(2), y, RAT_RING), RAT_RING),
      c(-2),
      RAT_RING,
    );
    const result = classifyInput([eq1, eq2], ["x", "y"]);
    expect(result.kind).toBe("linear");
  });
});
