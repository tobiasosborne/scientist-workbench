// =============================================================================
// nodes — typed in-memory IR forms, encoders, decoders
// =============================================================================
//
// Why this file exists
// --------------------
// A Sturm channel flows through the workbench as a canonical Value: an
// `expression` with head `"channel"` and three positional args. That
// shape is the protocol object (see ADR-0006) — it has a hash, it
// round-trips through canonicalisation, every Sturm tool consumes it
// directly. But for tool *bodies* — the implementation of
// `sturm-simplify`'s rewrite engine, `sturm-execute`'s state-vector
// loop, `sturm-equivalent`'s matrix builder — the Value shape is
// inconvenient. A rewrite that "merges two consecutive ry on the same
// wire with the same controls" reads naturally over a typed
// discriminated-union form `{ head: "ry"; wireId: 3n; delta: …;
// controls: [1n] }`. It reads as line noise over the raw Value
// `{ kind: "expression", head: "ry", args: [{kind:"integer",
// value:"3"}, …, {kind:"list", items:[{kind:"integer",value:"1"}]}] }`.
//
// This file gives Sturm tools a typed in-memory layer:
//
//   • `Wire`, `Channel`, `Op` (and the seven op-shape interfaces) —
//     the discriminated-union TS forms.
//   • Builder functions (`wire`, `channel`, `prepareOp`, `ryOp`, …)
//     that produce the typed forms with sensible defaults (e.g.,
//     `controls: []` on rotations).
//   • Encoders (`encodeWire`, `encodeChannel`, `encodeOp`) that
//     materialise the typed forms back to canonical Values for
//     transport / hashing / pipe-composition.
//   • Decoders (`decodeWire`, `decodeChannel`, `decodeOp`) that take
//     a Value and return a typed form, throwing `ProtocolError`
//     with a dotted path if the shape is wrong.
//
// The schema layer (in `schema.ts`) is the *value-level* contract: it
// validates a Value against the IR shape using the runner's standard
// `validate` machinery. Schemas are the predicate; this module is the
// convenient typed surface. They agree on the same vocabulary; the
// schema is non-recursive (per ADR-0004's omissions), so the recursive
// slots — `cases` arms, `oracle`'s embedded channel — are
// shape-checked at the schema level via `S.any()` and content-checked
// here in the decoder. The two layers compose: validate first, decode
// second.
//
// The vocabulary is closed (ADR-0006). The op-head set is exactly
// `prepare`, `ry`, `rz`, `observe`, `oracle`, `cases`, `discard`. A
// Value with any other head fails decoding with a loud
// `ProtocolError`. Adding a new head is a breaking change to the IR
// — that closure is the property that makes P5 (no gates, no qubits)
// a structural type fact rather than a code-review guideline.

import {
  expr,
  int,
  list,
  ProtocolError,
  record,
  str,
  type ExpressionValue,
  type ListValue,
  type RecordValue,
  type Value,
} from "@workbench/protocol";

// -----------------------------------------------------------------------------
// Wire
// -----------------------------------------------------------------------------
//
// A wire carries an ID (scoped to the enclosing channel — see ADR-0006
// on local scoping plus rename-on-compose), a kind (classical /
// quantum), and an optional dimension descriptor. v0.1 emits only
// "qubit"; the schema admits "qudit" / "anyon" / "boson" additively
// per P7 (dimension-agnostic), but the body of any v0.1 tool can
// safely assume "qubit" wherever a quantum wire appears. Future
// expansion of the dim space does not change the wire shape.

export type WireKind = "classical" | "quantum";
export type WireDim = "qubit" | "qudit" | "anyon" | "boson";

export interface Wire {
  readonly id: bigint;
  readonly kind: WireKind;
  readonly dim?: WireDim;
}

export function wire(id: bigint, kind: WireKind, dim?: WireDim): Wire {
  return dim === undefined ? { id, kind } : { id, kind, dim };
}

// -----------------------------------------------------------------------------
// Channel
// -----------------------------------------------------------------------------
//
// `inputs` and `outputs` are wire signatures — wires that come in from
// outside and that flow out, respectively. Wires can be declared in
// the inputs and threaded through the body, or prepared inside the
// body and listed in the outputs. The well-formedness check (`wellformed.ts`)
// enforces that every wire referenced by an op is in scope at that
// point. The body is a sequence of ops in document order. Classical
// branches (`cases`) introduce nested op-lists, but the controls-stack
// of any active `when` is already lowered into the inner ops at IR
// build time — see ADR-0006 on why `when` is not its own op-node.

export interface Channel {
  readonly inputs: readonly Wire[];
  readonly outputs: readonly Wire[];
  readonly body: readonly Op[];
}

export function channel(
  inputs: readonly Wire[],
  outputs: readonly Wire[],
  body: readonly Op[]
): Channel {
  return { inputs, outputs, body };
}

// -----------------------------------------------------------------------------
// Op — the closed seven-head union
// -----------------------------------------------------------------------------
//
// Each op interface tags itself with a literal `head` matching the
// expression head used in the canonical Value form. TS narrows on
// `op.head` cleanly. The `Op` type is the algebraic-data-type sum.
//
// Notes on each op:
//
//   prepare(p, wireId)
//     A cq channel. Allocates `wireId` (which must not already be in
//     scope) and prepares it in `√(1−p)|0⟩ + √p|1⟩`. `p` is a Value —
//     a rational, a float64, or a symbolic expression. The op carries
//     it opaquely; the simulator decides what to do with non-rational
//     `p`. Per ADR-0006 / ADR-0038, `prepare` carries no `controls`
//     field: coherent control on a fresh-wire preparation is not
//     well-defined at the IR level. The TS-source tracer (q0b) refuses
//     a `prepare` inside a `when` body with envelope
//     `tagged "sturm-trace/invalid-when-body"`.
//
//   ry(wireId, delta, controls)
//   rz(wireId, delta, controls)
//     Single-axis rotations. `delta` is a Value (rational, float64, or
//     symbolic expression in π-rationals). `controls` is the list of
//     control wire IDs; an empty list is the unconditional rotation,
//     a non-empty list is a multi-controlled rotation (semantics: the
//     rotation fires iff every control wire is `|1⟩`, by convention).
//     Controls only ever name *quantum* wires — wellformed enforces
//     this. ry and rz are the only ops that carry a `controls` field;
//     they are the unitary primitives of the language, and the
//     `whenStack` lowered from a source-level `when(q) { … }` block
//     materialises as their `controls` argument. Every other op-head
//     is uncontrolled at the IR level (ADR-0038).
//
//   observe(wireId, classicalRef)
//     The qc channel — projects `wireId` and binds the outcome to
//     `classicalRef`, a string ID scoped to the enclosing channel.
//     After this op, references to `wireId` are out of scope, and
//     references to `classicalRef` are in scope until the channel
//     terminates. No `controls` field — coherent control on a
//     measurement is not well-defined (ADR-0006 / ADR-0038).
//
//   oracle(circuit, inWires, outWires)
//     A reversible classical oracle. `circuit` is itself a channel
//     Value (typically produced by `sturm-bennett-oracle`); the IR
//     carries it as an opaque payload that downstream tools can
//     re-decode. `inWires` and `outWires` are wire IDs in the
//     enclosing channel that the oracle reads / writes. No `controls`
//     field: the principled way to control an oracle is to lift the
//     `when` into the oracle's source and re-trace, which the IR
//     layer cannot do automatically. Refused at trace time
//     (ADR-0038).
//
//   cases(classicalRef, trueArm, falseArm)
//     A classical branch. `classicalRef` must already be bound by an
//     earlier `observe`. The two arms are themselves op-lists; ops
//     inside an arm see the same wire scope as the parent (no fresh
//     local scope is introduced by the branch). No `controls` field
//     on the cases op itself: coherent control over a classical
//     branch is ill-defined (ADR-0006 / ADR-0038). Inside an arm,
//     the same principle restricts which ops may appear — see
//     `wellformed.ts`.
//
//   discard(wireId)
//     The qq → terminal channel — partial trace on `wireId`. After
//     this op, `wireId` is out of scope. No `controls` field — a
//     coherently-controlled partial trace is ill-defined (ADR-0006 /
//     ADR-0038).
//
// The fact that only `ry` and `rz` admit a `controls` field is one of
// the four enforcement layers ADR-0038 documents (the "builder API"
// layer): TS rejects `observeOp(0n, "r", [1n])` at compile time. The
// other three layers are the schema closure (`schema.ts`), the
// decoder arity check (`decodeOp` below), and the well-formedness
// recursive analogue (`wellformed.ts` cases-arm restrictions).
//
// The interfaces are `readonly` throughout because Values are
// immutable in the protocol; we mirror that here so a tool body that
// thinks it can mutate an op gets a TS error rather than corrupting
// shared state.

export type OpHead =
  | "prepare"
  | "ry"
  | "rz"
  | "observe"
  | "oracle"
  | "cases"
  | "discard";

export interface PrepareOp {
  readonly head: "prepare";
  readonly p: Value;
  readonly wireId: bigint;
}

export interface RyOp {
  readonly head: "ry";
  readonly wireId: bigint;
  readonly delta: Value;
  readonly controls: readonly bigint[];
}

export interface RzOp {
  readonly head: "rz";
  readonly wireId: bigint;
  readonly delta: Value;
  readonly controls: readonly bigint[];
}

export interface ObserveOp {
  readonly head: "observe";
  readonly wireId: bigint;
  readonly classicalRef: string;
}

export interface OracleOp {
  readonly head: "oracle";
  readonly circuit: Value;
  readonly inWires: readonly bigint[];
  readonly outWires: readonly bigint[];
}

export interface CasesOp {
  readonly head: "cases";
  readonly classicalRef: string;
  readonly trueArm: readonly Op[];
  readonly falseArm: readonly Op[];
}

export interface DiscardOp {
  readonly head: "discard";
  readonly wireId: bigint;
}

export type Op =
  | PrepareOp
  | RyOp
  | RzOp
  | ObserveOp
  | OracleOp
  | CasesOp
  | DiscardOp;

// -----------------------------------------------------------------------------
// Builder functions
// -----------------------------------------------------------------------------
//
// Convenience constructors that produce typed op forms. The defaults
// here are the documented default for each op — `controls: []` on
// rotations, no fall-through dim on wires. A tool author writing
// agent-facing IR by hand should reach for these rather than
// hand-rolling object literals; the result is the same typed value.

export function prepareOp(p: Value, wireId: bigint): PrepareOp {
  return { head: "prepare", p, wireId };
}

export function ryOp(
  wireId: bigint,
  delta: Value,
  controls: readonly bigint[] = []
): RyOp {
  return { head: "ry", wireId, delta, controls };
}

export function rzOp(
  wireId: bigint,
  delta: Value,
  controls: readonly bigint[] = []
): RzOp {
  return { head: "rz", wireId, delta, controls };
}

export function observeOp(wireId: bigint, classicalRef: string): ObserveOp {
  return { head: "observe", wireId, classicalRef };
}

export function oracleOp(
  circuit: Value,
  inWires: readonly bigint[],
  outWires: readonly bigint[]
): OracleOp {
  return { head: "oracle", circuit, inWires, outWires };
}

export function casesOp(
  classicalRef: string,
  trueArm: readonly Op[],
  falseArm: readonly Op[]
): CasesOp {
  return { head: "cases", classicalRef, trueArm, falseArm };
}

export function discardOp(wireId: bigint): DiscardOp {
  return { head: "discard", wireId };
}

// -----------------------------------------------------------------------------
// Encoders — typed form → canonical Value
// -----------------------------------------------------------------------------
//
// These produce the protocol-Value form an agent or a downstream tool
// will see. The encoded bytes are content-addressed: equal channels
// hash to the same SHA-256.

function wireIdsToList(ids: readonly bigint[]): ListValue {
  return list(ids.map(int));
}

export function encodeWire(w: Wire): RecordValue {
  if (w.dim === undefined) {
    return record({ id: int(w.id), kind: str(w.kind) });
  }
  return record({ id: int(w.id), kind: str(w.kind), dim: str(w.dim) });
}

export function encodeOp(op: Op): ExpressionValue {
  switch (op.head) {
    case "prepare":
      return expr("prepare", [op.p, int(op.wireId)]);
    case "ry":
      return expr("ry", [int(op.wireId), op.delta, wireIdsToList(op.controls)]);
    case "rz":
      return expr("rz", [int(op.wireId), op.delta, wireIdsToList(op.controls)]);
    case "observe":
      return expr("observe", [int(op.wireId), str(op.classicalRef)]);
    case "oracle":
      return expr("oracle", [
        op.circuit,
        wireIdsToList(op.inWires),
        wireIdsToList(op.outWires),
      ]);
    case "cases":
      return expr("cases", [
        str(op.classicalRef),
        list(op.trueArm.map(encodeOp)),
        list(op.falseArm.map(encodeOp)),
      ]);
    case "discard":
      return expr("discard", [int(op.wireId)]);
  }
}

export function encodeChannel(c: Channel): ExpressionValue {
  return expr("channel", [
    list(c.inputs.map(encodeWire)),
    list(c.outputs.map(encodeWire)),
    list(c.body.map(encodeOp)),
  ]);
}

// -----------------------------------------------------------------------------
// Decoders — canonical Value → typed form
// -----------------------------------------------------------------------------
//
// The decoder is the boundary between the value-protocol world and the
// typed in-memory world. It throws `ProtocolError` with a dotted path
// when shapes don't match. The schema (in `schema.ts`) catches most of
// these mismatches earlier — but the schema is non-recursive (per
// ADR-0004's omissions), so the recursive slots (`cases` arms,
// `oracle`'s embedded channel Value) are decoded here.
//
// The path argument is a stack-like dotted prefix passed through
// recursion; users who only have a single value to decode call the
// top-level functions and never see it.

function expectExpression(v: Value, head: string, path: string): ExpressionValue {
  if (v.kind !== "expression") {
    throw new ProtocolError(
      `${path}: expected expression with head "${head}", got kind ${v.kind}`
    );
  }
  if (v.head !== head) {
    throw new ProtocolError(
      `${path}: expected expression head "${head}", got "${v.head}"`
    );
  }
  return v;
}

function expectArgsLength(e: ExpressionValue, n: number, path: string): void {
  if (e.args.length !== n) {
    throw new ProtocolError(
      `${path}: expected ${n} args for "${e.head}", got ${e.args.length}`
    );
  }
}

function expectInteger(v: Value, path: string): bigint {
  if (v.kind !== "integer") {
    throw new ProtocolError(`${path}: expected integer, got kind ${v.kind}`);
  }
  return BigInt(v.value);
}

function expectString(v: Value, path: string): string {
  if (v.kind !== "string") {
    throw new ProtocolError(`${path}: expected string, got kind ${v.kind}`);
  }
  return v.value;
}

function expectList(v: Value, path: string): ListValue {
  if (v.kind !== "list") {
    throw new ProtocolError(`${path}: expected list, got kind ${v.kind}`);
  }
  return v;
}

function expectRecord(v: Value, path: string): RecordValue {
  if (v.kind !== "record") {
    throw new ProtocolError(`${path}: expected record, got kind ${v.kind}`);
  }
  return v;
}

function expectField(rec: RecordValue, key: string, path: string): Value {
  const v = rec.fields[key];
  if (v === undefined) {
    throw new ProtocolError(`${path}: missing required field "${key}"`);
  }
  return v;
}

function expectIntegerList(v: Value, path: string): bigint[] {
  const xs = expectList(v, path).items;
  return xs.map((item, i) => expectInteger(item, `${path}.${i}`));
}

function decodeWireKindString(s: string, path: string): WireKind {
  if (s === "classical" || s === "quantum") return s;
  throw new ProtocolError(
    `${path}: wire.kind must be "classical" or "quantum", got "${s}"`
  );
}

function decodeWireDimString(s: string, path: string): WireDim {
  if (s === "qubit" || s === "qudit" || s === "anyon" || s === "boson") return s;
  throw new ProtocolError(
    `${path}: wire.dim must be one of "qubit"/"qudit"/"anyon"/"boson", got "${s}"`
  );
}

export function decodeWire(v: Value, path = "$"): Wire {
  const rec = expectRecord(v, path);
  const id = expectInteger(expectField(rec, "id", path), `${path}.id`);
  const kindStr = expectString(expectField(rec, "kind", path), `${path}.kind`);
  const kind = decodeWireKindString(kindStr, `${path}.kind`);
  const dimVal = rec.fields["dim"];
  if (dimVal === undefined) {
    return { id, kind };
  }
  const dim = decodeWireDimString(expectString(dimVal, `${path}.dim`), `${path}.dim`);
  // Reject extras to keep the IR shape tight.
  for (const k of Object.keys(rec.fields)) {
    if (k !== "id" && k !== "kind" && k !== "dim") {
      throw new ProtocolError(`${path}: unexpected field "${k}" on wire`);
    }
  }
  return { id, kind, dim };
}

const OP_HEADS: ReadonlySet<string> = new Set([
  "prepare",
  "ry",
  "rz",
  "observe",
  "oracle",
  "cases",
  "discard",
]);

export function decodeOp(v: Value, path = "$"): Op {
  if (v.kind !== "expression") {
    throw new ProtocolError(`${path}: expected expression op, got kind ${v.kind}`);
  }
  if (!OP_HEADS.has(v.head)) {
    throw new ProtocolError(
      `${path}: unknown op head "${v.head}"; the IR vocabulary is closed (ADR-0006)`
    );
  }
  switch (v.head) {
    case "prepare": {
      expectArgsLength(v, 2, path);
      const p = v.args[0]!;
      const wireId = expectInteger(v.args[1]!, `${path}.args[1]`);
      return prepareOp(p, wireId);
    }
    case "ry":
    case "rz": {
      expectArgsLength(v, 3, path);
      const wireId = expectInteger(v.args[0]!, `${path}.args[0]`);
      const delta = v.args[1]!;
      const controls = expectIntegerList(v.args[2]!, `${path}.args[2]`);
      return v.head === "ry"
        ? ryOp(wireId, delta, controls)
        : rzOp(wireId, delta, controls);
    }
    case "observe": {
      expectArgsLength(v, 2, path);
      const wireId = expectInteger(v.args[0]!, `${path}.args[0]`);
      const classicalRef = expectString(v.args[1]!, `${path}.args[1]`);
      return observeOp(wireId, classicalRef);
    }
    case "oracle": {
      expectArgsLength(v, 3, path);
      const circuit = v.args[0]!;
      const inWires = expectIntegerList(v.args[1]!, `${path}.args[1]`);
      const outWires = expectIntegerList(v.args[2]!, `${path}.args[2]`);
      return oracleOp(circuit, inWires, outWires);
    }
    case "cases": {
      expectArgsLength(v, 3, path);
      const classicalRef = expectString(v.args[0]!, `${path}.args[0]`);
      const trueArm = decodeOpList(v.args[1]!, `${path}.args[1]`);
      const falseArm = decodeOpList(v.args[2]!, `${path}.args[2]`);
      return casesOp(classicalRef, trueArm, falseArm);
    }
    case "discard": {
      expectArgsLength(v, 1, path);
      const wireId = expectInteger(v.args[0]!, `${path}.args[0]`);
      return discardOp(wireId);
    }
  }
  // Unreachable — OP_HEADS is exhaustive over the switch above. The
  // invariant is enforced by the closed union of heads at construction.
  throw new ProtocolError(`${path}: internal: unhandled op head "${v.head}"`);
}

function decodeOpList(v: Value, path: string): Op[] {
  const xs = expectList(v, path).items;
  return xs.map((item, i) => decodeOp(item, `${path}.${i}`));
}

export function decodeChannel(v: Value, path = "$"): Channel {
  const e = expectExpression(v, "channel", path);
  expectArgsLength(e, 3, path);
  const inputs = expectList(e.args[0]!, `${path}.args[0]`).items.map((w, i) =>
    decodeWire(w, `${path}.args[0].${i}`)
  );
  const outputs = expectList(e.args[1]!, `${path}.args[1]`).items.map((w, i) =>
    decodeWire(w, `${path}.args[1].${i}`)
  );
  const body = decodeOpList(e.args[2]!, `${path}.args[2]`);
  return { inputs, outputs, body };
}
