// =============================================================================
// scripts/solver-ipm-bench.ts — microbench for solver-ipm hot ops
// =============================================================================
//
// Baseline for the upcoming SDP factorWith3Way refactor (Phase 1 of the
// solver-ipm convergence handoff). Each operation is run N times with
// `Bun.nanoseconds()` wall timing. Reports mean / median / p95 in
// microseconds. Run before and after a refactor; the delta is the
// per-op regression signal.
//
// Usage
// -----
//
//     bun scripts/solver-ipm-bench.ts             # full suite
//     bun scripts/solver-ipm-bench.ts schur lp    # only ops matching tokens
//
// The verbose iter-trace's `tSchurMs`/`tFactorMs`/`tDirectionMs`/
// `tStepMs` give *in-context* per-iter timing across a real solve; this
// script measures the same operations in isolation with no IPM
// orchestration overhead, on synthetic but representative inputs. Use
// both: the trace tells you which phase dominates *on this problem*;
// the bench tells you whether a refactor changed the cost *of an op*.

import {
  schurAssembleNormalEq,
} from "../packages/solver-ipm/src/linalg/SchurAssembler.js";
import {
  choleskyInPlace,
} from "../packages/solver-ipm/src/linalg/Cholesky.js";
import {
  eighJacobi,
  matMul,
  symmetrize,
} from "../packages/solver-ipm/src/cone/PsdCone.js";

interface BenchResult {
  name: string;
  iters: number;
  meanUs: number;
  medianUs: number;
  p95Us: number;
}

function bench(name: string, iters: number, fn: () => void): BenchResult {
  // Warmup
  for (let i = 0; i < Math.min(5, iters); i++) fn();
  const samples = new Float64Array(iters);
  for (let i = 0; i < iters; i++) {
    const t0 = Bun.nanoseconds();
    fn();
    samples[i] = (Bun.nanoseconds() - t0) / 1000; // microseconds
  }
  const sorted = Array.from(samples).sort((a, b) => a - b);
  const mean = sorted.reduce((s, x) => s + x, 0) / iters;
  const median = sorted[Math.floor(iters / 2)]!;
  const p95 = sorted[Math.floor(iters * 0.95)]!;
  return { name, iters, meanUs: mean, medianUs: median, p95Us: p95 };
}

function randSpd(n: number, seed = 1): Float64Array {
  // Generate a random symmetric PD matrix via A^T A + n·I. Deterministic
  // seed (simple LCG) so runs are reproducible across invocations.
  let s = seed;
  const next = (): number => { s = (s * 1664525 + 1013904223) | 0; return ((s >>> 0) / 0xffffffff) - 0.5; };
  const A = new Float64Array(n * n);
  for (let i = 0; i < n * n; i++) A[i] = next();
  const out = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      let acc = 0;
      for (let k = 0; k < n; k++) acc += A[k * n + i]! * A[k * n + j]!;
      out[i * n + j] = acc;
    }
  }
  for (let i = 0; i < n; i++) out[i * n + i] = out[i * n + i]! + n;
  return out;
}

function randMatrix(rows: number, cols: number, seed: number): Float64Array {
  let s = seed;
  const next = (): number => { s = (s * 1664525 + 1013904223) | 0; return ((s >>> 0) / 0xffffffff) - 0.5; };
  const A = new Float64Array(rows * cols);
  for (let i = 0; i < A.length; i++) A[i] = next();
  return A;
}

function fmt(r: BenchResult): string {
  return (
    r.name.padEnd(34) +
    ` n=${r.iters}` +
    `  mean=${r.meanUs.toFixed(1)}µs` +
    `  median=${r.medianUs.toFixed(1)}µs` +
    `  p95=${r.p95Us.toFixed(1)}µs`
  );
}

const filters = process.argv.slice(2).map((s) => s.toLowerCase());
const include = (label: string): boolean => filters.length === 0 || filters.some((f) => label.toLowerCase().includes(f));

const results: BenchResult[] = [];

// LP Schur assemble — A (m×n) · diag(d) · A^T → M (m×m).
for (const [m, n, iters] of [[20, 80, 1000], [100, 400, 200], [400, 1600, 20]] as const) {
  const label = `lp-schur-assemble m=${m} n=${n}`;
  if (!include(label)) continue;
  const A = randMatrix(m, n, 7);
  const d = new Float64Array(n);
  for (let i = 0; i < n; i++) d[i] = 0.1 + (i % 13) * 0.01;
  const M = new Float64Array(m * m);
  results.push(bench(label, iters, () => schurAssembleNormalEq(A, m, n, d, M)));
}

// Cholesky factor of m×m SPD.
for (const [m, iters] of [[20, 5000], [100, 500], [400, 30]] as const) {
  const label = `cholesky-in-place m=${m}`;
  if (!include(label)) continue;
  const Mbase = randSpd(m, 23);
  const M = new Float64Array(m * m);
  results.push(bench(label, iters, () => {
    M.set(Mbase);
    choleskyInPlace(M, m, 1e-12);
  }));
}

// SDP NT-related ops surrogate: matMul of n×n + symmetric Cholesky.
// These dominate buildNtFactor / WAW cache loops in the SDP solvers.
for (const [n, iters] of [[10, 5000], [30, 500], [60, 100]] as const) {
  {
    const label = `sdp-matmul n=${n}`;
    if (include(label)) {
      const A = randMatrix(n, n, 11);
      const B = randMatrix(n, n, 13);
      const C = new Float64Array(n * n);
      results.push(bench(label, iters, () => matMul(A, B, n, C)));
    }
  }
  {
    const label = `sdp-eigh n=${n}`;
    if (include(label)) {
      const A = randSpd(n, 17);
      symmetrize(A, n);
      results.push(bench(label, iters, () => eighJacobi(A, n)));
    }
  }
}

const longest = results.reduce((m, r) => Math.max(m, r.name.length), 0);
for (const r of results) {
  process.stdout.write(fmt({ ...r, name: r.name.padEnd(longest) }) + "\n");
}
