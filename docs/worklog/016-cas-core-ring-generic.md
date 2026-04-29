# 016 — cas-core ring-generic refactor

**Date:** 2026-04-29
**Status:** complete
**Branches:** main
**Issues:** scientist-workbench-but (ADR 0008, closed in shard 016 prelude),
 scientist-workbench-t87 (closed)
**ADR:** [docs/adr/0008-cas-core-ring-generic-and-algebraic-numbers.md](../adr/0008-cas-core-ring-generic-and-algebraic-numbers.md)
**Roadmap:** [docs/cas-core-roadmap.md](../cas-core-roadmap.md)

## Context

The previous shard (015 — `tools/sturm-simplify`) closed Phase 1's
canonicaliser slot. The next Phase 1 issue, `tkx` (`sturm-execute`),
needs exact-symbolic Clifford+T amplitudes — natural ring is
`Q[√2, i]`. cas-core's existing v0.1 hardcoded Q as the coefficient,
so adding a new ring meant either special-casing the substrate or
properly refactoring it.

The user reframed the question: cas-core is meant to grow into a
real CAS, on feature parity with Mathematica/SymPy/Maple/FriCAS.
"Adding algebraic numbers" isn't out-of-scope for cas-core; it's
the natural next rung of cas-core's intended evolution. Two
sidequest artefacts captured this:

- `docs/cas-core-roadmap.md` — the working trajectory document with
  the library-vs-tool split, the capability map, and the priority-
  ordered ladder.
- `docs/adr/0008-cas-core-ring-generic-and-algebraic-numbers.md` —
  the formal ADR for the ring-generic refactor (rung 1) and
  algebraic-numbers (rung 2).

This shard is rung 1: the refactor itself. The algebraic-numbers
issue (1s4) lands in shard 017 on top of it.

## What changed

### `packages/cas-core/src/ring.ts` (new)

A small abstract interface declaring what every coefficient ring
satisfies:

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

export interface Field<T> extends Ring<T> {
  readonly inv: (a: T) => T;
  readonly div: (a: T, b: T) => T;
}
```

Deliberately minimal — no FriCAS-style category lattice
(`CommutativeRing`, `IntegralDomain`, `GcdDomain`, `UFD`, …) until a
concrete operation needs the additional structure. We add a category
when an algorithm earns it.

### `packages/cas-core/src/rat.ts` — Q as the v0.1 instance

Existing `Rat`, `ratAdd`, `ratMul`, etc. preserved verbatim. New
`RAT_RING: Field<Rat>` export bundles them into the abstract
dictionary. Also added: `ratInv` (which previously didn't exist as a
named export, since the Q case used `ratDiv(RAT_ONE, x)` ad hoc).

### `packages/cas-core/src/poly.ts` — `Poly<T>` generic

`Monomial<T>` and `Poly<T>` are now generic in the coefficient. Every
arithmetic function takes `R: Ring<T>` as an explicit parameter:

```ts
export function polyAdd<T>(a: Poly<T>, b: Poly<T>, R: Ring<T>): Poly<T>;
export function polyMul<T>(a: Poly<T>, b: Poly<T>, R: Ring<T>): Poly<T>;
// etc.
```

`POLY_ZERO` is preserved as a constant typed `Poly<never>` —
structurally polymorphic, assignable to any `Poly<T>`. `POLY_ONE`
becomes the factory `polyOne(R)` since it needs `R.one`. Same pattern
for `polyVar(name, R)`, `polyConst(c, R)`, `polyConstValue(p, R)`,
`polyLeadingCoef(p, R)`, `polyEq(a, b, R)`, `polyIsOne(p, R)`.

`polyIsZero(p)` and `polyIsConst(p)` stay ring-free — they're purely
structural shape checks.

### `packages/cas-core/src/ratfn.ts` — `RatFn<T>` generic

Same pattern. Operations take `R: Field<T>` (Field, not just Ring —
rational-function arithmetic needs division for the underlying
polynomial reductions, although for the cross-multiplication equality
check the ring itself suffices).

The Q sign-normalisation (flip-when-leading-coef-of-den-negative) is
now an explicit option:

```ts
export interface RatFnOptions<T> {
  readonly signNormalise?: (leadingCoefOfDen: T) => boolean;
}
```

`makeRatFn(num, den, R, opts)` is the generic constructor.
`makeRatFnQ(num, den)` is the Q-bound shortcut that auto-passes the
sign normalisation. `RATFN_ZERO` and `RATFN_ONE` are pre-bound Q
constants for ergonomic use.

`ratFnZero(R)` and `ratFnOne(R)` are factories. We considered making
zero universal (no R needed) but rejected — a zero RatFn is `0/1`,
and `1` needs the ring's one. Honest factories beat phantom
"den-irrelevant-when-num-is-zero" hacks.

### `packages/cas-core/src/expr-bridge.ts` — Q-specific by design

The bridge from arbitrary `Value` to `RatFn<T>` requires knowing how
to map `IntegerValue` and `RationalValue` to T — a per-ring concern.
This module stays Q-specific in v0.2; the algebraic-number bridge
will live in `algebraic.ts` alongside the algebraic-ring
implementation. Internally, calls to `polyAdd`, `ratFnMul`, etc. now
thread `RAT_RING` explicitly. The public functions
(`valueToRatFn`, `ratFnToValue`, `polyToValue`, `ratFnConstValue`)
return / accept `RatFn<Rat>` / `Poly<Rat>` — Q-typed.

### `packages/cas-core/src/verify.ts` and `simplify.ts`

`verify.ts` adds `RAT_RING` import, threads it through `ratFnEq`,
`ratFnSub`. `simplify.ts` is unchanged — it operates on Values
through the bridge, no ring threading needed at that level.

### Public surface (`src/index.ts`)

New exports:
- `Ring`, `Field` types from `ring.ts`
- `RAT_RING` from `rat.ts`
- `polyZero`, `polyOne` factories
- `ratFnZero`, `ratFnOne`, `makeRatFnQ`, `RatFnOptions`
- `ratInv`

Removed: `POLY_ONE` (replaced by `polyOne(R)` factory). No external
consumer of cas-core was using it directly — verified by grep.

### Tests

`packages/cas-core/test/cas-core.test.ts` updated — every call site
that previously used `polyAdd(a, b)` now uses `polyAdd(a, b, RAT_RING)`,
and similarly for the other arithmetic functions. ~50 line-level
edits, all mechanical. Test count and structure unchanged.

## Verification

`bun run check`: 16/16 phases pass.

```
▸ typecheck (tsc --noEmit) ... ok
▸ bun test (workspace property tests) ... ok (1488 expect()s)
▸ tool --test: cas-simplify, ntt, mod-inv, mod-pow, expr-parse,
  sturm-simplify ... all ok
▸ oracle: every tool's goldens ... all ok
```

Mutation-proven (per CLAUDE.md Rule 6): replacing `RAT_RING.add:
ratAdd` with `RAT_RING.add: ratSub` (a one-line stub in `rat.ts`)
caused 16 of 26 cas-core tests to fail (everywhere addition is the
load-bearing operation: ring-axiom commutativity, distributivity,
power agreement, the bridge tests). Restoring brought all tests back
to 26/26 passing. The tests demonstrably catch a regression in the
ring abstraction.

## Why these choices

**Explicit Ring at the call site, not bound to the value.** A `Poly<T>`
is pure data — no embedded function-pointer payload. The price is one
extra argument per call; we pay it. Discussed in ADR-0008's
"Alternatives considered."

**Minimal Ring/Field interface.** Resisted the urge to import FriCAS's
full categorical hierarchy upfront. Add categories when algorithms
need them (e.g., `EuclideanDomain<T>` will earn its place when
polynomial GCD lands in issue djr).

**Q-specific bridge in `expr-bridge.ts`.** Generic Value-to-RatFn
translation requires knowing how to map number kinds to a target
ring's elements — that's per-ring work. Each new ring brings its own
bridge module. Keeping `expr-bridge.ts` Q-specific is honest scope.

**`POLY_ZERO` as a constant typed `Poly<never>`.** Empty term-list is
universally a `Poly<T>` for any T. The phantom-typed constant means
callers can still write `if (polyIsZero(p)) return POLY_ZERO;` without
knowing the ring. `POLY_ONE` is *not* universal (needs R.one), so it
becomes the factory `polyOne(R)`.

**`makeRatFnQ` as a Q-bound shortcut.** The Q sign-normalisation is
common enough at call sites that exposing the curried Q form keeps
internal expression-bridge code readable. Other rings construct via
`makeRatFn(num, den, R, opts)` directly.

## Frictions surfaced

- **Test-file churn was substantial but bounded.** ~50 edits across
  the test file. Mostly mechanical (`polyAdd(a, b)` →
  `polyAdd(a, b, RAT_RING)`). Easy to verify by re-running the suite
  after each chunk.

- **The `ratFnIsConst` shape check tempted me to keep it ring-free.**
  Reading `polyIsOne(a.den)` requires R because "one" is ring-
  specific. I initially tried a placeholder `_trustOneRing()` that
  threw at runtime — a bad hack. Replaced with a clean
  `ratFnIsConst(a, R)` signature. The lesson: when the abstraction
  forces a parameter, accept it; don't paper over with phantom
  values.

- **`expr-bridge.ts` is Q-specific now in a way that wasn't quite
  before.** Pre-refactor, the Q-ness was implicit in the imports
  (`ratAdd`, etc.); post-refactor, it's structural — every internal
  call passes `RAT_RING`. This actually clarifies the file's role: it
  *is* the Q-bridge, and the algebraic-number bridge will be its
  sibling, not a refactor of it.

- **`expr-bridge`'s `ratFnConstValue` returns `Rat | null`.** When
  the algebraic-number ring lands, a parallel `algRatFnConstValue`
  will return `AlgebraicElement<R> | null`. The naming convention
  for parallel bridges (one per ring) is open — for now,
  `expr-bridge.ts` is the Q name; future bridges will pick names as
  they land.

## Acceptance

- `packages/cas-core/src/ring.ts` exists with the `Ring<T>` and
  `Field<T>` interfaces.
- `Poly<T>`, `RatFn<T>` are generic; arithmetic functions take an
  explicit ring parameter.
- `RAT_RING: Field<Rat>` exported from `rat.ts` and re-exported from
  the package index.
- All 47 existing cas-core tests pass without behavioural changes.
- `bun run check` is 16/16 green.
- Mutation-proven via the `RAT_RING.add` swap.
- `docs/cas-core-roadmap.md` and ADR-0008 cross-referenced
  throughout.
- Issue scientist-workbench-t87 closed.

## Pointers

- ADR-0008 — the design.
- `docs/cas-core-roadmap.md` — the trajectory; this shard lands rung 1.
- `packages/cas-core/src/ring.ts` — the new interface.
- `packages/cas-core/src/poly.ts`, `ratfn.ts`, `rat.ts`, `expr-
  bridge.ts`, `simplify.ts`, `verify.ts` — the refactored
  implementation.
- `packages/cas-core/test/cas-core.test.ts` — the updated tests
  (still 26 testsets / 47 assertions / load-bearing per
  mutation-prove).
- Next shard 017: rung 2 — algebraic-numbers (issue
  scientist-workbench-1s4).
