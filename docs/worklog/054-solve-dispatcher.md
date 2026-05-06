# 054 — `solve`: top-level dispatcher (linear + univariate-poly v0.1)

**Date:** 2026-05-06
**Status:** complete
**Branches:** main
**ADRs:** applies ADR-0017 (solution-set shape), ADR-0003 (boundary
categories). No new ADRs.
**Issues closed:** scientist-workbench-{77b, cfd, fij, 80x}.

## Context

Phase 3 closeout for the v0.1 solve-suite: ship the user-facing
`tools/solve` that dispatches to the substrate built across worklogs
050 (`linsolve-q`), 052 (`poly-factor`), 053 (`poly-roots`). The bead
set 77b/cfd/fij/80x is the natural unit — classifier + linear path +
univariate-polynomial path + tool ship. Multivariate (Gröbner),
transcendental (invert-and-substitute), and parametric branching are
deferred to follow-up beads; this v0.1 refuses them honestly.

## What changed

### `packages/solve` — new package

- **`src/classify.ts`** — `classifyInput(eqs, vars)` returns one of
  three verdicts:
  - `linear` — every equation has total degree ≤ 1 in `vars` *and*
    no cross-variable products (`x · y` is bilinear, not linear).
    Carries the `(A, b)` rational matrix extraction inline.
  - `univariate-poly` — single equation, single variable, deg ≥ 1.
  - `unsupported` — refusal class string + detail. Roster includes
    `multivariate-non-zero-dim`, `parametric-non-trivial`,
    `constant-equation`, `empty-input`, `empty-vars`.
- **`src/dispatch.ts`** — `dispatchClassified(verdict, vars)` executes
  each lane:
  - linear → `bareissSolve` over the extracted `(A, b)`; map result to
    ADR-0017 `Solution { bindings, branches }` shape (unique →
    one binding-only solution; under-determined → one solution with
    branches; inconsistent → empty `solutions` list).
  - univariate-poly → `factorRatQ` then dispatch each irreducible
    factor by degree to `linearRoot` / `quadraticRoots` / `cubicRoots`
    / `quarticRoots`. Multiplicities preserved per factor (a triple
    root produces three identical-binding `Solution` entries). Deg ≥ 5
    irreducible ⇒ refusal `high-degree-irreducible`.
  - unsupported → propagate refusal (caller wraps as tagged).

Tests: `packages/solve/test/{classify, dispatch}.test.ts` — 19 tests,
57 expects. Each lane covered for unique / under-determined /
inconsistent / refusal; multiplicity discipline verified for
`(x − 1)²`; classifier's bilinear-detection (`x · y` not linear)
explicitly tested.

### `tools/solve` — the seven-artefact tool

Wraps `@workbench/solve` behind the standard contract:

- Input: `record { eqs: list<expression>, vars: list<symbol> }`.
- Output: ADR-0017 happy-path record OR `tagged "solve/<class>"`
  with `record { detail: string }` payload. Class roster matches
  ADR-0017's table: `high-degree-irreducible`, `multivariate-non-
  zero-dim`, `parametric-non-trivial`, `foreign-vocabulary`,
  `constant-equation`, `empty-input`, `empty-vars`.
- Schema declared as `S.any()` at the top level (matching `cas-diff`
  and `poly-roots` — TS-inference on a tight union is fragile;
  goldens enforce shape integrity).
- Goldens: 20 cases spanning linear unique / inconsistent / under-
  determined, single-variable linear, 3×3 unique system, univariate
  quadratic / cubic / quartic, multiplicity, deg-5 refusal,
  transcendental refusal, rational-function refusal, bilinear
  refusal, parametric refusal, constant-equation refusal.
- Demo-scope: 16th demo runs both lanes (linear `x + y = 3, x − y = 1`
  ⟹ `x = 2, y = 1`; univariate `x² − 5x + 6 = 0` ⟹ `x ∈ {2, 3}`).

### Bug found while wiring goldens: `neg` head in goldens.spec builders

`tools/poly-factor/goldens.spec.ts` and `tools/poly-roots/goldens.spec.ts`
both used a `term(coef, k)` helper that emitted `expr("neg", [xPow(k)])`
when `coef === -1n`. The `valueToRatFn` bridge (in
`@workbench/cas-core`) accepts only the Q[x] vocabulary `+ − * / ^`
— `neg` is part of the broader closed-numerical vocabulary that
`cas-diff` / `integrate-1d` admit, but is not part of Q[x]'s.
Polynomials passing through the `neg` builder were silently being
refused as "non-polynomial" and the corresponding goldens were
recording the refusal output, masquerading as factorisation tests.

Φ₁₂ (`x⁴ − x² + 1`) was the canary: bead 1yu's irreducible-cyclotomic
case was supposed to verify that `poly-factor` correctly identifies
the input as already irreducible (returning `[(Φ₁₂, 1)]`); instead
the golden recorded `tagged "poly-factor/non-polynomial"`. The fix
is one-line in each builder:

```ts
// before:
if (coef === -1n) return expr("neg", [xPow(k)]);
// after — matches Q[x] vocabulary admitted by valueToRatFn:
if (coef === -1n) return expr("*", [int(-1n), xPow(k)]);
```

After regeneration, all 27 poly-factor + 22 poly-roots goldens pass
the oracle check and the refusal-path goldens (sin/exp/multivariate)
still test what they were supposed to. The lesson: **the vocabulary
that `valueToRatFn` accepts is *narrower* than the closed numerical
vocabulary** — `neg` is admitted by `cas-diff` but not by Q[x]
expressions. Tools that operate over Q[x] (poly-factor, poly-roots,
solve) must build their inputs in the narrow vocabulary; tools that
operate over the broader numerical vocabulary (cas-diff,
integrate-1d, optimize) admit `neg` directly.

## Why these choices

**Why a separate `packages/solve` package, not inline in the tool.**
The classifier + dispatcher are reusable substrate — a future
notebook surface, a programmatic agent harness, or a different
top-level tool (e.g., `solve-system` vs. `solve-equation`) can call
them directly without spawning the seven-artefact wrapper. Mirrors
the pattern of `linsolve-q` (substrate in cas-core/linsolve.ts; tool
wraps), `poly-factor` (substrate in poly-factor; tool wraps).
Consistent layering, smaller tools, more reusable substrate.

**Why classify-then-dispatch, not unified solve.** The two principles
applied: a TS expert reading the classifier sees a closed
discriminated union of three verdicts; reading the dispatcher sees a
switch over those three. Each step's invariants are independent —
classifier doesn't need to know about Bareiss; dispatcher doesn't
need to know about polynomial-degree checks. Three smaller invariants
per step instead of one big one in a unified solve. Tested
independently. Bead `77b` explicitly called for this separation.

**Why direct cas-core / poly-factor calls in the dispatcher, not
subprocess hops.** The dispatcher is the orchestrator; it runs in
the same process as `tools/solve`'s `fn`. ADR-0012's "in-process
composition" applies. Calling `bareissSolve` directly (it's exported
from `@workbench/cas-core`) is byte-identical to calling `bun
tools/linsolve-q/tool.ts` with the same input — by construction,
since both surfaces share `executeToolDef`. Skipping the subprocess
is faster and the whole solve invocation runs in a single bun
process.

**Why solutions are flat, with multiplicity expressed as repetition.**
For univariate `(x − 1)² = 0`, the result has two `Solution` entries
each with the binding `x = 1`. Per ADR-0017 the solution set is
"finitely many or empty or infinitely many," and a double root is
finitely-many-of-cardinality-2. The alternative (one Solution with
multiplicity field) doesn't fit the ADR's shape and would split the
caller's logic into "iterate over solutions; also iterate over
multiplicity." The flat shape is cleaner — a planner that wants
multiplicity counts groups by binding-equality, and a planner that
just wants distinct roots dedupes. Two-principle test: a TS expert
writes `for (const sol of result.solutions) ... ` without thinking
about a multiplicity inner loop.

**Why `S.any()` at the schema top level.** Same trade-off as in
`poly-roots` and `cas-diff`. The output is a tight union of one
record shape and seven tagged shapes; TS inference on a `fn`
returning that union via the runner's narrow type fights us. The
runtime `output` validation against `S.any()` is a no-op; the
guardrails are the goldens (each output's shape is fixed by the
generator) and the unit tests on the substrate. Filed as a
limitation of `@workbench/contract`'s schema-narrowing, not as a
choice to fix here.

## Frictions surfaced

**`vars.map(sym)` calls `sym(name, namespace=index)`.** First draft of
`tools/solve/goldens.spec.ts` had `vars: list(vars.map(sym))` where
`sym(name: string, namespace?: string)`. `Array.prototype.map`
passes `(element, index)`; the index (a `number`) was silently
landing in `namespace`, producing `{kind: "symbol", name: "x",
namespace: 0}` — and the canonical encoder rejected the raw JSON
number. Fixed by wrapping: `vars.map((v) => sym(v))`. Same gotcha
applies in any `Array.map(constructor)` pattern; left a comment in
the goldens.spec to prevent regression.

**`expr("neg", [...])` invalidating poly-factor goldens.** Documented
above as a "what changed" item rather than a hidden friction — it's
public-facing because the bug was in goldens that *looked* like they
were testing factorisation but were actually testing the refusal
path. Caught while wiring `tools/solve` (where the same builder
mistake would have hidden a working dispatcher behind a refusal
output). Fixed in poly-factor and poly-roots goldens.spec; bumped
the typed barrel to 32 tools.

## Acceptance

- 4 beads closed: `scientist-workbench-{77b, cfd, fij, 80x}`.
- `packages/solve` package: `classify.ts` + `dispatch.ts` + tests.
  19 tests, 57 expects, all green.
- `tools/solve`: full seven-artefact contract, 20 goldens.
- Bug fixed in `tools/poly-factor/goldens.spec.ts` and `tools/poly-
  roots/goldens.spec.ts` — `neg` head replaced with `*` + `int(-1n)`.
  Both tools' goldens regenerated; oracle still 27/22 green.
- Main README catalog row + tools/solve/README.md + scripts/demo-
  scope.ts (16th demo) updated in lockstep.
- `bun run check`: 61 phases passed, 0 failed.

## Pointers

- Bead `scientist-workbench-77b`: classifier (closed).
- Bead `scientist-workbench-cfd`: linear path (closed).
- Bead `scientist-workbench-fij`: univariate-poly path (closed).
- Bead `scientist-workbench-80x`: tools/solve (closed).
- ADR-0017 (`docs/adr/0017-solution-set-shape.md`) — solution-set
  shape; this shard is the first user-visible exercise of every
  field.
- `packages/solve/src/{classify, dispatch, index}.ts` for the substrate.
- `tools/solve/{tool, README, goldens.spec}.ts` for the tool.

## Commits

(this shard documents the work landed; commit messages will follow
the same Law-2 lockstep pattern when staged.)
