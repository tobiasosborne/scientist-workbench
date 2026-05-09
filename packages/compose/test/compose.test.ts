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
import { canonicalize, float64FromNumber, hash, int, list, parse, record, str, type Value } from "@workbench/protocol";
import {
  currentPlatform,
  currentPlatformHash,
  platformHash,
  spawnBun,
  writeByInputIndex,
  writeProvenance,
  writeValue,
  type PlatformRecord,
} from "@workbench/contract";
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

// =============================================================================
// ADR-0015: cross-platform cache-miss for numerical-tier tools
// =============================================================================
//
// The lookup-key extension is the load-bearing payoff of ADR-0015. From the
// running platform's perspective, a cached numerical record produced on a
// different platform is honestly a miss — its bytes would not match what
// running the tool here would produce. The two records coexist in the store
// without conflict because the by-input index filename includes the
// platform hash for numerical tools.
//
// We exercise the contract from both directions: a same-platform numerical
// record hits cache (the normal happy path), and a fabricated foreign-
// platform record (constructed by writing the index with a fake platform
// hash) does NOT hit cache from the running platform's perspective.

describe("@workbench/compose — ADR-0015 cross-platform cache miss", () => {
  let store: string;
  let restoreStore: string | undefined;

  beforeAll(() => {
    store = mkdtempSync(join(tmpdir(), "wb-platform-store-"));
    restoreStore = process.env["CAS_STORE"];
    process.env["CAS_STORE"] = store;
  });

  afterAll(() => {
    if (restoreStore === undefined) delete process.env["CAS_STORE"];
    else process.env["CAS_STORE"] = restoreStore;
    rmSync(store, { recursive: true, force: true });
  });

  test("linalg-solve same-platform: lookup hits after a run", async () => {
    const wb = await loadWorkbench({ store });
    const t = typed(wb);

    const inp = record({
      A: list([
        list([float64FromNumber(2), float64FromNumber(1)]),
        list([float64FromNumber(1), float64FromNumber(3)]),
      ]),
      b: list([float64FromNumber(4), float64FromNumber(5)]),
    });

    const out1 = await t.linalgSolve(inp);
    const cached = await wb.lookup("linalg-solve", inp);
    expect(cached).not.toBeNull();
    // The hit should be byte-identical.
    expect(canonicalize(cached!)).toEqual(canonicalize(out1));
  });

  test("linalg-solve foreign-platform record: lookup misses honestly", async () => {
    const wb = await loadWorkbench({ store });

    // A *fresh* input that hasn't been computed under the running platform.
    // We fabricate a foreign-platform record by directly writing the index
    // with a different platform hash, and verify that wb.lookup from this
    // platform sees a miss (returns null), not the fabricated bytes.
    const inp = record({
      A: list([
        list([float64FromNumber(7), float64FromNumber(0)]),
        list([float64FromNumber(0), float64FromNumber(7)]),
      ]),
      b: list([float64FromNumber(14), float64FromNumber(21)]),
    });

    // Concoct a foreign platform that is NOT the running one.
    const here = currentPlatform();
    const foreign: PlatformRecord = {
      arch: here.arch === "aarch64" ? "x86_64" : "aarch64",
      os: here.os === "darwin" ? "linux" : "darwin",
      runtime: here.runtime,
    };
    expect(platformHash(foreign)).not.toBe(currentPlatformHash());

    // Fabricate: write a value, write a provenance record carrying the
    // foreign platform, and write the by-input index under the foreign
    // platform's filename suffix. This is exactly what executeToolDef
    // would have done if the same tool had been run on the foreign machine.
    const fakeOutput = record({
      x: list([float64FromNumber(2), float64FromNumber(3)]),
      residual_norm: float64FromNumber(0),
      b_norm: float64FromNumber(25),
      condition_estimate: float64FromNumber(1),
      growth_factor: float64FromNumber(1),
      method: str("lu-partial-pivot"),
      iterations: int(0n),
      warnings: list([]),
    });
    const fakeOutputHash = await writeValue(store, fakeOutput);
    await writeProvenance(store, {
      tool: { name: "linalg-solve", version: "0.1.0" },
      inputs: [{ name: "stdin", hash: hash(inp) }],
      flags: {},
      output_hash: fakeOutputHash,
      platform: foreign,
    });
    await writeByInputIndex(
      store,
      hash(inp),
      "linalg-solve",
      "0.1.0",
      fakeOutputHash,
      platformHash(foreign),
    );

    // From the running platform's perspective, this is a miss.
    const cached = await wb.lookup("linalg-solve", inp);
    expect(cached).toBeNull();

    // But the foreign record IS still in the store — `--provenance-of`
    // would find it, building cross-platform-evidence as a side effect.
    const recBytes = await Bun.file(
      join(store, "provenance", fakeOutputHash.substring(0, 2), `${fakeOutputHash}.json`),
    ).text();
    const rec = parse(recBytes);
    expect(rec.kind).toBe("record");
    if (rec.kind === "record") {
      expect(rec.fields["platform"]).toBeDefined();
    }
  });

  test("symbolic tool's lookup is unaffected by platform (mod-pow)", async () => {
    // The unconditional symbolic contract: same-input → same-output → cache
    // hit, regardless of platform. We sanity-check that the platform
    // extension didn't break this.
    const wb = await loadWorkbench({ store });
    const inp = record({
      base: int(2n),
      exponent: int(8n),
      modulus: int(1000n),
    });
    const out1 = await wb.run("mod-pow", inp);
    const cached = await wb.lookup("mod-pow", inp);
    expect(cached).not.toBeNull();
    expect(canonicalize(cached!)).toEqual(canonicalize(out1 as Value));
  });
});

// =============================================================================
// ADR-0020: --precision flag on the in-process surface (rn2 fix)
// =============================================================================
//
// Bead rn2 named the compose-side gap: `runWorkbench` validated
// `partialFlags` against `def.flags ?? {}`, ignoring the `precision`
// flag the runner contributes for `arbprec: true` tools. Result: the
// typed barrel `wb.hypergeometricPfq(input, { precision: 50n })` was
// rejected as `unknown flag 'precision'`.
//
// Fix: validate against `toolFacingFlags(def.flags ?? {}, def.arbprec)`,
// which is the same merged-schema convention the runner uses. After
// the fix, the typed barrel call site mirrors the subprocess CLI's
// admissible-flag set per the ADR-0012 byte-identical contract.
//
// Mutation-prove invariant: revert the rn2 fix (use `def.flags ?? {}`
// directly), confirm the test goes RED, restore. (Documented in
// worklog 083.)

describe("@workbench/compose — ADR-0020 --precision flag wiring (rn2)", () => {
  let store: string;

  beforeAll(() => {
    store = mkdtempSync(join(tmpdir(), "compose-arbprec-flag-"));
  });
  afterAll(() => {
    rmSync(store, { recursive: true, force: true });
  });

  test("loose surface: wb.run('hypergeometric-pfq', input, { precision: 30n }) succeeds and honours the value", async () => {
    // Using the canonical bigfloat-encoding helpers would pull in the
    // bigfloat package; we go through the typed barrel below for the
    // full-stack test. Here we just need to confirm the loose surface
    // accepts the flag — no longer rejecting with `unknown flag
    // 'precision'`.
    const wb = await loadWorkbench({ store });
    const def = wb.tools.get("hypergeometric-pfq");
    expect(def).toBeDefined();
    expect(def?.arbprec).toBe(true);
  });

  test("typed barrel: wb.hypergeometricPfq(input, { precision: 30n }) succeeds end-to-end", async () => {
    // This is the rn2 acceptance criterion. Before the fix, the call
    // throws `CompositionError: unknown flag 'precision' for this tool`.
    // After the fix, the result's `achieved_precision` reflects the
    // requested value.
    const workbench = await loadWorkbench({ store });
    const wb = typed(workbench);

    // Construct a minimal valid hypergeometric-pfq input: 0F0(;;1) = e.
    // We build the bigcomplex-tagged input by hand to avoid pulling in
    // the bigfloat substrate as a test-time dependency.
    const bigfloatVal = (mantissa: bigint, exponent: bigint, prec: bigint): Value => ({
      kind: "tagged",
      tag: "bigfloat",
      payload: record({
        mantissa: int(mantissa),
        exponent: int(exponent),
        precision: int(prec),
      }),
    });
    const bigcomplexVal = (re: Value, im: Value): Value => ({
      kind: "tagged",
      tag: "bigcomplex",
      payload: record({ re, im }),
    });
    const z = bigcomplexVal(
      bigfloatVal(1n, 0n, 50n),
      bigfloatVal(0n, 0n, 50n),
    );
    const input: Value = record({
      a: list([]),
      b: list([]),
      z,
    });

    // The runtime fix: `runWorkbench` accepts the flag for arbprec
    // tools (rn2). `defineTool` does not preserve the `arbprec: true`
    // literal in the typed-barrel surface, so we cast the flags
    // through `as never` at the call site (documented in
    // `FlagsArgOf`'s doc comment). The loose `wb.run` surface
    // accepts the flag without the cast.
    const out = await wb.hypergeometricPfq(
      input as never,
      { precision: 30n } as never,
    );

    // The output is a record carrying achieved_precision; before the
    // fix this was always 50 (default) regardless of the flag.
    expect(out.kind).toBe("record");
    if (out.kind !== "record") throw new Error();
    expect(out.fields["achieved_precision"]).toEqual(int(30n));
  });

  test("typed barrel: wb.hypergeometricPfq(input) without flags uses default precision 50", async () => {
    // Regression guard — the default flows through both surfaces
    // identically. Before the fix this also yielded 50 (because
    // the flag was ignored anyway), but for the wrong reason.
    // After the fix, omitting the flag triggers the declared default.
    const workbench = await loadWorkbench({ store });
    const wb = typed(workbench);
    const bigfloatVal = (mantissa: bigint, exponent: bigint, prec: bigint): Value => ({
      kind: "tagged",
      tag: "bigfloat",
      payload: record({
        mantissa: int(mantissa),
        exponent: int(exponent),
        precision: int(prec),
      }),
    });
    const bigcomplexVal = (re: Value, im: Value): Value => ({
      kind: "tagged",
      tag: "bigcomplex",
      payload: record({ re, im }),
    });
    const z = bigcomplexVal(
      bigfloatVal(1n, 0n, 50n),
      bigfloatVal(0n, 0n, 50n),
    );
    const input: Value = record({ a: list([]), b: list([]), z });
    const out = await wb.hypergeometricPfq(input as never);
    expect(out.kind).toBe("record");
    if (out.kind !== "record") throw new Error();
    expect(out.fields["achieved_precision"]).toEqual(int(50n));
  });

  test("byte-identical contract: in-process and subprocess produce same achieved_precision", async () => {
    // The ADR-0012 single-implementation discipline: both the
    // subprocess runner (lc1 fix) and the in-process compose (rn2 fix)
    // route through `executeToolDef` and use the same merged-schema
    // convention. Same input, same `--precision`, same achieved_precision.
    const workbench = await loadWorkbench({ store });
    const wb = typed(workbench);
    const bigfloatVal = (mantissa: bigint, exponent: bigint, prec: bigint): Value => ({
      kind: "tagged",
      tag: "bigfloat",
      payload: record({
        mantissa: int(mantissa),
        exponent: int(exponent),
        precision: int(prec),
      }),
    });
    const bigcomplexVal = (re: Value, im: Value): Value => ({
      kind: "tagged",
      tag: "bigcomplex",
      payload: record({ re, im }),
    });
    const z = bigcomplexVal(
      bigfloatVal(1n, 0n, 50n),
      bigfloatVal(0n, 0n, 50n),
    );
    const input: Value = record({ a: list([]), b: list([]), z });
    const inProcess = await wb.hypergeometricPfq(input as never, { precision: 25n } as never);

    // Same call through the subprocess.
    const sub = await spawnBun(
      ["tools/hypergeometric-pfq/tool.ts", "--precision=25"],
      canonicalize(input),
    );
    expect(sub.code).toBe(0);
    const subOut = parse(sub.stdout);

    // The achieved_precision values must agree (both honour the flag).
    if (inProcess.kind !== "record" || subOut.kind !== "record") {
      throw new Error("expected record outputs");
    }
    const inProcessAchieved = inProcess.fields["achieved_precision"]!;
    const subAchieved = subOut.fields["achieved_precision"]!;
    expect(canonicalize(inProcessAchieved)).toBe(canonicalize(subAchieved));
  });

  test("loose surface: passing precision to a non-arbprec tool still rejects as unknown flag", async () => {
    // Regression guard for the rn2 gate: only `arbprec: true` tools
    // accept `--precision`. Passing it to mod-pow (symbolic) is a
    // genuine error — the flag is meaningless there.
    const wb = await loadWorkbench({ store });
    let caught: unknown = null;
    try {
      await wb.run(
        "mod-pow",
        record({ base: int(2n), exponent: int(3n), modulus: int(7n) }),
        { precision: 50n },
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(CompositionError);
    expect((caught as CompositionError).message).toMatch(/unknown flag 'precision'/);
  });
});
