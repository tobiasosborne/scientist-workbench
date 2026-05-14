// The value protocol — ten primitive kinds, exhaustive over `kind`.
// New domains add tagged variants over these primitives, never new primitives.
// See PRD §2.
//
// Schema-kind annotations
// -----------------------
// `kindOf("integer")`, `kindOf("string")`, etc. produce a tagged value
// `tagged "schema/kind" <symbol>` that means "any value of this kind." It's
// used in tool schemas where a sample Value would be either misleading
// (an empty list loses its element kind) or arbitrary (the specific
// integer 0 in `int(0n)` says nothing about the schema). Composes
// naturally:
//
//     list([kindOf("integer")])             // list of integers, any contents
//     record({ x: kindOf("integer"),
//              name: kindOf("string") })   // record with x:int, name:string
//
// See `docs/adr/0002-schema-kind-annotations.md`. Consumers (notably
// registry-search) recognise the tag and unwrap to the named kind.

import { ProtocolError } from "./errors.js";
import { INT_RE, F64_BITS_RE, gcdBigInt } from "./numerics.js";

export type Hash = string;

export interface SymbolValue {
  readonly kind: "symbol";
  readonly name: string;
  readonly namespace?: string;
}
export interface StringValue {
  readonly kind: "string";
  readonly value: string;
}
export interface IntegerValue {
  readonly kind: "integer";
  readonly value: string;
}
export interface RationalValue {
  readonly kind: "rational";
  readonly num: string;
  readonly den: string;
}
export interface Float64Value {
  readonly kind: "float64";
  readonly bits: string;
}
export interface BooleanValue {
  readonly kind: "boolean";
  readonly value: boolean;
}
export interface ListValue {
  readonly kind: "list";
  readonly items: readonly Value[];
}
export interface RecordValue {
  readonly kind: "record";
  readonly fields: { readonly [k: string]: Value };
}
export interface ExpressionValue {
  readonly kind: "expression";
  readonly head: string;
  readonly args: readonly Value[];
}
export interface TaggedValue {
  readonly kind: "tagged";
  readonly tag: string;
  readonly payload: Value;
}

export type Value =
  | SymbolValue
  | StringValue
  | IntegerValue
  | RationalValue
  | Float64Value
  | BooleanValue
  | ListValue
  | RecordValue
  | ExpressionValue
  | TaggedValue;

export const KINDS = [
  "symbol",
  "string",
  "integer",
  "rational",
  "float64",
  "boolean",
  "list",
  "record",
  "expression",
  "tagged",
] as const;

export type Kind = (typeof KINDS)[number];

const KIND_SET: ReadonlySet<string> = new Set(KINDS);

export function isKind(s: unknown): s is Kind {
  return typeof s === "string" && KIND_SET.has(s);
}

function checkInt(s: string, field: string): void {
  if (!INT_RE.test(s)) {
    throw new ProtocolError(`integer.${field} must match canonical decimal /^-?(0|[1-9][0-9]*)$/, got ${JSON.stringify(s)}`);
  }
}

export const sym = (name: string, namespace?: string): SymbolValue =>
  namespace === undefined ? { kind: "symbol", name } : { kind: "symbol", name, namespace };

export const str = (value: string): StringValue => ({ kind: "string", value });

export const bool = (value: boolean): BooleanValue => ({ kind: "boolean", value });

// `list` and `record` preserve the structural type of their argument
// (rather than widening to `ListValue` / `RecordValue`) so that
// schema-typed contexts retain the narrow element / field types they
// inferred. A `list([int(0n), int(1n)])` is *assignable to* `ListValue`
// (covariant subtype) but TS keeps the more specific
// `{kind:"list"; items: readonly IntegerValue[]}` so it composes with
// `Schema<ListValueOf<IntegerValue>>` slots — see ADR-0004.
export const list = <E extends Value>(items: readonly E[]): {
  readonly kind: "list";
  readonly items: readonly E[];
} => ({ kind: "list", items });

export const record = <F extends { readonly [k: string]: Value }>(fields: F): {
  readonly kind: "record";
  readonly fields: F;
} => ({ kind: "record", fields });

export const expr = (head: string, args: readonly Value[]): ExpressionValue => ({
  kind: "expression",
  head,
  args,
});

// `tagged` likewise preserves the structural type of its payload rather
// than widening to `TaggedValue`. A `tagged("schema/kind", sym("integer"))`
// keeps `payload: SymbolValue`, so a helper that builds tagged values
// composes with `Schema<TaggedValueOf<…>>` slots instead of forcing an
// `as never` cast at every call site (bead x0lc). The result is still
// assignable to the wide `TaggedValue` (covariant subtype), so existing
// `TaggedValue`-typed call sites are unaffected — see ADR-0004.
export const tagged = <P extends Value>(tag: string, payload: P): {
  readonly kind: "tagged";
  readonly tag: string;
  readonly payload: P;
} => ({ kind: "tagged", tag, payload });

/** The schema-kind annotation tag. See ADR-0002. */
export const SCHEMA_KIND_TAG = "schema/kind";

/**
 * Produce a schema-kind annotation: a tagged value declaring "any value of
 * the given kind." Use in tool schemas where a sample Value would lose
 * structural information (e.g. an empty `list([])` does not advertise its
 * element kind) or be arbitrary (e.g. `int(0n)` for an output declaration).
 */
export function kindOf(k: Kind): TaggedValue {
  return tagged(SCHEMA_KIND_TAG, sym(k));
}

/**
 * If `v` is a schema-kind annotation, return the named kind. Otherwise
 * return `null`. Used by registry consumers to unwrap schemas before
 * filtering.
 */
export function asSchemaKind(v: Value): Kind | null {
  if (v.kind !== "tagged") return null;
  if (v.tag !== SCHEMA_KIND_TAG) return null;
  if (v.payload.kind !== "symbol") return null;
  return isKind(v.payload.name) ? v.payload.name : null;
}

export function int(value: bigint | number | string): IntegerValue {
  let s: string;
  if (typeof value === "bigint") s = value.toString();
  else if (typeof value === "number") {
    if (!Number.isInteger(value)) {
      throw new ProtocolError(`int(): non-integer number ${value}`);
    }
    s = value.toString();
  } else {
    checkInt(value, "value");
    return { kind: "integer", value };
  }
  return { kind: "integer", value: s };
}

export function rat(num: bigint | number | string, den: bigint | number | string): RationalValue {
  const n =
    typeof num === "bigint" ? num : typeof num === "number" ? BigInt(num) : BigInt(num);
  const d =
    typeof den === "bigint" ? den : typeof den === "number" ? BigInt(den) : BigInt(den);
  if (d === 0n) throw new ProtocolError("rat(): denominator is zero");
  let nn = n;
  let dd = d;
  if (dd < 0n) {
    nn = -nn;
    dd = -dd;
  }
  const g = gcdBigInt(nn, dd);
  nn = nn / g;
  dd = dd / g;
  return { kind: "rational", num: nn.toString(), den: dd.toString() };
}

export function float64FromNumber(x: number): Float64Value {
  const buf = new ArrayBuffer(8);
  const dv = new DataView(buf);
  dv.setFloat64(0, x, false);
  let bits = "";
  for (let i = 0; i < 8; i++) bits += dv.getUint8(i).toString(16).padStart(2, "0");
  return { kind: "float64", bits };
}

export function float64ToNumber(v: Float64Value): number {
  if (!F64_BITS_RE.test(v.bits)) throw new ProtocolError(`float64.bits malformed: ${v.bits}`);
  const buf = new ArrayBuffer(8);
  const dv = new DataView(buf);
  for (let i = 0; i < 8; i++) {
    dv.setUint8(i, parseInt(v.bits.substring(2 * i, 2 * i + 2), 16));
  }
  return dv.getFloat64(0, false);
}
