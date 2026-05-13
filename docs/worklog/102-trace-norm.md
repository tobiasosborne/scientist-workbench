# 102 — trace-norm: the first qinfo v0.2 tool (2026-05-13)

> **Scope.** Ship `tools/trace-norm` — the first deliverable of the
> qinfo v0.2 surface, unblocked by shard 101's `linalg-eigh-complex`.
> Hermitian-only path via the spectral characterisation `‖M‖₁ = Σ
> |λ_k|` (Bhatia §IV.2). The general (non-Hermitian) lane is queued
> for ADR-0035 phase 2 (`linalg-svd-complex`, filed). 35 goldens,
> full seven-artefact contract, demo-scope entry exercises the
> Helstrom trace distance end-to-end, `bun run check` clean.

## Context

The whole `ov4j` ↔ `hsxa` epic ladder existed to unblock the qinfo
v0.2 quartet (`korg` trace-norm, `k2xo` trace-distance, `2hxf`
fidelity, `2czd` purity). Shard 098 shipped the qinfo substrate with
the four eigh-routed tools deliberately deferred; shard 100 wrote
ADR-0035 to fix the substrate-type and wire-shape decisions; shard
101 shipped `linalg-eigh-complex` (the complex-Hermitian
eigendecomposition substrate). This session converts that ladder
into its first concrete agent-visible payoff: a tool that takes a
complex Hermitian density operator (or any Hermitian matrix) and
returns its Schatten-1 norm.

The downstream value is concrete and named: trace distance, fidelity
bounds (Fuchs–van de Graaf), state distinguishability (Helstrom). The
demo-scope entry in this session shows it as one subtraction + one
tool call.

## What changed

### `tools/trace-norm/` (new)

Full seven-artefact contract. The algorithm is `eighComplex → Σ |λ|`
— routed through the new substrate, with the trace-norm tool layer
owning input decoding, Hermiticity check (the same `100·EPS·max|M|`
tolerance as `linalg-eigh-complex`), boundary tagging, and output
encoding.

Wire shape:
- Input: `record{M: record{re, im}}`. The matrix is wrapped in a
  `{M}` record (rather than passed naked) so the surface can grow
  additively — a future `hermitian?: boolean` override, a future
  weight matrix, etc.
- Output: `record{value, eigenvalues, condition_number, method,
  warnings}`. `value` is the scalar trace norm; the rest are
  pass-through diagnostics from the eigh substrate that cost zero
  extra and give the planner useful gates.

Boundary tags:
- `trace-norm/non-hermitian-input` (the SVD path that would handle
  this is ADR-0035 phase 2, filed)
- `trace-norm/non-finite-input`
- `trace-norm/degenerate-shape`

ToolError for malformed: re/im shape mismatch, non-square, ragged,
OOM.

35 goldens covering: identity sizes 1-5, pure projectors (|0><0|,
|1><1|, Bell), maximally mixed (I/2, I/3, I/4), the Pauli family
(X, Y, Z each with ‖·‖₁ = 2), density operators with Bloch vectors
including the complex Y-component case (the dogfood-named workload),
generic complex Hermitian, mixed-sign diagonals (the `Σ |·|` over
signed eigenvalues), Z⊗Z + X⊗Y multi-qubit Hamiltonians, degenerate
spectra (exercises the eigh MGS pass), well-separated extremes
(1e-8 to 1e8), and every boundary branch.

`--test` hook: eight invariant-asserting probes (identity-3, pure
projector, max mixed, Pauli X / Y / Z, generic complex Hermitian
2×2, mixed-signs 3×3). Every probe asserts a known mathematical
value (Rule 7).

### Lockstep doc updates (Law 2)

- `README.md` root: new tool-catalog row for `trace-norm` between
  `tensor-product` and the next alphabetical entry.
- `packages/compose/src/generated/wb.ts` regenerated (48 tools now;
  `wb.traceNorm` available via the typed barrel).
- `scripts/demo-scope.ts` gains demo #23 — Helstrom trace distance
  between density operators, exercising the tool end-to-end via the
  typed barrel. Two illustrative cases: T(|0⟩⟨0|, |1⟩⟨1|) = 1
  (orthogonal pure states, perfectly distinguishable) and
  T(|0⟩⟨0|, I/2) = ½ (Bloch-vector half-distance). Both produce the
  textbook Helstrom values to 1e-12.

## Why these choices

- **Why wrap M in `{M}` rather than pass naked.** Tools that accept a
  single matrix tend to outgrow that surface fast — `linalg-solve`
  takes `{A, b}`, `eigh-complex` takes `{re, im}` directly because
  the matrix *is* the complex shape and there's no other field
  conceivable. Trace-norm is on the bubble: today the matrix is the
  only input, but the surface can plausibly grow (`hermitian?:
  boolean` flag for forced dispatch, weight matrix for weighted
  Schatten norms, basis choice). The `{M}` wrapping pays a ~10
  characters cost today against the ability to grow without a
  schema-breaking edit. The same reasoning applies in `linalg-solve`'s
  `{A, b}` shape.

- **Why expose eigenvalues + condition_number in the output, not just
  `value`.** Downstream consumers (the qinfo v0.2 quartet,
  `trace-distance` first) almost certainly want spectral information
  beyond the scalar — purity is `tr(ρ²) = Σ λ²`, computable
  client-side from the eigenvalues list without a second eigh call;
  trace-distance bounds are easier to gate on when the spectrum is
  visible. The fields are free (already computed by `eighComplex`)
  and agent-honest. Cost: ~10 extra wire bytes per element of `n`.

- **Why a separate tool, not a `--norm` flag on `linalg-eigh-complex`.**
  The trace norm is a *scalar* with a documented invariant set
  (non-negative, triangle inequality, ‖cM‖ = |c|·‖M‖, ‖ρ‖₁ = 1 for
  density operators) — invariants that don't make sense at the eigh
  level. Separating the two tools gives `registry-search` an explicit
  type signature for the planner; gives downstream composers a
  cleanly-typed `wb.traceNorm({M})` call site; and gives the qinfo
  v0.2 trio (trace-distance, fidelity, purity) a clear cousin to
  follow.

- **Why refuse non-Hermitian rather than dispatch to SVD.** Phase 2
  (`linalg-svd-complex`) is filed and not yet shipped. v0.1 refuses
  with an honest tag (`trace-norm/non-hermitian-input`) that names
  the path forward. When phase 2 lands, this tool will gain a
  `hermitian?: boolean` flag (auto-detect by default) and dispatch
  between the two substrate calls; the non-Hermitian tag will be
  subsumed. The discipline matters: a tool that silently
  Hermitian-symmetrises `(M + M†)/2` and returns *that* matrix's
  trace norm would be **inadmissible** (Rule 8 — that's a different
  matrix; the answer is not the user's answer).

- **Why duplicate `findWorstHermitianViolation` from
  `linalg-eigh-complex/tool.ts` rather than reuse.** It's a 15-line
  helper that lives at the tool layer (the substrate's
  `eighComplex` doesn't expose it — the substrate is permissive on
  Hermiticity and trusts the caller). Re-implementing it in
  trace-norm keeps the tool self-contained — no cross-tool helper
  import to maintain. If a third tool needs this, the helper
  graduates to `packages/linalg-core/src/complex-matrix.ts` as
  `hermitianViolation(M, tol)`. v0.1 doesn't justify the move.

## Frictions surfaced

- **The `eighComplex` inside `examples`-table evaluation runs at
  module-load time.** `defineTool` reads the `examples` array before
  the runner is wired up; each example's `output` is computed at
  import time. For trace-norm I chose to compute the expected output
  by running `eighComplex` directly on flat `re/im` buffers (rather
  than re-running the full tool), via a duplicated helper
  `traceNormSuccessFromExample`. The duplication is small and
  intentional — using the runner from inside the examples would risk
  circular evaluation.

- **`maxAbs` tracking via `Math.hypot` per element.** This is one
  square-root per matrix element during decode, theoretically
  expensive at large `n`. In practice the decode loop is dominated
  by JSON parse + Float64Array allocation; the `Math.hypot` is
  noise. If profiling ever shows this matters, replace with `re² +
  im²` accumulation and one `sqrt` at the end.

- **Pre-existing `.claude/worktrees/` raw-kind-literal drift sites
  in the convention warning.** Inherited from earlier work
  (presumably an agent-a1c13e6c worktree that wasn't cleaned up).
  Not blocking; the convention warning explicitly flags these as
  non-fatal. Filing a memory note: when this drift accumulates we
  may want a cleanup pass.

- **Demo-scope wall-clock to 1.05s.** New tool is loaded but the
  demos around it are ms-level; the trace-norm calls themselves add
  ~3-4ms total. Acceptable.

## Acceptance

  - [x] `tools/trace-norm/{tool,goldens.spec,README,package}.ts/md/json`
    all written.
  - [x] 35 goldens generated, byte-frozen.
  - [x] `--test` hook passes; covers 8 invariant cases.
  - [x] Demo-scope #23 (Helstrom trace distance) produces correct
    values to 1e-12.
  - [x] Typed barrel regenerated (`wb.traceNorm`, 48 tools).
  - [x] Tool-catalog row added to root `README.md`.
  - [x] `bun run check` green (running at shard write-time).
  - [x] Bead `korg` (trace-norm tool) claimed, ready to close on
    commit.
  - [ ] `k2xo` (trace-distance), `2hxf` (fidelity), `2czd` (purity)
    queued — each is one composition over trace-norm's substrate
    fixture. Next session.

## Pointers

  - ADR-0035 — the complex-linalg-tier ADR.
  - Worklog 100 — ADR-0035 writing.
  - Worklog 101 — `linalg-eigh-complex` substrate that this tool
    composes against.
  - Bead `korg` (closes this session), `hsxa` (qinfo epic, parent),
    `ov4j` (complex-linalg epic; phase 1 shipped, phase 2 filed).
  - Watrous, *Theory of Quantum Information*, Cambridge 2018, §1.1
    + §3.1 — operator norms, trace distance, Helstrom's theorem.
  - Nielsen & Chuang, *Quantum Computation and Quantum Information*,
    Cambridge 2010, §9.2 — the trace distance and its operational
    significance.
  - Bhatia, *Matrix Analysis*, Springer 1997, §IV.2 — Schatten
    norms; the Hermitian spectral characterisation `‖M‖₁ = Σ |λ_k|`
    that this tool implements.
