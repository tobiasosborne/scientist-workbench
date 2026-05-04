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
// `fn` always *returns* the results record — pass or fail — and never
// calls `process.exit`. This was the design fixed by bead `qf1`
// (worklog 038). Two consequences fall out of the change:
//
//   1. **Provenance is written for both pass and fail records.** The
//      runner's normal flow takes over: the record is canonicalised,
//      output-validated against the schema, and persisted into the
//      provenance store. A failed-golden run produces an output_hash
//      a CI consumer can `--provenance-of` to get the full per-golden
//      breakdown without re-running.
//   2. **In-process callers can't be killed mid-pipeline.** A
//      `wb.run("oracle", ...)` from `@workbench/compose` (ADR-0012)
//      gets back a Value, never a `process.exit` that takes down the
//      orchestrator. The cache-by-input-hash machinery (ADR-0012's
//      `runMemoized`) works on oracle outputs like any other tool's.
//
// CI exits-on-fail by inspecting the `failed` field of the returned
// record. `scripts/check.ts` does this for every per-tool oracle
// phase. Other consumers that want exit-1-on-fail behaviour write
// the same trivial check on the parsed stdout. The contract is
// "oracle is a pure function from (tool, goldens, mode) to a results
// record"; the exit decision lives where it belongs — at the caller.
//
// PRD §4.5.

import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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
import { defineTool, F, runTool, spawnBun } from "@workbench/contract";

const NAME = "oracle";
const VERSION = "0.4.0";

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
  flags: {
    // ADR-0011 demo flag. When set, the oracle emits one stderr line
    // per golden as it runs ("✓ name.golden.json" or "✗ name.golden.json:
    // <reason>") so a developer running `bun tools/oracle/tool.ts
    // --verbose` against a noisy goldens directory sees progress without
    // having to wait for the final summary record. Off by default.
    verbose: F.bool("emit per-golden progress lines to stderr"),
  },
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
      name: "fail-count-iff-mismatch",
      statement: "output.failed equals the count of goldens whose actual canonical bytes differ from expected",
      machine_checkable: true,
    },
    {
      name: "always-returns-record",
      statement: "fn always returns a well-formed record (never process.exit); CI inspects output.failed for the exit decision",
      machine_checkable: true,
    },
    {
      name: "no-mutation",
      statement: "oracle does not mutate goldens or the tool under test",
      machine_checkable: false,
    },
  ],
  fn: async (input, flags) => {
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
      if (flags.verbose) {
        const tag = r.passed ? "✓" : "✗";
        const detail = r.passed ? "" : `: ${r.error ?? "(no detail)"}`;
        process.stderr.write(`oracle: ${tag} ${r.filename}${detail}\n`);
      }
    }

    if (failed > 0) {
      process.stderr.write(`oracle: ${failed}/${results.length} goldens failed\n`);
      for (const r of results) {
        if (!r.passed) {
          process.stderr.write(`  FAIL ${r.filename}: ${r.error ?? "(no detail)"}\n`);
        }
      }
    }

    return record({
      failed: int(BigInt(failed)),
      mode: str(mode),
      passed: int(BigInt(passed)),
      results: list(results.map(resultToValue)),
      total: int(BigInt(results.length)),
    });
  },
  test: async () => {
    // Exercises the load-bearing contract change from bead `qf1` /
    // worklog 038: `fn` *returns* the results record even when goldens
    // fail, never `process.exit`-ing. Before the fix, the failing-
    // golden branch would have killed this test process; after, the
    // fn returns, the assertions run, and the temp dir is cleaned up.
    //
    // We use mod-pow as a real tool-under-test (its module is in the
    // workspace and `--test`-time resolution finds it via the file's
    // own URL). Two synthetic goldens: one with the right answer
    // (`2^3 mod 1000 == 8`), one with a deliberately-wrong expected
    // value (9). Pass-count must be 1; fail-count must be 1.
    const HERE = dirname(fileURLToPath(import.meta.url));     // tools/oracle/
    const ROOT = resolve(HERE, "..", "..");                   // repo root
    const modPowPath = join(ROOT, "tools", "mod-pow", "tool.ts");

    const dir = await mkdtemp(join(tmpdir(), "oracle-self-test-"));
    try {
      const passingGolden = canonicalize(record({
        input: record({ base: int(2n), exponent: int(3n), modulus: int(1000n) }),
        output: int(8n),
      }));
      const failingGolden = canonicalize(record({
        input: record({ base: int(2n), exponent: int(3n), modulus: int(1000n) }),
        output: int(9n),  // deliberately wrong; mod-pow returns 8
      }));
      await writeFile(join(dir, "01-pass.golden.json"), passingGolden);
      await writeFile(join(dir, "02-fail.golden.json"), failingGolden);

      const result = await def.fn(
        record({
          tool_path: str(modPowPath),
          goldens_dir: str(dir),
        }) as Parameters<typeof def.fn>[0],
        { verbose: false } as Parameters<typeof def.fn>[1],
      );

      if (result.kind !== "record") throw new Error("test: expected record output");
      const failedField = result.fields.failed;
      const passedField = result.fields.passed;
      const totalField = result.fields.total;
      if (failedField.kind !== "integer" || failedField.value !== "1") {
        throw new Error(`test: expected failed=1, got ${JSON.stringify(failedField)}`);
      }
      if (passedField.kind !== "integer" || passedField.value !== "1") {
        throw new Error(`test: expected passed=1, got ${JSON.stringify(passedField)}`);
      }
      if (totalField.kind !== "integer" || totalField.value !== "2") {
        throw new Error(`test: expected total=2, got ${JSON.stringify(totalField)}`);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
});

if (import.meta.main) void runTool(def);
