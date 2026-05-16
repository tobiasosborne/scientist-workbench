// =============================================================================
// scripts/sdp-probe.ts — single-case SDP solver driver with verbose trace
// =============================================================================
//
// Purpose
// -------
// The fast-iteration loop for "is the change I'm making improving control2?"
// Loads one SDPA-sparse file from disk, builds the SdpProblem, invokes the
// chosen solver with verbose-on-stderr, and prints the final status. The
// trace is byte-identical to what the `sdp-solve` tool would emit on the
// same input (modulo time wall-clock noise), and respects the same
// `IPM_TRACE_JSONL` env var for JSONL mirror.
//
// Usage
// -----
//
//     bun scripts/sdp-probe.ts <path.dat-s> [--method=nt|aho|hkm|hsde-nt] [--minimize]
//
// SDPLIB convention is maximisation (the SDPA-sparse format's b/C/A
// arrays encode the maximisation primal); we default to that. Pass
// `--minimize` for problems where the .dat-s file was written for the
// minimisation primal (rare; mostly own-derived test fixtures).
//
// `--method=hsde-nt` selects the homogeneous-self-dual-embedding solver
// (ADR-0033) with iterative refinement on the Schur back-sub (ADR-0033
// §"Decision 9", Phase 5 Tier 1). The HSDE result carries extra `tau` /
// `kappa` / `achievedPrecision` fields; the summary line is uniformised
// across solvers so trace-diff workflows can compose freely.
//
// Examples
//
//     bun scripts/sdp-probe.ts ~/Projects/scientist-workbench-corpus/data/sdp-sdplib/raw/control2.dat-s
//     bun scripts/sdp-probe.ts /path/to/case.dat-s --method=aho
//     IPM_TRACE_JSONL=/tmp/ts-control2.jsonl bun scripts/sdp-probe.ts ...
//
// Why a script rather than a `--probe` flag on the tool
// ------------------------------------------------------
// The `sdp-solve` tool speaks the value-protocol wire: input is a JSON
// record, output is a `Value`. Adding a "read .dat-s from disk and
// solve" path would muddy the tool's contract. The probe script is the
// research-side companion: directly drives the library, no wire
// transcoding, no `runTool` runner. Same verbose stream, same JSONL env
// var support, none of the protocol overhead.

import { readFileSync } from "node:fs";
import { writeSync, openSync, closeSync } from "node:fs";
import {
  parseSdpaSparse,
  convertSdpaToSdp,
  solveSdpNt,
  solveSdpAho,
  solveSdpHkm,
  solveHsdeSdpNt,
  formatVerboseLine,
  type HsdeSdpSolveResult,
  type SdpProblem,
  type SdpSolveResult,
  type VerboseIterLine,
  type SolveOptions,
} from "@workbench/solver-ipm";

type Method = "nt" | "aho" | "hkm" | "hsde-nt";

/** Uniform per-solver summary. The legacy SDP solvers and the HSDE solver
 *  agree on these fields by name; HSDE supplies `tau`/`kappa` for the
 *  homogenization scalars and `achievedPrecision` for the best ρ-metric
 *  observed (ADR-0033 §"Decision 7"), legacy paths omit them. */
interface ProbeSummary {
  status: string;
  iter: number;
  primalObj: number;
  dualObj: number;
  mu: number;
  primalInf: number;
  dualInf: number;
  tau: number | null;
  kappa: number | null;
  achievedPrecision: number | null;
}

function summarise(r: SdpSolveResult | HsdeSdpSolveResult): ProbeSummary {
  const hsde = "tau" in r;
  return {
    status: r.status,
    iter: r.iter,
    primalObj: r.primalObj,
    dualObj: r.dualObj,
    mu: r.mu,
    primalInf: r.primalInf,
    dualInf: r.dualInf,
    tau: hsde ? r.tau : null,
    kappa: hsde ? r.kappa : null,
    achievedPrecision: hsde ? r.achievedPrecision : null,
  };
}

function parseArgs(argv: string[]): { path: string; method: Method; maximize: boolean } {
  let path: string | null = null;
  let method: Method = "nt";
  let maximize = true; // SDPLIB convention
  for (const a of argv) {
    if (a.startsWith("--method=")) {
      const m = a.slice("--method=".length);
      if (m !== "nt" && m !== "aho" && m !== "hkm" && m !== "hsde-nt") {
        throw new Error(`--method must be one of nt|aho|hkm|hsde-nt (got ${m})`);
      }
      method = m;
    } else if (a === "--minimize") {
      maximize = false;
    } else if (a.startsWith("--")) {
      throw new Error(`unknown flag: ${a}`);
    } else if (path === null) {
      path = a;
    } else {
      throw new Error(`unexpected positional arg: ${a}`);
    }
  }
  if (path === null) {
    throw new Error("usage: bun scripts/sdp-probe.ts <path.dat-s> [--method=nt|aho|hkm|hsde-nt] [--minimize]");
  }
  return { path, method, maximize };
}

type Solve = (p: SdpProblem, o: SolveOptions) => SdpSolveResult | HsdeSdpSolveResult;

function pickSolver(method: Method): Solve {
  switch (method) {
    case "nt":      return solveSdpNt;
    case "aho":     return solveSdpAho;
    case "hkm":     return solveSdpHkm;
    case "hsde-nt": return solveHsdeSdpNt;
  }
}

function main(): void {
  const { path, method, maximize } = parseArgs(process.argv.slice(2));

  const text = readFileSync(path, "utf-8");
  const parsed = parseSdpaSparse(text);
  const prob = convertSdpaToSdp(parsed, maximize);

  const jsonlPath = process.env.IPM_TRACE_JSONL;
  const jsonlFd = jsonlPath ? openSync(jsonlPath, "a") : -1;
  const verbose = (line: VerboseIterLine): void => {
    writeSync(2, formatVerboseLine(line) + "\n");
    if (jsonlFd >= 0) writeSync(jsonlFd, JSON.stringify(line) + "\n");
  };

  const solve = pickSolver(method);
  const startMs = Date.now();
  let summary: ProbeSummary;
  try {
    summary = summarise(solve(prob, { verbose }));
  } finally {
    if (jsonlFd >= 0) closeSync(jsonlFd);
  }
  const wallMs = Date.now() - startMs;

  // Summary to stdout (so it doesn't interleave with the stderr trace).
  const hsdeBits =
    summary.tau === null
      ? ""
      : ` tau=${summary.tau.toExponential(2)} ` +
        `kappa=${(summary.kappa ?? 0).toExponential(2)} ` +
        `achievedPrecision=${(summary.achievedPrecision ?? Infinity).toExponential(2)}`;
  process.stdout.write(
    `status=${summary.status} method=${method} iter=${summary.iter} ` +
    `primalObj=${summary.primalObj.toExponential(8)} ` +
    `dualObj=${summary.dualObj.toExponential(8)} ` +
    `mu=${summary.mu.toExponential(2)} ` +
    `primalInf=${summary.primalInf.toExponential(2)} ` +
    `dualInf=${summary.dualInf.toExponential(2)}${hsdeBits} ` +
    `wallMs=${wallMs}\n`,
  );
  if (jsonlPath) process.stdout.write(`trace=${jsonlPath}\n`);
}

main();
