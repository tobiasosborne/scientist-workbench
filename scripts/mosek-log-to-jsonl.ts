// =============================================================================
// scripts/mosek-log-to-jsonl.ts — convert a Mosek IPM iter log to JSONL trace
// =============================================================================
//
// Purpose
// -------
// Parses Mosek's homogeneous self-dual interior-point iteration table and emits
// one JSONL line per iter aligned with `@workbench/solver-ipm`'s
// `VerboseIterLine` schema. This is the Mosek sibling of
// `scripts/copt-log-to-jsonl.ts`; both feed `scripts/trace-diff.ts`.
//
// Expected Mosek row shape
// ------------------------
//
//   ITE PFEAS DFEAS GFEAS PRSTATUS POBJ DOBJ MU TIME
//     0 1.0e+00 2.0e+00 3.0e+00 0.00 -1.0e+00 +0.0e+00 1.0e+00 0.01
//
// Mosek versions differ slightly in spacing and whether `TIME` carries a
// trailing `s`; this parser tokenises on whitespace and accepts either.
// Non-table lines naturally fail the token shape.

import { readFileSync, writeFileSync } from "node:fs";

interface MosekIterLine {
  iter: number;
  primalObj: number;
  dualObj: number;
  compl: number;
  primalInf: number;
  dualInf: number;
  timeSec: number;
  kind: "mosek";
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
  tau: number | null;
  kappa: number | null;
  gfeas: number;
  prstatus: number;
  nitref1: number | null;
  nitref2: number | null;
  nitref3: number | null;
  tSchurMs: number | null;
  tFactorMs: number | null;
  tDirectionMs: number | null;
  tStepMs: number | null;
}

const NUM_RE = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
const TIME_RE = /^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)(?:s)?$/;

function parseNumber(tok: string): number | null {
  if (!NUM_RE.test(tok)) return null;
  const x = Number.parseFloat(tok);
  return Number.isFinite(x) ? x : null;
}

function parseTime(tok: string): number | null {
  const m = TIME_RE.exec(tok);
  if (m === null) return null;
  const x = Number.parseFloat(m[1]!);
  return Number.isFinite(x) ? x : null;
}

function tryParseIterLine(line: string): MosekIterLine | null {
  const trimmed = line.trim();
  if (trimmed === "") return null;
  const toks = trimmed.split(/\s+/);
  if (toks.length !== 9) return null;
  if (!/^\d+$/.test(toks[0]!)) return null;

  const iter = Number.parseInt(toks[0]!, 10);
  const pfeas = parseNumber(toks[1]!);
  const dfeas = parseNumber(toks[2]!);
  const gfeas = parseNumber(toks[3]!);
  const prstatus = parseNumber(toks[4]!);
  const pobj = parseNumber(toks[5]!);
  const dobj = parseNumber(toks[6]!);
  const mu = parseNumber(toks[7]!);
  const timeSec = parseTime(toks[8]!);
  if (
    pfeas === null || dfeas === null || gfeas === null ||
    prstatus === null || pobj === null || dobj === null ||
    mu === null || timeSec === null
  ) {
    return null;
  }

  return {
    iter,
    primalObj: pobj,
    dualObj: dobj,
    compl: mu,
    primalInf: pfeas,
    dualInf: dfeas,
    timeSec,
    kind: "mosek",
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
    tau: null,
    kappa: null,
    gfeas,
    prstatus,
    nitref1: null,
    nitref2: null,
    nitref3: null,
    tSchurMs: null,
    tFactorMs: null,
    tDirectionMs: null,
    tStepMs: null,
  };
}

function main(): void {
  const args = process.argv.slice(2);
  if (args.length < 1 || args.length > 2) {
    throw new Error("usage: bun scripts/mosek-log-to-jsonl.ts <mosek.log> [<out.jsonl>]");
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
    if (sawAnyIter && parsed.iter !== prevIter + 1) break;
    sawAnyIter = true;
    prevIter = parsed.iter;
    out.push(JSON.stringify(parsed));
  }

  if (!sawAnyIter) {
    throw new Error(`no Mosek iter lines found in ${inPath}`);
  }

  const body = out.join("\n") + "\n";
  if (outPath === null) process.stdout.write(body);
  else {
    writeFileSync(outPath, body);
    process.stdout.write(`wrote ${out.length} iters to ${outPath}\n`);
  }
}

main();
