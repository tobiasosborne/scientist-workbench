// =============================================================================
// integrate-1d — adaptive 1D numerical integration
// =============================================================================
//
// Intent
// ------
// The second numerical-tier tool in scientist-workbench (ADR-0014 is
// the precedent; ADR-0015 is the determinism contract this tool opts
// into). Computes `∫_a^b f(x) dx` for a finite real interval and a
// closed-vocabulary integrand expression. Wire wrapper around
// `@workbench/quadrature`'s `gaussKronrodAdaptive` + `evalNumericExpr`.
//
// What makes this tool agent-honest (the load-bearing design choice):
// the output is *not* just `value`. It is a record carrying everything
// an agent's planner needs to decide what to do with the answer:
//
//     {
//       value,          // best estimate of the integral
//       error_estimate, // conservative upper bound on truncation error
//       n_evals,        // number of f-evaluations spent
//       converged,      // honest "did we hit the requested tolerance?"
//       iterations,     // bisection iterations performed
//       method,         // "gauss-kronrod-g7k15"
//       warnings,       // human-readable diagnostics (e.g. budget hit)
//     }
//
// `converged` is a *field*, not a separate boundary category — same
// shape pattern as `linalg-solve`'s `warnings` / `condition_estimate`.
// A planner reads `converged === false` and decides whether to retry
// with a higher budget, accept the value with the reported error
// bound, or warn the user.
//
// Boundary categories (ADR-0003)
// ------------------------------
//   * `integrate-1d/non-finite-during-eval` (tagged): the integrand
//     produced NaN / +Inf / -Inf at some quadrature node. Payload
//     carries the offending x and a string description of the value.
//   * `integrate-1d/degenerate-interval` (tagged): `a >= b`. Payload
//     carries a, b. Reversed (`a > b`) and empty (`a == b`) are both
//     refused — a tool that silently returned `-∫_b^a` for reversed
//     intervals would lose the agent the chance to spot a calling-
//     convention bug.
//   * Malformed input (`ToolError`, exit 1):
//     - `f` contains an unknown expression head or unknown free
//       symbol. Suggestion lists the admitted vocabulary.
//     - `var` is not a symbol value (caught by schema validation).
//     - `a` or `b` is non-finite (NaN / ±Inf) at input time.
//
// ADR-0015 — numerical tier
// -------------------------
// `numerical: true`. Every output containing `value: float64` is
// platform-conditional in the sense ADR-0015 names; the runner
// records the platform fingerprint on every successful run. The
// `--platform-fingerprint` standard flag emits the running
// fingerprint without doing any work, so an agent's planner can
// compare a stored provenance record to the running platform before
// invoking.
//
// Out of scope (v0.1, all explicitly deferred)
// --------------------------------------------
//   * Infinite intervals / improper integrals (Gauss-Hermite,
//     Gauss-Laguerre): tools/integrate-1d-infinite (deferred).
//   * Vector-valued or complex integrands.
//   * Higher-dimensional integration (cubature).
//   * Symbolic anti-derivatives.
//   * Integrand vocabulary beyond + - * / ^ neg exp sin cos tan log
//     sqrt abs and constants pi, e — extension would be additive.
//
// Algorithm
// ---------
// QUADPACK-style adaptive Gauss-Kronrod G7K15 with global priority-
// queue bisection, ported from GSL's `qk15.c` / `qk.c`. See
// `packages/quadrature/src/gauss-kronrod.ts` for the literate
// algorithm prose and the canonical-constant citations.

import {
  bool,
  expr,
  float64FromNumber,
  float64ToNumber,
  int,
  list,
  record,
  S,
  str,
  sym,
  tagged,
  ToolError,
  type Float64Value,
  type SymbolValue,
  type Value,
} from "@workbench/protocol";
import { defineTool, runTool } from "@workbench/contract";
import {
  ADMITTED_HEADS,
  ADMITTED_CONSTANTS,
  evalNumericExpr,
  gaussKronrodAdaptive,
  QuadratureNonFiniteError,
  UnknownVocabularyError,
  type QuadResult,
} from "@workbench/quadrature";

const NAME = "integrate-1d";
const VERSION = "0.1.0";

// -----------------------------------------------------------------------------
// Schema
// -----------------------------------------------------------------------------
//
// The integrand `f` is declared `S.any()` because a closed-form
// vocabulary check inside a recursive schema would be redundant with
// the per-node check in `evalNumericExpr`. The semantic check is
// done on first evaluation: an unknown head produces a `ToolError`
// with the admitted-vocabulary suggestion baked in.

const inputSchema = S.record({
  f: S.any(),
  var: S.kind("symbol"),
  a: S.kind("float64"),
  b: S.kind("float64"),
});

const successOutputSchema = S.record({
  value: S.kind("float64"),
  error_estimate: S.kind("float64"),
  n_evals: S.kind("integer"),
  converged: S.kind("boolean"),
  iterations: S.kind("integer"),
  method: S.kind("string"),
  warnings: S.list(S.kind("string")),
});

const nonFiniteOutputSchema = S.tagged(
  `${NAME}/non-finite-during-eval`,
  S.record({ at_x: S.kind("float64"), value: S.kind("string") }),
);

const degenerateOutputSchema = S.tagged(
  `${NAME}/degenerate-interval`,
  S.record({ a: S.kind("float64"), b: S.kind("float64") }),
);

const outputSchema = S.union([
  successOutputSchema,
  nonFiniteOutputSchema,
  degenerateOutputSchema,
]);

// -----------------------------------------------------------------------------
// Convenience helpers used by `examples` and the tool body
// -----------------------------------------------------------------------------

/** Build an input value from raw JS pieces. The TS return type is inferred narrow so it satisfies the schema-typed `examples` slot. */
function inp(f: Value, varName: string, a: number, b: number) {
  return record({
    f,
    var: sym(varName),
    a: float64FromNumber(a),
    b: float64FromNumber(b),
  });
}

/**
 * Encode a successful QuadResult as the canonical record output. Return
 * type is *inferred narrow* (no explicit annotation); we want the TS
 * type to mention every field literally so the schema-typed `examples`
 * slot can verify shape conformance at the call site rather than at
 * load-time only. (Same shape pattern as `linalg-solve`'s
 * `encodeSolveValue`.)
 */
function encodeSuccess(r: QuadResult) {
  return record({
    value: float64FromNumber(r.value),
    error_estimate: float64FromNumber(r.errorEstimate),
    n_evals: int(BigInt(r.nEvals)),
    converged: bool(r.converged),
    iterations: int(BigInt(r.iterations)),
    method: str(r.method),
    warnings: list(r.warnings.map((w) => str(w))),
  });
}

// -----------------------------------------------------------------------------
// Tool definition
// -----------------------------------------------------------------------------

export const def = defineTool({
  name: NAME,
  version: VERSION,
  schema: { input: inputSchema, output: outputSchema },
  // ADR-0015 numerical tier. The output always contains float64
  // leaves on the success branch, so the platform fingerprint is
  // recorded on every successful run. The boundary-tag branches
  // (degenerate-interval, non-finite-during-eval) also carry float64
  // leaves; the `containsFloat64` walker in the runner picks those up
  // too. Mutually exclusive with `nondeterministic: true`.
  numerical: true,
  examples: [
    {
      description: "∫_0^π sin(x) dx = 2 (smooth, converges on first pass)",
      input: inp(expr("sin", [sym("x")]), "x", 0, Math.PI),
      output: encodeSuccess(gaussKronrodAdaptive(Math.sin, 0, Math.PI)),
    },
    {
      description: "∫_0^1 exp(x) dx = e - 1",
      input: inp(expr("exp", [sym("x")]), "x", 0, 1),
      output: encodeSuccess(gaussKronrodAdaptive(Math.exp, 0, 1)),
    },
    {
      description: "∫_{-1}^{1} (x^4 - 2x^2 + 1) dx = 16/15",
      input: inp(
        // x^4 - 2x^2 + 1, written as +(^(x,4), neg(*(2, ^(x,2))), 1)
        expr("+", [
          expr("^", [sym("x"), int(4n)]),
          expr("neg", [expr("*", [int(2n), expr("^", [sym("x"), int(2n)])])]),
          int(1n),
        ]),
        "x",
        -1,
        1,
      ),
      output: encodeSuccess(
        gaussKronrodAdaptive((x: number) => x ** 4 - 2 * x * x + 1, -1, 1),
      ),
    },
    {
      description: "narrow Gaussian peak forces bisection (∫_0^1 exp(-100(x-0.5)^2) ≈ √π/10)",
      input: inp(
        // exp(neg(* 100 (^ (- x 0.5) 2)))
        expr("exp", [
          expr("neg", [
            expr("*", [
              int(100n),
              expr("^", [expr("-", [sym("x"), float64FromNumber(0.5)]), int(2n)]),
            ]),
          ]),
        ]),
        "x",
        0,
        1,
      ),
      output: encodeSuccess(
        gaussKronrodAdaptive((x: number) => Math.exp(-100 * (x - 0.5) ** 2), 0, 1),
      ),
    },
    {
      description: "degenerate interval a == b → tagged degenerate-interval",
      input: inp(sym("x"), "x", 1, 1),
      output: tagged(`${NAME}/degenerate-interval`, record({
        a: float64FromNumber(1),
        b: float64FromNumber(1),
      })),
    },
    {
      description: "pole at interior x=0.5 → tagged non-finite-during-eval",
      input: inp(
        // 1 / (x - 0.5)
        expr("/", [int(1n), expr("-", [sym("x"), float64FromNumber(0.5)])]),
        "x",
        0,
        1,
      ),
      output: tagged(`${NAME}/non-finite-during-eval`, record({
        at_x: float64FromNumber(0.5),
        value: str("Infinity"),
      })),
    },
  ],
  invariants: [
    {
      name: "deterministic-per-platform",
      statement: "same input bytes → same output bytes (single platform; ADR-0015 platform fingerprint recorded in provenance)",
      machine_checkable: true,
    },
    {
      name: "scipy-quadpack-agreement",
      statement: "for every case in tools/integrate-1d/reference/manifest.json, |reported value - manifest value| ≤ category tolerance OR converged=false (tool's --test hook enforces)",
      machine_checkable: true,
    },
    {
      name: "honest-converged-flag",
      statement: "converged=true ⇒ error_estimate ≤ atol + rtol * |value|; converged=false ⇒ warnings list contains the budget message",
      machine_checkable: true,
    },
    {
      name: "non-finite-tagged",
      statement: `integrand producing NaN/Inf at any node → tagged "${NAME}/non-finite-during-eval" with offending x — never silently wrong value`,
      machine_checkable: true,
    },
    {
      name: "degenerate-interval-tagged",
      statement: `a >= b → tagged "${NAME}/degenerate-interval" — never the silent-sign-flip a-vs-b convention`,
      machine_checkable: true,
    },
    {
      name: "unknown-vocabulary-rejected",
      statement: "integrand head outside admitted vocabulary raises ToolError listing the admitted heads",
      machine_checkable: true,
    },
  ],
  fn: (input, _flags) => {
    // The runner has validated the input shape against `inputSchema`.
    // Semantic checks (finite bounds, vocabulary) live below.
    const fields = input.fields;
    const a = float64ToNumber(fields.a as Float64Value);
    const b = float64ToNumber(fields.b as Float64Value);
    const varName = (fields.var as SymbolValue).name;
    const fExpr = fields.f as Value;

    // Bound-finiteness check (the runner accepts NaN-bit-pattern
    // `float64` values in principle; we refuse them at the boundary
    // because every quadrature claim presupposes finite endpoints).
    if (!Number.isFinite(a) || !Number.isFinite(b)) {
      throw new ToolError(
        `${NAME}: integration bounds must be finite (got a=${a}, b=${b})`,
        { suggestion: "supply finite IEEE-754 binary64 values for a and b" },
      );
    }

    // Degenerate interval: a == b OR a > b.
    if (a >= b) {
      return tagged(`${NAME}/degenerate-interval`, record({
        a: float64FromNumber(a),
        b: float64FromNumber(b),
      }));
    }

    // Build the JS-side integrand. The env Map is reused across
    // evaluations (mutated in place) — the adaptive driver calls
    // `f` thousands of times; allocating a fresh Map each call would
    // dominate the wall-clock cost.
    const env = new Map<string, number>([[varName, 0]]);
    const f = (x: number): number => {
      env.set(varName, x);
      return evalNumericExpr(fExpr, env);
    };

    let result: QuadResult;
    try {
      result = gaussKronrodAdaptive(f, a, b);
    } catch (err) {
      if (err instanceof QuadratureNonFiniteError) {
        // ADR-0003 boundary failure — the input was structurally
        // valid but the integrand stepped outside the tool's scope
        // of finite-valued integrands.
        return tagged(`${NAME}/non-finite-during-eval`, record({
          at_x: float64FromNumber(err.atX),
          value: str(formatNonFinite(err.fValue)),
        }));
      }
      if (err instanceof UnknownVocabularyError) {
        // Malformed input — `ToolError` is the right shape.
        throw new ToolError(
          `${NAME}: ${err.message}`,
          {
            suggestion: err.kind === "head"
              ? `admitted heads: ${ADMITTED_HEADS.join(", ")}`
              : `admitted free constants: ${ADMITTED_CONSTANTS.join(", ")}; the integration variable is "${varName}"`,
          },
        );
      }
      throw err;
    }

    return encodeSuccess(result);
  },
  test: async () => {
    // Orthogonal-oracle check: for every value-shaped case in the
    // manifest, run the tool's algorithm and assert agreement with
    // the SciPy/QUADPACK ground truth within the per-category
    // tolerance. The 2 cases flagged with `reference_disagreement`
    // (where SciPy and mpmath disagree) accept either the SciPy
    // value, the mpmath value, or an honest `converged: false`.
    //
    // The case-id → integrand mapping comes from
    // `tools/integrate-1d/reference/case-corpus.ts` (mirror of the
    // Python generator's `CASES` table). We import both the manifest
    // (for ground-truth values) and the corpus (for integrand
    // expressions) and walk them in lockstep.
    const { caseCorpus } = await import("./reference/case-corpus.js");
    const manifestModule = await import("./reference/manifest.json", {
      with: { type: "json" },
    });
    const manifest = manifestModule.default as ManifestShape;
    const tolerances = manifest._meta.tolerance_recommendation;

    const corpusById = new Map(caseCorpus.map((c) => [c.id, c]));
    let checked = 0;
    let acceptedDisagreement = 0;
    for (const entry of manifest.cases) {
      if (entry.kind !== "value") continue;
      const c = corpusById.get(entry.id);
      if (c === undefined) {
        throw new Error(`integrate-1d --test: case ${entry.id} missing from case-corpus.ts`);
      }
      const tolBlock = tolerances[entry.category];
      if (tolBlock === undefined) {
        throw new Error(`integrate-1d --test: unknown category ${entry.category} for ${entry.id}`);
      }
      const atol = parseFloat(tolBlock.atol);
      const rtol = parseFloat(tolBlock.rtol);

      const r = gaussKronrodAdaptive(c.f, c.a, c.b, { atol, rtol, maxEvals: 50000 });
      const got = r.value;

      const scipyVal = entry.scipy?.value;
      if (scipyVal === undefined) {
        throw new Error(`integrate-1d --test: ${entry.id} missing scipy.value in manifest`);
      }
      const tol = atol + rtol * Math.max(Math.abs(scipyVal), 1);

      const matchesScipy = Math.abs(got - scipyVal) <= tol;
      let matchesMpmath = false;
      if (entry.mpmath !== undefined) {
        matchesMpmath = Math.abs(got - entry.mpmath.value) <= tol;
      }

      if (entry.reference_disagreement !== undefined) {
        // Per the brief: accept SciPy, accept mpmath, or accept an
        // honest converged=false report.
        if (!matchesScipy && !matchesMpmath && r.converged) {
          throw new Error(
            `integrate-1d --test: ${entry.id} (reference_disagreement) — got ${got}; ` +
            `scipy ${scipyVal}, mpmath ${entry.mpmath?.value ?? "?"}; ` +
            `tol ${tol}; converged=${r.converged}`,
          );
        }
        acceptedDisagreement += 1;
      } else {
        // Standard cases — tolerance must be met.
        if (!matchesScipy) {
          throw new Error(
            `integrate-1d --test: ${entry.id} — got ${got}, expected ${scipyVal} ` +
            `(category ${entry.category}, tol ${tol}, |diff| ${Math.abs(got - scipyVal)})`,
          );
        }
      }
      checked += 1;
    }
    if (checked === 0) {
      throw new Error("integrate-1d --test: no value-shaped cases were checked — manifest empty?");
    }
    // Print a brief summary to stderr so a watching human gets confirmation.
    process.stderr.write(
      `integrate-1d --test: ${checked} cases agree with SciPy/QUADPACK ground truth ` +
      `(${acceptedDisagreement} reference-disagreement cases accepted under the relaxed rule)\n`,
    );
  },
});

function formatNonFinite(v: number): string {
  if (Number.isNaN(v)) return "NaN";
  if (v === Infinity) return "Infinity";
  if (v === -Infinity) return "-Infinity";
  return String(v);
}

// -----------------------------------------------------------------------------
// Manifest type — a typed view over reference/manifest.json
// -----------------------------------------------------------------------------
//
// The manifest is a frozen artefact (generated by the orchestrator's
// Python script); we *don't* validate against a schema here because
// the manifest's own format is the contract — drift surfaces as a
// `--test` failure rather than a schema violation.

interface ManifestShape {
  readonly _meta: {
    readonly tolerance_recommendation: Readonly<Record<string, { atol: string; rtol: string }>>;
  };
  readonly cases: readonly ManifestCase[];
}

interface ManifestCase {
  readonly id: string;
  readonly category: string;
  readonly kind: "value" | "refusal";
  readonly scipy?: { readonly value: number };
  readonly mpmath?: { readonly value: number };
  readonly reference_disagreement?: unknown;
}

if (import.meta.main) void runTool(def);
