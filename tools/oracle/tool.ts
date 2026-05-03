// =============================================================================
// oracle — golden-master diffing harness
// =============================================================================
//
// Intent
// ------
// For a single tool's goldens directory, run the tool against each
// golden's input and compare its stdout to the recorded expected
// output. Modes:
//   - exact (default): canonical bytes must match.
//   - structural: hashes must match (allows the same Value emitted as
//     a different but canonically-equal byte string — never observed
//     in practice given the canonical encoder is bijective, but kept
//     as an explicit knob for future encoders).
//
// Schema (ADR-0004)
// -----------------
// Input: record { tool_path, goldens_dir, mode? } where mode is the
// literal-union "exact" | "structural". The schema runner enforces
// the mode enum and the field shape; the body trusts the narrowed
// input.
//
// Output: record { passed, failed, total, mode, results: list }
// where each result is a record { filename, passed, expected_hash?,
// actual_hash?, error? }.
//
// Process exit
// ------------
// On golden failure the oracle still emits its full results record
// to stdout (so consumers learn *which* goldens failed), then exits
// 1 from outside `fn`. We rely on `runTool`'s ToolError path: throw
// a ToolError carrying the result detail, and the runner emits the
// stderr line and exits non-zero. The result record is also returned
// from fn so a successful run produces a normal canonical output.
//
// PRD §4.5.

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
  S,
  str,
  type Value,
} from "@workbench/protocol";
import { defineTool, runTool, spawnBun } from "@workbench/contract";

const NAME = "oracle";
const VERSION = "0.3.0";

const inputSchema = S.record(
  {
    tool_path: S.kind("string"),
    goldens_dir: S.kind("string"),
    mode: S.union([S.literal(str("exact")), S.literal(str("structural"))]),
  },
  { optional: ["mode"] }
);

const resultRecordSchema = S.record(
  {
    filename: S.kind("string"),
    passed: S.kind("boolean"),
    expected_hash: S.kind("string"),
    actual_hash: S.kind("string"),
    error: S.kind("string"),
  },
  { optional: ["expected_hash", "actual_hash", "error"] }
);

const outputSchema = S.record({
  passed: S.kind("integer"),
  failed: S.kind("integer"),
  total: S.kind("integer"),
  mode: S.kind("string"),
  results: S.list(resultRecordSchema),
});

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

interface GoldenResult {
  filename: string;
  passed: boolean;
  expected_hash?: string;
  actual_hash?: string;
  error?: string;
}

function resultToValue(r: GoldenResult) {
  const fields: Record<string, Value> = {
    filename: str(r.filename),
    passed: bool(r.passed),
  };
  if (r.expected_hash !== undefined) fields["expected_hash"] = str(r.expected_hash);
  if (r.actual_hash !== undefined) fields["actual_hash"] = str(r.actual_hash);
  if (r.error !== undefined) fields["error"] = str(r.error);
  return record(fields);
}

export const def = defineTool({
  name: NAME,
  version: VERSION,
  schema: { input: inputSchema, output: outputSchema },
  examples: [
    {
      description: "run cas-simplify against its goldens — output omitted; verifier checks shape",
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
  fn: async (input, _flags) => {
    // Schema runner has narrowed input to {tool_path, goldens_dir, mode?}.
    const mode = (input.fields.mode?.value ?? "exact") as "exact" | "structural";
    const toolPath = input.fields.tool_path.value;
    const goldensDir = input.fields.goldens_dir.value;
    const goldens = await readGoldens(goldensDir);
    const results: GoldenResult[] = [];
    let passed = 0;
    let failed = 0;

    for (const g of goldens) {
      const expectedBytes = canonicalize(g.expected);
      const expectedHash = hash(g.expected);
      let r: GoldenResult;
      try {
        const proc = await spawnBun([toolPath, ...g.flags], canonicalize(g.input));
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

    // Failed goldens still produce a well-formed record, but we want
    // CI to see a non-zero exit. Emit the record on stdout and exit 1
    // before the runner's normal flow takes over. (Replacing this
    // pattern is tracked under beads issue scientist-workbench-qf1.)
    if (failed > 0) {
      process.stdout.write(canonicalize(out));
      process.exit(1);
    }
    return out;
  },
});

if (import.meta.main) void runTool(def);
