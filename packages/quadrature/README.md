# @workbench/quadrature

Adaptive 1D Gauss-Kronrod quadrature, two precision tiers. The substrate
behind `tools/integrate-1d` (float64) and the in-process surface for
arb-prec consumers (`packages/meijer-core`'s Mellin-Barnes contour layer
and downstream).

Pure TypeScript on Bun. No FFI; no subprocess; no platform-conditional
behaviour in the arb-prec tier (ADR-0020 — bit-identical across all JS
runtimes by language spec). Float64 tier carries the standard ADR-0015
caveat (platform fingerprint recorded in provenance).

## Surface

```ts
import {
  // Float64 (ADR-0014) — substrate for tools/integrate-1d.
  gaussKronrodAdaptive,
  type QuadResult,
  type QuadOptions,
  QuadratureNonFiniteError,

  // Arbitrary precision (ADR-0021) — substrate for packages/meijer-core
  // and any arb-prec quadrature consumer. Bit-identical across runtimes.
  gaussKronrodAdaptiveBF,
  type BigFloatQuadResult,
  type BigFloatQuadOptions,
  BigFloatQuadratureError,
  MAX_DECIMAL_PRECISION,           // = 150 (driver's hard cap)
  getG7K15Table,                   // BigFloat nodes/weights at given workingBits
  type G7K15Table,

  // Closed-vocabulary integrand evaluator (float64 only).
  evalNumericExpr,
  ADMITTED_HEADS,
  ADMITTED_CONSTANTS,
  UnknownVocabularyError,
} from "@workbench/quadrature";
```

### Float64 — `gaussKronrodAdaptive(f, a, b, opts?)`

```ts
const r = gaussKronrodAdaptive(Math.sin, 0, Math.PI);
//  r.value          ≈ 2.0
//  r.errorEstimate  ≈ 0
//  r.nEvals         = 15
//  r.converged      = true
//  r.iterations     = 0
//  r.method         = "gauss-kronrod-g7k15"
//  r.warnings       = []
```

Wire encoding lives in `tools/integrate-1d/tool.ts`. ADR-0010's
`defineTool`/`runTool` split lets one implementation serve both
surfaces.

### Arb-prec — `gaussKronrodAdaptiveBF(f, a, b, prec, opts?)`

```ts
import { fromInt, sin } from "@workbench/bigfloat";

const r = gaussKronrodAdaptiveBF(
  (x, p) => sin(x, p),
  fromInt(0n),
  pi(decimalToBinaryPrecision(50, 30)),
  50,                                         // 50 decimal digits
);
//  r.value             ≈ 2.0 as BigFloat at 50 dps
//  r.errorEstimate     ≈ 10^-50 as BigFloat
//  r.precision         = 50 (decimal digits)
//  r.workingPrecision  = 196 (bits)
//  r.method            = "gauss-kronrod-g7k15-bigfloat"
//  r.converged         = true
```

The integrand callback takes `(x: BigFloat, prec: number) → BigFloat`.
The second argument is the *working* bit precision the driver wants the
integrand to honour — load-bearing for integrands that themselves do
arb-prec computation (e.g., Mellin-Barnes pFq).

## Algorithm (both tiers, same shape)

- **Local rule — `gaussKronrod15`/`localG7K15BF`**: a 7-point
  Gauss-Legendre rule nested inside a 15-point Kronrod extension over
  `[-1, 1]`, mapped affinely to a working subinterval. K15 is the
  integral estimate (algebraically exact for polynomials of degree ≤ 22
  per Patterson 1968); `|K15 − G7| · halfLength` is the local
  truncation-error estimate.

  At the float64 tier, K and G are computed as separate sums and
  subtracted; at 53-bit precision the cancellation in `K − G` loses at
  most ~ulp(K) bits, absorbed by the working margin.

  At the arb-prec tier, K15 is computed directly but `K − G` uses the
  **centred-delta identity** (ADR-0021):

  ```
  K15 - G7 = Σ_{i=0..6} (WGK[i] - WG[g(i)]) · (fSum_i - 2·f(centre))
  ```

  where `fSum_i = f(centre - h·xgk[i]) + f(centre + h·xgk[i])` and
  `g(i) = (i-1)/2` at Gauss-shared positions, undefined at Kronrod-only.
  Each `(fSum_i - 2·f(centre))` is the *variation* of the integrand
  across a symmetric pair of abscissae — small by construction. The
  centre's K-G contribution algebraically vanishes (proof in
  `gauss-kronrod-bf.ts`). This eliminates the catastrophic cancellation
  that would otherwise dominate at 200+ bit precision.

- **Global driver — `gaussKronrodAdaptive*`**: a max-heap of
  subintervals keyed on local error. Each iteration pops the worst
  subinterval, bisects, evaluates K15+G7 on the two halves, and pushes
  them back.

  Float64 driver: running totals updated *by delta* (`total += new −
  old`) — at 53-bit precision the cancellation is harmless.

  Arb-prec driver: running totals are **recomputed from the heap each
  iteration** — at 200+ bit precision the delta-update would chew
  through the running value's lower bits over many iterations. The
  heap-rebuild is O(heap size) but heapSize ≪ the 15-evaluation cost
  of one local rule call (each BigFloat sin / exp / Γ at workingBits
  is milliseconds; the heap walk is microseconds), so the perf cost
  is in the noise.

  Convergence test (both tiers): `errorEstimate ≤ atol + rtol·|value|`
  → `converged: true`. Budget hit → `converged: false` with a budget
  warning.

  Arb-prec driver additionally fires a **Cauchy value-stability**
  convergence when the running value's iteration-by-iteration change
  drops below the substrate's relative ulp times a small headroom
  factor for 8 consecutive iterations. Rationale: K-G measures G7's
  algebraic error which can floor far above the user's tolerance long
  before K15's actual error reaches the floor (especially for
  high-degree polynomial integrands and smooth analytic integrands).
  Cauchy stability declares convergence when the value has stabilised
  at the substrate's representable-precision floor — much tighter
  than the user's tolerance, so spurious early firing during heap
  traversal is robustly avoided. When Cauchy fires but K-G doesn't, a
  warning is added to the result.

Constants:

- **Float64 tier**: GSL `qk15.c` (BSD-equivalent reimpl of QUADPACK's
  `dqk15.f`); the source documents them as "evaluated with 80 decimal
  digit arithmetic by L. W. Fullerton, Bell Labs, Nov. 1981" — far
  above the float64 precision they round to.

- **Arb-prec tier**: 200-decimal-digit string literals stored in
  `nodes-weights-bf.ts`, generated via mpmath at 230 dps using the
  Stieltjes orthogonality construction (Patterson 1968 / Laurie 1997).
  The regeneration recipe is preserved in the file's header. Constants
  cross-verified against GSL's float64 values byte-for-byte at the
  truncated precision; algebraic exactness on `x^{2k}` for k = 0..11
  verified at residual ≈ 10^-231 (mpmath's 230-dps floor).

References: Piessens, de Doncker, Überhuber & Kahaner, *QUADPACK*
(1983); Galassi et al., *GNU Scientific Library Reference Manual*
§16.4; Kahaner, Moler & Nash, *Numerical Methods and Software* (1989,
Ch. 5); Patterson 1968 *Math. Comp.* 22(104); Laurie 1997 *Math. Comp.*
66(219); Monegato 2008 *Numer. Algorithms* 26(2).

## Closed integrand vocabulary (float64 surface only)

`evalNumericExpr` admits:

- **Heads:** `+`, `-`, `*`, `/`, `^`, `neg`, `exp`, `sin`, `cos`,
  `tan`, `log`, `sqrt`, `abs`, `asin`, `acos`, `atan`, `sinh`, `cosh`,
  `tanh`, `asinh`, `acosh`, `atanh`, `log2`, `log10`. `+` and `*` are
  n-ary; `-` accepts unary (`-x` ≡ `neg(x)`) or binary (`-(a, b)`).
- **Constants:** `pi` (≡ `Math.PI`), `e` (≡ `Math.E`).
- **Numeric leaves:** `integer` / `rational` / `float64` (the
  protocol's three numeric kinds).
- **Variables:** any other `symbol` is resolved via the `env: Map`.
  An unknown symbol raises `UnknownVocabularyError`.

Faithful to IEEE-754: `log(-1)` returns `NaN`, `1/0` returns
`+Infinity`. The quadrature driver catches non-finite values during
integration; the evaluator never silently substitutes.

The arb-prec surface does *not* have an analogous bridge in v0.1 —
its callers (`packages/meijer-core`'s contour layer, downstream tools)
compose BigFloat-typed integrands directly rather than walking a
`Value` tree.

## Scope

- **In:** finite real intervals `[a, b]` with `a < b`. Float64 tier
  for general numerical integration (single-platform determinism via
  ADR-0015 platform fingerprint). Arb-prec tier for problem-13-class
  integrands (Mellin-Barnes contours, Slater pFq composition,
  `tools/meijer-g` dispatcher).
- **Out (v0.1, all deliberate):** infinite intervals (Gauss-Hermite /
  Gauss-Laguerre would be sister tools), vector-valued or complex
  integrands (`BigComplex` codomain extension deferred to `hv0.8` per
  ADR-0021), higher-dimensional cubature, symbolic anti-derivatives,
  *high-precision* (≥ ~50 dps) on smooth analytic integrands with
  bounded Taylor radius (K15+adaptive saturates faster than the user
  tolerance can be met — for those cases tanh-sinh is the appropriate
  algorithm, filed as a follow-up).
- **Hard caps:** arb-prec tier refuses `prec > 150` decimal digits
  (the table cap, with safety margin); refuses `a >= b`; refuses
  `maxEvals < 15`; refuses non-integer `prec`.

## Tests

```sh
bun test packages/quadrature
```

106 tests in two files:

- `quadrature.test.ts` — 30 tests for the float64 driver: algebraic
  exactness on `x^k` for `k = 0..15`, hand-checked smooth integrals,
  oscillatory budget honesty, narrow-Gaussian-peak adaptivity,
  evaluator round-trips, non-finite boundary path. Mutation-proven.

- `quadrature-bf.test.ts` — 72 tests for the arb-prec driver:
  algebraic exactness on `x^k` for `k = 0..23` at 50 and 100 dps,
  cross-precision agreement against mpmath truths for sin and exp at
  30/50/80 dps, smooth-analytic value precision at 20 dps,
  bit-determinism (within-process; cross-runtime inherits from
  ADR-0020 substrate guarantee), oscillatory budget honesty, narrow
  Gaussian peak adaptivity, boundary refusals (cap violations,
  reversed/equal interval, sub-15 budget, integrand exception
  passthrough), default-tolerance scaling, table cache idempotency,
  rule-symmetry probes (Σ paired Kronrod weights = 2; Σ paired Gauss
  weights = 2 at 30/80/150 dps).
