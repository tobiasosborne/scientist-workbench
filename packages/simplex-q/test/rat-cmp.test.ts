// Tests for the total order on Rat. Brief — the operations are
// one-liners over already-tested BigInt arithmetic; we test the
// edge cases that would reveal sign-flip or normalisation bugs.

import { describe, test, expect } from "bun:test";
import { makeRat, RAT_ZERO, RAT_ONE, RAT_NEG_ONE } from "@workbench/cas-core";
import { ratCompare, ratLt, ratLe, ratGt, ratGe, ratIsPositive, ratBitLength } from "../src/rat-cmp.js";

describe("ratCompare", () => {
  test("0 < 1 < 2", () => {
    expect(ratCompare(RAT_ZERO, RAT_ONE)).toBe(-1);
    expect(ratCompare(RAT_ONE, makeRat(2n))).toBe(-1);
    expect(ratCompare(RAT_ONE, RAT_ZERO)).toBe(1);
  });

  test("equality of normalised forms", () => {
    expect(ratCompare(makeRat(6n, 4n), makeRat(3n, 2n))).toBe(0);
  });

  test("negatives", () => {
    expect(ratCompare(RAT_NEG_ONE, RAT_ZERO)).toBe(-1);
    expect(ratCompare(RAT_NEG_ONE, makeRat(-2n))).toBe(1);
  });

  test("cross-sign with different denominators", () => {
    // 2/3 vs -3/4: 2*4 = 8, -3*3 = -9 → 8 > -9 → 2/3 > -3/4
    expect(ratCompare(makeRat(2n, 3n), makeRat(-3n, 4n))).toBe(1);
  });

  test("strict variants", () => {
    expect(ratLt(RAT_ZERO, RAT_ONE)).toBe(true);
    expect(ratLt(RAT_ONE, RAT_ONE)).toBe(false);
    expect(ratLe(RAT_ONE, RAT_ONE)).toBe(true);
    expect(ratGt(RAT_ONE, RAT_ZERO)).toBe(true);
    expect(ratGe(RAT_ONE, RAT_ONE)).toBe(true);
  });

  test("ratIsPositive", () => {
    expect(ratIsPositive(RAT_ONE)).toBe(true);
    expect(ratIsPositive(RAT_ZERO)).toBe(false);
    expect(ratIsPositive(RAT_NEG_ONE)).toBe(false);
  });
});

describe("ratBitLength", () => {
  test("zero", () => {
    expect(ratBitLength(RAT_ZERO)).toBe(0);
  });

  test("integers", () => {
    expect(ratBitLength(RAT_ONE)).toBe(1); // 1n.toString(2) = "1"
    expect(ratBitLength(makeRat(7n))).toBe(3); // 111
    expect(ratBitLength(makeRat(8n))).toBe(4); // 1000
  });

  test("large rational", () => {
    const huge = 1n << 100n;
    expect(ratBitLength(makeRat(huge))).toBe(101);
  });

  test("denominator dominates", () => {
    expect(ratBitLength(makeRat(1n, 1n << 50n))).toBe(51);
  });
});
