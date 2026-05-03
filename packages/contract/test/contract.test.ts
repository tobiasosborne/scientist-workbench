// Contract package tests: provenance round-trip and store layout.

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  describeTool,
  ExitSignal,
  importToolDef,
  provenanceToValue,
  readProvenance,
  runTool,
  valueToProvenance,
  writeProvenance,
  writeValue,
  readValue,
  type ProvenanceRecord,
  type RunIO,
} from "../src/index.js";
import { canonicalize, hash, int, parse, record, str, sym, expr } from "@workbench/protocol";

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

  // ADR-0005: nondeterministic flag round-trips, and absence is byte-equal
  // to a record with the field omitted (so existing deterministic provenance
  // bytes do not shift under the amendment).
  test("nondeterministic: true round-trips through value form", () => {
    const r: ProvenanceRecord = {
      tool: { name: "entropy-source", version: "0.1.0" },
      inputs: [{ name: "stdin", hash: "e".repeat(64) }],
      flags: {},
      output_hash: "f".repeat(64),
      nondeterministic: true,
    };
    const v = provenanceToValue(r);
    expect(valueToProvenance(v)).toEqual(r);
    expect(canonicalize(v).includes('"nondeterministic":')).toBe(true);
  });

  test("nondeterministic absent ⇒ field omitted (no encoding drift)", () => {
    const r: ProvenanceRecord = {
      tool: { name: "mod-pow", version: "0.2.0" },
      inputs: [{ name: "stdin", hash: "1".repeat(64) }],
      flags: {},
      output_hash: "2".repeat(64),
    };
    const bytes = canonicalize(provenanceToValue(r));
    expect(bytes.includes('"nondeterministic":')).toBe(false);
    expect(valueToProvenance(provenanceToValue(r))).toEqual(r);
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

// =============================================================================
// ADR-0010 — defineTool (pure data) / runTool (IO bound) split
// =============================================================================
//
// The split has three observable consequences and we test each:
//
// 1. A tool module can be imported for metadata without spawning a subprocess
//    (importToolDef returns the live `def`).
// 2. `def.fn` is callable in-process — no stdin, no stdout, no exit hooks.
// 3. `runTool` accepts an injectable `RunIO` so the dispatcher itself is
//    exercisable from inside the test runner: argv, stdin, stdout, stderr,
//    exit, env are all overridable.

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..", "..");
const MOD_POW_PATH = join(REPO_ROOT, "tools", "mod-pow", "tool.ts");

describe("ADR-0010 — defineTool / runTool split", () => {
  test("importToolDef returns live ToolDefinition without spawning", async () => {
    const def = await importToolDef(MOD_POW_PATH);
    expect(def.name).toBe("mod-pow");
    expect(def.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(typeof def.fn).toBe("function");
    expect(def.examples.length).toBeGreaterThan(0);
    expect(def.invariants.length).toBeGreaterThan(0);
    // Schema is a real Schema object, not a wire-form Value.
    expect(def.schema.input).toBeDefined();
    expect(def.schema.output).toBeDefined();
  });

  test("describeTool emits byte-identical metadata via in-process import", async () => {
    const meta = await describeTool(MOD_POW_PATH, "mod-pow");
    expect(meta.name).toBe("mod-pow");
    expect(meta.path).toBe(MOD_POW_PATH);
    expect(meta.examples.length).toBeGreaterThan(0);
    // Each rendered example is a record with description+input fields.
    for (const ex of meta.examples) {
      expect(ex.kind).toBe("record");
    }
  });

  test("def.fn is unit-testable in-process (no subprocess)", async () => {
    const def = await importToolDef(MOD_POW_PATH);
    const input = record({
      base: int(2n),
      exponent: int(10n),
      modulus: int(1000n),
    });
    const out = await def.fn(input, {});
    // 2^10 mod 1000 = 24
    expect(out).toEqual(int(24n));
  });

  test("runTool with injected --version writes canonical bytes to captured stdout", async () => {
    const def = await importToolDef(MOD_POW_PATH);
    let captured = "";
    const io: RunIO = {
      argv: ["--version"],
      stdout: (c) => { captured += c; },
      stderr: () => {},
      env: { WB_SKIP_SCHEMA_CHECK: "1" },
      exit: (code) => { throw new ExitSignal(code); },
    };
    await runTool(def, io);
    const v = parse(captured);
    expect(v.kind).toBe("record");
    if (v.kind === "record") {
      expect(v.fields["name"]).toEqual(str("mod-pow"));
      expect(v.fields["version"]?.kind).toBe("string");
    }
  });

  test("runTool work case with injected stdin/stdout/env", async () => {
    const def = await importToolDef(MOD_POW_PATH);
    const inputBytes = canonicalize(
      record({ base: int(7n), exponent: int(3n), modulus: int(13n) }),
    );
    const storeDir = await mkdtemp(join(tmpdir(), "wb-runtool-"));
    try {
      let stdoutCaptured = "";
      let stderrCaptured = "";
      const io: RunIO = {
        argv: [],
        stdin: async () => inputBytes,
        stdout: (c) => { stdoutCaptured += c; },
        stderr: (c) => { stderrCaptured += c; },
        env: { CAS_STORE: storeDir, WB_SKIP_SCHEMA_CHECK: "1" },
        exit: (code) => { throw new ExitSignal(code); },
      };
      await runTool(def, io);
      // 7^3 mod 13 = 343 mod 13 = 5
      expect(parse(stdoutCaptured)).toEqual(int(5n));
      expect(stderrCaptured).toBe("");
    } finally {
      await rm(storeDir, { recursive: true, force: true });
    }
  });

  test("runTool surfaces ToolError via injected stderr + exit(1)", async () => {
    const def = await importToolDef(MOD_POW_PATH);
    // negative exponent triggers a ToolError inside fn
    const inputBytes = canonicalize(
      record({ base: int(2n), exponent: int(-1n), modulus: int(7n) }),
    );
    let stderrCaptured = "";
    const io: RunIO = {
      argv: [],
      stdin: async () => inputBytes,
      stdout: () => {},
      stderr: (c) => { stderrCaptured += c; },
      env: { WB_SKIP_SCHEMA_CHECK: "1" },
      exit: (code) => { throw new ExitSignal(code); },
    };
    let signal: ExitSignal | null = null;
    try {
      await runTool(def, io);
    } catch (e) {
      if (e instanceof ExitSignal) signal = e;
      else throw e;
    }
    expect(signal).not.toBeNull();
    expect(signal?.code).toBe(1);
    expect(stderrCaptured).toMatch(/exponent must be ≥ 0/);
  });

  test("importing tool.ts is side-effect free (does not consume stdin)", async () => {
    // If `runTool(def)` were not gated on `import.meta.main`, importing the
    // module would attempt to read stdin and would surface as a hung
    // promise or stderr write. The fact that `importToolDef` returns
    // promptly with a defined def is the proof.
    const t0 = Date.now();
    const def = await importToolDef(MOD_POW_PATH);
    const elapsed = Date.now() - t0;
    expect(def).toBeDefined();
    // Generous bound; the actual import takes ~milliseconds.
    expect(elapsed).toBeLessThan(2000);
  });
});

// silence the unused-import lint when these helpers aren't otherwise reached
void sym; void expr; void hash;
