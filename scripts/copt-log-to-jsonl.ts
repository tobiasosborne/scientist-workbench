// =============================================================================
// scripts/copt-log-to-jsonl.ts — convert a COPT iter log to a JSONL trace
// =============================================================================
//
// Thin CLI shell. The parsing logic — and the `TraceLine` schema the output
// conforms to — lives in `@workbench/solver-ipm` (`src/solver/TraceLog.ts`),
// where it is typechecked and unit-tested. This file is only argv handling
// and I/O; there is nothing here that can drift from the schema.
//
//     bun scripts/copt-log-to-jsonl.ts <copt.log> [<out.jsonl>]
//
// If <out.jsonl> is omitted, JSONL is written to stdout. The emitted lines
// feed `scripts/trace-diff.ts` for TS-vs-COPT divergence localisation.

import { readFileSync, writeFileSync } from "node:fs";
import { parseCoptLog } from "@workbench/solver-ipm";

function main(): void {
  const args = process.argv.slice(2);
  if (args.length < 1 || args.length > 2) {
    throw new Error("usage: bun scripts/copt-log-to-jsonl.ts <copt.log> [<out.jsonl>]");
  }
  const inPath = args[0]!;
  const outPath = args[1] ?? null;

  const lines = parseCoptLog(readFileSync(inPath, "utf-8"));
  if (lines.length === 0) {
    throw new Error(`no COPT iter lines found in ${inPath}`);
  }

  const body = lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
  if (outPath === null) {
    process.stdout.write(body);
  } else {
    writeFileSync(outPath, body);
    process.stdout.write(`wrote ${lines.length} iters to ${outPath}\n`);
  }
}

main();
