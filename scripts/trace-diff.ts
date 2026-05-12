// =============================================================================
// scripts/trace-diff.ts — first-divergence finder over JSONL solver traces
// =============================================================================
//
// Purpose
// -------
// Compares two JSONL verbose-trace files (as produced by
// `IPM_TRACE_JSONL=path bun tools/{lp,sdp}-solve/tool.ts ...` or
// `scripts/sdp-probe.ts`, or by `scripts/copt-log-to-jsonl.ts`) and
// reports the first iter+field where they diverge beyond tolerance.
// Treats `null` (the JSON encoding of `NaN`, which the verbose schema
// uses for solver-kind-inapplicable fields) as "missing" — null on one
// side and a value on the other is reported as a difference; null on
// both sides is silently skipped.
//
// Three workflows it supports
// ---------------------------
// 1. **Regression check.** TS-before vs TS-after a refactor:
//        IPM_TRACE_JSONL=/tmp/a.jsonl bun scripts/sdp-probe.ts case.dat-s
//        # ...edit code...
//        IPM_TRACE_JSONL=/tmp/b.jsonl bun scripts/sdp-probe.ts case.dat-s
//        bun scripts/trace-diff.ts /tmp/a.jsonl /tmp/b.jsonl
//
// 2. **Algorithm divergence localisation.** TS vs COPT:
//        copt_cmd … > /tmp/copt.log
//        bun scripts/copt-log-to-jsonl.ts /tmp/copt.log /tmp/copt.jsonl
//        IPM_TRACE_JSONL=/tmp/ts.jsonl bun scripts/sdp-probe.ts case.dat-s
//        bun scripts/trace-diff.ts /tmp/copt.jsonl /tmp/ts.jsonl
//
// 3. **Bisection / load-bearing identification.** Perturbation runs:
//        IPM_TRACE_JSONL=/tmp/unperturbed.jsonl bun ...
//        # …apply a single-line change to the solver…
//        IPM_TRACE_JSONL=/tmp/perturbed.jsonl bun ...
//        bun scripts/trace-diff.ts --fields=mu,sigma,alphaPrimal /tmp/un*.jsonl /tmp/per*.jsonl
//
// CLI
// ---
//
//     bun scripts/trace-diff.ts <a.jsonl> <b.jsonl>
//                               [--rtol=1e-6] [--atol=1e-10]
//                               [--fields=mu,sigma,...]
//                               [--max-iter=N]
//                               [--include-timing]
//
// Exit code is 0 if the traces align within tolerance over the shared
// iter range, 1 otherwise. The first divergence is printed to stdout
// in a structured form; subsequent divergences are also printed (up to
// 20) to give a sense of how the trajectories drift after the first
// disagreement.
//
// Timing fields (`timeSec`, `tSchurMs`, `tFactorMs`, `tDirectionMs`,
// `tStepMs`) are **excluded by default** — they reflect wall-clock
// noise and would mask algorithmic divergences. Pass `--include-timing`
// for perf-diff workflows where you do want to compare them.

import { readFileSync } from "node:fs";

type Trace = Record<string, unknown>[];

const TIMING_FIELDS = new Set([
  "timeSec", "tSchurMs", "tFactorMs", "tDirectionMs", "tStepMs",
]);

interface Args {
  a: string;
  b: string;
  rtol: number;
  atol: number;
  fields: Set<string> | null;
  maxIter: number;
  includeTiming: boolean;
}

function parseArgs(argv: string[]): Args {
  let a: string | null = null;
  let b: string | null = null;
  let rtol = 1e-6;
  let atol = 1e-10;
  let fields: Set<string> | null = null;
  let maxIter = Infinity;
  let includeTiming = false;
  for (const arg of argv) {
    if (arg.startsWith("--rtol=")) rtol = Number(arg.slice("--rtol=".length));
    else if (arg.startsWith("--atol=")) atol = Number(arg.slice("--atol=".length));
    else if (arg.startsWith("--fields=")) {
      fields = new Set(arg.slice("--fields=".length).split(","));
    } else if (arg.startsWith("--max-iter=")) {
      maxIter = Number(arg.slice("--max-iter=".length));
    } else if (arg === "--include-timing") {
      includeTiming = true;
    } else if (arg.startsWith("--")) {
      throw new Error(`unknown flag: ${arg}`);
    } else if (a === null) a = arg;
    else if (b === null) b = arg;
    else throw new Error(`unexpected positional: ${arg}`);
  }
  if (a === null || b === null) {
    throw new Error("usage: bun scripts/trace-diff.ts <a.jsonl> <b.jsonl> [--rtol=1e-6] [--atol=1e-10] [--fields=mu,sigma] [--max-iter=N] [--include-timing]");
  }
  if (!Number.isFinite(rtol) || rtol < 0) throw new Error(`invalid --rtol: ${rtol}`);
  if (!Number.isFinite(atol) || atol < 0) throw new Error(`invalid --atol: ${atol}`);
  return { a, b, rtol, atol, fields, maxIter, includeTiming };
}

function loadJsonl(path: string): Trace {
  const text = readFileSync(path, "utf-8");
  const out: Trace = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (t === "") continue;
    out.push(JSON.parse(t) as Record<string, unknown>);
  }
  return out;
}

/**
 * Compare two numeric values under (rtol, atol). Treats null as "missing":
 * null/null is "agree"; null vs number is a disagreement (the
 * solver-kind-inapplicable case — e.g., LP eigMinX null vs SDP eigMinX
 * 1.2e-3 — surfaces a meaningful kind mismatch, not a wash). NaN/NaN
 * is agreement (matching the JSON null semantic post-round-trip).
 *
 * Returns a description of the disagreement, or null if values agree.
 */
function compareValue(av: unknown, bv: unknown, rtol: number, atol: number): string | null {
  if (av === null && bv === null) return null;
  if (av === null || bv === null) return `${av} vs ${bv}`;
  if (typeof av === "number" && typeof bv === "number") {
    if (Number.isNaN(av) && Number.isNaN(bv)) return null;
    if (Number.isNaN(av) || Number.isNaN(bv)) return `${av} vs ${bv}`;
    if (av === bv) return null;
    const absDiff = Math.abs(av - bv);
    const tol = atol + rtol * Math.max(Math.abs(av), Math.abs(bv));
    if (absDiff <= tol) return null;
    return `${av.toExponential(4)} vs ${bv.toExponential(4)} (Δ=${absDiff.toExponential(2)} > tol=${tol.toExponential(2)})`;
  }
  // Non-numeric fields (e.g., `kind: "lp"` vs `kind: "sdp-nt"`).
  if (av === bv) return null;
  return `${JSON.stringify(av)} vs ${JSON.stringify(bv)}`;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const A = loadJsonl(args.a);
  const B = loadJsonl(args.b);

  const lenShared = Math.min(A.length, B.length, args.maxIter + 1);
  if (A.length !== B.length) {
    process.stdout.write(
      `note: trace lengths differ — a=${A.length} iters, b=${B.length} iters; ` +
      `comparing first ${lenShared} iters\n`,
    );
  }

  // Build the union of fields across both files (in encounter order from
  // the first iter of A). If --fields is set, restrict to that subset.
  // Timing fields are excluded unless --include-timing is set.
  const fieldOrder: string[] = [];
  const seen = new Set<string>();
  for (const trace of [A, B]) {
    for (const line of trace.slice(0, lenShared)) {
      for (const k of Object.keys(line)) {
        if (!seen.has(k)) {
          const passField = args.fields === null || args.fields.has(k);
          const passTiming = args.includeTiming || !TIMING_FIELDS.has(k);
          if (passField && passTiming) fieldOrder.push(k);
          seen.add(k);
        }
      }
    }
  }

  let divergences = 0;
  const MAX_REPORT = 20;
  for (let i = 0; i < lenShared; i++) {
    const a = A[i]!;
    const b = B[i]!;
    for (const f of fieldOrder) {
      const dis = compareValue(a[f], b[f], args.rtol, args.atol);
      if (dis !== null) {
        divergences++;
        if (divergences <= MAX_REPORT) {
          process.stdout.write(`iter=${i} field=${f}: ${dis}\n`);
        } else if (divergences === MAX_REPORT + 1) {
          process.stdout.write(`... (additional divergences suppressed)\n`);
        }
      }
    }
  }

  if (divergences === 0) {
    process.stdout.write(`aligned: ${lenShared} iters × ${fieldOrder.length} fields within rtol=${args.rtol} atol=${args.atol}\n`);
    process.exit(0);
  }
  process.stdout.write(`\ndivergences: ${divergences} total across ${lenShared} iters\n`);
  process.exit(1);
}

main();
