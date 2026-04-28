// Combined health check: typecheck + bun test + per-tool --test + oracle on every goldens dir.
// Prints a summary at the end and exits non-zero if any phase failed.
//
// Usage:  bun scripts/check.ts          (full)
//         bun scripts/check.ts --quick  (skip per-tool --test and oracle goldens)

import { spawn } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);
const TOOLS = join(ROOT, "tools");
const BUN = process.env["BUN_BIN"] ?? "bun";
const ORACLE = join(TOOLS, "oracle", "tool.ts");

const QUICK = process.argv.includes("--quick");

interface PhaseResult {
  name: string;
  ok: boolean;
  skipped?: boolean;
  detail?: string;
}

const results: PhaseResult[] = [];

function spawnCmd(cmd: string, args: string[], stdin?: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: [stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    p.stdout.on("data", (b) => (stdout += b.toString("utf8")));
    p.stderr.on("data", (b) => (stderr += b.toString("utf8")));
    p.on("error", reject);
    p.on("close", (code) => resolve({ code: code ?? 0, stdout, stderr }));
    if (stdin !== undefined) {
      p.stdin.write(stdin, "utf8");
      p.stdin.end();
    }
  });
}

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

await phase("typecheck (tsc --noEmit)", async () => {
  const r = await spawnCmd(BUN, ["tsc", "--noEmit"]);
  return r.code === 0 ? { ok: true } : { ok: false, detail: r.stdout + r.stderr };
});

await phase("bun test (workspace property tests)", async () => {
  const r = await spawnCmd(BUN, ["test"]);
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
      const r = await spawnCmd(BUN, [toolPath, "--test"]);
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
      const input = JSON.stringify({
        kind: "record",
        fields: {
          tool_path: { kind: "string", value: toolPath },
          goldens_dir: { kind: "string", value: goldensDir },
        },
      });
      const r = await spawnCmd(BUN, [ORACLE], input);
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
