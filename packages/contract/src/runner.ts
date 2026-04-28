// runTool — the standard contract dispatcher.
// Reads JSON from stdin (in the work case), writes canonical JSON to stdout.
// Standard flags: --schema --examples --invariants --version --help/-h
//                 --provenance-of <hash> --test
// Tool-specific flags follow `--key value` form and are passed to fn(input, flags).
// On success, writes a ProvenanceRecord indexed by output hash. See PRD §3.5, §4.1.

import {
  canonicalize,
  hash,
  list,
  parse,
  record,
  str,
  tagged,
  ToolError,
  type Value,
} from "@workbench/protocol";
import { readProvenance, writeProvenance } from "./provenance.js";
import { defaultStore } from "./store.js";

export interface ExampleEntry {
  description: string;
  input: Value;
  output?: Value;
  error?: string;
  flags?: Record<string, string>;
}

export interface InvariantEntry {
  name: string;
  statement: string;
  machine_checkable?: boolean;
}

export interface ToolDefinition {
  name: string;
  version: string;
  schema: { input: Value; output: Value };
  examples: ExampleEntry[];
  invariants: InvariantEntry[];
  fn: (input: Value, flags: Record<string, string>) => Value | Promise<Value>;
  test?: () => void | Promise<void>;
}

interface ParsedArgv {
  switches: Set<string>;
  named: Record<string, string>;
  positional: string[];
}

const STD_TAKES_VALUE = new Set(["provenance-of"]);

function parseArgv(argv: string[]): ParsedArgv {
  const switches = new Set<string>();
  const named: Record<string, string> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg.startsWith("--")) {
      const stripped = arg.slice(2);
      const eq = stripped.indexOf("=");
      if (eq >= 0) {
        named[stripped.slice(0, eq)] = stripped.slice(eq + 1);
      } else if (
        STD_TAKES_VALUE.has(stripped) ||
        (i + 1 < argv.length && !argv[i + 1]!.startsWith("-"))
      ) {
        const next = argv[i + 1];
        if (next === undefined) {
          switches.add(stripped);
        } else {
          named[stripped] = next;
          i++;
        }
      } else {
        switches.add(stripped);
      }
    } else if (arg === "-h") {
      switches.add("help");
    } else {
      positional.push(arg);
    }
  }
  return { switches, named, positional };
}

function exampleToValue(e: ExampleEntry): Value {
  const fields: Record<string, Value> = {
    description: str(e.description),
    input: e.input,
  };
  if (e.output !== undefined) fields["output"] = e.output;
  if (e.error !== undefined) fields["error"] = str(e.error);
  if (e.flags !== undefined) {
    const ff: Record<string, Value> = {};
    for (const [k, v] of Object.entries(e.flags)) ff[k] = str(v);
    fields["flags"] = record(ff);
  }
  return record(fields);
}

function invariantToValue(inv: InvariantEntry): Value {
  const fields: Record<string, Value> = {
    name: str(inv.name),
    statement: str(inv.statement),
  };
  if (inv.machine_checkable !== undefined) {
    fields["machine_checkable"] = { kind: "boolean", value: inv.machine_checkable };
  }
  return record(fields);
}

async function readStdin(): Promise<string> {
  if (typeof (globalThis as unknown as { Bun?: { stdin: { text(): Promise<string> } } }).Bun !== "undefined") {
    return await (globalThis as unknown as { Bun: { stdin: { text(): Promise<string> } } }).Bun.stdin.text();
  }
  let s = "";
  for await (const chunk of process.stdin) s += chunk;
  return s;
}

function writeOut(v: Value): void {
  process.stdout.write(canonicalize(v));
}

function helpText(def: ToolDefinition): string {
  const lines: string[] = [];
  lines.push(`${def.name} ${def.version}`);
  lines.push("");
  lines.push("Reads a JSON value from stdin and writes a JSON value to stdout.");
  lines.push("");
  lines.push("Standard flags:");
  lines.push("  --schema           emit input/output schema");
  lines.push("  --examples         emit list of examples");
  lines.push("  --invariants       emit list of invariants");
  lines.push("  --version          emit {name, version}");
  lines.push("  --provenance-of H  emit derivation tree for value-hash H if known");
  lines.push("  --test             run this tool's property tests in-process (if any)");
  lines.push("  -h, --help         this message");
  return lines.join("\n");
}

function ensureExtractFlags(named: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(named)) {
    if (k === "provenance-of") continue;
    out[k] = v;
  }
  return out;
}

export async function runTool(def: ToolDefinition): Promise<void> {
  const argv = process.argv.slice(2);
  const parsed = parseArgv(argv);

  try {
    if (parsed.switches.has("help")) {
      process.stdout.write(helpText(def));
      process.stdout.write("\n");
      return;
    }
    if (parsed.switches.has("version")) {
      writeOut(record({ name: str(def.name), version: str(def.version) }));
      return;
    }
    if (parsed.switches.has("schema")) {
      writeOut(record({ input: def.schema.input, output: def.schema.output }));
      return;
    }
    if (parsed.switches.has("examples")) {
      writeOut(list(def.examples.map(exampleToValue)));
      return;
    }
    if (parsed.switches.has("invariants")) {
      writeOut(list(def.invariants.map(invariantToValue)));
      return;
    }
    if (parsed.named["provenance-of"] !== undefined) {
      const h = parsed.named["provenance-of"];
      const store = process.env["CAS_STORE"] ?? defaultStore();
      const rec = await readProvenance(store, h);
      if (rec === null) {
        writeOut(tagged("provenance/not-found", str(h)));
        return;
      }
      const flagFields: Record<string, Value> = {};
      for (const [k, v] of Object.entries(rec.flags)) flagFields[k] = str(v);
      writeOut(
        record({
          flags: record(flagFields),
          inputs: list(rec.inputs.map((i) => record({ hash: str(i.hash), name: str(i.name) }))),
          output_hash: str(rec.output_hash),
          tool: record({ name: str(rec.tool.name), version: str(rec.tool.version) }),
        })
      );
      return;
    }
    if (parsed.switches.has("test")) {
      if (def.test === undefined) {
        process.stderr.write(`${def.name}: no --test suite registered\n`);
        process.exit(2);
      }
      await def.test();
      process.stdout.write(`${def.name} ${def.version}: tests passed\n`);
      return;
    }

    // Work case: read stdin, parse, validate, run fn, emit canonical output, write provenance.
    const stdinText = await readStdin();
    if (stdinText.trim().length === 0) {
      throw new ToolError(`${def.name}: no input on stdin`, {
        suggestion: "pipe a canonical JSON value to stdin or use --help",
      });
    }
    const input = parse(stdinText);
    const flags = ensureExtractFlags(parsed.named);
    const output = await def.fn(input, flags);
    const outBytes = canonicalize(output);
    process.stdout.write(outBytes);

    // Provenance write — append-only, content-addressed, no-op on hash collision.
    try {
      const inputHash = hash(input);
      const outputHash = hash(output);
      const store = process.env["CAS_STORE"] ?? defaultStore();
      await writeProvenance(store, {
        tool: { name: def.name, version: def.version },
        inputs: [{ name: "stdin", hash: inputHash }],
        flags,
        output_hash: outputHash,
      });
    } catch (e) {
      // Provenance failures must not destroy the user's output. Warn and move on.
      process.stderr.write(`${def.name}: warning — provenance write failed: ${(e as Error).message}\n`);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    process.stderr.write(`${def.name}: ${msg}\n`);
    process.exit(1);
  }
}
