// =============================================================================
// optimize-lbfgs-projected goldens
// =============================================================================
//
// One golden per *value-shaped* case in `reference/case-corpus.ts`
// (21 of the 25 manifest cases). The case-corpus is the single
// source of truth for the input expressions; this file just exposes
// each case's already-canonical wire-form input.
//
// Per the brief, this is *one* of two correctness mechanisms. The
// orthogonal-oracle check lives in the tool's `--test` hook and
// asserts agreement with the SciPy / Fortran-v3.0 ground truth in
// `reference/manifest.json`. *This* mechanism — the goldens — locks
// the tool's *own bytes* in place once `--test` has approved them,
// so future runs that deviate byte-for-byte fail the oracle phase
// of `bun run check`.
//
// Refusal cases do NOT get goldens: the tool's behaviour for them
// is governed by ADR-0003 (boundary-tag or ToolError). The --test
// hook validates the boundary-tag refusal cases (F1, F4) and the
// ToolError refusal cases (F2, F3) directly.

import type { GoldenSpec } from "@workbench/contract";
import { caseCorpus } from "./reference/case-corpus.js";

export const goldens: GoldenSpec[] = caseCorpus
  .filter((c) => c.kind === "value")
  .map((c) => ({
    description: `${c.id}: ${c.description}`,
    input: c.input,
  }));
