// =============================================================================
// runWorkbench — the in-process invocation surface (issue 23i)
// =============================================================================
//
// `runWorkbench(wb, name, input, partialFlags?)` resolves the named
// tool from the workbench's registry, applies declared flag defaults
// to the partial flags object, and routes the call through
// `executeToolDef` from `@workbench/contract`. Schema validation,
// output validation, and provenance writing all flow through that
// single helper — the in-process and subprocess surfaces produce
// byte-identical results for the same `(tool, version, input,
// explicit-flags)` (ADR-0012, "single-implementation discipline").
//
// Errors are wrapped:
//   * Unknown tool name → `CompositionError`.
//   * Wrong-typed flag (e.g. number where bigint was declared) →
//     `CompositionError` (re-wrapped from the `ToolError` raised by
//     `resolveFlagsForCall`).
//   * Schema validation failures (input or output) → `CompositionError`
//     carrying the underlying `ToolError`'s `path`/`detail`.
//   * Provenance write failures are *not* errors. They show up on the
//     returned tuple from `executeToolDef` and we surface them as a
//     console.warn so the caller's output is never destroyed (matches
//     `runTool`'s stderr-warning discipline; PRD §3.5).

import {
  executeToolDef,
  explicitStringsFromPartial,
  resolveFlagsForCall,
  toolFacingFlags,
  type ToolDefinition,
} from "@workbench/contract";
import { ToolError, type Value } from "@workbench/protocol";
import { CompositionError, type CompositionErrorOptions } from "./errors.js";

/**
 * Re-wrap a `ToolError` thrown by `resolveFlagsForCall` /
 * `executeToolDef` as a `CompositionError`. The `exactOptionalPropertyTypes`
 * flag forbids spreading a possibly-undefined property into a typed
 * options object, so we build the options conditionally.
 */
function wrapToolError(toolName: string, e: ToolError): CompositionError {
  const opts: CompositionErrorOptions = { toolName, cause: e };
  if (e.suggestion !== undefined) opts.suggestion = e.suggestion;
  if (e.detail !== undefined) opts.detail = e.detail;
  return new CompositionError(`${toolName}: ${e.message}`, opts);
}

export interface RunWorkbenchOptions {
  /** Resolved provenance store. Captured from the Workbench. */
  store: string;
}

export async function runWorkbench<O extends Value = Value>(
  tools: ReadonlyMap<string, ToolDefinition>,
  name: string,
  input: Value,
  partialFlags: Record<string, unknown> = {},
  opts: RunWorkbenchOptions,
): Promise<O> {
  const def = tools.get(name);
  if (def === undefined) {
    const available = [...tools.keys()].sort();
    throw new CompositionError(
      `unknown tool '${name}'`,
      {
        toolName: name,
        suggestion:
          available.length === 0
            ? "the workbench is empty — check `Workbench.errors` for import failures"
            : `available tools: ${available.slice(0, 8).join(", ")}${available.length > 8 ? ", …" : ""}`,
        detail: { unknown: name, available_count: available.length },
      },
    );
  }

  // Apply defaults + type-validate flags. Callers using the typed
  // barrel get this for free at compile time; the loose surface
  // catches bad types here at runtime.
  //
  // The flag schema is the tool's declared flags *plus* any tier-
  // additive standard flags the runner contributes (today: `precision`
  // for `arbprec: true` tools, ADR-0020). Validating against
  // `toolFacingFlags(...)` rather than `def.flags ?? {}` keeps the in-
  // process surface admissibility-equivalent to the subprocess CLI:
  // `wb.hypergeometricPfq(input, { precision: 50n })` succeeds, the
  // bench's `executeToolDef` workaround is no longer needed, and the
  // ADR-0012 byte-identical contract is restored at the call-site
  // ergonomic layer.
  const flagSchema = toolFacingFlags(def.flags ?? {}, def.arbprec === true);
  let resolvedFlags: Record<string, unknown>;
  try {
    resolvedFlags = resolveFlagsForCall(flagSchema, partialFlags);
  } catch (e) {
    if (e instanceof ToolError) throw wrapToolError(name, e);
    throw e;
  }
  const explicitFlags = explicitStringsFromPartial(flagSchema, partialFlags);

  // Hand off to the contract dispatcher's work-case helper. Schema
  // validation + provenance write happen inside.
  let result;
  try {
    result = await executeToolDef(def, input, resolvedFlags as never, {
      explicitFlags,
      store: opts.store,
    });
  } catch (e) {
    if (e instanceof ToolError) throw wrapToolError(name, e);
    throw e;
  }

  if (result.provenanceError !== null) {
    // Best-effort: warn but don't destroy the user's output. Matches
    // the runner's stderr discipline (runner.ts work case).
    console.warn(
      `${name}: warning — provenance write failed: ${result.provenanceError.message}`,
    );
  }

  return result.output as O;
}
