// =============================================================================
// demo-scope.ts — TS port of demo-scope.sh, using @workbench/compose
// =============================================================================
//
// Substrate: ADR-0012 §"Three moves — implementation sequencing", issue
// scientist-workbench-e0h.
//
// The bash version (`scripts/demo-scope.sh`) covers the same 14 demos
// using subprocess invocations. It still works, lives alongside this
// file as a sanity-check the subprocess surface is healthy. The TS
// port here exists for:
//
// 1. **The agent-facing call site.** A reader landing cold on
//    `demo-scope.ts` sees `wb.casVerify({lhs, rhs})` and
//    `wb.pipe(input).through("expr-parse").through("cas-simplify").value()`,
//    not 250 lines of `echo '{"kind":"..."}'` plumbing. The TS port
//    *is* the documentation of what the typed surface buys you.
// 2. **The speedup measurement.** The bash version spawns `bun` once
//    per pipe hop (~50 ms each); this version spawns `bun` once
//    total. A 5+ step chain shows the ~20× ratio the issue's
//    acceptance asks for.
// 3. **Forcing-function for friction.** Anything awkward in the API
//    surfaces here. (Friction notes go in worklog 035.)
//
// Run: `bun scripts/demo-scope.ts`. Set `CAS_STORE` to a fresh dir
// if you want a clean provenance store; absent, the demos use the
// global default (`~/.scientist-workbench/cas-store`).

import { float64FromNumber, float64ToNumber, hash, int, list, parse, rat, record, str, sym, expr, type Value } from "@workbench/protocol";
import { canonicalize } from "@workbench/protocol";
import { spawnBun } from "@workbench/contract";
import { loadWorkbench, typed } from "@workbench/compose";

// -----------------------------------------------------------------------------
// Pretty-printer — same shape as `SHORT` in the bash version
// -----------------------------------------------------------------------------

function short(v: Value): string {
  switch (v.kind) {
    case "integer": return v.value;
    case "rational": return `${v.num}/${v.den}`;
    case "symbol": return v.name;
    case "string": return JSON.stringify(v.value);
    case "boolean": return String(v.value);
    case "float64": return `<f64:${v.bits}>`;
    case "list": return `[${v.items.map(short).join(",")}]`;
    case "record": {
      const fs = v.fields;
      const keys = Object.keys(fs).sort();
      return `{${keys.map((k) => `${k}: ${short(fs[k]!)}`).join(", ")}}`;
    }
    case "expression": {
      const args = v.args.map(short);
      if (["+", "-", "*", "/", "^"].includes(v.head) && args.length >= 2) {
        return `(${args.join(` ${v.head} `)})`;
      }
      if (v.head === "-" && args.length === 1) return `(-${args[0]})`;
      return `${v.head}(${args.join(",")})`;
    }
    case "tagged": return `tagged[${v.tag}](${short(v.payload)})`;
  }
}

function header(n: number, title: string, body?: string): void {
  console.log("\n" + "=".repeat(60));
  console.log(`  Demo ${n} — ${title}`);
  if (body !== undefined) console.log(`          ${body}`);
  console.log("=".repeat(60));
}

// -----------------------------------------------------------------------------
// Bootstrap
// -----------------------------------------------------------------------------

const t0 = Date.now();
const workbench = await loadWorkbench();
const wb = typed(workbench);
const loadMs = Date.now() - t0;
console.log(`(loaded ${workbench.tools.size} tools in ${loadMs}ms)`);

// Convenience: parse plain text into an expression Value.
const parseExpr = (s: string) => wb.exprParse(str(s));

// Convenience: verify lhs ?= rhs and short-print the verdict.
async function verify(lhs: Value, rhs: Value): Promise<void> {
  const out = await wb.casVerify({
    kind: "record",
    fields: { lhs, rhs },
  });
  console.log("  " + short(out));
}

// -----------------------------------------------------------------------------
// Demos — same 14 as scripts/demo-scope.sh, in the same order
// -----------------------------------------------------------------------------

header(1, "binomial expansion: (a+b)^4 ?= a^4+4a^3b+6a^2b^2+4ab^3+b^4");
await verify(
  await parseExpr("(a+b)^4"),
  await parseExpr("a^4 + 4*a^3*b + 6*a^2*b^2 + 4*a*b^3 + b^4"),
);

header(2, "catching a real algebra error with a witness",
  "(a-b)^3 ?= a^3 - 3a^2 b + 3 a b^2 + b^3   (sign wrong on b^3)");
await verify(
  await parseExpr("(a-b)^3"),
  await parseExpr("a^3 - 3*a^2*b + 3*a*b^2 + b^3"),
);
console.log("  (witness shows lhs - rhs in canonical form)");

header(3, "Sophie Germain identity",
  "a^4+4b^4 ?= (a^2+2b^2+2ab)(a^2+2b^2-2ab)");
await verify(
  await parseExpr("a^4 + 4*b^4"),
  await parseExpr("(a^2 + 2*b^2 + 2*a*b)*(a^2 + 2*b^2 - 2*a*b)"),
);

header(4, "symmetric-function identity",
  "a^3+b^3+c^3-3abc ?= (a+b+c)(a^2+b^2+c^2-ab-ac-bc)");
await verify(
  await parseExpr("a^3 + b^3 + c^3 - 3*a*b*c"),
  await parseExpr("(a+b+c)*(a^2 + b^2 + c^2 - a*b - a*c - b*c)"),
);

header(5, "partial-fraction decomposition (no GCD needed)",
  "1/(x^2-1) ?= 1/(2(x-1)) - 1/(2(x+1))");
await verify(
  await parseExpr("1/(x^2 - 1)"),
  await parseExpr("1/(2*(x-1)) - 1/(2*(x+1))"),
);

header(6, "telescoping summand",
  "1/(n(n+1)) ?= 1/n - 1/(n+1)");
await verify(
  await parseExpr("1/(n*(n+1))"),
  await parseExpr("1/n - 1/(n+1)"),
);

header(7, "chain verification: each step of a hand derivation",
  "(x+1)^2 = (x+1)(x+1) = x^2 + 2x + 1");
const s0 = await parseExpr("(x+1)^2");
const s1 = await parseExpr("(x+1)*(x+1)");
const s2_correct = await parseExpr("x^2 + 2*x + 1");
const s2_wrong = await parseExpr("x^2 + 1");
console.log("  step 0 = step 1 :");
await verify(s0, s1);
console.log("  step 1 = step 2 (correct work):");
await verify(s1, s2_correct);
console.log("  step 1 = step 2 (forgot the middle term — should fail):");
await verify(s1, s2_wrong);

header(8, "honest scope: sin^2(x) + cos^2(x) = 1",
  "(this tool does NOT know trig — should say so, not lie)");
const trigLhs = expr("+", [
  expr("^", [expr("sin", [sym("x")]), int(2n)]),
  expr("^", [expr("cos", [sym("x")]), int(2n)]),
]);
await verify(trigLhs, await parseExpr("1"));

header(9, "discoverability: agent plans a composition by type",
  "'I have plain text. What can consume strings?'");
function printRegistryHits(label: string, result: Value): void {
  console.log(`  ${label} :`);
  if (result.kind !== "list") return;
  for (const t of result.items) {
    if (t.kind !== "record") continue;
    const name = t.fields["name"];
    const ver = t.fields["version"];
    if (name?.kind === "string" && ver?.kind === "string") {
      console.log(`    - ${name.value} @ ${ver.value}`);
    }
  }
}
printRegistryHits(
  "tools that consume kind=string",
  await wb.registrySearch(record({ input_kind: str("string") })),
);
printRegistryHits(
  "tools that produce kind=record",
  await wb.registrySearch(record({ output_kind: str("record") })),
);

header(10, "re-executable provenance",
  "Verify (x+1)^3 = x^3+3x^2+3x+1, look up the derivation by hash.");
const v10lhs = await parseExpr("(x+1)^3");
const v10rhs = await parseExpr("x^3 + 3*x^2 + 3*x + 1");
const v10out = await wb.casVerify({ kind: "record", fields: { lhs: v10lhs, rhs: v10rhs } });
console.log("  verdict:", short(v10out));
const v10hash = hash(v10out);
console.log("  output hash:", v10hash);
console.log("  provenance lookup (in-process; the same record subprocess --provenance-of would give):");
const provLookup = await spawnBun(
  ["tools/cas-verify/tool.ts", "--provenance-of", v10hash],
  undefined,
  { env: { ...process.env, CAS_STORE: workbench.store } },
);
if (provLookup.code === 0) {
  console.log("  " + short(parse(provLookup.stdout)));
} else {
  console.log("  (no provenance — store may be in a different location)");
}

header(11, "Sturm channel execution: Bell pair → distribution",
  "Construct + simplify + execute. Expect (r0=0,r1=0) and (r0=1,r1=1) at ≈ 0.5 each.");

// The Bell-pair channel — ADR-0006 IR-as-Value form.
const bellPair: Value = expr("channel", [
  list([]),
  list([]),
  list([
    expr("prepare", [rat(0n, 1n), int(0n)]),
    expr("prepare", [rat(0n, 1n), int(1n)]),
    expr("ry", [int(0n), expr("/", [sym("π"), int(2n)]), list([])]),
    expr("ry", [int(1n), sym("π"), list([int(0n)])]),
    expr("observe", [int(0n), str("r0")]),
    expr("observe", [int(1n), str("r1")]),
  ]),
]);
const bellExecuted = await wb
  .pipe(bellPair)
  .through("sturm-simplify")
  .through("sturm-execute")
  .value();
console.log("  " + short(bellExecuted));

header(12, "Sturm equivalence: Bell pair vs Bell pair + ry(0)",
  "Two circuits differ syntactically; sturm-equivalent confirms equality.");
const bellRedundant: Value = expr("channel", [
  list([]),
  list([]),
  list([
    expr("prepare", [rat(0n, 1n), int(0n)]),
    expr("prepare", [rat(0n, 1n), int(1n)]),
    expr("ry", [int(0n), expr("/", [sym("π"), int(2n)]), list([])]),
    expr("ry", [int(0n), int(0n), list([])]),
    expr("ry", [int(1n), sym("π"), list([int(0n)])]),
    expr("observe", [int(0n), str("r0")]),
    expr("observe", [int(1n), str("r1")]),
  ]),
]);
const bellEq = await wb.sturmEquivalent({
  kind: "record",
  fields: { lhs: bellPair, rhs: bellRedundant },
});
console.log("  " + short(bellEq));

header(13, "channel combinators: build a channel from pieces",
  "sturm-then composes prepare-only + observe-only into a deterministic prepare-and-observe.");

const prepW0: Value = expr("channel", [
  list([]),
  list([record({ id: int(0n), kind: str("quantum") })]),
  list([expr("prepare", [rat(0n, 1n), int(0n)])]),
]);
const obsW0: Value = expr("channel", [
  list([record({ id: int(0n), kind: str("quantum") })]),
  list([]),
  list([expr("observe", [int(0n), str("r")])]),
]);
const composed = await wb.sturmThen({
  kind: "record",
  fields: { first: prepW0, second: obsW0 },
});
console.log("  composed channel:");
console.log("  " + short(composed));
console.log("  end-to-end through sturm-execute (P(r=0) should be 1):");
const composedExecuted = await wb.sturmExecute(composed as never);
console.log("  " + short(composedExecuted));

header(14, "Grover's algorithm: find a marked basis state",
  "n=3 search space (8 items), marked=5, predicted P(observed=5) ≈ 0.945 after 2 iterations.");
const grover = await wb.sturmFind({
  kind: "record",
  fields: {
    n_bits: int(3n),
    marked: list([int(5n)]),
  },
});
console.log("  " + short(grover));

header(15, "linalg-qr: Householder QR on Hilbert-8 (κ ≈ 1.5e10)",
  "Householder gives ‖QᵀQ − I‖_F = O(ε) independent of κ — MGS would catastrophically fail here.");
// Hilbert(8) — the canonical ill-conditioned test.
const hilbert8Rows = Array.from({ length: 8 }, (_, i) =>
  list(Array.from({ length: 8 }, (_, j) => float64FromNumber(1 / (i + j + 1)))),
);
const hilbert8Result = await wb.linalgQr({
  kind: "record",
  fields: { A: list(hilbert8Rows) },
});
if (hilbert8Result.kind === "record") {
  const reconErr = hilbert8Result.fields["reconstruction_error"];
  const orthErr = hilbert8Result.fields["orthogonality_error"];
  if (reconErr?.kind === "float64" && orthErr?.kind === "float64") {
    console.log("  reconstruction error:", float64ToNumber(reconErr).toExponential(2));
    console.log("  orthogonality error: ", float64ToNumber(orthErr).toExponential(2),
      " (Householder: O(ε); MGS would be ~3e-6 here)");
  }
}

header(16, "linalg-svd: rank-revealing factorisation of a rank-deficient matrix",
  "Rank-1 outer product u·vᵀ; SVD reveals exactly one nonzero singular value.");
// Rank-1 outer product: A[i,j] = u[i] · v[j] has rank exactly 1.
// SVD's rank_estimate should report 1; the other singular values are noise.
const u = [1.0, 2.0, 3.0, 4.0];
const v = [1.0, -1.0, 2.0];
const nearSingular = u.map((ui) => v.map((vj) => ui * vj));
const svdInput = list(
  nearSingular.map((row) => list(row.map((x) => float64FromNumber(x)))),
);
const svdResult = await wb.linalgSvd({
  kind: "record",
  fields: { A: svdInput },
});
if (svdResult.kind === "record") {
  const sList = svdResult.fields["S"];
  const rank = svdResult.fields["rank_estimate"];
  const cond = svdResult.fields["condition_number"];
  if (sList?.kind === "list" && rank?.kind === "integer" && cond?.kind === "float64") {
    const sigmas = sList.items
      .filter((it): it is { kind: "float64" } & typeof it => it.kind === "float64")
      .map((it) => float64ToNumber(it as never).toExponential(2));
    console.log("  singular values:    [" + sigmas.join(", ") + "]");
    console.log("  numerical rank:    ", Number(rank.value), " (the other σ are at machine epsilon — true rank revealed)");
    console.log("  condition number:  ", float64ToNumber(cond).toExponential(2));
  }
}

header(17, "linalg-eigh: symmetric eigh on the Pei matrix αI + eeᵀ",
  "Cyclic Jacobi diagonalises the symmetric n×n; n−1 eigenvalues at α and one at α+n.");
// Pei(5, 1) = I + eeᵀ (with diagonal increment): eigenvalues = (1, 1, 1, 1, 6).
const peiRows = [
  [2, 1, 1, 1, 1],
  [1, 2, 1, 1, 1],
  [1, 1, 2, 1, 1],
  [1, 1, 1, 2, 1],
  [1, 1, 1, 1, 2],
];
const peiInput = list(
  peiRows.map((row) => list(row.map((x) => float64FromNumber(x)))),
);
const eighResult = await wb.linalgEigh({
  kind: "record",
  fields: { A: peiInput },
});
if (eighResult.kind === "record") {
  const lams = eighResult.fields["eigenvalues"];
  const reconErr = eighResult.fields["reconstruction_error"];
  const orthErr = eighResult.fields["orthogonality_error"];
  if (lams?.kind === "list" && reconErr?.kind === "float64" && orthErr?.kind === "float64") {
    const eigs = lams.items
      .filter((it): it is { kind: "float64" } & typeof it => it.kind === "float64")
      .map((it) => float64ToNumber(it as never).toFixed(4));
    console.log("  eigenvalues:        [" + eigs.join(", ") + "]   (expected [1, 1, 1, 1, 6])");
    console.log("  reconstruction err:", float64ToNumber(reconErr).toExponential(2));
    console.log("  orthogonality err: ", float64ToNumber(orthErr).toExponential(2),
      " (Jacobi: O(ε) independent of κ)");
  }
}

header(18, "integrate-ode-ivp: Lotka-Volterra predator-prey",
  "DOPRI5 + PI controller integrates dy/dt = f(t, y) over a non-stiff system.");
const lvF = list([
  // y0' = α y0 - β y0 y1, with α=1.0, β=0.1
  expr("-", [
    sym("y0"),
    expr("*", [
      expr("*", [float64FromNumber(0.1), sym("y0")]),
      sym("y1"),
    ]),
  ]),
  // y1' = δ y0 y1 - γ y1, with δ=0.075, γ=1.5
  expr("-", [
    expr("*", [
      expr("*", [float64FromNumber(0.075), sym("y0")]),
      sym("y1"),
    ]),
    expr("*", [float64FromNumber(1.5), sym("y1")]),
  ]),
]);
const lvInput = {
  kind: "record" as const,
  fields: {
    f: lvF,
    vars: list([sym("y0"), sym("y1")]),
    t_var: sym("t"),
    y0: list([float64FromNumber(10.0), float64FromNumber(5.0)]),
    t_span: { kind: "record" as const, fields: { t0: float64FromNumber(0), tf: float64FromNumber(5) } },
    options: {
      kind: "record" as const, fields: {
        rtol: float64FromNumber(1e-6),
        atol: float64FromNumber(1e-9),
        t_eval: list([0, 1, 2, 3, 4, 5].map((x) => float64FromNumber(x))),
      },
    },
  },
};
const ivpResult = await wb.integrateOdeIvp(lvInput as never);
if (ivpResult.kind === "record") {
  const traj = ivpResult.fields["trajectory"];
  const status = ivpResult.fields["status"];
  const nAcc = ivpResult.fields["n_steps_accepted"];
  if (traj?.kind === "list" && status?.kind === "string" && nAcc?.kind === "integer") {
    console.log("  status:           ", status.value);
    console.log("  n_steps_accepted: ", String(nAcc.value));
    const last = traj.items[traj.items.length - 1];
    if (last?.kind === "list") {
      const lastVals = last.items.map((it) =>
        it.kind === "float64" ? float64ToNumber(it as never).toFixed(4) : "?",
      );
      console.log(`  y(5) ≈            [${lastVals.join(", ")}]   (one Lotka-Volterra orbit)`);
    }
  }
}

header(19, "integrate-ode-symplectic: Kepler 2-body, energy drift bounded over 10 orbits",
  "Velocity Verlet preserves energy O(h²) regardless of horizon; DOPRI5 would drift linearly.");
// H = (px² + py²)/2 − 1/√(qx² + qy²): unit-mass Kepler 2-body (sun at origin).
// Circular orbit at r=1 has period 2π and angular momentum 1; we run 10
// such periods at h = T/100 = π/50 and report the bounded drift.
const keplerH = expr("-", [
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
const keplerInput = {
  kind: "record" as const,
  fields: {
    H: keplerH,
    q_vars: list([sym("qx"), sym("qy")]),
    p_vars: list([sym("px"), sym("py")]),
    t_var: sym("t"),
    q0: list([float64FromNumber(1.0), float64FromNumber(0.0)]),
    p0: list([float64FromNumber(0.0), float64FromNumber(1.0)]),
    t_span: { kind: "record" as const, fields: {
      t0: float64FromNumber(0),
      tf: float64FromNumber(10 * 2 * Math.PI),
    }},
    n_steps: int(1000n),
  },
};
const symplResult = await wb.integrateOdeSymplectic(keplerInput as never);
if (symplResult.kind === "record") {
  const drift = symplResult.fields["energy_drift_max"];
  const secular = symplResult.fields["energy_drift_secular"];
  const method = symplResult.fields["method"];
  const status = symplResult.fields["status"];
  if (drift?.kind === "float64" && secular?.kind === "boolean"
      && method?.kind === "string" && status?.kind === "string") {
    console.log("  status:               ", status.value);
    console.log("  method:               ", method.value);
    console.log("  energy_drift_max:     ", float64ToNumber(drift).toExponential(2),
      "  (bounded — symplectic structure preserves H)");
    console.log("  energy_drift_secular: ", String(secular.value),
      "  (false — drift is oscillatory, not linear-growing)");
  }
}

header(20, "integrate-ode-stiff: Robertson chemistry, t in [0, 1e6] (stiff IVP via Radau-IIA)",
  "Explicit RK would need ~10^12 tiny steps to remain stable; Radau handles it in ~150 implicit steps.");
// Robertson (Robertson 1966) — the canonical stiff test problem. Three
// reactant species over a horizon spanning many orders of magnitude.
//
//   y0' = -0.04 y0 + 1e4 y1 y2
//   y1' =  0.04 y0 - 1e4 y1 y2 - 3e7 y1²
//   y2' =                          3e7 y1²
//
// Initial condition (1, 0, 0). The tool composes `cas-diff` in-process
// to derive the symbolic Jacobian and pushes it into the implicit-RK
// driver; per-step cost is dominated by the `n × n` and `2n × 2n` LU
// factorisations (n = 3 here, so cheap).
const robertsonF = list([
  // -0.04 * y0 + 1e4 * y1 * y2
  expr("+", [
    expr("*", [float64FromNumber(-0.04), sym("y0")]),
    expr("*", [
      expr("*", [float64FromNumber(1e4), sym("y1")]),
      sym("y2"),
    ]),
  ]),
  // 0.04 * y0 - 1e4 * y1 * y2 - 3e7 * y1^2
  expr("-", [
    expr("-", [
      expr("*", [float64FromNumber(0.04), sym("y0")]),
      expr("*", [
        expr("*", [float64FromNumber(1e4), sym("y1")]),
        sym("y2"),
      ]),
    ]),
    expr("*", [float64FromNumber(3e7), expr("^", [sym("y1"), int(2n)])]),
  ]),
  // 3e7 * y1^2
  expr("*", [float64FromNumber(3e7), expr("^", [sym("y1"), int(2n)])]),
]);
const robertsonInput = {
  kind: "record" as const,
  fields: {
    f: robertsonF,
    vars: list([sym("y0"), sym("y1"), sym("y2")]),
    t_var: sym("t"),
    y0: list([float64FromNumber(1.0), float64FromNumber(0.0), float64FromNumber(0.0)]),
    t_span: { kind: "record" as const, fields: {
      t0: float64FromNumber(0),
      tf: float64FromNumber(1e6),
    }},
    options: {
      kind: "record" as const, fields: {
        rtol: float64FromNumber(1e-6),
        atol: float64FromNumber(1e-10),
        t_eval: list([0, 1, 100, 1e4, 1e6].map((x) => float64FromNumber(x))),
      },
    },
  },
};
const stiffResult = await wb.integrateOdeStiff(robertsonInput as never);
if (stiffResult.kind === "record") {
  const status = stiffResult.fields["status"];
  const nAcc = stiffResult.fields["n_steps_accepted"];
  const nJac = stiffResult.fields["n_jacobian_evals"];
  const nLU = stiffResult.fields["n_lu_decompositions"];
  const traj = stiffResult.fields["trajectory"];
  if (status?.kind === "string" && nAcc?.kind === "integer"
      && nJac?.kind === "integer" && nLU?.kind === "integer"
      && traj?.kind === "list") {
    console.log("  status:                ", status.value);
    console.log("  n_steps_accepted:      ", String(nAcc.value));
    console.log("  n_jacobian_evals:      ", String(nJac.value),
      "  (>0 — implicit method actually uses J)");
    console.log("  n_lu_decompositions:   ", String(nLU.value),
      `  (≥ 2·n_jacobian_evals — real + complex pair)`);
    const last = traj.items[traj.items.length - 1];
    if (last?.kind === "list") {
      const lastVals = last.items.map((it) =>
        it.kind === "float64" ? float64ToNumber(it as never).toExponential(3) : "?",
      );
      console.log(`  y(1e6) ≈                [${lastVals.join(", ")}]`);
    }
  }
}

header(21, "linsolve-q: exact rational linear solve over Hilbert-3",
  "Bareiss fraction-free Gaussian elimination — exact in Q with bit length bounded by Hadamard.");
// Hilbert-3 (famously ill-conditioned over ℝ — exact over ℚ).
// The demo asserts: kind=complete, bit length stays small, x is exact
// rational. b chosen to make x = (1/2, -3, 4) the unique solution.
const linsolveResult = await wb.linsolveQ({
  kind: "record",
  fields: {
    A: list([
      list([
        { kind: "integer", value: "1" },
        { kind: "rational", num: "1", den: "2" },
        { kind: "rational", num: "1", den: "3" },
      ]),
      list([
        { kind: "rational", num: "1", den: "2" },
        { kind: "rational", num: "1", den: "3" },
        { kind: "rational", num: "1", den: "4" },
      ]),
      list([
        { kind: "rational", num: "1", den: "3" },
        { kind: "rational", num: "1", den: "4" },
        { kind: "rational", num: "1", den: "5" },
      ]),
    ]),
    b: list([
      { kind: "rational", num: "1", den: "3" },
      { kind: "rational", num: "1", den: "4" },
      { kind: "rational", num: "13", den: "60" },
    ]),
  },
});
if (linsolveResult.kind === "record") {
  const completeness = linsolveResult.fields["completeness"];
  const warnings = linsolveResult.fields["warnings"];
  if (completeness?.kind === "string") {
    console.log("  completeness:           ", completeness.value);
  }
  if (warnings?.kind === "list" && warnings.items.length > 0) {
    const w0 = warnings.items[0];
    if (w0?.kind === "string") {
      console.log("  ", w0.value, "  (Hadamard-bounded; naive ℚ would be 100×)");
    }
  }
  const solutions = linsolveResult.fields["solutions"];
  if (solutions?.kind === "list" && solutions.items.length === 1) {
    const sol = solutions.items[0];
    if (sol?.kind === "record") {
      const bindings = sol.fields["bindings"];
      if (bindings?.kind === "list") {
        const summary: string[] = [];
        for (const b of bindings.items) {
          if (b?.kind === "record") {
            const v = b.fields["var"];
            const val = b.fields["value"];
            if (v?.kind === "symbol" && val) {
              const valStr =
                val.kind === "integer" ? val.value
                : val.kind === "rational" ? `${val.num}/${val.den}`
                : "<expr>";
              summary.push(`${v.name} → ${valStr}`);
            }
          }
        }
        console.log("  x:                      ", summary.join(", "));
      }
    }
  }
}

// -----------------------------------------------------------------------------
// 15. poly-factor — exact univariate factorisation over ℚ
// -----------------------------------------------------------------------------
//
// First Solve-tier symbolic tool (after linsolve-q): given a polynomial
// over ℚ, return the unique irreducible factorisation. The demo shows
// (x⁵ − x⁴ − 2x³ + 2x² + x − 1) factoring as (x − 1)³(x + 1)² —
// multiplicity discipline + monic primitive integer factors.

console.log("\n" + "=".repeat(60));
console.log("  15. poly-factor — exact univariate factorisation over ℚ");
console.log("=".repeat(60));
console.log(
  "Berlekamp 1967 over a lucky prime + Zassenhaus 1969 quadratic Hensel\n" +
  "lift + subset-sum recombination. Pure ℤ/ℚ over BigInt — no float, no FFI.",
);
const factorInput = await parseExpr("x^5 - x^4 - 2*x^3 + 2*x^2 + x - 1");
const factorResult = await wb.polyFactor({
  kind: "record",
  fields: { f: factorInput as never, var: { kind: "symbol", name: "x" } },
});
if (factorResult.kind === "record") {
  const content = factorResult.fields["content"];
  const factors = factorResult.fields["factors"];
  if (content?.kind === "integer") {
    console.log("  content:                ", content.value);
  }
  if (factors?.kind === "list") {
    for (const fr of factors.items) {
      if (fr?.kind === "record") {
        const f = fr.fields["factor"];
        const m = fr.fields["multiplicity"];
        if (f && m?.kind === "integer") {
          // Pretty-render the integer factor expression.
          const render = (v: typeof f): string => {
            if (v.kind === "symbol") return v.name;
            if (v.kind === "integer") return v.value;
            if (v.kind === "rational") return `${v.num}/${v.den}`;
            if (v.kind === "expression") {
              if (v.head === "+") return v.args.map(render).join(" + ").replace(/\+ -/g, "- ");
              if (v.head === "*") return v.args.map(render).join("·");
              if (v.head === "^") return `${render(v.args[0]!)}^${render(v.args[1]!)}`;
              if (v.head === "neg") return `-${render(v.args[0]!)}`;
              return `<${v.head}>`;
            }
            return `<${v.kind}>`;
          };
          console.log(`  factor:    (${render(f)})^${m.value}`);
        }
      }
    }
  }
}

// -----------------------------------------------------------------------------
// 16. solve — Mathematica Solve[]-class dispatcher (linear + univariate)
// -----------------------------------------------------------------------------
//
// The top-level entry point of solve-suite-v1. Takes equations and
// unknowns, classifies, dispatches, returns ADR-0017's solution-set
// shape. The demo runs both lanes in one call to demonstrate the
// dispatcher: a linear system (bareissSolve under the hood) and a
// univariate quadratic (factor + quadratic-formula radicals).

console.log("\n" + "=".repeat(60));
console.log("  16. solve — top-level dispatcher (linear + univariate)");
console.log("=".repeat(60));
console.log(
  "Classifier decides the lane (linear / univariate-poly / refusal);\n" +
  "dispatcher executes via Bareiss exact ℚ or poly-factor + radicals.",
);
const linearSolveResult = await wb.solve({
  kind: "record",
  fields: {
    eqs: list([
      { kind: "expression", head: "+", args: [{ kind: "symbol", name: "x" }, { kind: "symbol", name: "y" }, { kind: "integer", value: "-3" }] },
      { kind: "expression", head: "-", args: [{ kind: "expression", head: "-", args: [{ kind: "symbol", name: "x" }, { kind: "symbol", name: "y" }] }, { kind: "integer", value: "1" }] },
    ]),
    vars: list([{ kind: "symbol", name: "x" }, { kind: "symbol", name: "y" }]),
  },
});
if (linearSolveResult.kind === "record") {
  const sols = linearSolveResult.fields["solutions"];
  if (sols?.kind === "list" && sols.items[0]?.kind === "record") {
    const bindings = sols.items[0].fields["bindings"];
    if (bindings?.kind === "list") {
      const summary = bindings.items.map((b) => {
        if (b.kind !== "record") return "?";
        const v = b.fields["var"], val = b.fields["value"];
        if (v?.kind !== "symbol") return "?";
        const valStr = val?.kind === "integer" ? val.value : "?";
        return `${v.name} → ${valStr}`;
      }).join(", ");
      console.log("  linear { x + y = 3, x − y = 1 }: ", summary);
    }
  }
}

const polySolveResult = await wb.solve({
  kind: "record",
  fields: {
    eqs: list([
      { kind: "expression", head: "+", args: [
        { kind: "expression", head: "^", args: [{ kind: "symbol", name: "x" }, { kind: "integer", value: "2" }] },
        { kind: "expression", head: "*", args: [{ kind: "integer", value: "-5" }, { kind: "symbol", name: "x" }] },
        { kind: "integer", value: "6" },
      ] },
    ]),
    vars: list([{ kind: "symbol", name: "x" }]),
  },
});
if (polySolveResult.kind === "record") {
  const sols = polySolveResult.fields["solutions"];
  if (sols?.kind === "list") {
    const xs: string[] = [];
    for (const sol of sols.items) {
      if (sol.kind !== "record") continue;
      const bindings = sol.fields["bindings"];
      if (bindings?.kind !== "list" || bindings.items.length !== 1) continue;
      const b = bindings.items[0];
      if (b?.kind !== "record") continue;
      const val = b.fields["value"];
      if (val?.kind === "integer") xs.push(val.value);
    }
    console.log(`  univariate { x² − 5x + 6 = 0 }:    x ∈ {${xs.join(", ")}}`);
  }
}

// Multivariate zero-dim probe — (x²+y²−5, x+y−3) over ℚ[x,y]. The
// Gröbner stack (ADR-0029, bead x8d) handles this: compute reduced
// DRL Gröbner basis via Buchberger + sloppy sugar + Gebauer-Möller
// pruning; test zero-dimensionality (pure-power LM check, CLO
// Ch.5 §3 Theorem 6); convert DRL → lex via FGLM; check shape
// position; factor g_n(x_n) and emit one solution per root. The
// system has two solutions: (x=1, y=2) and (x=2, y=1).
const mvSolveResult = await wb.solve({
  kind: "record",
  fields: {
    eqs: list([
      // x² + y² − 5 = 0
      expr("-", [
        expr("+", [
          expr("^", [sym("x"), int(2n)]),
          expr("^", [sym("y"), int(2n)]),
        ]),
        int(5n),
      ]),
      // x + y − 3 = 0
      expr("-", [expr("+", [sym("x"), sym("y")]), int(3n)]),
    ]),
    vars: list([sym("x"), sym("y")]),
  },
});
if (mvSolveResult.kind === "record") {
  const sols = mvSolveResult.fields["solutions"];
  if (sols?.kind === "list") {
    const summaries: string[] = [];
    for (const sol of sols.items) {
      if (sol.kind !== "record") continue;
      const bindings = sol.fields["bindings"];
      if (bindings?.kind !== "list") continue;
      const pieces: string[] = [];
      for (const b of bindings.items) {
        if (b.kind !== "record") continue;
        const v = b.fields["var"], val = b.fields["value"];
        if (v?.kind !== "symbol") continue;
        const valStr = val?.kind === "integer" ? val.value :
                       val?.kind === "rational" ? `${val.num}/${val.den}` :
                       "?";
        pieces.push(`${v.name}=${valStr}`);
      }
      summaries.push(`{${pieces.join(", ")}}`);
    }
    console.log(`  multivariate { x²+y²=5, x+y=3 }: ${summaries.join(", ")}`);
  }
}

// -----------------------------------------------------------------------------
// 17. poly-roots — symbolic roots over ℚ (radicals deg ≤ 4 + Root[] deg ≥ 5)
// -----------------------------------------------------------------------------
//
// Composes poly-factor with closed-form formulas for irreducible factors of
// degree ≤ 4: linear (rational), quadratic (discriminant), cubic (Cardano
// 1545), quartic (Ferrari 1540). Each root is an *exact symbolic*
// expression in `+ − * / ^ neg sqrt` — `(-1 + √5)/2`, not `0.6180...` — so
// it composes downstream with cas-diff / integrate-1d. The demo solves
// x² − x − 1 = 0 (golden ratio minimal poly) to showcase the radical
// surface.
//
// For irreducible factors of degree ≥ 5 (Galois 1832: no general radical
// formula), each *real* root is named by `Root[poly, k]` per ADR-0018 —
// the value-protocol primitive for an arbitrary algebraic number. The
// second probe runs Lehmer's L(x) = x⁵ + x⁴ − 4x³ − 3x² + 3x + 1 (the
// minimal polynomial of 2cos(2π/11) — totally real, irreducible) and
// shows the five Root[] values it returns.

console.log("\n" + "=".repeat(60));
console.log("  17. poly-roots — radicals (deg ≤ 4) + Root[] (deg ≥ 5)");
console.log("=".repeat(60));
console.log(
  "Cardano + Ferrari closed forms for deg ≤ 4; Root[poly, k] (ADR-0018)\n" +
  "for irreducible deg ≥ 5. Exact symbolic roots — composable.",
);
const phiPoly = await parseExpr("x^2 - x - 1");
const phiRoots = await wb.polyRoots({
  kind: "record",
  fields: { f: phiPoly as never, var: { kind: "symbol", name: "x" } },
});
if (phiRoots.kind === "record") {
  const roots = phiRoots.fields["roots"];
  if (roots?.kind === "list") {
    const renderRoot = (v: Value): string => {
      if (v.kind === "symbol") return v.name;
      if (v.kind === "integer") return v.value;
      if (v.kind === "rational") return `${v.num}/${v.den}`;
      if (v.kind === "expression") {
        // Parenthesise compound subterms (head ∈ {+, -}) when they appear
        // inside `/` or `^` numerators — `(1 + √5)/2` not `1 + √5/2`.
        const wrap = (a: Value): string => {
          const s = renderRoot(a);
          if (a.kind === "expression" && (a.head === "+" || a.head === "-")) return `(${s})`;
          return s;
        };
        if (v.head === "+") return v.args.map(renderRoot).join(" + ").replace(/\+ -/g, "- ");
        if (v.head === "-") return v.args.map(renderRoot).join(" − ");
        if (v.head === "*") return v.args.map(renderRoot).join("·");
        if (v.head === "/") return `${wrap(v.args[0]!)}/${wrap(v.args[1]!)}`;
        if (v.head === "^") return `${wrap(v.args[0]!)}^${renderRoot(v.args[1]!)}`;
        if (v.head === "neg") return `-${wrap(v.args[0]!)}`;
        if (v.head === "sqrt") return `√(${renderRoot(v.args[0]!)})`;
        return `<${v.head}>`;
      }
      return `<${v.kind}>`;
    };
    for (const entry of roots.items) {
      if (entry?.kind !== "record") continue;
      const root = entry.fields["root"];
      const mult = entry.fields["multiplicity"];
      if (root && mult?.kind === "integer") {
        console.log(`  root:  ${renderRoot(root)}   (multiplicity ${mult.value})`);
      }
    }
  }
}

// Lehmer probe — irreducible totally-real quintic ⟹ 5 Root[] values.
const lehmerPoly = await parseExpr("x^5 + x^4 - 4*x^3 - 3*x^2 + 3*x + 1");
const lehmerRoots = await wb.polyRoots({
  kind: "record",
  fields: { f: lehmerPoly as never, var: { kind: "symbol", name: "x" } },
});
if (lehmerRoots.kind === "record") {
  const roots = lehmerRoots.fields["roots"];
  const method = lehmerRoots.fields["method"];
  if (method?.kind === "string") {
    console.log(`\n  Lehmer L(x) = x⁵ + x⁴ − 4x³ − 3x² + 3x + 1   (method: ${method.value})`);
  }
  if (roots?.kind === "list") {
    for (const entry of roots.items) {
      if (entry?.kind !== "record") continue;
      const root = entry.fields["root"];
      if (root?.kind === "expression" && root.head === "Root") {
        const polyArg = root.args[0];
        const kArg = root.args[1];
        if (polyArg?.kind === "expression" && polyArg.head === "Polynomial" && kArg?.kind === "integer") {
          const coefs = polyArg.args
            .map((c) => (c.kind === "integer" ? c.value : "?"))
            .join(", ");
          console.log(`  Root[Polynomial[${coefs}], k=${kArg.value}]`);
        }
      }
    }
  }
}

// -----------------------------------------------------------------------------
// 17.5. alg-num-arith — field arithmetic over named algebraic numbers
// -----------------------------------------------------------------------------
//
// The wire envelope around `@workbench/alg-num`: takes one or two
// `Root[poly, k]` values and applies a chosen op (add / sub / mul /
// div / neg / inv / eq). The demo runs the ADR-0018 headline example
// `√2 + √3 ⟹ Root[x⁴ − 10x² + 1, k=3]` end-to-end through the
// composition layer.

console.log("\n" + "=".repeat(60));
console.log("  17.5. alg-num-arith — field arithmetic over Root[poly, k]");
console.log("=".repeat(60));
console.log(
  "ADR-0018 headline: √2 + √3 = Root[x⁴ − 10x² + 1, k=3]\n" +
  "(Sylvester-Bareiss resultant + canonicalise-by-interval; alg-num substrate).",
);
const sqrt2Root: Value = {
  kind: "expression",
  head: "Root",
  args: [
    {
      kind: "expression",
      head: "Polynomial",
      args: [
        { kind: "integer", value: "-2" },
        { kind: "integer", value: "0" },
        { kind: "integer", value: "1" },
      ],
    },
    { kind: "integer", value: "1" },
  ],
};
const sqrt3Root: Value = {
  kind: "expression",
  head: "Root",
  args: [
    {
      kind: "expression",
      head: "Polynomial",
      args: [
        { kind: "integer", value: "-3" },
        { kind: "integer", value: "0" },
        { kind: "integer", value: "1" },
      ],
    },
    { kind: "integer", value: "1" },
  ],
};
const algSum = await wb.algNumArith(
  { kind: "record", fields: { a: sqrt2Root, b: sqrt3Root } },
  { op: "add" },
);
if (algSum.kind === "expression" && algSum.head === "Root") {
  const polyArg = algSum.args[0];
  const kArg = algSum.args[1];
  if (polyArg?.kind === "expression" && polyArg.head === "Polynomial" && kArg?.kind === "integer") {
    const coefs = polyArg.args
      .map((c) => (c.kind === "integer" ? c.value : "?"))
      .join(", ");
    console.log(`  √2 + √3 = Root[Polynomial[${coefs}], k=${kArg.value}]`);
  }
}
const eqResult = await wb.algNumArith(
  { kind: "record", fields: { a: sqrt2Root, b: sqrt2Root } },
  { op: "eq" },
);
if (eqResult.kind === "boolean") {
  console.log(`  eq(+√2, +√2) = ${eqResult.value}`);
}

// -----------------------------------------------------------------------------
// 18. solve — transcendental lane with branched output (ADR-0017)
// -----------------------------------------------------------------------------
//
// The third dispatch lane: single-equation single-variable `head(arg) = c`
// for `head ∈ {sin, cos, tan, exp, log, sinh, cosh, tanh, abs}`. The v0.1
// invert table emits *branched* solutions with explicit integer-parameter
// symbols (`t_0, t_1, …`) — the workbench is *branch-honest*: it never
// silently returns a principal-branch slice. The demo runs sin(x) = 1/2
// and prints the two infinite-family solutions.

console.log("\n" + "=".repeat(60));
console.log("  18. solve — transcendental lane, branched output");
console.log("=".repeat(60));
console.log(
  "ADR-0017 finite-rep-of-infinite: sin(x) = 1/2 ⟹\n" +
  "  x = arcsin(1/2) + 2π·t_0   ∨   x = π − arcsin(1/2) + 2π·t_1.",
);
const transResult = await wb.solve({
  kind: "record",
  fields: {
    eqs: list([
      // sin(x) − 1/2
      expr("-", [expr("sin", [sym("x")]), { kind: "rational", num: "1", den: "2" }]),
    ]),
    vars: list([sym("x")]),
  },
});
if (transResult.kind === "record") {
  const completeness = transResult.fields["completeness"];
  if (completeness?.kind === "string") {
    console.log("  completeness:           ", completeness.value);
  }
  const sols = transResult.fields["solutions"];
  if (sols?.kind === "list") {
    const renderTrans = (v: Value): string => {
      if (v.kind === "symbol") return v.name;
      if (v.kind === "integer") return v.value;
      if (v.kind === "rational") return `${v.num}/${v.den}`;
      if (v.kind === "expression") {
        if (v.head === "+") return v.args.map(renderTrans).join(" + ").replace(/\+ -/g, "- ");
        if (v.head === "-") return v.args.map(renderTrans).join(" − ");
        if (v.head === "*") return v.args.map(renderTrans).join("·");
        if (v.head === "/") return `${renderTrans(v.args[0]!)}/${renderTrans(v.args[1]!)}`;
        if (v.head === "^") return `${renderTrans(v.args[0]!)}^${renderTrans(v.args[1]!)}`;
        if (v.head === "neg") return `-${renderTrans(v.args[0]!)}`;
        return `${v.head}(${v.args.map(renderTrans).join(", ")})`;
      }
      return `<${v.kind}>`;
    };
    for (const sol of sols.items) {
      if (sol.kind !== "record") continue;
      const bindings = sol.fields["bindings"];
      const branches = sol.fields["branches"];
      if (bindings?.kind !== "list" || branches?.kind !== "list") continue;
      const bind = bindings.items[0];
      if (bind?.kind !== "record") continue;
      const v = bind.fields["var"];
      const val = bind.fields["value"];
      if (v?.kind !== "symbol" || !val) continue;
      const branchSyms = branches.items.map((b) => b.kind === "symbol" ? b.name : "?").join(", ");
      console.log(`  ${v.name} = ${renderTrans(val)}    (branches: [${branchSyms}])`);
    }
  }
}

// -----------------------------------------------------------------------------
// Bonus — content-addressing
// -----------------------------------------------------------------------------

console.log("\n" + "=".repeat(60));
console.log("  Bonus — every byte everywhere is content-addressed");
console.log("=".repeat(60));
const h1 = hash(await parseExpr("x + 1"));
const h2 = hash(await parseExpr("1 + x"));
console.log("  hash of parsed 'x + 1':", h1);
console.log("  hash of parsed '1 + x':", h2);
console.log("  (different hashes — the trees differ; cas-simplify normalises both to the same form)");
const s1h = hash(await wb.casSimplify(await parseExpr("x + 1") as never));
const s2h = hash(await wb.casSimplify(await parseExpr("1 + x") as never));
console.log("  hash of simplify(x + 1):", s1h);
console.log("  hash of simplify(1 + x):", s2h);
console.log("  (same hash — cas-simplify makes them content-identical)");

// -----------------------------------------------------------------------------
// Speedup banner
// -----------------------------------------------------------------------------

const totalMs = Date.now() - t0;
console.log("\n" + "=".repeat(60));
console.log(`  Total wall-clock: ${totalMs} ms (${(totalMs / 1000).toFixed(2)}s)`);
console.log(`  (one bun process; ~${workbench.tools.size} tools loaded once and reused.`);
console.log(`  Subprocess equivalent — \`bash scripts/demo-scope.sh\` —`);
console.log(`  pays ~50ms × hops ≈ several seconds extra on the multi-step demos.`);
console.log("=".repeat(60));
