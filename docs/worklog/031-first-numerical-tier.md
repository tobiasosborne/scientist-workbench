# 031 — First numerical tier (linalg-core + linalg-solve)

**Date:** 2026-05-03
**Status:** complete (v0.1)
**Branches:** main
**ADR:** [0014-first-numerical-tier](../adr/0014-first-numerical-tier.md)
**Issues closed:** scientist-workbench-abj (ADR), -0ky (package), -ynd (tool), -gyb (lockstep docs), -bf0 (this worklog)
**Issues filed (deferred follow-ups):** -71f (decompose tools), -wmm (blob-by-hash), -0ck (ADR-0015 determinism tier), -e7y (FFI BLAS), -va1 (cas-to-latex), -n2a (epic — closes when the tier matures)

## Context

The `numerics-and-vis-2026-04-29.md` research note named the cliff:
without numerics, sci-wb covers ~5% of physics, ~10% of ML, ~0% of
data analysis. The note proposed four cheap experiments and held back
from drafting the determinism-tier ADR until "the forcing experiment
hasn't run."

This shard *is* the forcing experiment, sharpened from the note's
§5.3: instead of `numeric-eigvals` bridged to Julia, we built
`linalg-solve` in pure TypeScript. The sharpening was earned by
ADR-0010 (`defineTool`/`runTool` split), which makes
library-and-tool dual surface real — a TS expert imports `solve(A,
b)` directly, an agent invokes the tool over stdin/stdout, and they
share one implementation.

## What changed

**`docs/adr/0014-first-numerical-tier.md`** (new). Captures:
the sharpened experiment, the five forcing-questions, the explicit
non-decisions (cross-platform determinism, blob-by-hash, FFI bridge,
sparse/iterative methods all deferred), and the three things that
shifted since the precursor note (ADR-0010 is now load-bearing,
cap-at-200 makes wire encoding viable, `solve` not `eigvals` is the
right first tool).

**`packages/linalg-core/`** (new, ~700 LOC across 4 source files
plus 270 LOC of tests). Pure TypeScript on `Float64Array`:

- `matrix.ts` — `Matrix = {rows, cols, data: Float64Array}` row-major.
  Constructors with NaN / Inf / ragged-input rejection; element
  accessors; `matVec` (straight float64 dot product); `vecNorm2` with
  scaling pass to avoid overflow; `matNorm1` (max column sum of abs).
- `lu.ts` — Doolittle LU with partial pivoting, in-place packed L+U
  storage (LAPACK-style), integer permutation vector. Tracks
  Wilkinson's growth factor. Forward/back substitution and
  transpose-solve (the latter needed by Hager).
- `hager.ts` — classical Hager (1984) 1-norm estimator for
  `||A^{-1}||_1` using ~4 LU-solves; capped at 5 iterations.
- `solve.ts` — high-level `solve(A, b)`: LU → `luSolve` → conditional
  one-step iterative refinement (when residual exceeds `4 n eps`) →
  Hager condition estimate. Returns the agent-honest `SolveResult`
  record; returns `null` on exact singularity.

**`tools/linalg-solve/`** (new). Wire-encoding wrapper around
`solve`. Schema: `record{A: list<list<float64>>, b: list<float64>}`
in, union of success-record and `tagged "linalg-solve/singular"`
out. `ToolError` for non-square, dim mismatch, non-finite entries,
and `n > MAX_N (200)`. Typed flag `--method=lu` (the v0.2-additive
discipline from ADR-0011). 16 goldens, all passing the oracle.
Per-tool `--test` hook covers a hand-checked solve, the singular
case, and Hilbert(4) condition.

**Lockstep doc updates (Law 2):**
- main `README.md` tool catalog — new `linalg-solve` row.
- main `README.md` File layout — `packages/linalg-core` entry.
- main `README.md` "What this is *not*" — softened "Not a numerics
  library" to "Not a BLAS-scale numerics library", explicitly naming
  the bounded numerical tier and its cap.
- `packages/linalg-core/README.md` — surface, algorithm references,
  in/out scope.
- `tools/linalg-solve/README.md` — input / output shapes, boundary
  categories, algorithm pointer, references.
- **PRD §1.2 deliberately not updated.** ADR-0015 is the right place
  for the determinism-tier story; the PRD edit follows that ADR, not
  this one.

## Why these choices

**Pure TS over FFI / Julia.** The forcing experiment must stand
alone: no library version pin, no subprocess startup cost, no
licence-matrix question on the hot path. FFI is then earned by a
future workload that doesn't fit pure TS (bead `e7y`).

**Cap at n = 200.** Useful range (small ML, finite elements on toy
meshes, OLS up to 200 features), wire encoding still acceptable
(~470 KB), and the cap is itself a forcing function — the first
workload that wants 500×500 forces the blob-convention experiment to
be earned (bead `wmm`).

**LU + iterative refinement + Hager**, not QR or SVD, as the first
algorithm. Cheapest non-trivial linalg; honest about its instability
mode (growth factor + Hager condition); refinable to good accuracy
on well-conditioned problems. QR gets its own tool when the
requirement is "least-squares" (bead `71f`).

**Output is a record, not just `x`.** The single load-bearing design
choice for agent-irresistibility. A planner that gets back
`{x, residual_norm, b_norm, condition_estimate, growth_factor,
method, iterations, warnings}` can decide whether to trust the answer
or escalate. A planner that gets back just `x` cannot.

**Output schema is a union** of the success record and the singular
tag (ADR-0003 categories). The first iteration was a single-record
schema; this caused tsc to reject the singular example. Promoting to
`S.union([successRecord, singularTag])` was the right fix and clearly
documents the two valid output shapes for downstream consumers.

**Library surface is `Float64Array`, not Value.** A TS expert imports
`solve(A, b)` and operates on typed arrays — the wire encoding is
*the wire's job*, not the library's. This is the dual surface
ADR-0010 enables; the linalg tier is the first place it pays off
non-trivially.

## Frictions surfaced

**1. Type narrowing through `record(...)`.** The `inp` helper for
goldens / examples needed *no* explicit return type — annotating it
`: RecordValue` widened the type past what the schema-typed example
slot accepts. Same trap on `encodeSolveResult` / `encodeSolveValue`
(the `: Value` annotation widened past `TaggedValue | RecordValueOf<...>`).
**Lesson:** in tool authoring, when in doubt, omit the return-type
annotation and let TS infer the narrow form. Worth surfacing in the
template / scaffolder docs at some point.

**2. Output-schema unions are not optional.** When a tool can produce
either a happy-path record or a boundary-tagged value, the schema
must be `S.union([...])`. The runner enforces conformance at example-
load time, so this fails fast and loud — but the error message
("output does not conform: expected record, got tagged") is
diagnostic. Worked as designed.

**3. The `lu` named export shadowed the local variable.** I imported
`{ lu }` from `@workbench/linalg-core` and tried to declare `const
luRes = lu(A)` inside `fn`; this almost worked but the dynamic
`require()` style I tried first (to avoid the shadowing) hit
TypeScript strictness. Renamed import to `lu as luFactor`. Honest
import discipline — the hint that JS-style late `require` was wrong
came from tsc.

**4. Mutation-proving worked cleanly.** Removed the
pivot-search loop entirely (made every step take `LU[k,k]`) — the
"LU pivots correctly when (0,0) is zero" test failed with a clean
NPE, and the "permutation matrix on b recovers" test failed with
`null is not an object`. Restored, re-ran, all green. Two unrelated
tests caught the same mutation, which is the right shape: the
property is load-bearing and gets exercised from multiple angles.

**5. Bun's hex-printed float64 is *almost* but not exactly readable.**
Decoding `400999999999999a` mentally takes a beat; the sign bit, exp
bias, and mantissa structure are all there but the bits-as-string
form is for machines, not humans. The agent-honest output gives
people scanning JSON a hard time. This is pre-existing protocol
design (PRD §0.1), not a friction this shard introduced — but it
became visible here because every output is now mostly-floats. The
notebook surface (Phase 4) will paper this over; until then, the
goldens are the human-readable reference.

**6. Five system-reminder nudges to use TaskCreate.** Same as shards
028, 029, 030. Per CLAUDE.md Rule 9 ignored; using beads exclusively.
Worth recording for the fourth time so the policy is maximally clear
to a future agent.

## Acceptance

- `bun run check` is green: 33 phases pass, 4 skipped, 0 failed
  (~46s total).
- `bun test packages/linalg-core/test/linalg-core.test.ts` reports
  33 pass, 0 fail, 175 expect calls, ~80ms (after warm-up).
- `bun tools/linalg-solve/tool.ts --test` passes (in-process probe
  for hand-checked solve, singular detection, Hilbert(4) condition).
- All 16 linalg-solve goldens pass via the oracle.
- Mutation-proven on the pivot-search loop (skip-pivoting → 2 tests
  fail with clean errors → restore → all green).
- Boundary categories all verified end-to-end via direct stdin pipes:
  singular A → `tagged "linalg-solve/singular"`; non-square →
  `ToolError` with suggestion; NaN entry → `ToolError` with path.
- `--schema` round-trips: shows the union output (success-record OR
  singular-tag).
- README + per-package READMEs + per-tool README updated in lockstep.

## Forcing-questions, answered (partially)

ADR-0014 listed five forcing-questions this experiment was meant to
surface. Status:

1. **Single-platform float bit-stability.** All 16 goldens have
   stable hashes across multiple `bun run check` runs on the same
   machine (Bun 1.3.9, x86-64 Linux). Cross-version testing is
   future work — the corpus exists, the question is now answerable
   when needed.
2. **Agent-honest output shape.** The `record{x, residual_norm,
   b_norm, condition_estimate, growth_factor, method, iterations,
   warnings}` shape survived the schema-validation, oracle, and
   --test loop unchanged. Will it compose with downstream tools?
   Open until a downstream tool exists.
3. **Library-and-tool duality.** Worked clean. The library exports
   `solve` operating on `Float64Array`; the tool wraps it with
   ~30 LOC of decode/encode. Same algorithm, two surfaces, no
   divergence. ADR-0010's pattern is now battle-tested in the
   numerical tier.
4. **Mutation-proving for numerics.** Worked. Skip-pivoting failed
   two tests cleanly; the pattern is the same as for symbolic code.
5. **5.9× JSON inflation at n = 200.** Not stress-tested at n=200 in
   this shard (largest golden is n=6); the cap is in place and the
   forcing function is wired, but the actual measurement is deferred
   to whoever first wants n=200.

## Pointers

- `docs/adr/0014-first-numerical-tier.md` — design rationale.
- `docs/numerics-and-vis-2026-04-29.md` — the precursor research note.
- `packages/linalg-core/src/{matrix,lu,hager,solve,index}.ts` — the
  literate algorithmic substrate.
- `packages/linalg-core/test/linalg-core.test.ts` — 33 tests.
- `tools/linalg-solve/{tool.ts,goldens.spec.ts,README.md}` — the
  wire-encoding wrapper.
- `tools/linalg-solve/goldens/` — 16 generated goldens.
- ADR-0010 — `defineTool`/`runTool` split (the dual-surface enabler).
- ADR-0003 — output / error categories (applied here in numerical form).
- ADR-0011 — typed flag declarations (`F.enum(["lu"])` discipline).

## Open questions (for the next iteration)

- **ADR-0015 (determinism tier, bead `0ck`).** The corpus exists;
  drafting the ADR now needs (a) a cross-Bun-version run of the
  goldens corpus, (b) a decision on the per-platform fingerprint
  format. Worth doing once we have a second numerical tool.
- **The wire-encoding measurement at n=200.** Whoever first wants it
  should benchmark wire-encode + parse + solve on a random
  well-conditioned 200×200 system; that's the data point that
  calibrates the blob-convention pressure.
- **Iterative-refinement quality.** Current refinement uses
  straight-float64 residuals — buys ~1 digit on well-conditioned
  problems, ineffective on ill-conditioned ones. A future "compensated
  residual" path (Kahan-style) is one option; "extended-precision via
  bigint scaling" is another. Defer until a workload demands it.
