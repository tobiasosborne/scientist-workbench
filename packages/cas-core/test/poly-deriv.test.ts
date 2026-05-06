// =============================================================================
// polyDeriv — partial derivative wrt a named variable
// =============================================================================
//
// These tests assert structural invariants of the derivative operator
// rather than mere "didn't throw" behaviour:
//   • d(c)/dv = 0 for any constant c
//   • d(v)/dv = 1
//   • d(v^k)/dv = k·v^(k-1)
//   • Linearity: d(a + b)/dv = da/dv + db/dv
//   • Product rule: d(a·b)/dv = a·(db/dv) + b·(da/dv)
//   • Independent variables: ∂x/∂y = 0
//   • Mixed partials commute: ∂²f/∂x∂y = ∂²f/∂y∂x
//
// The product-rule check is the load-bearing one — implementing
// derivative naively (forgetting to handle multivariate exponents) still
// passes the linear/atomic checks but breaks here.

import { describe, expect, test } from "bun:test";
import {
  makeRat,
  polyAdd,
  polyConst,
  polyDeriv,
  polyEq,
  polyMul,
  polyVar,
  polyZero,
  polyPow,
  RAT_ONE,
  RAT_RING,
  RAT_ZERO,
  type Rat,
} from "../src/index.js";

const r = (n: number | bigint, d: number | bigint = 1): Rat =>
  makeRat(BigInt(n), BigInt(d));

const x = polyVar<Rat>("x", RAT_RING);
const y = polyVar<Rat>("y", RAT_RING);
const constP = (c: Rat) => polyConst<Rat>(c, RAT_RING);

describe("polyDeriv", () => {
  test("d(constant)/dx = 0", () => {
    const seven = constP(r(7));
    expect(polyEq(polyDeriv(seven, "x", RAT_RING), polyZero(), RAT_RING)).toBe(true);
  });

  test("d(x)/dx = 1", () => {
    expect(polyEq(polyDeriv(x, "x", RAT_RING), constP(RAT_ONE), RAT_RING)).toBe(true);
  });

  test("d(x^5)/dx = 5x^4", () => {
    const lhs = polyDeriv(polyPow(x, 5, RAT_RING), "x", RAT_RING);
    const rhs = polyMul(constP(r(5)), polyPow(x, 4, RAT_RING), RAT_RING);
    expect(polyEq(lhs, rhs, RAT_RING)).toBe(true);
  });

  test("∂x/∂y = 0 (independent variables)", () => {
    expect(polyEq(polyDeriv(x, "y", RAT_RING), polyZero(), RAT_RING)).toBe(true);
  });

  test("linearity: d(2x + 3x^2)/dx = 2 + 6x", () => {
    const f = polyAdd(
      polyMul(constP(r(2)), x, RAT_RING),
      polyMul(constP(r(3)), polyPow(x, 2, RAT_RING), RAT_RING),
      RAT_RING,
    );
    const df = polyDeriv(f, "x", RAT_RING);
    const expected = polyAdd(
      constP(r(2)),
      polyMul(constP(r(6)), x, RAT_RING),
      RAT_RING,
    );
    expect(polyEq(df, expected, RAT_RING)).toBe(true);
  });

  test("product rule: d((x+1)(x-1))/dx = 2x", () => {
    const xPlus1 = polyAdd(x, constP(RAT_ONE), RAT_RING);
    const xMinus1 = polyAdd(x, constP(makeRat(-1n, 1n)), RAT_RING);
    const f = polyMul(xPlus1, xMinus1, RAT_RING);                  // x^2 - 1
    const df = polyDeriv(f, "x", RAT_RING);
    const expected = polyMul(constP(r(2)), x, RAT_RING);
    expect(polyEq(df, expected, RAT_RING)).toBe(true);
  });

  test("multivariate: ∂(x²·y³)/∂x = 2·x·y³", () => {
    const f = polyMul(polyPow(x, 2, RAT_RING), polyPow(y, 3, RAT_RING), RAT_RING);
    const dfdx = polyDeriv(f, "x", RAT_RING);
    const expected = polyMul(
      polyMul(constP(r(2)), x, RAT_RING),
      polyPow(y, 3, RAT_RING),
      RAT_RING,
    );
    expect(polyEq(dfdx, expected, RAT_RING)).toBe(true);
  });

  test("mixed partials commute: ∂²(x²·y³)/∂x∂y == ∂²(x²·y³)/∂y∂x", () => {
    const f = polyMul(polyPow(x, 2, RAT_RING), polyPow(y, 3, RAT_RING), RAT_RING);
    const dxdy = polyDeriv(polyDeriv(f, "x", RAT_RING), "y", RAT_RING);
    const dydx = polyDeriv(polyDeriv(f, "y", RAT_RING), "x", RAT_RING);
    expect(polyEq(dxdy, dydx, RAT_RING)).toBe(true);
  });

  test("d(0)/dx = 0", () => {
    expect(polyEq(polyDeriv(polyZero<Rat>(), "x", RAT_RING), polyZero(), RAT_RING)).toBe(true);
  });
});
