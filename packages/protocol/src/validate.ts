// Structural validation: walk an unknown JS object and confirm it is a Value.
// Rejects raw JSON numbers and unknown kinds. Emits ProtocolError with a path
// pointing at the offending node.

import { ProtocolError } from "./errors.js";
import { isKind } from "./kinds.js";
import type { Value } from "./kinds.js";

const INT_RE = /^-?(0|[1-9][0-9]*)$/;
const F64_BITS_RE = /^[0-9a-f]{16}$/;

export function validateValue(x: unknown): Value {
  return walk(x, []);
}

function walk(x: unknown, path: readonly string[]): Value {
  if (x === null) throw new ProtocolError("null is not a valid value", path);
  if (typeof x !== "object") throw new ProtocolError(`expected object, got ${typeof x}`, path);
  if (Array.isArray(x)) throw new ProtocolError("expected object, got array", path);

  const obj = x as Record<string, unknown>;
  const kind = obj["kind"];
  if (typeof kind !== "string") {
    throw new ProtocolError("missing string `kind` discriminator", path);
  }
  if (!isKind(kind)) {
    throw new ProtocolError(`unknown kind ${JSON.stringify(kind)}`, path);
  }

  switch (kind) {
    case "symbol": {
      requireKeys(obj, ["kind", "name"], ["namespace"], path);
      const name = requireString(obj, "name", path);
      const out: Value = { kind: "symbol", name };
      if ("namespace" in obj) {
        const ns = requireString(obj, "namespace", path);
        return { kind: "symbol", name, namespace: ns };
      }
      return out;
    }
    case "string": {
      requireKeys(obj, ["kind", "value"], [], path);
      return { kind: "string", value: requireString(obj, "value", path) };
    }
    case "integer": {
      requireKeys(obj, ["kind", "value"], [], path);
      const v = requireString(obj, "value", path);
      if (!INT_RE.test(v)) {
        throw new ProtocolError(`integer.value not canonical: ${JSON.stringify(v)}`, [
          ...path,
          "value",
        ]);
      }
      return { kind: "integer", value: v };
    }
    case "rational": {
      requireKeys(obj, ["kind", "num", "den"], [], path);
      const num = requireString(obj, "num", path);
      const den = requireString(obj, "den", path);
      if (!INT_RE.test(num)) {
        throw new ProtocolError(`rational.num not canonical: ${JSON.stringify(num)}`, [
          ...path,
          "num",
        ]);
      }
      if (!INT_RE.test(den)) {
        throw new ProtocolError(`rational.den not canonical: ${JSON.stringify(den)}`, [
          ...path,
          "den",
        ]);
      }
      const dn = BigInt(den);
      if (dn <= 0n) {
        throw new ProtocolError(`rational.den must be positive, got ${den}`, [...path, "den"]);
      }
      const nn = BigInt(num);
      const g = gcdBigInt(nn, dn);
      if (g !== 1n) {
        throw new ProtocolError(
          `rational not in lowest terms: gcd(${num}, ${den}) = ${g.toString()}`,
          path
        );
      }
      return { kind: "rational", num, den };
    }
    case "float64": {
      requireKeys(obj, ["kind", "bits"], [], path);
      const bits = requireString(obj, "bits", path);
      if (!F64_BITS_RE.test(bits)) {
        throw new ProtocolError(
          `float64.bits must be 16 lowercase hex chars, got ${JSON.stringify(bits)}`,
          [...path, "bits"]
        );
      }
      return { kind: "float64", bits };
    }
    case "boolean": {
      requireKeys(obj, ["kind", "value"], [], path);
      const v = obj["value"];
      if (typeof v !== "boolean") {
        throw new ProtocolError(`boolean.value not a boolean (got ${typeof v})`, [
          ...path,
          "value",
        ]);
      }
      return { kind: "boolean", value: v };
    }
    case "list": {
      requireKeys(obj, ["kind", "items"], [], path);
      const items = obj["items"];
      if (!Array.isArray(items)) {
        throw new ProtocolError("list.items not an array", [...path, "items"]);
      }
      const out: Value[] = [];
      for (let i = 0; i < items.length; i++) out.push(walk(items[i], [...path, "items", String(i)]));
      return { kind: "list", items: out };
    }
    case "record": {
      requireKeys(obj, ["kind", "fields"], [], path);
      const fields = obj["fields"];
      if (fields === null || typeof fields !== "object" || Array.isArray(fields)) {
        throw new ProtocolError("record.fields not an object", [...path, "fields"]);
      }
      const out: Record<string, Value> = {};
      for (const k of Object.keys(fields)) {
        out[k] = walk((fields as Record<string, unknown>)[k], [...path, "fields", k]);
      }
      return { kind: "record", fields: out };
    }
    case "expression": {
      requireKeys(obj, ["kind", "head", "args"], [], path);
      const head = requireString(obj, "head", path);
      const args = obj["args"];
      if (!Array.isArray(args)) {
        throw new ProtocolError("expression.args not an array", [...path, "args"]);
      }
      const out: Value[] = [];
      for (let i = 0; i < args.length; i++) out.push(walk(args[i], [...path, "args", String(i)]));
      return { kind: "expression", head, args: out };
    }
    case "tagged": {
      requireKeys(obj, ["kind", "tag", "payload"], [], path);
      const tag = requireString(obj, "tag", path);
      const payload = walk(obj["payload"], [...path, "payload"]);
      return { kind: "tagged", tag, payload };
    }
  }
}

function requireKeys(
  obj: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  path: readonly string[]
): void {
  const allowed = new Set([...required, ...optional]);
  for (const k of required) {
    if (!(k in obj)) throw new ProtocolError(`missing required field ${JSON.stringify(k)}`, path);
  }
  for (const k of Object.keys(obj)) {
    if (!allowed.has(k)) {
      throw new ProtocolError(`unexpected field ${JSON.stringify(k)} on kind ${JSON.stringify(obj["kind"])}`, path);
    }
  }
}

function requireString(obj: Record<string, unknown>, key: string, path: readonly string[]): string {
  const v = obj[key];
  if (typeof v !== "string") {
    throw new ProtocolError(`field ${JSON.stringify(key)} not a string (got ${typeof v})`, [
      ...path,
      key,
    ]);
  }
  return v;
}

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
