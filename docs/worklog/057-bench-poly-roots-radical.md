# 057 — `bench/poly-roots-radical` (iyj) + `demo-scope` solve entries (b22)

**Date:** 2026-05-07
**Status:** complete
**Branches:** main
**ADRs:** applies ADR-0019 (bench discipline), ADR-1yu (casus
irreducibilis: faithful complex form). No new ADRs.
**Issues closed:** scientist-workbench-{iyj, b22}.

## Context

Two epic closeouts in the same session as worklog 056 (yq2):

- **`b22`** — add representative invocations of the solve-epic tools
  (`linsolve-q`, `poly-factor`, `poly-roots`, `solve`) to the TS
  `scripts/demo-scope.ts`. Linsolve-q + poly-factor + solve linear/
  univariate-poly were already there from worklogs 050/052/054; this
  shard added demo 17 (poly-roots golden-ratio radicals) and demo 18
  (solve transcendental branched output) — the two surfaces missing
  from the demo's solve-epic exposition.
- **`iyj`** — dedicated bench for `tools/poly-roots`. Single-tool,
  single-lane, 50-case 7-tier battery exercising the Cardano +
  Ferrari closed-form radicals across happy paths and deg-5
  refusals.

Sequenced behind worklog 056 (yq2): the bench/solve template was
fresh, so this bench is structurally near-identical with
narrower scope (one tool instead of four lanes).

## What changed

### `scripts/demo-scope.ts` (b22) — demos 17 + 18

- **Demo 17 — poly-roots, golden-ratio radicals.** Solves `x² − x − 1 = 0`
  to demonstrate the exact-symbolic root surface: `(1 + √5)/2` and
  `(1 − √5)/2`. The pretty-renderer parenthesises `+`/`-` subterms
  inside `/` and `^` so `(1 + √5)/2` doesn't display as ambiguous
  `1 + √(5)/2`. (First-pass renderer dropped the parens; caught at
  the first end-to-end run.)
- **Demo 18 — solve transcendental, branched output.** Solves
  `sin(x) = 1/2` to demonstrate the v0.1 invert-table branched
  emission with explicit integer-parameter symbols. Output:
  `x = arcsin(1/2) + 2π·t_0` ∨ `x = π − arcsin(1/2) + 2π·t_1`,
  `completeness = "finite-rep-of-infinite"` per ADR-0017.

Verified end-to-end: `bun scripts/demo-scope.ts` runs in ~1s with
both demos producing the expected output. `bun run check:quick`
4/4 green.

### `bench/poly-roots-radical/` (iyj) — 50-case 7-tier bench

Files:

- **`PROMPT.md`** (~6 KB) — agent-facing spec: 4 happy-path checks
  (shape, each_root_satisfies, count_with_multiplicity,
  distinct_roots_match) + 2 refusal checks; 7-tier grid.
- **`DESCRIPTION.md`** (~5 KB) — per-degree algorithm spec, casus-
  irreducibilis explanation per ADR-1yu, mutation-prove harness
  rationale.
- **`REFERENCES.md`** (~4 KB) — Cardano/Ferrari/Cox-Little-O'Shea
  citations + Berlekamp-Zassenhaus prefix from `bench/poly-factor-q`,
  oracle bridge documentation, ADR-0019 + ADR-1yu cross-refs.
- **`golden/verifier_protocol.md`** (~4 KB) — exact tolerances per
  check; `1e-9` numerical fallback for casus-irreducibilis radicals.
- **`reference/poly_roots_reference.py`** (~150 LOC) — SymPy-backed:
  `Poly.factor_list()` per ℚ-irreducible, `Poly.all_roots(multiple=True)`
  per factor, multiplicity inherited from factor exponent.
- **`golden/verify.py`** (~280 LOC) — 4 + 2 checks. Three-layer
  simplification chain (`simplify` → `radsimp` → `evalf`-fallback)
  for casus-irreducibilis confirmation per ADR-1yu.
- **`golden/generate.py`** (~290 LOC) — fixed 50-case bank (no
  random tier here — the closed-form domain is small enough that
  curated coverage of every degree-by-discriminant cell is
  better than stratified random; same precedent as `bench/linsolve-q`'s
  Tier-C classical-structural cases). Eager-flush per-case logging.
- **`golden/test_mutations.py`** (~190 LOC) — 8 perturbations:
  `dropped_root`, `wrong_multiplicity`, `wrong_root_value`,
  `added_spurious_root`, `lied_about_scope`, `wrong_refusal_tag`,
  `casus_irreducibilis_wrong` (exercises the numerical fallback
  layer), `zero_multiplicity`. GREEN baseline 5/5 + RED 8/8.
- **`golden/{inputs,expected,oracle_log}.json`** — generated, 50/50
  admitted with full Wolfram cross-witness (~2 min runtime).

Per-tier counts: A linear 6, B quadratic 8, C cubic 8 (incl. 2
casus-irreducibilis), D quartic Ferrari 8, E reducible 6, F numeric
stress 8, G refusals 6 → **50 total**.

### `README.md`

`tools/poly-roots` row updated with the bench reference (Law-2
lockstep).

## Why these choices

**Why no random tier for poly-roots-radical.** The closed-form domain
is tightly bounded — degrees 1-4, discriminant signs, multiplicity
patterns. Curated coverage of every degree × discriminant × multiplicity
cell catches every algorithmic regime; stratified random would either
duplicate cells already present or produce inputs whose only signal
is "the formula didn't crash." The same precedent governs
`bench/linsolve-q`'s Tier-C classical-structural cases (Hilbert /
Pascal / Vandermonde — curated, not random). For `bench/poly-factor-q`
the Tier-D Swinnerton-Dyer max-r cases are similarly curated; only
Tier-B / Tier-F got random coefficients there.

**Why the three-layer simplification chain.** SymPy's `simplify` is
*conservative* on cube-roots-of-complex expressions — it preserves
the form `((a + b·i)^(1/3))` rather than reducing to a real value,
even when the real value is integer. `radsimp` flattens nested radicals
but doesn't address complex-radical reduction. The `evalf`
fallback accepts `|residue.evalf()| < 1e-9` as proof-of-zero. For
casus irreducibilis (`x³ − 3x + 1` etc.) this is the only practical
verification path that doesn't break ADR-1yu's faithful-complex-form
discipline. The mutation harness exercise `casus_irreducibilis_wrong`
verifies the chain catches mutations that produce numerically-non-
zero residues (a wrong root substituted into a real polynomial gives
a real non-zero residue that survives the chain).

**Why `count_with_multiplicity` separately from `distinct_roots_match`.**
A bug that returns the right *set* of distinct roots but wrong
multiplicities (e.g., `(x − 1)²` returning multiplicity-1 instead of
multiplicity-2) fails count but passes distinct-match. Conversely, a
bug that returns extra spurious roots passes count (since multiplicity
sum still equals deg) only if it ALSO drops a real root. Both checks
together are sufficient for the multiset-equality property; either
alone is partial.

**Why `random.Random` not pinned even though no random tier.** The
generator is fully deterministic (seeded at module top, never
consumed). The seed is preserved for forward-compatibility — adding
a Tier-H stratified random later doesn't change the existing tiers.

## Frictions surfaced

**Pretty-renderer parenthesisation.** The first draft of demo 17 dropped
parens around `+`/`-` subterms inside `/`. `(1 + √5)/2` displayed as
`1 + √(5)/2` — ambiguous to a reader (could mean `1 + (√5)/2`).
Fixed by adding a `wrap()` helper that adds parens for compound
heads in numerator/denominator/base positions. Same fix would
apply to any future symbolic-output demo; consider promoting to a
shared `renderExpr` helper if a third demo needs it.

**Two casus-irreducibilis cubics, not one.** Tier C originally had
one casus case (`x³ − 3x + 1`). After running the verifier with the
`evalf` fallback layer in place, I added `x³ − 7x + 6` (which has
the more pleasant rational roots `1, 2, −3`, but Cardano's formula
still computes them via complex radicals because the discriminant is
negative) as a sanity check that the *symbolic-equality* match
(post-`radsimp`) actually fires for at least one casus case rather
than always falling through to `evalf`. Both cases pass; the
`x³ − 7x + 6` case exercises `radsimp` + symbolic equality, the
`x³ − 3x + 1` case exercises the `evalf` fallback. Coverage.

**SymPy `Poly.all_roots(multiple=False)` returns deduplicated roots.**
The verifier's bipartite match relies on this — same as the
candidate's "distinct root + multiplicity" convention. SymPy's
default `multiple=True` would return roots with repetition (matching
`tools/solve`'s flat-with-repetition convention but NOT
`tools/poly-roots`'s distinct-with-multiplicity convention). Calling
the right variant is load-bearing; test_mutations' `wrong_multiplicity`
case caught a draft that used the wrong default.

## Acceptance

- 2 beads closed: `scientist-workbench-{iyj, b22}`.
- `bench/poly-roots-radical/` package: PROMPT/DESCRIPTION/REFERENCES
  + golden/{verify.py, generate.py, test_mutations.py,
  verifier_protocol.md, inputs.json, expected.json, oracle_log.json}
  + reference/poly_roots_reference.py.
- 50/50 admitted with triple-witness (sympy + wolfram); 0 dropped.
- 50/50 pass via the verifier; per-tier 6/6, 8/8, 8/8, 8/8, 6/6,
  8/8, 6/6.
- Mutation-prove: 8 perturbations RED (≥ 5 required by ADR-0019 §4).
  GREEN baseline 5/5.
- `scripts/demo-scope.ts` extended with demos 17 (poly-roots) + 18
  (solve transcendental). End-to-end verified.
- Main README catalog row updated for poly-roots (Law-2 lockstep).
- `bun run check`: 61 phases passed, 0 failed.

## Pointers

- Bead `scientist-workbench-iyj`: closed.
- Bead `scientist-workbench-b22`: closed.
- ADR-1yu (`docs/adr/1yu-casus-irreducibilis.md` — actually filed
  inline in `tools/poly-roots/tool.ts` per worklog 053): faithful
  complex form for casus irreducibilis.
- ADR-0019 (`docs/adr/0019-solve-bench-discipline.md`): bench
  discipline; this bench is the §1-§7 instance for poly-roots.
- Open follow-ups: `bench/poly-roots-radical/run-candidate.ts` (TS
  adapter to `tools/poly-roots`'s subprocess; mirrors
  `bench/solve` and `bench/poly-factor-q` deferrals); bead `yoc`
  (poly-roots upgrade to `Root[poly, k]` for deg ≥ 5 — lifts the
  bounded-scope refusal); bead `q8q` (`bench/real-root-isolate`
  for high-degree real roots).

## Commits

(this shard documents the work landed; commit messages will follow
the same Law-2 lockstep pattern when staged.)
