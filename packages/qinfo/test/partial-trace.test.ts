// Partial trace — invariants (Rule 7). Decisive cases:
//
//   * Product state Tr_B(A⊗B) = tr(B)·A. This is the defining property — if
//     partialTrace is wrong even by index permutation it fails here.
//   * Trace preservation tr(Tr_k(M)) = tr(M).
//   * Bell state |Φ+⟩⟨Φ+| reduces to I/2 on either qubit (maximally
//     entangled state has maximally mixed reductions).
//   * Pure-state path agrees with the general path on ρ = |ψ⟩⟨ψ|.

import { describe, expect, test } from "bun:test";
import {
  eye,
  fromNested,
  fromNestedComplex,
  toNested,
  toNestedComplex,
  trace,
  scale,
  maxAbsDiff,
  kron2,
  partialTrace,
  partialTracePure,
} from "../src/index.js";

describe("partial trace shape", () => {
  test("Tr_k(M) on a [d_0, d_1, …]-dim system reduces by d_k", () => {
    // dims = [2, 3], total dim = 6. Trace out subsystem 1 (dim 3) → 2×2.
    const M = fromNested([
      [1, 0, 0, 0, 0, 0],
      [0, 2, 0, 0, 0, 0],
      [0, 0, 3, 0, 0, 0],
      [0, 0, 0, 4, 0, 0],
      [0, 0, 0, 0, 5, 0],
      [0, 0, 0, 0, 0, 6],
    ]);
    const red = partialTrace(M, [2, 3], 1);
    expect(red.rows).toBe(2);
    expect(red.cols).toBe(2);
  });
});

describe("partial trace product-state law: Tr_1(A⊗B) = tr(B)·A", () => {
  test("real 2 × 2 × 2 case", () => {
    const A = fromNested([[1, 2], [3, 4]]); // tr = 5
    const B = fromNested([[5, 6], [7, 8]]); // tr = 13
    const AB = kron2(A, B); // 4 × 4
    // Tr over subsystem 1 (right factor, dim 2 each) = tr(B) · A = 13·A.
    const red = partialTrace(AB, [2, 2], 1);
    const expected = scale(13, A);
    expect(maxAbsDiff(red, expected)).toBeLessThan(1e-10);
  });

  test("real 2 × 2 × 2 case, trace out LEFT factor", () => {
    const A = fromNested([[1, 2], [3, 4]]); // tr = 5
    const B = fromNested([[5, 6], [7, 8]]);
    const AB = kron2(A, B);
    // Tr over subsystem 0 (left factor) = tr(A) · B = 5·B.
    const red = partialTrace(AB, [2, 2], 0);
    const expected = scale(5, B);
    expect(maxAbsDiff(red, expected)).toBeLessThan(1e-10);
  });

  test("qutrit ⊗ qubit (dims = [3, 2]); trace out qubit", () => {
    const A = fromNested([[1, 0, 0], [0, 2, 0], [0, 0, 3]]); // tr = 6
    const B = fromNested([[5, 6], [7, 8]]); // tr = 13
    const AB = kron2(A, B);
    const red = partialTrace(AB, [3, 2], 1);
    expect(maxAbsDiff(red, scale(13, A))).toBeLessThan(1e-10);
  });

  test("3-system case, trace out middle subsystem", () => {
    // [d_0, d_1, d_2] = [2, 3, 2]. Trace out subsystem 1.
    // (A ⊗ B ⊗ C) → tr(B) · (A ⊗ C).
    const A = fromNested([[1, 0], [0, 2]]);
    const B = fromNested([[1, 0, 0], [0, 2, 0], [0, 0, 3]]);
    const C = fromNested([[1, 0], [0, -1]]);
    const ABC = kron2(kron2(A, B), C);
    const red = partialTrace(ABC, [2, 3, 2], 1);
    const expected = scale(trace(B).re, kron2(A, C));
    expect(maxAbsDiff(red, expected)).toBeLessThan(1e-10);
  });
});

describe("partial trace preserves total trace", () => {
  test("tr(Tr_k(M)) = tr(M) for random-looking M on [2, 3]", () => {
    const M = fromNested([
      [1, 2, 3, 4, 5, 6],
      [7, 8, 9, 0, 1, 2],
      [3, 4, 5, 6, 7, 8],
      [9, 0, 1, 2, 3, 4],
      [5, 6, 7, 8, 9, 0],
      [1, 2, 3, 4, 5, 6],
    ]);
    const totalTr = trace(M).re;
    expect(trace(partialTrace(M, [2, 3], 0)).re).toBeCloseTo(totalTr, 10);
    expect(trace(partialTrace(M, [2, 3], 1)).re).toBeCloseTo(totalTr, 10);
  });
});

describe("Bell state reduces to maximally mixed", () => {
  test("|Φ+⟩⟨Φ+| on 2 qubits → ρ_A = I/2", () => {
    // |Φ+⟩ = (|00⟩ + |11⟩)/√2; ρ = |Φ+⟩⟨Φ+| = 0.5 · (|00⟩⟨00| + |00⟩⟨11| +
    //   |11⟩⟨00| + |11⟩⟨11|). In 4×4 matrix form:
    //   [[0.5, 0, 0, 0.5], [0, 0, 0, 0], [0, 0, 0, 0], [0.5, 0, 0, 0.5]].
    const rho = fromNested([
      [0.5, 0, 0, 0.5],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0.5, 0, 0, 0.5],
    ]);
    const rhoA = partialTrace(rho, [2, 2], 1);
    const halfI = scale(0.5, eye(2));
    expect(maxAbsDiff(rhoA, halfI)).toBeLessThan(1e-12);
    // Tracing the other side also gives I/2.
    const rhoB = partialTrace(rho, [2, 2], 0);
    expect(maxAbsDiff(rhoB, halfI)).toBeLessThan(1e-12);
  });
});

describe("partial trace linearity", () => {
  test("Tr_k(αM + βN) = α·Tr_k(M) + β·Tr_k(N)", () => {
    const M = fromNested([[1, 2, 3, 4], [5, 6, 7, 8], [9, 0, 1, 2], [3, 4, 5, 6]]);
    const N = fromNested([[7, 8, 9, 0], [1, 2, 3, 4], [5, 6, 7, 8], [9, 0, 1, 2]]);
    const lhs = partialTrace(
      // 2.5·M + (-1.3)·N
      {
        rows: 4, cols: 4,
        re: M.re.map((x, i) => 2.5 * x + (-1.3) * N.re[i]!) as unknown as Float64Array,
      },
      [2, 2],
      0,
    );
    const rhs = {
      rows: 2, cols: 2,
      re: partialTrace(M, [2, 2], 0).re.map(
        (x, i) => 2.5 * x + (-1.3) * partialTrace(N, [2, 2], 0).re[i]!,
      ) as unknown as Float64Array,
    };
    expect(maxAbsDiff(lhs, rhs as never)).toBeLessThan(1e-10);
  });
});

describe("multi-subsystem trace", () => {
  test("trace out everything = total trace × 1×1 matrix", () => {
    const M = fromNested([[1, 2, 3, 4], [5, 6, 7, 8], [9, 0, 1, 2], [3, 4, 5, 6]]);
    const out = partialTrace(M, [2, 2], [0, 1]);
    expect(out.rows).toBe(1);
    expect(out.cols).toBe(1);
    expect(out.re[0]!).toBeCloseTo(trace(M).re, 12);
  });

  test("trace out 0 then 2 = trace out [0, 2] (commutativity)", () => {
    // 3-subsystem: [2, 2, 2]. Trace out 0 and 2; should leave subsystem 1.
    const A = fromNested([[1, 0], [0, 2]]);
    const B = fromNested([[3, 0], [0, 4]]);
    const C = fromNested([[5, 0], [0, 6]]);
    const M = kron2(kron2(A, B), C);
    const r1 = partialTrace(M, [2, 2, 2], [0, 2]);
    // Sequential: trace 2 first → leaves [2,2], then trace 0 → leaves [2].
    const seq = partialTrace(partialTrace(M, [2, 2, 2], 2), [2, 2], 0);
    expect(maxAbsDiff(r1, seq)).toBeLessThan(1e-12);
    // The result should equal tr(A)·tr(C)·B = 3·11·B = 33·B.
    const expected = scale(trace(A).re * trace(C).re, B);
    expect(maxAbsDiff(r1, expected)).toBeLessThan(1e-10);
  });
});

describe("complex partial trace", () => {
  test("Tr_1(A⊗B) on complex A, B gives tr(B)·A", () => {
    // A = (1+i) · I_2 ; B = diag(1+i, 2-i); tr(B) = 3.
    const A = fromNestedComplex([[1, 0], [0, 1]], [[1, 0], [0, 1]]);
    const B = fromNestedComplex([[1, 0], [0, 2]], [[1, 0], [0, -1]]);
    const AB = kron2(A, B);
    const red = partialTrace(AB, [2, 2], 1);
    // tr(B) = (1+i)+(2-i) = 3. Expected: 3·A = 3·(1+i)·I_2.
    const expected = scale(3, A);
    expect(maxAbsDiff(red, expected)).toBeLessThan(1e-10);
  });
});

describe("partialTracePure agrees with general path on |ψ⟩⟨ψ|", () => {
  test("Bell state via pure path → I/2", () => {
    // |Φ+⟩ = (|00⟩ + |11⟩)/√2 in C^4.
    const psi = new Float64Array([Math.SQRT1_2, 0, 0, Math.SQRT1_2]);
    const rhoA = partialTracePure(psi, undefined, [2, 2], 1);
    const halfI = scale(0.5, eye(2));
    expect(maxAbsDiff(rhoA, halfI)).toBeLessThan(1e-12);
  });

  test("complex pure state matches partialTrace on |ψ⟩⟨ψ|", () => {
    // |ψ⟩ = (|0⟩ + i|1⟩)/√2 on a single qubit, then tensored with |0⟩.
    // ρ = |ψ⟩⟨ψ| ⊗ |0⟩⟨0|. Tr_1 gives |ψ⟩⟨ψ|.
    const inv = 1 / Math.SQRT2;
    const psiRe = new Float64Array([inv, 0, 0, 0]);
    const psiIm = new Float64Array([0, 0, inv, 0]);
    const fast = partialTracePure(psiRe, psiIm, [2, 2], 1);
    // |ψ⟩⟨ψ| explicitly: (1/2)·[[1, -i], [i, 1]].
    const expected = fromNestedComplex(
      [[0.5, 0], [0, 0.5]],
      [[0, -0.5], [0.5, 0]],
    );
    expect(maxAbsDiff(fast, expected)).toBeLessThan(1e-12);
  });
});
