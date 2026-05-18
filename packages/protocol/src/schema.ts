// =============================================================================
// Schema — a typed, transportable description of the values a tool will accept
// =============================================================================
//
// Why this file exists
// --------------------
// A `Value` is a runtime datum: an integer, a record, an expression. A
// `Schema` is something a step removed: it describes a *set* of Values —
// the set of inputs a tool will accept, or the set of outputs it promises
// to produce. Until ADR-0004 we conflated the two: tool authors wrote
// schemas using sample values dressed up with `kindOf("integer")`
// annotations, and downstream consumers (notably `registry-search`)
// pattern-matched on the sample. That worked as documentation, but it
// could not support the load-bearing claims the rest of the project
// makes — that an agent can plan a composition by *type* before
// executing, and that the runner can validate inputs against the
// declared contract before handing them to the tool function.
//
// This module gives Schema its own type. The rest of the system can then
// treat schemas as predicates rather than examples: `validate(v, s)`
// either accepts a Value as conforming or returns a precise
// (path, message) failure; `conforms(v, s): v is V` narrows at the
// TypeScript level so a tool's `fn` body sees a typed input rather than
// a generic `Value`.
//
// The big design decision (see ADR-0004 for the full reasoning):
// Schema is a runtime tagged union with a *phantom* TypeScript type
// parameter `V extends Value`. The parameter is never stored — it
// exists purely so that the constructors compose at the type level:
//
//     S.record({ base: S.kind("integer"), modulus: S.kind("integer") })
//
// has type
//
//     Schema<{ kind: "record"; fields: { base: IntegerValue;
//                                         modulus: IntegerValue } }>
//
// and TypeScript propagates that through `defineTool` so the tool's
// `fn` signature is `(input: { ... }, flags) => ...`. No `as`-casts,
// no `if (input.kind !== "record") throw …` boilerplate.
//
// Three deliberate omissions, all explained in ADR-0004:
//   - no recursive schemas (no `S.lazy`)
//   - no predicate / refinement nodes
//   - no "open" records — every record schema is closed
//
// Schemas are pure data. They round-trip through the value protocol
// via `encodeSchema` / `decodeSchema`, which is what allows
// `--schema` to emit canonical bytes a registry consumer can read
// without spawning the tool.

import { canonicalize } from "./canonical.js";
import { ProtocolError } from "./errors.js";
import {
  isKind,
  list,
  record,
  str,
  sym,
  tagged,
  type BooleanValue,
  type ExpressionValue,
  type Float64Value,
  type IntegerValue,
  type Kind,
  type ListValue,
  type RationalValue,
  type RecordValue,
  type StringValue,
  type SymbolValue,
  type TaggedValue,
  type Value,
} from "./kinds.js";

// -----------------------------------------------------------------------------
// Helper types — map a Kind to its concrete Value variant
// -----------------------------------------------------------------------------
//
// `S.kind("integer")` should produce a `Schema<IntegerValue>`, not a
// `Schema<Value>`. The mapping is mechanical but verbose; we write it
// once here and reuse via `ValueOfKind<K>`.

export type ValueOfKind<K extends Kind> =
  K extends "symbol" ? SymbolValue :
  K extends "string" ? StringValue :
  K extends "integer" ? IntegerValue :
  K extends "rational" ? RationalValue :
  K extends "float64" ? Float64Value :
  K extends "boolean" ? BooleanValue :
  K extends "list" ? ListValue :
  K extends "record" ? RecordValue :
  K extends "expression" ? ExpressionValue :
  K extends "tagged" ? TaggedValue :
  Value;

// `S.list(S.kind("integer"))` should produce a list of integers, not a
// list of arbitrary Values. We narrow `ListValue.items` to the element
// schema's value type.
export interface ListValueOf<E extends Value> {
  readonly kind: "list";
  readonly items: readonly E[];
}

// `S.tagged("foo", S.kind("integer"))` should remember its payload type —
// a `Schema<TaggedValueOf<IntegerValue>>`, not a `Schema<TaggedValue>` that
// has forgotten what it wraps. Mirrors `ListValueOf`: one type parameter,
// structurally narrowed, still a subtype of the wide `TaggedValue`.
export interface TaggedValueOf<P extends Value> {
  readonly kind: "tagged";
  readonly tag: string;
  readonly payload: P;
}

// Tuples are length-fixed lists with positional element types. We map
// the array of schemas to an array of value types via a mapped tuple.
export type TupleValueOf<S extends readonly Schema[]> = {
  readonly kind: "list";
  readonly items: { readonly [I in keyof S]: ValueOf<S[I]> };
};

// Records map each field's schema to that field's value type, with
// fields named in `OptKey` becoming TS-level optional (`field?:`).
// The default `OptKey = never` keeps every field required, which is
// the no-options call. When the caller passes `{ optional: [...] as
// const }` (or a literal array, which TS narrows automatically), the
// optional-key set is inferred and the corresponding fields become
// `?`-typed in the resulting record value.
export type RecordValueOf<
  F extends Record<string, Schema>,
  OptKey extends keyof F = never,
> = {
  readonly kind: "record";
  readonly fields:
    & { readonly [K in keyof F as K extends OptKey ? never : K]: ValueOf<F[K]> }
    & { readonly [K in keyof F as K extends OptKey ? K : never]?: ValueOf<F[K]> };
};

// `ValueOf<S>` extracts the conforming Value type from a Schema. It is
// the named alias of the phantom type parameter, kept around because
// occasionally one wants to talk about it without already having a
// `Schema<V>` in hand.
export type ValueOf<S> = S extends Schema<infer V> ? V : never;

// -----------------------------------------------------------------------------
// SchemaNode — the runtime structure
// -----------------------------------------------------------------------------
//
// `tag` is the discriminator. Every constructor below returns a
// `Schema<V>` whose `.node` is one of these.
//
// We intentionally keep this as plain data — no methods, no closures,
// no class instances. That keeps schemas serializable, hashable, and
// trivially equal-by-canonical-bytes.

export type SchemaNode =
  | { readonly tag: "any" }
  | { readonly tag: "kind"; readonly kind: Kind }
  | { readonly tag: "literal"; readonly value: Value }
  | { readonly tag: "list"; readonly element: Schema }
  | { readonly tag: "tuple"; readonly items: readonly Schema[] }
  | {
      readonly tag: "record";
      readonly fields: { readonly [k: string]: Schema };
      readonly optional: ReadonlySet<string>;
    }
  | {
      readonly tag: "expression";
      readonly head: string | null;
      readonly args: readonly Schema[] | null;
    }
  | {
      readonly tag: "tagged";
      readonly tagName: string | null;
      readonly payload: Schema;
    }
  | { readonly tag: "union"; readonly alts: readonly Schema[] };

// The Schema type itself. The phantom `_v` field is never written or
// read; its sole purpose is to carry the `V` type parameter so TS can
// thread the conforming-Value type through composition. Marking it
// optional with `readonly _v?: V` lets us construct Schemas without
// supplying the phantom value.

export interface Schema<V extends Value = Value> {
  readonly node: SchemaNode;
  readonly _v?: V;
}

// -----------------------------------------------------------------------------
// Constructors — the `S` namespace
// -----------------------------------------------------------------------------
//
// We export both individual constructors (for direct import) and an
// `S` object aggregating them (for the namespace style favoured at
// tool call sites). Keep both forms in sync.

export const anySchema = (): Schema<Value> => ({ node: { tag: "any" } });

export const kindSchema = <K extends Kind>(k: K): Schema<ValueOfKind<K>> => ({
  node: { tag: "kind", kind: k },
});

export const literalSchema = <V extends Value>(v: V): Schema<V> => ({
  node: { tag: "literal", value: v },
});

export const listSchema = <E extends Value>(element: Schema<E>): Schema<ListValueOf<E>> => ({
  node: { tag: "list", element },
});

export const tupleSchema = <S extends readonly Schema[]>(items: S): Schema<TupleValueOf<S>> => ({
  node: { tag: "tuple", items },
});

// Options to `recordSchema`. We avoid threading the optional-keys
// tuple through a named interface — TS's `const` type-parameter
// inference is sharper at the function-signature site than through
// an indirection.
export interface RecordSchemaOptions<F extends Record<string, Schema>> {
  readonly optional?: readonly (keyof F & string)[];
}

export const recordSchema = <
  F extends Record<string, Schema>,
  const O extends readonly (keyof F & string)[] = [],
>(
  fields: F,
  options?: { readonly optional?: O }
): Schema<RecordValueOf<F, O[number]>> => ({
  node: {
    tag: "record",
    fields,
    optional: new Set<string>(options?.optional ?? []),
  },
});

export const expressionSchema = (
  head: string | null = null,
  args: readonly Schema[] | null = null
): Schema<ExpressionValue> => ({
  node: { tag: "expression", head, args },
});

export const taggedSchema = <P extends Value>(
  tagName: string | null,
  payload: Schema<P>
): Schema<TaggedValueOf<P>> => ({
  node: { tag: "tagged", tagName, payload },
});

export const unionSchema = <S extends readonly Schema[]>(
  alts: S
): Schema<ValueOf<S[number]>> => ({
  node: { tag: "union", alts },
});

/**
 * The namespaced constructors. Use as `S.record({...})`, `S.kind("integer")`,
 * etc. at tool call sites — reads more naturally than `recordSchema(...)`.
 */
export const S = {
  any: anySchema,
  kind: kindSchema,
  literal: literalSchema,
  list: listSchema,
  tuple: tupleSchema,
  record: recordSchema,
  expression: expressionSchema,
  tagged: taggedSchema,
  union: unionSchema,
} as const;

// -----------------------------------------------------------------------------
// Conformance — does a Value satisfy a Schema?
// -----------------------------------------------------------------------------
//
// Path tracking
// -------------
// On the happy path we want to allocate nothing for path bookkeeping;
// validation is on the hot path of every tool invocation. We carry a
// linked-list parent pointer (`PathFrame`) and reconstruct the dotted
// path string only when a failure surfaces. This is the same pattern
// recommended for the other protocol error paths (beads issue
// scientist-workbench-lbl).

interface PathFrame {
  readonly parent: PathFrame | null;
  readonly seg: string;
}

function pathFrameToArray(p: PathFrame | null): string[] {
  const out: string[] = [];
  for (let f = p; f !== null; f = f.parent) out.unshift(f.seg);
  return out;
}

export interface ConformanceFailure {
  readonly path: readonly string[];
  readonly message: string;
}

export type ConformanceResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly failure: ConformanceFailure };

const OK: ConformanceResult = { ok: true };

function fail(p: PathFrame | null, message: string): ConformanceResult {
  return { ok: false, failure: { path: pathFrameToArray(p), message } };
}

/**
 * Validate that `v` conforms to `s`. Returns `{ ok: true }` on success,
 * `{ ok: false, failure: { path, message } }` on the first failure
 * encountered. Walks the schema tree top-down, depth-first, in
 * declaration order — agents reading the failure message can rely on
 * the path being the exact location of the mismatch.
 */
export function validate(v: Value, s: Schema): ConformanceResult {
  return walk(v, s.node, null);
}

/**
 * Type-narrowing predicate form. Use when the path/message detail is
 * not needed — typically inside tool fn bodies where the runner has
 * already validated the input.
 */
export function conforms<V extends Value>(v: Value, s: Schema<V>): v is V {
  return validate(v, s).ok;
}

function walk(v: Value, n: SchemaNode, path: PathFrame | null): ConformanceResult {
  switch (n.tag) {
    case "any":
      return OK;

    case "kind":
      return v.kind === n.kind ? OK : fail(path, `expected kind ${n.kind}, got ${v.kind}`);

    case "literal":
      return canonicalize(v) === canonicalize(n.value)
        ? OK
        : fail(path, `value mismatch: expected literal ${canonicalize(n.value)}, got ${canonicalize(v)}`);

    case "list": {
      if (v.kind !== "list") return fail(path, `expected list, got ${v.kind}`);
      for (let i = 0; i < v.items.length; i++) {
        const r = walk(v.items[i]!, n.element.node, { parent: path, seg: String(i) });
        if (!r.ok) return r;
      }
      return OK;
    }

    case "tuple": {
      if (v.kind !== "list") return fail(path, `expected list-as-tuple, got ${v.kind}`);
      if (v.items.length !== n.items.length) {
        return fail(path, `tuple length mismatch: expected ${n.items.length}, got ${v.items.length}`);
      }
      for (let i = 0; i < n.items.length; i++) {
        const r = walk(v.items[i]!, n.items[i]!.node, { parent: path, seg: String(i) });
        if (!r.ok) return r;
      }
      return OK;
    }

    case "record": {
      if (v.kind !== "record") return fail(path, `expected record, got ${v.kind}`);
      // Required and optional fields, conforming where present.
      for (const k of Object.keys(n.fields)) {
        const fv = v.fields[k];
        if (fv === undefined) {
          if (n.optional.has(k)) continue;
          return fail({ parent: path, seg: k }, `missing required field`);
        }
        const r = walk(fv, n.fields[k]!.node, { parent: path, seg: k });
        if (!r.ok) return r;
      }
      // Closed records: extras throw. (See ADR-0004 alternatives.)
      for (const k of Object.keys(v.fields)) {
        if (!(k in n.fields)) {
          return fail({ parent: path, seg: k }, `unexpected field`);
        }
      }
      return OK;
    }

    case "expression": {
      if (v.kind !== "expression") return fail(path, `expected expression, got ${v.kind}`);
      if (n.head !== null && v.head !== n.head) {
        return fail(path, `expected expression head '${n.head}', got '${v.head}'`);
      }
      if (n.args !== null) {
        if (v.args.length !== n.args.length) {
          return fail(path, `expression arity mismatch: expected ${n.args.length}, got ${v.args.length}`);
        }
        for (let i = 0; i < n.args.length; i++) {
          const r = walk(v.args[i]!, n.args[i]!.node, { parent: path, seg: `args.${i}` });
          if (!r.ok) return r;
        }
      }
      return OK;
    }

    case "tagged": {
      if (v.kind !== "tagged") return fail(path, `expected tagged, got ${v.kind}`);
      if (n.tagName !== null && v.tag !== n.tagName) {
        return fail(path, `expected tag '${n.tagName}', got '${v.tag}'`);
      }
      return walk(v.payload, n.payload.node, { parent: path, seg: "payload" });
    }

    case "union": {
      // First-match-wins. We collect the alternatives' messages so a
      // failure tells the agent every shape that was tried — opaque
      // "no match" messages are the kind of diagnostic this project
      // exists to retire.
      const altMessages: string[] = [];
      for (const alt of n.alts) {
        const r = walk(v, alt.node, path);
        if (r.ok) return OK;
        altMessages.push(r.failure.message);
      }
      return fail(path, `no union alternative matched (${altMessages.length} tried): ${altMessages.join(" | ")}`);
    }
  }
}

// -----------------------------------------------------------------------------
// Schema-as-Value transport (encode/decode)
// -----------------------------------------------------------------------------
//
// `--schema` emits canonical bytes; the registry tools want to read
// them back as a real Schema. We define a stable Value encoding for
// every node and a matching decoder. Round-trip identity:
//
//     decodeSchema(encodeSchema(s))  ≡  s   (structurally)
//     canonicalize(encodeSchema(s))  is deterministic
//
// The encoding for `S.kind(k)` is exactly the `kindOf(k)` value
// produced by `kindOf` in kinds.ts — that wire form predates this
// schema language (ADR-0002) and is preserved so registry consumers
// that already understand it keep working.

const SCHEMA_TAG_ANY = "schema/any";
const SCHEMA_TAG_KIND = "schema/kind";
const SCHEMA_TAG_LITERAL = "schema/literal";
const SCHEMA_TAG_LIST = "schema/list";
const SCHEMA_TAG_TUPLE = "schema/tuple";
const SCHEMA_TAG_RECORD = "schema/record";
const SCHEMA_TAG_EXPRESSION = "schema/expression";
const SCHEMA_TAG_TAGGED = "schema/tagged";
const SCHEMA_TAG_UNION = "schema/union";

/**
 * Encode a Schema as a canonical Value. The encoding is deterministic
 * (canonical-bytes equal for equal schemas) and round-trips through
 * `decodeSchema`. This is the wire form for `--schema` output.
 */
export function encodeSchema(s: Schema): Value {
  const n = s.node;
  switch (n.tag) {
    case "any":
      return tagged(SCHEMA_TAG_ANY, sym("any"));
    case "kind":
      return tagged(SCHEMA_TAG_KIND, sym(n.kind));
    case "literal":
      return tagged(SCHEMA_TAG_LITERAL, n.value);
    case "list":
      return tagged(SCHEMA_TAG_LIST, encodeSchema(n.element));
    case "tuple":
      return tagged(SCHEMA_TAG_TUPLE, list(n.items.map(encodeSchema)));
    case "record": {
      const fieldEncodings: Record<string, Value> = {};
      for (const [k, fs] of Object.entries(n.fields)) fieldEncodings[k] = encodeSchema(fs);
      const optionalKeys: Value[] = [];
      // Sorted to keep canonical bytes deterministic regardless of insertion order.
      for (const k of [...n.optional].sort()) optionalKeys.push(str(k));
      return tagged(
        SCHEMA_TAG_RECORD,
        record({
          fields: record(fieldEncodings),
          optional: list(optionalKeys),
        })
      );
    }
    case "expression": {
      const fields: Record<string, Value> = {};
      if (n.head !== null) fields["head"] = str(n.head);
      if (n.args !== null) fields["args"] = list(n.args.map(encodeSchema));
      return tagged(SCHEMA_TAG_EXPRESSION, record(fields));
    }
    case "tagged": {
      const fields: Record<string, Value> = { payload: encodeSchema(n.payload) };
      if (n.tagName !== null) fields["tag"] = str(n.tagName);
      return tagged(SCHEMA_TAG_TAGGED, record(fields));
    }
    case "union":
      return tagged(SCHEMA_TAG_UNION, list(n.alts.map(encodeSchema)));
  }
}

/**
 * Decode a canonical Value produced by `encodeSchema` back into a
 * Schema. Throws `ProtocolError` on malformed input — the wire form
 * is part of the protocol, so failures here are protocol failures,
 * not user failures.
 */
export function decodeSchema(v: Value): Schema {
  if (v.kind !== "tagged") {
    throw new ProtocolError(`schema decode: expected tagged value, got ${v.kind}`);
  }
  switch (v.tag) {
    case SCHEMA_TAG_ANY:
      return anySchema();
    case SCHEMA_TAG_KIND: {
      if (v.payload.kind !== "symbol" || !isKind(v.payload.name)) {
        throw new ProtocolError(`schema decode: kind payload must be a symbol naming a Kind`);
      }
      return kindSchema(v.payload.name);
    }
    case SCHEMA_TAG_LITERAL:
      return literalSchema(v.payload);
    case SCHEMA_TAG_LIST:
      return listSchema(decodeSchema(v.payload));
    case SCHEMA_TAG_TUPLE: {
      if (v.payload.kind !== "list") throw new ProtocolError(`schema decode: tuple payload must be a list`);
      return tupleSchema(v.payload.items.map(decodeSchema));
    }
    case SCHEMA_TAG_RECORD: {
      if (v.payload.kind !== "record") throw new ProtocolError(`schema decode: record payload must be a record`);
      const fieldsV = v.payload.fields["fields"];
      const optionalV = v.payload.fields["optional"];
      if (!fieldsV || fieldsV.kind !== "record") {
        throw new ProtocolError(`schema decode: record.fields missing or wrong shape`);
      }
      if (!optionalV || optionalV.kind !== "list") {
        throw new ProtocolError(`schema decode: record.optional missing or wrong shape`);
      }
      const fields: Record<string, Schema> = {};
      for (const [k, fv] of Object.entries(fieldsV.fields)) fields[k] = decodeSchema(fv);
      const optional = new Set<string>();
      for (const item of optionalV.items) {
        if (item.kind !== "string") throw new ProtocolError(`schema decode: record.optional must contain strings`);
        optional.add(item.value);
      }
      // Hand-construct the node here: `recordSchema` is parametric over
      // the optional-keys tuple for type inference at literal call sites,
      // and the wire-decoded shape (where keys are runtime strings)
      // doesn't carry that information. We return a `Schema<Value>` —
      // the wire format is the source of truth, the TS type is broad.
      const decoded: Schema<Value> = {
        node: { tag: "record", fields, optional },
      };
      return decoded;
    }
    case SCHEMA_TAG_EXPRESSION: {
      if (v.payload.kind !== "record") throw new ProtocolError(`schema decode: expression payload must be a record`);
      const headV = v.payload.fields["head"];
      const argsV = v.payload.fields["args"];
      let head: string | null = null;
      if (headV !== undefined) {
        if (headV.kind !== "string") throw new ProtocolError(`schema decode: expression.head must be a string`);
        head = headV.value;
      }
      let args: Schema[] | null = null;
      if (argsV !== undefined) {
        if (argsV.kind !== "list") throw new ProtocolError(`schema decode: expression.args must be a list`);
        args = argsV.items.map(decodeSchema);
      }
      return expressionSchema(head, args);
    }
    case SCHEMA_TAG_TAGGED: {
      if (v.payload.kind !== "record") throw new ProtocolError(`schema decode: tagged payload must be a record`);
      const tagV = v.payload.fields["tag"];
      const payloadV = v.payload.fields["payload"];
      if (!payloadV) throw new ProtocolError(`schema decode: tagged payload missing 'payload' field`);
      let tagName: string | null = null;
      if (tagV !== undefined) {
        if (tagV.kind !== "string") throw new ProtocolError(`schema decode: tagged.tag must be a string`);
        tagName = tagV.value;
      }
      return taggedSchema(tagName, decodeSchema(payloadV));
    }
    case SCHEMA_TAG_UNION: {
      if (v.payload.kind !== "list") throw new ProtocolError(`schema decode: union payload must be a list`);
      return unionSchema(v.payload.items.map(decodeSchema));
    }
    default:
      throw new ProtocolError(`schema decode: unknown schema tag '${v.tag}'`);
  }
}

// -----------------------------------------------------------------------------
// Convenience: top-level kind extraction
// -----------------------------------------------------------------------------
//
// Registry-search wants to ask "what is the top-level Value kind this
// schema describes?" The answer is well-defined for every node except
// `any` (no constraint) and `union` (multiple alternatives). We
// expose it as `schemaTopKind(s): Kind | null` and let the caller
// decide what to do with `null`.

export function schemaTopKind(s: Schema): Kind | null {
  const n = s.node;
  switch (n.tag) {
    case "any":
      return null;
    case "kind":
      return n.kind;
    case "literal":
      return n.value.kind;
    case "list":
    case "tuple":
      return "list";
    case "record":
      return "record";
    case "expression":
      return "expression";
    case "tagged":
      return "tagged";
    case "union": {
      // If every alternative agrees on a single kind, return it; else null.
      let common: Kind | null = null;
      for (const a of n.alts) {
        const k = schemaTopKind(a);
        if (k === null) return null;
        if (common === null) common = k;
        else if (common !== k) return null;
      }
      return common;
    }
  }
}

/**
 * Walk the schema tree and report whether any node anywhere mentions
 * the given kind. Used by registry-search to decide whether a tool's
 * input might somewhere contain a value of a particular kind, even if
 * the top-level kind differs (e.g. a record-of-integers matches
 * `input_kind=integer` for the deep-search axis).
 */
export function schemaMentionsKind(s: Schema, k: Kind): boolean {
  const n = s.node;
  switch (n.tag) {
    case "any":
      return false;
    case "kind":
      return n.kind === k;
    case "literal":
      return n.value.kind === k;
    case "list":
      return schemaMentionsKind(n.element, k);
    case "tuple":
      return n.items.some((s) => schemaMentionsKind(s, k));
    case "record":
      return Object.values(n.fields).some((s) => schemaMentionsKind(s, k));
    case "expression":
      return n.args !== null && n.args.some((s) => schemaMentionsKind(s, k));
    case "tagged":
      return schemaMentionsKind(n.payload, k);
    case "union":
      return n.alts.some((s) => schemaMentionsKind(s, k));
  }
}

/**
 * If the schema describes an expression with a fixed head, return
 * that head. Otherwise null. Used by registry-search's `head` filter.
 */
export function schemaExpressionHead(s: Schema): string | null {
  const n = s.node;
  if (n.tag === "expression") return n.head;
  return null;
}
