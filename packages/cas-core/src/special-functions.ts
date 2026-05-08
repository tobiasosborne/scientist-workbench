// =============================================================================
// special-functions.ts — closed special-function vocabulary for the cas-core AST
// =============================================================================
//
// The elementary AST in `diff.ts` admits the closed numerical
// vocabulary that aligns with `@workbench/quadrature`'s
// `evalNumericExpr`: `+ - * / ^ neg exp sin cos tan log sqrt abs`,
// inverse / hyperbolic trig, `log2 / log10`, and the constants `pi /
// e`. That vocabulary is the right scope for `cas-diff` /
// `integrate-1d` / `optimize-lbfgs-projected` / `integrate-ode-*` —
// anything an agent can pipe to a float64 numerical evaluator.
//
// Problem 13 (Meijer G mega-test) drives the next layer of the
// workbench: the symbolic dispatcher (Adamchik–Marichev + Roach
// reduction rules; bead `hv0.6`) and the asymptotic layer (Braaksma +
// Olde Daalhuis–Olver; `hv0.9`). Both layers work on a *broader* AST
// that names the special functions they reduce *to* and *from* —
// `Gamma`, `BesselJ`, `HypergeometricPFQ`, `MeijerG`, etc. This module
// is the canonical declaration of that broader vocabulary.
//
// ADR-0023 is the design document. This file is its implementation.
//
// Three concerns
// --------------
// 1. **Vocabulary table.** `SPECIAL_FUNCTION_HEADS` enumerates every
//    head admitted as a special-function AST node. Closed, exhaustive,
//    sorted by problem-13 reduction-table relevance. Future expansions
//    require a new ADR + a deliberate edit here, never silent runtime
//    registration.
//
// 2. **Arity contracts.** `specialFunctionArity(head)` returns the
//    expected shape of the head's argument list. Three cases:
//    `fixed { count: n }` for plain n-argument heads (`Gamma(z)`,
//    `BesselJ(ν, z)`, `WhittakerM(k, m, z)`), and `list-head` for the
//    Wolfram-encoded list-parameter heads (`HypergeometricPFQ` is
//    `(list, list, scalar)`; `MeijerG` is
//    `(list-of-list, list-of-list, scalar)`). Unknown heads return
//    `null`. Consumers (the symbolic dispatcher, the asymptotic
//    expansion layer, future arbprec evaluators) call this to validate
//    inputs at their boundary.
//
// 3. **Diff dispatcher.** `differentiateSpecialFunction(head, args,
//    wrt, recurDiff)` is `cas-diff`'s extension point. For every head
//    in `SPECIAL_FUNCTION_DIFFERENTIABLE_HEADS` (the ADR-0023 v0.1
//    subset) it returns a closed-form derivative. For heads in
//    `SPECIAL_FUNCTION_HEADS` *but not* in the differentiable subset,
//    it returns `null` — the caller (`diff.ts`'s `diffExpression`) maps
//    null to the same `CasDiffOutOfScopeError` foreign heads take, and
//    `tools/cas-diff` wraps that into the existing
//    `tagged "cas-diff/out-of-scope"` boundary tag. Honest scope: the
//    head is recognised in the AST; cas-diff is honest about which
//    rules are shipped.
//
// Why a callback for `recurDiff`
// -------------------------------
// `differentiate` (in `diff.ts`) and `differentiateSpecialFunction`
// (here) form a recursive pair. Importing `differentiate` directly
// here would create a circular module dependency that, while TS
// usually resolves, is a code smell — the wrong direction of
// dependency for a vocabulary table to point back at the diff engine.
// The callback inverts the dependency: special-functions has no
// import of diff, only the smart-constructor helpers used by diff
// rules generally.
//
// Diff-rule output is in the same closed vocabulary
// -------------------------------------------------
// Bessel rules emit Bessel; Erf/Erfc/Fresnel/ExpIntegralEi/ExpIntegralE
// rules emit elementary heads (`exp`, `cos`, `sin`, `*`, `/`, `^`).
// Both are admissible — when cas-diff recurs through a Bessel
// derivative result, the dispatcher fires again on the new BesselJ
// node. The output is well-formed AST, recursively differentiable.

import {
  expr,
  int,
  rat,
  sym,
  type SymbolValue,
  type Value,
} from "@workbench/protocol";
import {
  isZero,
  mkDiv,
  mkMinus,
  mkNeg,
  mkPlus,
  mkPower,
  mkTimes,
  ZERO,
} from "./diff.js";

// -----------------------------------------------------------------------------
// Vocabulary table
// -----------------------------------------------------------------------------

/**
 * The closed special-function vocabulary admitted by `cas-core`'s
 * AST. ADR-0023 §"Decision" pins the contents. Order is by
 * problem-13 reduction-table relevance, not alphabetical, so a
 * reader scans the table the same way they scan the reduction-table
 * sources (Gamma family first, then Bessel family, then PFQ /
 * Whittaker / orthogonal-polynomial-and-relative families, then the
 * `MeijerG` recursive head last).
 */
export const SPECIAL_FUNCTION_HEADS: readonly string[] = [
  // Gamma family.
  "Gamma",
  "Digamma",
  "Polygamma",
  // Bessel family.
  "BesselJ",
  "BesselY",
  "BesselI",
  "BesselK",
  // Generalised hypergeometric.
  "HypergeometricPFQ",
  // Confluent (Whittaker) and parabolic-cylinder.
  "WhittakerM",
  "WhittakerW",
  "ParabolicCylinderD",
  // Error / exponential / Fresnel integrals.
  "Erf",
  "Erfc",
  "ExpIntegralEi",
  "ExpIntegralE",
  "FresnelC",
  "FresnelS",
  // Legendre.
  "LegendreP",
  "LegendreQ",
  // Other classical orthogonal polynomials.
  "LaguerreL",
  "HermiteH",
  "ChebyshevT",
  "ChebyshevU",
  "GegenbauerC",
  // Polylog / Lerch.
  "Polylog",
  "LerchPhi",
  // The recursive head MeijerG dispatches *to*.
  "MeijerG",
];

const SPECIAL_FUNCTION_HEADS_SET = new Set(SPECIAL_FUNCTION_HEADS);

/**
 * Heads with a closed-form derivative shipped in v0.1 (ADR-0023
 * §"Decision"). Heads in `SPECIAL_FUNCTION_HEADS` but absent here
 * refuse via the existing boundary tag. New rules ship via additional
 * ADRs and additive edits to `differentiateSpecialFunction`.
 */
export const SPECIAL_FUNCTION_DIFFERENTIABLE_HEADS: readonly string[] = [
  "Gamma",
  "Digamma",
  "Polygamma",
  "Erf",
  "Erfc",
  "ExpIntegralEi",
  "ExpIntegralE",
  "FresnelC",
  "FresnelS",
  "BesselJ",
  "BesselY",
  "BesselI",
  "BesselK",
  "HermiteH",
  "Polylog",
];

// -----------------------------------------------------------------------------
// Arity contracts
// -----------------------------------------------------------------------------

/**
 * The shape of a head's argument list.
 *
 *   * `fixed` — exactly `count` arguments, each an arbitrary Value.
 *     Most heads use this (Gamma: 1; BesselJ: 2; WhittakerM: 3).
 *
 *   * `list-head` — for heads whose first / second positions are
 *     themselves lists of parameters (Wolfram convention). Each
 *     entry of `argShapes` describes the corresponding positional
 *     argument: `"scalar"` is any Value; `"list"` is a list Value;
 *     `"list-of-list"` is a list of list Values (the Mathematica
 *     `MeijerG` encoding has two such positions).
 */
export type SpecialFunctionArity =
  | { shape: "fixed"; count: number }
  | {
      shape: "list-head";
      argShapes: readonly ("scalar" | "list" | "list-of-list")[];
    };

const ARITY_TABLE: Readonly<Record<string, SpecialFunctionArity>> = {
  Gamma: { shape: "fixed", count: 1 },
  Digamma: { shape: "fixed", count: 1 },
  Polygamma: { shape: "fixed", count: 2 },
  BesselJ: { shape: "fixed", count: 2 },
  BesselY: { shape: "fixed", count: 2 },
  BesselI: { shape: "fixed", count: 2 },
  BesselK: { shape: "fixed", count: 2 },
  HypergeometricPFQ: {
    shape: "list-head",
    argShapes: ["list", "list", "scalar"],
  },
  WhittakerM: { shape: "fixed", count: 3 },
  WhittakerW: { shape: "fixed", count: 3 },
  ParabolicCylinderD: { shape: "fixed", count: 2 },
  Erf: { shape: "fixed", count: 1 },
  Erfc: { shape: "fixed", count: 1 },
  ExpIntegralEi: { shape: "fixed", count: 1 },
  ExpIntegralE: { shape: "fixed", count: 2 },
  FresnelC: { shape: "fixed", count: 1 },
  FresnelS: { shape: "fixed", count: 1 },
  LegendreP: { shape: "fixed", count: 2 },
  LegendreQ: { shape: "fixed", count: 2 },
  LaguerreL: { shape: "fixed", count: 2 },
  HermiteH: { shape: "fixed", count: 2 },
  ChebyshevT: { shape: "fixed", count: 2 },
  ChebyshevU: { shape: "fixed", count: 2 },
  GegenbauerC: { shape: "fixed", count: 3 },
  Polylog: { shape: "fixed", count: 2 },
  LerchPhi: { shape: "fixed", count: 3 },
  MeijerG: {
    shape: "list-head",
    argShapes: ["list-of-list", "list-of-list", "scalar"],
  },
};

/**
 * Return the arity contract for `head`, or `null` if `head` is not a
 * recognised special-function head. Consumers validate at their
 * boundary; nothing in this file enforces the contract automatically
 * (the value protocol's `expression { head, args }` is permissive by
 * design — ADR-0004 — and arity policy belongs to the head's semantic
 * dispatcher, not to the AST itself).
 */
export function specialFunctionArity(head: string): SpecialFunctionArity | null {
  if (!SPECIAL_FUNCTION_HEADS_SET.has(head)) return null;
  return ARITY_TABLE[head] ?? null;
}

// -----------------------------------------------------------------------------
// Integer-shift helper for parameter-recurrence rules
// -----------------------------------------------------------------------------
//
// The Bessel / orthogonal-polynomial / Polylog / ExpIntegralE rules
// shift an order parameter by a small integer (`ν ± 1`, `n − 1`,
// `s − 1`). When the parameter is itself an `integer` or `rational`
// Value we want the result in canonical numeric form; when it is
// symbolic or a complex sub-expression, we emit `expr("+", ...)` or
// `expr("-", ...)` and let downstream simplification take it from
// there. The smart fallback keeps `d/dz J_3(z)` printing as
// `(J_2(z) − J_4(z))/2` — not `(J_{3-1}(z) − J_{3+1}(z))/2` — even
// before any cas-simplify pass.

function intShift(v: Value, k: bigint): Value {
  if (k === 0n) return v;
  if (v.kind === "integer") {
    return int(BigInt(v.value) + k);
  }
  if (v.kind === "rational") {
    const num = BigInt(v.num);
    const den = BigInt(v.den);
    return rat(num + k * den, den);
  }
  // Symbolic / float64 / expression — emit an additive expression.
  if (k > 0n) return expr("+", [v, int(k)]);
  return expr("-", [v, int(-k)]);
}

// -----------------------------------------------------------------------------
// Diff-rule dispatcher
// -----------------------------------------------------------------------------

type RecurDiff = (e: Value, wrt: SymbolValue) => Value;

/**
 * Dispatch a special-function diff rule for `head(args)` with respect
 * to `wrt`. Returns the derivative `Value`, or `null` if the head is
 * recognised but no rule is shipped in v0.1.
 *
 * Discrete-order parameters (`n` in `Polygamma(n, z)`,
 * `BesselJ(ν, z)`, `HermiteH(n, z)`, `Polylog(s, z)`,
 * `ExpIntegralE(n, z)`) are *not* differentiated in v0.1 — if the
 * caller asks for `d/dν J_ν(z)` and `ν` depends on `wrt`, the rule
 * refuses (returns null). Closed-form parameter-derivative rules
 * exist (e.g. `∂J/∂ν` involves Polygamma) but their landing belongs
 * to a future bead.
 */
export function differentiateSpecialFunction(
  head: string,
  args: readonly Value[],
  wrt: SymbolValue,
  recurDiff: RecurDiff,
): Value | null {
  switch (head) {
    case "Gamma":
      return ruleGamma(args, wrt, recurDiff);
    case "Digamma":
      return ruleDigamma(args, wrt, recurDiff);
    case "Polygamma":
      return rulePolygamma(args, wrt, recurDiff);
    case "Erf":
      return ruleErf(args, wrt, recurDiff, /*sign=*/ 1);
    case "Erfc":
      return ruleErf(args, wrt, recurDiff, /*sign=*/ -1);
    case "ExpIntegralEi":
      return ruleExpIntegralEi(args, wrt, recurDiff);
    case "ExpIntegralE":
      return ruleExpIntegralE(args, wrt, recurDiff);
    case "FresnelC":
      return ruleFresnel(args, wrt, recurDiff, /*kind=*/ "cos");
    case "FresnelS":
      return ruleFresnel(args, wrt, recurDiff, /*kind=*/ "sin");
    case "BesselJ":
    case "BesselY":
      return ruleBesselFirstKind(head, args, wrt, recurDiff);
    case "BesselI":
      return ruleBesselI(args, wrt, recurDiff);
    case "BesselK":
      return ruleBesselK(args, wrt, recurDiff);
    case "HermiteH":
      return ruleHermiteH(args, wrt, recurDiff);
    case "Polylog":
      return rulePolylog(args, wrt, recurDiff);
    default:
      return null;
  }
}

// -----------------------------------------------------------------------------
// Per-head rule bodies
// -----------------------------------------------------------------------------
//
// Convention: every rule that takes a chain-rule argument `z`
// short-circuits when `dz = recurDiff(z, wrt)` is zero. This both
// matches the diff.ts smart-constructor's `mkTimes(_, 0) → 0`
// behaviour and avoids emitting a no-op derivative shape (e.g.,
// `d/dw Γ(z)` when `w ≠ z` returns `0` directly rather than
// `ψ(z)·Γ(z) · 0`).
//
// Per-rule discrete-parameter discipline: every rule that has a
// non-z parameter (`n`, `ν`, `s`) checks whether the parameter
// depends on `wrt`. If it does, the rule refuses (`null`). v0.1
// assumes discrete parameters are constant in `wrt`.

function arityCheck(args: readonly Value[], expected: number, head: string): void {
  if (args.length !== expected) {
    throw new Error(
      `differentiateSpecialFunction: ${head} expects ${expected} args, got ${args.length}`,
    );
  }
}

function dependsOnWrt(v: Value, wrt: SymbolValue, recurDiff: RecurDiff): boolean {
  // We use the diff engine itself to decide dependency: if the
  // derivative is non-zero, the value depends on wrt. This is
  // strictly correct for any value the diff engine handles, and for
  // the parameter Values appearing in special-function arguments
  // (integers, rationals, symbols, and expressions of those) every
  // case is in-scope. If a parameter is itself out-of-scope (e.g. a
  // tagged value), recurDiff throws, which surfaces honestly.
  return !isZero(recurDiff(v, wrt));
}

// d/dz Γ(z) = ψ(z) · Γ(z)         — DLMF §5.4.2
function ruleGamma(
  args: readonly Value[],
  wrt: SymbolValue,
  recurDiff: RecurDiff,
): Value | null {
  arityCheck(args, 1, "Gamma");
  const z = args[0]!;
  const dz = recurDiff(z, wrt);
  if (isZero(dz)) return ZERO;
  return mkTimes(
    mkTimes(expr("Digamma", [z]), expr("Gamma", [z])),
    dz,
  );
}

// d/dz ψ(z) = ψ⁽¹⁾(z) = Polygamma(1, z)   — DLMF §5.7.1
function ruleDigamma(
  args: readonly Value[],
  wrt: SymbolValue,
  recurDiff: RecurDiff,
): Value | null {
  arityCheck(args, 1, "Digamma");
  const z = args[0]!;
  const dz = recurDiff(z, wrt);
  if (isZero(dz)) return ZERO;
  return mkTimes(expr("Polygamma", [int(1n), z]), dz);
}

// d/dz ψ⁽ⁿ⁾(z) = ψ⁽ⁿ⁺¹⁾(z) when var = z   — DLMF §5.15.3
// d/dn refuses (n is a discrete order).
function rulePolygamma(
  args: readonly Value[],
  wrt: SymbolValue,
  recurDiff: RecurDiff,
): Value | null {
  arityCheck(args, 2, "Polygamma");
  const n = args[0]!;
  const z = args[1]!;
  if (dependsOnWrt(n, wrt, recurDiff)) return null;
  const dz = recurDiff(z, wrt);
  if (isZero(dz)) return ZERO;
  return mkTimes(expr("Polygamma", [intShift(n, 1n), z]), dz);
}

// d/dz erf(z) =  2/√π · exp(-z²)     — DLMF §7.7.1
// d/dz erfc(z) = -2/√π · exp(-z²)
//
// `sign = +1` for Erf, `-1` for Erfc. The `2/√π` prefactor stays
// expressible in the elementary vocabulary so the result composes
// downstream without requiring new heads.
function ruleErf(
  args: readonly Value[],
  wrt: SymbolValue,
  recurDiff: RecurDiff,
  sign: 1 | -1,
): Value | null {
  arityCheck(args, 1, sign === 1 ? "Erf" : "Erfc");
  const z = args[0]!;
  const dz = recurDiff(z, wrt);
  if (isZero(dz)) return ZERO;
  const twoOverSqrtPi = mkDiv(int(2n), expr("sqrt", [sym("pi")]));
  const prefactor = sign === 1 ? twoOverSqrtPi : mkNeg(twoOverSqrtPi);
  const expFactor = expr("exp", [mkNeg(mkPower(z, int(2n)))]);
  return mkTimes(mkTimes(prefactor, expFactor), dz);
}

// d/dz Ei(z) = exp(z) / z   — DLMF §6.2.6
function ruleExpIntegralEi(
  args: readonly Value[],
  wrt: SymbolValue,
  recurDiff: RecurDiff,
): Value | null {
  arityCheck(args, 1, "ExpIntegralEi");
  const z = args[0]!;
  const dz = recurDiff(z, wrt);
  if (isZero(dz)) return ZERO;
  return mkTimes(mkDiv(expr("exp", [z]), z), dz);
}

// d/dz E_n(z) = -E_{n-1}(z) when var = z   — DLMF §8.19.13
// d/dn refuses (n is the discrete order).
function ruleExpIntegralE(
  args: readonly Value[],
  wrt: SymbolValue,
  recurDiff: RecurDiff,
): Value | null {
  arityCheck(args, 2, "ExpIntegralE");
  const n = args[0]!;
  const z = args[1]!;
  if (dependsOnWrt(n, wrt, recurDiff)) return null;
  const dz = recurDiff(z, wrt);
  if (isZero(dz)) return ZERO;
  return mkTimes(
    mkNeg(expr("ExpIntegralE", [intShift(n, -1n), z])),
    dz,
  );
}

// d/dz C(z) = cos(π·z²/2),  d/dz S(z) = sin(π·z²/2)   — DLMF §7.2.7
function ruleFresnel(
  args: readonly Value[],
  wrt: SymbolValue,
  recurDiff: RecurDiff,
  kind: "cos" | "sin",
): Value | null {
  arityCheck(args, 1, kind === "cos" ? "FresnelC" : "FresnelS");
  const z = args[0]!;
  const dz = recurDiff(z, wrt);
  if (isZero(dz)) return ZERO;
  const arg = mkDiv(
    mkTimes(sym("pi"), mkPower(z, int(2n))),
    int(2n),
  );
  return mkTimes(expr(kind, [arg]), dz);
}

// d/dz J_ν(z) = (J_{ν-1}(z) − J_{ν+1}(z)) / 2   — DLMF §10.6.1
// d/dz Y_ν(z) — same shape (DLMF §10.6.1).
// Discrete order ν refuses.
function ruleBesselFirstKind(
  head: string,
  args: readonly Value[],
  wrt: SymbolValue,
  recurDiff: RecurDiff,
): Value | null {
  arityCheck(args, 2, head);
  const nu = args[0]!;
  const z = args[1]!;
  if (dependsOnWrt(nu, wrt, recurDiff)) return null;
  const dz = recurDiff(z, wrt);
  if (isZero(dz)) return ZERO;
  return mkTimes(
    mkDiv(
      mkMinus(
        expr(head, [intShift(nu, -1n), z]),
        expr(head, [intShift(nu, 1n), z]),
      ),
      int(2n),
    ),
    dz,
  );
}

// d/dz I_ν(z) = (I_{ν-1}(z) + I_{ν+1}(z)) / 2   — DLMF §10.29.1
function ruleBesselI(
  args: readonly Value[],
  wrt: SymbolValue,
  recurDiff: RecurDiff,
): Value | null {
  arityCheck(args, 2, "BesselI");
  const nu = args[0]!;
  const z = args[1]!;
  if (dependsOnWrt(nu, wrt, recurDiff)) return null;
  const dz = recurDiff(z, wrt);
  if (isZero(dz)) return ZERO;
  return mkTimes(
    mkDiv(
      mkPlus([
        expr("BesselI", [intShift(nu, -1n), z]),
        expr("BesselI", [intShift(nu, 1n), z]),
      ]),
      int(2n),
    ),
    dz,
  );
}

// d/dz K_ν(z) = -(K_{ν-1}(z) + K_{ν+1}(z)) / 2   — DLMF §10.29.1
function ruleBesselK(
  args: readonly Value[],
  wrt: SymbolValue,
  recurDiff: RecurDiff,
): Value | null {
  arityCheck(args, 2, "BesselK");
  const nu = args[0]!;
  const z = args[1]!;
  if (dependsOnWrt(nu, wrt, recurDiff)) return null;
  const dz = recurDiff(z, wrt);
  if (isZero(dz)) return ZERO;
  return mkTimes(
    mkNeg(
      mkDiv(
        mkPlus([
          expr("BesselK", [intShift(nu, -1n), z]),
          expr("BesselK", [intShift(nu, 1n), z]),
        ]),
        int(2n),
      ),
    ),
    dz,
  );
}

// d/dz H_n(z) = 2n · H_{n-1}(z) when var = z   — DLMF §18.9.27
// Discrete order n refuses.
function ruleHermiteH(
  args: readonly Value[],
  wrt: SymbolValue,
  recurDiff: RecurDiff,
): Value | null {
  arityCheck(args, 2, "HermiteH");
  const n = args[0]!;
  const z = args[1]!;
  if (dependsOnWrt(n, wrt, recurDiff)) return null;
  const dz = recurDiff(z, wrt);
  if (isZero(dz)) return ZERO;
  return mkTimes(
    mkTimes(
      mkTimes(int(2n), n),
      expr("HermiteH", [intShift(n, -1n), z]),
    ),
    dz,
  );
}

// d/dz Li_s(z) = Li_{s-1}(z) / z when var = z   — DLMF §25.12.4
// Discrete order s refuses.
function rulePolylog(
  args: readonly Value[],
  wrt: SymbolValue,
  recurDiff: RecurDiff,
): Value | null {
  arityCheck(args, 2, "Polylog");
  const s = args[0]!;
  const z = args[1]!;
  if (dependsOnWrt(s, wrt, recurDiff)) return null;
  const dz = recurDiff(z, wrt);
  if (isZero(dz)) return ZERO;
  return mkTimes(
    mkDiv(expr("Polylog", [intShift(s, -1n), z]), z),
    dz,
  );
}
