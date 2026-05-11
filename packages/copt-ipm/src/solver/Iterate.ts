// IPM iterate state. Mirrors the LP fields of COPT's barrier solver
// struct (FUN_00730590 + the workspace offsets in PD_IPM_DEEP.md).

export interface Iterate {
  m: number;
  n: number;
  x: Float64Array;
  y: Float64Array;
  s: Float64Array;
  rp: Float64Array;
  rd: Float64Array;
  rc: Float64Array;
  dx: Float64Array;
  dy: Float64Array;
  ds: Float64Array;
  M: Float64Array;
  Lchol: Float64Array;
  rhs: Float64Array;
  mu: number;
  primalObj: number;
  dualObj: number;
  primalInf: number;
  dualInf: number;
  gap: number;
  iter: number;
  jitterPrimal: number;
  jitterDual: number;
  jitterGap: number;
  bumpsPrimal: number;
  bumpsDual: number;
  bumpsGap: number;
  refactors: number;
  stallCount: number;
  status: SolverStatus;
  startMs: number;
}

export type SolverStatus =
  | "running"
  | "optimal"
  | "dual-feasible"
  | "primal-infeasible"
  | "dual-infeasible"
  | "numerical-difficulty"
  | "iter-limit"
  | "time-limit"
  | "user-interrupt"
  | "numerical-error"
  | "out-of-memory";

export function makeIterate(m: number, n: number): Iterate {
  return {
    m,
    n,
    x: new Float64Array(n),
    y: new Float64Array(m),
    s: new Float64Array(n),
    rp: new Float64Array(m),
    rd: new Float64Array(n),
    rc: new Float64Array(n),
    dx: new Float64Array(n),
    dy: new Float64Array(m),
    ds: new Float64Array(n),
    M: new Float64Array(m * m),
    Lchol: new Float64Array(m * m),
    rhs: new Float64Array(m),
    mu: 0,
    primalObj: 0,
    dualObj: 0,
    primalInf: 0,
    dualInf: 0,
    gap: 0,
    iter: 0,
    jitterPrimal: 0,
    jitterDual: 0,
    jitterGap: 0,
    bumpsPrimal: 0,
    bumpsDual: 0,
    bumpsGap: 0,
    refactors: 0,
    stallCount: 0,
    status: "running",
    startMs: 0,
  };
}
