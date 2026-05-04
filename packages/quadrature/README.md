# @workbench/quadrature

Adaptive 1D numerical integration on `float64`. The substrate behind
`tools/integrate-1d`. Pure TypeScript, no FFI; ADR-0014 (numerical-tier
package precedent) and ADR-0015 (numerical-tier determinism contract)
apply.

This is a library, not a tool — it speaks `(x: number) => number` and a
canonical `Value` integrand tree, not the wire protocol. The wire-
encoding wrapper lives in the tool layer (`tools/integrate-1d/tool.ts`);
ADR-0010's `defineTool`/`runTool` split lets one implementation serve
both surfaces.

## Surface

```ts
import {
  gaussKronrodAdaptive,
  evalNumericExpr,
  ADMITTED_HEADS,
  ADMITTED_CONSTANTS,
  type QuadResult,
  type QuadOptions,
  QuadratureNonFiniteError,
  UnknownVocabularyError,
} from "@workbench/quadrature";

// Pure-numeric API: caller provides a JS function.
const r = gaussKronrodAdaptive(Math.sin, 0, Math.PI);
//  r.value          ≈ 2.0
//  r.errorEstimate  ≈ 0
//  r.nEvals         = 15
//  r.converged      = true
//  r.iterations     = 0
//  r.method         = "gauss-kronrod-g7k15"
//  r.warnings       = []

// Closed-vocabulary expression evaluator, used to bridge a `Value`
// integrand to a plain JS callable.
import { expr, sym, int } from "@workbench/protocol";
const e = expr("sin", [sym("x")]);
const env = new Map<string, number>([["x", 0]]);
const f = (x: number) => { env.set("x", x); return evalNumericExpr(e, env); };
gaussKronrodAdaptive(f, 0, Math.PI);
```

## Algorithm

- **Local rule — `gaussKronrod15`**: a 7-point Gauss-Legendre rule
  nested inside a 15-point Kronrod extension over `[-1, 1]`, mapped
  affinely to a working subinterval. K15 is the integral estimate
  (algebraically exact for polynomials of degree ≤ 23); the difference
  `|K15 − G7| · halfLength` is the local truncation-error estimate.
  The Piessens 1983 §1.5.1 robustness rescaling is *deferred* in v0.1;
  we use the simpler (and conservative) `|K-G|` form, which over-
  estimates rather than under-estimates the error and so keeps
  `converged` honest.
- **Global driver — `gaussKronrodAdaptive`**: a max-heap of subintervals
  keyed on local error. Each iteration pops the worst subinterval,
  bisects, evaluates K15+G7 on the two halves, and updates the running
  totals *by delta* (`total += new − old`). Termination on
  `errorEstimate ≤ atol + rtol·|value|` (`converged: true`) or
  `nEvals ≥ maxEvals` (`converged: false`, with a budget warning).

Constants from GSL `qk15.c` (BSD-equivalent reimpl of QUADPACK's
`dqk15.f`); the source documents them as "evaluated with 80 decimal
digit arithmetic by L. W. Fullerton, Bell Labs, Nov. 1981" — far above
the float64 precision they round to here.

References: Piessens, de Doncker, Überhuber & Kahaner, *QUADPACK*
(1983); Galassi et al., *GNU Scientific Library Reference Manual*
§16.4; Kahaner, Moler & Nash, *Numerical Methods and Software* (1989,
Ch. 5).

## Closed integrand vocabulary

`evalNumericExpr` admits exactly:

- **Heads:** `+`, `-`, `*`, `/`, `^`, `neg`, `exp`, `sin`, `cos`,
  `tan`, `log`, `sqrt`, `abs`. `+` and `*` are n-ary; `-` accepts
  unary (`-x` ≡ `neg(x)`) or binary (`-(a, b)`).
- **Constants:** `pi` (≡ `Math.PI`), `e` (≡ `Math.E`).
- **Numeric leaves:** `integer` / `rational` / `float64` (the
  protocol's three numeric kinds).
- **Variables:** any other `symbol` is resolved via the `env: Map`.
  An unknown symbol raises `UnknownVocabularyError`.

Unknown heads / unknown free symbols raise `UnknownVocabularyError`
loudly (no silent NaN). The tool layer translates those into
`ToolError` (malformed input, ADR-0003) at the first evaluation.

The evaluator is faithful to IEEE-754 — `log(-1)` returns `NaN`,
`1/0` returns `+Infinity`, etc. The *quadrature driver* is responsible
for catching non-finite values during integration; the evaluator
itself never silently substitutes.

## Scope

- **In:** finite real intervals `[a, b]` with `a < b`, smooth or
  modestly non-smooth integrands, default tolerances `atol=1e-10`
  `rtol=1e-8` `maxEvals=10000`. Single-platform determinism
  (Bun on x86-64 Linux).
- **Out (v0.1, all deliberate):** infinite intervals (Gauss-Hermite /
  Gauss-Laguerre would be sister tools), vector-valued or complex
  integrands, higher-dimensional cubature, symbolic anti-derivatives,
  cross-platform bit-identity (see ADR-0015's `numerical: true`
  tiering and the platform-fingerprint provenance field).

## Tests

```sh
bun test packages/quadrature
```

30 tests covering algebraic exactness on `x^k` for `k = 0..15` (the
K15 rule is exact for polynomials of degree ≤ 23), hand-checked
smooth integrals, oscillatory budget honesty, narrow-Gaussian-peak
adaptivity, evaluator round-trips, and the non-finite-during-eval
boundary path. Mutation-proven (see test header): G7-only fails the
high-degree polynomial cases; FIFO bisection fails the oscillatory
budget-honesty test.
