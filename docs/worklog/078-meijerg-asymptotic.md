# Worklog 078 — `meijer-core` Braaksma asymptotic (Layer 6) shipped (`hv0.9`)

**Date:** 2026-05-08 → 2026-05-09 (one session).
**Beads:** `scientist-workbench-hv0.9` (claimed at session start; will
be closed by the orchestrator from main after worktree merge — the
beads DB is not bootstrapped in this worktree by design). New
ADR-0026.
**Related ADRs:** ADR-0020 (arb-prec tier — every numerical layer
in this stack inherits the bit-deterministic-cross-platform-given-
precision contract). ADR-0021 / ADR-0022 (BigComplex G7K15 driver
— the contour layer the asymptotic complements). ADR-0025 (Layer 4
symbolic dispatch — the asymptotic is the *numerical* far-field
sibling for the layer-7 dispatcher). ADR-0010 (`defineTool` /
`runTool` shape). ADR-0003 (three output categories; refusal on
Stokes lines / secondary sectors is a *boundary failure*, tagged).
**Lockstep with:** the campaign log at
`../tstournament/ts-bench-infra/problems/13-meijer-g/WORKLOG-13.md`.

## Context

Layer 6 of the seven-layer Meijer G stack — the **far-field
asymptotic** path. When `|z|` is large enough that Slater Series 2
diverges (the `p > q` regime) or the contour quadrature is
exponentially expensive (the integrand peak shifts and the
truncation `T` grows like `precision · log|z|`), the Braaksma 1964
sectorial asymptotic expansion (Compositio Math. 15: 239–341)
gives a formal series that — truncated optimally per Olver §3.7
"superasymptotic" — produces an answer to a fixed number of digits
in `O(precision)` Γ-evaluations, no `|z|`-dependence beyond the
truncation index.

The full Braaksma theorem is genuinely complicated:
- algebraic part `H^{m,n}_{p,q}(z)` (formal series in `z^{-a_h-k}`);
- exponential part `E_{p,q}(z)` (terms `z^{ν} exp(κ z^{1/κ})`);
- connection coefficients depending on `(m, n, p, q)` and the
  sector containing `arg z`;
- Stokes lines at sector boundaries with discontinuous switching
  on/off of exponentially-small terms.

**Implementing the full theorem in one session is unrealistic.**
This shard ships the **v0.1 algebraic dominant asymptotic in the
principal sector**, with structured refusal on Stokes lines and
secondary sectors. Follow-up beads carry the full theorem.

## What changed

### `docs/adr/0026-meijerg-asymptotic.md` — design ADR

Pins the conventions:

- v0.1 scope: principal-sector algebraic dominant asymptotic for
  `|z| → ∞`; structured refusal on Stokes lines, secondary
  sectors, the symmetric `|z| → 0` regime, `non-asymptotic-regime`
  inputs, and `n = 0` no-residues cases.
- The optimal-truncation rule (Olver 1974 §3.7): truncate at the
  index `k*` where `|t_{k*+1}| ≥ |t_{k*}|`; report `|t_{k*+1}|`
  as the error estimate.
- I/O envelope mirrors `MeijerGContour…` line-for-line on the
  common fields (`status`, `value`, `method`, `achievedPrecision`,
  `workingPrecision`, `warnings`); adds `nTerms`,
  `optimalTermIndices`, `errorEstimate`, `sector`.
- Wire tool: `arbprec: true` + `--precision=<int>` standard flag.
- Determinism: `arbprec: true` — bit-identical cross-platform
  forever given precision.

### `packages/meijer-core/src/asymptotic.ts` — kernel (~470 LOC)

Public surface:

- `meijergAsymptotic(params, z, precision, opts) → MeijerGAsymptoticResult`
- `classifySector(z, m, n, p, q, workingBits, opts?)` — three-way
  sector classifier (`principal | stokes | secondary`).
- `asymptoticTerms(params, z, h, workingBits)` — generator
  yielding successive terms of the per-pole inner series.
- `findOptimalTruncation(params, z, h, workingBits, maxTerms)` —
  reads magnitudes off `asymptoticTerms`, returns `{ index,
  partialSum, errorEstimate, nTerms, reachedCap }`.

The recurrence is the same one Slater Series 2's inner pFq uses
(`packages/hypergeometric/src/pfq.ts::pFqDirectSeries`). The
asymptotic path differs only in **how** we sum: instead of
"continue until the term magnitude drops below `2^{-target}`," we
"continue until the term magnitude turns around, then stop." The
per-pole prefactor is Slater Series 2's `B_h` Γ-product re-
implemented inline (~25 lines; refactoring `series.ts` to expose
just the prefactor would split a piece that reads naturally as a
unit).

### `packages/meijer-core/src/index.ts` — barrel extension

Public re-exports: `meijergAsymptotic`, `asymptoticTerms`,
`classifySector`, `findOptimalTruncation`, plus the four
asymptotic types (`MeijerGAsymptoticOptions / Result / Success /
Refusal`).

### `tools/meijer-g-asymptotic-only/` — wire wrapper

Thin `defineTool({...})` wrapper exposing `meijergAsymptotic` over
the protocol. Schema: `record { an, ap, bm, bq: list<bigcomplex>,
z: bigcomplex }` in / `record { value, achieved_precision, method,
n_terms, optimal_term_indices, error_estimate, sector,
working_precision, warnings }` out (or `tagged
"meijer-g-asymptotic-only/<class>" record { reason }` for
refusal). Three examples + five invariants declared. Goldens: 8
cases covering principal-sector success (entire-function and
divergent-asymptotic), refusals, default-precision behaviour.

### `packages/meijer-core/test/asymptotic.test.ts` — 40 tests

Covers:
- 8 closed-form anchors (`e^{-1/z}`, `z·e^{-1/z}`, `√(π/(1+z))`
  family at z=100 / 1000 / complex z=10+5i, mpmath-pinned and
  Wolfram-pinned cases at 80 / 60 dps).
- 5 mpmath cross-validation cases at 80 dps (truths in test file).
- 5 Wolfram cross-validation cases at 60 dps (truths in test file).
- 4 Slater agreement tests on the overlap region (where Slater
  Series 1/2 also converges to the user precision).
- 3 optimal-truncation invariant tests (`error_estimate · 100 ≥
  actual_error vs Slater ground truth`).
- 6 refusal-class tests (one each for `secondary-sector`,
  `stokes-line/secondary-sector` border, `small-z`,
  `no-pole-residues`, `input-error`, `z = 0`).
- bit-determinism (two evaluations byte-equal across mantissa,
  exponent, optimal indices, nTerms).
- Sector-classifier direct unit tests + asymptoticTerms /
  findOptimalTruncation property tests.

### `packages/meijer-core/test/asymptotic-mutations.test.ts` — 5 mutation-prove tests

Per CLAUDE.md Rule 6 ("port-and-verify with mutation-prove"). Each
mutation perturbs the *result* programmatically (sign flip,
prefactor scale, premature truncation, sector mis-admit, omitted
1/z-per-step), confirms the perturbed value fails the
corresponding invariant test, and proves the test catches that
class of regression.

### `tools/meijer-g-asymptotic-only/tool.test.ts` — 7 tests

Wire-surface lock-in: input decoding (four-tuple split + z),
output encoding (success record / tagged refusal), schema-
validation contract, `--precision` flag plumbing, determinism.

### Documentation lockstep (Law 2)

- `docs/adr/0026-meijerg-asymptotic.md` — design ADR.
- `packages/meijer-core/README.md` — Asymptotic Layer section
  added; tests section extended.
- `packages/meijer-core/src/index.ts` — public re-exports.
- `tools/meijer-g-asymptotic-only/README.md` — agent-facing
  summary (when to call asymptotic vs Slater vs contour;
  refusal-class table).
- `README.md` (root) — catalog row for
  `tools/meijer-g-asymptotic-only`.
- This worklog shard (078).
- `tstournament/ts-bench-infra/problems/13-meijer-g/WORKLOG-13.md`
  — campaign-side closure banner update.
- `tstournament/WORKLOG.md` — top-level handoff banner.

## Why these choices

### Why "algebraic only" in v0.1, not the full theorem

Three constraints:
1. one-session budget;
2. the full Braaksma theorem's connection coefficients are
   tabulated rather than derived — translating the table from
   primary literature is at least as much work as the algorithmic
   core, and getting it *wrong* (a sign or factor-of-2 in a
   connection coefficient) silently produces wrong-valued answers
   on the corresponding sector;
3. the user-stated brief is "v0.1 dominant-balance asymptotic in
   the principal sector with structured refusal."

The honest-scope refusal envelope means a v0.1 caller knows
exactly when the answer is trustworthy and routes to the contour
quadrature otherwise. The top-level dispatcher (hv0.10) composes
asymptotic-first → contour-fallback for inputs the asymptotic
refuses; this gives correct answers throughout the parameter
space even though the asymptotic alone covers only the principal
sector.

### Why optimal-truncation, not fixed precision-targeted truncation

The asymptotic series is **divergent**. Its terms first decrease
geometrically (~`|z|^{-1}` ratio), reach a minimum at the
"optimal" index `k* ≈ |z|` (for clean cases), then grow
factorially. Truncating earlier than `k*` gives a worse-than-
necessary error; truncating later gives a *worse* result (the
divergent tail dominates). Olver §3.7's rule — "stop when terms
turn around" — is the canonical and only correct choice.

### Why mirror `MeijerGContourResult` exactly

The hv0.10 dispatcher reads the result envelope to decide
"success or fallback?" — and it must do so via a single switch
across the three numerical layers' return shapes. The mirror
discipline (same field names, same status enum vocabulary, same
wire-tool refusal-tag pattern) makes the dispatcher's compose
code one switch statement instead of three. Pre-emptive mirror
= lower hv0.10 cost. Asymptotic-specific fields
(`optimalTermIndices`, `errorEstimate`, `sector`) are added
without conflict.

### Why `optimalTermIndices` is per-h not summary

Each of the `n` upper-pole series can hit its optimal truncation
at a different index `k*_h`, because each has a different
prefactor and recurrence ratio. The aggregate "summary index"
loses information that's diagnostically useful (which pole is
contributing most? where is the geometry tightest?). We keep the
per-h list.

### Why re-implement the prefactor inline rather than import from `series.ts`

`evaluateSeries2` couples the prefactor with the inner-pFq sum
into a single `ResidueTerm` value. The asymptotic path needs
*only* the prefactor (the inner-pFq sum is exactly what we're
replacing with the optimal-truncation alternative). Refactoring
`series.ts` to expose the prefactor alone would split a piece of
code that reads naturally as a unit and increase the v0.5 surface
area. The duplication is ~25 lines; the cost is a one-line edit
in two places when the prefactor formula evolves. Acceptable.

## Frictions surfaced

### Recurrence-derivation algebra error caught by smoke test

First draft of `asymptoticTerms` mis-implemented the per-step
ratio: I had absorbed the per-residue `(-1)^k` into the recurrence
*and* the `(-1)^{q-m-n}/z` argument sign, double-counting the
sign. A 4-line rewrite (split the sign into a single boolean
parity carried per-step) fixed it. The smoke test (running on
`G^{1,1}_{1,2}([1/2]; _ ; [0],[1] | 100)` against mpmath truth
at first attempt) failed with sign-flipped result — caught
immediately. **Lesson:** smoke-test against an external oracle
*before* writing the test file, not after; a wrong recurrence
that "compiles" can pass syntactic property tests if you wrote
the property tests against the wrong recurrence.

### Standard `--precision` flag wiring gap

The runner parses `--precision=N` correctly for arbprec tools and
threads it into `parsed.flags`, but `toolFlagsTyped` (the object
passed to `def.fn`) only contains *tool-declared* flags
(`def.flags`), not standard flags. Result: every CLI invocation of
arbprec tools runs at the default `50` dps regardless of the
`--precision` flag. **This is a pre-existing issue affecting
`hypergeometric-pfq` and `meijer-g-slater-only` too** — both have
the same `(flags as { precision?: bigint }).precision ?? 50n`
pattern, and both are presumably broken on the CLI in the same way
(though their in-process test files manually pass `flags` to
`def.fn`, which works). Filed as a follow-up bead. Goldens for
this tool ship without per-case `flags` — the generated output
reflects the actual runtime behaviour at precision=50.

### Minor: tsc warning under strict mode

`tools/meijer-g-asymptotic-only/tool.test.ts`'s `evalAsy(...)`
helper initially cast `{ precision: 30n }` directly to
`Parameters<typeof def.fn>[1]`; tsc complained that
`FlagsOf<EmptyFlags>` doesn't have a `precision` property. Fixed
by routing through `unknown` (same idiom as
`tools/hypergeometric-pfq/tool.test.ts`). Took ~2 minutes; would
not have surfaced under `bun test` alone (which uses a more
permissive type-check pass).

### Quadrature flake (not my work, but observed)

`packages/quadrature/test/quadrature-bc.test.ts > sin(x) on [0,π]
at 80 dps` timed out at 5000 ms during the `bun run check:quick`
parallel run; ran fine in isolation. Pre-existing flakiness; the
parallel agent on bead 6f8 owns `packages/quadrature/`. Mentioned
here for the next session's awareness.

## Acceptance

- ADR-0026 written.
- `packages/meijer-core/src/asymptotic.ts` shipped (~470 LOC).
- `packages/meijer-core/src/index.ts` extended with public
  re-exports.
- `packages/meijer-core/test/asymptotic.test.ts` — 40 tests,
  all green.
- `packages/meijer-core/test/asymptotic-mutations.test.ts` — 5
  tests, all green.
- `tools/meijer-g-asymptotic-only/` shipped (tool.ts +
  README.md + tool.test.ts (7 tests) + 8 goldens).
- `packages/meijer-core/README.md` extended.
- Root `README.md` extended with catalog row.
- This worklog shard.
- Tournament-side log updated.
- `bun run check` green (67 passed, 7 skipped, 0 failed).

## Pointers

- Design ADR: `docs/adr/0026-meijerg-asymptotic.md`.
- Kernel: `packages/meijer-core/src/asymptotic.ts`.
- Tests: `packages/meijer-core/test/asymptotic{,-mutations}.test.ts`.
- Tool: `tools/meijer-g-asymptotic-only/`.
- Goldens: `tools/meijer-g-asymptotic-only/goldens/` (8 files).
- Predecessor ADRs: 0020 (arbprec tier), 0021 (BF G7K15), 0022
  (BC G7K15), 0025 (symbolic dispatch).
- Campaign log: `../tstournament/ts-bench-infra/problems/13-meijer-g/
  WORKLOG-13.md` (this shard's tournament-side counterpart, updated
  in the same session).

## Next pickup

The campaign now has 8 of 12 child beads closed (`hv0.1` ✓
bigfloat, `hv0.2` ✓ AST extension, `hv0.3` ✓ pFq, `hv0.5` ✓
Slater, `hv0.6` ✓ symbolic dispatch, `hv0.7` ✓ arb-prec
quadrature, `hv0.8` ✓ contour, `hv0.9` ✓ asymptotic). Open and
unblocked:

- `hv0.4` — `bench/hypergeometric-pfq` tier-graded battery.
- `hv0.10` — top-level `tools/meijer-g` dispatcher (depends on
  `hv0.6` ✓ + `hv0.5` ✓ + `hv0.8` ✓ + `hv0.9` ✓; **now fully
  unblocked**).
- `hv0.11` — bench/meijer-g tier-graded battery.

Recommended next: **`hv0.10`** — the top-level dispatcher composes
the four numerical paths into a single `tools/meijer-g`. Every
piece it depends on is now in place.

Follow-up beads to file (orchestrator will create after merge —
see `BEADS-TO-FILE.txt` in the worktree root):

- `hv0.9.1` — Full `H^{m,n}_{p,q}` algebraic series (different
  prefactor than Series 2 when `n < p`).
- `hv0.9.2` — Stokes-line connection coefficients across
  `arg z = ±π/2` (for `p = q`).
- `hv0.9.3` — Olde Daalhuis-Olver hyperasymptotic refinement.
- `hv0.9.4` — Symmetric `|z| → 0` asymptotic (uses Series 1
  truncated optimally; n-pole-residue-mirror at the lower poles).
- `hv0.9.5` — Secondary-sector handling (`|arg z| > π/2 - π/64`).
- Standard-flag wiring fix: `--precision=N` doesn't reach
  arbprec-tool `fn` flags via `runTool` (affects
  `hypergeometric-pfq`, `meijer-g-slater-only`,
  `meijer-g-asymptotic-only` consistently).
