// =============================================================================
// diff.ts — symbolic differentiation over the closed numerical vocabulary
// =============================================================================
//
// This module implements `differentiate(expr, wrt)`: a pure-symbolic
// derivative of an expression `Value` with respect to a variable
// `SymbolValue`, returning a new `Value`. It is the substrate behind
// `tools/cas-diff/`.
//
// Vocabulary (matches @workbench/quadrature's `evalNumericExpr`)
// ---------------------------------------------------------------
// Heads:     + - * / ^ neg exp sin cos tan log sqrt abs
// Constants: pi, e
// Leaves:    integer, rational, float64
// Variables: any symbol
//
// (Note: this is the broader *numerical* vocabulary, not the narrower
// algebraic-only vocabulary of cas-simplify. cas-simplify excludes
// transcendentals because it canonicalises Q[x_1..x_n] / Q(x_1..x_n);
// cas-diff includes them because differentiation rules are well-defined
// for all of them, and the natural sister tool — integrate-1d — accepts
// the same superset. A planner that wants to differentiate-then-
// integrate composes cleanly because the vocabularies match.)
//
// Rule table (single-variable derivative; `wrt` is the differentiation var):
// --------------------------------------------------------------------------
//   atoms        d(c)/dx     = 0          (integer/rational/float64/pi/e)
//   variable     d(s)/dx     = 1 if s == wrt else 0
//   sum          d(Σ aᵢ)/dx  = Σ daᵢ/dx
//   diff (-)     d(a-b)/dx   = da-db    (also unary: d(-a)/dx = -da)
//   neg          d(neg a)/dx = neg(da)
//   product      d(Π aᵢ)/dx  = Σᵢ a₁·…·daᵢ·…·aₙ          (n-ary product rule)
//   quotient     d(a/b)/dx   = (da·b - a·db) / b²
//   power        d(aᵇ)/dx    = b·a^(b-1)·da              if b ⊥ wrt (power rule)
//                            = aᵇ·log(a)·db              if a ⊥ wrt (exp rule)
//                            = aᵇ·(db·log(a) + b·da/a)   general (log-chain)
//   exp          d(exp a)/dx = exp(a)·da
//   log          d(log a)/dx = da/a                          (natural log)
//   sin          d(sin a)/dx = cos(a)·da
//   cos          d(cos a)/dx = -sin(a)·da
//   tan          d(tan a)/dx = da / cos(a)²
//   sqrt         d(√a)/dx    = da / (2·√a)
//   abs          d(|a|)/dx   = (a/|a|)·da   (singular at a=0; correct on R\{0})
//   asin         d(asin a)/dx  = da / √(1 − a²)              (|a| < 1)
//   acos         d(acos a)/dx  = −da / √(1 − a²)             (|a| < 1)
//   atan         d(atan a)/dx  = da / (1 + a²)
//   sinh         d(sinh a)/dx  = cosh(a) · da
//   cosh         d(cosh a)/dx  = sinh(a) · da
//   tanh         d(tanh a)/dx  = (1 − tanh(a)²) · da
//   asinh        d(asinh a)/dx = da / √(1 + a²)
//   acosh        d(acosh a)/dx = da / √(a² − 1)              (a > 1)
//   atanh        d(atanh a)/dx = da / (1 − a²)               (|a| < 1)
//   log2         d(log₂ a)/dx  = da / (a · log(2))
//   log10        d(log₁₀ a)/dx = da / (a · log(10))
//
// Boundary discipline
// -------------------
// Any subterm with a head outside the table, OR any Value of a kind
// cas-diff cannot interpret (string / list / record / tagged / boolean),
// raises `CasDiffOutOfScopeError`. The tool layer maps that to a
// top-level `tagged "cas-diff/out-of-scope"` so an agent gets a binary
// yes/no answer ("did this work?") rather than having to walk the result
// tree looking for embedded tagged sub-nodes. This is the same honest-
// scope discipline cas-simplify follows for its own narrower vocab,
// modulo the binary-vs-embedded distinction (cas-simplify wraps the
// node *in place*; cas-diff refuses the whole input).
//
// Output structure
// ----------------
// Smart constructors absorb local identities:
//   0 + x      → x
//   1 · x      → x
//   x · 0      → 0
//   x¹         → x
//   x⁰         → 1
//   neg(0)     → 0
//   neg(neg(x)) → x
//   a / 1      → a
//   0 / a      → 0
// No further reduction. Pipe through `cas-simplify` if you want full
// canonicalisation (e.g. like-term collapse, polynomial expansion). The
// decomposition discipline keeps cas-diff focused on differentiation;
// simplification is a sibling concern.

import {
  expr,
  float64ToNumber,
  int,
  rat,
  type ExpressionValue,
  type SymbolValue,
  type Value,
} from "@workbench/protocol";

/** Tag used by `tools/cas-diff/` for the top-level out-of-scope refusal. */
export const DIFF_TAG = "cas-diff/out-of-scope";

/** Heads cas-diff knows how to differentiate. */
export const DIFF_ADMITTED_HEADS: readonly string[] = [
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
  // Tier-1 extension (2026-05-04). Vocabulary tracks
  // @workbench/quadrature's ADMITTED_HEADS so cas-diff →
  // integrate-1d / optimize-lbfgs-projected continues to compose
  // without vocabulary mismatches.
  "asin",
  "acos",
  "atan",
  "sinh",
  "cosh",
  "tanh",
  "asinh",
  "acosh",
  "atanh",
  "log2",
  "log10",
];

const DIFF_ADMITTED_HEADS_SET = new Set(DIFF_ADMITTED_HEADS);

/** Symbol names cas-diff treats as constants (derivative is 0 regardless of wrt). */
export const DIFF_ADMITTED_CONSTANTS: readonly string[] = ["pi", "e"];

const DIFF_ADMITTED_CONSTANTS_SET = new Set(DIFF_ADMITTED_CONSTANTS);

/**
 * Thrown when an expression contains a subterm cas-diff cannot
 * interpret. Two flavours:
 *   * `kind: "head"` — an expression head not in the rule table
 *     (e.g., gamma, erf, arctan). Identifier is the head string.
 *   * `kind: "value-kind"` — a Value whose top-level kind cas-diff
 *     does not interpret as a mathematical scalar
 *     (string / list / record / tagged / boolean). Identifier is the
 *     kind string.
 *
 * Pattern mirrors @workbench/quadrature's UnknownVocabularyError so the
 * two tools' refusal taxonomies feel consistent.
 */
export class CasDiffOutOfScopeError extends Error {
  readonly kind: "head" | "value-kind";
  readonly identifier: string;
  constructor(kind: "head" | "value-kind", identifier: string) {
    super(
      kind === "head"
        ? `cas-diff: unknown expression head ${JSON.stringify(identifier)}; admitted heads: ${DIFF_ADMITTED_HEADS.join(", ")}`
        : `cas-diff: cannot differentiate value of kind ${JSON.stringify(identifier)}; expected expression / symbol / integer / rational / float64`,
    );
    this.name = "CasDiffOutOfScopeError";
    this.kind = kind;
    this.identifier = identifier;
  }
}

// -----------------------------------------------------------------------------
// Public entry point
// -----------------------------------------------------------------------------

/**
 * Differentiate `e` with respect to `wrt`. Returns a new `Value` whose
 * heads are in `DIFF_ADMITTED_HEADS` and whose evaluation under
 * `evalNumericExpr` (with the same env binding `wrt` and any other free
 * variables) equals `df/dx`.
 *
 * Throws `CasDiffOutOfScopeError` if any subterm has an unknown head or
 * an uninterpretable value kind. The tool layer catches and converts to
 * the boundary tag.
 */
export function differentiate(e: Value, wrt: SymbolValue): Value {
  switch (e.kind) {
    case "integer":
    case "rational":
    case "float64":
      return ZERO;
    case "symbol":
      if (DIFF_ADMITTED_CONSTANTS_SET.has(e.name)) return ZERO;
      return symbolEqual(e, wrt) ? ONE : ZERO;
    case "expression":
      return diffExpression(e, wrt);
    case "string":
    case "list":
    case "record":
    case "tagged":
    case "boolean":
      throw new CasDiffOutOfScopeError("value-kind", e.kind);
  }
}

// -----------------------------------------------------------------------------
// Expression dispatch
// -----------------------------------------------------------------------------

function diffExpression(e: ExpressionValue, wrt: SymbolValue): Value {
  if (!DIFF_ADMITTED_HEADS_SET.has(e.head)) {
    throw new CasDiffOutOfScopeError("head", e.head);
  }
  const args = e.args;
  switch (e.head) {
    case "+":
      return mkPlus(args.map((a) => differentiate(a, wrt)));
    case "-":
      // Unary `-(a)` and binary `-(a, b)` are the canonical arities. Higher
      // arities are mathematically `a - b - c - …` (left-fold) but in
      // practice cas-simplify normalises via `+` with negative-coefficient
      // children, so we never see them in canonical pipelines. Reject loudly
      // for n>2 rather than guess: an unexpected n-ary `-` is more likely
      // a calling-convention bug than a deliberate input.
      if (args.length === 1) return mkNeg(differentiate(args[0]!, wrt));
      if (args.length === 2)
        return mkMinus(differentiate(args[0]!, wrt), differentiate(args[1]!, wrt));
      throw new Error(`cas-diff: unexpected arity for "-": ${args.length}`);
    case "neg":
      if (args.length !== 1)
        throw new Error(`cas-diff: "neg" expects 1 arg, got ${args.length}`);
      return mkNeg(differentiate(args[0]!, wrt));
    case "*":
      return productRule(args, wrt);
    case "/":
      if (args.length !== 2)
        throw new Error(`cas-diff: "/" expects 2 args, got ${args.length}`);
      return quotientRule(args[0]!, args[1]!, wrt);
    case "^":
      if (args.length !== 2)
        throw new Error(`cas-diff: "^" expects 2 args, got ${args.length}`);
      return powerRule(args[0]!, args[1]!, wrt);
    case "exp": {
      // d(exp a)/dx = exp(a) · da
      const a = args[0]!;
      const da = differentiate(a, wrt);
      return mkTimes(expr("exp", [a]), da);
    }
    case "log": {
      // d(log a)/dx = da / a
      const a = args[0]!;
      const da = differentiate(a, wrt);
      return mkDiv(da, a);
    }
    case "sin": {
      const a = args[0]!;
      const da = differentiate(a, wrt);
      return mkTimes(expr("cos", [a]), da);
    }
    case "cos": {
      // d(cos a)/dx = -sin(a) · da. We materialise the negative as `neg`
      // (a head in our vocab) rather than `*(-1, sin(a), da)`.
      const a = args[0]!;
      const da = differentiate(a, wrt);
      return mkTimes(mkNeg(expr("sin", [a])), da);
    }
    case "tan": {
      // d(tan a)/dx = da / cos(a)²
      const a = args[0]!;
      const da = differentiate(a, wrt);
      return mkDiv(da, mkPower(expr("cos", [a]), int(2n)));
    }
    case "sqrt": {
      // d(√a)/dx = da / (2·√a)
      const a = args[0]!;
      const da = differentiate(a, wrt);
      return mkDiv(da, mkTimes(int(2n), expr("sqrt", [a])));
    }
    case "abs": {
      // d(|a|)/dx = (a / |a|) · da. The composition (a/|a|) encodes
      // sign(a) in the closed vocabulary; it is undefined at a=0 (matches
      // the underlying mathematics — |x| is not differentiable at 0)
      // but correct on R\{0}, which is the operating regime any caller
      // running the result through evalNumericExpr / quadrature can
      // honour.
      const a = args[0]!;
      const da = differentiate(a, wrt);
      return mkTimes(mkDiv(a, expr("abs", [a])), da);
    }
    // -------------------------------------------------------------------
    // Tier-1 transcendentals (2026-05-04). Domain restrictions are
    // recorded here as comments — they are *not* enforced by cas-diff,
    // which is purely symbolic. Domain violations surface at evaluation
    // time as NaN / ±Infinity, which the integrator / optimiser tag as
    // `non-finite-during-eval` boundary failures (same discipline as
    // `log(negative)` and `1/x at x=0`).
    // -------------------------------------------------------------------
    case "asin": {
      // d(asin(a))/dx = da / √(1 − a²)              (|a| < 1)
      const a = args[0]!;
      const da = differentiate(a, wrt);
      return mkDiv(
        da,
        expr("sqrt", [mkMinus(int(1n), mkPower(a, int(2n)))]),
      );
    }
    case "acos": {
      // d(acos(a))/dx = −da / √(1 − a²)             (|a| < 1)
      const a = args[0]!;
      const da = differentiate(a, wrt);
      return mkDiv(
        mkNeg(da),
        expr("sqrt", [mkMinus(int(1n), mkPower(a, int(2n)))]),
      );
    }
    case "atan": {
      // d(atan(a))/dx = da / (1 + a²)
      const a = args[0]!;
      const da = differentiate(a, wrt);
      return mkDiv(da, mkPlus([int(1n), mkPower(a, int(2n))]));
    }
    case "sinh": {
      // d(sinh(a))/dx = cosh(a) · da
      const a = args[0]!;
      const da = differentiate(a, wrt);
      return mkTimes(expr("cosh", [a]), da);
    }
    case "cosh": {
      // d(cosh(a))/dx = sinh(a) · da   (note: positive, unlike d(cos)/dx)
      const a = args[0]!;
      const da = differentiate(a, wrt);
      return mkTimes(expr("sinh", [a]), da);
    }
    case "tanh": {
      // d(tanh(a))/dx = (1 − tanh(a)²) · da. The textbook identity
      // sech²(a) = 1 − tanh²(a) keeps the derivative expressible in
      // the existing vocabulary without introducing a `sech` head.
      const a = args[0]!;
      const da = differentiate(a, wrt);
      return mkTimes(
        mkMinus(int(1n), mkPower(expr("tanh", [a]), int(2n))),
        da,
      );
    }
    case "asinh": {
      // d(asinh(a))/dx = da / √(1 + a²)             (defined on all R)
      const a = args[0]!;
      const da = differentiate(a, wrt);
      return mkDiv(
        da,
        expr("sqrt", [mkPlus([int(1n), mkPower(a, int(2n))])]),
      );
    }
    case "acosh": {
      // d(acosh(a))/dx = da / √(a² − 1)             (a > 1)
      const a = args[0]!;
      const da = differentiate(a, wrt);
      return mkDiv(
        da,
        expr("sqrt", [mkMinus(mkPower(a, int(2n)), int(1n))]),
      );
    }
    case "atanh": {
      // d(atanh(a))/dx = da / (1 − a²)              (|a| < 1)
      const a = args[0]!;
      const da = differentiate(a, wrt);
      return mkDiv(da, mkMinus(int(1n), mkPower(a, int(2n))));
    }
    case "log2": {
      // d(log₂(a))/dx = da / (a · log(2))   — change-of-base identity
      // log₂(x) = log(x) / log(2). `log` here is natural log (the
      // existing head); `log(2)` evaluates as a constant at numeric
      // eval time.
      const a = args[0]!;
      const da = differentiate(a, wrt);
      return mkDiv(da, mkTimes(a, expr("log", [int(2n)])));
    }
    case "log10": {
      // d(log₁₀(a))/dx = da / (a · log(10))
      const a = args[0]!;
      const da = differentiate(a, wrt);
      return mkDiv(da, mkTimes(a, expr("log", [int(10n)])));
    }
  }
  // Unreachable: head was checked against DIFF_ADMITTED_HEADS_SET above.
  throw new Error(`cas-diff: internal error — unhandled head ${e.head}`);
}

// -----------------------------------------------------------------------------
// Rules that need helper logic
// -----------------------------------------------------------------------------

/**
 * Product rule for `*(f₁, f₂, …, fₙ)`. Standard formula:
 *
 *   d/dx Πfᵢ = Σᵢ f₁·…·(dfᵢ/dx)·…·fₙ
 *
 * Terms whose dfᵢ is exactly zero are dropped (smart-constructed away),
 * so `d(2·x)/dx` collapses cleanly to `2` rather than `0·x + 2·1`.
 *
 * Edge cases:
 *   * 0 factors → derivative of the empty product (1) → 0.
 *   * 1 factor  → trivially the differentiation of that factor.
 */
function productRule(factors: readonly Value[], wrt: SymbolValue): Value {
  if (factors.length === 0) return ZERO;
  if (factors.length === 1) return differentiate(factors[0]!, wrt);
  const terms: Value[] = [];
  for (let i = 0; i < factors.length; i++) {
    const dfi = differentiate(factors[i]!, wrt);
    if (isZero(dfi)) continue;
    const factorList: Value[] = [];
    for (let j = 0; j < factors.length; j++) {
      factorList.push(j === i ? dfi : factors[j]!);
    }
    terms.push(mkTimes(...factorList));
  }
  return mkPlus(terms);
}

/** Quotient rule: `d(a/b) = (da·b − a·db) / b²`. */
function quotientRule(a: Value, b: Value, wrt: SymbolValue): Value {
  const da = differentiate(a, wrt);
  const db = differentiate(b, wrt);
  const num = mkMinus(mkTimes(da, b), mkTimes(a, db));
  const den = mkPower(b, int(2n));
  return mkDiv(num, den);
}

/**
 * Power rule, branching on which side depends on `wrt`:
 *
 *   * neither: d(aᵇ)/dx = 0
 *   * b independent of x: d(aᵇ)/dx = b · a^(b−1) · da    (textbook power rule)
 *   * a independent of x: d(aᵇ)/dx = aᵇ · log(a) · db    (textbook exp rule)
 *   * both depend on x:   d(aᵇ)/dx = aᵇ · (db·log(a) + b·da/a)   (log-chain)
 *
 * The branch ordering matters for output shape: a literal `x²` should
 * emit `2·x` (power rule), not the more verbose log-chain form.
 */
function powerRule(a: Value, b: Value, wrt: SymbolValue): Value {
  const aDep = dependsOn(a, wrt);
  const bDep = dependsOn(b, wrt);
  if (!aDep && !bDep) return ZERO;
  if (!bDep) {
    // Power rule. b is constant in wrt; subtract one cleanly.
    const da = differentiate(a, wrt);
    if (isZero(da)) return ZERO;
    return mkTimes(b, mkPower(a, constantSubtractOne(b)), da);
  }
  if (!aDep) {
    // Exp rule. a is constant in wrt.
    const db = differentiate(b, wrt);
    if (isZero(db)) return ZERO;
    return mkTimes(mkPower(a, b), expr("log", [a]), db);
  }
  // General log-chain: d(aᵇ)/dx = aᵇ · (db·log(a) + b·da/a). Requires
  // a > 0 for log(a) to be real-valued; if a caller integrates the
  // result, evalNumericExpr will produce NaN for non-positive a, which
  // surfaces honestly as `non-finite-during-eval` at the integrator.
  const da = differentiate(a, wrt);
  const db = differentiate(b, wrt);
  const logTerm = mkTimes(db, expr("log", [a]));
  const ratioTerm = mkDiv(mkTimes(b, da), a);
  return mkTimes(mkPower(a, b), mkPlus([logTerm, ratioTerm]));
}

// -----------------------------------------------------------------------------
// Symbol / dependency helpers
// -----------------------------------------------------------------------------

function symbolEqual(a: SymbolValue, b: SymbolValue): boolean {
  if (a.name !== b.name) return false;
  // Symbols have an optional `namespace` field; absence and presence are
  // treated as distinct (a bare symbol is not the same identifier as a
  // namespaced one with the same name).
  const ans = a.namespace ?? null;
  const bns = b.namespace ?? null;
  return ans === bns;
}

/**
 * Recursively decide whether `v` references `wrt` anywhere in its
 * structure. Used by `powerRule` to pick the right branch. Walks every
 * Value kind — including list / record / tagged for completeness, even
 * though `differentiate` itself refuses those at top level. Hitting one
 * here means the caller embedded a non-arithmetic value inside an
 * expression, which `differentiate` will refuse on the recursive call;
 * `dependsOn` answers "does this subtree mention wrt" without committing
 * to whether differentiation will succeed.
 */
function dependsOn(v: Value, wrt: SymbolValue): boolean {
  switch (v.kind) {
    case "integer":
    case "rational":
    case "float64":
    case "string":
    case "boolean":
      return false;
    case "symbol":
      return symbolEqual(v, wrt);
    case "expression":
      return v.args.some((a) => dependsOn(a, wrt));
    case "list":
      return v.items.some((i) => dependsOn(i, wrt));
    case "record":
      return Object.values(v.fields).some((f) => dependsOn(f, wrt));
    case "tagged":
      return dependsOn(v.payload, wrt);
  }
}

// -----------------------------------------------------------------------------
// Smart constructors
// -----------------------------------------------------------------------------
//
// These are the local-identity collapses cas-diff applies as the rule
// table runs. They are NOT a substitute for cas-simplify — they only
// recognise the trivial patterns the chain rule produces in surplus
// (multiplication by 1, addition of 0, x¹, x⁰, neg(neg(·)), …). The
// motivation is reader-facing: `d(x²)/dx` should print as `2·x`, not
// `2·x^(2-1)·1`, even before cas-simplify runs.

const ZERO: Value = int(0n);
const ONE: Value = int(1n);

function isZero(v: Value): boolean {
  if (v.kind === "integer") return v.value === "0";
  if (v.kind === "rational") return v.num === "0";
  if (v.kind === "float64") return float64ToNumber(v) === 0;
  return false;
}

function isOne(v: Value): boolean {
  if (v.kind === "integer") return v.value === "1";
  if (v.kind === "rational") return v.num === "1" && v.den === "1";
  if (v.kind === "float64") return float64ToNumber(v) === 1;
  return false;
}

function mkPlus(args: readonly Value[]): Value {
  const filtered = args.filter((a) => !isZero(a));
  if (filtered.length === 0) return ZERO;
  if (filtered.length === 1) return filtered[0]!;
  return expr("+", filtered);
}

function mkMinus(a: Value, b: Value): Value {
  if (isZero(b)) return a;
  if (isZero(a)) return mkNeg(b);
  return expr("-", [a, b]);
}

function mkNeg(a: Value): Value {
  if (isZero(a)) return ZERO;
  if (a.kind === "expression" && a.head === "neg" && a.args.length === 1) {
    return a.args[0]!;
  }
  return expr("neg", [a]);
}

function mkTimes(...args: Value[]): Value {
  const flat: Value[] = [];
  for (const a of args) {
    if (isZero(a)) return ZERO;
    if (isOne(a)) continue;
    flat.push(a);
  }
  if (flat.length === 0) return ONE;
  if (flat.length === 1) return flat[0]!;
  return expr("*", flat);
}

function mkDiv(a: Value, b: Value): Value {
  if (isZero(a)) return ZERO;
  if (isOne(b)) return a;
  return expr("/", [a, b]);
}

function mkPower(base: Value, exponent: Value): Value {
  if (isZero(exponent)) return ONE;
  if (isOne(exponent)) return base;
  return expr("^", [base, exponent]);
}

/**
 * Produce `b - 1` in the most natural form, used by the power rule
 * when `b` is constant in `wrt`. Integer / rational stay in their own
 * form (so `d(x²)/dx → 2·x`, not `2·x^(2−1)`); float64 and arbitrary
 * expressions fall back to a literal `(b - 1)` subtree.
 */
function constantSubtractOne(b: Value): Value {
  if (b.kind === "integer") return int(BigInt(b.value) - 1n);
  if (b.kind === "rational") {
    const n = BigInt(b.num);
    const d = BigInt(b.den);
    return rat(n - d, d);
  }
  return expr("-", [b, int(1n)]);
}
