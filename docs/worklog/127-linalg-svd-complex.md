# 127 — linalg-svd-complex: complex SVD via one-sided Jacobi (ov4j phase 2)

**Date:** 2026-05-16
**Beads:** `scientist-workbench-jao0` (closes — `linalg-svd-complex`, phase 2 of `ov4j`).
**Touches:** `packages/linalg-core/src/svd-complex.ts` (new, 568 LOC including diagnostics + complete-mode extension); `packages/linalg-core/src/index.ts` (export); `packages/linalg-core/test/svd-complex.test.ts` (new, 25 property tests across shape edges, Pauli fixtures, Hermitian cross-check, rectangular, mode, rank-deficient, self-honesty, determinism); `tools/linalg-svd-complex/{tool.ts, package.json, README.md, goldens.spec.ts, goldens/}` (new tool, 35 goldens, ≥15 invariants, `--test` hook with 5 invariant probes); `tools/trace-norm/tool.ts` (extended with non-Hermitian SVD path; legacy `trace-norm/non-hermitian-input` refusal retired); `tools/trace-norm/goldens.spec.ts` (3 previously-refusal goldens regenerated as SVD-path success goldens); `tools/trace-norm/goldens/` (35 regenerated); `README.md` (catalog row added for `linalg-svd-complex`; `trace-norm` row updated for two-path dispatch).
**Net diff:** ~1900 LOC added (substrate + tool + tests + docs + goldens), ~60 LOC trace-norm refusal-path replaced with dispatch logic.

## Context

ADR-0035 (the complex-linalg tier, 2026-05-13) named three deliverables: `linalg-eigh-complex` (phase 1, shipped via bead `pom8` 2026-05-13), `linalg-svd-complex` (phase 2, this shard), `linalg-solve-complex` (phase 3, still to file). The phase-1 deliverable unblocked `tools/trace-norm` (shipped via bead `korg`) on its Hermitian path only — non-Hermitian square inputs refused with `trace-norm/non-hermitian-input` pending the SVD path. The qinfo v0.2 surface (`trace-distance`, `fidelity`, `purity`) was already shipped riding the Hermitian path.

`jao0` was filed at the start of this session as the ov4j child bead for phase 2. The first draft of the bead description proposed using the real-symplectic embedding for SVD by analogy with eigh-complex. Reading ADR-0035 §D8 corrected this: *"the symplectic embedding buys nothing for SVD"*. The right algorithm is **complex one-sided Jacobi** (Hari-Veselić 1987) — native complex arithmetic on the columns of M, no embedding. The bead description was updated to reflect the correct algorithm before any code was written.

## What changed

### Substrate: `svdComplex` in `packages/linalg-core/src/svd-complex.ts`

A clean port of the real `svdJacobi` (the high-precision lane in `linalg-core`'s real SVD) lifted to complex Jacobi rotations. The per-pair update is the complex-specific delta: each column-pair rotation requires a **phase extraction** before the real Jacobi tangent recipe, because the complex Gram inner product `γ = ⟨W[:,p], W[:,q]⟩` is generally not real. The recipe:

1. Compute Gram entries `α = ‖W[:,p]‖²`, `β = ‖W[:,q]‖²`, `γ = Σ conj(W[i,p])·W[i,q]`.
2. Drmač 1997 §4.2 per-pair tolerance: skip if `|γ|² ≤ ε²·α·β` (the relative-accuracy test).
3. Extract phase: `e^{-iθ} = conj(γ) / |γ|`. After applying this to column q, `γ' = e^{-iθ}·γ = |γ|` is real and the Gram matrix is `[[α, |γ|], [|γ|, β]]`.
4. Real Jacobi tangent recipe on the now-real Gram: `ζ = (β−α)/(2|γ|)`, `t = sgn(ζ)/(|ζ| + √(1+ζ²))`, `c = 1/√(1+t²)`, `s = t·c`.
5. Apply the combined complex rotation to columns p and q of W and to the accumulator V.

The convergence story (Hari-Veselić 1987 §3): the off-diagonal mass `Σ |⟨W[:,p], W[:,q]⟩|²` decreases monotonically each rotation, so the algorithm converges to a sweep with no rotations fired. Empirical cap at 60 sweeps matches the real Jacobi precedent.

Post-processing matches the real one-sided Jacobi pattern: column norms → S; `U_work[:,j] = W[:,j]/σ_j` (with complex Gram-Schmidt completion for numerically-zero σ); permute columns of U_work and V by descending σ; for `m < n` we worked on `M†`, so swap `(U_work, V) ↔ (V_final, U_final)` at the end. Reduced mode trims to `k = min(m, n)`; complete mode extends to square via complex Gram-Schmidt completion.

Diagnostics (agent-honest self-report, ADR-0014 pattern): `reconstructionError = ‖M − U·diag(S)·V†‖_F / max(‖M‖_F, 1)`; `orthogonalityErrorU = ‖U†U − I‖_F`; `orthogonalityErrorV = ‖V†V − I‖_F`; `conditionNumber = S[0]/S[k-1]` (capped at 1/ε); `rankEstimate = #{σ_i > max(m,n)·ε·σ_max}`. All computed in complex arithmetic via the existing `complexMatmul` and `complexAdjoint` helpers from `complex-matrix.ts` (shipped with phase 1).

Verified at machine precision on probes spanning real diagonal, Pauli X/Y/Z, rectangular m>n and m<n, Hermitian (cross-checked against `eighComplex`'s eigenvalues), generic complex 2×2 (singular values match NumPy to bit-level on the chosen probe). Reconstruction errors are ~10⁻¹⁶ across the board; orthogonality errors similar.

### Wire tool: `tools/linalg-svd-complex/`

Mirrors `linalg-eigh-complex`'s shape with three SVD-specific deltas:

1. **Input includes `mode?: string`** ("reduced" | "complete", default "reduced"). Parallel to real `linalg-svd`'s mode field.
2. **Output emits `Vh = V†`** (conjugate transpose), not `V` itself, matching NumPy `np.linalg.svd` convention and the real tool's `Vt`. The substrate keeps `V` in its result so the substrate-side reconstruction diagnostic uses `M·V − U·diag(S)` directly without an extra adjoint; the tool wrapper computes `Vh = complexAdjoint(V)` once for the wire emission.
3. **No `non-hermitian-input` refusal class**: SVD is well-defined for any complex matrix, square or rectangular. The boundary categories are just `non-finite-input` and `degenerate-shape`; non-square is *not* a refusal (unlike `linalg-eigh-complex`, which rejects non-square Hermitian eigh as undefined).

35 goldens covering: shape edges (1×1, 2×2 identity / zero / diagonal), Pauli matrices (X / Y / Z), Hermitian 2×2 with imaginary off-diagonal (rank 1), generic complex 2×2, rectangular tall (3×2, 4×2) and short (2×3, 2×4), 3×3 tridiagonal Hermitian (sweep convergence), 4×4 multi-qubit (Z⊗Z, Bell density, X⊗Y), rank-deficient (2×2 outer product, well-separated diag with LAPACK-threshold rank), reduced + complete modes, every boundary tag. The `--test` hook runs 5 invariant probes (diagonal, Pauli Y, Hermitian rank-1, rectangular m<n shape, generic 2×2 ordering).

### Extension: `tools/trace-norm` lifts the Hermitian-only restriction

Two-path dispatch internal to the tool:
- Hermitian input (max|M − M†| ≤ 100·EPS·max|M|) → `eighComplex`, `value = Σ |λ_k|`, success record carries `eigenvalues` field with `method = "hermitian-via-eigh-complex"`.
- Non-Hermitian input → `svdComplex`, `value = Σ S_k`, success record carries `singular_values` field with `method = "general-via-svd-complex"`.

Wire schema changes:
- `eigenvalues` and `singular_values` declared **optional** in the success record (mutually exclusive in practice; the `method` string discriminates).
- The `trace-norm/non-hermitian-input` tagged refusal class is **removed** from the output union. This is schema-additive in the sense that a refusal class is by nature "may or may not appear" — pattern-matching callers stay structurally valid, just see that branch never fire. Any planner that relied on the tag for routing should now check the `method` field instead.

The 3 previously-refusal goldens (non-Hermitian symmetric-im, nonzero-diagonal-imaginary, real-asymmetric M=[[1,2],[3,4]]) regenerated as success goldens with `method = "general-via-svd-complex"` and `singular_values` populated. Total trace-norm golden count unchanged (35); the count of *success* goldens went up by 3 (32 → 35), the count of *refusal* goldens went down correspondingly.

## Why these choices

**Complex one-sided Jacobi, not real-symplectic embedding.** ADR-0035 §D8 said this explicitly; the implementation honoured it. The embedding's eigenvalue-pairing trick that makes `linalg-eigh-complex` viable hinges on the spectral theorem's `Q · diag(λ) · Q†` structure: each Hermitian eigenvalue appears with multiplicity 2 in the 2n × 2n real-symmetric embedded matrix, so dedupe + lift recovers the complex eigenvectors. SVD has *distinct* U and V matrices; the analogous 2m × 2n real-embedded SVD produces singular values paired with messy interleaving and no clean post-processing. Native complex Jacobi, by contrast, ships in ~500 LOC of pure complex arithmetic with the same relative-accuracy property as real Jacobi (Demmel-Veselić 1992 carries to complex via Hari-Veselić 1987). The first bead description proposed the embedding by analogy — caught and corrected during the ADR re-read, before any code was written. Ground truth before code (Law 1).

**Drmač's per-pair tolerance test, not absolute.** The convergence test `|γ|² ≤ ε² · α · β` is *relative* — it skips pair (p, q) when their inner product is already small relative to the column norms. The naive alternative `|γ| ≤ ε` is absolute and breaks relative accuracy on inputs with extreme column-norm spread (e.g., the well-separated diag(1e-8, 1, 1e8) test case). Drmač 1997 §4.2 is the canonical reference; we follow it for the same reason the real `svdJacobi` does (the inherited Demmel-Veselić accuracy bound only holds under the relative test).

**Wire emits `Vh = V†`, not `V`.** NumPy `np.linalg.svd` returns `(U, S, Vh)` with `Vh` the conjugate transpose. The real `linalg-svd` already emits `Vt = Vᵀ`. Matching the convention means a caller who has used NumPy or LAPACK for any complex SVD work reaches for `Vh` reflexively. The substrate-side `V` is kept for the diagnostic path because the reconstruction error `‖M·V − U·diag(S)‖_F` reads more naturally with `V` than with `Vh` (and avoids an extra adjoint allocation per call).

**`singular_values` as a new field, not field-overloaded `eigenvalues`.** The two paths produce semantically different quantities: Hermitian eigenvalues are real (with sign), singular values are non-negative. Routing them through the same field name and discriminating only by `method` was tempting (zero schema change), but it's mildly dishonest — a caller reading `eigenvalues = [2.5, 1.2]` after a non-Hermitian dispatch would be wrong to interpret them as eigenvalues. The optional-field discriminated-union shape is more work (4 lines of schema, both fields declared optional via `{ optional: ["eigenvalues", "singular_values"] as const }`) but says exactly what's in the record. Same shape as the real `linalg-svd` separates `S` and (in eigh) `eigenvalues`; this preserves the parallel.

**Retire the non-Hermitian refusal class rather than gate behind a flag.** A flag like `--allow-non-hermitian=false` (default true) would be more backward-compatible but adds a knob with no current consumer wanting it. The bead description was "lift the restriction" without conditions. The lift is the right default; future callers who want strict Hermitian validation should either check the matrix themselves or invoke `linalg-eigh-complex` directly. The retired tag stays documented in the README "What changes" sense via the catalog row update.

## Frictions surfaced

**ADR-bead mismatch on algorithm choice.** The bead I filed claimed real-symplectic embedding for SVD; the ADR explicitly said otherwise. Caught at the ADR re-read (the first thing after claiming the bead per Law 1) rather than at implementation time, which would have wasted a substrate write. Pattern: when filing a child bead under a settled ADR, *read the relevant ADR section in the bead description PR* rather than going from the parent epic's notes alone. Worklog 125's similar lesson for atip applies — bead descriptions written in haste during a previous session can carry inherited errors.

**The complete-mode extension code is `complexExtendOrthonormal` calling `complexCompleteOrthonormal` twice (once for each new column-set range).** Slightly noisy because the helper builds a `Set<number>` of "filled" columns and walks unit basis vectors `e_k` to find one that projects out non-trivially. Real `linalg-svd` has the same shape (`extendOrthonormal` calling `completeOrthonormal`); the complex version is a straight port with `conj` added in the inner-loop dot products. No simplification justified at this scope; could be refactored if the qinfo workload ever exercises complete mode heavily.

**Initial test expectation wrong on LAPACK rank threshold.** Wrote a test asserting `rank = 3` for `diag(1e-8, 1, 1e8)` — actually the LAPACK convention reports `rank = 2` because `σ_min = 1e-8 < max(m,n)·ε·σ_max ≈ 6.7e-8`. Caught immediately by the test failure; updated the test to reflect the LAPACK threshold (and added a sibling test where `σ_min` is comfortably above threshold to exercise the `rank = full` path). Real LAPACK behaviour, real test bug; the fix is the test, not the algorithm.

**Trace-norm goldens spec retained stale descriptions.** The 3 previously-refusal goldens kept their "tagged non-hermitian-input" descriptions even though they now route to SVD. Updated descriptions to "non-Hermitian-X routes via SVD"; the file slot order is preserved (golden numbers unchanged) but the descriptions are now accurate. Minor — caught after regenerating goldens and inspecting one to confirm the SVD path emitted.

**Two `bd dep add` calls bounced** on "tasks can only block other tasks, not epics" and "type" syntax. Used `bd dep add jao0 ov4j --type parent-child` (with the right `--type` value from `bd dep add --help`) on the second try; the parent-child link landed and `bd show jao0` reflects the BLOCKS relationship. The warning about Dolt auto-push to remote git is pre-existing (the Dolt remote is behind the actual `git push` cadence; the local DB is consistent). Worth a follow-up to either suppress the auto-push warning or align Dolt remote with the post-`git push` state.

## Acceptance

- `jao0` closes. Substrate, tool, trace-norm extension, README catalog, worklog all shipped in one session.
- `bun run typecheck` clean.
- `bun test packages/linalg-core/ tools/linalg-svd-complex/ tools/linalg-eigh-complex/ tools/trace-norm/ tools/trace-distance/ tools/fidelity/ tools/purity/`: 146 pass / 0 fail / 1250 expect() calls.
- `bun tools/linalg-svd-complex/tool.ts --test`: passes (5 invariant probes).
- `bun tools/trace-norm/tool.ts --test`: passes (8 probes — unchanged from pre-`jao0`).
- 35 `linalg-svd-complex` goldens generated; 35 `trace-norm` goldens regenerated (3 changed from refusal to success).
- ADR-0035 §D8 phase 2 status moves from "filed" to "shipped". `ov4j` epic has one phase remaining (`linalg-solve-complex`, not yet filed).

## Pointers

- ADR — `docs/adr/0035-complex-linalg-tier.md` (§D5 algorithm note; §D8 phase order; §D2 wire shape).
- Math reference — Hari-Veselić 1987 ("On Jacobi methods for singular value decompositions", SIAM J. Sci. Stat. Comp. 8(5):741-754); Drmač 1997 ("Implementation of Jacobi rotations for accurate singular value computation in floating point arithmetic", SIAM J. Sci. Comput. 18(4):1200-1222); Demmel-Veselić 1992 ("Jacobi's method is more accurate than QR", SIAM J. Matrix Anal. Appl. 13(4):1204-1245).
- Phase-1 worklog (eigh-complex) — `docs/worklog/100-` (or the relevant shard; the substrate code at `packages/linalg-core/src/eigh-complex.ts` is the template this shard mirrors).
- Substrate — `packages/linalg-core/src/svd-complex.ts`.
- Tool — `tools/linalg-svd-complex/`.
- Trace-norm extension — `tools/trace-norm/tool.ts:550-660` (the two-path dispatch in `fn`).
- Bead — `bd show jao0`.
- Next ov4j phase: file `linalg-solve-complex` bead (complex LU with partial pivoting + iterative refinement + complex Hager 1-norm condition estimator; algorithm is a clean port of real `linalg-solve` per ADR-0035 §D8 phase 3).
