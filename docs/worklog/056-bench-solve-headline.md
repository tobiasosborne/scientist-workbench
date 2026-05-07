# 056 — `bench/solve` headline bench (yq2)

**Date:** 2026-05-07
**Status:** complete
**Branches:** main
**ADRs:** applies ADR-0019 (solve-bench-discipline; the headline
instantiation), ADR-0017 (solution-set shape), ADR-0003 (output /
error patterns). No new ADRs.
**Issues closed:** scientist-workbench-yq2.

## Context

The headline bench for `tools/solve` per the bead description: 20
hand-curated Mathematica-v1 bank cases + 80 stratified random spanning
the four dispatch lanes the v0.1 dispatcher implements
(linear, univariate-poly, multivariate-zero-dim — refusal-class —,
transcendental-univariate). This is the §1-§7 first solve-tier
instantiation of ADR-0019 — `linsolve-q` and `poly-factor-q` are
substrate benches; this one tests the dispatcher composing them.

The bench follows `bench/poly-factor-q`'s template (specification +
verifier + reference + mutation-prove harness, no `run-candidate.ts`
this shard — that's a follow-up after the SymPy reference reaches
end-to-end equivalence with `tools/solve`'s output, mirroring the
poly-factor-q deferral pattern).

## What changed

### Spec docs — `bench/solve/{PROMPT,DESCRIPTION,REFERENCES}.md` + `golden/verifier_protocol.md`

- **`PROMPT.md`** (~13 KB) — agent-facing spec: 4-lane dispatch
  surface, refusal-class roster, I/O contract (text-form eqs/vars
  with bindings as expression strings), invariants per lane, six-tier
  test grid (`v1-bank.handled` 15, `v1-bank.refused` 5,
  `rand.linear` 15, `rand.univariate-poly` 25,
  `rand.multivariate-zero-dim` 25, `rand.transcendental-univariate` 15
  → 100 total), triple-witness oracle protocol, hard constraints.
- **`DESCRIPTION.md`** (~7 KB) — per-lane algorithm specs (linking to
  the substrate benches), 4-lane verifier-dispatch logic, mutation-
  prove harness rationale.
- **`REFERENCES.md`** (~6 KB) — primary algorithm citations per lane
  (Bareiss 1968 for linear, Berlekamp + vanHoeij + Cardano/Ferrari
  for univariate-poly, Fateman 1991 for the refusal-class motivation),
  oracle bridge documentation, ADR-0017 + ADR-0019 cross-refs.
- **`golden/verifier_protocol.md`** (~5 KB) — exact tolerances per
  check, per-lane dispatch rules, `expected.lane` semantics.

### `bench/solve/reference/solve_reference.py`

SymPy-backed reference implementation mirroring `tools/solve`'s
output envelope (ADR-0017 record OR `tagged "solve/<class>"`).
Three lanes implemented + refusal classifier:

- **Linear** — uses SymPy's `linsolve(A, b)`; renames free parameters
  to `t_0, t_1, …` (matching the workbench's bareiss output naming).
- **Univariate-poly** — `Poly.factor_list()` + `all_roots(multiple=True)`
  preserving multiplicity-as-repetition. Refuses on any irreducible
  factor of degree ≥ 5 with `solve/high-degree-irreducible`.
- **Transcendental** — pattern-matches `head(arg) = c` for
  `head ∈ {exp, log, sin, cos, tan, sinh, cosh, tanh, abs}` with
  `arg` linear in `x`; emits the v0.1 9-head invert table's
  branched solutions (sin → 2 branches, cos → 2 branches, tan → 1
  branch, abs/cosh → 2 branches, others → 1).
- **Refusal classifier** — extra free symbols ⇒ `parametric-non-trivial`;
  non-polynomial atoms ⇒ `foreign-vocabulary`; multivariate degree>1 ⇒
  `multivariate-non-zero-dim`; constant equations ⇒ `constant-equation`.

### `bench/solve/golden/verify.py`

4-lane dispatch verifier per ADR-0019 §1 + §2 + §5. The verifier
dispatches by `expected.lane` (set at golden-generation time by the
classifier in `generate.py`), not by `candidate.kind` — that's the
pattern that catches "lied-about-scope" bugs.

- **Linear lane** (5 checks): shape, exact_satisfaction (substitute
  bindings symbolically and verify residue ≡ 0 in ℚ),
  free_var_basis (10 random rational tuples per branch dimension,
  capped at 50 total samples), rank_consistent (Rouché-Capelli;
  `|branches| = n_vars - rank(A)`), completeness_correct.
- **Univariate-poly lane** (4 checks): shape, each_root_satisfies
  (`simplify(p.subs(x, root)) == 0`), count_with_multiplicity
  (`Σ deg(f_i)·m_i`), distinct_roots_match (bipartite-matching
  vs SymPy `Poly.all_roots`).
- **Transcendental lane** (3 checks): shape, branched_substitution_cube
  (every integer tuple in `[-3, 3]^n` instantiated and substituted;
  `|residual| < 1e-12 · max(1, |lhs|, |rhs|)`), completeness_grid
  (1D NumPy scan trimmed to *cube reach* — the max `|candidate(tup)|`
  across all solutions × tuples — with brentq refinement to <1e-12
  and pole filtering on `|f(root)|`; every in-reach grid root must
  match within `1e-6` of a candidate-instantiated tuple).
- **Refusal lane** (2 checks): tag_matches (exact string equality;
  must start with `"solve/"`), payload_predicate (`payload.detail`
  non-empty string; loose predicate per ADR-0019 §5).

### `bench/solve/golden/test_mutations.py`

ADR-0019 §4 mutation-prove harness with 8 perturbations (exceeds the
required ≥ 5). Each demonstrates RED on the expected check:

1. `lied_about_scope` (multivariate-non-zero-dim returns `kind=ok` ⇒
   shape).
2. `linear_sign_flip` (negate one binding's value ⇒
   exact_satisfaction).
3. `dropped_multiplicity` (return one solution for `(x−1)²=0` ⇒
   count_with_multiplicity).
4. `missed_branch_sin` (drop the second branch of `sin(x)=0` ⇒
   completeness_grid).
5. `wrong_period_tan` (`2π·t_0` instead of `π·t_0` ⇒ completeness_grid).
6. `inconsistent_returned_unique` (spurious unique solution for
   `x+y=1, x+y=2` ⇒ exact_satisfaction + rank_consistent).
7. `underdet_dropped_branches` (clear branches list, instantiate `t_0=0`
   ⇒ rank_consistent).
8. `wrong_refusal_tag` (`solve/foreign-vocabulary` instead of
   `solve/multivariate-non-zero-dim` ⇒ tag_matches).

GREEN baseline 8/8 + RED mutations 8/8 ⇒ verifier is sensitive.

### `bench/solve/golden/generate.py`

Seeded reproducible generator (SEED = 20260507). Produces
`inputs.json` (100 cases) + `expected.json` (per-case
`expected.lane` and refusal `tag` where applicable) + `oracle_log.json`
(triple-witness consensus per case).

- **Hand-curated 20** — 15 v1-handled cases (linear small/medium,
  univariate quadratic/cubic/quartic/multiplicity, transcendental
  simple) + 5 v1-refused (Fateman cos+cos+cos, Fateman sin(6x)/sin(x),
  bilinear x·y=1 capability-pending, deg-5 Eisenstein irreducible
  permanent, constant equation).
- **Stratified random 80** — linear 15 (mixed shapes 1×1 → 4×4 with
  under/over/inconsistent variants), univariate-poly 25 (degrees
  2-10, mix of fully-reducible / partially-reducible / multiplicity ≥ 2,
  ~1/5 of degree≥5 cases inject an Eisenstein quintic factor to
  exercise the refusal path), multivariate-non-zero-dim 25 (conic
  intersections, bilinear pairs, 3-var systems — all v0.1-refusal-
  class goldens; will regenerate to happy-path when groebner ships
  per the bead-yq2 description), transcendental 15 (random
  `head(a·x + b) = c` cycling over the 9-head invert table).

Per-case eager-flush logging (per the user's UX note): each case
prints `[i/100] ✓ id lane consensus time` as it completes.

Triple-witness via `bench/_corpus/oracle/{wolfram, sympy_bridge,
agreement}.py` (P0-6 substrate). For refusal cases the consensus
classification distinguishes "permanent" (Wolfram + SymPy also
refuse / produce only a conditional expression) from "capability-
pending" (oracles solve but workbench refuses honestly until the
substrate ships). Wolfram cross-validation via SymPy's
`mathematica_code` printer to avoid fragile text-substitution
translation.

### `README.md`

Solve tool row updated with the bench reference (Law-2 lockstep).

## Why these choices

**Why a 4-lane dispatch verifier (rather than a single check
function).** The four lanes have *categorically different* invariants
— linear's `exact_satisfaction` operates on rational matrix-vector
arithmetic; transcendental's `branched_substitution_cube` runs
numerical evaluation on integer-tuple cubes; refusal's `tag_matches`
is just string equality. Stuffing all four into one `verify` body
would couple unrelated logic and make the per-lane TS-expert reading
of "what does the linear lane check?" require trace-following. The
dispatch-by-lane pattern matches `tools/solve`'s body shape and the
TS expert's mental model of `Solve[]` itself ("linear systems
have ranks; polynomials have roots; transcendentals have branches").

**Why `expected.lane` rather than `candidate.kind` as the dispatch
key.** Catches lied-about-scope. A candidate that returns
`kind="ok"` for a multivariate-non-zero-dim input that should have
been refused fails the *refusal* lane's `shape` check at the kind
mismatch — diagnosed as "lied-about-scope" rather than silently
running through the wrong lane's checks (where it might pass for
trivial reasons). Worklog 052's poly-factor-q `_check_shape_*` set
the precedent.

**Why trim the completeness grid to the cube reach (rather than the
ADR-0019-default `[-50, 50]`).** ADR-0019 §2 specifies `[-50, 50]`
as the grid window, but for `sin(x) = 0` with cube `[-3, 3]^1`, the
candidate's instantiated values cover `[-6π, 6π] ≈ [-18.85, 18.85]`
— roots beyond that are *outside the verifiable region*, not
"missed branches." Trimming to the cube reach (max
`|candidate(tup)|`) is the honest semantics: the cube *defines* what
the verifier can check, and the grid is the completeness audit
*within* that. Documented in `verifier_protocol.md` §"Lane:
transcendental → completeness_grid" and `DESCRIPTION.md` §"Lane:
transcendental".

**Why brentq + pole filter on grid root refinement.** Linear
interpolation between grid samples gives root accuracy ~`grid_step
≈ 0.02`, way looser than `GRID_TOL = 1e-6`. SciPy's `brentq`
refines to <1e-13, but a sign change across `tan`'s pole at `π/2`
is *not* a root — `f(refined_root)` is huge. The pole filter
(`|f(refined_root)| < 1e-6` or it's discarded) keeps tan's actual
zeros and rejects its poles. Without this filter, `tan(x) = 0`
fails completeness_grid spuriously (the verifier's first iteration
caught this).

**Why include 25 multivariate-non-zero-dim cases as
refusal-class goldens at v0.1.** Two reasons:

1. The bead description specifies 25 random multivariate-zero-dim
   cases. The Gröbner stack (`8y8 → fcf → 9du → onh → h56 → x8d → m0m`)
   is open. Today the workbench refuses; tomorrow it solves. Including
   the cases now means the *boundary correctness* is regression-
   checked today, and when groebner ships, regenerating
   `expected.json` flips them from refusal to happy-path with one
   command. Excluding them would be regenerated-from-scratch work.
2. The v0.1 oracle log records each case's consensus classification
   ("wolfram-solved-workbench-refuses-pending" vs "permanent"), so
   the audit trail is honest: "today we refuse honestly; here's the
   capability gap."

**Why no `run-candidate.ts` this shard.** The poly-factor-q precedent:
ship the spec + verifier + reference + mutation-prove first; the
Bun-side adapter to `tools/solve`'s subprocess is a follow-up shard
once the SymPy reference passes 100/100 against itself (which it now
does). The adapter is a small mechanical artefact at that point.

## Frictions surfaced

**SymPy `linsolve` keeps free parameters as the original variable
names.** For `x + y = 3` in `(x, y)`, SymPy returns `(3 - y, y)` —
the free parameter `y` is one of the input variables. The workbench
emits `x = 3 - t_0, y = t_0, branches = [t_0]`. The reference's first
draft kept SymPy's naming, mismatching the workbench shape. Fixed by
detecting "self-mapped" vars (`val == s`) and renaming them to `t_i`,
substituting through the rest of the bindings. Caught at the first
end-to-end run.

**`Abs(x)` head capitalisation.** SymPy's `Abs.__name__` is `'Abs'`
but the v0.1 invert table is keyed lower-case (`'abs'`) per
`packages/solve/src/transcendental.ts`. Fixed by normalising the
lookup via `.lower()` at all four `func.__name__` call sites in the
reference. The remaining 8 trig/exp/log heads are already lower-case
in SymPy, so no other normalisation needed.

**Pole-induced sign changes in tan.** As noted above; documented
in the verifier_protocol.md and `_trans_grid` body comment.

**Generator initially batched all output until end of run.** ~3 min
runtime with no progress signal — pointed out by the user during the
first live-oracle invocation. Fixed by adding per-case
`flush=True` logging (`[i/100] ✓ id lane consensus time`). Lesson:
benches with ~3 min runtimes need progress signal, not just a
completion summary. Followup: any future bench with
multi-second per-case oracle calls should ship with eager-flush
logging from the start.

**Wolfram bridge: text-substitution Python→Mathematica was fragile.**
First draft converted `**` → `^` and `Log(` → `Log[` via string
replace, but didn't close the trailing `)`. Replaced with SymPy's
`mathematica_code(expr)` printer — robust for the full vocabulary.

**Classifier mirroring.** First-pass `classify_lane` returned
"univariate-poly" for `3x + 1` (1 eq, 1 var, parses as poly), but
the workbench's `classifyInput` checks linearity (`total_degree ≤ 1`)
*before* univariate-poly. Fixed to mirror the workbench's order:
transcendental fast path first (1 eq, 1 var, not a poly), then
linearity check, then univariate-poly fallback. Both lanes' verifiers
pass for `3x + 1` (the candidate has the same wire shape), but lane
labelling now matches the workbench.

## Acceptance

- 1 bead closed: `scientist-workbench-yq2`.
- `bench/solve/` package: PROMPT/DESCRIPTION/REFERENCES + golden/
  (verify, generate, test_mutations, verifier_protocol) + reference/
  solve_reference.py.
- 100 cases admitted, 0 dropped (per-tier counts:
  `v1-bank.handled` 15, `v1-bank.refused` 5, `rand.linear` 15,
  `rand.univariate-poly` 25, `rand.multivariate-zero-dim` 25,
  `rand.transcendental-univariate` 15).
- 100/100 pass when reference candidate fed through verifier.
- Mutation-prove: 8 perturbations all RED (>= 5 required by ADR-0019
  §4). GREEN baseline 8/8.
- Triple-witness via `bench/_corpus/oracle/` Wolfram + SymPy; refusal
  cases distinguish "permanent" vs "capability-pending" in oracle_log.
- Main README catalog row updated (Law-2 lockstep).

## Pointers

- Bead `scientist-workbench-yq2`: closed.
- ADR-0019 (`docs/adr/0019-solve-bench-discipline.md`): the bench
  discipline ADR; this is the §1-§7 headline instantiation.
- ADR-0017 (`docs/adr/0017-solution-set-shape.md`): solution-set
  shape; every field exercised across the 100 cases.
- Substrate benches: `bench/linsolve-q` (linear lane verifies the
  same invariants), `bench/poly-factor-q` (univariate-poly lane
  composes the verified factor list).
- Worklogs 050-055: the implementation shards this bench tests
  end-to-end (linsolve-q → poly-factor → poly-roots → solve
  dispatcher → transcendental invert).
- Open follow-up beads: `b55` (transcendental-multibranch upgrade
  for Fateman cases), `m0m`/`x8d`/groebner stack (multivariate
  happy-path; bench regenerates), `iyj` (poly-roots-radical bench),
  `q8q` (real-root-isolate bench), and a future shard for
  `bench/solve/run-candidate.ts` to wire the workbench's actual
  `tools/solve` subprocess output through the bench.

## Commits

(this shard documents the work landed; commit messages will follow
the same Law-2 lockstep pattern when staged.)
