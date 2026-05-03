// =============================================================================
// PipeImpl — fluent chain over Workbench.run (issue scientist-workbench-46z)
// =============================================================================
//
// Substrate: ADR-0012 §"Workbench.pipe(input) — fluent chain".
//
// `wb.pipe(input).through("expr-parse").through("cas-simplify").value()`
// is the same call sequence as
//
//   const a = await wb.run("expr-parse", input);
//   const b = await wb.run("cas-simplify", a);
//
// with three additions:
//
// 1. **Immutability.** Each `.through(...)` returns a *new* Pipe with
//    the step appended. The receiver is unchanged, so branches share
//    a prefix without aliasing:
//
//      const p = wb.pipe(input).through("expr-parse");
//      const a = await p.through("cas-simplify").value();
//      const b = await p.through("cas-verify").value();   // p untouched
//
// 2. **Step-numbered errors.** A failure mid-chain (schema mismatch,
//    unknown tool, the tool's own ToolError) is re-thrown as a
//    CompositionError carrying the step number AND the tool name —
//    so the message reads like:
//
//      pipe step 2 (cas-simplify): input does not conform to schema...
//
// 3. **Lazy evaluation.** Building a Pipe runs no tools. `.value()`
//    is what awaits the chain. Each `.through(...)` returns
//    immediately; the chain accumulates as a list of `Step` records
//    that `.value()` walks in order.

import type { Value } from "@workbench/protocol";
import type { ToolDefinition } from "@workbench/contract";
import { CompositionError } from "./errors.js";
import { runWorkbench } from "./run.js";
import type { Pipe } from "./types.js";

interface Step {
  name: string;
  flags: Record<string, unknown>;
}

interface PipeContext {
  tools: ReadonlyMap<string, ToolDefinition>;
  store: string;
}

class PipeImpl implements Pipe {
  constructor(
    private readonly ctx: PipeContext,
    private readonly input: Value,
    private readonly steps: readonly Step[],
  ) {}

  through(name: string, flags: Record<string, unknown> = {}): Pipe {
    // Concat into a new immutable list; the existing `steps` array is
    // shared (a cheap reference, not a copy). A frozen-array discipline
    // is overkill here — every method returns a new Pipe and the
    // private `steps` reference is never re-exposed.
    const next: Step[] = [...this.steps, { name, flags }];
    return new PipeImpl(this.ctx, this.input, next);
  }

  async value<O extends Value = Value>(): Promise<O> {
    let acc: Value = this.input;
    for (let i = 0; i < this.steps.length; i++) {
      const step = this.steps[i]!;
      try {
        acc = await runWorkbench<Value>(
          this.ctx.tools,
          step.name,
          acc,
          step.flags,
          { store: this.ctx.store },
        );
      } catch (e) {
        if (e instanceof CompositionError) {
          // Re-wrap with the step number. The underlying error is
          // attached as `cause` so the original suggestion / detail /
          // toolName are preserved on the inner cause; the new
          // outermost message reads as
          //
          //   pipe step <N> (<tool>): <underlying message>
          //
          // which is what a user reading the failure wants to see at
          // a glance.
          throw new CompositionError(
            `pipe step ${i + 1} (${step.name}): ${e.message}`,
            {
              toolName: step.name,
              step: i + 1,
              ...(e.suggestion !== undefined ? { suggestion: e.suggestion } : {}),
              ...(e.detail !== undefined ? { detail: e.detail } : {}),
              cause: e,
            },
          );
        }
        throw e;
      }
    }
    return acc as O;
  }
}

/**
 * Construct a fresh Pipe seeded with `input`. The factory takes the
 * Workbench context (the `tools` registry and the resolved `store`)
 * directly so `Workbench.pipe(input)` is a one-liner on the class
 * side.
 */
export function makePipe(
  tools: ReadonlyMap<string, ToolDefinition>,
  store: string,
  input: Value,
): Pipe {
  return new PipeImpl({ tools, store }, input, []);
}
