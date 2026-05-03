// =============================================================================
// registry-list — discover installed tools and emit their metadata
// =============================================================================
//
// For an agent landing cold in a workspace: walk `tools/`, ask each
// tool for its `--version`, `--schema`, `--examples`, `--invariants`,
// and assemble one record per tool. The `schema_input` and
// `schema_output` fields carry the tool's declared schema in the
// canonical encoded form (ADR-0004 wire format) so downstream consumers
// (notably an agent reading registry output) can decode and reason
// about types directly.
//
// PRD §6.2.

import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  encodeSchema,
  int,
  list,
  record,
  S,
  str,
  type Value,
} from "@workbench/protocol";
import { defineTool, describeTool, findToolsRoot, listToolEntries, runTool } from "@workbench/contract";

const NAME = "registry-list";
const VERSION = "0.3.0";

const inputSchema = S.record(
  { tools_root: S.kind("string") },
  { optional: ["tools_root"] }
);

// Each entry in the output list is a record describing one tool.
// `schema_input` and `schema_output` are wire-encoded Schemas
// (tagged values) — consumers decode via `decodeSchema` to get a
// real Schema back.
const entryRecordSchema = S.record(
  {
    name: S.kind("string"),
    version: S.kind("string"),
    path: S.kind("string"),
    schema_input: S.kind("tagged"),
    schema_output: S.kind("tagged"),
    examples_count: S.kind("integer"),
    invariants_count: S.kind("integer"),
    error: S.kind("string"),
  },
  // Either the metadata fields are present, or `error` is present
  // (when probing the tool failed). The schema admits both shapes via
  // a generous optional set; `fn` always emits exactly one or the
  // other. A future tightening could split this into a union of two
  // record shapes.
  {
    optional: [
      "version",
      "schema_input",
      "schema_output",
      "examples_count",
      "invariants_count",
      "error",
    ],
  }
);

const outputSchema = S.list(entryRecordSchema);

export const def = defineTool({
  name: NAME,
  version: VERSION,
  schema: { input: inputSchema, output: outputSchema },
  examples: [
    {
      description: "list all tools in the current workspace — output omitted; verifier checks shape",
      input: record({}),
    },
    {
      description: "list tools in a specific directory — output omitted; verifier checks shape",
      input: record({ tools_root: str("/path/to/tools") }),
    },
  ],
  invariants: [
    { name: "discovery-by-tool.ts", statement: "every directory inside tools/ containing tool.ts is listed", machine_checkable: true },
    { name: "alphabetical", statement: "results are sorted by name", machine_checkable: true },
    { name: "no-side-effects", statement: "querying the registry does not mutate any tool", machine_checkable: false },
  ],
  fn: async (input, _flags) => {
    let toolsRoot: string | null = input.fields.tools_root?.value ?? null;
    if (toolsRoot === null) {
      const here = dirname(fileURLToPath(import.meta.url));
      toolsRoot = await findToolsRoot(here);
      if (toolsRoot === null) {
        throw new Error("registry-list: could not locate a tools/ directory; pass tools_root explicitly");
      }
    }
    const entries = await listToolEntries(toolsRoot);
    const out: Value[] = [];
    for (const e of entries) {
      try {
        const meta = await describeTool(e.path, e.name);
        out.push(
          record({
            examples_count: int(BigInt(meta.examples.length)),
            invariants_count: int(BigInt(meta.invariants.length)),
            name: str(meta.name),
            path: str(meta.path),
            schema_input: encodeSchema(meta.schema.input),
            schema_output: encodeSchema(meta.schema.output),
            version: str(meta.version),
          })
        );
      } catch (err) {
        out.push(
          record({
            error: str((err as Error).message),
            name: str(e.name),
            path: str(e.path),
          })
        );
      }
    }
    return list(out);
  },
});

if (import.meta.main) void runTool(def);
