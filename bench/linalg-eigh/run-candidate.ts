// =============================================================================
// bench/linalg-eigh/run-candidate.ts — bench wire-format adapter
// =============================================================================
//
// Bridges raw JSON wire format to the tool's canonical Value protocol.
// Mirrors `bench/linalg-{qr,svd}/run-candidate.ts`.
//
// Tagged-boundary outputs are surfaced to the bench as-is (the verifier
// inspects them via `kind: "tagged"` checks); non-tagged outputs are
// decoded into the success-shape JSON the verifier expects.

import { readFileSync } from "node:fs";
import { loadWorkbench } from "@workbench/compose";
import {
  float64FromNumber,
  float64ToNumber,
  list,
  record,
  type Value,
} from "@workbench/protocol";

// ─── raw JSON → canonical Value (input encoding) ─────────────────────────────

function encodeRow(row: readonly number[]): Value {
  return list(row.map((x) => float64FromNumber(x)));
}

function encodeInput(raw: { A: readonly (readonly number[])[] }): Value {
  return record({ A: list(raw.A.map(encodeRow)) });
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

function decodeAny(v: Value): unknown {
  // Best-effort decode for tagged-boundary payloads. The bench's verifier
  // for tagged boundaries only inspects the tag, but we surface the
  // payload in case future tags carry data the verifier wants.
  switch (v.kind) {
    case "string": return v.value;
    case "integer": return Number(v.value);
    case "float64": return float64ToNumber(v);
    case "boolean": return v.value;
    case "list": return v.items.map(decodeAny);
    case "record": {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v.fields)) out[k] = decodeAny(val as Value);
      return out;
    }
    case "tagged": return { kind: "tagged", tag: v.tag, payload: decodeAny(v.payload) };
    default: return null;
  }
}

function decodeOutput(v: Value): Record<string, unknown> {
  if (v.kind === "tagged") {
    // Surface the tagged boundary as-is; bench verifier handles the
    // category-vs-input check.
    return {
      kind: "tagged",
      tag: v.tag,
      payload: decodeAny(v.payload),
    };
  }
  if (v.kind !== "record") {
    throw new Error(`expected record, got kind=${v.kind}`);
  }
  const f = v.fields;
  return {
    Q: decodeFloatMatrix(f["Q"]!),
    eigenvalues: decodeFloatList(f["eigenvalues"]!),
    reconstruction_error: decodeFloat(f["reconstruction_error"]!),
    orthogonality_error: decodeFloat(f["orthogonality_error"]!),
    condition_number: decodeFloat(f["condition_number"]!),
    method: decodeString(f["method"]!),
    warnings: decodeStringList(f["warnings"]!),
  };
}

// ─── main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const raw = JSON.parse(readFileSync(0, "utf8")) as {
    A: readonly (readonly number[])[];
  };
  const input = encodeInput(raw);

  const wb = await loadWorkbench();
  const out = await wb.run("linalg-eigh", input);

  const decoded = decodeOutput(out);
  process.stdout.write(JSON.stringify(decoded) + "\n");
}

await main();
