# 145 — cas-core pattern primitives: `isPositiveInteger`, `isNonNegativeInteger`, `isHalfInteger` (2026-05-17)

> **Scope.** Land Phase 2 Round 1 bead `7j02` (I6b) of the World-class
> Bessel epic (`zcam`): create `packages/cas-core/src/pattern.ts` with
> three pure pattern-condition predicates. R1 Discovery B (`docs/refs/
> besselj-research/R1-symbolic-identities.md` §18) surfaced these as
> load-bearing for the half-integer-closure rule family (R1 §16
> priority-class C) and the spherical-Bessel non-negative-integer
> constraint (DLMF §10.47); ADR-0041 §"Decision 6" pinned them as a
> separate concern from the I6a vocabulary amendment (`vsvl` /
> worklog 144).

## Context

The I4 Bessel identity rules (bead `lrmo`) implement ~30 rules from
R1 §16, eight of which (priority-class C, the half-integer closures
`J_{1/2}(z) = √(2/(πz))·sin(z)` and seven siblings) gate on
`isHalfInteger(ν)`. R1 §14.2 audited the existing cas-core pattern
language and found no such predicate — `diff.ts` ships `isZero` /
`isOne` for smart-constructor short-circuiting (different concern), but
nothing for shape-classification at rule-guard time. I6b ships the
three predicates the R1-shippable rule table needs.

## What changed

`packages/cas-core/src/pattern.ts` (new, ~150 LOC literate prose +
small implementations); `packages/cas-core/test/pattern.test.ts` (new,
58 tests); `packages/cas-core/src/index.ts` (re-export). The three
predicates are total functions `(v: Value) => boolean` over the
`@workbench/protocol` AST; non-numeric kinds always return `false`
without throwing (a hard invariant — see in-file rationale).

The implementations use `BigInt` arithmetic throughout (`BigInt(v.value)`
for integer-kind; `BigInt(v.num)` / `BigInt(v.den)` for rational-kind)
so arbitrary-size numerators / denominators classify correctly — a
load-bearing decision because rule-guards may consult these at
arbitrary precision. `isHalfInteger` reduces a rational to lowest
terms internally before classifying so `4/2` → `2/1` is correctly
rejected (integer, not half-integer); `7/2` is accepted.

## Why these choices

R1 §14.2 proposed a higher-order generalisation
`isIntegerLiteralCondition(v, (n: bigint) => boolean)` that subsumes
all three. I6b declined the generalisation per CLAUDE.md "Three
similar lines is better than a premature abstraction": the three
concrete predicates are the only shapes any v0.1 rule needs, the
generalisation costs a higher-order indirection at every consumer
site, and the per-name docstring is the readable place to pin the
DLMF-section consumer-mapping. If a future rule needs e.g.
`isEvenInteger`, add it as a fourth named predicate, not by
generalising. The file's top-of-module narrative explains this
decision honestly.

The predicates live in a dedicated `pattern.ts` (not folded into
`diff.ts`) because the *concern is different*: `diff.ts`'s `isZero`
/ `isOne` exist for ring-arithmetic short-circuiting (consumed by
`mkPlus` etc.); these predicates exist for *declarative rule
guards*. The R1-discovered rule tables in
`src/special-funcs/bessel-identities.ts` (and the existing
`erf-identities.ts`) import only this module, not the diff substrate
— preserving the per-concern boundary.

## Frictions surfaced

1. **Rational-reduction discipline for `isHalfInteger`.** The
   rational kind admits non-reduced forms (`4/2`, `6/4`) per protocol;
   the predicate must canonicalise via `gcd` before checking
   `den === 2n`. Caught by mutation `M2` (drop the den-check) — RED
   confirms the rule fires.
2. **`-0` rational invariant.** A rational with `num === 0n` is
   always reducible to `0/1`; `isHalfInteger` should reject `0/2`
   (= 0 = integer, not half-integer). Verified explicitly.
3. **Boundary test discipline.** Each predicate has ≥ 12 test cases
   covering positive / negative / zero / boundary-half-integer /
   integer-as-rational / symbol / expression / boolean / string
   Values. The "always returns boolean, never throws" invariant is
   tested explicitly with each non-numeric kind.

## Mutation-proving

Documented inline in `pattern.test.ts` header:

- **M1** — Flip `>=` to `>` in `isNonNegativeInteger` → "zero
  classifies as non-negative" test RED.
- **M2** — Accept all rationals as half-integer (drop the
  reduced-`den === 2n` check) → "`5/3` is not half-integer" test RED.
- **M3** — Treat negative integer as positive → "`-1` not positive"
  test RED.

Each perturbation verified locally by toggle / `bun test
packages/cas-core/test/pattern.test.ts` / restore.

## Acceptance

- `packages/cas-core/src/pattern.ts` shipped (~150 LOC) with literate
  prose covering: what predicates do, why they live in a separate
  module from `diff.ts`, why three named predicates not one
  generalisation, DLMF source citation per predicate.
- 58 tests, all green via `bun test packages/cas-core/test/pattern.test.ts`.
- `bun run check` green (full 14-phase) verified post-integration by
  orchestrator.
- Mutation-proving documented + verified.

## Pointers

- ADR-0041 §"Decision 6" (the pattern-primitives architectural pin)
- R1 §14 / §18 (the literature analysis recommending these three)
- `packages/cas-core/src/special-funcs/erf-identities.ts` (the
  consumer-side styling exemplar from the Erf epic)
- I4 bead `lrmo` (the immediate downstream consumer; blocked-on I6b)

## Honest scope

I6b's subagent dispatch hit the harness's per-job duration cap
before reaching the `bd close 7j02` step. The code, tests, and
in-file literate prose all landed cleanly in main (verified by
inspection + 58 tests); this worklog shard was written by the
orchestrator post-hoc as part of the close-out. The substantive
work is the subagent's; the synthesis here cites it.
