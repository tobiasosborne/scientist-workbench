# @workbench/cone-core

Pure-TypeScript convex-cone solver substrate — the SCS-style
operator-splitting iteration on the homogeneous self-dual embedding
(O'Donoghue-Chu-Parikh-Boyd 2016). The universal-primary lineage of the
convex-cone solver tier (ADR-0030 §H); the substrate behind the
forthcoming `tools/cone-solve`.

This is a **library, not a tool** — it speaks `Float64Array` and a plain
TS `Cone` union, never the canonical JSON value protocol. The wire
encoding (cones-as-`expression` values, the `cone-solve` input/output
records) lives in the tool layer. Same discipline as
`@workbench/linalg-core`: the substrate carries no `@workbench/protocol`
dependency, only `@workbench/linalg-core` for `Matrix` + LU.

Algorithm ground truth: [`docs/ground-truth/convex/scs-algorithm.md`](../../docs/ground-truth/convex/scs-algorithm.md),
transcribed from `docs/refs/odonoghue-2016-scs.pdf`. Ported **from the
paper, never from `scs.c`** (CLAUDE.md Law 1 + ADR-0030 §E).

## Surface

```ts
import {
  // cones.ts — the cone primitive and its Euclidean projection
  type Cone, nonNeg, zero, free, coneDim,
  projectCone, dualCone, inCone, ConeError,
  // hsde.ts — the homogeneous self-dual embedding
  type ConeProblem, type HSDEMatrix, type Recovered,
  buildHSDE, recoverPrimalDual, assembleQ,
  // scs.ts — the operator-splitting iteration
  type SCSOpts, type SCSResult, scsSolve, DEFAULT_SCS_OPTS,
} from "@workbench/cone-core";
import { matrixFromRows } from "@workbench/linalg-core";

// minimise  x   s.t.  x ≥ 1     (encoded −x + s = −1, s ≥ 0)
const result = scsSolve({
  A: matrixFromRows([[-1]]),
  b: new Float64Array([-1]),
  c: new Float64Array([1]),
  cones: [nonNeg(1)],
});
// result === {
//   status: "optimal",
//   x: Float64Array [≈1], y: Float64Array [≈1], s: Float64Array [≈0],
//   objective: ≈1, iterations: 47, achievedPrecision: ≈6.3e-9,
// }
```

## The problem

A primal–dual pair of cone programs in O'Donoghue 2016 standard form:

```
minimise   cᵀx     s.t.   A x + s = b ,   (x, s) ∈ ℝⁿ × 𝒦
```

`A` is `m × n`; the cone `𝒦 ⊆ ℝᵐ` is a product `Cone[]` over contiguous
slices of the slack `s`, whose dimensions must sum to `m`. `scsSolve`
returns a discriminated `SCSResult` — the `status` field *is* the
contract:

| status | meaning | fields |
|---|---|---|
| `optimal` | KKT met within `precision` | `x, y, s, objective, achievedPrecision` |
| `infeasible` | primal infeasible | `certificate` (Farkas `y`, `bᵀy = −1`) |
| `unbounded` | primal unbounded / dual infeasible | `certificate` (ray `x`, `cᵀx = −1`) |
| `iter-cap` | `maxIter` hit first | best-effort `x, y, s` + honest `achievedPrecision` |
| `numerical-breakdown` | non-finite iterate / failed factorisation | `detail` |

You cannot read an `objective` off an `infeasible` result — the type
forbids it. There is no mode where the solver returns garbage under a
happy `optimal` (CLAUDE.md Rule 8).

## v0.1 scope — the LP-complete cone subset

`cone-core` v0.1 implements the three cone families whose projections
are *definitional* and need no second reference: the **zero** cone, the
**free** cone, and the **nonnegative orthant**. Those three close the
**LP** case (LP = nonnegative orthant, equalities folded into `Ax = b`),
which is exactly the v0.1 bench gate.

The `SOCone`, `PSDCone`, `ExpCone` and `PowCone` variants are present in
the `Cone` union — they are the documented substrate surface (ADR-0030
§H) and a TS expert should see the whole map — but every *operation* on
them (`projectCone`, `dualCone`, `inCone`, and `scsSolve` at setup)
throws a loud `ConeError` naming the sub-bead that tracks it:

- `SOCone` / `PSDCone` → bead `scientist-workbench-0wc7`
- `ExpCone` / `PowCone` → bead `scientist-workbench-j282`

Both are blocked on staging Parikh-Boyd *Proximal Algorithms* §6.3 (the
2016 SCS paper gives the cone *definitions* but defers the projection
*formulas*). A typed-but-unusable variant is honest; a silent wrong
projection is not.

## Determinism

`numerical: true` (ADR-0015): the iteration is a fixed sequence of
IEEE-754 float64 operations in a fixed order — bit-identical given
`(problem, opts, platform)`. No comparison uses an implicit-zero gate;
every threshold is an explicit tolerance derived from the single
user-facing `precision` knob (default `1e-8`). Data scaling (O'Donoghue
2016 §5) is a separable preprocessing step deferred to a follow-up bead
— v0.1 runs the iteration unscaled.

## Module map

| module | exports | paper §§ |
|---|---|---|
| `cones.ts` | `Cone`, `projectCone`, `dualCone`, `inCone`, `coneDim`, constructors | §6 (cone definitions; projections deferred to ref [64]) |
| `hsde.ts` | `ConeProblem`, `HSDEMatrix`, `buildHSDE`, `assembleQ`, `recoverPrimalDual` | §1–§2 (embedding eq 7/8), §3.5 (termination) |
| `scs.ts` | `SCSOpts`, `SCSResult`, `scsSolve` | §3.2.3 (iteration eq 17), §3.3 (over-relaxation), §3.4 (init), §4.1 (SMW subspace solve) |

## See also

- `docs/adr/0030-convex-cone-solver-tier.md` — the tier design.
- `docs/ground-truth/convex/scs-algorithm.md` — the algorithm transcription.
- `docs/worklog/112-cone-core-lp-slice.md` — the build of this v0.1 slice.
- `@workbench/linalg-core` — the `Matrix` + LU substrate this builds on.
