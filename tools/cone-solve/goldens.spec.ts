// =============================================================================
// cone-solve goldens
// =============================================================================
//
// One golden per representative case in the v0.1 input surface. The
// cases below exercise *every code path* in the tool — happy-path optima
// (1-D / 2-D / 3-D, with a free variable, with an equality-via-zero-cone),
// the infeasible and unbounded status branches, and each refusal
// envelope (unsupported cone, quadratic objective, malformed cone,
// non-finite input, degenerate shape).
//
// The corpus's `lp-netlib` and `lp-small` suites carry the algorithmic
// stress (NETLIB classics graded against the Gurobi/Mosek triple-witness);
// this file pins the *tool's own bytes* so a future run that drifts
// byte-for-byte fails the oracle phase. `cone-solve` is `numerical: true`
// (ADR-0015) — bit-identical given the platform fingerprint — so the
// goldens are a hard equality, not a tolerance.

import { expr, float64FromNumber, int, list, record } from "@workbench/protocol";
import type { GoldenSpec } from "@workbench/contract";

function f(x: number) {
  return float64FromNumber(x);
}
function vecF(xs: number[]) {
  return list(xs.map(f));
}
function matF(rows: number[][]) {
  return list(rows.map((r) => vecF(r)));
}
function cone(head: string, indices: number[]) {
  return expr(head, [list(indices.map((i) => int(BigInt(i))))]);
}

export const goldens: GoldenSpec[] = [
  {
    description: "trivial-1d: min x s.t. x = 1, x ≥ 0 — optimum x = 1",
    input: record({
      minimize: record({ c: vecF([1]) }),
      subjectTo: record({
        Ax_eq_b: record({ A: matF([[1]]), b: vecF([1]) }),
        cones: list([cone("NonNegCone", [0])]),
      }),
    }),
  },
  {
    description: "trivial-2d: min x + 2y s.t. x + y = 3, x, y ≥ 0 — optimum (3, 0)",
    input: record({
      minimize: record({ c: vecF([1, 2]) }),
      subjectTo: record({
        Ax_eq_b: record({ A: matF([[1, 1]]), b: vecF([3]) }),
        cones: list([cone("NonNegCone", [0, 1])]),
      }),
    }),
  },
  {
    description: "3-var, 2-equality: min x+y+z s.t. x+2y=4, x+y=3, x,y,z ≥ 0",
    input: record({
      minimize: record({ c: vecF([1, 1, 1]) }),
      subjectTo: record({
        Ax_eq_b: record({
          A: matF([
            [1, 2, 0],
            [1, 1, 0],
          ]),
          b: vecF([4, 3]),
        }),
        cones: list([cone("NonNegCone", [0, 1, 2])]),
      }),
    }),
  },
  {
    description: "rational interior: min 3x + 5y s.t. 2x+y=1, x+2y=1, x,y ≥ 0 — x = y = 1/3",
    input: record({
      minimize: record({ c: vecF([3, 5]) }),
      subjectTo: record({
        Ax_eq_b: record({
          A: matF([
            [2, 1],
            [1, 2],
          ]),
          b: vecF([1, 1]),
        }),
        cones: list([cone("NonNegCone", [0, 1])]),
      }),
    }),
  },
  {
    description: "free variable: min x − y s.t. x + y = 1, x ≥ 0, y free (FreeCone)",
    input: record({
      minimize: record({ c: vecF([1, -1]) }),
      subjectTo: record({
        Ax_eq_b: record({ A: matF([[1, 1]]), b: vecF([1]) }),
        cones: list([cone("NonNegCone", [0]), cone("FreeCone", [1])]),
      }),
    }),
  },
  {
    description: "equality via the zero cone: min x s.t. x + y = 5, x ≥ 0, y = 0 (ZeroCone)",
    // The ZeroCone pins variable 1 to zero through the cone block, so the
    // equality `x + y = 5` forces `x = 5`. Exercises the ZeroCone branch
    // of `parseCones` and the mixed zero+nonneg cone product.
    input: record({
      minimize: record({ c: vecF([1, 0]) }),
      subjectTo: record({
        Ax_eq_b: record({ A: matF([[1, 1]]), b: vecF([5]) }),
        cones: list([cone("NonNegCone", [0]), cone("ZeroCone", [1])]),
      }),
    }),
  },
  {
    description: "infeasible: x = 1 ∧ x = 2 simultaneously — Farkas certificate in `dual`",
    input: record({
      minimize: record({ c: vecF([0]) }),
      subjectTo: record({
        Ax_eq_b: record({ A: matF([[1], [1]]), b: vecF([1, 2]) }),
        cones: list([cone("NonNegCone", [0])]),
      }),
    }),
  },
  {
    description: "unbounded: min −x s.t. y = 1, x, y ≥ 0 — x unbounded above, ray in `x`",
    input: record({
      minimize: record({ c: vecF([-1, 0]) }),
      subjectTo: record({
        Ax_eq_b: record({ A: matF([[0, 1]]), b: vecF([1]) }),
        cones: list([cone("NonNegCone", [0, 1])]),
      }),
    }),
  },
  {
    description: "refusal: a second-order cone is outside the v0.1 LP-complete scope",
    input: record({
      minimize: record({ c: vecF([1, 0, 0]) }),
      subjectTo: record({ cones: list([cone("SOCone", [0, 1, 2])]) }),
    }),
  },
  {
    description: "refusal: an exponential cone is outside the v0.1 LP-complete scope",
    input: record({
      minimize: record({ c: vecF([1, 0, 0]) }),
      subjectTo: record({ cones: list([cone("ExpCone", [0, 1, 2])]) }),
    }),
  },
  {
    description: "refusal: a quadratic objective is deferred (ADR-0030 open-question 3)",
    input: record({
      minimize: record({ c: vecF([1]), Q: matF([[2]]) }),
      subjectTo: record({
        Ax_eq_b: record({ A: matF([[1]]), b: vecF([1]) }),
        cones: list([cone("NonNegCone", [0])]),
      }),
    }),
  },
  {
    description: "refusal: a malformed cone — index out of range",
    input: record({
      minimize: record({ c: vecF([1]) }),
      subjectTo: record({
        Ax_eq_b: record({ A: matF([[1]]), b: vecF([1]) }),
        cones: list([cone("NonNegCone", [5])]),
      }),
    }),
  },
  {
    description: "refusal: non-finite input — a NaN smuggled into b",
    input: record({
      minimize: record({ c: vecF([1]) }),
      subjectTo: record({
        Ax_eq_b: record({ A: matF([[1]]), b: vecF([Number.NaN]) }),
        cones: list([cone("NonNegCone", [0])]),
      }),
    }),
  },
  {
    description: "refusal: degenerate shape — A has 2 rows but b has 1 entry",
    input: record({
      minimize: record({ c: vecF([1]) }),
      subjectTo: record({
        Ax_eq_b: record({ A: matF([[1], [1]]), b: vecF([1]) }),
        cones: list([cone("NonNegCone", [0])]),
      }),
    }),
  },
];
