// =============================================================================
// scripts/sdplib-stress.ts — full-SDPLIB stress test for tools/sdp-solve
// =============================================================================
//
// Background
// ----------
// Bead `jb1x`. The corpus repo (`scientist-workbench-corpus/benchmarks/
// sdp-sdplib/`) currently ships 6 graded cases — control1/2/3, hinf2,
// theta1, mcp100. SDPLIB itself has ~92 problems. This script is a
// **broader stress test** of the `tools/sdp-solve` wire: read every
// `.dat-s` under `$SDPLIB_DIR`, filter by `m ≤ M_CAP` (default 500;
// the substrate's dense Schur Cholesky scales as O(m³), so problems
// above that are pre-Phase-6-bigfloat / pre-sparse-linalg territory),
// pipe each through the tool with both `--method=nt` (legacy default)
// and `--method=hsde-nt` (the Phase 3 HSDE port). Per-problem verbose
// JSONL trace lands under `$TRACES_DIR`; tabular summary lands in CSV.
//
// Why this script exists alongside the corpus grader
// --------------------------------------------------
// The corpus grader (`bun src/cli.ts grade scientist-workbench
// sdp-sdplib`) runs the 6 selected cases through a Mosek + COPT
// dual-witness oracle. That's *evaluation*. This script is
// *characterisation* — broader coverage, no oracle, A/B between
// methods. It produces the raw data; the oracle is a separate
// (slow, costly) concern.
//
// What "stress" means here
// ------------------------
// For each (case, method) pair we record:
//   - status:     optimal / iter-cap / numerical-breakdown / timeout / tagged-refusal
//   - iter:       iteration count at exit
//   - ap:         achieved_precision (max(rpWire, rdWire, rcWire), the wire-frame
//                                     residual the corpus verifier uses)
//   - pObj:       primal objective in SDPLIB convention (max <C, X>, sign-flipped
//                                                       internally to min)
//   - wall_ms:    wall-clock from spawn to stdout-close
//
// Trace flush mode
// ----------------
// The tool's stderr verbose path is `writeSync(2, formatVerboseLine(line))`
// per iter — eager, syscall-per-iter, survives mid-iter crash. JSONL
// mirror via `IPM_TRACE_JSONL=<path>` is similarly synchronous. Both
// are wired by default; no extra config needed.
//
// Usage
// -----
//   SDPLIB_DIR=/tmp/sdplib/sdplib bun scripts/sdplib-stress.ts
//
// Env knobs (all optional):
//   SDPLIB_DIR   path to the raw .dat-s tarball expansion (default
//                "/tmp/sdplib/sdplib")
//   TRACES_DIR   where per-(case, method) JSONL traces go (default
//                "/tmp/sdplib-stress-traces")
//   RESULTS_CSV  where the tabular summary goes (default
//                "scripts/sdplib-stress-results.csv")
//   M_CAP        max constraints m to admit (default 500)
//   COST_CAP     max rough per-iter cost m²·max_n² + m³ (default Infinity)
//   TIMEOUT_MS   per-(case, method) wall timeout (default 90000)
//   METHODS      comma-separated list (default "nt,hsde-nt")
//
// CSV columns:
//   case,method,m,maxn,status,iter,ap,pObj,wall_ms

import {
  readFileSync,
  readdirSync,
  mkdirSync,
  existsSync,
  appendFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import {
  parseSdpaSparse,
  convertSdpaToSdp,
  type SdpProblem,
  type SdpaSparseProblem,
} from "@workbench/solver-ipm";
import { float64FromNumber, int, list, record, expr } from "@workbench/protocol";

// -----------------------------------------------------------------------------
// Config
// -----------------------------------------------------------------------------

const SDPLIB_DIR = process.env["SDPLIB_DIR"] ?? "/tmp/sdplib/sdplib";
const TRACES_DIR = process.env["TRACES_DIR"] ?? "/tmp/sdplib-stress-traces";
const RESULTS_CSV =
  process.env["RESULTS_CSV"] ?? "scripts/sdplib-stress-results.csv";
const M_CAP = Number(process.env["M_CAP"] ?? 500);
const COST_CAP = Number(process.env["COST_CAP"] ?? Number.POSITIVE_INFINITY);
const TIMEOUT_MS = Number(process.env["TIMEOUT_MS"] ?? 90_000);
const METHODS = (process.env["METHODS"] ?? "nt,hsde-nt").split(",");

const TOOL_PATH = "tools/sdp-solve/tool.ts";

// -----------------------------------------------------------------------------
// Triage — parse + filter
// -----------------------------------------------------------------------------

interface TriageRow {
  name: string;
  path: string;
  m: number;
  maxn: number;
  cost: number;
  sparse: SdpaSparseProblem;
}

function triage(): TriageRow[] {
  const out: TriageRow[] = [];
  for (const f of readdirSync(SDPLIB_DIR)) {
    if (!f.endsWith(".dat-s")) continue;
    const path = join(SDPLIB_DIR, f);
    try {
      const text = readFileSync(path, "utf-8");
      const sparse = parseSdpaSparse(text);
      const maxn = sparse.blockSizes.reduce(
        (a, n) => Math.max(a, Math.abs(n)),
        0,
      );
      const m = sparse.m;
      const cost = m * m * maxn * maxn + m * m * m;
      if (m <= M_CAP && cost <= COST_CAP) {
        out.push({ name: f.replace(/\.dat-s$/, ""), path, m, maxn, cost, sparse });
      }
    } catch (e) {
      console.error(`triage parse-fail ${f}: ${(e as Error).message}`);
    }
  }
  out.sort((a, b) => a.cost - b.cost);
  return out;
}

// -----------------------------------------------------------------------------
// SdpProblem → wire (the inverse of `buildSdpProblem` in tools/sdp-solve)
// -----------------------------------------------------------------------------
//
// The tool's wire shape (ADR-0030 §C with PSDCone):
//   minimize:  { c: float64[] }
//   subjectTo: { Ax_eq_b: { A: float64[][], b: float64[] }, cones: [PSDCone, ...] }
//
// Each PSD block b contributes svec_len(n_b) = n_b · (n_b + 1) / 2 entries
// to the global n-vector. We assign indices [offset_b .. offset_b + svec_len - 1]
// per block in declaration order; the cone declares (size, indices).
//
// svec uses the Mosek √2 off-diagonal scaling so `<C, X>_F = svec(C) · svec(X)`
// exactly. This matches `unsvecIntoFull` and `svecFromFull` in tool.ts;
// our encoder must produce the same wire format the tool consumes.
//
// Convention: `convertSdpaToSdp(sparse, /*maximize=*/ true)` returns the
// SDPLIB problem with C *negated* (so internal minimize matches external
// maximize). We pass the negated C straight into `c` and report the
// objective with the sign flipped back in the result table.

const SQRT2 = Math.SQRT2;

function svecLen(n: number): number {
  return (n * (n + 1)) / 2;
}

function svecFromFull(
  F: Float64Array,
  n: number,
  out: number[],
  offset: number,
): void {
  let k = 0;
  for (let i = 0; i < n; i++) {
    for (let j = i; j < n; j++, k++) {
      const v = F[i * n + j]!;
      out[offset + k] = i === j ? v : SQRT2 * v;
    }
  }
}

function encodeWire(prob: SdpProblem): string {
  const offsets: number[] = [];
  let off = 0;
  for (const b of prob.blocks) {
    offsets.push(off);
    off += svecLen(b.size);
  }
  const N = off;

  // c: svec(C) per block, concatenated
  const c = new Array<number>(N).fill(0);
  for (let b = 0; b < prob.blocks.length; b++) {
    svecFromFull(prob.blocks[b]!.C, prob.blocks[b]!.size, c, offsets[b]!);
  }

  // A: row i = svec(A_i^b) per block, concatenated
  const A: number[][] = [];
  for (let i = 0; i < prob.m; i++) {
    const row = new Array<number>(N).fill(0);
    for (let b = 0; b < prob.blocks.length; b++) {
      svecFromFull(prob.blocks[b]!.A[i]!, prob.blocks[b]!.size, row, offsets[b]!);
    }
    A.push(row);
  }
  const b = Array.from(prob.b);

  const cones = prob.blocks.map((blk, idx) => {
    const indices: number[] = [];
    for (let k = 0; k < svecLen(blk.size); k++) indices.push(offsets[idx]! + k);
    return expr("PSDCone", [
      int(BigInt(blk.size)),
      list(indices.map((i) => int(BigInt(i)))),
    ]);
  });

  const input = record({
    minimize: record({ c: list(c.map((x) => float64FromNumber(x))) }),
    subjectTo: record({
      Ax_eq_b: record({
        A: list(A.map((row) => list(row.map((x) => float64FromNumber(x))))),
        b: list(b.map((x) => float64FromNumber(x))),
      }),
      cones: list(cones),
    }),
  });

  return JSON.stringify(input);
}

// -----------------------------------------------------------------------------
// Subprocess invocation per (case, method)
// -----------------------------------------------------------------------------

interface Row {
  name: string;
  method: string;
  m: number;
  maxn: number;
  status: string;
  iter: number;
  ap: number;
  pObj: number;
  wall_ms: number;
}

function decodeFloat64Bits(hex: string): number {
  const buf = new ArrayBuffer(8);
  const view = new DataView(buf);
  view.setBigUint64(0, BigInt(`0x${hex}`));
  return view.getFloat64(0);
}

async function runCase(tc: TriageRow, method: string): Promise<Row> {
  // We convert each case anew per method so the subprocess receives a clean
  // stdin; cost is dominated by the solve, not the encode.
  const prob = convertSdpaToSdp(tc.sparse, /* maximize */ true);
  const inputJson = encodeWire(prob);

  const tracePath = join(TRACES_DIR, `${tc.name}.${method}.jsonl`);
  // Clear any previous trace for this (case, method) — append mode in the tool
  // means we'd accumulate stale iters from earlier runs otherwise.
  writeFileSync(tracePath, "");

  const t0 = Date.now();

  const child = Bun.spawn({
    cmd: ["bun", TOOL_PATH, `--method=${method}`],
    stdin: "pipe",
    stdout: "pipe",
    stderr: "ignore",
    env: { ...process.env, IPM_TRACE_JSONL: tracePath },
  });

  child.stdin.write(inputJson);
  await child.stdin.end();

  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, TIMEOUT_MS);

  const stdout = await new Response(child.stdout).text();
  await child.exited;
  clearTimeout(timeout);

  const wall_ms = Date.now() - t0;

  let status = "?";
  let iter = -1;
  let ap = Number.NaN;
  let pObj = Number.NaN;

  if (timedOut) {
    status = "timeout";
  } else {
    try {
      const out = JSON.parse(stdout) as {
        kind: string;
        tag?: string;
        fields?: Record<string, { kind: string; value?: string; bits?: string }>;
      };
      if (out.kind === "record" && out.fields !== undefined) {
        const f = out.fields;
        status = (f["status"]?.value as string | undefined) ?? "?";
        const iterField = f["iterations"];
        if (iterField?.value !== undefined) iter = Number(BigInt(iterField.value));
        const apField = f["achieved_precision"];
        if (apField?.bits !== undefined) ap = decodeFloat64Bits(apField.bits);
        const pObjField = f["objective"];
        if (pObjField?.bits !== undefined) {
          // Negate to recover SDPLIB convention (the wire minimizes -C_sdpa,
          // so wire's primalObj = -<C_sdpa, X> and we want <C_sdpa, X>).
          pObj = -decodeFloat64Bits(pObjField.bits);
        }
      } else if (out.kind === "tagged") {
        status = `tagged:${out.tag ?? "?"}`;
      }
    } catch (e) {
      status = `parse-fail:${(e as Error).message.slice(0, 40)}`;
    }
  }

  return {
    name: tc.name,
    method,
    m: tc.m,
    maxn: tc.maxn,
    status,
    iter,
    ap,
    pObj,
    wall_ms,
  };
}

// -----------------------------------------------------------------------------
// CSV — append incrementally so partial results survive a crash
// -----------------------------------------------------------------------------

const CSV_HEADER = "case,method,m,maxn,status,iter,ap,pObj,wall_ms\n";

function ensureCsv(): void {
  if (!existsSync(RESULTS_CSV)) {
    writeFileSync(RESULTS_CSV, CSV_HEADER);
  }
}

function csvField(v: string | number): string {
  if (typeof v === "string") {
    // Wrap in quotes if it contains a comma or quote
    if (v.includes(",") || v.includes('"')) return `"${v.replace(/"/g, '""')}"`;
    return v;
  }
  if (!Number.isFinite(v)) return Number.isNaN(v) ? "nan" : v > 0 ? "inf" : "-inf";
  return v.toString();
}

function appendRow(row: Row): void {
  const cols = [
    row.name,
    row.method,
    row.m,
    row.maxn,
    row.status,
    row.iter,
    row.ap,
    row.pObj,
    row.wall_ms,
  ];
  appendFileSync(RESULTS_CSV, cols.map(csvField).join(",") + "\n");
}

// -----------------------------------------------------------------------------
// Main
// -----------------------------------------------------------------------------

if (!existsSync(SDPLIB_DIR)) {
  console.error(`SDPLIB_DIR=${SDPLIB_DIR} does not exist`);
  process.exit(1);
}
mkdirSync(TRACES_DIR, { recursive: true });

const cases = triage();
console.log(
  `[sdplib-stress] ${cases.length} cases pass filter (m ≤ ${M_CAP}, cost ≤ ${COST_CAP}); methods=${JSON.stringify(METHODS)}; timeout=${TIMEOUT_MS}ms`,
);
console.log(`[sdplib-stress] traces → ${TRACES_DIR}`);
console.log(`[sdplib-stress] results → ${RESULTS_CSV}`);

ensureCsv();

const totalRuns = cases.length * METHODS.length;
let runIdx = 0;
const t0Suite = Date.now();

for (const tc of cases) {
  for (const method of METHODS) {
    runIdx++;
    const tStart = Date.now();
    process.stderr.write(
      `[${runIdx}/${totalRuns}] ${tc.name} (m=${tc.m}, maxn=${tc.maxn}) ${method} ... `,
    );
    try {
      const row = await runCase(tc, method);
      appendRow(row);
      const wall = (Date.now() - tStart) / 1000;
      process.stderr.write(
        `${row.status} iter=${row.iter} ap=${row.ap.toExponential(2)} obj=${row.pObj.toExponential(3)} (${wall.toFixed(1)}s)\n`,
      );
    } catch (e) {
      process.stderr.write(`ERROR ${(e as Error).message}\n`);
      appendRow({
        name: tc.name,
        method,
        m: tc.m,
        maxn: tc.maxn,
        status: `error:${(e as Error).message.slice(0, 40)}`,
        iter: -1,
        ap: Number.NaN,
        pObj: Number.NaN,
        wall_ms: Date.now() - tStart,
      });
    }
  }
}

const totalMs = Date.now() - t0Suite;
console.log(`\n[sdplib-stress] suite complete in ${(totalMs / 1000).toFixed(1)}s; ${totalRuns} runs`);
