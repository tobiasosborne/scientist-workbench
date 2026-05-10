// =============================================================================
// solve-groebner.test.ts — end-to-end DRL → FGLM → shape extraction
// =============================================================================

import { describe, expect, test } from "bun:test";
import {
  type Poly,
  type Rat,
  RAT_RING,
  makeRat,
  polyAdd,
  polyConst,
  polyMul,
  polyVar,
} from "@workbench/cas-core";
import { solveGroebner } from "../src/solve-groebner.js";

const x = polyVar<Rat>("x", RAT_RING);
const y = polyVar<Rat>("y", RAT_RING);
const c = (n: bigint, d: bigint = 1n): Poly<Rat> => polyConst<Rat>(makeRat(n, d), RAT_RING);

describe("solveGroebner — happy path", () => {
  test("(x² − 1, y − x) ⟹ 2 solutions; bindings shape correct", () => {
    const VARS = ["x", "y"];
    const f1 = polyAdd(polyMul(x, x, RAT_RING), c(-1n), RAT_RING);
    const f2 = polyAdd(y, polyMul(c(-1n), x, RAT_RING), RAT_RING);
    const result = solveGroebner([f1, f2], VARS);
    if (result.kind !== "success") {
      throw new Error(`expected success, got ${result.kind}: ${(result as { detail?: string }).detail ?? ""}`);
    }
    expect(result.solutions.length).toBe(2);
    expect(result.vars).toEqual(VARS);
    for (const s of result.solutions) {
      expect(s.bindings.length).toBe(2);
      expect(s.bindings[0]!.var).toBe("x");
      expect(s.bindings[1]!.var).toBe("y");
    }
  });
});

describe("solveGroebner — refusals", () => {
  test("⟨x⟩ in ℚ[x, y] ⟹ multivariate-non-zero-dim refusal", () => {
    const VARS = ["x", "y"];
    const result = solveGroebner([x], VARS);
    expect(result.kind).toBe("refusal");
    if (result.kind === "refusal") {
      expect(result.reasonClass).toBe("multivariate-non-zero-dim");
      // Refusal payload includes the basis as a Value.
      expect(result.basis).toBeDefined();
    }
  });

  test("(x² − y², y² − 1) ⟹ shape-lemma-failure", () => {
    const VARS = ["x", "y"];
    const xSq = polyMul(x, x, RAT_RING);
    const ySq = polyMul(y, y, RAT_RING);
    const f1 = polyAdd(xSq, polyMul(c(-1n), ySq, RAT_RING), RAT_RING);
    const f2 = polyAdd(ySq, c(-1n), RAT_RING);
    const result = solveGroebner([f1, f2], VARS);
    expect(result.kind).toBe("refusal");
    if (result.kind === "refusal") {
      expect(result.reasonClass).toBe("shape-lemma-failure");
    }
  });

  test("(x − 1, x − 2) ⟹ inconsistent ⟹ empty solution set (success)", () => {
    const VARS = ["x"];
    const f1 = polyAdd(x, c(-1n), RAT_RING);
    const f2 = polyAdd(x, c(-2n), RAT_RING);
    const result = solveGroebner([f1, f2], VARS);
    if (result.kind !== "success") {
      throw new Error("expected success (inconsistent → []), got refusal");
    }
    expect(result.solutions.length).toBe(0);
  });
});
