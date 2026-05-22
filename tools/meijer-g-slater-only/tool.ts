// =============================================================================
// meijer-g-slater-only — Slater-residue path for the Meijer G-function
// =============================================================================
//
// Intent
// ------
// Thin wire-protocol wrapper around `@workbench/meijer-core`'s
// `meijergSlater` orchestrator. Independently exposing the Slater
// path lets the benchmark exercise it in isolation — separately from
// the eventual `tools/meijer-g` top-level dispatcher (which will
// also try contour quadrature and Braaksma asymptotic before
// refusing). Once the dispatcher lands, this tool stays for
// regression / diagnostic / benchmarking purposes.
//
// I/O contract
// ------------
//   input:  record { an: list<bigcomplex>,
//                    ap: list<bigcomplex>,
//                    bm: list<bigcomplex>,
//                    bq: list<bigcomplex>,
//                    z:  bigcomplex }
//
//   output: record { value: bigcomplex,
//                    achieved_precision: integer,
//                    method: string,         // "slater-series-1" | "slater-series-2"
//                    series_terms: integer,
//                    perturbation_applied: boolean,
//                    cancellation_digits_lost: integer,
//                    working_precision: integer,
//                    warnings: list<string> }
//
//   refusals (tagged):
//     meijer-g-slater-only/quarantine-band       record { reason }
//     meijer-g-slater-only/non-convergent-pfq    record { reason }
//     meijer-g-slater-only/input-error           record { reason }
//
// `--precision=N` (decimal digits, default 50) is the standard
// ADR-0020 flag inherited from the runner.

import {
  bool,
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
} from "@workbench/bigfloat";
import { meijergSlater } from "@workbench/meijer-core";

const NAME = "meijer-g-slater-only";
const VERSION = "0.1.0";

// -----------------------------------------------------------------------------
// Schema
// -----------------------------------------------------------------------------

const inputSchema = S.record({
  an: S.list(bigcomplexSchema),
  ap: S.list(bigcomplexSchema),
  bm: S.list(bigcomplexSchema),
  bq: S.list(bigcomplexSchema),
  z: bigcomplexSchema,
});

const successOutputSchema = S.record({
  value: bigcomplexSchema,
  achieved_precision: S.kind("integer"),
  method: S.kind("string"),
  series_terms: S.kind("integer"),
  perturbation_applied: S.kind("boolean"),
  cancellation_digits_lost: S.kind("integer"),
  working_precision: S.kind("integer"),
  warnings: S.list(S.kind("string")),
});

const refusalOutputSchema = (tag: string) =>
  S.tagged(tag, S.record({ reason: S.kind("string") }));

const outputSchema = S.union([
  successOutputSchema,
  refusalOutputSchema(`${NAME}/quarantine-band`),
  refusalOutputSchema(`${NAME}/non-convergent-pfq`),
  refusalOutputSchema(`${NAME}/input-error`),
]);

// -----------------------------------------------------------------------------
// Tool definition
// -----------------------------------------------------------------------------

export const def = defineTool({
  name: NAME,
  version: VERSION,
  summary:
    "Slater residue-summation path (Series 1 + Series 2) for the Meijer G-function; deterministic odd-coefficient perturbation for parameter coalescence; `arbprec: true`",
  schema: { input: inputSchema, output: outputSchema },
  arbprec: true,
  examples: [
    {
      description: "G^{1,0}_{0,1}(_; 1 | 2) = 2 e^{-2}",
      input: record({
        an: list([] as Value[]),
        ap: list([] as Value[]),
        bm: list([bigcomplexToValue(cfromInts(1n, 0n, 50))]),
        bq: list([] as Value[]),
        z: bigcomplexToValue(cfromInts(2n, 0n, 50)),
      }),
      flags: { precision: "30" },
    },
    {
      description: "G^{1,1}_{1,1}(1/2; 0 | 1/2) = √(2π/3)",
      input: record({
        an: list([bigcomplexToValue(cfromInts(1n, 0n, 50))]),
        ap: list([] as Value[]),
        bm: list([bigcomplexToValue(cfromInts(0n, 0n, 50))]),
        bq: list([] as Value[]),
        z: bigcomplexToValue(cfromInts(1n, 0n, 50)),
      }),
      flags: { precision: "30" },
    },
  ],
  invariants: [
    {
      name: "G^{1,0}_{0,1}(_; b | z) = z^b · e^{-z}",
      statement:
        "DLMF 16.18.4: the simplest Series-1 closed form. Verifiable by " +
        "computing the right-hand side via the bigfloat substrate and " +
        "comparing byte-equal at the requested precision.",
      machine_checkable: true,
    },
    {
      name: "G^{0,1}_{1,0}(a; _ | z) = z^{a-1} · e^{-1/z}",
      statement: "Series-2 simplest closed form (Bateman 5.6.2).",
      machine_checkable: true,
    },
    {
      name: "Quarantine refusal at |z| ≈ 1, p = q, m + n = p",
      statement:
        "Inputs in the quarantine band emit `tagged " +
        "meijer-g-slater-only/quarantine-band` rather than a numerical " +
        "answer; the contour-integration layer (deferred) handles them.",
      machine_checkable: true,
    },
  ],
  fn: (input, flags) => {
    const inputRecord = input as Extract<Value, { kind: "record" }>;
    const decode = (key: string): BigComplex[] => {
      const v = inputRecord.fields[key] as Extract<Value, { kind: "list" }>;
      return v.items.map((it) => valueToBigComplex(it));
    };
    const an = decode("an");
    const ap = decode("ap");
    const bm = decode("bm");
    const bq = decode("bq");
    const z = valueToBigComplex(inputRecord.fields.z!);

    const precision = Number((flags as { precision?: bigint }).precision ?? 50n);
    if (!Number.isInteger(precision) || precision < 1) {
      throw new ToolError(
        `${NAME}: precision must be a positive integer; got ${precision}`,
      );
    }

    const result = meijergSlater({ an, ap, bm, bq }, z, precision);

    if (result.status === "success") {
      const warningStrs = result.warnings.map((w) => str(w));
      return record({
        value: bigcomplexToValue(result.value),
        achieved_precision: int(BigInt(result.achievedPrecision)),
        method: str(result.method),
        series_terms: int(BigInt(result.seriesTerms)),
        perturbation_applied: bool(result.perturbationApplied),
        cancellation_digits_lost: int(BigInt(result.cancellationDigitsLost)),
        working_precision: int(BigInt(result.workingPrecision)),
        warnings: list(warningStrs),
      });
    }

    // Map structured refusal status to a tagged value with the same tag tree.
    const tag = `${NAME}/${result.status}`;
    return tagged(tag, record({ reason: str(result.reason) }));
  },
});

if (import.meta.main) void runTool(def);
