// =============================================================================
// integrate-ode-symplectic goldens
// =============================================================================
//
// Per-tool goldens. Once `bun run goldens` has approved each input
// against the tool's body, the canonical bytes are locked in
// `goldens/*.golden.json`; future runs that deviate byte-for-byte
// fail the oracle phase of `bun run check`.
//
// Coverage: at least one per code-path branch:
//   - 1-DOF harmonic (A-tier shape edge, n_steps in {10, 100})
//   - 2-DOF harmonic / two-pendulums (B-tier canonical)
//   - small-angle pendulum
//   - large-angle pendulum (full nonlinearity, near-separatrix)
//   - Kepler 2-body circular orbit (B-tier)
//   - Yoshida-4 on harmonic (verifies scheme dispatch)
//   - long-horizon harmonic (C-tier; bounded drift, not secular)
//   - degenerate-tspan boundary tag (t0 == tf)
//   - zero-n_steps boundary tag (degenerate-tspan via the other path)
//   - non-separable Hamiltonian → tagged
//
// The bench's 17-case battery in `bench/integrate-ode-symplectic/`
// is the heavier validation surface; per-tool goldens lock the
// *bytes* once the bench has approved the *invariants*.

import {
  expr,
  float64FromNumber,
  int,
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
  H: Value;
  q_vars: string[];
  p_vars: string[];
  t_var?: string;
  q0: number[];
  p0: number[];
  t_span: { t0: number; tf: number };
  n_steps: number;
  options?: { scheme?: string; atol?: number };
}): Value {
  const fields: Record<string, Value> = {
    H: args.H,
    q_vars: list(args.q_vars.map((v) => sym(v))),
    p_vars: list(args.p_vars.map((v) => sym(v))),
    t_var: sym(args.t_var ?? "t"),
    q0: vec(args.q0),
    p0: vec(args.p0),
    t_span: record({ t0: f(args.t_span.t0), tf: f(args.t_span.tf) }),
    n_steps: int(BigInt(args.n_steps)),
  };
  if (args.options !== undefined) {
    const optFields: Record<string, Value> = {};
    if (args.options.scheme !== undefined) optFields.scheme = str(args.options.scheme);
    if (args.options.atol !== undefined) optFields.atol = f(args.options.atol);
    fields.options = record(optFields);
  }
  return record(fields);
}

// Hamiltonian builders for readability.
const harmonic1d = expr("/", [
  expr("+", [
    expr("^", [sym("q"), int(2n)]),
    expr("^", [sym("p"), int(2n)]),
  ]),
  int(2n),
]);

const pendulum1d = expr("+", [
  expr("/", [expr("^", [sym("p"), int(2n)]), int(2n)]),
  expr("-", [int(1n), expr("cos", [sym("q")])]),
]);

const twoPendulums = expr("+", [
  expr("+", [
    expr("/", [expr("^", [sym("p1"), int(2n)]), int(2n)]),
    expr("/", [expr("^", [sym("p2"), int(2n)]), int(2n)]),
  ]),
  expr("+", [
    expr("-", [int(1n), expr("cos", [sym("q1")])]),
    expr("-", [int(1n), expr("cos", [sym("q2")])]),
  ]),
]);

const kepler = expr("-", [
  expr("/", [
    expr("+", [
      expr("^", [sym("px"), int(2n)]),
      expr("^", [sym("py"), int(2n)]),
    ]),
    int(2n),
  ]),
  expr("/", [
    int(1n),
    expr("sqrt", [
      expr("+", [
        expr("^", [sym("qx"), int(2n)]),
        expr("^", [sym("qy"), int(2n)]),
      ]),
    ]),
  ]),
]);

// Non-separable: H = (q + p)² / 2.
const nonSeparable = expr("/", [
  expr("^", [
    expr("+", [sym("q"), sym("p")]),
    int(2n),
  ]),
  int(2n),
]);

export const goldens: GoldenSpec[] = [
  {
    description: "A 1-DOF harmonic over one period at n_steps=10 (shape edge)",
    input: inp({
      H: harmonic1d,
      q_vars: ["q"], p_vars: ["p"],
      q0: [1.0], p0: [0.0],
      t_span: { t0: 0, tf: 2 * Math.PI },
      n_steps: 10,
    }),
  },
  {
    description: "A 1-DOF harmonic over one period at n_steps=100 (canonical resolution)",
    input: inp({
      H: harmonic1d,
      q_vars: ["q"], p_vars: ["p"],
      q0: [1.0], p0: [0.0],
      t_span: { t0: 0, tf: 2 * Math.PI },
      n_steps: 100,
    }),
  },
  {
    description: "B 1-DOF harmonic with explicit atol option",
    input: inp({
      H: harmonic1d,
      q_vars: ["q"], p_vars: ["p"],
      q0: [1.0], p0: [0.0],
      t_span: { t0: 0, tf: 2 * Math.PI },
      n_steps: 200,
      options: { atol: 1e-9 },
    }),
  },
  {
    description: "B small-angle pendulum H = p²/2 + (1 − cos q), q0 = 0.1 over two periods",
    input: inp({
      H: pendulum1d,
      q_vars: ["q"], p_vars: ["p"],
      q0: [0.1], p0: [0.0],
      t_span: { t0: 0, tf: 4 * Math.PI },
      n_steps: 400,
    }),
  },
  {
    description: "B large-angle pendulum H = p²/2 + (1 − cos q), q0 = 1.5 (near separatrix)",
    input: inp({
      H: pendulum1d,
      q_vars: ["q"], p_vars: ["p"],
      q0: [1.5], p0: [0.0],
      t_span: { t0: 0, tf: 4 * Math.PI },
      n_steps: 400,
    }),
  },
  {
    description: "B Kepler circular orbit H = (px²+py²)/2 − 1/√(qx²+qy²), one period",
    input: inp({
      H: kepler,
      q_vars: ["qx", "qy"], p_vars: ["px", "py"],
      q0: [1.0, 0.0], p0: [0.0, 1.0],
      t_span: { t0: 0, tf: 2 * Math.PI },
      n_steps: 400,
    }),
  },
  {
    description: "B two-pendulums (4D separable) over two periods",
    input: inp({
      H: twoPendulums,
      q_vars: ["q1", "q2"], p_vars: ["p1", "p2"],
      q0: [0.5, 0.3], p0: [0.0, 0.1],
      t_span: { t0: 0, tf: 4 * Math.PI },
      n_steps: 400,
    }),
  },
  {
    description: "Yoshida-4 on harmonic — strictly tighter drift than Verlet",
    input: inp({
      H: harmonic1d,
      q_vars: ["q"], p_vars: ["p"],
      q0: [1.0], p0: [0.0],
      t_span: { t0: 0, tf: 2 * Math.PI },
      n_steps: 100,
      options: { scheme: "yoshida-4" },
    }),
  },
  {
    description: "C harmonic long-horizon (100 periods at h ≈ 2π/100); drift bounded, not secular",
    input: inp({
      H: harmonic1d,
      q_vars: ["q"], p_vars: ["p"],
      q0: [1.0], p0: [0.0],
      t_span: { t0: 0, tf: 100 * 2 * Math.PI },
      n_steps: 10_000,
    }),
  },
  {
    description: "boundary: degenerate tspan t0 == tf yields tagged degenerate-tspan",
    input: inp({
      H: harmonic1d,
      q_vars: ["q"], p_vars: ["p"],
      q0: [1.0], p0: [0.0],
      t_span: { t0: 0, tf: 0 },
      n_steps: 10,
    }),
  },
  {
    description: "boundary: n_steps == 0 yields tagged degenerate-tspan",
    input: inp({
      H: harmonic1d,
      q_vars: ["q"], p_vars: ["p"],
      q0: [1.0], p0: [0.0],
      t_span: { t0: 0, tf: 1 },
      n_steps: 0,
    }),
  },
  {
    description: "boundary: non-separable H = (q+p)²/2 yields tagged non-separable-hamiltonian",
    input: inp({
      H: nonSeparable,
      q_vars: ["q"], p_vars: ["p"],
      q0: [1.0], p0: [0.0],
      t_span: { t0: 0, tf: 1 },
      n_steps: 100,
    }),
  },
];
