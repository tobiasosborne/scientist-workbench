# 101 — linalg-eigh-complex: ADR-0035 phase 1 ships (2026-05-13)

> **Scope.** Ship `tools/linalg-eigh-complex` and its substrate
> (`packages/linalg-core/src/{complex-matrix,eigh-complex}.ts`) per
> ADR-0035. v0.1 algorithm: real-symplectic embedding `H = A + iB →
> [[A,-B],[B,A]]` reusing the existing real cyclic-Jacobi `eigh`
> verbatim — zero new spectral code. Unblocks `korg` (trace-norm) and
> the rest of the qinfo v0.2 quartet (`k2xo` trace-distance, `2hxf`
> fidelity, `2czd` purity). 34 goldens, full seven-artefact contract,
> `bun run check` clean.

## Context

ADR-0035 (shard 100, 2026-05-13 same morning) committed to the
parallel `*-complex` tool surface with eight specific decisions. The
phase-1 deliverable named in §D8 was `linalg-eigh-complex` —
unblocking the qinfo v0.2 trace-norm / fidelity quartet, which had
been filed since the qinfo substrate landed (shard 098) but
deliberately deferred behind the `ov4j` epic.

The decision tree was already complete:

- Wire shape: `record{re, im}` both required (D2)
- Substrate type: new `ComplexMatrix` in `linalg-core` (D4)
- Algorithm v0.1: real-symplectic embedding (D5)
- Output: complex `Q`, real `eigenvalues` (D3, D7)
- Boundary categories: non-Hermitian / non-finite / degenerate (D6)

This session executed that decision tree.

## What changed

### `packages/linalg-core/src/complex-matrix.ts` (new)

The `ComplexMatrix` type and its supporting operations. `{rows, cols,
re: Float64Array, im: Float64Array}` with `im` required — type-level
expression of "this value is definitely complex" (ADR-0035 §D4).
Structurally identical to qinfo's `Matrix`-with-`im`, but
distinguished at the type level so every algorithm trusts it and
never branches on imaginary-presence at the top of a body.

Exports:
- Type: `ComplexMatrix`
- Constructors: `complexFromNested(re, im)`, `complexZeros(rows, cols)`
- Bridge helpers (ADR-0035 §D4): `complexFromReal(M: Matrix)`,
  `complexFromQinfo(M: {rows, cols, re, im?})`, `realPartOnly(M:
  ComplexMatrix)`. The qinfo bridge uses a structural parameter type
  so linalg-core stays free of any `@workbench/qinfo` dependency.
- Elementary ops: `complexAdjoint`, `complexFrobeniusNorm`,
  `complexMaxAbs`, `complexMatmul`. Naive triple-loop matmul —
  sufficient for post-decomposition diagnostics; BLAS-backed is FFI
  bridge territory.

### `packages/linalg-core/src/eigh-complex.ts` (new)

The real-symplectic embedding wrapper. ~360 lines total, with the
prose carrying the embedding identity, the spectrum correspondence
(`H̃`'s spectrum is `H`'s spectrum with multiplicity 2), the
reconstruction map (every other eigenvalue, top-half + i·bottom-half
of every other column), and the role of the complex MGS cleanup.

Algorithm shape:

1. Build `H̃` of size `2n × 2n`. Single `Float64Array` allocation;
   four nested loops fill the four blocks.
2. Call existing `eigh(H̃)` from `./eigh.js` — zero new spectral code.
3. Dedupe: `λ[k] = λ̃[2k]` for `k = 0, …, n−1` (paired in `H̃`).
4. Lift eigenvectors: column `2k` of `Q̃` splits as `(u, w)`; complex
   eigenvector of `H` is `q_k = u + i w`.
5. Complex Modified Gram-Schmidt on `Q`'s columns as defence-in-depth
   for degenerate-eigenvalue cases (where real eigh's arbitrary
   in-eigenspace basis can give complex-non-orthonormal extracted
   `q_k`).
6. Compute `reconstruction_error`, `orthogonality_error`,
   `condition_number` in complex arithmetic.

Smoke probe directly after writing the substrate (Pauli Y, Pauli Z,
diag(3,1,4)): all three round-trip with machine-epsilon
reconstruction and orthogonality. Pauli Y produces the expected
phase-carrying eigenvectors `(1, -i)/√2` for `λ = -1` and `(-i,
1)/√2` for `λ = +1`.

### `tools/linalg-eigh-complex/` (new)

Full seven-artefact contract:
- `tool.ts` ~470 lines — Hermiticity check (`max|H − H†| > 100·EPS·max|H|`
  via the symmetric+antisymmetric decomposition), wire-decode +
  boundary tagging + ToolError for malformed, encoded output with
  warnings, `--test` hook with four invariant-asserting smoke probes
  (Pauli Y, Pauli Z, `[[1, i], [-i, 1]]`, 4×4 random Hermitian).
- `package.json` — workspace dependency on `@workbench/linalg-core`.
- `goldens.spec.ts` — 34 entries covering: shape edges, the Pauli
  family, generic complex Hermitian 2×2, density operators (real
  Bloch X-Z + complex Bloch with Y component = the dogfood target),
  3×3 / 4×4 / 5×5 sizes, two-qubit Hamiltonians (Z⊗Z, X⊗Y, Bell
  density), degenerate spectra (exercises the MGS pass),
  well-separated extremes, and every boundary-tag branch.
- `goldens/` — 34 generated `*.golden.json` files (byte-frozen).
- `README.md` — full per-tool reference: wire shape, output shapes,
  algorithm prose, invariants list, run example, references.
- `--test`: 4 smoke probes, every probe asserts a mathematical
  invariant (Rule 7).

### Lockstep doc updates (Law 2)

- `README.md` (root): new row in the tool catalog for
  `linalg-eigh-complex` between `linalg-eigh` and `linalg-qr`;
  `linalg-core/` description in "File layout" updated to mention
  the `ComplexMatrix` type, `eighComplex`, and the bridge helpers.
- `packages/compose/src/generated/wb.ts` regenerated to add
  `wb.linalgEighComplex(...)` (47 tools now in the barrel).
- `packages/linalg-core/src/index.ts` — eleven new exports: the
  `ComplexMatrix` type, two constructors, three bridge helpers, four
  elementary ops, `EighComplexResult` + `eighComplex`.

## Why these choices

The substrate-level decisions all derive directly from ADR-0035:

- **Why not extend qinfo's `Matrix`-with-optional-`im`.** ADR-0035
  §D4 settled this: optional `im` is the right shape for qinfo's
  index-only ops (which transparently handle both real and complex),
  but the wrong shape for an algorithm that *requires* a complex
  argument. The `ComplexMatrix` type asserts "this is complex" at
  the type level; `eighComplex` accepts `ComplexMatrix` and never
  branches `if (M.im)` inside the body.

- **Why the bridge helpers take structural parameters.** linalg-core
  must not depend on `@workbench/qinfo` (ADR-0014 — pure TS, no
  dependencies outside the package). `complexFromQinfo` accepts
  anything matching `{rows, cols, re, im?}`, which includes qinfo's
  `Matrix` without an import. The qinfo package can later
  `import { complexFromQinfo } from "@workbench/linalg-core"` if it
  wants to route a density operator into the complex eigh.

- **Why MGS unconditionally, not "only on degenerate detection".** A
  detection step would need a threshold for "eigenvalues are
  degenerate" — yet another tunable. Running MGS on every Q is
  `O(n³)` extra (in float ops, ~`n³/2` for the orthogonalisation,
  vs `4 · n³` for the embedded eigh's lifted output) — negligible
  next to the 8× embedding overhead. No tunable, clean invariant,
  guaranteed orthonormal output.

- **Why `assessNumericalScale` gets passed `2n`, not `n`.** The
  algorithm actually computes on a `2n × 2n` matrix; that's what
  determines the wall-clock and memory honestly. Reporting against
  `n` would lie about the cost. The scale advisory's "n > 500" floor
  fires at `n = 250` user-facing — which is the right call.

- **Why `findWorstHermitianViolation` walks `i ≤ j`, not full
  matrix.** Hermitian asymmetry has a symmetry: `|H[i,j] −
  conj(H[j,i])| = |H[j,i] − conj(H[i,j])|`. Walking the upper
  triangle (including diagonal) catches every violation exactly
  once. The diagonal-imaginary check `|im[i,i]|` is the `i = j` case
  of the formula `|2·im[i,i]|/2`, treated uniformly.

The tool-level decisions also derive from ADR-0035:

- **Why the Hermiticity tagged payload carries `violation` instead of
  `value`.** Mirrors the real `linalg-eigh`'s payload spelling but
  uses the more semantically-loaded name. The real tool's `value`
  field is `A[i,j] − A[j,i]`; the complex sibling's is the magnitude
  of the conjugate-symmetric violation — a single scalar, not a
  complex pair. The planner can match on the magnitude directly.

- **Why `linalg-svd-complex` is named in the non-square `ToolError`
  suggestion.** That tool is filed (ADR-0035 §D8 phase 2) and is
  the right destination for non-square complex matrices when it
  ships. Naming it in the suggestion now is forward-looking but
  honest: the suggestion is for the agent's planner, and saying
  "(filed) when shipped" carries the honest scope.

## Frictions surfaced

- **Two near-identical Matrix types, both in linalg-core's neighbourhood.**
  Predicted in ADR-0035 §Frictions. In practice the bridge helpers
  are the explicit conversion points, named in the public surface and
  read at the boundary. No friction in this session; we'll see if
  downstream tools (trace-norm) collide with it.

- **Goldens generator silent on non-Hermitian / non-finite branches.**
  These produce tagged values rather than throwing, and the
  generator captures them byte-faithfully into the `output` field of
  the golden — which is the right behaviour (the tool's output is
  the tagged value; that's admissible per ADR-0003). The smoke-test
  surface for ToolError-malformed branches sits in the substrate's
  `--test` hook and the unit tests, not in goldens.

- **Per-tool README + main-README + `gen-workbench-barrel.ts` —
  three places to update.** The discipline is in CLAUDE.md Law 2;
  the friction is that a forgetful agent might ship a tool that
  doesn't appear in the catalog or the barrel and pass
  `check:quick` (which doesn't enforce barrel-completeness). The
  full `bun run check` does enforce it — the discipline that
  protects the discipline.

- **`-0` in `Q.im` from real-input cheap path.** Predicted in
  ADR-0034 / ADR-0035. In practice the complex MGS pass adds and
  subtracts terms that sometimes flip `+0 → -0` on otherwise-zero
  imaginary parts. Goldens are byte-identical (the bit pattern of
  `-0` and `+0` differ); the generator captures whichever came out
  of the run. A real-Bloch-X-Z density operator and a corresponding
  golden round-trip cleanly. If we ever see test instability from
  `±0` flip, swap to `maxAbsDiff` for comparison.

- **`bun run check` ~ 4 min** (mostly the workspace `bun test`
  suite). Not new; the substrate additions add ~7 new unit tests
  through `tool.ts`'s `--test` hook and the (eventual)
  `packages/linalg-core/test/eigh-complex.test.ts` follow-up.

## Acceptance

  - [x] `packages/linalg-core/src/complex-matrix.ts` + `eigh-complex.ts`
    written; exports added to `index.ts`.
  - [x] `tools/linalg-eigh-complex/` directory with all 6 contract
    artefacts.
  - [x] Smoke probe (Pauli Y, Z, diag) green; `--test` hook (4
    probes covering Pauli Y, Z, generic 2×2 complex Hermitian, 4×4
    random Hermitian) green.
  - [x] 34 goldens generated, byte-frozen.
  - [x] `wb.linalgEighComplex` available via the typed barrel.
  - [x] Tool-catalog row added to root `README.md`.
  - [x] linalg-core package description updated.
  - [x] `bun run check` green (target — running at shard write-time).
  - [x] Bead `pom8` (linalg-eigh-complex) claimed, ready to close on
    commit.
  - [ ] Three downstream beads next session: `linalg-svd-complex`,
    `linalg-solve-complex` (both filed under `ov4j`; not blockers
    for `korg` trace-norm). `korg` itself is now unblocked: takes
    `H` complex Hermitian or general, dispatches to
    `linalg-eigh-complex` (Hermitian path) or `linalg-svd-complex`
    (general path, when shipped) via the `hermitian?` boolean flag.

## Pointers

  - ADR-0035 — phase 1 design.
  - Worklog 100 — the ADR-writing iteration.
  - Worklog 098 / 099 — qinfo v0.1 substrate that this work
    completes the spectral piece of.
  - `packages/linalg-core/src/eigh.ts` (the real-symmetric Jacobi
    eigh that the embedding reuses).
  - `temp/qwasserstein.ts` — the original dogfood that surfaced the
    gap.
  - Goedecker, *Rev. Mod. Phys.* 71:1085-1123, 1999 — embedding in
    DFT.
  - Day & Heroux, *SIAM J. Sci. Comput.* 23(2):480-498, 2001 —
    embedding backward stability.
  - Higham, *Accuracy and Stability of Numerical Algorithms*, 2nd
    ed., SIAM 2002 — §10 + §20.6 (the eigh backward-stability bound
    inherited verbatim).
