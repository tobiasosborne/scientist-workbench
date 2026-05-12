// Canonical SCS form (ADR-0030 §C): min c^T x s.t. Ax = b, x ∈ K.
// This is the wire format every workbench LP/cone solver consumes.

export type NonNegConeBlock = {
  head: "NonNegCone";
  indices?: readonly number[];
  size?: number;
};
export type PsdConeBlock = {
  head: "PsdCone";
  indices?: readonly number[];
  size?: number;
};
export type ConeBlock = NonNegConeBlock | PsdConeBlock;

export interface CanonicalLp {
  minimize: { c: readonly number[] };
  subjectTo: {
    Ax_eq_b?: {
      A: readonly (readonly number[])[];
      b: readonly number[];
    };
    cones: readonly ConeBlock[];
  };
  precision: number;
  max_iter?: number;
}

export type SolveStatus =
  | "optimal"
  | "infeasible"
  | "unbounded"
  | "iter-cap"
  | "numerical-breakdown";

export interface SolveSuccess {
  status: SolveStatus;
  x: number[];
  dual: number[];
  slack: number[];
  iterations: number;
  method: string;
  condition_estimate: number;
  warnings: string[];
  objective?: number;
  achieved_precision?: number;
}
