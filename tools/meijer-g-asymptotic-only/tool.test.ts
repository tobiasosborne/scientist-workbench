// =============================================================================
// meijer-g-asymptotic-only tool tests
// =============================================================================
//
// The kernel's algorithmic correctness is exhaustively covered in
// `packages/meijer-core/test/asymptotic.test.ts` (closed-form anchors,
// Slater cross-check, optimal-truncation invariant, mutation-prove,
// bit-determinism). This file locks in the wire surface: input
// decoding (four-tuple split + z), output encoding (success record /
// tagged refusal), schema-validation contract, and `--precision`
// flag plumbing.

import { describe, expect, test } from "bun:test";
import { def } from "./tool.js";
import {
  bigcomplexToValue,
  cfromInts,
  cfromStrings,
} from "@workbench/bigfloat";
import { list, record, type Value } from "@workbench/protocol";

const PREC = 256;

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

function callFn(
  input: Parameters<typeof def.fn>[0],
  precision = 30n,
): Value {
  // The arbprec `precision` flag is injected by the runner — *not*
  // declared in `def.flags` — so its type is not part of
  // `FlagsOf<...>`. Cast through `unknown` to bypass the strict-
  // narrowed type. (Same pattern as `tools/hypergeometric-pfq/
  // tool.test.ts`.)
  const flags = { precision } as unknown as Parameters<typeof def.fn>[1];
  return def.fn(input, flags) as Value;
}

const cZero = bigcomplexToValue(cfromInts(0n, 0n, PREC));
const cOne = bigcomplexToValue(cfromInts(1n, 0n, PREC));
const cHalf = bigcomplexToValue(cfromStrings("0.5", "0", PREC));
const c100 = bigcomplexToValue(cfromInts(100n, 0n, PREC));

describe("tools/meijer-g-asymptotic-only", () => {
  test("principal-sector success: G^{0,1}_{1,0}(1; |100) — record envelope", () => {
    const out = callFn(buildInput([cOne], [], [], [], c100));
    expect(out.kind).toBe("record");
    if (out.kind !== "record") return;
    expect(out.fields.method!.kind).toBe("string");
    if (out.fields.method!.kind === "string") {
      expect(out.fields.method!.value).toBe("braaksma-algebraic");
    }
    expect(out.fields.sector!.kind).toBe("string");
    if (out.fields.sector!.kind === "string") {
      expect(out.fields.sector!.value).toBe("principal");
    }
    // optimal_term_indices is a list with one entry (n=1).
    expect(out.fields.optimal_term_indices!.kind).toBe("list");
    if (out.fields.optimal_term_indices!.kind === "list") {
      expect(out.fields.optimal_term_indices!.items.length).toBe(1);
    }
    // Working precision encoded as integer.
    expect(out.fields.working_precision!.kind).toBe("integer");
  });

  test("principal-sector success: schema fields are all populated", () => {
    const out = callFn(
      buildInput([cHalf], [], [cZero], [cOne], c100),
      30n,
    );
    expect(out.kind).toBe("record");
    if (out.kind !== "record") return;
    // All success fields must be present.
    for (const k of [
      "value",
      "achieved_precision",
      "method",
      "n_terms",
      "optimal_term_indices",
      "error_estimate",
      "sector",
      "working_precision",
      "warnings",
    ]) {
      expect(out.fields[k]).toBeDefined();
    }
  });

  test("refusal: secondary-sector tag for arg z = π", () => {
    const cNeg100 = bigcomplexToValue(cfromInts(-100n, 0n, PREC));
    const out = callFn(buildInput([cHalf], [], [cZero], [cOne], cNeg100));
    expect(out.kind).toBe("tagged");
    if (out.kind !== "tagged") return;
    expect(out.tag).toBe("meijer-g-asymptotic-only/secondary-sector");
    expect(out.payload.kind).toBe("record");
    if (out.payload.kind === "record") {
      expect(out.payload.fields.reason!.kind).toBe("string");
    }
  });

  test("refusal: small-z tag for |z| < 1", () => {
    const cSmall = bigcomplexToValue(cfromStrings("0.5", "0", PREC));
    const out = callFn(buildInput([cHalf], [], [cZero], [cOne], cSmall));
    expect(out.kind).toBe("tagged");
    if (out.kind !== "tagged") return;
    expect(out.tag).toBe("meijer-g-asymptotic-only/small-z");
  });

  test("refusal: no-pole-residues tag for n=0", () => {
    const out = callFn(buildInput([], [], [cZero], [], c100));
    expect(out.kind).toBe("tagged");
    if (out.kind !== "tagged") return;
    expect(out.tag).toBe("meijer-g-asymptotic-only/no-pole-residues");
  });

  test("--precision flag is honoured", () => {
    const out30 = callFn(buildInput([cHalf], [], [cZero], [cOne], c100), 30n);
    const out50 = callFn(buildInput([cHalf], [], [cZero], [cOne], c100), 50n);
    if (out30.kind !== "record" || out50.kind !== "record") {
      throw new Error("expected success records");
    }
    const ap30 = out30.fields.achieved_precision;
    const ap50 = out50.fields.achieved_precision;
    if (ap30?.kind !== "integer" || ap50?.kind !== "integer") {
      throw new Error("achieved_precision must be integer");
    }
    expect(ap30.value).toBe("30");
    expect(ap50.value).toBe("50");
    // Working precision should differ (50 dps requires more bits).
    const wp30 = out30.fields.working_precision;
    const wp50 = out50.fields.working_precision;
    if (wp30?.kind !== "integer" || wp50?.kind !== "integer") {
      throw new Error("working_precision must be integer");
    }
    expect(BigInt(wp50.value)).toBeGreaterThan(BigInt(wp30.value));
  });

  test("determinism: two evaluations produce byte-identical output", () => {
    const a = callFn(buildInput([cHalf], [], [cZero], [cOne], c100));
    const b = callFn(buildInput([cHalf], [], [cZero], [cOne], c100));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
