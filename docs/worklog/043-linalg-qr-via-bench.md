# 043 — linalg-qr via the tstournament-protocol bench

**Date:** 2026-05-05
**Status:** complete
**Branches:** main
**ADR:** none — applies ADR-0014 (numerical-tier precedent), ADR-0015
(`numerical: true` opt-in), ADR-0010 (defineTool/runTool split),
ADR-0003 (output / error categories).
**Issues closed:** scientist-workbench-3jq

## Context

Worklog 040 closed `optimize-lbfgs-projected`, the second numerical-
tier tool to ship under ADR-0014 / ADR-0015. The agreed v0.2 numerical
roadmap names QR as the next decomposition (parent bead 71f), and
issue 3jq specifically scopes the *first slice* — QR — as the path-
finder run for the **tstournament protocol** applied to scientist-
workbench. The protocol: write a punishing language-neutral bench
(`bench/<name>/` with PROMPT, DESCRIPTION, REFERENCES, golden
inputs, SciPy reference, invariant verifier with backward-stability
tolerances) before writing the candidate; then dispatch a smart
subagent with full sci-wb context to implement the seven-artefact
tool against the bench.

The bench scaffold landed in a prior session by a different agent;
this shard records the candidate-implementation slice.

## What changed

### Substrate (unchanged from prior agent's work, verified)

`packages/linalg-core/src/qr.ts` (544 lines) — Householder QR by
LAPACK DGEQRF storage convention (Householder vectors below the
diagonal of the work array, τ in a separate length-`k` vector,
backward accumulation of Q). Self-reports
`reconstructionError = ‖Q·R − A‖_F / max(‖A‖_F, 1)` and
`orthogonalityError = ‖QᵀQ − I‖_F` on the *actual* returned matrices,
not on intermediate state. Smoke test on a 5×3 input gives
reconstruction 6.5e-16 and orthogonality 1.2e-15 — confirms
Householder is wired correctly. The substrate's literate header is
the canonical reference for the algorithm prose; this shard does not
duplicate it.

`packages/linalg-core/src/index.ts` exports `{ type QRResult, qr }`.

### Substrate tests — `packages/linalg-core/test/qr.test.ts` (303 lines)

Twenty `bun test`-shaped tests across six describe blocks:

- **shape edges** — 1×1 (positive and negative diagonal exercises the
  sign convention); 2×1 tall; 1×2 fat (verifies the m<n contract that
  Q stays m×m); 2×2 zero (the all-zero matrix gets identity Q and
  zero R); identity 5×5; the bench's 5×3 standard case.
- **complete mode** — 5×3 complete (Q is 5×5, bottom 2 rows of R
  exactly zero per LAPACK convention); coincidence with reduced when
  m ≤ n (substrate must produce identical bytes for the two modes
  on fat or square inputs).
- **sign convention** — `[3,4]ᵀ` should give R[0,0] = -5;
  `[-3,4]ᵀ` should give R[0,0] = +5. Pins the Householder choice
  α = -sign(x[0])·‖x‖.
- **random well-conditioned** — 30 random 10×10 matrices through a
  seeded mulberry32 (matching the linalg-core test pattern); plus a
  tall 50×3 case and a fat 3×50 case.
- **Hilbert (the discriminator)** — Hilbert-8 (κ ≈ 1.5e10) and
  Hilbert-12 (κ ≈ 1e16). These are the cases MGS would catastrophically
  fail; passing them confirms Householder's `O(ε)` orthogonality.
- **rank-deficient** — rank-1 outer product (R diagonal reveals rank
  1, the lower diagonals are at machine epsilon); identity with a zero
  column at j=2 (R[2,2] = 0 exactly).
- **self-reported errors** — independent recomputation of both error
  diagnostics, asserted to match the substrate's report to better
  than 1e-12 relative.

The independent recomputation helpers (`reconstructionError`,
`orthogonalityError`) are deliberately re-implemented in the test
file rather than reused from `qr.ts` — a regression in the substrate's
self-report would otherwise be invisible because the test was reading
the same buggy formula.

Mutation hooks at the bottom name five perturbations that should turn
the suite red, with the test that catches each one. All five were
verified by hand during development.

### Tool — `tools/linalg-qr/` (seven artefacts)

`tool.ts` (~470 lines) — wire wrapper around `qr(A, mode)` from the
substrate. `numerical: true` per ADR-0015, mirroring `linalg-solve`
and `integrate-1d`. Output is the agent-honest record specified in
the bench's PROMPT.md:
`{Q, R, mode, diagonal_R, reconstruction_error, orthogonality_error,
method: "householder", warnings}`. Note `diagonal_R` (snake_case) on
the wire; the substrate uses `diagonalR` (camelCase) — translated at
the wire boundary. Boundary categories per ADR-0003:
- `tagged "linalg-qr/non-finite-input"` — payload carries `(row,
  col, value)` so a planner can introspect the offending cell.
- `tagged "linalg-qr/degenerate-shape"` — payload carries `(m, n)`.
- `ToolError` for ragged A or `m·n > 200·200` (suggestion points at
  bead `wmm`, mirroring `linalg-solve`).

Seven examples (one per code-path branch including both boundary
tags and complete-mode), nine invariants, one `--test` hook (5×3
round-trip + Hilbert-8 orthogonality + sign convention probe).

`goldens.spec.ts` (~150 lines) — 34 cases spanning shape edges,
hand-checked sign convention, well-conditioned random, ill-conditioned
(Hilbert 4/6/8/10, Vandermonde 5/8), structured (Wilkinson tridiag),
rank-deficient, tall/fat, complete-mode, and every boundary category.

`README.md` — agent-facing summary mirroring `linalg-solve`'s
structure: library surface, input wire format, three output shapes
(happy / two tagged boundaries / ToolError), algorithm prose with
the Householder-vs-Gram-Schmidt rationale, eight invariants.

`package.json` — depends on `@workbench/linalg-core`.

### Lockstep docs

- Top-level `README.md` — new `linalg-qr` row inserted in the tool
  catalog table between `linalg-solve` and `integrate-1d`.
- `scripts/demo-scope.ts` — added Demo 15: Householder QR on Hilbert-8,
  prints both reported errors. The demo is a one-liner via
  `wb.linalgQr({...})` since the typed barrel auto-generates the
  binding.

## Why these choices

### Optional `mode` field, not a flag

The bench's wire format puts `mode` *inside* the input record (omitted
for the default, present as `"complete"` only when needed). This
forced one early misstep: the first cut declared `mode` as a required
field, which made all 45 reduced-mode cases fail at schema validation
("missing required field"). The fix was `S.record({ ... }, { optional:
["mode"] as const })` — the codebase's idiomatic optional-field
declaration. Routing the optional through schema rather than via
`flags` keeps the bench's wire format honest: a planner reading the
schema sees `mode` as part of the input shape, which is where it
belongs semantically.

### Tagged boundaries for non-finite and degenerate, ToolError for cap

The boundary split flips the `linalg-solve` polarity for non-finite
inputs (which `linalg-solve` currently sends to `ToolError`). Two
reasons documented in the literate header:

1. QR is *defined* for every real matrix, including rank-deficient
   ones — the substrate just produces small `diag(R)` entries. There
   is no analogue of `linalg-solve`'s `singular` tag (no boundary
   on rank-deficient input, just a rank-revealing diagonal). The
   non-finite case is the closest analogue: a structurally well-
   formed but semantically out-of-scope input.
2. The bench's `golden/inputs.json` exercises shape edges (1×1, 2×1)
   that an agent might encode with stray NaN scratch. Tagging rather
   than throwing lets a planner introspect the offending cell rather
   than receiving an opaque exit-1.

Size cap stays in `ToolError` — it's a v0.1 *scope* refusal rather
than a structural-validity question, so the suggestion-with-bead-
pointer pattern is exactly right.

### Independent recomputation in tests

The substrate self-reports `reconstructionError` and
`orthogonalityError`. Tempting to reuse those values in the test
suite. Resisted: the *bench's verifier* recomputes them, so the test
must too — otherwise a regression in the self-report would pass the
substrate test (because the test reads the same buggy formula) and
fail the bench. The duplicated recomputation is load-bearing for
"the substrate doesn't lie about its own quality."

## Frictions surfaced

1. **Required-field mismatch with the bench wire format.** The
   bench's adapter `bench/linalg-qr/run-candidate.ts` only emits
   `mode` when the caller's input has it, but my first schema cut
   declared it required. Forty-five of forty-nine cases failed
   immediately. Fix was a two-line change to use the
   `S.record({...}, { optional: ["mode"] })` form, but the diagnostic
   wasn't obvious from the bench's "candidate command exited
   non-zero" line — I had to reproduce one case by hand
   (`echo '{"A":[[3.0]]}' | bun bench/linalg-qr/run-candidate.ts`)
   to see the schema error. Worth remembering: bench-failure
   triage starts with reproducing one failing input through the
   adapter directly to surface the underlying error message.

2. **`Write` tool requires prior `Read` even on scaffold-generated
   files.** New-tool scaffolding writes `tool.ts` / `goldens.spec.ts`
   / `README.md` from a template; the next thing I want to do is
   overwrite each with the real implementation. The `Write` tool
   refuses (correctly) without a prior `Read`. Three small `Read`
   calls cost almost nothing but break the rhythm. Not a structural
   issue, just a noticed friction; documenting in case a future
   workflow change wants to bridge it.

3. **The prior-agent handoff.** The prior agent shipped the
   substrate algorithm (544 lines of literate Householder QR with
   exhaustive prose on storage conventions, sign choices, and
   backward-accumulation order) but their session ended before
   tests / tool / goldens / docs landed. Picking up the work meant
   reading the substrate end-to-end before writing anything — the
   storage convention (Householder vectors below the diagonal of
   the work array, τ in a separate length-`k` vector, implicit
   `v[0] = 1` after rescaling) is load-bearing for both the test
   recomputations and the substrate's contract with the wire layer.
   The substrate prose was excellent; landing on it cold and
   trusting it took less than ten minutes. The handoff worked.

4. **No raw-kind-literal drift introduced.** `bun run check`'s
   convention pass flags 31 raw-kind-literal sites total; none of
   them are new (the new linalg-qr files all use `record` / `list` /
   `tagged` / `str` / `int` / `float64FromNumber` constructors). The
   convention discipline carried.

5. **Schema-typed example inference.** `inp` and `encodeSuccess`
   needed *inferred narrow* return types (no explicit annotations)
   so the schema-typed `examples` slot validates structure at the
   call site. Following the `linalg-solve` `encodeSolveValue` and
   `integrate-1d` `encodeSuccess` precedents was straightforward;
   no friction.

## Acceptance

- `bun test packages/linalg-core/test/qr.test.ts` — 20 pass, 0 fail.
- `bun tools/linalg-qr/tool.ts --test` — passes 5×3 round-trip,
  Hilbert-8 orthogonality (< 1e-12), and the sign-convention probe.
- `bun scripts/generate-goldens.ts --tool linalg-qr` — wrote 34
  goldens, zero failures / mismatches.
- `bash bench/infra/run-bench.sh bench/linalg-qr bun bench/linalg-qr/
  run-candidate.ts` — 49/49 cases green; per-check totals all 49/49:
  shape, finite_entries, R_upper_triangular, Q_orthonormal,
  factorisation_residual, self_reported_residual, self_reported_
  orthogonality. **343/343 invariant assertions.**
- `bun run check` — 43 phases passed, 3 skipped, 0 failed (the
  oracle pass on linalg-qr's 34 goldens is in there).
- Top-level `README.md` catalog row added between `linalg-solve` and
  `integrate-1d`.
- `scripts/demo-scope.ts` Demo 15 invokes `wb.linalgQr` on Hilbert-8.

## Pointers

- Substrate: `packages/linalg-core/src/qr.ts` (prior agent),
  `packages/linalg-core/src/index.ts` (export added by prior agent).
- Substrate tests: `packages/linalg-core/test/qr.test.ts`.
- Tool: `tools/linalg-qr/{tool.ts, goldens.spec.ts, README.md,
  package.json, goldens/}`.
- Bench: `bench/linalg-qr/{PROMPT.md, DESCRIPTION.md, REFERENCES.md,
  run-candidate.ts, golden/{inputs.json, expected.json, verify.py,
  verifier_protocol.md}, reference/qr_reference.py}`.
- Top-level README catalog row at `README.md` between rows 124–125.
- Demo: `scripts/demo-scope.ts` Demo 15 (Hilbert-8 QR).
- ADRs: 0014 (numerical-tier precedent), 0015 (`numerical: true`
  determinism contract relaxation), 0010 (`defineTool` / `runTool`
  split), 0003 (output / error categories).
- Beads: `scientist-workbench-3jq` (this work, closed); -71f (parent
  decomposition family); -wmm (blob-by-hash for the n>200 follow-up);
  -e7y (FFI BLAS / LAPACK path).
