// schema.test.ts — value-level Schema validation for IR shapes.
//
// We exercise both the happy path (Bell / GHZ examples conform) and
// the structural rejections (a `cnot` op-node fails the closed
// op-head union; a wire with an unknown `dim` string is rejected).

import { describe, expect, test } from "bun:test";
import {
  expr,
  int,
  list,
  rat,
  record,
  str,
  sym,
  validate,
  type Value,
} from "@workbench/protocol";
import {
  channelSchema,
  encodeChannel,
  encodeOp,
  encodeWire,
  opSchema,
  prepareOp,
  ryOp,
  wire,
  wireSchema,
  channel,
} from "../src/index.js";

describe("wireSchema", () => {
  test("accepts a wire without dim", () => {
    const v = encodeWire(wire(0n, "quantum"));
    expect(validate(v, wireSchema).ok).toBe(true);
  });

  test("accepts a wire with dim qubit", () => {
    const v = encodeWire(wire(0n, "quantum", "qubit"));
    expect(validate(v, wireSchema).ok).toBe(true);
  });

  test("accepts each declared dim", () => {
    for (const dim of ["qubit", "qudit", "anyon", "boson"] as const) {
      const v = encodeWire(wire(0n, "quantum", dim));
      expect(validate(v, wireSchema).ok).toBe(true);
    }
  });

  test("rejects a wire with unknown dim", () => {
    const bad = record({
      id: int(0n),
      kind: str("quantum"),
      dim: str("photon"),
    });
    expect(validate(bad, wireSchema).ok).toBe(false);
  });

  test("rejects a wire with unknown kind", () => {
    const bad = record({ id: int(0n), kind: str("entangled") });
    expect(validate(bad, wireSchema).ok).toBe(false);
  });

  test("rejects extras", () => {
    const bad = record({
      id: int(0n),
      kind: str("quantum"),
      bogus: str("x"),
    });
    expect(validate(bad, wireSchema).ok).toBe(false);
  });
});

describe("opSchema", () => {
  test("accepts every op head with the right arity", () => {
    const ops = [
      encodeOp(prepareOp(rat(1n, 2n), 0n)),
      encodeOp(ryOp(0n, sym("π"), [])),
      encodeOp(ryOp(0n, sym("π"), [1n])),
    ];
    for (const v of ops) {
      const r = validate(v, opSchema);
      expect(r.ok).toBe(true);
    }
  });

  test("rejects an unknown op head — P5 enforced structurally", () => {
    const cnot = expr("cnot", [int(0n), int(1n)]);
    expect(validate(cnot, opSchema).ok).toBe(false);
  });

  test("rejects rotation with wrong arity", () => {
    const tooFew = expr("ry", [int(0n), sym("π")]); // missing controls
    expect(validate(tooFew, opSchema).ok).toBe(false);
  });

  test("rejects rotation whose controls list is not integers", () => {
    const bad = expr("ry", [int(0n), sym("π"), list([str("notanint")])]);
    expect(validate(bad, opSchema).ok).toBe(false);
  });

  test("cases arms validate as list-shaped (recursion delegated to decoder)", () => {
    const c = expr("cases", [str("ref"), list([]), list([])]);
    expect(validate(c, opSchema).ok).toBe(true);
  });

  test("oracle.circuit is opaque to the schema", () => {
    const o = expr("oracle", [sym("anything"), list([int(0n)]), list([int(1n)])]);
    expect(validate(o, opSchema).ok).toBe(true);
  });
});

describe("channelSchema", () => {
  function bellChannelValue(): Value {
    return encodeChannel(
      channel(
        [],
        [wire(0n, "quantum", "qubit"), wire(1n, "quantum", "qubit")],
        [
          prepareOp(rat(0n, 1n), 0n),
          prepareOp(rat(0n, 1n), 1n),
          ryOp(0n, expr("/", [sym("π"), int(2n)]), []),
          ryOp(1n, sym("π"), [0n]),
        ]
      )
    );
  }

  test("accepts the Bell-pair channel", () => {
    expect(validate(bellChannelValue(), channelSchema).ok).toBe(true);
  });

  test("rejects a body containing a gate-named op (cnot)", () => {
    const bad = expr("channel", [
      list([]),
      list([]),
      list([expr("cnot", [int(0n), int(1n)])]),
    ]);
    expect(validate(bad, channelSchema).ok).toBe(false);
  });

  test("rejects a non-channel expression as the top-level shape", () => {
    const notChannel = expr("circuit", [list([]), list([]), list([])]);
    expect(validate(notChannel, channelSchema).ok).toBe(false);
  });
});
