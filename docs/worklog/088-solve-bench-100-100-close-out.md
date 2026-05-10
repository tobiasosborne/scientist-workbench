# 088 — `solve` bench close-out: 100/100 cases, 354/354 invariants (`3g9x` + `ay4u`)

**Date:** 2026-05-10 (one session, immediately after worklog 087's
Gröbner substrate ship).
**Beads:** `scientist-workbench-3g9x` (P2 bug — pre-existing
transcendental-lane drift in `bench/solve`) and
`scientist-workbench-ay4u` (P2 task — corpus verifier needs
multivariate-poly lane after `x8d`).
**Lockstep with:** corpus changes in
[`benchmarks/solve/`](https://github.com/tobiasosborne/scientist-workbench-corpus/tree/main/benchmarks/solve).
This shard documents the workbench-side surface; the corpus-side
surface is mirrored in `scientist-workbench-corpus`'s own worklog.

## Context

Worklog 087 shipped Phase 3 of `x8d` (Gröbner substrate +
multivariate-poly lane in `tools/solve`).  Three open beads remained:

- `3g9x` — six pre-existing drift cases in the corpus
  `bench/solve`'s `rand.transcendental-univariate` tier.  Two
  ("UPGRADED": `tan(-2x+2)+3=0`, `sin(-4x+1)+1/3=0`) had been added
  to `tryTranscendentalInvert` post-bench-author-time and now solve
  honestly; four ("NOT-YET-SHIPPED": `log(-3x-3)-2=0`,
  `cosh(4x-3)-3=0`, `|-3x-1|=0`, `log(-3x-1)-1=0`) were refusing
  with `solve/foreign-vocabulary` despite their head being in the
  v0.1 invert table.
- `ay4u` — corpus-side: extend `solve_reference.py` and `verify.ts`
  with a multivariate-poly lane so the 25 `rand-mv-*` cases the
  workbench now correctly solves stop regressing the bench grade.
- `b55` — solve-suite-v1 epic close-out, blocked by `3g9x`.

Pre-shard grade: **70/100** cases (94 baseline minus the 24 mv-tier
regressions worklog 087 introduced when the workbench started
honestly emitting happy-path on zero-dim ideals).

This shard takes the bench from **70/100 → 100/100** and closes
both directions of drift in lockstep.

## What changed

### `packages/solve/src/transcendental.ts` — Sub-shape D (`3g9x`)

The "linear-arg decomposer" in `decomposeLinearInVar` had three
sub-shapes:

- **A:** `c · varName`               (no offset).
- **B:** n-ary `+`-sum with one `c·varName` summand.
- **C:** `varName − b`               (a = 1 only).

The corpus parser's left-associative `+ −` chain emits
`-3*x - 3` as `expr("-", [expr("*", [-3, x]), 3])` — a `c·varName − b`
shape the existing Sub-shape C did not admit because it required a
bare `varName` on the LHS.  Result: `head(-3*x - 3) − k` matched
neither Sub-shape B (head not in n-ary `+`) nor Sub-shape C
(non-bare LHS), the linear-arg path returned `null`, and `solve`
fell through to the polynomial classifier which threw
`foreign-vocabulary` because `log` / `cosh` / `abs` are non-poly.

Added **Sub-shape D**: `c · varName − b` with the coefficient on
either side of the `*`.  The fix is structural — it merges with C
into a single `expr("-", [left, b])` arm that recognises bare
`varName` (Sub-shape C) or `c · varName` Mul (Sub-shape D) on the
LHS.  Six lines of new code; one paragraph of comment naming the
bench-side rationale (parser left-associativity + invert-table
admissibility).

A regression probe is added to `tools/solve/tool.ts`'s `--test`
hook (Probe 7: `log(2*x − 3) = 1`).

### `packages/groebner/src/shape-extract.ts` — real-root gate + ROOT_VAR rename

Two latent bugs surfaced when the corpus's mv-poly tier started
exercising the deg-2/3/4 shape-lemma path (worklog 087's closure
left them dormant — every `--test` probe and corpus mv-tier case
prior to today had `vars[-1] === "x"` so the alg-num rename gap
never triggered, and only one mv-tier case had a non-shape lex GB
which already surfaced via `shape-lemma-failure`).

**Bug 1 — complex-root leak through deg-2/3/4 radicals.**  The
shape-lemma extractor dispatched each ℚ-irreducible factor of `g_n`
by degree: deg 1 via `linearRoot`, deg 2-4 via `quadraticRoots` /
`cubicRoots` / `quarticRoots`, deg ≥ 5 via VAS-isolated `Root[poly,
k]` *with a real-root count gate* (refuse `complex-roots-not-yet-
named` if any factor's real-root count was below its degree).  The
deg ≥ 5 gate did not extend to deg 2-4: a deg-2 factor with
negative discriminant (e.g. `[x²+y²-3, xy-3]`'s y-poly
`y² - 3y + 3`) would silently flow `(b ± sqrt(disc))/(2a)` through
`quadraticRoots`, leaking `sqrt(neg)` into solution bindings — a
`Solve[]`-class lie under ADR-0017's honest-scope contract.

Fix: lift the real-root counting (via `isolateRealRoots` on the
factor's coefficient vector) before the radical dispatch for *any*
deg ≥ 2 factor.  When the count is below the degree, refuse with
`complex-roots-not-yet-named`.  This unifies the deg-2-4 and
deg-≥5 paths under a single uniform gate and matches the workbench's
univariate-poly lane (which already gated complex roots in the
deg-≥5 case via `tools/poly-roots`).

**Bug 2 — `polyToHighToLowRat(minpoly, ROOT_VAR)` when `v != "x"`.**
`canonicalIntegerForm(g, v)` returns a `Poly<bigint>` whose terms
are still indexed by `v` (the input variable).  `polyToHighToLowRat`,
`lowToHighIntCoeffs`, and the rest of the alg-num substrate hard-code
`ROOT_VAR = "x"` as the carrier variable.  When the lex-last shape
variable was `"y"` or `"z"` (every multivariate case in the bench),
`polyCoeffsInVar(_, "x")` saw an x-degree-0 constant, the constant
failed `polyConstValue`'s singletonness, and `isolateRealRoots`
threw `"zero polynomial after denom-clear"` on a `[Rat(0)]`
coefficient list.

Fix: rename the factor's variable from `v` to `ROOT_VAR` before
calling `canonicalIntegerForm`.  A small `renameSingleVar<T>(p,
fromVar, toVar)` helper walks each term's `exp` array and replaces
the variable name with a defensive throw on any unexpected
appearance.  The rename is the cleanest fix because the alg-num
contract — `Root[Polynomial[…], k]` always carries a polynomial
in `ROOT_VAR` — is canonical and load-bearing for `rootToValue`'s
encoding.

Both bugs were latent in the deg-≥5 path too (the existing code
threaded `ROOT_VAR` everywhere and worked only because every
existing test had `v === "x"`).  The new gate exercises the alg-num
substrate with `v ∈ {"x", "y", "z"}` and exposes the gap; fixing
once at the gate site fixes both call paths.

### `tools/solve/tool.ts` — Probe 7

```ts
// Probe 7: transcendental linear-arg Sub-shape D — log(c·x − b) = k.
// Regression for bead 3g9x: pre-fix, the linear-arg decomposer
// accepted `varName − b` (Sub-shape C) but not `c·varName − b`,
// so SymPy-style equation strings of the form `log(-3*x - 3) - 2`
// refused as `solve/foreign-vocabulary`.  Mirrors corpus case
// rand-trans-004.
```

The probe builds `expr("log", [expr("-", [expr("*", [2, x]), 3])])
- 1` and asserts `kind === "record"` with one solution.

### Corpus side (cross-referenced; not in this repo)

The full `ay4u` close-out lives in
`scientist-workbench-corpus/benchmarks/solve/`:

- **`reference/solve_reference.py`** — added `_solve_multivariate`
  with five staged gates mirroring `solveGroebner` bit-for-bit:
  lex GB → constant-1 short-circuit → Macaulay zero-dim test
  (`_is_zero_dim`) → shape-lemma gate (`_is_lex_gb_shape_form`) →
  SymPy `solve(eqs, vars, dict=True)`.  Refusal classes match
  workbench tags exactly.  Also fixed `_decompose_head_eq_const`
  to admit SymPy's odd-function unfolds (`tan(-y) → -tan(y)`)
  via a new `_extract_head_with_coeff` helper handling the
  `c · head(arg)` form.
- **`golden/verify.ts`** — added `multivariate-poly` lane (3
  checks: shape, each_solution_satisfies, completeness_correct);
  fixed two pre-existing parser bugs surfaced by the new lane
  (`+` followed by unary `-` in the float64 evaluator; `neg(x)`
  function name from cas-core radicals); narrowed the
  transcendental `completeness_grid` window to the cube's actual
  `[cubeMin, cubeMax]` reach (the pre-fix `±max(|cube|)` symmetric
  scan flagged false-positive completeness violations on
  asymmetric tan/sin invert images).
- **`golden/generate.py`** — `classify_lane` now returns
  `multivariate-poly` for nonlinear multivariate inputs that
  `solve_reference` admits as ok.  Optional `oracle.wolfram`
  import wrapped in try/except so corpus-side regen runs without
  the workbench's `bench/_corpus/` tree.
- **`manifest.toml`** — fifth lane added to verifier.checks
  registry; description + tolerance docs updated; previous
  "Known failures" stanza retired (drift fully closed).
- **`golden/expected.json`** — regenerated; sha256 updated in
  manifest.

## Why these choices

**Why a single Sub-shape D arm rather than a generic "linear in
varName" decomposer?**  Tempting to replace the four hand-rolled
sub-shapes with a `valueToRatFn(arg, [varName])` extraction.  But
`valueToRatFn` lives in `cas-core` and `cas-core ← solve` would
introduce a circular workspace dependency.  The PRD §"Substrate
discipline" forbids that direction; the fix mirrors C's structure.

**Why a uniform real-root gate at deg ≥ 2 rather than per-degree
discriminant logic?**  The deg-2 discriminant `b² - 4ac < 0` test
is cheap, but cubic / quartic discriminants are messy and the
real-root *count* (not just sign) is what the
`complex-roots-not-yet-named` contract requires.  `isolateRealRoots`
returns the count for free; the existing deg ≥ 5 path already
relied on it.  Uniformity > micro-optimisation here — the bench's
factor sizes are tiny (deg ≤ 4 over coefficients in `[-9, 9]²`),
VAS isolation is microseconds.

**Why fix the alg-num `ROOT_VAR` rename in shape-extract rather
than canonicalIntegerForm?**  Two-call-site fix vs N-call-site fix.
`canonicalIntegerForm`'s contract — "produce a Poly<bigint> in the
input variable's frame" — is depended on by other callers
(`tools/poly-roots`, `packages/alg-num`'s constructors); changing
it would ripple.  The rename helper at the shape-extract call site
is local, two-line, and named explicitly enough that future
callers extending the alg-num substrate will spot the convention.

**Why mirror SymPy's `solve` failure modes onto workbench's
refusal tags rather than just emit happy-path everywhere SymPy
solves?**  The bench's value isn't "does someone solve it" but
"does the candidate match the reference's verdict".  If the
workbench refuses `shape-lemma-failure` while the reference admits
happy-path, the bench fails a tag-mismatch — that's the bench
working correctly.  By mirroring the workbench's gate ordering
(zero-dim → shape → solve) in the reference, refusal-tag agreement
becomes mechanical.  The bench's mutation-prove harness benefits:
perturbing either side surfaces the disagreement immediately.

## Frictions surfaced

**Friction 1: SymPy normalisation hides reference bugs.**
`sp.sympify("tan(-2*x + 2)")` auto-simplifies to `-tan(2*x - 2)`
via the odd-function identity.  The reference's
`_decompose_head_eq_const` was matching only bare `head(arg)` Add
arguments, so `-tan(2*x - 2) + 3` (one `Mul(-1, tan)` term + one
constant) yielded no head match and refused.  The first regen
incorrectly classified rand-trans-002/009/011 as `refusal` lane,
which then mismatched the candidate's (correct) ok output.

Resolved by extending the decomposer with `_extract_head_with_coeff`
that admits any `c · head(arg)` Mul form.  The pattern was always
in scope per `transcendental.ts:30-42`'s comment block; the
reference simply hadn't ported the full pattern set.

**Friction 2: parser regression in verify.ts unary-minus fix.**
First attempt at the unary fix wired `parseAddSub → parseUnary`
directly, bypassing `parseMulDiv` entirely.  Result: `8 / 4 / 2`
parsed as `8` (parseUnary returned 8, parseAddSub's loop saw `/`
which isn't `+`/`-`, broke, "trailing tokens").  Fixed by keeping
the canonical chain `parseAddSub → parseMulDiv → parseUnary →
parsePow → parseAtom`; the unary layer threads between mul-div
and power-and-atom so every multiplicative term position absorbs
its sign without disturbing left-associativity.

A right-associativity regression on `/` would have been far harder
to spot — the test corpus has few `a / b / c` chains.  Cautionary:
when reordering precedence, always verify left-associative
operators with a 3-operand chain (`8 / 4 / 2 = 1`, not `4`).

**Friction 3: grid-window asymmetry false-positives.**  The
transcendental `completeness_grid` check scanned `[-win, win]`
where `win = max(|cube|)` — symmetric.  For asymmetric cube ranges
(any invertible-head equation with nonzero linear coefficient,
e.g. `tan(-2x + 2) + 3 = 0`'s cube `[-3.09, 6.34]`), the grid
extended past `cubeMin` into territory the cube cannot reach,
finding "unmatched" grid roots that were really branches `k > 3`
the cube simply doesn't enumerate.  Fix: scan `[cubeMin, cubeMax]`
clamped to `±GRID_HI`.  My first attempt at this fix expanded
rather than narrowed (`min(cubeMin, -win)` instead of just
`cubeMin`); the second attempt was correct.

**Friction 4: workbench rename gap surfaced post-grade.**  The
post-`x8d` 96/100 grade looked like the close-out was nearly done
(2 transcendental drift + 4 mv tag mismatches).  Tightening the
shape-extract complex gate dropped to 86/100 because the latent
ROOT_VAR rename gap exploded — every multivariate case with `v
!= "x"` started throwing `tool_error`.  The fix recovered to 98/100;
fixing the asymmetric grid window closed the last two cases to
100/100.  The lesson: a real-root *count* test on a polynomial in
`y` requires the polynomial actually be parseable as a polynomial
in `y` by the substrate that does the counting.  The alg-num
substrate's hard-coded `ROOT_VAR = "x"` is a load-bearing convention
documented nowhere in code (only ADR-0018 §"Wire encoding" hints).
Worth a follow-up: either rename in `canonicalIntegerForm` itself
(documented in ADR-0018) or add an assertion at every alg-num
public entry point.

## Acceptance

- **`bun run check:quick`** — 4/4 phases pass (convention-drift,
  codegen, typecheck, bun test); 212s for the full inner-loop
  cycle.  No regression; the only test-suite touchpoint is
  `tools/solve --test` Probe 7 (new), all six existing probes
  pass unchanged.
- **`bun tools/solve/tool.ts --test`** — 7 probes pass (linear,
  univariate-poly, transcendental simple, refusal,
  multivariate-happy, multivariate-inconsistent, transcendental
  linear-arg).
- **`bun tools/groebner-basis/tool.ts --test`** — 6 probes pass
  unchanged (the workbench's groebner package stayed otherwise
  untouched; the change is local to `shape-extract.ts`'s
  `rootsOfGn`).
- **`bash scripts/bench-grade.sh solve`** — **100/100 cases,
  354/354 invariants** (was 70/100 before, 96/100 after the
  initial corpus extension, 98/100 after the workbench shape-
  extract fix).
- **`bun src/cli.ts validate`** (corpus side) — clean: 582 caps,
  15 suites, 15 adapters.
- **Beads:** `3g9x` closed; `ay4u` closed; `b55` newly unblocked
  (its acceptance is "transcendental scope close-out", which the
  Sub-shape D extension delivers).

## Pointers

- Workbench-side fixes:
  - [`packages/solve/src/transcendental.ts`](../../packages/solve/src/transcendental.ts) —
    Sub-shape D in `decomposeLinearInVar`.
  - [`packages/groebner/src/shape-extract.ts`](../../packages/groebner/src/shape-extract.ts) —
    real-root gate + `renameSingleVar` helper.
  - [`tools/solve/tool.ts`](../../tools/solve/tool.ts) — Probe 7.
- Corpus-side fixes (sister repo): `benchmarks/solve/{reference/solve_reference.py,
  golden/verify.ts,golden/generate.py,manifest.toml}`.
- Originating beads: `scientist-workbench-{3g9x, ay4u, b55}`.
- ADRs touched: none (the changes are bug-fixes within already-
  documented contracts; ADR-0017's solution shape and ADR-0029's
  Gröbner gate ordering both already permit the new behaviour).
- Worklog ancestor: `087-groebner-substrate-and-multivariate-solve.md`
  (the Phase 3 ship that surfaced both drifts).
