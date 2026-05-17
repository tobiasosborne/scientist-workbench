# 145 — cas-core pattern primitives: `isPositiveInteger`, `isNonNegativeInteger`, `isHalfInteger` (2026-05-17)

> **Scope.** Land Phase 2 Round 1 bead `7j02` (I6b) of the World-class
> Bessel epic (`zcam`): create `packages/cas-core/src/pattern.ts` with
> three pure pattern-condition predicates over the cas-core `Value` AST.
> R1 Discovery B (`docs/refs/besselj-research/R1-symbolic-identities.md`
> §14) surfaced these as load-bearing for the half-integer-closure rule
> family (R1 §16 priority-class C, 8 rules) and the spherical-Bessel
> non-negative-integer constraint (DLMF §10.47); ADR-0041 §"Decision 6"
> pinned them as a separate concern from the I6a vocabulary amendment
> (`vsvl`) and the I4 rule table (`lrmo`) that consumes them. I6b ships
> independently and unblocks both.

## Context

The I4 Bessel identity rules (bead `lrmo`) implement ~30 rules from
R1 §16; eight of them (priority-class C, the half-integer closures
`J_{1/2}(z) = √(2/(πz))·sin(z)` and seven Y/I/K siblings) gate the
rewrite on `isHalfInteger(ν)`. Three further classes need
`isPositiveInteger` (e.g. `J_n(0) = 0` for `n ∈ ℤ_{>0}` per DLMF
§10.2.4) and `isNonNegativeInteger` (the spherical-Bessel order
constraint per DLMF §10.47.3).

R1 §14 audited the existing cas-core pattern language and found no
such primitives. `diff.ts` ships `isZero` and `isOne` for
smart-constructor short-circuiting (`mkPlus([ZERO, x]) → x`) — a
different concern from rule-guard shape classification.
`special-funcs/erf-identities.ts` ships `isIntegerEq(v, n)`,
`isZeroLiteral`, `isPosInfinity`, etc. as bespoke per-head
predicates. Generalising those to a top-level shared module is a
separate refactor (R1 §14.2); I6b ships only the three new
predicates the Bessel rule set demands, on the smallest scope
compatible with that goal.

## What changed

### `packages/cas-core/src/pattern.ts` (NEW, 365 LOC; ~210 lines literate prose + 60 lines implementation)

A new top-level module under `packages/cas-core/src/`, sibling to
`diff.ts` / `simplify.ts` / `special-functions.ts`. Three public
exports:

```ts
export function isPositiveInteger(v: Value): boolean;
export function isNonNegativeInteger(v: Value): boolean;
export function isHalfInteger(v: Value): boolean;
```

Each is a total function (no throws on well-formed Values, no
`undefined`, no `null` returns). Each accepts both the `integer` and
`rational` Value kinds; non-numeric kinds (`symbol`, `string`,
`expression`, `list`, `record`, `tagged`, `boolean`, `float64`)
return `false`.

Internal helpers (not exported, package-private):
- `bigintOfIntegerValueField(s)` — `BigInt(s)` wrapper with a literate
  comment documenting why we do NOT catch malformed-integer-string
  exceptions (CLAUDE.md Rule 1: crash with context beats silent
  misclassification).
- `reduceFraction(num, den) → [num', den']` — Euclidean GCD reduction
  preserving the sign on the numerator. Precondition: `den > 0n`.
- `normalizeRational(v) → [num, den] | null` — sign-normalises
  (positive denominator) then reduces. Returns `null` on `den = 0n`
  so the public predicates classify degenerate rationals as
  "not an integer / not a half-integer" without throwing.

`float64` is intentionally NOT classified. A user passing
`float64FromNumber(0.5)` has volunteered into the floating-point
world; the symbolic substrate must not silently re-interpret it as
the exact rational `1/2`. The `quadrature` substrate handles float64
inputs; cas-core's symbolic substrate does not. This boundary is
documented in the file-header literate prose under "Domain coverage".

### `packages/cas-core/src/index.ts` (+5 LOC)

Three exports added under a new `export { ... } from "./pattern.js"`
block, placed after the `special-functions.js` exports.

### `packages/cas-core/test/pattern.test.ts` (NEW, 88 tests, 147 assertions)

Four `describe` blocks:

- **isPositiveInteger** — 27 tests covering small positives, large
  BigInt-sized positives (10^40 + 1), zero (rejected: `≥ 1` boundary),
  negatives, rationals reducing to positive integers (`rat(6,3)`) and
  negative integers (`rat(-6,3)`), non-integer rationals (`rat(3,2)`),
  raw non-canonical rationals (`{num:"4", den:"2"}`), raw
  negative-denominator (`-6/-3 = 2`), degenerate zero-denominator,
  and the 11 non-numeric Value kinds.
- **isNonNegativeInteger** — 25 tests, structurally parallel, with
  the boundary at `≥ 0`. Zero passes.
- **isHalfInteger** — 31 tests covering canonical half-integers
  (`1/2`, `-1/2`, `7/2`, large odd-num cases), the integer-disguised-
  as-rational trap (`rat(4,2)` and raw `{num:"4", den:"2"}` BOTH
  reduce to `2`, both classified `false`), the
  non-canonical-reduces-to-half-integer case (`{num:"6", den:"4"} →
  3/2 → true`), raw-negative-denominator sign normalisation
  (`-1/-2 → 1/2 → true`), `1/-2 → -1/2 → true`, degenerate
  zero-denominator (false, not throw), `0/2` (= 0, integer, false),
  bare integers (false), and the 11 non-numeric kinds.
- **cross-predicate invariants** — five invariants over a 15-element
  representative corpus: `isPositiveInteger ⟹ isNonNegativeInteger`;
  `isPositiveInteger ⟹ ¬isHalfInteger`;
  `isNonNegativeInteger ⟹ ¬isHalfInteger`; `isHalfInteger ⟹
  ¬(isPositiveInteger ∨ isNonNegativeInteger)`; every predicate
  returns a strict boolean (not `undefined`, not throw).

## Why these choices

### Why a new top-level `pattern.ts`, not `special-funcs/predicates.ts`

R1 §14.5 originally recommended landing in
`packages/cas-core/src/special-funcs/predicates.ts`. ADR-0041
§Decision 6 instead pinned `packages/cas-core/src/pattern.ts`. I
chose the ADR location for three reasons:

1. **Pattern primitives are cas-core-wide, not per-head.** A predicate
   like `isHalfInteger` is *equally* applicable to a future
   Whittaker-family rule (Whittaker M takes half-integer first
   parameter; DLMF §13.18.7), a Legendre P_n rule (`n ∈ ℤ_{≥0}` for
   the polynomial case), or a Lerch Φ identity. Locking the helper
   inside `special-funcs/` would force every other head's rule table
   to import across a "private" boundary or duplicate the predicate.
2. **Future expansion.** When subsequent heads' research surfaces a
   fourth needed shape (R1 §14.2 already names
   `isIntegerLiteralCondition`, `isSpecificHalfInteger`,
   `isNegationOf`), they join `pattern.ts` as named predicates with
   one-line public exports. A `special-funcs/predicates.ts` would
   ship the same surface with no advantage and worse discoverability.
3. **The ADR is authoritative.** Per CLAUDE.md Law 1 ("Ground truth
   before code"), when ADR-0041 §Decision 6 explicitly names
   `pattern.ts`, that's the binding decision; R1's older proposal
   was research input that the ADR consumed and revised.

### Why three named predicates, not one parametric helper

R1 §14.2 noted that the three (plus the existing per-head
`isIntegerEq`) could all collapse to a single
`isIntegerLiteralCondition(v, (n: bigint) => boolean)`. Declined for
v0.1:

1. **Honest scope** (CLAUDE.md Rule 8). The three concrete shapes are
   the *only* shapes any current rule needs. Generalising "in case"
   violates the rule.
2. **Readability at the rule-table callsite.** Rule guards read as
   English with named predicates (`isHalfInteger(args[0])`); they
   read as Lisp with one parametric
   (`isIntegerLiteralCondition(args[0], (n) => n >= 0n)`). The named
   form *is* the documentation.
3. **Cheap to refactor later.** The generalisation can land
   drop-in-compatible when ≥ 5 callsites would simplify by collapsing.
   Today there are 0 callsites (I4 hasn't shipped yet); the threshold
   is far off.

### Why BigInt arithmetic throughout (not JavaScript `Number`)

Numerators and denominators inside `RationalValue` are arbitrary-size
by protocol (stored as decimal `string`). A user constructing
`rat(BigInt("10000000000000000000000000001"), 2n)` expects
`isHalfInteger` to classify correctly; converting to JS `Number` for
the parity check would silently lose precision above
`Number.MAX_SAFE_INTEGER` (≈ 9·10¹⁵) and misclassify. All arithmetic
stays in BigInt space. Cost is negligible because predicates run
inside rule-table `match` closures (called once per rewrite dispatch),
not in inner loops.

### Why reduce raw rationals internally instead of trusting canonical form

The protocol validator enforces `RationalValue` canonical form
(`den > 0`, in lowest terms, gcd = 1). Validated Values arriving
from the wire are reduced. But raw-literal Values (constructed in
tests, in golden-file fixtures, or via JSON-bridge inputs that
bypass the `rat()` factory) may not be reduced. The predicate's
contract is *mathematical* — "does this Value, after reduction,
satisfy the condition?" — not byte-literal. So:

- `{kind:"rational", num:"4", den:"2"}` reduces to `2/1` →
  classified as an integer by `isNonNegativeInteger`, NOT as a
  half-integer.
- `{kind:"rational", num:"6", den:"4"}` reduces to `3/2` →
  classified as a half-integer.
- `{kind:"rational", num:"-1", den:"-2"}` sign-normalises to `1/2` →
  half-integer.

The `normalizeRational` helper handles both reductions inline. This
gives the predicate a single mathematical contract across both
canonical and non-canonical input shapes.

### Why total-function contract (return `false` instead of throwing)

CLAUDE.md Rule 1 says "Fail fast, fail loud." But the predicate's
*job* is to classify Value shapes, not to validate them. A
non-numeric Value passed to `isHalfInteger` isn't a bug — it's the
rule-table dispatcher correctly trying every predicate to see which
fires. Throwing on every non-numeric input would force every callsite
into a `try/catch` shell or a redundant pre-guard, defeating the
predicate's purpose. Total-function contract is "classify well-formed
Values, return `false` on non-matching shapes" — the dispatcher then
moves to the next candidate rule.

## Frictions surfaced

### Worklog file pre-existed

`docs/worklog/145-i6b-pattern-primitives.md` was pre-staged by the
orchestrator with a placeholder body that under-counted the test
panel (58 vs the actual 88) and named me as a hypothetical post-hoc
synthesis. I overwrote with the actual landed work. Friction lesson:
pre-staged shards are templates, not contracts — verify against the
landed code before signing.

### `pattern.ts` did not exist; ADR-0041 says it should

The ADR cited `packages/cas-core/src/pattern.ts` as the landing site
but no such file existed. The bd issue body says "(or equivalent)"
which is permissive but ambiguous. The ADR is authoritative (Law 1)
so I created the file at the ADR's named location. This is the right
choice for future heads, not just Bessel.

### Float64 is OUT of scope

It would be ergonomically tempting to handle `float64FromNumber(0.5)
→ isHalfInteger` for "what the user obviously meant." Declined: the
symbolic substrate must not silently re-interpret a floating-point
input as an exact rational. If a downstream rule needs that, it
should explicitly chain through a `float64ToExactRationalIfClose(v)`
helper (which *doesn't exist yet*); the predicate's domain is the
exact-arithmetic part of the AST.

### Canonical-vs-raw rational handling adds GCD on every call

The protocol validator enforces canonical form on the wire; the
predicate ships internal reduction anyway. This is double work in
the happy case (validated input is already reduced; the reducer is a
no-op). Cost: one Euclidean GCD per call, O(log min(|num|, den)).
Acceptable trade for robustness against raw-literal inputs (which DO
arise in tests and JSON-bridge inputs).

## Mutation-proving

The bd brief required three explicit perturbations, each with at
least one pinned test. All three verified by toggle / run / restore
on `bun test packages/cas-core/test/pattern.test.ts`:

- **M1** — Flip `>=` to `>` in `isNonNegativeInteger`. Pinned test:
  `int(0n) → true (zero IS non-negative — pins M1)`. Confirmed RED
  along with `rat(0n, 5n) → true` and raw `0/7 → true` (3 tests
  flip). Restored.
- **M2** — Drop the `den !== 2n` guard in `isHalfInteger`. Pinned
  test: `rat(5/3) → false (denominator 3, not 2 — pins M2)`.
  Confirmed RED along with `rat(1/4) → false` (2 tests flip).
  Restored.
- **M3** — Replace `> 0n` with `!== 0n` in `isPositiveInteger`.
  Pinned test: `int(-1n) → false (negative is not positive — pins
  M3)`. Confirmed RED along with `rat(-6/3) → false`, raw
  negative-denominator `-6/-3` and the cross-predicate invariant
  `isPositiveInteger ⟹ isNonNegativeInteger` (4 tests flip).
  Restored.

Each mutation: confirmed RED, restored to green. Final state: 88/88
green.

## Acceptance

- `bun test packages/cas-core/test/pattern.test.ts` — **88/88 green,
  147 expect() calls.**
- `bun test packages/cas-core` — **467/467 green** (0 regressions
  across 11 pre-existing cas-core test files).
- `bun run typecheck` (`tsc --noEmit`) — clean, exit 0.
- `bun run check:quick` — green on convention / codegen / typecheck /
  test phases.
- Mutation-prove panel verified end-to-end (M1, M2, M3).
- Three predicates exported from `@workbench/cas-core` public surface
  via `index.ts`.

## Pointers

- `packages/cas-core/src/pattern.ts:1-300` — the new module.
- `packages/cas-core/src/index.ts:152-156` — public re-exports.
- `packages/cas-core/test/pattern.test.ts:1-400` — the test panel.
- `docs/adr/0041-bessel-family-per-head-substrate.md:376-413` —
  §Decision 6, the architectural pin.
- `docs/refs/besselj-research/R1-symbolic-identities.md:887-986` —
  §14 Discovery B, the literature justification + downstream-rule
  inventory.
- `packages/cas-core/src/special-funcs/erf-identities.ts:188-252` —
  the per-head pattern-predicate style this module generalises. R1
  §14.2 refactor opportunity: promote `isZeroLiteral`,
  `isPosInfinity`, `isNegInfinity`, `matchNegFree`, `isIntegerEq`
  into `pattern.ts` too. Filed as future P3 work.
- Downstream consumer: bead `lrmo` (I4) — cas-core Bessel identity
  rules. The 8 half-integer-closure rules import `isHalfInteger`
  one-line dependency.
