// Tests for @workbench/json-bridge.
//
// Coverage axes:
//   - leaf-kind parsing (integer, rational, float64, string, boolean, symbol)
//   - structural parsing (list, record)
//   - reverse direction (canonicalToJson) under every encoding option
//   - round-trip identity at the value-level (back-translation reproduces the
//     original canonical value, modulo the chosen encoding for integers)
//   - error paths (malformed JSON, missing hinted fields, kind mismatches)

import { describe, expect, test } from "bun:test";
import { canonicalize, int, kindOf, list, parse, rat, record, str, tagged } from "@workbench/protocol";
import { canonicalToJson, jsonToCanonical, JsonBridgeError } from "../src/index.js";

// ── leaf-kind parsing ──────────────────────────────────────────────────────

describe("jsonToCanonical: integer leaves", () => {
  test("JSON number → integer", () => {
    expect(jsonToCanonical(7, kindOf("integer"))).toEqual(int(7n));
    expect(jsonToCanonical(0, kindOf("integer"))).toEqual(int(0n));
    expect(jsonToCanonical(-42, kindOf("integer"))).toEqual(int(-42n));
  });

  test("JSON decimal-string → integer (handles values past 2^53)", () => {
    expect(jsonToCanonical("998244353", kindOf("integer"))).toEqual(int(998244353n));
    expect(jsonToCanonical("123456789012345678901234567890", kindOf("integer"))).toEqual(
      int(123456789012345678901234567890n)
    );
    expect(jsonToCanonical("-7", kindOf("integer"))).toEqual(int(-7n));
  });

  test("rejects non-integer number", () => {
    expect(() => jsonToCanonical(1.5, kindOf("integer"))).toThrow();
  });

  test("rejects malformed string", () => {
    expect(() => jsonToCanonical("abc", kindOf("integer"))).toThrow();
  });

  test("rejects null/undefined/array/object", () => {
    expect(() => jsonToCanonical(null, kindOf("integer"))).toThrow();
    expect(() => jsonToCanonical([1], kindOf("integer"))).toThrow();
    expect(() => jsonToCanonical({}, kindOf("integer"))).toThrow();
  });
});

describe("jsonToCanonical: string / boolean / symbol leaves", () => {
  test("string leaf", () => {
    expect(jsonToCanonical("forward", kindOf("string"))).toEqual(str("forward"));
  });
  test("boolean leaf", () => {
    expect(jsonToCanonical(true, kindOf("boolean"))).toEqual({ kind: "boolean", value: true });
    expect(jsonToCanonical(false, kindOf("boolean"))).toEqual({ kind: "boolean", value: false });
  });
  test("symbol leaf (string becomes symbol name)", () => {
    expect(jsonToCanonical("x", kindOf("symbol"))).toEqual({ kind: "symbol", name: "x" });
  });
  test("kind mismatches throw", () => {
    expect(() => jsonToCanonical(42, kindOf("string"))).toThrow();
    expect(() => jsonToCanonical("yes", kindOf("boolean"))).toThrow();
  });
});

describe("jsonToCanonical: rational leaves", () => {
  test("fraction object", () => {
    expect(jsonToCanonical({ num: "3", den: "4" }, kindOf("rational"))).toEqual(rat(3n, 4n));
  });
  test("slash string", () => {
    expect(jsonToCanonical("3/4", kindOf("rational"))).toEqual(rat(3n, 4n));
  });
  test("integer-as-rational", () => {
    expect(jsonToCanonical("7", kindOf("rational"))).toEqual(rat(7n, 1n));
    expect(jsonToCanonical(7, kindOf("rational"))).toEqual(rat(7n, 1n));
  });
});

describe("jsonToCanonical: float64 leaves", () => {
  test("JSON number → float64 bits", () => {
    const v = jsonToCanonical(1.5, kindOf("float64"));
    if (v.kind !== "float64") throw new Error("expected float64");
    expect(v.bits).toBe("3ff8000000000000");
  });
  test("16-hex string passes through as bits", () => {
    const v = jsonToCanonical("3ff8000000000000", kindOf("float64"));
    if (v.kind !== "float64") throw new Error("expected float64");
    expect(v.bits).toBe("3ff8000000000000");
  });
  test("non-numeric, non-hex throws", () => {
    expect(() => jsonToCanonical("not-hex", kindOf("float64"))).toThrow();
  });
});

// ── structural ─────────────────────────────────────────────────────────────

describe("jsonToCanonical: list", () => {
  test("list of integers", () => {
    const out = jsonToCanonical(["1", "2", "3"], list([kindOf("integer")]));
    expect(out).toEqual(list([int(1n), int(2n), int(3n)]));
  });
  test("empty list", () => {
    expect(jsonToCanonical([], list([kindOf("integer")]))).toEqual(list([]));
  });
  test("list of strings", () => {
    expect(jsonToCanonical(["a", "b"], list([kindOf("string")]))).toEqual(list([str("a"), str("b")]));
  });
  test("rejects non-array", () => {
    expect(() => jsonToCanonical({}, list([kindOf("integer")]))).toThrow();
  });
  test("hint with multiple element-hints throws", () => {
    expect(() => jsonToCanonical([1], list([kindOf("integer"), kindOf("string")]))).toThrow();
  });
});

describe("jsonToCanonical: record", () => {
  test("flat record with mixed kinds (the tournament NTT shape)", () => {
    const hint = record({
      n: kindOf("integer"),
      modulus: kindOf("integer"),
      direction: kindOf("string"),
      x: list([kindOf("integer")]),
    });
    const j = { n: 4, modulus: "998244353", direction: "forward", x: ["1", "0", "0", "0"] };
    const out = jsonToCanonical(j, hint);
    const expected = record({
      direction: str("forward"),
      modulus: int(998244353n),
      n: int(4n),
      x: list([int(1n), int(0n), int(0n), int(0n)]),
    });
    expect(canonicalize(out)).toBe(canonicalize(expected));
  });

  test("missing hinted field throws", () => {
    const hint = record({ a: kindOf("integer"), b: kindOf("string") });
    expect(() => jsonToCanonical({ a: 1 }, hint)).toThrow();
  });

  test("extras silently dropped", () => {
    const hint = record({ a: kindOf("integer") });
    const out = jsonToCanonical({ a: 1, extra: "ignored" }, hint);
    expect(out).toEqual(record({ a: int(1n) }));
  });

  test("error path includes the offending dotted path", () => {
    const hint = record({ outer: record({ inner: list([kindOf("integer")]) }) });
    try {
      jsonToCanonical({ outer: { inner: ["1", "abc"] } }, hint);
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(JsonBridgeError);
      expect((e as JsonBridgeError).path).toBe("$.outer.inner.1");
    }
  });
});

// ── reverse direction ──────────────────────────────────────────────────────

describe("canonicalToJson", () => {
  test("integer 'smart' encoding: small as number, big as string", () => {
    expect(canonicalToJson(int(7n))).toBe(7);
    expect(canonicalToJson(int(998244353n))).toBe(998244353);
    expect(canonicalToJson(int(123456789012345678901234567890n))).toBe("123456789012345678901234567890");
  });
  test("integer 'string' encoding always string", () => {
    expect(canonicalToJson(int(7n), { integerEncoding: "string" })).toBe("7");
    expect(canonicalToJson(int(0n), { integerEncoding: "string" })).toBe("0");
  });
  test("integer 'number' encoding throws on overflow", () => {
    expect(() =>
      canonicalToJson(int(123456789012345678901234567890n), { integerEncoding: "number" })
    ).toThrow();
  });

  test("rational 'fraction' (default) and 'slash' encodings", () => {
    expect(canonicalToJson(rat(3n, 4n))).toEqual({ num: "3", den: "4" });
    expect(canonicalToJson(rat(3n, 4n), { rationalEncoding: "slash" })).toBe("3/4");
  });

  test("list, record, primitives", () => {
    expect(canonicalToJson(list([int(1n), str("a")]))).toEqual([1, "a"]);
    expect(canonicalToJson(record({ x: int(1n), y: str("a") }))).toEqual({ x: 1, y: "a" });
    expect(canonicalToJson({ kind: "boolean", value: true })).toBe(true);
  });

  test("tagged emits structural form", () => {
    const v = tagged("foo/bar", int(7n));
    expect(canonicalToJson(v, { integerEncoding: "string" })).toEqual({
      kind: "tagged",
      tag: "foo/bar",
      payload: "7",
    });
  });
});

// ── round-trip ─────────────────────────────────────────────────────────────

describe("round-trip", () => {
  test("the tournament NTT input shape round-trips with integerEncoding=string", () => {
    const hint = record({
      direction: kindOf("string"),
      modulus: kindOf("integer"),
      n: kindOf("integer"),
      primitive_root: kindOf("integer"),
      x: list([kindOf("integer")]),
    });
    const tournament = {
      n: 4,
      modulus: "998244353",
      primitive_root: "3",
      direction: "forward",
      x: ["1", "0", "0", "0"],
    };
    const canonical = jsonToCanonical(tournament, hint);
    // Forward → canonical is unambiguous.
    expect(canonical).toEqual(record({
      direction: str("forward"),
      modulus: int(998244353n),
      n: int(4n),
      primitive_root: int(3n),
      x: list([int(1n), int(0n), int(0n), int(0n)]),
    }));
    // Round-trip back with integerEncoding="string" reproduces the
    // tournament's exact JSON shape (modulo n which the tournament emits
    // as a JSON number, not a string — that's the "smart" axis).
    const back = canonicalToJson(canonical, { integerEncoding: "string" });
    expect(back).toEqual({
      direction: "forward",
      modulus: "998244353",
      n: "4",                                    // string under "string" mode
      primitive_root: "3",
      x: ["1", "0", "0", "0"],
    });
  });

  test("canonicalize(jsonToCanonical(json, hint)) is deterministic", () => {
    // Two canonicalizations of the same parse must produce identical bytes.
    const hint = record({ a: kindOf("integer"), b: list([kindOf("integer")]) });
    const j = { a: 7, b: [1, 2, 3] };
    const out1 = canonicalize(jsonToCanonical(j, hint));
    const out2 = canonicalize(jsonToCanonical(j, hint));
    expect(out1).toBe(out2);
    // And it parses back as a Value.
    const v = parse(out1);
    expect(v.kind).toBe("record");
  });
});

// -----------------------------------------------------------------------------
// Numerical-tier ergonomic helpers (bead `qiv8`)
// -----------------------------------------------------------------------------
//
// `matrixToValue` / `vectorToValue` / `valueToMatrix` / `valueToVector` —
// the boilerplate-deleters. The tests cover three properties:
//
//   1. Round-trip identity: `valueTo*(matrixTo*Value(M))` reproduces `M`
//      bit-for-bit (modulo IEEE-754 NaN, which is excluded).
//   2. Type-narrowness: the return type of `matrixToValue` is
//      `ListValueOf<ListValueOf<Float64Value>>` so the call site doesn't
//      need an `as never` cast — pinned via a static type-level test.
//   3. Honest refusal: shape mismatches and non-rectangular inputs raise
//      `JsonBridgeError` with a path pointing at the offending position.

import {
  matrixToValue,
  vectorToValue,
  valueToMatrix,
  valueToVector,
} from "../src/index.js";
import {
  float64FromNumber,
  type Float64Value,
  type ListValueOf,
  type Value,
} from "@workbench/protocol";

describe("vectorToValue / valueToVector — round-trip and refusal", () => {
  test("round-trip: [1, 2.5, -3.14, 0] survives", () => {
    const v = [1, 2.5, -3.14, 0];
    expect(valueToVector(vectorToValue(v))).toEqual(v);
  });

  test("round-trip: empty vector survives", () => {
    expect(valueToVector(vectorToValue([]))).toEqual([]);
  });

  test("round-trip: ±Infinity and subnormal values survive (IEEE-754 bit-exact)", () => {
    const v = [Infinity, -Infinity, Number.MIN_VALUE, -Number.MIN_VALUE, 0, -0];
    expect(valueToVector(vectorToValue(v))).toEqual(v);
  });

  test("vectorToValue: return is canonical {kind:'list', items: Float64Value[]}", () => {
    const out = vectorToValue([1, 2]);
    expect(out.kind).toBe("list");
    expect(out.items.length).toBe(2);
    expect(out.items[0]!.kind).toBe("float64");
    expect(out.items[1]!.kind).toBe("float64");
  });

  test("valueToVector: rejects non-list with JsonBridgeError", () => {
    expect(() => valueToVector(float64FromNumber(1))).toThrow(JsonBridgeError);
    expect(() => valueToVector(int(1n))).toThrow(/expected list/);
  });

  test("valueToVector: rejects list with non-float64 element, names position", () => {
    const bad: Value = { kind: "list", items: [float64FromNumber(1), int(2n)] };
    expect(() => valueToVector(bad)).toThrow(/element 1.*float64/);
    expect(() => valueToVector(bad)).toThrow(/\$\[1\]/);
  });
});

describe("matrixToValue / valueToMatrix — round-trip and refusal", () => {
  test("round-trip: 2x3 matrix survives", () => {
    const M = [
      [1, 2, 3],
      [4, 5, 6],
    ];
    expect(valueToMatrix(matrixToValue(M))).toEqual(M);
  });

  test("round-trip: 5x5 identity survives", () => {
    const I = Array.from({ length: 5 }, (_, i) =>
      Array.from({ length: 5 }, (_, j) => (i === j ? 1 : 0)),
    );
    expect(valueToMatrix(matrixToValue(I))).toEqual(I);
  });

  test("round-trip: empty matrix []", () => {
    expect(valueToMatrix(matrixToValue([]))).toEqual([]);
  });

  test("matrixToValue: rejects non-rectangular input with named row", () => {
    const bad = [
      [1, 2, 3],
      [4, 5],  // row 1 ragged
    ];
    expect(() => matrixToValue(bad)).toThrow(JsonBridgeError);
    expect(() => matrixToValue(bad)).toThrow(/row 1.*length 2.*expected 3/);
    expect(() => matrixToValue(bad)).toThrow(/\$\[1\]/);
  });

  test("valueToMatrix: rejects non-list at top level", () => {
    expect(() => valueToMatrix(float64FromNumber(1))).toThrow(/expected list/);
  });

  test("valueToMatrix: rejects when a row is not a list", () => {
    const bad: Value = {
      kind: "list",
      items: [
        { kind: "list", items: [float64FromNumber(1)] },
        float64FromNumber(2), // row 1 is a leaf, not a row
      ],
    };
    expect(() => valueToMatrix(bad)).toThrow(/row 1.*float64.*expected list/);
  });

  test("valueToMatrix: rejects non-rectangular value, names row", () => {
    const bad: Value = {
      kind: "list",
      items: [
        { kind: "list", items: [float64FromNumber(1), float64FromNumber(2)] },
        { kind: "list", items: [float64FromNumber(3)] }, // wrong length
      ],
    };
    expect(() => valueToMatrix(bad)).toThrow(/row 1.*length 1.*expected 2/);
  });

  test("valueToMatrix: rejects non-float64 cell, names [i][j] position", () => {
    const bad: Value = {
      kind: "list",
      items: [
        { kind: "list", items: [float64FromNumber(1), int(2n)] },
      ],
    };
    expect(() => valueToMatrix(bad)).toThrow(/\[0\]\[1\].*integer.*float64/);
  });
});

describe("type-level: helper returns narrow to ListValueOf<...>", () => {
  // Bead `qiv8`: the whole point of the helpers is to remove `as never`
  // casts at the typed-barrel boundary. That requires the return type
  // to be the *narrow* `ListValueOf<Float64Value>` /
  // `ListValueOf<ListValueOf<Float64Value>>`, not the loose `Value` or
  // `ListValue`. A regression to a wider return type would re-introduce
  // the cast and the `extends` assertions below go RED at compile time.
  test("vectorToValue returns ListValueOf<Float64Value>", () => {
    type _ok = ReturnType<typeof vectorToValue> extends ListValueOf<Float64Value>
      ? true
      : "WIDENED RETURN TYPE";
    const _check: _ok = true;
    void _check;
    expect(true).toBe(true);
  });

  test("matrixToValue returns ListValueOf<ListValueOf<Float64Value>>", () => {
    type _ok = ReturnType<typeof matrixToValue> extends ListValueOf<ListValueOf<Float64Value>>
      ? true
      : "WIDENED RETURN TYPE";
    const _check: _ok = true;
    void _check;
    expect(true).toBe(true);
  });

  test("cast-free composition: matrixToValue feeds a list<list<float64>> slot", () => {
    // Synthetic call site mirroring the typed-barrel boundary:
    // `expectMatrix` requires `ListValueOf<ListValueOf<Float64Value>>`.
    // Pre-`qiv8`, callers built the value inline with `list(M.map(row =>
    // list(row.map(float64FromNumber))))` — a `Value` — and had to cast
    // `as never` here. Post-`qiv8`, `matrixToValue(M)` typechecks
    // directly.
    const expectMatrix = (m: ListValueOf<ListValueOf<Float64Value>>): number =>
      m.items.length;
    const n = expectMatrix(matrixToValue([[1, 2], [3, 4]]));
    expect(n).toBe(2);
  });
});
