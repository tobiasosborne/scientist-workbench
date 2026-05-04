// =============================================================================
// integrate-1d goldens
// =============================================================================
//
// One golden per case in `reference/case-corpus.ts` — 30 cases total
// (24 value-shaped, 6 refusal-shaped). The case-corpus is the single
// source of truth for the integrand expressions; this file just
// builds the canonical wire-form input record for each case.
//
// Per the brief, this is *one* of two correctness mechanisms. The
// orthogonal-oracle check lives in the tool's `--test` hook and
// asserts agreement with SciPy/QUADPACK ground truth in
// `reference/manifest.json`. *This* mechanism — the goldens — locks
// the tool's *own bytes* in place once `--test` has approved them,
// so future runs that deviate byte-for-byte fail the oracle phase.

import { float64FromNumber, record, sym } from "@workbench/protocol";
import type { GoldenSpec } from "@workbench/contract";
import { caseCorpus } from "./reference/case-corpus.js";

export const goldens: GoldenSpec[] = caseCorpus.map((c) => ({
  description: `${c.id}: ${c.description}`,
  input: record({
    f: c.fExpr,
    var: sym("x"),
    a: float64FromNumber(c.a),
    b: float64FromNumber(c.b),
  }),
}));
