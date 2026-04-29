# ADR-0008 — cas-core: ring-generic refactor and algebraic numbers

**Status:** Accepted (2026-04-29)
**Context:** beads issue scientist-workbench-but
**Roadmap:** [docs/cas-core-roadmap.md](../cas-core-roadmap.md)
**Related:** PRD §0.1 (the known v0.1 gaps); ADR-0004 (Schema, the
shape Sturm tools declare for IR Values they consume); ADR-0006 (the
Sturm IR whose first concrete consumer needs algebraic numbers).

## Context

`packages/cas-core` shipped at v0.1 as a deliberately narrow MVP: Q
rationals, multivariate polynomials in named indeterminates, rational
functions over Q(x₁,…,xₙ). That scope was honest for v0.1 — it
covered the whole of the workbench's then-existing CAS surface
(`cas-simplify`, `cas-verify`) — but the rest of the project's
ambition has caught up with it.

Two demands now want capabilities cas-core can't supply:

1. **`sturm-execute` (issue scientist-workbench-tkx).** Per ADR-0006
   and ADR-0007, the analytic-distribution computer for Sturm channels
   needs exact-symbolic amplitudes for Clifford+T fragments. The
   natural amplitude ring is `Q[√2, i]` — quadratic algebraic
   extension over Q with a root of `x² − 2` and a root of `y² + 1`
   adjoined. cas-core has no algebraic-number representation.

2. **The known v0.1 gaps in PRD §0.1.** No polynomial GCD; no
   `cas-reduce`; `cas-simplify` cannot reduce `(x²−1)/(x−1)` to
   `x+1`. These gaps were honest given v0.1's scope but stop scaling
   once the substrate is meant to grow into a real CAS.

The reframe (captured in `docs/cas-core-roadmap.md`): cas-core's
trajectory is to grow into a CAS on feature parity with mature
systems (Mathematica, SymPy, Maple, FriCAS), at scientist-workbench's
chosen granularity (small typed substrate library + many independent
tools). The current shape is rung 0; the ladder above has well-
understood rungs (algebraic numbers, GCD, factorisation, pattern
matching, eventually integration). Adding algebraic-number support
to cas-core isn't "polluting cas-core's scope" — it *is* cas-core's
scope, properly understood.

This ADR codifies the next two rungs of that ladder:

- **Rung 1: ring-generic refactor.** `Poly<R>` and `RatFn<R>` become
  parametric over a coefficient ring. Q stays the v0.1 instance.
- **Rung 2: algebraic numbers.** `Q[α]/(p(α))` for univariate α; tower
  composition for `Q[√2, i]` and friends.

The ring-generic refactor is load-bearing for everything below it on
the ladder. Doing it now is cheaper than retrofitting once each new
ring (algebraic, finite-field, p-adic, modular) is its own siloed
implementation.

## Decision

### The Ring interface

A new module `packages/cas-core/src/ring.ts` declares the abstract
shape every coefficient ring satisfies:

```ts
export interface Ring<T> {
  readonly zero: T;
  readonly one: T;
  readonly add: (a: T, b: T) => T;
  readonly sub: (a: T, b: T) => T;
  readonly mul: (a: T, b: T) => T;
  readonly neg: (a: T) => T;
  readonly eq: (a: T, b: T) => boolean;
  readonly isZero: (a: T) => boolean;
  readonly isOne: (a: T) => boolean;
  readonly fromInt: (n: bigint) => T;
}
```

A `Field<T> extends Ring<T>` adds `inv` and `div` for rings where
every non-zero element is invertible (Q, Q[α]/(p) when p is
irreducible, etc.). Polynomial operations that need division (GCD,
extended Euclid) require a `Field<T>` constraint.

The interface is intentionally minimal. Operations like `gcd` (for
GCD domains), `factor` (for UFDs), and `embedInt` (for ordered rings)
are added only when a concrete ring needs them — we do not preemptively
import FriCAS's full categorical hierarchy.

### Generic Poly and RatFn

The existing `Monomial`, `Poly`, and `RatFn` types become generic:

```ts
export interface Monomial<T> {
  readonly exp: Exp;
  readonly coef: T;
}

export interface Poly<T> {
  readonly terms: readonly Monomial<T>[];
}

export interface RatFn<T> {
  readonly num: Poly<T>;
  readonly den: Poly<T>;
}
```

Operations take the ring as an explicit parameter:

```ts
export function polyAdd<T>(a: Poly<T>, b: Poly<T>, R: Ring<T>): Poly<T>;
export function polyMul<T>(a: Poly<T>, b: Poly<T>, R: Ring<T>): Poly<T>;
// etc.
```

The Q instance is `RAT_RING: Field<Rat>` exported from
`packages/cas-core/src/rat.ts`. A `polyAddQ = (a, b) => polyAdd(a, b,
RAT_RING)` style of curried alias is *not* introduced — call sites
that work with one specific ring are short enough that
`polyAdd(a, b, RAT_RING)` reads cleanly, and avoiding the alias keeps
the API surface flat.

### Why explicit ring at the call site, not bound to the value

Two natural designs were considered:

- **(A) Explicit-ring functions.** Operations take `R: Ring<T>` as a
  parameter. The `Poly<T>` value carries no ring reference. *Chosen.*
- **(B) Ring-bound values.** Each `Poly<T>` carries `readonly ring:
  Ring<T>`. Operations recover the ring from the value.

(A) keeps Values pure-data — they round-trip through canonicalisation
and hashing without an embedded function-pointer payload. The price
is one extra argument at every call site. We pay it: cas-core's
internal API is consumed by tool authors who understand the ring
context anyway, and the symmetry with `validate(v, schema)` in the
protocol's schema layer is satisfying.

(B) was tempting because it makes call sites slightly shorter, but
(i) it would require Ring values to canonicalise stably (functions
don't), (ii) it conflates the data shape with its interpretation, and
(iii) it drifts away from the FriCAS-style "polynomial categorically
parameterised by domain" pattern that the cas-core roadmap is
following.

### Algebraic numbers — chain composition

A new module `packages/cas-core/src/algebraic.ts` implements
`AlgebraicElement<R>` and `AlgebraicRing<R>` for a univariate
algebraic extension over an arbitrary base ring `R`:

```ts
export interface AlgebraicElement<R> {
  // Polynomial in α of degree < deg(p), with coefficients in R.
  readonly coefs: readonly R[];
}

export interface AlgebraicRingSpec<R> {
  readonly base: Field<R>;
  readonly minimalPoly: readonly R[];   // p(α), highest degree last;
                                         // p must be monic and irreducible over R
  readonly generatorName: string;        // e.g., "√2" or "i"
}

export function algebraicRing<R>(
  spec: AlgebraicRingSpec<R>
): Field<AlgebraicElement<R>>;
```

`Q[√2]` is `algebraicRing({ base: RAT_RING, minimalPoly: [-2, 0, 1],
generatorName: "√2" })`. `Q[√2, i]` is the chain
`algebraicRing({ base: Q_SQRT2, minimalPoly: [1, 0, 1], generatorName:
"i" })`, where `Q_SQRT2` is the level above.

Two natural representations were considered for multivariable
algebraic extensions:

- **(A) Flat:** `Q[α₁,…,αₖ]/(p₁,…,pₖ)` with simultaneous reductions
  via Gröbner basis on the ideal. General; needs Gröbner machinery
  cas-core does not yet have.
- **(B) Chain:** `Q ⊂ Q[α₁] ⊂ Q[α₁, α₂] ⊂ …`, each link a single
  univariate extension. Easier to implement, easier to grow, matches
  FriCAS's design. The cost: extension order matters at the type
  level (different orderings produce different but isomorphic types),
  but elements canonicalise the same after reduction.

**(B), chain.** Reasons:
- Implementation is roughly multiplication-then-polynomial-reduce on
  the level above, which we already have via `polyMul` and a future
  univariate-poly-division primitive.
- Flat would require Gröbner basis work that cas-core has not yet
  motivated.
- The chain ordering for `Q[√2, i]` is `Q ⊂ Q[√2] ⊂ Q[√2][i]`
  (irrational extension first, then imaginary). The Q-basis is
  `{1, √2, i, √2·i}`; multiplication uses `√2² = 2` and `i² = −1`
  with no coupling.

Future flat composition (e.g., for cyclotomic fields where the
embedding requires simultaneous relations) can be added later as a
separate `flatAlgebraicRing(...)` constructor without disturbing the
chain implementation.

### Migration

This refactor touches every cas-core file. We do it as a single
landing rather than a backwards-compatibility shim — same discipline
as ADR-0004's all-at-once Schema migration:

1. Add `Ring<T>` and `Field<T>` interfaces. Implement `RAT_RING:
   Field<Rat>`.
2. Refactor `poly.ts` to be generic over the coefficient ring.
3. Refactor `ratfn.ts` similarly.
4. Refactor `expr-bridge.ts` to thread the ring through Value ↔
   `RatFn<R>` translation. Q is the default; the algebraic-number
   bridge follows in the algebraic-numbers issue
   (scientist-workbench-1s4).
5. `simplify.ts` and `verify.ts` keep operating on `RatFn<Rat>` —
   their public contract is unchanged. cas-simplify v2 (a future
   tool revision) will make them ring-polymorphic.
6. All existing 47 unit tests pass without modification.

A second issue, scientist-workbench-1s4, lands the algebraic-numbers
ring on top of the refactor. A third issue, scientist-workbench-djr,
lands polynomial GCD; both can land in parallel once the refactor is
in.

## Consequences

**Positive.**
- The ring-generic surface is the architectural pattern every serious
  CAS uses. Now done, every future ring (algebraic, finite-field,
  p-adic, modular Z/nZ, polynomial-quotient `R[α]/(p)`) is just a new
  `Ring<T>` instance reusing all polynomial machinery.
- `sturm-execute` becomes implementable with exact-symbolic
  Clifford+T amplitudes via `Q[√2, i]`, which is the killer demo for
  the workbench's exact-symbolic substrate.
- Cas-core is structurally on a path to closing PRD §0.1's known
  gaps: polynomial GCD lands as a generic algorithm over any GCD
  domain; `cas-reduce` follows.

**Negative.**
- Every cas-core file is touched. ~300 LOC churn. Existing tests
  catch regressions; mutation-prove confirms tests are load-bearing.
  We accept the churn — load-bearing for everything from now on.
- Call-site verbosity. `polyAdd(a, b, RAT_RING)` is three arguments
  where the original was two. We pay this; the alternative (binding
  Ring to Poly value) breaks pure-data semantics.
- The chain ordering for algebraic towers is type-level visible.
  `Q_SQRT2_I` and `Q_I_SQRT2` are different types even though their
  elements are isomorphic; canonical-form code uses the chosen
  ordering. Documented in `algebraic.ts`.
- Cas-core is now committed to a multi-year evolution arc.
  `docs/cas-core-roadmap.md` is the trajectory doc; each rung is its
  own ADR + worklog landing.

## Alternatives considered

**Don't refactor; add Q[√2, i] as a special-cased extension to
cas-core's hardcoded Q backend.** Rejected. A one-off "if the
coefficient happens to involve √2 and i, switch to special path"
re-creates exactly the failure mode (composition through ad-hoc
special cases) that the agent-first architecture is trying to escape.
The refactor is the right shape; the cost is one-time.

**Add `packages/algebraic-numbers` as a parallel package depending
on cas-core.** Rejected — this was my initial framing; the user
correctly pushed back. Algebraic numbers are *part of* a real CAS,
not a sibling capability. Splitting them off would re-create the
"every CAS feature is its own package" surface area
(packages/cas-core, packages/cas-algebraic, packages/cas-gcd, etc.)
and force every consumer to coordinate workspace deps. cas-core
grows; sibling packages emerge only when scope genuinely splits
(e.g., a future `packages/diff-algebra` for symbolic differentiation
machinery would be a sibling because differential algebra's structure
is genuinely different from polynomial algebra; algebraic numbers
are not in that bucket).

**Flat algebraic representation `Q[α₁,…,αₖ]/(p₁,…,pₖ)`.** Considered
above. Defer to chain composition for v0.2; flat can be added as a
separate constructor later if a use case demands.

**Adopt FriCAS's full category hierarchy upfront (`Ring`,
`CommutativeRing`, `IntegralDomain`, `GcdDomain`, `Field`,
`UniqueFactorizationDomain`, …).** Rejected for v0.2 — implement only
what we need (`Ring`, `Field`) and grow the category lattice as
operations require. The roadmap captures the eventual destination
without forcing it on us today.

## Pointers

- `docs/cas-core-roadmap.md` — the working trajectory document; the
  capability map and the priority-ordered ladder.
- `packages/cas-core/src/rat.ts` — current Q implementation; gains
  `RAT_RING: Field<Rat>` export.
- `packages/cas-core/src/poly.ts` — refactor target.
- `packages/cas-core/src/ratfn.ts` — refactor target.
- `packages/cas-core/src/algebraic.ts` — to be created in the
  algebraic-numbers issue.
- ADR-0006 — Sturm IR; sturm-execute is the first concrete consumer
  of `Q[√2, i]`.
- ADR-0007 — distribution-vs-sampling; the operational context for
  why exact-symbolic Clifford+T matters.
- PRD §0.1 — known v0.1 gaps; this ADR opens the door to closing
  them via `cas-reduce` (after the GCD issue lands).
- Issues: scientist-workbench-but (this ADR), -t87 (refactor),
  -1s4 (algebraic numbers), -djr (polynomial GCD).
