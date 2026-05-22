// Combined health check: typecheck + bun test + per-tool --test + oracle on every goldens dir.
// Prints a summary at the end and exits non-zero if any phase failed.
//
// Usage:  bun scripts/check.ts          (full)
//         bun scripts/check.ts --quick  (skip per-tool --test and oracle goldens)

import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalize, parse, record, str } from "@workbench/protocol";
import { spawnBun } from "@workbench/contract";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);
const TOOLS = join(ROOT, "tools");
const ORACLE = join(TOOLS, "oracle", "tool.ts");

const QUICK = process.argv.includes("--quick");

interface PhaseResult {
  name: string;
  ok: boolean;
  skipped?: boolean;
  detail?: string;
}

const results: PhaseResult[] = [];

async function phase(name: string, fn: () => Promise<{ ok: boolean; skipped?: boolean; detail?: string }>): Promise<void> {
  const t0 = Date.now();
  process.stdout.write(`▸ ${name} ... `);
  try {
    const r = await fn();
    const dt = Date.now() - t0;
    if (r.skipped) process.stdout.write(`skipped (${r.detail ?? "no work"})\n`);
    else process.stdout.write(r.ok ? `ok (${dt}ms)\n` : `FAIL (${dt}ms)\n`);
    if (!r.ok && r.detail) process.stdout.write(`    ${r.detail.replace(/\n/g, "\n    ")}\n`);
    const out: PhaseResult = { name, ok: r.ok };
    if (r.skipped) out.skipped = true;
    if (r.detail !== undefined) out.detail = r.detail;
    results.push(out);
  } catch (e) {
    process.stdout.write(`ERROR\n    ${(e as Error).message}\n`);
    results.push({ name, ok: false, detail: (e as Error).message });
  }
}

// -----------------------------------------------------------------------------
// Convention check: raw kind-literals outside the allowlist.
// -----------------------------------------------------------------------------
//
// CLAUDE.md says: prefer the constructors (int, str, list, record, …) over
// raw `{ kind: "..." }` literals in tool/test/script code. A few places
// legitimately construct values from scratch — the protocol package itself,
// the contract runner (protocol-adjacent), and the json-bridge package
// (whose job is exactly that). Every other appearance is a soft drift.
//
// This phase greps the workspace and flags violations as a non-fatal
// warning: failing CI on a convention drift is too aggressive while we're
// migrating, but silence is wrong. Once we're confident the codebase is
// clean, flip the warning to a hard fail.

const KIND_LITERAL_RE = /\bkind:\s*"(symbol|string|integer|rational|float64|boolean|list|record|expression|tagged)"/;
const ALLOWLIST = [
  "packages/protocol/",
  "packages/contract/src/runner.ts",
  "packages/json-bridge/src/",
  // tests are pragmatic about literals in assertions
  ".test.ts",
  // scripts/check.ts is allowed to introspect; this very file may grep itself
  "scripts/check.ts",
];

async function gatherTsFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(d: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name === "node_modules" || e.name === ".beads" || e.name === ".git" || e.name === "goldens") continue;
      const p = join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.isFile() && (p.endsWith(".ts") || p.endsWith(".js"))) out.push(p);
    }
  }
  await walk(root);
  return out;
}

await phase("convention: raw kind-literals outside allowlist", async () => {
  const files = await gatherTsFiles(ROOT);
  const violations: { file: string; line: number; text: string }[] = [];
  for (const f of files) {
    const rel = relative(ROOT, f);
    if (ALLOWLIST.some((a) => rel.includes(a))) continue;
    const content = await readFile(f, "utf8");
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      // skip lines inside line comments — crude but adequate for this check
      const trimmed = line.trim();
      if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;
      if (KIND_LITERAL_RE.test(line)) violations.push({ file: rel, line: i + 1, text: trimmed.slice(0, 100) });
    }
  }
  if (violations.length === 0) return { ok: true, detail: "no raw kind-literal drift" };
  // Warn but don't fail — see comment above. Surface to the report as a soft signal.
  process.stdout.write(`(warning, not fatal: ${violations.length} raw kind-literal drift sites)\n`);
  for (const v of violations.slice(0, 20)) {
    process.stdout.write(`    ${v.file}:${v.line}  ${v.text}\n`);
  }
  if (violations.length > 20) process.stdout.write(`    … ${violations.length - 20} more\n`);
  return { ok: true, detail: `${violations.length} drift sites (non-fatal)` };
});

// Codegen the typed barrel before typecheck. ADR-0012 / issue
// scientist-workbench-4t5. The generated file
// (`packages/compose/src/generated/wb.ts`) is committed; regeneration
// against an unchanged tool set is byte-stable. The drift check is
// "regenerate, compare bytes against the file we read before
// regeneration" — drift means a new tool was added, an existing tool
// renamed, or a schema/flag changed since the last commit; the
// developer should `bun scripts/gen-workbench-barrel.ts` and commit.
await phase("codegen: workbench typed barrel", async () => {
  const barrelPath = join(ROOT, "packages", "compose", "src", "generated", "wb.ts");
  let before: string | null = null;
  try {
    before = await readFile(barrelPath, "utf8");
  } catch {
    // file doesn't exist yet — fine, regen will create it; we still
    // flag it as drift because we expect the file to be committed.
  }
  const gen = await spawnBun(["scripts/gen-workbench-barrel.ts"]);
  if (gen.code !== 0) return { ok: false, detail: gen.stderr || gen.stdout };
  const after = await readFile(barrelPath, "utf8");
  if (before === null || before !== after) {
    return {
      ok: false,
      detail:
        "packages/compose/src/generated/wb.ts is out of date with tools/. " +
        "Run `bun scripts/gen-workbench-barrel.ts` and commit the diff.",
    };
  }
  return { ok: true };
});

// Codegen drift check for the generated tool catalog. ADR-0043 (the tool
// registry is the single source of truth for tool-facing docs), issues
// scientist-workbench-ixnv.2 (the generator) and scientist-workbench-ixnv.4
// (the tiered progressive-discovery model — which moved the catalog out of
// `README.md` into its own generated file). This mirrors the
// workbench-typed-barrel phase above exactly: `docs/CATALOG.md` is a fully
// generated file, derived from each tool's `def.name` / `def.summary`,
// committed to git, and byte-stable on an unchanged tool set. Drift means a
// tool was added, renamed, or re-summarised since the last `gen-catalog`
// run; the developer should `bun scripts/gen-catalog.ts` and commit. Per
// ADR-0043 Decision 6 this phase lives in the always-on portion of check.ts
// (before the `if (!QUICK)` gate) so `bun run check:quick` catches catalog
// drift in the fast inner loop — the check is just a registry walk plus a
// string compare.
await phase("codegen: tool catalog", async () => {
  const catalogPath = join(ROOT, "docs", "CATALOG.md");
  let before: string | null = null;
  try {
    before = await readFile(catalogPath, "utf8");
  } catch {
    // docs/CATALOG.md missing is treated as drift — the file is a
    // committed generated artefact and must be present. The regen below
    // will create it; a null-before still fails the phase so the missing
    // commit is surfaced.
  }
  const gen = await spawnBun(["scripts/gen-catalog.ts"]);
  if (gen.code !== 0) return { ok: false, detail: gen.stderr || gen.stdout };
  const after = await readFile(catalogPath, "utf8");
  if (before === null || before !== after) {
    return {
      ok: false,
      detail:
        "docs/CATALOG.md tool catalog is out of date with tools/. " +
        "Run `bun scripts/gen-catalog.ts` and commit the diff.",
    };
  }
  return { ok: true };
});

// Codegen drift check for the folded goldens. ADR-0043 Decision 3 & 6
// (the registry is the single source of truth — `tools/<name>/goldens/`
// is generated by folding `def.examples`), issue scientist-workbench-
// ixnv.3. This mirrors the workbench-typed-barrel and README-catalog
// phases: `generate-goldens.ts --check` re-derives every golden from the
// registry and byte-compares against the committed `*.golden.json`
// files, exiting non-zero on any mismatch or missing file. Drift means a
// tool's examples (or supplementary goldens.spec.ts) changed since the
// last `bun run goldens` run. Per ADR-0043 Decision 6 the phase lives in
// the always-on portion of check.ts (before the `if (!QUICK)` gate) so
// `bun run check:quick` catches goldens drift in the fast inner loop —
// the `--check` mode runs each tool once but writes nothing.
await phase("codegen: folded goldens", async () => {
  const gen = await spawnBun(["scripts/generate-goldens.ts", "--check"]);
  if (gen.code !== 0) {
    return {
      ok: false,
      detail:
        "Folded goldens are out of date with tools/ examples. " +
        "Run `bun run goldens` and commit the diff.\n" +
        (gen.stderr || gen.stdout).split("\n").filter((l) => l.includes("✗")).join("\n"),
    };
  }
  return { ok: true };
});

// Codegen drift check for the generated per-tool READMEs. ADR-0043
// Decision 3 (the mechanical sections of each `tools/<name>/README.md`
// are generated from `def`) & Decision 5 (the prose is extracted from
// the canonical `tool.ts` literate header), issue scientist-workbench-
// ixnv.5. This mirrors the workbench-typed-barrel, README-catalog, and
// folded-goldens phases above: `gen-tool-readme.ts --check` regenerates
// every `tools/<name>/README.md` from the registry and byte-compares
// against the committed files, exiting non-zero on any drift. Drift
// means a tool's `def` (schema / summary / invariants / examples) or its
// `tool.ts` literate header changed since the last `gen-tool-readme`
// run, or a generated README was hand-edited. Per ADR-0043 Decision 6
// the phase lives in the always-on portion of check.ts (before the
// `if (!QUICK)` gate) so `bun run check:quick` catches per-tool README
// drift in the fast inner loop — the check is a registry walk plus a
// string compare.
await phase("codegen: per-tool READMEs", async () => {
  const gen = await spawnBun(["scripts/gen-tool-readme.ts", "--check"]);
  if (gen.code !== 0) {
    return {
      ok: false,
      detail:
        "One or more tools/<name>/README.md are out of date with the registry. " +
        "Run `bun scripts/gen-tool-readme.ts` and commit the diff.\n" +
        (gen.stderr || gen.stdout).trim(),
    };
  }
  return { ok: true };
});

await phase("typecheck (tsc --noEmit)", async () => {
  const r = await spawnBun(["tsc", "--noEmit"]);
  return r.code === 0 ? { ok: true } : { ok: false, detail: r.stdout + r.stderr };
});

await phase("bun test (workspace property tests)", async () => {
  const r = await spawnBun(["test"]);
  if (r.code !== 0) return { ok: false, detail: r.stderr || r.stdout };
  // Bun writes the summary to stderr; surface the pass count line.
  const summary = (r.stderr.match(/\d+ pass[\s\S]*?expect\(\) calls/) ?? [r.stderr.split("\n").slice(-3, -1).join(" ")])[0];
  return { ok: true, detail: summary };
});

if (!QUICK) {
  // Per-tool --test hooks.
  const toolDirs = await readdir(TOOLS, { withFileTypes: true });
  for (const e of toolDirs) {
    if (!e.isDirectory()) continue;
    const toolPath = join(TOOLS, e.name, "tool.ts");
    try {
      await stat(toolPath);
    } catch {
      continue;
    }
    await phase(`tool --test: ${e.name}`, async () => {
      const r = await spawnBun([toolPath, "--test"]);
      if (r.code === 2) return { ok: true, skipped: true, detail: "no --test hook registered" };
      if (r.code !== 0) return { ok: false, detail: r.stderr || r.stdout };
      return { ok: true };
    });
  }

  // Oracle on every tool's goldens.
  for (const e of toolDirs) {
    if (!e.isDirectory()) continue;
    const goldensDir = join(TOOLS, e.name, "goldens");
    let names: string[];
    try {
      names = (await readdir(goldensDir)).filter((n) => n.endsWith(".golden.json"));
    } catch {
      continue;
    }
    if (names.length === 0) continue;
    const toolPath = join(TOOLS, e.name, "tool.ts");
    await phase(`oracle: ${e.name} (${names.length} goldens)`, async () => {
      const input = canonicalize(record({
        tool_path: str(toolPath),
        goldens_dir: str(goldensDir),
      }));
      const r = await spawnBun([ORACLE], input);
      if (r.code !== 0) {
        // Non-zero exit from the oracle itself means the oracle ran into
        // a real error (malformed input, broken goldens dir, etc.) — not
        // a per-golden failure. Surface stderr or a stdout snippet.
        return { ok: false, detail: r.stderr.trim() || r.stdout.slice(0, 400) };
      }
      // Bead `qf1` (worklog 038): oracle now always returns the results
      // record on stdout — pass or fail. CI inspects `failed` for the
      // exit decision instead of relying on `process.exit(1)`.
      const out = parse(r.stdout);
      if (out.kind !== "record") {
        return { ok: false, detail: `oracle output not a record: ${JSON.stringify(out).slice(0, 200)}` };
      }
      const failedField = out.fields["failed"];
      if (failedField === undefined || failedField.kind !== "integer") {
        return { ok: false, detail: "oracle output missing integer `failed` field" };
      }
      if (failedField.value !== "0") {
        // List the failing goldens from the results array, mirroring
        // the stderr summary the oracle itself wrote.
        const detail: string[] = [`${failedField.value}/${names.length} goldens failed`];
        const resultsField = out.fields["results"];
        if (resultsField !== undefined && resultsField.kind === "list") {
          for (const item of resultsField.items) {
            if (item.kind !== "record") continue;
            const passed = item.fields["passed"];
            if (passed?.kind === "boolean" && passed.value === false) {
              const fname = item.fields["filename"];
              const err = item.fields["error"];
              const fnameStr = fname?.kind === "string" ? fname.value : "?";
              const errStr = err?.kind === "string" ? err.value : "(no detail)";
              detail.push(`  FAIL ${fnameStr}: ${errStr}`);
            }
          }
        }
        return { ok: false, detail: detail.join("\n") };
      }
      return { ok: true };
    });
  }
}

const failed = results.filter((r) => !r.ok);
const skipped = results.filter((r) => r.skipped);
const ran = results.length - skipped.length - failed.length;
console.log("");
console.log(`summary: ${ran} passed, ${skipped.length} skipped, ${failed.length} failed`);
if (failed.length > 0) {
  console.log("failed phases:");
  for (const f of failed) console.log(`  - ${f.name}`);
  process.exit(1);
}
