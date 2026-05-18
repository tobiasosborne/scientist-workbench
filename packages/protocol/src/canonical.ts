// Canonical serialisation — strict JSON subset, sorted keys (UTF-16 code units),
// no whitespace, no raw JSON numbers, no escaped forward slash.
// See PRD §2.4. The round-trip property is tested in test/protocol.test.ts.
//
// Implementation
// --------------
// `canonicalize` takes a `Value` and emits canonical-encoded bytes. Because
// the input type is the closed `Value` union (ten kinds, all listed in
// `kinds.ts`), this is an exhaustive `switch` on `v.kind`. The compiler
// flag `noFallthroughCasesInSwitch` (tsconfig.json) enforces coverage —
// if a new kind is added to the union the build will fail at this site,
// pointing to the missing branch. That's how we keep this hot-path code
// honest as the protocol evolves.
//
// Earlier versions of this encoder walked `unknown` with defensive branches
// for raw numbers, `null`, `bigint`, and arrays — none of which can appear
// in a validated `Value`. Those branches were never reached in production
// (validators upstream reject them) but they obscured the actual encoding
// logic. They are gone now; callers with truly unknown input should run
// `validateValue` from `validate.ts` first and then call `canonicalize`.
//
// Key-ordering note
// -----------------
// Each case below emits its fields in lexicographic order over UTF-16 code
// units (the same order `Object.keys(x).sort()` would produce). That order
// is *not* always the order in which the fields are declared in
// `kinds.ts` — for example, a `rational` has declared order `{kind, num,
// den}` but encodes as `{"den":…,"kind":…,"num":…}`. The test suite (1000
// random round-trips, key-reorder-on-parse) and the 350+ tool goldens are
// the canary if any of these orderings ever drift.
//
// `record`'s field-key ordering is the only one that has to be computed at
// runtime (its keys are caller-supplied); we sort them and skip
// `undefined` values (defensive against optional-field assignments that
// leak `undefined` through the type system).

import type { Value } from "./kinds.js";

export function canonicalize(v: Value): string {
  return encodeValue(v);
}

function encodeValue(v: Value): string {
  switch (v.kind) {
    case "symbol":
      // Field order: kind, name, [namespace]. Namespace is optional.
      return v.namespace === undefined
        ? `{"kind":"symbol","name":${encodeString(v.name)}}`
        : `{"kind":"symbol","name":${encodeString(v.name)},"namespace":${encodeString(v.namespace)}}`;
    case "string":
      // Field order: kind, value.
      return `{"kind":"string","value":${encodeString(v.value)}}`;
    case "integer":
      // Field order: kind, value (value is a decimal-string).
      return `{"kind":"integer","value":${encodeString(v.value)}}`;
    case "rational":
      // Field order: den, kind, num (lexicographic; not declaration order).
      return `{"den":${encodeString(v.den)},"kind":"rational","num":${encodeString(v.num)}}`;
    case "float64":
      // Field order: bits, kind (lexicographic; bits is a 16-hex-char string).
      return `{"bits":${encodeString(v.bits)},"kind":"float64"}`;
    case "boolean":
      // Field order: kind, value. Booleans encode as bare `true`/`false`.
      return `{"kind":"boolean","value":${v.value ? "true" : "false"}}`;
    case "list": {
      // Field order: items, kind.
      const parts: string[] = [];
      for (const item of v.items) parts.push(encodeValue(item));
      return `{"items":[${parts.join(",")}],"kind":"list"}`;
    }
    case "record": {
      // Field order at top level: fields, kind. The `fields` payload's
      // own keys come from the caller and are sorted lexicographically.
      const keys = Object.keys(v.fields).sort();
      const parts: string[] = [];
      for (const k of keys) {
        const val = v.fields[k];
        // Defensive against optional fields assigned `undefined` —
        // the type system says `Value`, but JS object literals can
        // pass `undefined` for an optional property.
        if (val === undefined) continue;
        parts.push(encodeString(k) + ":" + encodeValue(val));
      }
      return `{"fields":{${parts.join(",")}},"kind":"record"}`;
    }
    case "expression": {
      // Field order: args, head, kind.
      const argParts: string[] = [];
      for (const arg of v.args) argParts.push(encodeValue(arg));
      return `{"args":[${argParts.join(",")}],"head":${encodeString(v.head)},"kind":"expression"}`;
    }
    case "tagged":
      // Field order: kind, payload, tag.
      return `{"kind":"tagged","payload":${encodeValue(v.payload)},"tag":${encodeString(v.tag)}}`;
  }
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
