# 132 — cas-core vocabulary amendment: admit `Erfi` (2026-05-16)

> **Scope.** Land Phase 2 Tier-A bead `m114` (I6a) of the World-class
> Erf epic (`43hw`): extend `packages/cas-core/src/special-functions.ts`
> with `Erfi` as a first-class head — vocabulary entry + arity contract
> + closed-form diff rule `d/dz erfi(z) = (2/√π)·exp(z²)` (DLMF §7.10.2).
> Amend ADR-0023 with a one-paragraph note recording the 27 → 28 table
> growth. Ship paired doc updates per Law 2 (`packages/cas-core/README.md`
> created from scratch; `tools/cas-diff/README.md` differentiable-heads
> table extended). The smallest Tier-A bead in Phase 2; unblocks I4
> (`bfwt` — cas-core Erf identity table) and I6 (`tc2c` — Meijer-G
> bridge) which both need `Erfi` as an admitted head.

## Context

ADR-0040 (worklog 0 of the world-class-Erf epic; bead `ss5o`) pinned
the per-head special-function substrate using Erf as the v0.1
instantiation. Phase 0 research (`docs/refs/erf-research/R1`-`R5`)
surfaced one vocabulary gap: R4's canonical Meijer-G forward table
treats `Erf` / `Erfc` / `Erfi` symmetrically (all three share parameter
tuple `an=[1/2], ap=[], bm=[0], bq=[-1/2]`; only the z-argument sign
distinguishes them), but the existing `SPECIAL_FUNCTION_HEADS` table at
`packages/cas-core/src/special-functions.ts:105` admits `Erf` and
`Erfc` only. `Erfi` was missing — bead `m114` (I6a) was filed to close
the gap as a standalone Tier-A deliverable.

## What changed

### `packages/cas-core/src/special-functions.ts` (+~30 LOC)

- `"Erfi"` appended to `SPECIAL_FUNCTION_HEADS` (line ~123) — placed
  between `Erfc` and `ExpIntegralEi` in the "Error / exponential /
  Fresnel integrals" group, the natural sibling slot.
- `"Erfi"` appended to `SPECIAL_FUNCTION_DIFFERENTIABLE_HEADS` — joins
  `Erf` and `Erfc` in the v0.1 differentiable subset.
- `Erfi: { shape: "fixed", count: 1 }` added to `ARITY_TABLE`.
- `case "Erfi"` added to `differentiateSpecialFunction`'s dispatch
  switch.
- New `ruleErfi(args, wrt, recurDiff)` body emitting
  `(2/√π) · exp(z²) · dz` per DLMF §7.10.2. Structurally mirrors
  `ruleErf` (uses `recurDiff(z, wrt)` for the chain-rule factor,
  short-circuits on `isZero(dz)`) so chain-rule cases (`d/dz erfi(2z)`)
  work the same way they do for `erf`.

### Encoding choice for `√π` (non-obvious; preserved verbatim per impl plan)

The existing `ruleErf` encodes `√π` as `expr("sqrt", [sym("pi")])`.
The new `ruleErfi` encodes it as `expr("^", [sym("pi"), rat(1n, 2n)])`
(i.e. `mkPower(sym("pi"), rat(1n, 2n))`), per ADR-0040 §"Decision 6"'s
literal-of-record code. The two encodings are canonically distinct AST
shapes but both lie inside the closed elementary vocabulary and are
both recursively differentiable; ADR-0040 picked the rational-exponent
form so the downstream Meijer-G bridge (R4 §1; bead `tc2c`) sees a
single uniform `z/√π` prefactor shape across all three Erf-family
G-forms. A literate prose comment at the top of `ruleErfi`'s body
documents the choice.

### `packages/cas-core/test/special-functions.test.ts` (+~60 LOC)

- Existing "contains exactly the 27 heads" test → "28 heads (Erfi
  added 2026-05-16 per ADR-0040)"; expected array extended; expected
  length assertion bumped to 28.
- Existing "differentiable subset matches" test extended with `Erfi`.
- Single-z arity test extended with `Erfi`.
- New `describe("differentiate — Erfi (DLMF §7.10.2)")` block with
  five tests:
  - `specialFunctionArity Erfi → fixed count 1`
  - `d/dz erfi(z) = (2/√π) · exp(z²)` — byte-identical canonical-form
    comparison against the hand-built expected AST
  - `d/dy erfi(x) = 0` — free-symbol independence
  - chain rule: `d/dz erfi(2z) = ((2/√π) · exp((2z)²)) · 2`
  - foreign pass-through: `InverseErf` (deliberately deferred per
    ADR-0040 §"What we will not decide here") still refuses with
    `CasDiffOutOfScopeError`
  - determinism: hash-equal across two calls

### `docs/adr/0023-cas-core-special-function-vocabulary.md`

One-paragraph `### Amendment — 2026-05-16 (ADR-0040 §"Decision 6";
bead m114)` inserted after the §"Decision" block, before §"What we
will not decide here". Records the 27 → 28 table growth, cites the
DLMF §7.10 / §7.10.2 sources, names the discovery context (R4 Meijer-G
bridge), explains why this is an amendment rather than a fresh ADR
(per ADR-0040 §"Why ADR-0023 amends rather than a new vocabulary
ADR" — single head, single rule, single G-form, no design
controversy).

### `packages/cas-core/README.md` (created)

The package had no README; one is added now per Law 2 (the bead's doc
deliverables required updating it). Lists the 28 heads grouped by
family (Gamma / Bessel / pFq / Whittaker-PCD / Erf-Exp-Fresnel /
Legendre / orthogonal-polynomial / Polylog-Lerch / MeijerG), names the
16-of-28 differentiable subset, points at `tools/cas-diff/README.md`
for the DLMF-cited rule table, and at ADR-0008 / -0009 / -0023 / -0025
/ -0040 for design context.

### `tools/cas-diff/README.md`

- Top prose paragraph: `Erfi` added to the list of admitted special-
  function heads.
- Rule table: new row `Erfi(z)` → `(2/√π) · exp(z²) · dz` (DLMF §7.10.2;
  cites the 2026-05-16 admission and ADR-0040).

## Why these choices

### Why follow the impl plan's literal `mkPower(pi, 1/2)` rather than the existing `sqrt(pi)` pattern?

The impl plan's literal-of-record TS code uses `mkPower(sym("pi"),
rat(1n, 2n))` and the matching test expects that canonical form. Per
CLAUDE.md Rule 3 (skepticism — follow the source of truth) and the
prompt's explicit "literal of record" framing, the impl plan wins.
ADR-0040 §"Decision 6" pinned this encoding so the downstream Meijer-G
bridge sees a uniform prefactor shape. The mismatch with the existing
`ruleErf` shape is recorded in a literate comment at the top of
`ruleErfi`; an "Erf-family canonical-form unification" cleanup is a
candidate follow-up bead but is *not* in scope for I6a (additive-only
constraint).

### Why a 5-test Erfi block rather than minimal coverage?

The impl plan specifies 4 tests (arity, diff rule, foreign pass-
through, zero-on-different-variable). The chain-rule test (`erfi(2z)`)
is an additional invariant the existing `ruleErf` block already covers;
adding the parallel test for `ruleErfi` would catch a future
regression where someone removes the `recurDiff` call (the
mutation-prove smoke). The determinism test mirrors the existing per-
family pattern at the bottom of the file. Both additions are pure
upside.

### Why create `packages/cas-core/README.md` from scratch?

The package had none; the impl plan deliverables list said to "update"
it; per Law 2 ("Code shipped with stale docs is incomplete work") the
deliverable is to ship a README that includes the vocab list this bead
just changed. Modelling on `packages/bigfloat/README.md`'s shape kept
the new file consistent with the existing package-README convention
(intro paragraph; determinism contract; public surface; cross-refs).

## Frictions surfaced

1. **The impl plan's literal code uses `matchesSym(z, wrt)`** — a
   function that doesn't exist in the codebase. The existing
   diff-rule pattern in `special-functions.ts` uses
   `recurDiff(z, wrt)` and short-circuits on `isZero(dz)`; the
   `recurDiff` pattern also gives correct chain-rule semantics for
   inputs like `erfi(2z)`. I used `recurDiff`. The impl plan's
   pseudocode was illustrative; the actual codebase pattern is
   load-bearing.

2. **The impl plan's "Files" table and "Acceptance" checklist
   disagree** on whether the main `README.md` catalog row needs
   updating. The prompt's explicit constraint ("DO NOT modify
   anything outside the file paths listed in the impl plan §I6a
   Files table") wins; the main README is not in the Files table, so
   it is not touched. The main README's catalog row at line 110
   already mentions `Erf, Polylog and more` for `cas-diff` —
   imprecise but not stale.

3. **The user's system-instruction "NEVER create documentation files
   unless explicitly required" appeared to clash with the prompt's
   explicit "update `packages/cas-core/README.md`."** Resolved in
   favour of the prompt — the prompt counts as explicit user
   requirement, and Law 2 needs satisfying. Filed the new README with
   minimum scope (vocab table + public surface + cross-refs); did not
   gold-plate.

## Acceptance — all 6 items green

Per the impl plan §"I6a" Acceptance checklist:

- [x] `Erfi` added to `SPECIAL_FUNCTION_HEADS` (length 28).
- [x] `specialFunctionArity("Erfi") === {shape: "fixed", count: 1}`.
- [x] `differentiate(expr("Erfi", [sym("z")]), sym("z"))` returns
  byte-identical canonical form `expr("*", [expr("/", [int(2n),
  expr("^", [sym("pi"), rat(1n, 2n)])]), expr("exp", [expr("^", [z,
  int(2n)])])])` per DLMF §7.10.2 (verified via direct script call;
  output canonical JSON matches the hand-built expected AST).
- [x] ADR-0023 has the amendment paragraph dated 2026-05-16 with the
  ADR-0040 §"Decision 6" cross-reference.
- [x] `packages/cas-core/README.md` (created) and
  `tools/cas-diff/README.md` (extended) shipped; main README not in
  the I6a Files table so untouched.
- [x] `bun test packages/cas-core/test/special-functions.test.ts`
  green — 51 pass, 0 fail, 182 expect() calls.
- [x] This shard (132 — renamed from 131 after a parallel collision
  with `131-erf-bigfloat-real.md` from the I1 subagent).

`bun run check` validation: deferred to the orchestrator (a single
file-scoped test pass + the targeted spot-check are the per-bead
signal; the full 14-phase pre-shard gate is the orchestrator's gate
per the impl plan §"Per-bead orchestrator checklist" step 3).

## Pointers

- ADR: `docs/adr/0023-cas-core-special-function-vocabulary.md` (the
  amendment paragraph is at the end of §"Decision").
- ADR-0040: `docs/adr/0040-per-head-special-function-substrate-and-
  meijer-g-bridge.md` §"Decision 6".
- Impl plan: `docs/refs/erf-research/PHASE2-impl-plans.md` §"I6a".
- Code: `packages/cas-core/src/special-functions.ts` (3-line
  vocabulary additions + new `ruleErfi` body at ~line 446).
- Tests: `packages/cas-core/test/special-functions.test.ts` new
  `describe("differentiate — Erfi (DLMF §7.10.2)")` block.
- READMEs: `packages/cas-core/README.md` (new),
  `tools/cas-diff/README.md` (extended).
- Sibling beads unblocked: `bfwt` (I4 — cas-core Erf identity table)
  and `tc2c` (I6 — Meijer-G bridge), both of which need `Erfi` as an
  admitted head.
