// Kronecker product — invariants (Rule 7). Most decisive: the mixed-product
// law (A⊗B)(C⊗D) = (AC)⊗(BD). If kron is wrong even by an index permutation,
// the mixed-product law fails immediately.

import { describe, expect, test } from "bun:test";
import {
  eye,
  fromNested,
  fromNestedComplex,
  isReal,
  toNested,
  toNestedComplex,
  trace,
  matmul,
  maxAbsDiff,
  kron,
  kron2,
} from "../src/index.js";

describe("kron shape", () => {
  test("(m_A × n_A) ⊗ (m_B × n_B) = (m_A·m_B × n_A·n_B)", () => {
    const A = fromNested([[1, 2], [3, 4], [5, 6]]); // 3 × 2
    const B = fromNested([[7, 8, 9], [0, 1, 2]]);    // 2 × 3
    const AB = kron2(A, B);
    expect(AB.rows).toBe(6);
    expect(AB.cols).toBe(6);
  });
});

describe("kron canonical small case", () => {
  test("|0⟩⟨0| ⊗ |1⟩⟨1| has a 1 at index (1,1) only", () => {
    const k0b0 = fromNested([[1, 0], [0, 0]]);
    const k1b1 = fromNested([[0, 0], [0, 1]]);
    // The 4×4 Kronecker product has the (i_A, j_A)-block = A[i_A, j_A] · B.
    // Only A[0,0] = 1; so only the (0,0)-block is non-zero, and inside that
    // only B[1,1] = 1 — i.e. element (1,1) of the 4×4 result.
    const out = toNested(kron2(k0b0, k1b1));
    expect(out).toEqual([[0, 0, 0, 0], [0, 1, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]]);
  });

  test("I_2 ⊗ I_3 = I_6", () => {
    expect(maxAbsDiff(kron2(eye(2), eye(3)), eye(6))).toBe(0);
  });
});

describe("kron mixed-product law (A⊗B)(C⊗D) = (AC) ⊗ (BD)", () => {
  test("real 2×2 × 2×2", () => {
    const A = fromNested([[1, 2], [3, 4]]);
    const B = fromNested([[5, 6], [7, 8]]);
    const C = fromNested([[9, 10], [11, 12]]);
    const D = fromNested([[13, 14], [15, 16]]);
    const lhs = matmul(kron2(A, B), kron2(C, D));
    const rhs = kron2(matmul(A, C), matmul(B, D));
    expect(maxAbsDiff(lhs, rhs)).toBeLessThan(1e-10);
  });

  test("complex 2×2 × 2×2 (Pauli-X ⊗ Pauli-Y on identities)", () => {
    // X = [[0,1],[1,0]] real; Y = [[0,-i],[i,0]] complex.
    const X = fromNested([[0, 1], [1, 0]]);
    const Y = fromNestedComplex([[0, 0], [0, 0]], [[0, -1], [1, 0]]);
    // (X⊗Y)(X⊗Y) = (X²⊗Y²) = (I⊗I) = I_4.
    const XY = kron2(X, Y);
    const sq = matmul(XY, XY);
    expect(maxAbsDiff(sq, eye(4))).toBeLessThan(1e-10);
  });
});

describe("kron trace identity tr(A⊗B) = tr(A)·tr(B)", () => {
  test("real 2×2 case", () => {
    const A = fromNested([[1, 2], [3, 4]]);   // tr = 5
    const B = fromNested([[5, 6], [7, 8]]);   // tr = 13
    const t = trace(kron2(A, B));
    expect(t.re).toBe(5 * 13);
    expect(t.im).toBe(0);
  });

  test("complex 2×2 case", () => {
    const A = fromNestedComplex([[1, 0], [0, 2]], [[0, 0], [0, 0]]); // tr = 3
    const B = fromNestedComplex([[0, 0], [0, 0]], [[1, 0], [0, 1]]); // tr = 2i
    const t = trace(kron2(A, B));
    // 3 · 2i = 6i
    expect(Math.abs(t.re)).toBeLessThan(1e-12);
    expect(t.im).toBeCloseTo(6, 12);
  });
});

describe("kron variadic + associativity", () => {
  test("kron(A, B, C) = (A ⊗ B) ⊗ C = A ⊗ (B ⊗ C)", () => {
    const A = fromNested([[1, 2], [3, 4]]);
    const B = fromNested([[5, 6], [7, 8]]);
    const C = fromNested([[9, 10], [11, 12]]);
    const left = kron2(kron2(A, B), C);
    const right = kron2(A, kron2(B, C));
    const all = kron(A, B, C);
    expect(maxAbsDiff(left, right)).toBe(0);
    expect(maxAbsDiff(all, right)).toBe(0);
  });

  test("kron(A) returns A unchanged (modulo allocation)", () => {
    const A = fromNested([[1, 2], [3, 4]]);
    const out = kron(A);
    expect(maxAbsDiff(out, A)).toBe(0);
    expect(out).not.toBe(A); // fresh allocation, not aliased
  });
});

describe("kron preserves real/complex flags", () => {
  test("real ⊗ real is real", () => {
    expect(isReal(kron2(fromNested([[1]]), fromNested([[1]])))).toBe(true);
  });

  test("real ⊗ complex is complex", () => {
    const C = fromNestedComplex([[1]], [[0]]);
    expect(isReal(kron2(fromNested([[1]]), C))).toBe(false);
  });
});
