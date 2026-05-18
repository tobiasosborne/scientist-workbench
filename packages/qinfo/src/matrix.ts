// =============================================================================
// matrix.ts — the dense Matrix substrate for @workbench/qinfo
// =============================================================================
//
// Intent
// ------
// One Matrix type covers both real and complex. The real case is a plain
// row-major `Float64Array` in `re`; the complex case adds a sibling `im` of
// the same length. Functions branch on `M.im === undefined` exactly once;
// the rest of the work is on `Float64Array`s, where V8/JSC give us fixed-size
// contiguous storage with cache-friendly access patterns.
//
// The discriminated-union alternative (a `RealMatrix | ComplexMatrix` pair)
// would force every public function to either accept both via overloads or
// be split into two siblings. The TS expert reaches for `kron(A, B)` and
// expects it to Just Work whether A and B are real, complex, or mixed —
// so the single-Matrix-with-optional-im shape is what the API surface wants.
// Conventional terms: `re` is the real part (always present); `im` is the
// imaginary part (present iff the matrix is complex). A "real" Matrix is
// just one where `im === undefined`.
//
// Why row-major
// -------------
// kron + partialTrace + partialTranspose all access elements with patterns
// of the shape `out[outer · stride + inner] = M[outerM · strideM + innerM]`.
// Row-major makes those access patterns sequential at the innermost loop,
// which is the right behaviour for a CPU cache. We match linalg-core's
// convention here; qinfo doesn't *depend* on linalg-core (no need — the
// index-only ops do their own thing), but staying compatible means values
// can pass between the two packages by reinterpreting `{rows, cols, data}`
// ↔ `{rows, cols, re}` when the caller wants to route a real result into
// linalg-eigh.
//
// Mutability discipline
// ---------------------
// Every function in this package that returns a Matrix returns *fresh*
// Float64Array allocations — we never alias the caller's `re` or `im`.
// Callers can mutate their inputs after the call returns without affecting
// the output. This is the same discipline as linalg-core (matrix.ts) and
// makes the substrate composable: the output of one function can be the
// input to another without surprise interference.

/**
 * A dense rows × cols matrix, real or complex.
 *
 * Invariants:
 *   - `re.length === rows * cols`.
 *   - If `im !== undefined`, then `im.length === rows * cols` too.
 *   - Element `(i, j)` lives at index `i * cols + j` (row-major).
 *
 * "Real" iff `im === undefined`. Helper `isReal(M)` makes this explicit at
 * call sites; do not test `M.im === undefined` ad-hoc — it works but reads
 * worse than the helper, and the helper is what a future TS-expert reader
 * will grep for.
 */
export interface Matrix {
  readonly rows: number;
  readonly cols: number;
  readonly re: Float64Array;
  readonly im?: Float64Array;
}

export class MatrixError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MatrixError";
  }
}

// ─── Constructors ──────────────────────────────────────────────────────

/** Real rows × cols matrix backed by a freshly-allocated Float64Array. */
export function zeros(rows: number, cols: number): Matrix {
  checkDim(rows, "rows");
  checkDim(cols, "cols");
  return { rows, cols, re: new Float64Array(rows * cols) };
}

/** Complex rows × cols matrix backed by two freshly-allocated Float64Arrays. */
export function zerosComplex(rows: number, cols: number): Matrix {
  checkDim(rows, "rows");
  checkDim(cols, "cols");
  return {
    rows,
    cols,
    re: new Float64Array(rows * cols),
    im: new Float64Array(rows * cols),
  };
}

/** Real identity I_n. */
export function eye(n: number): Matrix {
  const M = zeros(n, n);
  for (let i = 0; i < n; i++) M.re[i * n + i] = 1;
  return M;
}

/**
 * Construct a real Matrix from a nested JS array. The outer length is `rows`,
 * the inner length (uniform; checked) is `cols`. Intended for tests and
 * tool boundaries, not for hot paths — the allocation cost is dominated by
 * the per-element copy.
 */
export function fromNested(rows: number[][]): Matrix {
  if (rows.length === 0) throw new MatrixError("fromNested: empty input");
  const r = rows.length;
  const c = rows[0]!.length;
  if (c === 0) throw new MatrixError("fromNested: empty rows");
  const re = new Float64Array(r * c);
  for (let i = 0; i < r; i++) {
    const row = rows[i]!;
    if (row.length !== c) {
      throw new MatrixError(
        `fromNested: ragged input — row 0 has ${c} cols, row ${i} has ${row.length}`,
      );
    }
    for (let j = 0; j < c; j++) re[i * c + j] = row[j]!;
  }
  return { rows: r, cols: c, re };
}

/**
 * Construct a complex Matrix from nested {re, im} arrays. The two arrays
 * must have matching shapes. Convenience wrapper for tests.
 */
export function fromNestedComplex(re: number[][], im: number[][]): Matrix {
  const A = fromNested(re);
  const B = fromNested(im);
  if (A.rows !== B.rows || A.cols !== B.cols) {
    throw new MatrixError(
      `fromNestedComplex: shape mismatch re=${A.rows}×${A.cols} im=${B.rows}×${B.cols}`,
    );
  }
  return { rows: A.rows, cols: A.cols, re: A.re, im: B.re };
}

/**
 * Wrap an already-allocated Float64Array as a real Matrix. The caller
 * gives up ownership — qinfo functions assume they may not be aliased.
 * Pre-checks: data.length === rows*cols.
 */
export function fromRowMajor(rows: number, cols: number, data: Float64Array): Matrix {
  checkDim(rows, "rows");
  checkDim(cols, "cols");
  if (data.length !== rows * cols) {
    throw new MatrixError(
      `fromRowMajor: length mismatch — expected ${rows * cols}, got ${data.length}`,
    );
  }
  return { rows, cols, re: data };
}

// ─── Predicates & projections ──────────────────────────────────────────

export function isReal(M: Matrix): boolean {
  return M.im === undefined;
}

/**
 * Convert a real Matrix to nested JS arrays (tests, tool encoders).
 * Throws on complex input — use `toNestedComplex` for that.
 */
export function toNested(M: Matrix): number[][] {
  if (M.im !== undefined) {
    throw new MatrixError("toNested: complex Matrix — use toNestedComplex");
  }
  const out: number[][] = new Array(M.rows);
  for (let i = 0; i < M.rows; i++) {
    const row = new Array<number>(M.cols);
    for (let j = 0; j < M.cols; j++) row[j] = M.re[i * M.cols + j]!;
    out[i] = row;
  }
  return out;
}

/** Convert a complex Matrix to `{re: number[][], im: number[][]}`. */
export function toNestedComplex(M: Matrix): { re: number[][]; im: number[][] } {
  const re = new Array<number[]>(M.rows);
  const im = new Array<number[]>(M.rows);
  const Mim = M.im;
  for (let i = 0; i < M.rows; i++) {
    const rRow = new Array<number>(M.cols);
    const iRow = new Array<number>(M.cols);
    for (let j = 0; j < M.cols; j++) {
      const k = i * M.cols + j;
      rRow[j] = M.re[k]!;
      iRow[j] = Mim ? Mim[k]! : 0;
    }
    re[i] = rRow;
    im[i] = iRow;
  }
  return { re, im };
}

// ─── Elementary ops (used by kron / choi / etc) ────────────────────────

/** Allocate a fresh deep copy of M. */
export function clone(M: Matrix): Matrix {
  const re = new Float64Array(M.re);
  if (M.im) {
    return { rows: M.rows, cols: M.cols, re, im: new Float64Array(M.im) };
  }
  return { rows: M.rows, cols: M.cols, re };
}

/** Transpose (no conjugation — for complex use `adjoint` instead). */
export function transpose(M: Matrix): Matrix {
  const out = M.im ? zerosComplex(M.cols, M.rows) : zeros(M.cols, M.rows);
  for (let i = 0; i < M.rows; i++) {
    for (let j = 0; j < M.cols; j++) {
      out.re[j * M.rows + i] = M.re[i * M.cols + j]!;
      if (M.im) out.im![j * M.rows + i] = M.im[i * M.cols + j]!;
    }
  }
  return out;
}

/** Conjugate transpose (Hermitian adjoint). For real M, equals transpose. */
export function adjoint(M: Matrix): Matrix {
  const out = M.im ? zerosComplex(M.cols, M.rows) : zeros(M.cols, M.rows);
  for (let i = 0; i < M.rows; i++) {
    for (let j = 0; j < M.cols; j++) {
      out.re[j * M.rows + i] = M.re[i * M.cols + j]!;
      if (M.im) out.im![j * M.rows + i] = -M.im[i * M.cols + j]!;
    }
  }
  return out;
}

/** Trace tr(M) = Σ_i M_ii. Returns {re, im}; if M is real, im === 0. */
export function trace(M: Matrix): { re: number; im: number } {
  if (M.rows !== M.cols) {
    throw new MatrixError(`trace: non-square — ${M.rows}×${M.cols}`);
  }
  let re = 0;
  let im = 0;
  for (let i = 0; i < M.rows; i++) {
    re += M.re[i * M.cols + i]!;
    if (M.im) im += M.im[i * M.cols + i]!;
  }
  return { re, im };
}

/**
 * Matrix product C = A · B. Shapes: A is m × k, B is k × n; C is m × n.
 *
 * Naive triple-loop O(m·n·k). This is the slowest path in the package;
 * if you find yourself reaching for it on > 100×100 dense matrices, the
 * right home is `@workbench/linalg-core`'s solver chain or eventually
 * a BLAS-backed kernel. qinfo uses this for tests and for the inner
 * `M M†` step of `partialTracePure`; both are small.
 */
export function matmul(A: Matrix, B: Matrix): Matrix {
  if (A.cols !== B.rows) {
    throw new MatrixError(
      `matmul: shape mismatch — A is ${A.rows}×${A.cols}, B is ${B.rows}×${B.cols}`,
    );
  }
  const m = A.rows;
  const k = A.cols;
  const n = B.cols;
  const complex = A.im !== undefined || B.im !== undefined;
  const out = complex ? zerosComplex(m, n) : zeros(m, n);
  const Are = A.re;
  const Aim = A.im;
  const Bre = B.re;
  const Bim = B.im;
  for (let i = 0; i < m; i++) {
    for (let j = 0; j < n; j++) {
      let sRe = 0;
      let sIm = 0;
      for (let p = 0; p < k; p++) {
        const aR = Are[i * k + p]!;
        const aI = Aim ? Aim[i * k + p]! : 0;
        const bR = Bre[p * n + j]!;
        const bI = Bim ? Bim[p * n + j]! : 0;
        sRe += aR * bR - aI * bI;
        if (complex) sIm += aR * bI + aI * bR;
      }
      out.re[i * n + j] = sRe;
      if (out.im) out.im[i * n + j] = sIm;
    }
  }
  return out;
}

/** Scalar multiply: c · M. Complex c via {re, im}; real c is just {re: c}. */
export function scale(c: number | { re: number; im: number }, M: Matrix): Matrix {
  const cRe = typeof c === "number" ? c : c.re;
  const cIm = typeof c === "number" ? 0 : c.im;
  const complex = cIm !== 0 || M.im !== undefined;
  const out = complex ? zerosComplex(M.rows, M.cols) : zeros(M.rows, M.cols);
  for (let k = 0; k < M.re.length; k++) {
    const mr = M.re[k]!;
    const mi = M.im ? M.im[k]! : 0;
    out.re[k] = cRe * mr - cIm * mi;
    if (out.im) out.im[k] = cRe * mi + cIm * mr;
  }
  return out;
}

/** Elementwise sum: A + B. Shapes must match. */
export function add(A: Matrix, B: Matrix): Matrix {
  if (A.rows !== B.rows || A.cols !== B.cols) {
    throw new MatrixError(
      `add: shape mismatch — ${A.rows}×${A.cols} vs ${B.rows}×${B.cols}`,
    );
  }
  const complex = A.im !== undefined || B.im !== undefined;
  const out = complex ? zerosComplex(A.rows, A.cols) : zeros(A.rows, A.cols);
  for (let k = 0; k < A.re.length; k++) {
    out.re[k] = A.re[k]! + B.re[k]!;
    if (out.im) out.im[k] = (A.im ? A.im[k]! : 0) + (B.im ? B.im[k]! : 0);
  }
  return out;
}

/** Elementwise difference: A − B. */
export function sub(A: Matrix, B: Matrix): Matrix {
  if (A.rows !== B.rows || A.cols !== B.cols) {
    throw new MatrixError(
      `sub: shape mismatch — ${A.rows}×${A.cols} vs ${B.rows}×${B.cols}`,
    );
  }
  const complex = A.im !== undefined || B.im !== undefined;
  const out = complex ? zerosComplex(A.rows, A.cols) : zeros(A.rows, A.cols);
  for (let k = 0; k < A.re.length; k++) {
    out.re[k] = A.re[k]! - B.re[k]!;
    if (out.im) out.im[k] = (A.im ? A.im[k]! : 0) - (B.im ? B.im[k]! : 0);
  }
  return out;
}

/**
 * Maximum absolute element-wise difference between A and B. Treats undefined
 * im as zero. Useful for tests asserting two matrices are equal up to a
 * tolerance: `expect(maxAbsDiff(actual, expected)).toBeLessThan(1e-12)`.
 */
export function maxAbsDiff(A: Matrix, B: Matrix): number {
  if (A.rows !== B.rows || A.cols !== B.cols) {
    throw new MatrixError(
      `maxAbsDiff: shape mismatch — ${A.rows}×${A.cols} vs ${B.rows}×${B.cols}`,
    );
  }
  let m = 0;
  for (let k = 0; k < A.re.length; k++) {
    const drRe = A.re[k]! - B.re[k]!;
    const drIm = (A.im ? A.im[k]! : 0) - (B.im ? B.im[k]! : 0);
    const mag = Math.hypot(drRe, drIm);
    if (mag > m) m = mag;
  }
  return m;
}

// ─── Internal helpers ──────────────────────────────────────────────────

function checkDim(n: number, name: string): void {
  if (!Number.isInteger(n) || n <= 0) {
    throw new MatrixError(`${name} must be a positive integer, got ${n}`);
  }
}
