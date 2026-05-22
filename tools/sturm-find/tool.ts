// =============================================================================
// sturm-find — Grover's algorithm wrapped as a workbench tool
// =============================================================================
//
// Intent
// ------
// `sturm-find` is the canonical demonstration of the layered Sturm-TS
// stack: the user supplies a register width and a list of marked
// classical values, the tool builds the Grover circuit using
// `@workbench/sturm-lib`'s `find`/`equalTo`/`phaseFlipMany`, runs it
// through `sturm-execute` for the analytic distribution, and (when
// `shots > 0`) draws Born-rule samples via `sturm-sample`.
//
// The tool is a thin wrapper. It does no quantum reasoning of its own
// — every interesting decision lives one layer down (`@workbench/sturm-lib`'s
// `optimalIters`, `find`, `phaseFlip`) or two (`@workbench/sturm`'s
// `trace`, `qreg`, `when`, etc.). The tool exists so a non-TS caller
// can run Grover via the standard pipe-tool interface.
//
// Input shape
// -----------
//   record {
//     n_bits:   integer,                  // 1 ≤ n_bits ≤ 3 in v0.1
//     marked:   list<integer>,            // distinct values in [0, 2^n_bits)
//     shots?:   integer,                  // ≥ 0; default 0 (no sampling)
//     entropy?: string,                   // hex bytes; required when shots > 0
//   }
//
// `n_bits ≤ 3` is the v0.1 cap — `mcz` (the multi-controlled Z used
// in the diffusion and oracle) supports n ∈ {1, 2, 3} only. n ≥ 4 is
// deferred until `mcz` grows a proper ancilla cascade with full
// CCNOTs.
//
// Output shape
// ------------
//   record {
//     distribution: <sturm-execute distribution record>,
//     samples?:     <sturm-sample result record, when shots > 0>,
//     iterations:   integer,             // optimalIters used
//   }
//
// Algorithm
// ---------
// `optimalIters(N, M) = ⌊π/4 · √(N/M)⌋` (Brassard et al. 2002,
// Theorem 3). The library `find` builds a `Channel<[], []>` that:
//   1. allocates `n_bits` qubits in |0⟩^n_bits,
//   2. applies H⊗n,
//   3. for each iteration: phase-flip the marked subset, then diffuse
//      (H⊗n · X⊗n · MCZ · X⊗n · H⊗n),
//   4. observes every bit, in LSB-first order — refs r0..r(n-1).
//
// `sturm-execute` returns the analytic distribution; if `shots > 0`,
// `sturm-sample` walks the CDF using 8 entropy bytes per shot.

import {
  type Value,
  S,
  type Schema,
  float64ToNumber,
  int,
  list,
  record,
  ToolError,
} from "@workbench/protocol";
import { defineTool, runTool } from "@workbench/contract";
import { execute, type QReg } from "@workbench/sturm";
import { equalTo, find, optimalIters, phaseFlipMany } from "@workbench/sturm-lib";

const NAME = "sturm-find";
const VERSION = "0.1.0";
const N_BITS_CAP = 3;

const inputSchema: Schema<Value> = S.record(
  {
    n_bits: S.kind("integer"),
    marked: S.list(S.kind("integer")),
    shots: S.kind("integer"),
    entropy: S.kind("string"),
  },
  { optional: ["shots", "entropy"] },
);

// `distribution` and `samples` carry the shapes that `sturm-execute`
// and `sturm-sample` define; we use S.any() to defer their structure
// to those tools' schemas.
const outputSchema: Schema<Value> = S.record(
  {
    distribution: S.any(),
    samples: S.any(),
    iterations: S.kind("integer"),
  },
  { optional: ["samples"] },
);

function readInteger(v: Value | undefined, field: string): bigint {
  if (v === undefined || v.kind !== "integer") {
    throw new ToolError(
      `${NAME}: missing or non-integer field '${field}'`,
      { suggestion: `field '${field}' must be an integer` },
    );
  }
  return BigInt(v.value);
}

export const def = defineTool({
  name: NAME,
  version: VERSION,
  summary:
    "Grover's algorithm via `sturm-execute` + optional `sturm-sample`; v0.1 caps at `n_bits ≤ 3`",
  schema: { input: inputSchema, output: outputSchema },
  examples: [
    {
      // `output` is omitted for all three Grover examples: the result
      // is a float64 amplitude distribution whose byte-exact form is a
      // simulation detail. Under ADR-0043 / issue ixnv.3 the examples
      // are folded into goldens, which snapshot the tool's actual
      // output — so the exact distribution is pinned in the golden, not
      // a hand-transcribed placeholder here. The description states the
      // verifiable claim (here: n=2 marked={3} amplifies |11⟩ to
      // probability 1 in a single iteration).
      description: "n=2 marked={3} — analytic distribution, no sampling",
      input: record({
        n_bits: int(2n),
        marked: list([int(3n)]),
      }),
    },
    {
      description: "n=3 marked={5} — 2 iterations, predicted ≈0.945 on |101⟩",
      input: record({
        n_bits: int(3n),
        marked: list([int(5n)]),
      }),
    },
    {
      description: "n=3 marked={2,5} — multi-marked oracle",
      input: record({
        n_bits: int(3n),
        marked: list([int(2n), int(5n)]),
      }),
    },
  ],
  invariants: [
    {
      name: "deterministic",
      statement: "same input bytes → same output bytes (IEEE-754 determinism)",
      machine_checkable: true,
    },
    {
      name: "probabilities-sum-to-one",
      statement:
        "the output distribution's prob field sums to 1 within float64 tolerance (≤ 1e-9)",
      machine_checkable: true,
    },
    {
      name: "marked-state-amplified",
      statement:
        "for n=2 marked={k}, P(observed = k) = 1.0; for n=3 marked={k}, P(observed = k) ≈ 0.9453",
      machine_checkable: true,
    },
    {
      name: "optimal-iterations-from-Brassard-2002",
      statement:
        "iterations = floor(π/4 · √(N/M)) where N = 2^n_bits and M = |marked|",
      machine_checkable: true,
    },
    {
      name: "honest-scope-bounds",
      statement:
        "n_bits ∈ [1, 3]; marked is non-empty; entries are distinct integers in [0, 2^n_bits)",
      machine_checkable: true,
    },
  ],
  fn: async (input, _flags): Promise<Value> => {
    if (input.kind !== "record") {
      throw new ToolError(`${NAME}: expected record input`, {
        suggestion: "input must be a record { n_bits, marked, shots?, entropy? }",
      });
    }
    const nBits = Number(readInteger(input.fields["n_bits"], "n_bits"));
    if (!Number.isInteger(nBits) || nBits < 1 || nBits > N_BITS_CAP) {
      throw new ToolError(
        `${NAME}: n_bits ${nBits} out of supported range [1, ${N_BITS_CAP}]`,
        {
          suggestion: `n_bits must be an integer in [1, ${N_BITS_CAP}]; v0.1 mcz supports n ∈ {1,2,3}`,
        },
      );
    }
    const N = 1 << nBits;

    const markedV = input.fields["marked"];
    if (markedV === undefined || markedV.kind !== "list") {
      throw new ToolError(`${NAME}: missing or non-list field 'marked'`, {
        suggestion: "field 'marked' must be a list of integers",
      });
    }
    if (markedV.items.length === 0) {
      throw new ToolError(`${NAME}: 'marked' must be non-empty`, {
        suggestion: "supply at least one target value",
      });
    }
    const marked: number[] = [];
    const seen = new Set<number>();
    for (const m of markedV.items) {
      const mn = Number(readInteger(m, "marked[i]"));
      if (mn < 0 || mn >= N) {
        throw new ToolError(`${NAME}: marked entry ${mn} out of range [0, ${N})`, {
          suggestion: `each marked value must be an integer in [0, 2^n_bits)`,
        });
      }
      if (seen.has(mn)) {
        throw new ToolError(`${NAME}: marked entry ${mn} duplicated`, {
          suggestion: "marked entries must be distinct",
        });
      }
      seen.add(mn);
      marked.push(mn);
    }

    let shots = 0;
    if (input.fields["shots"] !== undefined) {
      const sv = input.fields["shots"];
      if (sv.kind !== "integer") {
        throw new ToolError(`${NAME}: shots must be an integer`, {
          suggestion: "shots must be an integer ≥ 0",
        });
      }
      shots = Number(sv.value);
      if (shots < 0) {
        throw new ToolError(`${NAME}: shots ${shots} < 0`, {
          suggestion: "shots must be ≥ 0",
        });
      }
    }
    let entropy: string | undefined;
    if (input.fields["entropy"] !== undefined) {
      const e = input.fields["entropy"];
      if (e.kind !== "string") {
        throw new ToolError(`${NAME}: entropy must be a string`, {
          suggestion: "entropy must be hex bytes",
        });
      }
      entropy = e.value;
    }
    if (shots > 0 && entropy === undefined) {
      throw new ToolError(`${NAME}: shots > 0 requires entropy`, {
        suggestion: "supply 'entropy' (hex bytes from entropy-source) when sampling",
      });
    }

    const oracle =
      marked.length === 1
        ? equalTo(marked[0]!)
        : (x: QReg<number>) => phaseFlipMany(x, marked);
    const channel = find(nBits, oracle, marked.length);
    const iterations = optimalIters(N, marked.length);

    const opts: Parameters<typeof execute>[1] = {};
    if (shots > 0) {
      opts.shots = shots;
      if (entropy !== undefined) opts.entropy = entropy;
    }
    const result = await execute(channel, opts);

    const fields: Record<string, Value> = {
      distribution: result.distribution,
      iterations: int(BigInt(iterations)),
    };
    if (result.samples !== undefined) fields["samples"] = result.samples;
    return record(fields);
  },
  // In-process probes for `--test`. They re-derive the analytic
  // predictions and verify the tool's output matches them within IEEE
  // tolerance — catching any structural break in the library, not
  // just a "didn't throw" smoke test.
  test: async () => {
    // Probe 1: n=2 marked={3} amplifies to P(11) = 1.
    const r2 = await def.fn(record({ n_bits: int(2n), marked: list([int(3n)]) }), {});
    const dist2 = readDistribution(r2);
    assertProbsSum(dist2);
    const p2 = probOf(dist2, r => r["r0"] === 1 && r["r1"] === 1);
    if (Math.abs(p2 - 1) > 1e-9) {
      throw new Error(`sturm-find --test: n=2 marked={3} expected P(11)=1, got ${p2}`);
    }

    // Probe 2: n=3 marked={5} amplifies to ~0.945 on |101⟩.
    const r3 = await def.fn(record({ n_bits: int(3n), marked: list([int(5n)]) }), {});
    const dist3 = readDistribution(r3);
    assertProbsSum(dist3);
    const p3 = probOf(dist3, r => r["r0"] === 1 && r["r1"] === 0 && r["r2"] === 1);
    const theta = Math.asin(1 / Math.sqrt(8));
    const predicted = Math.sin(5 * theta) ** 2;
    if (Math.abs(p3 - predicted) > 1e-9) {
      throw new Error(
        `sturm-find --test: n=3 marked={5} expected ~${predicted.toFixed(6)}, got ${p3}`,
      );
    }
  },
});

// -----------------------------------------------------------------------------
// Test helpers
// -----------------------------------------------------------------------------

function readDistribution(v: Value): Value {
  if (v.kind !== "record") throw new Error("expected record output");
  const dist = v.fields["distribution"];
  if (dist === undefined) throw new Error("missing distribution field");
  return dist;
}

function assertProbsSum(distribution: Value): void {
  if (distribution.kind !== "record") throw new Error("distribution not a record");
  const outcomes = distribution.fields["outcomes"];
  if (outcomes === undefined || outcomes.kind !== "list") {
    throw new Error("distribution missing outcomes");
  }
  let total = 0;
  for (const o of outcomes.items) {
    if (o.kind !== "record") continue;
    const p = o.fields["prob"];
    if (p?.kind !== "float64") continue;
    total += float64ToNumber(p);
  }
  if (Math.abs(total - 1) > 1e-9) {
    throw new Error(`probabilities sum to ${total}, expected 1`);
  }
}

function probOf(
  distribution: Value,
  predicate: (resol: Record<string, number>) => boolean,
): number {
  if (distribution.kind !== "record") return NaN;
  const outcomes = distribution.fields["outcomes"];
  if (outcomes === undefined || outcomes.kind !== "list") return NaN;
  let total = 0;
  for (const o of outcomes.items) {
    if (o.kind !== "record") continue;
    const probV = o.fields["prob"];
    if (probV?.kind !== "float64") continue;
    const resolL = o.fields["classical_resolutions"];
    if (resolL?.kind !== "list") continue;
    const resol: Record<string, number> = {};
    for (const r of resolL.items) {
      if (r.kind !== "record") continue;
      const refV = r.fields["ref"];
      const valV = r.fields["value"];
      if (refV?.kind !== "string" || valV?.kind !== "integer") continue;
      resol[refV.value] = Number(valV.value);
    }
    if (predicate(resol)) total += float64ToNumber(probV);
  }
  return total;
}

if (import.meta.main) void runTool(def);
