// =============================================================================
// multidiv.test.ts — multivariate polynomial division (CLO Ch.2 §3 Theorem 3)
// =============================================================================

import { describe, expect, test } from "bun:test";
import {
  type Poly,
  type Rat,
  RAT_RING,
  makeRat,
  polyAdd,
  polyConst,
  polyEq,
  polyFromCoeffsInVar,
  polyIsZero,
  polyMul,
  polyVar,
} from "@workbench/cas-core";
import {
  drlOrder,
  lexOrder,
} from "../src/monomial-order.js";
import {
  leadingTerm,
  polyMultiDivRem,
  polyNormalForm,
} from "../src/multidiv.js";

const x = polyVar<Rat>("x", RAT_RING);
const y = polyVar<Rat>("y", RAT_RING);

const c = (n: bigint, d: bigint = 1n): Poly<Rat> => polyConst<Rat>(makeRat(n, d), RAT_RING);

const VARS = ["x", "y"];

describe("leadingTerm", () => {
  test("zero polynomial → null", () => {
    expect(leadingTerm(polyConst<Rat>(makeRat(0n, 1n), RAT_RING), lexOrder(VARS))).toBeNull();
  });
  test("under lex(x>y), x²y > xy² (LM is x²y)", () => {
    // f = x²y + xy²
    const f = polyAdd(polyMul(polyMul(x, x, RAT_RING), y, RAT_RING), polyMul(x, polyMul(y, y, RAT_RING), RAT_RING), RAT_RING);
    const lt = leadingTerm(f, lexOrder(VARS));
    expect(lt).not.toBeNull();
    // x²y exponent = [["x", 2], ["y", 1]]
    expect(lt!.exp).toEqual([["x", 2], ["y", 1]]);
  });
  test("under DRL(x,y), xy² < x²y so LM is x²y as well — but try a degree-tied case", () => {
    // f = x³ + y³ — degrees both 3. Under DRL(x,y) the LM walks
    // right-to-left; the variable y is encountered first; for x³, y=0;
    // for y³, y=3. Smaller exp wins ⇒ x³ > y³ ⇒ LM = x³.
    const f = polyAdd(polyMul(polyMul(x, x, RAT_RING), x, RAT_RING), polyMul(polyMul(y, y, RAT_RING), y, RAT_RING), RAT_RING);
    const lt = leadingTerm(f, drlOrder(VARS));
    expect(lt!.exp).toEqual([["x", 3]]);
  });
});

describe("polyMultiDivRem (CLO Ch.2 §3 Theorem 3)", () => {
  test("CLO Example 4 — divisor order matters for quotient", () => {
    // f = xy² + 1, F1 = (xy + 1, y² − 1) under lex(x>y).
    // Per CLO Ex 4, dividing by (xy+1, y²−1) yields q1 = y, q2 = 1, r = y + 1.
    // Dividing by (y²−1, xy+1) yields q1 = x, q2 = 0, r = x + 1.
    const lex = lexOrder(VARS);
    const f = polyAdd(polyMul(x, polyMul(y, y, RAT_RING), RAT_RING), c(1n), RAT_RING);
    const xyP1 = polyAdd(polyMul(x, y, RAT_RING), c(1n), RAT_RING);
    const ySqM1 = polyAdd(polyMul(y, y, RAT_RING), c(-1n), RAT_RING);

    const r1 = polyMultiDivRem(f, [xyP1, ySqM1], lex);
    // Reconstruct: f = q1 * (xy+1) + q2 * (y²-1) + r1.
    const recon1 = polyAdd(
      polyAdd(
        polyMul(r1.quotients[0]!, xyP1, RAT_RING),
        polyMul(r1.quotients[1]!, ySqM1, RAT_RING),
        RAT_RING,
      ),
      r1.remainder,
      RAT_RING,
    );
    expect(polyEq(recon1, f, RAT_RING)).toBe(true);

    const r2 = polyMultiDivRem(f, [ySqM1, xyP1], lex);
    const recon2 = polyAdd(
      polyAdd(
        polyMul(r2.quotients[0]!, ySqM1, RAT_RING),
        polyMul(r2.quotients[1]!, xyP1, RAT_RING),
        RAT_RING,
      ),
      r2.remainder,
      RAT_RING,
    );
    expect(polyEq(recon2, f, RAT_RING)).toBe(true);

    // Mutation: the remainders SHOULD differ (CLO Ex 4 — the divisor
    // order matters when the divisor list is not a Gröbner basis).
    expect(polyEq(r1.remainder, r2.remainder, RAT_RING)).toBe(false);
  });

  test("polyNormalForm: divisor list = a single linear divisor; result equivalent to univariate", () => {
    // f = x² − 1, divisor = x − 1 (over ℚ[x, y], lex(x>y)). Remainder
    // should be 0.
    const lex = lexOrder(VARS);
    const f = polyAdd(polyMul(x, x, RAT_RING), c(-1n), RAT_RING);
    const xM1 = polyAdd(x, c(-1n), RAT_RING);
    const r = polyNormalForm(f, [xM1], lex);
    expect(polyIsZero(r)).toBe(true);
  });

  test("zero divisor throws", () => {
    const lex = lexOrder(VARS);
    expect(() => polyMultiDivRem(x, [polyConst<Rat>(makeRat(0n, 1n), RAT_RING)], lex)).toThrow();
  });
});

// silence unused-imports warning; kept for symmetry with other test files.
void polyFromCoeffsInVar;
