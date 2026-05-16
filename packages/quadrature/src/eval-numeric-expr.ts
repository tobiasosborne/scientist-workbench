// =============================================================================
// eval-numeric-expr.ts — float64 numeric evaluator with special-function dispatch
// =============================================================================
//
// Intent
// ------
// This is the sibling of `eval-expr.ts` that extends the closed
// integrand vocabulary with the special-function heads pinned by
// ADR-0040 (`docs/adr/0040-per-head-special-function-substrate-and-meijer-g-bridge.md`,
// Decision 4). The Erf family is the v0.1 instantiation; subsequent
// ADRs add Bessel, Whittaker, Legendre, etc. without re-touching this
// dispatcher's shape.
//
// Why a sibling instead of an in-place extension?
// -----------------------------------------------
// `eval-expr.ts` is the *integrand evaluator* consumed by
// `tools/integrate-1d`. Its vocabulary is deliberately narrow — only
// the elementary heads the adaptive quadrature driver expects, plus
// the closed list of constants. Hooking Erf / Erfc / Erfi directly
// into that module would conflate two concerns: the quadrature
// integrand vocabulary (small, stable, hand-curated for the
// integration use case) and the special-function dispatch hub
// (growing additively as ADRs ship). The sibling keeps
// `tools/integrate-1d`'s import graph minimal and makes the
// special-function dispatch a separately-versioned surface.
//
// Note: the integrand evaluator does NOT use this dispatcher — by
// design. Users who want erf-in-the-integrand can compose via the
// `applySpecial`-aware evaluator below; that path lives in
// `tools/special-eval` (filed under ADR-0040 Decision 7) when it
// ships. `tools/integrate-1d` continues to use `eval-expr.ts`'s
// elementary-only vocabulary, and an `Erf` head in an integrand
// surfaces as `UnknownVocabularyError` there — which is the right
// failure: integration with Erf requires the agent to opt into the
// special-eval surface.
//
// Dispatch shape
// --------------
// The `applySpecial(head, args, env)` callback returns a `number` for
// recognised heads, or `null` to indicate "not in this dispatch
// table's scope". The walker forwards to `applySpecial` *before* the
// `eval-expr.ts` head-set check, so the same head name can extend the
// vocabulary additively. Unknown heads still throw
// `UnknownVocabularyError` exactly as the elementary evaluator does
// (via the fall-through to `evalNumericExpr` from `eval-expr.ts`).
//
// Determinism contract (ADR-0015 `numerical: true`)
// -------------------------------------------------
// Inherits the substrate's contract: bit-identical given platform
// fingerprint. The dispatch table itself is pure JS; the per-head
// implementations carry the float64 fingerprint of V8's `Math.*`.

import type { Value } from "@workbench/protocol";
import {
  evalNumericExpr as evalElementary,
  ADMITTED_HEADS as ELEMENTARY_HEADS,
  ADMITTED_CONSTANTS,
  UnknownVocabularyError,
} from "./eval-expr.js";
import {
  erfFloat64,
  erfcFloat64,
  erfcxFloat64,
  erfiFloat64,
  erfInvFloat64,
  erfcInvFloat64,
} from "./special-funcs/erf-float64.js";

/**
 * Special-function heads admitted in addition to the elementary
 * vocabulary. Mirrors ADR-0023's `SPECIAL_FUNCTION_HEADS` projection
 * onto float64-evaluable scalars (`InverseErf` / `InverseErfc` are
 * included; `Erfi` is part of ADR-0040's amendment to that table).
 * Future per-head ADRs (Bessel, etc.) extend this list additively.
 */
export const SPECIAL_HEADS: readonly string[] = [
  "Erf",
  "Erfc",
  "Erfcx",
  "Erfi",
  "InverseErf",
  "InverseErfc",
];

/** Union of elementary + special heads, exported for tool layer messages. */
export const ADMITTED_HEADS: readonly string[] = [...ELEMENTARY_HEADS, ...SPECIAL_HEADS];

const SPECIAL_HEADS_SET = new Set<string>(SPECIAL_HEADS);

/**
 * Per-head float64 dispatch table. Each entry receives the already-
 * evaluated `number[]` arguments and returns the scalar result. All
 * v0.1 heads are unary; future multi-arg heads (e.g. `BesselJ(n, x)`)
 * will use the same signature.
 */
const SPECIAL_DISPATCH = new Map<string, (args: number[]) => number>([
  [
    "Erf",
    (a) => {
      requireArity("Erf", a, 1);
      return erfFloat64(a[0]!);
    },
  ],
  [
    "Erfc",
    (a) => {
      requireArity("Erfc", a, 1);
      return erfcFloat64(a[0]!);
    },
  ],
  [
    "Erfcx",
    (a) => {
      requireArity("Erfcx", a, 1);
      return erfcxFloat64(a[0]!);
    },
  ],
  [
    "Erfi",
    (a) => {
      requireArity("Erfi", a, 1);
      return erfiFloat64(a[0]!);
    },
  ],
  [
    "InverseErf",
    (a) => {
      requireArity("InverseErf", a, 1);
      return erfInvFloat64(a[0]!);
    },
  ],
  [
    "InverseErfc",
    (a) => {
      requireArity("InverseErfc", a, 1);
      return erfcInvFloat64(a[0]!);
    },
  ],
]);

function requireArity(head: string, args: number[], n: number): void {
  if (args.length !== n) {
    throw new UnknownVocabularyError("head", `${head} (arity ${args.length})`);
  }
}

/**
 * Recursive float64 evaluator that admits both the elementary
 * integrand vocabulary AND the closed special-function vocabulary
 * shipped by ADR-0040.
 *
 * Semantics mirror `eval-expr.ts::evalNumericExpr`:
 *   - Leaf nodes (`integer` / `rational` / `float64` / `symbol`) go
 *     through the elementary evaluator unchanged.
 *   - `expression` nodes whose head is in `SPECIAL_HEADS` route to
 *     the dispatch table; argument evaluation recurses through *this*
 *     evaluator (so `Erf(sin(x))` works).
 *   - All other `expression` nodes fall through to the elementary
 *     evaluator. Unknown elementary heads still throw
 *     `UnknownVocabularyError` from there.
 *
 * Throws `UnknownVocabularyError` on unrecognised heads or symbols.
 *
 * Determinism: the dispatch order is fixed by the order of the
 * `Map<>` insertion above; the per-head impls are bit-identical to
 * their respective primary sources (SunPro 1993 for Erf/Erfc/Erfcx,
 * Faddeeva-Johnson 2012 for complex w(z) used by Erfi, Blair 1976 for
 * inverses). The output bytes are reproducible given the ADR-0015
 * platform fingerprint.
 */
export function evalNumericExpr(e: Value, env: Map<string, number>): number {
  if (e.kind === "expression" && SPECIAL_HEADS_SET.has(e.head)) {
    const dispatch = SPECIAL_DISPATCH.get(e.head)!;
    const evaluatedArgs = e.args.map((arg) => evalNumericExpr(arg, env));
    return dispatch(evaluatedArgs);
  }
  return evalElementary(e, env);
}

export { ADMITTED_CONSTANTS, UnknownVocabularyError };
