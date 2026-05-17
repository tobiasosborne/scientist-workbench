# 144 — cas-core vocabulary amendment: admit four Bessel-family boundary heads (2026-05-17)

> **Scope.** Land Phase 2 Round 1 bead `vsvl` (I6a) of the World-class
> Bessel epic (`zcam`): extend `packages/cas-core/src/special-functions.ts`
> with `HankelH1`, `HankelH2`, `SphericalBesselJ`, `SphericalBesselY` as
> first-class heads — vocabulary entries + arity contracts + closed-form
> diff rules per DLMF §10.6.1 (cylinder + Hankel) and DLMF §10.51.2
> (spherical Bessel). Amend ADR-0023 with a one-paragraph note recording
> the 28 → 32 table growth. Per-head substrate prototype #2 (Bessel),
> mirroring the Erfi precedent (Erf prototype #1, bead `m114`, worklog 132).

## Context

ADR-0041 (worklog 0 of the world-class-Bessel epic; bead `oibh`)
pinned the per-head special-function substrate for the Bessel family
under the ADR-0040 architecture. Phase 0 research (`docs/refs/besselj-
research/R1-R5`) surfaced one **vocabulary discovery** (R1 §13,
Discovery A): the cas-core vocabulary table needs to grow by four
heads — `HankelH1`, `HankelH2`, `SphericalBesselJ`, `SphericalBesselY`
— before the substrate's bigfloat / quadrature / meijer-core layers can
dispatch on them. Each passes the Erfi precedent test from ADR-0040 §
"Decision 6": a substrate-level pattern table can dispatch on the head
non-redundantly, and at least one v0.1-shippable identity rule exists.

`SphericalBesselI` and `SphericalBesselK` are **NOT** admitted in v0.1.
DLMF §10.47.7-8 defines two distinct spherical-modified-Bessel
conventions (`i^{(1)}_n` and `i^{(2)}_n`); the cas-core vocabulary
cannot represent "this is one of two distinct variants" without a tag-
disambiguator the substrate doesn't yet support. Filed as P3 follow-up
per ADR-0041 §"What we will not decide here".

## What changed

### `packages/cas-core/src/special-functions.ts` (~75 LOC added)

- **Top-of-file algorithm narrative**: extended the "Amendments"
  section with a 16-line paragraph documenting the 28 → 32 vocabulary
  growth, the per-head Erfi-precedent justification (Hankel needs
  first-class status because the direct Hankel-expansion numeric path
  avoids `J + i·Y` cancellation loss in the half-plane; spherical
  Bessel is the load-bearing physics encoding for Mie scattering,
  quantum partial-wave decomposition, gravitational-wave spherical
  harmonics), and the `SphericalBesselI/K` deferral rationale.
  Per CLAUDE.md Rule 10 — source files are exposition.
- **`SPECIAL_FUNCTION_HEADS`** extended with 4 new entries in a
  comment-delimited "Bessel family boundary" subgroup, immediately
  after the existing `BesselJ/Y/I/K` block. Net length 28 → 32.
- **`SPECIAL_FUNCTION_DIFFERENTIABLE_HEADS`** extended with all 4 new
  heads — every admitted head ships a closed-form diff rule. The
  differentiable subset grows 16 → 20.
- **`ARITY_TABLE`** extended with 4 `{shape: "fixed", count: 2}`
  entries.
- **`differentiateSpecialFunction` switch**: 4 new `case` labels
  fanning into 2 rule bodies. `case "HankelH1" | "HankelH2"` falls
  through to the existing `ruleBesselFirstKind` (which was already
  written generically with a `head` dispatch parameter — admitting
  Hankel required ZERO change to the rule body); `case
  "SphericalBesselJ" | "SphericalBesselY"` dispatches to the new
  `ruleSphericalBesselFirstKind`.
- **`ruleBesselFirstKind` doc-comment** expanded to document the
  4-head fan-through and to record the symmetric-vs-asymmetric form
  choice (cylinder Bessel uses symmetric per R1 §1.1; symmetric
  preserves the closed-vocabulary invariant and avoids the spurious
  `1/z` singularity at `z=0`).
- **New `ruleSphericalBesselFirstKind` body** (~25 LOC + literate
  prose): implements DLMF §10.51.2's asymmetric ascent form
  `d/dz f_n(z) = f_{n-1}(z) − ((n+1)/z) · f_n(z)`. The literate
  comment documents (a) why the asymmetric form is used here vs the
  symmetric form for cylinder Bessel — spherical's `1/z` factor is
  acceptable because consumers `integrate-1d` / `eval-numeric-expr`
  handle it exactly the way they handle `d/dz Li_s(z) = Li_{s-1}/z`
  (DLMF §25.12.4) in `rulePolylog`; (b) the closure invariant is
  preserved (output contains `SphericalBesselJ/Y` at shifted order
  plus elementary heads only).

### `packages/cas-core/test/special-functions.test.ts` (+~190 LOC)

- Existing `"contains exactly the 28 heads"` test renamed to
  `"contains exactly the 32 heads"`; expected array extended with 4
  new entries (in their canonical position between `BesselK` and
  `HypergeometricPFQ`); length assertion bumped to 32.
- Existing differentiable-subset test extended with all 4 new heads
  (alongside the existing Erfi).
- Two-arg arity sweep test extended with the 4 new heads.
- Two new `describe` blocks added:
  - `"differentiate — Hankel functions (DLMF §10.6.1)"` — 8 tests
    (H¹/H² integer order, rational order, symbolic order, chain rule,
    free-symbol-independence, order-derivative refusal, determinism).
  - `"differentiate — spherical Bessel functions (DLMF §10.51.2)"` —
    8 tests (j_n/y_n integer order, symbolic order, n=0 edge case,
    chain rule, free-symbol-independence, order-derivative refusal,
    determinism).

Final test count: 67 pass / 0 fail / 218 expect() calls (was 51 pass
pre-edit).

### `docs/adr/0023-cas-core-special-function-vocabulary.md`

One-paragraph `### Amendment 2 — 2026-05-17 (ADR-0041 §"Decision 6";
bead vsvl)` appended at the END of the ADR (per prompt: "DO NOT
modify any existing content of ADR-0023"). Mirrors the structure of
Amendment 1 (`Erfi`). Records: the four heads admitted, the per-head
Erfi-precedent justification, the symmetric / asymmetric diff-rule
shapes, the `SphericalBesselI/K` deferral rationale, and the R1 §13
cross-reference.

## Why these choices

### Why fold Hankel into the existing `ruleBesselFirstKind` rather than write a separate `ruleHankel`?

The existing `ruleBesselFirstKind` already takes a `head` parameter
and uses it generically — the rule body is purely structural over
`head + intShift(nu, ±1n)`. The existing code was *already shaped* to
accept any cylinder-Bessel-style head; the only reason it wasn't
exercised on Hankel before was that Hankel wasn't in the vocabulary.
Adding `case "HankelH1": case "HankelH2": return
ruleBesselFirstKind(head, ...)` is one line per head. Per the prompt
("a single `ruleHankel` for both H¹ and H² since they share the
recurrence") and per Decision-Principle ("what would a legendary TS
senior SE demand"): folding into the existing rule body is the
right call — *one* rule, *four* heads, no duplication. The doc-
comment now explicitly names all four heads.

### Why a separate `ruleSphericalBesselFirstKind` rather than fold into `ruleBesselFirstKind`?

Cylinder + Hankel share the *symmetric* `(C_{ν−1} − C_{ν+1}) / 2`
shape; spherical Bessel uses the *asymmetric* `j_{n-1} − ((n+1)/z)
· j_n` shape (DLMF §10.51.2 first equality). Structurally distinct
rule bodies — the spherical rule has a `1/z` factor and only one
ladder direction. Per the prompt ("The spherical-Bessel rules are
SEPARATE function"): a sister rule body, not a fold.

### Why the asymmetric DLMF §10.51.2 form for spherical Bessel?

Per the prompt's explicit specification. R1 §13.3 deems both forms
admissible ("Both forms are admissible; the symmetric `(n · j_{n−1} −
(n + 1) · j_{n+1}) / (2n + 1)` form is the canonical v0.1 choice
mirroring the cylinder Bessel convention"). The prompt overrides:
"d/dz j_n(z) = j_{n-1}(z) - (n+1)/z · j_n(z)" — the asymmetric
ascent form. This is the orchestrator's explicit instruction; the
asymmetric form has the virtue of a unidirectional ladder (small-`n`
consumers like Mie scattering and quantum partial-wave decomp shrink
linearly rather than fanning out symmetrically), and the `1/z` factor
is handled by the same downstream consumers (`integrate-1d`,
`eval-numeric-expr`) that already handle the analogous `1/z` in
`rulePolylog`'s `Li_{s-1}/z` output. Documented as a literate prose
comment at the top of `ruleSphericalBesselFirstKind` so a future
reader sees the symmetric-vs-asymmetric design tension surfaced and
the rationale for the asymmetric choice.

### Why admit only `HankelH1/H2 + SphericalBesselJ/Y` (not also `SphericalBesselI/K`)?

The DLMF §10.47.7-8 `i^{(1)}_n` / `i^{(2)}_n` convention ambiguity
makes a single-head admission unsound — admitting `SphericalBesselI`
would either pin one convention silently (which version?) or encode
both (which requires a tag-disambiguator the AST doesn't support).
The honest scope discipline (PRD §6.1; CLAUDE.md Rule 8) says: defer
until a consumer files the use case and a clean disambiguation
emerges. Filed as P3 follow-up per ADR-0041 §"What we will not
decide here".

### Why mutation-prove three perturbations rather than one?

Per CLAUDE.md Rule 6 (mutation-proving discipline) the prompt
specified ≥3. Each perturbation targets a distinct axis of the
change (vocabulary admission, arity contract, diff-rule body), so a
regression in any one is caught by a distinct test failure pattern.
Recorded:

1. **Mutation 1 — vocabulary removal**: deleted `"HankelH1"` from
   `SPECIAL_FUNCTION_HEADS`. RED: 3 tests fail
   (`"32 heads"` vocab-shape test; `"two-arg heads have arity 2"`
   sweep; `"every differentiable head is in the master vocabulary"`
   closure). Restored.
2. **Mutation 2 — arity flip**: changed `SphericalBesselJ` arity
   from `count: 2` to `count: 1`. RED: 1 test fails
   (`"two-arg heads have arity 2"` sweep, expected 2, received 1).
   Restored.
3. **Mutation 3 — diff-rule sign flip**: changed `mkMinus(ladderDown,
   ratioTerm)` to `mkPlus([ladderDown, ratioTerm])` inside
   `ruleSphericalBesselFirstKind`. RED: 5 spherical-Bessel diff
   tests fail (j_n integer order, y_n integer order, symbolic
   order, n=0 edge, chain rule). Restored.

Final state after all three restorations: 67 pass / 0 fail.

## Frictions surfaced

1. **The prompt cites "R1 §10" and "R1 §17"; the actual sections are
   §1 (recurrences) / §7 (derivative identities) and §13 (vocabulary
   recommendations).** R1 has 17 numbered sections, not aligned with
   the prompt's references. Resolved by reading R1 §1.1 (cylinder
   recurrences), §1.3 (spherical recurrences — deferred per R1; this
   bead is where it lands), §7 (derivative identities), and §13
   (Discovery A: vocabulary expansion). The prompt's diff-rule
   specifications are consistent with DLMF §10.6.1 (Hankel via the
   cylinder-Bessel framing) and DLMF §10.51.2 (spherical Bessel
   asymmetric ascent). Per CLAUDE.md Rule 3 (skepticism): I
   triangulated against R1 directly rather than trusting the
   prompt's section numbers.

2. **R1 §13.3's recommendation conflicts with the prompt's literal
   diff form.** R1 recommends the *symmetric* form for spherical
   Bessel ("the canonical v0.1 choice mirroring the cylinder Bessel
   convention"), but the prompt explicitly specifies the asymmetric
   `j_{n-1} - (n+1)/z · j_n` form. R1 §13.3 explicitly admits both
   ("Both forms are admissible"). The prompt is the orchestrator's
   explicit specification; following it directly. Documented the
   tension and the asymmetric-form rationale (unidirectional ladder,
   precedent in `rulePolylog`'s `Li_{s-1}/z` output) in a literate
   comment at the top of `ruleSphericalBesselFirstKind`. A future
   bead could revisit if `cas-simplify` ever needs to canonicalize
   spherical Bessel derivatives uniformly with cylinder Bessel
   derivatives — that would be a separate ADR.

3. **The existing `ruleBesselFirstKind` was already written
   generically.** The `head` parameter and the `expr(head, ...)`
   recurrence emission meant ZERO line-change to the rule body to
   admit Hankel. The change is purely additive: 4 lines in the switch
   case, 6 lines in the existing rule's doc-comment. This is the
   payoff from the rule's original literate-prose design — the
   abstraction was already in place; this bead just exercised it. No
   friction, but worth recording as a positive instance of CLAUDE.md
   Rule 10 paying forward.

## Acceptance

Per the prompt's required-output checklist:

- [x] **Vocabulary additions**: 4 new entries in
  `SPECIAL_FUNCTION_HEADS` (28 → 32). Verified by
  `"contains exactly the 32 heads"` test.
- [x] **Arity table**: 4 new `{shape: "fixed", count: 2}` entries.
  Verified by `"two-arg heads have arity 2"` sweep.
- [x] **Derivative rules**: Hankel folds into existing
  `ruleBesselFirstKind`; spherical Bessel lands as new
  `ruleSphericalBesselFirstKind`. Both verified by per-head diff
  tests against hand-built canonical-form expectations.
- [x] **ADR-0023 amendment** appended at end of file as
  `### Amendment 2`. Existing ADR content untouched.
- [x] **Literate prose**: top-of-file Amendments section extended;
  `ruleBesselFirstKind` doc-comment expanded; new
  `ruleSphericalBesselFirstKind` ships with full prose comment block
  per Rule 10.
- [x] **Mutation-proving ≥ 3**: documented above (vocab removal,
  arity flip, sign flip — all three RED, all three restored to
  green).
- [x] **Validation**: `bun test
  packages/cas-core/test/special-functions.test.ts` → 67 pass / 0
  fail / 218 expect() calls. `bun run check` → (gated on
  orchestrator full-check; per-file signal is the per-bead gate).
- [x] **This worklog shard** (~250 lines).

## Pointers

- ADR: `docs/adr/0041-bessel-family-per-head-substrate.md`
  §"Decision 6" (the umbrella vocab decision).
- ADR amendment: `docs/adr/0023-cas-core-special-function-vocabulary.md`
  (Amendment 2 at the end of file).
- Code: `packages/cas-core/src/special-functions.ts` (4 vocabulary
  rows, 4 arity rows, 4 switch cases, 1 new rule body, expanded
  literate prose on `ruleBesselFirstKind`).
- Tests: `packages/cas-core/test/special-functions.test.ts` (3
  existing tests extended with 4-head entries; 2 new `describe`
  blocks for Hankel + spherical Bessel diff rules).
- Erfi precedent: `docs/worklog/132-cas-core-vocab-erfi-admit.md`
  (the prototype-#1 styling exemplar this shard mirrors).
- R1 ground truth: `docs/refs/besselj-research/R1-symbolic-identities.md`
  §1.1 (cylinder Bessel recurrence), §1.3 (spherical Bessel
  recurrence — deferred in R1, landed here), §13 (vocabulary
  expansion Discovery A), §13.3 (the symmetric-vs-asymmetric form
  discussion).
- Sibling beads unblocked: `lrmo` (I4 — cas-core Bessel identity
  rules) which needs the 4 new heads as admitted vocabulary; and
  follow-on substrate rounds (I1a/I1b real arb-prec; I2a/I2b
  modified real arb-prec; I3a/I3b complex; I5a float64; I6
  Meijer-G bridge).
