// =============================================================================
// bench/linalg-qr/run-candidate.ts — bench wire-format adapter
// =============================================================================
//
// Bridges the bench's language-neutral JSON wire format
//
//   in:  { "A": [[float, ...], ...], "mode"?: "reduced" | "complete" }
//   out: { "Q": [[float, ...], ...], "R": ..., "mode": ...,
//          "diagonal_R": ..., "reconstruction_error": ...,
//          "orthogonality_error": ..., "method": ..., "warnings": [...] }
//
// to the canonical Value protocol that the actual `tools/linalg-qr/`
// tool speaks.  Reads one JSON object on stdin, encodes it as a
// canonical Value, calls the tool in-process via `@workbench/compose`,
// decodes the output Value back to raw JSON, writes one JSON object
// on stdout.  Used by `bench/infra/run-bench.sh` so the bench can
// drive the tool the way an external caller would.
//
// In-process invocation (vs subprocess) is the right call here
// because:
//   - the bench runs 49 cases per invocation; cumulative subprocess
//     overhead would dominate;
//   - the harness already starts one adapter process per case (49
//     loadWorkbench calls × ~150 ms = ~7s overhead, acceptable);
//   - in-process and subprocess paths are byte-identical by
//     construction (ADR-0012, executeToolDef), so the choice is
//     purely about cost.
//
// The adapter discovers `linalg-qr` automatically via `loadWorkbench`;
// no codegen step is required between writing `tools/linalg-qr/tool.ts`
// and running the bench.
//
// Boundary behaviour: any error from the tool (ToolError, tagged
// boundary, schema validation failure) is re-thrown so the bench
// harness sees a non-zero exit.  The bench's `golden/verify.py` then
// reports `candidate command exited non-zero`.

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
  if (v.kind !== "list") {
    throw new Error(`expected list, got kind=${v.kind}`);
  }
  return v.items.map((it) => {
    if (it.kind !== "float64") {
      throw new Error(`expected float64, got kind=${it.kind}`);
    }
    return float64ToNumber(it);
  });
}

function decodeFloatMatrix(v: Value): number[][] {
  if (v.kind !== "list") {
    throw new Error(`expected list-of-list, got kind=${v.kind}`);
  }
  return v.items.map(decodeFloatList);
}

function decodeStringList(v: Value): string[] {
  if (v.kind !== "list") {
    throw new Error(`expected list, got kind=${v.kind}`);
  }
  return v.items.map((it) => {
    if (it.kind !== "string") {
      throw new Error(`expected string, got kind=${it.kind}`);
    }
    return it.value;
  });
}

function decodeFloat(v: Value): number {
  if (v.kind !== "float64") {
    throw new Error(`expected float64, got kind=${v.kind}`);
  }
  return float64ToNumber(v);
}

function decodeString(v: Value): string {
  if (v.kind !== "string") {
    throw new Error(`expected string, got kind=${v.kind}`);
  }
  return v.value;
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
    Q: decodeFloatMatrix(f["Q"]!),
    R: decodeFloatMatrix(f["R"]!),
    mode: decodeString(f["mode"]!),
    diagonal_R: decodeFloatList(f["diagonal_R"]!),
    reconstruction_error: decodeFloat(f["reconstruction_error"]!),
    orthogonality_error: decodeFloat(f["orthogonality_error"]!),
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
  const out = await wb.run("linalg-qr", input);

  const decoded = decodeOutput(out);
  process.stdout.write(JSON.stringify(decoded) + "\n");
}

await main();
