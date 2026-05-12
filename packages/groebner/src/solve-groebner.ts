// =============================================================================
// solve-groebner — end-to-end DRL → FGLM → shape extraction → solution set
// =============================================================================
//
// What this module is for
// -----------------------
// `solveGroebner(polys, vars)` is the substrate entry point that the
// `tools/solve` multivariate-poly dispatch lane calls. It composes the
// three pieces:
//
//   1. Compute the reduced DRL Gröbner basis via Buchberger
//      (`buchberger.ts`). This is the cheapest order on most benchmark
//      systems and is what the zero-dim test consumes.
//   2. Test zero-dimensionality on the DRL basis (CLO Ch.5 §3
//      Theorem 6, ordering-independent test). On failure, refuse with
//      `multivariate-non-zero-dim` carrying the DRL basis as the
//      payload.
//   3. Convert DRL → lex via FGLM (`fglm.ts`).
//   4. Extract solutions via the shape lemma (`shape-extract.ts`). On
//      shape failure, refuse with `shape-lemma-failure` carrying the
//      lex basis. On complex-root failure, refuse with `complex-
//      roots-not-yet-named` carrying the lex basis.
//
// Result envelope
// ---------------
// The result mirrors the existing `SolveResult` from `@workbench/
// solve` so the dispatcher in `packages/solve/src/dispatch.ts` can
// fold it in without translation. (The actual `Solution` /
// `SolveResult` types live there; we re-export-friendly shapes here
// so this package doesn't take a dependency on `@workbench/solve`.)
//
// References
// ----------
// - RESEARCH-NOTE-x8d.md §2 — the seven decisions implemented here.
// - ADR-0017 — solution-set value-protocol shape.
// - ADR-0019 — bench discipline (mathematical-invariant verification).

import {
  type Poly,
  type Rat,
  polyToValue,
} from "@workbench/cas-core";
import {
  list,
  type Value,
} from "@workbench/protocol";

import { buchbergerReduced } from "./buchberger.js";
import { isZeroDimensional } from "./buchberger.js";
import { drlOrder } from "./monomial-order.js";
import { fglm } from "./fglm.js";
import { extractShapeSolutions } from "./shape-extract.js";

/**
 * The successful or refusing outcome of `solveGroebner`. Mirrors the
 * `SolveResult` type from `@workbench/solve` so the dispatcher folds
 * it directly. Fields:
 *   - `kind: "success"` — a finite list of solutions, each a list of
 *     `{var, value}` bindings. `branches` is always `[]` (multivariate
 *     zero-dim solutions are discrete; transcendental branches don't
 *     apply).
 *   - `kind: "refusal"` — a class string in the `solve/<class>`
 *     taxonomy (without the `solve/` prefix; the caller adds it) and
 *     a detail message. Optional `payloadBasis` is the relevant GB
 *     (DRL or lex) for the refusal — useful for downstream
 *     introspection.
 */
export interface GroebnerSolveSuccess {
  readonly kind: "success";
  readonly vars: readonly string[];
  readonly solutions: readonly {
    readonly bindings: readonly { var: string; value: Value }[];
  }[];
  readonly warnings: readonly string[];
  readonly nPairs: number;
}

export interface GroebnerSolveRefusal {
  readonly kind: "refusal";
  readonly reasonClass: string;
  readonly detail: string;
  /** Computed basis (DRL for non-zero-dim, lex for shape failure). */
  readonly basis?: Value;
}

export type GroebnerSolveResult = GroebnerSolveSuccess | GroebnerSolveRefusal;

/**
 * Convert a list of polynomial Values (from the GB) to a value-
 * protocol list of expressions. The caller wraps this into the
 * refusal payload's `groebner_basis` field per ADR-0017's roster.
 */
function basisToValue(basis: readonly Poly<Rat>[]): Value {
  return list(basis.map((p) => polyToValue(p)));
}

/**
 * `solveGroebner(polys, vars)` — top-level multivariate-zero-dim
 * solver. The caller (`packages/solve/src/dispatch.ts`'s
 * `dispatchMultivariatePoly`) has already converted the user input
 * to `Poly<Rat>` and verified that every variable is in `vars`.
 *
 * Output:
 *   - On a happy path, `{ kind: "success", solutions, vars,
 *     warnings, nPairs }`. `nPairs` is the count of S-pairs
 *     considered during Buchberger, useful for bench reporting.
 *   - On a refusal, `{ kind: "refusal", reasonClass, detail, basis? }`.
 *
 * Refusal classes:
 *   - `multivariate-non-zero-dim` — Krull dim > 0; payload is DRL GB.
 *   - `shape-lemma-failure`      — lex GB not in shape position.
 *   - `complex-roots-not-yet-named` — g_n has irreducible deg ≥ 5
 *     factor with complex roots; alg-num v0.1 refuses.
 */
export function solveGroebner(
  polys: readonly Poly<Rat>[],
  vars: readonly string[],
): GroebnerSolveResult {
  // Step 1: DRL Gröbner basis.
  const drl = drlOrder(vars);
  const drlResult = buchbergerReduced(polys, drl);
  const drlBasis = drlResult.basis;

  // Step 2: zero-dimensionality test.
  if (!isZeroDimensional(drlBasis, vars, drl)) {
    return {
      kind: "refusal",
      reasonClass: "multivariate-non-zero-dim",
      detail:
        `polynomial ideal in ${vars.length} variable(s) has positive Krull dimension; `
        + `Gröbner basis under DRL has |G| = ${drlBasis.length} but no pure power of `
        + `at least one variable appears as a leading monomial`,
      basis: basisToValue(drlBasis),
    };
  }

  // Inconsistent system — the GB is [1]. Return an empty solution set
  // honestly (mirrors `dispatchLinear`'s `inconsistent` arm).
  if (drlBasis.length === 1) {
    const t = drlBasis[0]!.terms;
    if (t.length === 1 && t[0]!.exp.length === 0) {
      return {
        kind: "success",
        vars,
        solutions: [],
        warnings: [],
        nPairs: drlResult.nPairs,
      };
    }
  }

  // Step 3: FGLM DRL → lex.
  let lexBasis: readonly Poly<Rat>[];
  try {
    lexBasis = fglm(drlBasis, vars);
  } catch (e) {
    // FGLM throws only on a programming-error (positive-dim slipping
    // past the zero-dim test). Surface the error honestly.
    const msg = e instanceof Error ? e.message : String(e);
    return {
      kind: "refusal",
      reasonClass: "shape-lemma-failure",
      detail: `FGLM internal error: ${msg}`,
      basis: basisToValue(drlBasis),
    };
  }

  // Step 4: shape extraction.
  const extract = extractShapeSolutions(lexBasis, vars);
  if (extract.kind === "refusal") {
    return {
      kind: "refusal",
      reasonClass: extract.reasonClass,
      detail: extract.detail,
      basis: basisToValue(lexBasis),
    };
  }

  return {
    kind: "success",
    vars,
    solutions: extract.solutions,
    warnings: [],
    nPairs: drlResult.nPairs,
  };
}
