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
// Ground truth: `docs/ground-truth/convex/scs-algorithm.md` §6, transcribed
// from O'Donoghue et al 2016 (`docs/refs/odonoghue-2016-scs.pdf`). The 2016
// paper gives the cone *definitions* (§6.1, p. 1059) but defers the
// projection *formulas* for the second-order, semidefinite, exponential and
// power cones to Parikh-Boyd *Proximal Algorithms* §6.3 (ref [64]) and, for
// the power cone, Khanh Hien 2014 (ref [97]).
//
// v0.1 scope (CLAUDE.md Rule 8 — honest scope). cone-core v0.1 implements
// the three cones whose projections are *definitional* and need no second
// reference: the zero cone, the free cone, and the nonnegative orthant.
// Those three close the **LP** case (LP = nonnegative orthant, with
// equalities folded into `Ax = b`), which is exactly the v0.1 bench gate
// (worklog 089: 21/21 lp-netlib + 29/29 lp-small). The `SOCone`, `PSDCone`,
// `ExpCone` and `PowCone` variants are present in the `Cone` union — they
// are the documented substrate surface (ADR-0030 §H) and a TS expert should
// see the whole map — but every *operation* on them throws a loud
// `ConeError` naming the sub-bead that tracks them. A typed-but-unusable
// variant is honest; a silent wrong projection is not.
//
//   SOCone, PSDCone        → scientist-workbench-0wc7 (needs Parikh-Boyd §6.3)
//   ExpCone, PowCone       → scientist-workbench-j282 (needs Parikh-Boyd §6.3
//                            + Khanh Hien 2014 for the power cone)

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
 * dimension including the scalar `t`. Self-dual. Projection deferred —
 * see the v0.1-scope note at the top of this file.
 */
export interface SOCone {
  readonly kind: "soc";
  readonly dim: number;
}

/**
 * The cone of symmetric positive-semidefinite `side × side` matrices,
 * carried on the wire as the upper-triangular vectorisation with the
 * strict-Mosek √2 off-diagonal scaling (ADR-0030 open-question 4), so
 * that `tr(A B) = svec(A)ᵀ svec(B)`. Block dimension is
 * `side·(side+1)/2`. Self-dual. Projection deferred.
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
// Constructors are exported only for the cones whose operations are live
// in v0.1. The `SOCone` / `PSDCone` / `ExpCone` / `PowCone` interfaces are
// exported (they are the type-level map) and constructible as object
// literals, but a dedicated constructor would advertise a usable cone the
// projection cannot yet honour. The constructor lands with the projection.

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
 *
 * `soc` / `psd` / `exp` / `pow` throw — see the v0.1-scope note at the
 * top of this file.
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
    case "soc":
    case "psd":
      throw new ConeError(
        `projectCone: the ${K.kind} cone is not implemented in cone-core v0.1 — ` +
          `tracked in scientist-workbench-0wc7 (needs Parikh-Boyd Proximal Algorithms §6.3)`,
      );
    case "exp":
    case "pow":
      throw new ConeError(
        `projectCone: the ${K.kind} cone is not implemented in cone-core v0.1 — ` +
          `tracked in scientist-workbench-j282 (needs Parikh-Boyd §6.3` +
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
    case "soc":
    case "psd":
      throw new ConeError(
        `inCone: the ${K.kind} cone is not implemented in cone-core v0.1 — ` +
          `tracked in scientist-workbench-0wc7`,
      );
    case "exp":
    case "pow":
      throw new ConeError(
        `inCone: the ${K.kind} cone is not implemented in cone-core v0.1 — ` +
          `tracked in scientist-workbench-j282`,
      );
  }
}
