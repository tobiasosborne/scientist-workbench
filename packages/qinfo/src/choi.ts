// =============================================================================
// choi.ts — vec / unvec / Choi–Jamiołkowski isomorphism
// =============================================================================
//
// Convention: column-stacking
// ---------------------------
// `vec(M)` stacks the columns of M into one tall vector. For an m × n
// matrix M:
//
//     vec(M)[i + m · j]  =  M[i, j]              (i ∈ [0,m), j ∈ [0,n))
//
// Useful identity:  vec(A · X · B^T) = (B ⊗ A) · vec(X).
//
// Column-stacking is the textbook default (Horn & Johnson, Watrous's
// "Theory of Quantum Information"; QuTiP and SymPy also default here).
// The alternative — row-stacking — has its merits but mixing conventions
// is the single biggest source of off-by-permutation bugs in this corner
// of the literature, so we pick one and lock it.
//
// Choi–Jamiołkowski isomorphism
// -----------------------------
// A linear map Φ : M_{d_in} → M_{d_out} (i.e. a "superoperator" on density
// matrices) is in 1-1 correspondence with a (d_in · d_out) × (d_in · d_out)
// matrix
//
//     J(Φ) := Σ_{i,j} |i⟩⟨j|_in ⊗ Φ(|i⟩⟨j|)_out
//
// (the right factor is the "output" subsystem; the left factor is the
// "input" subsystem — this is again a convention, and we lock it in.)
//
// When Φ is given as a superoperator matrix S in column-stacking form
// (vec(Φ(ρ)) = S · vec(ρ), with S being d_out² × d_in²), the index map
// from S to J is
//
//     J[i_in · d_out + i_out, j_in · d_out + j_out]
//         =  S[i_out + d_out · j_out, i_in + d_in · j_in].
//
// Properties used in the test suite:
//   - J(id) = |Ω⟩⟨Ω| where |Ω⟩ = Σ_i |i⟩|i⟩  (unnormalised max-entangled).
//   - J is linear in Φ.
//   - Tr_2(J(Φ)) = I_{d_in}  iff  Φ is trace-preserving.
//   - J(Φ) ⪰ 0  iff  Φ is completely-positive.
//   - choi(deChoi(J)) = J (round-trip).

import {
  type Matrix,
  isReal,
  zeros,
  zerosComplex,
  MatrixError,
} from "./matrix.js";

/**
 * Column-stacking vectorisation. `vec(M)[i + m·j] = M[i, j]`.
 *
 * Returns the real part (and optional imaginary part) as separate
 * Float64Arrays of length rows·cols. The caller can re-wrap into a
 * Matrix of shape (rows·cols × 1) if desired — but `vec` is primarily
 * an indexing intermediate, used by Choi internally.
 */
export function vec(M: Matrix): { re: Float64Array; im?: Float64Array } {
  const m = M.rows;
  const n = M.cols;
  const re = new Float64Array(m * n);
  const im = M.im ? new Float64Array(m * n) : undefined;
  for (let i = 0; i < m; i++) {
    for (let j = 0; j < n; j++) {
      re[i + m * j] = M.re[i * n + j]!;
      if (im && M.im) im[i + m * j] = M.im[i * n + j]!;
    }
  }
  return im ? { re, im } : { re };
}

/**
 * Inverse of `vec`. Given a length-rows·cols vector, build the rows × cols
 * matrix whose column-stacking is the input.
 */
export function unvec(
  v: { re: Float64Array; im?: Float64Array },
  rows: number,
  cols: number,
): Matrix {
  if (v.re.length !== rows * cols) {
    throw new MatrixError(
      `unvec: re length ${v.re.length} != rows·cols = ${rows * cols}`,
    );
  }
  if (v.im && v.im.length !== rows * cols) {
    throw new MatrixError(
      `unvec: im length ${v.im.length} != rows·cols = ${rows * cols}`,
    );
  }
  const out = v.im ? zerosComplex(rows, cols) : zeros(rows, cols);
  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < cols; j++) {
      out.re[i * cols + j] = v.re[i + rows * j]!;
      if (out.im && v.im) out.im[i * cols + j] = v.im[i + rows * j]!;
    }
  }
  return out;
}

/**
 * Choi matrix from a superoperator-matrix representation of a channel.
 *
 * `S` is the (d_out² × d_in²) matrix satisfying vec(Φ(ρ)) = S · vec(ρ).
 * Returns J(Φ), a (d_in · d_out) × (d_in · d_out) matrix.
 *
 * Throws if S's shape doesn't match (d_out², d_in²).
 */
export function choi(S: Matrix, dim_in: number, dim_out: number): Matrix {
  if (!Number.isInteger(dim_in) || dim_in <= 0) {
    throw new MatrixError(`choi: dim_in must be a positive integer, got ${dim_in}`);
  }
  if (!Number.isInteger(dim_out) || dim_out <= 0) {
    throw new MatrixError(`choi: dim_out must be a positive integer, got ${dim_out}`);
  }
  const dInSq = dim_in * dim_in;
  const dOutSq = dim_out * dim_out;
  if (S.rows !== dOutSq || S.cols !== dInSq) {
    throw new MatrixError(
      `choi: S shape must be (d_out², d_in²) = (${dOutSq}, ${dInSq}), got (${S.rows}, ${S.cols})`,
    );
  }
  const dJ = dim_in * dim_out;
  const out = isReal(S) ? zeros(dJ, dJ) : zerosComplex(dJ, dJ);
  // J[i_in · d_out + i_out, j_in · d_out + j_out]
  //     = S[i_out + d_out · j_out, i_in + d_in · j_in]
  for (let i_in = 0; i_in < dim_in; i_in++) {
    for (let i_out = 0; i_out < dim_out; i_out++) {
      const jRow = i_in * dim_out + i_out;
      for (let j_in = 0; j_in < dim_in; j_in++) {
        for (let j_out = 0; j_out < dim_out; j_out++) {
          const jCol = j_in * dim_out + j_out;
          const sRow = i_out + dim_out * j_out;
          const sCol = i_in + dim_in * j_in;
          out.re[jRow * dJ + jCol] = S.re[sRow * dInSq + sCol]!;
          if (out.im && S.im) out.im[jRow * dJ + jCol] = S.im[sRow * dInSq + sCol]!;
        }
      }
    }
  }
  return out;
}

/**
 * Inverse of `choi`: from Choi matrix J back to superoperator matrix S
 * (column-stacking convention).
 */
export function deChoi(J: Matrix, dim_in: number, dim_out: number): Matrix {
  if (!Number.isInteger(dim_in) || dim_in <= 0) {
    throw new MatrixError(`deChoi: dim_in must be a positive integer, got ${dim_in}`);
  }
  if (!Number.isInteger(dim_out) || dim_out <= 0) {
    throw new MatrixError(`deChoi: dim_out must be a positive integer, got ${dim_out}`);
  }
  const dJ = dim_in * dim_out;
  if (J.rows !== dJ || J.cols !== dJ) {
    throw new MatrixError(
      `deChoi: J shape must be (d_in·d_out, d_in·d_out) = (${dJ}, ${dJ}), got (${J.rows}, ${J.cols})`,
    );
  }
  const dInSq = dim_in * dim_in;
  const dOutSq = dim_out * dim_out;
  const out = isReal(J) ? zeros(dOutSq, dInSq) : zerosComplex(dOutSq, dInSq);
  // Invert the map: S[i_out + d_out·j_out, i_in + d_in·j_in]
  //                  = J[i_in · d_out + i_out, j_in · d_out + j_out].
  for (let i_in = 0; i_in < dim_in; i_in++) {
    for (let i_out = 0; i_out < dim_out; i_out++) {
      const jRow = i_in * dim_out + i_out;
      for (let j_in = 0; j_in < dim_in; j_in++) {
        for (let j_out = 0; j_out < dim_out; j_out++) {
          const jCol = j_in * dim_out + j_out;
          const sRow = i_out + dim_out * j_out;
          const sCol = i_in + dim_in * j_in;
          out.re[sRow * dInSq + sCol] = J.re[jRow * dJ + jCol]!;
          if (out.im && J.im) out.im[sRow * dInSq + sCol] = J.im[jRow * dJ + jCol]!;
        }
      }
    }
  }
  return out;
}
