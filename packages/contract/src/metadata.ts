// =============================================================================
// metadata — render a ToolDefinition's metadata into wire-form Values
// =============================================================================
//
// `exampleToValue` and `invariantToValue` translate the typed
// `ExampleEntry` / `InvariantEntry` records that tool authors write
// (TS shapes with branded `description`, optional `output`, optional
// `error`, optional `flags`) into the canonical wire form a registry
// consumer or `--examples` / `--invariants` reader expects.
//
// Why this lives in its own module
// --------------------------------
// Both the runner (which serves `--examples` / `--invariants` from a
// running tool) and the registry (which reads the same metadata
// in-process from an imported `def`) need to produce byte-identical
// output. Lifting the helpers out of `runner.ts` keeps the registry
// from having to import the runner's whole module — which would pull
// in stdin/stdout machinery the registry has no business touching —
// and makes the canonical encoding a single source of truth.
//
// ADR-0010: tool entry points export `def` directly, so the registry
// reads `def.examples` / `def.invariants` and renders them via these
// helpers without spawning a subprocess.

import { bool, record, str, type Value } from "@workbench/protocol";
import type { ExampleEntry, InvariantEntry } from "./runner.js";

export function exampleToValue(e: ExampleEntry): Value {
  const fields: Record<string, Value> = {
    description: str(e.description),
    input: e.input,
  };
  if (e.output !== undefined) fields["output"] = e.output;
  if (e.error !== undefined) fields["error"] = str(e.error);
  if (e.flags !== undefined) {
    const ff: Record<string, Value> = {};
    for (const [k, v] of Object.entries(e.flags)) ff[k] = str(v);
    fields["flags"] = record(ff);
  }
  return record(fields);
}

export function invariantToValue(inv: InvariantEntry): Value {
  const fields: Record<string, Value> = {
    name: str(inv.name),
    statement: str(inv.statement),
  };
  if (inv.machine_checkable !== undefined) {
    fields["machine_checkable"] = bool(inv.machine_checkable);
  }
  return record(fields);
}
