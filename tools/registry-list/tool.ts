// registry-list — discover installed tools and emit their metadata.
// Input:  record { tools_root?: string }   (defaults to auto-discover)
// Output: list of records, each describing one tool's name, version, path,
//         schema, examples count, invariants count.
//
// PRD §6.2.

import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  expr,
  int,
  list,
  record,
  str,
  type Value,
} from "@workbench/protocol";
import { describeTool, findToolsRoot, listToolEntries, runTool } from "@workbench/contract";

const NAME = "registry-list";
const VERSION = "0.2.0";

void runTool({
  name: NAME,
  version: VERSION,
  schema: {
    input: record({ tools_root: str("optional override; default = auto-discover") }),
    output: list([
      record({
        name: str("<tool name>"),
        version: str("<tool version>"),
        path: str("<tool.ts path>"),
        schema_input: expr("<input schema sample>", []),
        schema_output: expr("<output schema sample>", []),
        examples_count: int(0n),
        invariants_count: int(0n),
      }),
    ]),
  },
  examples: [
    {
      description: "list all tools in the current workspace",
      input: record({}),
    },
    {
      description: "list tools in a specific directory",
      input: record({ tools_root: str("/path/to/tools") }),
    },
  ],
  invariants: [
    { name: "discovery-by-tool.ts", statement: "every directory inside tools/ containing tool.ts is listed", machine_checkable: true },
    { name: "alphabetical", statement: "results are sorted by name", machine_checkable: true },
    { name: "no-side-effects", statement: "querying the registry does not mutate any tool", machine_checkable: false },
  ],
  fn: async (input: Value, _flags: Record<string, string>): Promise<Value> => {
    let toolsRoot: string | null = null;
    if (input.kind === "record" && input.fields["tools_root"]?.kind === "string") {
      toolsRoot = input.fields["tools_root"].value;
    }
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
            schema_input: meta.schema.input,
            schema_output: meta.schema.output,
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
