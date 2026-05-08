// =============================================================================
// meijer-g-symbolic-only — Adamchik–Marichev + Roach symbolic dispatch
// =============================================================================
//
// Intent
// ------
// Pattern-table dispatcher for the Meijer G-function. Given input
// parameters `(an, ap, bm, bq, z)` in the AST encoding (Wolfram
// convention; ADR-0023), walks the curated reduction-rule table in
// `@workbench/meijer-core` and emits a closed-form expression in the
// special-function vocabulary if a rule fires; otherwise returns a
// structured `tagged "meijer-g-symbolic-only/no-known-reduction"`
// envelope (per ADR-0003 boundary-failure pattern).
//
// This is the "fast path" for tier A and tier B of the problem-13
// verifier. The numerical path lives in `tools/meijer-g-slater-only`
// (Slater residue summation, ADR-0020 arb-prec). The eventual
// `tools/meijer-g` top-level dispatcher (`hv0.10`) will compose
// symbolic-first → Slater → contour → asymptotic → refuse.
//
// Input shape
// -----------
//   record {
//     an: list<Value>,    // upper params with Γ(1−aⱼ+s) factors
//     ap: list<Value>,    // upper params with Γ(aⱼ−s) factors
//     bm: list<Value>,    // lower params with Γ(bⱼ−s) factors
//     bq: list<Value>,    // lower params with Γ(1−bⱼ+s) factors
//     z:  Value           // argument; symbolic or rational/integer
//   }
//
// Each parameter Value lives in the protocol's
// `integer / rational / symbol / expression` subset. Values outside
// this subset (`float64`, `complex`, `tagged`) are accepted at the
// schema level but the dispatcher's pattern matcher returns
// `no-known-reduction` if it cannot reason about them.
//
// Output shape
// ------------
//   record {
//     expr: Value,             // closed-form AST in the special-function vocab
//     rule: string,            // stable rule id (e.g. "bateman-5-6-1")
//     source: string,          // human-readable citation
//     note: string             // closed-form RHS in conventional notation
//                              // (empty string if the rule didn't supply one)
//   }
//
//   |  tagged "meijer-g-symbolic-only/no-known-reduction" record { reason }
//
// Algorithm
// ---------
// `meijergSymbolic` (in `@workbench/meijer-core`) walks the curated
// rule list (DLMF §16.17–§16.18 + Bateman §5.6 + future PBM / Wolfram
// shards). First-match-wins; rules within each file ordered most-
// specific-first. Inputs are canonicalised by sorting each
// sub-tuple's slots by canonical-bytes order before matching.
// See `docs/adr/0025-meijerg-symbolic-dispatch.md`.

import {
  int,
  list,
  record,
  S,
  str,
  sym,
  tagged,
  type Value,
} from "@workbench/protocol";
import { defineTool, runTool } from "@workbench/contract";
import { meijergSymbolic } from "@workbench/meijer-core";
import type { MeijerGSymbolicParams } from "@workbench/meijer-core";

const NAME = "meijer-g-symbolic-only";
const VERSION = "0.1.0";

// -----------------------------------------------------------------------------
// Schema
// -----------------------------------------------------------------------------

const inputSchema = S.record({
  an: S.list(S.any()),
  ap: S.list(S.any()),
  bm: S.list(S.any()),
  bq: S.list(S.any()),
  z: S.any(),
});

const matchedSchema = S.record({
  expr: S.any(),
  rule: S.kind("string"),
  source: S.kind("string"),
  note: S.kind("string"),
});

const refusalSchema = S.tagged(
  `${NAME}/no-known-reduction`,
  S.record({ reason: S.kind("string") }),
);

const outputSchema = S.union([matchedSchema, refusalSchema]);

// -----------------------------------------------------------------------------
// Tool definition
// -----------------------------------------------------------------------------

export const def = defineTool({
  name: NAME,
  version: VERSION,
  schema: { input: inputSchema, output: outputSchema },
  examples: [
    {
      description: "G^{1,0}_{0,1}(_; 0 | z) = e^{-z}  (Bateman 5.6 (8))",
      input: record({
        an: list([] as Value[]),
        ap: list([] as Value[]),
        bm: list([int(0n)] as Value[]),
        bq: list([] as Value[]),
        z: sym("z"),
      }),
    },
    {
      description: "G^{2,0}_{0,2}(_; 0, 0 | z) = 2 K_0(2√z)  (Bateman 5.6 (25))",
      input: record({
        an: list([] as Value[]),
        ap: list([] as Value[]),
        bm: list([int(0n), int(0n)] as Value[]),
        bq: list([] as Value[]),
        z: sym("z"),
      }),
    },
    {
      description: "Generic G^{1,1}_{2,2}(symbolic params) — no-known-reduction",
      input: record({
        an: list([sym("a")] as Value[]),
        ap: list([sym("b")] as Value[]),
        bm: list([sym("c")] as Value[]),
        bq: list([sym("d")] as Value[]),
        z: sym("z"),
      }),
    },
  ],
  invariants: [
    {
      name: "deterministic",
      statement: "same input bytes → same output bytes",
      machine_checkable: true,
    },
    {
      name: "permutation invariance within sub-tuples",
      statement:
        "Inputs whose `an`, `ap`, `bm`, `bq` lists are individually " +
        "permuted produce the same matched ruleId and a byte-equal expr " +
        "(after the dispatcher's canonicalisation pipeline).",
      machine_checkable: true,
    },
    {
      name: "no-known-reduction on unrecognised shapes",
      statement:
        "Inputs not in the v0.1 rule table return " +
        "`tagged \"meijer-g-symbolic-only/no-known-reduction\" " +
        "record { reason }` rather than silently producing a wrong-shaped " +
        "answer (ADR-0003 boundary-failure).",
      machine_checkable: true,
    },
    {
      name: "every emitted rule cites primary literature",
      statement:
        "Every `source` field in a successful output names a " +
        "primary-literature reference (Bateman §5.6, DLMF §16.17/§16.18). " +
        "No source is transliterated from open-source implementation " +
        "code. The audit grep test " +
        "(`packages/meijer-core/test/dispatch-audit.test.ts`) enforces.",
      machine_checkable: true,
    },
  ],
  fn: (input, _flags): Value => {
    const inputRecord = input as Extract<Value, { kind: "record" }>;

    const decode = (key: string): Value[] => {
      const v = inputRecord.fields[key];
      if (v === undefined || v.kind !== "list") {
        throw new Error(`${NAME}: input.${key} must be a list`);
      }
      return [...v.items];
    };

    const params: MeijerGSymbolicParams = {
      an: decode("an"),
      ap: decode("ap"),
      bm: decode("bm"),
      bq: decode("bq"),
    };
    const z = inputRecord.fields.z;
    if (z === undefined) {
      throw new Error(`${NAME}: input.z is required`);
    }

    const result = meijergSymbolic(params, z);

    if (result.kind === "matched") {
      return record({
        expr: result.expr,
        rule: str(result.ruleId),
        source: str(result.ruleSource),
        note: str(result.note ?? ""),
      });
    }
    return tagged(
      `${NAME}/no-known-reduction`,
      record({ reason: str(result.reason) }),
    );
  },
});

if (import.meta.main) void runTool(def);
