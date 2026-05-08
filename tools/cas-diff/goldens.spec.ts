import { expr, int, rat, record, sym } from "@workbench/protocol";
import type { GoldenSpec } from "@workbench/contract";

// Per-tool goldens. `bun scripts/generate-goldens.ts` runs the tool
// against each input and writes the canonical `{input, output}` record
// into goldens/. The corpus below covers every rule branch (atoms,
// linearity, product, quotient, power × {const-exp, const-base,
// general}, six transcendentals + abs, chain rule) plus the demo
// motivation (`scripts/demo-min-integral.ts`'s integrand differentiated
// wrt `a`) and the two out-of-scope refusal classes.

const x = sym("x");
const y = sym("y");
const a = sym("a");

export const goldens: GoldenSpec[] = [
  // Atoms
  { description: "d(7)/dx = 0", input: record({ f: int(7n), var: x }) },
  { description: "d(3/7)/dx = 0", input: record({ f: rat(3n, 7n), var: x }) },
  { description: "d(pi)/dx = 0", input: record({ f: sym("pi"), var: x }) },
  { description: "d(x)/dx = 1", input: record({ f: x, var: x }) },
  { description: "d(y)/dx = 0", input: record({ f: y, var: x }) },

  // Sum / difference / neg
  { description: "d(x + y)/dx = 1", input: record({ f: expr("+", [x, y]), var: x }) },
  { description: "d(x - y)/dx = 1", input: record({ f: expr("-", [x, y]), var: x }) },
  { description: "d(y - x)/dx = neg(1)", input: record({ f: expr("-", [y, x]), var: x }) },
  { description: "d(-x)/dx = neg(1) (unary minus)", input: record({ f: expr("-", [x]), var: x }) },
  { description: "d(neg(x))/dx = neg(1)", input: record({ f: expr("neg", [x]), var: x }) },
  { description: "d(neg(neg(x)))/dx = 1 (double-negation collapses)",
    input: record({ f: expr("neg", [expr("neg", [x])]), var: x }) },

  // Product rule
  { description: "d(2·x)/dx = 2", input: record({ f: expr("*", [int(2n), x]), var: x }) },
  { description: "d(x·y)/dx = y", input: record({ f: expr("*", [x, y]), var: x }) },
  { description: "d(x·x)/dx = x + x  (product rule, no like-term combine)",
    input: record({ f: expr("*", [x, x]), var: x }) },

  // Quotient rule
  { description: "d(1/x)/dx = -1/x²", input: record({ f: expr("/", [int(1n), x]), var: x }) },
  { description: "d(x/(x²-49))/dx (the demo's denominator pattern)",
    input: record({
      f: expr("/", [x, expr("+", [expr("^", [x, int(2n)]), int(-49n)])]),
      var: x,
    }) },

  // Power rule branches
  { description: "d(x²)/dx = 2x  (constant exponent)",
    input: record({ f: expr("^", [x, int(2n)]), var: x }) },
  { description: "d(x³)/dx = 3·x²", input: record({ f: expr("^", [x, int(3n)]), var: x }) },
  { description: "d(x^(3/2))/dx (rational exponent)",
    input: record({ f: expr("^", [x, rat(3n, 2n)]), var: x }) },
  { description: "d(2^x)/dx = 2^x · log(2)  (exp rule)",
    input: record({ f: expr("^", [int(2n), x]), var: x }) },

  // Transcendentals
  { description: "d(sin(x))/dx = cos(x)", input: record({ f: expr("sin", [x]), var: x }) },
  { description: "d(cos(x))/dx = neg(sin(x))", input: record({ f: expr("cos", [x]), var: x }) },
  { description: "d(tan(x))/dx = 1/cos(x)²", input: record({ f: expr("tan", [x]), var: x }) },
  { description: "d(exp(x))/dx = exp(x)", input: record({ f: expr("exp", [x]), var: x }) },
  { description: "d(log(x))/dx = 1/x", input: record({ f: expr("log", [x]), var: x }) },
  { description: "d(sqrt(x))/dx = 1/(2·sqrt(x))", input: record({ f: expr("sqrt", [x]), var: x }) },
  { description: "d(|x|)/dx = x/|x|", input: record({ f: expr("abs", [x]), var: x }) },

  // Tier-1 transcendentals (2026-05-04). One golden per new head.
  { description: "d(asin(x))/dx", input: record({ f: expr("asin", [x]), var: x }) },
  { description: "d(acos(x))/dx", input: record({ f: expr("acos", [x]), var: x }) },
  { description: "d(atan(x))/dx", input: record({ f: expr("atan", [x]), var: x }) },
  { description: "d(sinh(x))/dx = cosh(x)", input: record({ f: expr("sinh", [x]), var: x }) },
  { description: "d(cosh(x))/dx = sinh(x) (positive — not the dual of d(cos))",
    input: record({ f: expr("cosh", [x]), var: x }) },
  { description: "d(tanh(x))/dx = 1 − tanh(x)²", input: record({ f: expr("tanh", [x]), var: x }) },
  { description: "d(asinh(x))/dx", input: record({ f: expr("asinh", [x]), var: x }) },
  { description: "d(acosh(x))/dx", input: record({ f: expr("acosh", [x]), var: x }) },
  { description: "d(atanh(x))/dx", input: record({ f: expr("atanh", [x]), var: x }) },
  { description: "d(log2(x))/dx = 1/(x · log(2))", input: record({ f: expr("log2", [x]), var: x }) },
  { description: "d(log10(x))/dx", input: record({ f: expr("log10", [x]), var: x }) },

  // Chain rule
  { description: "d(sin(2·x))/dx (chain rule, smart-constructor folds the constant factor)",
    input: record({ f: expr("sin", [expr("*", [int(2n), x])]), var: x }) },
  { description: "d(exp(-x²))/dx (chain rule with neg + power)",
    input: record({
      f: expr("exp", [expr("neg", [expr("^", [x, int(2n)])])]),
      var: x,
    }) },

  // Multivariate (the demo motivation)
  { description: "d(p(x,a))/da on the demo's full integrand",
    input: record({
      f: expr("/", [
        expr("*", [
          expr("*", [
            expr("-", [int(1n), expr("*", [a, x])]),
            expr("+", [int(2n), x]),
          ]),
          expr("+", [rat(3n, 7n), expr("*", [a, x])]),
        ]),
        expr("+", [expr("^", [x, int(2n)]), int(-49n)]),
      ]),
      var: a,
    }) },

  // Out-of-scope refusals (lowercase heads — distinct from the
  // PascalCase special-function vocabulary; ADR-0023).
  { description: "unknown head (lowercase 'gamma') → tagged out-of-scope",
    input: record({ f: expr("gamma", [x]), var: x }) },
  { description: "deeply nested unknown head (lowercase 'erf') → tagged out-of-scope",
    input: record({ f: expr("+", [x, expr("erf", [x])]), var: x }) },

  // Special-function vocabulary (ADR-0023). Differentiable subset:
  // each rule is sourced from DLMF; one golden per representative
  // family member to prove the dispatcher is wired.
  { description: "d(Γ(x))/dx = ψ(x)·Γ(x) — Gamma rule (DLMF §5.4.2)",
    input: record({ f: expr("Gamma", [x]), var: x }) },
  { description: "d(ψ(x))/dx = ψ⁽¹⁾(x) — Digamma rule (DLMF §5.7.1)",
    input: record({ f: expr("Digamma", [x]), var: x }) },
  { description: "d(erf(x))/dx = 2/√π · exp(−x²) — Erf rule (DLMF §7.7.1)",
    input: record({ f: expr("Erf", [x]), var: x }) },
  { description: "d(erfc(x))/dx = −2/√π · exp(−x²) — Erfc rule",
    input: record({ f: expr("Erfc", [x]), var: x }) },
  { description: "d(Ei(x))/dx = exp(x)/x — ExpIntegralEi rule (DLMF §6.2.6)",
    input: record({ f: expr("ExpIntegralEi", [x]), var: x }) },
  { description: "d(C(x))/dx = cos(π·x²/2) — FresnelC rule (DLMF §7.2.7)",
    input: record({ f: expr("FresnelC", [x]), var: x }) },
  { description: "d(J_2(x))/dx = (J_1(x) − J_3(x))/2 — Bessel J recurrence (DLMF §10.6.1)",
    input: record({ f: expr("BesselJ", [int(2n), x]), var: x }) },
  { description: "d(I_2(x))/dx = (I_1(x) + I_3(x))/2 — Bessel I (modified; DLMF §10.29.1)",
    input: record({ f: expr("BesselI", [int(2n), x]), var: x }) },
  { description: "d(K_2(x))/dx = −(K_1(x) + K_3(x))/2 — Bessel K (modified)",
    input: record({ f: expr("BesselK", [int(2n), x]), var: x }) },
  { description: "d(H_3(x))/dx = 2·3·H_2(x) — HermiteH (DLMF §18.9.27)",
    input: record({ f: expr("HermiteH", [int(3n), x]), var: x }) },
  { description: "d(Li_2(x))/dx = Li_1(x)/x — Polylog (DLMF §25.12.4)",
    input: record({ f: expr("Polylog", [int(2n), x]), var: x }) },

  // Special-function deferred subset — heads admitted in the AST but
  // refusing on diff per ADR-0023's honest-scope discipline.
  { description: "d(MeijerG(...))/dx → tagged (diff rule deferred)",
    input: record({ f: expr("MeijerG", [sym("a"), sym("b"), x]), var: x }) },
  { description: "d(W_M(k, m, x))/dx → tagged (Whittaker diff rule deferred)",
    input: record({ f: expr("WhittakerM", [int(1n), int(1n), x]), var: x }) },
  { description: "d(P_n(x))/dx → tagged (LegendreP diff rule deferred)",
    input: record({ f: expr("LegendreP", [int(2n), x]), var: x }) },
];
