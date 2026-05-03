// CompositionError — the typed failure surface for in-process invocation.
//
// Extends ToolError so existing handlers that special-case ToolError
// catch CompositionError too. Adds two fields:
//   * `toolName`     — which tool failed
//   * `step`         — for pipe(...).through(...) chains, the 1-based
//                      step index; absent for direct .run() calls
// The `path` and `kind` of the underlying validation failure ride on
// the `detail` field exactly as ToolError carries them today.
//
// The whole point of this class is that a TS expert reading a thrown
// error knows precisely where the call went wrong: which tool, which
// step in a chain, which field in the value tree. ADR-0012 §
// "errors that teach".

import { ToolError } from "@workbench/protocol";

export interface CompositionErrorOptions {
  toolName: string;
  step?: number;
  suggestion?: string;
  detail?: unknown;
  cause?: unknown;
}

export class CompositionError extends ToolError {
  public readonly toolName: string;
  public readonly step: number | undefined;

  constructor(message: string, opts: CompositionErrorOptions) {
    const baseOpts: { suggestion?: string; detail?: unknown } = {};
    if (opts.suggestion !== undefined) baseOpts.suggestion = opts.suggestion;
    if (opts.detail !== undefined) baseOpts.detail = opts.detail;
    super(message, baseOpts);
    this.name = "CompositionError";
    this.toolName = opts.toolName;
    this.step = opts.step;
    if (opts.cause !== undefined) {
      // Preserve the underlying error for stack-trace consumers.
      (this as unknown as { cause: unknown }).cause = opts.cause;
    }
  }
}
