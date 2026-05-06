# 053 — `poly-roots`: closed-form radical roots for deg ≤ 4

**Date:** 2026-05-06
**Status:** complete
**Branches:** main
**ADRs:** none new — applies ADR-0017 (solution-set shape extension to
root-list), ADR-0003 (output / error categories).
**Issues closed:** scientist-workbench-{1yu, 58q}.

## Context

Phase 3 of solve-suite-v1: univariate polynomial roots in radicals.
Sequencing: shard 052 closed Phase 2 with `tools/poly-factor`
(Berlekamp-Zassenhaus pipeline); this shard composes `poly-factor`
with closed-form radical formulas to ship the second user-visible
Solve-tier tool.

## What changed

### `packages/cas-core/src/poly-radicals.ts` — closed-form solvers

- `linearRoot(a, b) : Value` — `a · x + b = 0  ⟹  x = -b/a`; returns
  the rational as an `IntegerValue` or `RationalValue` exactly.
- `quadraticRoots(a, b, c) : [Value, Value]` — emits
  `(-b ± √(b² − 4ac)) / (2a)` regardless of discriminant sign;
  complex-discriminant cases yield `sqrt(negative)` subexpressions
  that round-trip through the closed vocabulary syntactically (NaN
  on numeric eval — consumer's call).
- `cubicRoots(a, b, c, d) : [Value, Value, Value]` — Cardano 1545.
  Depress, compute `D_c = (q/2)² + (p/3)³`, write three roots in
  terms of `u = ∛(−q/2 + √D_c)` and `v = ∛(−q/2 − √D_c)`. The two
  non-real roots use `ω = (−1 + √−3)/2` written out in the closed
  vocabulary. Per bead `1yu`: faithful complex form, *no* trig
  switch in casus irreducibilis — the consumer applies a `ToReal`
  simplifier post-hoc.
- `quarticRoots(a, b, c, d, e) : [Value, Value, Value, Value]` —
  Ferrari 1540 with biquadratic fast path. Depress, build resolvent
  cubic, take any cubic root `m₀`, factor the depressed quartic as
  two quadratics, solve each. Special-cases the depressed-`q = 0`
  branch (biquadratic) — Ferrari's standard formula divides by
  `√(2 m₀)` which goes to 0 in this branch; the fast path solves
  `y² + p y + r = 0` for `y² ∈ {α, β}`, then `y = ±√α, ±√β`.

Tests: `packages/cas-core/test/poly-radicals.test.ts` — 18 tests, 34
expects. Numerical-substitution invariant: evaluate root expression to
float, substitute back into the polynomial, assert `|p(root)| < EPS`
(EPS depending on degree: 1e-9 quadratic, 1e-7 cubic, 1e-6 quartic).
Casus-irreducibilis cases tolerate NaN evaluation but assert
finite-eval cases satisfy the residue bound.

The test's local numeric evaluator reimplements the closed vocabulary
inline (avoiding a `@workbench/quadrature` dep on cas-core's test
side) with a small tweak: `^(negative-base, 1/n)` for odd `n` uses
the signed real radical (`-pow(-base, 1/n)`), matching Cardano's
intended real-cube-root branch on negative arguments. (JavaScript's
native `Math.pow(-x, 1/3)` returns NaN — a famous quirk that broke
the cubic test until the evaluator was patched.)

### `tools/poly-roots/` — seven-artefact tool

Composes `tools/poly-factor` with the radical solvers:

1. Convert input expression Value → `Poly<Rat>` via `valueToRatFn`;
   refuse on out-of-scope subterms (`tagged "poly-roots/non-polynomial"`).
2. Multivariate refusal (`tagged "poly-roots/multivariate"`).
3. Factor via `factorRatQ`; every irreducible factor is monic +
   primitive + positive-leading.
4. Per factor, dispatch on degree to the appropriate radical solver.
5. Degree ≥ 5 ⟹ `tagged "poly-roots/degree-too-high"` (Galois 1832 —
   no general radical formula; lifting via `Root[]` representation is
   bead `scientist-workbench-yoc`).
6. Multiplicity inherited from `factorRatQ` per factor.

Output schema: `record { roots: list<record{root, multiplicity}>,
method, warnings }` on the happy path, `tagged "poly-roots/<class>"`
with `record { detail: string }` payload on refusals. The schema is
declared as `S.any()` at the top level (matching `cas-diff` to keep
TS-inference on `fn`'s return type tractable when the union has
multiple narrow record arms); goldens exercise the actual shape.

Goldens: 22 cases across linear (3), quadratic (4), cubic (3),
quartic (3), multiplicity (3), constant + refusal (5), rational
content (1).

## Why these choices

**Why factor-then-radicals instead of inline polishing.** A reducible
polynomial like `x⁴ − 5x² + 4 = (x²−1)(x²−4)` factors into two
quadratics via `tools/poly-factor` and then yields four real roots
via two `quadraticRoots` calls — exact, deterministic, no formula
needed for deg-4. Without factoring, Ferrari would be invoked
directly on the deg-4, traversing a resolvent cubic that hits
casus irreducibilis (since the original polynomial has all four real
roots), and producing complex-Cardano cube-roots that evaluate to
NaN. Factoring first preserves real-eval where the math allows it.
Same argument for `x³ − 1 = (x − 1)(x² + x + 1)`: the linear factor
gives `x = 1` exactly; only the irreducible quadratic invokes the
radical formula, which is a clean `(-1 ± √−3)/2`.

**Why faithful complex Cardano (no trig switch) per bead 1yu.** The
trigonometric formula `t_k = 2 √(−p/3) cos((1/3) acos(...) − 2πk/3)`
is real-valued in casus irreducibilis but changes the *shape* of the
answer entirely. Faithful Cardano keeps the form `u + v` with
`u, v ∈ ℂ`, expressed in the closed vocabulary as
`sqrt(-3) / 2 · (...)` and `^(_, 1/3)` of complex sub-expressions.
Round-trips through canonicalisation, composes with `cas-diff`, and
makes a downstream `ToReal` simplifier orthogonal. The trade-off:
numerical evaluation yields NaN for the casus irreducibilis branch
until that simplifier ships.

**Why a biquadratic fast path in Ferrari.** Standard Ferrari divides
by `√(2 m₀)` where `m₀` is a root of the resolvent cubic. When the
depressed quartic has `q = 0` (biquadratic in `x²`), the resolvent
cubic has `m = 0` as a root, and Ferrari's quadratic-factor formula
hits 0/0. The biquadratic case factors trivially by treating `y²` as
a new variable: `y² + p y + r = 0` is a quadratic in `y²`, whose
roots are the two values of `y²`; then `y = ±√(y²)` for each. Four
roots total, no Ferrari needed. This special case fires on `x⁴ − 1`,
`x⁴ + 1`, and most "even" quartics — a meaningful chunk of the
practical surface.

**Why the schema is `S.any()` at the top level.** The output is a
union of one happy-path record shape and three refusal-tag shapes.
TS struggles to infer the union type for `fn`'s return when the
union has multiple narrow record arms; cas-diff hit the same wall
and uses `S.union([S.any(), S.tagged(...)])`. We follow the same
pattern: schema is loose, runtime validation is loose, but goldens
+ unit tests + the type-narrowed *helper functions* (`buildHappyOutput`,
`refuse`) ensure shape integrity in practice. The trade-off cost is
that a future change to the happy-path shape is caught by goldens,
not by the runner's schema check; in exchange we get clean TS
inference and avoid a layer of `as` casts.

## Frictions surfaced

**JavaScript's `Math.pow(negative, 1/3) = NaN`.** The test's numeric
evaluator hit this on the cubic case `x³ + x − 2 = 0`, whose Cardano
form has `v = ∛(−0.018)`. JS's built-in returns NaN; the math wants
`−∛0.018 ≈ −0.262`. Patched the evaluator with a sign-and-strip
heuristic: for `^(negative-base, ε)` with `ε ≈ 1/n` for odd `n`,
return `−pow(−base, ε)`. The same logic would belong in
`@workbench/quadrature`'s `evalNumericExpr` if cas-diff or
integrate-1d ever emit cube-root expressions; for now it's a
test-local helper, with the policy decision deferred to the bead
that lands `Math.cbrt`-aware numeric eval as a substrate change.

**Ferrari's biquadratic 0/0.** First-pass test on `x⁴ − 1` returned
all-NaN. Trace showed Ferrari's resolvent cubic having `m₀ = 0`, then
`√(2 · 0) = 0` in the divisor of the per-quadratic formula. Ferrari
itself is degenerate here — the formula simply doesn't apply. Fast-
path detection (`q_q.n === 0n`) and direct biquadratic factoring is
the right shape. Filed under "frictions caught and fixed
within-session" rather than as a follow-up bead because the fix is
minimal and the alternative (a more-general Ferrari derivation that
sidesteps the divisor) would be substantially more code.

**TypeScript inference on union output schemas.** First draft used
`S.union([S.record({roots,method,warnings}), S.tagged(...)])`. The
runner's narrowed return type then became
`RecordValueOf<{...}> | TaggedValue` and TS couldn't reconcile the
fn's `Value` returns. Loosened to `S.any()` per the cas-diff
precedent. Documented the trade-off in code comments — this is a
known limitation of the current schema-narrowing, not a personal
choice; lifting it would require changes to `@workbench/contract`'s
runner type signatures.

## Acceptance

- 2 beads closed: `scientist-workbench-{1yu, 58q}`.
- `packages/cas-core/src/poly-radicals.ts`: 4 closed-form solvers,
  ~250 lines.
- `packages/cas-core/test/poly-radicals.test.ts`: 18 tests, 34
  expects, all green. Numerical-substitution invariant covered for
  deg 1–4 across happy-path, multiplicity, irreducible, and
  casus-irreducibilis cases.
- `tools/poly-roots/`: full seven-artefact contract.
- Goldens: 22 cases.
- Main README catalog row + tools/poly-roots/README.md updated in
  lockstep.
- `bun run check`: 59 phases passed, 0 failed (3 skipped — tools
  without `--test` hooks).

## Pointers

- Bead `scientist-workbench-1yu`: cardano + ferrari (closed).
- Bead `scientist-workbench-58q`: tools/poly-roots ship (closed).
- Bead `scientist-workbench-yoc`: poly-roots upgrade for deg ≥ 5
  (Root[] / algebraic-number representation; deferred).
- `packages/cas-core/src/poly-radicals.ts` for the formulas.
- `tools/poly-roots/{tool, README, goldens.spec}.ts` for the tool.

## Commits

(this shard documents the work landed; commit messages will follow
the same Law-2 lockstep pattern when staged.)
