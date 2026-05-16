# @workbench/cas-core

Symbolic computer-algebra substrate for the scientist-workbench:
multivariate `Q[x_1,…,x_n]` and `Q(x_1,…,x_n)` arithmetic; ring-generic
`Poly<T>` / `RatFn<T>` over `Field<T>` dictionaries (ADR-0008); a
closed-vocabulary symbolic differentiator (`differentiate`); a closed-
vocabulary special-function AST table (ADR-0023); and the smart-
constructor primitives (`mkPlus`, `mkTimes`, `mkPower`, …) that absorb
local algebraic identities for downstream rewriters. Pure TypeScript on
Bun — no FFI, no subprocess, deterministic by construction.

Primary consumers: `tools/cas-simplify`, `tools/cas-diff`,
`tools/cas-verify`, `packages/meijer-core` (symbolic dispatch rules),
`packages/quadrature` (the float64 evaluator borrows the closed-
vocabulary discipline).

## Determinism contract

Default symbolic tier — every operation is bit-identical cross-platform
forever. No platform fingerprint; no precision argument. This is the
unconditional ADR-0015 baseline (the strongest the workbench ships,
matched only by `@workbench/bigfloat`'s `arbprec: true` substrate).

## Special-function vocabulary (ADR-0023)

`SPECIAL_FUNCTION_HEADS` is the closed enumeration of special-function
AST heads admitted by the workbench's symbolic-computation layer. The
table is exhaustive — future additions require a deliberate edit plus
an ADR amendment, never silent runtime registration (the
TS-expert-irresistibility principle, ADR-0009; the "closed vocabulary,
not open registry" decision in ADR-0023).

**Current size: 28 heads** (27 in ADR-0023 v0.1; `Erfi` added
2026-05-16 per ADR-0040 §"Decision 6" — the per-head Erf substrate
needs `Erfi` as a first-class head for the bidirectional Meijer-G
bridge, which treats `Erf` / `Erfc` / `Erfi` symmetrically).

| Family | Heads |
|---|---|
| Gamma | `Gamma`, `Digamma`, `Polygamma` |
| Bessel (cylindrical) | `BesselJ`, `BesselY`, `BesselI`, `BesselK` |
| Generalised hypergeometric | `HypergeometricPFQ` |
| Confluent / parabolic-cylinder | `WhittakerM`, `WhittakerW`, `ParabolicCylinderD` |
| Error / exponential / Fresnel integrals | `Erf`, `Erfc`, `Erfi`, `ExpIntegralEi`, `ExpIntegralE`, `FresnelC`, `FresnelS` |
| Legendre | `LegendreP`, `LegendreQ` |
| Other classical orthogonal polynomials | `LaguerreL`, `HermiteH`, `ChebyshevT`, `ChebyshevU`, `GegenbauerC` |
| Polylog / Lerch | `Polylog`, `LerchPhi` |
| Meijer-G (recursive head) | `MeijerG` |

Each head has an arity contract (`specialFunctionArity(head)`); the
contracts come in two shapes — `fixed { count: n }` for scalar-only
heads (`Gamma`: 1; `BesselJ`: 2; `WhittakerM`: 3; `Erfi`: 1) and
`list-head` for the Wolfram-encoded list-parameter heads
(`HypergeometricPFQ` is `(list, list, scalar)`; `MeijerG` is
`(list-of-list, list-of-list, scalar)`).

The differentiable subset — `SPECIAL_FUNCTION_DIFFERENTIABLE_HEADS` —
is the v0.1 list of heads with closed-form derivatives shipped under
ADR-0023 / ADR-0040: `Gamma`, `Digamma`, `Polygamma`, `Erf`, `Erfc`,
`Erfi`, `ExpIntegralEi`, `ExpIntegralE`, `FresnelC`, `FresnelS`,
`BesselJ`, `BesselY`, `BesselI`, `BesselK`, `HermiteH`, `Polylog` (16
of 28). Heads admitted in the AST but not yet differentiable refuse
honestly via `CasDiffOutOfScopeError` — same boundary tag foreign
heads take. See `tools/cas-diff/README.md` for the per-head DLMF-cited
rule table.

## Public surface (selected)

```ts
import {
  // Differentiation (DLMF-cited closed-form rules)
  differentiate,
  CasDiffOutOfScopeError,
  DIFF_ADMITTED_HEADS,
  DIFF_ADMITTED_CONSTANTS,

  // Special-function vocabulary
  SPECIAL_FUNCTION_HEADS,
  SPECIAL_FUNCTION_DIFFERENTIABLE_HEADS,
  specialFunctionArity,
  differentiateSpecialFunction,

  // Smart constructors (worklog 077)
  mkPlus, mkMinus, mkNeg, mkTimes, mkDiv, mkPower,
  isZero, isOne, ZERO, ONE,

  // Simplify / verify
  casSimplify,
  casVerify,

  // Poly / RatFn ring-generic surface (ADR-0008)
  type Ring, type Field,
  type Rat, RAT_RING, makeRat,
  type Poly, polyAdd, polyMul, polyGcd, polyDivExact,
  type RatFn, RATFN_ZERO, RATFN_ONE, makeRatFnQ,
} from "@workbench/cas-core";
```

## See also

- ADR-0008 — ring-generic refactor
- ADR-0009 — TS-native idiom (the closed-vocabulary discipline)
- ADR-0023 — special-function vocabulary table
- ADR-0025 — Meijer-G symbolic dispatch
- ADR-0040 — per-head special-function substrate (Erf reference impl;
  amends ADR-0023 to admit `Erfi`)
- `docs/worklog/074-*.md` — original `cas-diff` shard
- `tools/cas-diff/README.md` — the diff-rule table this package
  implements
