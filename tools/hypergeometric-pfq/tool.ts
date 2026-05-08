// =============================================================================
// hypergeometric-pfq — arbitrary-precision generalised hypergeometric pFq
// =============================================================================
//
// Wire-protocol wrapper around the pure evaluator in
// `@workbench/hypergeometric`. The algorithm itself (direct power series,
// closed-form fast paths, cancellation-driven precision retry, parameter-
// pole detection) lives in the package; this tool decodes the value-
// protocol input, dispatches to the package, and re-encodes the structured
// result.
//
// First arb-prec numerical-tier tool in scientist-workbench (ADR-0020 is
// the design rationale; ADR-0014/0015 the precedent for "agent-honest
// numerical output records"). Computes
//
//     pFq(a₁,…,aₚ; b₁,…,b_q; z)
//        = Σ_{k=0}^∞   ∏_j (a_j)_k    ·  z^k / k!
//                      ───────────────
//                      ∏_j (b_j)_k
//
// at user-requested precision (`--precision=<int>` decimal digits).
//
// I/O contract
// ------------
//   input:  { a: list<bigcomplex>, b: list<bigcomplex>, z: bigcomplex }
//   output: { value: bigcomplex,
//             achieved_precision: integer,
//             method: string,
//             n_terms: integer,
//             working_precision: integer,
//             warnings: list<string> }
//   refusals:
//     tagged "hypergeometric-pfq/non-convergent" record { reason: string }
//     tagged "hypergeometric-pfq/parameter-pole" record { which: string,
//                                                          which_idx: integer }
//
// `--precision=N` (decimal digits, default 50) is the standard ADR-0020
// flag inherited from the runner.

import {
  int,
  list,
  record,
  S,
  str,
  tagged,
  ToolError,
  type Value,
} from "@workbench/protocol";
import { defineTool, runTool } from "@workbench/contract";
import {
  type BigComplex,
  bigcomplexSchema,
  bigcomplexToValue,
  valueToBigComplex,
  cfromInts,
  cfromStrings,
} from "@workbench/bigfloat";
import { evaluatePFq } from "@workbench/hypergeometric";

const NAME = "hypergeometric-pfq";
const VERSION = "0.1.0";

// -----------------------------------------------------------------------------
// Schema
// -----------------------------------------------------------------------------

const inputSchema = S.record({
  a: S.list(bigcomplexSchema),
  b: S.list(bigcomplexSchema),
  z: bigcomplexSchema,
});

const successOutputSchema = S.record({
  value: bigcomplexSchema,
  achieved_precision: S.kind("integer"),
  method: S.kind("string"),
  n_terms: S.kind("integer"),
  working_precision: S.kind("integer"),
  warnings: S.list(S.kind("string")),
});

const nonConvergentOutputSchema = S.tagged(
  `${NAME}/non-convergent`,
  S.record({ reason: S.kind("string") }),
);

const parameterPoleOutputSchema = S.tagged(
  `${NAME}/parameter-pole`,
  S.record({
    which: S.kind("string"),
    which_idx: S.kind("integer"),
  }),
);

const outputSchema = S.union([
  successOutputSchema,
  nonConvergentOutputSchema,
  parameterPoleOutputSchema,
]);

// -----------------------------------------------------------------------------
// Tool definition
// -----------------------------------------------------------------------------

export const def = defineTool({
  name: NAME,
  version: VERSION,
  schema: { input: inputSchema, output: outputSchema },
  arbprec: true,
  examples: [
    {
      description: "0F0(;;1) = e",
      input: record({
        a: list([] as Value[]),
        b: list([] as Value[]),
        z: bigcomplexToValue(cfromInts(1n, 0n, 50)),
      }),
      flags: { precision: "30" },
    },
    {
      description: "2F1(1, 1; 2; 1/2) = 2 ln(2)",
      input: record({
        a: list([
          bigcomplexToValue(cfromInts(1n, 0n, 50)),
          bigcomplexToValue(cfromInts(1n, 0n, 50)),
        ]),
        b: list([bigcomplexToValue(cfromInts(2n, 0n, 50))]),
        z: bigcomplexToValue(cfromStrings("0.5", "0", 50)),
      }),
      flags: { precision: "30" },
    },
  ],
  invariants: [
    {
      name: "0F0(;;z) = exp(z) for all z",
      statement:
        "When p=0 and q=0, the series sums to exp(z); the closed-form fast path matches the bigfloat exp.",
      machine_checkable: true,
    },
    {
      name: "1F0(a;;z) = (1-z)^(-a) for |z| < 1",
      statement: "The fast path equals (1 − z) raised to the −a power.",
      machine_checkable: true,
    },
    {
      name: "pFq(a; b; 0) = 1",
      statement: "At z = 0 every series collapses to its k=0 term.",
      machine_checkable: true,
    },
  ],
  fn: (input, flags) => {
    const inputRecord = input as Extract<Value, { kind: "record" }>;
    const aListValue = inputRecord.fields.a as Extract<Value, { kind: "list" }>;
    const bListValue = inputRecord.fields.b as Extract<Value, { kind: "list" }>;
    const zValue = inputRecord.fields.z!;
    const aList: BigComplex[] = aListValue.items.map((v) => valueToBigComplex(v));
    const bList: BigComplex[] = bListValue.items.map((v) => valueToBigComplex(v));
    const z = valueToBigComplex(zValue);

    const precision = Number((flags as { precision?: bigint }).precision ?? 50n);
    if (!Number.isInteger(precision) || precision < 1) {
      throw new ToolError(
        `${NAME}: precision must be a positive integer; got ${precision}`,
      );
    }

    const result = evaluatePFq(aList, bList, z, precision);

    if (result.status === "success") {
      const warningStrs = result.warnings.map((w) => str(w));
      return record({
        value: bigcomplexToValue(result.value),
        achieved_precision: int(BigInt(result.achievedPrecision)),
        method: str(result.method),
        n_terms: int(BigInt(result.nTerms)),
        working_precision: int(BigInt(result.workingPrecision)),
        warnings: list(warningStrs),
      });
    }
    if (result.status === "parameter-pole") {
      return tagged(
        `${NAME}/parameter-pole`,
        record({
          which: str(result.which ?? "b"),
          which_idx: int(BigInt(result.whichIdx ?? 0)),
        }),
      );
    }
    return tagged(
      `${NAME}/non-convergent`,
      record({ reason: str(result.reason) }),
    );
  },
});

if (import.meta.main) void runTool(def);
