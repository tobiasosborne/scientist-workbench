// Matrix substrate — construction, basic ops, complex-aware predicates.
// Tests assert invariants, not "didn't throw" (Rule 7).

import { describe, expect, test } from "bun:test";
import {
  eye,
  fromNested,
  fromNestedComplex,
  isReal,
  toNested,
  toNestedComplex,
  trace,
  transpose,
  adjoint,
  matmul,
  add,
  sub,
  scale,
  maxAbsDiff,
} from "../src/index.js";

describe("matrix construction", () => {
  test("fromNested → toNested round-trip", () => {
    const A = fromNested([[1, 2, 3], [4, 5, 6]]);
    expect(A.rows).toBe(2);
    expect(A.cols).toBe(3);
    expect(isReal(A)).toBe(true);
    expect(toNested(A)).toEqual([[1, 2, 3], [4, 5, 6]]);
  });

  test("eye(n) is the n × n identity", () => {
    const I = eye(3);
    expect(toNested(I)).toEqual([[1, 0, 0], [0, 1, 0], [0, 0, 1]]);
    expect(trace(I).re).toBe(3);
  });

  test("fromNestedComplex round-trip preserves re and im", () => {
    const re = [[1, 0], [0, 1]];
    const im = [[0, -1], [1, 0]];
    const M = fromNestedComplex(re, im);
    expect(isReal(M)).toBe(false);
    const back = toNestedComplex(M);
    expect(back.re).toEqual(re);
    expect(back.im).toEqual(im);
  });
});

describe("transpose / adjoint", () => {
  test("transpose swaps indices (real)", () => {
    const A = fromNested([[1, 2, 3], [4, 5, 6]]);
    const AT = transpose(A);
    expect(toNested(AT)).toEqual([[1, 4], [2, 5], [3, 6]]);
  });

  test("transpose does NOT conjugate (complex)", () => {
    const A = fromNestedComplex([[1, 0], [0, 1]], [[0, 1], [-1, 0]]);
    const AT = transpose(A);
    const { re, im } = toNestedComplex(AT);
    expect(re).toEqual([[1, 0], [0, 1]]);
    // The im part flips by transpose only (no sign change).
    expect(im).toEqual([[0, -1], [1, 0]]);
  });

  test("adjoint conjugates the transpose (complex)", () => {
    // For a Hermitian matrix, adjoint should fix it: H† = H.
    // Use the Pauli-Y matrix: Y = [[0, -i], [i, 0]].
    const Y = fromNestedComplex([[0, 0], [0, 0]], [[0, -1], [1, 0]]);
    expect(maxAbsDiff(adjoint(Y), Y)).toBe(0);
    // And the off-diagonal: adjoint of M = [[0, 1+i], [0, 0]] is [[0, 0], [1-i, 0]].
    const M = fromNestedComplex([[0, 1], [0, 0]], [[0, 1], [0, 0]]);
    const Mad = fromNestedComplex([[0, 0], [1, 0]], [[0, 0], [-1, 0]]);
    expect(maxAbsDiff(adjoint(M), Mad)).toBe(0);
  });

  test("adjoint(adjoint(M)) = M (involution)", () => {
    const A = fromNestedComplex([[1, 2], [3, 4]], [[5, 6], [7, 8]]);
    const AA = adjoint(adjoint(A));
    expect(maxAbsDiff(AA, A)).toBe(0);
  });
});

describe("matmul", () => {
  test("identity is multiplicative identity", () => {
    const I = eye(3);
    const A = fromNested([[1, 2, 3], [4, 5, 6], [7, 8, 9]]);
    expect(maxAbsDiff(matmul(I, A), A)).toBe(0);
    expect(maxAbsDiff(matmul(A, I), A)).toBe(0);
  });

  test("real × real (2×3)(3×2) = (2×2) by hand", () => {
    const A = fromNested([[1, 2, 3], [4, 5, 6]]);
    const B = fromNested([[1, 2], [3, 4], [5, 6]]);
    // A·B = [[22, 28], [49, 64]]
    const C = matmul(A, B);
    expect(toNested(C)).toEqual([[22, 28], [49, 64]]);
  });

  test("i · i = -1 (complex)", () => {
    // 1×1 complex matrices [i]·[i] = [-1].
    const iMat = fromNestedComplex([[0]], [[1]]);
    const C = matmul(iMat, iMat);
    const { re, im } = toNestedComplex(C);
    expect(re[0]![0]).toBe(-1);
    expect(im[0]![0]).toBe(0);
  });
});

describe("add / sub / scale", () => {
  test("add then sub recovers", () => {
    const A = fromNested([[1, 2], [3, 4]]);
    const B = fromNested([[5, 6], [7, 8]]);
    expect(maxAbsDiff(sub(add(A, B), B), A)).toBe(0);
  });

  test("scale by 0 zeroes; scale by 1 identity", () => {
    const A = fromNested([[1, 2], [3, 4]]);
    expect(scale(0, A).re.every((x) => x === 0)).toBe(true);
    expect(maxAbsDiff(scale(1, A), A)).toBe(0);
  });

  test("scale by i rotates real → imaginary", () => {
    const A = fromNested([[1, 2], [3, 4]]);
    const iA = scale({ re: 0, im: 1 }, A);
    const { re, im } = toNestedComplex(iA);
    expect(re).toEqual([[0, 0], [0, 0]]);
    expect(im).toEqual([[1, 2], [3, 4]]);
  });
});
