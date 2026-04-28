// =============================================================================
// Registry — discover installed tools and read their declared metadata
// =============================================================================
//
// The registry exists for one user: an agent (or a human acting agent-
// shaped) that wants to plan a composition without first running every
// candidate tool. `findToolsRoot` locates the tools/ directory; for each
// directory containing a `tool.ts`, `describeTool` invokes the tool's
// standard metadata flags (`--version`, `--schema`, `--examples`,
// `--invariants`) and assembles a `ToolMetadata` record.
//
// Schema-aware reads
// ------------------
// As of ADR-0004 a tool's `--schema` output is the encoded form of a
// real `Schema` (not a sample value). `describeTool` decodes that wire
// form here, so callers (registry-list, registry-search) work with
// `Schema` objects directly. Filtering by kind, by expression head, or
// by deep-mention is then a clean call into the schema helpers
// (`schemaTopKind`, `schemaMentionsKind`, `schemaExpressionHead`).
//
// Latency note
// ------------
// `describeTool` shells out four times per tool. With many tools that
// becomes the registry's dominant cost (see beads issue
// scientist-workbench-tyq for the planned cache, which depends on the
// `defineTool` / `runTool` split tracked by scientist-workbench-yth).

import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { decodeSchema, parse, type Schema, type Value } from "@workbench/protocol";
import { spawnBun } from "./spawn.js";

export interface ToolMetadata {
  name: string;
  version: string;
  path: string;
  schema: { input: Schema; output: Schema };
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

async function queryFlag(toolPath: string, flag: string): Promise<Value> {
  const r = await spawnBun([toolPath, `--${flag}`]);
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
  if (!versionStr || versionStr.kind !== "string") {
    throw new Error(`${name}: --version.version not a string`);
  }

  if (schemaVal.kind !== "record") throw new Error(`${name}: --schema not a record`);
  const schemaInputV = schemaVal.fields["input"];
  const schemaOutputV = schemaVal.fields["output"];
  if (!schemaInputV || !schemaOutputV) throw new Error(`${name}: --schema missing input/output`);

  // ADR-0004: --schema output is encoded `Schema`. Decode here so callers
  // get a real Schema object, not a wire-form Value.
  let inputSchema: Schema;
  let outputSchema: Schema;
  try {
    inputSchema = decodeSchema(schemaInputV);
    outputSchema = decodeSchema(schemaOutputV);
  } catch (e) {
    throw new Error(`${name}: --schema decode failed: ${(e as Error).message}`);
  }

  const examples: Value[] = examplesVal.kind === "list" ? [...examplesVal.items] : [];
  const invariants: Value[] = invariantsVal.kind === "list" ? [...invariantsVal.items] : [];

  return {
    name,
    version: versionStr.value,
    path: toolPath,
    schema: { input: inputSchema, output: outputSchema },
    examples,
    invariants,
  };
}
