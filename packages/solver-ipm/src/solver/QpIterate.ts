// Mutable iterate state for the convex-QP primal-dual interior-point
// method. The QP analogue of `Iterate` (LP): it carries the current
// point (x, y, s), residuals (rp, rd, rc), step (dx, dy, ds), the
// affine-step snapshots the corrector needs, and — the QP-specific
// part — the augmented quasidefinite KKT matrix `K0` with its factored
// copy `Kfac`, plus the signed primal/dual regularization state.
//
// Allocation-free discipline (mirrors `Iterate`): every buffer is sized
// once at `makeQpIterate` and reused across iterations; the inner loops
// never allocate. `N = n + m` is the augmented dimension.

import type { SolverStatus } from "./Iterate.js";

export interface QpIterate {
  m: number;
  n: number;
  /** Augmented dimension `n + m`. */
  N: number;

  x: Float64Array; // length n
  y: Float64Array; // length m
  s: Float64Array; // length n

  rp: Float64Array; // length m   primal residual Ax − b
  rd: Float64Array; // length n   dual residual Qx + c − Aᵀy − s
  rc: Float64Array; // length n   complementarity RHS

  dx: Float64Array; // length n
  dy: Float64Array; // length m
  ds: Float64Array; // length n

  dxAff: Float64Array; // length n   predictor snapshots (corrector reuses)
  dsAff: Float64Array; // length n

  /** Static augmented KKT pattern `[ −(Q+X⁻¹S)−ρI, Aᵀ; A, +δI ]`, row-major N×N.
   *  Q, A, ±base-reg are filled once; only the n x-block diagonals change per iter. */
  K0: Float64Array; // N*N
  /** Working copy of K0 that `signedLdltInPlace` overwrites with its factor. */
  Kfac: Float64Array; // N*N
  /** Length-N scratch row for the factorization, and a length-N RHS buffer. */
  ldltTmp: Float64Array; // N
  u: Float64Array; // N   augmented RHS (preserved across the IR loop)
  /** Iterative-refinement scratch (length N each): the refined solution
   *  `dv`, the residual `irRes = u − K0·dv`, and the trial correction. */
  dv: Float64Array; // N
  irRes: Float64Array; // N
  irCorr: Float64Array; // N

  mu: number;
  primalObj: number;
  dualObj: number;
  primalInf: number;
  dualInf: number;
  gap: number;
  iter: number;

  /** Base proximal levels (ρ0, δ0), carried into K0 and the IR target. */
  rho0: number;
  delta0: number;
  /** Escalation levels added on factorization failure (signed: −ρ on x, +δ on y). */
  rhoE: number;
  deltaE: number;
  bumpsRho: number;
  bumpsDelta: number;
  refactors: number;

  stallCount: number;
  status: SolverStatus;
  startMs: number;
}

export function makeQpIterate(m: number, n: number): QpIterate {
  const N = n + m;
  return {
    m,
    n,
    N,
    x: new Float64Array(n),
    y: new Float64Array(m),
    s: new Float64Array(n),
    rp: new Float64Array(m),
    rd: new Float64Array(n),
    rc: new Float64Array(n),
    dx: new Float64Array(n),
    dy: new Float64Array(m),
    ds: new Float64Array(n),
    dxAff: new Float64Array(n),
    dsAff: new Float64Array(n),
    K0: new Float64Array(N * N),
    Kfac: new Float64Array(N * N),
    ldltTmp: new Float64Array(N),
    u: new Float64Array(N),
    dv: new Float64Array(N),
    irRes: new Float64Array(N),
    irCorr: new Float64Array(N),
    mu: 0,
    primalObj: 0,
    dualObj: 0,
    primalInf: 0,
    dualInf: 0,
    gap: 0,
    iter: 0,
    rho0: 0,
    delta0: 0,
    rhoE: 0,
    deltaE: 0,
    bumpsRho: 0,
    bumpsDelta: 0,
    refactors: 0,
    stallCount: 0,
    status: "running",
    startMs: 0,
  };
}
