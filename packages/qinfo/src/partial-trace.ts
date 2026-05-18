// =============================================================================
// partial-trace.ts — trace out subsystems of a tensor-product operator
// =============================================================================
//
// Partial trace, conceptually
// ---------------------------
// Given an operator M on H = H_0 ⊗ H_1 ⊗ ⋯ ⊗ H_{n−1} and a subsystem k,
// the partial trace over k is the unique linear map
//
//     (Tr_k M) : H_{\k} → H_{\k}
//
// (where H_{\k} = ⊗_{j ≠ k} H_j) satisfying Tr_k(A ⊗ B ⊗ ⋯) = tr(A_k)·(rest).
// Concretely, in indices:
//
//     (Tr_k M)[I_kept, J_kept]  =  Σ_{t=0}^{d_k − 1}  M[I, J]
//
// where I = the linear index with subsystem k set to t and other components
// taken from I_kept (similarly J).
//
// Why this implementation choice
// ------------------------------
// Three algorithmic options (worklog 098 lays them out):
//
//   (a) Reshape-and-sum.  Iterate (I_kept, J_kept); sum t ∈ [0, d_k). O(d²)
//       with a 1/d_k factor relative to the trivial bound. The default v0.1
//       choice; cache-friendly because the t-step walks a stride-d_low slice
//       which packs sequentially when the traced subsystem is rightmost.
//
//   (b) Schmidt / SVD on pure states.  If M = |ψ⟩⟨ψ|, then Tr_k(M) for the
//       bipartition (k vs rest) is MM† where M is |ψ⟩ reshaped (d_kept ×
//       d_traced). O(d · rank). Implemented as `partialTracePure` for the
//       single-bipartition case.
//
//   (c) Structured fast paths (Hastings-style).  Diagonal / low-rank /
//       Pauli-string operators admit subquadratic-in-d partial trace via
//       their structure. Out of scope for v0.1 — the type infrastructure
//       isn't here yet.
//
// (a) ships; (b) ships for the pure-state case; (c) is a future bead.
//
// Multi-subsystem trace
// ---------------------
// `partialTrace(M, dims, [k_0, k_1, …])` is implemented as a sequence of
// single-subsystem traces from highest index to lowest. The order matters
// only for the running dims array — tracing high-to-low means the remaining
// subsystem indices in [0, …) don't shift between steps. The TS-expert call
// site is `partialTrace(rho, [2,2,2,2], [1, 3])` to keep qubits 0 and 2 of
// a 4-qubit ρ; the multi-axis sum is a fold of single traces.
//
// A future optimisation could fuse the loops (one reshape with multi-axis
// sum), which improves constant factors for d > 10³ but doesn't change the
// asymptotic. The API stays stable; only the implementation swaps in.

import {
  type Matrix,
  isReal,
  zeros,
  zerosComplex,
  MatrixError,
} from "./matrix.js";
import { dimProduct, normaliseSubsystems, type Dims } from "./dims.js";

/**
 * Trace out one or more subsystems of an operator M on H = ⊗_k H_{d_k}.
 *
 * `M` is the rows × cols matrix (rows = cols = ∏_k dims[k]).
 * `traceOut` is the index (or indices) of the subsystems to trace out.
 *
 * Returns a fresh matrix on the reduced Hilbert space, of dim d_kept ×
 * d_kept where d_kept = ∏_{k ∈ kept} dims[k]. Real input ⇒ real output;
 * any complex input ⇒ complex output.
 *
 * Throws if M is not square, dims don't multiply to M's dim, or subsystem
 * indices are out of range.
 */
export function partialTrace(
  M: Matrix,
  dims: Dims,
  traceOut: number | readonly number[],
): Matrix {
  const d = dimProduct(dims);
  if (M.rows !== d || M.cols !== d) {
    throw new MatrixError(
      `partialTrace: expected ${d}×${d} (dims product), got ${M.rows}×${M.cols}`,
    );
  }
  const subs = normaliseSubsystems(traceOut, dims.length);
  if (subs.length === dims.length) {
    // Tracing every subsystem = full trace; return a 1×1 matrix with tr(M).
    let sumRe = 0;
    let sumIm = 0;
    for (let i = 0; i < d; i++) {
      sumRe += M.re[i * d + i]!;
      if (M.im) sumIm += M.im[i * d + i]!;
    }
    const out = M.im ? zerosComplex(1, 1) : zeros(1, 1);
    out.re[0] = sumRe;
    if (out.im) out.im[0] = sumIm;
    return out;
  }
  // Trace high-to-low so remaining indices don't shift.
  let current = M;
  const currentDims = dims.slice();
  for (let i = subs.length - 1; i >= 0; i--) {
    current = partialTraceOne(current, currentDims, subs[i]!);
    currentDims.splice(subs[i]!, 1);
  }
  return current;
}

/** Trace out a single subsystem at position k. Internal building block. */
function partialTraceOne(M: Matrix, dims: number[], k: number): Matrix {
  const d_k = dims[k]!;
  // d_low = product of dims to the right of k.
  let d_low = 1;
  for (let j = k + 1; j < dims.length; j++) d_low *= dims[j]!;
  const d = M.rows;
  const d_reduced = d / d_k;
  const block = d_k * d_low;

  const out = isReal(M) ? zeros(d_reduced, d_reduced) : zerosComplex(d_reduced, d_reduced);
  const Mre = M.re;
  const Mim = M.im;
  const oRe = out.re;
  const oIm = out.im;

  for (let r = 0; r < d_reduced; r++) {
    const r_high = Math.floor(r / d_low);
    const r_low = r - r_high * d_low;
    const r_base = r_high * block + r_low;
    for (let c = 0; c < d_reduced; c++) {
      const c_high = Math.floor(c / d_low);
      const c_low = c - c_high * d_low;
      const c_base = c_high * block + c_low;
      let sumRe = 0;
      let sumIm = 0;
      for (let t = 0; t < d_k; t++) {
        const R = r_base + t * d_low;
        const C = c_base + t * d_low;
        const lin = R * d + C;
        sumRe += Mre[lin]!;
        if (Mim) sumIm += Mim[lin]!;
      }
      oRe[r * d_reduced + c] = sumRe;
      if (oIm) oIm[r * d_reduced + c] = sumIm;
    }
  }
  return out;
}

/**
 * Pure-state special case: partial trace of |ψ⟩⟨ψ| via Schmidt reshape.
 *
 * Input is a state vector `psi` (length d, real or complex) on a Hilbert
 * space partitioned by `dims`. `traceOut` lists which subsystems are
 * traced. The reduced density matrix is ρ_kept = M_ψ M_ψ† where M_ψ is
 * the rearranged matrix view of |ψ⟩ with rows indexed by kept subsystems
 * and columns by traced subsystems.
 *
 * Cost: O(d · rank) where rank ≤ min(d_kept, d_traced). For d_traced ≪
 * d_kept this is the difference between feasible and not on large pure
 * states (a 20-qubit pure state has d = 2²⁰ ≈ 10⁶; partialTracePure on
 * the half-bipartition is O(10⁶ · 2¹⁰) ≈ 10⁹ ops, versus the O(d²) ≈ 10¹²
 * cost of the general partialTrace on |ψ⟩⟨ψ|).
 *
 * `psi` is real iff `psiIm === undefined`. Returns a real matrix iff
 * psi is real (because MM^T is real-symmetric).
 */
export function partialTracePure(
  psi: Float64Array,
  psiIm: Float64Array | undefined,
  dims: Dims,
  traceOut: number | readonly number[],
): Matrix {
  const d = dimProduct(dims);
  if (psi.length !== d) {
    throw new MatrixError(
      `partialTracePure: psi length ${psi.length} != ∏dims = ${d}`,
    );
  }
  if (psiIm !== undefined && psiIm.length !== d) {
    throw new MatrixError(
      `partialTracePure: psiIm length ${psiIm.length} != ∏dims = ${d}`,
    );
  }
  const traced = normaliseSubsystems(traceOut, dims.length);
  if (traced.length === 0) {
    throw new MatrixError(
      "partialTracePure: must trace out at least one subsystem (use outerProduct for the identity case)",
    );
  }
  if (traced.length === dims.length) {
    // Tracing everything: ρ = trace = ⟨ψ|ψ⟩ in a 1×1.
    let s = 0;
    for (let i = 0; i < d; i++) {
      const r = psi[i]!;
      const im = psiIm ? psiIm[i]! : 0;
      s += r * r + im * im;
    }
    const out = psiIm ? zerosComplex(1, 1) : zeros(1, 1);
    out.re[0] = s;
    return out;
  }

  // Build M_ψ: rows indexed by kept subsystems (d_kept), cols by traced (d_traced).
  // For each linear i ∈ [0, d), decompose into kept/traced parts and write
  // M_ψ[i_kept, i_traced] = psi[i].
  const tracedSet = new Set(traced);
  const keptIdx: number[] = [];
  for (let k = 0; k < dims.length; k++) if (!tracedSet.has(k)) keptIdx.push(k);
  const d_kept = keptIdx.reduce((a, k) => a * dims[k]!, 1);
  const d_traced = traced.reduce((a, k) => a * dims[k]!, 1);

  // Precompute full strides.
  const fullStrides = new Array<number>(dims.length);
  fullStrides[dims.length - 1] = 1;
  for (let k = dims.length - 2; k >= 0; k--) {
    fullStrides[k] = fullStrides[k + 1]! * dims[k + 1]!;
  }
  // For each kept (multi)index and traced (multi)index, the full linear
  // index is Σ kept_parts[j] · stride[kept[j]] + Σ traced_parts[i] · stride[traced[i]].
  // We iterate full linearly and split.

  const Mre = new Float64Array(d_kept * d_traced);
  const Mim = psiIm ? new Float64Array(d_kept * d_traced) : undefined;

  for (let i = 0; i < d; i++) {
    // Decompose i into per-subsystem parts.
    let rem = i;
    let iKept = 0;
    let iTraced = 0;
    let keptStrideRunning = 1;
    let tracedStrideRunning = 1;
    // We must split into kept-part and traced-part using each subsystem's
    // index and the reduced strides on the kept/traced subsystem lists.
    // Easiest: re-decompose into parts then re-compose into kept/traced
    // linear indices. The arity is small (n ≤ ~20), so the array ops are cheap.
    const parts = new Array<number>(dims.length);
    for (let k = 0; k < dims.length; k++) {
      parts[k] = Math.floor(rem / fullStrides[k]!) % dims[k]!;
    }
    keptStrideRunning = 1;
    for (let j = keptIdx.length - 1; j >= 0; j--) {
      iKept += parts[keptIdx[j]!]! * keptStrideRunning;
      keptStrideRunning *= dims[keptIdx[j]!]!;
    }
    tracedStrideRunning = 1;
    for (let j = traced.length - 1; j >= 0; j--) {
      iTraced += parts[traced[j]!]! * tracedStrideRunning;
      tracedStrideRunning *= dims[traced[j]!]!;
    }
    Mre[iKept * d_traced + iTraced] = psi[i]!;
    if (Mim) Mim[iKept * d_traced + iTraced] = psiIm![i]!;
  }

  // ρ_kept = M M†. M is (d_kept × d_traced); ρ_kept is (d_kept × d_kept).
  // For real M: (MM^T)[a, b] = Σ_c M[a,c] · M[b,c].
  // For complex M: (MM†)[a, b] = Σ_c M[a,c] · conj(M[b,c]).
  const rhoIsComplex = Mim !== undefined;
  const rho = rhoIsComplex ? zerosComplex(d_kept, d_kept) : zeros(d_kept, d_kept);
  for (let a = 0; a < d_kept; a++) {
    for (let b = 0; b < d_kept; b++) {
      let sumRe = 0;
      let sumIm = 0;
      for (let c = 0; c < d_traced; c++) {
        const mar = Mre[a * d_traced + c]!;
        const mai = Mim ? Mim[a * d_traced + c]! : 0;
        const mbr = Mre[b * d_traced + c]!;
        const mbi = Mim ? Mim[b * d_traced + c]! : 0;
        // M[a,c] · conj(M[b,c]) = (mar + i mai)(mbr − i mbi)
        //   = mar·mbr + mai·mbi + i(mai·mbr − mar·mbi)
        sumRe += mar * mbr + mai * mbi;
        if (Mim) sumIm += mai * mbr - mar * mbi;
      }
      rho.re[a * d_kept + b] = sumRe;
      if (rho.im) rho.im[a * d_kept + b] = sumIm;
    }
  }
  return rho;
}
