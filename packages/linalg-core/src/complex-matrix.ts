// =============================================================================
// complex-matrix.ts — the dense complex matrix substrate for linalg-core
// =============================================================================
//
// Intent
// ------
// The complex sibling of `Matrix` (matrix.ts). Where `Matrix` is the real-
// only dense matrix on a single `Float64Array`, `ComplexMatrix` is the
// complex dense matrix on a parallel-array pair `(re, im)`, both
// `Float64Array`s of length `rows * cols`. The two types coexist in
// linalg-core; bridge helpers convert at boundaries (`complexFromReal`,
// `complexFromQinfo`, `realPartOnly`).
//
// Why a separate type, not optional `im` on `Matrix`
// ---------------------------------------------------
// ADR-0035 §D4. The discipline is type-honest: a `ComplexMatrix` is
// **definitely complex** — every algorithm that takes a `ComplexMatrix`
// trusts the type and never branches on `if (M.im)` at the top of a body.
// The branch on "real vs complex input" happens once, at the boundary,
// where the caller chooses which entry point to call (real `eigh(M:
// Matrix)` or complex `eighComplex(H: ComplexMatrix)`). Inside the body,
// one shape.
//
// Compare to `@workbench/qinfo`'s `Matrix` (ADR-0034 §D2): there, `im` is
// optional because qinfo's index-only operations transparently handle
// both real and complex matrices with the same code. That's the right
// shape for an index-permutation operation; it is the wrong shape for an
// algorithm that requires complex arithmetic (and therefore actually
// needs the imaginary part to be present).
//
// Why row-major
// -------------
// Matches `Matrix`'s convention (row-major, element `(i, j)` at index
// `i * cols + j`). LU, QR, and the embedded real eigh all touch elements
// in row-major patterns; the complex algorithms here inherit those
// patterns when they consume real-symplectic embedded data.
//
// Mutability discipline
// ---------------------
// Same as `Matrix`: every function that returns a `ComplexMatrix`
// allocates fresh `re` and `im` arrays. The caller may mutate inputs
// after the call without affecting outputs. This makes pipelines safe
// to compose.

import { type Matrix, MatrixError } from "./matrix.js";

/**
 * A dense `rows × cols` complex matrix.
 *
 * Invariants enforced by every constructor and bridge helper in this file:
 *   - `re.length === rows * cols`
 *   - `im.length === rows * cols`
 *   - element `(i, j)` lives at `re[i * cols + j]` and `im[i * cols + j]`
 *     (row-major)
 *   - `im` is **never** undefined — a `ComplexMatrix` is definitely
 *     complex. If you have a real matrix, use `Matrix` or call
 *     `complexFromReal` to lift it explicitly.
 *
 * The type's required `im` is the type-level expression of "this value
 * is complex" (ADR-0035 §D4). Algorithms that consume a `ComplexMatrix`
 * never branch on imaginary presence; they always read both parts.
 */
export type ComplexMatrix = {
  readonly rows: number;
  readonly cols: number;
  readonly re: Float64Array;
  readonly im: Float64Array;
};

// ─── Constructors ────────────────────────────────────────────────────────

/**
 * Construct a `ComplexMatrix` from two parallel nested arrays. `reRows`
 * and `imRows` must have matching outer length, matching inner length on
 * every row, and equal shapes to each other. Intended for tests and
 * tool boundaries; the inner copy makes this O(rows · cols) — not for
 * hot paths.
 */
export function complexFromNested(reRows: number[][], imRows: number[][]): ComplexMatrix {
  if (reRows.length === 0) throw new MatrixError("complexFromNested: empty input");
  const r = reRows.length;
  const c = reRows[0]!.length;
  if (c === 0) throw new MatrixError("complexFromNested: empty rows");
  if (imRows.length !== r) {
    throw new MatrixError(
      `complexFromNested: shape mismatch — re has ${r} rows, im has ${imRows.length}`,
    );
  }
  const re = new Float64Array(r * c);
  const im = new Float64Array(r * c);
  for (let i = 0; i < r; i++) {
    const rRow = reRows[i]!;
    const iRow = imRows[i]!;
    if (rRow.length !== c) {
      throw new MatrixError(
        `complexFromNested: ragged re — row 0 has ${c} cols, row ${i} has ${rRow.length}`,
      );
    }
    if (iRow.length !== c) {
      throw new MatrixError(
        `complexFromNested: ragged im — row 0 has ${c} cols, row ${i} has ${iRow.length}`,
      );
    }
    for (let j = 0; j < c; j++) {
      re[i * c + j] = rRow[j]!;
      im[i * c + j] = iRow[j]!;
    }
  }
  return { rows: r, cols: c, re, im };
}

/** Complex zero matrix of given shape (both parts freshly allocated). */
export function complexZeros(rows: number, cols: number): ComplexMatrix {
  return {
    rows,
    cols,
    re: new Float64Array(rows * cols),
    im: new Float64Array(rows * cols),
  };
}

// ─── Bridge helpers (ADR-0035 §D4) ───────────────────────────────────────

/**
 * Lift a real `Matrix` to a `ComplexMatrix` with zero imaginary part.
 * Allocates a fresh imaginary buffer and a copy of the real data so
 * the result does not alias the caller's `M.data`.
 */
export function complexFromReal(M: Matrix): ComplexMatrix {
  return {
    rows: M.rows,
    cols: M.cols,
    re: new Float64Array(M.data),
    im: new Float64Array(M.rows * M.cols),
  };
}

/**
 * Lift a qinfo-shaped matrix (or any value with `{rows, cols, re,
 * im?}`) to a `ComplexMatrix`. When `im` is absent, allocates a fresh
 * zero buffer; when present, copies it. The structural parameter type
 * keeps linalg-core free of any `@workbench/qinfo` dependency — anyone
 * with a value of that shape can use this helper.
 */
export function complexFromQinfo(M: {
  readonly rows: number;
  readonly cols: number;
  readonly re: Float64Array;
  readonly im?: Float64Array;
}): ComplexMatrix {
  return {
    rows: M.rows,
    cols: M.cols,
    re: new Float64Array(M.re),
    im: M.im !== undefined ? new Float64Array(M.im) : new Float64Array(M.rows * M.cols),
  };
}

/**
 * Project a `ComplexMatrix` onto its real part, discarding the
 * imaginary part. The result aliases nothing of the input (`data`
 * is a fresh copy of `re`); the caller is free to mutate either.
 * Useful when an algorithm has finished and only the real spectrum
 * matters (e.g., for diagnostic output that flows into a real-only
 * downstream tool).
 */
export function realPartOnly(M: ComplexMatrix): Matrix {
  return {
    rows: M.rows,
    cols: M.cols,
    data: new Float64Array(M.re),
  };
}

// ─── Elementary complex ops needed by eigh-complex's diagnostics ──────────

/**
 * Conjugate transpose `M†`. For a `rows × cols` input the output is
 * `cols × rows`. Equivalent to "transpose with sign-flip on the
 * imaginary part." For a real-valued `ComplexMatrix` (all zeros in
 * `im`) this is just transpose; the public name preserves the
 * conjugation intent.
 */
export function complexAdjoint(M: ComplexMatrix): ComplexMatrix {
  const out = complexZeros(M.cols, M.rows);
  for (let i = 0; i < M.rows; i++) {
    for (let j = 0; j < M.cols; j++) {
      const k = i * M.cols + j;
      const t = j * M.rows + i;
      out.re[t] = M.re[k]!;
      out.im[t] = -M.im[k]!;
    }
  }
  return out;
}

/**
 * Frobenius norm `‖M‖_F = sqrt(Σ_{i,j} |M[i,j]|²)` where
 * `|M[i,j]|² = re² + im²`. Plain summation; no Kahan, since the
 * use case here (post-decomposition residual diagnostics) does not
 * stress numerical stability beyond the algorithm's own bound.
 */
export function complexFrobeniusNorm(M: ComplexMatrix): number {
  let s = 0;
  for (let k = 0; k < M.re.length; k++) {
    const r = M.re[k]!;
    const i = M.im[k]!;
    s += r * r + i * i;
  }
  return Math.sqrt(s);
}

/**
 * Maximum element absolute value `max_{i,j} |M[i,j]|`. Used by the
 * Hermiticity tolerance (`100 · EPS · max|M|`) and by scale-warning
 * logic in the tool layer. Walks the entire matrix (no early exit).
 */
export function complexMaxAbs(M: ComplexMatrix): number {
  let m = 0;
  for (let k = 0; k < M.re.length; k++) {
    const r = M.re[k]!;
    const i = M.im[k]!;
    const v = Math.hypot(r, i);
    if (v > m) m = v;
  }
  return m;
}

/**
 * Naive triple-loop complex matrix product `C = A · B`. Shapes:
 * `A` is `m × k`, `B` is `k × n`; `C` is `m × n`. Inner loop applies
 * the complex multiplication rule
 *
 *     (aR + i aI)(bR + i bI) = (aR bR − aI bI) + i (aR bI + aI bR)
 *
 * per element. O(m · k · n) work. The use case here is post-
 * decomposition residual computation (`H · Q` is `n × n × n` work on
 * matrices well within the bench's tolerance regime); a BLAS-backed
 * variant would belong in the FFI bridge (bead `e7y`) when a workload
 * justifies it.
 */
export function complexMatmul(A: ComplexMatrix, B: ComplexMatrix): ComplexMatrix {
  if (A.cols !== B.rows) {
    throw new MatrixError(
      `complexMatmul: shape mismatch — A is ${A.rows}×${A.cols}, B is ${B.rows}×${B.cols}`,
    );
  }
  const m = A.rows;
  const k = A.cols;
  const n = B.cols;
  const out = complexZeros(m, n);
  for (let i = 0; i < m; i++) {
    for (let j = 0; j < n; j++) {
      let sRe = 0;
      let sIm = 0;
      for (let p = 0; p < k; p++) {
        const aR = A.re[i * k + p]!;
        const aI = A.im[i * k + p]!;
        const bR = B.re[p * n + j]!;
        const bI = B.im[p * n + j]!;
        sRe += aR * bR - aI * bI;
        sIm += aR * bI + aI * bR;
      }
      out.re[i * n + j] = sRe;
      out.im[i * n + j] = sIm;
    }
  }
  return out;
}
