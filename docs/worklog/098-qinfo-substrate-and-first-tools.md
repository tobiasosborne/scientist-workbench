# 098 — `@workbench/qinfo` substrate + tensor-product + partial-trace (2026-05-12)

> **Scope.** Open the qinfo epic (`hsxa`, filed 2026-05-10 from the
> Wasserstein-1 dogfood). Build the substrate package, ship the two
> most-used wire tools (tensor-product + partial-trace), file 2 new
> tool sub-beads (partial-transpose, choi-iso) that the original
> scoping missed. Three principle-led re-scopings beyond the existing
> `eq4a` plan: dims-generalised (not 2^n-only); flat Float64Array
> storage with optional `im` (not nested `number[][]`); complex-from-
> day-1 on the index-only ops (not strictly real-Hermitian-only).

## Context

`temp/qwasserstein.ts` (DMTL21 dogfood, 2026-05-10) surfaced that the
workbench has no quantum-information primitives. Partial trace, kron,
trace norm — all hand-rolled 50+ LOC per session. The
2026-05-10 scoping filed an epic (`hsxa`) + substrate (`eq4a`) + six
tool sub-beads (`qn98` tensor-product, `4jux` partial-trace, `korg`
trace-norm, `k2xo` trace-distance, `2hxf` fidelity, `2czd` purity).
Pattern: cas-core ↔ cas-* tools.

The user prompt this session ("Off you go. What would a TypeScript
expert engineer want, desire?") pinned the design rule. Three things
the existing `eq4a` scope under-specified:

  1. **Dims model.** `eq4a` described the API as qubit-only (the
     dogfood's shape). A TS expert reaches for
     `partialTrace(ρ, [4, 3], 1)` before specialising to qubits.
  2. **Storage representation.** `eq4a` punted; the dogfood used
     `number[][]`. The TS-expert-in-this-codebase convention
     (`solver-ipm`, `linalg-core`) is flat row-major Float64Array.
  3. **Real-only restriction.** `eq4a` applied the linalg-eigh-
     inherited real-only constraint across all primitives. But the
     index-only ops (kron, partialTrace, partialTranspose, vec,
     choi) don't depend on eigh — they're pure index manipulation.
     A TS expert wanting `kron(complexA, complexB)` should get it
     without waiting for the `ov4j` complex-Hermitian epic.

Also missing from the original scope: **partial transpose** (PPT
entanglement criterion is the workhorse test for entanglement) and
**Choi isomorphism** (channels ↔ matrices on the doubled space, the
gateway to talking about CPTP maps, channel capacities, etc.). Filed
as `yjs9` and `pk0c`.

## What changed

### Substrate (`packages/qinfo`)

```
packages/qinfo/
  package.json
  src/
    matrix.ts            — Matrix type {rows, cols, re, im?} + helpers
                           (eye, zeros, fromNested, toNested, transpose,
                            adjoint, trace, matmul, scale, add, sub,
                            maxAbsDiff).
    dims.ts              — Dims arithmetic (dimProduct, strides,
                            decomposeIndex, composeIndex,
                            normaliseSubsystems).
    kron.ts              — kron2(A, B), variadic kron(...args).
    partial-trace.ts     — partialTrace(M, dims, traceOut) +
                            partialTracePure(psi, im?, dims, traceOut)
                            for the pure-state SVD path.
    partial-transpose.ts — partialTranspose(M, dims, transposeOn).
    choi.ts              — vec / unvec / choi / deChoi
                            (column-stacking convention).
    index.ts             — public exports.
  test/
    matrix.test.ts       — fromNested round-trip, eye, transpose,
                            adjoint, matmul-by-hand-and-identity,
                            add/sub/scale.
    kron.test.ts         — shape, identity composition, |i⟩⟨i|⊗|j⟩⟨j|
                            sparsity, MIXED-PRODUCT (A⊗B)(C⊗D) =
                            (AC)⊗(BD), trace identity tr(A⊗B) =
                            tr(A)·tr(B), associativity, complex case.
    partial-trace.test.ts— shape, PRODUCT-STATE Tr_1(A⊗B) =
                            tr(B)·A, trace preservation, Bell ρ_A =
                            I/2, linearity, multi-system trace,
                            complex case, partialTracePure agrees
                            with general path on |ψ⟩⟨ψ|.
    partial-transpose.test.ts — involution PT(PT(M))=M, full-system
                            PT = transpose, PT factors through ⊗,
                            BELL PPT EIGENVALUE -1/2 (verified via
                            matmul, not eigh).
    choi.test.ts         — vec/unvec round-trip, COLUMN-STACKING
                            convention check, vec(AXB^T)=(B⊗A)·vec(X)
                            identity, J(id) = |Ω⟩⟨Ω| for d=2 AND
                            d=3, choi/deChoi round-trip on real and
                            complex AND rectangular (d_in ≠ d_out).
```

56 tests, 87 expect() calls, all pass. Every test asserts a
mathematical invariant per Rule 7 — no "didn't throw" tests.

### Tools

**`tools/tensor-product`** — wraps `qinfo.kron2`. Real-only wire
schema for v0.1 (complex wire blocked on `ov4j`). 11 goldens covering
identity composition, Pauli pairs, rectangular shapes, 1×1 scalar
edges, asymmetric outer products, negative entries.

**`tools/partial-trace`** — wraps `qinfo.partialTrace`. Dims-
generalised at the wire (`dims: list<integer>`, `trace_out:
list<integer>`). 12 goldens covering product-state defining property,
Bell I/2 reduction on both sides, singlet reduction, qutrit ⊗ qubit,
3-qubit maximally-mixed with multi-subsystem trace, full trace,
vacuous trace.

Both tools meet the seven-artefact contract: package.json, tool.ts,
README.md, goldens.spec.ts, goldens/. Both have `--test` hooks
exercising the substrate paths byte-identically to what the goldens
pin.

**Typed barrel auto-extended.** `wb.tensorProduct(...)` and
`wb.partialTrace(...)` are now first-class TypedWorkbench methods.
The TS-expert call site:

```ts
const wb = typed(await loadWorkbench());
const ρ_A = await wb.partialTrace({
  M: bellMatrix,
  dims: [2, 2],
  trace_out: [1],
});
// ρ_A.reduced === [[0.5, 0], [0, 0.5]]
```

is irresistibly composable in the workbench-native way.

### Beads

  - Closed: `qn98` (tensor-product), `4jux` (partial-trace).
  - Filed: `yjs9` (partial-transpose), `pk0c` (choi-iso). Each depends
    on `eq4a` and meets the same wire conventions.
  - Updated: `eq4a` description rewritten with the three re-scoping
    decisions (dims-generalised, flat Float64Array storage, complex-
    on-index-only-ops).
  - Still queued: `korg` (trace-norm), `k2xo` (trace-distance), `2hxf`
    (fidelity) — eigh-routed, blocked on `ov4j` complex-Hermitian.
    `2czd` (purity) is unblocked — purity is `tr(ρ²)` which doesn't
    need eigh; could ship in v0.1.5 if a TS expert reaches for it.

### Docs

  - **ADR-0034.** `@workbench/qinfo` substrate. 8 design decisions
    (D1–D8) covering package shape, Matrix type, dim model,
    complex-on-index-only-ops, partial-trace algorithm choice,
    partial-transpose, Choi convention, numerical tier.
  - **This worklog shard.**
  - Tool READMEs (tensor-product, partial-trace) — agent-facing
    summaries with invariants, refusal classes, worked examples.

## Why these choices

### Why one package, not one-per-operation

Substrate operations on a shared Matrix type share constants
(endianness, storage layout), helpers (dim arithmetic), and the
import surface a TS expert reaches for. Splitting kron/partial-trace/
choi across separate packages would mean three imports for the
common idiom "construct ⊗, partial-trace, then format" — and each
import would re-export Matrix/Dims, multiplying the type-identity
hazards. cas-core / linalg-core / solver-ipm all chose monolithic
substrates with deep export tables; qinfo follows.

### Why flat Float64Array, not number[][]

`temp/qwasserstein.ts` uses `number[][]`. Two principles test:
"what would a TypeScript expert want?" — the answer in *this
codebase* is "what solver-ipm / linalg-core use", which is flat
row-major Float64Array. The nested-array approach is ergonomic for
2 × 2 toys but cache-hostile and one-indirection-per-element on the
dense partial-trace inner loop, which is the partial-trace hot path
at >5 qubits. `fromNested` / `toNested` bridge the boundary for
tests and tool wire encoding; the hot path uses the flat shape.

### Why complex from day 1 on the index-only ops

The `eq4a` bead inherited the real-only restriction from
`linalg-eigh` blanket-style. But:

  - `kron`, `partialTrace`, `partialTranspose`, `vec`, `choi` don't
    call eigh. They're pure index manipulation.
  - The complex case is a single branch at the top of each function
    (real vs complex path) plus the additional `im` Float64Array.
  - A TS expert who needs `kron(complexPauliX, complexPauliY)`
    should be able to call it. Forcing them through
    `embedRealSymplectic` first is exactly the "boilerplate per
    session" friction the substrate exists to eliminate.

The wire schema for the tools stays real-only at v0.1 — the
canonical complex-matrix wire shape is part of the `ov4j` epic and
arrives there. The substrate ships ahead because the in-process
call site (via `@workbench/compose`'s typed barrel) doesn't go
through the wire encoder.

### Why partialTracePure ships alongside partialTrace

The general path on |ψ⟩⟨ψ| is O(d²); the SVD/Schmidt path on |ψ⟩
directly is O(d · rank). For a 20-qubit pure state (d = 2²⁰ ≈ 10⁶),
that's the difference between feasible and not — 10⁹ ops vs 10¹².
A TS expert with a state vector in hand should call
`partialTracePure(psi, ...)` and get the asymptotic improvement;
forcing them to form |ψ⟩⟨ψ| first wastes a factor of d. Separate
entry point so the choice is explicit at the call site.

### Why partial-transpose is a v0.1 ship and not a follow-up

The original `eq4a` scope omitted partial transpose entirely. But:

  - It's the simplest of the index-only ops (literal index
    permutation; no arithmetic).
  - PPT-criterion entanglement detection is the workhorse test
    that gets reached for constantly in QI numerics.
  - Including it now means the v0.1 substrate covers the four
    operations that compose: ⊗ (build), Tr (reduce), PT (probe),
    Choi (transform). The TS expert who imports `qinfo` for one
    of these often needs another in the same session.

Bead `yjs9` is for the *tool wire wrapper* (which adds JSON schema,
goldens, the wire-protocol round-trip); the substrate function
`qinfo.partialTranspose` ships today.

### Why column-stacking for vec / Choi

Mixing column-stacking and row-stacking is the #1 source of bugs in
this corner of the literature. We picked column-stacking because:

  - Watrous (the field's standard textbook) uses it.
  - QuTiP defaults to it.
  - SymPy defaults to it.
  - The vec identity `vec(AXB^T) = (B ⊗ A) · vec(X)` reads cleanly.

Locked. If a downstream tool needs row-stacking it constructs the
permutation explicitly; we do not provide a "convention switch".

## Frictions surfaced

  1. **`-0` vs `0` in adjoint tests.** Naïve `-M.im[k]` produces
     IEEE -0 when `M.im[k] === 0`. `toEqual([0, 1], [-1, 0])` fails
     against `[0, 1], [-1, -0]`. Workaround: switched the test to use
     `maxAbsDiff` (which uses Math.hypot, signs irrelevant). The
     adjoint output is mathematically correct; only the test
     framework cares about ±0.

  2. **TS return-type widening.** A helper `function matrixToValue(M:
     Matrix): Value { return list(...) }` widens the precise
     `ListValueOf<ListValueOf<Float64Value>>` (which `list(...)`
     infers) to the unspecific `Value`. The `defineTool` schema-
     driven output-narrowing then can't match the `output` slot.
     Fix: omit the explicit return-type annotation, let TS infer.
     Documented in ADR-0034 D2 so the next tool author doesn't
     repeat it.

  3. **`scripts/gen-workbench-barrel.ts` regen-after-new-tool**.
     Every new tool requires regenerating
     `packages/compose/src/generated/wb.ts` and committing the diff.
     `bun run check` enforces this — clean, but a step easy to
     forget mid-PR. Adding `bun scripts/gen-workbench-barrel.ts`
     to the new-tool checklist in CLAUDE.md would close the gap;
     left for a follow-up cleanup bead.

  4. **Hastings-style fast paths defer.** The user mentioned Matt
     Hastings has experimented with non-trivial partial-trace
     algorithms — diagonal-plus-low-rank, sum-of-Paulis,
     MPO/tensor-network representations admit subquadratic-in-d
     partial trace. We ship the dense O(d²) reshape-and-sum and
     the pure-state O(d·rank) SVD path; the structured fast paths
     need a structured-operator type infrastructure that doesn't
     exist yet. Filed as a future bead under `hsxa` so the v0.3
     epic doesn't lose track of the user's specific intent.

  5. **Wire complex deferred.** The substrate handles complex on
     index-only ops, but the wire schema stays real-only. The
     reason: defining the canonical complex-matrix wire shape is
     part of `ov4j`'s scope (`linalg-{eigh,svd,solve}` complex
     extension). Shipping a complex wire shape *here* before
     `ov4j` decides on its conventions would risk wire-protocol
     fragmentation. The substrate-vs-wire boundary lets us ship
     in-process complex now without prejudicing the wire decision.

## Acceptance

  - `bun test packages/qinfo/`: 56 pass / 0 fail / 87 expect() calls.
  - `bun tools/tensor-product/tool.ts --test`: passes.
  - `bun tools/partial-trace/tool.ts --test`: passes.
  - `bun scripts/generate-goldens.ts --check`: 11 tensor-product + 12
    partial-trace goldens round-trip byte-identical.
  - `bun run check`: 78 passed / 7 skipped / 1 failed. The 1 fail is
    the pre-existing `bun test (workspace property tests)` corpus-
    path mismatch (commit `6772307`, `/home/tobias` vs
    `/home/tobiasosborne` — not touched by this work).
  - Typed barrel: `wb.tensorProduct(...)` and `wb.partialTrace(...)`
    are first-class methods on `TypedWorkbench`.
  - Beads closed: `qn98`, `4jux`.
  - Beads filed: `yjs9` (partial-transpose), `pk0c` (choi-iso) —
    both depend on `eq4a` which closes too.
  - ADR-0034 lands.

## Pointers

  - **Substrate code:** `packages/qinfo/src/{matrix,dims,kron,
    partial-trace,partial-transpose,choi,index}.ts`.
  - **Substrate tests:** `packages/qinfo/test/*.test.ts` (5 files,
    56 tests).
  - **Tools:** `tools/tensor-product/`, `tools/partial-trace/`.
  - **Typed barrel:** `packages/compose/src/generated/wb.ts` regen'd
    (44 tools, +2 vs prior).
  - **ADR:** `docs/adr/0034-qinfo-substrate.md`.
  - **Beads:** `hsxa` (epic, still open — queued v0.2 tools);
    `eq4a` (closes with this shard); `qn98` (closes); `4jux`
    (closes); `yjs9` (filed); `pk0c` (filed); `korg`/`k2xo`/`2hxf`
    (queued, blocked on `ov4j`); `2czd` (queued, unblocked but
    deferred).
  - **Dogfood reference:** `temp/qwasserstein.ts` — the source of
    the gap that motivated the epic.
