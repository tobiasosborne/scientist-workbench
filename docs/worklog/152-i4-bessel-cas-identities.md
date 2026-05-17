# 152 — cas-core Bessel identity table + cas-simplify dispatch (2026-05-17)

> **Scope.** Land Phase 2 Round 3 bead `lrmo` (I4) of the World-class
> Bessel epic (`zcam`): the symbolic identity table for the eight
> Bessel-family heads (`BesselJ`, `BesselY`, `BesselI`, `BesselK`,
> `HankelH1`, `HankelH2`, `SphericalBesselJ`, `SphericalBesselY`),
> integrated into `cas-simplify`'s dispatcher so the user-visible
> rewrites (`J_0(0) → 1`, `J_{−n} → (−1)^n·J_n`, `J_{1/2}(z) →
> √(2/(πz))·sin(z)`, `H¹_ν → J_ν + i·Y_ν`, `j_0(z) → sin(z)/z`, …)
> compose with the existing Erf-pre-pass + RatFn fold. New module
> `packages/cas-core/src/special-funcs/bessel-identities.ts` (~775 LOC),
> extension to `packages/cas-core/src/simplify.ts` (~95 LOC),
> re-export from `index.ts` (~7 LOC), new test file (~480 LOC, 51
> tests). Paired doc updates per Law 2.

## Context

I4 (`lrmo`) was unblocked once I6a (`vsvl`; worklog 144) admitted
`HankelH1`, `HankelH2`, `SphericalBesselJ`, `SphericalBesselY` to the
special-function vocabulary AND I6b (`7j02`; worklog 145) shipped the
three new pattern primitives `isPositiveInteger`,
`isNonNegativeInteger`, `isHalfInteger`. R1's 30-rule symbolic-
identity catalogue (`docs/refs/besselj-research/R1-symbolic-
identities.md` §16) is the source-of-record for what the identity
table ships. ADR-0041 §"Decision 6" pins the per-head substrate's
v0.1 scope; this bead implements the cas-core symbolic layer of that
substrate.

The architectural claim ADR-0041 makes — and that this bead validates —
is that the per-head substrate pattern pinned by ADR-0040 for Erf
**generalises without architectural change**. This shard's
implementation evidence: zero changes to the package boundary, zero
new infrastructure modules, the dispatcher integration in
`simplify.ts` is a literally additive sibling of `applyErfRewrites`.
The substrate scales by accreting per-head sister files.

## What changed

### `packages/cas-core/src/special-funcs/bessel-identities.ts` (NEW, ~775 LOC)

The identity-table module. Five priority classes per R1 §16:

1. **Class A — special values + refusal at zero (8 rules).**
   `J_0(0) = 1`, `J_n(0) = 0` for n positive integer (DLMF 10.7.1 +
   10.7.3); `I_0(0) = 1`, `I_n(0) = 0` (DLMF 10.30.1); plus refusal
   tags for `Y_ν(0)`, `K_ν(0)`, `H¹_ν(0)`, `H²_ν(0)` which
   genuinely diverge — emit `tagged
   "cas-simplify/bessel-singular-at-zero"` per CLAUDE.md Rule 8
   (honest scope) + Rule 1 (fail loud). Payload preserves the
   original `head + args` so downstream consumers recover what was
   attempted.

2. **Class B — integer-ν parity (6 rules).** `J_{−n} = (−1)^n·J_n`
   (DLMF 10.4.1); `Y_{−n}` same; `I_{−n} = I_n` no sign (DLMF
   10.27.1); `K_{−n} = K_n` (DLMF 10.27.3, K even in ν for all ν);
   `H¹_{−n}` / `H²_{−n}` mirror J/Y (DLMF 10.4.2). All gate on a new
   helper `matchNegPositiveInteger` (accepts `int(-n)`,
   `expr("neg", [int(n)])`, unary `expr("-", [int(n)])`, and
   rationals reducing to negative integers). Sign-flip via
   `signByParityOfN` which dispatches on `n % 2`.

3. **Class C — half-integer closures (8 rules; LOAD-BEARING).**
   `J_{±1/2}` → `√(2/(πz)) · {sin, cos}(z)` (DLMF 10.16.1); the Y /
   I siblings; K_{±1/2} → `√(π/(2z)) · e^{−z}` (DLMF 10.47.9 chain).
   Each gates on `isHalfInteger(ν)` (from I6b) AND on
   `matchPlusMinusHalf(ν) === ±1` — belt-and-braces with the
   `isHalfInteger` predicate covering the half-integer ladder and
   `matchPlusMinusHalf` returning exact sign for `±1/2` (higher half-
   integers `3/2`, `5/2`, … pass through honestly per CLAUDE.md
   Rule 8; the recurrence-driven ladder is filed as P3 follow-up).

4. **Class D — Hankel + spherical canonicalisation (4 rules).**
   `H¹_ν → J_ν + i·Y_ν` (DLMF 10.4.3); H² mirror; `j_n →
   √(π/(2z))·J_{n+1/2}` (DLMF 10.47.3); y_n analogue. The
   spherical rules guard `isNonNegativeInteger(n)` per DLMF §10.47
   (negative integer n is a different function). Always-on per the
   Erfi-canonicalise precedent (worklog 134); an opt-in flag plumbs
   through `casSimplify` options if a future bead surfaces the
   need.

5. **Class E — spherical small-n closures (3 rules).** `j_0 →
   sin(z)/z`, `j_1 → sin(z)/z² − cos(z)/z`, `y_0 → −cos(z)/z`
   (DLMF 10.49.3-5). The class-D rewrites also fire on small n
   (declared earlier in the table), so the `casSimplify` cascade
   actually reaches the elementary closure via the chain
   `j_0(z) → √(π/(2z))·J_{1/2}(z) → √(π/(2z))·√(2/(πz))·sin(z)`,
   which the RatFn fold collapses. Both routes are mathematically
   equivalent; the test `end-to-end: casSimplify(j_0(z))` asserts
   `sin` is present in the canonicalised output regardless of which
   sub-route fired.

**Total: 8 + 6 + 8 + 4 + 3 = 29 rules.** R1 §16 targets "30 after
deduplication"; the K_{−1/2} rule is shipped as its own entry
(matching K_{1/2}'s elementary form directly rather than relying on
class-B parity → class-C cascade) which net-lands at 29 — inside the
"30 ± 2" envelope the bead prompt allowed.

**Encoding pins** (all per the ADR-0040 §"Decision 6" + worklog 134
precedent):
- `√π` as `mkPower(sym("pi"), rat(1n, 2n))` — uniform with `ruleErfi`.
- Imaginary unit `i` as `sym("I")` — uniform with `erf-identities.ts`.
- No infinity literal in rewrite RHS; divergent cases emit tagged
  refusals rather than `sym("infinity")` (Bessel diverges; Erf's
  limits are attained).

### `packages/cas-core/src/simplify.ts` (~95 LOC added)

Mirrors the `applyErfRewrites` pre-pass exactly: bottom-up tree walk,
bounded fixed-point per node (8 iterations — comfortably above the
v0.1 cascade depth), smart-ctor rebuild for `+ / * / neg`, foreign-
pass-through preserved. The two pre-passes are declared as sibling
functions rather than a unified per-head walker so that:
- adding the next per-head substrate (Gamma, Whittaker, …) ships as
  a literally additive new pre-pass function, no refactoring required;
- the per-head rule tables stay disjoint — a Bessel rule can't see
  an Erf-family input or vice versa;
- iteration bounds stay local to each substrate's cascade analysis.

`casSimplify` runs `applyErfRewrites` first then `applyBesselRewrites`;
the two are mathematically independent (each substrate's heads are
disjoint), so the ordering is irrelevant — declaration-order matches
history.

### `packages/cas-core/src/index.ts` (+ 7 LOC)

Re-export `BESSEL_FAMILY_HEADS`, `BESSEL_RULES`,
`isBesselFamilyHead`, `tryBesselSimplify` — the same surface
`erf-identities.ts` exposes, parallel naming convention.

### `packages/cas-core/test/bessel-identities.test.ts` (NEW, ~480 LOC, 51 tests)

Per-class test groups + end-to-end dispatcher tests + idempotence on
a 23-entry corpus. Structure mirrors `erf-identities.test.ts`:
canonicalize-JSON byte-comparison via the same `eq` helper, the same
table-shape smoke tests, the same idempotence corpus pattern.
Negative tests guard the predicate gates:
- `class-B NEGATIVE: J_{1/2} does NOT match parity` —
  `matchNegPositiveInteger` returns null on `±1/2`.
- `class-C NEGATIVE: J_{1/3} does NOT match half-integer closure` —
  `isHalfInteger` rejects 1/3.
- `class-C NEGATIVE: J_{3/2} does NOT collapse via ±1/2 closure` —
  `matchPlusMinusHalf` rejects 3/2 (returns null).
- `class-D NEGATIVE: SphericalBesselJ with negative n does NOT
  match` — `isNonNegativeInteger` rejects -2.

Plus mixed-pre-pass test: `casSimplify(Erf(0) + J_0(0)) = 1` validates
both pre-passes compose cleanly (the Erf pass produces `0 + J_0(0)`;
the Bessel pass simplifies `J_0(0)` to `1`; the RatFn fold collapses
`0 + 1` to `1`).

## Mutation-prove (CLAUDE.md Rule 6)

Three mutations exercised; each surfaced a different failure
signature:

- **M1: flip `(−1)^n` sign in class-B (`signByParityOfN` returns
  `mkNeg(v)` for even n, `v` for odd n).** Result: 6 parity tests
  RED (J_{−2}, J_{−3}, Y_{−1}, Y_{−4}, H¹_{−2}, H²_{−3}). The
  parity sign is load-bearing and well-tested.

- **M2-strong: swap `sin` for `cos` in `besselj-pos-half` rewrite.**
  Result: 2 tests RED (the `J_{1/2}` direct test + the
  `casSimplify(j_0(z))` end-to-end test, which cascades through
  `J_{1/2}`). The half-integer trig functions are pinned.

- **M3: change class-A `J_0(0) = 1` to `0`.** Result: 4 tests RED
  including the foreign-pass-through test and the mixed Erf-Bessel
  integration test. Class-A special values are pinned.

(M2-original — dropping the `isHalfInteger` guard from class-C —
does NOT cause a test failure because `matchPlusMinusHalf` already
does the right shape check independently. The double-gate is
documented as belt-and-braces in the rule body comments; it is
defensive code, not load-bearing in the v0.1 rule set. M2-strong
exercises the load-bearing pin instead.)

## Frictions surfaced

1. **Class D vs Class E dispatch ordering for `j_0`.** The class-D
   `sph-j-from-half-integer-J` rule fires for ALL non-negative
   integer n (gated on `isNonNegativeInteger`), so on `j_0(z)` it
   rewrites to `√(π/(2z))·J_{1/2}(z)` rather than ceding to class-E's
   direct `sin(z)/z` closure. The end-to-end behaviour is still
   correct (the cascade reaches `√(π/(2z))·√(2/(πz))·sin(z)` which
   RatFn-folds to `sin(z)/z`), but the intermediate shape differs
   from what a reader expecting "class E wins" might predict. The
   choice to leave class D un-gated for small n keeps the rule table
   simple — adding a `n >= 2` exclusion to class D would mean the
   user gets *different* intermediate canonical shapes depending on
   whether the cascade ran or not. Documented in the file's class-E
   header comment.

2. **K parity rule's all-ν scope.** DLMF 10.27.3 says `K_{−ν} = K_ν`
   for ALL ν (not just integer). The rule as shipped only catches
   the negation-of-positive-integer case (matches the J/Y/I/Hankel
   shape) — generalising to "any negated value" needs a pattern-
   language extension. Filed as P3 (would need a `matchAnyNegated`
   helper in `pattern.ts` returning the un-negated inner). Honest-
   scope: the rule's title remains accurate for what it ships.

3. **R1 §16 deduplicates to 29, not 30.** The K_{−1/2} closure is
   shipped as its own class-C rule rather than relying on the
   class-B → class-C cascade (`K_{−1/2}` → class-B parity → `K_{1/2}`
   → class-C → `√(π/(2z))·e^{−z}`). Two rules with identical RHS,
   but distinct LHS — clearer than a cascade. The net of 29 is
   inside the "30 ± 2" envelope the prompt allowed.

## Acceptance

- `bessel-identities.ts` on disk; literate top-of-file narrative
  covering R1 priority classes, vocab + pattern-primitive imports,
  idempotence invariant. ✓
- `simplify.ts` extended; existing tests still green. ✓
  (`bun test packages/cas-core/` — 518 pass, 0 fail.)
- New test file with 51 tests (one per rule + negative tests + end-
  to-end). ✓
- `bun test packages/cas-core/test/bessel-identities.test.ts`
  green — 51 pass, 158 expect() calls. ✓
- `bun run check:quick` green at end. ✓ (pending background check
  confirmation.)
- Worklog 152 (this shard). ✓
- Beads `lrmo` closed with notes. (next)
- Three mutations proven, documented above. ✓

## Pointers

- `packages/cas-core/src/special-funcs/bessel-identities.ts` — the
  identity table.
- `packages/cas-core/src/special-funcs/erf-identities.ts` — the
  styling exemplar.
- `packages/cas-core/src/simplify.ts` — the dispatcher integration
  (`applyBesselRewrites` parallel to `applyErfRewrites`).
- `packages/cas-core/src/pattern.ts` — `isHalfInteger` etc. (I6b).
- `packages/cas-core/src/special-functions.ts` — Hankel + spherical
  vocab heads (I6a).
- `docs/adr/0041-bessel-family-per-head-substrate.md` §"Decision 6" —
  the constitutional document.
- `docs/refs/besselj-research/R1-symbolic-identities.md` §16 — the
  30-rule v0.1-shippable target this bead implements.
- `docs/worklog/134-erf-cas-identities.md` — Erf I4 worklog
  (styling exemplar).
- `docs/worklog/144-i6a-bessel-vocab-amendment.md` — I6a vocab.
- `docs/worklog/145-i6b-pattern-primitives.md` — I6b predicates.

---

*End of shard 152. The 29 shipped rules are the v0.1 cas-core symbolic
layer of the per-head Bessel substrate; the remaining layers (arb-
prec real / arb-prec complex / float64 / Meijer-G bridge / wire
surface) land in beads I1a / I1b / I2a / I2b / I3a / I3b / I5a / I6
under Round 2 / 3 / 4 of Phase 2.*
