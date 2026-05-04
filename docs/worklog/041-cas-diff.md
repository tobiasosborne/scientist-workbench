# 041 — `cas-diff` ships: symbolic differentiation over the closed numerical vocabulary

**Date:** 2026-05-04
**Status:** complete
**Branches:** main
**ADR:** none — the algorithm and contract refer to ADR-0003 (output
patterns), ADR-0010 (defineTool/runTool split), ADR-0014/0015 (numerical
tier; cas-diff opts into the *symbolic* tier, i.e. `numerical: false`).
No new architectural decision was forced.
**Issues closed:** scientist-workbench-cnv

## Context

The `min ∫ p(x, a) dx over a ∈ [-1, 1]` exercise (see
`scripts/demo-min-integral.ts` and the conversation context that
produced it) surfaced a friction the workbench could not paper over:
to drive `optimize-lbfgs-projected` from an objective expressed as
`∫ p(x, a) dx`, you need `∂I/∂a` as an expression — and by Leibniz,
that's `∫ ∂p/∂a dx`. Without a `cas-diff` tool the agent had to
hand-derive `∂p/∂a` (or fall back on finite differences, doubling the
inner integrate-1d call count per outer iteration).

This was the cheapest, highest-leverage missing CAS tool given the
workbench's two-principles framing (TS-expert ergonomic + agent-
irresistibility): differentiation is mechanical over a closed
vocabulary, the rule table is high-school calculus, and the output's
heads must match `integrate-1d`'s closed vocabulary so the natural
sister-pipeline (differentiate-then-integrate) composes without
vocabulary mismatches.

## What changed

### `packages/cas-core/src/diff.ts` (new, ~340 LOC)

Pure-symbolic `differentiate(expr, wrt)` returning a new `Value`.
Vocabulary matches `@workbench/quadrature`'s `evalNumericExpr`:

- Heads:     `+ - * / ^ neg exp sin cos tan log sqrt abs`
- Constants: `pi`, `e`
- Leaves:    integer / rational / float64
- Variables: any symbol

Rule table is the textbook calculus surface: linearity, product
(n-ary), quotient, power-rule branches (constant exponent / constant
base / general log-chain), six transcendentals plus `abs` (handled
honestly via `(a/|a|) · da` — singular at zero, correct on R\\{0}).

Smart constructors absorb chain-rule book-keeping:
`0 + x → x`, `1 · x → x`, `x⁰ → 1`, `x¹ → x`, `neg(neg(x)) → x`,
`0/x → 0`, `x/1 → x`. No further reduction — pipe through
`cas-simplify` for full canonicalisation.

Out-of-scope discipline: any subterm with a head outside the table,
or any Value whose top-level kind isn't a mathematical scalar
(string / list / record / tagged / boolean), throws
`CasDiffOutOfScopeError`. The tool layer maps that to a top-level
`tagged "cas-diff/out-of-scope"`.

### `packages/cas-core/test/diff.test.ts` (new, ~330 LOC)

55 tests across two layers:

1. **Rule-by-rule unit tests** — for every rule in the table, build
   a small expression and assert structural equality of
   `differentiate(...)` to the expected closed form. Smart-constructor
   identities are exercised by these: `d(2·x)/dx = 2` (not `0·x + 2·1`),
   `d(x²)/dx = 2·x` (not `2·x^(2-1)·1`), etc.
2. **Numerical FD cross-check** — for an 18-expression corpus
   spanning every admitted head, evaluate `differentiate(f, x)` via
   `evalNumericExpr` at random points and compare to a centred
   finite-difference of `f` at the same points. Tolerance: relative
   error ≤ 1e-6. Centred FD has truncation error O(h²); h = 1e-6
   gives ~1e-12 truncation; total round-off ≤ 1e-7 in well-
   conditioned cases. The cross-check is the orthogonal-oracle
   verification — `evalNumericExpr` never sees the symbolic
   derivative.

A coverage-sanity test asserts every admitted head appears in the
FD corpus, so silently dropping a transcendental from the corpus
fails the test before merge.

### `tools/cas-diff/` (new tool, seven-artefact contract)

Standard scaffold via `bun scripts/new-tool.ts cas-diff --uses
cas-core,quadrature`. Schema:

```
input:  record { f: any, var: symbol }
output: any | tagged "cas-diff/out-of-scope" record { f: any, var: symbol }
```

The `f` field name mirrors `integrate-1d` and `optimize-lbfgs-
projected` for cross-tool symmetry. `var` is `integrate-1d`'s
nomenclature.

Tool body delegates to `differentiate(...)`; on
`CasDiffOutOfScopeError` it emits the boundary tag with the original
input record as payload.

`--test` hook: an 8-expression FD-cross-check corpus exercised
through the tool entry point so a regression in either the tool
wrapper or the library surfaces. Plus determinism / hash-stability
checks and a sanity check that an unknown head produces the
boundary tag at top level.

32 goldens covering every rule branch + the demo motivation
(`d(p(x, a))/da` on the original integrand) + the two out-of-scope
refusal classes.

### `packages/cas-core/src/index.ts`

Export the new surface: `DIFF_TAG`, `DIFF_ADMITTED_HEADS`,
`DIFF_ADMITTED_CONSTANTS`, `CasDiffOutOfScopeError`, `differentiate`.

### `README.md`

Catalog row for `cas-diff` immediately after `cas-verify`.

### `packages/compose/src/generated/wb.ts`

Regenerated via `bun scripts/gen-workbench-barrel.ts` to expose
`wb.casDiff(...)` on the typed barrel.

## Why these choices

### Vocabulary match with integrate-1d / optimize-lbfgs-projected, not with cas-simplify

`cas-simplify`'s vocabulary is *narrower* — it canonicalises
Q[x_1..x_n] / Q(x_1..x_n) and treats sin / cos / exp / log / sqrt /
abs as out-of-scope (wrapped in `tagged
"cas-simplify/out-of-scope"`). cas-diff is the opposite: those
transcendentals are *exactly* where the rule table earns its keep.

Match the *consumer* vocabulary, not the *sibling* vocabulary. An
agent's planner that wants to differentiate-then-integrate, or
differentiate-then-optimise, expects the cas-diff output to feed
straight into the next tool. Making cas-diff's vocabulary equal to
integrate-1d's (and optimize-lbfgs-projected's) means that pipeline
works without an intermediate scope-translation.

### Top-level boundary, not embedded tagged sub-nodes

`cas-simplify` wraps unknown-head subterms *in place* with `tagged
"cas-simplify/out-of-scope"` and lets arithmetic siblings simplify
around them. That makes sense for cas-simplify because its consumer
(the planner walking rational-function structure) needs the partial
reduction.

`cas-diff`'s consumer is different. `optimize-lbfgs-projected`'s
schema requires `grad: list<expression>` where each expression is
strictly in the closed numerical vocabulary; an embedded `tagged`
sub-node would fail the integrand vocabulary check at integrate-1d
time too. The agent gets nothing useful from a partial derivative
with tagged subterms; what they need is a binary "did this work."
So cas-diff refuses the *whole* input on any out-of-scope subterm.

### Smart constructors only — no internal cas-simplify call

The chain rule produces a lot of `0 + x` and `1 · x` book-keeping
that's pure noise for the agent. Smart constructors (`mkPlus`,
`mkTimes`, `mkPower`, `mkNeg`, `mkDiv`, `mkMinus`) absorb these
trivial identities at construction time. They do *not* attempt
algebraic simplification — `d(x · x)/dx` legitimately produces
`x + x` (not `2 · x`); like-term combination is cas-simplify's
job. The decomposition discipline (one tool, one operation) is
load-bearing here: an internal cas-simplify call would couple
cas-diff to cas-simplify's bug surface and regress the *narrower*
cas-simplify vocabulary onto cas-diff's wider one.

### `abs` via `(a/|a|) · da` rather than refusing

`d|a|/dx` is undefined at `a = 0` but well-defined elsewhere as
`sign(a) · da`. The closed vocabulary doesn't have a `sign` head, so
the natural encoding is `a/|a|` — which is in the vocabulary, evaluates
correctly under `evalNumericExpr` away from zero, and produces NaN at
exactly the point where the mathematics breaks. This keeps `abs(x)`
in scope for cas-diff (a useful integrand-class) and surfaces the
singularity honestly at evaluation time, the same way `1/x` does at
zero. A planner that needs to integrate `d|f|/dx` will hit
`integrate-1d`'s `non-finite-during-eval` boundary at any quadrature
node where `f = 0` — which is the correct mathematical behaviour.

### FD cross-check, not a SymPy manifest

For numerical-tier tools (linalg-solve, integrate-1d,
optimize-lbfgs-projected) the precedent is a frozen orthogonal-oracle
manifest from SciPy. For symbolic differentiation that pattern is
awkward: SymPy will produce a different (but equivalent) canonical
form, so byte-comparison would require a normalisation pass that's
itself non-trivial.

The FD cross-check is a strictly stronger orthogonal oracle for our
purposes: numerical evaluation is independent of symbolic
differentiation (different code path, different algorithm), and any
real bug in any rule shows up as a numerical mismatch at random
evaluation points. No reference manifest to maintain, no canonical-
form drift. The tradeoff is that we don't catch *equivalent-but-
sub-optimal* output (e.g., a derivative that's correct but uses 5
nodes where 3 would do); that's acceptable for v0.1 — the smart
constructors handle the obvious cases and `cas-simplify` is the
post-processing route for the rest.

## Frictions surfaced

### Forgot input is `Value`, not destructured fields

First implementation of the tool body was

```ts
fn: (input, _flags) => diffOrTag(input as { f, var }, ...)
```

assuming TS would let me pretend the parsed input was the inner
record. It's not — the runner hands `fn` the canonicalised Value
tree, so the access is `input.fields.f` / `input.fields.var`.
`integrate-1d`'s body already does this correctly; I should have
copied that pattern verbatim. Caught immediately by golden
generation: 32/32 cases failed with `undefined is not an object
(evaluating 'e.kind')`. ~5-minute fix.

This is the second time I've made this mistake (the first was in
some earlier port I don't remember). The pattern to internalise:
`fn: (input, _flags) => { const a = input.fields.foo as ...; const b
= input.fields.bar as ...; ... }`.

### Coverage sanity test caught a missing head

The FD-corpus coverage-sanity test (`every admitted head appears in
the FD corpus`) failed initially: I had `neg` (via
`expr("neg", [...])`) but no binary `-`. The test correctly flagged
`-` as missing; ~30-second fix to add a `(x − 3)²` probe. This is
exactly the kind of test Rule 7 ("runs without errors is not a
passing test") asks for — the test asserted a *coverage invariant*,
not just "no exceptions thrown."

### TypeScript path resolution worked without explicit tsconfig edit

Both `@workbench/cas-core` and `@workbench/quadrature` were already
in `tsconfig.json`'s `paths` map (added when those packages first
shipped), so cas-diff picked them up via the existing entries. No
tsconfig change needed — a small win for the previous iteration's
tsconfig hygiene.

## Acceptance

- `bun test packages/cas-core/test/diff.test.ts` reports 55 pass on
  47 expect calls. (FD-cross-check tests use `throw new Error(...)`
  rather than `expect(...).toBeLessThan(...)` to preserve descriptive
  point-level failure messages — the bun:test framework treats both
  identically for pass/fail accounting.)
- `bun tools/cas-diff/tool.ts --test` reports `8 corpus probes ×
  multiple points all agree with FD (rel ≤ 1e-6)` and exits 0.
- `bun run goldens --tool cas-diff` writes 32 golden files; the
  oracle phase consumes all 32 and reports `failed=0`.
- `bun run check` is green: 41 phases, 0 failed, 3 skipped (the
  registry/cas-verify tools have no `--test` hook by design).
- The `cas-diff` row exists in `README.md`'s tool catalog.
- `wb.casDiff(...)` is exposed on the typed compose barrel.
- This worklog shard exists.

## Pointers

- `packages/cas-core/src/diff.ts` — the algorithm prose + rule table
  + smart constructors + dependency-walking helpers.
- `tools/cas-diff/tool.ts` — wire wrapper, schema, examples, `--test`
  hook with FD cross-check.
- `tools/cas-diff/README.md` — operational reference + the `abs`
  honesty note.
- `packages/cas-core/test/diff.test.ts` — 55-test property battery
  including the FD-cross-check oracle and the coverage-sanity probe.
- ADR-0003 — output / error patterns (the two-category shape: happy-
  path expression vs top-level boundary tag).
- ADR-0010 — `defineTool`/`runTool` split.
- Worklog 039 — `integrate-1d` ships (the calling-convention
  precedent for `f: any, var: symbol`).
- Worklog 040 — `optimize-lbfgs-projected` ships (the
  vocabulary-match precedent for `grad: list<expression>`).
- `scripts/demo-min-integral.ts` — the friction-surfacing exercise
  that motivated this tool.
