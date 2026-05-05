// =============================================================================
// scripts/bench-numerical-tier.ts — measurement harness for the n ceiling
// =============================================================================
//
// Purpose: produce the empirical wall-clock + memory table that drives
// ADR-0016's warning-threshold choices. Runs each numerical-tier
// algorithm at growing n; records RSS delta, peak RSS, wall-clock, and
// success / failure (RangeError on allocation, etc.).
//
// Output: a markdown table on stdout. Pipe to `docs/adr/0016-...md`
// or paste into the ADR by hand.
//
// Methodology:
//   - Random well-conditioned matrix at each n (U·Σ·V^T construction).
//   - Algorithm warmed-up once at the smallest n before timing.
//   - process.memoryUsage().rss sampled before and after; difference
//     reported as "RSS delta MB".
//   - Bun.gc() called between sizes to keep the baseline meaningful.
//   - Try/catch on RangeError to surface the natural OOM ceiling.

import { performance } from "node:perf_hooks";
import {
  matrixFromRows,
  qr,
  svd,
  type Matrix,
} from "@workbench/linalg-core";

// ─── matrix construction ─────────────────────────────────────────────────────

function randomWellConditioned(n: number, seed: number): Matrix {
  // Box-Muller-via-LCG, seed-deterministic.
  let s = seed >>> 0;
  const lcg = () => {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    return s / 0x100000000;
  };
  const gauss = () => {
    const u = Math.max(lcg(), 1e-12);
    const v = lcg();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  const rows: number[][] = [];
  for (let i = 0; i < n; i++) {
    const row: number[] = [];
    for (let j = 0; j < n; j++) row.push(gauss());
    rows.push(row);
  }
  return matrixFromRows(rows);
}

// ─── one measurement ─────────────────────────────────────────────────────────

interface Result {
  n: number;
  algo: string;
  ms: number;
  rssDeltaMB: number;
  peakRssMB: number;
  status: "ok" | "skipped" | "error";
  detail?: string;
}

function rssMB(): number {
  return process.memoryUsage().rss / (1024 * 1024);
}

async function measure(
  n: number,
  algo: "qr" | "svd",
  budgetMs: number,
): Promise<Result> {
  // Force GC if available so the baseline is meaningful.
  if (typeof Bun !== "undefined" && typeof (Bun as { gc?: () => void }).gc === "function") {
    (Bun as { gc: () => void }).gc();
  }
  const baseRss = rssMB();
  let peakRss = baseRss;

  let A: Matrix;
  try {
    A = randomWellConditioned(n, 0xC0FFEE);
  } catch (e) {
    return { n, algo, ms: 0, rssDeltaMB: 0, peakRssMB: baseRss,
      status: "error", detail: `matrix alloc: ${(e as Error).message}` };
  }
  const matRss = rssMB();
  if (matRss > peakRss) peakRss = matRss;

  const t0 = performance.now();
  try {
    if (algo === "qr") qr(A);
    else svd(A);
  } catch (e) {
    const ms = performance.now() - t0;
    return { n, algo, ms, rssDeltaMB: rssMB() - baseRss, peakRssMB: peakRss,
      status: "error", detail: (e as Error).message };
  }
  const ms = performance.now() - t0;
  const finalRss = rssMB();
  if (finalRss > peakRss) peakRss = finalRss;

  if (ms > budgetMs) {
    return { n, algo, ms, rssDeltaMB: finalRss - baseRss, peakRssMB: peakRss,
      status: "ok", detail: `over budget (>${budgetMs}ms)` };
  }
  return { n, algo, ms, rssDeltaMB: finalRss - baseRss, peakRssMB: peakRss,
    status: "ok" };
}

// ─── main ────────────────────────────────────────────────────────────────────

const sizes = [100, 200, 500, 1000, 2000, 5000];
const algorithms: ("qr" | "svd")[] = ["qr", "svd"];
// Per-call timeout — if a single call exceeds this, we skip larger n for
// that algorithm. 120s is generous; phones will be much slower.
const PER_CALL_BUDGET_MS = 120_000;

console.log(`# Numerical-tier n-ceiling measurement`);
console.log(``);
console.log(`Run on: ${process.platform} ${process.arch}, Bun ${Bun.version ?? "?"}`);
console.log(`Date: ${new Date().toISOString()}`);
console.log(``);
console.log(`| algo | n | wall-clock (s) | RSS delta (MB) | peak RSS (MB) | status |`);
console.log(`|---|---|---|---|---|---|`);

// Warmup pass.
await measure(50, "qr", 30_000);
await measure(50, "svd", 30_000);

for (const algo of algorithms) {
  let skipRest = false;
  for (const n of sizes) {
    if (skipRest) {
      console.log(`| ${algo} | ${n} | — | — | — | skipped (prior over-budget) |`);
      continue;
    }
    const r = await measure(n, algo, PER_CALL_BUDGET_MS);
    const sec = (r.ms / 1000).toFixed(r.ms < 100 ? 4 : r.ms < 10000 ? 2 : 1);
    const rssDelta = r.rssDeltaMB.toFixed(1);
    const peak = r.peakRssMB.toFixed(0);
    const status = r.detail ? `${r.status}: ${r.detail}` : r.status;
    console.log(`| ${algo} | ${n} | ${sec} | ${rssDelta} | ${peak} | ${status} |`);
    if (r.status === "error" || r.ms > PER_CALL_BUDGET_MS) skipRest = true;
  }
}

console.log(``);
console.log(`Notes:`);
console.log(`- "RSS delta" is the RSS growth from baseline to post-call (after GC).`);
console.log(`- "peak RSS" is the max RSS observed during the call.`);
console.log(`- Phones run ~3× slower than dev box (rough rule of thumb for ARM cores`);
console.log(`  vs x86 desktop).`);
console.log(`- Memory matters more on phone: most browser tabs cap at 1-2 GB.`);
