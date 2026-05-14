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

Algorithm ground truth: [`docs/ground-truth/convex/scs-algorithm.md`](../../docs/ground-truth/convex/scs-algorithm.md)
(the SCS iteration, transcribed from `docs/refs/odonoghue-2016-scs.pdf`)
and [`docs/ground-truth/convex/cone-projections.md`](../../docs/ground-truth/convex/cone-projections.md)
(the SOC + PSD projections, transcribed from
`docs/refs/parikh-boyd-2014-proximal-algorithms.pdf`). Ported **from the
papers, never from `scs.c`** (CLAUDE.md Law 1 + ADR-0030 §E).

## Surface

```ts
import {
  // cones.ts — the cone primitive and its Euclidean projection
  type Cone, nonNeg, zero, free, soc, psd, coneDim,
  projectCone, dualCone, inCone, ConeError,
  // hsde.ts — the homogeneous self-dual embedding
  type ConeProblem, type HSDEMatrix, type Recovered, type Scaling,
  buildHSDE, recoverPrimalDual, assembleQ,
  // scaling.ts — Ruiz data equilibration (O'Donoghue §5)
  equilibrate, applyScaling,
  // anderson.ts — Type-II Anderson acceleration (ADR-0036)
  makeAnderson,
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

## Cone scope — five of seven families live

`cone-core` implements five of the seven cone families:

- the three **definitional** families — the **zero** cone, the **free**
  cone, and the **nonnegative orthant** — whose projections need no
  second reference. These shipped in v0.1 and close the **LP** case (LP
  = nonnegative orthant, equalities folded into `Ax = b`), the v0.1
  bench gate.
- the **second-order** (Lorentz) cone `soc(dim)` — Parikh-Boyd §6.3.2,
  the standard three-case closed form (already-in / polar-to-apex /
  boundary projection).
- the **positive-semidefinite** cone `psd(side)` — Parikh-Boyd §6.3.3:
  the block is the upper-triangular `svec` of a symmetric matrix with
  the strict-Mosek **√2 off-diagonal scaling** (ADR-0030 OQ4), and the
  projection is `smat` → `eigh` → clamp the negative spectrum to zero →
  `svec`. The √2 is load-bearing — it makes `svec` a Frobenius isometry,
  which is what makes coordinate-wise Euclidean projection equal the
  matrix projection. (Bead `scientist-workbench-0wc7`.)

The `ExpCone` and `PowCone` variants are present in the `Cone` union —
they are the documented substrate surface (ADR-0030 §H) and a TS expert
should see the whole map — but every *operation* on them (`projectCone`,
`dualCone`, `inCone`, and `scsSolve` at setup) throws a loud `ConeError`
naming the sub-bead that tracks them: `scientist-workbench-j282`
(blocked on Parikh-Boyd §6.3.4 + Khanh Hien 2014 for the power cone). A
typed-but-unusable variant is honest; a silent wrong projection is not.

## Convergence: scaling + acceleration

The plain SCS iteration is a *modest-accuracy* first-order method with
slow tail convergence (O'Donoghue 2016 §1). `scsSolve` applies two
levers from the literature before declaring an answer:

- **Ruiz data equilibration** (`scaling.ts`, O'Donoghue §5) — the
  iteration runs on the rescaled problem `Â = D A E` whose rows and
  columns have near-unit norm; the §3.5 termination test runs on the
  *original* residuals. Necessary on poorly-scaled data; not sufficient
  alone.
- **Type-II Anderson acceleration** (`anderson.ts`, ADR-0036) —
  extrapolates the fixed-point iteration through a windowed
  least-squares solve, collapsing the slow linear tail. On by default
  (`SCSOpts.andersonMemory`, default `10`; `0` disables it).

Even so, SCS is not an interior-point method: it reaches modest
accuracy quickly and high accuracy slowly. For best-in-class LP / QP
accuracy reach for the specialists (`tools/lp-solve`, `tools/qp-solve`)
— ADR-0030 §B is explicit that `cone-solve` is the *universal*
1e-6-ceiling primary and the specialists are the high-accuracy paths.

## Determinism

`numerical: true` (ADR-0015): the iteration — equilibration,
acceleration and all — is a fixed sequence of IEEE-754 float64
operations in a fixed order, bit-identical given `(problem, opts,
platform)`. No comparison uses an implicit-zero gate; every threshold
is an explicit tolerance derived from the single user-facing
`precision` knob (default `1e-8`).

## Module map

| module | exports | reference |
|---|---|---|
| `cones.ts` | `Cone`, `projectCone`, `dualCone`, `inCone`, `coneDim`, constructors | O'D 2016 §6 (cone definitions); Parikh-Boyd §6.3.2/§6.3.3 (SOC + PSD projections) |
| `hsde.ts` | `ConeProblem`, `HSDEMatrix`, `Scaling`, `buildHSDE`, `assembleQ`, `recoverPrimalDual` | O'D 2016 §1–§2 (embedding eq 7/8), §3.5 (termination), §5 (scaled criteria) |
| `scaling.ts` | `equilibrate`, `applyScaling` | O'D 2016 §5 (Ruiz equilibration, ref Ruiz 2001) |
| `anderson.ts` | `AndersonAccelerator`, `makeAnderson` | Zhang-O'Donoghue-Boyd 2018 / Walker-Ni 2011 (ADR-0036) |
| `scs.ts` | `SCSOpts`, `SCSResult`, `scsSolve` | O'D 2016 §3.2.3 (iteration eq 17), §3.3 (over-relaxation), §3.4 (init), §4.1 (SMW subspace solve) |

## See also

- `docs/adr/0030-convex-cone-solver-tier.md` — the tier design.
- `docs/adr/0036-anderson-acceleration-cone-tier.md` — the AA decision.
- `docs/ground-truth/convex/scs-algorithm.md` — the SCS algorithm transcription.
- `docs/ground-truth/convex/cone-projections.md` — the SOC + PSD projection transcription.
- `docs/ground-truth/convex/anderson-acceleration.md` — the AA transcription.
- `docs/worklog/112-cone-core-lp-slice.md` — the v0.1 LP-complete slice.
- `docs/worklog/113-cone-solve-and-acceleration.md` — `cone-solve` + scaling + AA.
- `@workbench/linalg-core` — the `Matrix` + LU substrate this builds on.
