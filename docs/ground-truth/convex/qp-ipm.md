# Ground truth — convex QP via a primal–dual interior-point method

Primary sources (textbook; the QP IPM is canonical and derivable from
first principles — per CLAUDE.md Law 1 + ADR-0030 §E the port derives
**from these papers/books, never from `OSQP.c` / `LOQO` / `OOQP`
source**):

- **Nocedal & Wright, *Numerical Optimization* (2e, 2006), Ch. 16**
  (quadratic programming) — esp. §16.6 *Interior-Point Methods* and
  Algorithm 16.4 (the predictor–corrector QP IPM).
- **S. J. Wright, *Primal-Dual Interior-Point Methods* (SIAM, 1997)** —
  §11 (infeasible-start Mehrotra), §11.2 (the augmented-system vs
  normal-equations choice and its stability).
- **Mehrotra (1992), *On the Implementation of a Primal-Dual
  Interior-Point Method*, SIAM J. Optim. 2(4):575–601** — the
  predictor–corrector heuristic (affine step, σ = (μ_aff/μ)³ centering,
  the second-order corrector term).
- **Vanderbei (1995), *Symmetric Quasidefinite Matrices*, SIAM J.
  Optim. 5(1):100–113** — the theorem that a symmetric quasidefinite
  (SQD) matrix has a stable `LDLᵀ` factorization for **every** symmetric
  permutation, so a **static (pivot-search-free)** signed Cholesky is
  backward-stable. This is the licence for the no-pivoting factorization
  the workbench needs for the `numerical: true` determinism contract.
- **Friedlander & Orban (2012), *A primal-dual regularized
  interior-point method for convex quadratic programs*, Math. Prog.
  Comp. 4:71–107** — the **primal–dual regularization** (−ρ on the
  primal block, +δ on the dual block) that makes the augmented KKT
  matrix quasidefinite and turns regularization from a "numerical lie"
  into a proximal step toward a nearby well-posed QP.
- **Gill, Saunders & Shinnerl (1996), *On the stability of Cholesky
  factorization for symmetric quasidefinite systems*, SIAM J. Matrix
  Anal. 17(1):35–46** — the backward-stability bound for the static SQD
  factorization (growth bounded by `cond(K)` and the regularization
  ratio, **not** by pivot-search element growth).

This file transcribes the algorithm `packages/solver-ipm`'s QP path
(`solveQp` and the `Qp*` modules) ports, and `tools/qp-solve` exposes.
The companion LP IPM already in-tree — `solveLp` in
`packages/solver-ipm/src/solver/Solver.ts`, its Newton-system literate
header in `Direction.ts`, the Mehrotra centering in `Solver.ts:277-289`,
and the step-length rule in `StepLength.ts` — is the **Q = 0 special
case** of everything below; the QP code is a strict, tested-against
generalisation of it.

---

## 1. The problem

Convex QP in standard form:

```
minimise   (1/2) xᵀ Q x + cᵀ x
subject to Ax = b
           x ≥ 0
```

with data `Q ∈ 𝕊ⁿ` symmetric positive semidefinite (`Q ⪰ 0`),
`A ∈ ℝ^{m×n}`, `b ∈ ℝᵐ`, `c ∈ ℝⁿ`. Convexity of the objective is
exactly `Q ⪰ 0`; a non-PSD `Q` makes the problem nonconvex and is
**out of honest scope** (refused — §7).

General bound/inequality forms reduce to this standard form the same way
the LP path reduces: a free variable `x_j ∈ ℝ` is split `x_j = x_j⁺ −
x_j⁻` (or, in a later iteration of the substrate, handled natively by
omitting its `X⁻¹S` term — see §3 note); an inequality `aᵀx ≤ β` becomes
`aᵀx + ξ = β, ξ ≥ 0` with a nonnegative slack. The standard form above
is what the solver core consumes; the tool wire layer performs the
reduction (mirroring `tools/lp-solve`'s free-variable split).

The **Lagrangian** with multipliers `y ∈ ℝᵐ` (equalities, free sign) and
`s ≥ 0` (the multipliers on `x ≥ 0`, i.e. the dual slacks):

```
L(x, y, s) = (1/2) xᵀQx + cᵀx − yᵀ(Ax − b) − sᵀx
```

---

## 2. KKT optimality and the central path

Because `Q ⪰ 0`, the first-order KKT conditions are **necessary and
sufficient** for global optimality:

```
(stationarity / dual feasibility)   Qx + c − Aᵀy − s = 0
(primal feasibility)                Ax = b
(nonnegativity)                     x ≥ 0,  s ≥ 0
(complementarity)                   x_i s_i = 0   ∀i   ⇔   XSe = 0
```

with `X = diag(x)`, `S = diag(s)`, `e = (1,…,1)ᵀ`. The interior-point
method replaces the hard complementarity `XSe = 0` by the **central-path**
relaxation `XSe = μe`, `μ > 0`, and drives `μ → 0`.

**Residuals** at a point `(x, y, s)` with `x, s > 0`:

```
r_d = Qx + c − Aᵀy − s          (dual residual,  length n)
r_p = Ax − b                    (primal residual, length m)
r_c = XSe − σμe                 (complementarity residual; predictor σ = 0)
```

`r_d` is the LP dual residual `c − Aᵀy − s` **plus the `Qx` term** — the
one change to the residual layer vs the LP path (`Residuals.ts:13-14`).
`μ = xᵀs / n`. Objectives gain the quadratic term:
`primalObj = cᵀx + (1/2)xᵀQx`, and the dual objective acquires the
matching `−(1/2)xᵀQx` so the **duality gap is `xᵀs`** as in the LP case
(the `(1/2)xᵀQx` cancels in `primalObj − dualObj` at a KKT point —
Nocedal–Wright eq. 16.60).

---

## 3. The Newton system and its augmented reduction

One Newton step `(Δx, Δy, Δs)` for the perturbed KKT system solves the
3×3 block system (Nocedal–Wright eq. 16.57, QP form):

```
[ Q   −Aᵀ  −I ] [Δx]   [ −r_d ]
[ A    0    0 ] [Δy] = [ −r_p ]
[ S    0    X ] [Δs]   [ −r_c ]
```

Eliminate `Δs` from the third block row (`S Δx + X Δs = −r_c`):

```
Δs = X⁻¹(−r_c − S Δx) = −X⁻¹ r_c − X⁻¹S Δx           (componentwise: Δs_j = (−r_c_j − s_j Δx_j)/x_j)
```

Substituting into the first block row collapses the system to the
**augmented (KKT-condensed) saddle system** whose (1,1) block is
`Q + X⁻¹S`:

```
[ −(Q + X⁻¹S)   Aᵀ ] [Δx]   [ r_d + X⁻¹ r_c ]
[      A         0 ] [Δy] = [    −r_p        ]      (★)
```

(Sign check: row 1 of the 3×3 is `QΔx − AᵀΔy − Δs = −r_d`; substituting
`Δs = −X⁻¹r_c − X⁻¹SΔx` gives `(Q+X⁻¹S)Δx − AᵀΔy = −r_d − X⁻¹r_c`, and
multiplying by `−1` yields the `−(Q+X⁻¹S)` block with RHS `r_d + X⁻¹r_c`.
The predictor `r_c = XSe` gives `X⁻¹r_c = s`, so the top RHS is `r_d + s`,
matching §6 step 3 and `QpDirection.ts`.)

with `X⁻¹S = diag(s_j / x_j)`. On the strict interior `X, S > 0` and
`Q ⪰ 0`, so `Q + X⁻¹S` is symmetric **positive definite**; hence the
(1,1) block of (★) is symmetric **negative definite** and the (2,2)
block is `0`. After the dual regularization of §4 the (2,2) block
becomes strictly positive definite and (★) is a symmetric
**quasidefinite** system.

**Why the augmented system, not the normal equations.** The LP path
(`Direction.ts`) goes one step further, eliminating `Δx` to reach the
`m×m` normal-equations Schur complement `M = A (X⁻¹S)⁻¹ Aᵀ`. That extra
elimination is only available because `Q = 0` makes the (1,1) block
diagonal. For QP it is *also* formally possible
(`M = A (Q + X⁻¹S)⁻¹ Aᵀ`), but it **squares the conditioning**: near the
optimum `X⁻¹S` spans `≈ μ … 1/μ` (dynamic range `≈ 1/μ²`), and folding
that through `A(·)Aᵀ` gives `cond(M) ≈ cond(K)²`. At a `1e-10`
complementarity target this is `≈ 1e20`, past float64's `≈ 1e16`
mantissa — the assembly destroys information no back-end refinement can
recover. The in-tree evidence is `IterativeRefinement.ts`'s header: on
NETLIB `hinf2` the LP normal-equations Schur reaches `cond ≈ 1e13` and
the solver **stalls at `pInf ≈ 1.26e-7`**, four orders short of `1e-10`.
The augmented system (★) keeps `cond(K) ≈ 1/μ` (the √ of the
normal-equations conditioning; Forsgren–Gill–Shinnerl 1996, Wright 1997
§11.2), which is the only regime with float64 headroom for the `1e-10`
ceiling that is `qp-solve`'s reason to exist (ADR-0030 §B). This is the
load-bearing design decision, recorded in the qp-solve ADR.

**Q = 0 cross-check (the consistency anchor).** Setting `Q = 0` in (★)
recovers the LP augmented system exactly; eliminating `Δx` then gives
`M Δy = r_p − A(X⁻¹S)⁻¹(r_d − X⁻¹r_c)`, byte-for-byte the LP
`Direction.ts` solve. So the QP solver restricted to `Q = 0` must
reproduce the LP solver's trajectory — a tested invariant (§8).

*Note on free variables.* A free `x_j` (no `x_j ≥ 0` bound) contributes
no `X⁻¹S` term to its (1,1) diagonal, leaving `−Q_jj − ρ` there; the
primal regularization `ρ > 0` (§4) keeps the block negative definite, so
free variables are admissible **without** the `x⁺ − x⁻` split and its
conditioning penalty. v0.1 of the tool still performs the split at the
wire layer for parity with `lp-solve`; native free-variable handling is
a documented follow-up.

---

## 4. Static signed-Cholesky LDLᵀ on the regularized SQD system

Regularize (★) to a **symmetric quasidefinite** matrix `K` (`N = n+m`):

```
K = [ −(Q + X⁻¹S) − ρ I_n        Aᵀ      ]
    [        A                 + δ I_m   ]
```

with `ρ, δ > 0`. The (1,1) block is symmetric negative definite, the
(2,2) block symmetric positive definite — the definition of a symmetric
quasidefinite matrix. **Vanderbei (1995) Thm:** an SQD matrix has an
`LDLᵀ` factorization with diagonal `D` for **every** symmetric
permutation; in particular the identity permutation. So the natural
order `0 … N−1` is always stable — **no pivot search**. `D` has a
**known sign pattern**: `D_jj < 0` for `j < n` (the x-block), `D_jj > 0`
for `j ≥ n` (the y-block).

This is the entire payoff: the factorization order is a function of the
integers `(n, m)` only — it reads no float64 value — so the
`numerical: true` determinism contract (ADR-0015) holds with **zero
pivot-determinism surface** (cf. a Bunch–Kaufman factorization, whose
data-dependent pivoting is the largest determinism surface among the
candidate paths — design panel spec C).

**The kernel** `signedLdltInPlace(K, N, n, tmp)` — an in-place
outer-product `LDLᵀ` (Golub–Van Loan Alg. 4.1.2), the no-`sqrt` sibling
of the existing `choleskyInPlace`. It stores `D` on the diagonal and the
strict-lower `L` below (implicit unit diagonal). `tmp` is a length-`N`
scratch row:

```
for (let j = 0; j < N; j++) {
  for (let k = 0; k < j; k++) tmp[k] = K[k*N+k] * K[j*N+k];   // tmp[k] = D_k · L_jk
  let d = K[j*N+j];
  for (let k = 0; k < j; k++) d -= K[j*N+k] * tmp[k];          // d = D_j (Schur update)
  const wantNeg = j < n;                                       // sign-pattern guard
  if (wantNeg ? !(d < 0) : !(d > 0)) return j;                 // → regularization-retry signal
  if (!Number.isFinite(d)) return j;
  K[j*N+j] = d;                                                // store pivot D_j
  const invd = 1 / d;
  for (let i = j + 1; i < N; i++) {
    let s = K[i*N+j];
    for (let k = 0; k < j; k++) s -= K[i*N+k] * tmp[k];
    K[i*N+j] = s * invd;
  }
}
return -1;
```

Cost `O(N³/3)`, the same shape as Cholesky but with no `Math.sqrt` (`D`
absorbs the sign). The inner `k`-loops accumulate in **fixed ascending
index order**, so the float64 rounding is reproducible. The `return j`
path is the regularization-retry trigger (§5): in exact arithmetic with
`ρ, δ > 0` it cannot fire (quasidefiniteness guarantees the sign
pattern), so a returned row signals that rounding pushed a pivot through
zero and more regularization is needed.

**The solve** `ldltSolveInPlace(K, N, x)` — `K v = u` in three sweeps,
`v` overwriting `u` in `x`:

```
for i = 0 … N−1:   x[i] −= Σ_{k<i} K[i*N+k]·x[k]          // L w = u   (unit lower)
for i = 0 … N−1:   x[i] /= K[i*N+i]                       // D z = w   (sign lives here)
for i = N−1 … 0:   x[i] −= Σ_{k>i} K[k*N+i]·x[k]          // Lᵀ Δ = z
```

Then `Δx = v[0 … n−1]`, `Δy = v[n … N−1]`, and `Δs` is recovered from the
eliminated complementarity row (§3): `Δs_j = (−r_c_j − s_j Δx_j)/x_j`.

`Q`, `A`, `ρ`, `δ` are constant across iterations; **only the `n`
x-block diagonal entries `−(s_j/x_j) − ρ` change per iteration**, so the
static pattern of `K` is assembled once and each iteration overwrites
just those `n` diagonals before copy-and-factor (mirrors how
`SchurAssembler` rebuilds `M` per iter, but cheaper).

---

## 5. Signed two-tier regularization

The existing uniform-positive Tikhonov (`factorWith3Way`, which adds a
single `+δI` to every diagonal via `choleskyInPlace`'s `jitter` arg) is
**wrong** for the saddle: a uniform `+δ` pushes the negative x-block
pivots toward zero and destroys quasidefiniteness. The QP path needs a
**signed** scheme:

```
K_reg = K0 + diag( −ρ · 1_n ,  +δ · 1_m )
```

i.e. **subtract** `ρ` from the first `n` diagonals (more negative) and
**add** `δ` to the last `m` (more positive). Both `ρ, δ ≥ 0`. This is
**Friedlander–Orban primal–dual regularization**: `−ρ` on the x-block is
a proximal term `(1/2)ρ‖Δx‖²`, `+δ` on the y-block a proximal term on
the dual, so `K_reg` is the KKT matrix of a **nearby well-posed QP**, not
a perturbation to apologise for.

**Two tiers, not three.** The augmented form has exactly two definiteness
blocks, so two regularizers (`ρ` primal, `δ` dual) are the natural and
complete set — there is no "gap" tier. **The diagnosis is structural and
exact:** the kernel's returned failing row `j` directly names the block —
`j < n ⇒` x-block lost its negative sign `⇒` bump `ρ`; `j ≥ n ⇒` y-block
`⇒` bump `δ`. No row-norm heuristic (`makeLpDiagnose`) is needed; the
block boundary `n` *is* the diagnosis. This is strictly cleaner than the
LP path's blind PRIMAL/DUAL/GAP escalation.

**Levels.** Base `ρ0 = δ0 = ρ_BASE · dataScale` with `ρ_BASE = 1e-10`
and `dataScale = max(1, max_ij|Q_ij|, max_ij|A_ij|)` — a **data-magnitude
proxy** computed once from the problem, *not* from the per-iteration
`X⁻¹S` range (which would inflate `ρ0` as `μ → 0` and grow the proximal
bias). `ρ0` is carried into `K0` itself **and** is the proximal target
`K_target` for the IR (§6); `δ0 > 0` makes the (2,2) block strictly PD
so `K0` is quasidefinite regardless of `rank(A)`. (`QpSolver.ts`
`problemScale`.) Escalation `(ρ_e, δ_e)` starts at `0` and
bumps `×10` on a returned failing row, capped (`ρ_max = 1e-2`,
`δ_max = 1e+2`, mirroring the LP caps), up to `maxRefactor` retries;
exhaustion ⇒ loud `numerical-error` status (Rule 1), never a
wrong-shaped answer.

---

## 6. Mehrotra predictor–corrector for QP

One outer iteration (port of `solveLp`'s loop, `Solver.ts:200-359`; the
**single factorization serves both predictor and corrector**, exactly as
the LP path reuses `it.Lchol`). Differences from LP are confined to:
(i) the matrix factored is `K` (★) not the `m×m` Schur; (ii) `r_d`
carries `Qx`.

1. **Residuals / μ.** `r_d = Qx + c − Aᵀy − s`, `r_p = Ax − b`,
   `μ = xᵀs/n`. Objectives `(1/2)xᵀQx + cᵀx` and dual. Convergence test
   reuses `checkConvergence` unchanged (it reads `primalInf/dualInf/gap`).

2. **Assemble + factor (once).** Overwrite the `n` x-block diagonals of
   `K0` with `−(s_j/x_j) − ρ0`. Copy `K0 → K`, run `signedFactorWithRetry`.
   One factorization per outer iteration.

3. **Predictor (affine, σ = 0, `r_c = XSe`).** RHS of (★) with
   `X⁻¹ r_c = s`:
   `u_aff[j] = r_d[j] + s[j]` for `j < n`; `u_aff[n+i] = −r_p[i]` for
   `i < m`. Solve `ldltSolveInPlace(K, …, u_aff)`, refine against
   `K_target` (§6 IR). `Δx_aff = u_aff[0..n-1]`, `Δy_aff = u_aff[n..N-1]`.
   Recover `Δs_aff_j = (−x_j s_j − s_j Δx_aff_j)/x_j`.

4. **Affine step lengths (fraction-to-boundary).**
   `α_p^aff = min(1, maxStepToBoundary(x, Δx_aff))`,
   `α_d^aff = min(1, maxStepToBoundary(s, Δs_aff))` (`StepLength.ts`
   reused verbatim). `μ_aff = (x + α_p^aff Δx_aff)ᵀ(s + α_d^aff Δs_aff)/n`.

5. **Centering.** `σ = clamp((μ_aff/μ)³, 0, 1)` — identical to
   `Solver.ts:284-285`.

6. **Corrector (`r_c = XSe + ΔX_aff ΔS_aff e − σμe`).** Only the x-block
   RHS changes; reassemble
   `u_cor[j] = r_d[j] + (x_j s_j + Δx_aff_j Δs_aff_j − σμ)/x_j` for
   `j < n`, `u_cor[n+i] = −r_p[i]`. Re-solve with the **same** factor.
   `Δx = u_cor[0..n-1]`, `Δy = u_cor[n..N-1]`,
   `Δs_j = (−r_c_j − s_j Δx_j)/x_j` with the corrector `r_c`. The
   second-order term `ΔX_aff ΔS_aff e` is what makes Mehrotra superior to
   a plain path-follower (corrects the linearization error of `XS = 0`).

7. **Safeguarded step + update.**
   `α_p = safeguardStep(min(1, maxStepToBoundary(x, Δx)), stepFactor)`,
   likewise `α_d` on `(s, Δs)`. `x += α_p Δx`, `y += α_d Δy`,
   `s += α_d Δs`. Separate primal/dual steps, exactly the LP path. Stall
   detection (`μ_new > 0.99 μ_before`) identical to `Solver.ts:305-316`.

**Iterative refinement (the last digits).** `solveWithIR`'s
trial/rollback/stagnation control flow is reused, generalised to call
`ldltSolveInPlace` (the approximate solver, factored `K_reg`) and a
symmetric `N×N` matvec against the proximal `K_target` (= `K0` at base
`ρ0, δ0`, nonsingular because `δ0 > 0`) for the residual. The √-level
conditioning of the augmented system leaves the headroom IR needs to
recover the final 2–3 digits the regularization spent — the same
mechanism that breaks the LP normal-equations `1e-7` floor, but starting
from `cond ≈ 1e10` instead of `1e20`, so it converges to `1e-10` rather
than stalling.

**Initial point.** Mehrotra infeasible-start heuristic (Wright 1997 §11):
the LP path's `defaultInitialPoint` (`x = s = const > 0`, `y = 0`,
`Solver.ts:370`) is a valid QP start and is reused; a least-squares
warm-start is the natural extension if iteration counts climb.

**Termination taxonomy (ADR-0030 §A, 5 classes).**
`optimal` (KKT met within `precision`), `infeasible` (primal
Farkas / improving-ray certificate), `unbounded` (dual-infeasibility
certificate), `iter-cap` (`max_iter` exhausted), `numerical-breakdown`
(factorization fails past `maxRefactor`, step collapse). Plus the
boundary-failure refusal envelopes (§7).

---

## 7. PSD validation of Q and the refusal envelope

A non-PSD `Q` is nonconvex — out of scope — and a malformed/asymmetric
`Q` is a contract violation. Validation, before any solve:

1. **Symmetry.** `|Q_ij − Q_ji| ≤ tol_sym·(1 + |Q_ij|)`, `tol_sym ≈
   1e-9`. The decoder symmetrizes `Q := (Q + Qᵀ)/2` (cheap, removes
   wire round-off asymmetry); gross asymmetry beyond `tol_sym` is itself
   suspicious and may be flagged.
2. **PSD.** via `@workbench/linalg-core` `eigh(A: Matrix): EighResult`
   (cyclic-Jacobi; `eigenvalues` sorted **ascending**, LAPACK/numpy
   convention). `Q` is PSD iff `eigenvalues[0] ≥ −eig_floor` with a
   **relative** floor `eig_floor = 1e-8 · max(1, |eigenvalues[n−1]|)`.
   `eigenvalues[0] < −eig_floor ⇒` boundary-failure
   `tagged "qp-solve/non-convex-objective"` with payload
   `{min_eigenvalue, eig_floor}`. Eigenvalues in `[−eig_floor, 0)` are
   numerically zero (PSD with a null space — convex but not strictly;
   the optimum may be a non-unique face — reported, not refused).

Other refusal classes mirror `lp-solve` (ADR-0003 boundary failures,
`tagged "qp-solve/<class>"`): `non-finite-input`, `degenerate-shape`,
`malformed-cone`, plus `free-variable-unsupported` and `non-nonneg-cone`
(the v0.1 standard-form scope). `ToolError` is reserved for **malformed**
input (schema does that).

*v0.1 note (honest scope, Rule 8).* There is **no** `precision-
unreachable` refusal in v0.1: a converged-but-loose solve is reported as
`status: optimal` carrying a large, honest `achieved_precision =
max(primalInf, dualInf, μ)` — the caller reads that field to judge the
achieved accuracy. A `precision-unreachable` envelope (payload
`{achieved, requested, condition_estimate}`) is the reserved v0.2 shape.
Likewise `condition_estimate` is a reserved field emitted as `0` until a
real (Hager 1-norm) estimate lands in v0.2.

---

## 8. The active set output

ADR-0030 §B: "QP returns active-set" — the structural extra output that
only makes sense for QP (parallel to LP's vertex basis, SDP's dual
matrix). At the interior-point optimum `x, s > 0` but converge so that
for each `i`, exactly one of `{x_i, s_i} → 0` (strict complementarity,
generic case). Definitions, with thresholds from the convergence dial
(the geometric-mean split of the complementarity gap `μ`, robust to the
`√μ` scaling near the central path):

```
tol_x = √precision · max(1, ‖x‖∞)
tol_s = √precision · max(1, ‖s‖∞)
index i ACTIVE   (bound x_i ≥ 0 tight)   ⇔  x_i ≤ tol_x  AND  s_i ≥ tol_s
index i INACTIVE                         ⇔  x_i ≥ tol_x  AND  s_i ≤ tol_s
index i NEAR-DEGENERATE (both ≤ tol)     ⇔  flagged, not forced into a set
```

The output reports `active_set` as the list of active indices `i` with
their multipliers `s_i` (the KKT dual on `x_i ≥ 0`, `≥ 0`, the objective
sensitivity to relaxing the bound). Equality multipliers `y` (length
`m`, free sign) are the separate dual vector. Honest scope (Rule 8): the
solver does **not** assert a crisp active set it cannot certify —
near-degenerate indices are flagged. The active set plus `y` is the
reduced-KKT certificate: on the active set `Qx + c − Aᵀy = s` with
`s_active ≥ 0`, `s_inactive = 0`.

---

## 9. Analytic oracle table (for in-repo verification)

Exact closed forms used by the property tests (no external corpus
needed; the Maros-Mészáros 138-case bench gate is the separate,
externally-blocked breadth gate — bead `j34c`):

| # | problem | exact solution |
|---|---------|----------------|
| O1 | **Unconstrained** `min ½xᵀQx + cᵀx`, `Q ≻ 0`, no `Ax=b`, bounds non-binding | `x* = −Q⁻¹c`, value `−½cᵀQ⁻¹c`. E.g. `Q = diag(2,4)`, `c = (−2,−8)` ⇒ `x* = (1,2)`, value `−9`. |
| O2 | **Equality-constrained**, no active inequality | KKT linear system `[Q Aᵀ; A 0][x; y] = [−c; b]` (dense `(n+m)` solve), unique when `Q ≻ 0` on `ker A` and `A` full row rank. E.g. `Q = I₂`, `c = 0`, `A = [1 1]`, `b = [1]` ⇒ `x* = (½,½)`, `y = −½`. |
| O3 | **LP reduction** `Q = 0` | the QP collapses to `min cᵀx s.t. Ax=b, x≥0`; cross-check that the optimum **agrees** with `tools/lp-solve` / `solveLp` to ~`1e-5` on uniquely-determined instances. (This is optimum-agreement, not a byte-for-byte trajectory claim — two IPMs on different factorization paths differ in the last roundoff digits; on a degenerate LP with a non-unique optimal face only the objective value is well-defined.) |
| O4 | **Separable diagonal-Q box** `min Σ ½q_i x_i² + c_i x_i s.t. l ≤ x ≤ u`, `q_i > 0` | decouples: `x*_i = clamp(−c_i/q_i, l_i, u_i)`; active set: lower where `−c_i/q_i < l_i` (mult `q_i l_i + c_i`), upper where `> u_i`. E.g. `q=(1,1)`, `c=(−3,1)`, box `[0,2]²` ⇒ `x* = (2,0)`, active `{0:upper, 1:lower}`. |
| O5 | **Single binding inequality** `min ½(x₁²+x₂²) s.t. x₁+x₂ ≥ 1` | stationarity `x = λ(1,1)`, feasibility `x₁+x₂ = 1` ⇒ `λ = ½`, `x* = (½,½)`, value `¼`, active = `{x₁+x₂≥1}`, multiplier `λ = ½`. Hand-verifiable; exercises the `active_set` reader. |

Mutation-proofs (Rule 6, port-and-verify): perturb the `Qx` term in
`r_d`, the corrector second-order term, or the sign guard in the kernel;
confirm the KKT-residual / oracle tests go RED; restore → GREEN.

---

## 10. Pointers

- Kernel: `packages/solver-ipm/src/linalg/SignedLdlt.ts`
  (`signedLdltInPlace`, `ldltSolveInPlace`) — cites §4.
- KKT assembly: `packages/solver-ipm/src/solver/QpKktAssembler.ts` — §4.
- Signed regularization: `packages/solver-ipm/src/solver/SignedRegularization.ts` — §5.
- Residuals / direction / iterate / driver: `QpResiduals.ts`,
  `QpDirection.ts`, `QpIterate.ts`, `QpSolver.ts` — §§2,3,6.
- Problem shape: `packages/solver-ipm/src/problem/QpProblem.ts` — §1.
- Tool: `tools/qp-solve/tool.ts` (wire layer, PSD validation, active_set,
  refusals) — §§7,8.
- The LP precedent this generalises: `Solver.ts`, `Direction.ts`,
  `StepLength.ts`, `Regularization.ts`, `IterativeRefinement.ts`.
- Decision record: the qp-solve ADR (augmented SQD over normal
  equations; signed regularization; static-factorization determinism).
