// Provenance record: tool + inputs + flags + output_hash.
// On-disk layout indexed by output_hash so `--provenance-of <hash>` is O(1).
// See PRD §3.2.

import {
  canonicalize,
  list,
  parse,
  ProtocolError,
  record,
  str,
  type Hash,
  type Value,
} from "@workbench/protocol";
import { readRawProvenance, writeRawProvenance } from "./store.js";

export interface ProvenanceRecord {
  tool: { name: string; version: string };
  inputs: { name: string; hash: Hash }[];
  flags: Record<string, string>;
  output_hash: Hash;
}

export function provenanceToValue(r: ProvenanceRecord): Value {
  const flagFields: Record<string, Value> = {};
  for (const [k, v] of Object.entries(r.flags)) flagFields[k] = str(v);
  return record({
    flags: record(flagFields),
    inputs: list(r.inputs.map((i) => record({ hash: str(i.hash), name: str(i.name) }))),
    output_hash: str(r.output_hash),
    tool: record({ name: str(r.tool.name), version: str(r.tool.version) }),
  });
}

function asString(v: Value | undefined, where: string): string {
  if (!v) throw new ProtocolError(`provenance: missing ${where}`);
  if (v.kind !== "string") throw new ProtocolError(`provenance: ${where} not a string (got ${v.kind})`);
  return v.value;
}

export function valueToProvenance(v: Value): ProvenanceRecord {
  if (v.kind !== "record") throw new ProtocolError(`provenance: top-level not a record (got ${v.kind})`);
  const f = v.fields;
  const tool = f["tool"];
  if (!tool || tool.kind !== "record") throw new ProtocolError("provenance.tool not a record");
  const inputs = f["inputs"];
  if (!inputs || inputs.kind !== "list") throw new ProtocolError("provenance.inputs not a list");
  const flags = f["flags"];
  if (!flags || flags.kind !== "record") throw new ProtocolError("provenance.flags not a record");

  const flagsOut: Record<string, string> = {};
  for (const [k, fv] of Object.entries(flags.fields)) flagsOut[k] = asString(fv, `flags.${k}`);

  const inputsOut: { name: string; hash: Hash }[] = [];
  for (const item of inputs.items) {
    if (item.kind !== "record") throw new ProtocolError("provenance.inputs[] entry not a record");
    inputsOut.push({
      name: asString(item.fields["name"], "inputs[].name"),
      hash: asString(item.fields["hash"], "inputs[].hash"),
    });
  }

  return {
    tool: {
      name: asString(tool.fields["name"], "tool.name"),
      version: asString(tool.fields["version"], "tool.version"),
    },
    inputs: inputsOut,
    flags: flagsOut,
    output_hash: asString(f["output_hash"], "output_hash"),
  };
}

export async function writeProvenance(store: string, r: ProvenanceRecord): Promise<void> {
  const bytes = canonicalize(provenanceToValue(r));
  await writeRawProvenance(store, r.output_hash, bytes);
}

export async function readProvenance(store: string, outputHash: Hash): Promise<ProvenanceRecord | null> {
  const raw = await readRawProvenance(store, outputHash);
  if (raw === null) return null;
  return valueToProvenance(parse(raw));
}
