// Shared type for per-tool goldens.spec.ts files. Each tool exports an array
// of GoldenSpec; the workspace's `scripts/generate-goldens.ts` walks them,
// runs the tool against each input, and writes `tools/<name>/goldens/<NN>-<slug>.golden.json`.

import type { Value } from "@workbench/protocol";

export interface GoldenSpec {
  description: string;
  input: Value;
  flags?: Record<string, string>;
}
