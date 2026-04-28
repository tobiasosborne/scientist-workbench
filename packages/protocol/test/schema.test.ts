// Schema conformance + transport round-trip tests.
//
// Coverage axes:
//   - every SchemaNode tag has a happy and an unhappy case
//   - record handles required/optional/extras correctly
//   - tuple is length-strict
//   - union returns first-match-wins and surfaces all tried-alternative messages
//   - encodeSchema → decodeSchema is identity (structurally) on every node
//   - encodeSchema is deterministic (canonical bytes equal for equal schemas)
//   - the wire form for S.kind matches the legacy kindOf() value
//   - top-level helpers (schemaTopKind, schemaMentionsKind, schemaExpressionHead)
//     return what registry-search expects

import { describe, expect, test } from "bun:test";
import {
  bool,
  canonicalize,
  conforms,
  decodeSchema,
  encodeSchema,
  expr,
  int,
  kindOf,
  list,
  rat,
  record,
  S,
  schemaExpressionHead,
  schemaMentionsKind,
  schemaTopKind,
  str,
  sym,
  tagged,
  validate,
  type IntegerValue,
  type StringValue,
} from "../src/index.js";

// ── leaf-node conformance ───────────────────────────────────────────────────

describe("S.any", () => {
  test("accepts every kind", () => {
    for (const v of [int(0n), str("a"), sym("x"), bool(true), list([]), record({}), expr("h", []), tagged("t", int(0n))]) {
      expect(validate(v, S.any())).toEqual({ ok: true });
    }
  });
});

describe("S.kind", () => {
  test("accepts the named kind", () => {
    expect(validate(int(7n), S.kind("integer"))).toEqual({ ok: true });
    expect(validate(str("a"), S.kind("string"))).toEqual({ ok: true });
  });
  test("rejects with kind in message", () => {
    const r = validate(str("a"), S.kind("integer"));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.failure.message).toContain("integer");
      expect(r.failure.message).toContain("string");
      expect(r.failure.path).toEqual([]);
    }
  });
});

describe("S.literal", () => {
  test("accepts canonically-equal value (insensitive to record key order)", () => {
    const lit = record({ b: int(2n), a: int(1n) });
    const reordered = record({ a: int(1n), b: int(2n) });
    expect(validate(reordered, S.literal(lit))).toEqual({ ok: true });
  });
  test("rejects different value", () => {
    expect(validate(int(8n), S.literal(int(7n))).ok).toBe(false);
  });
});

// ── structural conformance ──────────────────────────────────────────────────

describe("S.list", () => {
  test("accepts a list of conforming elements", () => {
    expect(validate(list([int(1n), int(2n), int(3n)]), S.list(S.kind("integer"))).ok).toBe(true);
    expect(validate(list([]), S.list(S.kind("integer"))).ok).toBe(true);
  });
  test("rejects on first non-conforming element with index in path", () => {
    const r = validate(list([int(1n), str("oops"), int(3n)]), S.list(S.kind("integer")));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.path).toEqual(["1"]);
  });
  test("rejects non-list values", () => {
    expect(validate(int(0n), S.list(S.kind("integer"))).ok).toBe(false);
  });
});

describe("S.tuple", () => {
  test("accepts a length-matched, position-conforming list", () => {
    const sch = S.tuple([S.kind("integer"), S.kind("string"), S.kind("boolean")]);
    expect(validate(list([int(1n), str("a"), bool(true)]), sch).ok).toBe(true);
  });
  test("length mismatch rejects", () => {
    const sch = S.tuple([S.kind("integer"), S.kind("string")]);
    const r = validate(list([int(1n)]), sch);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.message).toContain("length");
  });
  test("positional kind mismatch rejects with index in path", () => {
    const sch = S.tuple([S.kind("integer"), S.kind("string")]);
    const r = validate(list([int(1n), int(2n)]), sch);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.path).toEqual(["1"]);
  });
});

describe("S.record", () => {
  test("accepts records with all required fields, no extras", () => {
    const sch = S.record({ a: S.kind("integer"), b: S.kind("string") });
    expect(validate(record({ a: int(1n), b: str("x") }), sch).ok).toBe(true);
  });
  test("missing required field surfaces field name in path", () => {
    const sch = S.record({ a: S.kind("integer"), b: S.kind("string") });
    const r = validate(record({ a: int(1n) }), sch);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.failure.path).toEqual(["b"]);
      expect(r.failure.message).toContain("missing");
    }
  });
  test("optional field may be absent", () => {
    const sch = S.record(
      { a: S.kind("integer"), b: S.kind("string") },
      { optional: ["b"] }
    );
    expect(validate(record({ a: int(1n) }), sch).ok).toBe(true);
  });
  test("optional field, when present, must conform", () => {
    const sch = S.record(
      { a: S.kind("integer"), b: S.kind("string") },
      { optional: ["b"] }
    );
    const r = validate(record({ a: int(1n), b: int(2n) }), sch);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.path).toEqual(["b"]);
  });
  test("extras rejected (closed records)", () => {
    const sch = S.record({ a: S.kind("integer") });
    const r = validate(record({ a: int(1n), surprise: str("x") }), sch);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.failure.path).toEqual(["surprise"]);
      expect(r.failure.message).toContain("unexpected");
    }
  });
  test("nested record path is dotted-deep", () => {
    const sch = S.record({
      outer: S.record({ inner: S.list(S.kind("integer")) }),
    });
    const v = record({ outer: record({ inner: list([int(1n), str("oops")]) }) });
    const r = validate(v, sch);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.path).toEqual(["outer", "inner", "1"]);
  });
});

describe("S.expression", () => {
  test("any expression matches when head and args unset", () => {
    expect(validate(expr("f", [int(1n)]), S.expression()).ok).toBe(true);
  });
  test("head must match when specified", () => {
    expect(validate(expr("+", [int(1n), int(2n)]), S.expression("+")).ok).toBe(true);
    expect(validate(expr("-", [int(1n), int(2n)]), S.expression("+")).ok).toBe(false);
  });
  test("args (tuple) must match when specified", () => {
    const sch = S.expression("^", [S.kind("symbol"), S.kind("integer")]);
    expect(validate(expr("^", [sym("x"), int(2n)]), sch).ok).toBe(true);
    const r = validate(expr("^", [sym("x"), str("oops")]), sch);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.path).toEqual(["args.1"]);
  });
  test("rejects non-expression values", () => {
    expect(validate(int(0n), S.expression("+")).ok).toBe(false);
  });
});

describe("S.tagged", () => {
  test("tag matches when specified", () => {
    expect(validate(tagged("t/oos", int(1n)), S.tagged("t/oos", S.kind("integer"))).ok).toBe(true);
    expect(validate(tagged("other", int(1n)), S.tagged("t/oos", S.kind("integer"))).ok).toBe(false);
  });
  test("payload must conform", () => {
    const r = validate(tagged("t", str("a")), S.tagged("t", S.kind("integer")));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.path).toEqual(["payload"]);
  });
  test("any tag if not specified", () => {
    expect(validate(tagged("anything", int(1n)), S.tagged(null, S.kind("integer"))).ok).toBe(true);
  });
});

describe("S.union", () => {
  test("first matching alt wins", () => {
    const sch = S.union([S.kind("integer"), S.kind("string")]);
    expect(validate(int(1n), sch).ok).toBe(true);
    expect(validate(str("a"), sch).ok).toBe(true);
    expect(validate(bool(true), sch).ok).toBe(false);
  });
  test("failure message lists every tried alternative", () => {
    const sch = S.union([S.kind("integer"), S.kind("string")]);
    const r = validate(bool(true), sch);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.failure.message).toContain("2 tried");
      expect(r.failure.message).toContain("integer");
      expect(r.failure.message).toContain("string");
    }
  });
  test("literal-of-string union is the natural enum encoding", () => {
    const direction = S.union([S.literal(str("forward")), S.literal(str("inverse"))]);
    expect(validate(str("forward"), direction).ok).toBe(true);
    expect(validate(str("inverse"), direction).ok).toBe(true);
    expect(validate(str("sideways"), direction).ok).toBe(false);
  });
});

// ── conforms() type narrowing ───────────────────────────────────────────────

describe("conforms type narrowing", () => {
  test("narrows to the declared variant", () => {
    const v: unknown = int(7n);
    if (typeof v === "object" && v !== null && "kind" in v) {
      const value = v as IntegerValue | StringValue;
      const integerSchema = S.kind("integer");
      if (conforms(value, integerSchema)) {
        // TS sees `value` as IntegerValue here; .value is a string.
        expect(value.value).toBe("7");
      } else {
        throw new Error("expected conforms to return true");
      }
    }
  });
});

// ── transport round-trip ────────────────────────────────────────────────────

describe("encodeSchema / decodeSchema round-trip", () => {
  const cases = [
    { name: "any", s: S.any() },
    { name: "kind:integer", s: S.kind("integer") },
    { name: "kind:string", s: S.kind("string") },
    { name: "literal", s: S.literal(str("forward")) },
    { name: "list of integers", s: S.list(S.kind("integer")) },
    {
      name: "tuple",
      s: S.tuple([S.kind("integer"), S.kind("string"), S.kind("boolean")]),
    },
    {
      name: "record with optionals",
      s: S.record(
        { a: S.kind("integer"), b: S.kind("string") },
        { optional: ["b"] }
      ),
    },
    {
      name: "expression with head",
      s: S.expression("+", [S.kind("integer"), S.kind("integer")]),
    },
    { name: "expression open", s: S.expression() },
    { name: "tagged", s: S.tagged("foo/bar", S.kind("integer")) },
    {
      name: "union of literals",
      s: S.union([S.literal(str("forward")), S.literal(str("inverse"))]),
    },
    {
      name: "deep nesting",
      s: S.record({
        n: S.kind("integer"),
        x: S.list(S.kind("integer")),
        meta: S.record({ direction: S.union([S.literal(str("fwd")), S.literal(str("inv"))]) }),
      }),
    },
  ];
  for (const c of cases) {
    test(`round-trip: ${c.name}`, () => {
      const wire = encodeSchema(c.s);
      const back = decodeSchema(wire);
      // Re-encode and compare canonical bytes — structural identity at the
      // wire level is exactly what we need (the SchemaNode structures
      // themselves contain Sets which don't compare cleanly with toEqual).
      expect(canonicalize(encodeSchema(back))).toBe(canonicalize(wire));
    });
  }
});

describe("encodeSchema is deterministic", () => {
  test("the same schema canonicalises to the same bytes", () => {
    const s1 = S.record({ a: S.kind("integer"), b: S.kind("string") });
    const s2 = S.record({ b: S.kind("string"), a: S.kind("integer") });
    expect(canonicalize(encodeSchema(s1))).toBe(canonicalize(encodeSchema(s2)));
  });
  test("optional set order does not affect canonical bytes", () => {
    const s1 = S.record(
      { a: S.kind("integer"), b: S.kind("string"), c: S.kind("boolean") },
      { optional: ["c", "a"] }
    );
    const s2 = S.record(
      { a: S.kind("integer"), b: S.kind("string"), c: S.kind("boolean") },
      { optional: ["a", "c"] }
    );
    expect(canonicalize(encodeSchema(s1))).toBe(canonicalize(encodeSchema(s2)));
  });
});

describe("wire compatibility with kindOf()", () => {
  test("S.kind('integer') encodes to the same Value as kindOf('integer')", () => {
    expect(canonicalize(encodeSchema(S.kind("integer")))).toBe(canonicalize(kindOf("integer")));
  });
  test("S.kind('string') encodes to the same Value as kindOf('string')", () => {
    expect(canonicalize(encodeSchema(S.kind("string")))).toBe(canonicalize(kindOf("string")));
  });
});

describe("malformed wire values", () => {
  test("non-tagged input throws", () => {
    expect(() => decodeSchema(int(0n))).toThrow();
  });
  test("unknown tag throws", () => {
    expect(() => decodeSchema(tagged("schema/wat", sym("x")))).toThrow();
  });
  test("kind tag with non-symbol payload throws", () => {
    expect(() => decodeSchema(tagged("schema/kind", str("integer")))).toThrow();
  });
  test("kind tag with bogus kind name throws", () => {
    expect(() => decodeSchema(tagged("schema/kind", sym("not-a-kind")))).toThrow();
  });
});

// ── top-level helpers (registry-search building blocks) ─────────────────────

describe("schemaTopKind", () => {
  test("returns the leaf kind for kind schemas", () => {
    expect(schemaTopKind(S.kind("integer"))).toBe("integer");
    expect(schemaTopKind(S.kind("string"))).toBe("string");
  });
  test("returns the structural kind for structural schemas", () => {
    expect(schemaTopKind(S.list(S.kind("integer")))).toBe("list");
    expect(schemaTopKind(S.tuple([S.kind("integer")]))).toBe("list");
    expect(schemaTopKind(S.record({}))).toBe("record");
    expect(schemaTopKind(S.expression("+"))).toBe("expression");
    expect(schemaTopKind(S.tagged("t", S.kind("integer")))).toBe("tagged");
  });
  test("literal returns the literal's kind", () => {
    expect(schemaTopKind(S.literal(str("forward")))).toBe("string");
  });
  test("any returns null", () => {
    expect(schemaTopKind(S.any())).toBeNull();
  });
  test("union returns common kind, else null", () => {
    expect(schemaTopKind(S.union([S.literal(str("a")), S.literal(str("b"))]))).toBe("string");
    expect(schemaTopKind(S.union([S.kind("integer"), S.kind("string")]))).toBeNull();
  });
});

describe("schemaMentionsKind", () => {
  test("walks records and lists", () => {
    const sch = S.record({ x: S.list(S.kind("integer")), y: S.kind("string") });
    expect(schemaMentionsKind(sch, "integer")).toBe(true);
    expect(schemaMentionsKind(sch, "string")).toBe(true);
    expect(schemaMentionsKind(sch, "boolean")).toBe(false);
  });
  test("walks expression args", () => {
    const sch = S.expression("+", [S.kind("integer"), S.kind("symbol")]);
    expect(schemaMentionsKind(sch, "symbol")).toBe(true);
  });
  test("walks tagged payload and union alts", () => {
    expect(schemaMentionsKind(S.tagged("t", S.kind("rational")), "rational")).toBe(true);
    expect(schemaMentionsKind(S.union([S.kind("integer"), S.kind("string")]), "string")).toBe(true);
  });
  test("any never mentions a specific kind", () => {
    expect(schemaMentionsKind(S.any(), "integer")).toBe(false);
  });
});

describe("schemaExpressionHead", () => {
  test("returns head when the schema is an expression with a fixed head", () => {
    expect(schemaExpressionHead(S.expression("+"))).toBe("+");
  });
  test("returns null for any other shape", () => {
    expect(schemaExpressionHead(S.kind("integer"))).toBeNull();
    expect(schemaExpressionHead(S.expression())).toBeNull();
    expect(schemaExpressionHead(S.record({}))).toBeNull();
  });
});

// ── path tracking happy-path allocation ─────────────────────────────────────

describe("validate happy path", () => {
  test("returns the singleton ok object (no fresh allocation per success)", () => {
    const sch = S.record({ a: S.list(S.kind("integer")) });
    const v = record({ a: list([int(1n), int(2n), int(3n)]) });
    const r1 = validate(v, sch);
    const r2 = validate(v, sch);
    expect(r1).toBe(r2);
  });
});

// ── ergonomic constructors are not silently wrong ───────────────────────────

describe("constructor ergonomics", () => {
  test("S.literal accepts every Value variant", () => {
    expect(validate(rat(3n, 4n), S.literal(rat(3n, 4n))).ok).toBe(true);
    expect(validate(bool(true), S.literal(bool(true))).ok).toBe(true);
  });
  test("S.record({}) is a valid empty-record schema", () => {
    expect(validate(record({}), S.record({})).ok).toBe(true);
    const r = validate(record({ extra: int(0n) }), S.record({}));
    expect(r.ok).toBe(false);
  });
  test("S.tuple([]) is a valid empty-tuple schema", () => {
    expect(validate(list([]), S.tuple([])).ok).toBe(true);
    expect(validate(list([int(0n)]), S.tuple([])).ok).toBe(false);
  });
});
