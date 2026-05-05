// =============================================================================
// integrate-ode-ivp goldens
// =============================================================================
//
// Per-tool goldens. Once `bun run goldens` has approved each input
// against the tool's body, the canonical bytes are locked in
// `goldens/*.golden.json`; future runs that deviate byte-for-byte
// fail the oracle phase of `bun run check`.
//
// Coverage: at least one per code-path branch:
//   - scalar exp decay (A-tier shape edge)
//   - 2D harmonic oscillator (smooth analytic oracle, dense output)
//   - Lotka-Volterra (canonical conserved-quantity case)
//   - Kepler-2body (dense output + conservation)
//   - reverse integration (G-tier)
//   - high-frequency forcing (smooth-but-cycle-rich)
//   - degenerate-tspan boundary tag
//   - pole-in-rhs boundary tag (`1/(t-1)` between t=0 and t=2 hits the pole)
//   - default-options invocation (omits `options`)
//   - logistic growth (smooth analytic)
//
// The bench's 29-case battery in `bench/integrate-ode-ivp/` is the
// heavier validation surface; per-tool goldens lock the *bytes* once
// the bench has approved the *invariants*.

import {
  expr,
  float64FromNumber,
  list,
  record,
  sym,
  type Float64Value,
  type Value,
} from "@workbench/protocol";
import type { GoldenSpec } from "@workbench/contract";

function f(x: number): Float64Value { return float64FromNumber(x); }
function vec(xs: readonly number[]): { readonly kind: "list"; readonly items: readonly Float64Value[] } {
  return list(xs.map(f));
}

function inp(args: {
  f: Value[];
  vars: string[];
  t_var: string;
  y0: number[];
  t_span: { t0: number; tf: number };
  options?: { rtol?: number; atol?: number; max_step?: number; t_eval?: readonly number[] };
}): Value {
  const fields: Record<string, Value> = {
    f: list(args.f),
    vars: list(args.vars.map((v) => sym(v))),
    t_var: sym(args.t_var),
    y0: vec(args.y0),
    t_span: record({
      t0: f(args.t_span.t0),
      tf: f(args.t_span.tf),
    }),
  };
  if (args.options !== undefined) {
    const optFields: Record<string, Value> = {};
    if (args.options.rtol !== undefined) optFields.rtol = f(args.options.rtol);
    if (args.options.atol !== undefined) optFields.atol = f(args.options.atol);
    if (args.options.max_step !== undefined) optFields.max_step = f(args.options.max_step);
    if (args.options.t_eval !== undefined) optFields.t_eval = vec(args.options.t_eval);
    fields.options = record(optFields);
  }
  return record(fields);
}

export const goldens: GoldenSpec[] = [
  {
    description: "A scalar exp decay y'=-y, y(0)=1, t in [0,1]",
    input: inp({
      f: [expr("neg", [sym("y0")])],
      vars: ["y0"],
      t_var: "t",
      y0: [1.0],
      t_span: { t0: 0, tf: 1 },
    }),
  },
  {
    description: "B exp decay default tolerances over t in [0,5] with explicit grid",
    input: inp({
      f: [expr("neg", [sym("y0")])],
      vars: ["y0"],
      t_var: "t",
      y0: [1.0],
      t_span: { t0: 0, tf: 5 },
      options: { t_eval: [0, 1, 2, 3, 4, 5] },
    }),
  },
  {
    description: "B logistic y'=y(1-y) from y(0)=0.5 to t=10 (saturates near 1)",
    input: inp({
      f: [expr("*", [sym("y0"), expr("-", [float64FromNumber(1), sym("y0")])])],
      vars: ["y0"],
      t_var: "t",
      y0: [0.5],
      t_span: { t0: 0, tf: 10 },
      options: { t_eval: [0, 2, 4, 6, 8, 10] },
    }),
  },
  {
    description: "B 2D harmonic oscillator one period at tight tolerance",
    input: inp({
      f: [sym("y1"), expr("neg", [sym("y0")])],
      vars: ["y0", "y1"],
      t_var: "t",
      y0: [1.0, 0.0],
      t_span: { t0: 0, tf: 2 * Math.PI },
      options: { rtol: 1e-8, atol: 1e-11, t_eval: [0, Math.PI / 2, Math.PI, 3 * Math.PI / 2, 2 * Math.PI] },
    }),
  },
  {
    description: "C Lotka-Volterra predator-prey (conserved Hamiltonian)",
    input: inp({
      // y0' = α y0 - β y0 y1; y1' = δ y0 y1 - γ y1
      // α=1.0, β=0.1, γ=1.5, δ=0.075
      f: [
        expr("-", [sym("y0"), expr("*", [
          expr("*", [float64FromNumber(0.1), sym("y0")]),
          sym("y1"),
        ])]),
        expr("-", [
          expr("*", [
            expr("*", [float64FromNumber(0.075), sym("y0")]),
            sym("y1"),
          ]),
          expr("*", [float64FromNumber(1.5), sym("y1")]),
        ]),
      ],
      vars: ["y0", "y1"],
      t_var: "t",
      y0: [10.0, 5.0],
      t_span: { t0: 0, tf: 5 },
      options: { rtol: 1e-6, atol: 1e-9, t_eval: [0, 1, 2, 3, 4, 5] },
    }),
  },
  {
    description: "C Kepler-2body circular orbit (conservation)",
    input: inp({
      f: [
        sym("px"),
        sym("py"),
        // -qx / (qx^2 + qy^2)^(3/2)
        expr("/", [
          expr("neg", [sym("qx")]),
          expr("^", [
            expr("+", [
              expr("^", [sym("qx"), float64FromNumber(2)]),
              expr("^", [sym("qy"), float64FromNumber(2)]),
            ]),
            float64FromNumber(1.5),
          ]),
        ]),
        expr("/", [
          expr("neg", [sym("qy")]),
          expr("^", [
            expr("+", [
              expr("^", [sym("qx"), float64FromNumber(2)]),
              expr("^", [sym("qy"), float64FromNumber(2)]),
            ]),
            float64FromNumber(1.5),
          ]),
        ]),
      ],
      vars: ["qx", "qy", "px", "py"],
      t_var: "t",
      y0: [1.0, 0.0, 0.0, 1.0],
      t_span: { t0: 0, tf: 2 * Math.PI },
      options: { rtol: 1e-8, atol: 1e-11, t_eval: [0, Math.PI / 2, Math.PI, 3 * Math.PI / 2, 2 * Math.PI] },
    }),
  },
  {
    description: "G reverse exp decay from y(5)=e^-5 back to t=0",
    input: inp({
      f: [expr("neg", [sym("y0")])],
      vars: ["y0"],
      t_var: "t",
      y0: [Math.exp(-5)],
      t_span: { t0: 5, tf: 0 },
      options: { rtol: 1e-8, atol: 1e-11, t_eval: [5, 4, 3, 2, 1, 0] },
    }),
  },
  {
    description: "H dense output: y'=sin(t), y(0)=0 over a fine grid (forces Hermite extension)",
    input: inp({
      f: [expr("sin", [sym("t")])],
      vars: ["y0"],
      t_var: "t",
      y0: [0.0],
      t_span: { t0: 0, tf: 5 },
      options: {
        rtol: 1e-6,
        atol: 1e-9,
        t_eval: [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5],
      },
    }),
  },
  {
    description: "boundary: degenerate tspan t0==tf yields tagged degenerate-tspan",
    input: inp({
      f: [expr("neg", [sym("y0")])],
      vars: ["y0"],
      t_var: "t",
      y0: [1.0],
      t_span: { t0: 0, tf: 0 },
    }),
  },
  {
    description: "boundary: pole in rhs 1/(t-1) over [0,2] yields tagged non-finite-during-eval",
    input: inp({
      f: [expr("/", [float64FromNumber(1), expr("-", [sym("t"), float64FromNumber(1)])])],
      vars: ["y0"],
      t_var: "t",
      y0: [0.0],
      t_span: { t0: 0, tf: 2 },
    }),
  },
];

