# 058 — `bench/real-root-isolate` (q8q): VAS-LMQ bench

**Date:** 2026-05-07
**Status:** complete
**Branches:** main
**ADRs:** applies ADR-0019 (bench discipline), ADR-0018 (Root[]
substrate scaffolding). No new ADRs.
**Issues closed:** scientist-workbench-q8q.

## Context

First sub-shard of the algebraic-number branch of solve-suite-v1
(epic `scientist-workbench-98a`). The alg-num branch sequences:
**`q8q` (this shard)** → `rra` (VAS+LMQ TS impl) → `xyt` (Root[poly,k]
type) → `xkz` (lazy interval refinement) → `rti` (subresultant sum/
product) → `6cd` (equality) → `5i2` (primitive-element compression)
→ `iay` (alg-num arith bench) → `yoc` (poly-roots upgrade for
deg ≥ 5). The bench-first ADR-0019 discipline puts q8q ahead of
the implementation.

`tools/real-root-isolate` (planned via bead `rra`) takes a squarefree
`f ∈ ℚ[x]` and returns rational isolating intervals — open `(a, b)`
for irrational roots, singletons `(r, r)` for rational roots. The
algorithmic substrate is Vincent-Akritas-Strzebonski (VAS) continued
fractions with the Local-Max Quadratic (LMQ) bound (Akritas-
Strzebonski-Vigklas 2008). SymPy's `dup_isolate_real_roots`
(BSD-licensed) is the BSD port reference; the future TS implementation
will mirror its structure idiomatically.

## What changed

### `bench/real-root-isolate/` — 37-case 7-tier bench

Files (~30 KB total):

- **`PROMPT.md`** (~7 KB) — agent-facing spec: 4-check happy-path /
  2-check refusal verifier, two interval shapes (open `(a, b)` for
  irrational, singleton `(r, r)` for rational), 7-tier grid, refusal
  classes, hard constraints.
- **`DESCRIPTION.md`** (~9 KB) — VAS algorithm walkthrough, LMQ bound
  derivation, squarefree-precondition rationale, mutation-prove
  harness rationale, per-tier rationale.
- **`REFERENCES.md`** (~5 KB) — Vincent 1836, Akritas-Strzebonski-
  Vigklas 2008, Tsigaridas-Emiris 2008 (complexity analysis), Yun
  1976 (squarefree prefix), oracle bridge documentation.
- **`golden/verifier_protocol.md`** (~5 KB) — exact tolerances per
  check; both interval shapes handled by single-line boundary-
  correction.
- **`reference/real_root_isolate_reference.py`** (~140 LOC) — SymPy-
  backed: `Poly.intervals()` with squarefree precondition check via
  `Poly.is_sqf`; tagged refusal on non-squarefree, multivariate, and
  non-polynomial inputs.
- **`golden/verify.py`** (~190 LOC) — 4 + 2 checks. `count_roots(lo,
  hi) − [f(lo) = 0] − [f(hi) = 0]` is the open-interval correction
  that handles SymPy's two output shapes uniformly.
- **`golden/generate.py`** (~250 LOC) — fixed 37-case bank (no random
  tier; same precedent as `bench/poly-roots-radical` worklog 057).
  Triple-witness via `RootIntervals[][1]` count under wolframscript;
  agreement on count, not endpoints.
- **`golden/test_mutations.py`** (~190 LOC) — 9 perturbations:
  `dropped_interval`, `added_spurious_interval`, `widened_to_two_roots`,
  `overlapping_intervals`, `singleton_not_root`, `lied_about_scope`,
  `wrong_refusal_tag`, `reversed_order`, `endpoint_at_root`. GREEN
  baseline 7/7 + RED 9/9.
- **`golden/{inputs,expected,oracle_log}.json`** — generated, 37/37
  admitted with full Wolfram cross-witness (~92s runtime).

Per-tier counts: A trivial 5, B Chebyshev/Legendre 8, C clustered
(Mignotte) 5, D large-degree squarefree 5, E rational stress 5, F
refusals 4, G structural edges 5 → **37 total**.

## Why these choices

**Why two interval shapes (open vs singleton).** Forcing a uniform
strict-open `(lo, hi)` would require widening a rational root `r` to
some `(r − ε, r + ε)` chosen so no other root lies inside — strictly
more work than emitting `(r, r)` directly. SymPy's reference uses
the two-shape convention; standard VAS implementations (Akritas-
Strzebonski-Vigklas 2008 §5.2) do likewise. The verifier's `count_roots
− boundary_correction` handles both shapes in one expression.

**Why count, not endpoints, in oracle agreement.** Wolfram's
`RootIntervals` and SymPy's `intervals()` both produce *some*
isolating cover, but the bisection cadences differ — so the rational
endpoints disagree on identical inputs. The *count of intervals* is
invariant: every VAS-class isolator returns one interval per real
root. ADR-0019 §3 admits this kind of "byte-difference, semantically-
equal" oracle agreement; the consensus check is on the count alone.

**Why the squarefree precondition is a tagged refusal, not a silent
squarefree-and-isolate.** The composition with `packages/poly-factor::
squareFree` (worklog 052) is already the canonical pipeline; doing it
implicitly inside this tool would couple two distinct concerns and
make the rational-root-multiplicity contract murkier. The two
principles: a TS expert calling `realRootIsolate(f)` knows whether
they have squarefree input — if not, they call `squareFree` first,
which returns the multiplicity bookkeeping the isolator can't.
Refusing the precondition is the honest scope.

**Why no random tier.** Same precedent as `bench/poly-roots-radical`
(worklog 057): the algorithmic regimes are tightly bounded — degree
range (deg-1 to deg-50), root-distribution patterns (clustered /
spread / no-real / mixed-rational-irrational), refusal classes —
and stratified random would either duplicate cells already covered or
produce inputs whose only signal is "the algorithm didn't crash."
Curated 37 cases × 4 invariants ≈ 130 invariant assertions is
sufficient signal.

**Why Chebyshev T_11 / T_13 instead of products of odd Chebyshev.**
First-pass generator used `T_3 · T_5 · T_7` and `P_3 · P_4 · P_5` for
Tier D's deg-15 stress. Both products turned out non-squarefree —
every odd-indexed Chebyshev / Legendre polynomial has zero as a root
(`T_n(0) = cos(nπ/2) = 0` for odd n; same for odd Legendre), so
products thereof multiply the zero root. The triple-witness logging
caught this (Wolfram solved through, the workbench reference refused),
admitting under `wolfram-ok-workbench-bounded-scope` rather than
`sympy+wolfram`. Replaced with single Chebyshev `T_11` (deg 11) and
`T_13` (deg 13) — each squarefree by construction (n distinct roots).
The shared-zero pitfall is now noted in DESCRIPTION.md's tier-D
rationale.

## Frictions surfaced

**`Poly.is_squarefree` doesn't exist; the attribute is `is_sqf`.**
First-pass reference used `not p.is_squarefree`; SymPy raised
`AttributeError`. Five-second fix once located via `dir(p)` filter:
the attribute is named `is_sqf`. The `_squarefree`-suffixed version
exists as a free function `sympy.is_squarefree(...)` but not as a
`Poly` method. (Lesson: SymPy's polynomial-attribute naming is not
fully consistent with the rest of the namespace; always probe
`dir()` before assuming.)

**SymPy's open + singleton interval convention took two iterations to
get right.** Initial verifier required strict `lo < hi` for every
interval (the bead's `(a, b]` half-open framing). The first round-trip
test on `4x³ − 3x` failed: SymPy returns `[(-1, 0), (0, 0), (0, 1)]`
— three intervals, the middle one a *singleton* `(0, 0)` for the
rational root at zero. Realised the convention had to be: open
`(lo, hi)` when `lo < hi`, singleton `{lo}` when `lo == hi`. The
boundary-correction term `count_roots(lo, hi) − [f(lo) = 0] − [f(hi)
= 0]` handles both uniformly and is the cleanest single-expression
verifier. The bead's `(a, b]` framing was a sketch; the implementation
convention is what shipped.

**Adjacent intervals can share a non-root boundary.** Continuing from
the previous: `(-1, 0)` and `(0, 0)` share endpoint `0` (which is a
root, owned by the singleton); `(0, 0)` and `(0, 1)` share `0` (same
ownership). My initial `intervals_disjoint_and_ordered` check
required strict `hi_i < lo_{i+1}` and rejected this. The relaxation
to `hi_i ≤ lo_{i+1}` is correct: shared-non-root-boundary is
permitted under the open + singleton convention; shared-root-boundary
would require the singleton owns it, and the count check catches any
double-counting attempt.

**Wolfram `RootIntervals[]` parses as `{intervals, root_membership}`
list, not as a flat list of intervals.** Indexing `[[1]]` gives the
intervals; this is documented in Wolfram's reference but easy to
miss. The agreement check is `Length[RootIntervals[poly][[1]]]`.

## Acceptance

- 1 bead closed: `scientist-workbench-q8q`.
- `bench/real-root-isolate/` package: PROMPT/DESCRIPTION/REFERENCES
  + golden/{verify.py, generate.py, test_mutations.py,
  verifier_protocol.md, inputs.json, expected.json, oracle_log.json}
  + reference/real_root_isolate_reference.py.
- 37/37 admitted with triple-witness (sympy + wolfram, count
  agreement); 0 dropped.
- 37/37 pass via the verifier (per-tier 5/5, 8/8, 5/5, 5/5, 5/5,
  4/4, 5/5).
- Mutation-prove: 9 perturbations RED (≥ 5 required by ADR-0019 §4).
  GREEN baseline 7/7.
- `bun run check:quick`: 4/4 green.

## Pointers

- Bead `scientist-workbench-q8q`: closed.
- ADR-0019 (`docs/adr/0019-solve-bench-discipline.md`): bench
  discipline; this bench is the §1-§7 instance for
  `tools/real-root-isolate`.
- Open follow-ups: bead `rra` (`packages/real-roots`: VAS with LMQ
  bound — TypeScript port of `dup_isolate_real_roots`), then the
  `tools/real-root-isolate` ship that wires `bench/infra/run-bench.sh`
  to gate the TS implementation against this bench.

## Commits

(this shard documents the work landed; commit message will follow
the same Law-2 lockstep pattern when staged.)
