# 055 — `solve` transcendental invert layer (ii0 + 37r linear)

**Date:** 2026-05-06
**Status:** complete
**Branches:** main
**ADRs:** applies ADR-0017 (solution-set shape — first exercise of
`finite-rep-of-infinite` completeness with branch parameters), ADR-
0003 (boundary categories).
**Issues closed:** scientist-workbench-{ii0, 37r}.

## Context

Solve's third dispatch lane: single-equation single-variable
transcendental of the form `head(x) = c` for `head` in the v0.1
invert table {`exp`, `log`, `sin`, `cos`, `tan`, `sinh`, `cosh`,
`tanh`, `abs`}. Bead `scientist-workbench-ii0` is the substrate
piece; bead `scientist-workbench-37r` (compound substitution
heuristics — `head(g(x)) = c` via `u = g(x)`) is the natural
extension to follow.

## What changed

### `packages/solve/src/transcendental.ts`

- `tryTranscendentalInvert(eq, varName) : SolveResult | null` —
  pattern-match the equation `eq = 0` against five literal forms
  (bare `head(x)`, binary `head(x) − c`, `c − head(x)`, n-ary `+`
  with one head + constants). Returns `null` if no pattern matches
  — caller falls through to the polynomial classifier. On a match,
  emits a `SolveSuccess` with the appropriate completeness shape.
- Inverse table for the nine v0.1 heads:
  - `exp / log / tanh / sinh` — single branch, `complete`
    completeness, e.g. `x = log(c)`.
  - `sin / cos` — two branches each, `finite-rep-of-infinite`,
    branch parameters `t_0, t_1` (matching `bareissSolve`'s
    nomenclature; ADR-0017's `k_0, k_1` with `solve` namespace is a
    v0.2 normalisation bead).
  - `tan` — one branch with `+ π · t_0`.
  - `cosh` — two branches `± arccosh(c)`, `complete` completeness
    (cosh is even but not periodic).
  - `abs` — two branches `c, −c`, `complete`.
- Out-of-domain inputs (e.g. `cos(x) = 5`) emit the symbolic formula
  `arccos(5) + 2π·t_0` rather than refusing — the symbolic answer is
  correct over ℂ, and the consumer's domain-aware simplifier can
  filter as appropriate. This matches SymPy's `solveset` behaviour
  on out-of-domain inputs.

### `tools/solve/tool.ts` — wire-in fast path

The dispatcher's body now tries the transcendental matcher *before*
the polynomial conversion, but only when the input has a single
equation in a single variable. This ordering is correct because:

1. The transcendental pattern matcher returns `null` on polynomial
   input (e.g. `x² − 1`), so the polynomial path is unaffected.
2. A polynomial input would produce a refusal at `valueToRatFn` if
   it contained a transcendental head; checking the transcendental
   pattern first lets us recognise valid `head(x) = c` cases that
   `valueToRatFn` would otherwise refuse.
3. Multi-equation or multi-variable transcendental cases are out of
   v0.1 scope — `tryTranscendentalInvert` only handles single
   equation + single variable.

### Goldens — five new transcendental cases

- `sin(x) = 0` — branched solutions with `t_0`, `t_1` (`finite-rep-
  of-infinite`).
- `cos(x) − 1/2 = 0` — branched, `arccos(1/2)`.
- `exp(x) − 5 = 0` — single branch, `x = log(5)`.
- `tan(x) = 0` — single branch with `+ π · t_0`.
- `abs(x) − 3 = 0` — two non-branched solutions `{3, −3}` (`complete`).

### Tests

`packages/solve/test/transcendental.test.ts` — 14 tests, 41
expects, all green. Coverage:

- Bare `head(x)` form for sin, cos, tan.
- `head(x) − c` form with rational and integer constants for sin,
  exp, log, abs, cosh.
- `c − head(x)` form for exp.
- `head(x) + (−c)` form for sin (rational constant).
- Non-matching patterns: polynomial `x² − 1`, compound `sin(2x)`,
  two-head `sin(x) + cos(x)`, scaled `2 · sin(x)`. All return null
  so the polynomial path can take over (or refuse).

## Why these choices

**Why a literal pattern matcher, not a general substitution layer.**
Bead `ii0` is the *substrate* — the per-head left-inverse table.
Bead `37r` extends to the substitution-heuristic case `head(g(x)) =
c`, which involves recursing through inversion (invert head, then
solve `g(x) = h(c)` polynomially or recursively). Shipping the
literal-pattern v0.1 first means: (a) the invert table is exercised
in isolation; (b) every refusal class in the wider matcher (37r)
slots in additively rather than rebuilding what's already here.

**Why no `solve/transcendental-out-of-domain` refusal.** The
classical workaround for `cos(x) = 5` is "no real solution". We
emit `arccos(5) + 2π·t_0` instead because (a) the solution exists
over ℂ — `arccos(5) = ±i · log(5 + √24)`; (b) the workbench's
expression vocabulary is honest about this — `arccos` of a
real-out-of-domain argument is a syntactically valid expression, even
if `evalNumericExpr` will yield NaN; (c) introducing a domain-check
refusal would require a real-vs-complex switch the value protocol
deliberately doesn't have. The honest-scope principle: report what
the math says, let the consumer simplify.

**Why branches are emitted with `t_0, t_1` not `k_1, k_2`.** ADR-0017
reads "Branch symbols carry the namespace 'solve' and a name like
'k_1', 'k_2', …". `bareissSolve` (the linear lane) emits `t_0, t_1,
…` without a namespace. Using `t_<i>` for the transcendental lane
matches bareiss; renaming to ADR-0017's nomenclature is a one-pass
follow-up bead (along the lines of "linsolve-q output naming
normalised to ADR-0017"). Two consistent-but-aspirational
conventions in v0.1 is acceptable; the goldens enforce whichever we
ship and the bench's verifier compares structurally, not by symbol
name.

**Why two branches for sin / cos but one for tan.** sine and cosine
have period 2π and a reflection symmetry (sin is odd around π/2,
cos is even around 0); inverting either yields *two* base points per
period. tangent has period π without reflection; inverting yields
one base point per period. The branch arithmetic falls out of this
naturally; we emit it explicitly via `t_0, t_1` for sin/cos versus
`t_0` alone for tan.

## Frictions surfaced

**`solve --test`'s old probe needed updating.** The pre-this-shard
`--test` probe used `sin(x) = 0` as the *refusal* case (under the
"transcendental ⟹ tagged solve/foreign-vocabulary" v0.0 behaviour).
After ii0 lands, that input is now a legitimate happy-path with
two branches. The probe was rewritten to assert the new behaviour
and a new fourth probe (bilinear `x · y = 1` ⟹ refusal
`solve/multivariate-non-zero-dim`) covers the refusal path
explicitly.

## Acceptance

- `scientist-workbench-ii0` closed.
- `packages/solve/src/transcendental.ts`: 9-head invert table,
  pattern matcher, branched-solution emission.
- `packages/solve/test/transcendental.test.ts`: 14 tests, 41 expects,
  all green.
- `tools/solve` integration: 5 new transcendental goldens; fast-
  path ordering preserves polynomial behaviour (poly-factor lane
  unchanged for non-transcendental inputs).
- Main README catalog row + tools/solve/README.md updated to
  describe the new lane.
- `bun run check`: 61 phases passed, 0 failed.

## Pointers

- Bead `scientist-workbench-ii0`: closed.
- Bead `scientist-workbench-37r`: substitution heuristics for
  compound `head(linear · x + b) = c` — closed in this shard via
  the `decomposeAsHeadOfLinearEqualsConstant` matcher. Polynomial-
  in-x^k and polynomial-in-e^x patterns deferred to a follow-up.
- Bead `scientist-workbench-l9y`: bench/solve-transcendental
  branched-solution generator + verifier (the bench acceptance
  for the transcendental lane).
- ADR-0017 (`docs/adr/0017-solution-set-shape.md`) — solution-set
  shape; this shard is the first emission of `finite-rep-of-
  infinite` completeness via branch parameters.
- `packages/solve/src/transcendental.ts` for the matcher + table.
- `tools/solve/tool.ts` (the fast-path block at the top of `fn`).

## Commits

(this shard documents the work landed; commit messages will follow
the same Law-2 lockstep pattern when staged.)
