// =============================================================================
// sturm-trace — TS source → Sturm channel IR Value
// =============================================================================
//
// Intent
// ------
// The TS-native frontend tool: take a string of TypeScript source that
// builds a Sturm channel via `@workbench/sturm`'s `trace(...)` DSL,
// execute it in a sandboxed Bun subprocess, and emit the resulting
// channel as a canonical IR Value (`expression "channel"` per ADR-0006).
//
// This closes the "source → IR" boundary in the layered Sturm stack:
//
//     TS source ─[sturm-trace]→ IR Value ─[sturm-execute]→ distribution
//                                       ─[sturm-equivalent]→ verdict
//                                       ─[sturm-simplify]→ smaller IR
//
// The substrate piece is `@workbench/sturm` (ADR-0009, "agents are TS
// experts; what a TS expert wants is the spec") — the DSL surface a
// user reaches for. The IR end is `@workbench/sturm-ir` (ADR-0006).
// This tool is the bridge that lets agents compose by-pipe rather
// than by-direct-IR-construction.
//
// Input shape
// -----------
// `record{ source: string, entry?: string }`:
//   • `source` — the TS source code, as a single string. The source
//     must export a function (named or `default`) that calls
//     `trace(...)` from `@workbench/sturm` and returns the resulting
//     `Channel<I, O>`. The function is called with no arguments;
//     channel inputs (the `I` tuple) are out of scope for v0.1.
//   • `entry` — the export name to call. Defaults to `"default"` (the
//     module's default export). Use this when your source declares
//     multiple channels and you want to trace a named one.
//
// Output shape
// ------------
// On success: the channel IR Value (an `expression "channel"`).
// Validate further with `channelSchema` / `decodeChannel` /
// `checkWellFormed` from `@workbench/sturm-ir`, or pipe straight into
// the next tool.
//
// On refusal: `tagged "sturm-trace/<class>"` with a payload describing
// the failure (ADR-0003 boundary-failure shape). The four classes are:
//
//   • `parse-error`         — the source failed to import (syntax,
//                             missing module, etc.). Includes the
//                             `bennett-missing` case for v0.1 because
//                             `@bennett/core` is not yet a package;
//                             once Bennett-TS lands, that case lifts
//                             to its own class.
//   • `invalid-when-body`   — a non-rotation op (observe, prepare,
//                             discard, oracle, cases) fired inside a
//                             `when(...)` body. ADR-0038 makes this
//                             refusal load-bearing for the principle
//                             "coherent control on non-unitary ops is
//                             not well-defined."
//   • `non-pure-trace`      — the determinism check ran the trace
//                             twice and got different canonical IR
//                             bytes. The user's source is reading
//                             nondeterministic input (`Math.random`,
//                             `Date.now`, module-level mutable state,
//                             etc.).
//   • `non-channel-return`  — the entry function exists but didn't
//                             return a `Channel` (or doesn't exist
//                             under the requested entry name).
//
// Determinism
// -----------
// The default behaviour is "trace twice; abort if the canonical bytes
// disagree." This is what catches `Math.random()` and friends. The
// flag `--check-determinism=false` disables it for users who have a
// known-pure trace and want to halve the subprocess count.
//
// Algorithm
// ---------
// 1. Write the user source to a workspace-resident scratch file (so
//    Bun's module resolution can find `@workbench/sturm` by walking
//    up to the workspace's `node_modules`).
// 2. Spawn `bun runner.ts <scratch-path> <entry>` via `spawnBun`
//    (ADR-0001). The runner dynamic-imports the source, calls the
//    entry, and emits canonical IR bytes to stdout (or a typed JSON
//    error to stderr + exit 1).
// 3. If determinism is on, spawn the runner a second time. Compare
//    the stdout bytes for bit-equality. Disagreement → refuse.
// 4. Parse the canonical bytes into a `Value` and return.
// 5. On any subprocess failure: parse the stderr JSON, route to the
//    `tagged "sturm-trace/<class>"` envelope.
// 6. Clean up the scratch dir.
//
// Honest scope (v0.1)
// -------------------
// • No channel inputs. The user's entry function is called with `()`;
//   channels with non-empty input signatures will still be returned
//   correctly (their IR `inputs` list will be non-empty), but the
//   tool has no way to *bind* inputs through this surface. Use
//   `sturm-trace | sturm-then`-style composition to plumb inputs at
//   the IR layer.
// • No nested `run()` (per the v3 PRD; AsyncLocalStorage work
//   deferred).
// • No proper `bennett-missing` class until `@bennett/core` ships;
//   today's `oracle` import surfaces as `parse-error`.

import {
  parse,
  record,
  S,
  str,
  tagged,
  type ListValue,
  type Value,
} from "@workbench/protocol";
import { defineTool, F, runTool, spawnBun } from "@workbench/contract";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const NAME = "sturm-trace";
const VERSION = "0.1.0";

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNNER_PATH = join(HERE, "runner.ts");
// Scratch dir lives *inside* the tool's directory so Bun's module
// resolution finds `node_modules` by walking up — without this, the
// user's `import "@workbench/sturm"` fails with module-not-found.
const SCRATCH_ROOT = join(HERE, ".scratch");

// -----------------------------------------------------------------------------
// Subprocess plumbing
// -----------------------------------------------------------------------------

/**
 * The shape of the JSON line the runner writes to stderr on failure.
 * Mirrors `RunnerError` in runner.ts; the discriminator lifts directly
 * into the `tagged "sturm-trace/<class>"` envelope's tag suffix.
 */
interface RunnerErrorJSON {
  class:
    | "parse-error"
    | "invalid-when-body"
    | "non-channel-return"
    | "runtime-error";
  message: string;
  op?: string;
  controls?: string[];
}

function parseRunnerError(stderr: string): RunnerErrorJSON {
  // The runner writes a single JSON line then exits. User source may
  // have written to stderr too (via `console.error`); take the *last*
  // non-empty line and try to parse it. If parsing fails, treat the
  // whole stderr as a runtime-error message.
  const lines = stderr.split("\n").map(l => l.trim()).filter(l => l.length > 0);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(lines[i]!) as RunnerErrorJSON;
      if (typeof parsed.class === "string" && typeof parsed.message === "string") {
        return parsed;
      }
    } catch {
      // not JSON; keep looking
    }
  }
  return {
    class: "runtime-error",
    message: stderr.trim() || "(no stderr output)",
  };
}

/** One trace pass: write the source, spawn the runner, return its bytes or its error. */
async function runOnce(
  scratchPath: string,
  entry: string,
): Promise<{ ok: true; canonicalBytes: string } | { ok: false; err: RunnerErrorJSON }> {
  const result = await spawnBun([RUNNER_PATH, scratchPath, entry]);
  if (result.code === 0) {
    return { ok: true, canonicalBytes: result.stdout };
  }
  return { ok: false, err: parseRunnerError(result.stderr) };
}

// -----------------------------------------------------------------------------
// Refusal-envelope builders — each ADR-0038-named class as a separate fn so
// the call sites read as "here is the refusal I'm about to emit."
// -----------------------------------------------------------------------------

function envelope(klass: string, fields: Record<string, Value>): Value {
  return tagged(`${NAME}/${klass}`, record(fields));
}

function refuseInvalidWhenBody(err: RunnerErrorJSON): Value {
  const controlsList: ListValue = {
    kind: "list",
    items: (err.controls ?? []).map(c => str(c)),
  };
  return envelope("invalid-when-body", {
    op_head: str(err.op ?? "unknown"),
    control_wires: controlsList,
    message: str(err.message),
  });
}

function refuseParseError(err: RunnerErrorJSON): Value {
  return envelope("parse-error", { message: str(err.message) });
}

function refuseNonChannelReturn(err: RunnerErrorJSON): Value {
  return envelope("non-channel-return", { message: str(err.message) });
}

function refuseRuntimeError(err: RunnerErrorJSON): Value {
  return envelope("runtime-error", { message: str(err.message) });
}

function refuseNonPureTrace(_first: string, _second: string): Value {
  // Deliberately ship no payload other than the message. Including the
  // diverging bytes (or their hashes) would make the refusal envelope
  // itself non-deterministic across invocations — breaking the agent
  // contract that a given input always maps to the same canonical
  // refusal bytes. The user has the source; they can re-run with
  // `--skip-determinism` against each pass to see which fields drift.
  return envelope("non-pure-trace", {
    message: str(
      "two traces of the same source produced different canonical IR bytes. " +
      "The source is reading nondeterministic input — Math.random, Date.now, " +
      "module-level mutable state, file system, or similar. Make the trace " +
      "pure or pass --skip-determinism if the nondeterminism is intentional.",
    ),
  });
}

function routeRunnerFailure(err: RunnerErrorJSON): Value {
  switch (err.class) {
    case "invalid-when-body":
      return refuseInvalidWhenBody(err);
    case "parse-error":
      return refuseParseError(err);
    case "non-channel-return":
      return refuseNonChannelReturn(err);
    case "runtime-error":
      return refuseRuntimeError(err);
  }
}

// -----------------------------------------------------------------------------
// Scratch-file management
// -----------------------------------------------------------------------------

async function withScratchSource<T>(
  source: string,
  fn: (path: string) => Promise<T>,
): Promise<T> {
  // mkdtemp accepts a prefix; we anchor under the tool's own .scratch/
  // so paths are workspace-resident. Ensure SCRATCH_ROOT exists first
  // (mkdtemp's parent must exist).
  await mkdir(SCRATCH_ROOT, { recursive: true });
  const dir = await mkdtemp(SCRATCH_ROOT + "/run-");
  const path = join(dir, "user.ts");
  try {
    await writeFile(path, source, "utf8");
    return await fn(path);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

// -----------------------------------------------------------------------------
// Top-level pipeline (used by both `fn` and `test`)
// -----------------------------------------------------------------------------

interface TraceOpts {
  readonly checkDeterminism: boolean;
}

/**
 * The body of `def.fn`, factored out so the `--test` hook can drive
 * the pipeline with plain strings instead of constructed Values (and
 * thereby avoid `as never` casts on `def.fn`'s schema-narrowed input
 * parameter). Same semantics as the tool's `fn`: returns a channel IR
 * Value on success, a `tagged "sturm-trace/<class>"` refusal otherwise.
 */
async function traceSource(source: string, entry: string, opts: TraceOpts): Promise<Value> {
  return withScratchSource(source, async (scratchPath) => {
    const first = await runOnce(scratchPath, entry);
    if (!first.ok) return routeRunnerFailure(first.err);

    if (opts.checkDeterminism) {
      const second = await runOnce(scratchPath, entry);
      if (!second.ok) return routeRunnerFailure(second.err);
      if (second.canonicalBytes !== first.canonicalBytes) {
        return refuseNonPureTrace(first.canonicalBytes, second.canonicalBytes);
      }
    }

    // The runner already produced canonical JSON; `parse` accepts any
    // protocol-conforming JSON, canonical or not.
    return parse(first.canonicalBytes);
  });
}

// -----------------------------------------------------------------------------
// Schema + tool definition
// -----------------------------------------------------------------------------

const inputSchema = S.record(
  {
    source: S.kind("string"),
    entry: S.kind("string"),
  },
  { optional: ["entry"] },
);

export const def = defineTool({
  name: NAME,
  version: VERSION,
  summary:
    "TS-native frontend tool: run a TypeScript source string that builds a channel via `@workbench/sturm`'s `trace(...)` DSL (ADR-0009) in a sandboxed Bun subprocess, emit the canonical IR Value",
  schema: {
    input: inputSchema,
    // Output is either an `expression "channel"` IR Value or a
    // `tagged "sturm-trace/<class>"` refusal envelope. The runner
    // doesn't validate against a tighter schema at the contract layer;
    // consumers can decode via `decodeChannel` (if they got an IR) or
    // pattern-match `kind === "tagged"` (if they got a refusal).
    output: S.any(),
  },
  flags: {
    // The determinism check (trace twice, compare canonical bytes) is
    // on by default; pass `--skip-determinism` to disable it for
    // known-pure traces and halve the subprocess count. Negative-
    // framing the switch matches `F.bool`'s "switches default to
    // false" convention while preserving the bead's STURM_CHECK_-
    // DETERMINISM=1-default intent — silence keeps the check on.
    "skip-determinism": F.bool(
      "skip the trace-twice determinism check (default: check enabled)",
    ),
  },
  examples: [
    {
      description: "Empty trace: zero-op channel via default export",
      input: record({
        source: str(
          'import { trace } from "@workbench/sturm";\n' +
          "export default () => trace(() => []);\n",
        ),
      }),
      output: {
        kind: "expression",
        head: "channel",
        args: [
          { kind: "list", items: [] },
          { kind: "list", items: [] },
          { kind: "list", items: [] },
        ],
      },
    },
    {
      description:
        "Refusal: non-rotation op inside a when(...) body (ADR-0038)",
      input: record({
        source: str(
          'import { trace, qbool, when, observe } from "@workbench/sturm";\n' +
          "export default () => trace(() => {\n" +
          "  const ctrl = qbool(0.5);\n" +
          "  const tgt = qbool(0);\n" +
          "  when(ctrl, () => { observe(tgt); });\n" +
          "  return [];\n" +
          "});\n",
        ),
      }),
      output: tagged("sturm-trace/invalid-when-body", record({
        op_head: str("observe"),
        control_wires: { kind: "list", items: [str("0")] },
        message: str(
          "@workbench/sturm: observe() cannot appear inside a when(...) body. " +
          "Per ADR-0006/0038, controls are admitted only on ry/rz; " +
          "allocations, measurements, oracles, and classical branches must be unconditional.",
        ),
      })),
    },
  ],
  invariants: [
    {
      name: "deterministic-on-pure-source",
      statement:
        "For a pure trace (no Math.random/Date.now/module state), traceTwice(source) === traceOnce(source).",
      machine_checkable: true,
    },
    {
      name: "round-trips-through-sturm-execute",
      statement:
        "For a well-formed source, sturm-execute(sturm-trace(source)) is the textbook distribution.",
      machine_checkable: true,
    },
    {
      name: "rejects-invalid-when-body",
      statement:
        "A source that calls observe/prepare/oracle/cases/discard inside a when(...) body refuses with tagged 'sturm-trace/invalid-when-body' (ADR-0038).",
      machine_checkable: true,
    },
  ],
  fn: async (input, flags): Promise<Value> => {
    // The schema-validated input is `record{source, entry?}`. The
    // runner's type narrows automatically once we extract the fields.
    if (input.kind !== "record") {
      // Defensive — schema should have caught this.
      return envelope("runtime-error", {
        message: str("internal: input was not a record after schema validation"),
      });
    }
    const sourceField = input.fields["source"];
    if (sourceField?.kind !== "string") {
      return envelope("runtime-error", {
        message: str("internal: input.source missing or not a string after schema validation"),
      });
    }
    const entryField = input.fields["entry"];
    const entry =
      entryField?.kind === "string" ? entryField.value : "default";

    return traceSource(sourceField.value, entry, {
      checkDeterminism: !flags["skip-determinism"],
    });
  },
  // ---------------------------------------------------------------------------
  // --test hook — the q0b acceptance-criterion 4 round-trip property.
  //
  // For each of two structurally-distinct probes (Bell pair and the
  // GHZ-3 broadcast), we (1) trace the TS source through our own
  // `def.fn` to get an IR Value, (2) feed that Value to
  // tools/sturm-execute via spawnBun, (3) parse the resulting
  // distribution and assert the outcomes against the textbook
  // expectation.
  //
  // This is the load-bearing end-to-end test: it proves the source-to-
  // distribution pipeline is wired correctly. A bug in any of {trace
  // body, runner subprocess, canonical-byte round-trip, sturm-execute
  // dispatch} fails this hook.
  // ---------------------------------------------------------------------------
  test: async () => {
    const STURM_EXECUTE = "tools/sturm-execute/tool.ts";

    interface ExpectedOutcome {
      // `bits` are the 0/1 values of the classical refs in order.
      readonly bits: readonly (0 | 1)[];
      readonly prob: number;
    }

    async function traceAndExecute(source: string): Promise<Value> {
      const traceOut = await traceSource(source, "default", { checkDeterminism: true });
      if (traceOut.kind === "tagged") {
        throw new Error(
          `sturm-trace test: unexpected refusal: ${traceOut.tag}`,
        );
      }
      const irBytes = JSON.stringify(traceOut);
      const r = await spawnBun([STURM_EXECUTE], irBytes);
      if (r.code !== 0) {
        throw new Error(
          `sturm-trace test: sturm-execute exited ${r.code}: ${r.stderr}`,
        );
      }
      return parse(r.stdout);
    }

    function assertDistribution(
      label: string,
      dist: Value,
      expected: readonly ExpectedOutcome[],
    ): void {
      if (dist.kind !== "record") {
        throw new Error(`sturm-trace test (${label}): distribution kind = ${dist.kind}`);
      }
      const outcomesV = dist.fields["outcomes"];
      if (outcomesV?.kind !== "list") {
        throw new Error(`sturm-trace test (${label}): outcomes missing or non-list`);
      }
      // Build a map: bit-tuple-string → prob.
      const got = new Map<string, number>();
      for (const o of outcomesV.items) {
        if (o.kind !== "record") continue;
        const resol = o.fields["classical_resolutions"];
        const probV = o.fields["prob"];
        if (resol?.kind !== "list" || probV?.kind !== "float64") continue;
        const bits = resol.items.map(r => {
          if (r.kind !== "record") return "?";
          const v = r.fields["value"];
          return v?.kind === "integer" ? v.value : "?";
        }).join("");
        // float64 bits → number via DataView.
        const buf = new ArrayBuffer(8);
        const view = new DataView(buf);
        view.setBigUint64(0, BigInt("0x" + probV.bits), false);
        got.set(bits, view.getFloat64(0, false));
      }
      for (const ex of expected) {
        const key = ex.bits.join("");
        const p = got.get(key);
        if (p === undefined) {
          throw new Error(
            `sturm-trace test (${label}): missing outcome (${key}); got keys: ${[...got.keys()].join(",")}`,
          );
        }
        if (Math.abs(p - ex.prob) > 1e-9) {
          throw new Error(
            `sturm-trace test (${label}): outcome (${key}) prob=${p}, expected ${ex.prob}`,
          );
        }
      }
      // No spurious outcomes (within float64 tolerance, sturm-execute drops <1e-12).
      const total = [...got.values()].reduce((a, b) => a + b, 0);
      if (Math.abs(total - 1) > 1e-9) {
        throw new Error(
          `sturm-trace test (${label}): probabilities sum to ${total}, expected 1`,
        );
      }
    }

    // ---- Bell pair: textbook (00) → 0.5, (11) → 0.5 -----------------------
    const bellSource =
      'import { trace, qbool, when, not, observe } from "@workbench/sturm";\n' +
      "export default () => trace(() => {\n" +
      "  const a = qbool(0.5);\n" +
      "  const b = qbool(0);\n" +
      "  when(a, () => not(b));\n" +
      "  observe(a);\n" +
      "  observe(b);\n" +
      "  return [];\n" +
      "});\n";
    assertDistribution("Bell pair", await traceAndExecute(bellSource), [
      { bits: [0, 0], prob: 0.5 },
      { bits: [1, 1], prob: 0.5 },
    ]);

    // ---- GHZ-3: textbook (000) → 0.5, (111) → 0.5 -------------------------
    const ghzSource =
      'import { trace, qbool, when, not, observe } from "@workbench/sturm";\n' +
      "export default () => trace(() => {\n" +
      "  const a = qbool(0.5);\n" +
      "  const b = qbool(0);\n" +
      "  const c = qbool(0);\n" +
      "  when(a, () => { not(b); not(c); });\n" +
      "  observe(a);\n" +
      "  observe(b);\n" +
      "  observe(c);\n" +
      "  return [];\n" +
      "});\n";
    assertDistribution("GHZ-3", await traceAndExecute(ghzSource), [
      { bits: [0, 0, 0], prob: 0.5 },
      { bits: [1, 1, 1], prob: 0.5 },
    ]);

    // ---- Single-prepare deterministic round-trip -------------------------
    // The simplest closing-the-loop probe: prepare(0) + observe always
    // outputs |0⟩ with probability 1. Catches a wire-id-bookkeeping
    // bug that doesn't surface on multi-wire circuits.
    const oneSource =
      'import { trace, qbool, observe } from "@workbench/sturm";\n' +
      "export default () => trace(() => {\n" +
      "  const q = qbool(0);\n" +
      "  observe(q);\n" +
      "  return [];\n" +
      "});\n";
    assertDistribution("prepare-observe", await traceAndExecute(oneSource), [
      { bits: [0], prob: 1 },
    ]);
  },
});

if (import.meta.main) void runTool(def);
