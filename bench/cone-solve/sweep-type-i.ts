// =============================================================================
// bench/cone-solve/sweep-type-i.ts — AA-I-S-m hyper-parameter sweep
// =============================================================================
//
// Intent
// ------
// The just-landed Type-I Anderson port (ADR-0036 §F, `packages/cone-core/
// src/anderson-type-i.ts`) regresses the lp-netlib optimal-rate at the
// paper-default hyper-parameters `(m, θ̄, τ, α, D, ε) = (5, 0.01, 0.001,
// 0.1, 1e6, 1e-6)`: AA-II reaches 5/21 optima, AA-I (defaults) reaches
// 1/21 — four problems regressed (blend, sc50a, sc50b, scsd1), none
// gained. The implementation itself is mutation-proven (Powell + GS-
// restart + KM-safeguard test under `bun test`); the question this script
// answers is *not* "is the algorithm correct" but **"does any
// hyper-parameter setting earn the algorithm its keep on lp-netlib?"**.
//
// The sweep targets the three smallest problems where AA-II *iter-caps*
// — i.e. AA-II almost-but-not-quite reaches the 1e-6 ceiling at 50k
// iterations. These are the problems where an acceleration lever *might*
// help. (Problems where AA-II already reaches optimal don't need help;
// problems where AA-II timeouts at 60s dominate the sweep without
// shedding light.) The three:
//
//   kb2       m=52, n=77   — AA-II final residual 1.25e-3
//   adlittle  m=56, n=138  — AA-II final residual 1.06e-5
//   sc105     m=105, n=163 — AA-II final residual 1.74e-2
//
// Hyper-parameter grid — 3 × 3 × 3 = 27 AA-I configs per problem, plus
// the AA-II baseline (memory=10) as the fourth column:
//
//   memory       ∈ {5, 10, 20}
//   kmAlpha      ∈ {0.1, 0.5, 0.9}
//   safeguardEps ∈ {1e-6, 1e-3, 0.5}
//
// Other knobs held at paper defaults: `thetaBar = 0.01`, `tau = 0.001`,
// `safeguardD = 1e6`. 28 runs × 3 problems = 84 runs total.
//
// Wire-bypass
// -----------
// The sweep calls `scsSolve` directly via the cone-core substrate —
// bypassing the `bun tools/cone-solve/tool.ts` subprocess entry — to
// keep the inner loop cheap (no per-run spawn floor, no JSON encode /
// decode). The raw lp-netlib JSON (`number[][]`, `number[]`) is
// translated directly to `ConeProblem` using the algebra documented in
// `tools/cone-solve/tool.ts` lines 78-92:
//
//   §C   min cᵀx s.t. A x = b, x ∈ 𝒦                     (wire form)
//   →    min c'ᵀx' s.t. A' x' + s' = b', (x', s') ∈ ℝⁿ × 𝒦'  (O'Donoghue)
//
//   with c' = c, A' = [A ; S], b' = [b ; 0], cones' = [zero(m), …𝒦]
//   where S has one `−eⱼ` row per index `j` the cone covers.
//
// Free variables contribute no cone row (`x'` is already free in the
// O'Donoghue form). This mirrors `translate(decoded, blocks)` in
// `tool.ts` exactly — same algebra, lifted into raw arrays.
//
// `achievedPrecision` is read off cone-core's `SCSResult` directly: this
// is the embedded-form §3.5 residual, *not* the §C-wire-form residual
// the tool's `convergenceTest` hook is denominated in (bead `oxuk`,
// rgl8). The difference matters at the 1e-6 boundary but not for the
// sweep's purpose — we are looking for *orders-of-magnitude* gaps
// between configs, not 2× factors. (If a config lands `status: optimal`
// at a 1e-6 embedded residual, it is "basically converged" for this
// sweep's purposes; the tool's wire-form gating is a finer question.)
// Also captured: `iterations`, wall time, and whether the run reached
// `optimal` / `iter-cap` / `numerical-breakdown`.
//
// Per-run budget: `maxIter = 50000`, `precision = 1e-6`, no wall-clock
// timeout (the sweep metric is iteration efficiency; allow each run to
// take its natural wall time, worst case ~40s per iter-cap = ~55 min for
// the whole sweep).
//
// Usage:
//   bun bench/cone-solve/sweep-type-i.ts > /tmp/sweep-type-i.csv
//
// The script prints a CSV table to stdout (machine-readable) and a
// summary block to stderr (human-readable). Headline verdict at the
// end of stderr.
//
// References:
//   - Algorithm:   docs/ground-truth/convex/anderson-acceleration.md §7
//   - Paper:       docs/refs/zhang-odonoghue-boyd-2018-type-i-anderson.pdf
//   - ADR-0036 §F: the Type-I lever rationale
//   - Worklog:     docs/worklog/NNN-*.md (the lp-netlib regression shard)
//   - Implementation: packages/cone-core/src/anderson-type-i.ts

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  type AndersonSpec,
  type Cone,
  type ConeProblem,
  type SCSResult,
  nonNeg,
  scsSolve,
  zero,
  DEFAULT_SCS_OPTS,
} from "@workbench/cone-core";
import { matrixFromRows } from "@workbench/linalg-core";

// ── corpus location ──────────────────────────────────────────────────────────

const CORPUS_ROOT =
  process.env["CORPUS_ROOT"] ??
  resolve(import.meta.dir, "..", "..", "..", "scientist-workbench-corpus");
const INPUTS_JSON = resolve(
  CORPUS_ROOT,
  "benchmarks",
  "lp-netlib",
  "golden",
  "inputs.json",
);

// ── raw-JSON shapes (a strict subset of the lp-netlib goldens) ───────────────

interface RawCone {
  readonly head: string;
  readonly indices?: readonly number[];
}
interface RawInput {
  readonly minimize: { readonly c: readonly number[] };
  readonly subjectTo: {
    readonly Ax_eq_b?: {
      readonly A: readonly (readonly number[])[];
      readonly b: readonly number[];
    };
    readonly cones: readonly RawCone[];
  };
  readonly precision?: number;
  readonly max_iter?: number;
}
interface RawCase {
  readonly id: string;
  readonly input: RawInput;
}

// ── §C → O'Donoghue translation, lifted from tools/cone-solve/tool.ts ────────
//
// The algebra mirrors `translate(decoded, blocks)` in `tool.ts`:
//
//   - equality block: rows = A, rhs = b, cone = zero(m)
//   - cone block (per supported cone): one `−eⱼ` row per index `j`,
//     rhs = 0, cone-core cone = nonNeg / zero / (no row for free)
//
// We support only the LP-complete subset (`NonNegCone`, `ZeroCone`,
// `FreeCone`) — the lp-netlib corpus has nothing else. Anything else
// throws, since the sweep does not need to be defensive on input shape.

function translateRaw(rc: RawInput): ConeProblem {
  const c = rc.minimize.c.slice() as number[];
  const n = c.length;
  const rows: number[][] = [];
  const bPrime: number[] = [];
  const cones: Cone[] = [];

  const eq = rc.subjectTo.Ax_eq_b;
  if (eq !== undefined) {
    for (let i = 0; i < eq.A.length; i++) rows.push(eq.A[i]!.slice() as number[]);
    for (const v of eq.b) bPrime.push(v);
    if (eq.b.length > 0) cones.push(zero(eq.b.length));
  }

  for (const k of rc.subjectTo.cones) {
    const idx = k.indices ?? [];
    switch (k.head) {
      case "FreeCone":
        // no cone row — x' is already free in O'Donoghue form
        break;
      case "NonNegCone":
      case "ZeroCone": {
        for (const j of idx) {
          const row = new Array<number>(n).fill(0);
          row[j] = -1;
          rows.push(row);
          bPrime.push(0);
        }
        cones.push(k.head === "NonNegCone" ? nonNeg(idx.length) : zero(idx.length));
        break;
      }
      default:
        throw new Error(`sweep: unsupported cone head ${k.head} (lp-netlib should not have this)`);
    }
  }

  if (rows.length === 0) {
    throw new Error("sweep: degenerate problem with no constraints");
  }

  return {
    A: matrixFromRows(rows),
    b: new Float64Array(bPrime),
    c: new Float64Array(c),
    cones,
  };
}

// ── the sweep grid ───────────────────────────────────────────────────────────

interface ConfigAAI {
  readonly accelerator: "type-i";
  readonly memory: number;
  readonly kmAlpha: number;
  readonly safeguardEps: number;
}
interface ConfigAAII {
  readonly accelerator: "type-ii";
  readonly memory: number;
}
type Config = ConfigAAI | ConfigAAII;

const TARGETS = ["kb2", "adlittle", "sc105"] as const;
const MEMORY_GRID = [5, 10, 20] as const;
const KM_ALPHA_GRID = [0.1, 0.5, 0.9] as const;
const SAFEGUARD_EPS_GRID = [1e-6, 1e-3, 0.5] as const;
// Fixed at paper defaults — the three axes the sweep does *not* vary.
const FIXED_THETA_BAR = 0.01;
const FIXED_TAU = 0.001;
const FIXED_SAFEGUARD_D = 1e6;

const MAX_ITER = 50_000;
const PRECISION = 1e-6;

function buildConfigs(): Config[] {
  const out: Config[] = [];
  // AA-II baseline (workbench default memory)
  out.push({ accelerator: "type-ii", memory: 10 });
  // AA-I grid
  for (const m of MEMORY_GRID) {
    for (const a of KM_ALPHA_GRID) {
      for (const eps of SAFEGUARD_EPS_GRID) {
        out.push({ accelerator: "type-i", memory: m, kmAlpha: a, safeguardEps: eps });
      }
    }
  }
  return out;
}

function specOf(cfg: Config): AndersonSpec {
  if (cfg.accelerator === "type-ii") return { kind: "type-ii", memory: cfg.memory };
  return {
    kind: "type-i",
    memory: cfg.memory,
    thetaBar: FIXED_THETA_BAR,
    tau: FIXED_TAU,
    kmAlpha: cfg.kmAlpha,
    safeguardD: FIXED_SAFEGUARD_D,
    safeguardEps: cfg.safeguardEps,
  };
}

// ── one (problem, config) run ────────────────────────────────────────────────

interface RunResult {
  readonly problem: string;
  readonly cfg: Config;
  readonly status: SCSResult["status"] | "error";
  readonly iterations: number | null;
  /** cone-core's embedded-form §3.5 residual; undefined on infeasible/unbounded. */
  readonly achievedPrecision: number | null;
  readonly wallMs: number;
  readonly errorDetail?: string;
}

function runOne(problem: string, problemInstance: ConeProblem, cfg: Config): RunResult {
  const spec = specOf(cfg);
  // CLAUDE.md Rule 1: when `accelerator` is explicit we must hand it the
  // *default* `andersonMemory` sentinel — `scsSolve` throws otherwise.
  // `DEFAULT_SCS_OPTS.alpha` is the SCS over-relaxation, the same value
  // the production tool passes.
  const opts = {
    precision: PRECISION,
    maxIter: MAX_ITER,
    alpha: DEFAULT_SCS_OPTS.alpha,
    andersonMemory: DEFAULT_SCS_OPTS.andersonMemory,
    accelerator: spec,
  };
  const t0 = performance.now();
  try {
    const r = scsSolve(problemInstance, opts);
    const wallMs = performance.now() - t0;
    const achievedPrecision =
      r.status === "optimal" || r.status === "iter-cap" ? r.achievedPrecision : null;
    return {
      problem,
      cfg,
      status: r.status,
      iterations: r.iterations,
      achievedPrecision,
      wallMs,
    };
  } catch (e) {
    const wallMs = performance.now() - t0;
    return {
      problem,
      cfg,
      status: "error",
      iterations: null,
      achievedPrecision: null,
      wallMs,
      errorDetail: e instanceof Error ? e.message : String(e),
    };
  }
}

// ── CSV emit ─────────────────────────────────────────────────────────────────

function fmtNum(x: number | null): string {
  if (x === null) return "";
  if (!Number.isFinite(x)) return x > 0 ? "+inf" : "-inf";
  if (x === 0) return "0";
  return x.toExponential(4);
}

function cfgKey(cfg: Config): string {
  if (cfg.accelerator === "type-ii") return `type-ii,m=${cfg.memory}`;
  return `type-i,m=${cfg.memory},alpha=${cfg.kmAlpha},eps=${cfg.safeguardEps}`;
}

function emitCsvHeader(): void {
  process.stdout.write(
    "problem,accelerator,memory,kmAlpha,safeguardEps,status,iters,achieved_precision,wall_ms\n",
  );
}

function emitCsvRow(r: RunResult): void {
  const cfg = r.cfg;
  const memory = cfg.memory;
  const kmAlpha = cfg.accelerator === "type-i" ? cfg.kmAlpha : "";
  const safeguardEps = cfg.accelerator === "type-i" ? cfg.safeguardEps : "";
  process.stdout.write(
    [
      r.problem,
      cfg.accelerator,
      memory,
      kmAlpha,
      safeguardEps,
      r.status,
      r.iterations ?? "",
      fmtNum(r.achievedPrecision),
      r.wallMs.toFixed(1),
    ].join(",") + "\n",
  );
}

// ── main ─────────────────────────────────────────────────────────────────────

function main(): void {
  process.stderr.write(
    `sweep-type-i: loading lp-netlib goldens from ${INPUTS_JSON}\n`,
  );
  const doc = JSON.parse(readFileSync(INPUTS_JSON, "utf8")) as { cases: RawCase[] };
  const byId = new Map(doc.cases.map((c) => [c.id, c]));
  for (const id of TARGETS) {
    if (!byId.has(id)) throw new Error(`sweep: target problem '${id}' missing from goldens`);
  }

  const configs = buildConfigs();
  process.stderr.write(
    `sweep-type-i: ${TARGETS.length} problems × ${configs.length} configs = ` +
      `${TARGETS.length * configs.length} runs @ maxIter=${MAX_ITER}, precision=${PRECISION}\n`,
  );

  emitCsvHeader();
  const results: RunResult[] = [];

  for (const id of TARGETS) {
    const rc = byId.get(id)!;
    const problemInstance = translateRaw(rc.input);
    process.stderr.write(`\n── ${id} (m=${rc.input.subjectTo.Ax_eq_b?.A.length ?? 0}, n=${rc.input.minimize.c.length}) ──\n`);
    for (const cfg of configs) {
      const t0 = performance.now();
      const r = runOne(id, problemInstance, cfg);
      const dt = performance.now() - t0;
      emitCsvRow(r);
      results.push(r);
      process.stderr.write(
        `  ${cfgKey(cfg).padEnd(46)}  status=${r.status.padEnd(20)}  iters=${(r.iterations ?? "—").toString().padStart(6)}  prec=${fmtNum(r.achievedPrecision).padStart(12)}  wall=${dt.toFixed(0)}ms\n`,
      );
    }
  }

  // ── summary ────────────────────────────────────────────────────────────────

  process.stderr.write("\n");
  process.stderr.write("══════════════════════════════════════════════════════════\n");
  process.stderr.write("SUMMARY\n");
  process.stderr.write("══════════════════════════════════════════════════════════\n");

  const aaiResults = results.filter((r) => r.cfg.accelerator === "type-i");
  const optimalAAI = aaiResults.filter((r) => r.status === "optimal");
  process.stderr.write(
    `\nAA-I configs reaching status="optimal": ${optimalAAI.length} / ${aaiResults.length}\n`,
  );

  for (const id of TARGETS) {
    const baseline = results.find(
      (r) => r.problem === id && r.cfg.accelerator === "type-ii",
    )!;
    const aaiForProblem = aaiResults.filter((r) => r.problem === id);
    const aaiOptimal = aaiForProblem.filter((r) => r.status === "optimal");
    const aaiBestByPrec = [...aaiForProblem].sort((a, b) => {
      const pa = a.achievedPrecision ?? Infinity;
      const pb = b.achievedPrecision ?? Infinity;
      return pa - pb;
    });
    const best = aaiBestByPrec[0];

    process.stderr.write(`\n── ${id} ──\n`);
    process.stderr.write(
      `  AA-II baseline:   status=${baseline.status}  iters=${baseline.iterations}  ` +
        `prec=${fmtNum(baseline.achievedPrecision)}  wall=${baseline.wallMs.toFixed(0)}ms\n`,
    );
    if (aaiOptimal.length > 0) {
      const fastest = [...aaiOptimal].sort(
        (a, b) => (a.iterations ?? Infinity) - (b.iterations ?? Infinity),
      )[0]!;
      process.stderr.write(
        `  AA-I optimal:     ${aaiOptimal.length}/27 configs converged; fastest = ${cfgKey(fastest.cfg)} @ ${fastest.iterations} iters\n`,
      );
    } else {
      process.stderr.write(`  AA-I optimal:     0/27 configs reached the 1e-6 ceiling\n`);
    }
    if (best !== undefined) {
      process.stderr.write(
        `  AA-I best resid:  ${cfgKey(best.cfg)}  status=${best.status}  ` +
          `iters=${best.iterations}  prec=${fmtNum(best.achievedPrecision)}\n`,
      );
      const baselinePrec = baseline.achievedPrecision ?? Infinity;
      const bestPrec = best.achievedPrecision ?? Infinity;
      const ratio = baselinePrec / bestPrec;
      process.stderr.write(
        `  gap vs baseline:  AA-II prec ${fmtNum(baselinePrec)} / AA-I best prec ${fmtNum(bestPrec)} = ratio ${ratio.toFixed(2)}× ` +
          `(>1 = AA-I improved)\n`,
      );
    }
    // Watch the kb2 blow-up: report whether any config tames it below
    // 1e-2 (the order of magnitude AA-II reaches on the other targets).
    if (id === "kb2") {
      const tamed = aaiForProblem.filter(
        (r) => r.achievedPrecision !== null && r.achievedPrecision < 1e-2,
      );
      process.stderr.write(
        `  kb2 blow-up tame: ${tamed.length}/27 configs reach prec < 1e-2 ` +
          `(default AA-I prec was 5.22e+1 — 50,000× worse than AA-II)\n`,
      );
    }
  }

  // ── headline verdict ──────────────────────────────────────────────────────

  process.stderr.write("\n══════════════════════════════════════════════════════════\n");
  const problemsWithAnyOptimal = new Set(optimalAAI.map((r) => r.problem));
  process.stderr.write(
    `HEADLINE: ${optimalAAI.length}/${aaiResults.length} AA-I configs reached optimal, ` +
      `covering ${problemsWithAnyOptimal.size}/${TARGETS.length} of the targeted iter-cap problems.\n`,
  );
  process.stderr.write("══════════════════════════════════════════════════════════\n");
}

main();
