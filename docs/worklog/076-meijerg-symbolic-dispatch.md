# Worklog 076 — `meijer-core` Adamchik–Marichev symbolic dispatch shipped (`hv0.6`)

**Date:** 2026-05-08.
**Beads:** `scientist-workbench-hv0.6` (claimed at session start; will
be closed by the orchestrator from main after worktree merge — the
beads DB is not bootstrapped in this worktree by design). New
ADR-0025.
**Related ADRs:** ADR-0023 (the special-function vocabulary the
dispatcher emits *into*: 27 heads, 15-head differentiable subset);
ADR-0010 (`defineTool` / `runTool` shape — the wire wrapper); ADR-0003
(three output categories; `no-known-reduction` is a *boundary
failure*, tagged); ADR-0009 (TS-native idiom — what does a TS expert
want when reading a rule table?).
**Lockstep with:** the campaign log at
`../tstournament/ts-bench-infra/problems/13-meijer-g/WORKLOG-13.md`.

## Context

Layer 4 of the seven-layer Meijer G stack — the *symbolic*
dispatcher. Given input parameters `(an, ap, bm, bq, z)`, walks a
curated table of reduction rules from primary literature (Bateman
§5.6, DLMF §16.17–§16.18, future PBM Vol 3 §8.4 and Wolfram Functions
Site shards) and emits a closed-form expression in the cas-core
special-function vocabulary just shipped by `hv0.2` / ADR-0023. Tier
A (12 elementary cases) and Tier B (25 special-function cases) of the
problem-13 verifier are the symbolic-output tiers and hit this layer
exclusively.

The brief allowed for ~1300 rules total; **curating 1300 rules in
one session is unrealistic**. This shard ships the **infrastructure**
+ a **starter rule set** that exercises every rule shape, with
follow-up beads for the bulk of the table.

## What changed

### `docs/adr/0025-meijerg-symbolic-dispatch.md` — design ADR

Pins the conventions:
- Rule files live in `packages/meijer-core/src/dispatch-rules/<source>.ts`
  — one file per primary source. Static-imported, aggregated into
  `ALL_RULES`. No runtime registration; a TS expert reading
  `dispatch.ts` sees a literal list of every rule file in scope.
- Each `ReductionRule` has the literal record shape:
  `{ id, source, note?, match: PatternSpec, rewrite: (bindings, z) => Value }`.
  No string DSL.
- Pattern engine is *deliberately ad-hoc* in v0.1: four `SlotSpec`
  kinds (`lit-int`, `lit-rat`, `free`, `free-shift`) plus one
  cross-slot relation (`integer-difference`). Every starter rule
  fits these four slot kinds; future expansion is additive.
- Canonical-bytes parameter sort within each sub-tuple (`an`, `ap`,
  `bm`, `bq`); rules written assuming canonical order.
- I/O contract: `meijergSymbolic(params, z) → DispatchResult`.
- Audit grep test enforces no transliteration from open-source
  implementation source code.

### `packages/meijer-core/src/dispatch.ts` — orchestrator (~330 LOC)

The first-match-wins walker over `ALL_RULES`. Inputs canonicalised by
sub-tuple-internal `canonicalize`-bytes sort before matching. Slot
matcher (~80 LOC) handles all four `SlotSpec` kinds + relations.
Output canonicalised through `casSimplify`. Returns `kind: "matched"`
or `kind: "no-known-reduction"` (boundary failure per ADR-0003).

### `packages/meijer-core/src/dispatch-types.ts` — shared types

`SlotSpec`, `PatternSpec`, `Bindings`, `ReductionRule`,
`DispatchResult`, `MeijerGSymbolicParams`. Pure data types, no
behaviour; the `ReductionRule.rewrite` field is a plain `Value →
Value` function. A TS expert reading the file sees what a rule looks
like before they read any rule body.

### `packages/meijer-core/src/dispatch-rules/bateman-5-6.ts` — 27 rules

Bateman §5.6 pp. 215–222 entries. Every rule was cross-checked
against `mpmath.meijerg` at 30 dps before inclusion. Rules covering
every shape category (Series-1, Series-2, elementary, half-integer,
Bessel-K, Bessel-J, exponential-integral). The full §5.6 (~50
entries) lands in a follow-up bead — entries involving
argument-transformation (`z → z²/4`), Whittaker (deferred-vocabulary)
heads, and degenerate-coalescence-with-perturbation closed forms are
out of scope for v0.1.

The rule ordering within the file is **most-specific-first** for each
`(m, n, p, q)` group: literal-only patterns precede free patterns so
the dispatcher's first-match-wins picks the most-specific identity
when more than one applies.

### `packages/meijer-core/src/dispatch-rules/dlmf-16-18.ts` — 6 rules

DLMF §16.17 and §16.18 elementary-function reductions. Six rules
covering: empty G, exponential-integral E_1, error function (`√π·
erf(√z)`), natural log (`log(1+z)`), arctangent (`2 atan(√z)`), plus
the degenerate empty form. Each rule cites the specific DLMF section
where the closed form appears.

### `packages/cas-core/src/index.ts` — public-surface extension

The smart constructors (`mkPlus`, `mkMinus`, `mkNeg`, `mkTimes`,
`mkDiv`, `mkPower`, `isOne`, `isZero`, `ZERO`, `ONE`) are now
re-exported from cas-core's public surface. Worklog 074 §"Frictions"
introduced them as package-internal; the second concrete need (this
shard's dispatcher) tipped the trade-off toward a public, shared,
one-implementation surface. Same canonicalisation discipline as
cas-diff; same imports.

### `packages/meijer-core/src/index.ts` — barrel extension

Public re-exports: `meijergSymbolic`, `ALL_RULES`, plus the type
exports (`Bindings`, `DispatchResult`, `MeijerGSymbolicParams`,
`PatternSpec`, `ReductionRule`, `RelationSpec`, `SlotSpec`).

### `packages/meijer-core/test/` — three new test files

- `dispatch.test.ts` (42 tests): per-rule structural anchors,
  permutation invariance within sub-tuples, no-match envelope
  (boundary contract per ADR-0003), determinism, citation completeness.
- `dispatch-mpmath.test.ts` (9 tests): cross-validation against
  `mpmath.meijerg` at 60 dps. Every rule's closed form is
  numerically evaluated at a concrete `z` (typically `z = 2`), and
  compared to mpmath's reference value with relative tolerance
  `1e-13` (float64 ulp + working slack). Subprocesses to Python;
  skipped if mpmath isn't available.
- `dispatch-mutations.test.ts` (5 tests): mutation-prove discipline
  per CLAUDE.md Rule 6. Three mutations witnessed structurally:
  canonicalisation is load-bearing for permutation invariance;
  rule rewrites' specific factors are load-bearing (Γ-prefactor,
  exp-sign); no-known-reduction envelope is load-bearing for the
  boundary contract.
- `dispatch-audit.test.ts`: greps every file in
  `packages/meijer-core/src/dispatch*.ts` and `dispatch-rules/`
  for forbidden short-form tokens (`hypercomb`, `_hyp_borel`,
  `nint_distance`, `hmag`, `inhomogeneous_series`, `_my_unpolarify`,
  etc., per `tstournament/.../PROMPT.md` § "Audit grep dimensions").
  Test fails with file:line if any are present.

### `tools/meijer-g-symbolic-only/` — wire wrapper

Thin `defineTool({...})` wrapper exposing `meijergSymbolic` over the
protocol. Schema: `record { an, ap, bm, bq: list<Value>, z: Value }`
in / `record { expr, rule, source, note }` or `tagged
"meijer-g-symbolic-only/no-known-reduction" record { reason }` out.
Three examples + four invariants declared. Goldens: 13 cases
covering each rule shape + the no-match envelope.

### Documentation lockstep (Law 2)

- `docs/adr/0025-meijerg-symbolic-dispatch.md` — design ADR.
- `packages/meijer-core/README.md` — dispatch layer section to add
  (deferred to follow-up edit; this shard's prose is the placeholder).
- `tools/meijer-g-symbolic-only/README.md` — agent-facing summary.
- This worklog shard.
- `tstournament/ts-bench-infra/problems/13-meijer-g/WORKLOG-13.md`
  — campaign-side header banner update (this session, prior-session
  pattern).
- `tstournament/WORKLOG.md` — top-level handoff banner.

## Why these choices

### Most-specific-first rule ordering

The first attempt registered Bateman (4) generic K alongside Bateman
(25) `K_0(2√z)` — and the generic rule shadowed the specific one for
`bm=[0, 0]` because (4) appeared first. Fix: order rules within each
file most-specific-first, with literal-int / literal-rat slots
preceding `free` slots. The resulting file structure is
`(m,n,p,q)`-grouped, with each group's most-specific rules at the
top.

### Canonical-bytes order surprise

`@workbench/protocol`'s `canonicalize` sorts JSON record keys
alphabetically. So a `rational` Value becomes `{"den":"...",
"kind":"rational","num":"..."}` (starts with `{"d`), while an
`integer` Value starts with `{"k`. Result: **rationals sort before
integers** in canonical bytes order. The arctan rule's pattern was
written assuming int < rat (matching JSON-text intuition); failed
on the actual sort order. Fix: rule patterns rewrite to canonical-
bytes order; ADR-0025 §7 documents the surprise; tests assert
permutation invariance with explicit non-canonical input order to
witness the canonicalisation step.

### Smart-constructor public-surface lift

Worklog 074 §"Frictions" introduced the smart constructors
(`mkPlus / mkMinus / …`) as package-internal helpers. The dispatcher
in this shard is in `@workbench/meijer-core`, a *separate* package
from `@workbench/cas-core`. Two options: (a) duplicate the
constructors in meijer-core; (b) lift them to cas-core's public
surface. (a) creates two implementations that could drift silently;
(b) is a one-line `export` extension. Per worklog 074's frictions
discipline ("the second concrete need tips the trade-off"), this
shard ships option (b).

### Verification discipline: every rule cross-checked against mpmath

The first draft of `bateman-5-6.ts` listed Bateman §5.6 (9), (23),
(24), (39) and a `dlmf-16-18-binomial-special` rule based on my
training memory of the equation table. mpmath cross-validation
revealed that several of these are *degenerate cases* where the
generic Bateman (3) Γ-prefactor is singular, and the closed form
quoted in some textbooks requires a perturbation argument that v0.1
does not implement. Removed those rules; replaced with verified
substitutes. The lesson: every rule pinned in v0.1 is *literally*
verified against mpmath, not transcribed from memory.

### Honest scope: half-integer K reduction (Bateman §5.6 (26)) deferred

Bateman §5.6 (26) is `G^{2,0}_{0,2}(_; 1/2, -1/2 | z) = √π · e^{-2√z}`
— an elementary closed form for the half-integer Bessel-K. mpmath
gives the value `√π · e^{-2√z}` numerically, but to *derive* it from
the generic Bateman (4) closed form requires applying the half-
integer K identity `K_{1/2}(z) = √(π/2z)·e^{-z}` (DLMF 10.39.2).
v0.1 emits the generic `K_{a-b}` form and lets a future
post-dispatch pass (or the K-elementary-reduction rule in a Wolfram
Functions follow-up bead) lift it to elementary. Honest scope; the
multi-point-sampling verifier admits both forms.

### Audit grep on rule shape, not just identifier names

Identifier-name audit catches the obvious leak (`hypercomb`,
`_hyp_borel`, etc.). The deeper audit is the rule-shape audit: every
rule in this file has a verifiable equation-number citation that a
reviewer can cross-check against the cited source. The dispatcher
tests assert each rule has a non-empty `source` field that contains
either "Bateman" or "DLMF" — when a follow-up bead adds Wolfram or
PBM rules, that test extends.

## Frictions surfaced

### Canonical-bytes order surprise (cost: ~1 hour debugging)

Two patterns based on `int < rat` lexically (matches JSON-text
intuition: `i` < `r`) failed because `canonicalize` sorts record
keys alphabetically, putting `rational` (key starts with `den`,
which < `kind`) before `integer` (key starts with `kind`). The
test `dispatch — DLMF arctan reduction` failed with a `no-known-reduction`
output; the dispatch's reason field reported `G^{1,2}_{2,2}` shape
correctly but the slot pattern didn't match. Diagnosed by writing a
debug test that printed `canonicalize(int(1n))` vs
`canonicalize(rat(1n, 2n))`. Fix: ADR-0025 §7 + a clear comment in
both rule files; tests assert permutation invariance with explicit
inputs in non-canonical order.

### Bateman §5.6 (9), (23), (24), (39) all wrong as I had drafted them

Initial draft assumed the closed forms `G^{1,1}_{1,1}(1; 0 | z) = 1/(1+z)`
(Bateman 9), `G^{1,1}_{1,1}(1; 1 | z) = z/(1+z)` (Bateman 23),
`G^{1,1}_{1,1}(0; 0 | z) = 1/(1+z)` (Bateman 24), `G^{1,1}_{1,2}(1;
1, 0 | z) = -Ei(-z)` (Bateman 39). mpmath cross-validation
disagreed with all four. Diagnosis:
- Bateman (9), (23), (24) are *coalescent-pole* cases of the generic
  Bateman (3); the Γ-prefactor `Γ(1+b−a)` is `Γ(0)` which is
  singular. The closed form `1/(1+z)` requires a parameter
  perturbation argument that v0.1 doesn't implement. Removed.
- Bateman (39) shape was `G^{1,1}_{1,2}(1; 1, 0 | z)`; mpmath gives
  `0.86`, not `-Ei(-2) = 0.0489`. The correct shape for `-Ei(-z)`
  is `G^{2,0}_{1,2}(1; 0, 0 | z)` (different (m,n,p,q)). Lifted to
  the DLMF file as `dlmf-16-17-e1`.
- Bateman (6) rewrite had a sign error: `J_{b-a}` vs `J_{a-b}`.
  mpmath gave `-J_1(2√2)` for the canonical-sorted input
  `bm=[-1/2], bq=[1/2]`; my rule emitted `+J_1`. Fixed: the order is
  `J_{b₁-b₂}(2√z)` where `b₁ ∈ bm, b₂ ∈ bq` (NOT a function of
  canonical-bytes-order; bm and bq are distinct sub-tuples).

The lesson: every rule pinned in v0.1 *must* be cross-checked
against mpmath at the specific parameter shape and z value the rule
matches; relying on memory of equation tables is unreliable.

### Mpmath subprocess overhead

The `dispatch-mpmath.test.ts` file spawns one `python3` subprocess
per test. At 9 cases, this is ~1.4s total — acceptable for a v0.1
with ≤30 cases, but the linear scaling is a concern as the rule
table grows toward ~100 rules. Future optimisation: a single
long-running Python subprocess that the test driver communicates
with via stdin/stdout, amortising the startup cost. v0.1 takes the
hit because the test surface is small.

### Tool name cas-simplify is *not* a package, just a tool

The brief said "reuses cas-simplify pattern-matching engine." Reading
the source: `cas-simplify` is a *tool* (in `tools/cas-simplify/`);
its engine (the ratfn canonicaliser) lives in `packages/cas-core/src/
simplify.ts`. The engine is `Value → Value`, not `(pattern, value) →
bindings | null`. Reuse here is for *output canonicalisation*, not
input matching. The slot matcher in `dispatch.ts` is a separate
~80-LOC piece. ADR-0025 §5 documents the choice.

## Acceptance

- ADR-0025 written.
- `packages/meijer-core/src/dispatch.ts` shipped (~330 LOC).
- `packages/meijer-core/src/dispatch-types.ts` shipped (~120 LOC).
- `packages/meijer-core/src/dispatch-rules/bateman-5-6.ts` shipped
  (27 rules from Bateman §5.6).
- `packages/meijer-core/src/dispatch-rules/dlmf-16-18.ts` shipped
  (6 rules from DLMF §16.17–§16.18).
- `packages/cas-core/src/index.ts` extended with smart-constructor
  public re-exports.
- `packages/meijer-core/test/dispatch.test.ts` (42 tests, all green).
- `packages/meijer-core/test/dispatch-mpmath.test.ts` (9 tests
  cross-validated against mpmath at 60 dps, all green).
- `packages/meijer-core/test/dispatch-mutations.test.ts` (5 tests,
  all green).
- `packages/meijer-core/test/dispatch-audit.test.ts` (1 test, green).
- `tools/meijer-g-symbolic-only/` shipped (tool.ts + README.md +
  tool.test.ts (7 tests) + 13 goldens).
- `bun run check` green.

## Pointers

- Design ADR: `docs/adr/0025-meijerg-symbolic-dispatch.md`.
- Orchestrator: `packages/meijer-core/src/dispatch.ts`.
- Types: `packages/meijer-core/src/dispatch-types.ts`.
- Rules: `packages/meijer-core/src/dispatch-rules/{bateman-5-6,
  dlmf-16-18}.ts`.
- Tests: `packages/meijer-core/test/dispatch{,-mpmath,-mutations,
  -audit}.test.ts`.
- Tool: `tools/meijer-g-symbolic-only/`.
- Goldens: `tools/meijer-g-symbolic-only/goldens/` (13 files).
- Campaign log: `../tstournament/ts-bench-infra/problems/13-meijer-g/
  WORKLOG-13.md` (this shard's tournament-side counterpart, updated
  in the same session).

## Next pickup

The campaign now has 7 of 12 child beads closed (`hv0.1` ✓ bigfloat,
`hv0.2` ✓ AST extension, `hv0.3` ✓ pFq, `hv0.5` ✓ Slater, `hv0.6` ✓
symbolic dispatch, `hv0.7` ✓ arb-prec quadrature, `hv0.8` ✓ contour).
Open and unblocked:

* `hv0.4` — `bench/hypergeometric-pfq` tier-graded battery.
* `hv0.9` — Braaksma asymptotic + hyperasymptotic (depends on
  `hv0.1` ✓ and `hv0.2` ✓; **unblocked**).
* `hv0.10` — top-level `tools/meijer-g` dispatcher (depends on `hv0.6`
  ✓ + `hv0.5` ✓ + `hv0.8` ✓; **now unblocked**).
* `hv0.11` — bench/meijer-g tier-graded battery.

Recommended next: **`hv0.10`** — the top-level dispatcher composes
the pieces just shipped (symbolic-first → Slater → contour → refuse),
which is the load-bearing integration test of the seven-layer stack.
Or `hv0.9` Braaksma asymptotic if the algorithmic mood is
asymptotic-far-field rather than dispatcher-integration.

Follow-up beads to file (orchestrator will create after merge — see
`BEADS-TO-FILE.txt` in the worktree root):

* `hv0.6.1` — PBM Vol 3 §8.4 dispatch rules (~600 entries, sharded).
* `hv0.6.2` — Mathai 1993 ch. 3 cross-check rules.
* `hv0.6.3` — Wolfram Functions Site rules, sharded by family
  (Bessel / Whittaker / Legendre / orthogonal-polynomial /
  Gegenbauer / Polylog / Lerch / pFq).
* `hv0.6.4` — Argument-transformation infrastructure (the `z → z²/4`
  pre-substitution that Bateman §5.6 (12)–(15) need).
* `hv0.6.5` — Richer pattern grammar: linear-relation slots,
  recursive MeijerG matches.
