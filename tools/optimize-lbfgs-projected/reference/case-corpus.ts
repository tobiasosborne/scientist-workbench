// =============================================================================
// case-corpus.ts — TS mirror of generate-from-scipy.py's CASES table
// =============================================================================
//
// The orthogonal-oracle manifest (`manifest.json`) is keyed by case
// id. Each entry's `input` field carries the canonical wire-form
// record the tool ingests; we don't need to re-build f / grad
// expressions in TypeScript because the manifest *is* the source of
// truth for them.
//
// What this file *does* expose: a typed view over each manifest
// entry that's convenient for the tool's `--test` hook and
// `goldens.spec.ts` to walk in lockstep.
//
//   * `id`             — matches the manifest's case id.
//   * `description`    — human-readable case description.
//   * `category`       — tier ("smooth-easy", "canonical", ...).
//   * `kind`           — "value" or "refusal".
//   * `input`          — the canonical wire-form `Value` for this
//                        case's input record. Walking the manifest
//                        and validating each `input` against the
//                        tool's `inputSchema` is part of the
//                        `--test` hook.
//   * `vars`           — variable names in declaration order.
//   * `n`              — `vars.length`.
//   * `expectedFun?`   — the scipy reference's reported `f`.
//   * `expectedSuccess?` — for convergence-honesty cases, the
//                        success/fail expectation.
//   * `expectedRefusal?` — for refusal cases, the refusal class
//                        (the tag suffix or "ToolError").

import type { Value } from "@workbench/protocol";
import manifestJson from "./manifest.json" with { type: "json" };

export interface CorpusCase {
  readonly id: string;
  readonly description: string;
  readonly category: string;
  readonly kind: "value" | "refusal";
  /** Canonical wire-form input record (matches the tool's input schema). */
  readonly input: Value;
  readonly vars: readonly string[];
  readonly n: number;
  /** Only for value cases. The reference (scipy) reported f. */
  readonly expectedFun?: number;
  /** Only for value cases. The reference (scipy) reported gradient infinity norm. */
  readonly expectedGradInfNorm?: number;
  /** Only for value cases. The reference (scipy) success flag. */
  readonly expectedSuccess?: boolean;
  /** Only for value cases. The reference (scipy) status code. */
  readonly expectedStatus?: number;
  /**
   * Only for refusal cases. The expected refusal class — either the
   * tag suffix (e.g. `infeasible-bounds`) or the string `"ToolError"`
   * for malformed-input rejection.
   */
  readonly expectedRefusal?:
    | "infeasible-bounds"
    | "x0-outside-bounds"
    | "ToolError";
}

interface ManifestShape {
  readonly _meta: {
    readonly tolerance_recommendation: Readonly<Record<string, { atol: string; rtol: string; note?: string }>>;
    readonly default_options: Readonly<Record<string, number>>;
  };
  readonly cases: readonly ManifestCase[];
}

interface ManifestCase {
  readonly id: string;
  readonly description: string;
  readonly category: string;
  readonly kind: "value" | "refusal";
  readonly input: Value;
  readonly vars: readonly string[];
  readonly n: number;
  readonly scipy?: {
    readonly fun: number;
    readonly grad_inf_norm: number;
    readonly success: boolean;
    readonly status: number;
  };
  readonly expected_refusal_class?: "infeasible-bounds" | "x0-outside-bounds" | "ToolError";
  readonly expected_success?: boolean;
}

// The manifest's wire-form input has been validated as canonical
// Value-JSON by the Python generator; we trust the structure here.
// A `--test` hook re-validates each input against the tool's
// `inputSchema` to catch any drift.
const manifest = manifestJson as unknown as ManifestShape;

export const caseCorpus: readonly CorpusCase[] = manifest.cases.map((c) => {
  const base: CorpusCase = {
    id: c.id,
    description: c.description,
    category: c.category,
    kind: c.kind,
    input: c.input,
    vars: c.vars,
    n: c.n,
  };
  if (c.kind === "value" && c.scipy !== undefined) {
    return {
      ...base,
      expectedFun: c.scipy.fun,
      expectedGradInfNorm: c.scipy.grad_inf_norm,
      expectedSuccess: c.scipy.success,
      expectedStatus: c.scipy.status,
      expectedSuccess_override: c.expected_success,
    } as CorpusCase;
  }
  if (c.kind === "refusal" && c.expected_refusal_class !== undefined) {
    return { ...base, expectedRefusal: c.expected_refusal_class };
  }
  return base;
});

/** The category → tolerance map exposed for the --test hook. */
export const TOLERANCES: Readonly<Record<string, { atol: number; rtol: number }>> =
  Object.fromEntries(
    Object.entries(manifest._meta.tolerance_recommendation).map(([k, v]) => [
      k,
      { atol: parseFloat(v.atol), rtol: parseFloat(v.rtol) },
    ]),
  );

/** The default options bundled in the manifest. */
export const DEFAULT_OPTIONS: Readonly<Record<string, number>> = manifest._meta.default_options;
