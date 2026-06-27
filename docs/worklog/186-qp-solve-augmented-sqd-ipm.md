# 186 — tools/qp-solve: convex QP via augmented-SQD Mehrotra IPM (closes `psuw`)

**Date:** 2026-06-27.
**Bead:** `scientist-workbench-psuw` — *tools/qp-solve: best-in-class QP
specialist (Mehrotra IPM with Q-block in KKT)* — Phase-3 specialist of
the convex-cone epic `eg9j` (ADR-0030 §B).
**Ground truth:** `docs/ground-truth/convex/qp-ipm.md` (authored this
session), decision record `docs/adr/0044-qp-solve-augmented-sqd-ipm.md`.

## Context

The cone tier (ADR-0030) had `lp-solve`, `cone-solve`, `sdp-solve`, and
the `@workbench/solver-ipm` substrate, but no QP specialist. `qp-solve`
is the tool an agent reaches for once it has *classified* its problem as
a convex QP and wants accuracy past `cone-solve`'s 1e-6 ceiling. The
algorithm spec (psuw): Mehrotra predictor-corrector IPM with the
quadratic `Q` folded into the KKT system, ceiling 1e-10, plus the
QP-only `active_set` output.

The work was orchestrated in five phases (understand → design panel →
implement → adversarial review → gate), each a fan-out of subagents over
the main-thread orchestrator.

## What changed

**The design decision (3+1 panel).** The QP Newton step reduces to a
saddle system whose (1,1) block is `Q + X⁻¹S` — dense, so the LP path's
normal-equations Schur reduction is unavailable, and forming
`A(Q+X⁻¹S)⁻¹Aᵀ` would **square the conditioning** (`≈1e20` at the 1e-10
target). Three independent advocate-specs (nested-Schur / SQD signed-
Cholesky / Bunch-Kaufman) were scored; the augmented **symmetric
quasidefinite** system factored by a **static-order signed-Cholesky
LDLᵀ** won: it keeps `cond ≈ 1/μ` (√ of normal-equations), and its
identity-order factorization (Vanderbei 1995 — no pivot search) gives a
`numerical: true` determinism contract with *zero* pivot-determinism
surface. Bunch-Kaufman's own advocate conceded SQD gets ~90% of its
robustness at half the code; BK is the documented v0.2 promotion path
(`ysup`). Kernel correctness was de-risked with a standalone prototype
(machine-precision solve of a 1e16-dynamic-range augmented system) before
the ~1.1k-LOC build.

**The engine** (`packages/solver-ipm/src/`): `linalg/SignedLdlt.ts` (the
no-sqrt sign-checked sibling of `choleskyInPlace` + its triangular
solve); `problem/QpProblem.ts` (the dense QP shape + symmetrize-on-decode
+ `symMatVec`); `solver/QpKktAssembler.ts` (static augmented pattern +
per-iter diagonal refresh + the IR residual matvec); `solver/Signed
Regularization.ts` (the **signed** two-tier Friedlander-Orban scheme,
`−ρ` primal / `+δ` dual, with the kernel's failing-row index as the
*exact structural* block diagnosis — no row-norm heuristic); `solver/
QpResiduals.ts`, `QpConvergence.ts`, `QpDirection.ts`, `QpIterate.ts`,
`QpSolver.ts` (the Mehrotra loop). Built additively — the LP/SDP exports
are byte-untouched (ADR-0012 blast-radius discipline).

**The tool** (`tools/qp-solve/`): the cone-tier wire with `Q` required
and the `active_set` output added; PSD validation via `linalg-core`
`eigh`; six tagged refusal classes; `numerical: true`; 11 examples/
goldens; a `--test` smoke probe asserting the optimum, the `active_set`,
`achieved_precision` honesty, and the non-optimal absent-field contract.

## Why these choices

**Augmented over normal-equations is the load-bearing call.** qp-solve
exists *for* the 1e-10 ceiling; a path that floors at 1e-7 on the
ill-conditioned tail (which condition-squaring does) defeats its premise.
The in-tree witness is `linalg/IterativeRefinement.ts`: the LP normal-
equations Schur stalls at `pInf ≈ 1.26e-7` on `hinf2` at `cond ≈ 1e13`.

**SQD static factorization over Bunch-Kaufman is a determinism call.**
For a `numerical: true` tool, a pivot-search-free factorization whose
order depends only on `(n,m)` is bit-identical by construction — a
materially stronger contract than BK's data-dependent pivoting.

## Frictions surfaced

- **IR was specced in the ground truth but not wired in the first
  implementation pass.** The Phase-4 adversarial review (4 lenses) caught
  it across two independent lenses: `qp-ipm.md §6` and ADR-0044 described
  iterative refinement as implemented and *load-bearing for the 1e-10
  ceiling*, but `solveQpNewton` did a single solve and the IR residual
  kernel `symMatVecN` was dead code — a Law-2 ground-truth/impl
  divergence on a headline claim. Resolved by **implementing** the IR
  (trial/rollback toward the proximal target `K0`, mirroring
  `solveWithIR`) rather than downgrading the doc: the senior call, since
  the augmented system's √-conditioning is precisely what gives IR the
  headroom to recover the last digits. On the well-conditioned oracles
  the single solve was already at machine precision, so IR no-ops there
  (the optimal goldens are unchanged); it earns its keep on the
  ill-conditioned tail.
- **A false mutation-proof claim.** The first test header asserted that
  perturbing the Mehrotra corrector second-order term drives the tests
  RED. The review *empirically refuted* this: the corrector is a
  convergence accelerator, not a KKT-fixed-point determinant, so every
  residual/oracle test stays green under a corrector sign flip (it only
  inflates the iteration count, ~11→19 on the coupled-Q case). Corrected
  the claim and added a dedicated iteration-count guard that *is*
  sensitive to it.
- **Incomplete KKT certificate in tests.** `kkt()` computed `minx`/`mins`
  but no test asserted `x ≥ 0` / `s ≥ 0`; complementarity alone does not
  certify optimality. Added the nonnegativity legs to every oracle test
  (the `expectKkt` helper).
- **Determinism cracks vs the ADR's categorical claims.** The ported LP
  convergence carried a wall-clock `time-limit` branch and a `dual-
  feasible→optimal` mapping; both contradict a `numerical: true` /
  honest-status contract. Removed both from the QP path (deterministic
  iteration cap only; `optimal` requires genuine primal feasibility).
- **Infeasibility certificates are LP-ported, not QP-re-derived.** The
  Farkas-style `> huge` thresholds use objectives that now carry
  `±½xᵀQx`; some hard infeasible instances (inconsistent `m>n`) surface
  as `iter-cap` rather than `infeasible` — conservative (false-negative),
  never wrong-valued. Documented honestly (Rule 8) in the tool header and
  `qp-ipm.md §7`; v0.2 follow-up filed.
- **Acceptance is bench-gated externally.** The 120/138 Maros-Mészáros
  gate (psuw) needs the unbuilt `j34c` corpus + commercial Gurobi/Mosek/
  COPT witnesses, unavailable here. v0.1 ships verified by the analytic-
  oracle regime instead (depth over breadth); the Maros gate stays the
  documented remaining acceptance line on `j34c`.

## Acceptance

- `bun test packages/solver-ipm/test/qp.test.ts`: **16 pass / 0 fail**
  (100 assertions) — 5 analytic oracles with complete KKT certs
  (KKT residuals 1e-13…1e-17), the 5-class termination taxonomy
  (infeasible / unbounded / iter-cap / m>n / rank-deficient), the
  corrector-sensitivity guard, a random-PSD-Q cross-check against an
  independent dense KKT solve, the LP-reduction cross-check vs `solveLp`,
  and determinism on both a well-conditioned and an ill-conditioned
  (reg-bump) instance.
- `bun tools/qp-solve/tool.ts --test`: passes (optimum, active_set,
  achieved_precision, absent-field contract).
- `bun run check`: green (see commit) — typecheck, the four codegen
  drift phases (catalog, folded goldens, per-tool READMEs, typed barrel),
  workspace tests, the per-tool `--test`, and the oracle over the 11
  qp-solve goldens.

## Pointers

- Kernel: `packages/solver-ipm/src/linalg/SignedLdlt.ts`.
- Driver + IR: `solver/QpSolver.ts`, `solver/QpDirection.ts`
  (`ldltSolveRefined`).
- Signed reg: `solver/SignedRegularization.ts`.
- Tool: `tools/qp-solve/tool.ts`.
- Ground truth / decision: `docs/ground-truth/convex/qp-ipm.md`,
  `docs/adr/0044-qp-solve-augmented-sqd-ipm.md`.
- Follow-ups: `ysup` (BK promotion), the infeasibility-certificate v0.2
  bug, `j34c` (Maros corpus, the bench gate).
