// registry-search — filter the tool registry by input kind, output kind,
// expression head, or name substring. Useful for an agent planning a
// composition by type rather than by name (PRD §6.2 / §6.3).
//
// Input:  record { tools_root?: string, input_kind?: string,
//                  output_kind?: string, head?: string, name_substring?: string }
// Output: list of records (same shape as registry-list)

import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  asSchemaKind,
  expr,
  int,
  kindOf,
  list,
  record,
  str,
  type Value,
} from "@workbench/protocol";
import { describeTool, findToolsRoot, listToolEntries, runTool } from "@workbench/contract";

const NAME = "registry-search";
const VERSION = "0.3.0";

// Top-level kind, with the schema-kind annotation unwrapped: a schema slot
// declared `kindOf("integer")` is *for matching purposes* an integer.
function topKind(v: Value): string {
  const sk = asSchemaKind(v);
  return sk ?? v.kind;
}

function expressionHead(v: Value): string | null {
  return v.kind === "expression" ? v.head : null;
}

// Sub-tree search. Schema-kind annotations count as a member of the kind
// they name; we still walk into their (symbol) payload as well, so a
// schema that wraps a deeper structure is searchable.
function recurseHasKind(v: Value, kind: string): boolean {
  const sk = asSchemaKind(v);
  if (sk !== null) {
    if (sk === kind) return true;
    // schema-kind markers are leaves for our purposes — don't recurse into
    // their (symbol) payload.
    return false;
  }
  if (v.kind === kind) return true;
  switch (v.kind) {
    case "list":
      return v.items.some((x) => recurseHasKind(x, kind));
    case "record":
      return Object.values(v.fields).some((x) => recurseHasKind(x, kind));
    case "expression":
      return v.args.some((x) => recurseHasKind(x, kind));
    case "tagged":
      return recurseHasKind(v.payload, kind);
    default:
      return false;
  }
}

void runTool({
  name: NAME,
  version: VERSION,
  schema: {
    input: record({
      tools_root: str("optional override; default = auto-discover"),
      input_kind: str("optional: filter to tools whose schema.input top-level kind matches"),
      output_kind: str("optional: filter to tools whose schema.output top-level kind matches"),
      head: str("optional: filter to tools whose schema.output is an expression with this head"),
      name_substring: str("optional: case-insensitive substring of tool name"),
    }),
    output: list([
      record({
        name: str("<tool name>"),
        version: str("<tool version>"),
        path: str("<tool.ts path>"),
        schema_input: expr("<input schema sample>", []),
        schema_output: expr("<output schema sample>", []),
      }),
    ]),
  },
  examples: [
    {
      description: "find tools that consume a string (likely parsers)",
      input: record({ input_kind: str("string") }),
    },
    {
      description: "find tools that produce a record (likely verification verdicts)",
      input: record({ output_kind: str("record") }),
    },
    {
      description: "find tools that produce an integer (e.g. modular arithmetic)",
      input: record({ output_kind: str("integer") }),
    },
    {
      description: "find tools that consume an integer-bearing record",
      input: record({ input_kind: str("integer") }),
    },
    {
      description: "find tools by name",
      input: record({ name_substring: str("cas") }),
    },
  ],
  invariants: [
    { name: "subset-of-list", statement: "registry-search results are a subset of registry-list results", machine_checkable: true },
    { name: "predicate-is-conjunction", statement: "all provided filters apply with AND semantics", machine_checkable: false },
  ],
  fn: async (input: Value, _flags: Record<string, string>): Promise<Value> => {
    if (input.kind !== "record") throw new Error("registry-search: input must be a record");
    const tr = input.fields["tools_root"];
    const ik = input.fields["input_kind"];
    const ok = input.fields["output_kind"];
    const hd = input.fields["head"];
    const ns = input.fields["name_substring"];
    const filterInputKind = ik?.kind === "string" ? ik.value : null;
    const filterOutputKind = ok?.kind === "string" ? ok.value : null;
    const filterHead = hd?.kind === "string" ? hd.value : null;
    const filterNameSub = ns?.kind === "string" ? ns.value.toLowerCase() : null;

    let toolsRoot: string | null = null;
    if (tr?.kind === "string") toolsRoot = tr.value;
    if (toolsRoot === null) {
      const here = dirname(fileURLToPath(import.meta.url));
      toolsRoot = await findToolsRoot(here);
      if (toolsRoot === null) {
        throw new Error("registry-search: could not locate a tools/ directory; pass tools_root explicitly");
      }
    }
    const entries = await listToolEntries(toolsRoot);
    const out: Value[] = [];
    let queried = 0;
    let described = 0;
    let describeErrors = 0;
    for (const e of entries) {
      if (filterNameSub && !e.name.toLowerCase().includes(filterNameSub)) continue;
      queried++;
      let meta;
      try {
        meta = await describeTool(e.path, e.name);
        described++;
      } catch (err) {
        describeErrors++;
        process.stderr.write(`registry-search: describe ${e.name} failed: ${(err as Error).message}\n`);
        continue;
      }
      if (filterInputKind && topKind(meta.schema.input) !== filterInputKind && !recurseHasKind(meta.schema.input, filterInputKind)) continue;
      if (filterOutputKind && topKind(meta.schema.output) !== filterOutputKind && !recurseHasKind(meta.schema.output, filterOutputKind)) continue;
      if (filterHead && expressionHead(meta.schema.output) !== filterHead) continue;
      out.push(
        record({
          name: str(meta.name),
          path: str(meta.path),
          schema_input: meta.schema.input,
          schema_output: meta.schema.output,
          version: str(meta.version),
        })
      );
    }
    if (describeErrors > 0) {
      process.stderr.write(
        `registry-search: ${describeErrors}/${queried} tools failed --schema/--version/--examples/--invariants probe; ` +
        `result list is incomplete. Set BUN_BIN or fix the failing tools.\n`
      );
    }
    void int;
    void described;
    void kindOf;
    return list(out);
  },
});
