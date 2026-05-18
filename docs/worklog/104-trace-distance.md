# 104 — trace-distance: the third qinfo v0.2 tool (2026-05-13)

> **Scope.** Ship `tools/trace-distance` — third deliverable of the
> qinfo v0.2 surface, sibling to `trace-norm` and `purity`. Trace
> distance `D(ρ, σ) = ½‖ρ − σ‖₁` between two complex Hermitian
> density operators, computed via the same `eighComplex` substrate
> as `trace-norm` applied to the Hermitian difference. 29 goldens,
> full seven-artefact contract, demo-scope #25 demonstrates Helstrom
> distinguishability and triangle-inequality saturation on collinear
> Bloch states, `bun run check` clean (91 passed, 0 failed).

## Context

Shard 103 closed bead `2czd` (purity); the v0.2 trio's third member
`k2xo` (trace-distance) was the obvious next move, and continued the
session-long thread of taking the qinfo v0.2 trio from "filed" to
"shipped" tool-by-tool. The bead's spec line had been "Thin tool
over @workbench/qinfo's traceDistance" written before trace-norm
shipped; like purity, the implementation rebases on the post-trace-
norm reality: there is no `traceDistance` in `@workbench/qinfo` yet
(that was the "eigh-routed metrics deferred to v0.2" subset of the
qinfo index notice from shard 098), so the tool composes
`eighComplex` from `@workbench/linalg-core` directly, mirroring
trace-norm's pattern.

The mathematical claim is the same as trace-norm's, restricted to a
specific operand: the difference `ρ − σ` of two Hermitian matrices
is Hermitian by linearity, so the spectral characterisation
`‖M‖₁ = Σ |λ_k(M)|` (Bhatia §IV.2) applies; halve to get D. The
algorithm is `eighComplex(ρ − σ) → ½ · Σ |λ|`.

What's new in this session relative to trace-norm and purity is the
**two-input wire shape and the corresponding two-side boundary tags**:
`trace-distance/non-hermitian-input` and
`trace-distance/non-finite-input` carry a `which` field
∈ {"rho", "sigma"} so a planner can locate the bad input without
re-decoding the wire. `trace-distance/shape-mismatch` is the new
boundary class — refusing across Hilbert-space dimensions, with the
payload `(rho_n, sigma_n)` naming both sides.

## What changed

### `tools/trace-distance/` (new)

Full seven-artefact contract. Algorithm:

1. Decode `ρ.re, ρ.im, σ.re, σ.im` into flat `Float64Array(n²)`,
   folding in non-finite detection (→ tagged with `which`),
   degenerate-shape (→ tagged), and `maxAbs` for the Hermiticity
   tolerance.
2. Validate `n_ρ = n_σ`; refuse via `shape-mismatch` tag with
   `(rho_n, sigma_n)` payload.
3. Hermiticity gate on each input separately, with `which`
   distinguishing the offending side.
4. Compute `M = ρ − σ` entry-wise (Hermitian by construction).
5. `eighComplex(M)`; sum `|λ_k|`; halve.

Wire shape:
- Input: `record{rho: record{re, im}, sigma: record{re, im}}`. Both
  inputs use the canonical complex-matrix wire (ADR-0035 §D2),
  matching trace-norm and purity. The v0.2 quartet now has one
  matrix wire convention across all four tools.
- Output: `record{value, method, warnings}`. Single happy-path
  scalar plus method tag and warning list. Eigenvalues of `ρ − σ`
  are *not* surfaced because they're a derived intermediate; a
  caller who wants them can call `trace-norm` on the difference
  directly (or `linalg-eigh-complex`). Keeping `trace-distance`
  lean gives `registry-search` a clean type signature.

Boundary tags:
- `trace-distance/non-hermitian-input` (with `which`)
- `trace-distance/non-finite-input` (with `which`)
- `trace-distance/shape-mismatch` (new — `n_ρ ≠ n_σ`)
- `trace-distance/degenerate-shape` (with `which`)

ToolError for malformed: re/im shape mismatch within ρ or σ,
non-square, ragged rows.

29 goldens covering: orthogonal-pure-states saturate (computational
basis, X-eigenbasis, Y-eigenbasis as complex Hermitian, qutrit
orthogonal pures); identity-of-indiscernibles at multiple shapes;
pure-vs-max-mixed at d = 2, 3, 4 (D = 1 − 1/d); orthogonal Bell-state
projector pairs (Φ+ vs Φ−, Φ+ vs Ψ+); flipped classical bits
(D = |p − q|); Bloch X-Z plane geometric (D = √0.72/2); pure-vs-near-
pure (D = 0.01 — small distance probe); complex-Hermitian Bloch with
Y component (the dogfood case, D = 0.5 by Y-flip); symmetry probe
(D(A,B) = D(B,A) — encoded as two separate goldens whose value
fields must agree); triangle probes (three diagonal mixtures
saturating D(a,c) = D(a,b) + D(b,c) = 0.6); 3×3 generic; and every
boundary branch.

`--test` hook: seven invariant probes (orthogonal-pure,
identity-of-indiscernibles, pure-vs-max-mixed at d = 2 and d = 3,
orthogonal-Pauli-Y-eigenstates, flipped-classical-bits, plus an
explicit symmetry assertion `D(A, B) == D(B, A)` and an explicit
triangle assertion on diagonal mixtures).

### Lockstep doc updates (Law 2)

- `README.md` root: tool-catalog row for `trace-distance` placed
  between `tensor-product` and `trace-norm`.
- `packages/compose/src/generated/wb.ts` regenerated (50 tools;
  `wb.traceDistance` available via the typed barrel).
- `scripts/demo-scope.ts` gains demo #25: Helstrom orthogonal-pure-
  saturation (D = 1 ⇒ P_distinguish = 1) plus a triangle-inequality
  saturation probe on three collinear-Bloch diagonal mixtures
  (D(a,b) + D(b,c) = D(a,c) = 0.6). The triangle saturation reads
  visually in the output as "0.6000 ≥ 0.6000 (collinear ⇒
  saturated)" — irresistible to anyone reading the demo.

## Why these choices

- **Why the complex Hermitian wire shape, not the bead's `record{rho:
  list<list<float64>>, sigma: list<list<float64>>}`.** Same reason
  as purity (worklog 103 §"Why these choices"): the bead was filed
  pre-trace-norm and pre-purity; TS-expert consistency across the
  v0.2 quartet demands a single matrix wire shape. Real density
  matrices pass `im` as zero-list — the zero-im decode path is
  cheap and the wire-shape consistency wins.

- **Why direct `eighComplex` rather than calling `wb.traceNorm` via
  the compose layer.** Per CLAUDE.md's "in-process vs subprocess
  invocation" rubric: tools call substrates, orchestrators call
  tools. `@workbench/compose` is for orchestrators (demos,
  benchmarks, agent loops); `trace-distance` is itself a tool, so
  it composes at the substrate level. The alternative — importing
  `def` from `tools/trace-norm/tool.js` and calling its `fn` —
  would build a wire-encoded difference matrix, re-decode it inside
  trace-norm, re-check Hermiticity, and decode the result. That's
  three layers of round-trip for what is fundamentally a 5-line
  `eighComplex → Σ|λ| → halve` composition.

- **Why a `which` field on the boundary tags rather than tag suffixes
  (`/non-hermitian-rho` vs `/non-hermitian-sigma`).** The
  ADR-0003 convention is `tagged "<tool>/<class>"`; nesting an
  identity into the class would multiply the tag space. The
  payload-field approach keeps the tag set stable
  (`non-hermitian-input` is one class, regardless of which input)
  and the planner reads `which` to specialise its repair logic.
  Same shape that `linalg-solve` uses for `(row, col)` —
  payload-side localisation.

- **Why a separate `shape-mismatch` tag rather than a `ToolError`.**
  Shape mismatch is an honest boundary refusal (the trace distance
  isn't *defined* between operators on different-dimensional
  Hilbert spaces; embedding into a common dimension is a caller-
  side decision). `ToolError` is reserved for malformed input
  (ragged, non-square, shape mismatch *within* an input between re
  and im). The class line: "your operators don't live on the same
  Hilbert space, so the question has no answer" — a tagged refusal
  is the agent-honest response.

- **Why minimal output (just `value, method, warnings`) versus
  trace-norm's richer record.** Trace-norm exposes
  `eigenvalues + condition_number` because the eigenvalues are of
  the *input* matrix — they're useful per se as spectral data the
  caller paid an O(n³) eigh for. Trace-distance's eigenvalues are
  of `ρ − σ`, an internal-only intermediate. A caller who wants
  the spectrum can call `linalg-eigh-complex` directly on the
  difference; bundling the spectrum into `trace-distance`'s output
  hides the type signature behind a "and also some other stuff"
  shape. Keep `trace-distance`'s output narrow; let `trace-norm`
  be the spectrum-rich tool.

- **Why warn-don't-refuse on suspicious density matrices (`tr ≠ 1`,
  `D > 1`).** Same reasoning as purity (worklog 103): refusing
  forces users to pretend non-density operators are density
  operators to use the tool. Computing D between arbitrary
  Hermitian matrices (e.g. observables) is mathematically valid
  and useful; the warning lets the caller decide whether to trust
  the interpretation as a "trace distance" or just as a halved
  Schatten-1 norm.

## Frictions surfaced

- **The decoder + Hermitian-check helpers are now triplicated.**
  `decodeComplexMatrix` and `findWorstHermitianViolation` exist
  inline in three tool files: trace-norm, purity, and now
  trace-distance. Shard 102's "third use → lift" trigger has
  fired, but trace-distance's decoder has a *different shape*
  (parameterised on `which`, since the tool decodes two matrices),
  so the lift design isn't obvious. The right move (deferred):
  ship `fidelity` (bead `2hxf`) next, which will give a *fourth*
  data point with a similar two-matrix shape, then design the
  shared substrate based on the union of the four patterns. The
  natural home is a new file `packages/contract/src/wire-decode.ts`
  exposing `decodeComplexMatrix(reList, imList, opts: {toolName,
  inputName})` and `findWorstHermitianViolation(...)` — but only
  once we've seen fidelity's needs concretely. YAGNI-postponed,
  not YAGNI-rejected.

- **Output type field `method` carries only one literal in v0.1.**
  Three of the four qinfo v0.2 tools (trace-norm, trace-distance,
  fidelity-to-be) emit a `method` field, but each tool has a single
  fixed algorithm in v0.1 — so the field is constant per tool.
  This is intentional forward-compat: when SVD-complex ships
  (ADR-0035 phase 2), the same tools will dispatch between
  `hermitian-via-eigh-complex` and a non-Hermitian SVD path, at
  which point `method` discriminates. Today the field is
  documentary; tomorrow it carries content.

- **No `bun run check` failure this cycle.** Unlike shard 103 the
  codegen-barrel regen was done before the final `check` (since
  this session already learned that lesson). Filing the friction
  again is unnecessary; the right fix would be a `bun run new-tool`
  closing message that explicitly names `bun scripts/gen-workbench-
  barrel.ts` as a required step before commit. Not blocking.

## Acceptance

  - [x] `tools/trace-distance/{tool,goldens.spec,README,package}.ts/md/json`
    all written.
  - [x] 29 goldens generated, byte-frozen.
  - [x] `--test` hook passes; covers 7 invariant probes including
    explicit symmetry and triangle assertions.
  - [x] Demo-scope #25 (Helstrom + triangle saturation) produces
    correct values; triangle reads "0.6000 ≥ 0.6000 (collinear ⇒
    saturated)" in the output.
  - [x] Typed barrel regenerated (`wb.traceDistance`, 50 tools).
  - [x] Tool-catalog row added to root `README.md`.
  - [x] `bun run check` green (91 passed, 0 failed).
  - [x] Bead `k2xo` (trace-distance tool) claimed; closes on commit.
  - [ ] `2hxf` (fidelity) — last in the v0.2 trio. Computes
    `F(ρ, σ) = (tr √(√ρ σ √ρ))²`. Needs a Hermitian-PSD matrix-
    square-root primitive (`Q · diag(√λ) · Q†` via `eighComplex` with
    PSD projection of negative eigenvalues within tolerance), then
    composes trace-norm on the inner matrix. The substrate work
    pays forward to diamond-norm and channel-fidelity downstream.

## Pointers

  - Worklog 102 — `trace-norm`, the substrate consumer this tool
    inherits from.
  - Worklog 103 — `purity`, the second qinfo v0.2 tool; established
    the wire-shape-lift-from-bead pattern this shard inherits.
  - ADR-0035 — complex-linalg-tier ADR; §D2 wire shape.
  - Bead `k2xo` (closes this session), `hsxa` (qinfo epic, parent),
    `2hxf` (fidelity, last in the trio).
  - Helstrom, *Quantum Detection and Estimation Theory*, Academic
    Press 1976 — the eponymous distinguishability bound.
  - Nielsen & Chuang, §9.2 — trace distance and its operational
    significance.
  - Fuchs & van de Graaf, *IEEE Trans. Inf. Theory* 45(4) 1999 —
    trace-distance / fidelity inequalities, the bound that
    `fidelity` will pair against when it ships.
  - Bhatia, *Matrix Analysis*, Springer 1997, §IV.2 — Schatten
    norms; spectral characterisation `‖M‖₁ = Σ |λ_k|` for
    Hermitian M, the kernel of this tool's algorithm.
