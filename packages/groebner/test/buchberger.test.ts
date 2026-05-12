// =============================================================================
// buchberger.test.ts — Buchberger's algorithm: small classics + invariants
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
import {
  buchbergerReduced,
  isZeroDimensional,
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
const z = polyVar<Rat>("z", RAT_RING);
const ONE = polyConst<Rat>(makeRat(1n, 1n), RAT_RING);

const c = (n: bigint, d: bigint = 1n): Poly<Rat> => polyConst<Rat>(makeRat(n, d), RAT_RING);

describe("buchbergerReduced — classic CLO §6 Example 1", () => {
  test("(x²+y, xy+1) under lex(x>y) → expected reduced GB has 2 elements", () => {
    const VARS = ["x", "y"];
    const lex = lexOrder(VARS);
    const f1 = polyAdd(polyMul(x, x, RAT_RING), y, RAT_RING);
    const f2 = polyAdd(polyMul(x, y, RAT_RING), c(1n), RAT_RING);
    const result = buchbergerReduced([f1, f2], lex);
    expect(result.basis.length).toBe(2);
    // Every S-pair of the basis reduces to 0.
    for (let i = 0; i < result.basis.length; i++) {
      for (let j = i + 1; j < result.basis.length; j++) {
        const s = sPolynomial(result.basis[i]!, result.basis[j]!, lex);
        const r = polyNormalForm(s, result.basis, lex);
        expect(polyIsZero(r)).toBe(true);
      }
    }
  });

  test("input polynomials reduce to 0 mod the basis (ideal containment)", () => {
    const VARS = ["x", "y"];
    const lex = lexOrder(VARS);
    const f1 = polyAdd(polyMul(x, x, RAT_RING), y, RAT_RING);
    const f2 = polyAdd(polyMul(x, y, RAT_RING), c(1n), RAT_RING);
    const result = buchbergerReduced([f1, f2], lex);
    expect(polyIsZero(polyNormalForm(f1, result.basis, lex))).toBe(true);
    expect(polyIsZero(polyNormalForm(f2, result.basis, lex))).toBe(true);
  });
});

describe("buchbergerReduced — cyclic-3", () => {
  test("cyclic-3 system has a finite GB under DRL(x,y,z)", () => {
    // Cyclic-3: x + y + z, xy + yz + zx, xyz - 1.
    const VARS = ["x", "y", "z"];
    const drl = drlOrder(VARS);
    const f1 = polyAdd(polyAdd(x, y, RAT_RING), z, RAT_RING);
    const xy = polyMul(x, y, RAT_RING);
    const yz = polyMul(y, z, RAT_RING);
    const zx = polyMul(z, x, RAT_RING);
    const f2 = polyAdd(polyAdd(xy, yz, RAT_RING), zx, RAT_RING);
    const f3 = polyAdd(polyMul(xy, z, RAT_RING), c(-1n), RAT_RING);
    const result = buchbergerReduced([f1, f2, f3], drl);
    expect(result.basis.length).toBeGreaterThan(0);

    // S-pair invariant: every pair reduces to 0.
    for (let i = 0; i < result.basis.length; i++) {
      for (let j = i + 1; j < result.basis.length; j++) {
        const s = sPolynomial(result.basis[i]!, result.basis[j]!, drl);
        const r = polyNormalForm(s, result.basis, drl);
        expect(polyIsZero(r)).toBe(true);
      }
    }
    // Inputs reduce to 0.
    for (const f of [f1, f2, f3]) {
      expect(polyIsZero(polyNormalForm(f, result.basis, drl))).toBe(true);
    }
  });
});

describe("buchbergerReduced — already-a-GB inputs are idempotent", () => {
  test("monomial ideal {x², y²} is its own reduced GB", () => {
    const VARS = ["x", "y"];
    const lex = lexOrder(VARS);
    const xSq = polyMul(x, x, RAT_RING);
    const ySq = polyMul(y, y, RAT_RING);
    const result = buchbergerReduced([xSq, ySq], lex);
    expect(result.basis.length).toBe(2);
    // Re-feed: still 2 elements.
    const second = buchbergerReduced(result.basis, lex);
    expect(second.basis.length).toBe(2);
  });
});

describe("buchbergerReduced — inconsistent system", () => {
  test("ideal containing 1 → GB = [1]", () => {
    const VARS = ["x"];
    const lex = lexOrder(VARS);
    // Inputs: 1, x. Ideal generated is ⟨1⟩ = ℚ[x]; GB is [1].
    const result = buchbergerReduced([ONE, x], lex);
    expect(result.basis.length).toBe(1);
    const lt = leadingTerm(result.basis[0]!, lex);
    expect(lt).not.toBeNull();
    expect(lt!.exp.length).toBe(0); // constant 1
  });
});

describe("isZeroDimensional", () => {
  test("(x²+y, xy+1) under lex(x>y) is zero-dimensional", () => {
    const VARS = ["x", "y"];
    const lex = lexOrder(VARS);
    const f1 = polyAdd(polyMul(x, x, RAT_RING), y, RAT_RING);
    const f2 = polyAdd(polyMul(x, y, RAT_RING), c(1n), RAT_RING);
    const r = buchbergerReduced([f1, f2], lex);
    expect(isZeroDimensional(r.basis, VARS, lex)).toBe(true);
  });
  test("⟨x⟩ in ℚ[x, y] is NOT zero-dimensional (y is free)", () => {
    const VARS = ["x", "y"];
    const lex = lexOrder(VARS);
    const r = buchbergerReduced([x], lex);
    expect(isZeroDimensional(r.basis, VARS, lex)).toBe(false);
  });
  test("⟨x²⟩ in ℚ[x] IS zero-dim (x has pure power)", () => {
    const VARS = ["x"];
    const lex = lexOrder(VARS);
    const r = buchbergerReduced([polyMul(x, x, RAT_RING)], lex);
    expect(isZeroDimensional(r.basis, VARS, lex)).toBe(true);
  });
});

describe("buchbergerReduced — mutation-prove (defensive)", () => {
  test("DROP a basis element → input no longer reduces to 0", () => {
    // Mutation-prove discipline (CLAUDE.md Rule 6): the test must
    // catch a real regression. We take the cyclic-3 GB, drop one
    // element, and verify that at least one input polynomial no
    // longer reduces to 0 mod the truncated basis. Without this
    // sensitivity check the "ideal-equality" claim is unsupported.
    const VARS = ["x", "y", "z"];
    const drl = drlOrder(VARS);
    const f1 = polyAdd(polyAdd(x, y, RAT_RING), z, RAT_RING);
    const xy = polyMul(x, y, RAT_RING);
    const yz = polyMul(y, z, RAT_RING);
    const zx = polyMul(z, x, RAT_RING);
    const f2 = polyAdd(polyAdd(xy, yz, RAT_RING), zx, RAT_RING);
    const f3 = polyAdd(polyMul(xy, z, RAT_RING), c(-1n), RAT_RING);
    const result = buchbergerReduced([f1, f2, f3], drl);
    expect(result.basis.length).toBeGreaterThan(1);

    // Drop the leading basis element (which has the smallest LM in
    // the descending sort — the univariate-in-z polynomial). Inputs
    // that depended on that element to reduce will now have a non-
    // zero residue.
    const truncated = result.basis.slice(1);

    let someNonZero = false;
    for (const f of [f1, f2, f3]) {
      const r = polyNormalForm(f, truncated, drl);
      if (!polyIsZero(r)) { someNonZero = true; break; }
    }
    expect(someNonZero).toBe(true);
  });
});
