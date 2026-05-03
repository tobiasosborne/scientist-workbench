// =============================================================================
// Registry — discover installed tools and read their declared metadata
// =============================================================================
//
// The registry exists for one user: an agent (or a human acting agent-
// shaped) that wants to plan a composition without first running every
// candidate tool. `findToolsRoot` locates the tools/ directory; for each
// directory containing a `tool.ts`, `describeTool` imports the tool's
// module, reads the live `def` (a `ToolDefinition`), and assembles a
// `ToolMetadata` record.
//
// Schema-aware reads
// ------------------
// A tool's `def.schema.input` / `def.schema.output` are already real
// `Schema` objects (ADR-0004) — there is no decode step on this path
// because nothing was ever encoded for transport. Filtering by kind, by
// expression head, or by deep-mention is a clean call into the schema
// helpers (`schemaTopKind`, `schemaMentionsKind`, `schemaExpressionHead`).
//
// Why dynamic import, not a subprocess
// -------------------------------------
// Earlier versions of `describeTool` shelled out four times per tool
// (`--version`, `--schema`, `--examples`, `--invariants`). With ~20
// tools, a `registry-list` call paid ~80 spawns. ADR-0010 made every
// `tool.ts` an importable module: it exports `def` unconditionally and
// gates `runTool(def)` on `import.meta.main`. The registry now does
// `await import(toolPath)` once per tool, reads `mod.def`, and
// renders the metadata via the same helpers the runner uses for its
// `--examples` / `--invariants` flags. Output bytes are byte-identical
// to the spawn-era output. See beads issue scientist-workbench-tyq for
// the follow-up cache.
//
// Failure mode
// ------------
// A tool whose module fails to import, or whose module does not export
// `def`, surfaces as a `ToolMetadata`-shaped error in registry-list's
// output (the `error` field carries the message). `describeTool` itself
// throws so callers that want to fail-fast can do so.

import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { type Schema, type Value } from "@workbench/protocol";
import { exampleToValue, invariantToValue } from "./metadata.js";
import type { ToolDefinition } from "./runner.js";

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

/**
 * Import a tool module and return its exported `def`. Tool modules are
 * required (ADR-0010) to `export const def = defineTool({...})` and to
 * gate any `runTool(def)` call on `import.meta.main`, so importing for
 * metadata is side-effect free. A module that violates either part of
 * that contract surfaces as a thrown Error here.
 */
export async function importToolDef(toolPath: string): Promise<ToolDefinition> {
  const mod = (await import(toolPath)) as { def?: unknown };
  const def = mod.def;
  if (def === undefined) {
    throw new Error(
      `tool module at ${toolPath} does not export 'def'; ` +
      `every tool.ts must \`export const def = defineTool({...})\` (ADR-0010)`,
    );
  }
  // Light structural check — the type system enforces the shape at
  // compile time for tool authors using `defineTool`, but the registry
  // is consuming TS modules at runtime so we still want a clear error
  // if something foreign-shaped is exported.
  const d = def as { name?: unknown; version?: unknown; schema?: unknown; fn?: unknown };
  if (typeof d.name !== "string" || typeof d.version !== "string" || typeof d.fn !== "function") {
    throw new Error(
      `tool module at ${toolPath} exports a 'def' that is not a ToolDefinition ` +
      `(missing one of: name, version, fn)`,
    );
  }
  return def as ToolDefinition;
}

export async function describeTool(toolPath: string, name: string): Promise<ToolMetadata> {
  const def = await importToolDef(toolPath);
  return {
    name: def.name,
    version: def.version,
    path: toolPath,
    schema: { input: def.schema.input, output: def.schema.output },
    examples: def.examples.map(exampleToValue),
    invariants: def.invariants.map(invariantToValue),
  };
}
