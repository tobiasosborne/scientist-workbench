// =============================================================================
// eval-expr.ts — numeric evaluator over the closed integrand vocabulary
// =============================================================================
//
// Intent
// ------
// `tools/integrate-1d` takes the integrand as a `Value` (an
// `expression` tree, possibly with leaves that are integers,
// rationals, float64s, or symbols). The adaptive driver in
// `gauss-kronrod.ts` needs `f: (x: number) => number`. This module is
// the bridge: it walks the `Value` tree, resolves the integration
// variable from an `env` map, and produces a JS number.
//
// The vocabulary is *closed* — the tool's declared scope is exactly
// what `evalNumericExpr` admits. Unknown heads (e.g. `arctan`,
// `gamma`) and unknown free symbols (e.g. an undeclared `y` when the
// integration variable is `x`) raise `UnknownVocabularyError`. The
// tool layer translates this into `ToolError` (malformed input) at
// the *first* evaluation; we do not silently produce NaN or zero.
//
// Vocabulary
// ----------
// Heads (binary unless noted):
//   `+`, `-`, `*`, `/`, `^`               — n-ary `+`/`*`, binary
//                                            `-`/`/`/`^`, and unary
//                                            `-` (alias `neg`)
//   `neg`                                  — unary negation
//   `exp`, `sin`, `cos`, `tan`,            — unary, math.h sense
//   `log`, `sqrt`, `abs`
//
// Symbols:
//   `pi` (≡ `Math.PI`), `e` (≡ `Math.E`)
//   any other symbol must be present in `env`; otherwise
//   `UnknownVocabularyError`.
//
// Numeric leaves:
//   `integer`  — parsed via `BigInt` then `Number(...)`. Lossy for
//                values > 2^53; the tool layer documents this.
//   `rational` — `Number(num) / Number(den)`. Same caveat.
//   `float64`  — IEEE-754 round-trip via `float64ToNumber` from
//                `@workbench/protocol`.
//
// Out of scope (deliberate, v0.1)
// -------------------------------
// No `arctan` / `arcsin` / `arccos` (the integrand families in the
// reference manifest don't need them). No `floor`/`ceil`/`mod` (not
// useful in numerical integrands). No piecewise/`Heaviside` (a
// quadrature method that hits a step function should refuse, not
// silently ring; the manifest's discontinuous case handles this by
// being defined as `exp(2x)` over the truncated support).
//
// The vocabulary list above is the README's `valid heads` list — the
// tool's `ToolError` suggestion when an unknown head shows up should
// quote it verbatim.

import { float64ToNumber, type Value } from "@workbench/protocol";

/** Heads admitted by the evaluator. Exported so the tool layer can echo them in error messages. */
export const ADMITTED_HEADS: readonly string[] = [
  "+",
  "-",
  "*",
  "/",
  "^",
  "neg",
  "exp",
  "sin",
  "cos",
  "tan",
  "log",
  "sqrt",
  "abs",
];

/** Symbols admitted as constants. Variables are resolved via `env`. */
export const ADMITTED_CONSTANTS: readonly string[] = ["pi", "e"];

const ADMITTED_HEADS_SET = new Set(ADMITTED_HEADS);
const ADMITTED_CONSTANTS_SET = new Set(ADMITTED_CONSTANTS);

export class UnknownVocabularyError extends Error {
  /** "head" if an unknown expression head was encountered, "symbol" if an unknown free variable. */
  readonly kind: "head" | "symbol";
  /** The offending identifier (head string or symbol name). Distinct from `Error.name`. */
  readonly identifier: string;
  constructor(kind: "head" | "symbol", identifier: string) {
    super(
      kind === "head"
        ? `evalNumericExpr: unknown expression head ${JSON.stringify(identifier)}; admitted heads: ${ADMITTED_HEADS.join(", ")}`
        : `evalNumericExpr: unknown free symbol ${JSON.stringify(identifier)}; admitted constants: ${ADMITTED_CONSTANTS.join(", ")}; provide other variables via env`,
    );
    this.name = "UnknownVocabularyError";
    this.kind = kind;
    this.identifier = identifier;
  }
}

/**
 * Recursively evaluate `e` with the given environment. Variables are
 * resolved from `env` (e.g. `env.set("x", 0.5)`), constants from the
 * built-in `pi`/`e` table, and arithmetic via the obvious mapping
 * onto JavaScript's float64 ops.
 *
 * Returns whatever IEEE-754 result the underlying `Math.*` operations
 * produce — including `NaN` (e.g. `log(-1)`), `±Infinity` (e.g.
 * `1/0`), and signed zeros. The *quadrature driver* is responsible
 * for catching non-finite values during integration; the evaluator
 * itself is faithful to IEEE-754 semantics so that callers can
 * reason about partial behaviour (e.g. probe whether `f(midpoint)`
 * is finite without coupling to a quadrature run).
 *
 * Throws `UnknownVocabularyError` on unrecognised heads or symbols.
 * This is the only error path; numeric arity / type problems on
 * operations that admit them (e.g. `+` with one argument) currently
 * also fall through to `UnknownVocabularyError` via the head-arity
 * check, but a future refactor may surface a separate
 * `EvaluatorArityError`.
 */
export function evalNumericExpr(e: Value, env: Map<string, number>): number {
  switch (e.kind) {
    case "integer":
      // BigInt → number is lossy for |value| > 2^53. Acceptable for
      // integrands; users with huge integer coefficients are out of
      // scope for v0.1 numerical integration anyway.
      return Number(BigInt(e.value));
    case "rational": {
      const num = Number(BigInt(e.num));
      const den = Number(BigInt(e.den));
      return num / den;
    }
    case "float64":
      return float64ToNumber(e);
    case "symbol": {
      // Constants take precedence over `env`. A user who tries to
      // override `pi` would surprise the next reader; we refuse by
      // returning the constant unconditionally.
      if (e.name === "pi") return Math.PI;
      if (e.name === "e") return Math.E;
      const v = env.get(e.name);
      if (v === undefined) throw new UnknownVocabularyError("symbol", e.name);
      return v;
    }
    case "expression": {
      if (!ADMITTED_HEADS_SET.has(e.head)) {
        throw new UnknownVocabularyError("head", e.head);
      }
      return applyHead(e.head, e.args, env);
    }
    case "string":
    case "boolean":
    case "list":
    case "record":
    case "tagged":
      throw new UnknownVocabularyError(
        "head",
        `<${e.kind} value not evaluable as a numeric expression>`,
      );
  }
}

function applyHead(head: string, args: readonly Value[], env: Map<string, number>): number {
  switch (head) {
    case "+": {
      // n-ary sum. `+()` is 0; `+(x)` is x; `+(a, b, c)` is a+b+c.
      let s = 0;
      for (const a of args) s += evalNumericExpr(a, env);
      return s;
    }
    case "*": {
      let p = 1;
      for (const a of args) p *= evalNumericExpr(a, env);
      return p;
    }
    case "-": {
      // Unary minus (`-(x)` ≡ `neg(x)`) or binary subtraction
      // (`-(a, b)`). The `expr-parse` tool emits binary `-` for
      // infix subtraction and prefers `neg` for unary, but we accept
      // both shapes for symmetry with `+`.
      if (args.length === 1) return -evalNumericExpr(args[0]!, env);
      if (args.length === 2) return evalNumericExpr(args[0]!, env) - evalNumericExpr(args[1]!, env);
      throw new UnknownVocabularyError("head", `- (arity ${args.length})`);
    }
    case "neg": {
      if (args.length !== 1) throw new UnknownVocabularyError("head", `neg (arity ${args.length})`);
      return -evalNumericExpr(args[0]!, env);
    }
    case "/": {
      if (args.length !== 2) throw new UnknownVocabularyError("head", `/ (arity ${args.length})`);
      return evalNumericExpr(args[0]!, env) / evalNumericExpr(args[1]!, env);
    }
    case "^": {
      if (args.length !== 2) throw new UnknownVocabularyError("head", `^ (arity ${args.length})`);
      return Math.pow(evalNumericExpr(args[0]!, env), evalNumericExpr(args[1]!, env));
    }
    case "exp":
      return Math.exp(unaryArg("exp", args, env));
    case "sin":
      return Math.sin(unaryArg("sin", args, env));
    case "cos":
      return Math.cos(unaryArg("cos", args, env));
    case "tan":
      return Math.tan(unaryArg("tan", args, env));
    case "log":
      return Math.log(unaryArg("log", args, env));
    case "sqrt":
      return Math.sqrt(unaryArg("sqrt", args, env));
    case "abs":
      return Math.abs(unaryArg("abs", args, env));
  }
  // Unreachable — the head-set guard above ensures only recognised
  // heads land here. The exhaustive switch keeps TS honest.
  throw new UnknownVocabularyError("head", head);
}

function unaryArg(head: string, args: readonly Value[], env: Map<string, number>): number {
  if (args.length !== 1) throw new UnknownVocabularyError("head", `${head} (arity ${args.length})`);
  return evalNumericExpr(args[0]!, env);
}
