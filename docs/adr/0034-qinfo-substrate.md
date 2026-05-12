# ADR-0034 — `@workbench/qinfo` quantum-information substrate

**Status:** Accepted, v0.1 shipped.
**Date:** 2026-05-12.
**Beads:** epic `hsxa`, substrate `eq4a`, tool sub-beads `qn98` (tensor-product) and `4jux` (partial-trace) close with this ADR; `yjs9` (partial-transpose) and `pk0c` (choi-iso) are filed and depend on this substrate.
**Authors:** tobiasosborne + Claude Opus 4.7 (1M context).

## Context

The `temp/qwasserstein.ts` dogfood (DMTL 2021 Wasserstein-1 distance,
2026-05-10) surfaced that the workbench has no quantum-information
substrate. Partial trace, tensor product, trace norm, trace distance,
fidelity, purity are all hand-rolled per session — 50+ LOC of
boilerplate every time someone touches a quantum-information problem.
The cas-core / groebner pattern is the reference: one cohesive substrate
package with deep export table, plus thin tool wrappers each meeting the
seven-artefact contract.

The 2026-05-10 scoping (bead `hsxa`) committed to that pattern. The
2026-05-12 implementation (this ADR) made the following decisions
beyond the original scope:

  - **Dimension model.** The original spec was 2^n-qubit-only,
    matching the dogfood prototype's `insertBit` indexing. We
    generalise to arbitrary subsystem dims `[d_0, d_1, …]`.
  - **Storage representation.** Row-major flat `Float64Array` (matches
    `solver-ipm` / `linalg-core` convention), wrapped in a single
    `Matrix` type with mandatory `re` field + optional `im` field.
  - **Complex from day 1 on index-only ops.** kron, partialTrace,
    partialTranspose, vec/unvec, choi do not need `linalg-eigh` —
    they can support complex matrices without waiting for the
    `linalg-complex-extension` epic (`ov4j`).
  - **Endianness.** Subsystem 0 is the LEFTMOST tensor factor. Matches
    the dogfood and the standard reading-order convention.

The four index-only operations (`kron`, `partialTrace`,
`partialTranspose`, `vec`/`unvec`+`choi`/`deChoi`) ship in v0.1 along
with two wire tools (`tensor-product`, `partial-trace`); the remaining
tools — `partial-transpose`, `choi-iso`, `trace-norm`, `trace-distance`,
`fidelity`, `purity` — are filed and queued.

## Decision

### D1 — One package, deep export table

`packages/qinfo` exports `Matrix`, `kron`, `kron2`, `partialTrace`,
`partialTracePure`, `partialTranspose`, `vec`, `unvec`, `choi`,
`deChoi`, plus helpers (`fromNested`, `toNested`, `transpose`,
`adjoint`, `trace`, `matmul`, `scale`, `add`, `sub`, `maxAbsDiff`,
`eye`, `zeros`, `zerosComplex`) and dim arithmetic (`dimProduct`,
`strides`, `decomposeIndex`, `composeIndex`, `normaliseSubsystems`).
Files: `matrix.ts`, `dims.ts`, `kron.ts`, `partial-trace.ts`,
`partial-transpose.ts`, `choi.ts`, `index.ts`.

The TS-expert call site reads:

```ts
import { kron, partialTrace, fromNested } from "@workbench/qinfo";
const ρ = fromNested([[0.5, 0, 0, 0.5], [0,0,0,0], [0,0,0,0], [0.5, 0, 0, 0.5]]);
const ρ_A = partialTrace(ρ, [2, 2], 1);  // = I/2
```

Each operation is a separate file so future fast-path variants (sparse,
structured, Hastings-style) can land next to their generic cousin
without restructuring imports.

### D2 — Matrix type: `{rows, cols, re, im?}`

```ts
export interface Matrix {
  readonly rows: number;
  readonly cols: number;
  readonly re: Float64Array;
  readonly im?: Float64Array;
}
```

Single type covers both real and complex. Functions branch on
`if (M.im)` exactly once at the top, then operate on Float64Arrays
in tight inner loops.

Rejected alternatives:

  - **`number[][]`** (the dogfood's choice). Ergonomic for small
    cases; cache-hostile and indirection-per-element on dense
    operators above ~5 qubits. Partial trace on a dense 8-qubit ρ
    (256 × 256) is where the difference starts to show.
  - **Discriminated union `RealMatrix | ComplexMatrix`** (Haskell-
    style). Forces every public function into overloads or pair-of-
    siblings. The TS expert reaches for `kron(A, B)` expecting it
    to Just Work; the single-Matrix-with-optional-im delivers that.
  - **Always-complex** (always allocate both `re` and `im`). Doubles
    the memory for real-only sessions and noise. Optional `im` is
    the right asymmetry — real is the common case for v0.1's
    Hermitian-restricted neighbours.

### D3 — Arbitrary subsystem dims, leftmost = subsystem 0

The dogfood prototype hardcoded `2^n × 2^n` (qubit-only). We
generalise to a `dims: number[]` parameter, with the qubit case
being the special `Array(n).fill(2)`. This unlocks qutrit Bell-
inequality work, mixed dimension product spaces (e.g. `[4, 3, 2]`
for two qudit subsystems plus a qubit), the qudit benchmarks Hastings
and others care about.

Convention: subsystem 0 is the LEFTMOST tensor factor. For
`|ψ⟩ = |q_0⟩ ⊗ |q_1⟩ ⊗ …`, q_0 lives at subsystem 0. This matches
the dogfood and the physics-textbook reading order. QuTiP uses the
opposite convention (qubit 0 = rightmost); we explicitly diverge to
match the dogfood's already-verified test suite and what reads more
naturally in TS source.

### D4 — Complex from day 1 on index-only ops

The original `eq4a` bead scoped the substrate to real-Hermitian only,
deferring complex to the `linalg-complex-extension` epic (`ov4j`).
That's correct for the eigh-routed ops (`traceNorm`, `traceDistance`,
`fidelity`) — they call `wb.linalgEigh` which is real-only — but
over-restrictive for the index-only ops.

`kron`, `partialTrace`, `partialTranspose`, `vec`/`unvec`, `choi`/
`deChoi` are pure index manipulation: they do no spectral
decomposition, no transcendental functions, no operations that
require real input. They naturally support complex matrices by
splitting into `re` and `im` parts and operating on each. The TS-
expert who wants `kron(complexA, complexB)` should get it without
waiting for `ov4j`.

The wire schema for the tool surface remains real-only at v0.1 — the
canonical complex-matrix wire shape is part of the `ov4j` epic. So
the substrate accepts complex (callable directly via `@workbench/
compose`'s in-process surface), and the wire tools accept real only
(extends additively when `ov4j` ships its complex wire shape).

### D5 — Partial trace: reshape-and-sum ships; SVD and structured deferred

Three regimes ('worklog 098 §"the not so trivial bit"'):

  - **(a) Reshape-and-sum.** O(d²) with a 1/d_k factor. Cache-friendly
    when the traced subsystem is rightmost; we walk a stride-`d_low`
    slice that packs sequentially in row-major. **Ships in v0.1.**
  - **(b) Schmidt / SVD on pure states.** `partialTracePure(psi, dims,
    traceOut)` reshapes |ψ⟩ as a d_kept × d_traced matrix and returns
    `M M†`. O(d · rank) where rank ≤ min(d_kept, d_traced). **Ships
    in v0.1** as a separate entry point — callers with a pure state in
    hand should use this rather than form |ψ⟩⟨ψ| and call the general
    path (saves a factor of d).
  - **(c) Structured fast paths.** Diagonal / low-rank / Pauli-string
    operators admit subquadratic partial trace via their structure.
    Hastings has experimented in this regime. **Deferred** — needs a
    structured-operator type infrastructure that isn't in the workbench
    yet. Filed as a future bead under the `hsxa` epic.

Multi-subsystem trace (`trace_out = [k_0, k_1, …]`) is implemented as
a fold of single-subsystem traces from highest index to lowest. The
high-to-low order keeps remaining indices in `[0, …)` stable across
steps. A fused multi-axis sum would have better constant factors for
d > 10³; ships behind the same API as a future optimisation.

### D6 — Partial transpose: pure index permutation

`partialTranspose(M, dims, transposeOn)` is a pure index permutation:

```
PT_S(M)[I, J] = M[I_S↔J_S, J_S↔I_S]
```

where for each subsystem `s ∈ S`, the row's s-th component is taken
from the column's s-th component and vice versa. No arithmetic; just
index reshuffling.

This is the most algorithmically trivial of the qinfo ops and the
most *conceptually subtle* — the partial transpose plus the Peres–
Horodecki PPT criterion is the workhorse entanglement detector. The
PPT-witness test on the Bell state (eigenvalue -1/2 after PT on one
subsystem) is the canonical worked example; we test the matrix-form
piece in the substrate (no eigh dependency) and pin the eigenvalue
check in the tool goldens (uses linalg-eigh).

### D7 — Choi isomorphism: column-stacking convention

Mathematically, the Choi-Jamiołkowski iso is

```
J(Φ) := Σ_{i,j} |i⟩⟨j|_in ⊗ Φ(|i⟩⟨j|)_out
```

When Φ is represented as a superoperator matrix S satisfying
`vec(Φ(ρ)) = S · vec(ρ)`, the index map from S to J is

```
J[i_in · d_out + i_out, j_in · d_out + j_out]
    =  S[i_out + d_out · j_out, i_in + d_in · j_in].
```

We pick **column-stacking** for `vec` — `vec(M)[i + m·j] = M[i, j]` —
matching Watrous's textbook, QuTiP, and SymPy. This is locked: mixing
conventions is the single biggest source of off-by-permutation bugs
in this corner of the literature.

### D8 — Numerical tier: bit-identical given platform

Index-only operations are bit-identical cross-platform forever in
the limited sense that the inner loops perform only float64
arithmetic on caller-supplied inputs — no transcendentals, no
spectral decompositions, no I/O. When inputs are exact integers,
outputs are exact integers (every element comes from a real
arithmetic of inputs). The tools annotate `numerical: true` for
honesty; in practice the bit-pattern across `{x86-64, arm64}` and
`{Bun on Linux, Bun on Mac, Bun on Windows-WSL}` is identical for
the canonical test fixtures we ship.

The eigh-routed ops (`traceNorm`, `traceDistance`, `fidelity`,
`purity`) inherit `numerical: true` from `linalg-eigh` — bit-
identical given the platform fingerprint.

## Consequences

### What stays

  - The seven-artefact contract for tools (ADR-0001).
  - The value-protocol wire encoding (ADR-0004).
  - Real-Hermitian-only restriction at the wire boundary (until
    `ov4j` lands).
  - The `linalg-eigh` real-only constraint that gates v0.2 tools.

### What changes

  - New package: `packages/qinfo`. Workspace dependency for any tool
    that needs quantum-info primitives.
  - New tools: `tools/tensor-product`, `tools/partial-trace` (v0.1);
    `tools/partial-transpose`, `tools/choi-iso` (filed, v0.1 follow-
    up); `tools/trace-norm`, `tools/trace-distance`, `tools/fidelity`,
    `tools/purity` (filed, v0.2).
  - Typed barrel: `wb.tensorProduct(...)`, `wb.partialTrace(...)` are
    now first-class methods on `TypedWorkbench`. Future v0.1/v0.2
    tools extend additively.

### Frictions surfaced

  - **`-0` in adjoint** (matrix.ts:174). Naïve `-M.im[k]` produces `-0`
    when `M.im[k] === 0`. `expect(...).toEqual([...])` distinguishes
    `-0` from `0`. Worked around by switching the affected test to use
    `maxAbsDiff` (which uses `Math.hypot`, treats `±0` uniformly). The
    underlying behaviour isn't wrong; the test framework just exposed
    a corner of IEEE-754 that physicists ignore. Left as-is; the
    `Matrix` is correct.

  - **TS return-type widening on `matrixToValue`.** Declaring
    `function matrixToValue(M: Matrix): Value` widened the precise
    `ListValueOf<ListValueOf<Float64Value>>` inference to `Value`,
    breaking `defineTool`'s schema-driven output narrowing. Fix:
    omit the explicit return-type annotation and let TS infer.
    Documented here so the next tool author doesn't repeat it.

  - **`scripts/gen-workbench-barrel.ts` regen-after-new-tool**. Every
    new tool requires `bun scripts/gen-workbench-barrel.ts` + commit
    the diff. The check phase enforces this. Smooth in practice but
    worth flagging.

  - **The dogfood prototype's `Matrix = number[][]`.** Lifted as a
    nested-array bridge (`fromNested` / `toNested`) for tests and the
    tool boundary. The dogfood's actual primitives (`kron`,
    `partialTrace`) port to qinfo's flat-Float64Array shape with a
    factor-of-2-to-5 perf improvement in tight loops; the
    factor-of-d advantage of `partialTracePure` over `partialTrace`
    on |ψ⟩⟨ψ| is the bigger win.

### Future work

  - **`partialTracePure` perf path.** Currently allocates the M_ψ
    matrix explicitly. Could fuse into a single sweep that emits
    `M M†` directly without materialising the rectangular
    intermediate. Saves a factor of 2 in allocation but doesn't
    change the asymptotic. Defer until benchmarks justify.

  - **Structured-operator fast paths.** Diagonal-plus-low-rank, sum-
    of-Paulis, MPO representations. Need a new substrate type. Big
    enough for its own bead under `hsxa`.

  - **Complex wire shape.** Lands with the `ov4j` epic. Tools extend
    additively (optional `_im` siblings on existing fields, OR a
    discriminated `kind: "complex-matrix"` wire shape — to be
    decided in the `ov4j` ADR).

## References

  - Bead `hsxa` (epic), `eq4a` (substrate), `qn98` (tensor-product),
    `4jux` (partial-trace), `yjs9` (partial-transpose), `pk0c` (choi-
    iso), `korg`/`k2xo`/`2hxf`/`2czd` (eigh-routed v0.2 tools).
  - `temp/qwasserstein.ts` — dogfood prototype.
  - Worklog 098 — implementation shard.
  - ADR-0014 — `linalg-core`, the storage convention precedent.
  - ADR-0030 — convex-cone solver tier (parallel "substrate + tools"
    architecture).
  - Watrous, *Theory of Quantum Information*, §2.2 — column-stacking
    vec, Choi convention.
  - Horodecki et al., *Quantum entanglement* (Rev. Mod. Phys. 81, 865)
    — PPT criterion.
