// =============================================================================
// lp-solve goldens
// =============================================================================
//
// One golden per representative case in the v0.1 input surface. The
// cases below were chosen to exercise *every code path* in the tool —
// happy-path optimum (1D / 2D / 3D), degenerate constraint, infeasible,
// unbounded, free variables, and each refusal envelope. The corpus's
// `lp-netlib` and `lp-small` suites cover the algorithmic stress; this
// file pins the tool's own bytes so future runs that drift byte-for-
// byte fail the oracle phase.

import {
  expr,
  float64FromNumber,
  int,
  list,
  record,
} from "@workbench/protocol";
import type { GoldenSpec } from "@workbench/contract";

function nnCone(indices: number[]) {
  return expr("NonNegCone", [list(indices.map((i) => int(BigInt(i))))]);
}

function f(x: number) {
  return float64FromNumber(x);
}

function vecF(xs: number[]) {
  return list(xs.map(f));
}

function matF(rows: number[][]) {
  return list(rows.map((r) => vecF(r)));
}

export const goldens: GoldenSpec[] = [
  {
    description: "trivial-1d: min x s.t. x = 1, x >= 0",
    input: record({
      minimize: record({ c: vecF([1]) }),
      subjectTo: record({
        Ax_eq_b: record({ A: matF([[1]]), b: vecF([1]) }),
        cones: list([nnCone([0])]),
      }),
    }),
  },
  {
    description: "trivial-2d: min 2x + 3y s.t. x + y = 5, x, y >= 0",
    input: record({
      minimize: record({ c: vecF([2, 3]) }),
      subjectTo: record({
        Ax_eq_b: record({ A: matF([[1, 1]]), b: vecF([5]) }),
        cones: list([nnCone([0, 1])]),
      }),
    }),
  },
  {
    description: "3-var, 2-equality: min x+y+z s.t. x+2y=4, x+y=3, x,y,z>=0",
    input: record({
      minimize: record({ c: vecF([1, 1, 1]) }),
      subjectTo: record({
        Ax_eq_b: record({ A: matF([[1, 2, 0], [1, 1, 0]]), b: vecF([4, 3]) }),
        cones: list([nnCone([0, 1, 2])]),
      }),
    }),
  },
  {
    description: "infeasible: x = 1 AND x = 2",
    input: record({
      minimize: record({ c: vecF([0]) }),
      subjectTo: record({
        Ax_eq_b: record({ A: matF([[1], [1]]), b: vecF([1, 2]) }),
        cones: list([nnCone([0])]),
      }),
    }),
  },
  {
    description: "unbounded: min -x with no upper bound on x",
    input: record({
      minimize: record({ c: vecF([-1, 0]) }),
      subjectTo: record({
        Ax_eq_b: record({ A: matF([[0, 1]]), b: vecF([1]) }),
        cones: list([nnCone([0, 1])]),
      }),
    }),
  },
  {
    description: "exact-rational interior: min 3x + 5y s.t. 2x + y = 1, x + 2y = 1, x,y >= 0",
    // Solution: x = y = 1/3, obj = 8/3 — exact rational.
    input: record({
      minimize: record({ c: vecF([3, 5]) }),
      subjectTo: record({
        Ax_eq_b: record({ A: matF([[2, 1], [1, 2]]), b: vecF([1, 1]) }),
        cones: list([nnCone([0, 1])]),
      }),
    }),
  },
  {
    description: "free variable: min x - y s.t. x + y = 1, x >= 0 (y free)",
    input: record({
      minimize: record({ c: vecF([1, -1]) }),
      subjectTo: record({
        Ax_eq_b: record({ A: matF([[1, 1]]), b: vecF([1]) }),
        cones: list([nnCone([0])]),
      }),
    }),
  },
  {
    description: "refusal: quadratic objective routed to lp-solve",
    input: record({
      minimize: record({
        c: vecF([1]),
        Q: matF([[2]]),
      }),
      subjectTo: record({
        Ax_eq_b: record({ A: matF([[1]]), b: vecF([1]) }),
        cones: list([nnCone([0])]),
      }),
    }),
  },
  {
    description: "refusal: non-LP cone (SOCone)",
    input: record({
      minimize: record({ c: vecF([1, 1]) }),
      subjectTo: record({
        Ax_eq_b: record({ A: matF([[1, 0]]), b: vecF([1]) }),
        cones: list([expr("SOCone", [list([int(0n), int(1n)])])]),
      }),
    }),
  },
  {
    description: "refusal: malformed cone (index out of range)",
    input: record({
      minimize: record({ c: vecF([1]) }),
      subjectTo: record({
        Ax_eq_b: record({ A: matF([[1]]), b: vecF([1]) }),
        cones: list([nnCone([5])]),
      }),
    }),
  },
  {
    description: "refusal: non-finite input (NaN in c)",
    input: record({
      minimize: record({ c: vecF([NaN]) }),
      subjectTo: record({
        Ax_eq_b: record({ A: matF([[1]]), b: vecF([1]) }),
        cones: list([nnCone([0])]),
      }),
    }),
  },
  {
    description: "refusal: degenerate shape (A row width != c length)",
    input: record({
      minimize: record({ c: vecF([1, 2]) }),
      subjectTo: record({
        Ax_eq_b: record({ A: matF([[1]]), b: vecF([1]) }),
        cones: list([nnCone([0, 1])]),
      }),
    }),
  },
];
