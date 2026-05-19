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
// Phase 3 status (bead 3ynw / T1, worklog 140)
// --------------------------------------------
// `tools/integrate-1d` now consumes THIS dispatcher (re-exported as
// `evalNumericExprWithSpecial` from the package barrel) so that
// `Erf` / `Erfc` / `Erfcx` / `Erfi` / `InverseErf` / `InverseErfc`
// are admitted as integrand heads. The earlier note here ("the
// integrand evaluator does NOT use this dispatcher — by design")
// reflected the I5 implementer's expectation that a separate
// `tools/special-eval` would carry the special vocabulary; Phase 3
// re-decided that the integrand evaluator should pick up the
// special heads directly. The change is additive: every elementary
// integrand the tool used to accept still evaluates byte-identically,
// and the new heads work in compositions (`Erf(sin(x))`,
// `*(Erf(x), exp(-x²))`, `sin(Erf(x))`).
//
// Dispatch shape
// --------------
// The walker is a two-pass evaluator. Pass 1 (`foldSpecialHeads`)
// walks the AST and rewrites every special-head subexpression into
// a pre-evaluated `float64` leaf — the dispatch table is consulted
// here, and arguments to a special head are themselves folded
// recursively (so `Erf(sin(x) + Erf(0.5))` resolves the inner `Erf`
// first, then `sin`, then the outer `Erf`). Pass 2 delegates the
// rewritten elementary-only tree to `evalElementary`, which handles
// the arithmetic and elementary-transcendental dispatch unchanged.
//
// Why two passes rather than one self-recursive walker: pass 1 is
// O(n) and contained entirely in *this* module — the elementary
// head set, the elementary AST walker, and the elementary error
// surface remain the single source of truth in `eval-expr.ts`. The
// alternative (a self-recursive walker duplicating `applyHead`'s
// switch) would split the elementary dispatch into two physical
// locations and create a maintenance hazard whenever the elementary
// vocabulary grows.
//
// The v0.1 implementation of this file delegated non-special
// expressions to `evalElementary` directly, which then re-recursed
// through its own elementary-only evaluator — so `*(Erf(x), …)` saw
// `Erf` through the elementary path and threw
// `UnknownVocabularyError`. The two-pass fold above closes that gap
// without re-implementing the elementary walker.
//
// Unknown heads still throw `UnknownVocabularyError` exactly as the
// elementary evaluator does.
//
// Determinism contract (ADR-0015 `numerical: true`)
// -------------------------------------------------
// Inherits the substrate's contract: bit-identical given platform
// fingerprint. The dispatch table itself is pure JS; the per-head
// implementations carry the float64 fingerprint of V8's `Math.*`.

import { expr, float64FromNumber, type Value } from "@workbench/protocol";
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
import {
  besselJFloat64,
  besselYFloat64,
  besselIFloat64,
  besselKFloat64,
} from "./special-funcs/bessel-float64.js";
import {
  gammaFloat64,
  lgammaFloat64,
  digammaFloat64,
  trigammaFloat64,
  polygammaFloat64,
  pochhammerFloat64,
  gammaPFloat64,
  gammaQFloat64,
  incGammaUpperFloat64,
  incGammaLowerFloat64,
  invGammaPFloat64,
  invGammaQFloat64,
  betaFloat64,
  logBetaFloat64,
  gammaRatioFloat64,
  gammaDeltaRatioFloat64,
  gammaPDerivativeFloat64,
  incBetaFloat64,
  barnesGFloat64,
  hyperfactorialFloat64,
} from "./special-funcs/gamma-float64.js";

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
  // Bessel family (ADR-0041 §Decision 4). All arity-2: (ν, z).
  // BesselIScaled / BesselKScaled are NOT admitted as primary heads
  // (per ADR-0041 §Decision 7 — they are wire-tool concepts in
  // tools/special-eval; users compose them via Times(Exp(...),
  // BesselI(...)) which evalNumericExpr already handles).
  "BesselJ",
  "BesselY",
  "BesselI",
  "BesselK",
  // Gamma family (ADR-0042 §Decision 4). 19 ADMITTED_HEADS per R3 §1.
  // Vocabulary admits 6 new heads (LogGamma, Pochhammer, IncompleteGamma
  // Upper/Lower, Beta, BarnesG) per Decision 6; the float64 dispatcher
  // admits more (P/Q regularised, ratios, derivative, LogBeta,
  // Hyperfactorial, inverse P/Q) — the Erfi-precedent split between
  // vocab admission and dispatcher admission.
  "Gamma",
  "LogGamma",
  "Digamma",
  "Trigamma",
  "Polygamma",
  "Pochhammer",
  "IncompleteGammaUpper",
  "IncompleteGammaLower",
  "IncompleteGammaP",
  "IncompleteGammaQ",
  "InverseIncompleteGammaP",
  "InverseIncompleteGammaQ",
  "Beta",
  "LogBeta",
  "IncompleteBeta",
  "BarnesG",
  "Hyperfactorial",
  "GammaRatio",
  "GammaDeltaRatio",
  "GammaPDerivative",
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
  [
    "BesselJ",
    (a) => {
      requireArity("BesselJ", a, 2);
      return besselJFloat64(a[0]!, a[1]!);
    },
  ],
  [
    "BesselY",
    (a) => {
      requireArity("BesselY", a, 2);
      return besselYFloat64(a[0]!, a[1]!);
    },
  ],
  [
    "BesselI",
    (a) => {
      requireArity("BesselI", a, 2);
      return besselIFloat64(a[0]!, a[1]!);
    },
  ],
  [
    "BesselK",
    (a) => {
      requireArity("BesselK", a, 2);
      return besselKFloat64(a[0]!, a[1]!);
    },
  ],
  // Gamma family (ADR-0042 §Decision 4). Per R3 §1 verbatim-port table.
  // See `gamma-float64.ts` for per-function narrative.
  ["Gamma", (a) => { requireArity("Gamma", a, 1); return gammaFloat64(a[0]!); }],
  ["LogGamma", (a) => { requireArity("LogGamma", a, 1); return lgammaFloat64(a[0]!).value; }],
  ["Digamma", (a) => { requireArity("Digamma", a, 1); return digammaFloat64(a[0]!); }],
  ["Trigamma", (a) => { requireArity("Trigamma", a, 1); return trigammaFloat64(a[0]!); }],
  ["BarnesG", (a) => { requireArity("BarnesG", a, 1); return barnesGFloat64(a[0]!); }],
  ["Hyperfactorial", (a) => { requireArity("Hyperfactorial", a, 1); return hyperfactorialFloat64(a[0]!); }],
  ["Polygamma", (a) => { requireArity("Polygamma", a, 2); return polygammaFloat64(a[0]!, a[1]!); }],
  ["Pochhammer", (a) => { requireArity("Pochhammer", a, 2); return pochhammerFloat64(a[0]!, a[1]!); }],
  ["IncompleteGammaP", (a) => { requireArity("IncompleteGammaP", a, 2); return gammaPFloat64(a[0]!, a[1]!); }],
  ["IncompleteGammaQ", (a) => { requireArity("IncompleteGammaQ", a, 2); return gammaQFloat64(a[0]!, a[1]!); }],
  ["IncompleteGammaLower", (a) => { requireArity("IncompleteGammaLower", a, 2); return incGammaLowerFloat64(a[0]!, a[1]!); }],
  ["IncompleteGammaUpper", (a) => { requireArity("IncompleteGammaUpper", a, 2); return incGammaUpperFloat64(a[0]!, a[1]!); }],
  ["InverseIncompleteGammaP", (a) => { requireArity("InverseIncompleteGammaP", a, 2); return invGammaPFloat64(a[0]!, a[1]!); }],
  ["InverseIncompleteGammaQ", (a) => { requireArity("InverseIncompleteGammaQ", a, 2); return invGammaQFloat64(a[0]!, a[1]!); }],
  ["Beta", (a) => { requireArity("Beta", a, 2); return betaFloat64(a[0]!, a[1]!); }],
  ["LogBeta", (a) => { requireArity("LogBeta", a, 2); return logBetaFloat64(a[0]!, a[1]!).value; }],
  ["GammaRatio", (a) => { requireArity("GammaRatio", a, 2); return gammaRatioFloat64(a[0]!, a[1]!); }],
  ["GammaDeltaRatio", (a) => { requireArity("GammaDeltaRatio", a, 2); return gammaDeltaRatioFloat64(a[0]!, a[1]!); }],
  ["GammaPDerivative", (a) => { requireArity("GammaPDerivative", a, 2); return gammaPDerivativeFloat64(a[0]!, a[1]!); }],
  ["IncompleteBeta", (a) => { requireArity("IncompleteBeta", a, 3); return incBetaFloat64(a[0]!, a[1]!, a[2]!); }],
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
 * Two-pass implementation (Phase 3, bead 3ynw):
 *   1. `foldSpecialHeads` walks the AST and rewrites every
 *      special-head subexpression `expr(SH, [arg₀, …])` into a
 *      `float64` leaf carrying the evaluated `SH(arg₀, …)` value.
 *      Arguments are folded recursively first, so nested specials
 *      (e.g. `Erf(Erf(x))`) and specials inside elementary
 *      compositions (`*(Erf(x), exp(-x²))`) both work.
 *   2. The rewritten tree is delegated to `evalElementary`
 *      (`eval-expr.ts`'s evaluator) which sees only the elementary
 *      vocabulary plus numeric leaves and dispatches as it would for
 *      a special-free input.
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
  const folded = foldSpecialHeads(e, env);
  return evalElementary(folded, env);
}

/**
 * Recursively rewrite every special-head subexpression into a
 * `float64` leaf carrying the evaluated value. Non-special
 * expressions are walked through (their arg list is rewritten
 * recursively); leaves (`integer` / `rational` / `float64` /
 * `symbol`) and non-expression values pass through unchanged.
 *
 * The walk is in evaluation order — special-head args are folded
 * before the special head is dispatched, so nesting of any depth
 * resolves bottom-up. The output is structurally identical to the
 * input on inputs that contain no special heads; this is the
 * byte-identical-elementary-fallback guarantee (no Phase 3 change
 * to the elementary path).
 */
function foldSpecialHeads(e: Value, env: Map<string, number>): Value {
  if (e.kind !== "expression") return e;
  const foldedArgs = e.args.map((a) => foldSpecialHeads(a, env));
  if (SPECIAL_HEADS_SET.has(e.head)) {
    const dispatch = SPECIAL_DISPATCH.get(e.head)!;
    const evaluatedArgs = foldedArgs.map((a) => evalElementary(a, env));
    return float64FromNumber(dispatch(evaluatedArgs));
  }
  // Non-special expression with possibly-rewritten args. Preserve
  // referential equality when no rewrite happened (saves an
  // allocation per integrand node on Erf-free input — the common
  // case for everything that worked before this Phase 3 change).
  let rewrote = false;
  for (let i = 0; i < e.args.length; i++) {
    if (foldedArgs[i] !== e.args[i]) { rewrote = true; break; }
  }
  if (!rewrote) return e;
  return expr(e.head, foldedArgs);
}

export { ADMITTED_CONSTANTS, UnknownVocabularyError };
