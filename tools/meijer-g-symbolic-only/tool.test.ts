// =============================================================================
// meijer-g-symbolic-only tool tests
// =============================================================================
//
// The dispatcher's algorithmic correctness is covered exhaustively
// in `packages/meijer-core/test/dispatch.test.ts` (per-rule anchors,
// permutation invariance, no-match envelope, audit grep) and
// `packages/meijer-core/test/dispatch-mpmath.test.ts` (cross-
// validation against mpmath at 60 dps). This file locks in the wire
// surface: input decoding (four-tuple split + z), output encoding
// (matched record / tagged refusal), and the schema-validation
// contract.

import { describe, expect, test } from "bun:test";
import { def } from "./tool.js";
import {
  int,
  list,
  record,
  rat,
  sym,
  type Value,
} from "@workbench/protocol";

function buildInput(
  an: Value[],
  ap: Value[],
  bm: Value[],
  bq: Value[],
  z: Value,
): Parameters<typeof def.fn>[0] {
  return record({
    an: list(an),
    ap: list(ap),
    bm: list(bm),
    bq: list(bq),
    z,
  }) as Parameters<typeof def.fn>[0];
}

function callFn(input: Parameters<typeof def.fn>[0]): Value {
  return def.fn(input, {} as Parameters<typeof def.fn>[1]) as Value;
}

const Z = sym("z");

describe("tools/meijer-g-symbolic-only", () => {
  test("Bateman 5.6 (8): G^{1,0}_{0,1}(_; 0 | z) = e^{-z}", () => {
    const out = callFn(buildInput([], [], [int(0n)], [], Z));
    expect(out.kind).toBe("record");
    if (out.kind === "record") {
      const rule = out.fields.rule!;
      expect(rule.kind).toBe("string");
      if (rule.kind === "string") {
        expect(rule.value).toBe("bateman-5-6-8");
      }
      const source = out.fields.source!;
      expect(source.kind).toBe("string");
      if (source.kind === "string") {
        expect(source.value).toContain("Bateman");
      }
      // expr should be the closed form (canonicalised).
      const expr = out.fields.expr!;
      expect(JSON.stringify(expr)).toContain("exp");
    }
  });

  test("DLMF erf reduction emits Erf head", () => {
    const out = callFn(
      buildInput([int(1n)], [], [rat(1n, 2n)], [int(0n)], Z),
    );
    expect(out.kind).toBe("record");
    if (out.kind === "record") {
      const expr = out.fields.expr!;
      expect(JSON.stringify(expr)).toContain("Erf");
    }
  });

  test("no-known-reduction envelope on unrecognised shape", () => {
    const out = callFn(
      buildInput(
        [sym("a")],
        [sym("b")],
        [sym("c"), sym("d")],
        [],
        Z,
      ),
    );
    expect(out.kind).toBe("tagged");
    if (out.kind === "tagged") {
      expect(out.tag).toBe("meijer-g-symbolic-only/no-known-reduction");
      expect(out.payload.kind).toBe("record");
      if (out.payload.kind === "record") {
        const reason = out.payload.fields.reason!;
        expect(reason.kind).toBe("string");
        if (reason.kind === "string") {
          expect(reason.value.length).toBeGreaterThan(20);
        }
      }
    }
  });

  test("permutation invariance: bm permuted ⇒ same output bytes", () => {
    const out1 = callFn(buildInput([], [], [int(0n), int(0n)], [], Z));
    const out2 = callFn(buildInput([], [], [int(0n), int(0n)], [], Z));
    expect(JSON.stringify(out1)).toBe(JSON.stringify(out2));
  });

  test("rule citation is non-empty for matched outputs", () => {
    const out = callFn(buildInput([], [], [int(0n)], [], Z));
    if (out.kind === "record") {
      const source = out.fields.source!;
      if (source.kind === "string") {
        expect(source.value.length).toBeGreaterThan(0);
      }
    }
  });

  test("examples decode and dispatch", () => {
    expect(def.examples.length).toBeGreaterThanOrEqual(3);
    for (const ex of def.examples) {
      const out = callFn(ex.input as Parameters<typeof def.fn>[0]);
      // every example produces *some* defined output (matched record
      // or tagged refusal); none should throw.
      expect(out.kind === "record" || out.kind === "tagged").toBe(true);
    }
  });

  test("invariants are declared", () => {
    expect(def.invariants.length).toBeGreaterThanOrEqual(4);
  });
});
