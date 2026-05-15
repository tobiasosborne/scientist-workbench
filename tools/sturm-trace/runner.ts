// =============================================================================
// sturm-trace / runner — the subprocess entry point invoked by tool.ts
// =============================================================================
//
// Why this file exists
// --------------------
// `tools/sturm-trace/tool.ts` is the *outer* tool: it reads
// `record{source, entry?}` from stdin, writes the user source to a
// workspace-resident scratch file, and spawns this runner via `spawnBun`
// to actually execute the user code in a fresh Bun process. The
// runner's job is to:
//
//   1. Dynamic-import the user's source file (Bun handles TS natively;
//      a syntax error or module-not-found is caught here).
//   2. Find the entry function — `<entry>` or `default`.
//   3. Call the entry once. It must return a `Channel<I, O>` instance
//      from `@workbench/sturm` (i.e., the user wrote `return trace(...)`
//      and exported the result-producing function).
//   4. Print the canonical bytes of `channel.toValue()` to stdout.
//
// On any failure, the runner prints a single-line JSON record to stderr
// describing the refusal class and exits 1. The outer tool catches the
// non-zero exit, parses the JSON, and routes to the appropriate
// `tagged "sturm-trace/<class>"` envelope per ADR-0038 / ADR-0003.
//
// Why a subprocess at all
// -----------------------
// ADR-0001: subprocesses give us a clean module-state boundary. The
// user's source may register module-level effects, leak handles,
// allocate trace state — none of which we want bleeding into the
// orchestrator. A fresh Bun process per call is the simplest
// containment story; this is the same pattern `@workbench/sturm`'s
// own `execute()` already uses to spawn `sturm-execute`.
//
// Why no Bennett-missing envelope yet
// -----------------------------------
// The bead's earlier notes named `tagged "sturm-trace/bennett-missing"`
// for the case where the user calls `oracle(...)`. But `oracle` is not
// exported from `@workbench/sturm` and `@bennett/core` does not exist
// in this workspace — so a user importing `oracle` triggers a
// module-not-found error at `await import(sourcePath)` time, which we
// already route through `parse-error`. The separate envelope class
// becomes meaningful only once Bennett-TS lands and exports a real
// `oracle` symbol that throws a typed `BennettMissingError`; until
// then, folding it under `parse-error` is the honest scope.
//
// I/O protocol
// ------------
//   argv[2] = absolute path to the user source file (.ts)
//   argv[3] = entry function name (string; default "default")
//
//   Success: code=0, stdout = canonical bytes of the IR Value.
//   Failure: code=1, stderr = `<json line>\n` matching `RunnerError`.
//
// stderr in success paths is reserved for the user's own writes (they
// can `console.error(...)` from their trace body; we don't strip or
// reorder). The outer tool ignores stderr when code=0.

import { Channel, InvalidWhenBodyError } from "@workbench/sturm";
import { canonicalize } from "@workbench/protocol";

// -----------------------------------------------------------------------------
// Refusal-class JSON shape — matches the outer tool's parser.
// -----------------------------------------------------------------------------
//
// `class` is the discriminator that the outer tool routes on. The fields
// after it are optional per-class; the outer tool's parser is tolerant
// of missing optional fields.

interface RunnerError {
  readonly class:
    | "parse-error"            // import failed (syntax, missing module, etc.)
    | "invalid-when-body"      // a non-rotation op fired inside `when` (ADR-0038)
    | "non-channel-return"     // the entry didn't return a Channel
    | "runtime-error";         // any other exception from the user code
  readonly message: string;
  // invalid-when-body payload (ADR-0038 envelope spec):
  readonly op?: string;
  readonly controls?: readonly string[]; // bigints encoded as decimal strings
}

// The runner is invoked with an absolute scratch-file path that varies
// every call (mkdtemp suffix). We scrub the path and its parent dir
// out of error messages before emitting, so the outer tool's refusal
// envelopes are byte-stable across invocations — load-bearing for
// golden files.
let SCRUB_FILE: string | null = null;
let SCRUB_DIR: string | null = null;

function scrub(s: string): string {
  let out = s;
  if (SCRUB_FILE !== null) out = out.split(SCRUB_FILE).join("<source>");
  if (SCRUB_DIR !== null) out = out.split(SCRUB_DIR).join("<scratch>");
  return out;
}

function fail(err: RunnerError): never {
  const sanitized: RunnerError = { ...err, message: scrub(err.message) };
  process.stderr.write(JSON.stringify(sanitized) + "\n");
  process.exit(1);
}

// -----------------------------------------------------------------------------
// Source-primitive → IR-op-head mapping
// -----------------------------------------------------------------------------
//
// `@workbench/sturm`'s runtime tags `InvalidWhenBodyError.op` with the
// source-primitive name (with trailing parens — `"qbool()"`,
// `"observe()"`, etc.). ADR-0038's envelope payload wants the *IR
// op-head* — `"prepare"`, `"observe"`, `"discard"`. The mapping is
// small and stable; we keep it here in the runner because the
// boundary between source-DSL primitives and IR op-heads is exactly
// the tracer's responsibility.
//
// Future-proofing: an unknown source-primitive falls through to the
// raw string with parens stripped — better honest data than a thrown
// "unknown primitive" the outer tool can't route on.

function sourcePrimitiveToOpHead(srcOp: string): string {
  const stripped = srcOp.endsWith("()") ? srcOp.slice(0, -2) : srcOp;
  switch (stripped) {
    case "qbool":
    case "qreg":
      return "prepare";
    case "observe":
      return "observe";
    case "ptrace":
      return "discard";
    default:
      return stripped;
  }
}

// -----------------------------------------------------------------------------
// Main
// -----------------------------------------------------------------------------

async function main(): Promise<void> {
  const sourcePath = process.argv[2];
  const entryName = process.argv[3] ?? "default";
  if (sourcePath === undefined) {
    fail({
      class: "runtime-error",
      message: "runner.ts requires <source-path> <entry-name> argv",
    });
  }
  SCRUB_FILE = sourcePath;
  // Also scrub the containing scratch directory — mkdtemp's `run-XXXX`
  // suffix is the random part. The dir is one level up:
  // /…/tools/sturm-trace/.scratch/run-XYZ/user.ts → strip up through
  // `.../run-XYZ`. The longer (file) prefix runs first in `scrub` so
  // there's no partial-replace artifact between them.
  const stripped = sourcePath.replace(/\/user\.ts$/, "");
  if (stripped !== sourcePath) SCRUB_DIR = stripped;

  // Dynamic-import the user source. Bun handles TS at import time;
  // syntax errors, missing modules, and module-load-time runtime
  // errors all surface here as exceptions.
  let mod: Record<string, unknown>;
  try {
    mod = (await import(sourcePath)) as Record<string, unknown>;
  } catch (e) {
    fail({
      class: "parse-error",
      message: `import failed: ${(e as Error).message ?? String(e)}`,
    });
  }

  const entry = mod[entryName];
  if (typeof entry !== "function") {
    fail({
      class: "non-channel-return",
      message:
        `entry "${entryName}" is not a function on the source module (got ${typeof entry}). ` +
        "Export a function — e.g. `export default function() { return trace(...) }` — or pass --entry=<name>.",
    });
  }

  // Call the entry. The contract is "no-args call returns a Channel."
  // Inputs to the channel (the `I` tuple) are out of scope for v0.1
  // because we have no protocol for binding them through the wire.
  let result: unknown;
  try {
    result = (entry as () => unknown)();
  } catch (e) {
    if (e instanceof InvalidWhenBodyError) {
      fail({
        class: "invalid-when-body",
        message: e.message,
        op: sourcePrimitiveToOpHead(e.op),
        controls: e.controlWires.map(String),
      });
    }
    fail({
      class: "runtime-error",
      message: (e as Error).message ?? String(e),
    });
  }

  if (!(result instanceof Channel)) {
    fail({
      class: "non-channel-return",
      message:
        `entry "${entryName}" returned ${typeof result === "object" ? "an object" : typeof result}, ` +
        "expected a `Channel` from @workbench/sturm (the return value of `trace(...)`).",
    });
  }

  process.stdout.write(canonicalize(result.toValue()));
}

main().catch((e: unknown) => {
  process.stderr.write(
    JSON.stringify({
      class: "runtime-error",
      message: (e as Error)?.message ?? String(e),
    } satisfies RunnerError) + "\n",
  );
  process.exit(1);
});
