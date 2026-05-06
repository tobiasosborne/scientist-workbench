// =============================================================================
// dispatch.ts — top-level solve dispatcher (linear / univariate-poly / refusal)
// =============================================================================
//
// Intent
// ------
// Given the classifier's verdict (ClassifyResult), execute the
// appropriate substrate path and return a value-protocol-shaped
// result that `tools/solve` wraps for emission.
//
// The four lanes (matching `classify.ts` plus the catch-all):
//   • linear           — `bareissSolve` over ℚ; map result to ADR-0017
//                        solution-set shape.
//   • univariate-poly  — factor via `factorRatQ`, dispatch each
//                        irreducible factor to the right radical
//                        solver. Multiplicities are preserved; deg ≥ 5
//                        irreducibles trigger refusal.
//   • unsupported      — return refusal info; caller wraps as tagged.
//
// Why the dispatcher lives in a package, not in the tool
// ------------------------------------------------------
// `tools/solve` is the seven-artefact wrapper: schema, examples,
// invariants, fn-glue, `--test` hook. The actual algebra lives here
// and is unit-testable in `bun test` without going through the tool
// surface. Mirrors the discipline of `linsolve-q` (substrate in
// cas-core/linsolve.ts; tool wraps it) and `poly-factor` (substrate
// in poly-factor; tool wraps it).

import {
  type Poly,
  type Rat,
  type LinSolveResult,
  RAT_RING,
  bareissSolve,
  cubicRoots,
  linearRoot,
  makeRat,
  polyDegInVar,
  quadraticRoots,
  quarticRoots,
} from "@workbench/cas-core";
import { factorRatQ } from "@workbench/poly-factor";
import {
  expr,
  int,
  rat as protocolRat,
  sym,
  type Value,
} from "@workbench/protocol";

import type { ClassifyResult } from "./classify.js";

// -----------------------------------------------------------------------------
// Result types
// -----------------------------------------------------------------------------

export interface Solution {
  readonly bindings: readonly { var: string; value: Value }[];
  /** Branch parameter symbols introduced by this solution (empty for finite). */
  readonly branches: readonly string[];
}

export interface SolveSuccess {
  readonly kind: "success";
  readonly vars: readonly string[];
  readonly solutions: readonly Solution[];
  readonly completeness: "complete" | "finite-rep-of-infinite";
  readonly warnings: readonly string[];
}

export interface SolveRefusal {
  readonly kind: "refusal";
  /** Refusal class for ADR-0017's `solve/<class>` taxonomy. */
  readonly reasonClass: string;
  readonly detail: string;
}

export type SolveResult = SolveSuccess | SolveRefusal;

// -----------------------------------------------------------------------------
// dispatchClassified — the main entry point
// -----------------------------------------------------------------------------

/**
 * Execute the dispatch lane indicated by the classifier.
 *
 * @param verdict  Classifier output for the (eqs, vars) pair.
 * @param vars     Variable list, in caller-supplied order. Must match
 *                 the variables the classifier inspected.
 * @returns        `SolveSuccess` or `SolveRefusal`. The caller (`tools/
 *                 solve`) translates these into the value-protocol
 *                 record + tagged shapes per ADR-0017.
 */
export function dispatchClassified(
  verdict: ClassifyResult,
  vars: readonly string[],
): SolveResult {
  switch (verdict.kind) {
    case "linear":      return dispatchLinear(verdict.A, verdict.b, vars);
    case "univariate-poly":
      return dispatchUnivariatePoly(verdict.poly, verdict.varName);
    case "unsupported":
      return {
        kind: "refusal",
        reasonClass: verdict.reasonClass,
        detail: verdict.detail,
      };
  }
}

// -----------------------------------------------------------------------------
// Linear lane
// -----------------------------------------------------------------------------

function dispatchLinear(
  A: Rat[][], b: Rat[], vars: readonly string[],
): SolveResult {
  const lin: LinSolveResult = bareissSolve(A, b);
  switch (lin.kind) {
    case "unique": {
      const bindings = vars.map((v, j) => ({
        var: v,
        value: ratToValue(lin.x[j]!),
      }));
      return {
        kind: "success",
        vars,
        solutions: [{ bindings, branches: [] }],
        completeness: "complete",
        warnings: warningsFromBareiss(lin.maxIntermediateBitLength),
      };
    }
    case "under-determined": {
      // Bareiss returns each x_j as an `Affine` (rational constant + sum
      // of rational multiples of free variables `t_0, t_1, …`).  Convert
      // to expression Values.  Branch parameters live in the
      // 'solve' namespace per ADR-0017 with names `k_1, k_2, …`; for
      // simplicity in v0.1 we keep the upstream `t_k` naming and let
      // a follow-up bead rename to `k_k` if the nomenclature mismatch
      // matters at the bench level.
      const bindings = vars.map((v, j) => ({
        var: v,
        value: affineToValue(lin.x[j]!),
      }));
      return {
        kind: "success",
        vars,
        solutions: [{
          bindings,
          branches: lin.freeVars.slice(),
        }],
        completeness: "finite-rep-of-infinite",
        warnings: warningsFromBareiss(lin.maxIntermediateBitLength),
      };
    }
    case "inconsistent":
      return {
        kind: "success",
        vars,
        solutions: [],
        completeness: "complete",
        warnings: warningsFromBareiss(lin.maxIntermediateBitLength),
      };
  }
}

function warningsFromBareiss(maxBits: number): string[] {
  if (maxBits > 1000) {
    return [`bareiss: max intermediate bit length ${maxBits}`];
  }
  return [];
}

// -----------------------------------------------------------------------------
// Univariate-polynomial lane
// -----------------------------------------------------------------------------

function dispatchUnivariatePoly(
  poly: Poly<Rat>, varName: string,
): SolveResult {
  const fact = factorRatQ(poly, varName);
  const solutions: Solution[] = [];

  for (const fr of fact.factors) {
    const result = rootsOfFactor(fr.factor, varName);
    if (!Array.isArray(result)) {
      return {
        kind: "refusal",
        reasonClass: result.refusal.tag,
        detail: result.refusal.detail,
      };
    }
    // Each root contributes `multiplicity` solutions (a triple root
    // appears 3 times in the solution set per ADR-0017's discrete-
    // finite shape).
    for (const root of result) {
      for (let m = 0; m < fr.multiplicity; m++) {
        solutions.push({
          bindings: [{ var: varName, value: root }],
          branches: [],
        });
      }
    }
  }

  return {
    kind: "success",
    vars: [varName],
    solutions,
    completeness: "complete",
    warnings: [],
  };
}

function rootsOfFactor(
  p: Poly<Rat>, v: string,
): Value[] | { refusal: { tag: string; detail: string } } {
  const coefs = coefsAsRatDescending(p, v);
  const deg = coefs.length - 1;
  switch (deg) {
    case 0: return [];
    case 1: return [linearRoot(coefs[0]!, coefs[1]!)];
    case 2: {
      const [a, b, c] = coefs;
      const [r1, r2] = quadraticRoots(a!, b!, c!);
      return [r1, r2];
    }
    case 3: {
      const [a, b, c, d] = coefs;
      const [r1, r2, r3] = cubicRoots(a!, b!, c!, d!);
      return [r1, r2, r3];
    }
    case 4: {
      const [a, b, c, d, e] = coefs;
      const [r1, r2, r3, r4] = quarticRoots(a!, b!, c!, d!, e!);
      return [r1, r2, r3, r4];
    }
    default:
      return {
        refusal: {
          tag: "high-degree-irreducible",
          detail: `irreducible factor of degree ${deg}; radical solution requires Root[] (poly-roots v0.2)`,
        },
      };
  }
}

function coefsAsRatDescending(p: Poly<Rat>, v: string): Rat[] {
  const d = polyDegInVar(p, v);
  if (d < 0) return [];
  const arr = new Array<Rat>(d + 1).fill(makeRat(0n, 1n));
  for (const t of p.terms) {
    let pv = 0;
    for (const [name, exp] of t.exp) if (name === v) pv = exp;
    arr[pv] = t.coef;
  }
  return arr.reverse();
}

// -----------------------------------------------------------------------------
// Value conversions
// -----------------------------------------------------------------------------

function ratToValue(r: Rat): Value {
  if (r.d === 1n) return int(r.n);
  return protocolRat(r.n, r.d);
}

/**
 * Render an `Affine` value (bareiss's under-determined output) as an
 * expression Value: `c + ∑ k_i · t_i`.
 */
function affineToValue(a: { c: Rat; coeffs: ReadonlyMap<string, Rat> }): Value {
  // Single constant case.
  const entries = Array.from(a.coeffs.entries());
  if (entries.length === 0) return ratToValue(a.c);

  const terms: Value[] = [];
  if (a.c.n !== 0n) terms.push(ratToValue(a.c));
  for (const [name, coef] of entries) {
    if (coef.n === 0n) continue;
    if (coef.d === 1n && coef.n === 1n) {
      terms.push(sym(name));
    } else if (coef.d === 1n && coef.n === -1n) {
      terms.push(expr("neg", [sym(name)]));
    } else {
      terms.push(expr("*", [ratToValue(coef), sym(name)]));
    }
  }

  if (terms.length === 0) return int(0n);
  if (terms.length === 1) return terms[0]!;
  return expr("+", terms);
}

void RAT_RING;     // type-substrate import; not used directly here.
