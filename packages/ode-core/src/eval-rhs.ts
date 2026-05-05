// =============================================================================
// eval-rhs.ts — vector-RHS adapter over the closed expression vocabulary
// =============================================================================
//
// Intent
// ------
// A thin adapter around `evalNumericExpr` from `@workbench/quadrature`
// that turns a list of expression `Value`s plus a state-variable
// vocabulary into a JS function `(t, y, out) => void`.
//
// We do *not* re-derive the closed vocabulary here. The vocabulary is
// settled (`@workbench/quadrature::ADMITTED_HEADS`); we lean on the
// shared evaluator for both the head check and the numerical
// semantics. That keeps `cas-diff` / `integrate-1d` /
// `optimize-lbfgs-projected` / `integrate-ode-ivp` byte-aligned on
// what counts as an admissible expression.
//
// The wrapper allocates one `Map<string, number>` per `buildRhs` call
// and reuses it across every invocation of the returned `f`. A
// fresh-Map-per-call shape would dominate the per-step cost of an
// adaptive driver that takes 10⁴-10⁶ steps on a hard problem.
//
// Non-finite values
// -----------------
// `evalNumericExpr` returns IEEE-754 results faithfully — including
// NaN / ±Inf at poles and out-of-domain inputs. The driver in
// `integrate.ts` is responsible for catching the first non-finite
// component and translating that into an `OdeNonFiniteError` (which
// the tool layer then re-raises as a `tagged "integrate-ode-ivp/non-
// finite-during-eval"` boundary value, ADR-0003).
//
// We deliberately do *not* throw from the adapter on non-finite
// outputs: the PI controller's initial-step heuristic invokes `f`
// before the integration loop opens, and a thrown error from the
// initial probe would produce a different code path than a thrown
// error mid-integration. Letting the driver inspect the buffer and
// decide keeps both paths uniform.

import { evalNumericExpr } from "@workbench/quadrature";
import type { Value } from "@workbench/protocol";

/**
 * Build a vector-RHS function from a list of expression `Value`s and
 * a list of state-variable names.
 *
 *   `fExprs` — n component expressions; component `i` is `dy_i/dt`.
 *   `vars`   — n state-variable names, indexed in the same order as
 *              the components of `y` and `fExprs`.
 *   `tVar`   — name of the independent variable (e.g. `"t"`).
 *
 * The returned function `(t, y, out)` writes `f(t, y)` into `out`
 * in place. The caller owns the `out` buffer (the adaptive driver
 * pre-allocates seven such buffers for the FSAL stages).
 *
 * Throws `UnknownVocabularyError` from `evalNumericExpr` on the first
 * call if any expression contains an unknown head or unbound symbol.
 * The tool layer's `fn` body translates this into a `ToolError`.
 */
export function buildRhs(
  fExprs: readonly Value[],
  vars: readonly string[],
  tVar: string,
): (t: number, y: Float64Array, out: Float64Array) => void {
  const n = vars.length;
  // The shared env Map. `t` plus each state variable. Mutated in
  // place on every call.
  const env = new Map<string, number>();
  env.set(tVar, 0);
  for (const v of vars) env.set(v, 0);

  return (t: number, y: Float64Array, out: Float64Array): void => {
    env.set(tVar, t);
    for (let i = 0; i < n; i++) env.set(vars[i]!, y[i]!);
    for (let i = 0; i < n; i++) {
      out[i] = evalNumericExpr(fExprs[i]!, env);
    }
  };
}
