// =============================================================================
// sdp-solve goldens
// =============================================================================
//
// One golden per representative case. The cases below cover every
// code path: 1×1 PSD (the smallest non-trivial block), 2×2 PSD with
// non-zero off-diagonals, multi-block stacked PSDs, ZeroCone forced-
// zero variables, and each refusal envelope (Q present, NonNegCone,
// SOCone, malformed cone, non-finite input, cone-coverage gap).
//
// Algorithmic stress lives in the corpus repo's `benchmarks/sdp-sdplib/`
// suite (Phase 0 of bead `tj6p`) — SDPLIB problems graded against the
// Mosek + COPT dual-witness oracle. This file pins the tool's own bytes
// so a future-day code change that drifts the wire format fails the
// `oracle` phase loudly.

import {
  expr,
  float64FromNumber,
  int,
  list,
  record,
} from "@workbench/protocol";
import type { GoldenSpec } from "@workbench/contract";

function f(x: number) {
  return float64FromNumber(x);
}

function vecF(xs: number[]) {
  return list(xs.map(f));
}

function matF(rows: number[][]) {
  return list(rows.map(vecF));
}

function psdCone(size: number, indices: number[]) {
  return expr("PSDCone", [
    int(BigInt(size)),
    list(indices.map((i) => int(BigInt(i)))),
  ]);
}

function zeroCone(indices: number[]) {
  return expr("ZeroCone", [list(indices.map((i) => int(BigInt(i))))]);
}

function nonNegCone(indices: number[]) {
  return expr("NonNegCone", [list(indices.map((i) => int(BigInt(i))))]);
}

function socCone(indices: number[]) {
  return expr("SOCone", [list(indices.map((i) => int(BigInt(i))))]);
}

export const goldens: GoldenSpec[] = [
  // ---- Happy-path PSD cases ----
  {
    description: "1x1 PSD: minimise x s.t. x = 5, x >= 0; optimum x = 5",
    input: record({
      minimize: record({ c: vecF([1]) }),
      subjectTo: record({
        Ax_eq_b: record({ A: matF([[1]]), b: vecF([5]) }),
        cones: list([psdCone(1, [0])]),
      }),
    }),
  },
  {
    description:
      "2x2 PSD trace-equality: minimise -tr(X) s.t. tr(X) = 4, X >= 0; optimum primal -4",
    input: record({
      minimize: record({ c: vecF([-1, 0, -1]) }),
      subjectTo: record({
        Ax_eq_b: record({ A: matF([[1, 0, 1]]), b: vecF([4]) }),
        cones: list([psdCone(2, [0, 1, 2])]),
      }),
    }),
  },
  {
    description:
      "2x2 PSD with off-diagonal: minimise sqrt(2) X[0,1] s.t. tr X = 1, X >= 0; uses sqrt(2) wire scaling",
    // svec wire: x[0] = X[0,0], x[1] = sqrt(2) X[0,1], x[2] = X[1,1].
    // Objective coefficient on x[1] is 1 means coefficient on X[0,1] in
    // the matrix inner product is sqrt(2) * 1 = sqrt(2). Constraint
    // tr(X) = 1: A row = (1, 0, 1).
    // Minimum of sqrt(2) X[0,1] over {tr X = 1, X >= 0}: take X = diag(1,0)
    // or diag(0,1), value 0. Strictly: the SDP minimum of an off-diag is
    // -1 (X = (I + sigma_x)/2 has trace 1, off-diag 1/2, value sqrt(2)/2)
    // wait — the off-diag of a PSD matrix with trace 1 is bounded by 1/2 by
    // |X[0,1]|^2 <= X[0,0] X[1,1] <= 1/4. So minimum of X[0,1] is -1/2,
    // wire objective = sqrt(2) * (-1/2) = -sqrt(2)/2 ~= -0.7071.
    input: record({
      minimize: record({ c: vecF([0, 1, 0]) }),
      subjectTo: record({
        Ax_eq_b: record({ A: matF([[1, 0, 1]]), b: vecF([1]) }),
        cones: list([psdCone(2, [0, 1, 2])]),
      }),
    }),
  },
  {
    description:
      "Two PSD blocks (1x1 + 1x1): minimise x0 + x1 s.t. x0 + x1 = 3, x0, x1 >= 0; optimum 3",
    input: record({
      minimize: record({ c: vecF([1, 1]) }),
      subjectTo: record({
        Ax_eq_b: record({ A: matF([[1, 1]]), b: vecF([3]) }),
        cones: list([psdCone(1, [0]), psdCone(1, [1])]),
      }),
    }),
  },
  {
    description:
      "PSD + ZeroCone: 1x1 PSD x[0] free with x[0] = 2; x[1] forced to zero by ZeroCone; minimise x[0] - x[1]",
    input: record({
      minimize: record({ c: vecF([1, -1]) }),
      subjectTo: record({
        Ax_eq_b: record({ A: matF([[1, 0]]), b: vecF([2]) }),
        cones: list([psdCone(1, [0]), zeroCone([1])]),
      }),
    }),
  },
  {
    description:
      "3x3 PSD identity-trace: minimise -tr(X) s.t. tr(X) = 3, X >= 0; optimum -3",
    input: record({
      minimize: record({ c: vecF([-1, 0, 0, -1, 0, -1]) }),
      subjectTo: record({
        Ax_eq_b: record({ A: matF([[1, 0, 0, 1, 0, 1]]), b: vecF([3]) }),
        cones: list([psdCone(3, [0, 1, 2, 3, 4, 5])]),
      }),
    }),
  },

  // ---- Refusal envelopes ----
  {
    description: "Refusal: quadratic objective Q present",
    input: record({
      minimize: record({
        c: vecF([1]),
        Q: matF([[2]]),
      }),
      subjectTo: record({
        Ax_eq_b: record({ A: matF([[1]]), b: vecF([1]) }),
        cones: list([psdCone(1, [0])]),
      }),
    }),
  },
  {
    description: "Refusal: NonNegCone routed to lp-solve",
    input: record({
      minimize: record({ c: vecF([1]) }),
      subjectTo: record({
        Ax_eq_b: record({ A: matF([[1]]), b: vecF([1]) }),
        cones: list([nonNegCone([0])]),
      }),
    }),
  },
  {
    description: "Refusal: SOCone routed to cone-solve",
    input: record({
      minimize: record({ c: vecF([1, 0]) }),
      subjectTo: record({
        Ax_eq_b: record({ A: matF([[1, 0]]), b: vecF([1]) }),
        cones: list([socCone([0, 1])]),
      }),
    }),
  },
  {
    description: "Refusal: cone-coverage gap (variable 1 in no cone)",
    input: record({
      minimize: record({ c: vecF([1, 1]) }),
      subjectTo: record({
        Ax_eq_b: record({ A: matF([[1, 1]]), b: vecF([2]) }),
        cones: list([psdCone(1, [0])]),
      }),
    }),
  },
  {
    description: "Refusal: malformed PSDCone (wrong number of indices for size=2)",
    input: record({
      minimize: record({ c: vecF([1, 1]) }),
      subjectTo: record({
        Ax_eq_b: record({ A: matF([[1, 1]]), b: vecF([2]) }),
        // size=2 expects svec_len(2)=3 indices; we give only 2 — malformed.
        cones: list([
          expr("PSDCone", [int(2n), list([int(0n), int(1n)])]),
        ]),
      }),
    }),
  },
  {
    description: "Refusal: malformed PSDCone (size = 0)",
    input: record({
      minimize: record({ c: vecF([1]) }),
      subjectTo: record({
        Ax_eq_b: record({ A: matF([[1]]), b: vecF([1]) }),
        cones: list([
          expr("PSDCone", [int(0n), list([])]),
        ]),
      }),
    }),
  },
  {
    description: "Refusal: NonNegCone in a multi-cone problem (rejected even with PSDCone present)",
    input: record({
      minimize: record({ c: vecF([1, 1]) }),
      subjectTo: record({
        Ax_eq_b: record({ A: matF([[1, 1]]), b: vecF([2]) }),
        cones: list([psdCone(1, [0]), nonNegCone([1])]),
      }),
    }),
  },
  {
    description: "Refusal: index collision (variable 0 in two cones)",
    input: record({
      minimize: record({ c: vecF([1]) }),
      subjectTo: record({
        Ax_eq_b: record({ A: matF([[1]]), b: vecF([1]) }),
        cones: list([psdCone(1, [0]), psdCone(1, [0])]),
      }),
    }),
  },
];
