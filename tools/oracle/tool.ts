// oracle — golden-master diffing harness.
// Input: record { tool_path, goldens_dir, mode? }
//   tool_path:    string — path to the tool's tool.ts (run via `bun <path>`)
//   goldens_dir:  string — directory of *.golden.json files
//   mode:         optional string — "exact" (default) | "structural"
// Each golden is a record {input, output, flags?}. The harness pipes
// canonical(input) into the tool's stdin (with `flags` joined as argv) and
// compares the tool's stdout to the canonical expected output.
//
// Output: record { passed, failed, total, results: [...] }
// Exits 0 iff failed === 0.
//
// PRD §4.5.

import { spawn } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  bool,
  canonicalize,
  hash,
  int,
  list,
  parse,
  record,
  str,
  type Value,
} from "@workbench/protocol";
import { runTool } from "@workbench/contract";

const NAME = "oracle";
const VERSION = "0.2.0";
const BUN = process.env["BUN_BIN"] ?? "bun";

interface GoldenFile {
  filename: string;
  input: Value;
  expected: Value;
  flags: string[];
}

async function readGoldens(dir: string): Promise<GoldenFile[]> {
  const entries = await readdir(dir);
  const out: GoldenFile[] = [];
  for (const name of entries.sort()) {
    if (!name.endsWith(".golden.json")) continue;
    const p = join(dir, name);
    const s = await stat(p);
    if (!s.isFile()) continue;
    const raw = await readFile(p, "utf8");
    const v = parse(raw);
    if (v.kind !== "record") {
      throw new Error(`${name}: golden top-level must be a record (got ${v.kind})`);
    }
    const inputV = v.fields["input"];
    const outputV = v.fields["output"];
    if (!inputV) throw new Error(`${name}: missing input`);
    if (!outputV) throw new Error(`${name}: missing output`);
    const flagsV = v.fields["flags"];
    const flags: string[] = [];
    if (flagsV !== undefined) {
      if (flagsV.kind !== "record") throw new Error(`${name}: flags must be a record`);
      for (const [k, fv] of Object.entries(flagsV.fields)) {
        if (fv.kind !== "string") throw new Error(`${name}: flag ${k} must be a string value`);
        flags.push(`--${k}=${fv.value}`);
      }
    }
    out.push({ filename: name, input: inputV, expected: outputV, flags });
  }
  return out;
}

function runUnderTest(toolPath: string, flags: string[], inputBytes: string): Promise<{
  code: number;
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolve, reject) => {
    const p = spawn(BUN, [toolPath, ...flags], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    p.stdout.on("data", (b) => (stdout += b.toString("utf8")));
    p.stderr.on("data", (b) => (stderr += b.toString("utf8")));
    p.on("error", reject);
    p.on("close", (code) => resolve({ code: code ?? 0, stdout, stderr }));
    p.stdin.write(inputBytes, "utf8");
    p.stdin.end();
  });
}

interface GoldenResult {
  filename: string;
  passed: boolean;
  expected_hash?: string;
  actual_hash?: string;
  error?: string;
}

function resultToValue(r: GoldenResult): Value {
  const fields: Record<string, Value> = {
    filename: str(r.filename),
    passed: bool(r.passed),
  };
  if (r.expected_hash !== undefined) fields["expected_hash"] = str(r.expected_hash);
  if (r.actual_hash !== undefined) fields["actual_hash"] = str(r.actual_hash);
  if (r.error !== undefined) fields["error"] = str(r.error);
  return record(fields);
}

async function fn(input: Value, _flags: Record<string, string>): Promise<Value> {
  if (input.kind !== "record") {
    throw new Error(`oracle: input must be a record (got ${input.kind})`);
  }
  const toolPathV = input.fields["tool_path"];
  const goldensDirV = input.fields["goldens_dir"];
  const modeV = input.fields["mode"];
  if (!toolPathV || toolPathV.kind !== "string") {
    throw new Error("oracle: tool_path must be a string");
  }
  if (!goldensDirV || goldensDirV.kind !== "string") {
    throw new Error("oracle: goldens_dir must be a string");
  }
  const mode = modeV !== undefined && modeV.kind === "string" ? modeV.value : "exact";
  if (mode !== "exact" && mode !== "structural") {
    throw new Error(`oracle: unsupported mode ${JSON.stringify(mode)}`);
  }

  const goldens = await readGoldens(goldensDirV.value);
  const results: GoldenResult[] = [];
  let passed = 0;
  let failed = 0;

  for (const g of goldens) {
    const expectedBytes = canonicalize(g.expected);
    const expectedHash = hash(g.expected);
    let r: GoldenResult;
    try {
      const proc = await runUnderTest(toolPathV.value, g.flags, canonicalize(g.input));
      if (proc.code !== 0) {
        r = {
          filename: g.filename,
          passed: false,
          error: `tool exit ${proc.code}: ${proc.stderr.trim() || "(no stderr)"}`,
          expected_hash: expectedHash,
        };
      } else {
        const actualV = parse(proc.stdout);
        const actualBytes = canonicalize(actualV);
        const actualHash = hash(actualV);
        const ok = mode === "exact" ? actualBytes === expectedBytes : actualHash === expectedHash;
        r = {
          filename: g.filename,
          passed: ok,
          expected_hash: expectedHash,
          actual_hash: actualHash,
        };
        if (!ok) {
          r.error =
            mode === "exact"
              ? `canonical bytes differ: expected ${expectedBytes.length} bytes, got ${actualBytes.length} bytes`
              : `hash mismatch (mode=structural)`;
        }
      }
    } catch (e) {
      r = {
        filename: g.filename,
        passed: false,
        error: (e as Error).message,
        expected_hash: expectedHash,
      };
    }
    results.push(r);
    if (r.passed) passed++;
    else failed++;
  }

  if (failed > 0) {
    process.stderr.write(`oracle: ${failed}/${results.length} goldens failed\n`);
    for (const r of results) {
      if (!r.passed) {
        process.stderr.write(`  FAIL ${r.filename}: ${r.error ?? "(no detail)"}\n`);
      }
    }
  }

  const out = record({
    failed: int(BigInt(failed)),
    mode: str(mode),
    passed: int(BigInt(passed)),
    results: list(results.map(resultToValue)),
    total: int(BigInt(results.length)),
  });

  if (failed > 0) {
    process.stdout.write(canonicalize(out));
    process.exit(1);
  }
  return out;
}

void runTool({
  name: NAME,
  version: VERSION,
  schema: {
    input: record({
      tool_path: str("path to tool.ts"),
      goldens_dir: str("path to goldens dir containing *.golden.json"),
      mode: str("exact | structural (optional, default exact)"),
    }),
    output: record({
      passed: int(0n),
      failed: int(0n),
      total: int(0n),
      mode: str("exact"),
      results: list([]),
    }),
  },
  examples: [
    {
      description: "run cas-simplify against its goldens",
      input: record({
        tool_path: str("tools/cas-simplify/tool.ts"),
        goldens_dir: str("tools/cas-simplify/goldens"),
      }),
    },
  ],
  invariants: [
    {
      name: "exit-iff-fail",
      statement: "process exits 0 iff every golden's canonical output matches expected",
      machine_checkable: true,
    },
    {
      name: "no-mutation",
      statement: "oracle does not mutate goldens or the tool under test",
      machine_checkable: false,
    },
  ],
  fn,
});
