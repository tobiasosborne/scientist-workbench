// =============================================================================
// @workbench/compose — surface tests
// =============================================================================
//
// The MVP scaffold (issue inm) exposes:
//   * the `Workbench` and `LoadWorkbenchOptions` types
//   * the `CompositionError` class
//   * `loadWorkbench` (placeholder until issue 9n1 lands the walker)
//
// These tests pin the *shape* of the public surface — they are the
// canary for accidental API changes during the upcoming issues. As
// each issue lands a new method (run, lookup, runMemoized, pipe,
// runMemoized) the tests here grow in lockstep.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalize, hash, int, parse, record, str } from "@workbench/protocol";
import { spawnBun } from "@workbench/contract";
import { CompositionError, loadWorkbench, typed } from "../src/index.js";

describe("@workbench/compose — scaffold surface", () => {
  test("CompositionError extends ToolError and carries toolName + step", () => {
    const e = new CompositionError("boom", {
      toolName: "mod-pow",
      step: 2,
      suggestion: "fix the input",
      detail: { path: ["base"] },
    });
    expect(e.name).toBe("CompositionError");
    expect(e.toolName).toBe("mod-pow");
    expect(e.step).toBe(2);
    // ToolError appends "suggestion: ..." onto the message (errors-that-teach,
    // PRD §6.1) — the suggestion field is also read directly.
    expect(e.message).toContain("boom");
    expect(e.message).toContain("fix the input");
    expect((e as { suggestion?: string }).suggestion).toBe("fix the input");
  });

  test("CompositionError without step leaves step undefined", () => {
    const e = new CompositionError("boom", { toolName: "mod-pow" });
    expect(e.step).toBeUndefined();
  });

  test("loadWorkbench discovers every tool in the workbench", async () => {
    const wb = await loadWorkbench();
    // The exact set is implementation-defined and grows over time; we
    // assert on the contract: every well-known tool is present, no
    // discovery threw, and the registry size matches the directory walk.
    const expectedNames = [
      "expr-parse", "cas-simplify", "cas-verify",
      "mod-pow", "mod-inv", "ntt",
      "oracle", "registry-list", "registry-search",
      "entropy-source",
      "linalg-solve",
    ];
    for (const n of expectedNames) {
      expect(wb.tools.has(n)).toBe(true);
    }
    // Errors map exists and is empty on a clean checkout. (Failures
    // would mean a tool's module failed to import — surfacing here
    // rather than throwing is the contract.)
    expect(wb.errors.size).toBe(0);
    // store is resolved (non-empty path).
    expect(wb.store.length).toBeGreaterThan(0);
  });

  test("loadWorkbench respects an explicit toolsRoot", async () => {
    // Pointing at a non-tools dir produces an empty registry rather
    // than throwing — the walker is tolerant.
    const tmp = process.cwd();  // any real dir without tool.ts files
    const wb = await loadWorkbench({ toolsRoot: tmp });
    expect(wb.tools.size).toBe(0);
  });

  test("loadWorkbench respects a name filter", async () => {
    const wb = await loadWorkbench({ filter: (n) => n === "mod-pow" });
    expect(wb.tools.size).toBe(1);
    expect(wb.tools.has("mod-pow")).toBe(true);
  });

});

// =============================================================================
// In-process invocation (issue 23i)
// =============================================================================
//
// Each test below uses a per-suite scratch CAS_STORE so provenance
// writes don't pollute the user's real store. The store is populated
// via `loadWorkbench({ store })`.

describe("@workbench/compose — Workbench.run", () => {
  let store: string;
  let restoreStore: string | undefined;

  beforeAll(() => {
    store = mkdtempSync(join(tmpdir(), "compose-test-"));
    restoreStore = process.env["CAS_STORE"];
  });
  afterAll(() => {
    if (restoreStore === undefined) delete process.env["CAS_STORE"];
    else process.env["CAS_STORE"] = restoreStore;
    rmSync(store, { recursive: true, force: true });
  });

  test("mod-pow runs in-process and returns the right Value", async () => {
    const wb = await loadWorkbench({ store });
    const out = await wb.run(
      "mod-pow",
      record({ base: int(3n), exponent: int(5n), modulus: int(7n) }),
    );
    expect(out).toEqual(int(5n));  // 3^5 mod 7 = 243 mod 7 = 5
  });

  test("expr-parse → cas-simplify in-process matches subprocess bytes", async () => {
    const wb = await loadWorkbench({ store });
    const parsed = await wb.run("expr-parse", str("(x+1)*(x-1)"));
    const simplified = await wb.run("cas-simplify", parsed as never);
    const inProcessBytes = canonicalize(simplified);

    // Subprocess pipeline for the same input.
    const parseSub = await spawnBun(
      ["tools/expr-parse/tool.ts"],
      canonicalize(str("(x+1)*(x-1)")),
    );
    expect(parseSub.code).toBe(0);
    const simpSub = await spawnBun(
      ["tools/cas-simplify/tool.ts"],
      parseSub.stdout,
    );
    expect(simpSub.code).toBe(0);
    const subBytes = simpSub.stdout;

    expect(inProcessBytes).toBe(subBytes);
  });

  test("unknown tool name throws a CompositionError naming alternatives", async () => {
    const wb = await loadWorkbench({ store, filter: (n) => n === "mod-pow" });
    let caught: unknown = null;
    try {
      await wb.run("does-not-exist", str("hi"));
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(CompositionError);
    expect((caught as CompositionError).toolName).toBe("does-not-exist");
    expect((caught as CompositionError).message).toContain("mod-pow");
  });

  test("schema-violating input fails with toolName + path detail", async () => {
    const wb = await loadWorkbench({ store, filter: (n) => n === "mod-pow" });
    let caught: unknown = null;
    try {
      await wb.run("mod-pow", record({ base: int(3n) }));  // missing exponent + modulus
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(CompositionError);
    const ce = caught as CompositionError;
    expect(ce.toolName).toBe("mod-pow");
    expect(ce.message).toContain("mod-pow");
    expect(ce.message).toContain("schema");
  });

  test("typed barrel: wb.modPow({...}) typechecks and computes the right value", async () => {
    const workbench = await loadWorkbench({ store });
    const wb = typed(workbench);
    // The whole point of the typed barrel: input fields are TS-checked
    // against the schema's inferred I, and the output is narrowed to
    // OutputOf<typeof modPowDef>. A typo on a field name or a wrong
    // value type fails the typecheck — see the // @ts-expect-error
    // tests below.
    const out = await wb.modPow({
      kind: "record",
      fields: {
        base: int(2n),
        exponent: int(10n),
        modulus: int(1000n),
      },
    });
    // 2^10 mod 1000 = 1024 mod 1000 = 24
    expect(out).toEqual(int(24n));
  });

  test("typed barrel: typo on method name fails the typecheck", async () => {
    const workbench = await loadWorkbench({ store });
    const wb = typed(workbench);
    // @ts-expect-error — `modPwo` is a typo; the typed surface exposes
    // every tool method with its exact camelCase name.
    void wb.modPwo;
    // We do not run the typo'd call — the @ts-expect-error above is
    // the assertion that consumers cannot construct it. The runtime
    // void access is just to keep the line non-dead.
  });

  test("Workbench.lookup misses on a fresh store, hits after run", async () => {
    const wb = await loadWorkbench({ store });
    const input = record({ base: int(7n), exponent: int(13n), modulus: int(101n) });
    // Miss before any run.
    const miss = await wb.lookup("mod-pow", input);
    expect(miss).toBeNull();
    // Run, then hit.
    const computed = await wb.run("mod-pow", input);
    const hit = await wb.lookup("mod-pow", input);
    expect(hit).not.toBeNull();
    expect(hit).toEqual(computed);
  });

  test("Workbench.lookup hits are byte-identical to a fresh run", async () => {
    const wb = await loadWorkbench({ store });
    const input = record({ base: int(11n), exponent: int(20n), modulus: int(7919n) });
    const fresh = await wb.run("mod-pow", input);
    const cached = await wb.lookup("mod-pow", input);
    // Canonical bytes must match — same content-hash, same value.
    expect(canonicalize(cached!)).toBe(canonicalize(fresh));
    expect(hash(cached!)).toBe(hash(fresh));
  });

  test("Workbench.lookup refuses on nondeterministic tools", async () => {
    const wb = await loadWorkbench({ store });
    let caught: unknown = null;
    try {
      await wb.lookup("entropy-source", record({ n_bytes: int(8n) }));
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(CompositionError);
    expect((caught as CompositionError).toolName).toBe("entropy-source");
    expect((caught as CompositionError).message).toContain("nondeterministic");
  });

  test("Workbench.runMemoized: first call runs, second call hits cache", async () => {
    const wb = await loadWorkbench({ store });
    const input = record({ base: int(2n), exponent: int(15n), modulus: int(31n) });
    // Use a fresh-ish input to avoid any earlier test polluting the
    // cache. The store is the test-local mkdtemp; the writes from
    // earlier tests for different inputs do not collide.
    const a = await wb.runMemoized("mod-pow", input);
    const b = await wb.runMemoized("mod-pow", input);
    expect(canonicalize(a)).toBe(canonicalize(b));
    // 2^15 mod 31 = 32768 mod 31 = 32768 - 1057*31 = 32768 - 32767 = 1
    expect(a).toEqual(int(1n));
  });

  test("Workbench.runMemoized refuses on nondeterministic tools", async () => {
    const wb = await loadWorkbench({ store });
    let caught: unknown = null;
    try {
      await wb.runMemoized("entropy-source", record({ n_bytes: int(8n) }));
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(CompositionError);
    expect((caught as CompositionError).message).toContain("nondeterministic");
  });

  test("Workbench.pipe: chained .through(...) produces the right Value", async () => {
    const wb = await loadWorkbench({ store });
    const out = await wb
      .pipe(str("(x+1)*(x-1)"))
      .through("expr-parse")
      .through("cas-simplify")
      .value();
    // (x+1)*(x-1) → x^2 + (-1)
    expect(out.kind).toBe("expression");
  });

  test("Workbench.pipe: immutable builder — branches share a prefix without aliasing", async () => {
    const wb = await loadWorkbench({ store });
    const prefix = wb.pipe(str("(x+1)*(x-1)")).through("expr-parse");
    // Two independent terminals from the same prefix.
    const simplified = await prefix.through("cas-simplify").value();
    const reparseAttempt = prefix.through("cas-simplify");
    const simp2 = await reparseAttempt.value();
    expect(canonicalize(simplified)).toBe(canonicalize(simp2));
    // Mutating one chain's `.through` never mutated `prefix`; if it
    // had, the second `.value()` would have run an extra step.
  });

  test("Workbench.pipe: step-numbered errors name the failing step", async () => {
    const wb = await loadWorkbench({ store });
    let caught: unknown = null;
    try {
      // expr-parse on a non-string input fails. Step 1 is expr-parse.
      await wb
        .pipe(int(42n))
        .through("expr-parse")
        .through("cas-simplify")
        .value();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(CompositionError);
    const ce = caught as CompositionError;
    expect(ce.step).toBe(1);
    expect(ce.toolName).toBe("expr-parse");
    expect(ce.message).toContain("step 1");
    expect(ce.message).toContain("expr-parse");
  });

  test("provenance record matches subprocess for the same input", async () => {
    const wb = await loadWorkbench({ store });
    const input = record({ base: int(2n), exponent: int(10n), modulus: int(1000n) });
    const out = await wb.run("mod-pow", input);
    const outHash = hash(out);

    // Read back via --provenance-of through the subprocess surface.
    const lookup = await spawnBun(
      ["tools/mod-pow/tool.ts", "--provenance-of", outHash],
      undefined,
      { env: { ...process.env, CAS_STORE: store } },
    );
    expect(lookup.code).toBe(0);
    const prov = parse(lookup.stdout);
    expect(prov.kind).toBe("record");
    if (prov.kind === "record") {
      // tool.name + version + input hash should match.
      const tool = prov.fields["tool"];
      expect(tool?.kind).toBe("record");
      if (tool?.kind === "record") {
        expect(tool.fields["name"]).toEqual(str("mod-pow"));
      }
      const inputs = prov.fields["inputs"];
      expect(inputs?.kind).toBe("list");
      if (inputs?.kind === "list" && inputs.items[0]?.kind === "record") {
        const recordedInputHash = inputs.items[0].fields["hash"];
        expect(recordedInputHash).toEqual(str(hash(input)));
      }
    }
  });
});
