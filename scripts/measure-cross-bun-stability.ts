// =============================================================================
// measure-cross-bun-stability.ts — cross-Bun-version float stability measurement
// =============================================================================
//
// Forcing experiment for ADR-0015 (bead scientist-workbench-0ck).
//
// ADR-0014 §"What we will *not* decide here" said the determinism-tier ADR
// must be drafted *after* the property test for single-platform stability
// runs against multiple Bun versions. This script *is* that property test.
//
// Method
// ------
// Build a corpus of linalg-solve inputs (the 16 committed goldens + a
// synthetic random corpus + the most-likely-to-drift cases: Hilbert(n)
// for n=2..7 and Wilkinson growth-n for n=2..8). For each input, invoke
// `solve` in-process — the running Bun's float ops are exercised — and
// emit one line of `<case_id>\t<input_hash>\t<output_hash>` to stdout.
//
// Run under each Bun version of interest:
//
//   ~/.bun-1.2.21/bin/bun scripts/measure-cross-bun-stability.ts > 1.2.21.tsv
//   ~/.bun/bin/bun        scripts/measure-cross-bun-stability.ts > 1.3.13.tsv
//   diff -q 1.2.21.tsv 1.3.13.tsv     # zero diff = bit-stable across versions
//
// What "in-process" means here
// ----------------------------
// We import `solve` from `@workbench/linalg-core` directly and call the
// algorithm. No tool-runner, no JSON canonicalisation in the inner loop
// — we hash the final SolveResult after wire-encoding. This isolates the
// float work (the question) from the runner machinery (not the question).
//
// What we are *not* measuring
// ---------------------------
// - Cross-platform (linux x86_64 vs darwin aarch64): out of scope for this
//   pass; the measurement script is single-platform by construction.
// - Cross-engine (Bun-on-JSC vs Node-on-V8): a different question; this
//   script only ever runs under Bun.
// - Symbolic tools: assumed stable (no float ops); a separate sweep can
//   verify if doubt arises.
//
// References
// ----------
// - docs/adr/0014-first-numerical-tier.md §"Forcing-questions" (1)
// - docs/worklog/031-first-numerical-tier.md §"Forcing-questions, answered"
// - docs/numerics-and-vis-2026-04-29.md §4.1

import {
  canonicalize,
  float64FromNumber,
  hash,
  list,
  record,
  str,
  type Float64Value,
  type Value,
} from "@workbench/protocol";
import { matrixFromRows, solve, type SolveResult } from "@workbench/linalg-core";

// -----------------------------------------------------------------------------
// Wire encoding (mirrors tools/linalg-solve/tool.ts to keep hashes meaningful)
// -----------------------------------------------------------------------------

function vec(xs: readonly number[]): Value {
  return list(xs.map((x) => float64FromNumber(x)));
}
function mat(rows: readonly (readonly number[])[]): Value {
  return list(rows.map((r) => vec(r)));
}
function inputValue(A: readonly (readonly number[])[], b: readonly number[]): Value {
  return record({ A: mat(A), b: vec(b) });
}
function encodeSolveValue(r: SolveResult): Value {
  // Just the numerical fields; warnings & method are deterministic functions
  // of the numerical fields, so dropping them here is fine for the hash.
  const items: Float64Value[] = [];
  for (const xi of r.x) items.push(float64FromNumber(xi));
  return record({
    x: list(items),
    residual_norm: float64FromNumber(r.residualNorm),
    b_norm: float64FromNumber(r.bNorm),
    condition_estimate: float64FromNumber(r.conditionEstimate),
    growth_factor: float64FromNumber(r.growthFactor),
  });
}

// -----------------------------------------------------------------------------
// Deterministic random matrix generator (Mulberry32 — pure function of seed)
// -----------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomMatrix(rng: () => number, n: number): number[][] {
  const A: number[][] = [];
  for (let i = 0; i < n; i++) {
    const row: number[] = [];
    for (let j = 0; j < n; j++) row.push(rng() * 2 - 1);
    // Diagonal dominance for well-conditionedness — keeps every matrix
    // invertible without us having to special-case ill-luck.
    row[i] = (row[i]! >= 0 ? 1 : -1) * (n + 1);
    A.push(row);
  }
  return A;
}
function randomVector(rng: () => number, n: number): number[] {
  const v: number[] = [];
  for (let i = 0; i < n; i++) v.push(rng() * 2 - 1);
  return v;
}

// -----------------------------------------------------------------------------
// Corpus
// -----------------------------------------------------------------------------

interface Case {
  id: string;
  A: readonly (readonly number[])[];
  b: readonly number[];
}

function hilbert(n: number): number[][] {
  const A: number[][] = [];
  for (let i = 0; i < n; i++) {
    const row: number[] = [];
    for (let j = 0; j < n; j++) row.push(1 / (i + j + 1));
    A.push(row);
  }
  return A;
}

function wilkinson(n: number): number[][] {
  // The classic pivot-growth construction: lower triangle of -1s, diagonal
  // of 1s, last column of 1s. Growth factor is 2^(n-1).
  const A: number[][] = [];
  for (let i = 0; i < n; i++) {
    const row: number[] = [];
    for (let j = 0; j < n; j++) {
      if (j === n - 1) row.push(1);
      else if (i === j) row.push(1);
      else if (i > j) row.push(-1);
      else row.push(0);
    }
    A.push(row);
  }
  return A;
}

function buildCorpus(): Case[] {
  const cases: Case[] = [];

  // Ill-conditioned: Hilbert matrices — the Hilbert family is the
  // canonical "tickle the rounding mode" stress test.
  for (let n = 2; n <= 7; n++) {
    const A = hilbert(n);
    const b: number[] = []; b.push(1); for (let i = 1; i < n; i++) b.push(0);
    cases.push({ id: `hilbert-${n}`, A, b });
  }

  // Pivot growth: Wilkinson construction — exercises the partial-pivoting
  // path under maximal stress.
  for (let n = 2; n <= 8; n++) {
    const A = wilkinson(n);
    const b: number[] = []; for (let i = 0; i < n; i++) b.push(1);
    cases.push({ id: `wilkinson-${n}`, A, b });
  }

  // Random well-conditioned (diagonally dominant) — wide coverage of
  // routine inputs. Sizes 2..30, three seeds per size = 87 cases.
  for (let n = 2; n <= 30; n++) {
    for (let seed = 1; seed <= 3; seed++) {
      const rng = mulberry32(n * 1000 + seed);
      const A = randomMatrix(rng, n);
      const b = randomVector(rng, n);
      cases.push({ id: `rand-n${n}-s${seed}`, A, b });
    }
  }

  return cases;
}

// -----------------------------------------------------------------------------
// Main
// -----------------------------------------------------------------------------

const bunVersion = (Bun as unknown as { version: string }).version;
const corpus = buildCorpus();

console.log(`# bun_version=${bunVersion}`);
console.log(`# n_cases=${corpus.length}`);
console.log(`# columns: case_id\\tinput_hash\\toutput_hash`);

let nSingular = 0;
for (const c of corpus) {
  const inputHash = hash(inputValue(c.A, c.b));
  const A = matrixFromRows(c.A.map((r) => Array.from(r)));
  const b = new Float64Array(c.b);
  const r = solve(A, b);
  if (r === null) {
    console.log(`${c.id}\t${inputHash}\tSINGULAR`);
    nSingular++;
    continue;
  }
  const outputHash = hash(encodeSolveValue(r));
  console.log(`${c.id}\t${inputHash}\t${outputHash}`);
}

console.error(`measure-cross-bun-stability: ${corpus.length} cases (${nSingular} singular) on Bun ${bunVersion}`);
