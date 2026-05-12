// =============================================================================
// scripts/copt-log-to-jsonl.ts — convert a COPT iter log to JSONL trace
// =============================================================================
//
// Purpose
// -------
// Parses the iter-line section of a COPT 8.0.4 solver log (the format
// produced by `set Logging 2; optimize` in `copt_cmd`) and emits one
// JSONL line per iter matching the `VerboseIterLine` schema used by
// `@workbench/solver-ipm`. Fields COPT doesn't expose (`sigma`, `muAff`,
// `alphaPrimal`, regularisation counters, phase timings, `eigMinX/S`,
// `schurDiagMin/Max`) are emitted as `null` — same encoding the TS
// solvers use for solver-kind-inapplicable fields, so `trace-diff.ts`
// treats them uniformly.
//
// Result: COPT and TS traces can be `trace-diff`'d directly. Iter,
// primal/dual objectives, μ, primal/dual infeas, and timeSec are the
// shared cross-checks. Where these disagree at iter `k`, the
// algorithmic divergence is localised to iter `k` in our solver.
//
// CLI
// ---
//
//     bun scripts/copt-log-to-jsonl.ts <copt.log> [<out.jsonl>]
//
// If <out.jsonl> is omitted, JSONL is written to stdout.
//
// Format reference (one iter line)
// --------------------------------
//
//     Iter       Primal.Obj         Dual.Obj      Compl  Primal.Inf  Dual.Inf    Time
//        0  -4.75000000e+00  +0.00000000e+00   5.00e+00    8.12e+00  2.00e+00   0.02s
//
// COPT's printf format: `%4d  %+15.8e  %+15.8e   %8.2e  %10.2e  %8.2e %7s`.
// We match this with a token regex rather than fixed-column parsing —
// COPT pads with spaces, so split-on-whitespace is robust to small width
// drift across COPT versions. (Verified against probe1.log on COPT
// 8.0.4 build 20260424.)

import { readFileSync, writeFileSync } from "node:fs";

interface CoptIterLine {
  iter: number;
  primalObj: number;
  dualObj: number;
  compl: number;
  primalInf: number;
  dualInf: number;
  timeSec: number;
  // Filler for VerboseIterLine schema alignment with TS traces.
  kind: "copt";
  sigma: number | null;
  sigmaRaw: number | null;
  muAff: number | null;
  alphaPrimal: number | null;
  alphaDual: number | null;
  alphaPrimalRaw: number | null;
  alphaDualRaw: number | null;
  jitterPrimal: number | null;
  jitterDual: number | null;
  jitterGap: number | null;
  bumpsPrimalThisIter: number | null;
  bumpsDualThisIter: number | null;
  bumpsGapThisIter: number | null;
  refactorsThisIter: number | null;
  failRow: number | null;
  schurDiagMin: number | null;
  schurDiagMax: number | null;
  eigMinX: number | null;
  eigMinS: number | null;
  tSchurMs: number | null;
  tFactorMs: number | null;
  tDirectionMs: number | null;
  tStepMs: number | null;
}

const NUM_RE = /^[+-]?\d+(\.\d*)?([eE][+-]?\d+)?$/;
const TIME_RE = /^([0-9.]+)s$/;

/**
 * Parse a single trimmed line. Returns a parsed iter line or null if
 * the line isn't an iter row. We require: 7 whitespace-separated tokens,
 * first an integer (iter), tokens 2-6 floats, last a `<time>s` token.
 * Banner / status / fingerprint lines naturally fail this shape.
 */
function tryParseIterLine(line: string): CoptIterLine | null {
  const trimmed = line.trim();
  if (trimmed === "") return null;
  const toks = trimmed.split(/\s+/);
  if (toks.length !== 7) return null;

  const iterTok = toks[0]!;
  if (!/^\d+$/.test(iterTok)) return null;
  const iter = Number.parseInt(iterTok, 10);

  const numerics: number[] = [];
  for (let i = 1; i <= 5; i++) {
    const t = toks[i]!;
    if (!NUM_RE.test(t)) return null;
    const v = Number.parseFloat(t);
    if (!Number.isFinite(v)) return null;
    numerics.push(v);
  }

  const timeMatch = TIME_RE.exec(toks[6]!);
  if (timeMatch === null) return null;
  const timeSec = Number.parseFloat(timeMatch[1]!);
  if (!Number.isFinite(timeSec)) return null;

  return {
    iter,
    primalObj: numerics[0]!,
    dualObj: numerics[1]!,
    compl: numerics[2]!,
    primalInf: numerics[3]!,
    dualInf: numerics[4]!,
    timeSec,
    kind: "copt",
    sigma: null,
    sigmaRaw: null,
    muAff: null,
    alphaPrimal: null,
    alphaDual: null,
    alphaPrimalRaw: null,
    alphaDualRaw: null,
    jitterPrimal: null,
    jitterDual: null,
    jitterGap: null,
    bumpsPrimalThisIter: null,
    bumpsDualThisIter: null,
    bumpsGapThisIter: null,
    refactorsThisIter: null,
    failRow: null,
    schurDiagMin: null,
    schurDiagMax: null,
    eigMinX: null,
    eigMinS: null,
    tSchurMs: null,
    tFactorMs: null,
    tDirectionMs: null,
    tStepMs: null,
  };
}

function main(): void {
  const args = process.argv.slice(2);
  if (args.length < 1 || args.length > 2) {
    throw new Error("usage: bun scripts/copt-log-to-jsonl.ts <copt.log> [<out.jsonl>]");
  }
  const inPath = args[0]!;
  const outPath = args[1] ?? null;

  const text = readFileSync(inPath, "utf-8");
  const out: string[] = [];
  let sawAnyIter = false;
  let prevIter = -1;
  for (const line of text.split("\n")) {
    const parsed = tryParseIterLine(line);
    if (parsed === null) continue;
    // COPT iter numbers should be strictly increasing; if we see a non-
    // monotonic jump, it's almost certainly a spurious match on some
    // other tabular line (status table, DIMACS row, etc.). Stop parsing.
    if (sawAnyIter && parsed.iter !== prevIter + 1) {
      break;
    }
    sawAnyIter = true;
    prevIter = parsed.iter;
    out.push(JSON.stringify(parsed));
  }

  if (!sawAnyIter) {
    throw new Error(`no iter lines found in ${inPath}`);
  }

  const body = out.join("\n") + "\n";
  if (outPath === null) {
    process.stdout.write(body);
  } else {
    writeFileSync(outPath, body);
    process.stdout.write(`wrote ${out.length} iters to ${outPath}\n`);
  }
}

main();
