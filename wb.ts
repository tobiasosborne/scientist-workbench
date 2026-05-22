// =============================================================================
// wb — the scientist-workbench discovery CLI
// =============================================================================
//
// Invocation:  bun wb.ts [subcommand] [args...]
//          or:  bun run wb -- [subcommand] [args...]
//
// What this is
// ------------
// `wb` is the single discovery entry point for the workbench. It is NOT a
// value-protocol tool — it has no seven-artefact contract, no `def`, no
// `goldens/`. It is a literate CLI script that lives at the repo root so
// the invocation `bun wb.ts` is as short as it can be. Its only job is to
// answer the question an agent (or a human acting agent-shaped) has on
// landing in the repo: *what can this workbench do, and how do I call it?*
//
// The progressive-discovery model (ADR-0043, issue scientist-workbench-ixnv.4)
// ---------------------------------------------------------------------------
// Before this CLI, an agent had to read a 400-line `README.md` top to
// bottom before the first tool call. That is a heavy, all-or-nothing
// bootstrap. The progressive-discovery model replaces it with four tiers,
// each reached only when the agent actually needs it:
//
//   Tier 0 — `README.md`. A ~35-line bootstrap: what a tool is (one JSON
//            value in on stdin, one out on stdout), the one hard fact
//            (numerics are strings, no raw JSON numbers, no `null`), and
//            the first command — `bun wb.ts`. Nothing else. An agent reads
//            Tier 0 once and never again.
//
//   Tier 1 — `wb` (no args). Lists every tool: name + one-line summary,
//            read from the LIVE registry (a `tools/` walk — never a static
//            list; ADR-0043's hard constraint). This is the index: scan it
//            by name, then drill in.
//
//   Tier 2 — `wb <tool>`. Pretty-prints one tool's schema, examples, and
//            invariants — everything needed to assemble a correct first
//            invocation of that tool. `wb search` is the type-driven
//            sibling: "what consumes a string?", "what produces a record?".
//
//   Tier 3 — `wb protocol` / `wb contract`. The author- and
//            reference-facing prose — the value protocol, the schema
//            language, the seven-artefact contract, how to write a tool.
//            An agent only invoking tools never needs Tier 3; a tool
//            author reads it once.
//
// The design invariant: an agent can go from zero knowledge to a correct
// first tool invocation using ONLY the Tier-0 README plus this CLI. Every
// fact it needs is reachable by `bun wb.ts` and then `bun wb.ts <tool>`.
//
// Why the live registry, never a static list
// -------------------------------------------
// ADR-0043 makes the tool registry the single source of truth for
// tool-facing docs. A `wb` that read a hand-maintained tool list would be a
// NEW drift surface — the exact thing the `ixnv` epic exists to remove. So
// `wb` walks `tools/`, imports each tool's `def` (ADR-0010 guarantees that
// import is side-effect-free — the `runTool` call is gated on
// `import.meta.main`), and reads `def.name` / `def.summary` / `def.schema`
// / `def.examples` / `def.invariants` directly. The same `describeTool` /
// `listToolEntries` / `findToolsRoot` helpers `registry-list` and
// `registry-search` already use. `wb search` literally invokes the
// `registry-search` tool's `def.fn` in-process — it reuses discovery, it
// does not reimplement it.
//
// Failure mode
// ------------
// Unknown subcommands and unknown tool names fail loud (Rule 1) with a
// "did you mean…" suggestion computed by edit distance against the live
// registry. A discovery CLI that silently does nothing on a typo is worse
// than useless — it teaches the agent the wrong thing.

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  canonicalize,
  type Schema,
  type SchemaNode,
  type Value,
} from "@workbench/protocol";
import {
  describeTool,
  findToolsRoot,
  importToolDef,
  listToolEntries,
} from "@workbench/contract";
import { def as registrySearchDef } from "./tools/registry-search/tool.ts";

// -----------------------------------------------------------------------------
// Root resolution
// -----------------------------------------------------------------------------
// `wb.ts` lives at the repo root, so the directory of this module IS the
// root. We still route through `findToolsRoot` rather than hardcoding
// `join(HERE, "tools")` so that a future relocation of this script does not
// silently break discovery — the helper walks up to eight parents looking
// for a `tools/` directory.

const HERE = dirname(fileURLToPath(import.meta.url));

async function resolveToolsRoot(): Promise<string> {
  const root = await findToolsRoot(HERE);
  if (root === null) {
    throw new Error(
      "wb: could not locate a tools/ directory. Run wb from inside a " +
        "scientist-workbench checkout.",
    );
  }
  return root;
}

// -----------------------------------------------------------------------------
// Schema rendering — a compact one-line human form of a wire Schema
// -----------------------------------------------------------------------------
// `--schema` emits the verbose wire encoding of a `Schema`; that is the
// right shape for a machine consumer that will `decodeSchema` it, but it is
// unreadable in a terminal. `describeTool` hands us a decoded `Schema`
// object directly (no decode step on the in-process path), so `wb <tool>`
// renders that structural tree to a terse, deterministic one-liner — the
// same spirit as a TypeScript type signature. This is a *display*
// rendering, not a wire format: it is never parsed back.

function renderSchema(s: Schema): string {
  return renderNode(s.node);
}

function renderNode(node: SchemaNode): string {
  switch (node.tag) {
    case "any":
      return "any";
    case "kind":
      return node.kind;
    case "literal":
      return `literal(${canonicalize(node.value)})`;
    case "list":
      return `list<${renderNode(node.element.node)}>`;
    case "tuple":
      return `tuple[${node.items.map((i) => renderNode(i.node)).join(", ")}]`;
    case "record": {
      const fields = Object.entries(node.fields).map(([k, v]) => {
        const opt = node.optional.has(k) ? "?" : "";
        return `${k}${opt}: ${renderNode(v.node)}`;
      });
      return `record{ ${fields.join(", ")} }`;
    }
    case "expression": {
      const head = node.head === null ? "*" : node.head;
      const args =
        node.args === null
          ? "…"
          : node.args.map((a) => renderNode(a.node)).join(", ");
      return `expression(${head})[${args}]`;
    }
    case "tagged": {
      const tag = node.tagName === null ? "*" : `"${node.tagName}"`;
      return `tagged(${tag}, ${renderNode(node.payload.node)})`;
    }
    case "union":
      return node.alts.map((a) => renderNode(a.node)).join(" | ");
  }
}

// -----------------------------------------------------------------------------
// Value rendering — the canonical bytes of a value, for examples
// -----------------------------------------------------------------------------
// An example's `input` / `output` are full `Value`s. The canonical
// encoding is exactly what an agent would pipe into a tool, so rendering an
// example as its canonical bytes doubles as a copy-pasteable invocation
// fragment. We do not pretty-print with indentation: the canonical form is
// dense by design, and a dense one-liner is what goes after `echo '…' |`.

function renderValue(v: Value): string {
  return canonicalize(v);
}

// -----------------------------------------------------------------------------
// "Did you mean…" — edit distance for failure suggestions
// -----------------------------------------------------------------------------
// Both an unknown subcommand and an unknown tool name should fail loud with
// a concrete suggestion (Rule 1). A small Levenshtein implementation picks
// the closest known name; if nothing is within a sane threshold we fall
// back to "run `wb` to list everything", which is always correct advice.

function editDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const row: number[] = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    let prev = row[0]!;
    row[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = row[j]!;
      row[j] =
        a[i - 1] === b[j - 1]
          ? prev
          : 1 + Math.min(prev, row[j]!, row[j - 1]!);
      prev = tmp;
    }
  }
  return row[n]!;
}

function closestName(query: string, candidates: string[]): string | null {
  let best: string | null = null;
  let bestD = Infinity;
  for (const c of candidates) {
    const d = editDistance(query, c);
    if (d < bestD) {
      bestD = d;
      best = c;
    }
  }
  // A suggestion is only useful if it is genuinely close — accept it when
  // the edit distance is at most a third of the longer string's length.
  if (best !== null && bestD <= Math.max(2, Math.ceil(best.length / 3))) {
    return best;
  }
  return null;
}

// -----------------------------------------------------------------------------
// Tier 1 — `wb` with no args: the tool index
// -----------------------------------------------------------------------------
// Walk the live registry, import each `def`, print `name` + one-line
// `summary` aligned in a column. The footer is the discovery map: it names
// every other subcommand so an agent who ran `wb` once knows the whole CLI
// surface without reading this source.

async function cmdList(): Promise<number> {
  const toolsRoot = await resolveToolsRoot();
  const entries = await listToolEntries(toolsRoot);
  if (entries.length === 0) {
    process.stdout.write("wb: no tools found under tools/\n");
    return 0;
  }

  const rows: { name: string; summary: string }[] = [];
  for (const e of entries) {
    let summary = "(no summary)";
    try {
      const def = await importToolDef(e.path);
      if (def.summary !== undefined) summary = def.summary;
    } catch (err) {
      summary = `(failed to import: ${(err as Error).message})`;
    }
    rows.push({ name: e.name, summary });
  }

  const width = rows.reduce((w, r) => Math.max(w, r.name.length), 0);
  process.stdout.write(
    `scientist-workbench — ${rows.length} tools (live registry)\n\n`,
  );
  for (const r of rows) {
    process.stdout.write(`  ${r.name.padEnd(width)}   ${r.summary}\n`);
  }
  process.stdout.write(
    "\n" +
      "Next:\n" +
      "  bun wb.ts <tool>                 schema, examples, invariants for one tool\n" +
      "  bun wb.ts search [filters]       find tools by type (--consumes / --produces / …)\n" +
      "  bun wb.ts protocol               the value protocol, schema language, invocation\n" +
      "  bun wb.ts contract               the seven-artefact contract; writing a tool\n" +
      "  bun wb.ts help                   usage\n",
  );
  return 0;
}

// -----------------------------------------------------------------------------
// Tier 2 — `wb <tool>`: one tool's schema, examples, invariants
// -----------------------------------------------------------------------------
// `describeTool` imports the tool and hands back decoded `Schema`s plus the
// wire-form `examples` / `invariants` Values. We render the schema with the
// compact one-liner above, and each example as its canonical input bytes
// (a copy-pasteable invocation fragment). On an unknown tool name we fail
// loud with the closest registry match.

async function cmdTool(name: string): Promise<number> {
  const toolsRoot = await resolveToolsRoot();
  const entries = await listToolEntries(toolsRoot);
  const entry = entries.find((e) => e.name === name);
  if (entry === undefined) {
    const suggestion = closestName(
      name,
      entries.map((e) => e.name),
    );
    process.stderr.write(`wb: no tool named '${name}'.\n`);
    if (suggestion !== null) {
      process.stderr.write(`  did you mean '${suggestion}'?\n`);
    }
    process.stderr.write("  run `bun wb.ts` to list every tool.\n");
    return 1;
  }

  const meta = await describeTool(entry.path, entry.name);
  const def = await importToolDef(entry.path);

  process.stdout.write(`${meta.name}  (v${meta.version})\n`);
  if (def.summary !== undefined) {
    process.stdout.write(`${def.summary}\n`);
  }
  // Surface the determinism tier — it is part of "how do I call this":
  // an `arbprec` tool answers `--precision`, a `numerical` tool's output
  // is platform-conditioned, a `nondeterministic` tool opts out of the
  // determinism contract entirely.
  const tier =
    def.arbprec === true
      ? "arbprec (bit-identical cross-platform given --precision=N)"
      : def.numerical === true
        ? "numerical (bit-identical given the platform fingerprint)"
        : def.nondeterministic === true
          ? "nondeterministic (opts out of the determinism contract)"
          : "symbolic (bit-identical cross-platform forever)";
  process.stdout.write(`tier: ${tier}\n`);

  process.stdout.write("\nSCHEMA\n");
  process.stdout.write(`  input  : ${renderSchema(meta.schema.input)}\n`);
  process.stdout.write(`  output : ${renderSchema(meta.schema.output)}\n`);

  process.stdout.write(`\nEXAMPLES (${meta.examples.length})\n`);
  for (const ex of meta.examples) {
    // Each example is a record { description, input, output?, error?,
    // flags? }. We read the fields defensively — the shape is the wire
    // form `exampleToValue` produced, so the fields are always Values.
    if (ex.kind !== "record") continue;
    const desc = ex.fields["description"];
    const input = ex.fields["input"];
    const output = ex.fields["output"];
    const error = ex.fields["error"];
    const flags = ex.fields["flags"];
    const descStr =
      desc !== undefined && desc.kind === "string" ? desc.value : "(example)";
    process.stdout.write(`  • ${descStr}\n`);
    if (input !== undefined) {
      process.stdout.write(`      in   : ${renderValue(input)}\n`);
    }
    if (flags !== undefined && flags.kind === "record") {
      const fl = Object.entries(flags.fields)
        .map(([k, v]) => `--${k}=${v.kind === "string" ? v.value : "?"}`)
        .join(" ");
      if (fl.length > 0) process.stdout.write(`      flags: ${fl}\n`);
    }
    if (output !== undefined) {
      process.stdout.write(`      out  : ${renderValue(output)}\n`);
    }
    if (error !== undefined && error.kind === "string") {
      process.stdout.write(`      error: ${error.value}\n`);
    }
  }

  process.stdout.write(`\nINVARIANTS (${meta.invariants.length})\n`);
  for (const inv of meta.invariants) {
    if (inv.kind !== "record") continue;
    const nm = inv.fields["name"];
    const stmt = inv.fields["statement"];
    const nmStr = nm !== undefined && nm.kind === "string" ? nm.value : "?";
    const stmtStr =
      stmt !== undefined && stmt.kind === "string" ? stmt.value : "?";
    process.stdout.write(`  • ${nmStr}: ${stmtStr}\n`);
  }

  process.stdout.write(
    "\nRun it:\n" +
      `  echo '<canonical-json-input>' | bun tools/${meta.name}/tool.ts\n` +
      `  bun tools/${meta.name}/tool.ts --help        # the full flag table\n` +
      `  bun tools/${meta.name}/tool.ts --schema       # the machine-readable schema\n`,
  );
  return 0;
}

// -----------------------------------------------------------------------------
// Tier 2 — `wb search`: type-driven discovery, wrapping registry-search
// -----------------------------------------------------------------------------
// `wb search` does not reimplement registry filtering — it builds the
// `registry-search` tool's input record from the friendly flags and calls
// that tool's `def.fn` in-process. The result is a list of records; we
// render each as `name — input → output` so the agent sees the type
// signature alongside the name.
//
// Flags:
//   --consumes <kind>   tools whose input schema mentions <kind>
//   --produces <kind>   tools whose output schema mentions <kind>
//   --head <h>          tools whose output is an expression with head <h>
//   --name <substr>     tools whose name contains <substr>

function parseSearchFlags(
  args: string[],
): { ok: true; fields: Record<string, Value> } | { ok: false; msg: string } {
  // Map the friendly flag names to the registry-search input field names.
  const aliases: Record<string, string> = {
    "--consumes": "input_kind",
    "--produces": "output_kind",
    "--head": "head",
    "--name": "name_substring",
  };
  const fields: Record<string, Value> = {};
  for (let i = 0; i < args.length; i++) {
    const tok = args[i]!;
    let flag = tok;
    let inlineVal: string | null = null;
    const eq = tok.indexOf("=");
    if (eq !== -1) {
      flag = tok.slice(0, eq);
      inlineVal = tok.slice(eq + 1);
    }
    const field = aliases[flag];
    if (field === undefined) {
      return {
        ok: false,
        msg:
          `wb search: unknown filter '${flag}'. ` +
          `known filters: --consumes, --produces, --head, --name.`,
      };
    }
    let value: string;
    if (inlineVal !== null) {
      value = inlineVal;
    } else {
      const next = args[i + 1];
      if (next === undefined) {
        return { ok: false, msg: `wb search: '${flag}' needs a value.` };
      }
      value = next;
      i++;
    }
    fields[field] = { kind: "string", value };
  }
  return { ok: true, fields };
}

async function cmdSearch(args: string[]): Promise<number> {
  const parsed = parseSearchFlags(args);
  if (!parsed.ok) {
    process.stderr.write(`${parsed.msg}\n`);
    return 1;
  }
  if (Object.keys(parsed.fields).length === 0) {
    process.stderr.write(
      "wb search: no filters given — that would list everything.\n" +
        "  use one or more of: --consumes <kind>, --produces <kind>, " +
        "--head <h>, --name <substr>.\n" +
        "  e.g. bun wb.ts search --consumes string --produces expression\n" +
        "  (run `bun wb.ts` for the plain full list.)\n",
    );
    return 1;
  }

  // Invoke the registry-search tool's fn directly. Its `fn` takes the
  // typed input record and a flags object; we pass an empty flags object
  // (registry-search declares no tool-specific flags). The input record is
  // exactly what its schema expects: a record of optional string fields.
  const input = { kind: "record" as const, fields: parsed.fields };
  // The `fn` is typed against registry-search's own schema; we have built
  // a conforming value, so the cast is the seam between the dynamic CLI
  // surface and the typed tool body.
  const result = await registrySearchDef.fn(
    input as Parameters<typeof registrySearchDef.fn>[0],
    {} as Parameters<typeof registrySearchDef.fn>[1],
  );

  if (result.kind !== "list") {
    process.stderr.write("wb search: registry-search returned a non-list.\n");
    return 1;
  }
  if (result.items.length === 0) {
    process.stdout.write("wb search: no tools match those filters.\n");
    return 0;
  }
  process.stdout.write(`${result.items.length} match(es):\n\n`);
  for (const item of result.items) {
    if (item.kind !== "record") continue;
    const nm = item.fields["name"];
    const nmStr = nm !== undefined && nm.kind === "string" ? nm.value : "?";
    process.stdout.write(`  ${nmStr}\n`);
  }
  process.stdout.write("\n  drill in with: bun wb.ts <tool>\n");
  return 0;
}

// -----------------------------------------------------------------------------
// Tier 3 — `wb protocol` / `wb contract`: the reference prose
// -----------------------------------------------------------------------------
// These two subcommands print the relocated author-facing documentation —
// `docs/protocol.md` (the value protocol, schema language, invocation,
// provenance) and `docs/contract.md` (the seven-artefact contract, writing
// a tool, hard requirements, verification). They are plain Markdown; we
// stream the file to stdout verbatim so a pager (`bun wb.ts protocol |
// less`) works.

async function cmdDoc(which: "protocol" | "contract"): Promise<number> {
  const path = join(HERE, "docs", `${which}.md`);
  let text: string;
  try {
    text = await Bun.file(path).text();
  } catch {
    process.stderr.write(
      `wb: could not read docs/${which}.md (expected at ${path}).\n`,
    );
    return 1;
  }
  process.stdout.write(text);
  if (!text.endsWith("\n")) process.stdout.write("\n");
  return 0;
}

// -----------------------------------------------------------------------------
// `wb help` — the usage screen
// -----------------------------------------------------------------------------

function cmdHelp(): number {
  process.stdout.write(
    "wb — the scientist-workbench discovery CLI\n" +
      "\n" +
      "Usage:\n" +
      "  bun wb.ts                        list every tool (name + one-line summary)\n" +
      "  bun wb.ts <tool>                 schema, examples, invariants for one tool\n" +
      "  bun wb.ts search [filters]       find tools by type\n" +
      "  bun wb.ts protocol               the value protocol, schema language, invocation\n" +
      "  bun wb.ts contract               the seven-artefact contract; writing a tool\n" +
      "  bun wb.ts help | -h              this screen\n" +
      "\n" +
      "Search filters (AND-conjoined):\n" +
      "  --consumes <kind>    input schema mentions <kind>\n" +
      "  --produces <kind>    output schema mentions <kind>\n" +
      "  --head <h>           output is an expression with head <h>\n" +
      "  --name <substr>      tool name contains <substr>\n" +
      "\n" +
      "Progressive discovery: README.md (Tier 0) → `bun wb.ts` (Tier 1) →\n" +
      "`bun wb.ts <tool>` (Tier 2) → `bun wb.ts protocol|contract` (Tier 3).\n",
  );
  return 0;
}

// -----------------------------------------------------------------------------
// Dispatch
// -----------------------------------------------------------------------------
// argv[2] onward is the wb command line (argv[0] = bun, argv[1] = wb.ts).
// No subcommand ⇒ Tier 1 list. A leading `--`/`-` that is not `-h` is a
// malformed invocation. Anything else is either a known subcommand or a
// tool name; an unknown one fails loud with a suggestion.

async function main(): Promise<number> {
  const argv = process.argv.slice(2);

  if (argv.length === 0) return cmdList();

  const sub = argv[0]!;
  const rest = argv.slice(1);

  switch (sub) {
    case "help":
    case "--help":
    case "-h":
      return cmdHelp();
    case "search":
      return cmdSearch(rest);
    case "protocol":
      return cmdDoc("protocol");
    case "contract":
      return cmdDoc("contract");
    default:
      break;
  }

  // A flag-shaped first token that is not a recognised subcommand is a
  // malformed invocation — fail loud rather than treat `--foo` as a tool
  // name.
  if (sub.startsWith("-")) {
    process.stderr.write(
      `wb: unknown option '${sub}'. run \`bun wb.ts help\` for usage.\n`,
    );
    return 1;
  }

  // Otherwise treat `sub` as a tool name. `cmdTool` itself fails loud with
  // a suggestion if the name is not in the live registry.
  if (rest.length > 0) {
    process.stderr.write(
      `wb: '${sub}' takes no further arguments (got '${rest.join(" ")}'). ` +
        "did you mean `bun wb.ts search`?\n",
    );
    return 1;
  }
  return cmdTool(sub);
}

const code = await main();
process.exit(code);
