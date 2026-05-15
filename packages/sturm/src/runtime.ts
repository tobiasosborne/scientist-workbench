// =============================================================================
// runtime — the trace context carrier and op-emission helpers
// =============================================================================
//
// This module is internal to `@workbench/sturm`. It is the substrate every
// public function reads from and writes to: `qbool`, `qreg`, `rz`, `ry`,
// `not`, `when`, `observe`, `cases`, `ptrace`, `trace`, and the input
// declarators all dispatch through here.
//
// Why a module-level mutable carrier?
// ------------------------------------
// Sturm.jl uses `current_context()` plumbed through a Julia macro
// (`@context`). TS has no macros, so the trace context has to live in
// reachable runtime state. Two options were considered:
//
//   - `AsyncLocalStorage` from `node:async_hooks`: works across async
//     boundaries, but the trace body is *synchronous* by contract
//     (channel construction has no I/O, no awaits). The async-aware
//     storage adds dependency weight for no semantic gain.
//   - Module-level mutable variable, swapped in `trace(...)`: simple,
//     synchronous-only, no extra dependencies. Good enough.
//
// We picked the second. `trace(body)` wraps the body in a try/finally
// that installs and uninstalls the active state. Re-entering `trace`
// inside another `trace` body is permitted (the inner trace gets a
// fresh state and runs to completion before the outer state is
// restored), which is how channel composition by re-tracing works.
//
// The carrier is a class so its fields are typed and named; mutation
// is the contract here, not a smell. The type-level distinction
// between a `TraceState` and a finished `Channel` is captured by the
// `freeze()` step at trace exit, which produces an immutable `Channel`
// IR Value.

import { type Op, type Wire, channel as buildChannel, type Channel as IRChannel } from "@workbench/sturm-ir";

/**
 * Mutable state for an in-progress trace. Owned by the active `trace`
 * call; read by every primitive that needs to know "what wire id is
 * next, what controls are active, where do I append my op."
 *
 * Linearity tracking is a `Set<bigint>` of wire ids that have been
 * consumed (by `observe` or `discard`); the primitives query it on
 * every reference and throw on use-after-consume. This is the
 * runtime-equivalent of Sturm.jl's `check_live!` macro — TS has no
 * linear types, so we trade compile-time error for runtime error.
 */
export class TraceState {
  /** Next free wire id. Starts at 0; bumped by every `prepare`/input declaration. */
  nextWireId: bigint = 0n;
  /** Input wire signature, populated by `t.input.*` calls. */
  readonly inputs: Wire[] = [];
  /** Body ops in document order. */
  readonly body: Op[] = [];
  /** Active control stack for `when` — every emitted ry/rz copies this onto its `controls`. */
  readonly whenStack: bigint[] = [];
  /** Wire ids that have been consumed (observe, discard). Subsequent use throws. */
  readonly consumed: Set<bigint> = new Set();
  /** Counter for fresh classical-ref names. */
  nextRefId: number = 0;
  /** All allocated quantum wires (for the input/output cleanup pass). */
  readonly liveWires: Set<bigint> = new Set();
  /** Wires that started life as inputs (so we don't double-count them). */
  readonly inputWireIds: Set<bigint> = new Set();
}

let active: TraceState | null = null;

/**
 * Read the active trace state, or throw if called outside a `trace(...)`
 * block. Every primitive in `index.ts` goes through this — fail loud
 * with a clear remediation, not silent state corruption.
 */
export function currentTrace(): TraceState {
  if (active === null) {
    throw new Error(
      "@workbench/sturm: primitive called outside a trace(...) block. " +
      "Wrap your channel construction in trace<I, O>(...).",
    );
  }
  return active;
}

/**
 * Run `fn` with a fresh `TraceState` installed; restore the previous
 * state on exit (including on exception). Returns the populated state
 * for the caller to package into a Channel.
 *
 * Re-entrancy: an inner `trace` call gets a fresh state; the outer
 * state is re-installed when the inner finishes. This is what makes
 * "compose channel-construction helpers across the call stack" work.
 */
export function withTrace<R>(fn: (s: TraceState) => R): { state: TraceState; result: R } {
  const prev = active;
  const fresh = new TraceState();
  active = fresh;
  try {
    const result = fn(fresh);
    return { state: fresh, result };
  } finally {
    active = prev;
  }
}

/**
 * Allocate a fresh wire id and mark it live. Used by both
 * `t.input.*` declarators and the body allocators (`qbool`, `qreg`).
 */
export function allocWireId(s: TraceState): bigint {
  const id = s.nextWireId;
  s.nextWireId = id + 1n;
  s.liveWires.add(id);
  return id;
}

/**
 * Verify a wire is in scope. Throws on use-after-consume or use of a
 * wire from a different trace. Fail-loud per CLAUDE.md Rule 1.
 */
export function checkLive(s: TraceState, wireId: bigint, op: string): void {
  if (s.consumed.has(wireId)) {
    throw new Error(
      `@workbench/sturm: ${op} on consumed wire ${wireId}. ` +
      "A wire is consumed by observe() or ptrace(); subsequent use is invalid.",
    );
  }
  if (!s.liveWires.has(wireId)) {
    throw new Error(
      `@workbench/sturm: ${op} on wire ${wireId} which is not in this trace. ` +
      "Wires are scoped to the trace() call that allocated them; do not pass them across traces.",
    );
  }
}

/**
 * Mark a wire consumed (observe, discard).
 */
export function consume(s: TraceState, wireId: bigint): void {
  s.consumed.add(wireId);
}

/**
 * Allocate a fresh classical-ref name. Used by `observe`.
 *
 * Names are `r0`, `r1`, … in document order. They are stable for a
 * given trace body (no interleaving with another trace) and visible
 * through to the executed channel's distribution as the keys of
 * `classical_refs`.
 */
export function allocRefName(s: TraceState): string {
  const name = `r${s.nextRefId}`;
  s.nextRefId += 1;
  return name;
}

/**
 * Append an op to the active body. Used by every primitive.
 */
export function appendOp(s: TraceState, op: Op): void {
  s.body.push(op);
}

/**
 * Get a snapshot of the current `whenStack` to use as a rotation's
 * `controls` list. Returns a fresh array so the IR op holds an
 * independent copy (Op interfaces are `readonly`; mutating the
 * stored stack later would corrupt them).
 */
export function snapshotControls(s: TraceState): bigint[] {
  return s.whenStack.slice();
}

/**
 * Push a control wire onto the active stack for the duration of `body`.
 * Pops on normal return *and* on exception. Used by `when(c, fn)`.
 */
export function withControl<R>(s: TraceState, controlWireId: bigint, body: () => R): R {
  s.whenStack.push(controlWireId);
  try {
    return body();
  } finally {
    s.whenStack.pop();
  }
}

/**
 * Run `body` as a sub-trace whose ops are collected into a fresh
 * array, returned to the caller. Used by `Measurement.if` and `cases`
 * to capture an arm's ops without flushing them into the parent body.
 *
 * The sub-trace shares the parent's wire allocator, control stack,
 * consumed-set, and ref counter — it is a *body capture*, not a fresh
 * channel. Only `body` is captured separately.
 */
export function captureBody<R>(s: TraceState, body: () => R): { ops: Op[]; result: R } {
  const parentBody = s.body;
  // Replace the body array with a fresh one for the duration. We can't
  // just swap the reference (it's `readonly`), so we splice — push a
  // marker, run, then splice back the inserted ops.
  const startLen = parentBody.length;
  const result = body();
  const ops = parentBody.splice(startLen);
  return { ops, result };
}

/**
 * Typed exception thrown by `rejectUnderControl` when a non-rotation
 * op fires inside an active `when` body. ADR-0038 makes this the
 * source-surface enforcement of the principle "coherent control on
 * non-unitary ops is not well-defined" (ADR-0006).
 *
 * The class exists so the tracer tool (`tools/sturm-trace`) can
 * `instanceof InvalidWhenBodyError` instead of regex-matching the
 * message — a clean catch path that builds the
 * `tagged "sturm-trace/invalid-when-body"` envelope without
 * stringly-typed parsing. The free-text message is preserved for
 * humans reading stderr when the tracer is *not* the consumer; the
 * fields are the machine surface.
 *
 * `op` is the primitive that tried to fire (`"observe"`, `"prepare"`,
 * `"discard"`, `"cases"`, `"oracle"`). `controlWires` is a snapshot
 * of the active `whenStack` at the moment of refusal — the control-
 * wire IDs the user wrote in the enclosing `when(q, () => {…})`
 * calls. Both fields land in the tracer's envelope payload.
 */
export class InvalidWhenBodyError extends Error {
  readonly op: string;
  readonly controlWires: readonly bigint[];

  constructor(op: string, controlWires: readonly bigint[]) {
    super(
      `@workbench/sturm: ${op} cannot appear inside a when(...) body. ` +
      "Per ADR-0006/0038, controls are admitted only on ry/rz; " +
      "allocations, measurements, oracles, and classical branches must be unconditional.",
    );
    this.name = "InvalidWhenBodyError";
    this.op = op;
    // Copy so later whenStack mutation (push/pop on exception unwind)
    // can't corrupt the error's view of the violation site.
    this.controlWires = controlWires.slice();
  }
}

/**
 * Emit-time well-formedness check: a primitive that allocates a wire
 * (prepare) or a non-rotation op (observe, cases, discard) must NOT
 * fire inside a `when` body. ADR-0006/0038 admit controls only on
 * ry/rz.
 *
 * Called by `qbool`, `qreg` (which emit prepare ops), `observe`,
 * `cases`, `ptrace`. Not called by `ry`/`rz`/`not` — those are the
 * controlled primitives.
 *
 * Throws `InvalidWhenBodyError` (a subclass of `Error`) on violation.
 * Catching code in `tools/sturm-trace` uses `instanceof` to route the
 * refusal cleanly into the `sturm-trace/invalid-when-body` envelope.
 */
export function rejectUnderControl(s: TraceState, op: string): void {
  if (s.whenStack.length > 0) {
    throw new InvalidWhenBodyError(op, s.whenStack);
  }
}

/**
 * Package a finished trace state into an immutable IR Channel.
 *
 * Output wires: any wire still live (allocated, not consumed) at trace
 * exit is an output. Inputs are output too if they weren't consumed
 * (they pass through). The output order is: inputs-that-pass-through
 * (in input order), then body-allocated wires (in allocation order).
 *
 * This matches Sturm.jl's `trace(N) do args... ... return outputs end`:
 * the body's *return value* in Julia is the explicit output tuple,
 * but our TS `trace` body also returns an explicit tuple — and we
 * sanity-check that the returned wires are exactly the live set.
 */
export function freeze(state: TraceState, declaredOutputs: readonly Wire[]): IRChannel {
  // Validate that every declared output wire is still live (not consumed).
  for (const w of declaredOutputs) {
    if (state.consumed.has(w.id)) {
      throw new Error(
        `@workbench/sturm: trace body returned consumed wire ${w.id}. ` +
        "Wires that have been observe()'d or ptrace()'d cannot be channel outputs.",
      );
    }
    if (!state.liveWires.has(w.id)) {
      throw new Error(
        `@workbench/sturm: trace body returned wire ${w.id} not in this trace.`,
      );
    }
  }
  return buildChannel(state.inputs, declaredOutputs, state.body);
}
