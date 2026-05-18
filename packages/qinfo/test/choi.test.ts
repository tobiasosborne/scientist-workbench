// vec / unvec / choi / deChoi — invariants (Rule 7). Decisive cases:
//   * unvec(vec(M)) = M (round-trip).
//   * vec(A·X·B^T) = (B ⊗ A) · vec(X) — the famous identity that ties
//     column-stacking to the Kronecker product.
//   * J(identity channel) = |Ω⟩⟨Ω| = Σ_{i,j} |ii⟩⟨jj|.
//   * choi(deChoi(J)) = J (and vice versa).
//   * J is linear in the channel (additive + homogeneous).

import { describe, expect, test } from "bun:test";
import {
  fromNested,
  fromNestedComplex,
  toNested,
  zeros,
  eye,
  add,
  scale,
  matmul,
  maxAbsDiff,
  transpose,
  kron2,
  vec,
  unvec,
  choi,
  deChoi,
} from "../src/index.js";

describe("vec / unvec round-trip", () => {
  test("unvec(vec(M)) = M for real 3×2", () => {
    const M = fromNested([[1, 2], [3, 4], [5, 6]]);
    const v = vec(M);
    expect(v.re.length).toBe(6);
    const back = unvec(v, 3, 2);
    expect(maxAbsDiff(back, M)).toBe(0);
  });

  test("unvec(vec(M)) = M for complex 2×2", () => {
    const M = fromNestedComplex([[1, 2], [3, 4]], [[5, 6], [7, 8]]);
    const v = vec(M);
    const back = unvec(v, 2, 2);
    expect(maxAbsDiff(back, M)).toBe(0);
  });

  test("column-stacking convention: vec(M)[i + m·j] = M[i,j]", () => {
    const M = fromNested([[10, 20, 30], [40, 50, 60]]); // 2×3
    const v = vec(M);
    // m=2: vec(M) = [M[0,0], M[1,0], M[0,1], M[1,1], M[0,2], M[1,2]]
    //              = [10, 40, 20, 50, 30, 60].
    expect(Array.from(v.re)).toEqual([10, 40, 20, 50, 30, 60]);
  });
});

describe("vec identity: vec(A·X·B^T) = (B ⊗ A) · vec(X)", () => {
  test("real 2×2 case", () => {
    const A = fromNested([[1, 2], [3, 4]]);
    const B = fromNested([[5, 6], [7, 8]]);
    const X = fromNested([[9, 0], [1, 2]]);
    // LHS: A·X·B^T, then vec.
    const lhs = vec(matmul(matmul(A, X), transpose(B)));
    // RHS: (B ⊗ A) · vec(X).
    const vecX = vec(X);
    const vecXmat = unvec(vecX, 4, 1);
    const BkronA = kron2(B, A);
    const rhsMat = matmul(BkronA, vecXmat);
    expect(rhsMat.rows).toBe(4);
    expect(rhsMat.cols).toBe(1);
    // Compare flat.
    for (let i = 0; i < 4; i++) {
      expect(lhs.re[i]!).toBeCloseTo(rhsMat.re[i]!, 10);
    }
  });
});

describe("Choi: J(id) = |Ω⟩⟨Ω|", () => {
  test("identity channel on a qubit (d_in = d_out = 2)", () => {
    // The superoperator-matrix of id is the d²×d² identity (S·vec(ρ) =
    // vec(ρ) for all ρ).
    const dIn = 2;
    const dOut = 2;
    const S = eye(dIn * dOut); // d_out² × d_in² = 4×4
    const J = choi(S, dIn, dOut);
    // |Ω⟩ = |00⟩ + |11⟩ (unnormalised). |Ω⟩⟨Ω| has 1 at (0,0),(0,3),(3,0),(3,3).
    const expected = fromNested([
      [1, 0, 0, 1],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [1, 0, 0, 1],
    ]);
    expect(maxAbsDiff(J, expected)).toBe(0);
  });

  test("identity channel on a qutrit", () => {
    const dIn = 3;
    const dOut = 3;
    const S = eye(dIn * dOut); // 9×9
    const J = choi(S, dIn, dOut);
    // |Ω⟩ = |00⟩+|11⟩+|22⟩ (length 9). |Ω⟩⟨Ω| has 1 at indices (3i+i, 3j+j).
    // Linear position of |ii⟩ in 9-dim: i*3+i = 4i ∈ {0, 4, 8}.
    const expected = zeros(9, 9);
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        expected.re[(4 * i) * 9 + 4 * j] = 1;
      }
    }
    expect(maxAbsDiff(J, expected)).toBe(0);
  });
});

describe("Choi round-trip", () => {
  test("choi(deChoi(J)) = J for a generic real J", () => {
    // 4×4 invertible-ish J (the values don't have to encode a CP map for
    // the round-trip to hold — choi/deChoi are bijections of matrix space).
    const J = fromNested([
      [1, 2, 3, 4],
      [5, 6, 7, 8],
      [9, 0, 1, 2],
      [3, 4, 5, 6],
    ]);
    const S = deChoi(J, 2, 2);
    const Jback = choi(S, 2, 2);
    expect(maxAbsDiff(Jback, J)).toBe(0);
  });

  test("deChoi(choi(S)) = S for a generic real S", () => {
    const S = fromNested([
      [1, 2, 3, 4],
      [5, 6, 7, 8],
      [9, 0, 1, 2],
      [3, 4, 5, 6],
    ]);
    const J = choi(S, 2, 2);
    const Sback = deChoi(J, 2, 2);
    expect(maxAbsDiff(Sback, S)).toBe(0);
  });

  test("round-trip works for rectangular channel (d_in ≠ d_out)", () => {
    // d_in = 3, d_out = 2. S is 4 × 9; J is 6 × 6.
    const S = fromNested([
      [1, 2, 3, 4, 5, 6, 7, 8, 9],
      [9, 8, 7, 6, 5, 4, 3, 2, 1],
      [0, 1, 2, 3, 4, 5, 6, 7, 8],
      [8, 7, 6, 5, 4, 3, 2, 1, 0],
    ]);
    const J = choi(S, 3, 2);
    expect(J.rows).toBe(6);
    expect(J.cols).toBe(6);
    const Sback = deChoi(J, 3, 2);
    expect(maxAbsDiff(Sback, S)).toBe(0);
  });
});

describe("Choi linearity in the channel", () => {
  test("J(α·S_1 + β·S_2) = α·J(S_1) + β·J(S_2)", () => {
    const S1 = fromNested([[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]]);
    const S2 = fromNested([[2, 1, 0, 0], [1, 2, 0, 1], [0, 0, 2, 0], [0, 1, 0, 2]]);
    const J1 = choi(S1, 2, 2);
    const J2 = choi(S2, 2, 2);
    const Smix = add(scale(3, S1), scale(-1.5, S2));
    const Jmix = choi(Smix, 2, 2);
    const expected = add(scale(3, J1), scale(-1.5, J2));
    expect(maxAbsDiff(Jmix, expected)).toBeLessThan(1e-10);
  });
});

describe("complex Choi", () => {
  test("Choi of a complex channel round-trips", () => {
    const S = fromNestedComplex(
      [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]],
      [[0, 1, 0, 0], [-1, 0, 0, 0], [0, 0, 0, 1], [0, 0, -1, 0]],
    );
    const J = choi(S, 2, 2);
    const Sback = deChoi(J, 2, 2);
    expect(maxAbsDiff(Sback, S)).toBe(0);
  });
});
