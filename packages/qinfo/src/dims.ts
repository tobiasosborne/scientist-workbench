// =============================================================================
// dims.ts — subsystem-dimension arithmetic
// =============================================================================
//
// A qinfo operator on n subsystems lives on a Hilbert space of dimension
// d = d_0 · d_1 · ⋯ · d_{n−1}. Many index-only operations (partial trace,
// partial transpose, Choi) need to walk indices subsystem-by-subsystem.
// The helpers here factor that arithmetic in one place so the operations
// stay readable.
//
// Convention — endianness
// -----------------------
// Subsystem 0 is the LEFTMOST tensor factor. For dims = [d_0, d_1, d_2]
// the linear index i ∈ [0, d_0·d_1·d_2) decomposes as
//
//     i_0 = ⌊i / (d_1·d_2)⌋       (most-significant)
//     i_1 = ⌊i / d_2⌋ mod d_1
//     i_2 = i mod d_2             (least-significant)
//
// Equivalently i = i_0 · (d_1 · d_2) + i_1 · d_2 + i_2. This matches the
// dogfood prototype's `insertBit` (qubit 0 = leftmost) and the standard
// physics reading |ψ⟩ = |q_0⟩ ⊗ |q_1⟩ ⊗ …. Pick this once, never change.

export type Dims = readonly number[];

/** Product of subsystem dimensions = total Hilbert-space dimension. */
export function dimProduct(dims: Dims): number {
  let d = 1;
  for (const v of dims) {
    if (!Number.isInteger(v) || v <= 0) {
      throw new Error(`dimProduct: every dim must be a positive integer, got ${v}`);
    }
    d *= v;
  }
  return d;
}

/**
 * Strides for the row-major decomposition.
 *
 * `stride[k]` is the multiplier for subsystem-k's index when assembling the
 * total linear index — i.e. stride[k] = ∏_{j > k} dims[j]. The last
 * subsystem has stride 1.
 *
 * Used by partial trace / partial transpose: given a multi-index
 * (i_0, …, i_{n−1}), reconstruct the linear index as Σ_k i_k · stride[k].
 */
export function strides(dims: Dims): number[] {
  const n = dims.length;
  const s = new Array<number>(n);
  s[n - 1] = 1;
  for (let k = n - 2; k >= 0; k--) s[k] = s[k + 1]! * dims[k + 1]!;
  return s;
}

/**
 * Decompose a linear index into per-subsystem indices.
 * Inverse of `composeIndex`.
 */
export function decomposeIndex(idx: number, dims: Dims): number[] {
  const out = new Array<number>(dims.length);
  let rem = idx;
  for (let k = 0; k < dims.length; k++) {
    let denom = 1;
    for (let j = k + 1; j < dims.length; j++) denom *= dims[j]!;
    out[k] = Math.floor(rem / denom);
    rem = rem % denom;
  }
  return out;
}

/** Inverse of `decomposeIndex`. */
export function composeIndex(parts: readonly number[], dims: Dims): number {
  if (parts.length !== dims.length) {
    throw new Error(
      `composeIndex: arity mismatch — parts ${parts.length}, dims ${dims.length}`,
    );
  }
  let idx = 0;
  for (let k = 0; k < dims.length; k++) {
    if (parts[k]! < 0 || parts[k]! >= dims[k]!) {
      throw new Error(
        `composeIndex: subsystem ${k} index ${parts[k]} out of range [0, ${dims[k]})`,
      );
    }
    let stride = 1;
    for (let j = k + 1; j < dims.length; j++) stride *= dims[j]!;
    idx += parts[k]! * stride;
  }
  return idx;
}

/** Coerce a single number / list of numbers into a sorted unique number[]. */
export function normaliseSubsystems(spec: number | readonly number[], n: number): number[] {
  const arr = typeof spec === "number" ? [spec] : Array.from(spec);
  for (const k of arr) {
    if (!Number.isInteger(k) || k < 0 || k >= n) {
      throw new Error(`subsystem ${k} out of range [0, ${n})`);
    }
  }
  const sorted = [...new Set(arr)].sort((a, b) => a - b);
  if (sorted.length !== arr.length) {
    throw new Error(`subsystem list contains duplicates: ${JSON.stringify(arr)}`);
  }
  return sorted;
}
