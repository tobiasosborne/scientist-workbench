// The value protocol — ten primitive kinds, exhaustive over `kind`.
// New domains add tagged variants over these primitives, never new primitives.
// See PRD §2.

import { ProtocolError } from "./errors.js";

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

const INT_RE = /^-?(0|[1-9][0-9]*)$/;
const F64_BITS_RE = /^[0-9a-f]{16}$/;

function gcdBigInt(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) {
    const t = x % y;
    x = y;
    y = t;
  }
  return x;
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

export const list = (items: readonly Value[]): ListValue => ({ kind: "list", items });

export const record = (fields: { readonly [k: string]: Value }): RecordValue => ({
  kind: "record",
  fields,
});

export const expr = (head: string, args: readonly Value[]): ExpressionValue => ({
  kind: "expression",
  head,
  args,
});

export const tagged = (tag: string, payload: Value): TaggedValue => ({
  kind: "tagged",
  tag,
  payload,
});

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
