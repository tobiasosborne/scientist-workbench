// Registry discovery: scan tools/ for tool entry points (tools/<name>/tool.ts).
// `query` calls each tool with --schema/--examples/--invariants/--version and
// caches the result. Used by tools/registry-list and tools/registry-search.

import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { parse, type Value } from "@workbench/protocol";

export interface ToolMetadata {
  name: string;
  version: string;
  path: string;
  schema: { input: Value; output: Value };
  examples: Value[];
  invariants: Value[];
}

export async function findToolsRoot(start: string): Promise<string | null> {
  let d = start;
  for (let i = 0; i < 8; i++) {
    const candidate = join(d, "tools");
    try {
      const s = await stat(candidate);
      if (s.isDirectory()) return candidate;
    } catch {
      // continue
    }
    const parent = join(d, "..");
    if (parent === d) break;
    d = parent;
  }
  return null;
}

export async function listToolEntries(toolsRoot: string): Promise<{ name: string; path: string }[]> {
  const out: { name: string; path: string }[] = [];
  const entries = await readdir(toolsRoot, { withFileTypes: true });
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const candidate = join(toolsRoot, e.name, "tool.ts");
    try {
      const s = await stat(candidate);
      if (s.isFile()) out.push({ name: e.name, path: candidate });
    } catch {
      // skip directories without tool.ts
    }
  }
  out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return out;
}

function spawnText(cmd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    p.stdout.on("data", (b) => (stdout += b.toString("utf8")));
    p.stderr.on("data", (b) => (stderr += b.toString("utf8")));
    p.on("error", reject);
    p.on("close", (code) => resolve({ code: code ?? 0, stdout, stderr }));
  });
}

const BUN_CMD = process.env["BUN_BIN"] ?? "bun";

async function queryFlag(toolPath: string, flag: string): Promise<Value> {
  const r = await spawnText(BUN_CMD, [toolPath, `--${flag}`]);
  if (r.code !== 0) {
    throw new Error(`tool ${toolPath} failed --${flag}: ${r.stderr.trim()}`);
  }
  return parse(r.stdout);
}

export async function describeTool(toolPath: string, name: string): Promise<ToolMetadata> {
  const versionVal = await queryFlag(toolPath, "version");
  const schemaVal = await queryFlag(toolPath, "schema");
  const examplesVal = await queryFlag(toolPath, "examples");
  const invariantsVal = await queryFlag(toolPath, "invariants");

  if (versionVal.kind !== "record") throw new Error(`${name}: --version not a record`);
  const versionStr = versionVal.fields["version"];
  if (!versionStr || versionStr.kind !== "string") throw new Error(`${name}: --version.version not a string`);

  if (schemaVal.kind !== "record") throw new Error(`${name}: --schema not a record`);
  const schemaInput = schemaVal.fields["input"];
  const schemaOutput = schemaVal.fields["output"];
  if (!schemaInput || !schemaOutput) throw new Error(`${name}: --schema missing input/output`);

  const examples: Value[] = examplesVal.kind === "list" ? [...examplesVal.items] : [];
  const invariants: Value[] = invariantsVal.kind === "list" ? [...invariantsVal.items] : [];

  return {
    name,
    version: versionStr.value,
    path: toolPath,
    schema: { input: schemaInput, output: schemaOutput },
    examples,
    invariants,
  };
}
