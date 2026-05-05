# 044 — linalg-svd via the tstournament-protocol bench

**Date:** 2026-05-05
**Status:** complete
**Branches:** main
**ADR:** none — applies ADR-0014 (numerical-tier precedent), ADR-0015
(`numerical: true` opt-in), ADR-0010 (`defineTool`/`runTool` split),
ADR-0003 (output / error categories).
**Issues closed:** scientist-workbench-c03

## Context

Worklog 043 closed `linalg-qr` as the path-finder for the
tstournament-protocol bench applied to scientist-workbench. SVD is the
second slice of the `linalg-decompose` family (parent bead 71f) — the
*general-purpose rank-revealing tool* in the numerical tier:

- `linalg-solve` solves `Ax = b` for square non-singular `A` (fails
  cleanly on singular).
- `linalg-qr` factorises any `A = Q · R` but doesn't *reveal* rank —
  `diag(R)` carries pivot magnitudes, not singular values.
- `linalg-svd` factorises any `A = U · diag(S) · Vᵀ` *and* reveals
  rank as the count of singular values above the LAPACK-standard
  `max(m,n)·ε·S[0]` threshold.

So the output record is materially richer than QR's: `condition_number`
and `rank_estimate` are first-class fields, not derivable post-hoc by
the agent.

The bench scaffold had landed in a prior session; this shard records
the candidate-implementation slice. The pattern is identical to QR's
(worklog 043) — read PROMPT.md, mirror `tools/linalg-qr/tool.ts` shape,
implement substrate, wire the tool, generate goldens, validate.

## What changed

### Substrate — `packages/linalg-core/src/svd.ts` (~520 lines)

One-sided Jacobi SVD (Demmel-Veselić 1992). Diagonalises `AᵀA`
*implicitly* via column rotations of `A`: for each pair `(p, q)`
compute the Givens rotation that diagonalises the 2×2 block of
`AᵀA`, apply from the right to both `A` and the accumulated `V`.
After convergence, columns of `A·V` are orthogonal with norms equal
to singular values; left singular vectors come from normalising those
columns.

**Algorithm choice (Jacobi vs Golub-Reinsch).** Both are admissible
by the bench's tolerance regime; the bench tests the result, not the
algorithm. Jacobi wins the implementation budget at our scale
(`n ≤ 200`):

1. **Half the lines of code, no convergence-edge cases.**
   Golub-Reinsch needs Householder bidiagonalisation, accumulation of
   `U₁` and `V₁`, Demmel-Kahan implicit-shift QR sweeps with shift
   selection, deflation, post-sort. Each piece has subtle corner
   cases. Jacobi has one loop: rotate column pairs until off-
   diagonals are below tolerance.
2. **Superior accuracy on small singular values** (Demmel-Veselić
   1992): bidiag+QR can lose half the digits on the smallest σ when
   `A` has a wide range of column norms; Jacobi preserves them.
3. **n ≤ 200 means the speed gap doesn't matter.** Jacobi is
   `O(mn²·log n)` per sweep with `O(log n)` sweeps; Golub-Reinsch is
   `O(mn² + n³)`. Constants dominate at `n ≤ 200`.

The substrate exports `svd(A, mode)` returning `{U, S, Vt, mode,
reconstructionError, orthogonalityErrorU, orthogonalityErrorVt,
conditionNumber, rankEstimate}` (camelCase) — translated to
snake_case at the wire boundary.

The orient-tall preprocessing (transpose into Aᵀ if `m < n` so the
Jacobi loop's "columns become orthogonal" precondition holds, then
swap U ↔ V at the end) hit one bug during development — see
"Frictions" §1 below. Sign convention: Jacobi picks `t = sign(ζ) /
(|ζ| + √(1+ζ²))`, the smaller-magnitude root, keeping rotations
close to identity (Golub & Van Loan §8.5).

Rank-deficient (zero-norm) columns of the worked matrix surface as
zero singular values; the corresponding U-columns are completed by
modified Gram-Schmidt against the already-extracted unit vectors
(with a CGS2-style re-orthogonalisation pass for stability).
Complete-mode extends `U` and `Vᵀ` by the same Gram-Schmidt
machinery against the existing orthonormal partial bases.

`packages/linalg-core/src/index.ts` exports `{ type SVDResult, svd }`.

### Substrate tests — `packages/linalg-core/test/svd.test.ts` (~470 lines)

Twenty-five `bun test`-shaped tests across seven describe blocks.
Independent recomputation of `reconstructionError`,
`orthogonalityErrorU`, `orthogonalityErrorVt` is deliberately
re-implemented (not reused from `svd.ts`) so a regression in the
substrate's self-report doesn't go undetected because the test was
reading the same buggy formula. Mutation hooks at the bottom name
five perturbations and the test that catches each one.

Coverage:
- shape edges (1×1, 2×1, 1×2, 2×2 zero, 5×5 identity, 5×3 / 3×5 standard);
- complete-mode contract (5×3 → U is 5×5, Vt is 3×3; 3×5 → U is 3×3,
  Vt is 5×5);
- random well-conditioned (20 trials at 10×10, 50×3 tall, 3×50 fat);
- Hilbert-8 / Hilbert-12 (the Jacobi-accuracy advertisement;
  orthogonality stays at O(ε) independent of κ);
- rank-deficient (rank-1 outer product, identity-with-zero-column,
  all-zero); checks `rankEstimate` matches expectation;
- self-reported errors are honest (5×3 reconstruction, Hilbert-8
  both orthogonality fields, all-zero matrix);
- diagnostics (S non-negative descending, condition_number bounded
  for singular A, rank_estimate matches LAPACK threshold).

### Tool — `tools/linalg-svd/` (seven artefacts)

`tool.ts` (~470 lines) — wire wrapper around `svd(A, mode)`.
`numerical: true` per ADR-0015. Output is the agent-honest record
specified in the bench's PROMPT.md (snake_case wire form):
`{U, S, Vt, mode, reconstruction_error, orthogonality_error_U,
orthogonality_error_Vt, condition_number, rank_estimate, method:
"one-sided-jacobi", warnings}`. Boundary categories per ADR-0003
(mirroring QR's polarity):
- `tagged "linalg-svd/non-finite-input"` — payload carries `(row,
  col, value)`.
- `tagged "linalg-svd/degenerate-shape"` — payload carries `(m, n)`.
- `ToolError` for ragged A, mode ∉ {"reduced", "complete"}, or
  `m·n > 200·200` (suggestion points at bead `wmm`).

Seven examples (one per code-path branch including both boundary tags
and complete-mode), eleven invariants, one `--test` hook (5×3 round-
trip + Hilbert-8 orthogonality + S monotonicity + rank-1 outer rank
detection).

`goldens.spec.ts` (~135 lines) — 33 cases spanning shape edges,
hand-checked sign convention, well-conditioned random, ill-conditioned
(Hilbert 4/6/8/10, Vandermonde 5/8), structured (Wilkinson tridiag
5/11, Pei matrix), rank-deficient (rank-1 outer, identity-with-zero-
column, all-zero), tall/fat, complete-mode (5×3, 3×5, Hilbert-4
square), and every boundary category.

`README.md` — agent-facing summary mirroring `linalg-qr`'s structure:
library surface, input wire format, three output shapes (happy / two
tagged boundaries / ToolError), algorithm prose with the Jacobi-vs-
Golub-Reinsch rationale, ten invariants.

`package.json` — depends on `@workbench/linalg-core`.

### Lockstep docs

- Top-level `README.md` — new `linalg-svd` row inserted in the tool
  catalog table immediately after the `linalg-qr` row.
- `scripts/demo-scope.ts` — added Demo 16: SVD on a rank-1 outer
  product, prints the singular values (one nonzero, rest at machine
  epsilon) and `rank_estimate = 1`. The typed barrel auto-generates
  `wb.linalgSvd(...)` after `bun scripts/gen-workbench-barrel.ts`.

## Why these choices

### One-sided Jacobi over Golub-Reinsch

Documented in the substrate's literate header: Jacobi delivers
half the lines of code with no convergence-edge cases, superior
accuracy on small singular values (Demmel-Veselić 1992 proof), and
the speed gap doesn't matter at `n ≤ 200`. Golub-Reinsch is the
asymptotically faster and LAPACK-standard path; we leave the door
open via the `--method` flag (currently single-valued
`"one-sided-jacobi"`). Adding `"golub-reinsch"` later is
schema-additive.

### Optional `mode` field, not a flag

The bench's wire format puts `mode` *inside* the input record (omitted
for the default, present as `"complete"` only when needed). The
`linalg-qr` agent burned 45/49 cases by declaring it required; we
applied the lesson up front and used `S.record({...}, { optional:
["mode"] as const })` from line one.

### Tagged boundaries for non-finite and degenerate, ToolError for cap

Same polarity as `linalg-qr`. SVD is *defined* for every real matrix
including rank-deficient ones — there is no analogue of `linalg-solve`'s
`singular` tag (rank deficiency surfaces as `S[i] = 0` and
`rank_estimate < min(m,n)`). The non-finite case is a structurally
well-formed but semantically out-of-scope input; tagging lets a
planner introspect the offending cell rather than receive an opaque
exit-1.

### Rank-revealing diagnostics on the success branch

`condition_number` and `rank_estimate` are first-class output fields,
not warnings. The DESCRIPTION.md spells out the planner-decision
prose: "rank_estimate = 7 for an 8×4 input — A is full row rank.
Good." vs "rank_estimate = 3 for an 8×4 — there's a near-collinearity
between two rows; the user's data may have a duplicate." A planner
reading the SVD output decides whether to truncate at the noise floor
before pseudo-inverting, and the rank field is the input to that
decision. Putting it in the success record (not in `warnings`) makes
it programmatically queryable without string-parsing.

### Independent recomputation in tests (mirroring QR)

The substrate self-reports three error scalars; the bench's verifier
recomputes all three. The substrate test re-implements the formulas
locally so a self-report regression doesn't hide. Same load-bearing
discipline as worklog 043.

## Frictions surfaced

1. **Row-major addressing of the transposed work matrix.** First cut
   of the transpose preprocessing wrote `W[j * mw + i] = A[i, j]`
   when it should have been `W[j * nw + i] = A[i, j]` — the
   row-major stride for an `mw × nw` layout uses `nw`, not `mw`. Two
   minutes to find once I noticed `3×5 reduced` reconstruction was
   off by ~1.0 (normalised), but the symptom was misleading: the
   Vt rows looked individually orthonormal, so the bug looked like a
   permutation issue, not a stride issue. Fixed by pasting the
   transpose into a one-line REPL-style smoke test that compared
   `svd(A_3x5)` to `svd(A_5x3 transposed by hand)` — the `S` arrays
   differed, immediately localising the bug to the transpose path.
   Worth remembering: when SVD-output orthogonality is fine but
   reconstruction is bad, the singular *vectors* are wrong (likely
   from a layout / permutation bug), not the *algorithm*.

2. **TypeScript strict-null on Float64Array element subtraction.**
   `v[i] -= dot * data[i*cols+fc]!` reads as `(v[i] | undefined)
   minus number`, which TS rejects under `noUncheckedIndexedAccess`.
   Trivial fix (`v[i] = v[i]! - …`) but caught only by the typecheck
   phase of `bun run check`, not by `bun test` or the bench. Reminder
   that the per-tool feedback loop (substrate test → tool --test →
   bench) doesn't include typecheck; the project gate is the only
   place that runs `tsc --noEmit`.

3. **First-attempt 392/392 was lucky.** The bench passed on the very
   first attempt; the only post-bench iteration was the typecheck
   fix. This is unusual — worklog 043 surfaced a 45/49 first cut
   from the QR subagent. The difference: I read worklog 043 before
   writing any code and applied its three lessons (optional `mode`
   field, snake_case wire vs camelCase substrate, the bench-eats-
   stderr triage trick) up front. The "read the worklog from the
   prior agent who solved the same problem class" discipline paid
   for itself in one shard.

4. **Demo first-cut numerical-rank example was wrong.** The first
   demo iteration had two near-collinear *rows* in a 4×3 matrix and
   said "numerical rank 2"; SVD correctly reported rank 3 because
   column rank is bounded by `min(m,n) = 3` and the columns weren't
   collinear. Replaced with a pure rank-1 outer product `u·vᵀ` where
   the rank story is unambiguous: one nonzero σ, two at machine
   epsilon, `rank_estimate = 1`. Lesson: when crafting a
   demonstration, derive the expected output from algebra first
   rather than writing the prose to match a guess.

5. **Per-tool goldens duplicate the bench (intentionally).** The
   bench's 49-case battery exercises 392 invariant assertions; the
   per-tool goldens duplicate ~30 of those input shapes for the
   project's per-tool oracle phase. This is *deliberate redundancy*
   — the bench tests the candidate against floating-point invariants
   (which evolve as we improve), while the goldens freeze the
   exact byte output. A `numerical: true` golden won't catch a
   cross-platform last-bit drift; the bench's tolerance-band check
   will. Both layers of safety net are intentional.

## Acceptance

- `bun test packages/linalg-core/test/svd.test.ts` — 25 pass, 0 fail,
  201 expect() calls.
- `bun tools/linalg-svd/tool.ts --test` — passes 5×3 round-trip,
  Hilbert-8 orthogonality (< 1e-12), S monotonicity, rank-1 outer
  rank detection.
- `bun scripts/generate-goldens.ts --tool linalg-svd` — wrote 33
  goldens, zero failures / mismatches.
- `bash bench/infra/run-bench.sh bench/linalg-svd bun bench/linalg-svd/
  run-candidate.ts` — 49/49 cases green; per-check totals all 49/49
  across 8 invariant checks: shape, finite_entries,
  S_nonneg_descending, U_orthonormal, Vt_orthonormal,
  factorisation_residual, self_reported_residual,
  self_reported_orthogonality. **392/392 invariant assertions.**
- `bun run check` — 45 phases passed, 3 skipped, 0 failed (the
  oracle pass on linalg-svd's 33 goldens is in there).
- Top-level `README.md` catalog row added between `linalg-qr` and
  `integrate-1d`.
- `scripts/demo-scope.ts` Demo 16 invokes `wb.linalgSvd` on a rank-1
  outer product.

## Pointers

- Substrate: `packages/linalg-core/src/svd.ts`,
  `packages/linalg-core/src/index.ts` (export added).
- Substrate tests: `packages/linalg-core/test/svd.test.ts`.
- Tool: `tools/linalg-svd/{tool.ts, goldens.spec.ts, README.md,
  package.json, goldens/}`.
- Bench: `bench/linalg-svd/{PROMPT.md, DESCRIPTION.md, REFERENCES.md,
  run-candidate.ts, golden/{inputs.json, expected.json, verify.py,
  verifier_protocol.md}, reference/svd_reference.py}`.
- Top-level README catalog row at `README.md` (between linalg-qr and
  integrate-1d rows).
- Demo: `scripts/demo-scope.ts` Demo 16 (rank-1 outer product SVD).
- ADRs: 0014 (numerical-tier precedent), 0015 (`numerical: true`
  determinism contract relaxation), 0010 (`defineTool` / `runTool`
  split), 0003 (output / error categories).
- Beads: `scientist-workbench-c03` (this work, closed); -71f (parent
  decomposition family); -wmm (blob-by-hash for n>200 follow-up);
  -e7y (FFI BLAS / LAPACK path).
