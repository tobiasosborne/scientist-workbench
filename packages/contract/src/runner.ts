// =============================================================================
// runTool — the standard contract dispatcher
// =============================================================================
//
// Every tool in the workbench has the same shape: read a JSON value from
// stdin, write a JSON value to stdout, and accept a fixed set of standard
// flags (--schema, --examples, --invariants, --version, --help/-h,
// --provenance-of, --test). This module owns that shape.
//
// What this module does
// ---------------------
// 1. Parses argv into switches + named flags (no positional args except the
//    optional value for --provenance-of).
// 2. Dispatches the standard flags. --schema, --examples, --invariants,
//    --version emit canonical JSON metadata. --provenance-of looks up a
//    derivation by output hash. --test runs the tool's optional in-process
//    property tests.
// 3. In the work case: parses stdin, *validates* the parsed Value against
//    `def.schema.input`, runs `def.fn`, validates the output against
//    `def.schema.output`, writes canonical bytes to stdout, and writes a
//    provenance record.
//
// The schema validation hooks (added in ADR-0004) replace the hand-rolled
// `expectIntegerField` / `parseFooInput` shims that every tool used to
// carry. Tool authors now declare a `Schema<I>` and the runner narrows
// the parsed Value to `I` before calling `fn`. The `fn` body sees an
// already-typed input.
//
// Output validation is not optional. A tool that returns a Value not
// conforming to its declared output schema is, by ADR-0004's rules,
// lying — and the project's "honest scope" discipline (PRD §6.1) is
// about declining work, not misreporting it. We surface the violation
// loudly as a ToolError.
//
// ADR-0010 — defineTool / runTool split
// -------------------------------------
// `defineTool({...})` is a typed identity wrapper that returns the
// ToolDefinition unchanged but fixes its `I` and `O` type parameters
// from the inline schema. `runTool(def, io?)` then performs the
// IO-bound dispatch above. Because every tool entry point gates the
// `runTool` call on `import.meta.main`, importing a tool module from
// elsewhere yields the live `def` without spawning a subprocess and
// without consuming stdin. The registry uses this to read tool
// metadata in-process; tests use it to call `def.fn(input, flags)`
// directly. The optional `RunIO` parameter is the second half of
// the same change: tests inject argv / stdin / stdout / stderr /
// exit / env so the dispatcher itself is exercisable without a child
// process.

import {
  canonicalize,
  decodeSchema,
  encodeSchema,
  hash,
  hashCanonicalBytes,
  list,
  parse,
  record,
  str,
  tagged,
  ToolError,
  validate,
  type Schema,
  type Value,
} from "@workbench/protocol";
import { exampleToValue, invariantToValue } from "./metadata.js";
import { provenanceToValue, readProvenance, writeProvenance, type ProvenanceRecord } from "./provenance.js";
import { defaultStore } from "./store.js";

// -----------------------------------------------------------------------------
// Public types
// -----------------------------------------------------------------------------
//
// `ToolDefinition<I, O>` is generic in the input and output Value types
// inferred from the schema. Tools that import `defineTool` and pass an
// inline schema get tight `fn` typing for free; the cost is invisible at
// the call site.

// `NoInfer<I>` makes the example's `input` checked against `I` without
// contributing to its inference. Otherwise TS picks `I` from the
// narrower of (schema-implied type) and (example-input type), and an
// example that omits an optional field would silently widen the
// inferred I to "record without that field" — which then breaks
// `fn`'s access to it. Schema is the source of truth; examples
// conform to it, not the other way around.
export interface ExampleEntry<I extends Value = Value, O extends Value = Value> {
  description: string;
  input: NoInfer<I>;
  output?: NoInfer<O>;
  error?: string;
  flags?: Record<string, string>;
}

export interface InvariantEntry {
  name: string;
  statement: string;
  machine_checkable?: boolean;
}

export interface ToolDefinition<I extends Value = Value, O extends Value = Value> {
  name: string;
  version: string;
  schema: { input: Schema<I>; output: Schema<O> };
  examples: ExampleEntry<I, O>[];
  invariants: InvariantEntry[];
  fn: (input: I, flags: Record<string, string>) => O | Promise<O>;
  test?: () => void | Promise<void>;
  /**
   * Manifest annotation introduced by ADR-0005. When set to `true`, this
   * tool may emit different output bytes across runs given the same stdin —
   * it is consuming OS-randomness or another genuinely nondeterministic
   * source. The flag propagates into the provenance record so a consumer
   * reading `--provenance-of <hash>` knows the output is not re-derivable
   * from inputs alone. Default (absent / false): the tool is strictly
   * deterministic; the existing contract holds. The privileged consumer
   * is `entropy-source`; every other tool that needs randomness should
   * declare an `entropy: string` field in its input schema and remain
   * deterministic given those bytes.
   */
  nondeterministic?: boolean;
}

/**
 * Identity wrapper around a `ToolDefinition` that exists purely so that
 * TypeScript can infer the `I` and `O` type parameters from the inline
 * `schema` argument at the call site. Authors write
 *
 *     export const def = defineTool({
 *       name: "mod-pow", version: "0.1.0",
 *       schema: { input: S.record({...}), output: S.kind("integer") },
 *       fn: (input, flags) => ...    // input is typed as the record, output as IntegerValue
 *     });
 *
 * Without `defineTool`, `runTool({...})` swallows the inference and `fn`'s
 * `input` parameter widens back to `Value`.
 *
 * Pure data: this function performs no IO. The companion `runTool` is
 * the IO-bound dispatcher; the split (ADR-0010) is what lets the
 * registry import `def` directly to read metadata in-process and lets
 * tests call `def.fn(input, flags)` without spawning a subprocess.
 */
export function defineTool<I extends Value, O extends Value>(
  def: ToolDefinition<I, O>
): ToolDefinition<I, O> {
  return def;
}

// -----------------------------------------------------------------------------
// Injectable IO
// -----------------------------------------------------------------------------
//
// `runTool` defaults to the real process bindings (argv, stdin, stdout,
// stderr, exit, env). Passing a `RunIO` overrides any subset of those —
// useful for tests, in-process composition, and any future surface that
// wants to run the dispatcher without owning the parent process.
//
// `exit` returns `never` because the production binding terminates the
// process. The test binding throws a typed `ExitSignal` that callers
// catch; either way, no code after `io.exit(...)` runs.

export interface RunIO {
  argv?: string[];
  stdin?: () => Promise<string>;
  stdout?: (chunk: string) => void;
  stderr?: (chunk: string) => void;
  exit?: (code: number) => never;
  env?: Record<string, string | undefined>;
}

interface ResolvedIO {
  argv: string[];
  stdin: () => Promise<string>;
  stdout: (chunk: string) => void;
  stderr: (chunk: string) => void;
  exit: (code: number) => never;
  env: Record<string, string | undefined>;
}

/**
 * Thrown by the test-side `exit` binding so that `runTool` halts cleanly
 * when invoked in-process. The production binding (process.exit) does
 * not throw; this class is only observed when callers supply their own
 * `io.exit`.
 */
export class ExitSignal extends Error {
  constructor(public readonly code: number) {
    super(`runTool exit ${code}`);
    this.name = "ExitSignal";
  }
}

function resolveIO(io: RunIO | undefined): ResolvedIO {
  return {
    argv: io?.argv ?? process.argv.slice(2),
    stdin: io?.stdin ?? readStdin,
    stdout: io?.stdout ?? ((c: string) => { process.stdout.write(c); }),
    stderr: io?.stderr ?? ((c: string) => { process.stderr.write(c); }),
    exit: io?.exit ?? ((code: number) => process.exit(code)),
    env: io?.env ?? (process.env as Record<string, string | undefined>),
  };
}

// -----------------------------------------------------------------------------
// Argv parsing
// -----------------------------------------------------------------------------
//
// Three forms are recognised:
//   --flag           switch (flag in `switches`)
//   --flag=value     named (named[flag] = value)
//   --flag value     named, when the flag is in STD_TAKES_VALUE or the
//                    next arg does not start with `-`. This last
//                    heuristic is the historical footgun (see beads
//                    issue scientist-workbench-rej for the planned
//                    typed-flag overhaul); for now keep behaviour
//                    compatible with v0.2 callers.

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

// -----------------------------------------------------------------------------
// Stdin (default binding)
// -----------------------------------------------------------------------------

async function readStdin(): Promise<string> {
  // Bun exposes `Bun.stdin.text()` which is faster than the iterator path.
  // Fall back to the Node iterator under plain `node`.
  const g = globalThis as unknown as { Bun?: { stdin: { text(): Promise<string> } } };
  if (typeof g.Bun !== "undefined") return g.Bun.stdin.text();
  let s = "";
  for await (const chunk of process.stdin) s += chunk;
  return s;
}

// -----------------------------------------------------------------------------
// Help text
// -----------------------------------------------------------------------------

function helpText<I extends Value, O extends Value>(def: ToolDefinition<I, O>): string {
  const lines: string[] = [];
  lines.push(`${def.name} ${def.version}`);
  lines.push("");
  lines.push("Reads a JSON value from stdin and writes a JSON value to stdout.");
  lines.push("");
  lines.push("Standard flags:");
  lines.push("  --schema           emit input/output schema (encodeSchema'd Values)");
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

// -----------------------------------------------------------------------------
// Examples-conform-to-schema check (load-time)
// -----------------------------------------------------------------------------
//
// ADR-0004: `examples[i].input` and `examples[i].output` must conform to
// the declared schema. Catching this at tool-load time turns drift into
// an immediate, named failure rather than a goldens-mismatch hours
// later.
//
// Cost: linear in the example payload, capped by the example count
// (typically 10–30). Well under the 100ms cold-start budget.

function checkExamplesAgainstSchema<I extends Value, O extends Value>(def: ToolDefinition<I, O>): void {
  for (let i = 0; i < def.examples.length; i++) {
    const e = def.examples[i]!;
    const inputCheck = validate(e.input, def.schema.input);
    if (!inputCheck.ok) {
      throw new Error(
        `${def.name}: example #${i + 1} ('${e.description}') input does not conform to schema.input ` +
        `(at $.${inputCheck.failure.path.join(".") || "<root>"}): ${inputCheck.failure.message}`
      );
    }
    if (e.output !== undefined) {
      const outputCheck = validate(e.output, def.schema.output);
      if (!outputCheck.ok) {
        throw new Error(
          `${def.name}: example #${i + 1} ('${e.description}') output does not conform to schema.output ` +
          `(at $.${outputCheck.failure.path.join(".") || "<root>"}): ${outputCheck.failure.message}`
        );
      }
    }
  }
}

// -----------------------------------------------------------------------------
// Public API: runTool
// -----------------------------------------------------------------------------

export async function runTool<I extends Value, O extends Value>(
  def: ToolDefinition<I, O>,
  io?: RunIO,
): Promise<void> {
  const r = resolveIO(io);
  const writeOut = (v: Value): void => { r.stdout(canonicalize(v)); };
  const parsed = parseArgv(r.argv);

  try {
    // Examples-conform-to-schema is a load-time invariant. Run it once on
    // every entry into runTool — most invocations are cheap (validation
    // on small examples), and we want the failure surfaced early on the
    // metadata paths too (--examples, --schema), not just in the work
    // case. Skipping is opt-in for genuinely-pathological surfaces.
    if (r.env["WB_SKIP_SCHEMA_CHECK"] !== "1") {
      checkExamplesAgainstSchema(def);
    }

    if (parsed.switches.has("help")) {
      r.stdout(helpText(def));
      r.stdout("\n");
      return;
    }
    if (parsed.switches.has("version")) {
      writeOut(record({ name: str(def.name), version: str(def.version) }));
      return;
    }
    if (parsed.switches.has("schema")) {
      writeOut(
        record({
          input: encodeSchema(def.schema.input),
          output: encodeSchema(def.schema.output),
        })
      );
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
      const store = r.env["CAS_STORE"] ?? defaultStore();
      const rec = await readProvenance(store, h);
      if (rec === null) {
        writeOut(tagged("provenance/not-found", str(h)));
        return;
      }
      writeOut(provenanceToValue(rec));
      return;
    }
    if (parsed.switches.has("test")) {
      const t = def.test;
      if (t === undefined) {
        r.stderr(`${def.name}: no --test suite registered\n`);
        r.exit(2);
        return;  // unreachable in production (process.exit), reachable when io.exit throws or no-ops
      }
      await t();
      r.stdout(`${def.name} ${def.version}: tests passed\n`);
      return;
    }

    // ── Work case ────────────────────────────────────────────────────────
    //
    // 1. Read stdin. Refuse on empty input — a tool shouldn't silently do
    //    something on no input.
    // 2. Parse to a Value (rejects raw numbers, unknown kinds).
    // 3. Validate input against schema.input. Failure here is user-facing:
    //    the agent gave a wrong-shaped value.
    // 4. Call fn with the narrowed input.
    // 5. Validate output against schema.output. Failure here is internal:
    //    the tool produced a value that doesn't match its own contract.
    // 6. Canonicalise output bytes (one-shot — used both for stdout and
    //    for the provenance hash; see beads issue scientist-workbench-wmh).
    // 7. Write to stdout. Write provenance (best-effort; failures here
    //    must not destroy the user's output).

    const stdinText = await r.stdin();
    if (stdinText.trim().length === 0) {
      throw new ToolError(`${def.name}: no input on stdin`, {
        suggestion: "pipe a canonical JSON value to stdin or use --help",
      });
    }
    const input = parse(stdinText);
    const inputCheck = validate(input, def.schema.input);
    if (!inputCheck.ok) {
      throw new ToolError(
        `${def.name}: input does not conform to schema (at $.${
          inputCheck.failure.path.join(".") || "<root>"
        }): ${inputCheck.failure.message}`,
        {
          suggestion: "run `--schema` to see the declared shape; check field names, kinds, and required fields",
          detail: { path: inputCheck.failure.path },
        }
      );
    }
    const flags = ensureExtractFlags(parsed.named);
    const output = await def.fn(input as I, flags);

    const outputCheck = validate(output, def.schema.output);
    if (!outputCheck.ok) {
      // Internal contract violation. Loud failure — see ADR-0004.
      throw new ToolError(
        `${def.name}: tool output violates declared schema (internal bug, at $.${
          outputCheck.failure.path.join(".") || "<root>"
        }): ${outputCheck.failure.message}`,
        {
          suggestion: "the tool's `fn` returned a Value that does not conform to schema.output; this is a bug in the tool, not the input",
          detail: { path: outputCheck.failure.path },
        }
      );
    }

    const outBytes = canonicalize(output);
    r.stdout(outBytes);

    // Provenance: append-only, content-addressed. Hash from the canonical
    // bytes we already have rather than re-canonicalising via hash().
    try {
      const inputHash = hash(input);
      const outputHash = hashCanonicalBytes(outBytes);
      const store = r.env["CAS_STORE"] ?? defaultStore();
      const rec: ProvenanceRecord = {
        tool: { name: def.name, version: def.version },
        inputs: [{ name: "stdin", hash: inputHash }],
        flags,
        output_hash: outputHash,
      };
      if (def.nondeterministic === true) rec.nondeterministic = true;
      await writeProvenance(store, rec);
    } catch (e) {
      // Provenance failures must not destroy the user's output. Warn and move on.
      r.stderr(`${def.name}: warning — provenance write failed: ${(e as Error).message}\n`);
    }
  } catch (e) {
    if (e instanceof ExitSignal) throw e;  // already an explicit exit; propagate
    const msg = e instanceof Error ? e.message : String(e);
    r.stderr(`${def.name}: ${msg}\n`);
    r.exit(1);
  }
}

// -----------------------------------------------------------------------------
// Helper for callers that want to decode a `--schema` result
// -----------------------------------------------------------------------------
//
// Re-exported here for ergonomic discovery: tools that read another
// tool's schema (registry-list, registry-search) want `decodeSchema`
// in scope without reaching into the protocol package directly.

export { decodeSchema };
