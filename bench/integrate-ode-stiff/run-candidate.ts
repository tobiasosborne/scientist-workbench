// =============================================================================
// bench/integrate-ode-stiff/run-candidate.ts — bench wire-format adapter
// =============================================================================
//
// Mirrors `bench/integrate-ode-ivp/run-candidate.ts` with stiff-specific
// fields: `n_jacobian_evals` and `n_lu_decompositions` in output, optional
// `options.method` and `options.jacobian` in input.

import { readFileSync } from "node:fs";
import { loadWorkbench } from "@workbench/compose";
import {
  float64FromNumber,
  float64ToNumber,
  list,
  record,
  str,
  sym,
  type Value,
} from "@workbench/protocol";

interface RawInput {
  f_str: readonly string[];
  vars: readonly string[];
  t_var: string;
  y0: readonly number[];
  t_span: { t0: number; tf: number };
  options?: {
    rtol?: number;
    atol?: number;
    max_step?: number;
    t_eval?: readonly number[];
    method?: string;
    jacobian?: readonly (readonly string[])[];
  };
}

async function parseExpressionString(
  wb: Awaited<ReturnType<typeof loadWorkbench>>,
  s: string,
): Promise<Value> {
  return await wb.run("expr-parse", str(s));
}

async function encodeInput(
  wb: Awaited<ReturnType<typeof loadWorkbench>>,
  raw: RawInput,
): Promise<Value> {
  const fields: Record<string, Value> = {
    f: list(await Promise.all(raw.f_str.map((s) => parseExpressionString(wb, s)))),
    vars: list(raw.vars.map((v) => sym(v))),
    t_var: sym(raw.t_var),
    y0: list(raw.y0.map((x) => float64FromNumber(x))),
    t_span: record({
      t0: float64FromNumber(raw.t_span.t0),
      tf: float64FromNumber(raw.t_span.tf),
    }),
  };

  if (raw.options !== undefined) {
    const optFields: Record<string, Value> = {};
    if (raw.options.rtol !== undefined) optFields.rtol = float64FromNumber(raw.options.rtol);
    if (raw.options.atol !== undefined) optFields.atol = float64FromNumber(raw.options.atol);
    if (raw.options.max_step !== undefined) optFields.max_step = float64FromNumber(raw.options.max_step);
    if (raw.options.t_eval !== undefined) {
      optFields.t_eval = list(raw.options.t_eval.map((x) => float64FromNumber(x)));
    }
    if (raw.options.method !== undefined) optFields.method = str(raw.options.method);
    if (raw.options.jacobian !== undefined) {
      const jacRows: Value[] = [];
      for (const row of raw.options.jacobian) {
        jacRows.push(list(await Promise.all(row.map((s) => parseExpressionString(wb, s)))));
      }
      optFields.jacobian = list(jacRows);
    }
    fields.options = record(optFields);
  }

  return record(fields);
}

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

function decodeInt(v: Value): number {
  if (v.kind !== "integer") throw new Error(`expected integer, got kind=${v.kind}`);
  return Number(v.value);
}

function decodeBool(v: Value): boolean {
  if (v.kind !== "boolean") throw new Error(`expected boolean, got kind=${v.kind}`);
  return v.value;
}

function decodeString(v: Value): string {
  if (v.kind !== "string") throw new Error(`expected string, got kind=${v.kind}`);
  return v.value;
}

function decodeAny(v: Value): unknown {
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
    case "symbol": return v.name;
    default: return null;
  }
}

function decodeOutput(v: Value): Record<string, unknown> {
  if (v.kind === "tagged") {
    return { kind: "tagged", tag: v.tag, payload: decodeAny(v.payload) };
  }
  if (v.kind !== "record") throw new Error(`expected record, got kind=${v.kind}`);
  const f = v.fields;
  return {
    trajectory: decodeFloatMatrix(f["trajectory"]!),
    t_values: decodeFloatList(f["t_values"]!),
    error_estimate: decodeFloat(f["error_estimate"]!),
    n_evals: decodeInt(f["n_evals"]!),
    n_steps_accepted: decodeInt(f["n_steps_accepted"]!),
    n_steps_rejected: decodeInt(f["n_steps_rejected"]!),
    n_jacobian_evals: decodeInt(f["n_jacobian_evals"]!),
    n_lu_decompositions: decodeInt(f["n_lu_decompositions"]!),
    converged: decodeBool(f["converged"]!),
    status: decodeString(f["status"]!),
    method: decodeString(f["method"]!),
    warnings: decodeStringList(f["warnings"]!),
  };
}

async function main(): Promise<void> {
  const raw = JSON.parse(readFileSync(0, "utf8")) as RawInput;
  const wb = await loadWorkbench();

  let input: Value;
  try {
    input = await encodeInput(wb, raw);
  } catch (err) {
    const e = err as Error;
    process.stdout.write(JSON.stringify({
      kind: "tool_error", name: "ExpressionParseFailed", message: e.message,
    }) + "\n");
    return;
  }

  let out: Value;
  try {
    out = await wb.run("integrate-ode-stiff", input);
  } catch (err) {
    const e = err as Error & { name?: string };
    process.stdout.write(JSON.stringify({
      kind: "tool_error", name: e.name ?? "Error", message: e.message ?? String(e),
    }) + "\n");
    return;
  }

  process.stdout.write(JSON.stringify(decodeOutput(out)) + "\n");
}

await main();
