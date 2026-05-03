// =============================================================================
// matrix.ts — the dense `Matrix` substrate for @workbench/linalg-core
// =============================================================================
//
// Intent
// ------
// A minimal, allocation-aware dense-matrix surface built on `Float64Array`.
// Everything else in this package — LU factorisation, triangular solves,
// the Hager condition estimator, the high-level `solve` — operates on
// `Matrix` and `Float64Array` values defined here. There is one storage
// convention (row-major) and one element type (IEEE-754 binary64); a TS
// expert reading the source can hold the entire mental model in their head.
//
// Why `Float64Array` and not `number[]`
// -------------------------------------
// `Float64Array` gives us:
//   * Fixed-size, contiguous, cache-friendly storage. The inner loop of LU
//     touches O(n²) elements per pivot step; on a `number[]` (V8 boxes
//     mixed-typed arrays) we'd pay an extra indirection per access.
//   * A natural FFI surface, *if* we ever bridge to OpenBLAS through
//     `bun:ffi`. BLAS expects packed `double*`; `Float64Array.buffer` is
//     exactly that. ADR-0014 explicitly defers FFI; the type choice keeps
//     the door open.
//   * Predictable bit-level semantics — no engine-internal "smi" /
//     "boxed-double" representation drift. The bit pattern we read is the
//     bit pattern that came out of the last write, full stop.
//
// Why row-major
// -------------
// LU's natural access pattern walks rows when eliminating below the
// pivot. The triangular solves walk a single row of the U factor (or a
// single column of L, but we store L's strict-lower triangle in the same
// LU packing — see lu.ts for the packing contract). Row-major makes both
// the elimination loop and the back-substitution loop sequential reads,
// which is the right access pattern for a CPU cache.
//
// Mutability discipline
// ---------------------
// `Matrix.data` is a typed array; it is mutable in the JS sense. Every
// function in this module that returns a `Matrix` returns a *fresh*
// `Float64Array` allocation — we never alias the caller's data. The
// in-place LU factorisation (`luInPlace`, lu.ts) is the one exception,
// and it documents that contract loudly.

/**
 * A dense matrix in row-major storage.
 *
 * Invariant: `data.length === rows * cols`. Constructors enforce this;
 * mutating `data.length` after construction is undefined behaviour and
 * not policed.
 *
 * Element `(i, j)` lives at `data[i * cols + j]`. Use the `get` / `set`
 * helpers in this file to keep call sites readable; the inner LU loop
 * inlines the index arithmetic for speed.
 */
export type Matrix = {
  readonly rows: number;
  readonly cols: number;
  readonly data: Float64Array;
};

/**
 * `MatrixError` is a JS-level programming error: bad dimensions, NaN /
 * Infinity smuggled in through a constructor, ragged input rows. These
 * are *substrate* errors, not contract errors — at the tool layer they
 * surface as `ToolError` with a helpful suggestion, but inside the
 * library they raise plain `Error`s so the substrate layer doesn't
 * depend on `@workbench/protocol`.
 */
export class MatrixError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MatrixError";
  }
}

/**
 * Construct a Matrix from a nested-array literal. The outer length is
 * `rows`; the (validated, uniform) inner length is `cols`. Empty input
 * (zero rows, or zero cols) is rejected — the LU factorisation requires
 * at least 1×1; a hypothetical "solve a 0×0 system" semantics is more
 * confusing than useful.
 *
 * Non-finite entries (NaN, ±Infinity) are *rejected here*. Pushing the
 * check up-front keeps every downstream function (LU, solve, norms) free
 * of NaN-poisoning surprises. The tool layer translates this into a
 * `ToolError` with a path into the input record.
 */
export function matrixFromRows(rows: readonly (readonly number[])[]): Matrix {
  if (rows.length === 0) {
    throw new MatrixError("matrixFromRows: empty matrix (zero rows)");
  }
  const r = rows.length;
  const c = rows[0]!.length;
  if (c === 0) {
    throw new MatrixError("matrixFromRows: empty matrix (zero columns)");
  }
  const data = new Float64Array(r * c);
  for (let i = 0; i < r; i++) {
    const row = rows[i]!;
    if (row.length !== c) {
      throw new MatrixError(
        `matrixFromRows: ragged input — row 0 has ${c} cols but row ${i} has ${row.length}`,
      );
    }
    for (let j = 0; j < c; j++) {
      const v = row[j]!;
      if (!Number.isFinite(v)) {
        throw new MatrixError(`matrixFromRows: non-finite entry at [${i},${j}] = ${v}`);
      }
      data[i * c + j] = v;
    }
  }
  return { rows: r, cols: c, data };
}

/** Inverse of `matrixFromRows`. Allocates fresh nested arrays. */
export function matrixToRows(m: Matrix): number[][] {
  const out: number[][] = new Array(m.rows);
  for (let i = 0; i < m.rows; i++) {
    const row = new Array<number>(m.cols);
    for (let j = 0; j < m.cols; j++) row[j] = m.data[i * m.cols + j]!;
    out[i] = row;
  }
  return out;
}

/** Allocate an `r × c` zero matrix. */
export function matZeros(r: number, c: number): Matrix {
  if (r <= 0 || c <= 0) {
    throw new MatrixError(`matZeros: dimensions must be ≥ 1 (got ${r}×${c})`);
  }
  return { rows: r, cols: c, data: new Float64Array(r * c) };
}

/** Allocate the `n × n` identity matrix. */
export function matIdentity(n: number): Matrix {
  if (n <= 0) throw new MatrixError(`matIdentity: n must be ≥ 1 (got ${n})`);
  const data = new Float64Array(n * n);
  for (let i = 0; i < n; i++) data[i * n + i] = 1;
  return { rows: n, cols: n, data };
}

/** Element accessor. Bounds-checked; for hot loops, inline the arithmetic. */
export function get(m: Matrix, i: number, j: number): number {
  if (i < 0 || i >= m.rows || j < 0 || j >= m.cols) {
    throw new MatrixError(`get: index [${i},${j}] out of bounds for ${m.rows}×${m.cols}`);
  }
  return m.data[i * m.cols + j]!;
}

/** Element mutator. Bounds-checked. Used for diagnostics, not hot loops. */
export function set(m: Matrix, i: number, j: number, v: number): void {
  if (i < 0 || i >= m.rows || j < 0 || j >= m.cols) {
    throw new MatrixError(`set: index [${i},${j}] out of bounds for ${m.rows}×${m.cols}`);
  }
  if (!Number.isFinite(v)) {
    throw new MatrixError(`set: non-finite value ${v} at [${i},${j}]`);
  }
  m.data[i * m.cols + j] = v;
}

/** Clone a matrix (independent storage). */
export function matClone(m: Matrix): Matrix {
  return { rows: m.rows, cols: m.cols, data: new Float64Array(m.data) };
}

// -----------------------------------------------------------------------------
// Vector / matrix-vector primitives
// -----------------------------------------------------------------------------
//
// We use raw `Float64Array` for vectors. There's no `Vector` wrapper —
// the dimension is the array's length, and the few functions that need
// to assert agreement do so explicitly. Wrapping every vector in a
// `{length, data}` record would be ceremony with no upside.

/**
 * Compute `A · x` (matrix-vector product). Allocates a fresh vector.
 *
 * No accumulator-precision games: the dot product is a straight
 * left-to-right sum in float64. For ill-conditioned A this introduces
 * rounding; the iterative-refinement step in `solve.ts` is what we use
 * to keep the residual honest, not a Kahan accumulator here. (Higham
 * §3.1: Kahan summation buys ~1 extra digit of accuracy in the residual,
 * which is dominated by the condition number for any problem where it
 * would matter. The simplicity wins.)
 */
export function matVec(A: Matrix, x: Float64Array): Float64Array {
  if (x.length !== A.cols) {
    throw new MatrixError(`matVec: dim mismatch — A is ${A.rows}×${A.cols}, x has length ${x.length}`);
  }
  const y = new Float64Array(A.rows);
  for (let i = 0; i < A.rows; i++) {
    let s = 0;
    const rowOff = i * A.cols;
    for (let j = 0; j < A.cols; j++) s += A.data[rowOff + j]! * x[j]!;
    y[i] = s;
  }
  return y;
}

/**
 * Euclidean (2-) norm of a vector: `√(Σ x_i²)`. Implemented with a
 * scaling pass to avoid overflow on large-magnitude inputs (the
 * standard "BLAS DNRM2" trick: divide by the max absolute value, then
 * sum the squares of the scaled values, then multiply back).
 *
 * For inputs whose entries fit comfortably in float64, this gives the
 * correct rounded answer; for inputs with entries near the float64
 * overflow threshold (~1e308), the scaling keeps the computation
 * representable.
 */
export function vecNorm2(v: Float64Array): number {
  let m = 0;
  for (let i = 0; i < v.length; i++) {
    const a = Math.abs(v[i]!);
    if (a > m) m = a;
  }
  if (m === 0) return 0;
  let s = 0;
  for (let i = 0; i < v.length; i++) {
    const r = v[i]! / m;
    s += r * r;
  }
  return m * Math.sqrt(s);
}

/** Infinity norm: max |x_i|. */
export function vecNormInf(v: Float64Array): number {
  let m = 0;
  for (let i = 0; i < v.length; i++) {
    const a = Math.abs(v[i]!);
    if (a > m) m = a;
  }
  return m;
}

/**
 * 1-norm of a matrix: max over columns of the sum of absolute entries
 * in that column. (Note: NOT the same as the induced 2-norm; that
 * would require an SVD. The 1-norm is what Hager's condition estimator
 * needs, and that's the one this package computes.)
 */
export function matNorm1(A: Matrix): number {
  let m = 0;
  for (let j = 0; j < A.cols; j++) {
    let s = 0;
    for (let i = 0; i < A.rows; i++) s += Math.abs(A.data[i * A.cols + j]!);
    if (s > m) m = s;
  }
  return m;
}
