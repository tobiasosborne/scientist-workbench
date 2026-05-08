# Worklog 074 — `cas-core` special-function AST vocabulary extension shipped (`hv0.2`)

**Date:** 2026-05-08.
**Beads:** `scientist-workbench-hv0.2` (✓ closed). New ADR-0023.
**Related ADRs:** ADR-0009 (TS-native idiom — the framework that decides
the closed-vocabulary-not-open-registry shape and the Wolfram encoding
for list-parameter heads); ADR-0010 (defineTool/runTool split — why
this lands as library extension, not as a new wire tool); ADR-0020
(arb-prec tier — the substrate that future per-head arbprec evaluators
will live in); the existing cas-diff design (worklog 041; ADR-implicit
closed-vocabulary differentiator).
**Lockstep with:** the campaign log at
`../tstournament/ts-bench-infra/problems/13-meijer-g/WORKLOG-13.md`.

## Context

Layer 1 of the seven-layer Meijer G stack: extend `cas-core`'s closed
AST from the elementary numerical vocabulary (the `cas-diff` /
`integrate-1d` / `optimize-lbfgs-projected` / `integrate-ode-*` rule
table) to the **special-function vocabulary** that the symbolic
dispatcher (`hv0.6`, Adamchik–Marichev + Roach reduction) and the
asymptotic layer (`hv0.9`, Braaksma + Olde Daalhuis–Olver) reduce *to*
and *from*. Both downstream layers pattern-match on heads like
`Gamma`, `BesselJ`, `HypergeometricPFQ`, `MeijerG`; without a shared
vocabulary table, they cannot canonicalise their outputs nor recognise
their inputs.

ADR-0023 §"Decision" pins the 27-head closed vocabulary and the
diff-rule cascade. The plan sub-problem brief
(`13b-special-fn-ast-and-pfq/DESCRIPTION.md` Part 1) names "AST
recognition + arity contract + diff rules + parse round-trip + pretty-
printer" as the per-head deliverable; this shard ships the first three.
Parse round-trip needs no work — `expr-parse` already admits any
identifier-followed-by-`(` as an expression head, so `BesselJ(0, x)`
parses to `expr("BesselJ", [int(0n), sym("x")])` today (worklog 042
tier-1 vocabulary extension precedent). General pretty-printer
infrastructure is a separable concern and lands in a follow-up bead
when a consumer needs it.

## What changed

### `packages/cas-core/src/special-functions.ts` — the new module

A new ~440 LOC file (table + arity + diff dispatcher + literate
prose). Public surface:

* `SPECIAL_FUNCTION_HEADS: readonly string[]` — the 27 admitted heads,
  ordered by problem-13 reduction-table relevance (Gamma family →
  Bessel → PFQ → Whittaker / parabolic → error-and-friends →
  Legendre → other orthogonals → Polylog / Lerch → MeijerG last).
* `SPECIAL_FUNCTION_DIFFERENTIABLE_HEADS: readonly string[]` — the
  v0.1 closed-form-rule subset (15 heads).
* `type SpecialFunctionArity` — discriminated union of `fixed { count }`
  and `list-head { argShapes: ("scalar" | "list" | "list-of-list")[] }`.
  Most heads use `fixed`; `HypergeometricPFQ` is `(list, list, scalar)`
  per Wolfram convention; `MeijerG` is `(list-of-list, list-of-list,
  scalar)`.
* `specialFunctionArity(head): SpecialFunctionArity | null` — null for
  unknown heads.
* `differentiateSpecialFunction(head, args, wrt, recurDiff): Value | null`
  — returns the closed-form derivative for differentiable heads, or
  `null` for AST-admitted-but-deferred heads (caller falls through to
  the existing boundary-tag refusal).

The differentiable-subset rules each have a one-line DLMF citation in
the rule body's leading comment:

| Head | d/dz rule | Source |
|---|---|---|
| `Gamma(z)` | `ψ(z) · Γ(z)` | DLMF §5.4.2 |
| `Digamma(z)` | `ψ⁽¹⁾(z)` | DLMF §5.7.1 |
| `Polygamma(n, z)` | `ψ⁽ⁿ⁺¹⁾(z)` (var = z) | DLMF §5.15.3 |
| `Erf(z)` | `2/√π · exp(−z²)` | DLMF §7.7.1 |
| `Erfc(z)` | `−2/√π · exp(−z²)` | DLMF §7.7.1 |
| `ExpIntegralEi(z)` | `exp(z)/z` | DLMF §6.2.6 |
| `ExpIntegralE(n, z)` | `−E_{n−1}(z)` (var = z) | DLMF §8.19.13 |
| `FresnelC(z)` | `cos(π·z²/2)` | DLMF §7.2.7 |
| `FresnelS(z)` | `sin(π·z²/2)` | DLMF §7.2.7 |
| `BesselJ(ν, z)` | `(J_{ν−1} − J_{ν+1})/2` (var = z) | DLMF §10.6.1 |
| `BesselY(ν, z)` | `(Y_{ν−1} − Y_{ν+1})/2` | DLMF §10.6.1 |
| `BesselI(ν, z)` | `(I_{ν−1} + I_{ν+1})/2` | DLMF §10.29.1 |
| `BesselK(ν, z)` | `−(K_{ν−1} + K_{ν+1})/2` | DLMF §10.29.1 |
| `HermiteH(n, z)` | `2n · H_{n−1}(z)` (var = z) | DLMF §18.9.27 |
| `Polylog(s, z)` | `Li_{s−1}(z)/z` (var = z) | DLMF §25.12.4 |

Discrete-order parameters (`n` in `Polygamma`, `ν` in `BesselJ`, etc.)
are *not* differentiated in v0.1 — every such rule checks
`dependsOnWrt(orderArg, wrt, recurDiff)` and returns `null` if the
order depends on `wrt`. Closed-form parameter-derivative rules exist
(e.g., `∂J/∂ν` involves Polygamma) but their landing belongs to a
future bead. The honest refusal is correct (PRD §6.1; ADR-0003
boundary-class).

The `intShift(v, k)` helper shifts an order parameter by a small
integer, dispatched on Value kind: `int → int(BigInt + k)`,
`rational → rat(num + k·den, den)`, otherwise `expr("+" or "-", ...)`.
This keeps `d/dz J_3(z)` printing as `(J_2 − J_4)/2` (rational
arithmetic on the integer order) and `d/dz J_{1/2}(z)` as
`(J_{−1/2} − J_{3/2})/2` (rational arithmetic on the half-integer
order), without forcing every rational shift through a symbolic
expression node.

### `packages/cas-core/src/diff.ts` — extension point

Two surgical edits:

1. The seven smart-constructor helpers (`mkPlus`, `mkMinus`, `mkNeg`,
   `mkTimes`, `mkDiv`, `mkPower`, plus `isZero` / `isOne` / `ZERO` /
   `ONE`) are now `export`ed (rather than left private). They are
   *not* re-exported from `index.ts` — they're package-internal
   helpers usable by every diff-rule module in the package, but not
   part of the cas-core public API. The file's leading comment block
   explains the rationale.
2. `diffExpression` falls through to `differentiateSpecialFunction`
   when `head` is not in `DIFF_ADMITTED_HEADS_SET`. A non-null result
   is the derivative; null lands at the existing
   `CasDiffOutOfScopeError("head", ...)` refusal. Foreign heads (not
   in either table) take the same path they always have — the
   boundary-tag contract is preserved by construction.

### `tools/cas-diff` — examples + end-to-end check

Two new examples (`Gamma → Digamma·Gamma` and `MeijerG → tagged`) plus
an end-to-end check in the `--test` hook that exercises both shapes
through the tool's `fn`, not just the package surface. The existing
8-corpus FD cross-check still runs byte-identically — special-function
rules emit heads `evalNumericExpr` does not handle, so they're not in
the FD corpus; they're verified by structural unit tests in the
package layer.

### Tests — 45 new tests in `packages/cas-core/test/special-functions.test.ts`

Three layers:

- **Vocabulary table tests** (3 tests): exhaustive head list,
  no-duplicates, no-overlap-with-elementary.
- **Arity-contract tests** (6 tests, dozens of expects): unknown →
  null; single-z heads have arity 1; two-arg heads arity 2;
  three-arg heads arity 3; `HypergeometricPFQ` `(list, list,
  scalar)`; `MeijerG` `(list-of-list, list-of-list, scalar)`.
- **Per-head diff-rule tests** (35 tests): one structural-equality
  unit test per closed-form rule, one chain-rule test per family
  (`d/dz Γ(2z) = 2 · ψ(2z) · Γ(2z)`; `d/dz erf(2z) = (2/√π · exp(-(2z)²)) · 2`),
  one rational-order Bessel test (`d/dz J_{1/2}(z)` exercises the
  `rat`-kind branch of `intShift`), one symbolic-order Bessel test
  (exercises the symbolic branch), and one parameter-derivative-refuses
  test per discrete-order rule. Plus three composition tests
  (product rule with Γ, chain rule with Erf inside exp, free-symbol
  independence) and two determinism tests (`canonicalize` byte-equal
  on two calls).

Mutation-prove discipline (Rule 6 / port-and-verify): each rule has a
single canonical-form witness asserted. A typo in any rule (dropping
the chain-rule factor, swapping `ν−1 / ν+1`, missing the negative sign
on Erfc, off-by-one in the Hermite shift, etc.) fails one or more
specific tests by structural mismatch. The structural-equality oracle
is sufficient because each rule has a unique hand-derived shape from
DLMF.

### `tools/cas-diff/goldens.spec.ts` — 14 new goldens, 43 → 57

One golden per representative differentiable head (Γ, ψ, Erf, Erfc,
Ei, FresnelC, BesselJ, BesselI, BesselK, HermiteH, Polylog) plus three
deferred-head refusal goldens (MeijerG, WhittakerM, LegendreP) — proves
the dispatcher is wired through the tool's wire surface and that the
boundary tag fires for AST-admitted-but-not-yet-differentiable heads.

### Documentation lockstep (Law 2)

- `docs/adr/0023-cas-core-special-function-vocabulary.md` — the design
  ADR. Names the vocabulary, the differentiable subset, the deferred
  subset (with one-line "why deferred" justifications), and the
  three "what we will not decide here" out-of-scope items
  (numerical evaluation, pretty-printer, expr-parse syntax).
- `tools/cas-diff/README.md` — vocabulary table extended; the
  out-of-scope-vocabulary paragraph rephrased to mention the
  ADR-0023 set; the diff-rule table grows by 16 rows.
- Main `README.md` — `cas-diff` catalog row mentions ADR-0023 and
  enumerates the special-function vocabulary; the file-layout
  `cas-core/` row mentions the new dispatcher.

## Why these choices

### Closed vocabulary, not open registry

The TS-expert-irresistibility test (ADR-0009; the Two Principles): a
TS expert reading `SPECIAL_FUNCTION_HEADS` wants a finite, enumerable
table. `registerSpecialFunction(...)` would push the question one
level up — when an agent sees an unfamiliar head, what does it mean? —
without a corresponding upside. Future expansions add to the table via
a new ADR + a deliberate edit, never via runtime registration.

### Extension to `differentiate`, not a new function

`cas-diff` callers already invoke `differentiate(e, wrt)`. Branching
to a new `differentiateExtended(e, wrt)` would force every consumer
to choose between the two — for no benefit, since the elementary
vocabulary is a strict subset of the extended one. The single entry
point is the TS-expert reach.

### Callback for `recurDiff`, not direct import

`differentiate` (in `diff.ts`) and `differentiateSpecialFunction`
(in `special-functions.ts`) form a recursive pair. Importing
`differentiate` directly in `special-functions.ts` would create a
circular module dependency that, while TS usually resolves, is a code
smell — the wrong direction of dependency for a vocabulary table to
point back at the diff engine. The callback inverts the dependency:
`special-functions.ts` has no import of `diff.ts`'s `differentiate`,
only the smart-constructor helpers used by diff rules generally.

### Per-rule discrete-order discipline

For every rule with a non-z order parameter (`n` in `Polygamma`,
`ν` in `BesselJ`, `s` in `Polylog`, etc.), the rule checks whether
that parameter depends on `wrt` and refuses (`null`) if it does. The
`∂/∂ν J_ν(z)` formula involves Polygamma and is closed-form, but
implementing it adds new edges to the dispatcher graph — a separate
bead's territory. Honest scope: in v0.1, special-function order
parameters are constants in `wrt`.

### Smart constructors exported, not duplicated

The seven smart-constructor helpers in `diff.ts` could have been
duplicated in `special-functions.ts`. The export-and-reuse path costs
two characters (`export` keyword) and one import line in
`special-functions.ts`; duplication would have created two
implementations of `mkTimes` that could drift silently. The
constructors are package-internal — they don't appear in
`packages/cas-core/src/index.ts`'s public re-exports.

### Wolfram encoding for list-parameter heads

`HypergeometricPFQ[{a₁,…,aₚ}, {b₁,…,b_q}, z]` and
`MeijerG[{{a_top}, {a_bot}}, {{b_top}, {b_bot}}, z]` are the canonical
Wolfram encodings, well-known to anyone who has read Mathematica's
Functions site (the load-bearing reference for problem 13's reduction
tables). Following the convention is irresistible to the TS expert
who already knows it; matching it lets a future port lift formulae
verbatim. The encoding lives inside `expression.args` as `list` /
`list-of-list` Values; no new primitive kind is added to the value
protocol.

## Frictions surfaced

### Ad-hoc rational test failed because the test author wrote `1/2` as `expr("/", [1, 2])`

The first attempt at the rational-order Bessel test wrote
`ν = expr("/", [int(1n), int(2n)])`. That is *not* a `rational` Value
— it's an `expression` with the elementary `/` head. My `intShift`
helper, dispatching on Value kind, falls through to the symbolic
branch and emits `expr("-", [expr("/", [...]), int(1n)])`. The test
expected `rat(-1n, 2n)`. Failure surfaced the encoding distinction:
`rat(1n, 2n)` is the canonical rational; `expr("/", [int(1n), int(2n)])`
is two integers under the elementary division operator. Both are
mathematically the same number; the AST distinguishes them, and
`intShift` honours the distinction. Fixed the test to use `rat(1n, 2n)`.
The lesson is reusable: when testing a rule that branches on Value
kind, exercise the *kind* of the input, not its mathematical value.

### "28 heads" was an arithmetic slip in the first ADR draft

The DESCRIPTION.md vocabulary list contained 27 heads; my first ADR
draft said 28. Caught at the test-writing step (the test enumerates
the heads explicitly and asserts `length === 27`). Fixed the ADR and
the test in lockstep.

### The pre-existing kind-literal drift warning is unrelated

`bun run check:quick`'s convention phase warns about 161 raw
kind-literal sites in `bench/`, `packages/ode-core/`, and
`scripts/demo-scope.ts`. These are pre-existing (pre-date this shard)
and not introduced by hv0.2's diff. The warning is non-fatal; the
4-phase summary is `4 passed, 0 skipped, 0 failed`.

## Acceptance

- Bead `hv0.2` claimed at session start; closed at session end.
- ADR-0023 written and accepted.
- `packages/cas-core/src/special-functions.ts` shipped (~440 LOC
  including comprehensive literate prose).
- `packages/cas-core/src/diff.ts` extended (smart-constructor exports
  + special-function fall-through; ~10-line surgical edit).
- `packages/cas-core/src/index.ts` re-exports the new surface.
- `packages/cas-core/test/special-functions.test.ts` shipped with 45
  tests; all green.
- Existing 78 tests in `packages/cas-core/test/diff.test.ts` pass
  byte-identically.
- `tools/cas-diff` --test hook extended with end-to-end dispatcher
  checks; existing 8-corpus FD cross-check unchanged. Goldens grew
  by 14 (43 → 57); regenerated and oracle-verified green.
- `bun run check` green: 65 phases, 0 failed, 5 skipped (tier-3
  benches as usual).
- Documentation lockstep: `tools/cas-diff/README.md`, main
  `README.md`, this worklog shard, ADR-0023.

## Pointers

- Design ADR: `docs/adr/0023-cas-core-special-function-vocabulary.md`.
- Vocabulary + dispatcher: `packages/cas-core/src/special-functions.ts`.
- Diff fall-through: `packages/cas-core/src/diff.ts` `diffExpression`
  (~6 lines added) + smart-constructor exports.
- Tests: `packages/cas-core/test/special-functions.test.ts` (45 tests).
- Goldens: `tools/cas-diff/goldens/` (14 new files; the
  PascalCase-head ones are the differentiable subset, the deferred
  ones round-trip through the boundary-tag refusal).
- Campaign log: `../tstournament/ts-bench-infra/problems/13-meijer-g/
  WORKLOG-13.md` (this shard's tournament-side counterpart).

## Next pickup

The campaign now has 6 of 12 child beads closed (`hv0.1` ✓ bigfloat,
`hv0.2` ✓ AST extension, `hv0.3` ✓ pFq, `hv0.5` ✓ Slater,
`hv0.7` ✓ arb-prec quadrature, `hv0.8` ✓ contour). Open and unblocked:

* `hv0.4` — `bench/hypergeometric-pfq` tier-graded battery (no
  upstream beyond `hv0.3` ✓).
* `hv0.6` — `packages/meijer-core` Adamchik–Marichev + Roach symbolic
  dispatch (depends on `hv0.2` ✓; **now unblocked**).
* `hv0.9` — `packages/meijer-core` Braaksma asymptotic +
  hyperasymptotic (depends on `hv0.1` ✓ and `hv0.2` ✓; **now
  unblocked**).

Recommended next: **`hv0.6`** — the symbolic dispatcher consumes the
vocabulary just shipped and is the load-bearing layer for problem 13's
Tier A / B (the symbolic-reduction tiers; Wolfram's Functions-site rule
table). Alternatively `hv0.9` (asymptotic) is the algorithmic sibling
and equally unblocked. Follow-up beads worth filing: arbprec `evalAt`
per head (the pFq-recursive evaluator referenced in DESCRIPTION.md
Part 1 §2 that v0.1 deferred); the `WhittakerM`/`WhittakerW` /
`ParabolicCylinderD` / `LegendreP`-and-friends diff rules (the
ADR-0023 deferred subset).
