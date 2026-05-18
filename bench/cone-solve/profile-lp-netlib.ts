// =============================================================================
// bench/cone-solve/profile-lp-netlib.ts — the universal-tier honest profile
// =============================================================================
//
// `cone-solve` is the *universal* convex-cone solver of ADR-0030 §B — an
// SCS-style first-order method with a documented 1e-6 accuracy ceiling.
// The `lp-netlib` corpus suite verifies KKT residuals at a hard-coded
// 1e-8 relative tolerance: that is the *LP specialist's* gate, the bar
// `tools/lp-solve` is built to clear. Grading `cone-solve` against it
// (worklog 113) produced 0/21 — not a `cone-solve` bug, a category
// error. ADR-0037 records the reconciliation.
//
// This script is the artefact that replaces that mis-gate: it runs the
// 21 `lp-netlib` problems through `cone-solve` at the tool's *own*
// contract — `precision = 1e-6` — and reports the honest profile:
//
//   - `optimal`   — reached the 1e-6 ceiling within the iteration budget
//   - `iter-cap`  — budget exhausted; `achieved_precision` reported honestly
//   - `timeout`   — wall-clock budget exhausted (an iter-cap we didn't wait for)
//   - other       — wrong status, numerical breakdown, refusal (all bugs)
//
// For a universal first-order solver an honest `iter-cap` is *correct
// behaviour*, not a failure (ADR-0003: routine non-success is a
// record-with-flag, not a lie). The metric that matters is the
// optimal-rate at 1e-6 plus the two zero-tolerance honesty checks below.
// The optimal-rate is expected to climb as the algorithm gains the
// Type-I Anderson + Powell globalisation lever (bead filed; ADR-0036 §A
// names it the v0.2 move) — this script is how that progress is measured.
//
// ── the two honesty checks (zero-tolerance) ─────────────────────────────────
//
//   1. wrong-status — every lp-netlib case is a known-`optimal` problem
//      (expected.json: 21/21 optimal). A candidate status of
//      `infeasible` / `unbounded` / `numerical-breakdown` / a tagged
//      refusal is a hard bug. `optimal` / `iter-cap` / `timeout` are all
//      admissible — the last two say "I did not finish", honestly.
//
//   2. over-claimed-precision — the tool's reported `achieved_precision`
//      must not under-claim the *true* max relative KKT residual. This
//      script recomputes (r_p, r_d, r_c) independently from the
//      candidate's own (x, y, s) and the problem data — the same
//      residuals the corpus verifier's `self_reported_precision` check
//      recomputes — and verifies `achieved_precision ≥ recomputed / 2`
//      (the corpus's 2× slack absorbs float64 summation-order drift
//      between this recomputation and the tool's internal one). This is
//      the Rule-8 lie detector: a tool may be *more* honest than tight,
//      never less. NOTE this is distinct from the objective's distance
//      to the oracle optimum (`obj_rel_diff`, an informational column):
//      a ~1e-6 KKT residual consistently yields a few×1e-6 objective
//      error for a first-order method — that is expected, not a lie.
//
// It reuses the corpus bridge `benchmarks/lp-netlib/run-candidate.ts`
// verbatim (encode → `wb.run` → decode), only overriding the per-case
// `precision` and `max_iter`, so the wire path is byte-identical to the
// graded path — the profile measures the same tool the bench would.
//
// Usage:
//   bun bench/cone-solve/profile-lp-netlib.ts [--max-iter=N] [--timeout-ms=N] [--only=id,id,…] [--accelerator=type-ii|type-i]
//
// The `--accelerator` flag (ADR-0036 §F) mirrors `tools/cone-solve`'s
// own flag: select between the v0.1 AA-II (default) and the v0.2
// AA-I-S-m globalised path. Threaded to the corpus bridge via the
// `CANDIDATE_FLAGS` environment variable, which `run-candidate.ts`
// parses and passes to `wb.run` as the third (flags) argument.
//
// Determinism: `cone-solve` is `numerical: true` (ADR-0015) — the
// per-case status / iterations / achieved_precision are bit-identical
// given the platform fingerprint. Only `runtime_sec` varies run to run,
// so `--only` may be used to re-measure a subset (e.g. the timeouts)
// without disturbing the rest.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// ── locate the corpus suite ─────────────────────────────────────────────────
//
// The corpus is a sibling repo (worklog 027 / CLAUDE.md Rule 9). The
// golden inputs and the oracle consensus live there; this script reads
// them read-only and never writes corpus-side.

const CORPUS_ROOT =
  process.env["CORPUS_ROOT"] ??
  resolve(import.meta.dir, "..", "..", "..", "scientist-workbench-corpus");
const SUITE_ROOT = resolve(CORPUS_ROOT, "benchmarks", "lp-netlib");
const RUN_CANDIDATE = resolve(SUITE_ROOT, "run-candidate.ts");
const WORKBENCH_ROOT = resolve(import.meta.dir, "..", "..");

// ── flags ───────────────────────────────────────────────────────────────────

function intFlag(name: string, fallback: number): number {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (hit === undefined) return fallback;
  const v = Number(hit.slice(name.length + 3));
  if (!Number.isInteger(v) || v < 1) throw new Error(`--${name} must be a positive integer`);
  return v;
}

function listFlag(name: string): string[] | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (hit === undefined) return undefined;
  return hit
    .slice(name.length + 3)
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function enumFlag<T extends string>(
  name: string,
  values: readonly T[],
  fallback: T,
): T {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (hit === undefined) return fallback;
  const v = hit.slice(name.length + 3);
  if (!values.includes(v as T)) {
    throw new Error(`--${name} must be one of ${values.join("|")}; got '${v}'`);
  }
  return v as T;
}

const MAX_ITER = intFlag("max-iter", 50_000);
const TIMEOUT_MS = intFlag("timeout-ms", 60_000);
const ONLY = listFlag("only");
const ACCELERATOR = enumFlag("accelerator", ["type-ii", "type-i"] as const, "type-ii");
const PRECISION = 1e-6; // the cone-solve contract (ADR-0030 §B), not negotiable here

// ── golden + oracle consensus ───────────────────────────────────────────────

interface RawCase {
  id: string;
  input: {
    minimize: { c: number[] };
    subjectTo: { Ax_eq_b?: { A: number[][]; b: number[] }; cones: RawCone[] };
    precision?: number;
    max_iter?: number;
  };
}
interface RawCone {
  head: string;
  indices?: number[];
}
interface ExpectedCase {
  id: string;
  expected: { status: string; objective?: number };
}

const inputsDoc = JSON.parse(readFileSync(resolve(SUITE_ROOT, "golden", "inputs.json"), "utf8")) as {
  cases: RawCase[];
};
const expectedDoc = JSON.parse(
  readFileSync(resolve(SUITE_ROOT, "golden", "expected.json"), "utf8"),
) as { cases: ExpectedCase[] };
const expectedById = new Map(expectedDoc.cases.map((c) => [c.id, c.expected]));

// ── independent KKT recomputation (the Rule-8 lie detector) ─────────────────
//
// Recompute the three relative KKT residuals of ADR-0030 §C's form
// (`min cᵀx s.t. Ax = b, x ∈ 𝒦`, dual `Aᵀy + s = c`, `s ∈ 𝒦*`) directly
// from the candidate's own (x, y, s) and the problem data — the same
// residuals the corpus `verifier_protocol.md` defines (checks 4 / 6 / 7).
// Independent of anything the tool computed internally: if the tool's
// `achieved_precision` under-claims `max(r_p, r_d, r_c)` it is lying, and
// that is the one thing Rule 8 forbids unconditionally.

function infNorm(v: readonly number[]): number {
  let m = 0;
  for (const x of v) {
    const a = Math.abs(x);
    if (a > m) m = a;
  }
  return m;
}

interface KKT {
  rP: number; // ‖A·x − b‖_∞ / max(1, ‖b‖_∞)
  rD: number; // ‖Aᵀ·y + s − c‖_∞ / max(1, ‖c‖_∞)
  rC: number; // |xᵀ·s| / max(1, |cᵀ·x|)
  max: number;
}

function recomputeKKT(input: RawCase["input"], x: number[], y: number[], s: number[]): KKT | null {
  const c = input.minimize.c;
  const eq = input.subjectTo.Ax_eq_b;
  if (eq === undefined) return null; // no equality block — nothing to check here
  const { A, b } = eq;
  const m = A.length;
  const n = c.length;
  if (x.length !== n || s.length !== n || y.length !== m) return null;

  // r_p = ‖A·x − b‖_∞
  const ax = new Array<number>(m).fill(0);
  for (let i = 0; i < m; i++) {
    const row = A[i]!;
    let acc = 0;
    for (let j = 0; j < n; j++) acc += row[j]! * x[j]!;
    ax[i] = acc - b[i]!;
  }
  const rP = infNorm(ax) / Math.max(1, infNorm(b));

  // r_d = ‖Aᵀ·y + s − c‖_∞
  const aty = new Array<number>(n).fill(0);
  for (let i = 0; i < m; i++) {
    const row = A[i]!;
    const yi = y[i]!;
    for (let j = 0; j < n; j++) aty[j]! += row[j]! * yi;
  }
  const rd = new Array<number>(n);
  for (let j = 0; j < n; j++) rd[j] = aty[j]! + s[j]! - c[j]!;
  const rD = infNorm(rd) / Math.max(1, infNorm(c));

  // r_c = |xᵀ·s| / max(1, |cᵀ·x|)
  let xs = 0;
  let cx = 0;
  for (let j = 0; j < n; j++) {
    xs += x[j]! * s[j]!;
    cx += c[j]! * x[j]!;
  }
  const rC = Math.abs(xs) / Math.max(1, Math.abs(cx));

  return { rP, rD, rC, max: Math.max(rP, rD, rC) };
}

// ── per-case run through the corpus bridge ──────────────────────────────────

interface CandidateRecord {
  status?: string;
  x?: number[];
  dual?: number[];
  slack?: number[];
  objective?: number;
  achieved_precision?: number;
  iterations?: number;
  kind?: string; // present iff tagged refusal
  tag?: string;
}

interface Row {
  id: string;
  m: number;
  n: number;
  status: string; // candidate status, or "tagged:<tag>" / "timeout" / "error"
  iterations: number | null;
  achievedPrecision: number | null;
  recomputedKKT: number | null; // independent max(r_p, r_d, r_c)
  objectiveDiff: number | null; // |candidate − consensus| / max(1, |consensus|) — informational
  runtimeSec: number;
}

async function runCase(rc: RawCase): Promise<Row> {
  const A = rc.input.subjectTo.Ax_eq_b?.A ?? [];
  const m = A.length;
  const n = rc.input.minimize.c.length;

  // The graded path verbatim — only precision + max_iter overridden to
  // the cone-solve contract. run-candidate.ts reads both off the raw
  // input record (ADR-0030 §C optional fields).
  const rawInput = { ...rc.input, precision: PRECISION, max_iter: MAX_ITER };

  const t0 = performance.now();
  // CANDIDATE_FLAGS is the env-var protocol the corpus bridge accepts
  // for passing tool flags through to `wb.run(tool, value, flags)`.
  // Format: `key1=value1,key2=value2,…` (ADR-0036 §F bench wiring).
  // Here we forward only the accelerator flag; the bridge tolerates
  // an unknown key with a clean throw.
  const candidateFlags = `accelerator=${ACCELERATOR}`;
  const proc = Bun.spawn(["bun", "run", RUN_CANDIDATE], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    cwd: WORKBENCH_ROOT,
    env: {
      ...process.env,
      CANDIDATE_TOOL: "cone-solve",
      CANDIDATE_FLAGS: candidateFlags,
      WORKBENCH_ROOT,
    },
  });
  proc.stdin.write(JSON.stringify(rawInput));
  await proc.stdin.end();

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      proc.kill();
    } catch {
      /* already gone */
    }
  }, TIMEOUT_MS);
  const exit = await proc.exited;
  clearTimeout(timer);
  const runtimeSec = (performance.now() - t0) / 1000;

  const base = { id: rc.id, m, n, runtimeSec };
  const fail = (status: string): Row => ({
    ...base,
    status,
    iterations: null,
    achievedPrecision: null,
    recomputedKKT: null,
    objectiveDiff: null,
  });

  if (timedOut) return fail("timeout");

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  if (exit !== 0) {
    process.stderr.write(`  [${rc.id}] candidate exited ${exit}: ${stderr.slice(0, 300)}\n`);
    return fail("error");
  }

  let rec: CandidateRecord;
  try {
    rec = JSON.parse(stdout) as CandidateRecord;
  } catch {
    return fail("error");
  }

  if (rec.kind === "tagged") return fail(`tagged:${rec.tag ?? "?"}`);

  // Independent KKT recomputation from the candidate's own (x, y, s).
  let recomputedKKT: number | null = null;
  if (rec.x !== undefined && rec.dual !== undefined && rec.slack !== undefined) {
    recomputedKKT = recomputeKKT(rc.input, rec.x, rec.dual, rec.slack)?.max ?? null;
  }

  const exp = expectedById.get(rc.id);
  let objectiveDiff: number | null = null;
  if (rec.objective !== undefined && exp?.objective !== undefined) {
    objectiveDiff = Math.abs(rec.objective - exp.objective) / Math.max(1, Math.abs(exp.objective));
  }

  return {
    ...base,
    status: rec.status ?? "?",
    iterations: rec.iterations ?? null,
    achievedPrecision: rec.achieved_precision ?? null,
    recomputedKKT,
    objectiveDiff,
  };
}

// ── run the suite ───────────────────────────────────────────────────────────

const cases = ONLY ? inputsDoc.cases.filter((c) => ONLY.includes(c.id)) : inputsDoc.cases;
if (ONLY && cases.length !== ONLY.length) {
  const found = new Set(cases.map((c) => c.id));
  const missing = ONLY.filter((id) => !found.has(id));
  throw new Error(`--only named unknown case(s): ${missing.join(", ")}`);
}

process.stderr.write(
  `cone-solve × lp-netlib — universal-tier profile @ precision=${PRECISION}, ` +
    `max_iter=${MAX_ITER}, timeout=${TIMEOUT_MS}ms, accelerator=${ACCELERATOR}` +
    (ONLY ? `, only=${ONLY.join(",")}` : "") +
    `\n`,
);

const rows: Row[] = [];
for (const rc of cases) {
  process.stderr.write(`  running ${rc.id} …\n`);
  rows.push(await runCase(rc));
}

// ── report ──────────────────────────────────────────────────────────────────

function fmt(x: number | null, digits = 2): string {
  if (x === null) return "—";
  if (x === 0) return "0";
  if (!Number.isFinite(x)) return x > 0 ? "+inf" : "-inf";
  return x.toExponential(digits);
}

const HEADER = ["case", "m", "n", "status", "iters", "claimed_prec", "recomp_kkt", "obj_diff", "sec"];
const widths = [12, 5, 5, 12, 8, 13, 13, 11, 7];
const line = (cells: (string | number)[]): string =>
  cells.map((c, i) => String(c).padEnd(widths[i]!)).join(" ");

process.stdout.write(line(HEADER) + "\n");
process.stdout.write(widths.map((w) => "-".repeat(w)).join(" ") + "\n");
for (const r of rows) {
  process.stdout.write(
    line([
      r.id,
      r.m,
      r.n,
      r.status,
      r.iterations ?? "—",
      fmt(r.achievedPrecision),
      fmt(r.recomputedKKT),
      fmt(r.objectiveDiff),
      r.runtimeSec.toFixed(1),
    ]) + "\n",
  );
}

// ── summary + the two honesty checks ────────────────────────────────────────

const optimal = rows.filter((r) => r.status === "optimal");
const iterCap = rows.filter((r) => r.status === "iter-cap");
const timeout = rows.filter((r) => r.status === "timeout");
const other = rows.filter(
  (r) => r.status !== "optimal" && r.status !== "iter-cap" && r.status !== "timeout",
);

// Check 1 — no status is ever wrong (see the header prose).
const wrongStatus = rows.filter(
  (r) =>
    r.status === "infeasible" ||
    r.status === "unbounded" ||
    r.status === "numerical-breakdown" ||
    r.status.startsWith("tagged:") ||
    r.status === "error",
);

// Check 2 — `achieved_precision` never under-claims the independently
// recomputed KKT residual (the corpus `self_reported_precision` check,
// with the same 2× slack for summation-order drift). Applies wherever
// both numbers exist — `optimal` always, `iter-cap` when the tool
// carried a best-effort `achieved_precision`.
const overClaimed = rows.filter(
  (r) =>
    r.achievedPrecision !== null &&
    r.recomputedKKT !== null &&
    r.achievedPrecision < r.recomputedKKT / 2,
);

process.stdout.write("\n");
process.stdout.write(
  `profile @ precision=${PRECISION}, max_iter=${MAX_ITER}, accelerator=${ACCELERATOR}\n`,
);
process.stdout.write(
  `  optimal   ${optimal.length}/${rows.length}  (reached the 1e-6 ceiling within budget)\n`,
);
process.stdout.write(`  iter-cap  ${iterCap.length}/${rows.length}  (honest non-convergence)\n`);
process.stdout.write(`  timeout   ${timeout.length}/${rows.length}  (exceeded ${TIMEOUT_MS}ms)\n`);
if (other.length > 0) {
  process.stdout.write(
    `  other     ${other.length}/${rows.length}  (${other.map((r) => `${r.id}:${r.status}`).join(", ")})\n`,
  );
}
process.stdout.write("\n");
process.stdout.write(`honesty checks (zero-tolerance — these must all be 0):\n`);
process.stdout.write(
  `  wrong-status            ${wrongStatus.length}` +
    (wrongStatus.length > 0
      ? `  ✗ ${wrongStatus.map((r) => `${r.id}:${r.status}`).join(", ")}`
      : "  ✓") +
    "\n",
);
process.stdout.write(
  `  over-claimed-precision  ${overClaimed.length}` +
    (overClaimed.length > 0
      ? `  ✗ ${overClaimed
          .map((r) => `${r.id} (claimed ${fmt(r.achievedPrecision)} < kkt ${fmt(r.recomputedKKT)})`)
          .join(", ")}`
      : "  ✓") +
    "\n",
);

const honest = wrongStatus.length === 0 && overClaimed.length === 0;
process.stdout.write(
  `\n${honest ? "✓ honest-tier conformance holds" : "✗ honest-tier conformance VIOLATED — this is a bug"}` +
    ` — optimal-rate ${optimal.length}/${rows.length} @ 1e-6\n`,
);

process.exit(honest ? 0 : 1);
