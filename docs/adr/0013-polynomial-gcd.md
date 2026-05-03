# ADR-0013 — Polynomial GCD in cas-core

**Status:** Accepted — 2026-05-03
**Beads:** scientist-workbench-djr (P2; this ADR is the design pass)
**Related:** ADR-0008 (ring-generic refactor — provides the `Field<T>` /
`Poly<T>` substrate this builds on), beads `t87` (closed: ring-generic
refactor), the prophetic line in `packages/cas-core/src/ring.ts`
("If polynomial GCD lands as a generic algorithm…")

## Context

`packages/cas-core` reached its post-ring-generic shape in worklog 016:
`Poly<T>` is a sparse multivariate polynomial over an arbitrary
`Ring<T>`, and `RatFn<T>` is a pair `(num, den) ∈ Poly<T> × Poly<T>`
over a `Field<T>`. What it does *not* yet do is reduce a rational
function to lowest terms. `makeRatFn` sign-normalises the
denominator; `ratFnAdd / ratFnMul` cross-multiply; nobody divides
out a common factor.

The visible consequences:

- `cas-simplify` emits `(x²−1) / (x−1)` as exactly that, not as
  `x+1`. Two rational functions equal as field elements but differing
  in their (num, den) representation pass `ratFnEq` (which uses
  cross-multiplication) but fail `ratFnStructuralEq`.
- After three or four rational-function operations, numerators and
  denominators carry redundant common factors. Coefficients grow.
  An agent doing nontrivial computation hits this within a handful
  of steps.
- `cas-verify`'s witness on inequality (`lhs − rhs`) is unreduced.
  Useful but noisier than it should be.

The fix is polynomial GCD. Once `polyGcd(a, b, F)` exists,
`makeRatFn` divides num and den by their GCD, every `RatFn` produced
is in lowest terms, and the visible surface of cas-simplify becomes
substantively more capable without changing its public API.

## The axiom

The same one ADR-0011 applied: what would a senior TS expert who has
also seen Maple, Magma, FriCAS, and SymPy want here? Three things,
in order:

1. **A well-understood algorithm with explicit correctness, not a
   probabilistic one.** GCD is foundational; we will not be guessing.
2. **The same code over Q today and over Q[√2, i] tomorrow** — so
   issue `jfj`'s exact-symbolic path inherits GCD for free when the
   coefficient ring widens.
3. **Multivariate from day one if the cost is reasonable.** Univariate
   GCD with a documented "throws on multivariate" scope-limit would
   be honest scope, but the recursive multivariate algorithm is only
   modestly more code and unlocks a far larger class of practical
   inputs.

## Decision

### Algorithm: Brown-Collins subresultant PRS, recursive on variables

Univariate GCD over a field: classical Euclidean algorithm via
polynomial division. Cheap, correct, no ceremony.

Multivariate GCD over `Q[x_1, ..., x_n]` (or any `Field<T>` extended
to its polynomial ring): the recursive primitive-PRS algorithm with
**subresultant scaling** in the inner pseudo-remainder loop. The
recursion picks a main variable, computes the GCD of the
coefficient-polynomials in the remaining variables (a recursive call
on `n−1` variables), divides out the content, and computes the GCD
of the primitive parts via subresultant PRS. The result is the
content GCD times the primitive-part GCD.

Subresultant PRS is the classical Brown-Collins algorithm: a sequence
of pseudo-remainders, each scaled by a `β_i` factor derived from the
subresultant theorem so that intermediate coefficients stay bounded
(polynomial-time in the input size, not exponential). Without this
scaling, naive primitive-PRS exhibits exponential coefficient growth
on adversarial inputs; with it, the bound is polynomial. The proof
is in Knuth TAOCP §4.6.1, Geddes/Czapor/Labahn ch. 7, and is one of
the canonical results of computer algebra.

### What we will *not* do (for v0.1)

- **Modular / sparse modular GCD (Brown, Wang, Zippel).** Asymptotically
  faster on dense or sparse multivariate inputs, but introduces prime
  selection, bad-prime detection, leading-coefficient lifting, and CRT
  reconstruction — a substantially bigger surface. Filed as a follow-up
  beads issue once this lands.
- **Heuristic GCD (GCDHEU).** Probabilistic; needs verification step.
  Not in keeping with rule "deterministic by default."
- **Specialized GCD for Z[x] (over the integers).** Our coefficient
  ring is Q (a field). Subresultant over a field is simpler than over
  Z because there's no need to track integer content separately;
  every intermediate polynomial can be made monic.

### Where the categories sit

`ring.ts` had explicit prose: "If polynomial GCD lands as a generic
algorithm over `EuclideanDomain<T>`, that interface earns its place;
until then, it doesn't exist." This decision: **the interface still
doesn't earn its place.**

The reason is that our coefficient ring is `Field<T>` (Q today,
Q[√2,i] tomorrow). Over a field, every non-zero element is a unit,
and the polynomial ring `Field<T>[x_1, ..., x_n]` is a UFD. The
algorithm operates on `Poly<T>` values throughout; the only
operations on `T` itself are field operations (add, mul, div, inv).
We do not need a `EuclideanDomain<T>` or `GcdDomain<T>` interface on
the coefficient — `Field<T>` is sufficient.

When (if) we extend cas-core to coefficient rings that are *not*
fields — say, Z directly — that's the moment to introduce
`GcdDomain<T>`. Until then, the current minimalism stands.

### Public surface

```ts
// New module: packages/cas-core/src/poly-gcd.ts

/** Multivariate GCD over a field. Returns the monic associate
 *  (leading coefficient = R.one) by convention. gcd(0, 0) = 0;
 *  gcd(p, 0) = monic(p); gcd of constants = R.one if either is
 *  non-zero. */
export function polyGcd<T>(a: Poly<T>, b: Poly<T>, R: Field<T>): Poly<T>;

/** Exact polynomial division: returns q such that a = q * b. Throws
 *  if b does not divide a exactly. Used internally by GCD reduction
 *  and by cas-simplify's lowest-terms pass. */
export function polyDivExact<T>(a: Poly<T>, b: Poly<T>, R: Field<T>): Poly<T>;
```

Lower-level helpers (`polyDegInVar`, `polyCoeffsInVar`,
`polyPseudoDivide`, `polyContent`, `polyPrimitivePart`,
`polyMonicMultiple`) live in the same module but stay
package-private — exported only for tests. They're not part of the
agent-facing API surface.

### Integration: lowest-terms `RatFn`

`ratfn.ts` gains:

```ts
/** Reduce num/den by their polynomial GCD. Idempotent on already-
 *  reduced inputs. */
export function ratFnReduce<T>(rf: RatFn<T>, R: Field<T>): RatFn<T>;
```

`makeRatFn` calls `ratFnReduce` immediately before sign-normalisation,
so every `RatFn` constructed via the canonical path is in lowest
terms. `ratFnAdd / ratFnSub / ratFnMul / ratFnDiv` all funnel through
`makeRatFn`, so reduction is implicit at every step.

### Behavioural impact on existing tools

- **`cas-simplify`** now emits the lowest-terms form of every
  rational function. `(x²−1) / (x−1)` becomes `x+1`. Goldens
  regenerate; version bumps from `0.x` to `0.(x+1)` to mark the
  change.
- **`cas-verify`** is unaffected for equality decisions (cross-
  multiplication stays sound) but *witnesses on inequality* are
  now reduced — `lhs − rhs` arrives in lowest terms.
- **`ratFnStructuralEq`** becomes the strong equality: two `RatFn`s
  agree structurally iff they're equal as field elements, because
  every constructed `RatFn` is in canonical lowest-terms form.
  Previously this was a strictly weaker test than `ratFnEq`; after
  this ADR, the two coincide.

### Tests

In `packages/cas-core/test/poly-gcd.test.ts`:

- **Algebraic identities.** `gcd(p, p)` is the monic associate of
  `p`; `gcd(p, 0) = monic(p)`; `gcd(0, 0) = 0`; `gcd(p, 1) = 1`;
  `gcd(p · q, p · r)` is divisible by `monic(p)` and the quotient
  is `gcd(q, r)`.
- **Specific worked cases.** `gcd(x²−1, x²+2x+1) = x+1`;
  `gcd((x−1)(x−2), (x−2)(x−3)) = x−2`;
  `gcd(x², x+1) = 1`; `gcd(x²y − y, xy − y) = y(x−1)`.
- **Multivariate stress.** Random polynomials of degree ≤ 4 in ≤ 3
  variables; verify `gcd(g·a, g·b) ≡ monic(g) · gcd(a, b)` for
  random `g, a, b`.
- **Exact division.** `polyDivExact(g · q, g, R) = q` for random
  `g, q`; `polyDivExact(a, b, R)` throws when `b ∤ a`.
- **Mutation-prove.** Perturb the implementation (skip the
  subresultant `β` factor, or return a non-monic associate);
  confirm the property tests fail loudly.

In `packages/cas-core/test/cas-core.test.ts` (extending the existing
property tests):

- **`makeRatFn` always produces lowest terms.** For random
  `(num, den)` over Q[x, y, z], the result satisfies
  `polyGcd(rf.num, rf.den, R) = polyOne(R)`.
- **`ratFnStructuralEq` ≡ `ratFnEq`** on canonically-constructed
  `RatFn`s. This was strictly weaker before; afterward it's the
  same predicate up to representation.

## Consequences

**Positive.**

- The narrowest, biggest gap in cas-core's stated capability closes.
- Every downstream tool (`cas-simplify`, `cas-verify`, future
  `cas-factor`, future `cas-integrate` Hermite reduction) inherits
  GCD reduction transparently.
- The same algorithm runs over Q[√2, i] when issue `jfj` lands —
  algebraic-number coefficients flow through `Field<T>` unchanged.
- `ratFnStructuralEq` becomes a meaningful predicate (currently it's
  weaker than `ratFnEq`).
- A user-facing payoff: agents doing rational arithmetic stop
  seeing coefficient explosion within the typical session length.

**Negative / accepted.**

- `cas-simplify` goldens regenerate. The output for any input that
  contained reducible rational subterms changes. Documented;
  expected; the version bump signals it.
- Subresultant PRS is ~150–200 LOC of careful arithmetic. The bug
  surface is real — wrong `β` coefficient produces wrong results.
  Mutation-prove compensates.
- For degenerate inputs (high-degree dense multivariate), this MVP
  is slower than modular GCD would be. Worth it for an MVP;
  modular comes when we have a workload that demands it.

## Acceptance (when this ADR ships as Accepted)

- `packages/cas-core/src/poly-gcd.ts` exists with `polyGcd` and
  `polyDivExact` exported.
- `packages/cas-core/test/poly-gcd.test.ts` covers the test plan
  above, all green, mutation-proven on at least three perturbations.
- `ratfn.ts` integrates `ratFnReduce`; every `makeRatFn` produces
  lowest-terms output.
- `cas-simplify` goldens regenerated; oracle pass on the new bytes.
- `cas-simplify`'s version bumps and the README catalog row updates
  to remove the "No polynomial GCD reduction in v1" caveat.
- ADR-0013 is Accepted; worklog 030 records the iteration; a
  follow-up beads issue is filed for modular GCD as v0.2.

## Pointers

- `packages/cas-core/src/ring.ts:33-43` — the prophetic comment that
  this ADR fulfills.
- `packages/cas-core/src/poly.ts` — the ring-generic polynomial
  module this builds on.
- `packages/cas-core/src/ratfn.ts:56-70` — `makeRatFn` integration
  point.
- ADR-0008 — the ring-generic refactor that makes this generic.
- `docs/cas-core-roadmap.md` — the broader trajectory; GCD is rung
  3 on that ladder, between rings (rung 1) and algebraic numbers
  (rung 2).
- Knuth TAOCP §4.6.1, Geddes/Czapor/Labahn ch. 7 — the classical
  references for subresultant PRS.
