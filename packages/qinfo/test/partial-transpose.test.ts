// Partial transpose — invariants. Decisive cases:
//   * Involution: PT(PT(M)) = M.
//   * PT on the WHOLE system equals plain transpose.
//   * PT(A⊗B) on the second factor equals A ⊗ B^T.
//   * Bell-state PPT criterion: |Φ+⟩⟨Φ+| has min eigenvalue -1/2 after PT
//     on one subsystem. We verify the matrix form here; the eigenvalue
//     check is in the tools/partial-transpose goldens (uses linalg-eigh).

import { describe, expect, test } from "bun:test";
import {
  eye,
  fromNested,
  fromNestedComplex,
  toNested,
  transpose,
  matmul,
  add,
  scale,
  maxAbsDiff,
  kron2,
  partialTranspose,
} from "../src/index.js";

describe("partial transpose involution", () => {
  test("PT_S(PT_S(M)) = M on a 4×4 real M", () => {
    const M = fromNested([
      [1, 2, 3, 4],
      [5, 6, 7, 8],
      [9, 0, 1, 2],
      [3, 4, 5, 6],
    ]);
    const pt = partialTranspose(M, [2, 2], 1);
    const back = partialTranspose(pt, [2, 2], 1);
    expect(maxAbsDiff(back, M)).toBe(0);
  });

  test("PT_∅ = id (no subsystems transposed)", () => {
    const M = fromNested([[1, 2], [3, 4]]);
    const out = partialTranspose(M, [2], []);
    expect(maxAbsDiff(out, M)).toBe(0);
  });
});

describe("partial transpose on the WHOLE system = transpose", () => {
  test("dims = [2, 2], transpose subsystems [0, 1]", () => {
    const M = fromNested([
      [1, 2, 3, 4],
      [5, 6, 7, 8],
      [9, 0, 1, 2],
      [3, 4, 5, 6],
    ]);
    const out = partialTranspose(M, [2, 2], [0, 1]);
    expect(maxAbsDiff(out, transpose(M))).toBe(0);
  });
});

describe("partial transpose factors through ⊗", () => {
  test("PT_1(A ⊗ B) = A ⊗ B^T", () => {
    const A = fromNested([[1, 2], [3, 4]]);
    const B = fromNested([[5, 6, 7], [8, 9, 0], [1, 2, 3]]);
    const lhs = partialTranspose(kron2(A, B), [2, 3], 1);
    const rhs = kron2(A, transpose(B));
    expect(maxAbsDiff(lhs, rhs)).toBe(0);
  });

  test("PT_0(A ⊗ B) = A^T ⊗ B", () => {
    const A = fromNested([[1, 2, 3], [4, 5, 6], [7, 8, 9]]);
    const B = fromNested([[1, 0], [0, -1]]);
    const lhs = partialTranspose(kron2(A, B), [3, 2], 0);
    const rhs = kron2(transpose(A), B);
    expect(maxAbsDiff(lhs, rhs)).toBe(0);
  });
});

describe("Bell-state PPT witness (matrix form)", () => {
  test("PT_1(|Φ+⟩⟨Φ+|) has the expected swap pattern", () => {
    // |Φ+⟩ = (|00⟩ + |11⟩)/√2; ρ has 0.5 at (0,0),(0,3),(3,0),(3,3).
    // After PT on subsystem 1 (right factor), the (i_A, j_A, i_B, j_B) =
    // (a, b, c, d) entry moves to (a, b, d, c). So (0,0,0,0)→(0,0,0,0);
    // (0,1,0,1)→(0,1,1,0)=(linear (1,2)); etc. The result has the
    // characteristic "swap" pattern with eigenvalue -1/2 for the swap
    // antisymmetric subspace.
    const rho = fromNested([
      [0.5, 0, 0, 0.5],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0.5, 0, 0, 0.5],
    ]);
    const pt = partialTranspose(rho, [2, 2], 1);
    // Expected: the SWAP/2 matrix.
    // (0.5 at (0,0); 0.5 at (3,3); 0.5 at (1,2); 0.5 at (2,1); rest 0.)
    const expected = fromNested([
      [0.5, 0, 0, 0],
      [0, 0, 0.5, 0],
      [0, 0.5, 0, 0],
      [0, 0, 0, 0.5],
    ]);
    expect(maxAbsDiff(pt, expected)).toBe(0);
  });

  test("Bell-state PT eigenvalues directly: (1/2)·SWAP has eigenvalues ±1/2", () => {
    // SWAP-on-C^2⊗C^2 has eigenvalues +1 (symmetric subspace, multiplicity
    // 3) and -1 (antisymmetric subspace, multiplicity 1). So 0.5·SWAP has
    // +0.5 (×3) and -0.5 (×1). The -0.5 eigenvalue is the canonical PPT
    // signature of entanglement: ρ_AB is NOT separable.
    //
    // We don't have eigh here, but we can verify the antisymmetric singlet
    // |Ψ-⟩ = (|01⟩ − |10⟩)/√2 is an eigenvector with eigenvalue -0.5.
    const rho = fromNested([
      [0.5, 0, 0, 0.5],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0.5, 0, 0, 0.5],
    ]);
    const pt = partialTranspose(rho, [2, 2], 1);
    // |Ψ-⟩ as a column vector embedded in a 4×1.
    const psiMinus = fromNested([[0], [Math.SQRT1_2], [-Math.SQRT1_2], [0]]);
    const out = matmul(pt, psiMinus);
    // out should equal -0.5 · psiMinus.
    const expected = scale(-0.5, psiMinus);
    expect(maxAbsDiff(out, expected)).toBeLessThan(1e-12);
  });
});

describe("complex partial transpose", () => {
  test("PT does NOT conjugate (im part transposes, no sign flip)", () => {
    // 1-subsystem case = full transpose; check on a non-Hermitian complex M.
    const M = fromNestedComplex([[1, 2], [3, 4]], [[5, 6], [7, 8]]);
    const pt = partialTranspose(M, [2], 0);
    // Expected: transpose without conjugation.
    const t = transpose(M);
    expect(maxAbsDiff(pt, t)).toBe(0);
  });
});
