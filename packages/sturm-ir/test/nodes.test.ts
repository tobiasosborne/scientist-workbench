// nodes.test.ts — round-trip encode/decode, builder defaults, decoder error paths.
//
// These tests live close to the typed-vs-encoded boundary the
// `nodes.ts` module manages. We assert that:
//   1. Every builder produces a typed Op whose `encode → decode`
//      round-trip yields a structurally equal Op.
//   2. The Bell, GHZ, and phase-kickback example IRs from ADR-0006
//      round-trip through `encodeChannel` / `decodeChannel`.
//   3. Decoding malformed Values throws `ProtocolError` with a path
//      message naming the offending location.

import { describe, expect, test } from "bun:test";
import {
  ProtocolError,
  canonicalize,
  expr,
  int,
  list,
  rat,
  record,
  str,
  sym,
  type Value,
} from "@workbench/protocol";
import {
  channel,
  decodeChannel,
  decodeOp,
  decodeWire,
  discardOp,
  encodeChannel,
  encodeOp,
  encodeWire,
  observeOp,
  oracleOp,
  prepareOp,
  ryOp,
  rzOp,
  casesOp,
  wire,
  type Channel,
  type Op,
} from "../src/index.js";

const W0 = wire(0n, "quantum", "qubit");
const W1 = wire(1n, "quantum", "qubit");
const W2 = wire(2n, "quantum", "qubit");

describe("Wire builder + encode/decode", () => {
  test("dim defaults to undefined when omitted", () => {
    const w = wire(7n, "quantum");
    expect(w.dim).toBeUndefined();
    const v = encodeWire(w);
    expect(v.fields["dim"]).toBeUndefined();
    const back = decodeWire(v);
    expect(back).toEqual(w);
  });

  test("dim is preserved when supplied", () => {
    const w = wire(7n, "quantum", "qubit");
    const back = decodeWire(encodeWire(w));
    expect(back).toEqual(w);
  });

  test("classical kind round-trips", () => {
    const w = wire(3n, "classical");
    expect(decodeWire(encodeWire(w))).toEqual(w);
  });

  test("decode rejects extra fields", () => {
    const bad = record({
      id: int(0n),
      kind: str("quantum"),
      dim: str("qubit"),
      bogus: str("nope"),
    });
    expect(() => decodeWire(bad)).toThrow(ProtocolError);
  });

  test("decode rejects unknown kind string", () => {
    const bad = record({ id: int(0n), kind: str("classocal") });
    expect(() => decodeWire(bad)).toThrow(/wire.kind/);
  });

  test("decode rejects unknown dim string", () => {
    const bad = record({
      id: int(0n),
      kind: str("quantum"),
      dim: str("photon"),
    });
    expect(() => decodeWire(bad)).toThrow(/wire.dim/);
  });
});

describe("Op builders + encode/decode round-trip", () => {
  const cases: ReadonlyArray<readonly [string, Op]> = [
    ["prepare", prepareOp(rat(1n, 2n), 0n)],
    ["ry unconditional", ryOp(0n, sym("π"), [])],
    ["ry controlled", ryOp(1n, expr("/", [sym("π"), int(2n)]), [0n, 2n])],
    ["rz controlled", rzOp(2n, sym("π"), [0n])],
    ["observe", observeOp(0n, "out_bit_0")],
    ["oracle", oracleOp(sym("placeholder"), [0n, 1n], [2n])],
    [
      "cases",
      casesOp(
        "out_bit_0",
        [ryOp(1n, sym("π"), [])],
        [ryOp(1n, expr("-", [sym("π")]), [])]
      ),
    ],
    ["discard", discardOp(0n)],
  ];

  for (const [name, op] of cases) {
    test(`${name} round-trips`, () => {
      const v = encodeOp(op);
      expect(v.kind).toBe("expression");
      const back = decodeOp(v);
      expect(back).toEqual(op);
    });
  }

  test("ryOp default controls is empty", () => {
    const op = ryOp(0n, sym("π"));
    expect(op.controls).toEqual([]);
  });

  test("decodeOp rejects unknown head", () => {
    const bad = expr("cnot", [int(0n), int(1n)]);
    expect(() => decodeOp(bad)).toThrow(/unknown op head/);
  });

  test("decodeOp rejects wrong arity", () => {
    const bad = expr("prepare", [rat(1n, 2n)]); // missing wire id
    expect(() => decodeOp(bad)).toThrow(/expected 2 args/);
  });

  test("decodeOp rejects non-expression", () => {
    expect(() => decodeOp(int(0n))).toThrow(/expected expression op/);
  });
});

describe("Channel encode/decode — Bell, GHZ, kickback round-trips", () => {
  function bellChannel(): Channel {
    return channel(
      [],
      [W0, W1],
      [
        prepareOp(rat(0n, 1n), 0n),
        prepareOp(rat(0n, 1n), 1n),
        ryOp(0n, expr("/", [sym("π"), int(2n)]), []),
        ryOp(1n, sym("π"), [0n]),
      ]
    );
  }

  function ghzChannel(): Channel {
    return channel(
      [],
      [W0, W1, W2],
      [
        prepareOp(rat(0n, 1n), 0n),
        prepareOp(rat(0n, 1n), 1n),
        prepareOp(rat(0n, 1n), 2n),
        ryOp(0n, expr("/", [sym("π"), int(2n)]), []),
        ryOp(1n, sym("π"), [0n]),
        ryOp(2n, sym("π"), [0n]),
      ]
    );
  }

  function kickbackChannel(): Channel {
    // Simplified phase-kickback: prepare control in |+>, apply oracle
    // controlled by control, post-rotate, observe. Uses an opaque
    // placeholder for the oracle's circuit (a real one is produced by
    // sturm-bennett-oracle).
    const oracleCircuit: Value = sym("oracle-placeholder");
    return channel(
      [],
      [],
      [
        prepareOp(rat(0n, 1n), 0n),
        prepareOp(rat(0n, 1n), 1n),
        ryOp(0n, expr("/", [sym("π"), int(2n)]), []),
        oracleOp(oracleCircuit, [0n, 1n], [1n]),
        ryOp(0n, expr("-", [expr("/", [sym("π"), int(2n)])]), []),
        observeOp(0n, "phase_bit"),
        observeOp(1n, "target_bit"),
        discardOp(1n),
      ]
    );
    // (Note: observe removes wireId from scope; this body lists no
    // outputs, which is the channel "() → ()" terminating cleanly.)
  }

  for (const [name, build] of [
    ["bell", bellChannel],
    ["ghz", ghzChannel],
    ["kickback", kickbackChannel],
  ] as const) {
    test(`${name} round-trips`, () => {
      const c = build();
      const v = encodeChannel(c);
      expect(v.kind).toBe("expression");
      expect(v.head).toBe("channel");
      const back = decodeChannel(v);
      expect(back).toEqual(c);
    });

    test(`${name} canonicalises deterministically`, () => {
      const c = build();
      const a = canonicalize(encodeChannel(c));
      const b = canonicalize(encodeChannel(c));
      expect(a).toBe(b);
    });
  }
});

describe("Decoder paths report dotted locations", () => {
  test("malformed wire id surfaces with a path through the channel", () => {
    const bad = expr("channel", [
      list([
        record({ id: str("nope" /* should be integer */), kind: str("quantum") }),
      ]),
      list([]),
      list([]),
    ]);
    try {
      decodeChannel(bad);
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ProtocolError);
      expect((e as Error).message).toContain("$.args[0].0.id");
    }
  });

  test("malformed cases arm op surfaces a deep path", () => {
    const bad = expr("cases", [
      str("ref"),
      list([expr("nonsense", [])]),
      list([]),
    ]);
    try {
      decodeOp(bad);
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ProtocolError);
      expect((e as Error).message).toContain("args[1]");
    }
  });
});
