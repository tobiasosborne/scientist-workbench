# 030 — Polynomial GCD in cas-core

**Date:** 2026-05-03
**Status:** complete
**Branches:** main
**ADR:** [0013-polynomial-gcd](../adr/0013-polynomial-gcd.md)
**Issues closed:** scientist-workbench-djr (P2)
**Issues filed:** scientist-workbench-* (modular GCD as v0.2 follow-up; P4)

## Context

The biggest gap in cas-core's stated capability — and the thing the
honest-overview pass earlier in the day named as the load-bearing
narrowness in the project — was that nothing reduced rational
functions to lowest terms. `(x²−1)/(x−1)` came out of `cas-simplify`
unchanged. After three or four rational-function operations,
numerators and denominators carried redundant factors and
coefficients grew. The `cas-simplify` "canonical form" claim and the
"idempotent" invariant were technically true but quieter than they
sounded.

The substrate was already prepared for this: ADR-0008 (rung 1 of the
cas-core roadmap) had refactored cas-core to be ring-generic, and
`packages/cas-core/src/ring.ts` carried a deliberate prophetic line:

> If polynomial GCD lands as a generic algorithm over
> `EuclideanDomain<T>`, that interface earns its place; until then,
> it doesn't exist.

Beads `djr` (P2, filed 2026-04-29) tracked the work. ADR-0013 was
the design pass; this shard is the implementation.

## What changed

**`packages/cas-core/src/poly-gcd.ts`** (new, ~450 LOC). The
algorithm is the classical Brown–Collins subresultant PRS, made
recursive on variables. The shape:

```
polyGcd(a, b, R: Field<T>):
  base cases: zero-zero, zero-other, constant
  pick alphabetically-first variable v in vars(a) ∩ vars(b)
  contentA = polyGcd(coeffs of a in v)   // recurse on (n−1) vars
  contentB = polyGcd(coeffs of b in v)
  primA = polyDivExact(a, contentA)
  primB = polyDivExact(b, contentB)
  primGcd = subresultantPRS(primA, primB, v)
  contentGcd = polyGcd(contentA, contentB)   // recurse
  result = contentGcd · primGcd
  return polyMakeMonic(result)
```

Public surface: `polyGcd` and `polyDivExact`. Lower-level helpers
(`polyContent`, `polyPrimitivePart`, `polyPseudoDivide`,
`polyMakeMonic`) are exported as `_…ForTests` for white-box testing
but are not part of the agent-facing API.

**`packages/cas-core/src/poly.ts`** — added variable-view helpers
`polyVars`, `polyDegInVar`, `polyCoeffsInVar`,
`polyFromCoeffsInVar`. These are ring-aware but not field-requiring;
they're the algebraic counterpart to `compareExp` and `expAdd` —
low-level structural manipulation that the GCD algorithm and any
future algorithm needing main-variable views can layer on. Tested
via round-trip property: `polyFromCoeffsInVar(polyCoeffsInVar(p, v),
v) = p` for arbitrary p and any variable v of p.

**`packages/cas-core/src/ratfn.ts`** — `makeRatFn` now calls a new
`ratFnReduce(rf, R)` before sign-normalisation. Every `RatFn`
constructed through the canonical path is in lowest terms.
`ratFnReduce` is also exported for callers that want to make the
cost explicit at a particular call site.

**`packages/cas-core/src/index.ts`** — re-exports `polyGcd`,
`polyDivExact`, `ratFnReduce`, plus the four variable-view helpers.

**`packages/cas-core/test/poly-gcd.test.ts`** (new, ~270 LOC).
39 tests across five blocks: variable-view round-trip;
`polyDivExact` (worked cases + thrown-on-non-exact); `polyGcd`
worked examples (univariate, multivariate, coprime, constants);
edge cases (zero, units, no-shared-vars); algebraic identities
(monic, idempotence, multiplicative, divides-both, symmetry); and
30 random multivariate stress triples over Q[x, y, z] verifying
`monic(g)` divides `gcd(g·a, g·b)` for arbitrary g, a, b.

**`tools/cas-simplify/`** — version bumped 0.3.0 → 0.4.0. Goldens
regenerated; one golden's *name* changed because its description
was updated (from "rational function unreduced" to "(x²−1)/(x−1)
reduces to x+1 (ADR-0013: GCD-reduced)") and the filename derives
from description. The golden's *content* is now the canonical
output `x + 1` instead of the unreduced `(x² + (−1))/(x + (−1))`
— precisely the change the ADR documents.

**Lockstep doc updates:**
- `README.md` cas-simplify catalog row: dropped the "**No
  polynomial GCD reduction in v1.**" caveat; added the ADR-0013
  reduction note.
- `tools/cas-simplify/README.md`: same.
- `tools/cas-verify/README.md`: clarified that cross-multiplication
  is GCD-free for *equality decisions* but witnesses on inequality
  are now reduced (because `lhs − rhs` flows through `makeRatFn`
  which now reduces).
- `PRD-v0.2.md`: struck through the "no GCD in v1" entries in §0.1
  and §9.3, noted the supersession by ADR-0013, kept the modular-
  GCD follow-up as a future direction.

**`packages/cas-core/test/cas-core.test.ts`** — bumped the
"idempotent: simplify(simplify(v)) = simplify(v) — 200 random trees"
test's timeout from Bun's 5s default to 30s. The test still passes
on its property; GCD reduction now runs in `makeRatFn` per
construction, and 200 nested-rational-tree iterations with real
GCD work need more headroom than the default budget allows. The
property is unchanged; only the timing budget moved.

## Why these choices

**Subresultant PRS over modular methods.** ADR-0013 §"What we will
*not* do" laid out the trade-off. Subresultant is deterministic,
direct, polynomial-time, and ~150 LOC of careful arithmetic.
Modular GCD is asymptotically faster on adversarial inputs but
introduces prime selection, bad-prime detection, leading-coefficient
lifting, and CRT reconstruction — substantially more surface area
for a v0.1. The modular path is filed as a follow-up beads issue
once a workload demands it.

**Recursive multivariate, not Brown–Yun's modular evaluation.** The
recursive primitive-PRS-with-subresultant-scaling approach is the
classical "small CAS" multivariate GCD: pick a main variable, peel
off content, recurse on coefficients, run subresultant PRS on the
primitive parts viewed as univariate over the integral domain of
remaining-variable polynomials. Performance-wise, it's worse than
Brown–Yun on dense multivariate; for typical agent-scale inputs
(degrees ≤ 5, ≤ 4 variables), it's fine.

**Keep `Field<T>` as the only category.** ring.ts's prophecy was
that `EuclideanDomain<T>` would earn its place when GCD landed.
ADR-0013 deliberately doesn't introduce it. The reason: our
coefficient ring is `Field<T>` (Q today, Q[√2,i] tomorrow). Over a
field, every non-zero element is a unit, and the polynomial ring
`Field<T>[x_1, ..., x_n]` is a UFD. The algorithm operates on
`Poly<T>` values throughout; the only operations on `T` itself are
field operations. We don't need a separate
`EuclideanDomain<T>` interface on the coefficient — the polynomial
side handles UFD-shaped reasoning structurally. The category
discipline ("we add a category when an algorithm earns it") gets to
hold for one more iteration.

**Reduce inside `makeRatFn`, not at an explicit call site.** The
alternative was a `ratFnReduce(rf, R)` that callers invoke when they
want lowest-terms form. Rejected: `cas-simplify`'s whole job is
canonical form; it would have to call reduce anyway, and so would
every other consumer. The cost is one polyGcd per `makeRatFn`,
which for typical inputs is microseconds. We pay it always so the
canonical-form invariant is structural, not behavioural.

**Behavioral version bump on cas-simplify.** v0.3.0 → v0.4.0 marks
the change for any consumer reading the version field. The
provenance store keys derivations on `(tool.name, tool.version,
inputs[0].hash)`, so an old provenance record from v0.3.0 *won't*
mismatch with a new v0.4.0 invocation — they're keyed differently.
This is the right semantics.

## Frictions surfaced

**1. Mutation-proving revealed which claims are correctness vs.
performance.** The first mutation tried (skip the β-division step)
left all 39 tests green. Confused me for a moment until I realised:
β-scaling is the *coefficient-bound* property of subresultant PRS,
not the *correctness* property. Without β, the algorithm computes
the right GCD (mod a unit), just with exponentially-growing
intermediate coefficients on adversarial inputs. The tests test
correctness, which is what they should. Three subsequent mutations
(drop monic normalisation, drop primitive-part extraction, swap
mul→add at the final composition step) all caught failures
immediately. Documented in ADR-0013's open questions: a future
"performance regression" test could check that intermediate
coefficient bit-widths stay small on a stress input — that's the
test that would catch β regressions.

**2. Bun's default test timeout is per-test, not per-file.** The
"200 random trees" idempotence test in `cas-core.test.ts` blew its
5s budget once GCD reduction was wired in (~43ms per tree × 200
trees = 8.6s). The test was *correct*; it was just slow. Bumped
the per-test timeout to 30s. Worth flagging because the default is
narrow enough that any future "expensive property test" needs the
same treatment.

**3. The golden filename derived from the test description.** The
golden 21 was named `21-rational-function-unreduced.golden.json`,
which became misleading once the output was reduced. Updating the
description (to "(x²−1)/(x−1) reduces to x+1") changed the slugified
filename to `21-x-2-1-x-1-reduces-to-x-1-adr-0013-gcd-reduced.golden.json`.
Old file deleted, new file written. The point is that test
descriptions are part of the wire surface — they shape filenames
that get committed. Update them deliberately.

**4. PRD entries that said `[SETTLED]`-shaped things needed
amending, not deleting.** §0.1 and §9.3 of the PRD both said "no
polynomial GCD in v1" as deliberate scope choices. ADR-0013
supersedes those decisions; the PRD's history is preserved by
strikethrough rather than deletion, with an explicit "Updated by
ADR-0013 (2026-05-03)" note. A reader can see what was decided
when, and what changed it.

**5. Lots of system-reminder nudges to use TaskCreate.** Per
CLAUDE.md Rule 9 ("beads is the only tracker") I ignored them, as
in shards 028 and 029. Worth recording for the third time so a
future agent doesn't second-guess the policy.

## Acceptance

- `bun run check` is green: 31 phases pass, 4 skipped, 0 failed.
- `bun test packages/cas-core/test/poly-gcd.test.ts` reports 39
  pass, 0 fail, 69 expect calls, ~140ms.
- The full `cas-core.test.ts` workspace test passes within the
  bumped timeout (~10s including the GCD-stressed trees).
- Mutation-proven on three perturbations (drop monic, drop
  primitive-part, swap mul→add); all caught.
- `cas-simplify` v0.4.0 reduces `(x²−1)/(x−1) → x+1`; verified by
  the regenerated golden 21.
- `cas-verify` continues to decide equality correctly (cross-
  multiplication unchanged); witnesses on inequality are now in
  lowest terms.
- README, PRD, both tool READMEs updated in lockstep.

## Pointers

- `packages/cas-core/src/poly-gcd.ts` — the entire module; 450
  LOC including the literate prose.
- `packages/cas-core/src/poly.ts:230-360` — variable-view
  helpers added for this work.
- `packages/cas-core/src/ratfn.ts:67-110` — `makeRatFn`'s new
  reduce step + `ratFnReduce` export.
- `packages/cas-core/test/poly-gcd.test.ts` — the 39-test suite.
- `tools/cas-simplify/goldens/21-x-2-1-x-1-reduces-to-x-1-adr-0013-gcd-reduced.golden.json`
  — the regenerated golden showing the reduction.
- ADR-0013 — design rationale, algorithm choice, alternatives
  considered, references (Knuth TAOCP §4.6.1; Geddes/Czapor/Labahn
  ch. 7; Brown 1971).
- Beads `djr` (closed) — the issue this shard resolves.
- Beads (new follow-up) — modular GCD as v0.2 (P4).

## Open questions

- **Performance regression test.** Mutation #1 (skip β-scaling)
  passed all correctness tests because subresultant's value over
  primitive-PRS is coefficient-bound, not result-correctness. A
  future test on a stress input (e.g., gcd of two random degree-15
  univariates) could assert that intermediate coefficient
  bit-widths stay below some bound — that's the test that catches
  β regressions specifically. Out of scope for this shard.
- **`gcd(a, b)` over Q[√2, i].** ADR-0013 claims this works "for
  free" because the algorithm is generic over `Field<T>`. It's
  unverified for the algebraic-numbers ring until issue `jfj`
  exercises it. The recursion structure should be agnostic, but
  there may be subtleties (e.g., the algebraic ring's `eq` is
  expensive). Worth a smoke test once `algebraic.ts` is
  fully fleshed out.
- **Modular GCD for the v0.2 follow-up.** The performance gap is
  real on adversarial inputs but not on typical workbench-scale
  inputs. Defer until a real workload (probably some Hermite
  reduction or partial-fractions pass) hits the bound.
