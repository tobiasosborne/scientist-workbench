# 087 — Gröbner substrate + multivariate-poly `solve` lane (`x8d`)

**Date:** 2026-05-10 (one session, Phase 3 of the `x8d` orchestration —
Phase 1 = research note, Phase 2a = corpus bench, Phase 4 = review).
**Beads:** `scientist-workbench-x8d` (P1 — multivariate-polynomial
solve lane via Gröbner basis); `scientist-workbench-ay4u` filed for
follow-up corpus-side work the substrate exposes.
**Lockstep with:**
[`docs/adr/0029-multivariate-solve-via-groebner.md`](../adr/0029-multivariate-solve-via-groebner.md)
(new ADR codifying the seven algorithmic decisions);
[`docs/ground-truth/groebner/RESEARCH-NOTE-x8d.md`](../ground-truth/groebner/RESEARCH-NOTE-x8d.md)
(Phase 1 primary-source audit; canonical for §2-A through §2-G).

## Context

Worklog 054 (bead `77b`) shipped `tools/solve` covering linear systems
and univariate-polynomial inputs; worklog 055 (bead `ii0`) added the
single-head transcendental invert layer. Multivariate nonlinear
systems uniformly refused with `solve/multivariate-non-zero-dim`,
regardless of whether the ideal was actually zero-dimensional —
the refusal was a placeholder for the missing Gröbner-basis
substrate. ADR-0017's roster of refusal classes already named the
class for a future zero-dim → happy-path transition.

Phase 1 of bead `x8d` (research subagent, Phase 2 brief) audited the
primary sources (Buchberger 1979, Giovini-Mora-Niesi-Robbiano-
Traverso 1991, Faugère-Gianni-Lazard-Mora 1993, Becker-Mora-Marinari-
Traverso 1994, Cox-Little-O'Shea Ch.2 + Ch.5) and committed
`docs/ground-truth/groebner/RESEARCH-NOTE-x8d.md`. Seven algorithmic
decisions were made and frozen there:

| § | Decision |
|---|----------|
| A | `Poly<Rat>` reused; new `MonomialOrder` + `polyMultiDivRem` in `packages/groebner/`. |
| B | Sloppy sugar pair selection (Giovini et al. 1991); deterministic `(i, j)` lex tiebreak. |
| C | Buchberger Crit 1 + Crit 2 in strict Gebauer-Möller form (Becker-Weispfenning §5.5). |
| D | Always interreduce; output is the unique reduced GB (CLO Ch.2 §7 Theorem 5). |
| E | Pure-power LM zero-dim test (CLO Ch.5 §3 Theorem 6 + Macaulay's basis theorem). |
| F | FGLM (DRL → lex) + shape-lemma extraction; refuse on shape failure (Q2 option 1). |
| G | Defer F4, RUR, complex algebraic naming, parametric solving, positive-dim handling. |

Phase 2a (corpus migration) shipped `scientist-workbench-corpus/
benchmarks/groebner-basis/` — an 80-case battery with the four-
invariant Buchberger correctness certificate (shape, bidirectional
ideal containment, S-pair reduction). The bench *is* the Phase 3
spec; this shard implements against that contract.

This shard ships **Phase 3**: substrate package, standalone tool, and
solve dispatcher integration. Phase 4 (review) is the orchestrator's.

## What changed

### `packages/groebner/` — new substrate package (1 715 LOC across 7 src files)

```
src/
  monomial-order.ts   247 LOC   MonomialOrder iface, drlOrder, lexOrder, expAdd/Sub/Lcm/Divides
  multidiv.ts         265 LOC   polyMultiDivRem, polyNormalForm, leadingTerm, monomialAsPoly
  buchberger.ts       689 LOC   buchbergerReduced, isZeroDimensional, sPolynomial; sugar; GM pruning
  fglm.ts             704 LOC   DRL → lex via NewBasis (FGLM 1993); minimal-variable child rule
  shape-extract.ts    476 LOC   detectShapePosition, extractShapeSolutions; root dispatch
  solve-groebner.ts   186 LOC   top-level: DRL → zero-dim → FGLM → shape → solutions
  index.ts             73 LOC   public re-exports
test/
  monomial-order.test.ts        DRL/lex axioms; ordering invariants
  multidiv.test.ts              CLO §3 examples; mutation-prove on divisor reordering
  buchberger.test.ts            (x²+y, xy+1) classic + cyclic-3 + S-pair reduce-to-zero
  fglm.test.ts                  DRL → lex correctness on small zero-dim ideals
  shape-extract.test.ts         shape-detect on (x²−1, y−x); refuse on (x²−y², y²−1)
  solve-groebner.test.ts        end-to-end zero-dim → solution count
```

Reuses cas-core's `Poly<Rat>` substrate verbatim — cas-core is **not
modified**. The new monomial-order comparator avoids cas-core's
fixed-canonical-form term order trap: cas-core stores terms in
descending-lex over alphabetised vars (canonical for ring arithmetic);
under any other monomial order the leading term is *not* `terms[0]`.
Every Buchberger leading-term query goes through `leadingTerm(p,
order)` which does a linear scan under the supplied comparator.

Multivariate division `polyMultiDivRem(f, divisors, order)` (CLO
Ch.2 §3 Theorem 3) is the new primitive — cas-core's
`polyDivRemMonic` is univariate-by-design (it expects a principal
variable and treats other variables as coefficient-ring elements;
right for Hensel / Berlekamp, wrong for Buchberger).

Buchberger's algorithm runs with sloppy sugar pair priority (sugar
helps control coefficient swell — Giovini et al. 1991 §3) and
deterministic lex `(i, j)` tiebreak. Pair pruning uses both
criteria: Crit 1 (coprime LM ⟹ S-poly reduces to 0) checked first
as a short-circuit, then Crit 2 (Gebauer-Möller chain criterion in
the strict B/W93 §5.5 formulation — the strict-inequality conditions
are load-bearing, without them the rule over-prunes and the algorithm
can produce a non-Gröbner basis).

Interreduction is unconditional: discard any polynomial whose LM is
divisible by another's (deterministic tiebreak: keep lower-indexed
on equal LM), tail-reduce each survivor, monicise, sort by leading
monomial descending. Output is the unique reduced GB (CLO Ch.2 §7
Theorem 5 — uniqueness theorem).

Zero-dimensionality test scans the DRL basis's leading monomials for
"every variable in `vars` has a pure power as the LM of some basis
element" — CLO Ch.5 §3 Theorem 6 (Finiteness Theorem). The test is
ordering-independent (Macaulay's basis theorem, CLO Ch.2 §4
Proposition 4); we do it on the DRL basis we already have.

FGLM (`fglm.ts`) converts the DRL basis to a lex basis via the
NewBasis algorithm (Faugère-Gianni-Lazard-Mora 1993 §3): enumerate
the natural basis `B(G_DRL)` (monomials not in `LT_DRL(G)`); build
multiplication-by-`x_i` matrices; walk lex monomials in ascending
order via the minimal-variable-child rule (each monomial reached
exactly once); test linear dependence of each new monomial's
normal form against the staircase; barred monomials become LMs of
new lex GB elements. Termination is the staircase reaching size
`|B(G_DRL)| = D(I) = dim_ℚ(ℚ[x]/I)`.

Shape-lemma extraction (`shape-extract.ts`) checks if the lex GB
has the form `{g_n(x_n), x_{n-1} − h_{n-1}(x_n), …, x_1 − h_1(x_n)}`
(Becker-Mora-Marinari-Traverso 1994 §2). On success: factor `g_n`
via `factorRatQ`; dispatch each irreducible factor by degree (deg ≤
4 radicals via cas-core's `linearRoot`/`quadraticRoots`/`cubicRoots`/
`quarticRoots`; deg ≥ 5 real roots via `Root[poly, k]` per ADR-0018;
complex roots refuse with `complex-roots-not-yet-named`). Per-root
`h_i(r)` evaluation by Horner. Per Q2 of RESEARCH-NOTE: shape-failure
refuses immediately (`solve/shape-lemma-failure`); no fixed-shift
retry — a non-generic shift is *not* generic, the v0.1 honest path
is refusal.

### `tools/groebner-basis/` — new seven-artefact tool (449 LOC)

Thin wrapper around `buchbergerReduced` from `@workbench/groebner`.
Schema matches `scientist-workbench-corpus/benchmarks/groebner-basis/
run-candidate.ts`'s declared contract:

- input: `record { polys: list<expression>, vars: list<symbol>,
  order: string }` with `order ∈ {"lex", "degrevlex"}`.
- happy-path output: `record { basis, order, vars, n_pairs, warnings }`.
- boundary refusal: `tagged "groebner-basis/<class>"` with `class ∈
  {empty-input, empty-vars, parametric, non-polynomial}`. Payload
  `record { detail: string }`.

The body parses each input expression to `Poly<Rat>` via
`valueToRatFn` (cas-core), classifies the four refusal cases, then
calls `buchbergerReduced(polys, lexOrder(vars))` or
`buchbergerReduced(polys, drlOrder(vars))`. Output basis renders back
via `polyToValue`. The `--test` hook covers all four refusal classes
plus two happy-path probes (single-monomial ideal already-a-GB; the
classic CLO Ch.2 §6 Example 1).

### `packages/solve/src/{classify,dispatch}.ts` — extended

`classifyInput` gains a `multivariate-poly` verdict; the previous
catch-all "any nonlinear multivariate" path now returns
`{ kind: "multivariate-poly", polys, vars }`. `dispatchClassified`
gains a `case "multivariate-poly"` arm calling
`dispatchMultivariatePoly(polys, vars)` which invokes
`solveGroebner(polys, vars)` from `@workbench/groebner` in-process.
The result folds into ADR-0017's `Solution { bindings, branches: [] }`
shape; `completeness` is `"complete"` (zero-dim ⟹ finite); refusals
propagate the `multivariate-non-zero-dim` / `shape-lemma-failure` /
`complex-roots-not-yet-named` class strings.

### `tools/solve/tool.ts` — extended `--test` hook

Two new probes (5 and 6) for the multivariate-poly lane:
- `(x² − 1, y − x)` — happy path, 2 solutions.
- `(x − 1, x − 2)` — inconsistent, empty solution set.

The existing probe 4 (`x · y = 1`) now hits the live Gröbner-basis
zero-dim test (positive-dim ⟹ refuse) rather than the placeholder
catch-all. Result tag is unchanged: `solve/multivariate-non-zero-dim`.

### Docs in lockstep

- `docs/adr/0029-multivariate-solve-via-groebner.md` — new ADR;
  enshrines the seven algorithmic decisions, the Q1 ship-as-tool
  decision, the Q2 refuse-no-retry decision, and the determinism
  contract (symbolic tier per ADR-0015; bit-identical cross-platform
  forever).
- `README.md` — new catalog row for `groebner-basis`; updated `solve`
  row's refusal class roster (added `shape-lemma-failure`); new
  File-layout entry for `packages/groebner/`; updated `packages/
  solve/`'s description (added the multivariate-poly lane).
- `tools/groebner-basis/README.md` — new per-tool README.
- `packages/groebner/README.md` — new package README; documents the
  public API, the seven decisions, the determinism contract, the
  test surface.
- `tools/solve/README.md` — added the multivariate-poly lane to the
  dispatch summary; expanded refusal-class roster; updated
  out-of-scope list.

## Why these choices

The seven research-note decisions are not relitigated here — see
ADR-0029 §2 for the canonical rationale. Three meta-decisions
deserve calling out:

**Why a separate `packages/groebner/` rather than extending
`packages/solve/`?** The Gröbner substrate is reusable beyond
`tools/solve` — it backs the standalone `tools/groebner-basis` and
any future tool that needs ideal-level computations. Mirrors the
`packages/poly-factor/` ↔ `tools/poly-factor/` discipline.

**Why in-process call (`solveGroebner` import) rather than
`wb.run("groebner-basis", …)` from `dispatchMultivariatePoly`?**
The composition layer (ADR-0012) supports both, and the contract
(schema validation, output validation, provenance) holds byte-
identically on both surfaces by construction. For substrate-level
calls the in-process surface is the right answer: the spawn-per-hop
floor would be wasteful for the per-pair Buchberger inner loop, and
the dispatcher's failure mode is local to `tools/solve`'s process
either way. `tools/groebner-basis` exists for callers (the corpus
bench, external composition) who need the seven-artefact wrapper.

**Why ship `tools/groebner-basis` as a standalone tool?** Per Q1 of
the research note: the corpus bench needed a candidate-side
contract, the seven-artefact overhead was small, and exposing the
substrate at the tool layer gives agent planners (via
`registry-search`) discovery on the GB capability independent of the
`solve` envelope.

## Frictions surfaced

**Friction 1: snap-Bun cannot see system Python's sympy package.**
The corpus bench's verifier is `python3 verify.py`, but
`bash scripts/bench-grade.sh groebner-basis` spawns python3 from
inside snap-confined Bun. The snap mount-namespace presents a
different `/usr/lib/python3.10` than the host system's
`/usr/lib/python3.12`; the system-installed `python3-sympy` package
(at `/usr/lib/python3/dist-packages/sympy`) is invisible inside the
snap mount.

Direct invocation from a non-snap shell (`echo … | python3 verify.py`)
works. Bun-spawn invocation fails with `ModuleNotFoundError: No
module named 'sympy'`. This is the snap-mount-namespace issue noted
in ADR-0001 (originally about `bun` resolution; now extending to
external interpreters).

**Workaround**: install sympy via `pip install --user --break-system-
packages sympy`, which puts it at `~/.local/lib/python3.12/
site-packages/sympy`. The user's home directory IS visible inside
snap. Then export `PYTHONPATH=/home/<user>/.local/lib/python3.12/
site-packages` before running `bash scripts/bench-grade.sh
groebner-basis`. With that, the snap-Bun-spawned Python 3.10 finds
the user-installed sympy 1.14.0 and the verifier runs cleanly.

This is environmental friction; the workbench code is correct and
deterministic. A more durable fix is for the corpus to ship the
verifier as TS (matching the existing `verify.ts` lockstep), or for
the corpus to pass `PYTHONPATH` via `verifier.env` in the manifest
(documenting the snap workaround). Neither is in this shard's scope
("No work in the corpus repo" per orchestrator constraint).

**Friction 2: corpus solve bench has no `multivariate-poly` lane.**
The bench's `verify.ts` knows lanes `{linear, univariate-poly,
transcendental, refusal}`. After x8d the workbench correctly emits
happy-path `record` outputs for ~24 random multivariate-zero-dim
cases that the bench's `expected.json` still pins as `lane:
"refusal"` (per the v0.1-refusal-class regime that pre-dated the
Gröbner stack). Acceptance #5 of the orchestration brief calls for
regenerating `expected.json` so the tier expects happy-path; but
the corpus's `solve_reference.py` *itself* still refuses multivariate
inputs (mirroring the pre-x8d workbench), so even regenerating
wouldn't produce happy-path expecteds — and the verifier has no
lane to check them against if it did.

The honest reading: extending the corpus bench is Phase 2b territory
(corpus-side work) the orchestrator explicitly skipped. I filed
`scientist-workbench-ay4u` to track the corpus-side follow-up:
extend `solve_reference.py` to dispatch multivariate-zero-dim through
SymPy `groebner+solve`, extend `verify.ts` with a `multivariate-poly`
lane (substitute-and-evaluate per ADR-0019 §1), regenerate the
tier's `expected.json`. None of that can ship from this side per the
"No work in the corpus repo" constraint.

The bench grade for `solve` therefore lands at **70/100** post-x8d
(was 94/100 pre-x8d): the 24 mv-tier cases that previously expected
refusal now produce happy-path output and fail tag-match; one
(`rand-mv-005`) actually triggers `solve/shape-lemma-failure` instead
of the expected `solve/multivariate-non-zero-dim`. The 6 transcendental
drift cases (`rand-trans-{002, 004, 006, 008, 009, 013}`) are bead
`3g9x`'s scope and unaffected by my changes — they were drifting
before x8d, still drift after. My changes touched zero code in
`tools/solve`'s transcendental lane.

A purely workbench-side reading would say the regression is virtuous:
the workbench is *more correct* than before (zero-dim cases that
should produce solutions now do), and the regression is in the bench's
ability to grade them. The corpus-side fix lands the verdict back to
≥ 99/100. Filed `ay4u` priority 2.

**Friction 3 (intermittent): FGLM minimal-variable child rule
produces no edge cases on the shape-extract path.** Initial
implementation of `fglm.ts` had an unguarded "saturation" loop
(when staircase reaches size `|B|`, drain remaining frontier) that
would over-bar small monomials in pathological orderings. Resolved
by adding the "if any barred monomial divides cur.exp, skip"
descent-skip check at the head of every frontier-pop. Tests in
`fglm.test.ts` now pass on cyclic-2 (deg = 2) and a hand-curated
3-variable system (deg = 8).

## Acceptance

All acceptance criteria from the orchestrator's brief, modulo the
documented friction:

- **`bun run check`** — 4/4 phases pass (convention-drift, codegen,
  typecheck, bun test). 45 groebner-package tests pass; 1279
  `expect()` calls. Full `bun test` runs 212s on this device (no
  changes from baseline outside groebner).
- **`bun tools/groebner-basis/tool.ts --test`** — 6 probes pass:
  4 refusal classes + 2 happy paths.
- **`bun tools/solve/tool.ts --test`** — 6 dispatch lanes covered
  including the new probes 5 (`(x²−1, y−x)` happy) and 6
  (`(x−1, x−2)` inconsistent).
- **`bash scripts/bench-grade.sh groebner-basis`** — **80/80** cases
  pass with `PYTHONPATH=/home/<user>/.local/lib/python3.12/
  site-packages` (per Friction 1). 400/400 invariants.
- **`bash scripts/bench-grade.sh solve`** — 70/100 cases pass.
  Breakdown: 24 mv-tier cases now correctly emit happy-path; 1
  shape-lemma-failure tag mismatch; 6 transcendental-drift (`3g9x`).
  Filed `ay4u` for the corpus-side fix (Friction 2). My changes
  touched zero code in `solve`'s transcendental lane; the 6 drift
  cases are unaffected.
- **`bun scripts/demo-scope.ts`** — runs end-to-end (no demo
  additions in this shard; the workbench-level demos already cover
  univariate-poly + linear; the multivariate path is exercised
  through `tools/groebner-basis --test` and `tools/solve --test`).
- **ADR-0029** — landed at `docs/adr/0029-multivariate-solve-via-
  groebner.md`.
- **Worklog 087** — this shard.
- **README updates** — main `README.md` catalog row for
  `groebner-basis`, File-layout row for `packages/groebner/`,
  updated `solve` row; `tools/groebner-basis/README.md`,
  `packages/groebner/README.md`, `tools/solve/README.md` updated.

## Pointers

- Substrate: [`packages/groebner/`](../../packages/groebner/).
- Tool: [`tools/groebner-basis/`](../../tools/groebner-basis/).
- Solve dispatcher: [`packages/solve/src/dispatch.ts`](../../packages/solve/src/dispatch.ts)
  — `dispatchMultivariatePoly`.
- Solve classifier: [`packages/solve/src/classify.ts`](../../packages/solve/src/classify.ts)
  — `ClassifiedMultivariatePoly`.
- ADR: [`docs/adr/0029-multivariate-solve-via-groebner.md`](../adr/0029-multivariate-solve-via-groebner.md).
- Research note: [`docs/ground-truth/groebner/RESEARCH-NOTE-x8d.md`](../ground-truth/groebner/RESEARCH-NOTE-x8d.md).
- Corpus bench: `scientist-workbench-corpus/benchmarks/groebner-basis/`
  (DESCRIPTION.md, manifest.toml, run-candidate.ts, golden/).
- Filed beads: `scientist-workbench-ay4u` (corpus-side follow-up for
  the `multivariate-poly` solve-bench lane).
