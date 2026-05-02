// Combined health check: typecheck + bun test + per-tool --test + oracle on every goldens dir.
// Prints a summary at the end and exits non-zero if any phase failed.
//
// Usage:  bun scripts/check.ts          (full)
//         bun scripts/check.ts --quick  (skip per-tool --test and oracle goldens)

import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalize, record, str } from "@workbench/protocol";
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
      if (r.code !== 0) return { ok: false, detail: r.stderr.trim() || r.stdout.slice(0, 400) };
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
