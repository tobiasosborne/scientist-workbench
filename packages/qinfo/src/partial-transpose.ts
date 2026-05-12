// =============================================================================
// partial-transpose.ts — transpose on selected subsystems
// =============================================================================
//
// Partial transpose, conceptually
// -------------------------------
// On a bipartite Hilbert space H_A ⊗ H_B, the partial transpose with
// respect to B is the linear map
//
//     (id_A ⊗ T_B)(|a⟩⟨a'| ⊗ |b⟩⟨b'|)  =  |a⟩⟨a'| ⊗ |b'⟩⟨b|
//
// extended linearly. In matrix indices: PT_B(M)[(a,b), (a',b')] =
// M[(a,b'), (a',b)] — the B-indices on the row and column slots are swapped.
//
// Generalised to n subsystems with `transposeOn` = a subset S ⊆ {0,…,n−1}:
//
//     PT_S(M)[I, J]  =  M[I_S↔J_S, J_S↔I_S]
//
// where I_S↔J_S means "for each s ∈ S, take I's s-th component from J and
// vice versa". When S = {0,…,n−1}, PT_S equals the full transpose. When
// S = ∅, PT_S is the identity.
//
// Why it matters
// --------------
// The Peres–Horodecki criterion: a bipartite state ρ_AB is separable
// (NOT entangled) ⇒ PT_B(ρ_AB) ⪰ 0. The contrapositive — PT producing
// negative eigenvalues — is the workhorse entanglement detector for low-
// dimensional systems (necessary AND sufficient on 2×2 and 2×3).
//
// Implementation
// --------------
// Pure index permutation. The element values are copied unchanged (no
// arithmetic) — partial transpose is the most algorithmically trivial of
// the qinfo ops and the most conceptually subtle. We precompute strides
// and walk (I, J) pairs linearly; for each, decompose-and-swap-and-compose
// in one pass.

import {
  type Matrix,
  isReal,
  zeros,
  zerosComplex,
  MatrixError,
} from "./matrix.js";
import { dimProduct, normaliseSubsystems, type Dims } from "./dims.js";

/**
 * Partial transpose of M with respect to the subsystems in `transposeOn`.
 *
 * `dims` lists subsystem dimensions; `transposeOn` is a single index or
 * a list of indices. The output is the same shape as M, with the elements
 * shuffled. Complex inputs produce complex output; the transpose does NOT
 * conjugate (use `adjoint` from matrix.ts for that).
 */
export function partialTranspose(
  M: Matrix,
  dims: Dims,
  transposeOn: number | readonly number[],
): Matrix {
  const d = dimProduct(dims);
  if (M.rows !== d || M.cols !== d) {
    throw new MatrixError(
      `partialTranspose: expected ${d}×${d} (dims product), got ${M.rows}×${M.cols}`,
    );
  }
  const subs = normaliseSubsystems(transposeOn, dims.length);
  const n = dims.length;
  if (subs.length === 0) {
    // Identity case; return a fresh copy to preserve no-aliasing discipline.
    const out = isReal(M) ? zeros(d, d) : zerosComplex(d, d);
    out.re.set(M.re);
    if (out.im && M.im) out.im.set(M.im);
    return out;
  }

  // Strides: stride[k] = ∏_{j > k} dims[j]. Used for decompose/recompose.
  const stride = new Array<number>(n);
  stride[n - 1] = 1;
  for (let k = n - 2; k >= 0; k--) stride[k] = stride[k + 1]! * dims[k + 1]!;

  const subsSet = new Set(subs);
  const out = isReal(M) ? zeros(d, d) : zerosComplex(d, d);
  const Mre = M.re;
  const Mim = M.im;
  const oRe = out.re;
  const oIm = out.im;

  for (let I = 0; I < d; I++) {
    for (let J = 0; J < d; J++) {
      // Build the source indices I_src, J_src by swapping subsystems in `subs`.
      // For k ∈ subs: I_src.k = J.k, J_src.k = I.k.
      // For k ∉ subs: I_src.k = I.k, J_src.k = J.k.
      let I_src = 0;
      let J_src = 0;
      for (let k = 0; k < n; k++) {
        const dk = dims[k]!;
        const sk = stride[k]!;
        const i_k = Math.floor(I / sk) % dk;
        const j_k = Math.floor(J / sk) % dk;
        if (subsSet.has(k)) {
          I_src += j_k * sk;
          J_src += i_k * sk;
        } else {
          I_src += i_k * sk;
          J_src += j_k * sk;
        }
      }
      const src = I_src * d + J_src;
      const dst = I * d + J;
      oRe[dst] = Mre[src]!;
      if (oIm && Mim) oIm[dst] = Mim[src]!;
    }
  }
  return out;
}
