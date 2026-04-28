// =============================================================================
// registry-search — filter the tool registry by schema-derived predicates
// =============================================================================
//
// Intent
// ------
// An agent planning a composition asks "what consumes a string?" or
// "what produces a record?" and gets back the subset of tools whose
// schemas match. Filters AND-conjoin: every provided filter must pass.
//
// Schema-aware
// ------------
// As of ADR-0004, `--schema` output is the wire form of a real
// `Schema`. `describeTool` decodes it inside the registry helpers.
// The filter predicates here use `schemaTopKind`, `schemaMentionsKind`,
// and `schemaExpressionHead` from the protocol — proper schema
// queries, not heuristic walks over a sample-value tree.
//
// Filter axes
// -----------
//   tools_root      override the auto-discovery root (otherwise walk up).
//   input_kind      schema.input top kind matches, OR mentions this kind anywhere.
//   output_kind     same for schema.output.
//   head            schema.output is an `expression` schema with this head.
//   name_substring  case-insensitive substring of tool name.

import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  encodeSchema,
  isKind,
  list,
  record,
  S,
  schemaExpressionHead,
  schemaMentionsKind,
  schemaTopKind,
  str,
  type Value,
} from "@workbench/protocol";
import { defineTool, describeTool, findToolsRoot, listToolEntries, runTool } from "@workbench/contract";

const NAME = "registry-search";
const VERSION = "0.4.0";

const inputSchema = S.record(
  {
    tools_root: S.kind("string"),
    input_kind: S.kind("string"),
    output_kind: S.kind("string"),
    head: S.kind("string"),
    name_substring: S.kind("string"),
  },
  { optional: ["tools_root", "input_kind", "output_kind", "head", "name_substring"] }
);

const entryRecordSchema = S.record({
  name: S.kind("string"),
  version: S.kind("string"),
  path: S.kind("string"),
  schema_input: S.kind("tagged"),
  schema_output: S.kind("tagged"),
});

const outputSchema = S.list(entryRecordSchema);

export const def = defineTool({
  name: NAME,
  version: VERSION,
  schema: { input: inputSchema, output: outputSchema },
  examples: [
    {
      description: "find tools that consume a string (likely parsers) — output omitted; verifier checks shape",
      input: record({ input_kind: str("string") }),
    },
    {
      description: "find tools that produce a record (likely verification verdicts) — output omitted; verifier checks shape",
      input: record({ output_kind: str("record") }),
    },
    {
      description: "find tools that produce an integer (e.g. modular arithmetic) — output omitted; verifier checks shape",
      input: record({ output_kind: str("integer") }),
    },
    {
      description: "find tools that consume an integer-bearing record — output omitted; verifier checks shape",
      input: record({ input_kind: str("integer") }),
    },
    {
      description: "find tools by name — output omitted; verifier checks shape",
      input: record({ name_substring: str("cas") }),
    },
  ],
  invariants: [
    { name: "subset-of-list", statement: "registry-search results are a subset of registry-list results", machine_checkable: true },
    { name: "predicate-is-conjunction", statement: "all provided filters apply with AND semantics", machine_checkable: false },
  ],
  fn: async (input, _flags) => {
    const filterInputKind = input.fields.input_kind?.value ?? null;
    const filterOutputKind = input.fields.output_kind?.value ?? null;
    const filterHead = input.fields.head?.value ?? null;
    const filterNameSub = input.fields.name_substring?.value.toLowerCase() ?? null;

    let toolsRoot: string | null = input.fields.tools_root?.value ?? null;
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
    let describeErrors = 0;
    for (const e of entries) {
      if (filterNameSub && !e.name.toLowerCase().includes(filterNameSub)) continue;
      queried++;
      let meta;
      try {
        meta = await describeTool(e.path, e.name);
      } catch (err) {
        describeErrors++;
        process.stderr.write(`registry-search: describe ${e.name} failed: ${(err as Error).message}\n`);
        continue;
      }
      // Top-level OR deep-mention match — covers both "string in,
      // expression out" tools and "record-of-integers in" tools.
      if (filterInputKind && isKind(filterInputKind)) {
        const top = schemaTopKind(meta.schema.input);
        if (top !== filterInputKind && !schemaMentionsKind(meta.schema.input, filterInputKind)) continue;
      }
      if (filterOutputKind && isKind(filterOutputKind)) {
        const top = schemaTopKind(meta.schema.output);
        if (top !== filterOutputKind && !schemaMentionsKind(meta.schema.output, filterOutputKind)) continue;
      }
      if (filterHead && schemaExpressionHead(meta.schema.output) !== filterHead) continue;
      out.push(
        record({
          name: str(meta.name),
          path: str(meta.path),
          schema_input: encodeSchema(meta.schema.input),
          schema_output: encodeSchema(meta.schema.output),
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
    return list(out);
  },
});

void runTool(def);
