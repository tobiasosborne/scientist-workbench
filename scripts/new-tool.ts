// Scaffold a new tool: tools/<name>/{package.json, tool.ts, README.md, goldens.spec.ts, goldens/}.
// Usage:  bun scripts/new-tool.ts <name>
//
// Refuses to overwrite an existing directory. After scaffolding, run
// `bun install` so workspaces resolve, then iterate on tool.ts.

import { mkdir, writeFile, access } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);

const name = process.argv[2];
if (!name) {
  console.error("usage: bun scripts/new-tool.ts <name>");
  console.error("       (e.g. cas-reduce, expr-print, latex-parse)");
  process.exit(2);
}
if (!/^[a-z][a-z0-9-]*$/.test(name)) {
  console.error(`tool name must match /^[a-z][a-z0-9-]*$/; got ${JSON.stringify(name)}`);
  process.exit(2);
}

const dir = join(ROOT, "tools", name);

async function exists(p: string): Promise<boolean> {
  try {
    await access(p, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

if (await exists(dir)) {
  console.error(`refusing to overwrite ${dir} — directory already exists`);
  process.exit(2);
}

const packageJson = `{
  "name": "@workbench/tool-${name}",
  "version": "0.1.0",
  "type": "module",
  "private": true,
  "dependencies": {
    "@workbench/protocol": "workspace:*",
    "@workbench/contract": "workspace:*"
  }
}
`;

const toolTs = `// ${name} — <one-line summary of what this tool does>.
// Input:  <describe expected input shape>
// Output: <describe output shape>
//
// Invariants enforced: <list>
// Out of scope: <list>

import {
  expr,
  int,
  record,
  str,
  type Value,
} from "@workbench/protocol";
import { runTool } from "@workbench/contract";

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
    {
      description: "trivial pass-through",
      input: int(0n),
      output: int(0n),
    },
    // Aim for ≥10 examples by the time the tool is "done" (PRD §6.1).
  ],
  invariants: [
    {
      name: "deterministic",
      statement: "same input bytes → same output bytes",
      machine_checkable: true,
    },
    // Add domain-specific invariants here.
  ],
  fn: (input: Value, _flags: Record<string, string>): Value => {
    // TODO: implement.
    void record;
    void str;
    return input;
  },
  // Optional in-process property tests, runnable via \`bun tool.ts --test\`.
  // test: () => { ... },
});
`;

const readmeMd = `# ${name}

<one-paragraph summary>

## Input

<describe shape, with an example JSON value>

## Output

<describe shape>

## How

<algorithmic note — what's in scope, what's deliberately not>

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

const goldensSpec = `import type { GoldenSpec } from "@workbench/contract";

// Per-tool goldens. \`bun scripts/generate-goldens.ts\` will run the tool against
// each input and write the canonical \`{input, output}\` record into goldens/.
// Aim for ≥30 entries before declaring the tool done (PRD §10.1 item 4).
export const goldens: GoldenSpec[] = [
  // {
  //   description: "trivial pass-through",
  //   input: { kind: "integer", value: "0" },
  // },
];
`;

await mkdir(dir, { recursive: true });
await mkdir(join(dir, "goldens"), { recursive: true });
await writeFile(join(dir, "package.json"), packageJson, "utf8");
await writeFile(join(dir, "tool.ts"), toolTs, "utf8");
await writeFile(join(dir, "README.md"), readmeMd, "utf8");
await writeFile(join(dir, "goldens.spec.ts"), goldensSpec, "utf8");

console.log(`scaffolded tools/${name}/`);
console.log(`  - package.json`);
console.log(`  - tool.ts          (fill in the schema / fn / examples / invariants)`);
console.log(`  - README.md`);
console.log(`  - goldens.spec.ts  (add inputs; run \`bun scripts/generate-goldens.ts --tool ${name}\`)`);
console.log(`  - goldens/         (auto-populated by the generator)`);
console.log("");
console.log("next:  bun install         # so workspaces resolve");
console.log(`       bun tools/${name}/tool.ts --version`);
