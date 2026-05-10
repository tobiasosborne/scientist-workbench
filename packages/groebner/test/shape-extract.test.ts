// =============================================================================
// shape-extract.test.ts — shape lemma detection + solution extraction
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
import { detectShapePosition, extractShapeSolutions } from "../src/shape-extract.js";
import { fglm } from "../src/fglm.js";
import { buchbergerReduced } from "../src/buchberger.js";
import { drlOrder, lexOrder } from "../src/monomial-order.js";

const x = polyVar<Rat>("x", RAT_RING);
const y = polyVar<Rat>("y", RAT_RING);
const c = (n: bigint, d: bigint = 1n): Poly<Rat> => polyConst<Rat>(makeRat(n, d), RAT_RING);

describe("detectShapePosition", () => {
  test("(x² − 1, y − x): lex GB is in shape position", () => {
    const VARS = ["x", "y"];
    const drl = drlOrder(VARS);
    const f1 = polyAdd(polyMul(x, x, RAT_RING), c(-1n), RAT_RING);
    const f2 = polyAdd(y, polyMul(c(-1n), x, RAT_RING), RAT_RING);
    const drlBasis = buchbergerReduced([f1, f2], drl).basis;
    const lexBasis = fglm(drlBasis, VARS);
    const shape = detectShapePosition(lexBasis, VARS, lexOrder(VARS));
    expect(shape).not.toBeNull();
    // Shape: g_n is in y, h_x is in y.
    expect(shape!.xN).toBe("y");
  });
});

describe("extractShapeSolutions", () => {
  test("(x² − 1, y − x) ⟹ 2 solutions: (1, 1), (-1, -1)", () => {
    const VARS = ["x", "y"];
    const drl = drlOrder(VARS);
    const f1 = polyAdd(polyMul(x, x, RAT_RING), c(-1n), RAT_RING);
    const f2 = polyAdd(y, polyMul(c(-1n), x, RAT_RING), RAT_RING);
    const drlBasis = buchbergerReduced([f1, f2], drl).basis;
    const lexBasis = fglm(drlBasis, VARS);
    const result = extractShapeSolutions(lexBasis, VARS);
    if (result.kind !== "success") {
      throw new Error(`expected success, got refusal ${(result as { reasonClass: string }).reasonClass}`);
    }
    expect(result.solutions.length).toBe(2);
    // Each binding has 2 entries.
    for (const s of result.solutions) {
      expect(s.bindings.length).toBe(2);
      expect(s.bindings[0]!.var).toBe("x");
      expect(s.bindings[1]!.var).toBe("y");
    }
    // Solution count matches dim_ℚ(ℚ[x, y]/I) = 2.
    // (Verified by hand: I = ⟨x²−1, y−x⟩, dim = 2 because ℚ[x,y]/I
    // has basis {1, x} as ℚ-vector space.)
  });

  test("(x² − y², y² − 1): two y² generators ⟹ ideal = ⟨x² − 1, y² − 1⟩, NOT shape position", () => {
    // x² − y² = 0 and y² − 1 = 0 ⟹ x² = 1, y² = 1. Four solutions:
    // (±1, ±1). The lex GB under x > y is {x² − 1, y² − 1}, which has
    // LMs x² and y². The first basis element x² − 1 has LM = x² (a
    // pure power of x), but the shape lemma expects the *non-x_n*
    // variables to have linear LMs. Here x has LM x², not x¹, so
    // shape position fails.
    const VARS = ["x", "y"];
    const drl = drlOrder(VARS);
    const xSq = polyMul(x, x, RAT_RING);
    const ySq = polyMul(y, y, RAT_RING);
    const f1 = polyAdd(xSq, polyMul(c(-1n), ySq, RAT_RING), RAT_RING);
    const f2 = polyAdd(ySq, c(-1n), RAT_RING);
    const drlBasis = buchbergerReduced([f1, f2], drl).basis;
    const lexBasis = fglm(drlBasis, VARS);
    const result = extractShapeSolutions(lexBasis, VARS);
    expect(result.kind).toBe("refusal");
    if (result.kind === "refusal") {
      expect(result.reasonClass).toBe("shape-lemma-failure");
    }
  });

  test("two-circle intersection: NOT strict shape (refuses honestly)", () => {
    // x² + y² − 1, x² + y² − 2y: the lex GB is {x² − 3/4, y − 1/2}
    // which has LM x² (not linear in x), so it's NOT in strict shape
    // form per RESEARCH-NOTE §2-F + Q2-1. The honest behaviour is to
    // refuse with `shape-lemma-failure`; the underlying solutions
    // (±√3/2, 1/2) exist but are not extractable by the strict-
    // shape recipe alone (would need elimination in x first, then
    // substitution — a path deferred to the future RUR / generic-
    // shift bead).
    const VARS = ["x", "y"];
    const drl = drlOrder(VARS);
    const xSq = polyMul(x, x, RAT_RING);
    const ySq = polyMul(y, y, RAT_RING);
    const f1 = polyAdd(polyAdd(xSq, ySq, RAT_RING), c(-1n), RAT_RING);
    const f2 = polyAdd(polyAdd(xSq, ySq, RAT_RING), polyMul(c(-2n), y, RAT_RING), RAT_RING);
    const drlBasis = buchbergerReduced([f1, f2], drl).basis;
    const lexBasis = fglm(drlBasis, VARS);
    const result = extractShapeSolutions(lexBasis, VARS);
    expect(result.kind).toBe("refusal");
    if (result.kind === "refusal") {
      expect(result.reasonClass).toBe("shape-lemma-failure");
    }
  });

  test("rational-only system: x − 2, y − 3 ⟹ 1 solution", () => {
    // Trivial linear system, but routed through the multivariate
    // pipeline as the substrate would handle nonlinear cases. The
    // lex GB is {x − 2, y − 3} which IS shape position (g_y = y − 3
    // has degree 1, h_x(y) = 2 a constant).
    const VARS = ["x", "y"];
    const drl = drlOrder(VARS);
    const f1 = polyAdd(x, c(-2n), RAT_RING);
    const f2 = polyAdd(y, c(-3n), RAT_RING);
    const drlBasis = buchbergerReduced([f1, f2], drl).basis;
    const lexBasis = fglm(drlBasis, VARS);
    const result = extractShapeSolutions(lexBasis, VARS);
    if (result.kind !== "success") {
      throw new Error(
        `expected success for x−2, y−3; got refusal ${(result as { reasonClass: string }).reasonClass}`,
      );
    }
    expect(result.solutions.length).toBe(1);
    const sol = result.solutions[0]!;
    expect(sol.bindings.length).toBe(2);
  });
});
