// Tests for the basis-inverse module. The invariant we exercise is
// the most important one in the whole package: after a sequence of
// `pivotUpdate` calls, `invB` is genuinely the inverse of `B`, where
// `B`'s columns are read from the original `A` matrix at the basis
// indices. We check this via direct multiplication `B · invB == I`.

import { describe, test, expect } from "bun:test";
import {
  makeRat,
  RAT_ZERO,
  RAT_ONE,
  ratEq,
  ratMul,
  ratAdd,
  type Rat,
} from "@workbench/cas-core";
import {
  identityBasisInverse,
  solveBasis,
  solveBasisT,
  pivotUpdate,
  basisBitLength,
} from "../src/basis.js";

/** Multiply two dense rational matrices. Reference implementation for tests. */
function matMul(A: Rat[][], B: Rat[][]): Rat[][] {
  const m = A.length;
  const n = B[0]!.length;
  const k = B.length;
  const out: Rat[][] = [];
  for (let i = 0; i < m; i++) {
    const row: Rat[] = new Array(n);
    for (let j = 0; j < n; j++) {
      let s: Rat = RAT_ZERO;
      for (let l = 0; l < k; l++) {
        s = ratAdd(s, ratMul(A[i]![l]!, B[l]![j]!));
      }
      row[j] = s;
    }
    out.push(row);
  }
  return out;
}

function isIdentity(M: Rat[][]): boolean {
  const m = M.length;
  for (let i = 0; i < m; i++) {
    for (let j = 0; j < m; j++) {
      const expected = i === j ? RAT_ONE : RAT_ZERO;
      if (!ratEq(M[i]![j]!, expected)) return false;
    }
  }
  return true;
}

describe("identityBasisInverse", () => {
  test("3x3 is identity", () => {
    const bi = identityBasisInverse(3);
    expect(bi.m).toBe(3);
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        const v = bi.invB[i]![j]!;
        const expected = i === j ? RAT_ONE : RAT_ZERO;
        expect(ratEq(v, expected)).toBe(true);
      }
    }
  });
});

describe("solveBasis / solveBasisT against identity", () => {
  test("identity * v = v", () => {
    const bi = identityBasisInverse(3);
    const v = [makeRat(2n), makeRat(3n), makeRat(5n)];
    const y = solveBasis(bi, v);
    expect(ratEq(y[0]!, v[0]!)).toBe(true);
    expect(ratEq(y[1]!, v[1]!)).toBe(true);
    expect(ratEq(y[2]!, v[2]!)).toBe(true);
    const yT = solveBasisT(bi, v);
    expect(ratEq(yT[0]!, v[0]!)).toBe(true);
  });
});

describe("pivotUpdate maintains the inverse invariant", () => {
  test("swap one column of identity → still inverse", () => {
    // Start with B = I_3, invB = I_3. Pivot in column [1, 2, 3] at row 0.
    // The new basis matrix becomes
    //   B' = [[1, 0, 0],    ...wait: the basis indices conceptually point
    //         [2, 1, 0],    to columns of an external A matrix. For this
    //         [3, 0, 1]]    test we ignore basis indices and just check
    // The new invB' should satisfy invB' * B' == I.
    const bi0 = identityBasisInverse(3);
    const newCol: Rat[] = [makeRat(1n), makeRat(2n), makeRat(3n)];
    // eta = invB * newCol = newCol (since invB = I)
    const eta = newCol;
    const bi1 = pivotUpdate(bi0, eta, 0);
    // The new basis matrix B' has columns [newCol, e_2, e_3].
    const Bnew: Rat[][] = [
      [makeRat(1n), RAT_ZERO,    RAT_ZERO],
      [makeRat(2n), RAT_ONE,     RAT_ZERO],
      [makeRat(3n), RAT_ZERO,    RAT_ONE],
    ];
    const product = matMul(bi1.invB.map((r) => r.slice()), Bnew);
    expect(isIdentity(product)).toBe(true);
  });

  test("two consecutive pivots → still inverse", () => {
    // Pivot in [1, 2, 3] at row 0, then pivot in [4, 5, 6] at row 1.
    const bi0 = identityBasisInverse(3);
    const col1: Rat[] = [makeRat(1n), makeRat(2n), makeRat(3n)];
    const eta1 = solveBasis(bi0, col1);
    const bi1 = pivotUpdate(bi0, eta1, 0);

    const col2: Rat[] = [makeRat(4n), makeRat(5n), makeRat(6n)];
    const eta2 = solveBasis(bi1, col2);
    const bi2 = pivotUpdate(bi1, eta2, 1);

    // Final basis matrix B'' has columns [col1, col2, e_3].
    const Bfinal: Rat[][] = [
      [makeRat(1n), makeRat(4n), RAT_ZERO],
      [makeRat(2n), makeRat(5n), RAT_ZERO],
      [makeRat(3n), makeRat(6n), RAT_ONE],
    ];
    const product = matMul(bi2.invB.map((r) => r.slice()), Bfinal);
    expect(isIdentity(product)).toBe(true);
  });

  test("rejects zero pivot", () => {
    const bi = identityBasisInverse(3);
    const eta: Rat[] = [RAT_ZERO, makeRat(2n), makeRat(3n)];
    expect(() => pivotUpdate(bi, eta, 0)).toThrow();
  });
});

describe("basisBitLength", () => {
  test("identity has bit-length 1", () => {
    expect(basisBitLength(identityBasisInverse(5))).toBe(1);
  });
});
