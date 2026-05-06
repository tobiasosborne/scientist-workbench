// =============================================================================
// dispatchClassified — execute a classifier verdict, check ADR-0017 shape
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
import { classifyInput, dispatchClassified } from "../src/index.js";

const x = polyVar<Rat>("x", RAT_RING);
const y = polyVar<Rat>("y", RAT_RING);
const c = (n: number, d: number = 1): Poly<Rat> =>
  polyConst<Rat>(makeRat(BigInt(n), BigInt(d)), RAT_RING);

describe("dispatchClassified — linear lane", () => {
  test("unique solution: x + y = 3, x - y = 1 ⟹ x=2, y=1", () => {
    const eq1 = polyAdd(polyAdd(x, y, RAT_RING), c(-3), RAT_RING);
    const eq2 = polyAdd(
      polyAdd(x, polyMul(c(-1), y, RAT_RING), RAT_RING),
      c(-1),
      RAT_RING,
    );
    const verdict = classifyInput([eq1, eq2], ["x", "y"]);
    const result = dispatchClassified(verdict, ["x", "y"]);
    expect(result.kind).toBe("success");
    if (result.kind !== "success") return;
    expect(result.solutions.length).toBe(1);
    expect(result.completeness).toBe("complete");
    const bindings = result.solutions[0]!.bindings;
    expect(bindings[0]!.var).toBe("x");
    expect(bindings[1]!.var).toBe("y");
    // Verify x = 2: bindings[0].value should be integer 2
    expect(bindings[0]!.value.kind).toBe("integer");
    if (bindings[0]!.value.kind === "integer") {
      expect(bindings[0]!.value.value).toBe("2");
    }
    if (bindings[1]!.value.kind === "integer") {
      expect(bindings[1]!.value.value).toBe("1");
    }
  });

  test("inconsistent: x + y = 1, x + y = 2 ⟹ no solution", () => {
    const eq1 = polyAdd(polyAdd(x, y, RAT_RING), c(-1), RAT_RING);
    const eq2 = polyAdd(polyAdd(x, y, RAT_RING), c(-2), RAT_RING);
    const verdict = classifyInput([eq1, eq2], ["x", "y"]);
    const result = dispatchClassified(verdict, ["x", "y"]);
    expect(result.kind).toBe("success");
    if (result.kind !== "success") return;
    expect(result.solutions.length).toBe(0);
    expect(result.completeness).toBe("complete");
  });

  test("under-determined: x + y = 3 ⟹ {x → 3 - t, y → t} (single branch)", () => {
    const eq = polyAdd(polyAdd(x, y, RAT_RING), c(-3), RAT_RING);
    const verdict = classifyInput([eq], ["x", "y"]);
    expect(verdict.kind).toBe("linear");
    const result = dispatchClassified(verdict, ["x", "y"]);
    expect(result.kind).toBe("success");
    if (result.kind !== "success") return;
    expect(result.solutions.length).toBe(1);
    expect(result.completeness).toBe("finite-rep-of-infinite");
    expect(result.solutions[0]!.branches.length).toBeGreaterThan(0);
  });
});

describe("dispatchClassified — univariate-poly lane", () => {
  test("linear: 2x + 4 = 0 ⟹ x = -2", () => {
    const eq = polyAdd(polyMul(c(2), x, RAT_RING), c(4), RAT_RING);
    const verdict = classifyInput([eq], ["x"]);
    const result = dispatchClassified(verdict, ["x"]);
    expect(result.kind).toBe("success");
    if (result.kind !== "success") return;
    expect(result.solutions.length).toBe(1);
    expect(result.solutions[0]!.bindings[0]!.var).toBe("x");
    const v = result.solutions[0]!.bindings[0]!.value;
    if (v.kind === "integer") expect(v.value).toBe("-2");
  });

  test("quadratic: x² − 5x + 6 ⟹ x ∈ {2, 3}", () => {
    const eq = polyAdd(
      polyAdd(polyMul(x, x, RAT_RING), polyMul(c(-5), x, RAT_RING), RAT_RING),
      c(6),
      RAT_RING,
    );
    const verdict = classifyInput([eq], ["x"]);
    const result = dispatchClassified(verdict, ["x"]);
    expect(result.kind).toBe("success");
    if (result.kind !== "success") return;
    expect(result.solutions.length).toBe(2);
    expect(result.completeness).toBe("complete");
    // Each solution is a binding {x → integer}.
    const values = result.solutions.map((s) => {
      const v = s.bindings[0]!.value;
      return v.kind === "integer" ? Number(v.value) : NaN;
    }).sort();
    expect(values).toEqual([2, 3]);
  });

  test("cubic with rational root: x³ − x = x(x−1)(x+1) ⟹ {0, 1, -1}", () => {
    // x³ - x = 0 → factors as x · (x² - 1) = x · (x-1) · (x+1)
    const eq = polyAdd(
      polyMul(x, polyMul(x, x, RAT_RING), RAT_RING),
      polyMul(c(-1), x, RAT_RING),
      RAT_RING,
    );
    const verdict = classifyInput([eq], ["x"]);
    const result = dispatchClassified(verdict, ["x"]);
    expect(result.kind).toBe("success");
    if (result.kind !== "success") return;
    expect(result.solutions.length).toBe(3);
    const values = result.solutions.map((s) => {
      const v = s.bindings[0]!.value;
      return v.kind === "integer" ? Number(v.value) : NaN;
    }).sort();
    expect(values).toEqual([-1, 0, 1]);
  });

  test("multiplicity preserved: (x − 1)² ⟹ x = 1 (twice)", () => {
    // x² - 2x + 1 = 0
    const eq = polyAdd(
      polyAdd(polyMul(x, x, RAT_RING), polyMul(c(-2), x, RAT_RING), RAT_RING),
      c(1),
      RAT_RING,
    );
    const verdict = classifyInput([eq], ["x"]);
    const result = dispatchClassified(verdict, ["x"]);
    expect(result.kind).toBe("success");
    if (result.kind !== "success") return;
    expect(result.solutions.length).toBe(2);
    // Both solutions have x = 1.
    for (const sol of result.solutions) {
      const v = sol.bindings[0]!.value;
      if (v.kind === "integer") expect(v.value).toBe("1");
    }
  });

  test("deg-5 irreducible quintic ⟹ refusal", () => {
    // x⁵ + 2x + 2 (irreducible over ℚ by Eisenstein at p = 2).
    const x5 = polyMul(x, polyMul(x, polyMul(x, polyMul(x, x, RAT_RING), RAT_RING), RAT_RING), RAT_RING);
    const eq = polyAdd(
      polyAdd(x5, polyMul(c(2), x, RAT_RING), RAT_RING),
      c(2),
      RAT_RING,
    );
    const verdict = classifyInput([eq], ["x"]);
    const result = dispatchClassified(verdict, ["x"]);
    expect(result.kind).toBe("refusal");
    if (result.kind === "refusal") {
      expect(result.reasonClass).toBe("high-degree-irreducible");
    }
  });
});

describe("dispatchClassified — refusals propagate", () => {
  test("classifier refusal ⟹ dispatcher refusal with same class", () => {
    // x · y = 1 — bilinear, classifier refuses
    const eq = polyAdd(polyMul(x, y, RAT_RING), c(-1), RAT_RING);
    const verdict = classifyInput([eq], ["x", "y"]);
    const result = dispatchClassified(verdict, ["x", "y"]);
    expect(result.kind).toBe("refusal");
  });
});
