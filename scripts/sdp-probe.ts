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
//     bun scripts/sdp-probe.ts <path.dat-s> [--method=nt|aho|hkm] [--minimize]
//
// SDPLIB convention is maximisation (the SDPA-sparse format's b/C/A
// arrays encode the maximisation primal); we default to that. Pass
// `--minimize` for problems where the .dat-s file was written for the
// minimisation primal (rare; mostly own-derived test fixtures).
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
  formatVerboseLine,
  type SdpSolveResult,
  type VerboseIterLine,
  type SolveOptions,
} from "@workbench/solver-ipm";

type Method = "nt" | "aho" | "hkm";

function parseArgs(argv: string[]): { path: string; method: Method; maximize: boolean } {
  let path: string | null = null;
  let method: Method = "nt";
  let maximize = true; // SDPLIB convention
  for (const a of argv) {
    if (a.startsWith("--method=")) {
      const m = a.slice("--method=".length);
      if (m !== "nt" && m !== "aho" && m !== "hkm") {
        throw new Error(`--method must be one of nt|aho|hkm (got ${m})`);
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
    throw new Error("usage: bun scripts/sdp-probe.ts <path.dat-s> [--method=nt|aho|hkm] [--minimize]");
  }
  return { path, method, maximize };
}

function pickSolver(method: Method): (p: any, o: SolveOptions) => SdpSolveResult {
  switch (method) {
    case "nt":  return solveSdpNt;
    case "aho": return solveSdpAho;
    case "hkm": return solveSdpHkm;
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
  let result: SdpSolveResult;
  try {
    result = solve(prob, { verbose });
  } finally {
    if (jsonlFd >= 0) closeSync(jsonlFd);
  }
  const wallMs = Date.now() - startMs;

  // Summary to stdout (so it doesn't interleave with the stderr trace).
  process.stdout.write(
    `status=${result.status} method=${method} iter=${result.iter} ` +
    `primalObj=${result.primalObj.toExponential(8)} ` +
    `dualObj=${result.dualObj.toExponential(8)} ` +
    `mu=${result.mu.toExponential(2)} ` +
    `primalInf=${result.primalInf.toExponential(2)} ` +
    `dualInf=${result.dualInf.toExponential(2)} ` +
    `wallMs=${wallMs}\n`,
  );
  if (jsonlPath) process.stdout.write(`trace=${jsonlPath}\n`);
}

main();
