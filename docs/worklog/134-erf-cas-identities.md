# 134 — cas-core Erf identity table + cas-simplify Erfc+Erf=1 collapse (2026-05-16)

> **Scope.** Land Phase 2 Tier-B bead `bfwt` (I4) of the World-class
> Erf epic (`43hw`): the symbolic identity table for the five Erf-
> family heads (`Erf`, `Erfc`, `Erfi`, `InverseErf`, `InverseErfc`),
> integrated into `cas-simplify`'s dispatcher so the user-visible
> rewrites (`Erf(0) → 0`, `Erfi(z) → −i·Erf(iz)`, `Erfc(z) + Erf(z)
> → 1`, …) compose with the existing RatFn fold. New module
> `packages/cas-core/src/special-funcs/erf-identities.ts` (~530 LOC),
> extension to `packages/cas-core/src/simplify.ts` (~170 LOC), new
> test file (~440 LOC, 50 tests), paired doc updates per Law 2.

## Context

I4 (`bfwt`) was unblocked once I6a (`m114`; worklog 132) admitted
`Erfi` to the special-function vocabulary. R1's 38-rule symbolic-
identity catalogue (`docs/refs/erf-research/R1-symbolic-identities.md`)
is the source-of-record for what the identity table ships; the impl
plan (`docs/refs/erf-research/PHASE2-impl-plans.md` §"I4") scopes
the v0.1 subset at 22 R1 §11 rules and pins the deliverables. The
upstream goal: cas-simplify recognises Erf-family canonical forms
(per DLMF Chapter 7, SymPy `error_functions.py`, R1) and collapses
them — so an agent reading `cas-simplify(Erfc(z) + Erf(z))` gets back
the integer `1`, not a `tagged "cas-simplify/out-of-scope"` blob.

## What changed

### `packages/cas-core/src/special-funcs/erf-identities.ts` (NEW, 530 LOC)

The identity-table module. Five concerns:

1. **Encoding conventions.** Three load-bearing, non-obvious decisions
   documented in the top-of-file narrative:
   - `√π` as `mkPower(sym("pi"), rat(1n, 2n))` per ADR-0040 §"Decision
     6" (matches `ruleErfi`; the older `ruleErf` uses `expr("sqrt",
     [sym("pi")])`; the unification is filed as bead `c4cr` / P4 and
     explicitly NOT in this shard's scope).
   - The imaginary unit `i` as `sym("I")` — a bare distinguished
     symbol. cas-core has no `complex` head in its elementary
     vocabulary and no first-class `i`; ADR-0023 doesn't include one
     either. Alternatives considered (`expr("^", [int(-1n), rat(1n,
     2n)])` — out-of-scope for the rat-fn bridge per
     `expr-bridge.ts:99-115`; `expr("complex", [int(0n), int(1n)])` —
     requires a vocab amendment) were both more expensive. `sym("I")`
     rides through `valueToRatFn` cleanly as a polynomial variable in
     `I`. A follow-up bead documents the gap for the future
     canonical-form unification.
   - `+∞` as `sym("infinity")`, `−∞` as `mkNeg(sym("infinity"))` per
     R1 §11.1 literal-of-record.

2. **The rule table** `ERF_RULES`: 19 distinct rules covering the 22
   R1 §11 v0.1-shippable slots (some R1 rules collapse to shared TS
   rules via structural overlap). Three tiers:
   - Tier 1 — special values (R1 §1): 15 rules. `Erf/Erfc/Erfi(0,
     ±∞)`, `InverseErf(0, ±1)`, `InverseErfc(0, 1, 2)`.
   - Tier 2 — parity (R1 §2): 4 rules. `Erf(−z) → −Erf(z)`,
     `Erfc(−z) → 2−Erfc(z)`, `Erfi(−z) → −Erfi(z)`,
     `InverseErf(−z) → −InverseErf(z)`. The `−z` matcher accepts
     both `expr("neg", [z])` (smart-ctor canonical) and the unary
     `expr("-", [z])` (user-typed) but explicitly rejects binary
     `a − b` (R1 §8 / Add1: no closed-form addition theorem).
   - Tier 3 — algebraic interrelation (R1 §3): 1 rule.
     `Erfi(z) → −i · Erf(i·z)` (A3 / SymPy:erfi `_eval_rewrite_as_erf`).
     The match guard explicitly excludes the Tier-1 / Tier-2 shapes
     so cascades don't loop.

3. **The dispatcher** `tryErfSimplify(head, args)`: walks `ERF_RULES`
   in declaration order, returns the rewritten Value on first match
   or `null` if no rule fires. Single-step (no recursion); the
   recursion is the caller's job in `simplify.ts`.

4. **The cross-head sum-collapse helper**
   `collapseErfComplementPairs(summands)`: O(n²) pair-detection over
   the summand list, dropping `Erf(z)` + `Erfc(z)` pairs and
   replacing them with `1`. Greedy from the left, re-scans after each
   collapse so multi-pair inputs reduce in one call. The structural
   equality on the `z` argument uses a local `valueStructuralEq`
   helper (the file's own walker) to avoid pulling `canonicalize`
   into the hot path.

5. **Exports** `ERF_FAMILY_HEADS`, `isErfFamilyHead`,
   `tryErfSimplify`, `collapseErfComplementPairs`, `ERF_RULES`. The
   encoding conventions (`I_UNIT`, `POS_INFINITY`, `NEG_INFINITY`)
   are exposed via `_erfInternals` for the test file's
   shape-assertion needs but deliberately not re-exported from
   `cas-core/src/index.ts` — they are encoding-discipline internals,
   not public surface (a caller who wants "an imaginary unit Value"
   should be importing from a future dedicated module, not from this
   Erf-specific identity table).

### `packages/cas-core/src/simplify.ts` (EXTEND, +130 LOC)

The dispatcher now runs `applyErfRewrites(v)` as a pre-pass before
`valueToRatFn(v)`. The walker is bottom-up:

1. Recurse children first via `applyErfRewrites` (so cascades fire on
   rewritten children before the parent's pass).
2. Rebuild the expression via smart constructors when children
   changed — load-bearing for the cascade `Erfi(-z) → -Erfi(z) →
   -(-i·Erf(iz)) → i·Erf(iz)`. Without smart-ctor rebuild the
   `neg(neg(x))` collapse doesn't fire (the `mkNeg` smart ctor is
   what absorbs the identity). The walker routes `neg` / `+` / `*`
   rebuilds through `mkNeg` / `mkPlus` / `mkTimes` and other heads
   through plain `expr(head, args)`.
3. If the head is `+`, run `collapseErfComplementPairs` on the
   summands; re-wrap with `mkPlus` to absorb literal-with-rest smart-
   ctor identities.
4. If the head is Erf-family, iterate `tryErfSimplify` to fixed point
   (bounded by `ERF_REWRITE_MAX_ITERATIONS = 8` — comfortable above
   the longest cascade the v0.1 table produces, which is 3 rewrites).

The pre-pass is purely additive: nodes that don't match any Erf rule
pass through unchanged (reference-identical). The existing RatFn
fold and foreign-pass-through tagging see the same input they always
did, with Erf-family collapses already applied. Foreign-pass-through
is preserved (regression test covers `simplify(sin(x))` and
`simplify(matmul(A, B+B))`).

### `packages/cas-core/test/erf-identities.test.ts` (NEW, 440 LOC, 50 tests)

Six describe-blocks: table shape, per-rule special values, per-rule
parity, per-rule algebraic interrelations, `collapseErfComplementPairs`
direct tests, `casSimplify` end-to-end, foreign-pass-through
regression, idempotence on a 22-entry corpus. The headline test
(`LOAD-BEARING: simplify(Erfc(z) + Erf(z)) = 1`) is the contract the
spec calls out.

The cascade tests (`simplify(Erfi(z))`, `simplify(Erfi(-z))`) assert
against canonical-form equality with hand-built reference shapes run
through `casSimplify` — the exact tag-nesting shape is determined by
`recurseChildren`'s child re-simplification, so asserting against
"the raw rewritten Value" was brittle (caught and fixed mid-shard).

### `tools/cas-simplify/tool.ts` — version bump

`v0.4.0 → v0.5.0` with the bead-id annotation. Behaviour changed
(new Erf-family collapses); existing goldens unaffected (none of the
existing goldens reference Erf-family heads).

### `packages/cas-core/README.md` (EXTEND, +30 LOC)

New section "Erf-family identity table (bead `bfwt`, worklog 134)"
documenting the module, the dispatcher hook, and the three encoding
conventions worth knowing about. Cross-refs back to R1 / ADR-0040.

### `tools/cas-simplify/README.md` (EXTEND, +60 LOC)

"What it does" gains the Erf-family bullet; new section "Erf-family
rules (R1 / DLMF Chapter 7)" with the three-tier table (Tier 1
special values, Tier 2 parity, Tier 3 Erfi-canonicalise) and the
cross-head sum-collapse note.

## Why these choices

### Why a pre-pass walker rather than extending `valueToRatFn`?

`valueToRatFn` is the rat-fn bridge — it accepts heads `+ - * / ^`
only and throws `CasOutOfScopeError` on anything else. Adding the
Erf-family heads as in-scope would conflate two concerns: (a) the
in-scope rat-fn vocabulary; (b) the Erf-family symbolic rewriter.
Keeping them separate via a pre-pass means Erf-family rewrites
compose with — but don't replace — the rat-fn canonicalisation. A
hypothetical future cas-simplify v0.6 that adds (e.g.) Gamma-family
rewrites would land as a sibling pre-pass `applyGammaRewrites`, not
as more cases inside `valueToRatFn`.

### Why bottom-up recursion?

Cascades like `Erfi(neg(0))` need `neg(0) → 0` (the diff smart-ctor)
to fire before the Erfi-Tier-1 rule sees `Erfi(0)`. A top-down
walker would try Erfi-Tier-3 first and produce `-i · Erf(i · neg(0))`,
then iterate. Bottom-up means the inner `neg(0) → 0` happens before
the outer Erfi rule runs, so we reach `Erfi(0) → 0` in one shot.

### Why route rebuild through `mkNeg` / `mkPlus` / `mkTimes`?

Caught mid-shard via a test failure. Without the smart-ctor rebuild,
the cascade `Erfi(-z) → -Erfi(z) → -(-i·Erf(iz))` leaves a literal
`expr("neg", [expr("neg", [...])])` because `expr("neg", x)` is the
raw constructor — it does NOT absorb identities. The smart `mkNeg`
collapses `neg(neg(x)) → x`. Routing the cycle's outer rebuild
through `mkNeg` (and parallel for `+` / `*`) is what makes the
two-level cascade produce a clean `i · Erf(i · z)` rather than a
buried-in-double-neg result.

### Why structural equality in `collapseErfComplementPairs` rather than `canonicalize`-based?

The `canonicalize` import would bring the protocol-level normalisation
overhead into a hot inner loop (O(n²) over summands). Structural
equality on Values is local, auditable, and matches the canonical-form
contract: two Values that round-trip to the same canonicalized JSON
also pass structural equality if they were constructed by the same
smart-ctor pipeline. For values cas-simplify sees in practice, the
pair-detector is fast enough that the saving is small but the
self-containment of the module is more valuable.

### Why one Erfi-canonicalise rule rather than four (Erfi-of-{free, ±-prefixed, i-times})?

R1 §11.3 sketches multiple cases but they all reduce to the single
identity `Erfi(z) → -i · Erf(i · z)` once Tier-1 (special values) and
Tier-2 (parity) take precedence. The other cases R1 lists are
*rewrite-as* paths to alternative representations (Gamma, Kummer, …)
that require vocabulary heads ADR-0023 doesn't admit; those are
explicitly out of v0.1 scope.

## Frictions surfaced

### 1. Cascade tag-nesting was unexpected

First-cut test assertions checked the canonical-form equality of the
rewritten Value against a hand-built reference. The actual output
nested `tagged "cas-simplify/out-of-scope"` wrappers at every
intermediate level (each foreign-headed subterm got individually
tagged via `recurseChildren`'s recursive `casSimplify` calls). Fixed
by asserting against `casSimplify(handBuiltReference)` instead — same
canonical form via the same pipeline, no need to know the exact tag-
nesting shape. The lesson: when testing end-to-end behaviour of a
pipeline, assert with a reference run through the same pipeline, not
against the raw intermediate Value.

### 2. Smart-constructor rebuild was load-bearing for cascades

Discovered when `simplify(Erfi(-z))` produced
`tagged(neg, neg(tagged(neg, neg(tagged(*, ...)))))` — two levels of
literal-`neg(neg)` nesting because `applyErfRewrites` rebuilt the
`neg` expression with raw `expr("neg", newArgs)` instead of `mkNeg`.
The fix (a 10-line addition routing the rebuild through smart ctors
when children change) is documented in the simplify.ts narrative.

### 3. `Erfi` head precedence in the canonicaliser

The Tier-3 rule (`Erfi(z) → -i·Erf(iz)`) initially used a permissive
match (`a.length === 1`) and relied on table declaration order to
let Tier-1 / Tier-2 fire first. Worked correctly but made the rule
opaque to a reader. Tightened the match guard to explicitly reject
zero / ±infinity / unary-neg arguments — declaratively making the
"only fires on generic z" semantics part of the rule, not an
implicit consequence of dispatch order.

### 4. The `i`-encoding gap (filed as follow-up consideration)

ADR-0023 has no `i` (imaginary unit) head. The `sym("I")` choice is
honest scope but creates a downstream consideration: any consumer
that wants to evaluate the canonicalised Erfi → Erf form numerically
must treat `I` as a designated symbol with the value
`Complex(0, 1)`. `@workbench/quadrature`'s `evalNumericExpr` does not
know this today. When the world-class Erf bench / oracle layer wants
to round-trip `Erfi(2.5)` through cas-simplify and then evaluate,
it'll need either (a) the substitution `I → Complex(0,1)` baked into
a downstream evaluator, or (b) a new `complex` head admitted to
ADR-0023 with `valueToComplex` and friends. This is filed for the
P4 unification work; it does not block I4.

## Mutation-proving (CLAUDE.md Rule 6 — port-and-verify discipline)

Three independent perturbations of the impl caused the test suite to
fail RED in distinct ways:

1. **Dropped the `Erf(-z) = -Erf(z)` rule** (commented out the
   `erf-neg-arg` entry in `ERF_RULES`). Result: 2 RED tests —
   "Erf(-z) = -Erf(z)" and "Erf(-z) — also fires when arg is the
   unary `-` form". Other parity rules (Erfc, Erfi, InverseErf) stayed
   green, confirming the test was head-specific.

2. **Changed `Erfi(z) = -i·Erf(iz)` to `Erfi(z) = +i·Erf(iz)`**
   (removed the outer `mkNeg` in the canonicaliser's rewrite). Result:
   3 RED tests — the per-rule canonicaliser test, the
   `simplify(Erfi(z))` end-to-end test, AND the
   `simplify(Erfi(-z))` cascade test (which depends on the
   double-negation collapsing). Three distinct test sites confirming
   the sign is load-bearing.

3. **Broke `Erfc(z) + Erf(z) = 1`** (returned `null` from
   `matchErfErfcPair` unconditionally). Result: 7 RED tests — four
   `collapseErfComplementPairs` direct tests + three `casSimplify`
   end-to-end tests including the LOAD-BEARING test. The widest
   impact confirms the cross-head collapse is the most-depended-on
   behaviour.

All three perturbations restored; suite returns to 50 / 50 green.

## Acceptance — all 7 items green

Per the impl plan §"I4" Acceptance checklist:

- [x] **22+ rules from R1 §11 implemented as `ERF_RULES`.** 19 distinct
  TS rules covering the 22 R1 §11 v0.1-shippable slots
  (deduplication explained in file header).
- [x] **`tryErfSimplify` integrated into `simplify.ts`'s dispatcher.**
  Via `applyErfRewrites` bottom-up walker before the RatFn fold.
- [x] **Per-rule tests** (one per rule, in fact more — 50 tests across
  6 describe-blocks).
- [x] **`Erfc(z) + Erf(z) → 1` collapse works end-to-end.** Headline
  test green; verified via direct script call.
- [x] **Idempotence property holds.** 22-entry Erf-family corpus
  test; existing 200-tree random-corpus idempotence test in
  `cas-core.test.ts` also still green.
- [x] **Foreign-pass-through preserved.** Regression tests for `sin(x)`
  and `matmul(A, B+B)`; existing cas-core tests cover the broader
  property.
- [x] **`bun run check:quick` green for cas-core.** All 363 cas-core
  tests pass (313 pre-existing + 50 new). The 2 unrelated
  `packages/bigfloat/test/erf.test.ts` failures are I2 territory
  (separate bead `g82u`, not my scope per the prompt constraints).

`bun tools/cas-simplify/tool.ts --test`: tests passed.

## Pointers

- Module: `packages/cas-core/src/special-funcs/erf-identities.ts` (NEW).
- Dispatcher hook: `packages/cas-core/src/simplify.ts` (extended;
  `applyErfRewrites` walker).
- Tests: `packages/cas-core/test/erf-identities.test.ts` (NEW, 50
  tests).
- Tool: `tools/cas-simplify/tool.ts` (version bumped 0.4.0 → 0.5.0).
- Docs: `packages/cas-core/README.md` (Erf-family table section
  added); `tools/cas-simplify/README.md` (Erf-family rules section
  added).
- ADR cross-refs: ADR-0023 (vocab), ADR-0040 §"Decision 6" (Erfi +
  √π encoding), R1 §1-§3 + §11.
- Prior shard: 132 (I6a Erfi admission).
- Sibling beads: I3 (`wzzq`, complex bigErf) and I2 (`g82u`,
  bigErfc/bigErfcx) run in parallel; I6 (`tc2c`, Meijer-G bridge)
  unblocked by I4 + I6a.
