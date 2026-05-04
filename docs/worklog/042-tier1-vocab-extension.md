# 042 — tier-1 vocabulary extension: inverse trig + hyperbolics + log bases

**Date:** 2026-05-04
**Status:** complete
**Branches:** main
**ADR:** none — additive extension to the closed vocabulary; no design
decision is forced. The deferred items the bead description names
(`min`/`max`, `floor`/`ceil`/`mod`, `gamma`/`erf`/Bessel) will need
separate ADRs when motivated.
**Issues closed:** scientist-workbench-0jn

## Context

Worklog 041 closed `cas-diff` and surfaced an obvious next step:
the closed numerical vocabulary as it stood was the bare minimum
("high-school calculus, sized to the existing reference manifests"),
but a TS expert reaches for `Math.atan`, `Math.tanh`, `Math.log2`
regularly. Their absence was the most-likely-to-bite friction in the
v0.1 surface for any agent doing routine analysis.

Each new head is mechanical (single-argument, maps directly to
`Math.*`, has a closed-form derivative expressible in the existing
vocab plus possibly itself). The whole batch was about a half-day of
edits across two packages and three test files plus README lockstep.

## What changed

### `packages/quadrature/src/eval-expr.ts`

11 new heads appended to `ADMITTED_HEADS`: `asin`, `acos`, `atan`,
`sinh`, `cosh`, `tanh`, `asinh`, `acosh`, `atanh`, `log2`, `log10`.
Each gets a one-liner case in `applyHead` calling the corresponding
`Math.*`. The vocabulary documentation block at the top of the file
was extended with domain notes for `acosh` (x ≥ 1) and `atanh` (|x| <
1), and the "Out of scope" note was rewritten to name the deferred
classes explicitly (non-smooth heads, multi-arg shapes, special
functions) rather than just "no arctan/arcsin/arccos."

### `packages/cas-core/src/diff.ts`

11 new heads appended to `DIFF_ADMITTED_HEADS` with explanatory
comment. 11 new `case` arms in `diffExpression`, each using the
existing smart constructors (`mkTimes` / `mkDiv` / `mkPower` /
`mkPlus` / `mkMinus` / `mkNeg`) and the chain rule. The literate
rule-table comment block at the top was extended with the new rules
verbatim. Notable: `tanh`'s derivative uses the textbook identity
`1 − tanh²(a)` (rather than `1 / cosh²(a)` — equivalent, but the
self-referential form keeps evaluation on a single transcendental).
`log2`/`log10` use the change-of-base identity `1 / (a · log(b))`
where `log` is natural log (the existing head).

### `packages/cas-core/test/diff.test.ts`

11 new structural-equality unit tests in a new
`describe("differentiate — tier-1 transcendentals")` block — one per
new head. 11 new probes appended to `FD_CORPUS`, each with evaluation
points strictly inside the head's natural domain (`asin`/`acos`/
`atanh`: |x| < 1; `acosh`: x > 1; `log2`/`log10`: x > 0; the others
on all of R). One additional chain-rule composition probe
(`atan(2·x)`) to stress chain on a tier-1 head. The coverage-sanity
test (`every admitted head appears in the FD corpus`) automatically
asserts all 24 heads are exercised — the test would fail before merge
if any head got dropped from the corpus.

Total new diff tests: **23 unit + 12 FD probes = 35 new tests**, on
top of the existing 55. `bun test packages/cas-core/test/diff.test.ts`
now reports 78 pass (47 → 78).

### `packages/quadrature/test/quadrature.test.ts`

4 new tests in the existing `evalNumericExpr` describe block:
- inverse-trig dispatch matches `Math.*`
- hyperbolic dispatch matches `Math.*`
- `log2` / `log10` match `Math.*` (with exact-integer probes:
  `log2(8) = 3`, `log10(1000) = 3`)
- out-of-domain inputs (`asin(2)`, `acosh(0.5)`, `atanh(2)`,
  `log2(-1)`) surface as IEEE-754 NaN — no silent zeroing.

Total quadrature tests: **34 pass** (was 30).

### `tools/cas-diff/goldens.spec.ts`

11 new golden cases — one per new head — exercising the symbolic
derivative through the wire layer. `bun scripts/generate-goldens.ts
--tool cas-diff` now writes 43 goldens (was 32).

### Documentation lockstep (Law 2)

- `tools/cas-diff/README.md`: rule table extended with all 11 new
  heads + their derivative expressions, including the domain notes.
  Closed-vocab summary line updated.
- `tools/integrate-1d/README.md`: vocab list extended; added a
  paragraph noting that out-of-domain inputs surface as
  `non-finite-during-eval` boundary tags.
- `tools/optimize-lbfgs-projected/README.md`: vocab list extended;
  out-of-scope note updated to name the next deferred classes
  (`min`/`max`, special functions).
- `README.md`: the catalog rows for `cas-diff` and `integrate-1d`
  now quote the full 24-head vocabulary verbatim.

## Why these choices

### Match `evalNumericExpr`'s vocabulary, head-for-head

cas-diff's vocabulary tracks `evalNumericExpr`'s by design (worklog
041 made this load-bearing: differentiate-then-integrate composes
without scope translation). So any vocabulary extension must land in
both packages in lockstep. The order matters: `eval-expr.ts` first
(otherwise the diff FD-cross-check would fail when it tries to
evaluate a derivative containing a tier-1 head), then `diff.ts`. We
did them in the same edit pass and ran the full test battery once
both were ready.

### `tanh`: `1 − tanh²` not `sech²` not `1/cosh²`

Three equivalent forms; chose the textbook self-referential one. The
`sech` head doesn't exist (and shouldn't — it's a third name for
`1/cosh`); the `1/cosh²` form introduces `cosh` evaluation on input
that was originally `tanh`-only, which mildly increases the
evaluation cost. The `1 − tanh²` form keeps the derivative
syntactically about the same head, and a planner reading the output
sees the textbook identity directly.

### `log2`/`log10` via change-of-base

`log2(x)` and `log10(x)` evaluate via `Math.log2`/`Math.log10`
(faster and more accurate than `Math.log(x) / Math.log(2)` because
the JS runtime gets to use base-specific instructions). But the
*derivative* uses the change-of-base identity: `d(log_b x)/dx = 1 /
(x · ln b)`. This stays within the existing vocabulary (no new
constant `ln_2`, no new head) — `log(2)` evaluates to `Math.log(2)`
at quadrature time, a constant. Trade-off: the derivative is
slightly less aesthetically clean than `log_b'(x) = 1/(x · ln b)`
where `ln b` is a literal float — but the symbolic form is
deterministic-by-construction (cross-platform bit-identical) where a
materialised float would be platform-conditional.

### Domain restrictions surface at evaluation time, not at diff time

`acosh(0.5)` is mathematically nonsense, but cas-diff doesn't refuse
it — the rule produces `1/sqrt(x²-1)`, which evaluates to
`1/sqrt(-0.75) = NaN` if a caller plugs in `x=0.5`. integrate-1d
would tag that as `non-finite-during-eval`. This is the same
discipline as `log(negative)` and `1/x at x=0`: cas-diff is purely
symbolic; domain checking happens at the boundary where the result
hits float64 arithmetic. Putting domain checks inside cas-diff would
duplicate logic that integrate-1d / optimize-lbfgs-projected
already do correctly, and would make cas-diff's contract harder to
reason about.

### One probe per head in the FD corpus, not "comprehensive coverage"

Each new probe has 3–5 evaluation points inside the function's
natural domain. The coverage-sanity test asserts presence; the FD
mismatch tolerance (rel ≤ 1e-6) is the actual correctness check. A
single probe per head is enough to catch a wrong derivative (the FD
estimate is independent of the symbolic differentiation, so any rule
typo shows up immediately at one of the probe points). More probes
buy diminishing returns; the budget is better spent extending the
corpus to chain-rule compositions involving tier-1 heads — the
`atan(2·x)` probe does this for one head, and the existing pre-tier-1
chain-rule compositions (`sin(x²)`, `exp(-x²)`, `log(1+x²)`) cover
the rule machinery.

## Frictions surfaced

### None substantive

The whole batch landed first try across all 41 check phases. The
scaffolding from worklog 041 (the FD-cross-check pattern, the smart
constructors, the rule-by-rule unit-test pattern) generalised
without modification. This is what additive design buys: extending a
closed vocabulary is genuinely additive when the discipline holds.

The only minor friction was a Markdown heading character: the
cas-diff README uses U+2212 (proper minus) in `+ − * /`, not U+002D
(ASCII hyphen-minus) — an `Edit` call with the wrong dash silently
fails. Caught immediately by the diagnostic; ~30-second fix.

### What I deferred (worth recording)

Two design questions surfaced and were deliberately *not* tackled
this session:

1. **Should the eval-vocab and diff-vocab diverge?** `floor`,
   `ceil`, `round`, `trunc`, `sign`, `mod` are useful integrand
   primitives (especially `sign` for piecewise functions) but
   non-smooth, so cas-diff would have to refuse them per-head with
   a `tagged "cas-diff/out-of-scope"`. That breaks the current
   invariant that `DIFF_ADMITTED_HEADS = ADMITTED_HEADS`. Whether
   to relax the invariant or keep eval-vocab narrower is an
   ADR-worthy decision.
2. **Special functions belong in their own package.** `gamma`,
   `erf`, Bessel functions etc. need a numerical implementation
   that's not just `Math.*` dispatch — bolting them into
   quadrature would balloon that package. A sibling
   `@workbench/special-functions` (with one tool per function or a
   single dispatch tool, TBD) is the cleaner home.

Both are tier-2/tier-3 and worth their own beads + ADRs when
motivated by a real workflow.

## Acceptance

- `bun test packages/cas-core/test/diff.test.ts` reports 78 pass
  (was 55, +23 unit tests covering 11 new heads + 12 new FD probes).
- `bun test packages/quadrature/test/quadrature.test.ts` reports
  34 pass (was 30, +4 dispatch / domain tests).
- `bun tools/cas-diff/tool.ts --test` passes (FD cross-check).
- `bun tools/integrate-1d/tool.ts --test` passes (manifest
  agreement still holds — manifest didn't reference any new heads;
  this confirms backward compatibility).
- `bun tools/optimize-lbfgs-projected/tool.ts --test` passes
  (manifest agreement still holds).
- `bun run goldens --tool cas-diff` writes 43 goldens (was 32, +11
  for the new heads); oracle byte-stable.
- `bun run check` is green: 41 phases, 0 failed, 3 skipped.
- End-to-end probes confirmed: `∫₀¹ atan(x) dx` matches `π/4 −
  ln(2)/2` to float64 via integrate-1d; `d/dx tanh(x) = 1 −
  tanh(x)²` round-trips correctly through `bun tools/cas-diff/tool.ts`.

## Pointers

- `packages/quadrature/src/eval-expr.ts` — the canonical vocabulary
  table; all consumers cite this list.
- `packages/cas-core/src/diff.ts` — the differentiation rule table
  + smart constructors. The rule-table comment at the top of the
  file is the literate-programming source-of-truth for the rules.
- `packages/cas-core/test/diff.test.ts` — 78 tests including the FD
  cross-check oracle and the coverage-sanity probe.
- `packages/quadrature/test/quadrature.test.ts` — eval round-trip
  probes for tier-1 heads.
- Worklog 041 — `cas-diff` ships (the precedent for this extension's
  rule-table format and FD-cross-check discipline).
- Bead `scientist-workbench-0jn` — original tier-1 design + per-head
  derivative table, retained for reference.
