# 047 — linalg-eigh via the tstournament-protocol bench

**Date:** 2026-05-05
**Status:** complete
**Branches:** main
**ADR:** none — applies ADR-0014 (numerical-tier precedent), ADR-0015
(`numerical: true` opt-in), ADR-0016 (warning-based scaling, no hard
cap), ADR-0010 (`defineTool`/`runTool` split), ADR-0003 (output / error
categories).
**Issues closed:** scientist-workbench-evb

## Context

Worklogs 043 (`linalg-qr`) and 044 (`linalg-svd`) established the
tournament-protocol bench loop for the numerical tier; worklog 045
swept those two tools through the ADR-0016 cap lift (no `n ≤ 200`
ceiling, scale warnings instead, OOM-as-`ToolError`) and added the
NIST harwell-boeing industrial cases. `linalg-eigh` is the third slice
of the `linalg-decompose` family (parent bead 71f) and ships with the
post-ADR-0016 standards from day 1.

`A = Q · diag(λ) · Qᵀ` for symmetric `A` is a richer answer than QR
or SVD on the same input: the eigenvalues `λ` carry sign information
that singular values discard, and the `Q · diag(f(λ)) · Qᵀ` recipe
extends to matrix functions (exp, sqrt, log) — the use case that
motivates eigh in agent planning. We deliberately ship symmetric eigh
only; the non-Hermitian `linalg-eig` (complex eigenvalues, Schur
decomposition) is bead `evh` for a later iteration.

The bench scaffold (`bench/linalg-eigh/`) had landed in a prior
session; this shard records the candidate-implementation slice.  The
pattern is identical to QR's and SVD's — read PROMPT.md, mirror
`tools/linalg-svd/tool.ts` shape, implement substrate, wire the tool,
generate goldens, validate.

## What changed

### Substrate — `packages/linalg-core/src/eigh.ts` (~340 lines)

Cyclic-by-rows Jacobi (Jacobi 1846; Forsythe-Henrici 1960 for the
cyclic-convergence proof; Golub & Van Loan §8.4 for the modern form;
Demmel-Veselić 1992 for the high-relative-accuracy result). A
"sweep" walks every unordered pair `(p, q)` with `0 ≤ p < q < n`. For
each pair, compute the Jacobi rotation that diagonalises the 2×2
block `[D[p,p] D[p,q]; D[p,q] D[q,q]]`, apply the similarity
transform `Jᵀ D J` in place (preserving eigenvalues) and accumulate
the rotation into `Q`. After convergence (zero rotations needed in a
complete sweep), the diagonal of `D` holds the eigenvalues and `Q`'s
columns are the eigenvectors. We then sort eigenvalues ascending and
permute `Q`'s columns to match.

**Algorithm choice (Jacobi vs tridiag+QR).** Both are admissible by
the bench's tolerance regime; the bench tests the result, not the
algorithm. Jacobi wins the implementation budget at our scale:
~340 lines vs ~600+ for tridiag+QR (Householder tridiag + implicit-
shift QR sweeps with Wilkinson shifts + deflation + post-sort). And
Jacobi achieves high relative accuracy on small eigenvalues —
independent of `κ(A)` — where tridiag+QR can lose half the digits.

**Substrate symmetry policy.**  The substrate accepts any square
matrix and runs Jacobi unconditionally — symmetry is the *caller's*
contract. This mirrors `qr()` and `svd()`'s discipline (substrate is
permissive on rectangular shape; tool layer rejects non-finite,
degenerate, or asymmetric).  The tool layer above enforces the
symmetry contract via the `linalg-eigh/non-symmetric-input` boundary
tag *before* calling `eigh()`.

**Update form.**  We use the Demmel-Veselić 1992 form for the
diagonal update: `D[p,p] ← α − t·γ`, `D[q,q] ← β + t·γ` (more
accurate than the closed `c² α + s² β − 2cs γ` form when `c ≈ 1`).
The off-block update walks every `i ∉ {p, q}` and rotates the
`(i, p)` and `(i, q)` entries, mirroring to `(p, i)` and `(q, i)` to
maintain symmetry of `D`.

**Self-reported diagnostics.** Computed inside the algorithm on the
*actual* returned `Q` and `λ` — same formulas the verifier uses
(`np.linalg.norm(A @ Q - Q @ diag(λ), ord='fro') / max(||A||_F, 1)`,
`np.linalg.norm(Qᵀ Q - I, ord='fro')`). Mirroring the verifier
expression keeps the candidate's self-report inside the verifier's
1e-6 relative tolerance band on the bench's 45 success cases.

### Tool — `tools/linalg-eigh/tool.ts` (~530 lines)

Wire wrapper around `eigh()`. Mirrors `linalg-svd/tool.ts` chapter-by-
chapter:

- ADR-0014/0015/0016 chapter header with the "fifth numerical-tier
  tool" framing, why-Jacobi-not-tridiag-QR, and the agent-honest
  output justification.
- `S.*` schema constructors. Input is `{A: list<list<float64>>}`
  (no optional `mode` — eigh has no mode flag; the symmetric case is
  fully determined). Output union covers the success record plus
  three boundary tags.
- `numerical: true` annotation; `--method=jacobi` flag for
  forward-compatibility with a future `tridiag-qr` substrate.
- Four boundary categories per ADR-0003: `non-symmetric-input`,
  `non-finite-input`, `degenerate-shape` (all tagged); `non-square`,
  `non-rectangular`, OOM (all `ToolError`). Symmetry-tag payload
  carries `(row, col, value, max_asymmetry)` mirroring SciPy's
  reference's payload format (worst asymmetry coordinate from
  `np.argmax(|A − Aᵀ|)`).
- `assessNumericalScale("eigh", n, n)` for warnings + `withOomGuard`
  for the only physical refusal class (ADR-0016).
- `--test` hook covering 5×5 symmetric, Hilbert-8, and the diagonal
  case (eigenvalues == sorted diag entries).
- `if (import.meta.main) void runTool(def);` trailing line per
  ADR-0010.

### Tests — `packages/linalg-core/test/eigh.test.ts` (~340 lines)

21 tests across 8 describe blocks: shape edges (1×1, 2×2 zero/identity,
5×5 identity, diagonal); eigenvalues-ascending across n ∈ {3,5,10,20,50};
random-symmetric reconstruction at n=10 (20 trials seeded) and n=50;
Hilbert-8 / Hilbert-12 (the κ-independence advertisement);
rank-deficient `u·uᵀ` and the all-zero matrix; repeated and
near-degenerate eigenvalues; self-report cross-check (matches an
independent recomputation to 1e-12 relative); condition number
(identity, SPD diag, singular). Each test asserts a load-bearing
invariant; the tail of the file documents 6 mutation hooks a reviewer
can flip to confirm the tests would catch real regressions.

### Goldens — `tools/linalg-eigh/goldens.spec.ts` (33 cases)

Shape edges + diagonal + small symmetric + Hilbert-{4,6,8,10} +
Wilkinson-{5,11} + Pei-5 + rank-deficient (rank-1 outer, all-zero,
identity-with-zero) + repeated/near-degenerate + well-separated
extremes + alternating signs + every boundary category (non-symmetric,
non-finite, degenerate-shape).

### README — `tools/linalg-eigh/README.md` (~190 lines)

Mirrors `linalg-svd`'s README in shape: input/output JSON schemas
including all three tagged boundaries; algorithm note (cyclic Jacobi,
why-not-tridiag-QR); invariant list; standard flags. The library
surface example (`import { eigh } from "@workbench/linalg-core"`) gives
the TS-side caller the agent-irresistible answer.

### Catalog row

Added the `linalg-eigh` row to the top-level `README.md` catalog
immediately after `linalg-svd`, with the same "what / boundary /
references" detail level as the SVD row. Bench size noted: 46 cases ×
7 checks + 1 boundary = 316 invariant assertions.

### Demo

Added a `linalg-eigh` example to `scripts/demo-scope.ts` (Demo 17): the
Pei matrix `αI + eeᵀ` for n=5, α=1, which has eigenvalues
`(1, 1, 1, 1, 6)`. The demo prints the recovered eigenvalues plus the
self-reported reconstruction and orthogonality errors.  Regenerated
`packages/compose/src/generated/wb.ts` so the typed barrel includes
`wb.linalgEigh(...)`.

## Why these choices

1. **Cyclic-by-rows over Jacobi-classical (largest-pivot).**
   Cyclic-by-rows visits each `(p, q)` pair exactly once per sweep —
   `O(n²)` decisions per sweep, no need to track the largest off-
   diagonal. Classical Jacobi picks the largest |D[p,q]| each step,
   which converges in fewer rotations but pays `O(n²)` to find each
   pivot — same cost per sweep, but with a more complex inner loop.
   At our scale they're indistinguishable; cyclic wins on simplicity.

2. **Per-sweep convergence test (zero-rotations) over per-step.**
   Per-step convergence requires recomputing ‖D_off‖_F after each
   rotation — `O(n²)` work to confirm a single rotation. Per-sweep
   confirms convergence in `O(1)` (just count the sweep's rotations);
   the worst case is one extra sweep that does nothing.

3. **Demmel-Veselić diagonal update form.**  `D[p,p] ← α − t·γ`,
   `D[q,q] ← β + t·γ` is *exactly* the closed form when `c ≈ 1`
   (always true for small rotations) and avoids the squared term
   `c²·α + s²·β` losing the leading bits when `α ≈ β`.  Costs zero
   extra ops, gains 1-2 digits of accuracy on near-degenerate
   eigenpairs.

4. **Symmetry threshold matches the verifier's `_is_symmetric`.**
   `max|A − Aᵀ| > 100·ε·max|A|` is the bench's threshold (verifier
   line 87); we mirror it exactly so a passing-candidate's symmetry
   decision matches the bench's. The "100×" factor accommodates
   `(A + Aᵀ)/2` symmetrisation roundoff (~ε·max|A|) while rejecting
   genuine asymmetry.

5. **Symmetry payload mirrors SciPy reference.** The bench's verifier
   only checks the *tag* on boundary cases (it doesn't read the
   payload), but mirroring SciPy's `(row, col, value, max_asymmetry)`
   shape keeps the agent-facing API consistent across reference and
   candidate.

## Frictions surfaced

1. **Tool naming mismatch with worklog headers.**  Initial bead
   description called this the *third* slice; the actual numbering
   in PROMPT.md and the catalog has it as the *fifth* numerical-tier
   tool (after `linalg-solve`, `integrate-1d`, `linalg-qr`,
   `linalg-svd`). The chapter header in `tool.ts` and worklog reflect
   the corrected count.

2. **Substrate-vs-tool symmetry policy.** First instinct was to make
   `eigh()` reject non-symmetric A with `MatrixError`. Re-reading
   `qr()` and `svd()` showed neither rejects shape-only invariants
   (only true degenerate-storage corners); the tool layer is the
   right place for the *contract* check (asymmetry → tagged boundary).
   Substrate stays permissive, tool layer enforces. This matches the
   "ground truth before code" rule: the precedent files were the
   ground truth for where the policy lives.

3. **Bench passed on first run.** No iteration loop needed — the
   pattern from worklogs 043/044 is now well-enough understood that
   the substrate + tool came together without any per-check failure.
   That said, the substrate test suite caught two intermediate bugs
   during development that *would* have failed bench checks 4-5
   (orthogonality / eigendecomp_residual) — fixed in-place before
   the bench ever saw the code. Substrate tests as the inner loop
   continue to be the right discipline.

## Acceptance

- Per-check bench totals: shape 45/45, finite_entries 45/45,
  eigenvalues_ascending 45/45, Q_orthonormal 45/45, eigendecomp_residual
  45/45, self_reported_residual 45/45, self_reported_orthogonality
  45/45, boundary 1/1. **Total 316/316**.
- `bun run check`: 47 phases passed, 3 skipped, 0 failed.
- Substrate tests: `bun test packages/linalg-core/test/eigh.test.ts`
  → 21 pass, 194 expect() calls.
- Demo (`bun scripts/demo-scope.ts`) runs end-to-end, includes the
  new `linalg-eigh` step, total wall-clock ~600 ms across 25 tools.

## Pointers

- ADRs: `docs/adr/0014-first-numerical-tier.md`,
  `docs/adr/0015-determinism-tier.md`,
  `docs/adr/0016-warning-based-numerical-scaling.md`,
  `docs/adr/0010-tool-module-shape.md`,
  `docs/adr/0003-tool-output-error-patterns.md`.
- Substrate: `packages/linalg-core/src/eigh.ts`.
- Tool: `tools/linalg-eigh/tool.ts`.
- Bench: `bench/linalg-eigh/`.
- Precedents (this shard's direct ancestors):
  `docs/worklog/043-linalg-qr-via-bench.md`,
  `docs/worklog/044-linalg-svd-via-bench.md`,
  `docs/worklog/045-numerical-tier-cap-lift-and-industrial-bench.md`.
