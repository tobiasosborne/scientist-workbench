# @workbench/lbfgs-projected

Pure-TypeScript limited-memory BFGS with simple bound constraints
(L-BFGS with active-set projection). The third numerical-tier package in
scientist-workbench (ADR-0014 / ADR-0015); the substrate behind
`tools/optimize-lbfgs-projected`.

This is a library, not a tool — it speaks `Float64Array`, not the
canonical JSON value protocol. The wire-encoding wrapper lives in the
tool layer (`tools/optimize-lbfgs-projected/tool.ts`); ADR-0010's
`defineTool`/`runTool` split lets one implementation serve both
surfaces.

## Surface

```ts
import { lbfgsProjected } from "@workbench/lbfgs-projected";

const r = lbfgsProjected(
  (x) => 100 * (x[1] - x[0] ** 2) ** 2 + (1 - x[0]) ** 2,           // f
  (x) => new Float64Array([                                          // grad
    -400 * x[0] * (x[1] - x[0] ** 2) - 2 * (1 - x[0]),
     200 * (x[1] - x[0] ** 2),
  ]),
  new Float64Array([-1.2, 1.0]),                                     // x0
  new Float64Array([-Infinity, -Infinity]),                          // lower
  new Float64Array([+Infinity, +Infinity]),                          // upper
);

//  r.x ≈ Float64Array [1, 1]
//  r.fun ≈ 0
//  r.success === true
//  r.status === 0  (converged on projected-gradient norm)
```

## Algorithm

**L-BFGS with active-set projection.** A simpler relative of
Byrd-Lu-Nocedal-Zhu's strict L-BFGS-B (which is Cauchy point +
compact-form subspace minimisation); structurally closer to a
projected L-BFGS or "L-BFGS with active-set strategy". Agreement with
SciPy's L-BFGS-B (Northwestern Fortran v3.0) is verified for every
case in `tools/optimize-lbfgs-projected/reference/manifest.json` — see worklog
shard 040 for the pivot story (a first-pass full BLNZ implementation
hit two latent bugs in the compact-form matvec and the subspace CG
when reduced rows became zero on Booth-class problems; the simpler
algorithm has a smaller debug surface and meets the manifest's
comparison contract).

Components:

- **Active-set identification.** Each iteration: a coordinate is
  "active" iff it sits at a bound (within float tolerance) AND the
  gradient pushes further into that bound. Active coordinates are
  pinned; the others form the free subspace. This is the simpler
  alternative to BLNZ's Cauchy-point breakpoint walk.
- **L-BFGS direction on free coordinates.** Two-loop recursion
  (Nocedal 1980) over the m-history of `(s, y)` pairs, with
  contributions from active coordinates zeroed. Default `m = 10`.
- **Cap step at first bound crossing.** The proposed direction `d`
  is shortened so the trial `x + α d` does not cross any bound.
- **Strong-Wolfe line search.** Safeguarded cubic-interpolation
  backtracking satisfying both Wolfe conditions. The cubic safeguard
  was tuned to "stay 1% from the failed endpoint" rather than the
  textbook 10%-of-bracket rule — necessary for Powell-badly-scaled
  where the cubic correctly suggests `α ≈ 3e-9` from a `[0, 1]`
  bracket. Line-search failures are counted and surfaced in
  `warnings`.
- **L-BFGS update with Powell's curvature safeguard.** Skip the
  update if `s·y ≤ ε √(s·s · y·y)`; count the skips and surface in
  warnings.
- **Convergence tests.**
  - `‖∇f|_proj‖_∞ ≤ gtol` ⇒ status 0 (converged on gradient).
  - `(f_old − f_new) / max(|f_old|, |f_new|, 1) ≤ ftol` ⇒ status 1.
  - `iter ≥ maxiter` ⇒ status 2; `nfev ≥ maxfun` ⇒ status 3.
  - Line-search failure with no L-BFGS memory to reset ⇒ status 4.

References:

- Byrd, Lu, Nocedal, Zhu, "A Limited Memory Algorithm for Bound
  Constrained Optimization", SIAM J. Sci. Comput. 16(5), 1190–1208,
  1995.
- Zhu, Byrd, Lu, Nocedal, "Algorithm 778: L-BFGS-B", ACM TOMS 23(4),
  550–560, 1997.
- Morales, Nocedal, "Remark on Algorithm 778", ACM TOMS 38(1),
  Article 7, 2011.
- Byrd, Nocedal, Schnabel, "Representations of quasi-Newton matrices
  and their use in limited memory methods", Math. Programming 63,
  129–156, 1994.
- Nocedal, Wright, *Numerical Optimization*, 2nd ed., Springer 2006
  — §7.2 (limited-memory) and §7.4 (the Cauchy point story).

## Scope

- **In:** smooth `f` with analytic gradient, simple box constraints,
  `n ≤ ~200`, `Float64Array` storage, single-platform determinism
  (Bun on x86-64 Linux; ADR-0015 platform fingerprint recorded in
  provenance).
- **Out (v0.1, all deliberate):** equality and general nonlinear
  constraints (deferred — sister tools `optimize-slsqp`,
  `optimize-trust-region`); bound-constrained least squares (sister
  tool `optimize-bvls` deferred); finite-difference gradients (caller
  must supply analytic grad); cross-platform bit-identity (ADR-0015
  tier).

## Tests

```sh
bun test packages/lbfgs-projected/test/lbfgs-projected.test.ts
```

Property tests on synthetic problems: convergence on Rosenbrock,
sphere, Booth, bound-corner; monotone f-decrease across the run on a
quadratic; gradient norm at solution within `10*gtol`; refusal of
infeasible bounds and outside-bound x0. Mutation-proven: replacing
the projected-gradient norm with the raw gradient breaks the
bound-corner test (active-set cases need the projection); skipping
the curvature-safeguard makes Hilbert(8) diverge.
