// =============================================================================
// kron.ts — Kronecker product
// =============================================================================
//
// (A ⊗ B) is the (m_A · m_B) × (n_A · n_B) matrix with
//
//     (A ⊗ B)[i_A · m_B + i_B, j_A · n_B + j_B]  =  A[i_A, j_A] · B[i_B, j_B].
//
// Equivalently: think of (A ⊗ B) as the block matrix whose (i_A, j_A) block
// is A[i_A, j_A] · B. Row-major storage matches that block-by-block layout
// naturally (the inner index i_B walks the columns of a block, which are
// contiguous in row-major).
//
// Why a top-level branch on `isReal` not a per-element branch
// -----------------------------------------------------------
// The inner loop is `out[*] = a · b` (4 multiplications + 2 add/sub for the
// complex case, 1 multiplication for the real case). Putting the
// real/complex test in the inner loop costs an extra branch per element
// and defeats CPU prefetch on hot paths. We branch once at the entry to
// `kron2` and run two specialised inner loops.
//
// Variadic kron(A, B, C, …) = ((A ⊗ B) ⊗ C) ⊗ …  is left-associative; the
// associativity of ⊗ makes the bracketing physically irrelevant, but the
// allocation cost grows by the running cumulative size — same as iterating
// `args.reduce(kron2)`. Two-arg case is fast-path (no intermediate).

import { type Matrix, isReal, zeros, zerosComplex, MatrixError } from "./matrix.js";

/**
 * Kronecker product of two (real or complex) matrices.
 *
 * Real ⊗ real is real; any complex operand produces a complex result.
 * Treats `M.im === undefined` as zero imaginary; you do NOT need to
 * promote a real matrix to complex before passing it in.
 *
 * Allocates a fresh output; inputs are read-only.
 */
export function kron2(A: Matrix, B: Matrix): Matrix {
  const m = A.rows * B.rows;
  const n = A.cols * B.cols;
  const complex = !isReal(A) || !isReal(B);
  const out = complex ? zerosComplex(m, n) : zeros(m, n);
  const oRe = out.re;
  const oIm = out.im; // undefined iff `complex` is false

  const aRe = A.re;
  const aIm = A.im;
  const bRe = B.re;
  const bIm = B.im;
  const mA = A.rows;
  const nA = A.cols;
  const mB = B.rows;
  const nB = B.cols;

  if (!complex) {
    // Real × real: one multiplication per output element.
    for (let iA = 0; iA < mA; iA++) {
      for (let jA = 0; jA < nA; jA++) {
        const a = aRe[iA * nA + jA]!;
        if (a === 0) continue; // sparsity shortcut; benign even for non-sparse
        const rowBase = iA * mB;
        const colBase = jA * nB;
        for (let iB = 0; iB < mB; iB++) {
          const outRow = (rowBase + iB) * n;
          const inRow = iB * nB;
          for (let jB = 0; jB < nB; jB++) {
            oRe[outRow + colBase + jB] = a * bRe[inRow + jB]!;
          }
        }
      }
    }
    return out;
  }

  // Complex × complex (treating undefined im as zero per element):
  //   (a_re + i·a_im) · (b_re + i·b_im)
  //     = a_re·b_re − a_im·b_im  +  i·(a_re·b_im + a_im·b_re)
  for (let iA = 0; iA < mA; iA++) {
    for (let jA = 0; jA < nA; jA++) {
      const aR = aRe[iA * nA + jA]!;
      const aI = aIm ? aIm[iA * nA + jA]! : 0;
      const rowBase = iA * mB;
      const colBase = jA * nB;
      for (let iB = 0; iB < mB; iB++) {
        const outRow = (rowBase + iB) * n;
        const inRow = iB * nB;
        for (let jB = 0; jB < nB; jB++) {
          const bR = bRe[inRow + jB]!;
          const bI = bIm ? bIm[inRow + jB]! : 0;
          oRe[outRow + colBase + jB] = aR * bR - aI * bI;
          oIm![outRow + colBase + jB] = aR * bI + aI * bR;
        }
      }
    }
  }
  return out;
}

/**
 * Variadic Kronecker product: kron(A, B, C, …) = ((A ⊗ B) ⊗ C) ⊗ …
 *
 * Left-associative; `⊗` is associative so the bracketing is mathematically
 * equivalent, but allocation cost is dominated by the final product size
 * regardless. With one argument, returns a clone-ish (fresh allocation)
 * to preserve the no-aliasing discipline of the rest of the module.
 */
export function kron(...args: Matrix[]): Matrix {
  if (args.length === 0) {
    throw new MatrixError("kron: need at least one argument");
  }
  if (args.length === 1) {
    return kron2(args[0]!, { rows: 1, cols: 1, re: new Float64Array([1]) });
  }
  let acc = args[0]!;
  for (let i = 1; i < args.length; i++) acc = kron2(acc, args[i]!);
  return acc;
}
