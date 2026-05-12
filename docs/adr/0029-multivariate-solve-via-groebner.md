# ADR-0029 — Multivariate `solve` via Gröbner basis (Buchberger + FGLM + shape lemma)

**Status:** Accepted (2026-05-10)
**Bead:** `scientist-workbench-x8d`
**Epic:** `scientist-workbench-98a` (solve-suite-v1)
**Depends on:** ADR-0017 (solution-set shape), ADR-0018 (`Root[poly, k]`),
  ADR-0019 (solve-bench discipline), ADR-0028 (bench migration to corpus).
**Supersedes:** the placeholder `solve/multivariate-non-zero-dim` catch-all
  in `packages/solve/src/dispatch.ts` for zero-dimensional ideals.

## Context

`tools/solve` shipped in worklog 054 (bead `77b`) handling linear systems
(Bareiss over ℚ) and univariate polynomial inputs (factor-and-radicals
through `factorRatQ` + Cardano + Ferrari + `Root[poly, k]` for irreducible
deg ≥ 5 with all-real roots). Worklog 055 added a single-head
transcendental invert layer (`Sin[x] == c`, `Exp[x] == c`, …). Every
*multivariate-and-nonlinear* input refused with
`solve/multivariate-non-zero-dim` regardless of whether the ideal was in
fact zero-dimensional — the tool had no Gröbner-basis substrate, and the
refusal class was acting as a placeholder.

This ADR codifies the design decisions behind the substrate and the
dispatch lane that fills that placeholder. The companion research note
[`docs/ground-truth/groebner/RESEARCH-NOTE-x8d.md`](../ground-truth/groebner/RESEARCH-NOTE-x8d.md)
records the audit of primary sources (Buchberger 1979, Giovini-Mora-
Niesi-Robbiano-Traverso 1991, Faugère-Gianni-Lazard-Mora 1993, Becker-
Mora-Marinari-Traverso 1994, CLO Ch.2 + Ch.5) and the seven algorithmic
choices implemented; this ADR enshrines those choices and their
interaction with the existing protocol.

## Decision

### 1. New substrate package `packages/groebner/`

A self-contained substrate package, depending only on `cas-core`,
`poly-factor`, `alg-num`, `real-roots`, and `protocol`. The public API:

```ts
// monomial-order.ts
interface MonomialOrder { kind: "lex"|"drl", vars, compare }
function lexOrder(vars): MonomialOrder
function drlOrder(vars): MonomialOrder

// multidiv.ts
function leadingTerm(p, order): Monomial<Rat>|null
function polyMultiDivRem(f, divisors, order): { quotients, remainder }
function polyNormalForm(f, divisors, order): Poly<Rat>

// buchberger.ts
function buchbergerReduced(polys, order):
  { basis, nPairs, warnings }
function isZeroDimensional(basis, vars, order): boolean
function sPolynomial(f, g, order): Poly<Rat>

// fglm.ts
function fglm(gDrl, vars): readonly Poly<Rat>[]   // returns lex GB

// shape-extract.ts
function detectShapePosition(gLex, vars, lex): ShapeBasis|null
function extractShapeSolutions(gLex, vars):
  { kind: "success", solutions }
  | { kind: "refusal", reasonClass, detail }

// solve-groebner.ts (top-level)
function solveGroebner(polys, vars):
  { kind: "success", vars, solutions, warnings, nPairs }
  | { kind: "refusal", reasonClass, detail, basis? }
```

`cas-core` is **not modified**. The existing `Poly<Rat>` substrate
(canonical-form-fixed lex-over-alphabetised-vars term order) is the
underlying data type; the new `MonomialOrder` interface is the
caller-supplied comparator that Buchberger and FGLM consult instead of
relying on `terms[0]`.

### 2. Seven algorithmic choices (canonical per RESEARCH-NOTE §2)

Restated here for ADR-canonicality. All seven are implemented as the
research note prescribes, no deviations.

**§2-A — representation.** `Poly<Rat>` reused. New monomial-order
comparators in `packages/groebner/src/monomial-order.ts`. Leading term
under any non-cas-core order is computed by linear scan
(`leadingTerm(p, order)`); never `terms[0]`. Multivariate division uses
the new `polyMultiDivRem(f, divisors, order)` (CLO Ch.2 §3 Theorem 3).

**§2-B — sloppy sugar pair selection** (Giovini-Mora-Niesi-Robbiano-
Traverso 1991). Sugar of an input polynomial = total degree; sugar of an
S-polynomial = `max(sug(f) − deg(LM(f)) + deg(lcm), …)`. Pairs popped by
ascending sugar; tiebreak deterministic via lex-on-`(i, j)` with `i < j`.

**§2-C — Gebauer-Möller pair pruning.** Buchberger Criterion 1 (coprime
LM) checked first as a short-circuit; Criterion 2 (chain criterion) in
the strict Gebauer-Möller 1988 / Becker-Weispfenning 1993 §5.5
formulation — the strict-inequality conditions on `lcm(LM(f),LM(h))` and
`lcm(LM(g),LM(h))` are load-bearing. Without them the rule over-prunes.

**§2-D — interreduction always.** After the Buchberger main loop
terminates, the basis is interreduced to the unique reduced form
(CLO Ch.2 §7 Theorem 5). Two passes: discard polys whose LM is divisible
by another's, then tail-reduce each survivor against the rest, then
monicise, then sort by leading monomial in descending order. The output
of `tools/groebner-basis` is therefore canonical *for the requested
order*.

**§2-E — zero-dimensionality test via pure-power LMs.** CLO Ch.5 §3
Theorem 6: the ideal is zero-dimensional iff every variable has a pure
power as the leading monomial of some basis element. Ordering-
independent (Macaulay's basis theorem, CLO Ch.2 §4); we test on the DRL
basis we already have in hand. Failure ⟹ refuse with
`solve/multivariate-non-zero-dim`, payload includes the DRL basis.

**§2-F — FGLM + shape-lemma extraction.** Faugère-Gianni-Lazard-Mora
1993 NewBasis converts the DRL basis to a lex basis in O(n · |B|³)
where `B(G)` is the natural basis. Becker-Mora-Marinari-Traverso 1994
shape-position check identifies whether the lex basis has the form
`{g_n(x_n), x_{n-1} − h_{n-1}(x_n), …, x_1 − h_1(x_n)}`. On success,
factor `g_n` via `factorRatQ` and dispatch each irreducible factor:
deg ≤ 4 via radicals (`linearRoot` / `quadraticRoots` / `cubicRoots` /
`quarticRoots` in cas-core), deg ≥ 5 via `Root[poly, k]` (alg-num) for
real roots only, refuse with `solve/complex-roots-not-yet-named` for
factors with complex roots. Per-root `h_i` evaluation is by Horner.

**§2-G — deferred.** F4 / F5, RUR (Rouillier 1999), parametric solving,
positive-dimensional handling, complex algebraic naming. Each is a
future bead; v0.1 refuses honestly.

### 3. Q1 — `tools/groebner-basis` ships standalone

Per Q1 of the research note's open questions, the orchestrator's call
was *ship*: a standalone `tools/groebner-basis` exposes the substrate
directly, conforming to the corpus bench at
`scientist-workbench-corpus/benchmarks/groebner-basis/`. Wire format
matches `run-candidate.ts`'s declared contract:

- input: `record { polys: list<expression>, vars: list<symbol>,
  order: string }` with `order ∈ { "lex", "degrevlex" }`.
- happy-path output: `record { basis, order, vars, n_pairs, warnings }`.
- boundary refusals: `tagged "groebner-basis/<class>"` with classes
  `empty-input`, `empty-vars`, `parametric`, `non-polynomial`. Payload
  is `record { detail: string }`.

The tool is a thin wrapper: parse expressions to `Poly<Rat>`, classify
refusals (foreign-vocabulary / parametric / empty-input / empty-vars),
run `buchbergerReduced(polys, order)`, render `Poly<Rat>` results back
to expression Values via `polyToValue`. Phase 3 grades 80/80 on the
corpus bench.

### 4. Q2 — shape-lemma failure refuses immediately, no fixed-shift retry

Per Q2 of the research note. A v0.1 that *honestly refuses* on shape-
lemma failure is more aligned with CLAUDE.md Rule 8 (honest scope) than
one that silently muddles through with a non-generic fixed shift. The
class string is `solve/shape-lemma-failure`; the payload includes the
lex basis as `groebner_basis` for the caller's introspection. A future
bead may add a deterministic multi-shift fallback (option 3 in the
research note's Q2) once the bench surfaces shape-failure frequency on
real data.

### 5. Dispatcher integration

`packages/solve/src/classify.ts` gains a `ClassifiedMultivariatePoly`
verdict (kind `"multivariate-poly"`) and `dispatch.ts` gains a
`dispatchMultivariatePoly` arm. The `multivariate-non-zero-dim`
catch-all that previously fired for *every* nonlinear multivariate
input now only fires for ideals the Gröbner stack determines to have
positive Krull dimension. Three new refusal classes propagate from the
substrate to the tool layer:

| Class                                  | When emitted                                                            | Payload                                |
|----------------------------------------|-------------------------------------------------------------------------|----------------------------------------|
| `solve/multivariate-non-zero-dim`      | DRL basis fails the pure-power LM test                                  | `groebner_basis, dimension_estimate`   |
| `solve/shape-lemma-failure`            | Lex GB exists but is not in shape position; no retry per Q2             | `groebner_basis`                       |
| `solve/complex-roots-not-yet-named`    | `g_n` has irreducible deg ≥ 5 factor with complex roots                 | (degree, polynomial, complex_count)    |

`solve/complex-roots-not-yet-named` is shared with the univariate-poly
lane (ADR-0017's existing roster); ADR-0018 names real algebraic
numbers only. The other two are new this ADR.

### 6. Determinism contract

Symbolic tier per ADR-0015 default. Every operation is BigInt rational;
no float, no FFI, no platform-dependent ordering. Output is bit-
identical cross-platform forever, given the same input polynomials and
the same declared variable list. Sources of potential non-determinism
are explicitly neutralised:

- **Pair queue** sorts by sugar with deterministic `(i, j)` lex
  tiebreak. No stable-sort reliance.
- **Basis arrival order** is a deterministic function of the pair
  queue.
- **Interreduction** sorts by leading monomial in descending order;
  total order on monomials guarantees uniqueness.
- **FGLM lex traversal** uses the "minimal-variable child" rule (CLO /
  FGLM 1993 §3): from a monomial `m`, generate children `vars[i] · m`
  with `i ≥ minChildIdx`. Each monomial reached exactly once.
- **Roots of `g_n`** ordered per ADR-0018: rational < algebraic;
  algebraic by `Root[poly, k]` k-index ascending.

### 7. Tier-conditioned standard flag set

The tool inherits the standard flag set from `defineTool` (ADR-0011):
`--schema`, `--examples`, `--invariants`, `--platform-fingerprint`,
`--test`. Symbolic tier ⟹ no `--precision`, no `platform` field in
provenance. Default `def.fn` is invoked once per input; no caching at
this level (the workbench's `runMemoized` from `compose` handles input-
hash-keyed caching uniformly across all tools).

## Examples

### Happy path: (x²+y, xy+1) under lex with x>y

The classic CLO Ch.2 §6 Example 1. Reduced lex GB is
`{x − y², y³ + 1}`. Note `y³ + 1 = (y + 1)(y² − y + 1)` factors over ℚ.
The shape-extracted solutions (one rational + one irreducible quadratic
factor's two complex conjugate roots) are:

- `y = −1, x = 1` (rational)
- `y = (1 ± i·√3)/2, x = y²` (refused: complex roots not yet named)

In v0.1 the second factor's complex roots trigger
`solve/complex-roots-not-yet-named`. Lift to happy-path comes when
`alg-num` learns to name complex algebraic numbers (future bead).

### Happy path: (x² − 1, y − x)

Two solutions: `(x = 1, y = 1)` and `(x = −1, y = −1)`. Shape position
holds. Verified by `tools/solve --test`'s probe 5.

### Refusal: `x · y = 1` (positive-dim)

Single equation in two variables; the ideal `⟨xy − 1⟩` has Krull
dimension 1. DRL GB is `{xy − 1}`; LM is `xy`. Neither `x^k` nor
`y^k` appears as an LM. Zero-dim test fails ⟹
`solve/multivariate-non-zero-dim`. Verified by `tools/solve --test`'s
probe 4.

### Refusal: inconsistent system

`(x − 1, x − 2)` ⟹ DRL GB is `{1}` (the unit ideal). Zero-dim test
holds vacuously. Solution set is empty (`completeness: "complete"`).
Verified by `tools/solve --test`'s probe 6.

## Why these specific shape choices

**Why a separate `packages/groebner/` rather than extending `packages/
solve/`?** The Gröbner substrate is reusable beyond `tools/solve` — it
backs the standalone `tools/groebner-basis` and any future tool that
needs ideal-level computations (radical computation, ideal membership,
elimination). Mirrors the discipline of `packages/poly-factor` (the
substrate) vs. `tools/poly-factor` (the wrapper).

**Why DRL for Buchberger and lex for FGLM output?** DRL minimises
coefficient swell on the vast majority of benchmark systems (CLO
Ch.2 §9 p.114). Lex has the elimination property — the last variable's
univariate equation appears in the basis — which is exactly what shape-
lemma extraction consumes. Computing the DRL basis first and converting
via FGLM is dominantly cheaper than running Buchberger directly under
lex (FGLM 1993 §1).

**Why the strict Gebauer-Möller form of Criterion 2?** The naive
"`LM(h) | lcm(LM(f),LM(g))` ⟹ prune" form over-prunes — there are
known small examples (Becker-Weispfenning 1993 §5.5 Lemma 5.5.6) where
the loose rule discards essential pairs and the algorithm produces a
*non-Gröbner* "basis." The strict-inequality conditions on the third
polynomial's lcms are load-bearing.

**Why refuse on shape-lemma failure rather than retry?** v0.1 is
honest. A non-generic fixed shift is *not* generic; the Becker-Mora
theorem is about *generic* shifts, and the cases where a single fixed
shift fails are precisely the cases where the ideal has internal
structure aligned to that shift. A deterministic multi-shift retry is a
future bead's scope (option 3 of the research note's Q2); the v0.1
refusal class lets the bench surface the frequency of this case.

**Why a tagged refusal envelope for boundary cases rather than
`ToolError`?** Per ADR-0003: `ToolError` is reserved for *malformed
input*. A well-formed polynomial system with positive Krull dimension
is *not* malformed input — it's a perfectly valid ideal that happens
not to fall in the v0.1 capability set. Tagged refusal is the honest
boundary; the agent can branch on the class string and dispatch
elsewhere.

## Relationship to existing ADRs

- **ADR-0003** (output-error patterns): the three refusal classes
  follow the `tagged "<tool>/<class>"` boundary pattern. `ToolError`
  for malformed input only.
- **ADR-0004** (schema as first-class type): all schemas declared via
  `S.record(...)`, `S.list(...)`, `S.kind(...)`. The output schema is
  `S.any()` for the same reason every solve-tier tool uses `S.any()` —
  the discriminated union shape narrows poorly under TS inference; the
  goldens enforce it instead.
- **ADR-0008** (cas-core ring-generic): the substrate uses
  `Field<Rat>` (`RAT_RING`) throughout. No ring is *added*; `Rat` is
  the only coefficient type for v0.1.
- **ADR-0010** (tool module shape): the trailing
  `if (import.meta.main) void runTool(def)` rule applies. The
  `groebner-basis` tool is import-side-effect-free.
- **ADR-0011** (typed flags): no tool-specific flags. Inherits the
  standard set.
- **ADR-0012** (composition layer): `tools/solve`'s
  `dispatchMultivariatePoly` calls `solveGroebner` *in-process* via
  the package import (not via `wb.run("groebner-basis", …)`). The
  in-process surface is the right answer for substrate-level calls;
  the spawn-per-hop floor would be wasteful for the per-pair Buchberger
  inner loop. `tools/groebner-basis` is the subprocess-callable wrapper
  for callers who need the seven-artefact surface (corpus bench,
  external composition).
- **ADR-0015** (determinism tier): symbolic tier; bit-identical
  cross-platform forever. No `numerical: true`, no `arbprec: true`,
  no `nondeterministic: true`.
- **ADR-0017** (solution-set shape): the multivariate-poly lane emits
  ADR-0017's `record { vars, solutions, completeness, warnings }`
  shape. `branches` is always `[]` (zero-dim solutions are discrete).
  `completeness` is always `"complete"` for happy paths.
- **ADR-0018** (`Root[poly, k]`): real roots of irreducible deg ≥ 5
  factors of `g_n` are named via `Root[poly, k]` per ADR-0018. Complex
  roots refuse with `solve/complex-roots-not-yet-named`.
- **ADR-0019** (solve-bench discipline): `bench/groebner-basis`
  follows the four-invariant Buchberger correctness certificate (shape
  + bidirectional ideal containment + S-pair reduction). No
  byte-equality with a reference; mathematical-invariant verification
  per §1.

## What this ADR does not do

- **Positive-dimensional ideals.** Refuse with
  `solve/multivariate-non-zero-dim`; the payload's `groebner_basis`
  field carries the DRL basis for downstream introspection. Krull
  dimension itself is *not* computed (would require a separate Hilbert
  series or primary decomposition substrate).
- **Complex algebraic numbers.** Real roots only via `Root[poly, k]`
  (ADR-0018); complex naming requires planar isolation (future bead).
- **Parametric coefficients.** Captured by `solve/parametric-non-
  trivial` in `packages/solve/src/classify.ts`; the Gröbner stack
  itself only sees ideals over ℚ.
- **F4 / F5 / RUR.** All deferred per RESEARCH-NOTE §2-G.
- **Coefficient-swell guard.** No threshold-based abort in v0.1
  (`solve/coefficient-swell` is reserved as a future class). The
  research note §3 documents this; v0.1 ships with no swell guard,
  measurement-driven default to be set after bench surfaces
  swell-prone cases.
- **Multi-shift retry on shape-lemma failure.** Q2 option 3 deferred.

## Acceptance for this ADR

- This document committed under
  `docs/adr/0029-multivariate-solve-via-groebner.md`.
- `packages/groebner/` and `tools/groebner-basis/` shipped.
- `tools/solve` extended with the multivariate-poly lane.
- `bun run check` passes (14/14 phases).
- `bash scripts/bench-grade.sh groebner-basis` grades 80/80
  (PYTHONPATH set so snap-Bun's spawned python3 finds the user-
  installed sympy package — see worklog 087 for the friction).
- Worklog shard 087 lands.
- README catalog row for `tools/groebner-basis` and File-layout row
  for `packages/groebner/` land in the main `README.md`.

## Sources

- **Buchberger 1979.** "A Criterion for Detecting Unnecessary
  Reductions in the Construction of Gröbner Bases." Local mirror:
  `docs/ground-truth/groebner/buchberger-1979-two-criteria.pdf`.
  The two pruning criteria.
- **Giovini-Mora-Niesi-Robbiano-Traverso 1991.** "One sugar cube,
  please." Local mirror: `docs/ground-truth/groebner/
  giovini-mora-niesi-robbiano-traverso-1991-sugar-cube.pdf`. Sugar
  strategy and sloppy variant.
- **Faugère-Gianni-Lazard-Mora 1993.** "Efficient Computation of Zero-
  Dimensional Gröbner Bases by Change of Ordering." Local mirror:
  `docs/ground-truth/groebner/faugere-gianni-lazard-mora-1993-fglm.pdf`.
  The FGLM order-conversion algorithm.
- **Becker-Mora-Marinari-Traverso 1994.** "The shape of the Shape
  Lemma." Local mirror: `docs/ground-truth/groebner/
  becker-mora-marinari-traverso-1994-shape-lemma.pdf`. Shape-position
  characterisation.
- **Cox-Little-O'Shea 4th ed.** Ch.2 §2-§8 (orderings, S-polynomials,
  Buchberger, reduced GB), Ch.5 §3 Theorem 6 (Finiteness Theorem).
- **Gebauer-Möller 1988.** "On an Installation of Buchberger's
  Algorithm." Pair-pruning bookkeeping.
- **Becker-Weispfenning 1993.** "Gröbner Bases." §5.5 Algorithm
  5.5.7 — the strict Gebauer-Möller form used here.
- **RESEARCH-NOTE-x8d.md** at
  `docs/ground-truth/groebner/RESEARCH-NOTE-x8d.md`. The Phase 1
  audit of primary sources and the seven decisions implemented here.
- **`benchmarks/groebner-basis/`** in
  `scientist-workbench-corpus/`. Phase 2a bench. The four-invariant
  certificate verifier (`verify.py` + `verify.ts` lockstep) is the
  ground-truth contract this ADR's tool implements against.
