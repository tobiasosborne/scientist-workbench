// Provenance record: tool + inputs + flags + output_hash.
// On-disk layout indexed by output_hash so `--provenance-of <hash>` is O(1).
// See PRD §3.2.
//
// The optional `nondeterministic` field surfaces ADR-0005's externalised-
// entropy convention into the on-disk record. When the flag is absent (the
// default for every existing tool) the contract promises that re-executing
// the same tool version on the same inputs yields the same output bytes;
// the `output_hash` is therefore re-derivable from inputs alone. When
// `nondeterministic: true`, that promise is relaxed for this one record:
// the tool consumed OS-randomness, the captured `output_hash` was a single
// observed sample, and re-execution will diverge. We omit the field rather
// than encoding `false` so deterministic provenance bytes stay byte-equal
// to their pre-amendment form (canonical encoding sorts keys; an extra
// always-present field would shift bytes for every existing record).
//
// The optional `platform` field surfaces ADR-0015's numerical-tier
// fingerprint into the on-disk record. Same omitted-when-absent
// convention: symbolic records keep their pre-ADR-0015 bytes byte-
// identical. When present, it carries `{arch, os, runtime}` — the
// running platform that produced this output. `runMemoized`'s lookup
// uses it to decide whether a stored hit is admissible from the
// running platform's perspective.

import {
  bool,
  canonicalize,
  list,
  parse,
  ProtocolError,
  record,
  str,
  type Hash,
  type Value,
} from "@workbench/protocol";
import { type PlatformRecord, platformToValue, valueToPlatform } from "./platform.js";
import { readRawProvenance, writeRawProvenance } from "./store.js";

export interface ProvenanceRecord {
  tool: { name: string; version: string };
  inputs: { name: string; hash: Hash }[];
  flags: Record<string, string>;
  output_hash: Hash;
  nondeterministic?: boolean;
  platform?: PlatformRecord;
}

export function provenanceToValue(r: ProvenanceRecord): Value {
  const flagFields: Record<string, Value> = {};
  for (const [k, v] of Object.entries(r.flags)) flagFields[k] = str(v);
  const fields: Record<string, Value> = {
    flags: record(flagFields),
    inputs: list(r.inputs.map((i) => record({ hash: str(i.hash), name: str(i.name) }))),
    output_hash: str(r.output_hash),
    tool: record({ name: str(r.tool.name), version: str(r.tool.version) }),
  };
  if (r.nondeterministic === true) fields["nondeterministic"] = bool(true);
  if (r.platform !== undefined) fields["platform"] = platformToValue(r.platform);
  return record(fields);
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

  const out: ProvenanceRecord = {
    tool: {
      name: asString(tool.fields["name"], "tool.name"),
      version: asString(tool.fields["version"], "tool.version"),
    },
    inputs: inputsOut,
    flags: flagsOut,
    output_hash: asString(f["output_hash"], "output_hash"),
  };
  const nd = f["nondeterministic"];
  if (nd !== undefined) {
    if (nd.kind !== "boolean") {
      throw new ProtocolError(`provenance.nondeterministic not a boolean (got ${nd.kind})`);
    }
    if (nd.value === true) out.nondeterministic = true;
  }
  const plat = f["platform"];
  if (plat !== undefined) {
    out.platform = valueToPlatform(plat);
  }
  return out;
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
