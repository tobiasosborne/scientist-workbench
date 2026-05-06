# 052 — `poly-factor` end-to-end: Hensel + Berlekamp + recombination + tool ship

**Date:** 2026-05-06
**Status:** complete
**Branches:** main
**ADRs:** none new — applies ADR-0019 (solve-bench discipline),
ADR-0017 (solution-set shape extension to factor-list),
ADR-0013 (polynomial GCD), ADR-0003 (output / error categories),
ADR-0008 (ring-generic Poly), ADR-0010 (defineTool/runTool).
**Issues closed:** scientist-workbench-{0fy, p3d, 5k6, v13, d0o}.
Filed: scientist-workbench-5k6 (multi-factor Hensel). Phase 2 of
solve-suite-v1 (univariate factorisation over ℚ) ships complete; the
parent epic scientist-workbench-98a advances into P3 territory
(univariate roots, algebraic numbers, Gröbner / multivariate solve,
top-level `tools/solve`).

## Context

Continuing Phase 2 from shard 051 (which landed the
`bench/poly-factor-q/` skeleton + Yun square-free decomposition).
This shard covers the rest of the substrate stack and the first
Solve-tier symbolic *tool* — second after `linsolve-q` (shard 050-prep).

The session opened with a per-device baseline check: bun 1.3.0 lives
at `/home/tobias/.amp/bin/bun` (not on PATH; prefixed per-command),
`bun install` reports no changes, `bun run check:quick` is green
modulo a non-fatal stale-worktree warning. A locked git worktree
`.claude/worktrees/agent-af981578fc669a7c3` from a prior session was
left in place (destructive cleanup unauthorised; the warning is
informational, not blocking).

## What changed

### `packages/cas-core` — substrate for ℤ-arithmetic and 𝔽_p[x]

Three primitives added under one new file plus extensions:

- **`src/fp.ts`** (new):
  - `INT_RING : Ring<bigint>` — ℤ as a Ring instance, mirroring
    `RAT_RING` (in `rat.ts`) and `algebraicRing` (in `algebraic.ts`).
    Used by every `Poly<bigint>` operation in poly-factor's pipeline.
  - `fpField(p) : Field<bigint>` — 𝔽_p as a Field instance, canonical
    residues `[0, p)`. Cached per `p` (the same dictionary is reused
    across Berlekamp + Hensel, which both reach for it on every
    inner-loop tick). `inv` delegates to `mod-core::modInv` and
    throws on non-invertible inputs (with a primality-suggestion
    suffix); `fpField` does *not* check primality of `p` — that's
    the caller's contract.
  - `polyTrunc(f, m) : Poly<bigint>` — coefficient-wise reduction
    mod `m`, canonical `[0, m)`. The Hensel inner loop's per-iteration
    truncation step.
- **`src/poly.ts`**: added `polyDivRemMonic<T>(a, b, v, R: Ring<T>)` —
  univariate long division by a *monic* divisor over any Ring.
  Distinct from `polyDivExact` (which requires a Field for the
  leading-coefficient inversion at every step) and `polyPseudoDivide`
  (which pre-multiplies by `lc(b)^δ`, the wrong thing for Hensel
  where the divisor is already monic). The `Ring<T>` substrate is
  load-bearing: Hensel's `dup_div(s·e, h)` step lives in `ℤ[x]/(p^k)`
  which is a Ring, not a Field, but `h` is monic.
- **`src/poly-gcd.ts`**: added `polyExtGcd<T>(a, b, v, R: Field<T>)` —
  univariate extended Euclidean algorithm over a Field, returning
  `{g, s, t}` with `s·a + t·b = g` and `g` monic. The classical
  Knuth TAOCP 2 §4.6.1 Algorithm E. Distinct from the multivariate
  `polyGcd` (Brown-Collins subresultant PRS) — over a Field in one
  variable, the simpler Euclidean is the right primitive, and
  cofactor extraction is straightforward.

`packages/cas-core` now depends on `@workbench/mod-core` (workspace
edge added to `package.json`). Prior to this shard mod-core was the
sole consumer of `modInv`; making it cas-core's `fpField` substrate
is the natural evolution as we lean further into ring-generic
algorithms.

Tests: 33 across `fp.test.ts` + `poly-univariate.test.ts`, 85 expect()
calls. Bezout-identity asserted across multiple primes (F_2, F_3,
F_7, F_11, F_13, F_101) and across coprime / shared-factor inputs.

### `packages/poly-factor` — end-to-end factorisation pipeline

Three new modules + a top-level orchestrator:

- **`src/hensel.ts`** — quadratic Hensel lift.
  - `henselLiftPair(f, g₀, h₀, p, k, v)`: Knuth TAOCP 2 §4.6.2
    Algorithm D / Gathen-Gerhard 1999 §15.4. Lifts a coprime mod-p
    factorisation `f ≡ g₀·h₀ (mod p)` to mod `p^k` for any caller-
    chosen `k`. Doubling-precision per step (`⌈log₂ k⌉` iterations).
    Verifies preconditions at the boundary (lc(h₀) = 1, gcd(g₀, h₀) =
    1, f ≡ g₀·h₀ mod p) — sharp errors beat silent wrong factors.
  - `henselLiftMany(f, modPFactors, p, k, v)`: divide-and-conquer
    over `henselLiftPair` for the `r > 2` case. Pair the factors into
    halves, lift the pair, recurse. Mirrors SymPy's
    `dup_zz_hensel_lift` in `polys/factortools.py:280`.
- **`src/berlekamp.ts`** — `berlekampFactor(f, p, v)`. Classical
  Berlekamp 1967 over the Frobenius matrix kernel. Pure linear-
  algebraic and *deterministic* — no entropy plumbing per ADR-0005.
  Construct the `n×n` matrix `M[i][j] = ` coef of `v^i` in
  `v^{p·j} mod f` (via squaring and modular reduction), compute its
  null space over `𝔽_p` by Gaussian elimination, walk basis elements
  scanning constants `c ∈ [0, p)` for non-trivial gcds.
- **`src/recombine.ts`** — Mignotte 1974 bound + Berlekamp-Zassenhaus
  subset-sum recombination.
  - `mignotteBound(f, v)` returns `⌈√(n+1)⌉ · 2ⁿ · ‖f‖∞ · |lc(f)|`
    (a positive bigint).
  - `mignotteHenselExponent(f, p, v)` returns the smallest `l` with
    `p^l ≥ 2·M(f) + 1`.
  - `recombineFactors(f, lifted, p, l, v)` walks subsets of the
    lifted factors in increasing cardinality, trial-divides into
    the residual `f` over ℤ via `polyDivRemMonic`, harvests true
    integer factors. Constant-term-divides prune included.
- **`src/factor.ts`** — top-level orchestrator.
  - `factorPrimitiveSquareFreeZ(f, v)`: pick a lucky prime, run
    Berlekamp, Hensel-lift, recombine.
  - `factorIntZ(f, v)` (handles content + multiplicity + lifts to ℚ
    for Yun, factors each square-free piece via the primitive flow).
  - `factorRatQ(f, v)` (the user-facing `Poly<Rat>` entry point):
    multiplicative-content extraction, multivariate refusal, then
    `factorIntZ` on the integer body.

Tests: 56 total in `packages/poly-factor/test/{hensel,berlekamp,factor}.test.ts`.
Mutation-prove on the Hensel pair-step: drop coefficient (breaks
reconstruction), scale by 2 (breaks monicity AND reconstruction),
corrupt at a higher power of `p` (breaks reconstruction at p^k while
remaining invisible mod p — the load-bearing case for "lift was
wrong but mod-p invariants pass"), out-of-canonical-range coefficient
(breaks the canonical-residue invariant). End-to-end factorisation
verified on Cyclotomics Φ₃, Φ₅, Φ₈, Φ₁₂; Tier-D-style probe
`(x²−2)(x²−3)(x²−5)(x²−7)` (deg-8, all irreducible quadratic factors);
mixed-multiplicity `(x−1)³(x+1)²`.

### `tools/poly-factor` — the seven-artefact tool

Wraps `factorRatQ` behind the standard tool contract.

- Input: `record { f: <expression>, var: <symbol> }`.
- Output: happy-path `record { content, factors: list<{factor, multiplicity}>,
  method, warnings }` OR boundary `tagged "poly-factor/non-polynomial"`
  with `record { detail: string }` payload.
- Refusal classes: out-of-scope head, foreign symbol (multivariate),
  rational function with non-constant denominator. ToolError reserved
  for malformed input (e.g., the zero polynomial — factorisation
  undefined).
- Canonicalisation: each ℚ-monic factor is converted to integer-
  primitive form (multiply through by the LCM of denominators; the
  scaling absorbs into `content`); sign-fix to positive leading
  coefficient; sort by degree ascending then lex on coefficient
  sequence.
- Goldens: 27 cases spanning tiers A (shape edges), B (random low-
  degree), C (cyclotomic Φ_n for n ∈ {3, 5, 8, 12}), E (square-laden),
  F (large coefficients), G (content / scaling), H (refusals).
- README + main README catalog row + `packages/poly-factor` row in
  the file-layout section.
- Demo-scope: 15th demo added to `scripts/demo-scope.ts` showing
  `(x⁵ − x⁴ − 2x³ + 2x² + x − 1) = (x − 1)³ (x + 1)²` end-to-end.

## Why these choices

**Why Berlekamp instead of Cantor-Zassenhaus.** Cantor-Zassenhaus
1981 is probabilistic — needs random splittings. Per ADR-0005 the
workbench's nondeterministic operations consume an externalised
`entropy: string` field; that would mean wiring entropy into Hensel's
substrate. Berlekamp 1967 is deterministic linear-algebraic; the
match against the workbench's "same input bytes ⟹ same output bytes"
contract is exact. (Secondary win: deterministic factorisation
composes with provenance and content-addressing without thinking
about entropy plumbing at all.)

**Why two-factor Hensel first, then multi-factor.** The bead
`scientist-workbench-0fy` describes the two-factor case; its
correctness rests on the carefully-balanced (g, h, s, t) lift
formulas (Knuth Algorithm D). Multi-factor is divide-and-conquer
over the pair-step — a 30-line orchestrator on top of the substrate.
Shipping the pair-step solid first means every multi-factor lift
inherits the pair-step's mutation-proven correctness; the recursive
case adds only a "did we slice the factor list right" question, not
a "is the math right" question. Filing `scientist-workbench-5k6`
mid-shard for the multi-factor extension and closing it the same
session preserves the issue trail.

**Why Berlekamp-Zassenhaus, not van Hoeij.** The bench's PROMPT.md
notes vanHoeij is required for v1 admission of the deg-16
Swinnerton-Dyer cases (Tier D). The bead `scientist-workbench-v13`
explicitly scoped to classical Zassenhaus subset-sum, with vanHoeij
deferred to v0.2. Subset-sum is `O(2^r)` worst-case but practical
for `r ≤ 16` with the constant-term-divides prune (the deg-16 cases
have `r = 16` mod-p factors after Berlekamp, so `2^16 = 65 K`
candidates — borderline within the 60 s harness budget but feasible).
If running against the live bench surfaces Tier-D timeouts, the
escalation path is straight: introduce LLL-based knapsack
recombination as a follow-up bead. For shipping the v1 surface
without speculative complexity, classical recombination is the
right floor.

**Why content lives in a separate field, not absorbed into a factor.**
Per the PRD's two-principles framework: a TS expert reading
`{content, factors}` knows immediately what each piece is. Rolling
content into a factor means the factor list becomes inhomogeneous
(some factors are integer-primitive, one carries a rational scalar);
makes downstream consumers branch on factor[0]'s shape; defeats
"every factor is irreducible monic primitive". The principle from
ADR-0017 (solution-set shape) generalises: separate concerns by
shape; the planner reads what it needs.

**Why `INT_RING` and `fpField` live in cas-core, not in poly-factor.**
They mirror the existing `RAT_RING` and `algebraicRing` discipline.
`Field<bigint>` is a foundational coefficient ring — useful for
mod-p polynomial GCD elsewhere, for reduction tests, for downstream
algebraic-number work. Pinning it to cas-core means future
consumers (e.g., the Gröbner DAG's coefficient-conversion path)
reach for the same dictionary instead of re-inventing it.

**Why `polyDivRemMonic` over Ring, not Field.** Hensel's `dup_div`
step lives in `ℤ[x]/(p^k)` which is a *Ring* — `p^k` not prime, so
not every non-zero element is a unit. But the divisor is monic
(`lc(h) = 1`), so the per-step elimination needs no division. The
Ring substrate is the honest scope — saying `Field` would be a
lie about what the algorithm needs. A consumer that wants
`polyDivRemMonic` over a Field can just call it with a Field and
trust the same code path.

## Frictions surfaced

Three meaningful frictions; all caught and fixed within the session.

### 1. `Field<bigint>` cache via the `fpField(p)` constructor

First draft built `Field<bigint>` inline in every callsite
(berlekampFactor, henselLiftPair, factorPrimitiveSquareFreeZ).
Three problems: (a) duplicated allocation per call, (b) different
sites had subtly different `inv` error messages — debugging would
have been frustrating, (c) the dictionary's identity wasn't shared
across consumers, so a future "is this the F_p dictionary" check
in higher-up code would not have a single answer.

Fix: cache `fpField(p)` in a module-level `Map<bigint, Field<bigint>>`.
First call with a given `p` allocates; subsequent calls are
identity-equal. The test `dictionary cache: fpField(p) is identical
between calls` is the regression guard.

### 2. The `factorIntZ` content/sign reconstruction had two bugs

(a) For negative-leading input (e.g., `−x² + 1`), the early
implementation tried to absorb the sign into "content" and *also*
flip a factor's sign — but factors are by convention monic with
positive leading coef, so sign-flipping a factor breaks monicity.
Fixed by leaving the sign in `content` (relaxing the doc to "may be
negative if `f`'s leading coefficient is negative").

(b) The `runningContent` accumulator I built up alongside the Yun
loop didn't actually account for `lc_Q(f)`'s contribution correctly.
Symptoms: reconstruction `content · ∏ factor^mult` was off by a
factor for non-monic input. Fixed by computing `content` directly
as `f / ∏ factor^mult` over ℚ and asserting the residual is
constant — instrumentation at the boundary catches an algebraic-
identity error that the inline accumulator was hiding.

The lesson: when an algebraic invariant has a clean closed form,
compute it that way and let the cross-check be the safety net.
Inline accumulators that re-derive what the invariant says are
double bookkeeping.

### 3. The casSimplify property test occasionally tipped over the 30 s timeout

Pre-existing test in `packages/cas-core/test/cas-core.test.ts:261`
that simplifies 200 random expression trees twice each, asserting
idempotence. Already had a custom 30 s timeout (vs. bun's default
5 s) flagged as "ADR-0013: GCD reduction in makeRatFn adds real
per-tree cost". After landing poly-factor's substrate tests
(56 + 33 = 89 new expects), the suite-wide CPU pressure made the
property test occasionally hit 30 s. Bumped the test's timeout to
60 s with a comment pointing at this shard, in lieu of reducing
the iteration count (the 200-tree count is load-bearing for the
test's invariant-coverage claim).

This is an entirely pre-existing test that just had a tight margin;
the right move is to give it more room rather than weaken the
property.

## Acceptance

- 5 beads closed: `scientist-workbench-{0fy, p3d, 5k6, v13, d0o}`.
- `packages/cas-core` substrate: 33 tests, 85 expects, all green.
- `packages/poly-factor` end-to-end: 56 tests, ~470 expects, all
  green; mutation-prove demonstrates each invariant catches a
  distinct class of regression.
- `tools/poly-factor` ships with 27 goldens, full
  `bun run check` green (57 phases, 0 skipped).
- README catalog + tools/poly-factor/README.md + scripts/demo-scope.ts
  updated in lockstep (Law 2).
- The 15-demo `bun scripts/demo-scope.ts` runs in ~1.4 s — the
  poly-factor invocation takes a few hundred ms for the deg-5
  example.

## Pointers

- ADR-0019 (`docs/adr/0019-solve-bench-discipline.md`) — the
  contract for solve-tier benches; second instance after
  `bench/linsolve-q/` (shard 050-prep).
- Cox-Little-O'Shea §4.5–4.6 (local PDF
  `docs/ground-truth/factor/cox-little-oshea-…`) — Yun's algorithm,
  Hensel's lemma, Berlekamp factorisation, the integer-recombination
  argument.
- Berlekamp 1967 (local PDF `docs/ground-truth/factor/berlekamp-1967.pdf`)
  — original paper.
- Mignotte 1974 — bound only; PDF unavailable.
- SymPy `polys/factortools.py` lines 223 (`dup_zz_hensel_step`),
  280 (`dup_zz_hensel_lift`), 344 (`dup_zz_zassenhaus`) — the
  reference implementation cross-checked against during this work.
- `packages/cas-core/src/{fp.ts, poly-gcd.ts, poly.ts}` for the
  ring-substrate additions.
- `packages/poly-factor/src/{hensel, berlekamp, recombine, factor}.ts`
  for the pipeline.
- `tools/poly-factor/{tool, README, goldens.spec}.ts`.
- `bench/poly-factor-q/` — the 56-case bench whose bench-side wire
  adapter `run-candidate.ts` is the natural follow-up after this
  shard (defer to a Phase-2-closeout shard once the bench passes
  end-to-end against the live tool).

## Commits

(this shard documents the work landed; commit messages will follow
the same Law-2 lockstep pattern when staged.)
