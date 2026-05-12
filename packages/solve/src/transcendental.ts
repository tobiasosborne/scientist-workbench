// =============================================================================
// transcendental.ts — invert single-head transcendental equations
// =============================================================================
//
// What this module does
// ---------------------
// Given an equation expression `eq = 0` over the closed numerical
// vocabulary and a variable name, attempt to recognise the simple
// pattern
//
//     head(x) = c
//
// where `head ∈ {exp, log, sin, cos, tan, sinh, cosh, tanh, abs}` and
// `c` is a numeric constant. If the pattern matches, return the
// solution set as a list of ADR-0017 `Solution` records, with branch
// parameters where the inverse function is multi-branched (sin / cos
// / tan modulo 2π or π). If not, return `null` — the caller then
// falls back to the polynomial path or refuses with an honest tag.
//
// Why a simple pattern matcher (not full invert-and-substitute)
// -------------------------------------------------------------
// Bead `scientist-workbench-ii0` is the inversion *substrate*: per-
// head left-inverses with branch-parameter emission. Bead
// `scientist-workbench-37r` extends to compound patterns
// `head(g(x)) = c` via substitution heuristics (`u = g(x)` → polynomial
// in `u` → invert each root). v0.1 ships ii0 only; 37r is a follow-up.
//
// The pattern set v0.1 admits, all variations of "head(x) on one side,
// constant on the other":
//
//   • `head(x)`                     ⟹  `head(x) = 0`  with c = 0.
//   • `head(x) − c`                 ⟹  `head(x) = c`.
//   • `c − head(x)`                 ⟹  `head(x) = c`.
//   • `head(x) + c`                 ⟹  `head(x) = −c`.
//   • `c + head(x)`                 ⟹  `head(x) = −c`.
//   • An n-ary `+`-summation with exactly one `head(x)` summand and
//     the rest constants: `head(x) + c_1 + c_2 + … = 0`
//     ⟹  `head(x) = −(c_1 + c_2 + …)`.
//
// Anything more involved (`a · head(x) + b = 0`, `head(g(x)) = c`,
// `head_1(x) + head_2(x) = c`) is out of scope at this layer; the
// dispatcher falls back to refusal `solve/transcendental-multibranch`.
//
// Inverse table (real-valued)
// ---------------------------
// We emit symbolic expressions over the closed numerical vocabulary;
// they parse as `Value`s and a downstream `evalNumericExpr` can
// substitute float64 for the branch parameters to enumerate solutions.
// Branch symbols use the workbench-wide `t_<i>` convention (matching
// bareiss's free-variable naming); ADR-0017 specifies `k_<i>` with
// namespace `'solve'` for v0.2 normalisation.
//
//   exp(x)  = c  ⟹  x = log(c)                     (1 branch, real)
//   log(x)  = c  ⟹  x = exp(c)                     (1 branch)
//   sin(x)  = c  ⟹  x = arcsin(c) + 2π · t_0      and
//                   x = π − arcsin(c) + 2π · t_1   (2 branches)
//   cos(x)  = c  ⟹  x = arccos(c) + 2π · t_0      and
//                   x = −arccos(c) + 2π · t_1     (2 branches)
//   tan(x)  = c  ⟹  x = arctan(c) + π · t_0       (1 branch ×  π, not 2π)
//   sinh(x) = c  ⟹  x = arcsinh(c)                (1 branch — sinh is monotone)
//   cosh(x) = c  ⟹  x ∈ {arccosh(c), −arccosh(c)} (2 branches — even function)
//   tanh(x) = c  ⟹  x = arctanh(c)                (1 branch)
//   abs(x)  = c  ⟹  x ∈ {c, −c}                   (2 branches; consumer
//                                                  may discard −c when c < 0)
//
// Out-of-domain inputs (e.g. cos(x) = 5) are still returned with the
// arccos(5) formula; numerical evaluation yields NaN. We do not refuse
// for "no real solution" — the symbolic answer is correct over ℂ, and
// the consumer's domain-aware simplifier filters as appropriate.

import {
  type Value,
  expr,
  int,
  rat as protocolRat,
  sym,
} from "@workbench/protocol";

import type { Solution, SolveResult } from "./dispatch.js";

const TRANSCENDENTAL_HEADS: ReadonlySet<string> = new Set([
  "exp", "log", "sin", "cos", "tan", "sinh", "cosh", "tanh", "abs",
]);

const PI = sym("pi");
const TWO = int(2n);

/**
 * Try to recognise `eq = 0` as a single-head transcendental equation
 * in `varName` and emit the solution set.
 *
 * Handles two compound-arg shapes:
 *   • `head(x) = c`              (the basic ii0 case)
 *   • `head(a · x + b) = c`      (linear-inner-arg extension; bead 37r)
 *
 * For the linear case, the substitution is straightforward: invert
 * `head` to get `a · x + b ∈ {h_1(c), …, h_k(c)}` (with branch params
 * for multi-branched heads), then solve the linear `a · x + b = h_i(c)`
 * for each branch to get `x = (h_i(c) − b) / a`.
 *
 * @returns `SolveResult` (success or refusal) on a recognised pattern,
 *          or `null` if the equation does not match.
 */
export function tryTranscendentalInvert(
  eq: Value,
  varName: string,
): SolveResult | null {
  // Try the simple case first: head(x) = c.
  const decompSimple = decomposeAsHeadEqualsConstant(eq, varName);
  if (decompSimple !== null) {
    return invertHead(decompSimple.head, decompSimple.c, varName);
  }

  // Try the compound linear-inner case: head(a · x + b) = c (bead 37r).
  const decompLinear = decomposeAsHeadOfLinearEqualsConstant(eq, varName);
  if (decompLinear !== null) {
    const inner = invertHead(decompLinear.head, decompLinear.c, "__inner");
    if (inner.kind !== "success") return inner;
    return rewriteInnerLinear(
      inner, varName, decompLinear.linearA, decompLinear.linearB,
    );
  }

  return null;
}

// -----------------------------------------------------------------------------
// pattern decomposition
// -----------------------------------------------------------------------------

interface HeadAndConst {
  readonly head: string;
  readonly c: Value;
}

function decomposeAsHeadEqualsConstant(
  eq: Value, varName: string,
): HeadAndConst | null {
  // Case A: bare `head(x)` — rare but legitimate (`sin(x) = 0`).
  const bareHead = matchHeadOfVar(eq, varName);
  if (bareHead !== null) return { head: bareHead, c: int(0n) };

  if (eq.kind !== "expression") return null;

  // Case B: `head(x) − c` or `c − head(x)` (binary `-`).
  if (eq.head === "-" && eq.args.length === 2) {
    const lhs = eq.args[0]!;
    const rhs = eq.args[1]!;
    const lhsHead = matchHeadOfVar(lhs, varName);
    if (lhsHead !== null && isNumericConstant(rhs)) {
      return { head: lhsHead, c: rhs };
    }
    const rhsHead = matchHeadOfVar(rhs, varName);
    if (rhsHead !== null && isNumericConstant(lhs)) {
      return { head: rhsHead, c: lhs };
    }
  }

  // Case C: n-ary `+` with exactly one head(x) summand and the rest
  // numeric constants. `head(x) + c_1 + … = 0` ⟹ `head(x) = −(Σ c_i)`.
  if (eq.head === "+") {
    let foundHead: string | null = null;
    const constants: Value[] = [];
    for (const arg of eq.args) {
      const m = matchHeadOfVar(arg, varName);
      if (m !== null) {
        if (foundHead !== null) return null;        // two head(x) terms
        foundHead = m;
      } else if (isNumericConstant(arg)) {
        constants.push(arg);
      } else {
        return null;                                // non-constant non-head term
      }
    }
    if (foundHead !== null) {
      const sum = sumConstants(constants);
      return { head: foundHead, c: negateConstant(sum) };
    }
  }

  return null;
}

/** Returns the head name iff `v` is `expr(head, [sym(varName)])` with a known head. */
function matchHeadOfVar(v: Value, varName: string): string | null {
  if (v.kind !== "expression") return null;
  if (!TRANSCENDENTAL_HEADS.has(v.head)) return null;
  if (v.args.length !== 1) return null;
  const arg = v.args[0]!;
  if (arg.kind !== "symbol" || arg.name !== varName) return null;
  return v.head;
}

interface HeadOfLinear {
  readonly head: string;
  /** `a` in `head(a · varName + b)`, with `a ≠ 0`. */
  readonly linearA: Value;
  /** `b` in `head(a · varName + b)`. */
  readonly linearB: Value;
}

/**
 * Recognise `expr(head, [linear-in-varName])` where the inner argument
 * is `a · varName + b` (or `a · varName`, or `varName + b`) with `a, b`
 * numeric constants. Excludes the bare `head(varName)` case (which is
 * handled by `matchHeadOfVar`), to keep `tryTranscendentalInvert`'s
 * logic ordering deterministic.
 */
function matchHeadOfLinear(v: Value, varName: string): HeadOfLinear | null {
  if (v.kind !== "expression") return null;
  if (!TRANSCENDENTAL_HEADS.has(v.head)) return null;
  if (v.args.length !== 1) return null;
  const arg = v.args[0]!;
  // arg must be a linear function of varName: a · varName + b, with a, b
  // numeric constants.  We accept four structural sub-shapes (see
  // `decomposeLinearInVar` for the full table):
  //   A: expr("*", [c, varName])                       — c·x, no offset
  //   B: expr("+", […, c·varName, …])                  — n-ary sum, one var term
  //   C: expr("-", [varName, b])                       — x − b, a = 1
  //   D: expr("-", [c·varName, b])                     — c·x − b
  // Bare `varName` itself is the "head(x)" case handled by `matchHeadOfVar`.
  // The mirrored `b − c·varName` shape is not currently emitted by the
  // corpus parser, so an "E" arm is omitted; add if it ever surfaces.
  if (arg.kind === "symbol" && arg.name === varName) return null;
  return decomposeLinearInVar(arg, varName, v.head);
}

function decomposeLinearInVar(
  arg: Value, varName: string, headName: string,
): HeadOfLinear | null {
  // Pattern: arg is a · varName + b (or sub-shapes).  We use the cas-core
  // valueToRatFn machinery indirectly via a hand-rolled decomposition,
  // because importing valueToRatFn here would create a circular dep
  // (cas-core ← solve, but valueToRatFn lives in cas-core).  Instead,
  // we recognise the structural patterns directly.

  // Sub-shape A: c · varName  (no offset).
  if (arg.kind === "expression" && arg.head === "*" && arg.args.length === 2) {
    const a0 = arg.args[0]!;
    const a1 = arg.args[1]!;
    if (isNumericConstant(a0) && a1.kind === "symbol" && a1.name === varName) {
      return { head: headName, linearA: a0, linearB: int(0n) };
    }
    if (isNumericConstant(a1) && a0.kind === "symbol" && a0.name === varName) {
      return { head: headName, linearA: a1, linearB: int(0n) };
    }
  }

  // Sub-shape B: varName + b (a = 1).
  if (arg.kind === "expression" && arg.head === "+" && arg.args.length >= 2) {
    let varCoef: Value | null = null;       // coefficient of varName, if seen
    let varSeen = false;
    const constants: Value[] = [];
    for (const a of arg.args) {
      if (a.kind === "symbol" && a.name === varName) {
        if (varSeen) return null;            // multiple varName terms
        varSeen = true;
        varCoef = int(1n);
      } else if (a.kind === "expression" && a.head === "*" && a.args.length === 2) {
        const m0 = a.args[0]!, m1 = a.args[1]!;
        if (isNumericConstant(m0) && m1.kind === "symbol" && m1.name === varName) {
          if (varSeen) return null;
          varSeen = true;
          varCoef = m0;
        } else if (isNumericConstant(m1) && m0.kind === "symbol" && m0.name === varName) {
          if (varSeen) return null;
          varSeen = true;
          varCoef = m1;
        } else if (isNumericConstant(m0) && isNumericConstant(m1)) {
          // c1 * c2 — treat as a constant (rare; user could have written
          // `2*3` without simplification).
          constants.push(a);
        } else {
          return null;
        }
      } else if (isNumericConstant(a)) {
        constants.push(a);
      } else {
        return null;
      }
    }
    if (!varSeen || varCoef === null) return null;
    const offset = constants.length === 0
      ? int(0n)
      : constants.length === 1
        ? constants[0]!
        : expr("+", constants);
    return { head: headName, linearA: varCoef, linearB: offset };
  }

  // Sub-shape C/D: binary `−` form `(left) − b` with `b` a numeric
  // constant. Two flavours:
  //   • C: `varName − b`            (a = 1, negative offset).
  //   • D: `c · varName − b`        (general; coefficient on either
  //                                  side of the `*`).
  // Bench-side rationale: SymPy-style equation strings such as
  // `log(-3*x - 3)` round-trip through the corpus parser (left-
  // associative `+ −`) as `expr("-", [expr("*", [-3, x]), 3])` —
  // a `c · varName − b` shape with no enclosing `+`.  Without this
  // arm the linear-arg path missed every `head(c·x − b)` input,
  // refusing as `solve/foreign-vocabulary` (bead `3g9x`).
  if (arg.kind === "expression" && arg.head === "-" && arg.args.length === 2) {
    const left = arg.args[0]!;
    const right = arg.args[1]!;
    if (isNumericConstant(right)) {
      const negB = negateConstant(right);
      if (left.kind === "symbol" && left.name === varName) {
        return { head: headName, linearA: int(1n), linearB: negB };
      }
      if (left.kind === "expression" && left.head === "*" && left.args.length === 2) {
        const m0 = left.args[0]!;
        const m1 = left.args[1]!;
        if (isNumericConstant(m0) && m1.kind === "symbol" && m1.name === varName) {
          return { head: headName, linearA: m0, linearB: negB };
        }
        if (isNumericConstant(m1) && m0.kind === "symbol" && m0.name === varName) {
          return { head: headName, linearA: m1, linearB: negB };
        }
      }
    }
  }

  return null;
}

function decomposeAsHeadOfLinearEqualsConstant(
  eq: Value, varName: string,
): { head: string; c: Value; linearA: Value; linearB: Value } | null {
  // Reuse the same outer pattern as decomposeAsHeadEqualsConstant, but
  // accept `head(a·x + b)` instead of just `head(x)` on the head side.

  // Case A: bare `head(linear)`.
  const bare = matchHeadOfLinear(eq, varName);
  if (bare !== null) {
    return { head: bare.head, c: int(0n), linearA: bare.linearA, linearB: bare.linearB };
  }

  if (eq.kind !== "expression") return null;

  // Case B: `head(linear) − c` or `c − head(linear)`.
  if (eq.head === "-" && eq.args.length === 2) {
    const lhs = eq.args[0]!;
    const rhs = eq.args[1]!;
    const lhsHead = matchHeadOfLinear(lhs, varName);
    if (lhsHead !== null && isNumericConstant(rhs)) {
      return { head: lhsHead.head, c: rhs, linearA: lhsHead.linearA, linearB: lhsHead.linearB };
    }
    const rhsHead = matchHeadOfLinear(rhs, varName);
    if (rhsHead !== null && isNumericConstant(lhs)) {
      return { head: rhsHead.head, c: lhs, linearA: rhsHead.linearA, linearB: rhsHead.linearB };
    }
  }

  // Case C: n-ary `+` with one head(linear) summand and constants.
  if (eq.head === "+") {
    let foundHead: HeadOfLinear | null = null;
    const constants: Value[] = [];
    for (const arg of eq.args) {
      const m = matchHeadOfLinear(arg, varName);
      if (m !== null) {
        if (foundHead !== null) return null;
        foundHead = m;
      } else if (isNumericConstant(arg)) {
        constants.push(arg);
      } else {
        return null;
      }
    }
    if (foundHead !== null) {
      const sum = sumConstants(constants);
      return {
        head: foundHead.head,
        c: negateConstant(sum),
        linearA: foundHead.linearA,
        linearB: foundHead.linearB,
      };
    }
  }

  return null;
}

/**
 * Rewrite the inner-variable `__inner` solutions of `inverseResult` as
 * outer-variable `varName` solutions, given the linear relation
 * `__inner = a · varName + b`.  i.e. each binding `__inner = h_i(c)`
 * becomes `varName = (h_i(c) − b) / a`.
 */
function rewriteInnerLinear(
  inverseResult: SolveResult,
  varName: string, a: Value, b: Value,
): SolveResult {
  if (inverseResult.kind !== "success") return inverseResult;
  const solutions: Solution[] = inverseResult.solutions.map((sol) => {
    // sol.bindings[0] is `__inner = h_i(c)` (possibly with branch params).
    const innerValue = sol.bindings[0]!.value;
    // Build x = (innerValue − b) / a.
    const xValue: Value =
      isZeroLiteral(b)
        ? (isOneLiteral(a) ? innerValue : expr("/", [innerValue, a]))
        : (isOneLiteral(a)
            ? expr("-", [innerValue, b])
            : expr("/", [expr("-", [innerValue, b]), a]));
    return {
      bindings: [{ var: varName, value: xValue }],
      branches: sol.branches,
    };
  });
  return {
    ...inverseResult,
    vars: [varName],
    solutions,
  };
}

function isZeroLiteral(v: Value): boolean {
  if (v.kind === "integer") return BigInt(v.value) === 0n;
  if (v.kind === "rational") return BigInt(v.num) === 0n;
  return false;
}

function isOneLiteral(v: Value): boolean {
  if (v.kind === "integer") return BigInt(v.value) === 1n;
  if (v.kind === "rational") return BigInt(v.num) === 1n && BigInt(v.den) === 1n;
  return false;
}

function isNumericConstant(v: Value): boolean {
  return v.kind === "integer" || v.kind === "rational" || v.kind === "float64";
}

function sumConstants(items: readonly Value[]): Value {
  if (items.length === 0) return int(0n);
  if (items.length === 1) return items[0]!;
  // Build a `+`-headed expression — the consumer can simplify via cas-simplify.
  return expr("+", items.slice());
}

function negateConstant(v: Value): Value {
  if (v.kind === "integer") {
    return int(-BigInt(v.value));
  }
  if (v.kind === "rational") {
    return protocolRat(-BigInt(v.num), BigInt(v.den));
  }
  // For other kinds (float64, expression-like sum), wrap in `*` with -1.
  return expr("*", [int(-1n), v]);
}

// -----------------------------------------------------------------------------
// per-head inverse rules
// -----------------------------------------------------------------------------

function invertHead(
  head: string, c: Value, varName: string,
): SolveResult {
  switch (head) {
    case "exp":  return monoBranch(c, varName, (cc) => expr("log", [cc]), "exp(x) = c");
    case "log":  return monoBranch(c, varName, (cc) => expr("exp", [cc]), "log(x) = c");
    case "tanh": return monoBranch(c, varName, (cc) => expr("atanh", [cc]), "tanh(x) = c");
    case "sinh": return monoBranch(c, varName, (cc) => expr("asinh", [cc]), "sinh(x) = c");
    case "tan":  return tanInvert(c, varName);
    case "sin":  return sinInvert(c, varName);
    case "cos":  return cosInvert(c, varName);
    case "cosh": return coshInvert(c, varName);
    case "abs":  return absInvert(c, varName);
    default:
      return {
        kind: "refusal",
        reasonClass: "transcendental-multibranch",
        detail: `transcendental head '${head}' not in v0.1 invert table`,
      };
  }
}

function monoBranch(
  c: Value, varName: string, inverse: (c: Value) => Value, _label: string,
): SolveResult {
  return {
    kind: "success",
    vars: [varName],
    solutions: [{
      bindings: [{ var: varName, value: inverse(c) }],
      branches: [],
    }],
    completeness: "complete",
    warnings: [],
  };
}

function sinInvert(c: Value, varName: string): SolveResult {
  // x = arcsin(c) + 2π·t_0 OR π − arcsin(c) + 2π·t_1
  const arcsinC = expr("asin", [c]);
  const branch1: Value = expr("+", [arcsinC, expr("*", [TWO, PI, sym("t_0")])]);
  const branch2: Value = expr("+", [
    expr("-", [PI, arcsinC]),
    expr("*", [TWO, PI, sym("t_1")]),
  ]);
  return finiteRepInfinite(varName, [
    { value: branch1, branches: ["t_0"] },
    { value: branch2, branches: ["t_1"] },
  ]);
}

function cosInvert(c: Value, varName: string): SolveResult {
  // x = arccos(c) + 2π·t_0 OR −arccos(c) + 2π·t_1
  const arccosC = expr("acos", [c]);
  const branch1: Value = expr("+", [arccosC, expr("*", [TWO, PI, sym("t_0")])]);
  const branch2: Value = expr("+", [
    expr("*", [int(-1n), arccosC]),
    expr("*", [TWO, PI, sym("t_1")]),
  ]);
  return finiteRepInfinite(varName, [
    { value: branch1, branches: ["t_0"] },
    { value: branch2, branches: ["t_1"] },
  ]);
}

function tanInvert(c: Value, varName: string): SolveResult {
  // x = arctan(c) + π·t_0
  const arctanC = expr("atan", [c]);
  const branch1: Value = expr("+", [arctanC, expr("*", [PI, sym("t_0")])]);
  return finiteRepInfinite(varName, [
    { value: branch1, branches: ["t_0"] },
  ]);
}

function coshInvert(c: Value, varName: string): SolveResult {
  // x = arccosh(c) OR x = -arccosh(c)
  const acoshC = expr("acosh", [c]);
  return {
    kind: "success",
    vars: [varName],
    solutions: [
      { bindings: [{ var: varName, value: acoshC }], branches: [] },
      { bindings: [{ var: varName, value: expr("*", [int(-1n), acoshC]) }], branches: [] },
    ],
    completeness: "complete",
    warnings: [],
  };
}

function absInvert(c: Value, varName: string): SolveResult {
  // x = c OR x = -c
  return {
    kind: "success",
    vars: [varName],
    solutions: [
      { bindings: [{ var: varName, value: c }], branches: [] },
      { bindings: [{ var: varName, value: negateConstant(c) }], branches: [] },
    ],
    completeness: "complete",
    warnings: [],
  };
}

interface BranchedResult {
  readonly value: Value;
  readonly branches: readonly string[];
}

function finiteRepInfinite(
  varName: string, results: readonly BranchedResult[],
): SolveResult {
  const solutions: Solution[] = results.map((r) => ({
    bindings: [{ var: varName, value: r.value }],
    branches: r.branches.slice(),
  }));
  return {
    kind: "success",
    vars: [varName],
    solutions,
    completeness: "finite-rep-of-infinite",
    warnings: [],
  };
}
