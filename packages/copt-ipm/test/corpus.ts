// Portable corpus-path resolution for tests that read goldens from
// the sibling `scientist-workbench-corpus` git repo (ADR-0028).
//
// Resolution order:
//   1. `process.env.WORKBENCH_CORPUS` if set (explicit override).
//   2. `../scientist-workbench-corpus` relative to this workbench
//      repo root (the canonical sibling-checkout convention).
//
// If neither resolves to a directory containing the expected suite,
// the test that depends on the corpus is skipped with a clear
// reason — *not* silently green, because that would defeat the
// purpose of having a corpus (Rule 7).
//
// The corpus suites used here:
//   - `benchmarks/lp-netlib/golden/{inputs,expected}.json`
//   - `benchmarks/lp-small/golden/{inputs,expected}.json`

import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..", ".."); // packages/copt-ipm/test → repo root
const DEFAULT_CORPUS = resolve(REPO_ROOT, "..", "scientist-workbench-corpus");

export function resolveCorpusPath(): string | null {
  const envPath = process.env["WORKBENCH_CORPUS"];
  const candidate = envPath !== undefined && envPath !== "" ? envPath : DEFAULT_CORPUS;
  return existsSync(candidate) ? candidate : null;
}

export interface CorpusSuite<TInput> {
  cases: { id: string; input: TInput }[];
  expByCase: Record<
    string,
    { status: string; objective?: number; tol_rel?: number }
  >;
}

export function loadSuite<TInput>(
  suite: "lp-netlib" | "lp-small",
): CorpusSuite<TInput> | null {
  const corpus = resolveCorpusPath();
  if (corpus === null) return null;
  const inputsPath = resolve(corpus, "benchmarks", suite, "golden", "inputs.json");
  const expectedPath = resolve(corpus, "benchmarks", suite, "golden", "expected.json");
  if (!existsSync(inputsPath) || !existsSync(expectedPath)) return null;

  const inputs = JSON.parse(readFileSync(inputsPath, "utf-8")) as {
    cases: { id: string; input: TInput }[];
  };
  const expected = JSON.parse(readFileSync(expectedPath, "utf-8")) as {
    cases: { id: string; expected: { status: string; objective?: number; tol_rel?: number } }[];
  };
  const expByCase: Record<string, { status: string; objective?: number; tol_rel?: number }> = {};
  for (const c of expected.cases) expByCase[c.id] = c.expected;
  return { cases: inputs.cases, expByCase };
}
