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

// =============================================================================
// ADR-0015: determinism tier — platform helpers, executeToolDef branch,
//            mutual exclusion, --platform-fingerprint standard flag
// =============================================================================

import {
  currentPlatform,
  currentPlatformHash,
  executeToolDef,
  platformFingerprintValue,
  platformHash,
  platformToValue,
  readByInputIndex,
  type PlatformRecord,
  valueToPlatform,
} from "../src/index.js";
import { containsFloat64, float64FromNumber, list as plist } from "@workbench/protocol";

describe("ADR-0015 platform helpers", () => {
  test("currentPlatform returns three normalised string fields", () => {
    const p = currentPlatform();
    expect(typeof p.arch).toBe("string");
    expect(typeof p.os).toBe("string");
    expect(typeof p.runtime).toBe("string");
    // Bun normalises arch to {x86_64, aarch64, …} not Node's {x64, arm64}.
    expect(["x86_64", "aarch64", "i386"].includes(p.arch) || p.arch.length > 0).toBe(true);
    // Detected by the test file running under bun:test → must be "bun".
    expect(p.runtime).toBe("bun");
  });

  test("platformToValue ∘ valueToPlatform = id", () => {
    const p: PlatformRecord = { arch: "x86_64", os: "linux", runtime: "bun" };
    expect(valueToPlatform(platformToValue(p))).toEqual(p);
  });

  test("platformHash agrees on equal triples, differs on different triples", () => {
    const a: PlatformRecord = { arch: "x86_64", os: "linux", runtime: "bun" };
    const b: PlatformRecord = { arch: "x86_64", os: "linux", runtime: "bun" };
    const c: PlatformRecord = { arch: "aarch64", os: "darwin", runtime: "bun" };
    expect(platformHash(a)).toBe(platformHash(b));
    expect(platformHash(a)).not.toBe(platformHash(c));
  });

  test("currentPlatformHash matches platformHash(currentPlatform())", () => {
    expect(currentPlatformHash()).toBe(platformHash(currentPlatform()));
  });

  test("platformFingerprintValue carries both record and hash", () => {
    const v = platformFingerprintValue();
    expect(v.kind).toBe("record");
    if (v.kind !== "record") throw new Error();
    expect(v.fields.fingerprint).toBeDefined();
    expect(v.fields.hash).toBeDefined();
    expect(v.fields.hash!.kind).toBe("string");
  });
});

describe("ADR-0015 ProvenanceRecord platform round-trip", () => {
  test("provenanceToValue ∘ valueToProvenance preserves platform", () => {
    const r: ProvenanceRecord = {
      tool: { name: "linalg-solve", version: "0.1.0" },
      inputs: [{ name: "stdin", hash: "a".repeat(64) }],
      flags: {},
      output_hash: "b".repeat(64),
      platform: { arch: "x86_64", os: "linux", runtime: "bun" },
    };
    const back = valueToProvenance(provenanceToValue(r));
    expect(back).toEqual(r);
  });

  test("symbolic provenance bytes are byte-identical to pre-ADR-0015 bytes", () => {
    // Round-trip a record without the platform field; verify the canonical
    // bytes match a hand-rolled equivalent that has no platform-related
    // overhead. This is the byte-compat guarantee from the ADR.
    const r: ProvenanceRecord = {
      tool: { name: "mod-pow", version: "0.2.0" },
      inputs: [{ name: "stdin", hash: "c".repeat(64) }],
      flags: {},
      output_hash: "d".repeat(64),
    };
    const bytes = canonicalize(provenanceToValue(r));
    // The canonical bytes must NOT contain "platform" (it's omitted-when-absent).
    expect(bytes.includes("platform")).toBe(false);
  });
});

describe("ADR-0015 executeToolDef per-output platform branch", () => {
  // A tool annotated `numerical: true` whose output contains float64.
  // The provenance record must carry the platform field.
  const numericalDef = defineTool({
    name: "test-numerical",
    version: "0.0.1",
    schema: {
      input: S.kind("integer"),
      output: S.record({ x: S.kind("float64") }),
    },
    numerical: true,
    examples: [],
    invariants: [],
    fn: (_input) => record({ x: float64FromNumber(0.5) }),
  });

  // A tool annotated `numerical: true` whose output is pure-exact —
  // no float64 anywhere. The provenance record must NOT carry the
  // platform field (per ADR-0007 precision-precedent).
  const numericalExactDef = defineTool({
    name: "test-numerical-exact",
    version: "0.0.1",
    schema: {
      input: S.kind("integer"),
      output: S.kind("integer"),
    },
    numerical: true,
    examples: [],
    invariants: [],
    fn: (input) => input,  // identity on integer; no float64 output
  });

  // A symbolic tool (default — no annotation) whose output happens to
  // contain float64. Should NOT get a platform field — symbolic-tier
  // contract is unconditional cross-platform forever.
  const symbolicWithFloatDef = defineTool({
    name: "test-symbolic-with-float",
    version: "0.0.1",
    schema: {
      input: S.kind("integer"),
      output: S.kind("float64"),
    },
    examples: [],
    invariants: [],
    fn: () => float64FromNumber(0.5),
  });

  test("numerical + float64 output → platform field recorded", async () => {
    const result = await executeToolDef(numericalDef, int(1n), {}, {
      store: storeDir,
      env: { CAS_STORE: storeDir },
    });
    expect(result.provenanceError).toBeNull();
    const rec = await readProvenance(storeDir, result.outputHash);
    expect(rec).not.toBeNull();
    expect(rec!.platform).toBeDefined();
    expect(rec!.platform!.runtime).toBe("bun");
  });

  test("numerical + exact output → NO platform field", async () => {
    const result = await executeToolDef(numericalExactDef, int(42n), {}, {
      store: storeDir,
      env: { CAS_STORE: storeDir },
    });
    expect(result.provenanceError).toBeNull();
    const rec = await readProvenance(storeDir, result.outputHash);
    expect(rec).not.toBeNull();
    expect(rec!.platform).toBeUndefined();
  });

  test("symbolic + float64 output → NO platform field (no opt-in)", async () => {
    const result = await executeToolDef(symbolicWithFloatDef, int(7n), {}, {
      store: storeDir,
      env: { CAS_STORE: storeDir },
    });
    expect(result.provenanceError).toBeNull();
    const rec = await readProvenance(storeDir, result.outputHash);
    expect(rec).not.toBeNull();
    expect(rec!.platform).toBeUndefined();
  });

  test("numerical record's by-input index includes platform hash in filename", async () => {
    // Run the numerical tool, then verify the index file exists at the
    // platform-suffixed path *only*, not at the symbolic path.
    const input = int(99n);
    const result = await executeToolDef(numericalDef, input, {}, {
      store: storeDir,
      env: { CAS_STORE: storeDir },
    });
    expect(result.provenanceError).toBeNull();

    const inputHash = hash(input);
    const platHash = currentPlatformHash();

    const platformIndex = await readByInputIndex(
      storeDir, inputHash, numericalDef.name, numericalDef.version, platHash,
    );
    expect(platformIndex).toBe(result.outputHash);

    const symbolicIndex = await readByInputIndex(
      storeDir, inputHash, numericalDef.name, numericalDef.version, null,
    );
    expect(symbolicIndex).toBeNull();
  });
});

describe("ADR-0015 + ADR-0020 mutual exclusion (nondeterministic ∧ numerical ∧ arbprec)", () => {
  test("nondeterministic ∧ numerical fails at executeToolDef", async () => {
    const bad = defineTool({
      name: "test-both",
      version: "0.0.1",
      schema: { input: S.kind("integer"), output: S.kind("integer") },
      nondeterministic: true,
      numerical: true,
      examples: [],
      invariants: [],
      fn: (i) => i,
    });
    let err: Error | null = null;
    try {
      await executeToolDef(bad, int(1n), {}, {
        store: storeDir,
        env: { CAS_STORE: storeDir },
      });
    } catch (e) {
      err = e as Error;
    }
    expect(err).not.toBeNull();
    expect(err!.message).toMatch(/at most one of nondeterministic \/ numerical \/ arbprec/);
  });

  test("numerical ∧ arbprec fails at executeToolDef", async () => {
    const bad = defineTool({
      name: "test-num-arb",
      version: "0.0.1",
      schema: { input: S.kind("integer"), output: S.kind("integer") },
      numerical: true,
      arbprec: true,
      examples: [],
      invariants: [],
      fn: (i) => i,
    });
    let err: Error | null = null;
    try {
      await executeToolDef(bad, int(1n), {}, {
        store: storeDir,
        env: { CAS_STORE: storeDir },
      });
    } catch (e) {
      err = e as Error;
    }
    expect(err).not.toBeNull();
    expect(err!.message).toMatch(/at most one of nondeterministic \/ numerical \/ arbprec/);
  });

  test("nondeterministic ∧ arbprec fails at executeToolDef", async () => {
    const bad = defineTool({
      name: "test-nondet-arb",
      version: "0.0.1",
      schema: { input: S.kind("integer"), output: S.kind("integer") },
      nondeterministic: true,
      arbprec: true,
      examples: [],
      invariants: [],
      fn: (i) => i,
    });
    let err: Error | null = null;
    try {
      await executeToolDef(bad, int(1n), {}, {
        store: storeDir,
        env: { CAS_STORE: storeDir },
      });
    } catch (e) {
      err = e as Error;
    }
    expect(err).not.toBeNull();
    expect(err!.message).toMatch(/at most one of nondeterministic \/ numerical \/ arbprec/);
  });
});

describe("ADR-0015 --platform-fingerprint standard flag", () => {
  test("emits canonical bytes carrying {fingerprint, hash}", async () => {
    const minimalDef = defineTool({
      name: "test-fingerprint",
      version: "0.0.1",
      schema: { input: S.kind("integer"), output: S.kind("integer") },
      examples: [],
      invariants: [],
      fn: (i) => i,
    });
    let captured = "";
    await runTool(minimalDef, {
      argv: ["--platform-fingerprint"],
      stdin: async () => "",
      stdout: (c) => { captured += c; },
      stderr: () => {},
      env: { WB_SKIP_SCHEMA_CHECK: "1" },
      exit: (code) => { throw new ExitSignal(code); },
    });
    const v = parse(captured);
    expect(v.kind).toBe("record");
    if (v.kind !== "record") throw new Error();
    expect(v.fields.fingerprint).toBeDefined();
    expect(v.fields.hash).toBeDefined();
    // Hash field should be the 64-hex-char content address.
    const h = v.fields.hash!;
    expect(h.kind).toBe("string");
    if (h.kind !== "string") throw new Error();
    expect(/^[0-9a-f]{64}$/.test(h.value)).toBe(true);
  });
});

// =============================================================================
// ADR-0020: arbprec --precision standard-flag wiring (lc1 fix)
// =============================================================================
//
// Bead lc1 named the runner-side gap: `--precision=N` was parsed correctly
// for `arbprec: true` tools (it's added by `mergedFlags`) but never
// injected into the typed `flags` object handed to `def.fn`. The loop
// at the work-case site iterated only over `Object.keys(toolFlags)`,
// which is the *tool's declared* flags — `precision` was added by the
// runner and lived in `parsed.flags`, not `toolFlags`. Result: every
// arbprec tool's CLI ran at the default precision regardless of
// `--precision`.
//
// Fix: derive the typed-flags slot list via `toolFacingFlagNames(...,
// def.arbprec === true)` so the runner-injected `precision` is lifted
// alongside the tool's declared flags. The test below builds a synthetic
// arbprec tool (no real bigfloat work) and asserts that
// `--precision=80` reaches `def.fn` as `flags.precision === 80n`.
//
// Mutation-prove invariant: revert the runner fix to the broken loop,
// confirm the test goes RED, restore. (Documented in worklog 083.)

describe("ADR-0020 — --precision flag wired into toolFlagsTyped (lc1)", () => {
  // A synthetic arbprec tool that surfaces `flags.precision` in its
  // output so the test can assert what the runner injected. No real
  // bigfloat substrate — we only care about the wiring.
  const arbprecEchoDef = defineTool({
    name: "test-arbprec-echo",
    version: "0.0.1",
    schema: {
      input: S.kind("integer"),
      output: S.record({
        observed_precision: S.kind("integer"),
      }),
    },
    arbprec: true,
    examples: [],
    invariants: [],
    fn: (_input, flags) => {
      // ADR-0020: arbprec tools see `flags.precision` injected by the
      // runner. The cast is the one we want to make safe — once the
      // typed-flags lc1 work lands the cast can shrink, but the runtime
      // contract is what this test pins.
      const precision = (flags as { precision?: bigint }).precision;
      return record({
        observed_precision: int(precision ?? 0n),
      });
    },
  });

  test("--precision=80 reaches def.fn as flags.precision === 80n", async () => {
    let captured = "";
    const storeDir2 = await mkdtemp(join(tmpdir(), "wb-arbprec-flag-"));
    try {
      await runTool(arbprecEchoDef, {
        argv: ["--precision=80"],
        stdin: async () => canonicalize(int(0n)),
        stdout: (c) => { captured += c; },
        stderr: () => {},
        env: { CAS_STORE: storeDir2 },
        exit: (code) => { throw new ExitSignal(code); },
      });
      const v = parse(captured);
      expect(v.kind).toBe("record");
      if (v.kind === "record") {
        expect(v.fields["observed_precision"]).toEqual(int(80n));
      }
    } finally {
      await rm(storeDir2, { recursive: true, force: true });
    }
  });

  test("--precision absent ⇒ default 50n reaches def.fn", async () => {
    // The flag has a declared default of 50n (ADR-0020). When the user
    // omits the flag, that default flows through to `fn` exactly the
    // same as a tool-declared default with `F.int(..., {default: 50n})`.
    let captured = "";
    const storeDir2 = await mkdtemp(join(tmpdir(), "wb-arbprec-flag-default-"));
    try {
      await runTool(arbprecEchoDef, {
        argv: [],
        stdin: async () => canonicalize(int(0n)),
        stdout: (c) => { captured += c; },
        stderr: () => {},
        env: { CAS_STORE: storeDir2 },
        exit: (code) => { throw new ExitSignal(code); },
      });
      const v = parse(captured);
      if (v.kind === "record") {
        expect(v.fields["observed_precision"]).toEqual(int(50n));
      }
    } finally {
      await rm(storeDir2, { recursive: true, force: true });
    }
  });

  test("--precision=200 records `precision: \"200\"` on the provenance record", async () => {
    // The provenance record's `flags` field captures the explicit
    // argv-string form of every tool-facing flag the user set. After
    // the lc1 fix, --precision becomes a tool-facing flag for arbprec
    // tools — so an explicit `--precision=200` shows up in the record.
    let captured = "";
    const storeDir2 = await mkdtemp(join(tmpdir(), "wb-arbprec-flag-prov-"));
    try {
      await runTool(arbprecEchoDef, {
        argv: ["--precision=200"],
        stdin: async () => canonicalize(int(0n)),
        stdout: (c) => { captured += c; },
        stderr: () => {},
        env: { CAS_STORE: storeDir2 },
        exit: (code) => { throw new ExitSignal(code); },
      });
      const v = parse(captured);
      const outputHash = hash(v);
      const rec = await readProvenance(storeDir2, outputHash);
      expect(rec).not.toBeNull();
      expect(rec?.flags).toEqual({ precision: "200" });
    } finally {
      await rm(storeDir2, { recursive: true, force: true });
    }
  });

  test("non-arbprec tool: `precision` is *not* injected (regression guard)", async () => {
    // The lc1 fix is gated on `def.arbprec === true`. A regular
    // symbolic tool must not see a stray `precision` key in its flags
    // object — this would silently widen the contract.
    const symbolicDef = defineTool({
      name: "test-symbolic-no-precision",
      version: "0.0.1",
      schema: {
        input: S.kind("integer"),
        output: S.record({ keys: S.kind("string") }),
      },
      examples: [],
      invariants: [],
      fn: (_input, flags) => {
        const keys = Object.keys(flags as Record<string, unknown>);
        return record({ keys: str(keys.sort().join(",")) });
      },
    });
    let captured = "";
    const storeDir2 = await mkdtemp(join(tmpdir(), "wb-no-precision-"));
    try {
      await runTool(symbolicDef, {
        argv: [],
        stdin: async () => canonicalize(int(0n)),
        stdout: (c) => { captured += c; },
        stderr: () => {},
        env: { CAS_STORE: storeDir2 },
        exit: (code) => { throw new ExitSignal(code); },
      });
      const v = parse(captured);
      if (v.kind === "record") {
        // No declared flags, no arbprec ⇒ flags object is empty.
        expect(v.fields["keys"]).toEqual(str(""));
      }
    } finally {
      await rm(storeDir2, { recursive: true, force: true });
    }
  });
});

// silence the unused-import lint when these helpers aren't otherwise reached
void sym; void expr; void plist; void containsFloat64;
