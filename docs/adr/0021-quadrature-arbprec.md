# ADR-0021 — Arbitrary-precision generalisation of the G7K15 quadrature substrate

**Status:** Accepted — 2026-05-08
**Beads:** scientist-workbench-hv0.7 (this ADR + the
`packages/quadrature` arb-prec extension it specifies);
parent epic scientist-workbench-hv0 (problem-13 Meijer G mega-test).
**Related:** ADR-0014 (first numerical tier — the float64 G7K15 driver
this ADR generalises); ADR-0015 (numerical-tier determinism — what the
arb-prec generalisation is *not*); ADR-0020 (arbprec tier — the
unconditional bit-determinism contract this generalisation inherits);
ADR-0010 (`defineTool`/`runTool` split — why we extend the *package*
without adding a new wire tool).

## Context

`packages/quadrature` ships a pure-TypeScript adaptive Gauss-Kronrod
G7K15 driver (`gaussKronrodAdaptive`) operating on `float64`. ADR-0014
is the precedent that put it there; ADR-0015 is the determinism caveat
that put `numerical: true` on `tools/integrate-1d` to acknowledge the
platform-conditional behaviour of `Math.*` and IEEE-754 ordering across
runtimes.

Worklog 070 (the Slater path for problem 13) shipped the symbolic-plus-
inner-pFq layer of MeijerG. The next algorithmic layer is the
**Mellin-Barnes contour quadrature** (epic child `hv0.8`) — the
contour integral that closes the loop where the Slater residue
expansion does not converge. The contour is parameterised as a real
integral over `t ∈ ℝ` (truncated by the asymptotic decay of the
integrand), and the integrand is `Γ`-product-times-`z^s`, computed in
the bigfloat substrate at `--precision`-dictated working precision.

The natural substrate for that contour quadrature is the same G7K15
algorithm we already have, but operating on `BigFloat` instead of
`number`. Two concerns motivated this ADR:

1. **The shape of the generalisation.** The bead's brief offered three
   alternatives: parameterise `tools/integrate-1d` on precision; split
   into `integrate-1d-float64` + `integrate-1d-arbprec`; or extend the
   package without changing the wire surface. We pick the third —
   reasons below.
2. **Cancellation-stable error estimation at high precision.** The
   float64 driver computes `K15 - G7` as a difference of two
   ~bit-equal sums. At 53-bit precision this loses negligible bits;
   at 530-bit (150-dps) precision it loses ~75 bits worth of
   reliability in the error-estimate field, which is the very signal
   that drives bisection. The arb-prec driver must compute `K - G`
   *directly* via precomputed weight differences.

Both concerns are settled here so the implementation is unambiguous.

## The axiom (re-applied)

ADR-0009: a TS expert reads two named drivers `gaussKronrodAdaptive`
and `gaussKronrodAdaptiveBF` in the same package and immediately
understands "same algorithm, two precision tiers." A generic
`gaussKronrod<T>(field: Field<T>, ...)` would be type-elegant on paper
but reads as ceremony: every call site has to pass the field record,
and TypeScript's inference doesn't propagate cleanly through the
`(x: T) => T` callback shape. Two named drivers is what the agent
reaches for; one generic with a field-record argument is what it would
write reluctantly. Same algorithm, two named entry points.

## Decision

Five additive changes to `packages/quadrature`. None breaks the
existing float64 driver's bytes; none requires a tool-side change.

### 1. Library extension only — no wire-tool change in v0.1

`tools/integrate-1d` stays float64-only. We do *not* add a
`tools/integrate-1d-arbprec`, *not* parameterise `tools/integrate-1d`
on precision, and *not* add a `--precision` flag to the existing
tool's flag set.

Reasons:

- **The near-term consumer is in-process.** `hv0.8` (Mellin-Barnes
  contour) is a `packages/meijer-core` extension that calls the
  package surface directly. A wire tool would be dead surface — no
  agent invokes it via subprocess until `tools/meijer-g` (`hv0.10`)
  ships, and at that point a thin wrapper (the `meijer-g-slater-only`
  precedent) is the right shape.
- **`tools/integrate-1d`'s output schema is float64-bound.** Its
  success branch is `record { value: float64, error_estimate: float64,
  ... }`. Making it arbprec-aware would require changing the schema
  to `value: <float64 | tagged "bigfloat">` and adding union-discrimination
  logic to every consumer. That is a breaking change to a stable
  surface for no near-term benefit. Better: keep float64 stable; ship
  arb-prec as a separate tool *if and when* an external surface is
  needed.
- **The package layer is the right home for the algorithm.** ADR-0010
  (defineTool/runTool split) puts the algorithm in the package and
  the wire encoding in the tool. Both the float64 and the arb-prec
  drivers live in the same package; the wire layer is whatever tool
  needs them.

A future ADR can promote the arb-prec driver to a wire tool when an
agent-facing use case appears. The library-only ship is *not* a
half-measure — it is what the consumer (`hv0.8`) actually needs.

### 2. New driver `gaussKronrodAdaptiveBF`

Public surface:

```ts
gaussKronrodAdaptiveBF(
  f: (x: BigFloat, prec: number) => BigFloat,
  a: BigFloat,
  b: BigFloat,
  prec: number,                          // decimal digits of precision
  opts?: BigFloatQuadOptions,
): BigFloatQuadResult
```

The shape mirrors `gaussKronrodAdaptive` field-for-field:

```ts
type BigFloatQuadResult = {
  readonly value: BigFloat;
  readonly errorEstimate: BigFloat;
  readonly nEvals: number;
  readonly converged: boolean;
  readonly iterations: number;
  readonly method: "gauss-kronrod-g7k15-bigfloat";
  readonly precision: number;            // decimal digits achieved
  readonly workingPrecision: number;     // bits used internally
  readonly warnings: readonly string[];
};
```

Two shape differences from the float64 result:

- **Value, errorEstimate are `BigFloat`** (not `number`). The
  consumer reads them at `prec` decimal digits.
- **`precision` and `workingPrecision` are first-class fields**, not
  derived. The substrate worked at `workingPrecision` bits; the
  result was rounded to `prec` decimal digits. Recording both lets
  a downstream cancellation-aware planner reason about how much
  headroom is left without re-deriving the conversion.

The `f` callback takes `prec` as a *second* argument — the working
precision the driver is operating at. This is load-bearing: at the
inner-pFq composition pattern (the `meijer-core` Slater path's reuse
of `evaluatePFq`), the integrand is itself an arbitrary-precision
computation that needs to know what precision to round its output to.
A callback `(x: BigFloat) => BigFloat` with no precision argument
would force the integrand to either over-compute (wasting cycles) or
under-compute (corrupting the rule). This signature commits to the
right answer.

### 3. Cancellation-stable local rule

The local rule computes `K15 = halfLength · Σ_{i=0..7} WGK[i] · (f_left + f_right)`
and `G7 = halfLength · Σ_{i ∈ Gauss} WG[g(i)] · (f_left + f_right)`,
plus centre contributions. The float64 driver computes both and
subtracts; the arb-prec driver computes the *difference directly*:

```
K - G = halfLength · [
    (WGK[7] - WG[3]) · f(centre)
  + Σ_{i ∈ Kronrod-only} WGK[i] · (f_left + f_right)
  + Σ_{i ∈ Gauss-shared} (WGK[i] - WG[g(i)]) · (f_left + f_right)
]
```

The pre-computed differences `WGK[1] − WG[0]`, `WGK[3] − WG[1]`,
`WGK[5] − WG[2]`, `WGK[7] − WG[3]` are stored as 200-dps decimal
string literals alongside the absolute weights. At very high
precision (≥ 100 dps target) the cancellation-cost saving is
~70 bits of reliability in the error-estimate field — the precise
quantity that drives bisection.

The float64 driver's "compute K and G separately, subtract" path is
correct at 53-bit precision because the cancellation loss is
absorbed by the 30-bit safety margin. The arb-prec driver does not
have that luxury for users requesting near-substrate-cap precision,
so the direct-difference path is mandatory.

### 4. Constants stored at 200 dps; hard cap at 150 dps user-facing

`packages/quadrature/src/nodes-weights-bf.ts` carries the canonical
G7K15 nodes and weights as 200-decimal-digit string literals,
generated via mpmath at 230 dps using the standard Stieltjes-
orthogonality construction (Patterson 1968 / Laurie 1997 / Monegato's
review papers). The generation script is preserved in the file
header as the regeneration recipe; the values are cross-verified
against GSL `qk15.c`'s float64 values byte-for-byte at the truncated
precision.

Storage at 200 dps with a 150-dps user-facing cap leaves a 50-dps
safety margin. After applying `decimalToBinaryPrecision(150,
safety=30)`, the working precision is ~530 bits; the table's
~665-bit storage covers it with ~135 bits of slack.

A user requesting `prec > 150` decimal digits gets `RangeError`
loudly. Senior-engineer rule: refuse silently-degraded precision.
A future bead can extend the table (or compute the constants at
runtime via Golub-Welsch on the symmetric Jacobi matrix) when the
cap proves limiting. We do not pre-empt: the natural problem-13
ceiling is 110 dps (Wolfram-mpmath consensus oracle), comfortably
within the cap.

### 5. Convergence and tolerances scale with `prec`

Default tolerances:

```
atol = pow(2, -ceil(prec * log2(10)))      [BigFloat at workPrec]
rtol = atol
```

This is "achieve `prec` decimal digits in the final value." A user
who wants tighter or looser convergence overrides via `opts.atol` /
`opts.rtol`.

Termination:

```
errorEstimate ≤ atol + rtol · |value|     ⇒ converged = true
nEvals ≥ maxEvals                          ⇒ converged = false (budget)
```

`maxEvals` defaults to `prec * 200` (heuristic: 200 K15 calls per
decimal digit on a typical hard integrand). The user can raise this
via `opts.maxEvals`.

## Why these choices

### Why two named drivers, not a generic `gaussKronrod<T>(field, ...)`

The two principles applied (ADR-0009, the ts-native idiom): a
TypeScript expert reading the API surface wants to call
`gaussKronrodAdaptiveBF(f, a, b, 50)` without thinking about a
field-record. A generic over `Field<T>` would force every call site
to construct one. The two-named-driver pattern is what the workbench
already uses for the `runTool` (subprocess) / `executeToolDef`
(in-process) split — same algorithm, two named surfaces, no generic
ceremony.

### Why arb-prec, not float80 / quadruple

Float80 is non-portable (Intel-specific extended precision; not
available on ARM or in JS). Quadruple-precision (`__float128`) is
not a JS primitive and would need its own substrate. The
`@workbench/bigfloat` substrate already exists, is bit-deterministic
across runtimes (ADR-0020), and gives us *arbitrary* precision —
limited only by the table cap, which is recoverable. There is no
incremental engineering value in a quad-precision tier between
float64 and arb-prec.

### Why `f` takes `prec` as a second argument

The Mellin-Barnes integrand calls `evaluatePFq` (from
`@workbench/hypergeometric`), which itself takes a precision
argument. Without `prec` in the callback, the integrand would have
to close over a fixed precision that may not match the driver's
working precision. Passing `prec` makes the contract explicit:
"return f(x) at this precision, please." The callback can short-
circuit if it has cheap evaluation, or escalate if it needs more.

### Why no `--platform-fingerprint` analogue

`arbprec: true` is *more* deterministic than `numerical: true`, not
less. There is no platform-dependent code path in the bigfloat
substrate or the new driver: `BigInt` arithmetic is bit-identical
across every JS runtime (per the language specification). Recording
a platform fingerprint would be misleading. ADR-0020 already
established this; the new driver inherits it.

### Why no `BigComplex` driver in v0.1

The Mellin-Barnes contour integrand *is* complex-valued, so a
`BigComplex` codomain is the natural extension. We defer it because:

- `hv0.8` (the Mellin-Barnes implementation) is the design site for
  *how* complex-codomain quadrature is plumbed: per-component
  (real driver run twice with `Re(f)` and `Im(f)`, with caching to
  avoid double-evaluation) versus codomain-generic. That choice
  belongs in `hv0.8`'s design, not here.
- Shipping an unused complex driver risks committing to the wrong
  shape. The real driver in v0.1 is what the consumer needs *first*
  (the contour integrand's modulus check, the asymptotic-tail
  truncation point, the local-rule debugging). The complex
  extension is an additive feature when its consumer drives it.

## What we will *not* decide here

- **Arb-prec wire tool.** Deferred to whenever an agent-facing
  surface needs it. `tools/integrate-1d` stays float64.
- **`BigComplex` codomain.** Deferred to `hv0.8`'s design.
- **Runtime weight derivation (Golub-Welsch on the Jacobi matrix).**
  The 200-dps stored table covers every problem-13 use case. Filed
  as a follow-up if the 150-dps cap proves limiting.
- **Doubly-adaptive precision** (a driver that decides "I need 80
  dps to satisfy a 50-dps request" and silently bumps). The
  consumer (Slater path, contour layer) is responsible for picking
  the right working precision — the driver honours what it is told
  to honour. ADR-0020 §"What we will not decide": auto-bumping is
  the tool's responsibility, not the substrate's.
- **Improper / infinite intervals at arb-prec.** Out of scope; same
  rule as the float64 driver. Substitution-and-truncation is the
  consumer's choice.

## Migration

- New file `packages/quadrature/src/nodes-weights-bf.ts` (constants).
- New file `packages/quadrature/src/gauss-kronrod-bf.ts` (driver).
- `packages/quadrature/src/index.ts` re-exports
  `gaussKronrodAdaptiveBF`, `BigFloatQuadResult`,
  `BigFloatQuadOptions`.
- `packages/quadrature/package.json` adds `@workbench/bigfloat`
  workspace dependency.
- Tests added under `packages/quadrature/test/quadrature-bf.test.ts`.
- README updated to document both surfaces.
- Existing `gaussKronrodAdaptive` is unchanged; its 30 tests pass
  byte-identically.
- No tool catalog entries change; no provenance bytes shift.

## Acceptance

- This document exists with Status=Accepted.
- `packages/quadrature` exposes `gaussKronrodAdaptiveBF` with the
  signature documented in §2.
- Constants in `nodes-weights-bf.ts` are 200-dps, byte-cross-checked
  against the (independent) generation script preserved in the
  file header.
- New tests verify: (i) algebraic exactness on `x^k` for `k = 0..23`
  at 50 dps and 100 dps, residual at the substrate's ulp budget;
  (ii) hand-checked `∫_0^π sin(x) dx = 2` byte-identical to mpmath at
  50 and 100 dps; (iii) bit-determinism (running twice gives byte-
  identical results); (iv) cancellation-stability advantage over the
  separate-sums approach (mutation-prove); (v) honest `converged`
  flag under tight budget; (vi) precision cap at 150 dps throws
  `RangeError`.
- `bun run check:quick` green.
- Worklog shard 072 documents the iteration.

## References

- ADR-0010 — `defineTool`/`runTool` split; library-and-tool dual
  surface.
- ADR-0014 — first numerical tier; the float64 G7K15 driver this
  ADR generalises.
- ADR-0015 — numerical-tier determinism; what arb-prec is *not*.
- ADR-0020 — arb-prec tier; the unconditional bit-determinism
  contract this driver inherits.
- Patterson, T. N. L. 1968. "The Optimum Addition of Points to
  Quadrature Formulae." *Mathematics of Computation* 22(104),
  847–856 — the canonical Kronrod-extension construction.
- Laurie, D. P. 1997. "Calculation of Gauss-Kronrod Quadrature
  Rules." *Mathematics of Computation* 66(219), 1133–1145 — the
  modern algorithmic recipe (used at runtime to verify our
  precomputed table).
- Monegato, G. 2008. "An overview of the computational aspects of
  Kronrod quadrature rules." *Numerical Algorithms* 26(2),
  173–196 — review paper.
- Galassi et al., GSL Reference Manual §16.4 — the float64 reference
  implementation we cross-validate the truncated-table values
  against.
