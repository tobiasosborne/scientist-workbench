// =============================================================================
// case-corpus.ts — TS mirror of generate-from-scipy.py's CASES table
// =============================================================================
//
// The orthogonal-oracle manifest (`manifest.json`) is keyed by case
// id. The integrand expressions and intervals live only in the
// Python generator. This file mirrors them into TypeScript so:
//
//   * The tool's `--test` hook can pair each manifest entry with the
//     corresponding integrand and run it through the in-process
//     `gaussKronrodAdaptive`.
//   * The tool's `goldens.spec.ts` can build the canonical wire-form
//     `inp({...})` for each case from a single source of truth.
//
// Each entry carries:
//
//   * `id`         — matches the manifest's case id exactly.
//   * `f`          — JS-side integrand (for the `--test` hook to feed
//                    the library directly).
//   * `fExpr`      — wire-form `expression` (for the goldens). When
//                    the tool runs against the goldens, it
//                    re-evaluates `fExpr` via `evalNumericExpr`; the
//                    `f` and `fExpr` definitions must produce the
//                    same value at every quadrature node, which is
//                    a property the test suite indirectly verifies
//                    (mismatch ⇒ `--test` fails).
//   * `a`, `b`     — interval bounds.
//   * `kind`       — "value" or "refusal" (matching the manifest's
//                    kind discriminator).
//
// We *do not* duplicate manifest data here (expected values, per-
// category tolerances) — the manifest is the canonical source of
// truth for those; this file is the canonical source of truth for
// the *integrand vocabulary* expansion of each case.

import {
  expr,
  float64FromNumber,
  int,
  sym,
  type Value,
} from "@workbench/protocol";

// -----------------------------------------------------------------------------
// Helpers — keep the table below dense and readable
// -----------------------------------------------------------------------------

const x = sym("x");

/** `pi` as a numeric leaf — pi/2, 2pi, etc. baked at table-build time. */
const pi = Math.PI;

function pow(base: Value, n: bigint): Value {
  return expr("^", [base, int(n)]);
}
function neg(a: Value): Value {
  return expr("neg", [a]);
}
function add(...args: Value[]): Value {
  return expr("+", args);
}
function sub(a: Value, b: Value): Value {
  return expr("-", [a, b]);
}
function mul(...args: Value[]): Value {
  return expr("*", args);
}
function div(a: Value, b: Value): Value {
  return expr("/", [a, b]);
}
function f64(n: number): Value {
  return float64FromNumber(n);
}
function call(head: string, ...args: Value[]): Value {
  return expr(head, args);
}

// -----------------------------------------------------------------------------
// The corpus
// -----------------------------------------------------------------------------
//
// Each integrand is written to mirror the Python generator literally.
// Where the Python uses `0.5`, we use `f64(0.5)`; where it uses an
// integer literal, we use `int(...)`. Constants like `pi` are baked
// to their float64 value via `f64(pi)` rather than written as a `pi`
// symbol — the symbol is admitted by the evaluator but the goldens
// would then carry a symbolic constant the goldens.spec.ts is not
// trying to demonstrate.

export interface CorpusCase {
  readonly id: string;
  readonly description: string;
  readonly category: string;
  readonly kind: "value" | "refusal";
  readonly f: (x: number) => number;
  readonly fExpr: Value;
  readonly a: number;
  readonly b: number;
  /** Only set when `kind === "refusal"`. The expected boundary tag's reason class. */
  readonly expectedRefusalReason?: "non-finite-during-eval" | "degenerate-interval";
}

export const caseCorpus: readonly CorpusCase[] = [
  // --- Category 1: Smooth easy ---
  {
    id: "01-smooth-poly-quad",
    description: "degree-4 polynomial",
    category: "smooth-easy",
    kind: "value",
    f: (x) => x ** 4 - 2 * x * x + 1,
    fExpr: add(pow(x, 4n), neg(mul(int(2n), pow(x, 2n))), int(1n)),
    a: 0,
    b: 2,
  },
  {
    id: "02-smooth-exp-linear",
    description: "exp(x) on [0,1]",
    category: "smooth-easy",
    kind: "value",
    f: Math.exp,
    fExpr: call("exp", x),
    a: 0,
    b: 1,
  },
  {
    id: "03-smooth-trig-sin",
    description: "sin(x) on [0,pi]",
    category: "smooth-easy",
    kind: "value",
    f: Math.sin,
    fExpr: call("sin", x),
    a: 0,
    b: pi,
  },
  {
    id: "04-smooth-poly-cubic",
    description: "odd cubic on symmetric interval",
    category: "smooth-easy",
    kind: "value",
    f: (x) => x ** 3 - x,
    fExpr: sub(pow(x, 3n), x),
    a: -1,
    b: 1,
  },
  {
    id: "05-smooth-exp-cos",
    description: "exp(x)*cos(x) on [0,pi/2]",
    category: "smooth-easy",
    kind: "value",
    f: (x) => Math.exp(x) * Math.cos(x),
    fExpr: mul(call("exp", x), call("cos", x)),
    a: 0,
    b: pi / 2,
  },
  // --- Category 2: Smooth hard ---
  {
    id: "06-smooth-narrow-gauss",
    description: "narrow Gaussian peak",
    category: "smooth-hard",
    kind: "value",
    f: (x) => Math.exp(-100 * (x - 0.5) ** 2),
    fExpr: call(
      "exp",
      neg(mul(int(100n), pow(sub(x, f64(0.5)), 2n))),
    ),
    a: 0,
    b: 1,
  },
  {
    id: "07-smooth-product-peak",
    description: "Genz product peak (1D)",
    category: "smooth-hard",
    kind: "value",
    f: (x) => 1.0 / (0.04 + (x - 0.5) ** 2),
    fExpr: div(
      int(1n),
      add(f64(0.04), pow(sub(x, f64(0.5)), 2n)),
    ),
    a: 0,
    b: 1,
  },
  {
    id: "08-smooth-corner-peak",
    description: "Genz corner peak (1D)",
    category: "smooth-hard",
    kind: "value",
    f: (x) => 1.0 / (1 + 6 * x) ** 2,
    fExpr: div(int(1n), pow(add(int(1n), mul(int(6n), x)), 2n)),
    a: 0,
    b: 1,
  },
  {
    id: "09-smooth-c0-exponential",
    description: "Genz C0 family (1D, kink at 0.4)",
    category: "smooth-hard",
    kind: "value",
    f: (x) => Math.exp(-15 * Math.abs(x - 0.4)),
    fExpr: call("exp", neg(mul(int(15n), call("abs", sub(x, f64(0.4)))))),
    a: 0,
    b: 1,
  },
  {
    id: "10-smooth-high-freq-trig",
    description: "sin(30x)*exp(-x) on [0,pi]",
    category: "smooth-hard",
    kind: "value",
    f: (x) => Math.sin(30 * x) * Math.exp(-x),
    fExpr: mul(call("sin", mul(int(30n), x)), call("exp", neg(x))),
    a: 0,
    b: pi,
  },
  // --- Category 3: Standard test families ---
  {
    id: "11-genz-oscillatory",
    description: "Genz oscillatory family (1D)",
    category: "standard-family",
    kind: "value",
    f: (x) => Math.cos(2 * pi * 0.5 + 3 * x),
    // 2*pi*0.5 = pi; baked.
    fExpr: call("cos", add(f64(pi), mul(int(3n), x))),
    a: 0,
    b: 1,
  },
  {
    id: "12-genz-discontinuous",
    description: "Genz discontinuous (truncated to support)",
    category: "standard-family",
    kind: "value",
    f: (x) => Math.exp(2 * x),
    fExpr: call("exp", mul(int(2n), x)),
    a: 0,
    b: 0.6,
  },
  {
    id: "13-quadpack-qag-example",
    description: "QUADPACK QAG ex.: 2/(2+sin(10*pi*x))",
    category: "standard-family",
    kind: "value",
    f: (x) => 2.0 / (2 + Math.sin(10 * pi * x)),
    fExpr: div(
      int(2n),
      add(int(2n), call("sin", mul(int(10n), f64(pi), x))),
    ),
    a: 0,
    b: 1,
  },
  {
    id: "14-davis-rabinowitz-log",
    description: "log(x+1) on [0,1] (D&R baseline)",
    category: "standard-family",
    kind: "value",
    f: (x) => Math.log(x + 1),
    fExpr: call("log", add(x, int(1n))),
    a: 0,
    b: 1,
  },
  {
    id: "15-patterson-algebraic",
    description: "1/(1+x^2) on [0,1] = pi/4",
    category: "standard-family",
    kind: "value",
    f: (x) => 1.0 / (1 + x * x),
    fExpr: div(int(1n), add(int(1n), pow(x, 2n))),
    a: 0,
    b: 1,
  },
  {
    id: "16-squire-trig-product",
    description: "sin(x)^2*cos(x) on [0,pi/2]",
    category: "standard-family",
    kind: "value",
    f: (x) => Math.sin(x) ** 2 * Math.cos(x),
    fExpr: mul(pow(call("sin", x), 2n), call("cos", x)),
    a: 0,
    b: pi / 2,
  },
  // --- Category 4: Non-smooth interior ---
  {
    id: "17-kink-abs-centre",
    description: "|x - 0.3| kink interior",
    category: "nonsmooth-interior",
    kind: "value",
    f: (x) => Math.abs(x - 0.3),
    fExpr: call("abs", sub(x, f64(0.3))),
    a: 0,
    b: 1,
  },
  {
    id: "18-kink-abs-double",
    description: "|x-0.7| + |x-0.3| (two kinks)",
    category: "nonsmooth-interior",
    kind: "value",
    f: (x) => Math.abs(x - 0.7) + Math.abs(x - 0.3),
    fExpr: add(
      call("abs", sub(x, f64(0.7))),
      call("abs", sub(x, f64(0.3))),
    ),
    a: 0,
    b: 1,
  },
  {
    id: "19-near-sing-interior",
    description: "1/sqrt(|x-0.5|+0.01) (cusp)",
    category: "nonsmooth-interior",
    kind: "value",
    f: (x) => 1.0 / Math.sqrt(Math.abs(x - 0.5) + 0.01),
    fExpr: div(
      int(1n),
      call("sqrt", add(call("abs", sub(x, f64(0.5))), f64(0.01))),
    ),
    a: 0,
    b: 1,
  },
  // --- Category 5: Oscillatory but bounded ---
  {
    id: "20-osc-sin-k20-fullperiods",
    description: "sin(20x) on [0,2pi] = 0",
    category: "oscillatory",
    kind: "value",
    f: (x) => Math.sin(20 * x),
    fExpr: call("sin", mul(int(20n), x)),
    a: 0,
    b: 2 * pi,
  },
  {
    id: "21-osc-sin-k7-partial",
    description: "sin(7x) on [0,1]",
    category: "oscillatory",
    kind: "value",
    f: (x) => Math.sin(7 * x),
    fExpr: call("sin", mul(int(7n), x)),
    a: 0,
    b: 1,
  },
  {
    id: "22-osc-cos-exp-decay",
    description: "cos(10x)*exp(-x) on [0,pi]",
    category: "oscillatory",
    kind: "value",
    f: (x) => Math.cos(10 * x) * Math.exp(-x),
    fExpr: mul(call("cos", mul(int(10n), x)), call("exp", neg(x))),
    a: 0,
    b: pi,
  },
  // --- Category 6: Refusals (no f evaluated) ---
  {
    id: "23-refuse-pole-interior",
    description: "1/(x-0.5) — +Inf at x=0.5",
    category: "refusal",
    kind: "refusal",
    f: (x) => 1 / (x - 0.5),
    fExpr: div(int(1n), sub(x, f64(0.5))),
    a: 0,
    b: 1,
    expectedRefusalReason: "non-finite-during-eval",
  },
  {
    id: "24-refuse-log-negative",
    description: "log(x-0.5) — NaN for x<0.5",
    category: "refusal",
    kind: "refusal",
    f: (x) => Math.log(x - 0.5),
    fExpr: call("log", sub(x, f64(0.5))),
    a: 0,
    b: 1,
    expectedRefusalReason: "non-finite-during-eval",
  },
  {
    id: "25-refuse-degenerate-empty",
    description: "a == b empty interval",
    category: "refusal",
    kind: "refusal",
    f: () => 0,
    fExpr: x, // never evaluated; f stays "x" as a placeholder
    a: 1,
    b: 1,
    expectedRefusalReason: "degenerate-interval",
  },
  {
    id: "26-refuse-reversed-interval",
    description: "a > b reversed",
    category: "refusal",
    kind: "refusal",
    f: () => 0,
    fExpr: x,
    a: 2,
    b: 0,
    expectedRefusalReason: "degenerate-interval",
  },
  {
    id: "27-refuse-sqrt-negative",
    description: "sqrt(x-0.5) — NaN for x<0.5",
    category: "refusal",
    kind: "refusal",
    f: (x) => Math.sqrt(x - 0.5),
    fExpr: call("sqrt", sub(x, f64(0.5))),
    a: 0,
    b: 1,
    expectedRefusalReason: "non-finite-during-eval",
  },
  // --- Category 7: Timing stress ---
  {
    id: "28-stress-ultra-narrow-gauss",
    description: "exp(-1e6*(x-0.5)^2) — ultra-narrow peak",
    category: "timing-stress",
    kind: "value",
    f: (x) => Math.exp(-1e6 * (x - 0.5) ** 2),
    fExpr: call(
      "exp",
      neg(mul(f64(1e6), pow(sub(x, f64(0.5)), 2n))),
    ),
    a: 0,
    b: 1,
  },
  {
    id: "29-stress-high-freq-osc",
    description: "sin(1000x) on [0,1] — ~160 half-periods",
    category: "timing-stress",
    kind: "value",
    f: (x) => Math.sin(1000 * x),
    fExpr: call("sin", mul(int(1000n), x)),
    a: 0,
    b: 1,
  },
  {
    id: "30-stress-two-scale",
    description: "exp(-x) + exp(-1000(x-0.8)^2) two scales",
    category: "timing-stress",
    kind: "value",
    f: (x) => Math.exp(-x) + Math.exp(-1000 * (x - 0.8) ** 2),
    fExpr: add(
      call("exp", neg(x)),
      call(
        "exp",
        neg(mul(int(1000n), pow(sub(x, f64(0.8)), 2n))),
      ),
    ),
    a: 0,
    b: 1,
  },
];
