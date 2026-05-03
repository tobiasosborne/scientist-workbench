// Contract package tests: provenance round-trip and store layout.

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  describeTool,
  defineTool,
  ExitSignal,
  F,
  FlagParseError,
  importToolDef,
  parseFlagsFromArgv,
  provenanceToValue,
  readProvenance,
  renderFlagsHelp,
  runTool,
  valueToProvenance,
  writeProvenance,
  writeValue,
  readValue,
  type FlagsOf,
  type ProvenanceRecord,
  type RunIO,
} from "../src/index.js";
import { S } from "@workbench/protocol";
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

// =============================================================================
// ADR-0011 — typed flag declarations
// =============================================================================
//
// The parser is exhaustive over four kinds × five argv forms (switch,
// flag=value, flag value, missing, unknown) plus enum/int validation.
// Each test names the form being exercised and asserts the typed
// object's shape.

describe("ADR-0011 — typed flag parser", () => {
  test("F.bool: present=true, absent=false (never undefined)", () => {
    const decl = { verbose: F.bool("verbose mode") };
    const present = parseFlagsFromArgv(["--verbose"], decl);
    expect(present.flags.verbose).toBe(true);
    expect(present.explicit["verbose"]).toBe("true");
    const absent = parseFlagsFromArgv([], decl);
    expect(absent.flags.verbose).toBe(false);
    expect(absent.explicit["verbose"]).toBeUndefined();
  });

  test("F.bool: =value form rejected", () => {
    const decl = { verbose: F.bool("verbose mode") };
    expect(() => parseFlagsFromArgv(["--verbose=true"], decl)).toThrow(FlagParseError);
  });

  test("F.str: --flag value (space-separated) and --flag=value both work", () => {
    const decl = { name: F.str("a name") };
    expect(parseFlagsFromArgv(["--name", "alice"], decl).flags.name).toBe("alice");
    expect(parseFlagsFromArgv(["--name=alice"], decl).flags.name).toBe("alice");
  });

  test("F.str: with default present when absent", () => {
    const decl = { mode: F.str("mode", { default: "exact" }) };
    const r = parseFlagsFromArgv([], decl);
    expect(r.flags.mode).toBe("exact");
    expect(r.explicit["mode"]).toBeUndefined();  // default is not 'explicit'
  });

  test("F.str: without default is undefined when absent", () => {
    const decl = { name: F.str("optional name") };
    const r = parseFlagsFromArgv([], decl);
    expect(r.flags.name).toBeUndefined();
  });

  test("F.int: parses base-10 integers including negatives", () => {
    const decl = { shots: F.int("number of shots") };
    expect(parseFlagsFromArgv(["--shots", "100"], decl).flags.shots).toBe(100n);
    expect(parseFlagsFromArgv(["--shots=-5"], decl).flags.shots).toBe(-5n);
    expect(parseFlagsFromArgv(["--shots", "-5"], decl).flags.shots).toBe(-5n);
  });

  test("F.int: strips underscores (--shots=10_000)", () => {
    const decl = { shots: F.int("shots") };
    expect(parseFlagsFromArgv(["--shots=10_000"], decl).flags.shots).toBe(10000n);
    expect(parseFlagsFromArgv(["--shots", "1_000_000"], decl).flags.shots).toBe(1000000n);
  });

  test("F.int: rejects non-integer values", () => {
    const decl = { shots: F.int("shots") };
    expect(() => parseFlagsFromArgv(["--shots=abc"], decl)).toThrow(FlagParseError);
    expect(() => parseFlagsFromArgv(["--shots=1.5"], decl)).toThrow(FlagParseError);
  });

  test("F.int: enforces declared min/max bounds", () => {
    const decl = { shots: F.int("shots", { min: 1n, max: 1000n }) };
    expect(() => parseFlagsFromArgv(["--shots=0"], decl)).toThrow(/below declared minimum/);
    expect(() => parseFlagsFromArgv(["--shots=1001"], decl)).toThrow(/above declared maximum/);
    expect(parseFlagsFromArgv(["--shots=500"], decl).flags.shots).toBe(500n);
  });

  test("F.enum: accepts declared values, rejects others", () => {
    const decl = { mode: F.enum(["exact", "structural"] as const, "comparison mode") };
    expect(parseFlagsFromArgv(["--mode=exact"], decl).flags.mode).toBe("exact");
    expect(parseFlagsFromArgv(["--mode", "structural"], decl).flags.mode).toBe("structural");
    expect(() => parseFlagsFromArgv(["--mode=loose"], decl)).toThrow(FlagParseError);
  });

  test("F.enum: with default", () => {
    const decl = { mode: F.enum(["exact", "structural"] as const, "mode", { default: "exact" }) };
    expect(parseFlagsFromArgv([], decl).flags.mode).toBe("exact");
  });

  test("unknown flag rejected with suggestion listing valid flags", () => {
    const decl = { mode: F.str("mode"), shots: F.int("shots") };
    let err: FlagParseError | null = null;
    try { parseFlagsFromArgv(["--moed=exact"], decl); }
    catch (e) { if (e instanceof FlagParseError) err = e; }
    expect(err).not.toBeNull();
    expect(err?.message).toMatch(/unknown flag --moed/);
    expect(err?.suggestion).toMatch(/--mode.*--shots|--shots.*--mode/);
  });

  test("value flag missing its value rejected", () => {
    const decl = { name: F.str("name") };
    expect(() => parseFlagsFromArgv(["--name"], decl)).toThrow(/requires a value/);
  });

  test("strict arity: --bool followed by positional leaves positional", () => {
    const decl = { equal: F.bool("equality flag") };
    const r = parseFlagsFromArgv(["--equal", "1"], decl);
    expect(r.flags.equal).toBe(true);
    expect(r.positional).toEqual(["1"]);
  });

  test("-h alias resolves to --help in explicit map", () => {
    const decl = { help: F.bool("show help") };
    const r = parseFlagsFromArgv(["-h"], decl);
    expect(r.flags.help).toBe(true);
    expect(r.explicit["help"]).toBe("true");
  });

  test("renderFlagsHelp aligns columns and reports defaults", () => {
    const decl = {
      verbose: F.bool("show extra detail"),
      shots: F.int("number of shots", { default: 100n }),
      mode: F.enum(["exact", "structural"] as const, "comparison mode", { default: "exact" }),
    };
    const lines = renderFlagsHelp(decl);
    expect(lines.length).toBe(3);
    expect(lines.join("\n")).toMatch(/--shots <int> \(default: 100\)/);
    expect(lines.join("\n")).toMatch(/--mode <"exact"\|"structural"> \(default: "exact"\)/);
  });

  // Type-level fixture: this code only typechecks if the inference
  // is correct. The runtime asserts are duplicates of earlier tests;
  // the value here is the static type assignment.
  test("FlagsOf<F> inference: defaults non-undefined, enum literals preserved", () => {
    const decl = {
      verbose: F.bool("v"),
      shots: F.int("s", { default: 100n }),
      mode: F.enum(["exact", "structural"] as const, "m", { default: "exact" }),
      name: F.str("n"),
    } as const;
    type Flags = FlagsOf<typeof decl>;
    // Compile-time: these assignments only typecheck if inference is right.
    const fixture: Flags = {
      verbose: true,
      shots: 100n,
      mode: "exact",
      name: undefined,  // no default → string | undefined
    };
    expect(fixture.verbose).toBe(true);
    expect(fixture.shots).toBe(100n);
    expect(fixture.mode).toBe("exact");
    expect(fixture.name).toBeUndefined();
  });
});

// =============================================================================
// runTool end-to-end with a tool that declares flags
// =============================================================================
//
// Build a minimal in-memory tool with one flag of each kind, then drive
// it through runTool with various argv shapes. Catches integration bugs
// the parser tests can miss (merge with std flags, dispatch, provenance).

describe("ADR-0011 — runTool with declared flags", () => {
  const echoDef = defineTool({
    name: "test-echo",
    version: "0.0.1",
    schema: {
      input: S.kind("string"),
      output: S.record({
        echoed: S.kind("string"),
        verbose: S.kind("boolean"),
        shots: S.kind("integer"),
        mode: S.kind("string"),
      }),
    },
    flags: {
      verbose: F.bool("emit detail"),
      shots: F.int("number of shots", { default: 100n }),
      mode: F.enum(["fast", "slow"] as const, "speed", { default: "fast" }),
    },
    examples: [
      {
        description: "round-trip with defaults",
        input: str("hi"),
        output: record({
          echoed: str("hi"),
          verbose: { kind: "boolean", value: false },
          shots: int(100n),
          mode: str("fast"),
        }),
      },
    ],
    invariants: [{ name: "echoes-input", statement: "echoed == input.value", machine_checkable: true }],
    fn: (input, flags) => record({
      echoed: input,
      verbose: { kind: "boolean", value: flags.verbose },
      shots: int(flags.shots),
      mode: str(flags.mode),
    }),
  });

  test("defaults applied when no flags passed", async () => {
    let captured = "";
    const storeDir = await mkdtemp(join(tmpdir(), "wb-runtool-flags-"));
    try {
      await runTool(echoDef, {
        argv: [],
        stdin: async () => canonicalize(str("hi")),
        stdout: (c) => { captured += c; },
        stderr: () => {},
        env: { CAS_STORE: storeDir },
        exit: (code) => { throw new ExitSignal(code); },
      });
      const v = parse(captured);
      expect(v.kind).toBe("record");
      if (v.kind === "record") {
        expect(v.fields["verbose"]).toEqual({ kind: "boolean", value: false });
        expect(v.fields["shots"]).toEqual(int(100n));
        expect(v.fields["mode"]).toEqual(str("fast"));
      }
    } finally {
      await rm(storeDir, { recursive: true, force: true });
    }
  });

  test("explicit flags override defaults; provenance records only explicit", async () => {
    let captured = "";
    const storeDir = await mkdtemp(join(tmpdir(), "wb-runtool-flags-"));
    try {
      await runTool(echoDef, {
        argv: ["--verbose", "--shots=10_000", "--mode", "slow"],
        stdin: async () => canonicalize(str("hello")),
        stdout: (c) => { captured += c; },
        stderr: () => {},
        env: { CAS_STORE: storeDir },
        exit: (code) => { throw new ExitSignal(code); },
      });
      const v = parse(captured);
      if (v.kind === "record") {
        expect(v.fields["verbose"]).toEqual({ kind: "boolean", value: true });
        expect(v.fields["shots"]).toEqual(int(10000n));
        expect(v.fields["mode"]).toEqual(str("slow"));
      }
      // Provenance: only explicit tool flags recorded (verbose, shots, mode all explicit here)
      const outputHash = hash(v);
      const rec = await readProvenance(storeDir, outputHash);
      expect(rec).not.toBeNull();
      expect(rec?.flags).toEqual({ verbose: "true", shots: "10_000", mode: "slow" });
    } finally {
      await rm(storeDir, { recursive: true, force: true });
    }
  });

  test("unknown flag triggers loud rejection on stderr + exit 1", async () => {
    let stderrCaptured = "";
    let signal: ExitSignal | null = null;
    try {
      await runTool(echoDef, {
        argv: ["--moed=exact"],
        stdin: async () => canonicalize(str("hi")),
        stdout: () => {},
        stderr: (c) => { stderrCaptured += c; },
        env: { WB_SKIP_SCHEMA_CHECK: "1" },
        exit: (code) => { throw new ExitSignal(code); },
      });
    } catch (e) {
      if (e instanceof ExitSignal) signal = e;
      else throw e;
    }
    expect(signal?.code).toBe(1);
    expect(stderrCaptured).toMatch(/unknown flag --moed/);
  });

  test("--help renders standard + tool flags", async () => {
    let captured = "";
    await runTool(echoDef, {
      argv: ["--help"],
      stdin: async () => "",
      stdout: (c) => { captured += c; },
      stderr: () => {},
      env: { WB_SKIP_SCHEMA_CHECK: "1" },
      exit: (code) => { throw new ExitSignal(code); },
    });
    expect(captured).toMatch(/Standard flags:/);
    expect(captured).toMatch(/Tool flags:/);
    expect(captured).toMatch(/--verbose/);
    expect(captured).toMatch(/--shots <int> \(default: 100\)/);
    expect(captured).toMatch(/--mode/);
  });

  test("standard-flag collision in tool def fails fast at runTool entry", async () => {
    const collidingDef = defineTool({
      name: "test-collide",
      version: "0.0.1",
      schema: { input: S.kind("string"), output: S.kind("string") },
      flags: { version: F.bool("conflicts with std --version") },
      examples: [{ description: "x", input: str("x"), output: str("x") }],
      invariants: [],
      fn: (input) => input,
    });
    let stderrCaptured = "";
    let signal: ExitSignal | null = null;
    try {
      await runTool(collidingDef, {
        argv: ["--help"],
        stdin: async () => "",
        stdout: () => {},
        stderr: (c) => { stderrCaptured += c; },
        env: { WB_SKIP_SCHEMA_CHECK: "1" },
        exit: (code) => { throw new ExitSignal(code); },
      });
    } catch (e) {
      if (e instanceof ExitSignal) signal = e;
      else throw e;
    }
    expect(signal?.code).toBe(1);
    expect(stderrCaptured).toMatch(/collides with a standard flag/);
  });
});

// silence the unused-import lint when these helpers aren't otherwise reached
void sym; void expr;
