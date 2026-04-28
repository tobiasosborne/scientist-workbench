// Walk tools/<name>/goldens.spec.ts files, run each tool against its inputs,
// and write canonical {input, output, flags?} records to tools/<name>/goldens/.
//
// Usage:  bun scripts/generate-goldens.ts [--check] [--tool <name>]
//   default writes goldens (replacing any existing files in each goldens dir)
//   --check        fails if any existing golden's expected output differs from current
//   --tool <name>  restrict to one tool

import { mkdir, readFile, readdir, writeFile, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  canonicalize,
  parse,
  record,
  str,
  type Value,
} from "@workbench/protocol";
import { spawnBun, type GoldenSpec } from "@workbench/contract";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);
const TOOLS = join(ROOT, "tools");

const argv = process.argv.slice(2);
const CHECK = argv.includes("--check");
const toolFilterIdx = argv.indexOf("--tool");
const TOOL_FILTER = toolFilterIdx >= 0 ? argv[toolFilterIdx + 1] : null;

interface ToolBatch {
  name: string;
  toolPath: string;
  goldensDir: string;
  goldens: GoldenSpec[];
}

async function discoverBatches(): Promise<ToolBatch[]> {
  const entries = await readdir(TOOLS, { withFileTypes: true });
  const out: ToolBatch[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (TOOL_FILTER && e.name !== TOOL_FILTER) continue;
    const specPath = join(TOOLS, e.name, "goldens.spec.ts");
    const toolPath = join(TOOLS, e.name, "tool.ts");
    try {
      await stat(specPath);
      await stat(toolPath);
    } catch {
      continue;
    }
    const mod = (await import(specPath)) as { goldens?: GoldenSpec[] };
    if (!Array.isArray(mod.goldens)) {
      console.error(`✗ ${e.name}: goldens.spec.ts must export const goldens: GoldenSpec[]`);
      continue;
    }
    out.push({
      name: e.name,
      toolPath,
      goldensDir: join(TOOLS, e.name, "goldens"),
      goldens: mod.goldens,
    });
  }
  out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return out;
}


function slug(desc: string, n: number): string {
  const s = desc
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
  return `${String(n).padStart(2, "0")}-${s}.golden.json`;
}

async function generate(batch: ToolBatch): Promise<{ written: number; failures: number; mismatches: number; missing: number }> {
  if (batch.goldens.length === 0) {
    console.log(`  (no goldens registered)`);
    return { written: 0, failures: 0, mismatches: 0, missing: 0 };
  }
  await mkdir(batch.goldensDir, { recursive: true });
  if (!CHECK) {
    const existing = await readdir(batch.goldensDir);
    for (const f of existing) {
      if (f.endsWith(".golden.json")) await rm(join(batch.goldensDir, f));
    }
  }
  let written = 0;
  let failures = 0;
  let mismatches = 0;
  let missing = 0;
  for (let i = 0; i < batch.goldens.length; i++) {
    const g = batch.goldens[i]!;
    const flagsArgs: string[] = [];
    if (g.flags) for (const [k, v] of Object.entries(g.flags)) flagsArgs.push(`--${k}=${v}`);
    const inputBytes = canonicalize(g.input);
    const r = await spawnBun([batch.toolPath, ...flagsArgs], inputBytes);
    if (r.code !== 0) {
      console.error(`  ✗ ${g.description}: tool exit ${r.code}: ${r.stderr.trim()}`);
      failures++;
      continue;
    }
    let outValue: Value;
    try {
      outValue = parse(r.stdout);
    } catch (e) {
      console.error(`  ✗ ${g.description}: tool output not a valid value: ${(e as Error).message}`);
      failures++;
      continue;
    }
    const golden: Record<string, Value> = { input: g.input, output: outValue };
    if (g.flags) {
      const ff: Record<string, Value> = {};
      for (const [k, v] of Object.entries(g.flags)) ff[k] = str(v);
      golden["flags"] = record(ff);
    }
    const goldenBytes = canonicalize(record(golden));
    const path = join(batch.goldensDir, slug(g.description, i + 1));
    if (CHECK) {
      try {
        const existing = await readFile(path, "utf8");
        if (existing !== goldenBytes) {
          console.error(`  ✗ ${slug(g.description, i + 1)}: golden mismatch`);
          mismatches++;
        }
      } catch {
        console.error(`  ✗ ${slug(g.description, i + 1)}: missing golden file`);
        missing++;
      }
    } else {
      await writeFile(path, goldenBytes, "utf8");
      written++;
    }
  }
  return { written, failures, mismatches, missing };
}

const batches = await discoverBatches();
let totalWritten = 0;
let totalFailures = 0;
let totalMismatches = 0;
let totalMissing = 0;
for (const b of batches) {
  console.log(`\n=== ${b.name} (${b.goldens.length} cases) ===`);
  const r = await generate(b);
  totalWritten += r.written;
  totalFailures += r.failures;
  totalMismatches += r.mismatches;
  totalMissing += r.missing;
  console.log(`  written=${r.written} failures=${r.failures} mismatches=${r.mismatches} missing=${r.missing}`);
}
console.log(`\nTotal: written=${totalWritten} failures=${totalFailures} mismatches=${totalMismatches} missing=${totalMissing}`);
if (totalFailures > 0 || totalMismatches > 0 || totalMissing > 0) process.exit(1);
