// Round-trip + hash + canonicalisation property tests for the value protocol.
// 1000 random trials per property; the generator covers all 10 kinds.

import { describe, expect, test } from "bun:test";
import {
  bool,
  canonicalize,
  encodeString,
  expr,
  float64FromNumber,
  float64ToNumber,
  hash,
  int,
  isKind,
  KINDS,
  list,
  parse,
  ProtocolError,
  rat,
  record,
  str,
  sym,
  tagged,
  validateValue,
  type Value,
} from "../src/index.js";

class RNG {
  private state: number;
  constructor(seed: number) {
    this.state = seed >>> 0;
  }
  // mulberry32
  next(): number {
    let t = (this.state += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  int(lo: number, hi: number): number {
    return lo + Math.floor(this.next() * (hi - lo + 1));
  }
  bool(): boolean {
    return this.next() < 0.5;
  }
  alphanum(minLen: number, maxLen: number): string {
    const n = this.int(minLen, maxLen);
    const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_";
    let s = "";
    for (let i = 0; i < n; i++) s += chars[this.int(0, chars.length - 1)];
    if (s.length === 0) s = "x";
    if (/^[0-9]/.test(s)) s = "x" + s.slice(1);
    return s;
  }
  string(minLen: number, maxLen: number): string {
    const n = this.int(minLen, maxLen);
    let s = "";
    for (let i = 0; i < n; i++) {
      const r = this.next();
      if (r < 0.05) s += "\n";
      else if (r < 0.1) s += "\\";
      else if (r < 0.15) s += '"';
      else if (r < 0.2) s += "/";
      else if (r < 0.22) s += "";
      else if (r < 0.24) s += "\t";
      else if (r < 0.3) s += String.fromCharCode(this.int(0xa0, 0x07ff));
      else s += String.fromCharCode(this.int(0x20, 0x7e));
    }
    return s;
  }
  bigInt(): bigint {
    const sign = this.bool() ? 1n : -1n;
    const ndigits = this.int(1, 30);
    let s = "";
    s += String(this.int(1, 9));
    for (let i = 1; i < ndigits; i++) s += String(this.int(0, 9));
    return sign * BigInt(s);
  }
  nonZeroBigInt(): bigint {
    const v = this.bigInt();
    return v === 0n ? 1n : v;
  }
  float(): number {
    const r = this.next();
    if (r < 0.02) return Number.POSITIVE_INFINITY;
    if (r < 0.04) return Number.NEGATIVE_INFINITY;
    if (r < 0.05) return Number.NaN;
    if (r < 0.07) return 0;
    if (r < 0.09) return -0;
    return (this.next() - 0.5) * 1e6;
  }
}

function times<T>(n: number, f: () => T): T[] {
  const out: T[] = [];
  for (let i = 0; i < n; i++) out.push(f());
  return out;
}

function randomValue(rng: RNG, depth: number): Value {
  if (depth >= 4) return randomLeaf(rng);
  const choice = rng.int(0, 9);
  switch (choice) {
    case 0:
      return sym(rng.alphanum(1, 6), rng.bool() ? rng.alphanum(1, 6) : undefined);
    case 1:
      return str(rng.string(0, 20));
    case 2:
      return int(rng.bigInt());
    case 3:
      return rat(rng.bigInt(), rng.nonZeroBigInt());
    case 4:
      return float64FromNumber(rng.float());
    case 5:
      return bool(rng.bool());
    case 6:
      return list(times(rng.int(0, 4), () => randomValue(rng, depth + 1)));
    case 7: {
      const fields: Record<string, Value> = {};
      const n = rng.int(0, 4);
      for (let i = 0; i < n; i++) fields[rng.alphanum(1, 8)] = randomValue(rng, depth + 1);
      return record(fields);
    }
    case 8:
      return expr(
        rng.alphanum(1, 6),
        times(rng.int(0, 4), () => randomValue(rng, depth + 1))
      );
    case 9:
      return tagged(rng.alphanum(1, 6), randomValue(rng, depth + 1));
    default:
      return bool(false);
  }
}

function randomLeaf(rng: RNG): Value {
  const c = rng.int(0, 5);
  switch (c) {
    case 0:
      return sym(rng.alphanum(1, 6));
    case 1:
      return str(rng.string(0, 12));
    case 2:
      return int(rng.bigInt());
    case 3:
      return rat(rng.bigInt(), rng.nonZeroBigInt());
    case 4:
      return float64FromNumber(rng.float());
    default:
      return bool(rng.bool());
  }
}

describe("kinds", () => {
  test("KINDS lists exactly 10 kinds", () => {
    expect(KINDS.length).toBe(10);
  });

  test("isKind accepts each declared kind", () => {
    for (const k of KINDS) expect(isKind(k)).toBe(true);
  });

  test("isKind rejects unknown strings", () => {
    expect(isKind("not-a-kind")).toBe(false);
    expect(isKind("")).toBe(false);
    expect(isKind(42)).toBe(false);
  });
});

describe("constructors", () => {
  test("rat normalises sign and reduces to lowest terms", () => {
    expect(rat(2n, 4n)).toEqual({ kind: "rational", num: "1", den: "2" });
    expect(rat(-2n, 4n)).toEqual({ kind: "rational", num: "-1", den: "2" });
    expect(rat(2n, -4n)).toEqual({ kind: "rational", num: "-1", den: "2" });
    expect(rat(-2n, -4n)).toEqual({ kind: "rational", num: "1", den: "2" });
    expect(rat(0n, 5n)).toEqual({ kind: "rational", num: "0", den: "1" });
  });

  test("rat rejects zero denominator", () => {
    expect(() => rat(1n, 0n)).toThrow(ProtocolError);
  });

  test("int rejects non-canonical strings", () => {
    expect(() => int("01")).toThrow(ProtocolError);
    expect(() => int("00")).toThrow(ProtocolError);
    expect(() => int("+1")).toThrow(ProtocolError);
    expect(() => int("--1")).toThrow(ProtocolError);
    expect(() => int("")).toThrow(ProtocolError);
  });

  test("int accepts bigints, numbers, canonical strings", () => {
    expect(int(0n).value).toBe("0");
    expect(int(-1).value).toBe("-1");
    expect(int("123456789012345678901234567890").value).toBe("123456789012345678901234567890");
  });

  test("float64FromNumber/float64ToNumber round-trip", () => {
    for (const x of [0, -0, 1, -1, 3.14, 1e308, -1e308, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const v = float64FromNumber(x);
      expect(float64ToNumber(v)).toBe(x);
    }
    const nan = float64FromNumber(Number.NaN);
    expect(Number.isNaN(float64ToNumber(nan))).toBe(true);
  });
});

describe("canonical encoding", () => {
  test("string encoder never escapes forward slash", () => {
    expect(encodeString("/path/to/x")).toBe('"/path/to/x"');
  });

  test("string encoder escapes control chars as \\u00xx", () => {
    expect(encodeString("")).toBe('"\\u0001"');
    expect(encodeString("")).toBe('"\\u001f"');
  });

  test("string encoder escapes quote, backslash, BS, FF, CR, LF, TAB", () => {
    expect(encodeString('"')).toBe('"\\""');
    expect(encodeString("\\")).toBe('"\\\\"');
    expect(encodeString("\b")).toBe('"\\b"');
    expect(encodeString("\t")).toBe('"\\t"');
    expect(encodeString("\n")).toBe('"\\n"');
    expect(encodeString("\f")).toBe('"\\f"');
    expect(encodeString("\r")).toBe('"\\r"');
  });

  test("keys come out sorted lexicographically (UTF-16 code units)", () => {
    const v = expr("f", [sym("z"), sym("a")]);
    const c = canonicalize(v);
    expect(c).toBe(
      '{"args":[{"kind":"symbol","name":"z"},{"kind":"symbol","name":"a"}],"head":"f","kind":"expression"}'
    );
  });

  test("no whitespace anywhere", () => {
    const c = canonicalize(record({ a: int(1n), b: list([sym("x")]) }));
    expect(c).not.toMatch(/[\s]/);
  });

  test("rejects raw numbers in canonicalize via parse path", () => {
    expect(() => parse('{"kind":"integer","value":1}')).toThrow(ProtocolError);
  });

  test("rejects null", () => {
    expect(() => parse("null")).toThrow(ProtocolError);
  });

  test("rejects unknown kinds", () => {
    expect(() => parse('{"kind":"complex","value":"1+2i"}')).toThrow(ProtocolError);
  });

  test("rejects unexpected fields", () => {
    expect(() => parse('{"kind":"symbol","name":"x","extra":"oops"}')).toThrow(ProtocolError);
  });

  test("rejects rational with non-positive denominator", () => {
    expect(() => parse('{"kind":"rational","num":"1","den":"0"}')).toThrow(ProtocolError);
    expect(() => parse('{"kind":"rational","num":"1","den":"-2"}')).toThrow(ProtocolError);
  });

  test("rejects rational not in lowest terms", () => {
    expect(() => parse('{"kind":"rational","num":"2","den":"4"}')).toThrow(ProtocolError);
  });
});

describe("parse / validate", () => {
  test("validateValue returns a structurally-equal copy", () => {
    const v = expr("plus", [int(1n), sym("x")]);
    expect(validateValue(JSON.parse(JSON.stringify(v)))).toEqual(v);
  });

  test("parse handles records with reordered keys", () => {
    const v = parse('{"name":"x","kind":"symbol"}');
    expect(v).toEqual(sym("x"));
  });
});

describe("hash", () => {
  test("hash is 64 hex chars", () => {
    const h = hash(sym("x"));
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  test("equal values → equal hash", () => {
    const a = expr("plus", [sym("x"), int(1n)]);
    const b = expr("plus", [sym("x"), int(1n)]);
    expect(hash(a)).toBe(hash(b));
  });

  test("different values → different hash", () => {
    expect(hash(sym("x"))).not.toBe(hash(sym("y")));
    expect(hash(int(1n))).not.toBe(hash(int(2n)));
  });

  test("hash invariant under key reordering on input JSON", () => {
    const a = parse('{"kind":"symbol","name":"x","namespace":"a"}');
    const b = parse('{"namespace":"a","name":"x","kind":"symbol"}');
    expect(hash(a)).toBe(hash(b));
  });
});

describe("property: round-trip", () => {
  test("parse(canonicalize(v)) ≡ v over 1000 random trials", () => {
    const rng = new RNG(0xdeadbeef);
    for (let i = 0; i < 1000; i++) {
      const v = randomValue(rng, 0);
      const s = canonicalize(v);
      const back = parse(s);
      expect(back).toEqual(v);
    }
  });

  test("canonicalize is idempotent through parse over 1000 random trials", () => {
    const rng = new RNG(0xc0ffee);
    for (let i = 0; i < 1000; i++) {
      const v = randomValue(rng, 0);
      const s1 = canonicalize(v);
      const s2 = canonicalize(parse(s1));
      expect(s2).toBe(s1);
    }
  });

  test("hash determinism: 1000 random values rebuilt deeply yield identical hashes", () => {
    const rng = new RNG(0x12345);
    for (let i = 0; i < 1000; i++) {
      const v = randomValue(rng, 0);
      const a = hash(v);
      const b = hash(parse(canonicalize(v)));
      expect(a).toBe(b);
    }
  });
});
