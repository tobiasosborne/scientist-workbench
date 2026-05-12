// =============================================================================
// classify.ts — classify a (eqs, vars) input into a solve dispatch lane
// =============================================================================
//
// Intent
// ------
// `classifyInput(eqs, vars)` decides which substrate path the
// `tools/solve` dispatcher should take for a given equation list and
// unknown list. The four v0.1 lanes (post-x8d):
//
//   • `linear`              — every equation is linear in `vars`,
//                             dispatches to `bareissSolve` (cas-core)
//                             for an exact ℚ solution.
//   • `univariate-poly`     — single equation, single variable,
//                             polynomial of any positive degree;
//                             dispatches to the radicals/poly-roots
//                             pipeline for deg ≤ 4 and to the
//                             `Root[poly, k]` substrate (ADR-0018,
//                             via `@workbench/alg-num`) for
//                             irreducible deg ≥ 5 factors with all
//                             real roots; refuses with
//                             `solve/complex-roots-not-yet-named`
//                             when an irreducible deg-≥5 factor has
//                             complex roots (alg-num v0.1 limit).
//   • `multivariate-poly`   — multiple equations or multiple
//                             variables with at least one nonlinear
//                             monomial. Dispatches to
//                             `solveGroebner` from
//                             `@workbench/groebner` (Buchberger +
//                             FGLM + shape lemma; ADR-0029, bead
//                             scientist-workbench-x8d). Zero-
//                             dimensional ideals produce a finite
//                             solution set; positive-dim refuses with
//                             `solve/multivariate-non-zero-dim`;
//                             non-shape lex GB refuses with
//                             `solve/shape-lemma-failure`; complex
//                             algebraic roots refuse with
//                             `solve/complex-roots-not-yet-named`.
//   • `unsupported`         — transcendental, parametric, or
//                             out-of-vocabulary input. Carries a
//                             refusal class string per ADR-0017's
//                             roster.
//
// Why a separate classifier
// -------------------------
// Bead `scientist-workbench-77b` calls this out as the `packages/solve`
// architecture's first move: a planner (the dispatcher) reads the
// classifier's verdict and proceeds. Decoupling classification from
// dispatch means: (a) the test surface is simpler — classifier
// invariants are checked independently, (b) future lanes (Gröbner,
// transcendental invert-and-substitute) plug in by adding a case to
// the verdict union, not by editing dispatch flow control.
//
// Inputs are pre-canonical: each equation is a `Poly<Rat>` over the
// closed `+ − * / ^` vocabulary that `valueToRatFn` accepts. The
// caller (`tools/solve`) handles the expression → Poly conversion and
// the `lhs == rhs ⟹ lhs - rhs` reduction up front.

import {
  type Poly,
  type Rat,
  RAT_RING,
  polyConst,
  polyDegInVar,
  polyVars,
  ratIsZero,
  polyCoeffsInVar,
} from "@workbench/cas-core";

export type ClassifiedLinear = {
  readonly kind: "linear";
  /**
   * `m × n` coefficient matrix in row-major form. `A[i][j]` is the
   * coefficient of `vars[j]` in equation `i`. Entries are `Rat`.
   */
  readonly A: Rat[][];
  /**
   * Right-hand-side vector of length `m`: `b[i] = − (constant term of eq[i])`.
   * The system is `A · x = b`.
   */
  readonly b: Rat[];
};

export type ClassifiedUnivariatePoly = {
  readonly kind: "univariate-poly";
  /** The polynomial in the requested variable. */
  readonly poly: Poly<Rat>;
  /** The single requested variable's name. */
  readonly varName: string;
};

export type ClassifiedMultivariatePoly = {
  readonly kind: "multivariate-poly";
  /** The polynomial equations interpreted as eq_i = 0. */
  readonly polys: readonly Poly<Rat>[];
  /** The variable list. */
  readonly vars: readonly string[];
};

export type ClassifiedUnsupported = {
  readonly kind: "unsupported";
  /**
   * Refusal class string from ADR-0017's roster. Examples:
   * "multivariate-non-zero-dim", "parametric-non-trivial",
   * "foreign-vocabulary", "transcendental-multibranch".
   */
  readonly reasonClass: string;
  /** Human-readable detail for the boundary tag's payload. */
  readonly detail: string;
};

export type ClassifyResult =
  | ClassifiedLinear
  | ClassifiedUnivariatePoly
  | ClassifiedMultivariatePoly
  | ClassifiedUnsupported;

/**
 * Classify a list of polynomial equations in a list of variables.
 *
 * @param eqs   List of `Poly<Rat>` equations interpreted as `eq_i = 0`.
 * @param vars  The unknowns being solved for, in caller-supplied order.
 *
 * @returns  A `ClassifyResult` indicating the dispatch lane.
 */
export function classifyInput(
  eqs: readonly Poly<Rat>[],
  vars: readonly string[],
): ClassifyResult {
  if (eqs.length === 0) {
    return {
      kind: "unsupported",
      reasonClass: "empty-input",
      detail: "no equations to solve",
    };
  }
  if (vars.length === 0) {
    return {
      kind: "unsupported",
      reasonClass: "empty-vars",
      detail: "no variables to solve for",
    };
  }

  // Reject any equation that mentions a symbol outside `vars`. (A
  // free symbol becomes a parameter; v0.1 refuses parametric inputs
  // honestly via "parametric-non-trivial" rather than guessing.)
  const varSet = new Set(vars);
  for (let i = 0; i < eqs.length; i++) {
    const mentioned = polyVars(eqs[i]!);
    for (const u of mentioned) {
      if (!varSet.has(u)) {
        return {
          kind: "unsupported",
          reasonClass: "parametric-non-trivial",
          detail: `equation #${i + 1} mentions symbol '${u}' which is not in the unknown list`,
        };
      }
    }
  }

  // Check linearity: every equation has degree ≤ 1 in every variable AND
  // total degree ≤ 1 (i.e., no `x · y` terms). The total-degree check
  // is the load-bearing one — `x · y` has degree 1 in x AND degree 1
  // in y but the equation is bilinear, not linear.
  const isLinear = eqs.every((eq) => isLinearInVars(eq, vars));

  // Single-equation single-variable polynomial — the univariate lane.
  if (eqs.length === 1 && vars.length === 1) {
    const eq = eqs[0]!;
    const v = vars[0]!;
    const deg = polyDegInVar(eq, v);
    if (deg < 1) {
      // Constant equation. f = c with c ≠ 0 ⟹ no solution. f = 0
      // ⟹ every value of v is a solution (parametric). The dispatcher
      // handles both via the empty-or-refusal lane.
      return {
        kind: "unsupported",
        reasonClass: "constant-equation",
        detail: "the equation has no `vars[0]` term; either no solution (constant ≠ 0) or every value (constant = 0)",
      };
    }
    return { kind: "univariate-poly", poly: eq, varName: v };
  }

  if (isLinear) {
    // Build the (A, b) matrix.
    const A: Rat[][] = [];
    const b: Rat[] = [];
    for (const eq of eqs) {
      const { coefRow, constant } = extractLinearCoefs(eq, vars);
      A.push(coefRow);
      // Move the constant term to the RHS: eq_i = 0 ⟹ A_i · x = -constant.
      b.push({ n: -constant.n, d: constant.d });
    }
    return { kind: "linear", A, b };
  }

  // If we land here: multivariate / nonlinear polynomial system.
  // After x8d (ADR-0029), this routes to the Gröbner lane —
  // `dispatchClassified` then calls `solveGroebner` from
  // `@workbench/groebner`. Whether the system has a finite solution
  // set is decided by the zero-dim test inside `solveGroebner`; the
  // classifier's job is only to identify the lane. Cases that the
  // groebner stack itself can't handle (positive-dim, shape failure,
  // complex roots) surface their refusals from the dispatcher.
  return { kind: "multivariate-poly", polys: eqs, vars };
}

// -----------------------------------------------------------------------------
// helpers
// -----------------------------------------------------------------------------

/**
 * True iff `eq` is linear in `vars`: every monomial has total degree
 * ≤ 1 over the variables in `vars`. (Constant terms are degree 0 and
 * count as linear; degree-1 monomials are the active linear part.)
 *
 * Cross-variable products like `x · y` are *not* linear even though
 * they have degree 1 in `x` and degree 1 in `y` separately.
 */
function isLinearInVars(eq: Poly<Rat>, vars: readonly string[]): boolean {
  const varSet = new Set(vars);
  for (const t of eq.terms) {
    let totalDegInVars = 0;
    for (const [name, exp] of t.exp) {
      if (varSet.has(name)) totalDegInVars += exp;
    }
    if (totalDegInVars > 1) return false;
  }
  return true;
}

/**
 * Given a linear-in-vars polynomial `eq`, extract the row of
 * coefficients (one per variable in `vars`) and the constant term.
 *
 * The row is indexed in the order of `vars`. Variables not appearing
 * in `eq` get coefficient 0.
 */
function extractLinearCoefs(
  eq: Poly<Rat>,
  vars: readonly string[],
): { coefRow: Rat[]; constant: Rat } {
  const coefRow = vars.map(() => ({ n: 0n, d: 1n } as Rat));
  let constant: Rat = { n: 0n, d: 1n };
  const varIndex: Map<string, number> = new Map();
  vars.forEach((v, i) => varIndex.set(v, i));

  for (const t of eq.terms) {
    let activeVar: string | null = null;
    for (const [name, exp] of t.exp) {
      if (exp > 0 && varIndex.has(name)) {
        activeVar = name;
        break;     // total-degree-1 in vars guarantees at most one
      }
    }
    if (activeVar === null) {
      // Constant term in the linear sense (no var with degree > 0).
      // The exponent map has only non-var entries which are zero in
      // total in our setting (we already filtered foreign vars).
      // Add the coefficient to `constant`.
      constant = ratAdd(constant, t.coef);
    } else {
      const idx = varIndex.get(activeVar)!;
      coefRow[idx] = ratAdd(coefRow[idx]!, t.coef);
    }
  }

  return { coefRow, constant };
}

function ratAdd(a: Rat, b: Rat): Rat {
  // Use the fully-qualified ratAdd from cas-core through index-time
  // import; here we replicate the operation locally to keep this
  // module self-contained and avoid the cas-core re-export
  // ceremony for what's a 3-line operation.
  // a + b = (a.n · b.d + b.n · a.d) / (a.d · b.d), then normalise
  // by gcd.
  const n = a.n * b.d + b.n * a.d;
  const d = a.d * b.d;
  return reduceRat(n, d);
}

function reduceRat(n: bigint, d: bigint): Rat {
  if (d === 0n) throw new Error("ratAdd: zero denominator");
  if (n === 0n) return { n: 0n, d: 1n };
  let nn = n, dd = d;
  if (dd < 0n) { nn = -nn; dd = -dd; }
  const g = gcdAbs(nn, dd);
  return { n: nn / g, d: dd / g };
}

function gcdAbs(a: bigint, b: bigint): bigint {
  let aa = a < 0n ? -a : a;
  let bb = b < 0n ? -b : b;
  while (bb !== 0n) { const t = aa % bb; aa = bb; bb = t; }
  return aa;
}

void RAT_RING;        // referenced as type substrate; kept for clarity.
void polyConst;
void ratIsZero;
void polyCoeffsInVar;
