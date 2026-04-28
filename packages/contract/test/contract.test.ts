// Contract package tests: provenance round-trip and store layout.

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  provenanceToValue,
  readProvenance,
  valueToProvenance,
  writeProvenance,
  writeValue,
  readValue,
  type ProvenanceRecord,
} from "../src/index.js";
import { canonicalize, hash, sym, str, expr, int, parse } from "@workbench/protocol";

let storeDir: string;

beforeAll(async () => {
  storeDir = await mkdtemp(join(tmpdir(), "wb-store-"));
});

afterAll(async () => {
  await rm(storeDir, { recursive: true, force: true });
});

describe("provenance value round-trip", () => {
  test("provenanceToValue ∘ valueToProvenance = id", () => {
    const r: ProvenanceRecord = {
      tool: { name: "cas-verify", version: "0.1.0" },
      inputs: [{ name: "stdin", hash: "a".repeat(64) }],
      flags: { mode: "exact" },
      output_hash: "b".repeat(64),
    };
    const v = provenanceToValue(r);
    const back = valueToProvenance(v);
    expect(back).toEqual(r);
  });

  test("provenance value canonicalises deterministically", () => {
    const r: ProvenanceRecord = {
      tool: { name: "x", version: "0.0.1" },
      inputs: [],
      flags: {},
      output_hash: "0".repeat(64),
    };
    const a = canonicalize(provenanceToValue(r));
    const b = canonicalize(provenanceToValue(r));
    expect(a).toBe(b);
  });
});

describe("CAS store", () => {
  test("writeValue/readValue round-trip", async () => {
    const v = expr("plus", [sym("x"), int(1n)]);
    const h = await writeValue(storeDir, v);
    expect(h).toBe(hash(v));
    const back = await readValue(storeDir, h);
    expect(back).toEqual(v);
  });

  test("readValue returns null for unknown hash", async () => {
    expect(await readValue(storeDir, "0".repeat(64))).toBeNull();
  });

  test("writeProvenance/readProvenance round-trip", async () => {
    const r: ProvenanceRecord = {
      tool: { name: "demo", version: "1.0.0" },
      inputs: [{ name: "stdin", hash: "c".repeat(64) }],
      flags: { x: "y" },
      output_hash: "d".repeat(64),
    };
    await writeProvenance(storeDir, r);
    const back = await readProvenance(storeDir, r.output_hash);
    expect(back).toEqual(r);
  });

  test("readProvenance returns null for unknown hash", async () => {
    expect(await readProvenance(storeDir, "9".repeat(64))).toBeNull();
  });
});

describe("argv handling indirection (smoke)", () => {
  test("provenance value parses round-trip cleanly", () => {
    const r: ProvenanceRecord = {
      tool: { name: "t", version: "0.0.0" },
      inputs: [{ name: "a", hash: "1".repeat(64) }],
      flags: { k: "v" },
      output_hash: "2".repeat(64),
    };
    const v = provenanceToValue(r);
    const bytes = canonicalize(v);
    const reparsed = parse(bytes);
    expect(valueToProvenance(reparsed)).toEqual(r);
    expect(str("k").kind).toBe("string");
  });
});
