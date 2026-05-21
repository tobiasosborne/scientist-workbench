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
// Bessel rules emit Bessel; Erf/Erfc/Erfi/Fresnel/ExpIntegralEi/
// ExpIntegralE rules emit elementary heads (`exp`, `cos`, `sin`, `*`,
// `/`, `^`). Both are admissible — when cas-diff recurs through a
// Bessel derivative result, the dispatcher fires again on the new
// BesselJ node. The output is well-formed AST, recursively
// differentiable.
//
// Amendments
// ----------
// 2026-05-16 (ADR-0040 §"Decision 6"; bead `m114`): vocabulary table
// grew 27 → 28 by admitting `Erfi` — the per-head substrate this ADR
// pins for the Erf family needs `Erfi` as a first-class head (the
// canonical Meijer-G forward table R4 §1 covers `Erf`, `Erfc`, and
// `Erfi` symmetrically). Diff rule `d/dz Erfi(z) = (2/√π)·exp(z²)`
// per DLMF §7.10.2.
//
// 2026-05-17 (ADR-0041 §"Decision 6"; bead `vsvl`): vocabulary table
// grew 28 → 32 by admitting the four cleanly-disambiguated Bessel
// boundary heads — `HankelH1`, `HankelH2`, `SphericalBesselJ`,
// `SphericalBesselY` — per the per-head substrate prototype #2 (Bessel
// family). Each passes the Erfi precedent test of R1 §13: a substrate-
// level pattern table can dispatch on the head non-redundantly (Hankel
// avoids `J + i·Y` cancellation loss in the upper half-plane; spherical
// Bessel is the load-bearing physics encoding for Mie scattering,
// quantum partial-wave decomposition, and gravitational-wave spherical
// harmonic expansions). All four are fixed-2 arity. Diff rules per
// DLMF §10.6.1 (Hankel: same shape as cylinder Bessel) and DLMF
// §10.51.2 (spherical: asymmetric ascent form `j_{n-1} - (n+1)/z · j_n`
// — see `ruleHankel` and `ruleSphericalBesselFirstKind` below for the
// canonical-form rationale). `SphericalBesselI` and `SphericalBesselK`
// are deferred pending a clean resolution of the DLMF §10.47.7-8
// `i^{(1)}` / `i^{(2)}` convention ambiguity (filed as P3 follow-up;
// the cas-core AST cannot represent "this is one of two distinct
// spherical-modified-Bessel functions" without a tag-disambiguator the
// substrate doesn't yet support).
//
// 2026-05-19 (ADR-0042 §"Decision 6"; bead `scientist-workbench-mozz`):
// vocabulary table grew 32 → 38 by admitting six Gamma-family heads —
// `LogGamma`, `Pochhammer`, `IncompleteGammaUpper`,
// `IncompleteGammaLower`, `Beta`, `BarnesG` — as the substrate
// prototype #3 (Gamma family). Each passes the Erfi-precedent test of
// R1 §1 (per the gamma-research artefact at
// `docs/refs/gamma-research/R1-symbolic-identities.md`): `LogGamma`
// carries principal-value semantics that `log(Gamma(z))` does not
// (multi-valued for `z ∉ ℝ₊`); `Pochhammer` is a first-class argument
// in `HypergeometricPFQ` and every hypergeometric identity;
// `IncompleteGammaUpper` / `Lower` are the primary DLMF Chapter 8
// objects with independent diff rules and Meijer-G forms (DLMF
// §8.6.10-11; ADR-0042 §"Decision 5"); `Beta` is canonical in DLMF
// §5.12 with direct diff rules; `BarnesG` is an entire function of
// order 2 with `G(z+1) = Γ(z)·G(z)` (DLMF §5.17.1) load-bearing for
// random-matrix-theory determinant formulae. Diff rules per DLMF
// §5.2.2 (`LogGamma`), §8.8.1 / §8.8.2 (incomplete-gamma w.r.t. z),
// §5.12.2 (`Beta` w.r.t. either argument). `BarnesG` and `Pochhammer`
// diff rules and the `Beta` partial w.r.t. the *other* argument (chain-
// rule case) are honest refusals in v0.1 — see `ruleBarnesG`,
// `rulePochhammer`, and `ruleBeta` below for the deferred-rule
// rationale. `IncompleteGammaP` and `IncompleteGammaQ` are
// deliberately NOT admitted as vocabulary heads (ADR-0042 §"Tension
// Resolution A"; §"Decision 4"): they are derivable from
// Upper / Lower divided by `Gamma`, and any v0.1 symbolic rule for
// them follows by dividing existing Upper / Lower rules. The float64
// evaluator admits P / Q as dispatcher entries for numerical
// stability, but the cas-core vocabulary carries only the primitives.

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
  // Gamma family extensions — admitted 2026-05-19 per ADR-0042 §"Decision 6"
  // (R1 §1 / §2.2-§2.8). `LogGamma` carries principal-value semantics;
  // `Pochhammer` is a first-class argument in hypergeometric identities;
  // `IncompleteGammaUpper / Lower` have canonical Meijer-G forms (the only
  // Gamma-family heads that do — see ADR-0042 §"Decision 5"); `Beta` is the
  // canonical DLMF §5.12 object; `BarnesG` is the load-bearing RMT
  // determinant-formula function with `G(z+1) = Γ(z)·G(z)`.
  "LogGamma",
  "Pochhammer",
  "IncompleteGammaUpper",
  "IncompleteGammaLower",
  "Beta",
  "BarnesG",
  // Bessel family.
  "BesselJ",
  "BesselY",
  "BesselI",
  "BesselK",
  // Bessel family boundary — Hankel (cylinder, complex-valued: H¹ = J + i·Y,
  // H² = J − i·Y) and spherical Bessel (= √(π/(2z))·J_{n+1/2}, etc.).
  // Admitted 2026-05-17 per ADR-0041 §"Decision 6" (R1 §13).
  "HankelH1",
  "HankelH2",
  "SphericalBesselJ",
  "SphericalBesselY",
  // Generalised hypergeometric.
  "HypergeometricPFQ",
  // Confluent (Whittaker) and parabolic-cylinder.
  "WhittakerM",
  "WhittakerW",
  "ParabolicCylinderD",
  // Error / exponential / Fresnel integrals.
  "Erf",
  "Erfc",
  "Erfi",
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
  // Gamma extensions (ADR-0042 §"Decision 6"): four of the six new heads
  // ship a v0.1 closed-form diff rule. `Pochhammer` (discrete order n;
  // derivative w.r.t. `a` deferred to v0.2) and `BarnesG` (rule
  // `(z-1)·Digamma(z) - LogGamma(z) + const` from R1 §2.8, deferred
  // to v0.2 — composite of two Gamma-family heads with a non-trivial
  // additive constant) are absent here and refuse honestly via the
  // existing boundary tag.
  "LogGamma",
  "IncompleteGammaUpper",
  "IncompleteGammaLower",
  "Beta",
  "Erf",
  "Erfc",
  "Erfi",
  "ExpIntegralEi",
  "ExpIntegralE",
  "FresnelC",
  "FresnelS",
  "BesselJ",
  "BesselY",
  "BesselI",
  "BesselK",
  "HankelH1",
  "HankelH2",
  "SphericalBesselJ",
  "SphericalBesselY",
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
  // Gamma extensions (ADR-0042 §"Decision 6"; bead `mozz`). Three fixed-1
  // (`LogGamma`, `BarnesG`) and three fixed-2 (`Pochhammer(a, n)`,
  // `IncompleteGammaUpper(a, z)`, `IncompleteGammaLower(a, z)`, `Beta(a, b)`).
  LogGamma: { shape: "fixed", count: 1 },
  Pochhammer: { shape: "fixed", count: 2 },
  IncompleteGammaUpper: { shape: "fixed", count: 2 },
  IncompleteGammaLower: { shape: "fixed", count: 2 },
  Beta: { shape: "fixed", count: 2 },
  BarnesG: { shape: "fixed", count: 1 },
  BesselJ: { shape: "fixed", count: 2 },
  BesselY: { shape: "fixed", count: 2 },
  BesselI: { shape: "fixed", count: 2 },
  BesselK: { shape: "fixed", count: 2 },
  HankelH1: { shape: "fixed", count: 2 },
  HankelH2: { shape: "fixed", count: 2 },
  SphericalBesselJ: { shape: "fixed", count: 2 },
  SphericalBesselY: { shape: "fixed", count: 2 },
  HypergeometricPFQ: {
    shape: "list-head",
    argShapes: ["list", "list", "scalar"],
  },
  WhittakerM: { shape: "fixed", count: 3 },
  WhittakerW: { shape: "fixed", count: 3 },
  ParabolicCylinderD: { shape: "fixed", count: 2 },
  Erf: { shape: "fixed", count: 1 },
  Erfc: { shape: "fixed", count: 1 },
  Erfi: { shape: "fixed", count: 1 },
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
    case "LogGamma":
      return ruleLogGamma(args, wrt, recurDiff);
    case "Pochhammer":
      return rulePochhammer(args, wrt, recurDiff);
    case "IncompleteGammaUpper":
      return ruleIncompleteGamma(args, wrt, recurDiff, /*sign=*/ -1);
    case "IncompleteGammaLower":
      return ruleIncompleteGamma(args, wrt, recurDiff, /*sign=*/ 1);
    case "Beta":
      return ruleBeta(args, wrt, recurDiff);
    case "BarnesG":
      return ruleBarnesG(args, wrt, recurDiff);
    case "Erf":
      return ruleErf(args, wrt, recurDiff, /*sign=*/ 1);
    case "Erfc":
      return ruleErf(args, wrt, recurDiff, /*sign=*/ -1);
    case "Erfi":
      return ruleErfi(args, wrt, recurDiff);
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
    case "HankelH1":
    case "HankelH2":
      // Cylinder Bessel + Hankel share the symmetric three-term
      // derivative recurrence (DLMF §10.6.1, second equality). The
      // dispatcher fans four heads through one rule body.
      return ruleBesselFirstKind(head, args, wrt, recurDiff);
    case "BesselI":
      return ruleBesselI(args, wrt, recurDiff);
    case "BesselK":
      return ruleBesselK(args, wrt, recurDiff);
    case "SphericalBesselJ":
    case "SphericalBesselY":
      // Spherical Bessel j_n, y_n share the asymmetric ascent recurrence
      // (DLMF §10.51.2 first equality). One rule body, two heads.
      return ruleSphericalBesselFirstKind(head, args, wrt, recurDiff);
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

// d/dz erfi(z) = (2/√π) · exp(z²)     — DLMF §7.10.2 (imaginary error function)
//
// The imaginary error function `erfi(z) := -i · erf(i·z)` is the
// Dawson / Faddeeva sister of `erf` on the imaginary axis; its
// derivative differs from `erf`'s only in the sign of the exponent
// (`+z²` not `-z²`). That sign flip is what makes `erfi` grow super-
// exponentially on the real axis where `erf` saturates at ±1 — the
// numerical-evaluation challenges of `erfi` (catastrophic cancellation
// for moderate |z|, the need for Karbach-Weideman in the complex plane)
// trace back to this single sign and motivate the substrate pattern
// pinned by ADR-0040.
//
// Encoding choice: we emit `√π` as `expr("^", [sym("pi"), rat(1/2)])`
// per ADR-0040 §"Decision 6"'s literal-of-record code. The `sqrt`
// elementary head (used by `ruleErf` above) and `pi^(1/2)` are
// canonically distinct AST shapes — both within the closed elementary
// vocabulary, both recursively differentiable — but the per-head
// substrate at ADR-0040 picked the rational-exponent shape so the
// downstream Meijer-G bridge (R4 §1; bead `tc2c`) sees a single
// uniform encoding for the `z/√π` prefactor common to Erf, Erfc, and
// Erfi G-forms. The two encodings reduce to the same value under any
// numerical or arb-prec evaluator; their difference is purely
// canonical-form bookkeeping.
function ruleErfi(
  args: readonly Value[],
  wrt: SymbolValue,
  recurDiff: RecurDiff,
): Value | null {
  arityCheck(args, 1, "Erfi");
  const z = args[0]!;
  const dz = recurDiff(z, wrt);
  if (isZero(dz)) return ZERO;
  const twoOverSqrtPi = mkDiv(int(2n), mkPower(sym("pi"), rat(1n, 2n)));
  const expZSquared = expr("exp", [mkPower(z, int(2n))]);
  return mkTimes(mkTimes(twoOverSqrtPi, expZSquared), dz);
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

// d/dz C_ν(z) = (C_{ν-1}(z) − C_{ν+1}(z)) / 2   — DLMF §10.6.1
//
// One rule body, four heads: BesselJ, BesselY, HankelH1, HankelH2 all
// satisfy the same symmetric three-term derivative recurrence — DLMF
// §10.6.1's "any cylinder function `C_ν(z)`" pattern, where the
// cylinder family is `{J, Y, H¹, H²}`. Hankel was admitted to the
// vocabulary 2026-05-17 (ADR-0041 §"Decision 6"; bead vsvl); the rule
// fans through the same body via the `head` dispatch parameter that
// was already wired generically for J/Y.
//
// Why the symmetric form, not the asymmetric `C_{ν−1} − (ν/z)·C_ν`
// alternative (DLMF §10.6.2 first): the symmetric form preserves the
// closed-vocabulary invariant (ADR-0023: rule outputs emit heads that
// are themselves recursively differentiable in the same vocabulary)
// AND avoids introducing a spurious removable singularity at `z = 0`
// after foreign-pass-through. The two forms are mathematically
// equivalent on the principal branch; the symmetric form is the
// canonical CAS-output choice already verified against
// `integrate-1d` / `eval-numeric-expr` consumers (R1 §1.1).
//
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

// d/dz f_n(z) = f_{n-1}(z) − ((n + 1) / z) · f_n(z)   — DLMF §10.51.2
// (asymmetric ascent form, where f_n ∈ {j_n, y_n}).
//
// One rule body, two heads: SphericalBesselJ and SphericalBesselY share
// the spherical-Bessel ascent recurrence — DLMF §10.51.2's first
// equality, applicable to *any* solution of the spherical-Bessel ODE.
// The fan-through is the spherical-Bessel analogue of
// `ruleBesselFirstKind` for cylinder Bessel + Hankel.
//
// Why the asymmetric form here vs the symmetric form used for cylinder
// Bessel (ADR-0041 §"Decision 6" prompt; R1 §13.3 deems both
// admissible): the spherical-Bessel ladder is *unidirectional* — `j_n`
// derivatives shift down to `j_{n-1}` only, not symmetrically across
// `j_{n±1}`. That eliminates the half of the recurrence tree we would
// otherwise generate; for typical small-`n` use (Mie scattering and
// quantum partial-wave decomposition both cap at `n ≤ 10`-ish), the
// ladder shrinks linearly rather than fanning out. The `(n + 1) / z`
// factor introduces a `1/z` term that consumers must be aware of —
// `integrate-1d` and `eval-numeric-expr` handle this exactly the way
// they handle the `1/z` in `d/dz Li_s(z) = Li_{s-1}(z) / z` (DLMF
// §25.12.4; see `rulePolylog`), so no new dispatcher hook is needed.
//
// The closure invariant (ADR-0023: rule outputs emit heads recursively
// differentiable in the same vocabulary) is preserved: the output
// contains `SphericalBesselJ` (or `SphericalBesselY`) at shifted order
// plus elementary heads `*`, `/`, `+/-` — every recursive diff call
// fires the same rule again.
//
// Discrete order n refuses.
function ruleSphericalBesselFirstKind(
  head: string,
  args: readonly Value[],
  wrt: SymbolValue,
  recurDiff: RecurDiff,
): Value | null {
  arityCheck(args, 2, head);
  const n = args[0]!;
  const z = args[1]!;
  if (dependsOnWrt(n, wrt, recurDiff)) return null;
  const dz = recurDiff(z, wrt);
  if (isZero(dz)) return ZERO;
  // f_{n-1}(z) − ((n + 1) / z) · f_n(z)
  const ladderDown = expr(head, [intShift(n, -1n), z]);
  const ratioFactor = mkDiv(intShift(n, 1n), z);
  const ratioTerm = mkTimes(ratioFactor, expr(head, [n, z]));
  return mkTimes(mkMinus(ladderDown, ratioTerm), dz);
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

// -----------------------------------------------------------------------------
// Gamma family extensions (ADR-0042 §"Decision 6") — bead `mozz`
// -----------------------------------------------------------------------------
//
// Six diff rules (four shipped, two deferred) for the heads admitted by the
// 2026-05-19 amendment. The shipped four are LogGamma, IncompleteGammaUpper,
// IncompleteGammaLower, and Beta (partial w.r.t. its first argument).
// Pochhammer and BarnesG land as honest refusals — see their per-rule
// narratives below for the deferred-rule rationale.

// d/dz LogGamma(z) = ψ(z) = Digamma(z)   — DLMF §5.2.2
//
// The principal-value `LogGamma(z)` is the load-bearing analytic
// continuation of `log Γ(z)` along the principal branch (DLMF §5.11.1).
// Its derivative is Digamma — the same Digamma that `d/dz log Gamma(z)`
// would produce via the chain rule on `Gamma` (DLMF §5.4.2 plus the
// elementary `log` rule), but with the multi-valued branch-cut
// bookkeeping shed: `LogGamma` is single-valued on `ℂ \ {0, −1, −2, …}`,
// so the diff rule sees no branch-cut machinery. The result composes
// recursively — `Digamma` is itself in the differentiable subset (DLMF
// §5.7.1), and its derivative chains to `Polygamma(1, z)`.
function ruleLogGamma(
  args: readonly Value[],
  wrt: SymbolValue,
  recurDiff: RecurDiff,
): Value | null {
  arityCheck(args, 1, "LogGamma");
  const z = args[0]!;
  const dz = recurDiff(z, wrt);
  if (isZero(dz)) return ZERO;
  return mkTimes(expr("Digamma", [z]), dz);
}

// d/dz γ(a, z) = +z^{a-1} · e^{-z}   — DLMF §8.8.1
// d/dz Γ(a, z) = -z^{a-1} · e^{-z}   — DLMF §8.8.2
//
// The two incomplete-gamma functions are complementary on the
// integration interval — `γ(a, z) + Γ(a, z) = Γ(a)` — so their
// derivatives w.r.t. `z` are exact opposites: differentiating both sides
// of the partition w.r.t. `z` gives `γ' + Γ' = 0` (the right-hand side
// is independent of `z`), and the integrand `z^{a-1}·e^{-z}` is what
// each derivative recovers on its own (positive for the lower-bound-
// fixed γ, negative for the upper-bound-fixed Γ). One rule body, two
// heads, parameterised by `sign ∈ {+1, -1}` — the same fan-through
// pattern used by `ruleErf` for `Erf` / `Erfc`.
//
// Discrete-parameter discipline: differentiation w.r.t. the order `a`
// is genuinely non-elementary (the answer involves Meijer-G or the
// derivative of the regularised incomplete gamma `P/Q` w.r.t. `a` —
// see DLMF §8.8.16 for the closed form, which is itself a Meijer-G).
// v0.1 refuses with the standard discrete-parameter null return when
// `a` depends on `wrt`.
//
// `z^{a-1}` encoding: we lift `a-1` through `intShift(a, -1n)`. The
// helper folds integer / rational parameters to canonical numeric
// shapes (e.g. `a = int(3n)` → `int(2n)`) and emits a symbolic
// `expr("-", [a, int(1n)])` for everything else (sym, float64, complex
// expression). This matches the discipline used by `ruleBesselFirstKind`,
// `rulePolygamma`, and every other v0.1 recurrence rule that touches a
// parameter — the result reads canonically (`d/dz γ(3, z) = z² · e^{-z}`,
// not `z^{3-1} · e^{-z}`) before any cas-simplify pass, while preserving
// the symbolic `a-1` shape for continuous parameters.
function ruleIncompleteGamma(
  args: readonly Value[],
  wrt: SymbolValue,
  recurDiff: RecurDiff,
  sign: 1 | -1,
): Value | null {
  const head = sign === 1 ? "IncompleteGammaLower" : "IncompleteGammaUpper";
  arityCheck(args, 2, head);
  const a = args[0]!;
  const z = args[1]!;
  if (dependsOnWrt(a, wrt, recurDiff)) return null;
  const dz = recurDiff(z, wrt);
  if (isZero(dz)) return ZERO;
  const aMinusOne = intShift(a, -1n);
  const zPow = mkPower(z, aMinusOne);
  const expNegZ = expr("exp", [mkNeg(z)]);
  const integrand = mkTimes(zPow, expNegZ);
  const body = sign === 1 ? integrand : mkNeg(integrand);
  return mkTimes(body, dz);
}

// ∂/∂a B(a, b) = B(a, b) · [ψ(a) - ψ(a+b)]   — DLMF §5.12.2 (SymPy `beta.fdiff`)
// ∂/∂b B(a, b) = B(a, b) · [ψ(b) - ψ(a+b)]   — DLMF §5.12.2 (symmetric)
//
// The Beta function `B(a, b) = Γ(a)Γ(b)/Γ(a+b)` has a clean diff rule
// in either of its two parameters: factor the Beta out and pair the
// Digamma of the differentiated argument against the Digamma of the
// sum. Both partials sit in the v0.1 differentiable subset — the rule
// fans through one body with `which ∈ {"a", "b"}` selecting the
// argument that depends on `wrt`. If neither argument depends on `wrt`
// (constants-in-wrt), the result is `0` per the chain-rule
// short-circuit. If *both* depend — the genuine multivariable case —
// the answer is the sum of the two partials each multiplied by its
// chain factor; this is consistent with the elementary product rule
// but neither DLMF nor SymPy emits a single-rule encoding for it. v0.1
// refuses the both-depend case (null) and lets the future bead emit
// the additive composition; the alternative would be silently
// fabricating a rule shape that no canonical source endorses.
function ruleBeta(
  args: readonly Value[],
  wrt: SymbolValue,
  recurDiff: RecurDiff,
): Value | null {
  arityCheck(args, 2, "Beta");
  const a = args[0]!;
  const b = args[1]!;
  const da = recurDiff(a, wrt);
  const db = recurDiff(b, wrt);
  const aDep = !isZero(da);
  const bDep = !isZero(db);
  if (!aDep && !bDep) return ZERO;
  // Both arguments depend on `wrt`: refuse honestly. The multivariable
  // chain-rule additive composition is doable in principle, but no
  // canonical DLMF / SymPy source emits it as a single rule and a
  // separate v0.2 bead is the right granularity to land it.
  if (aDep && bDep) return null;
  const which = aDep ? a : b;
  const dwhich = aDep ? da : db;
  const betaTerm = expr("Beta", [a, b]);
  const digammaDiff = mkMinus(
    expr("Digamma", [which]),
    expr("Digamma", [mkPlus([a, b])]),
  );
  return mkTimes(mkTimes(betaTerm, digammaDiff), dwhich);
}

// d/dn Pochhammer(a, n) — refused (discrete-order parameter).
// d/da Pochhammer(a, n) — deferred to v0.2.
//
// The Pochhammer symbol `(a)_n = Γ(a+n)/Γ(a)` has a derivative w.r.t.
// `a` that is the natural multivariable Gamma-ratio rule —
// `(a)_n · [ψ(a+n) - ψ(a)]` (R1 §2.3 / SymPy `RisingFactorial.fdiff`).
// We defer it to v0.2 for symmetry with `BarnesG`'s deferred rule
// (both involve Gamma-quotient simplification that cas-simplify
// doesn't yet expose) and because v0.1 has no consumer that surfaces
// the parameter derivative — the only Pochhammer use site is as a
// first-class argument in `HypergeometricPFQ`, which itself defers its
// list-parameter diff rule (ADR-0023 v0.1).
//
// Differentiation w.r.t. `n` is genuinely non-elementary: `n` is the
// discrete order, and v0.1's discrete-parameter discipline (see
// `rulePolygamma`, `ruleExpIntegralE`, `ruleBesselFirstKind`) refuses
// uniformly. The continuous-extension form `(a)_n = Γ(a+n)/Γ(a)`
// does admit a derivative w.r.t. `n`, but lifting `n` from discrete to
// continuous semantics is a vocabulary-level decision a separate ADR
// should pin, not a diff-rule decision.
function rulePochhammer(
  args: readonly Value[],
  wrt: SymbolValue,
  recurDiff: RecurDiff,
): Value | null {
  arityCheck(args, 2, "Pochhammer");
  const a = args[0]!;
  const n = args[1]!;
  if (dependsOnWrt(n, wrt, recurDiff)) return null;
  // a-derivative deferred to v0.2 per the narrative above. If `a`
  // depends on `wrt`, surface the deferral as a null return; the
  // diff.ts caller will raise the standard `CasDiffOutOfScopeError`,
  // and the tool layer wraps it in `tagged "cas-diff/out-of-scope"`.
  if (dependsOnWrt(a, wrt, recurDiff)) return null;
  // Neither argument depends on `wrt`: the Pochhammer value is constant
  // in `wrt`, so its derivative is zero.
  return ZERO;
}

// d/dz BarnesG(z) — deferred to v0.2.
//
// The Barnes G-function (DLMF §5.17.1, `G(z+1) = Γ(z)·G(z)`, `G(1) = 1`)
// has a closed-form derivative via the logarithmic derivative
// (DLMF §5.17.4):
//
//     d/dz log G(z+1) = (z/2)·log(2π) + z·ψ(z+1) - z²/2 - z·(ψ(z+1) - 1)
//                                        ... simplified ...
//     d/dz log G(z)   = (z - 1)·Digamma(z) - LogGamma(z) + (1/2)·log(2π)
//
// chaining via `d/dz G(z) = G(z) · d/dz log G(z)` to:
//
//     d/dz G(z) = G(z) · [(z - 1)·Digamma(z) - LogGamma(z) + (1/2)·log(2π)]
//
// The rule is shippable in principle — every head in the right-hand
// side is in the v0.1 differentiable subset (Digamma, LogGamma) — but
// the additive constant `(1/2)·log(2π)` introduces a literal-of-record
// shape (`mkTimes(mkDiv(int(1n), int(2n)), expr("log", [mkTimes(int(2n),
// sym("pi"))]))`) that has no precedent in the existing v0.1 diff
// rules. The closest precedent is `ruleErfi`'s `mkPower(sym("pi"),
// rat(1n, 2n))` for `√π`, but that is a multiplicative prefactor (not
// an additive constant) and is wrapped inside a `mkDiv`, not exposed
// directly. R1 §2.8 recommends deferring to v0.2 alongside the
// `applyGammaRewrites` simplify pre-pass (ADR-0042 §"Decision 13"),
// which will canonicalise the additive-constant encoding consistently
// across the family.
//
// v0.1 refuses honestly via a null return when `BarnesG(z)`'s argument
// `z` depends on `wrt` (the rule itself is what's deferred). When the
// argument is constant in `wrt` — the chain-rule short-circuit shared
// with every other rule body — we return `0` directly. This preserves
// the free-symbol-independence discipline (a `BarnesG(c)` term where
// `c` is constant in `wrt` contributes zero to the derivative without
// requiring the deferred rule to fire), exactly mirroring how
// `rulePolygamma` and `ruleBesselFirstKind` short-circuit on constant
// arguments while their main rule body refuses for the
// discrete-parameter case.
function ruleBarnesG(
  args: readonly Value[],
  wrt: SymbolValue,
  recurDiff: RecurDiff,
): Value | null {
  arityCheck(args, 1, "BarnesG");
  const z = args[0]!;
  const dz = recurDiff(z, wrt);
  // Free-symbol-independence: `BarnesG(c)` with `c` constant in `wrt`
  // contributes zero to the derivative. The rule itself is deferred,
  // so any other call refuses with the standard null return.
  if (isZero(dz)) return ZERO;
  return null;
}
