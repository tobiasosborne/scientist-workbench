// =============================================================================
// @workbench/sturm — TS-native frontend DSL for Sturm channels
// =============================================================================
//
// This package realises the design recorded in ADR-0009: a TS-native
// frontend DSL for constructing Sturm Channel IR Values, on top of
// `@workbench/sturm-ir`'s typed builders. The axiom of the layer is
// "agents are TS experts; what a TS expert wants is the spec."
//
// All seven open questions from the first ADR draft were resolved
// against that axiom (see ADR-0009 §"Resolved during skeleton
// review"). This implementation reflects those resolutions:
//
//   - Free functions for the rotation primitives — `rz(q, π)` /
//     `ry(q, π/2)` / `not(q)` — not setters, not methods.
//   - `π = Math.PI`. `piOver(n)` for symbolic preservation through
//     the IR's exact path.
//   - `execute(channel, opts)` free function. `Channel` is pure data.
//   - `Measurement<T>` (renamed from `ClassicalRef`) with
//     `m.if(then, else?)` for post-measurement classical branching.
//   - `QReg<W>` (renamed from `QInt`); arithmetic deferred.
//   - `using` declarations for partial trace; `ptrace(q)` for
//     mid-scope.
//
// Reading order: types → constants → allocators → trace context →
// primitives → control binder → measurement → channel → composition
// → execution. Each section has prose explaining what the section
// does and why; the prose is the spec. Per CLAUDE.md Rule 10
// (literate programming), this file should read top-to-bottom like a
// chapter — read it, then read the test file, and you should be able
// to write Grover yourself.

import {
  type Value,
  type ExpressionValue,
  bool,
  expr,
  float64FromNumber,
  int,
  list,
  rat,
  record,
  str,
  sym,
  parse,
  canonicalize,
  hashCanonicalBytes,
} from "@workbench/protocol";
import {
  type Channel as IRChannel,
  type Wire as IRWire,
  type Op,
  decodeChannel,
  encodeChannel,
  encodeOp,
  observeOp,
  prepareOp,
  ryOp,
  rzOp,
  discardOp,
  casesOp,
  wire,
} from "@workbench/sturm-ir";
import { spawnBun } from "@workbench/contract";

import {
  TraceState,
  allocRefName,
  allocWireId,
  appendOp,
  captureBody,
  checkLive,
  consume,
  currentTrace,
  freeze,
  rejectUnderControl,
  snapshotControls,
  withControl,
  withTrace,
} from "./runtime.js";

// Re-export the typed exception so `tools/sturm-trace` can
// `instanceof`-check it in its catch path (the runner's subprocess
// sees these as instances thrown by `rejectUnderControl`). ADR-0038
// names the source-surface refusal envelope.
export { InvalidWhenBodyError } from "./runtime.js";

// =============================================================================
// Wires
// =============================================================================
//
// `QBool` and `QReg<W>` are *handles* — at trace time they carry no
// state, just a wire id. The trace state in `runtime.ts` carries the
// actual structure (which wires exist, what's been consumed, what's
// the active control stack).
//
// The handles are classes (not plain objects) for two reasons: (a)
// `Symbol.dispose` requires a method and a `using` declaration only
// works on Disposable objects, and (b) phantom typing the handle
// makes `Channel<[QBool, QReg<3>], …>` signatures legible.
//
// Linearity: a QBool whose wire has been consumed (by `observe` or
// `ptrace`) is not directly flagged on the handle — the runtime's
// `consumed` set is the source of truth, queried on every access.
// Why: the same wire id may be referenced by handles created at
// different times (e.g., from `t.input.qbool()`); we don't want one
// handle's consumption to leave another stale handle "live."

class QBoolImpl implements QBool {
  readonly __wireId: bigint;
  readonly __brand!: "QBool";

  constructor(wireId: bigint) {
    this.__wireId = wireId;
  }

  [Symbol.dispose](): void {
    // `using q = qbool(...)` — at scope exit, record a partial trace.
    // If the wire was already consumed (observe / explicit ptrace),
    // skip; otherwise emit a discardOp.
    const s = currentTrace();
    if (!s.consumed.has(this.__wireId)) {
      appendOp(s, discardOp(this.__wireId));
      consume(s, this.__wireId);
    }
  }
}

// QRegImpl carries the runtime data for a QReg. It does not declare an
// index signature at the class level (TS class index signatures
// require *every* property to be assignable to the indexer's value
// type, which conflicts with `width` and `[Symbol.dispose]`); instead,
// `qreg(...)` and `t.input.qreg(...)` cast the return value to the
// `QReg<W>` interface, which carries the index signature. Numeric
// properties are wired by `Object.defineProperty` in the constructor
// so `reg[i]` works at runtime; the cast is the runtime-trusted
// assertion that the layout matches.
class QRegImpl<W extends number> {
  readonly width: W;
  readonly __brand!: "QReg";
  readonly #bits: readonly QBool[];

  constructor(width: W, bits: readonly QBool[]) {
    this.width = width;
    this.#bits = bits;
    for (let i = 0; i < bits.length; i++) {
      Object.defineProperty(this, i, { value: bits[i], enumerable: true });
    }
  }

  *[Symbol.iterator](): Iterator<QBool> {
    for (const b of this.#bits) yield b;
  }

  [Symbol.dispose](): void {
    for (const b of this.#bits) (b as QBoolImpl)[Symbol.dispose]();
  }
}

function makeQReg<W extends number>(width: W, bits: readonly QBool[]): QReg<W> {
  return new QRegImpl(width, bits) as unknown as QReg<W>;
}

/**
 * A single quantum wire. Surfaces only at the lowest layer (hand-traced
 * channels); library calls hide it.
 *
 * Operations on a `QBool` are free functions: `rz(q, δ)` and `ry(q, δ)`
 * for rotation primitives, `not(q)` for the named bit-flip exception,
 * `observe(q)` for measurement, `ptrace(q)` for explicit partial trace.
 *
 * Implements `Disposable` for `using`-block partial trace.
 */
export interface QBool extends Disposable {
  /** The wire's identity inside the trace context. Opaque; do not construct. */
  readonly __wireId: bigint;
}

/**
 * A W-wire quantum register. Indexable by bit position (`x[0]` ≡ LSB).
 * Iteration yields the `W` underlying `QBool`s in little-endian order.
 *
 * Note: arithmetic on registers (e.g. `add(x, y)`, `mul(x, y)`) is
 * deferred. When it lands, the arithmetic-bearing type will be
 * `QInt<W> extends QReg<W>`, leaving this type as the bare register.
 */
export interface QReg<W extends number> extends Disposable, Iterable<QBool> {
  readonly width: W;
  readonly [bit: number]: QBool;
  [Symbol.iterator](): Iterator<QBool>;
}

/**
 * The signature of a channel's input or output side.
 */
export type WireTuple = readonly (QBool | QReg<number>)[];

// =============================================================================
// Constants and angles
// =============================================================================

/**
 * The numeric constant π, exported as `Math.PI`. Use it as you would
 * use `Math.PI` — `π / 2` is the float `1.5707...`, which decays to
 * `float64` in the IR. For symbolic π/n preserved through the IR's
 * exact path, use `piOver(n)`.
 */
export const π: number = Math.PI;

/**
 * Construct the symbolic angle `π / n` as a Value, for IR consumers
 * that benefit from exact representation (e.g. `sturm-equivalent`).
 *
 * @example
 * rz(q, piOver(2));         // symbolic π/2 in the IR
 * rz(q, π / 2);             // float 1.5707... in the IR
 */
export function piOver(n: number | bigint): Value {
  const nb = typeof n === "bigint" ? n : BigInt(n);
  if (nb === 1n) return sym("π");
  return expr("/", [sym("π"), int(nb)]);
}

/**
 * A trace-time angle: a TS number (decays to float64 in the IR) or a
 * symbolic Value (preserved verbatim).
 */
export type Angle = number | Value;

function angleToValue(a: Angle): Value {
  if (typeof a === "number") {
    // Special cases: integer angles 0, ±π, ±π/2, ±π/4 land as rationals
    // for cleaner IR. Anything else goes to float64.
    if (a === 0) return rat(0n, 1n);
    return float64FromNumber(a);
  }
  return a;
}

function probToValue(p: number | boolean): Value {
  if (typeof p === "boolean") return p ? rat(1n, 1n) : rat(0n, 1n);
  if (p === 0) return rat(0n, 1n);
  if (p === 1) return rat(1n, 1n);
  if (p === 0.5) return rat(1n, 2n);
  if (p === 0.25) return rat(1n, 4n);
  if (p === 0.75) return rat(3n, 4n);
  // Generic: encode as float64. Users who need exact rational
  // probabilities can construct the IR directly.
  if (p < 0 || p > 1 || Number.isNaN(p)) {
    throw new Error(`@workbench/sturm: prepare probability ${p} out of [0, 1]`);
  }
  return float64FromNumber(p);
}

// =============================================================================
// Allocators
// =============================================================================

/**
 * Allocate a fresh quantum bit, prepared in the state
 * √(1−p)|0⟩ + √p|1⟩. Records a `prepareOp` against the current trace
 * context.
 *
 * @param p — preparation probability, in [0, 1]. Defaults to 0 (|0⟩).
 *            Booleans accepted as sugar: `qbool(true)` ≡ `qbool(1)`.
 *
 * Use `using q = qbool(...)` for scope-exit partial trace. Note that
 * channels containing `discardOp`s currently fail under
 * `sturm-execute` (out-of-scope per ADR-0006); use `using` only when
 * you do not need to simulate the channel.
 */
export function qbool(p: number | boolean = 0): QBool {
  const s = currentTrace();
  rejectUnderControl(s, "qbool()");
  const id = allocWireId(s);
  appendOp(s, prepareOp(probToValue(p), id));
  return new QBoolImpl(id);
}

/**
 * Allocate a fresh W-wire register, prepared with the given classical
 * value (defaults to 0 = |0…0⟩).
 *
 * Records `W` `prepareOp`s — one per bit, LSB-first, each prepared at
 * `(value >> i) & 1`.
 */
export function qreg<W extends number>(W: W, value: number | bigint = 0): QReg<W> {
  const s = currentTrace();
  rejectUnderControl(s, "qreg()");
  const v = typeof value === "bigint" ? value : BigInt(value);
  const bits: QBool[] = [];
  for (let i = 0; i < W; i++) {
    const bit = (v >> BigInt(i)) & 1n;
    const id = allocWireId(s);
    appendOp(s, prepareOp(bit === 1n ? rat(1n, 1n) : rat(0n, 1n), id));
    bits.push(new QBoolImpl(id));
  }
  return makeQReg(W, bits);
}

// =============================================================================
// Trace context
// =============================================================================

/**
 * The trace context. Handed to the `trace` body; carries an `input`
 * namespace for declaring input wires.
 */
export interface TraceContext {
  readonly input: {
    /** Declare a QBool input. Must be called once per QBool in the channel's input type. */
    qbool(): QBool;
    /** Declare a QReg<W> input. */
    qreg<W extends number>(W: W): QReg<W>;
  };
}

class TraceContextImpl implements TraceContext {
  readonly input: TraceContext["input"];
  constructor(s: TraceState) {
    this.input = {
      qbool: () => {
        if (s.body.length > 0) {
          throw new Error(
            "@workbench/sturm: t.input.qbool() must be called before any body op. " +
            "Declare all inputs first, then build the body.",
          );
        }
        const id = allocWireId(s);
        s.inputs.push(wire(id, "quantum", "qubit"));
        s.inputWireIds.add(id);
        return new QBoolImpl(id);
      },
      qreg: <W extends number>(W: W) => {
        if (s.body.length > 0) {
          throw new Error(
            "@workbench/sturm: t.input.qreg() must be called before any body op.",
          );
        }
        const bits: QBool[] = [];
        for (let i = 0; i < W; i++) {
          const id = allocWireId(s);
          s.inputs.push(wire(id, "quantum", "qubit"));
          s.inputWireIds.add(id);
          bits.push(new QBoolImpl(id));
        }
        return makeQReg(W, bits);
      },
    };
  }
}

/**
 * Construct a `Channel<I, O>` by tracing the body function. The body
 * runs once with a fresh context; primitives accumulate into the IR;
 * the body's return value becomes the channel's output signature.
 *
 * The output tuple's wires must be still-live (not consumed by
 * `observe`/`ptrace`); this is enforced at freeze time.
 *
 * @example
 * const bell = trace<[], []>(() => {
 *   const a = qbool(0.5);
 *   const b = qbool(0);
 *   when(a, () => not(b));
 *   observe(a);
 *   observe(b);
 *   return [];
 * });
 */
export function trace<I extends WireTuple, O extends WireTuple>(
  body: (t: TraceContext) => O,
): Channel<I, O> {
  const { state, result } = withTrace(s => body(new TraceContextImpl(s)));
  // Convert the returned WireTuple (handles) into IR Wire records.
  const outputWires: IRWire[] = result.map(handle => {
    if ("width" in handle) {
      // QReg — splat its bits in order.
      const reg = handle as QReg<number>;
      const wires: IRWire[] = [];
      for (let i = 0; i < reg.width; i++) {
        wires.push(wire(reg[i]!.__wireId, "quantum", "qubit"));
      }
      return wires;
    }
    return [wire(handle.__wireId, "quantum", "qubit")];
  }).flat();
  const ir = freeze(state, outputWires);
  return new Channel<I, O>(ir);
}

// =============================================================================
// Primitives
// =============================================================================

/**
 * Y-axis rotation by `delta`. Records an `ryOp` against `q` with
 * controls inherited from the surrounding `when` stack.
 *
 * `delta` is a TS number (decays to float64) or a symbolic Value
 * (e.g. from `piOver(2)`).
 */
export function ry(q: QBool, delta: Angle): void {
  const s = currentTrace();
  checkLive(s, q.__wireId, "ry");
  appendOp(s, ryOp(q.__wireId, angleToValue(delta), snapshotControls(s)));
}

/**
 * Z-axis rotation by `delta`. Records an `rzOp` against `q` with
 * controls inherited from the surrounding `when` stack.
 */
export function rz(q: QBool, delta: Angle): void {
  const s = currentTrace();
  checkLive(s, q.__wireId, "rz");
  appendOp(s, rzOp(q.__wireId, angleToValue(delta), snapshotControls(s)));
}

/**
 * The single named gate (P5 exception). Bit-flip on a QBool. Records
 * `rz(q, π); ry(q, π)` against the current trace context, inheriting
 * controls from the surrounding `when` stack.
 *
 * Why two primitives, not one: `ry(q, π)` alone is `Ry(π) = -iY` —
 * the Y channel, not X. The Rz(π) factor is invisible at top level
 * (just a global phase) but becomes a relative phase between branches
 * when `not` is wrapped in `when()`. See `Sturm.jl/src/gates.jl:22`
 * and the `Sturm.jl-3yz` bug fix.
 */
export function not(q: QBool): void {
  const s = currentTrace();
  checkLive(s, q.__wireId, "not");
  const ctrls = snapshotControls(s);
  const piVal = piOver(1);
  appendOp(s, rzOp(q.__wireId, piVal, ctrls));
  appendOp(s, ryOp(q.__wireId, piVal, ctrls));
}

// =============================================================================
// Quantum control
// =============================================================================

/**
 * Coherent-control binder. The body's rotation ops inherit `q` on
 * their controls list. Stacks for multi-control.
 *
 * Throws if the body attempts non-rotation ops (`qbool`, `qreg`,
 * `observe`, `cases`, `ptrace`) — controls are only valid on `ry`/`rz`
 * per ADR-0006.
 *
 * @example
 * when(c, () => not(t));                              // CNOT
 * when(c1, () => when(c2, () => not(t)));             // Toffoli
 */
export function when(q: QBool, body: () => void): void {
  const s = currentTrace();
  checkLive(s, q.__wireId, "when");
  withControl(s, q.__wireId, body);
}

// =============================================================================
// Measurement and post-measurement classical control
// =============================================================================

class MeasurementImpl<T> implements Measurement<T> {
  readonly __refId: string;
  readonly __resultType!: T;

  constructor(refId: string) {
    this.__refId = refId;
  }

  if(thenArm: () => void, elseArm?: () => void): void {
    const s = currentTrace();
    const captured = captureBody(s, thenArm);
    const trueArm = captured.ops;
    let falseArm: Op[] = [];
    if (elseArm !== undefined) {
      const cap2 = captureBody(s, elseArm);
      falseArm = cap2.ops;
    }
    appendOp(s, casesOp(this.__refId, trueArm, falseArm));
  }

  [Symbol.dispose](): void {
    // No-op — Measurement holds no wire; refs are scoped to the channel.
  }
}

/**
 * The classical outcome of a measurement, captured at trace time.
 * Resolves to `T` when the channel is executed.
 *
 * Use `m.if(then, else?)` for post-measurement classical branching
 * inside a trace body.
 */
export interface Measurement<T> extends Disposable {
  if(then: () => void, else_?: () => void): void;
  readonly __refId: string;
  readonly __resultType: T;
}

/**
 * Measure `q` and bind the outcome to a `Measurement<boolean>`. Records
 * an `observeOp` against the current trace context. `q` is consumed —
 * subsequent use throws.
 */
export function observe(q: QBool): Measurement<boolean> {
  const s = currentTrace();
  rejectUnderControl(s, "observe()");
  checkLive(s, q.__wireId, "observe");
  const ref = allocRefName(s);
  appendOp(s, observeOp(q.__wireId, ref));
  consume(s, q.__wireId);
  return new MeasurementImpl<boolean>(ref);
}

/**
 * Explicit partial trace on `q`. Records a `discardOp` and consumes
 * the wire. Use only when scope-driven cleanup (`using`) doesn't fit.
 */
export function ptrace(q: QBool): void {
  const s = currentTrace();
  rejectUnderControl(s, "ptrace()");
  checkLive(s, q.__wireId, "ptrace");
  appendOp(s, discardOp(q.__wireId));
  consume(s, q.__wireId);
}

// =============================================================================
// Channel
// =============================================================================

/**
 * A Sturm channel with input signature `I` and output signature `O`.
 * Pure data — wraps an IR Channel and its canonical Value.
 *
 * Composition operations (`then`, `tensor`, `controlled`) and
 * execution (`execute`) are free functions in this module that take
 * `Channel`s and return new `Channel`s or `ExecuteResult`s.
 */
export class Channel<I extends WireTuple, O extends WireTuple> {
  // Phantom type tags: unused at runtime, threaded through the type.
  readonly #_inputBrand!: I;
  readonly #_outputBrand!: O;
  readonly #ir: IRChannel;
  #cachedValue: ExpressionValue | null = null;
  #cachedHash: string | null = null;

  constructor(ir: IRChannel) {
    this.#ir = ir;
  }

  /** Emit the canonical IR Value (`expression` with head `"channel"`). */
  toValue(): ExpressionValue {
    if (this.#cachedValue === null) {
      this.#cachedValue = encodeChannel(this.#ir);
    }
    return this.#cachedValue;
  }

  /** Content-addressed sha256 of `toValue()`'s canonical bytes. */
  hash(): string {
    if (this.#cachedHash === null) {
      const bytes = canonicalize(this.toValue());
      this.#cachedHash = hashCanonicalBytes(bytes);
    }
    return this.#cachedHash;
  }

  /** Decoded typed view of the IR. */
  toIR(): IRChannel {
    return this.#ir;
  }

  /** Construct a `Channel` from a previously-emitted IR Value. */
  static fromValue<I extends WireTuple, O extends WireTuple>(v: Value): Channel<I, O> {
    return new Channel<I, O>(decodeChannel(v));
  }
}

// =============================================================================
// Channel composition (placeholders — Grover does not need these)
// =============================================================================
//
// `then`, `tensor`, `controlled` are channel-level combinators that
// dispatch to the existing IR-level tools (`sturm-then`,
// `sturm-tensor`, `sturm-controlled`). Grover constructs its circuit
// imperatively inside a single `trace`, so these stay as deferred
// implementations; they will land when a use case forces them or when
// the patterns library starts composing pre-built channels.

/** @deprecated v0.1: use a single `trace` block; combinator dispatch deferred. */
export function then<A extends WireTuple, B extends WireTuple, C extends WireTuple>(
  _f: Channel<A, B>,
  _g: Channel<B, C>,
): Channel<A, C> {
  throw new Error("@workbench/sturm: then() is deferred to v0.2; build inside a single trace() block.");
}

/** @deprecated v0.1: use a single `trace` block; combinator dispatch deferred. */
export function tensor<
  A1 extends WireTuple, B1 extends WireTuple,
  A2 extends WireTuple, B2 extends WireTuple,
>(
  _f: Channel<A1, B1>,
  _g: Channel<A2, B2>,
): Channel<readonly [...A1, ...A2], readonly [...B1, ...B2]> {
  throw new Error("@workbench/sturm: tensor() is deferred to v0.2.");
}

/** @deprecated v0.1: use a single `trace` block; combinator dispatch deferred. */
export function controlled<I extends WireTuple, O extends WireTuple>(
  _c: QBool,
  _f: Channel<I, O>,
): Channel<readonly [QBool, ...I], readonly [QBool, ...O]> {
  throw new Error("@workbench/sturm: controlled() is deferred to v0.2.");
}

// =============================================================================
// Execution
// =============================================================================
//
// `execute(channel, opts)` spawns `tools/sturm-execute/tool.ts` (and,
// when `shots > 0`, `tools/sturm-sample/tool.ts`) as subprocesses. Why
// subprocess and not in-process import: the existing tool.ts files
// end with `void runTool(def)` which fires on import and tries to read
// stdin / parse argv. Refactoring every tool to split the CLI entry
// from the def is invasive; subprocess via `spawnBun` works today.
// Reconsider when there's a measured perf complaint.

/**
 * Options for `execute`.
 */
export interface ExecuteOpts<I extends WireTuple = readonly []> {
  input?: I;
  shots?: number;
  entropy?: string;
  precision?: "float64" | "rational";
  backend?: "execute" | "density-matrix" | "hardware";
}

/**
 * Result of `execute`.
 */
export interface ExecuteResult<O extends WireTuple> {
  /** The analytic outcome distribution from `sturm-execute`. */
  distribution: Value;
  /** Present when `opts.shots > 0`. */
  samples?: Value;
  /** Phantom type tag; unused at runtime. */
  readonly __outputBrand?: O;
}

const STURM_EXECUTE_TOOL = "tools/sturm-execute/tool.ts";
const STURM_SAMPLE_TOOL = "tools/sturm-sample/tool.ts";

/**
 * Execute a channel and return the resulting outcome distribution
 * (and optionally a sample of shots). Pipes through `sturm-execute`
 * for the analytic distribution and `sturm-sample` for shots.
 */
export async function execute<I extends WireTuple, O extends WireTuple>(
  channel: Channel<I, O>,
  opts: ExecuteOpts<I> = {},
): Promise<ExecuteResult<O>> {
  if (opts.backend !== undefined && opts.backend !== "execute") {
    throw new Error(
      `@workbench/sturm: backend "${opts.backend}" not supported in v0.1; only "execute".`,
    );
  }
  if (opts.input !== undefined && opts.input.length > 0) {
    throw new Error(
      "@workbench/sturm: opts.input is not supported in v0.1 — channels with non-empty input " +
      "signatures cannot be directly executed yet. Wrap inputs as `prepare` ops inside the trace.",
    );
  }
  const stdin = canonicalize(channel.toValue());

  const exec = await spawnBun([STURM_EXECUTE_TOOL], stdin);
  if (exec.code !== 0) {
    throw new Error(
      `@workbench/sturm: sturm-execute exited ${exec.code}\nstderr: ${exec.stderr}`,
    );
  }
  const distribution = parse(exec.stdout);

  // If the distribution is a `tagged "sturm-execute/out-of-scope"`,
  // surface it directly — the caller can inspect.
  if (distribution.kind === "tagged") {
    return { distribution };
  }

  if (opts.shots === undefined || opts.shots <= 0) {
    return { distribution };
  }

  if (opts.entropy === undefined) {
    throw new Error(
      "@workbench/sturm: opts.shots > 0 requires opts.entropy " +
      "(8 hex bytes per shot per ADR-0007). Use entropy-source to obtain.",
    );
  }

  const sampleStdin = canonicalize(record({
    distribution,
    entropy: str(opts.entropy),
    shots: int(BigInt(opts.shots)),
  }));
  const samp = await spawnBun([STURM_SAMPLE_TOOL], sampleStdin);
  if (samp.code !== 0) {
    throw new Error(
      `@workbench/sturm: sturm-sample exited ${samp.code}\nstderr: ${samp.stderr}`,
    );
  }
  return { distribution, samples: parse(samp.stdout) };
}

// =============================================================================
// Re-exports
// =============================================================================

export type { IRWire as Wire, IRChannel };
