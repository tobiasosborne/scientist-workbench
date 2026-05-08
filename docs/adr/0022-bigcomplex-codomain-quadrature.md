# ADR-0022 — BigComplex-codomain generalisation of the G7K15 quadrature substrate

**Status:** Accepted — 2026-05-08
**Beads:** scientist-workbench-hv0.8 (this ADR + the
`packages/quadrature` BigComplex-codomain extension it specifies, plus
the `packages/meijer-core` Mellin–Barnes contour layer that consumes
it); parent epic scientist-workbench-hv0 (problem-13 Meijer G mega-test).
**Related:** ADR-0014 (first numerical tier — the float64 G7K15 driver
that began the lineage); ADR-0020 (arbprec tier — the unconditional
bit-determinism contract that this driver inherits); ADR-0021 (arb-prec
real-codomain G7K15 driver that this ADR directly extends, including
the cancellation-stable centred-delta K-G identity that survives the
codomain change verbatim); ADR-0009 (TS-native idiom — the framework
under which "two named drivers" beats one generic).

## Context

ADR-0021 shipped `gaussKronrodAdaptiveBF`: an adaptive G7K15 driver on
`(x: BigFloat, prec: number) => BigFloat`. Its "What we will not decide
here" §"`BigComplex` codomain" deferred the complex-codomain extension
to the design site of its consumer — `hv0.8`, the Mellin–Barnes contour
quadrature layer of `packages/meijer-core`.

That consumer is now ready to land. The Mellin–Barnes contour
integrand is intrinsically complex-valued: the contour is a vertical
line `Re(s) = c, t ∈ ℝ` parameterised as `s = c + it`, and the
integrand `Π Γ(b_j − s) · Π Γ(1 − a_j + s) · z^s / [Π Γ(1 − b_j + s) ·
Π Γ(a_j − s)]` evaluates to a `BigComplex` at every `t`. The
quadrature variable `t` is real; the codomain is complex. The driver
the consumer wants is "G7K15 over a real interval `[a, b]`, integrand
returns `BigComplex`, error estimate is `|K − G|` as a real
`BigFloat`."

## The axioms (re-applied)

ADR-0009 — *what would a TS expert reach for, without thinking*:

* `gaussKronrodAdaptiveBC(f, a, b, prec, opts?)` — the codomain is in
  the suffix exactly as in `gaussKronrodAdaptiveBF`. Reading the name,
  the TS expert immediately knows: "BigComplex codomain, same algorithm
  shape." No field-record argument, no generic `<T, RealOf<T>>` to
  reason about, no codomain-by-callback-shape inference puzzle.

* The driver returns `BigComplexQuadResult { value: BigComplex,
  errorEstimate: BigFloat, … }`. A TS expert handed this result reaches
  for `result.value.re` and `result.value.im` exactly as expected.
  `errorEstimate` is real because `|K − G|` is the natural scalar bound;
  agents reason about it the same way they reason about the float64 and
  BigFloat error estimates.

ADR-0021 — *the centred-delta K-G identity is load-bearing at high
precision*. That identity is purely algebraic (`K - G = Σ (WGK_i -
WG_i) · δ_i` where `δ_i = fSum_i - 2·f(centre)`) and works
component-wise in any codomain that is a vector space over the reals.
For BigComplex it specialises to per-component: `δ_i.re = fSum_i.re -
2·f(centre).re`, `δ_i.im = fSum_i.im - 2·f(centre).im`, and `K - G` is
itself BigComplex. We carry the identity verbatim and take `|K - G|`
(via `cabs`, the safe `max·sqrt(1 + (min/max)²)` formula) at the end as
the heap key and convergence estimate.

## Decision

Five additive changes. None breaks the existing real drivers' bytes;
none changes the wire surface of `tools/integrate-1d`.

### 1. New driver `gaussKronrodAdaptiveBC` in `packages/quadrature`

Public surface:

```ts
gaussKronrodAdaptiveBC(
  f: (t: BigFloat, prec: number) => BigComplex,
  a: BigFloat,
  b: BigFloat,
  prec: number,
  opts?: BigComplexQuadOptions,
): BigComplexQuadResult
```

The integration variable `t` is real (a `BigFloat`); the codomain is
BigComplex. This is what the Mellin–Barnes consumer wants: parameterise
the vertical line `s = c + it` by `t ∈ ℝ`, evaluate the integrand at
each `t`, and integrate.

Result shape:

```ts
type BigComplexQuadResult = {
  readonly value: BigComplex;
  readonly errorEstimate: BigFloat;       // |K - G| · |halfLength|
  readonly precision: number;
  readonly workingPrecision: number;
  readonly nEvals: number;
  readonly converged: boolean;
  readonly iterations: number;
  readonly method: "gauss-kronrod-g7k15-bigcomplex";
  readonly warnings: readonly string[];
};
```

Two surface differences from `BigFloatQuadResult`:

* **`value` is `BigComplex`**, not `BigFloat`. Same precision contract:
  the user requested `prec` decimal digits, both components are rounded
  there in the final `roundToBC` step.
* **`errorEstimate` is `BigFloat` (real)**. `cabs(K - G)` is the natural
  scalar bound — both components are individually bounded, so the
  scalar `cabs` carries the convergence signal cleanly. The convergence
  test `errorEstimate ≤ atol + rtol · |value|` uses `cabs(value)` on
  the right-hand side, again real-valued.

### 2. Centred-delta K-G identity ports verbatim, component-wise

The local-rule loop in `gauss-kronrod-bf.ts` (§"localG7K15BF") ports
verbatim under the type substitution `BigFloat → BigComplex` for `f`,
`fSum`, `fCentre`, `delta`, `K15`, and `kMinusG`. The weights `WGK[i]`,
`WG[i]`, `WGK_i - WG_i` remain `BigFloat` (the rule's nodes and weights
are inherently real). Each `(WGK_i - WG_i) · δ_i` term is `BigFloat ·
BigComplex = BigComplex` via per-component multiplication. The K-G
accumulator is `BigComplex`; `cabs(K-G) · halfLength` (real BigFloat) is
the error estimate.

The cancellation-stability argument from ADR-0021 holds component-wise:
each `δ_i.re` and `δ_i.im` is small (~ `f'(centre).re/im · halfLength
· 2·xgk_i`), each weighted-delta is small in both components, and
neither component sum suffers large-vs-large cancellation.

### 3. Heap key is real

The max-heap orders subintervals by `subinterval.error`, a real
`BigFloat`. We do **not** invent a complex ordering — there is no
useful one. The same `cmp(a.error, b.error)` from `gauss-kronrod-bf.ts`
ports verbatim. Bisect-the-largest-error-first is what we want, and
"largest" is unambiguously defined on the real `cabs(K-G) ·
halfLength`.

### 4. Cauchy value-stability test compares `cabs(valueChange)` to
threshold

The arb-prec real driver's secondary convergence test fires when
`|value - prevValue| ≤ |value| × 2^-(workingBits - 30)` for 8
consecutive iterations. The complex generalisation: track
`cabs(csub(value, prevValue)) ≤ cabs(value) × 2^-(workingBits - 30)`.
Both sides are `BigFloat`; the comparison is `cmp` exactly as before.
The component-wise interpretation is honest — value-stability in *both*
real and imaginary parts is what we want before declaring convergence.

### 5. No new wire tool in v0.1; library extension only

Same reasoning as ADR-0021 §1. The near-term consumer (`hv0.8`'s
`meijergContour`) is in-process. A wire tool would be dead surface
until `tools/meijer-g` (`hv0.10`) ships. When it does, the right
shape is a thin wrapper analogous to `tools/meijer-g-slater-only`
(worklog 070); the algorithm stays in the package. ADR-0010 is the
load-bearing layering rule.

`tools/integrate-1d` continues to be float64-only with a real codomain.
A future ADR can promote a complex variant when an agent surface needs
it.

## What this does *not* introduce

* **Complex contour deformation as a driver feature.** The driver
  integrates over the real interval `[a, b]`. Steepest-descent contour
  deformation, branch-cut routing, and saddle-point analysis live in
  the consumer (`packages/meijer-core/src/contour.ts`). This is
  consistent with the float64/real layering — `gaussKronrodAdaptive`
  doesn't know about geodesic distances or singularity tracking either.

* **Component-wise per-pass driver.** An alternative shape is "run the
  real driver twice (Re-pass, Im-pass) with a memoising integrand
  cache." Rejected because the two passes' bisection trees diverge
  (the heap is keyed on each pass's local K-G, which differs between
  Re and Im for general integrands), so the cache hit rate is poor;
  worse, the convergence flags can disagree (Re-pass converges, Im-pass
  doesn't), forcing the wrapper to invent a "joint convergence" notion
  that ends up looking exactly like a complex-codomain driver anyway.
  One driver, one heap, one convergence flag — this is the cleaner
  surface.

* **Codomain-generic field-parameterised driver `gaussKronrodAdaptive
  <T>(field: Field<T>, ...)`.** The TS-expert irresistibility test
  rules this out: every call site has to construct a field record, the
  generic doesn't propagate cleanly through `(x: BigFloat) => T`
  callbacks, and TypeScript inference loses a step. ADR-0021 already
  rejected the field-record shape for the BF case; the same reasoning
  applies, only stronger now that we have three drivers (real-float64,
  real-arbprec, complex-arbprec) whose shared structure is the *G7K15
  algorithm shape*, not a typeclass.

## Determinism

Every operation in the BC driver bottoms out in `BigInt` arithmetic
via `cadd`/`csub`/`cmul`/`cdiv`/`cabs`, which are bit-deterministic
across every JS runtime by language specification (ADR-0020). The
G7K15 table is `BigFloat`-valued; per-component multiplication
`BigFloat · BigComplex` is `(w · z.re, w · z.im)` — two bit-deterministic
ops. The heap operations are deterministic given the input subinterval
order. The Cauchy stability test is bit-deterministic. The driver
inherits the strongest possible determinism contract: same `(input
bytes, prec)` ⇒ same output bytes, forever, on any platform.

## Migration

* New file `packages/quadrature/src/gauss-kronrod-bc.ts` (driver).
* `packages/quadrature/src/index.ts` re-exports
  `gaussKronrodAdaptiveBC`, `BigComplexQuadResult`,
  `BigComplexQuadOptions`, `BigComplexQuadratureError`.
* Tests added under `packages/quadrature/test/quadrature-bc.test.ts`.
* `packages/quadrature/README.md` updated to document three surfaces.
* Existing `gaussKronrodAdaptive` (float64) and
  `gaussKronrodAdaptiveBF` (arb-prec real) are unchanged; their
  combined 102 tests pass byte-identically.
* No tool catalog entries change; no provenance bytes shift.

The Mellin–Barnes consumer ships in the same `hv0.8` close:

* New file `packages/meijer-core/src/contour.ts`.
* `packages/meijer-core/src/index.ts` exports `meijergContour` and
  the `MeijerGContourResult` type.
* Tests under `packages/meijer-core/test/contour.test.ts`.

## Acceptance

* This document exists with Status=Accepted.
* `packages/quadrature` exposes `gaussKronrodAdaptiveBC` with the
  signature documented in §1.
* New tests verify, at minimum:
  1. Real-only integrand (im≡0) reproduces `gaussKronrodAdaptiveBF`'s
     bytes (mutation-prove that the BC driver is a faithful extension).
  2. Algebraic exactness on `(c0 + i·c1) · t^k` for k = 0..23 — both
     components.
  3. `∫_0^{2π} e^{i·t} dt = 0` to substrate ulp at multiple precisions
     (bit-determinism + entire-function correctness in the imaginary
     direction).
  4. `∫_0^1 (cos(t) + i·sin(t)) dt = sin(1) + i·(1 - cos(1))` against
     mpmath at 50 / 80 dps.
  5. Bit-determinism (running twice gives byte-identical BigComplex
     value and BigFloat errorEstimate).
  6. Convergence-flag honesty under tight budget on an oscillatory
     complex integrand.
  7. Boundary refusals: `prec` out of range throws; `a >= b` throws;
     `maxEvals < 15` throws; integrand exceptions propagate verbatim.
* `bun run check:quick` green.
* Worklog shard 073 documents the iteration and the `meijergContour`
  consumer's design.

## References

* ADR-0010 — `defineTool`/`runTool` split; library-and-tool dual
  surface.
* ADR-0014 — first numerical tier; the float64 G7K15 driver this
  lineage descends from.
* ADR-0020 — arb-prec tier; the unconditional bit-determinism contract
  this driver inherits.
* ADR-0021 — arb-prec real-codomain G7K15; the immediate predecessor
  whose centred-delta identity the BC driver carries verbatim.
* DLMF §16.17 — Mellin–Barnes integral representation of MeijerG;
  contour-existence conditions.
* Paris, R. B. & Kaminski, D. 2001. *Asymptotics and Mellin-Barnes
  Integrals*. Cambridge — the modern treatise on contour deformation
  and steepest-descent analysis (the consumer's reference, not the
  driver's).
