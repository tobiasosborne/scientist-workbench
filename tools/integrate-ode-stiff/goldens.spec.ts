// =============================================================================
// integrate-ode-stiff goldens
// =============================================================================
//
// Per-tool goldens. Once `bun run goldens` has approved each input
// against the tool's body, the canonical bytes are locked in
// `goldens/*.golden.json`; future runs that deviate byte-for-byte
// fail the oracle phase of `bun run check`.
//
// Coverage: at least one per code-path branch:
//   - scalar mild-stiff (A-tier shape edge)
//   - scalar very-stiff exp decay (A-tier; λ = 1000)
//   - 2D linear stiff (A-tier; two well-separated decay rates)
//   - exp decay over a long horizon (B-tier)
//   - van der Pol μ = 10 (mild stiffness; B-tier)
//   - Robertson at moderate horizon t = 1e6 (D-tier canonical;
//     bench's t = 1e10 is too slow for the per-tool golden; the
//     bench is the heavier validation surface)
//   - Oregonator on a short horizon (D-tier canonical)
//   - reverse integration (G-tier; ensures the substrate's direction
//     plumbing round-trips)
//   - analytic-Jacobian-supplied 2D linear (verifies the
//     `options.jacobian` short-circuit)
//   - degenerate-tspan boundary tag
//   - method-bdf boundary tag
//
// The bench's 19-case battery in `bench/integrate-ode-stiff/` is the
// heavier validation surface; per-tool goldens lock the *bytes* once
// the bench has approved the *invariants*.
//
// ToolError paths (dim-mismatch, unknown vocabulary) are NOT exercised
// here — the goldens infrastructure requires exit-0 from every input
// and a parsed Value; ToolError exits 1. Those paths are exercised by
// the bench's E-tier and by the tool's `--test` smoke probe.

import {
  expr,
  float64FromNumber,
  list,
  record,
  str,
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
  options?: {
    rtol?: number;
    atol?: number;
    max_step?: number;
    t_eval?: readonly number[];
    method?: string;
    jacobian?: readonly (readonly Value[])[];
  };
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
    if (args.options.method !== undefined) optFields.method = str(args.options.method);
    if (args.options.jacobian !== undefined) {
      const rows: Value[] = [];
      for (const r of args.options.jacobian) rows.push(list([...r] as Value[]));
      optFields.jacobian = list(rows);
    }
    fields.options = record(optFields);
  }
  return record(fields);
}

// ---- expression builders ----------------------------------------------------

const negY0 = expr("neg", [sym("y0")]);
const minus1000Y0 = expr("*", [float64FromNumber(-1000), sym("y0")]);

// 2D linear stiff: y0' = -1000 y0; y1' = -y1.
const linearStiff2D = [
  minus1000Y0,
  expr("neg", [sym("y1")]),
];

// van der Pol μ=10: y0' = y1; y1' = μ(1 - y0²) y1 - y0.
const vdpMu10 = [
  sym("y1"),
  expr("-", [
    expr("*", [
      float64FromNumber(10),
      expr("*", [
        expr("-", [float64FromNumber(1), expr("^", [sym("y0"), float64FromNumber(2)])]),
        sym("y1"),
      ]),
    ]),
    sym("y0"),
  ]),
];

// Robertson:
//   y0' = -0.04 y0 + 1e4 y1 y2
//   y1' =  0.04 y0 - 1e4 y1 y2 - 3e7 y1²
//   y2' =                          3e7 y1²
const robertson = [
  expr("+", [
    expr("*", [float64FromNumber(-0.04), sym("y0")]),
    expr("*", [
      expr("*", [float64FromNumber(1e4), sym("y1")]),
      sym("y2"),
    ]),
  ]),
  expr("-", [
    expr("-", [
      expr("*", [float64FromNumber(0.04), sym("y0")]),
      expr("*", [
        expr("*", [float64FromNumber(1e4), sym("y1")]),
        sym("y2"),
      ]),
    ]),
    expr("*", [float64FromNumber(3e7), expr("^", [sym("y1"), float64FromNumber(2)])]),
  ]),
  expr("*", [float64FromNumber(3e7), expr("^", [sym("y1"), float64FromNumber(2)])]),
];

// Oregonator (Field-Noyes 1974) — canonical small stiff oscillator,
// 3 components. Standard parameters from Hairer-Wanner Vol II §IV.10:
//
//   y0' = 77.27 (y1 + y0(1 − 8.375e-6 y0 − y1))
//   y1' = (1/77.27) (y2 − (1 + y0) y1)
//   y2' = 0.161 (y0 − y2)
//
// (We encode ratios as float64 literals; the closed vocabulary covers
// the rest.)
const oregonator = [
  // 77.27 * (y1 + y0 * (1 - 8.375e-6 * y0 - y1))
  expr("*", [
    float64FromNumber(77.27),
    expr("+", [
      sym("y1"),
      expr("*", [
        sym("y0"),
        expr("-", [
          expr("-", [
            float64FromNumber(1),
            expr("*", [float64FromNumber(8.375e-6), sym("y0")]),
          ]),
          sym("y1"),
        ]),
      ]),
    ]),
  ]),
  // (1/77.27) * (y2 - (1 + y0) * y1)
  expr("*", [
    float64FromNumber(1 / 77.27),
    expr("-", [
      sym("y2"),
      expr("*", [
        expr("+", [float64FromNumber(1), sym("y0")]),
        sym("y1"),
      ]),
    ]),
  ]),
  // 0.161 * (y0 - y2)
  expr("*", [
    float64FromNumber(0.161),
    expr("-", [sym("y0"), sym("y2")]),
  ]),
];

// Analytic-Jacobian for the 2D linear stiff system:
//   J = [[-1000, 0], [0, -1]]
const linearStiff2DJac: readonly (readonly Value[])[] = [
  [float64FromNumber(-1000), float64FromNumber(0)],
  [float64FromNumber(0), float64FromNumber(-1)],
];

export const goldens: GoldenSpec[] = [
  {
    description: "A scalar mild-stiff y'=-y, y(0)=1, t in [0,1]",
    input: inp({
      f: [negY0],
      vars: ["y0"],
      t_var: "t",
      y0: [1.0],
      t_span: { t0: 0, tf: 1 },
      options: { t_eval: [0, 1] },
    }),
  },
  {
    description: "A scalar stiff lambda=1000 y'=-1000 y, y(0)=1 over t in [0, 0.1]",
    input: inp({
      f: [minus1000Y0],
      vars: ["y0"],
      t_var: "t",
      y0: [1.0],
      t_span: { t0: 0, tf: 0.1 },
      options: { rtol: 1e-6, atol: 1e-9, t_eval: [0, 0.02, 0.04, 0.06, 0.08, 0.1] },
    }),
  },
  {
    description: "A 2D linear stiff y0'=-1000 y0, y1'=-y1, y(0)=(1,1) over t in [0, 0.5]",
    input: inp({
      f: linearStiff2D,
      vars: ["y0", "y1"],
      t_var: "t",
      y0: [1.0, 1.0],
      t_span: { t0: 0, tf: 0.5 },
      options: { rtol: 1e-6, atol: 1e-9, t_eval: [0, 0.1, 0.2, 0.3, 0.4, 0.5] },
    }),
  },
  {
    description: "B exp decay long horizon t in [0, 100]",
    input: inp({
      f: [negY0],
      vars: ["y0"],
      t_var: "t",
      y0: [1.0],
      t_span: { t0: 0, tf: 100 },
      options: { rtol: 1e-6, atol: 1e-9, t_eval: [0, 25, 50, 75, 100] },
    }),
  },
  {
    description: "B van der Pol mu=10 over one limit-cycle period",
    input: inp({
      f: vdpMu10,
      vars: ["y0", "y1"],
      t_var: "t",
      y0: [2.0, 0.0],
      t_span: { t0: 0, tf: 20 },
      options: { rtol: 1e-6, atol: 1e-9, t_eval: [0, 5, 10, 15, 20] },
    }),
  },
  {
    description: "D Robertson canonical chemistry, t up to 1e6",
    input: inp({
      f: robertson,
      vars: ["y0", "y1", "y2"],
      t_var: "t",
      y0: [1.0, 0.0, 0.0],
      t_span: { t0: 0, tf: 1e6 },
      options: { rtol: 1e-6, atol: 1e-10, t_eval: [0, 1, 100, 1e4, 1e6] },
    }),
  },
  {
    description: "D Oregonator canonical small-stiff oscillator over t in [0, 30]",
    input: inp({
      f: oregonator,
      vars: ["y0", "y1", "y2"],
      t_var: "t",
      y0: [1.0, 2.0, 3.0],
      t_span: { t0: 0, tf: 30 },
      options: { rtol: 1e-6, atol: 1e-9, t_eval: [0, 5, 10, 15, 20, 25, 30] },
    }),
  },
  {
    description: "G reverse integration y'=-y from t=5 back to t=0",
    input: inp({
      f: [negY0],
      vars: ["y0"],
      t_var: "t",
      y0: [Math.exp(-5)],
      t_span: { t0: 5, tf: 0 },
      options: { rtol: 1e-8, atol: 1e-11, t_eval: [5, 4, 3, 2, 1, 0] },
    }),
  },
  {
    description: "analytic-Jacobian shortcut: 2D linear stiff with options.jacobian",
    input: inp({
      f: linearStiff2D,
      vars: ["y0", "y1"],
      t_var: "t",
      y0: [1.0, 1.0],
      t_span: { t0: 0, tf: 0.5 },
      options: {
        rtol: 1e-6, atol: 1e-9,
        t_eval: [0, 0.25, 0.5],
        jacobian: linearStiff2DJac,
      },
    }),
  },
  {
    description: "boundary: degenerate tspan t0==tf yields tagged degenerate-tspan",
    input: inp({
      f: [negY0],
      vars: ["y0"],
      t_var: "t",
      y0: [1.0],
      t_span: { t0: 0, tf: 0 },
    }),
  },
  {
    description: "boundary: options.method == 'bdf' yields tagged method-not-implemented",
    input: inp({
      f: [negY0],
      vars: ["y0"],
      t_var: "t",
      y0: [1.0],
      t_span: { t0: 0, tf: 1 },
      options: { method: "bdf" },
    }),
  },
];

