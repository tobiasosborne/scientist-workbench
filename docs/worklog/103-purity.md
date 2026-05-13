# 103 — purity: the second qinfo v0.2 tool (2026-05-13)

> **Scope.** Ship `tools/purity` — the second deliverable of the qinfo
> v0.2 surface, immediately after shard 102's `trace-norm`. Purity
> `γ(ρ) = tr(ρ²)` of a complex Hermitian density operator, computed
> via the entrywise sum-of-squares identity (no eigendecomposition).
> 34 goldens, full seven-artefact contract, demo-scope entry exercises
> the canonical "entanglement = purity-loss-under-partial-trace"
> signature end-to-end, `bun run check` clean (89 passed, 0 failed).

## Context

Shard 102 shipped `trace-norm` and named the v0.2 trio queued behind
it: `k2xo` trace-distance, `2hxf` fidelity, `2czd` purity — each "one
composition over trace-norm's substrate fixture." This session opens
the trio with the simplest of the three: purity needs no
eigendecomposition at all. For a Hermitian ρ the Hermiticity
condition `ρ_{ji} = conj(ρ_{ij})` collapses `tr(ρ²) = Σ_{i,j} ρ_{ij}
ρ_{ji}` to the entrywise sum

```
γ(ρ) = Σ_{i,j} |ρ_{ij}|² = Σ_{i,j} (re_{ij}² + im_{ij}²).
```

Two passes over `n²` floats — strictly cheaper than the trace-norm
O(n³) eigh route, and the spectral identity `Σ λ_k²` agrees with the
entrywise sum exactly for Hermitian ρ. The bead (`2czd`) flagged
"pure JS — no linalg subroutine needed" from the beginning, and that
prediction held: the tool body is a single double-loop after the
shared decode + Hermiticity-gate plumbing.

The user's framing this session ("this is a project for you: what
attracts you?") put the trio explicitly to me; I picked it from the
ready list with three justifications: (1) trace-norm just shipped and
its README named these three by `bd` ID as the workhorse downstream,
(2) each tool is a TS-expert-natural composition (the operational
test "a TS expert would type this without thinking" applies), and
(3) `purity` first because it warms up the substrate decode pattern
without inviting the matrix-square-root rabbit-hole that `fidelity`
will demand. The full reasoning is in the conversation log; the
artefacts are this shard + the seven contract files.

## What changed

### `tools/purity/` (new)

Full seven-artefact contract. The algorithm is

1. Decode the input wire shape into flat `Float64Array(n²)` for `re`
   and `im`, folding in non-finite detection (→ tagged) and a
   per-cell `|ρ_{ij}|` walk to compute `maxAbs` for the Hermiticity
   tolerance.
2. Hermiticity gate at `100·EPS·maxAbs` (the same tolerance the eigh
   substrate and trace-norm use, so the trio refuses on the same
   inputs).
3. One O(n²) pass: `value += re² + im²` (γ for Hermitian ρ) and
   `trace += re[i,i]` (tr ρ).
4. Emit `record{value, trace, is_pure_within_tolerance, method,
   warnings}`.

Wire shape:
- Input: `record{rho: record{re, im}}`. Matches the trace-norm wire
  shape (ADR-0035 §D2). The bead spec (filed 2026-05-10, pre-trace-
  norm) specified `record{rho: list<list<float64>>}` (real-only);
  this session lifts to the complex Hermitian wire shape to keep the
  v0.2 trio consistent with what trace-norm shipped. The
  TS-expert-consistency case wins: a planner reading the trio
  expects the four tools (trace-norm, trace-distance, fidelity,
  purity) to take the same matrix wire shape.
- Output: `record{value, trace, is_pure_within_tolerance, method,
  warnings}`. `value` is γ(ρ); the other fields are essentially
  free diagnostics surfaced once decode happens.

Boundary tags:
- `purity/non-hermitian-input` (γ is not a meaningful purity for
  non-Hermitian inputs)
- `purity/non-finite-input`
- `purity/degenerate-shape` (n=0)

ToolError for malformed: ρ.re / ρ.im shape mismatch, non-square,
ragged rows.

34 goldens covering: pure projectors (|0⟩⟨0|, |+⟩⟨+|, |−⟩⟨−|, the
two Pauli-Y eigenstates as complex-Hermitian probes), maximally
mixed at d ∈ {2, 3, 4}, rank-2 mixtures sweeping the [1/d, 1]
interval (diag(0.7, 0.3), diag(0.9, 0.1), diag(0.99, 0.01)), Bloch
density operators (real and complex-Y), Bell projector and Ψ−
projector, two-qubit product (|0+⟩⟨0+|), separable classical mix
(γ = 1/2), Pauli matrices as observables (γ = 2, not density —
warn), unnormalised identity (γ = d, warn), generic complex
Hermitian density operator, the zero operator (γ = 0, warn), a 5×5
real symmetric, and every boundary branch.

`--test` hook: ten invariant probes — pure-projector, max-mixed-3,
the Pauli-Y eigenstate (complex Hermitian), the spectral identity
γ = Σ λ_k² on diag(p, 1−p) for p ∈ {0.1, 0.3, 0.5, 0.7, 0.9}, and
a unitary-invariance check (rotate diag(0.7, 0.3) by 60°, check
γ unchanged). The unitary-invariance probe is the cross-check
that catches a buggy implementation that "happens to work on
diagonal ρ but breaks on rotated ρ."

### Lockstep doc updates (Law 2)

- `README.md` root: new tool-catalog row for `purity` between
  `poly-roots` and `real-root-isolate`.
- `packages/compose/src/generated/wb.ts` regenerated (49 tools now;
  `wb.purity` available via the typed barrel).
- `scripts/demo-scope.ts` gains demo #24 — entanglement as purity
  loss under partial trace. The composition `wb.partialTrace` →
  `wb.purity` reads exactly like the principle states: γ(|Φ+⟩⟨Φ+|)
  = 1, γ(tr_B |Φ+⟩⟨Φ+|) = 1/2. The drop from 1 → 1/2 is the
  Schmidt-decomposition-level signature that the original state
  was maximally entangled. State-side companion to demo #22's
  Peres–Horodecki witness.

## Why these choices

- **Why the complex Hermitian wire shape, not the bead's `record{rho:
  list<list<float64>>}`.** The bead was filed before trace-norm
  shipped. The trio's TS-expert consistency wins: trace-norm,
  trace-distance, fidelity, purity should all take ρ as
  `record{re, im}` so a caller writing the four `wb.tool({rho, …})`
  invocations doesn't context-switch between real-only and complex
  shapes. The cost is two zero-im list allocations on real inputs;
  no algorithmic cost (the sum-of-squares loop walks im whether
  it's zero or not). The bead spec is updated to v0.1 implementing
  the complex shape; the original spec stands as a useful pre-trace-
  norm artefact.

- **Why inline the math instead of adding `purity(ρ)` to
  `@workbench/qinfo`.** YAGNI. The math is one double-loop;
  trace-norm's precedent was to inline (it didn't lift `traceNorm`
  to qinfo either, just composed `eighComplex` from linalg-core at
  the tool layer). The qinfo index notes traceNorm/traceDistance/
  fidelity/purity as "deferred to v0.2"; we're shipping them at the
  tool layer first, with the option to lift to substrate once
  reuse pressure shows up. Today the only caller of "γ(ρ) = sum of
  squares" is `tools/purity` itself.

- **Why `is_pure_within_tolerance` as a named flag rather than a
  threshold on `value`.** The bead asked for it explicitly, and the
  reason is operational: a planner deciding "is ρ near a pure
  state?" wants a boolean answer at a documented tolerance, not a
  scalar they have to threshold themselves. The threshold (`1e-9`)
  is documented in the README and lives next to the field in the
  output. If a caller wants a different tolerance, they can
  re-threshold on `value` directly.

- **Why expose `trace` in the output.** Free diagnostic: the inner
  loop walks the diagonal anyway, and surfacing `tr(ρ)` lets a
  caller validate ρ is a density matrix (tr ≈ 1) without
  re-decoding the input or running a second tool. The same
  reasoning as trace-norm's `eigenvalues + condition_number`
  pass-through.

- **Why three warning branches on the success record (tr ≠ 1,
  γ > 1, γ < 1/d) rather than refuse on each.** Honest scope says
  refuse on hard violations (Hermiticity, NaN), warn on soft
  violations (almost-density-matrix). A user computing γ(A) for a
  general Hermitian observable A (e.g. a Pauli matrix) is not
  wrong — they get γ(X) = 2 with a warning that "this isn't a
  density operator." Refusing would force them to pretend the
  observable is a density matrix to use the tool, which is the
  wrong friction trade-off.

- **Why refuse non-Hermitian rather than compute γ on non-Hermitian
  input.** The formula `Σ |ρ_{ij}|²` is the *Frobenius* norm
  squared on any matrix; it equals `tr(ρ²)` only when ρ is
  Hermitian. For non-Hermitian A, `tr(A²)` can be complex (so not a
  meaningful purity), and `Σ |A_{ij}|²` is `‖A‖_F²`, not γ. A
  user who wanted `‖A‖_F²` should reach for a Frobenius-norm tool
  (filed nowhere yet); we don't conflate the two by computing the
  wrong scalar.

- **Why duplicate `findWorstHermitianViolation` and
  `decodeComplexMatrix` from trace-norm rather than lift to a
  shared helper.** Same reasoning as trace-norm shard 102 logged:
  small helpers at the tool layer keep each tool self-contained;
  re-implementing in the second tool of the trio is cheaper than
  designing the lift-point, and a third repetition (in `fidelity`)
  is the right trigger to extract — at which point the helper
  graduates to `packages/linalg-core/src/complex-matrix.ts` as
  `hermitianViolation(M, tol)` and `decodeComplexMatrix(reList,
  imList, toolName)`.

## Frictions surfaced

- **The original bead spec was pre-trace-norm.** The wire-shape
  divergence (`list<list<float64>>` vs `record{re, im}`) is a small
  example of a recurring pattern: bead descriptions filed at epic-
  open time embed schema assumptions that drift as the epic
  progresses. The right fix is implementation-time judgment with
  the rationale captured here — the principles axis is more
  load-bearing than the bead axis when they disagree. The bead
  description doesn't need editing retroactively; this worklog +
  the tool README are now the canonical spec.

- **`bun run check` first run failed on the codegen phase.** The
  typed-barrel regen (`scripts/gen-workbench-barrel.ts`) is not in
  the per-tool scaffold's "next steps" line; agents land on
  `bun tools/purity/tool.ts --version` and the codegen drift fires
  only at full-`check` time. A trivial improvement to
  `scripts/new-tool.ts`'s closing console message would surface the
  barrel-regen step explicitly. Filing as a friction; not blocking.

- **Demo-scope wall-clock to 0.98 s.** New tool adds two
  `wb.purity` calls + one `wb.partialTrace`; total demo-suite is
  still under a second. The composition `partial-trace → purity`
  exercises the right kind of TS-expert composition the
  Wasserstein-1 dogfood asked for. No friction; noting for the
  next session's "is the demo budget burning?" check.

## Acceptance

  - [x] `tools/purity/{tool,goldens.spec,README,package}.ts/md/json`
    all written.
  - [x] 34 goldens generated, byte-frozen.
  - [x] `--test` hook passes; covers 10 invariant cases including
    unitary invariance and the spectral identity.
  - [x] Demo-scope #24 (purity ∘ partial-trace) produces correct
    Bell-state values to 1e-12.
  - [x] Typed barrel regenerated (`wb.purity`, 49 tools).
  - [x] Tool-catalog row added to root `README.md`.
  - [x] `bun run check` green (89 passed, 0 failed).
  - [x] Bead `2czd` (purity tool) claimed; closes on commit.
  - [ ] `k2xo` (trace-distance) — next session; one subtraction +
    one trace-norm call + density-matrix validation envelope.
  - [ ] `2hxf` (fidelity) — third in the trio; needs a Hermitian-PSD
    matrix-square-root primitive (`Q · diag(√λ) · Q†` via complex
    eigh), composed with trace-norm. Pays forward to diamond-norm
    eventually.

## Pointers

  - Worklog 102 — `trace-norm`, the parent of this session.
  - ADR-0035 — the complex-linalg-tier ADR; §D2 wire shape.
  - ADR-0034 — qinfo substrate (parent epic).
  - Bead `2czd` (closes this session), `hsxa` (qinfo epic, parent),
    `k2xo` (trace-distance, next), `2hxf` (fidelity, next next).
  - Nielsen & Chuang, §2.4.3 + §8.4 — density operators and the
    linear-entropy variant `1 − γ`.
  - Bengtsson & Życzkowski §2.3, §15.6 — purity vs entropy and the
    state-space simplex bounds.
  - Watrous §1.1 + §5.2 — density operators and Renyi-2 entropy
    (`S_2(ρ) = −log γ(ρ)`, of which this tool computes the kernel).
