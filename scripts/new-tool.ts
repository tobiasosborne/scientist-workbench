// =============================================================================
// new-tool — scaffold a new tool that meets the seven-artefact contract
// =============================================================================
//
// Every tool in the workbench follows the same on-disk layout:
//
//     tools/<name>/
//       package.json         workspace manifest
//       tool.ts              entry point — calls runTool({...})
//       README.md            agent-facing summary
//       goldens.spec.ts      `export const goldens: GoldenSpec[]`
//       goldens/             generated *.golden.json (do not edit by hand)
//
// `bun scripts/new-tool.ts <name> [--uses pkg1,pkg2,...]` writes the
// skeleton and runs `bun install` so workspace dependencies resolve.
//
// The `--uses` flag was added to retire the prior friction (F3): every tool
// with substantive algorithmic content sits on top of at least one
// workspace package (cas-core, mod-core, future siblings), and editing
// package.json by hand after scaffolding was rote work that interrupted the
// "write the tool" flow. Now the algorithmic substrate is declared up front:
//
//     bun scripts/new-tool.ts cas-reduce  --uses cas-core
//     bun scripts/new-tool.ts ntt         --uses mod-core
//     bun scripts/new-tool.ts geom-orient --uses geom-predicates,float-utils
//
// We validate each name against `packages/<name>/package.json` so a typo
// fails the scaffold immediately rather than producing a half-broken tool
// directory.

import { mkdir, writeFile, access, readFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnBun } from "@workbench/contract";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);

// -----------------------------------------------------------------------------
// argv parsing
// -----------------------------------------------------------------------------
//
// Two positional / flag forms:
//   <name> [--uses a,b,c]
//   <name> [--uses=a,b,c]

interface ParsedArgs {
  name: string;
  uses: string[];
}

function parseArgs(argv: string[]): ParsedArgs | { error: string } {
  let name: string | null = null;
  let uses: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--uses") {
      const next = argv[++i];
      if (next === undefined) return { error: "--uses requires a value" };
      uses = next.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
    } else if (a.startsWith("--uses=")) {
      uses = a.slice("--uses=".length).split(",").map((s) => s.trim()).filter((s) => s.length > 0);
    } else if (a === "--help" || a === "-h") {
      return { error: "help" };
    } else if (a.startsWith("--")) {
      return { error: `unknown flag ${a}` };
    } else {
      if (name !== null) return { error: `unexpected extra positional argument ${a}` };
      name = a;
    }
  }
  if (name === null) return { error: "missing <name> positional argument" };
  return { name, uses };
}

const parsed = parseArgs(process.argv.slice(2));
if ("error" in parsed) {
  if (parsed.error === "help") {
    console.log("usage: bun scripts/new-tool.ts <name> [--uses pkg1,pkg2,...]");
    console.log("");
    console.log("Scaffolds tools/<name>/{package.json, tool.ts, README.md, goldens.spec.ts, goldens/}.");
    console.log("--uses adds workspace packages (under packages/<pkg>) as dependencies. Each pkg must already exist.");
    console.log("");
    console.log("examples:");
    console.log("  bun scripts/new-tool.ts cas-reduce  --uses cas-core");
    console.log("  bun scripts/new-tool.ts ntt         --uses mod-core");
    process.exit(0);
  }
  console.error(`new-tool: ${parsed.error}`);
  console.error("usage: bun scripts/new-tool.ts <name> [--uses pkg1,pkg2,...]   (--help for full help)");
  process.exit(2);
}

const { name, uses } = parsed;

if (!/^[a-z][a-z0-9-]*$/.test(name)) {
  console.error(`tool name must match /^[a-z][a-z0-9-]*$/; got ${JSON.stringify(name)}`);
  process.exit(2);
}

// -----------------------------------------------------------------------------
// validate --uses against packages/
// -----------------------------------------------------------------------------
//
// Each package referenced must exist under packages/<pkg>/package.json with
// the canonical `@workbench/<pkg>` name. We read each manifest to confirm
// rather than just checking the directory name — keeps this script honest
// against a future where someone reorganises packages/.

async function exists(p: string): Promise<boolean> {
  try {
    await access(p, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

const usesResolved: { pkg: string; manifestName: string }[] = [];
for (const pkg of uses) {
  const manifestPath = join(ROOT, "packages", pkg, "package.json");
  if (!(await exists(manifestPath))) {
    console.error(`new-tool: --uses ${pkg}: packages/${pkg}/package.json not found`);
    process.exit(2);
  }
  let manifest: { name?: string };
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { name?: string };
  } catch (e) {
    console.error(`new-tool: --uses ${pkg}: package.json unparseable: ${(e as Error).message}`);
    process.exit(2);
  }
  if (!manifest.name) {
    console.error(`new-tool: --uses ${pkg}: package.json missing 'name' field`);
    process.exit(2);
  }
  usesResolved.push({ pkg, manifestName: manifest.name });
}

const dir = join(ROOT, "tools", name);
if (await exists(dir)) {
  console.error(`refusing to overwrite ${dir} — directory already exists`);
  process.exit(2);
}

// -----------------------------------------------------------------------------
// emit the scaffold
// -----------------------------------------------------------------------------

const dependencyEntries = [
  '    "@workbench/protocol": "workspace:*"',
  '    "@workbench/contract": "workspace:*"',
  ...usesResolved.map((u) => `    ${JSON.stringify(u.manifestName)}: "workspace:*"`),
];

const packageJson = `{
  "name": "@workbench/tool-${name}",
  "version": "0.1.0",
  "type": "module",
  "private": true,
  "dependencies": {
${dependencyEntries.join(",\n")}
  }
}
`;

// The tool.ts template is deliberately *literate*: the comments at the top
// are a chapter introducing the tool's intent, with placeholders that
// invite expansion rather than terse `// TODO` markers. New tools start as
// prose and get refined as code lands.
//
// We import the workspace packages declared via --uses as named imports so
// the IDE picks up the surface area immediately. Unused imports get a
// `void` reference so TS doesn't complain at scaffold time.

const usesImports = usesResolved
  .map((u) => `import * as ${jsIdent(u.pkg)} from "${u.manifestName}";`)
  .join("\n");
const usesVoidRefs = usesResolved.map((u) => `void ${jsIdent(u.pkg)};`).join("\n  ");

function jsIdent(pkg: string): string {
  // packages with hyphens become camelCase identifiers for ergonomic imports.
  return pkg.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}

const toolTs = `// =============================================================================
// ${name} — <one-line statement of what this tool computes>
// =============================================================================
//
// Intent
// ------
// <Two or three paragraphs of prose. What does this tool do, and why is it
// shaped the way it is? What are the load-bearing invariants? What's
// deliberately out of scope?>
//
// Input shape
// -----------
// <Describe the canonical input. If it's a record, list each field with
// its kind and what role it plays. If it accepts multiple shapes,
// enumerate.>
//
// Output shape
// ------------
// <Describe the canonical output. Note when error-flavoured outputs are
// possible (tagged values, record { ok: false, ... }) — see PRD §6.1 on the
// error-pattern decision.>
//
// Algorithm
// ---------
// <Sketch the algorithm. Cite papers / references. Note any non-obvious
// optimisations.>

import {
  bool,
  expr,
  int,
  list,
  rat,
  record,
  str,
  sym,
  tagged,
  ToolError,
  type Value,
} from "@workbench/protocol";
import { runTool } from "@workbench/contract";
${usesImports}

const NAME = "${name}";
const VERSION = "0.1.0";

void runTool({
  name: NAME,
  version: VERSION,
  schema: {
    // Replace with a representative input value describing the shape.
    input: expr("<describe-input>", []),
    // Replace with a representative output value describing the shape.
    output: expr("<describe-output>", []),
  },
  examples: [
    // PRD §6.1: aim for one example per code-path branch + edge cases,
    // ≥10 once the tool is "done." For v0.1 prototypes the soft floor is
    // 'every code-path branch covered.'
    {
      description: "<describe>",
      input: int(0n),
      output: int(0n),
    },
  ],
  invariants: [
    {
      name: "deterministic",
      statement: "same input bytes → same output bytes",
      machine_checkable: true,
    },
    // Add domain-specific invariants here. Each should be a one-line
    // statement of a property that holds for *every* in-scope input.
  ],
  fn: (input: Value, _flags: Record<string, string>): Value => {
    // TODO: implement. The runner has already parsed and validated the
    // input as a canonical Value; pattern-match on input.kind.
    void bool;
    void list;
    void rat;
    void record;
    void str;
    void sym;
    void tagged;
    void ToolError;
    ${usesVoidRefs}
    return input;
  },
  // Optional in-process property tests, runnable via \`bun tool.ts --test\`.
  // Use them for invariants checkable against a small set of probes — full
  // workspace tests live in packages/<pkg>/test/.
  // test: () => { ... },
});
`;

const readmeMd = `# ${name}

<one-paragraph summary of what this tool does and why an agent would reach for it>

## Input

\`\`\`jsonc
<canonical-encoded sample input>
\`\`\`

## Output

<describe shape, including any tagged-value error flavours>

## How

<algorithmic note — what's in scope, what's deliberately not, links to references>

## Invariants

- **deterministic**: same input bytes → same output bytes.
- ...

## Run

\`\`\`sh
echo '<input json>' | bun tools/${name}/tool.ts
\`\`\`

## Standard flags

\`--schema --examples --invariants --version --help --provenance-of <hash> --test\`
`;

const goldensSpec = `import { int } from "@workbench/protocol";
import type { GoldenSpec } from "@workbench/contract";

// Per-tool goldens. \`bun scripts/generate-goldens.ts\` runs the tool against
// each input and writes the canonical \`{input, output}\` record into
// goldens/. Aim for ≥30 entries before declaring the tool done (PRD §10.1
// item 4); v0.1 prototypes can ship with fewer if every code-path branch is
// covered.
export const goldens: GoldenSpec[] = [
  // { description: "trivial", input: int(0n) },
];

void int;
`;

await mkdir(dir, { recursive: true });
await mkdir(join(dir, "goldens"), { recursive: true });
await writeFile(join(dir, "package.json"), packageJson, "utf8");
await writeFile(join(dir, "tool.ts"), toolTs, "utf8");
await writeFile(join(dir, "README.md"), readmeMd, "utf8");
await writeFile(join(dir, "goldens.spec.ts"), goldensSpec, "utf8");

console.log(`scaffolded tools/${name}/`);
console.log(`  - package.json`);
if (usesResolved.length > 0) {
  console.log(`      uses: ${usesResolved.map((u) => u.manifestName).join(", ")}`);
}
console.log(`  - tool.ts          (literate template; expand the prose, fill schema/fn/examples/invariants)`);
console.log(`  - README.md        (agent-facing summary; keep in lockstep with tool.ts)`);
console.log(`  - goldens.spec.ts  (add inputs; run \`bun scripts/generate-goldens.ts --tool ${name}\`)`);
console.log(`  - goldens/         (auto-populated by the generator)`);
console.log("");

// Auto-resolve workspaces so the next thing the developer types isn't
// `bun install`. We swallow non-zero exit because if `bun install` fails
// it'll print its own diagnostic; we just want to chain the common path.
console.log(`running 'bun install' to resolve workspaces ...`);
const r = await spawnBun(["install"]);
if (r.code !== 0) {
  console.error(`bun install exited ${r.code}; run it manually before iterating`);
  if (r.stderr.trim().length > 0) console.error(r.stderr.trim());
}
console.log("");
console.log(`next:  bun tools/${name}/tool.ts --version`);
console.log(`       bun tools/${name}/tool.ts --schema`);
console.log(`       (then iterate on tool.ts; run \`bun run check:quick\` between edits)`);
