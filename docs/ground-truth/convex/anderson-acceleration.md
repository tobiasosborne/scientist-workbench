# Ground truth — Anderson acceleration for fixed-point iterations

Primary source:
**Junzi Zhang, Brendan O'Donoghue, Stephen Boyd**, *Globally Convergent
Type-I Anderson Acceleration for Nonsmooth Fixed-Point Iterations*,
arXiv:1808.03971 (2018; SIAM J. Optim. 2020). Transcribed from the
authoritative ar5iv HTML rendering of the paper
(`ar5iv.labs.arxiv.org/html/1808.03971`), cross-checked against the
staged PDF at `docs/refs/zhang-odonoghue-boyd-2018-type-i-anderson.pdf`;
equation and algorithm numbers below are the paper's.

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
ports **AA-II**; Type-I and the Powell globalisation are the v0.2
refinement transcribed in §6–§8 below.

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

---

## 6. Type-I Anderson acceleration (AA-I) — the v0.2 port

Type-I AA is the paper's headline method (ZOB §2.3). Where AA-II
finds the *smallest-residual convex combination* of recent images
(§2 above), AA-I builds an explicit **multi-secant approximation of
the Jacobian of `g`** and takes one Newton-like step against it. The
two are duals — same input data (the recent iterate-differences and
residual-differences), different recipe — but in the *non-smooth*
fixed-point regime that SCS lives in, AA-I tends to converge faster
*when stabilised* and to diverge faster *when not*. The whole point of
§7 is the stabilisation; this section is the bare algorithm AA-I-m
(Algorithm 2 in the paper).

### 6.1 The data: iterate-differences `S_k` and residual-differences `Y_k`

Working at iteration `k` with memory window `m_k`, AA-I keeps the
same kind of rolling buffers AA-II uses, but the matrices play
*different* roles. Let

```
s_i  = x_{i+1} − x_i                                 (iterate diff)
y_i  = g_{i+1} − g_i                                 (residual diff)
```

and assemble the `n × m_k` buffers

```
S_k = [ s_{k−m_k}  …  s_{k−1} ]
Y_k = [ y_{k−m_k}  …  y_{k−1} ]
```

Compared to AA-II's `Y_k` (residual-diffs) and `ℱ_k` (image-diffs),
the iterate-diff `S_k` is the new object: AA-II never needs it, AA-I
makes it load-bearing.

### 6.2 The Jacobian estimate (paper eq 4)

The classical Broyden type-I update finds the matrix `B` closest to
the identity (in Frobenius norm) that satisfies the multi-secant
condition `B · S_k = Y_k` — "this Jacobian estimate is consistent
with every secant pair we've observed in the window." Assuming for
the moment that `S_k` has full column rank, the closed form is

```
B_k = I + (Y_k − S_k) (S_kᵀ S_k)⁻¹ S_kᵀ                       (eq 4)
```

A symmetric derivation argument fixes the choice. Read it as "start
from the identity (the trivial Jacobian guess), then add a low-rank
correction that bends the action of `B_k` so it matches `Y_k` on the
column-span of `S_k`." Off `span(S_k)`, `B_k` agrees with `I` — there
is no secant information there, so the estimate stays neutral.

### 6.3 The Newton step (paper eq 5)

Given `B_k`, AA-I takes a single Newton-like step against `g_k`:

```
x_{k+1} = x_k − B_k⁻¹ g_k                                     (eq 5)
```

The arithmetic cost of inverting an `n × n` matrix would be
intolerable for the SCS problem size; the Woodbury identity collapses
it to an `m_k × m_k` inverse:

```
B_k⁻¹ = I + (S_k − Y_k) (S_kᵀ Y_k)⁻¹ S_kᵀ                     (eq 6)
```

— so the only matrix actually inverted is the `m_k × m_k` matrix
`S_kᵀ Y_k`. This is the *dual* of AA-II's `m_k × m_k` normal-equations
solve, except the matrix is `S_kᵀ Y_k` (cross-Gram) instead of
`Y_kᵀ Y_k` (Gram); it is *not* symmetric, and it can be singular even
when `S_k` and `Y_k` separately have full rank. That asymmetry and
potential singularity is the source of AA-I's instability and the
motivation for §7.

### 6.4 The least-squares form the implementer actually solves (paper eq 7)

Expanding `B_k⁻¹ g_k` and rearranging gives an Algorithm-1-shape
update analogous to AA-II's:

```
                                      m_k − 1
x_{k+1} = f(x_k) − (S_k − Y_k) γ̃^k = f(x_k) − Σ γ̃_i^k · [f(x^{k−m_k+i+1}) − f(x^{k−m_k+i})]
                                      i = 0
                                                              (eq 7)
γ̃^k = (S_kᵀ Y_k)⁻¹ (S_kᵀ g_k)
```

So the **single linear solve** per AA-I step is

```
(S_kᵀ Y_k) γ̃^k = S_kᵀ g_k
```

— a non-symmetric `m_k × m_k` linear system (compare AA-II's
symmetric-positive-semidefinite `(Y_kᵀ Y_k) γ = Y_kᵀ g_k`). The
weights in convex-combination form are
`α_0^k = γ̃_0^k`, `α_i^k = γ̃_i^k − γ̃_{i−1}^k` for
`1 ≤ i ≤ m_k − 1`, and `α_{m_k}^k = 1 − γ̃_{m_k−1}^k` — but the
implementer never needs to form them explicitly; the `(S_k − Y_k) γ̃^k`
correction is the direct path.

### 6.5 Rank-one update form (paper eq 8 + 9, Proposition 1)

The closed-form `B_k` of eq 4 can equivalently be *built up*
column-by-column from `B_k^0 = I` by a sequence of rank-one updates —
this is the form §7's Powell regularisation modifies, so the
implementer must understand it before reading §7.

For `i = 0, …, m_k − 1`:

```
              (y_{k−m_k+i} − B_k^i · s_{k−m_k+i}) · ŝ_{k−m_k+i}ᵀ
B_k^{i+1} = B_k^i + ───────────────────────────────────────────             (eq 8)
                        ŝ_{k−m_k+i}ᵀ · s_{k−m_k+i}
```

with `B_k = B_k^{m_k}`. The vectors `ŝ_i` are the **Gram-Schmidt
orthogonalisation** of the iterate-diffs `s_i` against the previously
orthogonalised columns:

```
                  i − 1
                   ───   ŝ_jᵀ s_i
ŝ_i = s_i  −      ╲   ───────── · ŝ_j ,    i = k − m_k, …, k − 1     (eq 9)
                   ╱    ŝ_jᵀ ŝ_j
                  ─── j = k − m_k
```

The orthogonalisation is what makes the rank-one update equivalent to
the closed form; it is also the load-bearing object in the restart
test (§7.3) — `ŝ_{k−1}` is the residual of `s_{k−1}` after projecting
out the existing column-span, and its norm measures how much *new*
information the latest secant pair carries.

### 6.6 Algorithm 2 (paper, AA-I-m) — vanilla, no globalisation

The bare algorithm, before any stabilisation:

```
Algorithm 2  Type-I Anderson Acceleration (AA-I-m)

  Input:  initial point x^0,
          fixed-point mapping f: ℝⁿ → ℝⁿ,
          max-memory m > 0.

  for k = 0, 1, …:
    Choose m_k ≤ m         (e.g. m_k = min(m, k))
    γ̃^k = (S_kᵀ Y_k)⁻¹ (S_kᵀ g_k)
    α_0^k = γ̃_0^k
    α_i^k = γ̃_i^k − γ̃_{i−1}^k       for 1 ≤ i ≤ m_k − 1
    α_{m_k}^k = 1 − γ̃_{m_k − 1}^k
    x^{k+1} = Σ_{j=0}^{m_k} α_j^k · f(x^{k − m_k + j})
  end for
```

This is the artefact §7 stabilises. As-is, it suffers from two
failure modes the paper explicitly diagnoses (§2.3 closing paragraph):
(i) `S_kᵀ Y_k` can be singular or near-singular, making `γ̃^k`
ill-defined or wildly large; (ii) even when invertible, `B_k` can have
arbitrarily large norm — the Newton step blows up the iterate.

---

## 7. Globalisation: Powell regularisation + Gram-Schmidt restart + safe-guarding (paper §3 + §4)

This section is the v0.2 port's centre of mass. AA-I-m without
globalisation is documented in the paper as a *theoretical* method;
the *practical*, globally-convergent algorithm is **AA-I-S-m**
(Algorithm 3) — vanilla AA-I plus three interleaved modifications:

1. **Powell-type regularisation** of the rank-one update (eq 10–13) —
   ensures `B_k` stays invertible with `|det(B_k)| ≥ θ̄^{m_k}`.
2. **Gram-Schmidt restart rule** (eq 14) — ensures the orthogonalised
   `ŝ_{k−1}` is never too short, which keeps `‖B_k‖` and `‖H_k‖`
   uniformly bounded.
3. **Residual-decrease safeguarding** (lines 12–14 of Algorithm 3) —
   accepts the AA-I step only when the residual is sufficiently small;
   otherwise falls back to a KM-averaged step `f_α(x_k) = (1−α)x_k +
   α f(x_k)`.

Together they buy global convergence (Theorem 6, §7.5).

The v0.1 AA-II safeguard in §3 above is *not superseded* by this
section — that safeguard is the correct discipline for AA-II.
§7 is what AA-I requires *in addition*.

### 7.1 Powell-type regularisation (paper eq 10–13)

The motivation is rank-revealing-QR-like: when an incoming column
`s_{k−m_k+i}` is nearly in the span of the existing columns, the
secant condition `B s_i = y_i` it would impose is *numerically
indistinguishable* from secant conditions already encoded — but
because `(S_kᵀ Y_k)⁻¹` blows up in that direction, the rank-one
update of eq 8 takes a giant, meaningless step. Powell's trick:
**conditionally scale the secant target `y_i` back toward `B_k^i s_i`**
when the column is suspect, so the update is interpolated between
"trust the new secant" (`θ = 1`, vanilla eq 8) and "ignore the new
secant" (`θ = 0`, no update on this column).

Pick a regularisation strength `θ̄ ∈ (0, 1)`. For each column
`i = 0, …, m_k − 1` of the rank-one update, replace `y_{k−m_k+i}`
with

```
ỹ_{k−m_k+i} = θ_k^i · y_{k−m_k+i} + (1 − θ_k^i) · B_k^i · s_{k−m_k+i}    (eq 10)
```

The scalar `θ_k^i ∈ [1 − θ̄, 1 + θ̄]` is computed from a Powell test on
the dimensionless quantity

```
            ŝ_{k−m_k+i}ᵀ · (B_k^i)⁻¹ · y_{k−m_k+i}
η_k^i  =  ─────────────────────────────────────────
                       ‖ŝ_{k−m_k+i}‖₂²
```

via

```
                ⎧ 1                                  if |η| ≥ θ̄
φ_{θ̄}(η)  =    ⎨                                                         (eq 11)
                ⎩ (1 − sign(η) · θ̄) / (1 − η)        if |η| < θ̄
```

with `θ_k^i = φ_{θ̄}(η_k^i)` and the convention `sign(0) = 1`.

Read `η_k^i` as "how aligned is the secant target with the
orthogonalised iterate-diff direction": when `|η|` is large the
secant carries genuine, non-degenerate information and `θ = 1`
recovers the unregularised update; when `|η|` is small (the secant is
nearly orthogonal to the new information direction, the warning
sign for rank deficiency) `θ` is pulled away from 1, dragging `ỹ`
toward `B_k^i s` and dampening the update. The piecewise formula is
constructed so that `θ_k^i ∈ [1 − θ̄, 1 + θ̄]` always — a guarantee
the convergence proof needs.

The regularised rank-one update is then

```
                                                    T
                  (ỹ_{k−m_k+i} − B_k^i · s_{k−m_k+i}) · ŝ_{k−m_k+i}
B_k^{i+1} = B_k^i + ─────────────────────────────────────────────         (eq 12)
                            ŝ_{k−m_k+i}ᵀ · s_{k−m_k+i}
            for i = 0, …, m_k − 1
```

— structurally identical to eq 8, with `ỹ` instead of `y`. The
non-singularity guarantee (Lemma 2 in the paper) is the payoff:

```
|det(B_k)|  ≥  θ̄^{m_k}  >  0
```

so `B_k` is invertible, and `‖B_k⁻¹‖₂` is uniformly bounded by an
expression in `θ̄`, `τ`, `m` (Corollary 4, eq 15).

For implementation, the paper provides the **inverse-form update**
via Sherman-Morrison, so `H_k = B_k⁻¹` is built directly without
inverting anything:

```
                                                                T
                  (s_{k−m_k+i} − H_k^i · ỹ_{k−m_k+i}) · ŝ_{k−m_k+i} · H_k^i
H_k^{i+1} = H_k^i + ─────────────────────────────────────────────────────     (eq 13)
                              ŝ_{k−m_k+i}ᵀ · H_k^i · ỹ_{k−m_k+i}
              for i = 0, …, m_k − 1
```

with `H_k^0 = I` and `H_k = H_k^{m_k}`. The Newton step is then
`x_{k+1} = x_k − H_k g_k`.

**Critical implementation note** (paper §3.2 closing paragraph): when
`m_k` is chosen by rule (14), the algorithm maintains `B_k^i =
B_{k−m_k+i}` (and likewise for `H`). This means **only one rank-one
update of eq 13 is performed per iteration `k`** — the update with
`i = m_k − 1`, which yields `H_k = H_k^{m_k}` from `H_{k−1} =
H_k^{m_k−1}`. The subscript `k − m_k + i` then collapses to `k − 1`.
This is what makes the per-iteration cost `O(n · m_k)` rather than
`O(n · m_k²)`. The implementer should *not* re-run the full inner
loop each iteration.

A further simplification removes the need to maintain `B_k^i` for the
Powell test itself: by the recurrence,
`B_{k−m_k+i} s_{k−m_k+i} = −g_{k−m_k+i}`, so wherever
`B_k^i s_{k−m_k+i}` appears (in eq 10 and in `η_k^i`) the
implementer substitutes `−g_{k−m_k+i}`. With this substitution eq 10
becomes (as the paper writes it in Algorithm 3 line 9):

```
ỹ_{k−1} = θ_{k−1} · y_{k−1} − (1 − θ_{k−1}) · g_{k−1}
```

and `η_{k−1} = γ_{k−1} = ŝ_{k−1}ᵀ H_{k−1} y_{k−1} / ‖ŝ_{k−1}‖₂²`
(the inverse `H_{k−1}` replaces the matrix-vector product `(B_k^i)⁻¹
y_{k−m_k+i}` because that is exactly what `H_{k−1} y_{k−1}` computes
in the inverse-form world).

### 7.2 Why the Powell test is right (the rank-revealing analogy)

The Powell test is the multi-secant analogue of column-pivoted QR's
rejection rule. In RRQR, an incoming column whose orthogonal residual
is small relative to its norm is *demoted* (pivoted out) because it
carries no new linear-independence content. Here the test is on the
secant pair `(s, y)`, not the column alone, and the regularisation is
*continuous* (`θ` is a real number in `[1−θ̄, 1+θ̄]`, not a binary
keep/drop) — but the principle is identical: when `|η|` says "this
secant is nearly redundant with the existing Jacobian estimate",
shrink its update so the next iterate doesn't get a contribution from
a near-singular direction. The continuous form is what gives the
clean determinant lower bound `θ̄^{m_k}`.

### 7.3 Gram-Schmidt restart rule (paper eq 14)

The Powell regularisation keeps `B_k` invertible but does *not* keep
`‖B_k‖` bounded — if the orthogonalised `ŝ_{k−1}` is tiny (i.e. the
latest iterate-diff is nearly in the span of the previous ones), then
eq 8's denominator `ŝᵀs > 0` can still be vastly smaller than the
numerator, and `B_k` grows unboundedly. The restart rule guards
against this directly.

Initialise `m_0 = 0`. At every iteration `k ≥ 1`:

```
Update  m_k  =  m_{k−1} + 1.
If      m_k = m + 1   or   ‖ŝ_{k−1}‖₂  <  τ · ‖s_{k−1}‖₂          (eq 14)
then    reset  m_k = 0,  ŝ_{k−1} = s_{k−1},  H_{k−1} = I.
```

with `τ ∈ (0, 1)` pre-specified. There are *two* restart triggers,
and both matter:

- **Window saturation (`m_k = m + 1`).** The rolling window is
  full; clear it. This is unconditional — even a well-conditioned
  history is dropped at saturation. It is what makes "limited
  memory" precise: the algorithm forgets at a known rate, regardless
  of the data.
- **Strong-linear-independence violation (`‖ŝ_{k−1}‖ < τ ‖s_{k−1}‖`).**
  The orthogonalised iterate-diff is shorter than a `τ`-fraction of
  the raw iterate-diff. Geometrically: the latest `s_{k−1}` is more
  than `cos⁻¹(τ)`-aligned with the existing column span (e.g.
  `τ = 0.001` ⇒ alignment exceeds ~89.94°). The Jacobian estimate
  is not learning anything new from this column; worse, the small
  `‖ŝ‖` would blow up the next update.

After a restart the *entire history is dropped* — `m_k = 0`, the
buffers are emptied, `H_{k−1}` is reset to identity. The next AA-I
step therefore degenerates to a single plain Newton-like step against
`B = I`, i.e. `x_{k+1} = x_k − g_k = f(x_k)`. AA-I rebuilds its
Jacobian estimate from scratch.

**Recommended value of τ.** The paper's numerical-experiments default
(§5.2.1, "Choice of hyper-parameters") is `τ = 0.001`; the rule of
thumb (§5.2.1, "Additional rules-of-thumb") notes that the range
`0.001 … 0.1` is all reasonable, with larger `τ` forcing more
frequent restarts (in the limit, behaving like memory `m = 1`).

With rule (14) in force the paper proves (Corollary 4, eq 15):

```
‖H_k‖₂  =  ‖B_k⁻¹‖₂  ≤  3 · ((1 + θ̄ + τ) / τ)^m − 2  /  θ̄^m
```

— a uniform bound, independent of `k`, depending only on the
hyper-parameters `(θ̄, τ, m)`. This is the load-bearing fact for the
convergence proof.

### 7.4 Safe-guarding steps (paper §3.3, Algorithm 3 lines 12–14)

The third pillar. Even with Powell + restart, an individual AA-I step
can fail to reduce the residual — the paper's response is to require
each accepted AA-I step to *prove* it has reduced the residual past a
shrinking schedule, and to fall back to a KM-averaged step otherwise.

Let `n_AA` be the running count of accepted AA-I steps, initialised
to 0. Let `Ū = ‖g_0‖₂` be the initial residual norm. Pick safeguard
parameters `D > 0` and `ε > 0`. After computing the trial point
`x̃^{k+1} = x_k − H_k g_k`, gate it by

```
if   ‖g_k‖  ≤  D · Ū · (n_AA + 1)^{−(1 + ε)}                       (line 12)
then x^{k+1}  = x̃^{k+1}                                            (accept)
     n_AA    = n_AA + 1
else x^{k+1}  = f_α(x_k)  =  (1 − α) x_k  +  α f(x_k)               (fall back)
```

The threshold `D · Ū · (n_AA+1)^{−(1+ε)}` is a `Σ n^{−(1+ε)} < ∞`
summable schedule — it forces the *accepted* AA-I residuals to
contribute a finite total to the divergence budget, which is what
Step 1 of the convergence proof needs (it makes the right-hand side
of the eq 19 telescoping sum finite).

Note the *current* residual `‖g_k‖` is what's gated, not the *next*
residual — so there is no extra `f` evaluation on the candidate. This
is the structural reason the v0.1 file's §3 said "the paper's
residual-decrease safeguard needs an extra `f` evaluation per
candidate": that was wrong. Re-read line 12 — the check is on
`‖g_k‖`, which is already computed. The safeguard is *cheap*. The
v0.1 §3 statement should be read as "v0.1 chose not to *implement*
the residual-decrease test"; the v0.2 port should implement it as
written.

When the safeguard fails, the iterate is *not* the trial AA-I point
but the KM-averaged plain step. Importantly, the AA-I state
(`H_k`, the buffers `S_k`, `Y_k`, `ŝ`) is *not* cleared on a
safeguard fall-back; only `n_AA` is left unincremented. The
buffers continue to grow, and the *next* iteration's restart check
(rule 14) decides independently whether to reset.

**Important `s_{k−1}` redefinition** (paper §3.3 closing paragraph,
matches Algorithm 3 line 5). In AA-I-S-m, `s_{k−1}` and `y_{k−1}`
are defined **using the trial AA-I update `x̃^k`**, not the accepted
`x^k`:

```
s_{k−1}  =  x̃^k − x^{k−1}
y_{k−1}  =  g(x̃^k) − g(x^{k−1})
```

This is essential — it preserves the identity
`B_{k−1} s_{k−1} = −g_{k−1}` that lets the implementer drop the
explicit `B_k^i` maintenance (§7.1 closing). If you instead used
`s_{k−1} = x^k − x^{k−1}` (with `x^k` being the safeguard-accepted
KM step), that identity breaks and the simplification in §7.1
becomes invalid.

This *does* cost an extra `g(·)` evaluation per iteration (one on the
trial `x̃^k`, one on the accepted `x^k`), which is the real
per-iteration cost of safeguarding — not the `‖g_k‖` test itself.

### 7.5 Algorithm 3 (paper, AA-I-S-m) — full stabilised algorithm

Reproducing the paper's Algorithm 3 line by line, with the labels and
ordering preserved so the implementer can pattern-match against the
PDF (`docs/refs/zhang-odonoghue-boyd-2018-type-i-anderson.pdf`,
page 13):

```
Algorithm 3  Stabilised Type-I Anderson Acceleration (AA-I-S-m)

  Input:  initial point x^0,
          fixed-point mapping f: ℝⁿ → ℝⁿ,
          regularisation constants  θ̄, τ, α ∈ (0, 1),
          safe-guarding constants    D > 0,  ε > 0,
          max-memory m > 0.

  Initialise:  H_0 = I,  m_0 = 0,  n_AA = 0,  Ū = ‖g_0‖₂,
               x^1 = x̃^1 = f_α(x^0).

  for k = 1, 2, …:
    1. m_k = m_{k−1} + 1.
    2. s_{k−1} = x̃^k − x^{k−1},   y_{k−1} = g(x̃^k) − g(x^{k−1}).
    3. ŝ_{k−1} = s_{k−1} − Σ_{j = k − m_k}^{k − 2}
                   (ŝ_jᵀ s_{k−1}) / (ŝ_jᵀ ŝ_j) · ŝ_j        (Gram-Schmidt)
    4. if  m_k = m + 1  or  ‖ŝ_{k−1}‖₂ < τ · ‖s_{k−1}‖₂:           (restart, eq 14)
         reset  m_k = 0,  ŝ_{k−1} = s_{k−1},  H_{k−1} = I.
    5. γ_{k−1} = ŝ_{k−1}ᵀ · H_{k−1} · y_{k−1}  /  ‖ŝ_{k−1}‖₂²
       θ_{k−1} = φ_{θ̄}(γ_{k−1})                                   (Powell, eq 11)
       ỹ_{k−1} = θ_{k−1} · y_{k−1} − (1 − θ_{k−1}) · g_{k−1}     (Powell, eq 10 simplified)
    6. Update inverse Jacobian (Powell rank-one, eq 13):
                                                       T
                       (s_{k−1} − H_{k−1} ỹ_{k−1}) · ŝ_{k−1} · H_{k−1}
       H_k = H_{k−1} + ─────────────────────────────────────────────
                            ŝ_{k−1}ᵀ · H_{k−1} · ỹ_{k−1}
       x̃^{k+1} = x^k − H_k · g_k.
    7. Safe-guarding:
       if  ‖g_k‖  ≤  D · Ū · (n_AA + 1)^{−(1+ε)}:
         x^{k+1} = x̃^{k+1},  n_AA = n_AA + 1.
       else
         x^{k+1} = f_α(x^k)  =  (1 − α) · x^k + α · f(x^k).
  end for

  Output:  x^k (the last iterate).
```

**Matrix-free implementation** (paper §5.2.1, "Matrix-free
updates"). Computing and storing the dense `n × n` matrix `H_k`
defeats the point. The paper's trick: never materialise `H_k`;
instead, at each iteration, given the previous `H_{k−1}` *as an
operator on vectors* (built from a list of stored `(ŝ_j, H_{j−1})`
tuples), directly compute

```
d_k  =  H_{k−1} g_k
        +  (s_{k−1} − H_{k−1} ỹ_{k−1}) · (ŝ_{k−1}ᵀ H_{k−1} g_k) / (ŝ_{k−1}ᵀ H_{k−1} ỹ_{k−1})
```

and then `x̃^{k+1} = x^k − d_k`. This is `O(n · m_k)` per iteration
in both time and memory — the same complexity as AA-II. Internally,
`H_k v` for any vector `v` is unrolled as the sequence of rank-one
corrections to `v` driven by the stored `(ŝ_j, sign-scaled
residuals)`; the additional implementation trick the paper notes is
to store the *normalised* `ŝ_j` (so the `1/‖ŝ_j‖²` divisions are
absorbed) and store them *transposed* for cheap row-access.

### 7.6 Recommended hyper-parameter values (paper §5.2.1)

A single set of `(θ̄, τ, α, D, ε, m)` worked across all of the paper's
experiments. The defaults the `cone-core` v0.2 port should ship with
unless empirically tuned:

| symbol | recommended | role |
|---|---|---|
| `θ̄`  | `0.01`   | Powell regularisation strength (`θ ∈ [1−θ̄, 1+θ̄]`) |
| `τ`   | `0.001`  | restart threshold (`‖ŝ‖ < τ ‖s‖` triggers reset) |
| `α`   | `0.1`    | KM-averaging weight for safe-guard fall-back |
| `D`   | `1e6`    | safe-guard scale |
| `ε`   | `1e−6`   | safe-guard schedule exponent |
| `m`   | `5`      | window memory |

Rules of thumb from the paper:
- **`θ̄` should not be set too large** — empirically breaks the
  acceleration.
- **`τ ∈ [0.001, 0.1]`** is all reasonable; larger forces more
  frequent restarts (extreme `τ` → behaves like `m = 1`).
- **`m ∈ [2, 50]`** is all reasonable; larger memory is more stable
  with slightly larger per-iteration cost; `m` close to the variable
  dimension `n` becomes unstable.
- **Small `D` + large `ε`** ⇒ safe-guards fire more often, closer to
  vanilla AA-I-m (useful if the problem is easy and the safe-guard
  test is wasted work).
- **Pre-scaling matters more for AA than for the plain method** —
  the cone-core port already does Ruiz scaling (worklog 112 §5), so
  this is satisfied.

### 7.7 Global convergence guarantee (paper Theorem 6)

The load-bearing motivation for *all* of §7. Verbatim from the paper
(§4, page 16):

> **Theorem 6.** Suppose that `{x^k}_{k=0}^∞` is generated by
> Algorithm 3, then we have `lim_{k → ∞} x^k = x⋆`, where
> `x⋆ = f(x⋆)` is a solution to (1).

Standing assumptions (paper §1): `f: ℝⁿ → ℝⁿ` is non-expansive in
the `ℓ_2`-norm (`‖f(x) − f(y)‖_2 ≤ ‖x − y‖_2` for all `x, y ∈ ℝⁿ`),
and the solution set `X = {x⋆ | x⋆ = f(x⋆)}` is non-empty. No
smoothness assumption is required — this is the whole point. AA-II
(Walker-Ni 2011) has no comparable guarantee in the non-smooth
regime; that is the gap §7's machinery exists to close.

The proof (paper §4, three steps) reduces to two structural
invariants the implementer must preserve:

1. **Uniform boundedness of `‖H_k‖`** (Corollary 4, eq 15) — this
   requires Powell regularisation *and* the restart rule, both in
   force. If either is dropped or weakened, the bound fails and so
   does the convergence proof.
2. **Summability of the accepted-AA-step residual contributions**
   (`Σ ki < ∞` in the proof's eq 22) — this requires the
   safe-guarding test on `‖g_k‖ ≤ D Ū (n_AA + 1)^{−(1+ε)}` exactly
   as written, with the `(1+ε)` exponent strictly greater than 1.

An implementation that ships Powell + restart but skips the
safeguard does not satisfy Theorem 6. An implementation that
ships Powell + safeguard but skips restart does not satisfy
Theorem 6. The three pieces are not independently optional.

(Theorem 7, page 19, gives a sharper convergence rate when `f` is
*contractive* in some norm — not needed for SCS, where `f` is only
non-expansive. Out of scope for the v0.2 port.)

---

## 8. Mapping AA-I to `packages/cone-core`

Mirroring §5's table, for the v0.2 port:

| paper | cone-core (v0.2) |
|---|---|
| Algorithm 3 (AA-I-S-m) | `andersonI.ts` — `makeAndersonI({memory, θ̄, τ, α, D, ε}).next(x, fx, gx)` |
| `S_k` iterate-diff buffer | rolling `n × m_k` column buffer of `s_i = x̃_{i+1} − x_i` |
| `ŝ_j` orthogonalised iterate-diffs | parallel buffer; stored *normalised and transposed* (§7.5 implementation trick) |
| `H_k` inverse-Jacobian estimate | **never materialised** — represented as the recurrence over the stored `(ŝ_j, H_{j−1} ỹ_j)` tuples; `H_k v` is the matrix-free unroll |
| `θ_k^i` Powell per-column scaler | scalar computed at line 5 of Algorithm 3; only the latest column (i = m_k − 1) is needed per iteration |
| `η` / `γ` (Powell test input) | `ŝ_{k−1}ᵀ H_{k−1} y_{k−1} / ‖ŝ_{k−1}‖₂²`; matrix-free, two vector-vector products |
| `ỹ_{k−1}` regularised secant target | `θ_{k−1} y_{k−1} − (1 − θ_{k−1}) g_{k−1}` (uses the `B s = −g` simplification, §7.1 closing) |
| Restart trigger 1 — window saturation | `if m_k == memory + 1` ⇒ clear buffers, `H ← I` |
| Restart trigger 2 — strong-linear-indep | `if ‖ŝ_{k−1}‖ < τ · ‖s_{k−1}‖` ⇒ clear buffers, `H ← I` |
| Safe-guard test | `‖g_k‖ ≤ D · Ū · (n_AA + 1)^{−(1+ε)}`; `Ū` captured at construction from the first `g_0` |
| KM-averaged fall-back step `f_α` | `(1 − α) x_k + α · f(x_k)` — uses the `f(x_k)` value the caller already computed for this iteration (no extra `f` eval) |
| Determinism contract (`numerical: true`) | preserved verbatim from §4 / ADR-0015: fixed `m`, fixed-order Gram-Schmidt, fixed-order rank-one updates, no implicit-zero gates — bit-identical given `(problem, opts, platform)` |
| Standing assumption: `f` non-expansive in `ℓ_2` | satisfied by the SCS map `φ` (O'Donoghue 2016, appendix) — the same fact AA-II's §4 relies on |
| Theorem 6 (global convergence) | the invariant the `--test` hook should exercise: a non-expansive synthetic `f` with a known fixed point converges from any starting point, including starting points where v0.1's AA-II diverges or stagnates |

### 8.1 Differences from the v0.1 AA-II port (§5)

The v0.2 port is *not* a drop-in replacement of `anderson.ts`; it is
a parallel module. AA-II remains valid for cases where its
safeguard is empirically sufficient (LP-complete cone subset).
`andersonI.ts` is the choice for the SCS map on problems where the
non-smooth tail bites — exactly the cases ADR-0037 §E identifies
(the `lp-netlib` medium tier where AA-II caps).

The two share *no state*: their buffers, their internal "current
linear estimate" object (`(Y_kᵀ Y_k + λI)⁻¹` for AA-II vs. the
matrix-free `H_k` operator for AA-I), and their safeguard logic are
all distinct. The shared abstraction is only the outer interface:
`next(x_k, f(x_k))` returns the next iterate; on a safeguard fall-
back the next iterate is the (cheap) plain or averaged step.

### 8.2 The `--test` hook discipline AA-I requires

The light AA-II safeguard's `--test` could pass with a single smooth
contraction. AA-I's stabilisation is built for the *non-smooth*
regime, so its test hook must include:

1. A **non-expansive but non-contractive** synthetic `f` (e.g. a
   reflected projection onto a polyhedron) where vanilla AA-I-m
   (Algorithm 2, no Powell, no restart, no safeguard) is known to
   diverge or stagnate. The hook asserts AA-I-S-m converges.
2. A **Powell-regularisation invariant**: with the chosen `θ̄`, the
   accumulated `|det(H_k)|` stays in the `[θ̄^{−m}, …]` envelope
   the paper proves.
3. A **restart-trigger invariant**: a synthetic case where
   `‖ŝ_{k−1}‖ < τ ‖s_{k−1}‖` is forced (e.g. feed the same `s` twice);
   the hook asserts `m_k` resets to 0 and the next step degenerates
   to plain `f(x_k)`.
4. A **safe-guard invariant**: with `f` chosen so `‖g_k‖` violates
   the threshold for some `k`, the hook asserts `x^{k+1} = f_α(x^k)`
   and `n_AA` is *not* incremented.

These four invariants together cover the three structural pillars
(§7.1, §7.3, §7.4) plus the global-convergence motivation (§7.7) —
the test hook is honest in the Rule 7 sense: each assertion targets
a fact the paper proves, not "the code ran without throwing."
