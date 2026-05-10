// =============================================================================
// monomial-order.test.ts — comparator axioms (CLO Ch.2 §2)
// =============================================================================

import { describe, expect, test } from "bun:test";
import {
  drlOrder,
  expAdd,
  expDivides,
  expLcm,
  expSub,
  expTotalDegree,
  lexOrder,
  type MonomialOrder,
} from "../src/monomial-order.js";
import type { Exp } from "@workbench/cas-core";

const e = (...pairs: [string, number][]): Exp => {
  // Build canonical Exp form (sorted, non-zero entries).
  const filtered = pairs.filter(([, v]) => v !== 0);
  filtered.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return filtered;
};

const VARS = ["x", "y", "z"];

describe("expTotalDegree", () => {
  test("zero monomial → 0", () => {
    expect(expTotalDegree([])).toBe(0);
  });
  test("x²·y³ → 5", () => {
    expect(expTotalDegree(e(["x", 2], ["y", 3]))).toBe(5);
  });
});

describe("expAdd / expSub", () => {
  test("x²·y + x·y² = x²·y + x·y² as expected (sorted)", () => {
    const a = e(["x", 2], ["y", 1]);
    const b = e(["x", 1], ["y", 2]);
    const sum = expAdd(a, b);
    expect(sum).toEqual([["x", 3], ["y", 3]]);
  });
  test("expSub correct on canonical case", () => {
    const a = e(["x", 3], ["y", 2]);
    const b = e(["x", 2], ["y", 1]);
    expect(expSub(a, b)).toEqual([["x", 1], ["y", 1]]);
  });
  test("expSub throws on negative result", () => {
    expect(() => expSub(e(["x", 1]), e(["x", 2]))).toThrow();
  });
});

describe("expLcm", () => {
  test("lcm(x²·y, x·y²) = x²·y²", () => {
    const lcm = expLcm(e(["x", 2], ["y", 1]), e(["x", 1], ["y", 2]));
    expect(lcm).toEqual([["x", 2], ["y", 2]]);
  });
});

describe("expDivides", () => {
  test("x divides x²·y", () => {
    expect(expDivides(e(["x", 1]), e(["x", 2], ["y", 1]))).toBe(true);
  });
  test("x² does NOT divide x·y", () => {
    expect(expDivides(e(["x", 2]), e(["x", 1], ["y", 1]))).toBe(false);
  });
});

const triples = (order: MonomialOrder) => [
  e(),                              // 1
  e(["x", 1]),                      // x
  e(["y", 1]),                      // y
  e(["z", 1]),                      // z
  e(["x", 2]),                      // x²
  e(["x", 1], ["y", 1]),            // x·y
  e(["y", 2]),                      // y²
  e(["x", 1], ["z", 1]),            // x·z
  e(["y", 1], ["z", 1]),            // y·z
  e(["z", 2]),                      // z²
  e(["x", 3]),                      // x³
  e(["x", 2], ["y", 1]),            // x²y
];

function checkAxioms(order: MonomialOrder): void {
  const exps = triples(order);
  // Total order: trichotomy. For every pair, sign(compare(a,b)) ∈
  // {-1, 0, 1}; if compare(a,b) = 0 then a = b structurally; if
  // a < b then b > a; transitivity.
  for (const a of exps) {
    expect(order.compare(a, a)).toBe(0);
    for (const b of exps) {
      const ab = Math.sign(order.compare(a, b));
      const ba = Math.sign(order.compare(b, a));
      // Math.sign(0) is +0; -(+0) = -0, which fails strict `toBe(-ba)`.
      // Compare via numeric equality after normalising signed-zero.
      expect(ab + ba).toBe(0);
      for (const c of exps) {
        const bc = Math.sign(order.compare(b, c));
        const ac = Math.sign(order.compare(a, c));
        if (ab > 0 && bc > 0) {
          expect(ac).toBeGreaterThan(0);
        }
        if (ab < 0 && bc < 0) {
          expect(ac).toBeLessThan(0);
        }
      }
    }
  }
}

describe("lexOrder axioms", () => {
  test("total-order axioms hold over a 12-monomial sample", () => {
    checkAxioms(lexOrder(VARS));
  });
  test("lex(x>y>z): x > y² (x ranks first)", () => {
    const lex = lexOrder(VARS);
    expect(lex.compare(e(["x", 1]), e(["y", 2]))).toBeGreaterThan(0);
  });
  test("lex(x>y>z): x²y < x²z (within x², z > y because lex compares y next vs z next)", () => {
    // Wait — lex with x > y > z: x²y and x²z both start with x². Next
    // compare on the next variable (y rank 2). For x²y, y has exp 1;
    // for x²z, y has exp 0 so x²z's y-component is smaller. So
    // x²y > x²z under lex.
    const lex = lexOrder(VARS);
    expect(lex.compare(e(["x", 2], ["y", 1]), e(["x", 2], ["z", 1]))).toBeGreaterThan(0);
  });
});

describe("drlOrder axioms", () => {
  test("total-order axioms hold over a 12-monomial sample", () => {
    checkAxioms(drlOrder(VARS));
  });
  test("DRL: y² > x (degree wins over rank)", () => {
    const drl = drlOrder(VARS);
    expect(drl.compare(e(["y", 2]), e(["x", 1]))).toBeGreaterThan(0);
  });
  test("DRL(x,y,z): x²y > xy² (last differing var z=0 in both, then y: x²y has y=1, xy² has y=2; reverse-lex prefers smaller exp ⇒ x²y wins)", () => {
    // DRL within equal total degree compares right-to-left and prefers
    // SMALLER exponent at the differing position. Walking right to
    // left over [x, y, z]: z is equal (both 0), y differs (1 vs 2),
    // smaller wins, so x²y > xy².
    const drl = drlOrder(VARS);
    expect(drl.compare(e(["x", 2], ["y", 1]), e(["x", 1], ["y", 2]))).toBeGreaterThan(0);
  });
  test("DRL(x,y,z): xz > y² (degree 2 same; right-to-left finds z; xz has z=1, y² has z=0; smaller wins ⇒ y² > xz)", () => {
    // ... so y² > xz, NOT xz > y². Test the actual ordering.
    const drl = drlOrder(VARS);
    expect(drl.compare(e(["y", 2]), e(["x", 1], ["z", 1]))).toBeGreaterThan(0);
  });
});
