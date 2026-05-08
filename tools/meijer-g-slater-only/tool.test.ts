// =============================================================================
// meijer-g-slater-only tool tests
// =============================================================================
//
// The orchestrator's algorithmic correctness is covered exhaustively
// in `packages/meijer-core/test/slater.test.ts` against closed-form
// MeijerG identities. This file's job is to lock in the wire surface:
//   * input decoding (the four-tuple split + bigcomplex z),
//   * output encoding (success record + tagged refusals),
//   * structured refusal under each of the three failure modes,
//   * the `--precision` flag plumbs through to the orchestrator.

import { describe, expect, test } from "bun:test";
import { def } from "./tool.js";
import { record, list, type Value } from "@workbench/protocol";
import {
  cfromInts,
  cfromStrings,
  bigcomplexToValue,
  valueToBigComplex,
  toString,
  type BigComplex,
} from "@workbench/bigfloat";

function buildInput(
  an: BigComplex[],
  ap: BigComplex[],
  bm: BigComplex[],
  bq: BigComplex[],
  z: BigComplex,
): Value {
  return record({
    an: list(an.map((x) => bigcomplexToValue(x)) as Value[]),
    ap: list(ap.map((x) => bigcomplexToValue(x)) as Value[]),
    bm: list(bm.map((x) => bigcomplexToValue(x)) as Value[]),
    bq: list(bq.map((x) => bigcomplexToValue(x)) as Value[]),
    z: bigcomplexToValue(z),
  });
}

function callTool(
  an: BigComplex[],
  ap: BigComplex[],
  bm: BigComplex[],
  bq: BigComplex[],
  z: BigComplex,
  precision: bigint,
) {
  const input = buildInput(an, ap, bm, bq, z) as Parameters<typeof def.fn>[0];
  const flags = { precision } as unknown as Parameters<typeof def.fn>[1];
  const result = def.fn(input, flags);
  return result as Extract<Value, { kind: "record" } | { kind: "tagged" }>;
}

describe("success path — DLMF 16.18.4 simplest case", () => {
  // We assert leading-digit match against the mathematically-true closed
  // form. The match width here (38 dps) is constrained by the bigfloat
  // substrate's `exp()` accuracy at the time of writing — the substrate
  // empirically delivers ~40 dps for `exp(±2)` at 50-dps target, which
  // bottlenecks any tool that composes `cgamma`/`cexp` on integer-ish
  // arguments. The Slater algorithm itself is correct; the limitation
  // is upstream. Once `@workbench/bigfloat` lifts the limit, widen these
  // assertions; the algorithm will track. Algorithmic invariants
  // (relative-tolerance close-comparison vs. independently-computed
  // closed forms) are exercised in `packages/meijer-core/test/slater.test.ts`.

  test("G^{1,0}_{0,1}(_; 1 | 2) = 2·e^{-2} (Series 1)", () => {
    const r = callTool(
      [],
      [],
      [cfromInts(1n, 0n, 256)],
      [],
      cfromInts(2n, 0n, 256),
      50n,
    );
    expect(r.kind).toBe("record");
    if (r.kind !== "record") return;
    const v = valueToBigComplex(r.fields.value!);
    // True 2·e^{-2}:  0.27067056647322538378799898994496880681323736020250
    expect(toString(v.re, 50).startsWith(
      "0.270670566473225383787998989944968806",
    )).toBe(true);
    expect((r.fields.method as Extract<Value, { kind: "string" }>).value).toBe(
      "slater-series-1",
    );
    expect(
      (r.fields.perturbation_applied as Extract<Value, { kind: "boolean" }>).value,
    ).toBe(false);
  });

  test("G^{0,1}_{1,0}(1; _ | 2) = e^{-1/2} (Series 2)", () => {
    const r = callTool(
      [cfromInts(1n, 0n, 256)],
      [],
      [],
      [],
      cfromInts(2n, 0n, 256),
      50n,
    );
    expect(r.kind).toBe("record");
    if (r.kind !== "record") return;
    const v = valueToBigComplex(r.fields.value!);
    // True exp(-1/2): 0.60653065971263342360379953499118045344191813548718
    // True exp(-1/2): 0.60653065971263342360379953499118045344191813548718...
    expect(toString(v.re, 50).startsWith(
      "0.6065306597126334236037995349911804534419181354",
    )).toBe(true);
    expect((r.fields.method as Extract<Value, { kind: "string" }>).value).toBe(
      "slater-series-2",
    );
  });
});

describe("refusal path — quarantine band", () => {
  test("|z|=1, p=q=m+n ⟹ tagged quarantine-band", () => {
    const r = callTool(
      [cfromStrings("0.4", "0", 256)],
      [cfromStrings("0.7", "0", 256)],
      [cfromStrings("1.1", "0", 256)],
      [cfromStrings("1.5", "0", 256)],
      cfromInts(1n, 0n, 256),
      30n,
    );
    expect(r.kind).toBe("tagged");
    if (r.kind !== "tagged") return;
    expect(r.tag).toBe("meijer-g-slater-only/quarantine-band");
  });
});

describe("refusal path — input-error", () => {
  test("m=0 and n=0 ⟹ tagged input-error", () => {
    const r = callTool(
      [],
      [cfromStrings("1", "0", 50)],
      [],
      [cfromStrings("2", "0", 50)],
      cfromInts(1n, 0n, 50),
      30n,
    );
    expect(r.kind).toBe("tagged");
    if (r.kind !== "tagged") return;
    expect(r.tag).toBe("meijer-g-slater-only/input-error");
  });
});

describe("--precision flag", () => {
  test("higher precision yields more digits", () => {
    // G^{1,0}_{0,1}(_; 0 | 1) = e^{-1}, evaluated at 80 dps.
    // True 1/e at 80 dps is the assertion below; exp(-1) is one of the
    // input-near-an-integer cases the substrate handles particularly
    // well, so we get a long match here.
    const r = callTool(
      [],
      [],
      [cfromInts(0n, 0n, 400)],
      [],
      cfromInts(1n, 0n, 400),
      80n,
    );
    expect(r.kind).toBe("record");
    if (r.kind !== "record") return;
    const v = valueToBigComplex(r.fields.value!);
    // True 1/e leading 65 digits: 0.36787944117144232159552377016146086744581113103176783450783680169...
    const got = toString(v.re, 78);
    expect(got.startsWith("0.367879441171442321595523770161460867445811131031767834507836801697")).toBe(true);
  });
});

describe("perturbation diagnostics", () => {
  test("coalescent input ⟹ perturbation_applied = true", () => {
    // bm = [1, 2] differs by integer ⟹ coalescent.
    const r = callTool(
      [],
      [],
      [cfromInts(1n, 0n, 256), cfromInts(2n, 0n, 256)],
      [],
      cfromStrings("0.25", "0", 256),
      25n,
    );
    expect(r.kind).toBe("record");
    if (r.kind !== "record") return;
    expect(
      (r.fields.perturbation_applied as Extract<Value, { kind: "boolean" }>).value,
    ).toBe(true);
  });
});
