# ADR-0044 — `tools/qp-solve`: augmented SQD Newton step via static signed-Cholesky LDLᵀ

**Status:** Accepted — 2026-06-27.
**Beads:** `scientist-workbench-psuw` (the qp-solve v0.1 specialist this ADR
records the design of); `scientist-workbench-ysup` (the documented
v0.2 promotion path — SQD → Bunch-Kaufman LDLᵀ, see §C); blocked-on
`scientist-workbench-j34c` (the Maros-Mészáros corpus bench + commercial
triple-witness adapters that gate the 120/138 breadth acceptance — see
Consequences).
**Authors:** tobiasosborne + Claude (a 3+1 design panel: three
independent research subagents on the Newton-step factorization, plus
the convergence pass — the `Sturm.jl`/`Bennett.jl` pattern, CLAUDE.md
Rule 4).
**Related:** ADR-0030 (the convex-cone solver tier — §B names `qp-solve`
the Phase-3 QP specialist with a `1e-10` accuracy ceiling and an
`active_set` extra output; §E sets the port-from-paper discipline); ADR-
0015 (the `numerical: true` determinism tier — inherited verbatim); ADR-
0032 (the LP Mehrotra substrate in `@workbench/solver-ipm` this strictly
generalises); ADR-0033 (the sibling HSDE work whose
`IterativeRefinement.ts` carries the in-tree evidence for §B); ADR-0003
(the three output categories — the refusal envelopes in §7 of the ground
truth); CLAUDE.md Rules 1, 2, 8 (fail loud, all bugs are deep, honest
scope — the binding rules behind the regularization-as-proximal-step and
the no-pivot-search choices here).

## Context

The convex-cone solver tier (ADR-0030 §B) is a universal primary
(`cone-solve`, SCS-ADMM, `1e-6` ceiling) flanked by structure-aware
specialists. `tools/qp-solve` is the **Phase-3 QP specialist**: the
best-in-class path an agent reaches for once it has already classified
its problem as a convex quadratic program

```
minimise   ½ xᵀ Q x + cᵀ x
subject to Ax = b,  x ≥ 0          (Q ⪰ 0)
```

and wants the `1e-10` accuracy that `cone-solve`'s first-order method
cannot deliver, plus the `active_set` certificate that only makes sense
for QP (the analogue of LP's vertex basis, SDP's dual matrix). The QP
solver core ports a Mehrotra primal-dual predictor-corrector
interior-point method, built **additively on the LP Mehrotra IPM already
in `@workbench/solver-ipm`** (`Solver.ts`, `Direction.ts`,
`StepLength.ts`): the LP path is the `Q = 0` special case, and the QP
code is a strict, tested-against generalisation of it (ground truth
§§2-3, 6).

The algorithm itself — Mehrotra predictor-corrector on the perturbed KKT
system — is canonical and uncontested. What the 3+1 design panel
contested, and what this ADR records, is the **one load-bearing
engineering decision the LP precedent does not settle for us**: *how the
Newton step factors the KKT system at the `1e-10` ceiling.* The LP path
reduces to the `m × m` normal-equations Schur complement and factors it
with a uniform-positive Cholesky; neither of those survives the QP at
`1e-10`. The decision below is transcribed from the math in
[`docs/ground-truth/convex/qp-ipm.md`](../ground-truth/convex/qp-ipm.md)
(§§3-6, the augmented-system reduction, the static signed-Cholesky
kernel, and the signed regularization), which is itself a from-paper
transcription per ADR-0030 §E — derived from Nocedal-Wright Ch.16,
Wright 1997 §11, Mehrotra 1992, Vanderbei 1995, Friedlander-Orban 2012,
and Gill-Saunders-Shinnerl 1996, never from `OOQP`/`LOQO`/`OSQP` source.

**The decision in one sentence.** `tools/qp-solve` factors the Newton
step by reducing the perturbed KKT system to the **regularized augmented
(KKT-condensed) saddle system**, not the normal equations, and factors
that system as a **symmetric quasidefinite (SQD)** matrix via a
**static-order (pivot-search-free) signed-Cholesky `LDLᵀ`**.

## Decision

### A. Tier and architecture: a `numerical: true` Phase-3 specialist on the `solver-ipm` substrate

`tools/qp-solve` carries `numerical: true` (ADR-0015): bit-identical
output given the platform fingerprint `{arch, os, runtime}`, with cross-
platform divergence surfaced in the provenance `platform` field (written
when the output carries float64 leaves) and `runMemoized` cache hits
dropped on a platform mismatch. It is the Phase-3 QP specialist of the
cone tier (ADR-0030 §B), with the tier's two extra contracts: the
`--precision` dial drives the tolerance triple, and `--max-iter` is a
standard flag. Its **accuracy ceiling is `1e-10`** — four decades past
`cone-solve`'s `1e-6` — and that ceiling is the whole reason the tool
exists; every decision below exists to defend it. The structural extra
output is `active_set` (ground truth §8): the active inequality indices
with their KKT multipliers `s_i ≥ 0`, plus the equality duals `y`,
forming the reduced-KKT certificate `Qx + c − Aᵀy = s` with
`s_active ≥ 0`, `s_inactive = 0`.

The solver core extends `@workbench/solver-ipm`'s LP Mehrotra IPM with
the `Q`-block, in new `Qp*` modules
(`QpResiduals.ts`/`QpKktAssembler.ts`/`QpDirection.ts`/`QpIterate.ts`/`QpSolver.ts`)
plus the SQD kernel (`packages/solver-ipm/src/linalg/SignedLdlt.ts`).
The changes against the LP path are confined to two places: the residual
layer gains the `Qx` term (`r_d = Qx + c − Aᵀy − s`), and the matrix
factored each iteration is the augmented `K` of §B, not the LP Schur.
Everything else — `StepLength.ts`'s fraction-to-boundary rule, the
`σ = (μ_aff/μ)³` centering, the safeguarded separate-primal/dual step,
the stall detector, the initial point — reuses byte-identically (ground
truth §6).

### B. The augmented system, not the normal equations — the load-bearing decision

One Newton step solves the 3×3 block KKT system (Nocedal-Wright eq.
16.57, QP form). Eliminating `Δs` from the complementarity row collapses
it to the **augmented (KKT-condensed) saddle system** whose (1,1) block
is `Q + X⁻¹S` (ground truth §3, eq. ★):

```
[ −(Q + X⁻¹S)   Aᵀ ] [Δx]   [ r_d + X⁻¹ r_c ]
[      A         0 ] [Δy] = [    −r_p        ]
```

On the strict interior `X, S > 0` and `Q ⪰ 0`, so `Q + X⁻¹S` is
symmetric positive definite; the (1,1) block is symmetric negative
definite and the (2,2) block is `0`.

The LP path (`Direction.ts`) goes one elimination further, reaching the
`m × m` normal-equations Schur complement `M = A(X⁻¹S)⁻¹Aᵀ`. That extra
step is **only available because `Q = 0` makes the (1,1) block
diagonal** and trivially invertible. For QP the Schur form is *formally*
possible — `M = A(Q + X⁻¹S)⁻¹Aᵀ` — but it **squares the conditioning**.
Near the optimum `X⁻¹S` spans `≈ μ … 1/μ` (dynamic range `≈ 1/μ²`);
folding that through `A(·)Aᵀ` gives `cond(M) ≈ cond(K)²`. At a `1e-10`
complementarity target that is `≈ 1e20`, past float64's `≈ 1e16`
mantissa — **the assembly destroys information no back-end refinement
can recover.** The augmented system (★) keeps `cond(K) ≈ 1/μ`, the
**√ of the normal-equations conditioning** (Forsgren-Gill-Shinnerl 1996,
Wright 1997 §11.2), which is the only regime with float64 headroom for
the `1e-10` ceiling.

This is not a theoretical worry; it is the **measured in-tree failure
mode of the very mechanism the Schur form would inherit**. The HSDE LP
and NT-SDP solvers in this same package go the normal-equations route,
and
[`packages/solver-ipm/src/linalg/IterativeRefinement.ts:15-18`](../../packages/solver-ipm/src/linalg/IterativeRefinement.ts)
records the consequence verbatim: on NETLIB `hinf2` the Schur condition
number reaches `~1e13` (verbose trace `Mdiag=[4.8e+7, 1.0e+13]`) and the
back-substitution **stalls the whole solver at `pInf ≈ 1.26e-7` from
iter ~36 onward** — four orders short of the QP target. The augmented
system starts the iterative refinement from `cond ≈ 1e10` instead of
`1e20`, so IR converges to `1e-10` rather than stalling at `1e-7`
(ground truth §6, "Iterative refinement"). **This is the load-bearing
design decision of `qp-solve`.**

A consistency anchor falls out for free: setting `Q = 0` in (★) recovers
the LP augmented system exactly, and eliminating `Δx` reproduces the LP
`Direction.ts` normal-equations solve byte-for-byte. So `qp-solve`
restricted to `Q = 0` must reproduce the LP solver's trajectory — a
tested invariant (ground truth §3 "Q = 0 cross-check", oracle O3).

### C. Static signed-Cholesky over Bunch-Kaufman — zero pivot-determinism surface

Regularize (★) to the SQD matrix `K` (`N = n + m`):

```
K = [ −(Q + X⁻¹S) − ρ I_n        Aᵀ      ]
    [        A                 + δ I_m   ]
```

with `ρ, δ > 0`. The (1,1) block is symmetric negative definite, the
(2,2) block symmetric positive definite — the definition of **symmetric
quasidefinite** (Vanderbei 1995). Vanderbei's theorem: an SQD matrix has
a stable `LDLᵀ` factorization with diagonal `D` for **every** symmetric
permutation, in particular the identity. So the natural order `0 … N−1`
is always stable — **no pivot search.** `D` carries a known sign
pattern: `D_jj < 0` for the x-block `j < n`, `D_jj > 0` for the y-block
`j ≥ n`; Gill-Saunders-Shinnerl 1996 bounds the backward error by
`cond(K)` and the regularization ratio rather than by pivot-search
element growth.

The kernel `signedLdltInPlace(K, N, n, tmp)` is the no-`sqrt` sibling of
the existing `choleskyInPlace` (Golub-Van Loan Alg. 4.1.2, in-place
outer-product `LDLᵀ`; ground truth §4). Because the factorization order
is a function of the **integers `(n, m)` only** — it reads no float64
value — the `numerical: true` contract holds with **zero
pivot-determinism surface**. This is the cleanest possible fit for
bit-identical reproducibility, and it is the deciding argument over the
panel's strongest competitor.

That competitor was a **Bunch-Kaufman partial-pivoting `LDLᵀ`** (1×1/2×2
blocks). BK is the most general and robust symmetric-indefinite factor —
it handles true indefiniteness and an *unregularized* (2,2) = 0 block
with no lift, and the panel scored it a 9 on robustness. But all of that
generality is **unused on convex QP**: with `Q ⪰ 0`, `X, S > 0`, and the
dual regularization of §D, `K` is *strictly* quasidefinite, so the SQD
theorem applies and the extra BK machinery never engages. What BK *does*
introduce is **data-dependent pivoting** — its 1×1-vs-2×2 block choice
reads float64 values — which is the largest determinism surface among
all candidate paths. Trading a guaranteed-stable static factorization
for data-dependent pivoting we would then have to canonicalise
(frozen `α = (1+√17)/8`, smallest-index tie-break) buys robustness the
convex problem cannot use, at a determinism cost the contract cannot
afford. The panel's own BK advocate conceded that SQD reaches **~90% of
the robustness at half the code with zero pivot-determinism surface**;
v0.1 ships SQD. BK is the **documented future-promotion path** (bead
`scientist-workbench-ysup`): the trigger is a real bench instance where
the SQD assumption genuinely fails (a block loses definiteness even with
the signed proximal lift at its cap) or where the `ρ0, δ0` proximal bias
caps achievable accuracy short of `1e-10` on an otherwise-solvable
problem.

### D. Signed two-tier regularization — Friedlander-Orban, not uniform Tikhonov

The existing uniform-positive Tikhonov (`factorWith3Way`, which adds a
single `+δI` to every diagonal via `choleskyInPlace`'s `jitter` arg) is
**wrong for the saddle**: a uniform `+δ` pushes the *negative* x-block
pivots toward zero and destroys quasidefiniteness. The QP path needs a
**signed** scheme (ground truth §5):

```
K_reg = K0 + diag( −ρ · 1_n ,  +δ · 1_m )
```

i.e. **subtract** `ρ` from the first `n` diagonals (more negative) and
**add** `δ` to the last `m` (more positive). This is
**Friedlander-Orban 2012 primal-dual regularization**: `−ρ` on the
x-block is a proximal term `½ρ‖Δx‖²`, `+δ` on the y-block a proximal
term on the dual, so `K_reg` is the KKT matrix of a **nearby well-posed
QP** — a proximal step toward a problem we can solve, not a numerical lie
to apologise for (CLAUDE.md Rule 1: regularization that *means* something
beats a silent jitter that doesn't).

Two tiers, not three: the augmented form has exactly two definiteness
blocks, so two regularizers (`ρ` primal, `δ` dual) are the natural and
complete set — there is no "gap" tier, unlike the LP path's PRIMAL/DUAL/GAP
escalation. And the diagnosis is **structural and exact**: the kernel's
returned failing row `j` directly names the block — `j < n` ⇒ the
x-block lost its negative sign ⇒ bump `ρ`; `j ≥ n` ⇒ the y-block ⇒ bump
`δ`. **No row-norm heuristic** (`makeLpDiagnose`) is needed; the block
boundary `n` *is* the diagnosis, strictly cleaner than the LP path's
blind escalation. Base `ρ0 = δ0 = ρ_BASE · max(1, ‖diag K0‖∞)` with
`ρ_BASE ∈ [1e-12, 1e-8]`, escalation `×10` per failing row, capped
(`ρ_max = 1e-2`, `δ_max = 1e+2`), exhaustion ⇒ a loud `numerical-error`
status (Rule 1), never a wrong-shaped answer.

### E. Determinism: a static order is a function of `(n, m)`, nothing more

`numerical: true` (ADR-0015) holds with the platform fingerprint, and
the `platform` field is written precisely when the output carries float64
leaves (the per-output tier-conditioning of ADR-0007). The contract is
*stronger* here than the rule's floor because the factorization order is
a pure function of the integer shape `(n, m)`:

- The factorization order reads no data — it is the identity permutation
  on `0 … N−1` (§C). There is no pivot search, hence no data-dependent
  control flow inside the factor.
- The only data-dependent control flow in the whole solver is the
  regularization retry (§D, a deterministic function of the float64
  failing-row index) and the iterative-refinement accept/reject (a
  deterministic trial against `K_target` with a fixed comparison). Both
  are deterministic functions of the float64 input with fixed
  comparison tolerances derived from `--precision` — no implicit-zero
  `if (x > 0)` gates (the tier rule from ADR-0030's determinism table).
- No RNG, no wall-clock, no parallel reduction. The kernel's inner
  `k`-loops accumulate in fixed ascending index order, so float64
  rounding is reproducible (ground truth §4).

## Why rejected alternatives

**(A) Nested SPD Schur — `M = A · G⁻¹ · Aᵀ` with `G = Q + X⁻¹S`.**
The maximal-reuse option: it inherits the LP path's `SchurAssembler`,
Cholesky, and three-way regularizer almost verbatim, and on
well-conditioned QP it is genuinely faster (an `m × m` dense factor
vs the augmented `(n+m) × (n+m)`). It was the leading candidate on code
reuse. Rejected because it **squares the conditioning** (§B): `cond(M) ≈
cond(K)² ≈ 1e20` at the `1e-10` target, past float64. The in-tree
evidence is not hypothetical — the HSDE solvers that take exactly this
route floor at `pInf ≈ 1.26e-7` on `hinf2` at `cond(M) ~ 1e13`
(`IterativeRefinement.ts:15-18`). A `qp-solve` that floors at `~1e-7` on
the ill-conditioned / `m > n` tail has no reason to exist next to
`cone-solve`'s `1e-6` — it would defeat its own raison d'être. Reuse is
not worth the four decades.

**(C) Bunch-Kaufman partial-pivoting `LDLᵀ`.** The most general and
robust symmetric-indefinite factor (panel robustness score 9): it needs
no quasidefiniteness assumption, handles true indefiniteness and an
unregularized (2,2) = 0 block with no lift. Rejected for v0.1 because
its generality is **unused on convex QP** (the regularized `K` is
strictly quasidefinite, so SQD's static factor is already provably
stable) while its **data-dependent 1×1/2×2 pivoting is the single
largest determinism surface** among the candidates — exactly the thing
`numerical: true` is least willing to pay for. The panel's BK advocate
conceded SQD reaches ~90% of the robustness at half the code with zero
pivot-determinism surface; ship SQD first, promote to BK only when a
real instance demands it (bead `scientist-workbench-ysup`).

## Consequences

### Honest costs

1. **The `ρ0, δ0` knife-edge.** Too small and the factor fails the sign
   guard and triggers a retry; too large and the proximal bias caps
   achievable accuracy short of `1e-10`. Mitigated by the
   `ρ_BASE · ‖diag K0‖∞` scaling (so the base tracks the matrix norm)
   **and** by iterative refinement against the proximal target
   `K_target` (= `K0` at base `ρ0, δ0`, nonsingular because `δ0 > 0`),
   which recovers the final 2-3 digits the regularization spends —
   the same IR mechanism that breaks the LP normal-equations floor, but
   starting from `cond ≈ 1e10` so it converges rather than stalls
   (ground truth §6). If a real instance defeats this, that is the
   `scientist-workbench-ysup` BK-promotion trigger, not a tuning
   bandaid (Rule 2).

2. **A dense `(n+m)²` factor is heavier than the normal equations when
   `m ≪ n`.** The augmented system is larger than the `m × m` Schur, so
   when there are few constraints we pay an `O((n+m)³)` factor where the
   Schur form would pay `O(m³)`. This is fine at Maros-Mészáros sizes
   (dense storage comfortable, per ADR-0030's dense-from-v0.1 decision),
   and a **sparse SQD factor with a fill-reducing ordering is the
   documented future extension** — it lands additively without changing
   the wire schema (ADR-0030's "sparse as a transparent v0.2
   optimisation").

3. **The full breadth gate is externally blocked.** ADR-0030 §F sets the
   acceptance bar at **120/138 Maros-Mészáros cases** against a
   Gurobi/Mosek/COPT triple-witness. That corpus and its commercial
   witness adapters live in `scientist-workbench-corpus` and are tracked
   by bead `scientist-workbench-j34c`, which is **not yet shipped** —
   `j34c` explicitly `BLOCKS` `psuw`'s Phase-3 gate. So **v0.1 ships
   verified by analytic oracles instead** (ground truth §9, the
   O1-O5 closed-form table: unconstrained `x* = −Q⁻¹c`,
   equality-constrained KKT solve, the `Q = 0` LP-reduction cross-check
   against `tools/lp-solve`, the separable diagonal-Q box, and the
   single-binding-inequality case), with port-and-verify mutation-proofs
   (Rule 6) perturbing the `Qx` residual term, the corrector
   second-order term, and the kernel sign guard. The Maros breadth grade
   is gated on `j34c` and is a Phase-3 close-out item, not a v0.1
   blocker.

### Determinism contract (summary)

| property | `tools/qp-solve` |
|---|---|
| annotation | `numerical: true` (ADR-0015) |
| accuracy ceiling | `1e-10` (vs `cone-solve` `1e-6`, ADR-0030 §B) |
| bit-identical | given platform fingerprint `{arch, os, runtime}` |
| factorization order | identity permutation, function of `(n, m)` only — **no pivot search** |
| pivot-determinism surface | **zero** (the SQD-over-BK payoff, §C) |
| data-dependent control flow | regularization retry + IR accept/reject only — deterministic functions of float64 data, fixed comparisons |
| RNG / wall-clock / parallel reduction | none |
| `platform` field written | when output carries float64 leaves (ADR-0007 per-output conditioning) |

## References

- **Nocedal & Wright, *Numerical Optimization* (2e, 2006), Ch. 16** —
  §16.6 interior-point QP, Algorithm 16.4 (the predictor-corrector loop
  ported in ground truth §6); eq. 16.57 (the Newton block system) and
  eq. 16.60 (the duality gap `xᵀs`).
- **S. J. Wright, *Primal-Dual Interior-Point Methods* (SIAM, 1997)** —
  §11 (infeasible-start Mehrotra), §11.2 (the augmented-system vs
  normal-equations stability argument that grounds §B).
- **Mehrotra (1992)**, *On the Implementation of a Primal-Dual
  Interior-Point Method*, SIAM J. Optim. 2(4):575-601 — the affine /
  `σ = (μ_aff/μ)³` / second-order corrector heuristic (§A).
- **Vanderbei (1995)**, *Symmetric Quasidefinite Matrices*, SIAM J.
  Optim. 5(1):100-113 — the SQD theorem that licenses the static
  pivot-search-free signed-Cholesky (§C).
- **Friedlander & Orban (2012)**, *A primal-dual regularized
  interior-point method for convex quadratic programs*, Math. Prog.
  Comp. 4:71-107 — the signed `(−ρ, +δ)` primal-dual regularization as a
  proximal step (§D).
- **Gill, Saunders & Shinnerl (1996)**, *On the stability of Cholesky
  factorization for symmetric quasidefinite systems*, SIAM J. Matrix
  Anal. 17(1):35-46 — the backward-stability bound for the static SQD
  factor (§C).
- The math transcription: **[`docs/ground-truth/convex/qp-ipm.md`](../ground-truth/convex/qp-ipm.md)**
  (§§1-10) — the from-paper port (ADR-0030 §E) of everything above.

## Pointers

- Ground truth: [`docs/ground-truth/convex/qp-ipm.md`](../ground-truth/convex/qp-ipm.md)
  — §3 (augmented reduction ★), §4 (the `signedLdltInPlace` /
  `ldltSolveInPlace` kernel), §5 (signed regularization), §6 (the
  Mehrotra loop + IR), §8 (`active_set`), §9 (analytic oracle table).
- In-tree evidence for §B: [`packages/solver-ipm/src/linalg/IterativeRefinement.ts:15-18`](../../packages/solver-ipm/src/linalg/IterativeRefinement.ts)
  — the `hinf2` normal-equations Schur stall at `pInf ≈ 1.26e-7`,
  `cond ~ 1e13`.
- The LP precedent this generalises: `packages/solver-ipm/src/solver/{Solver,Direction,StepLength,Regularization}.ts`
  (ADR-0032); the wrong-for-a-saddle uniform-positive `factorWith3Way`
  contrasted in §D lives in `Regularization.ts`.
- Tool + core (to be authored under `psuw`):
  `tools/qp-solve/tool.ts` (wire layer, PSD validation, `active_set`,
  refusals); `packages/solver-ipm/src/linalg/SignedLdlt.ts` (the kernel);
  `packages/solver-ipm/src/solver/Qp{KktAssembler,Residuals,Direction,Iterate,Solver}.ts`.
- ADR-0030 §B (the specialist's place in the tier, the `1e-10` ceiling,
  the `active_set` output) and §E (port-from-paper); ADR-0015 (the
  `numerical: true` contract inherited verbatim).
- Future-promotion path: bead `scientist-workbench-ysup` (SQD →
  Bunch-Kaufman). Breadth gate: bead `scientist-workbench-j34c`
  (Maros-Mészáros corpus + triple-witness), blocking `psuw`.
