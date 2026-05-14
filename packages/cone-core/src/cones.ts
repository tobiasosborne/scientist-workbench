// =============================================================================
// cones.ts — the convex-cone primitive and its Euclidean projection
// =============================================================================
//
// A `Cone` describes one closed convex cone over a contiguous block of a
// real vector. The full cone of a conic program is a *product* of these
// primitives; the product is the caller's `Cone[]` (the SCS iteration in
// `scs.ts` walks one over slices of the iterate). This mirrors the way
// `@workbench/linalg-core` exposes `Matrix` as the primitive and lets the
// caller compose — the substrate stays small and the composition stays
// visible.
//
// Three operations, each a textbook object:
//
//   projectCone(z, K)  — the Euclidean projection Π_K(z) = argmin_{w∈K} ‖w−z‖₂
//   dualCone(K)        — the dual cone K* = {y : yᵀz ≥ 0 ∀ z ∈ K}
//   inCone(z, K, tol)  — membership test, tolerance-gated (never an
//                        implicit `x > 0`; ADR-0030 determinism contract)
//
// Ground truth: `docs/ground-truth/convex/scs-algorithm.md` §6 (the zero /
// free / nonneg projections, transcribed from O'Donoghue et al 2016,
// `docs/refs/odonoghue-2016-scs.pdf`) and `docs/ground-truth/convex/
// cone-projections.md` (the second-order and semidefinite projections,
// transcribed from Parikh-Boyd *Proximal Algorithms* §6.3,
// `docs/refs/parikh-boyd-2014-proximal-algorithms.pdf` — O'Donoghue 2016
// §6.1 p. 1059 gives only the cone *definitions* and defers the projection
// *formulas* to that monograph, its ref [64]).
//
// Scope as of bead 0wc7 (CLAUDE.md Rule 8 — honest scope). cone-core now
// implements five of the seven cone families:
//
//   - the three *definitional* projections (zero / free / nonneg) — they
//     need no second reference and shipped in v0.1, closing the **LP**
//     case (worklog 089: 21/21 lp-netlib + 29/29 lp-small);
//   - the **second-order** (Lorentz) cone — Parikh-Boyd §6.3.2, the
//     standard 3-case closed form;
//   - the **positive-semidefinite** cone — Parikh-Boyd §6.3.3, eigenvalue
//     clamp on the svec'd block (`smat` → `eigh` → clamp → `svec`); the
//     √2 off-diagonal scaling that makes `svec` a Frobenius isometry is
//     load-bearing (ADR-0030 OQ4 — the trap that bites amateur SDP code).
//
// The `ExpCone` and `PowCone` variants are present in the `Cone` union —
// they are the documented substrate surface (ADR-0030 §H) and a TS expert
// should see the whole map — but every *operation* on them throws a loud
// `ConeError` naming the sub-bead that tracks them. A typed-but-unusable
// variant is honest; a silent wrong projection is not.
//
//   ExpCone, PowCone       → scientist-workbench-j282 (needs Parikh-Boyd
//                            §6.3.4 + Khanh Hien 2014 for the power cone)

import { eigh, type Matrix, matrixFromRows } from "@workbench/linalg-core";

/**
 * `ConeError` is a substrate-level programming / scope error: a vector
 * whose length does not match the cone's dimension, a malformed cone
 * spec, or an operation on a cone family not yet implemented in this
 * version. Like `linalg-core`'s `MatrixError` it is a plain `Error`
 * subclass so the substrate carries no `@workbench/protocol` dependency;
 * the tool layer (`tools/cone-solve`) translates it into a `tagged`
 * refusal envelope or a `ToolError` as appropriate.
 */
export class ConeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConeError";
  }
}

// -----------------------------------------------------------------------------
// The Cone union
// -----------------------------------------------------------------------------

/** `ℝ^dim₊` — the nonnegative orthant. Self-dual. */
export interface NonNegCone {
  readonly kind: "nonneg";
  readonly dim: number;
}

/** `{0}^dim` — the zero cone. Dual is the free cone `ℝ^dim`. */
export interface ZeroCone {
  readonly kind: "zero";
  readonly dim: number;
}

/** `ℝ^dim` — the free cone (the whole space). Dual is the zero cone. */
export interface FreeCone {
  readonly kind: "free";
  readonly dim: number;
}

/**
 * The second-order (Lorentz / "ice-cream") cone
 * `{(t, x) ∈ ℝ × ℝ^{dim−1} : t ≥ ‖x‖₂}`. `dim` is the *total* block
 * dimension including the scalar apex coordinate `t`, so `dim ≥ 1`.
 * Self-dual. Projection: Parikh-Boyd §6.3.2 (`projectCone`, `case "soc"`).
 */
export interface SOCone {
  readonly kind: "soc";
  readonly dim: number;
}

/**
 * The cone of symmetric positive-semidefinite `side × side` matrices,
 * carried on the wire as the upper-triangular vectorisation `svec` with
 * the strict-Mosek √2 off-diagonal scaling (ADR-0030 open-question 4),
 * so that `tr(A B) = svec(A)ᵀ svec(B)` — i.e. `svec` is a Frobenius
 * isometry, which is exactly what makes coordinate-wise Euclidean
 * projection equal the matrix projection (see `svec` / `smat` below and
 * `docs/ground-truth/convex/cone-projections.md` §3). Block dimension is
 * `side·(side+1)/2`. Self-dual. Projection: Parikh-Boyd §6.3.3
 * (`projectCone`, `case "psd"`).
 */
export interface PSDCone {
  readonly kind: "psd";
  readonly side: number;
}

/**
 * The exponential cone, the closure of
 * `{(x, y, z) : y > 0, y·exp(x/y) ≤ z}` (∪ `{(x,0,z): x ≤ 0, z ≥ 0}`).
 * Fixed block dimension 3. **Not** self-dual. Projection deferred.
 */
export interface ExpCone {
  readonly kind: "exp";
}

/**
 * The three-dimensional power cone
 * `{(x, y, z) : x^α · y^{1−α} ≥ |z|, x ≥ 0, y ≥ 0}` for a fixed
 * `alpha ∈ [0, 1]`. Fixed block dimension 3. Projection deferred.
 */
export interface PowCone {
  readonly kind: "pow";
  readonly alpha: number;
}

/**
 * One closed convex cone over a contiguous vector block. The full cone
 * of a conic program is a product `Cone[]` of these.
 */
export type Cone =
  | NonNegCone
  | ZeroCone
  | FreeCone
  | SOCone
  | PSDCone
  | ExpCone
  | PowCone;

// -----------------------------------------------------------------------------
// Smart constructors — for the implemented families
// -----------------------------------------------------------------------------
//
// Constructors are exported for the cones whose operations are live: the
// three definitional families (zero / free / nonneg) plus `soc` and `psd`
// as of bead 0wc7. The `ExpCone` / `PowCone` interfaces are exported (they
// are the type-level map) and constructible as object literals, but a
// dedicated constructor would advertise a usable cone the projection
// cannot yet honour — the constructor lands with the projection.

function checkDim(dim: number, what: string): void {
  if (!Number.isInteger(dim) || dim < 0) {
    throw new ConeError(`${what} dimension must be a non-negative integer, got ${dim}`);
  }
}

/** Construct an `ℝ^dim₊` nonnegative-orthant cone. */
export function nonNeg(dim: number): NonNegCone {
  checkDim(dim, "nonneg cone");
  return { kind: "nonneg", dim };
}

/** Construct a `{0}^dim` zero cone. */
export function zero(dim: number): ZeroCone {
  checkDim(dim, "zero cone");
  return { kind: "zero", dim };
}

/** Construct an `ℝ^dim` free cone (the whole space). */
export function free(dim: number): FreeCone {
  checkDim(dim, "free cone");
  return { kind: "free", dim };
}

/**
 * Construct a second-order cone `{(t, x) ∈ ℝ × ℝ^{dim−1} : t ≥ ‖x‖₂}`.
 * `dim` is the *total* block dimension; it must be `≥ 1`, because the
 * cone is defined by its scalar apex coordinate `t` and a block with no
 * `t` is malformed (not just empty — there is nothing to be `≥` a norm).
 * `dim = 1` is the degenerate-but-valid case: the cone is the
 * nonnegative half-line `{t : t ≥ 0}`.
 */
export function soc(dim: number): SOCone {
  checkDim(dim, "soc cone");
  if (dim < 1) {
    throw new ConeError(
      `soc cone dimension must be at least 1 (the scalar apex coordinate), got ${dim}`,
    );
  }
  return { kind: "soc", dim };
}

/**
 * Construct a positive-semidefinite cone over symmetric `side × side`
 * matrices. `side` must be `≥ 1`. The block the cone constrains is the
 * `side·(side+1)/2`-long upper-triangular `svec` vectorisation with the
 * √2 off-diagonal scaling (see `svec` / `smat`).
 */
export function psd(side: number): PSDCone {
  checkDim(side, "psd cone");
  if (side < 1) {
    throw new ConeError(`psd cone side must be at least 1, got ${side}`);
  }
  return { kind: "psd", side };
}

// -----------------------------------------------------------------------------
// coneDim — the block dimension a cone occupies
// -----------------------------------------------------------------------------

/**
 * The dimension of the vector block the cone constrains. `projectCone`
 * and `inCone` require their input vector to have exactly this length.
 * Defined for *every* cone family — it is pure arithmetic on the spec and
 * never depends on a projection being implemented.
 */
export function coneDim(K: Cone): number {
  switch (K.kind) {
    case "nonneg":
    case "zero":
    case "free":
    case "soc":
      return K.dim;
    case "psd":
      // Upper-triangular vectorisation of a symmetric `side × side`
      // matrix: the `side` diagonal entries plus `side·(side−1)/2`
      // off-diagonal entries.
      return (K.side * (K.side + 1)) / 2;
    case "exp":
    case "pow":
      return 3;
  }
}

// -----------------------------------------------------------------------------
// svec / smat — the √2-scaled symmetric-matrix vectorisation
// -----------------------------------------------------------------------------
//
// A `PSDCone` block is carried as a *vector* — the upper-triangular,
// row-major vectorisation of a symmetric `side × side` matrix, with each
// off-diagonal entry scaled by √2 (ADR-0030 open-question 4, the strict-
// Mosek convention). The √2 is not decoration: it is exactly what makes
// `svec` a linear *isometry* between `(Sⁿ, ⟨·,·⟩_Frobenius)` and
// `(ℝ^{n(n+1)/2}, ⟨·,·⟩_Euclidean)`, because
//
//   ⟨svec A, svec B⟩ = Σᵢ AᵢᵢBᵢᵢ + Σ_{i<j}(√2 Aᵢⱼ)(√2 Bᵢⱼ) = tr(A B).
//
// Isometry is the load-bearing fact: it means the Euclidean projection of
// the *block* equals `svec` of the Frobenius projection of the *matrix*,
// so `projectCone` can legitimately go `smat → eigh-clamp → svec`. Drop
// the √2 and that equality breaks — off-diagonal directions would be
// under-counted — which is the classic amateur-SDP bug ADR-0030 OQ4
// calls out. Ground truth: `docs/ground-truth/convex/cone-projections.md`
// §3.
//
// `svec` is never materialised as a standalone function here — the PSD
// projection assembles its result straight into the √2-scaled output
// vector — but `smat` (its inverse, the un-scaling rebuild) is needed to
// hand a real symmetric `Matrix` to `linalg-core`'s `eigh`.

const SQRT2 = Math.SQRT2;

/**
 * `smat(w, side)` — rebuild the symmetric `side × side` matrix from its
 * √2-scaled upper-triangular vectorisation `w` (the inverse of `svec`).
 * Diagonal slots are copied verbatim; each off-diagonal slot is un-scaled
 * by `1/√2` and written to both `(i, j)` and `(j, i)`. `w.length` must be
 * `side·(side+1)/2`; `side ≥ 1`. The result is a fresh `Matrix` suitable
 * for `linalg-core`'s `eigh` — it is symmetric by construction.
 */
function smat(w: Float64Array, side: number): Matrix {
  const rows: number[][] = [];
  for (let i = 0; i < side; i++) rows.push(new Array<number>(side).fill(0));
  let k = 0;
  for (let i = 0; i < side; i++) {
    for (let j = i; j < side; j++) {
      const wk = w[k++]!;
      if (i === j) {
        rows[i]![j] = wk;
      } else {
        const v = wk / SQRT2;
        rows[i]![j] = v;
        rows[j]![i] = v;
      }
    }
  }
  return matrixFromRows(rows);
}

// -----------------------------------------------------------------------------
// projectCone — the Euclidean projection Π_K
// -----------------------------------------------------------------------------

/**
 * The Euclidean projection of `z` onto the cone `K`: the unique
 * `w ∈ K` minimising `‖w − z‖₂`. Returns a *fresh* `Float64Array`; `z`
 * is never mutated (the mutability discipline `linalg-core` documents).
 *
 * `z.length` must equal `coneDim(K)` — a mismatch is a `ConeError`, not
 * a silent truncation (CLAUDE.md Rule 1, fail fast and loud).
 *
 * The three implemented families:
 *
 *  - **zero** `{0}^n`: `Π(z) = 0`. The nearest point of the singleton
 *    `{0}` is `0`, always.
 *  - **free** `ℝⁿ`: `Π(z) = z`. The whole space contains every point;
 *    each is its own nearest point. (A non-finite entry would not lie
 *    in `ℝⁿ`; the SCS iterate is finite by construction, and the
 *    `numerical-breakdown` guard in `scsSolve` catches non-finiteness
 *    upstream, so this path copies unconditionally.)
 *  - **nonneg** `ℝⁿ₊`: `Π(z)ᵢ = max(0, zᵢ)`. The orthant is a product
 *    of half-lines `[0, ∞)`; projection is independent per coordinate,
 *    and the projection onto `[0, ∞)` is `max(0, ·)`.
 *  - **soc** `{(t,x) : t ≥ ‖x‖₂}`: Parikh-Boyd §6.3.2, the standard
 *    three-case closed form (already-in / polar-to-apex / boundary).
 *  - **psd** `{V ⪰ 0}` on the √2-svec'd block: Parikh-Boyd §6.3.3 eq
 *    (6.6) — `smat` the block, `eigh` it, clamp the negative spectrum to
 *    zero, re-assemble straight into the √2-scaled output.
 *
 * Non-finiteness is the caller's precondition to honour: the iterate is
 * finite by construction (the `numerical-breakdown` guard in `scsSolve`
 * catches non-finiteness upstream), so `smat`'s `linalg-core` path never
 * sees a `NaN`. A non-finite `psd` block from a misbehaving caller would
 * surface as a loud `MatrixError`, not a silent wrong answer.
 *
 * `exp` / `pow` throw — see the scope note at the top of this file.
 */
export function projectCone(z: Float64Array, K: Cone): Float64Array {
  const expected = coneDim(K);
  if (z.length !== expected) {
    throw new ConeError(
      `projectCone: vector length ${z.length} does not match ${K.kind}-cone dimension ${expected}`,
    );
  }
  switch (K.kind) {
    case "zero":
      // Π_{0}(z) = 0.
      return new Float64Array(expected);
    case "free":
      // Π_ℝⁿ(z) = z.
      return z.slice();
    case "nonneg": {
      // Π_{ℝⁿ₊}(z)ᵢ = max(0, zᵢ), coordinate-wise.
      const out = new Float64Array(expected);
      for (let i = 0; i < expected; i++) {
        const zi = z[i]!;
        out[i] = zi > 0 ? zi : 0;
      }
      return out;
    }
    case "soc": {
      // Parikh-Boyd §6.3.2 — the second-order cone, in cone-core's
      // scalar-first ordering `z = (t, x)`. Let `ρ = ‖x‖₂`. The branch
      // order is load-bearing for the `ρ = 0` corner (cone-projections.md
      // §2): test `ρ ≤ t` *before* `ρ ≤ −t`.
      if (expected < 1) {
        throw new ConeError(
          `projectCone: soc cone needs a scalar apex coordinate — ` +
            `dimension must be ≥ 1, got ${expected}`,
        );
      }
      const t = z[0]!;
      let rho = 0;
      for (let i = 1; i < expected; i++) rho += z[i]! * z[i]!;
      rho = Math.sqrt(rho);
      if (rho <= t) {
        // already inside the cone — the projection is the identity
        return z.slice();
      }
      if (rho <= -t) {
        // inside the polar cone (the SOC is self-dual) — project to the apex
        return new Float64Array(expected);
      }
      // genuine boundary projection: ½·(1 + t/ρ)·(ρ, x). Reached only
      // when ρ > |t| ≥ 0, so ρ > 0 strictly — the /(2ρ) is always safe.
      const out = new Float64Array(expected);
      const scale = (rho + t) / (2 * rho);
      out[0] = (rho + t) / 2;
      for (let i = 1; i < expected; i++) out[i] = scale * z[i]!;
      return out;
    }
    case "psd": {
      // Parikh-Boyd §6.3.3 eq (6.6) — Π(V) = Σ (λᵢ)₊ uᵢuᵢᵀ. `smat` the
      // block to the symmetric matrix `V`, `eigh` it, clamp the negative
      // eigenvalues to zero, and re-assemble V⁺ᵢⱼ = Σₑ max(0,λₑ)·QᵢₑQⱼₑ
      // straight into the √2-scaled svec output. Valid because the √2
      // scaling makes svec a Frobenius isometry (see the svec/smat note).
      const side = K.side;
      if (side < 1) {
        throw new ConeError(`projectCone: psd cone side must be ≥ 1, got ${side}`);
      }
      const { Q, eigenvalues } = eigh(smat(z, side));
      const out = new Float64Array(expected);
      let k = 0;
      for (let i = 0; i < side; i++) {
        for (let j = i; j < side; j++) {
          let acc = 0;
          for (let e = 0; e < side; e++) {
            const lam = eigenvalues[e]!;
            if (lam > 0) acc += lam * Q.data[i * side + e]! * Q.data[j * side + e]!;
          }
          out[k++] = i === j ? acc : SQRT2 * acc;
        }
      }
      return out;
    }
    case "exp":
    case "pow":
      throw new ConeError(
        `projectCone: the ${K.kind} cone is not implemented in cone-core — ` +
          `tracked in scientist-workbench-j282 (needs Parikh-Boyd §6.3.4` +
          `${K.kind === "pow" ? " + Khanh Hien 2014" : ""})`,
      );
  }
}

// -----------------------------------------------------------------------------
// dualCone — the dual cone K*
// -----------------------------------------------------------------------------

/**
 * The dual cone `K* = {y : yᵀz ≥ 0 for all z ∈ K}`.
 *
 *  - **nonneg** is self-dual: `(ℝⁿ₊)* = ℝⁿ₊`.
 *  - **zero** and **free** are duals of each other: `({0}ⁿ)* = ℝⁿ` and
 *    `(ℝⁿ)* = {0}ⁿ`. (Every `y` has `yᵀ·0 = 0 ≥ 0`, so the dual of the
 *    zero cone is the whole space; conversely only `y = 0` has
 *    `yᵀz ≥ 0` for *every* `z ∈ ℝⁿ`.)
 *  - **soc** and **psd** are self-dual.
 *  - **exp** is **not** self-dual — its dual is a distinct cone with no
 *    representation in the v0.1 `Cone` union, so `dualCone` throws for
 *    it, consistent with `projectCone`. **pow**'s dual is a power cone
 *    with exponent `α` but a different inequality; also deferred.
 *
 * `dualCone` is pure type-level rewriting — it never touches a vector —
 * but it throws for `exp` / `pow` because the *result* type cannot be
 * expressed in v0.1, and returning a wrong-shaped cone would be the
 * silent lie Rule 8 forbids.
 */
export function dualCone(K: Cone): Cone {
  switch (K.kind) {
    case "nonneg":
    case "soc":
    case "psd":
      return K; // self-dual
    case "zero":
      return { kind: "free", dim: K.dim };
    case "free":
      return { kind: "zero", dim: K.dim };
    case "exp":
    case "pow":
      throw new ConeError(
        `dualCone: the dual of the ${K.kind} cone has no representation in ` +
          `cone-core v0.1 — tracked in scientist-workbench-j282`,
      );
  }
}

// -----------------------------------------------------------------------------
// inCone — tolerance-gated membership test
// -----------------------------------------------------------------------------

/**
 * Whether `z` lies in `K` to within `tol`. Every comparison is gated by
 * an explicit tolerance — the ADR-0030 determinism contract forbids
 * implicit-zero gates (`if (x > 0)`), because the sign of a value that
 * is `−1e-17` "should be" zero is a platform-fingerprint coin-flip.
 *
 *  - **nonneg**: every `zᵢ ≥ −tol`.
 *  - **zero**: every `|zᵢ| ≤ tol`.
 *  - **free**: every `zᵢ` finite (the whole space — but `NaN`/`±∞` are
 *    not points of `ℝⁿ`, and saying "yes" for a poisoned vector would
 *    be the wrong kind of honest).
 *  - **soc**: `t − ‖x‖₂ ≥ −tol` for `z = (t, x)`.
 *  - **psd**: `λ_min(smat(z)) ≥ −tol` — `eigh` sorts ascending, so the
 *    smallest eigenvalue is `eigenvalues[0]`.
 *
 * As with `free`, a non-finite entry is never a cone member: `soc`
 * rejects it because the `NaN` poisons the `≥` comparison, and `psd`
 * pre-scans the block (a non-finite block cannot be `smat`-rebuilt for
 * `eigh`) — both return `false`, never throw.
 *
 * `tol` must be finite and non-negative. `z.length` must equal
 * `coneDim(K)`.
 */
export function inCone(z: Float64Array, K: Cone, tol: number): boolean {
  if (!Number.isFinite(tol) || tol < 0) {
    throw new ConeError(`inCone: tol must be finite and non-negative, got ${tol}`);
  }
  const expected = coneDim(K);
  if (z.length !== expected) {
    throw new ConeError(
      `inCone: vector length ${z.length} does not match ${K.kind}-cone dimension ${expected}`,
    );
  }
  switch (K.kind) {
    case "nonneg":
      for (let i = 0; i < expected; i++) {
        if (!(z[i]! >= -tol)) return false; // also rejects NaN
      }
      return true;
    case "zero":
      for (let i = 0; i < expected; i++) {
        if (!(Math.abs(z[i]!) <= tol)) return false; // also rejects NaN
      }
      return true;
    case "free":
      for (let i = 0; i < expected; i++) {
        if (!Number.isFinite(z[i]!)) return false;
      }
      return true;
    case "soc": {
      // (t, x) ∈ soc  ⇔  t ≥ ‖x‖₂.  Tolerance-gated: t − ‖x‖₂ ≥ −tol.
      // A NaN coordinate poisons `rho`, so `t − rho >= −tol` is `false`
      // — non-finite vectors are correctly rejected.
      if (expected < 1) {
        throw new ConeError(
          `inCone: soc cone needs a scalar apex coordinate — ` +
            `dimension must be ≥ 1, got ${expected}`,
        );
      }
      const t = z[0]!;
      let rho = 0;
      for (let i = 1; i < expected; i++) rho += z[i]! * z[i]!;
      rho = Math.sqrt(rho);
      return t - rho >= -tol;
    }
    case "psd": {
      // smat(z) ⪰ 0  ⇔  λ_min ≥ 0.  Tolerance-gated: λ_min ≥ −tol.
      // A non-finite block is never a cone member (and cannot be
      // `smat`-rebuilt for `eigh`) — pre-scan and reject as `false`,
      // matching the `free` cone's NaN handling.
      const side = K.side;
      if (side < 1) {
        throw new ConeError(`inCone: psd cone side must be ≥ 1, got ${side}`);
      }
      for (let i = 0; i < expected; i++) {
        if (!Number.isFinite(z[i]!)) return false;
      }
      const { eigenvalues } = eigh(smat(z, side));
      return eigenvalues[0]! >= -tol;
    }
    case "exp":
    case "pow":
      throw new ConeError(
        `inCone: the ${K.kind} cone is not implemented in cone-core — ` +
          `tracked in scientist-workbench-j282`,
      );
  }
}
