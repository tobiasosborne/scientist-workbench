# 105 — fidelity: the qinfo v0.2 trio complete (2026-05-13)

> **Scope.** Ship `tools/fidelity` — fourth and final deliverable of
> the qinfo v0.2 surface, completing the trio with `trace-distance`
> and `purity`. Uhlmann fidelity `F(ρ, σ) = (tr √(√ρ · σ · √ρ))²` of
> two complex Hermitian density operators, computed via the spectral
> path (three `eighComplex` calls + two complex matmuls). 28 goldens,
> full seven-artefact contract, demo-scope #26 exercises the
> **Fuchs–van de Graaf inequality** `1 − √F ≤ D ≤ √(1 − F)`
> numerically — a probe that exists because both `D` and `F`
> finally ship in the same session. `bun run check` clean (93
> passed, 0 failed).

## Context

The qinfo v0.2 quartet originally filed in 2026-05-10 (beads `korg`
trace-norm, `2czd` purity, `k2xo` trace-distance, `2hxf` fidelity)
took five sessions to complete:
- Worklog 098 (2026-05-12) — qinfo substrate + tensor-product +
  partial-trace tools.
- Worklog 099 (2026-05-12) — qinfo v0.1 close (choi-iso +
  partial-transpose).
- Worklog 100 (2026-05-13) — ADR-0035 (the complex-linalg-tier
  design that unblocked v0.2).
- Worklog 101 (2026-05-13) — `linalg-eigh-complex` (phase 1 of
  ADR-0035; the substrate the trio composes against).
- Worklog 102 (2026-05-13) — `trace-norm` (first v0.2 tool; the
  spectral characterisation).
- Worklog 103 (2026-05-13) — `purity` (second; the no-eigh
  one-pass entrywise formula).
- Worklog 104 (2026-05-13) — `trace-distance` (third; spectral
  on the Hermitian difference).
- **Worklog 105 (this session)** — `fidelity`; quartet complete.

The arc opened with a paired-tool plan ("the dogfood gap names
this") and closed with a Fuchs–van de Graaf inequality demo that
prints all four state-distance quantities side-by-side. The
session-level frame the user named at the top of this thread
("this is a project for you: what attracts you?") settled on the
trio as a coherent piece carrying trace-norm's momentum;
trace-distance and fidelity then ship in this session as a pair
because the algorithm-and-substrate cost rhymes, and the demo only
makes sense with both.

## What changed

### `tools/fidelity/` (new)

Full seven-artefact contract. The algorithm is the **spectral path**
through Uhlmann's formula:

```
F(ρ, σ) = (tr √(√ρ · σ · √ρ))²
        = (Σ_k √μ_k)²            where μ_k = eigenvalues(√ρ · σ · √ρ)
```

Implementation in five steps:

1. Decode ρ, σ (same plumbing as trace-distance — fourth copy of
   the decoder; lift to shared substrate filed as follow-up).
2. **Hermitian-PSD matrix square root via spectral path.** Run
   `eighComplex(ρ)` ⇒ `ρ = Q · diag(λ) · Q†`; build `√ρ = Q ·
   diag(√max(λ, 0)) · Q†` by hand-rolled complex matmul with the
   diagonal middle factor inlined as a column scale.
3. **Inner matrix.** `M = √ρ · σ · √ρ` via two `complexMatmul`
   calls. Hermitian PSD when both inputs are PSD; the sandwich
   preserves Hermiticity even when σ is only Hermitian.
4. **Trace of square root.** `eighComplex(M)` ⇒ μ. Sum
   `√max(μ_k, 0)`. PSD-clamp warns on hard negatives.
5. **Square.** `F = (Σ √μ_+)²`.

Output exposes three byproducts of the inner computation:
- `value` — F itself.
- `sqrt_value` — `√F`. One extra `Math.sqrt` after F; useful as
  the Bhattacharyya overlap and as the FvG-inequality input.
  Every downstream consumer of fidelity also wants `√F`.
- `bures_angle` — `arccos(min(1, √F))`. The Riemannian geodesic
  distance under the Bures metric, in radians ∈ [0, π/2]. The
  `min(1, …)` guards against `√F = 1 + 1e-16` producing `NaN`.

Boundary tags (same set as trace-distance):
- `fidelity/non-hermitian-input` (with `which`)
- `fidelity/non-finite-input` (with `which`)
- `fidelity/shape-mismatch`
- `fidelity/degenerate-shape` (with `which`)

PSD violations are **soft warnings, not refusals**. Trace-distance
warns on `tr ≠ 1`; fidelity additionally warns on negative
eigenvalues of either ρ or `√ρσ√ρ` beyond `1e-9 · max|λ|`. The
agent-honest choice: compute on near-PSD inputs (clamping negative
eigenspaces to 0) rather than refuse, with the warning carrying
the smallest negative eigenvalue.

28 goldens covering: identical states at multiple shapes (F = 1
including identical Bell states); orthogonal pure states (F = 0)
in computational, X-eigenbasis, and complex Y-eigenbasis;
pure-pure overlap at fixed angles (`F = 1/2` at 45°); pure-vs-max-
mixed at d ∈ {2, 3, 4} (F = 1/d); flipped classical bits (closed-
form via `(√pq + √(1-p)(1-q))²`); Bloch X-Z plane pairs; complex
Bloch with Y-sign-flip (the dogfood); orthogonal Bell projectors;
symmetry probe; classical-vs-pure (`F = p`); and every boundary
branch.

`--test` hook with **9 invariant probes** including identity at
two shapes, orthogonal-pures, pure-vs-max-mixed at d ∈ {2, 3},
pure-pure-overlap in both X and Y eigenbasis (complex-Hermitian
path), symmetry, and **three Fuchs–van de Graaf probes** that
check `1 − √F ≤ D ≤ √(1 − F)` on independent state pairs.

### `packages/linalg-core` — no new exports

The Hermitian-PSD matrix square root is implemented inline in
`tools/fidelity/tool.ts` rather than lifted to `linalg-core` as a
new `hermitianPSDSqrt(M)` export. The reason is twofold:

1. **YAGNI scope.** v0.1 has one caller; the sqrt is ~30 lines of
   spectral construction. Until a second tool needs it, the lift
   is design speculation.

2. **The decoder lift is the priority.** Three of the four qinfo
   v0.2 tools (purity, trace-distance, fidelity) now carry
   inline copies of `decodeComplexMatrix` and
   `findWorstHermitianViolation`. The fourth-copy threshold is
   crossed; the lift to a shared `packages/contract/src/wire-
   decode.ts` (or similar) is filed as a follow-up bead. With
   four data points the right shape is finally clear — both
   helpers parameterised on `{toolName, inputName}` for tag
   construction.

### Lockstep doc updates (Law 2)

- `README.md` root: tool-catalog row for `fidelity` between
  `expr-parse` and the next entry alphabetically.
- `packages/compose/src/generated/wb.ts` regenerated (51 tools;
  `wb.fidelity` available via the typed barrel).
- `scripts/demo-scope.ts` gains demo #26: **Fuchs–van de Graaf
  inequality**, numerical. Two probes (pure-vs-max-mixed showing
  loose bounds; a generic mixed pair showing the upper bound
  nearly tight) print all four quantities side-by-side. Probe
  output:
  ```
  Probe 1: D = 0.5000, F = 0.5000, √F = 0.7071
           Fuchs–vdG: 0.2929 ≤ D = 0.5000 ≤ 0.7071
  Probe 2: D = 0.3162, F = 0.8995, √F = 0.9484
           Fuchs–vdG: 0.0516 ≤ D = 0.3162 ≤ 0.3169
  ```
  Probe 2 demonstrates the upper bound's near-tightness (D and
  √(1−F) agree to three decimals).

## Why these choices

- **Why the spectral path, not Newton iteration.** Newton for the
  matrix square root converges quadratically but requires a
  linear-system solve at each step (and a tolerance to terminate).
  The spectral path is one `eighComplex` per matrix and is exact
  up to the eigh's own accuracy — no iteration tolerance to tune.
  At v0.1's typical small-n regime spectral dominates; iterative
  becomes attractive only at `n ≳ 10³` where eigh's `O(n³)`
  starts to feel. The future bead is "iterative-fidelity for
  large n" if the workload appears.

- **Why surface `√F` and `bures_angle` from the success record.**
  Both are essentially free: `√F` is `Math.sqrt(value)` after we
  compute `value`; `bures_angle` is `Math.acos(min(1, √F))`.
  Every downstream consumer of fidelity wants `√F` — the
  Bhattacharyya overlap, the Fuchs–van de Graaf inequalities, the
  process-fidelity definition. Computing `√F` client-side from
  `value` is one Math.sqrt anyway, so the field is documentary
  rather than load-bearing — but documentary fields read better
  in the wire when an agent dumps the output. Bures angle reads
  best as the geodesic distance interpretation, and downstream
  variational-fidelity loss functions optimise it directly.

- **Why warn-don't-refuse on PSD violation.** A planner computing
  `F(ρ, σ)` where ρ comes from a noisy channel may see eigenvalues
  like `[1 - ε, ε, -1e-16]` — Hermitian and trace-1 but with a
  tiny negative eigenvalue from numerical drift. Refusing this
  would be honest but useless: the answer to "what's the fidelity
  with σ?" *is* defined, just by the clamping convention. The
  warning carries `mostNeg / max|λ|` so a careful caller can
  decide to re-validate or refuse on its own. The same discipline
  as trace-distance's `tr ≠ 1` warning.

- **Why the same wire shape as trace-distance.** TS-expert
  consistency: the qinfo v0.2 quartet (`trace-norm`,
  `trace-distance`, `purity`, `fidelity`) now all take the same
  matrix-on-the-wire shape `record{re, im}`. A planner writing
  `wb.fidelity({rho: <density>, sigma: <density>})` immediately
  after `wb.traceDistance({...})` doesn't context-switch wire
  shapes. The bead spec called for real-only `list<list<float64>>`;
  same lift-to-complex reasoning as worklogs 103 + 104.

- **Why three eigh calls instead of one.** The naive count is
  three: `eighComplex(ρ)` for `√ρ`, the two matmuls don't need
  eigh, `eighComplex(M)` for the inner-trace. There's no
  obvious reduction; both spectral decompositions are doing real
  work (the first to build `√ρ`, the second to compute the trace
  of √M). Modern symbolic-numeric libraries don't shortcut this
  any further unless they know specific structure (e.g. ρ
  diagonal commutes with σ — the classical case, where F has a
  closed form `(Σ √(p_i q_i))²` that needs zero eigh).

## Frictions surfaced

- **Decoder/Hermitian-check helpers now quadruplicated.**
  `decodeComplexMatrix` and `findWorstHermitianViolation` exist
  inline in four tool files (trace-norm, purity, trace-distance,
  fidelity). The lift trigger was crossed at the third copy
  (shard 102 said so); by the fourth the right shape is finally
  clear. Filing a follow-up bead for the lift: target
  `packages/contract/src/wire-decode.ts` with
  `decodeComplexMatrix(reList, imList, opts: {toolName,
  inputName, isOptional?})` and
  `findWorstHermitianViolation(re, im, n, tol, opts: {toolName,
  inputName})` returning the canonical `tagged` payload. Refactor
  to all four tools is a one-commit change once shipped.

- **Bures angle clamping at `min(1, √F)`.** Floating-point
  `√F = 1 + 1e-16` is observable (the goldens for identical states
  show 1 ulp drift). Without the clamp, `Math.acos(1 + 1e-16) =
  NaN`. The clamp is `min(1, ·)` rather than `min(1, max(0, ·))`
  because we already filtered negative `μ`; `sumSqrt ≥ 0` by
  construction. Recording this as a friction so the lift-helper
  doesn't accidentally drop the guard.

- **Worklog 104's "decoder lift filed for after fidelity" played
  out exactly.** Shipping the trio in three sessions with the
  decoder triplicated/quadruplicated was the right call — the
  asymmetric (rho-vs-sigma) decoder design needed the fourth
  data point to converge. The cost (four near-identical
  decoders) is bounded; the benefit (each tool reads start-to-
  finish without cross-file jumps) was real during development.

- **Demo-scope at 1.00 s total.** Three new demos (#24 purity,
  #25 trace-distance, #26 fidelity) added in three sessions; the
  full suite stays under a second because everything composes
  through `eighComplex` which is the actual cost. No friction.

## Acceptance

  - [x] `tools/fidelity/{tool,goldens.spec,README,package}.ts/md/json`
    all written.
  - [x] 28 goldens generated, byte-frozen.
  - [x] `--test` hook passes; covers 9 invariant probes including
    three Fuchs–van de Graaf probes that check `1 − √F ≤ D ≤
    √(1 − F)`.
  - [x] Demo-scope #26 (Fuchs–van de Graaf inequality) produces
    correct values; probe 2 demonstrates the upper bound's near-
    tightness (`D = 0.3162 ≤ √(1−F) = 0.3169`).
  - [x] Typed barrel regenerated (`wb.fidelity`, 51 tools).
  - [x] Tool-catalog row added to root `README.md`.
  - [x] `bun run check` green (93 passed, 0 failed).
  - [x] Bead `2hxf` claimed; closes on commit.
  - [x] **The qinfo v0.2 trio is complete.** Beads `2czd`, `k2xo`,
    `2hxf` all closed in worklogs 103, 104, 105 across the same
    afternoon session.

## What's next

The natural follow-ups, ranked by readiness:

1. **Decoder lift** — `decodeComplexMatrix` + `findWorstHermitian
   Violation` to a shared substrate. One refactor pass, four
   touchpoints; trivial diff.

2. **Diamond norm** — channel distinguishability via SDP. Uses
   `choi-iso`, `partial-trace`, and the qinfo v0.2 `trace-norm`/
   `trace-distance` toolkit; the SDP layer is the cone-solver
   tier that's mid-flight under `qmrv` / HSDE Phase 5. Bead not
   yet filed.

3. **`linalg-svd-complex`** (ADR-0035 phase 2, bead `ov4j`) —
   unblocks the general (non-Hermitian) trace-norm lane and
   matrix-square-root for non-Hermitian inputs. Would also let
   `fidelity` extend to non-PSD Hermitian (the warn case
   becomes a refuse-or-route-to-SVD decision).

## Pointers

  - Worklog 103 — `purity`, the no-eigh sibling.
  - Worklog 104 — `trace-distance`, the spectral sibling.
  - ADR-0035 — complex-linalg-tier ADR.
  - Bead `2hxf` (closes this session); `hsxa` (qinfo epic, fourth
    of four v0.2 tools shipped).
  - Uhlmann, *Rep. Math. Phys.* 9(2) 1976 — the original
    transition-probability definition.
  - Jozsa, *J. Mod. Opt.* 41 1994 — modern fidelity for density
    operators.
  - Fuchs & van de Graaf, *IEEE Trans. Inf. Theory* 45(4) 1999 —
    the D ↔ F inequalities exercised in demo #26.
  - Nielsen & Chuang, *Quantum Computation and Quantum
    Information*, §9.2 — fidelity, trace distance, the Fuchs–vdG
    bounds.
  - Watrous, *Theory of Quantum Information*, Cambridge 2018,
    §3.2 — Uhlmann's theorem (symmetry); fidelity-vs-trace-
    distance relationships.
  - Bhatia, §IV.2 — Schatten norms; the spectral characterisation
    `tr √M = Σ √μ_k` for Hermitian PSD `M`, the kernel of step 4.
