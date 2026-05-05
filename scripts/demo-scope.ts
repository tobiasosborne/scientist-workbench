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
