# Ground truth — Anderson acceleration for fixed-point iterations

Primary source:
**Junzi Zhang, Brendan O'Donoghue, Stephen Boyd**, *Globally Convergent
Type-I Anderson Acceleration for Nonsmooth Fixed-Point Iterations*,
arXiv:1808.03971 (2018; SIAM J. Optim. 2020). Transcribed from the
authoritative ar5iv HTML rendering of the paper
(`ar5iv.labs.arxiv.org/html/1808.03971`); equation and algorithm numbers
below are the paper's. The PDF should be staged to `docs/refs/` on the
next acquisition pass (bead `scientist-workbench-k9mm`).

Companion: **Homer F. Walker & Peng Ni**, *Anderson Acceleration for
Fixed-Point Iterations*, SIAM J. Numer. Anal. 49(4) 2011 — the clean
classical statement of the Type-II method `cone-core` ports.

This file transcribes the algorithm `packages/cone-core/src/anderson.ts`
implements. Per CLAUDE.md Law 1 + ADR-0030 §E, the port derives from
this transcription, **never** from the `scs` C library's `aa` module.

---

## 1. The problem Anderson acceleration solves

A fixed-point iteration `x_{k+1} = f(x_k)` for a map `f: ℝⁿ → ℝⁿ`
converges to a fixed point `x⋆ = f(x⋆)` — but, for a contraction with
factor near 1 (the regime the SCS operator-splitting iteration lives in),
it converges *linearly and slowly*: the "slow tail convergence" O'Donoghue
2016 §1 warns about. Anderson acceleration (AA) wraps the iteration: at
each step it forms the next iterate as a combination of a *window* of
recent images, chosen to minimise the fixed-point residual. It needs no
derivatives of `f` and costs one small least-squares solve per step.

Notation. The **residual** is `g(x) = x − f(x)` (zero at a fixed point).
At iteration `k` write `g_k = g(x_k)`, `f_k = f(x_k)`. With memory `m`,
`m_k = min(m, k)` is the working window size.

---

## 2. Type-II Anderson acceleration (AA-II) — the v0.1 port

### 2.1 The constrained least-squares (paper eq 2)

AA-II chooses convex-combination weights `α = (α_0, …, α_{m_k})` solving

```
minimise  ‖ Σ_{j=0}^{m_k} α_j · g(x_{k−m_k+j}) ‖₂²
subject to  Σ_{j=0}^{m_k} α_j = 1
```

— the combination of the last `m_k+1` residuals with smallest norm — and
sets the next iterate to the same combination of the *images*:

```
x_{k+1} = Σ_{j=0}^{m_k} α_j · f(x_{k−m_k+j})            (Algorithm 1)
```

### 2.2 The unconstrained reformulation (paper eq 3; Walker-Ni)

Eliminating the constraint by the change of variables
`α_0 = γ_0`, `α_i = γ_i − γ_{i−1}`, `α_{m_k} = 1 − γ_{m_k−1}` turns it
into an *unconstrained* least-squares over `γ ∈ ℝ^{m_k}`:

```
minimise_γ  ‖ g_k − Y_k γ ‖₂ ,   Y_k = [ Δg_{k−m_k} … Δg_{k−1} ]
```

where the columns of `Y_k` are the **residual differences**
`Δg_i = g_{i+1} − g_i`. Given `Y_k` of full column rank,

```
γ^k = (Y_kᵀ Y_k)⁻¹ Y_kᵀ g_k                            (normal equations)
```

and — this is the form `cone-core` implements — the accelerated iterate
in the Walker-Ni `β = 1` (no-damping) form is

```
x_{k+1} = f(x_k) − ℱ_k γ^k ,   ℱ_k = [ Δf_{k−m_k} … Δf_{k−1} ]
```

with `Δf_i = f(x_{i+1}) − f(x_i)` the **image differences**. (Equivalent
to the convex-combination form of §2.1: substitute and telescope.)

So one accelerated step needs, beyond the plain `f(x_k)` evaluation:
the two difference matrices `Y_k` (residual-diffs) and `ℱ_k`
(image-diffs), each `n × m_k`; the `m_k × m_k` normal-equations solve;
and the rank-`m_k` correction `ℱ_k γ`.

### 2.3 Why AA-II and not AA-I for v0.1

The paper's headline contribution is **Type-I** AA (eq 4–6): approximate
the Jacobian of `g` directly via a multi-secant condition,
`B_k = I + (Y_k − S_k)(S_kᵀ S_k)⁻¹ S_kᵀ`, update
`x_{k+1} = x_k − B_k⁻¹ g_k`. Type-I can converge faster but is *unstable*
without the paper's globalisation scaffolding — Powell-type regularisation
(eq 10–13) and the restart rule (eq 14). AA-II is the classical,
robust method (Walker-Ni 2011): one tall-skinny least-squares, no
Jacobian estimate, well-behaved with a light safeguard. `cone-core` v0.1
ports **AA-II**; Type-I and the Powell globalisation are a documented
v0.2 refinement.

---

## 3. Safeguarding (the globalisation, paper §3)

AA is *not* monotone — an accelerated step can transiently increase the
residual, and a rank-deficient or ill-conditioned `Y_k` can produce a
garbage extrapolation. The paper's full globalisation (Powell
regularisation eq 10–13 + the restart rule eq 14, "reset `m_k = 0` if
`m_k = m+1` or `‖ŝ_{k−1}‖ < τ‖s_{k−1}‖`" for the Gram-Schmidt-orthogonalised
`ŝ`) guarantees global convergence for Type-I.

`cone-core` v0.1 ships a **lighter AA-II safeguard** sufficient for the
well-posed dense problems in scope:

1. **Tikhonov ridge on the normal equations.** Solve
   `(Y_kᵀ Y_k + λ I) γ = Y_kᵀ g_k` with a small relative `λ` — this is
   the morally-equivalent, far simpler stand-in for Powell regularisation,
   and it makes a rank-deficient `Y_k` harmless rather than catastrophic.
2. **Finiteness + non-explosion check.** If the extrapolated `x_{k+1}` is
   non-finite, or its norm exceeds a large multiple of `‖f(x_k)‖`, the
   step is rejected: take the plain fixed-point step `x_{k+1} = f(x_k)`
   and **clear the history** (restart `m_k = 0`).
3. **Window restart.** The window rolls at `m`; on any safeguard trip the
   whole history is dropped, so a bad stretch cannot poison later steps.

The residual-decrease safeguard of the paper (reject a step whose
*next* residual grows past a bound) needs an extra `f` evaluation per
candidate; `cone-core` v0.1 omits it — finiteness + non-explosion +
restart is empirically enough for the LP-complete cone subset. The full
residual-decrease globalisation is the v0.2 refinement.

---

## 4. Applying AA to the SCS iteration

The SCS iteration (`docs/ground-truth/convex/scs-algorithm.md` §3.2.3,
eq 17) is a fixed-point map on the embedding pair `z = [u; v] ∈ ℝ^{2N}`:

```
φ(z):  ũ = (I+Q)⁻¹(u + v)
       ǔ = α·ũ + (1−α)·u                 (over-relaxation)
       u⁺ = Π_𝒞(ǔ − v)
       v⁺ = v − ǔ + u⁺
       return [u⁺; v⁺]
```

`φ` is nonexpansive (O'Donoghue 2016, appendix) — exactly the
"nonsmooth fixed-point iteration" the ZOB paper targets. `cone-core`
accelerates the `2N`-vector `z`: each iteration computes `Gz = φ(z_k)`
once, then `anderson.ts` returns either the AA-II extrapolation or, if
the safeguard trips, `Gz` itself.

**Determinism.** AA preserves the `numerical: true` contract (ADR-0015):
a fixed window `m`, a fixed-order normal-equations solve, no
implicit-zero gates — the accelerated trajectory is bit-identical given
`(problem, opts, platform)`, exactly as the plain iteration is.

**Termination** is unchanged: the §3.5 test (`recoverPrimalDual`) runs on
the accepted `z`, against the *original* (unscaled) problem, every
iteration — AA changes only *how fast* `z` reaches the terminal region,
never *what counts as* terminal.

---

## 5. Mapping to `packages/cone-core`

| paper | cone-core |
|---|---|
| Algorithm 1 / eq 2–3 (AA-II) | `anderson.ts` — `makeAnderson(memory).next(z, Gz)` |
| `Y_k` residual-diffs, `ℱ_k` image-diffs | rolling column buffers in the accelerator state |
| `γ = (Y_kᵀY_k)⁻¹ Y_kᵀ g_k` | the ridge-regularised normal-equations solve |
| §3 globalisation (Powell + restart eq 14) | the v0.1 light safeguard (§3 above); Powell is v0.2 |
| `φ` = one SCS iteration (O'D 2016 eq 17) | `scsStep` extracted in `scs.ts`; the loop is `Gz = scsStep(z); z = aa.next(z, Gz)` |
