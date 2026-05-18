# 112 — packages/cone-core: the LP-complete slice of the SCS substrate (2026-05-14)

> **Scope.** Bead `cp9k` — the Phase-0 substrate of the convex-cone
> solver epic (`eg9j`, ADR-0030 §H). Ship `packages/cone-core`: the
> `Cone` primitive + projections, the homogeneous self-dual embedding,
> and the SCS operator-splitting iteration — to the **LP-complete**
> milestone, the slice that unblocks `tools/cone-solve` against its
> actual v0.1 bench gate. SOC/PSD/EXP/POW cone projections are filed as
> sub-beads, not deferred silently.

## Context

`cp9k` is the keystone of the convex-cone epic: it blocks `cone-solve`
(the universal-primary tool ADR-0030 calls "the symbol a TS expert
lusts to type"), `qp-solve`, and the deferred `sdp-solve`. It had sat
untouched since 2026-05-11 while the project's solver momentum went to
the *other* HSDE lineage — `@workbench/solver-ipm`'s interior-point
HSDE (worklogs 106/110). `cone-core` is the SCS / first-order lineage:
a different algorithm family for the same problem class.

**Law 1, and it paid for itself twice.** The canonical reference —
O'Donoghue-Chu-Parikh-Boyd 2016, *Conic Optimization via Operator
Splitting and Homogeneous Self-Dual Embedding* — was already staged at
`docs/refs/odonoghue-2016-scs.pdf` (alongside the whole HSDE family:
Andersen 2009, ECOS, Ye warm-start). Reading all 27 pages *before*
writing code surfaced the scope boundary that shaped the whole session
(below). The reading was transcribed to
`docs/ground-truth/convex/scs-algorithm.md` — the Law-1 artefact, cited
by file + page + equation throughout the source.

## What changed

New package `packages/cone-core` (`@workbench/cone-core`), three modules:

**`cones.ts`** — the `Cone` union (`NonNeg | Zero | Free | SOC | PSD |
Exp | Pow`), `coneDim`, `projectCone`, `dualCone`, `inCone`, smart
constructors. NonNeg / Zero / Free are fully implemented — their
Euclidean projections are *definitional* (`max(0,·)`, `0`, identity)
and need no second reference. SOC / PSD / Exp / Pow are in the union
(the documented surface, ADR-0030 §H) but every operation throws a
loud `ConeError` naming its sub-bead.

**`hsde.ts`** — `ConeProblem` (the input: `A, b, c, cones`),
`buildHSDE` (validate + lift to a dimension-checked `HSDEMatrix`),
`assembleQ` (materialise the dense skew-symmetric `Q` for tests),
`recoverPrimalDual` (the §3.5 termination evaluator: classify an
embedding point as optimal / primal-infeasible / dual-infeasible /
inconclusive, with the certificates). Internal `matTransposeVec` /
`dot` helpers — `linalg-core` exposes `matVec` but not the transposed
product.

**`scs.ts`** — `scsSolve`: the §3.2.3 three-step iteration with §3.3
over-relaxation, §3.4 zero-avoiding initialisation, and the §4.1
Sherman-Morrison-Woodbury factorisation-caching subspace solve (`M =
[[I, Aᵀ], [−A, I]]` LU-factored once, `g = M⁻¹h` and `denom` cached).
Returns a discriminated `SCSResult` — `status` *is* the contract.

61 tests across `cones.test.ts` / `hsde.test.ts` / `scs.test.ts`, plus
docs: package README, root README File-layout row, the ground-truth
transcription, and ADR-0030 §H is now realised (one deviation, below).

## Why these choices

**The LP-complete scope boundary.** The 2016 paper gives the complete
SCS *algorithm* — embedding, iteration, over-relaxation, termination,
SMW subspace solve, scaling — but it does **not** give cone-projection
*formulas*: §3.1 and §6.1 defer SOC/PSD/Exp to Parikh-Boyd *Proximal
Algorithms* §6.3 (ref [64]) and the power cone to Khanh Hien 2014 (ref
[97]). Neither is staged in `docs/refs/`. Under Law 1 + ADR-0030 §E's
"pitiless" port discipline, those projections cannot be written yet.
This lines up exactly with a real milestone: the **v0.1 bench gate is
LP-only** (worklog 089: 21/21 lp-netlib + 29/29 lp-small), and LP needs
only the nonneg orthant (+ zero, absorbed into `Ax=b`) — projections
that *are* definitional. So the honest decomposition is: ship the
LP-complete slice now, file `0wc7` (SOC+PSD) and `j282` (Exp+Pow) as
sub-beads of `cp9k`, each carrying its "stage the reference first"
acceptance criterion. `projectCone` throws a `ConeError` *naming the
bead* for any unimplemented family — Rule 8 honest scope, and the bead
pointer is verified real (the IDs in the source are the IDs `bd
create` actually returned, not placeholders).

**Dependency: linalg-core only, not protocol+contract.** ADR-0030 §H
wrote "depends on protocol, contract, linalg-core". `cone-core` ships
depending on `linalg-core` *only*. The §H line predates the
now-established `linalg-core` discipline — a numerics substrate speaks
`Float64Array`, not the wire protocol; the cone-as-`expression`
encoding and the `cone-solve` records are a *tool-layer* concern. A TS
expert building this substrate writes it pure-numerics and pushes the
protocol to the boundary, exactly as `linalg-core` does. Taking the
position (the two principles: don't escalate where they give a clear
answer) rather than following the stale §H line literally.

**`recoverPrimalDual` is the tested kernel; `scsSolve` is the loop.**
The §3.5 termination logic — form the candidate, compute the three
residuals, check the certificate conditions — is a pure function of
`(u, v, hsde, tol)`. Factoring it out of the iteration means the entire
termination taxonomy is testable on *hand-built* embedding points with
known classifications (a zero-residual point → optimal; a Farkas
direction → primal-infeasible; an unbounded ray → dual-infeasible),
and `scsSolve` is a thin, readable loop around it.

**`SCSResult` is a discriminated union, not a flat record.** ADR-0030
§D specifies a flat wire record. But that is the *wire* shape; the
*substrate* return is a discriminated union keyed on `status`, so the
type itself forbids reading an `objective` off an `infeasible` result.
The tool layer flattens it to the §D record. This is the
"irresistible to a TS expert" read of the honest-status requirement.

**Direct method, not indirect.** §4.1 offers a direct (cache an LU/LDLᵀ
factor of `M`) and an indirect (CG on `I + AᵀA`) subspace solve. v0.1
uses direct: `M` is invertible for *any* data (no SPD assumption
needed, unlike the indirect path's `I + AᵀA`), and it reuses
`linalg-core`'s `lu` verbatim. ADR-0030 defers sparse to v0.2, so the
indirect method's large-sparse motivation does not yet apply.

## Frictions surfaced

- **The `−0` trap in the skew-symmetry test.** `assembleQ` writes `−0`
  wherever a data entry is `0` (`-a` with `a === 0`). The first
  skew-symmetry test used `expect(get(Q,i,j)).toBe(-get(Q,j,i))`, which
  fails on the *diagonal*: `Object.is(+0, −0)` is `false`. The fix is
  the mathematically honest form — `expect(get(Q,i,j) + get(Q,j,i))
  .toBe(0)` — since `0 + −0` is `+0`. The invariant `Q + Qᵀ = 0` was
  right; the *encoding* of it as a test was wrong.

- **`iter-cap` before any `u_τ > 0` has no candidate.** A probe showed
  `scsSolve` on a 1-var LP with `maxIter = 2` returns
  `achievedPrecision = +∞` — no iterate has had `u_τ > 0` yet, so there
  is nothing to read off. This is *correct and honest* (the alternative
  is fabricating a finite number), but the first iter-cap test asserted
  `Number.isFinite`. Split into two tests: `maxIter = 10` (a candidate
  exists, finite precision worse than target) and `maxIter = 2` (no
  candidate, `achievedPrecision === Infinity`, `x` absent).

- **`Float64Array<ArrayBuffer>` vs `<ArrayBufferLike>`.** The mutable
  iteration bindings `let u = new Float64Array(N)` narrow to
  `Float64Array<ArrayBuffer>`, which then rejects the reassignment from
  `projectProduct` (`<ArrayBufferLike>`). Fixed with an explicit
  `let u: Float64Array` annotation — the general element type is the
  one wanted, the idiomatic TS-expert fix.

## Acceptance

- `bun run typecheck` — clean across the workspace (new package wired
  into `tsconfig` paths + the `bun install` workspace symlink).
- `bun test packages/cone-core/` — **62 pass, 0 fail**, 208 assertions.
- **Mutation-proven** (Rule 6/7), four sign-flips on the load-bearing
  invariants, each confirmed RED then restored:
  - `projectCone` nonneg `zi>0` → `zi<0` — 2 fails (Moreau / idempotence).
  - `assembleQ` `−A` block sign — 2 fails (skew-symmetry).
  - `subspaceProject` SMW correction `−` → `+` — 6 fails (LP convergence).
  - `recoverPrimalDual` primal residual `−b` → `+b` — 9 fails (KKT
    re-derivation + termination classification).
- Hand-verified LP optima: `min x s.t. x≥1` → `x=1` (47 iters);
  `min x+2y s.t. x+y≥3, x,y≥0` → `x=3, y=0` (96 iters); equality via
  the zero cone → `x=5`. Each cross-checked by an *independent* KKT
  residual re-derivation in the test (the solver's self-report is never
  trusted — worklog 089 "status is honest").
- Determinism: the same problem solved twice is bit-identical
  (`expect(...).toBe(...)`, not `toBeCloseTo`).
- `bun run check` — full gate green.

## Pointers

- Bead: `scientist-workbench-cp9k` (this slice). Sub-beads filed:
  `scientist-workbench-0wc7` (SOC + PSD projections),
  `scientist-workbench-j282` (Exp + Pow projections) — both depend on
  `cp9k`, both blocked on staging Parikh-Boyd §6.3 in `docs/refs/`.
- Unblocks `scientist-workbench-2ivi` (`tools/cone-solve`) for the
  LP-complete bench gate.
- ADR-0030 §H (substrate package); `docs/ground-truth/convex/scs-algorithm.md`
  (the algorithm transcription); `docs/refs/odonoghue-2016-scs.pdf`
  (the canonical reference).
- `packages/cone-core/{src,test}/`, `packages/cone-core/README.md`.
