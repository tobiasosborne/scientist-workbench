# 051 — `poly-factor-q` bench + first substrate (Yun square-free)

**Date:** 2026-05-06
**Status:** complete
**Branches:** main
**ADRs:** none new — applies ADR-0019 (solve-bench discipline),
ADR-0017 (solution-set shape), ADR-0013 (polynomial GCD), ADR-0003
(output / error categories).
**Issues closed:** scientist-workbench-{4nz, 3s2, 153}. Parent epic
scientist-workbench-98a (solve-suite-v1) advances from P1 (linear) into
P2 (univariate polynomial factorisation). Phase 2 substrate beads
remaining: -0fy (Hensel), Berlekamp + vanHoeij (new beads to file),
-d0o (tool ship).

## Context

Second algorithmic tier of the solve epic, after `linsolve-q`. The
target is `tools/poly-factor` consuming `record{f: expression,
var: symbol}` and emitting a canonical irreducible factorisation
`{content: rational, factors: list[(factor: poly, multiplicity: int)]}`
over ℚ. The standard algorithm chain (Cox-Little-O'Shea Ch. 4;
Geddes-Czapor-Labahn Ch. 8) is:

1. content/primitive split + square-free decomposition (Yun 1976)
2. factor each square-free piece over `𝔽_p` (Berlekamp 1967)
3. Hensel-lift `𝔽_p → ℤ/p^k` with `p^k > 2 · M(f)` (Zassenhaus 1969)
4. recombine `ℤ/p^k` factors back to `ℤ` (vanHoeij 2002 LLL knapsack —
   not optional for v1, since Tier D Swinnerton-Dyer demands
   polynomial-time recombination)

This shard records the bench skeleton, the verifier with mutation-
prove, and the *first* substrate piece — Yun's square-free
decomposition, the entry point of step (1).

This is also the first session run on the second device. The pre-flight
established baseline readiness (bun 1.3.9, python3 + sympy 1.12 +
scipy 1.11.4 + numpy 1.26.4, jq 1.7, wolframscript 1.13.0, pytest
9.0.3 via `pip install --break-system-packages pytest`), staged 21/22
ground-truth PDFs across `docs/ground-truth/` (with three Buchberger
+ CLO PDFs symlinked from `../tstournament/ts-bench-infra/problems/
08-buchberger/sources/` to avoid duplicate downloads), and confirmed
`bun run check:quick` was green before any code changes.

## What changed

### Bench skeleton — `bench/poly-factor-q/` (4nz)

Mirrors the `bench/linsolve-q/` template byte-for-byte where the
shape allows; departs only where univariate-factor semantics differ.

- **`PROMPT.md`** (12.8 KB) — agent-facing spec: 5 invariants
  (shape, product-equals-input, each-factor-irreducible-over-Q,
  factors-primitive, factors-positive-leading) + refusal-class match;
  8-tier test grid (A shape edges, B random low-degree primitive,
  C cyclotomic Φ_n, D Swinnerton-Dyer max-r, E square-laden, F large-
  coefficient Mignotte stress, G content/scaling, H non-polynomial
  refusals); explicit "vanHoeij-style recombination is required for
  v1 admission" — Tier D's deg-16 case (`√2 + √3 + √5 + √7` minpoly)
  produces 16 modular factors and naive Zassenhaus is `O(2^16)`,
  borderline at the per-case 60 s harness timeout; `n=5` would be
  untenable.
- **`DESCRIPTION.md`** (5.7 KB) — context, dependency on `linsolve-q`,
  what the bench earns (substrate package + bench-discipline template
  for the rest of Phase 2-6).
- **`REFERENCES.md`** (9.3 KB) — primary algorithm citations with local-
  PDF paths (Berlekamp 1967, vanHoeij 2002, Hart-vanHoeij-Novocin 2011,
  Cox-Little-O'Shea §4) plus three honest "not staged" notes (Mignotte
  1974 — AMS Cloudflare-walled even via Wayback; Zassenhaus 1969 —
  Elsevier bot-walled; the Strzebonski papers are now staged via
  manual TIB-VPN browser fetch, see worklog 050's per-phase
  `MISSING.md` files).
- **`golden/verifier_protocol.md`** (8.0 KB) — exact specifications
  per check; tolerance regime "none"; refusal-class admission rule.
- **`golden/generate.py`** (562 LOC) — seeded reproducible generator.
  Seed `0x01346C0B = 20260507`. Triple-witnessed via SymPy primary
  (`Poly.factor_list`) + Wolfram cross-witness (`Factor[f]`).
  56 cases admitted on the live pass, **0 drops**. Per-tier counts:
  A:6 B:12 C:8 D:6 E:8 F:6 G:6 H:4. Tier-F cases carry a sidecar
  `expected_max_coef_log2` for the verifier's bit-budget sanity
  assertion.

### Verifier + mutation-prove — `bench/poly-factor-q/golden/` (3s2)

- **`verify.py`** (~280 LOC). Reads `{input, candidate, id, expected?}`
  on stdin, emits `{pass, reason, checks}` on stdout, exit 0/1. Five
  happy-path checks plus `refusal_class_matches`. Lied-about-scope
  detection: when the candidate's `kind` mismatches the case's
  `expected.kind`, **all** downstream checks are reported as failed
  (not n/a) so the failure is loud — a candidate that fabricates a
  happy-path output for a Tier H non-polynomial input is exactly what
  the bench is supposed to catch.
- **`reference/poly_factor_q_reference.py`** (~110 LOC). SymPy
  `Poly.factor_list` adapter that emits the candidate-shaped record;
  used by the mutation harness as the GREEN baseline to perturb.
- **`golden/test_mutations.py`** (~250 LOC). GREEN baseline 4/4 probes
  (`x^4 - 5x^2 + 4`, `6·(x-1)·(x+2)`, `(x-1)^3·(x²+1)`, `x-7`), then
  6 RED demonstrations:
  - `drop_factor` → fails `product_equals_input` exclusively
  - `off_by_one_multiplicity` → fails `product_equals_input`
  - `content_leak` → fails *both* `product_equals_input` and
    `factors_primitive` (good — both checks catch the regression)
  - `sign_flip_leading` → fails `factors_positive_leading` exclusively
    (the mutation flips the factor's leading sign *and* compensates
    `content` so the product invariant is preserved; only the
    canonical-form invariant fails)
  - `returned_reducible_factor` → fails `each_factor_irreducible`
    exclusively (replaces `(x-1)·(x+1)` with the single reducible
    factor `x²-1`; product preserved)
  - `lied_about_scope` → fails `shape` first; downstream checks
    reported as failed for traceability

The precision discipline is the load-bearing point: each mutation
maps to the *specific* check it's supposed to fail. A mutation harness
where every mutation fails on `shape` (because the structure is
malformed) would not actually test the deeper invariants. Round-trip
self-check: 56/56 across the full golden bank pass when
`candidate = expected`.

### Substrate — `packages/poly-factor` + cas-core extension (153)

- **`packages/cas-core/src/poly.ts`**: added `polyDeriv(a, v, R)` —
  partial derivative wrt a named variable. Ring-only (not Field —
  derivative is `R.fromInt(BigInt(k)) · coef`, no division). 9 unit
  tests covering linearity, product rule, multivariate, mixed-partials-
  commute, char-0 invariants. Named `polyDeriv` (not `polyDiff`) to
  avoid collision with the existing `differentiate` symbolic derivative
  in `diff.ts` (which works on `Value`, not `Poly<T>`).
- **`packages/poly-factor/`** — new workspace package, deps just
  `@workbench/cas-core`. `src/squarefree.ts` implements Yun 1976 with
  literate doc-comments citing CLO §4.5. The output shape is
  `Array<{factor: Poly<Rat>, multiplicity: number}>`; the leading-
  coefficient `lc(f)` is exposed *separately* (callers compute via
  `polyLeadingCoef`) — the API discipline is "factor list is monic and
  square-free; the residual constant is none of squareFree's business."
- **`packages/poly-factor/test/squarefree.test.ts`** — 17 tests, 607
  expect() calls. The `assertYunInvariants` helper is the punishing
  surface: per call it asserts (I1) reconstruction `lc(f)·∏ a_i^i = f`
  exactly, (I2) each `a_i` is square-free (`gcd(a_i, a_i') = 1`),
  (I3) pairwise coprimality, (I4) monicity, (I5) strictly-increasing
  multiplicities, (I6) no spurious one-entries. Property test runs
  `assertYunInvariants` over 30 random products; adversarial tests
  cover `(x-1)^k` for `k ∈ {1..15}` and `∏_{k=1..6} (x-k)^k`.

## Why these choices

**Why bench-first.** Same precedent as `linsolve-q` (P1-1 → P1-2 →
P1-3 → P1-4 → P1-5). The bench is the floor; substrate work has a
target to verify against. ADR-0019 §4's mutation-prove discipline
catches "verifier IS sensitive" early, before any candidate substrate
is in flight. With the bench locked in, all subsequent substrate
beads (Hensel, Berlekamp, vanHoeij) feed into a known-good acceptance
gate.

**Why Yun specifically.** The issue-153 brief flagged "trivial given
polyGcd" — true, but the *invariant set* matters more than the LOC.
Yun's algorithm operates entirely in `polyGcd` + `polyDivExact` +
`polyDeriv`, all of which already exist in cas-core. The output's
"square-free + pairwise coprime + monic" invariant set is what makes
Hensel work (Hensel needs coprime initial factors), so getting the
output canonicalisation right at this layer pays off twice.

**Why `polyIsOne(b)` was wrong as the loop exit.** Yun assumes monic
input; for non-monic `f` the residual after the last extraction is
the constant `lc(f)`, not 1. The `b == 1` check terminates fine on
monic input but loops forever on non-monic. Fixed to
`polyDegInVar(b, v) > 0` — semantically what we mean by "while
there's polynomial structure left to peel off." The reconstruction
`f = lc(f) · ∏ a_i^i` correctly carries the leading coefficient
outside the factor list, so this is honest factoring.

**Why `polyDeriv` lives in cas-core, not poly-factor.** It's a
basic polynomial operation, not a factor-specific one. Future Sturm-
sequence work for real-root isolation (`real-root-isolate`) will reach
for the same primitive; placing it in cas-core makes that downstream
cost-free.

**Why no live oracle for Tier H.** `H-non-polynomial-1-over-x` etc.
are *bench-design* refusal cases — the expected output is a
`tagged "poly-factor-q/non-polynomial"` regardless of what any oracle
says. SymPy's `Poly.factor_list` raises on `1/x`; that's already
agreement enough. Wolfram is skipped for these cases.

## Frictions surfaced

Three. All caught and fixed within the session.

### 1. Wolfram `Factor[f, x]` is wrong syntax — Mathematica's
`Factor[]` does not accept a variable argument (it's univariate;
multivariate input is detected and refused). The first live oracle
pass returned 52/56 DROPPED with `Factor::nonopt: Options expected
beyond position 1`. Trivial fix: `Factor[f]` — correct syntax. The
agreement layer wrapped the Wolfram InputForm into SymPy and
back; once the syntax was right, all 56 cases agreed cleanly.
The friction was useful as a sanity check on the agreement
plumbing — a DROP rate of 100% was unmistakable as plumbing failure
rather than mathematics failure.

### 2. Test helper hand-rolled poly with wrong canonical ordering —
my initial `lin(a)` test helper built `Poly<Rat>` directly via
the public field representation, sorting terms with a one-line
comparator that didn't replicate `compareExp`. Two tests passed
(monic deg-1 and monic deg-≥-2 with first-position const), the
rest hit the loop-bound safety. The fix was just to use the
trusted `polyAdd(x, polyConst(...))` API instead of hand-rolling.
Lesson: when a test helper's purpose is to construct a value of a
type the codebase already constructs, **use the type's
constructor**. Hand-rolling the wire shape duplicates an
invariant that should not be re-proven in test code.

### 3. Yun loop exit condition — described above. Caught by a single
test (`3·(x - 1)^2`). The lesson: write tests for the *non-monic*
case explicitly. Without it the bug would have only surfaced on
real Tier-G content cases at integration time.

The frictions were RED in the literal sense — `bun test` reported
fail. The classic red→green→refactor TDD shape ran cleanly: write
test → see RED → fix → see GREEN → minor polish, ship.

## Acceptance

- `bench/poly-factor-q/PROMPT.md` + `DESCRIPTION.md` + `REFERENCES.md`
  + `golden/verifier_protocol.md` committed.
- `golden/generate.py` produces 56 cases on a fresh seeded run, all
  triple-witnessed (SymPy + Wolfram, 0 drops).
- `golden/verify.py` PASSes on every `expected.json` case round-tripped
  as a candidate; 56/56.
- `golden/test_mutations.py` GREEN-then-RED across 6 mutations, each
  failing on its targeted invariant.
- `packages/poly-factor` builds; `bun test packages/poly-factor/` —
  17 tests, 607 expect() calls, all green.
- `bun test packages/cas-core/test/poly-deriv.test.ts` — 9 tests, all
  green.
- `bun run check:quick` — 4 phases (convention, codegen, typecheck,
  bun test), all green.

## Pointers

- ADR-0019 (`docs/adr/0019-solve-bench-discipline.md`) — the contract
  every solve-tier bench follows. This shard is the second instance
  (after `linsolve-q`) and confirms the template generalises.
- `bench/linsolve-q/PROMPT.md` — the byte-equivalent template these
  files mirror.
- Cox-Little-O'Shea §4.5 (local PDF
  `docs/ground-truth/factor/cox-little-oshea-ideals-varieties-algorithms-4th.pdf`)
  for Yun's algorithm pseudocode and the surrounding correctness
  argument. CLO §4.6-4.8 cover Hensel, Berlekamp, recombination — the
  reading list for `0fy` and the new beads.
- `packages/cas-core/src/{poly.ts,poly-gcd.ts}` for the substrate
  primitives (`polyDeriv`, `polyGcd`, `polyDivExact`).
- `packages/poly-factor/src/squarefree.ts` for the implementation;
  `packages/poly-factor/test/squarefree.test.ts` for the invariant
  surface (`assertYunInvariants`).

## Commits

- `1032a01` — P2-1 + P2-2 ship: `bench/poly-factor-q` (skeleton +
  verifier + mutation-prove)
- `58a829c` — P2-3 ship: `packages/poly-factor::squareFree` — Yun 1976
