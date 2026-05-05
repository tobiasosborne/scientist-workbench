// =============================================================================
// bench/linalg-svd/run-candidate.ts — bench wire-format adapter
// =============================================================================
//
// Bridges the bench's language-neutral JSON wire format
//
//   in:  { "A": [[float, ...], ...], "mode"?: "reduced" | "complete" }
//   out: { "U": [[float, ...], ...], "S": [float, ...],
//          "Vt": [[float, ...], ...], "mode": ...,
//          "reconstruction_error": ..., "orthogonality_error_U": ...,
//          "orthogonality_error_Vt": ..., "condition_number": ...,
//          "rank_estimate": int, "method": ..., "warnings": [...] }
//
// to the canonical Value protocol that `tools/linalg-svd/` speaks.
// Reads one JSON object on stdin, encodes it as a canonical Value,
// calls the tool in-process via `@workbench/compose`, decodes the
// output Value back to raw JSON, writes one JSON object on stdout.
// Used by `bench/infra/run-bench.sh`.
//
// Mirrors `bench/linalg-qr/run-candidate.ts` (worklog 043).  Same
// in-process / subprocess trade-off: in-process amortises better
// over 49 cases.

import { readFileSync } from "node:fs";
import { loadWorkbench } from "@workbench/compose";
import {
  float64FromNumber,
  float64ToNumber,
  list,
  record,
  str,
  type Value,
} from "@workbench/protocol";

// ─── raw JSON → canonical Value (input encoding) ─────────────────────────────

function encodeRow(row: readonly number[]): Value {
  return list(row.map((x) => float64FromNumber(x)));
}

function encodeInput(raw: { A: readonly (readonly number[])[]; mode?: string }): Value {
  const rows = list(raw.A.map(encodeRow));
  if (raw.mode === undefined) {
    return record({ A: rows });
  }
  return record({ A: rows, mode: str(raw.mode) });
}

// ─── canonical Value → raw JSON (output decoding) ────────────────────────────

function decodeFloatList(v: Value): number[] {
  if (v.kind !== "list") throw new Error(`expected list, got kind=${v.kind}`);
  return v.items.map((it) => {
    if (it.kind !== "float64") throw new Error(`expected float64, got kind=${it.kind}`);
    return float64ToNumber(it);
  });
}

function decodeFloatMatrix(v: Value): number[][] {
  if (v.kind !== "list") throw new Error(`expected list-of-list, got kind=${v.kind}`);
  return v.items.map(decodeFloatList);
}

function decodeStringList(v: Value): string[] {
  if (v.kind !== "list") throw new Error(`expected list, got kind=${v.kind}`);
  return v.items.map((it) => {
    if (it.kind !== "string") throw new Error(`expected string, got kind=${it.kind}`);
    return it.value;
  });
}

function decodeFloat(v: Value): number {
  if (v.kind !== "float64") throw new Error(`expected float64, got kind=${v.kind}`);
  return float64ToNumber(v);
}

function decodeString(v: Value): string {
  if (v.kind !== "string") throw new Error(`expected string, got kind=${v.kind}`);
  return v.value;
}

function decodeInt(v: Value): number {
  if (v.kind !== "integer") throw new Error(`expected integer, got kind=${v.kind}`);
  return Number(v.value);
}

function decodeOutput(v: Value): Record<string, unknown> {
  if (v.kind === "tagged") {
    throw new Error(
      `tool returned tagged boundary "${v.tag}" — bench treats this as failure`,
    );
  }
  if (v.kind !== "record") {
    throw new Error(`expected record, got kind=${v.kind}`);
  }
  const f = v.fields;
  return {
    U: decodeFloatMatrix(f["U"]!),
    S: decodeFloatList(f["S"]!),
    Vt: decodeFloatMatrix(f["Vt"]!),
    mode: decodeString(f["mode"]!),
    reconstruction_error: decodeFloat(f["reconstruction_error"]!),
    orthogonality_error_U: decodeFloat(f["orthogonality_error_U"]!),
    orthogonality_error_Vt: decodeFloat(f["orthogonality_error_Vt"]!),
    condition_number: decodeFloat(f["condition_number"]!),
    rank_estimate: decodeInt(f["rank_estimate"]!),
    method: decodeString(f["method"]!),
    warnings: decodeStringList(f["warnings"]!),
  };
}

// ─── main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const raw = JSON.parse(readFileSync(0, "utf8")) as {
    A: readonly (readonly number[])[];
    mode?: string;
  };
  const input = encodeInput(raw);

  const wb = await loadWorkbench();
  const out = await wb.run("linalg-svd", input);

  const decoded = decodeOutput(out);
  process.stdout.write(JSON.stringify(decoded) + "\n");
}

await main();
