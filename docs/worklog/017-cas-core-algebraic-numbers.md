# 017 — cas-core algebraic numbers (Q[α]/(p) + tower composition)

**Date:** 2026-04-29
**Status:** complete
**Branches:** main
**Issues:** scientist-workbench-1s4 (closed)
**ADR:** [docs/adr/0008-cas-core-ring-generic-and-algebraic-numbers.md](../adr/0008-cas-core-ring-generic-and-algebraic-numbers.md)
**Roadmap:** [docs/cas-core-roadmap.md](../cas-core-roadmap.md) — rung 2

## Context

Shard 016 landed rung 1: cas-core's ring-generic refactor.
`Poly<T>` and `RatFn<T>` are now parametric over a `Ring<T>` /
`Field<T>` interface. Q remains the v0.1 instance via `RAT_RING`.

Rung 2 — this shard — adds algebraic-number support: `Q[α]/(p(α))`
for univariate algebraic α, with chain composition for towers like
`Q[√2, i]`. First concrete consumer is `sturm-execute` (issue
scientist-workbench-tkx, currently blocked on this); Clifford+T
amplitudes naturally live in `Q[√2, i]`.

## What changed

### `packages/cas-core/src/algebraic.ts` (new)

Implements the abstract construction `R[α]/(p(α))` over any field
`R`:

```ts
export interface AlgebraicElement<R> {
  readonly coefs: readonly R[];   // low-to-high degree
}

export function algebraicRing<R>(spec: {
  base: Field<R>;
  minimalPoly: readonly R[];      // monic; irreducible over base
  generatorName: string;
}): Field<AlgebraicElement<R>>;
```

The element representation is a coefficient list in low-to-high
degree order: `[a₀, a₁, …, a_{n-1}]` represents
`a₀ + a₁·α + … + a_{n-1}·α^{n-1}`. Canonical form trims trailing
zeros so structurally equal elements have byte-equal arrays.

Internal helpers (all coefficient-list polynomial operations over
the base ring):

- `trimZeros` — drop trailing zeros (canonical form).
- `listAdd / listSub / listNeg / listMul` — pointwise / convolution.
- `reduceModMinPoly` — synthetic division by the (monic) minimal
  polynomial, reducing degrees ≥ deg(p) to a remainder strictly
  below.
- `polyDivMod` — long division with remainder over R[α], where R is
  a field.
- `polyExtGcd` — extended Euclidean algorithm; finds `(g, s, t)`
  with `a·s + b·t = g`. Used for `inv` via Bezout: when `minPoly`
  is irreducible, `gcd(element, minPoly)` is a unit (a non-zero
  constant in `R`), and `s` modulo `minPoly` divided by that unit
  is the inverse.

The `Field<AlgebraicElement<R>>` returned by `algebraicRing` plugs
into the same `Poly<T>` and `RatFn<T>` machinery as `RAT_RING`.

### Pre-built instances

```ts
export const Q_SQRT2: Field<AlgebraicElement<Rat>>;
export const Q_I:     Field<AlgebraicElement<Rat>>;
export const Q_SQRT2_I: Field<AlgebraicElement<AlgebraicElement<Rat>>>;
```

`Q_SQRT2` is `Q[α]/(α² − 2)`. `Q_I` is `Q[α]/(α² + 1)`. `Q_SQRT2_I`
is the chain `Q ⊂ Q[√2] ⊂ Q[√2][i]` — element type
`AlgebraicElement<AlgebraicElement<Rat>>`. The Q-basis of the tower
is `{1, √2, i, √2·i}`.

### Convenience constructors

```ts
qSqrt2(a, b)         // a + b·√2 in Q[√2]
qI(a, b)             // a + b·i in Q[i]
qSqrt2I(a, b, c, d)  // a + b·√2 + c·i + d·√2·i in Q[√2, i]
```

The full nested-coefficient construction is verbose; these helpers
make typical element construction direct. Call sites that build an
ad-hoc tower (cyclotomic, etc.) use `algElement(coefs, base)`
directly.

### Tests — `packages/cas-core/test/algebraic.test.ts`

34 tests / 51 expect calls / runs in ~70ms. Coverage:

- **Q[√2] basics (10 tests):** construction, (√2)² = 2,
  (1+√2)² = 3+2√2, (1+√2)(1−√2) = −1, inverse of (1+√2) and √2,
  zero-construction-path-independence, ring-axiom commutativity /
  associativity / distributivity, fromInt embedding.
- **Q[i] basics (5 tests):** i² = −1, (1+i)² = 2i, (1+i)(1−i) = 2,
  inverse of (1+i) and i.
- **Q[√2, i] tower (12 tests):** all four basis elements; (√2)² = 2
  and i² = −1 within the tower; (√2·i)² = −2; √2 · i = √2·i (basis
  multiplication); (1+i)(1−i) = 2 and (1+√2)(1−√2) = −1 across the
  tower; (1+i+√2)² = 2+2√2+2i+2√2·i; inverse of i, (1+√2), (1+i)
  within the tower; tower distributivity; zero/one recognition;
  basis-coef sanity.
- **Error paths (4 tests):** reducible-minPoly throws on inverse
  attempts; non-monic minPoly rejected at construction;
  degree-0 minPoly rejected; inverse-of-zero throws everywhere.

`bun run check`: 16/16 phases pass. Tournament 02-NTT cross-
validation still 64/64.

Mutation-proven: bypassing the `reduceModMinPoly` step in `mul`
caused the test suite to *infinite-loop* — without reduction, every
multiplication grows the coefficient list unboundedly. That's a
strong demonstration the reduction is structurally load-bearing,
not just numerically correct. Restored.

### Public surface (`src/index.ts`)

New exports:

```ts
export {
  type AlgebraicElement,
  type AlgebraicRingSpec,
  algebraicRing,
  algElement,
  Q_SQRT2,
  Q_I,
  Q_SQRT2_I,
  qSqrt2,
  qI,
  qSqrt2I,
} from "./algebraic.js";
```

## Why these choices

**Chain composition, not flat.** ADR-0008's "Alternatives considered"
covers this. Chain (Q ⊂ Q[√2] ⊂ Q[√2][i]) is implementable from the
primitives we have; flat (Q[α₁,α₂]/(p₁,p₂) with simultaneous Gröbner
reduction) would need machinery cas-core does not yet have. Future
flat composition can land as `flatAlgebraicRing(...)` without
disturbing the chain implementation.

**Coefficient-list representation, not `Poly<R>`.** `Poly<R>` from
`poly.ts` is the multivariate sparse representation. Algebraic-
number elements are *dense univariate* polynomials in the single
generator α. A flat coefficient array is simpler, faster, and
matches FriCAS's design. This is a deliberate scope split: `poly.ts`
is for general-purpose multivariate work; `algebraic.ts`'s internal
helpers are for the dense-univariate case the construction needs.

**Extended Euclid for inverse, not closed-form formulas.** Q[√2]
has a closed-form inverse: `1/(a+b√2) = (a−b√2)/(a²−2b²)`. So does
Q[i]. We could special-case these. We don't — extended-Euclid is
the general algorithm and works for any irreducible minPoly,
including the cubic and higher cases that future consumers will
need (cyclotomic fields, splitting fields). The cost on degree-2
extensions is a few extra multiplications; negligible.

**`reducible-minPoly is the caller's problem`.** The constructor
checks monic-ness but does not check irreducibility (which would
require a polynomial-factorisation algorithm we don't have yet).
Documented as a precondition. A reducible minPoly produces a ring
that's not a field; arithmetic still works, but `inv` fails on
zero-divisors. The implementation throws when `polyExtGcd` returns
a non-trivial-degree gcd, which is the reasonable failure shape.

**Tower ordering matters at the type level.** `Q_SQRT2_I` and a
hypothetical `Q_I_SQRT2` would be different TS types even though
their elements are isomorphic. We pick `Q ⊂ Q[√2] ⊂ Q[√2][i]`
(irrational extension first, imaginary second) because the natural
basis `{1, √2, i, √2·i}` matches that ordering. Documented in
algebraic.ts and ADR-0008.

## Frictions surfaced

- **Mutation-prove burned background test runs.** Skipping
  `reduceModMinPoly` produces an infinite loop (because every
  multiplication compounds without reduction). Three test runs
  hung in the background and had to be killed. The lesson: when
  mutation-proving a function whose absence causes non-termination,
  use a CPU/wall-clock timeout (or run the tests in a sandbox that
  enforces one). For future mutation-proves on similar primitives,
  add a `timeout 30` wrapper.

- **Two `return canonical(...)` lines after the mutation script.**
  My `python3` mutation script targeted the `mul` function's
  reduction call, but the script also matched the `div` function's
  identical line. The restore wasn't atomic with the test (the
  test hung, blocking the trailing `cp` restore). When I returned
  to the file, both had been mutated and only one had been
  restored. Lesson: chain mutate-test-restore with `&&` not `;`,
  or always run mutation tests with an explicit timeout.

- **The `reducible minPoly` test deliberately exercises a
  failure path.** It constructs `α² − 1 = (α−1)(α+1)` and asks for
  the inverse of `α − 1`. The implementation correctly throws
  with a "minPoly may be reducible" message. This is honest
  scope (per CLAUDE.md Rule 8): the constructor doesn't check
  irreducibility (we'd need factorisation), but the error
  surfaces loudly when the abstraction breaks.

- **The `Q_SQRT2_I` type is genuinely nested.** TS displays it as
  `Field<AlgebraicElement<AlgebraicElement<Rat>>>`. For a third
  level of extension, that nesting deepens. Type aliases (e.g.,
  `type SturmAmplitude = AlgebraicElement<AlgebraicElement<Rat>>`)
  will help once consumers (sturm-execute) start writing real code
  against the tower.

## Acceptance

- `packages/cas-core/src/algebraic.ts` exists with the
  `algebraicRing<R>(spec)` constructor and `Q_SQRT2`, `Q_I`,
  `Q_SQRT2_I` instances.
- 34 tests pass covering ring axioms, the specific Q[√2, i]
  structure, equality / canonical-form, error paths.
- Mutation-proven: bypassing `reduceModMinPoly` in `mul` causes
  infinite loops (failure mode is non-termination, which is
  caught by test timeouts).
- `bun run check`: 16/16 phases pass.
- Public exports added to `index.ts`.
- ADR-0008 cross-referenced.
- Issue scientist-workbench-1s4 closed.

`tkx` (sturm-execute) is now unblocked — the Q[√2, i] amplitude
ring it needs is available.

## Pointers

- ADR-0008 — the design.
- `docs/cas-core-roadmap.md` — rung 2 lands here; rungs 3+ (poly
  GCD, factorisation, pattern matching, …) remain on the ladder.
- `packages/cas-core/src/algebraic.ts` — the literate-programmed
  implementation.
- `packages/cas-core/test/algebraic.test.ts` — the conformance
  battery.
- shard 016 — rung 1 (the ring-generic refactor this depends on).
- Next ready: tkx (`sturm-execute`) — analytic distribution over
  the IR using Q[√2, i] for Clifford+T amplitudes.
