// =============================================================================
// shape-extract — solution extraction from a lex GB via the shape lemma
// =============================================================================
//
// The shape lemma — a refresher
// -----------------------------
// Becker-Mora-Marinari-Traverso 1994 §2: a zero-dimensional ideal
// `I ⊆ ℚ[x_1, …, x_n]` is in *shape position* (with respect to lex
// order `x_1 > x_2 > … > x_n`) iff its reduced lex GB has the form
//
//     g_n(x_n)        = 0
//     x_{n-1} − h_{n-1}(x_n) = 0
//     …
//     x_1 − h_1(x_n)        = 0
//
// where `g_n ∈ ℚ[x_n]` is univariate of degree `D = dim_ℚ(ℚ[x]/I)`
// and each `h_i ∈ ℚ[x_n]` is univariate of degree < D. Solutions are
// then `(h_1(r), h_2(r), …, h_{n-1}(r), r)` for each root `r` of
// `g_n`.
//
// Our extraction recipe
// ---------------------
// 1. Verify the lex basis is in shape position. If not, refuse with
//    `solve/shape-lemma-failure` per Q2 of the research note (no
//    fixed-shift retry — we choose option 1, the honest refusal).
//
// 2. Identify `g_n(x_n)` and the per-variable `h_i(x_n)` by
//    inspecting each lex GB element. Concretely:
//      - The element whose LM is `x_n^d` (a pure power of the last
//        variable) is `g_n`.
//      - Each other element has LM `x_i` (degree 1, single variable
//        from `vars[0..n-2]`); its tail in `x_n` alone is the
//        polynomial `h_i(x_n)` such that the binding is
//        `x_i = h_i(x_n)`.
//
// 3. Find the rational and algebraic roots of `g_n` by factoring
//    over ℚ (`factorRatQ` from `@workbench/poly-factor`) and
//    dispatching each irreducible factor by degree:
//      - deg 1 → linear formula → ℚ root (rational binding values).
//      - deg 2 → `quadraticRoots` → radical-form value.
//      - deg 3 → `cubicRoots` → radical-form value.
//      - deg 4 → `quarticRoots` → radical-form value.
//      - deg ≥ 5 → `Root[poly, k]` for each *real* root via the
//        univariate-poly-lane recipe (alg-num); refuse with
//        `solve/complex-roots-not-yet-named` for any complex roots.
//
// 4. For each root `r` of `g_n`, evaluate each `h_i(r)` in exact
//    arithmetic and emit a `Solution { bindings, branches }` per
//    ADR-0017.
//
// Substitution is exact — `r` may be a `Rat` (rational root), a
// radical expression Value (deg 2-4), or a `Root[poly, k]` Value
// (deg ≥ 5 real). We perform the polynomial evaluation symbolically:
// for each h_i, build the expression `coef_d · x_n^d + coef_{d-1} ·
// x_n^{d-1} + … + coef_0`, then substitute `x_n ↦ r` by replacing
// each `sym(x_n)` leaf with the root Value. The resulting expression
// is the binding for `x_i`. The result is canonical iff `r` is a
// rational; for radical / `Root[]` roots the substituted expression
// is correct *up to ratFn-level simplification*. CAS-simplify lifting
// is a downstream concern; the bench's verifier checks substitution-
// satisfies-equation, not byte-equality.
//
// References
// ----------
// - Becker-Mora-Marinari-Traverso 1994 — shape lemma + 1-thick
//   characterisation.
// - ADR-0017 — `Solution { bindings, branches }` output protocol.
// - ADR-0018 — `Root[poly, k]` for algebraic numbers ≥ 5.

import {
  type Poly,
  type Rat,
  RAT_RING,
  cubicRoots,
  linearRoot,
  makeRat,
  polyConst,
  polyDegInVar,
  polyIsZero,
  quadraticRoots,
  quarticRoots,
  ratIsZero,
} from "@workbench/cas-core";
import { factorRatQ } from "@workbench/poly-factor";
import {
  ROOT_VAR,
  canonicalIntegerForm,
  polyToHighToLowRat,
  rootToValue,
} from "@workbench/alg-num";
import { isolateRealRoots } from "@workbench/real-roots";
import {
  expr,
  int,
  rat as protocolRat,
  sym,
  type Value,
} from "@workbench/protocol";

import {
  type MonomialOrder,
  expGet,
  lexOrder,
} from "./monomial-order.js";
import { leadingTerm } from "./multidiv.js";

// -----------------------------------------------------------------------------
// Shape-position detection
// -----------------------------------------------------------------------------

interface ShapeBasis {
  /** The univariate polynomial g_n(x_n). */
  readonly gN: Poly<Rat>;
  /**
   * Per-variable `h_i(x_n)` polynomials. `h.get(varName)` returns the
   * polynomial in `x_n` such that the binding is `varName = h(x_n)`.
   * Keys are `vars[0]`, `vars[1]`, …, `vars[n-2]`. The last variable
   * `vars[n-1]` (= x_n) has no entry; its binding comes from the
   * roots of g_n directly.
   */
  readonly h: ReadonlyMap<string, Poly<Rat>>;
  /** The last variable, `x_n` in the standard formulation. */
  readonly xN: string;
}

/**
 * Detect whether `gLex` is in shape position with respect to `vars`
 * under lex (with `vars[0]` highest). Returns the structured
 * `ShapeBasis` on success, or `null` if shape position fails.
 *
 * The detection rules:
 *   - Exactly `n` polynomials in the basis, where `n = vars.length`.
 *   - One polynomial has LM `x_n^d` for some d ≥ 1 (a pure power of
 *     the *last* variable). This is `g_n`.
 *   - Each of the other n-1 polynomials has LM `x_i` (a degree-1
 *     single-variable monomial) for a unique i ∈ [0, n-1), and its
 *     tail involves only `x_n`.
 *
 * Per Q2 of the research note: shape failure ⇒ refuse, no retry.
 */
export function detectShapePosition(
  gLex: readonly Poly<Rat>[],
  vars: readonly string[],
  lex: MonomialOrder,
): ShapeBasis | null {
  if (vars.length === 0) return null;
  const xN = vars[vars.length - 1]!;

  if (gLex.length !== vars.length) return null;

  // Identify g_n: the unique element whose LM is a pure power of x_n.
  let gN: Poly<Rat> | null = null;
  const ltMap = new Map<string, Poly<Rat>>(); // varName (LM = x_i^1) → polynomial
  for (const p of gLex) {
    const lt = leadingTerm(p, lex);
    if (lt === null) return null;
    // Pure power of x_n?
    if (lt.exp.length === 1 && lt.exp[0]![0] === xN) {
      if (gN !== null) return null; // two pure-x_n elements ⇒ not shape
      gN = p;
      continue;
    }
    // Single-variable degree-1 LM?
    if (lt.exp.length === 1 && lt.exp[0]![1] === 1) {
      const v = lt.exp[0]![0];
      if (v === xN) return null; // x_n^1 alone wouldn't be shape's g_n
      if (ltMap.has(v)) return null;
      ltMap.set(v, p);
      continue;
    }
    // Anything else (multi-variable LM, degree-≥2 in non-xN variable)
    // means we're not in shape position.
    return null;
  }
  if (gN === null) return null;

  // Each other variable in vars[0..n-2] must appear as an LM in the
  // map.
  const h = new Map<string, Poly<Rat>>();
  for (let i = 0; i < vars.length - 1; i++) {
    const v = vars[i]!;
    const elem = ltMap.get(v);
    if (elem === undefined) return null;
    // h_i(x_n) := -(elem - LT(elem)) — i.e., move the leading x_i to
    // the LHS and multiply through. elem = x_i + tail(x_n) ⇒
    // x_i = -tail(x_n).
    const tailPoly: Poly<Rat> = {
      terms: elem.terms.filter((t) => !(t.exp.length === 1 && t.exp[0]![0] === v && t.exp[0]![1] === 1)),
    };
    // Verify tail is in x_n only.
    for (const t of tailPoly.terms) {
      for (const [name] of t.exp) {
        if (name !== xN) {
          // Foreign variable in tail ⇒ not shape position.
          return null;
        }
      }
    }
    // h_i(x_n) = -tail.
    const minusTail: Poly<Rat> = {
      terms: tailPoly.terms.map((t) => ({
        exp: t.exp,
        coef: { n: -t.coef.n, d: t.coef.d } as Rat,
      })),
    };
    h.set(v, minusTail);
  }

  return { gN, h, xN };
}

// -----------------------------------------------------------------------------
// Roots of g_n via the univariate dispatch pipeline
// -----------------------------------------------------------------------------

/**
 * One root of `g_n` produced by the univariate dispatch. The Value
 * is whatever shape ADR-0017 + ADR-0018 dictate — Rat for ≤ deg 1,
 * radical Value for deg 2-4, `Root[poly, k]` for deg ≥ 5 real roots.
 */
type RootOfGn =
  | { kind: "value"; value: Value }
  | { kind: "refusal"; tag: string; detail: string };

function rootsOfGn(g: Poly<Rat>, v: string): RootOfGn[] | { refusal: { tag: string; detail: string } } {
  if (polyIsZero(g) || polyDegInVar(g, v) <= 0) {
    // Constant g_n ≠ 0 means inconsistent (no roots); g_n = 0 means
    // every value satisfies (positive-dim, but caller should have
    // tested that). Both are caller-violations.
    return { refusal: { tag: "shape-lemma-failure", detail: "g_n is constant" } };
  }
  const fact = factorRatQ(g, v);
  const out: RootOfGn[] = [];
  for (const fr of fact.factors) {
    const deg = polyDegInVar(fr.factor, v);
    if (deg <= 0) continue;
    const coefs = coefsAsRatDescending(fr.factor, v);
    let factorRoots: Value[] | { refusal: { tag: string; detail: string } };
    if (deg === 1) {
      factorRoots = [linearRoot(coefs[0]!, coefs[1]!)];
    } else if (deg === 2) {
      const [a, b, c] = coefs;
      const [r1, r2] = quadraticRoots(a!, b!, c!);
      factorRoots = [r1, r2];
    } else if (deg === 3) {
      const [a, b, c, d] = coefs;
      const [r1, r2, r3] = cubicRoots(a!, b!, c!, d!);
      factorRoots = [r1, r2, r3];
    } else if (deg === 4) {
      const [a, b, c, d, e] = coefs;
      const [r1, r2, r3, r4] = quarticRoots(a!, b!, c!, d!, e!);
      factorRoots = [r1, r2, r3, r4];
    } else {
      // deg ≥ 5: name each real root by Root[poly, k] (ADR-0018).
      const minpoly = canonicalIntegerForm(fr.factor, v);
      const intervals = isolateRealRoots(polyToHighToLowRat(minpoly, ROOT_VAR));
      if (intervals.length < deg) {
        return {
          refusal: {
            tag: "complex-roots-not-yet-named",
            detail:
              `irreducible factor of degree ${deg} of g_n has `
              + `${deg - intervals.length} complex root(s); alg-num v0.1 names `
              + `real algebraic numbers only.`,
          },
        };
      }
      factorRoots = intervals.map((iv, k) =>
        rootToValue({
          minpoly,
          k,
          interval: { lo: iv.lo, hi: iv.hi },
        }),
      );
    }
    if (Array.isArray(factorRoots)) {
      // Multiplicity ⇒ repeat each root `mult` times (ADR-0017's
      // discrete-finite shape per the univariate convention).
      for (const root of factorRoots) {
        for (let m = 0; m < fr.multiplicity; m++) {
          out.push({ kind: "value", value: root });
        }
      }
    }
  }
  return out;
}

/**
 * Coefficients of `p` in v from low to high — note: the cas-core
 * `polyDivRemMonic` and the radical solvers expect descending order
 * (`[a_d, a_{d-1}, …, a_0]`), which is what this function returns.
 */
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
// Polynomial evaluation under variable substitution
// -----------------------------------------------------------------------------

/**
 * Evaluate `h(x_n)` at the value `r` and return the result as an
 * expression Value. The polynomial is treated as a univariate in
 * `xN`: `h = c_d · x_n^d + c_{d-1} · x_n^{d-1} + … + c_0`. Substitute
 * `x_n ↦ r` and emit the resulting expression.
 *
 * For rational roots, emit a closed-form rational. For radical /
 * `Root[]` roots, emit an expression with the root substituted in.
 */
function evalPolyAtValue(
  h: Poly<Rat>,
  xN: string,
  r: Value,
): Value {
  if (polyIsZero(h)) return int(0n);

  // Special case: r is a rational. Then evaluation reduces to
  // building a rational result and we don't need to materialise an
  // expression tree.
  if (r.kind === "integer" || r.kind === "rational") {
    const rNum = r.kind === "integer" ? BigInt(r.value) : BigInt(r.num);
    const rDen = r.kind === "integer" ? 1n : BigInt(r.den);
    let acc: Rat = makeRat(0n, 1n);
    // Evaluate via Horner on the descending-coef list.
    const coefs = coefsAsRatDescending(h, xN); // [c_d, …, c_0]
    for (let i = 0; i < coefs.length; i++) {
      // acc := acc * r + coefs[i]
      const prodNum = acc.n * rNum;
      const prodDen = acc.d * rDen;
      acc = makeRat(prodNum, prodDen);
      acc = makeRat(acc.n * coefs[i]!.d + coefs[i]!.n * acc.d, acc.d * coefs[i]!.d);
    }
    return ratToValue(acc);
  }

  // r is a non-rational expression Value. Build the polynomial
  // expression using `r` as the substitute for `x_n`, then return.
  // Use Horner: evaluate as ((c_d · r + c_{d-1}) · r + c_{d-2}) · r + …
  const coefs = coefsAsRatDescending(h, xN);
  if (coefs.length === 0) return int(0n);
  let acc: Value = ratToValue(coefs[0]!);
  for (let i = 1; i < coefs.length; i++) {
    // acc := acc * r + coef
    acc = expr("+", [expr("*", [acc, r]), ratToValue(coefs[i]!)]);
  }
  return acc;
}

function ratToValue(r: Rat): Value {
  if (r.d === 1n) return int(r.n);
  return protocolRat(r.n, r.d);
}

// -----------------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------------

export interface ExtractedSolutionSet {
  readonly kind: "success";
  readonly solutions: readonly {
    readonly bindings: readonly { var: string; value: Value }[];
  }[];
}

export interface ExtractRefusal {
  readonly kind: "refusal";
  readonly reasonClass: string; // unprefixed class string, e.g. "shape-lemma-failure"
  readonly detail: string;
}

export type ExtractResult = ExtractedSolutionSet | ExtractRefusal;

/**
 * Attempt to extract a finite solution set from the lex GB `gLex` of
 * a zero-dimensional ideal. Returns the solution set on success or a
 * refusal with class `shape-lemma-failure` / `complex-roots-not-yet-
 * named` on the documented boundary cases.
 *
 * Pre-condition: caller has verified that the ideal is zero-
 * dimensional (via `isZeroDimensional` on the DRL basis); this
 * function does not re-test.
 */
export function extractShapeSolutions(
  gLex: readonly Poly<Rat>[],
  vars: readonly string[],
): ExtractResult {
  if (vars.length === 0) {
    return { kind: "success", solutions: [] };
  }
  // Special case: empty lex basis ⇒ ideal is the zero ideal ⇒ every
  // assignment is a solution (positive-dim, caller should have
  // refused). Defensive return.
  if (gLex.length === 0) {
    return {
      kind: "refusal",
      reasonClass: "shape-lemma-failure",
      detail: "empty lex basis (ideal is the zero ideal — caller should have flagged positive-dim)",
    };
  }
  // Special case: gLex = [1] ⇒ inconsistent system.
  if (gLex.length === 1) {
    const lt = leadingTerm(gLex[0]!, lexOrder(vars));
    if (lt && lt.exp.length === 0) {
      // Constant 1 — no solutions.
      return { kind: "success", solutions: [] };
    }
  }

  const lex = lexOrder(vars);
  const shape = detectShapePosition(gLex, vars, lex);
  if (shape === null) {
    return {
      kind: "refusal",
      reasonClass: "shape-lemma-failure",
      detail: "lex GB is not in shape position; per Q2 v0.1 refuses without retry",
    };
  }

  // Find the roots of g_n.
  const rootsOrRefusal = rootsOfGn(shape.gN, shape.xN);
  if (!Array.isArray(rootsOrRefusal)) {
    return {
      kind: "refusal",
      reasonClass: rootsOrRefusal.refusal.tag,
      detail: rootsOrRefusal.refusal.detail,
    };
  }

  // For each root `r` of g_n, build the per-variable bindings.
  const solutions: { bindings: { var: string; value: Value }[] }[] = [];
  for (const root of rootsOrRefusal) {
    if (root.kind !== "value") {
      return {
        kind: "refusal",
        reasonClass: root.tag,
        detail: root.detail,
      };
    }
    const bindings: { var: string; value: Value }[] = [];
    for (let i = 0; i < vars.length; i++) {
      const v = vars[i]!;
      if (v === shape.xN) {
        bindings.push({ var: v, value: root.value });
      } else {
        const h = shape.h.get(v);
        if (h === undefined) {
          return {
            kind: "refusal",
            reasonClass: "shape-lemma-failure",
            detail: `internal: variable '${v}' has no h_i(x_n) polynomial after detectShapePosition succeeded`,
          };
        }
        const value = evalPolyAtValue(h, shape.xN, root.value);
        bindings.push({ var: v, value });
      }
    }
    solutions.push({ bindings });
  }
  return { kind: "success", solutions };
}

// silence unused-imports.
void polyConst;
void RAT_RING;
void ratIsZero;
void expGet;
void sym;
