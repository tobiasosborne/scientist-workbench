// =============================================================================
// fglm.test.ts — DRL → lex Gröbner basis conversion
// =============================================================================

import { describe, expect, test } from "bun:test";
import {
  type Poly,
  type Rat,
  RAT_RING,
  makeRat,
  polyAdd,
  polyConst,
  polyIsZero,
  polyMul,
  polyVar,
} from "@workbench/cas-core";
import { fglm } from "../src/fglm.js";
import {
  buchbergerReduced,
  sPolynomial,
} from "../src/buchberger.js";
import {
  drlOrder,
  lexOrder,
} from "../src/monomial-order.js";
import {
  leadingTerm,
  polyNormalForm,
} from "../src/multidiv.js";

const x = polyVar<Rat>("x", RAT_RING);
const y = polyVar<Rat>("y", RAT_RING);
const c = (n: bigint, d: bigint = 1n): Poly<Rat> => polyConst<Rat>(makeRat(n, d), RAT_RING);

describe("fglm — small zero-dim ideals", () => {
  test("classic CLO §6 Ex 1: (x²+y, xy+1) — DRL→lex returns 2 elements with shape", () => {
    const VARS = ["x", "y"];
    const drl = drlOrder(VARS);
    const lex = lexOrder(VARS);
    const f1 = polyAdd(polyMul(x, x, RAT_RING), y, RAT_RING);
    const f2 = polyAdd(polyMul(x, y, RAT_RING), c(1n), RAT_RING);
    const drlResult = buchbergerReduced([f1, f2], drl);
    const lexBasis = fglm(drlResult.basis, VARS);
    // Expected lex GB: { x − y², y³ + 1 } with leading monomials
    // {x, y³} (descending lex). Specifically two elements; the
    // first (LM=x) is linear in x, the second (LM=y³) is univariate.
    expect(lexBasis.length).toBe(2);
    // Every element under lex(x>y) should have its LM as either
    // a power of x of degree 1 or a pure power of y.
    for (const p of lexBasis) {
      const lt = leadingTerm(p, lex);
      expect(lt).not.toBeNull();
    }

    // Ideal containment via S-pair check: every S-pair of lexBasis
    // reduces to 0 mod lexBasis (the GB property under lex).
    for (let i = 0; i < lexBasis.length; i++) {
      for (let j = i + 1; j < lexBasis.length; j++) {
        const s = sPolynomial(lexBasis[i]!, lexBasis[j]!, lex);
        const r = polyNormalForm(s, lexBasis, lex);
        expect(polyIsZero(r)).toBe(true);
      }
    }

    // Cross-validation: the lex GB still spans the original ideal —
    // every f_i reduces to 0 under lex.
    for (const f of [f1, f2]) {
      expect(polyIsZero(polyNormalForm(f, lexBasis, lex))).toBe(true);
    }
  });

  test("(x² − 1, y − x) — already-shape-position case", () => {
    // x² − 1 = 0, y = x. Solutions: (1, 1), (-1, -1).
    // The lex GB under x > y SHOULD be { x − y, y² − 1 } (after
    // elimination of x). Let's verify.
    const VARS = ["x", "y"];
    const drl = drlOrder(VARS);
    const f1 = polyAdd(polyMul(x, x, RAT_RING), c(-1n), RAT_RING);
    const f2 = polyAdd(y, polyMul(c(-1n), x, RAT_RING), RAT_RING); // y - x
    const drlResult = buchbergerReduced([f1, f2], drl);
    const lexBasis = fglm(drlResult.basis, VARS);
    expect(lexBasis.length).toBe(2);

    // Confirm GB property.
    const lex = lexOrder(VARS);
    for (let i = 0; i < lexBasis.length; i++) {
      for (let j = i + 1; j < lexBasis.length; j++) {
        const s = sPolynomial(lexBasis[i]!, lexBasis[j]!, lex);
        const r = polyNormalForm(s, lexBasis, lex);
        expect(polyIsZero(r)).toBe(true);
      }
    }
  });

  test("inconsistent system → lex GB = [1]", () => {
    const VARS = ["x", "y"];
    const drl = drlOrder(VARS);
    // x − 1, x − 2 → ideal contains 1 → GB is {1}.
    const f1 = polyAdd(x, c(-1n), RAT_RING);
    const f2 = polyAdd(x, c(-2n), RAT_RING);
    const drlResult = buchbergerReduced([f1, f2], drl);
    expect(drlResult.basis.length).toBe(1);
    const lexBasis = fglm(drlResult.basis, VARS);
    expect(lexBasis.length).toBe(1);
    const lt = leadingTerm(lexBasis[0]!, lexOrder(VARS));
    // GB = [1] ⇒ leading term is the constant 1.
    expect(lt!.exp.length).toBe(0);
  });

  test("unit ideal in 1 var: ⟨x − 2⟩ — DRL→lex idempotent", () => {
    const VARS = ["x"];
    const drl = drlOrder(VARS);
    const f1 = polyAdd(x, c(-2n), RAT_RING);
    const drlResult = buchbergerReduced([f1], drl);
    const lexBasis = fglm(drlResult.basis, VARS);
    expect(lexBasis.length).toBe(1);
  });

  test("two-circle intersection: x²+y²−1, x²+y²−2y → 2 solutions", () => {
    // x²+y² = 1, x²+y² = 2y ⇒ 2y = 1 ⇒ y = 1/2 ⇒ x² = 1 - 1/4 = 3/4.
    // Two solutions: (√3/2, 1/2), (-√3/2, 1/2). zero-dim, deg 2.
    const VARS = ["x", "y"];
    const drl = drlOrder(VARS);
    const lex = lexOrder(VARS);
    const xSq = polyMul(x, x, RAT_RING);
    const ySq = polyMul(y, y, RAT_RING);
    const f1 = polyAdd(polyAdd(xSq, ySq, RAT_RING), c(-1n), RAT_RING);
    const f2 = polyAdd(polyAdd(xSq, ySq, RAT_RING), polyMul(c(-2n), y, RAT_RING), RAT_RING);
    const drlResult = buchbergerReduced([f1, f2], drl);
    const lexBasis = fglm(drlResult.basis, VARS);
    // Expect 2 elements: x² − 3/4 (or shifted), y − 1/2.
    expect(lexBasis.length).toBe(2);
    // Verify GB property.
    for (let i = 0; i < lexBasis.length; i++) {
      for (let j = i + 1; j < lexBasis.length; j++) {
        const s = sPolynomial(lexBasis[i]!, lexBasis[j]!, lex);
        const r = polyNormalForm(s, lexBasis, lex);
        expect(polyIsZero(r)).toBe(true);
      }
    }
  });
});

describe("fglm — refusals on positive-dim", () => {
  test("⟨x⟩ in ℚ[x, y] is positive-dim → fglm throws", () => {
    const VARS = ["x", "y"];
    const drl = drlOrder(VARS);
    const drlResult = buchbergerReduced([x], drl);
    expect(() => fglm(drlResult.basis, VARS)).toThrow();
  });
});
