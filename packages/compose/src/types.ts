// Public type surface for @workbench/compose.
//
// The `Workbench` interface fixes the API surface every later issue
// fills in. Each method's TSDoc states the contract; implementation
// notes live next to the implementation in load.ts / run.ts / pipe.ts
// and in ADR-0012.
//
// `loadWorkbench` is async because importing N tool modules is
// inherently async. We hide the IO behind the constructor and never
// expose a sync surface — a TS expert expects `await` at construction
// and direct return after.

import type { Hash, Value } from "@workbench/protocol";
import type { ToolDefinition } from "@workbench/contract";

export interface LoadWorkbenchOptions {
  /**
   * Override the tools/ directory. Default: walk up from
   * `process.cwd()` via `findToolsRoot`. Set this in tests or in
   * environments where multiple tool roots coexist.
   */
  toolsRoot?: string;

  /**
   * Filter tools at discovery time by name. Default: include all.
   * Useful for tests that want a minimal, deterministic registry.
   */
  filter?: (name: string) => boolean;

  /**
   * Override the provenance store path used by `run` /
   * `runMemoized` / `lookup`. Default: `CAS_STORE` env var, falling
   * back to `~/.scientist-workbench/cas-store`.
   */
  store?: string;
}

export interface Workbench {
  /**
   * Tools that imported successfully, keyed by `def.name`. The map
   * is read-only; mutating it has no effect on the in-memory
   * registry.
   */
  readonly tools: ReadonlyMap<string, ToolDefinition>;

  /**
   * Tools whose modules failed to import (or did not export `def`),
   * keyed by directory name. Partial discovery is the default: a
   * single broken tool surfaces here, the rest of the workbench is
   * fully callable. Matches the failure-tally discipline from
   * `registry-search` (ADR-0001 §2 frictions).
   */
  readonly errors: ReadonlyMap<string, Error>;

  /** Provenance store path resolved at load time. */
  readonly store: string;

  /**
   * Look up a tool by name and invoke it in-process.
   *
   * Schema validation runs on the input and on the output (the
   * contract is byte-identical to subprocess invocation; see
   * ADR-0004). Provenance is written on success. Failures throw a
   * `CompositionError` carrying the tool name and the validation
   * path so the call site sees exactly what went wrong.
   *
   * The `flags` argument is `Partial<…>`: tool flags with declared
   * defaults can be omitted, and the runner-side default fills in.
   * Recorded provenance flags include only the explicitly-passed
   * keys (matches the subprocess discipline — defaults don't bloat
   * recorded bytes).
   */
  run<O extends Value = Value>(
    name: string,
    input: Value,
    flags?: Record<string, unknown>,
  ): Promise<O>;

  /**
   * Look up a previously-computed output by `(tool name, version,
   * input hash)`. Returns the stored Value on hit, `null` on miss.
   * Pure local read — no `fn` execution, no spawn, no network.
   *
   * Implemented in scientist-workbench-mtw.
   */
  lookup<O extends Value = Value>(
    name: string,
    input: Value,
  ): Promise<O | null>;

  /**
   * `lookup` then `run`. On hit, byte-identical Value with no `fn`
   * execution. On miss, runs the tool (which writes provenance) and
   * returns the fresh Value.
   *
   * Refuses on tools with `def.nondeterministic === true`
   * (`entropy-source`) — memoising a nondeterministic tool would
   * silently invent a determinism the contract does not promise.
   *
   * Implemented in scientist-workbench-csa.
   */
  runMemoized<O extends Value = Value>(
    name: string,
    input: Value,
    flags?: Record<string, unknown>,
  ): Promise<O>;

  /**
   * Build an immutable pipe over `input`. `pipe(input).through(name,
   * flags?)` returns a new Pipe; `.value()` resolves to the final
   * Value. Errors mid-chain report the step index and tool name.
   *
   * Implemented in scientist-workbench-46z.
   */
  pipe<I extends Value>(input: I): Pipe;
}

export interface Pipe {
  /** Append a step to the chain. Returns a new Pipe; the receiver is unchanged. */
  through(name: string, flags?: Record<string, unknown>): Pipe;
  /** Resolve and return the final Value. */
  value<O extends Value = Value>(): Promise<O>;
}

/** Re-export of the canonical hash alias so callers don't reach into protocol. */
export type { Hash };
