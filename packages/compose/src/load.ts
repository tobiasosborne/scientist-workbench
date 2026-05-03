// =============================================================================
// loadWorkbench — auto-discovery + in-memory registry
// =============================================================================
//
// Scope (issue scientist-workbench-9n1).
//
// Walks the workbench's `tools/` directory, imports every `tool.ts`,
// reads each module's `def` export, and assembles an in-memory
// `Workbench` registry keyed by `def.name`. Returns a Workbench whose
// `tools` map is populated for every module that imported successfully
// and whose `errors` map carries one entry per directory whose import
// failed.
//
// The walk reuses `findToolsRoot`, `listToolEntries`, and
// `importToolDef` from `@workbench/contract` — we are not inventing a
// second discovery mechanism. The contract registry already handles
// the snap-Bun spawn corner (ADR-0001) and the side-effect-free
// import contract (ADR-0010); riding those keeps `@workbench/compose`
// thin.
//
// Partial discovery is the default. A failed import does *not* throw
// from `loadWorkbench` — the rest of the registry is fully callable.
// This matches `registry-search` (failures tallied to stderr,
// continues) and is the only sane default for a multi-tool ecosystem
// where one bad module would otherwise poison every call site.
//
// The methods on the returned `Workbench` are the issue chain that
// follows: `run` (23i), `lookup` (mtw), `runMemoized` (csa), `pipe`
// (46z). Each is wired to a clear `not-yet-implemented`
// `CompositionError` here so a caller cannot mistake an unfilled
// surface for a hung promise. As each issue lands, the placeholder
// is replaced with the real implementation.

import {
  defaultStore,
  findToolsRoot,
  importToolDef,
  listToolEntries,
} from "@workbench/contract";
import type { ToolDefinition } from "@workbench/contract";
import type { Value } from "@workbench/protocol";
import { CompositionError } from "./errors.js";
import { runWorkbench } from "./run.js";
import type { LoadWorkbenchOptions, Pipe, Workbench } from "./types.js";

/**
 * Construct a `Workbench` by importing every `tool.ts` under
 * `opts.toolsRoot` (defaults to walking up from `process.cwd()`).
 *
 * Resolution order for the tools root:
 *   1. `opts.toolsRoot` if given;
 *   2. `findToolsRoot(process.cwd())` walking up at most 8 directories;
 *   3. throw a `CompositionError` ("no tools/ directory found").
 *
 * Resolution order for the provenance store:
 *   1. `opts.store` if given;
 *   2. `process.env.CAS_STORE` if set;
 *   3. `defaultStore()` (`~/.scientist-workbench/cas-store`).
 *
 * The cold cost is dominated by Bun's TS load path: 18 dynamic imports
 * is ~150 ms on a warm fs cache, well under the 200 ms budget named in
 * the issue's acceptance criteria.
 */
export async function loadWorkbench(opts: LoadWorkbenchOptions = {}): Promise<Workbench> {
  const toolsRoot = opts.toolsRoot ?? (await findToolsRoot(process.cwd()));
  if (toolsRoot === null) {
    throw new CompositionError("no tools/ directory found", {
      toolName: "<bootstrap>",
      suggestion:
        "loadWorkbench walked up from process.cwd() looking for a `tools/` " +
        "directory and found none. Pass `{ toolsRoot: '...' }` explicitly, " +
        "or run from inside the scientist-workbench checkout.",
      detail: { cwd: process.cwd() },
    });
  }

  const entries = await listToolEntries(toolsRoot);
  const filter = opts.filter ?? (() => true);

  const tools = new Map<string, ToolDefinition>();
  const errors = new Map<string, Error>();

  // Discoveries run in parallel — each `await import(...)` is
  // independent. Bun's loader handles concurrent imports fine; the
  // small parallelism keeps cold-load latency tight on machines with
  // multi-core fs throughput.
  await Promise.all(
    entries.map(async ({ name, path }) => {
      if (!filter(name)) return;
      try {
        const def = await importToolDef(path);
        // The directory name and the declared def.name should agree, but
        // we key the registry by `def.name` because that is the contract
        // every consumer (the runner, registry-search, the typed barrel)
        // already keys on. A mismatch is loud but not fatal — record the
        // tool under its declared name and surface the discrepancy in
        // `errors` so a tool author sees it.
        if (def.name !== name) {
          errors.set(name, new Error(
            `directory name '${name}' does not match def.name '${def.name}'; ` +
            `registry keyed by def.name`,
          ));
        }
        tools.set(def.name, def);
      } catch (e) {
        errors.set(name, e instanceof Error ? e : new Error(String(e)));
      }
    }),
  );

  const store = opts.store ?? process.env["CAS_STORE"] ?? defaultStore();

  return new InProcessWorkbench(tools, errors, store);
}

// -----------------------------------------------------------------------------
// Internal Workbench shell
// -----------------------------------------------------------------------------
//
// Exposed only via `loadWorkbench`. Methods that rely on issues 23i /
// 46z / mtw / csa throw `CompositionError`s naming the issue. As each
// issue lands, the placeholder body is replaced with the real
// implementation; no public-API change is required.

class InProcessWorkbench implements Workbench {
  public readonly tools: ReadonlyMap<string, ToolDefinition>;
  public readonly errors: ReadonlyMap<string, Error>;
  public readonly store: string;

  constructor(
    tools: Map<string, ToolDefinition>,
    errors: Map<string, Error>,
    store: string,
  ) {
    this.tools = tools;
    this.errors = errors;
    this.store = store;
  }

  async run<O extends Value = Value>(
    name: string,
    input: Value,
    flags: Record<string, unknown> = {},
  ): Promise<O> {
    return runWorkbench<O>(this.tools, name, input, flags, { store: this.store });
  }

  async lookup<O extends Value = Value>(name: string, _input: Value): Promise<O | null> {
    throw new CompositionError(
      "Workbench.lookup is not yet implemented (waits on scientist-workbench-mtw)",
      { toolName: name },
    );
  }

  async runMemoized<O extends Value = Value>(
    name: string,
    _input: Value,
    _flags?: Record<string, unknown>,
  ): Promise<O> {
    throw new CompositionError(
      "Workbench.runMemoized is not yet implemented (waits on scientist-workbench-csa)",
      { toolName: name },
    );
  }

  pipe<I extends Value>(_input: I): Pipe {
    throw new CompositionError(
      "Workbench.pipe is not yet implemented (waits on scientist-workbench-46z)",
      { toolName: "<pipe>" },
    );
  }
}
