// Public status taxonomy mapping: solver-ipm's natural SolverStatus →
// the ADR-0030 §A.3 wire taxonomy (the public surface every cone-
// solver tool emits). Lossy by design: the IPM tracks more internal
// states than the wire vocabulary needs to expose.
//
// Reused by:
// - tools/lp-solve  (encodes the lane's result onto the wire)
// - packages/solver-ipm/test/*  (compares lane output against the
//   corpus's `expected.status` field, which is in wire vocabulary)
//
// Keep this in sync with ADR-0030 §A.3 if the public taxonomy ever
// extends.

import type { SolverStatus } from "./Iterate.js";

export type WireStatus =
  | "optimal"
  | "infeasible"
  | "unbounded"
  | "iter-cap"
  | "numerical-breakdown";

export function toWireStatus(s: SolverStatus): WireStatus {
  switch (s) {
    case "optimal":
      return "optimal";
    case "primal-infeasible":
      return "infeasible";
    case "dual-infeasible":
      return "unbounded";
    case "iter-limit":
    case "time-limit":
      return "iter-cap";
    case "running":
    case "dual-feasible":
    case "numerical-difficulty":
    case "user-interrupt":
    case "numerical-error":
    case "out-of-memory":
    default:
      return "numerical-breakdown";
  }
}
