# 100 — Complex-Hermitian linalg tier: ADR-0035 (2026-05-13)

> **Scope.** Write ADR-0035 to resolve the open decision in `ov4j`
> (complex-Hermitian / complex-matrix linalg extension). The session
> produces only the ADR + lockstep doc updates; the three downstream
> tools (`linalg-eigh-complex`, `linalg-svd-complex`,
> `linalg-solve-complex`) are filed-but-not-shipped, and the qinfo v0.2
> tools that depend on them (`korg` trace-norm, `k2xo` trace-distance,
> `2hxf` fidelity, `2czd` purity) remain blocked. The ADR is the next
> entry point for that work.

## Context

The qinfo v0.1 substrate landed 2026-05-12 (shard 099) with a deliberate
hole: `traceNorm`, `traceDistance`, `fidelity`, `purity` filed and
queued, all blocked by `ov4j`. The `temp/qwasserstein.ts` dogfood that
prompted the substrate restricted *every* `n=1` example to the real
Bloch X–Z plane to avoid the absence of complex-Hermitian
eigendecomposition. Real Bloch slice only is not honest scope for a
substrate the workbench claims ships quantum information.

This session opened with the user re-issuing the "what would you, as a
TS expert, desire to work on" framing that opened the previous session.
Survey of the open work pointed to `ov4j` for three reasons: (1) it's a
named substrate gap with a single open ADR decision; (2) it cascades
into clean downstream wins (`korg` trace-norm specifies almost
mechanically once complex eigh exists); (3) the algorithmic choice for
v0.1 (real-symplectic embedding) is port-and-verify-shaped rather than
greenfield-research-shaped — the Goedecker identity reuses every line
of the existing real cyclic-Jacobi `eigh`. The bead `ov4j` itself named
three options for the tool surface and recommended (b), but explicitly
held the decision in an ADR; this session is that decision.

## What changed

### `docs/adr/0035-complex-linalg-tier.md` (new)

Eight decisions, each additive to the existing surface:

  - **D1 — Tool surface, option (b):** three parallel `*-complex`
    tools mirroring the `meijer-g-*` fan-out (`linalg-eigh-complex`
    next to `linalg-eigh`, etc.). Rejected (a) extend-existing — would
    shift the existing 350+ goldens. Rejected (c) bridge-package — the
    tools would be invisible to `registry-search`'s type-based
    discovery, violating PRD §6.3.
  - **D2 — Wire shape:** `record{re: list<list<float64>>, im:
    list<list<float64>>}` with `im` **required** and shape-matched to
    `re`. Required-`im` is the right discipline for a complex tool:
    "this value is definitely complex" should read from the type.
    Per-cell complex (`list<list<record{re, im}>>`) rejected as 3-4×
    wire inflation and a violation of the "bulk numerics travel as
    single-kind `list<…>`" convention.
  - **D3 — Determinism tier:** `numerical: true` (ADR-0015). Hermitian
    eigenvalues are real and emit as `list<float64>`; eigenvectors are
    complex `record{re, im}`. Emitting eigenvalues as
    `list<record{re, im}>` of always-zero-imaginary would lie about
    what Hermitian eigendecomposition produces.
  - **D4 — Substrate location:** new `ComplexMatrix` type in
    `@workbench/linalg-core`, structurally identical to qinfo's
    `Matrix`-with-im but with `im` **required**, not optional. The
    two-types-bridged-by-helpers shape (`complexFromReal`,
    `complexFromQinfo`, `realPartOnly`) keeps the type discipline:
    every complex algorithm trusts a single non-optional shape; the
    branch on real-vs-complex happens once at the boundary, not at
    every loop nest. Rejected: extending real `Matrix` with optional
    `im` (renames `.data → .re` across every linalg-core call site);
    using qinfo's `Matrix` directly (forces every complex algorithm to
    branch on `if (M.im)`); new package (over-inflates the dependency
    graph for what is structurally the same package's concerns).
  - **D5 — Algorithm v0.1: real-symplectic embedding** (Goedecker
    1999, Day & Heroux 2001). `H = A + iB → H̃ = [[A, -B], [B, A]]` of
    size 2n × 2n is real-symmetric; eigenvalues come in identical
    pairs, eigenvectors lift back as `(u_a, w_a) → u_a + i · w_a`. The
    complex eigh is a ~120-LOC wrapper over the existing real cyclic-
    Jacobi `eigh` — zero new spectral code for v0.1. 8× flops, 4×
    memory; invisible at qinfo-dogfood scale (`d ≤ 256`). Native
    complex Householder + complex QR iteration deferred to v0.2 under
    a workload that justifies the constant-factor win.
  - **D6 — Hermiticity check + boundary categories:** `H[i,j] =
    conj(H[j,i])` ⇒ `re[i,j] = re[j,i]` AND `im[i,j] = -im[j,i]` AND
    `im[i,i] = 0`. Tolerance `100·EPS·max|H|` (parallel to real
    `linalg-eigh`'s `SYMMETRY_TOL_FACTOR`). Boundary tags:
    `non-hermitian-input`, `non-finite-input`, `degenerate-shape`.
    `ToolError` for malformed: shape mismatch between `re` and `im`,
    non-square, ragged rows, OOM on the 2n × 2n buffer.
  - **D7 — Output shape:** parallel-but-distinct from real eigh.
    `Q` is complex (`record{re, im}`); `eigenvalues` is
    `list<float64>` (real, ascending); reconstruction and
    orthogonality errors are the agent-honest self-report (ADR-0014
    pattern), computed in complex arithmetic; `method` is
    `"real-symplectic-embedding"` (becomes a
    `F.enum(["real-symplectic-embedding", "complex-jacobi"])` schema-
    additively in v0.2).
  - **D8 — Phase order:** `linalg-eigh-complex` first (unblocks
    `korg` and the rest of the qinfo v0.2 surface). Then
    `linalg-svd-complex` (complex one-sided Jacobi SVD; not via the
    symplectic embedding — that buys nothing for SVD). Then
    `linalg-solve-complex` (complex LU + iterative refinement +
    complex Hager). Each is independent; only phase-1 blocks
    downstream qinfo tools.

### `CLAUDE.md` (hallucination-risk callout added)

New entry in the "Hallucination-risk callouts" list naming the
`record{re, im}` wire shape with both fields required. The optional-
`im` shape (qinfo substrate) and the required-`im` shape (wire +
linalg-core `ComplexMatrix`) are easy to confuse; the callout names
the distinction.

### `README.md` (paragraph added between value protocol and tool
invocation)

Paragraph documenting the canonical complex-matrix wire shape and the
required-`im` discipline. References ADR-0035. Explicitly notes the
per-cell-complex rejection and the qinfo-substrate-shape distinction.

## Why these choices

The ADR's own §"The axiom (re-applied)" carries the reasoning. The two
load-bearing TS-expert calls:

  1. **`linalg-eigh-complex(H)` is what the TS expert types** — not
     `linalg-eigh(realSymplecticEmbed(H))`, not a flag toggle on the
     existing tool, not a hidden bridge. The parallel-tool pattern is
     visible to `registry-search` by type and reads correctly in a
     typed-barrel call site (`wb.linalgEighComplex(H)` mirrors
     `wb.linalgEigh(A)`).
  2. **A `ComplexMatrix` is definitely complex** — the type carries
     "complex" at the type level so every algorithm trusts it,
     instead of branching `if (M.im)` at the top of every body. The
     bridge helpers handle the boundary; the algorithms see one
     shape.

The third choice that wasn't in the bead's option-list is the
algorithm. Real-symplectic embedding ships a working complex eigh in
~120 LOC of wrapper, reusing the existing real Jacobi code in full.
This is the standard idiom for the field (Goedecker 1999 in DFT,
Day & Heroux 2001 in scientific computing more generally) and the
backward-stability properties are well-understood. Native complex
Jacobi would be ~600 LOC of complex-rotation code; it's the right
v0.2 work when a workload at `n > 1000` justifies the constant-factor
win.

## Frictions surfaced

  - **Two near-identical `Matrix` types** — linalg-core's
    `ComplexMatrix` and qinfo's `Matrix`-with-im. The bridge helpers
    are the explicit conversion points, named in the linalg-core
    public surface. A future ADR could unify if the duplication
    grates, but the required-vs-optional `im` distinction is
    load-bearing and unlikely to converge cleanly.
  - **Schema-validation walks `record{re, im}` instead of an opaque
    blob.** A 200 × 200 complex matrix on the wire is ~1.5 MB of
    JSON (3× the real-only case). The blob-by-hash escape hatch
    (bead `wmm`) is the v0.2 path when n ≥ 500 actually hurts.
  - **`-0` in `Q.im` for real-density-operator input.** Same
    `-0` IEEE-754 corner ADR-0034 documented for `qinfo.adjoint`.
    Test goldens will use `maxAbsDiff` rather than strict `===` for
    the same reason.
  - **The ADR did *not* commit to a substrate-side refactor of
    qinfo's `Matrix`.** It explicitly stays optional-`im`; the
    duplication is the price of additive shipping. If the qinfo
    package later wants to depend on linalg-core's `ComplexMatrix`
    directly, that's a separate ADR.

## Acceptance

  - [x] `docs/adr/0035-complex-linalg-tier.md` exists, Status=Accepted.
  - [x] `CLAUDE.md` "Hallucination-risk callouts" gains the
    complex-matrix wire-shape entry.
  - [x] `README.md` value-protocol section gains the
    complex-matrices-on-the-wire paragraph.
  - [x] Bead `q4f9` (this ADR write) created, claimed, referenced
    from `ov4j`'s description / notes.
  - [ ] Three downstream beads filed under `ov4j`:
    `linalg-eigh-complex`, `linalg-svd-complex`,
    `linalg-solve-complex`. (Next session.)
  - [x] This worklog shard documents the iteration.
  - [ ] `bun run check:quick` clean. (Verified this session;
    documents-only edits.)

## Pointers

  - ADR-0035 — this session's primary artefact.
  - ADR-0034 — qinfo substrate (the source of the `Matrix`-with-im
    shape, the source of the `ov4j` blocker citation).
  - ADR-0014 — first numerical tier (the `linalg-core` substrate this
    ADR extends).
  - ADR-0015 — determinism tier (`numerical: true` inherited).
  - Bead `ov4j` (epic, parent), `q4f9` (this ADR), `korg` / `k2xo` /
    `2hxf` / `2czd` (qinfo v0.2 tools unblocked when phase 1 ships).
  - `temp/qwasserstein.ts` — the dogfood that named the friction
    (referenced by ADR-0034 too).
  - Worklog 098 — qinfo substrate; the most recent place a substrate-
    plus-tool epic was decomposed into shippable phases. The
    `linalg-eigh-complex` follow-up should mirror its structure
    (substrate file + tool file + bench corpus, each a separate bead).
