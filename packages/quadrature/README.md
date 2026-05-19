# @workbench/quadrature

Adaptive 1D quadrature, four drivers covering two precision tiers,
two algorithm classes, and two codomains. The substrate behind
`tools/integrate-1d` (float64, real codomain) and the in-process surface
for arb-prec consumers (`packages/meijer-core`'s Slater inner-pFq usage
and Mellin-Barnes contour layer).

| Driver                       | Precision | Algorithm   | Codomain     | ADR | Consumer                                      |
|------------------------------|-----------|-------------|--------------|-----|-----------------------------------------------|
| `gaussKronrodAdaptive`       | float64   | G7K15+bisect| real         | 0014| `tools/integrate-1d`                          |
| `gaussKronrodAdaptiveBF`     | arb-prec  | G7K15+bisect| `BigFloat`   | 0021| arb-prec real-codomain consumers              |
| `gaussKronrodAdaptiveBC`     | arb-prec  | G7K15+bisect| `BigComplex` | 0022| `packages/meijer-core`'s contour layer        |
| `tanhSinhAdaptiveBF`         | arb-prec  | DE-rule     | `BigFloat`   | 0024| smooth-analytic 50–1000 dps integrands        |

Use G7K15 for general (oscillatory, mildly singular, mixed-class)
integrands; use tanh-sinh for **smooth-analytic** integrands at
**50+ dps** where G7K15's algebraic decay rate (~`1/N^k` with k=13)
saturates before the user tolerance is met. The canonical case is
`∫_0^1 1/(1+x²) dx` at 100 dps — G7K15 needs astronomical iterations,
tanh-sinh needs ~7 levels and 600 evaluations.

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

  // Arb-prec, BigComplex codomain (ADR-0022) — Mellin-Barnes contour
  // quadrature surface. Faithful lift of the BF driver to BigComplex;
  // on real-only integrands returns byte-identical bytes to the BF driver.
  gaussKronrodAdaptiveBC,
  type BigComplexQuadResult,
  type BigComplexQuadOptions,
  BigComplexQuadratureError,

  // Tanh-sinh (double-exponential) at arb-prec (ADR-0024). For
  // smooth-analytic integrands at 50+ dps where G7K15's algebraic
  // error decay saturates. Same return type as gaussKronrodAdaptiveBF;
  // discriminated by `method = "tanh-sinh-bigfloat"`.
  tanhSinhAdaptiveBF,
  type TanhSinhBFOptions,

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

### Arb-prec, BigComplex codomain — `gaussKronrodAdaptiveBC(f, a, b, prec, opts?)`

```ts
import { fromInt, cos, sin } from "@workbench/bigfloat";

const r = gaussKronrodAdaptiveBC(
  (t, p) => ({ re: cos(t, p), im: sin(t, p) }),  // ∫ e^{it} dt
  fromInt(0n),
  fromInt(1n),
  50,                                              // 50 decimal digits
);
//  r.value             { re, im } as BigComplex at 50 dps
//                      = { sin(1), 1 - cos(1) } in this case
//  r.errorEstimate     real BigFloat: cabs(K - G) · halfLength
//  r.precision         = 50
//  r.workingPrecision  = 196 (bits)
//  r.method            = "gauss-kronrod-g7k15-bigcomplex"
//  r.converged         = true
```

The integration variable `t` is real (`BigFloat`); the codomain is
`BigComplex`. The natural surface for Mellin-Barnes contour quadrature:
parameterise the vertical line `s = c + it` by `t ∈ ℝ` and integrate.
The driver is a faithful lift of the BF driver — on real-only
integrands (`im ≡ 0`) it returns byte-identical `value.re` and
`errorEstimate` bytes to the BF driver. Centred-delta K-G identity
ports verbatim component-wise; error estimate is the natural scalar
`cabs(K - G) · halfLength`. ADR-0022.

### Arb-prec tanh-sinh — `tanhSinhAdaptiveBF(f, a, b, prec, opts?)`

```ts
import { fromInt, add, mul, div } from "@workbench/bigfloat";

const r = tanhSinhAdaptiveBF(
  // INTEGRAND CONTRACT (worklog 077): every constant must use the
  // supplied `p`, not `fromInt(1n)` (default 53 bits). Substrate `div`
  // doesn't account for low-precision dividends and silently quantises
  // the result.
  (x, p) => {
    const onePlusXsq = add(fromInt(1n, p), mul(x, x, p), p);
    return div(fromInt(1n, p), onePlusXsq, p);
  },
  fromInt(0n),
  fromInt(1n),
  100,                                          // 100 decimal digits
);
//  r.value             ≈ π/4 as BigFloat at 100 dps
//  r.errorEstimate     ≈ 10^-101 as BigFloat
//  r.precision         = 100
//  r.workingPrecision  = 413 (bits)
//  r.iterations        = 7 (level count, not bisections)
//  r.method            = "tanh-sinh-bigfloat"
//  r.converged         = true
```

The variable transformation `x = tanh((π/2)·sinh t)` makes the
transformed integrand `f(g(t))·g'(t)` decay doubly-exponentially at
`t → ±∞`; by Euler-Maclaurin (Bailey 2005 §4) the trapezoidal rule on
this transformed integrand converges *faster than any power of h*.
Practical rate: doubling the level count roughly doubles the number
of correct digits — so prec=400 dps reaches the floor at level 8-9
(Bailey Table 1).

**Use this driver when**: the integrand is real-valued, smooth (all
derivatives bounded on `[a, b]`), analytic in a strip of the complex
plane around `[a, b]`, and you want 50+ dps. The canonical case is
`∫_0^1 1/(1+x²) dx = π/4` at 100 dps. Use `gaussKronrodAdaptiveBF`
instead for: oscillatory integrands (G7K15+bisection adapts naturally
to oscillation), endpoint-singular integrands (v0.1 of tanh-sinh
defers the secondary-epsilon trick that handles those), or any
integrand where 30 dps suffices (G7K15 is faster).

## Algorithm (all four drivers, same shape)

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

## Special-function extension (ADR-0040)

The closed integrand vocabulary above is the *integrand* surface
consumed by `tools/integrate-1d` — deliberately narrow. The
*special-function* surface — wider, accommodating Erf today and Bessel
/ Whittaker / Legendre as future ADRs ship — lives in the sibling
`evalNumericExprWithSpecial`. It accepts every elementary head AND
the six Erf-family heads pinned by ADR-0040 Decision 4:

- **Heads added:** `Erf`, `Erfc`, `Erfcx`, `Erfi`, `InverseErf`,
  `InverseErfc`. All unary; all float64 → float64.

Per-head implementations live in
`src/special-funcs/erf-float64.ts`:

- **Real `erf`/`erfc`/`erfcx`** — verbatim port of Sun Microsystems
  1993 `s_erf.c` (musl / glibc / FreeBSD lineage; ≤ 1 ULP `erf`,
  ≤ 2 ULP `erfc`). The five-piece dispatch on `|x|` and the
  `SET_LOW_WORD(s, 0)` mantissa-mask trick (as a JS `maskLowWord`
  DataView helper) are the load-bearing numerical structure. License:
  BSD-permissive Sun 1993 notice carried verbatim in the module
  header.
- **Real `erfi`** — `erfi(x) = exp(x²) · w_im(x)` where `w_im(x) =
  (2/√π)·Dawson(x) = Im[w(x)]` is computed via the 100-panel
  Chebyshev `wImY100` (Faddeeva-Johnson, MIT, 2012) for `|x| ≤ 45`
  and a 5-term continued-fraction expansion for `|x| > 45`. Inherits
  Faddeeva-Johnson's ≤ ULP real-axis precision; the previous v0.1
  asymptotic-series fallback (precision-limited to ≈ 1e-7 at x=4 and
  ≈ 1e-11 at x=5 by the inherent asymptotic-truncation floor) is
  retired (worklog 167 / bead `nxvu`).
- **Complex `w`/`erf`/`erfc`/`erfcx`/`erfi`** — full port of Stephen
  G. Johnson's Faddeeva library (MIT, 2012). Hybrid dispatch
  preserved verbatim from `Faddeeva.cc` lines 692-984:
  Zaghloul-Ali Algorithm 916 (`ACM TOMS 38(2), 2011`) for the bulk;
  Poppe-Wijers 1990 continued fraction (`ACM TOMS 16(1)`) for the
  large-`|z|` envelope (`|Im z| > 7` OR `|Re z| > 6 ∧ |Im z| > 0.1`
  …); the 100-panel Chebyshev `w_im_y100` on the real axis; SunPro
  `erfcx` on the imaginary axis; and two complex-`erf` Taylor
  branches (`taylor` for `|x| < 0.08 ∧ |y| < 0.01`; `taylor_erfi`
  for `|x| < 5e-3 ∧ |Re·Im| < 2.5e-3`) to handle the
  `1 − exp(−z²)·w(iz)` cancellation strips. License: MIT notice
  carried verbatim in the source header. **Accuracy contract**:
  ≤ Faddeeva-Johnson's published `1e-13` relative error across all
  of ℂ. The v0.1 "CF-universal" regression (worklog 167) that lost
  1-3 orders of magnitude at `|z| < 1.5` is retired.
- **`erfinv`/`erfcinv`** — Blair, Edwards & Johnson 1976 rational
  approximants (Tables 17/37/57 for erfinv, Tables 57/80 for
  erfcinv) plus one Newton-Raphson refinement step (≤ 8 ULP vs
  SciPy in the ill-conditioned saturation regime, where multiple
  float64 inputs round to the same `erf` value).

The extension obeys the same `numerical: true` determinism contract
as the integrand evaluator: bit-identical given the platform
fingerprint, pure JS with no FFI or platform-conditional branches.

```ts
import {
  evalNumericExprWithSpecial,
  SPECIAL_HEADS,            // ["Erf", "Erfc", "Erfcx", "Erfi", "InverseErf", "InverseErfc"]
  erfFloat64,               // direct call without going through AST
  erfcFloat64,
  erfcxFloat64,
  erfiFloat64,
  erfInvFloat64,
  erfcInvFloat64,
  wFunctionFloat64,
  erfComplexFloat64,
  erfcComplexFloat64,
  erfcxComplexFloat64,
  erfiComplexFloat64,
  type ComplexF64,
} from "@workbench/quadrature";

// AST surface:
//   import { expr, float64FromNumber } from "@workbench/protocol";
//   evalNumericExprWithSpecial(
//     expr("Erf", [float64FromNumber(0.5)]),
//     new Map(),
//   )                                  // → 0.5204998778130465
```

`tools/integrate-1d` continues to use the elementary-only
`evalNumericExpr` from `eval-expr.ts`. An `Erf` in the integrand
surfaces there as `UnknownVocabularyError` — which is the right
failure: integration with Erf in the integrand requires the agent to
opt into `tools/special-eval` (filed under ADR-0040 Decision 7) when
that ships.

## Bessel-family extension (ADR-0041)

Per ADR-0041 §Decision 4, the special-function dispatcher is extended
with the Bessel family. Per-head implementations live in
`src/special-funcs/bessel-float64.ts` (~2715 LOC):

- **Heads added:** `BesselJ`, `BesselY`, `BesselI`, `BesselK`. All
  arity-2 `(ν, z)`; all float64 → float64. Plus internal scaled
  variants (`besselIScaledFloat64`, `besselKScaledFloat64`) and 4
  complex entry points (`besselJComplexFloat64`, etc.) reachable
  directly without going through the AST evaluator.
- **Sources** (per R3 §0.1): SunPro 1993 `j0.c` / `j1.c` / `jn.c` for
  integer-order J/Y; Cephes (Moshier 2000) `i0.c` / `i1.c` / `k0.c` /
  `k1.c` for I/K integer order; DLMF series + Hankel asymptotic for
  general-ν; AMOS-rotation path for complex (full Fortran port deferred
  as `BESSEL-AMOS-FULL`).
- **Accuracy** (per ADR-0041 §Acceptance): ≤ 2-4 ULP for real
  J/Y/I/K integer order; ≤ 4 ULP typical for general-ν; complex paths
  ≤ ~10-12 dp at v0.1.

## Gamma-family extension (ADR-0042)

Per ADR-0042 §Decision 4, the special-function dispatcher is extended
with the Gamma family. Per-head implementations live in
`src/special-funcs/gamma-float64.ts` (~2100 LOC):

- **Heads added (19 entries):** `Gamma`, `LogGamma`, `Digamma`,
  `Trigamma`, `Polygamma`, `Pochhammer`, `IncompleteGammaUpper`,
  `IncompleteGammaLower`, `IncompleteGammaP`, `IncompleteGammaQ`,
  `InverseIncompleteGammaP`, `InverseIncompleteGammaQ`, `Beta`,
  `LogBeta`, `IncompleteBeta`, `BarnesG`, `Hyperfactorial`,
  `GammaRatio`, `GammaDeltaRatio`, `GammaPDerivative`. Arities 1
  (`Gamma`/`LogGamma`/`Digamma`/`Trigamma`/`BarnesG`/`Hyperfactorial`),
  2 (most), and 3 (`IncompleteBeta`). All float64 → float64; plus 3
  complex entry points (`lgammaComplexFloat64`, `gammaComplexFloat64`,
  `digammaComplexFloat64`) for `(re, im) → {re, im}`.
- **Sources** (per R3 §0.0 + §1 verbatim-port table):
  - `gammaFloat64` — Cephes `gamma.c` (Moshier 2000), P[7]/Q[8] rational
    on `[2, 3]` + Stirling `stirf` for x > 33 + integer factorial table
    for n ≤ 22.
  - `lgammaFloat64` — FreeBSD `e_lgamma_r.c` (SunPro 1993 lineage; same
    provenance as `j0.c` and `s_erf.c`). Five-region dispatch with
    minimax pivot at `tc ≈ 1.46163` + sign tracked via `{value, sign}`
    discriminated record.
  - `digammaFloat64` — Boost.Math `digamma.hpp` 53-bit specialisation
    `(x - root) · (Y + R(x-1))` rational on `[1, 2]` + Stirling for
    x ≥ 10 + reflection for x < 0. **The reflection identity (DLMF
    §5.5.4) is implemented directly**, so `digamma(-0.5) ≈ 0.03649`
    per DLMF, NOT the Boost-1.83 buggy `ψ(1/2)` value.
  - `trigammaFloat64` / `polygammaFloat64` — Boost.Math
    `polygamma.hpp` Bernoulli expansion via Hurwitz zeta route.
  - `gammaPFloat64` / `gammaQFloat64` — Cephes `igam.c` mutual-dispatch
    (series for `x < a + 1`, continued fraction otherwise; CF rescaling
    via `IGAM_BIG = 4.5e15` empirically calibrated constants).
  - `incBetaFloat64` — Cephes `incbet.c` series + CF1/CF2 dispatch.
  - `barnesGFloat64` — Adamchik 1998 asymptotic (DLMF §5.17.5) +
    integer table + Glaisher-Kinkelin constant. v0.1 accuracy at
    non-integer x is ~1e-5 (asymptotic carve-out per R3 §9.5; v0.2
    upgrade filed).
  - **Complex paths**: SciPy `_loggamma.pxd` Stirling + reflection (≤
    14 dp). Complex incomplete gamma, complex BarnesG, complex
    polygamma m ≥ 2 are honest refusals — no battle-tested float64
    algorithm exists; the arb-prec lane carries those cases.

- **Accuracy** (per ADR-0042 §Acceptance):
  - Closed-form goldens (`Γ(1/2)=√π`, `Γ(-1/2)=-2√π`, `Beta(1/2,1/2)=π`,
    `ψ(1)=-γ`, `ψ^(2)(1)=-2ζ(3)`): match within 2-16 ULP.
  - mpmath gold-tier oracle cross-validation: max relative error
    ≤ 5e-15 on 35 T1/T5 inputs (excluding BarnesG at large x, the
    documented v0.1 carve-out).
  - `P(a, z) + Q(a, z) = 1` to machine precision; `γ(a, z) + Γ(a, z) =
    Γ(a)` to ≤ 1e-12 relative.
  - Digamma reflection: `digamma(-0.5) = ψ(3/2) ≈ 0.0365` (NOT
    Boost-1.83's bug value `-1.96`).

## Scope

- **In:** finite real intervals `[a, b]` with `a < b`. Float64 tier
  for general numerical integration (single-platform determinism via
  ADR-0015 platform fingerprint). Arb-prec tier for problem-13-class
  integrands (Mellin-Barnes contours, Slater pFq composition,
  `tools/meijer-g` dispatcher).
- **Out (v0.1, all deliberate):** infinite intervals (Gauss-Hermite /
  Gauss-Laguerre would be sister tools), vector-valued integrands,
  higher-dimensional cubature, symbolic anti-derivatives. Endpoint-
  singular integrands at high prec (`√t/√(1-t²)`, `log²t`) are
  out for tanh-sinh v0.1 (Bailey §3's secondary-epsilon trick, filed
  as a follow-up); G7K15+bisection handles weak endpoint singularities
  via natural endpoint refinement at moderate prec. The BigComplex
  driver shares the same scope caveats as the BF driver.
- **Hard caps:** arb-prec tier refuses `prec > 150` decimal digits
  (the table cap, with safety margin); refuses `a >= b`; refuses
  `maxEvals < 15`; refuses non-integer `prec`.

## Tests

```sh
bun test packages/quadrature
```

167 tests in four files:

- `quadrature.test.ts` — 30 tests for the float64 driver: algebraic
  exactness on `x^k` for `k = 0..15`, hand-checked smooth integrals,
  oscillatory budget honesty, narrow-Gaussian-peak adaptivity,
  evaluator round-trips, non-finite boundary path. Mutation-proven.

- `quadrature-bf.test.ts` — 76 tests for the arb-prec driver:
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

- `quadrature-bc.test.ts` — 35 tests for the arb-prec BigComplex
  driver: faithful-extension byte-equality with the BF driver on
  real-only integrands (the load-bearing mutation-prove that BC is BF
  lifted, not an independent reimplementation), algebraic exactness
  on `(c0 + i·c1)·t^k`, `∫_0^{2π} e^{i·t} dt = 0` (canonical complex
  cancellation probe), `∫_0^1 (cos+i·sin) dt = sin(1) + i·(1−cos(1))`
  against mpmath at 30/50/80 dps, bit-determinism (BigComplex
  components and BigFloat error), tight-budget oscillatory honesty,
  boundary refusals (matching BF driver semantics), default-tolerance
  scaling, result shape, integrand-linearity probe.

- `tanh-sinh-bf.test.ts` — 26 tests for the arb-prec tanh-sinh
  driver: closed-form anchors at 30/50/100 dps for `t·log(1+t)` and
  `1/(1+x²)` (the worklog-072 motivating case, resolved in worklog
  077); cross-validation against `gaussKronrodAdaptiveBF` on entire
  functions (sin, exp at 50 dps); cross-validation against
  Wolfram + mpmath truths at 50 + 100 dps for `e^{-x²}`,
  `1/(1+x⁴)` (sister of the bug-case), `1/(2+cos x)`;
  bit-determinism on `1/(1+x²)` at 50 dps; convergence-flag honesty
  under tight `maxLevels`; boundary refusals; default-tolerance
  scaling; result-shape validation. Mutation-proven against four
  invariants (sinh↔cosh swap, halveBF /4, convergence-test inversion,
  integrand-precision regression) — see worklog 077 §"Mutation-prove
  protocol".
