// =============================================================================
// lookupWorkbench / runMemoizedWorkbench — provenance-store cache (issues mtw, csa)
// =============================================================================
//
// Substrate: ADR-0012 §"Workbench.lookup", §"Workbench.runMemoized".
//
// The provenance store now stores three pieces per successful tool
// run (executeToolDef writes them):
//   * the output Value at `values/<hh>/<output_hash>.json`
//   * the provenance record at `provenance/<hh>/<output_hash>.json`
//   * a reverse-index file at
//     `by-input/<hh>/<input_hash>--<tool>--<version>.json`
//     containing the output hash as its content.
//
// `Workbench.lookup(name, input)` is therefore: hash the input, read
// the index file, read the output value at the indexed hash, return.
// On any miss (no index file, no value file, version mismatch) we
// return `null` — the contract is "byte-identical hit on success,
// null on miss"; never a partial recompute, never a stale Value.
//
// `Workbench.runMemoized(name, input, flags)` is `lookup ?? run`,
// with one safety: tools whose `def.nondeterministic === true`
// (`entropy-source` is the only one in v0.2) are refused. Memoising
// a nondeterministic call would silently invent a determinism the
// contract does not promise. The user is told to call `run` directly.

import {
  currentPlatformHash,
  readByInputIndex,
  readValue,
  type ToolDefinition,
} from "@workbench/contract";
import { hash, type Value } from "@workbench/protocol";
import { CompositionError } from "./errors.js";

export async function lookupWorkbench<O extends Value = Value>(
  tools: ReadonlyMap<string, ToolDefinition>,
  name: string,
  input: Value,
  store: string,
): Promise<O | null> {
  const def = tools.get(name);
  if (def === undefined) {
    throw new CompositionError(`unknown tool '${name}'`, {
      toolName: name,
      suggestion:
        "Workbench.lookup needs the tool's `def` to know which version to look up; " +
        "if the tool isn't in the registry, lookup cannot disambiguate versions",
    });
  }

  // Refuse the lookup for nondeterministic tools — the index would
  // be a lie. (`executeToolDef` doesn't write the index for these,
  // so a hit is structurally impossible, but throwing here surfaces
  // intent at the call site.)
  if (def.nondeterministic === true) {
    throw new CompositionError(
      `${name} is nondeterministic; lookup cannot guarantee a stable result`,
      {
        toolName: name,
        suggestion:
          "this tool consumes OS randomness (ADR-0005). " +
          "Use `wb.run(...)` directly; consumers downstream remain deterministic given the bytes returned.",
      },
    );
  }

  // ADR-0015: numerical-tier lookups condition on the running
  // platform's fingerprint. The reverse-index filename for numerical
  // records includes the platform hash; from a different platform's
  // perspective, the cached record is honestly a miss (its bytes would
  // not match what running the tool here would produce). Symbolic
  // tools have no platform suffix on the index, so the lookup behaves
  // exactly as before — bit-identical cross-platform forever.
  const platformHashForLookup = def.numerical === true ? currentPlatformHash() : null;

  const inputHash = hash(input);
  const outputHash = await readByInputIndex(
    store, inputHash, def.name, def.version, platformHashForLookup,
  );
  if (outputHash === null) return null;
  const out = await readValue(store, outputHash);
  if (out === null) {
    // Index pointed to a value the store doesn't have. This is a
    // store-inconsistency — possible if someone hand-deleted a value
    // file. Treat as a miss; the next `runMemoized` will recompute
    // and overwrite. Surfacing as null (rather than an error) keeps
    // the contract simple.
    return null;
  }
  return out as O;
}

/**
 * Re-import is necessary so we have a runWorkbench reference for
 * `runMemoized`'s fallback path. Kept inside this module to avoid a
 * circular dependency between `load.ts` and `lookup.ts`.
 */
import { runWorkbench } from "./run.js";

export async function runMemoizedWorkbench<O extends Value = Value>(
  tools: ReadonlyMap<string, ToolDefinition>,
  name: string,
  input: Value,
  partialFlags: Record<string, unknown>,
  store: string,
): Promise<O> {
  const def = tools.get(name);
  if (def === undefined) {
    // Defer to runWorkbench's better unknown-tool error, including
    // the alternative-listing.
    return runWorkbench<O>(tools, name, input, partialFlags, { store });
  }

  if (def.nondeterministic === true) {
    throw new CompositionError(
      `${name} is nondeterministic; runMemoized cannot guarantee its precondition`,
      {
        toolName: name,
        suggestion:
          "this tool consumes OS randomness (ADR-0005); call `wb.run(...)` directly. " +
          "Consumers downstream — sturm-sample for example — remain deterministic given the bytes returned.",
      },
    );
  }

  // Lookup ignores flags, but re-running with the same input + same
  // flag set produces the same output. We pass partialFlags through
  // to `run` on miss so the output is faithful to the caller's flag
  // intent. (For provenance, the *recorded* flags are what
  // determines re-run identity, so two memoized calls with different
  // flags will hit different output hashes.)
  //
  // The lookup-by-input does not yet condition on flag set — that's
  // a deliberate v0.1 simplification (the v0.2 follow-up would
  // include flag-explicit-bytes in the index key). For tools without
  // declared flags (the common case), this is a non-issue. For
  // tools with flags, callers reaching for runMemoized today should
  // know that flag changes are not part of the cache key.
  if (Object.keys(partialFlags).length === 0) {
    const cached = await lookupWorkbench<O>(tools, name, input, store);
    if (cached !== null) return cached;
  }
  return runWorkbench<O>(tools, name, input, partialFlags, { store });
}
