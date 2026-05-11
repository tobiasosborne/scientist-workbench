# @workbench/simplex-q

Exact-rational revised two-phase simplex method over ℚ. The substrate of
`tools/lp-solve` (ADR-0031). Pure TypeScript, BigInt rationals
throughout, no float64 on the hot path.

## What the package does

Solves linear programs of the form

```
minimise  cᵀ x
subject to  A x = b
            x ≥ 0
```

with `c`, `A`, `b` given over the rationals (`Rat` from
`@workbench/cas-core`). The output is a discriminated union — `optimal`
with primal/dual/slack/basis, `infeasible` with a Farkas certificate,
`unbounded` with a recession ray, `iter-cap` if the pivot budget is
exhausted, or `coefficient-explosion` if the rational basis-inverse
bit length blows past the configured cap.

Every operation is exact rational arithmetic. There are no tolerances,
no `ε`-comparisons, and no numerical drift. Bland's anti-cycling rule
has a genuine termination proof — not "terminates with high
probability." Degeneracy is exact (the leaving ratio is *exactly* zero
or it isn't). LP duality holds bit-exactly: `cᵀ x = bᵀ y` at every
optimum.

The trade-off: each pivot operates over ever-growing rationals, so the
substrate is fast on small problems (n ≤ ~30) and slow on large ones
(n ≥ ~50). Pathological inputs hit the `coefficient-explosion` refusal
envelope. For larger LPs the workbench's float-engine lane
(`tools/lp-solve-fast`, bead `hnyu`) is the natural successor.

## Public API

```ts
import { simplexSolve, type StandardLP } from "@workbench/simplex-q";
import { makeRat } from "@workbench/cas-core";

const lp: StandardLP = {
  c: [makeRat(3n), makeRat(5n)],
  A: [[makeRat(2n), makeRat(1n)], [makeRat(1n), makeRat(2n)]],
  b: [makeRat(1n), makeRat(1n)],
};

const result = simplexSolve(lp);
if (result.status === "optimal") {
  console.log(result.x);           // [1/3, 1/3]
  console.log(result.objective);   // 8/3 — exactly
}
```

Public types and functions are re-exported from `src/index.ts`. Read
each module's header comment for the algorithm-level prose:

- `src/simplex.ts` — the two-phase orchestrator. Dantzig pricing with
  Bland-rule guard on degeneracy. Cite: Dantzig 1947, Bland 1977,
  Vanderbei *Linear Programming* 4th ed. Ch.6-8.
- `src/basis.ts` — explicit `B⁻¹` storage with O(m²) product-form
  rank-1 update on every pivot. Cite: Vanderbei §6.4.
- `src/rat-cmp.ts` — total order on `Rat` (`ratCompare`, `ratLt`,
  `ratIsPositive`); the comparison primitive `cas-core` doesn't ship.

## Tests

Unit tests live in `test/`:

- `rat-cmp.test.ts` — sanity on the comparison primitive.
- `basis.test.ts` — verifies `B · B⁻¹ = I` invariance across the
  rank-1 update via direct matrix-multiplication.
- `simplex.test.ts` — trivial LPs (1D, 2D, KKT residuals exactly
  zero), infeasibility with Farkas-certificate validation, primal
  unboundedness with ray-validation, Beale 1955 cycling instance
  (terminates under default policy AND under always-Bland), Klee-Minty
  cube, redundant-constraint silent drop.
- `negated-rows.test.ts` — exercises the row-negation path that
  normalises `b ≥ 0` for the Phase-1 initial basis.

```sh
bun test packages/simplex-q/
```

## Design references

- **ADR-0031** — the canonical design document for the engine and the
  exact-rational-interior-inside-float64-wire pattern.
- **ADR-0030** — the cone-solver tier this substrate sits inside.
- **CLAUDE.md Rules 1, 6, 7, 8, 10** — the workbench's discipline
  this package conforms to.

## What's not in this package

- Bartels-Golub LU update: deferred. The arbprec engine doesn't need
  the numerical-hygiene motivation B-G provides; we ship product-form
  rank-1 update and call it. If basis-inverse bit-length growth turns
  out to be the bottleneck in practice, a B-G or eta-file revision can
  slot in without changing the public surface.
- Float64 wire: that's the wire wrapper's job (`tools/lp-solve`).
- Cone vocabulary parsing: also the wire wrapper's job.
- Provenance / canonical-bytes I/O: `runTool`'s job, one level above.

## Status

v0.1 — shipped with `tools/lp-solve` on 2026-05-11. See worklog 090
for the build narrative and the frictions surfaced during the bench
grade-in.
