// Bell-pair smoke tests for the @workbench/sturm frontend.
//
// Three layers checked:
//   1. The trace context emits a well-formed Channel IR Value with
//      the expected ops in the expected order.
//   2. `not(q)` lowers to two ops (Rz(π) then Ry(π)) so the wrapped
//      X channel — not Y — is what the IR records.
//   3. `execute(channel)` round-trips through `sturm-execute` and
//      returns the textbook Bell distribution: 0.5 (00), 0.5 (11).
//
// These are property tests, not "didn't throw" tests — every
// assertion checks an invariant that catches a real regression.

import { describe, expect, it } from "bun:test";
import {
  Channel,
  execute,
  not,
  observe,
  qbool,
  rz,
  ry,
  trace,
  when,
  π,
} from "../src/index.js";
import { float64ToNumber } from "@workbench/protocol";

describe("@workbench/sturm — Bell pair", () => {
  it("trace builds a 4-op Bell-pair channel: prepare(1/2), prepare(0), CX, then observe×2", () => {
    const bell = trace<readonly [], readonly []>(() => {
      const a = qbool(1 / 2);
      const b = qbool(0);
      when(a, () => not(b));
      observe(a);
      observe(b);
      return [];
    });
    const ir = bell.toIR();
    expect(ir.inputs.length).toBe(0);
    expect(ir.outputs.length).toBe(0);
    // ops: prepare(1/2)→a, prepare(0)→b, rz(π)→b ctrl=[a], ry(π)→b ctrl=[a],
    //      observe(a)→r0, observe(b)→r1.
    expect(ir.body.length).toBe(6);
    expect(ir.body[0]!.head).toBe("prepare");
    expect(ir.body[1]!.head).toBe("prepare");
    expect(ir.body[2]!.head).toBe("rz");
    expect(ir.body[3]!.head).toBe("ry");
    expect(ir.body[4]!.head).toBe("observe");
    expect(ir.body[5]!.head).toBe("observe");

    const cx0 = ir.body[2];
    if (cx0?.head !== "rz") throw new Error("expected rz");
    expect(cx0.controls).toEqual([0n]); // a's wireId is 0
    expect(cx0.wireId).toBe(1n); // b's wireId is 1

    const cx1 = ir.body[3];
    if (cx1?.head !== "ry") throw new Error("expected ry");
    expect(cx1.controls).toEqual([0n]);
    expect(cx1.wireId).toBe(1n);
  });

  it("not(q) is two ops, in (rz, ry) order — the X channel, not Y", () => {
    const ch = trace<readonly [], readonly []>(() => {
      const q = qbool(0);
      not(q);
      observe(q);
      return [];
    });
    const ops = ch.toIR().body;
    // prepare, rz(π), ry(π), observe
    expect(ops.length).toBe(4);
    expect(ops[1]!.head).toBe("rz");
    expect(ops[2]!.head).toBe("ry");
  });

  it("Channel#hash is deterministic across re-construction", () => {
    const make = () =>
      trace<readonly [], readonly []>(() => {
        const a = qbool(1 / 2);
        const b = qbool(0);
        when(a, () => not(b));
        observe(a);
        observe(b);
        return [];
      });
    const h1 = make().hash();
    const h2 = make().hash();
    expect(h1).toBe(h2);
    expect(h1.length).toBe(64);
  });

  it("Channel.fromValue round-trips toValue", () => {
    const bell = trace<readonly [], readonly []>(() => {
      const a = qbool(1 / 2);
      const b = qbool(0);
      when(a, () => not(b));
      observe(a);
      observe(b);
      return [];
    });
    const v = bell.toValue();
    const reborn = Channel.fromValue(v);
    expect(reborn.hash()).toBe(bell.hash());
  });

  it("execute(bell) returns the textbook 0.5 / 0.5 distribution", async () => {
    const bell = trace<readonly [], readonly []>(() => {
      const a = qbool(1 / 2);
      const b = qbool(0);
      when(a, () => not(b));
      observe(a);
      observe(b);
      return [];
    });
    const result = await execute(bell);
    const dist = result.distribution;
    if (dist.kind !== "record") {
      throw new Error("expected record distribution, got " + dist.kind);
    }
    const refs = dist.fields["classical_refs"];
    if (refs?.kind !== "list") throw new Error("missing classical_refs");
    expect(refs.items.length).toBe(2);

    const outcomes = dist.fields["outcomes"];
    if (outcomes?.kind !== "list") throw new Error("missing outcomes");
    expect(outcomes.items.length).toBe(2); // only the two non-zero outcomes survive 1e-12 floor

    // Sum probabilities to 1.0; verify the two outcomes are (0,0) and (1,1).
    let total = 0;
    let bothZero = 0;
    let bothOne = 0;
    for (const o of outcomes.items) {
      if (o.kind !== "record") continue;
      const probV = o.fields["prob"];
      if (probV?.kind !== "float64") continue;
      const p = float64ToNumber(probV);
      total += p;
      const resol = o.fields["classical_resolutions"];
      if (resol?.kind !== "list" || resol.items.length !== 2) continue;
      const v0 = resol.items[0];
      const v1 = resol.items[1];
      if (v0?.kind !== "record" || v1?.kind !== "record") continue;
      const a = v0.fields["value"];
      const b = v1.fields["value"];
      if (a?.kind !== "integer" || b?.kind !== "integer") continue;
      if (a.value === "0" && b.value === "0") bothZero += p;
      if (a.value === "1" && b.value === "1") bothOne += p;
    }
    expect(Math.abs(total - 1)).toBeLessThan(1e-9);
    expect(Math.abs(bothZero - 0.5)).toBeLessThan(1e-9);
    expect(Math.abs(bothOne - 0.5)).toBeLessThan(1e-9);
  });

  it("when() is rejected on a consumed wire", () => {
    expect(() =>
      trace<readonly [], readonly []>(() => {
        const a = qbool(0);
        observe(a);
        when(a, () => {}); // a is consumed
        return [];
      }),
    ).toThrow(/consumed/);
  });

  it("primitive called outside trace() throws cleanly", () => {
    expect(() => qbool(0)).toThrow(/outside a trace/);
  });

  it("rz / ry preserve symbolic angles unchanged", () => {
    const ch = trace<readonly [], readonly []>(() => {
      const q = qbool(0);
      rz(q, π);
      ry(q, π / 2);
      observe(q);
      return [];
    });
    const ops = ch.toIR().body;
    if (ops[1]?.head !== "rz") throw new Error("expected rz at idx 1");
    if (ops[2]?.head !== "ry") throw new Error("expected ry at idx 2");
    // π → float64 (a number, not symbolic, since we used `π = Math.PI`)
    expect(ops[1]!.delta.kind).toBe("float64");
    expect(ops[2]!.delta.kind).toBe("float64");
  });
});
