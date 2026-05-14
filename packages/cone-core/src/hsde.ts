// =============================================================================
// hsde.ts — the homogeneous self-dual embedding
// =============================================================================
//
// The HSDE converts a primal–dual pair of cone programs into a single
// convex feasibility problem: find a nonzero `(u, v)` with `v = Q u` and
// `(u, v) ∈ 𝒞 × 𝒞*`. Solving *that* — done by the operator-splitting
// iteration in `scs.ts` — yields either a primal–dual solution of the
// original program *or* a certificate of primal/dual infeasibility,
// uniformly. That two-for-one is the whole reason the embedding exists.
//
// This module owns two responsibilities:
//
//   buildHSDE(problem)            — validate a `ConeProblem` and surface its
//                                   dimensions as a trusted `HSDEMatrix`
//   recoverPrimalDual(u, v, …)    — read a primal–dual solution or an
//                                   infeasibility certificate out of an
//                                   embedding point (the §3.5 evaluator)
//
// Ground truth: `docs/ground-truth/convex/scs-algorithm.md` §1–§2 and §3.5,
// transcribed from O'Donoghue et al 2016 (`docs/refs/odonoghue-2016-scs.pdf`),
// §2 (p. 1045–1047) and §3.5 (p. 1054–1055).
//
// Variable layout. The embedding stacks
//
//     u = [ x ; y ; τ ]   ∈ ℝⁿ × 𝒦* × ℝ₊         (length N = n + m + 1)
//     v = [ r ; s ; κ ]   ∈ {0}ⁿ × 𝒦  × ℝ₊        (length N)
//
// so `x` is the primal variable (free, ℝⁿ), `y` the dual variable (in the
// dual cone 𝒦*), `s` the primal slack (in the cone 𝒦), `r` the dual
// residual (pinned to 0), and `τ, κ` the homogenisation scalars. The
// embedding matrix is the skew-symmetric
//
//     Q = ⎡ 0    Aᵀ   c⎤      (eq 7, p. 1046)
//         ⎢−A    0    b⎥
//         ⎣−cᵀ  −bᵀ   0⎦

import type { Matrix } from "@workbench/linalg-core";
import { matZeros, set } from "@workbench/linalg-core";
import { type Cone, ConeError, coneDim } from "./cones.js";

// -----------------------------------------------------------------------------
// internal linear-algebra helpers
// -----------------------------------------------------------------------------
//
// `@workbench/linalg-core` exposes `matVec` (A x) but not the transposed
// product (Aᵀ y) or a plain dot — both are one tight loop, kept local so
// the substrate dependency stays exactly "linalg-core, for `Matrix` + LU".

/** `Aᵀ x` for an `m × n` matrix `A` and length-`m` vector `x` → length `n`. */
export function matTransposeVec(A: Matrix, x: Float64Array): Float64Array {
  if (x.length !== A.rows) {
    throw new ConeError(`matTransposeVec: vector length ${x.length} ≠ matrix rows ${A.rows}`);
  }
  const out = new Float64Array(A.cols);
  for (let i = 0; i < A.rows; i++) {
    const xi = x[i]!;
    if (xi === 0) continue;
    const base = i * A.cols;
    for (let j = 0; j < A.cols; j++) {
      out[j]! += A.data[base + j]! * xi;
    }
  }
  return out;
}

/** Euclidean inner product of two equal-length vectors. */
export function dot(a: Float64Array, b: Float64Array): number {
  if (a.length !== b.length) {
    throw new ConeError(`dot: length mismatch ${a.length} ≠ ${b.length}`);
  }
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
}

/** 2-norm of a vector — local copy so callers need not also import linalg-core. */
function norm2(v: Float64Array): number {
  let s = 0;
  for (let i = 0; i < v.length; i++) {
    const vi = v[i]!;
    s += vi * vi;
  }
  return Math.sqrt(s);
}

// -----------------------------------------------------------------------------
// ConeProblem — the input
// -----------------------------------------------------------------------------

/**
 * A primal–dual pair of cone programs in the standard form of
 * O'Donoghue 2016 eq (1):
 *
 *     minimise   cᵀx     s.t.   A x + s = b ,   (x, s) ∈ ℝⁿ × 𝒦
 *
 * The cone `𝒦 ⊆ ℝᵐ` is a *product* `cones`, in order, over contiguous
 * slices of the slack vector `s`; the slice dimensions must sum to `m`.
 * `A` is `m × n` (constraints × variables). All of `A`, `b`, `c` are
 * `Float64Array`-backed; this is a numerics substrate, not a wire type.
 */
export interface ConeProblem {
  /** Constraint matrix, `m × n`. */
  readonly A: Matrix;
  /** Right-hand side, length `m`. */
  readonly b: Float64Array;
  /** Objective coefficients, length `n`. */
  readonly c: Float64Array;
  /** The product cone 𝒦 over the slack `s ∈ ℝᵐ`; Σ `coneDim` must equal `m`. */
  readonly cones: readonly Cone[];
}

// -----------------------------------------------------------------------------
// HSDEMatrix — the validated, dimension-checked structure
// -----------------------------------------------------------------------------

/**
 * A `ConeProblem` that has passed `buildHSDE`'s validation: dimensions are
 * mutually consistent, the cone product tiles `m` exactly, and every data
 * entry is finite. `scsSolve` consumes a `HSDEMatrix`, never a raw
 * `ConeProblem` — so the iteration's inner loop never re-checks shape.
 *
 * The embedding matrix `Q` is *not* stored densely: the SCS iteration
 * never forms it (it works through the structured `M`/`h` factorisation,
 * `scs.ts` §4.1). `assembleQ` materialises it on demand for tests and
 * diagnostics.
 */
export interface HSDEMatrix {
  /** Number of primal variables — `A.cols`. */
  readonly n: number;
  /** Number of constraints — `A.rows`. */
  readonly m: number;
  /** Embedding dimension `n + m + 1` (length of `u` and `v`). */
  readonly N: number;
  readonly A: Matrix;
  readonly b: Float64Array;
  readonly c: Float64Array;
  readonly cones: readonly Cone[];
}

/**
 * Validate a `ConeProblem` and lift it to a trusted `HSDEMatrix`.
 *
 * Rejects, loudly (`ConeError`, CLAUDE.md Rule 1):
 *  - empty problems (`n < 1` or `m < 1`) — the embedding and the SMW
 *    factorisation both assume at least a 1×1 block;
 *  - dimension mismatches between `A`, `b`, `c`;
 *  - a cone product whose dimensions do not sum to exactly `m` (a partial
 *    tiling would leave slack coordinates unconstrained — a silent
 *    wrong answer);
 *  - non-finite entries in `A`, `b`, or `c`.
 */
export function buildHSDE(problem: ConeProblem): HSDEMatrix {
  const { A, b, c, cones } = problem;
  const m = A.rows;
  const n = A.cols;

  if (n < 1 || m < 1) {
    throw new ConeError(`buildHSDE: problem must have n ≥ 1 and m ≥ 1, got n=${n}, m=${m}`);
  }
  if (b.length !== m) {
    throw new ConeError(`buildHSDE: b has length ${b.length}, expected m=${m} (= A.rows)`);
  }
  if (c.length !== n) {
    throw new ConeError(`buildHSDE: c has length ${c.length}, expected n=${n} (= A.cols)`);
  }

  let coneTotal = 0;
  for (const K of cones) coneTotal += coneDim(K);
  if (coneTotal !== m) {
    throw new ConeError(
      `buildHSDE: cone product has total dimension ${coneTotal}, must tile m=${m} exactly`,
    );
  }

  for (let i = 0; i < A.data.length; i++) {
    if (!Number.isFinite(A.data[i]!)) {
      throw new ConeError(`buildHSDE: A contains a non-finite entry at flat index ${i}`);
    }
  }
  for (let i = 0; i < m; i++) {
    if (!Number.isFinite(b[i]!)) throw new ConeError(`buildHSDE: b[${i}] is non-finite`);
  }
  for (let i = 0; i < n; i++) {
    if (!Number.isFinite(c[i]!)) throw new ConeError(`buildHSDE: c[${i}] is non-finite`);
  }

  return { n, m, N: n + m + 1, A, b, c, cones };
}

/**
 * Materialise the dense skew-symmetric embedding matrix `Q` (eq 7),
 * `N × N` with `N = n + m + 1`. The SCS iteration never needs this — it
 * is here for tests (the skew-symmetry invariant `Qᵀ = −Q` is a one-line
 * check once `Q` is in hand) and for diagnostics.
 *
 *     Q = ⎡ 0    Aᵀ   c⎤
 *         ⎢−A    0    b⎥
 *         ⎣−cᵀ  −bᵀ   0⎦
 */
export function assembleQ(hsde: HSDEMatrix): Matrix {
  const { n, m, N, A, b, c } = hsde;
  const Q = matZeros(N, N);
  const tauCol = n + m;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < m; j++) {
      const a = A.data[j * n + i]!; // A[j][i]
      set(Q, i, n + j, a); //  Aᵀ block
      set(Q, n + j, i, -a); // −A block
    }
    set(Q, i, tauCol, c[i]!); //  c column
    set(Q, tauCol, i, -c[i]!); // −cᵀ row
  }
  for (let j = 0; j < m; j++) {
    set(Q, n + j, tauCol, b[j]!); //  b column
    set(Q, tauCol, n + j, -b[j]!); // −bᵀ row
  }
  return Q;
}

// -----------------------------------------------------------------------------
// recoverPrimalDual — the §3.5 evaluator
// -----------------------------------------------------------------------------

/**
 * Convergence tolerances for `recoverPrimalDual`. ADR-0030 drives all of
 * these from the single user-facing `precision` knob; this struct is the
 * derived triple-plus-two that the §3.5 termination test actually reads.
 */
/**
 * Diagonal data-scaling for the SCS problem (O'Donoghue 2016 §5). `D`
 * scales the constraint rows, `E` the variable columns: the scaled
 * problem is `Â = D A E`, `b̂ = D b`, `ĉ = E c` (the paper's scalar `σ`,
 * `ρ` folded into `D`, `E`). For the LP-complete cone subset every
 * positive diagonal `D` preserves cone membership (the nonneg / zero /
 * free cones are closed under positive componentwise scaling), so `D` is
 * an unconstrained positive diagonal here. Equilibration computes it
 * (`scaling.ts`); `recoverPrimalDual` consumes it to map a scaled
 * embedding iterate back to the *original* problem's coordinates.
 */
export interface Scaling {
  /** Row scaling — length `m` (constraint rows). `y = D ⊙ ŷ`, `s = ŝ ⊘ D`. */
  readonly D: Float64Array;
  /** Column scaling — length `n` (variable columns). `x = E ⊙ x̂`. */
  readonly E: Float64Array;
}

export interface Tolerances {
  /** Primal-residual tolerance `ε_pri`. */
  readonly epsPri: number;
  /** Dual-residual tolerance `ε_dual`. */
  readonly epsDual: number;
  /** Duality-gap tolerance `ε_gap`. */
  readonly epsGap: number;
  /** Unboundedness-certificate tolerance `ε_unbdd`. */
  readonly epsUnbdd: number;
  /** Infeasibility-certificate tolerance `ε_infeas`. */
  readonly epsInfeas: number;
}

/**
 * The candidate primal–dual point read off an embedding iterate, plus the
 * three residual quantities the §3.5 test gates on. Present whenever
 * `u_τ > 0` (the homogeneity division is well defined); absent otherwise.
 */
export interface Candidate {
  /** Primal variable `x = u_x / u_τ`. */
  readonly x: Float64Array;
  /** Dual variable `y = u_y / u_τ`. */
  readonly y: Float64Array;
  /** Primal slack `s = v_s / u_τ`. */
  readonly s: Float64Array;
  /** Objective value `cᵀx`. */
  readonly objective: number;
  /** `‖A x + s − b‖₂` — the primal residual norm. */
  readonly primalResidual: number;
  /** `‖Aᵀ y + c‖₂` — the dual residual norm. */
  readonly dualResidual: number;
  /** `cᵀx + bᵀy` — the duality gap. */
  readonly gap: number;
}

/**
 * What an embedding point means. `recoverPrimalDual` returns exactly one
 * of these per call; `scsSolve` loops until it is not `inconclusive`.
 */
export type Recovered =
  | ({ readonly kind: "optimal" } & Candidate)
  | {
      /** Primal infeasible: `certificate` is a `y` with `Aᵀy ≈ 0`, `y ∈ 𝒦*`, `bᵀy = −1`. */
      readonly kind: "primal-infeasible";
      readonly certificate: Float64Array;
    }
  | {
      /** Dual infeasible (primal unbounded): `certificate` is an `x` with `−Ax ∈ 𝒦`, `cᵀx = −1`. */
      readonly kind: "dual-infeasible";
      readonly certificate: Float64Array;
    }
  | {
      /** No branch fired this iterate. `candidate` is the best-effort read-off if `u_τ > 0`. */
      readonly kind: "inconclusive";
      readonly candidate?: Candidate;
    };

/**
 * Read a primal–dual solution or an infeasibility certificate out of an
 * embedding iterate `(u, v)`. This is the §3.5 termination evaluator
 * (O'Donoghue 2016 p. 1054–1055), factored out as a pure function so the
 * iteration in `scs.ts` is just a loop around it — and so the whole
 * termination taxonomy is testable on hand-built `(u, v)` pairs.
 *
 * The three branches, checked in the paper's order:
 *
 *  1. **optimal** — requires `u_τ > 0`. Form `x = u_x/u_τ`, `y = u_y/u_τ`,
 *     `s = v_s/u_τ`; this candidate satisfies the cone constraints and
 *     complementary slackness *by construction* of the iteration, so only
 *     the three linear residuals remain to check:
 *
 *         ‖A x + s − b‖₂ ≤ ε_pri  · (1 + ‖b‖₂)
 *         ‖Aᵀ y + c‖₂   ≤ ε_dual · (1 + ‖c‖₂)
 *         |cᵀx + bᵀy|    ≤ ε_gap  · (1 + |cᵀx| + |bᵀy|)
 *
 *  2. **dual-infeasible** (the original primal is unbounded) — uses the
 *     *raw* `u_x` (no τ division; the certificate is a direction):
 *
 *         cᵀu_x < 0   and   ‖A u_x + v_s‖₂ ≤ (−cᵀu_x / ‖c‖₂) · ε_unbdd
 *
 *     then `u_x / (−cᵀu_x)` is the unboundedness certificate.
 *
 *  3. **primal-infeasible** — uses the raw `u_y`:
 *
 *         bᵀu_y < 0   and   ‖Aᵀ u_y‖₂ ≤ (−bᵀu_y / ‖b‖₂) · ε_infeas
 *
 *     then `u_y / (−bᵀu_y)` is the infeasibility certificate.
 *
 * If `‖c‖₂` (resp. `‖b‖₂`) is zero the corresponding certificate test is
 * skipped — its right-hand side would divide by zero, and a zero `c`
 * (resp. `b`) cannot produce that kind of certificate anyway.
 *
 * **Scaling.** When `scaling` is supplied, `(u, v)` are an embedding
 * iterate of the *scaled* problem `Â = D A E`, but `hsde` is the
 * *original* problem and the returned `(x, y, s)` / certificates are in
 * the *original* coordinates: the raw embedding components are unscaled
 * (`xRaw = E ⊙ u_x`, `yRaw = D ⊙ u_y`, `sRaw = v_s ⊘ D`) before the §3.5
 * residual test runs against the original data. This is the paper's
 * "Scaled Termination Criteria" (§5, p. 1058): the iteration runs in the
 * better-conditioned scaled space, but convergence is judged on the
 * original residuals. Without `scaling`, `(u, v)` and `hsde` are the same
 * (unscaled) problem and the raw components are the subarrays as-is.
 *
 * `u` and `v` must both have length `hsde.N`.
 */
export function recoverPrimalDual(
  u: Float64Array,
  v: Float64Array,
  hsde: HSDEMatrix,
  tol: Tolerances,
  scaling?: Scaling,
): Recovered {
  const { n, m, N, A, b, c } = hsde;
  if (u.length !== N || v.length !== N) {
    throw new ConeError(
      `recoverPrimalDual: u/v length ${u.length}/${v.length} ≠ embedding dimension N=${N}`,
    );
  }

  const uX = u.subarray(0, n);
  const uY = u.subarray(n, n + m);
  const uTau = u[n + m]!;
  const vS = v.subarray(n, n + m);

  // Unscale the raw (un-τ-divided) embedding components to the original
  // problem's coordinates. With no scaling these are the subarrays
  // verbatim; with scaling, `Â = D A E` ⟹ `x = E ⊙ x̂`, `y = D ⊙ ŷ`,
  // `s = ŝ ⊘ D`. Everything below uses `xRaw / yRaw / sRaw` and the
  // *original* `A, b, c`, so the §3.5 test is on the original residuals.
  let xRaw: Float64Array;
  let yRaw: Float64Array;
  let sRaw: Float64Array;
  if (scaling === undefined) {
    xRaw = uX;
    yRaw = uY;
    sRaw = vS;
  } else {
    xRaw = new Float64Array(n);
    for (let j = 0; j < n; j++) xRaw[j] = scaling.E[j]! * uX[j]!;
    yRaw = new Float64Array(m);
    for (let i = 0; i < m; i++) yRaw[i] = scaling.D[i]! * uY[i]!;
    sRaw = new Float64Array(m);
    for (let i = 0; i < m; i++) sRaw[i] = vS[i]! / scaling.D[i]!;
  }

  const bNorm = norm2(b);
  const cNorm = norm2(c);

  // ── branch 1: optimal ────────────────────────────────────────────────────
  // Only meaningful when the homogenisation scalar τ is strictly positive;
  // a non-positive τ means no scaled primal–dual point can be read off.
  let candidate: Candidate | undefined;
  if (uTau > 0) {
    const x = new Float64Array(n);
    for (let i = 0; i < n; i++) x[i] = xRaw[i]! / uTau;
    const y = new Float64Array(m);
    for (let i = 0; i < m; i++) y[i] = yRaw[i]! / uTau;
    const s = new Float64Array(m);
    for (let i = 0; i < m; i++) s[i] = sRaw[i]! / uTau;

    // primal residual  p = A x + s − b
    const Ax = matVecLocal(A, x);
    const p = new Float64Array(m);
    for (let i = 0; i < m; i++) p[i] = Ax[i]! + s[i]! - b[i]!;
    // dual residual  d = Aᵀ y + c
    const Aty = matTransposeVec(A, y);
    const d = new Float64Array(n);
    for (let i = 0; i < n; i++) d[i] = Aty[i]! + c[i]!;

    const cTx = dot(c, x);
    const bTy = dot(b, y);
    const gap = cTx + bTy;

    candidate = {
      x,
      y,
      s,
      objective: cTx,
      primalResidual: norm2(p),
      dualResidual: norm2(d),
      gap,
    };

    const primalOk = candidate.primalResidual <= tol.epsPri * (1 + bNorm);
    const dualOk = candidate.dualResidual <= tol.epsDual * (1 + cNorm);
    const gapOk = Math.abs(gap) <= tol.epsGap * (1 + Math.abs(cTx) + Math.abs(bTy));
    if (primalOk && dualOk && gapOk) {
      return { kind: "optimal", ...candidate };
    }
  }

  // ── branch 2: dual-infeasible (primal unbounded) ─────────────────────────
  // Direction certificate, built from the raw (unscaled) u_x — no τ
  // division; the certificate is a direction.
  if (cNorm > 0) {
    const cTxRaw = dot(c, xRaw);
    if (cTxRaw < 0) {
      // residual  A xRaw + sRaw  (in the original coordinates)
      const AxRaw = matVecLocal(A, xRaw);
      const res = new Float64Array(m);
      for (let i = 0; i < m; i++) res[i] = AxRaw[i]! + sRaw[i]!;
      if (norm2(res) <= (-cTxRaw / cNorm) * tol.epsUnbdd) {
        const certificate = new Float64Array(n);
        const scale = -cTxRaw; // > 0
        for (let i = 0; i < n; i++) certificate[i] = xRaw[i]! / scale;
        return { kind: "dual-infeasible", certificate };
      }
    }
  }

  // ── branch 3: primal-infeasible ──────────────────────────────────────────
  if (bNorm > 0) {
    const bTyRaw = dot(b, yRaw);
    if (bTyRaw < 0) {
      const AtyRaw = matTransposeVec(A, yRaw);
      if (norm2(AtyRaw) <= (-bTyRaw / bNorm) * tol.epsInfeas) {
        const certificate = new Float64Array(m);
        const scale = -bTyRaw; // > 0
        for (let i = 0; i < m; i++) certificate[i] = yRaw[i]! / scale;
        return { kind: "primal-infeasible", certificate };
      }
    }
  }

  // ── no branch fired ──────────────────────────────────────────────────────
  return candidate === undefined ? { kind: "inconclusive" } : { kind: "inconclusive", candidate };
}

/**
 * `A x` for a `Matrix` and a `Float64Array` — a local copy of
 * `linalg-core`'s `matVec` that accepts a `subarray` view (whose
 * `.length` linalg-core's own bounds check would still accept, but
 * keeping it local keeps the import surface to just `Matrix` + LU).
 */
function matVecLocal(A: Matrix, x: Float64Array): Float64Array {
  if (x.length !== A.cols) {
    throw new ConeError(`matVec: vector length ${x.length} ≠ matrix cols ${A.cols}`);
  }
  const out = new Float64Array(A.rows);
  for (let i = 0; i < A.rows; i++) {
    let acc = 0;
    const base = i * A.cols;
    for (let j = 0; j < A.cols; j++) acc += A.data[base + j]! * x[j]!;
    out[i] = acc;
  }
  return out;
}
