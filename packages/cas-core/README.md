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

**Current size: 38 heads.** History: 27 in ADR-0023 v0.1; `Erfi` added
2026-05-16 per ADR-0040 §"Decision 6" (per-head Erf substrate, total
28); `HankelH1`, `HankelH2`, `SphericalBesselJ`, `SphericalBesselY`
added 2026-05-17 per ADR-0041 §"Decision 6" (per-head Bessel
substrate, total 32); `LogGamma`, `Pochhammer`,
`IncompleteGammaUpper`, `IncompleteGammaLower`, `Beta`, `BarnesG`
added 2026-05-19 per ADR-0042 §"Decision 6" (per-head Gamma
substrate, total 38).

| Family | Heads |
|---|---|
| Gamma | `Gamma`, `Digamma`, `Polygamma`, `LogGamma`, `Pochhammer`, `IncompleteGammaUpper`, `IncompleteGammaLower`, `Beta`, `BarnesG` |
| Bessel (cylindrical) | `BesselJ`, `BesselY`, `BesselI`, `BesselK` |
| Bessel (boundary: Hankel + spherical) | `HankelH1`, `HankelH2`, `SphericalBesselJ`, `SphericalBesselY` |
| Generalised hypergeometric | `HypergeometricPFQ` |
| Confluent / parabolic-cylinder | `WhittakerM`, `WhittakerW`, `ParabolicCylinderD` |
| Error / exponential / Fresnel integrals | `Erf`, `Erfc`, `Erfi`, `ExpIntegralEi`, `ExpIntegralE`, `FresnelC`, `FresnelS` |
| Legendre | `LegendreP`, `LegendreQ` |
| Other classical orthogonal polynomials | `LaguerreL`, `HermiteH`, `ChebyshevT`, `ChebyshevU`, `GegenbauerC` |
| Polylog / Lerch | `Polylog`, `LerchPhi` |
| Meijer-G (recursive head) | `MeijerG` |

Each head has an arity contract (`specialFunctionArity(head)`); the
contracts come in two shapes — `fixed { count: n }` for scalar-only
heads (`Gamma`: 1; `BesselJ`: 2; `WhittakerM`: 3; `Erfi`: 1;
`LogGamma`: 1; `BarnesG`: 1; `Beta`: 2; `Pochhammer`: 2;
`IncompleteGammaUpper / Lower`: 2) and `list-head` for the
Wolfram-encoded list-parameter heads (`HypergeometricPFQ` is
`(list, list, scalar)`; `MeijerG` is `(list-of-list, list-of-list,
scalar)`).

The differentiable subset — `SPECIAL_FUNCTION_DIFFERENTIABLE_HEADS` —
is the v0.1 list of heads with closed-form derivatives shipped under
ADR-0023 / ADR-0040 / ADR-0041 / ADR-0042: `Gamma`, `Digamma`,
`Polygamma`, `LogGamma`, `IncompleteGammaUpper`,
`IncompleteGammaLower`, `Beta`, `Erf`, `Erfc`, `Erfi`,
`ExpIntegralEi`, `ExpIntegralE`, `FresnelC`, `FresnelS`, `BesselJ`,
`BesselY`, `BesselI`, `BesselK`, `HankelH1`, `HankelH2`,
`SphericalBesselJ`, `SphericalBesselY`, `HermiteH`, `Polylog` (24 of
38). Heads admitted in the AST but not yet differentiable
(`Pochhammer` and `BarnesG` from the 2026-05-19 amendment;
`HypergeometricPFQ`, `MeijerG`, `WhittakerM`, `WhittakerW`,
`ParabolicCylinderD`, `LegendreP`, `LegendreQ`, `LaguerreL`,
`ChebyshevT`, `ChebyshevU`, `GegenbauerC`, `LerchPhi` from earlier
amendments) refuse honestly via `CasDiffOutOfScopeError` — same
boundary tag foreign heads take. See `tools/cas-diff/README.md` for
the per-head DLMF-cited rule table.

## Erf-family identity table (bead `bfwt`, worklog 134)

`packages/cas-core/src/special-funcs/erf-identities.ts` is the symbolic
identity table for the five Erf-family heads — `Erf`, `Erfc`, `Erfi`,
`InverseErf`, `InverseErfc`. It ports R1's 38-rule catalogue
(`docs/refs/erf-research/R1-symbolic-identities.md`) to the cas-core
AST and ships the v0.1-shippable subset (19 distinct rules covering
the 22 R1 §11 rule slots — special values, parity / odd symmetry, and
the Erfi → Erf canonicaliser per A3 / SymPy:erfi).

`tryErfSimplify(head, args)` is the per-head dispatcher. The companion
`collapseErfComplementPairs(summands)` runs as a sum-walker inside
`casSimplify` to collapse the cross-head identity `Erfc(z) + Erf(z) →
1` — the load-bearing end-to-end behaviour the dispatcher must
support (R1 §3 A1). The integration hook lives in
`packages/cas-core/src/simplify.ts`'s `applyErfRewrites` walker, which
runs bottom-up before the RatFn fold so the rewritten output composes
cleanly with the existing rational-function canonicalisation pipeline.

Encoding conventions worth knowing about (the file's top-of-module
narrative is the source of truth):
- `√π` is `mkPower(sym("pi"), rat(1n, 2n))` per ADR-0040 §"Decision 6"
  (matches `ruleErfi`; the older `ruleErf` uses `expr("sqrt", [sym("pi")])`
  — the unification is filed as a separate cas-core bead).
- The imaginary unit `i` is `sym("I")` — a bare distinguished symbol.
  cas-core has no `complex` head, no `Q[i]` value-level encoding, and
  no first-class `i` in the elementary vocab; the bare-symbol choice
  is the cheapest viable encoding for v0.1 and is documented in the
  module's top narrative.
- `+∞` is `sym("infinity")`, `−∞` is `mkNeg(sym("infinity"))` (R1 §11.1
  literal-of-record).

## Gamma-family identity table (bead `scientist-workbench-rknz`)

`packages/cas-core/src/special-funcs/gamma-identities.ts` is the
symbolic identity table for the nine Gamma-family heads — `Gamma`,
`LogGamma`, `Pochhammer`, `Digamma`, `Polygamma`,
`IncompleteGammaUpper`, `IncompleteGammaLower`, `Beta`, `BarnesG`. It
ports R1's rule catalogue
(`docs/refs/gamma-research/R1-symbolic-identities.md` §3) to the
cas-core AST and ships **48 rules** across five priority classes:

| Class | Rules | Content |
|---|---|---|
| A — special values + pole refusal | ~24 | Γ at 1/2, ±3/2, ±1/2, positive integers (factorial closure ≤ 22); LogGamma at positive integers + 1/2; pole-refusal at non-positive integers for Γ / LogGamma / Digamma / Polygamma (`tagged "cas-simplify/gamma-pole"`, payload `record{head, arg}`); BarnesG zeros at non-positive integers; Pochhammer at index 0 / 1; incomplete-Gamma boundary identities; Beta special values; BarnesG integer table G(1)=G(2)=G(3)=1, G(4)=2, G(5)=12 |
| B — half-integer + small-int closures | ~8 | Γ(3/2), Γ(5/2), Γ(-3/2); ψ(1), ψ(2), ψ(3), ψ(1/2), ψ(3/2); ψ'(1)=π²/6, ψ'(1/2)=π²/2; (a)_2 = a(a+1) |
| C — recurrences + reflection (load-bearing) | ~12 | Γ(z+1)=z·Γ(z); LogGamma(z+1) recurrence; Pochhammer recurrence; ψ(z+1)=ψ(z)+1/z; **ψ(1-z) reflection** (DLMF §5.5.4 — SIGN-CRITICAL, the `+π·cos(πz)/sin(πz)` form, see the file's top-of-module narrative for the sign argument); incomplete-Gamma recurrences (Γ(a+1, z) and γ(a+1, z), DLMF §8.8.1-2); Beta recurrence B(a+1, b); BarnesG functional equation G(z+1) = Γ(z)·G(z) (DLMF §5.17.1) |
| D — multiplication theorems | 3 | Legendre duplication Γ(2z) (DLMF §5.5.5); Digamma duplication ψ(2z) (DLMF §5.5.8); Polygamma recurrence ψ^{(m)}(z+1) for concrete m (DLMF §5.15.5) |
| E — small | covered by class A above | BarnesG integer table |

`tryGammaSimplify(head, args)` is the per-head dispatcher, mirroring
`tryErfSimplify` and `tryBesselSimplify`. The integration hook in
`packages/cas-core/src/simplify.ts` is `applyGammaRewrites`, a
bottom-up bounded-fixed-point walker that runs **after Erf and after
Bessel, before the RatFn fold** (per ADR-0042 §"Decision 13"). The
three per-head pre-passes are independent (an Erf-rewritten subtree
contains no Bessel or Gamma heads, etc.); the declared sequence
matches the historical landing order.

Encoding conventions specific to the Gamma table (the file's top-of-
module narrative is the source of truth):
- `√π` is `mkPower(sym("pi"), rat(1n, 2n))` — same encoding the Erf
  and Bessel tables use (ADR-0040 §"Decision 6").
- Euler–Mascheroni constant `γ_E` is `sym("EulerGamma")` (SymPy /
  Mathematica convention; R1 §3 documents the choice).
- Pole-refusal tag is `"cas-simplify/gamma-pole"` — the outer
  dispatcher's namespace, not the per-head module's. Tag payload is
  `record { head: sym(<HeadName>), arg: <offending value> }` for
  self-describing refusal. BarnesG at non-positive integers is the
  *single* exception: it emits `int(0n)` because BarnesG vanishes
  (not diverges) at those points (DLMF §5.17.1).
- The **Digamma reflection sign is PLUS**: `ψ(1-z) = ψ(z) +
  π·cos(πz)/sin(πz)`. The DLMF §5.5.4 identity reads `ψ(1-z) - ψ(z) =
  +π·cot(πz)`; rearranging for `ψ(1-z)` keeps the + sign. The test
  file's non-half-integer canary (`ψ(1-(-1/3)) reflection`) catches a
  mutation that swaps the sign — at half-integer z the cot term is
  zero and a sign error would be invisible.

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
- ADR-0041 — per-head Bessel substrate; amends ADR-0023 to admit
  `HankelH1`, `HankelH2`, `SphericalBesselJ`, `SphericalBesselY`
- ADR-0042 — per-head Gamma substrate; amends ADR-0023 to admit
  `LogGamma`, `Pochhammer`, `IncompleteGammaUpper`,
  `IncompleteGammaLower`, `Beta`, `BarnesG`
- `docs/worklog/074-*.md` — original `cas-diff` shard
- `tools/cas-diff/README.md` — the diff-rule table this package
  implements
