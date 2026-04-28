// Canonical serialisation — strict JSON subset, sorted keys (UTF-16 code units),
// no whitespace, no raw JSON numbers, no escaped forward slash.
// See PRD §2.4. The round-trip property is tested in test/protocol.test.ts.

import { ProtocolError } from "./errors.js";
import type { Value } from "./kinds.js";

export function canonicalize(v: Value): string {
  return encodeAny(v, []);
}

function encodeAny(x: unknown, path: readonly string[]): string {
  if (typeof x === "string") return encodeString(x);
  if (typeof x === "boolean") return x ? "true" : "false";
  if (Array.isArray(x)) {
    const parts: string[] = [];
    for (let i = 0; i < x.length; i++) parts.push(encodeAny(x[i], [...path, String(i)]));
    return "[" + parts.join(",") + "]";
  }
  if (x !== null && typeof x === "object") {
    const keys = Object.keys(x as object);
    keys.sort();
    const parts: string[] = [];
    for (const k of keys) {
      const val = (x as Record<string, unknown>)[k];
      if (val === undefined) continue;
      parts.push(encodeString(k) + ":" + encodeAny(val, [...path, k]));
    }
    return "{" + parts.join(",") + "}";
  }
  if (typeof x === "number") {
    throw new ProtocolError(
      "raw JSON numbers are forbidden in the value protocol; use integer/rational/float64 kinds",
      path
    );
  }
  if (x === null) {
    throw new ProtocolError("null is reserved and not allowed in canonical encoding", path);
  }
  if (typeof x === "bigint") {
    throw new ProtocolError("bigints must be wrapped in an integer kind before encoding", path);
  }
  throw new ProtocolError(`cannot encode value of type ${typeof x}`, path);
}

export function encodeString(s: string): string {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x22) out += '\\"';
    else if (c === 0x5c) out += "\\\\";
    else if (c === 0x08) out += "\\b";
    else if (c === 0x09) out += "\\t";
    else if (c === 0x0a) out += "\\n";
    else if (c === 0x0c) out += "\\f";
    else if (c === 0x0d) out += "\\r";
    else if (c < 0x20) out += "\\u" + c.toString(16).padStart(4, "0");
    else out += s.charAt(i);
  }
  out += '"';
  return out;
}

