// =============================================================================
// newton-iteration.ts — Jacobian construction (analytic + FD) for Radau
// =============================================================================
//
// Intent
// ------
// The Radau-IIA(5) simplified-Newton iteration in `radau.ts` consumes a
// Jacobian `J ≈ ∂f/∂y(t, y)` evaluated at the step start. This file is
// the substrate for *building* that Jacobian on demand:
//
//   1. **Analytic-from-cas-diff** — when the user provides a list-of-list
//      of expression Values (one per `∂f_i/∂y_j` entry), we lambdify each
//      expression once and evaluate them numerically into a Float64Array
//      on every Jacobian update. The *evaluation* is the inner-loop
//      cost; the *lambdification* (parse the expression once) is paid
//      once per integration.
//
//   2. **Finite-difference fallback** — when no analytic Jacobian is
//      available and `cas-diff` either refuses some component (out-of-
//      vocabulary) or wasn't requested, we approximate `J` via centred
//      differences with a per-component step `h = sqrt(EPS) · max(|y_j|,
//      1)`. Cost: `2n` extra `f` evaluations per Jacobian update.
//      The forward-difference variant SciPy ships (`num_jac` in
//      `scipy/integrate/_ivp/common.py`) is more economical (one f-eval
//      per column instead of two) but centred differences give roughly
//      one extra correct digit and the doubling is benign on the bench
//      cases.
//
// The output is a flat row-major `Float64Array` of length `n²` — same
// memory layout that `lu` / `luSolve` from `@workbench/linalg-core`
// expect. Keeping the substrate `Float64Array`-shaped means the
// Jacobian flows directly into the LU factorisation without a copy.
//
// Caching discipline
// ------------------
// The driver in `integrate-stiff.ts` decides *when* to recompute the
// Jacobian (the staleness logic uses Newton convergence rate). This
// file is a stateless library; each call recomputes from scratch. The
// driver caches the result and reuses it across multiple steps until
// the staleness signal fires.
//
// Failure modes
// -------------
// `evaluateAnalyticJacobian` and `evaluateFiniteDifferenceJacobian`
// both throw `OdeNonFiniteError` if any computed entry is NaN/Inf —
// the driver catches and translates to the `non-finite-during-eval`
// boundary tag. The `evalNumericExpr` path will also throw
// `UnknownVocabularyError` when the analytic Jacobian's expressions
// reference an out-of-vocabulary head; the tool layer translates this
// to a `ToolError`.

import type { Value } from "@workbench/protocol";
import { evalNumericExpr } from "@workbench/quadrature";
import { OdeNonFiniteError } from "./integrate.js";

/** Step for centred finite differences. SciPy uses cube-root-EPS for
 *  centred and sqrt-EPS for forward; we use sqrt-EPS scaled by per-
 *  component magnitude — the standard recipe (Higham, *Accuracy and
 *  Stability* §3.5.4 eq. 3.74). */
const FD_STEP_BASE = Math.sqrt(Number.EPSILON);

/**
 * Lambdify a list-of-list of expression Values into a JS function
 * `(t, y, Jout)` that writes the row-major Jacobian into the caller's
 * buffer.
 *
 *   `jacExprs`   — `n × n` expression matrix; `jacExprs[i][j] = ∂f_i/∂y_j`.
 *   `vars`       — n state-variable names (must match the integrator's).
 *   `tVar`       — independent-variable name.
 *
 * Closes over a single `Map<string, number>` reused across calls (same
 * shape as `eval-rhs.ts`'s `buildRhs`).
 */
export function buildAnalyticJacobian(
  jacExprs: ReadonlyArray<ReadonlyArray<Value>>,
  vars: readonly string[],
  tVar: string,
): (t: number, y: Float64Array, Jout: Float64Array) => void {
  const n = vars.length;
  const env = new Map<string, number>();
  env.set(tVar, 0);
  for (const v of vars) env.set(v, 0);

  return (t: number, y: Float64Array, Jout: Float64Array): void => {
    env.set(tVar, t);
    for (let i = 0; i < n; i++) env.set(vars[i]!, y[i]!);
    for (let i = 0; i < n; i++) {
      const row = jacExprs[i]!;
      for (let j = 0; j < n; j++) {
        const v = evalNumericExpr(row[j]!, env);
        if (!Number.isFinite(v)) {
          const kind: "NaN" | "Infinity" | "-Infinity" =
            Number.isNaN(v) ? "NaN" : v > 0 ? "Infinity" : "-Infinity";
          throw new OdeNonFiniteError(t, new Float64Array(y), kind);
        }
        Jout[i * n + j] = v;
      }
    }
  };
}

/**
 * Build a finite-difference Jacobian evaluator. Closes over caller-
 * owned scratch buffers (allocated once). On each call, performs `2n`
 * RHS evaluations to estimate `∂f/∂y` at `(t, y)` via centred
 * differences:
 *
 *   J[i, j] ≈ (f_i(t, y + h_j e_j) − f_i(t, y − h_j e_j)) / (2 h_j)
 *
 * with `h_j = sqrt(EPS) · max(|y_j|, 1)` chosen per component to
 * balance roundoff and truncation errors (Higham §3.5).
 */
export function buildFiniteDifferenceJacobian(
  rhs: (t: number, y: Float64Array, out: Float64Array) => void,
  n: number,
): (t: number, y: Float64Array, Jout: Float64Array, fEvalCount?: { value: number }) => void {
  const yPlus = new Float64Array(n);
  const yMinus = new Float64Array(n);
  const fPlus = new Float64Array(n);
  const fMinus = new Float64Array(n);

  return (t: number, y: Float64Array, Jout: Float64Array, fEvalCount?: { value: number }): void => {
    for (let j = 0; j < n; j++) {
      const yj = y[j]!;
      const hj = FD_STEP_BASE * Math.max(Math.abs(yj), 1);
      // y + h_j e_j
      for (let i = 0; i < n; i++) yPlus[i] = y[i]!;
      yPlus[j] = yj + hj;
      rhs(t, yPlus, fPlus);
      // y - h_j e_j
      for (let i = 0; i < n; i++) yMinus[i] = y[i]!;
      yMinus[j] = yj - hj;
      rhs(t, yMinus, fMinus);
      if (fEvalCount !== undefined) fEvalCount.value += 2;
      // Column j of J = (fPlus − fMinus) / (2 h_j)
      const inv2hj = 1 / (2 * hj);
      for (let i = 0; i < n; i++) {
        const v = (fPlus[i]! - fMinus[i]!) * inv2hj;
        if (!Number.isFinite(v)) {
          const kind: "NaN" | "Infinity" | "-Infinity" =
            Number.isNaN(v) ? "NaN" : v > 0 ? "Infinity" : "-Infinity";
          throw new OdeNonFiniteError(t, new Float64Array(y), kind);
        }
        Jout[i * n + j] = v;
      }
    }
  };
}

/**
 * Try to derive the analytic Jacobian symbolically by walking the
 * vector RHS expressions and applying `cas-diff` (in-process, no
 * subprocess) component-by-component.
 *
 * Returns `null` iff *any* `∂f_i/∂y_j` returns out-of-scope from
 * cas-diff — in that case the driver falls back to FD and emits a
 * warning. We refuse the *whole* Jacobian on any out-of-scope
 * component (rather than mixing analytic + FD) because the per-
 * component derivative cost is dominated by a single full-row pass
 * anyway, and a partial-analytic Jacobian risks an inconsistency
 * between the user's notion of `∂f/∂y` and the driver's mixed view.
 *
 * `cas-diff`'s `differentiate` returns the smart-constructor-reduced
 * expression; we accept whatever it gives us.
 *
 * NB: the import is *intentional* — `cas-diff` is a workspace package,
 * but the substrate package sits below it. To avoid a dependency cycle
 * we accept a callback `differentiate` that the tool layer wires up
 * with the actual cas-core symbol. (Tool layer imports `@workbench/
 * cas-core` and passes its `differentiate` here.)
 */
export function deriveSymbolicJacobian(
  fExprs: readonly Value[],
  vars: readonly string[],
  differentiate: (f: Value, varSym: { kind: "symbol"; name: string }) => Value,
  isOutOfScope: (e: unknown) => boolean,
): Value[][] | null {
  const n = vars.length;
  const J: Value[][] = new Array<Value[]>(n);
  for (let i = 0; i < n; i++) {
    const row: Value[] = new Array<Value>(n);
    for (let j = 0; j < n; j++) {
      try {
        row[j] = differentiate(fExprs[i]!, { kind: "symbol", name: vars[j]! });
      } catch (e) {
        if (isOutOfScope(e)) return null;
        throw e;
      }
    }
    J[i] = row;
  }
  return J;
}
